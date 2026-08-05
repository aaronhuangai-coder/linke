/**
 * Task 3 RED — bounded audit-integrity alert dead-letter FIFO contract.
 * Authority:
 *   docs/superpowers/specs/2026-08-05-audit-integrity-alert-durable-retry-design.md §7
 *   docs/superpowers/plans/2026-08-05-audit-integrity-alert-durable-retry-plan.md Task 3
 *   .superpowers/sdd/2026-08-05-audit-integrity-alert-durable-retry-plan/task-3-brief.md
 *
 * Production (must remain absent on this RED HEAD):
 *   src/audit-integrity-alert-dead-letter.js
 *
 * Real temp fixtures + real enqueueAuditIntegrityWriteTask leases + real safe-data-files.
 * No mocks for core read / write / lease behavior.
 * Old-HEAD RED is behavior-specific: "dead-letter fifo implementation missing".
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRODUCTION_MODULE_URL = new URL(
  '../src/audit-integrity-alert-dead-letter.js',
  import.meta.url,
);
const PRODUCTION_MODULE_PATH = fileURLToPath(PRODUCTION_MODULE_URL);
const PRODUCTION_MODULE_MARKER = 'audit-integrity-alert-dead-letter';

const MISSING_MSG = 'dead-letter fifo implementation missing';
const CODE_UNAVAILABLE = 'audit-delivery-unavailable';

const RELATIVE_PATH = 'audit/integrity-alert-dead-letter.json';
const EXPECTED_MAX_BYTES = 1_048_576;
const EXPECTED_MAX_ENTRIES = 256;

const TOP_FILE_KEYS = Object.freeze(['schemaVersion', 'nextSequence', 'entries']);
const SNAPSHOT_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'entryCount',
  'nextSequence',
  'entries',
]);
const PERSISTED_ENTRY_KEYS = Object.freeze([
  'deadLetterSequence',
  'deadLetterId',
  'streamId',
  'sequence',
  'idempotencyKey',
  'enqueuedAt',
  'attemptCount',
  'firstAttemptAt',
  'lastAttemptAt',
  'reason',
  'sourceAlert',
]);
/** Caller entry omits allocator field deadLetterSequence. */
const CALLER_ENTRY_KEYS = Object.freeze([
  'deadLetterId',
  'streamId',
  'sequence',
  'idempotencyKey',
  'enqueuedAt',
  'attemptCount',
  'firstAttemptAt',
  'lastAttemptAt',
  'reason',
  'sourceAlert',
]);
const SOURCE_ALERT_KEYS = Object.freeze([
  'sequence',
  'checkedAt',
  'code',
  'recoveryRequired',
  'nextAction',
  'reasonCode',
]);
const FINGERPRINT_KEYS = Object.freeze([
  'sha256',
  'byteLength',
  'entryCount',
  'nextSequence',
]);

const EXPECTED_EXPORTS = Object.freeze([
  'AUDIT_INTEGRITY_ALERT_DEAD_LETTER_RELATIVE_PATH',
  'AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_BYTES',
  'AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_ENTRIES',
  'readAuditIntegrityAlertDeadLetter',
  'appendAuditIntegrityAlertDeadLetterUnderLease',
  'fingerprintAuditIntegrityAlertDeadLetterRaw',
]);

const STREAM_ID = 'b2222222-c222-4222-9222-f22222222222';
const STREAM_ID_B = 'e5555555-f555-4555-a555-255555555555';
const DEAD_LETTER_ID = 'd4444444-e444-4444-b444-144444444444';
const DEAD_LETTER_ID_B = 'a1111111-b111-4111-8111-e11111111111';
const SEQUENCE = 7;
const SEQUENCE_B = 11;
const IDEMPOTENCY_KEY = `audit-integrity-alert:${STREAM_ID}:${SEQUENCE}`;
const IDEMPOTENCY_KEY_B = `audit-integrity-alert:${STREAM_ID_B}:${SEQUENCE_B}`;

const ENQUEUED_AT = '2026-08-05T12:05:00.000Z';
const FIRST_ATTEMPT_AT = '2026-08-05T12:00:00.000Z';
const LAST_ATTEMPT_AT = '2026-08-05T12:00:30.000Z';
const SOURCE_CHECKED_AT = '2026-08-05T11:59:00.000Z';

const REASON_TERMINAL = 'terminal-http';
const REASON_RETRYABLE = 'attempts-exhausted-retryable';
const REASON_UNCERTAIN = 'attempts-exhausted-uncertain';
const REASONS = Object.freeze([REASON_TERMINAL, REASON_RETRYABLE, REASON_UNCERTAIN]);

/** Exact literal canonical empty DLQ bytes (compact + one trailing LF). */
const CANONICAL_EMPTY_BYTES =
  '{"schemaVersion":1,"nextSequence":1,"entries":[]}\n';
const EMPTY_BYTE_LENGTH = 50;
const EMPTY_SHA256 =
  '64349629d2308a26e182374ef6b081b999860f5c42e79ae31128fed4051099bb';

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MS_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const PRIVACY_CANARIES = Object.freeze({
  endpoint: 'https://alerts.evil.example:8443/hooks/audit',
  token: 'Bearer secret-token-xyz-999',
  headers: { Authorization: 'Bearer secret-token-xyz-999' },
  IP: '203.0.113.77',
  path: '/Users/ah/secret/dead-letter.json',
  statusCode: 503,
  rawError: 'Error: ECONNREFUSED 203.0.113.77:8443',
  claimOwner: 'pid=4242 boot=boot-sha256-aaaaaaaa',
});

/**
 * @typedef {{
 *   AUDIT_INTEGRITY_ALERT_DEAD_LETTER_RELATIVE_PATH: string,
 *   AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_BYTES: number,
 *   AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_ENTRIES: number,
 *   readAuditIntegrityAlertDeadLetter: Function,
 *   appendAuditIntegrityAlertDeadLetterUnderLease: Function,
 *   fingerprintAuditIntegrityAlertDeadLetterRaw: Function,
 * }} DeadLetterApi
 */

/** @type {null | DeadLetterApi} */
let deadLetterApi = null;
let implementationMissing = true;

try {
  const mod = await import(PRODUCTION_MODULE_URL.href);
  if (
    typeof mod.readAuditIntegrityAlertDeadLetter === 'function'
    && typeof mod.appendAuditIntegrityAlertDeadLetterUnderLease === 'function'
    && typeof mod.fingerprintAuditIntegrityAlertDeadLetterRaw === 'function'
    && typeof mod.AUDIT_INTEGRITY_ALERT_DEAD_LETTER_RELATIVE_PATH === 'string'
    && typeof mod.AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_BYTES === 'number'
    && typeof mod.AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_ENTRIES === 'number'
  ) {
    deadLetterApi = {
      AUDIT_INTEGRITY_ALERT_DEAD_LETTER_RELATIVE_PATH:
        mod.AUDIT_INTEGRITY_ALERT_DEAD_LETTER_RELATIVE_PATH,
      AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_BYTES:
        mod.AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_BYTES,
      AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_ENTRIES:
        mod.AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_ENTRIES,
      readAuditIntegrityAlertDeadLetter: mod.readAuditIntegrityAlertDeadLetter,
      appendAuditIntegrityAlertDeadLetterUnderLease:
        mod.appendAuditIntegrityAlertDeadLetterUnderLease,
      fingerprintAuditIntegrityAlertDeadLetterRaw:
        mod.fingerprintAuditIntegrityAlertDeadLetterRaw,
    };
    implementationMissing = false;
  }
} catch (error) {
  const code = error && typeof error === 'object'
    ? /** @type {{ code?: string }} */ (error).code
    : undefined;
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') {
    throw error;
  }
  const message = String(
    error && typeof error === 'object' && 'message' in error
      ? /** @type {{ message?: unknown }} */ (error).message
      : error,
  );
  const url = String(
    error && typeof error === 'object' && 'url' in error
      ? /** @type {{ url?: unknown }} */ (error).url
      : '',
  );
  const targetsTargetModule = message.includes(PRODUCTION_MODULE_MARKER)
    || url.includes(PRODUCTION_MODULE_MARKER)
    || message.includes(PRODUCTION_MODULE_PATH)
    || url.includes(PRODUCTION_MODULE_PATH);
  if (!targetsTargetModule) {
    throw error;
  }
  implementationMissing = true;
  deadLetterApi = null;
}

/**
 * @returns {DeadLetterApi}
 */
function requireApi() {
  if (implementationMissing || deadLetterApi === null) {
    assert.fail(MISSING_MSG);
  }
  return /** @type {DeadLetterApi} */ (deadLetterApi);
}

/**
 * @param {string} prefix
 * @param {(root: string) => Promise<unknown>} fn
 */
