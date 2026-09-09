import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Context } from '@deepseek-ai/cordis';
import ToolRuntime, { type ToolExecutionInput } from '@deepseek-ai/dsh-tools';
import * as host from '../src/plugin-dsh/host.js';
import { Client } from '../src/client.js';
import { Runtime } from '../src/runtime.js';
import { serve } from '../src/server.js';
import { FakeExecutor, setup, waitFor, report } from './helpers.js';
import type { ResolveIntegrationCommand, ArtifactFile, Run } from '../src/contracts.js';

const policy = { commands: [{ id: 'accept', executable: process.execPath,
  args: ['-e', "require('node:assert').ok(require('node:fs').readFileSync('hello.txt','utf8').includes('fixed'))"], timeoutMs: 5000 }] };
const clientOf = (attempt: FakeExecutor['instances'][number]) => new Client(attempt.bridge.url, attempt.bridge.token);
async function submit(attempt: FakeExecutor['instances'][number], review = false) {
  await clientOf(attempt).bridge(attempt.order.attemptId, 'submit', { commandId: 'submit', epoch: attempt.order.epoch, inputDigest: attempt.order.inputDigest,
    report: review ? { ...report, review: { functionality: 'pass', completeness: 'pass', findings: [] } } : report });
  attempt.finish();
}
async function fixture(verification = policy) {
  const fake = new FakeExecutor(), f = await setup(fake, 10_000, verification, true);
  try {
    const started = await f.client.start({ commandId: 'start', objective: 'Implement fixed behavior' });
    const implementation = await waitFor(() => fake.instances[0]);
    await assert.rejects(clientOf(implementation).context(implementation.order.attemptId, { kind: 'conflicts', offset: 0, limit: 10 }), { code: 'CONTEXT_MISSING' });
    await writeFile(join(implementation.order.workspace, 'hello.txt'), 'fixed'); await submit(implementation);
    await submit(await waitFor(() => fake.instances[1]), true);
    const parent = await waitFor(() => { const r = f.store.get(started.id); return r.phase === 'verified' ? r : undefined; });
    await writeFile(join(f.source, 'hello.txt'), 'user change');
    await writeFile(join(f.source, 'user-only'), 'keep this');
    const preview = await f.client.previewIntegration(parent.id);
    const conflict = await f.client.integrate(parent.id, { commandId: 'integrate-conflicting', type: 'integrate', expectedRevision: parent.revision, planId: preview.id });
    assert.equal(conflict.phase, 'conflict');
    const command = async (commandId = 'resolve'): Promise<ResolveIntegrationCommand> => ({ commandId, type: 'resolve',
      expectedRevision: (await f.client.integration(parent.id, conflict.id)).revision,
      planId: (await f.client.previewIntegration(parent.id)).id, instructions: 'Preserve user change while incorporating fixed behavior' });
    return { ...f, fake, parent, conflict, command };
  } catch (error) { await f.cleanup(); throw error; }
}
async function contextFile(attempt: FakeExecutor['instances'][number], version: 'base' | 'proposal' | 'current', path = 'hello.txt') {
  return await clientOf(attempt).context(attempt.order.attemptId, { kind: 'file', version, path, offset: 0, length: 65536 }) as ArtifactFile;
}
async function verified(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  return waitFor(() => { const r = f.store.get(id); return ['verified', 'failed', 'rejected', 'blocked'].includes(r.phase) ? r : undefined; });
}

