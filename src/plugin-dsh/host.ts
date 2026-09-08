import type { Context } from '@deepseek-ai/cordis';
import '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import { startSchema, cancelSchema, identifier } from '../contracts.js';
import { clientFromEnvironment, object, string, tool } from './shared.js';

export const name = 'teamwork-host';
export const inject = ['tools'];
export function apply(ctx: Context): void {
  if (process.env.TEAMWORK_ATTEMPT_TOKEN) throw new Error('Host plugin must not load inside a managed worker');
  const client = clientFromEnvironment(false);
  // Registration only: a reload never starts work or owns the background Runtime.
  ctx.tools.register(tool('teamwork_start',
    'Start a coding attempt in an independent workspace. Only call for user-authorized work. Reuse commandId on network retries. Returns immediately; submitted is NOT verified success.',
    object({ commandId: string, objective: string }), async (args, exec) => {
      await client.hello(exec.signal);
      return client.start(startSchema.parse(args), exec.signal);
    }));
  ctx.tools.register(tool('teamwork_status', 'Read authoritative run status and independent review/command evidence. verified means the candidate passed configured acceptance, NOT integrated. gate not_evaluated means no acceptance yet.',
    object({ runId: string }), async (args, exec) => {
      const { runId } = z.object({ runId: identifier }).strict().parse(args);
      return client.status(runId, exec.signal);
    }));
  ctx.tools.register(tool('teamwork_control', 'Cancel an owned attempt. Supply current revision. Stopping is not confirmation of exit. This development slice supports cancel only.',
    object({ runId: string, commandId: string, expectedRevision: { type: 'integer' }, type: { type: 'string', enum: ['cancel'] } }),
    async (args, exec) => {
      const { runId, ...command } = cancelSchema.extend({ runId: identifier }).parse(args);
      return client.cancel(runId, command, exec.signal);
    }));
}
