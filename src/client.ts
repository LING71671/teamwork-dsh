import { Fault, protocolVersion, type Run, type StartCommand, type CancelCommand, type BridgeCommand } from './contracts.js';

export class Client {
  private readonly url: string;
  constructor(url: string, private readonly token: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' ||
        parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Fault('CONFIG_INVALID', 'Runtime URL must be http://127.0.0.1:<port>', 400);
    }
    this.url = parsed.origin;
  }
  private async request<T>(path: string, data?: unknown, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(15_000);
    const response = await fetch(this.url + path, {
      method: data === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const result = await response.json() as { error?: { code: string; message: string } };
    if (!response.ok) throw new Fault(result.error?.code ?? 'HTTP_ERROR', result.error?.message ?? 'Runtime request failed', response.status);
    return result as T;
  }
  async hello(signal?: AbortSignal): Promise<void> {
    const info = await this.request<{ protocolVersion: string }>('/v1/hello', undefined, signal);
    if (info.protocolVersion !== protocolVersion) throw new Fault('PROTOCOL_MISMATCH', 'Runtime protocol version differs');
  }
  start(input: StartCommand, signal?: AbortSignal): Promise<Run> { return this.request('/v1/runs', input, signal); }
  status(id: string, signal?: AbortSignal): Promise<Run> { return this.request(`/v1/runs/${encodeURIComponent(id)}`, undefined, signal); }
  cancel(id: string, input: CancelCommand, signal?: AbortSignal): Promise<Run> {
    return this.request(`/v1/runs/${encodeURIComponent(id)}/commands`, input, signal);
  }
  bridge(id: string, kind: 'checkpoint' | 'submit', input: BridgeCommand, signal?: AbortSignal): Promise<{ accepted: true; runId: string; revision: number }> {
    return this.request(`/v1/attempts/${encodeURIComponent(id)}/${kind}`, input, signal);
  }
}
