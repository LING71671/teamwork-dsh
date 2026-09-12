import { mkdir, readFile, writeFile, realpath, lstat, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { Store } from './store.js';
import { Runtime, type RuntimeOptions } from './runtime.js';
import { serve } from './server.js';
import { acquire } from './ownership.js';
import { inside } from './workspace.js';
import { Fault, identifier, type Executor } from './contracts.js';
import { lifecycleSchema, type Lifecycle, type ServiceStatus, type ShutdownCommand, type ShutdownReceipt } from './service-contracts.js';

const statusSchema = z.object({ instanceId: identifier, pid: z.number().int().positive(), lifecycle: lifecycleSchema, startedAt: z.string().datetime(),
  state: z.enum(['running', 'draining', 'stopping', 'blocked', 'stopped']), activeRunIds: z.array(identifier), blockedRunIds: z.array(identifier),
  pausedRunIds: z.array(identifier), pendingRunIds: z.array(identifier), activeIntegrationId: identifier.optional(), reason: z.string().optional() }).strict();
const recordSchema = z.object({ version: z.literal(1), url: z.string(), operatorToken: z.string().min(32), status: statusSchema }).strict();
type ServiceRecord = z.infer<typeof recordSchema>;
const recordName = 'runtime-service.json';
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function regularFile(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Fault('SERVICE_RECORD_INVALID', 'Service record must be a bounded ordinary file');
}
/** Replaces directory-owned metadata without truncating a reader's record or following a link. */
async function writeRecord(directory: string, name: string, value: unknown): Promise<void> {
  const path = join(directory, name), temporary = join(directory, `.${name}-${randomUUID()}.tmp`);
  try { await regularFile(path); } catch (error) { if (!missing(error)) throw error; }
  try {
    await writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, path); break; }
      catch (error) {
        // Windows readers can briefly deny replacement. Retry this same metadata publication,
        // never remove the destination or truncate it, and never replay model/integration work.
        if (attempt >= 19 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await setTimeout(25);
        try { await regularFile(path); } catch (check) { if (!missing(check)) throw check; }
      }
    }
  } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
}
async function readRecord(directory: string): Promise<ServiceRecord> {
  const path = join(await realpath(directory), recordName);
  await regularFile(path);
  const record = recordSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  const url = new URL(record.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Fault('SERVICE_RECORD_INVALID', 'Service record does not contain an exact loopback origin');
  }
  return record;
}
async function request<T>(record: ServiceRecord, input?: ShutdownCommand): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${record.url}/v1/runtime${input ? '/commands' : ''}`, { method: input ? 'POST' : 'GET', redirect: 'error',
      headers: { authorization: `Bearer ${record.operatorToken}`, 'content-type': 'application/json' },
      ...(input ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(5000) });
  } catch { throw new Fault('SERVICE_UNREACHABLE', 'Service outcome is unknown; inspect status and reuse the same stop command. Never kill a PID or start a replacement based on a timeout.', 503); }
  const result = await response.json() as { error?: { code: string; message: string } };
  if (!response.ok) throw new Fault(result.error?.code ?? 'SERVICE_ERROR', result.error?.message ?? 'Service request failed', response.status);
  return result as T;
}
export async function serviceStatus(directory: string): Promise<ServiceStatus> {
  const record = await readRecord(directory);
  if (record.status.state === 'stopped') {
    try { await lstat(join(directory, 'runtime.lock')); }
    catch (error) { if (missing(error)) return record.status; throw error; }
    throw new Fault('SERVICE_TRANSITION', 'An owner exists but the connection record has not been replaced; query status again', 503);
  }
  const status = statusSchema.parse(await request(record));
  if (status.instanceId !== record.status.instanceId) throw new Fault('SERVICE_IDENTITY_CHANGED', 'Endpoint belongs to another service instance');
  return status;
}
export async function stopService(directory: string, input: ShutdownCommand): Promise<ShutdownReceipt> {
  const record = await readRecord(directory);
  if (input.instanceId !== record.status.instanceId) throw new Fault('SERVICE_IDENTITY_CHANGED', 'Stop targets a different instance; inspect the current service');
  if (record.status.state === 'stopped') throw new Fault('SERVICE_STOPPED', 'Service already stopped; query its recorded status');
  // Prove the endpoint generation before sending any mutation. No PID-based control.
  const current = statusSchema.parse(await request(record));
  if (current.instanceId !== input.instanceId) throw new Fault('SERVICE_IDENTITY_CHANGED', 'Endpoint belongs to another service instance');
  return request(record, input);
}

export interface ServiceOptions extends Omit<RuntimeOptions, 'attemptsDirectory' | 'lifecycle'> {
  dataDirectory: string; lifecycle: Lifecycle; port?: number; hostToken?: string;
}
export async function startService(options: ServiceOptions, executor: Executor) {
  const source = await realpath(options.source);
  if (inside(source, options.dataDirectory) || inside(options.dataDirectory, source)) throw new Fault('WORKSPACE_OVERLAP', 'dataDirectory must be separate from workspace');
  await mkdir(options.dataDirectory, { recursive: true, mode: 0o700 });
  const directory = await realpath(options.dataDirectory);
  if (inside(source, directory) || inside(directory, source)) throw new Fault('WORKSPACE_OVERLAP', 'Resolved workspace and data paths overlap');
  const release = await acquire(directory);
  let store: Store | undefined, server: Awaited<ReturnType<typeof serve>> | undefined, runtime: Runtime | undefined;
  let writeQueue = Promise.resolve();
  let resolveClosed = (): void => {}, rejectClosed = (_error: unknown): void => {};
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  void closed.catch(() => {});
  try {
    store = new Store(join(directory, 'runtime.sqlite'));
    runtime = new Runtime(store, executor, { ...options, source, attemptsDirectory: join(directory, 'attempts') });
    const managed = runtime;
    const instanceId = randomUUID(), operatorToken = randomBytes(32).toString('hex'), startedAt = new Date().toISOString();
    const hostToken = options.hostToken ?? randomBytes(32).toString('hex');
    let state: ServiceStatus['state'] = 'running', reason: string | undefined, finishing = false, finalStatus: ServiceStatus | undefined;
    const status = (): ServiceStatus => {
      if (finalStatus) return finalStatus;
      const runs = store!.all(), blockedRunIds = runs.filter(run => run.phase === 'blocked').map(run => run.id);
      return { instanceId, pid: process.pid, lifecycle: options.lifecycle, startedAt,
        state: state === 'running' && (blockedRunIds.length || managed.dispatchStopped) ? 'blocked' : state, ...managed.activity(), blockedRunIds,
        pausedRunIds: runs.filter(run => run.phase === 'paused' || run.automaticIntegration?.state === 'paused').map(run => run.id),
        pendingRunIds: store!.pending(), ...(reason ? { reason } : state === 'running' && managed.dispatchStopped ? { reason: 'DISPATCH_STOPPED' } : {}) };
    };
    const persist = (snapshot: ServiceStatus): Promise<void> => {
      const record: ServiceRecord = { version: 1, url: server!.url, operatorToken, status: snapshot };
      return writeQueue = writeQueue.then(() => writeRecord(directory, recordName, record));
    };
    const finish = async (): Promise<void> => {
      try {
        await managed.waitForShutdown();
        // Closing the HTTP server after drain also finishes outstanding readers before SQLite closes.
        await server!.close();
        state = 'stopped'; finalStatus = status();
        store!.close();
        await persist(finalStatus);
        await release();
        resolveClosed();
      } catch (error) {
        state = 'blocked'; reason = error instanceof Fault ? error.code : 'SHUTDOWN_UNCONFIRMED';
        if (finalStatus) finalStatus = { ...finalStatus, state, reason };
        await persist(status()).catch(() => {});
        const failure = new Fault('SHUTDOWN_UNCONFIRMED', 'Retain service ownership and data; shutdown could not be confirmed');
        failure.cause = error; rejectClosed(failure);
      }
    };
    const stop = (input: ShutdownCommand): ShutdownReceipt => {
      if (input.instanceId !== instanceId) throw new Fault('SERVICE_IDENTITY_CHANGED', 'Stop targets another service instance');
      if (state === 'blocked' || state === 'stopped') throw new Fault('SHUTDOWN_UNCONFIRMED', 'Service is not accepting further shutdown transitions');
      const receipt = managed.requestShutdown(input);
      state = state === 'stopping' || input.mode === 'interrupt' ? 'stopping' : 'draining';
      void persist(status()).catch(() => {}); // The authoritative stop receipt and holds are already in SQLite.
      if (!finishing) { finishing = true; setImmediate(() => { void finish(); }); }
      return receipt;
    };
    server = await serve(runtime, hostToken, options.port ?? 0, { token: operatorToken, status, stop });
    await writeRecord(directory, 'connection.json', { url: server.url, token: hostToken });
    await persist(status());
    return { directory, runtime: managed, store, server, status, stop, closed };
  } catch (error) {
    // Publication failure can occur after recovery dispatched previously authorized work.
    // Pause and prove exit before releasing ownership; do not replace a failed startup blindly.
    if (runtime?.connected) {
      runtime.requestShutdown({ type: 'stop', instanceId: randomUUID(), commandId: `startup-failed-${randomUUID()}`, mode: 'interrupt' });
      await runtime.waitForShutdown();
    }
    if (server) await server.close(); else await runtime?.close();
    store?.close(); await release(); throw error;
  }
}
