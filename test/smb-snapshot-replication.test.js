import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  SmbReplicationError,
  SMB_REPLICATION_CODES,
  buildRemoteSnapshotManifest,
  serializeCanonicalRemoteManifest,
  digestRemoteSnapshotManifest,
  buildSmbSnapshotReplicationPlan,
} from '../src/smb-snapshot-replication.js';
import { safeDevicePath } from '../src/storage.js';

const SNAPSHOT_A = '11111111-1111-1111-1111-111111111111';
const HASH_ALPHA = '8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8';

function localManifestV2(overrides = {}) {
  return {
    schemaVersion: 2,
    snapshotId: SNAPSHOT_A,
    deviceId: 'device-a',
    createdAt: '2026-07-10T00:00:00.000Z',
    hostname: 'must-not-replicate',
    ipAddress: '192.0.2.10',
    sourcePath: '/private/source/path',
    files: ['a.txt'],
    integrity: {
      algorithm: 'sha256',
      totalBytes: 5,
      entries: [{
        path: 'a.txt',
        size: 5,
        sha256: HASH_ALPHA,
        ignoredEntryField: 'must-not-replicate',
      }],
      ignoredIntegrityField: 'must-not-replicate',
    },
    ...overrides,
  };
}

function validPlanOptions() {
  return {
    config: {
      nasTargets: [{
        name: 'primary-nas',
        provider: 'synology',
        endpoint: 'https://sensitive-endpoint.invalid',
        remotePath: '/sensitive/provider/path',
        credentialRef: 'sensitive-reference',
        enabled: true,
        mountedShare: {
          enabled: true,
          mountPath: '/Volumes/SecretLinkeBackup',
          relativeRoot: 'sensitive-replication-root',
        },
      }],
    },
    dataDir: '/tmp/linke-plan-fixture-sensitive',
    targetName: 'primary-nas',
    deviceId: 'device-a',
    snapshotId: SNAPSHOT_A,
  };
}

function assertIntegrityError(fn) {
  assert.throws(
    fn,
    (error) => error instanceof SmbReplicationError
      && error.code === SMB_REPLICATION_CODES.SNAPSHOT_INTEGRITY_FAILED
      && error.exitCode === 2,
  );
}

