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

const sessionState = sql => ({
  consoles: [consoleState('console-0', sql)],
  activeConsoleKey: 'console-0',
  nextSequence: 1,
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return Object.freeze({ promise, resolve });
}

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
  manager.schedule('env-a', session);
  await manager.flush();
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

async function testUnchangedSessionDeduplication() {
  const saved = [];
  const stored = sessionState('SELECT persisted;');
  const manager = new ConsoleSessionManager({
    store: {
      getConsoleSession: async () => stored,
      getConsoleDraft: async () => null,
      saveConsoleSession: async (envId, session) => saved.push({ envId, session }),
    },
    onError: error => { throw error; },
    saveDelayMs: 5,
  });
  const loaded = await manager.load('env-a');
  manager.schedule('env-a', loaded);
  manager.schedule('env-a', sessionState('SELECT persisted;'));
  await manager.flush();
  assert.equal(saved.length, 0);

  manager.schedule('env-a', sessionState('SELECT changed;'));
  const firstFlush = manager.flush();
  const secondFlush = manager.flush();
  assert.equal(firstFlush, secondFlush);
  await firstFlush;
  assert.equal(saved.length, 1);
  manager.schedule('env-a', sessionState('SELECT changed;'));
  await manager.flush();
  assert.equal(saved.length, 1);
}

async function testFlushPersistsLastEditWithinDebounceWindow() {
  const saved = [];
  let persisted = null;
  const manager = new ConsoleSessionManager({
    store: {
      getConsoleSession: async () => persisted,
      getConsoleDraft: async () => null,
      saveConsoleSession: async (envId, session) => { saved.push({ envId, session }); persisted = session; },
    },
    onError: error => { throw error; },
    saveDelayMs: 1000,
  });
  manager.schedule('env-a', sessionState('SELECT 1;'));
  manager.schedule('env-a', sessionState('SELECT 2;'));
  manager.schedule('env-a', sessionState('SELECT 3;'));
  await manager.flush();
  assert.equal(saved.length, 1);
  assert.equal(persisted.consoles[0].sql, 'SELECT 3;');
}

async function testRevertToBaselineSkipsWrite() {
  const saved = [];
  const stored = sessionState('SELECT base;');
  const manager = new ConsoleSessionManager({
    store: {
      getConsoleSession: async () => stored,
      getConsoleDraft: async () => null,
      saveConsoleSession: async (envId, session) => saved.push({ envId, session }),
    },
    onError: error => { throw error; },
    saveDelayMs: 5,
  });
  await manager.load('env-a');
  manager.schedule('env-a', sessionState('SELECT edited;'));
  manager.schedule('env-a', sessionState('SELECT base;'));
  await delay(20);
  await manager.flush();
  assert.equal(saved.length, 0);
}

async function testRevertDuringInFlightWriteRestoresBaseline() {
  const writeGate = deferred();
  const saved = [];
  let persisted = sessionState('SELECT base;');
  let gated = false;
  const manager = new ConsoleSessionManager({
    store: {
      getConsoleSession: async () => persisted,
      getConsoleDraft: async () => null,
      saveConsoleSession: async (envId, session) => {
        if (!gated) { gated = true; await writeGate.promise; }
        saved.push({ envId, session });
        persisted = session;
      },
    },
    onError: error => { throw error; },
    saveDelayMs: 5,
  });
  await manager.load('env-a');
  manager.schedule('env-a', sessionState('SELECT edited;'));
  await delay(20);
  manager.schedule('env-a', sessionState('SELECT base;'));
  writeGate.resolve();
  await manager.flush();
  assert.equal(saved.length, 2);
  assert.equal(persisted.consoles[0].sql, 'SELECT base;');
}

async function testFailedSaveRemainsDirty() {
  let attempts = 0;
  const reported = [];
  const manager = new ConsoleSessionManager({
    store: {
      getConsoleSession: async () => null,
      getConsoleDraft: async () => null,
      saveConsoleSession: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('disk full');
      },
    },
    onError: error => reported.push(error.message),
    saveDelayMs: 5,
  });
  manager.schedule('env-a', sessionState('SELECT retry;'));
  await delay(20);
  assert.deepEqual(reported, ['disk full']);
  assert.equal(attempts, 1);
  await manager.flush();
  assert.equal(attempts, 2);
  await manager.flush();
  assert.equal(attempts, 2);
}

async function testFlushWaitsForAllWrites() {
  const slowStarted = deferred();
  const slowGate = deferred();
  let failedAttempts = 0;
  const manager = new ConsoleSessionManager({
    store: {
      getConsoleSession: async () => null,
      getConsoleDraft: async () => null,
      saveConsoleSession: async envId => {
        if (envId === 'env-a') { failedAttempts += 1; throw new Error('env-a failed'); }
        slowStarted.resolve();
        await slowGate.promise;
      },
    },
    onError: () => {},
    saveDelayMs: 100,
  });
  manager.schedule('env-a', sessionState('SELECT A;'));
  manager.schedule('env-b', sessionState('SELECT B;'));
  let settled = false;
  const flush = manager.flush().finally(() => { settled = true; });
  await slowStarted.promise;
  assert.equal(settled, false);
  slowGate.resolve();
  await assert.rejects(flush, /env-a failed/);
  assert.equal(settled, true);
  assert.equal(failedAttempts, 1);
  await assert.rejects(manager.flush(), /env-a failed/);
  assert.equal(failedAttempts, 2);
}

