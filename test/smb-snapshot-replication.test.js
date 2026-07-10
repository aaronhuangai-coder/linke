import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  mkdir, mkdtemp, rm, writeFile, symlink, readdir, readFile, lstat,
} from 'node:fs/promises';
import { createReadStream as fsCreateReadStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  SmbReplicationError,
  SMB_REPLICATION_CODES,
  buildRemoteSnapshotManifest,
  serializeCanonicalRemoteManifest,
  digestRemoteSnapshotManifest,
  buildSmbSnapshotReplicationPlan,
  inspectMountedSmb,
  replicateSnapshotToMountedSmb,
} from '../src/smb-snapshot-replication.js';
import { safeDevicePath, createBackup } from '../src/storage.js';
import { LINKE_RELEASE_VERSION } from '../src/version.js';

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

async function createExecutionFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'linke-smb-execute-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const mountPath = join(root, 'mounted-share');
  await mkdir(source, { recursive: true });
  await mkdir(mountPath, { recursive: true });
  await writeFile(join(source, 'a.txt'), 'alpha');
  const snapshot = await createBackup(root, { deviceId: 'device-a', sourcePath: source });
  const options = {
    config: {
      nasTargets: [{
        name: 'primary-nas',
        provider: 'synology',
        enabled: true,
        mountedShare: { enabled: true, mountPath, relativeRoot: 'linke-test' },
      }],
    },
    dataDir: root,
    targetName: 'primary-nas',
    deviceId: 'device-a',
    snapshotId: snapshot.snapshotId,
    execute: true,
    executionGate: 'enabled',
  };
  return {
    root,
    mountPath,
    options,
    snapshotId: snapshot.snapshotId,
    stagingParent: join(mountPath, 'linke-test', '.linke-control', 'staging', 'device-a', snapshot.snapshotId),
    finalDir: join(mountPath, 'linke-test', 'devices', 'device-a', 'snapshots', snapshot.snapshotId),
  };
}

async function freshExecutionOptions(t) {
  return (await createExecutionFixture(t)).options;
}

function ampleMountDeps() {
  return {
    inspectMount: async () => ({ fsType: 'smbfs', availableBytes: 1024 * 1024 * 1024 }),
  };
}

function assertSanitizedReplicationResult(result, forbiddenPaths) {
  const serialized = JSON.stringify(result);
  for (const forbidden of forbiddenPaths) {
    assert.ok(!serialized.includes(forbidden), `result must not include ${forbidden}`);
  }
  assert.strictEqual(result.command, 'nas-snapshot-replicate');
  assert.strictEqual(result.mode, 'execute');
  assert.strictEqual(result.provider, 'synology');
  assert.strictEqual(result.targetName, 'primary-nas');
  assert.strictEqual(result.deviceId, 'device-a');
  assert.ok(typeof result.snapshotId === 'string');
  assert.ok(typeof result.manifestDigest === 'string');
  assert.ok(Number.isSafeInteger(result.fileCount));
  assert.ok(Number.isSafeInteger(result.totalBytes));
  assert.ok(Number.isSafeInteger(result.verifiedFileCount));
}

