import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '../src/client.js';
import { Store } from '../src/store.js';
import { repairEligible, repairFeedback } from '../src/kernel.js';
import { terminal, verificationSchema, type Report, type Run, type VerificationPolicy } from '../src/contracts.js';
import { report, FakeExecutor, setup, waitFor } from './helpers.js';

const approved: Report = { ...report, review: { functionality: 'pass', completeness: 'pass', findings: [] } };
const rejected: Report = { ...report, review: { functionality: 'fail', completeness: 'pass', findings: ['Boundary case broken'] } };
const policy: VerificationPolicy = { maxIterations: 2, commands: [{ id: 'accept', executable: process.execPath,
  args: ['-e', "require('node:assert').equal(require('node:fs').readFileSync('hello.txt','utf8'),'fixed')"], timeoutMs: 5000 }] };
async function submit(attempt: FakeExecutor['instances'][number], value: Report = report, commandId = 'submit') {
  return new Client(attempt.bridge.url, attempt.bridge.token).bridge(attempt.order.attemptId, 'submit', {
    commandId, epoch: attempt.order.epoch, inputDigest: attempt.order.inputDigest, report: value,
  });
}
async function settle(f: Awaited<ReturnType<typeof setup>>, id: string): Promise<Run> {
  return waitFor(() => { const r = f.store.get(id); return terminal(r.phase) ? r : undefined; });
}

for (const defect of ['acceptance', 'review', 'incomplete'] as const) test(`bounded repair fixes ${defect} with fresh attempts and retained evidence`, async () => {
  const fake = new FakeExecutor(), f = await setup(fake, 5000, policy);
  try {
    const run = await f.client.start({ commandId: 'start', objective: 'Fix the boundary case' });
    const first = await waitFor(() => fake.instances[0]);
    const firstContent = defect === 'acceptance' ? 'broken' : 'fixed';
    await writeFile(join(first.order.workspace, 'hello.txt'), firstContent);
    await writeFile(join(first.order.workspace, 'preserved.txt'), 'keep this implementation change');
    const firstReport: Report = defect === 'incomplete' ? { ...report, outcome: 'incomplete', unresolved: ['Need another pass'] } : report;
    await submit(first, firstReport);
    first.finish();
    const reviewer = await waitFor(() => fake.instances[1]);
    await submit(reviewer, defect === 'review' ? rejected : approved); reviewer.finish();
    const repair = await waitFor(() => fake.instances[2]);
    assert.equal(first.closed && reviewer.closed, true);
    assert.equal(await readFile(join(repair.order.workspace, 'hello.txt'), 'utf8'), firstContent);
    assert.equal(await readFile(join(repair.order.workspace, 'preserved.txt'), 'utf8'), 'keep this implementation change');
    assert.equal(repair.order.epoch, 2);
    assert.equal(repair.order.workItemId, first.order.workItemId);
    assert.equal(repair.order.specRevision, first.order.specRevision);
    assert.equal(repair.order.objective, first.order.objective);
    assert.notEqual(repair.order.inputDigest, first.order.inputDigest);
    assert.notEqual(repair.order.dispatchKey, first.order.dispatchKey);
    assert.notEqual(repair.bridge.token, first.bridge.token);
    const repairing = f.store.get(run.id);
    assert.equal(repairing.iteration, 2);
    assert.equal(repairing.history?.length, 1);
    assert.equal(repairing.report, undefined);
    assert.equal(repairing.reviewAttempt, undefined);
    assert.equal(repairing.gate, 'not_evaluated');
    assert.deepEqual(repair.order.repair?.candidate, repairing.history![0]!.candidate);
    assert.match(repair.order.repair!.feedback, new RegExp(defect === 'acceptance' ? 'ACCEPTANCE_FAILED' : defect === 'review' ? 'Boundary case broken' : 'Need another pass'));
    await assert.rejects(submit(first, report, 'late'), { code: 'RESULT_STALE' });
    await assert.rejects(submit(reviewer, approved, 'late'), { code: 'RESULT_STALE' });
    // An old idempotent receipt can be replayed, but cannot overwrite the current round.
    await submit(first, firstReport); assert.equal(f.store.get(run.id).report, undefined);
    await writeFile(join(repair.order.workspace, 'hello.txt'), 'fixed');
    await submit(repair); repair.finish();
    const freshReview = await waitFor(() => fake.instances[3]);
    assert.equal(freshReview.order.repair, undefined);
    assert.equal(freshReview.order.epoch, 2);
    assert.notEqual(freshReview.order.attemptId, reviewer.order.attemptId);
    await submit(freshReview, approved); freshReview.finish();
    const result = await settle(f, run.id);
    assert.equal(result.phase, 'verified', JSON.stringify(result));
    assert.equal(result.history?.length, 1);
    assert.equal(fake.instances.length, 4);
    assert.equal(new Set(fake.instances.map(i => i.order.attemptId)).size, 4);
    assert.equal(await readFile(join(result.history![0]!.candidate!.workspace, 'hello.txt'), 'utf8'), firstContent);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'original');
    assert.ok(f.store.events(run.id, 0).some(e => e.type === 'gate.failed_repair_queued'));
  } finally { await f.cleanup(); }
});

