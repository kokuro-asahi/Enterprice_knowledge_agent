import asyncio
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.agent import _enforce_tool_call_limit, _extract_stream_text, _extract_stream_tool_calls
from app.config import _csv_env
from app.errors import AppError, classify_run_error, http_exception_handler, validate_image_inputs
from app.model_messages import agent_system_prompt, model_messages
from app.model_guard import ModelDisclosureGuard, _CLASSIFIER_SYSTEM_PROMPT, _is_block_decision
from app.role_prompts import load_role_prompt
from app.retry import retry_sync
from app.schemas import RunRequest
from app.sse import encode_sse
from app.tool_sse import tool_trace_sse_event
from app.tools import _normalize_bocha_result, get_agent_tools
from app.runtime import AgentRuntime
from app.skills import SkillRegistry
from app.usage import usage_from_messages


class FakeMessage:
    def __init__(self, usage_metadata=None, response_metadata=None):
        self.usage_metadata = usage_metadata
        self.response_metadata = response_metadata or {}


def test_csv_env_parses_agent_skill_paths():
    assert _csv_env("skills, shared/skills, ,personal-skills") == [
        "skills",
        "shared/skills",
        "personal-skills",
    ]


def test_plan_stream_uses_applied_state_and_can_be_restored(monkeypatch, tmp_path):
    from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
    from langchain_core.messages import AIMessage
    from langgraph.checkpoint.memory import InMemorySaver
    from pydantic import Field

    from app.agent import AgentClient

    class PlanningModel(FakeMessagesListChatModel):
        bindings: list = Field(default_factory=list)

        def bind_tools(self, tools, **kwargs):
            assert "write_todos" in {tool.name for tool in tools}
            self.bindings.append(({tool.name for tool in tools}, kwargs.get("tool_choice")))
            return self

    def update(status, call_id):
        return AIMessage(content="", tool_calls=[{
            "name": "write_todos",
            "args": {"todos": [{"content": "核对依据", "status": status}]},
            "id": call_id,
            "type": "tool_call",
        }])

    model = PlanningModel(responses=[update("in_progress", "plan-1"), update("completed", "plan-2"), AIMessage(content="这是回答")])
    settings = SimpleNamespace(agent_backend="deepagents", max_tool_calls=50, agent_filesystem_root=str(tmp_path), agent_skills_paths=())
    runtime = AgentRuntime(settings)
    runtime.checkpointer = InMemorySaver()
    monkeypatch.setattr(runtime, "create_model", lambda: model)
    monkeypatch.setattr("app.agent.runtime", runtime)

    async def collect():
        return [event async for event in AgentClient(settings).astream_events(
            [{"role": "user", "content": "请核对后回答"}], "user", "thread", 1, [],
        )]

    events = asyncio.run(collect())
    plans = [event["todos"] for event in events if event["type"] == "plan"]
    assert plans == [
        [{"content": "核对依据", "status": "in_progress"}],
        [{"content": "核对依据", "status": "completed"}],
    ]
    assert "".join(event["text"] for event in events if event["type"] == "text") == "这是回答"
    assert runtime.get_todos("user", "thread", 1) == plans[-1]
    assert runtime.get_todos("another-user", "thread", 1) == []
    assert runtime.get_todos("user", "thread", 2) == []
    assert model.bindings[0] == ({"write_todos"}, {"type": "function", "function": {"name": "write_todos"}})
    assert "get_current_time" in model.bindings[1][0]
    assert "bocha_search" in model.bindings[1][0]
    assert model.bindings[1][1] is None


def test_each_user_turn_requires_its_own_successful_plan():
    from langchain.agents.middleware.types import ModelRequest
    from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
    from app.planning import TaskPlanningMiddleware

    middleware = TaskPlanningMiddleware()
    messages = [
        HumanMessage(content="第一轮任务"),
        AIMessage(content="", tool_calls=[{"name": "write_todos", "args": {"todos": []}, "id": "old-plan"}]),
        ToolMessage(content="Updated todo list", tool_call_id="old-plan"),
    ]
    request = ModelRequest(model=None, messages=messages, tools=middleware.tools, state={"messages": messages})
    assert middleware._plan_first(request).tool_choice is None
    messages = [*messages, HumanMessage(content="第二轮任务")]
    request = request.override(messages=messages, state={"messages": messages})
    assert middleware._plan_first(request).tool_choice["function"]["name"] == "write_todos"
    failed_messages = [
        *messages,
        AIMessage(content="", tool_calls=[{"name": "write_todos", "args": {"todos": []}, "id": "new-plan"}]),
        ToolMessage(content="Invalid plan", tool_call_id="new-plan", status="error"),
    ]
    request = request.override(messages=failed_messages, state={"messages": failed_messages})
    assert middleware._plan_first(request).tool_choice["function"]["name"] == "write_todos"


