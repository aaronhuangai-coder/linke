/**
 * LaunchAgent 生命周期元数据存储（V1.46 Task 2）。
 *
 * 边界：
 * - 仅管理隔离 metadataRoot 下的 owned 目录与叶文件；不触碰真实 LaunchAgents、不执行 launchctl。
 * - 生产 factory 固定使用 node:fs/promises，不接受 fs/sink 注入；测试 factory 显式注入真实 wrapper 与 durability sink。
 * - 所有对外错误归一为 LaunchAgentLifecycleError，绝不回显本机 path 或原始异常消息。
 * - 实现 initialize / candidate / anchor / lock / journal append-only chain CAS、receipt 发布/读取、
 *   terminal 与 MIR handoff 的 lock release 与 durability events；
 *   consumed-confirmation 以 O_EXCL durable leaf 持久化（no-clobber → confirmation-consumed）。
 * - 叶写使用 O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW；journal 追加使用 O_APPEND（absent 时 O_CREAT|O_EXCL）；
 *   平台缺少 O_NOFOLLOW 时 factory 直接 fail-closed，不降级。
 * - 并发 lock 仅依赖真实 O_EXCL exactly-one，禁止内存 mutex。
 */

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as nodeFsPromises from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  LaunchAgentLifecycleError,
  LAUNCHAGENT_LIFECYCLE,
  LAUNCHAGENT_LIFECYCLE_CODES,
  validateLaunchAgentAnchor,
  validateLaunchAgentConsumedConfirmation,
  validateLaunchAgentJournal,
  validateLaunchAgentReceipt,
} from './contracts.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const FIXED_MID_DIRS = Object.freeze([
  'candidates',
  'anchors',
  'receipts',
  'confirmations',
]);

const ROLE_LEAVES = Object.freeze({
  controller: 'controller.plist',
  scheduler: 'scheduler.plist',
  manifest: 'active-manifest.json',
});

const TRANSACTION_LOCK_LEAF = 'transaction.lock';
const MANUAL_INTERVENTION_LOCK_LEAF = 'manual-intervention.lock';
const RECOVERY_CLAIM_LEAF = 'recovery-claim.lock';
const TRANSACTION_LOCK_KIND = 'transaction-lock';
const MANUAL_INTERVENTION_LOCK_KIND = 'manual-intervention-lock';
const RECOVERY_CLAIM_LOCK_KIND = 'recovery-claim-lock';
const RECOVERY_CLAIM_ARTIFACT = 'recovery-claim-lock';
const JOURNAL_LEAF = 'transaction-journal.json';
const JOURNAL_ARTIFACT = 'journal';
const RECEIPT_ARTIFACT = 'receipt';
const RECEIPTS_MID_DIR = 'receipts';
const CONFIRMATION_ARTIFACT = 'confirmation';
const CONFIRMATIONS_MID_DIR = 'confirmations';

const ONE_MIB = 1024 * 1024;
const FOUR_MIB = 4 * 1024 * 1024;
const LOCK_MAX_BYTES = 256 * 1024;
/** receipt 单文件上限。 */
const RECEIPT_MAX_BYTES = 256 * 1024;
/** consumed-confirmation 单文件上限。 */
const CONFIRMATION_MAX_BYTES = 256 * 1024;
/** journal 单行上限（含末尾 LF）。 */
const JOURNAL_LINE_MAX_BYTES = 256 * 1024;
/** journal 文件总量上限。 */
const JOURNAL_TOTAL_MAX_BYTES = 16 * 1024 * 1024;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const ROOT_ID = LAUNCHAGENT_LIFECYCLE.rootIds.metadata;

/** 可发布/可普通释放的 terminal journal state（不含 MIR-required）。 */
const TERMINAL_JOURNAL_STATES = new Set([
  'committed',
  'recovered',
  'no-change',
  'blocked',
]);

/** MIR 锁释放允许的 terminal journal state。 */
const MIR_RELEASE_JOURNAL_STATES = new Set([
  'recovered',
  'blocked',
]);

/** 统一 fail-closed：固定错误，不携带 path / raw message。 */
function invalid() {
  throw new LaunchAgentLifecycleError();
}

/** 闭合码错误：code/message 同值，仍无 path / raw message。 */
function coded(code) {
  throw new LaunchAgentLifecycleError(code);
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

/** 要求 plain exact object：仅允许 expectedKeys，且为可枚举数据属性。 */
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

function requireAbsoluteRoot(value) {
  if (typeof value !== 'string' || value.length === 0) invalid();
  if (!isAbsolute(value)) invalid();
  return value;
}

function requireUuid(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) invalid();
  return value;
}

function requireSha256(value) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) invalid();
  return value;
}

function requireRole(value) {
  if (typeof value !== 'string' || !Object.hasOwn(ROLE_LEAVES, value)) invalid();
  return value;
}

function requireBufferAtMost(value, maxBytes) {
  if (!Buffer.isBuffer(value)) invalid();
  if (value.byteLength > maxBytes) invalid();
  return value;
}

function requirePositiveSafeInteger(value) {
  if (!Number.isSafeInteger(value) || value <= 0) invalid();
  return value;
}

/**
 * 身份投影：exact `{available,value}`；
 * available=false → value 必须 null；
 * available=true → 非空 string，且拒绝 `/` `\\` NUL CR/LF。
 */
function validateSessionIdentity(value) {
  const fields = readExactObject(value, ['available', 'value']);
  if (fields.available === false) {
    if (fields.value !== null) invalid();
    return { available: false, value: null };
  }
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

/**
 * 校验并投影 lock record（transaction / MIR 共用 schema）。
 * 固定 leaves：schemaVersion1；transactionId/ownerNonce 为不同 canonical UUID；
 * ownerPid 为正 safe integer；双 identity 严格投影。
 */
function validateLockRecord(value) {
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
    bootSessionIdentity: validateSessionIdentity(fields.bootSessionIdentity),
    processStartIdentity: validateSessionIdentity(fields.processStartIdentity),
  };
}

function serializeLockRecord(projection) {
  const bytes = Buffer.from(JSON.stringify(projection), 'utf8');
  if (bytes.byteLength > LOCK_MAX_BYTES) invalid();
  return bytes;
}

/** 校验 lock ref 闭合投影：kind/transactionId/ownerNonce/sha256；UUID 两两不同。 */
function validateLockRefShape(value, expectedKind) {
  const fields = readExactObject(value, ['kind', 'transactionId', 'ownerNonce', 'sha256']);
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

function lockRefsEqual(left, right) {
  return (
    left !== null
    && right !== null
    && left.kind === right.kind
    && left.transactionId === right.transactionId
    && left.ownerNonce === right.ownerNonce
    && left.sha256 === right.sha256
  );
}

/**
 * 校验并投影 recovery-claim 记录。
 * 固定键序 schema；claimId/transactionId/ownerNonce 两两不同；
 * expectedTransactionLockRef 为 null 或精确 transaction-lock ref；
 * nested refs 与 identity 均为封闭投影。
 */
function validateRecoveryClaimRecord(value) {
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
  if (fields.kind !== RECOVERY_CLAIM_LOCK_KIND) invalid();
  const claimId = requireUuid(fields.claimId);
  const transactionId = requireUuid(fields.transactionId);
  const ownerNonce = requireUuid(fields.ownerNonce);
  if (claimId === transactionId || claimId === ownerNonce || transactionId === ownerNonce) {
    invalid();
  }
  let expectedTransactionLockRef = null;
  if (fields.expectedTransactionLockRef !== null) {
    expectedTransactionLockRef = validateLockRefShape(
      fields.expectedTransactionLockRef,
      TRANSACTION_LOCK_KIND,
    );
  }
  const manualInterventionLockRef = validateLockRefShape(
    fields.manualInterventionLockRef,
    MANUAL_INTERVENTION_LOCK_KIND,
  );
  const freshTransactionLockRef = validateLockRefShape(
    fields.freshTransactionLockRef,
    TRANSACTION_LOCK_KIND,
  );
  // Nested refs must bind to claim/fresh transactionId (cross-tx pair cannot authorize claim).
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
    kind: RECOVERY_CLAIM_LOCK_KIND,
    claimId,
    transactionId,
    ownerPid: requirePositiveSafeInteger(fields.ownerPid),
    ownerNonce,
    bootSessionIdentity: validateSessionIdentity(fields.bootSessionIdentity),
    processStartIdentity: validateSessionIdentity(fields.processStartIdentity),
    expectedTransactionLockRef,
    manualInterventionLockRef,
    freshTransactionLockRef,
  };
}

