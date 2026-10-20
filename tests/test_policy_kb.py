import asyncio
import importlib
from pathlib import Path
from unittest.mock import patch

import pytest

from app.config import Settings
from app.role_prompts import load_role_prompt
from app.runtime import AgentRuntime
from app.schemas import RunRequest
from app.skill_tools import _load_module, skill_tool_registry
from app.skills import SkillRegistry
from app.tools import get_agent_tools


def _enterprise_policy_tool():
    root = Path(Settings().agent_filesystem_root)
    path = SkillRegistry(Settings()).paths_for(["enterprise-policy"])[0]
    module = _load_module(root / path.strip("/") / "scripts" / "tools.py")
    return module.search_enterprise_policy


def test_policy_tool_is_exposed_when_skill_is_enabled():
    assert "search_enterprise_policy" not in {tool.__name__ for tool in get_agent_tools()}
    assert {tool.__name__ for tool in skill_tool_registry.tools_for(("enterprise-policy",))} == {"search_enterprise_policy"}
    names = {tool.__name__ for tool in get_agent_tools(("enterprise-policy",))}
    assert {"get_current_time", "bocha_search", "search_enterprise_policy"} <= names
    request = RunRequest(user_id="test", agent_role="enterprise_policy_advisor", content=[{"type": "text", "text": "请假"}])
    assert request.active_skill_ids == []
    assert load_role_prompt(request.agent_role)


def test_selected_skill_discovery_and_file_isolation(monkeypatch):
    from deepagents.backends.protocol import LsResult
    from deepagents.middleware.skills import _list_skills

    runtime = AgentRuntime(Settings())
    monkeypatch.setattr(runtime, "create_model", lambda: None)
    paths = SkillRegistry(runtime.settings).paths_for(["enterprise-policy"])
    kwargs = runtime.deep_agent_kwargs(paths, ("enterprise-policy",))
    assert "search_enterprise_policy" in {tool.__name__ for tool in kwargs["tools"]}
    backend = kwargs["backend"]
    # Supply the empty graph state normally available during graph execution.
    monkeypatch.setattr(backend.default, "ls", lambda path: LsResult(entries=[]))
    discovered = _list_skills(backend, kwargs["skills"][0])
    assert [s["name"] for s in discovered] == ["enterprise-policy"]
    assert len(backend.routes) == 1
    assert "backend" not in runtime.deep_agent_kwargs([])


def test_policy_bridge_preserves_results_and_arguments():
    expected = {"results": [{"content": "原文", "source_pages": [3]}], "result_count": 1}
    tool = _enterprise_policy_tool()
    module = importlib.import_module(tool.__module__)
    with patch.object(module, "_search_policy", return_value=expected) as search:
        assert tool(" 请假 ", file_id=" policy-1 ") == expected
        search.assert_awaited_once_with({"query": "请假", "top_k": 5, "candidates": 20, "file_id": "policy-1"})
    with pytest.raises(ValueError):
        tool("", top_k=0)


def test_json_invocation_forwards_selected_skills():
    from app.services import _agent_invoke_event

    async def operation(messages, user_id, thread_id, version, skills, system_prompt):
        assert skills == ["enterprise-policy"]
        assert system_prompt is None
        return {"message": "ok"}

    with patch("app.services.log_agent_event"):
        result = asyncio.run(_agent_invoke_event(operation, [], "u", "t", 1, ["enterprise-policy"], None, {}))
    assert result["message"] == "ok"
