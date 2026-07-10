import { ICO } from './icons.mjs';

const GUTTER_WIDTH_PX = 52;
const NUMERIC_MIN_WIDTH_PX = 70;
const NUMERIC_MAX_WIDTH_PX = 160;
const TEXT_MIN_WIDTH_PX = 110;
const TEXT_MAX_WIDTH_PX = 220;
const LARGE_TEXT_WIDTH_PX = 240;
const VARCHAR_MAX_WIDTH_PX = 300;
const COLUMN_NAME_CHAR_WIDTH_PX = 9;
const NUMERIC_PADDING_PX = 30;
const TEXT_PADDING_PX = 40;
const VARCHAR_CHAR_WIDTH_PX = 3;

const escapeHtml = value => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');
const escapeAttribute = value => escapeHtml(value).replace(/"/g, '&quot;');

export function renderGrid(columns, rows, options = {}) {
  if (!columns.length) return '<div class="center-view" style="color:var(--text-faint)">无列</div>';
  const widthOf = column => (options.widths && options.widths[column.name]) || columnWidth(column);
  const totalWidth = GUTTER_WIDTH_PX + columns.reduce((sum, column) => sum + widthOf(column), 0);
  let html = `<table class="grid" style="width:${totalWidth}px"><colgroup><col style="width:${GUTTER_WIDTH_PX}px">`;
  columns.forEach(column => { html += `<col style="width:${widthOf(column)}px">`; });
  html += '</colgroup><thead><tr><th class="gutter"></th>';
  columns.forEach((column, columnIndex) => {
    html += renderHeader(column, columnIndex, options);
  });
  html += '</tr></thead><tbody>';
  rows.forEach((row, rowIndex) => {
    html += renderRow(columns, row, rowIndex, options);
  });
  return html + '</tbody></table>';
}
function renderHeader(column, columnIndex, options) {
  const orderIndex = options.orderBy ? options.orderBy.findIndex(order => order.col === column.name) : -1;
  const sortIndicator = orderIndex >= 0 ? renderSortIndicator(options.orderBy, orderIndex) : '';
  const title = column.name + (column.type ? ' · ' + column.type : '') + (column.comment ? '\n' + column.comment : '');
  const sortable = options.sortable
    ? `class="sortable" data-act="sort" data-col="${escapeAttribute(column.name)}"`
    : '';
  return `<th ${sortable} title="${escapeAttribute(title)}">
    <span class="th-ico ${column.pk ? 'c-key' : 'c-col'}">${column.pk ? ICO.key : ICO.col}</span>${escapeHtml(column.name)}${sortIndicator}<span class="th-rs" data-ci="${columnIndex}" data-col="${escapeAttribute(column.name)}"></span></th>`;
}

function renderSortIndicator(orderBy, orderIndex) {
  const order = orderBy[orderIndex];
  const sequence = orderBy.length > 1 ? '<sub>' + (orderIndex + 1) + '</sub>' : '';
  return ` <span class="sort-ind">${order.dir === 'asc' ? '▲' : '▼'}${sequence}</span>`;
}

function renderRow(columns, row, rowIndex, options) {
  const displayIndex = (options.start || 0) + rowIndex + 1;
  let html = `<tr><td class="gutter">${displayIndex}</td>`;
  columns.forEach((column, columnIndex) => {
    const value = row[columnIndex];
    const content = value == null ? '<span class="null">&lt;null&gt;</span>' : escapeHtml(value);
    html += `<td class="${column.num ? 'num' : ''}" data-act="cell" data-r="${displayIndex}" data-col="${escapeAttribute(column.name)}">${content}</td>`;
  });
  return html + '</tr>';
}

function columnWidth(column) {
  const nameLength = (column.name || '').length;
  if (column.num) {
    return Math.min(NUMERIC_MAX_WIDTH_PX, Math.max(NUMERIC_MIN_WIDTH_PX, nameLength * COLUMN_NAME_CHAR_WIDTH_PX + NUMERIC_PADDING_PX));
  }
  const varcharMatch = /varchar\((\d+)\)/i.exec(column.type || '');
  if (varcharMatch) {
    return Math.min(VARCHAR_MAX_WIDTH_PX, Math.max(TEXT_MIN_WIDTH_PX, Number(varcharMatch[1]) * VARCHAR_CHAR_WIDTH_PX));
  }
  if (/text|json|blob/i.test(column.type || '')) return LARGE_TEXT_WIDTH_PX;
  return Math.min(TEXT_MAX_WIDTH_PX, Math.max(TEXT_MIN_WIDTH_PX, nameLength * COLUMN_NAME_CHAR_WIDTH_PX + TEXT_PADDING_PX));
}
