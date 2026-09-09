import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '../src/client.js';
import { startSchema, type RunSpec, type TreeManifest, type Report } from '../src/contracts.js';
import { compareManifests } from '../src/artifacts.js';
import { scopeViolations } from '../src/scope.js';
import { evaluateGate } from '../src/kernel.js';
import { IntegrationEngine } from '../src/integration-engine.js';
import { FakeExecutor, setup, waitFor, report } from './helpers.js';

const spec: RunSpec = { requirements: [{ id: 'fix', text: 'hello.txt contains fixed' }], writeScope: { files: ['hello.txt'], trees: [] } };
const policy = { commands: [{ id: 'accept', executable: process.execPath,
  args: ['-e', "require('node:assert').equal(require('node:fs').readFileSync('hello.txt','utf8'),'fixed')"], timeoutMs: 5000 }] };
const approval: Report = { ...report, review: { functionality: 'pass', completeness: 'pass', findings: [],
  requirements: [{ id: 'fix', verdict: 'pass', evidence: 'hello.txt contains the requested fixed content.' }] } };
async function submit(attempt: FakeExecutor['instances'][number], result: Report = report) {
  await new Client(attempt.bridge.url, attempt.bridge.token).bridge(attempt.order.attemptId, 'submit', {
    commandId: 'submit', epoch: attempt.order.epoch, inputDigest: attempt.order.inputDigest, report: result });
  attempt.finish();
}
const tree = (files: Record<string, string>, directories: string[] = []): TreeManifest => ({ digest: 'synthetic', bytes: 0,
  entries: [...directories.map(path => ({ path, kind: 'directory' as const })),
    ...Object.entries(files).map(([path, digest]) => ({ path, kind: 'file' as const, digest, size: 1, executable: 0 }))] });

test('RunSpec rejects unsafe/glob paths, unknown policies, duplicate IDs and oversized requirements', () => {
  const parse = (value: unknown) => startSchema.safeParse({ commandId: 'start', objective: 'Fix', spec: value }).success;
  assert.equal(parse(spec), true);
  for (const path of ['', '/', '../x', 'a//b', 'a/./b', 'C:/x', 'x:stream', 'dir\\x', 'NUL', 'a.', 'a ', 'a*', '**/*.ts', 'e\u0301.txt']) {
    assert.equal(parse({ ...spec, writeScope: { files: [path], trees: [] } }), false, path);
  }
  assert.equal(parse({ ...spec, requirements: [spec.requirements[0], spec.requirements[0]] }), false);
  assert.equal(parse({ ...spec, requirements: Array.from({ length: 17 }, (_, i) => ({ id: `r${i}`, text: 'x'.repeat(2000) })) }), false);
  assert.equal(parse({ ...spec, budget: { maxTokens: 1 } }), false); // Unsupported policies must not be silently accepted.
  assert.equal(parse({ ...spec, writeScope: { files: [], trees: ['.'] } }), true);
  assert.equal(parse({ ...spec, writeScope: { files: [], trees: [] } }), true); // Explicit read-only delta.
});

test('scope compares deletes, type and mode changes; literal trees never match siblings or replace exact-file parents', () => {
  const baseline = tree({ 'src/a': 'a', 'src-other/b': 'b', 'keep': 'k' }, ['src', 'src-other']);
  const candidate = tree({ 'src/a': 'changed', 'src-other/b': 'changed', 'src/new/file': 'new', 'keep': 'k' }, ['src', 'src-other', 'src/new']);
  const changes = compareManifests(baseline, candidate);
  assert.deepEqual(scopeViolations({ files: [], trees: ['src'] }, changes, baseline, candidate), ['src-other/b']);
  assert.deepEqual(scopeViolations({ files: ['src/a', 'src/new/file'], trees: [] }, changes, baseline, candidate), ['src-other/b']);
  const replaced = tree({ 'src': 'replacement', 'src-other/b': 'b', 'keep': 'k' }, ['src-other']);
  assert.deepEqual(scopeViolations({ files: ['src', 'src/a'], trees: [] }, compareManifests(baseline, replaced), baseline, replaced), ['src']);
  const mode = structuredClone(baseline);
  const entry = mode.entries.find(item => item.path === 'keep')!;
  assert.equal(entry.kind, 'file'); if (entry.kind === 'file') entry.executable = 0o111;
  assert.deepEqual(scopeViolations({ files: [], trees: ['src'] }, compareManifests(baseline, mode), baseline, mode), ['keep']);
  const deleted = tree({ 'src/a': 'a', 'src-other/b': 'b' }, ['src', 'src-other']);
  assert.deepEqual(scopeViolations({ files: [], trees: ['src'] }, compareManifests(baseline, deleted), baseline, deleted), ['keep']);
});

