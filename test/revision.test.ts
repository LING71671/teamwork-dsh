import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '../src/client.js';
import { Runtime } from '../src/runtime.js';
import { serve } from '../src/server.js';
import { Store } from '../src/store.js';
import { FakeExecutor, setup, waitFor, report } from './helpers.js';
import type { ArtifactFile, ReviseCommand, Run, RunSpec } from '../src/contracts.js';

const policy = { commands: [{ id: 'accept', executable: process.execPath,
  args: ['-e', "require('node:assert').ok(require('node:fs').readFileSync('hello.txt','utf8').startsWith('fixed'))"], timeoutMs: 5000 }] };
const spec: RunSpec = { requirements: [{ id: 'new', text: 'Implement fixed-v2 behavior' }], writeScope: { files: ['hello.txt'], trees: [] } };
const client = (a: FakeExecutor['instances'][number]) => new Client(a.bridge.url, a.bridge.token);
async function submit(a: FakeExecutor['instances'][number], review = false) {
  await client(a).bridge(a.order.attemptId, 'submit', { commandId: 'submit', epoch: a.order.epoch, inputDigest: a.order.inputDigest,
    report: review ? { ...report, review: { functionality: 'pass', completeness: 'pass', findings: [],
      requirements: (a.order.spec?.requirements ?? []).map(r => ({ id: r.id, verdict: 'pass', evidence: 'Fixture inspected fixed behavior in hello.txt.' })) } } : report });
  a.finish();
}
async function context(a: FakeExecutor['instances'][number], version: 'base' | 'proposal' | 'current', path = 'hello.txt') {
  return await client(a).context(a.order.attemptId, { kind: 'file', version, path, offset: 0, length: 65536 }) as ArtifactFile;
}
async function fixture() {
  const fake = new FakeExecutor(), f = await setup(fake, 10_000, policy, true);
  try {
    const initial = await f.client.start({ commandId: 'start', objective: 'Implement fixed behavior' });
    const worker = await waitFor(() => fake.instances[0]);
    await writeFile(join(worker.order.workspace, 'hello.txt'), 'fixed');
    await writeFile(join(worker.order.workspace, 'old-extra'), 'old scope change'); await submit(worker);
    await submit(await waitFor(() => fake.instances[1]), true);
    const original = await waitFor(() => { const r = f.store.get(initial.id); return r.phase === 'verified' ? r : undefined; });
    const command = (commandId = 'revise'): ReviseCommand => ({ type: 'revise', commandId, expectedRevision: f.store.get(original.id).revision,
      objective: 'Implement the new fixed-v2 behavior, preserving user files', spec, reason: 'User replaced the previous objective and narrowed the write scope' });
    return { ...f, fake, original, command };
  } catch (error) { await f.cleanup(); throw error; }
}
async function finish(f: Awaited<ReturnType<typeof fixture>>, index: number, id = f.original.id) {
  const worker = await waitFor(() => f.fake.instances[index]);
  await writeFile(join(worker.order.workspace, 'hello.txt'), 'fixed-v2'); await submit(worker);
  await submit(await waitFor(() => f.fake.instances[index + 1]), true);
  return waitFor(() => { const r = f.store.get(id); return ['verified', 'failed', 'rejected'].includes(r.phase) ? r : undefined; });
}

