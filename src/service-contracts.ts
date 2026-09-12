import { z } from 'zod';
import { identifier } from './contracts.js';

export const lifecycleSchema = z.enum(['attached', 'persistent']);
export type Lifecycle = z.infer<typeof lifecycleSchema>;
export const shutdownSchema = z.object({ type: z.literal('stop'), instanceId: identifier, commandId: identifier,
  mode: z.enum(['drain', 'interrupt']).default('drain') }).strict();
export type ShutdownCommand = z.infer<typeof shutdownSchema>;
export interface ShutdownReceipt { accepted: true; instanceId: string; commandId: string; mode: 'drain' | 'interrupt'; rootRunIds: string[] }
export interface ServiceStatus {
  instanceId: string; pid: number; lifecycle: Lifecycle; startedAt: string;
  state: 'running' | 'draining' | 'stopping' | 'blocked' | 'stopped';
  activeRunIds: string[]; blockedRunIds: string[]; pausedRunIds: string[]; pendingRunIds: string[];
  activeIntegrationId?: string | undefined; reason?: string | undefined;
}
export interface ServiceManagement {
  token: string;
  status(): ServiceStatus;
  stop(input: ShutdownCommand): ShutdownReceipt;
}