test('conflict becomes a fresh resolution WorkItem with three scoped inputs, a current baseline and an independent Gate', async () => {
  const f = await fixture();
  try {
    const input = await f.command();
    const [child, repeated] = await Promise.all([f.client.resolveIntegration(f.parent.id, f.conflict.id, input), f.client.resolveIntegration(f.parent.id, f.conflict.id, input)]);
    assert.deepEqual(child, repeated);
    assert.notEqual(child.id, f.parent.id); assert.notEqual(child.order.workItemId, f.parent.order.workItemId);
    assert.equal(child.order.specRevision, f.parent.order.specRevision + 1);
    assert.equal(child.order.objective, f.parent.order.objective);
    assert.deepEqual(child.verification, f.parent.verification);
    assert.equal(child.gate, 'not_evaluated'); assert.equal(child.order.epoch, 1);
    assert.equal((await f.client.integration(f.parent.id, f.conflict.id)).resolutionRunId, child.id);
    assert.ok(f.store.events(child.id, 0).some(e => e.type === 'run.resolution_created'));
    const resolver = await waitFor(() => f.fake.instances[2]);
    assert.equal(await readFile(join(resolver.order.workspace, 'hello.txt'), 'utf8'), 'user change');
    assert.equal(await readFile(join(resolver.order.workspace, 'user-only'), 'utf8'), 'keep this');
    assert.equal((await contextFile(resolver, 'base')).content, 'original');
    assert.equal((await contextFile(resolver, 'proposal')).content, 'fixed');
    assert.equal((await contextFile(resolver, 'current')).content, 'user change');
    const conflicts = await clientOf(resolver).context(resolver.order.attemptId, { kind: 'conflicts', offset: 0, limit: 1 });
    assert.ok('conflicts' in conflicts); assert.equal(conflicts.total, 1); assert.equal(conflicts.conflicts[0]!.path, 'hello.txt');
    assert.deepEqual(resolver.order.resolution!.requirements, [input.instructions]);
    assert.equal(f.store.get(child.id).baseline!.digest, resolver.order.inputTreeDigest);
    await writeFile(join(resolver.order.workspace, 'hello.txt'), 'fixed + user change'); await submit(resolver);
    await assert.rejects(contextFile(resolver, 'base'), { code: 'RESULT_STALE' });
    const review = await waitFor(() => f.fake.instances[3]);
    assert.equal(review.order.role, 'review');
    assert.equal((await contextFile(review, 'current')).content, 'user change');
    assert.equal((await contextFile(review, 'proposal')).content, 'fixed');
    assert.notEqual(review.order.attemptId, resolver.order.attemptId);
    await submit(review, true);
    const ready = await verified(f, child.id);
    assert.equal(ready.phase, 'verified');
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'user change');
    assert.equal((await f.client.artifactFile(child.id, ready.baseline!.artifactId!, 'hello.txt')).content, 'user change');
    assert.equal((await f.client.artifactFile(f.parent.id, f.parent.baseline!.artifactId!, 'hello.txt')).content, 'original');
    const preview = await f.client.previewIntegration(child.id); assert.equal(preview.status, 'clear');
    const integration = await f.client.integrate(child.id, { commandId: 'integrate-resolved', type: 'integrate', expectedRevision: ready.revision, planId: preview.id });
    await waitFor(() => f.store.integrations.get(integration.id).phase === 'succeeded' ? true : undefined);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'fixed + user change');
    assert.equal(await readFile(join(f.source, 'user-only'), 'utf8'), 'keep this');
    assert.equal(f.store.integrations.get(f.conflict.id).phase, 'conflict'); // Old conflict is not rewritten as success.
    assert.deepEqual(await f.client.resolveIntegration(f.parent.id, f.conflict.id, input), child);
    await assert.rejects(f.client.resolveIntegration(f.parent.id, f.conflict.id, { ...input, instructions: 'different' }), { code: 'IDEMPOTENCY_CONFLICT' });
  } finally { await f.cleanup(); }
});

