import { z } from 'zod';
import { portablePath } from './portable-path.js';

export const protocolVersion = '0.3';
export const identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const scopePath = z.string().refine(path => portablePath(path) && path === path.normalize('NFC'), 'Use a normalized portable relative path, not a glob');
export const writeScopeSchema = z.object({
  files: z.array(scopePath).max(200),
  trees: z.array(z.union([z.literal('.'), scopePath])).max(200),
}).strict();
export const runSpecSchema = z.object({
  requirements: z.array(z.object({ id: identifier, text: z.string().trim().min(1).max(2000) }).strict()).max(100)
    .refine(items => new Set(items.map(item => item.id)).size === items.length, 'Requirement IDs must be unique')
    .refine(items => items.reduce((sum, item) => sum + item.text.length, 0) <= 32_000, 'Requirements exceed the character budget'),
  writeScope: writeScopeSchema,
}).strict();
export type RunSpec = z.infer<typeof runSpecSchema>;
export type WriteScope = RunSpec['writeScope'];
export interface ScopeCheck { inputDigest: string; baselineDigest: string; candidateDigest: string; violations: string[] }
export const modelBudgetSchema = z.object({ maxModelAttempts: z.number().int().min(0).max(1000) }).strict();
export interface ModelBudgetStatus {
  rootRunId: string; revision: number; maxModelAttempts: number; reservedModelAttempts: number;
  lastIncrease?: { reason: string; at: string; previousMaxModelAttempts: number };
}
export const startSchema = z.object({
  commandId: identifier,
  objective: z.string().trim().min(1).max(32_000),
  spec: runSpecSchema.optional(),
  budget: modelBudgetSchema.optional(),
}).strict();
export const cancelSchema = z.object({
  commandId: identifier,
  expectedRevision: z.number().int().nonnegative(),
  type: z.literal('cancel'),
}).strict();
export const pauseSchema = cancelSchema.extend({ type: z.literal('pause'), mode: z.enum(['drain', 'interrupt']).default('drain') });
export const resumeSchema = cancelSchema.extend({ type: z.literal('resume') });
export const reviseSchema = cancelSchema.extend({ type: z.literal('revise'), objective: z.string().trim().min(1).max(32_000),
  spec: runSpecSchema, reason: z.string().trim().min(1).max(2000) });
export const budgetCommandSchema = cancelSchema.extend({ type: z.literal('budget'), expectedBudgetRevision: z.number().int().nonnegative(),
  maxModelAttempts: modelBudgetSchema.shape.maxModelAttempts, reason: z.string().trim().min(1).max(2000) });
export type BudgetCommand = z.infer<typeof budgetCommandSchema>;
export const controlSchema = z.discriminatedUnion('type', [cancelSchema, pauseSchema, resumeSchema, reviseSchema, budgetCommandSchema]);
export const integrationPolicySchema = z.object({ enabled: z.boolean() }).strict();
export const integrateSchema = cancelSchema.extend({ type: z.literal('integrate'), planId: z.string().regex(/^[a-f0-9]{64}$/) });
export const abandonIntegrationSchema = cancelSchema.extend({ type: z.literal('abandon'), targetDigest: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().trim().min(1).max(2000) });
export const resolveIntegrationSchema = cancelSchema.extend({ type: z.literal('resolve'), planId: z.string().regex(/^[a-f0-9]{64}$/), instructions: z.string().trim().min(1).max(16_000) });
export type IntegrateCommand = z.infer<typeof integrateSchema>;
export type AbandonIntegrationCommand = z.infer<typeof abandonIntegrationSchema>;
export type ResolveIntegrationCommand = z.infer<typeof resolveIntegrationSchema>;
export type IntegrationPolicy = z.infer<typeof integrationPolicySchema>;
export const reportSchema = z.object({
  outcome: z.enum(['completed', 'incomplete']),
  summary: z.string().trim().min(1).max(16_000),
  // Claims, not independently verified evidence. No artifact paths are trusted here.
  unresolved: z.array(z.string().max(2_000)).max(100),
  review: z.object({
    functionality: z.enum(['pass', 'fail']),
    completeness: z.enum(['pass', 'fail']),
    findings: z.array(z.string().max(2_000)).max(100),
    requirements: z.array(z.object({ id: identifier, verdict: z.enum(['pass', 'fail']),
      evidence: z.string().trim().min(1).max(2000) }).strict()).max(100).optional(),
  }).strict().optional(),
}).strict();
export const verificationSchema = z.object({
  // Total implementation rounds, including the first. Absent means no automatic repair.
  maxIterations: z.number().int().min(1).max(5).optional(),
  commands: z.array(z.object({
    id: identifier,
    executable: z.string().min(1),
    args: z.array(z.string().max(8_000)).max(100),
    timeoutMs: z.number().int().min(100).max(600_000),
  }).strict()).min(1).max(20).refine(commands => new Set(commands.map(c => c.id)).size === commands.length, 'Command IDs must be unique'),
}).strict();
export type VerificationPolicy = z.infer<typeof verificationSchema>;
export interface Candidate { workspace: string; digest: string; artifactId?: string }
export interface ArtifactDescriptor {
  id: string; runId: string; kind: 'baseline' | 'candidate' | 'checkpoint' | 'integrated' | 'context'; digest: string; attemptId: string; createdAt: string;
  specRevision?: number;
  baselineId?: string;
}
export type TreeEntry = { path: string; kind: 'directory' } |
  { path: string; kind: 'file'; size: number; executable: number; digest: string };
