const DEFAULT_SQL = 'SELECT 1;';
const DEFAULT_EDITOR_HEIGHT = 172;

export function consoleIdentity(sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('控制台序号无效');
  return Object.freeze({
    consoleKey: `console-${sequence}`,
    title: sequence === 0 ? 'console' : `console_${sequence}`,
    nextSequence: sequence + 1,
  });
}

export function createConsoleTab(options) {
  const context = options.context || {};
  return {
    id: options.id,
    type: 'console',
    consoleKey: options.consoleKey,
    title: options.title,
    instance: context.instance || '',
    db: context.db || '',
    schema: context.schema || '',
    dbType: context.dbType || '',
    dbs: null,
    schemas: null,
    contextErr: '',
    sql: typeof options.sql === 'string' ? options.sql : DEFAULT_SQL,
    results: null,
    activeResult: 0,
    running: false,
    colW: {},
    edH: Number.isFinite(options.edH) ? options.edH : DEFAULT_EDITOR_HEIGHT,
    open: options.open !== false,
  };
}

function newConsoleContext(options) {
  const current = options.currentTab;
  if (current && (current.type === 'table' || current.type === 'console')) {
    return Object.freeze({
      instance: current.instance,
      db: current.db,
      schema: current.schema || '',
      dbType: current.dbType || '',
    });
  }
  const recent = options.lastContext || {};
  const instance = recent.inst || options.instances[0]?.instance_name || '';
  return Object.freeze({
    instance,
    db: recent.db || '',
    schema: recent.schema || '',
    dbType: options.findDbType(options.instances, instance),
  });
}

export function createNewConsole(options) {
  const identity = consoleIdentity(options.sequence);
  return Object.freeze({
    tab: createConsoleTab({
      id: options.id,
      consoleKey: identity.consoleKey,
      title: identity.title,
      context: newConsoleContext(options),
      sql: options.presetSql,
    }),
    nextSequence: identity.nextSequence,
  });
}

export function consoleSessionState(options) {
  return Object.freeze({
    consoles: options.tabs.filter(tab => tab.type === 'console'),
    activeConsoleKey: options.activeConsoleKey,
    nextSequence: options.nextSequence,
  });
}

export function defaultConsoleTab(tabs) {
  return tabs.find(tab => tab.type === 'console') || null;
}

export function visibleTabs(tabs) {
  return tabs.filter(tab => tab.type !== 'console' || tab.open !== false);
}

export function closeWorkspaceTab(options) {
  const index = options.tabs.findIndex(tab => tab.id === options.id);
  if (index < 0) return null;
  const closed = options.tabs[index];
  // 控制台可能仍有执行、分页或上下文请求在途，必须保留对象身份让结果回写到可重开的同一记录。
  if (closed.type === 'console') closed.open = false;
  const tabs = closed.type === 'console' ? options.tabs.slice() : options.tabs.filter(tab => tab.id !== closed.id);
  if (options.activeTabId !== closed.id) {
    const activeKey = closed.consoleKey === options.activeConsoleKey
      ? visibleTabs(tabs).find(tab => tab.type === 'console')?.consoleKey || null
      : options.activeConsoleKey;
    return Object.freeze({ tabs, closed, activeTabId: options.activeTabId, activeConsoleKey: activeKey });
  }
  const openTabs = visibleTabs(tabs);
  const previous = visibleTabs(tabs.slice(0, index)).at(-1);
  const fallback = previous || visibleTabs(tabs.slice(index + 1))[0] || null;
  const consoleFallback = fallback?.type === 'console' ? fallback : openTabs.find(tab => tab.type === 'console');
  return Object.freeze({
    tabs,
    closed,
    activeTabId: fallback ? fallback.id : null,
    activeConsoleKey: consoleFallback ? consoleFallback.consoleKey : null,
  });
}

export function deleteWorkspaceConsole(options) {
  const index = options.tabs.findIndex(tab => tab.id === options.id && tab.type === 'console');
  if (index < 0) return null;
  const deleted = options.tabs[index];
  const tabs = options.tabs.filter(tab => tab !== deleted);
  if (options.activeTabId !== deleted.id) {
    const activeKey = deleted.consoleKey === options.activeConsoleKey
      ? visibleTabs(tabs).find(tab => tab.type === 'console')?.consoleKey || null
      : options.activeConsoleKey;
    return Object.freeze({ tabs, deleted, activeTabId: options.activeTabId, activeConsoleKey: activeKey });
  }
  const previous = visibleTabs(options.tabs.slice(0, index)).at(-1);
  const fallback = previous || visibleTabs(options.tabs.slice(index + 1))[0] || null;
  const consoleFallback = fallback?.type === 'console' ? fallback : visibleTabs(tabs).find(tab => tab.type === 'console');
  return Object.freeze({
    tabs,
    deleted,
    activeTabId: fallback ? fallback.id : null,
    activeConsoleKey: consoleFallback ? consoleFallback.consoleKey : null,
  });
}

export function restoreConsoleWorkspace(session, initialTabSeq) {
  if (!session) return Object.freeze({ tabs: [], activeTabId: null, tabSeq: initialTabSeq, nextSequence: 0 });
  let tabSeq = initialTabSeq;
  const tabs = session.consoles.map(consoleState => createConsoleTab({
    id: ++tabSeq,
    consoleKey: consoleState.consoleKey,
    title: consoleState.title,
    context: consoleState,
    sql: consoleState.sql,
    edH: consoleState.edH,
    open: consoleState.open,
  }));
  const openTabs = visibleTabs(tabs);
  const active = openTabs.find(tab => tab.consoleKey === session.activeConsoleKey) || openTabs[0] || null;
  return Object.freeze({
    tabs,
    activeTabId: active ? active.id : null,
    tabSeq,
    nextSequence: session.nextSequence,
  });
}
