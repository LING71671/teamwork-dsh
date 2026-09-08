import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Client } from '../src/client.js';
import { report, FakeExecutor, setup, waitFor } from './helpers.js';
import { terminal, type Report, type VerificationPolicy } from '../src/contracts.js';
import { validateCommand } from '../src/validation.js';
import { runOwned } from '../src/owned-execution.js';
import { evaluateGate } from '../src/kernel.js';

const approved: Report = { ...report, review: { functionality: 'pass', completeness: 'pass', findings: [] } };
const policy = (script = "require('node:assert').equal(require('node:fs').readFileSync('hello.txt','utf8'),'changed')"): VerificationPolicy => ({
  commands: [{ id: 'accept', executable: process.execPath, args: ['-e', script], timeoutMs: 5_000 }],
});
async function submit(attempt: FakeExecutor['instances'][number], value = report as Report, commandId = 'submit') {
  return new Client(attempt.bridge.url, attempt.bridge.token).bridge(attempt.order.attemptId, 'submit', {
    commandId, epoch: attempt.order.epoch, inputDigest: attempt.order.inputDigest, report: value,
  });
}
async function startReview(f: Awaited<ReturnType<typeof setup>>, fake: FakeExecutor) {
  const run = await f.client.start({ commandId: 'start', objective: 'Change hello' });
  const implementation = await waitFor(() => fake.instances[0]);
  await writeFile(join(implementation.order.workspace, 'hello.txt'), 'changed');
  await submit(implementation); implementation.finish();
  const review = await waitFor(() => fake.instances[1]);
  return { run, implementation, review };
}

test('Gate needs independent review and command evidence for exact candidate; original project is untouched', async () => {
  const fake = new FakeExecutor(), f = await setup(fake, 5_000, policy());
  try {
    const { run, implementation, review } = await startReview(f, fake);
    assert.equal(implementation.closed, true);
    assert.notEqual(implementation.order.attemptId, review.order.attemptId);
    assert.notEqual(implementation.bridge.token, review.bridge.token);
    assert.notEqual(implementation.order.workspace, review.order.workspace);
    assert.equal(review.order.role, 'review');
    await assert.rejects(submit(implementation, report, 'late'), { code: 'RESULT_STALE' });
    await assert.rejects(submit(review), { code: 'REVIEW_REQUIRED' });
    await submit(review, approved);
    assert.equal(f.store.get(run.id).phase, 'reviewing');
    assert.equal(f.store.get(run.id).gate, 'not_evaluated');
    review.finish();
    const result = await waitFor(() => { const r = f.store.get(run.id); return terminal(r.phase) ? r : undefined; });
    assert.equal(result.phase, 'verified', JSON.stringify(result));
    assert.equal(result.gate, 'passed');
    assert.equal(result.validation![0]!.exitCode, 0);
    assert.equal(result.candidate!.digest, result.reviewAttempt!.order.candidateDigest);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'original');
  } finally { await f.cleanup(); }
});

for (const scenario of ['review-fail', 'command-fail', 'command-timeout', 'review-mutated', 'candidate-mutated', 'acceptance-mutated'] as const) {
  test(`Gate rejects ${scenario}`, async () => {
    const command = scenario === 'command-fail' ? policy('process.exit(3)') : scenario === 'command-timeout'
      ? { commands: [{ ...policy('setInterval(()=>{},1000)').commands[0]!, timeoutMs: 100 }] } : scenario === 'acceptance-mutated'
      ? policy("require('node:fs').writeFileSync('hello.txt','cheat')") : policy();
    const fake = new FakeExecutor(), f = await setup(fake, 5_000, command);
    try {
      const { run, review } = await startReview(f, fake);
      if (scenario === 'review-mutated') await writeFile(join(review.order.workspace, 'hello.txt'), 'review edit');
      if (scenario === 'candidate-mutated') await writeFile(join(f.store.get(run.id).candidate!.workspace, 'hello.txt'), 'tamper');
      await submit(review, scenario === 'review-fail' ? { ...report,
        review: { functionality: 'fail', completeness: 'pass', findings: ['Boundary case broken'] } } : approved);
      review.finish();
      const result = await waitFor(() => { const r = f.store.get(run.id); return terminal(r.phase) ? r : undefined; });
      // Tampering before validation-copy creation is rejected before launching any command.
      if (scenario === 'candidate-mutated') { assert.equal(result.phase, 'failed'); assert.equal(result.reason, 'CANDIDATE_CHANGED'); }
      else {
        assert.equal(result.phase, 'rejected', JSON.stringify(result));
        assert.equal(result.gate, 'failed');
        assert.ok(result.gateReasons!.includes(scenario === 'review-fail' ? 'REVIEW_REJECTED' :
          ['command-fail', 'command-timeout'].includes(scenario) ? 'ACCEPTANCE_FAILED' : scenario === 'acceptance-mutated' ? 'ACCEPTANCE_INPUT_CHANGED' : 'CANDIDATE_CHANGED'));
      }
    } finally { await f.cleanup(); }
  });
}

