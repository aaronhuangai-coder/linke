/**
 * V1.38/V1.43 read-only audit integrity run-once monitor report contract.
 *
 * ONLY imports two public read-only inspectors:
 *   inspectAuditIntegrityDualWriteReadOnly
 *   inspectAuditIntegrityRotationReadOnly
 * Maps frozen observation → frozen report (design §3.3–§3.7).
 * Zero writes; no timers; no process.argv; no error-codes registry.
 */

import { inspectAuditIntegrityDualWriteReadOnly } from './audit-integrity-dual-write.js';
import { inspectAuditIntegrityRotationReadOnly } from './audit-integrity-rotation.js';

/** Test-only Symbol; CLI MUST NOT accept wall-clock override. */
export const AUDIT_INTEGRITY_MONITOR_TEST_CHECKED_AT = Symbol(
  'linke.audit-integrity-monitor.test-checkedAt',
);

export const AUDIT_INTEGRITY_MONITOR_CONDITION_CODES = Object.freeze([
  'healthy',
  'uninitialized',
  'state-missing',
  'recovery-required',
  'rotation-recovery-required',
  'integrity-alert',
  'io-alert',
]);

/** Fixed typed rotation reason codes (string literals; no error-codes import). */
const ROTATION_REASON_RECOVERY_REQUIRED =
  'audit-integrity-rotation-recovery-required';
const ROTATION_REASON_STATE_INVALID =
  'audit-integrity-rotation-state-invalid';
const ROTATION_REASON_IO_ERROR = 'audit-integrity-rotation-io-error';
const ROTATION_REASON_CONFLICT = 'audit-integrity-rotation-conflict';

/** Legacy dual-write RootFail / Sio reason (string literal; no error-codes import). */
const DUAL_WRITE_REASON_IO_ERROR = 'audit-integrity-dual-write-io-error';

const REPORT_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'code',
  'checkedAt',
  'dualWriteState',
  'relationship',
  'recoveryRequired',
  'alertRequired',
  'nextAction',
  'reasonCode',
]);

const OBS_KEYS = Object.freeze([
  'statePresence',
  'stateStatus',
  'storesEmpty',
  'cursorMatch',
  'journalOutcome',
  'crossStoreOutcome',
  'relationship',
  'reasonCode',
  'errorLayer',
]);

const STATE_PRESENCE = new Set(['absent', 'idle', 'prepared', 'invalid', 'io-error']);
const STATE_STATUS = new Set(['idle', 'prepared', null]);
const CURSOR_MATCH = new Set(['n/a', 'match', 'mismatch', 'skipped']);
const JOURNAL_OUT = new Set(['missing', 'verified', 'typed-error', 'skipped']);
const CROSS_OUT = new Set(['ok', 'typed-error', 'skipped']);
const ERROR_LAYER = new Set([
  'none',
  'state',
  'journal',
  'events',
  'cross-store',
  'cursor',
  'root',
]);
const RELATIONSHIP = new Set([
  'empty',
  'equal',
  'events-suffix-of-journal',
  'journal-suffix-of-events',
  'uncovered-events',
  null,
]);
const HEALTHY_RELATIONSHIP = new Set([
  'equal',
  'events-suffix-of-journal',
  'journal-suffix-of-events',
]);

const STATUS_SET = new Set(['healthy', 'alert']);
const DUAL_WRITE_STATE_SET = new Set([
  'idle',
  'prepared',
  'missing',
  'invalid',
  'unknown',
]);
const NEXT_ACTION_SET = new Set([
  'none',
  'initialize-via-production-write',
  'run-explicit-recovery',
  'investigate-integrity',
]);
const CONDITION_CODE_SET = new Set(AUDIT_INTEGRITY_MONITOR_CONDITION_CODES);

const CHECKED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const MISUSE_TYPE_ERROR = 'invalid audit integrity monitor report';

/**
 * Module-private issuance provenance for monitor reports.
 * Never exported. WeakSet.has does not trigger Proxy traps.
 */
const ISSUED_MONITOR_REPORTS = new WeakSet();

/**
 * Resolve checkedAt from options via own data descriptor only.
 * Never uses ordinary property read (options[SYMBOL] / Reflect.get).
 * Proxy getOwnPropertyDescriptor trap may run; throw/illegal → real clock.
 * @param {object} [options]
 * @returns {string}
 */
