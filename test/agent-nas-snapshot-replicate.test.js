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

/**
 * V1.39 C2: NAS execute/recover required start audit fail-closed.
 * required start uses appendAuditEvent directly (not best-effort swallow helper).
 * post-outcome remains best-effort. No e2e/atomic claim.
 */
const NAS_START_TYPE = 'nas.snapshot.replication.started';
const AUDIT_DELIVERY_UNAVAILABLE = 'audit-delivery-unavailable';
const SEED_EVENT = Object.freeze({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  createdAt: '2026-07-20T00:00:00.000Z',
  type: 'api.seed',
  method: 'POST',
  path: '/api/seed',
  outcome: 'success',
});

function dualWriteStateAbs(root) {
  return join(root, 'audit', 'integrity-dual-write-state.json');
}

function auditEventsAbs(root) {
  return join(root, 'audit', 'events.jsonl');
}

function auditJournalAbs(root) {
  return join(root, 'audit', 'integrity-journal.jsonl');
}

/**
 * Deterministic raw-byte snapshot of dual-write store files.
 * Missing path → null (ENOENT only). Any other read error propagates (no swallow).
 */
async function snapshotAuditStoreBytes(root) {
  const paths = {
    state: dualWriteStateAbs(root),
    events: auditEventsAbs(root),
    journal: auditJournalAbs(root),
  };
  const out = {};
  for (const [key, abs] of Object.entries(paths)) {
    try {
      out[key] = await readFile(abs);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        out[key] = null;
      } else {
        throw error;
      }
    }
  }
  return out;
}

function assertBufferOrNullEqual(actual, expected, label) {
  if (expected === null) {
    assert.equal(actual, null, `${label} must remain absent`);
    return;
  }
  assert.ok(Buffer.isBuffer(actual), `${label} must be a Buffer`);
  assert.ok(Buffer.isBuffer(expected), `${label} expected must be a Buffer`);
  assert.equal(actual.equals(expected), true, `${label} raw bytes must be unchanged`);
}

function assertAuditStoreBytesUnchanged(before, after) {
  assertBufferOrNullEqual(after.state, before.state, 'dual-write state');
  assertBufferOrNullEqual(after.events, before.events, 'events.jsonl');
  assertBufferOrNullEqual(after.journal, before.journal, 'integrity-journal.jsonl');
}

/**
 * Hard: no delivered started event. Uses readAuditEvents without catch-swallow.
 * Also scans raw events bytes when the file exists.
 */
async function assertNoDeliveredNasStart(dataDir) {
  const events = await readAuditEvents(dataDir, { limit: 50 });
  assert.equal(
    events.filter((e) => e && e.type === NAS_START_TYPE).length,
    0,
    'required start must not be delivered',
  );
  const raw = await snapshotAuditStoreBytes(dataDir);
  if (raw.events !== null) {
    const text = raw.events.toString('utf8');
    // Line-oriented exact type token; refuse silent presence of started delivery.
    assert.equal(
      text.split('\n').some((line) => {
        if (!line.trim()) return false;
        try {
          const parsed = JSON.parse(line);
          return parsed && parsed.type === NAS_START_TYPE;
        } catch {
          return false;
        }
      }),
      false,
      'events.jsonl must not contain a delivered nas.snapshot.replication.started line',
    );
  }
}

/** Mount target directory snapshot: entries + per-file raw bytes (empty expected for fail-closed). */
async function snapshotMountTarget(mountPath) {
  const names = (await readdir(mountPath)).slice().sort();
  const files = {};
  for (const name of names) {
    files[name] = await readFile(join(mountPath, name));
  }
  return { names, files };
}

function assertMountTargetUnchanged(before, after) {
  assert.deepEqual(after.names, before.names, 'mount target entries must be unchanged');
  assert.deepEqual(Object.keys(after.files).sort(), Object.keys(before.files).sort());
  for (const name of before.names) {
    assert.equal(
      after.files[name].equals(before.files[name]),
      true,
      `mount target file bytes changed: ${name}`,
    );
  }
}

