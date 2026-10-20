# 混合普通问题 + 攻击问题，20 次请求，10 并发
python scripts/benchmark_latency.py --concurrency 10 --seed 1

# 无外部工具的多轮 Agent 工作流压测：10 位虚拟用户，每人连续完成 3 个创作任务，2 路并发。
python scripts/benchmark_policy_workflow.py --workflow creative --workflows 10 --concurrency 2

# 约 10 万 token 的首轮输入（96,800 个 padding token + 约 3,200 个框架开销），先从单并发开始。
python scripts/benchmark_policy_workflow.py --workflow creative --workflows 1 --concurrency 1 --first-turn-padding-tokens 96800

# 企业制度知识库工作流压测；仅在政策 MCP 服务可用时运行。
python scripts/benchmark_policy_workflow.py --workflow policy --workflows 10 --concurrency 2
