# 流水线与通知中心技术方案

## 1. 文档目的

本文给出 [执行流程需求说明](README.md) 的落地架构，覆盖流水线管理、后台调度、SQL 与插件执行、产物传递、执行审计，以及软件自身的通知中心。

“通知中心”是软件内提醒能力，不属于插件，也不等于流水线中的 `message` 数据产物或钉钉机器人消息插件。

## 2. 设计原则

- Rust 宿主负责持久化、调度、执行、凭据读取和原生通知；前端只负责配置与展示；
- 首期只实现单向线性流水线，不引入 DAG、并行、条件和循环；
- 插件不直接互调，由执行器通过标准数据产物串联；
- 流程草稿可编辑，发布版本和脚本版本不可变；
- 执行失败必须显式记录，不跳过、不模拟成功、不隐式降级；
- `store.json` 保持现状，新功能使用独立 `workflow.db`；
- 密码、Webhook、Token 和 Secret 只进入 Windows 凭据管理器；
- 外部消息发送不自动重试，避免重复推送。

## 3. 概念与命名

| 概念 | 代码建议名称 | 说明 |
|------|--------------|------|
| 软件内提醒 | `AppNotification` | 通知中心、未读角标、Windows 通知 |
| 流水线消息产物 | `MessageArtifact` | 插件间传递的标准消息数据 |
| 消息构建插件 | `MessageBuilderPlugin` | 将表格、对象或文本加工为消息产物 |
| 钉钉发送插件 | `DingTalkSinkPlugin` | 消费消息并发送到钉钉的终止插件 |

## 4. 总体架构

```text
WebView2 前端
├── 流程列表 / 编辑 / 发布
├── 执行历史 / 产物查看
├── 插件资源选择
└── 通知铃铛 / 通知中心
              │ Tauri invoke / event
Rust 宿主
├── WorkflowService        草稿、版本、发布校验
├── WorkflowScheduler      Cron、时区、任务认领
├── WorkflowExecutor       SQL 与插件线性执行
├── ArcheryService         登录、会话、查询
├── PluginRegistry         插件元数据与执行器注册
├── NotificationService    应用消息与原生通知
├── WorkflowRepository     workflow.db
└── CredentialRepository   Windows 凭据管理器
```

定时任务和插件执行不得放在 WebView 中。主窗口隐藏到系统托盘后，Rust 后台仍需继续调度和执行。

## 5. 模块划分

### 5.1 Rust 宿主

```text
src-tauri/src/
├── archery/
│   ├── client.rs
│   ├── session.rs
│   └── query.rs
├── storage/
│   ├── legacy_store.rs
│   ├── workflow_db.rs
│   └── credentials.rs
├── workflows/
│   ├── commands.rs
│   ├── domain.rs
│   ├── repository.rs
│   ├── migrations.rs
│   ├── service.rs
│   ├── validation.rs
│   ├── scheduler.rs
│   ├── executor.rs
│   └── artifact_codec.rs
├── messages/
│   ├── commands.rs
│   ├── domain.rs
│   ├── repository.rs
│   └── notifier.rs
└── plugins/
    ├── registry.rs
    ├── message_builder.rs
    └── dingtalk.rs
```

`main.rs` 只负责依赖组装、状态注册和 Tauri command 注册。业务服务通过仓储、网关、时钟和插件执行器接口注入具体实现。

### 5.2 前端

```text
src/lib/
├── workflow-api.mjs
├── workflow-manager.mjs
├── workflow-editor.mjs
├── workflow-history.mjs
├── execution-detail.mjs
└── message-center.mjs
```

流水线作为一级业务页面，不使用大型弹窗。现有 `app.js` 已接近文件长度上限，新功能必须拆分模块。

## 6. 流程定义与版本

流程采用草稿与发布版本分离：

```text
编辑草稿 → 后端完整校验 → 发布不可变版本 → 启用 → 手动或定时执行
```

修改已启用流程只修改草稿；重新发布后，新执行使用新版本，历史执行继续引用原版本。删除流程、插件资源和脚本使用软删除，不破坏历史引用。

首期节点结构固定为：

```text
SQL → transform 0..N → sink 0..1
```

SQL 是第一个业务节点；终止插件最多一个且只能位于最后。

