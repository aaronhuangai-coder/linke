/**
 * Linke V1.43 secure audit rotation coordinator.
 *
 * Task 4: archive commit + atomic live cutover + phase recovery + completed
 * fact verification and exact frozen receipts (rotated / already-completed).
 *
 * Explicit/manual foundation only. Not Gold/GA; not scheduled rotation;
 * archive append-only is product policy, not WORM.
 *
 * Signature ceiling (only allowed claim for this stage):
 *   explicit crash-recoverable audit integrity rotation cutover foundation
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import {
  assertSafeDataRoot,
  safeAtomicWriteBytes,
  safeAtomicWriteText,
  safeCreateExclusiveText,
  safeReadBytes,
  safeReadText,
} from './safe-data-files.js';
import { ERROR_CODES } from './error-codes.js';
import {
  enqueueAuditIntegrityWriteTask,
} from './audit-integrity-write-queue.js';
import {
  inspectAuditIntegrityDualWriteReadOnly,
  validateAuditIntegrityDualWriteIdleUnlocked,
} from './audit-integrity-dual-write.js';
import {
  loadDualWriteStateUnlocked,
  publishDualWriteStateUnlocked,
} from './audit-integrity-dual-write-state.js';
import {
  AuditIntegrityRotationError,
  AUDIT_INTEGRITY_ARCHIVE_MANIFEST_MAX_BYTES,
  AUDIT_INTEGRITY_ROTATION_STATE_MAX_BYTES,
  AUDIT_INTEGRITY_ROTATION_STATE_RELATIVE_PATH,
  buildAuditIntegrityArchiveManifest,
  loadAuditIntegrityRotationStateUnlocked,
  parseAuditIntegrityArchiveManifestText,
  parseAuditIntegrityRotationStateText,
  publishAuditIntegrityRotationStateUnlocked,
} from './audit-integrity-rotation-state.js';
import {
  AUDIT_INTEGRITY_JOURNAL_RELATIVE_PATH,
  AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES,
  buildAuditIntegrityV2GenerationImage,
  verifyAuditIntegrityJournalText,
} from './audit-integrity-journal.js';
import {
  AUDIT_CROSS_STORE_EVENTS_RELATIVE_PATH,
  AUDIT_CROSS_STORE_EVENTS_MAX_PRE_READ_BYTES,
  AUDIT_CROSS_STORE_MAX_EVENT_LINE_BYTES,
  AUDIT_CROSS_STORE_MAX_EVENT_LINES,
  verifyAuditIntegrityAgainstEventStore,
} from './audit-integrity-cross-store.js';
import {
  computeAuditIntegrityEventPayloadDigest,
  parseStrictCanonicalAuditEventLinesText,
  StrictCanonicalAuditEventLinesParseError,
} from './audit-event-schema.js';

/**
 * TEST ONLY crash-injection key. Not a production options field.
 * Values:
 *   'after-prepared' | 'after-archive-journal' | 'after-archive-events' |
 *   'after-manifest' | 'after-new-journal' | 'after-events-post' | 'after-new-idle'
 * Per-call only; no module-global force/bypass setter.
 */
export const AUDIT_INTEGRITY_ROTATION_TEST_CRASH_HOOK = Symbol(
  'linke.audit-integrity-rotation.test-crash',
);

const GENERATION_ID_RE = /^[0-9a-f]{32}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const EMPTY_FILE_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const PUBLIC_OPTION_KEYS = Object.freeze([
  'expectedGenerationId',
  'expectedHeadDigest',
]);

const CRASH_HOOK_VALUES = new Set([
  'after-prepared',
  'after-archive-journal',
  'after-archive-events',
  'after-manifest',
  'after-new-journal',
  'after-events-post',
  'after-new-idle',
]);

const NONTERMINAL_STATUSES = new Set([
  'prepared',
  'archive-committed',
  'journal-published',
  'events-published',
]);

const PHASE_RANK = Object.freeze({
  prepared: 0,
  'archive-committed': 1,
  'journal-published': 2,
  'events-published': 3,
  completed: 4,
});

const ROTATION_EVENT_TYPE = 'audit-integrity-rotation';
const ROTATION_EVENT_OUTCOME = 'committed';
const ROTATION_EVENT_OPERATION = 'generation-transition';
const ROTATION_EVENT_MESSAGE =
  'audit integrity generation rotation committed';
const MANIFEST_RECORD_KIND = 'audit-integrity-rotation-manifest';

/**
 * @param {string} code
 * @returns {never}
 */
function throwRotation(code) {
  throw new AuditIntegrityRotationError(code);
}

/** @returns {never} */
function throwPrecondition() {
  throwRotation(ERROR_CODES.AUDIT_INTEGRITY_ROTATION_PRECONDITION_FAILED);
}

/** @returns {never} */
function throwRecoveryRequired() {
  throwRotation(ERROR_CODES.AUDIT_INTEGRITY_ROTATION_RECOVERY_REQUIRED);
}

/** @returns {never} */
function throwConflict() {
  throwRotation(ERROR_CODES.AUDIT_INTEGRITY_ROTATION_CONFLICT);
}

/** @returns {never} */
function throwBounds() {
  throwRotation(ERROR_CODES.AUDIT_INTEGRITY_ROTATION_BOUNDS_EXCEEDED);
}

/** @returns {never} */
function throwIo() {
  throwRotation(ERROR_CODES.AUDIT_INTEGRITY_ROTATION_IO_ERROR);
}

/** @returns {never} */
function throwStateInvalid() {
  throwRotation(ERROR_CODES.AUDIT_INTEGRITY_ROTATION_STATE_INVALID);
}

/**
 * Fixed path-free test-only crash error (not a registered production code).
 * @param {string} code
 * @returns {never}
 */
function throwTestCrash(code) {
  const err = new Error(code);
  /** @type {{ code?: string }} */ (err).code = code;
  throw err;
}

/**
 * @param {string | Buffer} value
 * @returns {string}
 */
function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isEnoent(err) {
  return Boolean(
    err
    && typeof err === 'object'
    && /** @type {{ code?: unknown }} */ (err).code === 'ENOENT',
  );
}

/**
 * @param {string} status
 * @returns {number}
 */
function phaseRank(status) {
  const rank = PHASE_RANK[/** @type {keyof typeof PHASE_RANK} */ (status)];
  return rank === undefined ? -1 : rank;
}

/**
 * Synchronous hostile-options snapshot before any await / root I/O.
 * @param {unknown} options
 * @returns {{
 *   expectedGenerationId: string,
 *   expectedHeadDigest: string,
 *   crashHook: string|undefined,
 * }}
 */
function snapshotRotateOptions(options) {
  if (options === null || typeof options !== 'object') {
    throwPrecondition();
  }
  if (utilTypes.isProxy(options)) throwPrecondition();
  if (Array.isArray(options)) throwPrecondition();
  if (typeof options === 'function') throwPrecondition();
  const proto = Object.getPrototypeOf(options);
  if (proto !== Object.prototype && proto !== null) throwPrecondition();

  const ownKeys = Reflect.ownKeys(options);
  /** @type {string[]} */
  const stringKeys = [];
  /** @type {unknown} */
  let crashHook;

  for (const key of ownKeys) {
    if (typeof key === 'symbol') {
      if (key !== AUDIT_INTEGRITY_ROTATION_TEST_CRASH_HOOK) throwPrecondition();
      const desc = Object.getOwnPropertyDescriptor(options, key);
      if (!desc) throwPrecondition();
      if (!desc.enumerable) throwPrecondition();
      if (desc.get !== undefined || desc.set !== undefined) throwPrecondition();
      if (!Object.prototype.hasOwnProperty.call(desc, 'value')) throwPrecondition();
      crashHook = desc.value;
      continue;
    }
    if (typeof key !== 'string') throwPrecondition();
    const desc = Object.getOwnPropertyDescriptor(options, key);
    if (!desc) throwPrecondition();
    if (!desc.enumerable) throwPrecondition();
    if (desc.get !== undefined || desc.set !== undefined) throwPrecondition();
    if (!Object.prototype.hasOwnProperty.call(desc, 'value')) throwPrecondition();
    stringKeys.push(key);
  }

  if (stringKeys.length !== PUBLIC_OPTION_KEYS.length) throwPrecondition();
  for (let i = 0; i < PUBLIC_OPTION_KEYS.length; i += 1) {
    if (stringKeys[i] !== PUBLIC_OPTION_KEYS[i]) throwPrecondition();
  }

  const expectedGenerationId =
    /** @type {{ expectedGenerationId?: unknown }} */ (options).expectedGenerationId;
  const expectedHeadDigest =
    /** @type {{ expectedHeadDigest?: unknown }} */ (options).expectedHeadDigest;

  if (
    typeof expectedGenerationId !== 'string'
    || !GENERATION_ID_RE.test(expectedGenerationId)
  ) {
    throwPrecondition();
  }
  if (typeof expectedHeadDigest !== 'string' || !HEX64_RE.test(expectedHeadDigest)) {
    throwPrecondition();
  }
  if (crashHook !== undefined) {
    if (typeof crashHook !== 'string' || !CRASH_HOOK_VALUES.has(crashHook)) {
      throwPrecondition();
    }
  }

  return Object.freeze({
    expectedGenerationId,
    expectedHeadDigest,
    crashHook: crashHook === undefined ? undefined : crashHook,
  });
}

