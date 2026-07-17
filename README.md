# SQL Studio

SQL Studio 是基于 [Archery](https://github.com/hhyo/Archery) 兼容 HTTP 接口的 Windows 可视化数据库客户端，提供库表浏览、数据查询、结构查看和多 SQL 控制台，无需修改服务端。

本项目是独立的社区客户端，与 Archery、Microsoft、JetBrains 或 DataGrip 没有官方隶属关系。

项目主页：[github.com/leile-xyz/sql-studio](https://github.com/leile-xyz/sql-studio)

`gl` 分支维护原有 Tauri 2 Windows 桌面端；`gl-browser-mode` 分支维护纯浏览器模式。

## 技术栈

浏览器模式基于 Rust 本地 HTTP 服务和系统默认浏览器，不依赖 Tauri 2 或 WebView2。网络与 Django 会话由本地 Rust 服务处理，密码保存到 Windows 凭据管理器，CSV 通过浏览器下载导出。

## 主要功能

- 多环境登录和环境切换；
- MySQL：实例 → 数据库 → 表；
- PostgreSQL：实例 → 数据库 → schema → 表；
- 表数据分页（总获取量和 CSV 导出最多 1000 条）、组合排序、WHERE 条件片段和结构查看；
- 多 SQL 拆分执行、选区优先、失败继续和结果页签；
- 自动联想按当前 SQL 与光标位置调整字段/表优先级；
- 字段、表、关键词和函数支持包含、跨词与完全匹配；
- MySQL/PostgreSQL 方言函数候选隔离；
- 控制台入口固定在标签栏最左侧，关闭标签后仍可从列表找回；列表支持重命名，并可通过删除图标永久移除控制台及其 SQL；
- 数据库树侧边栏支持收起和展开，收起不会清空树状态；
- 关闭主窗口后继续在后台运行，并在 Windows 系统托盘显示图标；左键图标恢复窗口，右键菜单可显示窗口或彻底退出；
- 控制台普通 SELECT 默认每页 100 条，COUNT、分页范围和 CSV 导出最多按 1000 条处理，并支持查询历史；
- 关于弹窗展示版本、客户端类型和 MIT 许可证。

## 兼容性

- 服务端需要提供 Archery 的登录、实例资源、表结构和查询接口。
- PostgreSQL 实例类型支持 `pgsql`、`postgres`、`postgresql`。
- PostgreSQL 的 DDL 页签取决于服务端 `describetable` 响应；当前兼容路径只展示数据和结构。
- 客户端面向 Windows 10/11；系统缺少 WebView2 Runtime 时需要单独安装。

## 快速开始

当前仓库不内置预编译或签名的 exe，需要从源码构建。

开发依赖：

- Node.js 20+；
- Rust stable（MSVC 工具链）；
- Microsoft C++ Build Tools；
- WebView2 Runtime。

```powershell
npm ci
npm test
npm run build
```

产物位于：

```text
src-tauri/target/release/sql-studio.exe
```

当前只生成便携 exe，不生成安装包，也未配置代码签名，因此 Windows SmartScreen 可能显示未知发布者提示。

更完整的安装、运行和首次配置说明见 [快速入门](docs/getting-started.md)。

## 环境配置

默认示例位于 `src/default-envs.json`，只在本地尚无配置时初始化：

```json
{
  "id": "test",
  "name": "测试环境",
  "color": "#5fad65",
  "base": "archery-test.example.com",
  "scheme": "https"
}
```

`base` 只填写主机名或 `IP:端口`，不要包含协议、路径或查询参数。

字段说明、数据位置、备份和清理方式见 [配置与本地数据](docs/configuration.md)。

## 服务端接口

| 接口 | 方法 | 用途 |
|------|------|------|
| `/authenticate/` | POST | Django 表单登录与 CSRF 校验 |
| `/group/user_all_instances/?tag_codes[]=can_read` | GET | 获取可读实例 |
| `/instance/instance_resource/` | GET | 获取 database/schema/table/column 资源 |
| `/instance/describetable/` | POST | 获取表结构或 DDL 信息 |
| `/query/` | POST | 执行 SQL |

客户端不会绕过服务端的实例权限、SQL 审核、脱敏或查询限制。

表数据浏览会在分页查询之外额外执行一条使用相同 WHERE 条件的 `COUNT(*)`，用于展示精确总条数、总页数并正确限制首页/末页按钮。大表或复杂 WHERE 的统计可能增加数据库负载和等待时间，具体性能取决于索引、数据库执行计划及服务端限制。

CSV 导出会沿用已应用的 WHERE 和排序条件，从第一页开始按 1000 条逐页读取并合并为一个文件；控制台中可自动分页的 SELECT 结果也使用相同的全量导出语义。任一页请求失败或分页期间结果行数与 COUNT 不一致时会明确报错，不生成不完整文件。

## 安全与隐私

- 项目不包含遥测、广告或自建云服务，只连接用户配置的 Archery。
- 保存密码存入 Windows 凭据管理器。
- 当前绕过系统代理并接受无效/自签 TLS 证书，只适合受控内网；公网连接存在中间人攻击风险。
- 公开问题和截图中禁止提交真实域名、凭据、Cookie、Session、SQL 或数据库内容。

详见 [安全策略](SECURITY.md) 与 [隐私说明](PRIVACY.md)。

## 开发与测试

```powershell
npm ci
npm test
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --locked --manifest-path src-tauri/Cargo.toml
```

Windows E2E 使用 mock Archery 和 WebView2 CDP，详细流程见 [测试指南](docs/testing.md)。

## 仓库结构

```text
sql-studio/
├── .github/                 # CI、Issue 与 PR 模板
├── docs/                    # 用户、架构、开发与功能文档
├── src/                     # Tauri 前端
├── src-tauri/               # Rust 宿主
├── test/                    # 单元测试、mock 与 Windows E2E
├── package.json
├── package-lock.json
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md
├── PRIVACY.md
└── LICENSE
```

模块职责和请求链路见 [架构说明](docs/architecture.md)。

## 文档

| 文档 | 内容 |
|------|------|
| [快速入门](docs/getting-started.md) | 构建、首次运行与服务端要求 |
| [配置与本地数据](docs/configuration.md) | 环境字段、配置位置、凭据和清理方式 |
| [架构说明](docs/architecture.md) | Tauri 前端、Rust 宿主和请求链路 |
| [开发指南](docs/development.md) | 开发环境、模块修改和工程约定 |
| [测试指南](docs/testing.md) | 单测、Rust 检查、生产构建和 E2E |
| [发布指南](docs/releasing.md) | 版本同步、发布前检查和产物说明 |
| [FAQ](docs/FAQ.md) | 登录、TLS、WebView2 和 PostgreSQL 常见问题 |
| [功能文档索引](docs/README.md) | 多 SQL、自动联想、网格和桌面端文档 |

## 参与贡献

请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。安全问题不要创建公开 Issue，应按 [SECURITY.md](SECURITY.md) 私密报告。

## 许可证

SQL Studio 自有代码按 [MIT License](LICENSE) 分发。第三方依赖、Archery 服务端和操作系统组件由各自许可证或条款约束，详见 [第三方说明](docs/third-party.md)。