test('full spec revision atomically invalidates old Gate, snapshots current project and creates fresh implementation/review identities', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.source, 'hello.txt'), 'user edit'); await writeFile(join(f.source, 'user-only'), 'keep');
    const oldPlan = await f.client.previewIntegration(f.original.id), input = f.command();
    await assert.rejects(f.client.control(f.original.id, { ...input, objective: f.original.order.objective, spec: f.original.order.spec! }), { code: 'SPEC_UNCHANGED' });
    const [revised, repeated] = await Promise.all([f.client.control(f.original.id, input), f.client.control(f.original.id, input)]);
    assert.deepEqual(revised, repeated); assert.equal(revised.id, f.original.id);
    assert.equal(revised.order.specRevision, 2); assert.equal(revised.order.epoch, 2);
    assert.equal(revised.order.workItemId, f.original.order.workItemId); assert.notEqual(revised.order.attemptId, f.original.order.attemptId);
    assert.equal(revised.gate, 'not_evaluated'); assert.equal(revised.candidate, undefined); assert.equal(revised.validation, undefined);
    assert.equal(revised.integration, undefined); assert.equal(revised.reviewAttempt, undefined);
    assert.deepEqual(revised.verification, f.original.verification); assert.deepEqual(revised.order.spec, spec);
    assert.equal(revised.specHistory?.[0]?.previous.gate, 'passed'); assert.equal(revised.specHistory?.[0]?.previous.candidate?.digest, f.original.candidate?.digest);
    assert.notEqual(revised.baseline?.digest, f.original.baseline?.digest);
    const worker = await waitFor(() => f.fake.instances[2]);
    assert.equal(await readFile(join(worker.order.workspace, 'hello.txt'), 'utf8'), 'user edit');
    await assert.rejects(readFile(join(worker.order.workspace, 'old-extra')), { code: 'ENOENT' });
    assert.equal((await context(worker, 'base')).content, 'original'); assert.equal((await context(worker, 'proposal')).content, 'fixed');
    assert.equal((await context(worker, 'current')).content, 'user edit');
    const historicalChanges = await f.client.changes(revised.id, f.original.candidate!.artifactId!);
    assert.equal(historicalChanges.baseline.digest, f.original.baseline!.digest);
    assert.equal(historicalChanges.candidate.specRevision, 1);
    const historicalPreview = await f.client.previewIntegration(revised.id, f.original.candidate!.artifactId!);
    assert.equal(historicalPreview.baseline.digest, f.original.baseline!.digest); assert.equal(historicalPreview.candidateVerified, false);
    await assert.rejects(client(f.fake.instances[0]!).bridge(f.original.order.attemptId, 'checkpoint', {
      commandId: 'late', epoch: 1, inputDigest: f.fake.instances[0]!.order.inputDigest, report }), { code: 'RESULT_STALE' });
    await assert.rejects(f.client.integrate(f.original.id, { commandId: 'stale-integrate', type: 'integrate', expectedRevision: f.original.revision, planId: oldPlan.id }), { code: 'REVISION_CONFLICT' });
    const ready = await finish(f, 2); assert.equal(ready.phase, 'verified');
    assert.equal(ready.reviewAttempt?.order.specRevision, 2); assert.equal(ready.reviewAttempt?.report?.review?.requirements?.[0]?.id, 'new');
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'user edit');
    const plan = await f.client.previewIntegration(ready.id);
    const integrated = await f.client.integrate(ready.id, { commandId: 'new-integrate', type: 'integrate', expectedRevision: ready.revision, planId: plan.id });
    await waitFor(() => f.store.integrations.get(integrated.id).phase === 'succeeded' ? true : undefined);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'fixed-v2'); assert.equal(await readFile(join(f.source, 'user-only'), 'utf8'), 'keep');
    assert.deepEqual(await f.client.control(ready.id, input), revised);
    await assert.rejects(f.client.control(ready.id, { ...input, reason: 'different' }), { code: 'IDEMPOTENCY_CONFLICT' });
  } finally { await f.cleanup(); }
});

