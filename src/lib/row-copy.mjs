import { isPostgresType, quoteIdentifier } from './db-context.mjs';

const JSON_INDENT = 2;
const HEX_RADIX = 16;
const HEX_BYTE_WIDTH = 2;

export const ROW_COPY_FORMATS = Object.freeze([
  Object.freeze({ id: 'json', label: 'JSON' }),
  Object.freeze({ id: 'insert', label: 'INSERT' }),
  Object.freeze({ id: 'csv', label: 'CSV' }),
  Object.freeze({ id: 'tsv', label: 'TSV' }),
]);

function validateRow(columns, row) {
  if (!Array.isArray(columns) || !columns.length || columns.some(name => typeof name !== 'string')) {
    throw new Error('复制失败：结果列名无效');
  }
  if (!Array.isArray(row) || row.length !== columns.length || row.some(value => value === undefined)) {
    throw new Error('复制失败：行数据与结果列不一致');
  }
}

function requireUniqueColumns(columns, format) {
  if (new Set(columns).size !== columns.length) {
    throw new Error(format + ' 无法使用重复列名，请为查询列设置不同别名，或复制为 CSV / TSV');
  }
}

function delimitedCell(value, delimiter) {
  const text = value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const needsQuotes = text.includes(delimiter) || /["\r\n]/.test(text);
  return needsQuotes ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function delimitedRows(options, delimiter) {
  const values = options.includeHeaders === false ? options.rows : [options.columns, ...options.rows];
  return values
    .map(values => values.map(value => delimitedCell(value, delimiter)).join(delimiter))
    .join('\r\n');
}

function rowRecord(columns, row) {
  return Object.fromEntries(columns.map((name, index) => [name, row[index]]));
}

function sqlString(value, dbType) {
  if (isPostgresType(dbType)) {
    if (value.includes('\0')) throw new Error('PostgreSQL 文本不能包含 NUL 字符');
    const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "''");
    return "E'" + escaped + "'";
  }
  // 十六进制编码使反斜杠与 NUL 不受 MySQL NO_BACKSLASH_ESCAPES 模式影响。
  if (/[\\\0]/.test(value)) {
    const bytes = new TextEncoder().encode(value);
    const hex = Array.from(bytes, byte => byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, '0')).join('');
    return "CONVERT(X'" + hex + "' USING utf8mb4)";
  }
  return "'" + value.replace(/'/g, "''") + "'";
}

function sqlValue(value, dbType) {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('INSERT 不支持非有限数值');
    return String(value);
  }
  if (typeof value === 'string') return sqlString(value, dbType);
  if (typeof value === 'object') return sqlString(JSON.stringify(value), dbType);
  throw new Error('INSERT 不支持该数据类型：' + typeof value);
}

function insertRow(options) {
  requireUniqueColumns(options.columns, 'INSERT');
  const target = options.target;
  if (!target || typeof target.table !== 'string' || !target.table.trim()) {
    throw new Error('请填写 INSERT 的目标表名');
  }
  const names = [target.namespace, target.table].filter(name => name !== '' && name != null);
  const table = names.map(name => quoteIdentifier(name, options.dbType)).join('.');
  const columns = options.columns.map(name => quoteIdentifier(name, options.dbType)).join(', ');
  const values = options.row.map(value => sqlValue(value, options.dbType)).join(', ');
  return 'INSERT INTO ' + table + ' (' + columns + ') VALUES (' + values + ');';
}

export function serializeRow(options) {
  validateRow(options.columns, options.row);
  if (options.format === 'json') {
    requireUniqueColumns(options.columns, 'JSON');
    return JSON.stringify(rowRecord(options.columns, options.row), null, JSON_INDENT);
  }
  if (options.format === 'insert') return insertRow(options);
  if (options.format === 'csv') return delimitedRows({ ...options, rows: [options.row] }, ',');
  if (options.format === 'tsv') return delimitedRows({ ...options, rows: [options.row] }, '\t');
  throw new Error('不支持的复制格式：' + options.format);
}

export function serializeRows(options) {
  if (!Array.isArray(options.rows) || !options.rows.length) throw new Error('复制失败：没有选中的数据行');
  options.rows.forEach(row => validateRow(options.columns, row));
  if (options.rows.length === 1) return serializeRow({ ...options, row: options.rows[0] });
  if (options.format === 'json') {
    requireUniqueColumns(options.columns, 'JSON');
    return JSON.stringify(options.rows.map(row => rowRecord(options.columns, row)), null, JSON_INDENT);
  }
  if (options.format === 'insert') return options.rows.map(row => insertRow({ ...options, row })).join('\r\n');
  if (options.format === 'csv') return delimitedRows(options, ',');
  if (options.format === 'tsv') return delimitedRows(options, '\t');
  throw new Error('不支持的复制格式：' + options.format);
}
