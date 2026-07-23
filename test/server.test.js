import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { API_WRITE_ROUTES, createServer, isApiWriteRoute } from '../src/server.js';
import { ERROR_CODES } from '../src/error-codes.js';

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

/**
 * C6 RED — loopback restore-tasks management surface.
 * Authority: design §8.1 / §9.4 + plan C6 Step 1b / Step 3.
 */
describe('C6 loopback restore-tasks management (RED)', () => {
  const DEVICE_ID = 'mac-restore-mgmt';
  const TASK_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const SNAPSHOT_ID = '550e8400-e29b-41d4-a716-4466554400aa';
  const WRITE_TOKEN = 'c6-restore-write-token-fixture';

  function createMockRestoreService(impl = {}) {
    const calls = {
      createTask: [],
      getStatus: [],
      cancelTask: [],
      findActiveUpload: [],
      findActiveSession: [],
    };
    return {
      calls,
      service: {
        async createTask(input) {
          calls.createTask.push(input);
          if (impl.createTask) return impl.createTask(input);
          return {
            taskId: TASK_ID,
            deviceId: input?.deviceId ?? DEVICE_ID,
            snapshotId: input?.snapshotId ?? SNAPSHOT_ID,
            manifestDigest: 'a'.repeat(64),
            relativeTarget: input?.relativeTarget ?? 'apps/demo',
            status: 'pending',
            fileCount: 2,
            totalBytes: 4096,
            createdAt: '2026-07-23T12:00:00.000Z',
          };
        },
        async getStatus(input) {
          calls.getStatus.push(input);
          if (impl.getStatus) return impl.getStatus(input);
          return {
            taskId: input?.taskId ?? TASK_ID,
            deviceId: input?.deviceId ?? DEVICE_ID,
            snapshotId: SNAPSHOT_ID,
            manifestDigest: 'a'.repeat(64),
            relativeTarget: 'apps/demo',
            status: 'pending',
            fileCount: 2,
            totalBytes: 4096,
            createdAt: '2026-07-23T12:00:00.000Z',
            updatedAt: '2026-07-23T12:00:00.000Z',
            cancelRequested: false,
            cleanupAuthorized: false,
          };
        },
        async cancelTask(input) {
          calls.cancelTask.push(input);
          if (impl.cancelTask) return impl.cancelTask(input);
          return {
            taskId: input?.taskId ?? TASK_ID,
            status: 'cancelled',
            cancelRequested: true,
          };
        },
      },
    };
  }

  async function withRestoreServer(options, fn) {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-mgmt-'));
    const server = createServer({
      dataDir,
      writeToken: WRITE_TOKEN,
      restoreService: options.restoreService,
      ...options.serverOptions,
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      return await fn({ port, dataDir, server });
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
    }
  }

  it('POST create requires write-token; body exact keys; returns safe summary without endpoint abs path', async () => {
    const { service, calls } = createMockRestoreService();
    await withRestoreServer({ restoreService: service }, async ({ port }) => {
      const noAuth = await fetch(`http://127.0.0.1:${port}/api/devices/${DEVICE_ID}/restore-tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ snapshotId: SNAPSHOT_ID, relativeTarget: 'apps/demo' }),
      });
      assert.strictEqual(noAuth.status, 401);
      assert.strictEqual(calls.createTask.length, 0);

      const created = await fetch(`http://127.0.0.1:${port}/api/devices/${DEVICE_ID}/restore-tasks`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WRITE_TOKEN}`,
        },
        body: JSON.stringify({ snapshotId: SNAPSHOT_ID, relativeTarget: 'apps/demo' }),
      });
      assert.ok([200, 201].includes(created.status), `create status ${created.status}`);
      const body = await created.json();
      assert.strictEqual(body.taskId, TASK_ID);
      assert.strictEqual(body.deviceId, DEVICE_ID);
      assert.strictEqual(body.snapshotId, SNAPSHOT_ID);
      assert.strictEqual(body.status, 'pending');
      assert.strictEqual(typeof body.manifestDigest, 'string');
      assert.strictEqual(typeof body.fileCount, 'number');
      assert.strictEqual(typeof body.totalBytes, 'number');
      assert.strictEqual(body.absolutePath, undefined);
      assert.strictEqual(body.targetPath, undefined);
      assert.strictEqual(body.stagingPath, undefined);
      const text = JSON.stringify(body);
      assert.ok(!text.includes('/Users/'));
      assert.ok(!text.includes(WRITE_TOKEN));
      assert.strictEqual(calls.createTask.length, 1);
      assert.strictEqual(calls.createTask[0].deviceId, DEVICE_ID);
      // Admission is not on createTask domain probe: create must not call upload active checks.
      assert.strictEqual(calls.findActiveUpload.length, 0);
      assert.strictEqual(calls.findActiveSession.length, 0);
    });
  });

  it('active upload does not block management createTask (zero findActiveUpload/findActiveSession)', async () => {
    let findActiveUpload = 0;
    let findActiveSession = 0;
    const { service, calls } = createMockRestoreService({
      createTask: async (input) => {
        // Simulate domain create that must not consult upload peers.
        return {
          taskId: TASK_ID,
          deviceId: input.deviceId,
          snapshotId: input.snapshotId,
          manifestDigest: 'b'.repeat(64),
          relativeTarget: input.relativeTarget,
          status: 'pending',
          fileCount: 1,
          totalBytes: 8,
          createdAt: '2026-07-23T12:00:00.000Z',
        };
      },
    });
    // Hostile extras: if management wrongly probes upload, counters move.
    service.findActiveUpload = async () => {
      findActiveUpload += 1;
      return true;
    };
    service.findActiveSession = async () => {
      findActiveSession += 1;
      return { uploadId: 'active' };
    };
    await withRestoreServer({ restoreService: service }, async ({ port }) => {
      const created = await fetch(`http://127.0.0.1:${port}/api/devices/${DEVICE_ID}/restore-tasks`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WRITE_TOKEN}`,
        },
        body: JSON.stringify({ snapshotId: SNAPSHOT_ID, relativeTarget: 'apps/demo' }),
      });
      assert.ok([200, 201].includes(created.status));
      assert.strictEqual(calls.createTask.length, 1);
      assert.strictEqual(findActiveUpload, 0, 'management create must not call findActiveUpload');
      assert.strictEqual(findActiveSession, 0, 'management create must not call findActiveSession');
    });
  });

  it('GET task status is readable; cancel returns 200/202 table without endpoint abs path', async () => {
    /** @type {'pending'|'active'|'terminal'} */
    let cancelMode = 'pending';
    const { service, calls } = createMockRestoreService({
      cancelTask: async () => {
        if (cancelMode === 'active') {
          return { taskId: TASK_ID, status: 'active', cancelRequested: true, httpStatus: 202 };
        }
        if (cancelMode === 'terminal') {
          const err = new Error(ERROR_CODES.RESTORE_TASK_CONFLICT);
          err.code = ERROR_CODES.RESTORE_TASK_CONFLICT;
          err.statusCode = 409;
          throw err;
        }
        return { taskId: TASK_ID, status: 'cancelled', cancelRequested: true, httpStatus: 200 };
      },
    });
    await withRestoreServer({ restoreService: service }, async ({ port }) => {
      const got = await fetch(
        `http://127.0.0.1:${port}/api/devices/${DEVICE_ID}/restore-tasks/${TASK_ID}`,
        {
          headers: { authorization: `Bearer ${WRITE_TOKEN}` },
        },
      );
      assert.strictEqual(got.status, 200);
      const statusBody = await got.json();
      assert.strictEqual(statusBody.taskId, TASK_ID);
      assert.strictEqual(typeof statusBody.cancelRequested, 'boolean');
      assert.ok(!JSON.stringify(statusBody).includes('/Users/'));
      assert.strictEqual(calls.getStatus.length, 1);

      cancelMode = 'pending';
      const cancelPending = await fetch(
        `http://127.0.0.1:${port}/api/devices/${DEVICE_ID}/restore-tasks/${TASK_ID}/cancel`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${WRITE_TOKEN}`,
          },
          body: '{}',
        },
      );
      assert.strictEqual(cancelPending.status, 200);
      const pendingBody = await cancelPending.json();
      assert.strictEqual(pendingBody.status, 'cancelled');
      assert.strictEqual(pendingBody.cancelRequested, true);

      cancelMode = 'active';
      const cancelActive = await fetch(
        `http://127.0.0.1:${port}/api/devices/${DEVICE_ID}/restore-tasks/${TASK_ID}/cancel`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${WRITE_TOKEN}`,
          },
          body: '{}',
        },
      );
      assert.strictEqual(cancelActive.status, 202);
      const activeBody = await cancelActive.json();
      assert.strictEqual(activeBody.status, 'active');
      assert.strictEqual(activeBody.cancelRequested, true);
      assert.ok(!JSON.stringify(activeBody).includes('/Users/'));

      cancelMode = 'terminal';
      const cancelTerminal = await fetch(
        `http://127.0.0.1:${port}/api/devices/${DEVICE_ID}/restore-tasks/${TASK_ID}/cancel`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${WRITE_TOKEN}`,
          },
          body: '{}',
        },
      );
      assert.strictEqual(cancelTerminal.status, 409);
      const termBody = await cancelTerminal.json();
      assert.deepStrictEqual(termBody, { error: ERROR_CODES.RESTORE_TASK_CONFLICT });
    });
  });

  it('without restoreService: restore-tasks paths fixed 404 (no half exposure)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-c6-rs-mgmt-nosvc-'));
    const server = createServer({ dataDir, writeToken: WRITE_TOKEN });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      const paths = [
        ['POST', `/api/devices/${DEVICE_ID}/restore-tasks`, JSON.stringify({
          snapshotId: SNAPSHOT_ID,
          relativeTarget: 'apps/demo',
        })],
        ['GET', `/api/devices/${DEVICE_ID}/restore-tasks/${TASK_ID}`, undefined],
        ['POST', `/api/devices/${DEVICE_ID}/restore-tasks/${TASK_ID}/cancel`, '{}'],
      ];
      for (const [method, path, body] of paths) {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${WRITE_TOKEN}`,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          body,
        });
        assert.strictEqual(res.status, 404, `${method} ${path}`);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
