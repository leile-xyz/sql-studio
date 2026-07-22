/**
 * 本地存储层 — 环境配置、登录凭据（含记住密码）、查询历史。
 * 非敏感数据走 Rust 端 KV（%APPDATA%\sql-studio\store.json）；
 * 密码存 Windows 凭据管理器（DPAPI），本地文件只留 {user, remember} 标志。
 */

const KEY_ENVS = 'sqls_envs';
const KEY_ACTIVE = 'sqls_active_env';
const KEY_CREDS = 'sqls_creds';       // { [envId]: { user, remember } }（密码在凭据管理器）
const KEY_HISTORY = 'sqls_history';   // { [envId]: [ {sql, instance, db, schema, dbType, ts, ok, elapsed} ] }
const KEY_CONSOLE_DRAFTS = 'sqls_console_drafts'; // { [envId]: {sql, instance, db, schema, dbType, updatedAt} }
const KEY_CONSOLE_SESSIONS = 'sqls_console_sessions'; // { [envId]: {consoles, activeConsoleKey, nextSequence} }
const HISTORY_LIMIT = 100;
const mutationQueues = new Map();

/** 默认内置环境来自应用根目录的 default-envs.json（base 为域名或 IP:端口，不含协议）。
 *  仅在本地尚无环境配置时作为初始值写入，之后以「环境管理」中的配置为准。 */
async function loadDefaultEnvs() {
    try {
        const resp = await fetch(new URL('../default-envs.json', import.meta.url));
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const envs = await resp.json();
        if (!Array.isArray(envs)) throw new Error('根节点必须是数组');
        return envs.filter(e => e && e.base);
    } catch (e) {
        throw new Error(`读取 default-envs.json 失败：${e.message}`);
    }
}

function invoke(cmd, args) {
    return window.__TAURI__.core.invoke(cmd, args).catch(e => {
        throw new Error(typeof e === 'string' ? e : (e && e.message) || '存储操作失败');
    });
}
const kvGet = key => invoke('kv_get', { key });
const kvSet = (key, value) => invoke('kv_set', { key, value });

function runKeyMutation(key, operation) {
    const previous = mutationQueues.get(key) || Promise.resolve();
    const current = previous.then(operation, operation);
    mutationQueues.set(key, current);
    return current.finally(() => {
        if (mutationQueues.get(key) === current) mutationQueues.delete(key);
    });
}

/* ---------------- 环境 ---------------- */

export async function getEnvs() {
    const envs = await kvGet(KEY_ENVS);
    if (envs != null && !Array.isArray(envs)) throw new Error('本地环境配置格式无效');
    if (!envs || !envs.length) {
        const defaults = await loadDefaultEnvs();
        if (defaults.length) await kvSet(KEY_ENVS, defaults);
        return defaults;
    }
    return envs;
}

export async function saveEnvs(envs) {
    await kvSet(KEY_ENVS, envs);
}

export async function replaceEnvs(envs) {
    if (!Array.isArray(envs)) throw new Error('本地环境配置格式无效');
    const stored = await kvGet(KEY_ENVS);
    if (stored != null && !Array.isArray(stored)) throw new Error('本地环境配置格式无效');
    const nextIds = new Set(envs.map(env => env.id));
    const removedIds = (stored || [])
        .map(env => env && env.id)
        .filter(id => id && !nextIds.has(id));
    for (const envId of removedIds) await clearEnvCredentials(envId);
    await kvSet(KEY_ENVS, envs);
}

export async function getActiveEnvId() {
    const id = await kvGet(KEY_ACTIVE);
    if (id) return id;
    const envs = await getEnvs();
    return envs[0] ? envs[0].id : null;
}

export async function setActiveEnvId(id) {
    await kvSet(KEY_ACTIVE, id);
}

export async function getEnv(id) {
    const envs = await getEnvs();
    return envs.find(e => e.id === id) || null;
}

/** 新增/更新单个环境（按 id 合并） */
export async function upsertEnv(env) {
    const envs = await getEnvs();
    const idx = envs.findIndex(e => e.id === env.id);
    if (idx >= 0) envs[idx] = { ...envs[idx], ...env };
    else envs.push(env);
    await saveEnvs(envs);
    return envs;
}

export async function removeEnv(id) {
    const envs = (await getEnvs()).filter(e => e.id !== id);
    await clearEnvCredentials(id);
    await saveEnvs(envs);
    return envs;
}

