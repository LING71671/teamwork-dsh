import { createHash } from 'node:crypto';
import type { Run, WorkflowHold, WorkflowStatus } from './contracts.js';
import { integrationStatus, type IntegrationRecord } from './integration-journal.js';

export const activeRun = (run: Run): boolean => ['starting', 'running', 'freezing', 'verification_starting', 'reviewing', 'validating', 'pausing', 'stopping'].includes(run.phase);
export const activeIntegration = (job: IntegrationRecord): boolean => job.dispatch === 'claimed' && ['prepared', 'applying', 'snapshotting', 'validating', 'abandoning'].includes(job.phase);

/** Pure status projection. Historical ancestor conflicts are not the state of their replacement child. */
export function workflowStatus(rootRunId: string, runs: Run[], jobs: IntegrationRecord[], holds: WorkflowHold[]): WorkflowStatus {
  runs = [...runs].sort((a, b) => a.id.localeCompare(b.id)); jobs = [...jobs].sort((a, b) => a.id.localeCompare(b.id));
  holds = [...holds].sort((a, b) => a.rootRunId.localeCompare(b.rootRunId));
  const byId = new Map(runs.map(run => [run.id, run]));
  const reachable = new Set([rootRunId]), replaced = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const run of runs) if (reachable.has(run.id)) {
      const children = [run.automaticIntegration?.resolutionRunId, ...jobs.filter(job => job.runId === run.id && job.gateInputDigest === run.order.inputDigest).map(job => job.resolutionRunId)];
      for (const id of children) if (id && byId.has(id) && byId.get(id)!.phase !== 'superseded') {
        replaced.add(run.id); if (!reachable.has(id)) { reachable.add(id); changed = true; }
      }
    }
  }
  const leaves = runs.filter(run => reachable.has(run.id) && !replaced.has(run.id));
  const budgets = [...new Map(runs.filter(run => run.budget).map(run => [run.budget!.rootRunId, run.budget!])).values()].sort((a, b) => a.rootRunId.localeCompare(b.rootRunId));
  const activeRunIds = runs.filter(activeRun).map(run => run.id), active = activeRunIds.length > 0 || jobs.some(activeIntegration);
  const governing = holds.filter(hold => hold.rootRunId === rootRunId || !byId.has(hold.rootRunId));
  const held = governing.some(hold => hold.mode === 'cancelled') ? 'cancelled' : governing.some(hold => hold.mode === 'paused') ? 'paused' : undefined;
  let state: WorkflowStatus['state'];
  if (!leaves.length || runs.some(run => run.phase === 'blocked') || jobs.some(job => ['blocked', 'failed'].includes(job.phase))) state = 'blocked';
  else if (held === 'cancelled') state = active ? 'cancelling' : 'cancelled';
  else if (held === 'paused') state = active ? 'pausing' : 'paused';
  else if (active || runs.some(run => ['queued', 'repair_queued', 'verification_queued'].includes(run.phase) || run.automaticIntegration?.state === 'pending') ||
      jobs.some(job => job.phase === 'prepared')) state = 'running';
  else if (runs.some(run => run.phase === 'paused' || run.automaticIntegration?.state === 'paused')) state = 'paused';
  else if (leaves.every(run => run.phase === 'verified' && run.integration?.phase === 'succeeded')) state = 'integrated';
  else if (leaves.every(run => run.phase === 'verified' && !run.autonomy && !run.integration && !run.automaticIntegration)) state = 'verified';
  else if (leaves.every(run => run.phase === 'submitted')) state = 'submitted';
  else if (leaves.every(run => ['cancelled', 'superseded'].includes(run.phase))) state = 'cancelled';
  else state = 'needs_attention';
  const summaries = runs.map(({ id, revision, phase, gate, parentRunId, reason, automaticIntegration }) => ({ id, revision, phase, gate,
    ...(parentRunId ? { parentRunId } : {}), ...(reason ? { reason } : {}), ...(automaticIntegration ? { automaticIntegration } : {}) }));
  const revision = createHash('sha256').update(JSON.stringify([rootRunId, summaries, jobs.map(job => [job.id, job.revision]), budgets, holds])).digest('hex');
  return { rootRunId, revision, state, runs: summaries, integrations: jobs.map(integrationStatus), budgets, holds, activeRunIds, leafRunIds: leaves.map(run => run.id) };
}
