/**
 * LaunchAgent 生命周期验收门（V1.46 Task 6A Task 3）。
 *
 * 边界：
 * - 纯 prepare 与 consume-before-mint 授权；不触碰 fs / launchctl / coordinator / 网络。
 * - 耐久消费仅通过调用方注入的 metadataStore 两方法面：
 *   `{ consumeConfirmation, readConsumedConfirmation }`（精确键集合，无第三方法/brand/provenance）。
 * - metadataStore 是宿主注入的可信内部依赖：本模块校验方法存在与可调用形态，并处理
 *   缺失/畸形方法、方法抛错、消费后缺失或读回不一致等失效实现；
 *   不把「两方法恶意串通并伪造耐久性」视为本边界可识别的攻击者。
 * - 人工能力以模块私有 WeakMap 绑定对象身份；公开投影不含 confirmationId 或 lock refs。
 * - 禁用 facade 对全部条件变异入口立即 conditional-mutation-unsupported，零依赖探测。
 */

import { types as utilTypes } from 'node:util';

import {
  LAUNCHAGENT_LIFECYCLE_CODES,
  LaunchAgentLifecycleError,
  validateLaunchAgentAcceptanceRequest,
  validateLaunchAgentCapabilityProjection,
  validateLaunchAgentConfirmationRecord,
  validateLaunchAgentConsumedConfirmation,
} from './contracts.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** 非生产能力私有 brand（本波未对外消费，仅隔离命名空间）。 */
const nonProductionAuthorityByCapability = new WeakMap();
/** 人工修复能力私有 brand：capability 对象身份 → 冻结 authority。 */
const manualRepairAuthorityByCapability = new WeakMap();

const DISABLED_METHODS = Object.freeze([
  'install',
  'managedUpgrade',
  'stop',
  'rollback',
  'uninstall',
  'recover',
  'recoverAfterManualRepair',
]);

function invalid() {
  throw new LaunchAgentLifecycleError();
}

function denied() {
  throw new LaunchAgentLifecycleError(LAUNCHAGENT_LIFECYCLE_CODES.ACCEPTANCE_GATE_DENIED);
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) {
      deepFreeze(descriptor.value);
    }
  }
  return Object.freeze(value);
}

/**
 * 精确 plain object 读取：仅允许 expectedKeys，且为可枚举数据属性。
 * accessor / Proxy / 额外键 → fail-closed，不执行 getter。
 */
function readExactObject(value, expectedKeys) {
  if (value === null || typeof value !== 'object') invalid();
  if (utilTypes.isProxy(value)) invalid();
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
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      invalid();
    }
    fields[key] = descriptor.value;
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(fields, key)) invalid();
  }
  return fields;
}

/**
 * 请求/确认等契约载体：拒绝 Proxy 与非 plain object，再交公共 validator。
 * 必须先 isProxy（不触发任何 trap），再做原型检查，保证敌意 Proxy counter 保持 0。
 */
function requirePlainContractObject(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) invalid();
  // 先于 getPrototypeOf / ownKeys / getOwnPropertyDescriptor，避免触发 Proxy trap
  if (utilTypes.isProxy(value)) invalid();
  if (typeof value !== 'object') invalid();
  if (Object.getPrototypeOf(value) !== Object.prototype) invalid();
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

function requireUtc(value) {
  if (typeof value !== 'string' || !UTC_PATTERN.test(value)) invalid();
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime()) || instant.toISOString() !== value) invalid();
  return value;
}

function requireInteger(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) invalid();
  return value;
}

function requireFunction(value) {
  if (typeof value !== 'function') invalid();
  return value;
}

/** 规范化非生命周期异常为 INVALID；保留 LaunchAgentLifecycleError（含 confirmation-consumed）。 */
function rethrowLifecycle(error) {
  if (error instanceof LaunchAgentLifecycleError) throw error;
  invalid();
}

/**
 * 授权入口依赖袋：exact keys + store 方法形态 + clock.now 函数 + readCurrentFacts 函数。
 * 畸形依赖 → INVALID（在任何 facts/consume 之前）。
 *
 * metadataStore 可信边界（人类裁决 A）：
 * - 精确接口 `{ consumeConfirmation, readConsumedConfirmation }`，由宿主注入。
 * - 本函数只做 exact 键与 typeof function 形态闸；不引入 brand/provenance/第三方法。
 * - 可识别失效：缺键、非函数、后续调用抛错、读回缺失/不一致。
 * - 两方法串通伪造耐久性不在本边界对抗模型内。
 */
