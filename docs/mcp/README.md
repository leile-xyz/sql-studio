# MCP 服务与本地 SQL 接口

## 速览

SQL Studio 启动后会在本机 `127.0.0.1:37625` 提供一个 HTTP 服务：

- `POST /mcp`：MCP（Model Context Protocol）streamable-http 端点，供支持 MCP 的客户端调用；
- `POST /sql`：面向脚本 / 其他系统的 SQL 执行接口，请求体与 MCP 的 `execute_sql` 工具参数一致。

两者共用同一个 40 位 Access Token（保存在 Windows 凭据管理器，service `sql-studio-mcp`），并共用同一套「按环境定位会话」的逻辑，因此都可以操作与界面当前环境不同的环境。MCP 弹窗（顶栏 M 按钮）会直接展示两个端点、Token、客户端 JSON 配置与工具清单；「SQL 执行接口」旁的 `?` 按钮会打开内置的接口文档弹窗（端点、参数、响应、状态码、行为边界、常见错误，其中的地址与 curl 示例会带上当前 Token，可直接复制）。

## 接入方式

MCP 客户端（弹窗内可直接复制 JSON）：

```json
{
  "mcpServers": {
    "sql-studio": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:37625/mcp?token=<Access Token>"
    }
  }
}
```

脚本调用（`token` 也可以放在 `Authorization: Bearer <token>` 头里）：

```powershell
curl.exe -X POST "http://127.0.0.1:37625/sql?token=<Access Token>" `
  -H "Content-Type: application/json" `
  -d '{"envId":"pre","instanceName":"mysql-pre","databaseName":"app","schemaName":"","sql":"select 1","limit":10}'
```

## MCP 工具

| 工具 | 入参 | 返回 | 底层调用 |
|------|------|------|----------|
| `list_environments` | 无 | `id` / `name` / `origin` / `color` | 读本地 KV，不联网 |
| `list_instances` | `envId` | 该环境可读实例 | `GET /group/user_all_instances/?tag_codes[]=can_read` |
| `list_databases` | `envId`, `instanceName` | 数据库列表 | `GET /instance/instance_resource/`（database 层） |
| `list_tables` | `envId`, `instanceName`, `databaseName`, `schemaName?` | 数据表列表 | 同上（table 层） |
| `get_table_schema` | 上述 + `tableName` | 字段、索引、DDL | `POST /instance/describetable/` |
| `execute_sql` | `envId`, `instanceName`, `databaseName`, `schemaName?`, `sql`, `limit?` | 结果集与元信息 | `POST /query/` |

`execute_sql` 一次只执行一条语句；`limit` 默认 100、上限 1000，超出会被夹紧并在结果的 `rowLimit` 中回显。

## POST /sql 契约

请求体字段与 `execute_sql` 参数一致（camelCase）：

| 字段 | 必填 | 说明 |
|------|------|------|
| `envId` | 是 | SQL Studio 环境标识，决定用哪个环境的会话 |
| `instanceName` | 是 | Archery 实例名 |
| `databaseName` | 是 | 数据库名 |
| `schemaName` | 否 | PostgreSQL schema；MySQL 省略或传空串 |
| `sql` | 是 | 单条 SQL |
| `limit` | 否 | 返回行数上限，默认 100，最大 1000 |

成功响应：

```json
{
  "ok": true,
  "result": {
    "columns": ["id", "name"],
    "columnTypes": ["LONGLONG", "VAR_STRING"],
    "rows": [[1, "张三"]],
    "elapsedSeconds": 0.012,
    "affectedRows": 0,
    "fullSql": "select * from t_user",
    "isMasked": false,
    "rowCount": 1,
    "rowLimit": 100,
    "truncated": false
  }
}
```

| 情况 | HTTP | 响应体 |
|------|------|--------|
| 执行成功 | 200 | `{"ok":true,"result":{...}}` |
| 参数、凭据、SQL 或网络导致的失败 | 200 | `{"ok":false,"error":"中文原因"}` |
| 请求体不是 JSON 对象 | 400 | `{"ok":false,"error":"请求体必须是 JSON 对象"}` |
| token 缺失或错误 | 401 | `{"ok":false,"error":"MCP token 无效"}` |

失败仍返回 200 是为了与 MCP 侧保持一致：请求本身被正常处理，业务是否成功看 `ok`。

## 跨环境免登录

界面停在哪个环境不影响接口调用——`envId` 决定用哪个环境的会话，按以下顺序解析：

1. **复用进程内会话**：该环境在本次运行中登录过，直接用现成的 Cookie Jar；
2. **用已保存凭据登录**：该环境在环境管理里保存过用户名并勾选过「记住密码」，则用凭据管理器里的密码自动登录；
3. **明确报错**：以上都不满足时返回 `该环境尚未登录且未保存密码，请先在 SQL Studio 登录并勾选记住密码`（无用户名时返回 `该环境尚未保存登录用户名`）。

会话被 Archery 判定失效（返回登录页）时，`execute_sql` 会用已保存凭据重新登录一次并重试；重登失败则把可操作的原因返回给调用方。

## 安全边界

- 服务只绑定 `127.0.0.1`，不对外网开放；Token 等价于本机 SQL 执行权限，泄漏等于把数据库查询权限交出去。
- 接口**不接受调用方传入账号密码**，凭据只来自本地 KV 与 Windows 凭据管理器；密码不写入 `store.json`、不写日志。
- 语句原样提交给 Archery，由服务端的实例权限、审核与脱敏规则决定能否执行；SQL Studio 不做改写也不绕过。
- 接口可执行写操作（`UPDATE` / `DELETE` / DDL）——服务端审核是唯一兜底，请只在受控环境使用；需要收紧时可让 Archery 侧限制该账号的写入权限。
- 服务未配置 CORS 响应头，浏览器页面无法跨源读取响应。

## 常见错误

| 现象 | 原因 | 处理 |
|------|------|------|
| `MCP token 无效` | Token 不匹配或已重置 | 在 MCP 弹窗复制最新 Token，或更新客户端配置 |
| `环境不存在：xxx` | `envId` 写错或环境已删除 | 先调 `list_environments` 拿准确 id |
| `该环境尚未保存登录用户名` | 该环境从未在界面登录过 | 在环境管理里登录一次该环境 |
| `该环境当前未登录且未保存密码…` | 登录过但未勾选「记住密码」 | 重新登录并勾选「记住密码」 |
| 弹窗显示「启动失败」 | 端口 37625 被占用 | 关闭占用进程后重启应用 |

## 验证

- Rust 单元测试：工具 schema、参数校验、`limit` 夹紧、结果字段、Token 解析、请求体校验（`cargo test --locked`）。
- 工程检查：`npm test` 中的 `testMcpStructure` 与命令名一致性检查。
- 端到端：`node test/e2e-mcp.js <exe>`，用 mock Archery 驱动真实界面，覆盖鉴权、契约、参数边界与「界面在线上、预发无会话仍查询成功」的跨环境场景。

## 提交记录

| 提交 | 日期 | 说明 |
|------|------|------|
| `b7c9a11` | 2026-07-17 | 内置 MCP 服务与 5 个只读资源工具 |
| `c0e72af` | 2026-07-17 | MCP 工具参数校验、凭据解析与 Token 重置 |
| 待提交 | 2026-09-23 | `execute_sql` 工具与 `POST /sql` 接口、跨环境免登录（`session.rs`）、会话失效重登 |
