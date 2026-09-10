import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '../src/client.js';
import { Store, digest } from '../src/store.js';
import { Runtime } from '../src/runtime.js';
import { serve } from '../src/server.js';
import { IntegrationEngine } from '../src/integration-engine.js';
import { integrationPreview } from '../src/integration-preview.js';
import { resolveIntegration, automaticResolutionInstructions } from '../src/resolution.js';
import { type ArtifactFile, type PauseCommand } from '../src/contracts.js';
import { FakeExecutor, setup, waitFor, report } from './helpers.js';

const autonomy = { integration: 'on-gate-pass' as const, conflicts: 'resolve' as const };
const spec = { requirements: [], writeScope: { files: ['hello.txt'], trees: [] } };
const policy = { commands: [{ id: 'accept', executable: process.execPath,
  args: ['-e', "require('node:assert').ok(require('node:fs').readFileSync('hello.txt','utf8').startsWith('fixed'))"], timeoutMs: 5000 }] };
async function submit(a: FakeExecutor['instances'][number], pass = true) {
  await new Client(a.bridge.url, a.bridge.token).bridge(a.order.attemptId, 'submit', { commandId: 'submit', epoch: a.order.epoch, inputDigest: a.order.inputDigest,
    report: a.order.role === 'review' ? { ...report, review: { functionality: pass ? 'pass' : 'fail', completeness: 'pass', findings: [] } } : report }); a.finish();
}
async function fixture(maxModelAttempts = 4, blocker = false) {
  const fake = new FakeExecutor(), f = await setup(fake, 10_000, policy, true);
  try {
    const run = await f.client.start({ commandId: 'start', objective: 'Fix behavior while preserving user changes', spec, autonomy, budget: { maxModelAttempts } });
    const worker = await waitFor(() => fake.instances[0]); await writeFile(join(worker.order.workspace, 'hello.txt'), 'fixed'); await submit(worker);
    const review = await waitFor(() => fake.instances[1]);
    const hold = blocker ? await f.client.start({ commandId: 'hold', objective: 'Hold a slot' }) : undefined;
    if (hold) await waitFor(() => fake.instances[2]);
    await writeFile(join(f.source, 'hello.txt'), 'user'); await writeFile(join(f.source, 'user-only'), 'keep');
    await submit(review);
    await waitFor(() => f.store.get(run.id).phase === 'verified' ? true : undefined);
    return { ...f, fake, run, hold };
  } catch (error) { await f.cleanup(); throw error; }
}
const childOf = (store: Store, id: string) => waitFor(() => {
  const child = store.get(id).automaticIntegration?.resolutionRunId;
  return child ? store.get(child) : undefined;
});
const integrated = (store: Store, id: string) => waitFor(() => { const run = store.get(id); return run.integration?.phase === 'succeeded' ? run : undefined; });
async function finish(fake: FakeExecutor, index: number, content = 'fixed + user') {
  const worker = await waitFor(() => fake.instances[index]); await writeFile(join(worker.order.workspace, 'hello.txt'), content); await submit(worker);
  await submit(await waitFor(() => fake.instances[index + 1])); return worker.order.runId;
}

test('autonomous conflict resolution rejects unbudgeted start and revision', async () => {
  const f = await setup(new FakeExecutor(), 5000, policy, true);
  try {
    await assert.rejects(f.client.start({ commandId: 'start', objective: 'Fix', spec, autonomy }), { code: 'AUTONOMY_BUDGET_REQUIRED' });
    const run = await f.client.start({ commandId: 'manual', objective: 'Old goal' });
    await assert.rejects(f.client.control(run.id, { commandId: 'revise', type: 'revise', expectedRevision: run.revision, objective: 'New goal', spec, autonomy, reason: 'Changed' }), { code: 'AUTONOMY_BUDGET_REQUIRED' });
  } finally { await f.cleanup(); }
});

test('one upfront grant drives conflict child, scoped references, independent review and automatic final integration', async () => {
  const f = await fixture();
  try {
    const child = await childOf(f.store, f.run.id), worker = await waitFor(() => f.fake.instances[2]);
    assert.deepEqual(child.order.spec, spec); assert.deepEqual(child.autonomy, autonomy); assert.equal(child.budget?.rootRunId, f.run.id);
    assert.equal(await readFile(join(worker.order.workspace, 'hello.txt'), 'utf8'), 'user');
    const bridge = new Client(worker.bridge.url, worker.bridge.token);
    for (const [version, expected] of [['base', 'original'], ['proposal', 'fixed'], ['current', 'user']] as const) {
      const file = await bridge.context(worker.order.attemptId, { kind: 'file', version, path: 'hello.txt', offset: 0, length: 64 }) as ArtifactFile;
      assert.equal(file.content, expected);
    }
    await assert.rejects(f.client.cancel(f.run.id, { commandId: 'cancel-parent', type: 'cancel', expectedRevision: f.store.get(f.run.id).revision }), { code: 'DERIVED_CONTROL_REQUIRED' });
    await finish(f.fake, 2); const ready = await integrated(f.store, child.id);
    assert.equal(ready.budget?.reservedModelAttempts, 4); assert.equal(f.fake.instances.length, 4);
    assert.equal(f.store.get(f.run.id).integration?.phase, 'conflict');
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'fixed + user'); assert.equal(await readFile(join(f.source, 'user-only'), 'utf8'), 'keep');
  } finally { await f.cleanup(); }
});

