/**
 * Linke V1.46 Task 4 测试专用确定性 harness（仅测试代码）。
 * 只拥有 in-memory/temp-root 合成 fake；不 import/调用 production runner、真实 launchctl、
 * 真实 ~/Library/LaunchAgents。闭合 simple/structured 事件词汇外一律 fail-closed。
 */

import { createHash } from 'node:crypto';
import {
  LAUNCHAGENT_LIFECYCLE,
  LAUNCHAGENT_LIFECYCLE_CODES,
  LaunchAgentLifecycleError,
  validateLaunchAgentAnchor,
  validateLaunchAgentJournal,
  validateLaunchAgentManifest,
  validateLaunchAgentManualRepairAttestation,
  validateLaunchAgentReceipt,
  validateLaunchAgentTransactionCloseout,
  validateLaunchAgentTransactionPrefix,
} from '../../src/launchagent-lifecycle/contracts.js';
import { validateLaunchctlRequest } from '../../src/launchagent-lifecycle/host-adapter.js';

const SIMPLE_EVENTS = Object.freeze([
  'inspect', 'lock-acquire', 'journal', 'anchor',
  'publish-controller', 'publish-scheduler', 'publish-manifest',
  'inspect-job-controller', 'inspect-job-scheduler',
  'verify-job-controller', 'verify-job-scheduler',
  'bootout-scheduler', 'bootout-controller',
  'bootstrap-controller', 'health-controller', 'bootstrap-scheduler',
  'verify-scheduler-outcome',
  'remove-scheduler', 'remove-controller', 'remove-manifest',
  'mir-lock-publish', 'mir-lock-verify',
  'mir-transaction-lock-release', 'mir-lock-release',
  'receipt', 'lock-release',
  'recovery-lock-seam',
  // Task 6B.1 Task 5：authorized entry / attestation / recovery-lock acquisition
  'authority-consumed',
  'attestation-file-sync',
  'attestation-directory-sync',
  'attestation-verify',
  'owner-observe-1',
  'owner-observe-2',
  'claim-owner-observe-1',
  'claim-owner-observe-2',
  'claim-resolve',
  'recovery-lock-acquire',
  'post-lock-snapshot',
]);
const SIMPLE_EVENT_SET = new Set(SIMPLE_EVENTS);
const ADAPTER_CALL_SET = new Set([
  'read-journal-heads', 'read-journal', 'read-anchor', 'read-receipt',
  'classify-receipt',
  'lock-acquire', 'lock-verify', 'append-journal',
  'inspect-file', 'inspect-job', 'write-anchor',
  'write-candidate', 'plist-validate', 'publish', 'host-mutation',
]);
const COMPENSATION_ACTION_SET = new Set([
  'remove-controller', 'remove-scheduler', 'remove-manifest',
  'restore-controller', 'restore-scheduler', 'restore-manifest',
  'stop-controller', 'stop-scheduler', 'load-controller', 'load-scheduler',
]);
const COMPENSATION_PHASE_SET = new Set(['intent', 'completed']);
const COMPENSATION_STATE_PATTERN = /^compensate-([a-z-]+)-(intent|completed)$/;
/**
 * Task 1B frozen-chain 拒绝矩阵：闭合 enumerated mutation 词汇（恰 14 个名字）。
 * mutateFrozenChainForTest 只接受这些名字；不提供 generic callback mutator，
 * 不进 dependencies/factoryContract/crash-image durable allowlist。
 */
const FROZEN_CHAIN_MUTATIONS = Object.freeze(new Set([
  // Stratum A：persisted compensating envelope（acquire 前于 journal 加载层被拒）
  'reverse-plan-hash-field-drift',
  'reverse-plan-order-corruption',
  'reverse-plan-action-corruption',
  'reverse-plan-index-corruption',
  // Stratum B 链文法（逐条合法、hash-linked、head MIR；整链 prefix 被拒）
  'second-compensating-entry',
  'duplicate-intent',
  'completed-without-intent',
  'open-intent-then-later-intent',
  'duplicate-completed',
  'second-mir-marker',
  'terminal-before-plan-completion',
  // Stratum B evidence/live 单侧漂移（链不动，只漂移比较的一侧）
  'candidate-evidence-mismatch',
  'anchor-evidence-mismatch',
  'non-current-live-union-mismatch',
]));
const FROZEN_CHAIN_ENVELOPE_MUTATIONS = Object.freeze(new Set([
  'reverse-plan-hash-field-drift',
  'reverse-plan-order-corruption',
  'reverse-plan-action-corruption',
  'reverse-plan-index-corruption',
]));
const FROZEN_CHAIN_GRAMMAR_MUTATIONS = Object.freeze(new Set([
  'second-compensating-entry',
  'duplicate-intent',
  'completed-without-intent',
  'open-intent-then-later-intent',
  'duplicate-completed',
  'second-mir-marker',
  'terminal-before-plan-completion',
]));
const FAILABLE_EVENT_SET = new Set([
  'publish-controller', 'publish-scheduler', 'publish-manifest',
  'remove-controller', 'remove-scheduler', 'remove-manifest',
  'bootout-controller', 'bootout-scheduler',
  'bootstrap-controller', 'bootstrap-scheduler',
  'health-controller', 'verify-job-controller', 'verify-job-scheduler',
  'verify-scheduler-outcome',
]);
const REVALIDATION_REASONS = new Set([
  'after-prepared-inspection',
  'before-manifest-publish',
  'before-bootstrap-controller',
  'before-bootstrap-scheduler',
  'before-commit',
  'compensate-before-bootstrap-controller',
  'compensate-before-bootstrap-scheduler',
  'compensate-before-close',
]);

const ROOT_LAUNCH_AGENTS = LAUNCHAGENT_LIFECYCLE.rootIds.launchAgents;
const ROOT_METADATA = LAUNCHAGENT_LIFECYCLE.rootIds.metadata;
const FILENAMES = LAUNCHAGENT_LIFECYCLE.filenames;
const LABELS = LAUNCHAGENT_LIFECYCLE.labels;
const CODE_INVALID = LAUNCHAGENT_LIFECYCLE_CODES.INVALID;
const CODE_TX = LAUNCHAGENT_LIFECYCLE_CODES.TRANSACTION_IN_PROGRESS;
const CODE_MIR = LAUNCHAGENT_LIFECYCLE_CODES.MANUAL_INTERVENTION_REQUIRED;
const CODE_CONFIRMATION_CONSUMED = LAUNCHAGENT_LIFECYCLE_CODES.CONFIRMATION_CONSUMED;
const CODE_RECOVERY_CLAIM_STALLED = LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_CLAIM_STALLED;

/**
 * 冻结 coordinator DEPENDENCY_METHODS.metadataStore 完整表面（单一 FULL 契约）。
 * 与生产 transaction-coordinator DEPENDENCY_METHODS.metadataStore 精确对齐；
 * 不得再暴露 BASE/FULL 双表面或可选依赖。
 */
const COORDINATOR_METADATA_METHODS = Object.freeze([
  'readJournalHeads', 'readJournal', 'appendJournal',
  'writeCandidate', 'readCandidate',
  'writeAnchor', 'readAnchor',
  'acquireTransactionLock', 'verifyTransactionLock', 'releaseTransactionLock',
  'acquireManualInterventionLock', 'verifyManualInterventionLock',
  'publishReceipt', 'readReceipt', 'classifyReceipt',
  'writeManualRepairAttestation', 'readManualRepairAttestation',
  'readTransactionLockObservation', 'readRecoveryClaimObservation',
  'readManualInterventionLockObservation',
  'acquireRecoveryLockForManualRepair', 'abortRecoveryLockForManualRepair',
  'resolveRecoveryClaimForManualRepair',
  'releaseManualInterventionLock',
]);
const OBSERVE_STATUSES = new Set([
  'dead', 'alive-same-owner', 'pid-reused', 'unavailable', 'boot-session-mismatch',
]);
const SAFE_CLAIM_RESOLVE_STATUSES = new Set([
  'fresh-published', 'old-intact', 'transaction-lock-absent',
]);

/** 纯合成 temp-root 路径，不来自真实 HOME。 */
const SYNTH_LAUNCH_AGENTS_DIR = '/tmp/linke-v146-harness/LaunchAgents';
const FIXED_UID = 501;
const FIXED_DEVICE = 'device-harness-1';
const CLOCK_BASE_MS = Date.parse('2026-07-30T00:00:00.000Z');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const TERMINAL_JOURNAL_STATES = new Set(['committed', 'recovered', 'no-change', 'blocked']);
const RUNTIME_ARTIFACTS = Object.freeze({
  node: { pathId: 'host-node-executable', sha256: 'a1'.repeat(32) },
  controller: { pathId: 'src/controller-runtime.js', sha256: 'b2'.repeat(32) },
  agent: { pathId: 'src/agent.js', sha256: 'c3'.repeat(32) },
});
const ROLE_BY_ADDRESS = Object.freeze({
  [`${ROOT_LAUNCH_AGENTS}:${FILENAMES.controller}`]: 'controller',
  [`${ROOT_LAUNCH_AGENTS}:${FILENAMES.scheduler}`]: 'scheduler',
  [`${ROOT_METADATA}:${FILENAMES.manifest}`]: 'manifest',
});
const LOCK_KEYS = Object.freeze([
  'schemaVersion', 'transactionId', 'ownerPid', 'ownerNonce',
  'bootSessionIdentity', 'processStartIdentity',
]);
/** Task 6B.0 默认 fake process identity 固定字面（仅测试观测，不进 crash image）。 */
const FAKE_BOOT_SESSION_VALUE = 'fake-boot-session-v1';
const FAKE_PROCESS_START_VALUE = 'fake-process-start-v1';
function harnessError(message) {
  return new Error(`launchagent-harness:${message}`);
}

function invalid() {
  throw new LaunchAgentLifecycleError(CODE_INVALID);
}

function coded(code) {
  throw new LaunchAgentLifecycleError(code);
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value) || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}

function readExactObject(value, expectedKeys) {
  if (value === null || typeof value !== 'object') invalid();
  if (Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expectedKeys.length || ownKeys.some((k) => typeof k !== 'string')) invalid();
  const expected = new Set(expectedKeys);
  const fields = Object.create(null);
  for (const key of ownKeys) {
    if (!expected.has(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    fields[key] = descriptor.value;
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(fields, key)) invalid();
  }
  return fields;
}

function requireUuid(value) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) invalid();
  return value;
}

function requireSha256(value) {
  if (typeof value !== 'string' || !SHA_RE.test(value)) invalid();
  return value;
}

function computeJournalEntrySha256(entry) {
  return sha256Hex(Buffer.from(JSON.stringify({
    schemaVersion: entry.schemaVersion,
    transactionId: entry.transactionId,
    sequence: entry.sequence,
    previousEntrySha256: entry.previousEntrySha256,
    operation: entry.operation,
    state: entry.state,
    at: entry.at,
    payload: entry.payload,
  }), 'utf8'));
}

function resolvedPathFor(role) {
  return `${SYNTH_LAUNCH_AGENTS_DIR}/${FILENAMES[role]}`;
}

/**
 * 镜像 profiles.js 依赖：controllerEnvironment 只进 controller；scheduleSeconds 只进 scheduler；
 * sourceCommit 只进 publicProjection/manifest，不编码进 plist bytes。
 */
function makeProfiles(
  scheduleSeconds,
  controllerEnvironment,
  runtimeArtifacts = RUNTIME_ARTIFACTS,
) {
  const controllerBytes = Buffer.from(JSON.stringify({
    fakePlist: 'controller',
    label: LABELS.controller,
    controllerEnvironment,
  }), 'utf8');
  const schedulerBytes = Buffer.from(JSON.stringify({
    fakePlist: 'scheduler',
    label: LABELS.scheduler,
    scheduleSeconds,
  }), 'utf8');
  return {
    controller: {
      label: LABELS.controller,
      filename: FILENAMES.controller,
      plistBytes: controllerBytes,
      plistSha256: sha256Hex(controllerBytes),
    },
    scheduler: {
      label: LABELS.scheduler,
      filename: FILENAMES.scheduler,
      plistBytes: schedulerBytes,
      plistSha256: sha256Hex(schedulerBytes),
    },
    manifestRuntimeArtifacts: structuredClone(runtimeArtifacts),
    publicProjection: {
      scheduleSeconds,
      runtimeArtifacts: structuredClone(runtimeArtifacts),
      controller: {
        label: LABELS.controller,
        filename: FILENAMES.controller,
        plistSha256: sha256Hex(controllerBytes),
      },
      scheduler: {
        label: LABELS.scheduler,
        filename: FILENAMES.scheduler,
        plistSha256: sha256Hex(schedulerBytes),
      },
    },
  };
}

// ---- Task 5A.2 crash image：module-private brand、闭合 selector 词汇与字节编解码 ----
const CRASH_IMAGE_BRAND = new WeakSet();
// Task 6B.2 Task 4A：闭合 event selector，精确捕获 durable cut（仅 harness test API）。
const CRASH_SELECTOR_KINDS = new Set(['journal-state', 'host-mutation', 'event']);
const CRASH_HOST_ACTIONS = new Set([
  'publish-controller', 'publish-scheduler', 'publish-manifest',
  'bootout-controller', 'bootout-scheduler',
  'bootstrap-controller', 'bootstrap-scheduler',
  'remove-controller', 'remove-scheduler', 'remove-manifest',
  'restore-controller', 'restore-scheduler', 'restore-manifest',
  'load-controller', 'load-scheduler', 'stop-controller', 'stop-scheduler',
]);
/** Task 4A 闭合 event 名（恰 8 个）；未知名 fail-closed。 */
const CRASH_EVENT_NAMES = new Set([
  'attestation-verify',
  'recovery-claim-durable-old-intact',
  'old-transaction-lock-removed',
  'fresh-transaction-lock-published',
  'recovery-lock-acquire',
  'receipt-published',
  'recovery-transaction-lock-released',
  'mir-lock-released',
]);

/** Task 6B.2 Task 5：跨进程 crash-image 二进制信封上限（4 MiB）。 */
const CRASH_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
/** 信封顶层 exact own enumerable data keys（顺序固定）。 */
const CRASH_IMAGE_ENVELOPE_KEYS = Object.freeze(['schemaVersion', 'image', 'sha256']);
/** crash image 顶层 durable allowlist（含 Task 5 selected-host evidence）。 */
const CRASH_IMAGE_DURABLE_KEYS = Object.freeze([
  'schemaVersion',
  'files',
  'candidates',
  'journal',
  'anchors',
  'receipts',
  'transactionLock',
  'manualInterventionLock',
  'attestations',
  'recoveryClaim',
  'host',
  'sequence',
  'selectedFakeHostActionEvidence',
]);
const CRASH_IMAGE_HOST_KEYS = Object.freeze([
  'loaded', 'jobIdentity', 'foreignJob', 'probeMode',
  'health', 'schedulerOutcome', 'runtimeArtifacts',
]);
const CRASH_IMAGE_SEQUENCE_KEYS = Object.freeze(['clockIndex', 'idIndex', 'inodeIndex']);
const CRASH_IMAGE_EVIDENCE_KEYS = Object.freeze(['action', 'count']);
/** host.runtimeArtifacts exact closed shape: node,controller,agent × pathId,sha256. */
const CRASH_IMAGE_RUNTIME_ARTIFACT_KEYS = Object.freeze(['node', 'controller', 'agent']);
const CRASH_IMAGE_RUNTIME_ARTIFACT_FIELD_KEYS = Object.freeze(['pathId', 'sha256']);
/** pathId: nonempty safe identifier (alphanumeric + . _ / -). */
const CRASH_IMAGE_PATH_ID_RE = /^[A-Za-z0-9._/-]+$/;

function validatePositiveOccurrence(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw harnessError('crash capture occurrence must be a positive integer');
  }
  return value;
}

function encodeBytes(value) {
  if (!Buffer.isBuffer(value)) throw harnessError('crash image bytes must be Buffer');
  return value.toString('base64');
}

function decodeBytes(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw harnessError('crash image base64 must be non-empty');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw harnessError('invalid crash image base64');
  return bytes;
}

/**
 * Descriptor-first plain-data object read with exact key *order* and no accessors.
 * @param {unknown} value
 * @param {readonly string[]} expectedKeys
 * @returns {Record<string, unknown>}
 */
function readExactOrderedObject(value, expectedKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw harnessError('crash image field must be a plain object');
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw harnessError('crash image field must be a plain object');
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expectedKeys.length || ownKeys.some((k) => typeof k !== 'string')) {
    throw harnessError('crash image field has invalid keys');
  }
  for (let i = 0; i < expectedKeys.length; i += 1) {
    if (ownKeys[i] !== expectedKeys[i]) {
      throw harnessError('crash image field key order mismatch');
    }
  }
  const fields = Object.create(null);
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw harnessError('crash image field rejects accessors');
    }
    fields[key] = descriptor.value;
  }
  return fields;
}

function requireNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw harnessError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function validateIdentityPairShape(identity, label) {
  const fields = readExactOrderedObject(identity, ['available', 'value']);
  if (fields.available === false) {
    if (fields.value !== null) throw harnessError(`${label} unavailable value must be null`);
    return { available: false, value: null };
  }
  if (fields.available === true) {
    if (typeof fields.value !== 'string' || fields.value.length === 0) {
      throw harnessError(`${label} available value must be non-empty string`);
    }
    return { available: true, value: fields.value };
  }
  throw harnessError(`${label} available must be boolean`);
}

function validateSerializedLockRecord(record) {
  if (record === null) return null;
  const fields = readExactOrderedObject(record, [...LOCK_KEYS]);
  if (fields.schemaVersion !== 1) throw harnessError('unsupported lock schema');
  const transactionId = requireUuid(fields.transactionId);
  const ownerNonce = requireUuid(fields.ownerNonce);
  if (transactionId === ownerNonce) throw harnessError('lock identity collision');
  if (!Number.isSafeInteger(fields.ownerPid) || fields.ownerPid <= 0) {
    throw harnessError('lock ownerPid must be positive');
  }
  return {
    schemaVersion: 1,
    transactionId,
    ownerPid: fields.ownerPid,
    ownerNonce,
    bootSessionIdentity: validateIdentityPairShape(
      fields.bootSessionIdentity,
      'bootSessionIdentity',
    ),
    processStartIdentity: validateIdentityPairShape(
      fields.processStartIdentity,
      'processStartIdentity',
    ),
  };
}

function validateSelectedFakeHostActionEvidence(value) {
  if (value === null) return null;
  const fields = readExactOrderedObject(value, CRASH_IMAGE_EVIDENCE_KEYS);
  if (typeof fields.action !== 'string' || !CRASH_HOST_ACTIONS.has(fields.action)) {
    throw harnessError('selected fake host action evidence action invalid');
  }
  if (!Number.isSafeInteger(fields.count) || fields.count <= 0) {
    throw harnessError('selected fake host action evidence count invalid');
  }
  return { action: fields.action, count: fields.count };
}

/**
 * Exact closed host.runtimeArtifacts: keys node,controller,agent (order fixed);
 * each exact pathId,sha256; nonempty safe pathId; lowercase sha256.
 * @param {unknown} value
 * @returns {{
 *   node: { pathId: string, sha256: string },
 *   controller: { pathId: string, sha256: string },
 *   agent: { pathId: string, sha256: string },
 * }}
 */
function validateRuntimeArtifactsProjection(value) {
  const artifacts = readExactOrderedObject(value, CRASH_IMAGE_RUNTIME_ARTIFACT_KEYS);
  const out = Object.create(null);
  for (const role of CRASH_IMAGE_RUNTIME_ARTIFACT_KEYS) {
    const fields = readExactOrderedObject(
      artifacts[role],
      CRASH_IMAGE_RUNTIME_ARTIFACT_FIELD_KEYS,
    );
    if (typeof fields.pathId !== 'string' || fields.pathId.length === 0) {
      throw harnessError('host.runtimeArtifacts pathId invalid');
    }
    if (!CRASH_IMAGE_PATH_ID_RE.test(fields.pathId)) {
      throw harnessError('host.runtimeArtifacts pathId unsafe');
    }
    // requireSha256 enforces lowercase [0-9a-f]{64}.
    out[role] = {
      pathId: fields.pathId,
      sha256: requireSha256(fields.sha256),
    };
  }
  return {
    node: out.node,
    controller: out.controller,
    agent: out.agent,
  };
}

/**
 * Reject duplicate logical keys so Map revival cannot silently overwrite.
 * @param {string[]} keys
 * @param {string} label
 */
function rejectDuplicateLogicalKeys(keys, label) {
  const seen = new Set();
  for (const key of keys) {
    if (seen.has(key)) {
      throw harnessError(`crash image ${label} duplicate logical key`);
    }
    seen.add(key);
  }
}

/**
 * Rebuild crash image with exact durable key order for canonical JSON.
 * Validates nested shapes/values/bindings/hashes strictly (fail closed).
 * @param {unknown} raw
 * @returns {object}
 */