function resolveCheckedAt(options) {
  const fallback = () => new Date().toISOString();
  if (options === null || options === undefined || typeof options !== 'object') {
    return fallback();
  }
  let desc;
  try {
    desc = Object.getOwnPropertyDescriptor(
      options,
      AUDIT_INTEGRITY_MONITOR_TEST_CHECKED_AT,
    );
  } catch {
    return fallback();
  }
  if (desc == null) return fallback();
  if (!Object.prototype.hasOwnProperty.call(desc, 'value')) return fallback();
  if (desc.get !== undefined || desc.set !== undefined) return fallback();
  const value = desc.value;
  if (typeof value !== 'string') return fallback();
  if (!CHECKED_AT_RE.test(value)) return fallback();
  try {
    if (new Date(value).toISOString() !== value) return fallback();
  } catch {
    return fallback();
  }
  return value;
}

/**
 * Condition classification by reason suffix semantics (not registry whitelist).
 * @param {string|null} reasonCode
 * @returns {'integrity-alert'|'io-alert'}
 */
function conditionFromTypedReason(reasonCode) {
  if (typeof reasonCode === 'string' && reasonCode.endsWith('-io-error')) {
    return 'io-alert';
  }
  return 'integrity-alert';
}

/**
 * Structural path-free kebab reason guard (not ERROR_CODES membership).
 * C1 registry remains the trusted SoT for real codes; this only rejects
 * path-like / hostile shapes before values enter the mapper.
 * @param {string} code
 * @returns {boolean}
 */
function isStructuralPathFreeKebabReason(code) {
  // Registered dual-write codes are strict lowercase kebab, max len 50.
  if (typeof code !== 'string') return false;
  if (code.length < 1 || code.length > 128) return false;
  return /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(code);
}

/**
 * Validate frozen observation and return plain descriptor values map.
 * All reflection (isFrozen / keys / getOwnPropertyDescriptor) is fail-closed:
 * trap throws → null (caller maps to fixed failClosed report; raw not rethrown).
 * Values are read only via own data descriptors — never ordinary property get.
 * Shape/enum only — cross-field semantic consistency is separate
 * (observationHasSemanticConsistency) and enforced by the mapper.
 * @param {unknown} obs
 * @returns {object|null} Object.create(null) values map, or null if invalid
 */
function readValidFrozenObservationValues(obs) {
  if (obs === null || typeof obs !== 'object' || Array.isArray(obs)) return null;
  try {
    // Object.isFrozen may fire isExtensible / ownKeys / getOwnPropertyDescriptor traps
    if (!Object.isFrozen(obs)) return null;
    const keys = Object.keys(obs);
    if (keys.length !== OBS_KEYS.length) return null;
    for (let i = 0; i < OBS_KEYS.length; i += 1) {
      if (keys[i] !== OBS_KEYS[i]) return null;
    }
    // Read only via own data descriptors (no ordinary get on potential Proxy)
    const values = Object.create(null);
    for (const key of OBS_KEYS) {
      const d = Object.getOwnPropertyDescriptor(obs, key);
      if (d == null) return null;
      if (!Object.prototype.hasOwnProperty.call(d, 'value')) return null;
      if (d.get !== undefined || d.set !== undefined) return null;
      values[key] = d.value;
    }
    if (!STATE_PRESENCE.has(values.statePresence)) return null;
    if (!STATE_STATUS.has(values.stateStatus)) return null;
    if (typeof values.storesEmpty !== 'boolean') return null;
    if (!CURSOR_MATCH.has(values.cursorMatch)) return null;
    if (!JOURNAL_OUT.has(values.journalOutcome)) return null;
    if (!CROSS_OUT.has(values.crossStoreOutcome)) return null;
    if (!RELATIONSHIP.has(values.relationship)) return null;
    if (values.reasonCode !== null) {
      if (!isStructuralPathFreeKebabReason(values.reasonCode)) return null;
    }
    if (!ERROR_LAYER.has(values.errorLayer)) return null;
    return values;
  } catch {
    return null;
  }
}

