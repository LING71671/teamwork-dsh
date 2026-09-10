import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { Client } from '../src/client.js';
import { workflowControlSchema, type WorkflowControlCommand, type Run } from '../src/contracts.js';
import { FakeExecutor, setup, waitFor, report } from './helpers.js';

const policy = { commands: [{ id: 'accept', executable: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 5000 }] };
const spec = { requirements: [], writeScope: { files: ['hello.txt'], trees: [] } };
function command(store: Store, id: string, type: 'pause' | 'resume' | 'cancel', commandId: string = type, mode: 'drain' | 'interrupt' = 'interrupt'): WorkflowControlCommand {
  return workflowControlSchema.parse({ type, commandId, expectedWorkflowRevision: store.workflow(id).revision, ...(type === 'pause' ? { mode } : {}) });
}
async function submit(a: FakeExecutor['instances'][number]) {
  await new Client(a.bridge.url, a.bridge.token).bridge(a.order.attemptId, 'submit', { commandId: 'submit', epoch: a.order.epoch, inputDigest: a.order.inputDigest,
    report: a.order.role === 'review' ? { ...report, review: { functionality: 'pass', completeness: 'pass', findings: [] } } : report });
  a.finish();
}
async function family(count = 2) {
  const fake = new FakeExecutor(), f = await setup(fake, 30_000, policy, true);
  try {
    const root = await f.client.start({ commandId: 'root', objective: 'Fix', spec, budget: { maxModelAttempts: 20 } });
    const worker = await waitFor(() => fake.instances[0]); await writeFile(join(worker.order.workspace, 'hello.txt'), 'proposal');
    await submit(worker); await submit(await waitFor(() => fake.instances[1]));
    await waitFor(() => f.store.get(root.id).phase === 'verified' ? true : undefined);
    await writeFile(join(f.source, 'hello.txt'), 'user');
    const jobs = [];
    for (let i = 0; i < count; i++) {
      const plan = await f.client.previewIntegration(root.id);
      jobs.push(await f.client.integrate(root.id, { type: 'integrate', commandId: `job-${i}`, expectedRevision: f.store.get(root.id).revision, planId: plan.id }));
    }
    const plan = await f.client.previewIntegration(root.id), children: Run[] = [];
    for (const [i, job] of jobs.entries()) children.push(await f.client.resolveIntegration(root.id, job.id, {
      type: 'resolve', commandId: `child-${i}`, expectedRevision: job.revision, planId: plan.id, instructions: 'Combine changes' }));
    await waitFor(() => children.every(child => f.store.get(child.id).phase === 'running') ? true : undefined);
    return { ...f, fake, root, children, jobs };
  } catch (error) { await f.cleanup(); throw error; }
}

test('workflow schema requires aggregate revision and rejects individual revisions or scope expansion', () => {
  const base = { type: 'pause', commandId: 'pause', expectedWorkflowRevision: 'a'.repeat(64) };
  const parsed = workflowControlSchema.parse(base); assert.ok(parsed.type === 'pause'); assert.equal(parsed.mode, 'drain');
  for (const input of [{ ...base, expectedRevision: 1 }, { ...base, expectedWorkflowRevision: 'bad' }, { ...base, type: 'revise' }]) {
    assert.equal(workflowControlSchema.safeParse(input).success, false);
  }
});

test('one root command interrupts all children, replays one receipt, and resumes fresh attempts without changing quota', async () => {
  const f = await family();
  try {
    const status = await f.client.workflow(f.root.id);
    assert.equal(status.state, 'running'); assert.equal(status.runs.length, 3);
    assert.deepEqual(new Set(status.leafRunIds), new Set(f.children.map(c => c.id)));
    assert.equal(status.budgets.length, 1); assert.equal(status.budgets[0]!.reservedModelAttempts, 4);
    const pause = command(f.store, f.root.id, 'pause'), receipt = await f.client.controlWorkflow(f.root.id, pause);
    assert.equal(receipt.state, 'pausing');
    await waitFor(() => f.store.workflow(f.root.id).state === 'paused' ? true : undefined);
    assert.ok(f.fake.instances.slice(2).every(a => a.closed));
    assert.deepEqual(await f.client.controlWorkflow(f.root.id, pause), receipt);
    await assert.rejects(f.client.controlWorkflow(f.root.id, { ...pause, commandId: 'stale' }), { code: 'WORKFLOW_REVISION_CONFLICT' });
    await assert.rejects(f.client.controlWorkflow(f.root.id, { ...pause, type: 'pause', mode: 'drain' }), { code: 'IDEMPOTENCY_CONFLICT' });
    for (const child of f.children) await assert.rejects(f.client.control(child.id, {
      type: 'resume', commandId: `bypass-${child.id}`, expectedRevision: f.store.get(child.id).revision }), { code: 'WORKFLOW_HELD' });
    await f.client.controlWorkflow(f.root.id, command(f.store, f.root.id, 'resume'));
    await waitFor(() => f.fake.instances.length === 6 && f.children.every(c => f.store.get(c.id).phase === 'running') ? true : undefined);
    assert.equal(f.store.get(f.root.id).budget!.reservedModelAttempts, 6);
    for (const child of f.children) assert.notEqual(f.store.get(child.id).order.attemptId, child.order.attemptId);
    assert.deepEqual(await f.client.controlWorkflow(f.root.id, pause), receipt);
  } finally { await f.cleanup(); }
});

