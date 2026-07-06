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

function startMockGoldServer(payload) {
  const server = createHttpServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/gold-readiness') {
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

describe('Agent gold-readiness CLI', () => {
  it('prints blocked Gold readiness JSON without mutating dataDir in no-token mode', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-gold-open-'));
    const server = createServer({ dataDir });
    const port = await listen(server);

    try {
      assert.deepStrictEqual(await readdir(dataDir), []);
      const { stdout, stderr } = await runAgent([
        'gold-readiness',
        '--server',
        `http://127.0.0.1:${port}`,
      ]);
      const report = JSON.parse(stdout);

      assert.strictEqual(stderr, '');
      assert.strictEqual(report.version, LINKE_RELEASE_VERSION);
      assert.strictEqual(report.status, 'blocked');
      assert.deepStrictEqual(report.summary, { ready: 4, partial: 4, blocked: 1, total: 9 });
      assert.strictEqual(Array.isArray(report.items), true);
      assert.strictEqual(report.items.length, 9);
      assert.ok(!stdout.includes(dataDir), 'stdout must not leak dataDir');
      assert.deepStrictEqual(await readdir(dataDir), []);
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('allows a read token to fetch Gold readiness without returning token material', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-gold-token-'));
    const server = createServer({
      dataDir,
      readToken: 'gold-read-token',
      writeToken: 'gold-write-token',
    });
    const port = await listen(server);

    try {
      const { stdout, stderr } = await runAgent([
        'gold-readiness',
        '--server',
        `http://127.0.0.1:${port}`,
        '--token',
        'gold-read-token',
      ]);
      const report = JSON.parse(stdout);

      assert.strictEqual(stderr, '');
      assert.strictEqual(report.status, 'blocked');
      assert.strictEqual(report.version, LINKE_RELEASE_VERSION);
      assert.ok(!stdout.includes('gold-read-token'), 'stdout must not include token material');
      assert.ok(!stdout.includes('gold-write-token'), 'stdout must not include write token material');
      assert.deepStrictEqual(await readdir(dataDir), []);
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('exits 2 after printing the report when --fail-on-blocked sees blocked Gold readiness', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-gold-fail-'));
    const server = createServer({ dataDir });
    const port = await listen(server);

    try {
      const err = await rejectAgent([
        'gold-readiness',
        '--server',
        `http://127.0.0.1:${port}`,
        '--fail-on-blocked',
      ], 2);
      const report = JSON.parse(err.stdout);

      assert.strictEqual(err.stderr, '');
      assert.strictEqual(report.status, 'blocked');
      assert.strictEqual(report.summary.blocked, 1);
      assert.ok(report.items.some((item) => item.id === 'real-nas-remote-backup'));
      assert.ok(!err.stdout.includes(dataDir), 'stdout must not leak dataDir');
      assert.deepStrictEqual(await readdir(dataDir), []);
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects a value after --fail-on-blocked', async () => {
    const err = await rejectAgent([
      'gold-readiness',
      '--server',
      'http://127.0.0.1:1',
      '--fail-on-blocked',
      'yes',
    ], 1);

    assert.match(err.stderr, /--fail-on-blocked does not accept a value/);
  });

  it('exits 1 for invalid Gold readiness status without echoing payload values', async () => {
    const leakedPath = '/private/tmp/linke-gold-leaked-data-dir';
    const server = startMockGoldServer({
      status: 'unknown',
      version: LINKE_RELEASE_VERSION,
      dataDir: leakedPath,
    });
    const port = await listen(server);

    try {
      const err = await rejectAgent([
        'gold-readiness',
        '--server',
        `http://127.0.0.1:${port}`,
      ], 1);

      assert.strictEqual(err.stdout, '');
      assert.match(err.stderr, /gold-readiness response has invalid status/);
      assert.ok(!err.stderr.includes(leakedPath), 'stderr must not echo leaked path values');
    } finally {
      await close(server);
    }
  });

  it('exits 1 through existing error handling when the server is unreachable', async () => {
    const err = await rejectAgent([
      'gold-readiness',
      '--server',
      'http://127.0.0.1:1',
    ], 1);

    assert.match(err.stderr, /Error:/);
  });
});
