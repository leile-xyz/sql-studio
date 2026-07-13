import { isPostgresType, resourceContextKey } from './db-context.mjs';

const SQL_KEYWORDS = Object.freeze([
  'select', 'from', 'where', 'and', 'or', 'not', 'null', 'is', 'in', 'like', 'between', 'exists',
  'order by', 'group by', 'having', 'limit', 'offset', 'asc', 'desc', 'distinct',
  'join', 'left join', 'right join', 'inner join', 'outer join', 'on', 'as', 'union', 'union all',
  'insert into', 'values', 'update', 'set', 'delete from', 'case', 'when', 'then', 'else', 'end',
  'interval', 'show tables', 'show databases', 'describe', 'explain', 'true', 'false',
]);
const COMMON_SQL_FUNCTIONS = Object.freeze([
  'count', 'sum', 'avg', 'min', 'max', 'coalesce', 'nullif', 'concat', 'substring', 'trim',
  'lower', 'upper', 'length', 'char_length', 'replace', 'abs', 'round', 'ceil', 'floor', 'now',
]);
const MYSQL_SQL_FUNCTIONS = Object.freeze(COMMON_SQL_FUNCTIONS.concat([
  'ifnull', 'group_concat', 'date_format', 'str_to_date', 'from_unixtime', 'unix_timestamp',
  'datediff', 'date_add', 'date_sub',
]));
const POSTGRES_SQL_FUNCTIONS = Object.freeze(COMMON_SQL_FUNCTIONS.concat([
  'string_agg', 'array_agg', 'date_trunc', 'date_part', 'to_char', 'to_date', 'to_timestamp',
  'age', 'split_part',
]));
const HIGHLIGHT_KEYWORDS = 'CREATE|TABLE|NOT|NULL|DEFAULT|COMMENT|PRIMARY|KEY|ENGINE|AUTO_INCREMENT|CHARSET|COLLATE|SELECT|FROM|WHERE|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|AND|OR|LIKE|IN|IS|DESC|ASC|INSERT|INTO|VALUES|UPDATE|SET|DELETE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AS|COUNT|SUM|MAX|MIN|AVG|DISTINCT|UNION|ALL|SHOW|BETWEEN|CASE|WHEN|THEN|ELSE|END|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME';
const HIGHLIGHT_TYPES = 'bigint|tinyint|smallint|mediumint|varchar|int|datetime|decimal|numeric|text|longtext|mediumtext|timestamp|char|json|double|float|date|time|bit|blob|enum';
const HIGHLIGHT_KEYWORD_TOKEN = new RegExp('^(?:' + HIGHLIGHT_KEYWORDS + ')$', 'i');
const HIGHLIGHT_TYPE_TOKEN = new RegExp('^(?:' + HIGHLIGHT_TYPES + ')$', 'i');
const SQL_HIGHLIGHT_PATTERN = new RegExp([
  "'(?:''|\\\\.|[^'\\\\])*'",
  '`(?:``|[^`])*`',
  '"(?:""|[^"])*"',
  '--[^\\n]*',
  '#[^\\n]*',
  '/\\*[\\s\\S]*?\\*/',
  '\\b(?:' + HIGHLIGHT_KEYWORDS + ')\\b',
  '\\b(?:' + HIGHLIGHT_TYPES + ')\\b',
  '\\b\\d+(?:\\.\\d+)?\\b',
].join('|'), 'gi');
const MAX_ITEMS = 30;
const VIEWPORT_MARGIN_PX = 8;
const INPUT_POPUP_GAP_PX = 4;
const TEXTAREA_POPUP_OFFSET_PX = 2;
const POPUP_FLIP_GAP_PX = 6;
const DEFAULT_LINE_HEIGHT_PX = 20;
const MATCH_TIER = Object.freeze({
  EXACT: 0,
  LABEL_PREFIX: 1,
  TOKEN_PREFIX: 2,
  CONTAINS: 3,
  CROSS_WORD: 4,
});

const escapeHtml = value => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

function contiguousMatchRanges(lowerLabel, lowerQuery) {
  const ranges = [];
  let from = 0;
  while (from <= lowerLabel.length) {
    const i = lowerLabel.indexOf(lowerQuery, from);
    if (i < 0) break;
    ranges.push([i, i + lowerQuery.length]);
    from = i + lowerQuery.length;
  }
  return ranges;
}