/**
 * @returns {{
 *   event: {
 *     id: string,
 *     createdAt: string,
 *     type: string,
 *     outcome: string,
 *     operation: string,
 *     message: string,
 *   },
 *   eventLineUtf8: string,
 *   payloadDigest: string,
 * }}
 */
function buildFixedRotationEvent() {
  const id = randomUUID().toLowerCase();
  const createdAt = new Date().toISOString();
  const event = {
    id,
    createdAt,
    type: ROTATION_EVENT_TYPE,
    outcome: ROTATION_EVENT_OUTCOME,
    operation: ROTATION_EVENT_OPERATION,
    message: ROTATION_EVENT_MESSAGE,
  };
  const eventLineUtf8 = `${JSON.stringify(event)}\n`;
  const payloadDigest = computeAuditIntegrityEventPayloadDigest(event);
  return { event, eventLineUtf8, payloadDigest };
}

/**
 * @param {string} previousGenerationId
 * @returns {string}
 */
function newNextGenerationId(previousGenerationId) {
  let next;
  do {
    next = randomBytes(16).toString('hex');
  } while (next === previousGenerationId);
  return next;
}

/**
 * Build canonical rotation WAL plain object (exact key order for all phases).
 * @param {object} p
 * @returns {object}
 */
function buildRotationWalObject(p) {
  return {
    schemaVersion: 1,
    status: p.status,
    rotationId: p.rotationId,
    createdAt: p.createdAt,
    previousGenerationId: p.previousGenerationId,
    previousHeadDigest: p.previousHeadDigest,
    nextGenerationId: p.nextGenerationId,
    archiveRelativePath: p.archiveRelativePath,
    archiveManifestDigest: p.archiveManifestDigest,
    rotationEvent: {
      event: {
        id: p.rotationEvent.event.id,
        createdAt: p.rotationEvent.event.createdAt,
        type: p.rotationEvent.event.type,
        outcome: p.rotationEvent.event.outcome,
        operation: p.rotationEvent.event.operation,
        message: p.rotationEvent.event.message,
      },
      eventLineUtf8: p.rotationEvent.eventLineUtf8,
      payloadDigest: p.rotationEvent.payloadDigest,
    },
    journal: {
      previous: {
        schemaVersion: p.journalPrevious.schemaVersion,
        recordCount: p.journalPrevious.recordCount,
        headDigest: p.journalPrevious.headDigest,
        rawByteLength: p.journalPrevious.rawByteLength,
        rawSha256: p.journalPrevious.rawSha256,
      },
      next: {
        schemaVersion: p.journalNext.schemaVersion,
        recordCount: p.journalNext.recordCount,
        headDigest: p.journalNext.headDigest,
        rawByteLength: p.journalNext.rawByteLength,
        rawSha256: p.journalNext.rawSha256,
      },
    },
    events: {
      sealed: {
        present: p.eventsSealed.present,
        strictRecordCount: p.eventsSealed.strictRecordCount,
        rawByteLength: p.eventsSealed.rawByteLength,
        rawSha256: p.eventsSealed.rawSha256,
      },
      post: {
        present: p.eventsPost.present,
        strictRecordCount: p.eventsPost.strictRecordCount,
        rawByteLength: p.eventsPost.rawByteLength,
        rawSha256: p.eventsPost.rawSha256,
      },
    },
  };
}

/**
 * @param {object} wal
 * @param {string} status
 * @returns {object}
 */
function walBuildParams(wal, status) {
  return {
    status,
    rotationId: wal.rotationId,
    createdAt: wal.createdAt,
    previousGenerationId: wal.previousGenerationId,
    previousHeadDigest: wal.previousHeadDigest,
    nextGenerationId: wal.nextGenerationId,
    archiveRelativePath: wal.archiveRelativePath,
    archiveManifestDigest: wal.archiveManifestDigest,
    rotationEvent: wal.rotationEvent,
    journalPrevious: wal.journal.previous,
    journalNext: wal.journal.next,
    eventsSealed: wal.events.sealed,
    eventsPost: wal.events.post,
  };
}

/**
 * Forward-only WAL phase publication. Never moves status backward.
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {object} wal
 * @param {string} status
 * @returns {Promise<object>}
 */
async function advanceWalStatus(resolvedRoot, lease, wal, status) {
  if (wal.status === status) return wal;
  if (phaseRank(wal.status) >= phaseRank(status)) return wal;
  const next = buildRotationWalObject(walBuildParams(wal, status));
  return publishAuditIntegrityRotationStateUnlocked(resolvedRoot, lease, next);
}

/**
 * @param {object} wal
 * @returns {{
 *   journalRel: string,
 *   eventsRel: string,
 *   manifestRel: string,
 * }}
 */
function archiveRels(wal) {
  const base = wal.archiveRelativePath;
  return {
    journalRel: `${base}/integrity-journal.jsonl`,
    eventsRel: `${base}/events.jsonl`,
    manifestRel: `${base}/manifest.json`,
  };
}

/**
 * Fresh bounded exact archive-leaf verification.
 * Missing/unreadable/non-regular/symlink/oversize/length/digest/raw mismatch
 * → path-free ROTATION_CONFLICT. Never mutates the leaf.
 *
 * @param {string} resolvedRoot
 * @param {string} relativePath
 * @param {string} raw
 * @param {{ rawByteLength: number, rawSha256: string }} fp
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Promise<string>} actual raw text
 */
async function verifyArchiveExactText(resolvedRoot, relativePath, raw, fp, opts = {}) {
  const maxBytes = opts.maxBytes !== undefined
    ? opts.maxBytes
    : fp.rawByteLength + 1;
  let actual;
  try {
    actual = await safeReadText(resolvedRoot, relativePath, { maxBytes });
  } catch {
    throwConflict();
  }
  if (Buffer.byteLength(actual, 'utf8') !== fp.rawByteLength) throwConflict();
  if (sha256Hex(actual) !== fp.rawSha256) throwConflict();
  if (actual !== raw) throwConflict();
  return actual;
}

/**
 * Exclusive-create archive leaf or verify exact existing content.
 * Never overwrites/deletes/renames. Occupied mismatch/non-regular → CONFLICT.
 *
 * @param {string} resolvedRoot
 * @param {string} relativePath
 * @param {string} raw
 * @param {{ rawByteLength: number, rawSha256: string }} fp
 * @param {{ maxBytes?: number }} [opts]
 */
async function createOrVerifyArchiveText(resolvedRoot, relativePath, raw, fp, opts = {}) {
  try {
    await safeCreateExclusiveText(
      resolvedRoot,
      relativePath,
      raw,
      { mode: 0o600 },
    );
  } catch (error) {
    if (error instanceof AuditIntegrityRotationError) throw error;
    throwIo();
  }

  await verifyArchiveExactText(resolvedRoot, relativePath, raw, fp, opts);
}

/**
 * Rebuild deterministic v2 journal image from WAL; conflict if fingerprints diverge.
 * @param {object} wal
 * @returns {ReturnType<typeof buildAuditIntegrityV2GenerationImage>}
 */
