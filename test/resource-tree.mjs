import assert from 'node:assert/strict';
import { renderResourceTree } from '../src/lib/resource-tree-view.mjs';
import { createResourceTreeLoader } from '../src/lib/resource-tree-loader.mjs';
import { createResourceTreeSearch } from '../src/lib/resource-tree-search.mjs';
import { renderTreeContextMenuView, resolveTreeConsoleChange } from '../src/lib/resource-tree-menu.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return Object.freeze({ promise, resolve, reject });
}

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
let renders = 0;
const search = createResourceTreeSearch({
  getFilter: () => 'orders', getTree: () => searchNodes, getOrigin: () => 'origin',
  isPostgres: () => false,
  loadDbs: async node => { loaded.push('databases'); node.dbs = [searchDatabase]; },
  loadSchemas: async () => { throw new Error('unexpected schema request'); },
  loadTables: async node => { loaded.push('tables'); node.tables = [table]; },
  render: () => { renders += 1; },
});
await search.search();
assert.deepEqual(loaded, ['databases', 'tables']);
assert.deepEqual(search.viewState(), { searchLoading: false, searchError: '' });
assert.equal(renders, 2);

let filter = 'orders';
let cancelledRenders = 0;
let databaseLoads = 0;
let tableLoads = 0;
const databaseGate = deferred();
const cancelledInstance = { name: 'cancelled', dbType: 'mysql', dbs: null };
const cancelledDatabase = { name: 'cancelled_db', dbType: 'mysql', tables: null };
const cancelledTree = [cancelledInstance];
const cancelledSearch = createResourceTreeSearch({
  getFilter: () => filter, getTree: () => cancelledTree, getOrigin: () => 'origin',
  isPostgres: () => false,
  loadDbs: async node => {
    databaseLoads += 1;
    await databaseGate.promise;
    node.dbs = [cancelledDatabase];
  },
  loadSchemas: async () => { throw new Error('unexpected schema request'); },
  loadTables: async node => { tableLoads += 1; node.tables = [table]; },
  render: () => { cancelledRenders += 1; },
});
const staleSearch = cancelledSearch.search();
filter = '';
const clearSearch = cancelledSearch.search();
databaseGate.resolve();
await staleSearch;
await clearSearch;
assert.equal(databaseLoads, 1);
assert.equal(tableLoads, 0);
assert.deepEqual(cancelledInstance.dbs, [cancelledDatabase]);
assert.equal(cancelledRenders, 3);
assert.deepEqual(cancelledSearch.viewState(), { searchLoading: false, searchError: '' });

filter = 'orders';
await cancelledSearch.search();
assert.equal(databaseLoads, 1);
assert.equal(tableLoads, 1);
assert.deepEqual(cancelledDatabase.tables, [table]);
assert.equal(cancelledRenders, 5);

let errorRenders = 0;
const errorTree = [{ name: 'error', dbType: 'mysql', dbs: null }];
const errorSearch = createResourceTreeSearch({
  getFilter: () => 'orders', getTree: () => errorTree, getOrigin: () => 'origin',
  isPostgres: () => false,
  loadDbs: async () => { throw new Error('database load failed'); },
  loadSchemas: async () => {}, loadTables: async () => {},
  render: () => { errorRenders += 1; },
});
await errorSearch.search();
assert.deepEqual(errorSearch.viewState(), { searchLoading: false, searchError: 'database load failed' });
assert.equal(errorRenders, 3);

