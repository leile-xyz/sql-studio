import assert from 'node:assert/strict';
import { buildCsv } from '../src/lib/csv.mjs';
import {
  buildConsoleCountSql,
  buildConsolePageSql,
  DEFAULT_CONSOLE_PAGE_SIZE,
  isPageableConsoleSql,
  PAGE_SIZE_OPTIONS,
} from '../src/lib/console-query.mjs';
import { parseTableDescription } from '../src/lib/ddl.js';
import { collectPagedRows } from '../src/lib/paged-export.mjs';
import { renderTableView, resolveTableSubview } from '../src/lib/table-view.mjs';
import {
  detectSqlCompletionContext,
  extractReferencedTables,
  extractReferencedTableRefs,
  extractSqlStatementAt,
  formatSql,
  highlightMatch,
  highlightSql,
  resolveSqlExecution,
  splitSql,
  SqlAutocomplete,
} from '../src/lib/sql-editor.mjs';
import {
  buildBrowseSql,
  buildTableConsoleSql,
  isPostgresType,
  qualifiedTableName,
  quoteIdentifier,
  resourceContextKey,
} from '../src/lib/db-context.mjs';

const FULL_SQL = 'SELECT 1;\nSELECT * FROM t_user;';
const SELECTED_SQL = 'SELECT * FROM t_user;';
const autocompleteKey = options => resourceContextKey({ instance: 'inst', db: 'db', ...options });

function testExecutionResolution() {
  assert.deepEqual(resolveSqlExecution({ sql: FULL_SQL, selectionStart: 0, selectionEnd: 0 }), {
    sql: FULL_SQL,
    selectionUsed: false,
  });
  const start = FULL_SQL.indexOf(SELECTED_SQL);
  assert.deepEqual(resolveSqlExecution({ sql: FULL_SQL, selectionStart: start, selectionEnd: FULL_SQL.length }), {
    sql: SELECTED_SQL,
    selectionUsed: true,
  });
  assert.deepEqual(resolveSqlExecution({ sql: FULL_SQL, selectionStart: 9, selectionEnd: 10 }), {
    sql: FULL_SQL,
    selectionUsed: false,
  });
}

function testEditorUtilities() {
  assert.equal(formatSql('select * from t_user where id = 1'), 'SELECT *\nFROM t_user\nWHERE id = 1');
  const highlighted = highlightSql('<script> SELECT 1');
  assert.ok(highlighted.includes('&lt;script&gt;'));
  assert.ok(highlighted.includes('tk-kw'));
  assert.ok(highlightSql('SELECT * FROM "public"."accounts"').includes('<span class="tk-id">"public"</span>'));
  const mysqlDdl = highlightSql("CREATE TABLE `order` (`default` varchar(20) DEFAULT 'pending', `key` int DEFAULT 0); -- SELECT 1");
  assert.ok(mysqlDdl.includes('<span class="tk-id">`order`</span>'));
  assert.ok(mysqlDdl.includes('<span class="tk-id">`default`</span>'));
  assert.ok(mysqlDdl.includes('<span class="tk-id">`key`</span>'));
  assert.ok(mysqlDdl.includes('<span class="tk-str">\'pending\'</span>'));
  assert.ok(mysqlDdl.includes('<span class="tk-num">0</span>'));
  assert.ok(mysqlDdl.includes('<span class="tk-cmt">-- SELECT 1</span>'));
  assert.ok(!mysqlDdl.includes('class=<span'));
  assert.ok(!mysqlDdl.includes('<span class="tk-cmt">-- <span'));
}

function testDbContextHelpers() {
  assert.equal(isPostgresType('pgsql'), true);
  assert.equal(isPostgresType('PostgreSQL'), true);
  assert.equal(isPostgresType('mysql'), false);
  assert.equal(quoteIdentifier('a"b', 'pgsql'), '"a""b"');
  assert.equal(quoteIdentifier('a`b', 'mysql'), '`a``b`');
  assert.equal(
    qualifiedTableName({ dbType: 'pgsql', schema: 'public', table: 'account_integrates' }),
    '"public"."account_integrates"',
  );
  assert.equal(
    qualifiedTableName({ dbType: 'mysql', schema: '', table: 't_user' }),
    '`t_user`',
  );
  const postgresBrowse = {
    dbType: 'pgsql',
    schema: 'public',
    table: 'end_users',
    where: '',
    orderBy: [],
    page: 1,
    pageSize: 100,
  };
  assert.equal(buildBrowseSql(postgresBrowse), 'SELECT * FROM "public"."end_users" OFFSET 0');
  assert.equal(buildTableConsoleSql(postgresBrowse), 'SELECT * FROM "public"."end_users"');
  assert.equal(
    buildBrowseSql({ ...postgresBrowse, dbType: 'mysql', schema: '', table: 't_user' }),
    'SELECT * FROM `t_user` LIMIT 100 OFFSET 0',
  );
  assert.equal(
    buildTableConsoleSql({ ...postgresBrowse, dbType: 'mysql', schema: '', table: 't_user' }),
    'SELECT * FROM `t_user`',
  );
}

function testPostgresTableDescription() {
  const metadata = parseTableDescription({
    full_sql: 'select metadata',
    column_list: [
      'column_name',
      'data_type',
      'character_maximum_length',
      'numeric_precision',
      'numeric_scale',
      'is_nullable',
      'column_default',
      'description',
    ],
    rows: [
      ['id', 'uuid', null, null, null, 'NO', 'uuid_generate_v4()', null],
      ['amount', 'numeric', null, 12, 2, 'YES', null, '金额'],
    ],
  });
  assert.equal(metadata.dialect, 'postgresql');
  assert.equal(metadata.ddl, '');
  assert.equal(metadata.engine, 'PostgreSQL');
  assert.deepEqual(metadata.columns[0], {
    name: 'id',
    type: 'uuid',
    nn: true,
    ai: false,
    pk: false,
    num: false,
    comment: '',
    default: 'uuid_generate_v4()',
  });
  assert.equal(metadata.columns[1].type, 'numeric(12,2)');
  assert.equal(metadata.columns[1].num, true);
}

