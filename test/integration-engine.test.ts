import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, rename, symlink, rm, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { Client } from '../src/client.js';
import { IntegrationEngine } from '../src/integration-engine.js';
import { sourceManifest } from '../src/workspace.js';
import { FakeExecutor, setup, waitFor, report } from './helpers.js';
import type { IntegrationRecord } from '../src/integration-journal.js';

const signal = (): AbortSignal => new AbortController().signal;
const accept = "require('node:assert').equal(require('node:fs').readFileSync('hello.txt','utf8'),'candidate')";
async function fixture(mutate?: (source: string) => Promise<void>, change?: (candidate: string) => Promise<void>, command = accept) {
  const fake = new FakeExecutor();
  const f = await setup(fake, 10_000, { commands: [{ id: 'accept', executable: process.execPath, args: ['-e', command], timeoutMs: 5_000 }] });
  try {
    if (mutate) await mutate(f.source);
    const run = await f.client.start({ commandId: 'start', objective: 'Fix and integrate' });
    const implementation = await waitFor(() => fake.instances[0]);
    await writeFile(join(implementation.order.workspace, 'hello.txt'), 'candidate');
    if (change) await change(implementation.order.workspace);
    await new Client(implementation.bridge.url, implementation.bridge.token).bridge(implementation.order.attemptId, 'submit', {
      commandId: 'submit', epoch: implementation.order.epoch, inputDigest: implementation.order.inputDigest, report,
    });
    implementation.finish();
    const reviewer = await waitFor(() => fake.instances[1]);
    await new Client(reviewer.bridge.url, reviewer.bridge.token).bridge(reviewer.order.attemptId, 'submit', {
      commandId: 'submit', epoch: reviewer.order.epoch, inputDigest: reviewer.order.inputDigest,
      report: { ...report, review: { functionality: 'pass', completeness: 'pass', findings: [] } },
    });
    reviewer.finish();
    const verified = await waitFor(() => { const r = f.store.get(run.id); return r.phase === 'verified' ? r : undefined; });
    const engine = new IntegrationEngine(f.store, f.source);
    const prepare = async (): Promise<IntegrationRecord> => {
      const preview = await f.client.previewIntegration(run.id);
      return engine.prepare(run.id, f.store.get(run.id).revision, preview.id, signal());
    };
    return { ...f, engine, run: verified, prepare };
  } catch (error) { await f.cleanup(); throw error; }
}
async function crash(database: string, source: string, id: string, boundary: string, ordinal = 1): Promise<void> {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/integration-crash.js', import.meta.url)), database, source, id, boundary, String(ordinal)],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH } });
  let output = '';
  child.stdout.on('data', bytes => { output += String(bytes); }); child.stderr.on('data', bytes => { output += String(bytes); });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 77, output);
}

