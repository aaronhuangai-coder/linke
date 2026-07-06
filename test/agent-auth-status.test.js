import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  API_WRITE_ROUTES,
  createServer,
  formatApiRoute,
} from '../src/server.js';
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

describe('Agent auth-status CLI', () => {
  it('prints sanitized auth status JSON without mutating dataDir in no-token mode', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-auth-open-'));
    const server = createServer({ dataDir });
    const port = await listen(server);

    try {
      assert.deepStrictEqual(await readdir(dataDir), []);
      const { stdout, stderr } = await runAgent([
        'auth-status',
        '--server',
        `http://127.0.0.1:${port}`,
      ]);
      const body = JSON.parse(stdout);

      assert.strictEqual(stderr, '');
      assert.strictEqual(body.status, 'ok');
      assert.strictEqual(body.service, 'linke');
      assert.strictEqual(body.version, LINKE_RELEASE_VERSION);
      assert.strictEqual(body.auth.enabled, false);
      assert.deepStrictEqual(body.auth.configuredScopes, { full: false, read: false, write: false });
      assert.deepStrictEqual(body.auth.writeRoutes, API_WRITE_ROUTES.map(formatApiRoute));
      assert.deepStrictEqual(body.safety, { tokenValuesReturned: false, successAuditEvent: false });
      assert.ok(!stdout.includes(dataDir), 'stdout must not leak dataDir');
      assert.deepStrictEqual(await readdir(dataDir), []);
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('passes --token as bearer auth and does not print token material', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-auth-token-'));
    const server = createServer({
      dataDir,
      readToken: 'auth-read-token',
      writeToken: 'auth-write-token',
    });
    const port = await listen(server);

    try {
      const { stdout, stderr } = await runAgent([
        'auth-status',
        '--server',
        `http://127.0.0.1:${port}`,
        '--token',
        'auth-read-token',
      ]);
      const body = JSON.parse(stdout);

      assert.strictEqual(stderr, '');
      assert.strictEqual(body.auth.enabled, true);
      assert.deepStrictEqual(body.auth.configuredScopes, { full: false, read: true, write: true });
      assert.deepStrictEqual(body.auth.writeRoutes, API_WRITE_ROUTES.map(formatApiRoute));
      assert.doesNotMatch(stdout, /auth-read-token|auth-write-token|Bearer/);
      assert.deepStrictEqual(await readAuditEvents(dataDir), []);
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('exits 1 when auth is required and no token is provided', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-auth-missing-'));
    const server = createServer({ dataDir, readToken: 'auth-read-token' });
    const port = await listen(server);

    try {
      const err = await rejectAgent([
        'auth-status',
        '--server',
        `http://127.0.0.1:${port}`,
      ], 1);

      assert.match(err.stderr, /Unauthorized/);
      assert.doesNotMatch(err.stdout, /configuredScopes|writeRoutes|auth-read-token/);
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('exits 1 when an invalid token is provided without leaking token material', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-auth-invalid-'));
    const server = createServer({ dataDir, readToken: 'auth-read-token' });
    const port = await listen(server);

    try {
      const err = await rejectAgent([
        'auth-status',
        '--server',
        `http://127.0.0.1:${port}`,
        '--token',
        'wrong-auth-token',
      ], 1);

      assert.match(err.stderr, /Unauthorized/);
      assert.doesNotMatch(err.stdout, /configuredScopes|writeRoutes|auth-read-token|wrong-auth-token/);
      assert.doesNotMatch(err.stderr, /auth-read-token|wrong-auth-token/);
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('exits 1 through existing error handling when the server is unreachable', async () => {
    const err = await rejectAgent([
      'auth-status',
      '--server',
      'http://127.0.0.1:1',
    ], 1);

    assert.match(err.stderr, /Error:/);
  });
});
