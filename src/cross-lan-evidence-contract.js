/**
 * Cross-LAN evidence pure contract (T1.15 M1 only).
 *
 * --- honesty (Gold ADR §7.2.1 / §7.2.2) ---
 * [status] T1.0 Noise library gate = BLOCKED (not M1 crypto PASS)
 * [scope] T1.15 M1 constants / minimum-shape / pure decisions —
 *   CROSS_LAN_EVIDENCE_SCHEMA,
 *   CROSS_LAN_EVIDENCE_RETENTION_POLICY,
 *   CROSS_LAN_EVIDENCE_REPORT_BUDGET_POLICY,
 *   matchesCrossLanEvidenceShape,
 *   doesCrossLanEvidenceSatisfyM5RealGate,
 *   classifyCrossLanExternalArtifactState,
 *   resolveCrossLanEvidenceDegradedImpact,
 *   calculateCrossLanEvidenceMaxRepoReportBytes
 * [coverage] T1.15 M1 contract coverage = COMPLETE (contract task only)
 * [not ready] Real M5/M6/M7 harness = NOT IMPLEMENTED
 *   Gold evidence I/O / file write-delete / scorecard mutation = NOT IMPLEMENTED
 *   filename matcher / retention date arithmetic = NOT IMPLEMENTED
 *   secret-value scanning = NOT IMPLEMENTED (extras are a compatibility policy only)
 *
 * This module does **not** read git, files, external artifacts, digests, or
 * the network. It does **not** prove real evidence or Gold readiness.
 */

import { ERROR_CODES } from './error-codes.js';

/** @type {ReadonlyArray<string>} */
const RELAY_TYPES = Object.freeze([
  'mock',
  'operator-managed-test',
  'user-managed',
]);

/** @type {ReadonlyArray<string>} */
const M5_REAL_RELAY_TYPES = Object.freeze(
  RELAY_TYPES.filter((t) => t !== 'mock'),
);

/** @type {ReadonlyArray<string>} */
const PROXY_ERROR_CODES = Object.freeze([
  ERROR_CODES.PROXY_AUTH_FAILED,
  ERROR_CODES.PROXY_CONNECT_FAILED,
  ERROR_CODES.PROXY_UNSUPPORTED_AUTH,
  ERROR_CODES.PROXY_PAC_UNSUPPORTED,
  ERROR_CODES.PROXY_CHAIN_UNSUPPORTED,
  ERROR_CODES.RELAY_TLS_PIN_MISMATCH,
  ERROR_CODES.PROXY_TLS_INTERCEPTED,
]);

/** @type {ReadonlyArray<string>} */
const ARTIFACT_ERROR_CODES = Object.freeze([
  ERROR_CODES.EVIDENCE_ARTIFACT_MISSING,
  ERROR_CODES.EVIDENCE_ARTIFACT_DIGEST_MISMATCH,
]);

/**
 * Frozen cross-lan-evidence/v1 schema constants (26 keys).
 *
 * @type {Readonly<Record<string, unknown>>}
 */
