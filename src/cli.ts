#!/usr/bin/env node
import { readFile, writeFile, realpath, mkdir } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import { DshExecutor, verifyDsh, supportedDshVersion } from './driver-dsh.js';
import { Store } from './store.js';
import { Runtime } from './runtime.js';
import { serve } from './server.js';
import { acquire } from './ownership.js';
import { inside } from './workspace.js';
import { Fault, verificationSchema, integrationPolicySchema } from './contracts.js';

const absolute = z.string().refine(isAbsolute, 'Use an absolute path');
const configSchema = z.object({
  workspace: absolute, dataDirectory: absolute,
  port: z.number().int().min(0).max(65535).default(0),
  maxConcurrency: z.number().int().min(1).max(4).default(1),
  attemptTimeoutMs: z.number().int().min(1_000).max(3_600_000).default(600_000),
  verification: verificationSchema.refine(policy => policy.commands.every(c => isAbsolute(c.executable)), 'Acceptance executables must be absolute').optional(),
  integration: integrationPolicySchema.optional(),
  dsh: z.object({ dshBin: absolute, profile: z.string().min(1).default('sdk'),
    patches: z.array(absolute).default([]), provider: z.string().min(1), model: z.string().min(1),
    dshHome: absolute.optional() }).strict(),
}).strict().refine(config => !config.integration?.enabled || !!config.verification, 'Integration requires verification');

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: 'string' }, doctor: { type: 'boolean' } } });
  if (!values.config) throw new Fault('CONFIG_INVALID', 'Usage: npm start -- --config <file.json> [--doctor]');
  const config = configSchema.parse(JSON.parse(await readFile(resolve(values.config), 'utf8')));
  const { dshHome, ...route } = config.dsh;
  const dsh = { ...route, ...(dshHome ? { dshHome } : {}) };
  await verifyDsh(dsh.dshBin);
  const source = await realpath(config.workspace);
  if (inside(source, config.dataDirectory) || inside(config.dataDirectory, source)) {
    throw new Fault('WORKSPACE_OVERLAP', 'dataDirectory must be separate from workspace');
  }
  if (values.doctor) {
    const harness = new DeepSeekHarness({ ...dsh, cwd: source, processCwd: source, initializeTimeoutMs: 30_000 });
    try {
      await harness.start();
      process.stdout.write(`DSH ${supportedDshVersion}: SDK initialize succeeded; no prompt or model request sent.\n`);
    } finally { await harness.close(); }
    return;
  }
  await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
  const directory = await realpath(config.dataDirectory);
  if (inside(source, directory) || inside(directory, source)) throw new Fault('WORKSPACE_OVERLAP', 'Resolved workspace and data paths overlap');
  const release = await acquire(directory);
  let store: Store | undefined;
  let server: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    store = new Store(join(directory, 'runtime.sqlite'));
    const runtime = new Runtime(store, new DshExecutor(dsh), {
      source, attemptsDirectory: join(directory, 'attempts'), maxConcurrency: config.maxConcurrency,
      attemptTimeoutMs: config.attemptTimeoutMs, executionProfile: config.dsh,
      ...(config.verification ? { verification: config.verification } : {}),
      ...(config.integration ? { integration: config.integration } : {}),
    });
    const token = process.env.TEAMWORK_HOST_TOKEN ?? randomBytes(32).toString('hex');
    server = await serve(runtime, token, config.port);
    const connection = join(directory, 'connection.json');
    await writeFile(connection, JSON.stringify({ url: server.url, token }) + '\n', { mode: 0o600 });
    process.stdout.write(`Teamwork runtime: ${server.url}\nConnection file: ${connection}\nNo task starts until teamwork_start is called.\n`);
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void server!.close().then(() => { store!.close(); return release(); })
        .catch(() => { process.stderr.write('Shutdown could not be fully confirmed; retain runtime data for recovery.\n'); process.exitCode = 1; });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) { await server?.close(); store?.close(); await release(); throw error; }
}
void main().catch(error => {
  // Deliberately avoid serializing arbitrary SDK errors (including stderr tails).
  const message = error instanceof Fault ? `${error.code}: ${error.message}`
    : error instanceof z.ZodError ? `CONFIG_INVALID: ${error.issues.map(i => i.path.join('.')).join(', ')}`
    : 'Startup failed. Check DSH version, profile, paths, and model route; no task was accepted.';
  process.stderr.write(message + '\n');
  process.exitCode = 1;
});