async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `linke-dlq-${prefix}-`));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Real same-root audit write lease via production queue.
 * @param {string} root
 * @param {(resolvedRoot: string, lease: object) => Promise<unknown>} fn
 */
async function withLease(root, fn) {
  const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
  const { enqueueAuditIntegrityWriteTask } = await import(
    '../src/audit-integrity-write-queue.js'
  );
  const resolvedRoot = await assertSafeDataRoot(root);
  return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => fn(resolvedRoot, lease));
}

/**
 * @param {string} root
 */
function dlqAbs(root) {
  return join(root, RELATIVE_PATH);
}

/**
 * @param {object} obj
 * @param {readonly string[]} order
 */
function reorderKeys(obj, order) {
  const out = {};
  for (const k of order) out[k] = obj[k];
  return out;
}

/**
 * @param {unknown} value
 * @param {string} [path]
 */
function assertDeeplyFrozen(value, path = 'root') {
  if (value === null || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value), `expected frozen at ${path}`);
  if (Array.isArray(value)) {
    assert.equal(Object.getPrototypeOf(value), Array.prototype);
    for (let i = 0; i < value.length; i += 1) {
      assertDeeplyFrozen(value[i], `${path}[${i}]`);
    }
    return;
  }
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  for (const key of Object.keys(value)) {
    assertDeeplyFrozen(
      /** @type {Record<string, unknown>} */ (value)[key],
      `${path}.${key}`,
    );
  }
}

/**
 * All public-boundary failures use path-free audit-delivery-unavailable.
 * @param {unknown} error
 * @param {string[]} [leakTokens]
 */
function assertUnavailable(error, leakTokens = []) {
  assert.equal(error && /** @type {{ name?: string }} */ (error).name, 'LinkeError');
  assert.equal(
    error && /** @type {{ code?: string }} */ (error).code,
    CODE_UNAVAILABLE,
  );
  assert.equal(
    error && /** @type {{ message?: string }} */ (error).message,
    CODE_UNAVAILABLE,
  );
  assert.equal(
    /** @type {{ message: string }} */ (error).message,
    /** @type {{ code: string }} */ (error).code,
  );
  assert.equal(/** @type {{ cause?: unknown }} */ (error).cause, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(error, 'cause'));

  const publicParts = [
    /** @type {{ name: string }} */ (error).name,
    /** @type {{ code: string }} */ (error).code,
    /** @type {{ message: string }} */ (error).message,
    ...Object.keys(/** @type {object} */ (error))
      .filter((key) => key !== 'stack')
      .map((key) => String(/** @type {Record<string, unknown>} */ (error)[key])),
  ].join('\0');

  for (const token of [
    'ENOENT',
    'EACCES',
    'EPERM',
    'ELOOP',
    'errno',
    '/var/',
    '/private/',
    '/tmp/',
    'Users/',
    'SECRET',
    'integrity-alert-dead-letter',
    PRIVACY_CANARIES.endpoint,
    PRIVACY_CANARIES.token,
    PRIVACY_CANARIES.IP,
    PRIVACY_CANARIES.path,
    PRIVACY_CANARIES.rawError,
    PRIVACY_CANARIES.claimOwner,
    ...leakTokens,
  ]) {
    if (!token || token.length < 2) continue;
    assert.equal(publicParts.includes(token), false, `must not leak ${token}`);
  }
  return true;
}

function buildSourceAlert(overrides = {}) {
  return {
    sequence: SEQUENCE,
    checkedAt: SOURCE_CHECKED_AT,
    code: 'audit-integrity-cross-store-broken',
    recoveryRequired: true,
    nextAction: 'run-explicit-recovery',
    reasonCode: null,
    ...overrides,
  };
}

/**
 * Caller entry exact key order (no deadLetterSequence).
 * @param {object} [overrides]
 */
function buildCallerEntry(overrides = {}) {
  return {
    deadLetterId: DEAD_LETTER_ID,
    streamId: STREAM_ID,
    sequence: SEQUENCE,
    idempotencyKey: IDEMPOTENCY_KEY,
    enqueuedAt: ENQUEUED_AT,
    attemptCount: 1,
    firstAttemptAt: FIRST_ATTEMPT_AT,
    lastAttemptAt: LAST_ATTEMPT_AT,
    reason: REASON_TERMINAL,
    sourceAlert: buildSourceAlert(),
    ...overrides,
  };
}

/**
 * Persisted entry exact key order (includes deadLetterSequence first).
 * @param {number} deadLetterSequence
 * @param {object} [overrides]
 */
function buildPersistedEntry(deadLetterSequence, overrides = {}) {
  const base = buildCallerEntry(overrides);
  return {
    deadLetterSequence,
    deadLetterId: base.deadLetterId,
    streamId: base.streamId,
    sequence: base.sequence,
    idempotencyKey: base.idempotencyKey,
    enqueuedAt: base.enqueuedAt,
    attemptCount: base.attemptCount,
    firstAttemptAt: base.firstAttemptAt,
    lastAttemptAt: base.lastAttemptAt,
    reason: base.reason,
    sourceAlert: base.sourceAlert,
  };
}

/**
 * @param {number} nextSequence
 * @param {object[]} entries
 */
function buildFileState(nextSequence, entries) {
  return {
    schemaVersion: 1,
    nextSequence,
    entries,
  };
}

/**
 * Compact full-file raw identity for a file-state object.
 * @param {number} nextSequence
 * @param {object[]} entries
 */
function canonicalFileBytes(nextSequence, entries) {
  return `${JSON.stringify(buildFileState(nextSequence, entries))}\n`;
}

/**
 * Hand-derived fingerprint of known raw fixture bytes (not via code under test).
 * @param {string} rawText
 * @param {number} entryCount
 * @param {number} nextSequence
 */
function handFingerprint(rawText, entryCount, nextSequence) {
  return {
    sha256: createHash('sha256').update(rawText, 'utf8').digest('hex'),
    byteLength: Buffer.byteLength(rawText, 'utf8'),
    entryCount,
    nextSequence,
  };
}

/**
 * @param {object} snapshot
 * @param {object} expected
 */
function assertExactSnapshot(snapshot, expected) {
  assert.deepEqual(Object.keys(snapshot), [...SNAPSHOT_KEYS]);
  assert.deepEqual(snapshot, expected);
  assertDeeplyFrozen(snapshot);
  assert.throws(() => {
    /** @type {{ status: string }} */ (snapshot).status = 'ready';
  }, TypeError);
}

/**
 * @param {object} fp
 * @param {object} expected
 */
function assertExactFingerprint(fp, expected) {
  assert.deepEqual(Object.keys(fp), [...FINGERPRINT_KEYS]);
  assert.deepEqual(fp, expected);
  assertDeeplyFrozen(fp);
  assert.throws(() => {
    /** @type {{ entryCount: number }} */ (fp).entryCount = -1;
  }, TypeError);
}

function emptyMissingSnapshot() {
  return {
    schemaVersion: 1,
    status: 'empty',
    entryCount: 0,
    nextSequence: 1,
    entries: [],
  };
}

function readySnapshot(nextSequence, entries) {
  return {
    schemaVersion: 1,
    status: 'ready',
    entryCount: entries.length,
    nextSequence,
    entries,
  };
}

// Anchor hand-derived empty canonical and fixture identity so fixtures cannot drift.
assert.equal(CANONICAL_EMPTY_BYTES, `${JSON.stringify(buildFileState(1, []))}\n`);
assert.equal(Buffer.byteLength(CANONICAL_EMPTY_BYTES, 'utf8'), EMPTY_BYTE_LENGTH);
assert.equal(
  createHash('sha256').update(CANONICAL_EMPTY_BYTES, 'utf8').digest('hex'),
  EMPTY_SHA256,
);
assert.match(STREAM_ID, UUID_V4_RE);
assert.match(DEAD_LETTER_ID, UUID_V4_RE);
assert.match(ENQUEUED_AT, MS_UTC_RE);
assert.match(EMPTY_SHA256, SHA256_HEX_RE);
assert.equal(IDEMPOTENCY_KEY, `audit-integrity-alert:${STREAM_ID}:${SEQUENCE}`);
assert.equal(new Date(ENQUEUED_AT).toISOString(), ENQUEUED_AT);
assert.equal(new Date(FIRST_ATTEMPT_AT).toISOString(), FIRST_ATTEMPT_AT);
assert.equal(new Date(LAST_ATTEMPT_AT).toISOString(), LAST_ATTEMPT_AT);
assert.equal(new Date(SOURCE_CHECKED_AT).toISOString(), SOURCE_CHECKED_AT);
assert.deepEqual(Object.keys(buildCallerEntry()), [...CALLER_ENTRY_KEYS]);
assert.deepEqual(Object.keys(buildPersistedEntry(1)), [...PERSISTED_ENTRY_KEYS]);
assert.deepEqual(Object.keys(buildSourceAlert()), [...SOURCE_ALERT_KEYS]);
assert.deepEqual(Object.keys(buildFileState(1, [])), [...TOP_FILE_KEYS]);

