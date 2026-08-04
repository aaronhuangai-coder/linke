import { Buffer } from 'node:buffer';
import { ERROR_CODES, LinkeError } from './error-codes.js';
import { assertNoAuditIntegrityAlertDeliveryClaim } from './audit-integrity-alert-delivery-claim-state.js';
import {
  auditIntegrityMonitorExitCode,
  formatAuditIntegrityMonitorReportJson,
} from './audit-integrity-monitor.js';
import {
  assertAuditIntegrityWriteLease,
  enqueueAuditIntegrityWriteTask,
} from './audit-integrity-write-queue.js';
import {
  assertSafeDataRoot,
  safeAtomicWriteText,
  safeReadText,
} from './safe-data-files.js';

export const AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH =
  'audit/integrity-alert-outbox.json';
export const AUDIT_INTEGRITY_ALERT_OUTBOX_MAX_BYTES = 1024 * 1024;
export const AUDIT_INTEGRITY_ALERT_OUTBOX_MAX_ENTRIES = 256;

const STATE_KEYS = Object.freeze(['schemaVersion', 'nextSequence', 'entries']);
const ENTRY_KEYS = Object.freeze([
  'sequence',
  'checkedAt',
  'code',
  'recoveryRequired',
  'nextAction',
  'reasonCode',
]);
const CHECKED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PATH_FREE_REASON_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ROTATION_RECOVERY_REASON = 'audit-integrity-rotation-recovery-required';

function unavailableError() {
  return new LinkeError(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE);
}

function fail() {
  throw unavailableError();
}

function hasExactKeys(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  if (actual.length !== keys.length) return false;
  return keys.every((key, index) => actual[index] === key);
}

function isCanonicalCheckedAt(value) {
  if (typeof value !== 'string' || !CHECKED_AT_RE.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isPathFreeReason(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 128
    && PATH_FREE_REASON_RE.test(value);
}

function hasValidEntrySemantics(entry) {
  switch (entry.code) {
    case 'uninitialized':
      return entry.recoveryRequired === false
        && entry.nextAction === 'initialize-via-production-write'
        && entry.reasonCode === null;
    case 'state-missing':
      return entry.recoveryRequired === false
        && entry.nextAction === 'investigate-integrity'
        && entry.reasonCode === null;
    case 'recovery-required':
      return entry.recoveryRequired === true
        && entry.nextAction === 'run-explicit-recovery'
        && entry.reasonCode === null;
    case 'rotation-recovery-required':
      return entry.recoveryRequired === true
        && entry.nextAction === 'run-explicit-recovery'
        && entry.reasonCode === ROTATION_RECOVERY_REASON;
    case 'integrity-alert':
      return entry.recoveryRequired === false
        && entry.nextAction === 'investigate-integrity'
        && (entry.reasonCode === null || isPathFreeReason(entry.reasonCode));
    case 'io-alert':
      return entry.recoveryRequired === false
        && entry.nextAction === 'investigate-integrity'
        && (
          entry.reasonCode === null
          || (isPathFreeReason(entry.reasonCode) && entry.reasonCode.endsWith('-io-error'))
        );
    default:
      return false;
  }
}

function normalizeEntry(value) {
  if (!hasExactKeys(value, ENTRY_KEYS)) fail();
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) fail();
  if (!isCanonicalCheckedAt(value.checkedAt)) fail();
  const entry = {
    sequence: value.sequence,
    checkedAt: value.checkedAt,
    code: value.code,
    recoveryRequired: value.recoveryRequired,
    nextAction: value.nextAction,
    reasonCode: value.reasonCode,
  };
  if (!hasValidEntrySemantics(entry)) fail();
  return entry;
}

function serializeState(state) {
  const text = `${JSON.stringify({
    schemaVersion: 1,
    nextSequence: state.nextSequence,
    entries: state.entries,
  })}\n`;
  if (Buffer.byteLength(text, 'utf8') > AUDIT_INTEGRITY_ALERT_OUTBOX_MAX_BYTES) fail();
  return text;
}

function parseState(raw) {
  if (typeof raw !== 'string') fail();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail();
  }
  if (!hasExactKeys(parsed, STATE_KEYS)) fail();
  if (parsed.schemaVersion !== 1) fail();
  if (!Number.isSafeInteger(parsed.nextSequence) || parsed.nextSequence < 1) fail();
  if (!Array.isArray(parsed.entries)) fail();
  if (parsed.entries.length > AUDIT_INTEGRITY_ALERT_OUTBOX_MAX_ENTRIES) fail();

  const entries = parsed.entries.map(normalizeEntry);
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index].sequence !== entries[index - 1].sequence + 1) fail();
  }
  if (entries.length > 0) {
    const last = entries[entries.length - 1].sequence;
    if (!Number.isSafeInteger(last + 1) || parsed.nextSequence !== last + 1) fail();
  }
  const state = { schemaVersion: 1, nextSequence: parsed.nextSequence, entries };
  if (serializeState(state) !== raw) fail();
  return state;
}

function emptyState() {
  return { schemaVersion: 1, nextSequence: 1, entries: [] };
}

async function loadState(resolvedRoot) {
  let raw;
  try {
    raw = await safeReadText(
      resolvedRoot,
      AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH,
      { maxBytes: AUDIT_INTEGRITY_ALERT_OUTBOX_MAX_BYTES },
    );
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyState();
    fail();
  }
  return parseState(raw);
}