test('integration writes the merged tree, keeps user files and backups, and validates an independent final copy', async () => {
  const f = await fixture(async source => {
    await writeFile(join(source, 'deleted'), 'old delete');
    await mkdir(join(source, 'was-dir')); await writeFile(join(source, 'was-dir', 'child'), 'old child');
    await writeFile(join(source, 'was-file'), 'old file');
    await writeFile(join(source, '.env'), 'fixture-secret');
  }, async candidate => {
    await rm(join(candidate, 'deleted'));
    await rm(join(candidate, 'was-dir'), { recursive: true }); await writeFile(join(candidate, 'was-dir'), 'now file');
    await rm(join(candidate, 'was-file')); await mkdir(join(candidate, 'was-file')); await writeFile(join(candidate, 'was-file', 'new'), 'nested');
    await mkdir(join(candidate, 'empty')); await writeFile(join(candidate, 'added'), 'new');
  }, accept + ";require('node:fs').writeFileSync('build-output','independent')");
  try {
    await writeFile(join(f.source, 'user-only'), 'preserve');
    const prepared = await f.prepare();
    assert.equal(prepared.phase, 'prepared');
    const result = await f.engine.execute(prepared.id, signal());
    assert.equal(result.phase, 'succeeded', JSON.stringify(result));
    assert.ok(result.effects.every(e => e.state === 'done'));
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'candidate');
    assert.equal(await readFile(join(f.source, 'user-only'), 'utf8'), 'preserve');
    assert.equal(await readFile(join(f.source, '.env'), 'utf8'), 'fixture-secret');
    assert.equal(await readFile(join(f.source, 'was-dir'), 'utf8'), 'now file');
    assert.equal(await readFile(join(f.source, 'was-file', 'new'), 'utf8'), 'nested');
    await assert.rejects(lstat(join(f.source, 'deleted')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(f.source, 'build-output')), { code: 'ENOENT' });
    assert.equal(await readFile(join(result.validationWorkspace!, 'build-output'), 'utf8'), 'independent');
    assert.equal(result.integrated!.digest, (await sourceManifest(f.source, signal())).manifest.digest);
    assert.notEqual(result.integrated!.digest, result.candidate.digest); // Includes concurrent unrelated file.
    const original = result.effects.find(e => e.path === 'hello.txt' && e.kind === 'remove_file')!;
    assert.equal(await readFile(join(result.directory, `${original.id}.backup`), 'utf8'), 'original');
    assert.equal((await readdir(result.directory)).some(name => name.endsWith('.stage')), false);
    assert.equal((await lstat(join(f.source, 'hello.txt'))).nlink, 1);
    assert.equal(result.validation[0]!.exitCode, 0);
    assert.equal(f.store.get(f.run.id).phase, 'verified'); // Integration journal is separate until host lifecycle wiring.
    const repeated = await f.engine.execute(result.id, signal());
    assert.deepEqual(repeated, result);
    assert.ok(f.store.integrations.events(result.id).some(e => e.type === 'integration.effect_intent'));
    assert.equal(f.store.integrations.forRun(f.run.id)[0]!.phase, 'succeeded');
    await assert.rejects(lstat(result.reservation), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('unverified runs, stale previews and preflight conflicts never write the project', async () => {
  const f = await fixture();
  try {
    const unverified = f.store.start({ commandId: 'unverified', objective: 'Not verified' }, f.data, {});
    await assert.rejects(f.engine.prepare(unverified.id, unverified.revision, 'x', signal()), { code: 'INTEGRATION_NOT_VERIFIED' });
    const preview = await f.client.previewIntegration(f.run.id);
    await assert.rejects(f.engine.prepare(f.run.id, f.run.revision + 1, preview.id, signal()), { code: 'REVISION_CONFLICT' });
    await writeFile(join(f.source, 'hello.txt'), 'user edit');
    await assert.rejects(f.engine.prepare(f.run.id, f.run.revision, preview.id, signal()), { code: 'INTEGRATION_PLAN_STALE' });
    const conflict = await f.prepare();
    assert.equal(conflict.phase, 'conflict');
    assert.deepEqual(await f.engine.execute(conflict.id, signal()), conflict);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'user edit');
    await assert.rejects(lstat(conflict.directory), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('durable source lease excludes a second integration and journal identity/revision are immutable', async () => {
  const f = await fixture();
  try {
    const job = await f.prepare();
    await assert.rejects(f.prepare(), { code: 'INTEGRATION_BUSY' });
    assert.throws(() => f.store.integrations.update(job.id, 99, 'bad', r => r), { code: 'REVISION_CONFLICT' });
    assert.throws(() => f.store.integrations.update(job.id, 0, 'bad', r => ({ ...r, source: f.data })), { code: 'INTEGRATION_IDENTITY' });
    assert.equal(f.store.integrations.get(job.id).revision, 0);
    const running = f.engine.execute(job.id, signal());
    await assert.rejects(new IntegrationEngine(f.store, f.source).execute(job.id, signal()), { code: 'INTEGRATION_BUSY' });
    assert.equal((await running).phase, 'succeeded');
    assert.equal((await f.prepare()).phase, 'prepared');
  } finally { await f.cleanup(); }
});

for (const mutation of ['source', 'candidate', 'foreign-owner'] as const) test(`integration refuses ${mutation} changes before writing`, async () => {
  const f = await fixture();
  try {
    const job = await f.prepare();
    if (mutation === 'source') await writeFile(join(f.source, 'hello.txt'), 'user edit');
    else if (mutation === 'candidate') await writeFile(join(f.run.candidate!.workspace, 'hello.txt'), 'tamper');
    else await writeFile(job.reservation, 'foreign owner');
    const result = await f.engine.execute(job.id, signal());
    assert.equal(result.phase, 'blocked');
    assert.equal(result.reason, mutation === 'source' ? 'INTEGRATION_PLAN_STALE' : mutation === 'candidate' ? 'ARTIFACT_CHANGED' : 'INTEGRATION_BUSY');
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), mutation === 'source' ? 'user edit' : 'original');
    if (mutation === 'source') assert.equal((await f.prepare()).phase, 'conflict');
    else await assert.rejects(f.prepare(), { code: mutation === 'candidate' ? 'ARTIFACT_CHANGED' : 'INTEGRATION_BUSY' });
  } finally { await f.cleanup(); }
});

for (const [boundary, ordinal] of [['integration.effect_done', 1], ['integration.effect_done', 2], ['integration.snapshot_intent', 1], ['integration.validation_prepared', 1], ['integration.succeeded', 1]] as const) {
  test(`process crash before ${boundary} #${ordinal} reconciles without repeating destructive effects`, async () => {
    const f = await fixture();
    try {
      const job = await f.prepare();
      await crash(join(f.data, 'state.sqlite'), f.source, job.id, boundary, ordinal);
      const interrupted = f.store.integrations.get(job.id);
      assert.notEqual(interrupted.phase, 'succeeded');
      const reopened = new Store(join(f.data, 'state.sqlite'));
      try {
        const resumed = await new IntegrationEngine(reopened, f.source).execute(job.id, signal());
        assert.equal(resumed.phase, 'succeeded', JSON.stringify(resumed));
        assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'candidate');
        const backups = (await readdir(job.directory)).filter(p => p.endsWith('.backup'));
        assert.equal(backups.length, 1);
        assert.equal(await readFile(join(job.directory, backups[0]!), 'utf8'), 'original');
      } finally { reopened.close(); }
    } finally { await f.cleanup(); }
  });
}

test('a destination created after crash is preserved; partial integration remains explicitly blocked', async () => {
  const f = await fixture();
  try {
    const job = await f.prepare();
    await crash(join(f.data, 'state.sqlite'), f.source, job.id, 'integration.effect_done', 1);
    await writeFile(join(f.source, 'hello.txt'), 'new user file');
    const result = await f.engine.execute(job.id, signal());
    assert.equal(result.phase, 'blocked');
    assert.equal(result.reason, 'INTEGRATION_CHANGED');
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'new user file');
    const backup = result.effects.find(e => e.kind === 'remove_file')!;
    assert.equal(await readFile(join(result.directory, `${backup.id}.backup`), 'utf8'), 'original');
    assert.deepEqual(await f.engine.execute(job.id, signal()), result);
  } finally { await f.cleanup(); }
});

test('unknown final command dispatch is not repeated after process exit', async () => {
  const f = await fixture();
  try {
    const job = await f.prepare();
    await crash(join(f.data, 'state.sqlite'), f.source, job.id, 'integration.command_done');
    assert.equal(f.store.integrations.get(job.id).commandIntent, 'accept');
    const result = await f.engine.execute(job.id, signal());
    assert.equal(result.phase, 'blocked'); assert.equal(result.reason, 'EXTERNAL_STATE_UNKNOWN');
    assert.equal(result.validation.length, 0);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'candidate');
  } finally { await f.cleanup(); }
});

test('final acceptance sees merged user changes and may fail even when candidate Gate passed', async () => {
  const f = await fixture(undefined, undefined, accept + ";if(require('node:fs').existsSync('user-only'))process.exit(7)");
  try {
    await writeFile(join(f.source, 'user-only'), 'preserve');
    const job = await f.prepare();
    const result = await f.engine.execute(job.id, signal());
    assert.equal(result.phase, 'failed'); assert.equal(result.reason, 'INTEGRATION_ACCEPTANCE_FAILED');
    assert.equal(result.validation[0]!.exitCode, 7);
    assert.equal(f.store.get(f.run.id).gate, 'passed');
    assert.equal(await readFile(join(f.source, 'user-only'), 'utf8'), 'preserve');
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'candidate');
    await assert.rejects(f.prepare(), { code: 'INTEGRATION_BUSY' });
  } finally { await f.cleanup(); }
});

