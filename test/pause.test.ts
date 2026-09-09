import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '../src/client.js';
import { Store } from '../src/store.js';
import { Runtime } from '../src/runtime.js';
import { serve } from '../src/server.js';
import { snapshot, treeDigest } from '../src/workspace.js';
import { terminal, type Report, type VerificationPolicy } from '../src/contracts.js';
import { FakeExecutor, setup, report, waitFor } from './helpers.js';

const approved: Report = { ...report, review: { functionality: 'pass', completeness: 'pass', findings: [] } };
const verification: VerificationPolicy = { maxIterations: 2, commands: [{ id: 'accept', executable: process.execPath,
  args: ['-e', "require('node:assert').equal(require('node:fs').readFileSync('hello.txt','utf8'),'fixed')"], timeoutMs: 5000 }] };
async function send(attempt: FakeExecutor['instances'][number], value = report as Report, kind: 'checkpoint' | 'submit' = 'submit', commandId: string = kind) {
  return new Client(attempt.bridge.url, attempt.bridge.token).bridge(attempt.order.attemptId, kind, {
    commandId, epoch: attempt.order.epoch, inputDigest: attempt.order.inputDigest, report: value,
  });
}
async function paused(f: Awaited<ReturnType<typeof setup>>, id: string) {
  return waitFor(() => { const r = f.store.get(id); return r.phase === 'paused' ? r : undefined; });
}
async function resume(f: Awaited<ReturnType<typeof setup>>, id: string, commandId = 'resume') {
  return f.client.control(id, { commandId, type: 'resume', expectedRevision: f.store.get(id).revision });
}
async function startReview(f: Awaited<ReturnType<typeof setup>>, fake: FakeExecutor) {
  const run = await f.client.start({ commandId: 'start', objective: 'Fix hello' });
  const impl = await waitFor(() => fake.instances[0]);
  await writeFile(join(impl.order.workspace, 'hello.txt'), 'fixed');
  await send(impl); impl.finish();
  const reviewer = await waitFor(() => fake.instances[1]);
  return { run, impl, reviewer };
}

test('queued pause prevents dispatch; resume receipt is idempotent and starts exactly once', async () => {
  const fake = new FakeExecutor(), f = await setup(fake);
  try {
    // Both calls occur before the first scheduling microtask.
    const run = f.runtime.start({ commandId: 'start', objective: 'Fix' });
    const stopped = f.runtime.control(run.id, { type: 'pause', mode: 'drain', commandId: 'pause', expectedRevision: run.revision });
    assert.equal(stopped.phase, 'paused');
    await f.client.status(run.id);
    assert.equal(fake.instances.length, 0);
    assert.deepEqual(f.store.pending(), []);
    await assert.rejects(f.client.control(run.id, { type: 'resume', commandId: 'stale', expectedRevision: 0 }), { code: 'REVISION_CONFLICT' });
    const command = { type: 'resume' as const, commandId: 'resume', expectedRevision: stopped.revision };
    const a = await f.client.control(run.id, command), b = await f.client.control(run.id, command);
    assert.deepEqual(a, b);
    const attempt = await waitFor(() => fake.instances[0]);
    assert.equal(fake.instances.length, 1);
    assert.equal(attempt.order.attemptId, run.order.attemptId);
    assert.equal(attempt.order.epoch, 1);
  } finally { await f.cleanup(); }
});

