import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { Fault, type Candidate, type IntegrationPlan, type TreeEntry, type TreeManifest, type ValidationResult, type VerificationPolicy,
  type IntegrationPhase, type IntegrationStatus, type IntegrateCommand, type CancelCommand, type AbandonIntegrationCommand, type ResolveIntegrationCommand, type Run } from './contracts.js';

export interface IntegrationRequest { commandId: string; digest: string }
export const integrationRequest = (runId: string, command: IntegrateCommand | CancelCommand | AbandonIntegrationCommand | ResolveIntegrationCommand, id?: string): IntegrationRequest => ({ commandId: command.commandId,
  digest: createHash('sha256').update(JSON.stringify(['integration', runId, command.type, command.expectedRevision, command.type === 'integrate' ? command.planId : id,
    ...(command.type === 'abandon' ? [command.targetDigest, command.reason] : command.type === 'resolve' ? [command.planId, command.instructions] : [])])).digest('hex') });
export function integrationStatus(record: IntegrationRecord): IntegrationStatus {
  return { id: record.id, runId: record.runId, revision: record.revision, phase: record.phase, planId: record.plan.id,
    completedEffects: record.effects.filter(e => e.state === 'done').length, totalEffects: record.effects.length,
    conflictCount: record.plan.changes.filter(c => c.disposition === 'conflict').length, cancelRequested: record.cancelRequested ?? false,
    recoveryDirectory: record.directory, validation: record.validation, ...(record.reason ? { reason: record.reason } : {}),
    ...(record.integrated ? { integrated: record.integrated } : {}), ...(record.resolution ? { resolution: record.resolution } : {}),
    ...(record.commandStop ? { commandStop: record.commandStop } : {}), ...(record.resolutionRunId ? { resolutionRunId: record.resolutionRunId } : {}) };
}

export interface IntegrationEffect {
  id: string; path: string;
  kind: 'remove_file' | 'remove_directory' | 'write_file' | 'make_directory';
  state: 'pending' | 'intent' | 'done';
  before?: TreeEntry; after?: TreeEntry;
}
export interface IntegrationRecord {
  id: string; runId: string; revision: number;
  gateInputDigest: string;
  source: string; directory: string; reservation: string;
  baseline: Candidate; candidate: Candidate;
  target: TreeManifest; protectedPaths: string[];
  plan: IntegrationPlan; effects: IntegrationEffect[];
  commands: VerificationPolicy['commands'];
  phase: IntegrationPhase;
  authorized?: boolean;
  dispatch?: 'pending' | 'claimed';
  cancelRequested?: boolean;
  resolution?: { kind: 'keep-current'; targetDigest: string; reason: string };
  reason?: string;
  integrated?: Candidate;
  validationWorkspace?: string;
  validation: ValidationResult[];
  commandIntent?: string;
  commandStop?: { commandId: string; proof: 'not-started' | 'direct-process-exited' };
  resolutionRunId?: string;
  resolutionRuns?: string[];
}

/** Same SQLite connection/transaction authority as Run state, not a second database.
 * Source leases survive process exit. Only a successful job releases its lease automatically;
 * partial writes and ambiguous acceptance retain ownership for explicit reconciliation. */
