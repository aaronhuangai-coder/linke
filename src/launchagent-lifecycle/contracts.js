import { createHash } from 'node:crypto';

const INVALID_CODE = 'launchagent-lifecycle-invalid';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** V1.46 用户级 LaunchAgent 的固定公开词汇。 */
export const LAUNCHAGENT_LIFECYCLE = deepFreeze({
  schemaVersion: 1,
  scope: 'user-launch-agent',
  labels: {
    controller: 'com.linke.controller',
    scheduler: 'com.linke.scheduler',
  },
  filenames: {
    controller: 'com.linke.controller.plist',
    scheduler: 'com.linke.scheduler.plist',
    manifest: 'active-manifest.json',
  },
  rootIds: {
    launchAgents: 'current-user-launch-agents',
    metadata: 'linke-launchagent-lifecycle-metadata',
  },
  scheduleSeconds: { min: 60, max: 86400 },
});

/** V1.46 生命周期模块的闭合结果码。 */
export const LAUNCHAGENT_LIFECYCLE_CODES = deepFreeze({
  INVALID: INVALID_CODE,
  OWNERSHIP_MISMATCH: 'ownership-mismatch',
  LABEL_IN_USE: 'label-in-use',
  CONDITIONAL_MUTATION_UNSUPPORTED: 'conditional-mutation-unsupported',
  CONDITIONAL_MUTATION_MISMATCH: 'conditional-mutation-mismatch',
  TRANSACTION_IN_PROGRESS: 'transaction-in-progress',
  RECOVERY_REQUIRED: 'recovery-required',
  MANUAL_INTERVENTION_REQUIRED: 'manual-intervention-required',
  CONTROLLER_NOT_READY: 'controller-not-ready',
  SCHEDULER_LOAD_FAILED: 'scheduler-load-failed',
  ROLLBACK_RUNTIME_MISMATCH: 'rollback-runtime-mismatch',
  UNINSTALL_UNLOAD_INCOMPLETE: 'uninstall-unload-incomplete',
  ACCOUNT_RESOLUTION_UNAVAILABLE: 'account-resolution-unavailable',
  LAUNCHCTL_DISABLED: 'launchctl-disabled',
  ACCEPTANCE_GATE_DENIED: 'acceptance-gate-denied',
  CONFIRMATION_CONSUMED: 'confirmation-consumed',
});

/** 闭合结果码集合：constructor 只接受其中成员，未知/非 string 归一为 INVALID。 */
const CLOSED_LIFECYCLE_CODES = new Set(Object.values(LAUNCHAGENT_LIFECYCLE_CODES));

/**
 * 对外仅暴露固定名称、错误码与消息的生命周期契约错误。
 * 无参或非法 code → launchagent-lifecycle-invalid；合法 code 时 code/message 同值。
 * 禁止自由消息与额外 data/stack 字段。
 */
export class LaunchAgentLifecycleError extends Error {
  constructor(code) {
    const resolved =
      arguments.length === 0
        ? INVALID_CODE
        : (typeof code === 'string' && CLOSED_LIFECYCLE_CODES.has(code) ? code : INVALID_CODE);
    super(resolved);
    this.name = 'LaunchAgentLifecycleError';
    this.code = resolved;
  }
}

function invalid() {
  throw new LaunchAgentLifecycleError();
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}

function project(validate, value) {
  try {
    return deepFreeze(validate(value));
  } catch (error) {
    if (error instanceof LaunchAgentLifecycleError) throw error;
    invalid();
  }
}

function readExactObject(value, expectedKeys) {
  if (value === null || typeof value !== 'object') invalid();
  if (Object.getPrototypeOf(value) !== Object.prototype) invalid();

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expectedKeys.length || ownKeys.some((key) => typeof key !== 'string')) {
    invalid();
  }

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

function readTag(value, key) {
  if (value === null || typeof value !== 'object') invalid();
  if (Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
  return descriptor.value;
}

function requireLiteral(value, expected) {
  if (value !== expected) invalid();
  return value;
}

function requireString(value) {
  if (typeof value !== 'string' || value.length === 0) invalid();
  return value;
}

function requireBoolean(value) {
  if (typeof value !== 'boolean') invalid();
  return value;
}

function requireInteger(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) invalid();
  return value;
}

function requireEnum(value, allowed) {
  if (typeof value !== 'string' || !allowed.has(value)) invalid();
  return value;
}

function requireUuid(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) invalid();
  return value;
}

function requireCommit(value) {
  if (typeof value !== 'string' || !COMMIT_PATTERN.test(value)) invalid();
  return value;
}

function requireSha256(value) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) invalid();
  return value;
}

function requireSha256OrNull(value) {
  if (value === null) return null;
  return requireSha256(value);
}

function requireUtc(value) {
  if (typeof value !== 'string' || !UTC_PATTERN.test(value)) invalid();
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime()) || instant.toISOString() !== value) invalid();
  return value;
}

function validateRuntimeArtifact(value, expectedPathId) {
  const fields = readExactObject(value, ['pathId', 'sha256']);
  return {
    pathId: requireLiteral(fields.pathId, expectedPathId),
    sha256: requireSha256(fields.sha256),
  };
}

function validateRuntimeArtifacts(value) {
  const fields = readExactObject(value, ['node', 'controller', 'agent']);
  return {
    node: validateRuntimeArtifact(fields.node, 'host-node-executable'),
    controller: validateRuntimeArtifact(fields.controller, 'src/controller-runtime.js'),
    agent: validateRuntimeArtifact(fields.agent, 'src/agent.js'),
  };
}

function validateProfileIdentity(value, role) {
  const fields = readExactObject(value, ['label', 'filename', 'plistSha256']);
  return {
    label: requireLiteral(fields.label, LAUNCHAGENT_LIFECYCLE.labels[role]),
    filename: requireLiteral(fields.filename, LAUNCHAGENT_LIFECYCLE.filenames[role]),
    plistSha256: requireSha256(fields.plistSha256),
  };
}

