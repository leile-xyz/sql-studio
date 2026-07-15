export const MAX_QUERY_ROWS = 1_000;

export function validateQueryLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_QUERY_ROWS) {
    throw new Error(`查询行数限制必须是 1 到 ${MAX_QUERY_ROWS} 之间的安全整数`);
  }
  return limit;
}

export function capQueryRowCount(totalRows) {
  if (!Number.isSafeInteger(totalRows) || totalRows < 0) {
    throw new Error('查询总行数必须是非负安全整数');
  }
  return Math.min(totalRows, MAX_QUERY_ROWS);
}

export function hasQueryRowCount(totalRows) {
  return Number.isSafeInteger(totalRows)
    && totalRows >= 0
    && totalRows <= MAX_QUERY_ROWS;
}

export function queryPageWindow(options) {
  const page = options && options.page;
  const pageSize = validateQueryLimit(options && options.pageSize);
  if (!Number.isSafeInteger(page) || page <= 0) throw new Error('page 必须是正安全整数');
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset) || offset >= MAX_QUERY_ROWS) {
    throw new Error(`分页范围不能超过前 ${MAX_QUERY_ROWS} 条数据`);
  }
  return Object.freeze({
    page,
    pageSize,
    offset,
    limit: Math.min(pageSize, MAX_QUERY_ROWS - offset),
  });
}

export function maxQueryPage(pageSize) {
  return Math.ceil(MAX_QUERY_ROWS / validateQueryLimit(pageSize));
}

export function cappedQueryPage(options) {
  const page = options && options.page;
  if (!Number.isSafeInteger(page) || page <= 0) throw new Error('page 必须是正安全整数');
  return Math.min(page, maxQueryPage(options.pageSize));
}

export function validateQueryRows(rows, limit = MAX_QUERY_ROWS) {
  const rowLimit = validateQueryLimit(limit);
  if (!Array.isArray(rows)) throw new Error('查询结果 rows 必须是数组');
  if (rows.length > rowLimit) {
    throw new Error(`查询返回 ${rows.length} 条数据，超过本次请求上限 ${rowLimit} 条`);
  }
  return rows;
}
