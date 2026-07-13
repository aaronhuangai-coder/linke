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
  deviceId: 'guarded-runner-readiness-api',
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

describe('Supervisor lifecycle guarded runner readiness API', () => {
  it('keeps guarded runner readiness outside API write routes', () => {
    assert.strictEqual(API_WRITE_ROUTES.length, 6);
    assert.strictEqual(isApiWriteRoute('POST', '/api/supervisor-lifecycle-guarded-runner-readiness'), false);
    assert.strictEqual(API_WRITE_ROUTES.some((route) => (
      route.method === 'POST' && route.path === '/api/supervisor-lifecycle-guarded-runner-readiness'
    )), false);
  });

  it('returns blocked guarded runner readiness for valid inline binding without creating approval storage', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-readiness-api-valid-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, '/api/supervisor-lifecycle-guarded-runner-readiness', {
          operation: 'install',
          config: BASE_CONFIG,
          manifest: validInstallManifest(),
          runnerBinding: validRunnerBinding(),
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.command, 'supervisor-lifecycle-guarded-runner-readiness');
        assert.strictEqual(body.operation, 'install');
        assert.strictEqual(body.state, 'blocked');
        assert.strictEqual(body.runnerBindingState, 'ready');
        assert.strictEqual(body.runnerBindingsReady, true);
        assert.strictEqual(body.executorReady, false);
        assert.deepStrictEqual(body.runnerBlockers, []);
        assert.deepStrictEqual(body.blockers, ['guarded-runner-execution-disabled']);
        assert.deepStrictEqual(body.nextBlockers, ['guarded-runner-execution-disabled']);
        assert.strictEqual(body.runnerBindings.length, 3);
        assert.ok(body.runnerBindings.every((entry) => entry.wouldRun === false && entry.wouldWrite === false));
        assert.strictEqual(body.safety.readOnly, true);
        assert.strictEqual(body.safety.lifecycleApplied, false);
        assert.strictEqual(body.safety.launchctlCalled, false);
        assert.strictEqual(body.safety.filesystemWritten, false);
        await assert.rejects(() => readdir(join(dataDir, 'approvals')), /ENOENT/);
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('allows read token to call guarded runner readiness because the endpoint is read-only', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-readiness-api-read-token-'));
    try {
      await withServer({ dataDir, readToken: 'read-token', writeToken: 'write-token' }, async (port) => {
        const { res, body } = await postJSON(port, '/api/supervisor-lifecycle-guarded-runner-readiness', {
          operation: 'install',
          config: BASE_CONFIG,
          manifest: validInstallManifest(),
          runnerBinding: validRunnerBinding(),
        }, { Authorization: 'Bearer read-token' });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.command, 'supervisor-lifecycle-guarded-runner-readiness');
        assert.strictEqual(body.state, 'blocked');
        assert.strictEqual(body.runnerBindingsReady, true);
        assert.strictEqual(body.executorReady, false);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('redacts unsafe inline runner binding values from blocked output', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-readiness-api-unsafe-'));
    try {
      const runnerBinding = validRunnerBinding();
      runnerBinding.bindings[0].runnerKind = '/usr/bin/eval token=SECRET_XYZ';

      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, '/api/supervisor-lifecycle-guarded-runner-readiness', {
          operation: 'install',
          config: BASE_CONFIG,
          manifest: validInstallManifest(),
          runnerBinding,
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.state, 'blocked');
        assert.strictEqual(body.runnerBindingsReady, false);
        assert.ok(body.runnerBlockers.includes('secret-reference'));
        assert.strictEqual(body.runnerBindings[0].runnerKind, '[redacted]');
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('handles missing inline runner binding as blocked readiness without throwing', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-readiness-api-missing-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, '/api/supervisor-lifecycle-guarded-runner-readiness', {
          operation: 'install',
          config: BASE_CONFIG,
          manifest: validInstallManifest(),
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.state, 'blocked');
        assert.strictEqual(body.runnerBindingsReady, false);
        assert.ok(body.runnerBlockers.includes('guarded-runner-binding-invalid-bindings'));
        assert.ok(body.blockers.includes('guarded-runner-execution-disabled'));
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects invalid operation and config without echoing submitted values', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-readiness-api-invalid-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const invalidOperation = await postJSON(port, '/api/supervisor-lifecycle-guarded-runner-readiness', {
          operation: 'install /tmp/SECRET_XYZ',
          config: { token: 'SECRET_XYZ', deviceId: 'missing-server-url', backupJobs: BASE_CONFIG.backupJobs },
          manifest: validInstallManifest(),
          runnerBinding: validRunnerBinding(),
        });

        assert.strictEqual(invalidOperation.res.status, 400);
        assert.deepStrictEqual(invalidOperation.body, { error: 'operation must be one of: install, uninstall, rollback, recover' });
        assertNoSensitiveText(invalidOperation.text, dataDir);

        const invalidConfig = await postJSON(port, '/api/supervisor-lifecycle-guarded-runner-readiness', {
          operation: 'install',
          config: { token: 'SECRET_XYZ', deviceId: 'missing-server-url', backupJobs: BASE_CONFIG.backupJobs },
          manifest: validInstallManifest(),
          runnerBinding: validRunnerBinding(),
        });

        assert.strictEqual(invalidConfig.res.status, 400);
        assert.deepStrictEqual(invalidConfig.body, {
          error: 'supervisor-lifecycle-guarded-runner-readiness failed; verify config is a readable valid Linke config',
        });
        assertNoSensitiveText(invalidConfig.text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('ignores submitted approval, dataDir, apply, output, and path-like fields without leaking metadata', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-guarded-runner-readiness-api-ignore-extra-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, '/api/supervisor-lifecycle-guarded-runner-readiness', {
          operation: 'install',
          config: BASE_CONFIG,
          manifest: validInstallManifest(),
          runnerBinding: validRunnerBinding(),
          apply: true,
          output: '/tmp/SECRET_XYZ',
          dataDir: '/tmp/SECRET_XYZ',
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
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
