import assert from 'node:assert/strict';
import { renderTableView } from '../src/lib/table-view.mjs';

function testEmptyTableDataView() {
  const html = renderTableView({
    subview: 'data', dbType: 'mysql', page: 1, pageSize: 100,
    orderBy: [], where: '', hasNext: false, totalRows: 0,
    data: {
      columns: ['id', 'project_name'],
      types: ['LONG', 'VARCHAR'],
      rows: [], elapsed: 0.01,
    },
    dataErr: '', dataLoading: false, sql: 'SELECT * FROM project',
  }).html;
  assert.match(html, /<th [^>]*title="id · LONG">/);
  assert.match(html, /<th [^>]*title="project_name · VARCHAR">/);
  assert.match(html, /查询结果为空/);
  assert.match(html, /当前数据表未返回任何数据/);
  assert.match(html, /共 0 条 · 本页 0 条/);

  const noColumnsHtml = renderTableView({
    subview: 'data', dbType: 'mysql', page: 1, pageSize: 100,
    orderBy: [], where: '', hasNext: false, totalRows: 0,
    data: { columns: [], types: [], rows: [], elapsed: 0.01 },
    dataErr: '', dataLoading: false, sql: 'SELECT 1 WHERE FALSE',
  }).html;
  assert.match(noColumnsHtml, /查询结果为空/);
  assert.doesNotMatch(noColumnsHtml, />无列</);
}

testEmptyTableDataView();
console.log('PASS  table empty state: headers and zero-row data view');
