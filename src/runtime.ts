import { randomBytes, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { Store, digest } from './store.js';
import { Fault, type Executor, type StartCommand, type CancelCommand, type Run,
  type VerificationPolicy, type WorkOrder, type ValidationResult, type ControlCommand, type Candidate,
  type IntegrationPolicy, type IntegrateCommand, type IntegrationStatus, type AbandonIntegrationCommand, type ResolveIntegrationCommand, type ReviseCommand } from './contracts.js';
import { activityPhase } from './kernel.js';
import { snapshot, treeDigest, treeManifest, inputsUnchanged } from './workspace.js';
import { compareManifests } from './artifacts.js';
import { scopeViolations } from './scope.js';
import { runOwned } from './owned-execution.js';
import { validateCommand } from './validation.js';
import { integrationPreview } from './integration-preview.js';
import { IntegrationEngine } from './integration-engine.js';
import { integrationRequest, integrationStatus } from './integration-journal.js';
import { resolveIntegration } from './resolution.js';
import { reviseRun } from './revision.js';

export interface RuntimeOptions {
  source: string;
  attemptsDirectory: string;
  maxConcurrency: number;
  attemptTimeoutMs: number;
  executionProfile: unknown;
  verification?: VerificationPolicy;
  integration?: IntegrationPolicy;
}
interface Active { abort: AbortController; done: Promise<void> }

export class Runtime {
  private readonly active = new Map<string, Active>();
  private closing = false;
  private url = '';
  private activeIntegration: { id: string; abort: AbortController; done: Promise<void> } | undefined;
  private readonly preparation = new Set<Promise<unknown>>();
  private readonly shutdown = new AbortController();
  constructor(readonly store: Store, private readonly executor: Executor, private readonly options: RuntimeOptions) {
    if (options.integration?.enabled && !options.verification) throw new Fault('CONFIG_INVALID', 'Integration requires verification commands');
  }
  get verificationEnabled(): boolean { return this.options.verification !== undefined; }
  get integrationEnabled(): boolean { return this.options.integration?.enabled === true; }
  get maxIterations(): number { return this.options.verification?.maxIterations ?? 1; }
  previewIntegration(id: string, artifactId: string | undefined, offset: number, limit: number, planId: string | undefined, signal: AbortSignal) {
    return integrationPreview(this.store, this.options.source, id, artifactId, offset, limit, planId, signal);
  }
  connect(url: string): void {
    this.store.bindProfile({ source: this.options.source, attemptsDirectory: this.options.attemptsDirectory,
      executionProfile: this.options.executionProfile,
      ...(this.integrationEnabled ? { integration: { enabled: true } } : {}),
      ...(this.options.verification ? { verification: this.options.verification } : {}) });
    this.url = url;
    this.store.recover();
    this.pump();
  }
  start(input: StartCommand): Run {
    if (this.closing) throw new Fault('UNAVAILABLE', 'Runtime is shutting down or an owned process is unconfirmed', 503);
    if (this.integrationEnabled && !this.activeIntegration && !this.store.integrations.pending().length && this.store.integrations.unresolved()) {
      throw new Fault('INTEGRATION_RECONCILIATION_REQUIRED', 'Resolve the retained integration before starting more work');
    }
    const run = this.store.start(input, this.options.attemptsDirectory, this.options.executionProfile, this.options.verification);
    queueMicrotask(() => this.pump());
    return run;
  }
  cancel(id: string, input: CancelCommand): Run {
    const run = this.store.cancel(id, input);
    if (this.store.get(id).phase === 'stopping') this.active.get(id)?.abort.abort();
    return run;
  }
  control(id: string, input: Exclude<ControlCommand, ReviseCommand>): Run {
    if (input.type === 'budget') return this.store.increaseBudget(id, input);
    if (this.store.get(id).integration && input.type === 'cancel') {
      const integration = this.store.get(id).integration!;
      if (['prepared', 'applying', 'snapshotting', 'validating'].includes(integration.phase)) {
        throw new Fault('INTEGRATION_CONTROL_REQUIRED', 'Cancel the integration using its own ID and revision');
      }
    }
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
  async revise(id: string, input: ReviseCommand, signal: AbortSignal): Promise<Run> {
    if (this.closing) throw new Fault('UNAVAILABLE', 'Runtime is shutting down or an owned process is unconfirmed', 503);
    const old = this.store.replayRevision(id, input); if (old) return old;
    if (this.activeIntegration) throw new Fault('INTEGRATION_BUSY', 'Wait for the integration writer to stop');
    const task = reviseRun(this.store, this.options.source, this.options.attemptsDirectory, id, input,
      AbortSignal.any([signal, this.shutdown.signal])).then(run => { queueMicrotask(() => this.pump()); return run; }).catch(error => {
      const committed = this.store.replayRevision(id, input); if (committed) return committed;
      throw error;
    });
    this.preparation.add(task);
    try { return await task; } finally { this.preparation.delete(task); }
  }
  async integrate(id: string, input: IntegrateCommand, signal: AbortSignal): Promise<IntegrationStatus> {
    if (!this.integrationEnabled) throw new Fault('CAPABILITY_MISSING', 'Integration is disabled by the operator', 422);
    if (this.closing) throw new Fault('UNAVAILABLE', 'Runtime is shutting down', 503);
    const request = integrationRequest(id, input);
    const old = this.store.integrations.replay(request);
    if (old) return integrationStatus(old);
    const task = new IntegrationEngine(this.store, this.options.source).prepare(id, input.expectedRevision, input.planId,
      AbortSignal.any([signal, this.shutdown.signal]), request).then(record => {
      queueMicrotask(() => this.pump()); return integrationStatus(record);
    }).catch(error => {
      // A concurrent identical request may have committed while this scan observed a changing
      // project. Its durable receipt wins over this redundant preparation's read error.
      const committed = this.store.integrations.replay(request);
      if (committed) return integrationStatus(committed);
      throw error;
    });
    this.preparation.add(task);
    try { return await task; } finally { this.preparation.delete(task); }
  }
  integrationStatus(runId: string, id: string): IntegrationStatus {
    const record = this.store.integrations.get(id);
    if (record.runId !== runId) throw new Fault('NOT_FOUND', 'Integration is not in this run', 404);
    return integrationStatus(record);
  }
  integrations(runId: string, offset: number, limit: number): { integrations: IntegrationStatus[]; nextOffset: number | null } {
    this.store.get(runId);
    const records = this.store.integrations.forRun(runId, offset, limit + 1);
    return { integrations: records.slice(0, limit).map(integrationStatus), nextOffset: records.length > limit ? offset + limit : null };
  }
  cancelIntegration(runId: string, id: string, input: CancelCommand): IntegrationStatus {
    const result = this.store.integrations.cancel(runId, id, input);
    const current = this.store.integrations.get(id);
    if (current.cancelRequested && this.activeIntegration?.id === id) this.activeIntegration.abort.abort();
    queueMicrotask(() => this.pump());
    return integrationStatus(result);
  }
  async abandonIntegration(runId: string, id: string, input: AbandonIntegrationCommand, signal: AbortSignal): Promise<IntegrationStatus> {
    if (!this.integrationEnabled) throw new Fault('CAPABILITY_MISSING', 'Integration is disabled by the operator', 422);
    if (this.closing) throw new Fault('UNAVAILABLE', 'Runtime is shutting down', 503);
    const request = integrationRequest(runId, input, id);
    const old = this.store.integrations.replay(request);
    if (old) return integrationStatus(old);
    if (this.activeIntegration?.id === id) throw new Fault('INTEGRATION_BUSY', 'Wait for the integration writer to stop');
    const task = new IntegrationEngine(this.store, this.options.source).abandon(runId, id, input,
      AbortSignal.any([signal, this.shutdown.signal])).then(record => { queueMicrotask(() => this.pump()); return integrationStatus(record); }).catch(error => {
      const committed = this.store.integrations.replay(request);
      if (committed) return integrationStatus(committed);
      throw error;
    });
    this.preparation.add(task);
    try { return await task; } finally { this.preparation.delete(task); }
  }
  async resolveIntegration(runId: string, id: string, input: ResolveIntegrationCommand, signal: AbortSignal): Promise<Run> {
    if (!this.integrationEnabled) throw new Fault('CAPABILITY_MISSING', 'Integration resolution is disabled by the operator', 422);
    if (this.closing) throw new Fault('UNAVAILABLE', 'Runtime is shutting down', 503);
    const request = integrationRequest(runId, input, id), old = this.store.integrations.replay<Run>(request);
    if (old) return old;
    if (this.activeIntegration) throw new Fault('INTEGRATION_BUSY', 'Wait for the integration writer to stop');
    const task = resolveIntegration(this.store, this.options.source, this.options.attemptsDirectory, this.options.executionProfile, runId, id, input,
      AbortSignal.any([signal, this.shutdown.signal])).then(run => { queueMicrotask(() => this.pump()); return run; }).catch(error => {
      const committed = this.store.integrations.replay<Run>(request); if (committed) return committed;
      throw error;
    });
    this.preparation.add(task);
    try { return await task; } finally { this.preparation.delete(task); }
  }
  private async checkContext(run: Run, signal: AbortSignal): Promise<void> {
    const context = run.order.resolution ?? run.order.revisionContext;
    if (!context) return;
    for (const input of Object.values(context.inputs)) {
      if (await treeDigest(input.workspace, signal) !== input.digest) throw new Fault(run.order.resolution ? 'RESOLUTION_CONTEXT_CHANGED' : 'REVISION_CONTEXT_CHANGED', 'Registered reference evidence changed');
    }
  }
  private async checkScope(run: Run, candidate: Candidate, signal: AbortSignal): Promise<void> {
    if (!run.order.spec) return; // Legacy records predate structured scope; do not invent prior authorization.
    if (!run.baseline) throw new Fault('SCOPE_BASELINE_MISSING', 'Scope verification requires the original baseline');
    const baseline = await treeManifest(run.baseline.workspace, signal), after = await treeManifest(candidate.workspace, signal);
    if (baseline.digest !== run.baseline.digest || after.digest !== candidate.digest) throw new Fault('ARTIFACT_CHANGED', 'Scope evidence changed');
    const violations = scopeViolations(run.order.spec.writeScope, compareManifests(baseline, after), baseline, after);
    signal.throwIfAborted();
    this.store.recordScopeCheck(run.id, { inputDigest: run.order.inputDigest, baselineDigest: baseline.digest, candidateDigest: after.digest, violations });
    if (violations.length) throw new Fault('SCOPE_VIOLATION', 'Candidate changes exceed the authorized write scope');
  }
  private pump(): void {
    if (this.closing || !this.url) return;
    if (this.activeIntegration) return;
    if (this.integrationEnabled) {
      const pending = this.store.integrations.pending()[0];
      if (pending) {
        // Drain existing Attempts before touching the source; do not start new source snapshots
        // or starve a pending integration with fresh worker dispatches.
        if (this.active.size) return;
        const record = this.store.integrations.claim(pending.id), abort = new AbortController();
        const done = Promise.resolve().then(async () => {
          await new IntegrationEngine(this.store, this.options.source).execute(record.id, abort.signal);
        }).finally(() => { this.activeIntegration = undefined; this.pump(); });
        this.activeIntegration = { id: record.id, abort, done };
        void done.catch(() => { this.closing = true; });
        return;
      }
      if (this.store.integrations.unresolved()) return;
    }
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
      const base = run.order.resume?.candidate ?? run.order.repair?.candidate ?? run.order.resolution?.inputs.current ?? run.order.revisionContext?.inputs.current;
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
      await this.checkContext(run, abort.signal);
      abort.signal.throwIfAborted();
      run = this.store.bindInput(run.id, inputTreeDigest);
      this.store.move(run.id, 'running');
      if (await this.pauseStopped(run.id, abort)) return;
      if (!this.store.reserveModelAttempt(run.id, run.order.attemptId)) { await this.pauseStopped(run.id, abort); return; }
      await runOwned(this.executor.create(run.order, { url: this.url, token }), abort.signal, this.options.attemptTimeoutMs);
      implementationCompleted = true;
      const current = this.store.get(run.id);
      if (!current.report) throw new Fault('RESULT_MISSING', 'Idle is not a structured submission');
      if (await this.pauseStopped(run.id, abort, true)) return;
      if (!current.verification) {
        const candidate = await this.freeze(current.order.workspace, abort.signal);
        await this.checkScope(current, candidate, abort.signal);
        abort.signal.throwIfAborted();
        if (await this.pauseStopped(run.id, abort, true)) return;
        this.store.recordSubmission(run.id, candidate);
      }
      else {
        this.store.move(run.id, 'freezing');
        const candidate = await this.freeze(current.order.workspace, abort.signal);
        await this.checkScope(current, candidate, abort.signal);
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
      await this.checkScope(current, candidate, signal);
      this.store.finishPause(id, { kind: implementationCompleted || stage === 'freezing'
        ? (current.verification ? 'verification' : 'submitted') : 'implementation', candidate });
    }
    return true;
  }
  private async verify(run: Run, abort: AbortController): Promise<void> {
    const signal = abort.signal;
    await this.checkContext(run, signal);
    const candidate = run.candidate;
    if (!candidate || await treeDigest(candidate.workspace, signal) !== candidate.digest) {
      throw new Fault('CANDIDATE_CHANGED', 'Queued verification candidate changed');
    }
    await this.checkScope(run, candidate, signal);
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
    if (!this.store.reserveModelAttempt(run.id, reviewOrder.attemptId)) { await this.pauseStopped(run.id, abort); return; }
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
    await this.checkContext(run, signal);
    if (intact) await this.checkScope(run, candidate, signal);
    this.store.finishGate(run.id, results, intact, acceptanceIntegrity);
  }
  async close(): Promise<void> {
    this.closing = true;
    this.shutdown.abort();
    this.activeIntegration?.abort.abort();
    for (const [id, active] of this.active) {
      const run = this.store.get(id);
      if (['starting', 'running', 'freezing', 'reviewing', 'validating', 'verification_starting', 'pausing'].includes(run.phase)) this.store.move(id, 'stopping', 'Runtime shutdown');
      active.abort.abort();
    }
    await Promise.allSettled([...this.preparation]);
    await Promise.all([...this.active.values()].map(a => a.done).concat(this.activeIntegration ? [this.activeIntegration.done] : []));
  }
}
