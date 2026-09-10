import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '../src/client.js';
import { Store } from '../src/store.js';
import { Runtime } from '../src/runtime.js';
import { serve } from '../src/server.js';
import { startSchema, type BudgetCommand, type Run } from '../src/contracts.js';
import { FakeExecutor, setup, waitFor, report } from './helpers.js';

const policy = { commands: [{ id: 'accept', executable: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 5000 }] };
const spec = { requirements: [], writeScope: { files: [], trees: ['.'] } };
function increase(run: Run, maxModelAttempts: number, commandId = 'budget'): BudgetCommand {
  return { type: 'budget', commandId, expectedRevision: run.revision, expectedBudgetRevision: run.budget!.revision,
    maxModelAttempts, reason: 'User explicitly allocated more implementation/review attempts' };
}
async function submit(instance: FakeExecutor['instances'][number], failedReview = false) {
  const review = instance.order.role === 'review';
  await new Client(instance.bridge.url, instance.bridge.token).bridge(instance.order.attemptId, 'submit', {
    commandId: 'submit', epoch: instance.order.epoch, inputDigest: instance.order.inputDigest,
    report: review ? { ...report, review: { functionality: failedReview ? 'fail' : 'pass', completeness: 'pass', findings: [] } } : report,
  }); instance.finish();
}
const paused = (store: Store, id: string) => waitFor(() => { const r = store.get(id); return r.phase === 'paused' ? r : undefined; });
const verified = (store: Store, id: string) => waitFor(() => { const r = store.get(id); return r.phase === 'verified' ? r : undefined; });

test('budget schema rejects invalid limits and does not confuse attempts with token/money limits', () => {
  for (const maxModelAttempts of [-1, 0.5, 1001, Infinity]) assert.equal(startSchema.safeParse({ commandId: 'start', objective: 'Fix', budget: { maxModelAttempts } }).success, false);
  assert.equal(startSchema.safeParse({ commandId: 'start', objective: 'Fix', budget: { maxModelAttempts: 2, tokens: 1000 } }).success, false);
  assert.equal(startSchema.safeParse({ commandId: 'start', objective: 'Fix', budget: { maxModelAttempts: 0 } }).success, true);
});

test('zero budget pauses without launching; explicit idempotent allocation does not resume and worker credentials cannot allocate', async () => {
  const fake = new FakeExecutor(), f = await setup(fake);
  try {
    const run = await f.client.start({ commandId: 'start', objective: 'Fix', budget: { maxModelAttempts: 0 } });
    const stopped = await paused(f.store, run.id);
    assert.equal(fake.instances.length, 0); assert.equal(stopped.reason, 'BUDGET_EXHAUSTED');
    assert.equal(stopped.budget?.reservedModelAttempts, 0); assert.equal(stopped.gate, 'not_evaluated');
    await assert.rejects(f.client.control(run.id, { commandId: 'resume-denied', type: 'resume', expectedRevision: stopped.revision }), { code: 'BUDGET_EXHAUSTED' });
    const command = increase(stopped, 1);
    const [allocated, replay] = await Promise.all([f.client.control(run.id, command), f.client.control(run.id, command)]);
    assert.deepEqual(allocated, replay); assert.equal(allocated.phase, 'paused'); assert.equal(fake.instances.length, 0);
    assert.equal(allocated.budget?.lastIncrease?.reason, command.reason);
    await assert.rejects(f.client.control(run.id, { ...command, reason: 'Changed' }), { code: 'IDEMPOTENCY_CONFLICT' });
    await f.client.control(run.id, { commandId: 'resume', type: 'resume', expectedRevision: allocated.revision });
    const worker = await waitFor(() => fake.instances[0]);
    assert.equal(f.store.get(run.id).budget?.reservedModelAttempts, 1);
    await assert.rejects(new Client(f.server.url, worker.bridge.token).control(run.id, increase(f.store.get(run.id), 2, 'worker-allocate')), { code: 'UNAUTHORIZED' });
    await submit(worker);
    await waitFor(() => f.store.get(run.id).phase === 'submitted' ? true : undefined);
    assert.deepEqual(await f.client.control(run.id, command), allocated);
    assert.equal(f.store.get(run.id).budget?.reservedModelAttempts, 1);
  } finally { await f.cleanup(); }
});

