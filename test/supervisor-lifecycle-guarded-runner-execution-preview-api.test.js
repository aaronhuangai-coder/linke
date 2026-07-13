import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  API_WRITE_ROUTES,
  createServer,
  isApiWriteRoute,
} from '../src/server.js';

const BASE_CONFIG = {
  serverUrl: 'http://localhost:3000',
  deviceId: 'guarded-runner-execution-preview-api',
  backupJobs: [{ name: 'documents', sourcePath: '/tmp/linke-documents' }],
};

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
    'localhost',
    'linke-documents',
    'token=',
    'password=',
    'Authorization',
    'Bearer',
    'SECRET_XYZ',
    '/usr/bin',
    '/Users/ah',
    '/tmp/linke-documents',
    'operator@example.invalid',
    'do not leak submitted approval reason',
    'do not leak submitted approval acknowledgement',
  ]) {
    assert.ok(!text.includes(disallowed), `response leaked ${disallowed}`);
  }
  assert.doesNotMatch(text, /\beval\b/i);
  assert.doesNotMatch(text, /EEXIST|ENOTDIR|EACCES|ENOENT|SyntaxError/i);
  if (dataDir) {
    assert.ok(!text.includes(dataDir), 'response must not include dataDir path');
  }
}

function assertExecutionPreviewSafety(safety) {
  assert.strictEqual(safety.readOnly, true);
  assert.strictEqual(safety.dryRun, true);
  assert.strictEqual(safety.hostMutation, false);
  assert.strictEqual(safety.launchctlCalled, false);
  assert.strictEqual(safety.processListRead, false);
  assert.strictEqual(safety.filesystemWritten, false);
  assert.strictEqual(safety.metadataWritten, false);
  assert.strictEqual(safety.rollbackAnchorWritten, false);
  assert.strictEqual(safety.auditEventWritten, false);
  assert.strictEqual(safety.approvalPersisted, false);
  assert.strictEqual(safety.sensitiveValuesReturned, false);
  assert.strictEqual(safety.lifecycleApplied, false);
  assert.strictEqual(safety.nasConnected, false);
  assert.strictEqual(safety.backupTriggered, false);
  assert.strictEqual(safety.restoreTriggered, false);
  assert.strictEqual(safety.remoteCommandExecuted, false);
}

