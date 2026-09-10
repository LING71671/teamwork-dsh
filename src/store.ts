import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { Fault, terminal, type Run, type Event, type StartCommand, type CancelCommand,
  type BridgeCommand, type Phase, type VerificationPolicy, type Candidate, type WorkOrder, type ValidationResult,
  type PauseCommand, type ResumeCommand, type PauseContinuation, type RoundEvidence, type ArtifactDescriptor, type ResolveIntegrationCommand,
  type ResolutionContext, type RevisionContext, type ReviseCommand, type ScopeCheck, type BudgetCommand, type ModelBudgetStatus,
  type AutomaticIntegration, startSchema, reviseSchema, budgetCommandSchema } from './contracts.js';
import { activityPhase, evaluateGate, receive, transition, repairEligible, repairFeedback } from './kernel.js';
import { IntegrationJournal, integrationStatus } from './integration-journal.js';

export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function roundEvidence(run: Run): RoundEvidence {
  const { report, checkpoint, candidate, reviewAttempt, validation, gateReasons, scopeCheck } = run;
  return { iteration: run.iteration ?? 1, order: run.order, finishedAt: run.updatedAt,
    ...(report ? { report } : {}), ...(checkpoint ? { checkpoint } : {}), ...(candidate ? { candidate } : {}),
    ...(reviewAttempt ? { reviewAttempt } : {}), ...(validation ? { validation } : {}), ...(gateReasons ? { gateReasons } : {}),
    ...(scopeCheck ? { scopeCheck } : {}) };
}

