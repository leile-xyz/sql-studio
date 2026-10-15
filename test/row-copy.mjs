import assert from 'node:assert/strict';
import { serializeRow, serializeRows } from '../src/lib/row-copy.mjs';
import { createRowCopyActions } from '../src/lib/row-copy-actions.mjs';

const columns = Object.freeze(['id', 'name', 'empty', 'enabled', 'details']);
const row = Object.freeze([42, '张三\nO\'Reilly', null, true, Object.freeze({ note: '完整内容', values: [1, 2] })]);
const input = Object.freeze({ columns, row });
const json = serializeRow({ ...input, format: 'json' });
assert.deepEqual(JSON.parse(json), {
  id: 42, name: '张三\nO\'Reilly', empty: null, enabled: true,
  details: { note: '完整内容', values: [1, 2] },
});
assert.match(json, /\n  "id": 42/);

const specialNames = Object.freeze(['__proto__', 'constructor', 'name"<']);
assert.deepEqual(
  JSON.parse(serializeRow({ columns: specialNames, row: ['value', 1, 2], format: 'json' })),
  JSON.parse('{"__proto__":"value","constructor":1,"name\\"<":2}'),
);
const largeId = '900719925474099312345';
assert.equal(JSON.parse(serializeRow({ columns: ['id'], row: [largeId], format: 'json' })).id, largeId);

const delimited = {
  columns: ['id', 'text', 'empty'],
  row: [1, 'a,"b"\n中文\t末尾', null],
};
assert.equal(serializeRow({ ...delimited, format: 'csv' }), 'id,text,empty\r\n1,"a,""b""\n中文\t末尾",');
assert.equal(serializeRow({ ...delimited, format: 'tsv' }), 'id\ttext\tempty\r\n1\t"a,""b""\n中文\t末尾"\t');
assert.equal(serializeRow({ columns: ['a,b', 'c\td'], row: ['', false], format: 'csv' }), '"a,b",c\td\r\n,false');

const sqlInput = {
  columns: ['id', 'display_name', 'deleted', 'active'],
  row: [42, "O'Reilly", null, false],
  format: 'insert',
};
assert.equal(
  serializeRow({ ...sqlInput, dbType: 'mysql', target: { namespace: 'demo', table: 'users' } }),
  "INSERT INTO \x60demo\x60.\x60users\x60 (\x60id\x60, \x60display_name\x60, \x60deleted\x60, \x60active\x60) VALUES (42, 'O''Reilly', NULL, FALSE);",
);
assert.equal(
  serializeRow({ ...sqlInput, dbType: 'pgsql', target: { namespace: 'public', table: 'users' } }),
  'INSERT INTO "public"."users" ("id", "display_name", "deleted", "active") VALUES (42, E\'O\'\'Reilly\', NULL, FALSE);',
);
assert.equal(
  serializeRow({ columns: ['co\x60l'], row: ['x'], format: 'insert', dbType: 'mysql', target: { table: 'ta\x60ble' } }),
  "INSERT INTO \x60ta\x60\x60ble\x60 (\x60co\x60\x60l\x60) VALUES ('x');",
);
assert.equal(
  serializeRow({ columns: ['co"l'], row: ['x'], format: 'insert', dbType: 'postgres', target: { namespace: 's"chema', table: 'ta"ble' } }),
  'INSERT INTO "s""chema"."ta""ble" ("co""l") VALUES (E\'x\');',
);

const literalInput = { columns: ['value'], format: 'insert', target: { table: 'data' } };
assert.equal(
  serializeRow({ ...literalInput, dbType: 'mysql', row: ["C:\\目录\0"] }),
  "INSERT INTO \x60data\x60 (\x60value\x60) VALUES (CONVERT(X'433a5ce79baee5bd9500' USING utf8mb4));",
);
assert.equal(
  serializeRow({ ...literalInput, dbType: 'postgresql', row: ["C:\\dir\nO'Reilly"] }),
  'INSERT INTO "data" ("value") VALUES (E\'C:\\\\dir\nO\'\'Reilly\');',
);
assert.match(
  serializeRow({ ...literalInput, dbType: 'mysql', row: [largeId] }),
  /VALUES \('900719925474099312345'\);$/,
);
assert.throws(() => serializeRow({ ...literalInput, dbType: 'pgsql', row: ['\0'] }), /NUL/);
assert.throws(() => serializeRow({ ...literalInput, row: [Infinity] }), /非有限/);
assert.throws(() => serializeRow({ ...input, format: 'insert', target: { table: ' ' } }), /目标表名/);
assert.throws(() => serializeRow({ columns: ['id'], row: [], format: 'json' }), /不一致/);
assert.throws(() => serializeRow({ columns: ['id'], row: [undefined], format: 'json' }), /不一致/);
assert.throws(() => serializeRow({ columns: [], row: [], format: 'json' }), /列名无效/);
assert.throws(() => serializeRow({ ...input, format: 'unsupported' }), /不支持的复制格式/);

