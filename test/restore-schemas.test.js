import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import {
  RESTORE_CHUNK_SIZE,
  MAX_RESTORE_TASK_JSON_BYTES,
  projectTaskJson,
  projectStatusJson,
  projectReceiptObject,
  projectCleanupReceipt,
  projectProgressBody,
  assertFingerprintNullability,
} from '../src/restore-schemas.js';

const TASK_INVALID = ERROR_CODES.RESTORE_TASK_INVALID;

const TASK_ID = '550e8400-e29b-41d4-a716-446655440001';
const SNAPSHOT_ID = '550e8400-e29b-41d4-a716-446655440002';
const RECEIPT_ID = '550e8400-e29b-41d4-a716-446655440003';
const CLEANUP_ID = '550e8400-e29b-41d4-a716-446655440004';
const OTHER_TASK_ID = '550e8400-e29b-41d4-a716-446655440099';
const OTHER_RECEIPT_ID = '550e8400-e29b-41d4-a716-446655440098';
const DEVICE_ID = 'device-alpha-001';
const OTHER_DEVICE_ID = 'device-beta-002';
const MANIFEST_DIGEST = 'a'.repeat(64);
const CONTENT_SHA = 'b'.repeat(64);
const STRUCTURE_FP = 'c'.repeat(64);
const ISO_T0 = '2026-07-23T12:00:00.000Z';
const ISO_T1 = '2026-07-23T12:01:00.000Z';
const ISO_T2 = '2026-07-23T12:02:00.000Z';
const ISO_T3 = '2026-07-23T12:03:00.000Z';

const TASK_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'deviceId',
  'snapshotId',
  'manifestDigest',
  'relativeTarget',
  'createdAt',
  'fileCount',
  'totalBytes',
  'chunkSize',
]);

const STATUS_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'status',
  'updatedAt',
  'claimedAt',
  'completedAt',
  'receipt',
  'receiptAckAt',
  'cleanupAuthorized',
  'cleanupReceipt',
  'cleanupAckAt',
  'cancelRequestedAt',
  'lastProgress',
]);

const RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'taskId',
  'deviceId',
  'snapshotId',
  'manifestDigest',
  'outcome',
  'relativeTarget',
  'totalBytes',
  'fileCount',
  'contentSha256',
  'structureFingerprint',
  'publishedVerifiedAt',
  'rolledBackAt',
  'anchorPresentBeforePublish',
  'receiptId',
]);

const CLEANUP_KEYS = Object.freeze([
  'schemaVersion',
  'cleanupId',
  'taskId',
  'deviceId',
  'outcome',
  'receiptId',
  'cleanedAt',
]);

const PROGRESS_KEYS = Object.freeze(['fileIndex', 'chunkIndex', 'receivedBytes']);

/**
 * Expect restore-task-invalid without leaking hostile tokens.
 * @param {() => unknown} fn
 * @param {{ leakTokens?: string[] }} [opts]
 */
function expectTaskInvalid(fn, { leakTokens = [] } = {}) {
  assert.throws(
    fn,
    (error) => {
      assert.ok(error instanceof LinkeError);
      assert.strictEqual(error.code, TASK_INVALID);
      assert.strictEqual(error.message, TASK_INVALID);
      assert.strictEqual(error.code, 'restore-task-invalid');
      assert.strictEqual(error.message, 'restore-task-invalid');
      const publicParts = [
        error.code,
        error.message,
        error.name,
        String(error.statusCode),
        String(error.retryable),
      ].join('\0');
      for (const token of leakTokens) {
        if (token === '' || token == null) continue;
        assert.ok(!publicParts.includes(String(token)), 'public fields must not echo hostile token');
      }
      assert.ok(!publicParts.includes('/Users/'));
      assert.ok(!publicParts.includes('secret-token'));
      assert.ok(!publicParts.includes('GETTER_SENTINEL'));
      assert.ok(!publicParts.includes('PROXY_SENTINEL'));
      return true;
    },
  );
}

function validTask(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: TASK_ID,
    deviceId: DEVICE_ID,
    snapshotId: SNAPSHOT_ID,
    manifestDigest: MANIFEST_DIGEST,
    relativeTarget: 'docs/restore-target',
    createdAt: ISO_T0,
    fileCount: 1,
    totalBytes: 0,
    chunkSize: 8_388_608,
    ...overrides,
  };
}

function validCompletedReceipt(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: TASK_ID,
    deviceId: DEVICE_ID,
    snapshotId: SNAPSHOT_ID,
    manifestDigest: MANIFEST_DIGEST,
    outcome: 'completed',
    relativeTarget: 'docs/restore-target',
    totalBytes: 0,
    fileCount: 1,
    contentSha256: CONTENT_SHA,
    structureFingerprint: STRUCTURE_FP,
    publishedVerifiedAt: ISO_T1,
    rolledBackAt: null,
    anchorPresentBeforePublish: false,
    receiptId: RECEIPT_ID,
    ...overrides,
  };
}

function validRolledBackReceipt(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: TASK_ID,
    deviceId: DEVICE_ID,
    snapshotId: SNAPSHOT_ID,
    manifestDigest: MANIFEST_DIGEST,
    outcome: 'rolled-back',
    relativeTarget: 'docs/restore-target',
    totalBytes: 0,
    fileCount: 1,
    contentSha256: CONTENT_SHA,
    structureFingerprint: STRUCTURE_FP,
    publishedVerifiedAt: null,
    rolledBackAt: ISO_T1,
    anchorPresentBeforePublish: true,
    receiptId: RECEIPT_ID,
    ...overrides,
  };
}

function validCleanupCompleted(overrides = {}) {
  return {
    schemaVersion: 1,
    cleanupId: CLEANUP_ID,
    taskId: TASK_ID,
    deviceId: DEVICE_ID,
    outcome: 'completed',
    receiptId: RECEIPT_ID,
    cleanedAt: ISO_T2,
    ...overrides,
  };
}

function validCleanupCancelled(overrides = {}) {
  return {
    schemaVersion: 1,
    cleanupId: CLEANUP_ID,
    taskId: TASK_ID,
    deviceId: DEVICE_ID,
    outcome: 'cancelled',
    receiptId: null,
    cleanedAt: ISO_T2,
    ...overrides,
  };
}

function validStatusPending(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: TASK_ID,
    status: 'pending',
    updatedAt: ISO_T0,
    claimedAt: null,
    completedAt: null,
    receipt: null,
    receiptAckAt: null,
    cleanupAuthorized: false,
    cleanupReceipt: null,
    cleanupAckAt: null,
    cancelRequestedAt: null,
    lastProgress: null,
    ...overrides,
  };
}