test('root cancellation covers descendants but never an unrelated root; cancelled authorization cannot become a pause', async () => {
  const f = await family(1);
  try {
    const unrelated = await f.client.start({ commandId: 'unrelated', objective: 'Separate work' });
    await waitFor(() => f.store.get(unrelated.id).phase === 'running' ? true : undefined);
    const cancel = command(f.store, f.root.id, 'cancel'), receipt = await f.client.controlWorkflow(f.root.id, cancel);
    assert.equal(receipt.state, 'cancelling');
    await waitFor(() => f.store.workflow(f.root.id).state === 'cancelled' ? true : undefined);
    assert.equal(f.store.get(f.children[0]!.id).phase, 'cancelled'); assert.equal(f.store.get(unrelated.id).phase, 'running');
    assert.equal(f.fake.instances[3]!.closed, false);
    for (const type of ['pause', 'resume'] as const) await assert.rejects(f.client.controlWorkflow(f.root.id, command(f.store, f.root.id, type)), { code: 'WORKFLOW_CANCELLED' });
    assert.deepEqual(await f.client.controlWorkflow(f.root.id, cancel), receipt);
  } finally { await f.cleanup(); }
});

test('subtree holds are isolated; root resume preserves child hold and child resume cannot bypass an ancestor', async () => {
  const f = await family();
  try {
    const [child, sibling] = f.children;
    await f.client.controlWorkflow(child!.id, command(f.store, child!.id, 'pause', 'child-pause'));
    await waitFor(() => f.store.workflow(child!.id).state === 'paused' ? true : undefined);
    assert.equal(f.store.get(sibling!.id).phase, 'running'); assert.equal(f.store.workflow(f.root.id).state, 'running');
    await f.client.controlWorkflow(f.root.id, command(f.store, f.root.id, 'pause', 'root-pause'));
    await waitFor(() => f.store.workflow(f.root.id).state === 'paused' ? true : undefined);
    await assert.rejects(f.client.controlWorkflow(child!.id, command(f.store, child!.id, 'resume', 'bypass-root')), { code: 'WORKFLOW_HELD' });
    await f.client.controlWorkflow(f.root.id, command(f.store, f.root.id, 'resume', 'root-resume'));
    await waitFor(() => f.store.get(sibling!.id).phase === 'running' ? true : undefined);
    assert.equal(f.store.get(child!.id).phase, 'paused'); assert.equal(f.store.workflowHeld(child!.id), true);
    await f.client.controlWorkflow(child!.id, command(f.store, child!.id, 'resume', 'child-resume'));
    await waitFor(() => f.store.get(child!.id).phase === 'running' ? true : undefined);
  } finally { await f.cleanup(); }
});

test('child-only and shared-budget changes invalidate root workflow CAS before any hold is written', async () => {
  const f = await family(1);
  try {
    const beforeChild = command(f.store, f.root.id, 'pause', 'stale-child'), child = f.children[0]!;
    f.store.pause(child.id, { type: 'pause', commandId: 'drain-child', mode: 'drain', expectedRevision: f.store.get(child.id).revision });
    assert.throws(() => f.store.controlWorkflow(f.root.id, beforeChild), { code: 'WORKFLOW_REVISION_CONFLICT' });
    const beforeBudget = command(f.store, child.id, 'pause', 'stale-budget'), root = f.store.get(f.root.id);
    f.store.increaseBudget(root.id, { type: 'budget', commandId: 'budget', expectedRevision: root.revision,
      expectedBudgetRevision: root.budget!.revision, maxModelAttempts: 25, reason: 'Explicit allocation' });
    assert.throws(() => f.store.controlWorkflow(child.id, beforeBudget), { code: 'WORKFLOW_REVISION_CONFLICT' });
    assert.deepEqual(f.store.workflow(f.root.id).holds, []);
  } finally { await f.cleanup(); }
});

