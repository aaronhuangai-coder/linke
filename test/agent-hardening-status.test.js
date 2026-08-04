import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  API_WRITE_ROUTES,
  MAX_JSON_BODY_BYTES,
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

describe('Agent hardening-status CLI', () => {
  it('prints sanitized hardening JSON without mutating dataDir in no-token mode', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-hardening-open-'));
    const server = createServer({ dataDir });
    const port = await listen(server);

    try {
      assert.deepStrictEqual(await readdir(dataDir), []);
      const { stdout } = await runAgent([
        'hardening-status',
        '--server',
        `http://127.0.0.1:${port}`,
      ]);
      const body = JSON.parse(stdout);

      assert.strictEqual(body.status, 'partial');
      assert.strictEqual(body.service, 'linke');
      assert.strictEqual(body.version, LINKE_RELEASE_VERSION);
      assert.strictEqual(body.hardening.authConfigured, false);
      assert.strictEqual(body.hardening.scopedTokensConfigured, false);
      assert.strictEqual(body.hardening.rateLimitConfigured, false);
      assert.strictEqual(body.hardening.auditRetentionConfigured, false);
      assert.strictEqual(body.hardening.restoreRootConfigured, false);
      assert.strictEqual(body.hardening.requestBodyLimitBytes, MAX_JSON_BODY_BYTES);
      assert.deepStrictEqual(body.hardening.writeRoutes, API_WRITE_ROUTES.map(formatApiRoute));
      assert.strictEqual(body.safety.tokenValuesReturned, false);
      assert.strictEqual(body.safety.restoreRootValueReturned, false);
      assert.strictEqual(body.safety.auditPathReturned, false);
      assert.strictEqual(body.safety.environmentValuesReturned, false);
      assert.strictEqual(body.safety.successAuditEvent, false);
      assert.ok(!stdout.includes(dataDir));
      assert.deepStrictEqual(await readdir(dataDir), []);
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('passes --token as bearer auth and does not print token or restoreRoot material', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-hardening-auth-'));
    const restoreRoot = await mkdtemp(join(tmpdir(), 'linke-agent-hardening-root-'));
    const server = createServer({
      dataDir,
      readToken: 'hardening-read-token',
      writeToken: 'hardening-write-token',
      restoreRoot,
      rateLimit: { maxRequests: 5, windowMs: 60000 },
      auditRetention: { maxEvents: 5 },
    });
    const port = await listen(server);

    try {
      const { stdout } = await runAgent([
        'hardening-status',
        '--server',
        `http://127.0.0.1:${port}`,
        '--token',
        'hardening-read-token',
      ]);
      const body = JSON.parse(stdout);

      assert.strictEqual(body.hardening.authConfigured, true);
      assert.deepStrictEqual(body.hardening.configuredAuthScopes, {
        full: false,
        read: true,
        write: true,
        admin: false,
      });
      assert.strictEqual(body.hardening.rateLimitConfigured, true);
      assert.strictEqual(body.hardening.auditRetentionConfigured, true);
      assert.strictEqual(body.hardening.restoreRootConfigured, true);
      assert.doesNotMatch(stdout, /hardening-read-token|hardening-write-token|Bearer/);
      assert.ok(!stdout.includes(restoreRoot));
      assert.deepStrictEqual(await readAuditEvents(dataDir), []);
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
      await rm(restoreRoot, { recursive: true, force: true });
    }
  });

  it('exits 1 when auth is required and no token is provided', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-hardening-missing-auth-'));
    const server = createServer({ dataDir, readToken: 'hardening-read-token' });
    const port = await listen(server);

    try {
      const err = await rejectAgent([
        'hardening-status',
        '--server',
        `http://127.0.0.1:${port}`,
      ], 1);

      assert.match(err.stderr, /Unauthorized/);
      assert.doesNotMatch(err.stdout, /hardening|configuredAuthScopes|hardening-read-token/);
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('exits 1 when an invalid token is provided', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-hardening-invalid-auth-'));
    const server = createServer({ dataDir, readToken: 'hardening-read-token' });
    const port = await listen(server);

    try {
      const err = await rejectAgent([
        'hardening-status',
        '--server',
        `http://127.0.0.1:${port}`,
        '--token',
        'wrong-hardening-token',
      ], 1);

      assert.match(err.stderr, /Unauthorized/);
      assert.doesNotMatch(err.stdout, /hardening|configuredAuthScopes|hardening-read-token|wrong-hardening-token/);
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('exits 1 through existing error handling when the server is unreachable', async () => {
    const err = await rejectAgent([
      'hardening-status',
      '--server',
      'http://127.0.0.1:1',
    ], 1);

    assert.match(err.stderr, /Error:/);
  });
});
