import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createServer,
  buildAuthStatusResponse,
  buildHardeningStatusResponse,
  buildHealthResponse,
  API_WRITE_ROUTES,
  formatApiRoute,
  isApiWriteRoute,
  MAX_JSON_BODY_BYTES,
} from '../src/server.js';
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
        writeRoutes: API_WRITE_ROUTES.map(formatApiRoute),
      },
      safety: {
        tokenValuesReturned: false,
        successAuditEvent: false,
      },
    });
    assert.doesNotMatch(JSON.stringify(body), /full-secret-token|read-secret-token|write-secret-token/);
  });
});

describe('Shared write-route registry pure tests', () => {
  it('defines API_WRITE_ROUTES correctly', () => {
    assert.strictEqual(Array.isArray(API_WRITE_ROUTES), true);
    assert.strictEqual(API_WRITE_ROUTES.length, 3);

    const expected = [
      { method: 'POST', path: '/api/heartbeat' },
      { method: 'POST', path: '/api/backups' },
      { method: 'POST', path: '/api/restore' },
    ];
    assert.deepStrictEqual(API_WRITE_ROUTES, expected);
  });

  it('formatApiRoute formats route objects', () => {
    assert.strictEqual(formatApiRoute({ method: 'POST', path: '/api/heartbeat' }), 'POST /api/heartbeat');
    assert.strictEqual(formatApiRoute({ method: 'POST', path: '/api/backups' }), 'POST /api/backups');
    assert.strictEqual(formatApiRoute({ method: 'POST', path: '/api/restore' }), 'POST /api/restore');
  });

  it('isApiWriteRoute returns true for the write routes and false for others', () => {
    assert.strictEqual(isApiWriteRoute('POST', '/api/heartbeat'), true);
    assert.strictEqual(isApiWriteRoute('POST', '/api/backups'), true);
    assert.strictEqual(isApiWriteRoute('POST', '/api/restore'), true);

    assert.strictEqual(isApiWriteRoute('GET', '/api/heartbeat'), false);
    assert.strictEqual(isApiWriteRoute('POST', '/api/nas-dry-run'), false);
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
      assert.deepStrictEqual(body.auth.writeRoutes, API_WRITE_ROUTES.map(formatApiRoute));
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

describe('Hardening status response', () => {
  it('buildHardeningStatusResponse returns sanitized disabled status by default', () => {
    const body = buildHardeningStatusResponse();

    assert.deepStrictEqual(body, {
      status: 'partial',
      service: 'linke',
      version: LINKE_RELEASE_VERSION,
      hardening: {
        authConfigured: false,
        configuredAuthScopes: {
          full: false,
          read: false,
          write: false,
        },
        scopedTokensConfigured: false,
        rateLimitConfigured: false,
        auditRetentionConfigured: false,
        restoreRootConfigured: false,
        requestBodyLimitBytes: MAX_JSON_BODY_BYTES,
        writeRoutes: API_WRITE_ROUTES.map(formatApiRoute),
      },
      safety: {
        tokenValuesReturned: false,
        restoreRootValueReturned: false,
        auditPathReturned: false,
        environmentValuesReturned: false,
        successAuditEvent: false,
      },
    });
  });

  it('buildHardeningStatusResponse reports configured controls without values', () => {
    const restoreRoot = '/private/tmp/linke-secret-restore-root';
    const body = buildHardeningStatusResponse({
      authToken: 'full-secret-token',
      readToken: 'read-secret-token',
      writeToken: 'write-secret-token',
      restoreRoot,
      rateLimit: { maxRequests: 3, windowMs: 60000 },
      auditRetention: { maxEvents: 10 },
    });
    const serialized = JSON.stringify(body);

    assert.strictEqual(body.status, 'partial');
    assert.deepStrictEqual(body.hardening.configuredAuthScopes, {
      full: true,
      read: true,
      write: true,
    });
    assert.strictEqual(body.hardening.authConfigured, true);
    assert.strictEqual(body.hardening.scopedTokensConfigured, true);
    assert.strictEqual(body.hardening.rateLimitConfigured, true);
    assert.strictEqual(body.hardening.auditRetentionConfigured, true);
    assert.strictEqual(body.hardening.restoreRootConfigured, true);
    assert.doesNotMatch(serialized, /full-secret-token|read-secret-token|write-secret-token/);
    assert.ok(!serialized.includes(restoreRoot));
  });

  it('buildHardeningStatusResponse treats auditRetention maxEvents 0 as disabled', () => {
    const body = buildHardeningStatusResponse({
      auditRetention: { maxEvents: 0 },
    });

    assert.strictEqual(body.hardening.auditRetentionConfigured, false);
  });
});

describe('GET /api/hardening-status', () => {
  it('returns sanitized hardening status in no-token localhost mode and does not mutate dataDir', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-hardening-status-open-'));
    const server = createServer({ dataDir });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      assert.deepStrictEqual(await readdir(dataDir), []);
      const res = await fetch(`http://localhost:${port}/api/hardening-status`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();

      assert.strictEqual(body.status, 'partial');
      assert.strictEqual(body.service, 'linke');
      assert.strictEqual(body.version, LINKE_RELEASE_VERSION);
      assert.strictEqual(body.hardening.authConfigured, false);
      assert.strictEqual(body.hardening.rateLimitConfigured, false);
      assert.strictEqual(body.hardening.auditRetentionConfigured, false);
      assert.strictEqual(body.hardening.restoreRootConfigured, false);
      assert.strictEqual(body.hardening.requestBodyLimitBytes, MAX_JSON_BODY_BYTES);
      assert.deepStrictEqual(body.hardening.writeRoutes, API_WRITE_ROUTES.map(formatApiRoute));
      assert.deepStrictEqual(body.safety, {
        tokenValuesReturned: false,
        restoreRootValueReturned: false,
        auditPathReturned: false,
        environmentValuesReturned: false,
        successAuditEvent: false,
      });
      assert.ok(!JSON.stringify(body).includes(dataDir));
      assert.deepStrictEqual(await readdir(dataDir), []);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('allows readToken to read hardening status without returning token or restoreRoot material', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-hardening-status-read-'));
    const restoreRoot = await mkdtemp(join(tmpdir(), 'linke-hardening-restore-root-'));
    const server = createServer({
      dataDir,
      readToken: 'read-hardening-token',
      writeToken: 'write-hardening-token',
      restoreRoot,
      rateLimit: { maxRequests: 5, windowMs: 60000 },
      auditRetention: { maxEvents: 5 },
    });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/api/hardening-status`, {
        headers: { Authorization: 'Bearer read-hardening-token' },
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      const serialized = JSON.stringify(body);

      assert.strictEqual(body.hardening.authConfigured, true);
      assert.deepStrictEqual(body.hardening.configuredAuthScopes, {
        full: false,
        read: true,
        write: true,
      });
      assert.strictEqual(body.hardening.scopedTokensConfigured, true);
      assert.strictEqual(body.hardening.rateLimitConfigured, true);
      assert.strictEqual(body.hardening.auditRetentionConfigured, true);
      assert.strictEqual(body.hardening.restoreRootConfigured, true);
      assert.doesNotMatch(serialized, /read-hardening-token|write-hardening-token|Bearer/);
      assert.ok(!serialized.includes(restoreRoot));
      assert.deepStrictEqual(await readAuditEvents(dataDir), []);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
      await rm(restoreRoot, { recursive: true, force: true });
    }
  });

  it('rejects unknown tokens before returning hardening fields', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-hardening-status-denied-'));
    const server = createServer({ dataDir, readToken: 'read-hardening-token' });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/api/hardening-status`, {
        headers: { Authorization: 'Bearer unknown-hardening-token' },
      });
      assert.strictEqual(res.status, 401);
      const body = await res.json();
      assert.deepStrictEqual(body, { error: 'Unauthorized' });
      assert.doesNotMatch(JSON.stringify(body), /hardening|configuredAuthScopes|read-hardening-token|unknown-hardening-token/);
      const events = await readAuditEvents(dataDir, { limit: 1 });
      assert.strictEqual(events[0].type, 'auth.denied');
      assert.strictEqual(events[0].path, '/api/hardening-status');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('does not implement mutating methods for /api/hardening-status', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-hardening-status-methods-'));
    const server = createServer({ dataDir });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await fetch(`http://localhost:${port}/api/hardening-status`, { method });
        assert.strictEqual(res.status, 404, `${method} /api/hardening-status must return 404`);
        assert.deepStrictEqual(await res.json(), { error: 'Not Found' });
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('GET /api/supervisor-status', () => {
  it('returns sanitized not-configured supervisor status and does not mutate dataDir', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-supervisor-status-open-'));
    const server = createServer({ dataDir });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      assert.deepStrictEqual(await readdir(dataDir), []);
      const res = await fetch(`http://localhost:${port}/api/supervisor-status`);
      assert.strictEqual(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /application\/json/);
      const body = await res.json();

      assert.deepStrictEqual(body, {
        status: 'partial',
        service: 'linke',
        version: LINKE_RELEASE_VERSION,
        supervisor: {
          installed: false,
          managed: false,
          launchdConfigured: false,
          watchdogConfigured: false,
          monitoringConfigured: false,
          recoveryConfigured: false,
          state: 'not_configured',
        },
        safety: {
          launchctlCalled: false,
          processListRead: false,
          supervisorInstalled: false,
          metadataWritten: false,
          nasConnected: false,
          backupTriggered: false,
          restoreTriggered: false,
          remoteCommandExecuted: false,
        },
      });
      assert.ok(!JSON.stringify(body).includes(dataDir), 'response must not leak dataDir');
      assert.deepStrictEqual(await readdir(dataDir), []);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('allows readToken to read supervisor status without returning token material', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-supervisor-status-read-'));
    const server = createServer({ dataDir, readToken: 'read-supervisor-token', writeToken: 'write-supervisor-token' });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/api/supervisor-status`, {
        headers: { Authorization: 'Bearer read-supervisor-token' },
      });
      assert.strictEqual(res.status, 200);
      const bodyText = await res.text();
      const body = JSON.parse(bodyText);

      assert.strictEqual(body.supervisor.state, 'not_configured');
      assert.doesNotMatch(bodyText, /read-supervisor-token|write-supervisor-token|Bearer/);
      assert.deepStrictEqual(await readAuditEvents(dataDir), []);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects unknown tokens before returning supervisor fields', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-supervisor-status-denied-'));
    const server = createServer({ dataDir, readToken: 'read-supervisor-token' });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/api/supervisor-status`, {
        headers: { Authorization: 'Bearer unknown-supervisor-token' },
      });
      assert.strictEqual(res.status, 401);
      const body = await res.json();
      assert.deepStrictEqual(body, { error: 'Unauthorized' });
      assert.doesNotMatch(JSON.stringify(body), /supervisor|read-supervisor-token|unknown-supervisor-token/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('does not implement mutating methods for /api/supervisor-status', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-supervisor-status-methods-'));
    const server = createServer({ dataDir });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await fetch(`http://localhost:${port}/api/supervisor-status`, { method });
        assert.strictEqual(res.status, 404, `${method} /api/supervisor-status must return 404`);
        assert.deepStrictEqual(await res.json(), { error: 'Not Found' });
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
