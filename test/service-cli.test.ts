import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { Client } from '../src/client.js';
import { Store } from '../src/store.js';
import { serviceStatus, stopService } from '../src/service.js';
import { launchPersistent, launchAttached } from '../src/service-launcher.js';

const exec = promisify(execFile), cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
async function until<T>(body: () => Promise<T | undefined>, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await body(); if (value !== undefined) return value; await setTimeout(25); }
  throw new Error('Timed out waiting for confirmed lifecycle state');
}
async function fixture(pauseDemo = false) {
  const root = await mkdtemp(join(tmpdir(), 'teamwork-cli-')), source = join(root, 'source'), data = join(root, 'data'), dshHome = join(root, 'dsh-home');
  await mkdir(source); await mkdir(dshHome); await writeFile(join(source, 'hello.txt'), 'original');
  const patch = join(root, 'offline.yml');
  await writeFile(patch, `- insert:\n    - id: offline-test-provider\n      name: ${JSON.stringify(new URL('./fixtures/offline-provider.js', import.meta.url).href)}\n      inject: [llm]\n      config:\n        pauseDemo: ${pauseDemo}\n`);
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({ workspace: source, dataDirectory: data, maxConcurrency: 1, attemptTimeoutMs: 40_000,
    verification: { commands: [{ id: 'readback', executable: process.execPath,
      args: ['-e', "require('node:assert').equal(require('node:fs').readFileSync('hello.txt','utf8'),'changed through real DSH tool')"], timeoutMs: 5000 }] },
    integration: { enabled: true }, dsh: { dshBin: fileURLToPath(new URL('../../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url)),
      profile: 'sdk', patches: [patch], provider: 'teamwork-offline-fixture', model: 'deterministic', dshHome } }));
  const env = { ...process.env };
  for (const key of ['TEAMWORK_HOST_TOKEN', 'TEAMWORK_ATTEMPT_TOKEN', 'TEAMWORK_URL', 'TEAMWORK_CONNECTION_FILE']) delete env[key];
  const command = (args: string[]) => exec(process.execPath, [cli, ...args, '--config', config], { windowsHide: true, env, timeout: 20_000, maxBuffer: 128 * 1024 });
  async function connection() {
    const record = JSON.parse(await readFile(join(data, 'connection.json'), 'utf8')) as { url: string; token: string };
    return { ...record, client: new Client(record.url, record.token) };
  }
  async function stopped() { return until(async () => {
    try { const status = await serviceStatus(data); return status.state === 'stopped' ? status : undefined; }
    catch (error) { if (['SERVICE_UNREACHABLE', 'SERVICE_TRANSITION'].includes((error as { code: string }).code)) return undefined; throw error; }
  }); }
  return { root, source, data, config, env, command, connection, stopped,
    async cleanup() {
      try {
        const status = await serviceStatus(data);
        if (status.state !== 'stopped') { await stopService(data, { type: 'stop', instanceId: status.instanceId, commandId: 'test-cleanup', mode: 'interrupt' }); await stopped(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; // Never erase uncertain live-service evidence.
      }
      await rm(root, { recursive: true, force: true });
    } };
}

test('persistent CLI launcher exits while real DSH implementation, review and final integration continue independently', { timeout: 90_000 }, async () => {
  const f = await fixture();
  try {
    const launch = await f.command(['start']); assert.match(launch.stdout, /Persistent Runtime ready/);
    const status = await serviceStatus(f.data); assert.equal(status.lifecycle, 'persistent'); assert.equal(status.state, 'running');
    const { client, token } = await f.connection(); assert.ok(!launch.stdout.includes(token));
    // execFile has confirmed the launcher exited. Only the detached Runtime owns the following DSH children.
    const run = await client.start({ commandId: 'start', objective: 'Exercise persistent autonomous work',
      spec: { requirements: [], writeScope: { files: ['hello.txt'], trees: [] } }, budget: { maxModelAttempts: 2 }, autonomy: { integration: 'on-gate-pass' } });
    assert.equal(run.lifecycle, 'persistent');
    const completed = await until(async () => { const current = await client.workflow(run.id); return current.state === 'integrated' ? current : undefined; }, 50_000);
    assert.equal(completed.budgets[0]!.reservedModelAttempts, 2);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'changed through real DSH tool');
    await assert.rejects(f.command(['start']), error => /RUNTIME_OWNED/.test(String((error as { stderr?: string }).stderr)));
    assert.equal((await serviceStatus(f.data)).instanceId, status.instanceId);
    const stop = await f.command(['stop', '--instance-id', status.instanceId, '--command-id', 'stop']); assert.match(stop.stdout, /Stop accepted/);
    await f.stopped(); assert.match((await f.command(['status'])).stdout, /"state":"stopped"/);
    await f.command(['start']);
    const replacement = await serviceStatus(f.data); assert.notEqual(replacement.instanceId, status.instanceId);
    await assert.rejects(f.command(['stop', '--instance-id', status.instanceId, '--command-id', 'stop']), error => /SERVICE_IDENTITY_CHANGED/.test(String((error as { stderr?: string }).stderr)));
    assert.equal((await serviceStatus(f.data)).state, 'running');
  } finally { await f.cleanup(); }
});

test('attached owner death disconnects IPC and pauses a real DSH worker with durable recovery evidence', { timeout: 90_000 }, async () => {
  const f = await fixture(true);
  const owner = spawn(process.execPath, [cli, '--config', f.config], { windowsHide: true, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = ''; owner.stdout.on('data', chunk => { output += chunk; }); owner.stderr.on('data', chunk => { errors += chunk; });
  const ownerExit = new Promise<void>(resolve => owner.once('exit', () => resolve()));
  try {
    await until(async () => { if (owner.exitCode !== null) throw new Error(`Owner exited before ready: ${errors}`); return output.includes('Attached Runtime ready') ? true : undefined; });
    const status = await serviceStatus(f.data); assert.equal(status.lifecycle, 'attached'); assert.notEqual(status.pid, owner.pid);
    const { client } = await f.connection();
    const run = await client.start({ commandId: 'start', objective: 'Pause on owner exit', budget: { maxModelAttempts: 4 } });
    await until(async () => (await client.status(run.id)).checkpoint ? true : undefined, 40_000);
    owner.kill('SIGKILL'); await ownerExit; // Kill only the process created above, not a discovered or reusable PID.
    await f.stopped(); await assert.rejects(lstat(join(f.data, 'runtime.lock')), { code: 'ENOENT' });
    const store = new Store(join(f.data, 'runtime.sqlite'));
    try {
      const paused = store.get(run.id); assert.equal(paused.phase, 'paused'); assert.equal(paused.lifecycle, 'attached');
      assert.equal(paused.pause!.continuation!.kind, 'implementation'); assert.ok('candidate' in paused.pause!.continuation!);
      assert.equal(paused.budget!.reservedModelAttempts, 1); assert.equal(store.workflowHeld(run.id), true);
    } finally { store.close(); }
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'original');
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) { owner.kill('SIGKILL'); await ownerExit; }
    await f.cleanup();
  }
});

test('CLI rejects ambiguous stops and worker-scoped service launch without starting another process', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.command(['stop']), error => /CONFIG_INVALID/.test(String((error as { stderr?: string }).stderr)));
    await assert.rejects(f.command(['run', '--service-child']), error => /CONFIG_INVALID/.test(String((error as { stderr?: string }).stderr)));
    await assert.rejects(exec(process.execPath, [cli, 'start', '--config', f.config], { windowsHide: true, env: { ...f.env, TEAMWORK_ATTEMPT_TOKEN: 'test-only-worker' } }),
      error => /WORKER_SCOPE/.test(String((error as { stderr?: string }).stderr)));
    await assert.rejects(lstat(f.data), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

for (const lifecycle of ['attached', 'persistent'] as const) test(`${lifecycle} startup observation timeout does not imply process death or authorize replacement`, { timeout: 45_000 }, async () => {
  const f = await fixture();
  try {
    await assert.rejects(lifecycle === 'persistent' ? launchPersistent(f.config, 1) : launchAttached(f.config, () => {}, 1), { code: 'STARTUP_UNCONFIRMED' });
    const status = await until(async () => {
      try { const current = await serviceStatus(f.data); return current.state === (lifecycle === 'persistent' ? 'running' : 'stopped') ? current : undefined; }
      catch (error) { if (['ENOENT', 'SERVICE_UNREACHABLE', 'SERVICE_TRANSITION'].includes((error as { code: string }).code)) return undefined; throw error; }
    });
    assert.equal(status.lifecycle, lifecycle); assert.deepEqual(status.activeRunIds, []);
  } finally { await f.cleanup(); }
});