/** 以固定键序序列化 recovery-claim 投影（含嵌套 ref 精确键序）。 */
function serializeRecoveryClaim(projection) {
  const plain = {
    schemaVersion: projection.schemaVersion,
    kind: projection.kind,
    claimId: projection.claimId,
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
    expectedTransactionLockRef: projection.expectedTransactionLockRef === null
      ? null
      : {
        kind: projection.expectedTransactionLockRef.kind,
        transactionId: projection.expectedTransactionLockRef.transactionId,
        ownerNonce: projection.expectedTransactionLockRef.ownerNonce,
        sha256: projection.expectedTransactionLockRef.sha256,
      },
    manualInterventionLockRef: {
      kind: projection.manualInterventionLockRef.kind,
      transactionId: projection.manualInterventionLockRef.transactionId,
      ownerNonce: projection.manualInterventionLockRef.ownerNonce,
      sha256: projection.manualInterventionLockRef.sha256,
    },
    freshTransactionLockRef: {
      kind: projection.freshTransactionLockRef.kind,
      transactionId: projection.freshTransactionLockRef.transactionId,
      ownerNonce: projection.freshTransactionLockRef.ownerNonce,
      sha256: projection.freshTransactionLockRef.sha256,
    },
  };
  const bytes = Buffer.from(JSON.stringify(plain), 'utf8');
  if (bytes.byteLength > LOCK_MAX_BYTES) invalid();
  return bytes;
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 平台必须提供 O_NOFOLLOW / O_APPEND；缺失则 factory 失败，禁止降级跟随 symlink。 */
function requireNoFollowFlags() {
  if (typeof fsConstants.O_NOFOLLOW !== 'number') invalid();
  if (typeof fsConstants.O_CREAT !== 'number') invalid();
  if (typeof fsConstants.O_EXCL !== 'number') invalid();
  if (typeof fsConstants.O_WRONLY !== 'number') invalid();
  if (typeof fsConstants.O_RDONLY !== 'number') invalid();
  if (typeof fsConstants.O_APPEND !== 'number') invalid();
  return {
    write:
      fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | fsConstants.O_WRONLY
      | fsConstants.O_NOFOLLOW,
    appendCreate:
      fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | fsConstants.O_APPEND
      | fsConstants.O_WRONLY
      | fsConstants.O_NOFOLLOW,
    append:
      fsConstants.O_APPEND
      | fsConstants.O_WRONLY
      | fsConstants.O_NOFOLLOW,
    read: fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    dirRead: fsConstants.O_RDONLY,
  };
}

/**
 * journal entry canonical hash：闭合投影字段（不含 entrySha256）按固定键序
 * schemaVersion,transactionId,sequence,previousEntrySha256,operation,state,at,payload
 * → JSON.stringify UTF-8 → SHA-256 hex。store 负责与 entry.entrySha256 对齐。
 */
function computeJournalEntrySha256(projection) {
  const plain = {
    schemaVersion: projection.schemaVersion,
    transactionId: projection.transactionId,
    sequence: projection.sequence,
    previousEntrySha256: projection.previousEntrySha256,
    operation: projection.operation,
    state: projection.state,
    at: projection.at,
    payload: projection.payload,
  };
  return sha256Hex(Buffer.from(JSON.stringify(plain), 'utf8'));
}

function currentUid() {
  if (typeof process.getuid !== 'function') invalid();
  return process.getuid();
}

/**
 * 将任意异常归一为 LaunchAgentLifecycleError；已是契约错误则原样抛出。
 * 单一职责：边界错误卫生，避免 path / raw message 泄漏。
 */
async function withLifecycleErrors(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof LaunchAgentLifecycleError) throw error;
    invalid();
  }
}

/**
 * 构造冻结 store。fs 与 onDurabilityEvent 由 factory 注入（生产为内置 fs + no-op sink）。
 */
