/**
 * 本地存储层 — 环境配置、登录凭据（含记住密码）、查询历史。
 * 全部走 chrome.storage.local；密码字段用 crypto.js 加密后落盘。
 */
import { encryptText, decryptText } from './crypto.js';

const KEY_ENVS = 'sqls_envs';
const KEY_ACTIVE = 'sqls_active_env';
const KEY_CREDS = 'sqls_creds';       // { [envId]: { user, encPwd, remember } }
const KEY_HISTORY = 'sqls_history';   // { [envId]: [ {sql, instance, db, schema, dbType, ts, ok, elapsed} ] }
const KEY_CONSOLE_DRAFTS = 'sqls_console_drafts'; // { [envId]: {sql, instance, db, schema, dbType, updatedAt} }
const KEY_CONSOLE_SESSIONS = 'sqls_console_sessions'; // { [envId]: {consoles, activeConsoleKey, nextSequence} }
const HISTORY_LIMIT = 100;

/** 默认内置环境来自扩展根目录的 default-envs.json（base 为域名或 IP:端口，不含协议）。
 *  仅在本地尚无环境配置时作为初始值写入，之后以「环境管理」中的配置为准。 */
async function loadDefaultEnvs() {
    try {
        const resp = await fetch(chrome.runtime.getURL('default-envs.json'));
        const envs = await resp.json();
        return Array.isArray(envs) ? envs.filter(e => e && e.base) : [];
    } catch (e) {
        console.error('[SQL Studio] 读取 default-envs.json 失败', e);
        return [];
    }
}

function get(keys) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.get(keys, items => {
            const err = chrome.runtime.lastError;
            err ? reject(new Error(err.message)) : resolve(items);
        });
    });
}
function set(items) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.set(items, () => {
            const err = chrome.runtime.lastError;
            err ? reject(new Error(err.message)) : resolve();
        });
    });
}

/* ---------------- 环境 ---------------- */

export async function getEnvs() {
    const { [KEY_ENVS]: envs } = await get(KEY_ENVS);
    if (!envs || !envs.length) {
        const defaults = await loadDefaultEnvs();
        if (defaults.length) await set({ [KEY_ENVS]: defaults });
        return defaults;
    }
    return envs;
}

export async function saveEnvs(envs) {
    await set({ [KEY_ENVS]: envs });
}

export async function getActiveEnvId() {
    const { [KEY_ACTIVE]: id } = await get(KEY_ACTIVE);
    if (id) return id;
    const envs = await getEnvs();
    return envs[0] ? envs[0].id : null;
}

export async function setActiveEnvId(id) {
    await set({ [KEY_ACTIVE]: id });
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
    await saveEnvs(envs);
    const creds = await getAllCreds();
    delete creds[id];
    await set({ [KEY_CREDS]: creds });
    return envs;
}

/** 环境的 origin，如 http://archery.example.com */
export function envOrigin(env) {
    const scheme = env.scheme || 'http';
    return `${scheme}://${env.base}`;
}

/* ---------------- 凭据 / 记住密码 ---------------- */

async function getAllCreds() {
    const { [KEY_CREDS]: creds } = await get(KEY_CREDS);
    return creds || {};
}

/** 读取某环境凭据，remember 时解密返回明文密码 */
export async function getCred(envId) {
    const creds = await getAllCreds();
    const c = creds[envId];
    if (!c) return { user: '', password: '', remember: false };
    const password = c.remember && c.encPwd ? await decryptText(c.encPwd) : '';
    return { user: c.user || '', password, remember: !!c.remember };
}

/** 保存凭据：remember=true 时加密存密码，否则清除已存密码只留用户名 */
export async function saveCred(envId, { user, password, remember }) {
    const creds = await getAllCreds();
    creds[envId] = {
        user: user || '',
        remember: !!remember,
        encPwd: remember && password ? await encryptText(password) : ''
    };
    await set({ [KEY_CREDS]: creds });
}

/** 仅清除某环境已保存的密码，保留用户名 */
export async function clearCredPassword(envId) {
    const creds = await getAllCreds();
    if (creds[envId]) {
        creds[envId].encPwd = '';
        creds[envId].remember = false;
        await set({ [KEY_CREDS]: creds });
    }
}

/** 返回各环境是否已记住密码，用于环境管理列表展示 */
export async function getRememberFlags() {
    const creds = await getAllCreds();
    const flags = {};
    for (const [id, c] of Object.entries(creds)) {
        flags[id] = !!(c.remember && c.encPwd);
    }
    return flags;
}

/* ---------------- 查询历史 ---------------- */

export async function getHistory(envId) {
    const { [KEY_HISTORY]: all } = await get(KEY_HISTORY);
    return (all && all[envId]) || [];
}

export async function addHistory(envId, item) {
    const { [KEY_HISTORY]: all } = await get(KEY_HISTORY);
    const map = all || {};
    const list = map[envId] || [];
    list.unshift(item);
    map[envId] = list.slice(0, HISTORY_LIMIT);
    await set({ [KEY_HISTORY]: map });
}

export async function clearHistory(envId) {
    const { [KEY_HISTORY]: all } = await get(KEY_HISTORY);
    const map = all || {};
    delete map[envId];
    await set({ [KEY_HISTORY]: map });
}

/* ---------------- 控制台草稿 ---------------- */

export async function getConsoleDraft(envId) {
    const { [KEY_CONSOLE_DRAFTS]: drafts } = await get(KEY_CONSOLE_DRAFTS);
    const draft = drafts && drafts[envId];
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
    const { [KEY_CONSOLE_SESSIONS]: sessions } = await get(KEY_CONSOLE_SESSIONS);
    if (sessions == null) return null;
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) {
        throw new Error('本地控制台会话格式无效');
    }
    return Object.hasOwn(sessions, envId) ? sessions[envId] : null;
}

export async function saveConsoleSession(envId, session) {
    const { [KEY_CONSOLE_SESSIONS]: stored } = await get(KEY_CONSOLE_SESSIONS);
    if (stored != null && (!stored || typeof stored !== 'object' || Array.isArray(stored))) {
        throw new Error('本地控制台会话格式无效');
    }
    await set({ [KEY_CONSOLE_SESSIONS]: { ...(stored || {}), [envId]: session } });
}