test('resolution context rejects arbitrary paths, host/other attempt credentials, stale identities and unregistered versions', async () => {
  const f = await fixture();
  try {
    const child = await f.client.resolveIntegration(f.parent.id, f.conflict.id, await f.command());
    const resolver = await waitFor(() => f.fake.instances[2]);
    const client = clientOf(resolver);
    await assert.rejects(f.client.context(resolver.order.attemptId, { kind: 'conflicts', offset: 0, limit: 10 }), { code: 'UNAUTHORIZED' });
    await assert.rejects(clientOf(f.fake.instances[0]!).context(resolver.order.attemptId, { kind: 'conflicts', offset: 0, limit: 10 }), { code: 'UNAUTHORIZED' });
    await assert.rejects(client.artifact(child.id, child.baseline!.artifactId!), { code: 'UNAUTHORIZED' });
    for (const path of ['../outside', 'hello.txt:stream', 'C:/private', 'dir\\file', 'NUL']) await assert.rejects(contextFile(resolver, 'base', path), { code: 'ARTIFACT_PATH' });
    const headers = { authorization: `Bearer ${resolver.bridge.token}` };
    const route = `${f.server.url}/v1/attempts/${resolver.order.attemptId}/context`;
    for (const query of ['kind=manifest&version=unknown', 'kind=file&version=base&path=hello.txt&artifactId=other', 'kind=conflicts&offset=0&offset=1']) {
      assert.equal((await fetch(`${route}?${query}`, { headers })).status, 400);
    }
    assert.equal((await fetch(route, { method: 'POST', headers })).status, 401);
    await assert.rejects(client.bridge(resolver.order.attemptId, 'submit', { commandId: 'stale-parent', epoch: 1,
      inputDigest: f.parent.order.inputDigest, report }), { code: 'RESULT_STALE' });
    await f.client.cancel(child.id, { commandId: 'cancel', type: 'cancel', expectedRevision: f.store.get(child.id).revision });
    await waitFor(() => f.store.get(child.id).phase === 'cancelled' ? true : undefined);
    await assert.rejects(contextFile(resolver, 'current'), { code: 'RESULT_STALE' });
  } finally { await f.cleanup(); }
});

test('resolution rejects stale scope/plans and will not duplicate an active or verified child', async () => {
  const f = await fixture();
  try {
    const input = await f.command();
    await assert.rejects(f.client.resolveIntegration(f.parent.id, f.conflict.id, { ...input, expectedRevision: 99 }), { code: 'REVISION_CONFLICT' });
    await assert.rejects(f.client.resolveIntegration(f.parent.id, f.conflict.id, { ...input, planId: 'f'.repeat(64) }), { code: 'INTEGRATION_PLAN_STALE' });
    await assert.rejects(f.client.resolveIntegration('different-run', f.conflict.id, input), { code: 'NOT_FOUND' });
    const child = await f.client.resolveIntegration(f.parent.id, f.conflict.id, input);
    await assert.rejects(f.client.resolveIntegration(f.parent.id, f.conflict.id, await f.command('second')), { code: 'RESOLUTION_EXISTS' });
    assert.equal(f.store.all().length, 2);
    assert.equal(f.store.get(child.id).order.resolution!.inputs.current.digest, child.baseline!.digest);
  } finally { await f.cleanup(); }
});

test('pause/resume retains immutable context, rejects old readers and allows explicit replacement of a cancelled child', async () => {
  const f = await fixture();
  try {
    const child = await f.client.resolveIntegration(f.parent.id, f.conflict.id, await f.command());
    const first = await waitFor(() => f.fake.instances[2]);
    await f.client.control(child.id, { commandId: 'pause', type: 'pause', mode: 'interrupt', expectedRevision: f.store.get(child.id).revision });
    await waitFor(() => f.store.get(child.id).phase === 'paused' ? true : undefined);
    await f.client.control(child.id, { commandId: 'resume', type: 'resume', expectedRevision: f.store.get(child.id).revision });
    const next = await waitFor(() => f.fake.instances[3]);
    assert.equal(next.order.epoch, 2);
    assert.equal((await contextFile(next, 'proposal')).content, 'fixed');
    assert.deepEqual(next.order.resolution, first.order.resolution);
    await assert.rejects(contextFile(first, 'proposal'), { code: 'RESULT_STALE' });
    await f.client.cancel(child.id, { commandId: 'cancel', type: 'cancel', expectedRevision: f.store.get(child.id).revision });
    await waitFor(() => f.store.get(child.id).phase === 'cancelled' ? true : undefined);
    await writeFile(join(f.source, 'hello.txt'), 'new user change');
    const replacement = await f.client.resolveIntegration(f.parent.id, f.conflict.id, await f.command('resolve-again'));
    const fresh = await waitFor(() => f.fake.instances[4]);
    assert.notEqual(replacement.id, child.id);
    assert.equal((await contextFile(fresh, 'current')).content, 'new user change');
    assert.deepEqual(f.store.integrations.get(f.conflict.id).resolutionRuns, [child.id, replacement.id]);
  } finally { await f.cleanup(); }
});

