import assert from 'node:assert/strict';
import { executeConsoleStatement, fetchConsolePage } from '../src/lib/console-execution.mjs';
import { renderConsoleResultView } from '../src/lib/console-result-view.mjs';
import { buildBrowseSql, buildCountSql, buildTableConsoleSql, parseCountTotal } from '../src/lib/db-context.mjs';
import { collectConsoleExport, collectTableExport } from '../src/lib/export-service.mjs';
import { queryPageWindow } from '../src/lib/query-row-limit.mjs';
import { loadTableData, prepareTableDataQuery } from '../src/lib/table-data-loader.mjs';
import { renderTableView } from '../src/lib/table-view.mjs';

const columns = Object.freeze(['id']);
const types = Object.freeze(['LONGLONG']);
const makeRows = (count, offset = 0) => Array.from({ length: count }, (_, index) => [offset + index + 1]);
const response = (rows, sql) => ({ columns, types, rows, elapsed: 0.01, fullSql: sql, isMasked: false });
const sqlOffset = sql => Number((String(sql).match(/OFFSET\s+(\d+)/i) || [])[1] || 0);

function pagedApi(totalRows, calls) {
  return {
    query: async (_origin, options) => {
      calls.push(options);
      if (/SELECT COUNT\(\*\) AS total/i.test(options.sql)) {
        return { columns: ['total'], types, rows: [[totalRows]] };
      }
      const offset = sqlOffset(options.sql);
      const rowCount = Math.max(0, Math.min(options.limit, totalRows - offset));
      return response(makeRows(rowCount, offset), options.sql);
    },
  };
}

async function testConsoleExecutionAndPaging() {
  const calls = [];
  const context = { instance: 'inst', db: 'db', schema: 'public', dbType: 'pgsql' };
  const api = pagedApi(2501, calls);
  const result = await executeConsoleStatement({ api, origin: 'http://archery', context, sql: 'SELECT id FROM users' });
  context.db = 'changed';
  assert.equal(result.ok, true);
  assert.equal(result.pageable, true);
  assert.equal(result.pageSize, 100);
  assert.equal(result.rows.length, 100);
  assert.equal(result.totalRows, 1000);
  assert.equal(result.pageCount, 10);
  assert.equal(result.hasNext, true);
  assert.equal(result.context.db, 'db');
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /LIMIT 100 OFFSET 0$/);
  assert.equal(calls[0].limit, 100);
  assert.match(calls[1].sql, /SELECT COUNT\(\*\) AS total/);

  const tenthPage = await fetchConsolePage({ api, origin: 'http://archery', result, page: 10, pageSize: 100 });
  assert.equal(tenthPage.rows.length, 100);
  assert.equal(tenthPage.rows[0][0], 901);
  assert.equal(tenthPage.page, 10);
  assert.equal(tenthPage.pageCount, 10);
  assert.equal(tenthPage.hasNext, false);
  assert.equal(calls.length, 4);

  const clampedPage = await fetchConsolePage({ api, origin: 'http://archery', result, page: 11, pageSize: 100 });
  assert.equal(clampedPage.page, 10);
  assert.equal(clampedPage.rows[0][0], 901);
  assert.equal(calls.length, 6);

  const partialCalls = [];
  const partialPage = await fetchConsolePage({
    api: pagedApi(2501, partialCalls), origin: 'http://archery', result, page: 2, pageSize: 600,
  });
  assert.equal(partialPage.rows.length, 400);
  assert.equal(partialPage.rows[0][0], 601);
  assert.match(partialCalls[0].sql, /LIMIT 400 OFFSET 600$/);
  assert.equal(partialCalls[0].limit, 400);
}

async function testTableConsoleSqlKeepsAutomaticPagination() {
  const context = { instance: 'inst', db: 'db', schema: '', dbType: 'mysql' };
  const sql = buildTableConsoleSql({
    dbType: 'mysql', table: 'users', schema: '', where: 'status = 1',
    orderBy: [{ col: 'id', dir: 'desc' }], page: 3, pageSize: 100,
  });
  const calls = [];
  const result = await executeConsoleStatement({
    api: pagedApi(2501, calls), origin: 'http://archery', context, sql,
  });
  assert.equal(result.pageable, true);
  assert.equal(result.totalRows, 1000);
  assert.equal(result.pageCount, 10);
  assert.equal(calls.length, 2);
}

