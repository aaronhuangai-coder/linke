import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { API_WRITE_ROUTES, createServer, isApiWriteRoute } from '../src/server.js';

describe('Server API Isolation Regression', () => {
  let server, dataDir, port;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'linke-server-test-'));
    server = createServer({ dataDir });
    await new Promise((resolve) => server.listen(0, resolve));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });

  it('proves GET /api/supervisor-lifecycle-apply does not exist and returns 404', async () => {
    const res = await fetch(`http://localhost:${port}/api/supervisor-lifecycle-apply`);
    assert.strictEqual(res.status, 404);
    const body = await res.text();
    assert.doesNotMatch(body, /simulated|fake-test-only|\blaunchctl\b/i);
  });

  it('proves POST /api/supervisor-lifecycle-apply does not exist and returns 404', async () => {
    const res = await fetch(`http://localhost:${port}/api/supervisor-lifecycle-apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'install' }),
    });
    assert.strictEqual(res.status, 404);
    const body = await res.text();
    assert.doesNotMatch(body, /simulated|fake-test-only|\blaunchctl\b/i);
  });

  it('proves GET /api/supervisor-lifecycle-approval-persistence-preview does not exist and returns 404', async () => {
    const res = await fetch(`http://localhost:${port}/api/supervisor-lifecycle-approval-persistence-preview`);
    assert.strictEqual(res.status, 404);
    const body = await res.text();
    assert.doesNotMatch(body, /approvalPersisted:true|wouldPersist:true|\blaunchctl\b/i);
  });

  it('keeps approval persistence preview out of API_WRITE_ROUTES', () => {
    assert.strictEqual(isApiWriteRoute('POST', '/api/supervisor-lifecycle-approval-persistence-preview'), false);
    assert.ok(!API_WRITE_ROUTES.some((route) => route.path === '/api/supervisor-lifecycle-approval-persistence-preview'));
  });
});
