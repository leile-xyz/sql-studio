import { ROW_COPY_FORMATS } from './row-copy.mjs';

const MENU_VIEWPORT_MARGIN = 8;
const escapeHtml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function menuAction(action, label, attributes = '') {
  return '<button type="button" class="mi" role="menuitem" data-act="' + action + '" ' + attributes + '>' + escapeHtml(label) + '</button>';
}

function rowMenuItems(options) {
  const count = options.state.selectedRows.length;
  const title = count > 1 ? '已选 ' + count + ' 行' : '第 ' + (options.start + options.rowIndex + 1) + ' 行';
  const subject = count > 1 ? '复制所选 ' + count + ' 行为 ' : '复制整行为 ';
  return [
    '<div class="menu-title">' + title + '</div>',
    ...ROW_COPY_FORMATS.map(format => menuAction('grid-copy', subject + format.label, 'data-format="' + format.id + '"')),
    '<hr>',
    menuAction('grid-freeze', '冻结到第 ' + (options.start + options.rowIndex + 1) + ' 行', 'data-axis="rows"'),
  ];
}

export function renderGridMenu(options) {
  const items = options.rowIndex >= 0 ? rowMenuItems(options) : [];
  if (options.columnIndex >= 0) {
    items.push(menuAction('grid-freeze', '冻结到第 ' + (options.columnIndex + 1) + ' 列（' + options.columnName + '）', 'data-axis="columns"'));
  }
  if (options.state.frozenRows || options.state.frozenColumns) items.push('<hr>');
  if (options.state.frozenRows) items.push(menuAction('grid-unfreeze', '取消冻结行', 'data-axis="rows"'));
  if (options.state.frozenColumns) items.push(menuAction('grid-unfreeze', '取消冻结列', 'data-axis="columns"'));
  if (options.state.frozenRows && options.state.frozenColumns) {
    items.push(menuAction('grid-unfreeze', '取消全部冻结', 'data-axis="all"'));
  }
  return items.join('');
}

export function showGridMenu(menu, options) {
  menu.innerHTML = renderGridMenu(options);
  if (!menu.innerHTML) return;
  menu.classList.add('show');
  const viewport = menu.ownerDocument.defaultView;
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(MENU_VIEWPORT_MARGIN, Math.min(options.clientX, viewport.innerWidth - rect.width - MENU_VIEWPORT_MARGIN)) + 'px';
  menu.style.top = Math.max(MENU_VIEWPORT_MARGIN, Math.min(options.clientY, viewport.innerHeight - rect.height - MENU_VIEWPORT_MARGIN)) + 'px';
}