function rebuildV2FromWal(wal) {
  let v2Image;
  try {
    v2Image = buildAuditIntegrityV2GenerationImage({
      generationId: wal.nextGenerationId,
      previousGenerationId: wal.previousGenerationId,
      previousHeadDigest: wal.previousHeadDigest,
      archiveManifestDigest: wal.archiveManifestDigest,
      rotationEvent: {
        id: wal.rotationEvent.event.id,
        createdAt: wal.rotationEvent.event.createdAt,
        type: wal.rotationEvent.event.type,
        outcome: wal.rotationEvent.event.outcome,
        operation: wal.rotationEvent.event.operation,
        message: wal.rotationEvent.event.message,
      },
    });
  } catch {
    throwConflict();
  }
  if (
    v2Image.rawByteLength !== wal.journal.next.rawByteLength
    || v2Image.rawSha256 !== wal.journal.next.rawSha256
    || v2Image.headDigest !== wal.journal.next.headDigest
    || v2Image.recordCount !== wal.journal.next.recordCount
  ) {
    throwConflict();
  }
  return v2Image;
}

/**
 * Rebuild canonical manifest expected by WAL fingerprints.
 * @param {object} wal
 */
function rebuildManifestFromWal(wal) {
  const sealed = wal.events.sealed;
  let built;
  try {
    built = buildAuditIntegrityArchiveManifest({
      schemaVersion: 1,
      recordKind: MANIFEST_RECORD_KIND,
      rotationId: wal.rotationId,
      createdAt: wal.createdAt,
      previousGenerationId: wal.previousGenerationId,
      previousJournalSchemaVersion: wal.journal.previous.schemaVersion,
      previousHeadDigest: wal.previousHeadDigest,
      journal: {
        rawByteLength: wal.journal.previous.rawByteLength,
        rawSha256: wal.journal.previous.rawSha256,
        recordCount: wal.journal.previous.recordCount,
      },
      events: {
        present: sealed.present,
        rawByteLength: sealed.rawByteLength,
        rawSha256: sealed.rawSha256,
        strictRecordCount: sealed.strictRecordCount,
      },
      nextGenerationId: wal.nextGenerationId,
      rotationEventId: wal.rotationId,
      rotationEventPayloadDigest: wal.rotationEvent.payloadDigest,
    });
  } catch {
    throwConflict();
  }
  if (built.digest !== wal.archiveManifestDigest) throwConflict();
  return built;
}

/**
 * Try to load and fully re-verify the immutable archive bundle as authority.
 * Returns null when the full verified bundle is not present (pre-commit).
 * Throws CONFLICT when a leaf is occupied but does not match authority facts
 * after commit-or-later phases (caller decides); for soft probe use soft=true.
 *
 * @param {string} resolvedRoot
 * @param {object} wal
 * @param {{ require?: boolean }} [opts]
 * @returns {Promise<null | {
 *   journalRaw: string,
 *   eventsRaw: string,
 *   manifestRaw: string,
 * }>}
 */
async function loadVerifiedArchiveBundle(resolvedRoot, wal, opts = {}) {
  const requireBundle = opts.require === true;
  const { journalRel, eventsRel, manifestRel } = archiveRels(wal);
  const prev = wal.journal.previous;
  const sealed = wal.events.sealed;
  const builtManifest = rebuildManifestFromWal(wal);

  /** @type {string} */
  let journalRaw;
  try {
    journalRaw = await safeReadText(resolvedRoot, journalRel, {
      maxBytes: Math.max(prev.rawByteLength + 1, 1),
    });
  } catch {
    if (requireBundle) throwConflict();
    return null;
  }
  if (
    Buffer.byteLength(journalRaw, 'utf8') !== prev.rawByteLength
    || sha256Hex(journalRaw) !== prev.rawSha256
  ) {
    throwConflict();
  }

  /** @type {string} */
  let eventsRaw;
  try {
    eventsRaw = await safeReadText(resolvedRoot, eventsRel, {
      maxBytes: Math.max(sealed.rawByteLength + 1, 1),
    });
  } catch {
    if (requireBundle) throwConflict();
    return null;
  }
  if (
    Buffer.byteLength(eventsRaw, 'utf8') !== sealed.rawByteLength
    || sha256Hex(eventsRaw) !== sealed.rawSha256
  ) {
    throwConflict();
  }

  /** @type {string} */
  let manifestRaw;
  try {
    manifestRaw = await safeReadText(resolvedRoot, manifestRel, {
      maxBytes: AUDIT_INTEGRITY_ARCHIVE_MANIFEST_MAX_BYTES,
    });
  } catch {
    if (requireBundle) throwConflict();
    return null;
  }
  if (sha256Hex(manifestRaw) !== wal.archiveManifestDigest) throwConflict();
  if (manifestRaw !== builtManifest.rawText) throwConflict();
  try {
    parseAuditIntegrityArchiveManifestText(manifestRaw);
  } catch {
    throwConflict();
  }

  return { journalRaw, eventsRaw, manifestRaw };
}

/**
 * Classify live journal text against WAL previous/next byte fingerprints.
 * Fingerprint before structural parse.
 * @param {string} liveRaw
 * @param {object} wal
 * @returns {'pre'|'post'|'other'}
 */
function classifyJournalRaw(liveRaw, wal) {
  const len = Buffer.byteLength(liveRaw, 'utf8');
  const sha = sha256Hex(liveRaw);
  const prev = wal.journal.previous;
  const next = wal.journal.next;
  if (len === prev.rawByteLength && sha === prev.rawSha256) return 'pre';
  if (len === next.rawByteLength && sha === next.rawSha256) return 'post';
  return 'other';
}

/**
 * @param {Buffer} bytes
 * @param {{ rawByteLength: number, rawSha256: string }} fp
 * @returns {boolean}
 */
function bytesMatchFp(bytes, fp) {
  return bytes.length === fp.rawByteLength && sha256Hex(bytes) === fp.rawSha256;
}

/**
 * Classify live events against sealed pre / post fingerprints.
 * @param {{ present: boolean, bytes: Buffer }} probe
 * @param {object} wal
 * @returns {'pre'|'post'|'other'}
 */
function classifyEventsProbe(probe, wal) {
  const sealed = wal.events.sealed;
  const post = wal.events.post;
  if (probe.present && bytesMatchFp(probe.bytes, post)) return 'post';
  if (sealed.present) {
    if (probe.present && bytesMatchFp(probe.bytes, sealed)) return 'pre';
    return 'other';
  }
  // Sealed absent: pre is exact ENOENT only (not present-empty).
  if (!probe.present) return 'pre';
  return 'other';
}

/**
 * @param {string} resolvedRoot
 * @returns {Promise<{ present: boolean, bytes: Buffer }>}
 */
async function readLiveEventsProbe(resolvedRoot) {
  try {
    const bytes = await safeReadBytes(
      resolvedRoot,
      AUDIT_CROSS_STORE_EVENTS_RELATIVE_PATH,
      { maxBytes: AUDIT_CROSS_STORE_EVENTS_MAX_PRE_READ_BYTES },
    );
    return { present: true, bytes };
  } catch (error) {
    if (isEnoent(error)) {
      return { present: false, bytes: Buffer.alloc(0) };
    }
    if (error instanceof AuditIntegrityRotationError) throw error;
    throwConflict();
  }
}

/**
 * Deterministic events post image from archived sealed raw + rotation line.
 * @param {string} sealedEventsRaw
 * @param {object} wal
 * @returns {Buffer}
 */
function buildEventsPostBytes(sealedEventsRaw, wal) {
  const sealedBuf = Buffer.from(sealedEventsRaw, 'utf8');
  const postBuf = Buffer.concat([
    sealedBuf,
    Buffer.from(wal.rotationEvent.eventLineUtf8, 'utf8'),
  ]);
  if (!bytesMatchFp(postBuf, wal.events.post)) throwConflict();
  if (wal.events.post.present !== true) throwConflict();
  return postBuf;
}

/**
 * After fingerprint match: strict parse post events and require unique rotation.
 * @param {Buffer} postBytes
 * @param {object} wal
 */
