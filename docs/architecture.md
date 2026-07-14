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
- `console-session.mjs`、`console-workspace.mjs`：多控制台会话校验、迁移、保存和恢复；
- `console-menu-view.mjs`：固定控制台入口、当前控制台和全部控制台菜单；
- `query-row-limit.mjs`：查询、COUNT、分页窗口和响应行数的 1000 条统一边界；
- `console-query.mjs`、`console-execution.mjs`：控制台查询分类、分页 SQL、COUNT 和结果状态；
- `table-data-loader.mjs`：表数据与 COUNT 并行加载、页码校正和响应校验；
- `paged-export.mjs`、`export-service.mjs`、`csv-export-actions.mjs`：逐页结果校验与最多 1000 条的双端导出编排；
- `console-result-view.mjs`：控制台结果和分页栏渲染；
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

`schema_name` 从资源树一路贯穿标签页、表结构、查询、控制台、历史、会话恢复和自动联想缓存。缓存键包含 origin、实例、数据库、schema 和表，避免不同 schema 下同名表共享字段元数据。

## 控制台工作区

标签栏由固定控制台入口和独立滚动的标签区组成。每个环境保存全部控制台，包括稳定标识、标题、SQL、实例、数据库、schema、数据库类型、编辑器高度和打开状态；查询结果与运行状态不持久化。关闭控制台只把它从标签栏隐藏，下拉列表仍保留记录，点击后按稳定标识重新打开；菜单项支持重命名，删除图标会从当前环境目录永久移除该控制台，但不会清除独立 SQL 执行历史。

旧版本每环境单草稿首次读取时会迁移成 `console` 控制台。输入采用 300ms 防抖保存，新建、关闭、重开、切换环境和页面隐藏时会刷新待写入会话；写入串行执行，避免旧快照晚于新快照覆盖。

数据库树收起仅切换布局类，树节点、搜索内容、已加载数据和选择状态保留；收起后由独立窄栏提供重新展开入口。

## 表数据分页与总数

每次加载或刷新表数据时（包括翻页、排序和变更 WHERE），客户端除分页数据查询外还会通过 `/query/` 执行一条有界 `COUNT(*)`。COUNT 使用与数据查询相同的实例、数据库、schema、表和 WHERE 上下文，并通过内层 `LIMIT 1000` 返回 `min(实际匹配条数, 1000)`，用于计算最多前 1000 条数据的页数和分页按钮边界；界面不展示总条数。

`affected_rows` 表示服务端对当前 SQL 的影响行语义，不能作为 SELECT 的计数结果。有界 COUNT 仍会增加一次数据库查询；复杂 WHERE 或缺少合适索引时可能产生明显负载，性能与超时仍由数据库和 Archery 控制。

## 控制台分页与导出

没有顶层 `LIMIT`、`OFFSET` 或 `FETCH` 的普通 SELECT 和只读查询型 CTE 会自动分页：MySQL SQL 追加 `LIMIT/OFFSET`，PostgreSQL SQL 只追加 `OFFSET`，页大小通过 Archery 的 `limit_num` 传递，避免服务端再次追加 `LIMIT` 后形成重复语法。默认每页 100 条，并通过带 `LIMIT 1000` 的派生表 COUNT 计算最多前 1000 条的分页范围；所有响应仍不能超过 1000 条。每个多 SQL 结果页签独立保存执行时的实例、数据库、schema、页码和页大小；翻页只重查当前结果，并同步刷新 COUNT。数据修改 CTE、锁定查询、`SELECT INTO`、DML、DDL 以及用户自行分页的 SQL 保持单次执行，但响应仍不能超过 1000 条。

表数据和可分页控制台结果导出前会重新执行有界 COUNT，最多读取并导出 1000 条。收集器严格校验每页行数、列顺序和行宽；任一请求失败或最终行数与 COUNT 不一致时直接终止并显示错误。表元数据包含主键时，导出排序会把尚未包含的主键列追加为稳定排序键。

## 安全边界

浏览器扩展依赖广域 host/cookie 权限；桌面端绕过系统代理并接受无效 TLS 证书。更完整说明见 [SECURITY.md](../SECURITY.md)。