test('scope denies case/Unicode aliases and unauthorized empty directories, including under broad grants', () => {
  const baseline = tree({ 'Hello.txt': 'a', 'é.txt': 'b' }), candidate = tree({ 'Hello.txt': 'a', 'hello.txt': 'a', 'e\u0301.txt': 'b' }, ['unrelated']);
  const violations = scopeViolations({ files: [], trees: ['.'] }, compareManifests(baseline, candidate), baseline, candidate);
  assert.ok(violations.includes('hello.txt')); assert.ok(violations.includes('e\u0301.txt')); assert.ok(violations.includes('é.txt'));
  assert.deepEqual(scopeViolations(spec.writeScope, compareManifests(tree({}), tree({}, ['unrelated'])), tree({}), tree({}, ['unrelated'])), ['unrelated']);
});

for (const kind of ['modify', 'delete', 'replace-parent', 'pause', 'without-verification'] as const) test(`out-of-scope ${kind} is refused before accepted candidate or review, without modifying the source`, async () => {
  const fake = new FakeExecutor(), f = await setup(fake, 5000, kind === 'without-verification' ? undefined : policy, kind !== 'without-verification');
  try {
    await mkdir(join(f.source, 'other'));
    await writeFile(join(f.source, 'other', 'keep'), 'user content');
    const run = await f.client.start({ commandId: 'start', objective: 'Fix', spec });
    const worker = await waitFor(() => fake.instances[0]);
    assert.deepEqual(worker.order.spec, spec);
    await writeFile(join(worker.order.workspace, 'hello.txt'), 'fixed');
    if (kind === 'replace-parent') {
      await rm(join(worker.order.workspace, 'other', 'keep'));
      await rm(join(worker.order.workspace, 'other'), { recursive: true });
      await writeFile(join(worker.order.workspace, 'other'), 'replacement');
    } else if (kind === 'delete') await rm(join(worker.order.workspace, 'other', 'keep'));
    else await writeFile(join(worker.order.workspace, 'other', 'keep'), 'unauthorized');
    if (kind === 'pause') await f.client.control(run.id, { commandId: 'pause', type: 'pause', mode: 'interrupt', expectedRevision: f.store.get(run.id).revision });
    else await submit(worker);
    const failed = await waitFor(() => { const r = f.store.get(run.id); return r.phase === 'failed' ? r : undefined; });
    assert.equal(failed.reason, 'SCOPE_VIOLATION'); assert.notEqual(failed.gate, 'passed');
    assert.ok(failed.scopeCheck?.violations.includes('other/keep')); assert.equal(fake.instances.length, 1);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'original');
    assert.equal(await readFile(join(f.source, 'other', 'keep'), 'utf8'), 'user content');
  } finally { await f.cleanup(); }
});