function verifyEventsPostContent(postBytes, wal) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(postBytes);
  } catch {
    throwConflict();
  }
  let parsed;
  try {
    parsed = parseStrictCanonicalAuditEventLinesText(text, {
      maxLineBytes: AUDIT_CROSS_STORE_MAX_EVENT_LINE_BYTES,
      maxLines: AUDIT_CROSS_STORE_MAX_EVENT_LINES,
    });
  } catch {
    throwConflict();
  }
  if (parsed.count !== wal.events.post.strictRecordCount) throwConflict();

  const lines = text.trimEnd().split('\n').filter((line) => line.length > 0);
  let rotationCount = 0;
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throwConflict();
    }
    if (
      event
      && typeof event === 'object'
      && (
        event.id === wal.rotationId
        || event.type === ROTATION_EVENT_TYPE
      )
    ) {
      rotationCount += 1;
    }
  }
  if (rotationCount !== 1) throwConflict();
  if (!text.endsWith(wal.rotationEvent.eventLineUtf8)) throwConflict();
}

/**
 * @param {string} journalRaw
 * @param {object} wal
 */
function verifyJournalPostContent(journalRaw, wal) {
  let verified;
  try {
    verified = verifyAuditIntegrityJournalText(journalRaw);
  } catch {
    throwConflict();
  }
  if (
    verified.schemaVersion !== 2
    || verified.recordCount !== wal.journal.next.recordCount
    || verified.generationId !== wal.nextGenerationId
    || verified.headDigest !== wal.journal.next.headDigest
    || !verified.generationBinding
    || verified.generationBinding.previousGenerationId !== wal.previousGenerationId
    || verified.generationBinding.previousHeadDigest !== wal.previousHeadDigest
    || verified.generationBinding.archiveManifestDigest !== wal.archiveManifestDigest
  ) {
    throwConflict();
  }

  const lines = journalRaw.trimEnd().split('\n').filter((line) => line.length > 0);
  let rotationCount = 0;
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      throwConflict();
    }
    if (
      rec
      && typeof rec === 'object'
      && rec.recordKind === 'event-link'
      && rec.payloadDigest === wal.rotationEvent.payloadDigest
    ) {
      rotationCount += 1;
    }
  }
  if (rotationCount !== 1) throwConflict();
  return verified;
}

/**
 * Classify dual-write idle against WAL pre/post facts (no live-store revalidation).
 * @param {object|null} state
 * @param {object} wal
 * @returns {'pre'|'post'|'other'}
 */
function classifyDualIdle(state, wal) {
  if (state === null || typeof state !== 'object' || state.status !== 'idle') {
    return 'other';
  }
  const prev = wal.journal.previous;
  const sealed = wal.events.sealed;
  const next = wal.journal.next;
  const post = wal.events.post;

  const isPost = (
    state.generationId === wal.nextGenerationId
    && state.journal.recordCount === next.recordCount
    && state.journal.headDigest === next.headDigest
    && state.journal.rawByteLength === next.rawByteLength
    && state.journal.rawSha256 === next.rawSha256
    && state.events.present === true
    && state.events.byteLength === post.rawByteLength
    && state.events.sha256 === post.rawSha256
    && state.events.strictRecordCount === post.strictRecordCount
    && state.lastTransactionId === wal.rotationId
    && state.lastPayloadDigest === wal.rotationEvent.payloadDigest
    && state.lastSequence === 1
  );
  if (isPost) return 'post';

  const eventsPreOk = sealed.present
    ? (
      state.events.present === true
      && state.events.byteLength === sealed.rawByteLength
      && state.events.sha256 === sealed.rawSha256
      && state.events.strictRecordCount === sealed.strictRecordCount
    )
    : (
      state.events.present === false
      && state.events.byteLength === 0
      && state.events.sha256 === EMPTY_FILE_SHA256
      && state.events.strictRecordCount === 0
    );

  const isPre = (
    state.generationId === wal.previousGenerationId
    && state.journal.recordCount === prev.recordCount
    && state.journal.headDigest === prev.headDigest
    && state.journal.rawByteLength === prev.rawByteLength
    && state.journal.rawSha256 === prev.rawSha256
    && eventsPreOk
  );
  if (isPre) return 'pre';
  return 'other';
}

/**
 * @param {object} wal
 * @param {string} journalRaw
 * @param {Buffer} eventsBytes
 * @returns {object}
 */
function buildPostIdleObject(wal, journalRaw, eventsBytes) {
  return {
    schemaVersion: 1,
    status: 'idle',
    generationId: wal.nextGenerationId,
    journal: {
      recordCount: wal.journal.next.recordCount,
      headDigest: wal.journal.next.headDigest,
      rawByteLength: Buffer.byteLength(journalRaw, 'utf8'),
      rawSha256: sha256Hex(journalRaw),
    },
    events: {
      present: true,
      byteLength: eventsBytes.length,
      sha256: sha256Hex(eventsBytes),
      strictRecordCount: wal.events.post.strictRecordCount,
    },
    lastTransactionId: wal.rotationId,
    lastPayloadDigest: wal.rotationEvent.payloadDigest,
    lastSequence: 1,
  };
}

/**
 * @param {string} state
 * @param {object} wal
 * @param {string} relationship
 * @returns {object}
 */
function freezeReceipt(state, wal, relationship) {
  return Object.freeze({
    state,
    rotationId: wal.rotationId,
    previousGenerationId: wal.previousGenerationId,
    generationId: wal.nextGenerationId,
    archiveRelativePath: wal.archiveRelativePath,
    archiveManifestDigest: wal.archiveManifestDigest,
    previousRecordCount: wal.journal.previous.recordCount,
    newRecordCount: wal.journal.next.recordCount,
    relationship,
  });
}

/**
 * Archive commit using live pre-state as source (pre-manifest authority).
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {object} wal
 * @param {{ crashHook?: string }} opts
 * @returns {Promise<object>}
 */
async function archiveCommitFromLivePreUnlocked(resolvedRoot, lease, wal, opts) {
  const { journalRel, eventsRel, manifestRel } = archiveRels(wal);
  const sealed = wal.events.sealed;
  const builtManifest = rebuildManifestFromWal(wal);
  rebuildV2FromWal(wal);

  let journalRaw;
  try {
    journalRaw = await safeReadText(
      resolvedRoot,
      AUDIT_INTEGRITY_JOURNAL_RELATIVE_PATH,
      { maxBytes: AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES },
    );
  } catch (error) {
    if (error instanceof AuditIntegrityRotationError) throw error;
    throwConflict();
  }
  if (classifyJournalRaw(journalRaw, wal) !== 'pre') throwConflict();

  let verifiedJournal;
  try {
    verifiedJournal = verifyAuditIntegrityJournalText(journalRaw);
  } catch {
    throwConflict();
  }
  if (
    verifiedJournal.generationId !== wal.previousGenerationId
    || verifiedJournal.headDigest !== wal.previousHeadDigest
    || verifiedJournal.recordCount !== wal.journal.previous.recordCount
    || verifiedJournal.schemaVersion !== wal.journal.previous.schemaVersion
  ) {
    throwConflict();
  }

  const eventsProbe = await readLiveEventsProbe(resolvedRoot);
  if (classifyEventsProbe(eventsProbe, wal) !== 'pre') throwConflict();

  const journalRawForArchive = journalRaw;
  const eventsRawForArchive = sealed.present
    ? eventsProbe.bytes.toString('utf8')
    : '';

  await createOrVerifyArchiveText(
    resolvedRoot,
    journalRel,
    journalRawForArchive,
    {
      rawByteLength: wal.journal.previous.rawByteLength,
      rawSha256: wal.journal.previous.rawSha256,
    },
  );
  if (opts.crashHook === 'after-archive-journal') {
    throwTestCrash('TEST_CRASH_AFTER_ARCHIVE_JOURNAL');
  }

  await createOrVerifyArchiveText(
    resolvedRoot,
    eventsRel,
    eventsRawForArchive,
    {
      rawByteLength: sealed.rawByteLength,
      rawSha256: sealed.rawSha256,
    },
  );
  if (opts.crashHook === 'after-archive-events') {
    throwTestCrash('TEST_CRASH_AFTER_ARCHIVE_EVENTS');
  }

  const manifestFp = {
    rawByteLength: Buffer.byteLength(builtManifest.rawText, 'utf8'),
    rawSha256: builtManifest.digest,
  };
  await createOrVerifyArchiveText(
    resolvedRoot,
    manifestRel,
    builtManifest.rawText,
    manifestFp,
    { maxBytes: AUDIT_INTEGRITY_ARCHIVE_MANIFEST_MAX_BYTES },
  );

  // Final commit-point re-verify of ALL three actual archive leaves.
  await verifyArchiveExactText(
    resolvedRoot,
    journalRel,
    journalRawForArchive,
    {
      rawByteLength: wal.journal.previous.rawByteLength,
      rawSha256: wal.journal.previous.rawSha256,
    },
  );
  await verifyArchiveExactText(
    resolvedRoot,
    eventsRel,
    eventsRawForArchive,
    {
      rawByteLength: sealed.rawByteLength,
      rawSha256: sealed.rawSha256,
    },
  );
  const manifestActual = await verifyArchiveExactText(
    resolvedRoot,
    manifestRel,
    builtManifest.rawText,
    manifestFp,
    { maxBytes: AUDIT_INTEGRITY_ARCHIVE_MANIFEST_MAX_BYTES },
  );
  if (sha256Hex(manifestActual) !== wal.archiveManifestDigest) throwConflict();
  try {
    parseAuditIntegrityArchiveManifestText(manifestActual);
  } catch {
    throwConflict();
  }

  if (opts.crashHook === 'after-manifest') {
    throwTestCrash('TEST_CRASH_AFTER_MANIFEST');
  }

  return advanceWalStatus(resolvedRoot, lease, wal, 'archive-committed');
}

