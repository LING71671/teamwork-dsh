import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, lstat, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import ToolRuntime, { type ToolExecutionInput } from '@deepseek-ai/dsh-tools';
import * as host from '../src/plugin-dsh/host.js';
import { Client } from '../src/client.js';
import { Runtime } from '../src/runtime.js';
import { serve } from '../src/server.js';
import { IntegrationEngine } from '../src/integration-engine.js';
import { integrationRequest } from '../src/integration-journal.js';
import { FakeExecutor, setup, waitFor, report } from './helpers.js';
import type { IntegrateCommand } from '../src/contracts.js';

const code = "require('node:assert').equal(require('node:fs').readFileSync('hello.txt','utf8'),'candidate')";
const policy = (script = code) => ({ commands: [{ id: 'accept', executable: process.execPath, args: ['-e', script], timeoutMs: 10_000 }] });
async function fixture(enabled = true, script = code) {
  const fake = new FakeExecutor(), f = await setup(fake, 10_000, policy(script), enabled);
  try {
    const started = await f.client.start({ commandId: 'start', objective: 'Fix' });
    const implementation = await waitFor(() => fake.instances[0]);
    await writeFile(join(implementation.order.workspace, 'hello.txt'), 'candidate');
    const submit = async (attempt: typeof implementation, review = false) => new Client(attempt.bridge.url, attempt.bridge.token).bridge(attempt.order.attemptId, 'submit', {
      commandId: 'submit', epoch: attempt.order.epoch, inputDigest: attempt.order.inputDigest,
      report: review ? { ...report, review: { functionality: 'pass', completeness: 'pass', findings: [] } } : report,
    });
    await submit(implementation); implementation.finish();
    const review = await waitFor(() => fake.instances[1]); await submit(review, true); review.finish();
    const run = await waitFor(() => { const r = f.store.get(started.id); return r.phase === 'verified' ? r : undefined; });
    const command = async (commandId = 'integrate'): Promise<IntegrateCommand> => ({ commandId, type: 'integrate',
      expectedRevision: (await f.client.status(run.id)).revision, planId: (await f.client.previewIntegration(run.id)).id });
    return { ...f, fake, run, command };
  } catch (error) { await f.cleanup(); throw error; }
}
async function finished(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  return waitFor(() => { const r = f.store.integrations.get(id); return ['succeeded', 'blocked', 'failed', 'cancelled', 'conflict', 'abandoned'].includes(r.phase) ? r : undefined; }, 10_000);
}

test('integration opt-in is required; Gate alone never changes the project', async () => {
  const f = await fixture(false);
  try {
    const hello = await fetch(`${f.server.url}/v1/hello`, { headers: { authorization: `Bearer ${f.token}` } }).then(r => r.json()) as { integrationEnabled: boolean; features: string[] };
    assert.equal(hello.integrationEnabled, false); assert.equal(hello.features.includes('integrate'), false);
    await assert.rejects(f.client.integrate(f.run.id, await f.command()), { code: 'CAPABILITY_MISSING' });
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'original');
    assert.equal(f.store.integrations.forRun(f.run.id).length, 0);
    assert.throws(() => new Runtime(f.store, f.fake, { source: f.source, attemptsDirectory: f.data, maxConcurrency: 1,
      attemptTimeoutMs: 1_000, executionProfile: {}, integration: { enabled: true } }), { code: 'CONFIG_INVALID' });
  } finally { await f.cleanup(); }
});

