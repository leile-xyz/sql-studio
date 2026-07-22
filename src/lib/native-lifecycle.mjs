const PREPARE_CLOSE_EVENT = 'sql-studio://prepare-window-close';
const CLOSE_DESTROY_FAILED_EVENT = 'sql-studio://window-close-destroy-failed';
const SNAPSHOT_VERSION = 1;
const DEFAULT_TABLE_PAGE = 1;
const DEFAULT_TABLE_PAGE_SIZE = 100;
const TABLE_SUBVIEWS = new Set(['data', 'struct', 'ddl']);

function asRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}必须是 JSON 对象`);
  }
  return value;
}

function optionalString(value, label) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串或 null`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串`);
  return value;
}

function optionalBoolean(value, label, defaultValue) {
  if (value == null) return defaultValue;
  if (typeof value !== 'boolean') throw new Error(`${label}必须是布尔值`);
  return value;
}

function requiredBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label}必须是布尔值`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}必须是非负安全整数`);
  return value;
}

function positiveInteger(value, label, defaultValue) {
  if (value == null) return defaultValue;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label}必须是正安全整数`);
  return value;
}

function normalizeContext(value, label) {
  if (value == null) return null;
  const context = asRecord(value, label);
  return Object.freeze({
    inst: requiredString(context.inst, `${label}.inst`),
    db: requiredString(context.db, `${label}.db`),
    schema: requiredString(context.schema, `${label}.schema`),
  });
}

function normalizeOrderBy(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  return Object.freeze(value.map((item, index) => {
    const entry = asRecord(item, `${label}[${index}]`);
    const dir = requiredString(entry.dir, `${label}[${index}].dir`);
    if (!['asc', 'desc'].includes(dir)) throw new Error(`${label}[${index}].dir 无效`);
    return Object.freeze({ col: requiredString(entry.col, `${label}[${index}].col`), dir });
  }));
}

function normalizeColumnWidths(value, label) {
  if (value == null) return Object.freeze({});
  const widths = asRecord(value, label);
  const normalized = {};
  for (const [column, width] of Object.entries(widths)) {
    if (!Number.isFinite(width) || width <= 0) throw new Error(`${label}.${column} 必须是正数`);
    normalized[column] = width;
  }
  return Object.freeze(normalized);
}

function tableIdentity(tab) {
  return [tab.instance, tab.db, tab.schema, tab.table].join('\u0000');
}

function normalizeTab(value, index) {
  const tab = asRecord(value, `ui_snapshot.tabs[${index}]`);
  const type = requiredString(tab.type, `ui_snapshot.tabs[${index}].type`);
  if (type === 'console') {
    const consoleKey = requiredString(tab.consoleKey, `ui_snapshot.tabs[${index}].consoleKey`);
    if (!consoleKey) throw new Error(`ui_snapshot.tabs[${index}].consoleKey 不能为空`);
    return Object.freeze({ type, consoleKey });
  }
  if (type !== 'table') throw new Error(`ui_snapshot.tabs[${index}].type 无效`);
  const normalized = {
    type,
    instance: requiredString(tab.instance, `ui_snapshot.tabs[${index}].instance`),
    db: requiredString(tab.db, `ui_snapshot.tabs[${index}].db`),
    schema: requiredString(tab.schema, `ui_snapshot.tabs[${index}].schema`),
    dbType: requiredString(tab.dbType, `ui_snapshot.tabs[${index}].dbType`),
    table: requiredString(tab.table, `ui_snapshot.tabs[${index}].table`),
    subview: tab.subview == null ? 'data' : requiredString(tab.subview, `ui_snapshot.tabs[${index}].subview`),
    where: tab.where == null ? '' : requiredString(tab.where, `ui_snapshot.tabs[${index}].where`),
    orderBy: normalizeOrderBy(tab.orderBy, `ui_snapshot.tabs[${index}].orderBy`),
    page: positiveInteger(tab.page, `ui_snapshot.tabs[${index}].page`, DEFAULT_TABLE_PAGE),
    pageSize: positiveInteger(tab.pageSize, `ui_snapshot.tabs[${index}].pageSize`, DEFAULT_TABLE_PAGE_SIZE),
    colW: normalizeColumnWidths(tab.colW, `ui_snapshot.tabs[${index}].colW`),
  };
  if (!TABLE_SUBVIEWS.has(normalized.subview)) throw new Error(`ui_snapshot.tabs[${index}].subview 无效`);
  return Object.freeze(normalized);
}

function activeTabIdentity(tab) {
  if (!tab) return null;
  if (tab.type === 'console') return Object.freeze({ type: 'console', consoleKey: tab.consoleKey });
  return Object.freeze({ type: 'table', key: tableIdentity(tab) });
}

