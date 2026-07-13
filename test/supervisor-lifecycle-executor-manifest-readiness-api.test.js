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
  deviceId: 'executor-manifest-readiness-api',
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
  ]) {
    assert.ok(!text.includes(disallowed), `response leaked ${disallowed}`);
  }
  assert.doesNotMatch(text, /\beval\b/i);
  assert.doesNotMatch(text, /EEXIST|ENOTDIR|EACCES|ENOENT|SyntaxError/i);
  if (dataDir) {
    assert.ok(!text.includes(dataDir), 'response must not include dataDir path');
  }
}

describe('Supervisor lifecycle executor manifest readiness API', () => {
  it('keeps executor manifest readiness outside API write routes', () => {
    assert.strictEqual(API_WRITE_ROUTES.length, 6);
    assert.strictEqual(isApiWriteRoute('POST', '/api/supervisor-lifecycle-executor-manifest-readiness'), false);
    assert.strictEqual(API_WRITE_ROUTES.some((route) => (
      route.method === 'POST' && route.path === '/api/supervisor-lifecycle-executor-manifest-readiness'
    )), false);
  });

  it('returns blocked manifest readiness for a valid inline manifest without creating approval storage', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-executor-manifest-readiness-api-valid-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, '/api/supervisor-lifecycle-executor-manifest-readiness', {
          operation: 'install',
          config: BASE_CONFIG,
          manifest: validInstallManifest(),
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.command, 'supervisor-lifecycle-executor-manifest-readiness');
        assert.strictEqual(body.operation, 'install');
        assert.strictEqual(body.state, 'blocked');
        assert.strictEqual(body.manifestState, 'ready');
        assert.strictEqual(body.manifestReady, true);
        assert.strictEqual(body.executorReady, false);
        assert.deepStrictEqual(body.manifestBlockers, []);
        assert.deepStrictEqual(body.blockers, ['guarded-executor-runner-missing']);
        assert.deepStrictEqual(body.nextBlockers, ['guarded-executor-runner-missing']);
        assert.ok(body.actionManifests.every((entry) => entry.wouldRun === false && entry.wouldWrite === false));
        assert.strictEqual(body.safety.readOnly, true);
        assert.strictEqual(body.safety.lifecycleApplied, false);
        assert.strictEqual(body.safety.launchctlCalled, false);
        await assert.rejects(() => readdir(join(dataDir, 'approvals')), /ENOENT/);
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('allows read token to call executor manifest readiness because the endpoint is read-only', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-executor-manifest-readiness-api-read-token-'));
    try {
      await withServer({ dataDir, readToken: 'read-token', writeToken: 'write-token' }, async (port) => {
        const { res, body } = await postJSON(port, '/api/supervisor-lifecycle-executor-manifest-readiness', {
          operation: 'install',
          config: BASE_CONFIG,
          manifest: validInstallManifest(),
        }, { Authorization: 'Bearer read-token' });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.command, 'supervisor-lifecycle-executor-manifest-readiness');
        assert.strictEqual(body.state, 'blocked');
        assert.strictEqual(body.manifestReady, true);
        assert.strictEqual(body.executorReady, false);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('redacts unsafe inline manifest values from blocked output', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-executor-manifest-readiness-api-unsafe-'));
    try {
      const manifest = validInstallManifest();
      manifest.actions[0].secretValue = 'token=SECRET_XYZ';
      manifest.actions[1].implementationId = '/usr/bin/eval';

      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, '/api/supervisor-lifecycle-executor-manifest-readiness', {
          operation: 'install',
          config: BASE_CONFIG,
          manifest,
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.state, 'blocked');
        assert.strictEqual(body.manifestReady, false);
        assert.ok(body.manifestBlockers.includes('secret-reference'));
        assert.strictEqual(body.actionManifests[1].implementationId, '[redacted]');
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('handles a missing inline manifest as blocked readiness without throwing', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-executor-manifest-readiness-api-missing-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, '/api/supervisor-lifecycle-executor-manifest-readiness', {
          operation: 'install',
          config: BASE_CONFIG,
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.state, 'blocked');
        assert.strictEqual(body.manifestReady, false);
        assert.ok(body.manifestBlockers.includes('executor-manifest-missing-for-action:render-launch-agent-plist'));
        assert.ok(body.manifestBlockers.includes('executor-manifest-missing-for-action:write-launch-agent-plist'));
        assert.ok(body.manifestBlockers.includes('executor-manifest-missing-for-action:load-launch-agent'));
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects invalid operation and config without echoing submitted values', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-executor-manifest-readiness-api-invalid-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const invalidOperation = await postJSON(port, '/api/supervisor-lifecycle-executor-manifest-readiness', {
          operation: 'install /tmp/SECRET_XYZ',
          config: { token: 'SECRET_XYZ', deviceId: 'missing-server-url', backupJobs: BASE_CONFIG.backupJobs },
          manifest: validInstallManifest(),
        });

        assert.strictEqual(invalidOperation.res.status, 400);
        assert.deepStrictEqual(invalidOperation.body, { error: 'operation must be one of: install, uninstall, rollback, recover' });
        assertNoSensitiveText(invalidOperation.text, dataDir);

        const invalidConfig = await postJSON(port, '/api/supervisor-lifecycle-executor-manifest-readiness', {
          operation: 'install',
          config: { token: 'SECRET_XYZ', deviceId: 'missing-server-url', backupJobs: BASE_CONFIG.backupJobs },
          manifest: validInstallManifest(),
        });

        assert.strictEqual(invalidConfig.res.status, 400);
        assert.deepStrictEqual(invalidConfig.body, {
          error: 'supervisor-lifecycle-executor-manifest-readiness failed; verify config is a readable valid Linke config',
        });
        assertNoSensitiveText(invalidConfig.text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('ignores submitted approval and dataDir fields without leaking metadata', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-executor-manifest-readiness-api-ignore-extra-'));
    try {
      await withServer({ dataDir }, async (port) => {
        const { res, text, body } = await postJSON(port, '/api/supervisor-lifecycle-executor-manifest-readiness', {
          operation: 'install',
          config: BASE_CONFIG,
          manifest: validInstallManifest(),
          dataDir: '/tmp/SECRET_XYZ',
          approval: {
            approvedBy: 'operator@example.invalid',
            reason: 'do not leak submitted approval reason',
            acknowledgements: ['do not leak submitted approval acknowledgement'],
          },
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(body.state, 'blocked');
        assert.strictEqual(body.manifestReady, true);
        assertNoSensitiveText(text, dataDir);
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
