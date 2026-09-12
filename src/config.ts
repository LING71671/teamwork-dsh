import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { z } from 'zod';
import { verificationSchema, integrationPolicySchema } from './contracts.js';

const absolute = z.string().refine(isAbsolute, 'Use an absolute path');
export const configSchema = z.object({
  workspace: absolute, dataDirectory: absolute,
  port: z.number().int().min(0).max(65535).default(0),
  maxConcurrency: z.number().int().min(1).max(4).default(1),
  attemptTimeoutMs: z.number().int().min(1_000).max(3_600_000).default(600_000),
  verification: verificationSchema.refine(policy => policy.commands.every(c => isAbsolute(c.executable)), 'Acceptance executables must be absolute').optional(),
  integration: integrationPolicySchema.optional(),
  dsh: z.object({ dshBin: absolute, profile: z.string().min(1).default('sdk'),
    patches: z.array(absolute).default([]), provider: z.string().min(1), model: z.string().min(1),
    dshHome: absolute.optional() }).strict(),
}).strict().refine(config => !config.integration?.enabled || !!config.verification, 'Integration requires verification');
export async function readConfig(path: string) { return configSchema.parse(JSON.parse(await readFile(resolve(path), 'utf8'))); }