export class Store {
  private readonly db: DatabaseSync;
  readonly integrations: IntegrationJournal;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (id TEXT PRIMARY KEY, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, digest TEXT NOT NULL, response TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (run_id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials (attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS artifacts_by_run ON artifacts(run_id, id);
      CREATE TABLE IF NOT EXISTS model_budgets (root_run_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_reservations (attempt_id TEXT PRIMARY KEY, root_run_id TEXT NOT NULL, run_id TEXT NOT NULL, role TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automatic_integrations (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL, revision INTEGER NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_by_run ON events(run_id, cursor);`);
    this.integrations = new IntegrationJournal(this.db, (record, type) => {
      const row = this.db.prepare('SELECT data FROM runs WHERE id=?').get(record.runId);
      if (!row) return record; // Internal journal fixtures may have no Run; host preparation never does.
      const run = JSON.parse(row.data as string) as Run;
      const updated = { ...run, revision: run.revision + 1, updatedAt: new Date().toISOString() };
      if (record.integrated && !record.integrated.artifactId) record = { ...record, integrated: this.registerArtifact(updated, record.integrated, 'integrated') };
      this.save({ ...updated, integration: integrationStatus(record) }, type);
      return record;
    });
  }
  close(): void { this.db.close(); }
  bindProfile(profile: unknown): void {
    this.transaction(() => {
      const hash = digest(canonical(profile));
      const old = this.db.prepare("SELECT hash FROM metadata WHERE id='profile'").get();
      if (old && old.hash !== hash) throw new Fault('PROFILE_CHANGED', 'Use a new data directory when changing workspace or execution profile');
      this.db.prepare("INSERT OR IGNORE INTO metadata VALUES('profile',?)").run(hash);
    });
  }
  private transaction<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = body(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private command<T>(id: string, input: unknown, body: () => T): T {
    return this.transaction(() => {
      const hash = digest(canonical(input));
      const old = this.db.prepare('SELECT digest,response FROM commands WHERE id=?').get(id);
      if (old) {
        if (old.digest !== hash) throw new Fault('IDEMPOTENCY_CONFLICT', 'Command ID reused with a different payload');
        return JSON.parse(old.response as string) as T;
      }
      const response = body();
      this.db.prepare('INSERT INTO commands VALUES(?,?,?)').run(id, hash, JSON.stringify(response));
      return response;
    });
  }
  get(id: string): Run {
    const row = this.db.prepare('SELECT data FROM runs WHERE id=?').get(id);
    if (!row) throw new Fault('NOT_FOUND', 'Run does not exist', 404);
    const run = JSON.parse(row.data as string) as Run;
    if (run.budget) run.budget = this.modelBudget(run.budget.rootRunId);
    return run;
  }
  all(): Run[] {
    return this.db.prepare('SELECT id FROM runs').all().map(r => this.get(r.id as string));
  }
  private save(run: Run, type: string): Run {
    this.db.prepare('INSERT OR REPLACE INTO runs VALUES(?,?)').run(run.id, JSON.stringify(run));
    this.db.prepare('INSERT INTO events(run_id,revision,type,at) VALUES(?,?,?,?)')
      .run(run.id, run.revision, type, run.updatedAt);
    return run;
  }
  private modelBudget(rootRunId: string): ModelBudgetStatus {
    const row = this.db.prepare('SELECT data FROM model_budgets WHERE root_run_id=?').get(rootRunId);
    if (!row) throw new Fault('BUDGET_MISSING', 'Budget ledger is missing; dispatch is not authorized');
    return JSON.parse(row.data as string) as ModelBudgetStatus;
  }
  automatic(id: string): AutomaticIntegration {
    const row = this.db.prepare('SELECT data FROM automatic_integrations WHERE id=?').get(id);
    if (!row) throw new Fault('NOT_FOUND', 'Automatic integration intent does not exist', 404);
    return JSON.parse(row.data as string) as AutomaticIntegration;
  }
  pendingAutomatic(): AutomaticIntegration[] {
    return this.db.prepare("SELECT data FROM automatic_integrations WHERE json_extract(data,'$.state')='pending' ORDER BY rowid")
      .all().map(row => JSON.parse(row.data as string) as AutomaticIntegration);
  }
  private saveAutomatic(run: Run, intent: AutomaticIntegration, type: string): Run {
    this.db.prepare('INSERT OR REPLACE INTO automatic_integrations VALUES(?,?)').run(intent.id, JSON.stringify(intent));
    return this.save({ ...run, automaticIntegration: intent, revision: run.revision + 1, updatedAt: new Date().toISOString() }, type);
  }
  finishAutomatic(id: string, result: { integrationId: string } | { reason: string }): void {
    this.transaction(() => {
      const intent = this.automatic(id), run = this.get(intent.runId);
      if (intent.state !== 'pending' || run.automaticIntegration?.id !== id) return;
      this.saveAutomatic(run, { ...intent, state: 'integrationId' in result ? 'scheduled' : 'failed', ...result },
        'integrationId' in result ? 'automatic.integration_scheduled' : 'automatic.integration_failed');
    });
  }
  /** Reservation precedes executor creation. Failed/unknown dispatch is conservatively charged, never refunded. */
  reserveModelAttempt(id: string, attemptId: string): boolean {
    return this.transaction(() => {
      const run = this.get(id), review = run.reviewAttempt?.order.attemptId === attemptId;
      if (run.phase !== (review ? 'reviewing' : 'running') || (!review && run.order.attemptId !== attemptId)) throw new Fault('RESULT_STALE', 'Only the current launch may reserve model budget');
      if (!run.budget) return true;
      if (this.db.prepare('SELECT 1 FROM model_reservations WHERE attempt_id=?').get(attemptId)) throw new Fault('DISPATCH_ALREADY_RESERVED', 'This attempt may already have launched; never dispatch twice');
      const budget = run.budget, at = new Date().toISOString();
      if (budget.reservedModelAttempts >= budget.maxModelAttempts) {
        this.save({ ...run, phase: 'pausing', reason: 'BUDGET_EXHAUSTED', revision: run.revision + 1, updatedAt: at,
          pause: { mode: 'interrupt', stage: run.phase } }, 'run.budget_exhausted');
        return false;
      }
      const reserved = { ...budget, revision: budget.revision + 1, reservedModelAttempts: budget.reservedModelAttempts + 1 };
      this.db.prepare('UPDATE model_budgets SET data=? WHERE root_run_id=?').run(JSON.stringify(reserved), budget.rootRunId);
      this.db.prepare('INSERT INTO model_reservations VALUES(?,?,?,?,?)').run(attemptId, budget.rootRunId, id, review ? 'review' : 'implementation', at);
      this.save({ ...run, budget: reserved, revision: run.revision + 1, updatedAt: at }, 'attempt.budget_reserved');
      return true;
    });
  }
  increaseBudget(id: string, input: BudgetCommand): Run {
    input = budgetCommandSchema.parse(input);
    return this.command(`host:${input.commandId}`, { id, input }, () => {
      const run = this.get(id);
      if (run.revision !== input.expectedRevision) throw new Fault('REVISION_CONFLICT', 'Run changed before budget authorization');
      if (!run.budget || run.budget.rootRunId !== id) throw new Fault('BUDGET_ROOT_REQUIRED', 'Change the existing shared budget on its root Run only');
      if (run.budget.revision !== input.expectedBudgetRevision) throw new Fault('BUDGET_REVISION_CONFLICT', 'Shared budget changed; inspect its current revision');
      if (input.maxModelAttempts <= run.budget.maxModelAttempts) throw new Fault('BUDGET_NOT_INCREASED', 'An explicit allocation must increase the total limit');
      const budget = { ...run.budget, maxModelAttempts: input.maxModelAttempts, revision: run.budget.revision + 1,
        lastIncrease: { reason: input.reason, at: new Date().toISOString(), previousMaxModelAttempts: run.budget.maxModelAttempts } };
      this.db.prepare('UPDATE model_budgets SET data=? WHERE root_run_id=?').run(JSON.stringify(budget), id);
      return this.save({ ...run, budget, revision: run.revision + 1, updatedAt: new Date().toISOString() }, 'run.budget_increased');
    });
  }
  private registerArtifact(run: Run, candidate: Candidate, kind: ArtifactDescriptor['kind']): Candidate {
    const id = digest(canonical({ runId: run.id, workspace: candidate.workspace, digest: candidate.digest }));
    const record: ArtifactDescriptor & { workspace: string } = { id, runId: run.id, kind, digest: candidate.digest,
      attemptId: run.order.attemptId, workspace: candidate.workspace, createdAt: run.updatedAt, specRevision: run.order.specRevision,
      ...(run.baseline?.artifactId ? { baselineId: run.baseline.artifactId } : {}) };
    this.db.prepare('INSERT OR IGNORE INTO artifacts VALUES(?,?,?)').run(id, run.id, JSON.stringify(record));
    return { ...candidate, artifactId: id };
  }
  artifacts(id: string, offset = 0, limit = 100): { artifacts: ArtifactDescriptor[]; nextOffset: number | null } {
    this.get(id);
    const rows = this.db.prepare('SELECT data FROM artifacts WHERE run_id=? ORDER BY id LIMIT ? OFFSET ?').all(id, limit + 1, offset);
    return { artifacts: rows.slice(0, limit).map(row => {
      const { workspace: _workspace, ...descriptor } = JSON.parse(row.data as string) as ArtifactDescriptor & { workspace: string };
      return descriptor;
    }), nextOffset: rows.length > limit ? offset + limit : null };
  }
  artifact(id: string, artifactId: string): ArtifactDescriptor & { workspace: string } {
    const row = this.db.prepare('SELECT data FROM artifacts WHERE id=? AND run_id=?').get(artifactId, id);
    if (!row) throw new Fault('NOT_FOUND', 'Artifact is not registered for this run', 404);
    return JSON.parse(row.data as string) as ArtifactDescriptor & { workspace: string };
  }
  artifactBaseline(id: string, artifactId: string): ArtifactDescriptor & { workspace: string } {
    const artifact = this.artifact(id, artifactId), run = this.get(id);
    if (artifact.baselineId) return this.artifact(id, artifact.baselineId);
    const versions = [run, ...(run.specHistory ?? []).map(history => history.previous)];
    const version = artifact.specRevision !== undefined ? versions.find(value => value.order.specRevision === artifact.specRevision)
      : versions.find(value => [value.order, ...(value.history ?? []).map(round => round.order), ...(value.suspensions ?? []).map(round => round.order)]
        .some(order => order.attemptId === artifact.attemptId)) ?? (!run.specHistory?.length ? run : undefined);
    if (!version) throw new Fault('BASELINE_VERSION_UNKNOWN', 'Historical artifact cannot be matched to a specification baseline');
    if (!version.baseline?.artifactId) throw new Fault('BASELINE_MISSING', 'No baseline is registered for this artifact version');
    return this.artifact(id, version.baseline.artifactId);
  }
  recordBaseline(id: string, candidate: Candidate): Run {
    return this.transaction(() => {
      const run = this.get(id);
      if (run.baseline) throw new Fault('BASELINE_EXISTS', 'The original baseline may not be replaced');
      if (activityPhase(run) !== 'starting') throw new Fault('RESULT_STALE', 'Baseline must precede implementation');
      const baseline = this.registerArtifact(run, candidate, 'baseline');
      return this.save({ ...run, baseline, revision: run.revision + 1, updatedAt: new Date().toISOString() }, 'baseline.recorded');
    });
  }
  bindInput(id: string, inputTreeDigest: string): Run {
    return this.transaction(() => {
      const run = this.get(id);
      if (activityPhase(run) !== 'starting') throw new Fault('RESULT_STALE', 'Input must be bound before execution');
      if (run.order.inputTreeDigest) {
        if (run.order.inputTreeDigest !== inputTreeDigest) throw new Fault('INPUT_ALREADY_BOUND', 'Attempt input cannot be replaced');
        return run;
      }
      const order: WorkOrder = { ...run.order, inputTreeDigest,
        inputDigest: digest(canonical({ requestDigest: run.order.inputDigest, inputTreeDigest })) };
      return this.save({ ...run, order, revision: run.revision + 1, updatedAt: new Date().toISOString() }, 'attempt.input_bound');
    });
  }
  recordSubmission(id: string, candidate: Candidate): Run {
    return this.transaction(() => {
      const run = this.get(id);
      const bound = this.registerArtifact(run, candidate, 'candidate');
      const next = transition({ ...run, candidate: bound }, 'submitted', 'Report collected; verification is not configured');
      this.db.prepare("UPDATE outbox SET state='done' WHERE run_id=?").run(id);
      return this.save(next, 'attempt.submitted');
    });
  }
  start(input: StartCommand, workspace: string, executionProfile: unknown, verification?: VerificationPolicy): Run {
    input = startSchema.parse(input);
    return this.command(`host:${input.commandId}`, { type: 'start', input }, () => {
      const id = randomUUID(), attemptId = randomUUID();
      const at = new Date().toISOString();
      const spec = input.spec ?? { requirements: [], writeScope: { files: [], trees: ['.'] } };
      const order = { runId: id, workItemId: randomUUID(), attemptId, dispatchKey: randomUUID(),
        epoch: 1, specRevision: 1, objective: input.objective, spec,
        inputDigest: digest(canonical({ objective: input.objective, spec, workspace, executionProfile,
          ...(verification ? { verification } : {}), ...(input.budget ? { budget: input.budget } : {}), ...(input.autonomy ? { autonomy: input.autonomy } : {}) })),
        workspace: join(workspace, attemptId, 'work') };
      const run: Run = { id, revision: 0, phase: 'queued', gate: 'not_evaluated', order, iteration: 1, history: [], createdAt: at, updatedAt: at,
        ...(input.autonomy ? { autonomy: input.autonomy } : {}),
        ...(verification ? { verification } : {}), ...(input.budget ? { budget: { rootRunId: id, revision: 0,
          maxModelAttempts: input.budget.maxModelAttempts, reservedModelAttempts: 0 } } : {}) };
      if (run.budget) this.db.prepare('INSERT INTO model_budgets VALUES(?,?)').run(id, JSON.stringify(run.budget));
      this.save(run, 'run.created');
      this.db.prepare('INSERT INTO outbox VALUES(?,?)').run(id, 'pending');
      return run;
    });
  }
  resolveIntegration(parentId: string, integrationId: string, input: ResolveIntegrationCommand, workspace: string,
    executionProfile: unknown, context: ResolutionContext): Run {
    return this.integrations.resolve(parentId, integrationId, input, () => {
      const parent = this.get(parentId);
      const job = this.integrations.get(integrationId);
      if (job.gateInputDigest !== parent.order.inputDigest || job.candidate.artifactId !== parent.candidate?.artifactId) throw new Fault('INTEGRATION_GATE_STALE', 'Integration no longer belongs to the current candidate');
      if (parent.phase !== 'verified' || parent.gate !== 'passed' || !parent.verification ||
        parent.candidate?.digest !== context.inputs.proposal.digest || parent.baseline?.digest !== context.inputs.base.digest) {
        throw new Fault('INTEGRATION_GATE_STALE', 'Parent candidate or baseline changed');
      }
      if (context.parentRunId !== parentId || context.integrationId !== integrationId || context.planId !== input.planId) throw new Fault('RESOLUTION_IDENTITY', 'Resolution inputs do not match the command');
      const id = randomUUID(), attemptId = randomUUID(), at = new Date().toISOString();
      let run: Run = { id, revision: 0, phase: 'queued', gate: 'not_evaluated', iteration: 1, history: [], createdAt: at, updatedAt: at,
        verification: parent.verification, parentRunId: parent.id, ...(parent.budget ? { budget: parent.budget } : {}),
        ...(parent.autonomy ? { autonomy: parent.autonomy } : {}),
        order: { runId: id, workItemId: randomUUID(), attemptId, dispatchKey: randomUUID(), epoch: 1, specRevision: parent.order.specRevision + 1,
          objective: parent.order.objective, ...(parent.order.spec ? { spec: parent.order.spec } : {}),
          workspace: join(workspace, attemptId, 'work'), inputDigest: '', resolution: context } };
      const current = this.registerArtifact(run, context.inputs.current, 'baseline');
      const resolution: ResolutionContext = { ...context, inputs: {
        current, base: this.registerArtifact(run, context.inputs.base, 'context'), proposal: this.registerArtifact(run, context.inputs.proposal, 'context'),
      } };
      run = { ...run, baseline: current, order: { ...run.order, resolution,
        inputDigest: digest(canonical({ parentInput: parent.order.inputDigest, resolution, executionProfile, verification: parent.verification })) } };
      this.save(run, 'run.resolution_created');
      this.db.prepare('INSERT INTO outbox VALUES(?,?)').run(id, 'pending');
      return run;
    });
  }
  contextScope(attemptId: string, token: string): { runId: string; context: ResolutionContext | RevisionContext } {
    const credential = this.db.prepare('SELECT run_id,hash FROM credentials WHERE attempt_id=?').get(attemptId);
    if (!credential || credential.hash !== digest(token)) throw new Fault('UNAUTHORIZED', 'Invalid attempt credential', 401);
    const run = this.get(credential.run_id as string), review = run.reviewAttempt?.order.attemptId === attemptId;
    const order = review ? run.reviewAttempt!.order : run.order;
    if (order.attemptId !== attemptId || activityPhase(run) !== (review ? 'reviewing' : 'running') ||
      (run.phase === 'pausing' && run.pause?.mode !== 'drain') || (review ? run.reviewAttempt!.report : run.report)) throw new Fault('RESULT_STALE', 'Attempt is no longer allowed to inspect resolution inputs');
    const context = order.resolution ?? order.revisionContext;
    if (!context) throw new Fault('CONTEXT_MISSING', 'This attempt has no registered reference context', 403);
    return { runId: run.id, context };
  }
  replayRevision(id: string, input: ReviseCommand): Run | undefined {
    const row = this.db.prepare('SELECT digest,response FROM commands WHERE id=?').get(`host:${input.commandId}`);
    if (!row) return undefined;
    if (row.digest !== digest(canonical({ id, input }))) throw new Fault('IDEMPOTENCY_CONFLICT', 'Command ID reused with a different payload');
    return JSON.parse(row.response as string) as Run;
  }
  revisionImpact(id: string, input: ReviseCommand): Run[] {
    const run = this.get(id);
    if (run.revision !== input.expectedRevision) throw new Fault('REVISION_CONFLICT', 'Run changed before revision');
    const stopped = ['queued', 'repair_queued', 'verification_queued', 'paused', 'submitted', 'verified', 'rejected', 'failed', 'cancelled'];
    if (!stopped.includes(run.phase)) throw new Fault('REVISION_NOT_READY', 'Pause/stop the current attempt and prove exit before revising');
    if (run.order.objective === input.objective && canonical(run.order.spec ?? { requirements: [], writeScope: { files: [], trees: ['.'] } }) === canonical(input.spec)) {
      throw new Fault('SPEC_UNCHANGED', 'A revision must change the objective or structured specification, not merely restart the same work');
    }
    if (this.integrations.unresolved() || this.integrations.pending().length) throw new Fault('INTEGRATION_RECONCILIATION_REQUIRED', 'Finish or resolve the source integration before revising');
    const all = this.all(), ids = new Set([id]), descendants: Run[] = [];
    for (let changed = true; changed;) {
      changed = false;
      for (const child of all) if (!ids.has(child.id) && ids.has(child.parentRunId ?? child.order.resolution?.parentRunId ?? '')) {
        ids.add(child.id); descendants.push(child); changed = true;
      }
    }
    if (descendants.some(child => !stopped.includes(child.phase) && child.phase !== 'superseded')) {
      throw new Fault('REVISION_ACTIVE_DESCENDANTS', 'Pause/stop all derived attempts first; unknown processes cannot be superseded');
    }
    return descendants;
  }
  revise(id: string, input: ReviseCommand, context: RevisionContext, workspace: string): Run {
    input = reviseSchema.parse(input);
    return this.command(`host:${input.commandId}`, { id, input }, () => {
      const descendants = this.revisionImpact(id, input), old = this.get(id);
      if (context.previousSpecRevision !== old.order.specRevision || context.reason !== input.reason) throw new Fault('REVISION_CONTEXT_STALE', 'Revision references do not match the previous specification');
      const attemptId = randomUUID(), at = new Date().toISOString(), specRevision = old.order.specRevision + 1;
      const { specHistory: _history, ...previous } = old;
      if (old.automaticIntegration && ['pending', 'paused'].includes(old.automaticIntegration.state)) {
        const intent = { ...old.automaticIntegration, state: 'cancelled', reason: 'SPEC_REVISED' };
        this.db.prepare('UPDATE automatic_integrations SET data=? WHERE id=?').run(JSON.stringify(intent), intent.id);
      }
      const parentRunId = old.parentRunId ?? old.order.resolution?.parentRunId;
      let run: Run = { id, revision: old.revision + 1, phase: 'queued', gate: 'not_evaluated', iteration: 1, history: [],
        createdAt: old.createdAt, updatedAt: at,
        ...(old.budget ? { budget: old.budget } : {}),
        ...(input.autonomy ? { autonomy: input.autonomy } : {}),
        ...(old.verification ? { verification: old.verification } : {}), ...(parentRunId ? { parentRunId } : {}),
        specHistory: [...(old.specHistory ?? []), { reason: input.reason, at, previous }],
        order: { runId: id, workItemId: old.order.workItemId, attemptId, dispatchKey: randomUUID(), epoch: old.order.epoch + 1,
          specRevision, objective: input.objective, spec: input.spec, workspace: join(workspace, attemptId, 'work'), inputDigest: '' } };
      const current = this.registerArtifact(run, context.inputs.current, 'baseline');
      const revisionContext: RevisionContext = { ...context, inputs: { current,
        ...(context.inputs.base ? { base: this.registerArtifact(run, context.inputs.base, 'context') } : {}),
        ...(context.inputs.proposal ? { proposal: this.registerArtifact(run, context.inputs.proposal, 'context') } : {}) } };
      run = { ...run, baseline: current, order: { ...run.order, revisionContext,
        inputDigest: digest(canonical({ previousInput: old.order.inputDigest, objective: input.objective, spec: input.spec, specRevision,
          epoch: run.order.epoch, revisionContext, verification: old.verification, ...(input.autonomy ? { autonomy: input.autonomy } : {}) })) } };
      for (const child of descendants) {
        if (child.phase === 'superseded') continue;
        if (child.automaticIntegration && ['pending', 'paused'].includes(child.automaticIntegration.state)) {
          const intent = { ...child.automaticIntegration, state: 'cancelled' as const, reason: 'PARENT_SPEC_REVISED' };
          this.db.prepare('UPDATE automatic_integrations SET data=? WHERE id=?').run(JSON.stringify(intent), intent.id);
          child.automaticIntegration = intent;
        }
        this.save({ ...child, phase: 'superseded', gate: 'not_evaluated', revision: child.revision + 1, updatedAt: at,
          supersededBy: { runId: id, specRevision }, reason: 'PARENT_SPEC_REVISED' }, 'run.superseded');
        this.db.prepare("UPDATE outbox SET state='done' WHERE run_id=?").run(child.id);
      }
      this.save(run, 'run.spec_revised');
      this.db.prepare("UPDATE outbox SET state='pending' WHERE run_id=?").run(id);
      return run;
    });
  }
  pending(): string[] {
    return this.db.prepare("SELECT run_id FROM outbox JOIN runs ON runs.id=outbox.run_id WHERE state='pending' ORDER BY json_extract(runs.data,'$.updatedAt'),run_id")
      .all().map(r => r.run_id as string);
  }
  claim(id: string, token: string): Run {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT state FROM outbox WHERE run_id=?').get(id);
      if (row?.state !== 'pending') throw new Fault('DISPATCH_CLAIMED', 'Dispatch is already owned');
      let current = this.get(id);
      if (current.phase === 'repair_queued') {
        if (!repairEligible(current, current.gateReasons ?? [])) throw new Fault('REPAIR_INVALID', 'Repair requires complete failed-round evidence and remaining budget');
        const attemptId = randomUUID();
        const repair = { candidate: current.candidate!, feedback: repairFeedback(current) };
        const { report: _report, checkpoint: _checkpoint, candidate: _candidate, reviewAttempt: _reviewAttempt,
          validation: _validation, gateReasons: _gateReasons, scopeCheck: _scopeCheck, reason: _reason, ...retained } = current;
        const history = [...(current.history ?? []), roundEvidence(current)];
        const { resume: _resume, inputTreeDigest: _inputTree, ...previousOrder } = current.order;
        const order: WorkOrder = { ...previousOrder, attemptId, dispatchKey: randomUUID(), epoch: current.order.epoch + 1,
          role: 'implementation', workspace: join(dirname(dirname(current.order.workspace)), attemptId, 'work'),
          inputDigest: digest(canonical({ previousInput: current.order.inputDigest, repair, epoch: current.order.epoch + 1 })), repair };
        current = { ...retained, order, iteration: (current.iteration ?? 1) + 1, history, gate: 'not_evaluated' };
      }
      const verifying = current.phase === 'verification_queued';
      const run = transition(current, verifying ? 'verification_starting' : 'starting');
      this.db.prepare("UPDATE outbox SET state='claimed' WHERE run_id=?").run(id);
      if (!verifying) this.db.prepare('INSERT INTO credentials VALUES(?,?,?)').run(run.order.attemptId, id, digest(token));
      return this.save(run, verifying ? 'verification.claimed' : 'attempt.claimed');
    });
  }
  move(id: string, phase: Phase, reason?: string): Run {
    return this.transaction(() => {
      const run = this.save(transition(this.get(id), phase, reason), `attempt.${phase}`);
      if (terminal(phase)) this.db.prepare("UPDATE outbox SET state='done' WHERE run_id=?").run(id);
      return run;
    });
  }
  cancel(id: string, input: CancelCommand): Run {
    return this.command(`host:${input.commandId}`, { id, input }, () => {
      const run = this.get(id);
      if (run.revision !== input.expectedRevision) throw new Fault('REVISION_CONFLICT', `Current revision is ${run.revision}`);
      if (run.automaticIntegration && ['pending', 'paused'].includes(run.automaticIntegration.state)) {
        return this.saveAutomatic(run, { ...run.automaticIntegration, state: 'cancelled', reason: 'USER_CANCELLED' }, 'automatic.integration_cancelled');
      }
      if (terminal(run.phase) || run.phase === 'stopping') return run;
      const next = this.save(transition(run, ['queued', 'repair_queued', 'verification_queued', 'paused'].includes(run.phase) ? 'cancelled' : 'stopping'), 'run.cancel_requested');
      if (next.phase === 'cancelled') this.db.prepare("UPDATE outbox SET state='done' WHERE run_id=?").run(id);
      return next;
    });
  }
  pause(id: string, input: PauseCommand): Run {
    return this.command(`host:${input.commandId}`, { id, input }, () => {
      const run = this.get(id);
      if (run.revision !== input.expectedRevision) throw new Fault('REVISION_CONFLICT', `Current revision is ${run.revision}`);
      if (run.phase === 'verified' && run.automaticIntegration && ['pending', 'paused'].includes(run.automaticIntegration.state)) {
        if (run.automaticIntegration.state === 'paused') return run;
        return this.saveAutomatic(run, { ...run.automaticIntegration, state: 'paused' }, 'automatic.integration_paused');
      }
      if (terminal(run.phase) || run.phase === 'stopping') throw new Fault('NOT_PAUSABLE', 'Run is not accepting pause');
      if (run.phase === 'paused' || (run.phase === 'pausing' && run.pause!.mode === input.mode)) return run;
      if (run.phase === 'pausing' && input.mode !== 'interrupt') throw new Fault('PAUSE_IN_PROGRESS', 'An interrupt cannot be downgraded to drain');
      const stage = activityPhase(run);
      const queued = stage === 'queued' || stage === 'repair_queued' || stage === 'verification_queued';
      const next: Run = { ...run, phase: queued ? 'paused' : 'pausing', revision: run.revision + 1, updatedAt: new Date().toISOString(),
        pause: { mode: input.mode, stage, ...(queued ? { continuation: { kind: 'queued', phase: stage } as PauseContinuation } : {}) } };
      if (queued) this.db.prepare("UPDATE outbox SET state='paused' WHERE run_id=?").run(id);
      return this.save(next, queued ? 'run.paused' : 'run.pause_requested');
    });
  }
  finishPause(id: string, continuation: PauseContinuation): Run {
    return this.transaction(() => {
      const run = this.get(id);
      if (run.phase !== 'pausing') throw new Fault('PAUSE_STALE', 'Pause is no longer pending');
      if ('candidate' in continuation && continuation.candidate) {
        continuation = { ...continuation, candidate: this.registerArtifact(run, continuation.candidate,
          continuation.kind === 'implementation' ? 'checkpoint' : 'candidate') };
      }
      const next = transition({ ...run, pause: { ...run.pause!, continuation },
        ...(['verification', 'submitted'].includes(continuation.kind) && 'candidate' in continuation ? { candidate: continuation.candidate! } : {}) }, 'paused');
      this.db.prepare("UPDATE outbox SET state='paused' WHERE run_id=?").run(id);
      return this.save(next, 'run.paused');
    });
  }
  resume(id: string, input: ResumeCommand): Run {
    return this.command(`host:${input.commandId}`, { id, input }, () => {
      const run = this.get(id);
      if (run.revision !== input.expectedRevision) throw new Fault('REVISION_CONFLICT', `Current revision is ${run.revision}`);
      if (run.phase === 'verified' && run.automaticIntegration?.state === 'paused') {
        return this.saveAutomatic(run, { ...run.automaticIntegration, state: 'pending' }, 'automatic.integration_resumed');
      }
      if (run.phase !== 'paused' || !run.pause?.continuation) throw new Fault('NOT_PAUSED', 'Only a fully paused run may resume');
      const plan = run.pause.continuation;
      if (plan.kind !== 'submitted' && run.budget && run.budget.reservedModelAttempts >= run.budget.maxModelAttempts) throw new Fault('BUDGET_EXHAUSTED', 'Authorize more budget on the root Run before resuming');
      let next = run;
      if (plan.kind === 'implementation' || plan.kind === 'verification') {
        const { report, checkpoint, candidate: _candidate, reviewAttempt: _review, validation: _validation,
          gateReasons: _reasons, scopeCheck: _scopeCheck, reason: _reason, ...retained } = run;
        const suspensions = [...(run.suspensions ?? []), roundEvidence(run)];
        if (plan.kind === 'implementation') {
          const attemptId = randomUUID();
          const resume = { previousAttemptId: run.order.attemptId, ...(plan.candidate ? { candidate: plan.candidate } : {}), ...(checkpoint ? { checkpoint } : {}) };
          const { inputTreeDigest: _inputTree, ...previousOrder } = run.order;
          const order: WorkOrder = { ...previousOrder, attemptId, dispatchKey: randomUUID(), epoch: run.order.epoch + 1, resume,
            workspace: join(dirname(dirname(run.order.workspace)), attemptId, 'work'),
            inputDigest: digest(canonical({ previousInput: run.order.inputDigest, resume, epoch: run.order.epoch + 1 })) };
          next = { ...retained, order, suspensions, gate: 'not_evaluated' };
        } else next = { ...retained, suspensions, candidate: plan.candidate, gate: 'not_evaluated',
          ...(report ? { report } : {}), ...(checkpoint ? { checkpoint } : {}) };
      }
      const phase = plan.kind === 'queued' ? plan.phase : plan.kind === 'verification' ? 'verification_queued' : plan.kind === 'submitted' ? 'submitted' : 'queued';
      const result = transition(next, phase);
      this.db.prepare('UPDATE outbox SET state=? WHERE run_id=?').run(phase === 'submitted' ? 'done' : 'pending', id);
      return this.save(result, 'run.resumed');
    });
  }
  queueVerification(id: string, candidate: Candidate): Run {
    return this.transaction(() => {
      const current = this.get(id);
      const run = transition({ ...current, candidate: this.registerArtifact(current, candidate, 'candidate') }, 'verification_queued');
      if (run.phase === 'pausing') {
        const paused = transition({ ...run, pause: { ...run.pause!, continuation: { kind: 'queued', phase: 'verification_queued' } } }, 'paused');
        this.db.prepare("UPDATE outbox SET state='paused' WHERE run_id=?").run(id);
        return this.save(paused, 'run.paused');
      }
      this.db.prepare("UPDATE outbox SET state='pending' WHERE run_id=?").run(id);
      return this.save(run, 'candidate.verification_queued');
    });
  }
  bridge(attemptId: string, token: string, kind: 'checkpoint' | 'submit', input: BridgeCommand): Run {
    // Authenticate even when replaying an already committed command.
    const credential = this.db.prepare('SELECT run_id,hash FROM credentials WHERE attempt_id=?').get(attemptId);
    if (!credential || credential.hash !== digest(token)) throw new Fault('UNAUTHORIZED', 'Invalid attempt credential', 401);
    return this.command(`attempt:${attemptId}:${input.commandId}`, { kind, input }, () => {
      const run = this.get(credential.run_id as string);
      const reviewing = run.reviewAttempt?.order.attemptId === attemptId;
      const order = reviewing ? run.reviewAttempt!.order : run.order;
      if (attemptId !== order.attemptId || input.epoch !== order.epoch || input.inputDigest !== order.inputDigest) {
        throw new Fault('RESULT_STALE', 'Attempt epoch or input digest does not match');
      }
      if (reviewing) {
        if (activityPhase(run) !== 'reviewing' || (run.phase === 'pausing' && run.pause?.mode !== 'drain')) {
          throw new Fault('RESULT_STALE', 'Review attempt is no longer accepting results');
        }
        if (run.reviewAttempt!.report) throw new Fault('RESULT_ALREADY_SUBMITTED', 'Review already submitted');
        if (kind === 'submit' && !input.report.review) throw new Fault('REVIEW_REQUIRED', 'A review must assess functionality and completeness');
        return this.save({ ...run, revision: run.revision + 1, updatedAt: new Date().toISOString(),
          reviewAttempt: { ...run.reviewAttempt!, [kind === 'submit' ? 'report' : 'checkpoint']: input.report } }, `review.${kind}_received`);
      }
      return this.save(receive(run, kind, input.report), `attempt.${kind}_received`);
    });
  }
  prepareReview(id: string, candidate: Candidate, order: WorkOrder, token: string): Run {
    return this.transaction(() => {
      const run = transition(this.get(id), 'reviewing');
      this.db.prepare('INSERT INTO credentials VALUES(?,?,?)').run(order.attemptId, id, digest(token));
      return this.save({ ...run, candidate: this.registerArtifact(run, candidate, 'candidate'), reviewAttempt: { order } }, 'review.dispatch_intent');
    });
  }
  finishGate(id: string, validation: ValidationResult[], integrity: boolean, acceptanceIntegrity = true): Run {
    return this.transaction(() => {
      const run = { ...this.get(id), validation };
      if (run.phase !== 'validating') throw new Fault('RESULT_STALE', 'Gate no longer accepting results');
      const reasons = evaluateGate(run, integrity, acceptanceIntegrity);
      const repair = repairEligible(run, reasons);
      const result = transition({ ...run, gate: reasons.length ? 'failed' : 'passed', gateReasons: reasons },
        reasons.length ? (repair ? 'repair_queued' : 'rejected') : 'verified');
      this.db.prepare('UPDATE outbox SET state=? WHERE run_id=?').run(repair ? 'pending' : 'done', id);
      const saved = this.save(result, repair ? 'gate.failed_repair_queued' : `gate.${result.gate}`);
      if (!reasons.length && result.autonomy?.integration === 'on-gate-pass') {
        return this.saveAutomatic(saved, { id: randomUUID(), runId: id, inputDigest: result.order.inputDigest,
          candidateId: result.candidate!.artifactId!, state: 'pending' }, 'automatic.integration_queued');
      }
      return saved;
    });
  }
  recordScopeCheck(id: string, check: ScopeCheck): void {
    this.transaction(() => {
      const run = this.get(id);
      if (!['running', 'freezing', 'verification_starting', 'reviewing', 'validating'].includes(activityPhase(run))) throw new Fault('RESULT_STALE', 'Scope evidence is no longer accepted');
      if (check.baselineDigest !== run.baseline?.digest) throw new Fault('SCOPE_BASELINE_STALE', 'Scope evidence must use the original run baseline');
      if (check.inputDigest !== run.order.inputDigest) throw new Fault('RESULT_STALE', 'Scope evidence belongs to another attempt input');
      this.save({ ...run, scopeCheck: check, revision: run.revision + 1, updatedAt: new Date().toISOString() }, 'candidate.scope_checked');
    });
  }
  recordValidation(id: string, result: ValidationResult): void {
    this.transaction(() => {
      const run = this.get(id);
      if (activityPhase(run) !== 'validating') throw new Fault('RESULT_STALE', 'Acceptance is no longer active');
      const results = run.validation ?? [];
      if (run.verification?.commands[results.length]?.id !== result.commandId) throw new Fault('ACCEPTANCE_ORDER', 'Unexpected acceptance result');
      this.save({ ...run, validation: [...results, result], revision: run.revision + 1, updatedAt: new Date().toISOString() }, 'acceptance.command_finished');
    });
  }
  events(id: string, after: number): Event[] {
    this.get(id);
    return this.db.prepare('SELECT * FROM events WHERE run_id=? AND cursor>? ORDER BY cursor LIMIT 500')
      .all(id, after).map(r => ({ cursor: r.cursor as number, runId: r.run_id as string,
        revision: r.revision as number, type: r.type as string, at: r.at as string }));
  }
  recover(): void {
    // A claimed stdio process cannot be reattached. Never re-dispatch its workspace.
    for (const run of this.all()) if (['starting', 'running', 'stopping', 'freezing', 'reviewing', 'validating', 'verification_starting', 'pausing'].includes(run.phase)) {
      this.move(run.id, 'blocked', 'EXTERNAL_STATE_UNKNOWN: previous process exit is unproved; workspace quarantined');
    }
  }
}
