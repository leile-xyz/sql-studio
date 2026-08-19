/**
 * 前端 → Rust 宿主的调用封装。所有 Archery 请求由 Rust 端代发
 * （每环境独立 Cookie Jar、自动注入 CSRF/Origin/Referer）。
 * 对 app.js 的接口签名与扩展版完全一致。
 */
import { parseTableDescription } from './ddl.js';

function invoke(cmd, args) {
    return window.__TAURI__.core.invoke(cmd, args).catch(e => {
        throw new Error(typeof e === 'string' ? e : (e && e.message) || '请求失败');
    });
}

const sessions = new Map();
const recoveryPromises = new Map();
const SESSION_EXPIRED_PATTERN = /未登录|会话已过期/;
let sessionRecoveryHandler = null;

function sessionFor(origin) {
    const session = sessions.get(origin);
    if (!session) throw new Error('Archery 会话上下文未配置');
    return session;
}

function setSession(envId, username, origin) {
    if (!envId || !username || !origin) throw new Error('Archery 会话上下文不完整');
    sessions.set(origin, Object.freeze({ envId, username, origin }));
}

async function loginSession(envId, origin, username, password) {
    setSession(envId, username, origin);
    return invoke('login', { session: sessionFor(origin), password });
}

function isSessionExpiredError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return SESSION_EXPIRED_PATTERN.test(message);
}

async function recoverSession(origin) {
    const pending = recoveryPromises.get(origin);
    if (pending) return pending;
    const session = Object.freeze({ ...sessionFor(origin) });
    if (!sessionRecoveryHandler) {
        throw new Error('会话已过期，未配置自动登录，请重新登录');
    }
    const recovery = Promise.resolve()
        .then(() => sessionRecoveryHandler(session))
        .finally(() => recoveryPromises.delete(origin));
    recoveryPromises.set(origin, recovery);
    return recovery;
}

async function requestWithRecovery(origin, request) {
    try {
        return await request();
    } catch (error) {
        if (!isSessionExpiredError(error)) throw error;
        await recoverSession(origin);
        // 恢复后只重放原请求一次；再次失败必须把真实错误交给调用方。
        return request();
    }
}

const get = (origin, path) => requestWithRecovery(
    origin,
    () => invoke('api_get', { session: sessionFor(origin), path }),
);
const post = (origin, path, form) => requestWithRecovery(
    origin,
    () => invoke('api_post', { session: sessionFor(origin), path, form }),
);
const resource = (origin, params) =>
    get(origin, '/instance/instance_resource/?' + new URLSearchParams(params));

export const api = {
    /** 配置会话过期后的恢复处理器；传 null 可禁用自动恢复。 */
    setSessionRecovery: handler => {
        if (handler != null && typeof handler !== 'function') {
            throw new Error('会话恢复处理器必须是函数或 null');
        }
        sessionRecoveryHandler = handler || null;
        recoveryPromises.clear();
    },
    setSession,
    /** 当前桌面应用版本 */
    appVersion: () => invoke('app_version'),
    /** 登录，成功 resolve，失败 reject（附带 Archery 返回的 msg） */
    login: loginSession,
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
        const d = (await post(origin, '/query/', {
            instance_name: options.instance,
            db_name: options.db,
            schema_name: options.schema || '',
            tb_name: options.table || '',
            sql_content: options.sql,
            limit_num: String(options.limit || 100)
        })) || {};
        if (d.error) throw new Error(d.error);
        return {
            columns: d.column_list || [],
            types: d.column_type || [],
            rows: d.rows || [],
            elapsed: d.query_time || 0,
            affected: d.affected_rows,
            fullSql: d.full_sql || options.sql,
            isMasked: d.is_masked || false
        };
    },
    /** CSV 导出：原生另存为对话框；resolve true=已保存 / false=用户取消 */
    exportCsv: (defaultName, content) => invoke('export_csv', { defaultName, content }),
    dingtalk: Object.freeze({
        status: () => invoke('dingtalk_config_status'),
        save: (webhook, secret) => invoke('dingtalk_save_config', { webhook, secret }),
        remove: () => invoke('dingtalk_delete_config'),
        sendText: content => invoke('dingtalk_send_text', { content }),
    })
};