/**
 * Ensure archive bundle is committed. Manifest existence is post-commit authority
 * even when WAL still says prepared.
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {object} wal
 * @param {{ crashHook?: string }} opts
 * @returns {Promise<object>}
 */
async function ensureArchiveCommittedUnlocked(resolvedRoot, lease, wal, opts) {
  if (phaseRank(wal.status) >= phaseRank('archive-committed')) {
    // Later phases: archive is immutable authority; require full verified bundle.
    await loadVerifiedArchiveBundle(resolvedRoot, wal, { require: true });
    return wal;
  }

  // prepared: soft-probe for full verified manifest authority.
  const existing = await loadVerifiedArchiveBundle(resolvedRoot, wal, {
    require: false,
  });
  if (existing) {
    // Authority present while WAL prepared — do not rebuild from live.
    if (opts.crashHook === 'after-manifest') {
      throwTestCrash('TEST_CRASH_AFTER_MANIFEST');
    }
    return advanceWalStatus(resolvedRoot, lease, wal, 'archive-committed');
  }

  // No valid full bundle yet — create-or-verify from exact live pre-state.
  return archiveCommitFromLivePreUnlocked(resolvedRoot, lease, wal, opts);
}

/**
 * Journal cutover: pre → atomic v2 publish; post → verify-only; other → conflict.
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {object} wal
 * @param {{ crashHook?: string }} opts
 * @returns {Promise<{ wal: object, journalRaw: string }>}
 */
async function ensureJournalPublishedUnlocked(resolvedRoot, lease, wal, opts) {
  const v2Image = rebuildV2FromWal(wal);

  let liveRaw;
  try {
    liveRaw = await safeReadText(
      resolvedRoot,
      AUDIT_INTEGRITY_JOURNAL_RELATIVE_PATH,
      { maxBytes: AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES },
    );
  } catch {
    throwConflict();
  }

  const klass = classifyJournalRaw(liveRaw, wal);
  if (klass === 'other') throwConflict();

  if (klass === 'pre') {
    // Illegal reverse direction: WAL already claims journal-published (or later)
    // while live journal is exact pre — conflict without rewrite.
    if (phaseRank(wal.status) >= phaseRank('journal-published')) {
      throwConflict();
    }
    try {
      await safeAtomicWriteText(
        resolvedRoot,
        AUDIT_INTEGRITY_JOURNAL_RELATIVE_PATH,
        v2Image.rawText,
        { mode: 0o600 },
      );
    } catch (error) {
      if (error instanceof AuditIntegrityRotationError) throw error;
      throwIo();
    }
    try {
      liveRaw = await safeReadText(
        resolvedRoot,
        AUDIT_INTEGRITY_JOURNAL_RELATIVE_PATH,
        { maxBytes: AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES },
      );
    } catch {
      throwConflict();
    }
    if (liveRaw !== v2Image.rawText) throwConflict();
    if (classifyJournalRaw(liveRaw, wal) !== 'post') throwConflict();
  } else if (liveRaw !== v2Image.rawText) {
    // post fingerprint matched but raw identity must hold
    throwConflict();
  }

  verifyJournalPostContent(liveRaw, wal);

  if (opts.crashHook === 'after-new-journal') {
    throwTestCrash('TEST_CRASH_AFTER_NEW_JOURNAL');
  }

  const nextWal = await advanceWalStatus(
    resolvedRoot,
    lease,
    wal,
    'journal-published',
  );
  return { wal: nextWal, journalRaw: liveRaw };
}

/**
 * Events cutover using archived sealed bytes as sealed source of truth.
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {object} wal
 * @param {string} sealedEventsRaw
 * @param {{ crashHook?: string }} opts
 * @returns {Promise<{ wal: object, eventsBytes: Buffer }>}
 */
async function ensureEventsPublishedUnlocked(
  resolvedRoot,
  lease,
  wal,
  sealedEventsRaw,
  opts,
) {
  const postBytes = buildEventsPostBytes(sealedEventsRaw, wal);
  const probe = await readLiveEventsProbe(resolvedRoot);
  const klass = classifyEventsProbe(probe, wal);
  if (klass === 'other') throwConflict();

  /** @type {Buffer} */
  let liveBytes;
  if (klass === 'pre') {
    // Illegal reverse direction: WAL already claims events-published (or later)
    // while live events are exact pre — conflict without rewrite.
    if (phaseRank(wal.status) >= phaseRank('events-published')) {
      throwConflict();
    }
    try {
      await safeAtomicWriteBytes(
        resolvedRoot,
        AUDIT_CROSS_STORE_EVENTS_RELATIVE_PATH,
        postBytes,
        { mode: 0o600 },
      );
    } catch (error) {
      if (error instanceof AuditIntegrityRotationError) throw error;
      throwIo();
    }
    const after = await readLiveEventsProbe(resolvedRoot);
    if (!after.present || !bytesMatchFp(after.bytes, wal.events.post)) {
      throwConflict();
    }
    liveBytes = after.bytes;
  } else {
    if (!probe.present || !bytesMatchFp(probe.bytes, wal.events.post)) {
      throwConflict();
    }
    liveBytes = probe.bytes;
  }

  // Fingerprint already matched; parse/unique rotation after.
  verifyEventsPostContent(liveBytes, wal);

  if (opts.crashHook === 'after-events-post') {
    throwTestCrash('TEST_CRASH_AFTER_EVENTS_POST');
  }

  const nextWal = await advanceWalStatus(
    resolvedRoot,
    lease,
    wal,
    'events-published',
  );
  return { wal: nextWal, eventsBytes: liveBytes };
}

/**
 * Dual idle cutover + completed WAL publication.
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {object} wal
 * @param {string} journalRaw
 * @param {Buffer} eventsBytes
 * @param {{ crashHook?: string }} opts
 * @returns {Promise<object>}
 */