function candidateTokens(label) {
  const tokens = [];
  let start = -1;
  for (let index = 0; index < label.length; index += 1) {
    const current = label[index];
    const wordCharacter = /[A-Za-z0-9$]/.test(current);
    if (!wordCharacter) {
      if (start >= 0) tokens.push({ text: label.slice(start, index).toLowerCase(), start });
      start = -1;
      continue;
    }
    const camelBoundary = start >= 0 && /[A-Z]/.test(current) && /[a-z0-9]/.test(label[index - 1]);
    if (camelBoundary) {
      tokens.push({ text: label.slice(start, index).toLowerCase(), start });
      start = index;
      continue;
    }
    if (start < 0) start = index;
  }
  if (start >= 0) tokens.push({ text: label.slice(start).toLowerCase(), start });
  return tokens;
}

function crossWordMatchFrom(tokens, query, start) {
  const failedStates = new Set();
  const visit = (tokenIndex, queryOffset, ranges) => {
    if (queryOffset === query.length) return ranges.length > 1 ? ranges : null;
    if (tokenIndex >= tokens.length) return null;
    const stateKey = tokenIndex + ':' + queryOffset;
    if (failedStates.has(stateKey)) return null;
    const token = tokens[tokenIndex];
    const maxLength = Math.min(token.text.length, query.length - queryOffset);
    for (let length = maxLength; length > 0; length -= 1) {
      const fragment = query.slice(queryOffset, queryOffset + length);
      if (!token.text.startsWith(fragment)) continue;
      const nextRanges = ranges.concat([[token.start, token.start + length]]);
      const match = visit(tokenIndex + 1, queryOffset + length, nextRanges);
      if (match) return match;
    }
    failedStates.add(stateKey);
    return null;
  };
  return visit(start, 0, []);
}

function crossWordMatchRanges(tokens, query) {
  if (query.length < 2) return null;
  for (let start = 0; start < tokens.length - 1; start += 1) {
    const ranges = crossWordMatchFrom(tokens, query, start);
    if (ranges) return ranges;
  }
  return null;
}

function candidateMatch(label, lowerQuery) {
  const text = String(label == null ? '' : label);
  const lowerLabel = text.toLowerCase();
  if (!lowerQuery) return null;
  if (lowerLabel === lowerQuery) {
    return { tier: MATCH_TIER.EXACT, start: 0, span: text.length, ranges: [[0, text.length]] };
  }
  const tokens = candidateTokens(text);
  const ranges = contiguousMatchRanges(lowerLabel, lowerQuery);
  if (ranges.length) {
    const prefixToken = tokens.find(token => token.text.startsWith(lowerQuery));
    const tier = lowerLabel.startsWith(lowerQuery)
      ? MATCH_TIER.LABEL_PREFIX
      : (prefixToken ? MATCH_TIER.TOKEN_PREFIX : MATCH_TIER.CONTAINS);
    const start = prefixToken ? prefixToken.start : ranges[0][0];
    return { tier, start, span: lowerQuery.length, ranges };
  }
  const crossRanges = crossWordMatchRanges(tokens, lowerQuery);
  if (!crossRanges) return null;
  const start = crossRanges[0][0];
  const end = crossRanges[crossRanges.length - 1][1];
  return { tier: MATCH_TIER.CROSS_WORD, start, span: end - start, ranges: crossRanges };
}

function compareCandidateRanks(left, right) {
  return left.match.tier - right.match.tier
    || left.match.start - right.match.start
    || left.match.span - right.match.span
    || left.label.length - right.label.length
    || left.index - right.index;
}

function rankCandidates(values, lowerQuery, getLabel) {
  return values
    .map((value, index) => {
      const label = String(getLabel(value));
      return { value, label, index, match: candidateMatch(label, lowerQuery) };
    })
    .filter(candidate => candidate.match)
    .sort(compareCandidateRanks)
    .map(candidate => candidate.value);
}

function sqlFunctionCatalog(dbType) {
  if (isPostgresType(dbType)) return POSTGRES_SQL_FUNCTIONS;
  if (String(dbType || '').trim().toLowerCase() === 'mysql') return MYSQL_SQL_FUNCTIONS;
  return COMMON_SQL_FUNCTIONS;
}

function sqlFunctionKind(dbType) {
  if (isPostgresType(dbType)) return 'PostgreSQL 函数';
  if (String(dbType || '').trim().toLowerCase() === 'mysql') return 'MySQL 函数';
  return 'SQL 函数';
}