for (const failure of ['event', 'receipt'] as const) test(`workflow ${failure} failure atomically rolls back all members, holds and outbox`, async () => {
  const f = await family(), audit = new DatabaseSync(join(f.data, 'state.sqlite'));
  try {
    const before = f.store.workflow(f.root.id), input = command(f.store, f.root.id, 'pause', 'rollback');
    const outbox = audit.prepare('SELECT * FROM outbox ORDER BY run_id').all();
    audit.exec(failure === 'event'
      ? "CREATE TRIGGER workflow_failure BEFORE INSERT ON events WHEN NEW.type='workflow.pause_requested' BEGIN SELECT RAISE(ABORT, 'fixture'); END"
      : "CREATE TRIGGER workflow_failure BEFORE INSERT ON commands WHEN NEW.id='host:rollback' BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    assert.throws(() => f.store.controlWorkflow(f.root.id, input));
    assert.deepEqual(f.store.workflow(f.root.id), before); assert.deepEqual(audit.prepare('SELECT * FROM outbox ORDER BY run_id').all(), outbox);
    assert.equal(audit.prepare("SELECT COUNT(*) AS n FROM commands WHERE id='host:rollback'").get()!.n, 0);
    audit.exec('DROP TRIGGER workflow_failure');
    f.runtime.controlWorkflow(f.root.id, input);
    await waitFor(() => f.store.workflow(f.root.id).state === 'paused' ? true : undefined);
    assert.equal(audit.prepare("SELECT COUNT(*) AS n FROM commands WHERE id='host:rollback'").get()!.n, 1);
  } finally { audit.close(); await f.cleanup(); }
});

test('unknown child exit remains blocked after root cancellation and never claims stopped success', async () => {
  const f = await family(1);
  try {
    f.fake.failClose = true;
    await f.client.controlWorkflow(f.root.id, command(f.store, f.root.id, 'cancel'));
    await waitFor(() => f.store.workflow(f.root.id).state === 'blocked' ? true : undefined);
    assert.equal(f.fake.instances[2]!.closed, false); assert.equal(f.store.get(f.children[0]!.id).phase, 'blocked');
    assert.equal(f.store.workflowHeld(f.root.id), true);
  } finally { f.fake.failClose = false; f.fake.instances.forEach(a => a.finish()); await f.cleanup(); }
});

test('workflow hold and exact receipt survive SQLite reopen and prevent direct dispatch or individual resume', async () => {
  const f = await setup();
  let reopened: Store | undefined;
  try {
    await f.server.close();
    const root = f.store.start({ commandId: 'queued', objective: 'Fix' }, join(f.data, 'attempts'), {});
    const input = command(f.store, root.id, 'pause'), receipt = f.store.controlWorkflow(root.id, input);
    f.store.close(); reopened = new Store(join(f.data, 'state.sqlite')); reopened.recover();
    assert.deepEqual(reopened.workflow(root.id), receipt); assert.deepEqual(reopened.controlWorkflow(root.id, input), receipt);
    assert.deepEqual(reopened.pending(), []);
    assert.throws(() => reopened!.claim(root.id, 'credential'), { code: 'WORKFLOW_HELD' });
    assert.throws(() => reopened!.resume(root.id, { type: 'resume', commandId: 'bypass', expectedRevision: reopened!.get(root.id).revision }), { code: 'WORKFLOW_HELD' });
    reopened.controlWorkflow(root.id, command(reopened, root.id, 'resume'));
    assert.deepEqual(reopened.pending(), [root.id]);
  } finally {
    // setup cleanup owns the original connection; use a new equivalent cleanup after closing it above.
    if (reopened) { reopened.close(); const { rm } = await import('node:fs/promises'); await rm(f.root, { recursive: true, force: true }); }
    else await f.cleanup();
  }
});

test('worker credentials cannot read or control workflow; endpoint rejects query parameters', async () => {
  const fake = new FakeExecutor(), f = await setup(fake);
  try {
    const root = await f.client.start({ commandId: 'root', objective: 'Fix' }), worker = await waitFor(() => fake.instances[0]);
    const client = new Client(worker.bridge.url, worker.bridge.token);
    await assert.rejects(client.workflow(root.id), { code: 'UNAUTHORIZED' });
    await assert.rejects(client.controlWorkflow(root.id, command(f.store, root.id, 'cancel')), { code: 'UNAUTHORIZED' });
    const response = await fetch(`${f.server.url}/v1/runs/${root.id}/workflow?scope=all`, { headers: { Authorization: `Bearer ${f.token}` } });
    assert.equal(response.status, 400); assert.equal(f.store.workflowHeld(root.id), false);
  } finally { await f.cleanup(); }
});

test('root resume retains a cancelled subtree without preventing its paused sibling from continuing', async () => {
  const f = await family();
  try {
    const [child, sibling] = f.children;
    await f.client.controlWorkflow(child!.id, command(f.store, child!.id, 'cancel', 'child-cancel'));
    await waitFor(() => f.store.workflow(child!.id).state === 'cancelled' ? true : undefined);
    await f.client.controlWorkflow(f.root.id, command(f.store, f.root.id, 'pause'));
    await waitFor(() => f.store.workflow(f.root.id).state === 'paused' ? true : undefined);
    await f.client.controlWorkflow(f.root.id, command(f.store, f.root.id, 'resume'));
    await waitFor(() => f.store.get(sibling!.id).phase === 'running' ? true : undefined);
    assert.equal(f.store.get(child!.id).phase, 'cancelled'); assert.equal(f.store.workflowHeld(child!.id), true);
  } finally { await f.cleanup(); }
});

test('budget exhaustion rolls back whole-workflow resume and preserves its durable hold', async () => {
  const fake = new FakeExecutor(), f = await setup(fake, 30_000);
  try {
    const root = await f.client.start({ commandId: 'root', objective: 'Fix', budget: { maxModelAttempts: 1 } });
    await waitFor(() => f.store.get(root.id).phase === 'running' ? true : undefined);
    await f.client.controlWorkflow(root.id, command(f.store, root.id, 'pause'));
    await waitFor(() => f.store.workflow(root.id).state === 'paused' ? true : undefined);
    const before = f.store.workflow(root.id);
    await assert.rejects(f.client.controlWorkflow(root.id, command(f.store, root.id, 'resume')), { code: 'BUDGET_EXHAUSTED' });
    assert.deepEqual(f.store.workflow(root.id), before); assert.equal(fake.instances.length, 1);
  } finally { await f.cleanup(); }
});

test('drain pause waits for an active implementation report and exit before becoming paused', async () => {
  const fake = new FakeExecutor(), f = await setup(fake, 30_000);
  try {
    const root = await f.client.start({ commandId: 'root', objective: 'Fix' }), worker = await waitFor(() => fake.instances[0]);
    await waitFor(() => f.store.get(root.id).phase === 'running' ? true : undefined);
    const receipt = await f.client.controlWorkflow(root.id, command(f.store, root.id, 'pause', 'pause', 'drain'));
    assert.equal(receipt.state, 'pausing'); assert.equal(worker.closed, false);
    await assert.rejects(f.client.controlWorkflow(root.id, command(f.store, root.id, 'resume')), { code: 'WORKFLOW_NOT_STOPPED' });
    await submit(worker); await waitFor(() => f.store.workflow(root.id).state === 'paused' ? true : undefined);
    await f.client.controlWorkflow(root.id, command(f.store, root.id, 'resume'));
    assert.equal(f.store.workflow(root.id).state, 'submitted'); assert.equal(fake.instances.length, 1);
  } finally { await f.cleanup(); }
});

for (const action of ['drain', 'interrupt', 'cancel'] as const) test(`workflow ${action} during actual final command preserves accurate stop and write evidence`, async () => {
  // Only the final merged snapshot has the user's marker. Its command announces readiness,
  // then awaits a test-controlled release file outside the candidate and source trees.
  const fake = new FakeExecutor(), f = await setup(fake, 30_000, { commands: [{ id: 'accept', executable: process.execPath,
    args: ['-e', "const f=require('node:fs');if(f.existsSync('wait-final')){const p=f.readFileSync('wait-final','utf8');f.writeFileSync(p+'.ready','ready');const t=setInterval(()=>{if(f.existsSync(p))clearInterval(t)},20)}"], timeoutMs: 15_000 }] }, true);
  try {
    const root = await f.client.start({ commandId: 'root', objective: 'Fix', spec }), worker = await waitFor(() => fake.instances[0]);
    await writeFile(join(worker.order.workspace, 'hello.txt'), 'fixed'); await submit(worker); await submit(await waitFor(() => fake.instances[1]));
    await waitFor(() => f.store.get(root.id).phase === 'verified' ? true : undefined);
    const release = join(f.root, 'release-final'); await writeFile(join(f.source, 'wait-final'), release);
    const plan = await f.client.previewIntegration(root.id);
    const job = await f.client.integrate(root.id, { type: 'integrate', commandId: 'integrate', expectedRevision: f.store.get(root.id).revision, planId: plan.id });
    await waitFor(() => f.store.integrations.get(job.id).commandIntent ? true : undefined);
    const input = command(f.store, root.id, action === 'cancel' ? 'cancel' : 'pause', 'stop', action === 'drain' ? 'drain' : 'interrupt');
    const receipt = await f.client.controlWorkflow(root.id, input);
    assert.equal(receipt.state, action === 'cancel' ? 'cancelling' : 'pausing');
    if (action === 'drain') {
      assert.notEqual(f.store.integrations.get(job.id).cancelRequested, true);
      await assert.rejects(f.client.controlWorkflow(root.id, command(f.store, root.id, 'resume')), { code: 'WORKFLOW_NOT_STOPPED' });
      await writeFile(release, 'continue');
      await waitFor(() => f.store.workflow(root.id).state === 'paused' ? true : undefined);
      assert.equal(f.store.integrations.get(job.id).phase, 'succeeded');
      await f.client.controlWorkflow(root.id, command(f.store, root.id, 'resume'));
      assert.equal(f.store.workflow(root.id).state, 'integrated');
    } else {
      await waitFor(() => f.store.workflow(root.id).state === 'blocked' ? true : undefined);
      const stopped = f.store.integrations.get(job.id);
      assert.equal(stopped.cancelRequested, true); assert.ok(stopped.commandStop); assert.equal(stopped.commandIntent, undefined);
      assert.equal(stopped.phase, 'blocked'); assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'fixed');
      const backup = stopped.effects.find(effect => effect.kind === 'remove_file')!;
      assert.equal(await readFile(join(stopped.directory, `${backup.id}.backup`), 'utf8'), 'original');
      await assert.rejects(f.client.controlWorkflow(root.id, command(f.store, root.id, 'resume')), { code: action === 'cancel' ? 'WORKFLOW_CANCELLED' : 'WORKFLOW_NOT_STOPPED' });
      if (action === 'interrupt') {
        const current = await f.client.previewIntegration(root.id);
        await f.client.abandonIntegration(root.id, job.id, { type: 'abandon', commandId: 'keep-current', expectedRevision: stopped.revision,
          targetDigest: current.targetDigest, reason: 'Explicit user choice to keep partial files and backups' });
        await waitFor(() => f.store.integrations.get(job.id).phase === 'abandoned' ? true : undefined);
        assert.equal(f.store.workflowHeld(root.id), true); assert.equal(f.store.integrations.unresolved(), false);
        await f.client.controlWorkflow(root.id, command(f.store, root.id, 'resume', 'resume-after-reconciliation'));
        assert.equal(f.store.workflow(root.id).state, 'needs_attention');
      }
    }
    assert.deepEqual(await f.client.controlWorkflow(root.id, input), receipt);
  } finally { await f.cleanup(); }
});

