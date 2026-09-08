import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Fault } from './contracts.js';

/** One runtime owner. A live/reused/unknown PID is never killed or stolen. */
export async function acquire(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'runtime.lock');
  const identity = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  try { await writeFile(path, identity, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const previous = await readFile(path, 'utf8');
    let pid: unknown;
    try { pid = (JSON.parse(previous) as { pid: unknown }).pid; } catch { /* refuse malformed owner */ }
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1) throw new Fault('OWNER_UNKNOWN', 'Malformed runtime lock; inspect it manually');
    let dead = false;
    try { process.kill(pid, 0); } catch (failure) { dead = (failure as NodeJS.ErrnoException).code === 'ESRCH'; }
    if (!dead) throw new Fault('RUNTIME_OWNED', 'The data directory has a live or unverified owner');
    // Do not race another starter by deleting a stale lock. Recovery requires operator inspection.
    throw new Fault('OWNER_STALE', 'Previous runtime is gone. Verify no worker remains, then archive runtime.lock before restarting');
  }
  return async () => { if (await readFile(path, 'utf8') === identity) await unlink(path); };
}