describe('SMB snapshot replication manifest', () => {
  it('serializes the allowlisted remote manifest into stable canonical bytes', () => {
    const remote = buildRemoteSnapshotManifest(localManifestV2());
    const bytes = serializeCanonicalRemoteManifest(remote);

    assert.deepStrictEqual(Object.keys(remote), [
      'schemaVersion',
      'snapshotId',
      'deviceId',
      'createdAt',
      'files',
      'integrity',
    ]);
    assert.deepStrictEqual(Object.keys(remote.integrity), [
      'algorithm',
      'totalBytes',
      'entries',
    ]);
    assert.strictEqual(
      bytes,
      '{"schemaVersion":2,"snapshotId":"11111111-1111-1111-1111-111111111111","deviceId":"device-a","createdAt":"2026-07-10T00:00:00.000Z","files":["a.txt"],"integrity":{"algorithm":"sha256","totalBytes":5,"entries":[{"path":"a.txt","size":5,"sha256":"8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8"}]}}',
    );
    assert.strictEqual(
      digestRemoteSnapshotManifest(remote),
      '2a4800b8e2a3891fd52511c297c42482583dfcee67b1211e2ee3eb4e6b8c7f33',
    );
    for (const forbidden of ['hostname', 'ipAddress', 'sourcePath', 'ignoredEntryField']) {
      assert.ok(!bytes.includes(forbidden));
    }
  });

  it('keeps three canonical golden digest vectors stable', () => {
    const vectors = [
      {
        manifest: localManifestV2(),
        digest: '2a4800b8e2a3891fd52511c297c42482583dfcee67b1211e2ee3eb4e6b8c7f33',
      },
      {
        manifest: localManifestV2({
          snapshotId: '22222222-2222-2222-2222-222222222222',
          deviceId: 'device-z',
          createdAt: '2026-07-10T01:02:03.004Z',
          files: [],
          integrity: { algorithm: 'sha256', totalBytes: 0, entries: [] },
        }),
        digest: '75fa14fe80c00da6fe214ad8969292d35b809d3cf154a2deccdf76dfc9b39b99',
      },
      {
        manifest: localManifestV2({
          snapshotId: '33333333-3333-3333-3333-333333333333',
          deviceId: 'device_3',
          createdAt: '2026-07-10T23:59:59.999Z',
          files: ['a.txt', 'é.txt'],
          integrity: {
            algorithm: 'sha256',
            totalBytes: 7,
            entries: [
              {
                path: 'a.txt',
                size: 2,
                sha256: '0000000000000000000000000000000000000000000000000000000000000000',
              },
              {
                path: 'é.txt',
                size: 5,
                sha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
              },
            ],
          },
        }),
        digest: '65fb2dbeea7022d8c8f50d16b875421ad4828b120a952f0678c8252f168f5e9e',
      },
    ];

    for (const { manifest, digest } of vectors) {
      const remote = buildRemoteSnapshotManifest(manifest);
      assert.strictEqual(digestRemoteSnapshotManifest(remote), digest);
    }
  });

  it('rejects malformed manifest identity and timestamps', () => {
    for (const manifest of [
      localManifestV2({ schemaVersion: 3 }),
      localManifestV2({ snapshotId: '../escape' }),
      localManifestV2({ snapshotId: new String(SNAPSHOT_A) }),
      localManifestV2({ deviceId: '../device' }),
      localManifestV2({ deviceId: 'Device A' }),
      localManifestV2({ createdAt: 'not-an-iso-date' }),
      localManifestV2({ createdAt: '2026-07-10T00:00:00Z' }),
    ]) {
      assertIntegrityError(() => buildRemoteSnapshotManifest(manifest));
    }
  });

  it('rejects unsorted, duplicate, mismatched, or unsafe file paths', () => {
    const hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    for (const manifest of [
      localManifestV2({
        files: ['z.txt', 'a.txt'],
        integrity: {
          algorithm: 'sha256', totalBytes: 2,
          entries: [
            { path: 'z.txt', size: 1, sha256: hash },
            { path: 'a.txt', size: 1, sha256: hash },
          ],
        },
      }),
      localManifestV2({
        files: ['a.txt', 'a.txt'],
        integrity: {
          algorithm: 'sha256', totalBytes: 2,
          entries: [
            { path: 'a.txt', size: 1, sha256: hash },
            { path: 'a.txt', size: 1, sha256: hash },
          ],
        },
      }),
      localManifestV2({ files: ['a.txt'], integrity: { algorithm: 'sha256', totalBytes: 5, entries: [] } }),
      localManifestV2({
        files: ['a.txt'],
        integrity: {
          algorithm: 'sha256', totalBytes: 5,
          entries: [{ path: 'other.txt', size: 5, sha256: hash }],
        },
      }),
      localManifestV2({
        files: ['../escape'],
        integrity: {
          algorithm: 'sha256', totalBytes: 5,
          entries: [{ path: '../escape', size: 5, sha256: hash }],
        },
      }),
      localManifestV2({
        files: ['nested\\file.txt'],
        integrity: {
          algorithm: 'sha256', totalBytes: 5,
          entries: [{ path: 'nested\\file.txt', size: 5, sha256: hash }],
        },
      }),
    ]) {
      assertIntegrityError(() => buildRemoteSnapshotManifest(manifest));
    }
  });

  it('rejects invalid sizes, totals, algorithms, and hashes', () => {
    for (const integrity of [
      { algorithm: 'sha1', totalBytes: 5, entries: [{ path: 'a.txt', size: 5, sha256: HASH_ALPHA }] },
      { algorithm: 'sha256', totalBytes: -1, entries: [{ path: 'a.txt', size: 5, sha256: HASH_ALPHA }] },
      { algorithm: 'sha256', totalBytes: 5.5, entries: [{ path: 'a.txt', size: 5, sha256: HASH_ALPHA }] },
      { algorithm: 'sha256', totalBytes: 5, entries: [{ path: 'a.txt', size: -1, sha256: HASH_ALPHA }] },
      { algorithm: 'sha256', totalBytes: 5, entries: [{ path: 'a.txt', size: 5.5, sha256: HASH_ALPHA }] },
      { algorithm: 'sha256', totalBytes: 4, entries: [{ path: 'a.txt', size: 5, sha256: HASH_ALPHA }] },
      { algorithm: 'sha256', totalBytes: 5, entries: [{ path: 'a.txt', size: 5, sha256: HASH_ALPHA.toUpperCase() }] },
      { algorithm: 'sha256', totalBytes: 5, entries: [{ path: 'a.txt', size: 5, sha256: 'abc' }] },
      { algorithm: 'sha256', totalBytes: 5, entries: [{ path: 'a.txt', size: 5, sha256: new String(HASH_ALPHA) }] },
    ]) {
      assertIntegrityError(() => buildRemoteSnapshotManifest(localManifestV2({ integrity })));
    }
  });
});

