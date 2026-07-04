import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateNasTarget,
  buildNasDryRunPlan,
  runNasDryRunFromConfig,
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
