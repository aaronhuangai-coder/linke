import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateNasTarget,
  buildNasDryRunPlan,
  runNasDryRunFromConfig,
  buildNasAppAdapterDryRunPlan,
} from '../src/nas.js';

// ── validateNasTarget ──────────────────────────────────────────────

describe('validateNasTarget', () => {
  it('accepts a valid synology target', () => {
    const target = {
      name: 'my-synology',
      provider: 'synology',
      endpoint: 'http://192.168.1.100:5000',
      shareName: 'backup',
      remotePath: '/volume1/backup',
      enabled: true,
    };
    const result = validateNasTarget(target);
    assert.strictEqual(result.name, 'my-synology');
    assert.strictEqual(result.provider, 'synology');
    assert.strictEqual(result.endpoint, 'http://192.168.1.100:5000');
    assert.strictEqual(result.shareName, 'backup');
    assert.strictEqual(result.remotePath, '/volume1/backup');
    assert.strictEqual(result.enabled, true);
  });

  it('normalizes mountedShare by reusing the shared configuration boundary', () => {
    const result = validateNasTarget({
      name: 'mounted-synology',
      provider: 'synology',
      endpoint: 'https://nas.example.invalid',
      shareName: 'backup',
      remotePath: '/provider-owned/path',
      mountedShare: {
        enabled: false,
        mountPath: '/Volumes/LinkeBackup',
        relativeRoot: 'linke/main',
      },
    });

    assert.deepStrictEqual(result.mountedShare, {
      enabled: false,
      mountPath: '/Volumes/LinkeBackup',
      relativeRoot: 'linke/main',
    });
  });

  it('rejects unsafe mountedShare input through validateNasTarget', () => {
    assert.throws(
      () => validateNasTarget({
        name: 'mounted-synology',
        provider: 'synology',
        endpoint: 'https://nas.example.invalid',
        shareName: 'backup',
        remotePath: '/provider-owned/path',
        mountedShare: {
          enabled: true,
          mountPath: '/Volumes/LinkeBackup',
          relativeRoot: '../escape',
        },
      }),
      /mountedShare/i,
    );
  });

  it('accepts a valid ugreen target', () => {
    const target = {
      name: 'my-ugreen',
      provider: 'ugreen',
      endpoint: 'https://192.168.1.200',
      shareName: 'data',
      remotePath: '/shares/data',
      enabled: false,
    };
    const result = validateNasTarget(target);
    assert.strictEqual(result.provider, 'ugreen');
    assert.strictEqual(result.enabled, false);
  });

  it('rejects an unknown provider', () => {
    assert.throws(
      () =>
        validateNasTarget({
          name: 'bad',
          provider: 'qnap',
          endpoint: 'http://192.168.1.1',
          shareName: 's',
          remotePath: '/r',
          enabled: true,
        }),
      /provider/,
    );
  });

  it('rejects a non-http endpoint', () => {
    assert.throws(
      () =>
        validateNasTarget({
          name: 'bad',
          provider: 'synology',
          endpoint: 'ftp://192.168.1.1',
          shareName: 's',
          remotePath: '/r',
          enabled: true,
        }),
      /endpoint/,
    );
  });

  it('rejects a garbage endpoint', () => {
    assert.throws(
      () =>
        validateNasTarget({
          name: 'bad',
          provider: 'synology',
          endpoint: 'not-a-url',
          shareName: 's',
          remotePath: '/r',
          enabled: true,
        }),
      /endpoint/,
    );
  });

  it('rejects missing name', () => {
    assert.throws(
      () =>
        validateNasTarget({
          provider: 'synology',
          endpoint: 'http://192.168.1.1',
          shareName: 's',
          remotePath: '/r',
          enabled: true,
        }),
      /name/,
    );
  });

  it('rejects missing shareName', () => {
    assert.throws(
      () =>
        validateNasTarget({
          name: 'x',
          provider: 'synology',
          endpoint: 'http://192.168.1.1',
          remotePath: '/r',
          enabled: true,
        }),
      /shareName/,
    );
  });

  it('rejects missing remotePath', () => {
    assert.throws(
      () =>
        validateNasTarget({
          name: 'x',
          provider: 'synology',
          endpoint: 'http://192.168.1.1',
          shareName: 's',
          enabled: true,
        }),
      /remotePath/,
    );
  });

  it('defaults enabled to true when omitted', () => {
    const result = validateNasTarget({
      name: 'x',
      provider: 'synology',
      endpoint: 'http://192.168.1.1',
      shareName: 's',
      remotePath: '/r',
    });
    assert.strictEqual(result.enabled, true);
  });

  // ── credential rejection ──────────────────────────────────────

  const CREDENTIAL_FIELDS = [
    'username', 'password', 'token', 'apiKey', 'secret', 'accessKey', 'refreshToken',
    'privateKey', 'clientSecret', 'connectionString', 'accessToken', 'idToken',
    'secretKey', 'sshKey', 'passphrase',
  ];

  for (const field of CREDENTIAL_FIELDS) {
    it(`rejects nasTarget containing credential field "${field}"`, () => {
      assert.throws(
        () =>
          validateNasTarget({
            name: 'x',
            provider: 'synology',
            endpoint: 'http://192.168.1.1',
            shareName: 's',
            remotePath: '/r',
            enabled: true,
            [field]: 'some-value',
          }),
        /credential|forbidden|not allowed/i,
      );
    });
  }

  it('accepts near credential-like field names without substring rejection in nasTarget and appAdapter', () => {
    const result = validateNasTarget({
      name: 'syno',
      provider: 'synology',
      endpoint: 'http://192.168.1.100:5000',
      shareName: 'backup',
      remotePath: '/volume1/backup',
      enabled: true,
      secretKeyName: 'primary-signing-key',
      tokenCount: 2,
      connectionStringLabel: 'primary-nas',
      appAdapter: {
        appId: 'synology-backup',
        secretKeyName: 'adapter-key-label',
        tokenCount: 2,
      },
    });

    assert.strictEqual(result.name, 'syno');
    assert.deepStrictEqual(result.appAdapter, {
      appId: 'synology-backup',
      operation: 'backup-plan',
    });
  });

  it('rejects endpoint URL containing userinfo (user:pass@host)', () => {
    assert.throws(
      () =>
        validateNasTarget({
          name: 'x',
          provider: 'synology',
          endpoint: 'http://admin:secret@192.168.1.1:5000',
          shareName: 's',
          remotePath: '/r',
          enabled: true,
        }),
      /credential|userinfo|user.*pass|not allowed|forbidden/i,
    );
  });

  it('rejects endpoint URL containing only username (no password)', () => {
    assert.throws(
      () =>
        validateNasTarget({
          name: 'x',
          provider: 'synology',
          endpoint: 'http://admin@192.168.1.1:5000',
          shareName: 's',
          remotePath: '/r',
          enabled: true,
        }),
      /credential|userinfo|user.*pass|not allowed|forbidden/i,
    );
  });

  // ── credentialRef 校验 ─────────────────────────────────────────

  it('accepts valid credentialRef "home-synology"', () => {
    const result = validateNasTarget({
      name: 'syno',
      provider: 'synology',
      endpoint: 'http://192.168.1.100:5000',
      shareName: 'backup',
      remotePath: '/volume1/backup',
      enabled: true,
      credentialRef: 'home-synology',
    });
    assert.strictEqual(result.credentialRef, 'home-synology');
  });

  it('accepts valid credentialRef "nas-01"', () => {
    const result = validateNasTarget({
      name: 'syno',
      provider: 'synology',
      endpoint: 'http://192.168.1.100:5000',
      shareName: 'backup',
      remotePath: '/volume1/backup',
      enabled: true,
      credentialRef: 'nas-01',
    });
    assert.strictEqual(result.credentialRef, 'nas-01');
  });

  const INVALID_REFS = [
    '',
    '   ',
    'home synology',
    'home-synology ',
    ' home-synology',
    'Home-synology',
    'home-Synology',
    'NAS-01',
    '../escape',
    'home/synology',
    'home.synology',
    'home@synology',
    'home$synology',
    'a'.repeat(32),
    '1nas',
    '01-nas',
    '9-synology',
  ];

  for (const ref of INVALID_REFS) {
    it(`rejects invalid credentialRef "${ref}"`, () => {
      assert.throws(
        () =>
          validateNasTarget({
            name: 'syno',
            provider: 'synology',
            endpoint: 'http://192.168.1.100:5000',
            shareName: 'backup',
            remotePath: '/volume1/backup',
            enabled: true,
            credentialRef: ref,
          }),
        /credentialRef/i,
      );
    });
  }

  it('rejects co-existence of credentialRef and forbidden credential fields (like password)', () => {
    assert.throws(
      () =>
        validateNasTarget({
          name: 'syno',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          enabled: true,
          credentialRef: 'home-synology',
          password: 'some-password',
        }),
      /credentialRef|credential|forbidden|password/i,
    );
  });

  it('rejects co-existence of credentialRef and new forbidden credential fields (like passphrase)', () => {
    assert.throws(
      () =>
        validateNasTarget({
          name: 'syno',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          enabled: true,
          credentialRef: 'home-synology',
          passphrase: 'some-passphrase',
        }),
      /credentialRef|credential|forbidden|passphrase/i,
    );
  });

  // ── appAdapter validation ─────────────────────────────────────

  it('accepts a valid synology appAdapter', () => {
    const result = validateNasTarget({
      name: 'syno',
      provider: 'synology',
      endpoint: 'http://192.168.1.100:5000',
      shareName: 'backup',
      remotePath: '/volume1/backup',
      appAdapter: {
        appId: 'synology-backup',
        operation: 'backup-plan',
      },
    });

    assert.deepStrictEqual(result.appAdapter, {
      appId: 'synology-backup',
      operation: 'backup-plan',
    });
  });

  it('accepts a valid ugreen appAdapter and defaults operation', () => {
    const result = validateNasTarget({
      name: 'ugreen',
      provider: 'ugreen',
      endpoint: 'https://192.168.1.200',
      shareName: 'data',
      remotePath: '/shares/data',
      appAdapter: {
        appId: 'ugreen-files',
      },
    });

    assert.deepStrictEqual(result.appAdapter, {
      appId: 'ugreen-files',
      operation: 'backup-plan',
    });
  });

  it('rejects appAdapter missing appId', () => {
    assert.throws(
      () =>
        validateNasTarget({
          name: 'syno',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          appAdapter: {
            operation: 'backup-plan',
          },
        }),
      /appAdapter\.appId/,
    );
  });

  it('rejects unknown appAdapter appId', () => {
    assert.throws(
      () =>
        validateNasTarget({
          name: 'syno',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          appAdapter: {
            appId: 'qnap-backup',
          },
        }),
      /appAdapter\.appId|unsupported/i,
    );
  });

  it('rejects provider/appAdapter mismatch', () => {
    assert.throws(
      () =>
        validateNasTarget({
          name: 'syno',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          appAdapter: {
            appId: 'ugreen-backup',
          },
        }),
      /provider|mismatch|appAdapter/i,
    );
  });

  for (const field of CREDENTIAL_FIELDS) {
    it(`rejects credential-like field "${field}" inside appAdapter`, () => {
      assert.throws(
        () =>
          validateNasTarget({
            name: 'syno',
            provider: 'synology',
            endpoint: 'http://192.168.1.100:5000',
            shareName: 'backup',
            remotePath: '/volume1/backup',
            appAdapter: {
              appId: 'synology-backup',
              [field]: 'do-not-accept',
            },
          }),
        /credential|not allowed|forbidden/i,
      );
    });
  }
});

