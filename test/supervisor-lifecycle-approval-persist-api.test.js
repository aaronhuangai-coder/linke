import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, API_WRITE_ROUTES, isApiWriteRoute } from '../src/server.js';
import { readAuditEvents } from '../src/audit-log.js';
import { readSupervisorLifecycleApprovalRecords } from '../src/approval-store.js';
import { buildSupervisorLifecycleApplyPlan } from '../src/supervisor-lifecycle.js';
import { validateConfig } from '../src/config.js';

const BASE_CONFIG = {
  serverUrl: 'http://localhost:3000',
  deviceId: 'web-api-approval-persist',
  backupJobs: [{ name: 'documents', sourcePath: '/tmp/linke-documents' }],
};

function validApprovalFor(operation = 'install', overrides = {}) {
  const dryRunPlan = buildSupervisorLifecycleApplyPlan(validateConfig(BASE_CONFIG), { operation });
  return {
    operation,
    configHash: dryRunPlan.configHash,
    planHash: dryRunPlan.planHash,
    approved: true,
    schemaVersion: 1,
    approvedBy: 'operator@example.invalid',
    reason: 'do not leak this reason',
    acknowledgements: ['do not leak this acknowledgement'],
    approvedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

async function withServer(options, fn) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    return await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function postJSON(port, path, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = {};
  }
  return { res, text, body: parsed };
}

function assertNoSensitiveText(text, dataDir = '') {
  assert.doesNotMatch(text, /operator@example|do not leak|sha256:|localhost|linke-documents|token|secret|Authorization|Bearer/i);
  assert.doesNotMatch(text, /EEXIST|ENOTDIR|EACCES|ENOENT|\/tmp\/linke-documents/i);
  if (dataDir) {
    assert.ok(!text.includes(dataDir), 'response must not include dataDir path');
  }
}

describe('Supervisor lifecycle approval persist API', () => {
  it('registers approval persist as a write route while preview remains read-only', () => {
    assert.strictEqual(isApiWriteRoute('POST', '/api/supervisor-lifecycle-approval-persist'), true);
    assert.ok(API_WRITE_ROUTES.some((route) => (
      route.method === 'POST' && route.path === '/api/supervisor-lifecycle-approval-persist'
    )));
    assert.strictEqual(isApiWriteRoute('POST', '/api/supervisor-lifecycle-approval-persistence-preview'), false);
  });

  it('persists valid approval through API with sanitized record and audit event', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-approval-persist-api-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, '/api/supervisor-lifecycle-approval-persist', {
          operation: 'install',
          config: BASE_CONFIG,
          approval: validApprovalFor('install'),
        });

        assert.strictEqual(res.status, 201);
        assert.strictEqual(body.command, 'supervisor-lifecycle-approval-record');
        assert.strictEqual(body.state, 'persisted');
        assert.strictEqual(body.operation, 'install');
        assert.strictEqual(body.safety.approvalPersisted, true);
        assert.strictEqual(body.safety.filesystemWritten, true);
        assert.strictEqual(body.safety.lifecycleApplied, false);
        assert.strictEqual(body.safety.launchctlCalled, false);
        assert.strictEqual(body.safety.hostMutation, false);
        assert.deepStrictEqual(await readSupervisorLifecycleApprovalRecords(dataDir), [body]);
        const auditEvents = await readAuditEvents(dataDir, { limit: 10 });
        assert.ok(auditEvents.some((event) => (
          event.type === 'api.supervisor_lifecycle_approval_persist.persisted' &&
          event.statusCode === 201 &&
          event.operation === 'install'
        )));
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('returns blocked preview for invalid approval without creating approval storage', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-approval-persist-api-blocked-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, '/api/supervisor-lifecycle-approval-persist', {
          operation: 'rollback',
          config: BASE_CONFIG,
          approval: validApprovalFor('install'),
        });

        assert.strictEqual(res.status, 409);
        assert.strictEqual(body.command, 'supervisor-lifecycle-approval-persistence-preview');
        assert.strictEqual(body.approvalValid, false);
        assert.ok(body.blockers.length > 0);
        await assert.rejects(() => readdir(join(dataDir, 'approvals')), /ENOENT/);
        const auditEvents = await readAuditEvents(dataDir, { limit: 10 });
        assert.ok(auditEvents.some((event) => (
          event.type === 'api.supervisor_lifecycle_approval_persist.blocked' &&
          event.statusCode === 409 &&
          event.operation === 'rollback'
        )));
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('returns 400 and sanitized failure audit for invalid operations', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-approval-persist-api-invalid-op-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, '/api/supervisor-lifecycle-approval-persist', {
          operation: 'install /tmp/secret-token',
          config: BASE_CONFIG,
          approval: validApprovalFor('install'),
        });

        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(body, { error: 'operation must be one of: install, uninstall, rollback, recover' });
        const auditEvents = await readAuditEvents(dataDir, { limit: 10 });
        assert.ok(auditEvents.some((event) => (
          event.type === 'api.supervisor_lifecycle_approval_persist.failure' &&
          event.statusCode === 400 &&
          event.message === 'invalid operation'
        )));
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('returns 400 and sanitized failure audit for invalid config', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-approval-persist-api-invalid-config-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, '/api/supervisor-lifecycle-approval-persist', {
          operation: 'install',
          config: { deviceId: 'missing-server-url', backupJobs: BASE_CONFIG.backupJobs },
          approval: validApprovalFor('install'),
        });

        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(body, { error: 'serverUrl is required' });
        const auditEvents = await readAuditEvents(dataDir, { limit: 10 });
        assert.ok(auditEvents.some((event) => (
          event.type === 'api.supervisor_lifecycle_approval_persist.failure' &&
          event.statusCode === 400 &&
          event.operation === 'install' &&
          event.message === 'invalid config'
        )));
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('returns 400 and sanitized failure audit for missing approval object', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-approval-persist-api-missing-approval-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, '/api/supervisor-lifecycle-approval-persist', {
          operation: 'install',
          config: BASE_CONFIG,
          approval: 'operator@example.invalid secret token',
        });

        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(body, { error: 'approval object is required' });
        const auditEvents = await readAuditEvents(dataDir, { limit: 10 });
        assert.ok(auditEvents.some((event) => (
          event.type === 'api.supervisor_lifecycle_approval_persist.failure' &&
          event.statusCode === 400 &&
          event.operation === 'install' &&
          event.message === 'approval object is required'
        )));
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('returns 400 for malformed JSON without leaking submitted values', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-approval-persist-api-malformed-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(
          port,
          '/api/supervisor-lifecycle-approval-persist',
          '{"operation":"install","approval":"operator@example.invalid secret token"',
        );

        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(body, { error: 'Invalid JSON body' });
        const auditEvents = await readAuditEvents(dataDir, { limit: 10 });
        assert.ok(auditEvents.some((event) => (
          event.type === 'api.supervisor_lifecycle_approval_persist.failure' &&
          event.statusCode === 400 &&
          event.message === 'invalid request body'
        )));
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('returns static 500 when approval storage write fails without leaking filesystem details', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-approval-persist-api-write-failure-'));
    try {
      await writeFile(join(dataDir, 'approvals'), 'not a directory');
      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, '/api/supervisor-lifecycle-approval-persist', {
          operation: 'install',
          config: BASE_CONFIG,
          approval: validApprovalFor('install'),
        });

        assert.strictEqual(res.status, 500);
        assert.deepStrictEqual(body, { error: 'failed to persist approval record' });
        const auditEvents = await readAuditEvents(dataDir, { limit: 10 });
        assert.ok(auditEvents.some((event) => (
          event.type === 'api.supervisor_lifecycle_approval_persist.failure' &&
          event.statusCode === 500 &&
          event.message === 'failed to persist approval record'
        )));
        assertNoSensitiveText(text, dataDir);
        assert.doesNotMatch(text, /linke-approval-persist-api-write-failure|approvals/i);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects read token for approval persist write route with 403 and auth.forbidden audit', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-approval-persist-api-read-token-'));
    try {
      await withServer({ dataDir, readToken: 'read-token', writeToken: 'write-token' }, async (port) => {
        const { res, body } = await postJSON(port, '/api/supervisor-lifecycle-approval-persist', {
          operation: 'install',
          config: BASE_CONFIG,
          approval: validApprovalFor('install'),
        }, { Authorization: 'Bearer read-token' });

        assert.strictEqual(res.status, 403);
        assert.deepStrictEqual(body, { error: 'Forbidden' });
        await assert.rejects(() => readdir(join(dataDir, 'approvals')), /ENOENT/);
        const auditEvents = await readAuditEvents(dataDir, { limit: 1 });
        assert.strictEqual(auditEvents[0].type, 'auth.forbidden');
        assert.strictEqual(auditEvents[0].path, '/api/supervisor-lifecycle-approval-persist');
        assert.strictEqual(auditEvents[0].statusCode, 403);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects missing token for approval persist write route with 401 and auth.denied audit', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-approval-persist-api-missing-token-'));
    try {
      await withServer({ dataDir, readToken: 'read-token', writeToken: 'write-token' }, async (port) => {
        const { res, body } = await postJSON(port, '/api/supervisor-lifecycle-approval-persist', {
          operation: 'install',
          config: BASE_CONFIG,
          approval: validApprovalFor('install'),
        });

        assert.strictEqual(res.status, 401);
        assert.deepStrictEqual(body, { error: 'Unauthorized' });
        await assert.rejects(() => readdir(join(dataDir, 'approvals')), /ENOENT/);
        const auditEvents = await readAuditEvents(dataDir, { limit: 1 });
        assert.strictEqual(auditEvents[0].type, 'auth.denied');
        assert.strictEqual(auditEvents[0].path, '/api/supervisor-lifecycle-approval-persist');
        assert.strictEqual(auditEvents[0].statusCode, 401);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