/** 高亮连续包含或跨词命中片段（大小写不敏感），其余部分转义。 */
export function highlightMatch(label, lowerPrefix) {
  const text = String(label == null ? '' : label);
  const match = candidateMatch(text, lowerPrefix);
  if (!match) return escapeHtml(text);
  let html = '';
  let cursor = 0;
  for (const [start, end] of match.ranges) {
    html += escapeHtml(text.slice(cursor, start));
    html += '<mark class="ac-hl">' + escapeHtml(text.slice(start, end)) + '</mark>';
    cursor = end;
  }
  return html + escapeHtml(text.slice(cursor));
}

function highlightSqlToken(token) {
  if (token.startsWith("'")) return 'tk-str';
  if (token.startsWith('`') || token.startsWith('"')) return 'tk-id';
  if (token.startsWith('--') || token.startsWith('#') || token.startsWith('/*')) return 'tk-cmt';
  if (HIGHLIGHT_KEYWORD_TOKEN.test(token)) return 'tk-kw';
  if (HIGHLIGHT_TYPE_TOKEN.test(token)) return 'tk-type';
  return 'tk-num';
}

export function highlightSql(source) {
  const text = String(source == null ? '' : source);
  let html = '';
  let cursor = 0;
  for (const match of text.matchAll(SQL_HIGHLIGHT_PATTERN)) {
    const token = match[0];
    html += escapeHtml(text.slice(cursor, match.index));
    html += '<span class="' + highlightSqlToken(token) + '">' + escapeHtml(token) + '</span>';
    cursor = match.index + token.length;
  }
  return html + escapeHtml(text.slice(cursor));
}

function formatSqlStatement(sql) {
  const clauses = /\s*\b(FROM|WHERE|ORDER BY|GROUP BY|HAVING|LIMIT|LEFT JOIN|RIGHT JOIN|INNER JOIN|JOIN|UNION|AND|OR|SET|VALUES)\b/gi;
  const keywords = /\b(select|from|where|order by|group by|having|limit|offset|and|or|join|left join|right join|inner join|on|as|insert into|update|set|delete|values|union|distinct)\b/gi;
  return sql.replace(/\s+/g, ' ').trim()
    .replace(clauses, '\n$1')
    .replace(keywords, match => match.toUpperCase());
}

export function formatSql(source) {
  const text = String(source == null ? '' : source);
  const statements = scanSqlStatementRanges(text)
    .map(range => {
      const statement = text.slice(range.start, range.end).trim();
      if (!statement) return '';
      const terminator = range.end < text.length ? ';' : '';
      return formatSqlStatement(statement) + terminator;
    })
    .filter(Boolean);
  return statements.join('\n');
}

export function resolveSqlExecution(options) {
  const start = Number.isInteger(options.selectionStart) ? options.selectionStart : 0;
  const end = Number.isInteger(options.selectionEnd) ? options.selectionEnd : start;
  const selectedSql = end > start ? options.sql.slice(start, end) : '';
  if (selectedSql.trim()) return Object.freeze({ sql: selectedSql, selectionUsed: true });
  return Object.freeze({ sql: options.sql, selectionUsed: false });
}

function skipQuotedSqlToken(text, start) {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length) {
    const current = text[index];
    if (current === '\\' && index + 1 < text.length) {
      index += 2;
      continue;
    }
    if (current === quote && text[index + 1] === quote) {
      index += 2;
      continue;
    }
    if (current === quote) return index + 1;
    index += 1;
  }
  return text.length;
}

function skipSqlBlockComment(text, start) {
  let depth = 1;
  let index = start + 2;
  while (index < text.length && depth > 0) {
    if (text[index] === '/' && text[index + 1] === '*') { depth += 1; index += 2; continue; }
    if (text[index] === '*' && text[index + 1] === '/') { depth -= 1; index += 2; continue; }
    index += 1;
  }
  return index;
}

function sqlDollarQuoteTag(text, start) {
  const match = text.slice(start).match(/^\$(?:[A-Za-z_][\w$]*)?\$/);
  return match ? match[0] : '';
}

function skipSqlToken(text, index, dbType) {
  const current = text[index];
  const next = text[index + 1];
  if ((current === '-' && next === '-') || (current === '#' && !isPostgresType(dbType))) {
    const lineEnd = text.indexOf('\n', index);
    return lineEnd < 0 ? text.length : lineEnd;
  }
  if (current === '/' && next === '*') return skipSqlBlockComment(text, index);
  if (current === '\'' || current === '"' || current === '`') {
    return skipQuotedSqlToken(text, index);
  }
  if (current === '$' && isPostgresType(dbType)) {
    const tag = sqlDollarQuoteTag(text, index);
    if (!tag) return index;
    const close = text.indexOf(tag, index + tag.length);
    return close < 0 ? text.length : close + tag.length;
  }
  return index;
}