for (const version of ['base', 'proposal', 'current'] as const) test(`tampered ${version} context prevents resolution dispatch`, async () => {
  const f = await fixture();
  try {
    const blockers: Run[] = [];
    for (let i = 0; i < 2; i++) {
      blockers.push(await f.client.start({ commandId: `block-${i}`, objective: 'Hold slot' }));
      await waitFor(() => f.fake.instances[2 + i]);
    }
    const child = await f.client.resolveIntegration(f.parent.id, f.conflict.id, await f.command());
    assert.equal(f.store.get(child.id).phase, 'queued');
    await writeFile(join(child.order.resolution!.inputs[version].workspace, 'hello.txt'), 'tampered');
    for (let i = 0; i < 2; i++) await f.client.cancel(blockers[i]!.id, { commandId: `cancel-block-${i}`, type: 'cancel', expectedRevision: f.store.get(blockers[i]!.id).revision });
    const failed = await verified(f, child.id);
    assert.equal(failed.phase, 'failed');
    assert.equal(failed.reason, version === 'current' ? 'CANDIDATE_CHANGED' : 'RESOLUTION_CONTEXT_CHANGED');
    assert.equal(f.fake.instances.length, 4);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'user change');
  } finally { await f.cleanup(); }
});

test('queued resolution recovers with its captured current baseline, not a new source snapshot', async () => {
  const f = await fixture();
  let replacement: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    for (let i = 0; i < 2; i++) { await f.client.start({ commandId: `block-${i}`, objective: 'Hold slot' }); await waitFor(() => f.fake.instances[2 + i]); }
    const child = await f.client.resolveIntegration(f.parent.id, f.conflict.id, await f.command());
    await f.server.close();
    await writeFile(join(f.source, 'hello.txt'), 'later user edit');
    const fake = new FakeExecutor();
    const runtime = new Runtime(f.store, fake, { source: f.source, attemptsDirectory: join(f.data, 'attempts'), maxConcurrency: 2,
      attemptTimeoutMs: 10_000, executionProfile: { driver: 'test' }, verification: policy, integration: { enabled: true } });
    replacement = await serve(runtime, f.token);
    const resumed = await waitFor(() => fake.instances[0]);
    assert.equal(resumed.order.runId, child.id);
    assert.equal(await readFile(join(resumed.order.workspace, 'hello.txt'), 'utf8'), 'user change');
    assert.equal((await contextFile(resumed, 'current')).content, 'user change');
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'later user edit');
  } finally { await replacement?.close(); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('context mutation after review starts cannot pass the new Gate', async () => {
  const f = await fixture();
  try {
    const child = await f.client.resolveIntegration(f.parent.id, f.conflict.id, await f.command());
    const resolver = await waitFor(() => f.fake.instances[2]);
    await writeFile(join(resolver.order.workspace, 'hello.txt'), 'fixed + user change'); await submit(resolver);
    const review = await waitFor(() => f.fake.instances[3]);
    await writeFile(join(child.order.resolution!.inputs.proposal.workspace, 'hello.txt'), 'changed evidence');
    await assert.rejects(contextFile(review, 'proposal'), { code: 'ARTIFACT_CHANGED' });
    await submit(review, true);
    const failed = await verified(f, child.id);
    assert.equal(failed.phase, 'failed'); assert.equal(failed.reason, 'RESOLUTION_CONTEXT_CHANGED');
    assert.notEqual(failed.gate, 'passed');
  } finally { await f.cleanup(); }
});

test('a further conflict keeps bounded inherited requirements and uses the latest three-way inputs', async () => {
  const f = await fixture();
  try {
    const first = { ...await f.command(), instructions: 'a'.repeat(16_000) };
    const child = await f.client.resolveIntegration(f.parent.id, f.conflict.id, first);
    const resolver = await waitFor(() => f.fake.instances[2]);
    await writeFile(join(resolver.order.workspace, 'hello.txt'), 'fixed + user change'); await submit(resolver);
    await submit(await waitFor(() => f.fake.instances[3]), true);
    const ready = await verified(f, child.id); assert.equal(ready.phase, 'verified');
    await writeFile(join(f.source, 'hello.txt'), 'later user edit');
    const preview = await f.client.previewIntegration(child.id);
    const conflict = await f.client.integrate(child.id, { commandId: 'later-conflict', type: 'integrate', expectedRevision: ready.revision, planId: preview.id });
    assert.equal(conflict.phase, 'conflict');
    await assert.rejects(f.client.resolveIntegration(child.id, conflict.id, { commandId: 'resolve-over-budget', type: 'resolve', expectedRevision: conflict.revision,
      planId: preview.id, instructions: 'b'.repeat(16_000) }), { code: 'RESOLUTION_BUDGET' });
    assert.equal(f.store.all().length, 2);
    const instructions = 'Also preserve the later user edit'.padEnd(15_999, '.');
    const grandchild = await f.client.resolveIntegration(child.id, conflict.id, { commandId: 'resolve-later', type: 'resolve', expectedRevision: conflict.revision,
      planId: preview.id, instructions });
    const next = await waitFor(() => f.fake.instances[4]);
    assert.deepEqual(next.order.resolution!.requirements, [first.instructions, instructions]);
    assert.equal(grandchild.order.specRevision, child.order.specRevision + 1);
    assert.equal((await contextFile(next, 'base')).content, 'user change');
    assert.equal((await contextFile(next, 'proposal')).content, 'fixed + user change');
    assert.equal((await contextFile(next, 'current')).content, 'later user edit');
  } finally { await f.cleanup(); }
});

test('resolution receipt failure rolls back child, artifacts, outbox, events and parent link together', async () => {
  const f = await fixture();
  const audit = new DatabaseSync(join(f.data, 'state.sqlite'));
  try {
    const input = await f.command();
    const counts = () => ['runs', 'artifacts', 'outbox', 'events', 'integration_events', 'commands'].map(table =>
      audit.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count);
    const before = counts(), parent = f.store.get(f.parent.id), job = f.store.integrations.get(f.conflict.id);
    audit.exec("CREATE TRIGGER reject_resolution_receipt BEFORE INSERT ON commands WHEN NEW.id='host:resolve' BEGIN SELECT RAISE(ABORT, 'test receipt failure'); END");
    await assert.rejects(f.client.resolveIntegration(f.parent.id, f.conflict.id, input));
    assert.deepEqual(counts(), before);
    assert.deepEqual(f.store.get(f.parent.id), parent);
    assert.deepEqual(f.store.integrations.get(f.conflict.id), job);
    assert.equal(f.fake.instances.length, 2);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'user change');
    audit.exec('DROP TRIGGER reject_resolution_receipt');
    const child = await f.client.resolveIntegration(f.parent.id, f.conflict.id, input);
    assert.equal((await waitFor(() => f.fake.instances[2])).order.runId, child.id);
    assert.equal(f.store.integrations.get(f.conflict.id).resolutionRunId, child.id);
    assert.deepEqual(await f.client.resolveIntegration(f.parent.id, f.conflict.id, input), child);
  } finally { audit.close(); await f.cleanup(); }
});

