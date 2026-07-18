/**
 * Independent capability real-audit proof sink.
 *
 * Append-only API behavior only — not immutable/WORM/tamper-proof, not HTTP audit,
 * not the generic events journal, not retention/compaction/rotation.
 *
 * Sole queue SoT: per-resolved-root serialization lives ONLY in this module
 * (`capabilityAuditSinkQueues`). Lifecycle/invoke MUST NOT maintain a second queue.
 *
 * Writes only to CAPABILITY_REAL_AUDIT_RELATIVE_PATH via safe-data-files.
 * Never imports/calls the generic HTTP audit append helper.
 */

import {
  SafeDataFileError,
  assertSafeDataRoot,
  safeAppendText,
  safeReadText,
} from './safe-data-files.js';
import {
  isSupervisorLifecycleActionForOperation,
  isSupervisorLifecycleOperation,
} from './supervisor-lifecycle-actions.js';

/** Fixed relative path for capability real-audit proof attempts (not the generic events journal). */
export const CAPABILITY_REAL_AUDIT_RELATIVE_PATH = 'audit/capability-proof-attempts.jsonl';

/**
 * Max pre-read UTF-8 file-size bytes for existing-file validation
 * (`safeReadText` / file `stat.size`, not JS `string.length`).
 *
 * 1.5 MiB = 1536 * 1024 = 1_572_864. Formal contract correction: 1 MiB cannot hold
 * 4096 full canonical SoT lines. Accepted operation/actionId are exact enums from
 * SUPERVISOR_LIFECYCLE_OPERATION_ACTION_IDS (unknown/cross-op/overlong fail-closed);
 * current max canonical UTF-8 JSONL line is 328 bytes; 328 * 4097 < 1_572_864, so
 * existing 4096 can append 4097 and the next preflight can fully re-read 4097 then
 * reject by line count. Oversize still fail-closes; 4096 is not retention.
 */
export const CAPABILITY_REAL_AUDIT_MAX_PRE_READ_BYTES = 1_572_864;

/**
 * Max existing event lines accepted during preflight validation bound ONLY.
 * Not retention/cap: existing exactly 4096 valid lines may append a 4097th;
 * next preflight with existing 4097 rejects. No delete/compaction/rotation.
 */
export const CAPABILITY_REAL_AUDIT_MAX_EVENT_LINES = 4096;

/** Path-free code: pre-append validation/read/root/incoming fail. */
export const CAPABILITY_REAL_AUDIT_SINK_INVALID = 'capability-real-audit-sink-invalid';

/** Path-free code: safeAppendText mutating call already invoked then failed. */
export const CAPABILITY_REAL_AUDIT_PERSIST_FAILED = 'capability-real-audit-persist-failed';

const HASH_RE = /^[0-9a-f]{64}$/;

const CANONICAL_KEYS = Object.freeze([
  'schemaVersion',
  'eventKind',
  'eventFingerprint',
  'operation',
  'actionId',
  'attemptRefFingerprint',
  'proofMode',
]);

/**
 * Path-free fail-closed error for the capability real-audit sink.
 * Never embeds path, system message, or stack details in public fields.
 * Stage contract:
 * - pre-append fail → code sink-invalid, writeAttempted:false
 * - after safeAppendText invoke → code persist-failed, writeAttempted:true
 */
export class CapabilityRealAuditSinkError extends Error {
  /**
   * @param {string} code
   * @param {{ writeAttempted: boolean }} options
   */
  constructor(code, { writeAttempted }) {
    super(code);
    this.name = 'CapabilityRealAuditSinkError';
    this.code = code;
    this.writeAttempted = Boolean(writeAttempted);
  }
}

/**
 * Sole per-resolved-root queue Map (module-private).
 * key = assertSafeDataRoot return value; value = tail Promise for cleanup identity.
 * @type {Map<string, Promise<unknown>>}
 */
const capabilityAuditSinkQueues = new Map();

/**
 * @param {string} code
 * @param {boolean} writeAttempted
 * @returns {never}
 */
function throwSinkError(code, writeAttempted) {
  throw new CapabilityRealAuditSinkError(code, { writeAttempted });
}

/**
 * @param {string} resolvedRoot
 * @param {() => Promise<void>} task
 * @returns {Promise<void>}
 */
function enqueueCapabilityAuditSinkTask(resolvedRoot, task) {
  const previous = capabilityAuditSinkQueues.get(resolvedRoot) || Promise.resolve();
  // Rejection must not poison subsequent tasks on this root.
  const run = previous.catch(() => {}).then(task);
  const cleanup = run.finally(() => {
    if (capabilityAuditSinkQueues.get(resolvedRoot) === cleanup) {
      capabilityAuditSinkQueues.delete(resolvedRoot);
    }
  });
  // Avoid unhandled rejection when callers only await `run`.
  cleanup.catch(() => {});
  capabilityAuditSinkQueues.set(resolvedRoot, cleanup);
  return run;
}

/**
 * Plain object: Object.prototype or null prototype; not array/function/other.
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainRecord(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Exact own enumerable string data properties only (no symbols/getters/setters).
 * Preserves own-key order from Reflect.ownKeys.
 * @param {object} record
 * @returns {Record<string, unknown> | null}
 */
