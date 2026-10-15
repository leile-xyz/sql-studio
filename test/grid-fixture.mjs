import { bindAppEvents } from '../src/lib/app-events.mjs';
import { createGridInteractions } from '../src/lib/grid-interactions.mjs';
import { renderTableView } from '../src/lib/table-view.mjs';
import { renderConsoleResultView } from '../src/lib/console-result-view.mjs';

const PAGE_SIZE = 100;
const RESULT_OFFSET = 500;
const COLUMN_WIDTH = 180;
const ID_WIDTH = 90;
const TEXT_REPEAT = 60;
const columns = ['id', 'name', 'nullable', 'enabled', 'path', 'details', 'amount', 'long_text', '尾列'];
const types = ['LONG', 'VAR_STRING', 'VAR_STRING', 'TINY', 'VAR_STRING', 'JSON', 'NEWDECIMAL', 'LONG_BLOB', 'VAR_STRING'];

function rowsAt(offset) {
  return Array.from({ length: PAGE_SIZE }, (_, index) => {
    const id = offset + index + 1;
    return [id, 'O\'Reilly, "第 ' + id + ' 行"\n第二段', null, id % 2 === 0, 'C:\\目录\\file.txt',
      { index: id, text: '中文' }, '12345678901234567890.1234', '完整内容'.repeat(TEXT_REPEAT) + '-' + id, 'tail ' + id];
  });
}

const data = { columns, types, rows: rowsAt(0), elapsed: 0.01 };
const widths = Object.fromEntries(columns.map(name => [name, name === 'id' ? ID_WIDTH : COLUMN_WIDTH]));
const tableTab = {
  id: 1, type: 'table', table: 'demo_records', db: 'fixture_db', dbType: 'mysql', schema: '',
  subview: 'data', data, meta: null, page: 1, pageSize: PAGE_SIZE, totalRows: PAGE_SIZE * 2,
  hasNext: true, pageCount: 2, colW: { ...widths }, where: '', whereDraft: '', orderBy: [],
};
const result = {
  ...data, ok: true, pageable: true, page: 1, pageSize: PAGE_SIZE,
  totalRows: PAGE_SIZE * 2, pageCount: 2, hasNext: true, sql: 'SELECT * FROM demo_records',
  context: { db: 'executed_db', dbType: 'pgsql', schema: 'public' },
};
const consoleTab = {
  id: 2, type: 'console', db: 'edited_db', dbType: 'mysql', schema: 'edited_schema',
  results: [result, { ...result, rows: rowsAt(RESULT_OFFSET) }], activeResult: 0, colW: { ...widths },
};
let currentTab = tableTab;
const hideMenus = () => document.querySelectorAll('.menu').forEach(menu => menu.classList.remove('show'));
const grid = createGridInteractions({
  document, getCurrentTab: () => currentTab, hideMenus,
  writeClipboard: text => navigator.clipboard.writeText(text),
  toast: (message, kind) => {
    document.getElementById('fixtureToast').textContent = message;
    document.getElementById('fixtureToast').className = kind;
  },
  onSelectionChange: text => { document.getElementById('sbCell').textContent = text; },
});

function render() {
  grid.unmount();
  const body = document.getElementById('tabbody');
  body.innerHTML = currentTab.type === 'table'
    ? renderTableView(currentTab).html
    : '<div class="console"><div class="toolbar">控制台查询结果</div><div class="con-results" id="conResults">' +
      renderConsoleResultView(currentTab).html + '</div></div>';
  grid.mount();
}

function reloadConsolePage(options) {
  consoleTab.results = consoleTab.results.map((item, index) => index === options.resultIndex ? {
    ...item, rows: rowsAt((options.page - 1) * options.pageSize),
    page: options.page, pageSize: options.pageSize, hasNext: options.page < item.pageCount,
  } : item);
  render();
}

bindAppEvents({
  grid, hideMenus, getCurrentTab: () => currentTab, renderConsoleResult: render, reloadConsolePage,
  state: { nodeMap: new Map() }, autocomplete: { isOpenFor: () => false },
});
document.addEventListener('click', hideMenus);
window.gridFixture = Object.freeze({
  showTable: () => { currentTab = tableTab; render(); },
  showConsole: () => { currentTab = consoleTab; render(); },
  redraw: render,
  refreshTable: () => {
    tableTab.data = { ...tableTab.data, rows: rowsAt(0) };
    currentTab = tableTab;
    render();
  },
  row: index => {
    const visible = currentTab.type === 'table' ? currentTab.data : currentTab.results[currentTab.activeResult];
    return { columns: visible.columns, row: visible.rows[index] };
  },
  showEmpty: () => {
    consoleTab.results = [...consoleTab.results, { ...result, rows: [], totalRows: 0, pageCount: 1, hasNext: false }];
    consoleTab.activeResult = consoleTab.results.length - 1;
    currentTab = consoleTab;
    render();
  },
});
render();
