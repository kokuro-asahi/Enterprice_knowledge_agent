# enterprise-policy 环境配置

`SKILL.md` 指导 Agent 如何查询和使用制度资料。`scripts/tools.py` 提供只读 MCP 查询实现；启用 enterprise-policy 技能时，`get_tools()` 向 Agent 注册 `search_enterprise_policy`。以下配置用于连接知识库服务。

将此 skill 复制到另一套相同架构的 Agent 后，在该项目的 `.env` 配置以下变量，再重启后端：

```dotenv
# 企业制度 MCP 的 Streamable HTTP 地址；按目标环境替换。
POLICY_MCP_URL=https://policy-mcp.example.com/mcp

# 二选一的认证来源：推荐由部署平台注入该变量，切勿提交到仓库。
POLICY_MCP_TOKEN=replace-with-a-secret

# 若不使用 POLICY_MCP_TOKEN，可指定一个仅服务器可读的 .env 文件；
# 后端从其中读取 MCP_AUTH_TOKEN。
# POLICY_MCP_ENV_FILE=/secure/path/to/policy-kb.env
```

认证优先级如下：

1. `POLICY_MCP_TOKEN`
2. `POLICY_MCP_ENV_FILE` 所指文件内的 `MCP_AUTH_TOKEN`

至少提供其中一种认证方式。不要把令牌、真实内网地址或 `.env` 内容写入 `SKILL.md`、参考文件、前端或版本控制。

若目标项目没有企业制度 MCP，仍可复制该目录，用于指导解读用户提供的制度原文；自动检索需要可用的 MCP 服务和正确的认证配置。
