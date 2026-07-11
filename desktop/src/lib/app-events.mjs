import { buildTableConsoleSql, isPostgresType } from './db-context.mjs';

const MIN_EDITOR_HEIGHT = 60;
const EDITOR_VIEWPORT_MARGIN = 160;
const MIN_COLUMN_WIDTH = 40;
const DEFAULT_COLUMN_WIDTH = 100;

function createClickHandlers(options) {
  const currentTab = () => options.getCurrentTab();
  return Object.freeze({
    'switch-env': ({ element }) => options.switchEnv(element.dataset.env),
    'open-envmgr': () => options.openEnvManager(),
    relogin: () => { options.hideMenus(); options.openLogin(); },
    'clear-pwd': ({ element }) => options.clearPassword(element.dataset.env),
    'del-env': ({ element }) => options.deleteEnvironment(element.dataset.env),
    toggle: ({ element, event }) => {
      if (element.dataset.table && !event.target.closest('.twist')) options.openTableNode(element.dataset.uid);
      else options.toggleNode(element.dataset.uid);
    },
    folder: ({ element }) => options.toggleFolder(element.dataset.uid, element.dataset.fold),
    'open-table': ({ element }) => options.openTableNode(element.dataset.uid),
    tab: ({ element }) => options.activateTab(+element.dataset.id),
    'close-tab': ({ element, event }) => { event.stopPropagation(); options.closeTab(+element.dataset.id); },
    'new-console': () => { options.hideMenus(); options.newConsole(); },
    'toggle-console-menu': ({ element, event }) => {
      event.stopPropagation();
      options.toggleConsoleMenu(element);
    },
    'open-default-console': () => { options.hideMenus(); options.openDefaultConsole(); },
    'open-console': ({ element }) => { options.hideMenus(); options.activateTab(+element.dataset.id); },
    'rename-console': ({ element, event }) => {
      event.stopPropagation(); options.openRenameConsole(+element.dataset.id);
    },
    'delete-console': ({ element, event }) => {
      event.stopPropagation(); options.hideMenus(); options.deleteConsole(+element.dataset.id);
    },
    'show-all-consoles': ({ element, event }) => {
      event.stopPropagation();
      options.toggleAllConsolesMenu(element);
    },
    subview: ({ element }) => {
      const tab = currentTab();
      const subview = element.dataset.v;
      if (!tab || (subview === 'ddl' && isPostgresType(tab.dbType))) return;
      tab.subview = subview;
      options.renderBody();
      if (subview !== 'data') options.ensureMeta(tab);
    },
    'apply-where': () => options.applyWhere(currentTab()),
    'clear-where': () => {
      const tab = currentTab();
      tab.where = '';
      tab.whereDraft = '';
      tab.page = 1;
      options.reloadData(tab);
    },
    'clear-sort': ({ element }) => {
      const tab = currentTab();
      tab.orderBy = (tab.orderBy || []).filter(order => order.col !== element.dataset.col);
      tab.page = 1;
      options.reloadData(tab);
    },
    sort: ({ element, event }) => {
      if (!event.target.closest('.th-rs')) options.cycleSort(currentTab(), element.dataset.col);
    },
    page: ({ element }) => {
      const tab = currentTab();
      if (!tab || tab.dataLoading || tab.totalLoading) return;
      const requestedPage = Number(element.dataset.page);
      if (!Number.isSafeInteger(requestedPage)) return;
      const maxPage = Number.isSafeInteger(tab.pageCount) ? tab.pageCount : tab.page;
      tab.page = Math.min(Math.max(requestedPage, 1), Math.max(maxPage, 1));
      options.reloadData(tab);
    },
    reload: () => options.reloadData(currentTab()),
    'reload-meta': () => {
      const tab = currentTab();
      tab.meta = null;
      tab.metaErr = '';
      options.renderBody();
      options.ensureMeta(tab);
    },
    'to-console': () => options.newConsole(buildTableConsoleSql(currentTab())),
    'copy-ddl': () => copyDdl(currentTab(), options),
    'run-console': () => options.runConsole(currentTab()),
    'res-tab': ({ element }) => {
      const tab = currentTab();
      if (!tab) return;
      tab.activeResult = +element.dataset.i;
      options.renderConsoleResult(tab);
    },
    'con-page': ({ element }) => {
      const tab = currentTab();
      const result = tab && tab.results && tab.results[tab.activeResult];
      if (!result || !result.pageable || result.dataLoading) return;
      options.reloadConsolePage({
        tabId: tab.id,
        resultIndex: tab.activeResult,
        page: Number(element.dataset.page),
        pageSize: result.pageSize,
      });
    },
    beautify: () => options.beautify(currentTab()),
    'export-csv': () => options.exportTableCsv(currentTab()),
    'export-csv-con': () => options.exportConsoleCsv(currentTab()),
    cell: ({ element }) => options.selectCell(element),
  });
}

function copyDdl(tab, options) {
  if (!tab || !tab.meta || !tab.meta.ddl) {
    options.toast('Archery 未返回该表的建表 DDL', 'err');
    return;
  }
  navigator.clipboard.writeText(tab.meta.ddl).then(() => options.toast('DDL 已复制', 'ok'));
}

function bindClickEvents(options) {
  const handlers = createClickHandlers(options);
  document.addEventListener('click', event => {
    const element = event.target.closest('[data-act]');
    if (!element) return;
    const handler = handlers[element.dataset.act];
    if (handler) handler({ element, event });
  });
}

