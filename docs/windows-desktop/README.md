# Windows 桌面端

SQL Studio Windows 浏览器模式由 Rust 本地 HTTP 服务承载，界面在系统默认浏览器中打开；网络、Cookie 和凭据由 Rust 宿主提供。

## 功能差异

- 使用 `reqwest` 直连 Archery，不受浏览器 CORS 限制；
- 每个环境使用独立 Cookie Jar；
- 密码存入 Windows 凭据管理器；
- CSV 使用浏览器下载导出；
- 浏览器页面关闭后本地服务继续在 Windows 系统托盘运行；托盘左键重新打开页面，右键菜单提供“打开 SQL Studio”和“退出”；
- PostgreSQL 支持数据库 → schema → 表，且不展示无数据来源的 DDL 页签。

## 构建与运行

依赖 Node.js 20+、Rust stable MSVC 和 Microsoft C++ Build Tools。

```powershell
npm ci
npm test
npm run build
```

产物：

```text
src-tauri/target/release/sql-studio.exe
```

当前只构建未签名的便携 exe，不生成安装包。SmartScreen 可能提示未知发布者。

## 数据位置

- 配置、历史和控制台工作区：`%APPDATA%\com.fanxiaofan.sql-studio\store.json`；
- 密码：Windows 凭据管理器，服务名 `sql-studio`，账号为环境 `id`；
- 删除 exe 不会自动删除配置或凭据。

完整清理方式见 [配置与本地数据](../configuration.md)。

## 网络与安全边界

- Rust HTTP 客户端通过 `no_proxy()` 绕过系统和环境变量代理；
- 当前通过 `danger_accept_invalid_certs(true)` 接受无效或自签 TLS 证书；
- 上述行为适用于受控内网，不是公网连接的安全默认值；
- 本地页面使用每次启动随机生成的令牌校验宿主 API 请求。

更多说明见根目录 [SECURITY.md](../../SECURITY.md)。

## 测试

- `npm test`：单元测试、SQL/DDL 解析、会话持久化和桌面端项目检查；
- `cargo fmt` / `cargo check`：Rust 格式和类型检查；
- `cargo test`：本地服务与托盘菜单行为的 Rust 单元测试。

完整命令见 [测试指南](../testing.md)。

历史迁移设计和实施记录见 [技术方案.md](./技术方案.md)，当前行为以本 README、根文档和代码为准。
