const MENU_VIEWPORT_MARGIN = 8;
const CONTEXT_NODE_KINDS = Object.freeze(new Set(['instance', 'db', 'schema']));
const escapeHtml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function isTreeConsoleContextNode(node) {
  return !!node && CONTEXT_NODE_KINDS.has(node.kind);
}

export function resolveTreeConsoleChange(tab, node) {
  if (!tab || tab.type !== 'console') throw new Error('当前标签不是查询控制台');
  if (!isTreeConsoleContextNode(node)) throw new Error('该资源节点不能设置控制台上下文');
  const instance = node.kind === 'instance' ? node.name : node.inst;
  const db = node.kind === 'instance' ? '' : node.kind === 'schema' ? node.db : node.name;
  const schema = node.kind === 'schema' ? node.name : '';
  const context = Object.freeze({ instance, db, schema, dbType: node.dbType || '' });
  return Object.freeze({
    context,
    instanceChanged: tab.instance !== instance,
    databaseChanged: tab.instance !== instance || tab.db !== db,
    changed: tab.instance !== instance || tab.db !== db || tab.schema !== schema || tab.dbType !== context.dbType,
  });
}

export function renderTreeContextMenuView(node) {
  if (!isTreeConsoleContextNode(node)) return '';
  return `<div class="menu-title">${escapeHtml(node.name)}</div>
    <div class="mi" data-act="tree-open-console" data-uid="${node.uid}"><span class="console-menu-icon">›_</span><span>在当前控制台打开</span></div>`;
}

export function showTreeContextMenu(options) {
  if (!isTreeConsoleContextNode(options.node)) {
    options.hideMenus();
    return false;
  }
  options.hideMenus();
  const menu = document.getElementById('treeContextMenu');
  menu.innerHTML = renderTreeContextMenuView(options.node);
  menu.style.left = options.clientX + 'px';
  menu.style.top = options.clientY + 'px';
  menu.classList.add('show');
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(MENU_VIEWPORT_MARGIN, Math.min(options.clientX, window.innerWidth - rect.width - MENU_VIEWPORT_MARGIN)) + 'px';
  menu.style.top = Math.max(MENU_VIEWPORT_MARGIN, Math.min(options.clientY, window.innerHeight - rect.height - MENU_VIEWPORT_MARGIN)) + 'px';
  return true;
}
