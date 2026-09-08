import { Fault, type Execution } from './contracts.js';

/** Keep cancellation armed until teardown is confirmed, including cancellation during close. */
export async function runOwned(execution: Execution, signal: AbortSignal, timeoutMs: number, closeTimeoutMs = 15_000): Promise<void> {
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([Promise.resolve().then(() => execution.close()), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Fault('EXTERNAL_STATE_UNKNOWN', 'Teardown confirmation deadline exceeded')), closeTimeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  })();
  let rejectAbort: (error: unknown) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  void aborted.catch(() => {});
  let timeout = false;
  const interrupt = (): void => { void close().then(() => rejectAbort(new Fault('ABORTED', 'Owned execution stopped')), rejectAbort); };
  signal.addEventListener('abort', interrupt, { once: true });
  const timer = setTimeout(() => { timeout = true; interrupt(); }, timeoutMs);
  timer.unref();
  let failure: unknown;
  try {
    signal.throwIfAborted();
    await Promise.race([Promise.resolve().then(() => execution.run()), aborted]);
  } catch (error) { failure = error; }
  try { await close(); }
  catch { throw new Fault('EXTERNAL_STATE_UNKNOWN', 'Owned process exit could not be confirmed'); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', interrupt); }
  if (timeout) throw new Fault('ATTEMPT_TIMEOUT', 'Attempt deadline exceeded');
  signal.throwIfAborted();
  if (failure) throw failure;
}