function readAuthorizeDependencies(input) {
  const fields = readExactObject(input, [
    'request',
    'confirmation',
    'metadataStore',
    'readCurrentFacts',
    'clock',
  ]);
  // 可信内部依赖：仅校验 exact 两方法键 + 可调用；不探测 store 实现真实性。
  const storeFields = readExactObject(fields.metadataStore, [
    'consumeConfirmation',
    'readConsumedConfirmation',
  ]);
  requireFunction(storeFields.consumeConfirmation);
  requireFunction(storeFields.readConsumedConfirmation);
  const clockFields = readExactObject(fields.clock, ['now']);
  requireFunction(clockFields.now);
  requireFunction(fields.readCurrentFacts);
  return {
    request: fields.request,
    confirmation: fields.confirmation,
    consumeConfirmation: storeFields.consumeConfirmation.bind(fields.metadataStore),
    readConsumedConfirmation: storeFields.readConsumedConfirmation.bind(fields.metadataStore),
    readCurrentFacts: fields.readCurrentFacts,
    now: clockFields.now.bind(fields.clock),
  };
}

function equalPrimitive(left, right) {
  return left === right;
}

function equalLockRef(left, right) {
  if (left === null && right === null) return true;
  if (left === null || right === null) return false;
  return (
    equalPrimitive(left.kind, right.kind)
    && equalPrimitive(left.transactionId, right.transactionId)
    && equalPrimitive(left.ownerNonce, right.ownerNonce)
    && equalPrimitive(left.sha256, right.sha256)
  );
}

function equalNonProductionFacts(left, right) {
  return (
    equalPrimitive(left.uid, right.uid)
    && equalPrimitive(left.launchAgentsRootId, right.launchAgentsRootId)
    && equalPrimitive(left.launchAgentsRootSha256, right.launchAgentsRootSha256)
    && equalPrimitive(left.sourceCommit, right.sourceCommit)
    && equalPrimitive(left.runtimeArtifactsSha256, right.runtimeArtifactsSha256)
  );
}

function equalManualFacts(left, right) {
  return (
    equalPrimitive(left.mirTransactionId, right.mirTransactionId)
    && equalLockRef(left.mirLockRef, right.mirLockRef)
    && equalLockRef(left.transactionLockRef, right.transactionLockRef)
    && equalPrimitive(left.anchorId, right.anchorId)
    && equalPrimitive(left.repairDeclarationSha256, right.repairDeclarationSha256)
  );
}

function equalConsumedRecord(left, right) {
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key)) return false;
    if (left[key] !== right[key]) return false;
  }
  return true;
}

/**
 * 投影非生产当前 facts：exact keys；字段经闭合校验。
 * 失败 → INVALID（畸形）由调用方在绑定阶段映射为 denied 时再区分。
 */
function projectNonProductionFacts(value) {
  try {
    const fields = readExactObject(value, [
      'uid',
      'launchAgentsRootId',
      'launchAgentsRootSha256',
      'sourceCommit',
      'runtimeArtifactsSha256',
    ]);
    return {
      uid: requireInteger(fields.uid),
      launchAgentsRootId: fields.launchAgentsRootId,
      launchAgentsRootSha256: requireSha256(fields.launchAgentsRootSha256),
      sourceCommit: requireCommit(fields.sourceCommit),
      runtimeArtifactsSha256: requireSha256(fields.runtimeArtifactsSha256),
    };
  } catch (error) {
    if (error instanceof LaunchAgentLifecycleError) throw error;
    invalid();
  }
}

function projectLockRef(value, expectedKind) {
  const fields = readExactObject(value, [
    'kind',
    'transactionId',
    'ownerNonce',
    'sha256',
  ]);
  if (fields.kind !== expectedKind) invalid();
  const transactionId = requireUuid(fields.transactionId);
  const ownerNonce = requireUuid(fields.ownerNonce);
  if (transactionId === ownerNonce) invalid();
  return {
    kind: expectedKind,
    transactionId,
    ownerNonce,
    sha256: requireSha256(fields.sha256),
  };
}

