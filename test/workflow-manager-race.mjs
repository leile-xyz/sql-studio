import assert from 'node:assert/strict';
import {
  commitLatestWorkflowRequest,
  createWorkflowRequestGate,
} from '../src/lib/workflow-manager.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(promiseResolve => { resolve = promiseResolve; });
  return Object.freeze({ promise, resolve });
}

async function verifyLatestResponseWins(channel) {
  let activeEnvironmentId = 'env-a';
  const gate = createWorkflowRequestGate(() => activeEnvironmentId);
  const committed = [];
  const first = deferred();
  const second = deferred();
  const firstRequest = gate.begin({ channel, subjectId: 'first' });
  const firstCommit = commitLatestWorkflowRequest({
    gate, request: firstRequest, load: () => first.promise, commit: value => committed.push(value),
  });
  const secondRequest = gate.begin({ channel, subjectId: 'second' });
  const secondCommit = commitLatestWorkflowRequest({
    gate, request: secondRequest, load: () => second.promise, commit: value => committed.push(value),
  });

  second.resolve('second');
  assert.equal(await secondCommit, true);
  first.resolve('first');
  assert.equal(await firstCommit, false);
  assert.deepEqual(committed, ['second']);

  const environmentRequest = gate.begin({ channel, subjectId: 'old-environment' });
  const environmentResponse = deferred();
  const environmentCommit = commitLatestWorkflowRequest({
    gate, request: environmentRequest, load: () => environmentResponse.promise, commit: value => committed.push(value),
  });
  activeEnvironmentId = 'env-b';
  environmentResponse.resolve('old-environment');
  assert.equal(await environmentCommit, false);
  assert.deepEqual(committed, ['second']);
}

await verifyLatestResponseWins('list');
await verifyLatestResponseWins('selection');
await verifyLatestResponseWins('history');

const gate = createWorkflowRequestGate(() => 'env-a');
const failedRequest = gate.begin({ channel: 'list' });
const expectedError = new Error('network failed');
await assert.rejects(
  commitLatestWorkflowRequest({
    gate,
    request: failedRequest,
    load: () => Promise.reject(expectedError),
    commit: () => assert.fail('failed requests must not commit'),
  }),
  expectedError,
);

console.log('PASS  workflow manager: stale list, environment, selection and history responses cannot commit');
