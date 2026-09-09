import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client } from '../src/client.js';
import { Fault } from '../src/contracts.js';

test('lost command response reports sanitized transport cause and never retries an accepted write automatically', async () => {
  const requests: string[] = [], receipts = new Map<string, { id: string }>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8'); requests.push(body);
      const input = JSON.parse(body) as { commandId: string };
      if (!receipts.has(input.commandId)) receipts.set(input.commandId, { id: 'one-accepted-run' });
      if (requests.length === 1) { req.socket.destroy(); return; } // Server committed, response lost.
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(receipts.get(input.commandId)));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const token = 'secret-not-for-diagnostics'.repeat(2), client = new Client(`http://127.0.0.1:${address.port}`, token);
    const input = { commandId: 'one-command', objective: 'Test an uncertain transport outcome' };
    await assert.rejects(client.start(input), (error: unknown) => {
      assert.ok(error instanceof Fault); assert.equal(error.code, 'TRANSPORT_ERROR');
      assert.match(error.message, /UND_ERR_SOCKET|ECONNRESET/);
      assert.ok(!error.message.includes(token)); assert.ok(error.cause instanceof Error);
      return true;
    });
    assert.equal(requests.length, 1); assert.equal(receipts.size, 1);
    assert.equal((await client.start(input)).id, 'one-accepted-run'); // Explicit idempotent retry only.
    assert.equal(requests.length, 2); assert.equal(receipts.size, 1); assert.equal(requests[0], requests[1]);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
