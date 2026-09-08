import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.js';
import { Runtime } from '../src/runtime.js';
import { serve } from '../src/server.js';
import { Client } from '../src/client.js';
import type { Executor, WorkOrder, Execution, VerificationPolicy } from '../src/contracts.js';

export const report = { outcome: 'completed' as const, summary: 'Implemented test change', unresolved: [] };
export async function waitFor<T>(body: () => T | undefined, timeout = 5_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = body(); if (result !== undefined) return result; await setTimeout(10); }
  throw new Error('Timed out waiting for condition');
}
export class FakeExecutor implements Executor {
  instances: { order: WorkOrder; bridge: { url: string; token: string }; finish(): void; closed: boolean }[] = [];
  failClose = false;
  create(order: WorkOrder, bridge: { url: string; token: string }): Execution {
    let finish = (): void => {};
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const instance = { order, bridge, finish, closed: false };
    this.instances.push(instance);
    return { run: () => pending, close: async () => {
      if (this.failClose) throw new Error('Exit unknown');
      instance.closed = true; finish();
    } };
  }
}
export async function setup(executor: Executor = new FakeExecutor(), attemptTimeoutMs = 5_000, verification?: VerificationPolicy) {
  const root = await mkdtemp(join(tmpdir(), 'teamwork-test-'));
  const source = join(root, 'source'), data = join(root, 'data');
  await mkdir(source); await mkdir(data);
  await writeFile(join(source, 'hello.txt'), 'original');
  const store = new Store(join(data, 'state.sqlite'));
  const runtime = new Runtime(store, executor, { source, attemptsDirectory: join(data, 'attempts'),
    maxConcurrency: 2, attemptTimeoutMs, executionProfile: { driver: 'test' }, ...(verification ? { verification } : {}) });
  const token = randomBytes(32).toString('hex');
  const server = await serve(runtime, token);
  const client = new Client(server.url, token);
  return { root, source, data, store, runtime, server, client, token, executor,
    async cleanup() { await server.close(); store.close(); await rm(root, { recursive: true, force: true }); } };
}