async function makeInvalidDualWriteState(root) {
  await mkdir(join(root, 'audit'), { recursive: true });
  await writeFile(dualWriteStateAbs(root), 'occupied-invalid-state\n', { mode: 0o600 });
}

function isTestCrash(error, code) {
  return Boolean(error && error.code === code);
}

async function makeRecoverablePrepared(root) {
  const {
    appendAuditEventWithIntegrityDualWrite,
    DUAL_WRITE_TEST_CRASH_HOOK,
  } = await import('../src/audit-integrity-dual-write.js');
  await assert.rejects(
    () => appendAuditEventWithIntegrityDualWrite(root, { ...SEED_EVENT }, {
      [DUAL_WRITE_TEST_CRASH_HOOK]: 'after-prepared',
    }),
    (e) => isTestCrash(e, 'TEST_CRASH_AFTER_PREPARED'),
  );
  const raw = await readFile(dualWriteStateAbs(root), 'utf8');
  assert.match(raw, /"status"\s*:\s*"prepared"/);
}

async function makeUnrecoverablePrepared(root) {
  const {
    appendAuditEventWithIntegrityDualWrite,
    DUAL_WRITE_TEST_CRASH_HOOK,
  } = await import('../src/audit-integrity-dual-write.js');
  const stateMod = await import('../src/audit-integrity-dual-write-state.js');
  const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
  const { enqueueAuditIntegrityWriteTask } = await import('../src/audit-integrity-write-queue.js');

  await assert.rejects(
    () => appendAuditEventWithIntegrityDualWrite(root, { ...SEED_EVENT }, {
      [DUAL_WRITE_TEST_CRASH_HOOK]: 'after-prepared',
    }),
    (e) => isTestCrash(e, 'TEST_CRASH_AFTER_PREPARED'),
  );
  const prepared = JSON.parse(await readFile(dualWriteStateAbs(root), 'utf8'));
  const badPostSha = prepared.journal.post.rawSha256.replace(/[0-9a-f]/, (c) => (c === 'a' ? 'b' : 'a'));
  const mutated = {
    ...prepared,
    journal: {
      pre: { ...prepared.journal.pre },
      post: { ...prepared.journal.post, rawSha256: badPostSha },
    },
    events: {
      pre: { ...prepared.events.pre },
      post: { ...prepared.events.post },
    },
    event: { ...prepared.event },
    retention: prepared.retention,
  };
  const resolvedRoot = await assertSafeDataRoot(root);
  await enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => {
    await stateMod.publishDualWriteStateUnlocked(resolvedRoot, lease, mutated);
  });
}

function assertNasStartShape(event, fixture) {
  assert.equal(event.type, NAS_START_TYPE);
  assert.equal(event.outcome, 'started');
  assert.equal(event.targetName, fixture.target);
  assert.equal(event.deviceId, fixture.deviceId);
  assert.equal(event.snapshotId, fixture.snapshotId);
  assert.equal(typeof event.id, 'string');
  assert.equal(typeof event.createdAt, 'string');
  const json = JSON.stringify(event);
  assert.ok(!json.includes(fixture.mountPath), 'start audit must not leak mountPath');
  assert.ok(!json.includes(fixture.dataDir), 'start audit must not leak dataDir');
  assert.ok(!json.includes(fixture.configPath), 'start audit must not leak configPath');
  assert.ok(!json.includes('home-backup-secret-ref'));
  assert.ok(!json.includes('password-value'));
  assert.ok(!json.includes('token-value'));
  assert.ok(!json.includes('owner-token-must-not-leak'));
  assert.doesNotMatch(json, /sourcePath|mountPath|endpoint|credentialRef|remotePath/);
}