test('interrupt freezes stopped outputs, preserves checkpoint and resumes a new attempt without touching another run', async () => {
  const fake = new FakeExecutor(), f = await setup(fake);
  try {
    const run = await f.client.start({ commandId: 'start', objective: 'Fix' });
    const first = await waitFor(() => fake.instances[0]);
    const other = await f.client.start({ commandId: 'other', objective: 'Other' });
    await waitFor(() => fake.instances[1]);
    await writeFile(join(first.order.workspace, 'hello.txt'), 'partial work');
    await send(first, { ...report, summary: 'Saved checkpoint' }, 'checkpoint');
    const request = await f.client.control(run.id, { type: 'pause', mode: 'interrupt', commandId: 'pause', expectedRevision: f.store.get(run.id).revision });
    assert.equal(request.phase, 'pausing');
    await assert.rejects(send(first), { code: 'RESULT_STALE' });
    const stopped = await paused(f, run.id);
    assert.equal(first.closed, true);
    assert.equal(fake.instances[1]!.closed, false);
    assert.equal(f.store.get(other.id).phase, 'running');
    assert.equal(stopped.gate, 'not_evaluated');
    assert.equal(stopped.pause?.continuation?.kind, 'implementation');
    await writeFile(join(f.source, 'hello.txt'), 'user changed original');
    await resume(f, run.id);
    const replacement = await waitFor(() => fake.instances[2]);
    assert.equal(await readFile(join(replacement.order.workspace, 'hello.txt'), 'utf8'), 'partial work');
    assert.equal(replacement.order.resume?.checkpoint?.summary, 'Saved checkpoint');
    assert.equal(replacement.order.epoch, 2);
    assert.equal(replacement.order.workItemId, first.order.workItemId);
    assert.notEqual(replacement.order.attemptId, first.order.attemptId);
    assert.notEqual(replacement.bridge.token, first.bridge.token);
    assert.notEqual(replacement.order.inputDigest, first.order.inputDigest);
    assert.equal(f.store.get(run.id).iteration, 1);
    assert.equal(f.store.get(run.id).suspensions?.length, 1);
    await assert.rejects(send(first, report, 'submit', 'late'), { code: 'RESULT_STALE' });
    await send(replacement); replacement.finish();
    await waitFor(() => f.store.get(run.id).phase === 'submitted' ? true : undefined);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'user changed original');
  } finally { await f.cleanup(); }
});

for (const verify of [false, true]) test(`drain accepts current submission but dispatches no reviewer until resume; verification=${verify}`, async () => {
  const fake = new FakeExecutor(), f = await setup(fake, 5000, verify ? verification : undefined);
  try {
    const run = await f.client.start({ commandId: 'start', objective: 'Fix' });
    const impl = await waitFor(() => fake.instances[0]);
    await f.client.control(run.id, { type: 'pause', mode: 'drain', commandId: 'pause', expectedRevision: f.store.get(run.id).revision });
    assert.equal(impl.closed, false);
    await assert.rejects(resume(f, run.id), { code: 'NOT_PAUSED' });
    await writeFile(join(impl.order.workspace, 'hello.txt'), 'fixed');
    await send(impl);
    assert.equal(f.store.get(run.id).phase, 'pausing');
    impl.finish();
    const stopped = await paused(f, run.id);
    assert.equal(fake.instances.length, 1);
    assert.equal(stopped.pause?.continuation?.kind, verify ? 'verification' : 'submitted');
    await resume(f, run.id);
    if (verify) {
      const reviewer = await waitFor(() => fake.instances[1]);
      assert.equal(reviewer.order.role, 'review');
      await send(reviewer, approved); reviewer.finish();
    }
    const settled = await waitFor(() => { const r = f.store.get(run.id); return terminal(r.phase) ? r : undefined; });
    assert.equal(settled.phase, verify ? 'verified' : 'submitted');
    assert.equal(fake.instances.filter(i => i.order.role !== 'review').length, 1);
  } finally { await f.cleanup(); }
});

for (const mode of ['drain', 'interrupt'] as const) test(`paused review ${mode} resumes with a fresh independent reviewer and keeps old evidence`, async () => {
  const fake = new FakeExecutor(), f = await setup(fake, 5000, verification);
  try {
    const { run, reviewer } = await startReview(f, fake);
    await f.client.control(run.id, { type: 'pause', mode, commandId: 'pause', expectedRevision: f.store.get(run.id).revision });
    if (mode === 'drain') { await send(reviewer, approved); reviewer.finish(); }
    const stopped = await paused(f, run.id);
    assert.equal(reviewer.closed, true);
    assert.equal(stopped.pause?.continuation?.kind, 'verification');
    await resume(f, run.id);
    const fresh = await waitFor(() => fake.instances[2]);
    assert.equal(fresh.order.role, 'review');
    assert.notEqual(fresh.order.attemptId, reviewer.order.attemptId);
    assert.notEqual(fresh.bridge.token, reviewer.bridge.token);
    assert.equal(fresh.order.resume, undefined);
    assert.equal(f.store.get(run.id).suspensions?.[0]?.reviewAttempt?.order.attemptId, reviewer.order.attemptId);
    await assert.rejects(send(reviewer, approved, 'submit', 'late'), { code: 'RESULT_STALE' });
    await send(fresh, approved); fresh.finish();
    await waitFor(() => f.store.get(run.id).phase === 'verified' ? true : undefined);
    assert.equal(fake.instances.filter(i => i.order.role !== 'review').length, 1);
  } finally { await f.cleanup(); }
});