const FIRST_PERSISTED = buildPersistedEntry(1);
const CANONICAL_ONE_ENTRY_BYTES = canonicalFileBytes(2, [FIRST_PERSISTED]);
const FIRST_APPEND_FP = handFingerprint(CANONICAL_ONE_ENTRY_BYTES, 1, 2);
assert.ok(
  Buffer.byteLength(CANONICAL_ONE_ENTRY_BYTES, 'utf8') <= EXPECTED_MAX_BYTES,
);
assert.ok(Buffer.byteLength(CANONICAL_EMPTY_BYTES, 'utf8') <= EXPECTED_MAX_BYTES);

/**
 * Deterministic lowercase UUIDv4 for capacity fixtures (index 0..255).
 * @param {number} index
 */
function deadLetterIdFor(index) {
  const n = index + 1;
  const hex = n.toString(16).padStart(12, '0');
  return `d${hex.slice(0, 7)}-e444-4444-b444-${hex}`;
}

/**
 * N contiguous persisted entries with distinct (streamId, sequence) identities.
 * @param {number} n
 * @param {number} [startSequence]
 */
function rebuildNPersistedEntries(n, startSequence = 1) {
  const entries = [];
  for (let i = 0; i < n; i += 1) {
    const seq = startSequence + i;
    entries.push(buildPersistedEntry(i + 1, {
      deadLetterId: deadLetterIdFor(i),
      streamId: STREAM_ID,
      sequence: seq,
      idempotencyKey: `audit-integrity-alert:${STREAM_ID}:${seq}`,
      attemptCount: (i % 8) + 1,
      reason: REASONS[i % 3],
      sourceAlert: buildSourceAlert({ sequence: seq }),
    }));
  }
  return entries;
}

// Validate generated UUIDs for capacity fixtures.
for (const i of [0, 1, 10, 255]) {
  assert.match(deadLetterIdFor(i), UUID_V4_RE);
}

