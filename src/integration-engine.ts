import { constants } from 'node:fs';
import { mkdir, lstat, realpath, readFile, writeFile, open, copyFile, rename, link, unlink, rmdir, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { Fault, type TreeEntry, type TreeManifest, type AbandonIntegrationCommand } from './contracts.js';
import { Store } from './store.js';
import { planIntegration } from './integration.js';
import { type IntegrationEffect, type IntegrationRecord, type IntegrationRequest, integrationRequest } from './integration-journal.js';
import { inside, snapshot, sourceManifest, treeManifest, inputsUnchanged } from './workspace.js';
import { validateCommand } from './validation.js';
import { scopeViolations } from './scope.js';
import { compareManifests } from './artifacts.js';

// A process-local guard complements the durable DB lease and cross-data-directory reservation.
// The caller must own the Runtime data directory before recovery; no PID-based owner stealing.
const active = new Set<string>();
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const lockIdentity = (record: IntegrationRecord): string => JSON.stringify({ id: record.id, directory: record.directory });
const missing = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; } }
async function canonicalDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || relative(resolve(path), await realpath(path)) !== '') throw new Fault('INTEGRATION_PATH', 'Integration directory must be canonical and not redirect');
}
async function entryAt(root: string, path: string): Promise<TreeEntry | undefined> {
  await canonicalDirectory(root);
  const target = join(root, ...path.split('/'));
  // Inspect each ancestor before following it, including when the final file is absent.
  let ancestor = root;
  for (const part of path.split('/').slice(0, -1)) {
    ancestor = join(ancestor, part);
    if (!await exists(ancestor)) return undefined;
    await canonicalDirectory(ancestor);
  }

  let stat;
  try { stat = await lstat(target); } catch (error) { if (missing(error)) return undefined; throw error; }
  if (stat.isSymbolicLink() || relative(resolve(target), await realpath(target)) !== '') throw new Fault('INTEGRATION_PATH', 'Integration entry must not redirect');
  if (stat.isDirectory()) return { path, kind: 'directory' };
  if (!stat.isFile()) throw new Fault('INTEGRATION_PATH', 'Integration entry is not an ordinary file');
  if (stat.size > 100 * 1024 * 1024) throw new Fault('WORKSPACE_TOO_LARGE', 'Integration entry exceeds limit');
  const content = await readFile(target);
  if (content.length !== stat.size) throw new Fault('INTEGRATION_CHANGED', 'Entry changed while reading');
  return { path, kind: 'file', size: stat.size, executable: stat.mode & 0o111, digest: hash(content) };
}
function same(a: TreeEntry | undefined, b: TreeEntry | undefined): boolean {
  if (!a || !b) return a === b;
  return a.kind === 'directory' ? b.kind === 'directory' : b.kind === 'file' && a.digest === b.digest && a.size === b.size && a.executable === b.executable;
}

/** Preparation requires a verified Run and current preview ID. Authorization is either an
 * explicit integration command or a durable automatic intent from the accepted upfront policy. */
export class IntegrationEngine {
  constructor(private readonly store: Store, private readonly source: string) {}

  async abandon(runId: string, id: string, command: AbandonIntegrationCommand, signal: AbortSignal): Promise<IntegrationRecord> {
    const record = this.store.integrations.get(id);
    if (record.runId !== runId || relative(resolve(this.source), record.source) !== '') throw new Fault('NOT_FOUND', 'Integration is not in this run/source', 404);
    const request = integrationRequest(runId, command, id), old = this.store.integrations.replay(request);
    if (old) return old;
    if (active.has(record.source)) throw new Fault('INTEGRATION_BUSY', 'Wait for the integration writer to stop');
    if (record.commandIntent) throw new Fault('EXTERNAL_STATE_UNKNOWN', 'Final command exit/result is unproved');
    const current = await sourceManifest(record.source, signal);
    if (current.manifest.digest !== command.targetDigest) throw new Fault('INTEGRATION_PLAN_STALE', 'Current project differs from the keep-current decision');
    signal.throwIfAborted();
    return this.store.integrations.abandon(runId, id, command);
  }

