/**
 * 前端 → background 的调用封装。所有 Archery 请求都由 background service worker
 * 代发（绕过页面 CORS、自动携带会话 Cookie、注入 CSRF）。这里只负责消息往返。
 */
import { ACTIONS } from './actions.js';

function send(type, payload) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type, payload }, resp => {
            const err = chrome.runtime.lastError;
            if (err) return reject(new Error(err.message));
            if (!resp) return reject(new Error('后台服务无响应，请重载扩展'));
            resp.ok ? resolve(resp.data) : reject(new Error(resp.error || '请求失败'));
        });
    });
}

export const api = {
    /** 当前扩展版本 */
    appVersion: async () => chrome.runtime.getManifest().version,
    /** 登录，成功 resolve，失败 reject（附带 Archery 返回的 msg） */
    login: (origin, username, password) => send(ACTIONS.LOGIN, { origin, username, password }),
    /** 探测会话是否有效（能否取到实例列表） */
    checkSession: (origin) => send(ACTIONS.SESSION, { origin }),
    /** 实例（集群）列表 → [{id,type,db_type,instance_name}] */
    instances: (origin) => send(ACTIONS.INSTANCES, { origin }),
    /** 数据库列表 → [dbName] */
    databases: (origin, instance) => send(ACTIONS.DATABASES, { origin, instance }),
    /** 模式列表 → [schemaName] */
    schemas: (origin, context) => send(ACTIONS.SCHEMAS, { origin, ...context }),
    /** 表列表 → [tableName] */
    tables: (origin, context) => send(ACTIONS.TABLES, { origin, ...context }),
    /** 列名列表 → [columnName] */
    columns: (origin, context) => send(ACTIONS.COLUMNS, { origin, ...context }),
    /** 表结构 → { ddl, columns:[...] } */
    describe: (origin, context) => send(ACTIONS.DESCRIBE, { origin, ...context }),
    /** 执行 SQL → { columns, columnType, rows, elapsed, affected, error } */
    query: (origin, options) => send(ACTIONS.QUERY, { origin, ...options })
};