function materializeCrashImageProjection(raw) {
  const top = readExactOrderedObject(raw, CRASH_IMAGE_DURABLE_KEYS);
  if (top.schemaVersion !== 1) throw harnessError('unsupported crash image schema');

  if (!Array.isArray(top.files)) throw harnessError('crash image files must be array');
  const files = top.files.map((item) => {
    const fields = readExactOrderedObject(item, [
      'key', 'bytesBase64', 'device', 'inode', 'ownerUid',
    ]);
    if (typeof fields.key !== 'string' || fields.key.length === 0) {
      throw harnessError('crash image file key invalid');
    }
    const bytes = decodeBytes(fields.bytesBase64);
    if (typeof fields.device !== 'string' || fields.device.length === 0) {
      throw harnessError('crash image file device invalid');
    }
    if (typeof fields.inode !== 'string' || fields.inode.length === 0) {
      throw harnessError('crash image file inode invalid');
    }
    if (!Number.isSafeInteger(fields.ownerUid) || fields.ownerUid < 0) {
      throw harnessError('crash image file ownerUid invalid');
    }
    return {
      key: fields.key,
      bytesBase64: encodeBytes(bytes),
      device: fields.device,
      inode: fields.inode,
      ownerUid: fields.ownerUid,
    };
  });
  rejectDuplicateLogicalKeys(files.map((item) => item.key), 'files');

  if (!Array.isArray(top.candidates)) throw harnessError('crash image candidates must be array');
  const candidates = top.candidates.map((item) => {
    const fields = readExactOrderedObject(item, [
      'key', 'bytesBase64', 'sha256', 'role', 'transactionId',
    ]);
    if (typeof fields.key !== 'string' || fields.key.length === 0) {
      throw harnessError('crash image candidate key invalid');
    }
    const bytes = decodeBytes(fields.bytesBase64);
    const sha256 = requireSha256(fields.sha256);
    if (sha256Hex(bytes) !== sha256) {
      throw harnessError('crash image candidate hash mismatch');
    }
    if (
      fields.role !== 'controller'
      && fields.role !== 'scheduler'
      && fields.role !== 'manifest'
    ) {
      throw harnessError('crash image candidate role invalid');
    }
    return {
      key: fields.key,
      bytesBase64: encodeBytes(bytes),
      sha256,
      role: fields.role,
      transactionId: requireUuid(fields.transactionId),
    };
  });
  rejectDuplicateLogicalKeys(candidates.map((item) => item.key), 'candidates');

  if (!Array.isArray(top.journal)) throw harnessError('crash image journal must be array');
  const journal = top.journal.map((entry) => {
    const projection = validateLaunchAgentJournal(structuredClone(entry));
    if (computeJournalEntrySha256(projection) !== projection.entrySha256) {
      throw harnessError('crash image journal entry hash mismatch');
    }
    return structuredClone(projection);
  });

  if (!Array.isArray(top.anchors)) throw harnessError('crash image anchors must be array');
  const anchors = top.anchors.map((item) => {
    if (!Array.isArray(item) || item.length !== 2) {
      throw harnessError('crash image anchor entry must be [key, value]');
    }
    const [key, value] = item;
    if (typeof key !== 'string' || !UUID_RE.test(key)) {
      throw harnessError('crash image anchor key invalid');
    }
    const projection = validateLaunchAgentAnchor(structuredClone(value));
    if (projection.anchorId !== key) {
      throw harnessError('crash image anchor key binding mismatch');
    }
    return [key, structuredClone(projection)];
  });
  rejectDuplicateLogicalKeys(anchors.map(([key]) => key), 'anchors');

  if (!Array.isArray(top.receipts)) throw harnessError('crash image receipts must be array');
  const receipts = top.receipts.map((item) => {
    if (!Array.isArray(item) || item.length !== 2) {
      throw harnessError('crash image receipt entry must be [key, value]');
    }
    const [key, value] = item;
    requireUuid(key);
    const valueFields = readExactOrderedObject(value, ['projection', 'sha256']);
    const projection = validateLaunchAgentReceipt(structuredClone(valueFields.projection));
    const sha256 = requireSha256(valueFields.sha256);
    const computed = sha256Hex(Buffer.from(JSON.stringify(projection), 'utf8'));
    if (computed !== sha256) throw harnessError('crash image receipt hash mismatch');
    if (projection.transactionId !== key) {
      throw harnessError('crash image receipt key binding mismatch');
    }
    return [key, { projection: structuredClone(projection), sha256 }];
  });
  rejectDuplicateLogicalKeys(receipts.map(([key]) => key), 'receipts');

  const transactionLock = validateSerializedLockRecord(top.transactionLock);
  const manualInterventionLock = validateSerializedLockRecord(top.manualInterventionLock);

  if (!Array.isArray(top.attestations)) {
    throw harnessError('crash image attestations must be an array');
  }
  const attestations = top.attestations.map((item) => {
    if (!Array.isArray(item) || item.length !== 2) {
      throw harnessError('crash image attestation entry must be [key, value]');
    }
    const [key, value] = item;
    if (typeof key !== 'string' || !UUID_RE.test(key)) {
      throw harnessError('crash image attestation key invalid');
    }
    const projection = validateLaunchAgentManualRepairAttestation(structuredClone(value));
    if (projection.manualRepairConfirmationId !== key) {
      throw harnessError('crash image attestation key binding mismatch');
    }
    return [key, structuredClone(projection)];
  });
  rejectDuplicateLogicalKeys(attestations.map(([key]) => key), 'attestations');

  let recoveryClaim = null;
  if (top.recoveryClaim !== null) {
    const claimFields = readExactOrderedObject(top.recoveryClaim, ['record', 'ref']);
    const recordFields = readExactOrderedObject(claimFields.record, [
      'schemaVersion', 'kind', 'claimId', 'transactionId', 'ownerPid', 'ownerNonce',
      'bootSessionIdentity', 'processStartIdentity',
      'expectedTransactionLockRef', 'manualInterventionLockRef', 'freshTransactionLockRef',
    ]);
    if (recordFields.schemaVersion !== 1) throw harnessError('recovery claim schema invalid');
    if (recordFields.kind !== 'recovery-claim-lock') {
      throw harnessError('recovery claim kind invalid');
    }
    const claimId = requireUuid(recordFields.claimId);
    const transactionId = requireUuid(recordFields.transactionId);
    const ownerNonce = requireUuid(recordFields.ownerNonce);
    if (claimId === transactionId || claimId === ownerNonce || transactionId === ownerNonce) {
      throw harnessError('recovery claim identity collision');
    }
    if (!Number.isSafeInteger(recordFields.ownerPid) || recordFields.ownerPid <= 0) {
      throw harnessError('recovery claim ownerPid invalid');
    }
    // Canonical record for hash binding (exact key order).
    const record = {
      schemaVersion: 1,
      kind: 'recovery-claim-lock',
      claimId,
      transactionId,
      ownerPid: recordFields.ownerPid,
      ownerNonce,
      bootSessionIdentity: validateIdentityPairShape(
        recordFields.bootSessionIdentity,
        'claim.bootSessionIdentity',
      ),
      processStartIdentity: validateIdentityPairShape(
        recordFields.processStartIdentity,
        'claim.processStartIdentity',
      ),
      expectedTransactionLockRef: recordFields.expectedTransactionLockRef === null
        ? null
        : (() => {
          const er = readExactOrderedObject(recordFields.expectedTransactionLockRef, [
            'kind', 'transactionId', 'ownerNonce', 'sha256',
          ]);
          if (er.kind !== 'transaction-lock') throw harnessError('claim expected tx kind');
          return {
            kind: 'transaction-lock',
            transactionId: requireUuid(er.transactionId),
            ownerNonce: requireUuid(er.ownerNonce),
            sha256: requireSha256(er.sha256),
          };
        })(),
      manualInterventionLockRef: (() => {
        const mir = readExactOrderedObject(recordFields.manualInterventionLockRef, [
          'kind', 'transactionId', 'ownerNonce', 'sha256',
        ]);
        if (mir.kind !== 'manual-intervention-lock') throw harnessError('claim mir kind');
        return {
          kind: 'manual-intervention-lock',
          transactionId: requireUuid(mir.transactionId),
          ownerNonce: requireUuid(mir.ownerNonce),
          sha256: requireSha256(mir.sha256),
        };
      })(),
      freshTransactionLockRef: (() => {
        const fr = readExactOrderedObject(recordFields.freshTransactionLockRef, [
          'kind', 'transactionId', 'ownerNonce', 'sha256',
        ]);
        if (fr.kind !== 'transaction-lock') throw harnessError('claim fresh tx kind');
        return {
          kind: 'transaction-lock',
          transactionId: requireUuid(fr.transactionId),
          ownerNonce: requireUuid(fr.ownerNonce),
          sha256: requireSha256(fr.sha256),
        };
      })(),
    };
    const claimSha = sha256Hex(Buffer.from(JSON.stringify(record), 'utf8'));
    const refIn = readExactOrderedObject(claimFields.ref, [
      'kind', 'claimId', 'transactionId', 'ownerNonce', 'sha256',
    ]);
    if (
      refIn.kind !== 'recovery-claim-lock'
      || refIn.claimId !== claimId
      || refIn.transactionId !== transactionId
      || refIn.ownerNonce !== ownerNonce
      || refIn.sha256 !== claimSha
    ) {
      throw harnessError('crash image recoveryClaim ref/hash mismatch');
    }
    recoveryClaim = {
      record,
      ref: {
        kind: 'recovery-claim-lock',
        claimId,
        transactionId,
        ownerNonce,
        sha256: claimSha,
      },
    };
  }

  const hostFields = readExactOrderedObject(top.host, CRASH_IMAGE_HOST_KEYS);
  const loaded = readExactOrderedObject(hostFields.loaded, ['controller', 'scheduler']);
  if (typeof loaded.controller !== 'boolean' || typeof loaded.scheduler !== 'boolean') {
    throw harnessError('host.loaded booleans required');
  }
  const jobIdentity = readExactOrderedObject(hostFields.jobIdentity, ['controller', 'scheduler']);
  for (const role of ['controller', 'scheduler']) {
    const value = jobIdentity[role];
    if (value !== null && (typeof value !== 'string' || !SHA_RE.test(value))) {
      throw harnessError('host.jobIdentity invalid');
    }
  }
  const foreignJob = readExactOrderedObject(hostFields.foreignJob, ['controller', 'scheduler']);
  if (typeof foreignJob.controller !== 'boolean' || typeof foreignJob.scheduler !== 'boolean') {
    throw harnessError('host.foreignJob booleans required');
  }
  const probeMode = readExactOrderedObject(hostFields.probeMode, ['controller', 'scheduler']);
  for (const role of ['controller', 'scheduler']) {
    if (probeMode[role] !== 'normal' && probeMode[role] !== 'unknown') {
      throw harnessError('host.probeMode invalid');
    }
  }
  const health = readExactOrderedObject(hostFields.health, ['statusCode', 'ready', 'count']);
  if (!Number.isSafeInteger(health.statusCode) || typeof health.ready !== 'boolean') {
    throw harnessError('host.health invalid');
  }
  requireNonNegativeSafeInteger(health.count, 'host.health.count');
  if (
    hostFields.schedulerOutcome !== 'ok'
    && hostFields.schedulerOutcome !== 'failed'
  ) {
    // harness may use other synthetic outcomes; accept non-empty string only.
    if (typeof hostFields.schedulerOutcome !== 'string' || hostFields.schedulerOutcome.length === 0) {
      throw harnessError('host.schedulerOutcome invalid');
    }
  }
  const runtimeArtifacts = validateRuntimeArtifactsProjection(hostFields.runtimeArtifacts);

  const sequence = readExactOrderedObject(top.sequence, CRASH_IMAGE_SEQUENCE_KEYS);
  requireNonNegativeSafeInteger(sequence.clockIndex, 'sequence.clockIndex');
  requireNonNegativeSafeInteger(sequence.idIndex, 'sequence.idIndex');
  requireNonNegativeSafeInteger(sequence.inodeIndex, 'sequence.inodeIndex');

  const selectedFakeHostActionEvidence = validateSelectedFakeHostActionEvidence(
    top.selectedFakeHostActionEvidence,
  );

  return {
    schemaVersion: 1,
    files,
    candidates,
    journal,
    anchors,
    receipts,
    transactionLock,
    manualInterventionLock,
    attestations,
    recoveryClaim,
    host: {
      loaded: { controller: loaded.controller, scheduler: loaded.scheduler },
      jobIdentity: {
        controller: jobIdentity.controller,
        scheduler: jobIdentity.scheduler,
      },
      foreignJob: {
        controller: foreignJob.controller,
        scheduler: foreignJob.scheduler,
      },
      probeMode: {
        controller: probeMode.controller,
        scheduler: probeMode.scheduler,
      },
      health: {
        statusCode: health.statusCode,
        ready: health.ready,
        count: health.count,
      },
      schedulerOutcome: hostFields.schedulerOutcome,
      runtimeArtifacts,
    },
    sequence: {
      clockIndex: sequence.clockIndex,
      idIndex: sequence.idIndex,
      inodeIndex: sequence.inodeIndex,
    },
    selectedFakeHostActionEvidence,
  };
}

function canonicalCrashImageBytes(image) {
  return Buffer.from(JSON.stringify(image), 'utf8');
}

/**
 * Task 6B.2 Task 5：将 branded crash image 序列化为闭合二进制信封。
 * 信封 = canonical UTF-8 JSON `{schemaVersion:1,image,sha256}`；
 * sha256 覆盖 image 单独的 canonical JSON bytes；总长 ≤ 4 MiB。
 * @param {object} image
 * @returns {Buffer}
 */
export function serializeLaunchAgentLifecycleCrashImageForTest(image) {
  if (image === null || typeof image !== 'object' || Array.isArray(image)) {
    throw harnessError('serialize requires branded crash image');
  }
  if (!CRASH_IMAGE_BRAND.has(image)) {
    throw harnessError('serialize requires branded crash image');
  }
  // Materialize through validator so envelope always carries canonical key order.
  const canonicalImage = materializeCrashImageProjection(image);
  const imageBytes = canonicalCrashImageBytes(canonicalImage);
  const digest = sha256Hex(imageBytes);
  const envelope = {
    schemaVersion: 1,
    image: canonicalImage,
    sha256: digest,
  };
  const bytes = Buffer.from(JSON.stringify(envelope), 'utf8');
  if (bytes.length > CRASH_IMAGE_MAX_BYTES) {
    throw harnessError('serialized crash image exceeds 4 MiB');
  }
  return bytes;
}

/**
 * Task 6B.2 Task 5：从闭合二进制信封 revive branded crash image。
 * 拒绝 empty/invalid UTF-8、非 canonical JSON、额外/缺失/accessor/非 plain、
 * digest 不匹配与全部非法嵌套形状。成功时 deep-freeze 并打 module-private brand。
 * @param {Buffer} bytes
 * @returns {object}
 */
export function reviveLaunchAgentLifecycleCrashImageForTest(bytes) {
  if (!Buffer.isBuffer(bytes)) {
    throw harnessError('revive requires Buffer');
  }
  if (bytes.length === 0) throw harnessError('revive rejects empty buffer');
  if (bytes.length > CRASH_IMAGE_MAX_BYTES) {
    throw harnessError('revive rejects buffer over 4 MiB');
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw harnessError('revive rejects invalid UTF-8');
  }
  // Reject non-canonical UTF-8 round-trip (e.g. overlong would already fail fatal).
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw harnessError('revive rejects noncanonical UTF-8 bytes');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw harnessError('revive rejects invalid JSON');
  }

  const envelope = readExactOrderedObject(parsed, CRASH_IMAGE_ENVELOPE_KEYS);
  if (envelope.schemaVersion !== 1) {
    throw harnessError('unsupported crash image envelope schema');
  }
  if (typeof envelope.sha256 !== 'string' || !SHA_RE.test(envelope.sha256)) {
    throw harnessError('envelope sha256 invalid');
  }

  const canonicalImage = materializeCrashImageProjection(envelope.image);
  const imageBytes = canonicalCrashImageBytes(canonicalImage);
  const digest = sha256Hex(imageBytes);
  if (digest !== envelope.sha256) {
    throw harnessError('crash image digest mismatch');
  }

  // Noncanonical envelope/image bytes: re-encode must equal input exactly.
  const reencoded = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    image: canonicalImage,
    sha256: digest,
  }), 'utf8');
  if (!reencoded.equals(bytes)) {
    throw harnessError('revive rejects noncanonical JSON bytes');
  }

  const image = deepFreeze(canonicalImage);
  CRASH_IMAGE_BRAND.add(image);
  // Dry-run restore through factory so nested restore validators also apply.
  try {
    createLaunchAgentLifecycleHarness({ crashImage: image });
  } catch (error) {
    CRASH_IMAGE_BRAND.delete(image);
    if (error instanceof Error && typeof error.message === 'string') {
      throw harnessError(`revive restore failed: ${error.message}`);
    }
    throw harnessError('revive restore failed');
  }
  return image;
}

