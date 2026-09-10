import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, digest } from '../src/store.js';
import { Runtime } from '../src/runtime.js';
import { serve } from '../src/server.js';
import { Client } from '../src/client.js';
import { IntegrationEngine } from '../src/integration-engine.js';
import { integrationPreview } from '../src/integration-preview.js';
import { FakeExecutor, setup, waitFor, report } from './helpers.js';

const policy = { commands: [{ id: 'accept', executable: process.execPath,
  args: ['-e', "require('node:assert').equal(require('node:fs').readFileSync('hello.txt','utf8'),'fixed')"], timeoutMs: 5000 }] };
const spec = { requirements: [], writeScope: { files: ['hello.txt'], trees: [] } };
const autonomy = { integration: 'on-gate-pass' as const };
async function submit(instance: FakeExecutor['instances'][number], pass = true) {
  await new Client(instance.bridge.url, instance.bridge.token).bridge(instance.order.attemptId, 'submit', {
    commandId: 'submit', epoch: instance.order.epoch, inputDigest: instance.order.inputDigest,
    report: instance.order.role === 'review' ? { ...report, review: { functionality: pass ? 'pass' : 'fail', completeness: 'pass', findings: [] } } : report,
  }); instance.finish();
}
async function fixture(options: { manual?: boolean; blocker?: boolean; reject?: boolean; conflict?: boolean } = {}) {
  const fake = new FakeExecutor(), f = await setup(fake, 10_000, policy, true);
  try {
    const initial = await f.client.start({ commandId: 'start', objective: 'Fix hello.txt', spec, ...(!options.manual ? { autonomy } : {}) });
    const worker = await waitFor(() => fake.instances[0]); await writeFile(join(worker.order.workspace, 'hello.txt'), 'fixed');
    await submit(worker); const review = await waitFor(() => fake.instances[1]);
    const blocker = options.blocker ? await f.client.start({ commandId: 'block', objective: 'Hold the runtime slot' }) : undefined;
    if (blocker) await waitFor(() => fake.instances[2]);
    await writeFile(join(f.source, 'user-only'), 'keep');
    if (options.conflict) await writeFile(join(f.source, 'hello.txt'), 'user edit');
    await submit(review, !options.reject);
    const ready = await waitFor(() => { const run = f.store.get(initial.id); return ['verified', 'rejected'].includes(run.phase) ? run : undefined; });
    return { ...f, fake, ready, blocker };
  } catch (error) { await f.cleanup(); throw error; }
}
async function release(f: Awaited<ReturnType<typeof fixture>>) {
  if (f.blocker) await f.client.cancel(f.blocker.id, { type: 'cancel', commandId: 'release', expectedRevision: f.store.get(f.blocker.id).revision });
}
async function integrated(f: { store: Store }, id: string) {
  return waitFor(() => { const run = f.store.get(id); return run.integration?.phase === 'succeeded' ? run : undefined; });
}

test('automatic writeback requires explicit scope and operator integration/verification capability', async () => {
  for (const enabled of [false, true]) {
    const f = await setup(new FakeExecutor(), 5000, enabled ? policy : undefined, enabled);
    try {
      await assert.rejects(f.client.start({ commandId: 'start', objective: 'Fix', autonomy, ...(enabled ? {} : { spec }) }), { code: 'AUTONOMY_NOT_AVAILABLE' });
      assert.equal(f.store.all().length, 0);
    } finally { await f.cleanup(); }
  }
});

test('upfront authorization automatically integrates a verified candidate and validates the final tree without another host command', async () => {
  const f = await fixture();
  try {
    const ready = await integrated(f, f.ready.id);
    assert.equal(ready.automaticIntegration?.state, 'scheduled'); assert.equal(ready.automaticIntegration?.integrationId, ready.integration?.id);
    assert.equal(ready.integration?.validation[0]?.status, 'passed');
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'fixed'); assert.equal(await readFile(join(f.source, 'user-only'), 'utf8'), 'keep');
    assert.equal(f.store.integrations.forRun(ready.id).length, 1); assert.equal(f.fake.instances.length, 2);
    assert.ok(f.store.events(ready.id, 0).some(event => event.type === 'automatic.integration_queued'));
  } finally { await f.cleanup(); }
});

for (const mode of ['manual', 'reject'] as const) test(`${mode} work never obtains an automatic integration intent`, async () => {
  const f = await fixture({ [mode]: true });
  try {
    assert.equal(f.ready.automaticIntegration, undefined); assert.equal(f.store.pendingAutomatic().length, 0);
    assert.equal(f.store.integrations.forRun(f.ready.id).length, 0); assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'original');
  } finally { await f.cleanup(); }
});

