import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
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

const ROUTE = '/api/supervisor-lifecycle-guarded-runner-execution-gate';

const BASE_CONFIG = {
  serverUrl: 'http://localhost:3000',
  deviceId: 'guarded-runner-execution-gate-api',
  backupJobs: [{ name: 'documents', sourcePath: '/tmp/linke-documents' }],
};

function validApprovalFor(operation = 'install') {
  const dryRunPlan = buildSupervisorLifecycleApplyPlan(validateConfig(BASE_CONFIG), { operation });
  return {
    operation,
    configHash: dryRunPlan.configHash,
    planHash: dryRunPlan.planHash,
    approved: true,
    schemaVersion: 1,
    approvedBy: 'operator@example.invalid',
    reason: 'do not leak execution gate approval reason',
    acknowledgements: ['do not leak execution gate acknowledgement'],
    approvedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };
}

function validInstallManifest() {
  return {
    kind: 'supervisor-lifecycle-executor-manifest',
    schemaVersion: 1,
    actions: [
      {
        actionId: 'render-launch-agent-plist',
        implementationId: 'render-plist-impl',
        mode: 'guarded-host-action',
        requiresApprovalRecord: true,
        maxAttempts: 2,
      },
      {
        actionId: 'write-launch-agent-plist',
        implementationId: 'write-plist-impl',
        mode: 'guarded-host-action',
        requiresApprovalRecord: true,
        maxAttempts: 1,
      },
      {
        actionId: 'load-launch-agent',
        implementationId: 'load-agent-impl',
        mode: 'guarded-host-action',
        requiresApprovalRecord: true,
        maxAttempts: 3,
      },
    ],
  };
}