export class IntegrationJournal {
  constructor(private readonly db: DatabaseSync, private readonly project?: (record: IntegrationRecord, type: string) => IntegrationRecord) {
    db.exec(`CREATE TABLE IF NOT EXISTS integration_jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS integration_leases (source TEXT PRIMARY KEY, job_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS integration_events (cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL, revision INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);`);
  }
  private transaction<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = body(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  replay<T = IntegrationRecord>(request: IntegrationRequest): T | undefined {
    const row = this.db.prepare('SELECT digest,response FROM commands WHERE id=?').get(`host:${request.commandId}`);
    if (!row) return undefined;
    if (row.digest !== request.digest) throw new Fault('IDEMPOTENCY_CONFLICT', 'Command ID reused with a different payload');
    return JSON.parse(row.response as string) as T;
  }
  private receipt(request: IntegrationRequest, record: IntegrationRecord | Run): void {
    this.db.prepare('INSERT INTO commands VALUES(?,?,?)').run(`host:${request.commandId}`, request.digest, JSON.stringify(record));
  }
  create(record: IntegrationRecord, request?: IntegrationRequest): IntegrationRecord {
    return this.transaction(() => {
      if (request) { const old = this.replay(request); if (old) return old; }
      if (record.revision !== 0 || !['prepared', 'conflict'].includes(record.phase)) throw new Fault('INTEGRATION_STATE', 'Invalid initial integration state');
      if (this.db.prepare('SELECT id FROM integration_jobs WHERE id=?').get(record.id)) throw new Fault('INTEGRATION_EXISTS', 'Integration already exists');
      if (record.phase === 'prepared') {
        if (this.db.prepare('SELECT job_id FROM integration_leases WHERE source=?').get(record.source)) throw new Fault('INTEGRATION_BUSY', 'Source has an unresolved integration');
        this.db.prepare('INSERT INTO integration_leases VALUES(?,?)').run(record.source, record.id);
      }
      const saved = this.save(record, 'integration.prepared');
      if (request) this.receipt(request, saved);
      return saved;
    });
  }
  get(id: string): IntegrationRecord {
    const row = this.db.prepare('SELECT data FROM integration_jobs WHERE id=?').get(id);
    if (!row) throw new Fault('NOT_FOUND', 'Integration does not exist', 404);
    return JSON.parse(row.data as string) as IntegrationRecord;
  }
  forRun(runId: string, offset = 0, limit = Number.MAX_SAFE_INTEGER): IntegrationRecord[] {
    return this.db.prepare('SELECT data FROM integration_jobs WHERE json_extract(data,\'$.runId\')=? ORDER BY rowid LIMIT ? OFFSET ?').all(runId, limit, offset)
      .map(row => JSON.parse(row.data as string) as IntegrationRecord);
  }
  pending(): IntegrationRecord[] {
    return this.db.prepare("SELECT data FROM integration_jobs WHERE json_extract(data,'$.authorized')=1 AND json_extract(data,'$.phase') IN ('prepared','applying','snapshotting','validating','abandoning') ORDER BY rowid")
      .all().map(row => JSON.parse(row.data as string) as IntegrationRecord);
  }
  unresolved(): boolean { return this.db.prepare('SELECT source FROM integration_leases LIMIT 1').get() !== undefined; }
  claim(id: string): IntegrationRecord {
    const record = this.get(id);
    if (!record.authorized || !['prepared', 'applying', 'snapshotting', 'validating', 'abandoning'].includes(record.phase)) throw new Fault('INTEGRATION_STATE', 'Integration is not dispatchable');
    return this.update(id, record.revision, 'integration.claimed', r => ({ ...r, dispatch: 'claimed' }));
  }
  cancel(runId: string, id: string, command: CancelCommand): IntegrationRecord {
    const request = integrationRequest(runId, command, id);
    return this.transaction(() => {
      const record = this.get(id);
      if (record.runId !== runId) throw new Fault('NOT_FOUND', 'Integration is not in this run', 404);
      const old = this.replay(request); if (old) return old;
      if (record.revision !== command.expectedRevision) throw new Fault('REVISION_CONFLICT', 'Integration revision changed');
      if (record.phase === 'abandoning') throw new Fault('INTEGRATION_STATE', 'An accepted keep-current resolution cannot be cancelled');
      let next = record;
      if (['prepared', 'applying', 'snapshotting', 'validating'].includes(record.phase)) {
        const undispatched = record.phase === 'prepared' && record.dispatch === 'pending';
        next = { ...record, revision: record.revision + 1, cancelRequested: true, ...(undispatched ? { phase: 'cancelled' as const } : {}) };
        if (undispatched) this.db.prepare('DELETE FROM integration_leases WHERE source=? AND job_id=?').run(record.source, id);
        next = this.save(next, undispatched ? 'integration.cancelled' : 'integration.cancel_requested');
      }
      this.receipt(request, next); return next;
    });
  }
  abandon(runId: string, id: string, command: AbandonIntegrationCommand): IntegrationRecord {
    const request = integrationRequest(runId, command, id);
    return this.transaction(() => {
      const record = this.get(id);
      if (record.runId !== runId) throw new Fault('NOT_FOUND', 'Integration is not in this run', 404);
      const old = this.replay(request); if (old) return old;
      if (record.revision !== command.expectedRevision) throw new Fault('REVISION_CONFLICT', 'Integration revision changed');
      if (!record.authorized || !['blocked', 'failed'].includes(record.phase)) throw new Fault('INTEGRATION_STATE', 'Only a stopped, host-authorized failed integration can be abandoned');
      if (record.commandIntent) throw new Fault('EXTERNAL_STATE_UNKNOWN', 'A final command lacks exit/result proof; keep-current cannot clear an unknown process');
      const next = this.save({ ...record, revision: record.revision + 1, phase: 'abandoning', dispatch: 'pending',
        resolution: { kind: 'keep-current', targetDigest: command.targetDigest, reason: command.reason } }, 'integration.abandon_requested');
      this.receipt(request, next); return next;
    });
  }
  resolve(runId: string, id: string, command: ResolveIntegrationCommand, create: () => Run): Run {
    const request = integrationRequest(runId, command, id);
    return this.transaction(() => {
      const record = this.get(id);
      if (record.runId !== runId) throw new Fault('NOT_FOUND', 'Integration is not in this run', 404);
      const old = this.replay<Run>(request); if (old) return old;
      if (record.revision !== command.expectedRevision) throw new Fault('REVISION_CONFLICT', 'Integration revision changed');
      if (!record.authorized || !['conflict', 'abandoned'].includes(record.phase) || record.commandIntent) throw new Fault('RESOLUTION_NOT_READY', 'Resolve a preflight conflict, or first complete a safe keep-current decision');
      if (this.unresolved()) throw new Fault('INTEGRATION_RECONCILIATION_REQUIRED', 'Resolve retained integration ownership first');
      if (record.resolutionRunId) {
        const previous = this.db.prepare('SELECT data FROM runs WHERE id=?').get(record.resolutionRunId);
        if (!previous || !['failed', 'cancelled', 'rejected'].includes((JSON.parse(previous.data as string) as Run).phase)) throw new Fault('RESOLUTION_EXISTS', 'Use the existing resolution run; blocked execution requires reconciliation');
      }
      const run = create();
      this.save({ ...record, revision: record.revision + 1, resolutionRunId: run.id,
        resolutionRuns: [...(record.resolutionRuns ?? []), run.id] }, 'integration.resolution_created');
      this.receipt(request, run); return run;
    });
  }
  update(id: string, revision: number, type: string, update: (record: IntegrationRecord) => IntegrationRecord): IntegrationRecord {
    return this.transaction(() => {
      const old = this.get(id);
      if (old.revision !== revision) throw new Fault('REVISION_CONFLICT', 'Integration revision changed');
      const next = update(structuredClone(old));
      const identity = (r: IntegrationRecord): string => JSON.stringify([r.id, r.runId, r.gateInputDigest, r.source, r.directory, r.reservation,
        r.baseline, r.candidate, r.target, r.protectedPaths, r.plan, r.commands, r.authorized,
        r.effects.map(({ state: _state, ...effect }) => effect)]);
      if (identity(old) !== identity(next)) throw new Fault('INTEGRATION_IDENTITY', 'Prepared integration inputs cannot change');
      if (['succeeded', 'conflict', 'blocked', 'failed', 'cancelled', 'abandoned'].includes(old.phase)) throw new Fault('INTEGRATION_TERMINAL', 'Integration needs a separate operator reconciliation decision');
      if (['succeeded', 'abandoned'].includes(next.phase)) this.db.prepare('DELETE FROM integration_leases WHERE source=? AND job_id=?').run(old.source, id);
      return this.save({ ...next, revision: old.revision + 1 }, type);
    });
  }
  private save(record: IntegrationRecord, type: string): IntegrationRecord {
    record = this.project?.(record, type) ?? record;
    const data = JSON.stringify(record);
    this.db.prepare('INSERT OR REPLACE INTO integration_jobs VALUES(?,?)').run(record.id, data);
    this.db.prepare('INSERT INTO integration_events(job_id,revision,type,data) VALUES(?,?,?,?)').run(record.id, record.revision, type,
      JSON.stringify({ phase: record.phase, reason: record.reason, effect: record.effects.find(e => e.state !== 'done')?.id,
        completedEffects: record.effects.filter(e => e.state === 'done').length, commandIntent: record.commandIntent, completedCommands: record.validation.length }));
    return record;
  }
  events(id: string): { cursor: number; revision: number; type: string }[] {
    this.get(id);
    return this.db.prepare('SELECT cursor,revision,type FROM integration_events WHERE job_id=? ORDER BY cursor').all(id)
      .map(row => ({ cursor: row.cursor as number, revision: row.revision as number, type: row.type as string }));
  }
}
