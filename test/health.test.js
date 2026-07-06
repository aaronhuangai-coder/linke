import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, buildAuthStatusResponse, buildHealthResponse } from '../src/server.js';
import { LINKE_RELEASE_VERSION } from '../src/version.js';
import { buildReleaseReadinessReport } from '../src/release-readiness.js';
import { readAuditEvents } from '../src/audit-log.js';

describe('Release health response', () => {
  it('buildHealthResponse returns the current release liveness payload without path disclosure', () => {
    assert.deepStrictEqual(buildHealthResponse({
      dataDirReadable: true,
      now: new Date('2026-07-05T00:00:00.000Z'),
    }), {
      status: 'ok',
      service: 'linke',
      version: LINKE_RELEASE_VERSION,
      checks: {
        http: 'ok',
        dataDirReadable: 'ok',
      },
      timestamp: '2026-07-05T00:00:00.000Z',
    });
  });

  it('buildHealthResponse reports degraded when dataDir is unreadable', () => {
    assert.deepStrictEqual(buildHealthResponse({
      dataDirReadable: false,
      now: new Date('2026-07-05T00:00:00.000Z'),
    }), {
      status: 'degraded',
      service: 'linke',
      version: LINKE_RELEASE_VERSION,
      checks: {
        http: 'ok',
        dataDirReadable: 'unavailable',
      },
      timestamp: '2026-07-05T00:00:00.000Z',
    });
  });
});

describe('Auth status response', () => {
  it('buildAuthStatusResponse returns sanitized scope status without token values', () => {
    const body = buildAuthStatusResponse({
      authToken: 'full-secret-token',
      readToken: 'read-secret-token',
      writeToken: 'write-secret-token',
    });

    assert.deepStrictEqual(body, {
      status: 'ok',
      service: 'linke',
      version: LINKE_RELEASE_VERSION,
      auth: {
        enabled: true,
        configuredScopes: {
          full: true,
          read: true,
          write: true,
        },
        writeRoutes: [
          'POST /api/heartbeat',
          'POST /api/backups',
          'POST /api/restore',
        ],
      },
      safety: {
        tokenValuesReturned: false,
        successAuditEvent: false,
      },
    });
    assert.doesNotMatch(JSON.stringify(body), /full-secret-token|read-secret-token|write-secret-token/);
  });
});
describe('GET /api/health', () => {
  let server, dataDir, port;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'linke-health-'));
    server = createServer({ dataDir });
    await new Promise((resolve) => server.listen(0, resolve));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });

  it('returns 200 JSON liveness data and does not mutate dataDir', async () => {
    assert.deepStrictEqual(await readdir(dataDir), []);
    const res = await fetch(`http://localhost:${port}/api/health`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(body.service, 'linke');
    assert.strictEqual(body.version, LINKE_RELEASE_VERSION);
    assert.strictEqual(body.checks.http, 'ok');
    assert.strictEqual(body.checks.dataDirReadable, 'ok');
    assert.ok(Number.isFinite(Date.parse(body.timestamp)));
    assert.ok(!JSON.stringify(body).includes(dataDir));
    assert.deepStrictEqual(await readdir(dataDir), []);
  });

  it('does not implement mutating methods for /api/health', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`http://localhost:${port}/api/health`, { method });
      assert.strictEqual(res.status, 404, `${method} /api/health must return 404`);
      assert.deepStrictEqual(await res.json(), { error: 'Not Found' });
    }
  });
});

describe('GET /api/health with missing dataDir', () => {
  let server, rootDir, dataDir, port;

  before(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'linke-health-missing-'));
    dataDir = join(rootDir, 'missing-data-dir');
    server = createServer({ dataDir });
    await new Promise((resolve) => server.listen(0, resolve));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(rootDir, { recursive: true, force: true });
  });

  it('reports degraded without creating the missing directory', async () => {
    const res = await fetch(`http://localhost:${port}/api/health`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, 'degraded');
    assert.strictEqual(body.checks.dataDirReadable, 'unavailable');
    await assert.rejects(() => readdir(dataDir), /ENOENT/);
    assert.ok(!JSON.stringify(body).includes(dataDir));
  });
});

