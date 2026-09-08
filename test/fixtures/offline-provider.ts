// Test-only deterministic adapter. Never makes an HTTP request or reads credentials.
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';

export const name = 'teamwork-offline-test-provider';
export const inject = ['llm'];
export function apply(ctx: Context): void {
  class OfflineAdapter extends LlmAdapter {
    private calls = 0;
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      options.signal?.throwIfAborted();
      const index = this.calls++;
      const reviewing = process.env.TEAMWORK_ROLE === 'review';
      if (index > 3) throw new Error('Fixture expected submit to conclude the turn');
      const toolName = ['read', 'write', 'teamwork_checkpoint', 'teamwork_submit'][index]!;
      if (!options.tools?.some(tool => tool.name === toolName)) throw new Error(`Missing registered tool ${toolName}`);
      const args = index === 0 ? { file_path: 'hello.txt' }
        : index === 1 ? { file_path: 'hello.txt', content: reviewing ? 'forbidden reviewer edit' : 'changed through real DSH tool' }
        : { commandId: `fixture-${index}`, report: {
          outcome: 'completed', summary: 'Offline DSH plugin integration exercise', unresolved: [],
          ...(reviewing ? { review: { functionality: 'pass', completeness: 'pass', findings: [] } } : {}),
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