async function ensureCompletedUnlocked(
  resolvedRoot,
  lease,
  wal,
  journalRaw,
  eventsBytes,
  opts,
) {
  let dualState;
  try {
    dualState = await loadDualWriteStateUnlocked(resolvedRoot, lease);
  } catch {
    throwConflict();
  }

  const klass = classifyDualIdle(dualState, wal);
  if (klass === 'other') throwConflict();

  if (klass === 'pre') {
    const postIdle = buildPostIdleObject(wal, journalRaw, eventsBytes);
    try {
      await publishDualWriteStateUnlocked(resolvedRoot, lease, postIdle);
    } catch (error) {
      if (error instanceof AuditIntegrityRotationError) throw error;
      throwConflict();
    }
  }

  // Exact post proof via shared idle validator (cursor + cross-store SoT).
  let idle;
  try {
    idle = await validateAuditIntegrityDualWriteIdleUnlocked(resolvedRoot, lease);
  } catch {
    throwConflict();
  }
  if (classifyDualIdle(idle, wal) !== 'post') throwConflict();

  // Re-assert actual live fingerprints still bind post idle.
  if (
    idle.journal.rawByteLength !== Buffer.byteLength(journalRaw, 'utf8')
    || idle.journal.rawSha256 !== sha256Hex(journalRaw)
    || idle.events.byteLength !== eventsBytes.length
    || idle.events.sha256 !== sha256Hex(eventsBytes)
    || idle.lastTransactionId !== wal.rotationId
    || idle.lastPayloadDigest !== wal.rotationEvent.payloadDigest
    || idle.lastSequence !== 1
    || idle.generationId !== wal.nextGenerationId
  ) {
    throwConflict();
  }

  if (opts.crashHook === 'after-new-idle') {
    throwTestCrash('TEST_CRASH_AFTER_NEW_IDLE');
  }

  return advanceWalStatus(resolvedRoot, lease, wal, 'completed');
}

/**
 * Final relationship via real cross-store verifier.
 * @param {string} resolvedRoot
 * @returns {Promise<string>}
 */
async function finalRelationship(resolvedRoot) {
  let receipt;
  try {
    receipt = await verifyAuditIntegrityAgainstEventStore(resolvedRoot);
  } catch {
    throwConflict();
  }
  if (
    !receipt
    || typeof receipt !== 'object'
    || typeof receipt.relationship !== 'string'
  ) {
    throwConflict();
  }
  return receipt.relationship;
}

/**
 * Read-only completed fact re-proof. Never rewrites any byte.
 * Any divergence → path-free CONFLICT (normalize nested errors).
 * Shared by entry-completed recover (already-completed) and first-finish
 * nonterminal cutover (rotated) after disk WAL re-load + exact identity bind.
 *
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {object} wal
 * @param {'rotated'|'already-completed'} receiptState
 * @returns {Promise<object>}
 */
async function proveCompletedReadOnlyUnlocked(
  resolvedRoot,
  lease,
  wal,
  receiptState,
) {
  // Internal-only receipt state; never accept other values.
  if (receiptState !== 'rotated' && receiptState !== 'already-completed') {
    throwConflict();
  }
  try {
    if (wal.status !== 'completed') throwConflict();

    const bundle = await loadVerifiedArchiveBundle(resolvedRoot, wal, {
      require: true,
    });
    if (!bundle) throwConflict();

    const v2Image = rebuildV2FromWal(wal);
    let journalRaw;
    try {
      journalRaw = await safeReadText(
        resolvedRoot,
        AUDIT_INTEGRITY_JOURNAL_RELATIVE_PATH,
        { maxBytes: AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES },
      );
    } catch {
      throwConflict();
    }
    // Fingerprint foreign bytes before structural journal verify.
    if (classifyJournalRaw(journalRaw, wal) !== 'post') throwConflict();
    if (journalRaw !== v2Image.rawText) throwConflict();
    verifyJournalPostContent(journalRaw, wal);

    const postBytes = buildEventsPostBytes(bundle.eventsRaw, wal);
    const eventsProbe = await readLiveEventsProbe(resolvedRoot);
    if (classifyEventsProbe(eventsProbe, wal) !== 'post') throwConflict();
    if (!eventsProbe.present || !bytesMatchFp(eventsProbe.bytes, wal.events.post)) {
      throwConflict();
    }
    if (!eventsProbe.bytes.equals(postBytes)) throwConflict();
    verifyEventsPostContent(eventsProbe.bytes, wal);

    let dualState;
    try {
      dualState = await loadDualWriteStateUnlocked(resolvedRoot, lease);
    } catch {
      throwConflict();
    }
    if (classifyDualIdle(dualState, wal) !== 'post') throwConflict();

    let idle;
    try {
      idle = await validateAuditIntegrityDualWriteIdleUnlocked(resolvedRoot, lease);
    } catch {
      throwConflict();
    }
    if (classifyDualIdle(idle, wal) !== 'post') throwConflict();

    const relationship = await finalRelationship(resolvedRoot);
    return freezeReceipt(receiptState, wal, relationship);
  } catch (error) {
    if (error instanceof AuditIntegrityRotationError) throw error;
    throwConflict();
  }
}

/**
 * After publishing completed from a nonterminal path: re-load disk WAL, require
 * full canonical exact identity with the publish result, then full read-only
 * fact re-proof. Returns rotated receipt only when all facts re-verify.
 *
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {object} publishedCompletedWal
 * @returns {Promise<object>}
 */
async function proveFreshCompletedAsRotatedUnlocked(
  resolvedRoot,
  lease,
  publishedCompletedWal,
) {
  let reloaded;
  try {
    reloaded = await loadAuditIntegrityRotationStateUnlocked(resolvedRoot, lease);
  } catch {
    throwConflict();
  }
  if (reloaded === null) throwConflict();
  if (reloaded.status !== 'completed') throwConflict();
  // Full canonical exact identity (fixed key order from parser), not id-only.
  if (JSON.stringify(reloaded) !== JSON.stringify(publishedCompletedWal)) {
    throwConflict();
  }
  return proveCompletedReadOnlyUnlocked(
    resolvedRoot,
    lease,
    reloaded,
    'rotated',
  );
}

/**
 * Roll forward from any nonterminal WAL through archive + cutover to completed.
 * Entry from nonterminal that finishes → rotated receipt after full re-proof.
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {object} wal
 * @param {{ crashHook?: string }} [opts]
 * @returns {Promise<object>}
 */
async function completeRotationFromWalUnlocked(resolvedRoot, lease, wal, opts = {}) {
  if (wal.status === 'completed') {
    return proveCompletedReadOnlyUnlocked(
      resolvedRoot,
      lease,
      wal,
      'already-completed',
    );
  }
  if (!NONTERMINAL_STATUSES.has(wal.status)) {
    throwStateInvalid();
  }

  // 1) Archive commit / authority
  let cur = await ensureArchiveCommittedUnlocked(resolvedRoot, lease, wal, opts);

  // Sealed events raw from immutable archive (never from possibly-post live).
  const bundle = await loadVerifiedArchiveBundle(resolvedRoot, cur, {
    require: true,
  });
  if (!bundle) throwConflict();

  // 2) Journal cutover
  const journalStep = await ensureJournalPublishedUnlocked(
    resolvedRoot,
    lease,
    cur,
    opts,
  );
  cur = journalStep.wal;

  // 3) Events cutover
  const eventsStep = await ensureEventsPublishedUnlocked(
    resolvedRoot,
    lease,
    cur,
    bundle.eventsRaw,
    opts,
  );
  cur = eventsStep.wal;

  // 4) Dual idle + completed WAL publication
  cur = await ensureCompletedUnlocked(
    resolvedRoot,
    lease,
    cur,
    journalStep.journalRaw,
    eventsStep.eventsBytes,
    opts,
  );

  // 5) Fresh disk WAL bind + full completed fact re-proof → rotated
  //    (not finalRelationship alone; foreign archive/live must conflict).
  return proveFreshCompletedAsRotatedUnlocked(resolvedRoot, lease, cur);
}

/**
 * @param {string} resolvedRoot
 * @param {object} lease
 * @param {{
 *   expectedGenerationId: string,
 *   expectedHeadDigest: string,
 *   crashHook: string|undefined,
 * }} snap
 */