export interface TreeManifest { digest: string; entries: TreeEntry[]; bytes: number }
export interface ArtifactPage { artifact: ArtifactDescriptor; entries: TreeEntry[]; total: number; nextOffset: number | null }
export interface ArtifactFile {
  artifact: ArtifactDescriptor; path: string; digest: string; size: number; offset: number; bytes: number;
  encoding: 'utf8' | 'base64'; content: string; nextOffset: number | null;
}
export interface Change { path: string; kind: 'added' | 'deleted' | 'modified' | 'type_changed'; before?: TreeEntry; after?: TreeEntry }
export interface ChangePage { baseline: ArtifactDescriptor; candidate: ArtifactDescriptor; changes: Change[]; total: number; nextOffset: number | null }
export type IntegrationConflict = 'concurrent_change' | 'ancestor_changed' | 'descendant_changed' | 'protected_path' | 'path_alias';
export interface IntegrationChange extends Change {
  disposition: 'apply' | 'already_applied' | 'conflict';
  reasons: IntegrationConflict[];
}
export interface IntegrationPlan {
  id: string;
  baselineDigest: string;
  candidateDigest: string;
  targetDigest: string;
  status: 'clear' | 'conflicts';
  changes: IntegrationChange[];
}
export interface IntegrationPreview extends Omit<IntegrationPlan, 'changes'> {
  runId: string; revision: number;
  baseline: ArtifactDescriptor; candidate: ArtifactDescriptor;
  candidateVerified: boolean;
  // A read-only preflight, never an authorization, lock, or final acceptance result.
  readOnly: true;
  changes: IntegrationChange[]; total: number; conflictCount: number; nextOffset: number | null;
}
export type IntegrationPhase = 'prepared' | 'applying' | 'snapshotting' | 'validating' | 'succeeded' | 'conflict' | 'blocked' | 'failed' | 'cancelled' | 'abandoning' | 'abandoned';
export interface IntegrationStatus {
  id: string; runId: string; revision: number; phase: IntegrationPhase; planId: string;
  completedEffects: number; totalEffects: number; conflictCount: number;
  cancelRequested: boolean; reason?: string; recoveryDirectory: string;
  integrated?: Candidate; validation: ValidationResult[];
  resolution?: { kind: 'keep-current'; targetDigest: string; reason: string };
  commandStop?: { commandId: string; proof: 'not-started' | 'direct-process-exited' };
  resolutionRunId?: string;
}
export const pageSchema = z.object({ offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100) }).strict();
export const filePageSchema = z.object({ path: z.string().min(1).max(2048), offset: z.coerce.number().int().min(0).max(100 * 1024 * 1024).default(0),
  length: z.coerce.number().int().min(1).max(65_536).default(16_384) }).strict();
