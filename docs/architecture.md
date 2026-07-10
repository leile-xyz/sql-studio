# 架构说明

SQL Studio 不增加自有服务端。两种客户端共享 UI 和大部分业务模块，但使用不同宿主完成网络、会话、存储和系统能力。

```text
                    ┌──────────────────────────┐
                    │   Shared UI and lib      │
                    │ editor/tree/grid/store   │
                    └─────────────┬────────────┘
                                  │
                  ┌───────────────┴───────────────┐
                  │                               │
        ┌─────────▼─────────┐           ┌─────────▼─────────┐
        │ Browser extension │           │ Windows desktop   │
        │ api.js            │           │ api.js            │
        │ background.js     │           │ Tauri invoke      │
        │ Cookie + DNR      │           │ Rust reqwest      │
        └─────────┬─────────┘           │ Windows keyring   │
                  │                     └─────────┬─────────┘
                  └───────────────┬───────────────┘
                                  │
                         ┌────────▼────────┐
                         │     Archery     │
                         └─────────────────┘
```

## 共享模块

`desktop/src/lib/` 与 `extension/lib/` 中以下模块必须保持逐字节一致：

- `sql-editor.mjs`：SQL 拆分、美化、语句定位和自动联想；
- `about-dialog.mjs`：关于弹窗的版本读取与关闭交互；
- `db-context.mjs`：数据库类型、标识符引用、schema、分页查询和 COUNT SQL 生成；
- `console-draft.mjs`：控制台草稿生命周期；
- `app-events.mjs`：共享事件委托；
- `resource-tree-view.mjs`、`table-view.mjs`、`grid.mjs`：视图渲染；
- `icons.mjs`、`csv.mjs`：共享图标与导出辅助能力；
- `ddl.js`：解析 MySQL `CREATE TABLE` 与 PostgreSQL 列元数据，统一列默认值、索引和表属性模型。

单元测试会读取双端文件并校验完全一致，防止修复只落在一个客户端。

## 宿主差异

| 能力 | 浏览器扩展 | Windows 桌面端 |
|------|------------|----------------|
| HTTP | background service worker `fetch` | Rust `reqwest` command |
| 会话 | 浏览器 Cookie | 每环境独立 Cookie Jar |
| CSRF | Cookie + 动态 Origin/Referer 请求规则 | Rust 请求头直接构造 |
| 配置 | `chrome.storage.local` | Tauri 配置目录 JSON |
| 密码 | AES-GCM 本地混淆 | Windows 凭据管理器 |
| CSV | 浏览器下载 | 原生另存为对话框 |

## PostgreSQL schema

`schema_name` 从资源树一路贯穿标签页、表结构、查询、控制台、历史、草稿和自动联想缓存。缓存键包含 origin、实例、数据库、schema 和表，避免不同 schema 下同名表共享字段元数据。

## 表数据分页与总数

每次加载或刷新表数据时（包括翻页、排序和变更 WHERE），客户端除分页数据查询外还会通过 `/query/` 执行一条 `COUNT(*)`。COUNT 使用与数据查询相同的实例、数据库、schema、表和 WHERE 上下文，但不携带排序、`LIMIT` 或 `OFFSET`；返回的首行首列用于计算总条数、总页数和分页按钮边界。

`affected_rows` 表示服务端对当前 SQL 的影响行语义，不能作为 SELECT 的全表总数。精确 COUNT 会增加一次数据库查询，大表、复杂 WHERE 或缺少合适索引时可能产生明显负载，性能与超时仍由数据库和 Archery 控制。

## 安全边界

浏览器扩展依赖广域 host/cookie 权限；桌面端绕过系统代理并接受无效 TLS 证书。更完整说明见 [SECURITY.md](../SECURITY.md)。