async function publishState(resolvedRoot, lease, state) {
  assertAuditIntegrityWriteLease(resolvedRoot, lease);
  const text = serializeState(state);
  try {
    await safeAtomicWriteText(
      resolvedRoot,
      AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH,
      text,
      { mode: 0o600 },
    );
  } catch {
    fail();
  }
}

function freezeState(state) {
  const entries = state.entries.map((entry) => Object.freeze({ ...entry }));
  return Object.freeze({
    schemaVersion: 1,
    nextSequence: state.nextSequence,
    entries: Object.freeze(entries),
  });
}

function freezeEnqueueReceipt(status, queued, sequence, pendingCount) {
  return Object.freeze({
    schemaVersion: 1,
    status,
    queued,
    sequence,
    pendingCount,
  });
}

function freezeAckReceipt(status, acknowledged, sequence, pendingCount) {
  return Object.freeze({
    schemaVersion: 1,
    status,
    acknowledged,
    sequence,
    pendingCount,
  });
}

function reduceIssuedReport(report) {
  let exitCode;
  let json;
  try {
    exitCode = auditIntegrityMonitorExitCode(report);
    json = formatAuditIntegrityMonitorReportJson(report);
  } catch {
    fail();
  }
  if (exitCode === 0) return null;
  if (exitCode !== 2) fail();

  let plain;
  try {
    plain = JSON.parse(json);
  } catch {
    fail();
  }
  return {
    checkedAt: plain.checkedAt,
    code: plain.code,
    recoveryRequired: plain.recoveryRequired,
    nextAction: plain.nextAction,
    reasonCode: plain.reasonCode,
  };
}

/**
 * Enqueue one issued alert occurrence into the bounded local outbox.
 * Healthy reports return before dataDir validation or filesystem access.
 */
export async function enqueueAuditIntegrityAlertOutbox(dataDir, report) {
  const reduced = reduceIssuedReport(report);
  if (reduced === null) {
    return freezeEnqueueReceipt('ignored-healthy', false, null, null);
  }

  let resolvedRoot;
  try {
    resolvedRoot = await assertSafeDataRoot(dataDir);
    return await enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => {
      assertAuditIntegrityWriteLease(resolvedRoot, lease);
      const state = await loadState(resolvedRoot);
      if (state.entries.length >= AUDIT_INTEGRITY_ALERT_OUTBOX_MAX_ENTRIES) fail();
      if (state.nextSequence >= Number.MAX_SAFE_INTEGER) fail();

      const entry = normalizeEntry({
        sequence: state.nextSequence,
        ...reduced,
      });
      const nextState = {
        schemaVersion: 1,
        nextSequence: state.nextSequence + 1,
        entries: [...state.entries, entry],
      };
      await publishState(resolvedRoot, lease, nextState);
      return freezeEnqueueReceipt(
        'queued',
        true,
        entry.sequence,
        nextState.entries.length,
      );
    });
  } catch {
    throw unavailableError();
  }
}

/** Read a deeply frozen defensive snapshot without repairing or writing state. */
export async function readAuditIntegrityAlertOutbox(dataDir) {
  try {
    const resolvedRoot = await assertSafeDataRoot(dataDir);
    return freezeState(await loadState(resolvedRoot));
  } catch {
    throw unavailableError();
  }
}

/**
 * Capability-guarded FIFO head acknowledgement under an active same-root lease.
 * Does not consult or mutate claim state; may run while claim remains claimed
 * (delivery completion). Must not re-enter the write queue.
 */
export async function acknowledgeAuditIntegrityAlertOutboxHeadUnderLease(
  resolvedRoot,
  lease,
  sequence,
) {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw unavailableError();
  try {
    assertAuditIntegrityWriteLease(resolvedRoot, lease);
    const state = await loadState(resolvedRoot);
    if (state.entries.length === 0) {
      return freezeAckReceipt('empty', false, null, 0);
    }
    if (state.entries[0].sequence !== sequence) fail();

    const nextState = {
      schemaVersion: 1,
      nextSequence: state.nextSequence,
      entries: state.entries.slice(1),
    };
    await publishState(resolvedRoot, lease, nextState);
    return freezeAckReceipt(
      'acknowledged',
      true,
      sequence,
      nextState.entries.length,
    );
  } catch {
    throw unavailableError();
  }
}

/**
 * Atomically remove exactly the current FIFO head occurrence.
 * Enters the same-root write queue first, refuses any persisted claimed delivery
 * claim, then delegates to the lease-guarded primitive (no nested enqueue).
 */
export async function acknowledgeAuditIntegrityAlertOutboxHead(dataDir, sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw unavailableError();
  try {
    const resolvedRoot = await assertSafeDataRoot(dataDir);
    return await enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => {
      assertAuditIntegrityWriteLease(resolvedRoot, lease);
      await assertNoAuditIntegrityAlertDeliveryClaim(resolvedRoot, lease);
      return acknowledgeAuditIntegrityAlertOutboxHeadUnderLease(
        resolvedRoot,
        lease,
        sequence,
      );
    });
  } catch {
    throw unavailableError();
  }
}