async function rotateUnlocked(resolvedRoot, lease, snap) {
  // Rotation WAL gate first.
  const existingWal = await loadAuditIntegrityRotationStateUnlocked(
    resolvedRoot,
    lease,
  );
  if (existingWal !== null) {
    // Existing WAL (nonterminal or completed) fail-closed for a new rotate.
    throwRecoveryRequired();
  }

  // Exact dual-write idle validator (no bootstrap/recover/write).
  const idle = await validateAuditIntegrityDualWriteIdleUnlocked(
    resolvedRoot,
    lease,
  );

  // Expected generation/head.
  if (
    idle.generationId !== snap.expectedGenerationId
    || idle.journal.headDigest !== snap.expectedHeadDigest
  ) {
    throwPrecondition();
  }

  // Exact old journal / events snapshots.
  let journalRaw;
  try {
    journalRaw = await safeReadText(
      resolvedRoot,
      AUDIT_INTEGRITY_JOURNAL_RELATIVE_PATH,
      { maxBytes: AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES },
    );
  } catch (error) {
    if (error instanceof AuditIntegrityRotationError) throw error;
    if (
      error
      && typeof error === 'object'
      && 'name' in error
      && /** @type {{ name?: string }} */ (error).name === 'AuditIntegrityJournalError'
    ) {
      throw error;
    }
    throwIo();
  }

  let verifiedJournal;
  try {
    verifiedJournal = verifyAuditIntegrityJournalText(journalRaw);
  } catch (error) {
    if (error instanceof AuditIntegrityRotationError) throw error;
    throw error;
  }

  if (
    verifiedJournal.generationId !== idle.generationId
    || verifiedJournal.headDigest !== idle.journal.headDigest
    || verifiedJournal.recordCount !== idle.journal.recordCount
  ) {
    throwConflict();
  }

  const journalPrevious = {
    schemaVersion: verifiedJournal.schemaVersion,
    recordCount: verifiedJournal.recordCount,
    headDigest: verifiedJournal.headDigest,
    rawByteLength: Buffer.byteLength(journalRaw, 'utf8'),
    rawSha256: sha256Hex(journalRaw),
  };
  if (
    journalPrevious.rawByteLength !== idle.journal.rawByteLength
    || journalPrevious.rawSha256 !== idle.journal.rawSha256
  ) {
    throwConflict();
  }

  /** @type {{ present: boolean, bytes: Buffer }} */
  let eventsProbe;
  try {
    const bytes = await safeReadBytes(
      resolvedRoot,
      AUDIT_CROSS_STORE_EVENTS_RELATIVE_PATH,
      { maxBytes: AUDIT_CROSS_STORE_EVENTS_MAX_PRE_READ_BYTES },
    );
    eventsProbe = { present: true, bytes };
  } catch (error) {
    if (isEnoent(error)) {
      eventsProbe = { present: false, bytes: Buffer.alloc(0) };
    } else if (error instanceof AuditIntegrityRotationError) {
      throw error;
    } else {
      throwIo();
    }
  }

  /** @type {{
   *   present: boolean,
   *   strictRecordCount: number,
   *   rawByteLength: number,
   *   rawSha256: string,
   * }} */
  let eventsSealed;
  if (!eventsProbe.present) {
    eventsSealed = {
      present: false,
      strictRecordCount: 0,
      rawByteLength: 0,
      rawSha256: EMPTY_FILE_SHA256,
    };
  } else {
    let parsed;
    try {
      const rawText = new TextDecoder('utf-8', { fatal: true }).decode(
        eventsProbe.bytes,
      );
      parsed = parseStrictCanonicalAuditEventLinesText(rawText, {
        maxLineBytes: AUDIT_CROSS_STORE_MAX_EVENT_LINE_BYTES,
        maxLines: AUDIT_CROSS_STORE_MAX_EVENT_LINES,
      });
    } catch (error) {
      if (error instanceof StrictCanonicalAuditEventLinesParseError) {
        throw error;
      }
      throw error;
    }
    eventsSealed = {
      present: true,
      strictRecordCount: parsed.count,
      rawByteLength: eventsProbe.bytes.length,
      rawSha256: sha256Hex(eventsProbe.bytes),
    };
  }

  if (
    eventsSealed.present !== idle.events.present
    || eventsSealed.rawByteLength !== idle.events.byteLength
    || eventsSealed.rawSha256 !== idle.events.sha256
    || eventsSealed.strictRecordCount !== idle.events.strictRecordCount
  ) {
    throwConflict();
  }

  const previousGenerationId = verifiedJournal.generationId;
  const nextGenerationId = newNextGenerationId(previousGenerationId);
  const rotationEvent = buildFixedRotationEvent();
  const rotationId = rotationEvent.event.id;
  const createdAt = rotationEvent.event.createdAt;

  // Bounds before any WAL/archive write.
  const eventBodyLen = Buffer.byteLength(
    rotationEvent.eventLineUtf8.endsWith('\n')
      ? rotationEvent.eventLineUtf8.slice(0, -1)
      : rotationEvent.eventLineUtf8,
    'utf8',
  );
  if (eventBodyLen > AUDIT_CROSS_STORE_MAX_EVENT_LINE_BYTES) throwBounds();
  if (eventsSealed.strictRecordCount + 1 > AUDIT_CROSS_STORE_MAX_EVENT_LINES) {
    throwBounds();
  }
  const eventLineBytes = Buffer.byteLength(rotationEvent.eventLineUtf8, 'utf8');
  if (
    eventsSealed.rawByteLength + eventLineBytes
    > AUDIT_CROSS_STORE_EVENTS_MAX_PRE_READ_BYTES
  ) {
    throwBounds();
  }

  const builtManifest = buildAuditIntegrityArchiveManifest({
    schemaVersion: 1,
    recordKind: MANIFEST_RECORD_KIND,
    rotationId,
    createdAt,
    previousGenerationId,
    previousJournalSchemaVersion: verifiedJournal.schemaVersion,
    previousHeadDigest: verifiedJournal.headDigest,
    journal: {
      rawByteLength: journalPrevious.rawByteLength,
      rawSha256: journalPrevious.rawSha256,
      recordCount: journalPrevious.recordCount,
    },
    events: {
      present: eventsSealed.present,
      rawByteLength: eventsSealed.rawByteLength,
      rawSha256: eventsSealed.rawSha256,
      strictRecordCount: eventsSealed.strictRecordCount,
    },
    nextGenerationId,
    rotationEventId: rotationId,
    rotationEventPayloadDigest: rotationEvent.payloadDigest,
  });

  let v2Image;
  try {
    v2Image = buildAuditIntegrityV2GenerationImage({
      generationId: nextGenerationId,
      previousGenerationId,
      previousHeadDigest: verifiedJournal.headDigest,
      archiveManifestDigest: builtManifest.digest,
      rotationEvent: {
        id: rotationEvent.event.id,
        createdAt: rotationEvent.event.createdAt,
        type: rotationEvent.event.type,
        outcome: rotationEvent.event.outcome,
        operation: rotationEvent.event.operation,
        message: rotationEvent.event.message,
      },
    });
  } catch (error) {
    if (error instanceof AuditIntegrityRotationError) throw error;
    throw error;
  }

  const journalNext = {
    schemaVersion: 2,
    recordCount: 2,
    headDigest: v2Image.headDigest,
    rawByteLength: v2Image.rawByteLength,
    rawSha256: v2Image.rawSha256,
  };

  const postBuf = Buffer.concat([
    eventsProbe.present ? eventsProbe.bytes : Buffer.alloc(0),
    Buffer.from(rotationEvent.eventLineUtf8, 'utf8'),
  ]);
  const eventsPost = {
    present: true,
    strictRecordCount: eventsSealed.strictRecordCount + 1,
    rawByteLength: postBuf.length,
    rawSha256: sha256Hex(postBuf),
  };

  const archiveRelativePath = `audit/archive/${previousGenerationId}`;

  const preparedObj = buildRotationWalObject({
    status: 'prepared',
    rotationId,
    createdAt,
    previousGenerationId,
    previousHeadDigest: verifiedJournal.headDigest,
    nextGenerationId,
    archiveRelativePath,
    archiveManifestDigest: builtManifest.digest,
    rotationEvent,
    journalPrevious,
    journalNext,
    eventsSealed,
    eventsPost,
  });

  const prepared = await publishAuditIntegrityRotationStateUnlocked(
    resolvedRoot,
    lease,
    preparedObj,
  );

  if (snap.crashHook === 'after-prepared') {
    throwTestCrash('TEST_CRASH_AFTER_PREPARED');
  }

  return completeRotationFromWalUnlocked(resolvedRoot, lease, prepared, {
    crashHook: snap.crashHook,
  });
}