async function testTableDataLoadingLimit() {
  const tab = {
    instance: 'inst', db: 'db', schema: '', dbType: 'mysql', table: 'users',
    where: '', orderBy: [], page: 11, pageSize: 100,
  };
  const calls = [];
  const request = prepareTableDataQuery(tab);
  assert.equal(request.page, 10);
  assert.equal(request.limit, 100);
  const loaded = await loadTableData({ api: pagedApi(2501, calls), origin: 'http://archery', tab, request });
  assert.equal(loaded.page, 10);
  assert.equal(loaded.totalRows, 1000);
  assert.equal(loaded.pageCount, 10);
  assert.equal(loaded.data.rows[0][0], 901);
  assert.equal(calls.length, 2);

  const reducedCalls = [];
  const reduced = await loadTableData({ api: pagedApi(150, reducedCalls), origin: 'http://archery', tab, request });
  assert.equal(reduced.page, 2);
  assert.equal(reduced.data.rows.length, 50);
  assert.equal(reduced.totalRows, 150);
  assert.equal(reducedCalls.length, 4);

  const oversized = await loadTableData({
    api: {
      query: async (_origin, options) => (/SELECT COUNT/i.test(options.sql)
        ? { rows: [[100]] }
        : response(makeRows(101), options.sql)),
    },
    origin: 'http://archery', tab: { ...tab, page: 1 },
  });
  assert.match(oversized.dataErr, /超过本次请求上限 100 条/);
}

async function testConsoleCountFailureAndExplicitLimit() {
  const failingCountApi = {
    query: async (_origin, options) => {
      if (/SELECT COUNT/i.test(options.sql)) throw new Error('count failed');
      return response([[1]], options.sql);
    },
  };
  const context = { instance: 'inst', db: 'db', schema: '', dbType: 'mysql' };
  const result = await executeConsoleStatement({
    api: failingCountApi,
    origin: 'http://archery',
    context,
    sql: 'SELECT id FROM users',
  });
  assert.equal(result.ok, true);
  assert.equal(result.totalErr, 'count failed');
  assert.equal(result.rows.length, 1);
  assert.equal(result.hasNext, false);

  const calls = [];
  const limited = await executeConsoleStatement({
    api: { query: async (_origin, options) => { calls.push(options); return response([[1]], options.sql); } },
    origin: 'http://archery',
    context,
    sql: 'SELECT id FROM users LIMIT 10',
  });
  assert.equal(limited.pageable, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].limit, 1000);

  const oversized = await executeConsoleStatement({
    api: { query: async (_origin, options) => response(makeRows(1001), options.sql) },
    origin: 'http://archery', context, sql: 'SELECT id FROM users LIMIT 5000',
  });
  assert.equal(oversized.ok, false);
  assert.match(oversized.error, /超过本次请求上限 1000 条/);
}

async function testFullExports() {
  const tableCalls = [];
  const tableApi = pagedApi(1501, tableCalls);
  const tab = {
    instance: 'inst', db: 'db', schema: '', dbType: 'mysql', table: 'users',
    where: 'status = 1', orderBy: [{ col: 'status', dir: 'asc' }],
    data: { columns, types, rows: [[1]] },
    meta: { columns: [{ name: 'id', type: 'bigint', num: true, pk: true, comment: '' }] },
  };
  const tableExport = await collectTableExport({ api: tableApi, origin: 'http://archery', tab });
  assert.equal(tableExport.rows.length, 1000);
  assert.equal(tableCalls.length, 2);
  assert.match(tableCalls[1].sql, /WHERE status = 1 ORDER BY `status` ASC, `id` ASC LIMIT 1000 OFFSET 0$/);

  const consoleCalls = [];
  const result = {
    sql: 'SELECT id FROM users WHERE status = 1', pageable: true, columns,
    context: Object.freeze({ instance: 'inst', db: 'db', schema: '', dbType: 'mysql' }),
  };
  const consoleExport = await collectConsoleExport({
    api: pagedApi(1200, consoleCalls),
    origin: 'http://archery',
    result,
  });
  assert.equal(consoleExport.rows.length, 1000);
  assert.equal(consoleCalls.length, 2);
  assert.match(consoleCalls[1].sql, /LIMIT 1000 OFFSET 0$/);

  await assert.rejects(() => collectConsoleExport({
    api: pagedApi(0, []), origin: 'http://archery',
    result: { ...result, pageable: false, rows: makeRows(1001) },
  }), /超过本次请求上限 1000 条/);
}