function validRunnerBinding() {
  return {
    kind: 'supervisor-lifecycle-guarded-runner-binding',
    schemaVersion: 1,
    bindings: [
      {
        actionId: 'render-launch-agent-plist',
        implementationId: 'render-plist-impl',
        mode: 'guarded-host-action',
        runnerKind: 'guarded-runner-stub',
        requiresApprovalRecord: true,
        maxAttempts: 2,
      },
      {
        actionId: 'write-launch-agent-plist',
        implementationId: 'write-plist-impl',
        mode: 'guarded-host-action',
        runnerKind: 'guarded-runner-stub',
        requiresApprovalRecord: true,
        maxAttempts: 1,
      },
      {
        actionId: 'load-launch-agent',
        implementationId: 'load-agent-impl',
        mode: 'guarded-host-action',
        runnerKind: 'guarded-runner-stub',
        requiresApprovalRecord: true,
        maxAttempts: 3,
      },
    ],
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
  for (const disallowed of [
    'serverUrl',
    'sourcePath',
    'localhost',
    'linke-documents',
    'operator@example.invalid',
    'execution gate approval',
    'execution gate acknowledgement',
    'do not leak submitted approval reason',
    'do not leak submitted approval acknowledgement',
    'token',
    'secret',
    'Authorization',
    'Bearer',
    'sha256:',
    '/usr/bin',
    '/Users/ah',
    '/tmp/linke-documents',
    '/tmp/SECRET_XYZ',
    'SECRET_XYZ',
    'raw-manifest-secret',
    'raw-runner-binding-secret',
    'launchctl load',
  ]) {
    assert.ok(!text.includes(disallowed), `response leaked ${disallowed}`);
  }
  assert.doesNotMatch(text, /EEXIST|ENOTDIR|EACCES|ENOENT|SyntaxError/i);
  if (dataDir) {
    assert.ok(!text.includes(dataDir), 'response must not include dataDir path');
  }
}

function assertBlockedExecutionGate(body) {
  assert.strictEqual(body.command, 'supervisor-lifecycle-guarded-runner-execution-gate');
  assert.strictEqual(body.operation, 'install');
  assert.strictEqual(body.state, 'blocked');
  assert.strictEqual(body.executionGateState, 'blocked');
  assert.strictEqual(body.executionEligible, false);
  assert.strictEqual(body.executorReady, false);
  assert.strictEqual(body.wouldExecute, false);
  assert.strictEqual(body.gates.realRunnerWiringReady, false);
  assert.strictEqual(body.gates.runnerWiringContractReady, false);
  assert.strictEqual(body.realRunnerWiringReady, false);
  assert.deepStrictEqual(body.nextBlockers, ['real-guarded-runner-execution-wiring-missing']);
  assert.ok(body.blockers.includes('real-guarded-runner-execution-wiring-missing'));
  assert.strictEqual(body.runnerWiringContract.command, 'supervisor-lifecycle-guarded-runner-wiring-contract');
  assert.strictEqual(body.runnerWiringContract.state, 'blocked');
  assert.strictEqual(body.runnerWiringContract.realRunnerWiringReady, false);
  assert.strictEqual(body.runnerWiringContract.readyCount, 0);
  assert.strictEqual(body.runnerWiringContract.blockedCount, 5);
  assert.deepStrictEqual(body.runnerWiringContract.nextBlockers, ['real-guarded-runner-execution-wiring-missing']);
  assert.deepStrictEqual(
    body.runnerWiringContract.requiredContracts.map((entry) => entry.id),
    ['runner-registry', 'host-mutation-adapter', 'rollback-anchor', 'attempt-audit', 'operator-recovery'],
  );
  assert.ok(body.runnerWiringContract.requiredContracts.every((entry) =>
    entry.status === 'blocked' && entry.requiredForExecution === true));
  assert.strictEqual(body.safety.readOnly, true);
  assert.strictEqual(body.safety.lifecycleApplied, false);
  assert.strictEqual(body.safety.filesystemWritten, false);
  assert.strictEqual(body.safety.auditEventWritten, false);
  assert.strictEqual(body.safety.metadataWritten, false);
}

describe('Supervisor lifecycle guarded runner execution gate API', () => {
  it('keeps guarded runner execution gate outside API write routes', () => {
    assert.strictEqual(API_WRITE_ROUTES.length, 4);
    assert.strictEqual(isApiWriteRoute('POST', ROUTE), false);
    assert.strictEqual(API_WRITE_ROUTES.some((route) => (
      route.method === 'POST' && route.path === ROUTE
    )), false);
  });

  it('returns blocked execution gate for valid inline metadata without creating approval storage', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-execution-gate-api-valid-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, ROUTE, {
          operation: 'install',
          config: BASE_CONFIG,
          manifest: validInstallManifest(),
          runnerBinding: validRunnerBinding(),
        });

        assert.strictEqual(res.status, 200);
        assertBlockedExecutionGate(body);
        assert.ok(body.blockers.includes('approval-record-gate-not-ready'));
        assert.ok(body.blockers.includes('execute-request-missing'));
        assert.strictEqual(body.gates.approvalRecordReady, false);
        assert.strictEqual(body.gates.executeRequested, false);
        assert.strictEqual(body.gates.runnerBindingsReady, true);
        assert.strictEqual(body.actionCandidates.length, 3);
        assert.ok(body.actionCandidates.every((entry) =>
          entry.status === 'blocked' &&
            entry.wouldExecute === false &&
            entry.wouldRun === false &&
            entry.wouldWrite === false));
        assert.deepStrictEqual(await readSupervisorLifecycleApprovalRecords(dataDir), []);
        await assert.rejects(() => readdir(join(dataDir, 'approvals')), /ENOENT/);
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('honors persisted approval record and executeRequested intent while remaining blocked', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-execution-gate-api-ready-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const persisted = await postJSON(port, '/api/supervisor-lifecycle-approval-persist', {
          operation: 'install',
          config: BASE_CONFIG,
          approval: validApprovalFor('install'),
        });
        assert.strictEqual(persisted.res.status, 201);

        const { res, text, body } = await postJSON(port, ROUTE, {
          operation: 'install',
          config: BASE_CONFIG,
          manifest: validInstallManifest(),
          runnerBinding: validRunnerBinding(),
          executeRequested: true,
        });

        assert.strictEqual(res.status, 200);
        assertBlockedExecutionGate(body);
        assert.ok(!body.blockers.includes('execute-request-missing'));
        assert.deepStrictEqual(body.blockers, ['real-guarded-runner-execution-wiring-missing']);
        assert.strictEqual(body.gates.approvalRecordReady, true);
        assert.strictEqual(body.gates.executeRequested, true);
        assert.strictEqual(body.executionEligible, false);
        assert.strictEqual(body.wouldExecute, false);
        assert.strictEqual(body.safety.lifecycleApplied, false);
        assert.deepStrictEqual(await readSupervisorLifecycleApprovalRecords(dataDir), [persisted.body]);
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('allows read token because the endpoint is read-only', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-execution-gate-api-read-token-'));
    try {
      await withServer({ dataDir, readToken: 'read-token', writeToken: 'write-token' }, async (port) => {
        const { res, body } = await postJSON(port, ROUTE, {
          operation: 'install',
          config: BASE_CONFIG,
          manifest: validInstallManifest(),
          runnerBinding: validRunnerBinding(),
        }, { Authorization: 'Bearer read-token' });

        assert.strictEqual(res.status, 200);
        assertBlockedExecutionGate(body);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('handles missing runnerBinding as blocked gate without action candidates', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-execution-gate-api-missing-runner-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, ROUTE, {
          operation: 'install',
          config: BASE_CONFIG,
          manifest: validInstallManifest(),
        });

        assert.strictEqual(res.status, 200);
        assertBlockedExecutionGate(body);
        assert.strictEqual(body.gates.runnerBindingsReady, false);
        assert.ok(body.blockers.includes('guarded-runner-readiness-not-ready'));
        assert.strictEqual(body.actionCandidates.length, 0);
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects invalid operation, config, manifest, and executeRequested with fixed sanitized errors', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-execution-gate-api-invalid-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const invalidOperation = await postJSON(port, ROUTE, {
          operation: 'install /tmp/SECRET_XYZ',
          config: { token: 'SECRET_XYZ', deviceId: 'missing-server-url', backupJobs: BASE_CONFIG.backupJobs },
          manifest: validInstallManifest(),
          runnerBinding: validRunnerBinding(),
        });

        assert.strictEqual(invalidOperation.res.status, 400);
        assert.deepStrictEqual(invalidOperation.body, {
          error: 'operation must be one of: install, uninstall, rollback, recover',
        });
        assertNoSensitiveText(invalidOperation.text, dataDir);

        const invalidConfig = await postJSON(port, ROUTE, {
          operation: 'install',
          config: { token: 'SECRET_XYZ', deviceId: 'missing-server-url', backupJobs: BASE_CONFIG.backupJobs },
          manifest: validInstallManifest(),
          runnerBinding: validRunnerBinding(),
        });

        assert.strictEqual(invalidConfig.res.status, 400);
        assert.deepStrictEqual(invalidConfig.body, {
          error: 'supervisor-lifecycle-guarded-runner-execution-gate failed; verify config is a readable valid Linke config',
        });
        assertNoSensitiveText(invalidConfig.text, dataDir);

        const missingManifest = await postJSON(port, ROUTE, {
          operation: 'install',
          config: BASE_CONFIG,
          runnerBinding: validRunnerBinding(),
        });

        assert.strictEqual(missingManifest.res.status, 400);
        assert.deepStrictEqual(missingManifest.body, {
          error: 'supervisor-lifecycle-guarded-runner-execution-gate failed; execution gate validation did not complete',
        });
        assertNoSensitiveText(missingManifest.text, dataDir);

        const invalidManifest = await postJSON(port, ROUTE, {
          operation: 'install',
          config: BASE_CONFIG,
          manifest: {
            kind: 'wrong-kind',
            schemaVersion: 1,
            actions: [{ actionId: 'raw-manifest-secret', implementationId: 'sha256:abc' }],
          },
          runnerBinding: validRunnerBinding(),
        });

        assert.strictEqual(invalidManifest.res.status, 400);
        assert.deepStrictEqual(invalidManifest.body, {
          error: 'supervisor-lifecycle-guarded-runner-execution-gate failed; execution gate validation did not complete',
        });
        assertNoSensitiveText(invalidManifest.text, dataDir);

        for (const executeRequested of ['yes', null, 1, { value: true }]) {
          const invalidExecuteRequested = await postJSON(port, ROUTE, {
            operation: 'install',
            config: BASE_CONFIG,
            manifest: validInstallManifest(),
            runnerBinding: validRunnerBinding(),
            executeRequested,
          });

          assert.strictEqual(invalidExecuteRequested.res.status, 400);
          assert.deepStrictEqual(invalidExecuteRequested.body, {
            error: 'executeRequested must be a boolean when provided',
          });
          assertNoSensitiveText(invalidExecuteRequested.text, dataDir);
        }
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('returns a fixed sanitized error when approval records cannot be read', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-execution-gate-api-store-error-'));
    try {
      await mkdir(join(dataDir, 'approvals', 'supervisor-lifecycle-approvals.jsonl'), { recursive: true });

      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, ROUTE, {
          operation: 'install',
          config: BASE_CONFIG,
          manifest: validInstallManifest(),
          runnerBinding: validRunnerBinding(),
        });

        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(body, {
          error: 'failed to read supervisor lifecycle approval records',
        });
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('ignores submitted approval, dataDir, apply, output, and path-like fields without writes or leaks', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-execution-gate-api-ignore-extra-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, ROUTE, {
          operation: 'install',
          config: BASE_CONFIG,
          manifest: validInstallManifest(),
          runnerBinding: validRunnerBinding(),
          apply: true,
          output: '/tmp/SECRET_XYZ',
          dataDir: '/tmp/SECRET_XYZ',
          configPath: '/tmp/SECRET_XYZ',
          manifestPath: '/tmp/SECRET_XYZ',
          runnerBindingPath: '/tmp/SECRET_XYZ',
          executionPreview: {
            command: 'launchctl load /Users/ah/Library/LaunchAgents/linke.plist',
            token: 'SECRET_XYZ',
            secret: 'raw-runner-binding-secret',
            hostname: 'unsafe.example',
            hash: 'sha256:abc',
          },
          approval: {
            approvedBy: 'operator@example.invalid',
            reason: 'do not leak submitted approval reason',
            acknowledgements: ['do not leak submitted approval acknowledgement'],
            configHash: 'sha256:abc',
          },
        });

        assert.strictEqual(res.status, 200);
        assertBlockedExecutionGate(body);
        assert.ok(body.blockers.includes('approval-record-gate-not-ready'));
        assert.strictEqual(body.gates.approvalRecordReady, false);
        assert.strictEqual(body.gates.runnerBindingsReady, true);
        assert.deepStrictEqual(await readSupervisorLifecycleApprovalRecords(dataDir), []);
        await assert.rejects(() => readdir(join(dataDir, 'approvals')), /ENOENT/);
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