def test_message_history_restores_plan_for_current_context(monkeypatch):
    from app.services import RunService, business_store, runtime

    monkeypatch.setattr(business_store, "get_thread", lambda *args: {"context_version": 2})
    monkeypatch.setattr(business_store, "paged_conversations", lambda *args: ([], 0))
    monkeypatch.setattr(business_store, "latest_run_status", lambda *args: "completed")

    def get_todos(user_id, thread_id, context_version):
        assert (user_id, thread_id, context_version) == ("user", "thread", 2)
        return [{"content": "核对依据", "status": "completed"}]

    monkeypatch.setattr(runtime, "get_todos", get_todos)
    history = asyncio.run(RunService().messages("user", "thread", 1, 100))
    assert history.model_dump()["todos"] == [{"content": "核对依据", "status": "completed"}]
    assert history.run_status == "completed"


def test_unknown_thread_does_not_read_checkpoint_plan(monkeypatch):
    from app.services import RunService, business_store, runtime

    monkeypatch.setattr(business_store, "get_thread", lambda *args: None)

    def unexpected(*args):
        raise AssertionError("A missing thread must not read checkpoint data")

    monkeypatch.setattr(runtime, "get_todos", unexpected)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(RunService().messages("user", "thread", 1, 100))
    assert exc.value.status_code == 404


def test_skill_paths_are_exposed_as_deepagents_virtual_paths(tmp_path):
    skills_dir = tmp_path / "skills"
    skills_dir.mkdir()
    runtime = AgentRuntime(
        SimpleNamespace(
            agent_filesystem_root=str(tmp_path),
            agent_skills_paths=("skills",),
        )
    )

    assert runtime.skill_paths() == ["/skills/"]


def test_skill_paths_reject_directories_outside_filesystem_root(tmp_path):
    outside_dir = tmp_path.parent / "outside-skills"
    outside_dir.mkdir(exist_ok=True)
    runtime = AgentRuntime(
        SimpleNamespace(
            agent_filesystem_root=str(tmp_path),
            agent_skills_paths=(str(outside_dir),),
        )
    )

    with pytest.raises(ValueError, match="AGENT_SKILLS_PATHS entries"):
        runtime.skill_paths()


def test_skill_registry_lists_public_metadata_and_resolves_selected_paths(tmp_path):
    skill_dir = tmp_path / "skills" / "research"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: research\ndescription: Research trusted sources.\n---\n# Research\n",
        encoding="utf-8",
    )
    registry = SkillRegistry(
        SimpleNamespace(agent_filesystem_root=str(tmp_path), agent_skills_paths=("skills",))
    )

    assert [skill.public_dict() for skill in registry.list()] == [
        {
            "id": "research",
            "name": "research",
            "description": "Research trusted sources.",
            "enabled_by_default": False,
        }
    ]
    assert registry.paths_for(["research"]) == ["/skills/research/"]
    with pytest.raises(ValueError, match="Unknown active_skill_ids"):
        registry.paths_for(["missing"])


def test_sse_encoding_preserves_event_and_json_data():
    encoded = encode_sse("message.delta", {"run_id": "run_001", "text": "你好"})

    assert encoded == 'event: message.delta\ndata: {"run_id":"run_001","text":"你好"}\n\n'


def test_tool_call_trace_maps_to_started_sse_event():
    event = tool_trace_sse_event(
        "run_001",
        {
            "role": "tool_call",
            "content": [
                {
                    "type": "tool_call",
                    "tool_call_id": "call_001",
                    "tool_name": "bocha_search",
                    "arguments": {"query": "西安明天天气", "count": 5, "freshness": "noLimit"},
                }
            ],
        },
    )

    assert event == (
        "tool.call.started",
        {
            "run_id": "run_001",
            "tool_call_id": "call_001",
            "tool_type": "bocha_search",
            "arguments": {"query": "西安明天天气", "count": 5, "freshness": "noLimit"},
        },
    )