test('acceptance build outputs stay separate from candidate; command credentials are scrubbed', async () => {
  const fake = new FakeExecutor();
  const f = await setup(fake, 5_000, policy("const fs=require('node:fs');if(Object.keys(process.env).some(k=>k.startsWith('TEAMWORK_'))) process.exit(2);fs.writeFileSync('build.txt','generated')"));
  const old = process.env.TEAMWORK_TEST_SECRET;
  process.env.TEAMWORK_TEST_SECRET = 'never-forward-this';
  try {
    const { run, review } = await startReview(f, fake);
    await submit(review, approved); review.finish();
    const result = await waitFor(() => { const r = f.store.get(run.id); return terminal(r.phase) ? r : undefined; });
    assert.equal(result.phase, 'verified');
    await assert.rejects(access(join(result.candidate!.workspace, 'build.txt')));
    await assert.rejects(access(join(f.source, 'build.txt')));
  } finally {
    if (old === undefined) delete process.env.TEAMWORK_TEST_SECRET; else process.env.TEAMWORK_TEST_SECRET = old;
    await f.cleanup();
  }
});

test('unconfirmed teardown is bounded; cancellation during teardown is not success', async () => {
  await assert.rejects(runOwned({ run: async () => {}, close: () => new Promise(() => {}) }, new AbortController().signal, 1_000, 25), { code: 'EXTERNAL_STATE_UNKNOWN' });
  const abort = new AbortController();
  await assert.rejects(runOwned({ run: async () => {}, close: async () => { abort.abort(); } }, abort.signal, 1_000));
});

test('Gate rejects incomplete implementation, stale review and missing command evidence even with positive review', async () => {
  const fake = new FakeExecutor(), f = await setup(fake, 5_000, policy());
  try {
    const { run, review } = await startReview(f, fake);
    await submit(review, approved); review.finish();
    const result = await waitFor(() => { const r = f.store.get(run.id); return terminal(r.phase) ? r : undefined; });
    assert.deepEqual(evaluateGate(result, true), []);
    assert.ok(evaluateGate({ ...result, report: { ...report, outcome: 'incomplete' } }, true).includes('IMPLEMENTATION_INCOMPLETE'));
    assert.ok(evaluateGate({ ...result, reviewAttempt: { ...result.reviewAttempt!, order: { ...review.order, specRevision: 999 } } }, true).includes('REVIEW_STALE'));
    assert.ok(evaluateGate({ ...result, validation: [] }, true).includes('ACCEPTANCE_FAILED'));
    assert.ok(f.store.events(run.id, 0).some(event => event.type === 'acceptance.command_finished'));
  } finally { await f.cleanup(); }
});

test('cancel during independent review closes that attempt and cannot pass Gate', async () => {
  const fake = new FakeExecutor(), f = await setup(fake, 5_000, policy());
  try {
    const { run, review } = await startReview(f, fake);
    await f.client.cancel(run.id, { commandId: 'cancel', expectedRevision: f.store.get(run.id).revision, type: 'cancel' });
    await waitFor(() => f.store.get(run.id).phase === 'cancelled' ? true : undefined);
    assert.equal(review.closed, true);
    assert.equal(f.store.get(run.id).gate, 'not_evaluated');
    await assert.rejects(submit(review, approved), { code: 'RESULT_STALE' });
  } finally { await f.cleanup(); }
});

test('acceptance runner bounds output, distinguishes timeout and startup failure', async () => {
  const signal = new AbortController().signal;
  const noisy = await validateCommand(policy("process.stdout.write('x'.repeat(100000))").commands[0]!, process.cwd(), signal);
  assert.equal(noisy.status, 'passed'); assert.equal(noisy.stdoutTail.length, 16_384);
  const timeout = await validateCommand({ ...policy('setInterval(()=>{},1000)').commands[0]!, timeoutMs: 100 }, process.cwd(), signal);
  assert.equal(timeout.status, 'timed_out');
  const missing = await validateCommand({ ...policy().commands[0]!, executable: join(process.cwd(), 'missing-teamwork-command.exe') }, process.cwd(), signal);
  assert.equal(missing.status, 'spawn_failed');
});

test('cancel during acceptance prevents verification', async () => {
  const fake = new FakeExecutor(), f = await setup(fake, 5_000, policy('setInterval(()=>{},1000)'));
  try {
    const { run, review } = await startReview(f, fake);
    await submit(review, approved); review.finish();
    await waitFor(() => f.store.get(run.id).phase === 'validating' ? true : undefined);
    await f.client.cancel(run.id, { commandId: 'cancel', expectedRevision: f.store.get(run.id).revision, type: 'cancel' });
    await waitFor(() => f.store.get(run.id).phase === 'cancelled' ? true : undefined);
    assert.equal(f.store.get(run.id).gate, 'not_evaluated');
  } finally { await f.cleanup(); }
});

test('operator-owned demo acceptance tests the supplied candidate cwd', async () => {
  const f = await setup();
  try {
    await copyFile(fileURLToPath(new URL('../../examples/verification-project/sum.mjs', import.meta.url)), join(f.source, 'sum.mjs'));
    const command = { id: 'demo', executable: process.execPath,
      args: [fileURLToPath(new URL('../../examples/sum-acceptance.mjs', import.meta.url))], timeoutMs: 5_000 };
    assert.equal((await validateCommand(command, f.source, new AbortController().signal)).status, 'failed');
    await writeFile(join(f.source, 'sum.mjs'), 'export function sum(values) { return values.reduce((a,b) => a+b, 0); }');
    assert.equal((await validateCommand(command, f.source, new AbortController().signal)).status, 'passed');
  } finally { await f.cleanup(); }
});