function projectManualFacts(value) {
  try {
    const fields = readExactObject(value, [
      'mirTransactionId',
      'mirLockRef',
      'transactionLockRef',
      'anchorId',
      'repairDeclarationSha256',
    ]);
    const mirTransactionId = requireUuid(fields.mirTransactionId);
    const mirLockRef = projectLockRef(fields.mirLockRef, 'manual-intervention-lock');
    let transactionLockRef = null;
    if (fields.transactionLockRef !== null) {
      transactionLockRef = projectLockRef(fields.transactionLockRef, 'transaction-lock');
    }
    return {
      mirTransactionId,
      mirLockRef,
      transactionLockRef,
      anchorId: requireUuid(fields.anchorId),
      repairDeclarationSha256: requireSha256(fields.repairDeclarationSha256),
    };
  } catch (error) {
    if (error instanceof LaunchAgentLifecycleError) throw error;
    invalid();
  }
}

/**
 * 构造非生产验收只读准备请求：exact 输入字段 + 字面 false 标志，经公共 validator 投影。
 * @param {object} input
 * @returns {Readonly<object>}
 */
export function prepareLaunchAgentAcceptanceRequest(input) {
  const fields = readExactObject(input, [
    'acceptanceId',
    'uid',
    'launchAgentsRootId',
    'launchAgentsRootSha256',
    'sourceCommit',
    'runtimeArtifactsSha256',
    'preparedAt',
  ]);
  return validateLaunchAgentAcceptanceRequest({
    schemaVersion: 1,
    kind: 'non-production-acceptance-request',
    acceptanceId: fields.acceptanceId,
    uid: fields.uid,
    launchAgentsRootId: fields.launchAgentsRootId,
    launchAgentsRootSha256: fields.launchAgentsRootSha256,
    sourceCommit: fields.sourceCommit,
    runtimeArtifactsSha256: fields.runtimeArtifactsSha256,
    executeRequested: false,
    nonProductionConfirmed: false,
    preparedAt: fields.preparedAt,
  });
}

/**
 * 构造人工修复只读准备请求：exact 输入字段 + 字面 false 标志，经公共 validator 投影。
 * @param {object} input
 * @returns {Readonly<object>}
 */
export function prepareLaunchAgentManualRepairRequest(input) {
  const fields = readExactObject(input, [
    'manualRepairRequestId',
    'mirTransactionId',
    'mirLockIdentitySha256',
    'anchorId',
    'repairDeclarationSha256',
    'preparedAt',
  ]);
  return validateLaunchAgentAcceptanceRequest({
    schemaVersion: 1,
    kind: 'manual-repair-request',
    manualRepairRequestId: fields.manualRepairRequestId,
    mirTransactionId: fields.mirTransactionId,
    mirLockIdentitySha256: fields.mirLockIdentitySha256,
    anchorId: fields.anchorId,
    repairDeclarationSha256: fields.repairDeclarationSha256,
    executeRequested: false,
    manualRepairConfirmed: false,
    preparedAt: fields.preparedAt,
  });
}

/**
 * 非生产确认 consume-before-mint：facts A → durable consume → readback → facts B → 能力投影。
 * @param {object} input
 * @returns {Promise<Readonly<object>>}
 */