test('exhausted root quota leaves exactly one paused resolution child without spending more model attempts', async () => {
  const f = await fixture(2);
  try {
    const child = await childOf(f.store, f.run.id);
    const paused = await waitFor(() => { const run = f.store.get(child.id); return run.phase === 'paused' ? run : undefined; });
    assert.equal(paused.reason, 'BUDGET_EXHAUSTED'); assert.equal(f.fake.instances.length, 2); assert.equal(f.store.all().length, 2);
    assert.equal(paused.budget?.reservedModelAttempts, 2); assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'user');
    const root = f.store.get(f.run.id);
    await f.client.control(root.id, { commandId: 'allocate', type: 'budget', expectedRevision: root.revision, expectedBudgetRevision: root.budget!.revision,
      maxModelAttempts: 4, reason: 'User expanded total resource envelope' });
    await f.client.control(child.id, { commandId: 'resume', type: 'resume', expectedRevision: paused.revision });
    await finish(f.fake, 2); await integrated(f.store, child.id); assert.equal(f.store.all().length, 2);
  } finally { await f.cleanup(); }
});

test('repeated user conflicts create bounded descendants without duplicating inherited instructions or budgets', async () => {
  const f = await fixture(6);
  try {
    const child = await childOf(f.store, f.run.id), worker = await waitFor(() => f.fake.instances[2]);
    await writeFile(join(worker.order.workspace, 'hello.txt'), 'fixed + user'); await submit(worker);
    const review = await waitFor(() => f.fake.instances[3]); await writeFile(join(f.source, 'hello.txt'), 'new user'); await submit(review);
    const grandchild = await childOf(f.store, child.id);
    assert.equal(grandchild.order.resolution?.requirements.length, 1); assert.equal(grandchild.budget?.rootRunId, f.run.id);
    await finish(f.fake, 4, 'fixed + new user'); const ready = await integrated(f.store, grandchild.id);
    assert.equal(ready.budget?.reservedModelAttempts, 6); assert.equal(f.fake.instances.length, 6); assert.equal(f.store.all().length, 3);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'fixed + new user');
  } finally { await f.cleanup(); }
});

test('rejected conflict candidate cannot write back or launch an unbounded replacement child', async () => {
  const f = await fixture(8);
  try {
    const child = await childOf(f.store, f.run.id), worker = await waitFor(() => f.fake.instances[2]);
    await writeFile(join(worker.order.workspace, 'hello.txt'), 'fixed + user'); await submit(worker);
    await submit(await waitFor(() => f.fake.instances[3]), false);
    await waitFor(() => f.store.get(child.id).phase === 'rejected' ? true : undefined);
    assert.equal(f.store.get(child.id).automaticIntegration, undefined); assert.equal(f.fake.instances.length, 4);
    assert.equal(f.store.all().length, 2); assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'user');
  } finally { await f.cleanup(); }
});

test('pause during resolution snapshot commit revokes authority; exact control replay remains valid after delegation', async t => {
  const original = Store.prototype.resolveIntegration;
  let pause: PauseCommand | undefined, pauseReceipt: unknown;
  t.mock.method(Store.prototype, 'resolveIntegration', function(this: Store, ...args: Parameters<Store['resolveIntegration']>) {
    if (args[6] && !pause) {
      pause = { commandId: 'pause-preparation', type: 'pause', mode: 'interrupt', expectedRevision: this.get(args[0]).revision };
      pauseReceipt = this.pause(args[0], pause);
    }
    return original.apply(this, args);
  });
  const f = await fixture();
  try {
    await waitFor(() => f.store.get(f.run.id).automaticIntegration?.state === 'paused' ? true : undefined);
    assert.equal(f.store.all().length, 1); assert.equal(f.fake.instances.length, 2);
    t.mock.restoreAll();
    const command = { commandId: 'resume-preparation', type: 'resume' as const, expectedRevision: f.store.get(f.run.id).revision };
    const receipt = await f.client.control(f.run.id, command);
    await childOf(f.store, f.run.id);
    assert.deepEqual(await f.client.control(f.run.id, command), receipt);
    assert.deepEqual(await f.client.control(f.run.id, pause!), pauseReceipt);
  } finally { t.mock.restoreAll(); await f.cleanup(); }
});

