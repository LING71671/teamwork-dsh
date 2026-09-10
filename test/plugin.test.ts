import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import ToolRuntime, { type ToolExecutionInput } from '@deepseek-ai/dsh-tools';
import * as host from '../src/plugin-dsh/host.js';
import { FakeExecutor, setup, waitFor } from './helpers.js';

test('host registers with real Cordis tools; reload removes old tools and never duplicates a run', async () => {
  const f = await setup(new FakeExecutor());
  const ctx = new Context();
  const keys = ['TEAMWORK_URL', 'TEAMWORK_HOST_TOKEN', 'TEAMWORK_CONNECTION_FILE', 'TEAMWORK_ATTEMPT_TOKEN'] as const;
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.TEAMWORK_URL = f.server.url;
    process.env.TEAMWORK_HOST_TOKEN = f.token;
    // Prompt assembly isn't under test; the actual registry/execution and plugin lifetimes are.
    ctx.provide('systemPrompt', { tools: () => () => {} } as unknown as Context['systemPrompt']);
    await ctx.plugin(ToolRuntime);
    await waitFor(() => ctx.get('tools'));
    let fiber = ctx.plugin(host);
    await waitFor(() => ctx.tools.get('teamwork_start'));
    assert.equal(f.store.all().length, 0);
    assert.deepEqual(ctx.tools.schemas().map(s => s.name).sort(), ['teamwork_control', 'teamwork_inspect', 'teamwork_integrate', 'teamwork_start', 'teamwork_status']);
    const spec = { requirements: [{ id: 'fix', text: 'Fix hello.txt' }], writeScope: { files: ['hello.txt'], trees: [] } };
    const unauthorizedAuto = await ctx.tools.execute({ callId: 'auto-disabled' as ToolExecutionInput['callId'], name: 'teamwork_start',
      arguments: { commandId: 'auto-disabled', objective: 'Fix', spec, autonomy: { integration: 'on-gate-pass' } }, signal: new AbortController().signal });
    assert.equal(unauthorizedAuto.isError, true); assert.equal(f.store.all().length, 0);
    const result = await ctx.tools.execute({ callId: 'host-call' as ToolExecutionInput['callId'],
      name: 'teamwork_start', arguments: { commandId: 'start', objective: 'fix', spec, budget: { maxModelAttempts: 10 } }, signal: new AbortController().signal });
    assert.equal(result.isError, false, JSON.stringify(result));
    const run = f.store.all()[0]!;
    assert.deepEqual(run.order.spec, spec);
    await fiber.dispose();
    assert.equal(ctx.tools.get('teamwork_start'), undefined);
    fiber = ctx.plugin(host);
    await waitFor(() => ctx.tools.get('teamwork_start'));
    assert.equal(f.store.all().length, 1);
    const status = await ctx.tools.execute({ callId: 'status-call' as ToolExecutionInput['callId'],
      name: 'teamwork_status', arguments: { runId: run.id }, signal: new AbortController().signal });
    assert.equal(status.isError, false, JSON.stringify(status));
    const workflow = await ctx.tools.execute({ callId: 'workflow-status' as ToolExecutionInput['callId'], name: 'teamwork_status',
      arguments: { runId: run.id, scope: 'workflow' }, signal: new AbortController().signal });
    assert.equal(workflow.isError, false, JSON.stringify(workflow)); assert.match(JSON.stringify(workflow), /leafRunIds/);
    await waitFor(() => f.store.get(run.id).phase === 'running' ? true : undefined);
    const current = f.store.get(run.id);
    assert.equal(current.budget?.reservedModelAttempts, 1);
    const allocate = await ctx.tools.execute({ callId: 'allocate-call' as ToolExecutionInput['callId'], name: 'teamwork_control',
      arguments: { runId: run.id, commandId: 'allocate', type: 'budget', expectedRevision: current.revision,
        expectedBudgetRevision: current.budget!.revision, maxModelAttempts: 12, reason: 'User approved a larger total allocation' }, signal: new AbortController().signal });
    assert.equal(allocate.isError, false, JSON.stringify(allocate)); assert.equal(f.store.get(run.id).budget?.maxModelAttempts, 12);
    const pause = await ctx.tools.execute({ callId: 'pause-call' as ToolExecutionInput['callId'], name: 'teamwork_control',
      arguments: { runId: run.id, scope: 'workflow', commandId: 'pause', type: 'pause', mode: 'interrupt', expectedWorkflowRevision: f.store.workflow(run.id).revision }, signal: new AbortController().signal });
    assert.equal(pause.isError, false, JSON.stringify(pause));
    await waitFor(() => f.store.get(run.id).phase === 'paused' ? true : undefined);
    const inspect = await ctx.tools.execute({ callId: 'inspect-call' as ToolExecutionInput['callId'], name: 'teamwork_inspect',
      arguments: { runId: run.id, kind: 'artifacts' }, signal: new AbortController().signal });
    assert.equal(inspect.isError, false, JSON.stringify(inspect));
    assert.match(JSON.stringify(inspect), /baseline/);
    const checkpoint = f.store.artifacts(run.id).artifacts.find(a => a.kind === 'checkpoint');
    assert.ok(checkpoint);
    const preview = await ctx.tools.execute({ callId: 'preview-call' as ToolExecutionInput['callId'], name: 'teamwork_inspect',
      arguments: { runId: run.id, kind: 'integration', artifactId: checkpoint.id }, signal: new AbortController().signal });
    assert.equal(preview.isError, false, JSON.stringify(preview));
    assert.match(JSON.stringify(preview), /readOnly/);
    assert.match(JSON.stringify(preview), /candidateVerified/);
    const resume = await ctx.tools.execute({ callId: 'resume-call' as ToolExecutionInput['callId'], name: 'teamwork_control',
      arguments: { runId: run.id, scope: 'workflow', commandId: 'resume', type: 'resume', expectedWorkflowRevision: f.store.workflow(run.id).revision }, signal: new AbortController().signal });
    assert.equal(resume.isError, false, JSON.stringify(resume));
    await waitFor(() => f.store.get(run.id).phase === 'running' ? true : undefined);
    assert.notEqual(f.store.get(run.id).order.attemptId, run.order.attemptId);
    assert.deepEqual(f.store.get(run.id).order.spec, spec);
    assert.equal(f.store.all().length, 1);
    const pauseAgain = await ctx.tools.execute({ callId: 'pause-before-revise' as ToolExecutionInput['callId'], name: 'teamwork_control',
      arguments: { runId: run.id, commandId: 'pause-again', type: 'pause', mode: 'interrupt', expectedRevision: f.store.get(run.id).revision }, signal: new AbortController().signal });
    assert.equal(pauseAgain.isError, false, JSON.stringify(pauseAgain));
    await waitFor(() => f.store.get(run.id).phase === 'paused' ? true : undefined);
    const revised = await ctx.tools.execute({ callId: 'revise-call' as ToolExecutionInput['callId'], name: 'teamwork_control',
      arguments: { runId: run.id, commandId: 'revise', type: 'revise', expectedRevision: f.store.get(run.id).revision,
        objective: 'New user goal', spec, reason: 'User replaced the objective' }, signal: new AbortController().signal });
    assert.equal(revised.isError, false, JSON.stringify(revised));
    assert.equal(f.store.get(run.id).order.specRevision, 2); assert.equal(f.store.get(run.id).order.epoch, 3);
    assert.equal(f.store.get(run.id).specHistory?.[0]?.previous.order.objective, 'fix');
    assert.equal(f.store.all().length, 1);
    await fiber.dispose();
  } finally {
    await ctx.fiber.dispose();
    for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; }
    await f.cleanup();
  }
});
