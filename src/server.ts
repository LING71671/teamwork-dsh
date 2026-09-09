import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ZodError } from 'zod';
import { Runtime } from './runtime.js';
import { Fault, protocolVersion, startSchema, controlSchema, bridgeSchema, pageSchema, filePageSchema, changePageSchema, integrationPageSchema,
  integrateSchema, cancelSchema, abandonIntegrationSchema, resolveIntegrationSchema, contextQuerySchema, type ContextResult } from './contracts.js';
import { artifactManifest, artifactFile, artifactChanges } from './artifacts.js';

async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Fault('CONTENT_TYPE', 'Use application/json', 415);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    if ((size += buffer.length) > 256 * 1024) throw new Fault('BODY_TOO_LARGE', 'Request exceeds 256 KiB', 413);
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new Fault('SCHEMA_INVALID', 'Invalid JSON', 400); }
}
const equal = (a: string, b: string): boolean => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const json = (res: ServerResponse, status: number, value: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
};

export async function serve(runtime: Runtime, token: string, port = 0): Promise<{ url: string; close(): Promise<void> }> {
  if (token.length < 32) throw new Fault('CONFIG_INVALID', 'Host token must be at least 32 characters', 400);
  const streams = new Set<ServerResponse>();
  let inspections = 0;
  async function inspect<T>(res: ServerResponse, body: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (inspections >= 2) throw new Fault('INSPECTION_LIMIT', 'Too many concurrent artifact reads', 429);
    inspections++;
    const abort = new AbortController();
    const close = (): void => abort.abort(new Fault('ABORTED', 'Artifact reader disconnected'));
    res.once('close', close);
    const timer = setTimeout(() => abort.abort(new Fault('INSPECTION_TIMEOUT', 'Artifact read deadline exceeded', 503)), 15_000);
    try { return await body(abort.signal); }
    finally { clearTimeout(timer); res.off('close', close); inspections--; }
  }
  const server = createServer((req, res) => { void route(req, res).catch(error => {
    if (res.headersSent) { res.end(); return; }
    const fault = error instanceof Fault ? error : error instanceof ZodError
      ? new Fault('SCHEMA_INVALID', 'Request does not match the protocol schema', 400)
      : new Fault('INTERNAL_ERROR', 'Internal runtime error', 500);
    json(res, fault.status, { error: { code: fault.code, message: fault.message } });
  }); });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 50;
  server.keepAliveTimeout = 5_000;
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.origin !== undefined) throw new Fault('ORIGIN_DENIED', 'Browser origins are not supported', 403);
    const address = server.address();
    if (!address || typeof address === 'string' || req.headers.host !== `127.0.0.1:${address.port}`) {
      throw new Fault('HOST_DENIED', 'Use the exact loopback endpoint', 403);
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const auth = req.headers.authorization?.match(/^Bearer ([^\s]+)$/)?.[1] ?? '';
    const context = /^\/v1\/attempts\/([a-zA-Z0-9_-]+)\/context$/.exec(url.pathname);
    if (context && req.method === 'GET') {
      const attemptId = context[1]!, scope = runtime.store.contextScope(attemptId, auth);
      const query = Object.fromEntries(url.searchParams);
      if (Object.keys(query).length !== [...url.searchParams].length) throw new Fault('SCHEMA_INVALID', 'Duplicate query parameters', 400);
      const input = contextQuerySchema.parse(query);
      const result = input.kind === 'conflicts' ? { conflicts: scope.context.conflicts.slice(input.offset, input.offset + input.limit), total: scope.context.conflicts.length,
        nextOffset: input.offset + input.limit < scope.context.conflicts.length ? input.offset + input.limit : null }
        : await inspect<ContextResult>(res, signal => input.kind === 'manifest'
          ? artifactManifest(runtime.store, scope.runId, scope.context.inputs[input.version].artifactId!, input.offset, input.limit, signal)
          : artifactFile(runtime.store, scope.runId, scope.context.inputs[input.version].artifactId!, input.path, input.offset, input.length, signal));
      runtime.store.contextScope(attemptId, auth); // Cancellation/epoch replacement can revoke an in-flight read.
      json(res, 200, result); return;
    }
    const worker = /^\/v1\/attempts\/([a-zA-Z0-9_-]+)\/(checkpoint|submit)$/.exec(url.pathname);
    if (worker && req.method === 'POST') {
      const run = runtime.store.bridge(worker[1]!, auth, worker[2] as 'checkpoint' | 'submit', bridgeSchema.parse(await body(req)));
      json(res, 200, { accepted: true, runId: run.id, revision: run.revision });
      return;
    }
    if (!equal(auth, token)) throw new Fault('UNAUTHORIZED', 'Invalid host credential', 401);
    if (req.method === 'GET' && url.pathname === '/v1/hello') {
      json(res, 200, { protocolVersion, features: ['start', 'status', 'cancel', 'pause', 'resume', 'checkpoint', 'submit', 'events', 'review-gate', 'structured-requirements', 'write-scope', 'bounded-repair', 'candidate-recovery', 'artifacts', 'changes', 'integration-preview', 'integration-status',
        ...(runtime.integrationEnabled ? ['integrate', 'integration-cancel', 'integration-keep-current', 'integration-resolve', 'resolution-context'] : [])],
        verificationEnabled: runtime.verificationEnabled,
        integrationEnabled: runtime.integrationEnabled,
        maxIterations: runtime.maxIterations,
        limitations: ['no-auto-integration', 'no-stdio-reattach', 'cooperative-isolation'] });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/runs') {
      json(res, 202, runtime.start(startSchema.parse(await body(req)))); return;
    }
    const integration = /^\/v1\/runs\/([a-zA-Z0-9_-]+)\/integrations(?:\/([a-zA-Z0-9_-]+)(\/commands)?)?$/.exec(url.pathname);
    if (integration) {
      const runId = integration[1]!, id = integration[2];
      if (req.method === 'POST' && !id) {
        const input = integrateSchema.parse(await body(req));
        json(res, 202, await inspect(res, signal => runtime.integrate(runId, input, signal))); return;
      }
      if (req.method === 'POST' && id && integration[3]) {
        const input = await body(req);
        if (typeof input === 'object' && input !== null && 'type' in input && input.type === 'resolve') {
          const command = resolveIntegrationSchema.parse(input);
          json(res, 202, await inspect(res, signal => runtime.resolveIntegration(runId, id, command, signal))); return;
        }
        if (typeof input === 'object' && input !== null && 'type' in input && input.type === 'abandon') {
          const command = abandonIntegrationSchema.parse(input);
          json(res, 202, await inspect(res, signal => runtime.abandonIntegration(runId, id, command, signal))); return;
        }
        json(res, 202, runtime.cancelIntegration(runId, id, cancelSchema.parse(input))); return;
      }
      if (req.method === 'GET' && !integration[3]) {
        if (id) { json(res, 200, runtime.integrationStatus(runId, id)); return; }
        const query = Object.fromEntries(url.searchParams);
        if (Object.keys(query).length !== [...url.searchParams].length) throw new Fault('SCHEMA_INVALID', 'Duplicate query parameters', 400);
        const input = pageSchema.parse(query);
        json(res, 200, runtime.integrations(runId, input.offset, input.limit)); return;
      }
      throw new Fault('NOT_FOUND', 'Unknown integration route', 404);
    }
    const preview = /^\/v1\/runs\/([a-zA-Z0-9_-]+)\/integration-preview$/.exec(url.pathname);
    if (preview && req.method === 'GET') {
      const query = Object.fromEntries(url.searchParams);
      if (Object.keys(query).length !== [...url.searchParams].length) throw new Fault('SCHEMA_INVALID', 'Duplicate query parameters', 400);
      const input = integrationPageSchema.parse(query);
      json(res, 200, await inspect(res, signal => runtime.previewIntegration(preview[1]!, input.artifactId, input.offset, input.limit, input.planId, signal))); return;
    }
    const artifact = /^\/v1\/runs\/([a-zA-Z0-9_-]+)\/(artifacts|changes)(?:\/([a-zA-Z0-9_-]+)(\/file)?)?$/.exec(url.pathname);
    if (artifact && req.method === 'GET') {
      const runId = artifact[1]!, artifactId = artifact[3];
      const query = Object.fromEntries(url.searchParams);
      if (Object.keys(query).length !== [...url.searchParams].length) throw new Fault('SCHEMA_INVALID', 'Duplicate query parameters', 400);
      if (artifact[2] === 'changes' && !artifactId) {
        const input = changePageSchema.parse(query);
        json(res, 200, await inspect(res, signal => artifactChanges(runtime.store, runId, input.artifactId, input.offset, input.limit, signal))); return;
      }
      if (artifact[2] !== 'artifacts') throw new Fault('NOT_FOUND', 'Unknown artifact route', 404);
      if (artifactId && artifact[4]) {
        const input = filePageSchema.parse(query);
        json(res, 200, await inspect(res, signal => artifactFile(runtime.store, runId, artifactId, input.path, input.offset, input.length, signal))); return;
      }
      const input = pageSchema.parse(query);
      if (!artifactId) { json(res, 200, runtime.store.artifacts(runId, input.offset, input.limit)); return; }
      json(res, 200, await inspect(res, signal => artifactManifest(runtime.store, runId, artifactId, input.offset, input.limit, signal))); return;
    }
    const match = /^\/v1\/runs\/([a-zA-Z0-9_-]+)(?:\/(commands|events))?$/.exec(url.pathname);
    if (!match) throw new Fault('NOT_FOUND', 'Unknown route', 404);
    const id = match[1]!;
    if (req.method === 'POST' && match[2] === 'commands') {
      const input = await body(req);
      if (typeof input === 'object' && input !== null && 'type' in input && !['cancel', 'pause', 'resume'].includes(String(input.type))) {
        throw new Fault('CAPABILITY_MISSING', 'Unknown control command', 422);
      }
      json(res, 202, runtime.control(id, controlSchema.parse(input))); return;
    }
    if (req.method !== 'GET') throw new Fault('NOT_FOUND', 'Unknown route', 404);
    if (!match[2]) { json(res, 200, runtime.store.get(id)); return; }
    if (match[2] === 'events') {
      let cursor = Number(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Fault('SCHEMA_INVALID', 'Invalid event cursor', 400);
      runtime.store.get(id);
      if (streams.size >= 32) throw new Fault('STREAM_LIMIT', 'Too many event streams', 429);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      streams.add(res);
      const flush = (): void => {
        try {
          if (res.writableLength > 256 * 1024) { res.end(); return; }
          for (const event of runtime.store.events(id, cursor)) {
            res.write(`id: ${event.cursor}\nevent: teamwork\ndata: ${JSON.stringify(event)}\n\n`);
            cursor = event.cursor;
          }
          res.write(': heartbeat\n\n');
        } catch { res.end(); }
      };
      flush();
      const timer = setInterval(flush, 1_000);
      timer.unref();
      res.on('close', () => { clearInterval(timer); streams.delete(res); });
      return;
    }
    throw new Fault('NOT_FOUND', 'Unknown route', 404);
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  const url = `http://127.0.0.1:${address.port}`;
  try { runtime.connect(url); }
  catch (error) { await new Promise<void>(resolve => server.close(() => resolve())); throw error; }
  return { url, async close() {
    await runtime.close();
    for (const stream of streams) stream.end();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