SQL 草稿保存明确的 `sql_kind`（`query` 或 `command`），分别声明输出 `table` 或 `object`。发布时使用声明类型校验后续插件连接，执行时再次核对 Archery 实际结果，不能通过解析 SQL 文本猜测类型。

## 7. 插件模型与数据链路

插件定义必须声明：

```text
accepts | produces | category | terminal
```

标准产物类型：

```text
table | object | text | message | files | none
```

执行器负责传递产物：

```text
SQL 输出 A → Python(A) 输出 B → 消息构建(B) 输出 C → 钉钉(C)
```

每个节点执行记录关联 `input_artifact_id` 和 `output_artifact_id`。发布时校验声明类型，运行时校验实际输出类型；不匹配时节点失败。

统一插件接口包含元数据、配置校验和执行能力。执行上下文只提供业务数据、非敏感元数据和受控能力，不包含数据库密码或其他插件凭据。

## 8. 插件资源

插件定义与具体资源分离。例如钉钉插件可有多个机器人资源，Python 插件可有多条脚本资源。

现有钉钉配置作为首个默认资源兼容：

```text
resource_id: dingtalk:default
credential_ref: plugin:dingtalk:default
accepts: message, text
produces: none
category: sink
terminal: true
```

后续多机器人使用 `plugin:dingtalk:{resource_id}` 作为凭据键。SQLite 只保存资源 ID、名称、状态、非敏感配置和凭据引用。

Python 流程节点必须引用明确的不可变脚本版本，并声明本节点确定的输出类型。

## 9. SQLite 设计

数据库路径：

```text
%APPDATA%\com.fanxiaofan.sql-studio\workflow.db
```

核心表：

| 表 | 作用 |
|----|------|
| `schema_migrations` | schema 迁移版本 |
| `workflow_definitions` | 流程名称、草稿状态、启用版本、软删除状态 |
| `workflow_draft_nodes` | 可编辑草稿节点 |
| `workflow_versions` | 已发布不可变快照 |
| `workflow_version_nodes` | 版本节点、顺序、类型和资源引用 |
| `workflow_schedules` | Cron、时区、下次执行时间 |
| `plugin_resources` | 插件资源非敏感信息 |
| `script_definitions` | Python 脚本资源 |
| `script_versions` | 不可变脚本版本 |
| `workflow_executions` | 流程总体执行记录 |
| `node_executions` | 节点状态、输入输出、耗时和错误 |
| `execution_artifacts` | CBOR、UTF-8 或文件引用产物 |
| `app_messages` | 软件通知内容与阅读状态 |
| `message_deliveries` | 应用内、Windows 通知投递记录 |
| `message_preferences` | 用户通知偏好 |

关键约束：

- `workflow_version_nodes(version_id, position)` 唯一；
- `workflow_executions(schedule_id, scheduled_for)` 唯一；
- 发布版本和脚本版本不可原地修改；
- 输入输出产物必须属于同一次流程执行；
- 终止节点约束由发布服务校验并通过数据库测试保障；
- 查询筛选字段使用普通列，结构化配置和产物使用 CBOR BLOB；
- SQLite 初始化或迁移失败时显式报错，不回退 JSON。

建议使用 `rusqlite` 的 `bundled` 特性，开启外键、WAL 和明确的 busy timeout。SQLite 操作放入独立工作线程或 `spawn_blocking`，避免阻塞异步运行时。

## 10. Archery 服务改造

现有登录、Cookie、CSRF 和 `/query/` 调用需要抽取为可被前端 command 与后台执行器共同使用的 `ArcheryService`。

```text
ensure_authenticated(env_id)
→ 获取环境及用户名
→ 检查对应身份的内存会话
→ 必要时从凭据管理器读取密码并登录
→ 执行查询
```

会话至少按“环境 ID + 用户身份”隔离。定时流程没有已保存凭据或凭据失效时必须失败并创建应用通知。

首期一个流程只允许一条业务 SQL，避免多 SQL 的产物、部分成功和失败语义不明确。

## 11. 执行状态机

流程状态：

```text
pending → running → succeeded
                  ↘ failed
                  ↘ cancelled
                  ↘ interrupted
```

节点状态：

```text
pending | running | dispatching | succeeded | failed
| skipped_due_to_failure | interrupted
```

执行步骤：

