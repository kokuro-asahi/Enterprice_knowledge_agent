"""Measure concurrent, multi-turn Agent workflows.

Each virtual user creates one thread, then completes a three-step workflow in
that same thread. The default creative workflow deliberately uses no external
tools, making it suitable for testing Agent/model concurrency independently of
the policy knowledge-base MCP service.
"""

import argparse
import asyncio
import json
import statistics
import time
from dataclasses import dataclass
from uuid import uuid4

import httpx


WORKFLOWS = {
    "creative": (
        "为一支 30 秒的城市咖啡品牌短片设计创意方向。明确主题、受众、情绪变化和核心故事冲突。",
        "基于上面的创意方向，拆分为 6 个连续镜头；每个镜头说明画面主体、动作、景别、镜头运动与时长。",
        "根据上述镜头方案，输出可交付给制作团队的拍摄执行清单，包含场景、演员动作、道具、灯光氛围和连续性注意事项。",
    ),
    "policy": (
    "请检索公司请假制度，说明年休假申请的适用条件、所需材料和审批路径，并引用制度原文依据。",
    "基于刚才检索到的制度，如果员工有 3 天年休假并计划下周休，请给出办理步骤；不确定的内容必须明确说明需要以制度原文为准。",
    "请把上述结果整理成给员工的执行清单，按申请前、提交申请、审批后分组，并保留对应的制度依据。",
    ),
}


@dataclass
class TurnResult:
    elapsed: float
    first_delta: float | None
    status: str
    tool_calls: int
    tool_failures: int
    input_tokens: int = 0
    output_tokens: int = 0
    answer: str = ""
    error: str = ""