function readOwnStringDataFields(record) {
  const ownKeys = Reflect.ownKeys(record);
  /** @type {Record<string, unknown>} */
  const out = Object.create(null);
  /** @type {string[]} */
  const order = [];
  for (const key of ownKeys) {
    if (typeof key === 'symbol') return null;
    const desc = Object.getOwnPropertyDescriptor(record, key);
    if (!desc || desc.enumerable !== true) return null;
    if (desc.get !== undefined || desc.set !== undefined) return null;
    if (typeof desc.value === 'function') return null;
    out[key] = desc.value;
    order.push(key);
  }
  // Attach order for callers that need key-order checks without re-enumerating.
  Object.defineProperty(out, '__keyOrder', {
    value: order,
    enumerable: false,
    configurable: true,
  });
  return out;
}

/**
 * Serialize a validated event with exact fixed key order.
 * @param {{
 *   schemaVersion: number,
 *   eventKind: string,
 *   eventFingerprint: string,
 *   operation: string,
 *   actionId: string,
 *   attemptRefFingerprint: string,
 *   proofMode: string,
 * }} fields
 * @returns {string}
 */
function stringifyCanonical(fields) {
  return JSON.stringify({
    schemaVersion: fields.schemaVersion,
    eventKind: fields.eventKind,
    eventFingerprint: fields.eventFingerprint,
    operation: fields.operation,
    actionId: fields.actionId,
    attemptRefFingerprint: fields.attemptRefFingerprint,
    proofMode: fields.proofMode,
  });
}

/**
 * Validate canonical event fields (types/enums/hash/SoT). Does not check key order.
 * @param {Record<string, unknown>} fields
 * @returns {boolean}
 */
function validateFieldValues(fields) {
  if (fields.schemaVersion !== 1) return false;
  if (fields.eventKind !== 'capability-real-audit-proof') return false;
  if (fields.proofMode !== 'real-proof') return false;
  if (typeof fields.eventFingerprint !== 'string' || !HASH_RE.test(fields.eventFingerprint)) {
    return false;
  }
  if (
    typeof fields.attemptRefFingerprint !== 'string'
    || !HASH_RE.test(fields.attemptRefFingerprint)
  ) {
    return false;
  }
  if (!isSupervisorLifecycleOperation(fields.operation)) return false;
  if (!isSupervisorLifecycleActionForOperation(fields.operation, fields.actionId)) {
    return false;
  }
  return true;
}

/**
 * Exact structural + value validation for a plain event object.
 * @param {unknown} event
 * @param {{ requireKeyOrder: boolean, originalLine?: string }} options
 * @returns {{
 *   schemaVersion: number,
 *   eventKind: string,
 *   eventFingerprint: string,
 *   operation: string,
 *   actionId: string,
 *   attemptRefFingerprint: string,
 *   proofMode: string,
 * }}
 */
function validateCanonicalEvent(event, options) {
  if (!isPlainRecord(event)) {
    throwSinkError(CAPABILITY_REAL_AUDIT_SINK_INVALID, false);
  }
  const fields = readOwnStringDataFields(/** @type {object} */ (event));
  if (fields === null) {
    throwSinkError(CAPABILITY_REAL_AUDIT_SINK_INVALID, false);
  }
  /** @type {string[]} */
  const keyOrder = /** @type {string[]} */ (
    /** @type {{ __keyOrder?: string[] }} */ (fields).__keyOrder || []
  );
  if (keyOrder.length !== CANONICAL_KEYS.length) {
    throwSinkError(CAPABILITY_REAL_AUDIT_SINK_INVALID, false);
  }
  for (let i = 0; i < CANONICAL_KEYS.length; i += 1) {
    if (!Object.hasOwn(fields, CANONICAL_KEYS[i])) {
      throwSinkError(CAPABILITY_REAL_AUDIT_SINK_INVALID, false);
    }
  }
  // Reject any extra own string keys.
  for (const key of keyOrder) {
    if (!CANONICAL_KEYS.includes(key)) {
      throwSinkError(CAPABILITY_REAL_AUDIT_SINK_INVALID, false);
    }
  }
  if (options.requireKeyOrder) {
    for (let i = 0; i < CANONICAL_KEYS.length; i += 1) {
      if (keyOrder[i] !== CANONICAL_KEYS[i]) {
        throwSinkError(CAPABILITY_REAL_AUDIT_SINK_INVALID, false);
      }
    }
  }
  if (!validateFieldValues(fields)) {
    throwSinkError(CAPABILITY_REAL_AUDIT_SINK_INVALID, false);
  }

  const canonical = {
    schemaVersion: /** @type {number} */ (fields.schemaVersion),
    eventKind: /** @type {string} */ (fields.eventKind),
    eventFingerprint: /** @type {string} */ (fields.eventFingerprint),
    operation: /** @type {string} */ (fields.operation),
    actionId: /** @type {string} */ (fields.actionId),
    attemptRefFingerprint: /** @type {string} */ (fields.attemptRefFingerprint),
    proofMode: /** @type {string} */ (fields.proofMode),
  };

  // Existing lines: fixed-order stringify must be byte-equal to original line.
  if (typeof options.originalLine === 'string') {
    if (stringifyCanonical(canonical) !== options.originalLine) {
      throwSinkError(CAPABILITY_REAL_AUDIT_SINK_INVALID, false);
    }
  }

  return canonical;
}