/**
 * Cross-field semantic consistency for observation descriptor values.
 * Per-field enums may all be legal while combinations contradict C1 families;
 * those must fail-closed before mapping (never healthy / never partial truth).
 * Does not copy ERROR_CODES membership — only structural cross-field rules.
 * @param {object} values plain Object.create(null) map from shape validator
 * @returns {boolean}
 */
function observationHasSemanticConsistency(values) {
  const statePresence = values.statePresence;
  const stateStatus = values.stateStatus;
  const storesEmpty = values.storesEmpty;
  const cursorMatch = values.cursorMatch;
  const journalOutcome = values.journalOutcome;
  const crossStoreOutcome = values.crossStoreOutcome;
  const relationship = values.relationship;
  const reasonCode = values.reasonCode;
  const errorLayer = values.errorLayer;

  // presence ↔ status coherence
  if (statePresence === 'idle' && stateStatus !== 'idle') return false;
  if (statePresence === 'prepared' && stateStatus !== 'prepared') return false;
  if (
    (statePresence === 'absent'
      || statePresence === 'invalid'
      || statePresence === 'io-error')
    && stateStatus !== null
  ) {
    return false;
  }

  // storesEmpty=true only for cold-absent family; never idle/prepared/invalid/io-error
  if (storesEmpty === true && statePresence !== 'absent') return false;
  if (
    statePresence === 'idle'
    || statePresence === 'prepared'
    || statePresence === 'invalid'
    || statePresence === 'io-error'
  ) {
    if (storesEmpty !== false) return false;
  }

  if (statePresence === 'io-error') {
    // C1 Sio/RootFail family: probes skipped; structural *-io-error; layer state|root
    return (
      stateStatus === null
      && storesEmpty === false
      && cursorMatch === 'skipped'
      && journalOutcome === 'skipped'
      && crossStoreOutcome === 'skipped'
      && relationship === null
      && typeof reasonCode === 'string'
      && reasonCode.endsWith('-io-error')
      && (errorLayer === 'state' || errorLayer === 'root')
    );
  }

  if (statePresence === 'invalid') {
    return (
      stateStatus === null
      && storesEmpty === false
      && cursorMatch === 'skipped'
      && journalOutcome === 'skipped'
      && crossStoreOutcome === 'skipped'
      && relationship === null
      && reasonCode !== null
      && errorLayer === 'state'
    );
  }

  if (statePresence === 'prepared') {
    return (
      stateStatus === 'prepared'
      && storesEmpty === false
      && cursorMatch === 'skipped'
      && journalOutcome === 'skipped'
      && crossStoreOutcome === 'skipped'
      && relationship === null
      && reasonCode === null
      && errorLayer === 'none'
    );
  }

  if (statePresence === 'absent') {
    if (stateStatus !== null || cursorMatch !== 'n/a') return false;
    if (storesEmpty === true) {
      // #1 cold empty exact
      return (
        journalOutcome === 'missing'
        && crossStoreOutcome === 'ok'
        && relationship === null
        && reasonCode === null
        && errorLayer === 'none'
      );
    }
    // storesEmpty === false
    if (reasonCode !== null) {
      // #2b typed: relationship null; errorLayer non-none
      return relationship === null && errorLayer !== 'none';
    }
    // #2a receipt success: cross ok; reason null; layer none
    return (
      crossStoreOutcome === 'ok'
      && reasonCode === null
      && errorLayer === 'none'
      && (journalOutcome === 'verified' || journalOutcome === 'missing')
    );
  }

  if (statePresence === 'idle') {
    if (stateStatus !== 'idle' || storesEmpty !== false) return false;

    if (reasonCode !== null) {
      // idle typed: relationship null; errorLayer non-none;
      // must not claim full healthy probes while advertising typed damage
      if (relationship !== null) return false;
      if (errorLayer === 'none') return false;
      if (
        cursorMatch === 'match'
        && journalOutcome === 'verified'
        && crossStoreOutcome === 'ok'
      ) {
        return false;
      }
      return true;
    }

    // reasonCode === null
    if (relationship === 'empty' || relationship === 'uncovered-events') {
      // #12 / #13 exact healthy-probe attention shapes
      return (
        cursorMatch === 'match'
        && journalOutcome === 'verified'
        && crossStoreOutcome === 'ok'
        && errorLayer === 'none'
      );
    }

    if (HEALTHY_RELATIONSHIP.has(relationship)) {
      // #4 healthy candidate full field set (mapper double-checks)
      return (
        cursorMatch === 'match'
        && journalOutcome === 'verified'
        && crossStoreOutcome === 'ok'
        && errorLayer === 'none'
      );
    }

    // other idle anomalies (e.g. unexpected relationship null): layer must be none
    // when reason is null (typed damage always carries reason + non-none layer)
    return errorLayer === 'none';
  }

  return false;
}