function scanSqlStatementRanges(text, dbType = '') {
  const ranges = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const nextIndex = skipSqlToken(text, index, dbType);
    if (nextIndex !== index) {
      index = nextIndex;
      continue;
    }
    if (text[index] === ';') {
      ranges.push(Object.freeze({ start, end: index }));
      start = index + 1;
    }
    index += 1;
  }
  ranges.push(Object.freeze({ start, end: text.length }));
  return Object.freeze(ranges);
}

function normalizeSqlCursor(text, cursorPosition) {
  if (!Number.isInteger(cursorPosition)) return 0;
  return Math.max(0, Math.min(cursorPosition, text.length));
}

function findSqlStatementRange(text, cursorPosition, dbType = '') {
  const cursor = normalizeSqlCursor(text, cursorPosition);
  return scanSqlStatementRanges(text, dbType)
    .find(candidate => cursor >= candidate.start && cursor <= candidate.end);
}

/**
 * 把一段 SQL 拆成可逐条执行的语句数组。
 * 分号仅在字符串、标识符与注释之外作为语句边界；空白语句会被丢弃。
 */
export function splitSql(source, options = {}) {
  const text = String(source == null ? '' : source);
  const statements = scanSqlStatementRanges(text, options.dbType)
    .map(range => text.slice(range.start, range.end).trim())
    .filter(Boolean);
  return Object.freeze(statements);
}

/**
 * 返回光标所在的完整 SQL 语句，保留光标后的 FROM/JOIN 供字段联想识别。
 */
export function extractSqlStatementAt(source, cursorPosition) {
  const text = String(source == null ? '' : source);
  const range = findSqlStatementRange(text, cursorPosition);
  return range ? text.slice(range.start, range.end).trim() : '';
}

const SQL_CONTEXT_IDENTIFIER = '<identifier>';
const SQL_WORD_START_PATTERN = /[A-Za-z_]/;
const SQL_WORD_PART_PATTERN = /[\w$]/;
const SQL_CONTEXT_CLAUSES = Object.freeze({
  select: Object.freeze({ mode: 'select-list', expectsTable: false, tableList: false }),
  from: Object.freeze({ mode: 'table', expectsTable: true, tableList: true }),
  join: Object.freeze({ mode: 'table', expectsTable: true, tableList: false }),
  update: Object.freeze({ mode: 'table', expectsTable: true, tableList: false }),
  into: Object.freeze({ mode: 'table', expectsTable: true, tableList: false }),
  where: Object.freeze({ mode: 'field', expectsTable: false, tableList: false }),
  on: Object.freeze({ mode: 'field', expectsTable: false, tableList: false }),
  having: Object.freeze({ mode: 'field', expectsTable: false, tableList: false }),
  set: Object.freeze({ mode: 'field', expectsTable: false, tableList: false }),
  group: Object.freeze({ mode: 'other', expectsTable: false, tableList: false }),
  order: Object.freeze({ mode: 'other', expectsTable: false, tableList: false }),
  limit: Object.freeze({ mode: 'other', expectsTable: false, tableList: false }),
  values: Object.freeze({ mode: 'other', expectsTable: false, tableList: false }),
});

function tokenizeSqlContext(source) {
  const text = String(source == null ? '' : source);
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const current = text[index];
    if (current === '`') {
      const end = skipQuotedSqlToken(text, index);
      if (end > index + 1 && text[end - 1] === '`') tokens.push(SQL_CONTEXT_IDENTIFIER);
      index = end;
      continue;
    }
    const skipped = skipSqlToken(text, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    if (SQL_WORD_START_PATTERN.test(current)) {
      let end = index + 1;
      while (end < text.length && SQL_WORD_PART_PATTERN.test(text[end])) end += 1;
      tokens.push(text.slice(index, end).toLowerCase());
      index = end;
      continue;
    }
    if ('(),.'.includes(current)) tokens.push(current);
    index += 1;
  }
  return Object.freeze(tokens);
}

function resolveClauseContext(token, previous) {
  if (token === 'by' && (previous === 'group' || previous === 'order')) {
    return { mode: 'field', expectsTable: false, tableList: false };
  }
  return SQL_CONTEXT_CLAUSES[token] || null;
}