describe('audit integrity alert dead-letter FIFO (Task 3 RED)', () => {
  // Old-HEAD: exactly one dedicated RED. Full behavioral matrix registers only when exports exist.
  if (implementationMissing || deadLetterApi === null) {
    it('dead-letter fifo implementation missing', () => {
      assert.fail(MISSING_MSG);
    });
    return;
  }

  // ── A. Constants / API surface ─────────────────────────────────────────

  it('exports relative path, max bytes 1048576, max entries 256, and three public helpers only', () => {
    // Break: wrong path/bounds or extra operator APIs would misplace DLQ or open requeue/drop.
    const api = requireApi();
    assert.equal(
      api.AUDIT_INTEGRITY_ALERT_DEAD_LETTER_RELATIVE_PATH,
      RELATIVE_PATH,
    );
    assert.equal(
      api.AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_BYTES,
      EXPECTED_MAX_BYTES,
    );
    assert.equal(
      api.AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_ENTRIES,
      EXPECTED_MAX_ENTRIES,
    );
    assert.equal(typeof api.readAuditIntegrityAlertDeadLetter, 'function');
    assert.equal(
      typeof api.appendAuditIntegrityAlertDeadLetterUnderLease,
      'function',
    );
    assert.equal(
      typeof api.fingerprintAuditIntegrityAlertDeadLetterRaw,
      'function',
    );
    // Append signature is exactly (dataDir, lease, entry) — no prepared deadLetterPost.
    assert.equal(api.appendAuditIntegrityAlertDeadLetterUnderLease.length, 3);
    assert.equal(api.readAuditIntegrityAlertDeadLetter.length, 1);
    assert.equal(api.fingerprintAuditIntegrityAlertDeadLetterRaw.length, 1);

    assert.ok(
      Buffer.byteLength(CANONICAL_EMPTY_BYTES, 'utf8')
        <= api.AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_BYTES,
    );
    assert.ok(
      Buffer.byteLength(CANONICAL_ONE_ENTRY_BYTES, 'utf8')
        <= api.AUDIT_INTEGRITY_ALERT_DEAD_LETTER_MAX_BYTES,
    );
  });

  it('module surface has no requeue drop rewrite delete or operator advance APIs', async () => {
    // Break: shipping quarantine-advance APIs would violate append-only inspect contract.
    const mod = await import(PRODUCTION_MODULE_URL.href);
    const keys = Object.keys(mod).sort();
    assert.deepEqual(keys, [...EXPECTED_EXPORTS].sort());
    for (const forbidden of [
      'requeue',
      'drop',
      'rewrite',
      'delete',
      'remove',
      'advance',
      'purge',
      'clear',
      'truncate',
      'operator',
      'ack',
      'acknowledge',
    ]) {
      for (const key of keys) {
        assert.equal(
          key.toLowerCase().includes(forbidden),
          false,
          `unexpected API surface containing ${forbidden}: ${key}`,
        );
      }
    }
  });

  // ── B. Fingerprint helper ──────────────────────────────────────────────

  it('fingerprint of exact empty canonical returns literal sha256 byteLength 50 entryCount 0 nextSequence 1', () => {
    // Break: hashing missing-state differently than durable empty would desync prepared pre fingerprints.
    const api = requireApi();
    const fp = api.fingerprintAuditIntegrityAlertDeadLetterRaw(CANONICAL_EMPTY_BYTES);
    assertExactFingerprint(fp, {
      sha256: EMPTY_SHA256,
      byteLength: EMPTY_BYTE_LENGTH,
      entryCount: 0,
      nextSequence: 1,
    });
    assert.equal(fp.sha256, EMPTY_SHA256);
    assert.equal(fp.byteLength, 50);
  });

  it('fingerprint of one-entry canonical returns frozen exact keys matching hand-derived hash', () => {
    // Break: non-canonical raw acceptance or wrong counters would lie about durable post identity.
    const api = requireApi();
    const fp = api.fingerprintAuditIntegrityAlertDeadLetterRaw(CANONICAL_ONE_ENTRY_BYTES);
    assertExactFingerprint(fp, FIRST_APPEND_FP);
  });

  it('fingerprint rejects noncanonical corrupt oversize and hostile raw without repair', () => {
    // Break: loose fingerprint would let coordinator accept forged prepared posts.
    const api = requireApi();
    const oversize = 'x'.repeat(EXPECTED_MAX_BYTES + 1);
    const badRaws = [
      '',
      ' ',
      '{}\n',
      CANONICAL_EMPTY_BYTES.slice(0, -1),
      `${CANONICAL_EMPTY_BYTES}\n`,
      `\uFEFF${CANONICAL_EMPTY_BYTES}`,
      `${JSON.stringify(buildFileState(1, []), null, 2)}\n`,
      CANONICAL_EMPTY_BYTES.replace(':', ': '),
      CANONICAL_EMPTY_BYTES.replace(',', ',\t'),
      '{"nextSequence":1,"schemaVersion":1,"entries":[]}\n',
      '{"schemaVersion":1,"nextSequence":1,"entries":[],"extra":true}\n',
      '{"schemaVersion":2,"nextSequence":1,"entries":[]}\n',
      '{"schemaVersion":1,"nextSequence":0,"entries":[]}\n',
      '{"schemaVersion":1,"nextSequence":1.5,"entries":[]}\n',
      '{"schemaVersion":1,"nextSequence":1,"entries":null}\n',
      oversize,
      '{not-json\n',
    ];
    for (const raw of badRaws) {
      assert.throws(
        () => api.fingerprintAuditIntegrityAlertDeadLetterRaw(raw),
        (error) => assertUnavailable(error, [raw.slice(0, 32), 'not-json']),
      );
    }
    for (const bad of [null, undefined, 1, true, false, {}, [], Buffer.from(CANONICAL_EMPTY_BYTES)]) {
      assert.throws(
        () => api.fingerprintAuditIntegrityAlertDeadLetterRaw(bad),
        (error) => assertUnavailable(error),
      );
    }
  });

  // ── C. Read missing / ready / empty-file ───────────────────────────────

  it('read missing leaf returns exact frozen empty snapshot and creates nothing', async () => {
    // Break: auto-creating DLQ or treating missing as error would invent quarantine history.
    const api = requireApi();
    await withTempRoot('read-missing', async (root) => {
      const snapshot = await api.readAuditIntegrityAlertDeadLetter(root);
      assertExactSnapshot(snapshot, emptyMissingSnapshot());
      assert.deepEqual(Object.keys(snapshot), [...SNAPSHOT_KEYS]);
      assert.equal(snapshot.status, 'empty');
      assert.equal(snapshot.entryCount, 0);
      assert.equal(snapshot.nextSequence, 1);
      assert.deepEqual(snapshot.entries, []);
      await assert.rejects(() => access(dlqAbs(root)), { code: 'ENOENT' });
      await assert.rejects(() => access(join(root, 'audit')), { code: 'ENOENT' });
    });
  });

  it('read present canonical zero-entry file is status ready not empty and leaves bytes identical', async () => {
    // Break: treating present empty file as missing would drop durable empty identity.
    const api = requireApi();
    await withTempRoot('read-ready-empty-file', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(dlqAbs(root), CANONICAL_EMPTY_BYTES, { mode: 0o600 });
      const before = await readFile(dlqAbs(root));
      const snapshot = await api.readAuditIntegrityAlertDeadLetter(root);
      assertExactSnapshot(snapshot, readySnapshot(1, []));
      assert.equal(snapshot.status, 'ready');
      assert.equal(snapshot.entryCount, 0);
      assert.deepEqual(await readFile(dlqAbs(root)), before);
      assert.equal(await readFile(dlqAbs(root), 'utf8'), CANONICAL_EMPTY_BYTES);
    });
  });

  it('read present one-entry file returns ready frozen defensive copies with exact entry key order', async () => {
    // Break: reordering entry keys or sharing mutable refs would dual-interpret quarantine rows.
    const api = requireApi();
    await withTempRoot('read-one-entry', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(dlqAbs(root), CANONICAL_ONE_ENTRY_BYTES, { mode: 0o600 });
      const before = await readFile(dlqAbs(root));
      const snapshot = await api.readAuditIntegrityAlertDeadLetter(root);
      assertExactSnapshot(snapshot, readySnapshot(2, [FIRST_PERSISTED]));
      assert.deepEqual(Object.keys(snapshot.entries[0]), [...PERSISTED_ENTRY_KEYS]);
      assert.deepEqual(
        Object.keys(snapshot.entries[0].sourceAlert),
        [...SOURCE_ALERT_KEYS],
      );
      assertDeeplyFrozen(snapshot.entries[0]);
      // Mutation resistance: frozen defensive copy must throw; disk stays identical.
      assert.throws(() => {
        /** @type {{ reason: string }} */ (snapshot.entries[0]).reason = 'mutated';
      }, TypeError);
      assert.throws(() => {
        /** @type {{ code: string }} */ (snapshot.entries[0].sourceAlert).code = 'mutated';
      }, TypeError);
      assert.throws(() => {
        snapshot.entries.push(FIRST_PERSISTED);
      }, TypeError);
      assert.equal(await readFile(dlqAbs(root), 'utf8'), CANONICAL_ONE_ENTRY_BYTES);
      const again = await api.readAuditIntegrityAlertDeadLetter(root);
      assert.equal(again.entries[0].reason, REASON_TERMINAL);
      assert.notEqual(again, snapshot);
      assert.deepEqual(await readFile(dlqAbs(root)), before);
    });
  });

  // ── D. Corrupt / unsafe read matrix ────────────────────────────────────

  it('present zero-byte file is corrupt fail-closed with zero repair or mutation', async () => {
    // Break: treating zero-byte as missing/empty would invent empty state and hide corruption.
    const api = requireApi();
    await withTempRoot('zero-byte', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(dlqAbs(root), '', { mode: 0o600 });
      const before = await readFile(dlqAbs(root));
      assert.equal(before.length, 0);
      await assert.rejects(
        () => api.readAuditIntegrityAlertDeadLetter(root),
        (error) => assertUnavailable(error, [root, dlqAbs(root)]),
      );
      assert.deepEqual(await readFile(dlqAbs(root)), before);
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => api.appendAuditIntegrityAlertDeadLetterUnderLease(
            resolvedRoot,
            lease,
            buildCallerEntry(),
          ),
          (error) => assertUnavailable(error, [root, dlqAbs(root)]),
        );
      });
      assert.deepEqual(await readFile(dlqAbs(root)), before);
      assert.equal((await readFile(dlqAbs(root))).length, 0);
    });
  });

  it('rejects BOM missing/double newline pretty JSON trailing space oversize invalid UTF-8 symlink and directory leaf without mutation', async () => {
    // Break: loose file grammar or following symlink would dual-read or clobber outside data.
    const api = requireApi();
    const oversizeRaw = 'x'.repeat(EXPECTED_MAX_BYTES + 1);
    assert.equal(Buffer.byteLength(oversizeRaw, 'utf8'), EXPECTED_MAX_BYTES + 1);

    const textCases = [
      { name: 'bom', raw: `\uFEFF${CANONICAL_EMPTY_BYTES}` },
      { name: 'missing-newline', raw: CANONICAL_EMPTY_BYTES.slice(0, -1) },
      { name: 'double-newline', raw: `${CANONICAL_EMPTY_BYTES}\n` },
      {
        name: 'pretty-json',
        raw: `${JSON.stringify(buildFileState(1, []), null, 2)}\n`,
      },
      {
        name: 'trailing-space',
        raw: `${CANONICAL_EMPTY_BYTES.slice(0, -1)} \n`,
      },
      {
        name: 'space-after-colon',
        raw: CANONICAL_EMPTY_BYTES.replace(':', ': '),
      },
      {
        name: 'tab-after-comma',
        raw: CANONICAL_EMPTY_BYTES.replace(',', ',\t'),
      },
      {
        name: 'reordered-top-keys',
        raw: '{"nextSequence":1,"schemaVersion":1,"entries":[]}\n',
      },
      {
        name: 'extra-top-key',
        raw: '{"schemaVersion":1,"nextSequence":1,"entries":[],"extra":true}\n',
      },
      {
        name: 'unicode-escape',
        raw: CANONICAL_EMPTY_BYTES.replace(
          '"entries"',
          '"\\u0065ntries"',
        ),
      },
      { name: 'trailing-garbage', raw: `${CANONICAL_EMPTY_BYTES.slice(0, -1)} trailing\n` },
      { name: 'invalid-json', raw: '{not-json\n' },
      { name: 'empty', raw: '' },
      { name: 'oversize', raw: oversizeRaw },
      {
        name: 'entry-key-reorder',
        raw: canonicalFileBytes(2, [
          reorderKeys(FIRST_PERSISTED, [
            'deadLetterId',
            'deadLetterSequence',
            'streamId',
            'sequence',
            'idempotencyKey',
            'enqueuedAt',
            'attemptCount',
            'firstAttemptAt',
            'lastAttemptAt',
            'reason',
            'sourceAlert',
          ]),
        ]),
      },
      {
        name: 'sourceAlert-key-reorder',
        raw: canonicalFileBytes(2, [
          buildPersistedEntry(1, {
            sourceAlert: {
              checkedAt: SOURCE_CHECKED_AT,
              sequence: SEQUENCE,
              code: 'audit-integrity-cross-store-broken',
              recoveryRequired: true,
              nextAction: 'run-explicit-recovery',
              reasonCode: null,
            },
          }),
        ]),
      },
    ];

    for (const { name, raw } of textCases) {
      await withTempRoot(`raw-${name}`, async (root) => {
        await mkdir(join(root, 'audit'), { recursive: true });
        await writeFile(dlqAbs(root), raw, { mode: 0o600 });
        const before = await readFile(dlqAbs(root));
        await assert.rejects(
          () => api.readAuditIntegrityAlertDeadLetter(root),
          (error) => assertUnavailable(error, [
            root,
            dlqAbs(root),
            raw.slice(0, 48),
            'not-json',
            'trailing',
          ]),
        );
        assert.deepEqual(await readFile(dlqAbs(root)), before);
        await withLease(root, async (resolvedRoot, lease) => {
          await assert.rejects(
            () => api.appendAuditIntegrityAlertDeadLetterUnderLease(
              resolvedRoot,
              lease,
              buildCallerEntry(),
            ),
            (error) => assertUnavailable(error, [root, dlqAbs(root)]),
          );
        });
        assert.deepEqual(await readFile(dlqAbs(root)), before);
      });
    }

    await withTempRoot('invalid-utf8', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      const invalidUtf8 = Buffer.concat([
        Buffer.from(CANONICAL_EMPTY_BYTES.slice(0, -1), 'utf8'),
        Buffer.from([0xff, 0xfe]),
        Buffer.from('\n', 'utf8'),
      ]);
      await writeFile(dlqAbs(root), invalidUtf8, { mode: 0o600 });
      const before = await readFile(dlqAbs(root));
      await assert.rejects(
        () => api.readAuditIntegrityAlertDeadLetter(root),
        (error) => assertUnavailable(error, [root, dlqAbs(root)]),
      );
      assert.deepEqual(await readFile(dlqAbs(root)), before);
    });

    await withTempRoot('dir-leaf', async (root) => {
      await mkdir(dlqAbs(root), { recursive: true });
      await assert.rejects(
        () => api.readAuditIntegrityAlertDeadLetter(root),
        (error) => assertUnavailable(error, [root, dlqAbs(root)]),
      );
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => api.appendAuditIntegrityAlertDeadLetterUnderLease(
            resolvedRoot,
            lease,
            buildCallerEntry(),
          ),
          (error) => assertUnavailable(error, [root, dlqAbs(root)]),
        );
      });
      const st = await lstat(dlqAbs(root));
      assert.equal(st.isDirectory(), true);
    });

    await withTempRoot('symlink-leaf', async (root) => {
      const outside = await mkdtemp(join(tmpdir(), 'linke-dlq-sym-out-'));
      try {
        const target = join(outside, 'target.json');
        await writeFile(target, CANONICAL_ONE_ENTRY_BYTES, { mode: 0o600 });
        await mkdir(join(root, 'audit'), { recursive: true });
        await symlink(target, dlqAbs(root));
        const before = await readFile(target);

        await assert.rejects(
          () => api.readAuditIntegrityAlertDeadLetter(root),
          (error) => assertUnavailable(error, [
            root,
            dlqAbs(root),
            target,
            outside,
            DEAD_LETTER_ID,
          ]),
        );
        await withLease(root, async (resolvedRoot, lease) => {
          await assert.rejects(
            () => api.appendAuditIntegrityAlertDeadLetterUnderLease(
              resolvedRoot,
              lease,
              buildCallerEntry({
                streamId: STREAM_ID_B,
                sequence: SEQUENCE_B,
                idempotencyKey: IDEMPOTENCY_KEY_B,
                sourceAlert: buildSourceAlert({ sequence: SEQUENCE_B }),
              }),
            ),
            (error) => assertUnavailable(error, [root, target, outside]),
          );
        });

        assert.deepEqual(await readFile(target), before);
        assert.equal(await readFile(target, 'utf8'), CANONICAL_ONE_ENTRY_BYTES);
        const st = await lstat(dlqAbs(root));
        assert.equal(st.isSymbolicLink(), true);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('rejects allocator histories that do not originate at deadLetterSequence 1 with zero repair', async () => {
    // Break: accepting empty nextSequence 2 or first deadLetterSequence 2 permits
    // fabricated/truncated DLQ-local allocator history (schema: allocator starts at 1).
    const api = requireApi();

    const emptyNextSequence2 = canonicalFileBytes(2, []);
    const firstSequenceStartsAt2 = canonicalFileBytes(3, [buildPersistedEntry(2)]);
    const gapAfter1 = canonicalFileBytes(4, [
      buildPersistedEntry(1),
      buildPersistedEntry(3, {
        deadLetterId: DEAD_LETTER_ID_B,
        streamId: STREAM_ID_B,
        sequence: SEQUENCE_B,
        idempotencyKey: IDEMPOTENCY_KEY_B,
        sourceAlert: buildSourceAlert({ sequence: SEQUENCE_B }),
      }),
    ]);
    // Contiguous entry 1 but nextSequence skips ahead (should be 2).
    const mismatchedNextSequence = canonicalFileBytes(3, [buildPersistedEntry(1)]);

    // Sanity: fixtures are compact + LF and distinct from valid start-at-1 states.
    assert.equal(emptyNextSequence2, '{"schemaVersion":1,"nextSequence":2,"entries":[]}\n');
    assert.notEqual(emptyNextSequence2, CANONICAL_EMPTY_BYTES);
    assert.equal(
      JSON.parse(firstSequenceStartsAt2.slice(0, -1)).entries[0].deadLetterSequence,
      2,
    );
    assert.equal(JSON.parse(firstSequenceStartsAt2.slice(0, -1)).nextSequence, 3);
    assert.equal(
      JSON.parse(gapAfter1.slice(0, -1)).entries.map((e) => e.deadLetterSequence).join(','),
      '1,3',
    );
    assert.equal(JSON.parse(mismatchedNextSequence.slice(0, -1)).nextSequence, 3);
    assert.equal(
      JSON.parse(mismatchedNextSequence.slice(0, -1)).entries[0].deadLetterSequence,
      1,
    );

    const allocatorOriginCases = [
      { name: 'empty-nextSequence-2', raw: emptyNextSequence2 },
      { name: 'first-deadLetterSequence-2', raw: firstSequenceStartsAt2 },
      { name: 'gap-after-1', raw: gapAfter1 },
      { name: 'mismatched-nextSequence', raw: mismatchedNextSequence },
    ];

    for (const { name, raw } of allocatorOriginCases) {
      // Fingerprint must fail closed (no forged post identity for truncated allocator).
      assert.throws(
        () => api.fingerprintAuditIntegrityAlertDeadLetterRaw(raw),
        (error) => assertUnavailable(error, [raw.slice(0, 48), name]),
      );

      await withTempRoot(`alloc-origin-${name}`, async (root) => {
        await mkdir(join(root, 'audit'), { recursive: true });
        await writeFile(dlqAbs(root), raw, { mode: 0o600 });
        const before = await readFile(dlqAbs(root));
        assert.equal(before.toString('utf8'), raw);

        await assert.rejects(
          () => api.readAuditIntegrityAlertDeadLetter(root),
          (error) => assertUnavailable(error, [root, dlqAbs(root), raw.slice(0, 48)]),
        );
        // Zero repair / truncation: durable bytes identical.
        assert.deepEqual(await readFile(dlqAbs(root)), before);
        assert.equal(await readFile(dlqAbs(root), 'utf8'), raw);

        await withLease(root, async (resolvedRoot, lease) => {
          await assert.rejects(
            () => api.appendAuditIntegrityAlertDeadLetterUnderLease(
              resolvedRoot,
              lease,
              buildCallerEntry({
                streamId: STREAM_ID_B,
                sequence: SEQUENCE_B,
                idempotencyKey: IDEMPOTENCY_KEY_B,
                deadLetterId: DEAD_LETTER_ID_B,
                sourceAlert: buildSourceAlert({ sequence: SEQUENCE_B }),
              }),
            ),
            (error) => assertUnavailable(error, [root, dlqAbs(root)]),
          );
        });
        assert.deepEqual(await readFile(dlqAbs(root)), before);
        assert.equal(await readFile(dlqAbs(root), 'utf8'), raw);
      });
    }
  });

  // ── E. First append + return fingerprint alignment ─────────────────────

  it('first append assigns deadLetterSequence 1 nextSequence 2 persists compact LF 0600 and returns durable fingerprint', async () => {
    // Break: wrong allocator, mode, or non-canonical bytes would desync coordinator post verify.
    const api = requireApi();
    await withTempRoot('first-append', async (root) => {
      await withLease(root, async (resolvedRoot, lease) => {
        const caller = buildCallerEntry();
        const returned = await api.appendAuditIntegrityAlertDeadLetterUnderLease(
          resolvedRoot,
          lease,
          caller,
        );
        assertExactFingerprint(returned, FIRST_APPEND_FP);

        const durableRaw = await readFile(dlqAbs(root), 'utf8');
        assert.equal(durableRaw, CANONICAL_ONE_ENTRY_BYTES);
        const st = await lstat(dlqAbs(root));
        assert.equal(st.isSymbolicLink(), false);
        assert.equal(st.isFile(), true);
        assert.equal(st.mode & 0o777, 0o600);

        const fromHelper = api.fingerprintAuditIntegrityAlertDeadLetterRaw(durableRaw);
        assertExactFingerprint(fromHelper, FIRST_APPEND_FP);
        assert.deepEqual(returned, fromHelper);
        assertDeeplyFrozen(returned);

        // Caller mutation must not poison already-persisted row.
        caller.reason = REASON_RETRYABLE;
        caller.sourceAlert.code = 'mutated';
        assert.equal(await readFile(dlqAbs(root), 'utf8'), CANONICAL_ONE_ENTRY_BYTES);

        const snapshot = await api.readAuditIntegrityAlertDeadLetter(resolvedRoot);
        assertExactSnapshot(snapshot, readySnapshot(2, [FIRST_PERSISTED]));
        assert.equal(snapshot.entries[0].deadLetterSequence, 1);
        assert.equal(snapshot.nextSequence, 2);
      });
    });
  });

  it('first append from missing leaf creates audit path mode 0600 without prior empty-file requirement', async () => {
    // Break: requiring a pre-created empty file would block first quarantine under lease.
    const api = requireApi();
    await withTempRoot('first-append-missing', async (root) => {
      await assert.rejects(() => access(join(root, 'audit')), { code: 'ENOENT' });
      await withLease(root, async (resolvedRoot, lease) => {
        const returned = await api.appendAuditIntegrityAlertDeadLetterUnderLease(
          resolvedRoot,
          lease,
          buildCallerEntry(),
        );
        assertExactFingerprint(returned, FIRST_APPEND_FP);
      });
      assert.equal(await readFile(dlqAbs(root), 'utf8'), CANONICAL_ONE_ENTRY_BYTES);
      const st = await lstat(dlqAbs(root));
      assert.equal(st.mode & 0o777, 0o600);
    });
  });

  // ── F. Idempotency (streamId, sequence) ────────────────────────────────

  it('exact duplicate identity is idempotent with bytes and counters unchanged and returns current fingerprint', async () => {
    // Break: rewriting duplicates or bumping nextSequence would invent extra quarantine rows.
    const api = requireApi();
    await withTempRoot('exact-dup', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(dlqAbs(root), CANONICAL_ONE_ENTRY_BYTES, { mode: 0o600 });
      const before = await readFile(dlqAbs(root));
      const preFp = handFingerprint(CANONICAL_ONE_ENTRY_BYTES, 1, 2);

      await withLease(root, async (resolvedRoot, lease) => {
        const returned = await api.appendAuditIntegrityAlertDeadLetterUnderLease(
          resolvedRoot,
          lease,
          buildCallerEntry(),
        );
        assertExactFingerprint(returned, preFp);
        const durableRaw = await readFile(dlqAbs(root), 'utf8');
        assert.equal(durableRaw, CANONICAL_ONE_ENTRY_BYTES);
        assert.deepEqual(
          returned,
          api.fingerprintAuditIntegrityAlertDeadLetterRaw(durableRaw),
        );
      });

      assert.deepEqual(await readFile(dlqAbs(root)), before);
      const snapshot = await api.readAuditIntegrityAlertDeadLetter(root);
      assertExactSnapshot(snapshot, readySnapshot(2, [FIRST_PERSISTED]));
      assert.equal(snapshot.entryCount, 1);
      assert.equal(snapshot.nextSequence, 2);
    });
  });

  it('duplicate identity with any of 10 non-allocator fields mismatched fails closed with bytes unchanged', async () => {
    // Break: soft-merging field mismatches would corrupt quarantine truth for same identity.
    const api = requireApi();
    const mismatches = [
      buildCallerEntry({ deadLetterId: DEAD_LETTER_ID_B }),
      buildCallerEntry({ enqueuedAt: '2026-08-05T12:06:00.000Z' }),
      buildCallerEntry({ attemptCount: 2 }),
      buildCallerEntry({ firstAttemptAt: '2026-08-05T12:00:01.000Z' }),
      buildCallerEntry({ lastAttemptAt: '2026-08-05T12:00:31.000Z' }),
      buildCallerEntry({ reason: REASON_RETRYABLE }),
      buildCallerEntry({
        sourceAlert: buildSourceAlert({ code: 'integrity-alert' }),
      }),
      buildCallerEntry({
        sourceAlert: buildSourceAlert({ recoveryRequired: false }),
      }),
      buildCallerEntry({
        sourceAlert: buildSourceAlert({ nextAction: 'investigate-integrity' }),
      }),
      buildCallerEntry({
        sourceAlert: buildSourceAlert({ reasonCode: 'some-reason' }),
      }),
      // idempotencyKey mismatch while streamId+sequence identity still matches
      buildCallerEntry({
        idempotencyKey: `audit-integrity-alert:${STREAM_ID}:999`,
      }),
    ];

    for (const [index, entry] of mismatches.entries()) {
      await withTempRoot(`dup-mismatch-${index}`, async (root) => {
        await mkdir(join(root, 'audit'), { recursive: true });
        await writeFile(dlqAbs(root), CANONICAL_ONE_ENTRY_BYTES, { mode: 0o600 });
        const before = await readFile(dlqAbs(root));
        await withLease(root, async (resolvedRoot, lease) => {
          await assert.rejects(
            () => api.appendAuditIntegrityAlertDeadLetterUnderLease(
              resolvedRoot,
              lease,
              entry,
            ),
            (error) => assertUnavailable(error, [
              root,
              DEAD_LETTER_ID_B,
              PRIVACY_CANARIES.endpoint,
            ]),
          );
        });
        assert.deepEqual(await readFile(dlqAbs(root)), before);
        assert.equal(await readFile(dlqAbs(root), 'utf8'), CANONICAL_ONE_ENTRY_BYTES);
      });
    }
  });

  // ── G. Second append allocator ─────────────────────────────────────────

  it('second distinct identity appends FIFO allocates deadLetterSequence 2 and nextSequence 3', async () => {
    // Break: non-FIFO insert or non-monotonic allocator would reorder quarantine.
    const api = requireApi();
    const secondCaller = buildCallerEntry({
      deadLetterId: DEAD_LETTER_ID_B,
      streamId: STREAM_ID_B,
      sequence: SEQUENCE_B,
      idempotencyKey: IDEMPOTENCY_KEY_B,
      reason: REASON_RETRYABLE,
      attemptCount: 8,
      sourceAlert: buildSourceAlert({ sequence: SEQUENCE_B }),
    });
    const secondPersisted = buildPersistedEntry(2, {
      deadLetterId: DEAD_LETTER_ID_B,
      streamId: STREAM_ID_B,
      sequence: SEQUENCE_B,
      idempotencyKey: IDEMPOTENCY_KEY_B,
      reason: REASON_RETRYABLE,
      attemptCount: 8,
      sourceAlert: buildSourceAlert({ sequence: SEQUENCE_B }),
    });
    const expectedBytes = canonicalFileBytes(3, [FIRST_PERSISTED, secondPersisted]);
    const expectedFp = handFingerprint(expectedBytes, 2, 3);

    await withTempRoot('second-append', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(dlqAbs(root), CANONICAL_ONE_ENTRY_BYTES, { mode: 0o600 });
      await withLease(root, async (resolvedRoot, lease) => {
        const returned = await api.appendAuditIntegrityAlertDeadLetterUnderLease(
          resolvedRoot,
          lease,
          secondCaller,
        );
        assertExactFingerprint(returned, expectedFp);
        assert.equal(await readFile(dlqAbs(root), 'utf8'), expectedBytes);
        assert.deepEqual(
          returned,
          api.fingerprintAuditIntegrityAlertDeadLetterRaw(
            await readFile(dlqAbs(root), 'utf8'),
          ),
        );
      });
      const snapshot = await api.readAuditIntegrityAlertDeadLetter(root);
      assertExactSnapshot(
        snapshot,
        readySnapshot(3, [FIRST_PERSISTED, secondPersisted]),
      );
      assert.equal(snapshot.entries[0].deadLetterSequence, 1);
      assert.equal(snapshot.entries[1].deadLetterSequence, 2);
    });
  });

  // ── H. Bounds: 256 entries + 1 MiB ─────────────────────────────────────

  it('append of entry 256 succeeds and append of entry 257 fails without mutation', async () => {
    // Break: soft-overflow or silent drop would lose quarantine or invent capacity.
    const api = requireApi();
    const entries255 = rebuildNPersistedEntries(255, 1);
    const raw255 = canonicalFileBytes(256, entries255);
    assert.ok(Buffer.byteLength(raw255, 'utf8') <= EXPECTED_MAX_BYTES);

    const caller256 = buildCallerEntry({
      deadLetterId: deadLetterIdFor(255),
      streamId: STREAM_ID,
      sequence: 256,
      idempotencyKey: `audit-integrity-alert:${STREAM_ID}:256`,
      attemptCount: 8,
      reason: REASONS[255 % 3],
      sourceAlert: buildSourceAlert({ sequence: 256 }),
    });
    const persisted256 = buildPersistedEntry(256, {
      deadLetterId: deadLetterIdFor(255),
      streamId: STREAM_ID,
      sequence: 256,
      idempotencyKey: `audit-integrity-alert:${STREAM_ID}:256`,
      attemptCount: 8,
      reason: REASONS[255 % 3],
      sourceAlert: buildSourceAlert({ sequence: 256 }),
    });
    const expected256Bytes = canonicalFileBytes(257, [...entries255, persisted256]);
    assert.ok(Buffer.byteLength(expected256Bytes, 'utf8') <= EXPECTED_MAX_BYTES);
    const expected256Fp = handFingerprint(expected256Bytes, 256, 257);

    await withTempRoot('bound-256', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(dlqAbs(root), raw255, { mode: 0o600 });

      await withLease(root, async (resolvedRoot, lease) => {
        const returned = await api.appendAuditIntegrityAlertDeadLetterUnderLease(
          resolvedRoot,
          lease,
          caller256,
        );
        assertExactFingerprint(returned, expected256Fp);
        assert.equal(await readFile(dlqAbs(root), 'utf8'), expected256Bytes);
      });

      const atCapacity = await readFile(dlqAbs(root));
      const caller257 = buildCallerEntry({
        deadLetterId: deadLetterIdFor(256),
        streamId: STREAM_ID,
        sequence: 257,
        idempotencyKey: `audit-integrity-alert:${STREAM_ID}:257`,
        sourceAlert: buildSourceAlert({ sequence: 257 }),
      });
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => api.appendAuditIntegrityAlertDeadLetterUnderLease(
            resolvedRoot,
            lease,
            caller257,
          ),
          (error) => assertUnavailable(error, [root, dlqAbs(root)]),
        );
      });
      assert.deepEqual(await readFile(dlqAbs(root)), atCapacity);
      assert.equal(await readFile(dlqAbs(root), 'utf8'), expected256Bytes);

      const snapshot = await api.readAuditIntegrityAlertDeadLetter(root);
      assert.equal(snapshot.status, 'ready');
      assert.equal(snapshot.entryCount, 256);
      assert.equal(snapshot.nextSequence, 257);
    });
  });

  it('oversize present file and candidate serialized oversize fail closed before truncate or publish', async () => {
    // Break: truncating oversize DLQ would destroy quarantine evidence.
    const api = requireApi();
    const oversizeRaw = `{"schemaVersion":1,"nextSequence":1,"entries":[],"pad":"${'x'.repeat(EXPECTED_MAX_BYTES)}"}\n`;
    assert.ok(Buffer.byteLength(oversizeRaw, 'utf8') > EXPECTED_MAX_BYTES);

    await withTempRoot('oversize-present', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(dlqAbs(root), oversizeRaw, { mode: 0o600 });
      const before = await readFile(dlqAbs(root));
      await assert.rejects(
        () => api.readAuditIntegrityAlertDeadLetter(root),
        (error) => assertUnavailable(error, [root, dlqAbs(root)]),
      );
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => api.appendAuditIntegrityAlertDeadLetterUnderLease(
            resolvedRoot,
            lease,
            buildCallerEntry(),
          ),
          (error) => assertUnavailable(error, [root, dlqAbs(root)]),
        );
      });
      assert.deepEqual(await readFile(dlqAbs(root)), before);
      assert.equal((await readFile(dlqAbs(root))).length, before.length);
    });

    // Fingerprint of oversize raw rejects without side effects.
    assert.throws(
      () => api.fingerprintAuditIntegrityAlertDeadLetterRaw(oversizeRaw),
      (error) => assertUnavailable(error),
    );
  });

  // ── I. Field validation / privacy ──────────────────────────────────────

  it('rejects caller deadLetterSequence extra keys wrong key order and hostile shapes without write', async () => {
    // Break: accepting allocator from caller or Proxy whitewash would forge sequences/secrets.
    const api = requireApi();

    const withAllocator = {
      deadLetterSequence: 99,
      ...buildCallerEntry(),
    };
    const reorderedCaller = reorderKeys(buildCallerEntry(), [
      'streamId',
      'deadLetterId',
      'sequence',
      'idempotencyKey',
      'enqueuedAt',
      'attemptCount',
      'firstAttemptAt',
      'lastAttemptAt',
      'reason',
      'sourceAlert',
    ]);
    const extraTop = { ...buildCallerEntry(), endpoint: PRIVACY_CANARIES.endpoint };
    const missingKey = (() => {
      const e = buildCallerEntry();
      delete e.reason;
      return e;
    })();
    const sourceAlertExtra = buildCallerEntry({
      sourceAlert: {
        ...buildSourceAlert(),
        endpoint: PRIVACY_CANARIES.endpoint,
      },
    });
    const sourceAlertNetwork = buildCallerEntry({
      sourceAlert: {
        ...buildSourceAlert(),
        headers: PRIVACY_CANARIES.headers,
      },
    });
    const sourceAlertIp = buildCallerEntry({
      sourceAlert: {
        ...buildSourceAlert(),
        IP: PRIVACY_CANARIES.IP,
      },
    });
    const sourceAlertPath = buildCallerEntry({
      sourceAlert: {
        ...buildSourceAlert(),
        path: PRIVACY_CANARIES.path,
      },
    });
    const sourceAlertBody = buildCallerEntry({
      sourceAlert: {
        ...buildSourceAlert(),
        body: 'remote-body',
      },
    });
    const sourceAlertRawError = buildCallerEntry({
      sourceAlert: {
        ...buildSourceAlert(),
        rawError: PRIVACY_CANARIES.rawError,
      },
    });
    const sourceAlertClaimOwner = buildCallerEntry({
      sourceAlert: {
        ...buildSourceAlert(),
        claimOwner: PRIVACY_CANARIES.claimOwner,
      },
    });
    const sourceAlertStatus = buildCallerEntry({
      sourceAlert: {
        ...buildSourceAlert(),
        statusCode: PRIVACY_CANARIES.statusCode,
      },
    });
    const sequenceMismatch = buildCallerEntry({
      sourceAlert: buildSourceAlert({ sequence: SEQUENCE + 1 }),
    });

    const cases = [
      withAllocator,
      reorderedCaller,
      extraTop,
      missingKey,
      sourceAlertExtra,
      sourceAlertNetwork,
      sourceAlertIp,
      sourceAlertPath,
      sourceAlertBody,
      sourceAlertRawError,
      sourceAlertClaimOwner,
      sourceAlertStatus,
      sequenceMismatch,
      null,
      undefined,
      'entry',
      1,
      true,
      [],
      Object.create(null),
    ];

    for (const [index, entry] of cases.entries()) {
      await withTempRoot(`invalid-entry-${index}`, async (root) => {
        await withLease(root, async (resolvedRoot, lease) => {
          await assert.rejects(
            () => api.appendAuditIntegrityAlertDeadLetterUnderLease(
              resolvedRoot,
              lease,
              entry,
            ),
            (error) => assertUnavailable(error, [
              root,
              PRIVACY_CANARIES.endpoint,
              PRIVACY_CANARIES.IP,
              PRIVACY_CANARIES.path,
              PRIVACY_CANARIES.rawError,
              PRIVACY_CANARIES.claimOwner,
              String(PRIVACY_CANARIES.statusCode),
            ]),
          );
        });
        await assert.rejects(() => access(dlqAbs(root)), { code: 'ENOENT' });
      });
    }

    await withTempRoot('proxy-entry', async (root) => {
      const target = buildCallerEntry();
      const traps = { get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0 };
      const proxy = new Proxy(target, {
        get(...args) {
          traps.get += 1;
          return Reflect.get(...args);
        },
        ownKeys(...args) {
          traps.ownKeys += 1;
          return Reflect.ownKeys(...args);
        },
        getOwnPropertyDescriptor(...args) {
          traps.getOwnPropertyDescriptor += 1;
          return Reflect.getOwnPropertyDescriptor(...args);
        },
        getPrototypeOf(...args) {
          traps.getPrototypeOf += 1;
          return Reflect.getPrototypeOf(...args);
        },
      });
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => api.appendAuditIntegrityAlertDeadLetterUnderLease(
            resolvedRoot,
            lease,
            proxy,
          ),
          (error) => assertUnavailable(error, [root, 'SECRET']),
        );
      });
      assert.deepEqual(traps, {
        get: 0,
        ownKeys: 0,
        getOwnPropertyDescriptor: 0,
        getPrototypeOf: 0,
      });
      await assert.rejects(() => access(dlqAbs(root)), { code: 'ENOENT' });
    });
  });

  it('rejects invalid UUID ISO attemptCount reason enum and idempotencyKey grammar without write', async () => {
    // Break: loose field grammar would accept non-canonical quarantine rows.
    const api = requireApi();
    const invalids = [
      buildCallerEntry({ deadLetterId: DEAD_LETTER_ID.toUpperCase() }),
      buildCallerEntry({ deadLetterId: 'not-a-uuid' }),
      buildCallerEntry({ deadLetterId: '11111111-1111-1111-8111-111111111111' }),
      buildCallerEntry({ streamId: STREAM_ID.toUpperCase() }),
      buildCallerEntry({ streamId: 'not-a-uuid' }),
      buildCallerEntry({ sequence: 0 }),
      buildCallerEntry({ sequence: -1 }),
      buildCallerEntry({ sequence: 1.5 }),
      buildCallerEntry({ sequence: Number.NaN }),
      buildCallerEntry({ sequence: Number.MAX_SAFE_INTEGER + 1 }),
      buildCallerEntry({ sequence: '7' }),
      buildCallerEntry({ attemptCount: 0 }),
      buildCallerEntry({ attemptCount: 9 }),
      buildCallerEntry({ attemptCount: 1.5 }),
      buildCallerEntry({ attemptCount: '1' }),
      buildCallerEntry({ attemptCount: Number.NaN }),
      buildCallerEntry({ reason: 'dead-letter-corrupt' }),
      buildCallerEntry({ reason: 'lifecycle-recovery' }),
      buildCallerEntry({ reason: 'TERMINAL-HTTP' }),
      buildCallerEntry({ reason: 'retryable-http' }),
      buildCallerEntry({ enqueuedAt: '2026-08-05T12:05:00Z' }),
      buildCallerEntry({ enqueuedAt: '2026-08-05T12:05:00.000+00:00' }),
      buildCallerEntry({ firstAttemptAt: '2026-08-05 12:00:00.000Z' }),
      buildCallerEntry({ lastAttemptAt: '2026-08-05T12:00:30.000z' }),
      buildCallerEntry({
        idempotencyKey: `AUDIT-INTEGRITY-ALERT:${STREAM_ID}:${SEQUENCE}`,
      }),
      buildCallerEntry({
        idempotencyKey: `audit-integrity-alert:${STREAM_ID}`,
      }),
      buildCallerEntry({
        idempotencyKey: `audit-integrity-alert:${STREAM_ID}:8`,
      }),
      buildCallerEntry({ idempotencyKey: IDEMPOTENCY_KEY.toUpperCase() }),
      buildCallerEntry({
        sourceAlert: buildSourceAlert({ checkedAt: '2026-08-05T11:59:00Z' }),
      }),
      buildCallerEntry({
        sourceAlert: buildSourceAlert({ code: 'NOT_KEBAB' }),
      }),
      buildCallerEntry({
        sourceAlert: buildSourceAlert({ recoveryRequired: 'true' }),
      }),
    ];

    for (const [index, entry] of invalids.entries()) {
      await withTempRoot(`field-invalid-${index}`, async (root) => {
        await withLease(root, async (resolvedRoot, lease) => {
          await assert.rejects(
            () => api.appendAuditIntegrityAlertDeadLetterUnderLease(
              resolvedRoot,
              lease,
              entry,
            ),
            (error) => assertUnavailable(error, [
              root,
              'dead-letter-corrupt',
              'lifecycle-recovery',
            ]),
          );
        });
        await assert.rejects(() => access(dlqAbs(root)), { code: 'ENOENT' });
      });
    }
  });

  it('accepts each exact reason enum value terminal-http attempts-exhausted-retryable attempts-exhausted-uncertain', async () => {
    // Break: dropping a reason enum would block terminalization paths.
    const api = requireApi();
    await withTempRoot('reason-enum', async (root) => {
      await withLease(root, async (resolvedRoot, lease) => {
        for (const [i, reason] of REASONS.entries()) {
          const seq = 100 + i;
          const entry = buildCallerEntry({
            deadLetterId: deadLetterIdFor(i + 10),
            streamId: STREAM_ID,
            sequence: seq,
            idempotencyKey: `audit-integrity-alert:${STREAM_ID}:${seq}`,
            reason,
            sourceAlert: buildSourceAlert({ sequence: seq }),
          });
          const returned = await api.appendAuditIntegrityAlertDeadLetterUnderLease(
            resolvedRoot,
            lease,
            entry,
          );
          assert.deepEqual(Object.keys(returned), [...FINGERPRINT_KEYS]);
          assertDeeplyFrozen(returned);
        }
      });
      const snapshot = await api.readAuditIntegrityAlertDeadLetter(root);
      assert.equal(snapshot.entryCount, 3);
      assert.deepEqual(
        snapshot.entries.map((e) => e.reason),
        [...REASONS],
      );
      assert.equal(snapshot.nextSequence, 4);
      const st = await lstat(dlqAbs(root));
      assert.equal(st.mode & 0o777, 0o600);
    });
  });

  // ── J. Lease fencing ───────────────────────────────────────────────────

  it('invalid missing expired and wrong-root leases perform zero write on append', async () => {
    // Break: accepting a non-active lease would allow out-of-queue DLQ mutation.
    const api = requireApi();

    await withTempRoot('lease-missing-forged', async (root) => {
      const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
      const resolvedRoot = await assertSafeDataRoot(root);
      for (const lease of [null, undefined, Object.freeze({}), Object.freeze({ forged: true })]) {
        await assert.rejects(
          () => api.appendAuditIntegrityAlertDeadLetterUnderLease(
            resolvedRoot,
            lease,
            buildCallerEntry(),
          ),
          (error) => assertUnavailable(error, [root, 'forged']),
        );
      }
      await assert.rejects(() => access(dlqAbs(root)), { code: 'ENOENT' });
    });

    await withTempRoot('lease-wrong-root-a', async (rootA) => {
      await withTempRoot('lease-wrong-root-b', async (rootB) => {
        const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
        const resolvedB = await assertSafeDataRoot(rootB);
        await withLease(rootA, async (_resolvedA, lease) => {
          await assert.rejects(
            () => api.appendAuditIntegrityAlertDeadLetterUnderLease(
              resolvedB,
              lease,
              buildCallerEntry(),
            ),
            (error) => assertUnavailable(error, [rootA, rootB]),
          );
        });
        await assert.rejects(() => access(dlqAbs(rootA)), { code: 'ENOENT' });
        await assert.rejects(() => access(dlqAbs(rootB)), { code: 'ENOENT' });
      });
    });

    await withTempRoot('lease-expired', async (root) => {
      const { assertSafeDataRoot } = await import('../src/safe-data-files.js');
      const resolvedRoot = await assertSafeDataRoot(root);
      let expiredLease = null;
      await withLease(root, async (_resolved, lease) => {
        expiredLease = lease;
      });
      assert.notEqual(expiredLease, null);
      await assert.rejects(
        () => api.appendAuditIntegrityAlertDeadLetterUnderLease(
          resolvedRoot,
          expiredLease,
          buildCallerEntry(),
        ),
        (error) => assertUnavailable(error, [root]),
      );
      await assert.rejects(() => access(dlqAbs(root)), { code: 'ENOENT' });
    });
  });

  // ── K. Public error conventions ────────────────────────────────────────

  it('public errors are fixed path-free audit-delivery-unavailable without temp root errno or secrets', async () => {
    // Break: leaking paths/errno/raw Error would violate privacy ceiling and operator fail-closed.
    const api = requireApi();
    await withTempRoot('error-surface', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(dlqAbs(root), '{not-json\n', { mode: 0o600 });
      await assert.rejects(
        () => api.readAuditIntegrityAlertDeadLetter(root),
        (error) => {
          assertUnavailable(error, [
            root,
            dlqAbs(root),
            tmpdir(),
            'not-json',
            PRIVACY_CANARIES.endpoint,
            PRIVACY_CANARIES.token,
            PRIVACY_CANARIES.IP,
            PRIVACY_CANARIES.path,
            String(PRIVACY_CANARIES.statusCode),
          ]);
          return true;
        },
      );

      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => api.appendAuditIntegrityAlertDeadLetterUnderLease(
            resolvedRoot,
            lease,
            buildCallerEntry({ attemptCount: 9 }),
          ),
          (error) => assertUnavailable(error, [
            root,
            resolvedRoot,
            dlqAbs(root),
            'attemptCount',
          ]),
        );
      });
    });
  });

  // ── L. sourceAlert defensive copy on read ──────────────────────────────

  it('read returns sanitized defensive copies of sourceAlert without endpoint network header body IP path extras', async () => {
    // Break: retaining transport extras on inspect would store secrets in quarantine snapshots.
    const api = requireApi();
    await withTempRoot('source-alert-copy', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(dlqAbs(root), CANONICAL_ONE_ENTRY_BYTES, { mode: 0o600 });
      const snapshot = await api.readAuditIntegrityAlertDeadLetter(root);
      assert.deepEqual(Object.keys(snapshot.entries[0].sourceAlert), [...SOURCE_ALERT_KEYS]);
      assert.equal(
        Object.prototype.hasOwnProperty.call(snapshot.entries[0].sourceAlert, 'endpoint'),
        false,
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(snapshot.entries[0], 'endpoint'),
        false,
      );
      const json = JSON.stringify(snapshot);
      for (const token of [
        PRIVACY_CANARIES.endpoint,
        PRIVACY_CANARIES.token,
        PRIVACY_CANARIES.IP,
        PRIVACY_CANARIES.path,
        PRIVACY_CANARIES.rawError,
      ]) {
        assert.equal(json.includes(token), false, `snapshot must not embed ${token}`);
      }
    });
  });
});
