const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = value => esc(value).replace(/"/g, '&quot;');

function tabHtml(tab, options) {
  const icon = tab.type === 'console'
    ? `<span class="c-idx">${options.consoleIcon}</span>`
    : `<span class="c-table">${options.tableIcon}</span>`;
  const tableContext = tab.schema ? tab.db + '.' + tab.schema : tab.db;
  const title = tab.type === 'console'
    ? esc(tab.title)
    : `${esc(tab.table)} <span class="tdb">${esc(tableContext)}</span>`;
  const tablePath = tab.schema ? `${tab.db}.${tab.schema}.${tab.table}` : `${tab.db}.${tab.table}`;
  const tooltip = tab.type === 'table' ? attr(`${tab.instance} · ${tablePath}`) : attr(tab.title);
  return `<div class="tab ${tab.id === options.activeTabId ? 'active' : ''}" data-act="tab" data-id="${tab.id}" title="${tooltip}">
    ${icon}<span>${title}</span><span class="x" data-act="close-tab" data-id="${tab.id}">✕</span></div>`;
}

export function renderTabBarView(options) {
  const tabs = options.tabs.filter(tab => tab.type !== 'console' || tab.open !== false)
    .map(tab => tabHtml(tab, options)).join('');
  return `<div class="console-launcher-wrap">
    <button class="console-launcher" data-act="toggle-console-menu" title="查询控制台" aria-label="查询控制台">
      ${options.consoleIcon}<span class="launcher-caret">⌄</span>
    </button>
  </div><div class="tabs-scroll">${tabs}</div>`;
}

function consoleItem(tab, activeTabId) {
  const active = tab.id === activeTabId ? ' active' : '';
  const closed = tab.open === false ? ' closed' : '';
  return `<div class="mi console-item${active}${closed}" data-act="open-console" data-id="${tab.id}">
    <span class="console-menu-icon">›_</span><span>${esc(tab.title)}</span><span class="grow"></span><span class="check">✔</span>
    <button class="console-action console-rename" data-act="rename-console" data-id="${tab.id}" title="重命名控制台" aria-label="重命名控制台 ${attr(tab.title)}">✎</button>
    <button class="console-delete" data-act="delete-console" data-id="${tab.id}" title="永久删除控制台" aria-label="永久删除控制台 ${attr(tab.title)}">✕</button>
  </div>`;
}

function activeConsoleId(options) {
  const activeTab = options.consoles.find(tab => tab.id === options.activeTabId);
  if (activeTab) return activeTab.id;
  return options.consoles.find(tab => tab.consoleKey === options.activeConsoleKey)?.id || null;
}

export function renderConsoleMenuView(options) {
  const activeTabId = activeConsoleId(options);
  const current = options.consoles.find(tab => tab.id === activeTabId) || options.consoles[0];
  const recent = current ? consoleItem(current, activeTabId) : '<div class="menu-empty">尚未打开控制台</div>';
  return `<div class="menu-title">查询控制台</div>
    <div class="mi" data-act="new-console"><span class="menu-action-icon">▣</span><span>新建查询控制台</span></div>
    <div class="mi" data-act="open-default-console"><span class="console-menu-icon">›_</span><span>默认查询控制台</span></div>
    <hr>${recent}
    <div class="mi" data-act="show-all-consoles"><span class="menu-action-icon">≡</span><span>所有</span><span class="grow"></span><span>›</span></div>`;
}

export function renderAllConsolesMenuView(options) {
  if (!options.consoles.length) return '<div class="menu-empty">尚未打开控制台</div>';
  const activeTabId = activeConsoleId(options);
  return options.consoles.map(tab => consoleItem(tab, activeTabId)).join('');
}

export function showConsoleMenu(options) {
  const menu = document.getElementById('consoleMenu');
  const opening = !menu.classList.contains('show');
  options.hideMenus();
  if (!opening) return;
  const consoles = options.tabs.filter(tab => tab.type === 'console');
  menu.innerHTML = renderConsoleMenuView({ consoles, activeTabId: options.activeTabId, activeConsoleKey: options.activeConsoleKey });
  const rect = options.button.getBoundingClientRect();
  menu.style.left = rect.left + 'px';
  menu.style.top = (rect.bottom + 5) + 'px';
  menu.classList.add('show');
}

export function showAllConsolesMenu(options) {
  const menu = document.getElementById('consoleAllMenu');
  const opening = !menu.classList.contains('show');
  menu.classList.remove('show');
  if (!opening) return;
  const consoles = options.tabs.filter(tab => tab.type === 'console');
  menu.innerHTML = renderAllConsolesMenuView({ consoles, activeTabId: options.activeTabId, activeConsoleKey: options.activeConsoleKey });
  const parentRect = document.getElementById('consoleMenu').getBoundingClientRect();
  const itemRect = options.button.getBoundingClientRect();
  menu.style.left = (parentRect.right + 4) + 'px';
  menu.style.top = itemRect.top + 'px';
  menu.classList.add('show');
}