for (const automatic of [false, true]) test(`workflow pause blocks ${automatic ? 'pending automatic' : 'prepared manual'} integration, resume continues without another approval`, async () => {
  const fake = new FakeExecutor(), f = await setup(fake, 30_000, policy, true);
  try {
    const root = await f.client.start({ commandId: 'root', objective: 'Fix', spec, ...(automatic ? { autonomy: { integration: 'on-gate-pass' as const } } : {}) });
    const worker = await waitFor(() => fake.instances[0]); await writeFile(join(worker.order.workspace, 'hello.txt'), 'fixed'); await submit(worker);
    const review = await waitFor(() => fake.instances[1]);
    const blocker = await f.client.start({ commandId: 'blocker', objective: 'Separate active work' }); await waitFor(() => fake.instances[2]);
    await submit(review); await waitFor(() => f.store.get(root.id).phase === 'verified' ? true : undefined);
    if (!automatic) {
      const plan = await f.client.previewIntegration(root.id);
      await f.client.integrate(root.id, { type: 'integrate', commandId: 'integrate', expectedRevision: f.store.get(root.id).revision, planId: plan.id });
    }
    await f.client.controlWorkflow(root.id, command(f.store, root.id, 'pause', 'pause', 'drain'));
    assert.equal(f.store.workflow(root.id).state, 'paused');
    const heldPlan = await f.client.previewIntegration(root.id);
    await assert.rejects(f.client.integrate(root.id, { type: 'integrate', commandId: 'bypass-hold',
      expectedRevision: f.store.get(root.id).revision, planId: heldPlan.id }), { code: 'WORKFLOW_HELD' });
    await f.client.cancel(blocker.id, { type: 'cancel', commandId: 'release', expectedRevision: f.store.get(blocker.id).revision });
    await waitFor(() => f.store.get(blocker.id).phase === 'cancelled' ? true : undefined);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'original');
    assert.equal(f.store.pendingAutomatic().length, 0);
    const jobs = f.store.integrations.forRun(root.id);
    assert.equal(jobs.length, automatic ? 0 : 1); if (!automatic) assert.equal(jobs[0]!.dispatch, 'pending');
    await f.client.controlWorkflow(root.id, command(f.store, root.id, 'resume'));
    await waitFor(() => f.store.workflow(root.id).state === 'integrated' ? true : undefined);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'fixed'); assert.equal(fake.instances.length, 3);
  } finally { await f.cleanup(); }
});

