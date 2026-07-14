/**
 * SQL Studio — background service worker
 * 统一代发 Archery 请求：
 *   - service worker + host_permissions → 不受页面 CORS 限制，可读响应体
 *   - credentials:'include' → 浏览器自动携带该域会话 Cookie（含 HttpOnly 的 sessionid）
 *   - 从 csrftoken Cookie 读取值，注入 X-CSRFToken 头（Django CSRF 校验要求 header == cookie）
 * 所有业务返回统一 { status:0, msg:'ok', data } 结构，status!=0 视为失败。
 */
import { ACTIONS } from './lib/actions.js';
import { parseTableDescription } from './lib/ddl.js';
import { validateQueryLimit, validateQueryRows } from './lib/query-row-limit.mjs';

/* ============ 打开主界面（点击工具栏图标） ============ */
async function openApp() {
    const url = chrome.runtime.getURL('app.html');
    try {
        const tabs = await chrome.tabs.query({});
        const existing = tabs.find(t => t.url && t.url.startsWith(url));
        if (existing) {
            await chrome.tabs.update(existing.id, { active: true });
            if (existing.windowId != null) {
                await chrome.windows.update(existing.windowId, { focused: true });
            }
            return;
        }
    } catch (e) { /* 忽略，转为新建 */ }
    await chrome.tabs.create({ url });
}
chrome.action.onClicked.addListener(() => { openApp(); });

/* ============ CSRF / Origin 修正（declarativeNetRequest） ============
 * 扩展发起的 POST 请求，浏览器会强制带上 Origin: chrome-extension://<id>，
 * Django CSRF 中间件校验 Origin 不在信任列表 → 403「CSRF验证失败」。
 * fetch 无法覆盖 Origin（禁止头），故用 DNR 在请求出站前把 Origin/Referer
 * 改写成目标 Archery 源，令服务端校验通过。规则按环境域名逐条生成。 */
const DNR_BASE_ID = 1000;
const DNR_RESOURCE_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other'];
/** 默认环境来自扩展根目录的 default-envs.json，与 lib/store.js 共用一份配置 */
async function loadDefaultHosts() {
  try {
    const resp = await fetch(chrome.runtime.getURL('default-envs.json'));
    const envs = await resp.json();
    return Array.isArray(envs) ? envs.filter(e => e && e.base) : [];
  } catch (e) { return []; }
}

async function syncDnrRules() {
  let envs;
  try {
    const { sqls_envs } = await chrome.storage.local.get('sqls_envs');
    envs = (sqls_envs && sqls_envs.length) ? sqls_envs : await loadDefaultHosts();
  } catch (e) { envs = await loadDefaultHosts(); }

  const rules = envs.filter(e => e.base).map((e, i) => {
    const origin = `${e.scheme || 'http'}://${e.base}`;
    return {
      id: DNR_BASE_ID + i,
      priority: 1,
      // requestDomains 只接受域名/IP，不含端口；Origin 头的值保留端口
      condition: { requestDomains: [e.base.split(':')[0]], resourceTypes: DNR_RESOURCE_TYPES },
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'origin', operation: 'set', value: origin },
          { header: 'referer', operation: 'set', value: `${origin}/sqlquery/` }
        ]
      }
    };
  });

  try {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const removeRuleIds = existing.filter(r => r.id >= DNR_BASE_ID && r.id < DNR_BASE_ID + 100).map(r => r.id);
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules: rules });
  } catch (e) {
    console.error('[SQL Studio] 设置 DNR 规则失败', e);
  }
}

syncDnrRules();
chrome.runtime.onInstalled.addListener(syncDnrRules);
chrome.runtime.onStartup.addListener(syncDnrRules);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.sqls_envs) syncDnrRules();
});

/* ============ 基础工具 ============ */

function getCookie(url, name) {
    return new Promise(resolve => {
        chrome.cookies.get({ url, name }, c => resolve(c ? c.value : ''));
    });
}

const UA = 'Mozilla/5.0 (SQL Studio Extension)';

/** 读取响应文本；若疑似被重定向到登录页（HTML），抛出会话失效错误 */
async function requestText(url, options = {}) {
    let resp;
    try {
        resp = await fetch(url, { credentials: 'include', ...options });
    } catch (e) {
        throw new Error('网络请求失败，请检查是否连入内网 / 域名是否可达');
    }
    const text = await resp.text();
    return { resp, text };
}

/** 请求并按 Archery JSON 协议解析：{status, msg, data}；status!=0 或非 JSON 均抛错 */
async function requestJson(url, options = {}) {
    const { resp, text } = await requestText(url, options);
    let json;
    try {
        json = JSON.parse(text);
    } catch (e) {
        // Archery 未登录时会重定向到登录页返回 HTML
        if (/<html|<!doctype/i.test(text)) {
            throw new Error('未登录或会话已过期，请重新登录');
        }
        throw new Error(`响应解析失败（HTTP ${resp.status}）`);
    }
    if (json.status !== 0) {
        throw new Error(json.msg || `请求失败（status=${json.status}）`);
    }
    return json;
}

