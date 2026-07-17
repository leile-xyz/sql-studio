/**
 * 前端 → Rust 宿主的调用封装。所有 Archery 请求由 Rust 端代发
 * （每环境独立 Cookie Jar、自动注入 CSRF/Origin/Referer）。
 * 对 app.js 的接口签名与扩展版完全一致。
 */
import { parseTableDescription } from './ddl.js';
import { validateQueryLimit, validateQueryRows } from './query-row-limit.mjs';
import { invoke } from './host.mjs';

const get = (origin, path) => invoke('api_get', { origin, path });
const post = (origin, path, form) => invoke('api_post', { origin, path, form });
const resource = (origin, params) =>
    get(origin, '/instance/instance_resource/?' + new URLSearchParams(params));

export const api = {
    /** 当前桌面应用版本 */
    appVersion: () => invoke('app_version'),
    /** 登录，成功 resolve，失败 reject（附带 Archery 返回的 msg） */
    login: (origin, username, password) => invoke('login', { origin, username, password }),
    /** 探测会话是否有效（能否取到实例列表） */
    checkSession: async (origin) => { await api.instances(origin); return { ok: true }; },
    /** 实例（集群）列表 → [{id,type,db_type,instance_name}] */
    instances: async (origin) =>
        (await get(origin, '/group/user_all_instances/?tag_codes%5B%5D=can_read')) || [],
    /** 数据库列表 → [dbName] */
    databases: async (origin, instance) =>
        (await resource(origin, { instance_name: instance, resource_type: 'database' })) || [],
    /** 模式列表 → [schemaName] */
    schemas: async (origin, context) =>
        (await resource(origin, {
            instance_name: context.instance,
            db_name: context.db,
            resource_type: 'schema'
        })) || [],
    /** 表列表 → [tableName] */
    tables: async (origin, context) =>
        (await resource(origin, {
            instance_name: context.instance,
            db_name: context.db,
            schema_name: context.schema || '',
            resource_type: 'table'
        })) || [],
    /** 列名列表 → [columnName] */
    columns: async (origin, context) =>
        (await resource(origin, {
            instance_name: context.instance,
            db_name: context.db,
            schema_name: context.schema || '',
            tb_name: context.table,
            resource_type: 'column'
        })) || [],
    /** 表结构 → { ddl, columns, indexes, ... } */
    describe: async (origin, context) => {
        const data = await post(origin, '/instance/describetable/', {
            instance_name: context.instance,
            db_name: context.db,
            schema_name: context.schema || '',
            tb_name: context.table
        });
        return parseTableDescription(data);
    },
    /** 执行 SQL → { columns, types, rows, elapsed, affected, fullSql, isMasked } */
    query: async (origin, options) => {
        const limit = validateQueryLimit(options.limit ?? 100);
        const d = (await post(origin, '/query/', {
            instance_name: options.instance,
            db_name: options.db,
            schema_name: options.schema || '',
            tb_name: options.table || '',
            sql_content: options.sql,
            limit_num: String(limit)
        })) || {};
        if (d.error) throw new Error(d.error);
        return {
            columns: d.column_list || [],
            types: d.column_type || [],
            rows: validateQueryRows(d.rows || [], limit),
            elapsed: d.query_time || 0,
            affected: d.affected_rows,
            fullSql: d.full_sql || options.sql,
            isMasked: d.is_masked || false
        };
    },
    /** CSV 导出：原生另存为对话框；resolve true=已保存 / false=用户取消 */
    exportCsv: (defaultName, content) => downloadCsv(defaultName, content)
};

function downloadCsv(defaultName, content) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    link.download = `${defaultName}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    return Promise.resolve(true);
}
