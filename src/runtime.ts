import { randomBytes, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { Store, digest } from './store.js';
import { Fault, type Executor, type StartCommand, type CancelCommand, type Run,
  type VerificationPolicy, type WorkOrder, type ValidationResult, type ControlCommand, type Candidate } from './contracts.js';
import { activityPhase } from './kernel.js';
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
  get maxIterations(): number { return this.options.verification?.maxIterations ?? 1; }
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
  control(id: string, input: ControlCommand): Run {
    if (input.type === 'cancel') return this.cancel(id, input);
    if (input.type === 'resume') {
      if (this.closing) throw new Fault('UNAVAILABLE', 'Runtime is shutting down or an owned process is unconfirmed', 503);
      const run = this.store.resume(id, input);
      queueMicrotask(() => this.pump());
      return run;
    }
    const run = this.store.pause(id, input);
    const current = this.store.get(id);
    if (current.phase === 'pausing' && current.pause?.mode === 'interrupt') this.active.get(id)?.abort.abort();
    return run;
  }
  private pump(): void {
    if (this.closing || !this.url) return;
    for (const id of this.store.pending()) {
      if (this.active.size >= this.options.maxConcurrency) break;
      if (this.active.has(id)) continue;
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
    let implementationCompleted = false;
    try {
      if (run.phase === 'verification_starting') { await this.verify(run, abort); return; }
      const base = run.order.resume?.candidate ?? run.order.repair?.candidate;
      if (base) {
        if (await treeDigest(base.workspace, abort.signal) !== base.digest) {
          throw new Fault('CANDIDATE_CHANGED', 'Replacement base changed');
        }
        await snapshot(base.workspace, run.order.workspace, abort.signal, true);
        if (await treeDigest(run.order.workspace, abort.signal) !== base.digest ||
            await treeDigest(base.workspace, abort.signal) !== base.digest) {
          throw new Fault('CANDIDATE_CHANGED', 'Replacement base changed while copying');
        }
      } else await snapshot(this.options.source, run.order.workspace, abort.signal);
      abort.signal.throwIfAborted();
      if (!run.baseline) {
        const baseline = await this.freeze(run.order.workspace, abort.signal);
        abort.signal.throwIfAborted();
        run = this.store.recordBaseline(run.id, baseline);
      }
      const inputTreeDigest = await treeDigest(run.order.workspace, abort.signal);
      abort.signal.throwIfAborted();
      run = this.store.bindInput(run.id, inputTreeDigest);
      this.store.move(run.id, 'running');
      if (await this.pauseStopped(run.id, abort)) return;
      await runOwned(this.executor.create(run.order, { url: this.url, token }), abort.signal, this.options.attemptTimeoutMs);
      implementationCompleted = true;
      const current = this.store.get(run.id);
      if (!current.report) throw new Fault('RESULT_MISSING', 'Idle is not a structured submission');
      if (await this.pauseStopped(run.id, abort, true)) return;
      if (!current.verification) {
        const candidate = await this.freeze(current.order.workspace, abort.signal);
        abort.signal.throwIfAborted();
        if (await this.pauseStopped(run.id, abort, true)) return;
        this.store.recordSubmission(run.id, candidate);
      }
      else {
        this.store.move(run.id, 'freezing');
        const candidate = await this.freeze(current.order.workspace, abort.signal);
        abort.signal.throwIfAborted();
        this.store.queueVerification(run.id, candidate);
      }
    } catch (error) {
      const current = this.store.get(run.id);
      if (current.phase === 'pausing' && current.pause?.mode === 'interrupt' && abort.signal.aborted &&
          (error === abort.signal.reason || (error instanceof Fault && error.code === 'ABORTED'))) {
        try { if (await this.pauseStopped(run.id, abort, implementationCompleted)) return; }
        catch (pauseError) { this.fail(run.id, pauseError); return; }
      }
      this.fail(run.id, error);
    }
  }
  private fail(id: string, error: unknown): void {
    const code = error instanceof Fault ? error.code : 'EXECUTOR_FAILED';
    if (code === 'EXTERNAL_STATE_UNKNOWN') { this.closing = true; this.store.move(id, 'blocked', code); }
    else if (this.store.get(id).phase === 'stopping') this.store.move(id, 'cancelled');
    else this.store.move(id, 'failed', code);
  }
  private async freeze(workspace: string, signal: AbortSignal): Promise<Candidate> {
    const candidatePath = join(dirname(workspace), `candidate-${randomUUID()}`);
    const initial = await treeDigest(workspace, signal);
    await snapshot(workspace, candidatePath, signal, true);
    const hash = await treeDigest(candidatePath, signal);
    if (hash !== initial || await treeDigest(workspace, signal) !== initial) {
      throw new Fault('CANDIDATE_CHANGED', 'Implementation changed while freezing');
    }
    return { workspace: candidatePath, digest: hash };
  }
  /** Called only before process launch or after owned-exit confirmation. Never stores live work as resumable. */
  private async pauseStopped(id: string, abort: AbortController, implementationCompleted = false): Promise<boolean> {
    const current = this.store.get(id);
    if (current.phase !== 'pausing') return false;
    const stage = activityPhase(current);
    // An interrupt has already stopped the process. A separate cancellable copy phase now freezes its outputs.
    const copying = abort.signal.aborted ? new AbortController() : abort;
    const active = this.active.get(id);
    if (active) active.abort = copying;
    const signal = copying.signal;
    if (['verification_starting', 'reviewing', 'validating'].includes(stage)) {
      if (!current.candidate || await treeDigest(current.candidate.workspace, signal) !== current.candidate.digest) {
        throw new Fault('CANDIDATE_CHANGED', 'Paused verification candidate changed');
      }
      this.store.finishPause(id, { kind: 'verification', candidate: current.candidate });
    } else if (stage === 'starting') {
      // A partially copied directory is not recovery evidence. Resume must use a fresh full copy.
      this.store.finishPause(id, { kind: 'implementation' });
    } else {
      const candidate = await this.freeze(current.order.workspace, signal);
      this.store.finishPause(id, { kind: implementationCompleted || stage === 'freezing'
        ? (current.verification ? 'verification' : 'submitted') : 'implementation', candidate });
    }
    return true;
  }
  private async verify(run: Run, abort: AbortController): Promise<void> {
    const signal = abort.signal;
    const candidate = run.candidate;
    if (!candidate || await treeDigest(candidate.workspace, signal) !== candidate.digest) {
      throw new Fault('CANDIDATE_CHANGED', 'Queued verification candidate changed');
    }
    if (await this.pauseStopped(run.id, abort)) return;
    const { workspace: candidatePath, digest: hash } = candidate;
    const attemptId = randomUUID();
    const { repair: _repair, resume: _resume, ...independentOrder } = run.order;
    const reviewOrder: WorkOrder = { ...independentOrder, role: 'review', attemptId, workItemId: randomUUID(),
      dispatchKey: randomUUID(), candidateDigest: hash, inputTreeDigest: hash,
      inputDigest: digest(JSON.stringify({ input: run.order.inputDigest, candidate: hash, role: 'review' })),
      workspace: join(this.options.attemptsDirectory, attemptId, 'work') };
    const token = randomBytes(32).toString('hex');
    this.store.prepareReview(run.id, { workspace: candidatePath, digest: hash }, reviewOrder, token);
    await snapshot(candidatePath, reviewOrder.workspace, signal, true);
    if (await treeDigest(reviewOrder.workspace, signal) !== hash) throw new Fault('CANDIDATE_CHANGED', 'Review input differs');
    if (await this.pauseStopped(run.id, abort)) return;
    await runOwned(this.executor.create(reviewOrder, { url: this.url, token }), signal, this.options.attemptTimeoutMs);
    const reviewed = this.store.get(run.id);
    if (!reviewed.reviewAttempt?.report) throw new Fault('REVIEW_MISSING', 'Reviewer did not submit a structured assessment');
    const reviewUnchanged = await treeDigest(reviewOrder.workspace, signal) === hash;
    if (this.store.get(run.id).phase === 'pausing' && !reviewUnchanged) throw new Fault('CANDIDATE_CHANGED', 'Drained review changed its input');
    if (await this.pauseStopped(run.id, abort)) return;
    this.store.move(run.id, 'validating');
    const validationPath = join(dirname(run.order.workspace), `validation-${randomUUID()}`);
    await snapshot(candidatePath, validationPath, signal, true);
    if (await treeDigest(validationPath, signal) !== hash) throw new Fault('CANDIDATE_CHANGED', 'Acceptance input differs');
    const results: ValidationResult[] = [];
    let acceptanceIntegrity = true;
    for (const command of run.verification!.commands) {
      signal.throwIfAborted();
      if (await this.pauseStopped(run.id, abort)) return;
      const result = await validateCommand(command, validationPath, signal);
      results.push(result);
      this.store.recordValidation(run.id, result);
      if (!await inputsUnchanged(candidatePath, validationPath, signal)) { acceptanceIntegrity = false; break; }
    }
    const intact = reviewUnchanged && await treeDigest(candidatePath, signal) === hash;
    signal.throwIfAborted();
    if (this.store.get(run.id).phase === 'pausing' && (!intact || !acceptanceIntegrity)) throw new Fault('CANDIDATE_CHANGED', 'Paused verification inputs changed');
    if (await this.pauseStopped(run.id, abort)) return;
    this.store.finishGate(run.id, results, intact, acceptanceIntegrity);
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const [id, active] of this.active) {
      const run = this.store.get(id);
      if (['starting', 'running', 'freezing', 'reviewing', 'validating', 'verification_starting', 'pausing'].includes(run.phase)) this.store.move(id, 'stopping', 'Runtime shutdown');
      active.abort.abort();
    }
    await Promise.all([...this.active.values()].map(a => a.done));
  }
}
