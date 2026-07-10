/** 前后端共享的消息动作常量 */
export const ACTIONS = {
    LOGIN: 'SQLS_LOGIN',            // 登录
    SESSION: 'SQLS_SESSION',       // 探测当前会话是否有效
    INSTANCES: 'SQLS_INSTANCES',   // 实例（集群）列表
    DATABASES: 'SQLS_DATABASES',   // 数据库列表
    SCHEMAS: 'SQLS_SCHEMAS',       // 模式列表
    TABLES: 'SQLS_TABLES',         // 表列表
    COLUMNS: 'SQLS_COLUMNS',       // 列名列表
    DESCRIBE: 'SQLS_DESCRIBE',     // 表结构（show create table）
    QUERY: 'SQLS_QUERY'            // 执行 SQL
};