function validStatusActive(overrides = {}) {
  return validStatusPending({
    status: 'active',
    claimedAt: ISO_T0,
    lastProgress: {
      fileIndex: 0,
      chunkIndex: 0,
      receivedBytes: 0,
      updatedAt: ISO_T0,
    },
    ...overrides,
  });
}

function validStatusCompleted(overrides = {}) {
  return validStatusPending({
    status: 'completed',
    claimedAt: ISO_T0,
    completedAt: ISO_T1,
    receipt: validCompletedReceipt(),
    receiptAckAt: ISO_T1,
    cleanupAuthorized: true,
    cleanupReceipt: null,
    cleanupAckAt: null,
    cancelRequestedAt: null,
    lastProgress: {
      fileIndex: 0,
      chunkIndex: 0,
      receivedBytes: 0,
      updatedAt: ISO_T1,
    },
    ...overrides,
  });
}

function validStatusRolledBack(overrides = {}) {
  return validStatusPending({
    status: 'rolled-back',
    claimedAt: ISO_T0,
    completedAt: ISO_T1,
    receipt: validRolledBackReceipt(),
    receiptAckAt: ISO_T1,
    cleanupAuthorized: true,
    cleanupReceipt: null,
    cleanupAckAt: null,
    cancelRequestedAt: null,
    lastProgress: null,
    ...overrides,
  });
}

/** Active-cancel branch: claimed + CleanupReceipt(outcome=cancelled) + cleanupAckAt. */
function validStatusCancelled(overrides = {}) {
  return validStatusPending({
    status: 'cancelled',
    claimedAt: ISO_T0,
    completedAt: null,
    receipt: null,
    receiptAckAt: null,
    cleanupAuthorized: false,
    cleanupReceipt: validCleanupCancelled(),
    cleanupAckAt: ISO_T2,
    cancelRequestedAt: ISO_T1,
    lastProgress: null,
    ...overrides,
  });
}

/** Pending-direct cancel: never claimed; no cleanup artifacts. */
function validStatusCancelledPendingDirect(overrides = {}) {
  return validStatusPending({
    status: 'cancelled',
    claimedAt: null,
    completedAt: null,
    receipt: null,
    receiptAckAt: null,
    cleanupAuthorized: false,
    cleanupReceipt: null,
    cleanupAckAt: null,
    cancelRequestedAt: ISO_T1,
    lastProgress: null,
    ...overrides,
  });
}

function validStatusCleaned(overrides = {}) {
  return validStatusPending({
    status: 'cleaned',
    claimedAt: ISO_T0,
    completedAt: ISO_T1,
    receipt: validCompletedReceipt(),
    receiptAckAt: ISO_T1,
    cleanupAuthorized: true,
    cleanupReceipt: validCleanupCompleted(),
    cleanupAckAt: ISO_T3,
    cancelRequestedAt: null,
    lastProgress: {
      fileIndex: 0,
      chunkIndex: 0,
      receivedBytes: 0,
      updatedAt: ISO_T1,
    },
    ...overrides,
  });
}

/** Cleaned after rolled-back business terminal; cleanup outcome matches receipt. */
function validStatusCleanedRolledBack(overrides = {}) {
  return validStatusPending({
    status: 'cleaned',
    claimedAt: ISO_T0,
    completedAt: ISO_T1,
    receipt: validRolledBackReceipt(),
    receiptAckAt: ISO_T1,
    cleanupAuthorized: true,
    cleanupReceipt: validCleanupCompleted({ outcome: 'rolled-back' }),
    cleanupAckAt: ISO_T3,
    cancelRequestedAt: null,
    lastProgress: null,
    ...overrides,
  });
}

function validProgress(overrides = {}) {
  return {
    fileIndex: 0,
    chunkIndex: 0,
    receivedBytes: 0,
    ...overrides,
  };
}

describe('restore schema constants', () => {
  it('exports exact RESTORE_CHUNK_SIZE and MAX_RESTORE_TASK_JSON_BYTES', () => {
    assert.strictEqual(RESTORE_CHUNK_SIZE, 8_388_608);
    assert.strictEqual(MAX_RESTORE_TASK_JSON_BYTES, 1_048_576);
  });
});