test('cancellation after a saved original retains a recoverable backup and never reports success', async () => {
  const f = await fixture();
  try {
    const job = await f.prepare();
    await crash(join(f.data, 'state.sqlite'), f.source, job.id, 'integration.effect_done');
    const abort = new AbortController(); abort.abort();
    const result = await f.engine.execute(job.id, abort.signal);
    assert.equal(result.phase, 'blocked'); assert.equal(result.reason, 'ABORTED');
    assert.equal((await readdir(job.directory)).filter(p => p.endsWith('.backup')).length, 1);
  } finally { await f.cleanup(); }
});

for (const kind of ['backup', 'stage', 'parent-link', 'source-change-after-publish', 'unknown-directory-entry'] as const) test(`recovery blocks ${kind} without erasing new user data`, async () => {
  const f = await fixture(async source => {
    await mkdir(join(source, 'folder')); await writeFile(join(source, 'folder', 'old'), 'old child');
  }, async candidate => {
    await rm(join(candidate, 'folder'), { recursive: true });
  });
  try {
    const job = await f.prepare();
    // First effect removes folder/old; hello removal is second, empty folder removal is third.
    const first = job.effects[0]!;
    assert.equal(first.path, 'folder/old');
    await crash(join(f.data, 'state.sqlite'), f.source, job.id, 'integration.effect_done', kind === 'stage' || kind === 'source-change-after-publish' ? job.effects.length : 1);
    if (kind === 'backup') await writeFile(join(job.directory, `${first.id}.backup`), 'changed backup');
    else if (kind === 'stage') {
      const effect = job.effects.find(e => e.kind === 'write_file')!;
      // Replace the staging name, not the hardlinked published content.
      await rename(join(job.directory, `${effect.id}.stage`), join(job.directory, 'saved-stage'));
      await writeFile(join(job.directory, `${effect.id}.stage`), 'foreign-stage');
    } else if (kind === 'parent-link') {
      const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'old'), 'outside user data');
      await rename(join(f.source, 'folder'), join(f.root, 'saved-folder'));
      await symlink(outside, join(f.source, 'folder'), 'junction');
    } else if (kind === 'source-change-after-publish') await writeFile(join(f.source, 'hello.txt'), 'post-publication user edit');
    else await writeFile(join(f.source, 'folder', '.env'), 'fixture-user-secret');
    const result = await f.engine.execute(job.id, signal());
    assert.equal(result.phase, 'blocked');
    if (kind === 'backup') assert.equal(await readFile(join(job.directory, `${first.id}.backup`), 'utf8'), 'changed backup');
    else if (kind === 'stage') assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'candidate');
    else if (kind === 'parent-link') assert.equal(await readFile(join(f.root, 'outside', 'old'), 'utf8'), 'outside user data');
    else if (kind === 'source-change-after-publish') assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'post-publication user edit');
    else assert.equal(await readFile(join(f.source, 'folder', '.env'), 'utf8'), 'fixture-user-secret');
  } finally { await f.cleanup(); }
});

