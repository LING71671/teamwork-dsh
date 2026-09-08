import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DshExecutor, assertSuccessfulTurn, verifyDsh } from '../src/driver-dsh.js';
import { DeepSeekHarness, type RunResult } from '@deepseek-ai/dsh-sdk-client';
import { setup, waitFor } from './helpers.js';

test('SDK result rejects idle without turn/end, error and max-tokens outcomes', () => {
  for (const kind of ['error', 'max-tokens', 'aborted', undefined]) {
    const result = { events: kind ? [{ type: 'turn/end', data: { reason: { kind } } }] : [] } as unknown as RunResult;
    assert.throws(() => assertSuccessfulTurn(result), { code: 'DSH_TURN_UNSUCCESSFUL' });
  }
});

for (const verification of [false, true, 'repair', 'pause'] as const) test(`real DSH SDK + Cordis workers, offline provider, verification=${verification}`, { timeout: 90_000 }, async () => {
  const fixtureHome = await mkdtemp(join(tmpdir(), 'teamwork-dsh-integration-'));
  const patch = join(fixtureHome, 'offline.patch.yml');
  const provider = new URL('./fixtures/offline-provider.js', import.meta.url).href;
  await writeFile(patch, `- insert:\n    - id: offline-test-provider\n      name: ${JSON.stringify(provider)}\n      inject: [llm]\n      config:\n        repairDemo: ${verification === 'repair'}\n        pauseDemo: ${verification === 'pause'}\n`);
  const actualBin = fileURLToPath(new URL('../../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url));
  await verifyDsh(actualBin);
  let diagnostic = '';
  const captures: RunResult[] = [];
  let launched = 0, exited = 0;
  const driver = new DshExecutor({ dshBin: actualBin, profile: 'sdk', patches: [patch],
    dshHome: fixtureHome, provider: 'teamwork-offline-fixture', model: 'deterministic' }, options => {
      const harness = new DeepSeekHarness(options);
      launched++;
      return { close: async () => { await harness.close(); exited++; }, run: async (...args) => {
        try {
          const result = await harness.run(...args);
          captures.push(result);
          diagnostic = JSON.stringify(result.events.filter(event => event.type === 'tool/result'));
          return result;
        }
        catch (error) {
          diagnostic = String(error) + '\n' + (harness.client as unknown as { stderrTail: string[] }).stderrTail.join('\n');
          throw error;
        }
      } };
    });
  const f = await setup(driver, 40_000, verification ? { maxIterations: verification === 'repair' ? 2 : 1, commands: [{
    id: 'readback', executable: process.execPath,
    args: ['-e', "require('node:assert').equal(require('node:fs').readFileSync('hello.txt','utf8'),'changed through real DSH tool')"],
    timeoutMs: 5_000,
  }] } : undefined);
  try {
    const run = await f.client.start({ commandId: 'real-dsh', objective: 'Exercise offline plugin integration' });
    if (verification === 'pause') {
      await waitFor(() => f.store.get(run.id).checkpoint ? true : undefined, 25_000);
      await f.client.control(run.id, { commandId: 'pause', type: 'pause', mode: 'interrupt', expectedRevision: f.store.get(run.id).revision });
      const stopped = await waitFor(() => { const r = f.store.get(run.id); return r.phase === 'paused' ? r : undefined; }, 20_000);
      assert.equal(exited, 1);
      assert.equal(stopped.gate, 'not_evaluated');
      await f.client.control(run.id, { commandId: 'resume', type: 'resume', expectedRevision: stopped.revision });
    }
    const settled = await waitFor(() => {
      const current = f.store.get(run.id);
      return ['submitted', 'failed', 'blocked', 'verified', 'rejected'].includes(current.phase) ? current : undefined;
    }, 50_000);
    assert.equal(settled.phase, verification ? 'verified' : 'submitted', diagnostic || JSON.stringify(settled));
    assert.equal(settled.gate, verification ? 'passed' : 'not_evaluated');
    assert.equal(launched, exited);
    assert.equal(launched, verification === 'pause' ? 3 : verification === 'repair' ? 4 : verification ? 2 : 1);
    if (verification) {
      assert.equal(captures.length, verification === 'repair' ? 4 : 2);
      assert.equal(new Set(captures.map(c => c.sessionId)).size, captures.length);
      assert.equal(captures.at(-1)!.sessionId, settled.reviewAttempt!.order.attemptId);
      assert.match(JSON.stringify(captures.at(-1)!.events.filter(e => e.type === 'tool/result')), /outside the managed attempt allowlist/);
      assert.equal(await readFile(join(settled.reviewAttempt!.order.workspace, 'hello.txt'), 'utf8'), 'changed through real DSH tool');
      if (verification === 'repair') {
        assert.equal(settled.iteration, 2);
        assert.equal(settled.history?.length, 1);
        assert.equal(settled.history![0]!.validation![0]!.status, 'failed');
        assert.equal(await readFile(join(settled.history![0]!.candidate!.workspace, 'hello.txt'), 'utf8'), 'first round defect');
        assert.equal(settled.order.repair?.candidate.digest, settled.history![0]!.candidate!.digest);
      }
      if (verification === 'pause') {
        assert.equal(settled.iteration, 1);
        assert.equal(settled.order.epoch, 2);
        assert.equal(settled.order.resume?.checkpoint?.summary, 'Offline DSH plugin integration exercise');
        assert.equal(settled.suspensions?.length, 1);
        assert.equal(settled.suspensions![0]!.order.attemptId, run.order.attemptId);
        assert.notEqual(settled.order.attemptId, run.order.attemptId);
      }
    }
    assert.equal(settled.checkpoint?.summary, 'Offline DSH plugin integration exercise');
    assert.equal(await readFile(join(settled.order.workspace, 'hello.txt'), 'utf8'), 'changed through real DSH tool', diagnostic);
    assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'original');
  } finally {
    await f.cleanup();
    await rm(fixtureHome, { recursive: true, force: true });
  }
});