  async prepare(runId: string, expectedRevision: number, expectedPlanId: string, signal: AbortSignal, request?: IntegrationRequest): Promise<IntegrationRecord> {
    if (request) { const old = this.store.integrations.replay(request); if (old) return old; }
    const run = this.store.get(runId);
    if (run.revision !== expectedRevision) throw new Fault('REVISION_CONFLICT', 'Run revision changed');
    if (run.phase !== 'verified' || run.gate !== 'passed' || !run.verification || !run.baseline?.artifactId || !run.candidate?.artifactId) {
      throw new Fault('INTEGRATION_NOT_VERIFIED', 'Integration requires a current verified candidate and command policy');
    }
    await canonicalDirectory(this.source);
    const source = await realpath(this.source);
    const baseline = this.store.artifact(runId, run.baseline.artifactId), candidate = this.store.artifact(runId, run.candidate.artifactId);
    const before = await treeManifest(baseline.workspace, signal), after = await treeManifest(candidate.workspace, signal);
    if (before.digest !== baseline.digest || after.digest !== candidate.digest) throw new Fault('ARTIFACT_CHANGED', 'Integration input changed');
    if (run.order.spec && scopeViolations(run.order.spec.writeScope, compareManifests(before, after), before, after).length) {
      throw new Fault('SCOPE_VIOLATION', 'Integration changes exceed the authorized run scope');
    }
    const target = await sourceManifest(source, signal);
    const plan = planIntegration(before, after, target.manifest, target.protectedPaths);
    if (plan.id !== expectedPlanId) throw new Fault('INTEGRATION_PLAN_STALE', 'Project or candidate changed since preview');
    if (request) { const old = this.store.integrations.replay(request); if (old) return old; }
    signal.throwIfAborted();
    if (this.store.get(runId).revision !== expectedRevision) throw new Fault('REVISION_CONFLICT', 'Run changed during preparation');
    const id = randomUUID();
    // Sibling storage makes rename/link same-volume in the usual workspace layout. EXDEV fails
    // closed; never fall back to a copy-and-delete move. The whole directory is retained.
    const directory = join(dirname(source), `.teamwork-integration-${id}`);
    const reservation = join(dirname(source), `.teamwork-integration-${hash(source.toLowerCase()).slice(0, 32)}.lock`);
    for (const input of [source, baseline.workspace, candidate.workspace]) if (inside(input, directory) || inside(directory, input)) throw new Fault('WORKSPACE_OVERLAP', 'Integration storage overlaps an input');
    const removals: IntegrationEffect[] = [], additions: IntegrationEffect[] = [];
    for (const change of plan.changes) if (change.disposition === 'apply') {
      if (change.before) removals.push({ id: randomUUID(), path: change.path, kind: change.before.kind === 'file' ? 'remove_file' : 'remove_directory', state: 'pending', before: change.before });
      if (change.after) additions.push({ id: randomUUID(), path: change.path, kind: change.after.kind === 'file' ? 'write_file' : 'make_directory', state: 'pending', after: change.after });
    }
    const depth = (effect: IntegrationEffect): number => effect.path.split('/').length;
    removals.sort((a, b) => depth(b) - depth(a) || a.path.localeCompare(b.path));
    additions.sort((a, b) => depth(a) - depth(b) || a.path.localeCompare(b.path));
    return this.store.integrations.create({ id, runId, revision: 0, gateInputDigest: run.order.inputDigest, source, directory, reservation,
      baseline: run.baseline, candidate: run.candidate, target: target.manifest, protectedPaths: target.protectedPaths, plan,
      effects: [...removals, ...additions], commands: run.verification.commands, phase: plan.status === 'conflicts' ? 'conflict' : 'prepared', validation: [],
      ...(request ? { authorized: true, dispatch: 'pending' } : {}) }, request);
  }