test('real Cordis host resolve tool requires explicit instructions and returns the new run identity', async () => {
  const f = await fixture(), ctx = new Context();
  const keys = ['TEAMWORK_URL', 'TEAMWORK_HOST_TOKEN', 'TEAMWORK_CONNECTION_FILE', 'TEAMWORK_ATTEMPT_TOKEN'] as const;
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.TEAMWORK_URL = f.server.url; process.env.TEAMWORK_HOST_TOKEN = f.token;
    ctx.provide('systemPrompt', { tools: () => () => {} } as unknown as Context['systemPrompt']);
    await ctx.plugin(ToolRuntime); await waitFor(() => ctx.get('tools'));
    ctx.plugin(host); await waitFor(() => ctx.tools.get('teamwork_integrate'));
    const input = { runId: f.parent.id, integrationId: f.conflict.id, ...await f.command() };
    const execute = (args: unknown) => ctx.tools.execute({ callId: 'resolve-host' as ToolExecutionInput['callId'], name: 'teamwork_integrate',
      arguments: args, signal: new AbortController().signal });
    const { instructions: _instructions, ...missingInstructions } = input;
    assert.equal((await execute(missingInstructions)).isError, true);
    assert.equal(f.store.all().length, 1);
    const result = await execute(input);
    assert.equal(result.isError, false, JSON.stringify(result));
    const childId = f.store.integrations.get(f.conflict.id).resolutionRunId!;
    assert.ok(childId); assert.ok(JSON.stringify(result).includes(childId));
    assert.equal(f.store.all().length, 2);
    assert.deepEqual(await execute(input), result);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'user change');
  } finally {
    await ctx.fiber.dispose();
    for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; }
    await f.cleanup();
  }
});