def test_tool_callback_trace_maps_to_completed_sse_event_with_unwrapped_result():
    result = {
        "query": "西安明天天气",
        "count": 1,
        "results": [{"title": "西安天气预报", "url": "https://example.com/weather"}],
    }
    event = tool_trace_sse_event(
        "run_001",
        {
            "role": "tool_callback",
            "content": [
                {
                    "type": "tool_callback",
                    "tool_call_id": "call_001",
                    "tool_name": "bocha_search",
                    "status": "completed",
                    "result": {"type": "json", "content": result},
                    "error": None,
                }
            ],
        },
    )

    assert event == (
        "tool.call.completed",
        {
            "run_id": "run_001",
            "tool_call_id": "call_001",
            "tool_type": "bocha_search",
            "result": result,
        },
    )


def test_tool_callback_trace_maps_to_failed_sse_event():
    event = tool_trace_sse_event(
        "run_001",
        {
            "role": "tool_callback",
            "content": [
                {
                    "type": "tool_callback",
                    "tool_call_id": "call_001",
                    "tool_name": "bocha_search",
                    "status": "error",
                    "result": {"type": "text", "content": "博查 API 请求超时"},
                    "error": {"type": "text", "content": "博查 API 请求超时"},
                }
            ],
        },
    )

    assert event == (
        "tool.call.failed",
        {
            "run_id": "run_001",
            "tool_call_id": "call_001",
            "tool_type": "bocha_search",
            "error": {"code": "TOOL_CALL_FAILED", "message": "博查 API 请求超时", "retryable": True},
        },
    )


def test_invalid_image_url_maps_to_image_download_failed():
    with pytest.raises(AppError) as error:
        validate_image_inputs([{"type": "image", "url": "ftp://example.com/image.png"}])

    assert error.value.to_error_info() == {
        "code": "IMAGE_DOWNLOAD_FAILED",
        "message": "图片 URL 无效",
        "retryable": False,
    }


def test_tool_error_is_classified_for_run_failed_payload():
    error = classify_run_error(RuntimeError("博查 API 请求失败：HTTP 500"))

    assert error == {
        "code": "TOOL_CALL_FAILED",
        "message": "博查 API 请求失败：HTTP 500",
        "retryable": True,
    }


def test_http_thread_not_found_handler_returns_error_code():
    response = asyncio.run(
        http_exception_handler(
            None,
            HTTPException(
                status_code=404,
                detail={"error": {"code": "THREAD_NOT_FOUND", "message": "会话不存在", "retryable": False}},
            ),
        )
    )

    assert response.status_code == 404
    assert json.loads(response.body) == {
        "error": {"code": "THREAD_NOT_FOUND", "message": "会话不存在", "retryable": False}
    }


def test_agent_role_required_when_thread_id_is_missing():
    with pytest.raises(ValidationError):
        RunRequest(
            user_id="user_001",
            content=[{"type": "text", "text": "hi"}],
        )


def test_agent_prompt_is_accepted_for_new_thread_without_role():
    request = RunRequest(
        user_id="user_001",
        agent_role=None,
        agent_prompt="  你是一个自定义 Agent。  ",
        content=[{"type": "text", "text": "hi"}],
    )

    assert request.agent_role is None
    assert request.agent_prompt == "你是一个自定义 Agent。"


def test_active_skill_ids_default_to_disabled_and_reject_duplicates():
    request = RunRequest(
        user_id="user_001",
        content=[{"type": "text", "text": "你好"}],
        agent_role="director",
    )
    assert request.active_skill_ids == []

    with pytest.raises(ValidationError, match="active_skill_ids must not contain duplicates"):
        RunRequest(
            user_id="user_001",
            content=[{"type": "text", "text": "你好"}],
            agent_role="director",
            active_skill_ids=["research", "research"],
        )


def test_blank_agent_prompt_is_rejected_for_new_thread_without_role():
    with pytest.raises(ValidationError):
        RunRequest(
            user_id="user_001",
            agent_role=None,
            agent_prompt="  ",
            content=[{"type": "text", "text": "hi"}],
        )


def test_agent_role_must_be_supported():
    with pytest.raises(ValidationError):
        RunRequest(
            user_id="user_001",
            agent_role="producer",
            content=[{"type": "text", "text": "hi"}],
        )