export async function consumeAndAuthorizeNonProductionConfirmation(input) {
  let deps;
  try {
    deps = readAuthorizeDependencies(input);
  } catch (error) {
    rethrowLifecycle(error);
  }

  let request;
  let confirmation;
  try {
    requirePlainContractObject(deps.request);
    requirePlainContractObject(deps.confirmation);
    request = validateLaunchAgentAcceptanceRequest(deps.request);
    confirmation = validateLaunchAgentConfirmationRecord(deps.confirmation);
  } catch (error) {
    rethrowLifecycle(error);
  }

  if (request.kind !== 'non-production-acceptance-request') denied();
  if (confirmation.kind !== 'non-production-confirmation') denied();
  if (confirmation.acceptanceId !== request.acceptanceId) denied();

  let factsA;
  try {
    const rawA = await deps.readCurrentFacts();
    factsA = projectNonProductionFacts(rawA);
  } catch (error) {
    rethrowLifecycle(error);
  }

  // 绑定 request：不一致 → deny（consume 前，不烧毁）
  if (
    factsA.uid !== request.uid
    || factsA.launchAgentsRootId !== request.launchAgentsRootId
    || factsA.launchAgentsRootSha256 !== request.launchAgentsRootSha256
    || factsA.sourceCommit !== request.sourceCommit
    || factsA.runtimeArtifactsSha256 !== request.runtimeArtifactsSha256
  ) {
    denied();
  }

  let consumedAt;
  try {
    consumedAt = requireUtc(deps.now());
  } catch (error) {
    rethrowLifecycle(error);
  }

  const consumedRecord = validateLaunchAgentConsumedConfirmation({
    schemaVersion: 1,
    confirmationId: confirmation.confirmationId,
    acceptanceId: request.acceptanceId,
    sourceCommit: request.sourceCommit,
    runtimeArtifactsSha256: request.runtimeArtifactsSha256,
    consumedAt,
  });

  try {
    await deps.consumeConfirmation(consumedRecord);
  } catch (error) {
    rethrowLifecycle(error);
  }

  let readback;
  try {
    readback = validateLaunchAgentConsumedConfirmation(
      await deps.readConsumedConfirmation(confirmation.confirmationId),
    );
  } catch (error) {
    // 确认可能已烧毁；不 mint。保留 store/契约错误码。
    rethrowLifecycle(error);
  }

  if (!equalConsumedRecord(readback, consumedRecord)) denied();

  let factsB;
  try {
    const rawB = await deps.readCurrentFacts();
    factsB = projectNonProductionFacts(rawB);
  } catch (error) {
    rethrowLifecycle(error);
  }

  if (!equalNonProductionFacts(factsA, factsB)) denied();

  let issuedAt;
  try {
    issuedAt = requireUtc(deps.now());
  } catch (error) {
    rethrowLifecycle(error);
  }

  const capability = validateLaunchAgentCapabilityProjection({
    schemaVersion: 1,
    acceptanceId: request.acceptanceId,
    confirmationId: confirmation.confirmationId,
    executeAuthorized: true,
    sourceCommit: request.sourceCommit,
    runtimeArtifactsSha256: request.runtimeArtifactsSha256,
    issuedAt,
  });

  nonProductionAuthorityByCapability.set(
    capability,
    deepFreeze({
      projection: capability,
      confirmationId: confirmation.confirmationId,
    }),
  );
  return capability;
}

/**
 * 人工修复确认 consume-before-mint：facts A → durable consume → readback → facts B → 脱敏能力 + 私有 brand。
 * @param {object} input
 * @returns {Promise<Readonly<object>>}
 */