  /** Caller holds Runtime ownership. Re-entry reconciles file intents, not unknown command processes.
   * Stop leaves an explicit blocked record and all backups; no destructive automatic rollback. */
  async execute(id: string, signal: AbortSignal): Promise<IntegrationRecord> {
    let record = this.store.integrations.get(id);
    if (relative(resolve(this.source), record.source) !== '') throw new Fault('INTEGRATION_IDENTITY', 'Integration belongs to another source');
    if (active.has(record.source)) throw new Fault('INTEGRATION_BUSY', 'Integration is already executing');
    if (['conflict', 'blocked', 'failed', 'cancelled', 'abandoned'].includes(record.phase)) return record;
    active.add(record.source);
    try {
      if (record.phase === 'succeeded') { await this.release(record); return record; }
      if (record.phase === 'abandoning') {
        signal.throwIfAborted();
        if (!record.resolution || record.commandIntent) throw new Fault('EXTERNAL_STATE_UNKNOWN', 'Keep-current requires stopped execution and a recorded decision');
        if ((await sourceManifest(record.source, signal)).manifest.digest !== record.resolution.targetDigest) throw new Fault('INTEGRATION_PLAN_STALE', 'Project changed after the keep-current decision');
        // Only relinquish this job's reservation. Keep project files, backups and snapshots intact.
        await canonicalDirectory(dirname(record.reservation));
        await this.release(record);
        return this.update(record, 'integration.abandoned', r => ({ ...r, phase: 'abandoned' }));
      }
      if (record.cancelRequested) throw new Fault('ABORTED', 'Integration cancellation was requested');
      signal.throwIfAborted();
      await this.reserve(record);
      const run = this.store.get(record.runId);
      if (run.phase !== 'verified' || run.gate !== 'passed' || run.order.inputDigest !== record.gateInputDigest ||
        run.candidate?.artifactId !== record.candidate.artifactId || JSON.stringify(run.verification?.commands) !== JSON.stringify(record.commands)) {
        throw new Fault('INTEGRATION_GATE_STALE', 'Prepared integration no longer matches the current Gate');
      }
      if (record.phase === 'prepared') {
        const current = await sourceManifest(record.source, signal);
        if (current.manifest.digest !== record.target.digest || JSON.stringify(current.protectedPaths) !== JSON.stringify(record.protectedPaths)) throw new Fault('INTEGRATION_PLAN_STALE', 'Project changed before first write');
        record = this.update(record, 'integration.applying', r => ({ ...r, phase: 'applying' }));
      }
      if (record.phase === 'applying') {
        await this.checkCandidate(record, signal);
        for (let i = 0; i < record.effects.length; i++) {
          signal.throwIfAborted();
          const effect = record.effects[i]!;
          if (effect.state === 'done') continue;
          if (effect.state === 'pending') record = this.update(record, 'integration.effect_intent', r => {
            r.effects[i]!.state = 'intent'; return r;
          });
          await this.applyEffect(record, record.effects[i]!, signal);
          record = this.update(record, 'integration.effect_done', r => { r.effects[i]!.state = 'done'; return r; });
        }
        await this.cleanupStages(record);
        await this.checkCandidate(record, signal);
        await this.checkResult(record, signal);
        record = this.update(record, 'integration.snapshot_intent', r => ({ ...r, phase: 'snapshotting' }));
      }
      if (record.phase === 'snapshotting') {
        await this.checkResult(record, signal);
        // New unique copies on each recovery: a partial copy is never reused or removed.
        const integratedPath = join(record.directory, `integrated-${randomUUID()}`);
        await snapshot(record.source, integratedPath, signal);
        const frozen = await treeManifest(integratedPath, signal);
        await this.checkResult(record, signal, frozen);
        const validationWorkspace = join(record.directory, `validation-${randomUUID()}`);
        await snapshot(integratedPath, validationWorkspace, signal, true);
        if ((await treeManifest(validationWorkspace, signal)).digest !== frozen.digest) throw new Fault('INTEGRATION_CHANGED', 'Final validation copy changed');
        record = this.update(record, 'integration.validation_prepared', r => ({ ...r, phase: 'validating',
          integrated: { workspace: integratedPath, digest: frozen.digest }, validationWorkspace }));
      }
      if (record.phase === 'validating') {
        if (record.commandIntent) throw new Fault('EXTERNAL_STATE_UNKNOWN', 'Final acceptance was claimed without a durable result; prove the prior process exited before reconciliation');
        if (!record.integrated || !record.validationWorkspace) throw new Fault('INTEGRATION_STATE', 'Missing final validation snapshot');
        if (record.validation.some((r, i) => r.commandId !== record.commands[i]?.id || r.status !== 'passed' || r.exitCode !== 0)) throw new Fault('INTEGRATION_ACCEPTANCE_FAILED', 'Previously recorded final acceptance failed');
        if ((await treeManifest(record.integrated.workspace, signal)).digest !== record.integrated.digest ||
          !await inputsUnchanged(record.integrated.workspace, record.validationWorkspace, signal)) throw new Fault('INTEGRATION_CHANGED', 'Final acceptance input changed');
        for (let i = record.validation.length; i < record.commands.length; i++) {
          signal.throwIfAborted();
          const command = record.commands[i]!;
          record = this.update(record, 'integration.command_intent', r => ({ ...r, commandIntent: command.id }));
          const result = await validateCommand(command, record.validationWorkspace!, signal).catch(error => {
            const exited = error instanceof Fault && error.code === 'ABORTED';
            const notStarted = signal.aborted && error === signal.reason;
            if (exited || notStarted) record = this.update(record, 'integration.command_stopped', r => {
              delete r.commandIntent;
              return { ...r, commandStop: { commandId: command.id, proof: exited ? 'direct-process-exited' : 'not-started' } };
            });
            throw error;
          });
          record = this.update(record, 'integration.command_done', r => {
            delete r.commandIntent; r.validation.push(result); return r;
          });
          if (result.status !== 'passed' || result.exitCode !== 0) throw new Fault('INTEGRATION_ACCEPTANCE_FAILED', 'Final integrated acceptance failed');
          if (!await inputsUnchanged(record.integrated!.workspace, record.validationWorkspace!, signal)) throw new Fault('INTEGRATION_CHANGED', 'Acceptance modified integrated inputs');
        }
        if ((await treeManifest(record.integrated!.workspace, signal)).digest !== record.integrated!.digest) throw new Fault('INTEGRATION_CHANGED', 'Integrated snapshot changed during acceptance');
        await this.checkResult(record, signal, await treeManifest(record.integrated!.workspace, signal));
        if (record.validation.length !== record.commands.length || record.validation.some((r, i) => r.commandId !== record.commands[i]!.id || r.status !== 'passed' || r.exitCode !== 0)) throw new Fault('INTEGRATION_ACCEPTANCE_FAILED', 'Final evidence is incomplete');
        record = this.update(record, 'integration.succeeded', r => ({ ...r, phase: 'succeeded' }));
        await this.release(record);
      }
      return record;
    } catch (error) {
      // Refresh after a persistence failure: never replace newer journal state with a local copy.
      record = this.store.integrations.get(id);
      if (record.phase === 'succeeded') throw error; // Success is durable; reservation cleanup can be retried.
      const ioCode = (error as NodeJS.ErrnoException).code;
      const reason = error instanceof Fault ? error.code : signal.aborted ? 'ABORTED' : ioCode === 'EXDEV' ? 'INTEGRATION_CROSS_DEVICE' :
        ['EEXIST', 'ENOTEMPTY'].includes(ioCode ?? '') ? 'INTEGRATION_CHANGED' : ['EPERM', 'EACCES'].includes(ioCode ?? '') ? 'INTEGRATION_PERMISSION_DENIED' : 'INTEGRATION_IO_ERROR';
      return this.update(record, 'integration.interrupted', r => ({ ...r,
        phase: reason === 'INTEGRATION_ACCEPTANCE_FAILED' ? 'failed' : 'blocked', reason }));
    } finally { active.delete(record.source); }
  }

