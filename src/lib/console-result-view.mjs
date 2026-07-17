import { PAGE_SIZE_OPTIONS } from './console-query.mjs';
import { renderGrid } from './grid.mjs';
import { ICO } from './icons.mjs';

const NUMERIC_TYPES = Object.freeze(new Set([
  'TINY', 'SHORT', 'LONG', 'LONGLONG', 'INT24', 'FLOAT', 'DOUBLE',
  'DECIMAL', 'NEWDECIMAL', 'YEAR', 'BIT',
]));

const escapeHtml = value => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');
const escapeAttribute = value => escapeHtml(value).replace(/"/g, '&quot;');
const isNumericType = type => NUMERIC_TYPES.has(String(type || '').toUpperCase());
const formatSeconds = seconds => (typeof seconds === 'number' ? seconds.toFixed(4) : seconds || '0') + ' s';

function errorBox(title, message) {
  return `<div class="center-view"><div class="error-box"><div class="et">⚠ ${escapeHtml(title)}</div><div>${escapeHtml(message)}</div></div></div>`;
}

function resultTabs(results, activeIndex) {
  return results.map((result, index) => {
    const active = index === activeIndex ? ' active' : '';
    const dot = result.ok ? '<span class="rt-dot ok"></span>' : '<span class="rt-dot bad"></span>';
    const rowCount = Number.isSafeInteger(result.totalRows) ? result.totalRows : result.rows.length;
    const meta = result.ok ? `${rowCount.toLocaleString('zh-CN')} 行 · ${formatSeconds(result.elapsed)}` : '失败';
    return `<span class="res-tab${active}" data-act="res-tab" data-i="${index}" title="${escapeAttribute(result.sql)}">${dot}结果 ${index + 1}<span class="rt-meta">${meta}</span></span>`;
  }).join('');
}

function pagerSummary(result) {
  if (result.totalLoading) return `总数统计中… · 本页 ${result.rows.length} 条`;
  if (result.totalErr) {
    return `<span style="color:var(--red)" title="${escapeAttribute(result.totalErr)}">总数查询失败</span> · 本页 ${result.rows.length} 条`;
  }
  if (Number.isSafeInteger(result.totalRows)) {
    return `共 ${result.totalRows.toLocaleString('zh-CN')} 条 · 本页 ${result.rows.length} 条`;
  }
  return `总数待统计 · 本页 ${result.rows.length} 条`;
}

function pagerHtml(result) {
  if (!result.pageable) return '';
  const loading = result.dataLoading || result.totalLoading;
  const totalPages = Number.isSafeInteger(result.pageCount) ? result.pageCount : null;
  const pageLabel = totalPages == null ? `第 <b>${result.page}</b> 页` : `第 <b>${result.page}</b> / ${totalPages} 页`;
  const maxPage = totalPages || result.page;
  const hasNext = totalPages != null ? result.page < totalPages : result.hasNext;
  const options = PAGE_SIZE_OPTIONS
    .map(size => `<option ${size === result.pageSize ? 'selected' : ''}>${size}</option>`)
    .join('');
  return `<div class="pagerbar">
    <span>${pagerSummary(result)}${result.isMasked ? ' · 已脱敏' : ''}</span>
    <span style="width:1px;height:16px;background:var(--border)"></span>
    每页 <select data-act="con-pagesize" ${loading ? 'disabled' : ''}>${options}</select> 条
    <span style="width:1px;height:16px;background:var(--border)"></span>
    <button class="pg-btn" data-act="con-page" data-page="1" ${loading || result.page <= 1 ? 'disabled' : ''}>⏮</button>
    <button class="pg-btn" data-act="con-page" data-page="${result.page - 1}" ${loading || result.page <= 1 ? 'disabled' : ''}>◀</button>
    <span class="pg-info">${pageLabel}</span>
    <button class="pg-btn" data-act="con-page" data-page="${result.page + 1}" ${loading || !hasNext ? 'disabled' : ''}>▶</button>
    <button class="pg-btn" data-act="con-page" data-page="${maxPage}" ${loading || !hasNext ? 'disabled' : ''}>⏭</button>
    <span class="grow" style="flex:1"></span>
  </div>`;
}

function resultBody(result, columnWidths) {
  if (!result.ok) return errorBox('执行失败', result.error);
  if (result.dataErr) return errorBox('查询失败', result.dataErr);
  if (result.dataLoading) return '<div class="center-view"><div class="spinner"></div><div>正在查询…</div></div>';
  const columns = result.columns.map((name, index) => ({
    name,
    type: result.types[index] || '',
    num: isNumericType(result.types[index]),
  }));
  const start = result.pageable ? (result.page - 1) * result.pageSize : 0;
  if (result.rows.length) {
    return `<div class="gridwrap">${renderGrid(columns, result.rows, { widths: columnWidths, start })}</div>`;
  }
  const emptyMessage = '<div class="big">查询结果为空</div><div>当前查询未返回任何数据</div>';
  if (!columns.length) return `<div class="center-view">${emptyMessage}</div>`;
  const grid = renderGrid(columns, [], { widths: columnWidths, start });
  const empty = `<div class="center-view" style="position:absolute;inset:31px 0 0">${emptyMessage}</div>`;
  return `<div class="gridwrap">${grid}${empty}</div>`;
}

export function renderConsoleResultView(tab) {
  const results = tab.results || [];
  if (tab.running && !results.length) {
    return { html: '<div class="center-view"><div class="spinner"></div><div>正在执行…</div></div>' };
  }
  if (!results.length) {
    return { html: `<div class="res-empty">${ICO.console}<div>按 <kbd>Ctrl + Enter</kbd> 或点击「▶ 执行」运行 SQL</div></div>` };
  }
  const activeIndex = Number.isInteger(tab.activeResult)
    ? Math.min(tab.activeResult, results.length - 1)
    : results.length - 1;
  const result = results[activeIndex];
  const total = Number.isSafeInteger(result.totalRows) ? `共 ${result.totalRows.toLocaleString('zh-CN')} 行 · ` : '';
  const selection = tab.executedSelection ? ' · 已执行选中内容' : '';
  const headMeta = result.ok
    ? `${total}本页 ${result.rows.length} 行 · ${formatSeconds(result.elapsed)}${result.isMasked ? ' · 已脱敏' : ''}${selection}`
    : `执行失败${selection}`;
  const disabled = !result.ok || result.dataLoading ? ' disabled' : '';
  const html = `<div class="res-tabs">${resultTabs(results, activeIndex)}</div>
    <div class="res-head">
      <span class="res-meta">${headMeta}</span>
      <span class="grow" style="flex:1"></span>
      <button class="tbtn" data-act="export-csv-con"${disabled}>⤓ CSV</button>
    </div>
    ${resultBody(result, tab.colW)}
    ${result.ok ? pagerHtml(result) : ''}`;
  return {
    html,
    sql: (result.fullSql || result.sql || tab.sql).replace(/\s+/g, ' '),
    elapsed: result.ok ? formatSeconds(result.elapsed) : '',
    status: { ok: result.ok, text: result.ok ? '200 OK' : '执行失败' },
  };
}
