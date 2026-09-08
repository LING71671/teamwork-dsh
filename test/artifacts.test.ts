import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, unlink, rename, symlink, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '../src/client.js';
import { Store } from '../src/store.js';
import { treeDigest } from '../src/workspace.js';
import { artifactPath, compareManifests } from '../src/artifacts.js';
import { FakeExecutor, setup, report, waitFor } from './helpers.js';

async function submission(f: Awaited<ReturnType<typeof setup>>, fake: FakeExecutor, mutate?: (workspace: string) => Promise<void>) {
  const run = await f.client.start({ commandId: 'start', objective: 'Fix' });
  const attempt = await waitFor(() => fake.instances[0]);
  if (mutate) await mutate(attempt.order.workspace);
  await new Client(attempt.bridge.url, attempt.bridge.token).bridge(attempt.order.attemptId, 'submit', {
    commandId: 'submit', epoch: attempt.order.epoch, inputDigest: attempt.order.inputDigest, report,
  });
  attempt.finish();
  return waitFor(() => { const r = f.store.get(run.id); return r.phase === 'submitted' ? r : undefined; });
}

test('registered baseline preserves original dirty files, excludes secrets and exposes exact candidate changes', async () => {
  const fake = new FakeExecutor(), f = await setup(fake);
  try {
    await writeFile(join(f.source, 'deleted.txt'), 'delete this');
    await writeFile(join(f.source, 'same.txt'), 'unchanged dirty content');
    await writeFile(join(f.source, '.env'), 'fixture-only-never-expose');
    await mkdir(join(f.source, 'was-directory'));
    const settled = await submission(f, fake, async workspace => {
      await writeFile(join(workspace, 'hello.txt'), 'fixed');
      await unlink(join(workspace, 'deleted.txt'));
      await rm(join(workspace, 'was-directory'), { recursive: true });
      await writeFile(join(workspace, 'was-directory'), 'now a file');
      await writeFile(join(workspace, '新增.txt'), '你好');
    });
    assert.ok(settled.baseline?.artifactId);
    assert.ok(settled.candidate?.artifactId);
    assert.notEqual(settled.baseline.artifactId, settled.candidate.artifactId);
    assert.equal(settled.order.inputTreeDigest, settled.baseline.digest);
    assert.notEqual(settled.order.inputTreeDigest, settled.candidate.digest);
    assert.equal(settled.gate, 'not_evaluated');
    await writeFile(join(f.source, 'hello.txt'), 'later user edit');
    const baseline = await f.client.artifact(settled.id, settled.baseline.artifactId);
    assert.equal(baseline.entries.some(e => e.path === '.env'), false);
    assert.equal((await f.client.artifactFile(settled.id, settled.baseline.artifactId, 'hello.txt')).content, 'original');
    assert.equal((await f.client.artifactFile(settled.id, settled.baseline.artifactId, 'same.txt')).content, 'unchanged dirty content');
    await assert.rejects(f.client.artifactFile(settled.id, settled.baseline.artifactId, '.env'), { code: 'NOT_FOUND' });
    const changes = await f.client.changes(settled.id);
    assert.equal(changes.baseline.id, settled.baseline.artifactId);
    assert.equal(changes.candidate.id, settled.candidate.artifactId);
    assert.deepEqual(changes.changes.map(c => [c.path, c.kind]), [
      ['deleted.txt', 'deleted'], ['hello.txt', 'modified'], ['was-directory', 'type_changed'], ['新增.txt', 'added'],
    ]);
    const first = await f.client.changes(settled.id, settled.candidate.artifactId, 0, 1);
    assert.equal(first.total, 4); assert.equal(first.nextOffset, 1);
    const rest = await f.client.changes(settled.id, settled.candidate.artifactId, first.nextOffset!, 500);
    assert.equal(rest.changes.length, 3); assert.equal(rest.nextOffset, null);
    const artifacts = await f.client.artifacts(settled.id);
    assert.equal(artifacts.artifacts.length, 2);
    assert.equal(JSON.stringify(artifacts).includes('workspace'), false);
    assert.equal(JSON.stringify(changes).includes(f.root), false);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'later user edit');
  } finally { await f.cleanup(); }
});