def test_agent_role_not_required_for_existing_thread():
    request = RunRequest(
        user_id="user_001",
        thread_id="thread_001",
        content=[{"type": "text", "text": "hi"}],
    )

    assert request.thread_id == "thread_001"


def test_supported_agent_role_is_accepted_for_new_thread():
    request = RunRequest(
        user_id="user_001",
        agent_role="storyboard_artist",
        content=[{"type": "text", "text": "hi"}],
    )

    assert request.agent_role == "storyboard_artist"


def test_run_request_ignores_legacy_message_ids():
    request = RunRequest(
        user_id="user_001",
        thread_id="thread_001",
        client_message_id="client_001",
        message_id="message_001",
        content=[{"type": "text", "text": "hi"}],
    )

    assert request.thread_id == "thread_001"
    assert not hasattr(request, "client_message_id")
    assert not hasattr(request, "message_id")


def test_bocha_stream_tool_call_waits_for_arguments():
    tool_call_chunks = {}
    empty_message = type(
        "AIMessageChunk",
        (),
        {
            "tool_calls": [{"id": "call_001", "name": "bocha_search", "args": {}}],
            "tool_call_chunks": [
                {"id": "call_001", "index": 0, "name": "bocha_search", "args": ""},
            ],
        },
    )()

    assert _extract_stream_tool_calls(empty_message, tool_call_chunks) == []

    args_message = type(
        "AIMessageChunk",
        (),
        {
            "tool_calls": [{"id": "call_001", "name": "bocha_search", "args": {"query": "西安明天天气"}}],
            "tool_call_chunks": [
                {"id": "call_001", "index": 0, "name": "bocha_search", "args": {"query": "西安明天天气"}},
            ],
        },
    )()

    assert _extract_stream_tool_calls(args_message, tool_call_chunks) == [
        {
            "type": "tool_call",
            "tool_call_id": "call_001",
            "tool_name": "bocha_search",
            "arguments": {"query": "西安明天天气"},
        }
    ]


def test_stream_text_excludes_reasoning_blocks():
    message = type(
        "AIMessageChunk",
        (),
        {
            "type": "ai",
            "content": [
                {"type": "reasoning", "text": "这是不应发送给客户端的思考过程"},
                {"type": "thinking", "text": "这同样不应发送"},
                {"type": "text", "text": "这是给用户的最终回答。"},
            ],
        },
    )()

    assert _extract_stream_text(message) == "这是给用户的最终回答。"


def test_stream_text_excludes_tool_node_and_tool_summary_events():
    message = type("AIMessageChunk", (), {"type": "ai", "content": "工具检索摘要不应显示为回答"})()

    assert _extract_stream_text((message, {"langgraph_node": "tools"})) == ""
    assert _extract_stream_text((message, {"tags": ["tool_result_summary"]})) == ""
    assert _extract_stream_text((message, {"metadata": {"suppress_stream_text": True}})) == ""


def test_tool_call_limit_counts_completed_callbacks():
    trace_messages = [{"role": "tool_callback", "content": []} for _ in range(10)]

    _enforce_tool_call_limit(trace_messages, 10)

    with pytest.raises(AppError) as error:
        _enforce_tool_call_limit([*trace_messages, {"role": "tool_callback", "content": []}], 10)

    assert error.value.to_error_info() == {
        "code": "TOOL_CALL_FAILED",
        "message": "工具调用次数超过限制（最多 10 次）",
        "retryable": False,
    }


def test_custom_agent_prompt_is_separate_from_conversation_state():
    messages = model_messages([{"type": "text", "text": "hi"}])

    assert messages == [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]
    assert agent_system_prompt(None, "你是一个自定义 Agent。") == "你是一个自定义 Agent。"


def test_model_guard_skips_classification_in_echo_mode():
    class Settings:
        model_guard_enabled = True
        agent_backend = "echo"
        model_guard_response = "固定话术"

    result = asyncio.run(
        ModelDisclosureGuard(Settings()).check([{"type": "text", "text": "你用的是什么模型型号？参数量是多少？"}])
    )

    assert result == {"blocked": False, "action": "allow", "message": ""}


def test_model_guard_allows_regular_questions_in_echo_mode():
    class Settings:
        model_guard_enabled = True
        agent_backend = "echo"
        model_guard_response = "固定话术"

    result = asyncio.run(ModelDisclosureGuard(Settings()).check([{"type": "text", "text": "帮我写一个分镜脚本"}]))

    assert result == {"blocked": False, "action": "allow", "message": ""}