/** 环境的 origin，如 http://archery.example.com */
export function envOrigin(env) {
    const scheme = env.scheme || 'http';
    return `${scheme}://${env.base}`;
}

/* ---------------- 凭据 / 记住密码 ---------------- */

async function getAllCreds() {
    return (await kvGet(KEY_CREDS)) || {};
}

async function clearEnvCredentials(envId) {
    const creds = await getAllCreds();
    if (Object.hasOwn(creds, envId)) {
        const nextCreds = { ...creds };
        delete nextCreds[envId];
        await kvSet(KEY_CREDS, nextCreds);
    }
    await invoke('cred_delete', { envId });
}

/** 读取某环境凭据，remember 时从 Windows 凭据管理器取回明文密码 */
export async function getCred(envId) {
    const creds = await getAllCreds();
    const c = creds[envId];
    if (!c) return { user: '', password: '', remember: false };
    let password = '';
    if (c.remember) password = (await invoke('cred_get', { envId })) || '';
    return { user: c.user || '', password, remember: !!c.remember };
}

/** 保存凭据：remember=true 时密码进凭据管理器，否则删除已存密码只留用户名 */
export async function saveCred(envId, { user, password, remember }) {
    const creds = await getAllCreds();
    creds[envId] = { user: user || '', remember: !!remember };
    await kvSet(KEY_CREDS, creds);
    if (remember && password) await invoke('cred_set', { envId, password });
    else await invoke('cred_delete', { envId });
}

/** 仅清除某环境已保存的密码，保留用户名 */
export async function clearCredPassword(envId) {
    const creds = await getAllCreds();
    if (creds[envId]) {
        creds[envId].remember = false;
        await kvSet(KEY_CREDS, creds);
    }
    await invoke('cred_delete', { envId });
}

/** 返回各环境是否已记住密码，用于环境管理列表展示 */
export async function getRememberFlags() {
    const creds = await getAllCreds();
    const flags = {};
    for (const [id, c] of Object.entries(creds)) {
        flags[id] = !!c.remember;
    }
    return flags;
}

/* ---------------- 查询历史 ---------------- */

export async function getHistory(envId) {
    const all = await kvGet(KEY_HISTORY);
    return (all && all[envId]) || [];
}

export async function addHistory(envId, item) {
    return runKeyMutation(KEY_HISTORY, async () => {
        const all = (await kvGet(KEY_HISTORY)) || {};
        const list = all[envId] || [];
        const next = { ...all, [envId]: [item, ...list].slice(0, HISTORY_LIMIT) };
        await kvSet(KEY_HISTORY, next);
    });
}

export async function clearHistory(envId) {
    return runKeyMutation(KEY_HISTORY, async () => {
        const all = (await kvGet(KEY_HISTORY)) || {};
        const next = { ...all };
        delete next[envId];
        await kvSet(KEY_HISTORY, next);
    });
}

/* ---------------- 控制台草稿 ---------------- */

export async function getConsoleDraft(envId) {
    const drafts = (await kvGet(KEY_CONSOLE_DRAFTS)) || {};
    const draft = drafts[envId];
    if (!draft || typeof draft.sql !== 'string') return null;
    return {
        sql: draft.sql,
        instance: typeof draft.instance === 'string' ? draft.instance : '',
        db: typeof draft.db === 'string' ? draft.db : '',
        schema: typeof draft.schema === 'string' ? draft.schema : '',
        dbType: typeof draft.dbType === 'string' ? draft.dbType : '',
        updatedAt: Number.isFinite(draft.updatedAt) ? draft.updatedAt : 0,
    };
}

/* ---------------- 控制台会话 ---------------- */

export async function getConsoleSession(envId) {
    const sessions = await kvGet(KEY_CONSOLE_SESSIONS);
    if (sessions == null) return null;
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) {
        throw new Error('本地控制台会话格式无效');
    }
    return Object.hasOwn(sessions, envId) ? sessions[envId] : null;
}

export async function saveConsoleSession(envId, session) {
    const stored = await kvGet(KEY_CONSOLE_SESSIONS);
    if (stored != null && (!stored || typeof stored !== 'object' || Array.isArray(stored))) {
        throw new Error('本地控制台会话格式无效');
    }
    await kvSet(KEY_CONSOLE_SESSIONS, { ...(stored || {}), [envId]: session });
}
