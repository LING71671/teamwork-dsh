import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { Fault, terminal, type Run, type Event, type StartCommand, type CancelCommand,
  type BridgeCommand, type Phase, type VerificationPolicy, type Candidate, type WorkOrder, type ValidationResult,
  type PauseCommand, type ResumeCommand, type PauseContinuation, type RoundEvidence, type ArtifactDescriptor } from './contracts.js';
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
  const { report, checkpoint, candidate, reviewAttempt, validation, gateReasons } = run;
  return { iteration: run.iteration ?? 1, order: run.order, finishedAt: run.updatedAt,
    ...(report ? { report } : {}), ...(checkpoint ? { checkpoint } : {}), ...(candidate ? { candidate } : {}),
    ...(reviewAttempt ? { reviewAttempt } : {}), ...(validation ? { validation } : {}), ...(gateReasons ? { gateReasons } : {}) };
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
    return JSON.parse(row.data as string) as Run;
  }
  all(): Run[] {
    return this.db.prepare('SELECT data FROM runs').all().map(r => JSON.parse(r.data as string) as Run);
  }
  private save(run: Run, type: string): Run {
    this.db.prepare('INSERT OR REPLACE INTO runs VALUES(?,?)').run(run.id, JSON.stringify(run));
    this.db.prepare('INSERT INTO events(run_id,revision,type,at) VALUES(?,?,?,?)')
      .run(run.id, run.revision, type, run.updatedAt);
    return run;
  }
  private registerArtifact(run: Run, candidate: Candidate, kind: ArtifactDescriptor['kind']): Candidate {
    const id = digest(canonical({ runId: run.id, workspace: candidate.workspace, digest: candidate.digest }));
    const record: ArtifactDescriptor & { workspace: string } = { id, runId: run.id, kind, digest: candidate.digest,
      attemptId: run.order.attemptId, workspace: candidate.workspace, createdAt: run.updatedAt };
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
    return this.command(`host:${input.commandId}`, { type: 'start', input }, () => {
      const id = randomUUID(), attemptId = randomUUID();
      const at = new Date().toISOString();
      const order = { runId: id, workItemId: randomUUID(), attemptId, dispatchKey: randomUUID(),
        epoch: 1, specRevision: 1, objective: input.objective,
        inputDigest: digest(canonical({ objective: input.objective, workspace, executionProfile,
          ...(verification ? { verification } : {}) })),
        workspace: join(workspace, attemptId, 'work') };
      const run: Run = { id, revision: 0, phase: 'queued', gate: 'not_evaluated', order, iteration: 1, history: [], createdAt: at, updatedAt: at,
        ...(verification ? { verification } : {}) };
      this.save(run, 'run.created');
      this.db.prepare('INSERT INTO outbox VALUES(?,?)').run(id, 'pending');
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
        const { report, checkpoint, candidate, reviewAttempt, validation, gateReasons, reason: _reason, ...retained } = current;
        const history = [...(current.history ?? []), {
          iteration: current.iteration ?? 1, order: current.order, finishedAt: current.updatedAt,
          ...(report ? { report } : {}), ...(checkpoint ? { checkpoint } : {}),
          ...(candidate ? { candidate } : {}), ...(reviewAttempt ? { reviewAttempt } : {}),
          ...(validation ? { validation } : {}), ...(gateReasons ? { gateReasons } : {}),
        }];
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
      if (run.phase !== 'paused' || !run.pause?.continuation) throw new Fault('NOT_PAUSED', 'Only a fully paused run may resume');
      const plan = run.pause.continuation;
      let next = run;
      if (plan.kind === 'implementation' || plan.kind === 'verification') {
        const { report, checkpoint, candidate: _candidate, reviewAttempt: _review, validation: _validation,
          gateReasons: _reasons, reason: _reason, ...retained } = run;
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
      return this.save(result, repair ? 'gate.failed_repair_queued' : `gate.${result.gate}`);
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
