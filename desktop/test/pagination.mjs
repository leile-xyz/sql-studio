import assert from 'node:assert/strict';
import { executeConsoleStatement, fetchConsolePage } from '../src/lib/console-execution.mjs';
import { renderConsoleResultView } from '../src/lib/console-result-view.mjs';
import { buildTableConsoleSql } from '../src/lib/db-context.mjs';
import { collectConsoleExport, collectTableExport } from '../src/lib/export-service.mjs';

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
  assert.equal(result.pageSize, 1000);
  assert.equal(result.rows.length, 1000);
  assert.equal(result.totalRows, 2501);
  assert.equal(result.pageCount, 3);
  assert.equal(result.context.db, 'db');
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /OFFSET 0$/);
  assert.doesNotMatch(calls[0].sql, /LIMIT/i);
  assert.equal(calls[0].limit, 1000);
  assert.match(calls[1].sql, /SELECT COUNT\(\*\) AS total/);

  const thirdPage = await fetchConsolePage({ api, origin: 'http://archery', result, page: 3, pageSize: 1000 });
  assert.equal(thirdPage.rows.length, 501);
  assert.equal(thirdPage.rows[0][0], 2001);
  assert.equal(thirdPage.page, 3);
  assert.equal(thirdPage.hasNext, false);
  assert.equal(calls.length, 4);
  assert.match(calls[2].sql, /OFFSET 2000$/);
  assert.doesNotMatch(calls[2].sql, /LIMIT/i);
  assert.equal(calls[2].limit, 1000);

  const reduced = await fetchConsolePage({
    api: pagedApi(1500, []),
    origin: 'http://archery',
    result,
    page: 3,
    pageSize: 1000,
  });
  assert.equal(reduced.page, 2);
  assert.equal(reduced.rows.length, 500);
  assert.equal(reduced.totalRows, 1500);
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
  assert.equal(result.totalRows, 2501);
  assert.equal(result.pageCount, 3);
  assert.equal(calls.length, 2);
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
  assert.equal(tableExport.rows.length, 1501);
  assert.equal(tableCalls.length, 3);
  assert.match(tableCalls[1].sql, /WHERE status = 1 ORDER BY `status` ASC, `id` ASC LIMIT 1000 OFFSET 0$/);
  assert.match(tableCalls[2].sql, /LIMIT 1000 OFFSET 1000$/);

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
  assert.equal(consoleExport.rows.length, 1200);
  assert.equal(consoleCalls.length, 3);
}

function testConsoleResultView() {
  const result = {
    sql: 'SELECT id FROM users', ok: true, pageable: true, columns, types, rows: [[1]],
    elapsed: 0.01, fullSql: 'SELECT id FROM users LIMIT 1000 OFFSET 0', isMasked: false,
    error: '', page: 1, pageSize: 1000, totalRows: 2501, pageCount: 3, hasNext: true,
    dataLoading: false, dataErr: '', totalLoading: false, totalErr: '',
  };
  const view = renderConsoleResultView({ results: [result], activeResult: 0, colW: {}, executedSelection: false });
  assert.match(view.html, /共 2,501 条 · 本页 1 条/);
  assert.match(view.html, /data-act="con-pagesize"/);
  assert.match(view.html, /data-act="con-page" data-page="2"/);
  assert.match(view.html, /<option selected>1000<\/option>/);
}

await testConsoleExecutionAndPaging();
await testTableConsoleSqlKeepsAutomaticPagination();
await testConsoleCountFailureAndExplicitLimit();
await testFullExports();
testConsoleResultView();