for (const kind of ['missing', 'duplicate', 'unknown', 'fail', 'pass'] as const) test(`independent per-requirement Gate evidence: ${kind}`, async () => {
  const fake = new FakeExecutor(), f = await setup(fake, 5000, { ...policy, maxIterations: 2 }, true);
  try {
    const input = { commandId: 'start', objective: 'Fix', spec };
    const run = await f.client.start(input);
    assert.deepEqual(await f.client.start(input), run);
    await assert.rejects(f.client.start({ ...input, spec: { ...spec, writeScope: { files: [], trees: ['.'] } } }), { code: 'IDEMPOTENCY_CONFLICT' });
    const worker = await waitFor(() => fake.instances[0]);
    await writeFile(join(worker.order.workspace, 'hello.txt'), 'fixed'); await submit(worker);
    const reviewer = await waitFor(() => fake.instances[1]);
    assert.deepEqual(reviewer.order.spec, spec);
    const result = structuredClone(approval);
    const requirements = result.review!.requirements!;
    if (kind === 'missing') delete result.review!.requirements;
    if (kind === 'duplicate') requirements.push(requirements[0]!);
    if (kind === 'unknown') requirements[0]!.id = 'unknown';
    if (kind === 'fail') requirements[0]!.verdict = 'fail';
    await submit(reviewer, result);
    if (kind === 'fail') {
      const repair = await waitFor(() => fake.instances[2]);
      assert.deepEqual(repair.order.spec, spec); assert.equal(repair.order.epoch, 2);
      assert.ok(f.store.get(run.id).history?.[0]?.gateReasons?.includes('REQUIREMENT_REJECTED'));
      assert.deepEqual(f.store.get(run.id).history?.[0]?.scopeCheck?.violations, []);
      await submit(repair); await submit(await waitFor(() => fake.instances[3]), approval);
    }
    const final = await waitFor(() => { const r = f.store.get(run.id); return ['verified', 'rejected', 'failed'].includes(r.phase) ? r : undefined; });
    if (kind === 'pass' || kind === 'fail') {
      assert.equal(final.phase, 'verified'); assert.deepEqual(final.scopeCheck?.violations, []);
      const { scopeCheck: _scopeCheck, ...withoutScope } = final;
      assert.ok(evaluateGate(withoutScope, true).includes('SCOPE_NOT_VERIFIED'));
      const altered = structuredClone(final); altered.reviewAttempt!.order.spec!.requirements[0]!.text = 'different';
      assert.ok(evaluateGate(altered, true).includes('REVIEW_STALE'));
      const preview = await f.client.previewIntegration(run.id);
      const integrated = await f.client.integrate(run.id, { commandId: 'integrate', type: 'integrate', expectedRevision: final.revision, planId: preview.id });
      await waitFor(() => f.store.integrations.get(integrated.id).phase === 'succeeded' ? true : undefined);
      assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'fixed');
    } else {
      assert.equal(final.phase, 'rejected'); assert.ok(final.gateReasons?.includes('REQUIREMENT_EVIDENCE_MISSING'));
      assert.equal(fake.instances.length, 2); // Missing/misattributed evidence is not an automatic retry.
    }
  } finally { await f.cleanup(); }
});

test('an explicit read-only scope permits unchanged report collection but never a changed candidate', async () => {
  const fake = new FakeExecutor(), f = await setup(fake);
  try {
    const run = await f.client.start({ commandId: 'start', objective: 'Inspect without changes', spec: { requirements: [], writeScope: { files: [], trees: [] } } });
    await submit(await waitFor(() => fake.instances[0]));
    const done = await waitFor(() => { const r = f.store.get(run.id); return r.phase === 'submitted' ? r : undefined; });
    assert.deepEqual(done.scopeCheck?.violations, []); assert.equal(done.scopeCheck?.baselineDigest, done.candidate?.digest);
    assert.equal(done.gate, 'not_evaluated');
  } finally { await f.cleanup(); }
});

test('integration independently rechecks scope even if a caller presents previously passed candidate evidence', async () => {
  const fake = new FakeExecutor(), f = await setup(fake, 5000, policy, true);
  const get = f.store.get.bind(f.store);
  try {
    const run = await f.client.start({ commandId: 'start', objective: 'Fix', spec });
    const worker = await waitFor(() => fake.instances[0]);
    await writeFile(join(worker.order.workspace, 'hello.txt'), 'fixed'); await submit(worker);
    await submit(await waitFor(() => fake.instances[1]), approval);
    const ready = await waitFor(() => { const r = get(run.id); return r.phase === 'verified' ? r : undefined; });
    const plan = await f.client.previewIntegration(run.id);
    // A synthetic store seam probes the integration invariant separately from Runtime's Gate checks.
    f.store.get = id => { const value = get(id); return { ...value, order: { ...value.order, spec: { ...spec, writeScope: { files: [], trees: [] } } } }; };
    await assert.rejects(new IntegrationEngine(f.store, f.source).prepare(run.id, ready.revision, plan.id, new AbortController().signal), { code: 'SCOPE_VIOLATION' });
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'original');
  } finally { f.store.get = get; await f.cleanup(); }
});
