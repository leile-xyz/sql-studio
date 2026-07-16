import assert from 'node:assert/strict';
import { resourceContextKey } from '../src/lib/db-context.mjs';
import {
  extractReferencedTableRefs,
  resolveSqlAutocompleteInput,
  SqlAutocomplete,
} from '../src/lib/sql-editor.mjs';

const CONTEXT = Object.freeze({
  type: 'console',
  instance: 'inst',
  db: 'db',
  dbType: 'pgsql',
});

function createAutocomplete() {
  return new SqlAutocomplete({
    api: {},
    getContext: () => CONTEXT,
    onEditorChange: () => {},
    onWhereChange: () => {},
    onError: error => { throw error; },
  });
}

function cacheTables(autocomplete, tables) {
  autocomplete.tables.set(resourceContextKey({ instance: 'inst', db: 'db' }), tables);
}

function cacheColumns(autocomplete, table, columns) {
  autocomplete.columns.set(
    resourceContextKey({ instance: 'inst', db: 'db', table }),
    columns,
  );
}

function collectAtCursor(autocomplete, sql, cursor = sql.length) {
  const input = resolveSqlAutocompleteInput(sql.slice(0, cursor));
  assert.ok(input, '光标前应包含可联想的 SQL 输入');
  return autocomplete.collectItems({
    context: CONTEXT,
    textarea: { value: sql, selectionStart: cursor },
    isWhere: false,
    prefix: input.prefix,
    qualifier: input.qualifier,
    refresh: () => {},
  });
}

function createTextarea(value, cursor = value.length) {
  return {
    value,
    selectionStart: cursor,
    selectionEnd: cursor,
    dataset: {},
    setRangeText(insertion, start, end) {
      this.value = this.value.slice(0, start) + insertion + this.value.slice(end);
      this.selectionStart = start + insertion.length;
      this.selectionEnd = this.selectionStart;
    },
    focus() {},
  };
}

function acceptCandidate(autocomplete, sql, candidate, cursor = sql.length) {
  const textarea = createTextarea(sql, cursor);
  const input = resolveSqlAutocompleteInput(sql.slice(0, cursor));
  assert.ok(input);
  autocomplete.hide = () => {};
  autocomplete.state = {
    open: true,
    items: [candidate],
    selected: 0,
    from: cursor - input.prefix.length,
    textarea,
  };
  autocomplete.accept();
  return textarea.value;
}

function testReferencedAliases() {
  const references = extractReferencedTableRefs(
    'SELECT * FROM public.budget AS b JOIN orders o ON b.id = o.budget_id',
  );
  assert.deepEqual(references, [
    { schema: 'public', table: 'budget', alias: 'b' },
    { schema: '', table: 'orders', alias: 'o' },
  ]);
  assert.deepEqual(extractReferencedTableRefs('SELECT * FROM budget WHERE id = 1'), [
    { schema: '', table: 'budget' },
  ]);
  assert.deepEqual(extractReferencedTableRefs('SELECT * FROM budget JOIN orders ON true'), [
    { schema: '', table: 'budget' },
    { schema: '', table: 'orders' },
  ]);
  assert.deepEqual(extractReferencedTableRefs('SELECT * FROM budget AS '), [
    { schema: '', table: 'budget' },
  ]);
  assert.ok(Object.isFrozen(references));
  assert.ok(references.every(Object.isFrozen));
}

function testResolveSqlAutocompleteInput() {
  assert.deepEqual(resolveSqlAutocompleteInput('SELECT budget.'), {
    qualifier: 'budget',
    prefix: '',
  });
  assert.deepEqual(resolveSqlAutocompleteInput('SELECT budget.na'), {
    qualifier: 'budget',
    prefix: 'na',
  });
  assert.deepEqual(resolveSqlAutocompleteInput('SELECT na'), {
    qualifier: '',
    prefix: 'na',
  });
  assert.deepEqual(resolveSqlAutocompleteInput('SELECT "用户别名".'), {
    qualifier: '用户别名',
    prefix: '',
  });
  assert.deepEqual(resolveSqlAutocompleteInput('SELECT `order-item`.na'), {
    qualifier: 'order-item',
    prefix: 'na',
  });
  assert.equal(resolveSqlAutocompleteInput('SELECT '), null);
  assert.ok(Object.isFrozen(resolveSqlAutocompleteInput('budget.id')));
}

function testQualifiedColumnCandidates() {
  const autocomplete = createAutocomplete();
  cacheColumns(autocomplete, 'budget', [
    { name: 'id', type: 'bigint' },
    { name: 'name', type: 'varchar' },
    { name: 'native_code', type: 'varchar' },
  ]);
  cacheColumns(autocomplete, 'orders', [{ name: 'order_name', type: 'varchar' }]);

  const cursor = 'SELECT budget.na'.length;
  const withFrom = collectAtCursor(autocomplete, 'SELECT budget.na FROM budget', cursor);
  assert.deepEqual(withFrom.map(item => item.label), ['name', 'native_code']);
  assert.deepEqual(withFrom.map(item => item.kind), ['varchar', 'varchar']);
  assert.ok(withFrom.every(item => item.label !== 'order_name'));

  const afterDot = collectAtCursor(
    autocomplete,
    'SELECT budget. FROM budget',
    'SELECT budget.'.length,
  );
  assert.deepEqual(afterDot.map(item => item.label), ['id', 'name', 'native_code']);
}

function testQualifiedColumnsWithoutFrom() {
  const autocomplete = createAutocomplete();
  cacheColumns(autocomplete, 'budget', [
    { name: 'id', type: 'bigint' },
    { name: 'name', type: 'varchar' },
  ]);

  const items = collectAtCursor(autocomplete, 'SELECT budget.na');
  assert.deepEqual(items.map(item => item.label), ['name']);
  assert.equal(items[0].insert, 'name');
  assert.equal(items[0].kind, 'varchar');
}