/**
 * Build plain frozen report in exact key order; mark as issued (provenance).
 * @param {object} fields
 * @returns {Readonly<object>}
 */
function freezeReport(fields) {
  const report = {
    schemaVersion: 1,
    status: fields.status,
    code: fields.code,
    checkedAt: fields.checkedAt,
    dualWriteState: fields.dualWriteState,
    relationship: fields.relationship,
    recoveryRequired: fields.recoveryRequired,
    alertRequired: fields.status === 'alert',
    nextAction: fields.nextAction,
    reasonCode: fields.reasonCode,
  };
  Object.freeze(report);
  ISSUED_MONITOR_REPORTS.add(report);
  return report;
}

/**
 * Fail-closed integrity-alert for malformed observation (structure only).
 * @param {string} checkedAt
 * @returns {Readonly<object>}
 */
function failClosedMalformedReport(checkedAt) {
  return freezeReport({
    status: 'alert',
    code: 'integrity-alert',
    checkedAt,
    dualWriteState: 'unknown',
    relationship: null,
    recoveryRequired: false,
    nextAction: 'investigate-integrity',
    reasonCode: null,
  });
}

/**
 * Observation → report per design §3.6 truth table.
 * Reads ONLY from readValidFrozenObservationValues map (descriptor values).
 * Never re-reads obs.<field> / obs[...] / Reflect.get after validation —
 * a frozen Proxy with hostile get trap must not escape past the validator.
 * Map accepts only semantic-consistent values; contradictory legal enums
 * fail-closed (integrity-alert / unknown / reason null).
 * @param {object} obs
 * @param {string} checkedAt
 * @returns {Readonly<object>}
 */