test('a concurrent manual resolution wins once and the automatic scheduler follows that same child', async t => {
  const original = Store.prototype.resolveIntegration;
  let manualChildId: string | undefined;
  t.mock.method(Store.prototype, 'resolveIntegration', function(this: Store, ...args: Parameters<Store['resolveIntegration']>) {
    if (args[6] && !manualChildId) {
      manualChildId = original.call(this, args[0], args[1], { ...args[2], commandId: 'manual-resolution-wins' }, args[3], args[4], args[5]).id;
    }
    return original.apply(this, args);
  });
  const f = await fixture();
  try {
    const child = await childOf(f.store, f.run.id); assert.equal(child.id, manualChildId);
    assert.equal(f.store.all().length, 2);
    await finish(f.fake, 2); await integrated(f.store, child.id);
    assert.equal(f.fake.instances.length, 4); assert.equal(f.store.get(f.run.id).budget?.reservedModelAttempts, 4);
  } finally { t.mock.restoreAll(); await f.cleanup(); }
});

for (const childCommitted of [false, true]) test(`reopen reuses conflict/child receipts without duplicate resolution dispatch: childCommitted=${childCommitted}`, async () => {
  const f = await fixture(4, true);
  let store: Store | undefined, server: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    const intent = f.store.get(f.run.id).automaticIntegration!;
    await f.server.close(); f.store.close(); store = new Store(join(f.data, 'state.sqlite'));
    const signal = new AbortController().signal;
    const plan = await integrationPreview(store, f.source, f.run.id, undefined, 0, 1, undefined, signal);
    const request = { commandId: `automatic:${intent.id}`, digest: digest(JSON.stringify(['automatic-integration', intent.id, intent.runId, intent.inputDigest, intent.candidateId])) };
    const job = await new IntegrationEngine(store, f.source).prepare(f.run.id, plan.revision, plan.id, signal, request);
    let childId: string | undefined;
    if (childCommitted) childId = (await resolveIntegration(store, f.source, join(f.data, 'attempts'), { driver: 'test' }, f.run.id, job.id,
      { commandId: `automatic-resolution:${intent.id}`, type: 'resolve', expectedRevision: job.revision, planId: plan.id, instructions: automaticResolutionInstructions }, signal, intent.id)).id;
    store.close(); store = new Store(join(f.data, 'state.sqlite'));
    const fake = new FakeExecutor(); server = await serve(new Runtime(store, fake, { source: f.source, attemptsDirectory: join(f.data, 'attempts'),
      maxConcurrency: 2, attemptTimeoutMs: 10_000, executionProfile: { driver: 'test' }, verification: policy, integration: { enabled: true } }), f.token);
    const child = await childOf(store, f.run.id); if (childId) assert.equal(child.id, childId);
    await finish(fake, 0); await integrated(store, child.id);
    assert.equal(store.all().filter(run => run.parentRunId === f.run.id).length, 1); assert.equal(fake.instances.length, 2);
  } finally {
    if (store) { await server?.close(); store.close(); await rm(f.root, { recursive: true, force: true }); }
    else await f.cleanup();
  }
});

test('child/outbox/automatic-link/receipt transaction rolls back together when the resolution receipt cannot commit', async () => {
  const f = await fixture(4, true), audit = new DatabaseSync(join(f.data, 'state.sqlite'));
  try {
    audit.exec("CREATE TRIGGER receipt_failure BEFORE INSERT ON commands WHEN NEW.id LIKE 'host:automatic-resolution:%' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    await f.client.cancel(f.hold!.id, { commandId: 'release', type: 'cancel', expectedRevision: f.store.get(f.hold!.id).revision });
    const failed = await waitFor(() => { const run = f.store.get(f.run.id); return run.automaticIntegration?.state === 'failed' ? run : undefined; });
    assert.equal(failed.automaticIntegration?.resolutionRunId, undefined);
    assert.equal(f.store.all().filter(run => run.parentRunId === f.run.id).length, 0);
    assert.equal(failed.budget?.reservedModelAttempts, 2); assert.equal(f.fake.instances.length, 3);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'user');
  } finally { audit.close(); await f.cleanup(); }
});

test('a conflict that clears during preparation is reintegrated under the same grant without launching a resolver', async t => {
  const original = IntegrationEngine.prototype.prepare;
  let source: string | undefined;
  t.mock.method(IntegrationEngine.prototype, 'prepare', async function(this: IntegrationEngine, ...args: Parameters<IntegrationEngine['prepare']>) {
    const result = await original.apply(this, args);
    if (result.phase === 'conflict' && source) { const path = source; source = undefined; await writeFile(join(path, 'hello.txt'), 'original'); }
    return result;
  });
  const f = await fixture(4, true);
  try {
    source = f.source;
    await f.client.cancel(f.hold!.id, { commandId: 'release', type: 'cancel', expectedRevision: f.store.get(f.hold!.id).revision });
    await integrated(f.store, f.run.id);
    assert.equal(f.store.all().filter(run => run.parentRunId === f.run.id).length, 0); assert.equal(f.fake.instances.length, 3);
    assert.equal(f.store.integrations.forRun(f.run.id).length, 2);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'fixed');
  } finally { t.mock.restoreAll(); await f.cleanup(); }
});
