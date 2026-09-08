import { randomBytes, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { Store, digest } from './store.js';
import { Fault, type Executor, type StartCommand, type CancelCommand, type Run,
  type VerificationPolicy, type WorkOrder, type ValidationResult } from './contracts.js';
import { snapshot, treeDigest, inputsUnchanged } from './workspace.js';
import { runOwned } from './owned-execution.js';
import { validateCommand } from './validation.js';

export interface RuntimeOptions {
  source: string;
  attemptsDirectory: string;
  maxConcurrency: number;
  attemptTimeoutMs: number;
  executionProfile: unknown;
  verification?: VerificationPolicy;
}
interface Active { abort: AbortController; done: Promise<void> }

export class Runtime {
  private readonly active = new Map<string, Active>();
  private closing = false;
  private url = '';
  constructor(readonly store: Store, private readonly executor: Executor, private readonly options: RuntimeOptions) {}
  get verificationEnabled(): boolean { return this.options.verification !== undefined; }
  connect(url: string): void {
    this.store.bindProfile({ source: this.options.source, attemptsDirectory: this.options.attemptsDirectory,
      executionProfile: this.options.executionProfile,
      ...(this.options.verification ? { verification: this.options.verification } : {}) });
    this.url = url;
    this.store.recover();
    this.pump();
  }
  start(input: StartCommand): Run {
    if (this.closing) throw new Fault('UNAVAILABLE', 'Runtime is shutting down or an owned process is unconfirmed', 503);
    const run = this.store.start(input, this.options.attemptsDirectory, this.options.executionProfile, this.options.verification);
    queueMicrotask(() => this.pump());
    return run;
  }
  cancel(id: string, input: CancelCommand): Run {
    const run = this.store.cancel(id, input);
    if (this.store.get(id).phase === 'stopping') this.active.get(id)?.abort.abort();
    return run;
  }
  private pump(): void {
    if (this.closing || !this.url) return;
    for (const id of this.store.pending()) {
      if (this.active.size >= this.options.maxConcurrency) break;
      const token = randomBytes(32).toString('hex');
      const run = this.store.claim(id, token);
      const abort = new AbortController();
      const done = Promise.resolve().then(() => this.execute(run, token, abort)).finally(() => {
        this.active.delete(id); this.pump();
      });
      this.active.set(id, { abort, done });
      void done.catch(() => { this.closing = true; });
    }
  }
  private async execute(run: Run, token: string, abort: AbortController): Promise<void> {
    try {
      await snapshot(this.options.source, run.order.workspace, abort.signal);
      abort.signal.throwIfAborted();
      this.store.move(run.id, 'running');
      await runOwned(this.executor.create(run.order, { url: this.url, token }), abort.signal, this.options.attemptTimeoutMs);
      const current = this.store.get(run.id);
      if (!current.report) throw new Fault('RESULT_MISSING', 'Idle is not a structured submission');
      if (!current.verification) this.store.move(run.id, 'submitted', 'Report collected; verification is not configured');
      else await this.verify(current, abort.signal);
    } catch (error) {
      const code = error instanceof Fault ? error.code : 'EXECUTOR_FAILED';
      if (code === 'EXTERNAL_STATE_UNKNOWN') {
        this.closing = true;
        this.store.move(run.id, 'blocked', code);
      } else if (this.store.get(run.id).phase === 'stopping') this.store.move(run.id, 'cancelled');
      else this.store.move(run.id, 'failed', code);
    }
  }
  private async verify(run: Run, signal: AbortSignal): Promise<void> {
    this.store.move(run.id, 'freezing');
    const candidatePath = join(dirname(run.order.workspace), 'candidate');
    const initial = await treeDigest(run.order.workspace, signal);
    await snapshot(run.order.workspace, candidatePath, signal, true);
    const hash = await treeDigest(candidatePath, signal);
    if (hash !== initial || await treeDigest(run.order.workspace, signal) !== initial) {
      throw new Fault('CANDIDATE_CHANGED', 'Implementation changed while freezing');
    }
    const attemptId = randomUUID();
    const reviewOrder: WorkOrder = { ...run.order, role: 'review', attemptId, workItemId: randomUUID(),
      dispatchKey: randomUUID(), candidateDigest: hash,
      inputDigest: digest(JSON.stringify({ input: run.order.inputDigest, candidate: hash, role: 'review' })),
      workspace: join(this.options.attemptsDirectory, attemptId, 'work') };
    const token = randomBytes(32).toString('hex');
    this.store.prepareReview(run.id, { workspace: candidatePath, digest: hash }, reviewOrder, token);
    await snapshot(candidatePath, reviewOrder.workspace, signal, true);
    if (await treeDigest(reviewOrder.workspace, signal) !== hash) throw new Fault('CANDIDATE_CHANGED', 'Review input differs');
    await runOwned(this.executor.create(reviewOrder, { url: this.url, token }), signal, this.options.attemptTimeoutMs);
    const reviewed = this.store.get(run.id);
    if (!reviewed.reviewAttempt?.report) throw new Fault('REVIEW_MISSING', 'Reviewer did not submit a structured assessment');
    const reviewUnchanged = await treeDigest(reviewOrder.workspace, signal) === hash;
    this.store.move(run.id, 'validating');
    const validationPath = join(dirname(run.order.workspace), 'validation');
    await snapshot(candidatePath, validationPath, signal, true);
    if (await treeDigest(validationPath, signal) !== hash) throw new Fault('CANDIDATE_CHANGED', 'Acceptance input differs');
    const results: ValidationResult[] = [];
    let acceptanceIntegrity = true;
    for (const command of run.verification!.commands) {
      signal.throwIfAborted();
      const result = await validateCommand(command, validationPath, signal);
      results.push(result);
      this.store.recordValidation(run.id, result);
      if (!await inputsUnchanged(candidatePath, validationPath, signal)) { acceptanceIntegrity = false; break; }
    }
    const intact = reviewUnchanged && await treeDigest(candidatePath, signal) === hash;
    signal.throwIfAborted();
    this.store.finishGate(run.id, results, intact, acceptanceIntegrity);
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const [id, active] of this.active) {
      const run = this.store.get(id);
      if (['starting', 'running', 'freezing', 'reviewing', 'validating'].includes(run.phase)) this.store.move(id, 'stopping', 'Runtime shutdown');
      active.abort.abort();
    }
    await Promise.all([...this.active.values()].map(a => a.done));
  }
}