/** 构造带 CSRF 的 POST 头（表单编码） */
async function postHeaders(origin) {
    const token = await getCookie(origin, 'csrftoken');
    return {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-CSRFToken': token,
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': UA
    };
}

const getHeaders = { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/javascript, */*; q=0.01' };

/* ============ 业务接口 ============ */

/** 登录：先取 csrftoken，再 POST /authenticate/ */
async function login({ origin, username, password }) {
    // 触发服务端下发 csrftoken（若已有则复用）
    try { await fetch(`${origin}/login/`, { credentials: 'include' }); } catch (e) { /* 允许失败，可能已有 cookie */ }
    let token = await getCookie(origin, 'csrftoken');
    const body = new URLSearchParams({ username, password }).toString();
    const { resp, text } = await requestText(`${origin}/authenticate/`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-CSRFToken': token,
            'X-Requested-With': 'XMLHttpRequest',
            'Origin': origin,
            'Referer': `${origin}/login/`,
            'User-Agent': UA
        },
        body
    });
    let json;
    try { json = JSON.parse(text); }
    catch (e) { throw new Error(`登录响应异常（HTTP ${resp.status}）`); }
    if (json.status !== 0) {
        throw new Error(json.msg || '用户名或密码错误');
    }
    return { ok: true, msg: json.msg || 'ok' };
}

/** 实例（集群）列表 */
async function getInstances({ origin }) {
    const json = await requestJson(
        `${origin}/group/user_all_instances/?tag_codes%5B%5D=can_read`,
        { headers: getHeaders }
    );
    return json.data || [];
}

/** 数据库列表 */
async function getDatabases({ origin, instance }) {
    const q = new URLSearchParams({ instance_name: instance, resource_type: 'database' });
    const json = await requestJson(`${origin}/instance/instance_resource/?${q}`, { headers: getHeaders });
    return json.data || [];
}

/** 模式列表 */
async function getSchemas({ origin, instance, db }) {
    const q = new URLSearchParams({ instance_name: instance, db_name: db, resource_type: 'schema' });
    const json = await requestJson(`${origin}/instance/instance_resource/?${q}`, { headers: getHeaders });
    return json.data || [];
}

/** 表列表 */
async function getTables({ origin, instance, db, schema = '' }) {
    const q = new URLSearchParams({ instance_name: instance, db_name: db, schema_name: schema, resource_type: 'table' });
    const json = await requestJson(`${origin}/instance/instance_resource/?${q}`, { headers: getHeaders });
    return json.data || [];
}

/** 列名列表 */
async function getColumns({ origin, instance, db, schema = '', table }) {
    const q = new URLSearchParams({ instance_name: instance, db_name: db, schema_name: schema, tb_name: table, resource_type: 'column' });
    const json = await requestJson(`${origin}/instance/instance_resource/?${q}`, { headers: getHeaders });
    return json.data || [];
}

/** 表结构：show create table，解析出列 / 索引 / 表属性 */
async function describeTable({ origin, instance, db, schema = '', table }) {
    const headers = await postHeaders(origin);
    const body = new URLSearchParams({ instance_name: instance, db_name: db, schema_name: schema, tb_name: table }).toString();
    const json = await requestJson(`${origin}/instance/describetable/`, { method: 'POST', headers, body });
    return parseTableDescription(json.data);
}

/** 执行 SQL */
async function runQuery({ origin, instance, db, schema = '', table = '', sql, limit }) {
    const rowLimit = validateQueryLimit(limit ?? 100);
    const headers = await postHeaders(origin);
    const body = new URLSearchParams({
        instance_name: instance,
        db_name: db,
        schema_name: schema,
        tb_name: table,
        sql_content: sql,
        limit_num: String(rowLimit)
    }).toString();
    const json = await requestJson(`${origin}/query/`, { method: 'POST', headers, body });
    const d = json.data || {};
    if (d.error) throw new Error(d.error);
    return {
        columns: d.column_list || [],
        types: d.column_type || [],
        rows: validateQueryRows(d.rows || [], rowLimit),
        elapsed: d.query_time || 0,
        affected: d.affected_rows,
        fullSql: d.full_sql || sql,
        isMasked: d.is_masked || false
    };
}

/* ============ 消息路由 ============ */

const HANDLERS = {
    [ACTIONS.LOGIN]: login,
    [ACTIONS.SESSION]: async (p) => { await getInstances(p); return { ok: true }; },
    [ACTIONS.INSTANCES]: getInstances,
    [ACTIONS.DATABASES]: getDatabases,
    [ACTIONS.SCHEMAS]: getSchemas,
    [ACTIONS.TABLES]: getTables,
    [ACTIONS.COLUMNS]: getColumns,
    [ACTIONS.DESCRIBE]: describeTable,
    [ACTIONS.QUERY]: runQuery
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const handler = message && HANDLERS[message.type];
    if (!handler) return;
    (async () => {
        try {
            const data = await handler(message.payload || {});
            sendResponse({ ok: true, data });
        } catch (error) {
            sendResponse({ ok: false, error: error.message || '未知错误' });
        }
    })();
    return true; // 异步响应
});