function mapObservationToReport(obs, checkedAt) {
  const values = readValidFrozenObservationValues(obs);
  if (values == null) {
    return failClosedMalformedReport(checkedAt);
  }
  // Shape/enum passed but cross-field family violated → fixed malformed report
  if (!observationHasSemanticConsistency(values)) {
    return failClosedMalformedReport(checkedAt);
  }

  const statePresence = values.statePresence;
  const stateStatus = values.stateStatus;
  const storesEmpty = values.storesEmpty;
  const reasonCode = values.reasonCode;
  const relationship = values.relationship;
  const cursorMatch = values.cursorMatch;
  const journalOutcome = values.journalOutcome;
  const crossStoreOutcome = values.crossStoreOutcome;
  const errorLayer = values.errorLayer;

  // #7 / #7b — statePresence io-error (Sio / RootFail)
  if (statePresence === 'io-error') {
    return freezeReport({
      status: 'alert',
      code: 'io-alert',
      checkedAt,
      dualWriteState: 'unknown',
      relationship: null,
      recoveryRequired: false,
      nextAction: 'investigate-integrity',
      reasonCode,
    });
  }

  // #6 — invalid state JSON/schema
  if (statePresence === 'invalid') {
    return freezeReport({
      status: 'alert',
      code: 'integrity-alert',
      checkedAt,
      dualWriteState: 'invalid',
      relationship: null,
      recoveryRequired: false,
      nextAction: 'investigate-integrity',
      reasonCode,
    });
  }

  // #3 — valid prepared
  if (statePresence === 'prepared') {
    return freezeReport({
      status: 'alert',
      code: 'recovery-required',
      checkedAt,
      dualWriteState: 'prepared',
      relationship: null,
      recoveryRequired: true,
      nextAction: 'run-explicit-recovery',
      reasonCode: null,
    });
  }

  // #1 / #2a / #2b — state absent
  if (statePresence === 'absent') {
    // #2b typed reason priority over state-missing
    if (reasonCode !== null) {
      return freezeReport({
        status: 'alert',
        code: conditionFromTypedReason(reasonCode),
        checkedAt,
        dualWriteState: 'missing',
        relationship: null,
        recoveryRequired: false,
        nextAction: 'investigate-integrity',
        reasonCode,
      });
    }
    // #1 cold empty
    if (storesEmpty === true) {
      return freezeReport({
        status: 'alert',
        code: 'uninitialized',
        checkedAt,
        dualWriteState: 'missing',
        relationship: null,
        recoveryRequired: false,
        nextAction: 'initialize-via-production-write',
        reasonCode: null,
      });
    }
    // #2a state-missing + receipt success
    return freezeReport({
      status: 'alert',
      code: 'state-missing',
      checkedAt,
      dualWriteState: 'missing',
      relationship,
      recoveryRequired: false,
      nextAction: 'investigate-integrity',
      reasonCode: null,
    });
  }

  // idle paths
  if (statePresence === 'idle') {
    // Typed reason paths: #5/#8/#9/#10/#11 — relationship null fixed
    if (reasonCode !== null) {
      return freezeReport({
        status: 'alert',
        code: conditionFromTypedReason(reasonCode),
        checkedAt,
        dualWriteState: 'idle',
        relationship: null,
        recoveryRequired: false,
        nextAction: 'investigate-integrity',
        reasonCode,
      });
    }

    // #12 idle + empty
    if (relationship === 'empty') {
      return freezeReport({
        status: 'alert',
        code: 'integrity-alert',
        checkedAt,
        dualWriteState: 'idle',
        relationship: 'empty',
        recoveryRequired: false,
        nextAction: 'investigate-integrity',
        reasonCode: null,
      });
    }

    // #13 idle + uncovered-events
    if (relationship === 'uncovered-events') {
      return freezeReport({
        status: 'alert',
        code: 'integrity-alert',
        checkedAt,
        dualWriteState: 'idle',
        relationship: 'uncovered-events',
        recoveryRequired: false,
        nextAction: 'investigate-integrity',
        reasonCode: null,
      });
    }

    // #4 healthy: full field belt-and-suspenders (semantic gate already required these)
    if (
      stateStatus === 'idle'
      && storesEmpty === false
      && cursorMatch === 'match'
      && journalOutcome === 'verified'
      && crossStoreOutcome === 'ok'
      && HEALTHY_RELATIONSHIP.has(relationship)
      && reasonCode === null
      && errorLayer === 'none'
    ) {
      return freezeReport({
        status: 'healthy',
        code: 'healthy',
        checkedAt,
        dualWriteState: 'idle',
        relationship,
        recoveryRequired: false,
        nextAction: 'none',
        reasonCode: null,
      });
    }

    // idle empty/uncovered already handled; other idle anomalies → integrity-alert
    // keep relationship only if it is a known enum; else null
    const relOut = RELATIONSHIP.has(relationship) ? relationship : null;
    return freezeReport({
      status: 'alert',
      code: 'integrity-alert',
      checkedAt,
      dualWriteState: 'idle',
      relationship: relOut,
      recoveryRequired: false,
      nextAction: 'investigate-integrity',
      reasonCode: null,
    });
  }

  // Unreachable known presence should not happen; fail-closed
  return failClosedMalformedReport(checkedAt);
}

/**
 * Fixed rotation-layer io-alert (WAL/root leaf I/O that is not legacy dual RootFail).
 * @param {string} checkedAt
 * @returns {Readonly<object>}
 */
function freezeRotationIoAlertReport(checkedAt) {
  return freezeReport({
    status: 'alert',
    code: 'io-alert',
    checkedAt,
    dualWriteState: 'unknown',
    relationship: null,
    recoveryRequired: false,
    nextAction: 'investigate-integrity',
    reasonCode: ROTATION_REASON_IO_ERROR,
  });
}

/**
 * Map typed rotation inspector throw → path-free monitor report.
 * Strict fixed code strings only; never copy message/cause/path.
 * Unknown exceptions → existing fail-closed malformed alert.
 *
 * Rotation I/O special-case: consult dual public inspector once to preserve
 * historical RootFail reason (`audit-integrity-dual-write-io-error`) when the
 * data root itself is unusable; otherwise keep rotation I/O reason (e.g. WAL
 * leaf is a directory while root/dual path still works).
 *
 * @param {unknown} error
 * @param {string} checkedAt
 * @param {string} dataDir
 * @returns {Promise<Readonly<object>>}
 */
