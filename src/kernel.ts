import { Fault, type Phase, type Run, type Report } from './contracts.js';

const transitions: Record<Phase, readonly Phase[]> = {
  queued: ['starting', 'cancelled'],
  starting: ['running', 'stopping', 'failed', 'blocked'],
  running: ['stopping', 'submitted', 'freezing', 'failed', 'blocked'],
  freezing: ['reviewing', 'stopping', 'failed', 'blocked'],
  reviewing: ['validating', 'stopping', 'failed', 'blocked'],
  validating: ['verified', 'rejected', 'stopping', 'failed', 'blocked'],
  verified: [], rejected: [],
  stopping: ['cancelled', 'blocked'],
  submitted: [], failed: [], cancelled: [], blocked: [],
};

export function transition(run: Run, phase: Phase, reason?: string): Run {
  if (!transitions[run.phase].includes(phase)) {
    throw new Fault('INVALID_TRANSITION', `${run.phase} -> ${phase} is not allowed`);
  }
  if (phase === 'submitted' && !run.report) {
    throw new Fault('RESULT_MISSING', 'A structured report is required');
  }
  if (phase === 'verified' && run.gate !== 'passed') throw new Fault('GATE_REQUIRED', 'Only a passed gate may be verified');
  return { ...run, phase, revision: run.revision + 1,
    updatedAt: new Date().toISOString(), ...(reason ? { reason } : {}) };
}

/** Pure fail-closed decision; only Runtime can supply command evidence and artifact checks. */
export function evaluateGate(run: Run, integrity: boolean, acceptanceIntegrity = true): string[] {
  const reasons: string[] = [];
  if (!run.candidate || !integrity) reasons.push('CANDIDATE_CHANGED');
  if (!acceptanceIntegrity) reasons.push('ACCEPTANCE_INPUT_CHANGED');
  if (run.report?.outcome !== 'completed' || run.report.unresolved.length) reasons.push('IMPLEMENTATION_INCOMPLETE');
  const review = run.reviewAttempt;
  if (!review || review.order.candidateDigest !== run.candidate?.digest || review.order.runId !== run.id ||
      review.order.attemptId === run.order.attemptId || review.order.specRevision !== run.order.specRevision ||
      review.order.epoch !== run.order.epoch || review.order.role !== 'review') reasons.push('REVIEW_STALE');
  if (review?.report?.outcome !== 'completed' || review.report.unresolved.length ||
      review.report.review?.functionality !== 'pass' || review.report.review.completeness !== 'pass' ||
      review.report.review.findings.length) reasons.push('REVIEW_REJECTED');
  const commands = run.verification?.commands;
  if (!commands?.length || run.validation?.length !== commands.length ||
      commands.some((command, i) => run.validation?.[i]?.commandId !== command.id || run.validation[i]?.status !== 'passed' || run.validation[i]?.exitCode !== 0)) {
    reasons.push('ACCEPTANCE_FAILED');
  }
  return reasons;
}

export function receive(run: Run, kind: 'checkpoint' | 'submit', report: Report): Run {
  if (run.phase !== 'running') throw new Fault('RESULT_STALE', 'Attempt is not accepting results');
  if (run.report) throw new Fault('RESULT_ALREADY_SUBMITTED', 'A final report is already recorded');
  return { ...run, [kind === 'submit' ? 'report' : 'checkpoint']: report,
    revision: run.revision + 1, updatedAt: new Date().toISOString() };
}