test('final commands cannot mutate the frozen input or current project and still pass integration', async () => {
  const f = await fixture(undefined, undefined, accept + ";const fs=require('node:fs');if(fs.existsSync('user-only'))fs.writeFileSync('hello.txt','tampered')");
  try {
    await writeFile(join(f.source, 'user-only'), 'final-context');
    const job = await f.prepare();
    const result = await f.engine.execute(job.id, signal());
    assert.equal(result.phase, 'blocked'); assert.equal(result.reason, 'INTEGRATION_CHANGED');
    assert.equal(result.validation[0]!.exitCode, 0);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'candidate');
    assert.equal(await readFile(join(result.integrated!.workspace, 'hello.txt'), 'utf8'), 'candidate');
  } finally { await f.cleanup(); }
});

test('cross-database reservation refuses another integration without stealing or deleting its lock', async () => {
  const f = await fixture();
  try {
    const job = await f.prepare();
    await crash(join(f.data, 'state.sqlite'), f.source, job.id, 'integration.effect_intent');
    const foreign = new Store(join(f.data, 'other.sqlite'));
    try {
      // A separate owner must not operate even with an otherwise valid copied plan.
      const other = { ...job, id: 'other-integration', directory: join(f.root, 'other-owned-directory') };
      foreign.integrations.create(other);
      const result = await new IntegrationEngine(foreign, f.source).execute(other.id, signal());
      assert.equal(result.phase, 'blocked'); assert.equal(result.reason, 'INTEGRATION_BUSY');
      assert.equal(JSON.parse(await readFile(job.reservation, 'utf8')).id, job.id);
      assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'original');
    } finally { foreign.close(); }
    assert.equal((await f.engine.execute(job.id, signal())).phase, 'succeeded');
  } finally { await f.cleanup(); }
});
