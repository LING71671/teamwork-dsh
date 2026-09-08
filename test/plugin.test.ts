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
    assert.deepEqual(ctx.tools.schemas().map(s => s.name).sort(), ['teamwork_control', 'teamwork_start', 'teamwork_status']);
    const result = await ctx.tools.execute({ callId: 'host-call' as ToolExecutionInput['callId'],
      name: 'teamwork_start', arguments: { commandId: 'start', objective: 'fix' }, signal: new AbortController().signal });
    assert.equal(result.isError, false, JSON.stringify(result));
    const run = f.store.all()[0]!;
    await fiber.dispose();
    assert.equal(ctx.tools.get('teamwork_start'), undefined);
    fiber = ctx.plugin(host);
    await waitFor(() => ctx.tools.get('teamwork_start'));
    assert.equal(f.store.all().length, 1);
    const status = await ctx.tools.execute({ callId: 'status-call' as ToolExecutionInput['callId'],
      name: 'teamwork_status', arguments: { runId: run.id }, signal: new AbortController().signal });
    assert.equal(status.isError, false, JSON.stringify(status));
    await fiber.dispose();
  } finally {
    await ctx.fiber.dispose();
    for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; }
    await f.cleanup();
  }
});