for (const maxIterations of [undefined, 2]) test(`repair budget is total rounds: ${maxIterations ?? 'default 1'}`, async () => {
  const { maxIterations: _max, ...once } = policy;
  const fake = new FakeExecutor(), f = await setup(fake, 5000, maxIterations ? { ...once, maxIterations } : once);
  try {
    const run = await f.client.start({ commandId: 'start', objective: 'Fix' });
    for (let i = 0; i < (maxIterations ?? 1); i++) {
      const impl = await waitFor(() => fake.instances[2 * i]);
      await submit(impl); impl.finish();
      const reviewer = await waitFor(() => fake.instances[2 * i + 1]);
      await submit(reviewer, approved); reviewer.finish();
    }
    const result = await settle(f, run.id);
    assert.equal(result.phase, 'rejected');
    assert.equal(result.iteration, maxIterations ?? 1);
    assert.equal(result.history?.length, (maxIterations ?? 1) - 1);
    assert.equal(fake.instances.length, 2 * (maxIterations ?? 1));
    assert.deepEqual(f.store.pending(), []);
  } finally { await f.cleanup(); }
});

for (const failure of ['review-mutation', 'spawn-failure', 'repair-base-mutation']) test(`automatic repair refuses ${failure}`, async () => {
  const verification = failure === 'spawn-failure' ? { ...policy, commands: [{ ...policy.commands[0]!, executable: join(process.cwd(), 'missing-command.exe') }] } : policy;
  const fake = new FakeExecutor(), f = await setup(fake, 5000, verification);
  try {
    if (failure === 'repair-base-mutation') {
      const finishGate = f.store.finishGate.bind(f.store);
      f.store.finishGate = (...args) => {
        const result = finishGate(...args);
        if (result.phase === 'repair_queued') writeFileSync(join(result.candidate!.workspace, 'hello.txt'), 'tampered');
        return result;
      };
    }
    const run = await f.client.start({ commandId: 'start', objective: 'Fix' });
    const impl = await waitFor(() => fake.instances[0]);
    await submit(impl); impl.finish();
    const reviewer = await waitFor(() => fake.instances[1]);
    if (failure === 'review-mutation') await writeFile(join(reviewer.order.workspace, 'hello.txt'), 'tampered');
    await submit(reviewer, approved); reviewer.finish();
    const result = await settle(f, run.id);
    assert.equal(result.phase, failure === 'repair-base-mutation' ? 'failed' : 'rejected');
    if (failure === 'repair-base-mutation') assert.equal(result.reason, 'CANDIDATE_CHANGED');
    assert.equal(fake.instances.length, 2);
    assert.deepEqual(f.store.pending(), []);
  } finally { await f.cleanup(); }
});