for (const action of ['pause', 'cancel'] as const) test(`${action} revokes an automatic intent while active work drains`, async () => {
  const f = await fixture({ blocker: true });
  try {
    assert.equal(f.ready.automaticIntegration?.state, 'pending'); assert.equal(f.store.integrations.forRun(f.ready.id).length, 0);
    const command = { commandId: action, expectedRevision: f.store.get(f.ready.id).revision,
      ...(action === 'pause' ? { type: 'pause' as const, mode: 'drain' as const } : { type: 'cancel' as const }) };
    const stopped = await f.client.control(f.ready.id, command);
    assert.equal(stopped.automaticIntegration?.state, action === 'pause' ? 'paused' : 'cancelled'); assert.equal(stopped.phase, 'verified');
    assert.deepEqual(await f.client.control(f.ready.id, command), stopped);
    await release(f);
    await waitFor(() => f.store.get(f.blocker!.id).phase === 'cancelled' ? true : undefined);
    assert.equal(f.store.pendingAutomatic().length, 0); assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'original');
    if (action === 'pause') {
      await f.client.control(f.ready.id, { type: 'resume', commandId: 'resume', expectedRevision: f.store.get(f.ready.id).revision });
      await integrated(f, f.ready.id);
    }
  } finally { await f.cleanup(); }
});

for (const renewed of [false, true]) test(`scope/spec revision cancels old writeback and uses only the replacement grant: renewed=${renewed}`, async () => {
  const f = await fixture({ blocker: true });
  try {
    const old = f.ready.automaticIntegration!;
    const revised = await f.client.control(f.ready.id, { type: 'revise', commandId: 'revise', expectedRevision: f.ready.revision,
      objective: 'New requirement', spec, reason: 'User changed the goal', ...(renewed ? { autonomy } : {}) });
    assert.deepEqual(revised.autonomy, renewed ? autonomy : undefined); assert.equal(f.store.automatic(old.id).state, 'cancelled');
    const worker = await waitFor(() => f.fake.instances[3]); await writeFile(join(worker.order.workspace, 'hello.txt'), 'fixed');
    await submit(worker); await submit(await waitFor(() => f.fake.instances[4]));
    await waitFor(() => f.store.get(revised.id).phase === 'verified' ? true : undefined); await release(f);
    if (renewed) {
      const completed = await integrated(f, revised.id);
      assert.notEqual(completed.automaticIntegration?.id, old.id); assert.equal(f.store.integrations.forRun(revised.id).length, 1);
    } else {
      assert.equal(f.store.get(revised.id).automaticIntegration, undefined);
      assert.equal(f.store.integrations.forRun(revised.id).length, 0); assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'original');
    }
  } finally { await f.cleanup(); }
});

test('automatic preflight records conflicts without overwriting concurrent user changes', async () => {
  const f = await fixture({ conflict: true });
  try {
    const ready = await waitFor(() => { const run = f.store.get(f.ready.id); return run.automaticIntegration?.state === 'scheduled' ? run : undefined; });
    assert.equal(ready.integration?.phase, 'conflict'); assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'user edit');
    assert.equal(f.store.integrations.forRun(ready.id).length, 1); assert.equal(f.fake.instances.length, 2);
  } finally { await f.cleanup(); }
});

test('an explicit integration during drain is reused, never duplicated by the automatic intent', async () => {
  const f = await fixture({ blocker: true });
  try {
    const plan = await f.client.previewIntegration(f.ready.id);
    const job = await f.client.integrate(f.ready.id, { commandId: 'manual-integrate', type: 'integrate', expectedRevision: f.store.get(f.ready.id).revision, planId: plan.id });
    await release(f); await integrated(f, f.ready.id);
    await waitFor(() => f.store.get(f.ready.id).automaticIntegration?.state === 'scheduled' ? true : undefined);
    assert.equal(f.store.integrations.forRun(f.ready.id).length, 1); assert.equal(f.store.get(f.ready.id).automaticIntegration?.integrationId, job.id);
  } finally { await f.cleanup(); }
});

test('pause racing automatic preparation prevents journal creation and source writes', async t => {
  const f = await fixture({ blocker: true });
  const original = IntegrationEngine.prototype.prepare;
  let intercepted = false;
  try {
    t.mock.method(IntegrationEngine.prototype, 'prepare', async function(this: IntegrationEngine, ...args: Parameters<IntegrationEngine['prepare']>) {
      if (!intercepted) {
        intercepted = true;
        f.store.pause(f.ready.id, { commandId: 'pause-during-prepare', type: 'pause', mode: 'interrupt', expectedRevision: f.store.get(f.ready.id).revision });
      }
      return original.apply(this, args);
    });
    await release(f);
    await waitFor(() => f.store.get(f.ready.id).automaticIntegration?.state === 'paused' ? true : undefined);
    assert.equal(intercepted, true); assert.equal(f.store.integrations.forRun(f.ready.id).length, 0);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'original');
  } finally { t.mock.restoreAll(); await f.cleanup(); }
});