describe('Supervisor lifecycle guarded runner execution preview API', () => {
  it('keeps guarded runner execution preview outside API write routes', () => {
    assert.strictEqual(API_WRITE_ROUTES.length, 6);
    assert.strictEqual(isApiWriteRoute('POST', '/api/supervisor-lifecycle-guarded-runner-execution-preview'), false);
    assert.strictEqual(API_WRITE_ROUTES.some((route) => (
      route.method === 'POST' && route.path === '/api/supervisor-lifecycle-guarded-runner-execution-preview'
    )), false);
  });

  it('returns blocked guarded runner execution preview for valid inline metadata without creating approval storage', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-execution-preview-api-valid-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, '/api/supervisor-lifecycle-guarded-runner-execution-preview', {
          operation: 'install',
          config: BASE_CONFIG,
          manifest: validInstallManifest(),
          runnerBinding: validRunnerBinding(),
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.command, 'supervisor-lifecycle-guarded-runner-execution-preview');
        assert.strictEqual(body.operation, 'install');
        assert.strictEqual(body.state, 'blocked');
        assert.strictEqual(body.executionReady, false);
        assert.strictEqual(body.executorReady, false);
        assert.strictEqual(body.wouldExecute, false);
        assert.strictEqual(body.runnerBindingsReady, true);
        assert.deepStrictEqual(body.blockers, ['guarded-runner-execution-preview-only']);
        assert.deepStrictEqual(body.nextBlockers, ['real-guarded-runner-execution-wiring-missing']);
        assert.strictEqual(body.actionPreviews.length, 3);
        assert.ok(body.actionPreviews.every((entry) =>
          entry.status === 'blocked' &&
            entry.wouldExecute === false &&
            entry.wouldRun === false &&
            entry.wouldWrite === false));
        assertExecutionPreviewSafety(body.safety);
        assert.deepStrictEqual(body.gates, {
          lifecyclePlanValid: true,
          runnerBindingsReady: true,
          executionPreviewOnly: true,
          executorReady: false,
        });
        await assert.rejects(() => readdir(join(dataDir, 'approvals')), /ENOENT/);
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('allows read token to call guarded runner execution preview because the endpoint is read-only', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-execution-preview-api-read-token-'));
    try {
      await withServer({ dataDir, readToken: 'read-token', writeToken: 'write-token' }, async (port) => {
        const { res, body } = await postJSON(port, '/api/supervisor-lifecycle-guarded-runner-execution-preview', {
          operation: 'install',
          config: BASE_CONFIG,
          manifest: validInstallManifest(),
          runnerBinding: validRunnerBinding(),
        }, { Authorization: 'Bearer read-token' });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.command, 'supervisor-lifecycle-guarded-runner-execution-preview');
        assert.strictEqual(body.state, 'blocked');
        assert.strictEqual(body.executionReady, false);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('redacts unsafe inline runner binding values from blocked action previews', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-execution-preview-api-unsafe-'));
    try {
      const runnerBinding = validRunnerBinding();
      runnerBinding.bindings[0].implementationId =
        'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      runnerBinding.bindings[0].runnerKind = 'node /Users/ah/.ssh/id_rsa token=SECRET_XYZ';
      runnerBinding.bindings[0].mode = 'curl http://unsafe.example password=super-secret';

      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, '/api/supervisor-lifecycle-guarded-runner-execution-preview', {
          operation: 'install',
          config: BASE_CONFIG,
          manifest: validInstallManifest(),
          runnerBinding,
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.state, 'blocked');
        assert.strictEqual(body.runnerBindingsReady, false);
        assert.strictEqual(body.actionPreviews[0].implementationId, '[redacted]');
        assert.strictEqual(body.actionPreviews[0].runnerKind, '[redacted]');
        assert.strictEqual(body.actionPreviews[0].mode, '[redacted]');
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('handles missing inline runner binding as blocked execution preview without action previews', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-execution-preview-api-missing-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, '/api/supervisor-lifecycle-guarded-runner-execution-preview', {
          operation: 'install',
          config: BASE_CONFIG,
          manifest: validInstallManifest(),
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.state, 'blocked');
        assert.strictEqual(body.runnerBindingsReady, false);
        assert.strictEqual(body.actionPreviews.length, 0);
        assert.ok(body.blockers.includes('guarded-runner-readiness-not-ready'));
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects invalid operation, config, and missing or invalid manifest with fixed sanitized errors', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-execution-preview-api-invalid-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const invalidOperation = await postJSON(port, '/api/supervisor-lifecycle-guarded-runner-execution-preview', {
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

        const invalidConfig = await postJSON(port, '/api/supervisor-lifecycle-guarded-runner-execution-preview', {
          operation: 'install',
          config: { token: 'SECRET_XYZ', deviceId: 'missing-server-url', backupJobs: BASE_CONFIG.backupJobs },
          manifest: validInstallManifest(),
          runnerBinding: validRunnerBinding(),
        });

        assert.strictEqual(invalidConfig.res.status, 400);
        assert.deepStrictEqual(invalidConfig.body, {
          error: 'supervisor-lifecycle-guarded-runner-execution-preview failed; verify config is a readable valid Linke config',
        });
        assertNoSensitiveText(invalidConfig.text, dataDir);

        const missingManifest = await postJSON(port, '/api/supervisor-lifecycle-guarded-runner-execution-preview', {
          operation: 'install',
          config: BASE_CONFIG,
          runnerBinding: validRunnerBinding(),
        });

        assert.strictEqual(missingManifest.res.status, 400);
        assert.deepStrictEqual(missingManifest.body, {
          error: 'supervisor-lifecycle-guarded-runner-execution-preview failed; execution preview validation did not complete',
        });
        assertNoSensitiveText(missingManifest.text, dataDir);

        const invalidManifest = await postJSON(port, '/api/supervisor-lifecycle-guarded-runner-execution-preview', {
          operation: 'install',
          config: BASE_CONFIG,
          manifest: { kind: 'wrong-kind', schemaVersion: 1, actions: 'bad' },
          runnerBinding: validRunnerBinding(),
        });

        assert.strictEqual(invalidManifest.res.status, 400);
        assert.deepStrictEqual(invalidManifest.body, {
          error: 'supervisor-lifecycle-guarded-runner-execution-preview failed; execution preview validation did not complete',
        });
        assertNoSensitiveText(invalidManifest.text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('ignores submitted approval, dataDir, apply, output, and path-like fields without leaking metadata', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-execution-preview-api-ignore-extra-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, '/api/supervisor-lifecycle-guarded-runner-execution-preview', {
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
          approval: {
            approvedBy: 'operator@example.invalid',
            reason: 'do not leak submitted approval reason',
            acknowledgements: ['do not leak submitted approval acknowledgement'],
          },
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.state, 'blocked');
        assert.strictEqual(body.runnerBindingsReady, true);
        assertExecutionPreviewSafety(body.safety);
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
