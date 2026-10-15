import { bindAppEvents } from '../src/lib/app-events.mjs';
import { closeWorkspaceTabs, createConsoleTab, defaultConsoleTab, visibleTabs } from '../src/lib/console-workspace.mjs';
import { showTabContextMenu } from '../src/lib/console-menu-view.mjs';
import { ICO } from '../src/lib/icons.mjs';
import { renderTableView } from '../src/lib/table-view.mjs';
import { createWorkspaceTabs } from '../src/lib/workspace-tabs.mjs';

const OPEN_TAB_COUNT = 30;
const FIRST_CONSOLE_ID = 29;
const LAST_CONSOLE_ID = 31;
const TABLE_NAMES = Object.freeze([
  'budget', 'account_plugin_permissions', 'api_based_extensions', 'app_annotation_hit_histories',
  'apps', 'conversations', 'dataset_collection_bindings', 'dataset_keyword_tables',
  'dataset_process_rules', 'datasets', 'document_segments', 'documents', 'embedding_model_settings',
  'end_users', 'installed_apps', 'invitation_codes', 'message_agent_thoughts', 'message_feedbacks',
  'messages', 'model_providers', 'operation_logs', 'provider_model_credentials', 'provider_model_settings',
  'schema_migrations', 'workflow_node_executions', 'workflow_runs', 'workflows', 'provider_model_settings',
]);

function seedTabs() {
  const tables = TABLE_NAMES.map((table, index) => ({
    id: index + 1, type: 'table', table, instance: 'warehouse-pg', db: index ? 'workspace_demo' : 'finance_demo',
    schema: index === TABLE_NAMES.length - 1 ? 'audit' : 'public', dbType: 'pgsql',
  }));
  const consoleTab = id => createConsoleTab({
    id, consoleKey: `console-${id}`, title: id === FIRST_CONSOLE_ID ? '会务查询' : '每日对账',
    context: { instance: 'finance-mysql', db: 'finance_demo', dbType: 'mysql' }, open: id !== LAST_CONSOLE_ID,
  });
  return [tables[0], consoleTab(FIRST_CONSOLE_ID), ...tables.slice(1), consoleTab(FIRST_CONSOLE_ID + 1), consoleTab(LAST_CONSOLE_ID)];
}

function renderBody(document, tab) {
  const body = document.getElementById('tabbody');
  if (!tab || tab.type === 'console') {
    body.innerHTML = '<div class="center-view"><div class="big">查询工作区</div></div>';
    document.getElementById('sbStatus').textContent = tab?.title || '尚未打开标签';
    return;
  }
  body.innerHTML = renderTableView({
    ...tab, subview: 'data', where: '', whereDraft: '', orderBy: [], page: 1, pageSize: 100,
    totalRows: 3, pageCount: 1, hasNext: false, colW: { id: 70, name: 260, status: 140, updated_at: 190 },
    data: { columns: ['id', 'name', 'status', 'updated_at'], types: ['LONG', 'VAR_STRING', 'VAR_STRING', 'DATETIME'],
      rows: [[1, 'workspace_default', 'enabled', '2026-10-10 09:30:00'], [2, 'daily_report', 'enabled', '2026-10-10 10:15:00'], [3, 'audit_history', 'archived', '2026-10-09 18:20:00']] },
  }).html;
  document.getElementById('sbStatus').textContent = tab.table;
}

function renderTree(document) {
  const names = TABLE_NAMES.slice(0, 10);
  document.getElementById('tree').innerHTML = `<div class="tnode"><span class="twist open">▶</span>${ICO.server}<span>warehouse-pg</span><span class="typ">postgresql</span></div>
    <div class="tnode" style="padding-left:32px">${ICO.db}<span>workspace_demo</span></div>
    <div class="tnode" style="padding-left:50px">${ICO.folder}<span>public</span></div>` +
    names.map(name => `<div class="tnode" style="padding-left:68px"><span class="c-table">${ICO.table}</span><span>${name}</span></div>`).join('');
}

function createFixture(options) {
  const { document, window } = options;
  let workspace = { tabs: seedTabs(), activeTabId: 3, activeConsoleKey: `console-${FIRST_CONSOLE_ID}` };
  const current = () => workspace.tabs.find(tab => tab.id === workspace.activeTabId);
  const hideMenus = () => { tabs.hideList(); document.querySelectorAll('.menu').forEach(menu => menu.classList.remove('show')); };
  const render = settings => { tabs.render(settings); renderBody(document, current()); };
  const activateTab = id => {
    workspace = { ...workspace, activeTabId: id, tabs: workspace.tabs.map(tab => tab.id === id ? { ...tab, open: true } : tab) };
    render({ revealActive: true });
  };
  const closeTabs = close => {
    hideMenus();
    const result = closeWorkspaceTabs({ ...workspace, tabs: workspace.tabs.map(tab => ({ ...tab })), ...close });
    if (!result) return;
    workspace = { ...workspace, ...result };
    render();
  };
  const closeTab = id => closeTabs({ id, mode: 'self' });
  const tabs = createWorkspaceTabs({
    root: document.getElementById('tabbar'), menu: document.getElementById('tabListMenu'), window, icons: ICO,
    getState: () => workspace, activateTab, closeTab, hideMenus,
  });
  bindAppEvents({
    activateTab, closeTab, closeTabs, hideMenus, getCurrentTab: current,
    toggleConsoleMenu: tabs.toggleConsoleMenu, toggleAllConsolesMenu: tabs.toggleAllConsolesMenu,
    openDefaultConsole: () => activateTab(defaultConsoleTab(workspace.tabs).id),
    newConsole: () => {
      const id = Math.max(...workspace.tabs.map(tab => tab.id)) + 1;
      const tab = createConsoleTab({ id, consoleKey: `console-${id}`, title: `临时查询_${id}` });
      workspace = { ...workspace, tabs: [...workspace.tabs, tab] };
      activateTab(id);
    },
    openTabContextMenu: event => showTabContextMenu({ ...workspace, ...event, hideMenus }),
    state: { nodeMap: new Map() }, autocomplete: { isOpenFor: () => false },
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('#consoleMenu, #consoleAllMenu, [data-act="toggle-console-menu"]')) hideMenus();
  });
  document.getElementById('fixtureTheme').addEventListener('click', () => {
    document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  });
  renderTree(document);
  render();
  return Object.freeze({
    redraw: render, activate: activateTab, getState: () => workspace,
    reset: (count = OPEN_TAB_COUNT) => {
      hideMenus();
      const open = visibleTabs(seedTabs()).slice(0, count);
      workspace = { tabs: [...open, seedTabs().find(tab => tab.id === LAST_CONSOLE_ID)], activeTabId: open[0]?.id ?? null };
      render();
    },
  });
}

window.tabsFixture = createFixture({ document, window });
