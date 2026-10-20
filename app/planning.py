from typing import Any

from langchain.agents.middleware import TodoListMiddleware
from langchain.agents.middleware.todo import WRITE_TODOS_SYSTEM_PROMPT


class TaskPlanningMiddleware(TodoListMiddleware):
    """Start each user turn with a model-authored, checkpointed task plan."""

    def __init__(self) -> None:
        super().__init__(system_prompt=WRITE_TODOS_SYSTEM_PROMPT + "\n\n"
            "每轮用户请求必须先调用 write_todos 制定当前任务的执行计划，再开始检索或回答。"
            "简单问题可以只列一个步骤。计划必须对应当前用户请求，不沿用上一轮的已完成计划。"
            "执行中及时更新步骤状态；只有实际完成的步骤才能标记 completed。"
            "正式回答内容准备就绪后，必须先调用 write_todos，将已完成的检索、核对和整理步骤更新为 completed，"
            "再输出正式回答。仍有无法完成的事项时，保留实际状态并在回答中说明缺口。"
            "最后一次更新计划后，仍须输出用户要求的正式回答。")

    @property
    def name(self) -> str:
        # Replace the official instance if the model's harness already adds it.
        return "TodoListMiddleware"

    def _plan_first(self, request: Any) -> Any:
        messages = request.state.get("messages", request.messages)
        turn = []
        for message in reversed(messages):
            if message.type == "human":
                break
            turn.append(message)
        successful_calls = {
            message.tool_call_id
            for message in turn
            if message.type == "tool" and getattr(message, "status", None) != "error"
        }
        has_plan = any(
            call.get("name") == "write_todos" and call.get("id") in successful_calls
            for message in turn
            for call in getattr(message, "tool_calls", []) or []
        )
        if has_plan:
            return request
        tools = [tool for tool in request.tools if getattr(tool, "name", None) == "write_todos"]
        return request.override(
            tools=tools,
            tool_choice={"type": "function", "function": {"name": "write_todos"}},
        )

    def wrap_model_call(self, request, handler):
        return super().wrap_model_call(self._plan_first(request), handler)

    async def awrap_model_call(self, request, handler):
        return await super().awrap_model_call(self._plan_first(request), handler)