test('root hold rejects new resolution children; existing receipt replay remains read-only', async () => {
  const f = await family(1);
  try {
    const plan = await f.client.previewIntegration(f.root.id);
    const job = await f.client.integrate(f.root.id, { type: 'integrate', commandId: 'another-conflict',
      expectedRevision: f.store.get(f.root.id).revision, planId: plan.id });
    await f.client.controlWorkflow(f.root.id, command(f.store, f.root.id, 'pause'));
    await waitFor(() => f.store.workflow(f.root.id).state === 'paused' ? true : undefined);
    await assert.rejects(f.client.resolveIntegration(f.root.id, job.id, { type: 'resolve', commandId: 'bypass', expectedRevision: job.revision,
      planId: plan.id, instructions: 'Combine changes' }), { code: 'WORKFLOW_HELD' });
    assert.equal(f.store.all().length, 2);
    assert.deepEqual(await f.client.resolveIntegration(f.root.id, f.jobs[0]!.id, { type: 'resolve', commandId: 'child-0',
      expectedRevision: f.jobs[0]!.revision, planId: plan.id, instructions: 'Combine changes' }), f.children[0]);
  } finally { await f.cleanup(); }
});

test('workflow cancellation receipt failure rolls back prepared journal, source lease and root hold together', async () => {
  const fake = new FakeExecutor(), f = await setup(fake, 30_000, policy, true), audit = new DatabaseSync(join(f.data, 'state.sqlite'));
  try {
    const root = await f.client.start({ commandId: 'root', objective: 'Fix', spec }), worker = await waitFor(() => fake.instances[0]);
    await writeFile(join(worker.order.workspace, 'hello.txt'), 'fixed'); await submit(worker); const review = await waitFor(() => fake.instances[1]);
    await f.client.start({ commandId: 'blocker', objective: 'Keep active' }); await waitFor(() => fake.instances[2]);
    await submit(review); await waitFor(() => f.store.get(root.id).phase === 'verified' ? true : undefined);
    const stale = command(f.store, root.id, 'cancel', 'stale'), plan = await f.client.previewIntegration(root.id);
    const job = await f.client.integrate(root.id, { type: 'integrate', commandId: 'integrate', expectedRevision: f.store.get(root.id).revision, planId: plan.id });
    assert.throws(() => f.store.controlWorkflow(root.id, stale), { code: 'WORKFLOW_REVISION_CONFLICT' });
    const before = f.store.workflow(root.id), leases = audit.prepare('SELECT * FROM integration_leases').all(), input = command(f.store, root.id, 'cancel');
    audit.exec("CREATE TRIGGER workflow_failure BEFORE INSERT ON commands WHEN NEW.id='host:cancel' BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    assert.throws(() => f.store.controlWorkflow(root.id, input));
    assert.deepEqual(f.store.workflow(root.id), before); assert.deepEqual(audit.prepare('SELECT * FROM integration_leases').all(), leases);
    audit.exec('DROP TRIGGER workflow_failure');
    const receipt = await f.client.controlWorkflow(root.id, input);
    assert.equal(receipt.state, 'cancelled'); assert.equal(f.store.integrations.get(job.id).phase, 'cancelled');
    assert.equal(audit.prepare('SELECT COUNT(*) AS n FROM integration_leases').get()!.n, 0);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'original');
  } finally { audit.close(); await f.cleanup(); }
});