function createStore(metadataRoot, fs, onDurabilityEvent) {
  const flags = requireNoFollowFlags();
  const uid = currentUid();

  /** @type {{ dev: number, ino: number } | null} */
  let boundRoot = null;

  function emitDurability(kind, artifact) {
    const event = Object.freeze({ kind, artifact });
    onDurabilityEvent(event);
  }

  async function lstatPath(path) {
    return fs.lstat(path);
  }

  /** 校验目录：必须是本 uid 拥有、mode 0700、真实目录、非 symlink。 */
  async function assertOwnedDirectory(path) {
    const st = await lstatPath(path);
    if (st.isSymbolicLink() || !st.isDirectory()) invalid();
    if ((st.mode & 0o777) !== DIR_MODE) invalid();
    if (st.uid !== uid) invalid();
    return st;
  }

  /** 仅对本轮缺失的目录 mkdir(0700)；已存在则只复核，不 chmod 修复。 */
  async function ensureOwnedDirectory(path) {
    let existed = true;
    try {
      await lstatPath(path);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        existed = false;
      } else {
        invalid();
      }
    }
    if (!existed) {
      try {
        await fs.mkdir(path, { mode: DIR_MODE });
      } catch {
        invalid();
      }
    }
    return assertOwnedDirectory(path);
  }

  /** 复核 root 身份（dev+ino）与固定中间目录；未 initialize 则 fail-closed。 */
  async function assertBoundRootLayout() {
    if (boundRoot === null) invalid();
    const rootStat = await assertOwnedDirectory(metadataRoot);
    if (rootStat.dev !== boundRoot.dev || rootStat.ino !== boundRoot.ino) invalid();
    for (const name of FIXED_MID_DIRS) {
      await assertOwnedDirectory(join(metadataRoot, name));
    }
    return rootStat;
  }

  /**
   * 叶文件 durable 写入：O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW → write → fsync 文件 →
   * fsync 父目录 → O_RDONLY|O_NOFOLLOW 重开校验 type/mode/uid/sha。
   * existingCode（可选闭合码）：仅 EEXIST 时映射为该码；缺省保持 candidate/anchor 的 INVALID。
   */
  async function durableWriteLeaf(targetPath, parentDir, bytes, expectedSha, artifact, existingCode) {
    let writeHandle;
    try {
      writeHandle = await fs.open(targetPath, flags.write, FILE_MODE);
    } catch (error) {
      if (
        existingCode !== undefined
        && error
        && error.code === 'EEXIST'
      ) {
        coded(existingCode);
      }
      invalid();
    }
    try {
      await writeHandle.writeFile(bytes);
      await writeHandle.sync();
    } catch {
      try {
        await writeHandle.close();
      } catch {
        // ignore close errors during fail-closed path
      }
      invalid();
    }
    try {
      await writeHandle.close();
    } catch {
      invalid();
    }
    emitDurability('file-sync', artifact);

    let dirHandle;
    try {
      dirHandle = await fs.open(parentDir, flags.dirRead);
    } catch {
      invalid();
    }
    try {
      await dirHandle.sync();
    } catch {
      try {
        await dirHandle.close();
      } catch {
        // ignore
      }
      invalid();
    }
    try {
      await dirHandle.close();
    } catch {
      invalid();
    }
    emitDurability('directory-sync', artifact);

    await verifyLeafFile(targetPath, bytes, expectedSha);
    emitDurability('verify', artifact);
  }

  /** 以 O_NOFOLLOW 重开叶文件并校验 type/mode/uid/内容/哈希。 */
  async function verifyLeafFile(targetPath, expectedBytes, expectedSha) {
    let readHandle;
    try {
      readHandle = await fs.open(targetPath, flags.read);
    } catch {
      invalid();
    }
    try {
      const st = await readHandle.stat();
      if (st.isSymbolicLink() || !st.isFile()) invalid();
      if ((st.mode & 0o777) !== FILE_MODE) invalid();
      if (st.uid !== uid) invalid();
      if (st.size !== expectedBytes.byteLength) invalid();
      const onDisk = await readHandle.readFile();
      if (!Buffer.isBuffer(onDisk) || onDisk.byteLength !== expectedBytes.byteLength) invalid();
      if (Buffer.compare(onDisk, expectedBytes) !== 0) invalid();
      if (sha256Hex(onDisk) !== expectedSha) invalid();
      return onDisk;
    } catch (error) {
      if (error instanceof LaunchAgentLifecycleError) throw error;
      invalid();
    } finally {
      try {
        await readHandle.close();
      } catch {
        // close best-effort; verification outcome already decided
      }
    }
  }

  /**
   * 只读打开 owned 叶文件，返回 detached Buffer。
   * maxBytes：在 handle.stat 后、readFile 前拒绝 oversize，避免先读后限。
   */
  async function readOwnedLeaf(targetPath, maxBytes) {
    let readHandle;
    try {
      readHandle = await fs.open(targetPath, flags.read);
    } catch {
      invalid();
    }
    try {
      const st = await readHandle.stat();
      if (st.isSymbolicLink() || !st.isFile()) invalid();
      if ((st.mode & 0o777) !== FILE_MODE) invalid();
      if (st.uid !== uid) invalid();
      if (typeof maxBytes === 'number' && st.size > maxBytes) invalid();
      const onDisk = await readHandle.readFile();
      if (!Buffer.isBuffer(onDisk) || onDisk.byteLength !== st.size) invalid();
      if (typeof maxBytes === 'number' && onDisk.byteLength > maxBytes) invalid();
      return Buffer.from(onDisk);
    } catch (error) {
      if (error instanceof LaunchAgentLifecycleError) throw error;
      invalid();
    } finally {
      try {
        await readHandle.close();
      } catch {
        // ignore
      }
    }
  }

  async function initialize() {
    return withLifecycleErrors(async () => {
      await ensureOwnedDirectory(metadataRoot);
      const rootStat = await assertOwnedDirectory(metadataRoot);
      if (boundRoot === null) {
        boundRoot = { dev: rootStat.dev, ino: rootStat.ino };
      } else if (boundRoot.dev !== rootStat.dev || boundRoot.ino !== rootStat.ino) {
        invalid();
      }

      for (const name of FIXED_MID_DIRS) {
        await ensureOwnedDirectory(join(metadataRoot, name));
      }

      return deepFreeze({ rootId: ROOT_ID });
    });
  }

  async function writeCandidate(input) {
    return withLifecycleErrors(async () => {
      await assertBoundRootLayout();
      const fields = readExactObject(input, ['transactionId', 'role', 'bytes']);
      const transactionId = requireUuid(fields.transactionId);
      const role = requireRole(fields.role);
      const bytes = Buffer.from(requireBufferAtMost(fields.bytes, ONE_MIB));
      const expectedSha = sha256Hex(bytes);

      const candidatesRoot = join(metadataRoot, 'candidates');
      await assertOwnedDirectory(candidatesRoot);
      const txDir = join(candidatesRoot, transactionId);
      await ensureOwnedDirectory(txDir);

      const leafName = ROLE_LEAVES[role];
      const targetPath = join(txDir, leafName);
      await durableWriteLeaf(targetPath, txDir, bytes, expectedSha, 'candidate');

      return deepFreeze({
        kind: 'candidate',
        transactionId,
        role,
        sha256: expectedSha,
      });
    });
  }

  async function readCandidate(ref) {
    return withLifecycleErrors(async () => {
      await assertBoundRootLayout();
      const fields = readExactObject(ref, ['kind', 'transactionId', 'role', 'sha256']);
      if (fields.kind !== 'candidate') invalid();
      const transactionId = requireUuid(fields.transactionId);
      const role = requireRole(fields.role);
      const expectedSha = requireSha256(fields.sha256);

      const targetPath = join(
        metadataRoot,
        'candidates',
        transactionId,
        ROLE_LEAVES[role],
      );
      const bytes = await readOwnedLeaf(targetPath, ONE_MIB);
      if (sha256Hex(bytes) !== expectedSha) invalid();
      return bytes;
    });
  }

  async function writeAnchor(anchor) {
    return withLifecycleErrors(async () => {
      await assertBoundRootLayout();
      const projection = validateLaunchAgentAnchor(anchor);
      const serialized = Buffer.from(JSON.stringify(projection), 'utf8');
      if (serialized.byteLength > FOUR_MIB) invalid();
      const expectedSha = sha256Hex(serialized);
      const anchorId = projection.anchorId;

      const anchorsRoot = join(metadataRoot, 'anchors');
      await assertOwnedDirectory(anchorsRoot);
      const targetPath = join(anchorsRoot, `${anchorId}.json`);
      await durableWriteLeaf(targetPath, anchorsRoot, serialized, expectedSha, 'anchor');

      return deepFreeze({
        kind: 'anchor',
        anchorId,
        sha256: expectedSha,
      });
    });
  }

  async function readAnchor(anchorIdInput) {
    return withLifecycleErrors(async () => {
      await assertBoundRootLayout();
      const anchorId = requireUuid(anchorIdInput);
      const targetPath = join(metadataRoot, 'anchors', `${anchorId}.json`);
      const bytes = await readOwnedLeaf(targetPath, FOUR_MIB);

      let parsed;
      try {
        parsed = JSON.parse(bytes.toString('utf8'));
      } catch {
        invalid();
      }
      const projection = validateLaunchAgentAnchor(parsed);
      if (projection.anchorId !== anchorId) invalid();
      // 重算序列化哈希与投影一致性（只读路径不强制与写时字节逐字相等以外的额外字段）
      return projection;
    });
  }

  /** lstat 探测 leaf 是否存在（任意类型）；ENOENT→false，其它错误 fail-closed。 */
  async function leafExists(leafName) {
    try {
      await lstatPath(join(metadataRoot, leafName));
      return true;
    } catch (error) {
      if (error && error.code === 'ENOENT') return false;
      invalid();
    }
  }

  /** 读取并严格校验现有 lock leaf 的 closed projection；不存在则返回 null。 */
  async function readExistingLockProjection(leafName) {
    const exists = await leafExists(leafName);
    if (!exists) return null;
    const bytes = await readOwnedLeaf(join(metadataRoot, leafName), LOCK_MAX_BYTES);
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      invalid();
    }
    return validateLockRecord(parsed);
  }

  /**
   * 校验 lock ref 并对照当前 leaf 的 type/mode/uid/size/hash/schema/绑定。
   * kind 不符在 leaf I/O 之前 INVALID（避免错误 kind 触碰无关 leaf）。
   */
  async function verifyLockRefAgainstLeaf(ref, expectedKind, leafName) {
    const fields = readExactObject(ref, ['kind', 'transactionId', 'ownerNonce', 'sha256']);
    if (fields.kind !== expectedKind) invalid();
    const transactionId = requireUuid(fields.transactionId);
    const ownerNonce = requireUuid(fields.ownerNonce);
    if (transactionId === ownerNonce) invalid();
    const expectedSha = requireSha256(fields.sha256);

    const targetPath = join(metadataRoot, leafName);
    const bytes = await readOwnedLeaf(targetPath, LOCK_MAX_BYTES);
    if (sha256Hex(bytes) !== expectedSha) invalid();

    let parsed;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      invalid();
    }
    const projection = validateLockRecord(parsed);
    if (projection.transactionId !== transactionId) invalid();
    if (projection.ownerNonce !== ownerNonce) invalid();
    return projection;
  }

  /** 在已验证的 journal 条目列表中取指定 transactionId 的最新条目；无则 null。 */
  function latestJournalEntryFor(entries, transactionId) {
    let latest = null;
    for (const entry of entries) {
      if (entry.transactionId === transactionId) latest = entry;
    }
    return latest;
  }

  /** fsync metadataRoot 目录（lock release 持久化边界）。 */
  async function fsyncMetadataRoot() {
    let dirHandle;
    try {
      dirHandle = await fs.open(metadataRoot, flags.dirRead);
    } catch {
      invalid();
    }
    try {
      await dirHandle.sync();
    } catch {
      try {
        await dirHandle.close();
      } catch {
        // ignore
      }
      invalid();
    }
    try {
      await dirHandle.close();
    } catch {
      invalid();
    }
  }

  /**
   * 读取并严格验证 receipt 叶：owned 模式、上限、schema 投影、精确
   * JSON.stringify(projection) 字节对齐、transactionId 绑定。
   * 返回 { projection, bytes, sha256 }。
   */
  async function loadValidatedReceipt(transactionId) {
    const receiptsRoot = join(metadataRoot, RECEIPTS_MID_DIR);
    await assertOwnedDirectory(receiptsRoot);
    const targetPath = join(receiptsRoot, `${transactionId}.json`);
    const bytes = await readOwnedLeaf(targetPath, RECEIPT_MAX_BYTES);

    let parsed;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      invalid();
    }
    const projection = validateLaunchAgentReceipt(parsed);
    if (projection.transactionId !== transactionId) invalid();
    const expectedBytes = Buffer.from(JSON.stringify(projection), 'utf8');
    if (expectedBytes.byteLength > RECEIPT_MAX_BYTES) invalid();
    if (Buffer.compare(bytes, expectedBytes) !== 0) invalid();
    const digest = sha256Hex(bytes);
    if (digest !== sha256Hex(expectedBytes)) invalid();
    return { projection, bytes, sha256: digest };
  }

  /**
   * 将已验证 receipt 与 terminal journal 条目对齐：
   * state / operation / transactionId / hostMutationCount / receiptSha256。
   */
  function assertReceiptMatchesTerminal(receiptProjection, receiptSha, terminal) {
    if (terminal === null || typeof terminal !== 'object') invalid();
    if (!TERMINAL_JOURNAL_STATES.has(terminal.state)) invalid();
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

  /** 校验 writer/publish lockRef 为 tx 或 MIR 之一，严格重验磁盘身份，返回投影。 */
  async function verifyWriterOrMirLockRef(lockRef) {
    const fields = readExactObject(lockRef, [
      'kind',
      'transactionId',
      'ownerNonce',
      'sha256',
    ]);
    if (fields.kind === TRANSACTION_LOCK_KIND) {
      return verifyLockRefAgainstLeaf(
        lockRef,
        TRANSACTION_LOCK_KIND,
        TRANSACTION_LOCK_LEAF,
      );
    }
    if (fields.kind === MANUAL_INTERVENTION_LOCK_KIND) {
      return verifyLockRefAgainstLeaf(
        lockRef,
        MANUAL_INTERVENTION_LOCK_KIND,
        MANUAL_INTERVENTION_LOCK_LEAF,
      );
    }
    invalid();
  }

  /** unlink 命名 leaf 后 fail-closed；不跟随业务错误消息。 */
  async function unlinkOwnedLeaf(leafName) {
    try {
      await fs.unlink(join(metadataRoot, leafName));
    } catch {
      invalid();
    }
  }

  /**
   * 解析并严格校验 journal 全量字节：逐行 JSON + validateLaunchAgentJournal +
   * independent canonical entry hash；按 transaction 验证 sequence 自 0 严格 +1 与 previous hash。
   */
  function parseAndValidateJournalBytes(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) invalid();
    if (bytes[bytes.byteLength - 1] !== 0x0a) invalid();

    const entries = [];
    /** @type {Map<string, { sequence: number, entrySha256: string }>} */
    const latestByTx = new Map();
    let offset = 0;
    while (offset < bytes.byteLength) {
      const nl = bytes.indexOf(0x0a, offset);
      if (nl === -1) invalid();
      const lineWithLf = nl - offset + 1;
      if (lineWithLf > JOURNAL_LINE_MAX_BYTES) invalid();
      const lineBytes = bytes.subarray(offset, nl);
      let parsed;
      try {
        parsed = JSON.parse(lineBytes.toString('utf8'));
      } catch {
        invalid();
      }
      const projection = validateLaunchAgentJournal(parsed);
      if (computeJournalEntrySha256(projection) !== projection.entrySha256) invalid();

      const prior = latestByTx.get(projection.transactionId);
      if (prior === undefined) {
        if (projection.sequence !== 0 || projection.previousEntrySha256 !== null) invalid();
      } else {
        if (projection.sequence !== prior.sequence + 1) invalid();
        if (projection.previousEntrySha256 !== prior.entrySha256) invalid();
      }
      latestByTx.set(projection.transactionId, {
        sequence: projection.sequence,
        entrySha256: projection.entrySha256,
      });
      entries.push(projection);
      offset = nl + 1;
    }
    return entries;
  }

  /**
   * 读取并验证整个 journal snapshot。
   * absent → { present:false }；存在则 O_RDONLY|O_NOFOLLOW，先 total size gate 再 read。
   */
  async function loadJournalSnapshot() {
    const targetPath = join(metadataRoot, JOURNAL_LEAF);
    let readHandle;
    try {
      readHandle = await fs.open(targetPath, flags.read);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return {
          present: false,
          bytes: Buffer.alloc(0),
          entries: [],
          st: null,
        };
      }
      invalid();
    }
    try {
      const st = await readHandle.stat();
      if (st.isSymbolicLink() || !st.isFile()) invalid();
      if ((st.mode & 0o777) !== FILE_MODE) invalid();
      if (st.uid !== uid) invalid();
      // total oversize：stat 后、read 前拒绝（绝不解析 >16MiB fixture）
      if (st.size <= 0 || st.size > JOURNAL_TOTAL_MAX_BYTES) invalid();
      const onDisk = await readHandle.readFile();
      if (!Buffer.isBuffer(onDisk) || onDisk.byteLength !== st.size) invalid();
      if (onDisk.byteLength === 0 || onDisk[onDisk.byteLength - 1] !== 0x0a) invalid();
      const entries = parseAndValidateJournalBytes(onDisk);
      return {
        present: true,
        bytes: Buffer.from(onDisk),
        entries,
        st: {
          dev: st.dev,
          ino: st.ino,
          mode: st.mode,
          uid: st.uid,
          size: st.size,
        },
      };
    } catch (error) {
      if (error instanceof LaunchAgentLifecycleError) throw error;
      invalid();
    } finally {
      try {
        await readHandle.close();
      } catch {
        // ignore
      }
    }
  }

  async function readJournal(input) {
    return withLifecycleErrors(async () => {
      await assertBoundRootLayout();
      const fields = readExactObject(input, ['transactionId']);
      const transactionId = requireUuid(fields.transactionId);

      const snapshot = await loadJournalSnapshot();
      if (!snapshot.present) {
        return deepFreeze([]);
      }
      const filtered = [];
      for (const entry of snapshot.entries) {
        if (entry.transactionId === transactionId) filtered.push(entry);
      }
      return deepFreeze(filtered);
    });
  }

  /**
   * 只读返回全局 journal heads：精确 bytes hash、每 transaction 最新 entry、
   * transactionId 词典序稳定排序。同一 transaction 的 operation 漂移时
   * 整体 fail-closed；不改变既有 readJournal 合同，也不产生耐久化事件。
   */
  async function readJournalHeads() {
    const argumentCount = arguments.length;
    return withLifecycleErrors(async () => {
      if (argumentCount !== 0) invalid();
      await assertBoundRootLayout();

      const snapshot = await loadJournalSnapshot();
      const operationByTransaction = new Map();
      const latestByTransaction = new Map();

      for (const entry of snapshot.entries) {
        const priorOperation = operationByTransaction.get(entry.transactionId);
        if (priorOperation === undefined) {
          operationByTransaction.set(entry.transactionId, entry.operation);
        } else if (priorOperation !== entry.operation) {
          invalid();
        }
        latestByTransaction.set(entry.transactionId, entry);
      }

      const heads = [...latestByTransaction.entries()]
        .sort(([left], [right]) => {
          if (left < right) return -1;
          if (left > right) return 1;
          return 0;
        })
        .map(([, entry]) => entry);

      return deepFreeze({
        kind: 'journal-heads',
        journalSha256: sha256Hex(snapshot.bytes),
        heads,
      });
    });
  }

  async function appendJournal(input) {
    return withLifecycleErrors(async () => {
      await assertBoundRootLayout();
      const fields = readExactObject(input, ['entry', 'expectedPrior', 'writerLockRef']);

      const entry = validateLaunchAgentJournal(fields.entry);
      if (computeJournalEntrySha256(entry) !== entry.entrySha256) invalid();

      const line = Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8');
      if (line.byteLength > JOURNAL_LINE_MAX_BYTES) invalid();

      // writer ref：仅 transaction-lock 或 manual-intervention-lock，严格 verify，且同 transactionId
      const writerFields = readExactObject(fields.writerLockRef, [
        'kind',
        'transactionId',
        'ownerNonce',
        'sha256',
      ]);
      if (writerFields.kind === TRANSACTION_LOCK_KIND) {
        await verifyLockRefAgainstLeaf(
          fields.writerLockRef,
          TRANSACTION_LOCK_KIND,
          TRANSACTION_LOCK_LEAF,
        );
      } else if (writerFields.kind === MANUAL_INTERVENTION_LOCK_KIND) {
        await verifyLockRefAgainstLeaf(
          fields.writerLockRef,
          MANUAL_INTERVENTION_LOCK_KIND,
          MANUAL_INTERVENTION_LOCK_LEAF,
        );
      } else {
        invalid();
      }
      if (writerFields.transactionId !== entry.transactionId) invalid();

      // 读取并验证整个 journal snapshot（corrupt/oversize/mode 在 mutation 前 fail-closed）
      const snapshot = await loadJournalSnapshot();

      let latest = null;
      for (const existing of snapshot.entries) {
        if (existing.transactionId === entry.transactionId) latest = existing;
      }

      if (latest === null) {
        if (fields.expectedPrior !== null) invalid();
        if (entry.sequence !== 0 || entry.previousEntrySha256 !== null) invalid();
      } else {
        const prior = readExactObject(fields.expectedPrior, [
          'transactionId',
          'sequence',
          'entrySha256',
        ]);
        if (prior.transactionId !== latest.transactionId) invalid();
        if (prior.sequence !== latest.sequence) invalid();
        if (prior.entrySha256 !== latest.entrySha256) invalid();
        if (entry.sequence !== latest.sequence + 1) invalid();
        if (entry.previousEntrySha256 !== latest.entrySha256) invalid();
      }

      const currentBytes = snapshot.present ? snapshot.bytes.byteLength : 0;
      if (currentBytes + line.byteLength > JOURNAL_TOTAL_MAX_BYTES) invalid();

      const targetPath = join(metadataRoot, JOURNAL_LEAF);
      let writeHandle;
      if (!snapshot.present) {
        try {
          writeHandle = await fs.open(targetPath, flags.appendCreate, FILE_MODE);
        } catch {
          invalid();
        }
      } else {
        try {
          writeHandle = await fs.open(targetPath, flags.append);
        } catch {
          invalid();
        }
        try {
          const st = await writeHandle.stat();
          if (st.isSymbolicLink() || !st.isFile()) invalid();
          if (st.dev !== snapshot.st.dev || st.ino !== snapshot.st.ino) invalid();
          if ((st.mode & 0o777) !== FILE_MODE) invalid();
          if (st.uid !== uid) invalid();
          if (st.size !== snapshot.st.size) invalid();
        } catch (error) {
          try {
            await writeHandle.close();
          } catch {
            // ignore
          }
          if (error instanceof LaunchAgentLifecycleError) throw error;
          invalid();
        }
      }

      try {
        let written = 0;
        while (written < line.byteLength) {
          const result = await writeHandle.write(
            line,
            written,
            line.byteLength - written,
          );
          if (!result || !Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) {
            invalid();
          }
          written += result.bytesWritten;
        }
        await writeHandle.sync();
      } catch (error) {
        try {
          await writeHandle.close();
        } catch {
          // ignore
        }
        if (error instanceof LaunchAgentLifecycleError) throw error;
        invalid();
      }
      try {
        await writeHandle.close();
      } catch {
        invalid();
      }
      emitDurability('file-sync', JOURNAL_ARTIFACT);

      let dirHandle;
      try {
        dirHandle = await fs.open(metadataRoot, flags.dirRead);
      } catch {
        invalid();
      }
      try {
        await dirHandle.sync();
      } catch {
        try {
          await dirHandle.close();
        } catch {
          // ignore
        }
        invalid();
      }
      try {
        await dirHandle.close();
      } catch {
        invalid();
      }
      emitDurability('directory-sync', JOURNAL_ARTIFACT);

      const expectedBytes = snapshot.present
        ? Buffer.concat([snapshot.bytes, line])
        : Buffer.from(line);
      const verified = await loadJournalSnapshot();
      if (!verified.present) invalid();
      if (Buffer.compare(verified.bytes, expectedBytes) !== 0) invalid();
      emitDurability('verify', JOURNAL_ARTIFACT);

      return deepFreeze({
        kind: 'journal-entry',
        transactionId: entry.transactionId,
        sequence: entry.sequence,
        entrySha256: entry.entrySha256,
      });
    });
  }

  /**
   * 只读打开 owned leaf：精确 ENOENT → null；否则校验 0600/uid/regular/非 symlink/
   * max size，返回 detached Buffer。不写、不修复。
   */
  async function readOptionalOwnedLeafBytes(leafName, maxBytes) {
    const targetPath = join(metadataRoot, leafName);
    let readHandle;
    try {
      readHandle = await fs.open(targetPath, flags.read);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      invalid();
    }
    try {
      const st = await readHandle.stat();
      if (st.isSymbolicLink() || !st.isFile()) invalid();
      if ((st.mode & 0o777) !== FILE_MODE) invalid();
      if (st.uid !== uid) invalid();
      if (st.size > maxBytes) invalid();
      const onDisk = await readHandle.readFile();
      if (!Buffer.isBuffer(onDisk) || onDisk.byteLength !== st.size) invalid();
      if (onDisk.byteLength > maxBytes) invalid();
      return Buffer.from(onDisk);
    } catch (error) {
      if (error instanceof LaunchAgentLifecycleError) throw error;
      invalid();
    } finally {
      try {
        await readHandle.close();
      } catch {
        // ignore
      }
    }
  }

  /**
   * 内部：读取 transaction.lock 观察载荷；ENOENT→null；canonical 字节对齐。
   * 返回未 deepFreeze 的 { ref, record } 供 acquisition 比较，或 null。
   */
  async function loadTransactionLockObservationPayload() {
    const bytes = await readOptionalOwnedLeafBytes(TRANSACTION_LOCK_LEAF, LOCK_MAX_BYTES);
    if (bytes === null) return null;
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      invalid();
    }
    const record = validateLockRecord(parsed);
    const expectedBytes = serializeLockRecord(record);
    if (Buffer.compare(bytes, expectedBytes) !== 0) invalid();
    return {
      record,
      ref: {
        kind: TRANSACTION_LOCK_KIND,
        transactionId: record.transactionId,
        ownerNonce: record.ownerNonce,
        sha256: sha256Hex(bytes),
      },
    };
  }

  /**
   * 内部：读取 recovery-claim.lock 观察载荷；ENOENT→null；canonical 字节对齐。
   */
  async function loadRecoveryClaimObservationPayload() {
    const bytes = await readOptionalOwnedLeafBytes(RECOVERY_CLAIM_LEAF, LOCK_MAX_BYTES);
    if (bytes === null) return null;
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      invalid();
    }
    const record = validateRecoveryClaimRecord(parsed);
    const expectedBytes = serializeRecoveryClaim(record);
    if (Buffer.compare(bytes, expectedBytes) !== 0) invalid();
    return {
      record,
      ref: {
        kind: RECOVERY_CLAIM_LOCK_KIND,
        claimId: record.claimId,
        transactionId: record.transactionId,
        ownerNonce: record.ownerNonce,
        sha256: sha256Hex(bytes),
      },
    };
  }

  /** 只读 transaction.lock 观察：null 或深冻结 detached observation。 */
  async function readTransactionLockObservation() {
    return withLifecycleErrors(async () => {
      await assertBoundRootLayout();
      const payload = await loadTransactionLockObservationPayload();
      if (payload === null) return null;
      return deepFreeze({
        kind: 'transaction-lock-observation',
        ref: payload.ref,
        record: payload.record,
      });
    });
  }

  /** 只读 recovery-claim.lock 观察：null 或深冻结 detached observation。 */
  async function readRecoveryClaimObservation() {
    return withLifecycleErrors(async () => {
      await assertBoundRootLayout();
      const payload = await loadRecoveryClaimObservationPayload();
      if (payload === null) return null;
      return deepFreeze({
        kind: 'recovery-claim-observation',
        ref: payload.ref,
        record: payload.record,
      });
    });
  }

  /**
   * MIR 专用恢复锁获取：先 durable O_EXCL 固定 recovery-claim.lock，
   * 再 revalidate → 删除 old transaction ref → O_EXCL 发布 fresh transaction.lock →
   * 精确释放 claim。普通 acquireTransactionLock 语义不变且继续拒绝 MIR。
   * claim 发布成功后禁止 catch/finally 清理 claim；后期错误保留精确 claim。
   */
  async function acquireRecoveryLockForManualRepair(input) {
    return withLifecycleErrors(async () => {
      await assertBoundRootLayout();

      // 1. mutation 前闭合全部输入；fresh ref 由 store 从 record 计算，调用方不可伪造。
      const fields = readExactObject(input, [
        'record',
        'claimId',
        'expectedTransactionLockRef',
        'manualInterventionLockRef',
      ]);
      const freshRecord = validateLockRecord(fields.record);
      const claimId = requireUuid(fields.claimId);
      if (
        claimId === freshRecord.transactionId
        || claimId === freshRecord.ownerNonce
      ) {
        invalid();
      }

      let expectedTransactionLockRef = null;
      if (fields.expectedTransactionLockRef !== null) {
        expectedTransactionLockRef = validateLockRefShape(
          fields.expectedTransactionLockRef,
          TRANSACTION_LOCK_KIND,
        );
      }
      const manualInterventionLockRef = validateLockRefShape(
        fields.manualInterventionLockRef,
        MANUAL_INTERVENTION_LOCK_KIND,
      );

      const freshBytes = serializeLockRecord(freshRecord);
      const freshSha = sha256Hex(freshBytes);
      const freshTransactionLockRef = {
        kind: TRANSACTION_LOCK_KIND,
        transactionId: freshRecord.transactionId,
        ownerNonce: freshRecord.ownerNonce,
        sha256: freshSha,
      };

      const claimProjection = {
        schemaVersion: 1,
        kind: RECOVERY_CLAIM_LOCK_KIND,
        claimId,
        transactionId: freshRecord.transactionId,
        ownerPid: freshRecord.ownerPid,
        ownerNonce: freshRecord.ownerNonce,
        bootSessionIdentity: freshRecord.bootSessionIdentity,
        processStartIdentity: freshRecord.processStartIdentity,
        expectedTransactionLockRef,
        manualInterventionLockRef,
        freshTransactionLockRef,
      };
      // 再经 validator 闭合（保证与只读观察路径同一投影/序列化契约）
      const claimRecord = validateRecoveryClaimRecord(claimProjection);
      const claimBytes = serializeRecoveryClaim(claimRecord);
      const claimSha = sha256Hex(claimBytes);
      const claimPath = join(metadataRoot, RECOVERY_CLAIM_LEAF);

      // 2. 验证精确 MIR（mutation 前）
      await verifyLockRefAgainstLeaf(
        manualInterventionLockRef,
        MANUAL_INTERVENTION_LOCK_KIND,
        MANUAL_INTERVENTION_LOCK_LEAF,
      );

      // 3–4. 读取并校验当前 transaction.lock，与 expected ref 或精确缺失对齐
      const currentBefore = await loadTransactionLockObservationPayload();
      if (expectedTransactionLockRef === null) {
        if (currentBefore !== null) invalid();
      } else if (
        currentBefore === null
        || !lockRefsEqual(currentBefore.ref, expectedTransactionLockRef)
      ) {
        invalid();
      }

      // 5. durable O_EXCL claim；竞争失败者 → transaction-in-progress，零 transaction 变更
      await durableWriteLeaf(
        claimPath,
        metadataRoot,
        claimBytes,
        claimSha,
        RECOVERY_CLAIM_ARTIFACT,
        LAUNCHAGENT_LIFECYCLE_CODES.TRANSACTION_IN_PROGRESS,
      );

      // claim 已 durable：此后任何错误必须保留精确 claim（无 catch/finally 清理）

      // 6. 重新验证 own claim、MIR、当前 transaction ref/精确缺失
      await verifyLeafFile(claimPath, claimBytes, claimSha);
      await verifyLockRefAgainstLeaf(
        manualInterventionLockRef,
        MANUAL_INTERVENTION_LOCK_KIND,
        MANUAL_INTERVENTION_LOCK_LEAF,
      );

      const currentAfterClaim = await loadTransactionLockObservationPayload();
      if (expectedTransactionLockRef === null) {
        if (currentAfterClaim !== null) {
          coded(LAUNCHAGENT_LIFECYCLE_CODES.TRANSACTION_IN_PROGRESS);
        }
      } else if (
        currentAfterClaim === null
        || !lockRefsEqual(currentAfterClaim.ref, expectedTransactionLockRef)
      ) {
        // 后期漂移：保留 claim 与已发布 winner，映射为 transaction-in-progress
        coded(LAUNCHAGENT_LIFECYCLE_CODES.TRANSACTION_IN_PROGRESS);
      }

      // 7. 若有旧锁：再次验证 old ref → unlink → fsync metadataRoot
      if (expectedTransactionLockRef !== null) {
        await verifyLockRefAgainstLeaf(
          expectedTransactionLockRef,
          TRANSACTION_LOCK_KIND,
          TRANSACTION_LOCK_LEAF,
        );
        await unlinkOwnedLeaf(TRANSACTION_LOCK_LEAF);
        await fsyncMetadataRoot();
      }

      // 8. durable O_EXCL 发布 fresh transaction.lock；禁止覆盖/内部重试
      await durableWriteLeaf(
        join(metadataRoot, TRANSACTION_LOCK_LEAF),
        metadataRoot,
        freshBytes,
        freshSha,
        'transaction-lock',
        LAUNCHAGENT_LIFECYCLE_CODES.TRANSACTION_IN_PROGRESS,
      );

      // 9. 再验证 fresh ref、MIR、own claim
      await verifyLockRefAgainstLeaf(
        freshTransactionLockRef,
        TRANSACTION_LOCK_KIND,
        TRANSACTION_LOCK_LEAF,
      );
      await verifyLockRefAgainstLeaf(
        manualInterventionLockRef,
        MANUAL_INTERVENTION_LOCK_KIND,
        MANUAL_INTERVENTION_LOCK_LEAF,
      );
      await verifyLeafFile(claimPath, claimBytes, claimSha);

      // 10. 精确删除 own claim → fsync root → 验证 claim 缺失
      await unlinkOwnedLeaf(RECOVERY_CLAIM_LEAF);
      await fsyncMetadataRoot();
      if (await leafExists(RECOVERY_CLAIM_LEAF)) invalid();

      // 11. 返回深冻结 fresh transaction-lock ref
      return deepFreeze({
        kind: TRANSACTION_LOCK_KIND,
        transactionId: freshRecord.transactionId,
        ownerNonce: freshRecord.ownerNonce,
        sha256: freshSha,
      });
    });
  }

  async function acquireTransactionLock(input) {
    return withLifecycleErrors(async () => {
      await assertBoundRootLayout();
      const projection = validateLockRecord(input);
      const bytes = serializeLockRecord(projection);
      const expectedSha = sha256Hex(bytes);

      // mutation 前：任意 MIR leaf 存在即阻断，不触碰 transaction.lock
      if (await leafExists(MANUAL_INTERVENTION_LOCK_LEAF)) {
        coded(LAUNCHAGENT_LIFECYCLE_CODES.MANUAL_INTERVENTION_REQUIRED);
      }

      const targetPath = join(metadataRoot, TRANSACTION_LOCK_LEAF);
      await durableWriteLeaf(
        targetPath,
        metadataRoot,
        bytes,
        expectedSha,
        'transaction-lock',
        LAUNCHAGENT_LIFECYCLE_CODES.TRANSACTION_IN_PROGRESS,
      );

      return deepFreeze({
        kind: TRANSACTION_LOCK_KIND,
        transactionId: projection.transactionId,
        ownerNonce: projection.ownerNonce,
        sha256: expectedSha,
      });
    });
  }

  async function verifyTransactionLock(ref) {
    return withLifecycleErrors(async () => {
      await assertBoundRootLayout();
      await verifyLockRefAgainstLeaf(ref, TRANSACTION_LOCK_KIND, TRANSACTION_LOCK_LEAF);
      return true;
    });
  }

  /**
   * 释放 transaction.lock。
   * - 普通路径：terminal journal（committed|recovered|no-change|blocked）+ 匹配收据；
   *   unlink 前再次重验锁身份，fsync root，发 lock-release。
   * - 唯一特殊 options `{ manualInterventionLockRef }`：最新 journal 必须为
   *   manual-intervention-required，双锁重验，仅删 transaction.lock，MIR 原样保留。
   * - 空对象 / 多余键 / 伪造 ref → INVALID 且不变更磁盘。
   */
  async function releaseTransactionLock(ref, options) {
    return withLifecycleErrors(async () => {
      await assertBoundRootLayout();

      // 特殊 MIR handoff：唯一允许的 options 形状（精确单键 manualInterventionLockRef）
      if (arguments.length > 1) {
        const optFields = readExactObject(options, ['manualInterventionLockRef']);
        const mirRef = optFields.manualInterventionLockRef;

        const txProjection = await verifyLockRefAgainstLeaf(
          ref,
          TRANSACTION_LOCK_KIND,
          TRANSACTION_LOCK_LEAF,
        );
        const mirProjection = await verifyLockRefAgainstLeaf(
          mirRef,
          MANUAL_INTERVENTION_LOCK_KIND,
          MANUAL_INTERVENTION_LOCK_LEAF,
        );
        if (txProjection.transactionId !== mirProjection.transactionId) invalid();

        const snapshot = await loadJournalSnapshot();
        if (!snapshot.present) invalid();
        const latest = latestJournalEntryFor(
          snapshot.entries,
          txProjection.transactionId,
        );
        if (latest === null) invalid();
        if (latest.state !== 'manual-intervention-required') invalid();
        if (latest.transactionId !== txProjection.transactionId) invalid();

        // unlink 前再次严格重验二者
        await verifyLockRefAgainstLeaf(
          ref,
          TRANSACTION_LOCK_KIND,
          TRANSACTION_LOCK_LEAF,
        );
        await verifyLockRefAgainstLeaf(
          mirRef,
          MANUAL_INTERVENTION_LOCK_KIND,
          MANUAL_INTERVENTION_LOCK_LEAF,
        );

        await unlinkOwnedLeaf(TRANSACTION_LOCK_LEAF);
        await fsyncMetadataRoot();
        emitDurability('lock-release', TRANSACTION_LOCK_KIND);
        return true;
      }

      // 普通路径：kind 必须在 leaf I/O 前失败（verify 内部先查 kind）
      const lockProjection = await verifyLockRefAgainstLeaf(
        ref,
        TRANSACTION_LOCK_KIND,
        TRANSACTION_LOCK_LEAF,
      );
      const transactionId = lockProjection.transactionId;

      const snapshot = await loadJournalSnapshot();
      if (!snapshot.present) invalid();
      const latest = latestJournalEntryFor(snapshot.entries, transactionId);
      if (latest === null) invalid();
      if (!TERMINAL_JOURNAL_STATES.has(latest.state)) invalid();

      const receipt = await loadValidatedReceipt(transactionId);
      assertReceiptMatchesTerminal(receipt.projection, receipt.sha256, latest);

      // 就在 unlink 前再次验证锁身份
      await verifyLockRefAgainstLeaf(
        ref,
        TRANSACTION_LOCK_KIND,
        TRANSACTION_LOCK_LEAF,
      );

      await unlinkOwnedLeaf(TRANSACTION_LOCK_LEAF);
      await fsyncMetadataRoot();
      emitDurability('lock-release', TRANSACTION_LOCK_KIND);
      return true;
    });
  }

  /**
   * MIR handoff：要求现有 transaction.lock 严格有效（同 transactionId、不同 ownerNonce）。
   * transaction.lock 不存在或无效 → 立即 INVALID，不创建 MIR；不改写已持有的 transaction.lock。
   */
  async function acquireManualInterventionLock(input) {
    return withLifecycleErrors(async () => {
      await assertBoundRootLayout();
      const projection = validateLockRecord(input);
      const bytes = serializeLockRecord(projection);
      const expectedSha = sha256Hex(bytes);

      // 必须已有严格有效的 transaction.lock；不存在则 INVALID，禁止 standalone MIR
      const existingTx = await readExistingLockProjection(TRANSACTION_LOCK_LEAF);
      if (existingTx === null) invalid();
      if (existingTx.transactionId !== projection.transactionId) invalid();
      if (existingTx.ownerNonce === projection.ownerNonce) invalid();

      const targetPath = join(metadataRoot, MANUAL_INTERVENTION_LOCK_LEAF);
      await durableWriteLeaf(
        targetPath,
        metadataRoot,
        bytes,
        expectedSha,
        'manual-intervention-lock',
        LAUNCHAGENT_LIFECYCLE_CODES.MANUAL_INTERVENTION_REQUIRED,
      );

      return deepFreeze({
        kind: MANUAL_INTERVENTION_LOCK_KIND,
        transactionId: projection.transactionId,
        ownerNonce: projection.ownerNonce,
        sha256: expectedSha,
      });
    });
  }

  async function verifyManualInterventionLock(ref) {
    return withLifecycleErrors(async () => {
      await assertBoundRootLayout();
      await verifyLockRefAgainstLeaf(
        ref,
        MANUAL_INTERVENTION_LOCK_KIND,
        MANUAL_INTERVENTION_LOCK_LEAF,
      );
      return true;
    });
  }

  /**
   * 释放 MIR 锁：最新 journal 只能 recovered|blocked，且必须有已严格重验、
   * 匹配 terminal 的收据；unlink 前再次验证锁身份。
   */
  async function releaseManualInterventionLock(ref) {
    return withLifecycleErrors(async () => {
      await assertBoundRootLayout();
      const lockProjection = await verifyLockRefAgainstLeaf(
        ref,
        MANUAL_INTERVENTION_LOCK_KIND,
        MANUAL_INTERVENTION_LOCK_LEAF,
      );
      const transactionId = lockProjection.transactionId;

      const snapshot = await loadJournalSnapshot();
      if (!snapshot.present) invalid();
      const latest = latestJournalEntryFor(snapshot.entries, transactionId);
      if (latest === null) invalid();
      if (!MIR_RELEASE_JOURNAL_STATES.has(latest.state)) invalid();

      const receipt = await loadValidatedReceipt(transactionId);
      assertReceiptMatchesTerminal(receipt.projection, receipt.sha256, latest);

      await verifyLockRefAgainstLeaf(
        ref,
        MANUAL_INTERVENTION_LOCK_KIND,
        MANUAL_INTERVENTION_LOCK_LEAF,
      );

      await unlinkOwnedLeaf(MANUAL_INTERVENTION_LOCK_LEAF);
      await fsyncMetadataRoot();
      emitDurability('lock-release', MANUAL_INTERVENTION_LOCK_KIND);
      return true;
    });
  }

  /**
   * 发布收据：闭合 {receipt, lockRef}；lock 可为 tx 或 MIR；
   * 最新 journal 只能 terminal（非 MIR-required），字段与收据精确对齐；
   * O_EXCL 持久写入 + 耐久三元组；返回闭合 receipt ref。
   */
  async function publishReceipt(input) {
    return withLifecycleErrors(async () => {
      await assertBoundRootLayout();
      const fields = readExactObject(input, ['receipt', 'lockRef']);

      const projection = validateLaunchAgentReceipt(fields.receipt);
      // manual-intervention-required 不可发布
      if (projection.state === 'manual-intervention-required') invalid();
      if (!TERMINAL_JOURNAL_STATES.has(projection.state)) invalid();

      const lockProjection = await verifyWriterOrMirLockRef(fields.lockRef);
      if (lockProjection.transactionId !== projection.transactionId) invalid();

      const snapshot = await loadJournalSnapshot();
      if (!snapshot.present) invalid();
      const latest = latestJournalEntryFor(
        snapshot.entries,
        projection.transactionId,
      );
      if (latest === null) invalid();
      if (!TERMINAL_JOURNAL_STATES.has(latest.state)) invalid();

      const bytes = Buffer.from(JSON.stringify(projection), 'utf8');
      if (bytes.byteLength > RECEIPT_MAX_BYTES) invalid();
      const expectedSha = sha256Hex(bytes);
      assertReceiptMatchesTerminal(projection, expectedSha, latest);

      const receiptsRoot = join(metadataRoot, RECEIPTS_MID_DIR);
      await assertOwnedDirectory(receiptsRoot);
      const targetPath = join(receiptsRoot, `${projection.transactionId}.json`);
      await durableWriteLeaf(
        targetPath,
        receiptsRoot,
        bytes,
        expectedSha,
        RECEIPT_ARTIFACT,
      );

      return deepFreeze({
        kind: 'receipt',
        transactionId: projection.transactionId,
        sha256: expectedSha,
      });
    });
  }

  /**
   * 读取收据：严格 UUID、路径安全、缺失/损坏/超限/模式漂移/符号链接 fail-closed；
   * 返回深冻结闭合投影。
   */
  async function readReceipt(transactionIdInput) {
    return withLifecycleErrors(async () => {
      await assertBoundRootLayout();
      const transactionId = requireUuid(transactionIdInput);
      const { projection } = await loadValidatedReceipt(transactionId);
      return projection;
    });
  }

  /**
   * 收据三态只读分类：严格 UUID 在任何 fs I/O（含 bound root/layout 复核）前
   * 闭合；bound root/layout 与 receipts 目录错误一律上抛（绝不吞成 receipt
   * invalid）；精确 leaf 仅 non-mutating lstat，ENOENT 为 missing；leaf 存在
   * 则走既有 strict loadValidatedReceipt，任何叶类型/模式/symlink/read/JSON/
   * schema/canonical bytes/transaction binding 错误均为 invalid。不写、不修复、
   * 不删除任何 artifact/lock；结果 exact/deep-frozen，仅 valid 携带 receipt 投影。
   */
  async function classifyReceipt(transactionIdInput) {
    return withLifecycleErrors(async () => {
      // 输入闭合先于一切 fs I/O：非法 UUID 连 root/layout lstat 都不得发生。
      const transactionId = requireUuid(transactionIdInput);
      await assertBoundRootLayout();
      const receiptsRoot = join(metadataRoot, RECEIPTS_MID_DIR);
      await assertOwnedDirectory(receiptsRoot);
      const targetPath = join(receiptsRoot, `${transactionId}.json`);
      try {
        await lstatPath(targetPath);
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          return deepFreeze({ status: 'missing' });
        }
        throw error;
      }
      try {
        const { projection } = await loadValidatedReceipt(transactionId);
        return deepFreeze({ status: 'valid', receipt: projection });
      } catch (error) {
        if (error instanceof LaunchAgentLifecycleError) {
          return deepFreeze({ status: 'invalid' });
        }
        throw error;
      }
    });
  }

  /**
   * 一次性消费确认：参数为直接 record；schema 投影在任何文件 I/O 前闭合。
   * 路径固定 confirmations/<confirmationId>.json；字节为投影精确 JSON.stringify UTF-8，≤256KiB。
   * O_EXCL durable leaf（0600、当前 uid）+ 耐久三元组 artifact=confirmation。
   * 任意目标 leaf 已存在（并发 loser / 同或不同有效绑定 replay / symlink|dir 占位 EEXIST）
   * → confirmation-consumed，不改原字节/模式，不泄露 EEXIST/路径。
   */
  async function consumeConfirmation(record) {
    return withLifecycleErrors(async () => {
      // 任意文件 I/O 前闭合投影；invalid 绝不触碰 confirmation leaf。
      const projection = validateLaunchAgentConsumedConfirmation(record);
      const bytes = Buffer.from(JSON.stringify(projection), 'utf8');
      if (bytes.byteLength > CONFIRMATION_MAX_BYTES) invalid();
      const expectedSha = sha256Hex(bytes);
      const confirmationId = projection.confirmationId;

      await assertBoundRootLayout();
      const confirmationsRoot = join(metadataRoot, CONFIRMATIONS_MID_DIR);
      await assertOwnedDirectory(confirmationsRoot);
      const targetPath = join(confirmationsRoot, `${confirmationId}.json`);
      await durableWriteLeaf(
        targetPath,
        confirmationsRoot,
        bytes,
        expectedSha,
        CONFIRMATION_ARTIFACT,
        LAUNCHAGENT_LIFECYCLE_CODES.CONFIRMATION_CONSUMED,
      );

      return deepFreeze({
        kind: 'consumed-confirmation',
        confirmationId,
        sha256: expectedSha,
      });
    });
  }

  /**
   * 读取已消费确认：严格 UUID；固定 confirmations/<id>.json；
   * readOwnedLeaf 先 size gate；解析 → validator 投影 → confirmationId 绑定 →
   * 投影精确 canonical bytes 比较。缺失/corrupt/extra/noncanonical/mode drift/
   * symlink/directory/oversize 全部 fail-closed，不修复；返回 validator 深冻结投影。
   */
  async function readConsumedConfirmation(confirmationIdInput) {
    return withLifecycleErrors(async () => {
      const confirmationId = requireUuid(confirmationIdInput);
      await assertBoundRootLayout();
      const confirmationsRoot = join(metadataRoot, CONFIRMATIONS_MID_DIR);
      await assertOwnedDirectory(confirmationsRoot);
      const targetPath = join(confirmationsRoot, `${confirmationId}.json`);
      const bytes = await readOwnedLeaf(targetPath, CONFIRMATION_MAX_BYTES);

      let parsed;
      try {
        parsed = JSON.parse(bytes.toString('utf8'));
      } catch {
        invalid();
      }
      const projection = validateLaunchAgentConsumedConfirmation(parsed);
      if (projection.confirmationId !== confirmationId) invalid();
      const expectedBytes = Buffer.from(JSON.stringify(projection), 'utf8');
      if (expectedBytes.byteLength > CONFIRMATION_MAX_BYTES) invalid();
      if (Buffer.compare(bytes, expectedBytes) !== 0) invalid();
      return projection;
    });
  }

  return Object.freeze({
    initialize,
    writeCandidate,
    readCandidate,
    writeAnchor,
    readAnchor,
    acquireTransactionLock,
    verifyTransactionLock,
    releaseTransactionLock,
    acquireManualInterventionLock,
    verifyManualInterventionLock,
    releaseManualInterventionLock,
    readTransactionLockObservation,
    readRecoveryClaimObservation,
    acquireRecoveryLockForManualRepair,
    appendJournal,
    readJournal,
    readJournalHeads,
    publishReceipt,
    readReceipt,
    classifyReceipt,
    consumeConfirmation,
    readConsumedConfirmation,
  });
}

