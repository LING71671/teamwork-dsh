import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, rm, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { TreeEntry, TreeManifest } from '../src/contracts.js';
import { planIntegration } from '../src/integration.js';
import { sourceManifest, snapshot, treeManifest } from '../src/workspace.js';
import { Client } from '../src/client.js';
import { FakeExecutor, setup, report, waitFor } from './helpers.js';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const file = (path: string, text = path, executable = 0): TreeEntry => ({ path, kind: 'file', size: Buffer.byteLength(text), digest: hash(text), executable });
const dir = (path: string): TreeEntry => ({ path, kind: 'directory' });
const manifest = (...entries: TreeEntry[]): TreeManifest => ({ digest: hash(JSON.stringify(entries)), entries,
  bytes: entries.reduce((n, entry) => n + (entry.kind === 'file' ? entry.size : 0), 0) });

test('three-way planner preserves unrelated user edits and identifies identical already-applied changes', () => {
  const baseline = manifest(file('a', 'old'), file('keep', 'old'), file('gone'));
  const candidate = manifest(file('a', 'new'), file('keep', 'old'), file('added'));
  const target = manifest(file('a', 'old'), file('keep', 'user edit'), file('gone'), file('user-only'));
  const plan = planIntegration(baseline, candidate, target);
  assert.equal(plan.status, 'clear');
  assert.deepEqual(plan.changes.map(c => [c.path, c.disposition]), [['a', 'apply'], ['added', 'apply'], ['gone', 'apply']]);
  const applied = manifest(file('a', 'new'), file('keep', 'user edit'), file('added'), file('user-only'));
  const repeat = planIntegration(baseline, candidate, applied);
  assert.equal(repeat.status, 'clear');
  assert.ok(repeat.changes.every(c => c.disposition === 'already_applied'));
  assert.notEqual(plan.id, repeat.id);
  assert.equal(plan.id, planIntegration({ ...baseline, entries: [...baseline.entries].reverse() }, candidate, target).id);
});

for (const kind of ['modified', 'deleted', 'added', 'mode'] as const) test(`three-way planner rejects a concurrent ${kind} conflict`, () => {
  const baseline = kind === 'added' ? manifest() : manifest(file('a', 'old'));
  const candidate = kind === 'deleted' ? manifest() : manifest(file('a', 'new', kind === 'mode' ? 0o111 : 0));
  const target = manifest(file('a', 'user', kind === 'mode' ? 0o100 : 0));
  const plan = planIntegration(baseline, candidate, target);
  assert.equal(plan.status, 'conflicts');
  assert.deepEqual(plan.changes[0]!.reasons, ['concurrent_change']);
});

test('planner treats executable-only edits as changes and preserves concurrent modes', () => {
  const b = manifest(file('run', 'same', 0)), c = manifest(file('run', 'same', 0o111));
  assert.equal(planIntegration(b, c, b).changes[0]!.disposition, 'apply');
  assert.equal(planIntegration(b, c, c).changes[0]!.disposition, 'already_applied');
  assert.equal(planIntegration(b, c, manifest(file('run', 'same', 0o100))).status, 'conflicts');
});

test('directory removal/type replacement blocks new, changed and protected descendants', () => {
  const baseline = manifest(dir('folder'), dir('folder/sub'), file('folder/sub/a'));
  for (const candidate of [manifest(), manifest(file('folder', 'replacement'))]) {
    const safe = planIntegration(baseline, candidate, baseline);
    assert.equal(safe.status, 'clear');
    for (const target of [manifest(...baseline.entries, file('folder/user')), manifest(dir('folder'), dir('folder/sub'), file('folder/sub/a', 'user'))]) {
      const plan = planIntegration(baseline, candidate, target);
      assert.equal(plan.status, 'conflicts');
      assert.ok(plan.changes.find(c => c.path === 'folder')!.reasons.includes('descendant_changed'));
    }
    const protectedPlan = planIntegration(baseline, candidate, baseline, ['folder/sub/.env', 'folder/node_modules']);
    assert.ok(protectedPlan.changes.find(c => c.path === 'folder')!.reasons.includes('protected_path'));
    assert.notEqual(protectedPlan.id, safe.id);
  }
});

test('parent creation and file-to-directory replacement work only against expected ancestors', () => {
  const baseline = manifest(file('a', 'old'));
  const candidate = manifest(dir('a'), dir('a/sub'), file('a/sub/new'));
  assert.equal(planIntegration(baseline, candidate, baseline).status, 'clear');
  const conflict = planIntegration(baseline, candidate, manifest(file('a', 'user')));
  assert.equal(conflict.status, 'conflicts');
  assert.ok(conflict.changes.find(c => c.path === 'a/sub/new')!.reasons.includes('ancestor_changed'));
  const oldDir = manifest(dir('a'), file('a/old'));
  const addedChild = manifest(...oldDir.entries, file('a/new'));
  assert.ok(planIntegration(oldDir, addedChild, manifest()).changes[0]!.reasons.includes('ancestor_changed'));
  assert.ok(planIntegration(oldDir, addedChild, manifest(file('a', 'user'))).changes[0]!.reasons.includes('ancestor_changed'));
});

