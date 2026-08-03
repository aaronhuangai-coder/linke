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
} from './contracts.js';
import { assertAndConsumeLaunchAgentManualRepairAuthority } from './acceptance-gate.js';

const DEPENDENCY_METHODS = Object.freeze({
  metadataStore: Object.freeze([
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
  ]),
  hostInspector: Object.freeze(['inspect', 'read', 'launchctlHostFacts']),
  profileRenderer: Object.freeze(['render', 'revalidate']),
  plistValidator: Object.freeze(['validate']),
  atomicPublisher: Object.freeze(['publishAbsent', 'replaceIfMatch', 'removeIfMatch']),
  launchctlRunner: Object.freeze(['run']),
  healthChecker: Object.freeze(['check']),
  clock: Object.freeze(['now', 'newId']),
  processIdentityReader: Object.freeze(['current', 'observe']),
});

/** residual recovery-claim 安全 resolution 终态（仅删 claim 后立即停止本次授权）。 */
const SAFE_RECOVERY_CLAIM_RESOLVE_STATUSES = new Set([
  'fresh-published',
  'old-intact',
  'transaction-lock-absent',
]);

const TERMINAL_STATES = new Set(['committed', 'recovered', 'no-change', 'blocked']);
// anchor durable 之后需要携带 recoveryContext 的 nonterminal business checkpoint；
// prepared/compensating/compensate-*/terminal 一律不写（§4.2、transactions 精确键断言）。
const RECOVERY_CONTEXT_STATES = new Set([
  'anchored',
  'published',
  'controller-loaded',
  'controller-ready',
  'scheduler-loaded',
  'manual-intervention-required',
  'controller-publish-intent',
  'controller-published',
  'scheduler-publish-intent',
  'scheduler-published',
  'manifest-publish-intent',
  'manifest-published',
  'controller-load-intent',
  'scheduler-load-intent',
  'scheduler-stop-intent',
  'scheduler-stopped',
  'controller-stop-intent',
  'controller-stopped',
  'controller-remove-intent',
  'controller-removed',
  'scheduler-remove-intent',
  'scheduler-removed',
  'manifest-remove-intent',
  'manifest-removed',
  'role-noop',
  'role-stop-noop',
  'role-load-noop',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ROOT_LAUNCH_AGENTS = LAUNCHAGENT_LIFECYCLE.rootIds.launchAgents;
const ROOT_METADATA = LAUNCHAGENT_LIFECYCLE.rootIds.metadata;
const FILENAMES = LAUNCHAGENT_LIFECYCLE.filenames;
const LABELS = LAUNCHAGENT_LIFECYCLE.labels;

function invalid() {
  throw new LaunchAgentLifecycleError(LAUNCHAGENT_LIFECYCLE_CODES.INVALID);
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
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    invalid();
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expectedKeys.length || ownKeys.some((key) => typeof key !== 'string')) {
    invalid();
  }
  const expected = new Set(expectedKeys);
  const result = Object.create(null);
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !expected.has(key)
      || !descriptor
      || !descriptor.enumerable
      || !Object.hasOwn(descriptor, 'value')
    ) {
      invalid();
    }
    result[key] = descriptor.value;
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(result, key)) invalid();
  }
  return result;
}

function requireUuid(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) invalid();
  return value;
}

function requireSha256(value) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) invalid();
  return value;
}

function requireCommit(value) {
  if (typeof value !== 'string' || !COMMIT_PATTERN.test(value)) invalid();
  return value;
}

/**
 * processIdentityReader.current() 闭合投影：descriptor-first exact plain data。
 * 外层仅 bootSessionIdentity/processStartIdentity；内层仅 available/value，
 * 且 available 必须 true、value 为拒绝 / \\ NUL CR/LF 的非空 string。
 * 无 unavailable 回落；畸形/accessor/错误原型一律 INVALID。
 */
function validateCurrentIdentity(value) {
  const fields = readExactObject(value, ['bootSessionIdentity', 'processStartIdentity']);
  return {
    bootSessionIdentity: validateAvailableIdentity(fields.bootSessionIdentity),
    processStartIdentity: validateAvailableIdentity(fields.processStartIdentity),
  };
}

function validateAvailableIdentity(value) {
  const fields = readExactObject(value, ['available', 'value']);
  if (fields.available !== true) invalid();
  if (typeof fields.value !== 'string' || fields.value.length === 0) invalid();
  const identity = fields.value;
  if (
    identity.includes('/')
    || identity.includes('\\')
    || identity.includes('\0')
    || identity.includes('\r')
    || identity.includes('\n')
  ) {
    invalid();
  }
  return { available: true, value: identity };
}

function validateDependencies(value) {
  try {
    const dependencyKeys = Object.keys(DEPENDENCY_METHODS);
    const fields = readExactObject(value, dependencyKeys);
    const snapshot = {};
    for (const key of dependencyKeys) {
      const dependency = fields[key];
      if (
        dependency === null
        || typeof dependency !== 'object'
        || Object.getPrototypeOf(dependency) !== Object.prototype
      ) {
        invalid();
      }
      const expectedMethods = DEPENDENCY_METHODS[key];
      const ownKeys = Reflect.ownKeys(dependency);
      if (
        ownKeys.length !== expectedMethods.length
        || ownKeys.some((method) => typeof method !== 'string' || !expectedMethods.includes(method))
      ) {
        invalid();
      }
      const methods = {};
      for (const method of expectedMethods) {
        const descriptor = Object.getOwnPropertyDescriptor(dependency, method);
        if (
          !descriptor
          || !descriptor.enumerable
          || !Object.hasOwn(descriptor, 'value')
          || typeof descriptor.value !== 'function'
        ) {
          invalid();
        }
        methods[method] = descriptor.value;
      }
      snapshot[key] = Object.freeze(methods);
    }
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof LaunchAgentLifecycleError) throw error;
    invalid();
  }
}