let partialErrorRenders = 0;
let partialErrorHtml = '';
const partialErrorGate = deferred();
const partialErrorVisible = deferred();
const failedInstance = { name: 'failed', dbType: 'mysql', dbs: null, error: '' };
const blockedInstance = { name: 'blocked', dbType: 'mysql', dbs: null, error: '' };
const partialErrorTree = [failedInstance, blockedInstance];
const partialErrorSearch = createResourceTreeSearch({
  getFilter: () => 'orders', getTree: () => partialErrorTree, getOrigin: () => 'origin',
  isPostgres: () => false,
  loadDbs: async node => {
    if (node === failedInstance) { node.error = 'failed instance'; return; }
    await partialErrorGate.promise;
    node.dbs = [];
  },
  loadSchemas: async () => {}, loadTables: async () => {},
  render: () => {
    partialErrorRenders += 1;
    partialErrorHtml = renderResourceTree({
      connected: true, tree: partialErrorTree, nodeMap: new Map(), selection: null, filter: 'orders',
      ...partialErrorSearch.viewState(),
    });
    if (partialErrorHtml.includes('failed instance')) partialErrorVisible.resolve();
  },
});
const partialErrorLoad = partialErrorSearch.search();
await partialErrorVisible.promise;
assert.deepEqual(partialErrorSearch.viewState(), { searchLoading: true, searchError: '' });
assert.match(partialErrorHtml, /资源加载失败：failed：failed instance/);
assert.match(partialErrorHtml, /正在加载数据库和数据表/);
assert.equal(partialErrorRenders, 2);
partialErrorGate.resolve();
await partialErrorLoad;
assert.equal(partialErrorRenders, 3);

let staleErrorFilter = 'orders';
let staleErrorRenders = 0;
const staleErrorGate = deferred();
const staleErrorTree = [{ name: 'stale-error', dbType: 'mysql', dbs: null }];
const staleErrorSearch = createResourceTreeSearch({
  getFilter: () => staleErrorFilter, getTree: () => staleErrorTree, getOrigin: () => 'origin',
  isPostgres: () => false,
  loadDbs: async () => { await staleErrorGate.promise; },
  loadSchemas: async () => {}, loadTables: async () => {},
  render: () => { staleErrorRenders += 1; },
});
const staleErrorLoad = staleErrorSearch.search();
staleErrorFilter = '';
const staleErrorClear = staleErrorSearch.search();
staleErrorGate.reject(new Error('stale database load failed'));
await staleErrorLoad;
await staleErrorClear;
assert.deepEqual(staleErrorSearch.viewState(), { searchLoading: false, searchError: '' });
assert.equal(staleErrorRenders, 3);

let scopedTree = [{ name: 'old-tree', dbType: 'mysql', dbs: null }];
let scopedOrigin = 'old-origin';
let scopedRenders = 0;
const oldTreeGate = deferred();
const scopedSearch = createResourceTreeSearch({
  getFilter: () => 'orders', getTree: () => scopedTree, getOrigin: () => scopedOrigin,
  isPostgres: () => false,
  loadDbs: async node => {
    if (node.name === 'old-tree') await oldTreeGate.promise;
    node.dbs = [];
  },
  loadSchemas: async () => {}, loadTables: async () => {},
  render: () => { scopedRenders += 1; },
});
const oldTreeSearch = scopedSearch.search();
scopedTree = [{ name: 'new-tree', dbType: 'mysql', dbs: null }];
scopedOrigin = 'new-origin';
oldTreeGate.resolve();
await oldTreeSearch;
assert.equal(scopedRenders, 1);
await scopedSearch.search();
assert.deepEqual(scopedTree[0].dbs, []);
assert.equal(scopedRenders, 3);

let loaderOrigin = 'old-origin';
const loaderNodes = new Map();
const loaderGate = deferred();
const loaderInstance = { uid: 'loader-instance', kind: 'instance', name: 'old', dbType: 'mysql', loading: false, error: '' };
loaderNodes.set(loaderInstance.uid, loaderInstance);
const loader = createResourceTreeLoader({
  api: { databases: async () => { await loaderGate.promise; return ['old_db']; }, schemas: async () => [], tables: async () => [] },
  getOrigin: () => loaderOrigin,
  makeNode: (kind, name, extra) => { const node = { uid: `${kind}-${name}`, kind, name, ...extra }; loaderNodes.set(node.uid, node); return node; },
  isPostgres: () => false,
  isCurrentNode: node => loaderNodes.get(node.uid) === node,
  render: () => {},
});
const staleLoader = loader.loadDbs(loaderInstance, { render: false, isCurrent: () => true });
loaderNodes.clear();
loaderOrigin = 'new-origin';
loaderGate.resolve();
await staleLoader;
assert.equal(loaderInstance.dbs, undefined);
assert.equal(loaderNodes.size, 0);

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

console.log('PASS resource tree: search batches rendering and cancels stale fan-out');
