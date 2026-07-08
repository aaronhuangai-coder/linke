import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  API_WRITE_ROUTES,
  createServer,
  isApiWriteRoute,
} from '../src/server.js';
import { readSupervisorLifecycleApprovalRecords } from '../src/approval-store.js';
import { buildSupervisorLifecycleApplyPlan } from '../src/supervisor-lifecycle.js';
import { validateConfig } from '../src/config.js';

const BASE_CONFIG = {
  serverUrl: 'http://localhost:3000',
  deviceId: 'apply-readiness-api',
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
    reason: 'do not leak this readiness reason',
    acknowledgements: ['do not leak this readiness acknowledgement'],
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

describe('Supervisor lifecycle apply readiness API', () => {
  it('keeps apply readiness outside API write routes', () => {
    assert.strictEqual(isApiWriteRoute('POST', '/api/supervisor-lifecycle-apply-readiness'), false);
    assert.strictEqual(API_WRITE_ROUTES.some((route) => (
      route.method === 'POST' && route.path === '/api/supervisor-lifecycle-apply-readiness'
    )), false);
  });

  it('returns blocked readiness without records and does not create approval storage', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-apply-readiness-api-empty-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, '/api/supervisor-lifecycle-apply-readiness', {
          operation: 'install',
          config: BASE_CONFIG,
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.command, 'supervisor-lifecycle-apply-readiness');
        assert.strictEqual(body.state, 'blocked');
        assert.strictEqual(body.approvalRecordState, 'blocked');
        assert.deepStrictEqual(body.blockers, ['approval-record-missing']);
        assert.strictEqual(body.approvalRecords.count, 0);
        assert.strictEqual(body.safety.readOnly, true);
        assert.strictEqual(body.safety.lifecycleApplied, false);
        assert.strictEqual(body.safety.launchctlCalled, false);
        assert.deepStrictEqual(await readSupervisorLifecycleApprovalRecords(dataDir), []);
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('marks approval record gate ready after a valid persisted approval record', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-apply-readiness-api-ready-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const persisted = await postJSON(port, '/api/supervisor-lifecycle-approval-persist', {
          operation: 'rollback',
          config: BASE_CONFIG,
          approval: validApprovalFor('rollback'),
        });
        assert.strictEqual(persisted.res.status, 201);

        const { res, text, body } = await postJSON(port, '/api/supervisor-lifecycle-apply-readiness', {
          operation: 'rollback',
          config: BASE_CONFIG,
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.state, 'blocked');
        assert.strictEqual(body.approvalRecordState, 'ready');
        assert.strictEqual(body.approvalRecordReady, true);
        assert.deepStrictEqual(body.blockers, []);
        assert.deepStrictEqual(body.nextBlockers, ['executor-implementation-missing']);
        assert.strictEqual(body.approvalRecords.count, 1);
        assert.strictEqual(body.approvalRecords.operationMatchCount, 1);
        assert.strictEqual(body.approvalRecords.persistedMatchCount, 1);
        assert.strictEqual(body.gates.approvalRecordValid, true);
        assert.strictEqual(body.gates.executorImplemented, false);
        assert.strictEqual(body.safety.lifecycleApplied, false);
        assert.strictEqual(body.safety.launchctlCalled, false);
        assert.deepStrictEqual(await readSupervisorLifecycleApprovalRecords(dataDir), [persisted.body]);
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('fails closed for tampered approval records read from local storage', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-apply-readiness-api-tampered-'));
    try {
      const approvalsDir = join(dataDir, 'approvals');
      await mkdir(approvalsDir, { recursive: true });
      await writeFile(join(approvalsDir, 'supervisor-lifecycle-approvals.jsonl'), `${JSON.stringify({
        command: 'supervisor-lifecycle-approval-record',
        schemaVersion: 1,
        id: 'tampered-record',
        createdAt: '2026-07-08T00:00:00.000Z',
        operation: 'install',
        state: 'persisted',
        approvalValid: true,
        approvedBy: 'operator@example.invalid',
        reason: 'do not leak this reason',
        validation: {
          approvalValid: true,
          acknowledgementCount: 1,
          windowWithinLimit: true,
          operationMatchesPlan: true,
          configHashMatchesPlan: true,
          planHashMatchesPlan: true,
        },
        safety: {
          approvalPersisted: true,
          filesystemWritten: true,
          hostMutation: true,
          launchctlCalled: true,
          lifecycleApplied: true,
          sensitiveValuesReturned: true,
        },
      })}\n`, 'utf-8');

      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, '/api/supervisor-lifecycle-apply-readiness', {
          operation: 'install',
          config: BASE_CONFIG,
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.state, 'blocked');
        assert.deepStrictEqual(body.blockers, ['approval-record-safety-invalid']);
        assert.strictEqual(body.safety.lifecycleApplied, false);
        assert.strictEqual(body.safety.launchctlCalled, false);
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('allows read token to call readiness because the endpoint is read-only', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-apply-readiness-api-read-token-'));
    try {
      await withServer({ dataDir, readToken: 'read-token', writeToken: 'write-token' }, async (port) => {
        const { res, body } = await postJSON(port, '/api/supervisor-lifecycle-apply-readiness', {
          operation: 'install',
          config: BASE_CONFIG,
        }, { Authorization: 'Bearer read-token' });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.command, 'supervisor-lifecycle-apply-readiness');
        assert.strictEqual(body.state, 'blocked');
        assert.strictEqual(body.safety.readOnly, true);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects invalid input without echoing submitted values', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-apply-readiness-api-invalid-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, '/api/supervisor-lifecycle-apply-readiness', {
          operation: 'install /tmp/secret-token',
          config: { deviceId: 'missing-server-url', backupJobs: BASE_CONFIG.backupJobs },
        });

        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(body, { error: 'operation must be one of: install, uninstall, rollback, recover' });
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