test('draining acceptance pauses between commands, then revalidates the frozen candidate from a fresh copy', async () => {
  const fake = new FakeExecutor();
  const f = await setup(fake, 5000, { ...verification, commands: [
    { id: 'slow', executable: process.execPath, args: ['-e', 'setTimeout(()=>{},500)'], timeoutMs: 5000 },
    verification.commands[0]!,
  ] });
  try {
    const { run, reviewer } = await startReview(f, fake);
    await send(reviewer, approved); reviewer.finish();
    await waitFor(() => f.store.get(run.id).phase === 'validating' ? true : undefined);
    await f.client.control(run.id, { type: 'pause', mode: 'drain', commandId: 'pause', expectedRevision: f.store.get(run.id).revision });
    const stopped = await paused(f, run.id);
    assert.ok((stopped.validation?.length ?? 0) <= 1);
    assert.equal(stopped.gate, 'not_evaluated');
    await resume(f, run.id);
    const fresh = await waitFor(() => fake.instances[2]);
    await send(fresh, approved); fresh.finish();
    await waitFor(() => f.store.get(run.id).phase === 'verified' ? true : undefined);
    assert.equal(f.store.get(run.id).validation?.length, 2);
  } finally { await f.cleanup(); }
});

test('interrupting acceptance confirms its exit and leaves no passed gate', async () => {
  const fake = new FakeExecutor(), f = await setup(fake, 5000, { commands: [{ id: 'slow', executable: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 5000 }] });
  try {
    const { run, reviewer } = await startReview(f, fake);
    await send(reviewer, approved); reviewer.finish();
    await waitFor(() => f.store.get(run.id).phase === 'validating' ? true : undefined);
    await f.client.control(run.id, { type: 'pause', mode: 'interrupt', commandId: 'pause', expectedRevision: f.store.get(run.id).revision });
    const stopped = await paused(f, run.id);
    assert.equal(stopped.gate, 'not_evaluated');
    assert.equal(stopped.pause?.continuation?.kind, 'verification');
    await f.client.cancel(run.id, { type: 'cancel', commandId: 'cancel', expectedRevision: stopped.revision });
    assert.equal(f.store.get(run.id).phase, 'cancelled');
  } finally { await f.cleanup(); }
});

test('drain can escalate to interrupt; cancellation overrides a pending pause', async () => {
  const fake = new FakeExecutor(), f = await setup(fake);
  try {
    const run = await f.client.start({ commandId: 'start', objective: 'Fix' });
    const first = await waitFor(() => fake.instances[0]);
    f.runtime.control(run.id, { type: 'pause', mode: 'drain', commandId: 'pause', expectedRevision: f.store.get(run.id).revision });
    f.runtime.control(run.id, { type: 'pause', mode: 'interrupt', commandId: 'interrupt', expectedRevision: f.store.get(run.id).revision });
    f.runtime.cancel(run.id, { type: 'cancel', commandId: 'cancel', expectedRevision: f.store.get(run.id).revision });
    await waitFor(() => f.store.get(run.id).phase === 'cancelled' ? true : undefined);
    assert.equal(first.closed, true);
    assert.equal(f.store.get(run.id).pause, undefined);
    await assert.rejects(resume(f, run.id), { code: 'NOT_PAUSED' });
  } finally { await f.cleanup(); }
});

