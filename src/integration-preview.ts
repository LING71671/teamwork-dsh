import { Fault, type IntegrationPreview, type ArtifactDescriptor } from './contracts.js';
import type { Store } from './store.js';
import { treeManifest, sourceManifest } from './workspace.js';
import { planIntegration } from './integration.js';

/** Only registered run snapshots and the operator-configured project can be compared. */
export async function integrationPreview(store: Store, source: string, runId: string, artifactId: string | undefined,
  offset: number, limit: number, expectedPlanId: string | undefined, signal: AbortSignal): Promise<IntegrationPreview> {
  const run = store.get(runId);
  if (!run.baseline?.artifactId) throw new Fault('BASELINE_MISSING', 'No original baseline is registered for this run');
  const selected = artifactId ?? run.candidate?.artifactId;
  if (!selected) throw new Fault('CANDIDATE_MISSING', 'Select a registered candidate or checkpoint');
  const baseline = store.artifact(runId, run.baseline.artifactId), candidate = store.artifact(runId, selected);
  if (candidate.kind === 'baseline') throw new Fault('ARTIFACT_KIND', 'Select a candidate or checkpoint artifact');
  const original = await treeManifest(baseline.workspace, signal), proposed = await treeManifest(candidate.workspace, signal);
  if (original.digest !== baseline.digest || proposed.digest !== candidate.digest) throw new Fault('ARTIFACT_CHANGED', 'Integration inputs no longer match their registered digests');
  const target = await sourceManifest(source, signal);
  const plan = planIntegration(original, proposed, target.manifest, target.protectedPaths);
  if (expectedPlanId && expectedPlanId !== plan.id) throw new Fault('INTEGRATION_PLAN_STALE', 'Inputs changed; restart preview pagination');
  const descriptor = ({ workspace: _workspace, ...value }: ArtifactDescriptor & { workspace: string }): ArtifactDescriptor => value;
  return { ...plan, runId, revision: run.revision, baseline: descriptor(baseline), candidate: descriptor(candidate),
    candidateVerified: run.phase === 'verified' && run.gate === 'passed' && run.candidate?.artifactId === selected,
    readOnly: true, changes: plan.changes.slice(offset, offset + limit), total: plan.changes.length,
    conflictCount: plan.changes.filter(change => change.disposition === 'conflict').length,
    nextOffset: offset + limit < plan.changes.length ? offset + limit : null };
}
