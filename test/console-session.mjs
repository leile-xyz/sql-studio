import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { renderAllConsolesMenuView, renderConsoleMenuView, renderTabBarView, renderTabContextMenuView } from '../src/lib/console-menu-view.mjs';
import { renameConsoleTitle } from '../src/lib/console-rename.mjs';
import { ConsoleSessionManager } from '../src/lib/console-session.mjs';
import { closeWorkspaceTab, closeWorkspaceTabs, consoleIdentity, consoleSessionState, createNewConsole, defaultConsoleTab, deleteWorkspaceConsole, restoreConsoleWorkspace, visibleTabs } from '../src/lib/console-workspace.mjs';

const consoleState = (key, sql, open = true) => ({
  consoleKey: key,
  title: key === 'console-0' ? 'console' : 'console_1',
  sql,
  instance: 'mock-pg',
  db: 'dify',
  schema: 'public',
  dbType: 'pgsql',
  edH: 220,
  open,
});

async function testLegacyDraftMigration() {
  const saved = [];
  const manager = new ConsoleSessionManager({
    store: {
      getConsoleSession: async () => null,
      getConsoleDraft: async () => ({ sql: 'SELECT legacy;', instance: 'mock', db: 'demo' }),
      saveConsoleSession: async (envId, session) => saved.push({ envId, session }),
    },
    onError: error => { throw error; },
  });
  const session = await manager.load('env-a');
  assert.equal(session.consoles[0].consoleKey, 'console-0');
  assert.equal(session.consoles[0].sql, 'SELECT legacy;');
  assert.equal(session.activeConsoleKey, 'console-0');
  assert.equal(session.nextSequence, 1);
  assert.equal(session.consoles[0].open, true);
  assert.equal(saved.length, 1);
}

async function testSessionScheduling() {
  const saved = [];
  const manager = new ConsoleSessionManager({
    store: {
      getConsoleSession: async () => null,
      getConsoleDraft: async () => null,
      saveConsoleSession: async (envId, session) => saved.push({ envId, session }),
    },
    onError: error => { throw error; },
    saveDelayMs: 5,
  });
  manager.schedule('env-a', {
    consoles: [consoleState('console-0', 'SELECT 1;')],
    activeConsoleKey: 'console-0',
    nextSequence: 1,
  });
  const latest = manager.schedule('env-a', {
    consoles: [consoleState('console-0', 'SELECT 2;'), consoleState('console-1', 'SELECT 3;')],
    activeConsoleKey: 'console-1',
    nextSequence: 2,
  });
  assert.ok(Object.isFrozen(latest) && Object.isFrozen(latest.consoles));
  assert.ok(latest.consoles.every(Object.isFrozen));
  await delay(20);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].session.consoles.length, 2);
  assert.equal(saved[0].session.activeConsoleKey, 'console-1');

  manager.schedule('env-a', { consoles: [], activeConsoleKey: null, nextSequence: 2 });
  manager.schedule('env-b', {
    consoles: [consoleState('console-0', 'SELECT B;')], activeConsoleKey: 'console-0', nextSequence: 1,
  });
  await manager.flush();
  assert.deepEqual(saved.slice(-2).map(item => item.envId), ['env-a', 'env-b']);
  assert.equal(saved.at(-2).session.consoles.length, 0);
  assert.throws(() => manager.schedule('env-a', {
    consoles: [consoleState('console-0', 'A'), consoleState('console-0', 'B')],
    activeConsoleKey: 'console-0',
    nextSequence: 1,
  }), /控制台标识重复/);
  assert.throws(() => manager.schedule('env-a', {
    consoles: [consoleState('console-0', 'A', false)], activeConsoleKey: 'console-0', nextSequence: 1,
  }), /活动控制台已关闭/);
}