async function mapRotationInspectorErrorToReport(error, checkedAt, dataDir) {
  let code = null;
  try {
    if (
      error !== null
      && typeof error === 'object'
      && typeof /** @type {{ code?: unknown }} */ (error).code === 'string'
    ) {
      code = /** @type {{ code: string }} */ (error).code;
    }
  } catch {
    return failClosedMalformedReport(checkedAt);
  }

  if (code === ROTATION_REASON_IO_ERROR) {
    try {
      const dualObs = await inspectAuditIntegrityDualWriteReadOnly(dataDir);
      const dualReport = mapObservationToReport(dualObs, checkedAt);
      // Legacy RootFail / dual-root I/O: keep historical dual-write-io-error report.
      if (
        dualReport
        && dualReport.code === 'io-alert'
        && dualReport.reasonCode === DUAL_WRITE_REASON_IO_ERROR
      ) {
        return dualReport;
      }
      // Root/dual usable (or non-io dual alert) — rotation WAL I/O must not be
      // covered by healthy/non-io dual observation.
      return freezeRotationIoAlertReport(checkedAt);
    } catch {
      // Dual inspector throw / unexpected: fail-closed, never leak exception.
      return failClosedMalformedReport(checkedAt);
    }
  }
  if (
    code === ROTATION_REASON_STATE_INVALID
    || code === ROTATION_REASON_CONFLICT
  ) {
    return freezeReport({
      status: 'alert',
      code: 'integrity-alert',
      checkedAt,
      dualWriteState: 'unknown',
      relationship: null,
      recoveryRequired: false,
      nextAction: 'investigate-integrity',
      reasonCode: code,
    });
  }
  return failClosedMalformedReport(checkedAt);
}

/**
 * Run-once read-only audit integrity monitor.
 * Rotation inspector first; dual-write inspector when rotation is absent/completed
 * (or as RootFail classifier after rotation I/O).
 * @param {string} dataDir
 * @param {object} [options]
 * @returns {Promise<Readonly<object>>}
 */
export async function runAuditIntegrityMonitor(dataDir, options = {}) {
  const checkedAt = resolveCheckedAt(options);

  let rotationObs;
  try {
    rotationObs = await inspectAuditIntegrityRotationReadOnly(dataDir);
  } catch (error) {
    return mapRotationInspectorErrorToReport(error, checkedAt, dataDir);
  }

  if (rotationObs && rotationObs.kind === 'recovery-required') {
    return freezeReport({
      status: 'alert',
      code: 'rotation-recovery-required',
      checkedAt,
      dualWriteState:
        typeof rotationObs.dualWriteState === 'string'
          ? rotationObs.dualWriteState
          : 'unknown',
      relationship: null,
      recoveryRequired: true,
      nextAction: 'run-explicit-recovery',
      reasonCode: ROTATION_REASON_RECOVERY_REQUIRED,
    });
  }

  // absent | completed: dual-write path preserves historical mapping.
  // completed latest-archive deep-check already done inside rotation inspector.
  const observation = await inspectAuditIntegrityDualWriteReadOnly(dataDir);
  return mapObservationToReport(observation, checkedAt);
}

/**
 * Cross-field semantic consistency for issued reports.
 * Rejects internal contradictions (e.g. healthy + io-alert).
 * @param {object} v
 * @returns {boolean}
 */
function reportHasSemanticConsistency(v) {
  if (v.status === 'healthy') {
    return (
      v.code === 'healthy'
      && v.alertRequired === false
      && v.dualWriteState === 'idle'
      && v.recoveryRequired === false
      && v.nextAction === 'none'
      && v.reasonCode === null
      && HEALTHY_RELATIONSHIP.has(v.relationship)
    );
  }
  // status === 'alert'
  if (v.code === 'healthy') return false;
  if (v.alertRequired !== true) return false;

  switch (v.code) {
    case 'recovery-required':
      return (
        v.dualWriteState === 'prepared'
        && v.recoveryRequired === true
        && v.nextAction === 'run-explicit-recovery'
        && v.reasonCode === null
        && v.relationship === null
      );
    case 'rotation-recovery-required':
      return (
        v.dualWriteState === 'unknown'
        && v.recoveryRequired === true
        && v.nextAction === 'run-explicit-recovery'
        && v.reasonCode === ROTATION_REASON_RECOVERY_REQUIRED
        && v.relationship === null
      );
    case 'uninitialized':
      return (
        v.dualWriteState === 'missing'
        && v.recoveryRequired === false
        && v.nextAction === 'initialize-via-production-write'
        && v.reasonCode === null
        && v.relationship === null
      );
    case 'state-missing':
      return (
        v.dualWriteState === 'missing'
        && v.recoveryRequired === false
        && v.nextAction === 'investigate-integrity'
        && v.reasonCode === null
      );
    case 'integrity-alert':
    case 'io-alert':
      return (
        v.recoveryRequired === false
        && v.nextAction === 'investigate-integrity'
      );
    default:
      return false;
  }
}
/**
 * Validate issued frozen report. Provenance gate runs before any reflection
 * so hostile Proxy / forged frozen objects never fire traps on format/exit.
 * @param {unknown} report
 * @returns {object|null} plain values map or null if invalid
 */
