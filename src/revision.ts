import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Fault, type Candidate, type ContextVersion, type ReviseCommand, type Run, type TreeManifest } from './contracts.js';
import type { Store } from './store.js';
import { snapshot, sourceManifest, treeManifest } from './workspace.js';
import { planIntegration } from './integration.js';

/** Full-spec replacement starts from CURRENT project content. Prior output is reference-only,
 * never a silently reused accepted candidate or permission to overwrite newer user changes. */
export async function reviseRun(store: Store, source: string, attempts: string, id: string, input: ReviseCommand, signal: AbortSignal): Promise<Run> {
  const replay = store.replayRevision(id, input); if (replay) return replay;
  store.revisionImpact(id, input);
  const old = store.get(id), current = await sourceManifest(source, signal);
  const directory = join(attempts, `revision-${randomUUID()}`);
  await snapshot(source, directory, signal);
  const frozen = await treeManifest(directory, signal), latest = await sourceManifest(source, signal);
  if (frozen.digest !== current.manifest.digest || latest.manifest.digest !== frozen.digest ||
    JSON.stringify(latest.protectedPaths) !== JSON.stringify(current.protectedPaths)) throw new Fault('REVISION_SOURCE_CHANGED', 'Project changed while preparing the new specification baseline');
  const inputs: { current: Candidate; base?: Candidate; proposal?: Candidate } = { current: { workspace: directory, digest: frozen.digest } };
  const manifests: { base?: TreeManifest; proposal?: TreeManifest } = {}, unavailable: ContextVersion[] = [];
  const continuation = old.pause?.continuation;
  const proposal = continuation && 'candidate' in continuation ? continuation.candidate ?? old.candidate : old.candidate;
  for (const [version, candidate] of [['base', old.baseline], ['proposal', proposal]] as const) {
    if (!candidate?.artifactId) { unavailable.push(version); continue; }
    let registered: ReturnType<Store['artifact']>;
    try { registered = store.artifact(id, candidate.artifactId); }
    catch (error) {
      if (!(error instanceof Fault) || error.code !== 'NOT_FOUND') throw error;
      unavailable.push(version); continue;
    }
    try {
      const manifest = await treeManifest(registered.workspace, signal);
      if (manifest.digest !== registered.digest || registered.digest !== candidate.digest) { unavailable.push(version); continue; }
      inputs[version] = { workspace: registered.workspace, digest: registered.digest, artifactId: registered.id }; manifests[version] = manifest;
    } catch (error) {
      signal.throwIfAborted();
      const unavailableTree = error instanceof Fault
        ? ['WORKSPACE_SYMLINK', 'WORKSPACE_TOO_LARGE', 'WORKSPACE_SPECIAL_FILE', 'CANDIDATE_CHANGED'].includes(error.code)
        : ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes((error as NodeJS.ErrnoException)?.code ?? '');
      if (!unavailableTree) throw error;
      unavailable.push(version);
    } // Missing/unsafe optional evidence is unavailable; infrastructure/programming errors still fail the command.
  }
  let conflicts: ReturnType<typeof planIntegration>['changes'] = [];
  let conflictPreviewAvailable = false;
  if (manifests.base && manifests.proposal) {
    try {
      conflicts = planIntegration(manifests.base, manifests.proposal, frozen, latest.protectedPaths).changes.filter(change => change.disposition === 'conflict');
      conflictPreviewAvailable = true;
    }
    catch (error) {
      if (!(error instanceof Fault) || !['INTEGRATION_PATH', 'ARTIFACT_PATH', 'INTEGRATION_TREE'].includes(error.code)) throw error;
      // Unsupported old paths cannot authorize a merge; references remain read-only and path-checked.
    }
  }
  signal.throwIfAborted();
  return store.revise(id, input, { previousSpecRevision: old.order.specRevision, reason: input.reason, inputs, conflicts, conflictPreviewAvailable, unavailable }, attempts);
}