// ── buildNasDryRunPlan ─────────────────────────────────────────────

describe('buildNasDryRunPlan', () => {
  it('produces a plan with mode=dry-run, wouldConnect=false, wouldWrite=false', () => {
    const config = {
      deviceId: 'test-device',
      nasTargets: [
        {
          name: 'syno1',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          enabled: true,
        },
        {
          name: 'ugreen1',
          provider: 'ugreen',
          endpoint: 'https://192.168.1.200',
          shareName: 'data',
          remotePath: '/shares/data',
          enabled: false,
        },
      ],
      backupJobs: [{ name: 'job1', sourcePath: '/tmp/src' }],
    };
    const plan = buildNasDryRunPlan(config);

    assert.strictEqual(plan.mode, 'dry-run');
    assert.strictEqual(plan.deviceId, 'test-device');
    assert.strictEqual(plan.wouldConnect, false);
    assert.strictEqual(plan.wouldWrite, false);
    assert.ok(Array.isArray(plan.targets));
    assert.strictEqual(plan.targets.length, 2);

    // Check first target
    assert.strictEqual(plan.targets[0].provider, 'synology');
    assert.strictEqual(plan.targets[0].name, 'syno1');
    assert.strictEqual(plan.targets[0].endpoint, 'http://192.168.1.100:5000');
    assert.strictEqual(plan.targets[0].shareName, 'backup');
    assert.strictEqual(plan.targets[0].remotePath, '/volume1/backup');
    assert.strictEqual(plan.targets[0].enabled, true);

    // Check second target
    assert.strictEqual(plan.targets[1].provider, 'ugreen');
    assert.strictEqual(plan.targets[1].enabled, false);

    // Jobs should be listed
    assert.ok(Array.isArray(plan.jobs));
    assert.strictEqual(plan.jobs.length, 1);
    assert.strictEqual(plan.jobs[0].name, 'job1');
  });

  it('exposes only mountedShare configured flags without leaking either path', () => {
    const plan = buildNasDryRunPlan({
      deviceId: 'mounted-share-device',
      nasTargets: [
        {
          name: 'mounted-synology',
          provider: 'synology',
          endpoint: 'https://nas.example.invalid',
          shareName: 'backup',
          remotePath: '/provider-owned/path',
          enabled: true,
          mountedShare: {
            enabled: false,
            mountPath: '/Volumes/LinkeBackup',
            relativeRoot: 'linke/main',
          },
        },
      ],
      backupJobs: [{ name: 'documents', sourcePath: '/tmp/documents' }],
    });

    const target = plan.targets[0];
    const serialized = JSON.stringify(plan);
    assert.strictEqual(target.mountedShareConfigured, true);
    assert.strictEqual(target.mountedShareEnabled, false);
    assert.strictEqual(target.mountedShare, undefined);
    assert.strictEqual(target.mountPath, undefined);
    assert.strictEqual(target.relativeRoot, undefined);
    assert.ok(!serialized.includes('/Volumes/LinkeBackup'));
    assert.ok(!serialized.includes('linke/main'));
    assert.ok(!serialized.includes('mountPath'));
    assert.ok(!serialized.includes('relativeRoot'));
  });

  it('handles empty nasTargets gracefully', () => {
    const config = {
      deviceId: 'dev',
      nasTargets: [],
      backupJobs: [{ name: 'j', sourcePath: '/s' }],
    };
    const plan = buildNasDryRunPlan(config);
    assert.strictEqual(plan.targets.length, 0);
    assert.strictEqual(plan.mode, 'dry-run');
    assert.strictEqual(plan.wouldConnect, false);
    assert.strictEqual(plan.wouldWrite, false);
  });

  it('handles missing nasTargets as empty array', () => {
    const config = {
      deviceId: 'dev',
      backupJobs: [{ name: 'j', sourcePath: '/s' }],
    };
    const plan = buildNasDryRunPlan(config);
    assert.strictEqual(plan.targets.length, 0);
  });

  it('includes adapterPlan with dry-run flags for appAdapter targets', () => {
    const plan = buildNasDryRunPlan({
      deviceId: 'dev',
      nasTargets: [
        {
          name: 'syno',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          appAdapter: {
            appId: 'synology-backup',
            operation: 'backup-plan',
          },
        },
      ],
      backupJobs: [{ name: 'docs', sourcePath: '/Users/ah/Documents' }],
    });

    assert.strictEqual(plan.targets[0].adapterPlan.mode, 'dry-run');
    assert.strictEqual(plan.targets[0].adapterPlan.appId, 'synology-backup');
    assert.strictEqual(plan.targets[0].adapterPlan.operation, 'backup-plan');
    assert.strictEqual(plan.targets[0].adapterPlan.wouldInvokeApp, false);
    assert.strictEqual(plan.targets[0].adapterPlan.wouldConnect, false);
    assert.strictEqual(plan.targets[0].adapterPlan.wouldWrite, false);
    assert.deepStrictEqual(plan.targets[0].adapterPlan.steps, [
      'validate-target',
      'prepare-app-request',
      'map-backup-jobs',
      'preview-remote-destination',
    ]);
  });

  it('sets adapterPlan to null when appAdapter is omitted', () => {
    const plan = buildNasDryRunPlan({
      deviceId: 'dev',
      nasTargets: [
        {
          name: 'syno',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
        },
      ],
      backupJobs: [{ name: 'docs', sourcePath: '/Users/ah/Documents' }],
    });

    assert.strictEqual(plan.targets[0].adapterPlan, null);
  });

  // ── dry-run plan 中的 credentialRef 与 executionGate ───────────

  it('sets credentialRefConfigured to true when valid credentialRef is provided, but omits raw credentialRef from the plan and JSON serialization', () => {
    const config = {
      deviceId: 'test-device',
      nasTargets: [
        {
          name: 'syno',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          enabled: true,
          credentialRef: 'home-synology',
        },
      ],
      backupJobs: [{ name: 'job1', sourcePath: '/tmp/src' }],
    };
    const plan = buildNasDryRunPlan(config);

    assert.strictEqual(plan.targets[0].credentialRefConfigured, true);
    assert.strictEqual(plan.targets[0].credentialRef, undefined);
    assert.strictEqual(JSON.stringify(plan).includes('home-synology'), false);

    const jsonPlan = JSON.parse(JSON.stringify(plan));
    assert.strictEqual(jsonPlan.targets[0].credentialRefConfigured, true);
    assert.strictEqual(jsonPlan.targets[0].credentialRef, undefined);
    assert.strictEqual(JSON.stringify(jsonPlan).includes('home-synology'), false);
  });

  it('sets credentialRefConfigured to false when credentialRef is not provided', () => {
    const config = {
      deviceId: 'test-device',
      nasTargets: [
        {
          name: 'syno',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          enabled: true,
        },
      ],
      backupJobs: [{ name: 'job1', sourcePath: '/tmp/src' }],
    };
    const plan = buildNasDryRunPlan(config);

    assert.strictEqual(plan.targets[0].credentialRefConfigured, false);
    assert.strictEqual(plan.targets[0].credentialRef, undefined);

    const jsonPlan = JSON.parse(JSON.stringify(plan));
    assert.strictEqual(jsonPlan.targets[0].credentialRefConfigured, false);
    assert.strictEqual(jsonPlan.targets[0].credentialRef, undefined);
  });

  it('always returns top-level executionGate with remoteExecutionAllowed false and non-empty blockingReason', () => {
    const config = {
      deviceId: 'test-device',
      nasTargets: [
        {
          name: 'syno',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          enabled: true,
          credentialRef: 'home-synology',
        },
      ],
      backupJobs: [{ name: 'job1', sourcePath: '/tmp/src' }],
    };
    const plan = buildNasDryRunPlan(config);
    assert.ok(plan.executionGate);
    assert.strictEqual(plan.executionGate.remoteExecutionAllowed, false);
    assert.ok(typeof plan.executionGate.blockingReason === 'string');
    assert.ok(plan.executionGate.blockingReason.length > 0);
  });

  it('cannot override remoteExecutionAllowed with input executionGate: true', () => {
    const config = {
      deviceId: 'test-device',
      executionGate: true,
      nasTargets: [
        {
          name: 'syno',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          enabled: true,
          credentialRef: 'home-synology',
        },
      ],
      backupJobs: [{ name: 'job1', sourcePath: '/tmp/src' }],
    };
    const plan = buildNasDryRunPlan(config);
    assert.ok(plan.executionGate);
    assert.strictEqual(plan.executionGate.remoteExecutionAllowed, false);
    assert.ok(typeof plan.executionGate.blockingReason === 'string');
    assert.ok(plan.executionGate.blockingReason.length > 0);
  });

  it('includes top-level readinessSummary counts and blockers', () => {
    const config = {
      deviceId: 'test-device',
      nasTargets: [
        {
          name: 'target1',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          enabled: true,
          credentialRef: 'home-synology',
        },
        {
          name: 'target2',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          enabled: true,
        },
        {
          name: 'target3',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          enabled: false,
        },
      ],
      backupJobs: [{ name: 'job1', sourcePath: '/tmp/src' }],
    };

    const plan = buildNasDryRunPlan(config);
    assert.ok(plan.readinessSummary);
    assert.strictEqual(plan.readinessSummary.mode, 'dry-run');
    assert.strictEqual(plan.readinessSummary.state, 'blocked');
    assert.strictEqual(plan.readinessSummary.totalTargets, 3);
    assert.strictEqual(plan.readinessSummary.enabledTargets, 2);
    assert.strictEqual(plan.readinessSummary.disabledTargets, 1);
    assert.strictEqual(plan.readinessSummary.credentialRefConfiguredTargets, 1);
    assert.strictEqual(plan.readinessSummary.enabledCredentialRefMissingTargets, 1);
    assert.strictEqual(plan.readinessSummary.blockedTargets, 3);
    assert.strictEqual(plan.readinessSummary.remoteExecutionBlocked, true);

    const blockers = plan.readinessSummary.blockers || [];
    assert.ok(blockers.includes('remote-execution-blocked'));
    assert.ok(blockers.includes('credential-ref-missing'));
    assert.ok(blockers.includes('target-disabled'));
    assert.strictEqual(blockers.length, 3);
  });

  it('determines per-target executionReadiness blockers', () => {
    const config = {
      deviceId: 'test-device',
      nasTargets: [
        {
          name: 'enabled-missing-cred',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          enabled: true,
        },
        {
          name: 'enabled-configured-cred',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          enabled: true,
          credentialRef: 'home-synology',
        },
        {
          name: 'disabled-target',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          enabled: false,
        },
      ],
    };

    const plan = buildNasDryRunPlan(config);
    const target1 = plan.targets.find(t => t.name === 'enabled-missing-cred');
    const target2 = plan.targets.find(t => t.name === 'enabled-configured-cred');
    const target3 = plan.targets.find(t => t.name === 'disabled-target');

    assert.ok(target1.executionReadiness);
    assert.strictEqual(target1.executionReadiness.state, 'blocked');
    assert.deepStrictEqual(target1.executionReadiness.blockers, ['credential-ref-missing', 'remote-execution-blocked']);

    assert.ok(target2.executionReadiness);
    assert.strictEqual(target2.executionReadiness.state, 'blocked');
    assert.deepStrictEqual(target2.executionReadiness.blockers, ['remote-execution-blocked']);

    assert.ok(target3.executionReadiness);
    assert.strictEqual(target3.executionReadiness.state, 'blocked');
    assert.deepStrictEqual(target3.executionReadiness.blockers, ['target-disabled', 'remote-execution-blocked']);
  });
});


