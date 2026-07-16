import assert from 'node:assert/strict';
import { renderExecutionDetail } from '../src/lib/execution-detail.mjs';

const tableDetail = renderExecutionDetail({
  status: 'succeeded',
  workflowName: '日报流水线',
  versionNumber: 2,
  triggerType: 'manual',
  dataSource: { instanceName: 'mysql', databaseName: 'finance' },
  nodeExecutions: [{ name: 'SQL 执行', status: 'succeeded', durationMs: 120 }],
  artifacts: [{ type: 'table', columns: ['id'], rows: [[1]], rowCount: 1 }],
});

assert.match(tableDetail, /class="execution-detail"/);
assert.match(tableDetail, /日报流水线/);
assert.match(tableDetail, /执行成功/);
assert.match(tableDetail, /手动执行/);
assert.match(tableDetail, /<td>1<\/td>/);

const messageDetail = renderExecutionDetail({
  status: 'succeeded',
  artifacts: [{ artifactType: 'message', value: { format: 'markdown', title: '日报', body: '### 完成\n\n| 项目 | 状态 |\n| --- | --- |\n| A | **成功** |\n\n- 已推送\n<script>' } }],
});
assert.match(messageDetail, /Markdown 消息/);
assert.match(messageDetail, /<h3>完成<\/h3>/);
assert.match(messageDetail, /<table>/);
assert.match(messageDetail, /<strong>成功<\/strong>/);
assert.match(messageDetail, /<li>已推送<\/li>/);
assert.match(messageDetail, /查看原始内容/);
assert.match(messageDetail, /返回渲染视图/);
assert.doesNotMatch(messageDetail, /<script>/);
assert.doesNotMatch(renderExecutionDetail({ status: 'failed', errorMessage: '<script>' }), /<script>/);

console.log('PASS  execution detail: hierarchy, localized status, artifacts and escaping');