test('pause cannot disguise unconfirmed exit or a natural execution failure', async () => {
  for (const unknown of [false, true]) {
    const fake = new FakeExecutor(), f = await setup(fake);
    try {
      const run = await f.client.start({ commandId: 'start', objective: 'Fix' });
      const first = await waitFor(() => fake.instances[0]);
      fake.failClose = unknown;
      await f.client.control(run.id, { type: 'pause', mode: unknown ? 'interrupt' : 'drain', commandId: 'pause', expectedRevision: f.store.get(run.id).revision });
      if (!unknown) first.finish(); // No report: a natural failure, not a resumable success.
      await waitFor(() => terminal(f.store.get(run.id).phase) ? true : undefined);
      assert.equal(f.store.get(run.id).phase, unknown ? 'blocked' : 'failed');
      assert.equal(f.store.get(run.id).reason, unknown ? 'EXTERNAL_STATE_UNKNOWN' : 'RESULT_MISSING');
      await assert.rejects(resume(f, run.id), { code: unknown ? 'UNAVAILABLE' : 'NOT_PAUSED' });
    } finally { await f.cleanup(); }
  }
});

test('paused source snapshot tampering fails before replacement process launch', async () => {
  const fake = new FakeExecutor(), f = await setup(fake);
  try {
    const run = await f.client.start({ commandId: 'start', objective: 'Fix' });
    await waitFor(() => fake.instances[0]);
    await f.client.control(run.id, { type: 'pause', mode: 'interrupt', commandId: 'pause', expectedRevision: f.store.get(run.id).revision });
    const stopped = await paused(f, run.id);
    const plan = stopped.pause!.continuation!;
    assert.equal(plan.kind, 'implementation');
    assert.ok('candidate' in plan && plan.candidate);
    await writeFile(join(plan.candidate.workspace, 'hello.txt'), 'tampered');
    await resume(f, run.id);
    await waitFor(() => f.store.get(run.id).phase === 'failed' ? true : undefined);
    assert.equal(f.store.get(run.id).reason, 'CANDIDATE_CHANGED');
    assert.equal(fake.instances.length, 1);
  } finally { await f.cleanup(); }
});