describe('SMB snapshot replication read-only plan', () => {
  it('blocks v1 manifests with a stable migration code', async () => {
    await assert.rejects(
      buildSmbSnapshotReplicationPlan(validPlanOptions(), {
        readSnapshotManifest: async () => ({ files: ['a.txt'] }),
      }),
      (error) => error instanceof SmbReplicationError
        && error.code === SMB_REPLICATION_CODES.V2_REQUIRED
        && error.exitCode === 2,
    );
  });

  it('builds a local-only plan without inspecting or writing the mounted share', async () => {
    const calls = [];
    const options = validPlanOptions();
    Object.defineProperty(options.config.nasTargets[0].mountedShare, 'mountPath', {
      get() {
        calls.push('mountPath');
        throw new Error('mountPath must not be read');
      },
    });
    const plan = await buildSmbSnapshotReplicationPlan(options, {
      readSnapshotManifest: async () => localManifestV2(),
      inspectMount: async () => {
        calls.push('inspect');
        throw new Error('must not run');
      },
    });

    assert.deepStrictEqual(plan, {
      command: 'nas-snapshot-replicate',
      mode: 'plan',
      state: 'planned',
      provider: 'synology',
      targetName: 'primary-nas',
      deviceId: 'device-a',
      snapshotId: SNAPSHOT_A,
      manifestDigest: '2a4800b8e2a3891fd52511c297c42482583dfcee67b1211e2ee3eb4e6b8c7f33',
      fileCount: 1,
      totalBytes: 5,
      wouldWrite: false,
      executionRequired: true,
    });
    assert.deepStrictEqual(calls, []);

    const serialized = JSON.stringify(plan);
    for (const forbidden of [
      '/Volumes/SecretLinkeBackup',
      'sensitive-replication-root',
      'sensitive-endpoint.invalid',
      '/sensitive/provider/path',
      'sensitive-reference',
      '/private/source/path',
      '/tmp/linke-plan-fixture-sensitive',
    ]) {
      assert.ok(!serialized.includes(forbidden));
    }
  });

  it('loads the manifest through the default local snapshot reader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-smb-plan-local-'));
    try {
      const options = { ...validPlanOptions(), dataDir: root };
      const { deviceDir } = safeDevicePath(root, options.deviceId);
      const snapshotDir = join(deviceDir, 'snapshots', options.snapshotId);
      await mkdir(snapshotDir, { recursive: true });
      await writeFile(
        join(snapshotDir, 'manifest.json'),
        JSON.stringify(localManifestV2()),
        'utf8',
      );

      const plan = await buildSmbSnapshotReplicationPlan(options);
      assert.strictEqual(plan.state, 'planned');
      assert.strictEqual(plan.manifestDigest, '2a4800b8e2a3891fd52511c297c42482583dfcee67b1211e2ee3eb4e6b8c7f33');
      assert.strictEqual(plan.wouldWrite, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when target configuration or snapshot identity is inconsistent', async () => {
    const options = validPlanOptions();
    await assert.rejects(
      buildSmbSnapshotReplicationPlan({ ...options, targetName: 'missing-target' }, {
        readSnapshotManifest: async () => localManifestV2(),
      }),
      (error) => error instanceof SmbReplicationError
        && error.code === SMB_REPLICATION_CODES.MOUNT_REQUIRED
        && error.exitCode === 2,
    );
    await assert.rejects(
      buildSmbSnapshotReplicationPlan(options, {
        readSnapshotManifest: async () => localManifestV2({ deviceId: 'other-device' }),
      }),
      (error) => error instanceof SmbReplicationError
        && error.code === SMB_REPLICATION_CODES.SNAPSHOT_INTEGRITY_FAILED
        && error.exitCode === 2,
    );
    await assert.rejects(
      buildSmbSnapshotReplicationPlan(options, {
        readSnapshotManifest: async () => localManifestV2({
          snapshotId: '99999999-9999-9999-9999-999999999999',
        }),
      }),
      (error) => error instanceof SmbReplicationError
        && error.code === SMB_REPLICATION_CODES.SNAPSHOT_INTEGRITY_FAILED
        && error.exitCode === 2,
    );
  });
});
