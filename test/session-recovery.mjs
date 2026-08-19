import assert from 'node:assert/strict';
import { createSessionRecovery } from '../src/lib/session-recovery.mjs';

async function testSavedCredentialRecovery() {
  const calls = [];
  const recovered = [];
  const recover = createSessionRecovery({
    getCredential: async () => ({ user: 'tester', password: 'pass123', remember: true }),
    login: async (...args) => calls.push(args),
    onRecovered: async session => recovered.push(session),
  });
  await recover({ envId: 'env-a', username: 'tester', origin: 'http://archery' });
  assert.deepEqual(calls, [['env-a', 'http://archery', 'tester', 'pass123']]);
  assert.deepEqual(recovered, [{ envId: 'env-a', username: 'tester', origin: 'http://archery' }]);
}

async function testMissingCredentialFailure() {
  let failure;
  const recover = createSessionRecovery({
    getCredential: async () => ({ user: 'tester', password: '', remember: false }),
    login: async () => assert.fail('无保存密码时不应发起登录'),
    onFailure: async (session, error) => { failure = { session, message: error.message }; },
  });
  await assert.rejects(
    () => recover({ envId: 'env-a', username: 'tester', origin: 'http://archery' }),
    /未找到已保存的登录凭据/,
  );
  assert.deepEqual(failure, {
    session: { envId: 'env-a', username: 'tester', origin: 'http://archery' },
    message: '会话已过期，未找到已保存的登录凭据，请重新登录',
  });
}

async function testUsernameMismatchFailure() {
  const recover = createSessionRecovery({
    getCredential: async () => ({ user: 'saved-user', password: 'pass123', remember: true }),
    login: async () => assert.fail('用户名不一致时不应发起登录'),
  });
  await assert.rejects(
    () => recover({ envId: 'env-a', username: 'current-user', origin: 'http://archery' }),
    /用户名与当前会话不一致/,
  );
}

async function testConcurrentRequestRecovery() {
  const calls = [];
  const recoverySessions = [];
  let expiredRequests = 2;
  globalThis.window = {
    __TAURI__: {
      core: {
        invoke: async (command, args) => {
          calls.push({ command, args });
          if (command === 'api_get') {
            if (expiredRequests > 0) {
              expiredRequests -= 1;
              throw '未登录或会话已过期，请重新登录';
            }
            return [];
          }
          return null;
        },
      },
    },
  };
  try {
    const { api } = await import('../src/lib/api.js?concurrent-session-recovery');
    const origin = 'http://archery-recovery';
    api.setSession('env-recovery', 'tester', origin);
    api.setSessionRecovery(async session => {
      recoverySessions.push(session);
      await api.login(session.envId, session.origin, session.username, 'pass123');
    });
    const [first, second] = await Promise.all([api.instances(origin), api.instances(origin)]);
    assert.deepEqual(first, []);
    assert.deepEqual(second, []);
    assert.equal(calls.filter(call => call.command === 'login').length, 1);
    assert.equal(calls.filter(call => call.command === 'api_get').length, 4);
    assert.deepEqual(recoverySessions, [{ envId: 'env-recovery', username: 'tester', origin }]);
  } finally {
    delete globalThis.window;
  }
}

async function testPostRequestRecovery() {
  const calls = [];
  let expired = true;
  globalThis.window = {
    __TAURI__: {
      core: {
        invoke: async (command, args) => {
          calls.push({ command, args });
          if (command === 'api_post' && expired) {
            expired = false;
            throw '未登录或会话已过期，请重新登录';
          }
          if (command === 'api_post') {
            return { column_list: ['id'], column_type: [], rows: [[1]], full_sql: 'SELECT 1' };
          }
          return null;
        },
      },
    },
  };
  try {
    const { api } = await import('../src/lib/api.js?post-session-recovery');
    const origin = 'http://archery-post';
    api.setSession('env-post', 'tester', origin);
    api.setSessionRecovery(async session => api.login(session.envId, session.origin, session.username, 'pass123'));
    const result = await api.query(origin, { instance: 'inst', db: 'db', sql: 'SELECT 1', limit: 1 });
    assert.deepEqual(result.rows, [[1]]);
    assert.equal(calls.filter(call => call.command === 'login').length, 1);
    assert.equal(calls.filter(call => call.command === 'api_post').length, 2);
  } finally {
    delete globalThis.window;
  }
}

await testSavedCredentialRecovery();
await testMissingCredentialFailure();
await testUsernameMismatchFailure();
await testConcurrentRequestRecovery();
await testPostRequestRecovery();
console.log('PASS  session recovery: saved credentials, explicit failure and concurrent retry deduplication');