function testQueryRowLimitHelpers() {
  assert.equal(parseCountTotal({ rows: [[1501]] }), 1000);
  assert.deepEqual(queryPageWindow({ page: 2, pageSize: 600 }), {
    page: 2, pageSize: 600, offset: 600, limit: 400,
  });
  assert.equal(
    buildBrowseSql({ dbType: 'mysql', table: 'users', page: 2, pageSize: 600 }),
    'SELECT * FROM `users` LIMIT 400 OFFSET 600',
  );
  assert.equal(
    buildBrowseSql({ dbType: 'pgsql', schema: 'public', table: 'users', page: 2, pageSize: 600 }),
    'SELECT * FROM "public"."users" LIMIT 400 OFFSET 600',
  );
  assert.match(buildCountSql({ dbType: 'mysql', table: 'users', where: 'status = 1' }), /WHERE status = 1\nLIMIT 1000/);
  assert.throws(() => queryPageWindow({ page: 3, pageSize: 600 }), /不能超过前 1000 条/);
  assert.throws(() => queryPageWindow({ page: 1, pageSize: 1001 }), /1 到 1000/);
}

function testConsoleResultView() {
  const baseResult = {
    sql: 'SELECT id FROM users', ok: true, pageable: true, columns, types, rows: [[1]],
    elapsed: 0.01, fullSql: 'SELECT id FROM users LIMIT 100 OFFSET 0', isMasked: false,
    dataLoading: false, dataErr: '', totalLoading: false, totalErr: '',
  };
  const withinLimit = {
    ...baseResult,
    error: '', page: 1, pageSize: 100, totalRows: 1000, pageCount: 10, hasNext: true,
  };
  const withinView = renderConsoleResultView({ results: [withinLimit], activeResult: 0, colW: {}, executedSelection: false });
  assert.doesNotMatch(withinView.html, /共 1,000/);
  assert.match(withinView.html, /本页 1 行/);
  assert.match(withinView.html, /本页 1 条/);
  assert.match(withinView.html, /data-act="con-pagesize"/);
  assert.match(withinView.html, /data-act="con-page"/);
  assert.match(withinView.html, /第 <b>1<\/b> \/ 10 页/);
  assert.match(withinView.html, /<option selected>100<\/option>/);

  const countFailure = { ...withinLimit, totalRows: null, pageCount: null, hasNext: false, totalErr: 'count failed' };
  const failureView = renderConsoleResultView({ results: [countFailure], activeResult: 0, colW: {}, executedSelection: false });
  assert.match(failureView.html, /总数查询失败/);
  assert.doesNotMatch(failureView.html, /data-act="con-page"/);
}

function tableDataTab(totalRows) {
  return {
    subview: 'data', dbType: 'mysql', table: 'users', schema: '', page: 1, pageSize: 100,
    orderBy: [], where: '', whereDraft: '', hasNext: totalRows > 100, colW: {},
    data: { columns, types, rows: [[1]], elapsed: 0.01, isMasked: false },
    dataErr: '', dataLoading: false, totalRows, totalErr: '', totalLoading: false,
    sql: 'SELECT id FROM users LIMIT 100 OFFSET 0',
  };
}

function testTableResultView() {
  const withinView = renderTableView(tableDataTab(1000));
  assert.doesNotMatch(withinView.html, /共 1,000/);
  assert.match(withinView.html, /本页 1 条/);
  assert.match(withinView.html, /data-act="pagesize"/);
  assert.match(withinView.html, /data-act="page"/);

  const countFailure = { ...tableDataTab(null), totalErr: 'count failed' };
  const failureView = renderTableView(countFailure);
  assert.match(failureView.html, /总数查询失败/);
  assert.doesNotMatch(failureView.html, /data-act="page"/);
}

await testConsoleExecutionAndPaging();
await testTableConsoleSqlKeepsAutomaticPagination();
await testTableDataLoadingLimit();
await testConsoleCountFailureAndExplicitLimit();
await testFullExports();
testQueryRowLimitHelpers();
testConsoleResultView();
testTableResultView();