test('HTTP integrates explicitly, deduplicates parallel/replayed commands, projects status/events and registers the final artifact', async () => {
  const f = await fixture();
  try {
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'original');
    await writeFile(join(f.source, 'user-only'), 'keep this');
    const input = await f.command();
    const [first, duplicate] = await Promise.all([f.client.integrate(f.run.id, input), f.client.integrate(f.run.id, input)]);
    assert.deepEqual(first, duplicate);
    const done = await finished(f, first.id);
    assert.equal(done.phase, 'succeeded', JSON.stringify(done));
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'candidate');
    assert.equal(await readFile(join(f.source, 'user-only'), 'utf8'), 'keep this');
    assert.equal(f.store.integrations.forRun(f.run.id).length, 1);
    const status = await f.client.status(f.run.id);
    assert.equal(status.phase, 'verified'); assert.equal(status.integration!.phase, 'succeeded');
    assert.equal(status.integration!.id, first.id);
    assert.ok(status.revision > f.run.revision);
    assert.ok(f.store.events(f.run.id, 0).some(e => e.type === 'integration.succeeded'));
    assert.deepEqual(await f.client.integrate(f.run.id, input), first); // Receipt, not current state.
    await assert.rejects(f.client.integrate(f.run.id, { ...input, expectedRevision: input.expectedRevision + 1 }), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(f.client.start({ commandId: input.commandId, objective: 'different' }), { code: 'IDEMPOTENCY_CONFLICT' });
    const list = await f.client.integrations(f.run.id, 0, 1);
    assert.equal(list.integrations.length, 1); assert.equal(list.nextOffset, null);
    assert.equal(list.integrations[0]!.phase, 'succeeded');
    const current = await f.client.integration(f.run.id, first.id);
    assert.equal(current.integrated!.artifactId, done.integrated!.artifactId);
    const artifactId = current.integrated!.artifactId!;
    const artifacts = await f.client.artifacts(f.run.id);
    assert.equal(artifacts.artifacts.find(a => a.id === artifactId)!.kind, 'integrated');
    assert.equal((await f.client.artifactFile(f.run.id, artifactId, 'user-only')).content, 'keep this');
    assert.equal((await f.client.artifactFile(f.run.id, artifactId, 'hello.txt')).content, 'candidate');
  } finally { await f.cleanup(); }
});

test('integration credentials, scopes, strict schemas and stale run revisions are enforced', async () => {
  const f = await fixture();
  try {
    const input = await f.command();
    const worker = new Client(f.fake.instances[0]!.bridge.url, f.fake.instances[0]!.bridge.token);
    await assert.rejects(worker.integrate(f.run.id, input), { code: 'UNAUTHORIZED' });
    await assert.rejects(f.client.integrate(f.run.id, { ...input, expectedRevision: 0 }), { code: 'REVISION_CONFLICT' });
    await assert.rejects(f.client.integrate(f.run.id, { ...input, planId: 'f'.repeat(64) }), { code: 'INTEGRATION_PLAN_STALE' });
    const first = await f.client.integrate(f.run.id, input); await finished(f, first.id);
    await assert.rejects(worker.integration(f.run.id, first.id), { code: 'UNAUTHORIZED' });
    const other = f.store.start({ commandId: 'other', objective: 'Other' }, f.data, {});
    await assert.rejects(f.client.integration(other.id, first.id), { code: 'NOT_FOUND' });
    await assert.rejects(f.client.cancelIntegration(other.id, first.id, { commandId: 'cancel-other', type: 'cancel', expectedRevision: 0 }), { code: 'NOT_FOUND' });
    const headers = { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' };
    assert.equal((await fetch(`${f.server.url}/v1/runs/${f.run.id}/integrations`, { method: 'POST', headers,
      body: JSON.stringify({ ...input, commandId: 'bad-path', source: 'C:/arbitrary' }) })).status, 400);
    assert.equal((await fetch(`${f.server.url}/v1/runs/${f.run.id}/integrations/${first.id}/commands`, { method: 'POST', headers,
      body: JSON.stringify({ commandId: 'bad-command', expectedRevision: 0, type: 'resume' }) })).status, 400);
  } finally { await f.cleanup(); }
});

test('queued integration drains an active attempt; cancellation is durable and leaves source untouched', async () => {
  const f = await fixture();
  try {
    const other = await f.client.start({ commandId: 'busy-worker', objective: 'Keep active' });
    await waitFor(() => f.fake.instances[2]);
    const queued = await f.client.integrate(f.run.id, await f.command());
    assert.equal(f.store.integrations.get(queued.id).phase, 'prepared');
    assert.equal(f.store.integrations.get(queued.id).dispatch, 'pending');
    const later = await f.client.start({ commandId: 'later', objective: 'Queued after integration' });
    assert.equal(f.store.get(later.id).phase, 'queued');
    await assert.rejects(f.client.control(f.run.id, { commandId: 'wrong-cancel', type: 'cancel', expectedRevision: f.store.get(f.run.id).revision }), { code: 'INTEGRATION_CONTROL_REQUIRED' });
    const cancel = { commandId: 'cancel-integration', type: 'cancel' as const, expectedRevision: queued.revision };
    const cancelled = await f.client.cancelIntegration(f.run.id, queued.id, cancel);
    assert.equal(cancelled.phase, 'cancelled');
    assert.deepEqual(await f.client.cancelIntegration(f.run.id, queued.id, cancel), cancelled);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'original');
    await assert.rejects(lstat(cancelled.recoveryDirectory), { code: 'ENOENT' });
    await f.client.cancel(other.id, { commandId: 'cancel-worker', type: 'cancel', expectedRevision: f.store.get(other.id).revision });
    await waitFor(() => f.store.get(later.id).phase === 'running' ? true : undefined);
  } finally { await f.cleanup(); }
});