test('tampered accepted evidence fails automatic preparation and never writes the project', async () => {
  const f = await fixture({ blocker: true });
  try {
    await writeFile(join(f.ready.candidate!.workspace, 'hello.txt'), 'tampered'); await release(f);
    const failed = await waitFor(() => { const run = f.store.get(f.ready.id); return run.automaticIntegration?.state === 'failed' ? run : undefined; });
    assert.equal(failed.automaticIntegration?.reason, 'ARTIFACT_CHANGED');
    assert.equal(f.store.integrations.forRun(f.ready.id).length, 0); assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'original');
  } finally { await f.cleanup(); }
});

for (const prepared of [false, true]) test(`automatic intent recovers after SQLite reopen, including committed integration receipt: prepared=${prepared}`, async () => {
  const f = await fixture({ blocker: true });
  let store: Store | undefined, server: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    const intent = f.ready.automaticIntegration!;
    await f.server.close(); f.store.close();
    store = new Store(join(f.data, 'state.sqlite'));
    let integrationId: string | undefined;
    if (prepared) {
      const signal = new AbortController().signal;
      const plan = await integrationPreview(store, f.source, f.ready.id, undefined, 0, 1, undefined, signal);
      const request = { commandId: `automatic:${intent.id}`, digest: digest(JSON.stringify(['automatic-integration', intent.id, intent.runId, intent.inputDigest, intent.candidateId])) };
      integrationId = (await new IntegrationEngine(store, f.source).prepare(f.ready.id, plan.revision, plan.id, signal, request)).id;
      assert.equal(store.automatic(intent.id).state, 'pending');
    }
    const fake = new FakeExecutor();
    const runtime = new Runtime(store, fake, { source: f.source, attemptsDirectory: join(f.data, 'attempts'), maxConcurrency: 2,
      attemptTimeoutMs: 10_000, executionProfile: { driver: 'test' }, verification: policy, integration: { enabled: true } });
    server = await serve(runtime, f.token);
    await integrated({ store }, f.ready.id);
    await waitFor(() => store!.get(f.ready.id).automaticIntegration?.state === 'scheduled' ? true : undefined);
    const jobs = store.integrations.forRun(f.ready.id); assert.equal(jobs.length, 1);
    if (integrationId) assert.equal(jobs[0]!.id, integrationId);
    assert.equal(fake.instances.length, 0); assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'fixed');
  } finally {
    if (store) { await server?.close(); store.close(); await rm(f.root, { recursive: true, force: true }); }
    else await f.cleanup();
  }
});

test('automatic-intent insertion is atomic with Gate and cannot leave an accepted unqueued authorization', async () => {
  const fake = new FakeExecutor(), f = await setup(fake, 5000, policy, true), audit = new DatabaseSync(join(f.data, 'state.sqlite'));
  try {
    const run = await f.client.start({ commandId: 'start', objective: 'Fix', spec, autonomy });
    const worker = await waitFor(() => fake.instances[0]); await writeFile(join(worker.order.workspace, 'hello.txt'), 'fixed'); await submit(worker);
    const review = await waitFor(() => fake.instances[1]);
    audit.exec("CREATE TRIGGER auto_failure BEFORE INSERT ON automatic_integrations BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    await submit(review);
    const failed = await waitFor(() => { const current = f.store.get(run.id); return current.phase === 'failed' ? current : undefined; });
    assert.equal(failed.gate, 'not_evaluated'); assert.equal(failed.automaticIntegration, undefined);
    assert.equal(f.store.events(run.id, 0).filter(event => event.type === 'gate.passed').length, 0);
    assert.equal(f.store.integrations.forRun(run.id).length, 0);
  } finally { audit.close(); await f.cleanup(); }
});

test('bookkeeping failure after a committed integration receipt stops scheduling and preserves recoverable intent', async t => {
  const f = await fixture({ blocker: true });
  try {
    t.mock.method(f.store, 'finishAutomatic', () => { throw new Error('Fixture projection failure'); });
    await release(f);
    await waitFor(() => (f.runtime as unknown as { closing: boolean }).closing ? true : undefined);
    const jobs = f.store.integrations.forRun(f.ready.id);
    assert.equal(jobs.length, 1); assert.equal(jobs[0]!.phase, 'prepared'); assert.equal(jobs[0]!.dispatch, 'pending');
    assert.equal(f.store.automatic(f.ready.automaticIntegration!.id).state, 'pending');
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'original');
  } finally { t.mock.restoreAll(); await f.cleanup(); }
});
