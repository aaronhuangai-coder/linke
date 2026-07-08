import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
  deviceId: 'executor-readiness-api',
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
    reason: 'do not leak this executor readiness reason',
    acknowledgements: ['do not leak this executor readiness acknowledgement'],
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
  assert.doesNotMatch(text, /operator@example|do not leak|sha256:|localhost|linke-documents|token|secret|password|Authorization|Bearer/i);
  assert.doesNotMatch(text, /EEXIST|ENOTDIR|EACCES|ENOENT|\/tmp\/linke-documents/i);
  if (dataDir) {
    assert.ok(!text.includes(dataDir), 'response must not include dataDir path');
  }
}

describe('Supervisor lifecycle executor readiness API', () => {
  it('keeps executor readiness outside API write routes', () => {
    assert.strictEqual(API_WRITE_ROUTES.length, 4);
    assert.strictEqual(isApiWriteRoute('POST', '/api/supervisor-lifecycle-executor-readiness'), false);
    assert.strictEqual(API_WRITE_ROUTES.some((route) => (
      route.method === 'POST' && route.path === '/api/supervisor-lifecycle-executor-readiness'
    )), false);
  });

  it('returns blocked executor readiness without records and does not create approval storage', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-executor-readiness-api-empty-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, '/api/supervisor-lifecycle-executor-readiness', {
          operation: 'install',
          config: BASE_CONFIG,
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.command, 'supervisor-lifecycle-executor-readiness');
        assert.strictEqual(body.state, 'blocked');
        assert.strictEqual(body.executorState, 'blocked');
        assert.strictEqual(body.executorReady, false);
        assert.strictEqual(body.approvalRecordReady, false);
        assert.ok(body.blockers.includes('approval-record-gate-not-ready'));
        assert.ok(body.blockers.includes('approval-record-missing'));
        assert.ok(body.blockers.includes('executor-not-implemented-for-action:render-launch-agent-plist'));
        assert.ok(body.blockers.includes('executor-not-implemented-for-action:write-launch-agent-plist'));
        assert.ok(body.blockers.includes('executor-not-implemented-for-action:load-launch-agent'));
        assert.deepStrictEqual(body.executorBlockers.map((entry) => entry.actionId), [
          'render-launch-agent-plist',
          'write-launch-agent-plist',
          'load-launch-agent',
        ]);
        assert.strictEqual(body.safety.readOnly, true);
        assert.strictEqual(body.safety.lifecycleApplied, false);
        assert.strictEqual(body.safety.launchctlCalled, false);
        assert.deepStrictEqual(await readSupervisorLifecycleApprovalRecords(dataDir), []);
        await assert.rejects(() => readdir(join(dataDir, 'approvals')), /ENOENT/);
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps executor readiness blocked after the approval record gate is ready', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-executor-readiness-api-ready-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const persisted = await postJSON(port, '/api/supervisor-lifecycle-approval-persist', {
          operation: 'rollback',
          config: BASE_CONFIG,
          approval: validApprovalFor('rollback'),
        });
        assert.strictEqual(persisted.res.status, 201);

        const { res, text, body } = await postJSON(port, '/api/supervisor-lifecycle-executor-readiness', {
          operation: 'rollback',
          config: BASE_CONFIG,
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.state, 'blocked');
        assert.strictEqual(body.executorState, 'blocked');
        assert.strictEqual(body.executorReady, false);
        assert.strictEqual(body.approvalRecordReady, true);
        assert.deepStrictEqual(body.blockers, [
          'executor-not-implemented-for-action:capture-current-state',
          'executor-not-implemented-for-action:restore-previous-plist',
          'executor-not-implemented-for-action:restart-previous-supervisor',
        ]);
        assert.deepStrictEqual(body.nextBlockers, body.blockers);
        assert.strictEqual(body.gates.approvalRecordReady, true);
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

  it('allows read token to call executor readiness because the endpoint is read-only', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-executor-readiness-api-read-token-'));
    try {
      await withServer({ dataDir, readToken: 'read-token', writeToken: 'write-token' }, async (port) => {
        const { res, body } = await postJSON(port, '/api/supervisor-lifecycle-executor-readiness', {
          operation: 'install',
          config: BASE_CONFIG,
        }, { Authorization: 'Bearer read-token' });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.command, 'supervisor-lifecycle-executor-readiness');
        assert.strictEqual(body.state, 'blocked');
        assert.strictEqual(body.executorReady, false);
        assert.strictEqual(body.safety.readOnly, true);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects invalid input without echoing submitted values', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-executor-readiness-api-invalid-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const invalidOperation = await postJSON(port, '/api/supervisor-lifecycle-executor-readiness', {
          operation: 'install /tmp/secret-token',
          config: { token: 'secret-token', deviceId: 'missing-server-url', backupJobs: BASE_CONFIG.backupJobs },
        });

        assert.strictEqual(invalidOperation.res.status, 400);
        assert.deepStrictEqual(invalidOperation.body, { error: 'operation must be one of: install, uninstall, rollback, recover' });
        assertNoSensitiveText(invalidOperation.text, dataDir);

        const invalidConfig = await postJSON(port, '/api/supervisor-lifecycle-executor-readiness', {
          operation: 'install',
          config: { token: 'secret-token', deviceId: 'missing-server-url', backupJobs: BASE_CONFIG.backupJobs },
        });

        assert.strictEqual(invalidConfig.res.status, 400);
        assertNoSensitiveText(invalidConfig.text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('sanitizes approval store read failures without leaking dataDir paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'linke-executor-readiness-api-store-error-'));
    const dataDir = join(dir, 'store-file');
    try {
      await writeFile(dataDir, 'not a directory');
      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, '/api/supervisor-lifecycle-executor-readiness', {
          operation: 'install',
          config: BASE_CONFIG,
        });

        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(body, { error: 'failed to read supervisor lifecycle approval records' });
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ignores submitted approval JSON and never echoes approval metadata', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-executor-readiness-api-approval-ignored-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, '/api/supervisor-lifecycle-executor-readiness', {
          operation: 'install',
          config: BASE_CONFIG,
          approval: validApprovalFor('install', {
            approvedBy: 'operator@example.invalid',
            reason: 'do not leak submitted approval reason',
            acknowledgements: ['do not leak submitted approval acknowledgement'],
          }),
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.approvalRecordReady, false);
        assert.ok(body.blockers.includes('approval-record-missing'));
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