export async function consumeAndAuthorizeManualRepair(input) {
  let deps;
  try {
    deps = readAuthorizeDependencies(input);
  } catch (error) {
    rethrowLifecycle(error);
  }

  let request;
  let confirmation;
  try {
    requirePlainContractObject(deps.request);
    requirePlainContractObject(deps.confirmation);
    request = validateLaunchAgentAcceptanceRequest(deps.request);
    confirmation = validateLaunchAgentConfirmationRecord(deps.confirmation);
  } catch (error) {
    rethrowLifecycle(error);
  }

  if (request.kind !== 'manual-repair-request') denied();
  if (confirmation.kind !== 'manual-repair-confirmation') denied();
  if (confirmation.manualRepairRequestId !== request.manualRepairRequestId) denied();

  let factsA;
  try {
    const rawA = await deps.readCurrentFacts();
    factsA = projectManualFacts(rawA);
  } catch (error) {
    rethrowLifecycle(error);
  }

  // 绑定 request 与 confirmation：lock 身份 / 事务 / 锚点 / 声明
  if (
    factsA.mirTransactionId !== request.mirTransactionId
    || factsA.mirLockRef.transactionId !== request.mirTransactionId
    || factsA.mirLockRef.sha256 !== request.mirLockIdentitySha256
    || factsA.anchorId !== request.anchorId
    || factsA.repairDeclarationSha256 !== request.repairDeclarationSha256
  ) {
    denied();
  }

  let consumedAt;
  try {
    consumedAt = requireUtc(deps.now());
  } catch (error) {
    rethrowLifecycle(error);
  }

  const consumedRecord = validateLaunchAgentConsumedConfirmation({
    schemaVersion: 1,
    kind: 'manual-repair-consumed-confirmation',
    confirmationId: confirmation.confirmationId,
    manualRepairRequestId: request.manualRepairRequestId,
    mirTransactionId: request.mirTransactionId,
    mirLockIdentitySha256: request.mirLockIdentitySha256,
    anchorId: request.anchorId,
    repairDeclarationSha256: request.repairDeclarationSha256,
    consumedAt,
  });

  try {
    await deps.consumeConfirmation(consumedRecord);
  } catch (error) {
    rethrowLifecycle(error);
  }

  let readback;
  try {
    readback = validateLaunchAgentConsumedConfirmation(
      await deps.readConsumedConfirmation(confirmation.confirmationId),
    );
  } catch (error) {
    rethrowLifecycle(error);
  }

  if (!equalConsumedRecord(readback, consumedRecord)) denied();

  let factsB;
  try {
    const rawB = await deps.readCurrentFacts();
    factsB = projectManualFacts(rawB);
  } catch (error) {
    rethrowLifecycle(error);
  }

  if (!equalManualFacts(factsA, factsB)) denied();

  let authorizedAt;
  try {
    authorizedAt = requireUtc(deps.now());
  } catch (error) {
    rethrowLifecycle(error);
  }

  const capability = validateLaunchAgentCapabilityProjection({
    schemaVersion: 1,
    kind: 'launchagent-manual-repair',
    manualRepairRequestId: request.manualRepairRequestId,
    mirTransactionId: request.mirTransactionId,
    mirLockIdentitySha256: request.mirLockIdentitySha256,
    anchorId: request.anchorId,
    repairDeclarationSha256: request.repairDeclarationSha256,
    authorizedAt,
  });

  const mirLockRef = deepFreeze({
    kind: factsA.mirLockRef.kind,
    transactionId: factsA.mirLockRef.transactionId,
    ownerNonce: factsA.mirLockRef.ownerNonce,
    sha256: factsA.mirLockRef.sha256,
  });
  const transactionLockRef = factsA.transactionLockRef === null
    ? null
    : deepFreeze({
      kind: factsA.transactionLockRef.kind,
      transactionId: factsA.transactionLockRef.transactionId,
      ownerNonce: factsA.transactionLockRef.ownerNonce,
      sha256: factsA.transactionLockRef.sha256,
    });

  const authority = deepFreeze({
    projection: capability,
    manualRepairConfirmationId: confirmation.confirmationId,
    mirLockRef,
    transactionLockRef,
  });
  manualRepairAuthorityByCapability.set(capability, authority);
  return capability;
}

/**
 * 一次性消费人工修复私有 authority：仅对象身份，无 I/O；用后即焚。
 * @param {object} capability
 * @returns {Readonly<object>}
 */
export function assertAndConsumeLaunchAgentManualRepairAuthority(capability) {
  if (capability === null || (typeof capability !== 'object' && typeof capability !== 'function')) {
    denied();
  }
  // Proxy / 克隆 / 仿品：WeakMap 以对象身份为准，查无 → denied
  const authority = manualRepairAuthorityByCapability.get(capability);
  if (authority === undefined) denied();
  manualRepairAuthorityByCapability.delete(capability);
  return authority;
}

/**
 * 禁用的零副作用生命周期 facade：全部条件变异入口立即拒绝，不检查任何调用方依赖。
 * @returns {Readonly<object>}
 */
export function createDisabledLaunchAgentLifecycleFacade() {
  function rejectConditionalMutation() {
    throw new LaunchAgentLifecycleError(
      LAUNCHAGENT_LIFECYCLE_CODES.CONDITIONAL_MUTATION_UNSUPPORTED,
    );
  }

  const facade = Object.create(null);
  for (const name of DISABLED_METHODS) {
    // 稳定函数引用：忽略全部 arguments，零属性访问
    Object.defineProperty(facade, name, {
      value: Object.freeze(function disabledLaunchAgentLifecycleMethod() {
        return rejectConditionalMutation();
      }),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(facade);
}