describe('SMB snapshot replication preflight and publication', () => {
  it('preflight rejects non-smbfs mounts before any remote write', async (t) => {
    const { options, mountPath } = await createExecutionFixture(t);
    await assert.rejects(
      replicateSnapshotToMountedSmb(options, {
        inspectMount: async () => ({ fsType: 'apfs', availableBytes: 1024 * 1024 * 1024 }),
      }),
      (error) => error instanceof SmbReplicationError
        && error.code === SMB_REPLICATION_CODES.MOUNT_REQUIRED
        && error.exitCode === 2,
    );
    assert.deepStrictEqual(await readdir(mountPath), []);
  });

  it('preflight rejects insufficient free space using the safety margin formula', async (t) => {
    await assert.rejects(
      replicateSnapshotToMountedSmb(await freshExecutionOptions(t), {
        inspectMount: async () => ({ fsType: 'smbfs', availableBytes: (64 * 1024 * 1024) + 4 }),
      }),
      (error) => error instanceof SmbReplicationError
        && error.code === SMB_REPLICATION_CODES.SPACE_INSUFFICIENT
        && error.exitCode === 2,
    );
  });

  it('preflight rejects relativeRoot symlink that escapes the mount root', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'linke-smb-symlink-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const outside = await mkdtemp(join(tmpdir(), 'linke-smb-outside-'));
    t.after(() => rm(outside, { recursive: true, force: true }));
    const source = join(root, 'source');
    const mountPath = join(root, 'mounted-share');
    await mkdir(source, { recursive: true });
    await mkdir(mountPath, { recursive: true });
    await writeFile(join(source, 'a.txt'), 'alpha');
    await symlink(outside, join(mountPath, 'linke-test'));
    const snapshot = await createBackup(root, { deviceId: 'device-a', sourcePath: source });
    const options = {
      config: {
        nasTargets: [{
          name: 'primary-nas',
          provider: 'synology',
          enabled: true,
          mountedShare: { enabled: true, mountPath, relativeRoot: 'linke-test' },
        }],
      },
      dataDir: root,
      targetName: 'primary-nas',
      deviceId: 'device-a',
      snapshotId: snapshot.snapshotId,
      execute: true,
      executionGate: 'enabled',
    };

    await assert.rejects(
      replicateSnapshotToMountedSmb(options, ampleMountDeps()),
      (error) => error instanceof SmbReplicationError
        && (
          error.code === SMB_REPLICATION_CODES.MOUNT_REQUIRED
          || error.code === SMB_REPLICATION_CODES.COPY_FAILED
        ),
    );
    assert.deepStrictEqual(await readdir(outside), []);
  });

  it('returns replicated on first publish and writes COMPLETED.json after final verification', async (t) => {
    const { options, mountPath, finalDir, root } = await createExecutionFixture(t);
    const first = await replicateSnapshotToMountedSmb(options, ampleMountDeps());

    assert.strictEqual(first.state, 'replicated');
    assertSanitizedReplicationResult(first, [
      root,
      mountPath,
      'mounted-share',
      'linke-test',
    ]);
    assert.strictEqual(first.fileCount, 1);
    assert.strictEqual(first.totalBytes, 5);
    assert.strictEqual(first.verifiedFileCount, 1);
    assert.strictEqual(first.manifestDigest, digestRemoteSnapshotManifest(
      buildRemoteSnapshotManifest({
        schemaVersion: 2,
        snapshotId: first.snapshotId,
        deviceId: 'device-a',
        createdAt: (await JSON.parse(
          await readFile(join(finalDir, 'manifest.json'), 'utf8'),
        )).createdAt,
        files: ['a.txt'],
        integrity: {
          algorithm: 'sha256',
          totalBytes: 5,
          entries: [{ path: 'a.txt', size: 5, sha256: HASH_ALPHA }],
        },
      }),
    ));

    const completed = JSON.parse(await readFile(join(finalDir, 'COMPLETED.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(completed).sort(), [
      'algorithm',
      'completedAt',
      'deviceId',
      'fileCount',
      'linkeVersion',
      'manifestDigest',
      'schemaVersion',
      'snapshotId',
      'state',
      'totalBytes',
    ].sort());
    assert.strictEqual(completed.schemaVersion, 1);
    assert.strictEqual(completed.state, 'completed');
    assert.strictEqual(completed.snapshotId, first.snapshotId);
    assert.strictEqual(completed.deviceId, 'device-a');
    assert.strictEqual(completed.manifestDigest, first.manifestDigest);
    assert.strictEqual(completed.algorithm, 'sha256');
    assert.strictEqual(completed.fileCount, 1);
    assert.strictEqual(completed.totalBytes, 5);
    assert.strictEqual(completed.linkeVersion, LINKE_RELEASE_VERSION);
    assert.ok(!Number.isNaN(Date.parse(completed.completedAt)));
    assert.strictEqual(
      await readFile(join(finalDir, 'files', 'a.txt'), 'utf8'),
      'alpha',
    );
  });

  it('returns already_verified on rerun without creating a new staging attempt', async (t) => {
    const { options, stagingParent } = await createExecutionFixture(t);
    const deps = ampleMountDeps();
    const first = await replicateSnapshotToMountedSmb(options, deps);
    assert.strictEqual(first.state, 'replicated');

    const second = await replicateSnapshotToMountedSmb(options, deps);
    assert.strictEqual(second.state, 'already_verified');
    assertSanitizedReplicationResult(second, [options.dataDir]);
    assert.strictEqual(second.snapshotId, first.snapshotId);
    assert.strictEqual(second.manifestDigest, first.manifestDigest);
    assert.strictEqual(second.verifiedFileCount, 1);

    let stagingEntries = [];
    try {
      stagingEntries = await readdir(stagingParent);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    assert.strictEqual(stagingEntries.length, 0);
  });

  it('conflict leaves a damaged final snapshot untouched and refuses overwrite', async (t) => {
    const { options, finalDir } = await createExecutionFixture(t);
    await mkdir(join(finalDir, 'files'), { recursive: true });
    await writeFile(join(finalDir, 'files', 'a.txt'), 'CORRUPTED');
    await writeFile(
      join(finalDir, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 2,
        snapshotId: options.snapshotId,
        deviceId: 'device-a',
        createdAt: '2026-07-10T00:00:00.000Z',
        files: ['a.txt'],
        integrity: {
          algorithm: 'sha256',
          totalBytes: 5,
          entries: [{ path: 'a.txt', size: 5, sha256: HASH_ALPHA }],
        },
      }),
      'utf8',
    );
    await writeFile(
      join(finalDir, 'COMPLETED.json'),
      JSON.stringify({
        schemaVersion: 1,
        state: 'completed',
        snapshotId: options.snapshotId,
        deviceId: 'device-a',
        manifestDigest: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        algorithm: 'sha256',
        fileCount: 1,
        totalBytes: 5,
        completedAt: '2026-07-10T00:00:00.000Z',
        linkeVersion: LINKE_RELEASE_VERSION,
      }),
      'utf8',
    );

    await assert.rejects(
      replicateSnapshotToMountedSmb(options, ampleMountDeps()),
      (error) => error instanceof SmbReplicationError
        && (
          error.code === SMB_REPLICATION_CODES.REMOTE_CONFLICT
          || error.code === SMB_REPLICATION_CODES.REMOTE_INTEGRITY_FAILED
        ),
    );

    assert.strictEqual(await readFile(join(finalDir, 'files', 'a.txt'), 'utf8'), 'CORRUPTED');
    const completed = JSON.parse(await readFile(join(finalDir, 'COMPLETED.json'), 'utf8'));
    assert.strictEqual(
      completed.manifestDigest,
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    );
  });

  it('aborts with replication-copy-failed when mount recheck fails before publish', async (t) => {
    let mountChecks = 0;
    await assert.rejects(
      replicateSnapshotToMountedSmb(await freshExecutionOptions(t), {
        inspectMount: async () => {
          mountChecks += 1;
          return mountChecks === 1
            ? { fsType: 'smbfs', availableBytes: 1024 * 1024 * 1024 }
            : { fsType: 'apfs', availableBytes: 1024 * 1024 * 1024 };
        },
      }),
      (error) => error instanceof SmbReplicationError
        && error.code === SMB_REPLICATION_CODES.COPY_FAILED,
    );
    assert.ok(mountChecks >= 2);
  });

  it('inspectMountedSmb uses fixed /usr/bin/stat args and statfs available bytes', async () => {
    const calls = [];
    const result = await inspectMountedSmb('/Volumes/TestShare', {
      execFile: async (file, args) => {
        calls.push({ file, args });
        return { stdout: 'smbfs\n' };
      },
      statfs: async (path) => {
        calls.push({ path });
        return { bavail: 100n, bsize: 4096n };
      },
    });
    assert.deepStrictEqual(calls[0], {
      file: '/usr/bin/stat',
      args: ['-f', '%T', '/Volumes/TestShare'],
    });
    assert.strictEqual(result.fsType, 'smbfs');
    assert.strictEqual(result.availableBytes, 409600);
  });

  it('conflict refuses overwrite when final appears before exclusive publication claim', async (t) => {
    const { options, finalDir } = await createExecutionFixture(t);
    await assert.rejects(
      replicateSnapshotToMountedSmb(options, {
        ...ampleMountDeps(),
        beforePublish: async () => {
          await mkdir(finalDir, { recursive: true });
          await writeFile(join(finalDir, 'sentinel.txt'), 'pre-existing-final');
        },
      }),
      (error) => error instanceof SmbReplicationError
        && (
          error.code === SMB_REPLICATION_CODES.REMOTE_CONFLICT
          || error.code === SMB_REPLICATION_CODES.RECOVERY_REQUIRED
          || error.code === SMB_REPLICATION_CODES.REMOTE_INTEGRITY_FAILED
        ),
    );

    assert.strictEqual(
      await readFile(join(finalDir, 'sentinel.txt'), 'utf8'),
      'pre-existing-final',
    );
    await assert.rejects(
      () => readFile(join(finalDir, 'COMPLETED.json'), 'utf8'),
      (error) => error && error.code === 'ENOENT',
    );
    const entries = await readdir(finalDir);
    assert.ok(entries.includes('sentinel.txt'));
    assert.ok(!entries.includes('COMPLETED.json'));
  });

  it('already_verified rejects malformed COMPLETED markers without modifying final', async (t) => {
    const { options, finalDir } = await createExecutionFixture(t);
    const deps = ampleMountDeps();
    const first = await replicateSnapshotToMountedSmb(options, deps);
    assert.strictEqual(first.state, 'replicated');

    const completedPath = join(finalDir, 'COMPLETED.json');
    const originalCompleted = await readFile(completedPath, 'utf8');
    const originalFile = await readFile(join(finalDir, 'files', 'a.txt'), 'utf8');
    const base = JSON.parse(originalCompleted);

    const malformedMarkers = [
      { ...base, completedAt: undefined, extraField: 'nope' },
      (() => {
        const copy = { ...base };
        delete copy.completedAt;
        return copy;
      })(),
      { ...base, completedAt: '2026-07-10T00:00:00Z' },
      { ...base, linkeVersion: 'CORRUPTED' },
      (() => {
        const copy = { ...base };
        delete copy.linkeVersion;
        return copy;
      })(),
      { ...base, unexpected: true },
    ];

    for (const marker of malformedMarkers) {
      const cleaned = Object.fromEntries(
        Object.entries(marker).filter(([, value]) => value !== undefined),
      );
      await writeFile(completedPath, JSON.stringify(cleaned), 'utf8');

      await assert.rejects(
        replicateSnapshotToMountedSmb(options, deps),
        (error) => error instanceof SmbReplicationError
          && (
            error.code === SMB_REPLICATION_CODES.REMOTE_INTEGRITY_FAILED
            || error.code === SMB_REPLICATION_CODES.REMOTE_CONFLICT
          ),
      );

      assert.strictEqual(await readFile(join(finalDir, 'files', 'a.txt'), 'utf8'), originalFile);
      assert.strictEqual(await readFile(completedPath, 'utf8'), JSON.stringify(cleaned));
    }

    await writeFile(completedPath, originalCompleted, 'utf8');
    const restored = await replicateSnapshotToMountedSmb(options, deps);
    assert.strictEqual(restored.state, 'already_verified');
  });

  it('already_verified rejects nested ancestor symlink escape in final files', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'linke-smb-nested-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const outside = await mkdtemp(join(tmpdir(), 'linke-smb-outside-nested-'));
    t.after(() => rm(outside, { recursive: true, force: true }));
    const source = join(root, 'source');
    const mountPath = join(root, 'mounted-share');
    await mkdir(join(source, 'nested'), { recursive: true });
    await mkdir(mountPath, { recursive: true });
    await writeFile(join(source, 'nested', 'a.txt'), 'alpha');
    const snapshot = await createBackup(root, { deviceId: 'device-a', sourcePath: source });
    const options = {
      config: {
        nasTargets: [{
          name: 'primary-nas',
          provider: 'synology',
          enabled: true,
          mountedShare: { enabled: true, mountPath, relativeRoot: 'linke-test' },
        }],
      },
      dataDir: root,
      targetName: 'primary-nas',
      deviceId: 'device-a',
      snapshotId: snapshot.snapshotId,
      execute: true,
      executionGate: 'enabled',
    };
    const finalDir = join(
      mountPath,
      'linke-test',
      'devices',
      'device-a',
      'snapshots',
      snapshot.snapshotId,
    );

    const first = await replicateSnapshotToMountedSmb(options, ampleMountDeps());
    assert.strictEqual(first.state, 'replicated');

    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'a.txt'), 'alpha');
    await rm(join(finalDir, 'files', 'nested'), { recursive: true, force: true });
    await symlink(outside, join(finalDir, 'files', 'nested'));

    await assert.rejects(
      replicateSnapshotToMountedSmb(options, ampleMountDeps()),
      (error) => error instanceof SmbReplicationError
        && error.code !== undefined
        && error.code !== 'already_verified',
    );
    assert.ok((await lstat(join(finalDir, 'files', 'nested'))).isSymbolicLink());
    assert.strictEqual(await readFile(join(outside, 'a.txt'), 'utf8'), 'alpha');
  });

  it('rejects local snapshot ancestor symlink escape before remote write', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'linke-smb-local-symlink-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const outside = await mkdtemp(join(tmpdir(), 'linke-smb-local-outside-'));
    t.after(() => rm(outside, { recursive: true, force: true }));
    const source = join(root, 'source');
    const mountPath = join(root, 'mounted-share');
    await mkdir(join(source, 'nested'), { recursive: true });
    await mkdir(mountPath, { recursive: true });
    await writeFile(join(source, 'nested', 'a.txt'), 'alpha');
    const snapshot = await createBackup(root, { deviceId: 'device-a', sourcePath: source });
    const { deviceDir } = safeDevicePath(root, 'device-a');
    const filesRoot = join(deviceDir, 'snapshots', snapshot.snapshotId, 'files');
    await writeFile(join(outside, 'a.txt'), 'alpha');
    await rm(join(filesRoot, 'nested'), { recursive: true, force: true });
    await symlink(outside, join(filesRoot, 'nested'));

    const options = {
      config: {
        nasTargets: [{
          name: 'primary-nas',
          provider: 'synology',
          enabled: true,
          mountedShare: { enabled: true, mountPath, relativeRoot: 'linke-test' },
        }],
      },
      dataDir: root,
      targetName: 'primary-nas',
      deviceId: 'device-a',
      snapshotId: snapshot.snapshotId,
      execute: true,
      executionGate: 'enabled',
    };

    await assert.rejects(
      replicateSnapshotToMountedSmb(options, ampleMountDeps()),
      (error) => error instanceof SmbReplicationError
        && error.code === SMB_REPLICATION_CODES.SNAPSHOT_INTEGRITY_FAILED
        && error.exitCode === 2,
    );
    assert.deepStrictEqual(await readdir(mountPath), []);
  });

  it('maps destination write-open failures to replication-copy-failed without crashing', async (t) => {
    const { options, stagingParent, finalDir } = await createExecutionFixture(t);
    const attemptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const destPath = join(stagingParent, attemptId, 'files', 'a.txt');

    await assert.rejects(
      replicateSnapshotToMountedSmb(options, {
        ...ampleMountDeps(),
        randomUUID: () => attemptId,
        beforeCopy: async () => {
          // 把期望的目标文件路径占成目录，强制 exclusive open 失败。
          await mkdir(destPath, { recursive: true });
        },
      }),
      (error) => error instanceof SmbReplicationError
        && error.code === SMB_REPLICATION_CODES.COPY_FAILED
        && error.exitCode === 1,
    );

    // 不得发布完成标记；handled failure 可清理 owned staging。
    await assert.rejects(
      () => readFile(join(finalDir, 'COMPLETED.json'), 'utf8'),
      (error) => error && error.code === 'ENOENT',
    );
  });

  it('rechecks mount mid-stream when a single file crosses the byte threshold', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'linke-smb-stream-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = join(root, 'source');
    const mountPath = join(root, 'mounted-share');
    await mkdir(source, { recursive: true });
    await mkdir(mountPath, { recursive: true });
    const payload = Buffer.alloc(40, 0x61);
    await writeFile(join(source, 'big.bin'), payload);
    const snapshot = await createBackup(root, { deviceId: 'device-a', sourcePath: source });
    const options = {
      config: {
        nasTargets: [{
          name: 'primary-nas',
          provider: 'synology',
          enabled: true,
          mountedShare: { enabled: true, mountPath, relativeRoot: 'linke-test' },
        }],
      },
      dataDir: root,
      targetName: 'primary-nas',
      deviceId: 'device-a',
      snapshotId: snapshot.snapshotId,
      execute: true,
      executionGate: 'enabled',
    };

    let streaming = false;
    let midStreamRechecks = 0;
    let totalInspects = 0;
    const result = await replicateSnapshotToMountedSmb(options, {
      mountRecheckByteInterval: 10,
      streamHighWaterMark: 8,
      createReadStream: (filePath, opts = {}) => {
        const stream = fsCreateReadStream(filePath, { ...opts, highWaterMark: 8 });
        streaming = true;
        stream.on('end', () => {
          streaming = false;
        });
        stream.on('close', () => {
          streaming = false;
        });
        return stream;
      },
      inspectMount: async () => {
        totalInspects += 1;
        if (streaming) midStreamRechecks += 1;
        return { fsType: 'smbfs', availableBytes: 1024 * 1024 * 1024 };
      },
    });

    assert.strictEqual(result.state, 'replicated');
    assert.ok(midStreamRechecks >= 1, 'expected mount recheck while a single file is still streaming');
    assert.ok(totalInspects >= 3, 'expected preflight, mid-stream, and pre-publish mount checks');
    assert.strictEqual(result.totalBytes, payload.length);
    assert.strictEqual(result.fileCount, 1);
  });
});
