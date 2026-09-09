import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Fault, type ResolveIntegrationCommand, type Run } from './contracts.js';
import type { Store } from './store.js';
import { integrationRequest } from './integration-journal.js';
import { planIntegration } from './integration.js';
import { snapshot, sourceManifest, treeManifest } from './workspace.js';

/** Prepare all three immutable inputs before atomically publishing the child WorkItem/outbox.
 * The workspace starts from CURRENT, not from the conflicting proposal. The resolver and fresh
 * reviewer inspect proposal/base through scoped read-only context tools, never shared writable trees. */
export async function resolveIntegration(store: Store, source: string, attempts: string, profile: unknown, parentId: string,
  integrationId: string, input: ResolveIntegrationCommand, signal: AbortSignal): Promise<Run> {
  const request = integrationRequest(parentId, input, integrationId), old = store.integrations.replay<Run>(request);
  if (old) return old;
  const job = store.integrations.get(integrationId), parent = store.get(parentId);
  if (job.runId !== parentId) throw new Fault('NOT_FOUND', 'Integration is not in this run', 404);
  if (job.revision !== input.expectedRevision) throw new Fault('REVISION_CONFLICT', 'Integration revision changed');
  if (!job.authorized || !['conflict', 'abandoned'].includes(job.phase) || job.commandIntent) throw new Fault('RESOLUTION_NOT_READY', 'Resolve conflicts only after the previous integration is stopped and ownership released');
  if (parent.phase !== 'verified' || parent.gate !== 'passed' || !parent.baseline || !parent.candidate || !parent.verification) throw new Fault('INTEGRATION_NOT_VERIFIED', 'Resolution needs the original verified candidate');
  if (job.gateInputDigest !== parent.order.inputDigest || job.candidate.artifactId !== parent.candidate.artifactId) throw new Fault('INTEGRATION_GATE_STALE', 'This integration belongs to an older specification/candidate');
  if (store.integrations.unresolved()) throw new Fault('INTEGRATION_RECONCILIATION_REQUIRED', 'Resolve retained integration ownership first');
  const requirements = [...(parent.order.resolution?.requirements ?? []), input.instructions];
  if (requirements.join('\n').length > 32_000) throw new Fault('RESOLUTION_BUDGET', 'Inherited resolution requirements exceed the 32,000-character budget');
  const base = await treeManifest(parent.baseline.workspace, signal), proposal = await treeManifest(parent.candidate.workspace, signal);
  if (base.digest !== parent.baseline.digest || proposal.digest !== parent.candidate.digest) throw new Fault('ARTIFACT_CHANGED', 'Resolution input changed');
  const current = await sourceManifest(source, signal);
  const plan = planIntegration(base, proposal, current.manifest, current.protectedPaths);
  if (plan.id !== input.planId) throw new Fault('INTEGRATION_PLAN_STALE', 'Project changed since the resolution preview');
  // A failed final integration can need semantic resolution even with no file-level conflicts.
  if (job.phase === 'conflict' && plan.status !== 'conflicts') throw new Fault('CONFLICTS_CLEARED', 'No current file conflicts remain; inspect and explicitly integrate instead');
  const directory = join(attempts, `resolution-${randomUUID()}`);
  await snapshot(source, directory, signal);
  const frozen = await treeManifest(directory, signal), latest = await sourceManifest(source, signal);
  if (frozen.digest !== current.manifest.digest || latest.manifest.digest !== current.manifest.digest ||
    JSON.stringify(latest.protectedPaths) !== JSON.stringify(current.protectedPaths)) throw new Fault('INTEGRATION_PLAN_STALE', 'Project changed while preparing resolution inputs');
  if ((await treeManifest(parent.baseline.workspace, signal)).digest !== base.digest || (await treeManifest(parent.candidate.workspace, signal)).digest !== proposal.digest) throw new Fault('ARTIFACT_CHANGED', 'Resolution input changed during preparation');
  signal.throwIfAborted();
  return store.resolveIntegration(parentId, integrationId, input, attempts, profile, { parentRunId: parentId, integrationId, planId: plan.id,
    requirements, feedback: JSON.stringify({ integrationPhase: job.phase, reason: job.reason,
      acceptance: job.validation.map(result => ({ commandId: result.commandId, status: result.status, exitCode: result.exitCode,
        stdoutTail: result.stdoutTail.slice(-1000), stderrTail: result.stderrTail.slice(-1000) })) }).slice(0, 16_000),
    inputs: { base: parent.baseline, proposal: parent.candidate, current: { workspace: directory, digest: frozen.digest } },
    conflicts: plan.changes.filter(c => c.disposition === 'conflict') });
}
