import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, buildHealthResponse } from '../src/server.js';
import { LINKE_RELEASE_VERSION } from '../src/version.js';
import { buildReleaseReadinessReport } from '../src/release-readiness.js';

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