test('active final acceptance can be cancelled; partial writes and backups remain explicit', async () => {
  const f = await fixture(true, code + ";if(require('node:fs').existsSync('user-only'))setInterval(()=>{},1000)");
  try {
    await writeFile(join(f.source, 'user-only'), 'trigger final wait');
    const first = await f.client.integrate(f.run.id, await f.command());
    await waitFor(() => f.store.integrations.get(first.id).commandIntent ? true : undefined);
    const current = await f.client.integration(f.run.id, first.id);
    const stopped = await f.client.cancelIntegration(f.run.id, first.id, { commandId: 'stop', type: 'cancel', expectedRevision: current.revision });
    assert.equal(stopped.cancelRequested, true);
    const done = await finished(f, first.id);
    assert.equal(done.phase, 'blocked'); assert.equal(done.reason, 'ABORTED');
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'candidate');
    assert.equal(done.validation.length, 0);
    assert.equal(done.commandIntent, undefined);
    assert.ok(done.commandStop);
    const backup = done.effects.find(e => e.kind === 'remove_file')!;
    assert.equal(await readFile(join(done.directory, `${backup.id}.backup`), 'utf8'), 'original');
    await assert.rejects(f.client.start({ commandId: 'after-block', objective: 'Not safe yet' }), { code: 'INTEGRATION_RECONCILIATION_REQUIRED' });
  } finally { await f.cleanup(); }
});

test('explicit keep-current resolution preserves files/backups, releases ownership and never claims success', async () => {
  const f = await fixture(true, code + ";if(require('node:fs').existsSync('user-only'))process.exit(7)");
  try {
    await writeFile(join(f.source, 'user-only'), 'keep');
    const queued = await f.client.integrate(f.run.id, await f.command());
    const failed = await finished(f, queued.id);
    assert.equal(failed.phase, 'failed');
    const before = await f.client.previewIntegration(f.run.id);
    const input = { commandId: 'keep-current', type: 'abandon' as const, expectedRevision: failed.revision,
      targetDigest: before.targetDigest, reason: 'User chose to preserve current project and inspect separately' };
    await assert.rejects(f.client.abandonIntegration(f.run.id, queued.id, { ...input, targetDigest: 'f'.repeat(64) }), { code: 'INTEGRATION_PLAN_STALE' });
    const receipt = await f.client.abandonIntegration(f.run.id, queued.id, input);
    assert.equal(receipt.phase, 'abandoning');
    const done = await waitFor(() => { const r = f.store.integrations.get(queued.id); return r.phase === 'abandoned' ? r : undefined; });
    assert.equal(done.resolution!.kind, 'keep-current');
    assert.equal(done.validation[0]!.exitCode, 7);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'candidate');
    assert.equal(await readFile(join(f.source, 'user-only'), 'utf8'), 'keep');
    const backup = done.effects.find(e => e.kind === 'remove_file')!;
    assert.equal(await readFile(join(done.directory, `${backup.id}.backup`), 'utf8'), 'original');
    await assert.rejects(lstat(done.reservation), { code: 'ENOENT' });
    assert.equal(f.store.integrations.unresolved(), false);
    assert.deepEqual(await f.client.abandonIntegration(f.run.id, queued.id, input), receipt);
    await assert.rejects(f.client.abandonIntegration(f.run.id, queued.id, { ...input, reason: 'Different decision' }), { code: 'IDEMPOTENCY_CONFLICT' });
    const fresh = await f.client.start({ commandId: 'fresh-work', objective: 'Explicit next task' });
    await waitFor(() => f.store.get(fresh.id).phase === 'running' ? true : undefined);
    assert.equal((await f.client.status(f.run.id)).integration!.phase, 'abandoned');
  } finally { await f.cleanup(); }
});

