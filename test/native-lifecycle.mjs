import assert from 'node:assert/strict';
import {
  createUiSnapshot,
  loadInitialUiState,
  normalizeUiSnapshot,
  registerNativeCloseHandler,
  restoreUiSnapshot,
} from '../src/lib/native-lifecycle.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

function bootstrap(persistent = {}) {
  return {
    mode: { lightweight: false, startupLightweight: false, uiPresent: true },
    persistent,
    runtime: {
      generation: 3,
      mainWindowPresent: true,
      workspaceWebviews: [],
      background: { schedulerManaged: true, mcpRunning: false, archerySessions: 1 },
    },
  };
}

function lightweightBootstrap(persistent = {}) {
  return {
    mode: { lightweight: true, startupLightweight: true, uiPresent: false },
    persistent,
    runtime: {
      generation: 4,
      mainWindowPresent: false,
      workspaceWebviews: [],
      background: { schedulerManaged: true, mcpRunning: true, archerySessions: 0 },
    },
  };
}

function tableTab(overrides = {}) {
  return {
    id: 2,
    type: 'table',
    instance: 'mysql-main',
    db: 'app',
    schema: '',
    dbType: 'mysql',
    table: 'users',
    subview: 'struct',
    where: 'enabled = 1',
    orderBy: [{ col: 'id', dir: 'desc' }],
    page: 2,
    pageSize: 50,
    colW: { id: 120 },
    data: { rows: [[1]] },
    dataLoading: true,
    ...overrides,
  };
}

function testSnapshotSerializationAndRestore() {
  const consoleTab = { id: 1, type: 'console', consoleKey: 'console-0', open: true, sql: 'SELECT 1' };
  const closedConsole = { id: 3, type: 'console', consoleKey: 'console-1', open: false, sql: 'SELECT 2' };
  const source = {
    activeEnvId: 'prod',
    sidebarCollapsed: true,
    activeConsoleKey: 'console-0',
    activeTabId: 2,
    treeSel: { inst: 'mysql-main', db: 'app', schema: '' },
    lastCtx: { inst: 'mysql-main', db: 'app', schema: '' },
    tabs: [consoleTab, tableTab(), closedConsole],
    nodeMap: new Map([['ignored', {}]]),
  };
  const snapshot = createUiSnapshot(source);
  assert.equal(snapshot.version, 1);
  assert.deepEqual(snapshot.tabs.map(tab => tab.type), ['console', 'table']);
  assert.equal(snapshot.tabs[1].data, undefined);
  assert.doesNotThrow(() => JSON.stringify(snapshot));
  const restored = restoreUiSnapshot({
    snapshot,
    tabs: [consoleTab, closedConsole],
    tabSeq: 3,
    activeTabId: 1,
    activeConsoleKey: 'console-0',
    activeEnvId: 'prod',
  });
  assert.deepEqual(restored.tabs.map(tab => tab.type), ['console', 'table', 'console']);
  assert.equal(restored.tabs[1].id, 4);
  assert.equal(restored.tabs[1].data, null);
  assert.equal(restored.tabs[1].where, 'enabled = 1');
  assert.equal(restored.activeTabId, 4);
  assert.equal(restored.sidebarCollapsed, true);
}

async function testBootstrapHydration() {
  const calls = [];
  globalThis.window = {
    __TAURI__: { core: { invoke: async command => {
      calls.push(command);
      return bootstrap({
        sqls_envs: [{ id: 'prod', base: 'db.example.com' }],
        sqls_active_env: 'prod',
        ui_snapshot: { version: 1, activeEnvId: 'prod', sidebarCollapsed: true },
      });
    } } },
  };
  const store = {
    getEnvs: async () => { throw new Error('不应读取环境回退'); },
    getActiveEnvId: async () => { throw new Error('不应读取活动环境回退'); },
  };
  const initial = await loadInitialUiState(store);
  assert.deepEqual(calls, ['bootstrap_state']);
  assert.equal(initial.activeEnvId, 'prod');
  assert.equal(initial.uiSnapshot.sidebarCollapsed, true);

  window.__TAURI__.core.invoke = async () => bootstrap({});
  const fallbackCalls = [];
  const fallback = await loadInitialUiState({
    getEnvs: async () => { fallbackCalls.push('envs'); return [{ id: 'test', base: 'test.example.com' }]; },
    getActiveEnvId: async () => { fallbackCalls.push('active'); return 'test'; },
  });
  assert.deepEqual(fallbackCalls, ['envs', 'active']);
  assert.equal(fallback.activeEnvId, 'test');

  window.__TAURI__.core.invoke = async () => lightweightBootstrap({
    sqls_envs: [{ id: 'test', base: 'test.example.com' }],
    sqls_active_env: 'test',
  });
  const lightweight = await loadInitialUiState({
    getEnvs: async () => [],
    getActiveEnvId: async () => null,
  });
  assert.equal(lightweight.bootstrap.mode.lightweight, true);
  assert.equal(lightweight.bootstrap.mode.startupLightweight, true);
  assert.equal(lightweight.bootstrap.runtime.mainWindowPresent, false);
}