async function testConcurrentFlushDoesNotRetryFailure() {
  let attempts = 0;
  const manager = new ConsoleSessionManager({
    store: {
      getConsoleSession: async () => null,
      getConsoleDraft: async () => null,
      saveConsoleSession: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient failure');
      },
    },
    onError: () => {},
    saveDelayMs: 100,
  });
  manager.schedule('env-a', sessionState('SELECT once;'));
  const firstFlush = manager.flush();
  const secondFlush = manager.flush();
  assert.equal(firstFlush, secondFlush);
  await assert.rejects(firstFlush, /transient failure/);
  assert.equal(attempts, 1);
  await manager.flush();
  assert.equal(attempts, 2);
}

async function testFlushBarrierAbsorbsMicrotaskSchedule() {
  const saved = [];
  const manager = new ConsoleSessionManager({
    store: {
      getConsoleSession: async () => null,
      getConsoleDraft: async () => null,
      saveConsoleSession: async (envId, session) => saved.push({ envId, session }),
    },
    onError: error => { throw error; },
    saveDelayMs: 100,
  });
  let secondFlush;
  const scheduled = Promise.resolve().then(() => {
    manager.schedule('env-a', sessionState('SELECT microtask;'));
    secondFlush = manager.flush();
  });
  const firstFlush = manager.flush();
  await firstFlush;
  await scheduled;
  await secondFlush;
  assert.equal(firstFlush, secondFlush);
  assert.equal(saved.length, 1);
}

async function testLoadJoinsFlushStartedBeforeSchedule() {
  let persisted = null;
  const saves = [];
  const manager = new ConsoleSessionManager({
    store: {
      getConsoleSession: async () => persisted,
      getConsoleDraft: async () => null,
      saveConsoleSession: async (envId, session) => {
        saves.push({ envId, session });
        persisted = session;
      },
    },
    onError: error => { throw error; },
    saveDelayMs: 100,
  });
  const idleFlush = manager.flush();
  let latest;
  let load;
  queueMicrotask(() => {
    latest = manager.schedule('env-a', sessionState('SELECT during flush;'));
    load = manager.load('env-a');
  });
  await idleFlush;
  const loaded = await load;
  assert.deepEqual(loaded, latest);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].session.consoles[0].sql, 'SELECT during flush;');
}

async function testLoadDoesNotOverwriteNewerSession() {
  const readGate = deferred();
  let persisted = null;
  const saves = [];
  const manager = new ConsoleSessionManager({
    store: {
      getConsoleSession: async () => { await readGate.promise; return persisted; },
      getConsoleDraft: async () => ({ sql: 'SELECT legacy;' }),
      saveConsoleSession: async (envId, session) => {
        saves.push({ envId, session });
        persisted = session;
      },
    },
    onError: error => { throw error; },
    saveDelayMs: 100,
  });
  const load = manager.load('env-a');
  const latest = manager.schedule('env-a', sessionState('SELECT newest;'));
  readGate.resolve();
  const loaded = await load;
  assert.deepEqual(loaded, latest);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].session.consoles[0].sql, 'SELECT newest;');
}

async function testConcurrentLoadsShareResult() {
  const readGate = deferred();
  let reads = 0;
  const stored = sessionState('SELECT shared;');
  const manager = new ConsoleSessionManager({
    store: {
      getConsoleSession: async () => { reads += 1; await readGate.promise; return stored; },
      getConsoleDraft: async () => null,
      saveConsoleSession: async () => { throw new Error('load must not write'); },
    },
    onError: error => { throw error; },
  });
  const first = manager.load('env-a');
  const second = manager.load('env-a');
  readGate.resolve();
  assert.deepEqual(await first, stored);
  assert.deepEqual(await second, stored);
  assert.equal(reads, 1);
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
await testUnchangedSessionDeduplication();
await testFlushPersistsLastEditWithinDebounceWindow();
await testRevertToBaselineSkipsWrite();
await testRevertDuringInFlightWriteRestoresBaseline();
await testFailedSaveRemainsDirty();
await testFlushWaitsForAllWrites();
await testConcurrentFlushDoesNotRetryFailure();
await testFlushBarrierAbsorbsMicrotaskSchedule();
await testLoadJoinsFlushStartedBeforeSchedule();
await testLoadDoesNotOverwriteNewerSession();
await testConcurrentLoadsShareResult();
testConsoleWorkspace();
testConsoleMenuViews();
console.log('PASS  console session: deduplicated persistence, reliable flush, restore, naming and launcher views');
