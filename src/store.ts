import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Fault, terminal, type Run, type Event, type StartCommand, type CancelCommand,
  type BridgeCommand, type Phase, type VerificationPolicy, type Candidate, type WorkOrder, type ValidationResult } from './contracts.js';
import { evaluateGate, receive, transition } from './kernel.js';

export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

export class Store {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (id TEXT PRIMARY KEY, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, digest TEXT NOT NULL, response TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (run_id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials (attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL, revision INTEGER NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_by_run ON events(run_id, cursor);`);
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
  start(input: StartCommand, workspace: string, executionProfile: unknown, verification?: VerificationPolicy): Run {
    return this.command(`host:${input.commandId}`, { type: 'start', input }, () => {
      const id = randomUUID(), attemptId = randomUUID();
      const at = new Date().toISOString();
      const order = { runId: id, workItemId: randomUUID(), attemptId, dispatchKey: randomUUID(),
        epoch: 1, specRevision: 1, objective: input.objective,
        inputDigest: digest(canonical({ objective: input.objective, workspace, executionProfile,
          ...(verification ? { verification } : {}) })),
        workspace: join(workspace, attemptId, 'work') };
      const run: Run = { id, revision: 0, phase: 'queued', gate: 'not_evaluated', order, createdAt: at, updatedAt: at,
        ...(verification ? { verification } : {}) };
      this.save(run, 'run.created');
      this.db.prepare('INSERT INTO outbox VALUES(?,?)').run(id, 'pending');
      return run;
    });
  }
  pending(): string[] {
    return this.db.prepare("SELECT run_id FROM outbox WHERE state='pending'").all().map(r => r.run_id as string);
  }
  claim(id: string, token: string): Run {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT state FROM outbox WHERE run_id=?').get(id);
      if (row?.state !== 'pending') throw new Fault('DISPATCH_CLAIMED', 'Dispatch is already owned');
      const run = transition(this.get(id), 'starting');
      this.db.prepare("UPDATE outbox SET state='claimed' WHERE run_id=?").run(id);
      this.db.prepare('INSERT INTO credentials VALUES(?,?,?)').run(run.order.attemptId, id, digest(token));
      return this.save(run, 'attempt.claimed');
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
      const next = this.save(transition(run, run.phase === 'queued' ? 'cancelled' : 'stopping'), 'run.cancel_requested');
      if (next.phase === 'cancelled') this.db.prepare("UPDATE outbox SET state='done' WHERE run_id=?").run(id);
      return next;
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
        if (run.phase !== 'reviewing') throw new Fault('RESULT_STALE', 'Review attempt is no longer accepting results');
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
      return this.save({ ...run, candidate, reviewAttempt: { order } }, 'review.dispatch_intent');
    });
  }
  finishGate(id: string, validation: ValidationResult[], integrity: boolean, acceptanceIntegrity = true): Run {
    return this.transaction(() => {
      const run = { ...this.get(id), validation };
      if (run.phase !== 'validating') throw new Fault('RESULT_STALE', 'Gate no longer accepting results');
      const reasons = evaluateGate(run, integrity, acceptanceIntegrity);
      const result = transition({ ...run, gate: reasons.length ? 'failed' : 'passed', gateReasons: reasons },
        reasons.length ? 'rejected' : 'verified');
      this.db.prepare("UPDATE outbox SET state='done' WHERE run_id=?").run(id);
      return this.save(result, `gate.${result.gate}`);
    });
  }
  recordValidation(id: string, result: ValidationResult): void {
    this.transaction(() => {
      const run = this.get(id);
      if (run.phase !== 'validating') throw new Fault('RESULT_STALE', 'Acceptance is no longer active');
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
    for (const run of this.all()) if (['starting', 'running', 'stopping', 'freezing', 'reviewing', 'validating'].includes(run.phase)) {
      this.move(run.id, 'blocked', 'EXTERNAL_STATE_UNKNOWN: previous process exit is unproved; workspace quarantined');
    }
  }
}