test('revision rejects running/unknown attempts, stale commands and missing replacement scope; paused work can be revised', async () => {
  const fake = new FakeExecutor(), f = await setup(fake, 10_000, policy);
  try {
    const run = await f.client.start({ commandId: 'start', objective: 'Old goal' });
    await waitFor(() => fake.instances[0]);
    const command = (): ReviseCommand => ({ type: 'revise', commandId: 'revise', expectedRevision: f.store.get(run.id).revision, objective: 'New goal', spec, reason: 'User changed goal' });
    await assert.rejects(f.client.control(run.id, command()), { code: 'REVISION_NOT_READY' });
    await f.client.control(run.id, { commandId: 'pause', type: 'pause', mode: 'interrupt', expectedRevision: f.store.get(run.id).revision });
    await waitFor(() => f.store.get(run.id).phase === 'paused' ? true : undefined);
    await assert.rejects(f.client.control(run.id, { ...command(), expectedRevision: 0 }), { code: 'REVISION_CONFLICT' });
    const { spec: _spec, ...missing } = command();
    const response = await fetch(`${f.server.url}/v1/runs/${run.id}/commands`, { method: 'POST', headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' }, body: JSON.stringify(missing) });
    assert.equal(response.status, 400);
    const revised = await f.client.control(run.id, command()); assert.equal(revised.order.epoch, 2);
    const worker = await waitFor(() => fake.instances[1]);
    assert.deepEqual(worker.order.spec, spec); assert.equal((await context(worker, 'proposal')).content, 'original');
    fake.failClose = true;
    await f.client.control(run.id, { commandId: 'cancel', type: 'cancel', expectedRevision: f.store.get(run.id).revision });
    await waitFor(() => f.store.get(run.id).phase === 'blocked' ? true : undefined);
    await assert.rejects(f.client.control(run.id, { ...command(), commandId: 'revise-unknown' }), { code: 'UNAVAILABLE' });
    fake.failClose = false; worker.finish();
  } finally { await f.cleanup(); }
});

test('legacy artifact metadata resolves the archived baseline after revision and refuses untraceable evidence', async () => {
  const f = await fixture(), audit = new DatabaseSync(join(f.data, 'state.sqlite'));
  try {
    const artifactId = f.original.candidate!.artifactId!;
    audit.prepare("UPDATE artifacts SET data=json_remove(data,'$.specRevision','$.baselineId') WHERE id=?").run(artifactId);
    await writeFile(join(f.source, 'hello.txt'), 'new user baseline');
    const revised = await f.client.control(f.original.id, f.command());
    assert.notEqual(revised.baseline!.digest, f.original.baseline!.digest);
    const changes = await f.client.changes(revised.id, artifactId);
    assert.equal(changes.baseline.id, f.original.baseline!.artifactId);
    const preview = await f.client.previewIntegration(revised.id, artifactId);
    assert.equal(preview.baseline.id, f.original.baseline!.artifactId); assert.equal(preview.candidateVerified, false);
    await waitFor(() => f.fake.instances[2]);
    audit.prepare("UPDATE artifacts SET data=json_set(data,'$.attemptId','untraceable-legacy-attempt') WHERE id=?").run(artifactId);
    await assert.rejects(f.client.changes(revised.id, artifactId), { code: 'BASELINE_VERSION_UNKNOWN' });
    await assert.rejects(f.client.previewIntegration(revised.id, artifactId), { code: 'BASELINE_VERSION_UNKNOWN' });
  } finally { audit.close(); await f.cleanup(); }
});

test('revision does not swallow artifact registry failures or commit a receipt; the exact command can be retried', async t => {
  const f = await fixture();
  try {
    const before = f.store.get(f.original.id), input = f.command();
    t.mock.method(f.store, 'artifact', () => { throw new Error('Fixture registry failure'); });
    await assert.rejects(f.client.control(before.id, input), { code: 'INTERNAL_ERROR' });
    assert.deepEqual(f.store.get(before.id), before); assert.equal(f.store.replayRevision(before.id, input), undefined);
    assert.equal(f.fake.instances.length, 2);
    t.mock.restoreAll();
    const revised = await f.client.control(before.id, input);
    assert.equal(revised.order.specRevision, 2); assert.deepEqual(revised.order.revisionContext?.unavailable, []);
    assert.equal((await finish(f, 2)).phase, 'verified');
  } finally { t.mock.restoreAll(); await f.cleanup(); }
});

test('revision refuses retained integration ownership and uses a fresh baseline after successful integration', async () => {
  const f = await fixture();
  try {
    const plan = await f.client.previewIntegration(f.original.id);
    const job = await f.client.integrate(f.original.id, { commandId: 'integrate', type: 'integrate', expectedRevision: f.original.revision, planId: plan.id });
    await assert.rejects(f.client.control(f.original.id, f.command()), error => ['INTEGRATION_BUSY', 'INTEGRATION_RECONCILIATION_REQUIRED'].includes((error as { code: string }).code));
    await waitFor(() => f.store.integrations.get(job.id).phase === 'succeeded' ? true : undefined);
    await waitFor(() => (f.runtime as unknown as { activeIntegration?: unknown }).activeIntegration === undefined ? true : undefined);
    const revised = await f.client.control(f.original.id, f.command());
    assert.equal(revised.specHistory?.[0]?.previous.integration?.phase, 'succeeded');
    const worker = await waitFor(() => f.fake.instances[2]); assert.equal((await context(worker, 'current')).content, 'fixed');
    const ready = await finish(f, 2); assert.equal(ready.phase, 'verified');
    assert.equal((await f.client.artifactFile(ready.id, ready.baseline!.artifactId!, 'hello.txt')).content, 'fixed');
    const next = await f.client.previewIntegration(ready.id); assert.equal(next.changes.find(c => c.path === 'hello.txt')?.before?.kind, 'file');
  } finally { await f.cleanup(); }
});

for (const childState of ['paused', 'verified'] as const) test(`revision invalidates ${childState} derived work and rejects active descendants or old integration resolution`, async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.source, 'hello.txt'), 'user edit');
    const plan = await f.client.previewIntegration(f.original.id);
    const conflict = await f.client.integrate(f.original.id, { commandId: 'conflict', type: 'integrate', expectedRevision: f.original.revision, planId: plan.id });
    const child = await f.client.resolveIntegration(f.original.id, conflict.id, { commandId: 'resolve', type: 'resolve', expectedRevision: conflict.revision, planId: plan.id, instructions: 'Combine changes' });
    await waitFor(() => f.fake.instances[2]);
    await assert.rejects(f.client.control(f.original.id, f.command()), { code: 'REVISION_ACTIVE_DESCENDANTS' });
    let grandchild: Run | undefined;
    if (childState === 'paused') {
      await f.client.control(child.id, { commandId: 'pause-child', type: 'pause', mode: 'interrupt', expectedRevision: f.store.get(child.id).revision });
      await waitFor(() => f.store.get(child.id).phase === 'paused' ? true : undefined);
    } else {
      const completed = await finish(f, 2, child.id); assert.equal(completed.phase, 'verified');
      await writeFile(join(f.source, 'hello.txt'), 'later user edit');
      const childPlan = await f.client.previewIntegration(child.id);
      const childConflict = await f.client.integrate(child.id, { commandId: 'child-conflict', type: 'integrate', expectedRevision: completed.revision, planId: childPlan.id });
      grandchild = await f.client.resolveIntegration(child.id, childConflict.id, { commandId: 'grandchild', type: 'resolve', expectedRevision: childConflict.revision,
        planId: childPlan.id, instructions: 'Reconcile the latest user changes' });
      await waitFor(() => f.fake.instances[4]);
      await assert.rejects(f.client.control(f.original.id, f.command()), { code: 'REVISION_ACTIVE_DESCENDANTS' });
      await f.client.control(grandchild.id, { commandId: 'pause-grandchild', type: 'pause', mode: 'interrupt', expectedRevision: f.store.get(grandchild.id).revision });
      await waitFor(() => f.store.get(grandchild!.id).phase === 'paused' ? true : undefined);
    }
    const revised = await f.client.control(f.original.id, f.command());
    assert.equal(f.store.get(child.id).phase, 'superseded'); assert.equal(f.store.get(child.id).supersededBy?.specRevision, 2);
    assert.equal(f.store.get(child.id).gate, 'not_evaluated'); assert.ok(!f.store.pending().includes(child.id));
    if (grandchild) { assert.equal(f.store.get(grandchild.id).phase, 'superseded'); assert.equal(f.store.get(grandchild.id).supersededBy?.runId, f.original.id); }
    await assert.rejects(context(f.fake.instances[2]!, 'current'), { code: 'RESULT_STALE' });
    await assert.rejects(f.client.control(child.id, { commandId: 'resume-child', type: 'resume', expectedRevision: f.store.get(child.id).revision }), { code: 'NOT_PAUSED' });
    const ready = await finish(f, childState === 'paused' ? 3 : 5); assert.equal(ready.order.specRevision, revised.order.specRevision);
    const latest = await f.client.previewIntegration(ready.id);
    await assert.rejects(f.client.resolveIntegration(ready.id, conflict.id, { commandId: 'old-job', type: 'resolve', expectedRevision: f.store.integrations.get(conflict.id).revision,
      planId: latest.id, instructions: 'Use old integration' }), { code: 'INTEGRATION_GATE_STALE' });
  } finally { await f.cleanup(); }
});

