import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startService, serviceStatus, stopService } from '../src/service.js';
import { Store } from '../src/store.js';
import { Client } from '../src/client.js';
import { shutdownSchema } from '../src/service-contracts.js';
import type { VerificationPolicy } from '../src/contracts.js';
import { FakeExecutor, waitFor, report } from './helpers.js';

async function fixture(verification?: VerificationPolicy) {
  const root = await mkdtemp(join(tmpdir(), 'teamwork-service-')), source = join(root, 'source'), dataDirectory = join(root, 'data');
  await mkdir(source); await writeFile(join(source, 'hello.txt'), 'original');
  const fake = new FakeExecutor(), options = { source, dataDirectory, maxConcurrency: 2, attemptTimeoutMs: 30_000,
    executionProfile: { driver: 'test' }, lifecycle: 'persistent' as const, ...(verification ? { verification, integration: { enabled: true } } : {}) };
  const service = await startService(options, fake);
  const connection = JSON.parse(await readFile(join(dataDirectory, 'connection.json'), 'utf8')) as { url: string; token: string };
  const client = new Client(connection.url, connection.token);
  const stop = (mode: 'drain' | 'interrupt' = 'interrupt', commandId = 'stop') => ({ type: 'stop' as const, instanceId: service.status().instanceId, commandId, mode });
  return { root, source, dataDirectory, options, fake, service, connection, client, stop,
    async cleanup() {
      if (service.status().state === 'blocked') {
        fake.failClose = false; fake.instances.forEach(a => a.finish());
        await service.server.close().catch(() => {}); try { service.store.close(); } catch { /* already closed */ }
        await rm(root, { recursive: true, force: true }); return;
      }
      if (service.status().state !== 'stopped') { service.stop(stop('interrupt', 'cleanup')); await service.closed; }
      await rm(root, { recursive: true, force: true });
    } };
}