describe('projectTaskJson', () => {
  it('projects exact keys/order/values, matches expectedTaskId, freezes output', () => {
    const input = validTask();
    const projected = projectTaskJson(input, { expectedTaskId: TASK_ID });
    assert.deepStrictEqual(Object.keys(projected), [...TASK_KEYS]);
    assert.deepStrictEqual(projected, {
      schemaVersion: 1,
      taskId: TASK_ID,
      deviceId: DEVICE_ID,
      snapshotId: SNAPSHOT_ID,
      manifestDigest: MANIFEST_DIGEST,
      relativeTarget: 'docs/restore-target',
      createdAt: ISO_T0,
      fileCount: 1,
      totalBytes: 0,
      chunkSize: 8_388_608,
    });
    assert.ok(Object.isFrozen(projected));
    assert.throws(() => {
      projected.schemaVersion = 99;
    }, TypeError);
  });

  it('accepts boundary fileCount 100_000 and deviceId 256 UTF-8 bytes', () => {
    const device256 = 'd'.repeat(256);
    assert.strictEqual(Buffer.byteLength(device256, 'utf8'), 256);
    const projected = projectTaskJson(
      validTask({ fileCount: 100_000, deviceId: device256 }),
      { expectedTaskId: TASK_ID },
    );
    assert.strictEqual(projected.fileCount, 100_000);
    assert.strictEqual(projected.deviceId, device256);
  });

  it('rejects unknown or missing keys and forbidden endpoint/token-like keys', () => {
    expectTaskInvalid(
      () => projectTaskJson(validTask({ extra: true }), { expectedTaskId: TASK_ID }),
      { leakTokens: ['extra'] },
    );
    expectTaskInvalid(
      () => projectTaskJson(validTask({ endpoint: '/Users/secret' }), { expectedTaskId: TASK_ID }),
      { leakTokens: ['/Users/secret', 'endpoint'] },
    );
    expectTaskInvalid(
      () => projectTaskJson(validTask({ path: '/abs' }), { expectedTaskId: TASK_ID }),
      { leakTokens: ['/abs'] },
    );
    expectTaskInvalid(
      () => projectTaskJson(validTask({ hostname: 'evil.example' }), { expectedTaskId: TASK_ID }),
      { leakTokens: ['evil.example'] },
    );
    expectTaskInvalid(
      () => projectTaskJson(validTask({ ipAddress: '10.0.0.1' }), { expectedTaskId: TASK_ID }),
      { leakTokens: ['10.0.0.1'] },
    );
    expectTaskInvalid(
      () => projectTaskJson(validTask({ token: 'secret-token' }), { expectedTaskId: TASK_ID }),
      { leakTokens: ['secret-token'] },
    );
    expectTaskInvalid(
      () => projectTaskJson(validTask({ accessToken: 'secret-token' }), { expectedTaskId: TASK_ID }),
      { leakTokens: ['secret-token'] },
    );
    for (const key of TASK_KEYS) {
      const bad = validTask();
      delete bad[key];
      expectTaskInvalid(() => projectTaskJson(bad, { expectedTaskId: TASK_ID }), {
        leakTokens: [key],
      });
    }
  });

  it('rejects wrong schemaVersion, taskId mismatch, invalid deviceId', () => {
    expectTaskInvalid(() =>
      projectTaskJson(validTask({ schemaVersion: 2 }), { expectedTaskId: TASK_ID }),
    );
    expectTaskInvalid(() =>
      projectTaskJson(validTask({ schemaVersion: '1' }), { expectedTaskId: TASK_ID }),
    );
    expectTaskInvalid(
      () => projectTaskJson(validTask(), { expectedTaskId: SNAPSHOT_ID }),
      { leakTokens: [SNAPSHOT_ID] },
    );
    expectTaskInvalid(() =>
      projectTaskJson(validTask({ deviceId: '' }), { expectedTaskId: TASK_ID }),
    );
    const overDevice = 'd'.repeat(257);
    assert.strictEqual(Buffer.byteLength(overDevice, 'utf8'), 257);
    expectTaskInvalid(
      () => projectTaskJson(validTask({ deviceId: overDevice }), { expectedTaskId: TASK_ID }),
      { leakTokens: [overDevice.slice(0, 32)] },
    );
  });

  it('rejects invalid UUID / SHA-256 / ISO calendar-time / counts / chunkSize / relativeTarget', () => {
    const badUuids = [
      'not-a-uuid',
      '550E8400-E29B-41D4-A716-446655440001', // upper
      '550e8400-e29b-61d4-a716-446655440001', // version 6
      '550e8400-e29b-41d4-c716-446655440001', // bad variant
      '550e8400e29b41d4a716446655440001',
    ];
    for (const taskId of badUuids) {
      expectTaskInvalid(
        () => projectTaskJson(validTask({ taskId }), { expectedTaskId: taskId }),
        { leakTokens: [taskId] },
      );
    }
    for (const snapshotId of badUuids) {
      expectTaskInvalid(
        () => projectTaskJson(validTask({ snapshotId }), { expectedTaskId: TASK_ID }),
        { leakTokens: [snapshotId] },
      );
    }

    const badSha = [
      'A'.repeat(64),
      'g'.repeat(64),
      'a'.repeat(63),
      'a'.repeat(65),
      '',
    ];
    for (const manifestDigest of badSha) {
      expectTaskInvalid(
        () => projectTaskJson(validTask({ manifestDigest }), { expectedTaskId: TASK_ID }),
        { leakTokens: [manifestDigest.slice(0, 16)] },
      );
    }

    const badIso = [
      '2026-07-23T12:00:00Z',
      '2026-07-23 12:00:00.000Z',
      '2026-07-23T12:00:00.000+08:00',
      '2026-02-30T00:00:00.000Z',
      '2026-13-01T00:00:00.000Z',
      '2026-04-31T00:00:00.000Z',
      'July 23, 2026',
    ];
    for (const createdAt of badIso) {
      expectTaskInvalid(
        () => projectTaskJson(validTask({ createdAt }), { expectedTaskId: TASK_ID }),
        { leakTokens: [String(createdAt).slice(0, 24)] },
      );
    }

    for (const fileCount of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', 100_001]) {
      expectTaskInvalid(() =>
        projectTaskJson(validTask({ fileCount }), { expectedTaskId: TASK_ID }),
      );
    }
    for (const totalBytes of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '0']) {
      expectTaskInvalid(() =>
        projectTaskJson(validTask({ totalBytes }), { expectedTaskId: TASK_ID }),
      );
    }
    for (const chunkSize of [0, 1, 4096, 8_388_607, 8_388_609, '8388608', 8_388_608.0 + 0.1]) {
      if (chunkSize === 8_388_608) continue;
      expectTaskInvalid(() =>
        projectTaskJson(validTask({ chunkSize }), { expectedTaskId: TASK_ID }),
      );
    }
    // Float that is not safe integer identity
    expectTaskInvalid(() =>
      projectTaskJson(validTask({ chunkSize: 8_388_608.5 }), { expectedTaskId: TASK_ID }),
    );

    const badTargets = ['', '/abs', 'a\\b', 'a//b', 'a/./b', 'a/../b', 'a\nb', 'p'.repeat(1025)];
    for (const relativeTarget of badTargets) {
      expectTaskInvalid(
        () => projectTaskJson(validTask({ relativeTarget }), { expectedTaskId: TASK_ID }),
        { leakTokens: [relativeTarget.slice(0, 24)] },
      );
    }
  });
});

