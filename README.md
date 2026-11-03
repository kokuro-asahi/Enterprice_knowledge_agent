# Deep Agents Interface Backend

Phase-one backend for the Agent interface described in the attached API and technical documents.

## Scope

- `POST /v1/runs` for text/image conversations, streaming or JSON.
  - When `thread_id` is empty, provide either `agent_role` or `agent_prompt`.
  - `agent_role` must be one of `director`, `cinematographer`, `art_director`, `screenwriter`, or `storyboard_artist`, or `null`.
  - When `agent_role` is `null`, `agent_prompt` is used as the Agent system prompt.
  - When `thread_id` is provided, it must already exist; unknown threads return `404`.
  - Role system prompts are loaded from `app/prompts/roles/*.md`.
- `POST /v1/threads/{thread_id}/context` to clear future model context without deleting history.
- `GET /v1/threads/{thread_id}/messages` for reverse chronological Q&A pagination.
- Custom DeepAgents tools are registered from `app/tools.py`, including time lookup and Bocha web search.
- DeepAgents/LangGraph `PostgresSaver` stores model checkpoints in PostgreSQL.
- Business tables store API-facing data in PostgreSQL:
  - `agent_threads`
  - `agent_runs`
  - `agent_messages`
  - `api_request_logs`
  - `agent_event_logs`
- No custom tools or subagents in phase one.

## Local Setup

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload
```

`AGENT_BACKEND=echo` is the default development mode. Set `AGENT_BACKEND=deepagents` and provide model credentials to use Deep Agents.
`MODEL_TIMEOUT_SECONDS` controls the backend's single model-call timeout (default: `60`). For long-context tests, set it to a value such as `600` and restart the backend.
Set `BOCHA_API_KEY` to enable the `bocha_search` web search tool.
`MODEL_GUARD_ENABLED=true` runs a lightweight model-disclosure guard before the main Agent call. Requests about model identity, internal performance parameters, prompts, or implementation details return `MODEL_GUARD_RESPONSE`; all other requests continue to the original Agent flow.

## 登录与用户表

启动时自动创建 `app_users` 和 `auth_sessions`。所有对话、会话、技能接口均要求登录；
首页静态文件和 `/health` 保持公开。网页已接入账号密码登录、Cookie 登录状态恢复和退出登录。
登录过期或账号禁用时自动回到登录表单并清理当前用户的数据；对话列表仅展示当前用户的会话。
不提供公开注册。首次启动自动初始化管理员账号 `admin`，密码为 `admin`，访问等级为 `3`。
初始化只补充缺失的默认账号，不覆盖已有账号的密码、用户名和启用状态。页面直接展示 `username`。
启动时自动移除旧版本用户表中的 `display_name` 字段。

### 用户表 `app_users`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `user_id` | TEXT，主键 | 稳定的用户标识，与会话中的 `user_id` 对应，不随登录名修改 |
| `username` | TEXT，唯一、非空 | 登录账号，区分大小写 |
| `password` | TEXT，非空 | 按当前需求存储明文密码；接口响应不返回该字段 |
| `access_level` | SMALLINT | `1` 初级、`2` 中级、`3` 高级，默认 `1`，数据库限制只能为这三个值 |
| `is_admin` | BOOLEAN | 管理员标识，默认 `false`，与知识库访问等级独立 |
| `is_active` | BOOLEAN | 是否允许登录，默认 `true`；禁用后已有 Session 也无法访问 |
| `created_at` | TIMESTAMPTZ | 创建时间，默认当前时间 |
| `updated_at` | TIMESTAMPTZ | 修改时间，初始为当前时间；手动更新账号时同步设置 |
| `last_login_at` | TIMESTAMPTZ，可空 | 最近一次成功登录时间 |

`access_level` 本次仅保存并通过登录接口返回，尚未接入 MCP/Milvus 的文件权限过滤。
`is_admin=true` 可进入“账户管理”，并访问 `/v1/admin/users` 账户管理接口和 `/v1/threads/users` 历史会话用户列表，
管理员也不能通过替换 `user_id` 操作其他用户的会话。

在应用使用的 PostgreSQL 数据库中执行以下 SQL 可扩充账号（先替换示例密码）：

```sql
INSERT INTO app_users (user_id, username, password, access_level)
VALUES ('user_001', 'zhangsan', '请替换为实际密码', 1);

