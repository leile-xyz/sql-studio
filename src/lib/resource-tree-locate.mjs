import { resolveTreeRevealPath } from './resource-tree-menu.mjs';

/** 树中定位后的高亮时长（毫秒），与 app.css 的 .tnode.located 动画保持一致 */
export const LOCATE_FLASH_MS = 1800;

/** 展开到目标节点：实例 → 数据库 →（PostgreSQL）schema，缺数据时按需触发加载。 */
async function expandTo(options) {
  const { tree, instanceName, dbName, schemaName, tableName, loadDbs, loadSchemas, loadTables, isPostgres } = options;
  const instance = (tree || []).find(item => item.name === instanceName) || null;
  if (!instance) return null;
  if (!instance.expanded) instance.expanded = true;
  if (instance.dbs == null && !instance.loading) await loadDbs(instance);
  const dbNode = dbName ? (instance.dbs || []).find(item => item.name === dbName) || null : null;
  if (dbNode) {
    dbNode.expanded = true;
    if (isPostgres(dbNode.dbType)) {
      if (dbNode.schemas == null && !dbNode.loading) await loadSchemas(dbNode);
    } else if (dbNode.tables == null && !dbNode.loading) {
      await loadTables(dbNode);
    }
  }
  const schemaNode = schemaName && dbNode && dbNode.schemas
    ? dbNode.schemas.find(item => item.name === schemaName) || null
    : null;
  if (schemaNode) {
    schemaNode.expanded = true;
    if (schemaNode.tables == null && !schemaNode.loading) await loadTables(schemaNode);
  }
  // 表节点从刚加载的容器里按名取活节点：表列表若被重新加载，搜索命中的旧对象已不在树中
  const container = schemaNode || dbNode;
  const tableNode = tableName && container && container.tables
    ? container.tables.find(item => item.name === tableName) || null
    : null;
  return Object.freeze({
    selection: Object.freeze({ inst: instance.name, db: dbName || '', schema: schemaNode ? schemaNode.name : '' }),
    target: tableNode || schemaNode || dbNode || instance,
  });
}

/** 按实例 / 数据库 / 模式名展开树；返回 null 表示实例不在当前树中（例如已切换环境）。 */
export async function expandTreeSelection(options) {
  return expandTo(options);
}

/** 按搜索结果节点展开树，路径取自节点自身携带的实例 / 数据库 / schema。 */
export async function expandTreePath(options) {
  const path = resolveTreeRevealPath(options.tree, options.node);
  if (!path) return null;
  return expandTo({
    ...options,
    instanceName: path.instance.name,
    dbName: path.dbName,
    schemaName: path.schemaName,
    tableName: options.node.kind === 'table' ? options.node.name : '',
  });
}

/**
 * 树的定位动作：把「展开路径 → 选中 → 滚动（可选高亮）」包成两个入口，
 * 供控制台上下文联动与搜索结果右键共用。DOM 与状态通过 context 注入。
 */
export function createTreeLocator(context) {
  const { getTree, getCurrentTab, loadDbs, loadSchemas, loadTables, isPostgres, treeSearch } = context;
  const { searchInput, renderTree, treeContainer, setSelection, markLocated, hideMenus } = context;
  const expandOptions = { loadDbs, loadSchemas, loadTables, isPostgres };
  let flashTimer = 0;

  function focus(located, flash) {
    setSelection(located.selection);
    renderTree();
    const element = treeContainer().querySelector(`[data-uid="${located.target.uid}"]`);
    if (element) element.scrollIntoView({ block: 'nearest' });
    if (!flash) return;
    // 高亮交给渲染层维护：搜索期间其它实例的加载完成后会重渲染，一次性贴类会被冲掉
    clearTimeout(flashTimer);
    markLocated(located.target.uid);
    flashTimer = setTimeout(() => markLocated(''), LOCATE_FLASH_MS);
  }

  return Object.freeze({
    /** 控制台选择实例 / 数据库 / 模式后，展开并高亮左侧树对应节点 */
    async syncFromConsole(tab) {
      if (!tab || tab.type !== 'console' || !tab.instance || getCurrentTab() !== tab) return;
      const located = await expandTreeSelection({
        ...expandOptions,
        tree: getTree(),
        instanceName: tab.instance,
        dbName: tab.db || '',
        schemaName: tab.schema || '',
      });
      if (located) focus(located, false);
    },
    /** 搜索结果右键：清除搜索条件，并在树中定位到该数据库或数据表 */
    async revealSearchNode(uid) {
      hideMenus();
      const node = context.getNode(uid);
      if (!node) return;
      if (searchInput().value) {
        searchInput().value = '';
        await treeSearch();
      }
      const located = await expandTreePath({ ...expandOptions, tree: getTree(), node });
      if (located) focus(located, true);
    },
  });
}