test('manifest and file pagination are bounded and preserve binary and UTF-8 byte content', async () => {
  const fake = new FakeExecutor(), f = await setup(fake);
  try {
    const content = Buffer.concat([Buffer.from('你好\n'), Buffer.alloc(80_000, 0x61)]);
    const settled = await submission(f, fake, async workspace => {
      await writeFile(join(workspace, 'large.txt'), content);
      await writeFile(join(workspace, 'binary.dat'), Buffer.from([0, 0xff, 1, 2]));
      await writeFile(join(workspace, 'empty.txt'), '');
      await mkdir(join(workspace, 'empty-dir'));
    });
    const id = settled.candidate!.artifactId!;
    const first = await f.client.artifact(settled.id, id, 0, 1);
    assert.equal(first.entries.length, 1); assert.equal(first.total, 5); assert.equal(first.nextOffset, 1);
    const rest = await f.client.artifact(settled.id, id, 1, 500);
    assert.equal(rest.entries.length, 4); assert.equal(rest.nextOffset, null);
    const page1 = await f.client.artifactFile(settled.id, id, 'large.txt', 0, 65_536);
    assert.equal(page1.bytes, 65_536); assert.equal(page1.encoding, 'utf8');
    const page2 = await f.client.artifactFile(settled.id, id, 'large.txt', page1.nextOffset!, 65_536);
    assert.equal(page2.nextOffset, null);
    assert.deepEqual(Buffer.concat([Buffer.from(page1.content), Buffer.from(page2.content)]), content);
    const splitUnicode = await f.client.artifactFile(settled.id, id, 'large.txt', 1, 1);
    assert.equal(splitUnicode.encoding, 'base64');
    assert.deepEqual(Buffer.from(splitUnicode.content, 'base64'), content.subarray(1, 2));
    const binary = await f.client.artifactFile(settled.id, id, 'binary.dat');
    assert.equal(binary.encoding, 'base64'); assert.deepEqual(Buffer.from(binary.content, 'base64'), Buffer.from([0, 0xff, 1, 2]));
    const empty = await f.client.artifactFile(settled.id, id, 'empty.txt');
    assert.equal(empty.bytes, 0); assert.equal(empty.nextOffset, null);
    const eof = await f.client.artifactFile(settled.id, id, 'large.txt', content.length);
    assert.equal(eof.bytes, 0); assert.equal(eof.nextOffset, null);
    await assert.rejects(f.client.artifactFile(settled.id, id, 'large.txt', content.length + 1), { code: 'OFFSET_RANGE' });
    await assert.rejects(f.client.artifactFile(settled.id, id, 'large.txt', 0, 65_537), { code: 'SCHEMA_INVALID' });
    await assert.rejects(f.client.artifactFile(settled.id, id, 'empty-dir'), { code: 'ARTIFACT_NOT_FILE' });
    await assert.rejects(f.client.artifact(settled.id, id, -1), { code: 'SCHEMA_INVALID' });
    const list1 = await f.client.artifacts(settled.id, 0, 1);
    const list2 = await f.client.artifacts(settled.id, list1.nextOffset!, 1);
    assert.notEqual(list1.artifacts[0]!.id, list2.artifacts[0]!.id); assert.equal(list2.nextOffset, null);
  } finally { await f.cleanup(); }
});

test('artifact APIs reject worker credentials, cross-run references, unknown registrations and arbitrary paths', async () => {
  const fake = new FakeExecutor(), f = await setup(fake);
  try {
    const settled = await submission(f, fake);
    const id = settled.candidate!.artifactId!;
    const worker = new Client(fake.instances[0]!.bridge.url, fake.instances[0]!.bridge.token);
    await assert.rejects(worker.artifacts(settled.id), { code: 'UNAUTHORIZED' });
    await assert.rejects(worker.artifactFile(settled.id, id, 'hello.txt'), { code: 'UNAUTHORIZED' });
    const other = f.store.start({ commandId: 'other', objective: 'Other' }, f.data, {});
    await assert.rejects(f.client.artifact(other.id, id), { code: 'NOT_FOUND' });
    await assert.rejects(f.client.artifact(settled.id, 'not-registered'), { code: 'NOT_FOUND' });
    await assert.rejects(f.client.changes(other.id), { code: 'BASELINE_MISSING' });
    await assert.rejects(f.client.changes(settled.id, settled.baseline!.artifactId!), { code: 'ARTIFACT_KIND' });
    for (const path of ['../outside', '/absolute', 'C:/Windows/file', 'hello.txt:stream', 'dir\\file', 'dir//file', './hello.txt', 'dir/../hello.txt', 'hello.txt.', 'hello.txt ', 'CON', 'NUL.txt', 'x\u0000y']) {
      await assert.rejects(f.client.artifactFile(settled.id, id, path), { code: 'ARTIFACT_PATH' });
    }
    const response = await fetch(`${f.server.url}/v1/runs/${settled.id}/artifacts/${id}?offset=0&offset=1`, { headers: { authorization: `Bearer ${f.token}` } });
    assert.equal(response.status, 400);
    const browser = await fetch(`${f.server.url}/v1/runs/${settled.id}/artifacts`, { headers: { authorization: `Bearer ${f.token}`, origin: 'https://example.org' } });
    assert.equal(browser.status, 403);
  } finally { await f.cleanup(); }
});