for (const scenario of ['queued', 'paused', 'tampered'] as const) test(`durable stopped candidate recovery: ${scenario}`, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'teamwork-candidate-recovery-')));
  const source = join(root, 'source'), data = join(root, 'data'), attemptsDirectory = join(data, 'attempts');
  await mkdir(source); await mkdir(data); await writeFile(join(source, 'hello.txt'), 'original');
  let store = new Store(join(data, 'state.sqlite'));
  const fake = new FakeExecutor();
  let server: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    const run = store.start({ commandId: 'start', objective: 'Fix' }, attemptsDirectory, {}, verification);
    store.claim(run.id, 'initial-token');
    const baselinePath = join(root, 'initial-baseline');
    await snapshot(source, baselinePath, new AbortController().signal);
    store.recordBaseline(run.id, { workspace: baselinePath, digest: await treeDigest(baselinePath, new AbortController().signal) });
    store.move(run.id, 'running');
    await snapshot(source, run.order.workspace, new AbortController().signal);
    await writeFile(join(run.order.workspace, 'hello.txt'), 'fixed');
    store.bridge(run.order.attemptId, 'initial-token', 'submit', { commandId: 'submit', epoch: 1, inputDigest: run.order.inputDigest, report });
    store.move(run.id, 'freezing');
    const candidatePath = join(root, 'stopped-candidate');
    await snapshot(run.order.workspace, candidatePath, new AbortController().signal, true);
    const candidate = { workspace: candidatePath, digest: await treeDigest(candidatePath, new AbortController().signal) };
    const queued = store.queueVerification(run.id, candidate);
    assert.equal(queued.phase, 'verification_queued');
    if (scenario === 'paused') store.pause(run.id, { type: 'pause', mode: 'drain', commandId: 'pause', expectedRevision: queued.revision });
    if (scenario === 'tampered') await writeFile(join(candidatePath, 'hello.txt'), 'tampered');
    // Simulate a crash after the stopped candidate/outbox transaction, before any reviewer claim.
    store.close(); store = new Store(join(data, 'state.sqlite'));
    const runtime = new Runtime(store, fake, { source, attemptsDirectory, maxConcurrency: 1, attemptTimeoutMs: 5000, executionProfile: {}, verification });
    server = await serve(runtime, 'x'.repeat(32));
    if (scenario === 'paused') {
      assert.equal(store.get(run.id).phase, 'paused');
      assert.equal(fake.instances.length, 0);
      runtime.control(run.id, { type: 'resume', commandId: 'resume', expectedRevision: store.get(run.id).revision });
    }
    if (scenario === 'tampered') {
      await waitFor(() => store.get(run.id).phase === 'failed' ? true : undefined);
      assert.equal(store.get(run.id).reason, 'CANDIDATE_CHANGED');
      assert.equal(fake.instances.length, 0);
      return;
    }
    const reviewer = await waitFor(() => fake.instances[0]);
    assert.equal(reviewer.order.role, 'review');
    assert.equal(await readFile(join(reviewer.order.workspace, 'hello.txt'), 'utf8'), 'fixed');
    await send(reviewer, approved); reviewer.finish();
    await waitFor(() => store.get(run.id).phase === 'verified' ? true : undefined);
    assert.equal(fake.instances.length, 1);
    assert.equal(await readFile(join(source, 'hello.txt'), 'utf8'), 'original');
  } finally { await server?.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test('repair after a resumed implementation uses the latest failed candidate, not its old pause snapshot', async () => {
  const fake = new FakeExecutor(), f = await setup(fake, 5000, verification);
  try {
    const run = await f.client.start({ commandId: 'start', objective: 'Fix' });
    const initial = await waitFor(() => fake.instances[0]);
    await writeFile(join(initial.order.workspace, 'hello.txt'), 'paused content');
    await f.client.control(run.id, { type: 'pause', mode: 'interrupt', commandId: 'pause', expectedRevision: f.store.get(run.id).revision });
    await paused(f, run.id); await resume(f, run.id);
    const replacement = await waitFor(() => fake.instances[1]);
    await writeFile(join(replacement.order.workspace, 'hello.txt'), 'resumed but still defective');
    await writeFile(join(replacement.order.workspace, 'new-change.txt'), 'must survive repair');
    await send(replacement); replacement.finish();
    const reviewer = await waitFor(() => fake.instances[2]);
    await send(reviewer, approved); reviewer.finish();
    const repair = await waitFor(() => fake.instances[3]);
    assert.equal(repair.order.resume, undefined);
    assert.equal(repair.order.epoch, 3);
    assert.equal(f.store.get(run.id).iteration, 2);
    assert.equal(await readFile(join(repair.order.workspace, 'hello.txt'), 'utf8'), 'resumed but still defective');
    assert.equal(await readFile(join(repair.order.workspace, 'new-change.txt'), 'utf8'), 'must survive repair');
  } finally { await f.cleanup(); }
});

test('paused state survives SQLite reopen; pausing with unknown owned process is blocked', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'teamwork-pause-recovery-')));
  let store = new Store(join(root, 'state.sqlite'));
  try {
    const queued = store.start({ commandId: 'queued', objective: 'Fix' }, root, {});
    store.pause(queued.id, { type: 'pause', mode: 'drain', commandId: 'pause-q', expectedRevision: 0 });
    const active = store.start({ commandId: 'active', objective: 'Fix' }, root, {});
    store.claim(active.id, 'token'); store.move(active.id, 'running');
    store.pause(active.id, { type: 'pause', mode: 'drain', commandId: 'pause-a', expectedRevision: store.get(active.id).revision });
    store.close(); store = new Store(join(root, 'state.sqlite')); store.recover();
    assert.equal(store.get(queued.id).phase, 'paused');
    assert.equal(store.get(active.id).phase, 'blocked');
    assert.deepEqual(store.pending(), []);
    store.resume(queued.id, { type: 'resume', commandId: 'resume', expectedRevision: store.get(queued.id).revision });
    assert.deepEqual(store.pending(), [queued.id]);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
