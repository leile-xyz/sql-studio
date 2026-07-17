import { api } from './lib/api.js';
import * as store from './lib/store.js';
import { formatSql, highlightSql, resolveSqlExecution, splitSql, SqlAutocomplete } from './lib/sql-editor.mjs';
import { ICO } from './lib/icons.mjs';
import { ConsoleSessionManager } from './lib/console-session.mjs';
import { bindAppEvents } from './lib/app-events.mjs';
import { bindAboutDialog } from './lib/about-dialog.mjs';
import { executeConsoleStatement, fetchConsolePage } from './lib/console-execution.mjs';
import { renderConsoleResultView } from './lib/console-result-view.mjs';
import { createCsvExportActions } from './lib/csv-export-actions.mjs';
import { saveCsvText } from './lib/csv-save.mjs';
import { renderResourceTree } from './lib/resource-tree-view.mjs';
import { renderTableView, resolveTableSubview } from './lib/table-view.mjs';
import { findDbType, isPostgresType } from './lib/db-context.mjs';
import { loadTableData, prepareTableDataQuery } from './lib/table-data-loader.mjs';
import { renderTabBarView, showAllConsolesMenu, showConsoleMenu, showTabContextMenu } from './lib/console-menu-view.mjs';
import { ConsoleRenameController } from './lib/console-rename.mjs';
import { closeWorkspaceTabs, consoleSessionState, createNewConsole, defaultConsoleTab, deleteWorkspaceConsole, restoreConsoleWorkspace } from './lib/console-workspace.mjs';
import { stopLocalService } from './lib/host.mjs';
const startupLog = (level, message) => window.__SQL_STUDIO_STARTUP_LOG__?.(level, message);
startupLog('info', 'frontend app module evaluated');
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const state = {
  envs: [], activeEnvId: null, env: null, origin: '',
  connected: false, connecting: false, user: '',
  instances: [], tree: [],
  sidebarCollapsed: false,
  tabs: [], activeTabId: null, activeConsoleKey: null, tabSeq: 0, consoleSeq: 0,
  uidSeq: 0, nodeMap: new Map(),
  treeSel: null, // 与控制台联动的高亮 {inst, db, schema}
  lastCtx: null, // 最近浏览的上下文 {inst, db, schema}，新建控制台时继承
};
const $ = id => document.getElementById(id);
const curTab = () => state.tabs.find(t => t.id === state.activeTabId) || null;
const isCurrentEnv = (env, origin) => !!env && env.id === state.activeEnvId && origin === state.origin;
const consoleSessionManager = new ConsoleSessionManager({ store, onError: reportConsoleSessionError });
const csvActions = createCsvExportActions({ api, getOrigin: () => state.origin, saveText: (name, csv) => saveCsvText(api, name, csv), toast });
const consoleRename = new ConsoleRenameController({ getEnvId: () => state.activeEnvId, getConsoles: () => state.tabs, persist: persistConsoleSession, renderTabs, hideMenus, openModal, closeModal });
const autocomplete = new SqlAutocomplete({
  api,
  getContext: () => {
    const tab = curTab();
    return tab ? {
      type: tab.type,
      origin: state.origin,
      instance: tab.instance,
      db: tab.db,
      schema: tab.schema || '',
      dbType: tab.dbType || '',
      meta: tab.meta,
    } : null;
  },
  onEditorChange: syncEditor,
  onWhereChange: value => { const tab = curTab(); if (tab) tab.whereDraft = value; },
  onError: (message, error) => console.error('[SQL Studio] ' + message, error),
});
/* ================= 初始化 ================= */
async function init() {
  startupLog('info', 'frontend init entered');
  bindStatic();
  bindDelegation();
  startupLog('info', 'frontend event bindings completed');
  try {
    state.envs = await store.getEnvs();
    state.activeEnvId = await store.getActiveEnvId();
  } catch (e) {
    startupLog('error', 'frontend configuration read failed: ' + (e?.stack || e));
    renderTabs(); renderBody(); renderTree(); renderEnvUI();
    toast('读取环境配置失败：' + e.message, 'err');
    openEnvMgr(); return;
  }
  renderTabs();
  renderBody();
  startupLog('info', 'frontend initial shell rendered');
  await applyEnv(state.activeEnvId);
  if (!state.env) { startupLog('info', 'frontend init completed without active environment'); openEnvMgr(); return; }
  await ensureConnected();
  startupLog('info', 'frontend init completed with active environment');
}
function bindStatic() {
  consoleRename.bind();
  $('envBtn').addEventListener('click', e => { e.stopPropagation(); toggleEnvMenu(); });
  $('btnEnvMgr').addEventListener('click', openEnvMgr);
  $('btnRelogin').addEventListener('click', () => openLogin());
  $('btnRefreshTree').addEventListener('click', refreshTree);
  $('btnCollapse').addEventListener('click', collapseAll);
  $('btnSidebarCollapse').addEventListener('click', () => setSidebarCollapsed(true));
  $('btnSidebarExpand').addEventListener('click', () => setSidebarCollapsed(false));
  $('treeSearch').addEventListener('input', renderTree);
  $('loginEnv').addEventListener('change', onLoginEnvChange);
  $('loginScheme').addEventListener('change', updateLoginEnvUrl);
  $('loginBase').addEventListener('input', updateLoginEnvUrl);
  $('loginCancel').addEventListener('click', () => closeModal('loginMask'));
  $('loginSubmit').addEventListener('click', doLogin);
  $('loginPwd').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  $('envAdd').addEventListener('click', addEnvRow);
  $('envMgrCancel').addEventListener('click', () => closeModal('envMgrMask'));
  $('envMgrSave').addEventListener('click', saveEnvMgr);
  $('btnExit').addEventListener('click', async () => {
    if (!window.confirm('退出 SQL Studio 并停止本地服务？')) return;
    await stopLocalService();
    window.close();
  });
  bindAboutDialog({ api, toast });
  document.addEventListener('click', event => { if (!event.target.closest('#consoleMenu, #consoleAllMenu, [data-act="toggle-console-menu"]')) hideMenus(); });
  window.addEventListener('pagehide', () => consoleSessionManager.flush().catch(reportConsoleSessionError));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') consoleSessionManager.flush().catch(reportConsoleSessionError);
  });
  document.addEventListener('focusout', e => { if (autocomplete.isOpenFor(e.target)) setTimeout(() => autocomplete.hide(), 100); });
  document.querySelectorAll('.mask').forEach(m =>
    m.addEventListener('click', e => { if (e.target === m) closeModal(m.id); }));
}
/* ================= 环境 ================= */
async function applyEnv(id) {
  await consoleSessionManager.flush();
  const env = state.envs.find(e => e.id === id) || state.envs[0];
  state.env = env;
  state.activeEnvId = env ? env.id : null;
  state.origin = env ? store.envOrigin(env) : '';
  state.connected = false;
  state.instances = [];
  state.tree = [];
  state.tabs = [];
  state.activeTabId = null;
  state.activeConsoleKey = null;
  state.treeSel = null;
  state.lastCtx = null;
  if (env) {
    await store.setActiveEnvId(env.id);
    const restored = restoreConsoleWorkspace(await consoleSessionManager.load(env.id), state.tabSeq);
    state.tabs = restored.tabs;
    state.activeTabId = restored.activeTabId;
    state.tabSeq = restored.tabSeq;
    state.consoleSeq = restored.nextSequence;
    state.activeConsoleKey = curTab() ? curTab().consoleKey : null;
  }
  renderEnvUI();
  renderTabs();
  renderBody();
  renderTree();
}
function renderEnvUI() {
  const e = state.env;
  if (!e) {
    $('envDot').style.background = '#888';
    $('envName').textContent = '未配置环境'; $('envUrl').textContent = '';
    $('connBox').className = 'conn off'; $('connText').textContent = '未连接';
    return;
  }
  $('envDot').style.background = e.color || '#888';
  $('envName').textContent = e.name;
  $('envUrl').textContent = e.base;
  const conn = $('connBox');
  if (state.connecting) {
    conn.className = 'conn'; conn.querySelector('.dot').style.background = 'var(--yellow)';
    $('connText').textContent = '连接中…';
  } else if (state.connected) {
    conn.className = 'conn'; conn.querySelector('.dot').style.background = 'var(--green)';
    $('connText').innerHTML = '已连接' + (state.user ? ' · <b>' + esc(state.user) + '</b>' : '');
  } else {
    conn.className = 'conn off'; conn.querySelector('.dot').style.background = '';
    $('connText').textContent = '未连接';
  }
}
function toggleEnvMenu() {
  const m = $('envMenu');
  if (m.classList.contains('show')) { m.classList.remove('show'); return; }
  const rows = state.envs.map(x => `<div class="mi ${x.id === state.activeEnvId ? 'active' : ''}" data-act="switch-env" data-env="${attr(x.id)}">
    <span class="dot" style="background:${x.color || '#888'}"></span><span>${esc(x.name)}</span>
    <span class="grow"></span><span class="murl">${esc(x.base)}</span><span class="check">✔</span></div>`).join('');
  m.innerHTML = rows + `<hr>
    <div class="mi" data-act="open-envmgr">⚙ 环境管理…</div>
    <div class="mi" data-act="relogin">⇄ 重新登录当前环境</div>`;
  const r = $('envBtn').getBoundingClientRect();
  m.style.left = r.left + 'px'; m.style.top = (r.bottom + 6) + 'px';
  m.classList.add('show');
}
function hideMenus() { document.querySelectorAll('.menu').forEach(m => m.classList.remove('show')); }
async function switchEnv(id) {
  hideMenus();
  if (id === state.activeEnvId && state.connected) return;
  await applyEnv(id);
  await ensureConnected();
}
/** 确保当前环境已连接：先探测已有会话，再尝试记住的密码，否则弹登录 */
async function ensureConnected() {
  if (!state.env) return;
  const env = state.env; const origin = state.origin;
  state.connecting = true; renderEnvUI(); renderTree();
  // 1. 已有会话
  try {
    await api.checkSession(origin);
    if (!isCurrentEnv(env, origin)) return;
    const cred = await store.getCred(env.id);
    if (!isCurrentEnv(env, origin)) return;
    state.user = cred.user || '';
    await onConnected();
    return;
  } catch (e) { if (!isCurrentEnv(env, origin)) return; }
  // 2. 记住的密码自动登录
  const cred = await store.getCred(env.id);
  if (cred.remember && cred.password) {
    try {
      await api.login(origin, cred.user, cred.password);
      if (!isCurrentEnv(env, origin)) return;
      state.user = cred.user;
      await onConnected();
      toast('已使用保存的凭据自动登录 ' + env.name, 'ok');
      return;
    } catch (e) { if (!isCurrentEnv(env, origin)) return; }
  }
  // 3. 弹登录
  state.connecting = false;
  renderEnvUI(); renderTree();
  openLogin();
}
async function onConnected() {
  state.connected = true;
  state.connecting = false;
  renderEnvUI();
  renderBody();
  await loadInstances();
}
/* ================= 登录 ================= */
function openLogin(envId) {
  const target = envId || state.activeEnvId;
  const sel = $('loginEnv');
  sel.innerHTML = state.envs.map(x => `<option value="${attr(x.id)}" ${x.id === target ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  $('loginErr').textContent = '';
  onLoginEnvChange();
  openModal('loginMask');
  setTimeout(() => $('loginPwd').focus(), 50);
}
async function onLoginEnvChange() {
  const env = state.envs.find(e => e.id === $('loginEnv').value);
  if (!env) return;
  $('loginScheme').value = env.scheme === 'https' ? 'https' : 'http';
  $('loginBase').value = env.base;
  updateLoginEnvUrl();
  const cred = await store.getCred(env.id);
  $('loginUser').value = cred.user || '';
  $('loginPwd').value = cred.password || '';
  $('loginRemember').checked = cred.remember;
}
function updateLoginEnvUrl() {
  const scheme = $('loginScheme').value;
  const base = $('loginBase').value.trim() || 'archery.example.com';
  $('loginEnvUrl').textContent = `${scheme}://${base}/authenticate/`;
}
function readLoginEnv(env) {
  const scheme = $('loginScheme').value;
  const base = $('loginBase').value.trim();
  if (!base) throw new Error('请输入 Archery 域名');
  if (!['http', 'https'].includes(scheme)) throw new Error('连接协议必须是 http 或 https');
  if (/[\s/?#]/.test(base) || base.includes('://')) throw new Error('域名仅填写主机名或 IP，可包含端口，不包含协议和路径');
  return Object.freeze({ ...env, scheme, base });
}
async function doLogin() {
  const envId = $('loginEnv').value;
  const storedEnv = state.envs.find(e => e.id === envId);
  const user = $('loginUser').value.trim();
  const pwd = $('loginPwd').value;
  const remember = $('loginRemember').checked;
  let env;
  try { env = readLoginEnv(storedEnv); }
  catch (error) { $('loginErr').textContent = error.message; return; }
  if (!user || !pwd) { $('loginErr').textContent = '请输入用户名和密码'; return; }
  const btn = $('loginSubmit');
  btn.disabled = true; btn.textContent = '登录中…';
  $('loginErr').textContent = '';
  try {
    const origin = store.envOrigin(env);
    await api.login(origin, user, pwd);
    const envChanged = env.scheme !== storedEnv.scheme || env.base !== storedEnv.base;
    const envs = state.envs.map(item => item.id === envId ? env : item);
    await store.saveEnvs(envs);
    await store.saveCred(envId, { user, password: pwd, remember });
    closeModal('loginMask');
    state.envs = envs;
    if (envId !== state.activeEnvId || envChanged) {
      await applyEnv(envId);
    } else {
      state.env = env;
      state.origin = origin;
      renderEnvUI();
    }
    state.user = user;
    await onConnected();
    toast('登录成功：' + user + ' @ ' + env.name + (remember ? '（密码已存入 Windows 凭据管理器）' : ''), 'ok');
  } catch (e) {
    $('loginErr').textContent = '登录失败：' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = '登 录';
  }
}
/* ================= 环境管理 ================= */
async function openEnvMgr() {
  hideMenus();
  const envs = state.envs.map(e => ({ ...e }));
  renderEnvMgrRows(envs, {});
  openModal('envMgrMask');
  try {
    const flags = await store.getRememberFlags();
    if ($('envMgrMask').classList.contains('show')) renderEnvMgrRows(envs, flags);
  } catch (e) { toast('读取密码状态失败：' + e.message, 'err'); }
}
function renderEnvMgrRows(envs, flags) {
  const body = $('envMgrBody');
  body.innerHTML = envs.map((e, i) => `<tr data-row="${i}">
    <td><input data-f="name" value="${attr(e.name)}"></td>
    <td><input data-f="base" value="${attr(e.base)}" placeholder="archery.example.com"></td>
    <td><select data-f="scheme"><option ${e.scheme !== 'https' ? 'selected' : ''}>http</option><option ${e.scheme === 'https' ? 'selected' : ''}>https</option></select></td>
    <td>${flags[e.id] ? '<span class="badge nn">已保存</span>' : '<span class="badge null">未保存</span>'}</td>
    <td><div class="env-row-actions">
      ${flags[e.id] ? `<button class="env-action danger" data-act="clear-pwd" data-env="${attr(e.id)}">清除密码</button>` : ''}
      <button class="env-action danger" data-act="del-env" data-env="${attr(e.id)}">删除</button>
    </div></td>
  </tr>`).join('');
  body.dataset.ids = JSON.stringify(envs.map(e => e.id));
  body.dataset.colors = JSON.stringify(envs.map(e => e.color || '#888'));
}
function addEnvRow() {
  const ids = JSON.parse($('envMgrBody').dataset.ids || '[]');
  const colors = JSON.parse($('envMgrBody').dataset.colors || '[]');
  const palette = ['#5fad65', '#dcae4c', '#db5c5c', '#6c9fce', '#b189f5', '#e08855'];
  const newId = 'env_' + (state.uidSeq++) + '_' + ids.length;
  const rows = collectEnvMgr();
  rows.push({ id: newId, name: '新环境', base: '', scheme: 'http', color: palette[ids.length % palette.length] });
  const flags = {};
  renderEnvMgrRows(rows, flags);
}
function collectEnvMgr() {
  const ids = JSON.parse($('envMgrBody').dataset.ids || '[]');
  const colors = JSON.parse($('envMgrBody').dataset.colors || '[]');
  return Array.from($('envMgrBody').querySelectorAll('tr')).map((tr, i) => ({
    id: ids[i],
    color: colors[i] || '#888',
    name: tr.querySelector('[data-f=name]').value.trim() || '未命名',
    base: tr.querySelector('[data-f=base]').value.trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    scheme: tr.querySelector('[data-f=scheme]').value,
  }));
}
async function saveEnvMgr() {
  const envs = collectEnvMgr().filter(e => e.base);
  if (!envs.length) { toast('至少保留一个带域名的环境', 'err'); return; }
  try {
    await store.saveEnvs(envs);
    state.envs = envs;
    closeModal('envMgrMask');
    await applyEnv(envs.find(e => e.id === state.activeEnvId) ? state.activeEnvId : envs[0].id);
    await ensureConnected();
    toast('环境配置已保存', 'ok');
  } catch (e) { toast('保存环境配置失败：' + e.message, 'err'); }
}
async function clearEnvPwd(envId) {
  await store.clearCredPassword(envId);
  const flags = await store.getRememberFlags();
  renderEnvMgrRows(collectEnvMgr(), flags);
  toast('已清除该环境保存的密码');
}
async function delEnvRow(envId) {
  const rows = collectEnvMgr().filter(e => e.id !== envId);
  const flags = await store.getRememberFlags();
  renderEnvMgrRows(rows, flags);
}
/* ================= 树 ================= */
function makeNode(kind, name, extra) {
  const uid = 'n' + (state.uidSeq++);
  const node = { uid, kind, name, expanded: false, loading: false, error: '', ...extra };
  state.nodeMap.set(uid, node);
  return node;
}
async function loadInstances() {
  const envId = state.activeEnvId; const origin = state.origin;
  try {
    const list = await api.instances(origin);
    if (envId !== state.activeEnvId || origin !== state.origin) return;
    state.instances = list;
    state.tree = list.map(inst => makeNode('instance', inst.instance_name, { dbType: inst.db_type, instType: inst.type, dbs: null }));
    renderTree();
    const tab = curTab();
    if (tab && tab.type === 'console' && tab.instance) await loadConsoleDbs(tab);
  } catch (e) {
    if (envId !== state.activeEnvId || origin !== state.origin) return;
    state.connected = false;
    renderEnvUI();
    renderTree(e.message);
  }
}
async function refreshTree() {
  if (!state.connected) { ensureConnected(); return; }
  state.nodeMap.clear();
  await loadInstances();
  toast('已刷新实例 / 数据库 / 模式 / 表');
}
function collapseAll() {
  state.nodeMap.forEach(n => { n.expanded = false; if (n.open) n.open = { cols: false, keys: false, idx: false }; });
  renderTree();
}
function setSidebarCollapsed(collapsed) { if (collapsed && $('sidebar').contains(document.activeElement)) document.activeElement.blur(); hideMenus(); state.sidebarCollapsed = collapsed; $('main').classList.toggle('sidebar-collapsed', collapsed); $(collapsed ? 'btnSidebarExpand' : 'btnSidebarCollapse').focus(); }
async function toggleNode(uid) {
  const node = state.nodeMap.get(uid);
  if (!node) return;
  node.expanded = !node.expanded;
  if (node.kind === 'db') state.lastCtx = { inst: node.inst, db: node.name, schema: '' };
  else if (node.kind === 'schema') state.lastCtx = { inst: node.inst, db: node.db, schema: node.name };
  else if (node.kind === 'table') state.lastCtx = { inst: node.inst, db: node.db, schema: node.schema || '' };
  if (node.expanded && !node.loading) {
    if (node.kind === 'instance' && node.dbs == null) await loadDbs(node);
    else if (node.kind === 'db' && isPostgresType(node.dbType) && node.schemas == null) await loadSchemas(node);
    else if (node.kind === 'db' && !isPostgresType(node.dbType) && node.tables == null) await loadTables(node);
    else if (node.kind === 'schema' && node.tables == null) await loadTables(node);
    else if (node.kind === 'table' && node.meta == null) await loadTableMeta(node);
  }
  renderTree();
  if (node.kind === 'db' || node.kind === 'schema') syncConsoleToTree(node);
}
async function loadDbs(node) {
  node.loading = true; node.error = ''; renderTree();
  try {
    const dbs = await api.databases(state.origin, node.name);
    node.dbs = dbs.map(d => makeNode('db', d, {
      inst: node.name,
      dbType: node.dbType,
      schemas: isPostgresType(node.dbType) ? null : [],
      tables: isPostgresType(node.dbType) ? [] : null,
    }));
  } catch (e) { node.error = e.message; node.dbs = null; node.expanded = true; }
  node.loading = false; renderTree();
}
async function loadSchemas(node) {
  node.loading = true; node.error = ''; renderTree();
  try {
    const schemas = await api.schemas(state.origin, { instance: node.inst, db: node.name });
    node.schemas = schemas.map(schema => makeNode('schema', schema, {
      inst: node.inst,
      db: node.name,
      dbType: node.dbType,
      tables: null,
    }));
  } catch (e) { node.error = e.message; node.schemas = null; node.expanded = true; }
  node.loading = false; renderTree();
}
async function loadTables(node) {
  node.loading = true; node.error = ''; renderTree();
  try {
    const db = node.kind === 'schema' ? node.db : node.name;
    const schema = node.kind === 'schema' ? node.name : '';
    const tbs = await api.tables(state.origin, { instance: node.inst, db, schema });
    node.tables = tbs.map(table => makeNode('table', table, {
      inst: node.inst,
      db,
      schema,
      dbType: node.dbType,
      meta: null,
      open: { cols: false, keys: false, idx: false },
    }));
  } catch (e) { node.error = e.message; node.tables = null; node.expanded = true; }
  node.loading = false; renderTree();
}
async function loadTableMeta(node) {
  node.loading = true; node.error = ''; renderTree();
  try {
    node.meta = await api.describe(state.origin, {
      instance: node.inst,
      db: node.db,
      schema: node.schema || '',
      table: node.name,
    });
    node.open = { cols: true, keys: false, idx: false };
  } catch (e) { node.error = e.message; node.meta = null; }
  node.loading = false; renderTree();
}
function renderTree(errMsg) {
  const box = $('tree');
  const filter = $('treeSearch').value.trim().toLowerCase();
  box.innerHTML = renderResourceTree({
    connecting: state.connecting,
    connected: state.connected,
    errorMessage: typeof errMsg === 'string' ? errMsg : '',
    envName: state.env ? state.env.name : '',
    filter,
    tree: state.tree,
    nodeMap: state.nodeMap,
    selection: state.treeSel,
  });
}
function toggleFolder(uid, fold) {
  const tb = state.nodeMap.get(uid);
  if (tb && tb.open) { tb.open[fold] = !tb.open[fold]; renderTree(); }
}
/* ---- 控制台 ↔ 树 联动 ---- */
/** 控制台选择实例/数据库/模式后，展开并高亮左侧树对应节点 */
async function syncTreeToConsole(tab) {
  if (!tab || tab.type !== 'console' || !tab.instance || curTab() !== tab) return;
  const inst = state.tree.find(n => n.name === tab.instance);
  if (!inst) return;
  if (!inst.expanded) {
    inst.expanded = true;
    if (inst.dbs == null && !inst.loading) await loadDbs(inst);
  }
  let dbNode = null;
  if (tab.db && inst.dbs) {
    dbNode = inst.dbs.find(d => d.name === tab.db) || null;
    if (dbNode) {
      dbNode.expanded = true;
      if (isPostgresType(dbNode.dbType) && dbNode.schemas == null && !dbNode.loading) await loadSchemas(dbNode);
      if (!isPostgresType(dbNode.dbType) && dbNode.tables == null && !dbNode.loading) await loadTables(dbNode);
    }
  }
  let schemaNode = null;
  if (tab.schema && dbNode && dbNode.schemas) {
    schemaNode = dbNode.schemas.find(schema => schema.name === tab.schema) || null;
    if (schemaNode) {
      schemaNode.expanded = true;
      if (schemaNode.tables == null && !schemaNode.loading) await loadTables(schemaNode);
    }
  }
  state.treeSel = { inst: tab.instance, db: tab.db || '', schema: tab.schema || '' };
  renderTree();
  const target = schemaNode || dbNode || inst;
  const el = $('tree').querySelector(`[data-uid="${target.uid}"]`);
  if (el) el.scrollIntoView({ block: 'nearest' });
}
/** 点击树上的数据库或模式节点时，同步到当前激活的控制台 */
function syncConsoleToTree(node) {
  const t = curTab();
  if (!t || t.type !== 'console' || (node.kind !== 'db' && node.kind !== 'schema')) return;
  const db = node.kind === 'schema' ? node.db : node.name;
  const schema = node.kind === 'schema' ? node.name : '';
  if (t.instance === node.inst && t.db === db && t.schema === schema) return;
  const instChanged = t.instance !== node.inst;
  const dbChanged = instChanged || t.db !== db;
  t.instance = node.inst;
  t.db = db;
  t.schema = schema;
  t.dbType = node.dbType || '';
  if (instChanged) t.dbs = null;
  if (dbChanged) t.schemas = null;
  state.treeSel = { inst: node.inst, db, schema };
  scheduleConsoleSession(t);
  if (t.dbs == null) loadConsoleDbs(t);
  else if (isPostgresType(t.dbType) && t.schemas == null) loadConsoleSchemas(t);
  else renderConsole(t, $('tabbody'));
  renderTree();
}
/* ================= 标签页 ================= */
function openTableNode(uid) {
  const node = state.nodeMap.get(uid);
  if (node && node.kind === 'table') openTable({
    instance: node.inst,
    db: node.db,
    schema: node.schema || '',
    dbType: node.dbType || '',
    table: node.name,
    meta: node.meta,
  });
}
function openTable(options) {
  const { instance, db, schema, dbType, table, meta } = options;
  state.lastCtx = { inst: instance, db, schema };
  const exist = state.tabs.find(tab =>
    tab.type === 'table' && tab.instance === instance && tab.db === db
    && tab.schema === schema && tab.table === table);
  if (exist) { activateTab(exist.id); return; }
  const tab = {
    id: ++state.tabSeq, type: 'table', instance, db, schema, dbType, table,
    subview: 'data', meta: meta || null, metaLoading: false, metaErr: '',
    where: '', whereDraft: '', orderBy: [], page: 1, pageSize: 100, colW: {},
    data: null, dataLoading: false, dataErr: '', totalRows: null, totalLoading: false,
    totalErr: '', pageCount: null, hasNext: false, dataRequestId: 0, sql: '',
  };
  state.tabs.push(tab);
  activateTab(tab.id);
  ensureTableLoaded(tab);
}
function newConsole(presetSql) {
  const created = createNewConsole({
    id: ++state.tabSeq,
    sequence: state.consoleSeq,
    currentTab: curTab(),
    lastContext: state.lastCtx,
    instances: state.instances,
    findDbType,
    presetSql,
  });
  state.consoleSeq = created.nextSequence;
  state.tabs.push(created.tab);
  activateTab(created.tab.id);
}
function openDefaultConsole() {
  const consoleTab = defaultConsoleTab(state.tabs);
  if (consoleTab) activateTab(consoleTab.id);
  else newConsole();
}
function closeTabs(options) {
  hideMenus(); const closed = closeWorkspaceTabs({ tabs: state.tabs, activeTabId: state.activeTabId, activeConsoleKey: state.activeConsoleKey, ...options });
  if (!closed) return;
  state.tabs = closed.tabs; state.activeTabId = closed.activeTabId; state.activeConsoleKey = closed.activeConsoleKey; if (closed.closed.some(tab => tab.type === 'console')) persistConsoleSession();
  renderTabs(); renderBody();
}
function deleteConsole(id) {
  const deleted = deleteWorkspaceConsole({ tabs: state.tabs, id, activeTabId: state.activeTabId, activeConsoleKey: state.activeConsoleKey });
  if (!deleted) return;
  state.tabs = deleted.tabs; state.activeTabId = deleted.activeTabId; state.activeConsoleKey = deleted.activeConsoleKey;
  persistConsoleSession(); renderTabs(); renderBody();
}
function activateTab(id) {
  const tab = state.tabs.find(candidate => candidate.id === id);
  if (!tab) return;
  state.activeTabId = id;
  if (tab.type === 'console') {
    tab.open = true;
    state.activeConsoleKey = tab.consoleKey;
    persistConsoleSession();
    if (tab.instance && tab.dbs == null && state.instances.length) loadConsoleDbs(tab);
  }
  renderTabs(); renderBody();
}
function renderTabs() { $('tabbar').innerHTML = renderTabBarView({ tabs: state.tabs, activeTabId: state.activeTabId, consoleIcon: ICO.console, tableIcon: ICO.table }); }
function toggleConsoleMenu(button) {
  showConsoleMenu({ button, tabs: state.tabs, activeTabId: state.activeTabId, activeConsoleKey: state.activeConsoleKey, hideMenus });
}
function toggleAllConsolesMenu(button) {
  showAllConsolesMenu({ button, tabs: state.tabs, activeTabId: state.activeTabId, activeConsoleKey: state.activeConsoleKey });
}
function setStatus(ok, text) {
  const el = $('sbStatus');
  if (text === undefined) { el.innerHTML = ''; return; }
  el.innerHTML = `<span class="${ok ? 'ok' : 'bad'}">${ok ? '●' : '●'}</span> ${esc(text)}`;
}
function renderBody() {
  autocomplete.hide();
  const body = $('tabbody');
  const tab = curTab();
  $('sbSql').textContent = '';
  $('sbTime').textContent = '';
  $('sbCell').textContent = '';
  setStatus(true, undefined);
  if (!tab) {
    body.innerHTML = `<div class="center-view">${ICO.db}<div class="big">${state.connected ? '点击左侧表打开数据浏览，或点击标签栏左侧控制台图标新建查询' : '请先连接 Archery 环境'}</div></div>`;
    return;
  }
  if (tab.type === 'console') return renderConsole(tab, body);
  return renderTableTab(tab, body);
}
/* ---- 表：数据/结构/DDL ---- */
function ensureTableLoaded(tab) {
  ensureMeta(tab);
  ensureData(tab);
}
async function ensureMeta(tab) {
  if (tab.meta || tab.metaLoading) return;
  tab.metaLoading = true; tab.metaErr = '';
  try {
    tab.meta = await api.describe(state.origin, {
      instance: tab.instance,
      db: tab.db,
      schema: tab.schema || '',
      table: tab.table,
    });
  }
  catch (e) { tab.metaErr = e.message; }
  tab.metaLoading = false;
  if (curTab() === tab) renderBody();
}
async function ensureData(tab) {
  const requestId = ++tab.dataRequestId;
  tab.dataLoading = true; tab.totalLoading = true;
  tab.dataErr = ''; tab.totalErr = ''; tab.totalRows = null; tab.pageCount = null;
  let request;
  try {
    request = prepareTableDataQuery(tab);
    tab.page = request.page; tab.sql = request.browseSql;
  } catch (error) {
    tab.dataLoading = false; tab.totalLoading = false; tab.dataErr = error.message;
    if (curTab() === tab) renderBody();
    return;
  }
  if (curTab() === tab) renderBody();
  const loaded = await loadTableData({ api, origin: state.origin, tab, request });
  if (tab.dataRequestId !== requestId) return;
  if (loaded.data) tab.data = loaded.data;
  tab.dataErr = loaded.dataErr; tab.totalRows = loaded.totalRows; tab.totalErr = loaded.totalErr;
  tab.page = loaded.page; tab.pageCount = loaded.pageCount; tab.hasNext = loaded.hasNext; tab.sql = loaded.sql;
  tab.dataLoading = false; tab.totalLoading = false;
  if (curTab() === tab) renderBody();
}
function reloadData(tab) { tab.data = null; ensureData(tab); }
function renderTableTab(tab, body) {
  const subview = resolveTableSubview(tab);
  if (tab.subview !== subview) tab.subview = subview;
  if (subview !== 'data' && !tab.meta && !tab.metaLoading && !tab.metaErr) ensureMeta(tab);
  const view = renderTableView(tab);
  body.innerHTML = view.html;
  $('sbSql').textContent = view.sql;
  if (view.status) {
    setStatus(true, view.status.text);
    $('sbTime').textContent = view.status.elapsed;
  }
}
/* ---- 控制台 ---- */
async function loadConsoleDbs(tab) {
  const instance = tab.instance;
  tab.contextErr = '';
  tab.dbType = findDbType(state.instances, instance);
  try {
    const databases = await api.databases(state.origin, instance);
    if (tab.instance !== instance) return;
    tab.dbs = databases;
  } catch (e) {
    if (tab.instance !== instance) return;
    tab.dbs = [];
    tab.contextErr = '加载数据库失败：' + e.message;
  }
  if (!tab.dbs.includes(tab.db)) tab.db = tab.dbs[0] || '';
  if (isPostgresType(tab.dbType) && tab.db) {
    tab.schemas = null;
    await loadConsoleSchemas(tab);
    return;
  }
  tab.schema = '';
  tab.schemas = [];
  finishConsoleContextLoad(tab);
}
async function loadConsoleSchemas(tab) {
  const requestContext = { instance: tab.instance, db: tab.db };
  tab.contextErr = '';
  try {
    const schemas = await api.schemas(state.origin, requestContext);
    if (tab.instance !== requestContext.instance || tab.db !== requestContext.db) return;
    tab.schemas = schemas;
    if (!schemas.includes(tab.schema)) tab.schema = schemas[0] || '';
  } catch (e) {
    if (tab.instance !== requestContext.instance || tab.db !== requestContext.db) return;
    tab.schemas = [];
    tab.schema = '';
    tab.contextErr = '加载模式失败：' + e.message;
  }
  finishConsoleContextLoad(tab);
}
function finishConsoleContextLoad(tab) {
  scheduleConsoleSession(tab);
  if (curTab() === tab) renderConsole(tab, $('tabbody'));
  syncTreeToConsole(tab);
}
function renderConsole(tab, body) {
  const instOpts = state.instances.map(i => `<option ${i.instance_name === tab.instance ? 'selected' : ''}>${esc(i.instance_name)}</option>`).join('') || '<option>（无实例，请先登录）</option>';
  const dbOpts = (tab.dbs || []).map(d => `<option ${d === tab.db ? 'selected' : ''}>${esc(d)}</option>`).join('') || '<option value="">（选择实例后加载）</option>';
  const schemaOpts = (tab.schemas || []).map(schema => `<option ${schema === tab.schema ? 'selected' : ''}>${esc(schema)}</option>`).join('') || '<option value="">（无模式）</option>';
  const schemaSelect = isPostgresType(tab.dbType)
    ? `<span class="lb">模式</span><select class="con-schema-select" data-act="con-schema">${schemaOpts}</select>`
    : '';
  const contextError = tab.contextErr ? `<span class="err" title="${attr(tab.contextErr)}">⚠ ${esc(tab.contextErr)}</span>` : '';
  body.innerHTML = `<div class="console">
    <div class="con-toolbar">
      <span class="lb">实例</span>
      <select class="con-instance-select" data-act="con-instance">${instOpts}</select>
      <span class="lb">数据库</span>
      <select class="con-db-select" data-act="con-db">${dbOpts}</select>
      ${schemaSelect}
      ${contextError}
      <span class="grow"></span>
      <button class="tbtn" data-act="beautify">✨ 美化</button>
      <button class="tbtn primary" data-act="run-console"${tab.running ? ' disabled' : ''} title="Ctrl+Enter · 有选区时仅执行选中内容">▶ 执行</button>
    </div>
    <div class="editor" style="height:${tab.edH || 172}px">
      <div class="ed-gutter" id="edGutter"></div>
      <div class="ed-stack">
        <pre class="ed-hl" id="edHl"></pre>
        <textarea class="ed-ta" id="edTa" data-act="ed-input" spellcheck="false"></textarea>
      </div>
    </div>
    <div class="ed-resize" data-act="ed-resize" title="拖动调整编辑器高度"></div>
    <div class="con-results" id="conResults"></div>
  </div>`;
  const ta = $('edTa');
  ta.value = tab.sql;
  syncEditor(ta);
  ta.addEventListener('scroll', () => { const hl = $('edHl'); hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft; autocomplete.hide(); });
  ta.addEventListener('blur', () => setTimeout(() => autocomplete.hide(), 100));
  ta.addEventListener('click', () => autocomplete.hide());
  renderConsoleResult(tab);
}
function syncEditor(ta) {
  const tab = curTab(); if (tab) tab.sql = ta.value;
  if (tab && tab.type === 'console') scheduleConsoleSession(tab);
  $('edHl').innerHTML = highlightSql(ta.value) + '\n';
  const lines = ta.value.split('\n').length;
  $('edGutter').innerHTML = Array.from({ length: lines }, (_, i) => `<div>${i + 1}</div>`).join('');
}
function renderConsoleResult(tab) {
  const box = $('conResults');
  const view = renderConsoleResultView(tab);
  box.innerHTML = view.html;
  if (!view.status) return;
  $('sbSql').textContent = view.sql;
  $('sbTime').textContent = view.elapsed;
  setStatus(view.status.ok, view.status.text);
}
async function runConsole(tab) {
  if (tab.running) return;
  if (!tab.instance) { toast('请先选择实例（需先登录）', 'err'); return; }
  if (!tab.db) { toast('请选择数据库', 'err'); return; }
  if (isPostgresType(tab.dbType) && !tab.schema) { toast('请选择模式', 'err'); return; }
  const editor = curTab() === tab ? $('edTa') : null;
  const selStart = editor ? editor.selectionStart : 0;
  const selEnd = editor ? editor.selectionEnd : 0;
  const execution = resolveSqlExecution({ sql: tab.sql, selectionStart: selStart, selectionEnd: selEnd });
  if (!execution.sql.trim()) { toast('请输入要执行的 SQL', 'err'); return; }
  // Archery 的 /query/ 一次只处理一条 SQL：拆开后顺序执行，某条失败也继续跑其余条
  const context = Object.freeze({
    instance: tab.instance,
    db: tab.db,
    schema: tab.schema || '',
    dbType: tab.dbType || '',
  });
  const origin = state.origin;
  const envId = state.env.id;
  const statements = splitSql(execution.sql, { dbType: context.dbType });
  if (!statements.length) { toast('请输入要执行的 SQL', 'err'); return; }
  tab.executedSql = execution.sql; tab.executedSelection = execution.selectionUsed;
  tab.results = []; tab.activeResult = 0; tab.running = true;
  renderConsoleResult(tab);
  for (let i = 0; i < statements.length; i++) {
    const sql = statements[i];
    const item = await executeConsoleStatement({ api, origin, context, sql });
    tab.results.push(item);
    tab.activeResult = tab.results.length - 1;
    await store.addHistory(envId, {
      sql,
      instance: item.context.instance,
      db: item.context.db,
      schema: item.context.schema,
      dbType: item.context.dbType,
      ok: item.ok,
      elapsed: item.elapsed,
    });
    if (curTab() === tab) renderConsoleResult(tab);
  }
  tab.running = false;
  if (curTab() === tab) renderConsoleResult(tab);
  // 选中执行时，执行后把焦点还回编辑器并恢复选区高亮，便于确认执行了哪段 SQL
  if (execution.selectionUsed && selEnd > selStart && curTab() === tab) {
    const ta = $('edTa');
    if (ta && ta.value === tab.sql) { ta.focus(); ta.setSelectionRange(selStart, selEnd); }
  }
}
async function reloadConsolePage(options) {
  const tab = state.tabs.find(candidate => candidate.id === options.tabId);
  const result = tab && tab.results && tab.results[options.resultIndex];
  if (!result || !result.pageable || result.dataLoading) return;
  const maxPage = Number.isSafeInteger(result.pageCount) ? result.pageCount : options.page;
  const page = Math.min(Math.max(options.page, 1), Math.max(maxPage, 1));
  const loading = { ...result, dataLoading: true, dataErr: '' };
  tab.results = tab.results.map((item, index) => index === options.resultIndex ? loading : item);
  if (curTab() === tab) renderConsoleResult(tab);
  let next;
  try {
    next = await fetchConsolePage({ api, origin: state.origin, result, page, pageSize: options.pageSize });
  } catch (error) {
    next = { ...result, dataLoading: false, dataErr: error.message };
  }
  if (tab.results[options.resultIndex] !== loading) return;
  tab.results = tab.results.map((item, index) => index === options.resultIndex ? next : item);
  if (curTab() === tab) renderConsoleResult(tab);
}
function beautify(tab) {
  tab.sql = formatSql(tab.sql);
  scheduleConsoleSession(tab);
  renderConsole(tab, $('tabbody'));
}
function scheduleConsoleSession(tab) {
  if (!tab || tab.type !== 'console' || !state.tabs.includes(tab)) return;
  persistConsoleSession();
}
function persistConsoleSession() {
  if (!state.activeEnvId) return;
  consoleSessionManager.schedule(state.activeEnvId, consoleSessionState({
    tabs: state.tabs,
    activeConsoleKey: state.activeConsoleKey,
    nextSequence: state.consoleSeq,
  }));
}
function changeConsoleInstance(tab, instance) {
  tab.instance = instance;
  tab.dbType = findDbType(state.instances, instance);
  tab.db = '';
  tab.schema = '';
  tab.dbs = null;
  tab.schemas = null;
  tab.contextErr = '';
  scheduleConsoleSession(tab);
  loadConsoleDbs(tab);
}
function changeConsoleDatabase(tab, db) {
  tab.db = db;
  tab.schema = '';
  tab.schemas = null;
  tab.contextErr = '';
  scheduleConsoleSession(tab);
  if (isPostgresType(tab.dbType) && db) loadConsoleSchemas(tab);
  else {
    tab.schemas = [];
    renderConsole(tab, $('tabbody'));
    syncTreeToConsole(tab);
  }
}
function changeConsoleSchema(tab, schema) {
  tab.schema = schema;
  scheduleConsoleSession(tab);
  syncTreeToConsole(tab);
}
function reportConsoleSessionError(error) { console.error('[SQL Studio] 控制台会话保存失败', error); toast('控制台内容保存失败：' + error.message, 'err'); }
/* ================= 事件委托 ================= */
function bindDelegation() {
  bindAppEvents({
    state,
    api,
    autocomplete,
    getCurrentTab: curTab,
    switchEnv,
    openEnvManager: openEnvMgr,
    hideMenus,
    openLogin,
    clearPassword: clearEnvPwd,
    deleteEnvironment: delEnvRow,
    openTableNode,
    toggleNode,
    toggleFolder,
    activateTab,
    closeTab: id => closeTabs({ id, mode: 'self' }),
    closeTabs,
    openTabContextMenu: options => showTabContextMenu({ tabs: state.tabs, hideMenus, ...options }),
    newConsole,
    openDefaultConsole,
    openRenameConsole: id => consoleRename.open(id),
    deleteConsole,
    toggleConsoleMenu,
    toggleAllConsolesMenu,
    persistConsoleSession,
    renderBody,
    ensureMeta,
    applyWhere,
    reloadData,
    cycleSort,
    toast,
    runConsole,
    renderConsoleResult,
    beautify,
    exportTableCsv: csvActions.exportTableCsv,
    exportConsoleCsv: csvActions.exportConsoleCsv,
    reloadConsolePage,
    selectCell,
    syncEditor,
    changeConsoleInstance,
    changeConsoleDatabase,
    changeConsoleSchema,
    onHoverError: error => console.error('[SQL Studio] 表结构预取失败', error),
  });
}
function applyWhere(tab) {
  const input = document.querySelector('[data-act=where-input]');
  if (!tab || !input) return;
  tab.where = input.value.trim(); tab.whereDraft = tab.where;
  tab.page = 1;
  reloadData(tab);
}
/** 组合排序：首次点击升序 → 再点降序 → 再点取消该列，其余列的排序保持 */
function cycleSort(tab, col) {
  if (!Array.isArray(tab.orderBy)) tab.orderBy = [];
  const o = tab.orderBy.find(x => x.col === col);
  if (!o) tab.orderBy.push({ col, dir: 'asc' });
  else if (o.dir === 'asc') o.dir = 'desc';
  else tab.orderBy = tab.orderBy.filter(x => x.col !== col);
  tab.page = 1;
  reloadData(tab);
}
function selectCell(td) {
  document.querySelectorAll('.cell-sel').forEach(e => e.classList.remove('cell-sel'));
  td.classList.add('cell-sel');
  $('sbCell').textContent = `行 ${td.dataset.r} · ${td.dataset.col}`;
}

/* ================= 弹窗 / toast ================= */
function openModal(id) { $(id).classList.add('show'); }
function closeModal(id) { $(id).classList.remove('show'); }
function toast(msg, kind) {
  const box = $('toast');
  const el = document.createElement('div');
  el.className = 'toast-item' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}
/* ================= 启动 ================= */
init();
