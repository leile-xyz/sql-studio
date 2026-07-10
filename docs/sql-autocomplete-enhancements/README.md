# SQL 自动联想

## 语句隔离

同一控制台可以包含多条 SQL。联想通过 `extractSqlStatementAt` 只分析光标所在语句，因此编辑其中一条 SQL 时：

- 只加载当前语句 `FROM/JOIN/UPDATE/INTO` 引用表的字段；
- 不会混入同一编辑器中其他 SQL 的表和字段；
- 美化和光标上下文判断也沿用相同的语句边界规则。

## 上下文优先级

`detectSqlCompletionContext` 根据光标前的当前语句结构调整候选顺序：

- `SELECT`、`WHERE`、`ON`、`HAVING`、`SET`、`GROUP BY`、`ORDER BY` 后优先字段；
- `FROM`、`JOIN`、`UPDATE`、`INTO` 以及 FROM 表列表逗号后优先表；
- 无法确定上下文时沿用字段、表、关键词的默认顺序。

字段、表、SQL 关键词和函数均使用大小写不敏感的匹配，例如 `name` 可以命中 `user_name`，`lect` 可以命中 `select`，`tween` 可以命中 `between`。

## 跨词匹配

候选会按下划线、空白、短横线、点和 camelCase 边界分词。连续包含未命中时，输入内容可以按连续 token 的前缀拆分：

- `dl`、`dlog`、`drlo` 均可命中 `sample_dream_log_center`；
- `df` 可命中 MySQL 函数 `date_format`；
- `dt` 可命中 PostgreSQL 函数 `date_trunc`；
- 不做单词内部的任意字符子序列匹配，因此 `dl` 不会误命中单个单词 `delete`。

匹配质量依次为完全匹配、整个标签前缀、token 前缀、连续包含、跨词匹配；同类型候选按匹配质量排序，字段/表的 SQL 上下文优先级保持不变。跨词命中的每个片段会分别高亮。

## 方言函数候选

函数候选取决于当前表或控制台的 `dbType`，MySQL 与 PostgreSQL 专属函数不会串库；无法识别方言时只展示公共函数。函数只在字段/表达式位置和表数据 WHERE 条件片段中出现，`FROM`、`JOIN`、`UPDATE`、`INTO` 后仍保持表候选优先且不混入函数。

- 公共函数：`count`、`sum`、`avg`、`min`、`max`、`coalesce`、`nullif`、`concat`、`substring`、`trim`、`lower`、`upper`、`length`、`char_length`、`replace`、`abs`、`round`、`ceil`、`floor`、`now`；
- MySQL 专属：`ifnull`、`group_concat`、`date_format`、`str_to_date`、`from_unixtime`、`unix_timestamp`、`datediff`、`date_add`、`date_sub`；
- PostgreSQL 专属：`string_agg`、`array_agg`、`date_trunc`、`date_part`、`to_char`、`to_date`、`to_timestamp`、`age`、`split_part`。

同名公共函数的具体签名和语义仍以当前数据库为准，例如 MySQL 与 PostgreSQL 的 `length`、`concat`、`round` 存在细节差异。

这些候选是按方言维护的静态常用函数清单，不枚举扩展函数、用户自定义函数或具体服务器版本提供的全部函数。

## 完全匹配与全部字段

- 字段、表和 WHERE 条件片段的完全匹配候选不会被过滤。
- `SELECT`、`WHERE` 等关键词输入完整后仍保留在下拉列表。
- SQL 函数完全匹配时同样进入精确匹配区。
- 完全匹配关键词会进入截断前的精确匹配区，即使普通候选超过 30 条也可见。
- 多词关键词会识别已经输入的短语范围，接受 `ORDER BY`、`LEFT JOIN` 等候选时不会重复插入前半段。
- 单表字段已加载时提供“全部字段”候选，其优先级仅低于完全匹配候选，高于普通包含匹配字段。

## PostgreSQL schema

表引用识别支持以下形式：

- `table_name`
- `` `database`.`table_name` ``
- `schema.table_name`
- `"schema"."table_name"`

结构化引用同时保留 schema 和表名。表与字段缓存键包含 `origin / instance / database / schema / table`，不同 schema 下的同名表不会共享字段缓存；SQL 中显式 schema 优先于控制台当前 schema。

## WHERE 条件片段

表数据页的 WHERE 输入框复用自动联想组件，提供当前表字段、SQL 关键词和当前数据库方言的函数候选，均支持包含与跨词匹配。候选插入后同步更新条件内容，按 Enter 可直接应用筛选。

## 交互与安全

- `↑` / `↓` 选择，`Enter` / `Tab` 插入，`Esc` 关闭；`Ctrl+Enter` 保留为执行 SQL。
- 候选命中片段使用 `highlightMatch` 高亮，大小写不敏感并支持多个命中位置。
- 字段名、类型、注释和候选标签在写入 `innerHTML` 前均进行转义。
- 元数据请求失败会显式报告并移除失败缓存，后续输入可以重新加载，不会静默固定为空结果。

## 验证

单元测试覆盖当前语句隔离、SELECT/FROM/WHERE 上下文、包含与跨词匹配、MySQL/PostgreSQL 函数隔离、大小写、多词关键词替换、完全匹配、全部字段优先级、schema 缓存隔离、特殊字符转义和双端模块一致性。