def test_model_guard_decision_requires_classifier_json_block_action():
    assert _is_block_decision('{"action":"block"}')
    assert not _is_block_decision('{"action":"allow"}')
    assert not _is_block_decision("block")


def test_model_guard_uses_deterministic_model_and_allows_role_questions(monkeypatch):
    class Settings:
        model_guard_enabled = True
        agent_backend = "deepagents"
        model_guard_response = "固定话术"

    captured = {}

    class Model:
        def invoke(self, messages):
            captured["messages"] = messages
            return '{"action":"allow"}'

    from app.runtime import runtime

    def create_model(*, temperature):
        captured["temperature"] = temperature
        return Model()

    monkeypatch.setattr(runtime, "create_model", create_model)
    result = asyncio.run(ModelDisclosureGuard(Settings()).check([{"type": "text", "text": "你是什么角色？"}]))

    assert result == {"blocked": False, "action": "allow", "message": ""}
    assert captured["temperature"] == 0
    assert "你是什么角色？" in captured["messages"][0]["content"]
    assert "必须输出 {\"action\":\"allow\"}" in _CLASSIFIER_SYSTEM_PROMPT


def test_role_prompt_loads_from_markdown_file():
    prompt = load_role_prompt("storyboard_artist")

    assert "分镜师" in prompt


def test_usage_sums_multiple_model_messages_in_one_run():
    usage = usage_from_messages(
        [
            FakeMessage({"input_tokens": 10, "output_tokens": 4, "total_tokens": 14}),
            FakeMessage({"input_tokens": 7, "output_tokens": 3, "total_tokens": 10}),
        ]
    )

    assert usage == {"input_tokens": 17, "output_tokens": 7, "total_tokens": 24}


def test_usage_supports_response_metadata_token_usage_shape():
    usage = usage_from_messages(
        [
            FakeMessage(response_metadata={"token_usage": {"prompt_tokens": 11, "completion_tokens": 5}}),
        ]
    )

    assert usage == {"input_tokens": 11, "output_tokens": 5, "total_tokens": 16}


def test_agent_tools_include_web_search():
    tool_names = {tool.__name__ for tool in get_agent_tools()}

    assert "get_current_time" in tool_names
    assert "bocha_search" in tool_names


def test_bocha_result_is_normalized_for_agent_output():
    result = _normalize_bocha_result(
        "OpenAI",
        {
            "data": {
                "webPages": {
                    "value": [
                        {
                            "name": "Title",
                            "url": "https://example.com",
                            "siteName": "Example",
                            "datePublished": "2026-08-03",
                            "summary": "Summary",
                        }
                    ]
                }
            }
        },
    )

    assert result == {
        "query": "OpenAI",
        "count": 1,
        "results": [
            {
                "title": "Title",
                "url": "https://example.com",
                "site_name": "Example",
                "date_published": "2026-08-03",
                "snippet": "Summary",
            }
        ],
    }


def test_bocha_ai_search_messages_result_is_normalized_for_agent_output():
    result = _normalize_bocha_result(
        "西安天气",
        {
            "code": 200,
            "messages": [
                {
                    "role": "assistant",
                    "type": "source",
                    "content_type": "webpage",
                    "content": (
                        '{"value":[{"name":"未来三天 陕西降水持续",'
                        '"url":"https://example.com/weather",'
                        '"siteName":"腾讯网",'
                        '"datePublished":"2026-08-03T01:00:07+08:00",'
                        '"summary":"西安三日天气"}]}'
                    ),
                }
            ],
        },
    )

    assert result == {
        "query": "西安天气",
        "count": 1,
        "results": [
            {
                "title": "未来三天 陕西降水持续",
                "url": "https://example.com/weather",
                "site_name": "腾讯网",
                "date_published": "2026-08-03T01:00:07+08:00",
                "snippet": "西安三日天气",
            }
        ],
    }


def test_retry_sync_retries_then_returns_value():
    calls = {"count": 0}

    def flaky_operation():
        calls["count"] += 1
        if calls["count"] < 3:
            raise TimeoutError("temporary")
        return "ok"

    assert retry_sync(flaky_operation, attempts=3, initial_delay=0, retry_exceptions=(TimeoutError,)) == "ok"
    assert calls["count"] == 3
