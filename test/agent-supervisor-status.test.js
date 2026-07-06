import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../src/server.js';
import { readAuditEvents } from '../src/audit-log.js';
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

describe('Agent supervisor-status CLI', () => {
  it('prints sanitized not-configured supervisor JSON without mutating dataDir in no-token mode', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-supervisor-open-'));
    const server = createServer({ dataDir });
    const port = await listen(server);

    try {
      assert.deepStrictEqual(await readdir(dataDir), []);
      const { stdout, stderr } = await runAgent([
        'supervisor-status',
        '--server',
        `http://127.0.0.1:${port}`,
      ]);
      const body = JSON.parse(stdout);

      assert.strictEqual(stderr, '');
      assert.strictEqual(body.status, 'partial');
      assert.strictEqual(body.service, 'linke');
      assert.strictEqual(body.version, LINKE_RELEASE_VERSION);
      assert.deepStrictEqual(body.supervisor, {
        installed: false,
        managed: false,
        launchdConfigured: false,
        watchdogConfigured: false,
        monitoringConfigured: false,
        recoveryConfigured: false,
        state: 'not_configured',
      });
      assert.deepStrictEqual(body.safety, {
        launchctlCalled: false,
        processListRead: false,
        supervisorInstalled: false,
        metadataWritten: false,
        nasConnected: false,
        backupTriggered: false,
        restoreTriggered: false,
        remoteCommandExecuted: false,
      });
      assert.ok(!stdout.includes(dataDir), 'stdout must not leak dataDir');
      assert.deepStrictEqual(await readdir(dataDir), []);
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('passes --token as bearer auth and does not print token material', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-supervisor-token-'));
    const server = createServer({
      dataDir,
      readToken: 'supervisor-read-token',
      writeToken: 'supervisor-write-token',
    });
    const port = await listen(server);

    try {
      const { stdout, stderr } = await runAgent([
        'supervisor-status',
        '--server',
        `http://127.0.0.1:${port}`,
        '--token',
        'supervisor-read-token',
      ]);
      const body = JSON.parse(stdout);

      assert.strictEqual(stderr, '');
      assert.strictEqual(body.supervisor.state, 'not_configured');
      assert.doesNotMatch(stdout, /supervisor-read-token|supervisor-write-token|Bearer/);
      assert.deepStrictEqual(await readAuditEvents(dataDir), []);
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('exits 1 when auth is required and no token is provided', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-supervisor-missing-'));
    const server = createServer({ dataDir, readToken: 'supervisor-read-token' });
    const port = await listen(server);

    try {
      const err = await rejectAgent([
        'supervisor-status',
        '--server',
        `http://127.0.0.1:${port}`,
      ], 1);

      assert.match(err.stderr, /Unauthorized/);
      assert.doesNotMatch(err.stdout, /supervisor|supervisor-read-token/);
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('exits 1 when an invalid token is provided without leaking token material', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-supervisor-invalid-'));
    const server = createServer({ dataDir, readToken: 'supervisor-read-token' });
    const port = await listen(server);

    try {
      const err = await rejectAgent([
        'supervisor-status',
        '--server',
        `http://127.0.0.1:${port}`,
        '--token',
        'wrong-supervisor-token',
      ], 1);

      assert.match(err.stderr, /Unauthorized/);
      assert.doesNotMatch(err.stdout, /supervisor|supervisor-read-token|wrong-supervisor-token/);
      assert.doesNotMatch(err.stderr, /supervisor-read-token|wrong-supervisor-token/);
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('exits 1 through existing error handling when the server is unreachable', async () => {
    const err = await rejectAgent([
      'supervisor-status',
      '--server',
      'http://127.0.0.1:1',
    ], 1);

    assert.match(err.stderr, /Error:/);
  });

  it('exits 1 without printing unexpected supervisor-status response payloads', async () => {
    const server = createHttpServer((req, res) => {
      assert.strictEqual(req.method, 'GET');
      assert.strictEqual(req.url, '/api/supervisor-status');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        supervisor: {
          installed: true,
          state: 'running',
        },
        safety: {
          launchctlCalled: true,
        },
      }));
    });
    const port = await listen(server);

    try {
      const err = await rejectAgent([
        'supervisor-status',
        '--server',
        `http://127.0.0.1:${port}`,
      ], 1);

      assert.match(err.stderr, /supervisor-status response has invalid schema/);
      assert.strictEqual(err.stdout, '');
      assert.doesNotMatch(err.stderr, /running|launchctlCalled|installed/);
    } finally {
      await close(server);
    }
  });
});
