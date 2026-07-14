import { buildBrowseSql, buildCountSql, parseCountTotal } from './db-context.mjs';
import { cappedQueryPage, queryPageWindow, validateQueryRows } from './query-row-limit.mjs';

function tableContext(tab) {
  return Object.freeze({
    instance: tab.instance,
    db: tab.db,
    schema: tab.schema || '',
    table: tab.table,
  });
}

export function prepareTableDataQuery(tab) {
  const page = cappedQueryPage(tab);
  const snapshot = { ...tab, page };
  const window = queryPageWindow(snapshot);
  return Object.freeze({
    page,
    pageSize: window.pageSize,
    limit: window.limit,
    browseSql: buildBrowseSql(snapshot),
    countSql: buildCountSql(snapshot),
    context: tableContext(snapshot),
  });
}

function resolvedData(settled, limit) {
  if (settled.status === 'rejected') return { data: null, dataErr: settled.reason.message };
  try {
    return {
      data: { ...settled.value, rows: validateQueryRows(settled.value.rows, limit) },
      dataErr: '',
    };
  } catch (error) {
    return { data: null, dataErr: error.message };
  }
}

function resolvedTotal(settled, pageSize) {
  if (settled.status === 'rejected') {
    return { totalRows: null, pageCount: null, totalErr: settled.reason.message };
  }
  try {
    const totalRows = parseCountTotal(settled.value);
    return { totalRows, pageCount: Math.max(1, Math.ceil(totalRows / pageSize)), totalErr: '' };
  } catch (error) {
    return { totalRows: null, pageCount: null, totalErr: error.message };
  }
}

export async function loadTableData(options) {
  const request = options.request || prepareTableDataQuery(options.tab);
  const [dataResult, totalResult] = await Promise.allSettled([
    options.api.query(options.origin, { ...request.context, sql: request.browseSql, limit: request.limit }),
    options.api.query(options.origin, { ...request.context, sql: request.countSql, limit: 1 }),
  ]);
  const data = resolvedData(dataResult, request.limit);
  const total = resolvedTotal(totalResult, request.pageSize);
  if (total.pageCount && request.page > total.pageCount) {
    const tab = { ...options.tab, page: total.pageCount };
    return loadTableData({ ...options, tab, request: prepareTableDataQuery(tab) });
  }
  return Object.freeze({
    ...data,
    ...total,
    page: request.page,
    sql: request.browseSql,
    hasNext: total.pageCount ? request.page < total.pageCount : false,
  });
}