test('keep-current refuses unproved commands', async () => {
  const f = await fixture();
  try {
    await f.server.close();
    const preview = await f.runtime.previewIntegration(f.run.id, undefined, 0, 100, undefined, new AbortController().signal);
    const input: IntegrateCommand = { commandId: 'prepare-only', type: 'integrate', expectedRevision: f.store.get(f.run.id).revision, planId: preview.id };
    const engine = new IntegrationEngine(f.store, f.source);
    const job = await engine.prepare(f.run.id, input.expectedRevision, input.planId, new AbortController().signal, integrationRequest(f.run.id, input));
    const unknown = f.store.integrations.update(job.id, job.revision, 'fixture.unknown_command', r => ({ ...r, phase: 'blocked', commandIntent: 'accept' }));
    await assert.rejects(engine.abandon(f.run.id, job.id, { commandId: 'unsafe', type: 'abandon', expectedRevision: unknown.revision,
      targetDigest: preview.targetDigest, reason: 'Cannot substitute words for exit evidence' }, new AbortController().signal), { code: 'EXTERNAL_STATE_UNKNOWN' });
    assert.equal(f.store.integrations.unresolved(), true);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'original');
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('keep-current cannot steal a foreign reservation even after final acceptance failed', async () => {
  const f = await fixture(true, code + ";if(require('node:fs').existsSync('user-only'))process.exit(7)");
  try {
    await writeFile(join(f.source, 'user-only'), 'keep');
    const queued = await f.client.integrate(f.run.id, await f.command());
    const failed = await finished(f, queued.id);
    const view = await f.client.previewIntegration(f.run.id);
    await writeFile(failed.reservation, 'foreign owner');
    await f.client.abandonIntegration(f.run.id, queued.id, { commandId: 'keep-current', type: 'abandon', expectedRevision: failed.revision,
      targetDigest: view.targetDigest, reason: 'Preserve project files' });
    const blocked = await waitFor(() => { const r = f.store.integrations.get(queued.id); return r.phase === 'blocked' ? r : undefined; });
    assert.equal(blocked.reason, 'INTEGRATION_OWNER_UNKNOWN');
    assert.equal(await readFile(failed.reservation, 'utf8'), 'foreign owner');
    assert.equal(f.store.integrations.unresolved(), true);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'candidate');
  } finally { await f.cleanup(); }
});

test('keep-current completion resumes after real process exit between reservation release and journal acknowledgment', async () => {
  const f = await fixture(true, code + ";if(require('node:fs').existsSync('user-only'))process.exit(7)");
  let replacement: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    await writeFile(join(f.source, 'user-only'), 'keep');
    const queued = await f.client.integrate(f.run.id, await f.command());
    const failed = await finished(f, queued.id);
    const view = await f.client.previewIntegration(f.run.id);
    await f.server.close();
    await new IntegrationEngine(f.store, f.source).abandon(f.run.id, queued.id, { commandId: 'keep-after-stop', type: 'abandon', expectedRevision: failed.revision,
      targetDigest: view.targetDigest, reason: 'Explicit keep-current decision' }, new AbortController().signal);
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/integration-crash.js', import.meta.url)), join(f.data, 'state.sqlite'),
      f.source, queued.id, 'integration.abandoned', '1'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = ''; child.stdout.on('data', b => { output += String(b); }); child.stderr.on('data', b => { output += String(b); });
    const exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(exit, 77, output);
    await assert.rejects(lstat(failed.reservation), { code: 'ENOENT' });
    assert.equal(f.store.integrations.get(queued.id).phase, 'abandoning');
    const runtime = new Runtime(f.store, f.fake, { source: f.source, attemptsDirectory: join(f.data, 'attempts'), maxConcurrency: 2,
      attemptTimeoutMs: 10_000, executionProfile: { driver: 'test' }, verification: policy(code + ";if(require('node:fs').existsSync('user-only'))process.exit(7)"), integration: { enabled: true } });
    replacement = await serve(runtime, f.token);
    await waitFor(() => f.store.integrations.get(queued.id).phase === 'abandoned' ? true : undefined);
    assert.equal(f.store.integrations.unresolved(), false);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'candidate');
    assert.equal(await readFile(join(f.source, 'user-only'), 'utf8'), 'keep');
  } finally { await replacement?.close(); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('authorized pending integration survives Runtime replacement and only then updates the source', async () => {
  const f = await fixture();
  let replacement: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    await f.server.close();
    const preview = await f.runtime.previewIntegration(f.run.id, undefined, 0, 100, undefined, new AbortController().signal);
    const input: IntegrateCommand = { commandId: 'durable-integrate', type: 'integrate', expectedRevision: f.store.get(f.run.id).revision, planId: preview.id };
    const job = await new IntegrationEngine(f.store, f.source).prepare(f.run.id, input.expectedRevision, input.planId,
      new AbortController().signal, integrationRequest(f.run.id, input));
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'original');
    const runtime = new Runtime(f.store, f.fake, { source: f.source, attemptsDirectory: join(f.data, 'attempts'), maxConcurrency: 2,
      attemptTimeoutMs: 10_000, executionProfile: { driver: 'test' }, verification: policy(), integration: { enabled: true } });
    replacement = await serve(runtime, f.token);
    const done = await finished(f, job.id);
    assert.equal(done.phase, 'succeeded', JSON.stringify(done));
    const client = new Client(replacement.url, f.token);
    assert.equal((await client.integrate(f.run.id, input)).id, job.id);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'candidate');
  } finally {
    await replacement?.close(); f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('CLI rejects enabled integration without verification before starting DSH', async () => {
  const f = await fixture(false);
  try {
    const config = join(f.data, 'invalid-integration.json');
    await writeFile(config, JSON.stringify({ workspace: f.source, dataDirectory: f.data, integration: { enabled: true },
      dsh: { dshBin: process.execPath, profile: 'sdk', provider: 'fixture', model: 'fixture' } }));
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), '--config', config],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.on('data', bytes => { output += String(bytes); }); child.stderr.on('data', bytes => { output += String(bytes); });
    const exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(exit, 1); assert.match(output, /CONFIG_INVALID/);
    assert.equal(output.includes('SDK initialize succeeded'), false);
  } finally { await f.cleanup(); }
});