export const CROSS_LAN_EVIDENCE_SCHEMA = Object.freeze({
  identifier: 'cross-lan-evidence/v1',
  requiredTopLevelFields: Object.freeze([
    'schemaVersion',
    'sourceCommit',
    'commandId',
    'startedAtUtc',
    'finishedAtUtc',
    'topology',
    'relayForced',
    'relayType',
    'relayDeployment',
    'reachabilityResult',
    'framing',
    'proxyResult',
    'firewallResult',
    'env',
    'cells',
    'faultInjection',
    'overall',
  ]),
  natTypes: Object.freeze([
    'full-cone',
    'address-restricted',
    'port-restricted',
    'symmetric',
    'unknown',
    'unknown-documented',
  ]),
  roles: Object.freeze(['endpoint', 'controller']),
  relayTypes: RELAY_TYPES,
  m5RealRelayTypes: M5_REAL_RELAY_TYPES,
  relayDeploymentKinds: Object.freeze([
    'operator-managed-test',
    'user-managed',
  ]),
  reachabilityStatuses: Object.freeze(['pass', 'fail']),
  diagnosticStatuses: Object.freeze(['pass', 'fail', 'not-applicable']),
  cellStatuses: Object.freeze([
    'PASS',
    'FAIL',
    'BLOCKED',
    'SKIP',
    'EVIDENCE-DEGRADED',
  ]),
  proxyErrorCodes: PROXY_ERROR_CODES,
  artifactErrorCodes: ARTIFACT_ERROR_CODES,
  productionFraming: 'wss-tls1.3-tcp443',
  topologyRequiredFields: Object.freeze([
    'sideA',
    'sideB',
    'independentNatDomains',
  ]),
  topologySideRequiredFields: Object.freeze(['natType', 'role']),
  relayDeploymentRequiredFields: Object.freeze(['kind', 'publicListener']),
  reachabilityRequiredFields: Object.freeze(['status']),
  diagnosticResultRequiredFields: Object.freeze(['status']),
  envRequiredFields: Object.freeze([
    'osA',
    'osB',
    'nodeVersion',
    'appCommit',
  ]),
  cellRequiredFields: Object.freeze(['id', 'status', 'errorCode']),
  faultInjectionSchemaStatus: 'open-enum-shape-not-wire-frozen',
  overallEnumStatus: 'not-enumerated-by-spec',
  nestedFieldsPolicy:
    'required-minimum-extra-string-data-fields-allowed',
  sourceCommitFormatPolicy:
    'nonempty-string-equality-only-no-hash-algorithm-frozen',
  timestampFormatPolicy: 'nonempty-string-no-regex-in-m1',
  implementationStage: 'T1.15-M1-contract-only',
});

/**
 * Frozen retention policy (18 keys). Date arithmetic and filename matcher
 * intentionally not implemented at M1.
 *
 * @type {Readonly<Record<string, unknown>>}
 */
export const CROSS_LAN_EVIDENCE_RETENTION_POLICY = Object.freeze({
  noOverwrite: true,
  newArtifactPerRun: true,
  filenameTemplate: 'YYYY-MM-DD-<sourceCommitPrefix>-<evidence-kind>.<ext>',
  repoReportAndDigestNeverOverwrite: true,
  repoHistoryImmutable: true,
  forcePushCleanupAllowed: false,
  worktreeMinimumRetentionMonths: 36,
  nextMajorGoldAdditionalRetentionMonths: 12,
  retentionDeadlineRule:
    'max-of-36months-or-next-major-gold-plus-12-take-later',
  externalMinimumRetentionMonths: 36,
  externalArtifactDigestRequired: true,
  externalArtifactHandlePolicy: 'non-secret',
  m7PriorEvidencePolicy: 'append-only-no-delete',
  purgeApprovalRequired: true,
  purgeAuditEvent: 'evidence-retention-purge-approved',
  dateArithmeticImplemented: false,
  filenameMatcherImplemented: false,
  implementationStage: 'T1.15-M1-policy-frozen-no-arithmetic',
});

/**
 * Frozen repo report budget formula constants (9 keys).
 *
 * @type {Readonly<Record<string, unknown>>}
 */
export const CROSS_LAN_EVIDENCE_REPORT_BUDGET_POLICY = Object.freeze({
  baseBytes: 32768,
  perCellBytes: 4096,
  perSchemaObjectBytes: 8192,
  hardCeilingBytes: 524288,
  minimumSchemaObjectCount: 8,
  minimumSchemaObjectFields: Object.freeze([
    'topology',
    'proxyResult',
    'firewallResult',
    'relayDeployment',
    'reachabilityResult',
    'env',
    'faultInjection',
    'overall',
  ]),
  scope: 'repo-redacted-summary-only',
  fieldDeletionToShrinkForbidden: true,
  implementationStage: 'T1.15-M1-budget-formula-only',
});

