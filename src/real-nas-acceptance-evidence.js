/**
 * Pure closed-schema validator for V1.44 real-NAS acceptance evidence receipts.
 * No file, Git, env, clock, network, or NAS I/O.
 */

export const REAL_NAS_ACCEPTANCE_EVIDENCE_INVALID =
  'real-nas-acceptance-evidence-invalid';

const TOP_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'acceptanceId',
  'runtimeVersion',
  'runtimeSourceCommit',
  'acceptedAt',
  'environment',
  'provider',
  'mountType',
  'copy',
  'recovery',
  'audit',
]);

const COPY_KEYS = Object.freeze([
  'state',
  'fileCount',
  'totalBytes',
  'verifiedFileCount',
  'manifestSha256',
  'completedMarkerValid',
  'lockResidualCount',
  'stagingResidualCount',
]);

const RECOVERY_KEYS = Object.freeze([
  'scenario',
  'terminationSignal',
  'staleLockValidated',
  'stagedFileCount',
  'stagedVerifiedFileCount',
  'state',
  'finalPublished',
  'postFinalExists',
  'lockResidualCount',
  'stagingResidualCount',
  'residualFileCount',
  'firstPublishedSnapshotPreserved',
]);

const AUDIT_KEYS = Object.freeze([
  'status',
  'dualWriteState',
  'relationship',
  'recoveryRequired',
]);

const ACCEPTANCE_ID_RE = /^NAS-REAL-V144-[0-9]{8}-[0-9]{2}$/;
const HEX40_RE = /^[0-9a-f]{40}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

/**
 * Create a fresh fixed public error. Never include input, keys, or causes.
 * @returns {Error & { code: string }}
 */
function invalidEvidence() {
  const error = new Error(REAL_NAS_ACCEPTANCE_EVIDENCE_INVALID);
  error.name = 'RealNasAcceptanceEvidenceError';
  error.code = REAL_NAS_ACCEPTANCE_EVIDENCE_INVALID;
  return error;
}

function fail() {
  throw invalidEvidence();
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainDataObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Read a closed plain object via data descriptors only (never invoke accessors).
 * @param {unknown} value
 * @param {ReadonlyArray<string>} expectedKeys
 * @returns {Record<string, unknown>}
 */
function readClosedObject(value, expectedKeys) {
  if (!isPlainDataObject(value)) fail();

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expectedKeys.length) fail();

  const expected = new Set(expectedKeys);
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !expected.has(key)) fail();
  }

  /** @type {Record<string, unknown>} */
  const out = Object.create(null);
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor) fail();
    if (Object.prototype.hasOwnProperty.call(descriptor, 'get')) fail();
    if (Object.prototype.hasOwnProperty.call(descriptor, 'set')) fail();
    if (descriptor.enumerable !== true) fail();
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail();
    out[key] = descriptor.value;
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {unknown} expected
 */
function assertExact(value, expected) {
  if (value !== expected) fail();
}

/**
 * @param {unknown} value
 */
function assertSafeInteger(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail();
}

/**
 * @param {unknown} value
 */
function assertNonNegativeSafeInteger(value) {
  assertSafeInteger(value);
  if (/** @type {number} */ (value) < 0) fail();
}

/**
 * @param {unknown} value
 */
function assertPositiveSafeInteger(value) {
  assertSafeInteger(value);
  if (/** @type {number} */ (value) <= 0) fail();
}

/**
 * @param {unknown} value
 */
function assertLowerHex40(value) {
  if (typeof value !== 'string' || !HEX40_RE.test(value)) fail();
}

/**
 * @param {unknown} value
 */
function assertLowerHex64(value) {
  if (typeof value !== 'string' || !HEX64_RE.test(value)) fail();
}

/**
 * Canonical UTC millisecond ISO only: Date.parse finite and toISOString round-trips.
 * @param {unknown} value
 */
function assertCanonicalAcceptedAt(value) {
  if (typeof value !== 'string') fail();
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) fail();
  if (new Date(ms).toISOString() !== value) fail();
}

/**
 * @param {unknown} value
 */
function assertAcceptanceId(value) {
  if (typeof value !== 'string' || !ACCEPTANCE_ID_RE.test(value)) fail();
}

/**
 * @param {unknown} raw
 */
function validateCopy(raw) {
  const copy = readClosedObject(raw, COPY_KEYS);
  assertExact(copy.state, 'replicated');
  assertPositiveSafeInteger(copy.fileCount);
  assertNonNegativeSafeInteger(copy.totalBytes);
  assertSafeInteger(copy.verifiedFileCount);
  if (copy.verifiedFileCount !== copy.fileCount) fail();
  assertLowerHex64(copy.manifestSha256);
  assertExact(copy.completedMarkerValid, true);
  assertNonNegativeSafeInteger(copy.lockResidualCount);
  if (copy.lockResidualCount !== 0) fail();
  assertNonNegativeSafeInteger(copy.stagingResidualCount);
  if (copy.stagingResidualCount !== 0) fail();
}

/**
 * @param {unknown} raw
 */
function validateRecovery(raw) {
  const recovery = readClosedObject(raw, RECOVERY_KEYS);
  assertExact(recovery.scenario, 'staging-ready-process-termination');
  assertExact(recovery.terminationSignal, 'SIGKILL');
  assertExact(recovery.staleLockValidated, true);
  assertPositiveSafeInteger(recovery.stagedFileCount);
  assertSafeInteger(recovery.stagedVerifiedFileCount);
  if (recovery.stagedVerifiedFileCount !== recovery.stagedFileCount) fail();
  assertExact(recovery.state, 'recovered');
  assertExact(recovery.finalPublished, false);
  assertExact(recovery.postFinalExists, false);
  assertNonNegativeSafeInteger(recovery.lockResidualCount);
  if (recovery.lockResidualCount !== 0) fail();
  assertNonNegativeSafeInteger(recovery.stagingResidualCount);
  if (recovery.stagingResidualCount !== 0) fail();
  assertNonNegativeSafeInteger(recovery.residualFileCount);
  if (recovery.residualFileCount !== 0) fail();
  assertExact(recovery.firstPublishedSnapshotPreserved, true);
}

/**
 * @param {unknown} raw
 */
function validateAudit(raw) {
  const audit = readClosedObject(raw, AUDIT_KEYS);
  assertExact(audit.status, 'healthy');
  assertExact(audit.dualWriteState, 'idle');
  assertExact(audit.relationship, 'equal');
  assertExact(audit.recoveryRequired, false);
}

/**
 * @param {unknown} input
 */
function validateBody(input) {
  const top = readClosedObject(input, TOP_KEYS);
  assertExact(top.schemaVersion, 1);
  assertExact(top.kind, 'linke-real-nas-acceptance');
  assertAcceptanceId(top.acceptanceId);
  assertExact(top.runtimeVersion, 'V1.44');
  assertLowerHex40(top.runtimeSourceCommit);
  assertCanonicalAcceptedAt(top.acceptedAt);
  assertExact(top.environment, 'non-production');
  assertExact(top.provider, 'synology');
  assertExact(top.mountType, 'smbfs');
  validateCopy(top.copy);
  validateRecovery(top.recovery);
  validateAudit(top.audit);
}

/**
 * Validate one JSON-parsed V1.44 real-NAS acceptance receipt.
 * Returns true; every invalid input throws only the fixed public code.
 * @param {unknown} input
 * @returns {true}
 */
export function validateRealNasAcceptanceEvidence(input) {
  try {
    validateBody(input);
    return true;
  } catch {
    throw invalidEvidence();
  }
}
