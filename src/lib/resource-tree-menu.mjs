const MENU_VIEWPORT_MARGIN = 8;
const CONTEXT_NODE_KINDS = Object.freeze(new Set(['instance', 'db', 'schema']));
/** 搜索结果里可能出现、并且能在树中定位的节点类型 */
const REVEAL_NODE_KINDS = Object.freeze(new Set(['db', 'table']));
const escapeHtml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function isTreeConsoleContextNode(node) {
  return !!node && CONTEXT_NODE_KINDS.has(node.kind);
}

export function isTreeRevealNode(node) {
  return !!node && REVEAL_NODE_KINDS.has(node.kind);
}

/** 定位目标节点在树中的归属：所属实例、数据库名，以及表节点所在的 schema。 */
export function resolveTreeRevealPath(tree, node) {
  if (!isTreeRevealNode(node)) return null;
  const instance = node.kind === 'instance' ? node : (tree || []).find(item => item.name === node.inst) || null;
  if (!instance) return null;
  return Object.freeze({
    instance,
    dbName: node.kind === 'db' ? node.name : (node.db || ''),
    schemaName: node.kind === 'table' ? (node.schema || '') : '',
  });
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

/** 菜单内容：控制台上下文动作用于实例/库/模式，定位动作只在搜索状态下对库与表出现。 */
export function renderTreeContextMenuView(node, options = {}) {
  const items = [];
  if (isTreeConsoleContextNode(node)) {
    items.push(`<div class="mi" data-act="tree-open-console" data-uid="${node.uid}"><span class="console-menu-icon">›_</span><span>在当前控制台打开</span></div>`);
  }
  if (options.searching && isTreeRevealNode(node)) {
    items.push(`<div class="mi" data-act="tree-reveal" data-uid="${node.uid}"><span class="menu-action-icon">⌖</span><span>清除搜索并定位</span></div>`);
  }
  if (!items.length) return '';
  return `<div class="menu-title">${escapeHtml(node.name)}</div>` + items.join('');
}

export function showTreeContextMenu(options) {
  const html = renderTreeContextMenuView(options.node, { searching: !!options.searching });
  if (!html) {
    options.hideMenus();
    return false;
  }
  options.hideMenus();
  const menu = document.getElementById('treeContextMenu');
  menu.innerHTML = html;
  menu.style.left = options.clientX + 'px';
  menu.style.top = options.clientY + 'px';
  menu.classList.add('show');
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(MENU_VIEWPORT_MARGIN, Math.min(options.clientX, window.innerWidth - rect.width - MENU_VIEWPORT_MARGIN)) + 'px';
  menu.style.top = Math.max(MENU_VIEWPORT_MARGIN, Math.min(options.clientY, window.innerHeight - rect.height - MENU_VIEWPORT_MARGIN)) + 'px';
  return true;
}