async function testMalformedBootstrapIsExposed() {
  globalThis.window = { __TAURI__: { core: { invoke: async () => bootstrap({
    sqls_envs: [{ id: 'prod', base: 'db.example.com' }],
    sqls_active_env: 'missing',
  }) } } };
  const store = { getEnvs: async () => [], getActiveEnvId: async () => null };
  await assert.rejects(() => loadInitialUiState(store), /活动环境不存在/);
  assert.throws(() => normalizeUiSnapshot({ sidebarCollapsed: 'yes' }), /必须是布尔值/);
  window.__TAURI__.core.invoke = async () => ({ ...bootstrap({}), runtime: { ...bootstrap({}).runtime, generation: -1 } });
  await assert.rejects(() => loadInitialUiState(store), /generation.*非负安全整数/);
}

async function testCloseHandshakeCommitBoundary() {
  const calls = [];
  const listeners = new Map();
  const originalConsoleError = console.error;
  console.error = () => {};
  globalThis.window = {
    __TAURI__: {
      event: { listen: async (event, callback) => { listeners.set(event, callback); return () => {}; } },
      core: { invoke: async command => {
        calls.push(command);
        if (command === 'window_close_ready') throw new Error('页面已经销毁');
      } },
    },
  };
  const errors = [];
  await registerNativeCloseHandler({
    flush: async () => { calls.push('flush'); },
    snapshot: () => ({ version: 1 }),
    cleanup: () => { calls.push('cleanup'); },
    onError: error => errors.push(error.message),
  });
  listeners.get('sql-studio://prepare-window-close')();
  await tick();
  await tick();
  console.error = originalConsoleError;
  assert.deepEqual(calls, ['flush', 'save_ui_snapshot', 'cleanup', 'window_close_ready']);
  assert.deepEqual(errors, []);
  assert.ok(!calls.includes('window_close_failed'));
}

async function testClosePreparationFailure() {
  const calls = [];
  const listeners = new Map();
  globalThis.window = {
    __TAURI__: {
      event: { listen: async (event, callback) => { listeners.set(event, callback); return () => {}; } },
      core: { invoke: async command => { calls.push(command); } },
    },
  };
  const errors = [];
  await registerNativeCloseHandler({
    flush: async () => { throw new Error('flush failed'); },
    snapshot: () => ({}),
    cleanup: () => { calls.push('cleanup'); },
    onError: error => errors.push(error.message),
  });
  listeners.get('sql-studio://prepare-window-close')();
  await tick();
  assert.deepEqual(calls, ['window_close_failed']);
  assert.deepEqual(errors, ['flush failed']);
}

async function testNativeDestroyFailureIsReportedOnce() {
  const listeners = new Map();
  const originalConsoleError = console.error;
  console.error = () => {};
  globalThis.window = {
    __TAURI__: {
      event: { listen: async (event, callback) => { listeners.set(event, callback); return () => {}; } },
      core: { invoke: async command => { if (command === 'window_close_ready') throw new Error('IPC 已关闭'); } },
    },
  };
  const errors = [];
  await registerNativeCloseHandler({
    flush: async () => {},
    snapshot: () => ({ version: 1 }),
    cleanup: () => {},
    onError: error => errors.push(error.message),
  });
  listeners.get('sql-studio://prepare-window-close')();
  await tick();
  listeners.get('sql-studio://window-close-destroy-failed')({ payload: { message: 'destroy failed' } });
  console.error = originalConsoleError;
  assert.deepEqual(errors, ['destroy failed']);
}

testSnapshotSerializationAndRestore();
await testBootstrapHydration();
await testMalformedBootstrapIsExposed();
await testCloseHandshakeCommitBoundary();
await testClosePreparationFailure();
await testNativeDestroyFailureIsReportedOnce();
delete globalThis.window;
console.log('PASS  native lifecycle: bootstrap validation, UI restore and close handshake');