  private update(record: IntegrationRecord, type: string, body: (record: IntegrationRecord) => IntegrationRecord): IntegrationRecord {
    const current = this.store.integrations.get(record.id);
    // The Runtime can persist cancellation while this writer is awaiting a filesystem effect.
    // Preserve that control fact; all other unexpected writers still fail the revision check.
    if (current.revision !== record.revision && !current.cancelRequested) throw new Fault('REVISION_CONFLICT', 'Integration changed during execution');
    return this.store.integrations.update(record.id, current.revision, type, body);
  }
  private async reserve(record: IntegrationRecord): Promise<void> {
    await canonicalDirectory(record.source);
    await canonicalDirectory(dirname(record.reservation));
    const identity = lockIdentity(record);
    try { await writeFile(record.reservation, identity, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = await lstat(record.reservation);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048 || await readFile(record.reservation, 'utf8') !== identity) throw new Fault('INTEGRATION_BUSY', 'Another integration owns this project reservation');
    }
    if (!await exists(record.directory)) {
      await mkdir(record.directory, { mode: 0o700 });
      await writeFile(join(record.directory, 'owner.json'), identity, { flag: 'wx', mode: 0o600 });
    }
    await canonicalDirectory(record.directory);
    const owner = await entryAt(record.directory, 'owner.json');
    if (owner?.kind !== 'file' || owner.digest !== hash(identity)) throw new Fault('INTEGRATION_OWNER_UNKNOWN', 'Integration storage ownership is unproved');
    if ((await lstat(record.source, { bigint: true })).dev !== (await lstat(record.directory, { bigint: true })).dev) {
      throw new Fault('INTEGRATION_CROSS_DEVICE', 'Project and backup storage must be on the same filesystem');
    }
    if (record.phase === 'prepared') {
      // Establish publication support before any original file is moved. A failed/interrupted
      // probe remains inside this exclusively owned directory, never in the user project.
      const probe = join(record.directory, `probe-${randomUUID()}`), alias = probe + '-link';
      await writeFile(probe, identity, { flag: 'wx', mode: 0o600 });
      await link(probe, alias);
      await unlink(alias); await unlink(probe);
    }
  }
  private async release(record: IntegrationRecord): Promise<void> {
    if (!await exists(record.reservation)) return;
    const stat = await lstat(record.reservation);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048 || await readFile(record.reservation, 'utf8') !== lockIdentity(record)) throw new Fault('INTEGRATION_OWNER_UNKNOWN', 'Project reservation changed');
    await unlink(record.reservation);
  }
  private async checkCandidate(record: IntegrationRecord, signal: AbortSignal): Promise<void> {
    if ((await treeManifest(record.candidate.workspace, signal)).digest !== record.candidate.digest) throw new Fault('ARTIFACT_CHANGED', 'Verified candidate changed');
  }
  private async cleanupStages(record: IntegrationRecord): Promise<void> {
    for (const effect of record.effects) if (effect.kind === 'write_file' && effect.state === 'done') {
      const stageName = `${effect.id}.stage`, stage = join(record.directory, stageName);
      if (!await exists(stage)) continue;
      const staged = await entryAt(record.directory, stageName), now = await entryAt(record.source, effect.path);
      if (!same(staged, effect.after) || !same(now, effect.after)) throw new Fault('INTEGRATION_CHANGED', 'Published file changed before staging cleanup');
      const a = await lstat(stage, { bigint: true }), b = await lstat(join(record.source, ...effect.path.split('/')), { bigint: true });
      if (a.dev !== b.dev || a.ino !== b.ino) throw new Fault('INTEGRATION_CHANGED', 'Publication identity changed before cleanup');
      await unlink(stage); // Remove only the owned staging link, never the target or original backup.
    }
  }
  private async checkResult(record: IntegrationRecord, signal: AbortSignal, frozen?: TreeManifest): Promise<void> {
    const source = await sourceManifest(record.source, signal);
    // The expected merged tree contains untouched live inputs captured at prepare, not just Candidate.
    const expected = new Map(record.target.entries.map(entry => [entry.path, entry]));
    for (const change of record.plan.changes) {
      if (change.after) expected.set(change.path, change.after); else expected.delete(change.path);
    }
    const matches = (manifest: TreeManifest): boolean => manifest.entries.length === expected.size && manifest.entries.every(e => same(e, expected.get(e.path)));
    if (!matches(source.manifest) || (frozen && (!matches(frozen) || frozen.digest !== source.manifest.digest)) ||
      JSON.stringify(source.protectedPaths) !== JSON.stringify(record.protectedPaths)) throw new Fault('INTEGRATION_CHANGED', 'Project diverged from the prepared merged tree');
  }
  private async applyEffect(record: IntegrationRecord, effect: IntegrationEffect, signal: AbortSignal): Promise<void> {
    await canonicalDirectory(record.directory);
    const target = join(record.source, ...effect.path.split('/'));
    const now = await entryAt(record.source, effect.path);
    if (effect.kind === 'remove_file') {
      const backupName = `${effect.id}.backup`, backup = join(record.directory, backupName);
      const saved = await entryAt(record.directory, backupName);
      if (saved) {
        if (!same(saved, effect.before)) throw new Fault('INTEGRATION_BACKUP_CHANGED', 'Backup differs from expected original');
        if (now) throw new Fault('INTEGRATION_CHANGED', 'A file appeared after the original was saved');
        return;
      }
      if (!same(now, effect.before)) throw new Fault('INTEGRATION_CHANGED', 'Original file changed before move');
      signal.throwIfAborted();
      await rename(target, backup);
      if (!same(await entryAt(record.directory, backupName), effect.before)) {
        // A concurrent edit in the check→rename window is retained, and restored only if vacant.
        try { await link(backup, target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        throw new Fault('INTEGRATION_CHANGED', 'Concurrent original preserved in backup; inspect the journal');
      }
    } else if (effect.kind === 'remove_directory') {
      if (!now) return; // Idempotent empty-directory deletion; no recursive erase.
      if (now.kind !== 'directory') throw new Fault('INTEGRATION_CHANGED', 'Directory type changed');
      if ((await readdir(target)).length) throw new Fault('INTEGRATION_CHANGED', 'Directory gained entries');
      signal.throwIfAborted();
      await rmdir(target); // Atomic refusal if any user entry arrives after the check.
    } else if (effect.kind === 'make_directory') {
      if (now) {
        if (now.kind !== 'directory') throw new Fault('INTEGRATION_CHANGED', 'Directory path is occupied');
        return;
      }
      signal.throwIfAborted();
      await mkdir(target); // Not recursive: parents have their own journaled effects.
    } else {
      const stageName = `${effect.id}.stage`, stage = join(record.directory, stageName);
      let staged = await entryAt(record.directory, stageName);
      if (now) {
        if (!same(now, effect.after) || !same(staged, effect.after)) throw new Fault('INTEGRATION_CHANGED', 'Destination is occupied without publication proof');
        const a = await lstat(target, { bigint: true }), b = await lstat(stage, { bigint: true });
        if (a.dev !== b.dev || a.ino !== b.ino) throw new Fault('INTEGRATION_CHANGED', 'Destination is not this effect publication');
        return;
      }
      if (!staged) {
        const input = await entryAt(record.candidate.workspace, effect.path);
        if (!same(input, effect.after)) throw new Fault('ARTIFACT_CHANGED', 'Candidate file changed before staging');
        signal.throwIfAborted();
        await copyFile(join(record.candidate.workspace, ...effect.path.split('/')), stage, constants.COPYFILE_EXCL);
        const handle = await open(stage, 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
        staged = await entryAt(record.directory, stageName);
      }
      if (!same(staged, effect.after)) throw new Fault('INTEGRATION_STAGE_CHANGED', 'Staging file does not match the verified candidate');
      // Exclusive atomic publication; never rename over a newly created user file.
      signal.throwIfAborted();
      await entryAt(record.source, effect.path); // Recheck ancestor redirection after staging.
      await link(stage, target);
    }
  }
}
