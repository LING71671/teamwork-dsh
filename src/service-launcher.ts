import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Fault, identifier } from './contracts.js';

const readySchema = z.object({ type: z.literal('ready'), instanceId: identifier, directory: z.string() }).strict();
export type ServiceReady = z.infer<typeof readySchema>;
/** Foreground owner with an IPC leash. The child pauses on owner disconnect, including owner death. */
export function launchAttached(config: string, onReady: (ready: ServiceReady) => void, timeoutMs = 60_000): Promise<void> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.js', import.meta.url)), '--config', resolve(config), '--attached-child'], {
      detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], shell: false,
    });
    let error: Error | undefined, ready = false, settled = false;
    const signalStop = (): void => { if (child.connected) child.send({ type: 'owner-stop' }, () => {}); };
    process.once('SIGINT', signalStop); process.once('SIGTERM', signalStop);
    const timer = setTimeout(() => {
      settled = true;
      error = new Fault('STARTUP_UNCONFIRMED', 'Attached startup was not confirmed; owner disconnect requests pause. Inspect service status before retrying.', 503);
      if (child.connected) child.disconnect(); child.unref();
      process.off('SIGINT', signalStop); process.off('SIGTERM', signalStop); reject(error);
    }, timeoutMs);
    child.on('error', () => { error = new Fault('SERVICE_LAUNCH_FAILED', 'Could not start the attached Runtime'); });
    child.on('message', (message: unknown) => {
      if (settled) return;
      const result = readySchema.safeParse(message);
      if (result.success && !ready) { ready = true; clearTimeout(timer); onReady(result.data); }
      else if (message && typeof message === 'object' && 'type' in message && message.type === 'startup-error') {
        error = new Fault('SERVICE_START_FAILED', 'Attached Runtime failed before readiness; inspect configuration and owner state');
      }
    });
    child.once('close', code => {
      clearTimeout(timer); process.off('SIGINT', signalStop); process.off('SIGTERM', signalStop);
      if (settled) return; settled = true;
      if (error || code !== 0 || !ready) reject(error ?? new Fault('SERVICE_EXIT_UNCONFIRMED', 'Attached Runtime did not report a clean lifecycle'));
      else resolveExit();
    });
  });
}
/** Detached stdio, hidden Windows window and an IPC readiness receipt. Never infer death from a timeout. */
export function launchPersistent(config: string, timeoutMs = 60_000): Promise<ServiceReady> {
  return new Promise((resolveReady, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.js', import.meta.url)), '--config', resolve(config), '--service-child'], {
      detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], shell: false,
    });
    let settled = false;
    const finish = (error?: Error, ready?: ServiceReady): void => {
      if (settled) return; settled = true; clearTimeout(timer);
      child.removeAllListeners('message'); child.removeAllListeners('exit');
      if (child.connected) child.disconnect(); child.unref();
      if (error) reject(error); else resolveReady(ready!);
    };
    const timer = setTimeout(() => finish(new Fault('STARTUP_UNCONFIRMED', 'No readiness receipt; inspect runtime status before retrying. The child may still be starting.', 503)), timeoutMs);
    child.on('error', () => finish(new Fault('SERVICE_LAUNCH_FAILED', 'Could not start the Runtime process')));
    child.once('exit', () => finish(new Fault('SERVICE_START_FAILED', 'Runtime exited before readiness; inspect configuration and owner state')));
    child.on('message', (message: unknown) => {
      const ready = readySchema.safeParse(message);
      if (ready.success) finish(undefined, ready.data);
      else if (message && typeof message === 'object' && 'type' in message && message.type === 'startup-error') {
        const code = 'code' in message && typeof message.code === 'string' && /^[A-Z_]{1,64}$/.test(message.code) ? message.code : 'SERVICE_START_FAILED';
        finish(new Fault(code, 'Runtime could not start; existing owners are never replaced automatically'));
      }
    });
  });
}
