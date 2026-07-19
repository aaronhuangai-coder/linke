import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBackup } from '../src/storage.js';
import { readAuditEvents, sanitizeAuditEvent } from '../src/audit-log.js';

const exec = promisify(execFile);
const agentPath = join(import.meta.dirname, '..', 'src', 'agent.js');

const SNAPSHOT_PLACEHOLDER = '11111111-1111-1111-1111-111111111111';

const SENSITIVE_FIXTURES = Object.freeze([
  'home-backup-secret-ref',
  'https://192.168.50.10:5001',
  '/volume1/linke-secret-remote',
  '/Volumes/SecretLinkeBackupMount',
  'sensitive-replication-root',
  '/Users/example/SecretDocuments',
  'owner-token-must-not-leak',
  'ENOENT',
  'EACCES',
  'password-value',
  'token-value',
]);

async function runAgent(args, env = {}) {
  return exec(process.execPath, [agentPath, ...args], {
    env: { ...process.env, ...env },
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function rejectAgent(args, expectedCode, env = {}) {
  try {
    const result = await runAgent(args, env);
    assert.fail(
      `expected exit ${expectedCode}, got success with stdout ${result.stdout}`,
    );
  } catch (error) {
    assert.equal(error.code, expectedCode);
    return error;
  }
}

function assertNoSensitiveLeak(...chunks) {
  const text = chunks.map((chunk) => String(chunk || '')).join('\n');
  for (const forbidden of SENSITIVE_FIXTURES) {
    assert.ok(!text.includes(forbidden), `output leaked ${forbidden}`);
  }
  assert.doesNotMatch(text, /Bearer\s+\S+/i);
  assert.doesNotMatch(text, /ownerToken/i);
  assert.doesNotMatch(text, /credentialRef/i);
  assert.doesNotMatch(text, /mountPath|relativeRoot|sourcePath|remotePath|endpoint/i);
}

async function writeFixtureConfig(root, { mountPathLocal } = {}) {
  const mountPath = mountPathLocal || join(root, 'mounted-share');
  await mkdir(mountPath, { recursive: true });
  const configPath = join(root, 'linke-nas-snapshot.json');
  const config = {
    serverUrl: 'http://localhost:3000',
    deviceId: 'device-a',
    hostname: 'agent-host',
    nasTargets: [
      {
        name: 'primary-nas',
        provider: 'synology',
        endpoint: 'https://192.168.50.10:5001',
        shareName: 'backup',
        remotePath: '/volume1/linke-secret-remote',
        enabled: true,
        credentialRef: 'home-backup-secret-ref',
        mountedShare: {
          enabled: true,
          mountPath,
          relativeRoot: 'sensitive-replication-root',
        },
      },
    ],
    backupJobs: [
      { name: 'documents', sourcePath: '/Users/example/SecretDocuments' },
    ],
  };
  await writeFile(configPath, JSON.stringify(config));
  return { configPath, mountPath, config };
}

async function createLocalSnapshotFixture() {
  const root = await mkdtemp(join(tmpdir(), 'linke-agent-nas-snap-'));
  const source = join(root, 'source');
  const mountPath = join(root, 'mounted-share');
  await mkdir(source, { recursive: true });
  await mkdir(mountPath, { recursive: true });
  await writeFile(join(source, 'a.txt'), 'alpha');
  const snapshot = await createBackup(root, {
    deviceId: 'device-a',
    sourcePath: source,
  });
  const { configPath } = await writeFixtureConfig(root, {
    mountPathLocal: mountPath,
  });
  return {
    root,
    configPath,
    mountPath,
    dataDir: root,
    deviceId: 'device-a',
    snapshotId: snapshot.snapshotId,
    target: 'primary-nas',
  };
}

function baseArgs(fixture, extra = []) {
  return [
    'nas-snapshot-replicate',
    '--config', fixture.configPath,
    '--data-dir', fixture.dataDir,
    '--target', fixture.target,
    '--device-id', fixture.deviceId,
    '--snapshot-id', fixture.snapshotId,
    ...extra,
  ];
}

describe('Agent nas-snapshot-replicate CLI', () => {
  it('rejects missing required arguments with a fixed code and exit 1', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-agent-nas-args-'));
    try {
      const err = await rejectAgent(['nas-snapshot-replicate'], 1);
      assert.match(err.stderr, /Error: smb-arguments-invalid/);
      assert.equal(err.stdout, '');
      assertNoSensitiveLeak(err.stdout, err.stderr);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects values after boolean flags and extra write-like parameters', async () => {
    const fixture = await createLocalSnapshotFixture();
    try {
      for (const extra of [
        ['--execute', 'true'],
        ['--recover', 'yes'],
        ['--username', 'admin'],
        ['--password', 'password-value'],
        ['--token', 'token-value'],
        ['--credential', 'secret'],
        ['--smb-url', 'smb://host/share'],
        ['--command', 'rm -rf /'],
        ['--shell', '/bin/sh'],
      ]) {
        const err = await rejectAgent(baseArgs(fixture, extra), 1);
        assert.match(err.stderr, /Error: smb-arguments-invalid/);
        assert.ok(!err.stderr.includes(extra[0].slice(2)));
        if (extra[1]) {
          assert.ok(!err.stderr.includes(extra[1]));
          assert.ok(!err.stdout.includes(extra[1]));
        }
        assertNoSensitiveLeak(err.stdout, err.stderr, fixture.configPath, fixture.dataDir);
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('requires --execute when --recover is set and exits 2', async () => {
    const fixture = await createLocalSnapshotFixture();
    try {
      const err = await rejectAgent(baseArgs(fixture, ['--recover']), 2);
      assert.match(err.stderr, /Error: smb-execution-blocked/);
      assert.equal(err.stdout, '');
      assert.deepEqual(await readdir(fixture.mountPath), []);
      assertNoSensitiveLeak(err.stdout, err.stderr, fixture.configPath, fixture.dataDir);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('builds a sanitized plan without remote writes and exits 0', async () => {
    const fixture = await createLocalSnapshotFixture();
    try {
      const before = await readdir(fixture.mountPath);
      const { stdout, stderr } = await runAgent(baseArgs(fixture));
      const result = JSON.parse(stdout);

      assert.equal(stderr, '');
      assert.equal(result.command, 'nas-snapshot-replicate');
      assert.equal(result.mode, 'plan');
      assert.equal(result.state, 'planned');
      assert.equal(result.provider, 'synology');
      assert.equal(result.targetName, 'primary-nas');
      assert.equal(result.deviceId, 'device-a');
      assert.equal(result.snapshotId, fixture.snapshotId);
      assert.equal(result.fileCount, 1);
      assert.equal(result.totalBytes, 5);
      assert.equal(result.wouldWrite, false);
      assert.equal(result.executionRequired, true);
      assert.equal(typeof result.manifestDigest, 'string');
      assert.deepEqual(Object.keys(result).sort(), [
        'command',
        'deviceId',
        'executionRequired',
        'fileCount',
        'manifestDigest',
        'mode',
        'provider',
        'snapshotId',
        'state',
        'targetName',
        'totalBytes',
        'wouldWrite',
      ].sort());
      assert.deepEqual(await readdir(fixture.mountPath), before);
      assert.ok(!stdout.includes(fixture.configPath));
      assert.ok(!stdout.includes(fixture.dataDir));
      assert.ok(!stdout.includes(fixture.mountPath));
      assertNoSensitiveLeak(stdout, stderr, fixture.configPath, fixture.dataDir);

      const events = await readAuditEvents(fixture.dataDir, { limit: 10 });
      assert.ok(events.some((event) => event.type === 'nas.snapshot.replication.planned'));
      const planned = events.find((event) => event.type === 'nas.snapshot.replication.planned');
      assert.equal(planned.targetName, 'primary-nas');
      assert.equal(planned.deviceId, 'device-a');
      assert.equal(planned.snapshotId, fixture.snapshotId);
      assert.equal(planned.fileCount, 1);
      assert.equal(planned.totalBytes, 5);
      assert.ok(!JSON.stringify(planned).includes(fixture.mountPath));
      assert.ok(!JSON.stringify(planned).includes('home-backup-secret-ref'));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('blocks execute when the environment gate is missing and exits 2', async () => {
    const fixture = await createLocalSnapshotFixture();
    try {
      const before = await readdir(fixture.mountPath);
      const err = await rejectAgent(baseArgs(fixture, ['--execute']), 2, {
        LINKE_NAS_SMB_EXECUTION: '',
      });
      assert.match(err.stderr, /Error: smb-execution-blocked/);
      assert.equal(err.stdout, '');
      assert.deepEqual(await readdir(fixture.mountPath), before);
      assertNoSensitiveLeak(err.stdout, err.stderr, fixture.configPath, fixture.dataDir);

      const events = await readAuditEvents(fixture.dataDir, { limit: 10 });
      const failed = events.find((event) => (
        event.type === 'nas.snapshot.replication.failed'
        || event.type === 'nas.snapshot.replication.recovery_required'
      ));
      assert.ok(failed);
      assert.equal(failed.errorCode, 'smb-execution-blocked');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('blocks execute on non-smbfs fixture mounts without leaking system errors', async () => {
    const fixture = await createLocalSnapshotFixture();
    try {
      const before = await readdir(fixture.mountPath);
      const err = await rejectAgent(baseArgs(fixture, ['--execute']), 2, {
        LINKE_NAS_SMB_EXECUTION: 'enabled',
      });
      assert.match(err.stderr, /Error: smb-mount-required/);
      assert.equal(err.stdout, '');
      assert.deepEqual(await readdir(fixture.mountPath), before);
      assert.ok(!err.stderr.includes(fixture.mountPath));
      assert.ok(!err.stderr.includes('stat'));
      assertNoSensitiveLeak(err.stdout, err.stderr, fixture.configPath, fixture.dataDir);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('maps recover+execute without the env gate to exit 2', async () => {
    const fixture = await createLocalSnapshotFixture();
    try {
      const err = await rejectAgent(baseArgs(fixture, ['--execute', '--recover']), 2, {
        LINKE_NAS_SMB_EXECUTION: 'disabled',
      });
      assert.match(err.stderr, /Error: smb-execution-blocked/);
      assertNoSensitiveLeak(err.stdout, err.stderr, fixture.configPath, fixture.dataDir);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects unknown snapshot identity without leaking local paths', async () => {
    const fixture = await createLocalSnapshotFixture();
    try {
      const err = await rejectAgent(
        baseArgs({
          ...fixture,
          snapshotId: SNAPSHOT_PLACEHOLDER,
        }),
        2,
      );
      assert.match(err.stderr, /Error: snapshot-integrity-failed|Error: snapshot-integrity-v2-required/);
      assert.ok(!err.stderr.includes(fixture.dataDir));
      assert.ok(!err.stderr.includes(fixture.configPath));
      assertNoSensitiveLeak(err.stdout, err.stderr, fixture.configPath, fixture.dataDir);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('does not expose config load failures as raw filesystem messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-agent-nas-missing-config-'));
    try {
      const missingConfig = join(root, 'missing-linke.json');
      const dataDir = join(root, 'data');
      await mkdir(dataDir, { recursive: true });
      const err = await rejectAgent([
        'nas-snapshot-replicate',
        '--config', missingConfig,
        '--data-dir', dataDir,
        '--target', 'primary-nas',
        '--device-id', 'device-a',
        '--snapshot-id', SNAPSHOT_PLACEHOLDER,
      ], 1);
      assert.match(err.stderr, /Error: nas-snapshot-replicate-failed/);
      assert.ok(!err.stderr.includes(missingConfig));
      assert.ok(!err.stderr.includes('ENOENT'));
      assert.ok(!err.stdout.includes(missingConfig));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('audit allowlist for NAS snapshot replication', () => {
  it('keeps replication allowlist fields and drops sensitive keys', () => {
    const event = sanitizeAuditEvent(
      {
        type: 'nas.snapshot.replication.completed',
        outcome: 'success',
        targetName: 'primary-nas',
        deviceId: 'device-a',
        snapshotId: SNAPSHOT_PLACEHOLDER,
        attemptId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        errorCode: 'smb-execution-blocked',
        fileCount: 2,
        totalBytes: 12,
        verifiedFileCount: 2,
        retryCount: 1,
        wouldWrite: false,
        executionRequired: true,
        sourcePath: '/private/tmp/source-secret',
        mountPath: '/Volumes/SecretLinkeBackupMount',
        endpoint: 'https://192.168.50.10:5001',
        credentialRef: 'home-backup-secret-ref',
        ownerToken: 'owner-token-must-not-leak',
        password: 'password-value',
        token: 'token-value',
      },
      new Date('2026-07-10T12:00:00.000Z'),
    );

    assert.deepEqual(Object.keys(event).sort(), [
      'attemptId',
      'createdAt',
      'deviceId',
      'errorCode',
      'executionRequired',
      'fileCount',
      'id',
      'outcome',
      'retryCount',
      'snapshotId',
      'targetName',
      'totalBytes',
      'type',
      'verifiedFileCount',
      'wouldWrite',
    ].sort());
    assert.equal(event.targetName, 'primary-nas');
    assert.equal(event.attemptId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    assert.equal(event.errorCode, 'smb-execution-blocked');
    assert.equal(event.totalBytes, 12);
    assert.equal(event.verifiedFileCount, 2);
    assert.equal(event.retryCount, 1);
    assert.equal(event.wouldWrite, false);
    assert.equal(event.executionRequired, true);
    assert.doesNotMatch(
      JSON.stringify(event),
      /source-secret|SecretLinkeBackupMount|192\.168\.50\.10|home-backup-secret-ref|owner-token|password-value|token-value/,
    );
  });

  it('drops negative numeric replication fields', () => {
    const event = sanitizeAuditEvent({
      type: 'nas.snapshot.replication.failed',
      totalBytes: -1,
      verifiedFileCount: -2,
      retryCount: -3,
      fileCount: -4,
    });
    assert.equal(Object.hasOwn(event, 'totalBytes'), false);
    assert.equal(Object.hasOwn(event, 'verifiedFileCount'), false);
    assert.equal(Object.hasOwn(event, 'retryCount'), false);
    assert.equal(Object.hasOwn(event, 'fileCount'), false);
  });
});

/**
 * V1.37 C6: agent appendNasReplicationAudit best-effort honesty.
 * Real appendAuditEvent failure (occupied dual-write state) must not change
 * nas-snapshot-replicate plan exit semantics. Does not modify agent catch.
 * No mail / external network.
 */
describe('C6 agent appendNasReplicationAudit best-effort (audit write failure swallowed)', () => {
  it('dry-run plan exits 0 when dual-write state is occupied; business stdout unchanged; no audit events', async () => {
    const fixture = await createLocalSnapshotFixture();
    try {
      await mkdir(join(fixture.dataDir, 'audit'), { recursive: true });
      await writeFile(
        join(fixture.dataDir, 'audit', 'integrity-dual-write-state.json'),
        'occupied-invalid-state\n',
        { mode: 0o600 },
      );

      const beforeMount = await readdir(fixture.mountPath);
      const { stdout, stderr } = await runAgent(baseArgs(fixture));
      const result = JSON.parse(stdout);

      // Business plan semantics unchanged by audit failure.
      assert.equal(result.command, 'nas-snapshot-replicate');
      assert.equal(result.mode, 'plan');
      assert.equal(result.state, 'planned');
      assert.equal(result.wouldWrite, false);
      assert.deepEqual(await readdir(fixture.mountPath), beforeMount);

      // No successful audit delivery (append swallowed).
      const events = await readAuditEvents(fixture.dataDir, { limit: 20 });
      assert.equal(
        events.filter((e) => String(e.type || '').startsWith('nas.snapshot.replication')).length,
        0,
        'audit events must not appear when dual-write append fails',
      );

      // No path/secret leak on stdout/stderr.
      assert.ok(!stdout.includes(fixture.dataDir));
      assert.ok(!stdout.includes('occupied-invalid-state'));
      assert.ok(!stderr.includes(fixture.dataDir));
      assert.ok(!stderr.includes('occupied-invalid-state'));
      assertNoSensitiveLeak(stdout, stderr, fixture.configPath, fixture.dataDir);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
