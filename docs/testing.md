# 测试指南

## 单元测试

```powershell
npm ci
npm test
```

测试覆盖 SQL 拆分、多语句格式化、自动联想、MySQL/PostgreSQL 方言、schema 上下文、多控制台会话迁移与恢复、CSV、关于弹窗元数据和桌面端项目结构。

## 静态检查

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --locked --manifest-path src-tauri/Cargo.toml
```

JavaScript/MJS 语法检查由项目测试和 CI 对 `src/` 全量执行。

## 生产构建

```powershell
npm run build
```

生产配置不开放 WebView2 CDP 调试端口。

## Windows E2E

E2E 仅支持 Windows，使用 mock Archery 和带本地 CDP 调试参数的测试构建。

桌面端流程同时检查关于弹窗的入口、版本、许可证和关闭交互。

构建测试程序：

```powershell
npm ci
npx tauri build --no-bundle --config test/tauri.e2e.conf.json
```

终端一启动 mock，默认监听 `127.0.0.1:9123`：

```powershell
node test/mock-archery.js
```

终端二运行 E2E：

```powershell
node test/e2e.js .\src-tauri\target\release\sql-studio.exe
node test/e2e-mcp.js .\src-tauri\target\release\sql-studio.exe
```

`test/e2e-mcp.js` 覆盖 MCP 服务的本地 HTTP 接口：`/sql` 的鉴权（401）、请求体校验（400）、`Bearer` 头、`limit` 夹紧、空 SQL 与未知环境错误、MCP `tools/list` 与 `tools/call execute_sql`，以及核心场景「界面停在线上、预发没有会话时用已保存凭据免登录查询成功」。脚本分两个阶段启动应用（先登录预发留下凭据，再以线上为活动环境登录并查询预发）。

注意：

- 两个 E2E 都会终止已有的 `sql-studio.exe` 和匹配测试应用标识的 WebView2 进程；
- 两个 E2E 都会替换 `%APPDATA%\com.fanxiaofan.sql-studio\store.json`：`test/e2e.js` 在结束时还原内存中的副本，`test/e2e-mcp.js` 先把原文件备份到 `%TEMP%` 再还原，并在退出时（含异常）做哈希校验，同时清理测试环境在 Windows 凭据管理器里的条目；
- 测试脚本为本地 CDP 设置 `NO_PROXY`；
- `test/tauri.e2e.conf.json` 生成的程序只用于测试，不能发布；
- 出现失败时保留真实错误和日志，不要改成 mock 成功路径。