describe('projectStatusJson', () => {
  const legalFixtures = [
    ['pending', validStatusPending],
    ['active', validStatusActive],
    ['completed', validStatusCompleted],
    ['rolled-back', validStatusRolledBack],
    ['cancelled', validStatusCancelled],
    ['cancelled', validStatusCancelledPendingDirect],
    ['cleaned', validStatusCleaned],
    ['cleaned', validStatusCleanedRolledBack],
  ];

  it('projects exact top-level keys, matches expectedTaskId, freezes nested objects', () => {
    for (const [status, factory] of legalFixtures) {
      const projected = projectStatusJson(factory(), { expectedTaskId: TASK_ID });
      assert.strictEqual(projected.status, status);
      assert.deepStrictEqual(Object.keys(projected), [...STATUS_KEYS]);
      assert.ok(Object.isFrozen(projected));
      if (projected.receipt !== null) {
        assert.ok(Object.isFrozen(projected.receipt));
        assert.deepStrictEqual(Object.keys(projected.receipt), [...RECEIPT_KEYS]);
      }
      if (projected.cleanupReceipt !== null) {
        assert.ok(Object.isFrozen(projected.cleanupReceipt));
        assert.deepStrictEqual(Object.keys(projected.cleanupReceipt), [...CLEANUP_KEYS]);
      }
      if (projected.lastProgress !== null) {
        assert.ok(Object.isFrozen(projected.lastProgress));
      }
      assert.throws(() => {
        projected.status = 'mutated';
      }, TypeError);
    }
  });

  it('covers all legal status enum values with minimally consistent fixtures', () => {
    for (const [status, factory] of legalFixtures) {
      const projected = projectStatusJson(factory(), { expectedTaskId: TASK_ID });
      assert.strictEqual(projected.taskId, TASK_ID);
      assert.strictEqual(projected.status, status);
      assert.strictEqual(projected.schemaVersion, 1);
    }
  });

  it('rejects unknown/missing keys, task mismatch, invalid status/timestamps/lastProgress', () => {
    expectTaskInvalid(
      () => projectStatusJson(validStatusPending({ extra: 1 }), { expectedTaskId: TASK_ID }),
      { leakTokens: ['extra'] },
    );
    for (const key of STATUS_KEYS) {
      const bad = validStatusPending();
      delete bad[key];
      expectTaskInvalid(() => projectStatusJson(bad, { expectedTaskId: TASK_ID }));
    }
    expectTaskInvalid(() =>
      projectStatusJson(validStatusPending(), { expectedTaskId: SNAPSHOT_ID }),
    );
    expectTaskInvalid(() =>
      projectStatusJson(validStatusPending({ status: 'running' }), { expectedTaskId: TASK_ID }),
    );
    expectTaskInvalid(() =>
      projectStatusJson(validStatusPending({ status: 'complete' }), { expectedTaskId: TASK_ID }),
    );
    expectTaskInvalid(() =>
      projectStatusJson(
        validStatusPending({ updatedAt: '2026-02-30T00:00:00.000Z' }),
        { expectedTaskId: TASK_ID },
      ),
    );
    expectTaskInvalid(() =>
      projectStatusJson(
        validStatusActive({
          lastProgress: {
            fileIndex: 0,
            chunkIndex: 0,
            receivedBytes: 0,
            updatedAt: ISO_T0,
            extra: true,
          },
        }),
        { expectedTaskId: TASK_ID },
      ),
    );
    for (const bad of [
      { fileIndex: -1, chunkIndex: 0, receivedBytes: 0, updatedAt: ISO_T0 },
      { fileIndex: 0.5, chunkIndex: 0, receivedBytes: 0, updatedAt: ISO_T0 },
      { fileIndex: 0, chunkIndex: -1, receivedBytes: 0, updatedAt: ISO_T0 },
      { fileIndex: 0, chunkIndex: 0, receivedBytes: -1, updatedAt: ISO_T0 },
      { fileIndex: 0, chunkIndex: 0, receivedBytes: 1.5, updatedAt: ISO_T0 },
      { fileIndex: 0, chunkIndex: 0, receivedBytes: '0', updatedAt: ISO_T0 },
    ]) {
      expectTaskInvalid(() =>
        projectStatusJson(validStatusActive({ lastProgress: bad }), { expectedTaskId: TASK_ID }),
      );
    }
  });

  it('rejects §7.3 cross-field inconsistencies for cleanupAuthorized/receipt/cleanup', () => {
    // completed requires cleanupAuthorized true + non-null receipt
    expectTaskInvalid(() =>
      projectStatusJson(
        validStatusCompleted({ cleanupAuthorized: false }),
        { expectedTaskId: TASK_ID },
      ),
    );
    expectTaskInvalid(() =>
      projectStatusJson(validStatusCompleted({ receipt: null }), { expectedTaskId: TASK_ID }),
    );
    expectTaskInvalid(() =>
      projectStatusJson(
        validStatusCompleted({ receiptAckAt: null }),
        { expectedTaskId: TASK_ID },
      ),
    );
    // rolled-back same
    expectTaskInvalid(() =>
      projectStatusJson(
        validStatusRolledBack({ cleanupAuthorized: false }),
        { expectedTaskId: TASK_ID },
      ),
    );
    expectTaskInvalid(() =>
      projectStatusJson(validStatusRolledBack({ receipt: null }), { expectedTaskId: TASK_ID }),
    );
    // cleaned must retain receipt + cleanupReceipt + cleanupAckAt
    expectTaskInvalid(() =>
      projectStatusJson(validStatusCleaned({ receipt: null }), { expectedTaskId: TASK_ID }),
    );
    expectTaskInvalid(() =>
      projectStatusJson(
        validStatusCleaned({ cleanupReceipt: null }),
        { expectedTaskId: TASK_ID },
      ),
    );
    expectTaskInvalid(() =>
      projectStatusJson(
        validStatusCleaned({ cleanupAckAt: null }),
        { expectedTaskId: TASK_ID },
      ),
    );
    expectTaskInvalid(() =>
      projectStatusJson(
        validStatusCleaned({ cleanupAuthorized: false }),
        { expectedTaskId: TASK_ID },
      ),
    );
    // cancelled path keeps receipt null; non-null receipt invalid
    expectTaskInvalid(() =>
      projectStatusJson(
        validStatusCancelled({ receipt: validCompletedReceipt() }),
        { expectedTaskId: TASK_ID },
      ),
    );
    // pending should not look claimed
    expectTaskInvalid(() =>
      projectStatusJson(
        validStatusPending({ claimedAt: ISO_T0 }),
        { expectedTaskId: TASK_ID },
      ),
    );
    // active requires claimedAt
    expectTaskInvalid(() =>
      projectStatusJson(validStatusActive({ claimedAt: null }), { expectedTaskId: TASK_ID }),
    );
    // cleanupAuthorized true without receipt is invalid on pending
    expectTaskInvalid(() =>
      projectStatusJson(
        validStatusPending({ cleanupAuthorized: true }),
        { expectedTaskId: TASK_ID },
      ),
    );
  });

  it('rejects pending terminal/cleanup/progress/cancel fields that must remain null', () => {
    const pendingRejects = [
      { completedAt: ISO_T1 },
      { receiptAckAt: ISO_T1 },
      { cleanupReceipt: validCleanupCancelled() },
      { cleanupAckAt: ISO_T2 },
      { cancelRequestedAt: ISO_T1 },
      {
        lastProgress: {
          fileIndex: 0,
          chunkIndex: 0,
          receivedBytes: 0,
          updatedAt: ISO_T0,
        },
      },
    ];
    for (const patch of pendingRejects) {
      expectTaskInvalid(() =>
        projectStatusJson(validStatusPending(patch), { expectedTaskId: TASK_ID }),
      );
    }
  });

  it('rejects active business-terminal/cleanup fields; accepts cancelRequestedAt + lastProgress', () => {
    const activeRejects = [
      { completedAt: ISO_T1 },
      { receipt: validCompletedReceipt() },
      { receiptAckAt: ISO_T1 },
      { cleanupAuthorized: true },
      { cleanupReceipt: validCleanupCancelled() },
      { cleanupAckAt: ISO_T2 },
    ];
    for (const patch of activeRejects) {
      expectTaskInvalid(() =>
        projectStatusJson(validStatusActive(patch), { expectedTaskId: TASK_ID }),
      );
    }

    const withCancel = projectStatusJson(
      validStatusActive({ cancelRequestedAt: ISO_T1 }),
      { expectedTaskId: TASK_ID },
    );
    assert.strictEqual(withCancel.status, 'active');
    assert.strictEqual(withCancel.cancelRequestedAt, ISO_T1);
    assert.notStrictEqual(withCancel.lastProgress, null);

    const progressOnly = projectStatusJson(
      validStatusActive({
        cancelRequestedAt: null,
        lastProgress: {
          fileIndex: 1,
          chunkIndex: 2,
          receivedBytes: 3,
          updatedAt: ISO_T1,
        },
      }),
      { expectedTaskId: TASK_ID },
    );
    assert.strictEqual(progressOnly.lastProgress.fileIndex, 1);
    assert.strictEqual(progressOnly.lastProgress.receivedBytes, 3);
  });

  it('rejects completed/rolled-back missing claim/complete times or nested receipt taskId mismatch', () => {
    for (const factory of [validStatusCompleted, validStatusRolledBack]) {
      expectTaskInvalid(() =>
        projectStatusJson(factory({ claimedAt: null }), { expectedTaskId: TASK_ID }),
      );
      expectTaskInvalid(() =>
        projectStatusJson(factory({ completedAt: null }), { expectedTaskId: TASK_ID }),
      );
      const baseReceipt =
        factory === validStatusCompleted
          ? validCompletedReceipt({ taskId: OTHER_TASK_ID })
          : validRolledBackReceipt({ taskId: OTHER_TASK_ID });
      expectTaskInvalid(() =>
        projectStatusJson(factory({ receipt: baseReceipt }), { expectedTaskId: TASK_ID }),
      );
    }

    // Post-anchor cancel must not overturn completed/rolled-back receipt acceptance.
    for (const factory of [validStatusCompleted, validStatusRolledBack]) {
      const projected = projectStatusJson(
        factory({ cancelRequestedAt: ISO_T2 }),
        { expectedTaskId: TASK_ID },
      );
      assert.strictEqual(projected.cancelRequestedAt, ISO_T2);
      assert.notStrictEqual(projected.receipt, null);
    }
  });

  it('rejects cleaned identity/outcome mismatches and accepts rolled-back cleaned + cancelRequestedAt', () => {
    const cleanedRejects = [
      { claimedAt: null },
      { completedAt: null },
      { receiptAckAt: null },
      { receipt: validCompletedReceipt({ taskId: OTHER_TASK_ID }) },
      { cleanupReceipt: validCleanupCompleted({ taskId: OTHER_TASK_ID }) },
      { cleanupReceipt: validCleanupCompleted({ outcome: 'rolled-back' }) },
      { cleanupReceipt: validCleanupCompleted({ receiptId: OTHER_RECEIPT_ID }) },
      { cleanupReceipt: validCleanupCompleted({ deviceId: OTHER_DEVICE_ID }) },
    ];
    for (const patch of cleanedRejects) {
      expectTaskInvalid(() =>
        projectStatusJson(validStatusCleaned(patch), { expectedTaskId: TASK_ID }),
      );
    }

    const cleanedRb = projectStatusJson(validStatusCleanedRolledBack(), {
      expectedTaskId: TASK_ID,
    });
    assert.strictEqual(cleanedRb.status, 'cleaned');
    assert.strictEqual(cleanedRb.receipt.outcome, 'rolled-back');
    assert.strictEqual(cleanedRb.cleanupReceipt.outcome, 'rolled-back');

    const cleanedWithCancel = projectStatusJson(
      validStatusCleaned({ cancelRequestedAt: ISO_T2 }),
      { expectedTaskId: TASK_ID },
    );
    assert.strictEqual(cleanedWithCancel.cancelRequestedAt, ISO_T2);
    assert.strictEqual(cleanedWithCancel.receipt.outcome, 'completed');
  });

  it('accepts both cancelled branches and rejects illegal cancelled combinations', () => {
    const direct = projectStatusJson(validStatusCancelledPendingDirect(), {
      expectedTaskId: TASK_ID,
    });
    assert.strictEqual(direct.status, 'cancelled');
    assert.strictEqual(direct.claimedAt, null);
    assert.strictEqual(direct.cleanupReceipt, null);
    assert.strictEqual(direct.cleanupAckAt, null);
    assert.strictEqual(direct.cancelRequestedAt, ISO_T1);

    const activeCancel = projectStatusJson(validStatusCancelled(), {
      expectedTaskId: TASK_ID,
    });
    assert.strictEqual(activeCancel.status, 'cancelled');
    assert.strictEqual(activeCancel.claimedAt, ISO_T0);
    assert.strictEqual(activeCancel.cleanupReceipt.outcome, 'cancelled');
    assert.strictEqual(activeCancel.cleanupAckAt, ISO_T2);
    assert.strictEqual(activeCancel.receipt, null);
    assert.strictEqual(activeCancel.cleanupAuthorized, false);

    // cancelRequestedAt required on both branches
    expectTaskInvalid(() =>
      projectStatusJson(
        validStatusCancelledPendingDirect({ cancelRequestedAt: null }),
        { expectedTaskId: TASK_ID },
      ),
    );
    expectTaskInvalid(() =>
      projectStatusJson(
        validStatusCancelled({ cancelRequestedAt: null }),
        { expectedTaskId: TASK_ID },
      ),
    );

    // Direct branch must not carry cleanup/progress artifacts
    for (const patch of [
      { cleanupReceipt: validCleanupCancelled() },
      { cleanupAckAt: ISO_T2 },
      {
        lastProgress: {
          fileIndex: 0,
          chunkIndex: 0,
          receivedBytes: 0,
          updatedAt: ISO_T0,
        },
      },
    ]) {
      expectTaskInvalid(() =>
        projectStatusJson(
          validStatusCancelledPendingDirect(patch),
          { expectedTaskId: TASK_ID },
        ),
      );
    }

    // Active branch requires cancelled cleanup receipt + ack
    expectTaskInvalid(() =>
      projectStatusJson(
        validStatusCancelled({ cleanupReceipt: null }),
        { expectedTaskId: TASK_ID },
      ),
    );
    expectTaskInvalid(() =>
      projectStatusJson(
        validStatusCancelled({ cleanupAckAt: null }),
        { expectedTaskId: TASK_ID },
      ),
    );
    expectTaskInvalid(() =>
      projectStatusJson(
        validStatusCancelled({
          cleanupReceipt: validCleanupCompleted({ outcome: 'completed' }),
        }),
        { expectedTaskId: TASK_ID },
      ),
    );
    expectTaskInvalid(() =>
      projectStatusJson(
        validStatusCancelled({
          cleanupReceipt: validCleanupCompleted({ outcome: 'rolled-back' }),
        }),
        { expectedTaskId: TASK_ID },
      ),
    );
    expectTaskInvalid(() =>
      projectStatusJson(
        validStatusCancelled({
          cleanupReceipt: validCleanupCancelled({ taskId: OTHER_TASK_ID }),
        }),
        { expectedTaskId: TASK_ID },
      ),
    );

    // Shared cancelled rejects
    for (const factory of [validStatusCancelled, validStatusCancelledPendingDirect]) {
      for (const patch of [
        { completedAt: ISO_T1 },
        { receiptAckAt: ISO_T1 },
        { cleanupAuthorized: true },
      ]) {
        expectTaskInvalid(() =>
          projectStatusJson(factory(patch), { expectedTaskId: TASK_ID }),
        );
      }
    }
  });
});