// ---------------------------------------------------------------------------
// private helpers — plain records / dense arrays / required-min
// Descriptor snapshot semantics: one getOwnPropertyDescriptor per own key
// per record (or dense index) when building a call-local snapshot. M5 and
// shape decisions consume that snapshot only — never re-read caller objects
// through ordinary property access after validation.
// ---------------------------------------------------------------------------

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isPlainRecord(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Own string enumerable data fields only (no symbols, non-enumerable, or
 * accessors). Single getOwnPropertyDescriptor per key. Returns map or null.
 * Does not recurse into field values.
 *
 * @param {object} record
 * @returns {Record<string, unknown> | null}
 */
function readOwnStringDataFields(record) {
  const ownKeys = Reflect.ownKeys(record);
  /** @type {Record<string, unknown>} */
  const out = Object.create(null);
  for (const key of ownKeys) {
    if (typeof key === 'symbol') return null;
    const desc = Object.getOwnPropertyDescriptor(record, key);
    if (!desc || desc.enumerable !== true) return null;
    if (desc.get !== undefined || desc.set !== undefined) return null;
    out[key] = desc.value;
  }
  return out;
}

/**
 * Required-minimum plain record: all required keys present; extras allowed
 * only as string enumerable data fields. Returns values map or null.
 * Does not recurse into extra field values.
 *
 * @param {unknown} value
 * @param {readonly string[]} requiredKeys
 * @returns {Record<string, unknown> | null}
 */
function readRequiredMinRecord(value, requiredKeys) {
  try {
    if (!isPlainRecord(value)) return null;
    const fields = readOwnStringDataFields(value);
    if (fields === null) return null;
    for (const k of requiredKeys) {
      if (!Object.hasOwn(fields, k)) return null;
    }
    return fields;
  } catch {
    return null;
  }
}

/**
 * Exact plain record: only the listed keys, all string enumerable data.
 *
 * @param {unknown} value
 * @param {readonly string[]} expectedKeys
 * @returns {Record<string, unknown> | null}
 */
function readExactRecord(value, expectedKeys) {
  try {
    if (!isPlainRecord(value)) return null;
    const fields = readOwnStringDataFields(value);
    if (fields === null) return null;
    const keys = Object.keys(fields);
    if (keys.length !== expectedKeys.length) return null;
    /** @type {Set<string>} */
    const expected = new Set(expectedKeys);
    for (const key of keys) {
      if (!expected.has(key)) return null;
    }
    for (const k of expectedKeys) {
      if (!Object.hasOwn(fields, k)) return null;
    }
    return fields;
  } catch {
    return null;
  }
}

/**
 * Dense array snapshot from own data descriptors only. Own keys must be
 * exactly `0..length-1` + `length` (length taken from its own data
 * descriptor, not ordinary get). Each index is a string enumerable data
 * property. Returns the descriptor values array or null.
 *
 * @param {unknown} value
 * @returns {unknown[] | null}
 */
function readDenseArrayDescriptorValues(value) {
  try {
    if (!Array.isArray(value)) return null;
    const lengthDesc = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      !lengthDesc ||
      lengthDesc.get !== undefined ||
      lengthDesc.set !== undefined
    ) {
      return null;
    }
    const length = lengthDesc.value;
    if (
      typeof length !== 'number' ||
      !Number.isInteger(length) ||
      length < 0
    ) {
      return null;
    }
    const keys = Reflect.ownKeys(value);
    /** @type {string[]} */
    const expected = [];
    for (let i = 0; i < length; i += 1) expected.push(String(i));
    expected.push('length');
    if (keys.length !== expected.length) return null;
    for (let i = 0; i < expected.length; i += 1) {
      if (keys[i] !== expected[i]) return null;
    }
    /** @type {unknown[]} */
    const out = [];
    for (let i = 0; i < length; i += 1) {
      const desc = Object.getOwnPropertyDescriptor(value, String(i));
      if (!desc || desc.enumerable !== true) return null;
      if (desc.get !== undefined || desc.set !== undefined) return null;
      out.push(desc.value);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @returns {boolean}
 */
function isClosedString(value, allowed) {
  return typeof value === 'string' && allowed.includes(value);
}

// ---------------------------------------------------------------------------
// nested snapshot parsers (schema-relevant fields only)
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   natType: string,
 *   role: string,
 * }} TopologySideSnapshot
 *
 * @typedef {{
 *   sideA: TopologySideSnapshot,
 *   sideB: TopologySideSnapshot,
 *   independentNatDomains: boolean,
 * }} TopologySnapshot
 *
 * @typedef {{
 *   kind: string,
 *   publicListener: boolean,
 * }} RelayDeploymentSnapshot
 *
 * @typedef {{
 *   status: string,
 * }} ReachabilitySnapshot
 *
 * @typedef {{
 *   status: string,
 * }} DiagnosticSnapshot
 *
 * @typedef {{
 *   osA: string,
 *   osB: string,
 *   nodeVersion: string,
 *   appCommit: string,
 * }} EnvSnapshot
 *
 * @typedef {{
 *   id: string,
 *   status: string,
 *   errorCode: null | string,
 * }} CellSnapshot
 *
 * @typedef {{
 *   schemaVersion: string,
 *   sourceCommit: string,
 *   commandId: string,
 *   startedAtUtc: string,
 *   finishedAtUtc: string,
 *   topology: TopologySnapshot,
 *   relayForced: boolean,
 *   relayType: string,
 *   relayDeployment: RelayDeploymentSnapshot,
 *   reachabilityResult: ReachabilitySnapshot,
 *   framing: string,
 *   proxyResult: DiagnosticSnapshot,
 *   firewallResult: DiagnosticSnapshot,
 *   env: EnvSnapshot,
 *   cells: CellSnapshot[],
 *   overall: string,
 * }} EvidenceSnapshot
 */

/**
 * @param {unknown} side
 * @returns {TopologySideSnapshot | null}
 */
function parseTopologySide(side) {
  const rec = readRequiredMinRecord(
    side,
    CROSS_LAN_EVIDENCE_SCHEMA.topologySideRequiredFields,
  );
  if (rec === null) return null;
  if (!isClosedString(rec.natType, CROSS_LAN_EVIDENCE_SCHEMA.natTypes)) {
    return null;
  }
  if (!isClosedString(rec.role, CROSS_LAN_EVIDENCE_SCHEMA.roles)) {
    return null;
  }
  return {
    natType: /** @type {string} */ (rec.natType),
    role: /** @type {string} */ (rec.role),
  };
}

/**
 * @param {unknown} topology
 * @returns {TopologySnapshot | null}
 */
function parseTopology(topology) {
  const rec = readRequiredMinRecord(
    topology,
    CROSS_LAN_EVIDENCE_SCHEMA.topologyRequiredFields,
  );
  if (rec === null) return null;
  const sideA = parseTopologySide(rec.sideA);
  if (sideA === null) return null;
  const sideB = parseTopologySide(rec.sideB);
  if (sideB === null) return null;
  if (typeof rec.independentNatDomains !== 'boolean') return null;
  return {
    sideA,
    sideB,
    independentNatDomains: rec.independentNatDomains,
  };
}

/**
 * @param {unknown} deployment
 * @returns {RelayDeploymentSnapshot | null}
 */
function parseRelayDeployment(deployment) {
  const rec = readRequiredMinRecord(
    deployment,
    CROSS_LAN_EVIDENCE_SCHEMA.relayDeploymentRequiredFields,
  );
  if (rec === null) return null;
  if (
    !isClosedString(rec.kind, CROSS_LAN_EVIDENCE_SCHEMA.relayDeploymentKinds)
  ) {
    return null;
  }
  if (typeof rec.publicListener !== 'boolean') return null;
  if (Object.hasOwn(rec, 'notesBucket')) {
    if (!isNonemptyString(rec.notesBucket)) return null;
  }
  return {
    kind: /** @type {string} */ (rec.kind),
    publicListener: rec.publicListener,
  };
}

/**
 * @param {unknown} reachability
 * @returns {ReachabilitySnapshot | null}
 */
function parseReachability(reachability) {
  const rec = readRequiredMinRecord(
    reachability,
    CROSS_LAN_EVIDENCE_SCHEMA.reachabilityRequiredFields,
  );
  if (rec === null) return null;
  if (
    !isClosedString(
      rec.status,
      CROSS_LAN_EVIDENCE_SCHEMA.reachabilityStatuses,
    )
  ) {
    return null;
  }
  if (Object.hasOwn(rec, 'tcp443') && typeof rec.tcp443 !== 'boolean') {
    return null;
  }
  if (Object.hasOwn(rec, 'wss') && typeof rec.wss !== 'boolean') {
    return null;
  }
  for (const bucket of ['dnsBucket', 'tlsBucket', 'pinBucket']) {
    if (Object.hasOwn(rec, bucket) && !isNonemptyString(rec[bucket])) {
      return null;
    }
  }
  if (Object.hasOwn(rec, 'errorCode')) {
    const code = rec.errorCode;
    if (code !== null && typeof code !== 'string') return null;
  }
  return {
    status: /** @type {string} */ (rec.status),
  };
}

/**
 * @param {unknown} result
 * @param {boolean} enforceProxyAllowlist
 * @returns {DiagnosticSnapshot | null}
 */
function parseDiagnosticResult(result, enforceProxyAllowlist) {
  const rec = readRequiredMinRecord(
    result,
    CROSS_LAN_EVIDENCE_SCHEMA.diagnosticResultRequiredFields,
  );
  if (rec === null) return null;
  if (
    !isClosedString(rec.status, CROSS_LAN_EVIDENCE_SCHEMA.diagnosticStatuses)
  ) {
    return null;
  }
  if (Object.hasOwn(rec, 'errorCode')) {
    const code = rec.errorCode;
    if (code !== null && typeof code !== 'string') return null;
    if (
      enforceProxyAllowlist &&
      code !== null &&
      !CROSS_LAN_EVIDENCE_SCHEMA.proxyErrorCodes.includes(code)
    ) {
      return null;
    }
  }
  return {
    status: /** @type {string} */ (rec.status),
  };
}

/**
 * @param {unknown} env
 * @param {string} expectedCommit
 * @returns {EnvSnapshot | null}
 */
function parseEnv(env, expectedCommit) {
  const rec = readRequiredMinRecord(
    env,
    CROSS_LAN_EVIDENCE_SCHEMA.envRequiredFields,
  );
  if (rec === null) return null;
  if (!isNonemptyString(rec.osA)) return null;
  if (!isNonemptyString(rec.osB)) return null;
  if (!isNonemptyString(rec.nodeVersion)) return null;
  if (!isNonemptyString(rec.appCommit)) return null;
  if (rec.appCommit !== expectedCommit) return null;
  return {
    osA: /** @type {string} */ (rec.osA),
    osB: /** @type {string} */ (rec.osB),
    nodeVersion: /** @type {string} */ (rec.nodeVersion),
    appCommit: /** @type {string} */ (rec.appCommit),
  };
}

/**
 * @param {unknown} cell
 * @returns {CellSnapshot | null}
 */
function parseCell(cell) {
  const rec = readRequiredMinRecord(
    cell,
    CROSS_LAN_EVIDENCE_SCHEMA.cellRequiredFields,
  );
  if (rec === null) return null;
  if (!isNonemptyString(rec.id)) return null;
  if (!isClosedString(rec.status, CROSS_LAN_EVIDENCE_SCHEMA.cellStatuses)) {
    return null;
  }
  const code = rec.errorCode;
  if (rec.status === 'PASS') {
    if (code !== null) return null;
  } else if (rec.status === 'EVIDENCE-DEGRADED') {
    if (
      typeof code !== 'string' ||
      !CROSS_LAN_EVIDENCE_SCHEMA.artifactErrorCodes.includes(code)
    ) {
      return null;
    }
  } else {
    // FAIL / BLOCKED / SKIP
    if (code !== null && typeof code !== 'string') return null;
  }
  return {
    id: /** @type {string} */ (rec.id),
    status: /** @type {string} */ (rec.status),
    errorCode:
      code === null || typeof code === 'string'
        ? /** @type {null | string} */ (code)
        : null,
  };
}

/**
 * @param {unknown} cells
 * @returns {CellSnapshot[] | null}
 */
function parseCells(cells) {
  const items = readDenseArrayDescriptorValues(cells);
  if (items === null) return null;
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {CellSnapshot[]} */
  const out = [];
  for (const cell of items) {
    const parsed = parseCell(cell);
    if (parsed === null) return null;
    if (seen.has(parsed.id)) return null;
    seen.add(parsed.id);
    out.push(parsed);
  }
  return out;
}

/**
 * Open plain record: string enumerable data props only; no required keys;
 * values not recursively typed. Snapshot only validates; extras ignored.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function matchesFaultInjection(value) {
  try {
    if (!isPlainRecord(value)) return false;
    const fields = readOwnStringDataFields(value);
    return fields !== null;
  } catch {
    return false;
  }
}

/**
 * Core evidence document: one descriptor snapshot per call. Returns a plain
 * schema-relevant snapshot or null. Nested extras are validated as allowed
 * by required-min but not copied (except notesBucket/errorCode presence
 * checks during parse).
 *
 * @param {unknown} evidenceDoc
 * @param {string} expectedSourceCommit
 * @returns {EvidenceSnapshot | null}
 */
function parseEvidenceDocument(evidenceDoc, expectedSourceCommit) {
  const top = readRequiredMinRecord(
    evidenceDoc,
    CROSS_LAN_EVIDENCE_SCHEMA.requiredTopLevelFields,
  );
  if (top === null) return null;

  if (top.schemaVersion !== CROSS_LAN_EVIDENCE_SCHEMA.identifier) {
    return null;
  }
  if (!isNonemptyString(top.sourceCommit)) return null;
  if (top.sourceCommit !== expectedSourceCommit) return null;
  if (!isNonemptyString(top.commandId)) return null;
  if (!isNonemptyString(top.startedAtUtc)) return null;
  if (!isNonemptyString(top.finishedAtUtc)) return null;

  const topology = parseTopology(top.topology);
  if (topology === null) return null;
  if (typeof top.relayForced !== 'boolean') return null;
  if (!isClosedString(top.relayType, CROSS_LAN_EVIDENCE_SCHEMA.relayTypes)) {
    return null;
  }
  const relayDeployment = parseRelayDeployment(top.relayDeployment);
  if (relayDeployment === null) return null;
  const reachabilityResult = parseReachability(top.reachabilityResult);
  if (reachabilityResult === null) return null;
  if (top.framing !== CROSS_LAN_EVIDENCE_SCHEMA.productionFraming) {
    return null;
  }
  const proxyResult = parseDiagnosticResult(top.proxyResult, true);
  if (proxyResult === null) return null;
  const firewallResult = parseDiagnosticResult(top.firewallResult, false);
  if (firewallResult === null) return null;
  const env = parseEnv(top.env, expectedSourceCommit);
  if (env === null) return null;
  const cells = parseCells(top.cells);
  if (cells === null) return null;
  if (!matchesFaultInjection(top.faultInjection)) return null;
  if (!isNonemptyString(top.overall)) return null;

  return {
    schemaVersion: /** @type {string} */ (top.schemaVersion),
    sourceCommit: /** @type {string} */ (top.sourceCommit),
    commandId: /** @type {string} */ (top.commandId),
    startedAtUtc: /** @type {string} */ (top.startedAtUtc),
    finishedAtUtc: /** @type {string} */ (top.finishedAtUtc),
    topology,
    relayForced: top.relayForced,
    relayType: /** @type {string} */ (top.relayType),
    relayDeployment,
    reachabilityResult,
    framing: /** @type {string} */ (top.framing),
    proxyResult,
    firewallResult,
    env,
    cells,
    overall: /** @type {string} */ (top.overall),
  };
}

/**
 * Shape-only validator. Input exact `{evidence, expectedSourceCommit}`.
 * Boolean / no-throw. Does not scan secret values or bind git hash algorithms.
 *
 * @param {unknown} input
 * @returns {boolean}
 */
export function matchesCrossLanEvidenceShape(input) {
  try {
    const env = readExactRecord(input, [
      'evidence',
      'expectedSourceCommit',
    ]);
    if (env === null) return false;
    if (!isNonemptyString(env.expectedSourceCommit)) return false;
    return (
      parseEvidenceDocument(
        env.evidence,
        /** @type {string} */ (env.expectedSourceCommit),
      ) !== null
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// M5 real gate
// ---------------------------------------------------------------------------

/**
 * Snapshot requiredCellIds from own data descriptors only (dense array,
 * nonempty unique strings). Does not use ordinary index get after structure
 * validation.
 *
 * @param {unknown} ids
 * @returns {string[] | null}
 */
function readRequiredCellIds(ids) {
  const items = readDenseArrayDescriptorValues(ids);
  if (items === null) return null;
  if (items.length === 0) return null;
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const id of items) {
    if (!isNonemptyString(id)) return null;
    if (seen.has(id)) return null;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * M5 real-path pure gate. Builds one descriptor snapshot for the evidence
 * document and one for requiredCellIds; all M5 decisions use those plain
 * snapshots only (no ordinary re-read of caller evidence / nested records /
 * cells / requiredCellIds). Does not read overall; does not require
 * proxy/firewall pass. Each requiredCellId must uniquely exist and PASS.
 *
 * @param {unknown} input
 * @returns {boolean}
 */
export function doesCrossLanEvidenceSatisfyM5RealGate(input) {
  try {
    const env = readExactRecord(input, [
      'evidence',
      'expectedSourceCommit',
      'requiredCellIds',
    ]);
    if (env === null) return false;
    if (!isNonemptyString(env.expectedSourceCommit)) return false;

    // Single evidence snapshot for this call — shape + M5 share it.
    const doc = parseEvidenceDocument(
      env.evidence,
      /** @type {string} */ (env.expectedSourceCommit),
    );
    if (doc === null) return false;

    const requiredCellIds = readRequiredCellIds(env.requiredCellIds);
    if (requiredCellIds === null) return false;

    const relayType = doc.relayType;
    if (
      !isClosedString(relayType, CROSS_LAN_EVIDENCE_SCHEMA.m5RealRelayTypes)
    ) {
      return false;
    }
    if (relayType !== doc.relayDeployment.kind) return false;
    if (doc.relayDeployment.publicListener !== true) return false;
    if (doc.relayForced !== true) return false;

    if (doc.topology.independentNatDomains !== true) return false;
    const roles = new Set([doc.topology.sideA.role, doc.topology.sideB.role]);
    if (roles.size !== 2) return false;
    if (!roles.has('endpoint') || !roles.has('controller')) return false;

    if (doc.reachabilityResult.status !== 'pass') return false;
    if (doc.framing !== CROSS_LAN_EVIDENCE_SCHEMA.productionFraming) {
      return false;
    }

    if (doc.cells.length === 0) return false;

    /** @type {Map<string, string>} */
    const byId = new Map();
    for (const cell of doc.cells) {
      if (byId.has(cell.id)) return false;
      byId.set(cell.id, cell.status);
    }

    for (const requiredId of requiredCellIds) {
      if (!byId.has(requiredId)) return false;
      if (byId.get(requiredId) !== 'PASS') return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// external artifact degraded classification
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   ok: boolean,
 *   cellStatus: null | 'EVIDENCE-DEGRADED',
 *   errorCode: null | string,
 * }} fields
 */
function freezeArtifactDecision(fields) {
  return Object.freeze({
    ok: fields.ok,
    cellStatus: fields.cellStatus,
    errorCode: fields.errorCode,
  });
}

const ARTIFACT_INVALID = freezeArtifactDecision({
  ok: false,
  cellStatus: null,
  errorCode: null,
});

/**
 * Pure external-artifact state classifier. Missing has priority over digest
 * issues. Invalid input → ok:false / null / null (no invented wire status).
 *
 * @param {unknown} input
 * @returns {Readonly<{
 *   ok: boolean,
 *   cellStatus: null | 'EVIDENCE-DEGRADED',
 *   errorCode: null | string,
 * }>}
 */
export function classifyCrossLanExternalArtifactState(input) {
  try {
    const rec = readExactRecord(input, ['artifactState', 'digestState']);
    if (rec === null) return ARTIFACT_INVALID;

    const artifactState = rec.artifactState;
    const digestState = rec.digestState;
    if (
      artifactState !== 'available' &&
      artifactState !== 'missing'
    ) {
      return ARTIFACT_INVALID;
    }
    if (
      digestState !== 'match' &&
      digestState !== 'mismatch' &&
      digestState !== 'unverifiable'
    ) {
      return ARTIFACT_INVALID;
    }

    if (artifactState === 'missing') {
      return freezeArtifactDecision({
        ok: true,
        cellStatus: 'EVIDENCE-DEGRADED',
        errorCode: ERROR_CODES.EVIDENCE_ARTIFACT_MISSING,
      });
    }

    // available
    if (digestState === 'match') {
      return freezeArtifactDecision({
        ok: true,
        cellStatus: null,
        errorCode: null,
      });
    }
    return freezeArtifactDecision({
      ok: true,
      cellStatus: 'EVIDENCE-DEGRADED',
      errorCode: ERROR_CODES.EVIDENCE_ARTIFACT_DIGEST_MISMATCH,
    });
  } catch {
    return ARTIFACT_INVALID;
  }
}

// ---------------------------------------------------------------------------
// degraded impact on Gold gate
// ---------------------------------------------------------------------------

/**
 * Pure degraded-impact resolver. Returns only:
 * `ready-unaffected` | `partial` | `blocked`.
 *
 * @param {unknown} input
 * @returns {'ready-unaffected' | 'partial' | 'blocked'}
 */
export function resolveCrossLanEvidenceDegradedImpact(input) {
  try {
    const rec = readExactRecord(input, [
      'cellStatus',
      'isGoldRequired',
      'hasAlternativeRealEvidence',
    ]);
    if (rec === null) return 'blocked';
    if (typeof rec.isGoldRequired !== 'boolean') return 'blocked';
    if (typeof rec.hasAlternativeRealEvidence !== 'boolean') return 'blocked';
    if (
      !isClosedString(rec.cellStatus, CROSS_LAN_EVIDENCE_SCHEMA.cellStatuses)
    ) {
      return 'blocked';
    }

    if (rec.isGoldRequired === false) return 'ready-unaffected';
    if (rec.cellStatus === 'PASS') return 'ready-unaffected';
    if (rec.cellStatus === 'EVIDENCE-DEGRADED') {
      return rec.hasAlternativeRealEvidence === true ? 'partial' : 'blocked';
    }
    // FAIL / BLOCKED / SKIP
    return 'blocked';
  } catch {
    return 'blocked';
  }
}

// ---------------------------------------------------------------------------
// report budget formula
// ---------------------------------------------------------------------------

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isNonnegSafeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * `maxRepoReportBytes = min(hardCeiling, base + perCell×cells + perObj×effectiveObjects)`
 * with `effectiveObjects = max(schemaObjectCount, minimumSchemaObjectCount)`.
 * Overflow-safe early ceiling when cellCount≥128 or effectiveObjects≥64.
 *
 * @param {unknown} input
 * @returns {number | null}
 */
export function calculateCrossLanEvidenceMaxRepoReportBytes(input) {
  try {
    const rec = readExactRecord(input, ['cellCount', 'schemaObjectCount']);
    if (rec === null) return null;
    if (!isNonnegSafeInt(rec.cellCount)) return null;
    if (!isNonnegSafeInt(rec.schemaObjectCount)) return null;

    const policy = CROSS_LAN_EVIDENCE_REPORT_BUDGET_POLICY;
    const cellCount = /** @type {number} */ (rec.cellCount);
    const schemaObjectCount = /** @type {number} */ (rec.schemaObjectCount);
    const effectiveObjects = Math.max(
      schemaObjectCount,
      /** @type {number} */ (policy.minimumSchemaObjectCount),
    );

    if (cellCount >= 128 || effectiveObjects >= 64) {
      return /** @type {number} */ (policy.hardCeilingBytes);
    }

    const raw =
      /** @type {number} */ (policy.baseBytes) +
      /** @type {number} */ (policy.perCellBytes) * cellCount +
      /** @type {number} */ (policy.perSchemaObjectBytes) * effectiveObjects;

    if (!Number.isFinite(raw) || Number.isNaN(raw)) {
      return /** @type {number} */ (policy.hardCeilingBytes);
    }
    return Math.min(/** @type {number} */ (policy.hardCeilingBytes), raw);
  } catch {
    return null;
  }
}