function advanceSqlCompletionState(state, token) {
  const clause = resolveClauseContext(token, state.previous);
  if (clause) return { ...clause, canQualifyTable: false, previous: token };
  if (token === ',' && state.tableList) {
    return { ...state, mode: 'table', expectsTable: true, canQualifyTable: false, previous: token };
  }
  if (token === '.' && state.canQualifyTable) {
    return { ...state, mode: 'table', expectsTable: true, canQualifyTable: false, previous: token };
  }
  if (state.expectsTable) {
    return { ...state, mode: 'other', expectsTable: false, canQualifyTable: true, previous: token };
  }
  return { ...state, canQualifyTable: false, previous: token };
}

function classifySqlCompletionContext(tokens) {
  let state = { mode: 'other', expectsTable: false, tableList: false, canQualifyTable: false, previous: '' };
  let stack = [];
  for (const token of tokens) {
    if (token === '(') {
      stack = stack.concat([state]);
      continue;
    }
    if (token === ')') {
      const restored = stack.length ? stack[stack.length - 1] : state;
      stack = stack.slice(0, -1);
      state = restored.expectsTable
        ? { ...restored, mode: 'other', expectsTable: false, canQualifyTable: false, previous: token }
        : { ...restored, previous: token };
      continue;
    }
    state = advanceSqlCompletionState(state, token);
  }
  return state.expectsTable ? 'table' : state.mode;
}

/**
 * 根据当前语句中光标前的 SQL 结构，判断联想应优先字段、表或沿用默认顺序。
 */
export function detectSqlCompletionContext(source, cursorPosition, prefixLength = 0) {
  const text = String(source == null ? '' : source);
  const cursor = normalizeSqlCursor(text, cursorPosition);
  const range = findSqlStatementRange(text, cursor);
  if (!range) return 'other';
  const safePrefixLength = Number.isInteger(prefixLength) ? Math.max(0, prefixLength) : 0;
  const prefixStart = Math.max(range.start, cursor - safePrefixLength);
  return classifySqlCompletionContext(tokenizeSqlContext(text.slice(range.start, prefixStart)));
}

/**
 * 从 SQL 中提取 SELECT 涉及的表名，用于字段联想。
 * 匹配 FROM / JOIN / UPDATE / INTO 后的表名，支持反引号标识符与 `schema.table` 形式（取末段表名）。
 * 跳过其后紧跟子查询关键字（SELECT/`( 等）的情况，避免把子查询误当表名。
 * 返回只读数组。供 sql-editor 内部使用，亦导出供单测。
 */
const TABLE_REF_PATTERN = /\b(?:from|join|update|into)\s+(?:(?:`([^`]+)`|"([^"]+)"|([A-Za-z_][\w$]*))\s*\.\s*)?(?:`([^`]+)`|"([^"]+)"|([A-Za-z_][\w$]*))/gi;

export function extractReferencedTableRefs(source) {
  const text = String(source == null ? '' : source);
  const references = new Map();
  let match;
  while ((match = TABLE_REF_PATTERN.exec(text))) {
    const schema = match[1] || match[2] || match[3] || '';
    const table = match[4] || match[5] || match[6];
    const key = schema + '\u001f' + table;
    if (!references.has(key)) references.set(key, Object.freeze({ schema, table }));
  }
  return Object.freeze([...references.values()]);
}

