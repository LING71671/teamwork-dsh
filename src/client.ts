import { Fault, protocolVersion, type Run, type StartCommand, type CancelCommand, type BridgeCommand, type ControlCommand,
  type ArtifactDescriptor, type ArtifactPage, type ArtifactFile, type ChangePage, type IntegrationPreview, type IntegrateCommand, type IntegrationStatus, type AbandonIntegrationCommand,
  type ResolveIntegrationCommand, type ContextQuery, type ContextResult } from './contracts.js';

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
    }).catch((error: unknown) => {
      if (timeout.aborted || signal?.aborted) throw error;
      const cause = error instanceof Error ? error.cause : undefined;
      const code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(cause.code)
        ? cause.code : 'UNKNOWN';
      const fault = new Fault('TRANSPORT_ERROR', `Runtime connection failed (${code}); command outcome may be unknown. Retry only with the same command ID and payload.`, 503);
      fault.cause = error;
      throw fault; // Never silently replay a possibly accepted write.
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
    return this.control(id, input, signal);
  }
  control(id: string, input: ControlCommand, signal?: AbortSignal): Promise<Run> {
    return this.request(`/v1/runs/${encodeURIComponent(id)}/commands`, input, signal);
  }
  artifacts(id: string, offset = 0, limit = 100, signal?: AbortSignal): Promise<{ artifacts: ArtifactDescriptor[]; nextOffset: number | null }> {
    return this.request(`/v1/runs/${encodeURIComponent(id)}/artifacts?offset=${offset}&limit=${limit}`, undefined, signal);
  }
  artifact(id: string, artifactId: string, offset = 0, limit = 100, signal?: AbortSignal): Promise<ArtifactPage> {
    return this.request(`/v1/runs/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifactId)}?offset=${offset}&limit=${limit}`, undefined, signal);
  }
  artifactFile(id: string, artifactId: string, path: string, offset = 0, length = 16_384, signal?: AbortSignal): Promise<ArtifactFile> {
    const query = new URLSearchParams({ path, offset: String(offset), length: String(length) });
    return this.request(`/v1/runs/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifactId)}/file?${query}`, undefined, signal);
  }
  changes(id: string, artifactId?: string, offset = 0, limit = 100, signal?: AbortSignal): Promise<ChangePage> {
    const query = new URLSearchParams({ offset: String(offset), limit: String(limit), ...(artifactId ? { artifactId } : {}) });
    return this.request(`/v1/runs/${encodeURIComponent(id)}/changes?${query}`, undefined, signal);
  }
  previewIntegration(id: string, artifactId?: string, offset = 0, limit = 100, planId?: string, signal?: AbortSignal): Promise<IntegrationPreview> {
    const query = new URLSearchParams({ offset: String(offset), limit: String(limit), ...(artifactId ? { artifactId } : {}), ...(planId ? { planId } : {}) });
    return this.request(`/v1/runs/${encodeURIComponent(id)}/integration-preview?${query}`, undefined, signal);
  }
  integrate(id: string, input: IntegrateCommand, signal?: AbortSignal): Promise<IntegrationStatus> {
    return this.request(`/v1/runs/${encodeURIComponent(id)}/integrations`, input, signal);
  }
  integrations(id: string, offset = 0, limit = 100, signal?: AbortSignal): Promise<{ integrations: IntegrationStatus[]; nextOffset: number | null }> {
    return this.request(`/v1/runs/${encodeURIComponent(id)}/integrations?offset=${offset}&limit=${limit}`, undefined, signal);
  }
  integration(id: string, integrationId: string, signal?: AbortSignal): Promise<IntegrationStatus> {
    return this.request(`/v1/runs/${encodeURIComponent(id)}/integrations/${encodeURIComponent(integrationId)}`, undefined, signal);
  }
  cancelIntegration(id: string, integrationId: string, input: CancelCommand, signal?: AbortSignal): Promise<IntegrationStatus> {
    return this.request(`/v1/runs/${encodeURIComponent(id)}/integrations/${encodeURIComponent(integrationId)}/commands`, input, signal);
  }
  abandonIntegration(id: string, integrationId: string, input: AbandonIntegrationCommand, signal?: AbortSignal): Promise<IntegrationStatus> {
    return this.request(`/v1/runs/${encodeURIComponent(id)}/integrations/${encodeURIComponent(integrationId)}/commands`, input, signal);
  }
  resolveIntegration(id: string, integrationId: string, input: ResolveIntegrationCommand, signal?: AbortSignal): Promise<Run> {
    return this.request(`/v1/runs/${encodeURIComponent(id)}/integrations/${encodeURIComponent(integrationId)}/commands`, input, signal);
  }
  context(attemptId: string, input: ContextQuery, signal?: AbortSignal): Promise<ContextResult> {
    const query = new URLSearchParams(Object.entries(input).map(([key, value]) => [key, String(value)]));
    return this.request(`/v1/attempts/${encodeURIComponent(attemptId)}/context?${query}`, undefined, signal);
  }
  bridge(id: string, kind: 'checkpoint' | 'submit', input: BridgeCommand, signal?: AbortSignal): Promise<{ accepted: true; runId: string; revision: number }> {
    return this.request(`/v1/attempts/${encodeURIComponent(id)}/${kind}`, input, signal);
  }
}