test('real Cordis host tool invokes the explicit integration command and observes the result', async () => {
  const f = await fixture(), ctx = new Context();
  const keys = ['TEAMWORK_URL', 'TEAMWORK_HOST_TOKEN', 'TEAMWORK_CONNECTION_FILE', 'TEAMWORK_ATTEMPT_TOKEN'] as const;
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.TEAMWORK_URL = f.server.url; process.env.TEAMWORK_HOST_TOKEN = f.token;
    ctx.provide('systemPrompt', { tools: () => () => {} } as unknown as Context['systemPrompt']);
    await ctx.plugin(ToolRuntime); await waitFor(() => ctx.get('tools'));
    const fiber = ctx.plugin(host); await waitFor(() => ctx.tools.get('teamwork_integrate'));
    const result = await ctx.tools.execute({ callId: 'integrate-call' as ToolExecutionInput['callId'], name: 'teamwork_integrate',
      arguments: { runId: f.run.id, ...await f.command() }, signal: new AbortController().signal });
    assert.equal(result.isError, false, JSON.stringify(result));
    const job = f.store.integrations.forRun(f.run.id)[0]!;
    assert.equal((await finished(f, job.id)).phase, 'succeeded');
    const list = await ctx.tools.execute({ callId: 'integrations-list' as ToolExecutionInput['callId'], name: 'teamwork_inspect',
      arguments: { runId: f.run.id, kind: 'integrations' }, signal: new AbortController().signal });
    assert.equal(list.isError, false); assert.match(JSON.stringify(list), /succeeded/);
    await fiber.dispose(); assert.equal(ctx.tools.get('teamwork_integrate'), undefined);
  } finally {
    await ctx.fiber.dispose();
    for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; }
    await f.cleanup();
  }
});
