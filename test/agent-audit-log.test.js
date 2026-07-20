import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../src/server.js';

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

async function postHeartbeat(base, token, deviceId) {
  return fetch(`${base}/api/heartbeat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ deviceId }),
  });
}

describe('Agent audit-log CLI', () => {
  it('prints empty sanitized audit JSON without mutating dataDir in no-token mode', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-audit-open-'));
    const server = createServer({ dataDir });
    const port = await listen(server);

    try {
      assert.deepStrictEqual(await readdir(dataDir), []);
      const { stdout } = await runAgent([
        'audit-log',
        '--server',
        `http://127.0.0.1:${port}`,
      ]);
      const body = JSON.parse(stdout);

      assert.deepStrictEqual(body, { events: [] });
      assert.ok(!stdout.includes(dataDir));
      assert.deepStrictEqual(await readdir(dataDir), []);
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('supports --limit and prints only newest sanitized event', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-audit-limit-'));
    const server = createServer({ dataDir });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;

    try {
      assert.strictEqual((await postHeartbeat(base, '', 'audit-device-old')).status, 200);
      assert.strictEqual((await postHeartbeat(base, '', 'audit-device-new')).status, 200);

      const { stdout } = await runAgent([
        'audit-log',
        '--server',
        base,
        '--limit',
        '1',
      ]);
      const body = JSON.parse(stdout);

      assert.strictEqual(body.events.length, 1);
      assert.strictEqual(body.events[0].type, 'api.heartbeat.success');
      assert.strictEqual(body.events[0].deviceId, 'audit-device-new');
      assert.doesNotMatch(stdout, /Authorization|Bearer|sourcePath|targetPath|password|token/);
      assert.ok(!stdout.includes(dataDir));
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('passes --token as bearer auth and does not print token material', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-audit-auth-'));
    const server = createServer({
      dataDir,
      readToken: 'audit-read-token',
      writeToken: 'audit-write-token',
    });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}`;

    try {
      assert.strictEqual((await postHeartbeat(base, 'audit-write-token', 'audit-auth-device')).status, 200);
      const { stdout } = await runAgent([
        'audit-log',
        '--server',
        base,
        '--token',
        'audit-read-token',
        '--limit',
        '1',
      ]);
      const body = JSON.parse(stdout);

      assert.strictEqual(body.events.length, 1);
      assert.strictEqual(body.events[0].deviceId, 'audit-auth-device');
      assert.doesNotMatch(stdout, /audit-read-token|audit-write-token|Authorization|Bearer/);
      assert.ok(!stdout.includes(dataDir));
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('exits 1 when auth is required and no token is provided', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-audit-missing-auth-'));
    const server = createServer({ dataDir, readToken: 'audit-read-token' });
    const port = await listen(server);

    try {
      const err = await rejectAgent([
        'audit-log',
        '--server',
        `http://127.0.0.1:${port}`,
      ], 1);

      assert.match(err.stderr, /Unauthorized/);
      assert.doesNotMatch(err.stdout, /events|audit-read-token/);
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('exits 1 when an invalid token is provided without echoing it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-audit-invalid-auth-'));
    const server = createServer({ dataDir, readToken: 'audit-read-token' });
    const port = await listen(server);

    try {
      const err = await rejectAgent([
        'audit-log',
        '--server',
        `http://127.0.0.1:${port}`,
        '--token',
        'wrong-audit-token',
      ], 1);

      assert.match(err.stderr, /Unauthorized/);
      assert.doesNotMatch(err.stdout + err.stderr, /wrong-audit-token|audit-read-token/);
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('exits 1 when --limit is provided without a value', async () => {
    const err = await rejectAgent([
      'audit-log',
      '--server',
      'http://127.0.0.1:1',
      '--limit',
    ], 1);

    assert.match(err.stderr, /--limit requires a positive integer value/);
  });

  it('exits 1 through existing error handling when the server is unreachable', async () => {
    const err = await rejectAgent([
      'audit-log',
      '--server',
      'http://127.0.0.1:1',
    ], 1);

    assert.match(err.stderr, /Error:/);
  });
});