export function createLaunchAgentLifecycleHarness(options = {}) {
  if (options === null || typeof options !== 'object'
      || Object.getPrototypeOf(options) !== Object.prototype) {
    throw harnessError('harness options must be a plain object');
  }
  const optionFields = readExactObject(
    options,
    Reflect.ownKeys(options).length === 0 ? [] : ['crashImage'],
  );
  const revivedImage = Object.hasOwn(optionFields, 'crashImage')
    ? optionFields.crashImage
    : null;
  if (revivedImage !== null && !CRASH_IMAGE_BRAND.has(revivedImage)) {
    throw harnessError('untrusted crash image');
  }
  // Step 4 锁接缝只允许作用于 branded revived harness。
  const revivedFromCrashImage = revivedImage !== null;
  const files = new Map();
  const candidates = new Map();
  const store = {
    journal: [],
    anchors: new Map(),
    receipts: new Map(),
    transactionLock: null,
    manualInterventionLock: null,
    // Task 5 fake durable: attestations + single recovery claim
    attestations: new Map(),
    recoveryClaim: null,
  };
  const state = {
    loaded: { controller: false, scheduler: false },
    jobIdentity: { controller: null, scheduler: null },
    foreignJob: { controller: false, scheduler: false },
    probeMode: { controller: 'normal', scheduler: 'normal' },
    health: { statusCode: 200, ready: true, count: 0 },
    schedulerOutcome: 'ok',
    printPhase: { controller: 'inspect', scheduler: 'inspect' },
    plistLintValid: { controller: true, scheduler: true },
    runtimeArtifacts: structuredClone(RUNTIME_ARTIFACTS),
    revalidationFailures: new Set(),
    strictLaunchctlTransitions: false,
    forgedReplaceNoMutationRole: null,
    invalidAtomicExpectations: new Set(),
    publishedIdentityFaults: new Map(),
    lastRenderedRuntimeArtifacts: null,
  };
  const counters = {
    inspect: 0,
    journal: 0,
    anchor: 0,
    publish: 0,
    remove: 0,
    bootout: 0,
    bootstrap: 0,
    print: 0,
    health: 0,
    receipt: 0,
    render: 0,
    revalidate: 0,
    plistValidate: 0,
    writeCandidate: 0,
    readCandidate: 0,
    readJournalHeads: 0,
    readJournal: 0,
    readAnchor: 0,
    lockVerify: 0,
  };
  const trace = [];
  const adapterCalls = [];
  const publishedCandidateRefs = [];
  const atomicExpectedAttempts = [];
  const failureOccurrences = new Map();
  const eventCallCounts = new Map();
  const hooks = [];
  const compensationHooks = [];
  const revalidateMarks = [];
  let clockIndex = 0;
  let idIndex = 0;
  // Task 6B.2 clock 观测：仅经 clock dependency surface 的 now/newId 调用计数；
  // 不写入 crash image；不进 dependencies/factoryContract；resetObservations 复位。
  let clockNowCount = 0;
  let clockNewIdCount = 0;
  let inodeIndex = 0;
  let nextAnchorOverride = null;
  // Task 5 Step 2：唯一 pending exact receipt race id；不写入 crash image，
  // revived harness 自然从 null 开始；resetObservations 复位。
  let exactReceiptRaceTransactionId = null;
  const queuedClockIds = [];
  let crashSelector = null;
  let crashImage = null;
  let crashImageTaken = false;
  const crashOccurrences = new Map();
  // Task 6B.0 process-identity 观测：不写入 crash image；resetObservations 复位。
  let processIdentityCurrentCount = 0;
  const lockAcquisitionHistory = [];
  // Task 5：recovery acquire 成功后 detached 观察（claim 已删除仍可证明传入 claimId）。
  // exact {claimId,transactionId,ownerNonce}；不暴露 capability/authority/brand。
  const recoveryAcquisitionHistory = [];
  // Task 5：owner / claim-owner observe 队列（显式 arm，默认 unavailable）。
  const ownerObserveQueue = [];
  const claimOwnerObserveQueue = [];
  let observeChannel = 'owner'; // 'owner' | 'claim'
  let ownerObserveCount = 0;
  let claimOwnerObserveCount = 0;
  // Task 5：authority-consumed 仅能由显式 test seam 或 coordinator 路径记录；
  // 不伪造 production success。harness 提供 recordAuthorityConsumedForTest。
  let postLockSnapshotArmed = false;
  // Task 5 test-only：下一次 acquire 原子 claim 检查点一次性注入 winner claim。
  // 不写入 crash image；不进 dependencies/factoryContract；resetObservations 清除。
  let raceRecoveryClaimArm = null;
  // Task 5 test-only：readRecoveryClaimObservation 只读历史（present/absent）。
  const recoveryClaimObservationHistory = [];
  // Task 6B.2 Task 5：闭合 selected fake host action evidence（仅 arm 后计数）。
  // 进入 crash image；不进 dependencies/factoryContract。
  let selectedFakeHostActionArm = null;
  let selectedFakeHostActionEvidence = null;
  /** @type {(() => void) | null} */
  let selectedFakeHostActionWaiter = null;

  // crash image 只恢复 durable allowlist；hooks/失败注入/trace/计数保持新 harness 默认。
  if (revivedImage !== null) {
    restoreDurableState(revivedImage);
  }

  function nextUuid() {
    idIndex += 1;
    return `00000000-0000-4000-8000-${String(idIndex).padStart(12, '0')}`;
  }

  function nowIso() {
    const instant = new Date(CLOCK_BASE_MS + clockIndex * 1000);
    clockIndex += 1;
    return instant.toISOString();
  }

  function fileKey(rootId, basename) {
    return `${rootId}:${basename}`;
  }

  function roleForAddress(rootId, basename) {
    const role = ROLE_BY_ADDRESS[fileKey(rootId, basename)];
    if (!role) invalid();
    return role;
  }

  function currentFileIdentity(role) {
    const rootId = role === 'manifest' ? ROOT_METADATA : ROOT_LAUNCH_AGENTS;
    const file = files.get(fileKey(rootId, FILENAMES[role]));
    if (!file) return null;
    return {
      device: file.device,
      inode: file.inode,
      sha256: sha256Hex(file.bytes),
    };
  }

  function completeFileIdentity(role, identity = currentFileIdentity(role)) {
    if (identity === null) return null;
    return {
      rootId: role === 'manifest' ? ROOT_METADATA : ROOT_LAUNCH_AGENTS,
      basename: FILENAMES[role],
      type: 'regular-file',
      ownerUid: FIXED_UID,
      device: identity.device,
      inode: identity.inode,
      sha256: identity.sha256,
    };
  }

  function publisherIdentity(role, identity = currentFileIdentity(role)) {
    return completeFileIdentity(role, identity);
  }

  function takePublishedIdentity(role) {
    const identity = publisherIdentity(role);
    const fault = state.publishedIdentityFaults.get(role);
    if (fault === undefined) return identity;
    state.publishedIdentityFaults.delete(role);
    if (fault === 'bad-sha256') {
      return {
        ...identity,
        sha256: identity.sha256 === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64),
      };
    }
    if (fault === 'three-field') {
      return {
        device: identity.device,
        inode: identity.inode,
        sha256: identity.sha256,
      };
    }
    throw harnessError(`unknown published identity fault: ${String(fault)}`);
  }

  function placeFile(role, bytes) {
    const rootId = role === 'manifest' ? ROOT_METADATA : ROOT_LAUNCH_AGENTS;
    inodeIndex += 1;
    files.set(fileKey(rootId, FILENAMES[role]), {
      bytes: Buffer.from(bytes),
      device: FIXED_DEVICE,
      inode: `inode-${inodeIndex}`,
      ownerUid: FIXED_UID,
    });
  }

  function removeFile(role) {
    const rootId = role === 'manifest' ? ROOT_METADATA : ROOT_LAUNCH_AGENTS;
    files.delete(fileKey(rootId, FILENAMES[role]));
  }

  function computeJobIdentity(role) {
    const file = files.get(fileKey(ROOT_LAUNCH_AGENTS, FILENAMES[role]));
    return file ? sha256Hex(file.bytes) : '0'.repeat(64);
  }

  function fireHooks(eventName) {
    for (const hook of hooks) {
      if (hook.eventName === eventName) hook.fn();
    }
  }

  function recordSimpleEvent(eventName) {
    if (!SIMPLE_EVENT_SET.has(eventName)) {
      throw harnessError(`unknown simple event: ${String(eventName)}`);
    }
    trace.push(eventName);
    fireHooks(eventName);
  }

  function recordCompensationEvent(action, phase) {
    if (!COMPENSATION_ACTION_SET.has(action)) {
      throw harnessError(`unknown compensation action: ${String(action)}`);
    }
    if (!COMPENSATION_PHASE_SET.has(phase)) {
      throw harnessError(`unknown compensation phase: ${String(phase)}`);
    }
    trace.push(deepFreeze({ kind: 'compensation', action, phase }));
    for (const hook of compensationHooks) {
      if (hook.action === action && hook.phase === phase) hook.fn();
    }
  }

  function recordAdapterCall(name, role = null) {
    if (!ADAPTER_CALL_SET.has(name)) {
      throw harnessError(`unknown adapter call: ${String(name)}`);
    }
    if (role !== null && role !== 'controller' && role !== 'scheduler' && role !== 'manifest') {
      throw harnessError(`unknown adapter role: ${String(role)}`);
    }
    adapterCalls.push(deepFreeze({ name, role }));
  }

  function shouldFail(eventName) {
    const callIndex = (eventCallCounts.get(eventName) ?? 0) + 1;
    eventCallCounts.set(eventName, callIndex);
    const occurrences = failureOccurrences.get(eventName);
    if (!occurrences || !occurrences.has(callIndex)) return false;
    occurrences.delete(callIndex);
    return true;
  }

  // ---- hostInspector ----
  const hostInspector = Object.freeze({
    async inspect(address) {
      const fields = readExactObject(address, ['rootId', 'basename']);
      if (typeof fields.rootId !== 'string' || typeof fields.basename !== 'string') invalid();
      if (fields.basename.includes('/') || fields.basename.includes('\\') || fields.basename.includes('\0')) {
        invalid();
      }
      roleForAddress(fields.rootId, fields.basename);
      recordAdapterCall('inspect-file', roleForAddress(fields.rootId, fields.basename));
      counters.inspect += 1;
      recordSimpleEvent('inspect');
      const file = files.get(fileKey(fields.rootId, fields.basename));
      if (!file) {
        return deepFreeze({
          rootId: fields.rootId,
          basename: fields.basename,
          type: 'regular-file',
          ownerUid: FIXED_UID,
        });
      }
      return deepFreeze({
        rootId: fields.rootId,
        basename: fields.basename,
        type: 'regular-file',
        ownerUid: FIXED_UID,
        device: file.device,
        inode: file.inode,
        sha256: sha256Hex(file.bytes),
      });
    },

    async read(identity) {
      const fields = readExactObject(identity, [
        'rootId', 'basename', 'type', 'ownerUid', 'device', 'inode', 'sha256',
      ]);
      if (fields.type !== 'regular-file' || fields.ownerUid !== FIXED_UID) invalid();
      roleForAddress(fields.rootId, fields.basename);
      counters.inspect += 1;
      recordSimpleEvent('inspect');
      const file = files.get(fileKey(fields.rootId, fields.basename));
      if (!file) invalid();
      if (file.device !== fields.device || file.inode !== fields.inode) invalid();
      if (sha256Hex(file.bytes) !== requireSha256(fields.sha256)) invalid();
      return Buffer.from(file.bytes);
    },

    /** 构造 validateLaunchctlRequest 兼容 request 所需的合成宿主事实。 */
    async launchctlHostFacts() {
      return deepFreeze({
        uid: FIXED_UID,
        rootId: ROOT_LAUNCH_AGENTS,
        basenames: {
          controller: FILENAMES.controller,
          scheduler: FILENAMES.scheduler,
        },
        resolvedPaths: {
          controller: resolvedPathFor('controller'),
          scheduler: resolvedPathFor('scheduler'),
        },
      });
    },
  });

  // ---- atomicPublisher：mismatch 在 mutation 前拒绝 → 不计 hostMutation ----
  function readExpectedIdentity(role, value) {
    const fields = readExactObject(value, [
      'rootId', 'basename', 'type', 'ownerUid', 'device', 'inode', 'sha256',
    ]);
    const expectedAddress = completeFileIdentity(role, {
      device: fields.device,
      inode: fields.inode,
      sha256: fields.sha256,
    });
    for (const key of ['rootId', 'basename', 'type', 'ownerUid']) {
      if (fields[key] !== expectedAddress[key]) invalid();
    }
    if (typeof fields.device !== 'string' || fields.device.length === 0) invalid();
    if (typeof fields.inode !== 'string' || fields.inode.length === 0) invalid();
    requireSha256(fields.sha256);
    return fields;
  }

  function readPublishInput(input, withExpected) {
    const keys = withExpected
      ? ['rootId', 'basename', 'candidateRef', 'expected']
      : ['rootId', 'basename', 'candidateRef'];
    const fields = readExactObject(input, keys);
    const role = roleForAddress(fields.rootId, fields.basename);
    const ref = readExactObject(fields.candidateRef, [
      'kind', 'transactionId', 'role', 'sha256',
    ]);
    if (ref.kind !== 'candidate') invalid();
    const transactionId = requireUuid(ref.transactionId);
    if (ref.role !== role) invalid();
    const sha256 = requireSha256(ref.sha256);
    const staged = candidates.get(`${transactionId}:${role}`);
    if (!staged || staged.sha256 !== sha256) invalid();
    const candidateRef = deepFreeze({ kind: 'candidate', transactionId, role, sha256 });
    publishedCandidateRefs.push(candidateRef);
    recordAdapterCall('publish', role);
    return {
      role,
      bytes: Buffer.from(staged.bytes),
      expected: withExpected ? fields.expected : null,
    };
  }

  function expectedMatchesCurrent(role, expected) {
    const current = currentFileIdentity(role);
    if (current === null) return false;
    if (
      current.device === expected.device
      && current.inode === expected.inode
      && current.sha256 === expected.sha256
    ) {
      const complete = completeFileIdentity(role, current);
      return ['rootId', 'basename', 'type', 'ownerUid']
        .every((key) => complete[key] === expected[key]);
    }
    return false;
  }

  function recordAtomicExpectedAttempt(operation, role, expected) {
    if (operation !== 'replace' && operation !== 'remove') {
      throw harnessError(`unknown atomic expectation operation: ${String(operation)}`);
    }
    const keys = expected !== null && typeof expected === 'object'
      ? Reflect.ownKeys(expected).map(String).sort()
      : [];
    atomicExpectedAttempts.push(deepFreeze({ operation, role, keys }));
    const failureKey = `${operation}:${role}`;
    if (state.invalidAtomicExpectations.delete(failureKey)) invalid();
  }

  const atomicPublisher = Object.freeze({
    async publishAbsent(input) {
      const { role, bytes } = readPublishInput(input, false);
      const eventName = `publish-${role}`;
      if (shouldFail(eventName)) {
        return deepFreeze({ outcome: 'conditional-mutation-mismatch' });
      }
      const rootId = role === 'manifest' ? ROOT_METADATA : ROOT_LAUNCH_AGENTS;
      if (files.has(fileKey(rootId, FILENAMES[role]))) {
        return deepFreeze({ outcome: 'conditional-mutation-mismatch' });
      }
      recordSimpleEvent(eventName);
      recordAdapterCall('host-mutation', role);
      placeFile(role, bytes);
      counters.publish += 1;
      recordSuccessfulHostMutation(eventName);
      return deepFreeze({ outcome: 'ok', identity: takePublishedIdentity(role) });
    },

    async replaceIfMatch(input) {
      const { role, bytes } = readPublishInput(input, true);
      recordAtomicExpectedAttempt('replace', role, input.expected);
      const expected = readExpectedIdentity(role, input.expected);
      const eventName = `publish-${role}`;
      if (shouldFail(eventName)) {
        return deepFreeze({ outcome: 'conditional-mutation-mismatch' });
      }
      if (!expectedMatchesCurrent(role, expected)) {
        return deepFreeze({ outcome: 'conditional-mutation-mismatch' });
      }
      if (state.forgedReplaceNoMutationRole === role) {
        state.forgedReplaceNoMutationRole = null;
        const current = currentFileIdentity(role);
        return deepFreeze({
          outcome: 'ok',
          identity: publisherIdentity(role, {
            ...current,
            sha256: sha256Hex(bytes),
          }),
        });
      }
      recordSimpleEvent(eventName);
      recordAdapterCall('host-mutation', role);
      placeFile(role, bytes);
      counters.publish += 1;
      recordSuccessfulHostMutation(eventName);
      return deepFreeze({ outcome: 'ok', identity: takePublishedIdentity(role) });
    },

    async removeIfMatch(input) {
      const fields = readExactObject(input, ['rootId', 'basename', 'expected']);
      const role = roleForAddress(fields.rootId, fields.basename);
      recordAtomicExpectedAttempt('remove', role, fields.expected);
      const expected = readExpectedIdentity(role, fields.expected);
      const eventName = `remove-${role}`;
      if (shouldFail(eventName)) {
        return deepFreeze({ outcome: 'conditional-mutation-mismatch' });
      }
      if (!expectedMatchesCurrent(role, expected)) {
        return deepFreeze({ outcome: 'conditional-mutation-mismatch' });
      }
      recordSimpleEvent(eventName);
      recordAdapterCall('host-mutation', role);
      removeFile(role);
      counters.remove += 1;
      recordSuccessfulHostMutation(eventName);
      return deepFreeze({ outcome: 'ok' });
    },
  });

  // ---- launchctlRunner：仅接受 validateLaunchctlRequest 兼容精确输入 ----
  function mapPrintEvent(role) {
    const phase = state.printPhase[role];
    if (phase === 'inspect') return `inspect-job-${role}`;
    if (phase === 'verify-then-outcome') {
      state.printPhase[role] = 'outcome';
      return `verify-job-${role}`;
    }
    if (phase === 'outcome') {
      state.printPhase[role] = 'verify';
      return 'verify-scheduler-outcome';
    }
    return `verify-job-${role}`;
  }

  const launchctlRunner = Object.freeze({
    async run(request) {
      // production-facing request 不得带 purpose/phase/unknown key
      const validated = validateLaunchctlRequest(request);
      const { operation, role } = validated;

      if (operation === 'bootstrap' || operation === 'bootout') {
        const eventName = `${operation}-${role}`;
        recordSimpleEvent(eventName);
        recordAdapterCall('host-mutation', role);
        // 一旦发出 mutation runner 调用，即使失败也计入 hostMutationCount
        if (operation === 'bootstrap') counters.bootstrap += 1;
        else counters.bootout += 1;
        if (shouldFail(eventName)) {
          return deepFreeze({ outcome: 'nonzero-exit' });
        }
        if (
          state.strictLaunchctlTransitions
          && operation === 'bootstrap'
          && state.loaded[role]
        ) {
          return deepFreeze({ outcome: 'nonzero-exit' });
        }
        if (operation === 'bootstrap') {
          state.loaded[role] = true;
          state.jobIdentity[role] = computeJobIdentity(role);
          state.foreignJob[role] = false;
          state.printPhase[role] = role === 'scheduler' ? 'verify-then-outcome' : 'verify';
        } else {
          state.loaded[role] = false;
          state.jobIdentity[role] = null;
          state.printPhase[role] = 'verify';
        }
        recordSuccessfulHostMutation(`${operation}-${role}`);
        return deepFreeze({ outcome: 'ok' });
      }

      if (operation === 'kickstart') invalid();
      if (operation !== 'print') invalid();

      const eventName = mapPrintEvent(role);
      recordAdapterCall('inspect-job', role);
      counters.print += 1;
      recordSimpleEvent(eventName);
      if (shouldFail(eventName) || state.probeMode[role] === 'unknown') {
        return deepFreeze({ outcome: 'unknown-result' });
      }
      const result = {
        outcome: 'ok',
        loaded: state.loaded[role],
        jobIdentitySha256: state.loaded[role] ? state.jobIdentity[role] : null,
      };
      if (eventName === 'verify-scheduler-outcome') {
        result.scheduledOutcome = state.schedulerOutcome;
      }
      return deepFreeze(result);
    },
  });

  // ---- health / profile / plist / clock ----
  const healthChecker = Object.freeze({
    async check(input) {
      const fields = readExactObject(input, ['port']);
      if (!Number.isSafeInteger(fields.port) || fields.port < 1 || fields.port > 65535) invalid();
      counters.health += 1;
      recordSimpleEvent('health-controller');
      if (shouldFail('health-controller')) {
        return deepFreeze({ statusCode: 503, ready: false, count: null });
      }
      return deepFreeze({ ...state.health });
    },
  });

  const profileRenderer = Object.freeze({
    async render(input) {
      const fields = readExactObject(input, [
        'sourceCommit', 'scheduleSeconds', 'controllerEnvironment',
      ]);
      if (typeof fields.sourceCommit !== 'string' || !COMMIT_RE.test(fields.sourceCommit)) invalid();
      if (
        !Number.isSafeInteger(fields.scheduleSeconds)
        || fields.scheduleSeconds < LAUNCHAGENT_LIFECYCLE.scheduleSeconds.min
        || fields.scheduleSeconds > LAUNCHAGENT_LIFECYCLE.scheduleSeconds.max
      ) {
        invalid();
      }
      const environment = readExactObject(
        fields.controllerEnvironment,
        Object.keys(fields.controllerEnvironment),
      );
      for (const key of Object.keys(environment)) {
        if (typeof environment[key] !== 'string') invalid();
      }
      counters.render += 1;
      const profiles = makeProfiles(
        fields.scheduleSeconds,
        fields.controllerEnvironment,
        state.runtimeArtifacts,
      );
      state.lastRenderedRuntimeArtifacts = structuredClone(
        profiles.manifestRuntimeArtifacts,
      );
      return deepFreeze({
        ...profiles,
        publicProjection: {
          sourceCommit: fields.sourceCommit,
          ...profiles.publicProjection,
        },
      });
    },

    async revalidate(reason) {
      if (typeof reason !== 'string' || !REVALIDATION_REASONS.has(reason)) invalid();
      counters.revalidate += 1;
      revalidateMarks.push(reason);
      if (state.revalidationFailures.delete(reason)) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.ROLLBACK_RUNTIME_MISMATCH);
      }
      if (
        state.lastRenderedRuntimeArtifacts !== null
        && JSON.stringify(state.runtimeArtifacts)
          !== JSON.stringify(state.lastRenderedRuntimeArtifacts)
      ) {
        return deepFreeze({ ok: false, reason });
      }
      return deepFreeze({ ok: true, reason });
    },
  });

  const plistValidator = Object.freeze({
    async validate(candidateRef) {
      // 协调层显式 kind 映射后的 launchagent-candidate ref
      const fields = readExactObject(candidateRef, [
        'kind', 'transactionId', 'role', 'sha256',
      ]);
      if (fields.kind !== 'launchagent-candidate') invalid();
      requireUuid(fields.transactionId);
      if (fields.role !== 'controller' && fields.role !== 'scheduler') invalid();
      requireSha256(fields.sha256);
      const key = `${fields.transactionId}:${fields.role}`;
      const staged = candidates.get(key);
      if (!staged || staged.sha256 !== fields.sha256) invalid();
      recordAdapterCall('plist-validate', fields.role);
      counters.plistValidate += 1;
      if (!state.plistLintValid[fields.role]) {
        return deepFreeze({ valid: false, outcome: 'invalid' });
      }
      return deepFreeze({ valid: true, outcome: 'valid' });
    },
  });

  const clock = Object.freeze({
    now() {
      clockNowCount += 1;
      return nowIso();
    },
    newId() {
      clockNewIdCount += 1;
      return queuedClockIds.length > 0 ? queuedClockIds.shift() : nextUuid();
    },
  });

  // ---- metadataStore ----
  function lockSha256(record) {
    return sha256Hex(Buffer.from(JSON.stringify(record), 'utf8'));
  }

  function validateLockRecord(record) {
    const fields = readExactObject(record, [...LOCK_KEYS]);
    if (fields.schemaVersion !== 1) invalid();
    requireUuid(fields.transactionId);
    requireUuid(fields.ownerNonce);
    if (fields.transactionId === fields.ownerNonce) invalid();
    if (!Number.isSafeInteger(fields.ownerPid) || fields.ownerPid <= 0) invalid();
    for (const key of ['bootSessionIdentity', 'processStartIdentity']) {
      const identity = readExactObject(fields[key], ['available', 'value']);
      if (identity.available === false) {
        if (identity.value !== null) invalid();
      } else if (identity.available === true) {
        if (typeof identity.value !== 'string' || identity.value.length === 0) invalid();
      } else {
        invalid();
      }
    }
    return {
      schemaVersion: 1,
      transactionId: fields.transactionId,
      ownerPid: fields.ownerPid,
      ownerNonce: fields.ownerNonce,
      bootSessionIdentity: { ...fields.bootSessionIdentity },
      processStartIdentity: { ...fields.processStartIdentity },
    };
  }

  function lockRefMatches(record, ref, expectedKind) {
    if (ref === null || typeof ref !== 'object') invalid();
    const ownKeys = Reflect.ownKeys(ref).filter((k) => typeof k === 'string');
    if (ownKeys.length !== 4) invalid();
    for (const key of ['kind', 'transactionId', 'ownerNonce', 'sha256']) {
      if (!Object.hasOwn(ref, key)) invalid();
    }
    if (ref.kind !== expectedKind || record === null) return false;
    return (
      ref.transactionId === record.transactionId
      && ref.ownerNonce === record.ownerNonce
      && ref.sha256 === lockSha256(record)
    );
  }

  function latestJournalEntry(transactionId) {
    let latest = null;
    for (const entry of store.journal) {
      if (entry.transactionId === transactionId) latest = entry;
    }
    return latest;
  }

  function validateJournalEntryShape(entry) {
    const projection = validateLaunchAgentJournal(entry);
    if (computeJournalEntrySha256(projection) !== projection.entrySha256) invalid();
    return projection;
  }

  function verifyWriterLockRef(writerLockRef, transactionId) {
    const fields = readExactObject(writerLockRef, [
      'kind', 'transactionId', 'ownerNonce', 'sha256',
    ]);
    if (fields.kind === 'transaction-lock') {
      if (!lockRefMatches(store.transactionLock, fields, 'transaction-lock')) invalid();
    } else if (fields.kind === 'manual-intervention-lock') {
      if (!lockRefMatches(store.manualInterventionLock, fields, 'manual-intervention-lock')) {
        invalid();
      }
    } else {
      invalid();
    }
    if (fields.transactionId !== transactionId) invalid();
  }

  function assertReceiptAlignedWithTerminal(receiptProjection, receiptSha, terminal) {
    if (terminal === null || !TERMINAL_JOURNAL_STATES.has(terminal.state)) invalid();
    if (terminal.state !== receiptProjection.state) invalid();
    if (terminal.operation !== receiptProjection.operation) invalid();
    if (terminal.transactionId !== receiptProjection.transactionId) invalid();
    if (
      terminal.payload === null
      || typeof terminal.payload !== 'object'
      || terminal.payload.hostMutationCount !== receiptProjection.hostMutationCount
    ) {
      invalid();
    }
    if (terminal.payload.receiptSha256 !== receiptSha) invalid();
  }

  const metadataStore = Object.freeze({
    async readJournalHeads() {
      if (arguments.length !== 0) invalid();
      const latestByTransaction = new Map();
      for (const storedEntry of store.journal) {
        const entry = validateJournalEntryShape(storedEntry);
        const prior = latestByTransaction.get(entry.transactionId);
        if (prior === undefined) {
          if (entry.sequence !== 0 || entry.previousEntrySha256 !== null) invalid();
        } else {
          if (entry.sequence !== prior.sequence + 1) invalid();
          if (entry.previousEntrySha256 !== prior.entrySha256) invalid();
          if (entry.operation !== prior.operation) invalid();
        }
        latestByTransaction.set(entry.transactionId, entry);
      }
      const heads = [...latestByTransaction.entries()]
        .sort(([left], [right]) => {
          if (left < right) return -1;
          if (left > right) return 1;
          return 0;
        })
        .map(([, entry]) => structuredClone(entry));
      const bytes = Buffer.from(
        store.journal.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
        'utf8',
      );
      counters.readJournalHeads += 1;
      counters.journal += 1;
      recordAdapterCall('read-journal-heads');
      recordSimpleEvent('journal');
      return deepFreeze({
        kind: 'journal-heads',
        journalSha256: sha256Hex(bytes),
        heads,
      });
    },

    async readJournal(input) {
      const fields = readExactObject(input, ['transactionId']);
      const transactionId = requireUuid(fields.transactionId);
      counters.readJournal += 1;
      counters.journal += 1;
      recordAdapterCall('read-journal');
      recordSimpleEvent('journal');
      return deepFreeze(store.journal.filter((e) => e.transactionId === transactionId));
    },

    async appendJournal(input) {
      const fields = readExactObject(input, ['entry', 'expectedPrior', 'writerLockRef']);
      const entry = validateJournalEntryShape(fields.entry);
      verifyWriterLockRef(fields.writerLockRef, entry.transactionId);
      recordAdapterCall('append-journal');
      const latest = latestJournalEntry(entry.transactionId);
      if (latest === null) {
        if (fields.expectedPrior !== null) invalid();
        if (entry.sequence !== 0 || entry.previousEntrySha256 !== null) invalid();
      } else {
        const prior = readExactObject(fields.expectedPrior, [
          'transactionId', 'sequence', 'entrySha256',
        ]);
        if (prior.transactionId !== latest.transactionId) invalid();
        if (prior.sequence !== latest.sequence) invalid();
        if (prior.entrySha256 !== latest.entrySha256) invalid();
        if (entry.sequence !== latest.sequence + 1) invalid();
        if (entry.previousEntrySha256 !== latest.entrySha256) invalid();
        if (entry.operation !== latest.operation) invalid();
      }

      const compensateMatch = entry.state.match(COMPENSATION_STATE_PATTERN);
      if (compensateMatch) {
        if (!COMPENSATION_ACTION_SET.has(compensateMatch[1])) {
          throw harnessError(`unknown compensation action: ${compensateMatch[1]}`);
        }
        if (!COMPENSATION_PHASE_SET.has(compensateMatch[2])) {
          throw harnessError(`unknown compensation phase: ${compensateMatch[2]}`);
        }
      }

      store.journal.push(deepFreeze({ ...entry, payload: deepFreeze({ ...entry.payload }) }));
      // journal entry 已持久化且 writer lock/chain 校验通过后才允许 crash capture；
      // capture 必须早于 observation hooks，保证 image 不含观察态。
      maybeCaptureCrash('journal-state', entry.state);
      counters.journal += 1;
      if (compensateMatch) {
        recordCompensationEvent(compensateMatch[1], compensateMatch[2]);
      } else {
        recordSimpleEvent('journal');
      }
      return deepFreeze({
        kind: 'journal-entry',
        transactionId: entry.transactionId,
        sequence: entry.sequence,
        entrySha256: entry.entrySha256,
      });
    },

    async writeCandidate(input) {
      const fields = readExactObject(input, ['transactionId', 'role', 'bytes']);
      const transactionId = requireUuid(fields.transactionId);
      const role = fields.role;
      if (role !== 'controller' && role !== 'scheduler' && role !== 'manifest') invalid();
      if (!Buffer.isBuffer(fields.bytes) || fields.bytes.byteLength === 0) invalid();
      const bytes = Buffer.from(fields.bytes);
      const digest = sha256Hex(bytes);
      const key = `${transactionId}:${role}`;
      if (candidates.has(key)) invalid();
      candidates.set(key, { bytes, sha256: digest, role, transactionId });
      recordAdapterCall('write-candidate', role);
      counters.writeCandidate += 1;
      // store 契约：kind 为 candidate（非 launchagent-candidate）
      return deepFreeze({
        kind: 'candidate',
        transactionId,
        role,
        sha256: digest,
      });
    },

    async readCandidate(ref) {
      const fields = readExactObject(ref, ['kind', 'transactionId', 'role', 'sha256']);
      if (fields.kind !== 'candidate') invalid();
      requireUuid(fields.transactionId);
      if (
        fields.role !== 'controller'
        && fields.role !== 'scheduler'
        && fields.role !== 'manifest'
      ) {
        invalid();
      }
      requireSha256(fields.sha256);
      const staged = candidates.get(`${fields.transactionId}:${fields.role}`);
      if (!staged || staged.sha256 !== fields.sha256) invalid();
      counters.readCandidate += 1;
      return Buffer.from(staged.bytes);
    },

    async writeAnchor(anchor) {
      const selectedAnchor = nextAnchorOverride === null
        ? anchor
        : structuredClone(nextAnchorOverride);
      nextAnchorOverride = null;
      if (selectedAnchor === null || typeof selectedAnchor !== 'object') invalid();
      if (Object.getPrototypeOf(selectedAnchor) !== Object.prototype) invalid();
      recordAdapterCall('write-anchor');
      const projection = validateLaunchAgentAnchor(selectedAnchor);
      const anchorId = requireUuid(projection.anchorId);
      if (store.anchors.has(anchorId)) invalid();
      counters.anchor += 1;
      recordSimpleEvent('anchor');
      const snapshot = deepFreeze(structuredClone(projection));
      store.anchors.set(anchorId, snapshot);
      return deepFreeze({
        kind: 'anchor',
        anchorId,
        sha256: sha256Hex(Buffer.from(JSON.stringify(snapshot), 'utf8')),
      });
    },

    async readAnchor(anchorIdInput) {
      const anchorId = requireUuid(anchorIdInput);
      counters.readAnchor += 1;
      recordAdapterCall('read-anchor');
      const snapshot = store.anchors.get(anchorId);
      if (!snapshot) invalid();
      return deepFreeze(structuredClone(snapshot));
    },

    async acquireTransactionLock(record) {
      const projection = validateLockRecord(record);
      recordAdapterCall('lock-acquire');
      recordSimpleEvent('lock-acquire');
      if (store.manualInterventionLock !== null) coded(CODE_MIR);
      if (store.transactionLock !== null) coded(CODE_TX);
      store.transactionLock = projection;
      // 仅成功 acquisition 记入观测历史（失败路径不记录）。
      lockAcquisitionHistory.push(deepFreeze({
        kind: 'transaction-lock',
        record: deepFreeze({
          schemaVersion: projection.schemaVersion,
          transactionId: projection.transactionId,
          ownerPid: projection.ownerPid,
          ownerNonce: projection.ownerNonce,
          bootSessionIdentity: {
            available: projection.bootSessionIdentity.available,
            value: projection.bootSessionIdentity.value,
          },
          processStartIdentity: {
            available: projection.processStartIdentity.available,
            value: projection.processStartIdentity.value,
          },
        }),
      }));
      return deepFreeze({
        kind: 'transaction-lock',
        transactionId: projection.transactionId,
        ownerNonce: projection.ownerNonce,
        sha256: lockSha256(projection),
      });
    },

    async verifyTransactionLock(ref) {
      if (!lockRefMatches(store.transactionLock, ref, 'transaction-lock')) invalid();
      counters.lockVerify += 1;
      recordAdapterCall('lock-verify');
      return true;
    },

    async releaseTransactionLock(ref, options) {
      if (arguments.length > 1) {
        const optFields = readExactObject(options, ['manualInterventionLockRef']);
        if (!lockRefMatches(store.transactionLock, ref, 'transaction-lock')) invalid();
        if (
          !lockRefMatches(
            store.manualInterventionLock,
            optFields.manualInterventionLockRef,
            'manual-intervention-lock',
          )
        ) {
          invalid();
        }
        if (store.transactionLock.transactionId !== store.manualInterventionLock.transactionId) {
          invalid();
        }
        const latest = latestJournalEntry(store.transactionLock.transactionId);
        if (latest === null || latest.state !== 'manual-intervention-required') invalid();
        // MIR handoff 旧 tx release：不触发 recovery-transaction-lock-released。
        store.transactionLock = null;
        recordSimpleEvent('mir-transaction-lock-release');
        return true;
      }
      if (!lockRefMatches(store.transactionLock, ref, 'transaction-lock')) invalid();
      const transactionId = store.transactionLock.transactionId;
      const latest = latestJournalEntry(transactionId);
      if (latest === null || !TERMINAL_JOURNAL_STATES.has(latest.state)) invalid();
      const receipt = store.receipts.get(transactionId);
      if (!receipt) invalid();
      assertReceiptAlignedWithTerminal(receipt.projection, receipt.sha256, latest);
      // 普通 terminal release：durable null 后捕获，先于 observation hook/trace。
      store.transactionLock = null;
      maybeCaptureCrash('event', 'recovery-transaction-lock-released');
      recordSimpleEvent('lock-release');
      return true;
    },

    async acquireManualInterventionLock(record) {
      const projection = validateLockRecord(record);
      recordSimpleEvent('mir-lock-publish');
      if (store.transactionLock === null) invalid();
      if (store.transactionLock.transactionId !== projection.transactionId) invalid();
      if (store.transactionLock.ownerNonce === projection.ownerNonce) invalid();
      if (store.manualInterventionLock !== null) coded(CODE_MIR);
      store.manualInterventionLock = projection;
      lockAcquisitionHistory.push(deepFreeze({
        kind: 'manual-intervention-lock',
        record: deepFreeze({
          schemaVersion: projection.schemaVersion,
          transactionId: projection.transactionId,
          ownerPid: projection.ownerPid,
          ownerNonce: projection.ownerNonce,
          bootSessionIdentity: {
            available: projection.bootSessionIdentity.available,
            value: projection.bootSessionIdentity.value,
          },
          processStartIdentity: {
            available: projection.processStartIdentity.available,
            value: projection.processStartIdentity.value,
          },
        }),
      }));
      return deepFreeze({
        kind: 'manual-intervention-lock',
        transactionId: projection.transactionId,
        ownerNonce: projection.ownerNonce,
        sha256: lockSha256(projection),
      });
    },

    async verifyManualInterventionLock(ref) {
      recordSimpleEvent('mir-lock-verify');
      if (!lockRefMatches(store.manualInterventionLock, ref, 'manual-intervention-lock')) {
        invalid();
      }
      return true;
    },

    async publishReceipt(input) {
      const fields = readExactObject(input, ['receipt', 'lockRef']);
      const projection = validateLaunchAgentReceipt(fields.receipt);
      if (!TERMINAL_JOURNAL_STATES.has(projection.state)) invalid();
      const receiptSha = sha256Hex(Buffer.from(JSON.stringify(projection), 'utf8'));
      verifyWriterLockRef(fields.lockRef, projection.transactionId);
      const latest = latestJournalEntry(projection.transactionId);
      if (latest === null) invalid();
      assertReceiptAlignedWithTerminal(projection, receiptSha, latest);
      // Task 5 Step 2 race 注入：只在 pending id 匹配时消费；从当时 validated
      // terminal payload 派生 exact embedded projection，hash 必须闭合；随后仍走
      // 既有 receipt-exists failure，publishReceipt 绝不静默成功。
      if (exactReceiptRaceTransactionId === projection.transactionId) {
        exactReceiptRaceTransactionId = null;
        const embedded = validateLaunchAgentReceipt(latest.payload.receipt);
        const embeddedSha256 = sha256Hex(Buffer.from(JSON.stringify(embedded), 'utf8'));
        if (embeddedSha256 !== latest.payload.receiptSha256) invalid();
        store.receipts.set(projection.transactionId, {
          projection: embedded,
          sha256: embeddedSha256,
        });
      }
      if (store.receipts.has(projection.transactionId)) invalid();
      // durable receipt 写入完成后捕获；不得复用 mutation 前的 trace 时机。
      store.receipts.set(projection.transactionId, { projection, sha256: receiptSha });
      maybeCaptureCrash('event', 'receipt-published');
      counters.receipt += 1;
      recordSimpleEvent('receipt');
      return deepFreeze({
        kind: 'receipt',
        transactionId: projection.transactionId,
        sha256: receiptSha,
      });
    },

    async readReceipt(transactionIdInput) {
      const transactionId = requireUuid(transactionIdInput);
      recordAdapterCall('read-receipt');
      const stored = store.receipts.get(transactionId);
      if (!stored) invalid();
      counters.receipt += 1;
      return stored.projection;
    },

    async classifyReceipt(transactionIdInput) {
      const transactionId = requireUuid(transactionIdInput);
      recordAdapterCall('classify-receipt');
      const stored = store.receipts.get(transactionId);
      if (!stored) return deepFreeze({ status: 'missing' });
      // 与生产对齐的只读三态分类：strict schema/transaction binding + canonical
      // sha 复核区分 valid/invalid；不写 receipt 计数、不改 store、不 heal。
      try {
        const projection = validateLaunchAgentReceipt(stored.projection);
        if (projection.transactionId !== transactionId) invalid();
        const canonical = sha256Hex(Buffer.from(JSON.stringify(projection), 'utf8'));
        if (canonical !== stored.sha256) invalid();
        return deepFreeze({ status: 'valid', receipt: projection });
      } catch (error) {
        if (error instanceof LaunchAgentLifecycleError) {
          return deepFreeze({ status: 'invalid' });
        }
        throw error;
      }
    },

    // ---- Task 6B.1 Task 5：attestation / lock observation / recovery claim / recovery lock ----

    async writeManualRepairAttestation(record) {
      const projection = validateLaunchAgentManualRepairAttestation(record);
      const manualRepairConfirmationId = projection.manualRepairConfirmationId;
      if (store.attestations.has(manualRepairConfirmationId)) {
        coded(CODE_CONFIRMATION_CONSUMED);
      }
      recordSimpleEvent('attestation-file-sync');
      recordSimpleEvent('attestation-directory-sync');
      const frozen = deepFreeze(structuredClone(projection));
      // durable attestation 写入完成后捕获，先于 verify observation/trace。
      store.attestations.set(manualRepairConfirmationId, frozen);
      maybeCaptureCrash('event', 'attestation-verify');
      recordSimpleEvent('attestation-verify');
      return deepFreeze({
        kind: 'manual-repair-attestation',
        manualRepairConfirmationId,
        sha256: sha256Hex(Buffer.from(JSON.stringify(projection), 'utf8')),
      });
    },

    async readManualRepairAttestation(manualRepairConfirmationIdInput) {
      const manualRepairConfirmationId = requireUuid(manualRepairConfirmationIdInput);
      const stored = store.attestations.get(manualRepairConfirmationId);
      if (stored === undefined) invalid();
      return deepFreeze(structuredClone(stored));
    },

    async readTransactionLockObservation() {
      if (arguments.length !== 0) invalid();
      if (store.transactionLock === null) return null;
      const record = deepFreeze(structuredClone(store.transactionLock));
      return deepFreeze({
        kind: 'transaction-lock-observation',
        ref: deepFreeze({
          kind: 'transaction-lock',
          transactionId: record.transactionId,
          ownerNonce: record.ownerNonce,
          sha256: lockSha256(record),
        }),
        record,
      });
    },

    async readManualInterventionLockObservation() {
      if (arguments.length !== 0) invalid();
      if (store.manualInterventionLock === null) return null;
      const record = deepFreeze(structuredClone(store.manualInterventionLock));
      return deepFreeze({
        kind: 'manual-intervention-lock-observation',
        ref: deepFreeze({
          kind: 'manual-intervention-lock',
          transactionId: record.transactionId,
          ownerNonce: record.ownerNonce,
          sha256: lockSha256(record),
        }),
        record,
      });
    },

    async readRecoveryClaimObservation() {
      if (arguments.length !== 0) invalid();
      const present = store.recoveryClaim !== null;
      // Test-only observation history（不进 production contract / dependencies）。
      recoveryClaimObservationHistory.push(deepFreeze({ present }));
      if (!present) return null;
      const record = deepFreeze(structuredClone(store.recoveryClaim.record));
      return deepFreeze({
        kind: 'recovery-claim-observation',
        ref: deepFreeze(structuredClone(store.recoveryClaim.ref)),
        record,
      });
    },

    async acquireRecoveryLockForManualRepair(input) {
      const fields = readExactObject(input, [
        'record', 'claimId', 'expectedTransactionLockRef', 'manualInterventionLockRef',
      ]);
      const freshRecord = validateLockRecord(fields.record);
      const claimId = requireUuid(fields.claimId);
      if (claimId === freshRecord.transactionId || claimId === freshRecord.ownerNonce) invalid();

      let expectedTransactionLockRef = null;
      if (fields.expectedTransactionLockRef !== null) {
        const er = readExactObject(fields.expectedTransactionLockRef, [
          'kind', 'transactionId', 'ownerNonce', 'sha256',
        ]);
        if (er.kind !== 'transaction-lock') invalid();
        expectedTransactionLockRef = deepFreeze({
          kind: 'transaction-lock',
          transactionId: requireUuid(er.transactionId),
          ownerNonce: requireUuid(er.ownerNonce),
          sha256: requireSha256(er.sha256),
        });
      }
      const mirRefFields = readExactObject(fields.manualInterventionLockRef, [
        'kind', 'transactionId', 'ownerNonce', 'sha256',
      ]);
      if (mirRefFields.kind !== 'manual-intervention-lock') invalid();
      const manualInterventionLockRef = deepFreeze({
        kind: 'manual-intervention-lock',
        transactionId: requireUuid(mirRefFields.transactionId),
        ownerNonce: requireUuid(mirRefFields.ownerNonce),
        sha256: requireSha256(mirRefFields.sha256),
      });

      if (!lockRefMatches(store.manualInterventionLock, manualInterventionLockRef, 'manual-intervention-lock')) {
        invalid();
      }

      if (expectedTransactionLockRef === null) {
        if (store.transactionLock !== null) invalid();
      } else if (!lockRefMatches(store.transactionLock, expectedTransactionLockRef, 'transaction-lock')) {
        invalid();
      }

      // Test-only race arm：仅在已验证 input/MIR/expected 之后、claim 检查点之前注入 winner。
      // 此前 readRecoveryClaimObservation 必须真实返回 null；注入后既有 race-loser 路径失败。
      if (raceRecoveryClaimArm !== null) {
        store.recoveryClaim = raceRecoveryClaimArm;
        raceRecoveryClaimArm = null;
      }

      // Claim race loser: keep winner, zero tx mutation
      if (store.recoveryClaim !== null) {
        coded(CODE_TX);
      }

      const freshSha = lockSha256(freshRecord);
      const freshTransactionLockRef = deepFreeze({
        kind: 'transaction-lock',
        transactionId: freshRecord.transactionId,
        ownerNonce: freshRecord.ownerNonce,
        sha256: freshSha,
      });

      const claimRecord = deepFreeze({
        schemaVersion: 1,
        kind: 'recovery-claim-lock',
        claimId,
        transactionId: freshRecord.transactionId,
        ownerPid: freshRecord.ownerPid,
        ownerNonce: freshRecord.ownerNonce,
        bootSessionIdentity: {
          available: freshRecord.bootSessionIdentity.available,
          value: freshRecord.bootSessionIdentity.value,
        },
        processStartIdentity: {
          available: freshRecord.processStartIdentity.available,
          value: freshRecord.processStartIdentity.value,
        },
        expectedTransactionLockRef,
        manualInterventionLockRef,
        freshTransactionLockRef,
      });
      const claimSha = sha256Hex(Buffer.from(JSON.stringify(claimRecord), 'utf8'));
      const claimRef = deepFreeze({
        kind: 'recovery-claim-lock',
        claimId,
        transactionId: freshRecord.transactionId,
        ownerNonce: freshRecord.ownerNonce,
        sha256: claimSha,
      });

      // claim durable 完成且旧 tx 仍 intact 时捕获。
      store.recoveryClaim = { record: claimRecord, ref: claimRef };
      maybeCaptureCrash('event', 'recovery-claim-durable-old-intact');

      if (expectedTransactionLockRef !== null) {
        if (!lockRefMatches(store.transactionLock, expectedTransactionLockRef, 'transaction-lock')) {
          coded(CODE_TX);
        }
        // 仅 expected old tx 非空且成功清 null 后捕获。
        store.transactionLock = null;
        maybeCaptureCrash('event', 'old-transaction-lock-removed');
      }

      if (store.transactionLock !== null) {
        coded(CODE_TX);
      }
      store.transactionLock = {
        schemaVersion: 1,
        transactionId: freshRecord.transactionId,
        ownerPid: freshRecord.ownerPid,
        ownerNonce: freshRecord.ownerNonce,
        bootSessionIdentity: { ...freshRecord.bootSessionIdentity },
        processStartIdentity: { ...freshRecord.processStartIdentity },
      };
      // fresh tx durable 且 claim 仍 present 时捕获；先于 history/observation。
      maybeCaptureCrash('event', 'fresh-transaction-lock-published');
      lockAcquisitionHistory.push(deepFreeze({
        kind: 'transaction-lock',
        record: deepFreeze(structuredClone(store.transactionLock)),
      }));

      // claim 删除后、fresh tx 已 durable 时捕获 recovery-lock-acquire。
      store.recoveryClaim = null;
      maybeCaptureCrash('event', 'recovery-lock-acquire');
      // Claim 已精确删除：detached history 仍可证明 coordinator 传入的 claimId/tx/nonce。
      recoveryAcquisitionHistory.push(deepFreeze({
        claimId,
        transactionId: freshRecord.transactionId,
        ownerNonce: freshRecord.ownerNonce,
      }));
      recordSimpleEvent('recovery-lock-acquire');
      if (postLockSnapshotArmed) {
        postLockSnapshotArmed = false;
        recordSimpleEvent('post-lock-snapshot');
      }
      return deepFreeze({
        kind: 'transaction-lock',
        transactionId: freshRecord.transactionId,
        ownerNonce: freshRecord.ownerNonce,
        sha256: freshSha,
      });
    },

    async abortRecoveryLockForManualRepair(input) {
      const fields = readExactObject(input, [
        'transactionLockRef', 'manualInterventionLockRef', 'expectedMirHead',
      ]);
      const txRef = readExactObject(fields.transactionLockRef, [
        'kind', 'transactionId', 'ownerNonce', 'sha256',
      ]);
      if (txRef.kind !== 'transaction-lock') invalid();
      const mirRef = readExactObject(fields.manualInterventionLockRef, [
        'kind', 'transactionId', 'ownerNonce', 'sha256',
      ]);
      if (mirRef.kind !== 'manual-intervention-lock') invalid();
      const mirHead = readExactObject(fields.expectedMirHead, ['transactionId', 'entrySha256']);
      const expectedMirHead = {
        transactionId: requireUuid(mirHead.transactionId),
        entrySha256: requireSha256(mirHead.entrySha256),
      };
      if (txRef.transactionId !== mirRef.transactionId) invalid();
      if (txRef.transactionId !== expectedMirHead.transactionId) invalid();
      if (!lockRefMatches(store.transactionLock, txRef, 'transaction-lock')) invalid();
      if (!lockRefMatches(store.manualInterventionLock, mirRef, 'manual-intervention-lock')) invalid();
      const latest = latestJournalEntry(txRef.transactionId);
      if (latest === null || latest.state !== 'manual-intervention-required') invalid();
      if (latest.entrySha256 !== expectedMirHead.entrySha256) invalid();
      store.transactionLock = null;
      if (!lockRefMatches(store.manualInterventionLock, mirRef, 'manual-intervention-lock')) invalid();
      const after = latestJournalEntry(txRef.transactionId);
      if (after === null || after.state !== 'manual-intervention-required') invalid();
      if (after.entrySha256 !== expectedMirHead.entrySha256) invalid();
      return true;
    },

    async resolveRecoveryClaimForManualRepair(input) {
      const fields = readExactObject(input, [
        'recoveryClaimRef', 'manualInterventionLockRef',
      ]);
      const claimRefIn = readExactObject(fields.recoveryClaimRef, [
        'kind', 'claimId', 'transactionId', 'ownerNonce', 'sha256',
      ]);
      if (claimRefIn.kind !== 'recovery-claim-lock') invalid();
      const recoveryClaimRef = {
        kind: 'recovery-claim-lock',
        claimId: requireUuid(claimRefIn.claimId),
        transactionId: requireUuid(claimRefIn.transactionId),
        ownerNonce: requireUuid(claimRefIn.ownerNonce),
        sha256: requireSha256(claimRefIn.sha256),
      };
      const mirRefIn = readExactObject(fields.manualInterventionLockRef, [
        'kind', 'transactionId', 'ownerNonce', 'sha256',
      ]);
      if (mirRefIn.kind !== 'manual-intervention-lock') invalid();
      const manualInterventionLockRef = {
        kind: 'manual-intervention-lock',
        transactionId: requireUuid(mirRefIn.transactionId),
        ownerNonce: requireUuid(mirRefIn.ownerNonce),
        sha256: requireSha256(mirRefIn.sha256),
      };

      if (store.recoveryClaim === null) coded(CODE_RECOVERY_CLAIM_STALLED);
      const claim = store.recoveryClaim;
      if (
        claim.ref.claimId !== recoveryClaimRef.claimId
        || claim.ref.transactionId !== recoveryClaimRef.transactionId
        || claim.ref.ownerNonce !== recoveryClaimRef.ownerNonce
        || claim.ref.sha256 !== recoveryClaimRef.sha256
      ) {
        coded(CODE_RECOVERY_CLAIM_STALLED);
      }
      if (!lockRefMatches(store.manualInterventionLock, manualInterventionLockRef, 'manual-intervention-lock')) {
        coded(CODE_RECOVERY_CLAIM_STALLED);
      }
      const claimMir = claim.record.manualInterventionLockRef;
      if (
        claimMir === null
        || claimMir.kind !== manualInterventionLockRef.kind
        || claimMir.transactionId !== manualInterventionLockRef.transactionId
        || claimMir.ownerNonce !== manualInterventionLockRef.ownerNonce
        || claimMir.sha256 !== manualInterventionLockRef.sha256
      ) {
        coded(CODE_RECOVERY_CLAIM_STALLED);
      }

      let status;
      const current = store.transactionLock;
      const currentRef = current === null ? null : {
        kind: 'transaction-lock',
        transactionId: current.transactionId,
        ownerNonce: current.ownerNonce,
        sha256: lockSha256(current),
      };
      const freshRef = claim.record.freshTransactionLockRef;
      const oldRef = claim.record.expectedTransactionLockRef;
      if (
        currentRef !== null
        && freshRef !== null
        && currentRef.transactionId === freshRef.transactionId
        && currentRef.ownerNonce === freshRef.ownerNonce
        && currentRef.sha256 === freshRef.sha256
      ) {
        status = 'fresh-published';
      } else if (
        oldRef !== null
        && currentRef !== null
        && currentRef.transactionId === oldRef.transactionId
        && currentRef.ownerNonce === oldRef.ownerNonce
        && currentRef.sha256 === oldRef.sha256
      ) {
        status = 'old-intact';
      } else if (current === null) {
        status = 'transaction-lock-absent';
      } else {
        coded(CODE_RECOVERY_CLAIM_STALLED);
      }

      store.recoveryClaim = null;
      recordSimpleEvent('claim-resolve');
      return deepFreeze({ status });
    },

    async releaseManualInterventionLock(ref) {
      if (!lockRefMatches(store.manualInterventionLock, ref, 'manual-intervention-lock')) {
        invalid();
      }
      const transactionId = store.manualInterventionLock.transactionId;
      const latest = latestJournalEntry(transactionId);
      if (latest === null) invalid();
      if (latest.state !== 'recovered' && latest.state !== 'blocked') invalid();
      const receipt = store.receipts.get(transactionId);
      if (!receipt) invalid();
      assertReceiptAlignedWithTerminal(receipt.projection, receipt.sha256, latest);
      // MIR durable 释放后捕获，先于 observation hook/trace。
      store.manualInterventionLock = null;
      maybeCaptureCrash('event', 'mir-lock-released');
      recordSimpleEvent('mir-lock-release');
      return true;
    },

  });

  // Task 6B.0：第九依赖 processIdentityReader（exact current/observe）。
  // 默认 fake current 返回固定 available 身份；observe 由 Task 5 arm 队列驱动。
  const processIdentityReader = Object.freeze({
    async current() {
      processIdentityCurrentCount += 1;
      return deepFreeze({
        bootSessionIdentity: { available: true, value: FAKE_BOOT_SESSION_VALUE },
        processStartIdentity: { available: true, value: FAKE_PROCESS_START_VALUE },
      });
    },
    async observe(_record) {
      // Channel selects owner vs claim-owner observation counters/events.
      if (observeChannel === 'claim') {
        claimOwnerObserveCount += 1;
        const status = claimOwnerObserveQueue.length > 0
          ? claimOwnerObserveQueue.shift()
          : 'unavailable';
        if (claimOwnerObserveCount === 1) recordSimpleEvent('claim-owner-observe-1');
        else if (claimOwnerObserveCount === 2) recordSimpleEvent('claim-owner-observe-2');
        return deepFreeze({ status });
      }
      ownerObserveCount += 1;
      const status = ownerObserveQueue.length > 0
        ? ownerObserveQueue.shift()
        : 'unavailable';
      if (ownerObserveCount === 1) recordSimpleEvent('owner-observe-1');
      else if (ownerObserveCount === 2) recordSimpleEvent('owner-observe-2');
      return deepFreeze({ status });
    },
  });

  // 单一 FULL 依赖袋：metadataStore 暴露完整 COORDINATOR_METADATA_METHODS 表面。
  const dependencies = Object.freeze({
    metadataStore,
    hostInspector,
    profileRenderer,
    plistValidator,
    atomicPublisher,
    launchctlRunner,
    healthChecker,
    clock,
    processIdentityReader,
  });

  function hostMutationCount() {
    return counters.publish + counters.remove + counters.bootout + counters.bootstrap;
  }

  function seedJournalAndReceipt({ transactionId, anchorId, sourceCommit }) {
    const receipt = validateLaunchAgentReceipt({
      schemaVersion: 1,
      operation: 'install',
      state: 'committed',
      success: true,
      sourceCommit,
      transactionId,
      anchorId,
      completedAt: nowIso(),
      roles: {
        controller: { label: LABELS.controller, outcome: 'created', changed: true },
        scheduler: { label: LABELS.scheduler, outcome: 'created', changed: true },
      },
      hostMutationCount: 5,
      outcome: 'completed',
    });
    const receiptSha = sha256Hex(Buffer.from(JSON.stringify(receipt), 'utf8'));
    // 完整 install 链（publish×3 + load×2 = 5 mutations）：共享 transaction
    // prefix validator 不接受压缩的 prepared->committed，seed 必须与真实
    // coordinator 写出的链一样逐条满足 forward/terminal transition。
    const chain = [
      ['prepared', 0, null],
      ['anchored', 0, null],
      ['controller-publish-intent', 0, 'controller'],
      ['controller-published', 1, 'controller'],
      ['scheduler-publish-intent', 1, 'scheduler'],
      ['scheduler-published', 2, 'scheduler'],
      ['manifest-publish-intent', 2, 'manifest'],
      ['manifest-published', 3, 'manifest'],
      ['controller-load-intent', 3, 'controller'],
      ['controller-loaded', 4, null],
      ['controller-ready', 4, null],
      ['scheduler-load-intent', 4, 'scheduler'],
      ['scheduler-loaded', 5, null],
    ];
    const entries = [];
    let previousEntrySha256 = null;
    for (const [index, [state, hostMutationCount, role]] of chain.entries()) {
      const payload = { hostMutationCount };
      if (role !== null) payload.role = role;
      const entry = {
        schemaVersion: 1,
        transactionId,
        sequence: index,
        previousEntrySha256,
        operation: 'install',
        state,
        at: nowIso(),
        payload,
      };
      entry.entrySha256 = computeJournalEntrySha256(entry);
      entries.push(entry);
      previousEntrySha256 = entry.entrySha256;
    }
    const committed = {
      schemaVersion: 1,
      transactionId,
      sequence: entries.length,
      previousEntrySha256,
      operation: 'install',
      state: 'committed',
      at: nowIso(),
      payload: { hostMutationCount: 5, receiptSha256: receiptSha },
    };
    committed.entrySha256 = computeJournalEntrySha256(committed);
    entries.push(committed);
    store.journal.push(
      ...entries.map((entry) => deepFreeze(validateJournalEntryShape(entry))),
    );
    store.receipts.set(transactionId, { projection: receipt, sha256: receiptSha });
  }

  function anchorEntryFor(role) {
    const bytes = harness.fileBytes(role);
    const identity = currentFileIdentity(role);
    if (bytes === null || identity === null) {
      throw harnessError(`cannot build anchor entry for absent role: ${role}`);
    }
    return {
      priorState: 'bytes',
      bytesBase64: bytes.toString('base64'),
      sha256: identity.sha256,
      identity: {
        rootId: role === 'manifest' ? ROOT_METADATA : ROOT_LAUNCH_AGENTS,
        basename: FILENAMES[role],
        type: 'regular-file',
        ownerUid: FIXED_UID,
        device: identity.device,
        inode: identity.inode,
        sha256: identity.sha256,
      },
    };
  }

  // ---- Task 5A.2 crash image：只序列化 durable allowlist，禁止 hooks/函数/Buffer 泄露 ----
  // Task 4A：schemaVersion 保持 1（现有测试只通过 branded capture→revive 闭环，
  // 无一断言 image.schemaVersion；升 2 无收益）。新增 Task 5 durable 字段
  // attestations / recoveryClaim 写入同一 v1 image；restore 经 validator/hash/binding 重算，
  // 禁止盲信 image 字节。
  // Task 6B.2 Task 5：selectedFakeHostActionEvidence 同入 v1 allowlist。
  function captureDurableState() {
    const image = deepFreeze({
      schemaVersion: 1,
      files: [...files.entries()].map(([key, file]) => ({
        key,
        bytesBase64: encodeBytes(file.bytes),
        device: file.device,
        inode: file.inode,
        ownerUid: file.ownerUid,
      })),
      candidates: [...candidates.entries()].map(([key, candidate]) => ({
        key,
        bytesBase64: encodeBytes(candidate.bytes),
        sha256: candidate.sha256,
        role: candidate.role,
        transactionId: candidate.transactionId,
      })),
      journal: structuredClone(store.journal),
      anchors: [...store.anchors.entries()].map(([key, value]) => [key, structuredClone(value)]),
      receipts: [...store.receipts.entries()].map(([key, value]) => [key, structuredClone(value)]),
      transactionLock: structuredClone(store.transactionLock),
      manualInterventionLock: structuredClone(store.manualInterventionLock),
      // Task 5 durable：attestation Map + 单例 recovery claim（record+ref 或 null）。
      attestations: [...store.attestations.entries()].map(([key, value]) => [
        key,
        structuredClone(value),
      ]),
      recoveryClaim: store.recoveryClaim === null
        ? null
        : {
          record: structuredClone(store.recoveryClaim.record),
          ref: structuredClone(store.recoveryClaim.ref),
        },
      host: {
        loaded: structuredClone(state.loaded),
        jobIdentity: structuredClone(state.jobIdentity),
        foreignJob: structuredClone(state.foreignJob),
        probeMode: structuredClone(state.probeMode),
        health: structuredClone(state.health),
        schedulerOutcome: state.schedulerOutcome,
        runtimeArtifacts: structuredClone(state.runtimeArtifacts),
      },
      sequence: { clockIndex, idIndex, inodeIndex },
      selectedFakeHostActionEvidence: selectedFakeHostActionEvidence === null
        ? null
        : {
          action: selectedFakeHostActionEvidence.action,
          count: selectedFakeHostActionEvidence.count,
        },
    });
    CRASH_IMAGE_BRAND.add(image);
    return image;
  }

  function restoreDurableState(image) {
    if (image.schemaVersion !== 1) throw harnessError('unsupported crash image schema');
    for (const item of image.files) {
      files.set(item.key, {
        bytes: decodeBytes(item.bytesBase64),
        device: item.device,
        inode: item.inode,
        ownerUid: item.ownerUid,
      });
    }
    for (const item of image.candidates) {
      const bytes = decodeBytes(item.bytesBase64);
      if (sha256Hex(bytes) !== item.sha256) {
        throw harnessError('crash image candidate hash mismatch');
      }
      candidates.set(item.key, {
        bytes,
        sha256: item.sha256,
        role: item.role,
        transactionId: item.transactionId,
      });
    }
    for (const entry of image.journal) {
      store.journal.push(deepFreeze(validateJournalEntryShape(structuredClone(entry))));
    }
    for (const [key, value] of image.anchors) {
      store.anchors.set(key, deepFreeze(validateLaunchAgentAnchor(structuredClone(value))));
    }
    for (const [key, value] of image.receipts) {
      const projection = validateLaunchAgentReceipt(structuredClone(value.projection));
      const receiptSha = sha256Hex(Buffer.from(JSON.stringify(projection), 'utf8'));
      if (receiptSha !== value.sha256) {
        throw harnessError('crash image receipt hash mismatch');
      }
      store.receipts.set(key, deepFreeze({ projection, sha256: receiptSha }));
    }
    store.transactionLock = image.transactionLock === null
      ? null
      : validateLockRecord(structuredClone(image.transactionLock));
    store.manualInterventionLock = image.manualInterventionLock === null
      ? null
      : validateLockRecord(structuredClone(image.manualInterventionLock));
    // Task 5 durable restore：validator + key binding；不得盲信 image。
    if (!Array.isArray(image.attestations)) {
      throw harnessError('crash image attestations must be an array');
    }
    for (const item of image.attestations) {
      if (!Array.isArray(item) || item.length !== 2) {
        throw harnessError('crash image attestation entry must be [key, value]');
      }
      const [key, value] = item;
      const projection = validateLaunchAgentManualRepairAttestation(structuredClone(value));
      if (projection.manualRepairConfirmationId !== key) {
        throw harnessError('crash image attestation key binding mismatch');
      }
      store.attestations.set(key, deepFreeze(projection));
    }
    if (image.recoveryClaim === null) {
      store.recoveryClaim = null;
    } else if (
      typeof image.recoveryClaim !== 'object'
      || Object.getPrototypeOf(image.recoveryClaim) !== Object.prototype
    ) {
      throw harnessError('crash image recoveryClaim must be null or plain object');
    } else {
      const claimFields = readExactObject(image.recoveryClaim, ['record', 'ref']);
      // 复用 materializeRecoveryClaim：canonical hash + cross-binding 与 seed/race 同源。
      // 函数声明在同作用域稍后定义，依赖 JS hoist；restore 仍做 exact ref 对齐。
      const materialized = materializeRecoveryClaim(structuredClone(claimFields.record));
      const refIn = readExactObject(claimFields.ref, [
        'kind', 'claimId', 'transactionId', 'ownerNonce', 'sha256',
      ]);
      if (
        refIn.kind !== materialized.ref.kind
        || refIn.claimId !== materialized.ref.claimId
        || refIn.transactionId !== materialized.ref.transactionId
        || refIn.ownerNonce !== materialized.ref.ownerNonce
        || refIn.sha256 !== materialized.ref.sha256
      ) {
        throw harnessError('crash image recoveryClaim ref/hash mismatch');
      }
      store.recoveryClaim = {
        record: materialized.record,
        ref: materialized.ref,
      };
    }
    Object.assign(state.loaded, image.host.loaded);
    Object.assign(state.jobIdentity, image.host.jobIdentity);
    Object.assign(state.foreignJob, image.host.foreignJob);
    Object.assign(state.probeMode, image.host.probeMode);
    state.health = structuredClone(image.host.health);
    state.schedulerOutcome = image.host.schedulerOutcome;
    state.runtimeArtifacts = structuredClone(image.host.runtimeArtifacts);
    clockIndex = image.sequence.clockIndex;
    idIndex = image.sequence.idIndex;
    inodeIndex = image.sequence.inodeIndex;
    // Task 6B.2 Task 5：strict revive of selected evidence（null 或 exact shape）。
    if (!Object.hasOwn(image, 'selectedFakeHostActionEvidence')) {
      // 兼容同进程旧 branded image（Task 5 前 capture 无此字段）→ 视为 null。
      selectedFakeHostActionEvidence = null;
    } else if (image.selectedFakeHostActionEvidence === null) {
      selectedFakeHostActionEvidence = null;
    } else {
      const evidence = validateSelectedFakeHostActionEvidence(
        image.selectedFakeHostActionEvidence,
      );
      selectedFakeHostActionEvidence = evidence === null
        ? null
        : deepFreeze({ action: evidence.action, count: evidence.count });
    }
  }

  function maybeCaptureCrash(kind, value) {
    if (crashSelector === null || crashImage !== null || crashSelector.kind !== kind) return;
    const selected = kind === 'journal-state'
      ? crashSelector.state
      : kind === 'host-mutation'
        ? crashSelector.action
        : crashSelector.event;
    if (selected !== value) return;
    const key = `${kind}:${value}`;
    const occurrence = (crashOccurrences.get(key) ?? 0) + 1;
    crashOccurrences.set(key, occurrence);
    if (occurrence === crashSelector.occurrence) crashImage = captureDurableState();
  }

  // 补偿窗口内最新 journal 为 compensate-<action>-intent 时，post-mutation image 以补偿
  // action 命名；否则使用宿主 fallback action。
  function semanticMutationAction(fallbackAction) {
    const transactionId = store.transactionLock?.transactionId ?? null;
    const latest = transactionId === null ? null : latestJournalEntry(transactionId);
    const match = latest?.state.match(/^compensate-([a-z-]+)-intent$/);
    return match ? match[1] : fallbackAction;
  }

  // 只在真实 fake 状态变更成功且计数增加之后调用；失败/非零退出/CAS mismatch/未知状态
  // 绝不生成 post-mutation image。
  function recordSuccessfulHostMutation(fallbackAction) {
    const action = semanticMutationAction(fallbackAction);
    // Task 6B.2 Task 5：armed selected action 在成功 mutation 后计入 durable evidence。
    if (selectedFakeHostActionArm !== null && selectedFakeHostActionArm === action) {
      const prior = selectedFakeHostActionEvidence;
      const nextCount = prior !== null && prior.action === action ? prior.count + 1 : 1;
      selectedFakeHostActionEvidence = deepFreeze({ action, count: nextCount });
      maybeCaptureCrash('host-mutation', action);
      if (selectedFakeHostActionWaiter !== null) {
        const resolve = selectedFakeHostActionWaiter;
        selectedFakeHostActionWaiter = null;
        resolve();
      }
      return;
    }
    maybeCaptureCrash('host-mutation', action);
  }

  /**
   * Task 5 test-only：闭合 recovery claim record + 计算 ref（seed / race-arm 共用）。
   * 含 production 等价 cross-binding 验证；不写入 store；不进入 dependencies/factoryContract。
   */
  function materializeRecoveryClaim(claimRecordInput) {
    const fields = readExactObject(claimRecordInput, [
      'schemaVersion', 'kind', 'claimId', 'transactionId', 'ownerPid', 'ownerNonce',
      'bootSessionIdentity', 'processStartIdentity',
      'expectedTransactionLockRef', 'manualInterventionLockRef', 'freshTransactionLockRef',
    ]);
    if (fields.schemaVersion !== 1) invalid();
    if (fields.kind !== 'recovery-claim-lock') invalid();
    const claimId = requireUuid(fields.claimId);
    const transactionId = requireUuid(fields.transactionId);
    const ownerNonce = requireUuid(fields.ownerNonce);
    if (claimId === transactionId || claimId === ownerNonce || transactionId === ownerNonce) {
      invalid();
    }
    if (!Number.isSafeInteger(fields.ownerPid) || fields.ownerPid <= 0) invalid();
    let expectedTransactionLockRef = null;
    if (fields.expectedTransactionLockRef !== null) {
      const er = readExactObject(fields.expectedTransactionLockRef, [
        'kind', 'transactionId', 'ownerNonce', 'sha256',
      ]);
      if (er.kind !== 'transaction-lock') invalid();
      expectedTransactionLockRef = deepFreeze({
        kind: 'transaction-lock',
        transactionId: requireUuid(er.transactionId),
        ownerNonce: requireUuid(er.ownerNonce),
        sha256: requireSha256(er.sha256),
      });
    }
    const mir = readExactObject(fields.manualInterventionLockRef, [
      'kind', 'transactionId', 'ownerNonce', 'sha256',
    ]);
    if (mir.kind !== 'manual-intervention-lock') invalid();
    const manualInterventionLockRef = deepFreeze({
      kind: 'manual-intervention-lock',
      transactionId: requireUuid(mir.transactionId),
      ownerNonce: requireUuid(mir.ownerNonce),
      sha256: requireSha256(mir.sha256),
    });
    const fr = readExactObject(fields.freshTransactionLockRef, [
      'kind', 'transactionId', 'ownerNonce', 'sha256',
    ]);
    if (fr.kind !== 'transaction-lock') invalid();
    const freshTransactionLockRef = deepFreeze({
      kind: 'transaction-lock',
      transactionId: requireUuid(fr.transactionId),
      ownerNonce: requireUuid(fr.ownerNonce),
      sha256: requireSha256(fr.sha256),
    });
    // Mirror production validateRecoveryClaimRecord cross-binding：
    // expected/MIR/fresh transactionId 与 claim.transactionId 绑定；
    // fresh.ownerNonce 与 claim.ownerNonce 绑定。缺任一 → INVALID。
    if (
      expectedTransactionLockRef !== null
      && expectedTransactionLockRef.transactionId !== transactionId
    ) {
      invalid();
    }
    if (manualInterventionLockRef.transactionId !== transactionId) invalid();
    if (freshTransactionLockRef.transactionId !== transactionId) invalid();
    if (freshTransactionLockRef.ownerNonce !== ownerNonce) invalid();
    const boot = readExactObject(fields.bootSessionIdentity, ['available', 'value']);
    const pstart = readExactObject(fields.processStartIdentity, ['available', 'value']);
    const claimRecord = deepFreeze({
      schemaVersion: 1,
      kind: 'recovery-claim-lock',
      claimId,
      transactionId,
      ownerPid: fields.ownerPid,
      ownerNonce,
      bootSessionIdentity: { available: boot.available, value: boot.value },
      processStartIdentity: { available: pstart.available, value: pstart.value },
      expectedTransactionLockRef,
      manualInterventionLockRef,
      freshTransactionLockRef,
    });
    const claimSha = sha256Hex(Buffer.from(JSON.stringify(claimRecord), 'utf8'));
    const ref = deepFreeze({
      kind: 'recovery-claim-lock',
      claimId,
      transactionId,
      ownerNonce,
      sha256: claimSha,
    });
    return deepFreeze({ ref, record: claimRecord });
  }

  const harness = {
    dependencies() {
      return dependencies;
    },

    /**
     * 工厂契约：精确九 key；methods.metadataStore = 单一 FULL 表面
     * （与生产 DEPENDENCY_METHODS / dependencies() 对齐）。
     */
    factoryContract() {
      return deepFreeze({
        keys: [
          'metadataStore', 'hostInspector', 'profileRenderer', 'plistValidator',
          'atomicPublisher', 'launchctlRunner', 'healthChecker', 'clock',
          'processIdentityReader',
        ],
        methods: {
          metadataStore: [...COORDINATOR_METADATA_METHODS],
          hostInspector: ['inspect', 'read', 'launchctlHostFacts'],
          profileRenderer: ['render', 'revalidate'],
          plistValidator: ['validate'],
          atomicPublisher: ['publishAbsent', 'replaceIfMatch', 'removeIfMatch'],
          launchctlRunner: ['run'],
          healthChecker: ['check'],
          clock: ['now', 'newId'],
          processIdentityReader: ['current', 'observe'],
        },
      });
    },

    trace() {
      return deepFreeze([...trace]);
    },

    adapterCalls() {
      return deepFreeze(adapterCalls.map((call) => ({ ...call })));
    },

    compensationEvents() {
      return deepFreeze(
        trace.filter((e) => typeof e === 'object' && e.kind === 'compensation'),
      );
    },

    journalStates(transactionId) {
      return deepFreeze(
        store.journal.filter((e) => e.transactionId === transactionId).map((e) => e.state),
      );
    },

    journalEntries(transactionId) {
      return deepFreeze(
        store.journal
          .filter((e) => e.transactionId === transactionId)
          .map((e) => structuredClone(e)),
      );
    },

    journalTransactionIds() {
      return deepFreeze([...new Set(store.journal.map((entry) => entry.transactionId))].sort());
    },

    receiptTransactionIds() {
      return deepFreeze([...store.receipts.keys()].sort());
    },

    deleteReceiptFor(transactionIdInput) {
      const transactionId = requireUuid(transactionIdInput);
      if (!store.receipts.delete(transactionId)) {
        throw harnessError('cannot delete missing receipt');
      }
    },

    deleteAnchorFor(anchorIdInput) {
      const anchorId = requireUuid(anchorIdInput);
      if (!store.anchors.delete(anchorId)) {
        throw harnessError('cannot delete missing anchor');
      }
    },

    /**
     * Task 6B.2 Task 5：闭合 selected fake host action evidence 接缝。
     * 仅绑定 CRASH_HOST_ACTIONS 词汇；arm 后每次成功 fake mutation 计数。
     * 返回 Promise：在该 action 首次成功 mutation 且 crash capture（若已 arm）
     * 完成之后 resolve，供 owner child 在 completed journal 前导出 crash image。
     * 禁止 generic callback；不进 dependencies/factoryContract。
     * @param {{ action: string }} input
     * @returns {Promise<void>}
     */
    armSelectedFakeHostActionEvidenceForTest(input) {
      if (selectedFakeHostActionArm !== null) {
        throw harnessError('selected fake host action evidence already armed');
      }
      const fields = readExactObject(input, ['action']);
      if (typeof fields.action !== 'string' || !CRASH_HOST_ACTIONS.has(fields.action)) {
        throw harnessError('unknown selected fake host action');
      }
      selectedFakeHostActionArm = fields.action;
      return new Promise((resolve) => {
        selectedFakeHostActionWaiter = resolve;
      });
    },

    /**
     * 只读：当前 durable selected fake host action evidence（null 或 exact shape）。
     */
    selectedFakeHostActionEvidenceForTest() {
      if (selectedFakeHostActionEvidence === null) return null;
      return deepFreeze({
        action: selectedFakeHostActionEvidence.action,
        count: selectedFakeHostActionEvidence.count,
      });
    },

    armCrashCapture(selector) {
      if (crashSelector !== null || crashImage !== null || crashImageTaken) {
        throw harnessError('crash capture already configured');
      }
      if (selector === null || typeof selector !== 'object'
          || Object.getPrototypeOf(selector) !== Object.prototype) {
        throw harnessError('crash selector must be a plain object');
      }
      const kindDescriptor = Object.getOwnPropertyDescriptor(selector, 'kind');
      if (!kindDescriptor || !Object.hasOwn(kindDescriptor, 'value')
          || !CRASH_SELECTOR_KINDS.has(kindDescriptor.value)) {
        throw harnessError('unknown crash selector kind');
      }
      const kind = kindDescriptor.value;
      const expectedKeys = kind === 'journal-state'
        ? ['kind', 'state', 'occurrence']
        : kind === 'host-mutation'
          ? ['kind', 'action', 'occurrence']
          : ['kind', 'event', 'occurrence'];
      const fields = readExactObject(selector, expectedKeys);
      validatePositiveOccurrence(fields.occurrence);
      if (kind === 'journal-state') {
        if (typeof fields.state !== 'string' || fields.state.length === 0) {
          throw harnessError('journal crash state must be non-empty');
        }
        crashSelector = deepFreeze({
          kind,
          state: fields.state,
          occurrence: fields.occurrence,
        });
      } else if (kind === 'host-mutation') {
        if (!CRASH_HOST_ACTIONS.has(fields.action)) {
          throw harnessError('unknown crash host action');
        }
        crashSelector = deepFreeze({
          kind,
          action: fields.action,
          occurrence: fields.occurrence,
        });
      } else {
        // kind === 'event'：闭合八名；未知 event / 额外字段已由 readExactObject fail-closed。
        if (!CRASH_EVENT_NAMES.has(fields.event)) {
          throw harnessError('unknown crash event name');
        }
        crashSelector = deepFreeze({
          kind,
          event: fields.event,
          occurrence: fields.occurrence,
        });
      }
      return true;
    },

    takeCrashImage() {
      if (crashImage === null || crashImageTaken) {
        throw harnessError('crash image unavailable');
      }
      crashImageTaken = true;
      return crashImage;
    },

    /**
     * Step 4 预证明锁接缝：只作用于 branded revived harness；仅清除 transactionId 匹配、
     * 无 MIR lock、latest 非 MIR 的 fake stale transaction lock。不预判 receipt 闭合。
     */
    preProveRecoveryLockRelease(input) {
      if (!revivedFromCrashImage) throw harnessError('lock seam requires revived crash image');
      const fields = readExactObject(input, ['transactionId']);
      const transactionId = requireUuid(fields.transactionId);
      if (store.transactionLock?.transactionId !== transactionId) {
        throw harnessError('stale transaction lock mismatch');
      }
      if (store.manualInterventionLock !== null) {
        throw harnessError('manual intervention lock blocks ordinary recovery');
      }
      const latest = latestJournalEntry(transactionId);
      if (latest === null || latest.state === 'manual-intervention-required') {
        throw harnessError('lock seam requires a recoverable non-MIR journal');
      }
      store.transactionLock = null;
      recordSimpleEvent('recovery-lock-seam');
      return true;
    },

    /**
     * Task 5 Step 2 exact terminal receipt publish race：只 arm 一次，重复 arm 抛
     * 稳定 harness error。injection 而非 seed path；不进 crash image；实际抢先
     * 落盘发生在 metadataStore.publishReceipt 的 receipt-exists 检查之前。
     */
    raceExactTerminalReceiptOnNextPublish(input) {
      const fields = readExactObject(input, ['transactionId']);
      const transactionId = requireUuid(fields.transactionId);
      if (exactReceiptRaceTransactionId !== null) {
        throw harnessError('terminal receipt race already armed');
      }
      exactReceiptRaceTransactionId = transactionId;
    },

    corruptLatestJournalLink() {
      if (store.journal.length < 2) {
        throw harnessError('cannot corrupt journal chain shorter than two entries');
      }
      const index = store.journal.length - 1;
      const latest = structuredClone(store.journal[index]);
      if (latest.previousEntrySha256 === null) {
        throw harnessError('latest journal entry has no prior link');
      }
      latest.previousEntrySha256 = latest.previousEntrySha256 === 'f'.repeat(64)
        ? 'e'.repeat(64)
        : 'f'.repeat(64);
      store.journal[index] = deepFreeze(latest);
    },

    misalignReceiptHashFor(transactionIdInput) {
      const transactionId = requireUuid(transactionIdInput);
      const stored = store.receipts.get(transactionId);
      if (!stored) throw harnessError('cannot misalign missing receipt');
      const sourceCommit = stored.projection.sourceCommit === 'a'.repeat(40)
        ? 'b'.repeat(40)
        : 'a'.repeat(40);
      const projection = validateLaunchAgentReceipt({
        ...structuredClone(stored.projection),
        sourceCommit,
      });
      const sha256 = sha256Hex(Buffer.from(JSON.stringify(projection), 'utf8'));
      if (sha256 === stored.sha256) throw harnessError('receipt hash did not change');
      store.receipts.set(transactionId, { projection, sha256 });
      return deepFreeze({ transactionId, sha256 });
    },

    /**
     * Task 5A.3 F1 RED seam：只对目标 transaction 的 latest nonterminal checkpoint
     * 做 test-only rewrite，保持 sequence/previousEntrySha256/operation/at/
     * recoveryContext，改为另一个 individually-valid checkpoint/payload 并重算
     * canonical entrySha256。schema/canonical hash/sequence/prevHash/operation/head
     * 全部保持合法，只留下 transition 层面的非法性供 recover 证明。
     */
    rewriteLatestJournalCheckpointForTest(input) {
      const fields = readExactObject(input, ['transactionId', 'state', 'role']);
      const transactionId = requireUuid(fields.transactionId);
      if (typeof fields.state !== 'string' || fields.state.length === 0) {
        throw harnessError('rewrite state must be non-empty');
      }
      if (fields.role !== 'controller' && fields.role !== 'scheduler' && fields.role !== 'manifest') {
        throw harnessError(`unknown rewrite role: ${String(fields.role)}`);
      }
      let index = -1;
      for (const [cursor, entry] of store.journal.entries()) {
        if (entry.transactionId === transactionId) index = cursor;
      }
      if (index === -1) throw harnessError('cannot rewrite missing journal');
      const latest = store.journal[index];
      if (TERMINAL_JOURNAL_STATES.has(latest.state) || latest.state === 'manual-intervention-required') {
        throw harnessError('rewrite requires a nonterminal latest checkpoint');
      }
      const payload = {
        hostMutationCount: latest.payload.hostMutationCount,
        role: fields.role,
      };
      if (Object.hasOwn(latest.payload, 'recoveryContext')) {
        payload.recoveryContext = structuredClone(latest.payload.recoveryContext);
      }
      const rewritten = {
        schemaVersion: latest.schemaVersion,
        transactionId: latest.transactionId,
        sequence: latest.sequence,
        previousEntrySha256: latest.previousEntrySha256,
        entrySha256: '0'.repeat(64),
        operation: latest.operation,
        state: fields.state,
        at: latest.at,
        payload,
      };
      rewritten.entrySha256 = computeJournalEntrySha256(rewritten);
      // 单条 schema/canonical hash 必须全合法；非法 state/role 组合在此 fail closed。
      store.journal[index] = validateJournalEntryShape(rewritten);
      return true;
    },

    /**
     * Task 5A.3 F3 RED seam：把 stored receipt projection 改成 exact-schema
     * invalid（额外键），不是另一份 valid conflicting receipt；保留可冻结快照。
     */
    corruptReceiptForTest(transactionIdInput) {
      const transactionId = requireUuid(transactionIdInput);
      const stored = store.receipts.get(transactionId);
      if (!stored) throw harnessError('cannot corrupt missing receipt');
      const projection = structuredClone(stored.projection);
      projection.unexpected = 'harness-corrupt';
      let stillValid = true;
      try {
        validateLaunchAgentReceipt(projection);
      } catch {
        stillValid = false;
      }
      if (stillValid) throw harnessError('receipt corruption must break validateLaunchAgentReceipt');
      const frozen = deepFreeze(projection);
      store.receipts.set(transactionId, {
        projection: frozen,
        sha256: sha256Hex(Buffer.from(JSON.stringify(frozen), 'utf8')),
      });
      return deepFreeze({ transactionId, projection: frozen });
    },

    hostSnapshot() {
      const fileInfo = (role) => {
        const identity = currentFileIdentity(role);
        return identity === null ? null : deepFreeze(identity);
      };
      return deepFreeze({
        controller: fileInfo('controller'),
        scheduler: fileInfo('scheduler'),
        manifest: fileInfo('manifest'),
        loaded: { ...state.loaded },
        jobIdentity: { ...state.jobIdentity },
        health: { ...state.health },
      });
    },

    /**
     * Task 6 test-only 只读：投影 reverse-plan step 形状的当前 live {file, job}。
     * 与 frozen reversePlan[].expectedPre / expectedPost 精确同形，供 safe-disabled /
     * pending-action 用 deepEqual 证明「live 已是 expectedPost」或「仍匹配 expectedPre」，
     * 不得仅靠 hostMode 命名。
     */
    liveReversePlanStepState(role) {
      if (role !== 'controller' && role !== 'scheduler' && role !== 'manifest') {
        throw harnessError(`liveReversePlanStepState unknown role: ${String(role)}`);
      }
      const complete = completeFileIdentity(role);
      const file = complete === null
        ? { state: 'absent' }
        : {
          state: 'present',
          identity: {
            rootId: complete.rootId,
            basename: complete.basename,
            type: complete.type,
            ownerUid: complete.ownerUid,
            device: complete.device,
            inode: complete.inode,
            sha256: complete.sha256,
          },
          sha256: complete.sha256,
        };
      const loaded = role === 'manifest' ? false : state.loaded[role] === true;
      const job = loaded
        ? {
          state: 'loaded',
          identitySha256: state.jobIdentity[role],
        }
        : {
          state: 'stopped',
          identitySha256: null,
        };
      return deepFreeze({ file, job });
    },

    sentinels() {
      return deepFreeze({
        ...counters,
        hostMutationCount: hostMutationCount(),
        realLaunchctlCalls: 0,
        revalidateMarks: [...revalidateMarks],
      });
    },

    lockState() {
      return deepFreeze({
        transactionLock: store.transactionLock !== null,
        manualInterventionLock: store.manualInterventionLock !== null,
      });
    },

    receiptFor(transactionId) {
      const stored = store.receipts.get(transactionId);
      return stored ? stored.projection : null;
    },

    anchorFor(anchorId) {
      const snapshot = store.anchors.get(anchorId);
      return snapshot ? deepFreeze(structuredClone(snapshot)) : null;
    },

    anchorsWritten() {
      return deepFreeze([...store.anchors.values()].map((a) => structuredClone(a)));
    },

    candidatesWritten() {
      return deepFreeze([...candidates.values()].map((c) => ({
        kind: 'candidate',
        transactionId: c.transactionId,
        role: c.role,
        sha256: c.sha256,
      })));
    },

    publishedCandidateRefs() {
      return deepFreeze(publishedCandidateRefs.map((ref) => ({ ...ref })));
    },

    atomicExpectedAttempts() {
      return deepFreeze(atomicExpectedAttempts.map((attempt) => ({
        ...attempt,
        keys: [...attempt.keys],
      })));
    },

    fileBytes(role) {
      if (role !== 'controller' && role !== 'scheduler' && role !== 'manifest') {
        throw harnessError(`unknown file role: ${String(role)}`);
      }
      const rootId = role === 'manifest' ? ROOT_METADATA : ROOT_LAUNCH_AGENTS;
      const file = files.get(fileKey(rootId, FILENAMES[role]));
      return file ? Buffer.from(file.bytes) : null;
    },

    seedInstalled(options = {}) {
      if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        throw harnessError('seedInstalled options must be a plain object');
      }
      const allowedKeys = new Set([
        'sourceCommit', 'scheduleSeconds', 'controllerEnvironment', 'loaded', 'foreign',
      ]);
      for (const key of Reflect.ownKeys(options)) {
        if (typeof key !== 'string' || !allowedKeys.has(key)) {
          throw harnessError(`seedInstalled unknown key: ${String(key)}`);
        }
      }
      const sourceCommit = options.sourceCommit ?? '0'.repeat(40);
      const scheduleSeconds = options.scheduleSeconds ?? 300;
      const controllerEnvironment = options.controllerEnvironment ?? {};
      const loaded = options.loaded ?? { controller: true, scheduler: true };
      const foreign = options.foreign ?? { controller: false, scheduler: false };
      if (typeof sourceCommit !== 'string' || !COMMIT_RE.test(sourceCommit)) {
        throw harnessError('seedInstalled sourceCommit must be 40 lowercase hex');
      }
      if (!Number.isSafeInteger(scheduleSeconds)) {
        throw harnessError('seedInstalled scheduleSeconds must be an integer');
      }
      for (const [name, pair] of [['loaded', loaded], ['foreign', foreign]]) {
        const pairFields = readExactObject(pair, ['controller', 'scheduler']);
        if (typeof pairFields.controller !== 'boolean' || typeof pairFields.scheduler !== 'boolean') {
          throw harnessError(`seedInstalled ${name} must be exact booleans`);
        }
      }

      const profiles = makeProfiles(
        scheduleSeconds,
        controllerEnvironment,
        state.runtimeArtifacts,
      );
      placeFile('controller', profiles.controller.plistBytes);
      placeFile('scheduler', profiles.scheduler.plistBytes);

      const seedTransactionId = nextUuid();
      const seedAnchorId = nextUuid();
      const installationId = nextUuid();
      const manifest = validateLaunchAgentManifest({
        schemaVersion: 1,
        installationId,
        scope: LAUNCHAGENT_LIFECYCLE.scope,
        sourceCommit,
        runtimeArtifacts: profiles.manifestRuntimeArtifacts,
        transactionId: seedTransactionId,
        controller: {
          label: LABELS.controller,
          filename: FILENAMES.controller,
          plistSha256: profiles.controller.plistSha256,
        },
        scheduler: {
          label: LABELS.scheduler,
          filename: FILENAMES.scheduler,
          plistSha256: profiles.scheduler.plistSha256,
        },
        activeAnchorId: seedAnchorId,
        installedAt: nowIso(),
      });
      const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
      placeFile('manifest', manifestBytes);

      const seedAnchor = validateLaunchAgentAnchor({
        schemaVersion: 1,
        anchorId: seedAnchorId,
        parentAnchorId: null,
        transactionId: seedTransactionId,
        sourceCommit,
        purpose: 'first-install',
        rollbackFromManifestSha256: null,
        restoreManifestSha256: null,
        controller: { priorState: 'absent' },
        scheduler: { priorState: 'absent' },
        manifest: { priorState: 'absent' },
        loaded: { controller: false, scheduler: false },
        createdAt: nowIso(),
      });
      store.anchors.set(seedAnchorId, deepFreeze(structuredClone(seedAnchor)));
      seedJournalAndReceipt({
        transactionId: seedTransactionId,
        anchorId: seedAnchorId,
        sourceCommit,
      });

      for (const role of ['controller', 'scheduler']) {
        state.loaded[role] = loaded[role];
        state.foreignJob[role] = foreign[role];
        state.jobIdentity[role] = loaded[role]
          ? (foreign[role] ? 'f'.repeat(64) : computeJobIdentity(role))
          : null;
      }
      state.health = { statusCode: 200, ready: true, count: 0 };
      state.schedulerOutcome = 'ok';
      state.printPhase = { controller: 'inspect', scheduler: 'inspect' };

      return deepFreeze({
        sourceCommit,
        scheduleSeconds,
        controllerEnvironment: { ...controllerEnvironment },
        controllerBytes: Buffer.from(profiles.controller.plistBytes),
        schedulerBytes: Buffer.from(profiles.scheduler.plistBytes),
        manifestBytes: Buffer.from(manifestBytes),
        controllerSha256: profiles.controller.plistSha256,
        schedulerSha256: profiles.scheduler.plistSha256,
        manifestSha256: sha256Hex(manifestBytes),
        installationId,
        anchorId: seedAnchorId,
        transactionId: seedTransactionId,
      });
    },

    seedForeignNonterminalHead(input) {
      const fields = readExactObject(input, ['transactionId', 'operation', 'state']);
      const transactionId = requireUuid(fields.transactionId);
      if (store.journal.some((entry) => entry.transactionId === transactionId)) {
        throw harnessError('foreign transactionId already exists');
      }
      if (typeof fields.operation !== 'string' || fields.operation.length === 0) invalid();
      if (
        typeof fields.state !== 'string'
        || fields.state.length === 0
        || TERMINAL_JOURNAL_STATES.has(fields.state)
      ) {
        invalid();
      }
      const entry = {
        schemaVersion: 1,
        transactionId,
        sequence: 0,
        previousEntrySha256: null,
        operation: fields.operation,
        state: fields.state,
        at: nowIso(),
        payload: { hostMutationCount: 0 },
      };
      entry.entrySha256 = computeJournalEntrySha256(entry);
      const projection = validateJournalEntryShape(entry);
      store.journal.push(deepFreeze({ ...projection, payload: deepFreeze({ ...projection.payload }) }));
      return deepFreeze(structuredClone(projection));
    },

    plausibleInvalidStopAnchor(sourceCommit) {
      if (typeof sourceCommit !== 'string' || !COMMIT_RE.test(sourceCommit)) {
        throw harnessError('stop anchor sourceCommit must be 40 lowercase hex');
      }
      return deepFreeze({
        schemaVersion: 1,
        anchorId: nextUuid(),
        parentAnchorId: null,
        transactionId: nextUuid(),
        sourceCommit,
        purpose: 'stop',
        rollbackFromManifestSha256: null,
        restoreManifestSha256: null,
        controller: anchorEntryFor('controller'),
        scheduler: anchorEntryFor('scheduler'),
        manifest: anchorEntryFor('manifest'),
        loaded: { ...state.loaded },
        createdAt: nowIso(),
        unexpected: true,
      });
    },

    overrideNextAnchor(anchor) {
      if (anchor === null || typeof anchor !== 'object' || Object.getPrototypeOf(anchor) !== Object.prototype) {
        throw harnessError('anchor override must be a plain object');
      }
      if (nextAnchorOverride !== null) throw harnessError('anchor override already pending');
      nextAnchorOverride = structuredClone(anchor);
    },

    resetObservations() {
      trace.length = 0;
      adapterCalls.length = 0;
      publishedCandidateRefs.length = 0;
      atomicExpectedAttempts.length = 0;
      failureOccurrences.clear();
      eventCallCounts.clear();
      state.invalidAtomicExpectations.clear();
      state.publishedIdentityFaults.clear();
      hooks.length = 0;
      compensationHooks.length = 0;
      revalidateMarks.length = 0;
      exactReceiptRaceTransactionId = null;
      processIdentityCurrentCount = 0;
      clockNowCount = 0;
      clockNewIdCount = 0;
      lockAcquisitionHistory.length = 0;
      recoveryAcquisitionHistory.length = 0;
      ownerObserveQueue.length = 0;
      claimOwnerObserveQueue.length = 0;
      observeChannel = 'owner';
      ownerObserveCount = 0;
      claimOwnerObserveCount = 0;
      postLockSnapshotArmed = false;
      raceRecoveryClaimArm = null;
      recoveryClaimObservationHistory.length = 0;
      for (const key of Object.keys(counters)) counters[key] = 0;
      state.printPhase = { controller: 'inspect', scheduler: 'inspect' };
      state.lastRenderedRuntimeArtifacts = null;
    },

    /** 只读：成功 lock acquisition 观测历史（detached deep-frozen 副本）。 */
    lockAcquisitionsForTest() {
      return deepFreeze(structuredClone(lockAcquisitionHistory));
    },

    /**
     * 只读：成功 recovery-lock acquire 观测历史（detached deep-frozen 副本）。
     * exact entries：{claimId,transactionId,ownerNonce}；无 capability/authority/brand。
     */
    recoveryAcquisitionsForTest() {
      return deepFreeze(structuredClone(recoveryAcquisitionHistory));
    },

    /** 只读：默认 fake processIdentityReader.current 调用计数。 */
    processIdentityCurrentCountForTest() {
      return processIdentityCurrentCount;
    },

    /**
     * 只读：clock dependency surface 的 now/newId 调用计数（deep-frozen exact）。
     * 证明 attestation/completion-receipt clock 消费次数与 claimId/freshOwnerNonce
     * newId 消费次数；resetObservations 复位。
     */
    clockCallCountsForTest() {
      return deepFreeze({ now: clockNowCount, newId: clockNewIdCount });
    },

    /**
     * Task 5 test-only：记录 authority-consumed（必须是第一可观察事件）。
     * 不进入 dependencies/factoryContract/snapshot；仅 trace。
     *
     * 仅允许由严格 clock.now sentinel 在已证明 capability 二次 consume 为
     * acceptance-gate-denied 之后调用；禁止测试在调用 coordinator 前无条件预置。
     */
    recordAuthorityConsumedForTest() {
      recordSimpleEvent('authority-consumed');
      return true;
    },

    /**
     * Task 5 test-only：arm owner observe 状态序列（连续两次 dead 等）。
     * 切换 observe channel 为 owner。
     */
    armOwnerObserveStatuses(statuses) {
      if (!Array.isArray(statuses) || statuses.length === 0) {
        throw harnessError('owner observe statuses must be a non-empty array');
      }
      for (const status of statuses) {
        if (!OBSERVE_STATUSES.has(status)) {
          throw harnessError(`unknown observe status: ${String(status)}`);
        }
      }
      ownerObserveQueue.length = 0;
      ownerObserveQueue.push(...statuses);
      ownerObserveCount = 0;
      observeChannel = 'owner';
      return true;
    },

    /**
     * Task 5 test-only：arm claim-owner observe 状态序列。
     * 切换 observe channel 为 claim。
     */
    armClaimOwnerObserveStatuses(statuses) {
      if (!Array.isArray(statuses) || statuses.length === 0) {
        throw harnessError('claim-owner observe statuses must be a non-empty array');
      }
      for (const status of statuses) {
        if (!OBSERVE_STATUSES.has(status)) {
          throw harnessError(`unknown observe status: ${String(status)}`);
        }
      }
      claimOwnerObserveQueue.length = 0;
      claimOwnerObserveQueue.push(...statuses);
      claimOwnerObserveCount = 0;
      observeChannel = 'claim';
      return true;
    },

    /** Task 5 test-only：下一次成功 recovery-lock-acquire 后追加 post-lock-snapshot 事件。 */
    armPostLockSnapshotEvent() {
      postLockSnapshotArmed = true;
      return true;
    },

    /**
     * Task 5 test-only：seed 精确 MIR lock（detached deep-frozen record）。
     * 不触发 host/launchctl；不记 lock acquisition history（seed ≠ acquire）。
     */
    seedManualInterventionLock(record) {
      const projection = validateLockRecord(record);
      store.manualInterventionLock = projection;
      return deepFreeze({
        kind: 'manual-intervention-lock',
        transactionId: projection.transactionId,
        ownerNonce: projection.ownerNonce,
        sha256: lockSha256(projection),
      });
    },

    /**
     * Task 5 test-only：把指定 transaction 的 latest MIR head 改成另一合法 non-MIR
     * checkpoint（controller-publish-intent），供 journal-head drift 矩阵。
     * 保持 sequence/previousEntrySha256/operation；仅 state/payload 漂移。
     */
    driftMirJournalHeadForTest(transactionIdInput) {
      const transactionId = requireUuid(transactionIdInput);
      let index = -1;
      for (const [cursor, entry] of store.journal.entries()) {
        if (entry.transactionId === transactionId) index = cursor;
      }
      if (index === -1) throw harnessError('cannot drift missing MIR journal');
      const latest = store.journal[index];
      if (latest.state !== 'manual-intervention-required') {
        throw harnessError('drift requires latest MIR head');
      }
      const drifted = {
        schemaVersion: latest.schemaVersion,
        transactionId: latest.transactionId,
        sequence: latest.sequence,
        previousEntrySha256: latest.previousEntrySha256,
        entrySha256: '0'.repeat(64),
        operation: latest.operation,
        state: 'controller-publish-intent',
        at: latest.at,
        payload: {
          hostMutationCount: latest.payload.hostMutationCount,
          role: 'controller',
        },
      };
      drifted.entrySha256 = computeJournalEntrySha256(drifted);
      store.journal[index] = validateJournalEntryShape(drifted);
      return deepFreeze(structuredClone(store.journal[index]));
    },

    /**
     * Task 5 test-only：seed 可达 MIR journal head + anchor（无 host mutation）。
     * head = sequence 0 / state manual-intervention-required / exact {hostMutationCount}。
     * 供 mint genuine capability 与 coordinator drift 检查绑定 exact refs。
     */
    seedMirHeadAndAnchor(input) {
      const fields = readExactObject(input, ['transactionId', 'anchorId']);
      const transactionId = requireUuid(fields.transactionId);
      const anchorId = requireUuid(fields.anchorId);
      if (store.journal.some((entry) => entry.transactionId === transactionId)) {
        throw harnessError('MIR journal transactionId already exists');
      }
      if (store.anchors.has(anchorId)) {
        throw harnessError('MIR anchorId already exists');
      }
      const entry = {
        schemaVersion: 1,
        transactionId,
        sequence: 0,
        previousEntrySha256: null,
        operation: 'install',
        state: 'manual-intervention-required',
        at: nowIso(),
        payload: { hostMutationCount: 0 },
      };
      entry.entrySha256 = computeJournalEntrySha256(entry);
      const projection = validateJournalEntryShape(entry);
      store.journal.push(deepFreeze({
        ...projection,
        payload: deepFreeze({ ...projection.payload }),
      }));
      const sourceCommit = '0'.repeat(40);
      const seedAnchor = validateLaunchAgentAnchor({
        schemaVersion: 1,
        anchorId,
        parentAnchorId: null,
        transactionId,
        sourceCommit,
        purpose: 'first-install',
        rollbackFromManifestSha256: null,
        restoreManifestSha256: null,
        controller: { priorState: 'absent' },
        scheduler: { priorState: 'absent' },
        manifest: { priorState: 'absent' },
        loaded: { controller: false, scheduler: false },
        createdAt: nowIso(),
      });
      store.anchors.set(anchorId, deepFreeze(structuredClone(seedAnchor)));
      return deepFreeze({
        transactionId,
        anchorId,
        entrySha256: projection.entrySha256,
        journalHead: structuredClone(projection),
        anchor: structuredClone(seedAnchor),
      });
    },

    /**
     * Task 6 test-only：seed contracts-valid pure-closeout MIR transaction prefix。
     * 默认 prepared → compensating(frozen reversePlan) → MIR；可选已存在 exact
     * recovered/blocked terminal + matching receipt（cleanup-only 矩阵）。
     * hostMode 只配置 in-memory fake host，不计入 hostMutationCount / publisher /
     * bootstrap / bootout。fixture 一律经真实 contracts 校验后 detached deep-freeze。
     *
     * hostMode:
     * - recovered-checkpoint：live 等于合法 recovered 终态（owned 目标已移除且 unloaded）
     * - restored-checkpoint：anchor prior-bytes + host exact 恢复目标（present+loaded），
     *   供 recovered receipt roles 应为 restored 的 pure-closeout 矩阵
     * - safe-disabled：both jobs unloaded，owned 目标仍 present；frozen reversePlan 为
     *   stop-only，seed 后每个 step 的 live 与 expectedPost 同形（可用
     *   liveReversePlanStepState deepEqual 证明无 pending host action）
     * - pending-action：仍有待执行 frozen reverse action；seed 后至少一个 step 的
     *   live 匹配 expectedPre（非全部 expectedPost）
     * - unmatched-checkpoint：host 字节/身份与 reverse plan evidence 漂移
     */
    seedValidMirTransactionPrefix(input) {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        throw harnessError('seedValidMirTransactionPrefix input must be a plain object');
      }
      const allowedKeys = new Set([
        'transactionId',
        'anchorId',
        'hostMode',
        'terminal',
        'sourceCommit',
        'operation',
      ]);
      for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== 'string' || !allowedKeys.has(key)) {
          throw harnessError(`seedValidMirTransactionPrefix unknown key: ${String(key)}`);
        }
      }
      const transactionId = requireUuid(input.transactionId);
      const anchorId = requireUuid(input.anchorId);
      const hostMode = input.hostMode ?? 'pending-action';
      const terminal = input.terminal ?? null;
      const sourceCommit = input.sourceCommit ?? '0'.repeat(40);
      const operation = input.operation ?? 'install';
      if (
        hostMode !== 'recovered-checkpoint'
        && hostMode !== 'restored-checkpoint'
        && hostMode !== 'safe-disabled'
        && hostMode !== 'pending-action'
        && hostMode !== 'unmatched-checkpoint'
      ) {
        throw harnessError(`seedValidMirTransactionPrefix unknown hostMode: ${String(hostMode)}`);
      }
      if (terminal !== null && terminal !== 'recovered' && terminal !== 'blocked') {
        throw harnessError(`seedValidMirTransactionPrefix unknown terminal: ${String(terminal)}`);
      }
      if (typeof sourceCommit !== 'string' || !COMMIT_RE.test(sourceCommit)) {
        throw harnessError('seedValidMirTransactionPrefix sourceCommit must be 40 lowercase hex');
      }
      if (operation !== 'install' && operation !== 'managed-upgrade' && operation !== 'stop'
        && operation !== 'rollback' && operation !== 'uninstall' && operation !== 'recover') {
        throw harnessError(`seedValidMirTransactionPrefix unknown operation: ${String(operation)}`);
      }
      if (store.journal.some((entry) => entry.transactionId === transactionId)) {
        throw harnessError('MIR journal transactionId already exists');
      }
      if (store.anchors.has(anchorId)) {
        throw harnessError('MIR anchorId already exists');
      }

      const profiles = makeProfiles(300, {}, state.runtimeArtifacts);
      // reverse-plan evidence 需要真实 in-memory file identity；seed 后按 hostMode 再调 host。
      placeFile('controller', profiles.controller.plistBytes);
      placeFile('scheduler', profiles.scheduler.plistBytes);
      const controllerIdentity = completeFileIdentity('controller');
      const schedulerIdentity = completeFileIdentity('scheduler');
      if (controllerIdentity === null || schedulerIdentity === null) {
        throw harnessError('seedValidMirTransactionPrefix failed to materialize file identities');
      }

      function presentFile(identity) {
        return {
          state: 'present',
          identity: {
            rootId: identity.rootId,
            basename: identity.basename,
            type: identity.type,
            ownerUid: identity.ownerUid,
            device: identity.device,
            inode: identity.inode,
            sha256: identity.sha256,
          },
          sha256: identity.sha256,
        };
      }
      function absentFile() {
        return { state: 'absent' };
      }
      function jobLoaded(identity) {
        return { state: 'loaded', identitySha256: identity.sha256 };
      }
      function jobStopped() {
        return { state: 'stopped', identitySha256: null };
      }

      let reversePlan;
      if (hostMode === 'safe-disabled') {
        // both jobs stop only：owned 目标仍 present，jobs unloaded = exact safe-disabled。
        reversePlan = [
          {
            index: 0,
            action: 'stop-scheduler',
            role: 'scheduler',
            expectedPre: { file: presentFile(schedulerIdentity), job: jobLoaded(schedulerIdentity) },
            expectedPost: { file: presentFile(schedulerIdentity), job: jobStopped() },
            evidence: {
              kind: 'candidate',
              transactionId,
              role: 'scheduler',
              sha256: schedulerIdentity.sha256,
            },
          },
          {
            index: 1,
            action: 'stop-controller',
            role: 'controller',
            expectedPre: { file: presentFile(controllerIdentity), job: jobLoaded(controllerIdentity) },
            expectedPost: { file: presentFile(controllerIdentity), job: jobStopped() },
            evidence: {
              kind: 'candidate',
              transactionId,
              role: 'controller',
              sha256: controllerIdentity.sha256,
            },
          },
        ];
      } else {
        // recovered / pending / unmatched：install reverse 到 controller 已移除。
        reversePlan = [
          {
            index: 0,
            action: 'stop-controller',
            role: 'controller',
            expectedPre: { file: presentFile(controllerIdentity), job: jobLoaded(controllerIdentity) },
            expectedPost: { file: presentFile(controllerIdentity), job: jobStopped() },
            evidence: {
              kind: 'candidate',
              transactionId,
              role: 'controller',
              sha256: controllerIdentity.sha256,
            },
          },
          {
            index: 1,
            action: 'remove-controller',
            role: 'controller',
            expectedPre: { file: presentFile(controllerIdentity), job: jobStopped() },
            expectedPost: { file: absentFile(), job: jobStopped() },
            evidence: {
              kind: 'candidate',
              transactionId,
              role: 'controller',
              sha256: controllerIdentity.sha256,
            },
          },
        ];
      }
      // reversePlan evidence (kind:candidate) 必须预置进 fake metadata candidates map，
      // 与 writeCandidate/readCandidate 相同 key/record 形状；否则安全实现调用
      // metadataStore.readCandidate 会被伪 fixture 阻断。仅 seed reversePlan 实际引用的
      // role；exact bytes+sha256 与 evidence 对齐；不计入 counters / adapter / host mutation。
      const stagedEvidenceKeys = new Set();
      for (const step of reversePlan) {
        const evidence = step.evidence;
        if (!evidence || evidence.kind !== 'candidate') continue;
        const key = `${evidence.transactionId}:${evidence.role}`;
        if (stagedEvidenceKeys.has(key)) {
          const existing = candidates.get(key);
          if (!existing || existing.sha256 !== evidence.sha256) {
            throw harnessError('seedValidMirTransactionPrefix candidate evidence conflict');
          }
          continue;
        }
        stagedEvidenceKeys.add(key);
        let sourceBytes = null;
        if (evidence.role === 'controller') {
          sourceBytes = profiles.controller.plistBytes;
        } else if (evidence.role === 'scheduler') {
          sourceBytes = profiles.scheduler.plistBytes;
        } else {
          throw harnessError(
            `seedValidMirTransactionPrefix unsupported candidate role: ${String(evidence.role)}`,
          );
        }
        const bytes = Buffer.from(sourceBytes);
        const digest = sha256Hex(bytes);
        if (digest !== evidence.sha256) {
          throw harnessError('seedValidMirTransactionPrefix candidate evidence sha256 mismatch');
        }
        if (evidence.transactionId !== transactionId) {
          throw harnessError('seedValidMirTransactionPrefix candidate transactionId mismatch');
        }
        if (candidates.has(key)) {
          throw harnessError('seedValidMirTransactionPrefix candidate already present');
        }
        candidates.set(key, {
          bytes,
          sha256: digest,
          role: evidence.role,
          transactionId: evidence.transactionId,
        });
      }
      const reversePlanSha256 = sha256Hex(Buffer.from(JSON.stringify(reversePlan), 'utf8'));
      const hostMutationCount = reversePlan.length;
      const at = nowIso();

      const rawEntries = [
        {
          schemaVersion: 1,
          transactionId,
          sequence: 0,
          previousEntrySha256: null,
          operation,
          state: 'prepared',
          at,
          payload: { hostMutationCount: 0 },
          entrySha256: '0'.repeat(64),
        },
        {
          schemaVersion: 1,
          transactionId,
          sequence: 1,
          previousEntrySha256: null,
          operation,
          state: 'compensating',
          at,
          payload: {
            hostMutationCount,
            reversePlan: structuredClone(reversePlan),
            reversePlanSha256,
          },
          entrySha256: '0'.repeat(64),
        },
        {
          schemaVersion: 1,
          transactionId,
          sequence: 2,
          previousEntrySha256: null,
          operation,
          state: 'manual-intervention-required',
          at,
          payload: { hostMutationCount },
          entrySha256: '0'.repeat(64),
        },
      ];
      let previousEntrySha256 = null;
      for (const [index, entry] of rawEntries.entries()) {
        entry.sequence = index;
        entry.previousEntrySha256 = previousEntrySha256;
        entry.entrySha256 = computeJournalEntrySha256(entry);
        previousEntrySha256 = entry.entrySha256;
      }
      // 真实 contracts 校验：prefix 必须闭合（含 reverse plan / hash）。
      const prefixProjection = validateLaunchAgentTransactionPrefix({
        entries: structuredClone(rawEntries),
      });
      const mirEntry = prefixProjection.entries[2];
      let receiptProjection = null;
      let receiptSha = null;
      if (terminal !== null) {
        if (terminal === 'recovered') {
          receiptProjection = validateLaunchAgentReceipt({
            schemaVersion: 1,
            operation,
            state: 'recovered',
            success: false,
            sourceCommit,
            transactionId,
            anchorId,
            completedAt: at,
            roles: {
              controller: {
                label: LABELS.controller,
                outcome: 'removed',
                changed: true,
              },
              scheduler: {
                label: LABELS.scheduler,
                outcome: 'removed',
                changed: true,
              },
            },
            hostMutationCount,
            outcome: 'recovered',
          });
        } else {
          receiptProjection = validateLaunchAgentReceipt({
            schemaVersion: 1,
            operation,
            state: 'blocked',
            success: false,
            sourceCommit,
            transactionId,
            anchorId,
            completedAt: at,
            roles: {
              controller: {
                label: LABELS.controller,
                outcome: 'unchanged',
                changed: false,
              },
              scheduler: {
                label: LABELS.scheduler,
                outcome: 'unchanged',
                changed: false,
              },
            },
            hostMutationCount,
            outcome: 'recovery-required',
          });
        }
        receiptSha = sha256Hex(Buffer.from(JSON.stringify(receiptProjection), 'utf8'));
        const terminalPayload = {
          hostMutationCount,
          receipt: structuredClone(receiptProjection),
          receiptSha256: receiptSha,
        };
        if (terminal === 'blocked') {
          terminalPayload.blockedByEntrySha256 = mirEntry.entrySha256;
        }
        const terminalEntry = {
          schemaVersion: 1,
          transactionId,
          sequence: 3,
          previousEntrySha256: mirEntry.entrySha256,
          operation,
          state: terminal,
          at,
          payload: terminalPayload,
          entrySha256: '0'.repeat(64),
        };
        terminalEntry.entrySha256 = computeJournalEntrySha256(terminalEntry);
        rawEntries.push(terminalEntry);
        const closeout = validateLaunchAgentTransactionCloseout({
          entries: structuredClone(rawEntries),
          receipt: structuredClone(receiptProjection),
        });
        receiptProjection = closeout.receipt;
      } else {
        // 再次确认 open MIR prefix 仍合法（防御 terminal 分支污染）。
        validateLaunchAgentTransactionPrefix({ entries: structuredClone(rawEntries) });
      }

      for (const entry of rawEntries) {
        const projection = validateJournalEntryShape(entry);
        store.journal.push(deepFreeze({
          ...projection,
          payload: deepFreeze(structuredClone(projection.payload)),
        }));
      }
      if (receiptProjection !== null && receiptSha !== null) {
        store.receipts.set(transactionId, {
          projection: deepFreeze(structuredClone(receiptProjection)),
          sha256: receiptSha,
        });
      }

      // restored-checkpoint：anchor prior-bytes 绑定当前 file identity；其余 hostMode 为 absent。
      const usePriorBytesAnchor = hostMode === 'restored-checkpoint';
      const seedAnchor = validateLaunchAgentAnchor({
        schemaVersion: 1,
        anchorId,
        parentAnchorId: null,
        transactionId,
        sourceCommit,
        purpose: usePriorBytesAnchor ? 'managed-upgrade' : 'first-install',
        rollbackFromManifestSha256: null,
        restoreManifestSha256: null,
        controller: usePriorBytesAnchor
          ? anchorEntryFor('controller')
          : { priorState: 'absent' },
        scheduler: usePriorBytesAnchor
          ? anchorEntryFor('scheduler')
          : { priorState: 'absent' },
        manifest: { priorState: 'absent' },
        loaded: usePriorBytesAnchor
          ? { controller: true, scheduler: true }
          : { controller: false, scheduler: false },
        createdAt: at,
      });
      store.anchors.set(anchorId, deepFreeze(structuredClone(seedAnchor)));

      // hostMode：仅合成 fake host；不触发 publisher/bootstrap/bootout 计数。
      if (hostMode === 'recovered-checkpoint') {
        removeFile('controller');
        removeFile('scheduler');
        state.loaded.controller = false;
        state.loaded.scheduler = false;
        state.jobIdentity.controller = null;
        state.jobIdentity.scheduler = null;
        state.foreignJob.controller = false;
        state.foreignJob.scheduler = false;
      } else if (hostMode === 'restored-checkpoint') {
        // prior-bytes exact restored：owned 目标 present 且 jobs loaded 匹配 anchor。
        state.loaded.controller = true;
        state.loaded.scheduler = true;
        state.jobIdentity.controller = computeJobIdentity('controller');
        state.jobIdentity.scheduler = computeJobIdentity('scheduler');
        state.foreignJob.controller = false;
        state.foreignJob.scheduler = false;
      } else if (hostMode === 'safe-disabled') {
        // owned targets 仍 present；jobs exact unloaded。
        state.loaded.controller = false;
        state.loaded.scheduler = false;
        state.jobIdentity.controller = null;
        state.jobIdentity.scheduler = null;
        state.foreignJob.controller = false;
        state.foreignJob.scheduler = false;
      } else if (hostMode === 'pending-action') {
        state.loaded.controller = true;
        state.loaded.scheduler = true;
        state.jobIdentity.controller = computeJobIdentity('controller');
        state.jobIdentity.scheduler = computeJobIdentity('scheduler');
        state.foreignJob.controller = false;
        state.foreignJob.scheduler = false;
      } else {
        // unmatched-checkpoint：evidence hash 漂移。
        placeFile(
          'controller',
          Buffer.concat([profiles.controller.plistBytes, Buffer.from('\n# unmatched', 'utf8')]),
        );
        state.loaded.controller = true;
        state.loaded.scheduler = false;
        state.jobIdentity.controller = computeJobIdentity('controller');
        state.jobIdentity.scheduler = null;
        state.foreignJob.controller = false;
        state.foreignJob.scheduler = false;
      }
      state.printPhase = { controller: 'inspect', scheduler: 'inspect' };

      const journalHead = latestJournalEntry(transactionId);
      return deepFreeze({
        transactionId,
        anchorId,
        sourceCommit,
        operation,
        hostMode,
        terminal,
        hostMutationCount,
        reversePlanSha256,
        reversePlan: structuredClone(reversePlan),
        mirEntrySha256: mirEntry.entrySha256,
        mirHead: structuredClone(mirEntry),
        journalHead: journalHead === null ? null : structuredClone(journalHead),
        journalStates: store.journal
          .filter((entry) => entry.transactionId === transactionId)
          .map((entry) => entry.state),
        receipt: receiptProjection === null ? null : structuredClone(receiptProjection),
        receiptSha256: receiptSha,
        controllerSha256: controllerIdentity.sha256,
        schedulerSha256: schedulerIdentity.sha256,
        controllerBytes: Buffer.from(profiles.controller.plistBytes),
        schedulerBytes: Buffer.from(profiles.scheduler.plistBytes),
        anchor: structuredClone(seedAnchor),
      });
    },

    /**
     * Task 6 test-only：无 hostMutation 计数地放置/覆盖 host 文件字节。
     * 仅合成 in-memory fake host，不经 publisher/bootstrap/bootout。
     */
    placeHostBytesForTest(role, bytes) {
      if (role !== 'controller' && role !== 'scheduler' && role !== 'manifest') {
        throw harnessError(`unknown placeHostBytes role: ${String(role)}`);
      }
      if (!Buffer.isBuffer(bytes) && typeof bytes !== 'string') {
        throw harnessError('placeHostBytesForTest bytes must be Buffer or string');
      }
      placeFile(role, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'));
      return true;
    },

    /**
     * Task 6 test-only：破坏含 compensating+reversePlan 的 transaction prefix。
     * 将 MIR head 的 hostMutationCount 降到 strictly less than compensating，使
     * validateLaunchAgentTransactionPrefix 因 hostMutationCount 非单调失败；同时
     * 重算 MIR entrySha256，保持单条 journal schema + previous 链接对
     * readAuthorizedMirJournal 仍合法。不触 host / counters / MIR state。
     */
    breakCompensatingPrefixMonotonicityForTest(transactionIdInput) {
      const transactionId = requireUuid(transactionIdInput);
      let compensatingIndex = -1;
      let mirIndex = -1;
      for (const [cursor, entry] of store.journal.entries()) {
        if (entry.transactionId !== transactionId) continue;
        if (entry.state === 'compensating') compensatingIndex = cursor;
        if (entry.state === 'manual-intervention-required') mirIndex = cursor;
      }
      if (compensatingIndex === -1) {
        throw harnessError('cannot break prefix without compensating entry');
      }
      if (mirIndex === -1) {
        throw harnessError('cannot break prefix without MIR head');
      }
      const compensating = store.journal[compensatingIndex];
      if (
        !Object.hasOwn(compensating.payload, 'reversePlan')
        || !Object.hasOwn(compensating.payload, 'reversePlanSha256')
      ) {
        throw harnessError('compensating entry lacks reversePlan fields');
      }
      const mir = store.journal[mirIndex];
      const priorCount = compensating.payload.hostMutationCount;
      if (typeof priorCount !== 'number' || priorCount < 1) {
        throw harnessError('compensating hostMutationCount must be positive to break monotonicity');
      }
      if (mir.payload.hostMutationCount < priorCount) {
        throw harnessError('prefix monotonicity already broken');
      }
      const rewritten = {
        schemaVersion: mir.schemaVersion,
        transactionId: mir.transactionId,
        sequence: mir.sequence,
        previousEntrySha256: mir.previousEntrySha256,
        entrySha256: '0'.repeat(64),
        operation: mir.operation,
        state: mir.state,
        at: mir.at,
        payload: {
          hostMutationCount: priorCount - 1,
        },
      };
      if (Object.hasOwn(mir.payload, 'recoveryContext')) {
        rewritten.payload.recoveryContext = structuredClone(mir.payload.recoveryContext);
      }
      rewritten.entrySha256 = computeJournalEntrySha256(rewritten);
      store.journal[mirIndex] = validateJournalEntryShape(rewritten);
      // 防御：prefix 必须因此失败；单条 journal 仍合法。
      let prefixStillValid = true;
      try {
        validateLaunchAgentTransactionPrefix({
          entries: store.journal
            .filter((entry) => entry.transactionId === transactionId)
            .map((entry) => structuredClone(entry)),
        });
      } catch {
        prefixStillValid = false;
      }
      if (prefixStillValid) {
        throw harnessError('expected broken prefix after hostMutationCount decrease');
      }
      return deepFreeze({
        transactionId,
        compensatingHostMutationCount: priorCount,
        mirHostMutationCount: priorCount - 1,
        mirEntrySha256: rewritten.entrySha256,
      });
    },

    /**
     * Task 1B test-only：frozen-chain 拒绝矩阵的闭合 enumerated mutation seam。
     * 只接受 FROZEN_CHAIN_MUTATIONS 恰 14 个名字；无 generic callback mutator；
     * 不进 dependencies/factoryContract/crash-image durable allowlist/production exports。
     *
     * sourceJournal 必须是真实 coordinator persisted 链（逐条 validate + 与 store 链
     * entrySha256 逐条对齐 = 真实来源证明）；clone/relink 只重算 entry envelope 的
     * sequence/previousEntrySha256/entrySha256 与 plan hash-binding，绝不从常量合成
     * 第二个 plan，也不把 malformed 数据伪装成 production-generated。
     *
     * Stratum A（envelope 行）：重绑 plan hash 或漂移 hash 字段后重算 envelope，
     * 恰好留下 compensating 一条不过 validateJournalEntryShape，head 仍 MIR。
     * Stratum B 链文法行：全 entry 逐条合法 + link 自洽 + head MIR，但整链必须过
     * 不了 validateLaunchAgentTransactionPrefix。Stratum B evidence/live 行：链
     * 完全不动且 prefix 仍合法，只漂移 candidate bytes / anchor.loaded / live 文件
     * 三处比较的一侧。所有前置/后置断言失败一律 harnessError（= setup failure，
     * 区别于 route rejection）。
     */
    mutateFrozenChainForTest(input) {
      const fields = readExactObject(input, ['transactionId', 'mutation', 'sourceJournal']);
      const transactionId = requireUuid(fields.transactionId);
      const mutation = fields.mutation;
      if (!FROZEN_CHAIN_MUTATIONS.has(mutation)) {
        throw harnessError(`unknown frozen chain mutation: ${String(mutation)}`);
      }
      if (!Array.isArray(fields.sourceJournal) || fields.sourceJournal.length === 0) {
        throw harnessError('frozen chain mutation requires the real persisted source journal');
      }
      const sourceEntries = fields.sourceJournal.map((entry) => {
        try {
          return validateJournalEntryShape(structuredClone(entry));
        } catch {
          throw harnessError('source journal entries must be individually valid');
        }
      });
      for (const entry of sourceEntries) {
        if (entry.transactionId !== transactionId) {
          throw harnessError('source journal transactionId mismatch');
        }
      }

      const txEntries = store.journal.filter((entry) => entry.transactionId === transactionId);
      if (txEntries.length === 0) {
        throw harnessError('frozen chain mutation requires a persisted transaction journal');
      }
      if (txEntries.length !== sourceEntries.length + 1) {
        throw harnessError('store chain must extend the source journal by exactly the MIR entry');
      }
      for (const [index, entry] of sourceEntries.entries()) {
        if (entry.entrySha256 !== txEntries[index].entrySha256) {
          throw harnessError('store chain must hash-match the real persisted source journal');
        }
      }
      const head = txEntries[txEntries.length - 1];
      if (head.state !== 'manual-intervention-required') {
        throw harnessError('frozen chain mutation requires an MIR head');
      }
      if (txEntries.filter((entry) => entry.state === 'compensating').length !== 1) {
        throw harnessError('frozen chain mutation requires exactly one compensating entry');
      }
      const prefixOf = (entries) => validateLaunchAgentTransactionPrefix({
        entries: entries.map((entry) => structuredClone(entry)),
      });
      // 基线链（含 MIR head）必须整链合法，否则是 fixture 构造失败而非目标拒绝层。
      try {
        prefixOf(txEntries);
      } catch {
        throw harnessError('frozen chain mutation requires a prefix-valid persisted base chain');
      }

      const clones = txEntries.map((entry) => structuredClone(entry));
      const mirIndex = clones.length - 1;
      const compensatingIndex = clones.findIndex((entry) => entry.state === 'compensating');
      const payload = clones[compensatingIndex].payload;
      const plan = payload.reversePlan;
      const isCompensate = (entry) => COMPENSATION_STATE_PATTERN.test(entry.state);
      const rebindPlanHash = () => {
        payload.reversePlanSha256 = sha256Hex(Buffer.from(JSON.stringify(plan), 'utf8'));
      };
      const relink = () => {
        let previousEntrySha256 = null;
        for (const [index, entry] of clones.entries()) {
          entry.sequence = index;
          entry.previousEntrySha256 = previousEntrySha256;
          entry.entrySha256 = computeJournalEntrySha256(entry);
          previousEntrySha256 = entry.entrySha256;
        }
      };
      let role = null;

      if (mutation === 'reverse-plan-hash-field-drift') {
        // 只漂移 persisted hash 字段本身（plan 不动），隔离 hash-binding 校验层。
        const original = payload.reversePlanSha256;
        payload.reversePlanSha256 = original.startsWith('0')
          ? `1${original.slice(1)}`
          : `0${original.slice(1)}`;
        if (payload.reversePlanSha256 === sha256Hex(Buffer.from(JSON.stringify(plan), 'utf8'))) {
          throw harnessError('hash-field drift must break the persisted binding');
        }
        relink();
      } else if (mutation === 'reverse-plan-order-corruption') {
        if (plan.length < 2) throw harnessError('order corruption requires a two-step plan');
        [plan[0], plan[1]] = [plan[1], plan[0]];
        rebindPlanHash();
        relink();
      } else if (mutation === 'reverse-plan-action-corruption') {
        if (plan.length < 2) throw harnessError('action corruption requires a two-step plan');
        [plan[0].action, plan[1].action] = [plan[1].action, plan[0].action];
        rebindPlanHash();
        relink();
      } else if (mutation === 'reverse-plan-index-corruption') {
        plan[0].index += 1;
        rebindPlanHash();
        relink();
      } else if (mutation === 'second-compensating-entry') {
        clones.splice(mirIndex, 0, structuredClone(clones[compensatingIndex]));
        relink();
      } else if (mutation === 'duplicate-intent') {
        const open = clones[mirIndex - 1];
        if (!isCompensate(open) || !open.state.endsWith('-intent')) {
          throw harnessError('duplicate-intent requires an open intent before the MIR head');
        }
        clones.splice(mirIndex, 0, structuredClone(open));
        relink();
      } else if (mutation === 'completed-without-intent') {
        const completedIndex = clones.findIndex((entry) => (
          isCompensate(entry) && entry.state.endsWith('-completed')
        ));
        if (completedIndex === -1) {
          throw harnessError('completed-without-intent requires a real persisted completed entry');
        }
        clones.splice(compensatingIndex + 1, 0, structuredClone(clones[completedIndex]));
        relink();
      } else if (mutation === 'open-intent-then-later-intent') {
        const open = clones[mirIndex - 1];
        if (!isCompensate(open) || !open.state.endsWith('-intent')) {
          throw harnessError('later-intent mutation requires an open intent before the MIR head');
        }
        const nextStep = plan[open.payload.planIndex + 1];
        if (nextStep === undefined) {
          throw harnessError('later-intent mutation requires a later frozen step');
        }
        // clone 真实 open intent，仅按 persisted plan 的下一步改写 planIndex/action/state。
        const later = structuredClone(open);
        later.state = `compensate-${nextStep.action}-intent`;
        later.payload.planIndex = nextStep.index;
        later.payload.action = nextStep.action;
        clones.splice(mirIndex, 0, later);
        relink();
      } else if (mutation === 'duplicate-completed') {
        const completedIndex = clones.findIndex((entry) => (
          isCompensate(entry) && entry.state.endsWith('-completed')
        ));
        if (completedIndex === -1) {
          throw harnessError('duplicate-completed requires a real persisted completed entry');
        }
        clones.splice(mirIndex, 0, structuredClone(clones[completedIndex]));
        relink();
      } else if (mutation === 'second-mir-marker') {
        clones.push(structuredClone(clones[mirIndex]));
        relink();
      } else if (mutation === 'terminal-before-plan-completion') {
        if (clones.some(isCompensate)) {
          throw harnessError('terminal-before-completion requires zero persisted compensate entries');
        }
        const terminal = structuredClone(clones[mirIndex]);
        terminal.state = 'recovered';
        terminal.payload = {
          hostMutationCount: terminal.payload.hostMutationCount,
          receiptSha256: clones[compensatingIndex].entrySha256,
        };
        clones.splice(mirIndex, 0, terminal);
        relink();
      } else if (mutation === 'candidate-evidence-mismatch') {
        const step = plan.find((candidate) => candidate.evidence.kind === 'candidate');
        if (step === undefined) {
          throw harnessError('candidate evidence drift requires a candidate-evidence step');
        }
        role = step.role;
        const key = `${transactionId}:${role}`;
        const staged = candidates.get(key);
        if (staged === undefined) {
          throw harnessError('candidate evidence drift requires a staged candidate');
        }
        if (staged.sha256 !== step.evidence.sha256) {
          throw harnessError('staged candidate must match the frozen evidence before drift');
        }
        const drifted = Buffer.concat([
          staged.bytes,
          Buffer.from('\n# frozen-candidate-evidence-drift', 'utf8'),
        ]);
        if (sha256Hex(drifted) === step.evidence.sha256) {
          throw harnessError('candidate evidence drift must change the candidate bytes hash');
        }
        // 只漂移比较的一侧（candidate bytes）；stored sha256 字段保持与 evidence 一致。
        candidates.set(key, {
          bytes: drifted,
          sha256: staged.sha256,
          role: staged.role,
          transactionId: staged.transactionId,
        });
      } else if (mutation === 'anchor-evidence-mismatch') {
        const step = plan.find((candidate) => (
          candidate.evidence.kind === 'anchor' && candidate.role !== 'manifest'
        ));
        if (step === undefined) {
          throw harnessError('anchor evidence drift requires a non-manifest anchor-evidence step');
        }
        role = step.role;
        const stored = store.anchors.get(step.evidence.anchorId);
        if (stored === undefined) {
          throw harnessError('anchor evidence drift requires a persisted anchor');
        }
        if (stored.loaded[role] !== step.evidence.loaded) {
          throw harnessError('anchor loaded must match the frozen evidence before drift');
        }
        const drifted = structuredClone(stored);
        drifted.loaded[role] = !drifted.loaded[role];
        let projection = null;
        try {
          projection = validateLaunchAgentAnchor(drifted);
        } catch {
          throw harnessError('anchor evidence drift must stay individually schema-valid');
        }
        store.anchors.set(step.evidence.anchorId, deepFreeze(structuredClone(projection)));
      } else if (mutation === 'non-current-live-union-mismatch') {
        // 选最后一个 expectedPost.file=absent 且当前 file 已 absent 的 step（非 current
        // step），放入 candidate bytes + drift 后缀，live identity 落在 frozen union 外。
        let step = null;
        for (const candidate of [...plan].reverse()) {
          if (
            candidate.expectedPost.file.state === 'absent'
            && currentFileIdentity(candidate.role) === null
          ) {
            step = candidate;
            break;
          }
        }
        if (step === null) {
          throw harnessError('live union drift requires a non-current absent-target step');
        }
        role = step.role;
        const key = `${transactionId}:${role}`;
        const staged = candidates.get(key);
        if (staged === undefined) {
          throw harnessError('live union drift requires a staged candidate for the role');
        }
        const unionShas = new Set();
        for (const candidate of plan) {
          if (candidate.role !== role) continue;
          for (const expected of [candidate.expectedPre, candidate.expectedPost]) {
            if (expected.file.state === 'present') unionShas.add(expected.file.sha256);
          }
        }
        const drifted = Buffer.concat([
          staged.bytes,
          Buffer.from('\n# frozen-live-union-drift', 'utf8'),
        ]);
        if (unionShas.has(sha256Hex(drifted))) {
          throw harnessError('live union drift must land outside the frozen union boundary');
        }
        placeFile(role, drifted);
      }

      // 后置断言（失败 = setup failure）：head 始终 MIR；Stratum A 恰好 compensating
      // 一条不过单条校验；B 链行全合法但 prefix 必败；evidence/live 行 prefix 仍合法。
      if (clones[clones.length - 1].state !== 'manual-intervention-required') {
        throw harnessError('frozen chain mutation must keep the MIR head');
      }
      if (FROZEN_CHAIN_ENVELOPE_MUTATIONS.has(mutation)) {
        let invalidCount = 0;
        for (const [index, entry] of clones.entries()) {
          try {
            validateJournalEntryShape(entry);
          } catch {
            invalidCount += 1;
            if (index !== compensatingIndex) {
              throw harnessError('only the persisted compensating entry may fail validation');
            }
          }
        }
        if (invalidCount !== 1) {
          throw harnessError('envelope mutation must break exactly the compensating entry');
        }
      } else if (FROZEN_CHAIN_GRAMMAR_MUTATIONS.has(mutation)) {
        for (const entry of clones) {
          try {
            validateJournalEntryShape(entry);
          } catch {
            throw harnessError(`${mutation} must keep every entry individually valid`);
          }
        }
        let prefixValid = true;
        try {
          prefixOf(clones);
        } catch {
          prefixValid = false;
        }
        if (prefixValid) {
          throw harnessError(`${mutation} must break the frozen-chain prefix`);
        }
      } else {
        try {
          prefixOf(clones);
        } catch {
          throw harnessError('evidence/live mutation must keep the frozen chain prefix-valid');
        }
      }

      const startIndex = store.journal.findIndex((entry) => entry.transactionId === transactionId);
      store.journal.splice(
        startIndex,
        txEntries.length,
        ...clones.map((entry) => deepFreeze(entry)),
      );
      return deepFreeze({ mutation, transactionId, role });
    },

    /** Task 1B 只读：闭合 mutation 词汇（排序副本），供矩阵 coverage 精确对齐。 */
    frozenChainMutationNamesForTest() {
      return deepFreeze([...FROZEN_CHAIN_MUTATIONS].sort());
    },

    /**
     * Task 5 test-only：seed 精确 transaction lock。
     */
    seedTransactionLock(record) {
      const projection = validateLockRecord(record);
      store.transactionLock = projection;
      return deepFreeze({
        kind: 'transaction-lock',
        transactionId: projection.transactionId,
        ownerNonce: projection.ownerNonce,
        sha256: lockSha256(projection),
      });
    },

    /**
     * Task 5 test-only：seed 已存在 manual-repair attestation（no-clobber 冲突矩阵）。
     * 不触发 attestation-* trace 事件；与 production write 路径分离。
     */
    seedManualRepairAttestation(record) {
      const projection = validateLaunchAgentManualRepairAttestation(record);
      const id = projection.manualRepairConfirmationId;
      if (store.attestations.has(id)) {
        throw harnessError('attestation already seeded for confirmationId');
      }
      const frozen = deepFreeze(structuredClone(projection));
      store.attestations.set(id, frozen);
      return deepFreeze(structuredClone(frozen));
    },


    /**
     * Task 5 test-only：seed residual recovery claim（闭合 record + 计算 ref）。
     */
    seedRecoveryClaim(claimRecordInput) {
      const materialized = materializeRecoveryClaim(claimRecordInput);
      store.recoveryClaim = {
        record: materialized.record,
        ref: materialized.ref,
      };
      return deepFreeze({
        ref: deepFreeze(structuredClone(materialized.ref)),
        record: deepFreeze(structuredClone(materialized.record)),
      });
    },

    /**
     * Task 5 test-only：arm 下一次 acquire 原子 claim 检查点的 winner claim。
     * 验证/冻结规则与 seedRecoveryClaim 完全同一路径；不写入 store（此前 observation 见 absent）。
     * 仅在 acquire 已验证 input/MIR/expected 之后、检查 recoveryClaim 之前一次性注入。
     * 不进入 dependencies/factoryContract/snapshot。
     */
    raceRecoveryClaimOnNextAcquire(claimRecordInput) {
      if (raceRecoveryClaimArm !== null) {
        throw harnessError('race recovery claim already armed');
      }
      if (store.recoveryClaim !== null) {
        throw harnessError('cannot arm race recovery claim while residual claim present');
      }
      const materialized = materializeRecoveryClaim(claimRecordInput);
      raceRecoveryClaimArm = {
        record: materialized.record,
        ref: materialized.ref,
      };
      return deepFreeze({
        ref: deepFreeze(structuredClone(materialized.ref)),
        record: deepFreeze(structuredClone(materialized.record)),
      });
    },

    /**
     * Task 5 test-only 只读：readRecoveryClaimObservation 历史（detached）。
     * 每条 { present: boolean }；证明 acquire 前 initial observation 见 absent。
     */
    recoveryClaimObservationsForTest() {
      return deepFreeze(structuredClone(recoveryClaimObservationHistory));
    },

    /** Task 5 只读：attestation 是否存在（detached boolean）。 */
    hasManualRepairAttestation(confirmationId) {
      return store.attestations.has(requireUuid(confirmationId));
    },

    /** Task 5 只读：attestation 投影或 null（detached deep-frozen 副本）。 */
    manualRepairAttestationForTest(confirmationId) {
      const stored = store.attestations.get(requireUuid(confirmationId));
      return stored === undefined ? null : deepFreeze(structuredClone(stored));
    },

    /** Task 5 只读：recovery claim 是否存在。 */
    hasRecoveryClaim() {
      return store.recoveryClaim !== null;
    },

    /** Task 5 只读：recovery claim ref 或 null。 */
    recoveryClaimRefForTest() {
      return store.recoveryClaim === null
        ? null
        : deepFreeze(structuredClone(store.recoveryClaim.ref));
    },

    /** Task 5 只读：当前 transaction lock ref 或 null。 */
    transactionLockRefForTest() {
      if (store.transactionLock === null) return null;
      return deepFreeze({
        kind: 'transaction-lock',
        transactionId: store.transactionLock.transactionId,
        ownerNonce: store.transactionLock.ownerNonce,
        sha256: lockSha256(store.transactionLock),
      });
    },

    /** Task 5 只读：当前 MIR lock ref 或 null。 */
    manualInterventionLockRefForTest() {
      if (store.manualInterventionLock === null) return null;
      return deepFreeze({
        kind: 'manual-intervention-lock',
        transactionId: store.manualInterventionLock.transactionId,
        ownerNonce: store.manualInterventionLock.ownerNonce,
        sha256: lockSha256(store.manualInterventionLock),
      });
    },


    failNext(eventName) {
      if (!FAILABLE_EVENT_SET.has(eventName)) {
        throw harnessError(`event is not failure-injectable: ${String(eventName)}`);
      }
      const nextCall = (eventCallCounts.get(eventName) ?? 0) + 1;
      if (!failureOccurrences.has(eventName)) failureOccurrences.set(eventName, new Set());
      failureOccurrences.get(eventName).add(nextCall);
    },

    failAt(eventName, occurrence) {
      if (!FAILABLE_EVENT_SET.has(eventName)) {
        throw harnessError(`event is not failure-injectable: ${String(eventName)}`);
      }
      if (!Number.isSafeInteger(occurrence) || occurrence <= 0) {
        throw harnessError('failAt occurrence must be a positive integer');
      }
      if (!failureOccurrences.has(eventName)) failureOccurrences.set(eventName, new Set());
      failureOccurrences.get(eventName).add(occurrence);
    },

    failNextRevalidation(reason) {
      if (!REVALIDATION_REASONS.has(reason)) {
        throw harnessError(`unknown revalidation reason: ${String(reason)}`);
      }
      if (state.revalidationFailures.has(reason)) {
        throw harnessError(`revalidation failure already pending: ${reason}`);
      }
      state.revalidationFailures.add(reason);
    },

    queueClockIds(ids) {
      if (!Array.isArray(ids) || ids.length === 0) {
        throw harnessError('clock id queue must be a non-empty array');
      }
      if (queuedClockIds.length !== 0) {
        throw harnessError('clock id queue already populated');
      }
      for (const id of ids) {
        if (typeof id !== 'string' || !UUID_RE.test(id)) {
          throw harnessError('clock id queue contains invalid uuid');
        }
      }
      queuedClockIds.push(...ids);
    },

    enableStrictLaunchctlTransitions() {
      state.strictLaunchctlTransitions = true;
    },

    failNextAtomicExpectedValidation(operation, role) {
      if (operation !== 'replace' && operation !== 'remove') {
        throw harnessError(`unknown atomic expectation operation: ${String(operation)}`);
      }
      if (role !== 'controller' && role !== 'scheduler' && role !== 'manifest') {
        throw harnessError(`unknown atomic expectation role: ${String(role)}`);
      }
      const key = `${operation}:${role}`;
      if (state.invalidAtomicExpectations.has(key)) {
        throw harnessError(`atomic expectation failure already pending: ${key}`);
      }
      state.invalidAtomicExpectations.add(key);
    },

    corruptNextPublishedIdentityAfterMutation(role, fault) {
      if (role !== 'controller' && role !== 'scheduler' && role !== 'manifest') {
        throw harnessError(`unknown published identity role: ${String(role)}`);
      }
      if (fault !== 'bad-sha256' && fault !== 'three-field') {
        throw harnessError(`unknown published identity fault: ${String(fault)}`);
      }
      if (state.publishedIdentityFaults.has(role)) {
        throw harnessError(`published identity fault already pending: ${role}`);
      }
      state.publishedIdentityFaults.set(role, fault);
    },

    forgeNextReplaceSuccessWithoutMutation(role) {
      if (role !== 'controller' && role !== 'scheduler' && role !== 'manifest') {
        throw harnessError(`unknown forged replace role: ${String(role)}`);
      }
      if (state.forgedReplaceNoMutationRole !== null) {
        throw harnessError('forged replace already pending');
      }
      state.forgedReplaceNoMutationRole = role;
    },

    setRuntimeArtifactSha256(role, sha256) {
      if (role !== 'node' && role !== 'controller' && role !== 'agent') {
        throw harnessError(`unknown runtime artifact role: ${String(role)}`);
      }
      if (typeof sha256 !== 'string' || !SHA_RE.test(sha256)) {
        throw harnessError('runtime artifact sha256 must be 64 lowercase hex');
      }
      state.runtimeArtifacts[role] = {
        ...state.runtimeArtifacts[role],
        sha256,
      };
    },

    seedLoadedJob(role, options = {}) {
      if (role !== 'controller' && role !== 'scheduler') {
        throw harnessError(`unknown loaded-job role: ${String(role)}`);
      }
      const foreign = options.foreign ?? false;
      if (typeof foreign !== 'boolean') throw harnessError('seedLoadedJob foreign must be boolean');
      state.loaded[role] = true;
      state.foreignJob[role] = foreign;
      state.jobIdentity[role] = foreign ? 'f'.repeat(64) : computeJobIdentity(role);
    },

    setProbeMode(role, mode) {
      if (role !== 'controller' && role !== 'scheduler') {
        throw harnessError(`unknown probe role: ${String(role)}`);
      }
      if (mode !== 'normal' && mode !== 'unknown') {
        throw harnessError(`unknown probe mode: ${String(mode)}`);
      }
      state.probeMode[role] = mode;
    },

    setPlistLintValid(role, valid) {
      if (role !== 'controller' && role !== 'scheduler') {
        throw harnessError(`unknown plist role: ${String(role)}`);
      }
      if (typeof valid !== 'boolean') throw harnessError('plist lint valid must be boolean');
      state.plistLintValid[role] = valid;
    },

    afterEvent(eventName, fn) {
      if (!SIMPLE_EVENT_SET.has(eventName)) {
        throw harnessError(`cannot hook unknown event: ${String(eventName)}`);
      }
      if (typeof fn !== 'function') throw harnessError('hook must be a function');
      hooks.push({ eventName, fn });
    },

    afterCompensationEvent(action, phase, fn) {
      if (!COMPENSATION_ACTION_SET.has(action)) {
        throw harnessError(`unknown compensation action: ${String(action)}`);
      }
      if (!COMPENSATION_PHASE_SET.has(phase)) {
        throw harnessError(`unknown compensation phase: ${String(phase)}`);
      }
      if (typeof fn !== 'function') throw harnessError('hook must be a function');
      compensationHooks.push({ action, phase, fn });
    },

    driftHostFile(role) {
      if (role !== 'controller' && role !== 'scheduler' && role !== 'manifest') {
        throw harnessError(`unknown drift role: ${String(role)}`);
      }
      const existing = harness.fileBytes(role);
      if (existing === null) throw harnessError(`cannot drift absent file: ${role}`);
      placeFile(role, Buffer.concat([existing, Buffer.from('\n# harness-drift', 'utf8')]));
    },

    /**
     * Task 5A.3 F2 RED seam：模拟事务外部使 host 文件缺失；不记录任何
     * lifecycle side effect/trace/counter；文件已缺失时 fail closed。
     */
    removeHostFileForTest(role) {
      if (role !== 'controller' && role !== 'scheduler' && role !== 'manifest') {
        throw harnessError(`unknown remove role: ${String(role)}`);
      }
      const rootId = role === 'manifest' ? ROOT_METADATA : ROOT_LAUNCH_AGENTS;
      if (!files.delete(fileKey(rootId, FILENAMES[role]))) {
        throw harnessError(`cannot remove absent file: ${role}`);
      }
      return true;
    },

    sha256(bytes) {
      return sha256Hex(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'));
    },

    /** 供测试构造 launchctl request 的合成路径（不进入 receipt）。 */
    syntheticResolvedPath(role) {
      if (role !== 'controller' && role !== 'scheduler') {
        throw harnessError(`unknown role: ${String(role)}`);
      }
      return resolvedPathFor(role);
    },

    fixedUid() {
      return FIXED_UID;
    },
  };

  return Object.freeze(harness);
}
