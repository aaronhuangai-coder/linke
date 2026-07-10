import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, hostname as osHostname } from 'node:os';
import {
  loadConfig,
  validateConfig,
  getDefaultIpAddress,
} from '../src/config.js';
import * as configModule from '../src/config.js';

function validMountedShareConfig(targetOverrides = {}) {
  return {
    serverUrl: 'http://localhost:3000',
    deviceId: 'mounted-smb-config',
    backupJobs: [{ name: 'documents', sourcePath: '/tmp/documents' }],
    nasTargets: [{
      name: 'primary-nas',
      provider: 'synology',
      endpoint: 'https://nas.example.invalid',
      shareName: 'backup',
      remotePath: '/provider-owned/path',
      enabled: true,
      ...targetOverrides,
    }],
  };
}

describe('Config module', () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'linke-config-'));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── loadConfig ───────────────────────────────────────────────

  it('loadConfig reads and parses a JSON file', async () => {
    const p = join(tmpDir, 'ok.json');
    await writeFile(p, JSON.stringify({ foo: 'bar' }));
    const cfg = await loadConfig(p);
    assert.deepStrictEqual(cfg, { foo: 'bar' });
  });

  // ── validateConfig — valid ──────────────────────────────────

  it('accepts a valid minimal config and applies defaults', () => {
    const cfg = validateConfig({
      serverUrl: 'http://localhost:3000',
      deviceId: 'test-device',
      backupJobs: [{ name: 'job1', sourcePath: '/tmp/src' }],
    });
    assert.strictEqual(cfg.serverUrl, 'http://localhost:3000');
    assert.strictEqual(cfg.deviceId, 'test-device');
    assert.strictEqual(cfg.backupJobs.length, 1);
    assert.strictEqual(cfg.hostname, osHostname());
    assert.ok(typeof cfg.ipAddress === 'string' && cfg.ipAddress.length > 0);
    assert.deepStrictEqual(cfg.excludePatterns, []);
    assert.strictEqual(cfg.scheduleSeconds, 3600);
    assert.strictEqual(cfg.launchdLabel, 'com.linke.agent.test-device');
  });

  // ── validateConfig — invalid ────────────────────────────────

  it('rejects non-http(s) serverUrl', () => {
    assert.throws(
      () => validateConfig({
        serverUrl: 'ftp://bad',
        deviceId: 'd',
        backupJobs: [{ name: 'j', sourcePath: '/s' }],
      }),
      /serverUrl/,
    );
  });

  it('rejects garbage serverUrl', () => {
    assert.throws(
      () => validateConfig({
        serverUrl: 'not-a-url',
        deviceId: 'd',
        backupJobs: [{ name: 'j', sourcePath: '/s' }],
      }),
      /serverUrl/,
    );
  });

  it('rejects empty backupJobs array', () => {
    assert.throws(
      () => validateConfig({
        serverUrl: 'http://localhost:3000',
        deviceId: 'd',
        backupJobs: [],
      }),
      /backupJobs/,
    );
  });

  it('rejects negative scheduleSeconds', () => {
    assert.throws(
      () => validateConfig({
        serverUrl: 'http://localhost:3000',
        deviceId: 'd',
        backupJobs: [{ name: 'j', sourcePath: '/s' }],
        scheduleSeconds: -1,
      }),
      /scheduleSeconds/,
    );
  });

  it('rejects zero scheduleSeconds', () => {
    assert.throws(
      () => validateConfig({
        serverUrl: 'http://localhost:3000',
        deviceId: 'd',
        backupJobs: [{ name: 'j', sourcePath: '/s' }],
        scheduleSeconds: 0,
      }),
      /scheduleSeconds/,
    );
  });

  it('rejects empty deviceId', () => {
    assert.throws(
      () => validateConfig({
        serverUrl: 'http://localhost:3000',
        deviceId: '',
        backupJobs: [{ name: 'j', sourcePath: '/s' }],
      }),
      /deviceId/,
    );
  });

  it('rejects backupJobs entry with empty name', () => {
    assert.throws(
      () => validateConfig({
        serverUrl: 'http://localhost:3000',
        deviceId: 'd',
        backupJobs: [{ name: '', sourcePath: '/s' }],
      }),
      /name/,
    );
  });

  it('rejects backupJobs entry with empty sourcePath', () => {
    assert.throws(
      () => validateConfig({
        serverUrl: 'http://localhost:3000',
        deviceId: 'd',
        backupJobs: [{ name: 'j', sourcePath: '' }],
      }),
      /sourcePath/,
    );
  });

  // ── defaults ────────────────────────────────────────────────

  it('defaults hostname to os.hostname()', () => {
    const cfg = validateConfig({
      serverUrl: 'http://localhost:3000',
      deviceId: 'd',
      backupJobs: [{ name: 'j', sourcePath: '/s' }],
    });
    assert.strictEqual(cfg.hostname, osHostname());
  });

  it('defaults ipAddress to a non-empty string', () => {
    const cfg = validateConfig({
      serverUrl: 'http://localhost:3000',
      deviceId: 'd',
      backupJobs: [{ name: 'j', sourcePath: '/s' }],
    });
    assert.ok(typeof cfg.ipAddress === 'string');
    assert.ok(cfg.ipAddress.length > 0);
  });

  it('defaults excludePatterns to []', () => {
    const cfg = validateConfig({
      serverUrl: 'http://localhost:3000',
      deviceId: 'd',
      backupJobs: [{ name: 'j', sourcePath: '/s' }],
    });
    assert.deepStrictEqual(cfg.excludePatterns, []);
  });

  // ── getDefaultIpAddress ─────────────────────────────────────

  it('getDefaultIpAddress returns a non-empty string', () => {
    const ip = getDefaultIpAddress();
    assert.ok(typeof ip === 'string');
    assert.ok(ip.length > 0);
  });

  // ── nasTargets ────────────────────────────────────────────────

  it('accepts config with valid nasTargets array', () => {
    const cfg = validateConfig({
      serverUrl: 'http://localhost:3000',
      deviceId: 'd',
      backupJobs: [{ name: 'j', sourcePath: '/s' }],
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
    });
    assert.ok(Array.isArray(cfg.nasTargets));
    assert.strictEqual(cfg.nasTargets.length, 1);
    assert.strictEqual(cfg.nasTargets[0].provider, 'synology');
  });

  it('accepts config with multiple nasTargets (synology + ugreen)', () => {
    const cfg = validateConfig({
      serverUrl: 'http://localhost:3000',
      deviceId: 'd',
      backupJobs: [{ name: 'j', sourcePath: '/s' }],
      nasTargets: [
        {
          name: 'syno',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          enabled: true,
        },
        {
          name: 'ugreen',
          provider: 'ugreen',
          endpoint: 'https://192.168.1.200',
          shareName: 'data',
          remotePath: '/shares/data',
          enabled: false,
        },
      ],
    });
    assert.strictEqual(cfg.nasTargets.length, 2);
    assert.strictEqual(cfg.nasTargets[0].provider, 'synology');
    assert.strictEqual(cfg.nasTargets[1].provider, 'ugreen');
  });

  it('rejects nasTargets with invalid provider', () => {
    assert.throws(
      () =>
        validateConfig({
          serverUrl: 'http://localhost:3000',
          deviceId: 'd',
          backupJobs: [{ name: 'j', sourcePath: '/s' }],
          nasTargets: [
            {
              name: 'bad',
              provider: 'qnap',
              endpoint: 'http://192.168.1.1',
              shareName: 's',
              remotePath: '/r',
              enabled: true,
            },
          ],
        }),
      /provider/,
    );
  });

  it('rejects nasTargets with non-http endpoint', () => {
    assert.throws(
      () =>
        validateConfig({
          serverUrl: 'http://localhost:3000',
          deviceId: 'd',
          backupJobs: [{ name: 'j', sourcePath: '/s' }],
          nasTargets: [
            {
              name: 'bad',
              provider: 'synology',
              endpoint: 'ftp://192.168.1.1',
              shareName: 's',
              remotePath: '/r',
              enabled: true,
            },
          ],
        }),
      /endpoint/,
    );
  });

  it('defaults nasTargets to empty array when not provided', () => {
    const cfg = validateConfig({
      serverUrl: 'http://localhost:3000',
      deviceId: 'd',
      backupJobs: [{ name: 'j', sourcePath: '/s' }],
    });
    assert.deepStrictEqual(cfg.nasTargets, []);
  });

  // ── nasTargets mountedShare ───────────────────────────────────

  it('accepts and normalizes a credential-free mountedShare', () => {
    const cfg = validateConfig(validMountedShareConfig({
      mountedShare: {
        enabled: true,
        mountPath: '/Volumes/LinkeBackup',
        relativeRoot: 'linke/main',
      },
    }));

    assert.deepStrictEqual(cfg.nasTargets[0].mountedShare, {
      enabled: true,
      mountPath: '/Volumes/LinkeBackup',
      relativeRoot: 'linke/main',
    });
  });

  it('preserves a disabled mountedShare and defaults enabled to true when omitted', () => {
    const disabled = validateConfig(validMountedShareConfig({
      mountedShare: {
        enabled: false,
        mountPath: '/Volumes/LinkeBackup',
        relativeRoot: 'linke/main',
      },
    }));
    const enabledByDefault = validateConfig(validMountedShareConfig({
      mountedShare: {
        mountPath: '/Volumes/LinkeBackup',
        relativeRoot: 'linke/main',
      },
    }));

    assert.strictEqual(disabled.nasTargets[0].mountedShare.enabled, false);
    assert.strictEqual(enabledByDefault.nasTargets[0].mountedShare.enabled, true);
    assert.strictEqual(typeof configModule.validateNasMountedShare, 'function');
    assert.strictEqual(configModule.validateNasMountedShare(undefined), null);
    assert.strictEqual(configModule.validateNasMountedShare(null), null);
  });

  const INVALID_MOUNTED_SHARES = [
    ['non-object', 'invalid'],
    ['array', []],
    ['non-boolean enabled', { enabled: 'yes', mountPath: '/Volumes/LinkeBackup', relativeRoot: 'linke' }],
    ['relative mountPath', { enabled: true, mountPath: 'Volumes/relative', relativeRoot: 'linke' }],
    ['mountPath control character', { enabled: true, mountPath: '/Volumes/Linke\nBackup', relativeRoot: 'linke' }],
    ['mountPath tab character', { enabled: true, mountPath: '/Volumes/Linke\tBackup', relativeRoot: 'linke' }],
    ['parent relativeRoot', { enabled: true, mountPath: '/Volumes/LinkeBackup', relativeRoot: '../escape' }],
    ['absolute relativeRoot', { enabled: true, mountPath: '/Volumes/LinkeBackup', relativeRoot: '/absolute' }],
    ['empty relativeRoot', { enabled: true, mountPath: '/Volumes/LinkeBackup', relativeRoot: '' }],
    ['empty relativeRoot segment', { enabled: true, mountPath: '/Volumes/LinkeBackup', relativeRoot: 'linke//main' }],
    ['dot relativeRoot segment', { enabled: true, mountPath: '/Volumes/LinkeBackup', relativeRoot: 'linke/./main' }],
    ['parent relativeRoot segment', { enabled: true, mountPath: '/Volumes/LinkeBackup', relativeRoot: 'linke/../main' }],
    ['backslash relativeRoot', { enabled: true, mountPath: '/Volumes/LinkeBackup', relativeRoot: 'linke\\main' }],
    ['relativeRoot control character', { enabled: true, mountPath: '/Volumes/LinkeBackup', relativeRoot: 'linke\rmain' }],
    ['relativeRoot unit-separator character', { enabled: true, mountPath: '/Volumes/LinkeBackup', relativeRoot: 'linke\u001fmain' }],
    ['unsupported field', { enabled: true, mountPath: '/Volumes/LinkeBackup', relativeRoot: 'linke', label: 'extra' }],
    ['credential field', { enabled: true, mountPath: '/Volumes/LinkeBackup', relativeRoot: 'linke', password: 'forbidden' }],
  ];

  for (const [label, mountedShare] of INVALID_MOUNTED_SHARES) {
    it(`rejects mountedShare with ${label}`, () => {
      assert.throws(
        () => validateConfig(validMountedShareConfig({ mountedShare })),
        /mountedShare|credential/i,
      );
    });
  }

  it('rejects appAdapter when null', () => {
    assert.throws(
      () =>
        validateConfig({
          serverUrl: 'http://localhost:3000',
          deviceId: 'd',
          backupJobs: [{ name: 'j', sourcePath: '/s' }],
          nasTargets: [
            {
              name: 'syno',
              provider: 'synology',
              endpoint: 'http://192.168.1.100:5000',
              shareName: 'backup',
              remotePath: '/volume1/backup',
              appAdapter: null,
            },
          ],
        }),
      /appAdapter must be an object/,
    );
  });

  it('rejects appAdapter when a string', () => {
    assert.throws(
      () =>
        validateConfig({
          serverUrl: 'http://localhost:3000',
          deviceId: 'd',
          backupJobs: [{ name: 'j', sourcePath: '/s' }],
          nasTargets: [
            {
              name: 'syno',
              provider: 'synology',
              endpoint: 'http://192.168.1.100:5000',
              shareName: 'backup',
              remotePath: '/volume1/backup',
              appAdapter: 'synology-files',
            },
          ],
        }),
      /appAdapter must be an object/,
    );
  });

  it('rejects appAdapter when a number', () => {
    assert.throws(
      () =>
        validateConfig({
          serverUrl: 'http://localhost:3000',
          deviceId: 'd',
          backupJobs: [{ name: 'j', sourcePath: '/s' }],
          nasTargets: [
            {
              name: 'syno',
              provider: 'synology',
              endpoint: 'http://192.168.1.100:5000',
              shareName: 'backup',
              remotePath: '/volume1/backup',
              appAdapter: 42,
            },
          ],
        }),
      /appAdapter must be an object/,
    );
  });

  it('rejects appAdapter when an array', () => {
    assert.throws(
      () =>
        validateConfig({
          serverUrl: 'http://localhost:3000',
          deviceId: 'd',
          backupJobs: [{ name: 'j', sourcePath: '/s' }],
          nasTargets: [
            {
              name: 'syno',
              provider: 'synology',
              endpoint: 'http://192.168.1.100:5000',
              shareName: 'backup',
              remotePath: '/volume1/backup',
              appAdapter: [{ appId: 'synology-files' }],
            },
          ],
        }),
      /appAdapter must be an object/,
    );
  });

  it('accepts nasTargets with valid appAdapter', () => {
    const cfg = validateConfig({
      serverUrl: 'http://localhost:3000',
      deviceId: 'dev',
      backupJobs: [{ name: 'docs', sourcePath: '/tmp/docs' }],
      nasTargets: [
        {
          name: 'syno',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          appAdapter: {
            appId: 'synology-files',
            operation: 'browse-plan',
          },
        },
      ],
    });

    assert.deepStrictEqual(cfg.nasTargets[0].appAdapter, {
      appId: 'synology-files',
      operation: 'browse-plan',
    });
  });

  // ── credential rejection in nasTargets ──────────────────────────

  const CREDENTIAL_FIELDS = [
    'username', 'password', 'token', 'apiKey', 'secret', 'accessKey', 'refreshToken',
    'privateKey', 'clientSecret', 'connectionString', 'accessToken', 'idToken',
    'secretKey', 'sshKey', 'passphrase',
  ];

  for (const field of CREDENTIAL_FIELDS) {
    it(`rejects nasTarget containing credential field "${field}"`, () => {
      assert.throws(
        () =>
          validateConfig({
            serverUrl: 'http://localhost:3000',
            deviceId: 'd',
            backupJobs: [{ name: 'j', sourcePath: '/s' }],
            nasTargets: [
              {
                name: 'bad',
                provider: 'synology',
                endpoint: 'http://192.168.1.1',
                shareName: 's',
                remotePath: '/r',
                enabled: true,
                [field]: 'some-value',
              },
            ],
          }),
        /credential|forbidden|not allowed/i,
      );
    });
  }

  it('accepts near credential-like field names without substring rejection in nasTargets and appAdapter', () => {
    const cfg = validateConfig({
      serverUrl: 'http://localhost:3000',
      deviceId: 'd',
      backupJobs: [{ name: 'j', sourcePath: '/s' }],
      nasTargets: [
        {
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
        },
      ],
    });

    assert.strictEqual(cfg.nasTargets[0].name, 'syno');
    assert.deepStrictEqual(cfg.nasTargets[0].appAdapter, {
      appId: 'synology-backup',
      operation: 'backup-plan',
    });
  });

  it('rejects nasTarget endpoint URL containing userinfo (user:pass@host)', () => {
    assert.throws(
      () =>
        validateConfig({
          serverUrl: 'http://localhost:3000',
          deviceId: 'd',
          backupJobs: [{ name: 'j', sourcePath: '/s' }],
          nasTargets: [
            {
              name: 'bad',
              provider: 'synology',
              endpoint: 'http://admin:pass@192.168.1.1:5000',
              shareName: 's',
              remotePath: '/r',
              enabled: true,
            },
          ],
        }),
      /credential|userinfo|user.*pass|not allowed|forbidden/i,
    );
  });

  it('rejects nasTarget endpoint URL containing only username (no password)', () => {
    assert.throws(
      () =>
        validateConfig({
          serverUrl: 'http://localhost:3000',
          deviceId: 'd',
          backupJobs: [{ name: 'j', sourcePath: '/s' }],
          nasTargets: [
            {
              name: 'bad',
              provider: 'synology',
              endpoint: 'http://admin@192.168.1.1:5000',
              shareName: 's',
              remotePath: '/r',
              enabled: true,
            },
          ],
        }),
      /credential|userinfo|user.*pass|not allowed|forbidden/i,
    );
  });

  // ── nasTargets credentialRef 校验 ───────────────────────────────

  it('accepts config with valid credentialRef "home-synology" in nasTargets', () => {
    const cfg = validateConfig({
      serverUrl: 'http://localhost:3000',
      deviceId: 'd',
      backupJobs: [{ name: 'j', sourcePath: '/s' }],
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
    });
    assert.strictEqual(cfg.nasTargets[0].credentialRef, 'home-synology');
  });

  it('accepts config with valid credentialRef "nas-01" in nasTargets', () => {
    const cfg = validateConfig({
      serverUrl: 'http://localhost:3000',
      deviceId: 'd',
      backupJobs: [{ name: 'j', sourcePath: '/s' }],
      nasTargets: [
        {
          name: 'syno',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          enabled: true,
          credentialRef: 'nas-01',
        },
      ],
    });
    assert.strictEqual(cfg.nasTargets[0].credentialRef, 'nas-01');
  });

  const CONFIG_INVALID_REFS = [
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

  for (const ref of CONFIG_INVALID_REFS) {
    it(`rejects config with invalid credentialRef "${ref}" in nasTargets`, () => {
      assert.throws(
        () =>
          validateConfig({
            serverUrl: 'http://localhost:3000',
            deviceId: 'd',
            backupJobs: [{ name: 'j', sourcePath: '/s' }],
            nasTargets: [
              {
                name: 'syno',
                provider: 'synology',
                endpoint: 'http://192.168.1.100:5000',
                shareName: 'backup',
                remotePath: '/volume1/backup',
                enabled: true,
                credentialRef: ref,
              },
            ],
          }),
        /credentialRef/i,
      );
    });
  }

  it('rejects config when credentialRef and password co-exist in nasTargets', () => {
    assert.throws(
      () =>
        validateConfig({
          serverUrl: 'http://localhost:3000',
          deviceId: 'd',
          backupJobs: [{ name: 'j', sourcePath: '/s' }],
          nasTargets: [
            {
              name: 'syno',
              provider: 'synology',
              endpoint: 'http://192.168.1.100:5000',
              shareName: 'backup',
              remotePath: '/volume1/backup',
              enabled: true,
              credentialRef: 'home-synology',
              password: 'some-password',
            },
          ],
        }),
      /credentialRef|credential|forbidden|password/i,
    );
  });

  it('rejects config when credentialRef and passphrase co-exist in nasTargets', () => {
    assert.throws(
      () =>
        validateConfig({
          serverUrl: 'http://localhost:3000',
          deviceId: 'd',
          backupJobs: [{ name: 'j', sourcePath: '/s' }],
          nasTargets: [
            {
              name: 'syno',
              provider: 'synology',
              endpoint: 'http://192.168.1.100:5000',
              shareName: 'backup',
              remotePath: '/volume1/backup',
              enabled: true,
              credentialRef: 'home-synology',
              passphrase: 'some-passphrase',
            },
          ],
        }),
      /credentialRef|credential|forbidden|passphrase/i,
    );
  });
});
