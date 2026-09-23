# AGENTS.md

本文件为 AI 编码助手提供 SQL Studio 桌面客户端的协作指引。

## 项目概述

SQL Studio 是兼容 **Archery HTTP 接口**的 Windows 可视化数据库客户端（浏览器扩展版位于 `extension` 分支）。桌面端基于 **Tauri 2 + Rust + WebView2**，网络请求与 Django 会话由 Rust 宿主处理，密码保存到 Windows 凭据管理器，CSV 通过原生另存为对话框导出。前端为**纯 ESM 无打包器**（`tauri.conf.json` 的 `frontendDist: ../src`、`withGlobalTauri: true`）。

## 仓库结构

```text
sql-studio/
├── docs/          用户、架构、开发与功能文档（docs/README.md 有索引）
├── src/           Tauri 前端：index.html + app.js + app.css + theme-bootstrap.mjs + lib/*.mjs
├── src-tauri/     Rust 宿主
├── test/          单元测试、mock 与 Windows E2E
├── contracts/     principal-identity / remediation-decisions / sql-studio-query-contract
├── gl/            预置 sql-studio.exe / sql-studio-browser.exe
├── .github/  .codex-tasks/
└── package.json  README.md  CHANGELOG.md  CONTRIBUTING.md  SECURITY.md  PRIVACY.md  LICENSE
```

## 入口与关键文件

- Rust 入口 `src-tauri/src/main.rs`：注册全部 `tauri::command` + `setup()`（KV、凭据、MCP、调度、托盘）。
- Rust 模块：`archery/`（登录 / 代发 / 每环境 Cookie Jar / CSRF：`login` / `api_get` / `api_post`）、`background.rs`（托盘 / 单实例 / 隐藏恢复）、`mcp.rs` + `mcp_tools.rs`、`session.rs`（按 `envId` 解析环境与凭据、复用或建立会话）、`scheduler.rs`（cron 调度）、`storage/`（`workflow_db.rs` SQLite + `migrations.rs`）、`workflows/`（commands / domain / execution* / plugin_* / repository / schedule_* / validation）、`notifications/`、`plugins/`（`dingtalk.rs`、`message_builder.rs`）。
- 前端 `src/`：`index.html`、`app.js`（页面编排）、`app.css`、`theme-bootstrap.mjs`、`default-envs.json`；`src/lib/`（约 48 文件）：`api.js`（调 Tauri）、`sql-editor.mjs`、`db-context.mjs`、`console-*.mjs`、`resource-tree-*.mjs`、`workflow-*.mjs`、`mcp-dialog.mjs`、`store.js`、`ddl.js` 等。`src/lib/package.json` 为 `{"type":"module"}`。
- 权限：`src-tauri/capabilities/default.json` 仅 `core:default`，业务走自定义 command。

## 常用命令

```powershell
npm ci
npm test                                            # test:unit + test:project
npm run dev                                         # tauri dev
npm run build                                       # tauri build --no-bundle（便携 exe）
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --locked --manifest-path src-tauri/Cargo.toml
```

- `test:unit`：`node test/theme.mjs && node test/unit.mjs && …`（主题 / 会话恢复 / 资源树 / 表空态 / 工作流排期 / 联想等）。
- `test:project`：`node test/project.mjs`（工程检查）。
- E2E：`test/e2e.js`（界面主流程）与 `test/e2e-mcp.js`（MCP / `POST /sql` 接口与跨环境免登录），均为 playwright-core + `test/mock-archery.js` + WebView2 CDP，不是 npm script。
- 产物：`src-tauri/target/release/sql-studio.exe`。

## MCP 服务与本地 SQL 接口

- `src-tauri/src/mcp.rs`：axum HTTP 服务，绑定 **`127.0.0.1:37625`**，路由 `POST /mcp`（MCP 协议 `2025-06-18`，server name `sql-studio`）与 `POST /sql`（脚本用 SQL 执行接口，请求体同 `execute_sql` 参数，失败返回 `{ok:false,error}`）。
- 40 位 Access Token 存 Windows 凭据管理器（service `sql-studio-mcp`）；command 为 `mcp_status` / `mcp::mcp_reset_token`；MCP 客户端 JSON 用 `streamable-http` URL（带 `?token=`），两个路由都接受 `Authorization: Bearer`。
- `src-tauri/src/mcp_tools.rs`：6 个工具 `list_environments` / `list_instances` / `list_databases` / `list_tables` / `get_table_schema` / `execute_sql`，只收定位参数，**不经参数传密码**；`execute_sql` 的 `limit` 默认 100、上限 1000。
- `src-tauri/src/session.rs`：按 `envId` 解析环境（KV `sqls_envs`）与凭据（KV `sqls_creds` + 凭据管理器），优先复用进程内会话，否则用已保存凭据登录 —— 界面停在别的环境也能查询目标环境（跨环境免登录）。
- 前端入口 `src/lib/mcp-dialog.mjs`，弹窗展示 `/mcp` 与 `/sql` 两个端点；`/sql` 旁的 `?` 打开接口文档弹窗 `#sqlApiMask`（内容在 `src/index.html`，地址与 curl 示例由 `renderApiDoc` 按当前 Token 填充）。

## 服务端接口

| 接口 | 方法 | 用途 |
|------|------|------|
| `/authenticate/` | POST | Django 表单登录与 CSRF 校验 |
| `/group/user_all_instances/?tag_codes[]=can_read` | GET | 获取可读实例 |
| `/instance/instance_resource/` | GET | 获取 database / schema / table / column 资源 |
| `/instance/describetable/` | POST | 获取表结构或 DDL |
| `/query/` | POST | 执行 SQL |

## 安全约定与注意

- **不绕过**服务端实例权限、SQL 审核、脱敏或查询限制。
- 表数据浏览在分页查询外额外执行精确 `COUNT(*)`，大表 / 复杂 WHERE 可能增加负载。
- `reqwest` **绕过系统代理并接受无效 / 自签 TLS**，仅适合受控内网；公网存在中间人风险。
- 公开 Issue / 截图禁止提交真实域名、凭据、Cookie、Session、SQL、数据库内容。
- 提交前跑 `npm test` 与 cargo fmt / check。
- 文档见 `docs/`（`docs/README.md` 有索引）；自有代码 MIT。
