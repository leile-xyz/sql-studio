const POSTGRES_TYPES = Object.freeze(['pgsql', 'postgres', 'postgresql']);

export function isPostgresType(dbType) {
  return POSTGRES_TYPES.includes(String(dbType || '').trim().toLowerCase());
}

export function findDbType(instances, instanceName) {
  const match = (instances || []).find(instance => instance.instance_name === instanceName);
  return match ? match.db_type || '' : '';
}

export function quoteIdentifier(identifier, dbType) {
  const value = String(identifier == null ? '' : identifier);
  if (isPostgresType(dbType)) return '"' + value.replace(/"/g, '""') + '"';
  return '`' + value.replace(/`/g, '``') + '`';
}

export function qualifiedTableName(options) {
  const table = quoteIdentifier(options.table, options.dbType);
  if (!isPostgresType(options.dbType) || !options.schema) return table;
  return quoteIdentifier(options.schema, options.dbType) + '.' + table;
}

export function buildBrowseSql(options) {
  let sql = 'SELECT * FROM ' + qualifiedTableName(options);
  if (String(options.where || '').trim()) sql += ' WHERE ' + String(options.where).trim();
  if (Array.isArray(options.orderBy) && options.orderBy.length) {
    sql += ' ORDER BY ' + options.orderBy
      .map(order => quoteIdentifier(order.col, options.dbType) + ' ' + String(order.dir).toUpperCase())
      .join(', ');
  }
  const offset = (options.page - 1) * options.pageSize;
  if (isPostgresType(options.dbType)) return sql + ' OFFSET ' + offset;
  return sql + ' LIMIT ' + options.pageSize + ' OFFSET ' + offset;
}

export function buildCountSql(options) {
  let sql = 'SELECT COUNT(*) AS total FROM ' + qualifiedTableName(options);
  const where = String(options.where || '').trim();
  if (where) sql += ' WHERE ' + where;
  return sql;
}

export function parseCountTotal(result) {
  const rows = result && result.rows;
  const raw = Array.isArray(rows) && Array.isArray(rows[0]) ? rows[0][0] : undefined;
  const text = typeof raw === 'string' ? raw.trim() : '';
  const total = typeof raw === 'number'
    ? raw
    : (/^\d+$/.test(text) ? Number(text) : Number.NaN);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error('COUNT(*) 未返回有效的非负安全整数');
  }
  return total;
}

export function buildTableConsoleSql(options) {
  const paginationPattern = isPostgresType(options.dbType)
    ? / OFFSET \d+$/
    : / LIMIT \d+ OFFSET \d+$/;
  return buildBrowseSql(options).replace(paginationPattern, '') + ' LIMIT 100';
}

export function resourceContextKey(options) {
  return [
    options.origin || '',
    options.instance || '',
    options.db || '',
    options.schema || '',
    options.table || '',
  ].join('\u001f');
}