function normalizeActiveTab(value) {
  if (value == null) return null;
  const tab = asRecord(value, 'ui_snapshot.activeTab');
  const type = requiredString(tab.type, 'ui_snapshot.activeTab.type');
  if (type === 'console') return Object.freeze({ type, consoleKey: requiredString(tab.consoleKey, 'ui_snapshot.activeTab.consoleKey') });
  if (type === 'table') return Object.freeze({ type, key: requiredString(tab.key, 'ui_snapshot.activeTab.key') });
  throw new Error('ui_snapshot.activeTab.type 无效');
}

export function normalizeUiSnapshot(value) {
  if (value == null) return null;
  const source = asRecord(value, 'persistent.ui_snapshot');
  if (source.version != null && source.version !== SNAPSHOT_VERSION) {
    throw new Error(`persistent.ui_snapshot.version 不受支持：${source.version}`);
  }
  const rawTabs = source.tabs == null ? [] : source.tabs;
  if (!Array.isArray(rawTabs)) throw new Error('persistent.ui_snapshot.tabs 必须是数组');
  const tabs = rawTabs.map(normalizeTab);
  const identities = new Set();
  for (const tab of tabs) {
    const identity = tab.type === 'console' ? `console:${tab.consoleKey}` : `table:${tableIdentity(tab)}`;
    if (identities.has(identity)) throw new Error(`persistent.ui_snapshot.tabs 包含重复标签：${identity}`);
    identities.add(identity);
  }
  return Object.freeze({
    version: SNAPSHOT_VERSION,
    activeEnvId: optionalString(source.activeEnvId, 'persistent.ui_snapshot.activeEnvId'),
    sidebarCollapsed: optionalBoolean(source.sidebarCollapsed, 'persistent.ui_snapshot.sidebarCollapsed', false),
    activeConsoleKey: optionalString(source.activeConsoleKey, 'persistent.ui_snapshot.activeConsoleKey'),
    activeTab: normalizeActiveTab(source.activeTab),
    treeSel: normalizeContext(source.treeSel, 'persistent.ui_snapshot.treeSel'),
    lastCtx: normalizeContext(source.lastCtx, 'persistent.ui_snapshot.lastCtx'),
    tabs: Object.freeze(tabs),
  });
}

function getNativeCore() {
  const core = window.__TAURI__?.core;
  if (!core || typeof core.invoke !== 'function') throw new Error('Tauri 原生调用 API 不可用');
  return core;
}

function invoke(command, args) {
  return Promise.resolve(getNativeCore().invoke(command, args)).catch(error => {
    throw new Error(typeof error === 'string' ? error : (error && error.message) || `原生调用失败：${command}`);
  });
}

export function loadBootstrapState() {
  return invoke('bootstrap_state');
}

function validateEnvironmentList(value) {
  if (!Array.isArray(value)) throw new Error('persistent.sqls_envs 必须是数组');
  const ids = new Set();
  value.forEach((candidate, index) => {
    const env = asRecord(candidate, `persistent.sqls_envs[${index}]`);
    const id = requiredString(env.id, `persistent.sqls_envs[${index}].id`);
    if (!id) throw new Error(`persistent.sqls_envs[${index}].id 不能为空`);
    if (ids.has(id)) throw new Error(`persistent.sqls_envs 包含重复环境 ID：${id}`);
    requiredString(env.base, `persistent.sqls_envs[${index}].base`);
    ids.add(id);
  });
  return value;
}

function validateStringArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  const items = value.map((item, index) => requiredString(item, `${label}[${index}]`));
  if (new Set(items).size !== items.length) throw new Error(`${label}不能包含重复项`);
  return items;
}

function validateBootstrapSnapshot(value) {
  const bootstrap = asRecord(value, 'bootstrap_state 返回值');
  const mode = asRecord(bootstrap.mode, 'bootstrap_state.mode');
  const runtime = asRecord(bootstrap.runtime, 'bootstrap_state.runtime');
  const background = asRecord(runtime.background, 'bootstrap_state.runtime.background');
  const uiPresent = requiredBoolean(mode.uiPresent, 'bootstrap_state.mode.uiPresent');
  const mainWindowPresent = requiredBoolean(runtime.mainWindowPresent, 'bootstrap_state.runtime.mainWindowPresent');
  const lightweight = requiredBoolean(mode.lightweight, 'bootstrap_state.mode.lightweight');
  requiredBoolean(mode.startupLightweight, 'bootstrap_state.mode.startupLightweight');
  if (lightweight === uiPresent) throw new Error('bootstrap_state 的轻量运行态与主窗口状态不一致');
  nonNegativeInteger(runtime.generation, 'bootstrap_state.runtime.generation');
  validateStringArray(runtime.workspaceWebviews, 'bootstrap_state.runtime.workspaceWebviews');
  requiredBoolean(background.schedulerManaged, 'bootstrap_state.runtime.background.schedulerManaged');
  requiredBoolean(background.mcpRunning, 'bootstrap_state.runtime.background.mcpRunning');
  nonNegativeInteger(background.archerySessions, 'bootstrap_state.runtime.background.archerySessions');
  if (uiPresent !== mainWindowPresent) throw new Error('bootstrap_state 的主窗口状态不一致');
  asRecord(bootstrap.persistent, 'bootstrap_state.persistent');
  return bootstrap;
}