const duplicates = { columns: ['id', 'id'], row: [1, 2] };
assert.throws(() => serializeRow({ ...duplicates, format: 'json' }), /重复列名/);
assert.throws(() => serializeRow({ ...duplicates, format: 'insert', target: { table: 'data' } }), /重复列名/);
assert.equal(serializeRow({ ...duplicates, format: 'csv' }), 'id,id\r\n1,2');

const writes = [];
const notifications = [];
const copyActions = createRowCopyActions({
  writeClipboard: async text => { writes.push(text); },
  toast: (message, kind) => notifications.push({ message, kind }),
});
await copyActions.copy({ columns, rows: [row], format: 'json' });
assert.equal(writes[0], json);
assert.deepEqual(notifications, [{ message: '整行已复制为 JSON', kind: 'ok' }]);
const failures = [];
const rejectedClipboard = createRowCopyActions({
  writeClipboard: async () => { throw new Error('clipboard permission denied'); },
  toast: (message, kind) => failures.push({ message, kind }),
});
await rejectedClipboard.copy({ columns, rows: [row], format: 'json' });
assert.deepEqual(failures, [{ message: 'clipboard permission denied', kind: 'err' }]);

async function testMultipleRows() {
  const batch = Object.freeze({ columns: Object.freeze(['id', 'name', 'empty']), rows: Object.freeze([
    Object.freeze([1, 'a,"b"\n中文\t末尾', null]), Object.freeze([2, 'second', false]),
  ]) });
  assert.deepEqual(JSON.parse(serializeRows({ ...batch, format: 'json' })), [
    { id: 1, name: 'a,"b"\n中文\t末尾', empty: null }, { id: 2, name: 'second', empty: false },
  ]);
  assert.equal(serializeRows({ columns, rows: [row], format: 'json' }), json, '单行 JSON 继续返回对象');
  assert.equal(serializeRows({ ...batch, format: 'csv' }), 'id,name,empty\r\n1,"a,""b""\n中文\t末尾",\r\n2,second,false');
  assert.equal(serializeRows({ ...batch, format: 'tsv', includeHeaders: false }), '1\t"a,""b""\n中文\t末尾"\t\r\n2\tsecond\tfalse');
  assert.equal(serializeRows({ columns: ['id'], rows: [[1]], format: 'tsv', includeHeaders: false }), '1');
  assert.equal(serializeRows({ columns: ['id'], rows: [[1], [2]], format: 'insert', dbType: 'pgsql', target: { namespace: 'public', table: 'records' } }),
    'INSERT INTO "public"."records" ("id") VALUES (1);\r\nINSERT INTO "public"."records" ("id") VALUES (2);');
  assert.throws(() => serializeRows({ columns: ['id'], rows: [], format: 'json' }), /没有选中/);
  assert.throws(() => serializeRows({ columns: ['id'], rows: [[1], []], format: 'json' }), /不一致/);
  assert.throws(() => serializeRows({ columns: ['id', 'id'], rows: [[1, 2], [3, 4]], format: 'json' }), /重复列名/);
  assert.throws(() => serializeRows({ ...batch, format: 'unsupported' }), /不支持/);
  const writes = [];
  const messages = [];
  const actions = createRowCopyActions({ writeClipboard: async text => writes.push(text), toast: (message, kind) => messages.push({ message, kind }) });
  await actions.copy({ ...batch, format: 'json' });
  assert.equal(writes.length, 1);
  assert.deepEqual(messages[0], { message: '已复制 2 行为 JSON', kind: 'ok' });
  await actions.copy({ columns: ['id'], rows: [[1], []], format: 'json' });
  assert.equal(writes.length, 1, '后续行无效时不能写入部分结果');
  assert.deepEqual(messages[1], { message: '复制失败：行数据与结果列不一致', kind: 'err' });
}

await testMultipleRows();
console.log('PASS row copy: single/multiple rows, JSON types, delimited quoting, SQL dialects and clipboard failures');