test('a safely abandoned final-acceptance failure can become a new semantic resolution and must pass acceptance again', async () => {
  const verification = { commands: [{ ...policy.commands[0]!, args: ['-e', policy.commands[0]!.args[1]! +
    ";const fs=require('node:fs');if(fs.existsSync('user-only'))require('node:assert').equal(fs.readFileSync('user-only','utf8'),'resolved-user-value')"] }] };
  const f = await fixture(verification);
  try {
    await writeFile(join(f.source, 'hello.txt'), 'original');
    const plan = await f.client.previewIntegration(f.parent.id);
    const job = await f.client.integrate(f.parent.id, { commandId: 'integrate-semantic', type: 'integrate', expectedRevision: f.store.get(f.parent.id).revision, planId: plan.id });
    const failed = await waitFor(() => { const j = f.store.integrations.get(job.id); return j.phase === 'failed' ? j : undefined; });
    const current = await f.client.previewIntegration(f.parent.id);
    await assert.rejects(f.client.resolveIntegration(f.parent.id, job.id, { commandId: 'too-early', type: 'resolve', expectedRevision: failed.revision,
      planId: current.id, instructions: 'Resolve final failure' }), { code: 'RESOLUTION_NOT_READY' });
    await f.client.abandonIntegration(f.parent.id, job.id, { commandId: 'keep-before-resolution', type: 'abandon', expectedRevision: failed.revision,
      targetDigest: current.targetDigest, reason: 'Keep current files and resolve the failed acceptance separately' });
    const abandoned = await waitFor(() => { const j = f.store.integrations.get(job.id); return j.phase === 'abandoned' ? j : undefined; });
    const child = await f.client.resolveIntegration(f.parent.id, job.id, { commandId: 'resolve-semantic', type: 'resolve', expectedRevision: abandoned.revision,
      planId: current.id, instructions: 'Change user-only to resolved-user-value while retaining fixed behavior' });
    const resolver = await waitFor(() => f.fake.instances[2]);
    assert.match(resolver.order.resolution!.feedback, /INTEGRATION_ACCEPTANCE_FAILED/);
    assert.equal(resolver.order.resolution!.conflicts.length, 0);
    assert.equal((await contextFile(resolver, 'current', 'user-only')).content, 'keep this');
    await writeFile(join(resolver.order.workspace, 'user-only'), 'resolved-user-value'); await submit(resolver);
    await submit(await waitFor(() => f.fake.instances[3]), true);
    const ready = await verified(f, child.id); assert.equal(ready.phase, 'verified');
    assert.equal(await readFile(join(f.source, 'user-only'), 'utf8'), 'keep this');
    const next = await f.client.previewIntegration(child.id);
    const integrated = await f.client.integrate(child.id, { commandId: 'integrate-semantic-resolution', type: 'integrate', expectedRevision: ready.revision, planId: next.id });
    await waitFor(() => f.store.integrations.get(integrated.id).phase === 'succeeded' ? true : undefined);
    assert.equal(await readFile(join(f.source, 'user-only'), 'utf8'), 'resolved-user-value');
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'fixed');
  } finally { await f.cleanup(); }
});
