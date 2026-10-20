from typing import Any

from app.role_prompts import load_role_prompt


def to_model_message(role: str, content: list[dict[str, Any]]) -> dict[str, Any]:
    blocks: list[dict[str, Any]] = []
    for block in content:
        if block.get("type") == "text":
            blocks.append({"type": "text", "text": block.get("text", "")})
        elif block.get("type") == "image":
            blocks.append({"type": "image_url", "image_url": {"url": block.get("url", "")}})
    return {"role": role, "content": blocks}


def model_messages(
    content: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Build conversation-state messages for an agent invocation.

    DeepAgents supplies its own system message before the conversation state.
    A second system message here can therefore arrive after it, which strict
    OpenAI-compatible servers reject. Role instructions belong in
    ``agent_system_prompt`` and are passed to DeepAgents separately.
    """
    return [to_model_message("user", content)]


def agent_system_prompt(agent_role: str | None, agent_prompt: str | None) -> str | None:
    """Resolve the thread's stable system prompt for DeepAgents."""
    if agent_role:
        prompt = load_role_prompt(agent_role)
        if prompt:
            return prompt
    return agent_prompt or None
