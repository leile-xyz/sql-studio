import {
  buildConsoleCountSql,
  buildConsolePageSql,
  DEFAULT_CONSOLE_PAGE_SIZE,
  isPageableConsoleSql,
} from './console-query.mjs';
import { parseCountTotal } from './db-context.mjs';

const COUNT_QUERY_LIMIT = 1;

function resultBase(options) {
  return {
    sql: options.sql,
    context: Object.freeze({ ...options.context }),
    ok: false,
    pageable: options.pageable,
    columns: [],
    types: [],
    rows: [],
    elapsed: 0,
    fullSql: options.sql,
    isMasked: false,
    error: '',
    page: 1,
    pageSize: DEFAULT_CONSOLE_PAGE_SIZE,
    totalRows: null,
    pageCount: null,
    hasNext: false,
    dataLoading: false,
    dataErr: '',
    totalLoading: false,
    totalErr: '',
  };
}

function queryOptions(options, sql, limit) {
  return { ...options.context, sql, limit };
}

function successfulResult(base, response) {
  return {
    ...base,
    ok: true,
    columns: response.columns,
    types: response.types,
    rows: response.rows,
    elapsed: response.elapsed,
    fullSql: response.fullSql,
    isMasked: response.isMasked,
  };
}

async function executeSingleQuery(options) {
  const base = resultBase({ ...options, pageable: false });
  try {
    const response = await options.api.query(
      options.origin,
      queryOptions(options, options.sql, DEFAULT_CONSOLE_PAGE_SIZE),
    );
    return successfulResult(base, response);
  } catch (error) {
    return { ...base, error: error.message };
  }
}

async function executePageableQuery(options) {
  const base = resultBase({ ...options, pageable: true });
  const pageSql = buildConsolePageSql({
    sql: options.sql,
    dbType: options.context.dbType,
    page: base.page,
    pageSize: base.pageSize,
  });
  const countSql = buildConsoleCountSql({ sql: options.sql, dbType: options.context.dbType });
  const [dataResult, totalResult] = await Promise.allSettled([
    options.api.query(options.origin, queryOptions(options, pageSql, base.pageSize)),
    options.api.query(options.origin, queryOptions(options, countSql, COUNT_QUERY_LIMIT)),
  ]);
  if (dataResult.status === 'rejected') return { ...base, error: dataResult.reason.message };
  const result = successfulResult(base, dataResult.value);
  if (totalResult.status === 'rejected') {
    return { ...result, hasNext: false, totalErr: totalResult.reason.message };
  }
  try {
    const totalRows = parseCountTotal(totalResult.value);
    const pageCount = Math.max(1, Math.ceil(totalRows / result.pageSize));
    return { ...result, totalRows, pageCount, hasNext: result.page < pageCount };
  } catch (error) {
    return { ...result, hasNext: false, totalErr: error.message };
  }
}

export function executeConsoleStatement(options) {
  if (!isPageableConsoleSql(options.sql, options.context.dbType)) return executeSingleQuery(options);
  return executePageableQuery(options);
}

async function fetchPageAndCount(options) {
  const sql = buildConsolePageSql({
    sql: options.result.sql,
    dbType: options.result.context.dbType,
    page: options.page,
    pageSize: options.pageSize,
  });
  const countSql = buildConsoleCountSql({
    sql: options.result.sql,
    dbType: options.result.context.dbType,
  });
  const [dataResult, totalResult] = await Promise.allSettled([
    options.api.query(options.origin, { ...options.result.context, sql, limit: options.pageSize }),
    options.api.query(options.origin, { ...options.result.context, sql: countSql, limit: COUNT_QUERY_LIMIT }),
  ]);
  if (dataResult.status === 'rejected') throw dataResult.reason;
  if (totalResult.status === 'rejected') {
    return { response: dataResult.value, totalRows: null, pageCount: null, totalErr: totalResult.reason.message };
  }
  try {
    const totalRows = parseCountTotal(totalResult.value);
    return { response: dataResult.value, totalRows, pageCount: Math.max(1, Math.ceil(totalRows / options.pageSize)), totalErr: '' };
  } catch (error) {
    return { response: dataResult.value, totalRows: null, pageCount: null, totalErr: error.message };
  }
}

function pageResult(options) {
  const response = options.loaded.response;
  return {
    ...options.result,
    ok: true,
    columns: response.columns,
    types: response.types,
    rows: response.rows,
    elapsed: response.elapsed,
    fullSql: response.fullSql,
    isMasked: response.isMasked,
    page: options.page,
    pageSize: options.pageSize,
    totalRows: options.loaded.totalRows,
    pageCount: options.loaded.pageCount,
    hasNext: options.loaded.pageCount == null ? false : options.page < options.loaded.pageCount,
    dataLoading: false,
    dataErr: '',
    totalLoading: false,
    totalErr: options.loaded.totalErr,
  };
}

export async function fetchConsolePage(options) {
  const loaded = await fetchPageAndCount(options);
  if (loaded.pageCount != null && options.page > loaded.pageCount) {
    const page = loaded.pageCount;
    const lastPage = await fetchPageAndCount({ ...options, page });
    return pageResult({ result: options.result, loaded: lastPage, page, pageSize: options.pageSize });
  }
  return pageResult({ result: options.result, loaded, page: options.page, pageSize: options.pageSize });
}

export async function countConsoleRows(options) {
  const response = await options.api.query(options.origin, {
    ...options.result.context,
    sql: buildConsoleCountSql({ sql: options.result.sql, dbType: options.result.context.dbType }),
    limit: COUNT_QUERY_LIMIT,
  });
  return parseCountTotal(response);
}