function failedRound(store: Store, workspace: string): Run {
  const run = store.start({ commandId: randomUUID(), objective: 'Fix' }, workspace, {}, policy);
  store.claim(run.id, 'impl-token');
  store.recordBaseline(run.id, { workspace: join(workspace, 'baseline'), digest: 'b'.repeat(64) });
  store.move(run.id, 'running');
  store.bridge(run.order.attemptId, 'impl-token', 'submit', { commandId: 'submit', epoch: 1, inputDigest: run.order.inputDigest, report });
  store.move(run.id, 'freezing');
  const candidate = { workspace: join(workspace, 'candidate'), digest: 'a'.repeat(64) };
  store.recordScopeCheck(run.id, { inputDigest: run.order.inputDigest, baselineDigest: 'b'.repeat(64), candidateDigest: candidate.digest, violations: [] });
  const order = { ...run.order, attemptId: randomUUID(), role: 'review' as const, candidateDigest: candidate.digest };
  store.prepareReview(run.id, candidate, order, 'review-token');
  store.bridge(order.attemptId, 'review-token', 'submit', { commandId: 'submit', epoch: 1, inputDigest: order.inputDigest, report: approved });
  store.move(run.id, 'validating');
  return store.finishGate(run.id, [{ commandId: 'accept', status: 'failed', exitCode: 1, durationMs: 1, stdoutTail: '', stderrTail: 'test failed' }], true);
}

test('repair outbox survives SQLite reopen; claimed repair is quarantined and never redispatched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamwork-repair-recovery-'));
  let store = new Store(join(root, 'state.sqlite'));
  try {
    const failed = failedRound(store, root);
    assert.equal(failed.phase, 'repair_queued');
    store.close(); store = new Store(join(root, 'state.sqlite')); store.recover();
    assert.deepEqual(store.pending(), [failed.id]);
    const claimed = store.claim(failed.id, 'new-token');
    assert.equal(claimed.iteration, 2);
    assert.equal(claimed.history?.[0]?.validation?.[0]?.stderrTail, 'test failed');
    store.close(); store = new Store(join(root, 'state.sqlite')); store.recover();
    assert.equal(store.get(failed.id).phase, 'blocked');
    assert.deepEqual(store.pending(), []);
    assert.throws(() => store.claim(failed.id, 'another-token'), { code: 'DISPATCH_CLAIMED' });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('queued repair cancellation is atomic, revision checked and replayable', () => {
  const store = new Store(':memory:');
  try {
    const run = failedRound(store, process.cwd());
    const input = { commandId: 'cancel', type: 'cancel' as const, expectedRevision: run.revision };
    assert.throws(() => store.cancel(run.id, { ...input, expectedRevision: 0 }), { code: 'REVISION_CONFLICT' });
    const cancelled = store.cancel(run.id, input);
    assert.equal(cancelled.phase, 'cancelled');
    assert.deepEqual(store.cancel(run.id, input), cancelled);
    assert.deepEqual(store.pending(), []);
    assert.equal(cancelled.iteration, 1);
  } finally { store.close(); }
});

test('repair policy rejects excess budgets, missing/stale evidence, and bounds feedback', () => {
  for (const limit of [0, -1, 6, 1.5]) assert.equal(verificationSchema.safeParse({ ...policy, maxIterations: limit }).success, false);
  const store = new Store(':memory:');
  try {
    const run = failedRound(store, process.cwd());
    assert.equal(repairEligible(run, run.gateReasons!), true);
    for (const reason of ['CANDIDATE_CHANGED', 'ACCEPTANCE_INPUT_CHANGED', 'REVIEW_STALE']) assert.equal(repairEligible(run, [reason]), false);
    assert.equal(repairEligible({ ...run, validation: [] }, ['ACCEPTANCE_FAILED']), false);
    assert.equal(repairEligible({ ...run, iteration: 2 }, ['ACCEPTANCE_FAILED']), false);
    assert.ok(repairFeedback({ ...run, reviewAttempt: { ...run.reviewAttempt!, report: {
      ...rejected, review: { ...rejected.review!, findings: Array(100).fill('x'.repeat(2000)) as string[] },
    } } }).length <= 16_000);
  } finally { store.close(); }
});
