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

for (const verification of [false, true, 'repair', 'pause', 'resolution', 'revision'] as const) test(`real DSH SDK + Cordis workers, offline provider, verification=${verification}`, { timeout: 90_000 }, async () => {
  const fixtureHome = await mkdtemp(join(tmpdir(), 'teamwork-dsh-integration-'));
  const patch = join(fixtureHome, 'offline.patch.yml');
  const provider = new URL('./fixtures/offline-provider.js', import.meta.url).href;
  await writeFile(patch, `- insert:\n    - id: offline-test-provider\n      name: ${JSON.stringify(provider)}\n      inject: [llm]\n      config:\n        repairDemo: ${verification === 'repair'}\n        pauseDemo: ${verification === 'pause'}\n        resolutionDemo: ${verification === 'resolution'}\n        requirementDemo: ${verification === true}\n        revisionDemo: ${verification === 'revision'}\n`);
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
    args: ['-e', verification === 'resolution' || verification === 'revision' ? "require('node:assert').ok(require('node:fs').readFileSync('hello.txt','utf8').startsWith('changed through real DSH tool'))"
      : "require('node:assert').equal(require('node:fs').readFileSync('hello.txt','utf8'),'changed through real DSH tool')"],
    timeoutMs: 5_000,
  }] } : undefined, verification === true || verification === 'resolution' || verification === 'revision');
  try {
    const run = await f.client.start({ commandId: 'real-dsh', objective: 'Exercise offline plugin integration', ...(verification === true ? {
      budget: { maxModelAttempts: 1 },
      spec: { requirements: [{ id: 'readback', text: 'hello.txt must contain changed through real DSH tool' }], writeScope: { files: ['hello.txt'], trees: [] } },
    } : {}) });
    if (verification === true) {
      const stopped = await waitFor(() => { const r = f.store.get(run.id); return r.phase === 'paused' ? r : undefined; }, 25_000);
      assert.equal(stopped.reason, 'BUDGET_EXHAUSTED'); assert.equal(launched, 1); assert.equal(exited, 1);
      assert.equal(stopped.budget?.reservedModelAttempts, 1); assert.equal(stopped.gate, 'not_evaluated');
      const allocated = await f.client.control(run.id, { commandId: 'allocate-review', type: 'budget', expectedRevision: stopped.revision,
        expectedBudgetRevision: stopped.budget!.revision, maxModelAttempts: 2, reason: 'User authorized one independent review attempt' });
      assert.equal(allocated.phase, 'paused'); assert.equal(launched, 1);
      await f.client.control(run.id, { commandId: 'resume-review', type: 'resume', expectedRevision: allocated.revision });
    }
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
    if (verification === true) assert.equal(settled.budget?.reservedModelAttempts, 2);
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
    if (verification === true) {
      assert.deepEqual(settled.scopeCheck?.violations, []);
      assert.equal(settled.reviewAttempt?.report?.review?.requirements?.[0]?.id, 'readback');
      await writeFile(join(f.source, 'concurrent-user-file'), 'preserved by integration');
      const preview = await f.client.previewIntegration(run.id);
      const integration = await f.client.integrate(run.id, { commandId: 'integrate-real-dsh', type: 'integrate', planId: preview.id,
        expectedRevision: (await f.client.status(run.id)).revision });
      const integrated = await waitFor(() => {
        const value = f.store.integrations.get(integration.id);
        return ['succeeded', 'failed', 'blocked'].includes(value.phase) ? value : undefined;
      }, 10_000);
      assert.equal(integrated.phase, 'succeeded', JSON.stringify(integrated));
      assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'changed through real DSH tool');
      assert.equal(await readFile(join(f.source, 'concurrent-user-file'), 'utf8'), 'preserved by integration');
      assert.equal(integrated.validation[0]!.status, 'passed');
      assert.ok(integrated.integrated?.artifactId);
      assert.equal(launched, 2); assert.equal(exited, 2); // Integration does not spawn a new model session.
    }
    if (verification === 'revision') {
      await writeFile(join(f.source, 'hello.txt'), 'user edit'); await writeFile(join(f.source, 'user-only'), 'keep this');
      const revised = await f.client.control(run.id, { commandId: 'revise-real-dsh', type: 'revise', expectedRevision: settled.revision,
        objective: 'Implement revised behavior and retain user-only files', reason: 'User changed requirements',
        spec: { requirements: [{ id: 'revised', text: 'hello.txt ends with revised goal' }], writeScope: { files: ['hello.txt'], trees: [] } } });
      assert.equal(revised.gate, 'not_evaluated'); assert.equal(revised.order.specRevision, 2);
      const ready = await waitFor(() => { const r = f.store.get(run.id); return ['verified', 'failed', 'rejected', 'blocked'].includes(r.phase) ? r : undefined; }, 40_000);
      assert.equal(ready.phase, 'verified', diagnostic || JSON.stringify(ready));
      assert.equal(ready.reviewAttempt?.report?.review?.requirements?.[0]?.id, 'revised');
      assert.equal(await readFile(join(ready.candidate!.workspace, 'hello.txt'), 'utf8'), 'changed through real DSH tool + revised goal');
      assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'user edit');
      assert.equal(launched, 4); assert.equal(exited, 4); assert.equal(new Set(captures.map(c => c.sessionId)).size, 4);
      const events = JSON.stringify(captures.slice(2).flatMap(c => c.events));
      assert.match(events, /teamwork_context/); assert.match(events, /user edit/); assert.match(events, /outside the managed attempt allowlist/);
      const plan = await f.client.previewIntegration(run.id);
      const integrated = await f.client.integrate(run.id, { commandId: 'integrate-revised', type: 'integrate', expectedRevision: ready.revision, planId: plan.id });
      await waitFor(() => f.store.integrations.get(integrated.id).phase === 'succeeded' ? true : undefined, 10_000);
      assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'changed through real DSH tool + revised goal');
      assert.equal(await readFile(join(f.source, 'user-only'), 'utf8'), 'keep this');
    }
    if (verification === 'resolution') {
      await writeFile(join(f.source, 'hello.txt'), 'user edit');
      await writeFile(join(f.source, 'user-only'), 'keep this');
      const view = await f.client.previewIntegration(run.id);
      const conflict = await f.client.integrate(run.id, { commandId: 'conflicting-integration', type: 'integrate', planId: view.id, expectedRevision: f.store.get(run.id).revision });
      assert.equal(conflict.phase, 'conflict');
      const child = await f.client.resolveIntegration(run.id, conflict.id, { commandId: 'resolve-with-dsh', type: 'resolve', expectedRevision: conflict.revision,
        planId: view.id, instructions: 'Combine the desired tool change with the user edit; preserve user-only files' });
      const ready = await waitFor(() => {
        const r = f.store.get(child.id); return ['verified', 'failed', 'rejected', 'blocked'].includes(r.phase) ? r : undefined;
      }, 40_000);
      assert.equal(ready.phase, 'verified', diagnostic || JSON.stringify(ready));
      assert.equal(await readFile(join(ready.candidate!.workspace, 'hello.txt'), 'utf8'), 'changed through real DSH tool + user edit');
      assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'user edit');
      assert.equal(launched, 4); assert.equal(exited, 4);
      const resolutionEvents = JSON.stringify(captures.slice(2).flatMap(c => c.events));
      assert.match(resolutionEvents, /teamwork_context/);
      assert.match(resolutionEvents, /user edit/);
      assert.match(resolutionEvents, /outside the managed attempt allowlist/);
      assert.equal(new Set(captures.map(c => c.sessionId)).size, 4);
      const plan = await f.client.previewIntegration(child.id); assert.equal(plan.status, 'clear');
      const integrated = await f.client.integrate(child.id, { commandId: 'integrate-dsh-resolution', type: 'integrate', planId: plan.id, expectedRevision: ready.revision });
      await waitFor(() => f.store.integrations.get(integrated.id).phase === 'succeeded' ? true : undefined, 10_000);
      assert.equal(await readFile(join(f.source, 'hello.txt'), 'utf8'), 'changed through real DSH tool + user edit');
      assert.equal(await readFile(join(f.source, 'user-only'), 'utf8'), 'keep this');
    }
  } finally {
    await f.cleanup();
    await rm(fixtureHome, { recursive: true, force: true });
  }
});