test('directory additions preserve independent children and already-applied subtree replacement is recognized', () => {
  const baseline = manifest(), candidate = manifest(dir('a'), file('a/new'));
  const plan = planIntegration(baseline, candidate, manifest(dir('a'), file('a/user')));
  assert.equal(plan.status, 'clear');
  assert.deepEqual(plan.changes.map(c => c.disposition), ['already_applied', 'apply']);
  const old = manifest(dir('a'), file('a/old')), next = manifest(file('a', 'replaced'));
  const repeated = planIntegration(old, next, next);
  assert.equal(repeated.status, 'clear');
  assert.ok(repeated.changes.every(c => c.disposition === 'already_applied'));
});

test('portable integration refuses aliases, protected paths and malformed manifests', () => {
  for (const pair of [['Readme', 'README'], ['é', 'e\u0301']]) {
    const plan = planIntegration(manifest(file(pair[0]!)), manifest(file(pair[1]!)), manifest(file(pair[0]!)));
    assert.equal(plan.status, 'conflicts');
    assert.ok(plan.changes.every(c => c.reasons.includes('path_alias')));
  }
  const parentAlias = planIntegration(manifest(), manifest(dir('src'), file('src/new')), manifest(dir('SRC')));
  assert.ok(parentAlias.changes.every(c => c.reasons.includes('path_alias')));
  for (const name of ['.env', '.ENV.production', '.git', '.NPMRC', 'node_modules', '.teamwork']) {
    const plan = planIntegration(manifest(), manifest(dir('nested'), file(`nested/${name}`)), manifest());
    assert.ok(plan.changes.find(c => c.path === `nested/${name}`)!.reasons.includes('protected_path'));
  }
  for (const path of ['../escape', 'x:stream', 'a\\b', 'CON', 'a?', 'a*', 'a|', 'a<', 'a"', 'a.']) {
    assert.throws(() => planIntegration(manifest(), manifest(file(path)), manifest()));
  }
  assert.throws(() => planIntegration(manifest(), manifest(file('missing/child')), manifest()), { code: 'INTEGRATION_TREE' });
  assert.throws(() => planIntegration(manifest(), manifest(file('same'), file('same')), manifest()), { code: 'INTEGRATION_PATH' });
});

async function submitted(f: Awaited<ReturnType<typeof setup>>, fake: FakeExecutor, mutate: (workspace: string) => Promise<void>) {
  const run = await f.client.start({ commandId: 'start', objective: 'Fix' });
  const attempt = await waitFor(() => fake.instances[0]);
  await mutate(attempt.order.workspace);
  await new Client(attempt.bridge.url, attempt.bridge.token).bridge(attempt.order.attemptId, 'submit', {
    commandId: 'submit', epoch: attempt.order.epoch, inputDigest: attempt.order.inputDigest, report,
  });
  attempt.finish();
  return waitFor(() => { const current = f.store.get(run.id); return current.phase === 'submitted' ? current : undefined; });
}

test('source manifest matches snapshot filtering and tracks opaque excluded barriers without reading them', async () => {
  const f = await setup();
  try {
    await mkdir(join(f.source, 'nested'));
    await writeFile(join(f.source, 'nested', '.ENV.local'), 'fixture-secret');
    await writeFile(join(f.source, '.NPMRC'), 'fixture-private');
    await symlink(f.data, join(f.source, 'node_modules'), 'junction');
    const signal = new AbortController().signal;
    const inspected = await sourceManifest(f.source, signal);
    assert.deepEqual(inspected.protectedPaths.sort(), ['.NPMRC', 'nested/.ENV.local', 'node_modules']);
    const copy = join(f.data, 'copied'); await snapshot(f.source, copy, signal);
    assert.deepEqual(inspected.manifest, await treeManifest(copy, signal));
    await symlink(f.data, join(f.source, 'ordinary-link'), 'junction');
    await assert.rejects(sourceManifest(f.source, signal), { code: 'WORKSPACE_SYMLINK' });
  } finally { await f.cleanup(); }
});