describe('hostile inputs fail closed as restore-task-invalid', () => {
  const SENTINEL = 'GETTER_SENTINEL';
  const PROXY_SENTINEL = 'PROXY_SENTINEL';

  it('rejects arrays, Date/class instances, null, and non-objects', () => {
    class Hostile {}
    for (const input of [
      null,
      undefined,
      [],
      [validTask()],
      new Date(ISO_T0),
      new Hostile(),
      'string',
      1,
      true,
      false,
    ]) {
      expectTaskInvalid(() => projectTaskJson(input, { expectedTaskId: TASK_ID }));
      expectTaskInvalid(() => projectStatusJson(input, { expectedTaskId: TASK_ID }));
      expectTaskInvalid(() => projectReceiptObject(input));
      expectTaskInvalid(() => projectCleanupReceipt(input));
      expectTaskInvalid(() => projectProgressBody(input));
    }
  });

  it('rejects own enumerable getters and custom-prototype records without executing getters', () => {
    let getterHits = 0;
    const withGetter = {
      ...validTask(),
    };
    Object.defineProperty(withGetter, 'secretLeak', {
      enumerable: true,
      get() {
        getterHits += 1;
        return SENTINEL;
      },
    });
    expectTaskInvalid(() => projectTaskJson(withGetter, { expectedTaskId: TASK_ID }), {
      leakTokens: [SENTINEL],
    });
    assert.strictEqual(getterHits, 0, 'descriptor validation must not execute own getters');

    getterHits = 0;
    const proto = {
      get hostname() {
        getterHits += 1;
        return SENTINEL;
      },
    };
    const inherited = Object.create(proto);
    Object.assign(inherited, validTask());
    // Custom prototype is not a plain record (only Object.prototype / null are safe).
    expectTaskInvalid(() => projectTaskJson(inherited, { expectedTaskId: TASK_ID }), {
      leakTokens: [SENTINEL],
    });
    assert.strictEqual(getterHits, 0, 'must not execute prototype getters');
  });

  it('rejects throwing and revoked Proxy paths without leaking sentinel text', () => {
    const throwing = new Proxy(validTask(), {
      get(target, prop, receiver) {
        if (prop === 'deviceId') throw new Error(PROXY_SENTINEL);
        return Reflect.get(target, prop, receiver);
      },
      ownKeys() {
        return Reflect.ownKeys(validTask());
      },
      getOwnPropertyDescriptor(target, prop) {
        return Object.getOwnPropertyDescriptor(target, prop)
          ?? Object.getOwnPropertyDescriptor(validTask(), prop);
      },
    });
    expectTaskInvalid(() => projectTaskJson(throwing, { expectedTaskId: TASK_ID }), {
      leakTokens: [PROXY_SENTINEL],
    });

    const base = validTask();
    const { proxy, revoke } = Proxy.revocable(base, {
      ownKeys() {
        return Reflect.ownKeys(base);
      },
      getOwnPropertyDescriptor(_t, prop) {
        return Object.getOwnPropertyDescriptor(base, prop);
      },
      get(_t, prop) {
        return base[prop];
      },
    });
    revoke();
    expectTaskInvalid(() => projectTaskJson(proxy, { expectedTaskId: TASK_ID }), {
      leakTokens: [PROXY_SENTINEL],
    });
  });
});

