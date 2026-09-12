#!/usr/bin/env node
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import { DshExecutor, verifyDsh, supportedDshVersion } from './driver-dsh.js';
import { Fault } from './contracts.js';
import { readConfig } from './config.js';
import { launchPersistent, launchAttached } from './service-launcher.js';
import { startService, serviceStatus, stopService } from './service.js';

const usage = 'teamwork-runtime [run|start|status|stop] --config <file.json> [--doctor] [--mode drain|interrupt --command-id <id> --instance-id <id>]';
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string' }, doctor: { type: 'boolean' }, mode: { type: 'string' },
    'command-id': { type: 'string' }, 'instance-id': { type: 'string' }, 'service-child': { type: 'boolean' }, 'attached-child': { type: 'boolean' },
  } });
  const action = positionals[0] ?? 'run';
  if (!values.config || positionals.length > 1 || !['run', 'start', 'status', 'stop'].includes(action)) throw new Fault('CONFIG_INVALID', usage);
  if (process.env.TEAMWORK_ATTEMPT_TOKEN) throw new Fault('WORKER_SCOPE', 'Managed workers cannot launch or control the shared Runtime');
  if (values.doctor && action !== 'run') throw new Fault('CONFIG_INVALID', '--doctor cannot be combined with service control');
  if (action !== 'stop' && (values.mode || values['command-id'] || values['instance-id'])) throw new Fault('CONFIG_INVALID', 'Stop options require the stop action');
  const child = values['service-child'] || values['attached-child'];
  if ((child && (action !== 'run' || !process.send || values.doctor)) || (values['service-child'] && values['attached-child'])) throw new Fault('CONFIG_INVALID', 'Internal service child requires its launcher IPC');
  let ownerLost = values['attached-child'] === true && !process.connected, onOwnerLost = (): void => {};
  if (values['attached-child']) {
    process.once('disconnect', () => { ownerLost = true; onOwnerLost(); });
    process.on('message', (message: unknown) => {
      if (message && typeof message === 'object' && 'type' in message && message.type === 'owner-stop') { ownerLost = true; onOwnerLost(); }
    });
  }
  const config = await readConfig(values.config);
  if (action === 'status') { process.stdout.write(JSON.stringify(await serviceStatus(config.dataDirectory)) + '\n'); return; }
  if (action === 'stop') {
    if (!values['command-id'] || !values['instance-id'] || (values.mode && !['drain', 'interrupt'].includes(values.mode))) {
      throw new Fault('CONFIG_INVALID', 'Stop requires --instance-id from status and a reusable --command-id; optional --mode drain|interrupt');
    }
    const result = await stopService(config.dataDirectory, { type: 'stop', instanceId: values['instance-id'], commandId: values['command-id'],
      mode: values.mode === 'interrupt' ? 'interrupt' : 'drain' });
    process.stdout.write(JSON.stringify(result) + '\nStop accepted; query status for completed shutdown.\n'); return;
  }
  if (action === 'start') {
    const ready = await launchPersistent(values.config);
    process.stdout.write(`Persistent Runtime ready: ${ready.instanceId}\nConnection file: ${join(ready.directory, 'connection.json')}\nClosing this terminal does not stop authorized work.\n`);
    return;
  }
  if (!child && !values.doctor) {
    await launchAttached(values.config, ready => {
      process.stdout.write(`Attached Runtime ready: ${ready.instanceId}\nConnection file: ${join(ready.directory, 'connection.json')}\nOwner exit pauses authorized work; use start for persistent operation.\n`);
    });
    return;
  }
  const { dshHome, ...route } = config.dsh, dsh = { ...route, ...(dshHome ? { dshHome } : {}) };
  await verifyDsh(dsh.dshBin);
  const source = await realpath(config.workspace);
  if (values.doctor) {
    const harness = new DeepSeekHarness({ ...dsh, cwd: source, processCwd: source, initializeTimeoutMs: 30_000 });
    try { await harness.start(); process.stdout.write(`DSH ${supportedDshVersion}: SDK initialize succeeded; no prompt or model request sent.\n`); }
    finally { await harness.close(); }
    return;
  }
  const service = await startService({ source, dataDirectory: config.dataDirectory, port: config.port, maxConcurrency: config.maxConcurrency,
    attemptTimeoutMs: config.attemptTimeoutMs, executionProfile: config.dsh, lifecycle: values['service-child'] ? 'persistent' : 'attached',
    ...(process.env.TEAMWORK_HOST_TOKEN ? { hostToken: process.env.TEAMWORK_HOST_TOKEN } : {}),
    ...(config.verification ? { verification: config.verification } : {}), ...(config.integration ? { integration: config.integration } : {}),
  }, new DshExecutor(dsh));
  let stopping = false;
  const stop = (): void => {
    if (stopping) return; stopping = true;
    try { service.stop({ type: 'stop', instanceId: service.status().instanceId, commandId: `signal-${randomUUID()}`, mode: 'interrupt' }); }
    catch { process.stderr.write('Stop request could not commit; retain service ownership and inspect data.\n'); process.exitCode = 1; }
  };
  onOwnerLost = stop;
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  void service.closed.then(() => { process.off('SIGINT', stop); process.off('SIGTERM', stop); if (process.connected) process.disconnect(); }, () => {
    process.stderr.write('Shutdown could not be fully confirmed; service ownership and data retained.\n'); process.exitCode = 1;
  });
  if (child) {
    if (process.connected) process.send!({ type: 'ready', instanceId: service.status().instanceId, directory: service.directory }, () => {});
  } else process.stdout.write(`Teamwork attached Runtime: ${service.server.url}\nConnection file: ${join(service.directory, 'connection.json')}\nNo task starts until teamwork_start is called.\n`);
  if (ownerLost) stop();
}
void main().catch(error => {
  const code = error instanceof Fault ? error.code : error instanceof z.ZodError ? 'CONFIG_INVALID' : 'SERVICE_START_FAILED';
  const message = error instanceof Fault ? `${code}: ${error.message}`
    : error instanceof z.ZodError ? `CONFIG_INVALID: ${error.issues.map(i => i.path.join('.')).join(', ')}`
    : 'Startup failed. Check DSH version, profile, paths, and model route; inspect service status before retrying.';
  if (process.send && process.connected) process.send({ type: 'startup-error', code }, () => { if (process.connected) process.disconnect(); });
  process.stderr.write(message + '\n'); process.exitCode = 1;
});
