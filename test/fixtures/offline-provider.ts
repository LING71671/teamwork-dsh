// Test-only deterministic adapter. Never makes an HTTP request or reads credentials.
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { setTimeout } from 'node:timers/promises';

export const name = 'teamwork-offline-test-provider';
export const inject = ['llm'];
export function apply(ctx: Context, config: { repairDemo?: boolean; pauseDemo?: boolean; resolutionDemo?: boolean; requirementDemo?: boolean; revisionDemo?: boolean } = {}): void {
  class OfflineAdapter extends LlmAdapter {
    private calls = 0;
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      options.signal?.throwIfAborted();
      const index = this.calls++;
      const reviewing = process.env.TEAMWORK_ROLE === 'review';
      const resolving = config.resolutionDemo && process.env.TEAMWORK_CONTEXT === '1';
      const revising = config.revisionDemo && process.env.TEAMWORK_CONTEXT === '1';
      const implementationContent = config.repairDemo && process.env.TEAMWORK_EPOCH === '1'
        ? 'first round defect' : revising ? 'changed through real DSH tool + revised goal' : resolving ? 'changed through real DSH tool + user edit' : 'changed through real DSH tool';
      if (config.pauseDemo && !reviewing && process.env.TEAMWORK_EPOCH === '1' && index === 3) {
        // Give the test host a deterministic checkpoint at which to interrupt the actual owned SDK process.
        await setTimeout(60_000, undefined, { ...(options.signal ? { signal: options.signal } : {}) });
      }
      const prefix = resolving || revising ? [
        { kind: 'conflicts' },
        ...(['base', 'proposal', 'current'] as const).map(version => ({ kind: 'file', version, path: 'hello.txt' })),
      ] : [];
      const step = index - prefix.length;
      if (step > 3) throw new Error('Fixture expected submit to conclude the turn');
      const toolName = step < 0 ? 'teamwork_context' : ['read', 'write', 'teamwork_checkpoint', 'teamwork_submit'][step]!;
      if (!options.tools?.some(tool => tool.name === toolName)) throw new Error(`Missing registered tool ${toolName}`);
      const args = step < 0 ? prefix[index] : step === 0 ? { file_path: 'hello.txt' }
        : step === 1 ? { file_path: 'hello.txt', content: reviewing ? 'forbidden reviewer edit' : implementationContent }
        : { commandId: `fixture-${index}`, report: {
          outcome: 'completed', summary: 'Offline DSH plugin integration exercise', unresolved: [],
          ...(reviewing ? { review: { functionality: 'pass', completeness: 'pass', findings: [], ...(config.requirementDemo || revising ? {
            requirements: [{ id: revising ? 'revised' : 'readback', verdict: 'pass', evidence: 'Read hello.txt through the actual read tool; content matches the requested text.' }],
          } : {}) } } : {}),
        } };
      const block = { type: 'tool-call' as const, id: ToolCallId(`fixture-call-${index}`), name: toolName, arguments: JSON.stringify(args) };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: toolName, argumentsDelta: block.arguments };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    }
  }
  ctx.llm.registerAdapter(['teamwork-offline-fixture'], new OfflineAdapter());
}
