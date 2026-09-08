import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { report } from './helpers.js';
import { transition } from '../src/kernel.js';

test('creation is atomic with outbox and idempotent; reused payload cannot change objective', () => {
  const store = new Store(':memory:');
  try {
    const input = { commandId: 'create-1', objective: 'fix' };
    const run = store.start(input, 'A:/attempts', {});
    assert.deepEqual(store.start(input, 'A:/attempts', {}), run);
    assert.equal(store.all().length, 1);
    assert.deepEqual(store.pending(), [run.id]);
    assert.equal(store.events(run.id, 0).length, 1);
    assert.throws(() => store.start({ ...input, objective: 'other' }, 'A:/attempts', {}), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal(store.events(run.id, 0).length, 1);
  } finally { store.close(); }
});

test('revision conflicts roll back; cancellation retries return original receipt', () => {
  const store = new Store(':memory:');
  try {
    const run = store.start({ commandId: 'start', objective: 'fix' }, 'A:/attempts', {});
    assert.throws(() => store.cancel(run.id, { commandId: 'cancel', expectedRevision: 99, type: 'cancel' }), { code: 'REVISION_CONFLICT' });
    assert.equal(store.get(run.id).revision, 0);
    const command = { commandId: 'cancel', expectedRevision: 0, type: 'cancel' as const };
    const result = store.cancel(run.id, command);
    assert.equal(result.phase, 'cancelled');
    assert.deepEqual(store.cancel(run.id, command), result);
    assert.deepEqual(store.pending(), []);
  } finally { store.close(); }
});

test('attempt credential, epoch, digest, checkpoint and final submission are independent of the gate', () => {
  const store = new Store(':memory:');
  try {
    const run = store.start({ commandId: 'start', objective: 'fix' }, 'A:/attempts', {});
    store.claim(run.id, 'secret'); store.move(run.id, 'running');
    const input = { commandId: 'submit', epoch: 1, inputDigest: run.order.inputDigest, report };
    assert.throws(() => store.bridge(run.order.attemptId, 'wrong', 'submit', input), { code: 'UNAUTHORIZED' });
    assert.throws(() => store.bridge(run.order.attemptId, 'secret', 'submit', { ...input, epoch: 2 }), { code: 'RESULT_STALE' });
    assert.throws(() => store.bridge(run.order.attemptId, 'secret', 'submit', { ...input, inputDigest: 'a'.repeat(64) }), { code: 'RESULT_STALE' });
    store.bridge(run.order.attemptId, 'secret', 'checkpoint', { ...input, commandId: 'cp' });
    assert.equal(store.get(run.id).report, undefined);
    const received = store.bridge(run.order.attemptId, 'secret', 'submit', input);
    assert.equal(received.phase, 'running');
    assert.equal(received.gate, 'not_evaluated');
    store.move(run.id, 'submitted');
    assert.deepEqual(store.bridge(run.order.attemptId, 'secret', 'submit', input), received);
    assert.throws(() => store.bridge(run.order.attemptId, 'secret', 'submit', { ...input, commandId: 'late' }), { code: 'RESULT_STALE' });
    assert.throws(() => transition(store.get(run.id), 'running'), { code: 'INVALID_TRANSITION' });
  } finally { store.close(); }
});

test('restart preserves undispatched outbox; ambiguous dispatch is quarantined, not retried', () => {
  const store = new Store(':memory:');
  try {
    const queued = store.start({ commandId: 'one', objective: 'fix' }, 'A:/attempts', {});
    const claimed = store.start({ commandId: 'two', objective: 'fix' }, 'A:/attempts', {});
    store.claim(claimed.id, 'secret');
    store.recover();
    assert.deepEqual(store.pending(), [queued.id]);
    assert.equal(store.get(claimed.id).phase, 'blocked');
    assert.throws(() => store.claim(claimed.id, 'secret'), { code: 'DISPATCH_CLAIMED' });
  } finally { store.close(); }
});

test('state directory is bound to source and execution profile', () => {
  const store = new Store(':memory:');
  try {
    store.bindProfile({ source: 'a', model: 'one' });
    store.bindProfile({ model: 'one', source: 'a' });
    assert.throws(() => store.bindProfile({ source: 'b', model: 'one' }), { code: 'PROFILE_CHANGED' });
  } finally { store.close(); }
});