describe('GET /api/auth-status', () => {
  it('returns disabled auth status in no-token localhost mode and does not mutate dataDir', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-auth-status-open-'));
    const server = createServer({ dataDir });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      assert.deepStrictEqual(await readdir(dataDir), []);
      const res = await fetch(`http://localhost:${port}/api/auth-status`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.status, 'ok');
      assert.strictEqual(body.service, 'linke');
      assert.strictEqual(body.version, LINKE_RELEASE_VERSION);
      assert.deepStrictEqual(body.auth.configuredScopes, { full: false, read: false, write: false });
      assert.strictEqual(body.auth.enabled, false);
      assert.deepStrictEqual(body.auth.writeRoutes, [
        'POST /api/heartbeat',
        'POST /api/backups',
        'POST /api/restore',
      ]);
      assert.deepStrictEqual(body.safety, { tokenValuesReturned: false, successAuditEvent: false });
      assert.deepStrictEqual(await readdir(dataDir), []);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('allows readToken to read auth status without returning token material or creating success audit events', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-auth-status-read-'));
    const server = createServer({ dataDir, readToken: 'read-status-token', writeToken: 'write-status-token' });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/api/auth-status`, {
        headers: { Authorization: 'Bearer read-status-token' },
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.auth.enabled, true);
      assert.deepStrictEqual(body.auth.configuredScopes, { full: false, read: true, write: true });
      assert.doesNotMatch(JSON.stringify(body), /read-status-token|write-status-token|Bearer/);
      assert.deepStrictEqual(await readAuditEvents(dataDir), []);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects unknown tokens before returning auth status fields', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-auth-status-denied-'));
    const server = createServer({ dataDir, readToken: 'read-status-token' });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/api/auth-status`, {
        headers: { Authorization: 'Bearer unknown-status-token' },
      });
      assert.strictEqual(res.status, 401);
      const body = await res.json();
      assert.deepStrictEqual(body, { error: 'Unauthorized' });
      assert.doesNotMatch(JSON.stringify(body), /configuredScopes|writeRoutes|read-status-token|unknown-status-token/);
      const events = await readAuditEvents(dataDir, { limit: 1 });
      assert.strictEqual(events[0].type, 'auth.denied');
      assert.strictEqual(events[0].path, '/api/auth-status');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('does not implement mutating methods for /api/auth-status', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-auth-status-methods-'));
    const server = createServer({ dataDir });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await fetch(`http://localhost:${port}/api/auth-status`, { method });
        assert.strictEqual(res.status, 404, `${method} /api/auth-status must return 404`);
        assert.deepStrictEqual(await res.json(), { error: 'Not Found' });
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('GET /api/release-readiness', () => {
  let server, dataDir, port;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'linke-readiness-'));
    server = createServer({ dataDir });
    await new Promise((resolve) => server.listen(0, resolve));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });

  it('returns 200 JSON readiness data matching helper report', async () => {
    const res = await fetch(`http://localhost:${port}/api/release-readiness`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();

    const expectedReport = buildReleaseReadinessReport(
      buildHealthResponse({ dataDirReadable: true, now: new Date(body.checkedAt) }),
      { expectedVersion: LINKE_RELEASE_VERSION, now: new Date(body.checkedAt) }
    );

    assert.deepStrictEqual(body, expectedReport);
  });

  it('does not implement mutating methods for /api/release-readiness', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`http://localhost:${port}/api/release-readiness`, { method });
      assert.strictEqual(res.status, 404, `${method} /api/release-readiness must return 404`);
      assert.deepStrictEqual(await res.json(), { error: 'Not Found' });
    }
  });
});

describe('GET /api/gold-readiness', () => {
  let server, dataDir, port;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'linke-gold-readiness-'));
    server = createServer({ dataDir });
    await new Promise((resolve) => server.listen(0, resolve));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });

  it('returns 200 JSON gold readiness data and does not mutate dataDir', async () => {
    assert.deepStrictEqual(await readdir(dataDir), []);
    const res = await fetch(`http://localhost:${port}/api/gold-readiness`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();
    assert.strictEqual(body.version, LINKE_RELEASE_VERSION);
    assert.strictEqual(body.status, 'blocked');
    assert.deepStrictEqual(body.summary, { ready: 4, partial: 4, blocked: 1, total: 9 });
    assert.ok(Number.isFinite(Date.parse(body.generatedAt)));
    assert.strictEqual(Array.isArray(body.items), true);
    assert.strictEqual(body.items.length, 9);
    assert.ok(!JSON.stringify(body).includes(dataDir));
    assert.deepStrictEqual(await readdir(dataDir), []);
  });

  it('does not implement mutating methods for /api/gold-readiness', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`http://localhost:${port}/api/gold-readiness`, { method });
      assert.strictEqual(res.status, 404, `${method} /api/gold-readiness must return 404`);
      assert.deepStrictEqual(await res.json(), { error: 'Not Found' });
    }
  });
});
