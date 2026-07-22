import assert from 'node:assert/strict';

const state = new Map();
const calls = [];
let failNextHistorySet = false;

function clone(value) {
  return value == null ? value : structuredClone(value);
}

globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async (command, args = {}) => {
        calls.push({ command, args: clone(args) });
        if (command === 'kv_get') return clone(state.get(args.key));
        if (command === 'kv_set') {
          if (args.key === 'sqls_history' && failNextHistorySet) {
            failNextHistorySet = false;
            throw new Error('history write failed');
          }
          state.set(args.key, clone(args.value));
          return null;
        }
        if (command === 'cred_delete') return null;
        throw new Error(`unexpected invoke: ${command}`);
      },
    },
  },
};

const store = await import(`../src/lib/store.js?store-regression=${Date.now()}`);

function resetStore(values = {}) {
  state.clear();
  calls.length = 0;
  failNextHistorySet = false;
  for (const [key, value] of Object.entries(values)) state.set(key, clone(value));
}

async function testReplaceEnvsClearsRemovedCredentials() {
  resetStore({
    sqls_envs: [{ id: 'keep', base: 'keep.example' }, { id: 'remove', base: 'remove.example' }],
    sqls_creds: {
      keep: { user: 'alice', remember: true },
      remove: { user: 'bob', remember: true },
    },
  });
  await store.replaceEnvs([{ id: 'keep', base: 'keep.example', scheme: 'https' }]);
  assert.deepEqual(state.get('sqls_envs'), [{ id: 'keep', base: 'keep.example', scheme: 'https' }]);
  assert.deepEqual(state.get('sqls_creds'), { keep: { user: 'alice', remember: true } });
  assert.deepEqual(calls.filter(call => call.command === 'cred_delete'), [
    { command: 'cred_delete', args: { envId: 'remove' } },
  ]);
}

async function testHistoryMutationsAreSerialized() {
  resetStore({ sqls_history: {} });
  const first = store.addHistory('env', { id: 1 });
  const second = store.addHistory('env', { id: 2 });
  await Promise.all([first, second]);
  assert.deepEqual(state.get('sqls_history').env.map(item => item.id), [2, 1]);
  const historyCalls = calls.filter(call => call.args?.key === 'sqls_history');
  assert.equal(historyCalls.length, 4);
}

async function testFailedMutationDoesNotPoisonQueue() {
  resetStore({ sqls_history: {} });
  failNextHistorySet = true;
  const first = store.addHistory('env', { id: 1 });
  const second = store.addHistory('env', { id: 2 });
  await assert.rejects(first, /history write failed/);
  await second;
  assert.deepEqual(state.get('sqls_history').env.map(item => item.id), [2]);
}

async function testClearAndAddKeepCallOrder() {
  resetStore({ sqls_history: { env: [{ id: 1 }], other: [{ id: 9 }] } });
  await Promise.all([store.addHistory('env', { id: 2 }), store.clearHistory('env')]);
  assert.equal(state.get('sqls_history').env, undefined);

  resetStore({ sqls_history: { env: [{ id: 1 }] } });
  await Promise.all([store.clearHistory('env'), store.addHistory('env', { id: 2 })]);
  assert.deepEqual(state.get('sqls_history').env.map(item => item.id), [2]);
}

await testReplaceEnvsClearsRemovedCredentials();
await testHistoryMutationsAreSerialized();
await testFailedMutationDoesNotPoisonQueue();
await testClearAndAddKeepCallOrder();
console.log('PASS  store: environment credential cleanup and serialized history mutations');