function assertFixedAuditDeliveryStderr(err) {
  assert.equal(err.code, 1);
  assert.match(err.stderr, /^Error: audit-delivery-unavailable\s*$/m);
  assert.equal(
    err.stderr.trim(),
    `Error: ${AUDIT_DELIVERY_UNAVAILABLE}`,
  );
  assert.equal(err.stdout, '');
  assert.ok(!err.stderr.includes('occupied-invalid-state'));
  assert.ok(!err.stderr.includes('integrity-dual-write'));
  assert.ok(!err.stderr.includes('ENOENT'));
  assert.ok(!err.stderr.includes('EACCES'));
  assert.doesNotMatch(err.stderr, /at\s+\S+\s+\(/);
}

describe('V1.39 C2 NAS required start audit fail-closed', () => {
  it('execute + healthy audit store: exact-one started before SMB side-effect failure path', async () => {
    const fixture = await createLocalSnapshotFixture();
    try {
      const mountBefore = await snapshotMountTarget(fixture.mountPath);
      const err = await rejectAgent(baseArgs(fixture, ['--execute']), 2, {
        LINKE_NAS_SMB_EXECUTION: 'enabled',
      });
      // Non-smbfs fixture: admission must succeed, then mount gate fails (proves order).
      assert.match(err.stderr, /Error: smb-mount-required/);
      assertMountTargetUnchanged(mountBefore, await snapshotMountTarget(fixture.mountPath));

      const events = await readAuditEvents(fixture.dataDir, { limit: 20 });
      const started = events.filter((e) => e.type === NAS_START_TYPE);
      assert.equal(started.length, 1, 'exact-one required start audit');
      assertNasStartShape(started[0], fixture);

      // Newest-first: business failure after start → failed is newer than started.
      const nasEvents = events.filter((e) => String(e.type || '').startsWith('nas.snapshot.replication'));
      const failedIdx = nasEvents.findIndex((e) => e.type === 'nas.snapshot.replication.failed');
      const startedIdx = nasEvents.findIndex((e) => e.type === NAS_START_TYPE);
      assert.ok(failedIdx >= 0, 'post-outcome failure audit expected after SMB gate');
      assert.ok(startedIdx >= 0);
      assert.ok(
        failedIdx < startedIdx,
        'failed audit must be newer than started (start before SMB side effect)',
      );
      assert.equal(nasEvents[failedIdx].errorCode, 'smb-mount-required');

      assertNoSensitiveLeak(err.stdout, err.stderr, fixture.configPath, fixture.dataDir, fixture.mountPath);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('recover + execute: exact-one required start before recover SMB helper path', async () => {
    const fixture = await createLocalSnapshotFixture();
    try {
      const mountBefore = await snapshotMountTarget(fixture.mountPath);
      const err = await rejectAgent(baseArgs(fixture, ['--execute', '--recover']), 2, {
        LINKE_NAS_SMB_EXECUTION: 'enabled',
      });
      assert.match(err.stderr, /Error: smb-mount-required|Error: recovery_required|Error: smb-execution-blocked/);
      assertMountTargetUnchanged(mountBefore, await snapshotMountTarget(fixture.mountPath));

      const events = await readAuditEvents(fixture.dataDir, { limit: 20 });
      const started = events.filter((e) => e.type === NAS_START_TYPE);
      assert.equal(started.length, 1, 'exact-one required start on recover path');
      assertNasStartShape(started[0], fixture);

      const nasEvents = events.filter((e) => String(e.type || '').startsWith('nas.snapshot.replication'));
      const startedIdx = nasEvents.findIndex((e) => e.type === NAS_START_TYPE);
      assert.ok(startedIdx >= 0);
      // If a post-start failure/recovery event exists, it must be newer than started.
      const postIdx = nasEvents.findIndex((e) => (
        e.type === 'nas.snapshot.replication.failed'
        || e.type === 'nas.snapshot.replication.recovery_required'
      ));
      if (postIdx >= 0) {
        assert.ok(postIdx < startedIdx, 'post-outcome audit must follow required start');
      }

      assertNoSensitiveLeak(err.stdout, err.stderr, fixture.configPath, fixture.dataDir, fixture.mountPath);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('execute + legal recoverable prepared: auto-recover then required start succeeds; not admission 503', async () => {
    const fixture = await createLocalSnapshotFixture();
    try {
      await makeRecoverablePrepared(fixture.dataDir);
      const stateBefore = await readFile(dualWriteStateAbs(fixture.dataDir), 'utf8');
      assert.match(stateBefore, /"status"\s*:\s*"prepared"/);

      const beforeMount = await readdir(fixture.mountPath);
      const err = await rejectAgent(baseArgs(fixture, ['--execute']), 2, {
        LINKE_NAS_SMB_EXECUTION: 'enabled',
      });
      // Admission must succeed (recoverable prepared auto-recovers); SMB fixture still non-smbfs.
      assert.match(err.stderr, /Error: smb-mount-required/);
      assert.ok(!err.stderr.includes(AUDIT_DELIVERY_UNAVAILABLE));
      assert.deepEqual(await readdir(fixture.mountPath), beforeMount);

      const events = await readAuditEvents(fixture.dataDir, { limit: 30 });
      const started = events.filter((e) => e.type === NAS_START_TYPE);
      assert.equal(started.length, 1);
      assertNasStartShape(started[0], fixture);

      // recovery + append may change dual-write state/events/journal bytes — must not be prepared leftover.
      const stateAfter = await readFile(dualWriteStateAbs(fixture.dataDir), 'utf8');
      assert.notEqual(stateAfter, stateBefore, 'recoverable prepared bytes may change via recovery+append');
      assert.ok(
        !/"status"\s*:\s*"prepared"/.test(stateAfter),
        'state must leave prepared after auto-recover + admission append',
      );

      assertNoSensitiveLeak(err.stdout, err.stderr, fixture.configPath, fixture.dataDir);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('execute + invalid dual-write state: exit 1 fixed code; zero SMB side effect; no secret/path leak', async () => {
    const fixture = await createLocalSnapshotFixture();
    try {
      await makeInvalidDualWriteState(fixture.dataDir);
      const mountBefore = await snapshotMountTarget(fixture.mountPath);
      const auditBefore = await snapshotAuditStoreBytes(fixture.dataDir);
      const mountMarker = join(fixture.mountPath, 'must-not-be-created-by-admission-fail');
      // Ensure target dir is empty and stays empty (0 SMB writes).
      assert.deepEqual(mountBefore.names, []);

      const err = await rejectAgent(baseArgs(fixture, ['--execute']), 1, {
        LINKE_NAS_SMB_EXECUTION: 'enabled',
      });
      assertFixedAuditDeliveryStderr(err);
      assertMountTargetUnchanged(mountBefore, await snapshotMountTarget(fixture.mountPath));
      await assert.rejects(() => readFile(mountMarker), { code: 'ENOENT' });

      // Hard: no delivered started; raw dual-write store bytes unchanged; no catch-swallow.
      await assertNoDeliveredNasStart(fixture.dataDir);
      assertAuditStoreBytesUnchanged(auditBefore, await snapshotAuditStoreBytes(fixture.dataDir));

      assert.ok(!err.stderr.includes(fixture.dataDir));
      assert.ok(!err.stderr.includes(fixture.mountPath));
      assert.ok(!err.stderr.includes(fixture.configPath));
      assertNoSensitiveLeak(err.stdout, err.stderr, fixture.configPath, fixture.dataDir, fixture.mountPath);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('execute + unrecoverable prepared: exit 1 fixed code; zero SMB; no delivered started; store frozen', async () => {
    const fixture = await createLocalSnapshotFixture();
    try {
      await makeUnrecoverablePrepared(fixture.dataDir);
      const mountBefore = await snapshotMountTarget(fixture.mountPath);
      const auditBefore = await snapshotAuditStoreBytes(fixture.dataDir);
      assert.match(auditBefore.state.toString('utf8'), /"status"\s*:\s*"prepared"/);

      const err = await rejectAgent(baseArgs(fixture, ['--execute']), 1, {
        LINKE_NAS_SMB_EXECUTION: 'enabled',
      });
      assertFixedAuditDeliveryStderr(err);
      assertMountTargetUnchanged(mountBefore, await snapshotMountTarget(fixture.mountPath));

      // Hard started=0 (no catch-swallow). Recovery conflict keeps prepared; no new events/journal bytes.
      await assertNoDeliveredNasStart(fixture.dataDir);
      const auditAfter = await snapshotAuditStoreBytes(fixture.dataDir);
      assertAuditStoreBytesUnchanged(auditBefore, auditAfter);
      assert.match(auditAfter.state.toString('utf8'), /"status"\s*:\s*"prepared"/);

      assert.ok(!err.stderr.includes('rawSha256'));
      assert.ok(!err.stderr.includes('recovery-conflict'));
      assert.ok(!err.stderr.includes(fixture.dataDir));
      assertNoSensitiveLeak(err.stdout, err.stderr, fixture.configPath, fixture.dataDir);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('recover + unrecoverable prepared: exit 1 fixed code; zero SMB; no delivered started; store frozen', async () => {
    const fixture = await createLocalSnapshotFixture();
    try {
      await makeUnrecoverablePrepared(fixture.dataDir);
      const mountBefore = await snapshotMountTarget(fixture.mountPath);
      const auditBefore = await snapshotAuditStoreBytes(fixture.dataDir);

      const err = await rejectAgent(baseArgs(fixture, ['--execute', '--recover']), 1, {
        LINKE_NAS_SMB_EXECUTION: 'enabled',
      });
      assertFixedAuditDeliveryStderr(err);
      assertMountTargetUnchanged(mountBefore, await snapshotMountTarget(fixture.mountPath));

      await assertNoDeliveredNasStart(fixture.dataDir);
      assertAuditStoreBytesUnchanged(auditBefore, await snapshotAuditStoreBytes(fixture.dataDir));
      assertNoSensitiveLeak(err.stdout, err.stderr, fixture.configPath, fixture.dataDir);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('plan-only does not require start admission; broken audit store keeps plan exit 0', async () => {
    const fixture = await createLocalSnapshotFixture();
    try {
      await makeInvalidDualWriteState(fixture.dataDir);
      const mountBefore = await snapshotMountTarget(fixture.mountPath);
      const { stdout, stderr } = await runAgent(baseArgs(fixture));
      const result = JSON.parse(stdout);

      assert.equal(result.mode, 'plan');
      assert.equal(result.state, 'planned');
      assert.equal(result.wouldWrite, false);
      assert.ok(!stderr.includes(AUDIT_DELIVERY_UNAVAILABLE));
      assertMountTargetUnchanged(mountBefore, await snapshotMountTarget(fixture.mountPath));

      // plan-only: readAuditEvents is hard (no catch-swallow → empty success).
      await assertNoDeliveredNasStart(fixture.dataDir);
      assertNoSensitiveLeak(stdout, stderr, fixture.configPath, fixture.dataDir);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('argv invalid path never writes required start admission', async () => {
    const fixture = await createLocalSnapshotFixture();
    try {
      const err = await rejectAgent(baseArgs(fixture, ['--execute', 'true']), 1);
      assert.match(err.stderr, /Error: smb-arguments-invalid/);
      assert.ok(!err.stderr.includes(AUDIT_DELIVERY_UNAVAILABLE));

      const events = await readAuditEvents(fixture.dataDir, { limit: 20 });
      assert.equal(events.filter((e) => e.type === NAS_START_TYPE).length, 0);
      assert.deepEqual(await readdir(fixture.mountPath), []);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('execution blocked without env gate still requires start then business code (not admission 503)', async () => {
    const fixture = await createLocalSnapshotFixture();
    try {
      const err = await rejectAgent(baseArgs(fixture, ['--execute']), 2, {
        LINKE_NAS_SMB_EXECUTION: '',
      });
      assert.match(err.stderr, /Error: smb-execution-blocked/);
      assert.ok(!err.stderr.includes(AUDIT_DELIVERY_UNAVAILABLE));

      const events = await readAuditEvents(fixture.dataDir, { limit: 20 });
      const started = events.filter((e) => e.type === NAS_START_TYPE);
      assert.equal(started.length, 1);
      assertNasStartShape(started[0], fixture);
      const failed = events.find((e) => e.type === 'nas.snapshot.replication.failed');
      assert.ok(failed);
      assert.equal(failed.errorCode, 'smb-execution-blocked');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('required failure is not overridden by optional best-effort failure audit under broken store', async () => {
    // invalid dual-write: required start throws; optional failure audit also cannot write.
    // stderr/exit must remain exact fixed code (must not become nas-snapshot-replicate-failed).
    const fixture = await createLocalSnapshotFixture();
    try {
      await makeInvalidDualWriteState(fixture.dataDir);
      const err = await rejectAgent(baseArgs(fixture, ['--execute']), 1, {
        LINKE_NAS_SMB_EXECUTION: 'enabled',
      });
      assertFixedAuditDeliveryStderr(err);
      assert.ok(!err.stderr.includes('nas-snapshot-replicate-failed'));
      assert.ok(!err.stderr.includes('smb-mount-required'));
      assert.ok(!err.stderr.includes('smb-execution-blocked'));
      assert.deepEqual(await readdir(fixture.mountPath), []);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it('source contract: required helper + code=== catch before SmbReplicationError; not instanceof-only', async () => {
    const source = await readFile(new URL('../src/agent.js', import.meta.url), 'utf8');

    // Helper must call appendAuditEvent directly (not route through swallow helper).
    assert.match(
      source,
      /async function recordRequiredNasReplicationStartAudit\s*\(/,
      'required helper must exist',
    );
    const helperStart = source.indexOf('async function recordRequiredNasReplicationStartAudit');
    assert.ok(helperStart >= 0);
    const helperEnd = source.indexOf('\nasync function ', helperStart + 1);
    const helperBody = source.slice(helperStart, helperEnd > helperStart ? helperEnd : helperStart + 800);
    assert.match(helperBody, /appendAuditEvent\s*\(/);
    assert.ok(
      !helperBody.includes('appendNasReplicationAudit'),
      'required helper must not call best-effort appendNasReplicationAudit',
    );
    assert.match(helperBody, /AUDIT_DELIVERY_UNAVAILABLE/);
    assert.match(helperBody, /statusCode:\s*503/);
    assert.match(helperBody, /retryable:\s*true/);
    // Remap catch must rethrow — no empty swallow.
    assert.ok(!/catch\s*\{\s*\}/.test(helperBody), 'required helper must not empty-swallow');
    assert.ok(!helperBody.includes('.catch('), 'required helper must not use promise swallow');

    // execute path must await required helper before SMB helpers in the same control flow.
    const caseIdx = source.indexOf("case 'nas-snapshot-replicate'");
    assert.ok(caseIdx >= 0);
    const caseSlice = source.slice(caseIdx, caseIdx + 4500);
    // Exact awaited production call (not a comment/string decoy).
    assert.match(
      caseSlice,
      /if\s*\(\s*replicationOptions\.execute\s*\)\s*\{[\s\S]*?await\s+recordRequiredNasReplicationStartAudit\s*\(/,
      'execute gate must await recordRequiredNasReplicationStartAudit',
    );
    const requiredCallIdx = caseSlice.search(/await\s+recordRequiredNasReplicationStartAudit\s*\(/);
    // Same-branch ternary: recover / replicate only after required await.
    assert.match(
      caseSlice,
      /const\s+result\s*=\s*replicationOptions\.recover\s*===\s*true\s*\n\s*\?\s*await\s+recoverMountedSmbSnapshot\s*\(/,
      'recover SMB helper must be in production ternary after start',
    );
    assert.match(
      caseSlice,
      /:\s*replicationOptions\.execute\s*===\s*true\s*\n\s*\?\s*await\s+replicateSnapshotToMountedSmb\s*\(/,
      'replicate SMB helper must be in production ternary after start',
    );
    const recoverIdx = caseSlice.search(/await\s+recoverMountedSmbSnapshot\s*\(/);
    const replicateIdx = caseSlice.search(/await\s+replicateSnapshotToMountedSmb\s*\(/);
    assert.ok(requiredCallIdx >= 0, 'execute path must await required start helper');
    assert.ok(recoverIdx > requiredCallIdx, 'recover await must follow required start await');
    assert.ok(replicateIdx > requiredCallIdx, 'replicate await must follow required start await');
    // Must not use best-effort helper for the started event on execute path.
    assert.ok(
      !/appendNasReplicationAudit\([^)]*nas\.snapshot\.replication\.started/.test(caseSlice),
      'started must not go through best-effort appendNasReplicationAudit',
    );
    // Best-effort helper must remain empty-swallow (no stderr pollution via err.message).
    const bestEffortFn = source.slice(
      source.indexOf('async function appendNasReplicationAudit'),
      source.indexOf('async function appendNasReplicationAudit') + 400,
    );
    assert.equal(
      bestEffortFn.includes('console.error'),
      false,
      'appendNasReplicationAudit must not console.error (server recordAudit only)',
    );
    assert.equal(
      /appendAuditEvent\s*\([^)]*retention/.test(source),
      false,
      'agent appendAuditEvent calls must not pass retention (server-only concern)',
    );

    // Catch recognition: err.code === AUDIT_DELIVERY_UNAVAILABLE first; not instanceof-only.
    const catchIdx = caseSlice.indexOf('} catch (err)');
    assert.ok(catchIdx >= 0, 'nas case must have catch');
    const catchSlice = caseSlice.slice(catchIdx, catchIdx + 1200);
    const codeCheckIdx = catchSlice.search(
      /err\s*&&\s*err\.code\s*===\s*ERROR_CODES\.AUDIT_DELIVERY_UNAVAILABLE/,
    );
    assert.ok(codeCheckIdx >= 0, 'catch must use err && err.code === ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE');
    const smbCheckIdx = catchSlice.indexOf('instanceof SmbReplicationError');
    assert.ok(smbCheckIdx >= 0, 'SmbReplicationError branch must remain');
    assert.ok(
      codeCheckIdx < smbCheckIdx,
      'AUDIT_DELIVERY_UNAVAILABLE code check must precede SmbReplicationError',
    );
    // Forbidden: recognition gated on instanceof LinkeError (code-form only is required).
    // Match executable forms only — comments may mention the forbidden pattern.
    assert.equal(
      /if\s*\(\s*err\s+instanceof\s+LinkeError/.test(catchSlice),
      false,
      'must not gate admission catch on instanceof LinkeError',
    );
    assert.equal(
      /err\s+instanceof\s+LinkeError\s*&&/.test(catchSlice),
      false,
      'must not require instanceof LinkeError to recognize admission failure',
    );

    // Fixed stderr string for admission failure branch.
    assert.match(
      catchSlice,
      /console\.error\(\s*['"]Error: audit-delivery-unavailable['"]\s*\)/,
    );
    assert.match(catchSlice, /process\.exit\(\s*1\s*\)/);

    // Post-outcome best-effort honesty: appendNasReplicationAudit still has swallow catch.
    const bestEffortIdx = source.indexOf('async function appendNasReplicationAudit');
    assert.ok(bestEffortIdx >= 0);
    const bestEffortBody = source.slice(bestEffortIdx, bestEffortIdx + 350);
    assert.match(bestEffortBody, /catch\s*\{/);
  });
});
