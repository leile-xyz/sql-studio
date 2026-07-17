import assert from 'node:assert/strict';
import { renderResourceTree } from '../src/lib/resource-tree-view.mjs';
import { createResourceTreeSearch } from '../src/lib/resource-tree-search.mjs';
import { renderTreeContextMenuView, resolveTreeConsoleChange } from '../src/lib/resource-tree-menu.mjs';

const table = { uid: 'table-1', kind: 'table', name: 'orders', schema: '', db: 'sales_db', expanded: false };
const database = { uid: 'db-1', kind: 'db', name: 'sales_db', dbType: 'mysql', expanded: false, tables: [table] };
const instance = { uid: 'instance-1', kind: 'instance', name: 'warehouse', dbType: 'mysql', expanded: false, dbs: [database] };
const nodeMap = new Map([instance, database, table].map(node => [node.uid, node]));
const base = { connected: true, tree: [instance], nodeMap, selection: null, searchLoading: false };

const databaseHtml = renderResourceTree({ ...base, filter: 'sales' });
assert.match(databaseHtml, /data-act="toggle"/);
assert.match(databaseHtml, /<mark>sales<\/mark>_db/);

const tableHtml = renderResourceTree({ ...base, filter: 'order' });
assert.match(tableHtml, /data-act="open-table"/);
assert.match(tableHtml, /<mark>order<\/mark>s/);

const searchInstance = { name: 'warehouse', dbType: 'mysql', dbs: null };
const searchDatabase = { name: 'sales_db', dbType: 'mysql', tables: null };
const searchNodes = [searchInstance];
const loaded = [];
const search = createResourceTreeSearch({
  getFilter: () => 'orders', getTree: () => searchNodes, getOrigin: () => 'origin',
  isPostgres: () => false,
  loadDbs: async node => { loaded.push('databases'); node.dbs = [searchDatabase]; },
  loadSchemas: async () => { throw new Error('unexpected schema request'); },
  loadTables: async node => { loaded.push('tables'); node.tables = [table]; },
  render: () => {},
});
await search.search();
assert.deepEqual(loaded, ['databases', 'tables']);
assert.deepEqual(search.viewState(), { searchLoading: false, searchError: '' });

const consoleTab = { type: 'console', instance: 'warehouse', db: 'sales_db', schema: '', dbType: 'mysql' };
const changedDatabase = resolveTreeConsoleChange(consoleTab, { kind: 'db', uid: 'db-2', name: 'archive', inst: 'warehouse', dbType: 'mysql' });
assert.deepEqual(changedDatabase.context, { instance: 'warehouse', db: 'archive', schema: '', dbType: 'mysql' });
assert.equal(changedDatabase.instanceChanged, false);
assert.equal(changedDatabase.databaseChanged, true);
assert.equal(changedDatabase.changed, true);
const schemaChange = resolveTreeConsoleChange(consoleTab, { kind: 'schema', name: 'audit', inst: 'warehouse', db: 'sales_db', dbType: 'pgsql' });
assert.deepEqual(schemaChange.context, { instance: 'warehouse', db: 'sales_db', schema: 'audit', dbType: 'pgsql' });
assert.match(renderTreeContextMenuView(database), /data-act="tree-open-console"/);
assert.match(renderTreeContextMenuView(database), /在当前控制台打开/);

console.log('PASS resource tree: search matches collapsed databases and tables');
