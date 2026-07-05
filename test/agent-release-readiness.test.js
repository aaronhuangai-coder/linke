import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createServer as createHttpServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../src/server.js';
import { LINKE_RELEASE_VERSION } from '../src/version.js';

const exec = promisify(execFile);
const agentPath = join(import.meta.dirname, '..', 'src', 'agent.js');

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function runAgent(args) {
  return exec('node', [agentPath, ...args]);
}

async function rejectAgent(args, expectedCode) {
  try {
    await runAgent(args);
  } catch (err) {
    assert.strictEqual(err.code, expectedCode);
    return err;
  }
  assert.fail(`Expected agent command to exit ${expectedCode}`);
}

function startMockHealthServer(payload) {
  const server = createHttpServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/health') {
      const body = JSON.stringify(payload);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    const body = JSON.stringify({ error: 'Not Found' });
    res.writeHead(404, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  });

  return server;
}

function failedCheckIds(report) {
  return report.checks.filter((check) => !check.ok).map((check) => check.id);
}

describe('Agent release-readiness CLI', () => {
  it('exits 0 with sanitized JSON when release readiness passes', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-readiness-'));
    const server = createServer({ dataDir });
    const port = await listen(server);

    try {
      assert.deepStrictEqual(await readdir(dataDir), []);
      const { stdout } = await runAgent([
        'release-readiness',
        '--server',
        `http://127.0.0.1:${port}`,
      ]);
      const report = JSON.parse(stdout);

      assert.strictEqual(report.ready, true);
      assert.strictEqual(report.expectedVersion, LINKE_RELEASE_VERSION);
      assert.strictEqual(report.actualVersion, LINKE_RELEASE_VERSION);
      assert.ok(!stdout.includes(dataDir));
      assert.deepStrictEqual(await readdir(dataDir), []);
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('exits 2 with ready false when health is degraded', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'linke-agent-readiness-missing-'));
    const dataDir = join(rootDir, 'missing-data-dir');
    const server = createServer({ dataDir });
    const port = await listen(server);

    try {
      const err = await rejectAgent([
        'release-readiness',
        '--server',
        `http://127.0.0.1:${port}`,
      ], 2);
      const report = JSON.parse(err.stdout);

      assert.strictEqual(report.ready, false);
      assert.deepStrictEqual(failedCheckIds(report), [
        'health.status',
        'health.checks.dataDirReadable',
      ]);
      assert.ok(!err.stdout.includes(dataDir));
      await assert.rejects(() => readdir(dataDir), /ENOENT/);
    } finally {
      await close(server);
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('exits 2 when --expected-version does not match server health version', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-readiness-version-'));
    const server = createServer({ dataDir });
    const port = await listen(server);

    try {
      const err = await rejectAgent([
        'release-readiness',
        '--server',
        `http://127.0.0.1:${port}`,
        '--expected-version',
        'V0.0',
      ], 2);
      const report = JSON.parse(err.stdout);

      assert.strictEqual(report.ready, false);
      assert.strictEqual(report.expectedVersion, 'V0.0');
      assert.strictEqual(report.actualVersion, LINKE_RELEASE_VERSION);
      assert.deepStrictEqual(failedCheckIds(report), ['release.version']);
      assert.ok(!err.stdout.includes(dataDir));
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('exits 2 for unexpected schema fields without echoing leaked values', async () => {
    const leakedPath = '/private/tmp/linke-leaked-data-dir';
    const server = startMockHealthServer({
      status: 'ok',
      service: 'linke',
      version: LINKE_RELEASE_VERSION,
      checks: {
        http: 'ok',
        dataDirReadable: 'ok',
      },
      timestamp: '2026-07-06T00:00:00.000Z',
      dataDir: leakedPath,
    });
    const port = await listen(server);

    try {
      const err = await rejectAgent([
        'release-readiness',
        '--server',
        `http://127.0.0.1:${port}`,
      ], 2);
      const report = JSON.parse(err.stdout);

      assert.strictEqual(report.ready, false);
      assert.deepStrictEqual(failedCheckIds(report), ['health.schema']);
      assert.match(report.checks.find((check) => check.id === 'health.schema').actual, /dataDir/);
      assert.ok(!err.stdout.includes(leakedPath), 'stdout must not echo leaked path values');
    } finally {
      await close(server);
    }
  });

  it('exits 1 through existing error handling when the server is unreachable', async () => {
    const err = await rejectAgent([
      'release-readiness',
      '--server',
      'http://127.0.0.1:1',
    ], 1);

    assert.match(err.stderr, /Error:/);
  });

  it('exits 1 when --expected-version is provided without a value', async () => {
    const err = await rejectAgent([
      'release-readiness',
      '--server',
      'http://127.0.0.1:1',
      '--expected-version',
    ], 1);

    assert.match(err.stderr, /--expected-version requires a value/);
  });
});