function testConsoleWorkspace() {
  assert.deepEqual(consoleIdentity(0), { consoleKey: 'console-0', title: 'console', nextSequence: 1 });
  const first = createNewConsole({
    id: 1,
    sequence: 0,
    currentTab: null,
    lastContext: { inst: 'mock-pg', db: 'dify', schema: 'public' },
    instances: [{ instance_name: 'mock-pg', db_type: 'pgsql' }],
    findDbType: () => 'pgsql',
  });
  assert.equal(first.tab.title, 'console');
  assert.equal(first.tab.schema, 'public');
  const state = consoleSessionState({ tabs: [first.tab, { id: 2, type: 'table' }], activeConsoleKey: 'console-0', nextSequence: 1 });
  assert.equal(state.consoles.length, 1);
  assert.equal(defaultConsoleTab([first.tab, { id: 2, type: 'console' }]), first.tab);
  const second = { ...first.tab, id: 2, consoleKey: 'console-1', title: 'console_1' };
  const closed = closeWorkspaceTab({
    tabs: [first.tab, second], id: 1, activeTabId: 1, activeConsoleKey: 'console-0',
  });
  assert.equal(closed.tabs[0], first.tab);
  assert.equal(closed.tabs[0].open, false);
  assert.equal(visibleTabs(closed.tabs).length, 1);
  assert.equal(closed.activeTabId, 2);
  assert.equal(consoleSessionState({ tabs: closed.tabs, activeConsoleKey: 'console-1', nextSequence: 2 }).consoles.length, 2);
  const batchConsoleA = { ...first.tab, open: true };
  const batchConsoleB = { ...second, open: true };
  const tableA = { id: 3, type: 'table', table: 'a' };
  const tableB = { id: 4, type: 'table', table: 'b' };
  const closeRight = closeWorkspaceTabs({
    tabs: [batchConsoleA, batchConsoleB, tableA, tableB], id: 2, mode: 'right', activeTabId: 4, activeConsoleKey: 'console-1',
  });
  assert.deepEqual(closeRight.closed, [tableA, tableB]);
  assert.deepEqual(closeRight.tabs, [batchConsoleA, batchConsoleB]);
  assert.equal(closeRight.activeTabId, 2);
  assert.equal(closeRight.activeConsoleKey, 'console-1');
  const closeOthers = closeWorkspaceTabs({
    tabs: [{ ...batchConsoleA }, { ...batchConsoleB }, tableA, tableB], id: 3, mode: 'others', activeTabId: 2, activeConsoleKey: 'console-1',
  });
  assert.deepEqual(visibleTabs(closeOthers.tabs), [tableA]);
  assert.equal(closeOthers.activeTabId, 3);
  assert.equal(closeOthers.activeConsoleKey, null);
  const closeAll = closeWorkspaceTabs({
    tabs: [{ ...batchConsoleA }, { ...batchConsoleB }, tableA], id: 3, mode: 'all', activeTabId: 3, activeConsoleKey: 'console-1',
  });
  assert.equal(visibleTabs(closeAll.tabs).length, 0);
  assert.equal(closeAll.activeTabId, null);
  assert.equal(closeAll.activeConsoleKey, null);
  assert.throws(() => closeWorkspaceTabs({
    tabs: [tableA], id: 3, mode: 'invalid', activeTabId: 3, activeConsoleKey: null,
  }), /未知标签页关闭模式/);
  const adjacent = closeWorkspaceTab({
    tabs: [
      { ...first.tab, id: 10, consoleKey: 'console-0', open: false },
      { ...second, id: 11, consoleKey: 'console-1', open: true },
      { ...second, id: 12, consoleKey: 'console-2', open: true },
    ],
    id: 12,
    activeTabId: 12,
    activeConsoleKey: 'console-2',
  });
  assert.equal(adjacent.activeTabId, 11);
  assert.equal(adjacent.activeConsoleKey, 'console-1');
  const deleted = deleteWorkspaceConsole({
    tabs: adjacent.tabs, id: 11, activeTabId: 11, activeConsoleKey: 'console-1',
  });
  assert.equal(deleted.tabs.length, 2);
  assert.equal(deleted.activeTabId, null);
  assert.equal(deleted.activeConsoleKey, null);
  assert.equal(consoleSessionState({ tabs: deleted.tabs, activeConsoleKey: null, nextSequence: 3 }).nextSequence, 3);
  const tableActive = deleteWorkspaceConsole({
    tabs: [{ id: 20, type: 'table' }, second, { ...second, id: 21, consoleKey: 'console-2' }],
    id: second.id,
    activeTabId: 20,
    activeConsoleKey: second.consoleKey,
  });
  assert.equal(tableActive.activeTabId, 20);
  assert.equal(tableActive.activeConsoleKey, 'console-2');
  assert.equal(deleteWorkspaceConsole({ tabs: tableActive.tabs, id: 999, activeTabId: 20, activeConsoleKey: 'console-2' }), null);
  const renamed = renameConsoleTitle({ consoles: closed.tabs, consoleKey: 'console-0', title: '  财务 <&> 控制台  ' });
  assert.equal(renamed, closed.tabs[0]);
  assert.equal(renamed.title, '财务 <&> 控制台');
  assert.equal(renamed.open, false);
  assert.throws(() => renameConsoleTitle({ consoles: closed.tabs, consoleKey: 'console-0', title: '   ' }), /请输入控制台名称/);
  assert.equal(renameConsoleTitle({ consoles: closed.tabs, consoleKey: 'missing', title: 'x' }), null);
  const restored = restoreConsoleWorkspace({
    consoles: [consoleState('console-0', 'SELECT 1;', false), consoleState('console-1', 'SELECT 2;')],
    activeConsoleKey: 'console-1',
    nextSequence: 2,
  }, 10);
  assert.equal(restored.tabs.length, 2);
  assert.equal(restored.activeTabId, 12);
  assert.equal(restored.nextSequence, 2);
  assert.equal(restored.tabs[1].sql, 'SELECT 2;');
}