function testMysqlTableDescriptionDefaults() {
  const ddl = `CREATE TABLE \`order\` (
  \`id\` bigint NOT NULL AUTO_INCREMENT,
  \`status\` varchar(20) NOT NULL DEFAULT 'pending' COMMENT '状态',
  \`retry_count\` int NOT NULL DEFAULT 0,
  \`ratio\` decimal(10,2) DEFAULT -1.25,
  \`parent_id\` bigint DEFAULT NULL,
  \`created_at\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` timestamp(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  \`empty_value\` varchar(20) DEFAULT '',
  \`title\` varchar(100) DEFAULT 'can''t',
  \`note\` varchar(100) COMMENT 'DEFAULT 只在注释中出现',
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
  const mysql = parseTableDescription({
    rows: [[
      'order',
      ddl,
    ]],
  });
  assert.equal(mysql.dialect, 'mysql');
  assert.equal(mysql.engine, 'InnoDB');
  assert.equal(mysql.columns[0].name, 'id');
  assert.equal(mysql.columns[0].pk, true);
  assert.equal(mysql.columns[0].default, '');
  const defaults = Object.fromEntries(mysql.columns.map(column => [column.name, column.default]));
  assert.deepEqual(defaults, {
    id: '',
    status: "'pending'",
    retry_count: '0',
    ratio: '-1.25',
    parent_id: 'NULL',
    created_at: 'CURRENT_TIMESTAMP',
    updated_at: 'CURRENT_TIMESTAMP(3)',
    empty_value: "''",
    title: "'can''t'",
    note: '',
  });
  const baseTab = {
    dbType: 'mysql',
    table: 'order',
    schema: '',
    meta: mysql,
    metaErr: '',
  };
  const structureHtml = renderTableView({ ...baseTab, subview: 'struct' }).html;
  assert.ok(structureHtml.includes("<td>'pending'</td>"));
  assert.ok(structureHtml.includes('<td>0</td>'));
  assert.ok(structureHtml.includes('<td>NULL</td>'));
  const ddlHtml = renderTableView({ ...baseTab, subview: 'ddl' }).html;
  assert.ok(ddlHtml.includes('<span class="tk-id">`status`</span>'));
  assert.ok(!ddlHtml.includes('class=<span'));
}

function testTableSubviewsByDialect() {
  const baseTab = {
    subview: 'ddl',
    page: 1,
    pageSize: 100,
    orderBy: [],
    where: '',
    hasNext: false,
    data: null,
    dataErr: '',
    dataLoading: true,
    sql: 'SELECT 1',
  };
  const postgres = { ...baseTab, dbType: 'pgsql' };
  assert.equal(resolveTableSubview(postgres), 'data');
  const postgresHtml = renderTableView(postgres).html;
  assert.ok(postgresHtml.includes('data-v="data"'));
  assert.ok(postgresHtml.includes('data-v="struct"'));
  assert.ok(!postgresHtml.includes('data-v="ddl"'));

  const mysql = { ...baseTab, dbType: 'mysql', subview: 'data' };
  assert.equal(resolveTableSubview(mysql), 'data');
  assert.ok(renderTableView(mysql).html.includes('data-v="ddl"'));
}

async function testDesktopApiSchemaRequests() {
  const calls = [];
  const pgDescription = {
    full_sql: 'select metadata',
    column_list: ['column_name', 'data_type', 'is_nullable'],
    rows: [['id', 'uuid', 'NO']],
  };
  globalThis.window = { location: { search: '?token=test' } };
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    const command = request.command;
    const args = request.args;
    calls.push({ command, args });
    let value = null;
    if (command === 'api_get') value = args.path.includes('resource_type=schema') ? ['public'] : ['account_integrates'];
    if (command === 'api_post' && args.path === '/instance/describetable/') value = pgDescription;
    if (command === 'api_post' && args.path === '/query/') value = { column_list: ['id'], column_type: [], rows: [], full_sql: args.form.sql_content };
    return { ok: true, status: 200, json: async () => ({ ok: true, value }) };
  };
  try {
    const { api } = await import('../src/lib/api.js?schema-contract');
    assert.deepEqual(await api.schemas('http://archery', { instance: 'mock-pg', db: 'dify' }), ['public']);
    await api.tables('http://archery', { instance: 'mock-pg', db: 'dify', schema: 'public' });
    const metadata = await api.describe('http://archery', {
      instance: 'mock-pg',
      db: 'dify',
      schema: 'public',
      table: 'account_integrates',
    });
    assert.equal(metadata.columns[0].name, 'id');
    await api.query('http://archery', {
      instance: 'mock-pg',
      db: 'dify',
      schema: 'public',
      table: 'account_integrates',
      sql: 'SELECT 1',
      limit: 100,
    });
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
  }
  const tableCall = calls.find(call => call.command === 'api_get' && call.args.path.includes('resource_type=table'));
  assert.ok(tableCall.args.path.includes('schema_name=public'));
  const describeCall = calls.find(call => call.args.path === '/instance/describetable/');
  assert.equal(describeCall.args.form.schema_name, 'public');
  const queryCall = calls.find(call => call.args.path === '/query/');
  assert.equal(queryCall.args.form.schema_name, 'public');
  assert.equal(queryCall.args.form.tb_name, 'account_integrates');
}

function testMultiStatementFormatting() {
  const source = 'select id from budget limit 1010;select * from final_accounts limit 1010;';
  assert.equal(
    formatSql(source),
    'SELECT id\nFROM budget\nLIMIT 1010;\nSELECT *\nFROM final_accounts\nLIMIT 1010;',
  );
  assert.equal(formatSql('select 1; select 2'), 'SELECT 1;\nSELECT 2');
  assert.equal(formatSql('select 1;;select 2;'), 'SELECT 1;\nSELECT 2;');
  assert.equal(
    formatSql("select 'a;b' from t; select `x;y` from u /* c;d */;"),
    "SELECT 'a;b'\nFROM t;\nSELECT `x;y`\nFROM u /* c;d */;",
  );
}

function testCsv() {
  assert.equal(buildCsv([{ name: 'name' }], [['a,b']]), '\uFEFFname\r\n"a,b"');
}

function testSplitSql() {
  // 基本多语句拆分
  assert.deepEqual(splitSql('SELECT 1;SELECT 2;'), ['SELECT 1', 'SELECT 2']);
  assert.deepEqual(splitSql('SELECT $$a;b$$ AS payload; SELECT 2;', { dbType: 'pgsql' }), [
    'SELECT $$a;b$$ AS payload',
    'SELECT 2',
  ]);
  assert.deepEqual(splitSql("SELECT payload #>> '{name}' FROM events; SELECT 2;", { dbType: 'pgsql' }), [
    "SELECT payload #>> '{name}' FROM events",
    'SELECT 2',
  ]);
  // 尾部无分号也算一条
  assert.deepEqual(splitSql('SELECT 1;\nSELECT 2'), ['SELECT 1', 'SELECT 2']);
  // 空白语句被丢弃
  assert.deepEqual(splitSql('  ;  \n  ; SELECT 1 ;'), ['SELECT 1']);
  // 空串与纯空白
  assert.deepEqual(splitSql(''), []);
  assert.deepEqual(splitSql('   \n\t '), []);
  // 字符串内的分号不拆分
  assert.deepEqual(splitSql("SELECT 'a;b'; SELECT 2;"), ["SELECT 'a;b'", 'SELECT 2']);
  // 双引号字符串内的分号
  assert.deepEqual(splitSql('SELECT "a;b"; SELECT 2;'), ['SELECT "a;b"', 'SELECT 2']);
  // 反引号标识符内的分号不拆分
  assert.deepEqual(splitSql('SELECT `a;b`; SELECT 2;'), ['SELECT `a;b`', 'SELECT 2']);
  // 行注释 -- 内的分号不拆分
  assert.deepEqual(splitSql('SELECT 1; -- 注释; 分号\nSELECT 2;'), ['SELECT 1', '-- 注释; 分号\nSELECT 2'.trim()]);
  // 块注释内的分号不拆分
  assert.deepEqual(splitSql('SELECT 1; /* 块;注释 */ SELECT 2;'), ['SELECT 1', '/* 块;注释 */ SELECT 2']);
  // # 行注释
  assert.deepEqual(splitSql('SELECT 1; # 注释; \nSELECT 2;'), ['SELECT 1', '# 注释; \nSELECT 2'.trim()]);
  // 转义引号不提前闭合
  assert.deepEqual(splitSql("SELECT 'a\\';b'; SELECT 2;"), ["SELECT 'a\\';b'", 'SELECT 2']);
  // 双写引号转义
  assert.deepEqual(splitSql("SELECT 'a''b;c'; SELECT 2;"), ["SELECT 'a''b;c'", 'SELECT 2']);
  // 返回值为只读
  assert.ok(Object.isFrozen(splitSql('SELECT 1;')));
}

function testStatementAtCursor() {
  const sql = 'SELECT id FROM `budget` LIMIT 1010;SELECT id FROM `final_accounts` LIMIT 1010;';
  const firstCursor = sql.indexOf('id') + 2;
  const secondCursor = sql.lastIndexOf('id') + 2;
  assert.equal(extractSqlStatementAt(sql, firstCursor), 'SELECT id FROM `budget` LIMIT 1010');
  assert.equal(extractSqlStatementAt(sql, secondCursor), 'SELECT id FROM `final_accounts` LIMIT 1010');

  const protectedSql = "SELECT 'a;b', `c;d` FROM budget /* x;y */; SELECT id FROM final_accounts";
  const protectedCursor = protectedSql.indexOf('budget') + 3;
  assert.equal(
    extractSqlStatementAt(protectedSql, protectedCursor),
    "SELECT 'a;b', `c;d` FROM budget /* x;y */",
  );

  const commentedSql = 'SELECT id FROM budget -- keep;this\nWHERE id > 0; SELECT id FROM final_accounts';
  const whereCursor = commentedSql.indexOf('WHERE') + 2;
  assert.equal(
    extractSqlStatementAt(commentedSql, whereCursor),
    'SELECT id FROM budget -- keep;this\nWHERE id > 0',
  );
}

function testReferencedTables() {
  // 用户工作流：先写 FROM 再改 SELECT 字段列表，整段扫描仍能识别表
  assert.deepEqual(extractReferencedTables('SELECT i FROM t_user'), ['t_user']);
  assert.deepEqual(extractReferencedTables('SELECT id, name FROM t_user WHERE id > 0'), ['t_user']);
  // 多表 JOIN
  assert.deepEqual(extractReferencedTables('SELECT a.x FROM t_user a JOIN t_order b ON a.id = b.uid'), ['t_user', 't_order']);
  // 反引号表名
  assert.deepEqual(extractReferencedTables('SELECT * FROM `t_user`'), ['t_user']);
  // schema.table 形式 → 取末段表名
  assert.deepEqual(extractReferencedTables('SELECT * FROM mydb.t_user'), ['t_user']);
  assert.deepEqual(extractReferencedTableRefs('SELECT * FROM "public"."t_user" JOIN audit.t_order ON true'), [
    { schema: 'public', table: 't_user' },
    { schema: 'audit', table: 't_order' },
  ]);
  // 无 FROM（用户正在写 SELECT 字段列表，尚未写 FROM）→ 空，回退到表名联想
  assert.deepEqual(extractReferencedTables('SELECT id, na'), []);
  // UPDATE / INSERT INTO
  assert.deepEqual(extractReferencedTables('UPDATE t_user SET name = 1'), ['t_user']);
  assert.deepEqual(extractReferencedTables('INSERT INTO t_user (id) VALUES (1)'), ['t_user']);
  // 只读
  assert.ok(Object.isFrozen(extractReferencedTables('SELECT * FROM t_user')));
}

function testHighlightMatch() {
  // 无前缀 → 纯转义
  assert.equal(highlightMatch('t_user', ''), 't_user');
  // 前缀命中（includes，命中位置可能在中间）
  assert.equal(highlightMatch('t_user', 't'), '<mark class="ac-hl">t</mark>_user');
  assert.equal(highlightMatch('user_name', 'name'), 'user_<mark class="ac-hl">name</mark>');
  // 大小写不敏感
  assert.equal(highlightMatch('CreatedAt', 'created'), '<mark class="ac-hl">Created</mark>At');
  assert.equal(highlightMatch('OrderID', 'id'), 'Order<mark class="ac-hl">ID</mark>');
  // 多命中点全部高亮
  assert.equal(highlightMatch('anaconda', 'a'), '<mark class="ac-hl">a</mark>n<mark class="ac-hl">a</mark>cond<mark class="ac-hl">a</mark>');
  // 无命中 → 纯转义
  assert.equal(highlightMatch('t_user', 'xyz'), 't_user');
  // 转义：label 含 HTML 特殊字符，命中段与未命中段都需正确转义
  assert.equal(highlightMatch('a<b&c', 'b'), 'a&lt;<mark class="ac-hl">b</mark>&amp;c');
  assert.equal(highlightMatch('a&b', 'a'), '<mark class="ac-hl">a</mark>&amp;b');
  // 跨连续分词前缀命中，下划线与 camelCase 均支持
  assert.equal(
    highlightMatch('sample_dream_log_center', 'dl'),
    'sample_<mark class="ac-hl">d</mark>ream_<mark class="ac-hl">l</mark>og_center',
  );
  assert.equal(
    highlightMatch('sample_dream_log_center', 'drlo'),
    'sample_<mark class="ac-hl">dr</mark>eam_<mark class="ac-hl">lo</mark>g_center',
  );
  assert.equal(
    highlightMatch('sample_dream_log_center', 'dlog'),
    'sample_<mark class="ac-hl">d</mark>ream_<mark class="ac-hl">log</mark>_center',
  );
  assert.equal(
    highlightMatch('dreamLogCenter', 'dl'),
    '<mark class="ac-hl">d</mark>ream<mark class="ac-hl">L</mark>ogCenter',
  );
  assert.ok(highlightMatch('dream-log-center', 'dl').includes('<mark class="ac-hl">l</mark>og'));
  assert.ok(highlightMatch('dream.log_center', 'dl').includes('<mark class="ac-hl">l</mark>og'));
  assert.equal(highlightMatch('delete', 'dl'), 'delete');
}

function testCrossWordAutocomplete() {
  const ac = new SqlAutocomplete({ api: {}, getContext: () => null, onError: () => {} });
  const consoleContext = { type: 'console', instance: 'inst', db: 'db', dbType: 'mysql' };
  ac.tables.set(autocompleteKey({}), ['sample_dream_log_center', 'unrelated']);
  const tableSql = 'SELECT * FROM dl';
  const tableItems = ac.collectItems({
    context: consoleContext,
    textarea: { value: tableSql, selectionStart: tableSql.length },
    isWhere: false,
    prefix: 'dl',
    refresh: () => {},
  });
  assert.ok(tableItems.some(item => item.label === 'sample_dream_log_center' && item.kind === 'table'));

  ac.columns.set(autocompleteKey({ table: 'budget' }), [
    { name: 'dream_log_id', type: 'bigint' },
    { name: 'name', type: 'varchar' },
  ]);
  const fieldSql = 'SELECT dl FROM budget';
  const fieldItems = ac.collectItems({
    context: consoleContext,
    textarea: { value: fieldSql, selectionStart: 'SELECT dl'.length },
    isWhere: false,
    prefix: 'dl',
    refresh: () => {},
  });
  assert.ok(fieldItems.some(item => item.label === 'dream_log_id' && item.kind.startsWith('budget ·')));

  const whereContext = {
    type: 'table',
    dbType: 'mysql',
    meta: {
      columns: [
        { name: 'dream_log_id', type: 'bigint', comment: '' },
        { name: 'dl_code', type: 'varchar', comment: '' },
      ],
    },
  };
  const whereItems = ac.collectItems({
    context: whereContext,
    textarea: {},
    isWhere: true,
    prefix: 'dl',
    refresh: () => {},
  });
  assert.equal(whereItems[0].label, 'dl_code');
  assert.ok(whereItems.some(item => item.label === 'dream_log_id'));
  assert.ok(ac.collectItems({
    context: whereContext,
    textarea: {},
    isWhere: true,
    prefix: 'ob',
    refresh: () => {},
  }).some(item => item.label === 'order by' && item.kind === 'keyword'));
}

function testDialectFunctionAutocomplete() {
  const ac = new SqlAutocomplete({ api: {}, getContext: () => null, onError: () => {} });
  const collect = ({ dbType, prefix, isWhere = false }) => {
    const context = isWhere
      ? { type: 'table', dbType, meta: { columns: [] } }
      : { type: 'console', instance: 'inst', db: 'db', dbType };
    if (!isWhere) ac.tables.set(autocompleteKey({}), []);
    const sql = 'SELECT ' + prefix;
    return ac.collectItems({
      context,
      textarea: { value: sql, selectionStart: sql.length },
      isWhere,
      prefix,
      refresh: () => {},
    });
  };
  const mysqlItems = collect({ dbType: 'mysql', prefix: 'df' });
  assert.ok(mysqlItems.some(item => item.label === 'date_format' && item.kind === 'MySQL 函数'));
  assert.ok(mysqlItems.every(item => item.label !== 'date_trunc'));
  assert.ok(collect({ dbType: 'mysql', prefix: 'DF' }).some(item => item.label === 'DATE_FORMAT'));
  assert.equal(collect({ dbType: 'mysql', prefix: 'date_format' })[0].label, 'date_format');

  const postgresItems = collect({ dbType: 'pgsql', prefix: 'dt' });
  assert.ok(postgresItems.some(item => item.label === 'date_trunc' && item.kind === 'PostgreSQL 函数'));
  assert.ok(postgresItems.every(item => item.label !== 'date_format'));
  assert.ok(collect({ dbType: 'pgsql', prefix: 'group_concat' })
    .every(item => item.label !== 'group_concat'));
  assert.ok(collect({ dbType: 'mysql', prefix: 'string_agg' })
    .every(item => item.label !== 'string_agg'));
  assert.ok(collect({ dbType: 'postgresql', prefix: 'sa', isWhere: true })
    .some(item => item.label === 'string_agg' && item.kind === 'PostgreSQL 函数'));
  assert.ok(collect({ dbType: 'mysql', prefix: 'gc', isWhere: true })
    .some(item => item.label === 'group_concat' && item.kind === 'MySQL 函数'));

  assert.ok(collect({ dbType: 'mysql', prefix: 'coa' }).some(item => item.label === 'coalesce'));
  assert.ok(collect({ dbType: 'pgsql', prefix: 'coa' }).some(item => item.label === 'coalesce'));
  assert.ok(collect({ dbType: '', prefix: 'coa' }).some(item => item.kind === 'SQL 函数'));
  assert.ok(collect({ dbType: '', prefix: 'ifnull' }).every(item => item.label !== 'ifnull'));
  assert.ok(collect({ dbType: '', prefix: 'date_trunc' }).every(item => item.label !== 'date_trunc'));
  const labels = collect({ dbType: 'mysql', prefix: 'a' }).map(item => item.label.toLowerCase());
  assert.equal(labels.length, new Set(labels).size);

  const countItem = collect({ dbType: 'mysql', prefix: 'cou' }).find(item => item.label === 'count');
  const textarea = {
    value: 'SELECT cou', selectionStart: 'SELECT cou'.length, selectionEnd: 'SELECT cou'.length, dataset: {},
    setRangeText(value, start, end) { this.value = this.value.slice(0, start) + value + this.value.slice(end); },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    focus() {},
  };
  ac.hide = () => {};
  ac.state = { open: true, items: [countItem], selected: 0, from: 'SELECT '.length, textarea };
  ac.accept();
  assert.equal(textarea.value, 'SELECT count() ');
  assert.equal(textarea.selectionStart, 'SELECT count('.length);
  assert.equal(textarea.selectionEnd, 'SELECT count('.length);

  const collectFrom = (dbType, prefix) => {
    const context = { type: 'console', instance: 'inst', db: 'db', dbType };
    ac.tables.set(autocompleteKey({}), ['count_events', 'date_trunc_jobs']);
    const sql = 'SELECT * FROM ' + prefix;
    return ac.collectItems({
      context,
      textarea: { value: sql, selectionStart: sql.length },
      isWhere: false,
      prefix,
      refresh: () => {},
    });
  };
  assert.ok(collectFrom('mysql', 'count').every(item => !item.kind.endsWith('函数')));
  assert.ok(collectFrom('pgsql', 'date_trunc').every(item => !item.kind.endsWith('函数')));
}

function testAllColumnsItem() {
  // 构造实例：collectAllColumnsItem 仅用 this.columns 缓存，不调 api
  const ac = new SqlAutocomplete({ api: {}, getContext: () => null, onError: () => {} });
  const ctx = { instance: 'inst', db: 'db' };
  // 无 FROM → 无全字段候选
  assert.equal(ac.collectAllColumnsItem(ctx, 'SELECT id, na'), null);
  // 有 FROM 但字段未加载 → null（ensureColumns 由 collectColumnItems 触发，此处只读缓存）
  assert.equal(ac.collectAllColumnsItem(ctx, 'SELECT * FROM t_user'), null);
  // 加载字段后 → 全字段候选，insert 为逗号分隔全字段
  ac.columns.set(autocompleteKey({ table: 't_user' }), [{ name: 'id', type: 'bigint' }, { name: 'name', type: 'varchar' }, { name: 'age', type: 'int' }]);
  const item = ac.collectAllColumnsItem(ctx, 'SELECT  FROM t_user');
  assert.ok(item && item.allColumns);
  assert.equal(item.insert, 'id, name, age');
  assert.equal(item.label, 'id, name, age');
  assert.ok(item.kind.includes('全部 3 列'));
  // 多表 JOIN → 无全字段候选（避免歧义）
  ac.columns.set(autocompleteKey({ table: 't_order' }), [{ name: 'oid', type: 'bigint' }]);
  assert.equal(ac.collectAllColumnsItem(ctx, 'SELECT * FROM t_user a JOIN t_order b'), null);
}

function testAllColumnsPriority() {
  const ac = new SqlAutocomplete({ api: {}, getContext: () => null, onError: () => {} });
  const context = { type: 'console', instance: 'inst', db: 'db' };
  ac.tables.set(autocompleteKey({}), []);
  ac.columns.set(autocompleteKey({ table: 'budget' }), [
    { name: 'id', type: 'bigint unsigned' },
    { name: 'budget_id', type: 'bigint' },
    { name: 'applicant_id', type: 'bigint' },
    { name: 'submitter_id', type: 'bigint' },
  ]);
  const collect = prefix => {
    const sql = 'SELECT ' + prefix + ' FROM budget';
    return ac.collectItems({
      context,
      textarea: { value: sql, selectionStart: 'SELECT '.length + prefix.length },
      isWhere: false,
      prefix,
      refresh: () => {},
    });
  };

  const exactItems = collect('id');
  assert.equal(exactItems[0].label, 'id');
  assert.ok(exactItems[1].allColumns);
  assert.deepEqual(exactItems.slice(2).map(item => item.label), ['budget_id', 'applicant_id', 'submitter_id']);

  const partialItems = collect('lic');
  assert.ok(partialItems[0].allColumns);
  assert.equal(partialItems[1].label, 'applicant_id');

  const collectAt = (sql, prefix) => ac.collectItems({
    context,
    textarea: { value: sql, selectionStart: sql.lastIndexOf(prefix) + prefix.length },
    isWhere: false,
    prefix,
    refresh: () => {},
  });
  const withoutAllColumns = [
    'SELECT 1 FROM budget WHERE id',
    'SELECT 1 FROM budget GROUP BY id',
    'SELECT 1 FROM budget HAVING id',
    'SELECT 1 FROM budget ORDER BY id',
    'SELECT 1 FROM budget b JOIN budget c ON id',
    'SELECT 1 FROM budget id',
  ];
  for (const sql of withoutAllColumns) {
    assert.ok(collectAt(sql, 'id').every(candidate => !candidate.allColumns), sql);
  }
}

function testWhereAutocompleteExactMatches() {
  const ac = new SqlAutocomplete({ api: {}, getContext: () => null, onError: () => {} });
  const context = {
    type: 'table',
    meta: {
      columns: [
        { name: 'budget_id', type: 'bigint', comment: '' },
        { name: 'applicant_id', type: 'bigint', comment: '' },
        { name: 'id', type: 'bigint unsigned', comment: '主键' },
        { name: 'selected_at', type: 'datetime', comment: '' },
      ],
    },
  };
  const collect = prefix => ac.collectItems({
    context,
    textarea: {},
    isWhere: true,
    prefix,
    refresh: () => {},
  });

  const fieldItems = collect('id');
  assert.equal(fieldItems[0].label, 'id');
  assert.deepEqual(fieldItems.slice(1).map(item => item.label), ['budget_id', 'applicant_id']);

  const keywordItems = collect('AND');
  assert.ok(keywordItems.some(item => item.label === 'AND' && item.kind === 'keyword'));

  assert.ok(collect('tween').some(item => item.label === 'between' && item.kind === 'keyword'));
  assert.ok(collect('TWEEN').some(item => item.label === 'BETWEEN' && item.kind === 'keyword'));
  const overlappingItems = collect('lect');
  assert.ok(overlappingItems.some(item => item.label === 'selected_at' && item.kind === 'datetime'));
  assert.ok(overlappingItems.some(item => item.label === 'select' && item.kind === 'keyword'));
}

function testConsoleAutocompleteExactKeywords() {
  const ac = new SqlAutocomplete({ api: {}, getContext: () => null, onError: () => {} });
  const context = { type: 'console', instance: 'inst', db: 'db' };
  ac.tables.set(autocompleteKey({}), [
    ...Array.from({ length: 35 }, (_, index) => 'select_table_' + index),
    ...Array.from({ length: 35 }, (_, index) => 'where_table_' + index),
  ]);
  const collect = (sql, prefix = sql) => ac.collectItems({
    context,
    textarea: { value: sql, selectionStart: sql.length },
    isWhere: false,
    prefix,
    refresh: () => {},
  });

  const selectItems = collect('SELECT');
  const whereItems = collect('WHERE');
  assert.deepEqual(selectItems[0], { label: 'SELECT', insert: 'SELECT', kind: 'keyword' });
  assert.deepEqual(whereItems[0], { label: 'WHERE', insert: 'WHERE', kind: 'keyword' });
  assert.ok(selectItems.slice(0, 30).some(item => item.label === 'SELECT'));
  assert.ok(whereItems.slice(0, 30).some(item => item.label === 'WHERE'));

  assert.ok(collect('lect').some(item => item.label === 'select' && item.kind === 'keyword'));
  assert.ok(collect('LECT').some(item => item.label === 'SELECT' && item.kind === 'keyword'));
  assert.ok(collect('roup').some(item => item.label === 'group by' && item.kind === 'keyword'));

  const previousDocument = globalThis.document;
  globalThis.document = { getElementById: () => null };
  try {
    for (const sql of ['ORDER BY', 'ORDER  BY', 'ORDER\tBY', 'ORDER\nBY']) {
      const orderByItem = collect(sql, 'BY')[0];
      assert.deepEqual(orderByItem, {
        label: 'ORDER BY',
        insert: 'ORDER BY',
        kind: 'keyword',
        replaceFrom: 0,
      });
      const textarea = {
        value: sql,
        selectionStart: sql.length,
        dataset: {},
        setRangeText(value, start, end) {
          this.value = this.value.slice(0, start) + value + this.value.slice(end);
          this.selectionStart = start + value.length;
        },
        focus() {},
      };
      ac.state = { open: true, items: [orderByItem], selected: 0, from: sql.length - 2, textarea };
      ac.accept();
      assert.equal(textarea.value, 'ORDER BY ');
    }
  } finally {
    if (previousDocument) globalThis.document = previousDocument;
    else delete globalThis.document;
  }
}

function testStatementScopedAutocomplete() {
  const ac = new SqlAutocomplete({ api: {}, getContext: () => null, onError: () => {} });
  const context = { type: 'console', instance: 'inst', db: 'db' };
  const sql = 'SELECT id FROM `budget` LIMIT 1010;SELECT id FROM `final_accounts` LIMIT 1010;';
  ac.tables.set(autocompleteKey({}), []);
  ac.columns.set(autocompleteKey({ table: 'budget' }), [
    { name: 'id', type: 'bigint unsigned' },
    { name: 'applicant_id', type: 'bigint' },
  ]);
  ac.columns.set(autocompleteKey({ table: 'final_accounts' }), [
    { name: 'id', type: 'bigint unsigned' },
    { name: 'account_id', type: 'bigint' },
  ]);

  const collectAt = selectionStart => ac.collectItems({
    context,
    textarea: { value: sql, selectionStart },
    isWhere: false,
    prefix: 'id',
    refresh: () => {},
  });
  const firstItems = collectAt(sql.indexOf('id') + 2);
  assert.ok(firstItems.some(item => item.kind.startsWith('budget ·')));
  assert.ok(firstItems.every(item => !item.kind.startsWith('final_accounts ·')));
  assert.equal(firstItems.find(item => item.allColumns).kind, 'budget · 全部 2 列');

  const secondItems = collectAt(sql.lastIndexOf('id') + 2);
  assert.ok(secondItems.some(item => item.kind.startsWith('final_accounts ·')));
  assert.ok(secondItems.every(item => !item.kind.startsWith('budget ·')));
  assert.equal(secondItems.find(item => item.allColumns).kind, 'final_accounts · 全部 2 列');
}

function testSchemaScopedAutocomplete() {
  const ac = new SqlAutocomplete({ api: {}, getContext: () => null, onError: () => {} });
  const baseContext = { type: 'console', origin: 'origin', instance: 'inst', db: 'db', schema: 'public' };
  const key = options => resourceContextKey({ origin: 'origin', instance: 'inst', db: 'db', ...options });
  ac.tables.set(key({ schema: 'public' }), ['public_accounts']);
  ac.tables.set(key({ schema: 'audit' }), ['audit_accounts']);
  ac.columns.set(key({ schema: 'public', table: 'accounts' }), [{ name: 'public_id', type: 'uuid' }]);
  ac.columns.set(key({ schema: 'audit', table: 'accounts' }), [{ name: 'audit_id', type: 'uuid' }]);

  const collect = (context, sql, prefix) => ac.collectItems({
    context,
    textarea: { value: sql, selectionStart: 'SELECT '.length + prefix.length },
    isWhere: false,
    prefix,
    refresh: () => {},
  });
  const publicItems = collect(baseContext, 'SELECT pub FROM "public"."accounts"', 'pub');
  assert.ok(publicItems.some(item => item.kind.startsWith('public.accounts ·')));
  assert.ok(publicItems.every(item => !item.kind.startsWith('audit.accounts ·')));

  const auditItems = collect(baseContext, 'SELECT aud FROM audit.accounts', 'aud');
  assert.ok(auditItems.some(item => item.kind.startsWith('audit.accounts ·')));
  assert.ok(auditItems.every(item => !item.kind.startsWith('public.accounts ·')));

  assert.ok(collect(baseContext, 'SELECT public', 'public').some(item => item.label === 'public_accounts'));
  const auditContext = { ...baseContext, schema: 'audit' };
  assert.ok(collect(auditContext, 'SELECT audit', 'audit').some(item => item.label === 'audit_accounts'));
}

function testCompletionContextDetection() {
  const detectAt = (sql, prefix, cursor = sql.indexOf(prefix) + prefix.length) =>
    detectSqlCompletionContext(sql, cursor, prefix.length);
  assert.equal(detectAt('SELECT fi FROM budget', 'fi'), 'select-list');
  assert.equal(detectAt('SELECT * FROM fi', 'fi'), 'table');
  assert.equal(detectAt('SELECT * FROM budget b JOIN fi', 'fi'), 'table');
  assert.equal(detectAt('SELECT * FROM db.fi', 'fi'), 'table');
  assert.equal(detectAt('SELECT * FROM budget b, fi', 'fi'), 'table');
  assert.equal(detectAt('UPDATE fi SET name = 1', 'fi'), 'table');
  assert.equal(detectAt('INSERT INTO fi (id) VALUES (1)', 'fi'), 'table');
  assert.equal(detectAt('SELECT * FROM budget WHERE fi', 'fi'), 'field');
  assert.equal(detectAt('UPDATE budget SET fi = 1', 'fi'), 'field');
  assert.equal(detectAt('SELECT * FROM `fi', 'fi'), 'table');
  assert.equal(detectAt("SELECT 'FROM fake', fi FROM budget", 'fi'), 'select-list');

  const multiSql = 'SELECT fi FROM budget; SELECT * FROM fi';
  const secondCursor = multiSql.indexOf('FROM fi') + 'FROM fi'.length;
  assert.equal(detectAt(multiSql, 'fi'), 'select-list');
  assert.equal(detectAt(multiSql, 'fi', secondCursor), 'table');
}

function testContextAwareAutocompletePriority() {
  const ac = new SqlAutocomplete({ api: {}, getContext: () => null, onError: () => {} });
  const context = { type: 'console', instance: 'inst', db: 'db' };
  ac.tables.set(autocompleteKey({}), ['final_accounts']);
  ac.columns.set(autocompleteKey({ table: 'budget' }), [
    { name: 'final_id', type: 'bigint' },
    { name: 'name', type: 'varchar' },
  ]);
  const collectAt = (sql, prefix, cursor) => ac.collectItems({
    context,
    textarea: { value: sql, selectionStart: cursor },
    isWhere: false,
    prefix,
    refresh: () => {},
  });
  const assertOrder = (items, expectedFirstKind) => {
    const fieldIndex = items.findIndex(item => item.kind.startsWith('budget ·') && !item.allColumns);
    const tableIndex = items.findIndex(item => item.kind === 'table');
    assert.ok(fieldIndex >= 0 && tableIndex >= 0);
    assert.equal(tableIndex < fieldIndex ? 'table' : 'field', expectedFirstKind);
  };

  const selectSql = 'SELECT fi FROM budget';
  assertOrder(collectAt(selectSql, 'fi', selectSql.indexOf('fi') + 2), 'field');

  const fromSql = 'SELECT final_id FROM fi JOIN budget b';
  const fromCursor = fromSql.indexOf('FROM fi') + 'FROM fi'.length;
  assertOrder(collectAt(fromSql, 'fi', fromCursor), 'table');

  const joinSql = 'SELECT final_id FROM budget b JOIN fi';
  assertOrder(collectAt(joinSql, 'fi', joinSql.length), 'table');

  const whereSql = 'SELECT final_id FROM budget WHERE fi';
  assertOrder(collectAt(whereSql, 'fi', whereSql.length), 'field');
}

function testConsoleQueryPagination() {
  assert.equal(DEFAULT_CONSOLE_PAGE_SIZE, 100);
  assert.deepEqual(PAGE_SIZE_OPTIONS, [20, 50, 100, 200, 500, 1000]);
  assert.ok(Object.isFrozen(PAGE_SIZE_OPTIONS));
  for (const sql of [
    'SELECT * FROM t_user',
    '-- leading comment\nSELECT * FROM t_user',
    '/* outer /* nested */ comment */ SELECT * FROM t_user',
    'WITH recent AS (SELECT * FROM events LIMIT 10) SELECT * FROM recent',
    'WITH RECURSIVE tree AS (SELECT 1 UNION ALL SELECT id + 1 FROM tree) SELECT * FROM tree',
    "SELECT 'LIMIT 1', \"OFFSET\", `FETCH` FROM t_user",
    'SELECT $$ LIMIT 1 $$ AS text_value FROM t_user',
    'SELECT * FROM (SELECT * FROM t_user LIMIT 1) nested_rows',
  ]) assert.equal(isPageableConsoleSql(sql), true, sql);
  for (const sql of [
    '',
    'UPDATE t_user SET name = \'changed\'',
    'WITH changed AS (SELECT id FROM t_user) UPDATE t_user SET name = \'changed\'',
    'WITH removed AS (SELECT id FROM t_user) DELETE FROM t_user',
    'SELECT * FROM t_user LIMIT 10',
    'SELECT * FROM t_user OFFSET 10',
    'SELECT * FROM t_user FETCH FIRST 10 ROWS ONLY',
    'WITH claimed AS (UPDATE jobs SET status = 1 RETURNING *) SELECT * FROM claimed',
    'SELECT * FROM jobs FOR UPDATE SKIP LOCKED',
    'SELECT id INTO archived_ids FROM users',
  ]) assert.equal(isPageableConsoleSql(sql), false, sql);
  assert.equal(isPageableConsoleSql("SELECT payload #>> '{name}' FROM events", 'pgsql'), true);
  assert.equal(isPageableConsoleSql("SELECT payload #>> '{name}' FROM events LIMIT 10", 'pgsql'), false);
  assert.equal(
    buildConsolePageSql({ sql: 'SELECT * FROM t_user;', page: 2, pageSize: 600 }),
    'SELECT * FROM t_user\nLIMIT 400 OFFSET 600',
  );
  assert.equal(
    buildConsoleCountSql({ sql: 'SELECT DISTINCT status FROM t_user;' }),
    'SELECT COUNT(*) AS total\nFROM (\nSELECT DISTINCT status FROM t_user\nLIMIT 1000\n) AS sql_studio_count',
  );
  assert.throws(
    () => buildConsolePageSql({ sql: 'SELECT * FROM t_user LIMIT 10', page: 1, pageSize: 1000 }),
    /无顶层分页参数/,
  );
  assert.throws(
    () => buildConsolePageSql({ sql: 'SELECT 1', page: 0, pageSize: 1000 }),
    /page 必须是正安全整数/,
  );
  assert.throws(() => buildConsoleCountSql({ sql: 'UPDATE t_user SET name = 1' }), /安全且无顶层分页参数/);
}

async function testPagedRowCollection() {
  const sourceRows = Object.freeze([
    Object.freeze([1, 'a']),
    Object.freeze([2, 'b']),
    Object.freeze([3, 'c']),
    Object.freeze([4, 'd']),
    Object.freeze([5, 'e']),
  ]);
  const requests = [];
  const result = await collectPagedRows({
    totalRows: sourceRows.length,
    pageSize: 2,
    fetchPage: async request => {
      requests.push(request);
      return { columns: ['id', 'name'], rows: sourceRows.slice(request.offset, request.offset + request.expectedRows) };
    },
  });
  assert.deepEqual(requests, [
    { page: 1, pageSize: 2, offset: 0, expectedRows: 2 },
    { page: 2, pageSize: 2, offset: 2, expectedRows: 2 },
    { page: 3, pageSize: 2, offset: 4, expectedRows: 1 },
  ]);
  assert.ok(requests.every(Object.isFrozen));
  assert.deepEqual(result.columns, ['id', 'name']);
  assert.deepEqual(result.rows, sourceRows);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.columns) && Object.isFrozen(result.rows));
  assert.ok(result.rows.every(Object.isFrozen));
  let emptyFetches = 0;
  const empty = await collectPagedRows({
    totalRows: 0,
    pageSize: 1000,
    columns: ['id'],
    fetchPage: async () => { emptyFetches += 1; },
  });
  assert.equal(emptyFetches, 0);
  assert.deepEqual(empty, { columns: ['id'], rows: [] });
  await assert.rejects(() => collectPagedRows({
    totalRows: 3,
    pageSize: 2,
    fetchPage: async ({ page }) => ({
      columns: page === 1 ? ['id'] : ['changed_id'],
      rows: page === 1 ? [[1], [2]] : [[3]],
    }),
  }), /第 2 页列定义不一致/);
  await assert.rejects(() => collectPagedRows({
    totalRows: 3,
    pageSize: 2,
    fetchPage: async () => ({ columns: ['id'], rows: [[1]] }),
  }), /第 1 页行数不符/);
  await assert.rejects(() => collectPagedRows({
    totalRows: 1,
    pageSize: 1,
    fetchPage: async () => ({ columns: ['id', 'name'], rows: [[1]] }),
  }), /行列数不一致/);
  await assert.rejects(() => collectPagedRows({
    totalRows: 1,
    pageSize: 1,
    fetchPage: async () => { throw new Error('page request failed'); },
  }), /page request failed/);
}

testExecutionResolution();
testEditorUtilities();
testDbContextHelpers();
testPostgresTableDescription();
testMysqlTableDescriptionDefaults();
testTableSubviewsByDialect();
testMultiStatementFormatting();
testSplitSql();
testStatementAtCursor();
testReferencedTables();
testHighlightMatch();
testCrossWordAutocomplete();
testDialectFunctionAutocomplete();
testAllColumnsItem();
testAllColumnsPriority();
testWhereAutocompleteExactMatches();
testConsoleAutocompleteExactKeywords();
testStatementScopedAutocomplete();
testSchemaScopedAutocomplete();
testCompletionContextDetection();
testContextAwareAutocompletePriority();
testConsoleQueryPagination();
testCsv();
await testPagedRowCollection();
await testDesktopApiSchemaRequests();
await import('./console-session.mjs');
await import('./pagination.mjs');
console.log('PASS  unit: SQL splitting, multi-statement formatting, autocomplete, table extraction, session persistence and CSV');