INSERT INTO app_users (user_id, username, password, access_level, is_admin)
VALUES ('user_manager', 'manager', '请替换为另一个实际密码', 3, true);

-- 调整访问等级。
UPDATE app_users SET access_level = 2, updated_at = now() WHERE username = 'zhangsan';

-- 禁用账号：已有会话凭证立即无法通过后续请求的校验。
UPDATE app_users SET is_active = false, updated_at = now() WHERE username = 'zhangsan';

-- 改密码并同时注销该用户的全部登录 Session。
BEGIN;
UPDATE app_users SET password = '请替换为新密码', updated_at = now() WHERE username = 'zhangsan';
DELETE FROM auth_sessions WHERE user_id = (SELECT user_id FROM app_users WHERE username = 'zhangsan');
COMMIT;
```

历史会话不会自动分配给新账号。需要继承历史会话时，由管理员核实归属后，
把新账号的 `user_id` 设置为历史会话对应的 ID；不要允许用户自行领取该 ID。

### 管理员账户与权限管理

以 `admin / admin` 登录后，点击页面顶部的 **账户管理**，可以：

- 搜索、分页查看账号列表。
- 新增账号并设置初始密码。
- 调整初级（1）、中级（2）、高级（3）访问等级。
- 设置管理员身份、启用或停用账号。
- 修改用户名、重置密码；用户 ID 保持不变，因此历史会话归属保持不变。

管理员不能停用自己或取消自己的管理员身份。重置密码、停用账号会撤销该账号的
全部登录 Session；重置自己的密码后需重新登录。管理员身份或等级变更在后续请求中生效。
页面不展示密码；数据库按当前约定保存明文密码。
访问等级仍仅保存配置，尚未接入知识库文件分级检索。

| 接口 | 用途 |
| --- | --- |
| `GET /v1/admin/users?q=&limit=50&offset=0` | 搜索和分页查询账号，返回 `users` 和 `total` |
| `POST /v1/admin/users` | 新增账号；必填 `username`、`password`，可选 `access_level`、`is_admin`、`is_active` |
| `PATCH /v1/admin/users/{user_id}` | 更新上述字段；不修改密码时省略 `password` |

接口仅允许管理员访问；普通用户返回 `403`，未登录返回 `401`。
重复用户名返回 `409 USERNAME_TAKEN`；不提供删除接口，可停用账号以保留历史会话。

### 登录会话与接口

`auth_sessions` 保存 `token_hash`（随机令牌的 SHA256 摘要，主键）、`user_id`
（外键，删除账号时级联删除）、`created_at` 和 `expires_at`。
原始令牌只在登录响应及 HttpOnly Cookie 中返回；退出时删除对应 Session。
过期 Session 在成功登录时清理。

| 接口 | 说明 |
| --- | --- |
| `POST /v1/auth/login` | JSON `{"username":"zhangsan","password":"实际密码"}`；返回 `access_token`、`token_type`、`expires_at`、`user`，并设置 `agent_session` Cookie |
| `GET /v1/auth/me` | 返回 `user_id`、`username`、`access_level`、`is_admin` |
| `POST /v1/auth/logout` | 注销当前令牌并清除 Cookie，成功返回 `204` |
| `GET /v1/threads/mine` | 查询当前登录用户的会话，无须提交 `user_id` |

同源网页自动使用 Cookie；脚本/API 客户端也可以发送 `Authorization: Bearer <access_token>`。
不要把令牌放在 URL 查询参数中。浏览器成功重新登录会注销其旧 Cookie 对应的 Session。

```bash
curl -sS -c /tmp/agent-cookies.txt http://127.0.0.1:1752/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"zhangsan","password":"实际密码"}'

curl -sS -b /tmp/agent-cookies.txt http://127.0.0.1:1752/v1/auth/me

curl -sS -b /tmp/agent-cookies.txt http://127.0.0.1:1752/v1/runs \
  -H 'Content-Type: application/json' \
  -d '{"agent_role":"enterprise_policy_advisor","content":[{"type":"text","text":"你好"}],"stream":false}'