describe('projectReceiptObject', () => {
  it('projects exact 15 keys, freezes output, and validates completed time/outcome coupling', () => {
    const projected = projectReceiptObject(validCompletedReceipt());
    assert.deepStrictEqual(Object.keys(projected), [...RECEIPT_KEYS]);
    assert.ok(Object.isFrozen(projected));
    assert.strictEqual(projected.outcome, 'completed');
    assert.strictEqual(projected.publishedVerifiedAt, ISO_T1);
    assert.strictEqual(projected.rolledBackAt, null);
    assert.strictEqual(projected.contentSha256, CONTENT_SHA);
    assert.strictEqual(projected.structureFingerprint, STRUCTURE_FP);
  });

  it('accepts rolled-back with anchor true and hex fingerprints', () => {
    const projected = projectReceiptObject(validRolledBackReceipt());
    assert.strictEqual(projected.outcome, 'rolled-back');
    assert.strictEqual(projected.publishedVerifiedAt, null);
    assert.strictEqual(projected.rolledBackAt, ISO_T1);
    assert.strictEqual(projected.anchorPresentBeforePublish, true);
  });

  it('accepts rolled-back with anchor false and both fingerprints null', () => {
    const projected = projectReceiptObject(
      validRolledBackReceipt({
        anchorPresentBeforePublish: false,
        contentSha256: null,
        structureFingerprint: null,
      }),
    );
    assert.strictEqual(projected.contentSha256, null);
    assert.strictEqual(projected.structureFingerprint, null);
  });

  it('rejects unknown keys, invalid UUID/SHA/ISO/safe-int/path, and time/outcome coupling', () => {
    expectTaskInvalid(() => projectReceiptObject(validCompletedReceipt({ extra: 1 })));
    for (const key of RECEIPT_KEYS) {
      const bad = validCompletedReceipt();
      delete bad[key];
      expectTaskInvalid(() => projectReceiptObject(bad));
    }
    expectTaskInvalid(() =>
      projectReceiptObject(validCompletedReceipt({ taskId: 'not-uuid' })),
    );
    expectTaskInvalid(() =>
      projectReceiptObject(validCompletedReceipt({ manifestDigest: 'A'.repeat(64) })),
    );
    expectTaskInvalid(() =>
      projectReceiptObject(validCompletedReceipt({ relativeTarget: '/abs' })),
      { leakTokens: ['/abs'] },
    );
    expectTaskInvalid(() =>
      projectReceiptObject(validCompletedReceipt({ fileCount: -1 })),
    );
    expectTaskInvalid(() =>
      projectReceiptObject(validCompletedReceipt({ totalBytes: 1.5 })),
    );
    // completed requires publishedVerifiedAt non-null and rolledBackAt null
    expectTaskInvalid(() =>
      projectReceiptObject(validCompletedReceipt({ publishedVerifiedAt: null })),
    );
    expectTaskInvalid(() =>
      projectReceiptObject(validCompletedReceipt({ rolledBackAt: ISO_T2 })),
    );
    // rolled-back requires rolledBackAt non-null and publishedVerifiedAt null
    expectTaskInvalid(() =>
      projectReceiptObject(validRolledBackReceipt({ rolledBackAt: null })),
    );
    expectTaskInvalid(() =>
      projectReceiptObject(validRolledBackReceipt({ publishedVerifiedAt: ISO_T2 })),
    );
    expectTaskInvalid(() =>
      projectReceiptObject(validCompletedReceipt({ outcome: 'cancelled' })),
    );
  });
});