function testAliasQualifiedColumns() {
  const autocomplete = createAutocomplete();
  cacheColumns(autocomplete, 'budget', [
    { name: 'id', type: 'bigint' },
    { name: 'name', type: 'varchar' },
  ]);
  cacheColumns(autocomplete, 'orders', [
    { name: 'id', type: 'bigint' },
    { name: 'native_order', type: 'varchar' },
  ]);

  const asItems = collectAtCursor(
    autocomplete,
    'SELECT b.na FROM budget AS b',
    'SELECT b.na'.length,
  );
  assert.deepEqual(asItems.map(item => item.label), ['name']);
  assert.equal(asItems[0].kind, 'varchar');

  const implicitItems = collectAtCursor(
    autocomplete,
    'SELECT b. FROM budget b',
    'SELECT b.'.length,
  );
  assert.deepEqual(implicitItems.map(item => item.label), ['id', 'name']);

  const joinedSql = 'SELECT O.na FROM budget b JOIN orders o ON b.id = o.budget_id';
  const joinedItems = collectAtCursor(autocomplete, joinedSql, 'SELECT O.na'.length);
  assert.deepEqual(joinedItems.map(item => item.label), ['native_order']);
  assert.deepEqual(joinedItems.map(item => item.kind), ['varchar']);
}

function testAliasPriorityAndQuotedAlias() {
  const autocomplete = createAutocomplete();
  cacheColumns(autocomplete, 'orders', [{ name: 'order_name', type: 'varchar' }]);
  cacheColumns(autocomplete, 'users', [{ name: 'native_user', type: 'varchar' }]);
  cacheColumns(autocomplete, 'budget', [{ name: 'id', type: 'bigint' }]);

  const conflictSql = 'SELECT orders.na FROM orders o JOIN users orders ON true';
  const conflictItems = collectAtCursor(autocomplete, conflictSql, 'SELECT orders.na'.length);
  assert.deepEqual(conflictItems.map(item => item.label), ['native_user']);

  const quotedSql = 'SELECT "用户别名". FROM budget AS "用户别名"';
  const quotedItems = collectAtCursor(autocomplete, quotedSql, 'SELECT "用户别名".'.length);
  assert.deepEqual(quotedItems.map(item => item.label), ['id']);
}

function testSelfJoinColumnsAreDeduplicated() {
  const autocomplete = createAutocomplete();
  cacheTables(autocomplete, []);
  cacheColumns(autocomplete, 'users', [
    { name: 'id', type: 'bigint' },
    { name: 'name', type: 'varchar' },
  ]);

  const sql = 'SELECT na FROM users u JOIN users manager';
  const items = collectAtCursor(autocomplete, sql, 'SELECT na'.length);
  assert.deepEqual(items.filter(item => item.label === 'name').map(item => item.label), ['name']);
}

function testAliasCandidates() {
  const autocomplete = createAutocomplete();
  cacheTables(autocomplete, ['users', 'user_logs']);
  cacheColumns(autocomplete, 'users', []);

  const whereSql = 'SELECT * FROM users AS usr WHERE us';
  const alias = collectAtCursor(autocomplete, whereSql)
    .find(item => item.kind === 'alias · users');
  assert.ok(alias);
  assert.equal(alias.label, 'usr');
  assert.equal(alias.insert, 'usr');
  assert.equal(alias.appendSpace, false);
  assert.equal(acceptCandidate(autocomplete, whereSql, alias), 'SELECT * FROM users AS usr WHERE usr');

  const selectSql = 'SELECT us FROM users usr';
  const cursor = 'SELECT us'.length;
  const selectAlias = collectAtCursor(autocomplete, selectSql, cursor)
    .find(item => item.kind === 'alias · users');
  assert.ok(selectAlias);
  assert.equal(acceptCandidate(autocomplete, selectSql, selectAlias, cursor), 'SELECT usr FROM users usr');

  const joinSql = 'SELECT * FROM users u JOIN us';
  const joinItems = collectAtCursor(autocomplete, joinSql);
  assert.ok(joinItems.every(item => item.kind !== 'alias · users'));
}

function testTableAcceptanceSpacing() {
  const autocomplete = createAutocomplete();
  cacheTables(autocomplete, ['final_accounts']);

  const selectSql = 'SELECT fin';
  const selectCandidate = collectAtCursor(autocomplete, selectSql)
    .find(item => item.kind === 'table');
  assert.ok(selectCandidate);
  assert.equal(selectCandidate.appendSpace, false);
  assert.equal(
    acceptCandidate(autocomplete, selectSql, selectCandidate),
    'SELECT final_accounts',
  );

  const fromSql = 'SELECT * FROM fin';
  const fromCandidate = collectAtCursor(autocomplete, fromSql)
    .find(item => item.kind === 'table');
  assert.ok(fromCandidate);
  assert.equal(fromCandidate.appendSpace, true);
  assert.equal(
    acceptCandidate(autocomplete, fromSql, fromCandidate),
    'SELECT * FROM final_accounts ',
  );
}

testResolveSqlAutocompleteInput();
testReferencedAliases();
testQualifiedColumnCandidates();
testQualifiedColumnsWithoutFrom();
testAliasQualifiedColumns();
testAliasPriorityAndQuotedAlias();
testSelfJoinColumnsAreDeduplicated();
testAliasCandidates();
testTableAcceptanceSpacing();

console.log('PASS  autocomplete: qualified columns and context-aware table insertion');