function manifestProjection(value) {
  const fields = readExactObject(value, [
    'schemaVersion',
    'installationId',
    'scope',
    'sourceCommit',
    'runtimeArtifacts',
    'transactionId',
    'controller',
    'scheduler',
    'activeAnchorId',
    'installedAt',
  ]);
  return {
    schemaVersion: requireLiteral(fields.schemaVersion, 1),
    installationId: requireUuid(fields.installationId),
    scope: requireLiteral(fields.scope, LAUNCHAGENT_LIFECYCLE.scope),
    sourceCommit: requireCommit(fields.sourceCommit),
    runtimeArtifacts: validateRuntimeArtifacts(fields.runtimeArtifacts),
    transactionId: requireUuid(fields.transactionId),
    controller: validateProfileIdentity(fields.controller, 'controller'),
    scheduler: validateProfileIdentity(fields.scheduler, 'scheduler'),
    activeAnchorId: requireUuid(fields.activeAnchorId),
    installedAt: requireUtc(fields.installedAt),
  };
}

/** 校验并投影严格闭合的活动 manifest。 */
export function validateLaunchAgentManifest(value) {
  return project(manifestProjection, value);
}

function validateStoredIdentity(value, role) {
  const fields = readExactObject(value, [
    'rootId',
    'basename',
    'type',
    'ownerUid',
    'device',
    'inode',
    'sha256',
  ]);
  const isManifest = role === 'manifest';
  return {
    rootId: requireLiteral(
      fields.rootId,
      isManifest
        ? LAUNCHAGENT_LIFECYCLE.rootIds.metadata
        : LAUNCHAGENT_LIFECYCLE.rootIds.launchAgents,
    ),
    basename: requireLiteral(
      fields.basename,
      isManifest
        ? LAUNCHAGENT_LIFECYCLE.filenames.manifest
        : LAUNCHAGENT_LIFECYCLE.filenames[role],
    ),
    type: requireLiteral(fields.type, 'regular-file'),
    ownerUid: requireInteger(fields.ownerUid),
    device: requireString(fields.device),
    inode: requireString(fields.inode),
    sha256: requireSha256(fields.sha256),
  };
}

function validateAnchorEntry(value, role) {
  const priorState = readTag(value, 'priorState');
  if (priorState === 'absent') {
    const fields = readExactObject(value, ['priorState']);
    return { priorState: requireLiteral(fields.priorState, 'absent') };
  }
  if (priorState !== 'bytes') invalid();

  const fields = readExactObject(value, [
    'priorState',
    'bytesBase64',
    'sha256',
    'identity',
  ]);
  requireLiteral(fields.priorState, 'bytes');
  const bytesBase64 = requireString(fields.bytesBase64);
  const bytes = Buffer.from(bytesBase64, 'base64');
  if (bytes.toString('base64') !== bytesBase64) invalid();
  const sha256 = requireSha256(fields.sha256);
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) invalid();
  const identity = validateStoredIdentity(fields.identity, role);
  if (identity.sha256 !== sha256) invalid();
  return { priorState: 'bytes', bytesBase64, sha256, identity };
}

function anchorProjection(value) {
  const fields = readExactObject(value, [
    'schemaVersion',
    'anchorId',
    'parentAnchorId',
    'transactionId',
    'sourceCommit',
    'purpose',
    'rollbackFromManifestSha256',
    'restoreManifestSha256',
    'controller',
    'scheduler',
    'manifest',
    'loaded',
    'createdAt',
  ]);
  const loaded = readExactObject(fields.loaded, ['controller', 'scheduler']);
  return {
    schemaVersion: requireLiteral(fields.schemaVersion, 1),
    anchorId: requireUuid(fields.anchorId),
    parentAnchorId: fields.parentAnchorId === null ? null : requireUuid(fields.parentAnchorId),
    transactionId: requireUuid(fields.transactionId),
    sourceCommit: requireCommit(fields.sourceCommit),
    purpose: requireEnum(fields.purpose, new Set([
      'first-install',
      'managed-upgrade',
      'stop',
      'rollback-compensation',
      'uninstall-compensation',
    ])),
    rollbackFromManifestSha256: requireSha256OrNull(fields.rollbackFromManifestSha256),
    restoreManifestSha256: requireSha256OrNull(fields.restoreManifestSha256),
    controller: validateAnchorEntry(fields.controller, 'controller'),
    scheduler: validateAnchorEntry(fields.scheduler, 'scheduler'),
    manifest: validateAnchorEntry(fields.manifest, 'manifest'),
    loaded: {
      controller: requireBoolean(loaded.controller),
      scheduler: requireBoolean(loaded.scheduler),
    },
    createdAt: requireUtc(fields.createdAt),
  };
}

/** 校验并投影严格 tagged-union 的升级或补偿锚点。 */
export function validateLaunchAgentAnchor(value) {
  return project(anchorProjection, value);
}