for (const mutation of ['file', 'root-link', 'child-link', 'missing'] as const) test(`registered artifact rejects ${mutation} mutation before returning content`, async () => {
  const fake = new FakeExecutor(), f = await setup(fake);
  try {
    const settled = await submission(f, fake);
    const candidate = settled.candidate!;
    if (mutation === 'file') await writeFile(join(candidate.workspace, 'hello.txt'), 'tampered');
    else if (mutation === 'missing') await rename(candidate.workspace, candidate.workspace + '-moved');
    else {
      const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'hello.txt'), 'not authorized');
      if (mutation === 'root-link') {
        await rename(candidate.workspace, candidate.workspace + '-saved');
        await symlink(outside, candidate.workspace, 'junction');
      } else await symlink(outside, join(candidate.workspace, 'redirect'), 'junction');
    }
    await assert.rejects(f.client.artifactFile(settled.id, candidate.artifactId!, 'hello.txt'), {
      code: mutation === 'file' ? 'ARTIFACT_CHANGED' : mutation === 'missing' ? 'ARTIFACT_MISSING' : 'WORKSPACE_SYMLINK',
    });
    await assert.rejects(f.client.changes(settled.id));
  } finally { await f.cleanup(); }
});

test('artifact registrations and baseline identity survive reopen; original baseline cannot be replaced', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'teamwork-artifact-store-')));
  let store = new Store(join(root, 'state.sqlite'));
  try {
    const run = store.start({ commandId: 'start', objective: 'Fix' }, root, {});
    store.claim(run.id, 'fixture-token');
    const candidate = { workspace: root, digest: 'a'.repeat(64) };
    const bound = store.recordBaseline(run.id, candidate);
    assert.throws(() => store.recordBaseline(run.id, candidate), { code: 'BASELINE_EXISTS' });
    const artifacts = store.artifacts(run.id);
    assert.equal(artifacts.artifacts[0]!.id, bound.baseline!.artifactId);
    store.close(); store = new Store(join(root, 'state.sqlite'));
    assert.deepEqual(store.artifacts(run.id), artifacts);
    assert.equal(store.artifact(run.id, bound.baseline!.artifactId!).workspace, root);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('manifest digest stays compatible and change detection includes executable-bit-only edits', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'teamwork-artifact-digest-')));
  try {
    assert.equal(await treeDigest(root, new AbortController().signal), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    const before = { digest: 'a', bytes: 1, entries: [{ path: 'run', kind: 'file' as const, size: 1, executable: 0, digest: 'x' }] };
    const after = { ...before, entries: [{ ...before.entries[0]!, executable: 0o111 }] };
    assert.equal(compareManifests(before, after)[0]!.kind, 'modified');
    assert.equal(artifactPath('nested/你好.txt'), 'nested/你好.txt');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('attempt input binding is immutable and changes the bridge digest before dispatch', () => {
  const store = new Store(':memory:');
  try {
    const run = store.start({ commandId: 'start', objective: 'Fix' }, process.cwd(), {});
    store.claim(run.id, 'fixture-token');
    const bound = store.bindInput(run.id, 'a'.repeat(64));
    assert.equal(bound.order.inputTreeDigest, 'a'.repeat(64));
    assert.notEqual(bound.order.inputDigest, run.order.inputDigest);
    assert.deepEqual(store.bindInput(run.id, 'a'.repeat(64)), bound);
    assert.throws(() => store.bindInput(run.id, 'b'.repeat(64)), { code: 'INPUT_ALREADY_BOUND' });
    store.move(run.id, 'running');
    assert.throws(() => store.bridge(run.order.attemptId, 'fixture-token', 'submit', {
      commandId: 'old', epoch: 1, inputDigest: run.order.inputDigest, report,
    }), { code: 'RESULT_STALE' });
    store.bridge(run.order.attemptId, 'fixture-token', 'submit', { commandId: 'bound', epoch: 1, inputDigest: bound.order.inputDigest, report });
  } finally { store.close(); }
});