// ── runNasDryRunFromConfig ─────────────────────────────────────────

describe('runNasDryRunFromConfig', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'linke-nas-dryrun-'));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('loads config from file and returns a dry-run plan', async () => {
    const configPath = join(tmpDir, 'nas-config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        serverUrl: 'http://localhost:3000',
        deviceId: 'nas-test-device',
        backupJobs: [{ name: 'docs', sourcePath: '/tmp/docs' }],
        nasTargets: [
          {
            name: 'home-syno',
            provider: 'synology',
            endpoint: 'http://10.0.0.50:5000',
            shareName: 'backups',
            remotePath: '/volume1/backups',
            enabled: true,
          },
        ],
      }),
    );

    const plan = await runNasDryRunFromConfig(configPath);

    assert.strictEqual(plan.mode, 'dry-run');
    assert.strictEqual(plan.deviceId, 'nas-test-device');
    assert.strictEqual(plan.wouldConnect, false);
    assert.strictEqual(plan.wouldWrite, false);
    assert.strictEqual(plan.targets.length, 1);
    assert.strictEqual(plan.targets[0].name, 'home-syno');
    assert.strictEqual(plan.targets[0].provider, 'synology');
  });

  it('does NOT make any network requests (dry-run guarantee)', async () => {
    const configPath = join(tmpDir, 'nas-no-net.json');
    await writeFile(
      configPath,
      JSON.stringify({
        serverUrl: 'http://localhost:3000',
        deviceId: 'no-net-device',
        backupJobs: [{ name: 'j', sourcePath: '/s' }],
        nasTargets: [
          {
            name: 'offline-nas',
            provider: 'ugreen',
            endpoint: 'http://192.168.99.99:8080',
            shareName: 'share',
            remotePath: '/data',
            enabled: true,
          },
        ],
      }),
    );

    // This should succeed without any network access
    const plan = await runNasDryRunFromConfig(configPath);
    assert.strictEqual(plan.wouldConnect, false);
    assert.strictEqual(plan.wouldWrite, false);
    assert.strictEqual(plan.mode, 'dry-run');
  });

  it('throws on invalid nasTarget in config', async () => {
    const configPath = join(tmpDir, 'nas-bad.json');
    await writeFile(
      configPath,
      JSON.stringify({
        serverUrl: 'http://localhost:3000',
        deviceId: 'bad-device',
        backupJobs: [{ name: 'j', sourcePath: '/s' }],
        nasTargets: [
          {
            name: 'bad',
            provider: 'qnap',
            endpoint: 'http://10.0.0.1',
            shareName: 's',
            remotePath: '/r',
            enabled: true,
          },
        ],
      }),
    );

    await assert.rejects(
      () => runNasDryRunFromConfig(configPath),
      /provider/,
    );
  });
});

