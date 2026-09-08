import type { DatabaseSync } from 'node:sqlite';
import { Fault, type Candidate, type IntegrationPlan, type TreeEntry, type TreeManifest, type ValidationResult, type VerificationPolicy } from './contracts.js';

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
  phase: 'prepared' | 'applying' | 'snapshotting' | 'validating' | 'succeeded' | 'conflict' | 'blocked' | 'failed';
  reason?: string;
  integrated?: Candidate;
  validationWorkspace?: string;
  validation: ValidationResult[];
  commandIntent?: string;
}

/** Same SQLite connection/transaction authority as Run state, not a second database.
 * Source leases survive process exit. Only a successful job releases its lease automatically;
 * partial writes and ambiguous acceptance retain ownership for explicit reconciliation. */
export class IntegrationJournal {
  constructor(private readonly db: DatabaseSync) {
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
  create(record: IntegrationRecord): IntegrationRecord {
    return this.transaction(() => {
      if (record.revision !== 0 || !['prepared', 'conflict'].includes(record.phase)) throw new Fault('INTEGRATION_STATE', 'Invalid initial integration state');
      if (this.db.prepare('SELECT id FROM integration_jobs WHERE id=?').get(record.id)) throw new Fault('INTEGRATION_EXISTS', 'Integration already exists');
      if (record.phase === 'prepared') {
        if (this.db.prepare('SELECT job_id FROM integration_leases WHERE source=?').get(record.source)) throw new Fault('INTEGRATION_BUSY', 'Source has an unresolved integration');
        this.db.prepare('INSERT INTO integration_leases VALUES(?,?)').run(record.source, record.id);
      }
      return this.save(record, 'integration.prepared');
    });
  }
  get(id: string): IntegrationRecord {
    const row = this.db.prepare('SELECT data FROM integration_jobs WHERE id=?').get(id);
    if (!row) throw new Fault('NOT_FOUND', 'Integration does not exist', 404);
    return JSON.parse(row.data as string) as IntegrationRecord;
  }
  forRun(runId: string): IntegrationRecord[] {
    return this.db.prepare('SELECT data FROM integration_jobs WHERE json_extract(data,\'$.runId\')=? ORDER BY rowid').all(runId)
      .map(row => JSON.parse(row.data as string) as IntegrationRecord);
  }
  update(id: string, revision: number, type: string, update: (record: IntegrationRecord) => IntegrationRecord): IntegrationRecord {
    return this.transaction(() => {
      const old = this.get(id);
      if (old.revision !== revision) throw new Fault('REVISION_CONFLICT', 'Integration revision changed');
      const next = update(structuredClone(old));
      const identity = (r: IntegrationRecord): string => JSON.stringify([r.id, r.runId, r.gateInputDigest, r.source, r.directory, r.reservation,
        r.baseline, r.candidate, r.target, r.protectedPaths, r.plan, r.commands,
        r.effects.map(({ state: _state, ...effect }) => effect)]);
      if (identity(old) !== identity(next)) throw new Fault('INTEGRATION_IDENTITY', 'Prepared integration inputs cannot change');
      if (['succeeded', 'conflict', 'blocked', 'failed'].includes(old.phase)) throw new Fault('INTEGRATION_TERMINAL', 'Integration needs a separate operator reconciliation decision');
      if (next.phase === 'succeeded') this.db.prepare('DELETE FROM integration_leases WHERE source=? AND job_id=?').run(old.source, id);
      return this.save({ ...next, revision: old.revision + 1 }, type);
    });
  }
  private save(record: IntegrationRecord, type: string): IntegrationRecord {
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
