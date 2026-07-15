# 贡献指南

感谢你为 SQL Studio Windows 桌面端提交问题、文档或代码。`main` 分支只维护 Tauri 桌面端；浏览器扩展实现位于 `extension` 分支。

## 开始之前

- 使用 Node.js 20 或更高版本。
- 桌面端开发需要 Rust stable（MSVC 工具链）、Microsoft C++ Build Tools 和 WebView2 Runtime。
- 不要在 Issue、PR、截图、日志或测试数据中提交真实域名、账号、密码、Cookie、CSRF Token、Session、SQL 查询结果或业务表名。

## 本地开发

```powershell
Set-Location desktop
npm ci
npm test
npm run dev
```

完整开发、测试和 E2E 流程见 [开发指南](docs/development.md) 与 [测试指南](docs/testing.md)。

## 代码结构

- `desktop/src/`：WebView2 中运行的前端页面和业务模块。
- `desktop/src-tauri/`：Tauri 2 配置、Rust 网络层、会话、凭据和文件对话框。
- `desktop/test/`：单元测试、项目检查、mock Archery 和 Windows E2E。
- `docs/`：用户、架构、开发和功能文档。

前端业务逻辑应放在职责明确的 `desktop/src/lib/` 模块中，宿主能力通过 Tauri command 注入，不要在业务模块中复制 Rust 宿主逻辑。

## 工程约定

- 源文件使用 UTF-8（无 BOM）和 LF 行尾。
- 函数不超过 100 行，源文件不超过 1000 行；复杂逻辑按职责拆分。
- 优先使用纯函数、不可变数据和明确错误；禁止伪造成功、吞掉异常或将安全失败静默降级。
- 不在前端拼接用户输入生成新的数据库查询语义；标识符必须走现有方言转义工具。
- 新增数据库行为时同时考虑 MySQL 与 PostgreSQL schema 上下文。
- 用户可见行为变化必须同步更新 README 或对应 `docs/` 文档。

## 测试要求

提交前至少执行：

```powershell
Set-Location desktop
npm test
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --locked --manifest-path src-tauri/Cargo.toml
```

涉及真实 UI、登录、资源树、查询或凭据边界的变更，应按 [测试指南](docs/testing.md) 运行 Windows E2E。E2E 调试构建不能作为发布产物。

## 提交 Pull Request

1. 从最新主分支创建功能分支。
2. 保持提交聚焦，避免混入无关格式化或生成产物。
3. 在 PR 中说明问题、方案、影响范围和验证结果。
4. UI 变化提供使用 mock/虚构数据生成的截图。
5. 确认相关代码、测试、文档、版本和变更记录已同步。

提交贡献即表示你有权提交相关内容，并同意贡献内容按仓库的 [MIT License](LICENSE) 分发。