export async function loadInitialUiState(store) {
  if (!store || typeof store.getEnvs !== 'function' || typeof store.getActiveEnvId !== 'function') {
    throw new Error('加载初始界面状态需要完整的存储实现');
  }
  const bootstrap = validateBootstrapSnapshot(await loadBootstrapState());
  const persistent = bootstrap.persistent;
  const storedEnvs = persistent.sqls_envs;
  const envs = storedEnvs == null || (Array.isArray(storedEnvs) && storedEnvs.length === 0)
    ? validateEnvironmentList(await store.getEnvs())
    : validateEnvironmentList(storedEnvs);
  const storedActive = persistent.sqls_active_env;
  const activeEnvId = storedActive == null || storedActive === ''
    ? await store.getActiveEnvId()
    : requiredString(storedActive, 'persistent.sqls_active_env');
  if (activeEnvId != null && !envs.some(env => env.id === activeEnvId)) {
    throw new Error(`活动环境不存在：${activeEnvId}`);
  }
  const uiSnapshot = normalizeUiSnapshot(persistent.ui_snapshot);
  if (uiSnapshot?.activeEnvId != null && uiSnapshot.activeEnvId !== activeEnvId) {
    throw new Error('界面快照与持久化活动环境不一致');
  }
  return Object.freeze({
    bootstrap,
    envs,
    activeEnvId: optionalString(activeEnvId, '活动环境 ID'),
    uiSnapshot,
  });
}

function serializeContext(value, label) {
  return normalizeContext(value, label);
}

function serializeTab(tab, index) {
  const normalized = normalizeTab(tab, index);
  return normalized;
}

export function createUiSnapshot(state) {
  if (!state || !Array.isArray(state.tabs)) throw new Error('创建界面状态快照需要有效的标签列表');
  state.tabs.forEach((tab, index) => {
    if (!tab || !['console', 'table'].includes(tab.type)) throw new Error(`state.tabs[${index}].type 无效`);
  });
  const tabs = state.tabs
    .filter(tab => tab.type === 'table' || tab.open !== false)
    .map(serializeTab);
  const snapshot = {
    version: SNAPSHOT_VERSION,
    activeEnvId: optionalString(state.activeEnvId, 'state.activeEnvId'),
    sidebarCollapsed: optionalBoolean(state.sidebarCollapsed, 'state.sidebarCollapsed', false),
    activeConsoleKey: optionalString(state.activeConsoleKey, 'state.activeConsoleKey'),
    activeTab: activeTabIdentity(state.tabs.find(tab => tab.id === state.activeTabId)),
    treeSel: serializeContext(state.treeSel, 'state.treeSel'),
    lastCtx: serializeContext(state.lastCtx, 'state.lastCtx'),
    tabs,
  };
  return normalizeUiSnapshot(snapshot);
}

function createTableTab(meta, id) {
  return {
    id,
    type: 'table',
    instance: meta.instance,
    db: meta.db,
    schema: meta.schema,
    dbType: meta.dbType,
    table: meta.table,
    subview: meta.subview,
    meta: null,
    metaLoading: false,
    metaErr: '',
    where: meta.where,
    whereDraft: meta.where,
    orderBy: meta.orderBy.map(item => ({ ...item })),
    page: meta.page,
    pageSize: meta.pageSize,
    colW: { ...meta.colW },
    data: null,
    dataLoading: false,
    dataErr: '',
    totalRows: null,
    totalLoading: false,
    totalErr: '',
    pageCount: null,
    hasNext: false,
    dataRequestId: 0,
    sql: '',
  };
}

function findRestoredTab(tabs, reference) {
  if (!reference) return null;
  if (reference.type === 'console') return tabs.find(tab => tab.type === 'console' && tab.consoleKey === reference.consoleKey) || null;
  return tabs.find(tab => tab.type === 'table' && tableIdentity(tab) === reference.key) || null;
}