curl -i -b /tmp/agent-cookies.txt -X POST http://127.0.0.1:1752/v1/auth/logout
```

业务接口现在根据登录身份确定用户。`POST /v1/runs`、上下文清理及消息查询中的
`user_id` 可省略；旧客户端仍可提交，但必须与登录用户一致，否则返回 `403 ACCESS_DENIED`。
缺少、过期或无效登录凭证返回 `401 AUTH_REQUIRED`；错误账号密码统一返回
`401 INVALID_CREDENTIALS`。流式请求在开始 SSE 前完成登录及会话归属校验。

可选环境配置：

```dotenv
AUTH_SESSION_TTL_SECONDS=86400
# 本地 HTTP 开发使用 false；生产 HTTPS 部署设为 true。
AUTH_COOKIE_SECURE=false
# 同源部署留空即可；跨域部署填写明确的前端 Origin，逗号分隔，不支持通配符。
CORS_ALLOWED_ORIGINS=
# 反向代理后的对外 URL，也用于校验 Cookie 写请求的 Origin。
PUBLIC_BASE_URL=http://127.0.0.1:1752
```

Cookie 写请求校验 `Origin` / `Sec-Fetch-Site`，拒绝不受信任的跨站请求。
跨域网页的 `fetch` 需显式设置 `credentials: "include"`；跨站 Cookie 部署还需单独设计。
密码只应放在登录请求体中，认证接口不会回显密码或验证失败时的原始输入。

验证命令：`python -m pytest -q`。数据库集成测试需显式执行
`python -m pytest tests/test_auth_postgres.py --auth-postgres -q`；该测试在配置的
PostgreSQL 中创建临时 schema，验证建表、约束及登录读写后清理，不修改现有业务表。

## Skills

### 企业规章制度知识库

新建会话选择角色 `enterprise_policy_advisor`（企业规章制度顾问），并手动勾选
`enterprise-policy` 技能。API 请求默认不启用技能。此技能提供知识库检索、条款解释、
流程梳理和来源引用，不修改知识库。

勾选技能后，Agent 可调用 `search_enterprise_policy` 查询知识库。
`bocha_search`（联网搜索）和 `get_current_time` 默认注册。
已有会话沿用创建时的技能选择；未启用知识库技能的会话需新建并勾选技能。

后端通过 MCP Streamable HTTP 连接现有知识库的 `search_policy` 工具。
`POLICY_MCP_URL` 默认是 `http://10.1.80.12:9020/mcp`，对应该服务允许的 Host。
认证优先使用 `POLICY_MCP_TOKEN`；未设置时仅从 `POLICY_MCP_ENV_FILE` 指定文件读取
`MCP_AUTH_TOKEN`（本机默认使用现有知识库项目的 `.env`）。不向前端或模型提供令牌。
迁移部署时配置这三个变量；不要把令牌写入 SKILL.md。

依赖已加入 `mcp==2.2.0`。修改后需重启对话后端以加载角色和工具代码，刷新页面。

When `AGENT_BACKEND=deepagents`, local skills are discovered from the comma-separated
directories configured by `AGENT_SKILLS_PATHS` (default: `skills`). Those directories
must be inside `AGENT_FILESYSTEM_ROOT`, which defaults to the project root. Each skill
lives in its own directory and starts with a `SKILL.md` file:

```text
skills/
  your-skill-name/
    SKILL.md
    scripts/
    references/
    assets/
```

`SKILL.md` must begin with YAML frontmatter. DeepAgents uses the `name` and
`description` to discover relevant skills and reads the complete instructions only
when a skill is selected.

`skills/` is the shared-skill source directory. For reuse in another project
using this architecture, copy or mount the complete directory below that
project's `AGENT_FILESYSTEM_ROOT`, keep `AGENT_SKILLS_PATHS=skills` in its
`.env`, and restart the backend. A skill that needs a backend tool must also
provide `scripts/tools.py` with a `get_tools()` entrypoint; the backend loads
its named callables only when that skill is selected. See the skill's
`references/environment.md` for its non-secret configuration requirements.

```markdown
---
name: your-skill-name
description: What this skill does and when the agent should use it.
---

# your-skill-name
```

### 会话技能选择

`GET /v1/skills` 返回前端技能选择器所需的安全元数据：`id`、`name`、
`description` 和 `enabled_by_default`（当前全部为 `false`）。创建新会话时可在
`POST /v1/runs` 中提交 `active_skill_ids`：

```json
{
  "user_id": "user_001",
  "agent_role": "director",
  "active_skill_ids": ["your-skill-name"],
  "content": [{"type": "text", "text": "开始创作"}]
}
```