/**
 * Existing-file JSONL preflight (design §8.2).
 * @param {string} raw
 */
function validateExistingRaw(raw) {
  if (raw.length === 0) return; // empty allow
  if (!raw.endsWith('\n')) {
    throwSinkError(CAPABILITY_REAL_AUDIT_SINK_INVALID, false);
  }
  const body = raw.slice(0, -1);
  const lines = body === '' ? [] : body.split('\n');
  if (lines.some((line) => line.length === 0)) {
    throwSinkError(CAPABILITY_REAL_AUDIT_SINK_INVALID, false);
  }
  if (lines.length > CAPABILITY_REAL_AUDIT_MAX_EVENT_LINES) {
    throwSinkError(CAPABILITY_REAL_AUDIT_SINK_INVALID, false);
  }
  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throwSinkError(CAPABILITY_REAL_AUDIT_SINK_INVALID, false);
    }
    // Existing: requireKeyOrder enforced via byte-equal re-stringify.
    validateCanonicalEvent(parsed, {
      requireKeyOrder: true,
      originalLine: line,
    });
  }
}

/**
 * One queue-task body: read → validate existing → validate incoming → append.
 * @param {string} resolvedRoot
 * @param {unknown} event
 */
async function appendCapabilityRealAuditProofEventInQueue(resolvedRoot, event) {
  let raw = null;
  try {
    raw = await safeReadText(resolvedRoot, CAPABILITY_REAL_AUDIT_RELATIVE_PATH, {
      maxBytes: CAPABILITY_REAL_AUDIT_MAX_PRE_READ_BYTES,
    });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      raw = null; // missing allow
    } else if (error instanceof CapabilityRealAuditSinkError) {
      throw error;
    } else if (error instanceof SafeDataFileError) {
      // Pre-append read/path/size fail (including over maxBytes).
      throwSinkError(CAPABILITY_REAL_AUDIT_SINK_INVALID, false);
    } else {
      throwSinkError(CAPABILITY_REAL_AUDIT_SINK_INVALID, false);
    }
  }

  try {
    if (raw !== null) {
      validateExistingRaw(raw);
    }
    // Incoming: same-level structural/type/enum/hash/op-action/key-order (§8.5).
    // No preimage recompute from raw attemptRef.
    const canonical = validateCanonicalEvent(event, { requireKeyOrder: true });
    const line = `${stringifyCanonical(canonical)}\n`;

    try {
      // Mutating call boundary: once invoked, failures map to persist-failed.
      await safeAppendText(resolvedRoot, CAPABILITY_REAL_AUDIT_RELATIVE_PATH, line);
    } catch (error) {
      if (error instanceof CapabilityRealAuditSinkError) throw error;
      throwSinkError(CAPABILITY_REAL_AUDIT_PERSIST_FAILED, true);
    }
  } catch (error) {
    if (error instanceof CapabilityRealAuditSinkError) throw error;
    throwSinkError(CAPABILITY_REAL_AUDIT_SINK_INVALID, false);
  }
}

/**
 * Append one canonical event under resolved data root.
 *
 * @internal append-only API behavior only — not immutable/WORM/tamper-proof.
 * Sole queue SoT: per-resolved-root serialization lives ONLY here.
 * Does not touch the generic events journal; does not call the generic HTTP audit append helper.
 *
 * @param {string} resolvedDataRoot
 *   invoke 对 exact context 做 assertSafeDataRoot 后返回的 root；
 *   该 assert 在 fingerprint / inFlightSet / sink call 前完成。
 *   sink 仍通过 safeReadText/safeAppendText 重新执行安全 root/path
 *   traversal/no-symlink 检查，不把 caller string 当安全证明。
 * @param {object} event canonical 7-key plain object
 * @returns {Promise<void>} success settle; throw path-free on fail
 *   error stage must align receipt truth:
 *   pre-append fail (existing/incoming/over-bound) → sink-invalid / writeAttempted:false
 *   post mutating-call throw → persist-failed / writeAttempted:true
 */
export async function appendCapabilityRealAuditProofEvent(resolvedDataRoot, event) {
  let resolvedRoot;
  try {
    resolvedRoot = await assertSafeDataRoot(resolvedDataRoot);
  } catch (error) {
    if (error instanceof CapabilityRealAuditSinkError) throw error;
    // SafeDataFileError or any root validation failure — pre-append, not attempted.
    throwSinkError(CAPABILITY_REAL_AUDIT_SINK_INVALID, false);
  }

  return enqueueCapabilityAuditSinkTask(resolvedRoot, () => (
    appendCapabilityRealAuditProofEventInQueue(resolvedRoot, event)
  ));
}