export const changePageSchema = pageSchema.extend({ artifactId: identifier.optional() });
export const integrationPageSchema = changePageSchema.extend({ planId: z.string().regex(/^[a-f0-9]{64}$/).optional() });
export const contextVersionSchema = z.enum(['base', 'proposal', 'current']);
export type ContextVersion = z.infer<typeof contextVersionSchema>;
export const contextQuerySchema = z.discriminatedUnion('kind', [
  pageSchema.extend({ kind: z.literal('conflicts') }),
  pageSchema.extend({ kind: z.literal('manifest'), version: contextVersionSchema }),
  filePageSchema.extend({ kind: z.literal('file'), version: contextVersionSchema }),
]);
export type ContextQuery = z.infer<typeof contextQuerySchema>;
export type ContextResult = ArtifactPage | ArtifactFile | { conflicts: IntegrationChange[]; total: number; nextOffset: number | null; available?: boolean };
export interface ResolutionContext {
  parentRunId: string; integrationId: string; planId: string;
  requirements: string[];
  feedback: string;
  inputs: Record<ContextVersion, Candidate>;
  conflicts: IntegrationChange[];
}
export interface RevisionContext {
  previousSpecRevision: number;
  reason: string;
  inputs: { current: Candidate; base?: Candidate; proposal?: Candidate };
  conflicts: IntegrationChange[];
  conflictPreviewAvailable: boolean;
  unavailable: ContextVersion[];
}
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
export type PauseCommand = z.infer<typeof pauseSchema>;
export type ResumeCommand = z.infer<typeof resumeSchema>;
export type ReviseCommand = z.infer<typeof reviseSchema>;
export type ControlCommand = z.infer<typeof controlSchema>;
export type Report = z.infer<typeof reportSchema>;
export type BridgeCommand = z.infer<typeof bridgeSchema>;
export type Phase = 'queued' | 'repair_queued' | 'verification_queued' | 'verification_starting' |
  'pausing' | 'paused' | 'starting' | 'running' | 'stopping' |
  'submitted' | 'failed' | 'cancelled' | 'blocked' | 'freezing' | 'reviewing' | 'validating' | 'verified' | 'rejected' | 'superseded';

export interface WorkOrder {
  runId: string;
  workItemId: string;
  attemptId: string;
  dispatchKey: string;
  epoch: number;
  specRevision: number;
  inputDigest: string;
  inputTreeDigest?: string;
  objective: string;
  spec?: RunSpec;
  workspace: string;
  role?: 'implementation' | 'review';
  candidateDigest?: string;
  repair?: { candidate: Candidate; feedback: string };
  resume?: { previousAttemptId: string; candidate?: Candidate; checkpoint?: Report };
  resolution?: ResolutionContext;
  revisionContext?: RevisionContext;
}
export type PauseContinuation = { kind: 'queued'; phase: 'queued' | 'repair_queued' | 'verification_queued' } |
  { kind: 'implementation'; candidate?: Candidate } | { kind: 'verification'; candidate: Candidate } |
  { kind: 'submitted'; candidate: Candidate };
export interface RoundEvidence {
  iteration: number;
  order: WorkOrder;
  report?: Report;
  checkpoint?: Report;
  candidate?: Candidate;
  reviewAttempt?: { order: WorkOrder; report?: Report; checkpoint?: Report };
  validation?: ValidationResult[];
  gateReasons?: string[];
  scopeCheck?: ScopeCheck;
  finishedAt: string;
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
  baseline?: Candidate;
  candidate?: Candidate;
  reviewAttempt?: { order: WorkOrder; report?: Report; checkpoint?: Report };
  validation?: ValidationResult[];
  gateReasons?: string[];
  scopeCheck?: ScopeCheck;
  // Optional for reading databases written before protocol 0.3; defaults to 1 / [].
  iteration?: number;
  history?: RoundEvidence[];
  pause?: { mode: 'drain' | 'interrupt'; stage: Phase; continuation?: PauseContinuation };
  suspensions?: RoundEvidence[];
  integration?: IntegrationStatus;
  parentRunId?: string;
  supersededBy?: { runId: string; specRevision: number };
  specHistory?: { reason: string; at: string; previous: Omit<Run, 'specHistory'> }[];
  budget?: ModelBudgetStatus;
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
  ['submitted', 'failed', 'cancelled', 'blocked', 'verified', 'rejected', 'superseded'].includes(phase);

// Portable execution seam: importing this module never loads a harness SDK.
export interface Execution {
  run(): Promise<void>;
  /** Resolves only after the owned runtime exited. Reject means UNKNOWN, not stopped. */
  close(): Promise<void>;
}
export interface Executor {
  create(order: WorkOrder, bridge: { url: string; token: string }): Execution;
}