def percentile(values: list[float], percent: int) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * percent / 100
    lower, upper = int(position), min(int(position) + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def print_summary(name: str, values: list[float]) -> None:
    if not values:
        print(f"{name}: no successful samples")
        return
    print(
        f"{name}: count={len(values)} avg={statistics.mean(values):.3f}s "
        f"p50={percentile(values, 50):.3f}s p95={percentile(values, 95):.3f}s "
        f"max={max(values):.3f}s"
    )


async def run_turn(
    client: httpx.AsyncClient,
    url: str,
    user_id: str,
    prompt: str,
    thread_id: str | None,
    agent_role: str,
    active_skill_id: str | None,
    workflow_id: int,
    step: int,
) -> tuple[str, TurnResult]:
    body = {
        "user_id": user_id,
        "thread_id": thread_id,
        "stream": True,
        "content": [{"type": "text", "text": prompt}],
        "metadata": {"benchmark": "policy_workflow", "workflow": workflow_id, "step": step},
    }
    if thread_id is None:
        body["agent_role"] = agent_role
        if active_skill_id:
            body["active_skill_ids"] = [active_skill_id]

    started = time.perf_counter()
    first_delta: float | None = None
    result_thread_id = thread_id or ""
    status = "unknown"
    tool_calls = 0
    tool_failures = 0
    input_tokens = 0
    output_tokens = 0
    answer = ""
    error = ""
    event_name = ""
    try:
        async with client.stream("POST", url, json=body) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line:
                    continue
                if line.startswith("event: "):
                    event_name = line.removeprefix("event: ").strip()
                    continue
                if not line.startswith("data: "):
                    continue
                payload = json.loads(line.removeprefix("data: "))
                if isinstance(payload, dict) and payload.get("thread_id"):
                    result_thread_id = str(payload["thread_id"])
                if event_name == "message.delta" and first_delta is None:
                    first_delta = time.perf_counter() - started
                elif event_name == "tool.call.started":
                    tool_calls += 1
                elif event_name == "tool.call.failed":
                    tool_failures += 1
                elif event_name == "run.completed":
                    status = str(payload.get("status", "completed"))
                    answer = str(payload.get("message", ""))
                    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
                    input_tokens = int(usage.get("input_tokens") or 0)
                    output_tokens = int(usage.get("output_tokens") or 0)
                elif event_name == "run.failed":
                    status = "failed"
                    error = str(payload.get("error", "run.failed"))
    except Exception as exc:
        status = "failed"
        error = f"{exc.__class__.__name__}: {exc}"

    return result_thread_id, TurnResult(
        elapsed=time.perf_counter() - started,
        first_delta=first_delta,
        status=status,
        tool_calls=tool_calls,
        tool_failures=tool_failures,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        answer=answer,
        error=error,
    )


async def run_workflow(
    client: httpx.AsyncClient,
    semaphore: asyncio.Semaphore,
    args: argparse.Namespace,
    workflow_id: int,
) -> list[TurnResult]:
    async with semaphore:
        user_id = f"policy_workflow_bench_{uuid4().hex}"
        thread_id: str | None = None
        results: list[TurnResult] = []
        for step, prompt in enumerate(args.workflow_steps, start=1):
            if step == 1 and args.first_turn_padding_tokens:
                # On the deployed Qwen tokenizer, one "资料" character is one token.
                # The measured role/framework overhead is about 3,200 tokens, so
                # 96,800 padding tokens yields an approximately 100k-token input.
                prompt = f"{prompt}\n\n【压测上下文】\n" + "资料" * args.first_turn_padding_tokens
            thread_id, result = await run_turn(
                client, args.url, user_id, prompt, thread_id, args.agent_role, args.active_skill_id, workflow_id, step
            )
            results.append(result)
            print(
                f"workflow={workflow_id} step={step} status={result.status} elapsed={result.elapsed:.3f}s "
                f"first_delta={'-' if result.first_delta is None else f'{result.first_delta:.3f}s'} "
                f"input_tokens={result.input_tokens} output_tokens={result.output_tokens} "
                f"tools={result.tool_calls} tool_failures={result.tool_failures} answer_chars={len(result.answer)}"
                + (f" error={result.error}" if result.error else "")
            )
            if result.answer:
                print(f"  answer_preview={result.answer.replace(chr(10), ' ')[:160]!r}")
            if result.status != "completed":
                break
        return results


async def main_async(args: argparse.Namespace) -> None:
    semaphore = asyncio.Semaphore(args.concurrency)
    limits = httpx.Limits(max_connections=args.concurrency, max_keepalive_connections=args.concurrency)
    started = time.perf_counter()
    async with httpx.AsyncClient(timeout=args.timeout, limits=limits) as client:
        batches = await asyncio.gather(
            *(run_workflow(client, semaphore, args, workflow_id) for workflow_id in range(1, args.workflows + 1))
        )

    all_turns = [turn for workflow in batches for turn in workflow]
    completed_workflows = sum(len(workflow) == len(args.workflow_steps) and workflow[-1].status == "completed" for workflow in batches)
    workflow_elapsed = [sum(turn.elapsed for turn in workflow) for workflow in batches if workflow]
    print()
    print(f"workflows={args.workflows} completed_workflows={completed_workflows} concurrency={args.concurrency}")
    print_summary("workflow_elapsed", workflow_elapsed)
    for step in range(len(args.workflow_steps)):
        print_summary(f"step_{step + 1}_elapsed", [workflow[step].elapsed for workflow in batches if len(workflow) > step])
    print_summary("first_delta", [turn.first_delta for turn in all_turns if turn.first_delta is not None])
    print(f"tool_calls={sum(turn.tool_calls for turn in all_turns)} tool_failures={sum(turn.tool_failures for turn in all_turns)}")
    print(f"failed_turns={sum(turn.status != 'completed' for turn in all_turns)} wall_clock={time.perf_counter() - started:.3f}s")


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark concurrent, multi-turn Agent workflows.")
    parser.add_argument("--url", default="http://127.0.0.1:1752/v1/runs")
    parser.add_argument("--workflows", type=int, default=10, help="Total virtual-user workflows to run.")
    parser.add_argument("--concurrency", type=int, default=2, help="Workflows to run at the same time.")
    parser.add_argument("--timeout", type=float, default=300, help="Per-request timeout in seconds.")
    parser.add_argument("--workflow", choices=tuple(WORKFLOWS), default="creative")
    parser.add_argument("--agent-role", help="Override the role for the selected workflow.")
    parser.add_argument("--active-skill-id", help="Optional skill enabled only for new workflow threads.")
    parser.add_argument(
        "--first-turn-padding-tokens",
        type=int,
        default=0,
        help="Append this many one-token '资料' tokens to the first turn for long-context testing.",
    )
    args = parser.parse_args()
    if args.workflows < 1 or args.concurrency < 1 or args.first_turn_padding_tokens < 0:
        raise SystemExit("--workflows and --concurrency must be at least 1; padding cannot be negative")
    args.workflow_steps = WORKFLOWS[args.workflow]
    if not args.agent_role:
        args.agent_role = "enterprise_policy_advisor" if args.workflow == "policy" else "director"
    if args.workflow == "policy" and not args.active_skill_id:
        args.active_skill_id = "enterprise-policy"
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
