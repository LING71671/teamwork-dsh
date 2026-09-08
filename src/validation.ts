import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { Fault, type VerificationPolicy, type ValidationResult } from './contracts.js';

/** No shell expansion and no model-supplied commands. The configured executable is trusted code. */
export async function validateCommand(command: VerificationPolicy['commands'][number], cwd: string,
  signal: AbortSignal): Promise<ValidationResult> {
  signal.throwIfAborted();
  if (!isAbsolute(command.executable)) throw new Fault('CONFIG_INVALID', 'Acceptance executable must be absolute');
  const env: NodeJS.ProcessEnv = {};
  const inherited = new Set(['path', 'systemroot', 'windir', 'comspec', 'pathext', 'temp', 'tmp', 'lang', 'lc_all']);
  for (const [key, value] of Object.entries(process.env)) if (inherited.has(key.toLowerCase())) env[key] = value;
  const start = Date.now();
  return new Promise<ValidationResult>((resolve, reject) => {
    const child = spawn(command.executable, command.args, { cwd, env, shell: false, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout: Buffer = Buffer.alloc(0), stderr: Buffer = Buffer.alloc(0);
    let timedOut = false, spawnFailed = false, settled = false;
    let confirmation: NodeJS.Timeout | undefined;
    const tail = (old: Buffer, chunk: Buffer): Buffer => Buffer.concat([old, chunk]).subarray(-16_384);
    child.stdout.on('data', chunk => { stdout = tail(stdout, Buffer.from(chunk)); });
    child.stderr.on('data', chunk => { stderr = tail(stderr, Buffer.from(chunk)); });
    const cleanup = (): void => {
      clearTimeout(timer); if (confirmation) clearTimeout(confirmation);
      signal.removeEventListener('abort', stop);
    };
    const stop = (): void => {
      if (settled || confirmation) return;
      // This confirms the owned direct process only; escaped descendants require OS containment.
      child.kill('SIGKILL');
      confirmation = setTimeout(() => {
        if (settled) return;
        settled = true; cleanup();
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
        reject(new Fault('EXTERNAL_STATE_UNKNOWN', 'Acceptance process exit/stdio closure is unconfirmed'));
      }, 3_000);
      confirmation.unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, command.timeoutMs);
    timer.unref();
    child.once('error', () => { spawnFailed = true; });
    child.once('close', code => {
      if (settled) return;
      settled = true; cleanup();
      if (signal.aborted) { reject(new Fault('ABORTED', 'Acceptance cancelled')); return; }
      resolve({ commandId: command.id, status: timedOut ? 'timed_out' : spawnFailed ? 'spawn_failed' : code === 0 ? 'passed' : 'failed',
        exitCode: code, durationMs: Date.now() - start, stdoutTail: stdout.toString('utf8'), stderrTail: stderr.toString('utf8') });
    });
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  });
}
