import { buildConsolePageSql } from './console-query.mjs';
import { countConsoleRows } from './console-execution.mjs';
import { buildBrowseSql, buildCountSql, parseCountTotal } from './db-context.mjs';
import { collectPagedRows } from './paged-export.mjs';
import { tableDataColumns } from './table-view.mjs';
import { MAX_QUERY_ROWS, validateQueryRows } from './query-row-limit.mjs';

export const DEFAULT_EXPORT_PAGE_SIZE = MAX_QUERY_ROWS;

function stableExportOrder(tab) {
  const order = (tab.orderBy || []).map(item => ({ ...item }));
  const orderedColumns = new Set(order.map(item => item.col));
  const primaryKeys = tab.meta ? tab.meta.columns.filter(column => column.pk) : [];
  for (const column of primaryKeys) {
    if (!orderedColumns.has(column.name)) order.push({ col: column.name, dir: 'asc' });
  }
  return Object.freeze(order.map(item => Object.freeze(item)));
}

function tableSnapshot(tab) {
  return Object.freeze({
    instance: tab.instance,
    db: tab.db,
    schema: tab.schema || '',
    dbType: tab.dbType || '',
    table: tab.table,
    where: tab.where,
    orderBy: stableExportOrder(tab),
  });
}

export async function collectTableExport(options) {
  const snapshot = tableSnapshot(options.tab);
  const countResult = await options.api.query(options.origin, {
    ...snapshot,
    sql: buildCountSql(snapshot),
    limit: 1,
  });
  const totalRows = parseCountTotal(countResult);
  const collected = await collectPagedRows({
    totalRows,
    pageSize: DEFAULT_EXPORT_PAGE_SIZE,
    columns: options.tab.data.columns,
    fetchPage: async request => options.api.query(options.origin, {
      ...snapshot,
      sql: buildBrowseSql({ ...snapshot, page: request.page, pageSize: request.pageSize }),
      limit: request.pageSize,
    }),
  });
  return Object.freeze({ columns: tableDataColumns(options.tab), rows: collected.rows });
}

export async function collectConsoleExport(options) {
  const result = options.result;
  const columns = Object.freeze(result.columns.map(name => Object.freeze({ name })));
  if (!result.pageable) {
    return Object.freeze({ columns, rows: validateQueryRows(result.rows) });
  }
  const totalRows = await countConsoleRows({ api: options.api, origin: options.origin, result });
  const collected = await collectPagedRows({
    totalRows,
    pageSize: DEFAULT_EXPORT_PAGE_SIZE,
    columns: result.columns,
    fetchPage: async request => options.api.query(options.origin, {
      ...result.context,
      sql: buildConsolePageSql({
        sql: result.sql,
        dbType: result.context.dbType,
        page: request.page,
        pageSize: request.pageSize,
      }),
      limit: request.pageSize,
    }),
  });
  return Object.freeze({ columns, rows: collected.rows });
}
