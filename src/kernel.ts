import { Fault, type Phase, type Run, type Report } from './contracts.js';

const transitions: Record<Phase, readonly Phase[]> = {
  queued: ['starting', 'cancelled', 'paused'],
  repair_queued: ['starting', 'cancelled', 'paused'],
  verification_queued: ['verification_starting', 'cancelled', 'paused'],
  verification_starting: ['reviewing', 'stopping', 'failed', 'blocked'],
  pausing: ['paused', 'stopping', 'failed', 'blocked'],
  paused: ['queued', 'repair_queued', 'verification_queued', 'submitted', 'cancelled'],
  starting: ['running', 'stopping', 'failed', 'blocked'],
  running: ['stopping', 'submitted', 'freezing', 'failed', 'blocked'],
  freezing: ['reviewing', 'verification_queued', 'stopping', 'failed', 'blocked'],
  reviewing: ['validating', 'stopping', 'failed', 'blocked'],
  validating: ['verified', 'rejected', 'repair_queued', 'stopping', 'failed', 'blocked'],
  verified: [], rejected: [],
  stopping: ['cancelled', 'blocked'],
  submitted: [], failed: [], cancelled: [], blocked: [],
};

/** Public pausing phase overlays the still-draining execution stage. */
export const activityPhase = (run: Run): Phase => run.phase === 'pausing' ? run.pause!.stage : run.phase;

export function transition(run: Run, phase: Phase, reason?: string): Run {
  const from = run.phase === 'pausing' && phase !== 'paused' ? activityPhase(run) : run.phase;
  if (!transitions[from].includes(phase)) {
    throw new Fault('INVALID_TRANSITION', `${run.phase} -> ${phase} is not allowed`);
  }
  if (phase === 'submitted' && !run.report) {
    throw new Fault('RESULT_MISSING', 'A structured report is required');
  }
  if (phase === 'verified' && run.gate !== 'passed') throw new Fault('GATE_REQUIRED', 'Only a passed gate may be verified');
  const next = { ...run, phase, revision: run.revision + 1,
    updatedAt: new Date().toISOString(), ...(reason ? { reason } : {}) };
  if (run.phase === 'pausing' && !['paused', 'stopping', 'failed', 'blocked', 'cancelled', 'submitted', 'verified', 'rejected'].includes(phase)) {
    return { ...next, phase: 'pausing', pause: { ...run.pause!, stage: phase } };
  }
  if (phase !== 'paused') delete next.pause;
  return next;
}

/** Pure fail-closed decision; only Runtime can supply command evidence and artifact checks. */
export function evaluateGate(run: Run, integrity: boolean, acceptanceIntegrity = true): string[] {
  const reasons: string[] = [];
  if (!run.candidate || !integrity) reasons.push('CANDIDATE_CHANGED');
  if (!acceptanceIntegrity) reasons.push('ACCEPTANCE_INPUT_CHANGED');
  if (run.order.spec && (!run.scopeCheck || run.scopeCheck.inputDigest !== run.order.inputDigest || run.scopeCheck.baselineDigest !== run.baseline?.digest ||
    run.scopeCheck.candidateDigest !== run.candidate?.digest || run.scopeCheck.violations.length)) reasons.push('SCOPE_NOT_VERIFIED');
  if (run.report?.outcome !== 'completed' || run.report.unresolved.length) reasons.push('IMPLEMENTATION_INCOMPLETE');
  const review = run.reviewAttempt;
  if (!review || review.order.candidateDigest !== run.candidate?.digest || review.order.runId !== run.id ||
      review.order.attemptId === run.order.attemptId || review.order.specRevision !== run.order.specRevision ||
      review.order.epoch !== run.order.epoch || review.order.role !== 'review' ||
      JSON.stringify(review.order.spec) !== JSON.stringify(run.order.spec) ||
      (review.order.inputTreeDigest !== undefined && review.order.inputTreeDigest !== run.candidate?.digest)) reasons.push('REVIEW_STALE');
  if (review?.report?.outcome !== 'completed' || review.report.unresolved.length ||
      review.report.review?.functionality !== 'pass' || review.report.review.completeness !== 'pass' ||
      review.report.review.findings.length) reasons.push('REVIEW_REJECTED');
  const requirements = run.order.spec?.requirements ?? [], assessments = review?.report?.review?.requirements ?? [];
  if (assessments.length !== requirements.length || new Set(assessments.map(item => item.id)).size !== requirements.length ||
    requirements.some(requirement => !assessments.some(item => item.id === requirement.id))) reasons.push('REQUIREMENT_EVIDENCE_MISSING');
  else if (assessments.some(item => item.verdict !== 'pass' || !item.evidence.trim())) reasons.push('REQUIREMENT_REJECTED');
  const commands = run.verification?.commands;
  if (!commands?.length || run.validation?.length !== commands.length ||
      commands.some((command, i) => run.validation?.[i]?.commandId !== command.id || run.validation[i]?.status !== 'passed' || run.validation[i]?.exitCode !== 0)) {
    reasons.push('ACCEPTANCE_FAILED');
  }
  return reasons;
}

export function receive(run: Run, kind: 'checkpoint' | 'submit', report: Report): Run {
  if (activityPhase(run) !== 'running' || (run.phase === 'pausing' && run.pause?.mode !== 'drain')) {
    throw new Fault('RESULT_STALE', 'Attempt is not accepting results');
  }
  if (run.report) throw new Fault('RESULT_ALREADY_SUBMITTED', 'A final report is already recorded');
  return { ...run, [kind === 'submit' ? 'report' : 'checkpoint']: report,
    revision: run.revision + 1, updatedAt: new Date().toISOString() };
}

/** Defects may be repaired, but broken infrastructure or untrusted evidence may not. */
export function repairEligible(run: Run, reasons: string[]): boolean {
  const commands = run.verification?.commands;
  return (run.iteration ?? 1) < (run.verification?.maxIterations ?? 1) &&
    !!run.candidate && !!run.reviewAttempt?.report && reasons.length > 0 &&
    reasons.every(reason => ['IMPLEMENTATION_INCOMPLETE', 'REVIEW_REJECTED', 'REQUIREMENT_REJECTED', 'ACCEPTANCE_FAILED'].includes(reason)) &&
    !!commands?.length && run.validation?.length === commands.length &&
    commands.every((command, i) => run.validation?.[i]?.commandId === command.id &&
      ['passed', 'failed', 'timed_out'].includes(run.validation[i]!.status));
}

/** Bounded diagnostic data, not permission to change the objective or acceptance policy. */
export function repairFeedback(run: Run): string {
  return JSON.stringify({
    gateReasons: run.gateReasons,
    implementation: { summary: run.report?.summary.slice(0, 1000), unresolved: run.report?.unresolved.slice(0, 10) },
    review: { summary: run.reviewAttempt?.report?.summary.slice(0, 1000), assessment: run.reviewAttempt?.report?.review },
    acceptance: run.validation?.filter(result => result.status !== 'passed').map(result => ({
      commandId: result.commandId, status: result.status, exitCode: result.exitCode,
      stdoutTail: result.stdoutTail.slice(-2000), stderrTail: result.stderrTail.slice(-2000),
    })),
  }).slice(0, 16_000);
}