export function extractReferencedTables(source) {
  const tables = new Set();
  for (const reference of extractReferencedTableRefs(source)) tables.add(reference.table);
  return Object.freeze([...tables]);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keywordReplacementStart(beforeCursor, keyword, fallbackFrom) {
  for (let length = keyword.length; length > 0; length -= 1) {
    const keywordPrefix = keyword.slice(0, length);
    if (keywordPrefix.endsWith(' ')) continue;
    const pattern = keywordPrefix.split(' ').map(escapeRegExp).join('\\s+');
    const match = new RegExp('(?:^|[^\\w$])(' + pattern + ')$', 'i').exec(beforeCursor);
    if (match) return beforeCursor.length - match[1].length;
  }
  return fallbackFrom;
}

function isExactKeywordItem(item, beforeCursor, fallbackFrom) {
  const from = Number.isInteger(item.replaceFrom) ? item.replaceFrom : fallbackFrom;
  const typedText = beforeCursor.slice(from).trim().replace(/\s+/g, ' ').toLowerCase();
  return item.label.toLowerCase() === typedText;
}

export class SqlAutocomplete {
  constructor(options) {
    this.api = options.api;
    this.getContext = options.getContext;
    this.onEditorChange = options.onEditorChange;
    this.onWhereChange = options.onWhereChange;
    this.onError = options.onError;
    this.tables = new Map();
    this.columns = new Map();
    this.state = { open: false, items: [], selected: 0, from: 0, textarea: null };
    this.sequence = 0;
    this.measure = null;
  }

  isOpenFor(target) {
    return this.state.open && this.state.textarea === target;
  }

  popup() {
    let popup = document.getElementById('acPop');
    if (popup) return popup;
    popup = document.createElement('div');
    popup.id = 'acPop';
    document.body.appendChild(popup);
    popup.addEventListener('mousedown', event => {
      event.preventDefault();
      const item = event.target.closest('.ac-item');
      if (item) this.accept(Number(item.dataset.i));
    });
    return popup;
  }

  hide() {
    this.state.open = false;
    const popup = document.getElementById('acPop');
    if (popup) popup.classList.remove('show');
  }

  update(textarea) {
    const context = this.getContext();
    const isWhere = textarea.dataset && textarea.dataset.act === 'where-input';
    if (!this.isValidTarget(context, textarea, isWhere)) return this.hide();
    const position = textarea.selectionStart;
    const before = textarea.value.slice(0, position);
    const prefixMatch = /[A-Za-z_][\w$]*$/.exec(before);
    if (!prefixMatch) return this.hide();
    const prefix = prefixMatch[0];
    const sequence = ++this.sequence;
    const refresh = () => {
      if (sequence === this.sequence && document.activeElement === textarea) this.update(textarea);
    };
    const items = this.collectItems({ context, textarea, isWhere, prefix, refresh });
    if (!items.length) return this.hide();
    this.state = {
      open: true,
      items: items.slice(0, MAX_ITEMS),
      selected: 0,
      from: position - prefix.length,
      prefix: prefix.toLowerCase(),
      textarea,
    };
    this.render();
    this.place(textarea, before, prefix);
  }

  isValidTarget(context, textarea, isWhere) {
    if (!context || document.activeElement !== textarea) return false;
    return isWhere ? context.type === 'table' : context.type === 'console';
  }

  collectItems(options) {
    const lowerPrefix = options.prefix.toLowerCase();
    const position = Number.isInteger(options.textarea.selectionStart)
      ? options.textarea.selectionStart
      : options.prefix.length;
    const beforeCursor = typeof options.textarea.value === 'string'
      ? options.textarea.value.slice(0, position)
      : options.prefix;
    const fallbackFrom = Math.max(0, beforeCursor.length - options.prefix.length);
    const functionItems = this.collectFunctionItems(options.context, options.prefix, lowerPrefix);
    const items = options.isWhere
      ? this.collectWhereItems(options.context, lowerPrefix).concat(functionItems)
      : this.collectConsoleItems({
        context: options.context,
        sql: extractSqlStatementAt(options.textarea.value, options.textarea.selectionStart),
        lowerPrefix,
        refresh: options.refresh,
        functionItems,
        completionContext: detectSqlCompletionContext(
          options.textarea.value,
          options.textarea.selectionStart,
          options.prefix.length,
        ),
      });
    const keywordItems = this.collectKeywordItems(options.prefix, lowerPrefix, beforeCursor);
    const exactKeywords = keywordItems.filter(item => isExactKeywordItem(item, beforeCursor, fallbackFrom));
    const partialKeywords = keywordItems.filter(item => !isExactKeywordItem(item, beforeCursor, fallbackFrom));
    const exactItems = items.filter(item => item.label.toLowerCase() === lowerPrefix);
    const partialItems = items.filter(item => item.label.toLowerCase() !== lowerPrefix);
    return exactKeywords.concat(exactItems, partialItems, partialKeywords);
  }

  collectWhereItems(context, lowerPrefix) {
    const columns = context.meta ? context.meta.columns : [];
    const items = rankCandidates(columns, lowerPrefix, column => column.name)
      .map(column => ({
        label: column.name,
        insert: column.name,
        kind: column.type + (column.comment ? ' · ' + column.comment : ''),
      }));
    const exactItems = items.filter(item => item.label.toLowerCase() === lowerPrefix);
    const partialItems = items.filter(item => item.label.toLowerCase() !== lowerPrefix);
    return exactItems.concat(partialItems);
  }

  collectConsoleItems(options) {
    const { context, sql, lowerPrefix, refresh, functionItems, completionContext } = options;
    if (!context.instance || !context.db) return [];
    const excludedTable = completionContext === 'table' ? lowerPrefix : '';
    const columns = this.collectColumnItems({ context, sql, lowerPrefix, refresh, excludedTable });
    const allColumnsItem = completionContext === 'select-list'
      ? this.collectAllColumnsItem(context, sql)
      : null;
    const exactColumns = columns.filter(column => column.label.toLowerCase() === lowerPrefix);
    const partialColumns = columns.filter(column => column.label.toLowerCase() !== lowerPrefix);
    // 全字段仅低于完全匹配字段，高于其余包含匹配字段。
    const fieldItems = allColumnsItem
      ? exactColumns.concat([allColumnsItem], partialColumns)
      : columns;
    const tableItems = this.collectTableItems(context, lowerPrefix, refresh);
    return completionContext === 'table'
      ? tableItems.concat(fieldItems)
      : fieldItems.concat(functionItems, tableItems);
  }

  collectTableItems(context, lowerPrefix, refresh) {
    const tableKey = resourceContextKey({
      origin: context.origin,
      instance: context.instance,
      db: context.db,
      schema: context.schema,
    });
    if (!this.tables.has(tableKey)) {
      this.ensureTables(context, refresh);
      return [];
    }
    return rankCandidates(this.tables.get(tableKey), lowerPrefix, table => table)
      .map(table => ({ label: table, insert: table, kind: 'table' }));
  }

  collectColumnItems(options) {
    const { context, sql, lowerPrefix, refresh, excludedTable } = options;
    const items = [];
    for (const reference of this.referencedTableRefs(sql)) {
      if (excludedTable && reference.table.toLowerCase() === excludedTable) continue;
      const schema = reference.schema || context.schema || '';
      const key = resourceContextKey({
        origin: context.origin,
        instance: context.instance,
        db: context.db,
        schema,
        table: reference.table,
      });
      if (!this.columns.has(key)) {
        this.ensureColumns(context, { schema, table: reference.table }, refresh);
        continue;
      }
      for (const column of this.columns.get(key)) {
        const source = schema ? schema + '.' + reference.table : reference.table;
        items.push({ label: column.name, insert: column.name, kind: source + ' · ' + column.type });
      }
    }
    return rankCandidates(items, lowerPrefix, item => item.label);
  }

  /** 「全部字段」候选：单表且字段已加载时，生成一条 insert 为全字段逗号串的候选。 */
  collectAllColumnsItem(context, sql) {
    const references = this.referencedTableRefs(sql);
    if (references.length !== 1) return null;
    const reference = references[0];
    const schema = reference.schema || context.schema || '';
    const key = resourceContextKey({
      origin: context.origin,
      instance: context.instance,
      db: context.db,
      schema,
      table: reference.table,
    });
    const columns = this.columns.get(key);
    if (!columns || !columns.length) return null;
    const names = columns.map(column => column.name);
    const insert = names.join(', ');
    const source = schema ? schema + '.' + reference.table : reference.table;
    return { label: insert, insert, kind: source + ' · 全部 ' + names.length + ' 列', allColumns: true };
  }

  collectKeywordItems(prefix, lowerPrefix, beforeCursor) {
    const upperCase = /[A-Z]/.test(prefix) && prefix === prefix.toUpperCase();
    const fallbackFrom = Math.max(0, beforeCursor.length - prefix.length);
    return rankCandidates(SQL_KEYWORDS, lowerPrefix, keyword => keyword)
      .map(keyword => {
        const value = upperCase ? keyword.toUpperCase() : keyword;
        const item = { label: value, insert: value, kind: 'keyword' };
        const replaceFrom = keywordReplacementStart(beforeCursor, keyword, fallbackFrom);
        if (replaceFrom !== fallbackFrom) item.replaceFrom = replaceFrom;
        return item;
      });
  }

  collectFunctionItems(context, prefix, lowerPrefix) {
    const upperCase = /[A-Z]/.test(prefix) && prefix === prefix.toUpperCase();
    const kind = sqlFunctionKind(context.dbType);
    return rankCandidates(sqlFunctionCatalog(context.dbType), lowerPrefix, name => name)
      .map(name => {
        const value = upperCase ? name.toUpperCase() : name;
        return { label: value, insert: value, kind };
      });
  }

  async ensureTables(context, refresh) {
    const key = resourceContextKey({
      origin: context.origin,
      instance: context.instance,
      db: context.db,
      schema: context.schema,
    });
    this.tables.set(key, []);
    try {
      this.tables.set(key, await this.api.tables(context.origin, {
        instance: context.instance,
        db: context.db,
        schema: context.schema || '',
      }));
      refresh();
    } catch (error) {
      this.tables.delete(key);
      this.onError('加载 SQL 联想表列表失败', error);
    }
  }

  async ensureColumns(context, reference, refresh) {
    const key = resourceContextKey({
      origin: context.origin,
      instance: context.instance,
      db: context.db,
      schema: reference.schema,
      table: reference.table,
    });
    this.columns.set(key, []);
    try {
      const metadata = await this.api.describe(context.origin, {
        instance: context.instance,
        db: context.db,
        schema: reference.schema,
        table: reference.table,
      });
      this.columns.set(key, metadata.columns.map(column => ({ name: column.name, type: column.type })));
      refresh();
    } catch (error) {
      this.columns.delete(key);
      this.onError('加载 SQL 联想字段失败', error);
    }
  }

  referencedTableRefs(sql) {
    return extractReferencedTableRefs(sql);
  }

  render() {
    const popup = this.popup();
    const prefix = this.state.prefix || '';
    popup.innerHTML = this.state.items.map((item, index) => {
      const label = `<span class="ac-label">${highlightMatch(item.label, prefix)}</span>`;
      const kind = `<span class="ac-kind">${escapeHtml(item.kind)}</span>`;
      const badge = item.allColumns ? '<span class="ac-all">✦</span> ' : '';
      return `<div class="ac-item ${index === this.state.selected ? 'sel' : ''}" data-i="${index}">${badge}${label}${kind}</div>`;
    }).join('');
    popup.classList.add('show');
    const selected = popup.children[this.state.selected];
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  }

  place(textarea, before, prefix) {
    const popup = this.popup();
    const style = getComputedStyle(textarea);
    if (!this.measure) this.measure = document.createElement('canvas').getContext('2d');
    this.measure.font = style.fontSize + ' ' + style.fontFamily;
    const lineStart = before.lastIndexOf('\n') + 1;
    const columnText = before.slice(lineStart, before.length - prefix.length);
    const line = (before.match(/\n/g) || []).length;
    const lineHeight = parseFloat(style.lineHeight) || DEFAULT_LINE_HEIGHT_PX;
    const rect = textarea.getBoundingClientRect();
    const x = rect.left + parseFloat(style.paddingLeft) + this.measure.measureText(columnText).width - textarea.scrollLeft;
    let y = textarea.tagName === 'INPUT'
      ? rect.bottom + INPUT_POPUP_GAP_PX
      : rect.top + parseFloat(style.paddingTop) + (line + 1) * lineHeight - textarea.scrollTop + TEXTAREA_POPUP_OFFSET_PX;
    if (y + popup.offsetHeight > window.innerHeight - VIEWPORT_MARGIN_PX) y = rect.top - popup.offsetHeight - POPUP_FLIP_GAP_PX;
    popup.style.left = Math.max(VIEWPORT_MARGIN_PX, Math.min(x, window.innerWidth - popup.offsetWidth - VIEWPORT_MARGIN_PX)) + 'px';
    popup.style.top = y + 'px';
  }

  accept(index = this.state.selected) {
    const item = this.state.items[index];
    const textarea = this.state.textarea;
    this.hide();
    if (!item || !textarea) return;
    const from = Number.isInteger(item.replaceFrom) ? item.replaceFrom : this.state.from;
    textarea.setRangeText(item.insert, from, textarea.selectionStart, 'end');
    if (textarea.dataset.act === 'ed-input') this.onEditorChange(textarea);
    if (textarea.dataset.act === 'where-input') this.onWhereChange(textarea.value);
    textarea.focus();
  }

  onKeydown(event) {
    if (!this.state.open) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') return this.moveSelection(event);
    if ((event.key === 'Enter' && !event.ctrlKey) || event.key === 'Tab') {
      event.preventDefault();
      this.accept();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.hide();
    }
  }

  moveSelection(event) {
    event.preventDefault();
    const offset = event.key === 'ArrowDown' ? 1 : this.state.items.length - 1;
    this.state.selected = (this.state.selected + offset) % this.state.items.length;
    this.render();
  }
}
