import assert from 'node:assert/strict';
import { describeWorkspaceTab, filterWorkspaceTabs, renderTabBarView, renderTabListResults, tabIdForKey } from '../src/lib/workspace-tabs-view.mjs';

const tabs = Object.freeze([
  Object.freeze({ id: 1, type: 'table', instance: 'warehouse-pg', db: 'workspace', schema: 'public', table: 'provider_model_settings' }),
  Object.freeze({ id: 2, type: 'console', title: '财务核对', instance: 'finance-mysql', db: 'ledger', open: true }),
  Object.freeze({ id: 3, type: 'console', title: '已保存的草稿', open: false }),
  Object.freeze({ id: 4, type: 'table', instance: 'warehouse-pg', db: 'workspace', schema: 'audit', table: 'provider_model_settings' }),
]);
const icons = Object.freeze({ consoleIcon: '<svg></svg>', tableIcon: '<svg></svg>' });

function testSearch() {
  assert.deepEqual(filterWorkspaceTabs(tabs).map(tab => tab.id), [1, 2, 4]);
  assert.deepEqual(filterWorkspaceTabs(tabs, ' PROVIDER  AUDIT ').map(tab => tab.id), [4]);
  assert.deepEqual(filterWorkspaceTabs(tabs, 'warehouse-pg public').map(tab => tab.id), [1]);
  assert.deepEqual(filterWorkspaceTabs(tabs, '财务 ledger').map(tab => tab.id), [2]);
  assert.deepEqual(filterWorkspaceTabs(tabs, '已保存'), []);
  assert.deepEqual(filterWorkspaceTabs(tabs, '不存在'), []);
  assert.deepEqual(filterWorkspaceTabs([], ''), []);
  assert.equal(tabs[2].open, false);
}

function testKeyboardOrder() {
  const target = (id, key) => tabIdForKey({ tabs, activeTabId: id, key });
  assert.equal(target(2, 'ArrowRight'), 4);
  assert.equal(target(4, 'ArrowRight'), 1);
  assert.equal(target(1, 'ArrowLeft'), 4);
  assert.equal(target(4, 'Home'), 1);
  assert.equal(target(1, 'End'), 4);
  assert.equal(target(3, 'ArrowRight'), null);
  assert.equal(target(1, 'Escape'), null);
  assert.equal(tabIdForKey({ tabs: [], activeTabId: null, key: 'Home' }), null);
}

function testSourcesAndEscaping() {
  assert.equal(describeWorkspaceTab(tabs[0]).source, 'warehouse-pg / workspace.public');
  assert.equal(describeWorkspaceTab(tabs[3]).context, 'workspace.audit');
  assert.equal(describeWorkspaceTab({ type: 'console', title: 'console' }).context, '未选择数据源');
  const unsafe = Object.freeze({ ...tabs[0], id: 5, table: 'audit_"<snapshot>&', instance: 'pg" onclick="alert(1)' });
  const bar = renderTabBarView({ ...icons, tabs: [...tabs, unsafe], activeTabId: 2 });
  assert.ok(!bar.includes('<snapshot>'));
  assert.ok(!bar.includes(' onclick="alert(1)'));
  assert.ok(bar.includes('audit_&quot;&lt;snapshot&gt;&amp;'));
  assert.ok(!bar.includes('已保存的草稿'));
  assert.ok(bar.includes('共 4 个'));
  const results = renderTabListResults({ ...icons, tabs: [unsafe], activeTabId: 5, selectedId: 5 });
  assert.ok(!results.includes('<snapshot>'));
  assert.ok(results.includes('aria-selected="true"'));
  assert.ok(results.includes('当前'));
  const empty = renderTabBarView({ ...icons, tabs: [], activeTabId: null });
  assert.ok(empty.includes('打开表或新建查询'));
  assert.ok(empty.includes('aria-expanded="false" disabled'));
}

testSearch();
testKeyboardOrder();
testSourcesAndEscaping();
console.log('PASS workspace tabs: visible-tab search, source identity, keyboard navigation and escaped names');