test('HTTP integration preview is read-only, paginated, bound to source/candidate and rejects stale pages', async () => {
  const fake = new FakeExecutor(), f = await setup(fake);
  try {
    const run = await submitted(f, fake, async workspace => {
      await writeFile(join(workspace, 'hello.txt'), 'candidate');
      await writeFile(join(workspace, 'added.txt'), 'new');
    });
    await writeFile(join(f.source, 'hello.txt'), 'user edit');
    await writeFile(join(f.source, 'unrelated'), 'preserve');
    const revision = f.store.get(run.id).revision;
    const first = await f.client.previewIntegration(run.id, undefined, 0, 1);
    assert.equal(first.readOnly, true); assert.equal(first.candidateVerified, false);
    assert.equal(first.status, 'conflicts'); assert.equal(first.conflictCount, 1);
    assert.equal(first.total, 2); assert.equal(first.nextOffset, 1);
    assert.equal(first.changes[0]!.path, 'added.txt');
    const last = await f.client.previewIntegration(run.id, first.candidate.id, 1, 1, first.id);
    assert.equal(last.nextOffset, null); assert.equal(last.id, first.id);
    assert.deepEqual(last.changes[0]!.reasons, ['concurrent_change']);
    assert.equal(JSON.stringify(first).includes(f.root), false);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'user edit');
    assert.equal(await readFile(join(f.source, 'unrelated'), 'utf8'), 'preserve');
    assert.equal(f.store.get(run.id).revision, revision);
    await writeFile(join(f.source, 'unrelated'), 'changed again');
    await assert.rejects(f.client.previewIntegration(run.id, first.candidate.id, 1, 1, first.id), { code: 'INTEGRATION_PLAN_STALE' });
    const refreshed = await f.client.previewIntegration(run.id);
    assert.notEqual(refreshed.id, first.id);
    const worker = new Client(fake.instances[0]!.bridge.url, fake.instances[0]!.bridge.token);
    await assert.rejects(worker.previewIntegration(run.id), { code: 'UNAUTHORIZED' });
    await assert.rejects(f.client.previewIntegration(run.id, run.baseline!.artifactId!), { code: 'ARTIFACT_KIND' });
    await assert.rejects(f.client.previewIntegration(run.id, 'unknown'), { code: 'NOT_FOUND' });
    await assert.rejects(f.client.previewIntegration(run.id, undefined, 0, 501), { code: 'SCHEMA_INVALID' });
    const other = f.store.start({ commandId: 'other', objective: 'Other' }, f.data, {});
    f.store.claim(other.id, 'fixture-token'); f.store.recordBaseline(other.id, run.baseline!);
    await assert.rejects(f.client.previewIntegration(other.id, run.candidate!.artifactId!), { code: 'NOT_FOUND' });
    const headers = { authorization: `Bearer ${f.token}` };
    for (const suffix of ['?path=C:/arbitrary', '?offset=0&offset=1', '?planId=invalid']) {
      assert.equal((await fetch(`${f.server.url}/v1/runs/${run.id}/integration-preview${suffix}`, { headers })).status, 400);
    }
    assert.equal((await fetch(`${f.server.url}/v1/runs/${run.id}/integration-preview`, { method: 'POST', headers })).status, 404);
  } finally { await f.cleanup(); }
});

test('preview protects excluded descendants and does not leak secret contents', async () => {
  const fake = new FakeExecutor(), f = await setup(fake);
  try {
    await mkdir(join(f.source, 'folder'));
    await writeFile(join(f.source, 'folder', '.env'), 'fixture-secret-never-expose');
    const run = await submitted(f, fake, async workspace => { await rm(join(workspace, 'folder'), { recursive: true }); });
    const preview = await f.client.previewIntegration(run.id);
    assert.equal(preview.status, 'conflicts');
    assert.deepEqual(preview.changes[0]!.reasons, ['protected_path']);
    assert.equal(JSON.stringify(preview).includes('fixture-secret-never-expose'), false);
    assert.equal(await readFile(join(f.source, 'folder', '.env'), 'utf8'), 'fixture-secret-never-expose');
  } finally { await f.cleanup(); }
});

for (const kind of ['baseline', 'candidate', 'source-link'] as const) test(`preview rejects ${kind} integrity failure`, async () => {
  const fake = new FakeExecutor(), f = await setup(fake);
  try {
    const run = await submitted(f, fake, async workspace => { await writeFile(join(workspace, 'hello.txt'), 'candidate'); });
    if (kind === 'source-link') {
      await rename(f.source, f.source + '-saved');
      await symlink(f.source + '-saved', f.source, 'junction');
    } else await writeFile(join(run[kind]!.workspace, 'hello.txt'), 'tampered');
    await assert.rejects(f.client.previewIntegration(run.id), { code: kind === 'source-link' ? 'WORKSPACE_SYMLINK' : 'ARTIFACT_CHANGED' });
  } finally { await f.cleanup(); }
});