// ── buildNasAppAdapterDryRunPlan ────────────────────────────────────

describe('buildNasAppAdapterDryRunPlan', () => {
  it('returns backup adapter steps for synology-backup', () => {
    const plan = buildNasAppAdapterDryRunPlan(
      {
        name: 'syno',
        provider: 'synology',
        appAdapter: {
          appId: 'synology-backup',
          operation: 'backup-plan',
        },
      },
      [{ name: 'docs', sourcePath: '/Users/ah/Documents' }],
    );

    assert.strictEqual(plan.mode, 'dry-run');
    assert.strictEqual(plan.provider, 'synology');
    assert.strictEqual(plan.appId, 'synology-backup');
    assert.strictEqual(plan.wouldInvokeApp, false);
    assert.deepStrictEqual(plan.steps, [
      'validate-target',
      'prepare-app-request',
      'map-backup-jobs',
      'preview-remote-destination',
    ]);
  });

  it('returns files adapter steps for ugreen-files', () => {
    const plan = buildNasAppAdapterDryRunPlan(
      {
        name: 'ugreen',
        provider: 'ugreen',
        appAdapter: {
          appId: 'ugreen-files',
          operation: 'browse-plan',
        },
      },
      [],
    );

    assert.deepStrictEqual(plan.steps, [
      'validate-target',
      'prepare-file-browser-request',
      'map-share-and-path',
      'preview-file-operation',
    ]);
  });

  it('returns null when target has no appAdapter', () => {
    assert.strictEqual(
      buildNasAppAdapterDryRunPlan({ name: 'plain', provider: 'synology' }, []),
      null,
    );
  });
});