test('an undispatched specification can be replaced without inventing missing previous artifacts', async () => {
  const fake = new FakeExecutor(), f = await setup(fake, 10_000, policy);
  try {
    const blockers: Run[] = [];
    for (let i = 0; i < 2; i++) { blockers.push(await f.client.start({ commandId: `block-${i}`, objective: 'Hold slot' })); await waitFor(() => fake.instances[i]); }
    const old = await f.client.start({ commandId: 'queued', objective: 'Old pending goal' });
    assert.equal(old.phase, 'queued'); assert.equal(old.baseline, undefined);
    const revised = await f.client.control(old.id, { commandId: 'revise', type: 'revise', expectedRevision: old.revision, objective: 'New pending goal', spec, reason: 'Change before dispatch' });
    assert.deepEqual(revised.order.revisionContext?.unavailable, ['base', 'proposal']);
    assert.equal(revised.order.revisionContext?.conflictPreviewAvailable, false);
    for (let i = 0; i < 2; i++) await f.client.cancel(blockers[i]!.id, { commandId: `stop-${i}`, type: 'cancel', expectedRevision: f.store.get(blockers[i]!.id).revision });
    const worker = await waitFor(() => fake.instances[2]); assert.equal(worker.order.runId, old.id); assert.equal(worker.order.epoch, 2);
    assert.equal((await context(worker, 'current')).content, 'original');
    await assert.rejects(context(worker, 'base'), { code: 'CONTEXT_VERSION_MISSING' });
    const conflicts = await client(worker).context(worker.order.attemptId, { kind: 'conflicts', offset: 0, limit: 100 });
    assert.ok('conflicts' in conflicts); assert.equal(conflicts.available, false);
  } finally { await f.cleanup(); }
});

