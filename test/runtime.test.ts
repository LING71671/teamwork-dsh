import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, FakeExecutor, report, waitFor } from './helpers.js';
import { Client } from '../src/client.js';

test('start is durable and asynchronous; submission waits for exit and never auto-integrates', async () => {
  const fake = new FakeExecutor(), f = await setup(fake);
  try {
    const run = await f.client.start({ commandId: 'start', objective: 'fix' });
    assert.equal(run.phase, 'queued');
    const attempt = await waitFor(() => fake.instances[0]);
    await writeFile(join(attempt.order.workspace, 'hello.txt'), 'changed');
    const worker = new Client(attempt.bridge.url, attempt.bridge.token);
    await worker.bridge(attempt.order.attemptId, 'submit', {
      commandId: 'submit', epoch: 1, inputDigest: attempt.order.inputDigest, report,
    });
    assert.equal(f.store.get(run.id).phase, 'running');
    attempt.finish();
    await waitFor(() => f.store.get(run.id).phase === 'submitted' ? true : undefined);
    assert.equal(attempt.closed, true);
    assert.equal(f.store.get(run.id).gate, 'not_evaluated');
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'original');
  } finally { await f.cleanup(); }
});

test('duplicate HTTP starts create only one writer; idle without report fails', async () => {
  const fake = new FakeExecutor(), f = await setup(fake);
  try {
    const input = { commandId: 'start', objective: 'fix' };
    const [a, b] = await Promise.all([f.client.start(input), f.client.start(input)]);
    assert.equal(a.id, b.id);
    const attempt = await waitFor(() => fake.instances[0]);
    assert.equal(fake.instances.length, 1);
    attempt.finish();
    await waitFor(() => f.store.get(a.id).phase === 'failed' ? true : undefined);
    assert.match(f.store.get(a.id).reason!, /RESULT_MISSING/);
  } finally { await f.cleanup(); }
});

test('cancelling one attempt does not close another', async () => {
  const fake = new FakeExecutor(), f = await setup(fake);
  try {
    const a = await f.client.start({ commandId: 'one', objective: 'one' });
    const b = await f.client.start({ commandId: 'two', objective: 'two' });
    await waitFor(() => fake.instances.length === 2 ? true : undefined);
    const current = await f.client.status(a.id);
    const response = await f.client.cancel(a.id, { commandId: 'cancel', expectedRevision: current.revision, type: 'cancel' });
    assert.equal(response.phase, 'stopping');
    await waitFor(() => f.store.get(a.id).phase === 'cancelled' ? true : undefined);
    assert.equal(fake.instances.find(i => i.order.runId === a.id)!.closed, true);
    assert.equal(fake.instances.find(i => i.order.runId === b.id)!.closed, false);
    assert.equal(f.store.get(b.id).phase, 'running');
  } finally { await f.cleanup(); }
});

test('unconfirmed close blocks rather than claiming cancellation', async () => {
  const fake = new FakeExecutor(), f = await setup(fake);
  try {
    const run = await f.client.start({ commandId: 'start', objective: 'fix' });
    await waitFor(() => fake.instances[0]);
    fake.failClose = true;
    await f.client.cancel(run.id, { commandId: 'cancel', type: 'cancel', expectedRevision: f.store.get(run.id).revision });
    await waitFor(() => f.store.get(run.id).phase === 'blocked' ? true : undefined);
    assert.match(f.store.get(run.id).reason!, /EXTERNAL_STATE_UNKNOWN/);
  } finally { await f.cleanup(); }
});

test('attempt timeout closes the execution and reports failure', async () => {
  const fake = new FakeExecutor(), f = await setup(fake, 100);
  try {
    const run = await f.client.start({ commandId: 'start', objective: 'fix' });
    const attempt = await waitFor(() => fake.instances[0]);
    await waitFor(() => f.store.get(run.id).phase === 'failed' ? true : undefined);
    assert.equal(attempt.closed, true);
    assert.equal(f.store.get(run.id).reason, 'ATTEMPT_TIMEOUT');
  } finally { await f.cleanup(); }
});

test('HTTP rejects credentials, Origin, malformed schema and unsupported controls', async () => {
  const f = await setup();
  try {
    const wrong = new Client(f.server.url, 'not-the-host');
    await assert.rejects(wrong.hello(), { code: 'UNAUTHORIZED' });
    let response = await fetch(f.server.url + '/v1/hello', { headers: { authorization: `Bearer ${f.token}`, origin: 'https://untrusted.example' } });
    assert.equal(response.status, 403);
    response = await fetch(f.server.url + '/v1/runs', { method: 'POST', headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ commandId: 'bad', objective: 'fix', workspace: 'C:/' }) });
    assert.equal(response.status, 400);
    const run = await f.client.start({ commandId: 'start', objective: 'fix' });
    response = await fetch(f.server.url + `/v1/runs/${run.id}/commands`, { method: 'POST', headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'unknown-control' }) });
    assert.equal(response.status, 422);
    const attempt = await waitFor(() => (f.executor as FakeExecutor).instances[0]);
    await assert.rejects(new Client(attempt.bridge.url, attempt.bridge.token).status(run.id), { code: 'UNAUTHORIZED' });
  } finally { await f.cleanup(); }
});

test('SSE replays persistent events after supplied cursor', async () => {
  const f = await setup();
  const abort = new AbortController();
  try {
    const run = await f.client.start({ commandId: 'start', objective: 'fix' });
    const first = f.store.events(run.id, 0)[0]!;
    const response = await fetch(f.server.url + `/v1/runs/${run.id}/events?after=${first.cursor}`, {
      headers: { authorization: `Bearer ${f.token}` }, signal: abort.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    assert.ok(!text.includes(`id: ${first.cursor}\n`));
    assert.match(text, /event: teamwork/);
    await reader.cancel();
  } finally { abort.abort(); await f.cleanup(); }
});