所选 skill IDs 会持久化到 `agent_threads.active_skill_ids`；同一 `thread_id`
后续始终沿用该配置。运行时会按所选 skill 集合创建并缓存独立的 DeepAgents
实例，未选 skill 不会进入该会话的 skill 发现范围。

## Latency Benchmark

To measure the latency impact of the model guard, run the same benchmark twice
against a running `deepagents` service: once with `MODEL_GUARD_ENABLED=true`,
then restart with `MODEL_GUARD_ENABLED=false` and run it again.

```bash
/opt/miniconda3/envs/deepagent/bin/python scripts/benchmark_latency.py --concurrency 5
```

The script reports streaming time to first `message.delta` and total completion
time. When `--runs` is omitted, every built-in prompt in the selected prompt set
is asked once; the default `mixed` set contains 20 normal questions and 20
prompt-injection/model-disclosure probes. Use `--prompt-set normal`, `attack`,
or `mixed`, `--concurrency 5` for parallel requests, `--runs 5` for a smaller
random sample, `--prompt "..."` for one fixed question, `--seed 1` to shuffle the
full prompt set reproducibly or reproduce random samples, and `--json` for
non-streaming requests. Each result includes `answered_by=guard` when the reply
matches the configured fixed guard response, otherwise `answered_by=agent`. It
also reads `agent_event_logs` by `run_id` and prints
`guard_action={"action":"block"}`, `{"action":"allow"}`, or `-` for the actual
`model_guard.check` decision recorded by the server.

## Request Logs

Every HTTP request is recorded in `api_request_logs` with a generated `request_id`,
method, path, route, status code, duration, response size, client host, user agent,
and error payload when the request fails. `/v1/runs` requests also attach `run_id`,
`user_id`, and `thread_id` when those values become available.
A log row is inserted as `running` when the request starts and updated to `completed`
or `failed` when the response body finishes streaming.

Agent execution events are recorded in `agent_event_logs`, keyed by the same
`request_id` and run identifiers. These rows track database stages, model calls,
tool calls, retry attempts, durations, summaries, and error payloads.

## Error Codes

HTTP error responses use this shape:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "请求参数校验失败",
    "retryable": false
  }
}
```

`POST /v1/runs` streaming failures are sent as `run.failed` SSE events with the
same `error` object.

| Interface | HTTP status / event | Error code | Retryable | Meaning |
| --- | --- | --- | --- | --- |
| `POST /v1/runs` | `422` | `VALIDATION_FAILED` | `false` | Request body or query validation failed. |
| `POST /v1/runs` | `404` | `THREAD_NOT_FOUND` | `false` | Provided `thread_id` does not exist for the user. |
| `POST /v1/runs` | `run.failed` / JSON `status=failed` | `IMAGE_DOWNLOAD_FAILED` | depends on cause | Image URL is invalid or the image preflight download failed. |
| `POST /v1/runs` | `run.failed` / JSON `status=failed` | `MODEL_PROVIDER_FAILED` | `true` | Model provider or LangChain model call failed. |
| `POST /v1/runs` | `run.failed` / JSON `status=failed` | `TOOL_CALL_FAILED` | `true` | Agent tool execution failed. |
| `POST /v1/runs` | `run.failed` / JSON `status=failed` | `DB_OPERATION_FAILED` | `true` | Database operation failed during run execution. |
| `POST /v1/runs` | `run.failed` / JSON `status=failed` | `AGENT_RUN_FAILED` | `true` | Unclassified Agent execution failure. |
| `POST /v1/threads/{thread_id}/context` | `422` | `VALIDATION_FAILED` | `false` | Request body or path validation failed. |
| `POST /v1/threads/{thread_id}/context` | `404` | `THREAD_NOT_FOUND` | `false` | Thread does not exist for the user. |
| `POST /v1/threads/{thread_id}/context` | `500` | `DB_OPERATION_FAILED` | `true` | Database operation failed. |
| `GET /v1/threads/{thread_id}/messages` | `422` | `VALIDATION_FAILED` | `false` | Query or path validation failed. |
| `GET /v1/threads/{thread_id}/messages` | `404` | `THREAD_NOT_FOUND` | `false` | Thread does not exist for the user. |
| `GET /v1/threads/{thread_id}/messages` | `500` | `DB_OPERATION_FAILED` | `true` | Database operation failed. |

## Database

DeepAgents creates its own LangGraph checkpoint tables:

```bash
uvicorn app.main:app --reload
```

Application startup also creates the business tables above if they do not already exist.