function readValidFrozenReportValues(report) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    return null;
  }
  // Provenance first — WeakSet.has does not trigger Proxy traps
  if (!ISSUED_MONITOR_REPORTS.has(report)) {
    return null;
  }

  try {
    if (!Object.isFrozen(report)) return null;

    const keys = Object.keys(report);
    if (keys.length !== REPORT_KEYS.length) return null;
    for (let i = 0; i < REPORT_KEYS.length; i += 1) {
      if (keys[i] !== REPORT_KEYS[i]) return null;
    }

    const values = Object.create(null);
    for (const key of REPORT_KEYS) {
      const d = Object.getOwnPropertyDescriptor(report, key);
      if (d == null) return null;
      if (!Object.prototype.hasOwnProperty.call(d, 'value')) return null;
      if (d.get !== undefined || d.set !== undefined) return null;
      values[key] = d.value;
    }

    if (values.schemaVersion !== 1) return null;
    if (!STATUS_SET.has(values.status)) return null;
    if (!CONDITION_CODE_SET.has(values.code)) return null;
    if (typeof values.checkedAt !== 'string' || !CHECKED_AT_RE.test(values.checkedAt)) {
      return null;
    }
    try {
      if (new Date(values.checkedAt).toISOString() !== values.checkedAt) return null;
    } catch {
      return null;
    }
    if (!DUAL_WRITE_STATE_SET.has(values.dualWriteState)) return null;
    if (!RELATIONSHIP.has(values.relationship)) return null;
    if (typeof values.recoveryRequired !== 'boolean') return null;
    if (typeof values.alertRequired !== 'boolean') return null;
    if (values.alertRequired !== (values.status === 'alert')) return null;
    if (!NEXT_ACTION_SET.has(values.nextAction)) return null;
    if (values.reasonCode !== null && typeof values.reasonCode !== 'string') return null;
    if (!reportHasSemanticConsistency(values)) return null;
    return values;
  } catch {
    // Issued object that still throws on reflection → fixed fail-closed null
    return null;
  }
}

/**
 * @param {Readonly<object>} report
 * @returns {0|2}
 */
export function auditIntegrityMonitorExitCode(report) {
  const values = readValidFrozenReportValues(report);
  if (values == null) {
    throw new TypeError(MISUSE_TYPE_ERROR);
  }
  if (values.status === 'healthy') return 0;
  if (values.status === 'alert') return 2;
  throw new TypeError(MISUSE_TYPE_ERROR);
}

/**
 * Compact single-line JSON + trailing newline. Frozen exact report only.
 * @param {Readonly<object>} report
 * @returns {string}
 */
export function formatAuditIntegrityMonitorReportJson(report) {
  const values = readValidFrozenReportValues(report);
  if (values == null) {
    throw new TypeError(MISUSE_TYPE_ERROR);
  }
  // Rebuild plain object in exact key order from validated descriptors only
  const plain = {
    schemaVersion: values.schemaVersion,
    status: values.status,
    code: values.code,
    checkedAt: values.checkedAt,
    dualWriteState: values.dualWriteState,
    relationship: values.relationship,
    recoveryRequired: values.recoveryRequired,
    alertRequired: values.alertRequired,
    nextAction: values.nextAction,
    reasonCode: values.reasonCode,
  };
  return `${JSON.stringify(plain)}\n`;
}
