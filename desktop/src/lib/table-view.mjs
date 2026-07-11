import { isPostgresType, qualifiedTableName } from './db-context.mjs';
import { PAGE_SIZE_OPTIONS } from './console-query.mjs';
import { renderGrid } from './grid.mjs';
import { ICO } from './icons.mjs';
import { highlightSql } from './sql-editor.mjs';

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

function paginationState(tab, rowCount) {
  const hasTotal = Number.isSafeInteger(tab.totalRows) && tab.totalRows >= 0;
  const pageSize = Number(tab.pageSize);
  const totalPages = hasTotal && Number.isSafeInteger(pageSize) && pageSize > 0
    ? Math.max(1, Math.ceil(tab.totalRows / pageSize))
    : null;
  const loading = tab.dataLoading || tab.totalLoading;
  const pageLabel = totalPages == null
    ? `第 <b>${tab.page}</b> 页`
    : `第 <b>${tab.page}</b> / ${totalPages} 页`;
  if (tab.totalLoading) {
    return { totalPages, pageLabel, summary: `总数统计中… · 本页 ${rowCount} 条`, loading };
  }
  if (tab.totalErr) {
    return {
      totalPages,
      pageLabel,
      summary: `<span style="color:var(--red)" title="${escapeAttribute(tab.totalErr)}">总数查询失败</span> · 本页 ${rowCount} 条`,
      loading,
    };
  }
  if (hasTotal) {
    return {
      totalPages,
      pageLabel,
      summary: `共 ${tab.totalRows.toLocaleString('zh-CN')} 条 · 本页 ${rowCount} 条`,
      loading,
    };
  }
  return { totalPages, pageLabel, summary: `总数待统计 · 本页 ${rowCount} 条`, loading };
}

export function resolveTableSubview(tab) {
  if (isPostgresType(tab.dbType) && tab.subview === 'ddl') return 'data';
  return tab.subview || 'data';
}

function subviewBar(tab, subview) {
  const ddl = isPostgresType(tab.dbType)
    ? ''
    : `<span class="sv ${subview === 'ddl' ? 'on' : ''}" data-act="subview" data-v="ddl">DDL</span>`;
  return `<div class="subviews">
    <span class="sv ${subview === 'data' ? 'on' : ''}" data-act="subview" data-v="data">数据</span>
    <span class="sv ${subview === 'struct' ? 'on' : ''}" data-act="subview" data-v="struct">结构</span>
    ${ddl}
  </div>`;
}

export function tableDataColumns(tab) {
  if (tab.data && tab.data.columns.length) {
    return tab.data.columns.map((name, index) => {
      const metadata = tab.meta && tab.meta.columns.find(column => column.name === name);
      const type = tab.data.types[index] || '';
      return {
        name,
        type: metadata ? metadata.type : type,
        num: metadata ? metadata.num : isNumericType(type),
        pk: metadata ? metadata.pk : false,
        comment: metadata ? metadata.comment : '',
      };
    });
  }
  return tab.meta ? tab.meta.columns : [];
}

function renderDataView(tab, subview) {
  const columns = tableDataColumns(tab);
  const rows = tab.data ? tab.data.rows : [];
  const pagination = paginationState(tab, rows.length);
  const start = (tab.page - 1) * tab.pageSize;
  const orderBy = tab.orderBy || [];
  let gridArea = `<div class="gridwrap">${renderGrid(columns, rows, {
    sortable: true,
    orderBy,
    start,
    widths: tab.colW,
  })}</div>`;
  if (tab.dataErr) gridArea = errorBox('查询失败', tab.dataErr);
  if (tab.dataLoading && !tab.data) {
    gridArea = '<div class="center-view"><div class="spinner"></div><div>正在查询…</div></div>';
  }
  const html = `<div class="toolbar data-toolbar">
      ${subviewBar(tab, subview)}
      <span class="sep"></span><span class="wlabel">WHERE</span>
      <input class="winput" data-act="where-input" placeholder="条件片段，如 audit_status = 4 AND auditor_name LIKE '张%'" value="${escapeAttribute(tab.whereDraft ?? tab.where)}">
      <button class="tbtn" data-act="apply-where">应用</button>
      ${tab.where ? '<button class="tbtn" data-act="clear-where">清除</button>' : ''}
      ${orderBy.map(order => `<span class="chip">${escapeHtml(order.col)} ${order.dir.toUpperCase()}<span class="x" data-act="clear-sort" data-col="${escapeAttribute(order.col)}">✕</span></span>`).join('')}
      <span class="grow"></span>
      <button class="tbtn" data-act="reload"${tab.dataLoading ? ' disabled' : ''}>⟳ 刷新</button>
      <button class="tbtn" data-act="export-csv">⤓ CSV</button>
      <button class="tbtn primary" data-act="to-console">在控制台查询</button>
    </div>${gridArea}
    <div class="pagerbar">
      <span>${pagination.summary}${tab.data && tab.data.isMasked ? ' · 已脱敏' : ''}</span>
      <span style="width:1px;height:16px;background:var(--border)"></span>
      每页 <select data-act="pagesize">${PAGE_SIZE_OPTIONS.map(size => `<option ${size === tab.pageSize ? 'selected' : ''}>${size}</option>`).join('')}</select> 条
      <span style="width:1px;height:16px;background:var(--border)"></span>
      <button class="pg-btn" data-act="page" data-page="1" ${pagination.loading || tab.page <= 1 ? 'disabled' : ''}>⏮</button>
      <button class="pg-btn" data-act="page" data-page="${tab.page - 1}" ${pagination.loading || tab.page <= 1 ? 'disabled' : ''}>◀</button>
      <span class="pg-info">${pagination.pageLabel}</span>
      <button class="pg-btn" data-act="page" data-page="${tab.page + 1}" ${pagination.loading || !tab.hasNext ? 'disabled' : ''}>▶</button>
      <button class="pg-btn" data-act="page" data-page="${pagination.totalPages || tab.page}" ${pagination.loading || !tab.hasNext ? 'disabled' : ''}>⏭</button>
      <span class="grow" style="flex:1"></span>
    </div>`;
  return {
    html,
    sql: tab.sql || '',
    status: tab.data ? { text: '200 OK', elapsed: formatSeconds(tab.data.elapsed) } : null,
  };
}