describe('assertFingerprintNullability', () => {
  const legal = [
    {
      label: 'completed + anchor true => both hex',
      receipt: validCompletedReceipt({ anchorPresentBeforePublish: true }),
    },
    {
      label: 'completed + anchor false => both hex',
      receipt: validCompletedReceipt({ anchorPresentBeforePublish: false }),
    },
    {
      label: 'rolled-back + anchor true => both hex',
      receipt: validRolledBackReceipt({
        anchorPresentBeforePublish: true,
        contentSha256: CONTENT_SHA,
        structureFingerprint: STRUCTURE_FP,
      }),
    },
    {
      label: 'rolled-back + anchor false => both null',
      receipt: validRolledBackReceipt({
        anchorPresentBeforePublish: false,
        contentSha256: null,
        structureFingerprint: null,
      }),
    },
  ];

  it('accepts the UNIQUE legal fingerprint nullability table', () => {
    for (const { receipt } of legal) {
      assert.doesNotThrow(() => assertFingerprintNullability(receipt));
    }
  });

  it('rejects all other one-null/both-null/hex combinations as restore-task-invalid', () => {
    const illegal = [
      validCompletedReceipt({ contentSha256: null, structureFingerprint: STRUCTURE_FP }),
      validCompletedReceipt({ contentSha256: CONTENT_SHA, structureFingerprint: null }),
      validCompletedReceipt({ contentSha256: null, structureFingerprint: null }),
      validRolledBackReceipt({
        anchorPresentBeforePublish: true,
        contentSha256: null,
        structureFingerprint: STRUCTURE_FP,
      }),
      validRolledBackReceipt({
        anchorPresentBeforePublish: true,
        contentSha256: CONTENT_SHA,
        structureFingerprint: null,
      }),
      validRolledBackReceipt({
        anchorPresentBeforePublish: true,
        contentSha256: null,
        structureFingerprint: null,
      }),
      validRolledBackReceipt({
        anchorPresentBeforePublish: false,
        contentSha256: CONTENT_SHA,
        structureFingerprint: STRUCTURE_FP,
      }),
      validRolledBackReceipt({
        anchorPresentBeforePublish: false,
        contentSha256: CONTENT_SHA,
        structureFingerprint: null,
      }),
      validRolledBackReceipt({
        anchorPresentBeforePublish: false,
        contentSha256: null,
        structureFingerprint: STRUCTURE_FP,
      }),
      // bad hex form
      validCompletedReceipt({ contentSha256: 'A'.repeat(64) }),
      validCompletedReceipt({ structureFingerprint: 'g'.repeat(64) }),
    ];
    for (const receipt of illegal) {
      expectTaskInvalid(() => assertFingerprintNullability(receipt));
    }
  });

  it('accepts null-prototype four-field record; rejects Proxy/getter/class without leak', () => {
    const nullProto = Object.assign(Object.create(null), {
      outcome: 'completed',
      anchorPresentBeforePublish: false,
      contentSha256: CONTENT_SHA,
      structureFingerprint: STRUCTURE_FP,
    });
    assert.doesNotThrow(() => assertFingerprintNullability(nullProto));

    const SENTINEL = 'GETTER_SENTINEL';
    let getterHits = 0;
    const withGetter = {
      outcome: 'completed',
      anchorPresentBeforePublish: false,
      contentSha256: CONTENT_SHA,
      structureFingerprint: STRUCTURE_FP,
    };
    Object.defineProperty(withGetter, 'contentSha256', {
      enumerable: true,
      configurable: true,
      get() {
        getterHits += 1;
        return SENTINEL;
      },
    });
    expectTaskInvalid(() => assertFingerprintNullability(withGetter), {
      leakTokens: [SENTINEL],
    });
    assert.strictEqual(getterHits, 0, 'must not execute own fingerprint getters');

    class FingerprintBag {
      constructor() {
        this.outcome = 'completed';
        this.anchorPresentBeforePublish = false;
        this.contentSha256 = CONTENT_SHA;
        this.structureFingerprint = STRUCTURE_FP;
      }
    }
    expectTaskInvalid(() => assertFingerprintNullability(new FingerprintBag()));

    const proxyTarget = {
      outcome: 'completed',
      anchorPresentBeforePublish: false,
      contentSha256: CONTENT_SHA,
      structureFingerprint: STRUCTURE_FP,
    };
    const proxy = new Proxy(proxyTarget, {
      get(target, prop, receiver) {
        if (prop === 'contentSha256') throw new Error('PROXY_SENTINEL');
        return Reflect.get(target, prop, receiver);
      },
    });
    expectTaskInvalid(() => assertFingerprintNullability(proxy), {
      leakTokens: ['PROXY_SENTINEL'],
    });

    const { proxy: revProxy, revoke } = Proxy.revocable(
      {
        outcome: 'completed',
        anchorPresentBeforePublish: false,
        contentSha256: CONTENT_SHA,
        structureFingerprint: STRUCTURE_FP,
      },
      {},
    );
    revoke();
    expectTaskInvalid(() => assertFingerprintNullability(revProxy));
  });
});