/**
 * Explicit generation rotation: preflight → prepared → archive → cutover → completed.
 *
 * @param {string} dataDir
 * @param {unknown} options
 * @returns {Promise<object>}
 */
export async function rotateAuditIntegrityGeneration(dataDir, options) {
  const snap = snapshotRotateOptions(options);

  let resolvedRoot;
  try {
    resolvedRoot = await assertSafeDataRoot(dataDir);
  } catch (error) {
    if (error instanceof AuditIntegrityRotationError) throw error;
    throwIo();
  }

  return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => (
    rotateUnlocked(resolvedRoot, lease, snap)
  ));
}

/**
 * Explicit recovery for nonterminal phases or completed re-proof.
 * prepared / archive-committed / journal-published / events-published → roll forward.
 * completed → read-only independent fact verification → already-completed.
 *
 * @param {string} dataDir
 * @returns {Promise<object>}
 */
export async function recoverAuditIntegrityRotation(dataDir) {
  let resolvedRoot;
  try {
    resolvedRoot = await assertSafeDataRoot(dataDir);
  } catch (error) {
    if (error instanceof AuditIntegrityRotationError) throw error;
    throwIo();
  }

  return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => {
    const wal = await loadAuditIntegrityRotationStateUnlocked(resolvedRoot, lease);
    if (wal === null) throwStateInvalid();
    if (wal.status === 'completed') {
      return proveCompletedReadOnlyUnlocked(
        resolvedRoot,
        lease,
        wal,
        'already-completed',
      );
    }
    if (!NONTERMINAL_STATUSES.has(wal.status)) {
      throwStateInvalid();
    }
    return completeRotationFromWalUnlocked(resolvedRoot, lease, wal, {});
  });
}

/** Healthy live relationships allowed after completed (includes post-retention). */
const COMPLETED_LIVE_RELATIONSHIPS = new Set([
  'equal',
  'events-suffix-of-journal',
  'journal-suffix-of-events',
]);

/**
 * Deep-freeze rotation read-only observation (fixed key order; path/raw free).
 * @param {{
 *   kind: 'absent'|'recovery-required'|'completed',
 *   dualWriteState: 'unknown'|'idle',
 *   relationship: string|null,
 *   reasonCode: string|null,
 * }} fields
 * @returns {Readonly<object>}
 */
function freezeRotationReadOnlyObservation(fields) {
  return Object.freeze({
    schemaVersion: 1,
    kind: fields.kind,
    dualWriteState: fields.dualWriteState,
    relationship: fields.relationship,
    reasonCode: fields.reasonCode,
  });
}

/**
 * Count event-link records with exact payloadDigest in already-verified journal raw.
 * @param {string} journalRaw
 * @param {string} payloadDigest
 * @returns {number}
 */
function countJournalEventLinkPayloadDigest(journalRaw, payloadDigest) {
  if (typeof journalRaw !== 'string' || !journalRaw.endsWith('\n')) throwConflict();
  const body = journalRaw.slice(0, -1);
  const lines = body === '' ? [] : body.split('\n');
  let count = 0;
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      throwConflict();
    }
    if (
      rec
      && typeof rec === 'object'
      && rec.recordKind === 'event-link'
      && rec.payloadDigest === payloadDigest
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * completed WAL live-store proof that allows later legal append/retention.
 * Does NOT require live journal/events bytes to match cutover post fingerprints.
 *
 * @param {string} resolvedRoot
 * @param {object} wal completed rotation WAL
 * @returns {Promise<string>} verified dual/cross-store relationship
 */
async function proveCompletedLiveAllowsRetentionUnlocked(resolvedRoot, wal) {
  // Latest archive bundle only (WAL-direct path); never scan other archives.
  await loadVerifiedArchiveBundle(resolvedRoot, wal, { require: true });

  let journalRaw;
  try {
    journalRaw = await safeReadText(
      resolvedRoot,
      AUDIT_INTEGRITY_JOURNAL_RELATIVE_PATH,
      { maxBytes: AUDIT_INTEGRITY_JOURNAL_MAX_PRE_READ_BYTES },
    );
  } catch {
    throwConflict();
  }

  let verified;
  try {
    verified = verifyAuditIntegrityJournalText(journalRaw);
  } catch {
    throwConflict();
  }
  if (verified.schemaVersion !== 2) throwConflict();
  if (verified.generationId !== wal.nextGenerationId) throwConflict();
  if (
    !verified.generationBinding
    || verified.generationBinding.previousGenerationId !== wal.previousGenerationId
    || verified.generationBinding.previousHeadDigest !== wal.previousHeadDigest
    || verified.generationBinding.archiveManifestDigest !== wal.archiveManifestDigest
  ) {
    throwConflict();
  }
  if (
    countJournalEventLinkPayloadDigest(
      journalRaw,
      wal.rotationEvent.payloadDigest,
    ) !== 1
  ) {
    throwConflict();
  }

  // Public dual-write inspector: current idle/cursor/cross-store (allows retention).
  let dualObs;
  try {
    dualObs = await inspectAuditIntegrityDualWriteReadOnly(resolvedRoot);
  } catch {
    throwConflict();
  }
  if (
    !dualObs
    || dualObs.statePresence !== 'idle'
    || dualObs.stateStatus !== 'idle'
    || dualObs.cursorMatch !== 'match'
    || dualObs.journalOutcome !== 'verified'
    || dualObs.crossStoreOutcome !== 'ok'
    || dualObs.reasonCode !== null
    || dualObs.errorLayer !== 'none'
    || !COMPLETED_LIVE_RELATIONSHIPS.has(dualObs.relationship)
  ) {
    throwConflict();
  }
  return /** @type {string} */ (dualObs.relationship);
}

/**
 * 公共只读 rotation 观察：不写、不 enqueue、不 recover、不扫描历史 archive。
 * missing → absent；nonterminal → recovery-required；completed → 深验 WAL 直接引用
 * 的最新 archive + 允许后续合法 append/retention 的 live 绑定。
 *
 * @param {string} dataDir
 * @returns {Promise<Readonly<{
 *   schemaVersion: 1,
 *   kind: 'absent'|'recovery-required'|'completed',
 *   dualWriteState: 'unknown'|'idle',
 *   relationship: string|null,
 *   reasonCode: string|null,
 * }>>}
 */
export async function inspectAuditIntegrityRotationReadOnly(dataDir) {
  let resolvedRoot;
  try {
    resolvedRoot = await assertSafeDataRoot(dataDir);
  } catch (error) {
    if (error instanceof AuditIntegrityRotationError) throw error;
    throwIo();
  }

  let raw;
  try {
    raw = await safeReadText(
      resolvedRoot,
      AUDIT_INTEGRITY_ROTATION_STATE_RELATIVE_PATH,
      { maxBytes: AUDIT_INTEGRITY_ROTATION_STATE_MAX_BYTES },
    );
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return freezeRotationReadOnlyObservation({
        kind: 'absent',
        dualWriteState: 'unknown',
        relationship: null,
        reasonCode: null,
      });
    }
    if (error instanceof AuditIntegrityRotationError) throw error;
    // Directory leaf / oversize / other safe I/O → path-free rotation IO.
    throwIo();
  }

  let wal;
  try {
    wal = parseAuditIntegrityRotationStateText(raw);
  } catch (error) {
    if (error instanceof AuditIntegrityRotationError) throw error;
    throwStateInvalid();
  }

  if (NONTERMINAL_STATUSES.has(wal.status)) {
    return freezeRotationReadOnlyObservation({
      kind: 'recovery-required',
      dualWriteState: 'unknown',
      relationship: null,
      reasonCode: ERROR_CODES.AUDIT_INTEGRITY_ROTATION_RECOVERY_REQUIRED,
    });
  }

  if (wal.status !== 'completed') {
    throwStateInvalid();
  }

  try {
    const relationship = await proveCompletedLiveAllowsRetentionUnlocked(
      resolvedRoot,
      wal,
    );
    return freezeRotationReadOnlyObservation({
      kind: 'completed',
      dualWriteState: 'idle',
      relationship,
      reasonCode: null,
    });
  } catch (error) {
    if (error instanceof AuditIntegrityRotationError) throw error;
    throwConflict();
  }
}
