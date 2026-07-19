import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises';
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

  it('registers device administration write routes and keeps listener status read-only', () => {
    assert.strictEqual(API_WRITE_ROUTES.length, 6);
    assert.strictEqual(isApiWriteRoute('POST', '/api/device-enrollment-codes'), true);
    assert.strictEqual(isApiWriteRoute('POST', '/api/device-revoke'), true);
    assert.strictEqual(isApiWriteRoute('GET', '/api/agent-listener-status'), false);
    assert.strictEqual(isApiWriteRoute('POST', '/api/agent-listener-status'), false);
    assert.ok(!API_WRITE_ROUTES.some((route) => route.path === '/api/agent-listener-status'));
  });

  it('returns 404 for wrong methods on device administration paths without auth open-leak', async () => {
    const getEnroll = await fetch(`http://localhost:${port}/api/device-enrollment-codes`);
    assert.strictEqual(getEnroll.status, 404);

    const getRevoke = await fetch(`http://localhost:${port}/api/device-revoke`);
    assert.strictEqual(getRevoke.status, 404);

    const postStatus = await fetch(`http://localhost:${port}/api/agent-listener-status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(postStatus.status, 404);
  });
});

/**
 * V1.37 C6: server recordAudit best-effort honesty.
 * Real appendAuditEvent failure (occupied dual-write state) must not change HTTP
 * main-path semantics. Does not modify server catch strategy.
 */
describe('C6 server recordAudit best-effort (audit write failure swallowed)', () => {
  it('HTTP auth-denied path stays 401 when dual-write state is occupied; audit failure does not bubble', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-server-c6-be-'));
    let server;
    const originalConsoleError = console.error;
    const errorLines = [];
    try {
      // Occupy dual-write state so production appendAuditEvent fails closed.
      await mkdir(join(dataDir, 'audit'), { recursive: true });
      await writeFile(
        join(dataDir, 'audit', 'integrity-dual-write-state.json'),
        'occupied-invalid-state\n',
        { mode: 0o600 },
      );

      server = createServer({ dataDir, authToken: 'c6-server-best-effort-token' });
      await new Promise((resolve) => server.listen(0, resolve));
      const port = server.address().port;

      console.error = (...args) => {
        errorLines.push(args.map((a) => String(a)).join(' '));
      };

      // Auth-required API path: missing Bearer → recordAudit(auth.denied) then 401.
      const res = await fetch(`http://localhost:${port}/api/health`);
      assert.strictEqual(res.status, 401);
      const bodyText = await res.text();
      assert.match(bodyText, /Unauthorized/i);
      // Response must not leak dataDir / state path / raw body secrets.
      assert.ok(!bodyText.includes(dataDir));
      assert.ok(!bodyText.includes('integrity-dual-write-state'));
      assert.ok(!bodyText.includes('occupied-invalid-state'));
      assert.ok(!bodyText.includes('c6-server-best-effort-token'));

      // Best-effort: console.error may log registered code-only message;
      // never dataDir path, relative state path, raw state body, or auth token.
      for (const line of errorLines) {
        assert.ok(!line.includes(dataDir), `console.error leaked dataDir: ${line}`);
        assert.ok(
          !line.includes('audit/integrity-dual-write-state.json'),
          `console.error leaked relative path: ${line}`,
        );
        assert.ok(!line.includes('occupied-invalid-state'), `console.error leaked state body: ${line}`);
        assert.ok(!line.includes('c6-server-best-effort-token'), `console.error leaked token: ${line}`);
      }
      // At least one audit-failure log is expected when append really fails.
      assert.ok(
        errorLines.some((line) => /Audit log write failed/i.test(line)),
        `expected audit failure log, got: ${JSON.stringify(errorLines)}`,
      );
      // Message should be code-shaped (registered kebab error), not a raw stack dump.
      assert.ok(
        errorLines.some((line) => /audit-integrity-dual-write-state-invalid|audit-integrity-dual-write-io-error/.test(line)),
        `expected dual-write error code in log, got: ${JSON.stringify(errorLines)}`,
      );

      // Occupied state file still present (no silent repair that would mask the failure).
      await access(join(dataDir, 'audit', 'integrity-dual-write-state.json'));
    } finally {
      console.error = originalConsoleError;
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