test('implementation and independent review share budget; stopped candidate resumes verification after explicit allocation', async () => {
  const fake = new FakeExecutor(), f = await setup(fake, 5000, policy);
  try {
    const run = await f.client.start({ commandId: 'start', objective: 'Fix', budget: { maxModelAttempts: 1 } });
    await submit(await waitFor(() => fake.instances[0]));
    const stopped = await paused(f.store, run.id);
    assert.equal(stopped.pause?.continuation?.kind, 'verification'); assert.ok(stopped.candidate);
    assert.equal(fake.instances.length, 1); assert.equal(stopped.budget?.reservedModelAttempts, 1);
    const allocated = await f.client.control(run.id, increase(stopped, 2));
    await f.client.control(run.id, { commandId: 'resume', type: 'resume', expectedRevision: allocated.revision });
    const review = await waitFor(() => fake.instances[1]); assert.equal(review.order.role, 'review');
    await submit(review);
    const ready = await verified(f.store, run.id); assert.equal(ready.budget?.reservedModelAttempts, 2);
    assert.equal(ready.candidate?.digest, stopped.candidate?.digest); assert.equal(fake.instances.length, 2);
  } finally { await f.cleanup(); }
});

test('repair and full specification replacement cannot reset consumed model attempts', async () => {
  const fake = new FakeExecutor(), f = await setup(fake, 5000, { ...policy, maxIterations: 2 });
  try {
    const run = await f.client.start({ commandId: 'start', objective: 'Fix', budget: { maxModelAttempts: 2 } });
    await submit(await waitFor(() => fake.instances[0])); await submit(await waitFor(() => fake.instances[1]), true);
    const stopped = await paused(f.store, run.id);
    assert.equal(stopped.iteration, 2); assert.equal(stopped.history?.length, 1); assert.equal(fake.instances.length, 2);
    const revised = await f.client.control(run.id, { commandId: 'revise', type: 'revise', expectedRevision: stopped.revision,
      objective: 'New goal', spec, reason: 'User changed the requirement, not the resource allocation' });
    assert.equal(revised.budget?.reservedModelAttempts, 2); assert.equal(revised.order.specRevision, 2);
    const again = await paused(f.store, run.id); assert.equal(fake.instances.length, 2); assert.equal(again.reason, 'BUDGET_EXHAUSTED');
    const allocated = await f.client.control(run.id, increase(again, 4));
    await f.client.control(run.id, { commandId: 'resume', type: 'resume', expectedRevision: allocated.revision });
    await submit(await waitFor(() => fake.instances[2])); await submit(await waitFor(() => fake.instances[3]));
    assert.equal((await verified(f.store, run.id)).budget?.reservedModelAttempts, 4);
  } finally { await f.cleanup(); }
});