function structureRows(metadata) {
  return metadata.columns.map((column, index) => `<tr>
    <td style="color:var(--text-faint)">${index + 1}</td>
    <td><span class="${column.pk ? 'c-key' : 'c-col'}">${column.pk ? ICO.key : ICO.col}</span> ${escapeHtml(column.name)}</td>
    <td style="color:var(--blue)">${escapeHtml(column.type)}</td>
    <td>${column.nn ? '<span class="badge nn">NOT NULL</span>' : '<span class="badge null">NULL</span>'}</td>
    <td>${column.pk ? '<span class="badge pk">PK</span> ' : ''}${column.ai ? '<span class="badge ai">AUTO_INC</span>' : ''}</td>
    <td>${escapeHtml(column.default || '')}</td><td class="cmt-td">${escapeHtml(column.comment || '')}</td>
  </tr>`).join('');
}

function indexRows(metadata) {
  if (!metadata.indexes.length) {
    return '<tr><td colspan="4" style="color:var(--text-faint)">无索引</td></tr>';
  }
  return metadata.indexes.map(index => `<tr>
    <td>${escapeHtml(index.name)}</td><td>${escapeHtml(index.type || 'BTREE')}</td>
    <td>${escapeHtml(index.cols.join(', '))}</td>
    <td>${index.unique ? '<span class="badge nn">UNIQUE</span>' : '<span class="badge null">普通</span>'}</td>
  </tr>`).join('');
}

function renderStructureView(tab, subview) {
  const head = `<div class="toolbar">${subviewBar(tab, subview)}<span class="grow"></span><button class="tbtn" data-act="reload-meta">⟳ 刷新</button></div>`;
  if (tab.metaErr) return { html: head + errorBox('读取表结构失败', tab.metaErr), sql: '' };
  if (!tab.meta) {
    return { html: head + '<div class="center-view"><div class="spinner"></div><div>正在读取表结构…</div></div>', sql: '' };
  }
  const metadata = tab.meta;
  const title = tab.schema ? tab.schema + '.' + tab.table : tab.table;
  const html = head + `<div class="structwrap">
    <div class="struct-title"><span class="c-table">${ICO.table}</span><h3>${escapeHtml(title)}</h3><span class="cmt">${escapeHtml(metadata.comment || '')}</span></div>
    <div class="struct-cards">
      <div class="scard"><div class="k">引擎</div><div class="v">${escapeHtml(metadata.engine || '—')}</div></div>
      <div class="scard"><div class="k">字符集</div><div class="v">${escapeHtml(metadata.charset || '—')}</div></div>
      <div class="scard"><div class="k">AUTO_INCREMENT</div><div class="v">${metadata.autoInc != null ? metadata.autoInc : '—'}</div></div>
      <div class="scard"><div class="k">列数</div><div class="v">${metadata.columns.length}</div></div>
    </div>
    <div class="sec-label">${ICO.col} 列</div>
    <table class="meta"><thead><tr><th>#</th><th>列名</th><th>类型</th><th>可空</th><th>键</th><th>默认值</th><th>注释</th></tr></thead><tbody>${structureRows(metadata)}</tbody></table>
    <div class="sec-label">${ICO.idx} 索引</div>
    <table class="meta"><thead><tr><th>名称</th><th>类型</th><th>列</th><th>唯一</th></tr></thead><tbody>${indexRows(metadata)}</tbody></table>
  </div>`;
  return { html, sql: metadata.sourceSql || 'SHOW CREATE TABLE ' + qualifiedTableName(tab) + ';' };
}

function renderDdlView(tab, subview) {
  const head = `<div class="toolbar">${subviewBar(tab, subview)}<span class="grow"></span><button class="tbtn" data-act="copy-ddl">⧉ 复制 DDL</button></div>`;
  if (tab.metaErr) return { html: head + errorBox('读取 DDL 失败', tab.metaErr), sql: '' };
  if (!tab.meta) {
    return { html: head + '<div class="center-view"><div class="spinner"></div><div>正在读取 DDL…</div></div>', sql: '' };
  }
  const content = tab.meta.ddl
    ? `<div class="ddlwrap"><div class="codebox">${highlightSql(tab.meta.ddl)}</div></div>`
    : '<div class="center-view"><div>Archery 未返回该表的建表 DDL</div></div>';
  return { html: head + content, sql: tab.meta.sourceSql || '' };
}

export function renderTableView(tab) {
  const subview = resolveTableSubview(tab);
  if (subview === 'struct') return renderStructureView(tab, subview);
  if (subview === 'ddl') return renderDdlView(tab, subview);
  return renderDataView(tab, subview);
}
