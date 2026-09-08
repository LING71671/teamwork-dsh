import type { ToolDefinition, JsonSchemaNode } from '@deepseek-ai/dsh-tools';
import { Client } from '../client.js';
import { Fault } from '../contracts.js';
import { readFileSync } from 'node:fs';

export function clientFromEnvironment(worker: boolean): Client {
  if (!worker && process.env.TEAMWORK_CONNECTION_FILE) {
    const record = JSON.parse(readFileSync(process.env.TEAMWORK_CONNECTION_FILE, 'utf8')) as { url: string; token: string };
    return new Client(record.url, record.token);
  }
  const url = process.env.TEAMWORK_URL;
  const token = process.env[worker ? 'TEAMWORK_ATTEMPT_TOKEN' : 'TEAMWORK_HOST_TOKEN'];
  if (!url || !token) throw new Fault('CONFIG_INVALID', 'Teamwork endpoint and scoped credential are required');
  return new Client(url, token);
}
export const string = { type: 'string' } as const;
export function object(properties: Record<string, JsonSchemaNode>, required = Object.keys(properties)): JsonSchemaNode {
  return { type: 'object', properties, required, additionalProperties: false };
}
export function tool(name: string, description: string, parameters: JsonSchemaNode,
  execute: ToolDefinition['execute']): ToolDefinition {
  return { name, description, parameters: { ...parameters },
    output: { schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute };
}
