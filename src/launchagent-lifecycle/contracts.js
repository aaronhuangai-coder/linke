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

/** 对外仅暴露固定名称、错误码与消息的生命周期契约错误。 */
export class LaunchAgentLifecycleError extends Error {
  constructor() {
    super(INVALID_CODE);
    this.name = 'LaunchAgentLifecycleError';
    this.code = INVALID_CODE;
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
]);

function validateJournalPayload(value) {
  const fields = readExactObject(value, ['hostMutationCount']);
  return { hostMutationCount: requireInteger(fields.hostMutationCount) };
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
  return {
    schemaVersion: requireLiteral(fields.schemaVersion, 1),
    transactionId: requireUuid(fields.transactionId),
    sequence,
    previousEntrySha256,
    entrySha256: requireSha256(fields.entrySha256),
    operation: requireEnum(fields.operation, JOURNAL_OPERATIONS),
    state: requireEnum(fields.state, JOURNAL_STATES),
    at: requireUtc(fields.at),
    payload: validateJournalPayload(fields.payload),
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
  return {
    schemaVersion: requireLiteral(fields.schemaVersion, 1),
    operation: requireEnum(fields.operation, JOURNAL_OPERATIONS),
    state: requireEnum(fields.state, RECEIPT_STATES),
    success: requireBoolean(fields.success),
    sourceCommit: requireCommit(fields.sourceCommit),
    transactionId: requireUuid(fields.transactionId),
    anchorId: requireUuid(fields.anchorId),
    completedAt: requireUtc(fields.completedAt),
    roles: {
      controller: validateReceiptRole(roles.controller, 'controller'),
      scheduler: validateReceiptRole(roles.scheduler, 'scheduler'),
    },
    hostMutationCount: requireInteger(fields.hostMutationCount),
    outcome: requireEnum(fields.outcome, RECEIPT_OUTCOMES),
  };
}

/** 校验并投影不含宿主原始输出的闭合操作回执。 */
export function validateLaunchAgentReceipt(value) {
  return project(receiptProjection, value);
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