function bindInputEvents(options) {
  document.addEventListener('input', event => {
    const element = event.target.closest('[data-act]');
    if (!element) return;
    if (element.dataset.act === 'ed-input') {
      options.syncEditor(element);
      options.autocomplete.update(element);
      return;
    }
    if (element.dataset.act !== 'where-input') return;
    const tab = options.getCurrentTab();
    if (tab) tab.whereDraft = element.value;
    options.autocomplete.update(element);
  });
  document.addEventListener('change', event => handleChange(event, options));
}

function handleChange(event, options) {
  const element = event.target.closest('[data-act]');
  if (!element) return;
  const tab = options.getCurrentTab();
  if (element.dataset.act === 'pagesize') {
    tab.pageSize = +element.value;
    tab.page = 1;
    options.reloadData(tab);
    return;
  }
  if (element.dataset.act === 'con-pagesize') {
    const result = tab && tab.results && tab.results[tab.activeResult];
    if (!result || !result.pageable || result.dataLoading) return;
    options.reloadConsolePage({
      tabId: tab.id,
      resultIndex: tab.activeResult,
      page: 1,
      pageSize: Number(element.value),
    });
    return;
  }
  if (element.dataset.act === 'con-instance') options.changeConsoleInstance(tab, element.value);
  if (element.dataset.act === 'con-db') options.changeConsoleDatabase(tab, element.value);
  if (element.dataset.act === 'con-schema') options.changeConsoleSchema(tab, element.value);
}

function bindKeyboardEvents(options) {
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') options.hideMenus();
    if (options.autocomplete.isOpenFor(event.target)) {
      options.autocomplete.onKeydown(event);
      if (event.defaultPrevented) return;
    }
    const tab = options.getCurrentTab();
    if (event.ctrlKey && event.key === 'Enter' && tab && tab.type === 'console') {
      event.preventDefault();
      options.runConsole(tab);
    }
    if (event.key === 'Enter' && event.target.dataset?.act === 'where-input') options.applyWhere(tab);
    copySelectedCell(event);
  });
}

function copySelectedCell(event) {
  if (!event.ctrlKey || !['c', 'C'].includes(event.key)) return;
  const tag = (event.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || String(window.getSelection())) return;
  const cell = document.querySelector('td.cell-sel');
  if (!cell) return;
  navigator.clipboard.writeText(cell.querySelector('.null') ? '' : cell.textContent);
}

function createEditorResize(event, tab) {
  const editor = document.querySelector('.editor');
  if (!editor) return null;
  const startY = event.clientY;
  const startHeight = editor.offsetHeight;
  return moveEvent => {
    const maxHeight = window.innerHeight - EDITOR_VIEWPORT_MARGIN;
    const height = Math.max(MIN_EDITOR_HEIGHT, Math.min(maxHeight, startHeight + moveEvent.clientY - startY));
    editor.style.height = height + 'px';
    if (tab && tab.type === 'console') tab.edH = height;
  };
}

function createColumnResize(event, resizer, tab) {
  const table = resizer.closest('table.grid');
  const column = table.querySelectorAll('col')[+resizer.dataset.ci + 1];
  const startX = event.clientX;
  const startWidth = parseFloat(column.style.width) || DEFAULT_COLUMN_WIDTH;
  const startTableWidth = parseFloat(table.style.width) || table.offsetWidth;
  return moveEvent => {
    const width = Math.max(MIN_COLUMN_WIDTH, startWidth + moveEvent.clientX - startX);
    column.style.width = width + 'px';
    table.style.width = startTableWidth + width - startWidth + 'px';
    if (tab) (tab.colW || (tab.colW = {}))[resizer.dataset.col] = width;
  };
}

function bindDragEvents(options) {
  document.addEventListener('dragstart', event => {
    if (event.target.closest?.('[data-act=ed-input]')) event.preventDefault();
  });
  document.addEventListener('mousedown', event => {
    const resizer = event.target.closest('.th-rs');
    const editorResizer = event.target.closest('[data-act=ed-resize]');
    if (!resizer && !editorResizer) return;
    event.preventDefault();
    const tab = options.getCurrentTab();
    const onMove = editorResizer
      ? createEditorResize(event, tab)
      : createColumnResize(event, resizer, tab);
    if (!onMove) return;
    const onUp = () => {
      finishDrag(onMove, onUp);
      if (editorResizer) options.persistConsoleSession();
    };
    document.body.style.cursor = editorResizer ? 'row-resize' : 'col-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function finishDrag(onMove, onUp) {
  document.removeEventListener('mousemove', onMove);
  document.removeEventListener('mouseup', onUp);
  document.body.style.cursor = '';
}

function bindTreeHover(options) {
  document.addEventListener('mouseover', async event => {
    const element = event.target.closest('.tnode[data-uid]');
    if (!element) return;
    const node = options.state.nodeMap.get(element.dataset.uid);
    if (!node || node.kind !== 'table') return;
    if (node.meta) {
      element.title = node.name + (node.meta.comment ? '\n' + node.meta.comment : '');
      return;
    }
    if (node.loading || node.metaFetching) return;
    await loadHoverMetadata(node, element, options);
  });
}

async function loadHoverMetadata(node, element, options) {
  node.metaFetching = true;
  try {
    node.meta = await options.api.describe(options.state.origin, {
      instance: node.inst,
      db: node.db,
      schema: node.schema || '',
      table: node.name,
    });
    node.open = { cols: true, keys: false, idx: false };
  } catch (error) {
    options.onHoverError(error);
  } finally {
    node.metaFetching = false;
  }
  if (node.meta && element.isConnected) {
    element.title = node.name + (node.meta.comment ? '\n' + node.meta.comment : '');
  }
}

export function bindAppEvents(options) {
  bindClickEvents(options);
  bindInputEvents(options);
  bindKeyboardEvents(options);
  bindDragEvents(options);
  bindTreeHover(options);
}