test('descendant conflict resolution inherits root quota; child cannot increase it and allocation requires shared revision', async () => {
  const fake = new FakeExecutor(), f = await setup(fake, 5000, policy, true);
  try {
    const run = await f.client.start({ commandId: 'start', objective: 'Fix', budget: { maxModelAttempts: 2 } });
    const worker = await waitFor(() => fake.instances[0]); await writeFile(join(worker.order.workspace, 'hello.txt'), 'candidate');
    await submit(worker); await submit(await waitFor(() => fake.instances[1])); await verified(f.store, run.id);
    await writeFile(join(f.source, 'hello.txt'), 'user');
    const plan = await f.client.previewIntegration(run.id);
    const job = await f.client.integrate(run.id, { commandId: 'integrate', type: 'integrate', expectedRevision: f.store.get(run.id).revision, planId: plan.id });
    const child = await f.client.resolveIntegration(run.id, job.id, { commandId: 'resolve', type: 'resolve', expectedRevision: job.revision, planId: plan.id, instructions: 'Combine changes' });
    const stopped = await paused(f.store, child.id);
    assert.equal(stopped.budget?.rootRunId, run.id); assert.equal(stopped.budget?.reservedModelAttempts, 2); assert.equal(fake.instances.length, 2);
    await assert.rejects(f.client.control(child.id, increase(stopped, 4)), { code: 'BUDGET_ROOT_REQUIRED' });
    const root = f.store.get(run.id);
    await assert.rejects(f.client.control(root.id, { ...increase(root, 4), expectedBudgetRevision: 0 }), { code: 'BUDGET_REVISION_CONFLICT' });
    await f.client.control(root.id, increase(root, 4));
    assert.equal((await f.client.status(child.id)).budget?.maxModelAttempts, 4);
    await f.client.control(child.id, { commandId: 'resume', type: 'resume', expectedRevision: f.store.get(child.id).revision });
    await submit(await waitFor(() => fake.instances[2])); await submit(await waitFor(() => fake.instances[3]));
    const ready = await verified(f.store, child.id); assert.equal(ready.budget?.reservedModelAttempts, 4);
    assert.equal(f.store.get(root.id).budget?.reservedModelAttempts, 4);
  } finally { await f.cleanup(); }
});

test('duplicate or unknown dispatch is never refunded or reauthorized', () => {
  const store = new Store(':memory:');
  try {
    const run = store.start({ commandId: 'start', objective: 'Fix', budget: { maxModelAttempts: 1 } }, 'A:/attempts', {});
    store.claim(run.id, 'credential'); store.move(run.id, 'running');
    assert.equal(store.reserveModelAttempt(run.id, run.order.attemptId), true);
    assert.throws(() => store.reserveModelAttempt(run.id, run.order.attemptId), { code: 'DISPATCH_ALREADY_RESERVED' });
    store.recover(); assert.equal(store.get(run.id).phase, 'blocked'); assert.equal(store.get(run.id).budget?.reservedModelAttempts, 1);
    const allocated = store.increaseBudget(run.id, increase(store.get(run.id), 2));
    assert.equal(allocated.phase, 'blocked'); assert.equal(allocated.budget?.reservedModelAttempts, 1);
    assert.throws(() => store.reserveModelAttempt(run.id, run.order.attemptId), { code: 'RESULT_STALE' });
  } finally { store.close(); }
});

test('sibling resolutions compete for one shared remaining reservation, not separate child quotas', async () => {
  const fake = new FakeExecutor(), f = await setup(fake, 5000, policy, true);
  try {
    const run = await f.client.start({ commandId: 'start', objective: 'Fix', budget: { maxModelAttempts: 3 } });
    const worker = await waitFor(() => fake.instances[0]); await writeFile(join(worker.order.workspace, 'hello.txt'), 'candidate');
    await submit(worker); await submit(await waitFor(() => fake.instances[1])); await verified(f.store, run.id);
    await writeFile(join(f.source, 'hello.txt'), 'user');
    const jobs = [];
    for (let i = 0; i < 2; i++) {
      const plan = await f.client.previewIntegration(run.id);
      jobs.push(await f.client.integrate(run.id, { commandId: `conflict-${i}`, type: 'integrate', expectedRevision: f.store.get(run.id).revision, planId: plan.id }));
    }
    const plan = await f.client.previewIntegration(run.id);
    const children = await Promise.all(jobs.map((job, i) => f.client.resolveIntegration(run.id, job.id, { commandId: `child-${i}`, type: 'resolve',
      expectedRevision: job.revision, planId: plan.id, instructions: 'Reconcile this conflict' })));
    await waitFor(() => fake.instances[2]);
    await waitFor(() => children.some(child => f.store.get(child.id).phase === 'paused') ? true : undefined);
    assert.equal(fake.instances.length, 3);
    assert.equal(children.filter(child => f.store.get(child.id).phase === 'running').length, 1);
    assert.equal(f.store.get(run.id).budget?.reservedModelAttempts, 3);
    assert.ok(children.every(child => f.store.get(child.id).budget?.reservedModelAttempts === 3));
  } finally { await f.cleanup(); }
});