test('service startup publishes distinct scoped credentials, persists lifecycle and does not launch model work', async () => {
  const f = await fixture();
  try {
    const status = await serviceStatus(f.dataDirectory);
    assert.equal(status.state, 'running'); assert.equal(status.lifecycle, 'persistent'); assert.equal(f.fake.instances.length, 0);
    const record = JSON.parse(await readFile(join(f.dataDirectory, 'runtime-service.json'), 'utf8')) as { operatorToken: string };
    assert.notEqual(record.operatorToken, f.connection.token); assert.equal('operatorToken' in f.connection, false);
    assert.ok(!JSON.stringify(status).includes(f.connection.token)); assert.ok(!JSON.stringify(status).includes(record.operatorToken));
    const root = await f.client.start({ commandId: 'start', objective: 'Fix' }); assert.equal(root.lifecycle, 'persistent');
    const worker = await waitFor(() => f.fake.instances[0]);
    for (const token of [f.connection.token, worker.bridge.token]) {
      assert.equal((await fetch(`${f.connection.url}/v1/runtime`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
      assert.equal((await fetch(`${f.connection.url}/v1/runtime/commands`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(f.stop()) })).status, 401);
    }
    await assert.rejects(new Client(f.connection.url, record.operatorToken).status(root.id), { code: 'UNAUTHORIZED' });
  } finally { await f.cleanup(); }
});

test('operator interrupt pauses active and queued work atomically; reopen retains holds, budget and fresh resume identity', async () => {
  const f = await fixture();
  let replacement: Awaited<ReturnType<typeof startService>> | undefined;
  try {
    const first = await f.client.start({ commandId: 'first', objective: 'Fix', budget: { maxModelAttempts: 4 } });
    await f.client.start({ commandId: 'second', objective: 'Fix another' });
    const queued = await f.client.start({ commandId: 'queued', objective: 'Wait for a slot' });
    await waitFor(() => f.fake.instances.length === 2 ? true : undefined);
    const receipt = await stopService(f.dataDirectory, f.stop()); assert.equal(receipt.accepted, true); assert.equal(receipt.rootRunIds.length, 3);
    await f.service.closed;
    assert.ok(f.fake.instances.every(a => a.closed)); assert.equal(f.fake.instances.length, 2);
    assert.equal((await serviceStatus(f.dataDirectory)).state, 'stopped');
    await assert.rejects(lstat(join(f.dataDirectory, 'runtime.lock')), { code: 'ENOENT' });
    const nextFake = new FakeExecutor(); replacement = await startService(f.options, nextFake);
    const before = replacement.store.get(first.id);
    assert.equal(before.phase, 'paused'); assert.equal(before.budget!.reservedModelAttempts, 1);
    assert.equal(replacement.store.get(queued.id).phase, 'paused'); assert.equal(nextFake.instances.length, 0);
    await assert.rejects(stopService(f.dataDirectory, f.stop()), { code: 'SERVICE_IDENTITY_CHANGED' });
    replacement.runtime.controlWorkflow(first.id, { type: 'resume', commandId: 'resume', expectedWorkflowRevision: replacement.store.workflow(first.id).revision });
    await waitFor(() => nextFake.instances[0]);
    assert.notEqual(replacement.store.get(first.id).order.attemptId, first.order.attemptId);
    assert.equal(replacement.store.get(first.id).budget!.reservedModelAttempts, 2);
    replacement.stop({ ...f.stop(), instanceId: replacement.status().instanceId, commandId: 'stop-replacement' }); await replacement.closed;
  } finally {
    if (replacement && replacement.status().state !== 'stopped') { replacement.stop({ ...f.stop(), instanceId: replacement.status().instanceId, commandId: 'cleanup-next' }); await replacement.closed; }
    await f.cleanup();
  }
});

test('drain keeps bridge alive until submission and supports exact receipt replay or explicit interrupt escalation', async () => {
  const f = await fixture();
  try {
    const run = await f.client.start({ commandId: 'run', objective: 'Fix' }), worker = await waitFor(() => f.fake.instances[0]);
    const input = f.stop('drain');
    const receipt = await stopService(f.dataDirectory, input);
    assert.equal((await serviceStatus(f.dataDirectory)).state, 'draining'); assert.equal(worker.closed, false);
    assert.deepEqual(await stopService(f.dataDirectory, input), receipt);
    await assert.rejects(stopService(f.dataDirectory, { ...input, mode: 'interrupt' }), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(f.client.start({ commandId: 'after-stop', objective: 'No new work' }), { code: 'UNAVAILABLE' });
    await new Client(worker.bridge.url, worker.bridge.token).bridge(worker.order.attemptId, 'submit', {
      commandId: 'submit', epoch: worker.order.epoch, inputDigest: worker.order.inputDigest, report }); worker.finish();
    await f.service.closed.catch(error => { assert.fail(`Shutdown failed: ${String(error)}; cause: ${String(error.cause)}`); });
    const store = new Store(join(f.dataDirectory, 'runtime.sqlite'));
    try { assert.equal(store.get(run.id).phase, 'paused'); assert.equal(store.get(run.id).pause!.continuation!.kind, 'submitted'); }
    finally { store.close(); }
  } finally { await f.cleanup(); }
});

test('drain can escalate to interrupt but cannot resurrect queued work or steal a live owner', async () => {
  const f = await fixture();
  try {
    await f.client.start({ commandId: 'run', objective: 'Fix' }); await waitFor(() => f.fake.instances[0]);
    await stopService(f.dataDirectory, f.stop('drain'));
    await assert.rejects(startService(f.options, new FakeExecutor()), { code: 'RUNTIME_OWNED' });
    await stopService(f.dataDirectory, f.stop('interrupt', 'escalate')); await f.service.closed;
    assert.equal(f.fake.instances[0]!.closed, true);
  } finally { await f.cleanup(); }
});

test('shutdown receipt failure rolls back all roots and leaves scheduling available', async () => {
  const f = await fixture(), audit = new DatabaseSync(join(f.dataDirectory, 'runtime.sqlite'));
  try {
    const first = await f.client.start({ commandId: 'run', objective: 'Fix' }); await waitFor(() => f.fake.instances[0]);
    const before = f.service.store.workflow(first.id);
    audit.exec("CREATE TRIGGER stop_failure BEFORE INSERT ON commands WHEN NEW.id='operator:stop' BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    assert.throws(() => f.service.stop(f.stop()));
    assert.deepEqual(f.service.store.workflow(first.id), before); assert.equal(f.service.status().state, 'running');
    await f.client.start({ commandId: 'still-available', objective: 'Separate work' }); await waitFor(() => f.fake.instances[1]);
    audit.exec('DROP TRIGGER stop_failure');
  } finally { audit.close(); await f.cleanup(); }
});

test('unknown worker stop retains the management endpoint and owner instead of claiming a clean exit', async () => {
  const f = await fixture();
  try {
    await f.client.start({ commandId: 'run', objective: 'Fix' }); await waitFor(() => f.fake.instances[0]);
    f.fake.failClose = true; await stopService(f.dataDirectory, f.stop());
    await assert.rejects(f.service.closed, { code: 'SHUTDOWN_UNCONFIRMED' });
    const status = await serviceStatus(f.dataDirectory); assert.equal(status.state, 'blocked'); assert.equal(status.blockedRunIds.length, 1);
    await lstat(join(f.dataDirectory, 'runtime.lock'));
    await assert.rejects(startService(f.options, new FakeExecutor()), { code: 'RUNTIME_OWNED' });
  } finally {
    // Explicit teardown of the test-only fake; product code deliberately retains the unconfirmed owner.
    f.fake.failClose = false; f.fake.instances.forEach(a => a.finish());
    await f.service.server.close(); f.service.store.close(); await rm(f.root, { recursive: true, force: true });
  }
});

test('service stop schema is generation-bound and status rejects redirected credential destinations', async () => {
  const f = await fixture();
  try {
    assert.equal(shutdownSchema.safeParse({ type: 'stop', commandId: 'stop' }).success, false);
    await assert.rejects(stopService(f.dataDirectory, { ...f.stop(), instanceId: 'another-instance' }), { code: 'SERVICE_IDENTITY_CHANGED' });
    const path = join(f.dataDirectory, 'runtime-service.json'), original = await readFile(path, 'utf8'), record = JSON.parse(original);
    try {
      for (const url of ['https://example.com', 'http://127.0.0.1:1/arbitrary', 'http://secret@127.0.0.1:1']) {
        await writeFile(path, JSON.stringify({ ...record, url }));
        await assert.rejects(serviceStatus(f.dataDirectory), { code: 'SERVICE_RECORD_INVALID' });
      }
    } finally { await writeFile(path, original); }
  } finally { await f.cleanup(); }
});

for (const mode of ['drain', 'interrupt'] as const) test(`service ${mode} waits for final writer proof before releasing the Runtime owner`, async () => {
  const f = await fixture({ commands: [{ id: 'accept', executable: process.execPath,
    args: ['-e', "const f=require('node:fs');if(f.existsSync('wait-final')){const p=f.readFileSync('wait-final','utf8');const t=setInterval(()=>{if(f.existsSync(p))clearInterval(t)},20)}"], timeoutMs: 15_000 }] });
  try {
    const root = await f.client.start({ commandId: 'run', objective: 'Fix' });
    const submit = async (a: FakeExecutor['instances'][number]) => {
      await new Client(a.bridge.url, a.bridge.token).bridge(a.order.attemptId, 'submit', { commandId: 'submit', epoch: a.order.epoch,
        inputDigest: a.order.inputDigest, report: a.order.role === 'review' ? { ...report, review: { functionality: 'pass', completeness: 'pass', findings: [] } } : report }); a.finish();
    };
    const worker = await waitFor(() => f.fake.instances[0]); await writeFile(join(worker.order.workspace, 'hello.txt'), 'fixed');
    await submit(worker); await submit(await waitFor(() => f.fake.instances[1]));
    await waitFor(() => f.service.store.get(root.id).phase === 'verified' ? true : undefined);
    const release = join(f.root, 'release'); await writeFile(join(f.source, 'wait-final'), release);
    const plan = await f.client.previewIntegration(root.id);
    const job = await f.client.integrate(root.id, { type: 'integrate', commandId: 'integrate', expectedRevision: f.service.store.get(root.id).revision, planId: plan.id });
    await waitFor(() => f.service.store.integrations.get(job.id).commandIntent ? true : undefined);
    const receipt = await stopService(f.dataDirectory, f.stop(mode)); assert.equal(receipt.accepted, true);
    if (mode === 'drain') {
      assert.equal((await serviceStatus(f.dataDirectory)).state, 'draining'); await lstat(join(f.dataDirectory, 'runtime.lock'));
      await writeFile(release, 'go');
    }
    await f.service.closed;
    const store = new Store(join(f.dataDirectory, 'runtime.sqlite'));
    try {
      const done = store.integrations.get(job.id); assert.equal(done.phase, mode === 'drain' ? 'succeeded' : 'blocked');
      assert.equal(done.commandIntent, undefined); if (mode === 'interrupt') assert.ok(done.commandStop);
      assert.equal(store.workflowHeld(root.id), true);
    } finally { store.close(); }
    await assert.rejects(lstat(join(f.dataDirectory, 'runtime.lock')), { code: 'ENOENT' });
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'fixed');
  } finally { await f.cleanup(); }
});

test('rejected lifecycle/profile change does not mutate previously accepted work or holds', async () => {
  const f = await fixture();
  try {
    const run = await f.client.start({ commandId: 'run', objective: 'Fix' }); await waitFor(() => f.fake.instances[0]);
    f.service.stop(f.stop()); await f.service.closed;
    const store = new Store(join(f.dataDirectory, 'runtime.sqlite'));
    const before = store.workflow(run.id); store.close();
    await assert.rejects(startService({ ...f.options, lifecycle: 'attached' }, new FakeExecutor()), { code: 'PROFILE_CHANGED' });
    const reopened = new Store(join(f.dataDirectory, 'runtime.sqlite'));
    try { assert.deepEqual(reopened.workflow(run.id), before); } finally { reopened.close(); }
    await assert.rejects(lstat(join(f.dataDirectory, 'runtime.lock')), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('connection publication failure after recovery pauses the queued run before releasing ownership', async () => {
  const f = await fixture();
  try {
    f.service.stop(f.stop()); await f.service.closed;
    const store = new Store(join(f.dataDirectory, 'runtime.sqlite'));
    const queued = store.start({ commandId: 'previously-authorized', objective: 'Resume dispatch after restart' }, join(f.dataDirectory, 'attempts'), f.options.executionProfile, undefined, 'persistent');
    store.close();
    const connection = join(f.dataDirectory, 'connection.json'); await rename(connection, join(f.dataDirectory, 'previous-connection.json')); await mkdir(connection);
    const fake = new FakeExecutor();
    await assert.rejects(startService(f.options, fake), { code: 'SERVICE_RECORD_INVALID' });
    assert.ok(fake.instances.every(a => a.closed));
    const reopened = new Store(join(f.dataDirectory, 'runtime.sqlite'));
    try { assert.equal(reopened.get(queued.id).phase, 'paused'); assert.equal(reopened.workflowHeld(queued.id), true); }
    finally { reopened.close(); }
    assert.equal((await lstat(connection)).isDirectory(), true);
    await assert.rejects(lstat(join(f.dataDirectory, 'runtime.lock')), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});