function validateOperationInput(value) {
  const fields = readExactObject(value, [
    'sourceCommit', 'scheduleSeconds', 'controllerEnvironment',
  ]);
  const sourceCommit = requireCommit(fields.sourceCommit);
  if (
    !Number.isSafeInteger(fields.scheduleSeconds)
    || fields.scheduleSeconds < LAUNCHAGENT_LIFECYCLE.scheduleSeconds.min
    || fields.scheduleSeconds > LAUNCHAGENT_LIFECYCLE.scheduleSeconds.max
  ) {
    invalid();
  }
  if (
    fields.controllerEnvironment === null
    || typeof fields.controllerEnvironment !== 'object'
    || Object.getPrototypeOf(fields.controllerEnvironment) !== Object.prototype
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
  return deepFreeze({
    sourceCommit,
    scheduleSeconds: fields.scheduleSeconds,
    controllerEnvironment: { ...environment },
  });
}

function validateStopInput(value) {
  const fields = readExactObject(value, ['sourceCommit']);
  return deepFreeze({ sourceCommit: requireCommit(fields.sourceCommit) });
}

function validateRollbackInput(value) {
  const fields = readExactObject(value, ['sourceCommit', 'targetAnchorId']);
  return deepFreeze({
    sourceCommit: requireCommit(fields.sourceCommit),
    targetAnchorId: requireUuid(fields.targetAnchorId),
  });
}

function journalEntrySha256(entry) {
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

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requirePositiveSafeInteger(value) {
  if (!Number.isSafeInteger(value) || value <= 0) invalid();
  return value;
}

/** lock ref 精确相等（双方同为 null 或四字段完全一致）。 */
function lockRefsExactEqual(left, right) {
  if (left === null && right === null) return true;
  if (left === null || right === null) return false;
  return (
    left.kind === right.kind
    && left.transactionId === right.transactionId
    && left.ownerNonce === right.ownerNonce
    && left.sha256 === right.sha256
  );
}

/** 投影 processIdentityReader.observe 闭合结果；仅 {status} 数据属性。 */
function validateObserveStatus(value) {
  const fields = readExactObject(value, ['status']);
  if (typeof fields.status !== 'string' || fields.status.length === 0) invalid();
  return fields.status;
}

/** 精确两次 dead；任一非 exact dead / malformed → false（调用方映射错误码）。 */
function isExactDeadStatus(value) {
  try {
    return validateObserveStatus(value) === 'dead';
  } catch {
    return false;
  }
}

/** transaction / MIR lock record 闭合投影（与 metadata-store schema 对齐）。 */
function projectLockRecord(value) {
  const fields = readExactObject(value, [
    'schemaVersion',
    'transactionId',
    'ownerPid',
    'ownerNonce',
    'bootSessionIdentity',
    'processStartIdentity',
  ]);
  if (fields.schemaVersion !== 1) invalid();
  const transactionId = requireUuid(fields.transactionId);
  const ownerNonce = requireUuid(fields.ownerNonce);
  if (transactionId === ownerNonce) invalid();
  return {
    schemaVersion: 1,
    transactionId,
    ownerPid: requirePositiveSafeInteger(fields.ownerPid),
    ownerNonce,
    bootSessionIdentity: validateAvailableIdentity(fields.bootSessionIdentity),
    processStartIdentity: validateAvailableIdentity(fields.processStartIdentity),
  };
}

function projectTransactionLockRef(value) {
  const fields = readExactObject(value, ['kind', 'transactionId', 'ownerNonce', 'sha256']);
  if (fields.kind !== 'transaction-lock') invalid();
  const transactionId = requireUuid(fields.transactionId);
  const ownerNonce = requireUuid(fields.ownerNonce);
  if (transactionId === ownerNonce) invalid();
  return {
    kind: 'transaction-lock',
    transactionId,
    ownerNonce,
    sha256: requireSha256(fields.sha256),
  };
}

function projectManualInterventionLockRef(value) {
  const fields = readExactObject(value, ['kind', 'transactionId', 'ownerNonce', 'sha256']);
  if (fields.kind !== 'manual-intervention-lock') invalid();
  const transactionId = requireUuid(fields.transactionId);
  const ownerNonce = requireUuid(fields.ownerNonce);
  if (transactionId === ownerNonce) invalid();
  return {
    kind: 'manual-intervention-lock',
    transactionId,
    ownerNonce,
    sha256: requireSha256(fields.sha256),
  };
}

function projectRecoveryClaimRef(value) {
  const fields = readExactObject(value, [
    'kind', 'claimId', 'transactionId', 'ownerNonce', 'sha256',
  ]);
  if (fields.kind !== 'recovery-claim-lock') invalid();
  const claimId = requireUuid(fields.claimId);
  const transactionId = requireUuid(fields.transactionId);
  const ownerNonce = requireUuid(fields.ownerNonce);
  if (claimId === transactionId || claimId === ownerNonce || transactionId === ownerNonce) {
    invalid();
  }
  return {
    kind: 'recovery-claim-lock',
    claimId,
    transactionId,
    ownerNonce,
    sha256: requireSha256(fields.sha256),
  };
}

function projectNullableTransactionLockRef(value) {
  if (value === null) return null;
  return projectTransactionLockRef(value);
}

/** recovery-claim record 闭合投影（严格 nested refs + 身份）。 */
function projectRecoveryClaimRecord(value) {
  const fields = readExactObject(value, [
    'schemaVersion',
    'kind',
    'claimId',
    'transactionId',
    'ownerPid',
    'ownerNonce',
    'bootSessionIdentity',
    'processStartIdentity',
    'expectedTransactionLockRef',
    'manualInterventionLockRef',
    'freshTransactionLockRef',
  ]);
  if (fields.schemaVersion !== 1) invalid();
  if (fields.kind !== 'recovery-claim-lock') invalid();
  const claimId = requireUuid(fields.claimId);
  const transactionId = requireUuid(fields.transactionId);
  const ownerNonce = requireUuid(fields.ownerNonce);
  if (claimId === transactionId || claimId === ownerNonce || transactionId === ownerNonce) {
    invalid();
  }
  const expectedTransactionLockRef = projectNullableTransactionLockRef(
    fields.expectedTransactionLockRef,
  );
  const manualInterventionLockRef = projectManualInterventionLockRef(
    fields.manualInterventionLockRef,
  );
  const freshTransactionLockRef = projectTransactionLockRef(fields.freshTransactionLockRef);
  if (
    expectedTransactionLockRef !== null
    && expectedTransactionLockRef.transactionId !== transactionId
  ) {
    invalid();
  }
  if (manualInterventionLockRef.transactionId !== transactionId) invalid();
  if (freshTransactionLockRef.transactionId !== transactionId) invalid();
  if (freshTransactionLockRef.ownerNonce !== ownerNonce) invalid();
  return {
    schemaVersion: 1,
    kind: 'recovery-claim-lock',
    claimId,
    transactionId,
    ownerPid: requirePositiveSafeInteger(fields.ownerPid),
    ownerNonce,
    bootSessionIdentity: validateAvailableIdentity(fields.bootSessionIdentity),
    processStartIdentity: validateAvailableIdentity(fields.processStartIdentity),
    expectedTransactionLockRef,
    manualInterventionLockRef,
    freshTransactionLockRef,
  };
}

/**
 * residual recovery-claim observation：present 时严格投影；畸形 → recovery-claim-stalled。
 * absent → null。
 */
function projectRecoveryClaimObservation(value) {
  if (value === null) return null;
  try {
    const fields = readExactObject(value, ['kind', 'ref', 'record']);
    if (fields.kind !== 'recovery-claim-observation') invalid();
    const ref = projectRecoveryClaimRef(fields.ref);
    const record = projectRecoveryClaimRecord(fields.record);
    if (
      ref.claimId !== record.claimId
      || ref.transactionId !== record.transactionId
      || ref.ownerNonce !== record.ownerNonce
    ) {
      invalid();
    }
    return { kind: 'recovery-claim-observation', ref, record };
  } catch (error) {
    if (
      error instanceof LaunchAgentLifecycleError
      && error.code === LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_CLAIM_STALLED
    ) {
      throw error;
    }
    coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_CLAIM_STALLED);
  }
}

function projectTransactionLockObservation(value) {
  if (value === null) return null;
  const fields = readExactObject(value, ['kind', 'ref', 'record']);
  if (fields.kind !== 'transaction-lock-observation') invalid();
  const ref = projectTransactionLockRef(fields.ref);
  const record = projectLockRecord(fields.record);
  if (
    ref.transactionId !== record.transactionId
    || ref.ownerNonce !== record.ownerNonce
  ) {
    invalid();
  }
  return { kind: 'transaction-lock-observation', ref, record };
}

function projectManualInterventionLockObservation(value) {
  if (value === null) return null;
  const fields = readExactObject(value, ['kind', 'ref', 'record']);
  if (fields.kind !== 'manual-intervention-lock-observation') invalid();
  const ref = projectManualInterventionLockRef(fields.ref);
  const record = projectLockRecord(fields.record);
  if (
    ref.transactionId !== record.transactionId
    || ref.ownerNonce !== record.ownerNonce
  ) {
    invalid();
  }
  return { kind: 'manual-intervention-lock-observation', ref, record };
}

function addressFor(role) {
  return {
    rootId: role === 'manifest' ? ROOT_METADATA : ROOT_LAUNCH_AGENTS,
    basename: FILENAMES[role],
  };
}

function isPresentIdentity(value) {
  return value !== null
    && typeof value === 'object'
    && Object.hasOwn(value, 'device')
    && Object.hasOwn(value, 'inode')
    && Object.hasOwn(value, 'sha256');
}

function projectFullIdentity(value, role, ownerUid) {
  const fields = readExactObject(value, [
    'rootId', 'basename', 'type', 'ownerUid', 'device', 'inode', 'sha256',
  ]);
  const address = addressFor(role);
  if (
    fields.rootId !== address.rootId
    || fields.basename !== address.basename
    || fields.type !== 'regular-file'
    || fields.ownerUid !== ownerUid
    || typeof fields.device !== 'string'
    || fields.device.length === 0
    || typeof fields.inode !== 'string'
    || fields.inode.length === 0
  ) {
    invalid();
  }
  requireSha256(fields.sha256);
  return deepFreeze({
    rootId: fields.rootId,
    basename: fields.basename,
    type: fields.type,
    ownerUid: fields.ownerUid,
    device: fields.device,
    inode: fields.inode,
    sha256: fields.sha256,
  });
}

function projectPublisherIdentity(value, role, ownerUid) {
  return projectFullIdentity(value, role, ownerUid);
}

function projectAbsentIdentity(value, role, ownerUid) {
  const fields = readExactObject(value, ['rootId', 'basename', 'type', 'ownerUid']);
  const address = addressFor(role);
  if (
    fields.rootId !== address.rootId
    || fields.basename !== address.basename
    || fields.type !== 'regular-file'
    || fields.ownerUid !== ownerUid
  ) {
    invalid();
  }
  return fields;
}

function candidateForPlist(candidateRef) {
  return {
    kind: 'launchagent-candidate',
    transactionId: candidateRef.transactionId,
    role: candidateRef.role,
    sha256: candidateRef.sha256,
  };
}

class FlowFailure extends Error {
  constructor(outcome, { forceManualIntervention = false } = {}) {
    super(outcome);
    this.outcome = outcome;
    this.forceManualIntervention = forceManualIntervention;
  }
}

/**
 * 创建 V1.46 用户级 LaunchAgent 事务协调器。
 * 所有宿主动作均经精确注入的窄适配器执行；本模块不直接访问文件系统或 launchctl。
 */
export function createLaunchAgentLifecycleCoordinator(dependencies) {
  const deps = validateDependencies(dependencies);

  async function readAndValidateHeads() {
    const snapshot = await deps.metadataStore.readJournalHeads();
    const fields = readExactObject(snapshot, ['kind', 'journalSha256', 'heads']);
    if (fields.kind !== 'journal-heads') invalid();
    requireSha256(fields.journalSha256);
    if (!Array.isArray(fields.heads)) invalid();

    let priorTransactionId = null;
    for (const rawHead of fields.heads) {
      const head = validateLaunchAgentJournal(rawHead);
      if (priorTransactionId !== null && priorTransactionId >= head.transactionId) invalid();
      priorTransactionId = head.transactionId;
      if (!TERMINAL_STATES.has(head.state)) {
        return { snapshot, blocker: head };
      }
      try {
        const receipt = validateLaunchAgentReceipt(
          await deps.metadataStore.readReceipt(head.transactionId),
        );
        const receiptSha256 = sha256Hex(Buffer.from(JSON.stringify(receipt), 'utf8'));
        if (
          receipt.transactionId !== head.transactionId
          || receipt.operation !== head.operation
          || receipt.state !== head.state
          || receipt.hostMutationCount !== head.payload.hostMutationCount
          || receiptSha256 !== head.payload.receiptSha256
        ) {
          return { snapshot, blocker: head };
        }
      } catch {
        return { snapshot, blocker: head };
      }
    }
    return { snapshot, blocker: null };
  }

  async function createLockRecord(transactionId, ownerNonce) {
    let identity;
    try {
      identity = validateCurrentIdentity(await deps.processIdentityReader.current());
    } catch (error) {
      if (error instanceof LaunchAgentLifecycleError) throw error;
      invalid();
    }
    return {
      schemaVersion: 1,
      transactionId,
      ownerPid: process.pid,
      ownerNonce,
      bootSessionIdentity: identity.bootSessionIdentity,
      processStartIdentity: identity.processStartIdentity,
    };
  }

  function receiptRoles(controller, scheduler) {
    return {
      controller: {
        label: LABELS.controller,
        outcome: controller.outcome,
        changed: controller.changed,
      },
      scheduler: {
        label: LABELS.scheduler,
        outcome: scheduler.outcome,
        changed: scheduler.changed,
      },
    };
  }

  async function beginTransaction(operation, sourceCommit, rendered) {
    const pre = await readAndValidateHeads();
    if (pre.blocker !== null) coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);

    const transactionId = requireUuid(deps.clock.newId());
    const ownerNonce = requireUuid(deps.clock.newId());
    const lockRef = await deps.metadataStore.acquireTransactionLock(
      await createLockRecord(transactionId, ownerNonce),
    );
    const verified = await deps.metadataStore.verifyTransactionLock(lockRef);
    if (verified !== true) invalid();

    const post = await readAndValidateHeads();
    const snapshotChanged = !sameValue(pre.snapshot, post.snapshot);
    const context = {
      operation,
      sourceCommit,
      rendered,
      transactionId,
      lockRef,
      lastEntry: null,
      mutationCount: 0,
      anchorId: null,
      anchor: null,
      anchorRef: null,
      facts: null,
      identities: { controller: null, scheduler: null, manifest: null },
      candidateRefs: { controller: null, scheduler: null, manifest: null },
      restorationCandidateTransactionId: null,
      possiblePublisherMutations: new Set(),
      published: new Set(),
      stopped: new Set(),
      loadedNew: { controller: false, scheduler: false },
    };

    if (post.blocker !== null || snapshotChanged) {
      await appendJournal(context, 'prepared');
      const blocker = post.blocker
        ?? post.snapshot.heads.find((head) => (
          !pre.snapshot.heads.some((prior) => sameValue(prior, head))
        ))
        ?? pre.snapshot.heads[0]
        ?? null;
      context.anchorId = requireUuid(deps.clock.newId());
      return {
        context,
        terminal: await closeWithReceipt(context, {
          state: 'blocked',
          outcome: 'recovery-required',
          success: false,
          blockedByEntrySha256: blocker?.entrySha256 ?? null,
          roles: receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        }),
      };
    }

    await appendJournal(context, 'prepared');
    return { context, terminal: null };
  }

  async function appendJournal(context, state, extraPayload = {}) {
    const sequence = context.lastEntry === null ? 0 : context.lastEntry.sequence + 1;
    const payload = { hostMutationCount: context.mutationCount, ...extraPayload };
    if (context.anchorRef !== null && RECOVERY_CONTEXT_STATES.has(state)) {
      payload.recoveryContext = {
        sourceCommit: context.sourceCommit,
        anchorRef: context.anchorRef,
        candidateRefs: {
          controller: context.candidateRefs.controller,
          scheduler: context.candidateRefs.scheduler,
          manifest: context.candidateRefs.manifest,
        },
      };
    }
    const entry = {
      schemaVersion: 1,
      transactionId: context.transactionId,
      sequence,
      previousEntrySha256: context.lastEntry?.entrySha256 ?? null,
      entrySha256: '0'.repeat(64),
      operation: context.operation,
      state,
      at: deps.clock.now(),
      payload,
    };
    entry.entrySha256 = journalEntrySha256(entry);
    const projection = validateLaunchAgentJournal(entry);
    await deps.metadataStore.appendJournal({
      entry: projection,
      expectedPrior: context.lastEntry === null
        ? null
        : {
          transactionId: context.transactionId,
          sequence: context.lastEntry.sequence,
          entrySha256: context.lastEntry.entrySha256,
        },
      writerLockRef: context.lockRef,
    });
    context.lastEntry = projection;
    return projection;
  }

  async function closeWithReceipt(context, options) {
    if (context.anchorId === null) context.anchorId = requireUuid(deps.clock.newId());
    const receipt = validateLaunchAgentReceipt({
      schemaVersion: 1,
      operation: context.operation,
      state: options.state,
      success: options.success,
      sourceCommit: context.sourceCommit,
      transactionId: context.transactionId,
      anchorId: context.anchorId,
      completedAt: deps.clock.now(),
      roles: options.roles,
      hostMutationCount: context.mutationCount,
      outcome: options.outcome,
    });
    const receiptSha256 = sha256Hex(Buffer.from(JSON.stringify(receipt), 'utf8'));
    const terminalPayload = { receipt, receiptSha256 };
    if (options.state === 'blocked') {
      terminalPayload.blockedByEntrySha256 = options.blockedByEntrySha256 ?? null;
    }
    await appendJournal(context, options.state, terminalPayload);
    await deps.metadataStore.publishReceipt({ receipt, lockRef: context.lockRef });
    const entries = await deps.metadataStore.readJournal({
      transactionId: context.transactionId,
    });
    const persisted = validateLaunchAgentReceipt(
      await deps.metadataStore.readReceipt(context.transactionId),
    );
    const closeout = validateLaunchAgentTransactionCloseout({ entries, receipt: persisted });
    if (!sameValue(receipt, closeout.receipt)) invalid();
    await deps.metadataStore.releaseTransactionLock(context.lockRef);
    return closeout.receipt;
  }

  async function enterManualIntervention(context, roles) {
    await appendJournal(context, 'manual-intervention-required');
    const manualNonce = requireUuid(deps.clock.newId());
    const mirLockRef = await deps.metadataStore.acquireManualInterventionLock(
      await createLockRecord(context.transactionId, manualNonce),
    );
    const verified = await deps.metadataStore.verifyManualInterventionLock(mirLockRef);
    if (verified !== true) invalid();
    await deps.metadataStore.releaseTransactionLock(context.lockRef, {
      manualInterventionLockRef: mirLockRef,
    });
    return validateLaunchAgentReceipt({
      schemaVersion: 1,
      operation: context.operation,
      state: 'manual-intervention-required',
      success: false,
      sourceCommit: context.sourceCommit,
      transactionId: context.transactionId,
      anchorId: context.anchorId,
      completedAt: deps.clock.now(),
      roles,
      hostMutationCount: context.mutationCount,
      outcome: 'manual-intervention-required',
    });
  }

  async function launchctlFacts() {
    const facts = await deps.hostInspector.launchctlHostFacts();
    const fields = readExactObject(facts, [
      'uid', 'rootId', 'basenames', 'resolvedPaths',
    ]);
    if (!Number.isSafeInteger(fields.uid) || fields.uid < 0) invalid();
    if (fields.rootId !== ROOT_LAUNCH_AGENTS) invalid();
    const basenames = readExactObject(fields.basenames, ['controller', 'scheduler']);
    const resolvedPaths = readExactObject(fields.resolvedPaths, ['controller', 'scheduler']);
    if (basenames.controller !== FILENAMES.controller || basenames.scheduler !== FILENAMES.scheduler) {
      invalid();
    }
    if (typeof resolvedPaths.controller !== 'string' || typeof resolvedPaths.scheduler !== 'string') {
      invalid();
    }
    return { uid: fields.uid, rootId: fields.rootId, basenames, resolvedPaths };
  }

  function launchctlRequest(facts, operation, role) {
    const domain = `gui/${facts.uid}`;
    const service = `${domain}/${LABELS[role]}`;
    let argv;
    if (operation === 'print') argv = ['print', service];
    else if (operation === 'bootstrap') argv = ['bootstrap', domain, facts.resolvedPaths[role]];
    else if (operation === 'bootout') argv = ['bootout', service];
    else invalid();
    return {
      operation,
      uid: facts.uid,
      rootId: facts.rootId,
      basename: facts.basenames[role],
      resolvedPath: facts.resolvedPaths[role],
      argv,
    };
  }

  async function probeJob(facts, role) {
    const result = await deps.launchctlRunner.run(launchctlRequest(facts, 'print', role));
    if (
      result === null
      || typeof result !== 'object'
      || (result.outcome !== 'ok' && result.outcome !== 'unknown-result')
    ) {
      invalid();
    }
    return result;
  }

  async function inspectCurrentState() {
    const inspected = {
      controller: await deps.hostInspector.inspect(addressFor('controller')),
      scheduler: await deps.hostInspector.inspect(addressFor('scheduler')),
      manifest: await deps.hostInspector.inspect(addressFor('manifest')),
    };
    const present = {
      controller: isPresentIdentity(inspected.controller),
      scheduler: isPresentIdentity(inspected.scheduler),
      manifest: isPresentIdentity(inspected.manifest),
    };
    const facts = await launchctlFacts();
    const identities = { controller: null, scheduler: null, manifest: null };
    for (const role of ['controller', 'scheduler', 'manifest']) {
      if (present[role]) {
        identities[role] = projectFullIdentity(inspected[role], role, facts.uid);
      }
    }
    const bytes = { controller: null, scheduler: null, manifest: null };
    for (const role of ['controller', 'scheduler', 'manifest']) {
      if (present[role]) bytes[role] = Buffer.from(await deps.hostInspector.read(identities[role]));
    }
    const jobs = {
      controller: await probeJob(facts, 'controller'),
      scheduler: await probeJob(facts, 'scheduler'),
    };
    return { identities, present, bytes, facts, jobs };
  }

  function parseManagedInstallation(snapshot, sourceCommit = null) {
    if (!snapshot.present.controller || !snapshot.present.scheduler || !snapshot.present.manifest) {
      return null;
    }
    let manifest;
    try {
      manifest = validateLaunchAgentManifest(
        JSON.parse(snapshot.bytes.manifest.toString('utf8')),
      );
    } catch {
      return null;
    }
    if (sourceCommit !== null && manifest.sourceCommit !== sourceCommit) return null;
    if (
      manifest.controller.plistSha256 !== snapshot.identities.controller.sha256
      || manifest.scheduler.plistSha256 !== snapshot.identities.scheduler.sha256
    ) {
      return null;
    }
    if (
      snapshot.identities.controller.ownerUid !== snapshot.facts.uid
      || snapshot.identities.scheduler.ownerUid !== snapshot.facts.uid
      || snapshot.identities.manifest.ownerUid !== snapshot.facts.uid
    ) {
      return null;
    }
    for (const role of ['controller', 'scheduler']) {
      const job = snapshot.jobs[role];
      if (job.outcome !== 'ok') return null;
      if (job.loaded && job.jobIdentitySha256 !== snapshot.identities[role].sha256) return null;
      if (!job.loaded && job.jobIdentitySha256 !== null) return null;
    }
    return manifest;
  }

  async function validateActiveAnchor(manifest) {
    try {
      const anchor = validateLaunchAgentAnchor(
        await deps.metadataStore.readAnchor(manifest.activeAnchorId),
      );
      if (
        anchor.anchorId !== manifest.activeAnchorId
        || anchor.transactionId !== manifest.transactionId
        || anchor.sourceCommit !== manifest.sourceCommit
      ) {
        invalid();
      }
      return anchor;
    } catch {
      return null;
    }
  }

  function anchorBytes(anchor, role) {
    const entry = anchor[role];
    if (entry.priorState !== 'bytes') return null;
    const bytes = Buffer.from(entry.bytesBase64, 'base64');
    if (sha256Hex(bytes) !== entry.sha256) invalid();
    return bytes;
  }

  function validateRollbackTarget(target, snapshot, manifest, targetAnchorId) {
    if (
      target.anchorId !== targetAnchorId
      || manifest.activeAnchorId !== targetAnchorId
      || target.rollbackFromManifestSha256 !== snapshot.identities.manifest.sha256
    ) {
      return null;
    }
    if (target.manifest.priorState === 'absent') {
      if (
        target.restoreManifestSha256 !== null
        || target.parentAnchorId !== null
        || target.controller.priorState !== 'absent'
        || target.scheduler.priorState !== 'absent'
        || target.loaded.controller
        || target.loaded.scheduler
      ) {
        return null;
      }
      return { manifest: null, bytes: null };
    }
    if (
      target.controller.priorState !== 'bytes'
      || target.scheduler.priorState !== 'bytes'
      || target.restoreManifestSha256 !== target.manifest.sha256
      || target.parentAnchorId === null
    ) {
      return null;
    }
    try {
      const bytes = anchorBytes(target, 'manifest');
      const restored = validateLaunchAgentManifest(JSON.parse(bytes.toString('utf8')));
      if (
        restored.activeAnchorId !== target.parentAnchorId
        || restored.controller.plistSha256 !== target.controller.sha256
        || restored.scheduler.plistSha256 !== target.scheduler.sha256
      ) {
        return null;
      }
      return { manifest: restored, bytes };
    } catch {
      return null;
    }
  }

  function anchorEntry(snapshot, role) {
    return {
      priorState: 'bytes',
      bytesBase64: snapshot.bytes[role].toString('base64'),
      sha256: snapshot.identities[role].sha256,
      identity: { ...snapshot.identities[role] },
    };
  }

  async function writeAnchor(
    context,
    snapshot,
    purpose,
    sourceCommit,
    parentAnchorId,
    rollbackFromManifestSha256 = undefined,
  ) {
    const present = purpose !== 'first-install';
    if (context.anchor !== null) invalid();
    if (context.anchorId === null) context.anchorId = requireUuid(deps.clock.newId());
    const rollbackFrom = rollbackFromManifestSha256 === undefined
      ? (present ? snapshot.identities.manifest.sha256 : null)
      : rollbackFromManifestSha256;
    const anchor = validateLaunchAgentAnchor({
      schemaVersion: 1,
      anchorId: context.anchorId,
      parentAnchorId,
      transactionId: context.transactionId,
      sourceCommit,
      purpose,
      rollbackFromManifestSha256: rollbackFrom,
      restoreManifestSha256: present ? snapshot.identities.manifest.sha256 : null,
      controller: present ? anchorEntry(snapshot, 'controller') : { priorState: 'absent' },
      scheduler: present ? anchorEntry(snapshot, 'scheduler') : { priorState: 'absent' },
      manifest: present ? anchorEntry(snapshot, 'manifest') : { priorState: 'absent' },
      loaded: present
        ? {
          controller: snapshot.jobs.controller.loaded,
          scheduler: snapshot.jobs.scheduler.loaded,
        }
        : { controller: false, scheduler: false },
      createdAt: deps.clock.now(),
    });
    const ref = await deps.metadataStore.writeAnchor(anchor);
    if (
      ref === null
      || typeof ref !== 'object'
      || ref.kind !== 'anchor'
      || ref.anchorId !== context.anchorId
      || !SHA256_PATTERN.test(ref.sha256)
    ) {
      invalid();
    }
    context.anchorRef = {
      kind: 'anchor',
      anchorId: context.anchorId,
      sha256: ref.sha256,
    };
    context.anchor = anchor;
    await appendJournal(context, 'anchored');
    return anchor;
  }

  function makeManifest(context, rendered, activeAnchorId, existingManifest = null) {
    return validateLaunchAgentManifest({
      schemaVersion: 1,
      installationId: existingManifest?.installationId ?? requireUuid(deps.clock.newId()),
      scope: LAUNCHAGENT_LIFECYCLE.scope,
      sourceCommit: context.sourceCommit,
      runtimeArtifacts: rendered.manifestRuntimeArtifacts,
      transactionId: context.transactionId,
      controller: {
        label: rendered.controller.label,
        filename: rendered.controller.filename,
        plistSha256: rendered.controller.plistSha256,
      },
      scheduler: {
        label: rendered.scheduler.label,
        filename: rendered.scheduler.filename,
        plistSha256: rendered.scheduler.plistSha256,
      },
      activeAnchorId,
      installedAt: deps.clock.now(),
    });
  }

  function projectCandidateRef(value, transactionId, role, sha256) {
    const fields = readExactObject(value, [
      'kind', 'transactionId', 'role', 'sha256',
    ]);
    if (
      fields.kind !== 'candidate'
      || fields.transactionId !== transactionId
      || fields.role !== role
      || fields.sha256 !== sha256
    ) {
      invalid();
    }
    requireUuid(fields.transactionId);
    requireSha256(fields.sha256);
    return deepFreeze({
      kind: 'candidate',
      transactionId: fields.transactionId,
      role: fields.role,
      sha256: fields.sha256,
    });
  }

  async function stageCandidates(context, bytesByRole) {
    for (const role of ['controller', 'scheduler', 'manifest']) {
      const candidateRef = await deps.metadataStore.writeCandidate({
        transactionId: context.transactionId,
        role,
        bytes: bytesByRole[role],
      });
      context.candidateRefs[role] = projectCandidateRef(
        candidateRef,
        context.transactionId,
        role,
        sha256Hex(bytesByRole[role]),
      );
    }

    for (const role of ['controller', 'scheduler']) {
      const bytes = await deps.metadataStore.readCandidate(context.candidateRefs[role]);
      if (!Buffer.isBuffer(bytes) || sha256Hex(bytes) !== context.candidateRefs[role].sha256) {
        invalid();
      }
      const lint = await deps.plistValidator.validate(candidateForPlist(context.candidateRefs[role]));
      if (lint === null || typeof lint !== 'object' || lint.valid !== true) {
        throw new FlowFailure('conditional-mutation-mismatch');
      }
    }
  }

  async function stageRollbackCandidates(context, target) {
    for (const role of ['controller', 'scheduler', 'manifest']) {
      const entry = target[role];
      if (entry.priorState !== 'bytes') continue;
      if (context.identities[role]?.sha256 === entry.sha256) continue;
      const bytes = anchorBytes(target, role);
      const candidateRef = await deps.metadataStore.writeCandidate({
        transactionId: context.transactionId,
        role,
        bytes,
      });
      context.candidateRefs[role] = projectCandidateRef(
        candidateRef,
        context.transactionId,
        role,
        entry.sha256,
      );
      const persisted = await deps.metadataStore.readCandidate(context.candidateRefs[role]);
      if (!Buffer.isBuffer(persisted) || Buffer.compare(persisted, bytes) !== 0) invalid();
      if (role !== 'manifest') {
        const lint = await deps.plistValidator.validate(
          candidateForPlist(context.candidateRefs[role]),
        );
        if (lint?.valid !== true) throw new FlowFailure('conditional-mutation-mismatch');
      }
    }
  }

  async function replaceCandidate(input, expected) {
    return deps.atomicPublisher.replaceIfMatch({ ...input, expected });
  }

  async function publishCandidate(context, role, expected = null) {
    await appendJournal(context, `${role}-publish-intent`, { role });
    const input = {
      ...addressFor(role),
      candidateRef: context.candidateRefs[role],
    };
    const result = expected === null
      ? await deps.atomicPublisher.publishAbsent(input)
      : await replaceCandidate(input, expected);
    if (result === null || typeof result !== 'object' || result.outcome !== 'ok') {
      throw new FlowFailure('conditional-mutation-mismatch');
    }
    context.possiblePublisherMutations.add(role);
    let inspected;
    let actualCandidatePublished = false;
    try {
      inspected = projectFullIdentity(
        await deps.hostInspector.inspect(addressFor(role)),
        role,
        context.facts.uid,
      );
      actualCandidatePublished = inspected.sha256 === context.candidateRefs[role].sha256
        && (
          expected === null
          || inspected.device !== expected.device
          || inspected.inode !== expected.inode
        );
      if (actualCandidatePublished) {
        context.mutationCount += 1;
        context.possiblePublisherMutations.delete(role);
        context.identities[role] = inspected;
        context.published.add(role);
      }
      const observedUnchanged = expected !== null && sameValue(inspected, expected);
      if (!actualCandidatePublished && !observedUnchanged) {
        if (context.possiblePublisherMutations.delete(role)) context.mutationCount += 1;
        throw new FlowFailure('conditional-mutation-mismatch', {
          forceManualIntervention: true,
        });
      }
      if (observedUnchanged) context.possiblePublisherMutations.delete(role);
      const claimed = projectPublisherIdentity(result.identity, role, context.facts.uid);
      if (
        !actualCandidatePublished
        || !sameValue(claimed, inspected)
      ) {
        throw new FlowFailure('conditional-mutation-mismatch', {
          forceManualIntervention: actualCandidatePublished,
        });
      }
    } catch (error) {
      if (error instanceof FlowFailure) throw error;
      if (context.possiblePublisherMutations.delete(role)) context.mutationCount += 1;
      throw new FlowFailure('conditional-mutation-mismatch', {
        forceManualIntervention: true,
      });
    }
    await appendJournal(context, `${role}-published`, { role });
  }

  async function removeManagedIdentity(context, role) {
    const expected = context.identities[role];
    if (expected === null) invalid();
    await appendJournal(context, `${role}-remove-intent`, { role });
    const result = await deps.atomicPublisher.removeIfMatch({
      ...addressFor(role),
      expected,
    });
    if (result?.outcome !== 'ok') {
      throw new FlowFailure('conditional-mutation-mismatch');
    }
    context.mutationCount += 1;
    context.possiblePublisherMutations.add(role);
    try {
      projectAbsentIdentity(
        await deps.hostInspector.inspect(addressFor(role)),
        role,
        context.facts.uid,
      );
    } catch {
      throw new FlowFailure('conditional-mutation-mismatch', {
        forceManualIntervention: true,
      });
    }
    context.possiblePublisherMutations.delete(role);
    context.identities[role] = null;
    context.published.add(role);
    await appendJournal(context, `${role}-removed`, { role });
  }

  async function bootout(context, facts, role) {
    await appendJournal(context, `${role}-stop-intent`, { role });
    const result = await deps.launchctlRunner.run(launchctlRequest(facts, 'bootout', role));
    context.mutationCount += 1;
    if (result === null || typeof result !== 'object' || result.outcome !== 'ok') {
      const observed = await probeJob(facts, role);
      if (observed.outcome !== 'ok') {
        throw new FlowFailure('conditional-mutation-mismatch', {
          forceManualIntervention: true,
        });
      }
      if (observed.loaded === false) context.stopped.add(role);
      else if (
        observed.loaded !== true
        || observed.jobIdentitySha256 !== context.identities[role]?.sha256
      ) {
        throw new FlowFailure('conditional-mutation-mismatch', {
          forceManualIntervention: true,
        });
      }
      throw new FlowFailure('conditional-mutation-mismatch');
    }
    const observed = await probeJob(facts, role);
    if (observed.outcome !== 'ok') {
      throw new FlowFailure('conditional-mutation-mismatch', {
        forceManualIntervention: true,
      });
    }
    if (observed.loaded !== false) {
      throw new FlowFailure('conditional-mutation-mismatch');
    }
    context.stopped.add(role);
    await appendJournal(context, `${role}-stopped`, { role });
  }

  async function recoverIncompleteUnload(context, snapshot, outcome) {
    for (const role of ['controller', 'scheduler']) {
      const observed = await probeJob(snapshot.facts, role);
      if (observed.outcome !== 'ok') {
        return enterManualIntervention(
          context,
          receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        );
      }
      if (observed.loaded === false && observed.jobIdentitySha256 === null) {
        if (snapshot.jobs[role].loaded) context.stopped.add(role);
        continue;
      }
      if (
        observed.loaded !== true
        || !snapshot.jobs[role].loaded
        || observed.jobIdentitySha256 !== snapshot.identities[role].sha256
      ) {
        return enterManualIntervention(
          context,
          receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        );
      }
      context.stopped.delete(role);
    }
    return compensate(context, snapshot, outcome, 'upgrade');
  }

  async function unloadOwnedJobs(context, snapshot, incompleteOutcome) {
    for (const role of ['scheduler', 'controller']) {
      const fresh = await probeJob(snapshot.facts, role);
      const expectedLoaded = snapshot.jobs[role].loaded;
      if (
        fresh.outcome !== 'ok'
        || fresh.loaded !== expectedLoaded
        || (expectedLoaded && fresh.jobIdentitySha256 !== snapshot.identities[role].sha256)
        || (!expectedLoaded && fresh.jobIdentitySha256 !== null)
      ) {
        return closeWithReceipt(context, {
          state: 'blocked', outcome: 'ownership-mismatch', success: false,
          blockedByEntrySha256: null,
          roles: receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        });
      }
      if (!expectedLoaded) {
        await appendJournal(context, 'role-stop-noop', { role });
        continue;
      }
      try {
        await bootout(context, snapshot.facts, role);
      } catch (error) {
        if (!(error instanceof FlowFailure)) throw error;
        return recoverIncompleteUnload(context, snapshot, incompleteOutcome);
      }
    }
    for (const role of ['scheduler', 'controller']) {
      const observed = await probeJob(snapshot.facts, role);
      if (
        observed.outcome !== 'ok'
        || observed.loaded !== false
        || observed.jobIdentitySha256 !== null
      ) {
        return recoverIncompleteUnload(context, snapshot, incompleteOutcome);
      }
    }
    return null;
  }

  function controllerPort(input) {
    const raw = input.controllerEnvironment.PORT;
    if (typeof raw === 'string' && /^\d+$/.test(raw)) {
      const parsed = Number(raw);
      if (Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 65535) return parsed;
    }
    return 8899;
  }

  function controllerPortFromPlistBytes(value) {
    if (!Buffer.isBuffer(value)) invalid();
    const text = value.toString('utf8');
    let rawPort;
    try {
      const descriptor = JSON.parse(text);
      if (
        descriptor === null
        || typeof descriptor !== 'object'
        || Array.isArray(descriptor)
        || Object.getPrototypeOf(descriptor) !== Object.prototype
      ) {
        invalid();
      }
      const label = descriptor.Label ?? descriptor.label;
      if (label !== LABELS.controller) invalid();
      const environment = descriptor.EnvironmentVariables ?? descriptor.controllerEnvironment;
      if (
        environment === null
        || typeof environment !== 'object'
        || Array.isArray(environment)
        || Object.getPrototypeOf(environment) !== Object.prototype
      ) {
        invalid();
      }
      rawPort = environment.PORT;
    } catch (error) {
      if (error instanceof LaunchAgentLifecycleError) throw error;
      const labelMatches = [...text.matchAll(
        /<key>Label<\/key>\s*<string>([^<]*)<\/string>/g,
      )];
      if (labelMatches.length !== 1 || labelMatches[0][1] !== LABELS.controller) invalid();
      const portMatches = [...text.matchAll(
        /<key>PORT<\/key>\s*<string>([^<]*)<\/string>/g,
      )];
      if (portMatches.length > 1) invalid();
      rawPort = portMatches[0]?.[1];
    }
    if (rawPort === undefined) return 8899;
    if (typeof rawPort !== 'string' || !/^\d+$/.test(rawPort)) invalid();
    const parsed = Number(rawPort);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) invalid();
    return parsed;
  }

  async function revalidateRuntime(reason) {
    try {
      const result = await deps.profileRenderer.revalidate(reason);
      if (result === null || typeof result !== 'object' || result.ok !== true) {
        throw new FlowFailure('rollback-runtime-mismatch');
      }
      return result;
    } catch (error) {
      if (error instanceof FlowFailure) throw error;
      if (
        error instanceof LaunchAgentLifecycleError
        && error.code === LAUNCHAGENT_LIFECYCLE_CODES.ROLLBACK_RUNTIME_MISMATCH
      ) {
        throw new FlowFailure('rollback-runtime-mismatch');
      }
      throw new FlowFailure('rollback-runtime-mismatch');
    }
  }

  async function bootstrapController(context, facts, input, expectedSha256) {
    await appendJournal(context, 'controller-load-intent', { role: 'controller' });
    await revalidateRuntime('before-bootstrap-controller');
    const result = await deps.launchctlRunner.run(
      launchctlRequest(facts, 'bootstrap', 'controller'),
    );
    context.mutationCount += 1;
    if (result === null || typeof result !== 'object' || result.outcome !== 'ok') {
      const observed = await probeJob(facts, 'controller');
      if (observed.outcome !== 'ok') {
        throw new FlowFailure('controller-not-ready', { forceManualIntervention: true });
      }
      if (
        observed.loaded === true
        && observed.jobIdentitySha256 === expectedSha256
      ) {
        context.loadedNew.controller = true;
      } else if (observed.loaded !== false) {
        throw new FlowFailure('controller-not-ready', { forceManualIntervention: true });
      }
      throw new FlowFailure('controller-not-ready');
    }
    const observed = await probeJob(facts, 'controller');
    if (
      observed.outcome !== 'ok'
      || observed.loaded !== true
      || observed.jobIdentitySha256 !== expectedSha256
    ) {
      throw new FlowFailure('controller-not-ready', { forceManualIntervention: true });
    }
    context.loadedNew.controller = true;
    await appendJournal(context, 'controller-loaded');
    const health = await deps.healthChecker.check({ port: controllerPort(input) });
    if (
      health === null
      || typeof health !== 'object'
      || health.statusCode !== 200
      || health.ready !== true
    ) {
      throw new FlowFailure('controller-not-ready');
    }
    await appendJournal(context, 'controller-ready');
  }

  async function bootstrapScheduler(context, facts, expectedSha256) {
    await appendJournal(context, 'scheduler-load-intent', { role: 'scheduler' });
    await revalidateRuntime('before-bootstrap-scheduler');
    const result = await deps.launchctlRunner.run(
      launchctlRequest(facts, 'bootstrap', 'scheduler'),
    );
    context.mutationCount += 1;
    if (result === null || typeof result !== 'object' || result.outcome !== 'ok') {
      const observed = await probeJob(facts, 'scheduler');
      if (observed.outcome !== 'ok') {
        throw new FlowFailure('scheduler-load-failed', { forceManualIntervention: true });
      }
      if (
        observed.loaded === true
        && observed.jobIdentitySha256 === expectedSha256
      ) {
        context.loadedNew.scheduler = true;
      } else if (observed.loaded !== false) {
        throw new FlowFailure('scheduler-load-failed', { forceManualIntervention: true });
      }
      throw new FlowFailure('scheduler-load-failed');
    }
    const observed = await probeJob(facts, 'scheduler');
    if (
      observed.outcome !== 'ok'
      || observed.loaded !== true
      || observed.jobIdentitySha256 !== expectedSha256
    ) {
      throw new FlowFailure('scheduler-load-failed', { forceManualIntervention: true });
    }
    context.loadedNew.scheduler = true;
    const scheduled = await probeJob(facts, 'scheduler');
    if (scheduled.outcome !== 'ok' || scheduled.scheduledOutcome !== 'ok') {
      if (scheduled.outcome !== 'ok') {
        throw new FlowFailure('scheduler-load-failed', { forceManualIntervention: true });
      }
      throw new FlowFailure('scheduler-load-failed');
    }
    await appendJournal(context, 'scheduler-loaded');
  }

  async function verifyLoadedPostState(context, facts) {
    for (const role of ['controller', 'scheduler']) {
      const observed = await probeJob(facts, role);
      if (
        observed.outcome !== 'ok'
        || observed.loaded !== true
        || observed.jobIdentitySha256 !== context.identities[role].sha256
      ) {
        throw new FlowFailure(role === 'controller' ? 'controller-not-ready' : 'scheduler-load-failed');
      }
    }
  }

  async function verifyCommittedFiles(context) {
    try {
      const current = {};
      for (const role of ['controller', 'scheduler', 'manifest']) {
        current[role] = projectFullIdentity(
          await deps.hostInspector.inspect(addressFor(role)),
          role,
          context.facts.uid,
        );
        if (!sameValue(current[role], context.identities[role])) {
          throw new FlowFailure('conditional-mutation-mismatch');
        }
      }
      const manifest = validateLaunchAgentManifest(JSON.parse(
        Buffer.from(await deps.hostInspector.read(current.manifest)).toString('utf8'),
      ));
      if (
        manifest.transactionId !== context.transactionId
        || manifest.sourceCommit !== context.sourceCommit
        || manifest.activeAnchorId !== context.anchorId
        || manifest.controller.plistSha256 !== current.controller.sha256
        || manifest.scheduler.plistSha256 !== current.scheduler.sha256
        || !sameValue(manifest.runtimeArtifacts, context.rendered.manifestRuntimeArtifacts)
      ) {
        throw new FlowFailure('conditional-mutation-mismatch');
      }
      const anchor = await validateActiveAnchor(manifest);
      if (anchor === null) throw new FlowFailure('ownership-mismatch');
    } catch (error) {
      if (error instanceof FlowFailure) throw error;
      throw new FlowFailure('conditional-mutation-mismatch');
    }
  }

  async function applyRollbackFiles(context, target) {
    for (const role of ['controller', 'scheduler', 'manifest']) {
      const entry = target[role];
      if (entry.priorState === 'absent') {
        await removeManagedIdentity(context, role);
        continue;
      }
      if (context.identities[role]?.sha256 === entry.sha256) {
        if (role === 'manifest') invalid();
        const currentBytes = await deps.hostInspector.read(context.identities[role]);
        if (Buffer.compare(Buffer.from(currentBytes), anchorBytes(target, role)) !== 0) invalid();
        await appendJournal(context, 'role-noop', { role });
        continue;
      }
      await publishCandidate(context, role, context.identities[role]);
    }
  }

  async function replayRollbackLoadedState(context, target, targetControllerPort) {
    for (const role of ['controller', 'scheduler']) {
      if (!target.loaded[role]) {
        const observed = await probeJob(context.facts, role);
        if (
          observed.outcome !== 'ok'
          || observed.loaded !== false
          || observed.jobIdentitySha256 !== null
        ) {
          throw new FlowFailure('conditional-mutation-mismatch');
        }
        await appendJournal(context, 'role-load-noop', { role });
        continue;
      }
      if (role === 'controller') {
        await bootstrapController(
          context,
          context.facts,
          { controllerEnvironment: { PORT: String(targetControllerPort) } },
          context.identities.controller.sha256,
        );
      } else {
        await bootstrapScheduler(
          context,
          context.facts,
          context.identities.scheduler.sha256,
        );
      }
    }
  }

  async function verifyRollbackTarget(
    context,
    target,
    targetProjection,
    targetControllerPort,
  ) {
    await revalidateRuntime('before-commit');
    const persistedTarget = validateLaunchAgentAnchor(
      await deps.metadataStore.readAnchor(target.anchorId),
    );
    if (!sameValue(persistedTarget, target)) invalid();

    const currentBytes = { controller: null, scheduler: null, manifest: null };
    for (const role of ['controller', 'scheduler', 'manifest']) {
      const inspected = await deps.hostInspector.inspect(addressFor(role));
      if (target[role].priorState === 'absent') {
        projectAbsentIdentity(inspected, role, context.facts.uid);
        if (context.identities[role] !== null) invalid();
        continue;
      }
      const identity = projectFullIdentity(inspected, role, context.facts.uid);
      const bytes = Buffer.from(await deps.hostInspector.read(identity));
      if (
        identity.sha256 !== target[role].sha256
        || Buffer.compare(bytes, anchorBytes(target, role)) !== 0
        || !sameValue(identity, context.identities[role])
      ) {
        throw new FlowFailure('conditional-mutation-mismatch');
      }
      currentBytes[role] = bytes;
    }

    if (targetProjection.manifest !== null) {
      const restored = validateLaunchAgentManifest(
        JSON.parse(currentBytes.manifest.toString('utf8')),
      );
      if (!sameValue(restored, targetProjection.manifest)) invalid();
      const parent = await validateActiveAnchor(restored);
      if (parent === null || parent.anchorId !== target.parentAnchorId) {
        throw new FlowFailure('ownership-mismatch');
      }
    }

    for (const role of ['controller', 'scheduler']) {
      const observed = await probeJob(context.facts, role);
      const expectedLoaded = target.loaded[role];
      if (
        observed.outcome !== 'ok'
        || observed.loaded !== expectedLoaded
        || (
          expectedLoaded
            ? observed.jobIdentitySha256 !== context.identities[role]?.sha256
            : observed.jobIdentitySha256 !== null
        )
      ) {
        throw new FlowFailure('conditional-mutation-mismatch');
      }
    }
    if (target.loaded.controller) {
      const health = await deps.healthChecker.check({ port: targetControllerPort });
      if (health?.statusCode !== 200 || health?.ready !== true) {
        throw new FlowFailure('controller-not-ready');
      }
    }
  }

  async function verifyUninstalled(context) {
    for (const role of ['controller', 'scheduler', 'manifest']) {
      projectAbsentIdentity(
        await deps.hostInspector.inspect(addressFor(role)),
        role,
        context.facts.uid,
      );
      if (context.identities[role] !== null) invalid();
    }
    for (const role of ['controller', 'scheduler']) {
      const observed = await probeJob(context.facts, role);
      if (
        observed.outcome !== 'ok'
        || observed.loaded !== false
        || observed.jobIdentitySha256 !== null
      ) {
        throw new FlowFailure('conditional-mutation-mismatch');
      }
    }
  }

  async function completeInstall(context, input, snapshot) {
    context.anchorId = requireUuid(deps.clock.newId());
    const manifest = makeManifest(context, context.rendered, context.anchorId);
    const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    await writeAnchor(
      context,
      snapshot,
      'first-install',
      context.sourceCommit,
      null,
      sha256Hex(manifestBytes),
    );
    const candidateBytes = {
      controller: Buffer.from(context.rendered.controller.plistBytes),
      scheduler: Buffer.from(context.rendered.scheduler.plistBytes),
      manifest: manifestBytes,
    };
    try {
      await stageCandidates(context, candidateBytes);
    } catch (error) {
      if (!(error instanceof FlowFailure)) throw error;
      return closeWithReceipt(context, {
        state: 'blocked', outcome: error.outcome, success: false,
        blockedByEntrySha256: null,
        roles: receiptRoles(
          { outcome: 'unchanged', changed: false },
          { outcome: 'unchanged', changed: false },
        ),
      });
    }

    try {
      await publishCandidate(context, 'controller');
      await publishCandidate(context, 'scheduler');
      await revalidateRuntime('before-manifest-publish');
      await publishCandidate(context, 'manifest');
      await bootstrapController(
        context,
        snapshot.facts,
        input,
        context.candidateRefs.controller.sha256,
      );
      await bootstrapScheduler(
        context,
        snapshot.facts,
        context.candidateRefs.scheduler.sha256,
      );
      await verifyLoadedPostState(context, snapshot.facts);
      await revalidateRuntime('before-commit');
      await verifyCommittedFiles(context);
      return await closeWithReceipt(context, {
        state: 'committed', outcome: 'completed', success: true,
        roles: receiptRoles(
          { outcome: 'created', changed: true },
          { outcome: 'created', changed: true },
        ),
      });
    } catch (error) {
      if (!(error instanceof FlowFailure)) throw error;
      if (error.forceManualIntervention) {
        return enterManualIntervention(
          context,
          receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        );
      }
      if (context.mutationCount === 0) {
        return closeWithReceipt(context, {
          state: 'blocked', outcome: error.outcome, success: false,
          blockedByEntrySha256: null,
          roles: receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        });
      }
      return compensate(context, snapshot, error.outcome, 'install');
    }
  }

  async function stageRestorationCandidate(context, snapshot, role) {
    try {
      if (context.restorationCandidateTransactionId === null) {
        const namespace = requireUuid(deps.clock.newId());
        if (namespace === context.transactionId) {
          throw new FlowFailure('manual-intervention-required', {
            forceManualIntervention: true,
          });
        }
        context.restorationCandidateTransactionId = namespace;
      }
      const bytes = snapshot.bytes[role];
      const expectedSha256 = sha256Hex(bytes);
      const ref = projectCandidateRef(
        await deps.metadataStore.writeCandidate({
          // 正向 candidate 不可覆盖；补偿使用严格独立的持久化命名空间。
          transactionId: context.restorationCandidateTransactionId,
          role,
          bytes,
        }),
        context.restorationCandidateTransactionId,
        role,
        expectedSha256,
      );
      const persisted = await deps.metadataStore.readCandidate(ref);
      if (!Buffer.isBuffer(persisted) || sha256Hex(persisted) !== expectedSha256) {
        throw new FlowFailure('manual-intervention-required', {
          forceManualIntervention: true,
        });
      }
      context.candidateRefs[role] = ref;
      return ref;
    } catch (error) {
      if (error instanceof FlowFailure) throw error;
      throw new FlowFailure('manual-intervention-required', {
        forceManualIntervention: true,
      });
    }
  }

  async function removePublishedIdentity(context, role) {
    const input = { ...addressFor(role), expected: context.identities[role] };
    const result = await deps.atomicPublisher.removeIfMatch(input);
    if (result?.outcome !== 'ok') {
      throw new FlowFailure('manual-intervention-required', {
        forceManualIntervention: true,
      });
    }
    context.possiblePublisherMutations.add(role);
    context.mutationCount += 1;
    try {
      projectAbsentIdentity(
        await deps.hostInspector.inspect(addressFor(role)),
        role,
        context.facts.uid,
      );
    } catch {
      throw new FlowFailure('manual-intervention-required', {
        forceManualIntervention: true,
      });
    }
    context.possiblePublisherMutations.delete(role);
  }

  async function publishRestorationCandidate(context, role, candidateRef) {
    const expected = context.identities[role];
    const input = { ...addressFor(role), candidateRef };
    const result = expected === null
      ? await deps.atomicPublisher.publishAbsent(input)
      : await replaceCandidate(input, expected);
    if (result === null || typeof result !== 'object' || result.outcome !== 'ok') {
      throw new FlowFailure('manual-intervention-required', {
        forceManualIntervention: true,
      });
    }
    context.possiblePublisherMutations.add(role);
    context.mutationCount += 1;
    let inspected;
    try {
      const claimed = projectPublisherIdentity(result.identity, role, context.facts.uid);
      inspected = projectFullIdentity(
        await deps.hostInspector.inspect(addressFor(role)),
        role,
        context.facts.uid,
      );
      if (
        claimed.sha256 !== candidateRef.sha256
        || inspected.sha256 !== candidateRef.sha256
        || !sameValue(claimed, inspected)
        || (
          expected !== null
          && inspected.device === expected.device
          && inspected.inode === expected.inode
        )
      ) {
        throw new FlowFailure('manual-intervention-required', {
          forceManualIntervention: true,
        });
      }
    } catch (error) {
      if (error instanceof FlowFailure) throw error;
      throw new FlowFailure('manual-intervention-required', {
        forceManualIntervention: true,
      });
    }
    context.possiblePublisherMutations.delete(role);
    context.identities[role] = inspected;
  }

  function reverseFileState(identity) {
    if (identity === null) return { state: 'absent' };
    return {
      state: 'present',
      identity: { ...identity },
      sha256: identity.sha256,
    };
  }

  function reverseJobState(loaded, identity) {
    return loaded
      ? { state: 'loaded', identitySha256: identity.sha256 }
      : { state: 'stopped', identitySha256: null };
  }

  function reverseExpected(identity, loaded = false) {
    return {
      file: reverseFileState(identity),
      job: reverseJobState(loaded, identity),
    };
  }

  function candidateEvidence(context, role, identity) {
    const candidateRef = context.candidateRefs[role];
    if (
      candidateRef === null
      || candidateRef.role !== role
      || candidateRef.sha256 !== identity?.sha256
    ) {
      throw new FlowFailure('manual-intervention-required', {
        forceManualIntervention: true,
      });
    }
    return {
      kind: 'candidate',
      transactionId: candidateRef.transactionId,
      role,
      sha256: candidateRef.sha256,
    };
  }

  function anchorEvidence(context, snapshot, role) {
    const identity = snapshot.identities[role];
    if (identity === null) {
      throw new FlowFailure('manual-intervention-required', {
        forceManualIntervention: true,
      });
    }
    return {
      kind: 'anchor',
      anchorId: context.anchorId,
      role,
      sha256: identity.sha256,
      loaded: role === 'manifest' ? false : context.anchor.loaded[role],
    };
  }

  function makeReverseStep(context, snapshot, action, index) {
    const role = action.slice(action.indexOf('-') + 1);
    const currentIdentity = context.identities[role];
    const priorIdentity = snapshot.identities[role];
    if (action.startsWith('stop-')) {
      if (currentIdentity === null) invalid();
      return {
        index,
        action,
        role,
        expectedPre: reverseExpected(currentIdentity, true),
        expectedPost: reverseExpected(currentIdentity, false),
        evidence: candidateEvidence(context, role, currentIdentity),
      };
    }
    if (action.startsWith('remove-')) {
      if (currentIdentity === null) invalid();
      return {
        index,
        action,
        role,
        expectedPre: reverseExpected(currentIdentity, false),
        expectedPost: reverseExpected(null, false),
        evidence: candidateEvidence(context, role, currentIdentity),
      };
    }
    if (action.startsWith('restore-')) {
      if (priorIdentity === null) invalid();
      return {
        index,
        action,
        role,
        expectedPre: reverseExpected(currentIdentity, false),
        expectedPost: reverseExpected(priorIdentity, false),
        evidence: anchorEvidence(context, snapshot, role),
      };
    }
    if (action.startsWith('load-')) {
      if (priorIdentity === null) invalid();
      return {
        index,
        action,
        role,
        expectedPre: reverseExpected(priorIdentity, false),
        expectedPost: reverseExpected(priorIdentity, true),
        evidence: anchorEvidence(context, snapshot, role),
      };
    }
    invalid();
  }

  function buildReversePlan(context, snapshot, mode) {
    const actions = [];
    if (context.loadedNew.scheduler) actions.push('stop-scheduler');
    if (context.loadedNew.controller) actions.push('stop-controller');
    if (mode === 'install') {
      for (const role of ['manifest', 'scheduler', 'controller']) {
        if (context.published.has(role)) actions.push(`remove-${role}`);
      }
    } else {
      for (const role of ['manifest', 'scheduler', 'controller']) {
        if (context.published.has(role)) actions.push(`restore-${role}`);
      }
      if (context.anchor.loaded.controller && context.stopped.has('controller')) {
        actions.push('load-controller');
      }
      if (context.anchor.loaded.scheduler && context.stopped.has('scheduler')) {
        actions.push('load-scheduler');
      }
    }
    return actions.map((action, index) => makeReverseStep(
      context,
      snapshot,
      action,
      index,
    ));
  }

  async function verifyRecoveryTarget(context, snapshot) {
    await revalidateRuntime('compensate-before-close');
    const persistedAnchor = validateLaunchAgentAnchor(
      await deps.metadataStore.readAnchor(context.anchorId),
    );
    if (!sameValue(persistedAnchor, context.anchor)) {
      throw new FlowFailure('manual-intervention-required', {
        forceManualIntervention: true,
      });
    }

    const current = { controller: null, scheduler: null, manifest: null };
    const currentBytes = { controller: null, scheduler: null, manifest: null };
    for (const role of ['controller', 'scheduler', 'manifest']) {
      const inspected = await deps.hostInspector.inspect(addressFor(role));
      if (!snapshot.present[role]) {
        projectAbsentIdentity(inspected, role, context.facts.uid);
        if (context.identities[role] !== null) invalid();
        continue;
      }
      current[role] = projectFullIdentity(inspected, role, context.facts.uid);
      currentBytes[role] = Buffer.from(await deps.hostInspector.read(current[role]));
      if (
        current[role].sha256 !== snapshot.identities[role].sha256
        || Buffer.compare(currentBytes[role], snapshot.bytes[role]) !== 0
        || !sameValue(current[role], context.identities[role])
      ) {
        throw new FlowFailure('manual-intervention-required', {
          forceManualIntervention: true,
        });
      }
    }

    if (snapshot.present.manifest) {
      const manifest = validateLaunchAgentManifest(
        JSON.parse(currentBytes.manifest.toString('utf8')),
      );
      if (
        current.controller === null
        || current.scheduler === null
        || manifest.controller.plistSha256 !== current.controller.sha256
        || manifest.scheduler.plistSha256 !== current.scheduler.sha256
      ) {
        throw new FlowFailure('manual-intervention-required', {
          forceManualIntervention: true,
        });
      }
      const activeAnchor = await validateActiveAnchor(manifest);
      if (activeAnchor === null) {
        throw new FlowFailure('manual-intervention-required', {
          forceManualIntervention: true,
        });
      }
    }

    for (const role of ['controller', 'scheduler']) {
      const observed = await probeJob(snapshot.facts, role);
      const expectedLoaded = snapshot.jobs[role].loaded;
      if (
        observed.outcome !== 'ok'
        || observed.loaded !== expectedLoaded
        || (
          expectedLoaded
            ? observed.jobIdentitySha256 !== current[role]?.sha256
            : observed.jobIdentitySha256 !== null
        )
      ) {
        throw new FlowFailure('manual-intervention-required', {
          forceManualIntervention: true,
        });
      }
    }
    if (snapshot.jobs.controller.loaded) {
      const health = await deps.healthChecker.check({
        port: controllerPortFromPlistBytes(snapshot.bytes.controller),
      });
      if (health?.statusCode !== 200 || health?.ready !== true) {
        throw new FlowFailure('manual-intervention-required', {
          forceManualIntervention: true,
        });
      }
    }
  }

  function expectedCompensationUnion(context, snapshot, reversePlan, planIndex, role) {
    const currentStep = reversePlan[planIndex];
    if (currentStep?.role === role) {
      if (currentStep.action.startsWith('load-')) {
        return {
          file: reverseFileState(context.identities[role]),
          job: currentStep.expectedPre.job,
        };
      }
      return currentStep.expectedPre;
    }
    const loaded = role === 'manifest'
      ? false
      : (
        context.loadedNew[role]
        || (!context.stopped.has(role) && snapshot.jobs[role].loaded)
      );
    return reverseExpected(context.identities[role], loaded);
  }

  async function verifyCompensationEvidence(context, reversePlan) {
    for (const step of reversePlan) {
      const { evidence, role } = step;
      if (evidence.kind === 'candidate') {
        const bytes = await deps.metadataStore.readCandidate({ ...evidence });
        if (!Buffer.isBuffer(bytes) || sha256Hex(bytes) !== evidence.sha256) {
          throw new FlowFailure('manual-intervention-required', {
            forceManualIntervention: true,
          });
        }
        continue;
      }
      const anchorEntry = context.anchor?.[role];
      if (
        evidence.anchorId !== context.anchorId
        || anchorEntry?.priorState !== 'bytes'
        || anchorEntry.sha256 !== evidence.sha256
        || (role !== 'manifest' && context.anchor.loaded[role] !== evidence.loaded)
        || (role === 'manifest' && evidence.loaded !== false)
      ) {
        throw new FlowFailure('manual-intervention-required', {
          forceManualIntervention: true,
        });
      }
    }
  }

  async function verifyCompensationPrecondition(
    context,
    snapshot,
    facts,
    reversePlan,
    planIndex,
  ) {
    await revalidateRuntime('compensate-before-close');
    const persistedAnchor = validateLaunchAgentAnchor(
      await deps.metadataStore.readAnchor(context.anchorId),
    );
    if (!sameValue(persistedAnchor, context.anchor)) {
      throw new FlowFailure('manual-intervention-required', {
        forceManualIntervention: true,
      });
    }
    await verifyCompensationEvidence(context, reversePlan);

    for (const role of ['controller', 'scheduler', 'manifest']) {
      const expected = expectedCompensationUnion(
        context,
        snapshot,
        reversePlan,
        planIndex,
        role,
      );
      const inspected = await deps.hostInspector.inspect(addressFor(role));
      if (expected.file.state === 'absent') {
        projectAbsentIdentity(inspected, role, facts.uid);
      } else {
        const identity = projectFullIdentity(inspected, role, facts.uid);
        const bytes = await deps.hostInspector.read(identity);
        if (
          !sameValue(identity, expected.file.identity)
          || identity.sha256 !== expected.file.sha256
          || !Buffer.isBuffer(bytes)
          || sha256Hex(bytes) !== expected.file.sha256
        ) {
          throw new FlowFailure('manual-intervention-required', {
            forceManualIntervention: true,
          });
        }
      }
      if (role === 'manifest') continue;
      const observed = await probeJob(facts, role);
      const expectedLoaded = expected.job.state === 'loaded';
      if (
        observed.outcome !== 'ok'
        || observed.loaded !== expectedLoaded
        || observed.jobIdentitySha256 !== expected.job.identitySha256
      ) {
        throw new FlowFailure('manual-intervention-required', {
          forceManualIntervention: true,
        });
      }
    }
  }

  async function executeCompensationMutation(context, snapshot, facts, step, input) {
    const { action } = step;
    let result;
    if (action === 'stop-controller' || action === 'stop-scheduler') {
      const role = action.slice('stop-'.length);
      result = await deps.launchctlRunner.run(launchctlRequest(facts, 'bootout', role));
      context.mutationCount += 1;
      if (result?.outcome !== 'ok') throw new FlowFailure('manual-intervention-required');
      const observed = await probeJob(facts, role);
      if (observed.outcome !== 'ok' || observed.loaded !== false) {
        throw new FlowFailure('manual-intervention-required');
      }
      context.loadedNew[role] = false;
      context.stopped.add(role);
    } else if (action.startsWith('remove-')) {
      const role = action.slice('remove-'.length);
      await removePublishedIdentity(context, role);
      context.identities[role] = null;
    } else if (action.startsWith('restore-')) {
      const role = action.slice('restore-'.length);
      const ref = await stageRestorationCandidate(context, snapshot, role);
      await publishRestorationCandidate(context, role, ref);
    } else if (action === 'load-controller') {
      await revalidateRuntime('compensate-before-bootstrap-controller');
      result = await deps.launchctlRunner.run(launchctlRequest(facts, 'bootstrap', 'controller'));
      context.mutationCount += 1;
      if (result?.outcome !== 'ok') throw new FlowFailure('manual-intervention-required');
      const observed = await probeJob(facts, 'controller');
      if (
        observed.outcome !== 'ok'
        || observed.loaded !== true
        || observed.jobIdentitySha256 !== context.identities.controller.sha256
      ) {
        throw new FlowFailure('manual-intervention-required');
      }
      const health = await deps.healthChecker.check({ port: controllerPort(input) });
      if (health?.statusCode !== 200 || health?.ready !== true) {
        throw new FlowFailure('manual-intervention-required');
      }
      context.loadedNew.controller = true;
      context.stopped.delete('controller');
    } else if (action === 'load-scheduler') {
      await revalidateRuntime('compensate-before-bootstrap-scheduler');
      result = await deps.launchctlRunner.run(launchctlRequest(facts, 'bootstrap', 'scheduler'));
      context.mutationCount += 1;
      if (result?.outcome !== 'ok') throw new FlowFailure('manual-intervention-required');
      const observed = await probeJob(facts, 'scheduler');
      if (
        observed.outcome !== 'ok'
        || observed.loaded !== true
        || observed.jobIdentitySha256 !== context.identities.scheduler.sha256
      ) {
        throw new FlowFailure('manual-intervention-required');
      }
      context.loadedNew.scheduler = true;
      context.stopped.delete('scheduler');
    } else {
      invalid();
    }
  }

  async function compensationAction(
    context,
    snapshot,
    facts,
    step,
    reversePlanSha256,
    reversePlan,
    input,
  ) {
    const { action } = step;
    await appendJournal(context, `compensate-${action}-intent`, {
      action,
      planIndex: step.index,
      reversePlanSha256,
    });
    await verifyCompensationPrecondition(
      context,
      snapshot,
      facts,
      reversePlan,
      step.index,
    );
    await executeCompensationMutation(context, snapshot, facts, step, input);
    await appendJournal(context, `compensate-${action}-completed`, { action });
  }

  async function compensate(context, snapshot, outcome, mode) {
    try {
      const reversePlan = buildReversePlan(context, snapshot, mode);
      const reversePlanSha256 = sha256Hex(Buffer.from(JSON.stringify(reversePlan), 'utf8'));
      const recoveryInput = {
        controllerEnvironment: snapshot.present.controller
          ? { PORT: String(controllerPortFromPlistBytes(snapshot.bytes.controller)) }
          : {},
      };
      const compensating = await appendJournal(context, 'compensating', {
        reversePlan,
        reversePlanSha256,
      });
      for (const step of compensating.payload.reversePlan) {
        await compensationAction(
          context,
          snapshot,
          snapshot.facts,
          step,
          compensating.payload.reversePlanSha256,
          compensating.payload.reversePlan,
          recoveryInput,
        );
      }
      await verifyRecoveryTarget(context, snapshot);
    } catch {
      return enterManualIntervention(
        context,
        receiptRoles(
          { outcome: 'unchanged', changed: false },
          { outcome: 'unchanged', changed: false },
        ),
      );
    }
    return closeWithReceipt(context, {
      state: 'recovered', outcome, success: false,
      roles: receiptRoles(
        { outcome: mode === 'install' ? 'removed' : 'restored', changed: true },
        { outcome: mode === 'install' ? 'removed' : 'restored', changed: true },
      ),
    });
  }

  function desiredMatchesManifest(rendered, manifest, sourceCommit) {
    return manifest.sourceCommit === sourceCommit
      && sameValue(manifest.runtimeArtifacts, rendered.manifestRuntimeArtifacts)
      && manifest.controller.plistSha256 === rendered.controller.plistSha256
      && manifest.scheduler.plistSha256 === rendered.scheduler.plistSha256;
  }

  async function completeUpgrade(context, input, snapshot, manifest) {
    const controllerChanged = snapshot.identities.controller.sha256
      !== context.rendered.controller.plistSha256;
    const schedulerChanged = snapshot.identities.scheduler.sha256
      !== context.rendered.scheduler.plistSha256;
    const runtimeChanged = !sameValue(
      manifest.runtimeArtifacts,
      context.rendered.manifestRuntimeArtifacts,
    );
    const sourceCommitChanged = manifest.sourceCommit !== context.sourceCommit;
    const anySemanticChange = !desiredMatchesManifest(
      context.rendered,
      manifest,
      context.sourceCommit,
    );
    if (!anySemanticChange) {
      context.anchorId = manifest.activeAnchorId;
      return closeWithReceipt(context, {
        state: 'no-change', outcome: 'no-change', success: true,
        roles: receiptRoles(
          { outcome: 'unchanged', changed: false },
          { outcome: 'unchanged', changed: false },
        ),
      });
    }

    context.anchorId = requireUuid(deps.clock.newId());
    const nextManifest = makeManifest(context, context.rendered, context.anchorId, manifest);
    const nextManifestBytes = Buffer.from(JSON.stringify(nextManifest), 'utf8');
    await writeAnchor(
      context,
      snapshot,
      'managed-upgrade',
      context.sourceCommit,
      manifest.activeAnchorId,
      sha256Hex(nextManifestBytes),
    );
    const candidateBytes = {
      controller: Buffer.from(context.rendered.controller.plistBytes),
      scheduler: Buffer.from(context.rendered.scheduler.plistBytes),
      manifest: nextManifestBytes,
    };
    try {
      await stageCandidates(context, candidateBytes);
    } catch (error) {
      if (!(error instanceof FlowFailure)) throw error;
      return closeWithReceipt(context, {
        state: 'blocked', outcome: error.outcome, success: false,
        blockedByEntrySha256: null,
        roles: receiptRoles(
          { outcome: 'unchanged', changed: false },
          { outcome: 'unchanged', changed: false },
        ),
      });
    }

    const manifestOnly = sourceCommitChanged
      && !controllerChanged
      && !schedulerChanged
      && !runtimeChanged;
    try {
      if (manifestOnly) {
        await appendJournal(context, 'role-noop', { role: 'controller' });
        await appendJournal(context, 'role-noop', { role: 'scheduler' });
      } else {
        for (const role of ['scheduler', 'controller']) {
          if (snapshot.jobs[role].loaded) await bootout(context, snapshot.facts, role);
          else {
            const fresh = await probeJob(snapshot.facts, role);
            if (fresh.outcome !== 'ok' || fresh.loaded !== false) {
              throw new FlowFailure('ownership-mismatch');
            }
            await appendJournal(context, 'role-stop-noop', { role });
          }
        }
        if (controllerChanged) {
          await publishCandidate(context, 'controller', snapshot.identities.controller);
        } else {
          await appendJournal(context, 'role-noop', { role: 'controller' });
          context.identities.controller = snapshot.identities.controller;
        }
        if (schedulerChanged) {
          await publishCandidate(context, 'scheduler', snapshot.identities.scheduler);
        } else {
          await appendJournal(context, 'role-noop', { role: 'scheduler' });
          context.identities.scheduler = snapshot.identities.scheduler;
        }
      }

      await revalidateRuntime('before-manifest-publish');
      await publishCandidate(context, 'manifest', snapshot.identities.manifest);

      if (!manifestOnly) {
        await bootstrapController(
          context,
          snapshot.facts,
          input,
          context.identities.controller.sha256,
        );
        await bootstrapScheduler(context, snapshot.facts, context.identities.scheduler.sha256);
        await verifyLoadedPostState(context, snapshot.facts);
      }
      await revalidateRuntime('before-commit');
      await verifyCommittedFiles(context);
      return await closeWithReceipt(context, {
        state: 'committed', outcome: 'completed', success: true,
        roles: receiptRoles(
          {
            outcome: controllerChanged || runtimeChanged ? 'updated' : 'unchanged',
            changed: controllerChanged || runtimeChanged,
          },
          {
            outcome: schedulerChanged || runtimeChanged ? 'updated' : 'unchanged',
            changed: schedulerChanged || runtimeChanged,
          },
        ),
      });
    } catch (error) {
      if (!(error instanceof FlowFailure)) throw error;
      if (error.forceManualIntervention) {
        return enterManualIntervention(
          context,
          receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        );
      }
      if (context.mutationCount === 0) {
        return closeWithReceipt(context, {
          state: 'blocked', outcome: error.outcome, success: false,
          blockedByEntrySha256: null,
          roles: receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        });
      }
      return compensate(context, snapshot, error.outcome, 'upgrade');
    }
  }

  async function runInstallOrUpgrade(operation, input) {
    const normalized = validateOperationInput(input);
    const rendered = await deps.profileRenderer.render(normalized);
    const begun = await beginTransaction(operation, normalized.sourceCommit, rendered);
    if (begun.terminal !== null) return begun.terminal;
    const { context } = begun;
    const snapshot = await inspectCurrentState();
    context.facts = snapshot.facts;
    context.identities = { ...snapshot.identities };
    try {
      await revalidateRuntime('after-prepared-inspection');
    } catch (error) {
      if (!(error instanceof FlowFailure)) throw error;
      context.anchorId = requireUuid(deps.clock.newId());
      return closeWithReceipt(context, {
        state: 'blocked', outcome: error.outcome, success: false,
        blockedByEntrySha256: null,
        roles: receiptRoles(
          { outcome: 'unchanged', changed: false },
          { outcome: 'unchanged', changed: false },
        ),
      });
    }

    const allAbsent = !snapshot.present.controller
      && !snapshot.present.scheduler
      && !snapshot.present.manifest;
    if (allAbsent && operation === 'install') {
      if (
        snapshot.jobs.controller.outcome !== 'ok'
        || snapshot.jobs.scheduler.outcome !== 'ok'
        || snapshot.jobs.controller.loaded
        || snapshot.jobs.scheduler.loaded
      ) {
        context.anchorId = requireUuid(deps.clock.newId());
        return closeWithReceipt(context, {
          state: 'blocked', outcome: 'label-in-use', success: false,
          blockedByEntrySha256: null,
          roles: receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        });
      }
      return completeInstall(context, normalized, snapshot);
    }

    const manifest = parseManagedInstallation(snapshot);
    const activeAnchor = manifest === null ? null : await validateActiveAnchor(manifest);
    if (manifest === null || activeAnchor === null) {
      context.anchorId = requireUuid(deps.clock.newId());
      return closeWithReceipt(context, {
        state: 'blocked', outcome: 'ownership-mismatch', success: false,
        blockedByEntrySha256: null,
        roles: receiptRoles(
          { outcome: 'unchanged', changed: false },
          { outcome: 'unchanged', changed: false },
        ),
      });
    }
    return completeUpgrade(context, normalized, snapshot, manifest);
  }

  async function runStop(input) {
    const normalized = validateStopInput(input);
    const begun = await beginTransaction('stop', normalized.sourceCommit, null);
    if (begun.terminal !== null) return begun.terminal;
    const { context } = begun;
    const snapshot = await inspectCurrentState();
    context.facts = snapshot.facts;
    context.identities = { ...snapshot.identities };
    const manifest = parseManagedInstallation(snapshot, normalized.sourceCommit);
    const activeAnchor = manifest === null ? null : await validateActiveAnchor(manifest);
    if (manifest === null || activeAnchor === null) {
      context.anchorId = requireUuid(deps.clock.newId());
      return closeWithReceipt(context, {
        state: 'blocked', outcome: 'ownership-mismatch', success: false,
        blockedByEntrySha256: null,
        roles: receiptRoles(
          { outcome: 'unchanged', changed: false },
          { outcome: 'unchanged', changed: false },
        ),
      });
    }
    await writeAnchor(
      context,
      snapshot,
      'stop',
      normalized.sourceCommit,
      manifest.activeAnchorId,
    );

    for (const role of ['scheduler', 'controller']) {
      const fresh = await probeJob(snapshot.facts, role);
      const expectedLoaded = snapshot.jobs[role].loaded;
      const freshMatches = fresh.outcome === 'ok'
        && fresh.loaded === expectedLoaded
        && (
          !expectedLoaded
          || fresh.jobIdentitySha256 === context.identities[role].sha256
        );
      if (!freshMatches) {
        return closeWithReceipt(context, {
          state: 'blocked', outcome: 'ownership-mismatch', success: false,
          blockedByEntrySha256: null,
          roles: receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        });
      }
      if (!snapshot.jobs[role].loaded) {
        await appendJournal(context, 'role-stop-noop', { role });
        continue;
      }
      try {
        await bootout(context, snapshot.facts, role);
      } catch (error) {
        if (!(error instanceof FlowFailure)) throw error;
        if (context.stopped.size > 0) {
          return compensate(context, snapshot, 'stop-incomplete', 'upgrade');
        }
        try {
          await verifyRecoveryTarget(context, snapshot);
        } catch {
          return enterManualIntervention(
            context,
            receiptRoles(
              { outcome: 'unchanged', changed: false },
              { outcome: 'unchanged', changed: false },
            ),
          );
        }
        return closeWithReceipt(context, {
          state: 'recovered', outcome: 'stop-incomplete', success: false,
          roles: receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        });
      }
    }
    for (const role of ['controller', 'scheduler']) {
      const observed = await probeJob(snapshot.facts, role);
      if (
        observed.outcome !== 'ok'
        || observed.loaded !== false
        || observed.jobIdentitySha256 !== null
      ) {
        return enterManualIntervention(
          context,
          receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        );
      }
    }
    return closeWithReceipt(context, {
      state: 'committed', outcome: 'completed', success: true,
      roles: receiptRoles(
        {
          outcome: snapshot.jobs.controller.loaded ? 'unloaded' : 'unchanged',
          changed: snapshot.jobs.controller.loaded,
        },
        {
          outcome: snapshot.jobs.scheduler.loaded ? 'unloaded' : 'unchanged',
          changed: snapshot.jobs.scheduler.loaded,
        },
      ),
    });
  }

  async function runRollback(input) {
    const normalized = validateRollbackInput(input);
    const begun = await beginTransaction('rollback', normalized.sourceCommit, null);
    if (begun.terminal !== null) return begun.terminal;
    const { context } = begun;
    const snapshot = await inspectCurrentState();
    context.facts = snapshot.facts;
    context.identities = { ...snapshot.identities };
    const manifest = parseManagedInstallation(snapshot, normalized.sourceCommit);
    const target = manifest === null ? null : await validateActiveAnchor(manifest);
    const targetProjection = target === null
      ? null
      : validateRollbackTarget(
          target,
          snapshot,
          manifest,
          normalized.targetAnchorId,
        );
    if (manifest === null || target === null || targetProjection === null) {
      context.anchorId = requireUuid(deps.clock.newId());
      return closeWithReceipt(context, {
        state: 'blocked', outcome: 'ownership-mismatch', success: false,
        blockedByEntrySha256: null,
        roles: receiptRoles(
          { outcome: 'unchanged', changed: false },
          { outcome: 'unchanged', changed: false },
        ),
      });
    }
    const targetControllerPort = target.controller.priorState === 'bytes'
      ? controllerPortFromPlistBytes(anchorBytes(target, 'controller'))
      : null;
    try {
      await revalidateRuntime('after-prepared-inspection');
    } catch (error) {
      if (!(error instanceof FlowFailure)) throw error;
      context.anchorId = requireUuid(deps.clock.newId());
      return closeWithReceipt(context, {
        state: 'blocked', outcome: error.outcome, success: false,
        blockedByEntrySha256: null,
        roles: receiptRoles(
          { outcome: 'unchanged', changed: false },
          { outcome: 'unchanged', changed: false },
        ),
      });
    }

    await writeAnchor(
      context,
      snapshot,
      'rollback-compensation',
      normalized.sourceCommit,
      target.anchorId,
    );
    if (
      targetProjection.manifest !== null
      && !sameValue(targetProjection.manifest.runtimeArtifacts, manifest.runtimeArtifacts)
    ) {
      try {
        await verifyRecoveryTarget(context, snapshot);
      } catch {
        return enterManualIntervention(
          context,
          receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        );
      }
      return closeWithReceipt(context, {
        state: 'recovered', outcome: 'rollback-runtime-mismatch', success: false,
        roles: receiptRoles(
          { outcome: 'unchanged', changed: false },
          { outcome: 'unchanged', changed: false },
        ),
      });
    }

    try {
      await stageRollbackCandidates(context, target);
      const unloadResult = await unloadOwnedJobs(
        context,
        snapshot,
        'rollback-unload-incomplete',
      );
      if (unloadResult !== null) return unloadResult;
      await applyRollbackFiles(context, target);
      if (targetProjection.manifest !== null) {
        await revalidateRuntime('before-bootstrap-controller');
        await replayRollbackLoadedState(context, target, targetControllerPort);
      }
      await verifyRollbackTarget(
        context,
        target,
        targetProjection,
        targetControllerPort,
      );
      return await closeWithReceipt(context, {
        state: 'committed', outcome: 'completed', success: true,
        roles: receiptRoles(
          {
            outcome: target.controller.priorState === 'absent' ? 'removed' : 'restored',
            changed: true,
          },
          {
            outcome: target.scheduler.priorState === 'absent' ? 'removed' : 'restored',
            changed: true,
          },
        ),
      });
    } catch (error) {
      if (!(error instanceof FlowFailure)) throw error;
      if (context.mutationCount === 0) {
        return closeWithReceipt(context, {
          state: 'blocked', outcome: error.outcome, success: false,
          blockedByEntrySha256: null,
          roles: receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        });
      }
      return compensate(context, snapshot, error.outcome, 'upgrade');
    }
  }

  async function runUninstall(input) {
    const normalized = validateStopInput(input);
    const begun = await beginTransaction('uninstall', normalized.sourceCommit, null);
    if (begun.terminal !== null) return begun.terminal;
    const { context } = begun;
    const snapshot = await inspectCurrentState();
    context.facts = snapshot.facts;
    context.identities = { ...snapshot.identities };
    const manifest = parseManagedInstallation(snapshot, normalized.sourceCommit);
    const activeAnchor = manifest === null ? null : await validateActiveAnchor(manifest);
    if (manifest === null || activeAnchor === null) {
      context.anchorId = requireUuid(deps.clock.newId());
      return closeWithReceipt(context, {
        state: 'blocked', outcome: 'ownership-mismatch', success: false,
        blockedByEntrySha256: null,
        roles: receiptRoles(
          { outcome: 'unchanged', changed: false },
          { outcome: 'unchanged', changed: false },
        ),
      });
    }
    await writeAnchor(
      context,
      snapshot,
      'uninstall-compensation',
      normalized.sourceCommit,
      manifest.activeAnchorId,
    );

    try {
      const unloadResult = await unloadOwnedJobs(
        context,
        snapshot,
        'uninstall-unload-incomplete',
      );
      if (unloadResult !== null) return unloadResult;
      await removeManagedIdentity(context, 'scheduler');
      await removeManagedIdentity(context, 'controller');
      await removeManagedIdentity(context, 'manifest');
      await verifyUninstalled(context);
      return await closeWithReceipt(context, {
        state: 'committed', outcome: 'completed', success: true,
        roles: receiptRoles(
          { outcome: 'removed', changed: true },
          { outcome: 'removed', changed: true },
        ),
      });
    } catch (error) {
      if (!(error instanceof FlowFailure)) throw error;
      if (context.mutationCount === 0) {
        return closeWithReceipt(context, {
          state: 'blocked', outcome: error.outcome, success: false,
          blockedByEntrySha256: null,
          roles: receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        });
      }
      return compensate(context, snapshot, error.outcome, 'upgrade');
    }
  }

  // ------------------------------------------------------------------
  // Task 5A.3 普通 crash recovery：只依赖 durable journal/anchor/candidate/
  // receipt 与当前 host identity。普通恢复续写原 transaction（operation 不变，
  // 绝不写 operation=recover）；无 owner-death 证明时绝不释放/接管旧锁。
  // ------------------------------------------------------------------

  function validateRecoverInput(value) {
    const fields = readExactObject(value, ['transactionId']);
    return requireUuid(fields.transactionId);
  }

  function recoveryFault() {
    return new FlowFailure('manual-intervention-required', {
      forceManualIntervention: true,
    });
  }

  async function readRecoverHeads(transactionId) {
    const snapshot = await deps.metadataStore.readJournalHeads();
    const fields = readExactObject(snapshot, ['kind', 'journalSha256', 'heads']);
    if (fields.kind !== 'journal-heads') invalid();
    requireSha256(fields.journalSha256);
    if (!Array.isArray(fields.heads)) invalid();
    let priorTransactionId = null;
    let target = null;
    for (const rawHead of fields.heads) {
      const head = validateLaunchAgentJournal(rawHead);
      if (priorTransactionId !== null && priorTransactionId >= head.transactionId) invalid();
      priorTransactionId = head.transactionId;
      if (head.transactionId === transactionId) {
        target = head;
        continue;
      }
      if (!TERMINAL_STATES.has(head.state)) {
        return { snapshot, target, blocker: head };
      }
      try {
        const receipt = validateLaunchAgentReceipt(
          await deps.metadataStore.readReceipt(head.transactionId),
        );
        const receiptSha256 = sha256Hex(Buffer.from(JSON.stringify(receipt), 'utf8'));
        if (
          receipt.transactionId !== head.transactionId
          || receipt.operation !== head.operation
          || receipt.state !== head.state
          || receipt.hostMutationCount !== head.payload.hostMutationCount
          || receiptSha256 !== head.payload.receiptSha256
        ) {
          return { snapshot, target, blocker: head };
        }
      } catch {
        return { snapshot, target, blocker: head };
      }
    }
    return { snapshot, target, blocker: null };
  }

  async function readRecoveryChain(transactionId, expectedHead) {
    const rawEntries = await deps.metadataStore.readJournal({ transactionId });
    if (!Array.isArray(rawEntries) || rawEntries.length === 0) invalid();
    // 完整链先过共享 prefix state machine（schema/canonical hash/首条 prepared、
    // sequence/prev hash、同 transactionId/operation、mutation 单调、精确
    // forward/terminal/compensation transition 与 frozen reverse-plan 顺序），
    // 再核对 transactionId 与 expectedHead；全部发生在 acquire fresh lock
    // 或任何 mutation 之前。
    const { entries } = validateLaunchAgentTransactionPrefix({ entries: rawEntries });
    for (const entry of entries) {
      if (entry.transactionId !== transactionId) invalid();
    }
    if (!sameValue(entries[entries.length - 1], expectedHead)) invalid();
    return entries;
  }

  async function acquireRecoveryLock(transactionId) {
    const ownerNonce = requireUuid(deps.clock.newId());
    const lockRef = await deps.metadataStore.acquireTransactionLock(
      await createLockRecord(transactionId, ownerNonce),
    );
    const verified = await deps.metadataStore.verifyTransactionLock(lockRef);
    if (verified !== true) invalid();
    return lockRef;
  }

  // receipt 三态只读分类的闭合 shape：missing/invalid 单键，valid 双键且
  // receipt 必须过 strict schema。descriptor-first：不执行 status accessor、
  // 不通过 ordinary property get 读取 status；Proxy descriptor/prototype trap
  // 可能被执行，但其 raw error 与任何非闭合异常一律归一为 invalid。
  function readReceiptClassification(value) {
    try {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
      if (Object.getPrototypeOf(value) !== Object.prototype) invalid();
      const statusDescriptor = Object.getOwnPropertyDescriptor(value, 'status');
      if (
        statusDescriptor === undefined
        || statusDescriptor.enumerable !== true
        || !Object.hasOwn(statusDescriptor, 'value')
      ) {
        invalid();
      }
      const status = statusDescriptor.value;
      if (status === 'missing' || status === 'invalid') {
        readExactObject(value, ['status']);
        return { status };
      }
      if (status === 'valid') {
        const fields = readExactObject(value, ['status', 'receipt']);
        return { status: 'valid', receipt: validateLaunchAgentReceipt(fields.receipt) };
      }
      invalid();
    } catch (error) {
      if (error instanceof LaunchAgentLifecycleError) throw error;
      invalid();
    }
  }

  async function classifyExistingReceipt(transactionId) {
    let raw;
    try {
      // dependency boundary：hostile/thenable 返回值会让 await 本身的 `.then`
      // 探测抛出 raw error；任何非闭合异常一律归一为 invalid。
      raw = await deps.metadataStore.classifyReceipt(transactionId);
    } catch (error) {
      if (error instanceof LaunchAgentLifecycleError) throw error;
      invalid();
    }
    return readReceiptClassification(raw);
  }

  function receiptMatchesTerminal(head, receipt) {
    return receipt !== null
      && receipt.transactionId === head.transactionId
      && receipt.operation === head.operation
      && receipt.state === head.state
      && receipt.hostMutationCount === head.payload.hostMutationCount
      && sha256Hex(Buffer.from(JSON.stringify(receipt), 'utf8')) === head.payload.receiptSha256;
  }

  function manualInterventionClassification(head, source) {
    return validateLaunchAgentReceipt({
      schemaVersion: 1,
      operation: head.operation,
      state: 'manual-intervention-required',
      success: false,
      sourceCommit: source.sourceCommit,
      transactionId: head.transactionId,
      anchorId: source.anchorId,
      completedAt: deps.clock.now(),
      roles: source.roles,
      hostMutationCount: head.payload.hostMutationCount,
      outcome: 'manual-intervention-required',
    });
  }

  function lastRecoveryContext(entries) {
    let context = null;
    for (const entry of entries) {
      if (Object.hasOwn(entry.payload, 'recoveryContext')) context = entry.payload.recoveryContext;
    }
    return context;
  }

  function assertRecoveryContextHistory(entries) {
    let sourceCommit = null;
    let anchorRef = null;
    const candidateRefs = { controller: null, scheduler: null, manifest: null };
    for (const entry of entries) {
      if (!Object.hasOwn(entry.payload, 'recoveryContext')) continue;
      const context = entry.payload.recoveryContext;
      if (anchorRef === null) {
        sourceCommit = context.sourceCommit;
        anchorRef = context.anchorRef;
      } else if (context.sourceCommit !== sourceCommit || !sameValue(context.anchorRef, anchorRef)) {
        invalid();
      }
      for (const role of ['controller', 'scheduler', 'manifest']) {
        const ref = context.candidateRefs[role];
        if (candidateRefs[role] === null) {
          candidateRefs[role] = ref;
        } else if (ref === null || !sameValue(candidateRefs[role], ref)) {
          invalid();
        }
      }
    }
  }

  async function recoverTerminal(pre, head) {
    const transactionId = head.transactionId;
    const embedded = Object.hasOwn(head.payload, 'receipt') ? head.payload.receipt : null;
    // 三态只读分类先行：valid+exact match 幂等返回；valid conflict 与 invalid
    // 一律只读 MIR/fail closed，绝不 acquire lock、不写、不 heal、不 takeover。
    const classification = await classifyExistingReceipt(transactionId);
    if (classification.status === 'valid') {
      const existing = classification.receipt;
      if (receiptMatchesTerminal(head, existing)) return existing;
      // valid 但 conflicting persisted receipt：只读 MIR 分类，优先 embedded，
      // fallback existing；journal、conflicting receipt、host、旧 transaction
      // lock 全部保持，绝不 heal 或 takeover。
      const source = embedded ?? existing;
      return manualInterventionClassification(head, {
        sourceCommit: source.sourceCommit,
        anchorId: source.anchorId,
        roles: source.roles,
      });
    }
    if (classification.status === 'invalid') {
      if (embedded !== null) {
        // invalid persisted receipt + durable embedded：只读 MIR 分类，来源
        // embedded terminal；不 acquire lock、不写、不覆盖 corrupt receipt。
        return manualInterventionClassification(head, {
          sourceCommit: embedded.sourceCommit,
          anchorId: embedded.anchorId,
          roles: embedded.roles,
        });
      }
      // invalid + legacy hash-only terminal：sourceCommit/anchorId 不可重建，
      // 任何猜测都被禁止；只读 fail closed。
      coded(LAUNCHAGENT_LIFECYCLE_CODES.MANUAL_INTERVENTION_REQUIRED);
    }
    if (embedded === null) {
      // legacy hash-only terminal 缺 receipt：sourceCommit/anchorId 不可重建，
      // 任何猜测都被禁止；只读 fail closed，不写 journal/receipt/lock/host。
      coded(LAUNCHAGENT_LIFECYCLE_CODES.MANUAL_INTERVENTION_REQUIRED);
    }
    const lockRef = await acquireRecoveryLock(transactionId);
    let settled = false;
    try {
      const post = await readRecoverHeads(transactionId);
      if (
        post.blocker !== null
        || post.target === null
        || !sameValue(post.snapshot, pre.snapshot)
      ) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.MANUAL_INTERVENTION_REQUIRED);
      }
      try {
        await deps.metadataStore.publishReceipt({ receipt: embedded, lockRef });
      } catch (error) {
        if (!(error instanceof LaunchAgentLifecycleError)) throw error;
        // exact no-clobber race：publish 失败后只重新分类；只有 valid + exact
        // embedded match 才按幂等成功继续，其余一律 fail closed。
        const raced = await classifyExistingReceipt(transactionId);
        if (raced.status !== 'valid' || !receiptMatchesTerminal(head, raced.receipt)) {
          coded(LAUNCHAGENT_LIFECYCLE_CODES.MANUAL_INTERVENTION_REQUIRED);
        }
      }
      const entries = await deps.metadataStore.readJournal({ transactionId });
      const persisted = validateLaunchAgentReceipt(
        await deps.metadataStore.readReceipt(transactionId),
      );
      const closeout = validateLaunchAgentTransactionCloseout({ entries, receipt: persisted });
      if (!sameValue(closeout.receipt, embedded)) invalid();
      await deps.metadataStore.releaseTransactionLock(lockRef);
      settled = true;
      return closeout.receipt;
    } finally {
      if (!settled) {
        try {
          await deps.metadataStore.releaseTransactionLock(lockRef);
        } catch {
          // fail closed：释放不可达时保留 fresh lock，优于遗留未授权写窗口。
        }
      }
    }
  }

  function recoverMirHeadClassification(head, entries) {
    const context = lastRecoveryContext(entries);
    if (context === null) {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.MANUAL_INTERVENTION_REQUIRED);
    }
    return manualInterventionClassification(head, {
      sourceCommit: context.sourceCommit,
      anchorId: context.anchorRef.anchorId,
      roles: receiptRoles(
        { outcome: 'unchanged', changed: false },
        { outcome: 'unchanged', changed: false },
      ),
    });
  }

  function baseRecoveryContext(head, entries, durable, lockRef) {
    return {
      operation: head.operation,
      sourceCommit: durable.sourceCommit,
      rendered: null,
      transactionId: head.transactionId,
      lockRef,
      lastEntry: entries.at(-1),
      mutationCount: head.payload.hostMutationCount,
      anchorId: durable.anchorRef.anchorId,
      anchor: null,
      anchorRef: durable.anchorRef,
      facts: null,
      identities: { controller: null, scheduler: null, manifest: null },
      candidateRefs: {
        controller: durable.candidateRefs.controller,
        scheduler: durable.candidateRefs.scheduler,
        manifest: durable.candidateRefs.manifest,
      },
      restorationCandidateTransactionId: null,
      possiblePublisherMutations: new Set(),
      published: new Set(),
      stopped: new Set(),
      loadedNew: { controller: false, scheduler: false },
    };
  }

  async function enterLegacyManualIntervention(head, lockRef) {
    // legacy nonterminal 无 durable recovery context：不猜测、不扫描目录；取得
    // fresh lock 后只做 durable MIR handoff。无 sourceCommit/anchorId 可闭合
    // receipt，handoff 完成后以闭合 MIR 错误收口。
    const context = {
      operation: head.operation,
      sourceCommit: null,
      rendered: null,
      transactionId: head.transactionId,
      lockRef,
      lastEntry: head,
      mutationCount: head.payload.hostMutationCount,
      anchorId: null,
      anchor: null,
      anchorRef: null,
      facts: null,
      identities: { controller: null, scheduler: null, manifest: null },
      candidateRefs: { controller: null, scheduler: null, manifest: null },
      restorationCandidateTransactionId: null,
      possiblePublisherMutations: new Set(),
      published: new Set(),
      stopped: new Set(),
      loadedNew: { controller: false, scheduler: false },
    };
    await appendJournal(context, 'manual-intervention-required');
    const manualNonce = requireUuid(deps.clock.newId());
    const mirLockRef = await deps.metadataStore.acquireManualInterventionLock(
      await createLockRecord(context.transactionId, manualNonce),
    );
    const verified = await deps.metadataStore.verifyManualInterventionLock(mirLockRef);
    if (verified !== true) invalid();
    await deps.metadataStore.releaseTransactionLock(context.lockRef, {
      manualInterventionLockRef: mirLockRef,
    });
    coded(LAUNCHAGENT_LIFECYCLE_CODES.MANUAL_INTERVENTION_REQUIRED);
  }

  function snapshotFromAnchor(anchor, facts) {
    const present = {};
    const identities = {};
    const bytes = {};
    for (const role of ['controller', 'scheduler', 'manifest']) {
      present[role] = anchor[role].priorState === 'bytes';
      identities[role] = present[role] ? anchor[role].identity : null;
      bytes[role] = present[role] ? anchorBytes(anchor, role) : null;
    }
    if (
      (anchor.loaded.controller && !present.controller)
      || (anchor.loaded.scheduler && !present.scheduler)
    ) {
      throw recoveryFault();
    }
    return {
      present,
      identities,
      bytes,
      jobs: {
        controller: { loaded: anchor.loaded.controller },
        scheduler: { loaded: anchor.loaded.scheduler },
      },
      facts,
    };
  }

  async function hydrateRecoveryEvidence(context) {
    const anchor = validateLaunchAgentAnchor(
      await deps.metadataStore.readAnchor(context.anchorId),
    );
    if (
      anchor.anchorId !== context.anchorId
      || anchor.transactionId !== context.transactionId
      || anchor.sourceCommit !== context.sourceCommit
      || sha256Hex(Buffer.from(JSON.stringify(anchor), 'utf8')) !== context.anchorRef.sha256
    ) {
      throw recoveryFault();
    }
    context.anchor = anchor;
    for (const role of ['controller', 'scheduler', 'manifest']) {
      const ref = context.candidateRefs[role];
      if (ref === null) continue;
      const bytes = await deps.metadataStore.readCandidate(ref);
      if (!Buffer.isBuffer(bytes) || sha256Hex(bytes) !== ref.sha256) {
        throw recoveryFault();
      }
    }
  }

  function intentWindow(state) {
    for (const role of ['controller', 'scheduler', 'manifest']) {
      for (const verb of ['publish', 'load', 'stop', 'remove']) {
        if (state === `${role}-${verb}-intent`) return { role, verb };
      }
    }
    return null;
  }

  function durableRemoveEvidence(entries, role) {
    return entries.some((entry) => (
      entry.state === `${role}-remove-intent` || entry.state === `${role}-removed`
    ));
  }

  function analyzeLiveWindow(context, entries, snapshot, live) {
    const deviations = {};
    for (const role of ['controller', 'scheduler', 'manifest']) {
      if (
        live.present[role]
        && sha256Hex(live.bytes[role]) !== live.identities[role].sha256
      ) {
        throw recoveryFault();
      }
      if (!snapshot.present[role] && !live.present[role]) {
        deviations[role] = 'same';
      } else if (
        snapshot.present[role]
        && live.present[role]
        && sameValue(live.identities[role], snapshot.identities[role])
      ) {
        deviations[role] = 'same';
      } else if (!snapshot.present[role] && live.present[role]) {
        deviations[role] = 'extra';
      } else if (snapshot.present[role] && !live.present[role]) {
        deviations[role] = 'missing';
      } else {
        deviations[role] = 'different';
      }
    }
    for (const role of ['controller', 'scheduler', 'manifest']) {
      const deviation = deviations[role];
      if (deviation === 'same') continue;
      if (deviation === 'extra' || deviation === 'different') {
        // 只有本 tx durable candidate 能解释 live 文件；drift/foreign 一律 fail closed。
        const ref = context.candidateRefs[role];
        if (ref === null || ref.sha256 !== live.identities[role].sha256) {
          throw recoveryFault();
        }
        continue;
      }
      // missing 只能由本 tx 已验证 chain 中该 exact role 的 durable remove 证据
      // 解释（remove-intent 已落账即证明 remove 窗口已到达该 role）；仅凭
      // operation 是 uninstall/rollback 不再足够，事务外删除一律 fail closed。
      if (!durableRemoveEvidence(entries, role)) {
        throw recoveryFault();
      }
    }
    const loadedNow = new Set();
    const stoppedNow = new Set();
    for (const role of ['controller', 'scheduler']) {
      const job = live.jobs[role];
      if (job.outcome !== 'ok') throw recoveryFault();
      if (job.loaded) {
        if (!live.present[role] || job.jobIdentitySha256 !== live.identities[role].sha256) {
          throw recoveryFault();
        }
        if (!snapshot.jobs[role].loaded) loadedNow.add(role);
      } else {
        if (job.jobIdentitySha256 !== null) throw recoveryFault();
        if (snapshot.jobs[role].loaded) stoppedNow.add(role);
      }
    }
    context.identities = { ...live.identities };
    for (const role of ['controller', 'scheduler']) {
      context.loadedNew[role] = loadedNow.has(role);
      if (stoppedNow.has(role)) context.stopped.add(role);
    }
    for (const role of ['controller', 'scheduler', 'manifest']) {
      if (deviations[role] !== 'same') context.published.add(role);
    }
    return { deviations, loadedNow, stoppedNow };
  }

  async function proveInstallPostState(context, live) {
    // 唯一 committed 例外：install 的完整 post-state 必须由 durable candidate、
    // manifest、job identity、health 与 runtime revalidation 全部独立证明。
    try {
      const manifest = validateLaunchAgentManifest(
        JSON.parse(live.bytes.manifest.toString('utf8')),
      );
      if (
        manifest.transactionId !== context.transactionId
        || manifest.sourceCommit !== context.sourceCommit
        || manifest.activeAnchorId !== context.anchorId
        || manifest.controller.plistSha256 !== live.identities.controller.sha256
        || manifest.scheduler.plistSha256 !== live.identities.scheduler.sha256
        || live.identities.manifest.sha256 !== context.candidateRefs.manifest.sha256
      ) {
        return false;
      }
      const health = await deps.healthChecker.check({
        port: controllerPortFromPlistBytes(live.bytes.controller),
      });
      if (health?.statusCode !== 200 || health?.ready !== true) return false;
      await revalidateRuntime('before-commit');
      return true;
    } catch {
      return false;
    }
  }

  function closeRecovered(context, roles) {
    return closeWithReceipt(context, {
      state: 'recovered',
      outcome: 'recovered',
      success: false,
      roles,
    });
  }

  async function recoverBusinessWindow(context, entries, head, snapshot, live) {
    const { deviations, loadedNow, stoppedNow } = analyzeLiveWindow(context, entries, snapshot, live);
    const window = intentWindow(head.state);
    if (window !== null) {
      const done = (
        (window.verb === 'publish'
          && (deviations[window.role] === 'extra' || deviations[window.role] === 'different'))
        || (window.verb === 'remove' && deviations[window.role] === 'missing')
        || (window.verb === 'stop' && stoppedNow.has(window.role))
        || (window.verb === 'load' && loadedNow.has(window.role))
      );
      if (done) {
        // intent 已落账、mutation 已发生但未落账：如实补记一次，绝不二次执行。
        context.mutationCount += 1;
      }
    }

    if (
      context.operation === 'install'
      && head.state === 'scheduler-load-intent'
      && deviations.controller === 'extra'
      && deviations.scheduler === 'extra'
      && deviations.manifest === 'extra'
      && loadedNow.has('controller')
      && loadedNow.has('scheduler')
      && await proveInstallPostState(context, live)
    ) {
      await appendJournal(context, 'scheduler-loaded');
      return closeWithReceipt(context, {
        state: 'committed',
        outcome: 'completed',
        success: true,
        roles: receiptRoles(
          { outcome: 'created', changed: true },
          { outcome: 'created', changed: true },
        ),
      });
    }

    const mode = context.operation === 'install' ? 'install' : 'upgrade';
    if (mode === 'upgrade') {
      for (const role of ['controller', 'scheduler', 'manifest']) {
        if (deviations[role] === 'extra') throw recoveryFault();
      }
    }
    const reversePlan = buildReversePlan(context, snapshot, mode);
    if (reversePlan.length === 0) {
      if (context.mutationCount !== 0) throw recoveryFault();
      await verifyRecoveryTarget(context, snapshot);
      return closeRecovered(context, receiptRoles(
        { outcome: 'unchanged', changed: false },
        { outcome: 'unchanged', changed: false },
      ));
    }
    const reversePlanSha256 = sha256Hex(Buffer.from(JSON.stringify(reversePlan), 'utf8'));
    const recoveryInput = {
      controllerEnvironment: snapshot.present.controller
        ? { PORT: String(controllerPortFromPlistBytes(snapshot.bytes.controller)) }
        : {},
    };
    const compensating = await appendJournal(context, 'compensating', {
      reversePlan,
      reversePlanSha256,
    });
    for (const step of compensating.payload.reversePlan) {
      await compensationAction(
        context,
        snapshot,
        live.facts,
        step,
        compensating.payload.reversePlanSha256,
        compensating.payload.reversePlan,
        recoveryInput,
      );
    }
    await verifyRecoveryTarget(context, snapshot);
    return closeRecovered(context, receiptRoles(
      { outcome: mode === 'install' ? 'removed' : 'restored', changed: true },
      { outcome: mode === 'install' ? 'removed' : 'restored', changed: true },
    ));
  }

  function restoredBefore(reversePlan, role, position) {
    return reversePlan.some((step) => (
      step.role === role && step.action.startsWith('restore-') && step.index < position
    ));
  }

  function matchExpectedLive(live, role, expected, inodeExact) {
    if (expected.file.state === 'absent') {
      if (live.present[role]) return false;
    } else {
      if (!live.present[role]) return false;
      const identity = live.identities[role];
      if (
        identity.device !== expected.file.identity.device
        || identity.sha256 !== expected.file.sha256
        || sha256Hex(live.bytes[role]) !== expected.file.sha256
        || (inodeExact && identity.inode !== expected.file.identity.inode)
      ) {
        return false;
      }
    }
    if (role === 'manifest') return true;
    const job = live.jobs[role];
    if (job.outcome !== 'ok') throw recoveryFault();
    return job.loaded === (expected.job.state === 'loaded')
      && job.jobIdentitySha256 === expected.job.identitySha256;
  }

  function resumeBoundary(reversePlan, fromIndex, snapshot, role) {
    let post = null;
    for (const step of reversePlan) {
      if (step.role !== role) continue;
      if (step.index < fromIndex) {
        post = step;
      } else {
        const expected = step.expectedPre;
        return {
          expected,
          inodeExact: !restoredBefore(reversePlan, role, step.index),
        };
      }
    }
    if (post !== null) {
      return {
        expected: post.expectedPost,
        inodeExact: !restoredBefore(reversePlan, role, post.index + 1),
      };
    }
    const loaded = role === 'manifest' ? false : snapshot.jobs[role].loaded;
    return {
      expected: reverseExpected(snapshot.identities[role], loaded),
      inodeExact: true,
    };
  }

  async function resumeFrozenCompensation(context, entries, head, frozen, snapshot, live) {
    const reversePlan = frozen.payload.reversePlan;
    const frozenHash = frozen.payload.reversePlanSha256;
    // 冻结链形状校验：frozen 之后只能按 plan 顺序成对出现 intent/completed。
    let nextIndex = 0;
    let awaitingCompletion = false;
    for (const entry of entries.slice(entries.indexOf(frozen) + 1)) {
      if (!entry.state.startsWith('compensate-')) throw recoveryFault();
      const completed = entry.state.endsWith('-completed');
      if (!completed && !entry.state.endsWith('-intent')) throw recoveryFault();
      const step = reversePlan[nextIndex];
      if (step === undefined || entry.state !== `compensate-${step.action}-${completed ? 'completed' : 'intent'}`) {
        throw recoveryFault();
      }
      if (entry.payload.action !== step.action) throw recoveryFault();
      if (completed) {
        if (!awaitingCompletion) throw recoveryFault();
        awaitingCompletion = false;
        nextIndex += 1;
      } else {
        if (awaitingCompletion) throw recoveryFault();
        if (
          entry.payload.planIndex !== step.index
          || entry.payload.reversePlanSha256 !== frozenHash
        ) {
          throw recoveryFault();
        }
        awaitingCompletion = true;
      }
    }

    await verifyCompensationEvidence(context, reversePlan);
    const currentStep = awaitingCompletion ? reversePlan[nextIndex] : null;
    // 任何 host mutation 前先验证全部 evidence 与非 current role 的 union boundary。
    for (const role of ['controller', 'scheduler', 'manifest']) {
      if (currentStep !== null && currentStep.role === role) continue;
      const boundary = resumeBoundary(reversePlan, nextIndex, snapshot, role);
      if (!matchExpectedLive(live, role, boundary.expected, boundary.inodeExact)) {
        throw recoveryFault();
      }
    }
    const recoveryInput = {
      controllerEnvironment: snapshot.present.controller
        ? { PORT: String(controllerPortFromPlistBytes(snapshot.bytes.controller)) }
        : {},
    };
    let startIndex = nextIndex;
    if (currentStep !== null) {
      const matchesPre = matchExpectedLive(
        live,
        currentStep.role,
        currentStep.expectedPre,
        !restoredBefore(reversePlan, currentStep.role, currentStep.index),
      );
      const matchesPost = !matchesPre && matchExpectedLive(
        live,
        currentStep.role,
        currentStep.expectedPost,
        !restoredBefore(reversePlan, currentStep.role, currentStep.index + 1),
      );
      if (matchesPre) {
        // current intent live=expectedPre：同一 frozen step 恰好执行一次，只补 completed。
        await executeCompensationMutation(context, snapshot, live.facts, currentStep, recoveryInput);
      } else if (matchesPost) {
        // live=expectedPost：mutation 已发生未落账，补记一次且绝不二次执行。
        context.mutationCount += 1;
      } else {
        throw recoveryFault();
      }
      await appendJournal(context, `compensate-${currentStep.action}-completed`, {
        action: currentStep.action,
      });
      startIndex = nextIndex + 1;
    }
    for (let index = startIndex; index < reversePlan.length; index += 1) {
      await compensationAction(
        context,
        snapshot,
        live.facts,
        reversePlan[index],
        frozenHash,
        reversePlan,
        recoveryInput,
      );
    }
    await verifyRecoveryTarget(context, snapshot);
    return closeRecovered(context, receiptRoles(
      {
        outcome: context.operation === 'install' ? 'removed' : 'restored',
        changed: true,
      },
      {
        outcome: context.operation === 'install' ? 'removed' : 'restored',
        changed: true,
      },
    ));
  }

  async function recoverBusiness(context, entries, head) {
    await hydrateRecoveryEvidence(context);
    const live = await inspectCurrentState();
    context.facts = live.facts;
    const snapshot = snapshotFromAnchor(context.anchor, live.facts);
    const frozen = entries.find((entry) => entry.state === 'compensating');
    if (frozen !== undefined) {
      // compensation resume：identities/loaded/stopped 先按 live 水合（loadedNew/
      // stopped 与 expectedCompensationUnion 的生产簿记语义一致：loadedNew 表示
      // 当前仍 loaded，stopped 表示当前已 unloaded），再由 boundary 逐 role 核验；
      // 只续同一 frozen plan/hash。
      context.identities = { ...live.identities };
      for (const role of ['controller', 'scheduler']) {
        const job = live.jobs[role];
        if (job.outcome !== 'ok') throw recoveryFault();
        if (job.loaded) {
          if (!live.present[role] || job.jobIdentitySha256 !== live.identities[role].sha256) {
            throw recoveryFault();
          }
          context.loadedNew[role] = true;
        } else {
          if (job.jobIdentitySha256 !== null) throw recoveryFault();
          context.loadedNew[role] = false;
          context.stopped.add(role);
        }
      }
      return resumeFrozenCompensation(context, entries, head, frozen, snapshot, live);
    }
    if (head.state.startsWith('compensate-')) throw recoveryFault();
    return recoverBusinessWindow(context, entries, head, snapshot, live);
  }

  async function recoverNonterminal(pre, head, entries) {
    const transactionId = head.transactionId;
    const lockRef = await acquireRecoveryLock(transactionId);
    const durable = lastRecoveryContext(entries);
    if (durable === null) {
      // legacy nonterminal 缺 context：不猜测、不扫描目录，fresh lock 后 durable MIR。
      return enterLegacyManualIntervention(head, lockRef);
    }
    const context = baseRecoveryContext(head, entries, durable, lockRef);
    try {
      const post = await readRecoverHeads(transactionId);
      if (
        post.blocker !== null
        || post.target === null
        || !sameValue(post.snapshot, pre.snapshot)
      ) {
        throw recoveryFault();
      }
      assertRecoveryContextHistory(entries);
      return await recoverBusiness(context, entries, head);
    } catch {
      // fresh recovery lock 已取得后的一切 fault 一律 durable MIR handoff。
      return enterManualIntervention(context, receiptRoles(
        { outcome: 'unchanged', changed: false },
        { outcome: 'unchanged', changed: false },
      ));
    }
  }

  async function runRecover(input) {
    const transactionId = validateRecoverInput(input);
    const pre = await readRecoverHeads(transactionId);
    if (pre.blocker !== null || pre.target === null) {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }
    const head = pre.target;
    const entries = await readRecoveryChain(transactionId, head);
    if (head.state === 'manual-intervention-required') {
      return recoverMirHeadClassification(head, entries);
    }
    if (TERMINAL_STATES.has(head.state)) {
      return recoverTerminal(pre, head);
    }
    return recoverNonterminal(pre, head, entries);
  }

  /**
   * 读取并校验授权 MIR 事务的完整 journal 链；最新 head 必须 exact MIR。
   * 同时保留可精确比较的完整 global heads snapshot（kind + journalSha256 + projected heads）：
   * 任意 global head 增删改或 journalSha256 漂移均与 pre-lock 不等。
   */
  async function readAuthorizedMirJournal(mirTransactionId) {
    const headsSnapshot = await deps.metadataStore.readJournalHeads();
    const headFields = readExactObject(headsSnapshot, ['kind', 'journalSha256', 'heads']);
    if (headFields.kind !== 'journal-heads') invalid();
    requireSha256(headFields.journalSha256);
    if (!Array.isArray(headFields.heads)) invalid();

    const projectedHeads = [];
    let priorTransactionId = null;
    let authorizedHead = null;
    for (const rawHead of headFields.heads) {
      const head = validateLaunchAgentJournal(rawHead);
      // transactionId 严格递增、无重复（与 install/recover heads 路径一致）。
      if (priorTransactionId !== null && priorTransactionId >= head.transactionId) invalid();
      priorTransactionId = head.transactionId;
      projectedHeads.push(head);
      if (head.transactionId === mirTransactionId) {
        authorizedHead = head;
      }
    }
    if (authorizedHead === null) invalid();
    if (authorizedHead.state !== 'manual-intervention-required') invalid();
    if (authorizedHead.transactionId !== mirTransactionId) invalid();

    const rawEntries = await deps.metadataStore.readJournal({ transactionId: mirTransactionId });
    if (!Array.isArray(rawEntries) || rawEntries.length === 0) invalid();
    const entries = [];
    let previousEntrySha256 = null;
    for (let index = 0; index < rawEntries.length; index += 1) {
      const entry = validateLaunchAgentJournal(rawEntries[index]);
      if (entry.transactionId !== mirTransactionId) invalid();
      if (entry.sequence !== index) invalid();
      if (entry.previousEntrySha256 !== previousEntrySha256) invalid();
      if (entry.entrySha256 !== journalEntrySha256(entry)) invalid();
      entries.push(entry);
      previousEntrySha256 = entry.entrySha256;
    }
    const latest = entries[entries.length - 1];
    if (latest.state !== 'manual-intervention-required') invalid();
    if (!sameValue(latest, authorizedHead)) invalid();
    // 完整 global snapshot：供 pre/post-lock exact equality（含 journalSha256 与全部 heads）。
    const snapshot = {
      kind: 'journal-heads',
      journalSha256: headFields.journalSha256,
      heads: projectedHeads,
    };
    return {
      snapshot,
      journalSha256: headFields.journalSha256,
      head: authorizedHead,
      entries,
    };
  }

  /** pure closeout 允许的已存在终态（class A cleanup-only）。 */
  const PURE_CLOSEOUT_EXISTING_TERMINALS = new Set(['recovered', 'blocked']);

  /**
   * 只读匹配 live 与 expected；probe unknown → null（不抛、不突变）。
   * 复用单一 matchExpectedLive 逻辑，禁止第二状态机。
   */
  function tryMatchExpectedLive(live, role, expected, inodeExact) {
    try {
      return matchExpectedLive(live, role, expected, inodeExact) === true;
    } catch {
      return null;
    }
  }

  /**
   * pure closeout 分类：recovered | blocked | not-pure。
   * recovered：live 精确等于 anchor 恢复终态（合法 recovered checkpoint）。
   * blocked：每个 frozen step live 已 exact expectedPost，双方 job unloaded/null，
   *          且 controller/scheduler/manifest 全部匹配 final union boundary
   *          （resumeBoundary + matchExpectedLive + snapshotFromAnchor）。
   * not-pure：pending expectedPre / unknown probe / unmatched / union 外漂移。
   */
  function classifyPureCloseoutDisposition(reversePlan, live, anchor) {
    for (const role of ['controller', 'scheduler']) {
      if (live.jobs[role].outcome !== 'ok') return 'not-pure';
    }

    let snapshot;
    try {
      snapshot = snapshotFromAnchor(anchor, live.facts);
    } catch {
      return 'not-pure';
    }

    // 合法 recovered 终态：live 精确匹配 anchor 恢复目标。
    let recoveredMatch = true;
    for (const role of ['controller', 'scheduler', 'manifest']) {
      const expected = reverseExpected(
        snapshot.identities[role],
        role === 'manifest' ? false : snapshot.jobs[role].loaded,
      );
      const matched = tryMatchExpectedLive(live, role, expected, true);
      if (matched !== true) {
        recoveredMatch = false;
        break;
      }
    }
    if (recoveredMatch) return 'recovered';

    // 逐 frozen step：expectedPre / expectedPost（inodeExact 规则与 resume 路径一致）。
    let allPost = true;
    for (const step of reversePlan) {
      const preMatch = tryMatchExpectedLive(
        live,
        step.role,
        step.expectedPre,
        !restoredBefore(reversePlan, step.role, step.index),
      );
      const postMatch = tryMatchExpectedLive(
        live,
        step.role,
        step.expectedPost,
        !restoredBefore(reversePlan, step.role, step.index + 1),
      );
      if (preMatch === null || postMatch === null) return 'not-pure';
      if (postMatch !== true) allPost = false;
      if (preMatch !== true && postMatch !== true) return 'not-pure';
    }
    if (!allPost) return 'not-pure';

    // proven safe-disabled：plan all-post + both jobs unloaded/null +
    // full three-role final union boundary（含 plan 未覆盖的 manifest）。
    for (const role of ['controller', 'scheduler']) {
      const job = live.jobs[role];
      if (job.loaded !== false || job.jobIdentitySha256 !== null) return 'not-pure';
    }
    for (const role of ['controller', 'scheduler', 'manifest']) {
      const boundary = resumeBoundary(reversePlan, reversePlan.length, snapshot, role);
      const matched = tryMatchExpectedLive(
        live,
        role,
        boundary.expected,
        boundary.inodeExact,
      );
      if (matched !== true) return 'not-pure';
    }
    return 'blocked';
  }

  /**
   * recovered receipt roles 由 anchor priorState 派生：
   * absent => removed；bytes => restored。禁止硬编码 removed。
   */
  function recoveredReceiptRolesFromAnchor(anchor) {
    function outcomeFor(role) {
      const priorState = anchor[role]?.priorState;
      if (priorState === 'bytes') return { outcome: 'restored', changed: true };
      if (priorState === 'absent') return { outcome: 'removed', changed: true };
      invalid();
    }
    return receiptRoles(outcomeFor('controller'), outcomeFor('scheduler'));
  }

  /**
   * 读取完整 global journal heads snapshot（任意 head 状态）。
   * 供 pure-closeout phase guard / terminal revalidation 使用。
   */
  async function readGlobalJournalHeadsSnapshot() {
    const headsSnapshot = await deps.metadataStore.readJournalHeads();
    const headFields = readExactObject(headsSnapshot, ['kind', 'journalSha256', 'heads']);
    if (headFields.kind !== 'journal-heads') invalid();
    requireSha256(headFields.journalSha256);
    if (!Array.isArray(headFields.heads)) invalid();
    const projectedHeads = [];
    let priorTransactionId = null;
    for (const rawHead of headFields.heads) {
      const head = validateLaunchAgentJournal(rawHead);
      if (priorTransactionId !== null && priorTransactionId >= head.transactionId) invalid();
      priorTransactionId = head.transactionId;
      projectedHeads.push(head);
    }
    return {
      kind: 'journal-heads',
      journalSha256: headFields.journalSha256,
      heads: projectedHeads,
    };
  }

  /**
   * 读取并投影单事务完整 journal 链（状态不限，供 terminal/cleanup 使用）。
   */
  async function readProjectedTransactionEntries(transactionId) {
    const rawEntries = await deps.metadataStore.readJournal({ transactionId });
    if (!Array.isArray(rawEntries) || rawEntries.length === 0) invalid();
    const entries = [];
    let previousEntrySha256 = null;
    for (let index = 0; index < rawEntries.length; index += 1) {
      const entry = validateLaunchAgentJournal(rawEntries[index]);
      if (entry.transactionId !== transactionId) invalid();
      if (entry.sequence !== index) invalid();
      if (entry.previousEntrySha256 !== previousEntrySha256) invalid();
      if (entry.entrySha256 !== journalEntrySha256(entry)) invalid();
      entries.push(entry);
      previousEntrySha256 = entry.entrySha256;
    }
    return entries;
  }

  /**
   * 复用 exact phase guard：claim absent、当前 tx ref exact、MIR ref+record exact、
   * anchor exact、授权事务链 + 完整 global heads exact。
   * foreign 任意 head/journal 漂移 → class C：保留两锁并抛 RECOVERY_REQUIRED。
   * 返回当前观测快照（只读）；匹配失败一律 fail closed（不 abort、不 append）。
   */
  async function enforceExactManualRepairPhase({
    mirTransactionId,
    transactionLockRef,
    mirLockRef,
    mirRecord,
    expectedAnchor,
    expectedGlobalSnapshot,
    expectedAuthorizedHead = null,
    expectedAuthorizedEntries = null,
  }) {
    try {
      const claim = projectRecoveryClaimObservation(
        await deps.metadataStore.readRecoveryClaimObservation(),
      );
      if (claim !== null) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }

      const tx = projectTransactionLockObservation(
        await deps.metadataStore.readTransactionLockObservation(),
      );
      if (tx === null || !lockRefsExactEqual(tx.ref, transactionLockRef)) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }

      const mir = projectManualInterventionLockObservation(
        await deps.metadataStore.readManualInterventionLockObservation(),
      );
      if (
        mir === null
        || !lockRefsExactEqual(mir.ref, mirLockRef)
        || !sameValue(mir.record, mirRecord)
      ) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }

      const anchor = validateLaunchAgentAnchor(
        await deps.metadataStore.readAnchor(expectedAnchor.anchorId),
      );
      if (!sameValue(anchor, expectedAnchor)) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }
      if (anchor.transactionId !== mirTransactionId) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }

      const globalSnapshot = await readGlobalJournalHeadsSnapshot();
      if (!sameValue(globalSnapshot, expectedGlobalSnapshot)) {
        // foreign 任意 head / journalSha256 漂移 = class C：保留两锁。
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }

      const authorized = globalSnapshot.heads.find(
        (head) => head.transactionId === mirTransactionId,
      );
      if (authorized === undefined) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }
      if (expectedAuthorizedHead !== null && !sameValue(authorized, expectedAuthorizedHead)) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }

      const entries = await readProjectedTransactionEntries(mirTransactionId);
      if (expectedAuthorizedEntries !== null && !sameValue(entries, expectedAuthorizedEntries)) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }
      const latest = entries[entries.length - 1];
      if (!sameValue(latest, authorized)) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }

      return { globalSnapshot, entries, authorizedHead: authorized, anchor, mir, tx };
    } catch (error) {
      if (error instanceof LaunchAgentLifecycleError) throw error;
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }
  }

  /**
   * class-B abort 前：先 exact phase（global heads/MIR/anchor/tx/claim）。
   * phase 失败（含 foreign drift=class C）→ 保留两锁并 RECOVERY_REQUIRED；
   * phase 精确匹配 → 仅 abort 自己 recovery tx，再 RECOVERY_REQUIRED。
   */
  async function abortOwnRecoveryLockAsClassBOrRetain({
    mirTransactionId,
    acquiredLockRef,
    mirLockRef,
    mirRecord,
    preJournal,
    preAnchor,
  }) {
    // phase guard 失败直接 RECOVERY_REQUIRED（保留两锁，绝不 abort）。
    await enforceExactManualRepairPhase({
      mirTransactionId,
      transactionLockRef: acquiredLockRef,
      mirLockRef,
      mirRecord,
      expectedAnchor: preAnchor,
      expectedGlobalSnapshot: preJournal.snapshot,
      expectedAuthorizedHead: preJournal.head,
      expectedAuthorizedEntries: preJournal.entries,
    });
    await deps.metadataStore.abortRecoveryLockForManualRepair({
      transactionLockRef: acquiredLockRef,
      manualInterventionLockRef: mirLockRef,
      expectedMirHead: {
        transactionId: mirTransactionId,
        entrySha256: preJournal.head.entrySha256,
      },
    });
    coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
  }

  /**
   * 校验 frozen reversePlan evidence（candidate readCandidate / anchor exact）。
   * 失败返回 false；不抛（调用方决定 class B/C）。
   */
  async function verifyFrozenReversePlanEvidence(reversePlan, reversePlanSha256, anchor) {
    if (
      typeof reversePlanSha256 !== 'string'
      || !SHA256_PATTERN.test(reversePlanSha256)
      || sha256Hex(Buffer.from(JSON.stringify(reversePlan), 'utf8')) !== reversePlanSha256
    ) {
      return false;
    }
    if (!Array.isArray(reversePlan) || reversePlan.length === 0) return false;
    for (const step of reversePlan) {
      if (step === null || typeof step !== 'object') return false;
      const evidence = step.evidence;
      if (evidence === null || typeof evidence !== 'object') return false;
      if (evidence.kind === 'candidate') {
        let bytes;
        try {
          bytes = await deps.metadataStore.readCandidate({
            kind: 'candidate',
            transactionId: evidence.transactionId,
            role: evidence.role,
            sha256: evidence.sha256,
          });
        } catch {
          return false;
        }
        if (!Buffer.isBuffer(bytes) || sha256Hex(bytes) !== evidence.sha256) {
          return false;
        }
        continue;
      }
      const role = step.role;
      const anchorEntry = anchor[role];
      if (
        evidence.kind !== 'anchor'
        || evidence.anchorId !== anchor.anchorId
        || anchorEntry?.priorState !== 'bytes'
        || anchorEntry.sha256 !== evidence.sha256
        || (role !== 'manifest' && anchor.loaded[role] !== evidence.loaded)
        || (role === 'manifest' && evidence.loaded !== false)
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * preJournal.entries 中是否存在可识别的 compensating + reversePlan
   * （已由 readAuthorizedMirJournal 校验 monoid 链；未必过 full prefix 单调性）。
   */
  function preJournalHasCompensatingReversePlan(preJournal) {
    if (!Array.isArray(preJournal?.entries)) return false;
    return preJournal.entries.some((entry) => (
      entry.state === 'compensating'
      && entry.payload !== null
      && typeof entry.payload === 'object'
      && Object.hasOwn(entry.payload, 'reversePlan')
      && Object.hasOwn(entry.payload, 'reversePlanSha256')
      && Array.isArray(entry.payload.reversePlan)
      && entry.payload.reversePlan.length > 0
    ));
  }

  /**
   * 终态后有序释锁：tx → 验证 tx absent 且 MIR exact → MIR → 验证两锁 absent。
   * 无 generalized finally；任一步失败保留剩余锁并 fail closed。
   * 仅双锁 class A 路径调用；不得被 MIR-only 路径使用（会错误 release 已 absent 的 tx）。
   */
  async function releaseTerminalLocksOrdered(transactionLockRef, mirLockRef, mirRecord) {
    await deps.metadataStore.releaseTransactionLock(transactionLockRef);

    const txAfter = projectTransactionLockObservation(
      await deps.metadataStore.readTransactionLockObservation(),
    );
    if (txAfter !== null) coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);

    const mirAfter = projectManualInterventionLockObservation(
      await deps.metadataStore.readManualInterventionLockObservation(),
    );
    if (
      mirAfter === null
      || !lockRefsExactEqual(mirAfter.ref, mirLockRef)
      || !sameValue(mirAfter.record, mirRecord)
    ) {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }

    await deps.metadataStore.releaseManualInterventionLock(mirLockRef);

    const txFinal = projectTransactionLockObservation(
      await deps.metadataStore.readTransactionLockObservation(),
    );
    const mirFinal = projectManualInterventionLockObservation(
      await deps.metadataStore.readManualInterventionLockObservation(),
    );
    if (txFinal !== null || mirFinal !== null) {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }
  }

  /**
   * §6.6 MIR-only：tx 已 absent 时的窄释放路径。
   * 释放前再次确认 tx still absent、MIR exact、claim absent；
   * 只 releaseManualInterventionLock；最终验证 tx/MIR 均 absent。
   * 绝不 owner observe / acquire / append / publish / releaseTransactionLock。
   * 普通双锁路径禁止调用本函数（会跳过必释的 residual tx）。
   */
  async function releaseTerminalMirOnly(mirLockRef, mirRecord) {
    const txStill = projectTransactionLockObservation(
      await deps.metadataStore.readTransactionLockObservation(),
    );
    if (txStill !== null) {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }

    const mirStill = projectManualInterventionLockObservation(
      await deps.metadataStore.readManualInterventionLockObservation(),
    );
    if (
      mirStill === null
      || !lockRefsExactEqual(mirStill.ref, mirLockRef)
      || !sameValue(mirStill.record, mirRecord)
    ) {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }

    const claimStill = projectRecoveryClaimObservation(
      await deps.metadataStore.readRecoveryClaimObservation(),
    );
    if (claimStill !== null) {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }

    await deps.metadataStore.releaseManualInterventionLock(mirLockRef);

    const txFinal = projectTransactionLockObservation(
      await deps.metadataStore.readTransactionLockObservation(),
    );
    const mirFinal = projectManualInterventionLockObservation(
      await deps.metadataStore.readManualInterventionLockObservation(),
    );
    if (txFinal !== null || mirFinal !== null) {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }
  }

  /**
   * class A：已存在 exact recovered/blocked terminal + embedded matching receipt +
   * persisted matching receipt。读取完整 valid prefix + 冻结 reversePlan/evidence/anchor，
   * readCandidate exact + inspectCurrentState 再证 host：
   * - recovered：live exact anchor recovered checkpoint
   * - blocked：再证 safe-disabled / no pending / full 三 role final union
   * 释放前重验 global terminal snapshot、anchor、host、tx/MIR；失败保留剩余锁。
   *
   * transactionLockRef 可空：
   * - non-null：双锁路径，tx exact 后 tx→MIR 有序释放
   * - null：§6.6 MIR-only，tx 必须仍 absent，仅 release MIR
   */
  async function cleanupExistingExactTerminal({
    mirTransactionId,
    mirLockRef,
    mirRecord,
    transactionLockRef,
  }) {
    const rawEntries = await deps.metadataStore.readJournal({ transactionId: mirTransactionId });
    if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }
    let entries;
    try {
      entries = validateLaunchAgentTransactionPrefix({ entries: rawEntries }).entries;
    } catch {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }
    const head = entries[entries.length - 1];
    if (!PURE_CLOSEOUT_EXISTING_TERMINALS.has(head.state)) {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }
    if (!Object.hasOwn(head.payload, 'receipt')) {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }

    let embedded;
    try {
      embedded = validateLaunchAgentReceipt(head.payload.receipt);
    } catch {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }
    if (!receiptMatchesTerminal(head, embedded)) {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }

    const classification = await classifyExistingReceipt(mirTransactionId);
    if (
      classification.status !== 'valid'
      || !receiptMatchesTerminal(head, classification.receipt)
      || !sameValue(classification.receipt, embedded)
    ) {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }

    let closeout;
    try {
      closeout = validateLaunchAgentTransactionCloseout({
        entries,
        receipt: classification.receipt,
      });
    } catch {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }
    if (!sameValue(closeout.receipt, embedded)) {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }

    // 恢复 frozen reversePlan / evidence / anchor；只读 re-prove host disposition。
    const frozen = entries.find((entry) => entry.state === 'compensating');
    if (
      frozen === undefined
      || !Object.hasOwn(frozen.payload, 'reversePlan')
      || !Object.hasOwn(frozen.payload, 'reversePlanSha256')
    ) {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }
    const reversePlan = frozen.payload.reversePlan;
    const reversePlanSha256 = frozen.payload.reversePlanSha256;

    let anchor;
    try {
      anchor = validateLaunchAgentAnchor(
        await deps.metadataStore.readAnchor(closeout.receipt.anchorId),
      );
    } catch {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }
    if (
      anchor.anchorId !== closeout.receipt.anchorId
      || anchor.transactionId !== mirTransactionId
      || anchor.sourceCommit !== closeout.receipt.sourceCommit
    ) {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }

    if (!(await verifyFrozenReversePlanEvidence(reversePlan, reversePlanSha256, anchor))) {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }

    let live;
    try {
      live = await inspectCurrentState();
    } catch {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }

    const disposition = classifyPureCloseoutDisposition(reversePlan, live, anchor);
    if (head.state === 'recovered') {
      if (disposition !== 'recovered') {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }
    } else if (head.state === 'blocked') {
      if (disposition !== 'blocked') {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }
    } else {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }

    // 释放前重验：global terminal snapshot、receipt、anchor、host、tx/MIR。
    const terminalGlobal = await readGlobalJournalHeadsSnapshot();
    const authorizedHead = terminalGlobal.heads.find(
      (entry) => entry.transactionId === mirTransactionId,
    );
    if (authorizedHead === undefined || !sameValue(authorizedHead, head)) {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }
    const stableGlobal = await readGlobalJournalHeadsSnapshot();
    if (!sameValue(stableGlobal, terminalGlobal)) {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }

    const reEntries = await readProjectedTransactionEntries(mirTransactionId);
    const reHead = reEntries[reEntries.length - 1];
    if (!sameValue(reHead, head)) {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }
    const reReceipt = validateLaunchAgentReceipt(
      await deps.metadataStore.readReceipt(mirTransactionId),
    );
    if (!sameValue(reReceipt, closeout.receipt)) {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }

    let reAnchor;
    try {
      reAnchor = validateLaunchAgentAnchor(
        await deps.metadataStore.readAnchor(anchor.anchorId),
      );
    } catch {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }
    if (!sameValue(reAnchor, anchor)) {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }

    let reLive;
    try {
      reLive = await inspectCurrentState();
    } catch {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }
    const reDisposition = classifyPureCloseoutDisposition(reversePlan, reLive, reAnchor);
    if (reDisposition !== disposition) {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }

    const txStill = projectTransactionLockObservation(
      await deps.metadataStore.readTransactionLockObservation(),
    );
    if (transactionLockRef === null) {
      // §6.6 MIR-only：tx 必须仍 absent；出现 residual tx → fail closed 保留 MIR。
      if (txStill !== null) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }
    } else if (
      txStill === null
      || !lockRefsExactEqual(txStill.ref, transactionLockRef)
    ) {
      // 双锁路径：tx 必须仍 exact 匹配 authority residual ref。
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }
    const mirStill = projectManualInterventionLockObservation(
      await deps.metadataStore.readManualInterventionLockObservation(),
    );
    if (
      mirStill === null
      || !lockRefsExactEqual(mirStill.ref, mirLockRef)
      || !sameValue(mirStill.record, mirRecord)
    ) {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }
    const claimStill = projectRecoveryClaimObservation(
      await deps.metadataStore.readRecoveryClaimObservation(),
    );
    if (claimStill !== null) {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }

    if (transactionLockRef === null) {
      await releaseTerminalMirOnly(mirLockRef, mirRecord);
    } else {
      await releaseTerminalLocksOrdered(transactionLockRef, mirLockRef, mirRecord);
    }
    return closeout.receipt;
  }

  /**
   * 新终态 pure closeout：append terminal → publish receipt → closeout 校验 →
   * 释放前重验 expected terminal global heads（其他 heads 与 pre exact、自己 head
   * exact terminal；随后 snapshot 稳定）、receipt、anchor exact、host disposition
   * 仍一致、tx/MIR exact；漂移保留两锁。零 host mutation。
   */
  async function pureCloseoutAppendAndRelease({
    context,
    mirLockRef,
    mirRecord,
    preJournal,
    preAnchor,
    disposition,
    reversePlan,
    state,
    outcome,
    roles,
    blockedByEntrySha256 = null,
  }) {
    const receipt = validateLaunchAgentReceipt({
      schemaVersion: 1,
      operation: context.operation,
      state,
      success: false,
      sourceCommit: context.sourceCommit,
      transactionId: context.transactionId,
      anchorId: context.anchorId,
      completedAt: deps.clock.now(),
      roles,
      hostMutationCount: context.mutationCount,
      outcome,
    });
    const receiptSha256 = sha256Hex(Buffer.from(JSON.stringify(receipt), 'utf8'));
    const terminalPayload = { receipt, receiptSha256 };
    if (state === 'blocked') {
      terminalPayload.blockedByEntrySha256 = blockedByEntrySha256;
    }

    await appendJournal(context, state, terminalPayload);
    await deps.metadataStore.publishReceipt({
      receipt,
      lockRef: context.lockRef,
    });

    const entries = await deps.metadataStore.readJournal({
      transactionId: context.transactionId,
    });
    const persisted = validateLaunchAgentReceipt(
      await deps.metadataStore.readReceipt(context.transactionId),
    );
    const closeout = validateLaunchAgentTransactionCloseout({
      entries,
      receipt: persisted,
    });
    if (!sameValue(receipt, closeout.receipt)) {
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }

    // 释放前：expected terminal global heads + receipt + anchor + host + tx/MIR。
    try {
      const reEntries = await readProjectedTransactionEntries(context.transactionId);
      const reHead = reEntries[reEntries.length - 1];
      if (reHead.state !== state) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }
      if (!receiptMatchesTerminal(reHead, persisted)) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }
      if (!sameValue(persisted, closeout.receipt)) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }

      const terminalGlobal = await readGlobalJournalHeadsSnapshot();
      const authorized = terminalGlobal.heads.find(
        (head) => head.transactionId === context.transactionId,
      );
      if (authorized === undefined || !sameValue(authorized, reHead)) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }
      // 其他 heads 与 pre exact；自己 head 为 exact terminal（已替换 open MIR）。
      const preOthers = preJournal.snapshot.heads.filter(
        (head) => head.transactionId !== context.transactionId,
      );
      const terminalOthers = terminalGlobal.heads.filter(
        (head) => head.transactionId !== context.transactionId,
      );
      if (!sameValue(terminalOthers, preOthers)) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }
      if (terminalGlobal.heads.length !== preOthers.length + 1) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }
      const stableGlobal = await readGlobalJournalHeadsSnapshot();
      if (!sameValue(stableGlobal, terminalGlobal)) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }

      const reAnchor = validateLaunchAgentAnchor(
        await deps.metadataStore.readAnchor(preAnchor.anchorId),
      );
      if (!sameValue(reAnchor, preAnchor)) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }

      const reLive = await inspectCurrentState();
      const reDisposition = classifyPureCloseoutDisposition(reversePlan, reLive, reAnchor);
      if (reDisposition !== disposition) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }

      const claim = projectRecoveryClaimObservation(
        await deps.metadataStore.readRecoveryClaimObservation(),
      );
      if (claim !== null) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }
      const tx = projectTransactionLockObservation(
        await deps.metadataStore.readTransactionLockObservation(),
      );
      if (tx === null || !lockRefsExactEqual(tx.ref, context.lockRef)) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }
      const mir = projectManualInterventionLockObservation(
        await deps.metadataStore.readManualInterventionLockObservation(),
      );
      if (
        mir === null
        || !lockRefsExactEqual(mir.ref, mirLockRef)
        || !sameValue(mir.record, mirRecord)
      ) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }
    } catch (error) {
      // terminal 已落盘后的漂移窗口：一律 RECOVERY_REQUIRED 并保留两锁；
      // 不得把 anchor missing 等路径泄漏为 INVALID。
      if (
        error instanceof LaunchAgentLifecycleError
        && error.code === LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED
      ) {
        throw error;
      }
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }

    await releaseTerminalLocksOrdered(context.lockRef, mirLockRef, mirRecord);
    return closeout.receipt;
  }

  /**
   * 锁后 pure closeout：完整链过 validateLaunchAgentTransactionPrefix；
   * reversePlan hash/evidence 冻结校验；live 只读 inspect/print。
   * pure classify / append / class-B abort 前均走 exact phase guard。
   * 可 pure close → recovered|blocked 收据；
   * 有 frozen plan 但不可 pure → class B/C 后 RECOVERY_REQUIRED；
   * 合法无 compensating → 返回 null（Task5 locked）。
   * prefix 失败且 preJournal 已有 compensating/reversePlan → fail closed（非 locked）。
   */
  async function attemptPureCloseoutAfterLock({
    mirTransactionId,
    acquiredLockRef,
    mirLockRef,
    mirRecord,
    preJournal,
    preAnchor,
  }) {
    const mirHead = preJournal.head;
    const mirHeadEntrySha256 = mirHead.entrySha256;
    const hostMutationCount = mirHead.payload.hostMutationCount;

    const failNotPure = async () => {
      await abortOwnRecoveryLockAsClassBOrRetain({
        mirTransactionId,
        acquiredLockRef,
        mirLockRef,
        mirRecord,
        preJournal,
        preAnchor,
      });
    };

    let entries;
    try {
      const rawEntries = await deps.metadataStore.readJournal({
        transactionId: mirTransactionId,
      });
      if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
        if (preJournalHasCompensatingReversePlan(preJournal)) {
          await failNotPure();
        }
        return null;
      }
      entries = validateLaunchAgentTransactionPrefix({ entries: rawEntries }).entries;
    } catch {
      // prefix 失败：已 validated preJournal.entries 若含 compensating/reversePlan
      // → fail closed（B/C）；仅合法无 compensating 链才返回 Task5 locked。
      if (preJournalHasCompensatingReversePlan(preJournal)) {
        await failNotPure();
      }
      return null;
    }
    if (!sameValue(entries[entries.length - 1], mirHead)) {
      if (preJournalHasCompensatingReversePlan(preJournal)) {
        await failNotPure();
      }
      return null;
    }
    if (entries[entries.length - 1].state !== 'manual-intervention-required') {
      if (preJournalHasCompensatingReversePlan(preJournal)) {
        await failNotPure();
      }
      return null;
    }

    const frozen = entries.find((entry) => entry.state === 'compensating');
    if (frozen === undefined) return null;
    if (
      !Object.hasOwn(frozen.payload, 'reversePlan')
      || !Object.hasOwn(frozen.payload, 'reversePlanSha256')
    ) {
      return null;
    }

    const reversePlan = frozen.payload.reversePlan;
    const reversePlanSha256 = frozen.payload.reversePlanSha256;
    if (!Array.isArray(reversePlan) || reversePlan.length === 0) return null;

    // anchor exact（与授权/锁前快照一致）。
    let anchor;
    try {
      anchor = validateLaunchAgentAnchor(
        await deps.metadataStore.readAnchor(preAnchor.anchorId),
      );
    } catch {
      await failNotPure();
    }
    if (!sameValue(anchor, preAnchor)) await failNotPure();
    if (anchor.transactionId !== mirTransactionId) await failNotPure();

    if (!(await verifyFrozenReversePlanEvidence(reversePlan, reversePlanSha256, anchor))) {
      await failNotPure();
    }

    // pure classify 前：exact phase（含完整 global heads）。
    await enforceExactManualRepairPhase({
      mirTransactionId,
      transactionLockRef: acquiredLockRef,
      mirLockRef,
      mirRecord,
      expectedAnchor: preAnchor,
      expectedGlobalSnapshot: preJournal.snapshot,
      expectedAuthorizedHead: preJournal.head,
      expectedAuthorizedEntries: preJournal.entries,
    });

    // live host 只读 inspect/print（零 host mutation）。
    let live;
    try {
      live = await inspectCurrentState();
    } catch {
      await failNotPure();
    }

    // inspect 后、classify 前再验 phase（捕获 foreign head TOCTOU）。
    await enforceExactManualRepairPhase({
      mirTransactionId,
      transactionLockRef: acquiredLockRef,
      mirLockRef,
      mirRecord,
      expectedAnchor: preAnchor,
      expectedGlobalSnapshot: preJournal.snapshot,
      expectedAuthorizedHead: preJournal.head,
      expectedAuthorizedEntries: preJournal.entries,
    });

    const disposition = classifyPureCloseoutDisposition(reversePlan, live, anchor);
    if (disposition !== 'recovered' && disposition !== 'blocked') {
      await failNotPure();
    }

    // append 前再次 exact phase。
    await enforceExactManualRepairPhase({
      mirTransactionId,
      transactionLockRef: acquiredLockRef,
      mirLockRef,
      mirRecord,
      expectedAnchor: preAnchor,
      expectedGlobalSnapshot: preJournal.snapshot,
      expectedAuthorizedHead: preJournal.head,
      expectedAuthorizedEntries: preJournal.entries,
    });

    const context = {
      operation: mirHead.operation,
      sourceCommit: anchor.sourceCommit,
      rendered: null,
      transactionId: mirTransactionId,
      lockRef: acquiredLockRef,
      lastEntry: mirHead,
      mutationCount: hostMutationCount,
      anchorId: anchor.anchorId,
      anchor,
      anchorRef: null,
      facts: live.facts,
      identities: { controller: null, scheduler: null, manifest: null },
      candidateRefs: { controller: null, scheduler: null, manifest: null },
      restorationCandidateTransactionId: null,
      possiblePublisherMutations: new Set(),
      published: new Set(),
      stopped: new Set(),
      loadedNew: { controller: false, scheduler: false },
    };

    if (disposition === 'recovered') {
      return pureCloseoutAppendAndRelease({
        context,
        mirLockRef,
        mirRecord,
        preJournal,
        preAnchor,
        disposition,
        reversePlan,
        state: 'recovered',
        outcome: 'recovered',
        roles: recoveredReceiptRolesFromAnchor(anchor),
      });
    }

    return pureCloseoutAppendAndRelease({
      context,
      mirLockRef,
      mirRecord,
      preJournal,
      preAnchor,
      disposition,
      reversePlan,
      state: 'blocked',
      outcome: 'recovery-required',
      roles: receiptRoles(
        { outcome: 'unchanged', changed: false },
        { outcome: 'unchanged', changed: false },
      ),
      blockedByEntrySha256: mirHeadEntrySha256,
    });
  }

  /**
   * Task 6B.1：消费一次性人工修复 authority → durable attestation →
   * residual claim 优先处理 → exact pre-lock 快照 → 双次 owner dead →
   * （已有 exact terminal：cleanup-only）或 claim-fenced recovery acquisition →
   * post-lock 快照 → pure closeout（零 host mutation）或返回 locked context。
   */
  async function runRecoverAfterManualRepair(capability) {
    // 1) authority 必须最先、同步、零 I/O 消费（lookalike/clone/replay → denied）。
    const authority = assertAndConsumeLaunchAgentManualRepairAuthority(capability);

    // 2) durable attestation：attestedAt 来自 clock.now（能力已焚毁）。
    const attestedAt = deps.clock.now();
    const attestation = validateLaunchAgentManualRepairAttestation({
      schemaVersion: 1,
      kind: 'launchagent-manual-repair-attestation',
      manualRepairConfirmationId: authority.manualRepairConfirmationId,
      manualRepairRequestId: authority.projection.manualRepairRequestId,
      mirTransactionId: authority.projection.mirTransactionId,
      mirLockIdentitySha256: authority.projection.mirLockIdentitySha256,
      anchorId: authority.projection.anchorId,
      repairDeclarationSha256: authority.projection.repairDeclarationSha256,
      authorizedAt: authority.projection.authorizedAt,
      attestedAt,
    });
    await deps.metadataStore.writeManualRepairAttestation(attestation);
    const attestationReadBack = validateLaunchAgentManualRepairAttestation(
      await deps.metadataStore.readManualRepairAttestation(
        attestation.manualRepairConfirmationId,
      ),
    );
    if (!sameValue(attestation, attestationReadBack)) invalid();

    const mirTransactionId = authority.projection.mirTransactionId;
    const mirLockRef = authority.mirLockRef;
    const expectedTransactionLockRef = authority.transactionLockRef;

    // 3) residual recovery claim 必须最先处理；present 时绝不进入 acquire/closeout。
    let claimObservation;
    try {
      claimObservation = projectRecoveryClaimObservation(
        await deps.metadataStore.readRecoveryClaimObservation(),
      );
    } catch (error) {
      if (error instanceof LaunchAgentLifecycleError) throw error;
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_CLAIM_STALLED);
    }

    if (claimObservation !== null) {
      const claimRecord = claimObservation.record;
      if (claimRecord.transactionId !== mirTransactionId) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_CLAIM_STALLED);
      }
      if (!lockRefsExactEqual(claimRecord.manualInterventionLockRef, mirLockRef)) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_CLAIM_STALLED);
      }

      // residual claim owner：逐次闭合分类（§6.3.3）。
      // 第一次 alive-same-owner → TRANSACTION_IN_PROGRESS（无第二次 observe、无 resolve）。
      // 第一次 dead 才第二次 observe；第二次 alive-same-owner → TRANSACTION_IN_PROGRESS。
      // 两次均 exact dead 才 resolve；其余非 dead/malformed/throw → RECOVERY_CLAIM_STALLED。
      let observe1;
      try {
        observe1 = await deps.processIdentityReader.observe(claimRecord);
      } catch {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_CLAIM_STALLED);
      }
      let claimOwnerStatus1;
      try {
        claimOwnerStatus1 = validateObserveStatus(observe1);
      } catch {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_CLAIM_STALLED);
      }
      if (claimOwnerStatus1 === 'alive-same-owner') {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.TRANSACTION_IN_PROGRESS);
      }
      if (claimOwnerStatus1 !== 'dead') {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_CLAIM_STALLED);
      }

      let observe2;
      try {
        observe2 = await deps.processIdentityReader.observe(claimRecord);
      } catch {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_CLAIM_STALLED);
      }
      let claimOwnerStatus2;
      try {
        claimOwnerStatus2 = validateObserveStatus(observe2);
      } catch {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_CLAIM_STALLED);
      }
      if (claimOwnerStatus2 === 'alive-same-owner') {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.TRANSACTION_IN_PROGRESS);
      }
      if (claimOwnerStatus2 !== 'dead') {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_CLAIM_STALLED);
      }

      let resolveResult;
      try {
        resolveResult = await deps.metadataStore.resolveRecoveryClaimForManualRepair({
          recoveryClaimRef: claimObservation.ref,
          manualInterventionLockRef: mirLockRef,
        });
      } catch (error) {
        if (error instanceof LaunchAgentLifecycleError) throw error;
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_CLAIM_STALLED);
      }
      let status;
      try {
        status = readExactObject(resolveResult, ['status']).status;
      } catch {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_CLAIM_STALLED);
      }
      if (!SAFE_RECOVERY_CLAIM_RESOLVE_STATUSES.has(status)) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_CLAIM_STALLED);
      }
      // 安全 resolution 后立即结束本次已消费授权；禁止继续 acquire/host/closeout。
      return deepFreeze({
        kind: 'manual-repair-recovery-claim-resolved',
        status,
        mirTransactionId,
        recoveryClaimRef: claimObservation.ref,
      });
    }

    // 4) exact pre-lock snapshot（仅 residual claim absent 后）。
    const mirObservation = projectManualInterventionLockObservation(
      await deps.metadataStore.readManualInterventionLockObservation(),
    );
    if (mirObservation === null) invalid();
    if (!lockRefsExactEqual(mirObservation.ref, mirLockRef)) invalid();
    if (mirObservation.record.transactionId !== mirTransactionId) invalid();
    if (mirObservation.ref.sha256 !== authority.projection.mirLockIdentitySha256) invalid();

    const preTxObservation = projectTransactionLockObservation(
      await deps.metadataStore.readTransactionLockObservation(),
    );
    if (expectedTransactionLockRef === null) {
      if (preTxObservation !== null) invalid();
    } else {
      if (preTxObservation === null) invalid();
      if (!lockRefsExactEqual(preTxObservation.ref, expectedTransactionLockRef)) invalid();
      if (preTxObservation.record.transactionId !== mirTransactionId) invalid();
    }

    // 4a) 已存在 recovered|blocked terminal：class A cleanup-only。
    // 必须在 acquire 之前识别；双 dead 后不 acquire/append/republish。
    {
      const headsSnapshot = await deps.metadataStore.readJournalHeads();
      const headFields = readExactObject(headsSnapshot, ['kind', 'journalSha256', 'heads']);
      if (headFields.kind !== 'journal-heads') invalid();
      requireSha256(headFields.journalSha256);
      if (!Array.isArray(headFields.heads)) invalid();
      let priorTransactionId = null;
      let authorizedHead = null;
      for (const rawHead of headFields.heads) {
        const head = validateLaunchAgentJournal(rawHead);
        if (priorTransactionId !== null && priorTransactionId >= head.transactionId) invalid();
        priorTransactionId = head.transactionId;
        if (head.transactionId === mirTransactionId) authorizedHead = head;
      }
      if (authorizedHead === null) invalid();

      if (PURE_CLOSEOUT_EXISTING_TERMINALS.has(authorizedHead.state)) {
        // class A 两种合法路径（ref 与 preTx 观测已在上方 fail-closed 对齐）：
        // (i) expectedTransactionLockRef exact 非空 + preTx exact → 双 dead 后 tx→MIR 有序清理
        // (ii) expectedTransactionLockRef===null + preTx===null → §6.6 MIR-only，无 owner observe
        // 禁止新 acquisition / append / republish；host 漂移保留 MIR。
        if (
          expectedTransactionLockRef !== null
          && preTxObservation !== null
        ) {
          let owner1;
          let owner2;
          try {
            owner1 = await deps.processIdentityReader.observe(preTxObservation.record);
            owner2 = await deps.processIdentityReader.observe(preTxObservation.record);
          } catch {
            coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
          }
          if (!isExactDeadStatus(owner1) || !isExactDeadStatus(owner2)) {
            coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
          }
          return cleanupExistingExactTerminal({
            mirTransactionId,
            mirLockRef,
            mirRecord: mirObservation.record,
            transactionLockRef: expectedTransactionLockRef,
          });
        }

        if (
          expectedTransactionLockRef === null
          && preTxObservation === null
        ) {
          // §6.6 MIR-only：绝不 owner observe / acquire；同一完整 terminal proof 后只释 MIR。
          return cleanupExistingExactTerminal({
            mirTransactionId,
            mirLockRef,
            mirRecord: mirObservation.record,
            transactionLockRef: null,
          });
        }

        // ref 与观测不一致（理论上已在 pre-lock 校验 invalid）；仍 fail closed。
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }
    }

    const preJournal = await readAuthorizedMirJournal(mirTransactionId);

    const preAnchor = validateLaunchAgentAnchor(
      await deps.metadataStore.readAnchor(authority.projection.anchorId),
    );
    if (preAnchor.anchorId !== authority.projection.anchorId) invalid();
    if (preAnchor.transactionId !== mirTransactionId) invalid();

    // 5) 旧 transaction owner 连续两次 exact dead；无旧锁则跳过 observe。
    if (preTxObservation !== null) {
      let owner1;
      let owner2;
      try {
        owner1 = await deps.processIdentityReader.observe(preTxObservation.record);
        owner2 = await deps.processIdentityReader.observe(preTxObservation.record);
      } catch (error) {
        if (error instanceof LaunchAgentLifecycleError) {
          coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
        }
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }
      if (!isExactDeadStatus(owner1) || !isExactDeadStatus(owner2)) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      }
    }

    // 6) claim-fenced recovery acquisition：仅两个新 ID；transactionId 固定为 MIR。
    const claimId = requireUuid(deps.clock.newId());
    const freshOwnerNonce = requireUuid(deps.clock.newId());
    if (
      claimId === mirTransactionId
      || claimId === freshOwnerNonce
      || mirTransactionId === freshOwnerNonce
    ) {
      invalid();
    }

    const identity = validateCurrentIdentity(await deps.processIdentityReader.current());
    const ownerPid = requirePositiveSafeInteger(process.pid);
    const freshRecord = {
      schemaVersion: 1,
      transactionId: mirTransactionId,
      ownerPid,
      ownerNonce: freshOwnerNonce,
      bootSessionIdentity: identity.bootSessionIdentity,
      processStartIdentity: identity.processStartIdentity,
    };

    // acquisition 竞争失败原样抛出既有 lifecycle 错误；禁止 cleanup winner claim。
    const acquiredLockRef = projectTransactionLockRef(
      await deps.metadataStore.acquireRecoveryLockForManualRepair({
        record: freshRecord,
        claimId,
        expectedTransactionLockRef,
        manualInterventionLockRef: mirLockRef,
      }),
    );
    if (
      acquiredLockRef.transactionId !== mirTransactionId
      || acquiredLockRef.ownerNonce !== freshOwnerNonce
    ) {
      invalid();
    }

    // 7) post-lock 快照：claim absent；fresh tx/MIR/journal/anchor 与 pre-lock exact。
    let postMismatch = false;
    try {
      const postClaim = projectRecoveryClaimObservation(
        await deps.metadataStore.readRecoveryClaimObservation(),
      );
      if (postClaim !== null) postMismatch = true;

      const postTx = projectTransactionLockObservation(
        await deps.metadataStore.readTransactionLockObservation(),
      );
      if (
        postTx === null
        || !lockRefsExactEqual(postTx.ref, acquiredLockRef)
        || postTx.record.transactionId !== mirTransactionId
        || postTx.record.ownerNonce !== freshOwnerNonce
        || postTx.record.ownerPid !== ownerPid
        || !sameValue(postTx.record.bootSessionIdentity, identity.bootSessionIdentity)
        || !sameValue(postTx.record.processStartIdentity, identity.processStartIdentity)
      ) {
        postMismatch = true;
      }

      const postMir = projectManualInterventionLockObservation(
        await deps.metadataStore.readManualInterventionLockObservation(),
      );
      if (
        postMir === null
        || !lockRefsExactEqual(postMir.ref, mirLockRef)
        || !sameValue(postMir.record, mirObservation.record)
      ) {
        postMismatch = true;
      }

      const postJournal = await readAuthorizedMirJournal(mirTransactionId);
      // 完整 global snapshot exact equality：journalSha256 或任一 global head 漂移均 mismatch。
      if (
        !sameValue(postJournal.snapshot, preJournal.snapshot)
        || postJournal.head.entrySha256 !== preJournal.head.entrySha256
        || !sameValue(postJournal.head, preJournal.head)
        || !sameValue(postJournal.entries, preJournal.entries)
      ) {
        postMismatch = true;
      }

      const postAnchor = validateLaunchAgentAnchor(
        await deps.metadataStore.readAnchor(authority.projection.anchorId),
      );
      if (!sameValue(postAnchor, preAnchor)) {
        postMismatch = true;
      }
    } catch (error) {
      if (error instanceof LaunchAgentLifecycleError) {
        postMismatch = true;
      } else {
        postMismatch = true;
      }
    }

    if (postMismatch) {
      // Task 5 / §6.4 class B：仅当 MIR ref/record + MIR chain + 完整 global snapshot
      // 均与 pre-lock 相同才 abort 自己的 recovery tx lock（anchor-only drift）。
      // class C：global journal head/journalSha256 漂移 → snapshot 不等 → 保留锁。
      // 无法证明匹配终态+收据 → 不走 class A pure-closeout。
      let canAbortOwnLock = false;
      try {
        const mirStill = projectManualInterventionLockObservation(
          await deps.metadataStore.readManualInterventionLockObservation(),
        );
        const journalStill = await readAuthorizedMirJournal(mirTransactionId);
        if (
          mirStill !== null
          && lockRefsExactEqual(mirStill.ref, mirLockRef)
          && sameValue(mirStill.record, mirObservation.record)
          && sameValue(journalStill.snapshot, preJournal.snapshot)
          && journalStill.head.entrySha256 === preJournal.head.entrySha256
          && sameValue(journalStill.head, preJournal.head)
          && sameValue(journalStill.entries, preJournal.entries)
        ) {
          canAbortOwnLock = true;
        }
      } catch {
        canAbortOwnLock = false;
      }

      if (canAbortOwnLock) {
        await deps.metadataStore.abortRecoveryLockForManualRepair({
          transactionLockRef: acquiredLockRef,
          manualInterventionLockRef: mirLockRef,
          expectedMirHead: {
            transactionId: mirTransactionId,
            entrySha256: preJournal.head.entrySha256,
          },
        });
      }
      // class B abort 后 / class C 保留锁：一律 fail-closed；禁止 generalized finally。
      coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
    }

    // 8) pure closeout：仅当 frozen reversePlan 可 pure 关闭时写 terminal；
    // 有 plan 但不可 pure → abort 自己 recovery tx + RECOVERY_REQUIRED；
    // 无 plan / prefix 不适用 → 返回 locked（Task 5 / 留给 6B.2）。
    const pureReceipt = await attemptPureCloseoutAfterLock({
      mirTransactionId,
      acquiredLockRef,
      mirLockRef,
      mirRecord: mirObservation.record,
      preJournal,
      preAnchor,
    });
    if (pureReceipt !== null) return pureReceipt;

    // 深冻结内部 locked context：不含 capability / private brand / confirmation 私密对象。
    return deepFreeze({
      kind: 'manual-repair-recovery-locked',
      mirTransactionId,
      claimId,
      freshOwnerNonce,
      transactionLockRef: acquiredLockRef,
      mirLockRef: {
        kind: mirLockRef.kind,
        transactionId: mirLockRef.transactionId,
        ownerNonce: mirLockRef.ownerNonce,
        sha256: mirLockRef.sha256,
      },
      anchorId: authority.projection.anchorId,
      mirHeadEntrySha256: preJournal.head.entrySha256,
      repairDeclarationSha256: authority.projection.repairDeclarationSha256,
      manualRepairRequestId: authority.projection.manualRepairRequestId,
    });
  }

  return Object.freeze({
    async install(input) {
      return runInstallOrUpgrade('install', input);
    },

    async managedUpgrade(input) {
      return runInstallOrUpgrade('managed-upgrade', input);
    },

    async stop(input) {
      return runStop(input);
    },

    async rollback(input) {
      return runRollback(input);
    },

    async uninstall(input) {
      return runUninstall(input);
    },

    async recover(input) {
      return runRecover(input);
    },

    async recoverAfterManualRepair(capability) {
      return runRecoverAfterManualRepair(capability);
    },
  });
}