function testConsoleMenuViews() {
  const tabs = [
    { id: 1, type: 'console', title: 'console', consoleKey: 'console-0', open: false },
    { id: 2, type: 'console', title: 'console_1', consoleKey: 'console-1' },
  ];
  const tabBar = renderTabBarView({ tabs, activeTabId: 2, consoleIcon: '<svg></svg>', tableIcon: '' });
  assert.ok(tabBar.indexOf('console-launcher-wrap') < tabBar.indexOf('tabs-scroll'));
  assert.ok(!tabBar.includes('data-act="new-console"'));
  assert.ok(!tabBar.includes('title="console"'));
  const menu = renderConsoleMenuView({ consoles: tabs, activeTabId: 2 });
  assert.ok(menu.includes('新建查询控制台'));
  assert.ok(menu.includes('默认查询控制台'));
  assert.ok(menu.includes('data-act="show-all-consoles"'));
  assert.ok(!menu.includes('显示控制台文件夹'));
  const all = renderAllConsolesMenuView({ consoles: tabs, activeTabId: 2 });
  assert.ok(all.includes('console') && all.includes('console_1'));
  assert.ok(!all.includes('已关闭'));
  assert.equal((all.match(/data-act="delete-console"/g) || []).length, 2);
  assert.equal((menu.match(/data-act="delete-console"/g) || []).length, 1);
  assert.equal((all.match(/data-act="rename-console"/g) || []).length, 2);
  assert.equal((menu.match(/data-act="rename-console"/g) || []).length, 1);
  const tabMenu = renderTabContextMenuView({ tabId: 2, hasOthers: true, hasRight: false });
  assert.ok(tabMenu.includes('关闭其他'));
  assert.ok(tabMenu.includes('全部关闭'));
  assert.ok(tabMenu.includes('data-mode="others"'));
  assert.ok(!tabMenu.includes('data-mode="right"'));
}

await testLegacyDraftMigration();
await testSessionScheduling();
testConsoleWorkspace();
testConsoleMenuViews();
console.log('PASS  console session: migration, persistence, restore, naming and launcher views');