const JOURNAL_OPERATIONS = new Set([
  'install',
  'managed-upgrade',
  'stop',
  'rollback',
  'uninstall',
  'recover',
]);
const JOURNAL_STATES = new Set([
  'prepared',
  'anchored',
  'published',
  'controller-loaded',
  'controller-ready',
  'scheduler-loaded',
  'committed',
  'compensating',
  'recovered',
  'no-change',
  'blocked',
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

const CHECKPOINT_ROLES = new Map([
  ['controller-publish-intent', new Set(['controller'])],
  ['controller-published', new Set(['controller'])],
  ['scheduler-publish-intent', new Set(['scheduler'])],
  ['scheduler-published', new Set(['scheduler'])],
  ['manifest-publish-intent', new Set(['manifest'])],
  ['manifest-published', new Set(['manifest'])],
  ['controller-load-intent', new Set(['controller'])],
  ['scheduler-load-intent', new Set(['scheduler'])],
  ['scheduler-stop-intent', new Set(['scheduler'])],
  ['scheduler-stopped', new Set(['scheduler'])],
  ['controller-stop-intent', new Set(['controller'])],
  ['controller-stopped', new Set(['controller'])],
  ['controller-remove-intent', new Set(['controller'])],
  ['controller-removed', new Set(['controller'])],
  ['scheduler-remove-intent', new Set(['scheduler'])],
  ['scheduler-removed', new Set(['scheduler'])],
  ['manifest-remove-intent', new Set(['manifest'])],
  ['manifest-removed', new Set(['manifest'])],
  ['role-noop', new Set(['controller', 'scheduler'])],
  ['role-stop-noop', new Set(['controller', 'scheduler'])],
  ['role-load-noop', new Set(['controller', 'scheduler'])],
]);
const COMPENSATION_ACTIONS = new Set([
  'remove-controller', 'remove-scheduler', 'remove-manifest',
  'restore-controller', 'restore-scheduler', 'restore-manifest',
  'stop-controller', 'stop-scheduler', 'load-controller', 'load-scheduler',
]);
const COMPENSATION_ACTION_ORDER = new Map([
  ['stop-scheduler', 0],
  ['stop-controller', 1],
  ['remove-manifest', 2],
  ['restore-manifest', 2],
  ['remove-scheduler', 3],
  ['restore-scheduler', 3],
  ['remove-controller', 4],
  ['restore-controller', 4],
  ['load-controller', 5],
  ['load-scheduler', 6],
]);
const COMPENSATION_STATE_ACTION = new Map();
for (const action of COMPENSATION_ACTIONS) {
  for (const phase of ['intent', 'completed']) {
    const state = `compensate-${action}-${phase}`;
    JOURNAL_STATES.add(state);
    COMPENSATION_STATE_ACTION.set(state, action);
  }
}

function compensationRole(action) {
  const separator = action.indexOf('-');
  if (separator === -1) invalid();
  const role = action.slice(separator + 1);
  if (role !== 'controller' && role !== 'scheduler' && role !== 'manifest') invalid();
  return role;
}

function validateReverseFileState(value, role) {
  const state = readTag(value, 'state');
  if (state === 'absent') {
    const fields = readExactObject(value, ['state']);
    return { state: requireLiteral(fields.state, 'absent') };
  }
  if (state !== 'present') invalid();
  const fields = readExactObject(value, ['state', 'identity', 'sha256']);
  const identity = validateStoredIdentity(fields.identity, role);
  const sha256 = requireSha256(fields.sha256);
  if (identity.sha256 !== sha256) invalid();
  return { state: 'present', identity, sha256 };
}

function validateReverseJobState(value) {
  const state = readTag(value, 'state');
  const fields = readExactObject(value, ['state', 'identitySha256']);
  if (state === 'stopped') {
    if (fields.identitySha256 !== null) invalid();
    return { state: 'stopped', identitySha256: null };
  }
  if (state !== 'loaded') invalid();
  return {
    state: 'loaded',
    identitySha256: requireSha256(fields.identitySha256),
  };
}

function validateReverseExpected(value, role) {
  const fields = readExactObject(value, ['file', 'job']);
  return {
    file: validateReverseFileState(fields.file, role),
    job: validateReverseJobState(fields.job),
  };
}

function validateReverseEvidence(value, role) {
  const kind = readTag(value, 'kind');
  if (kind === 'candidate') {
    const fields = readExactObject(value, [
      'kind', 'transactionId', 'role', 'sha256',
    ]);
    return {
      kind: 'candidate',
      transactionId: requireUuid(fields.transactionId),
      role: requireLiteral(fields.role, role),
      sha256: requireSha256(fields.sha256),
    };
  }
  if (kind !== 'anchor') invalid();
  const fields = readExactObject(value, [
    'kind', 'anchorId', 'role', 'sha256', 'loaded',
  ]);
  return {
    kind: 'anchor',
    anchorId: requireUuid(fields.anchorId),
    role: requireLiteral(fields.role, role),
    sha256: requireSha256(fields.sha256),
    loaded: requireBoolean(fields.loaded),
  };
}

function validateReverseStep(value, expectedIndex) {
  const fields = readExactObject(value, [
    'index', 'action', 'role', 'expectedPre', 'expectedPost', 'evidence',
  ]);
  const index = requireInteger(fields.index);
  if (index !== expectedIndex) invalid();
  const action = requireEnum(fields.action, COMPENSATION_ACTIONS);
  const role = requireLiteral(fields.role, compensationRole(action));
  const expectedPre = validateReverseExpected(fields.expectedPre, role);
  const expectedPost = validateReverseExpected(fields.expectedPost, role);
  const evidence = validateReverseEvidence(fields.evidence, role);
  const evidenceState = evidence.kind === 'candidate' ? expectedPre.file : expectedPost.file;
  if (evidenceState.state !== 'present' || evidenceState.sha256 !== evidence.sha256) invalid();
  return { index, action, role, expectedPre, expectedPost, evidence };
}

function validateReversePlan(value) {
  if (!Array.isArray(value) || value.length > 7) invalid();
  const plan = value.map((step, index) => validateReverseStep(step, index));
  let priorRank = -1;
  for (const step of plan) {
    const rank = COMPENSATION_ACTION_ORDER.get(step.action);
    if (rank === undefined || rank <= priorRank) invalid();
    priorRank = rank;
  }
  return plan;
}

/** state-specific exact payload projection；不在 validator 内重算 entry hash。 */
function validateJournalPayload(state, value) {
  const allowedRoles = CHECKPOINT_ROLES.get(state);
  if (allowedRoles !== undefined) {
    const fields = readExactObject(value, ['hostMutationCount', 'role']);
    return {
      hostMutationCount: requireInteger(fields.hostMutationCount),
      role: requireEnum(fields.role, allowedRoles),
    };
  }
  const compensationAction = COMPENSATION_STATE_ACTION.get(state);
  if (compensationAction !== undefined) {
    const phase = state.endsWith('-intent') ? 'intent' : 'completed';
    const fields = readExactObject(
      value,
      phase === 'intent'
        ? ['hostMutationCount', 'action', 'planIndex', 'reversePlanSha256']
        : ['hostMutationCount', 'action'],
    );
    const payload = {
      hostMutationCount: requireInteger(fields.hostMutationCount),
      action: requireLiteral(fields.action, compensationAction),
    };
    if (phase === 'intent') {
      payload.planIndex = requireInteger(fields.planIndex);
      payload.reversePlanSha256 = requireSha256(fields.reversePlanSha256);
    }
    return payload;
  }
  if (state === 'compensating') {
    const fields = readExactObject(value, [
      'hostMutationCount', 'reversePlan', 'reversePlanSha256',
    ]);
    const reversePlan = validateReversePlan(fields.reversePlan);
    const reversePlanSha256 = requireSha256(fields.reversePlanSha256);
    const calculated = createHash('sha256')
      .update(Buffer.from(JSON.stringify(reversePlan), 'utf8'))
      .digest('hex');
    if (calculated !== reversePlanSha256) invalid();
    return {
      hostMutationCount: requireInteger(fields.hostMutationCount),
      reversePlan,
      reversePlanSha256,
    };
  }
  if (
    state === 'prepared'
    || state === 'anchored'
    || state === 'published'
    || state === 'controller-loaded'
    || state === 'controller-ready'
    || state === 'scheduler-loaded'
    || state === 'manual-intervention-required'
  ) {
    const fields = readExactObject(value, ['hostMutationCount']);
    return { hostMutationCount: requireInteger(fields.hostMutationCount) };
  }
  if (state === 'committed' || state === 'recovered' || state === 'no-change') {
    const fields = readExactObject(value, ['hostMutationCount', 'receiptSha256']);
    return {
      hostMutationCount: requireInteger(fields.hostMutationCount),
      receiptSha256: requireSha256(fields.receiptSha256),
    };
  }
  if (state === 'blocked') {
    const fields = readExactObject(value, [
      'hostMutationCount',
      'receiptSha256',
      'blockedByEntrySha256',
    ]);
    return {
      hostMutationCount: requireInteger(fields.hostMutationCount),
      receiptSha256: requireSha256(fields.receiptSha256),
      blockedByEntrySha256: requireSha256OrNull(fields.blockedByEntrySha256),
    };
  }
  invalid();
}

function journalProjection(value) {
  const fields = readExactObject(value, [
    'schemaVersion',
    'transactionId',
    'sequence',
    'previousEntrySha256',
    'entrySha256',
    'operation',
    'state',
    'at',
    'payload',
  ]);
  const sequence = requireInteger(fields.sequence);
  const previousEntrySha256 = fields.previousEntrySha256 === null
    ? null
    : requireSha256(fields.previousEntrySha256);
  if ((sequence === 0) !== (previousEntrySha256 === null)) invalid();
  // 先验证 state，再按 state 投影 payload（existing prepared 行为不回归）。
  const state = requireEnum(fields.state, JOURNAL_STATES);
  return {
    schemaVersion: requireLiteral(fields.schemaVersion, 1),
    transactionId: requireUuid(fields.transactionId),
    sequence,
    previousEntrySha256,
    entrySha256: requireSha256(fields.entrySha256),
    operation: requireEnum(fields.operation, JOURNAL_OPERATIONS),
    state,
    at: requireUtc(fields.at),
    payload: validateJournalPayload(state, fields.payload),
  };
}

/** 校验并投影严格闭合的 journal 条目。 */
export function validateLaunchAgentJournal(value) {
  return project(journalProjection, value);
}

const RECEIPT_STATES = new Set([
  'committed',
  'recovered',
  'no-change',
  'blocked',
  'manual-intervention-required',
]);
const ROLE_OUTCOMES = new Set([
  'unchanged',
  'created',
  'updated',
  'removed',
  'loaded',
  'unloaded',
  'restored',
]);
const RECEIPT_OUTCOMES = new Set([
  'completed',
  'no-change',
  'ownership-mismatch',
  'label-in-use',
  'conditional-mutation-unsupported',
  'conditional-mutation-mismatch',
  'transaction-in-progress',
  'recovery-required',
  'manual-intervention-required',
  'controller-not-ready',
  'scheduler-load-failed',
  'rollback-runtime-mismatch',
  'rollback-unload-incomplete',
  'stop-incomplete',
  'uninstall-unload-incomplete',
]);
const RECEIPT_STATE_OUTCOMES = new Map([
  ['committed', { success: true, outcomes: new Set(['completed']) }],
  ['no-change', { success: true, outcomes: new Set(['no-change']) }],
  ['blocked', {
    success: false,
    outcomes: new Set([
      'ownership-mismatch',
      'label-in-use',
      'conditional-mutation-unsupported',
      'conditional-mutation-mismatch',
      'transaction-in-progress',
      'recovery-required',
      'controller-not-ready',
      'scheduler-load-failed',
      'rollback-runtime-mismatch',
    ]),
  }],
  ['recovered', {
    success: false,
    outcomes: new Set([
      'conditional-mutation-unsupported',
      'conditional-mutation-mismatch',
      'controller-not-ready',
      'scheduler-load-failed',
      'rollback-runtime-mismatch',
      'rollback-unload-incomplete',
      'stop-incomplete',
      'uninstall-unload-incomplete',
    ]),
  }],
  ['manual-intervention-required', {
    success: false,
    outcomes: new Set(['manual-intervention-required']),
  }],
]);

function validateReceiptRole(value, role) {
  const fields = readExactObject(value, ['label', 'outcome', 'changed']);
  return {
    label: requireLiteral(fields.label, LAUNCHAGENT_LIFECYCLE.labels[role]),
    outcome: requireEnum(fields.outcome, ROLE_OUTCOMES),
    changed: requireBoolean(fields.changed),
  };
}

function receiptProjection(value) {
  const fields = readExactObject(value, [
    'schemaVersion',
    'operation',
    'state',
    'success',
    'sourceCommit',
    'transactionId',
    'anchorId',
    'completedAt',
    'roles',
    'hostMutationCount',
    'outcome',
  ]);
  const roles = readExactObject(fields.roles, ['controller', 'scheduler']);
  const operation = requireEnum(fields.operation, JOURNAL_OPERATIONS);
  const state = requireEnum(fields.state, RECEIPT_STATES);
  const success = requireBoolean(fields.success);
  const hostMutationCount = requireInteger(fields.hostMutationCount);
  const outcome = requireEnum(fields.outcome, RECEIPT_OUTCOMES);
  const mapping = RECEIPT_STATE_OUTCOMES.get(state);
  const recoveredCompletion = operation === 'recover'
    && state === 'recovered'
    && success === true
    && outcome === 'completed';
  if (
    mapping === undefined
    || (
      !recoveredCompletion
      && (success !== mapping.success || !mapping.outcomes.has(outcome))
    )
    || (state === 'no-change' && hostMutationCount !== 0)
  ) {
    invalid();
  }
  return {
    schemaVersion: requireLiteral(fields.schemaVersion, 1),
    operation,
    state,
    success,
    sourceCommit: requireCommit(fields.sourceCommit),
    transactionId: requireUuid(fields.transactionId),
    anchorId: requireUuid(fields.anchorId),
    completedAt: requireUtc(fields.completedAt),
    roles: {
      controller: validateReceiptRole(roles.controller, 'controller'),
      scheduler: validateReceiptRole(roles.scheduler, 'scheduler'),
    },
    hostMutationCount,
    outcome,
  };
}

/** 校验并投影不含宿主原始输出的闭合操作回执。 */
export function validateLaunchAgentReceipt(value) {
  return project(receiptProjection, value);
}

function journalEntrySha256(entry) {
  return createHash('sha256').update(Buffer.from(JSON.stringify({
    schemaVersion: entry.schemaVersion,
    transactionId: entry.transactionId,
    sequence: entry.sequence,
    previousEntrySha256: entry.previousEntrySha256,
    operation: entry.operation,
    state: entry.state,
    at: entry.at,
    payload: entry.payload,
  }), 'utf8')).digest('hex');
}

function checkpointRole(entry, role) {
  return entry.payload.role === role;
}

function isExactForwardTransition(operation, prior, entry) {
  const from = prior.state;
  const to = entry.state;
  if (operation === 'install') {
    if (from === 'prepared') return to === 'anchored';
    if (from === 'anchored') {
      return (to === 'controller-publish-intent' && checkpointRole(entry, 'controller'))
        || (to === 'scheduler-stop-intent' && checkpointRole(entry, 'scheduler'))
        || (to === 'role-stop-noop' && checkpointRole(entry, 'scheduler'))
        || (to === 'role-noop' && checkpointRole(entry, 'controller'));
    }
    if (from === 'controller-publish-intent') return to === 'controller-published';
    if (from === 'controller-published') {
      return to === 'scheduler-publish-intent' && checkpointRole(entry, 'scheduler');
    }
    if (from === 'scheduler-publish-intent') return to === 'scheduler-published';
    if (from === 'scheduler-published') {
      return to === 'manifest-publish-intent' && checkpointRole(entry, 'manifest');
    }
    if (from === 'manifest-publish-intent') return to === 'manifest-published';
    if (from === 'manifest-published') {
      return to === 'controller-load-intent' && checkpointRole(entry, 'controller');
    }
    if (from === 'controller-load-intent') return to === 'controller-loaded';
    if (from === 'controller-loaded') return to === 'controller-ready';
    if (from === 'controller-ready') {
      return to === 'scheduler-load-intent' && checkpointRole(entry, 'scheduler');
    }
    if (from === 'scheduler-load-intent') return to === 'scheduler-loaded';
    return isExactForwardTransition('managed-upgrade', prior, entry);
  }

  if (operation === 'managed-upgrade') {
    if (from === 'prepared') return to === 'anchored';
    if (from === 'anchored') {
      return (to === 'scheduler-stop-intent' && checkpointRole(entry, 'scheduler'))
        || (to === 'role-stop-noop' && checkpointRole(entry, 'scheduler'))
        || (to === 'role-noop' && checkpointRole(entry, 'controller'));
    }
    if (from === 'scheduler-stop-intent') return to === 'scheduler-stopped';
    if (
      from === 'scheduler-stopped'
      || (from === 'role-stop-noop' && checkpointRole(prior, 'scheduler'))
    ) {
      return (to === 'controller-stop-intent' && checkpointRole(entry, 'controller'))
        || (to === 'role-stop-noop' && checkpointRole(entry, 'controller'));
    }
    if (from === 'controller-stop-intent') return to === 'controller-stopped';
    if (
      from === 'controller-stopped'
      || (from === 'role-stop-noop' && checkpointRole(prior, 'controller'))
    ) {
      return (to === 'controller-publish-intent' && checkpointRole(entry, 'controller'))
        || (to === 'role-noop' && checkpointRole(entry, 'controller'));
    }
    if (from === 'controller-publish-intent') return to === 'controller-published';
    if (
      from === 'controller-published'
      || (from === 'role-noop' && checkpointRole(prior, 'controller'))
    ) {
      return (to === 'scheduler-publish-intent' && checkpointRole(entry, 'scheduler'))
        || (to === 'role-noop' && checkpointRole(entry, 'scheduler'));
    }
    if (from === 'scheduler-publish-intent') return to === 'scheduler-published';
    if (
      from === 'scheduler-published'
      || (from === 'role-noop' && checkpointRole(prior, 'scheduler'))
    ) {
      return to === 'manifest-publish-intent' && checkpointRole(entry, 'manifest');
    }
    if (from === 'manifest-publish-intent') return to === 'manifest-published';
    if (from === 'manifest-published') {
      return to === 'controller-load-intent' && checkpointRole(entry, 'controller');
    }
    if (from === 'controller-load-intent') return to === 'controller-loaded';
    if (from === 'controller-loaded') return to === 'controller-ready';
    if (from === 'controller-ready') {
      return to === 'scheduler-load-intent' && checkpointRole(entry, 'scheduler');
    }
    if (from === 'scheduler-load-intent') return to === 'scheduler-loaded';
    return false;
  }

  if (operation === 'stop') {
    if (from === 'prepared') return to === 'anchored';
    if (from === 'anchored') {
      return (to === 'scheduler-stop-intent' && checkpointRole(entry, 'scheduler'))
        || (to === 'role-stop-noop' && checkpointRole(entry, 'scheduler'));
    }
    if (from === 'scheduler-stop-intent') return to === 'scheduler-stopped';
    if (
      from === 'scheduler-stopped'
      || (from === 'role-stop-noop' && checkpointRole(prior, 'scheduler'))
    ) {
      return (to === 'controller-stop-intent' && checkpointRole(entry, 'controller'))
        || (to === 'role-stop-noop' && checkpointRole(entry, 'controller'));
    }
    if (from === 'controller-stop-intent') return to === 'controller-stopped';
    return false;
  }
  if (operation === 'rollback') {
    if (from === 'prepared') return to === 'anchored';
    if (from === 'anchored') {
      return (to === 'scheduler-stop-intent' && checkpointRole(entry, 'scheduler'))
        || (to === 'role-stop-noop' && checkpointRole(entry, 'scheduler'));
    }
    if (from === 'scheduler-stop-intent') return to === 'scheduler-stopped';
    if (
      from === 'scheduler-stopped'
      || (from === 'role-stop-noop' && checkpointRole(prior, 'scheduler'))
    ) {
      return (to === 'controller-stop-intent' && checkpointRole(entry, 'controller'))
        || (to === 'role-stop-noop' && checkpointRole(entry, 'controller'));
    }
    if (from === 'controller-stop-intent') return to === 'controller-stopped';
    if (
      from === 'controller-stopped'
      || (from === 'role-stop-noop' && checkpointRole(prior, 'controller'))
    ) {
      return (to === 'controller-publish-intent' && checkpointRole(entry, 'controller'))
        || (to === 'controller-remove-intent' && checkpointRole(entry, 'controller'))
        || (to === 'role-noop' && checkpointRole(entry, 'controller'));
    }
    if (from === 'controller-publish-intent') return to === 'controller-published';
    if (from === 'controller-remove-intent') return to === 'controller-removed';
    if (
      from === 'controller-published'
      || from === 'controller-removed'
      || (from === 'role-noop' && checkpointRole(prior, 'controller'))
    ) {
      return (to === 'scheduler-publish-intent' && checkpointRole(entry, 'scheduler'))
        || (to === 'scheduler-remove-intent' && checkpointRole(entry, 'scheduler'))
        || (to === 'role-noop' && checkpointRole(entry, 'scheduler'));
    }
    if (from === 'scheduler-publish-intent') return to === 'scheduler-published';
    if (from === 'scheduler-remove-intent') return to === 'scheduler-removed';
    if (
      from === 'scheduler-published'
      || from === 'scheduler-removed'
      || (from === 'role-noop' && checkpointRole(prior, 'scheduler'))
    ) {
      return (to === 'manifest-publish-intent' && checkpointRole(entry, 'manifest'))
        || (to === 'manifest-remove-intent' && checkpointRole(entry, 'manifest'));
    }
    if (from === 'manifest-publish-intent') return to === 'manifest-published';
    if (from === 'manifest-remove-intent') return to === 'manifest-removed';
    if (from === 'manifest-published') {
      return (to === 'controller-load-intent' && checkpointRole(entry, 'controller'))
        || (to === 'role-load-noop' && checkpointRole(entry, 'controller'));
    }
    if (from === 'controller-load-intent') return to === 'controller-loaded';
    if (from === 'controller-loaded') return to === 'controller-ready';
    if (
      from === 'controller-ready'
      || (from === 'role-load-noop' && checkpointRole(prior, 'controller'))
    ) {
      return (to === 'scheduler-load-intent' && checkpointRole(entry, 'scheduler'))
        || (to === 'role-load-noop' && checkpointRole(entry, 'scheduler'));
    }
    if (from === 'scheduler-load-intent') return to === 'scheduler-loaded';
    return false;
  }
  if (operation === 'uninstall') {
    if (from === 'prepared') return to === 'anchored';
    if (from === 'anchored') {
      return (to === 'scheduler-stop-intent' && checkpointRole(entry, 'scheduler'))
        || (to === 'role-stop-noop' && checkpointRole(entry, 'scheduler'));
    }
    if (from === 'scheduler-stop-intent') return to === 'scheduler-stopped';
    if (
      from === 'scheduler-stopped'
      || (from === 'role-stop-noop' && checkpointRole(prior, 'scheduler'))
    ) {
      return (to === 'controller-stop-intent' && checkpointRole(entry, 'controller'))
        || (to === 'role-stop-noop' && checkpointRole(entry, 'controller'));
    }
    if (from === 'controller-stop-intent') return to === 'controller-stopped';
    if (
      from === 'controller-stopped'
      || (from === 'role-stop-noop' && checkpointRole(prior, 'controller'))
    ) {
      return to === 'scheduler-remove-intent' && checkpointRole(entry, 'scheduler');
    }
    if (from === 'scheduler-remove-intent') return to === 'scheduler-removed';
    if (from === 'scheduler-removed') {
      return to === 'controller-remove-intent' && checkpointRole(entry, 'controller');
    }
    if (from === 'controller-remove-intent') return to === 'controller-removed';
    if (from === 'controller-removed') {
      return to === 'manifest-remove-intent' && checkpointRole(entry, 'manifest');
    }
    if (from === 'manifest-remove-intent') return to === 'manifest-removed';
    return false;
  }
  return false;
}

function isValidTerminalTransition(operation, prior, entry) {
  if (entry.state === 'blocked') {
    return prior.payload.hostMutationCount === 0 && entry.payload.hostMutationCount === 0;
  }
  if (entry.state === 'no-change') {
    return (operation === 'install' || operation === 'managed-upgrade')
      && prior.state === 'prepared'
      && prior.payload.hostMutationCount === 0
      && entry.payload.hostMutationCount === 0;
  }
  if (entry.state === 'committed') {
    if (operation === 'install') {
      return prior.state === 'scheduler-loaded' || prior.state === 'manifest-published';
    }
    if (operation === 'managed-upgrade') {
      return prior.state === 'scheduler-loaded' || prior.state === 'manifest-published';
    }
    if (operation === 'stop') {
      return prior.state === 'controller-stopped'
        || (prior.state === 'role-stop-noop' && checkpointRole(prior, 'controller'));
    }
    if (operation === 'rollback') {
      return prior.state === 'scheduler-loaded'
        || (prior.state === 'role-load-noop' && checkpointRole(prior, 'scheduler'))
        || prior.state === 'manifest-removed';
    }
    if (operation === 'uninstall') return prior.state === 'manifest-removed';
  }
  if (entry.state === 'recovered' && operation === 'stop') {
    return prior.state === 'scheduler-stop-intent' || prior.state === 'controller-stop-intent';
  }
  if (entry.state === 'recovered' && (operation === 'rollback' || operation === 'uninstall')) {
    return prior.state === 'anchored'
      || prior.state === 'scheduler-stop-intent'
      || prior.state === 'controller-stop-intent';
  }
  return false;
}

function transactionCloseoutProjection(value) {
  const fields = readExactObject(value, ['entries', 'receipt']);
  if (!Array.isArray(fields.entries) || fields.entries.length === 0 || fields.entries.length > 4096) {
    invalid();
  }
  const entries = [];
  let prior = null;
  let transactionId = null;
  let operation = null;
  let compensation = null;
  for (const rawEntry of fields.entries) {
    const entry = journalProjection(rawEntry);
    if (journalEntrySha256(entry) !== entry.entrySha256) invalid();
    if (prior === null) {
      if (entry.sequence !== 0 || entry.previousEntrySha256 !== null) invalid();
      transactionId = entry.transactionId;
      operation = entry.operation;
    } else {
      if (entry.transactionId !== transactionId) invalid();
      if (entry.operation !== operation) invalid();
      if (entry.sequence !== prior.sequence + 1) invalid();
      if (entry.previousEntrySha256 !== prior.entrySha256) invalid();
      if (entry.payload.hostMutationCount < prior.payload.hostMutationCount) invalid();

      const action = COMPENSATION_STATE_ACTION.get(entry.state);
      if (prior.state === 'compensating') {
        compensation = {
          plan: prior.payload.reversePlan,
          digest: prior.payload.reversePlanSha256,
          nextIndex: 0,
          awaitingCompletion: false,
        };
      }
      if (action !== undefined) {
        if (compensation === null) invalid();
        const expectedStep = compensation.plan[compensation.nextIndex];
        if (entry.state.endsWith('-intent')) {
          if (compensation.awaitingCompletion || expectedStep === undefined) invalid();
          if (
            action !== expectedStep.action
            || entry.payload.action !== expectedStep.action
            || entry.payload.planIndex !== expectedStep.index
            || entry.payload.reversePlanSha256 !== compensation.digest
          ) {
            invalid();
          }
          compensation.awaitingCompletion = true;
        } else {
          if (!compensation.awaitingCompletion || expectedStep === undefined) invalid();
          if (action !== expectedStep.action || entry.payload.action !== expectedStep.action) invalid();
          compensation.awaitingCompletion = false;
          compensation.nextIndex += 1;
        }
      } else if (entry.state === 'compensating') {
        if (compensation !== null || entry.payload.hostMutationCount === 0) invalid();
      } else if (entry.state === 'recovered' && compensation !== null) {
        if (
          compensation.awaitingCompletion
          || compensation.nextIndex !== compensation.plan.length
        ) {
          invalid();
        }
      } else if (
        entry.state === 'manual-intervention-required'
        && compensation !== null
      ) {
        // intent/precheck/action 任一点失败均只能进入 MIR，不能再推进 reverse plan。
      } else if (isValidTerminalTransition(operation, prior, entry)) {
        // terminal transition 已按 operation 与精确 prior state 验证。
      } else if (!isExactForwardTransition(operation, prior, entry)) {
        invalid();
      }
    }
    if (
      prior === null
      && (entry.state !== 'prepared' || entry.payload.hostMutationCount !== 0)
    ) {
      invalid();
    }
    entries.push(entry);
    prior = entry;
  }

  const receipt = receiptProjection(fields.receipt);
  if (receipt.transactionId !== transactionId) invalid();
  if (receipt.operation !== operation) invalid();
  if (receipt.state !== prior.state) invalid();
  if (receipt.hostMutationCount !== prior.payload.hostMutationCount) invalid();
  if (!Object.hasOwn(prior.payload, 'receiptSha256')) invalid();
  const receiptSha256 = createHash('sha256')
    .update(Buffer.from(JSON.stringify(receipt), 'utf8'))
    .digest('hex');
  if (prior.payload.receiptSha256 !== receiptSha256) invalid();
  return { entries, receipt };
}

/** 校验完整 journal 链与 terminal receipt 的 transaction/operation/hash 对齐。 */
export function validateLaunchAgentTransactionCloseout(value) {
  return project(transactionCloseoutProjection, value);
}

function acceptanceRequestProjection(value) {
  const kind = readTag(value, 'kind');
  if (kind === 'non-production-acceptance-request') {
    const fields = readExactObject(value, [
      'schemaVersion',
      'kind',
      'acceptanceId',
      'uid',
      'launchAgentsRootId',
      'launchAgentsRootSha256',
      'sourceCommit',
      'runtimeArtifactsSha256',
      'executeRequested',
      'nonProductionConfirmed',
      'preparedAt',
    ]);
    return {
      schemaVersion: requireLiteral(fields.schemaVersion, 1),
      kind: requireLiteral(fields.kind, 'non-production-acceptance-request'),
      acceptanceId: requireUuid(fields.acceptanceId),
      uid: requireInteger(fields.uid),
      launchAgentsRootId: requireLiteral(
        fields.launchAgentsRootId,
        LAUNCHAGENT_LIFECYCLE.rootIds.launchAgents,
      ),
      launchAgentsRootSha256: requireSha256(fields.launchAgentsRootSha256),
      sourceCommit: requireCommit(fields.sourceCommit),
      runtimeArtifactsSha256: requireSha256(fields.runtimeArtifactsSha256),
      executeRequested: requireLiteral(fields.executeRequested, false),
      nonProductionConfirmed: requireLiteral(fields.nonProductionConfirmed, false),
      preparedAt: requireUtc(fields.preparedAt),
    };
  }
  if (kind !== 'manual-repair-request') invalid();
  const fields = readExactObject(value, [
    'schemaVersion',
    'kind',
    'manualRepairRequestId',
    'transactionId',
    'mirLockSha256',
    'anchorSha256',
    'repairDeclarationSha256',
    'executeRequested',
    'manualRepairConfirmed',
    'preparedAt',
  ]);
  return {
    schemaVersion: requireLiteral(fields.schemaVersion, 1),
    kind: requireLiteral(fields.kind, 'manual-repair-request'),
    manualRepairRequestId: requireUuid(fields.manualRepairRequestId),
    transactionId: requireUuid(fields.transactionId),
    mirLockSha256: requireSha256(fields.mirLockSha256),
    anchorSha256: requireSha256(fields.anchorSha256),
    repairDeclarationSha256: requireSha256(fields.repairDeclarationSha256),
    executeRequested: requireLiteral(fields.executeRequested, false),
    manualRepairConfirmed: requireLiteral(fields.manualRepairConfirmed, false),
    preparedAt: requireUtc(fields.preparedAt),
  };
}

/** 校验并投影非生产验收或人工修复的只读准备请求。 */
export function validateLaunchAgentAcceptanceRequest(value) {
  return project(acceptanceRequestProjection, value);
}

function confirmationProjection(value) {
  const kind = readTag(value, 'kind');
  if (kind === 'non-production-confirmation') {
    const fields = readExactObject(value, [
      'schemaVersion',
      'kind',
      'confirmationId',
      'acceptanceId',
      'confirmed',
      'confirmedAt',
    ]);
    return {
      schemaVersion: requireLiteral(fields.schemaVersion, 1),
      kind: requireLiteral(fields.kind, 'non-production-confirmation'),
      confirmationId: requireUuid(fields.confirmationId),
      acceptanceId: requireUuid(fields.acceptanceId),
      confirmed: requireLiteral(fields.confirmed, true),
      confirmedAt: requireUtc(fields.confirmedAt),
    };
  }
  if (kind !== 'manual-repair-confirmation') invalid();
  const fields = readExactObject(value, [
    'schemaVersion',
    'kind',
    'confirmationId',
    'manualRepairRequestId',
    'confirmed',
    'confirmedAt',
  ]);
  return {
    schemaVersion: requireLiteral(fields.schemaVersion, 1),
    kind: requireLiteral(fields.kind, 'manual-repair-confirmation'),
    confirmationId: requireUuid(fields.confirmationId),
    manualRepairRequestId: requireUuid(fields.manualRepairRequestId),
    confirmed: requireLiteral(fields.confirmed, true),
    confirmedAt: requireUtc(fields.confirmedAt),
  };
}

/** 校验并投影一次性非生产验收或人工修复确认。 */
export function validateLaunchAgentConfirmationRecord(value) {
  return project(confirmationProjection, value);
}

function consumedConfirmationProjection(value) {
  const fields = readExactObject(value, [
    'schemaVersion',
    'confirmationId',
    'acceptanceId',
    'sourceCommit',
    'runtimeArtifactsSha256',
    'consumedAt',
  ]);
  const confirmationId = requireUuid(fields.confirmationId);
  const acceptanceId = requireUuid(fields.acceptanceId);
  if (confirmationId === acceptanceId) invalid();
  return {
    schemaVersion: requireLiteral(fields.schemaVersion, 1),
    confirmationId,
    acceptanceId,
    sourceCommit: requireCommit(fields.sourceCommit),
    runtimeArtifactsSha256: requireSha256(fields.runtimeArtifactsSha256),
    consumedAt: requireUtc(fields.consumedAt),
  };
}

/** 校验并投影持久化的一次性确认消费记录。 */
export function validateLaunchAgentConsumedConfirmation(value) {
  return project(consumedConfirmationProjection, value);
}

function capabilityProjection(value) {
  const fields = readExactObject(value, [
    'schemaVersion',
    'acceptanceId',
    'confirmationId',
    'executeAuthorized',
    'sourceCommit',
    'runtimeArtifactsSha256',
    'issuedAt',
  ]);
  return {
    schemaVersion: requireLiteral(fields.schemaVersion, 1),
    acceptanceId: requireUuid(fields.acceptanceId),
    confirmationId: requireUuid(fields.confirmationId),
    executeAuthorized: requireBoolean(fields.executeAuthorized),
    sourceCommit: requireCommit(fields.sourceCommit),
    runtimeArtifactsSha256: requireSha256(fields.runtimeArtifactsSha256),
    issuedAt: requireUtc(fields.issuedAt),
  };
}

/** 校验并投影不含模块私有授权 brand 的能力摘要。 */
export function validateLaunchAgentCapabilityProjection(value) {
  return project(capabilityProjection, value);
}
