import { isPostgresType } from './db-context.mjs';
import { MAX_QUERY_ROWS, queryPageWindow } from './query-row-limit.mjs';

export const DEFAULT_CONSOLE_PAGE_SIZE = 100;
export const PAGE_SIZE_OPTIONS = Object.freeze([20, 50, 100, 200, 500, 1000]);

const MAIN_STATEMENT_KEYWORDS = Object.freeze(new Set([
  'select', 'insert', 'update', 'delete', 'merge',
]));
const PAGINATION_KEYWORDS = Object.freeze(new Set(['limit', 'offset', 'fetch']));
const MUTATION_KEYWORDS = Object.freeze(new Set(['insert', 'update', 'delete', 'merge']));
const UNSAFE_SELECT_KEYWORDS = Object.freeze(new Set(['into', 'for', 'lock']));

function skipQuotedToken(sql, start) {
  const quote = sql[start];
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === '\\' && index + 1 < sql.length) {
      index += 2;
      continue;
    }
    if (sql[index] === quote && sql[index + 1] === quote) {
      index += 2;
      continue;
    }
    if (sql[index] === quote) return index + 1;
    index += 1;
  }
  return sql.length;
}

function skipBlockComment(sql, start) {
  let depth = 1;
  let index = start + 2;
  while (index < sql.length && depth > 0) {
    if (sql[index] === '/' && sql[index + 1] === '*') {
      depth += 1;
      index += 2;
      continue;
    }
    if (sql[index] === '*' && sql[index + 1] === '/') {
      depth -= 1;
      index += 2;
      continue;
    }
    index += 1;
  }
  return index;
}

function dollarQuoteTag(sql, start) {
  const match = sql.slice(start).match(/^\$(?:[A-Za-z_][\w$]*)?\$/);
  return match ? match[0] : '';
}

function skipIgnoredToken(sql, index, dbType) {
  const current = sql[index];
  const next = sql[index + 1];
  if (current === '-' && next === '-') {
    const lineEnd = sql.indexOf('\n', index + 2);
    return lineEnd < 0 ? sql.length : lineEnd + 1;
  }
  if (current === '#' && !isPostgresType(dbType)) {
    const lineEnd = sql.indexOf('\n', index + 1);
    return lineEnd < 0 ? sql.length : lineEnd + 1;
  }
  if (current === '/' && next === '*') return skipBlockComment(sql, index);
  if (current === '\'' || current === '"' || current === '`') return skipQuotedToken(sql, index);
  if (current !== '$') return index;
  const tag = dollarQuoteTag(sql, index);
  if (!tag) return index;
  const close = sql.indexOf(tag, index + tag.length);
  return close < 0 ? sql.length : close + tag.length;
}

function sqlWordTokens(source, dbType) {
  const sql = String(source == null ? '' : source);
  const words = [];
  let depth = 0;
  let index = 0;
  while (index < sql.length) {
    const nextIndex = skipIgnoredToken(sql, index, dbType);
    if (nextIndex !== index) {
      index = nextIndex;
      continue;
    }
    if (sql[index] === '(') {
      depth += 1;
      index += 1;
      continue;
    }
    if (sql[index] === ')') {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    const match = sql.slice(index).match(/^[A-Za-z_][\w$]*/);
    if (!match) {
      index += 1;
      continue;
    }
    words.push(Object.freeze({ word: match[0].toLowerCase(), depth }));
    index += match[0].length;
  }
  return Object.freeze(words);
}

function mainStatementType(words) {
  const topLevel = words.filter(token => token.depth === 0).map(token => token.word);
  if (!topLevel.length) return '';
  if (topLevel[0] !== 'with') return topLevel[0];
  return topLevel.slice(1).find(word => MAIN_STATEMENT_KEYWORDS.has(word)) || '';
}

function normalizedSql(source) {
  const sql = String(source == null ? '' : source).trim().replace(/;\s*$/, '').trim();
  if (!sql) throw new Error('SQL 不能为空');
  return sql;
}

export function isPageableConsoleSql(source, dbType = '') {
  const tokens = sqlWordTokens(source, dbType);
  const topLevelWords = tokens.filter(token => token.depth === 0).map(token => token.word);
  const hasMutation = tokens.some(token => MUTATION_KEYWORDS.has(token.word));
  const hasUnsafeClause = topLevelWords.some(word => UNSAFE_SELECT_KEYWORDS.has(word));
  const hasPagination = topLevelWords.some(word => PAGINATION_KEYWORDS.has(word));
  return mainStatementType(tokens) === 'select' && !hasMutation && !hasUnsafeClause && !hasPagination;
}

export function buildConsolePageSql(options) {
  const sql = normalizedSql(options && options.sql);
  if (!isPageableConsoleSql(sql, options.dbType)) throw new Error('仅支持为安全且无顶层分页参数的 SELECT 构造分页 SQL');
  const window = queryPageWindow(options);
  return sql + '\nLIMIT ' + window.limit + ' OFFSET ' + window.offset;
}

export function buildConsoleCountSql(options) {
  const sql = normalizedSql(options && options.sql);
  if (!isPageableConsoleSql(sql, options.dbType)) throw new Error('仅支持为安全且无顶层分页参数的 SELECT 构造 COUNT SQL');
  return 'SELECT COUNT(*) AS total\nFROM (\n' + sql + '\nLIMIT ' + MAX_QUERY_ROWS + '\n) AS sql_studio_count';
}