describe('projectCleanupReceipt', () => {
  it('projects exact 7 keys and freezes output', () => {
    const projected = projectCleanupReceipt(validCleanupCompleted());
    assert.deepStrictEqual(Object.keys(projected), [...CLEANUP_KEYS]);
    assert.ok(Object.isFrozen(projected));
    assert.strictEqual(projected.outcome, 'completed');
    assert.strictEqual(projected.receiptId, RECEIPT_ID);
  });

  it('requires receiptId null for cancelled; UUID for completed/rolled-back', () => {
    const cancelled = projectCleanupReceipt(validCleanupCancelled());
    assert.strictEqual(cancelled.receiptId, null);
    assert.strictEqual(cancelled.outcome, 'cancelled');

    const rolled = projectCleanupReceipt(
      validCleanupCompleted({ outcome: 'rolled-back' }),
    );
    assert.strictEqual(rolled.outcome, 'rolled-back');
    assert.strictEqual(rolled.receiptId, RECEIPT_ID);

    expectTaskInvalid(() =>
      projectCleanupReceipt(validCleanupCancelled({ receiptId: RECEIPT_ID })),
    );
    expectTaskInvalid(() =>
      projectCleanupReceipt(validCleanupCompleted({ receiptId: null })),
    );
    expectTaskInvalid(() =>
      projectCleanupReceipt(
        validCleanupCompleted({ outcome: 'rolled-back', receiptId: null }),
      ),
    );
    expectTaskInvalid(() =>
      projectCleanupReceipt(validCleanupCompleted({ receiptId: 'not-a-uuid' })),
    );
  });

  it('rejects unknown/path keys and invalid combinations', () => {
    expectTaskInvalid(
      () => projectCleanupReceipt(validCleanupCompleted({ path: 'docs/a' })),
      { leakTokens: ['docs/a'] },
    );
    expectTaskInvalid(
      () => projectCleanupReceipt(validCleanupCompleted({ stagingPath: '/tmp/x' })),
      { leakTokens: ['/tmp/x'] },
    );
    expectTaskInvalid(() =>
      projectCleanupReceipt(validCleanupCompleted({ outcome: 'active' })),
    );
    for (const key of CLEANUP_KEYS) {
      const bad = validCleanupCompleted();
      delete bad[key];
      expectTaskInvalid(() => projectCleanupReceipt(bad));
    }
  });
});

describe('projectProgressBody', () => {
  it('projects exact 3 keys, freezes output, and accepts zero', () => {
    const projected = projectProgressBody(validProgress());
    assert.deepStrictEqual(Object.keys(projected), [...PROGRESS_KEYS]);
    assert.deepStrictEqual(projected, {
      fileIndex: 0,
      chunkIndex: 0,
      receivedBytes: 0,
    });
    assert.ok(Object.isFrozen(projected));
    assert.throws(() => {
      projected.fileIndex = 9;
    }, TypeError);
  });

  it('rejects unknown/missing/negative/float/unsafe/string-number values', () => {
    expectTaskInvalid(() => projectProgressBody(validProgress({ extra: 1 })));
    for (const key of PROGRESS_KEYS) {
      const bad = validProgress();
      delete bad[key];
      expectTaskInvalid(() => projectProgressBody(bad));
    }
    for (const bad of [
      { fileIndex: -1, chunkIndex: 0, receivedBytes: 0 },
      { fileIndex: 0, chunkIndex: -1, receivedBytes: 0 },
      { fileIndex: 0, chunkIndex: 0, receivedBytes: -1 },
      { fileIndex: 1.5, chunkIndex: 0, receivedBytes: 0 },
      { fileIndex: 0, chunkIndex: 0.1, receivedBytes: 0 },
      { fileIndex: 0, chunkIndex: 0, receivedBytes: 2.5 },
      { fileIndex: '0', chunkIndex: 0, receivedBytes: 0 },
      { fileIndex: 0, chunkIndex: '0', receivedBytes: 0 },
      { fileIndex: 0, chunkIndex: 0, receivedBytes: '0' },
      { fileIndex: Number.NaN, chunkIndex: 0, receivedBytes: 0 },
      { fileIndex: Number.MAX_SAFE_INTEGER + 1, chunkIndex: 0, receivedBytes: 0 },
      { fileIndex: Number.POSITIVE_INFINITY, chunkIndex: 0, receivedBytes: 0 },
    ]) {
      expectTaskInvalid(() => projectProgressBody(bad));
    }
  });
});

describe('ISO calendar validator on public schema paths', () => {
  it('rejects regex-shaped but calendar-invalid dates', () => {
    const illegalCalendars = [
      '2026-02-30T00:00:00.000Z',
      '2026-13-01T00:00:00.000Z',
      '2026-04-31T12:00:00.000Z',
      '2025-02-29T00:00:00.000Z', // not a leap year
    ];
    for (const createdAt of illegalCalendars) {
      expectTaskInvalid(
        () => projectTaskJson(validTask({ createdAt }), { expectedTaskId: TASK_ID }),
        { leakTokens: [createdAt] },
      );
    }
    for (const updatedAt of illegalCalendars) {
      expectTaskInvalid(
        () => projectStatusJson(validStatusPending({ updatedAt }), { expectedTaskId: TASK_ID }),
        { leakTokens: [updatedAt] },
      );
    }
    for (const publishedVerifiedAt of illegalCalendars) {
      expectTaskInvalid(
        () => projectReceiptObject(validCompletedReceipt({ publishedVerifiedAt })),
        { leakTokens: [publishedVerifiedAt] },
      );
    }
    for (const cleanedAt of illegalCalendars) {
      expectTaskInvalid(
        () => projectCleanupReceipt(validCleanupCompleted({ cleanedAt })),
        { leakTokens: [cleanedAt] },
      );
    }
  });
});

describe('public schema rejection contract', () => {
  it('all invalid public schema paths return LinkeError(RESTORE_TASK_INVALID) only', () => {
    const cases = [
      () => projectTaskJson(validTask({ schemaVersion: 99 }), { expectedTaskId: TASK_ID }),
      () => projectStatusJson(validStatusPending({ status: 'nope' }), { expectedTaskId: TASK_ID }),
      () => projectReceiptObject(validCompletedReceipt({ outcome: 'nope' })),
      () => projectCleanupReceipt(validCleanupCompleted({ outcome: 'nope' })),
      () => projectProgressBody(validProgress({ fileIndex: -1 })),
      () =>
        assertFingerprintNullability(
          validCompletedReceipt({ contentSha256: null, structureFingerprint: null }),
        ),
    ];
    for (const fn of cases) {
      expectTaskInvalid(fn, {
        leakTokens: ['stack', 'Error:', 'at ', '/Users/', 'secret'],
      });
    }
  });
});
