# SQL Studio 文档

## 用户文档

| 文档 | 内容 |
|------|------|
| [快速入门](getting-started.md) | Windows 构建、首次登录和服务端要求 |
| [配置与本地数据](configuration.md) | 环境字段、配置文件、凭据存储、备份与清理 |
| [插件](plugins.md) | 插件管理与钉钉机器人安全配置 |
| [FAQ](FAQ.md) | 权限、CSRF、TLS、WebView2、SmartScreen 和 PostgreSQL 常见问题 |
| [安全策略](../SECURITY.md) | 漏洞报告、支持范围和当前安全边界 |
| [隐私说明](../PRIVACY.md) | 本地数据、网络请求和权限用途 |

## 开发者文档

| 文档 | 内容 |
|------|------|
| [架构说明](architecture.md) | Tauri 前端、Rust 宿主、请求链路和 PostgreSQL schema |
| [开发指南](development.md) | 工具链、模块职责和代码约定 |
| [测试指南](testing.md) | 单元测试、Rust 检查、构建和 Windows E2E |
| [发布指南](releasing.md) | 版本同步、变更记录、历史审计和发布产物 |
| [贡献指南](../CONTRIBUTING.md) | 提交规范、验证要求和敏感数据边界 |
| [第三方说明](third-party.md) | 直接依赖、上游项目与许可证边界 |

## 功能文档

| 文档 | 主要内容 | 状态 |
|------|----------|------|
| [控制台多 SQL](console-multi-sql/) | 当前语句/选区解析、多语句执行、失败继续、结果页签 | 已实现并验证 |
| [SQL 自动联想](sql-autocomplete-enhancements/) | 语句隔离、跨词匹配、方言函数、完全匹配与 schema 隔离 | 已实现并验证 |
| [数据网格与树联动](console-grid-enhancements/) | 网格列宽、排序筛选、复制导出、资源树联动 | 已实现并验证 |
| [Windows 桌面端](windows-desktop/) | Tauri 2 架构、凭据、构建和运行边界 | 已实现并验证 |
| [执行流程需求](execution-workflow/) | 流水线、插件数据链路、执行记录与存储边界 | 需求已整理 |
| [流水线技术方案](execution-workflow/technical-design.md) | Rust 后台执行、SQLite、调度、插件与通知中心架构 | 待实施 |
| [流水线执行计划](execution-workflow/implementation-plan.md) | 分阶段任务、完成门禁、测试与交付策略 | 待实施 |

`windows-desktop/技术方案.md` 保留为历史设计与实施记录；当前行为以根 README、用户文档和代码为准。
