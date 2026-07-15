# Windows 桌面端

SQL Studio Windows 版使用 Tauri 2（Rust + WebView2）封装共享前端，网络、Cookie、凭据和文件对话框由 Rust 宿主提供。

## 功能差异

- 使用 `reqwest` 直连 Archery，不受浏览器 CORS 限制；
- 每个环境使用独立 Cookie Jar；
- 密码存入 Windows 凭据管理器；
- CSV 使用原生另存为对话框；
- 记忆窗口位置和尺寸；
- PostgreSQL 支持数据库 → schema → 表，且不展示无数据来源的 DDL 页签。

## 构建与运行

依赖 Node.js 20+、Rust stable MSVC、Microsoft C++ Build Tools 和 WebView2 Runtime。

```powershell
Set-Location desktop
npm ci
npm test
npm run build
```

产物：

```text
desktop/src-tauri/target/release/sql-studio.exe
```

当前只构建未签名的便携 exe，不生成安装包。SmartScreen 可能提示未知发布者。

## 数据位置

- 配置、历史和控制台工作区：`%APPDATA%\com.fanxiaofan.sql-studio\store.json`；
- 密码：Windows 凭据管理器，服务名 `sql-studio`，账号为环境 `id`；
- WebView2 用户数据：`%LOCALAPPDATA%\com.fanxiaofan.sql-studio\EBWebView`（可安全删除，业务数据不在其中）；
- 删除 exe 不会自动删除配置或凭据。

启动白屏或关闭无响应时，复现后等待至少 15 秒，再查看 `%TEMP%\sql-studio-startup.log`。程序每次启动会重新生成该文件，记录 Windows/WebView2 环境、Tauri 插件、窗口与页面加载、前端初始化和卡死看门狗阶段；看门狗从 15 秒起还会记录 WebView2 子进程与崩溃报告。主窗口在 setup 阶段手动创建以精确定位 WebView2 卡点；启动自愈逐级降级——上次启动未完成时自动重置 WebView2 用户数据（改名为 `EBWebView.broken`），连续失败两次起追加 `--disable-gpu --disable-gpu-compositing`；Windows 10 上始终追加 `--disable-features=RendererCodeIntegrity` 规避安全软件注入导致的渲染进程崩溃。详细判读方式见 [常见问题](../FAQ.md)。

完整清理方式见 [配置与本地数据](../configuration.md)。

## 网络与安全边界

- Rust HTTP 客户端通过 `no_proxy()` 绕过系统和环境变量代理；
- 当前通过 `danger_accept_invalid_certs(true)` 接受无效或自签 TLS 证书；
- 上述行为适用于受控内网，不是公网连接的安全默认值；
- 当前 Tauri 配置尚未启用 CSP，任何前端脚本注入问题都应按高风险处理。

更多说明见根目录 [SECURITY.md](../../SECURITY.md)。

## 测试

- `npm test`：单元测试、SQL/DDL 解析、凭据加密和双端共享模块一致性；
- `cargo fmt` / `cargo check`：Rust 格式和类型检查；
- Windows E2E：mock Archery + WebView2 CDP，覆盖登录、MySQL/PostgreSQL、结构/DDL、多 SQL 和凭据边界。

完整命令见 [测试指南](../testing.md)。测试配置构建会开放本地 CDP 端口，不能作为发布产物。

历史迁移设计和实施记录见 [技术方案.md](./技术方案.md)，当前行为以本 README、根文档和代码为准。