test('revision receipt failure rolls back history, baseline, descendants, events and outbox', async () => {
  const f = await fixture(), audit = new DatabaseSync(join(f.data, 'state.sqlite'));
  try {
    await writeFile(join(f.source, 'hello.txt'), 'user edit');
    const plan = await f.client.previewIntegration(f.original.id);
    const conflict = await f.client.integrate(f.original.id, { commandId: 'conflict', type: 'integrate', expectedRevision: f.original.revision, planId: plan.id });
    const child = await f.client.resolveIntegration(f.original.id, conflict.id, { commandId: 'resolve', type: 'resolve', expectedRevision: conflict.revision, planId: plan.id, instructions: 'Combine changes' });
    await waitFor(() => f.fake.instances[2]);
    await f.client.control(child.id, { commandId: 'pause-child', type: 'pause', mode: 'interrupt', expectedRevision: f.store.get(child.id).revision });
    const childBefore = await waitFor(() => { const r = f.store.get(child.id); return r.phase === 'paused' ? r : undefined; });
    const input = f.command(), before = f.store.get(f.original.id);
    const counts = () => ['runs', 'artifacts', 'outbox', 'events', 'commands'].map(table => audit.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
    const originalCounts = counts();
    audit.exec("CREATE TRIGGER revision_failure BEFORE INSERT ON commands WHEN NEW.id='host:revise' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    await assert.rejects(f.client.control(f.original.id, input), { code: 'INTERNAL_ERROR' });
    assert.deepEqual(f.store.get(f.original.id), before); assert.deepEqual(counts(), originalCounts); assert.equal(f.fake.instances.length, 3);
    assert.deepEqual(f.store.get(child.id), childBefore);
    audit.exec('DROP TRIGGER revision_failure');
    const revised = await f.client.control(f.original.id, input); assert.equal(revised.order.specRevision, 2);
    assert.equal(f.store.get(child.id).phase, 'superseded');
    assert.deepEqual(await f.client.control(f.original.id, input), revised);
  } finally { audit.close(); await f.cleanup(); }
});

test('queued revision survives SQLite reopen with the captured baseline and revokes the old spec', async () => {
  const f = await fixture(); let store: Store | undefined, server: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    for (let i = 0; i < 2; i++) { await f.client.start({ commandId: `block-${i}`, objective: 'Hold slot' }); await waitFor(() => f.fake.instances[2 + i]); }
    await writeFile(join(f.source, 'hello.txt'), 'captured user edit');
    const input = f.command(), revised = await f.client.control(f.original.id, input); assert.equal(revised.phase, 'queued');
    await f.server.close(); f.store.close();
    await writeFile(join(f.source, 'hello.txt'), 'later user edit');
    store = new Store(join(f.data, 'state.sqlite'));
    const fake = new FakeExecutor(), runtime = new Runtime(store, fake, { source: f.source, attemptsDirectory: join(f.data, 'attempts'), maxConcurrency: 2,
      attemptTimeoutMs: 10_000, executionProfile: { driver: 'test' }, verification: policy, integration: { enabled: true } });
    server = await serve(runtime, f.token);
    const worker = await waitFor(() => fake.instances[0]);
    assert.equal(worker.order.runId, revised.id); assert.equal(worker.order.specRevision, 2);
    assert.equal(await readFile(join(worker.order.workspace, 'hello.txt'), 'utf8'), 'captured user edit');
    assert.deepEqual(await new Client(server.url, f.token).control(revised.id, input), revised);
    assert.equal(store.get(revised.id).specHistory?.[0]?.previous.gate, 'passed');
  } finally {
    if (store) { await server?.close(); store.close(); await rm(f.root, { recursive: true, force: true }); }
    else await f.cleanup();
  }
});

for (const damaged of [false, true]) test(`revision can replace unavailable old artifacts but cannot use tampered new references: damaged=${damaged}`, async () => {
  const f = await fixture();
  try {
    if (damaged) await writeFile(join(f.original.candidate!.workspace, 'hello.txt'), 'tampered old reference');
    const revised = await f.client.control(f.original.id, f.command());
    const worker = await waitFor(() => f.fake.instances[2]);
    if (damaged) {
      assert.ok(revised.order.revisionContext?.unavailable.includes('proposal'));
      await assert.rejects(context(worker, 'proposal'), { code: 'CONTEXT_VERSION_MISSING' });
      const ready = await finish(f, 2); assert.equal(ready.phase, 'verified');
    } else {
      await writeFile(join(revised.order.revisionContext!.inputs.proposal!.workspace, 'hello.txt'), 'changed after binding');
      await assert.rejects(context(worker, 'proposal'), { code: 'ARTIFACT_CHANGED' });
      await writeFile(join(worker.order.workspace, 'hello.txt'), 'fixed-v2'); await submit(worker);
      const failed = await waitFor(() => { const r = f.store.get(revised.id); return r.phase === 'failed' ? r : undefined; });
      assert.equal(failed.reason, 'REVISION_CONTEXT_CHANGED'); assert.equal(f.fake.instances.length, 3);
    }
  } finally { await f.cleanup(); }
});