/**
 * 生产 factory：仅接受 `{ metadataRoot }`，使用 node:fs/promises，durability sink 为 no-op。
 * @param {{ metadataRoot: string }} options
 */
export function createLaunchAgentMetadataStore(options) {
  const fields = readExactObject(options, ['metadataRoot']);
  const metadataRoot = requireAbsoluteRoot(fields.metadataRoot);
  requireNoFollowFlags();
  return createStore(metadataRoot, nodeFsPromises, () => {});
}

/**
 * 测试 factory：显式注入真实 fs promises namespace 与 durability 观察 sink。
 * @param {{ metadataRoot: string, fs: typeof nodeFsPromises, onDurabilityEvent: (event: object) => void }} options
 */
export function createLaunchAgentMetadataStoreForTest(options) {
  const fields = readExactObject(options, ['metadataRoot', 'fs', 'onDurabilityEvent']);
  const metadataRoot = requireAbsoluteRoot(fields.metadataRoot);
  if (fields.fs === null || typeof fields.fs !== 'object') invalid();
  if (typeof fields.fs.open !== 'function') invalid();
  if (typeof fields.fs.mkdir !== 'function') invalid();
  if (typeof fields.fs.lstat !== 'function') invalid();
  if (typeof fields.onDurabilityEvent !== 'function') invalid();
  requireNoFollowFlags();
  return createStore(metadataRoot, fields.fs, fields.onDurabilityEvent);
}
