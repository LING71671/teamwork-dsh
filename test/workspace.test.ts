import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { snapshot } from '../src/workspace.js';
import { acquire } from '../src/ownership.js';
import { Store } from '../src/store.js';

test('snapshot preserves dirty files, excludes known secret/dependency dirs and rejects overlap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamwork-copy-'));
  try {
    const source = join(root, 'source'), target = join(root, 'copy');
    await mkdir(source);
    await writeFile(join(source, 'dirty.txt'), 'uncommitted content');
    await writeFile(join(source, '.env'), 'not for the worker');
    await mkdir(join(source, 'node_modules'));
    await snapshot(source, target, new AbortController().signal);
    assert.deepEqual(await readdir(target), ['dirty.txt']);
    assert.equal(await readFile(join(target, 'dirty.txt'), 'utf8'), 'uncommitted content');
    await assert.rejects(snapshot(source, join(source, 'nested'), new AbortController().signal), { code: 'WORKSPACE_OVERLAP' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('snapshot does not follow junctions/symlinks outside the assigned source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamwork-link-'));
  try {
    const source = join(root, 'source'), external = join(root, 'external');
    await mkdir(source); await mkdir(external);
    await symlink(external, join(source, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(snapshot(source, join(root, 'copy'), new AbortController().signal), { code: 'WORKSPACE_SYMLINK' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a live runtime owner cannot be stolen; release permits a new owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamwork-owner-'));
  try {
    const release = await acquire(root);
    await assert.rejects(acquire(root), { code: 'RUNTIME_OWNED' });
    await release();
    await (await acquire(root))();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('SQLite reopen keeps command receipts and quarantines a claimed dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamwork-reopen-'));
  const db = join(root, 'state.sqlite');
  const command = { commandId: 'persistent', objective: 'fix' };
  let store = new Store(db);
  try {
    const run = store.start(command, join(root, 'attempts'), {});
    store.claim(run.id, 'private');
    store.close(); store = new Store(db);
    store.recover();
    assert.equal(store.get(run.id).phase, 'blocked');
    assert.equal(store.start(command, join(root, 'attempts'), {}).id, run.id);
    assert.equal(store.all().length, 1);
    assert.equal(store.events(run.id, 0).length, 3);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('snapshot refuses an existing target instead of overwriting files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamwork-target-'));
  try {
    const source = join(root, 'source'), target = join(root, 'target');
    await mkdir(source); await mkdir(target);
    await writeFile(join(source, 'file.txt'), 'new');
    await writeFile(join(target, 'file.txt'), 'preserve');
    await assert.rejects(snapshot(source, target, new AbortController().signal), { code: 'EEXIST' });
    assert.equal(await readFile(join(target, 'file.txt'), 'utf8'), 'preserve');
  } finally { await rm(root, { recursive: true, force: true }); }
});