1. 创建 `pending` 执行及节点记录；
2. 原子领取任务并标记 `running`；
3. 在短事务中标记节点开始，在事务外执行 SQL、脚本或网络请求；
4. 成功后在事务中保存产物、变量、摘要和节点状态；
5. 失败后保存脱敏错误，将后续节点标记为 `skipped_due_to_failure`；
6. 更新流程最终状态，并在同一事务创建应用消息。

钉钉等外部发送前进入 `dispatching`。若发送后、成功落库前应用崩溃，启动时标记为 `interrupted` 并显示“发送结果未知”，不得自动重发。

## 12. 调度设计

调度器由 Tauri 启动，在 Rust 后台运行：

1. 查询最近的 `next_run_at`；
2. 等待到期，流程发布、启停时主动唤醒并重新计算；
3. 到期后在同一事务创建执行记录并推进 `next_run_at`；
4. 通过唯一键防止同一次计划重复建单；
5. 同一流程存在 `running` 或 `dispatching` 时，新任务保持排队。

应用必须限制为单实例，同时依靠 SQLite 唯一约束和原子领取保证并发安全。启动时把遗留的 `running`、`dispatching` 标记为 `interrupted`，已创建的 `pending` 任务可继续执行。

程序未运行或 Windows 关机期间无法执行。首期错过的计划不自动补跑，记录调度提醒后等待下一次计划，避免恢复时集中执行历史任务。

## 13. 通知中心

### 13.1 消息来源

首期接入：

- 流程执行成功、失败、中断和取消；
- 调度失败、Cron 失效和错过计划；
- 数据源、会话或凭据失效；
- 终止推送插件发送失败；
- SQLite 初始化、迁移或后台调度异常。

失败、中断和调度异常默认强提醒；成功消息进入通知中心，是否发送 Windows 通知由偏好控制。

### 13.2 状态与去重

```text
unread → read → archived
```

消息内容创建后不可变，阅读状态单独更新。`dedupe_key` 建唯一索引，例如：

```text
workflow_execution:{execution_id}:failed
```

### 13.3 提醒方式

- 顶栏铃铛持续展示未读角标；
- 右侧通知抽屉支持未读/全部筛选、单条已读、全部已读和详情跳转；
- 主窗口隐藏或失焦时发送 Windows 原生通知；
- 托盘 tooltip 展示未读数量；
- 点击原生通知恢复主窗口，并定位消息或对应执行详情。

现有 toast 只用于即时操作反馈，不作为可靠消息载体。

### 13.4 一致性链路

```text
执行器更新最终状态
→ 同一 SQLite 事务插入 app_messages
→ 提交
→ NotificationService 投递原生通知
→ 记录 message_deliveries
→ Rust emit 消息变化事件
→ 前端重新查询未读数量
```

原生通知失败不改变流水线结果，但必须记录失败状态和脱敏错误。前端启动、恢复焦点和收到事件时均重新查询 SQLite，避免事件丢失造成角标不准确。

## 14. 安全边界

通知只包含流程名称、版本、状态、耗时、失败节点和脱敏短错误。通知、SQLite 和日志不得保存或展示：

- SQL 正文和查询结果；
- 数据库密码；
- Webhook、Token、Secret；
- 请求头和 Webhook 查询参数；
- Python 完整运行环境；
- 未清洗的外部响应。

完整业务结果只在执行详情中按潜在敏感数据处理。CBOR 是编码而非加密，产物仍需遵守本地数据保护和保留策略。

## 15. 技术依赖

Rust 侧预计新增：

- `rusqlite`（`bundled`）；
- `ciborium`；
- `uuid`；
- `cron`、`chrono`、`chrono-tz`；
- `tauri-plugin-notification`；
- `tauri-plugin-single-instance`；
- Tokio `time` 能力。

依赖引入前需要核对许可证、Tauri 2 兼容性和 Windows 构建结果。

## 16. 验证重点

- 迁移、外键、不可变版本、节点顺序和唯一触发约束；
- 类型链路、失败停止、CBOR 往返和大产物写入；
- 时区、夏令时、重复触发、串行执行和启动恢复；
- 外部发送 `dispatching` 状态及不自动重发；
- 消息原子落库、去重、未读角标和隐藏窗口通知；
- SQLite、JSON、日志和错误中不存在凭据；
- 现有控制台、环境、历史和插件功能回归通过。