test('executor creation failure retains its pre-dispatch reservation and does not automatically retry', async () => {
  let creates = 0;
  const f = await setup({ create() { creates++; throw new Error('Fixture startup failure'); } });
  try {
    const run = await f.client.start({ commandId: 'start', objective: 'Fix', budget: { maxModelAttempts: 1 } });
    const failed = await waitFor(() => { const r = f.store.get(run.id); return r.phase === 'failed' ? r : undefined; });
    assert.equal(creates, 1); assert.equal(failed.budget?.reservedModelAttempts, 1); assert.equal(failed.gate, 'not_evaluated');
    assert.ok(!f.store.pending().includes(run.id));
    assert.equal((await f.client.control(run.id, increase(failed, 2))).phase, 'failed'); assert.equal(creates, 1);
  } finally { await f.cleanup(); }
});

test('ledger write/event/receipt failures leave counts and allocation unchanged', async () => {
  const f = await setup(), audit = new DatabaseSync(join(f.data, 'state.sqlite'));
  try {
    const run = f.store.start({ commandId: 'direct', objective: 'Fix', budget: { maxModelAttempts: 1 } }, join(f.data, 'attempts'), {});
    f.store.claim(run.id, 'credential'); f.store.move(run.id, 'running');
    audit.exec("CREATE TRIGGER reservation_failure BEFORE INSERT ON events WHEN NEW.type='attempt.budget_reserved' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    assert.throws(() => f.store.reserveModelAttempt(run.id, run.order.attemptId));
    assert.equal(f.store.get(run.id).budget?.reservedModelAttempts, 0); assert.equal(audit.prepare('SELECT COUNT(*) AS n FROM model_reservations').get()!.n, 0);
    audit.exec('DROP TRIGGER reservation_failure');
    assert.equal(f.store.reserveModelAttempt(run.id, run.order.attemptId), true);
    const before = f.store.get(run.id), command = increase(before, 2);
    audit.exec("CREATE TRIGGER allocation_failure BEFORE INSERT ON commands WHEN NEW.id='host:budget' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    assert.throws(() => f.store.increaseBudget(run.id, command)); assert.deepEqual(f.store.get(run.id), before);
    audit.exec('DROP TRIGGER allocation_failure');
    assert.equal(f.store.increaseBudget(run.id, command).budget?.maxModelAttempts, 2);
  } finally { audit.close(); await f.cleanup(); }
});

test('paused budget and committed allocation survive SQLite reopen without resetting consumption or auto-resuming', async () => {
  const fake = new FakeExecutor(), f = await setup(fake, 5000, policy);
  let store: Store | undefined, server: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    const run = await f.client.start({ commandId: 'start', objective: 'Fix', budget: { maxModelAttempts: 1 } });
    await submit(await waitFor(() => fake.instances[0])); const stopped = await paused(f.store, run.id);
    const command = increase(stopped, 2), allocated = await f.client.control(run.id, command);
    await f.server.close(); f.store.close();
    store = new Store(join(f.data, 'state.sqlite')); const next = new FakeExecutor();
    const runtime = new Runtime(store, next, { source: f.source, attemptsDirectory: join(f.data, 'attempts'), maxConcurrency: 2,
      attemptTimeoutMs: 5000, executionProfile: { driver: 'test' }, verification: policy });
    server = await serve(runtime, f.token); const client = new Client(server.url, f.token);
    assert.deepEqual(await client.control(run.id, command), allocated); assert.equal(next.instances.length, 0);
    assert.equal(store.get(run.id).budget?.reservedModelAttempts, 1);
    await client.control(run.id, { commandId: 'resume', type: 'resume', expectedRevision: store.get(run.id).revision });
    await submit(await waitFor(() => next.instances[0])); assert.equal((await verified(store, run.id)).budget?.reservedModelAttempts, 2);
  } finally {
    if (store) { await server?.close(); store.close(); await rm(f.root, { recursive: true, force: true }); }
    else await f.cleanup();
  }
});