export function restoreUiSnapshot(options) {
  if (!options || !Array.isArray(options.tabs)) throw new Error('恢复界面状态需要有效的标签列表');
  const snapshot = normalizeUiSnapshot(options.snapshot);
  const baseTabs = options.tabs.slice();
  if (!snapshot) return Object.freeze({ tabs: baseTabs, tabSeq: options.tabSeq, activeTabId: options.activeTabId, activeConsoleKey: options.activeConsoleKey, sidebarCollapsed: false, treeSel: null, lastCtx: null });
  const shared = { sidebarCollapsed: snapshot.sidebarCollapsed, treeSel: snapshot.treeSel, lastCtx: snapshot.lastCtx };
  if (snapshot.activeEnvId !== options.activeEnvId) return Object.freeze({ ...shared, tabs: baseTabs, tabSeq: options.tabSeq, activeTabId: options.activeTabId, activeConsoleKey: options.activeConsoleKey });
  const tabs = [];
  const used = new Set();
  let nextTabSeq = options.tabSeq;
  for (const meta of snapshot.tabs) {
    if (meta.type === 'console') {
      const tab = baseTabs.find(item => item.type === 'console' && item.consoleKey === meta.consoleKey);
      if (!tab) throw new Error(`界面快照引用了不存在的控制台：${meta.consoleKey}`);
      tabs.push(tab); used.add(tab);
    } else {
      const tab = createTableTab(meta, ++nextTabSeq);
      tabs.push(tab);
    }
  }
  for (const tab of baseTabs) if (!used.has(tab) && !tabs.includes(tab)) tabs.push(tab);
  const active = findRestoredTab(tabs, snapshot.activeTab);
  if (snapshot.activeTab && !active) throw new Error('界面快照引用了不存在的活动标签');
  if (snapshot.activeConsoleKey && !tabs.some(tab => tab.type === 'console' && tab.consoleKey === snapshot.activeConsoleKey)) {
    throw new Error(`界面快照引用了不存在的活动控制台：${snapshot.activeConsoleKey}`);
  }
  const activeConsoleKey = snapshot.activeConsoleKey || options.activeConsoleKey;
  return Object.freeze({ ...shared, tabs, tabSeq: nextTabSeq, activeTabId: active ? active.id : options.activeTabId, activeConsoleKey });
}

function reportCloseError(onError, error) {
  try { onError(error); } catch (callbackError) { console.error('[SQL Studio] 关闭错误回调失败', callbackError); }
}

export function saveUiSnapshot(snapshot) {
  return invoke('save_ui_snapshot', { snapshot });
}

export function registerNativeCloseHandler({ flush, snapshot, cleanup, onError }) {
  if (typeof flush !== 'function' || typeof snapshot !== 'function' || typeof cleanup !== 'function' || typeof onError !== 'function') {
    throw new Error('窗口关闭握手需要 flush、snapshot、cleanup 和 onError 回调');
  }
  const eventApi = window.__TAURI__?.event;
  if (!eventApi || typeof eventApi.listen !== 'function') throw new Error('Tauri 事件 API 不可用，无法完成窗口关闭握手');
  let handling = false;
  const handleDestroyFailure = event => {
    if (!handling) return;
    handling = false;
    const payload = event?.payload;
    const message = payload && typeof payload === 'object' && typeof payload.message === 'string'
      ? payload.message
      : '原生主界面销毁失败';
    reportCloseError(onError, new Error(message));
  };
  const handlePrepareClose = () => {
    if (handling) return;
    handling = true;
    Promise.resolve()
      .then(() => flush())
      .then(() => saveUiSnapshot(snapshot()))
      .then(() => cleanup())
      .then(() => {
        // 原生在 IPC 提交后异步销毁 WebView；页面提前退出时响应仍可能不可达。
        invoke('window_close_ready').catch(error => console.error('[SQL Studio] 原生关闭提交失败', error));
      })
      .catch(async error => {
        handling = false;
        try { await invoke('window_close_failed', { message: error.message }); }
        catch (closeError) { reportCloseError(onError, closeError); }
        reportCloseError(onError, error);
      });
  };
  const listeners = Promise.all([
    eventApi.listen(PREPARE_CLOSE_EVENT, handlePrepareClose),
    eventApi.listen(CLOSE_DESTROY_FAILED_EVENT, handleDestroyFailure),
  ]);
  listeners.catch(error => reportCloseError(onError, error));
  return listeners.then(unlisteners => () => unlisteners.forEach(unlisten => unlisten()));
}
