import { z } from 'zod';

export const protocolVersion = '0.2';
export const identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const startSchema = z.object({
  commandId: identifier,
  objective: z.string().trim().min(1).max(32_000),
}).strict();
export const cancelSchema = z.object({
  commandId: identifier,
  expectedRevision: z.number().int().nonnegative(),
  type: z.literal('cancel'),
}).strict();
export const reportSchema = z.object({
  outcome: z.enum(['completed', 'incomplete']),
  summary: z.string().trim().min(1).max(16_000),
  // Claims, not independently verified evidence. No artifact paths are trusted here.
  unresolved: z.array(z.string().max(2_000)).max(100),
  review: z.object({
    functionality: z.enum(['pass', 'fail']),
    completeness: z.enum(['pass', 'fail']),
    findings: z.array(z.string().max(2_000)).max(100),
  }).strict().optional(),
}).strict();
export const verificationSchema = z.object({
  commands: z.array(z.object({
    id: identifier,
    executable: z.string().min(1),
    args: z.array(z.string().max(8_000)).max(100),
    timeoutMs: z.number().int().min(100).max(600_000),
  }).strict()).min(1).max(20).refine(commands => new Set(commands.map(c => c.id)).size === commands.length, 'Command IDs must be unique'),
}).strict();
export type VerificationPolicy = z.infer<typeof verificationSchema>;
export interface Candidate { workspace: string; digest: string }
export interface ValidationResult {
  commandId: string;
  status: 'passed' | 'failed' | 'timed_out' | 'spawn_failed';
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
}
export const bridgeSchema = z.object({
  commandId: identifier,
  epoch: z.number().int().positive(),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  report: reportSchema,
}).strict();
export type StartCommand = z.infer<typeof startSchema>;
export type CancelCommand = z.infer<typeof cancelSchema>;
export type Report = z.infer<typeof reportSchema>;
export type BridgeCommand = z.infer<typeof bridgeSchema>;
export type Phase = 'queued' | 'starting' | 'running' | 'stopping' |
  'submitted' | 'failed' | 'cancelled' | 'blocked' | 'freezing' | 'reviewing' | 'validating' | 'verified' | 'rejected';

export interface WorkOrder {
  runId: string;
  workItemId: string;
  attemptId: string;
  dispatchKey: string;
  epoch: number;
  specRevision: number;
  inputDigest: string;
  objective: string;
  workspace: string;
  role?: 'implementation' | 'review';
  candidateDigest?: string;
}
export interface Run {
  id: string;
  revision: number;
  phase: Phase;
  gate: 'not_evaluated' | 'passed' | 'failed';
  order: WorkOrder;
  createdAt: string;
  updatedAt: string;
  report?: Report;
  checkpoint?: Report;
  reason?: string;
  verification?: VerificationPolicy;
  candidate?: Candidate;
  reviewAttempt?: { order: WorkOrder; report?: Report; checkpoint?: Report };
  validation?: ValidationResult[];
  gateReasons?: string[];
}
export interface Event {
  cursor: number;
  runId: string;
  revision: number;
  type: string;
  at: string;
}
export class Fault extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
  }
}
export const terminal = (phase: Phase): boolean =>
  ['submitted', 'failed', 'cancelled', 'blocked', 'verified', 'rejected'].includes(phase);

// Portable execution seam: importing this module never loads a harness SDK.
export interface Execution {
  run(): Promise<void>;
  /** Resolves only after the owned runtime exited. Reject means UNKNOWN, not stopped. */
  close(): Promise<void>;
}
export interface Executor {
  create(order: WorkOrder, bridge: { url: string; token: string }): Execution;
}
