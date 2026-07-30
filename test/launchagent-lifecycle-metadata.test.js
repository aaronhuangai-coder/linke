import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, lstat, readFile, chmod, symlink, rename, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fsPromises from 'node:fs/promises';
import * as metadataStoreModule from '../src/launchagent-lifecycle/metadata-store.js';
import {
  LaunchAgentLifecycleError,
  LAUNCHAGENT_LIFECYCLE_CODES,
  validateLaunchAgentJournal,
  validateLaunchAgentReceipt,
  validateLaunchAgentConsumedConfirmation,
} from '../src/launchagent-lifecycle/contracts.js';

const metadataStorePath = fileURLToPath(
  new URL('../src/launchagent-lifecycle/metadata-store.js', import.meta.url),
);

const EXPECTED_STORE_METHODS = Object.freeze([
  'initialize',
  'writeCandidate',
  'readCandidate',
  'writeAnchor',
  'readAnchor',
  'acquireTransactionLock',
  'verifyTransactionLock',
  'releaseTransactionLock',
  'acquireManualInterventionLock',
  'verifyManualInterventionLock',
  'releaseManualInterventionLock',
  'appendJournal',
  'readJournal',
  'readJournalHeads',
  'publishReceipt',
  'readReceipt',
  'consumeConfirmation',
  'readConsumedConfirmation',
]);

const FORBIDDEN_STORE_METHODS = Object.freeze([
  'writeFile',
  'rename',
  'unlink',
  'remove',
  'replace',
  'publishPath',
]);

const FIXED_MID_DIRS = Object.freeze(['candidates', 'anchors', 'receipts', 'confirmations']);
const ONE_MIB = 1024 * 1024;
const FOUR_MIB = 4 * 1024 * 1024;

/** Canonical UUIDs (lowercase, version 4 / RFC variant). */
const TX_ID = 'a1b2c3d4-e5f6-4789-8abc-def012345678';
const TX_ID_B = 'c3d4e5f6-a7b8-4901-acde-f01234567890';
const ANCHOR_ID = 'b2c3d4e5-f6a7-4890-9bcd-ef0123456789';
const OWNER_NONCE_A = 'd4e5f6a7-b8c9-4a12-bdef-012345678901';
const OWNER_NONCE_B = 'e5f6a7b8-c9d0-4b23-8ef0-123456789012';
const OWNER_NONCE_C = 'f6a7b8c9-d0e1-4c34-8f01-234567890123';
const OWNER_NONCE_MIR = 'a7b8c9d0-e1f2-4d45-8012-345678901234';
const SOURCE_COMMIT = '0123456789abcdef0123456789abcdef01234567';
const CREATED_AT = '2024-01-15T12:00:00.000Z';

const TRANSACTION_LOCK_LEAF = 'transaction.lock';
const MANUAL_INTERVENTION_LOCK_LEAF = 'manual-intervention.lock';
const JOURNAL_LEAF = 'transaction-journal.json';
const FIXED_OWNER_PID = 4242;
const SIXTEEN_MIB = 16 * 1024 * 1024;
const JOURNAL_LINE_MAX_BYTES = 256 * 1024;
/** Literal 64-hex receipt digest for terminal journal payload seeds (not derived). */
const RECEIPT_SHA256 =
  'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
const JOURNAL_AT = '2024-01-15T12:00:00.000Z';
const COMPLETED_AT = '2024-01-15T12:00:00.000Z';
const RECEIPT_MAX_BYTES = 256 * 1024;
const CONFIRMATION_MAX_BYTES = 256 * 1024;
const CONTROLLER_LABEL = 'com.linke.controller';
const SCHEDULER_LABEL = 'com.linke.scheduler';
/** Canonical UUIDs for durable consumed-confirmation fixtures (distinct acceptance vs confirmation). */
const CONFIRMATION_ID = 'f1a2b3c4-d5e6-4789-8abc-0123456789ab';
const CONFIRMATION_ID_B = 'a9b8c7d6-e5f4-4321-8fed-cba987654321';
const ACCEPTANCE_ID = 'a2b3c4d5-e6f7-4890-9bcd-123456789abc';
const ACCEPTANCE_ID_B = 'b3c4d5e6-f7a8-4901-acde-23456789abcd';
const RUNTIME_ARTIFACTS_SHA256 =
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
const CONSUMED_AT = '2024-01-15T12:00:00.000Z';

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isDeeplyFrozen(value) {
  if (value === null || typeof value !== 'object') return true;
  if (!Object.isFrozen(value)) return false;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) {
      if (!isDeeplyFrozen(descriptor.value)) return false;
    }
  }
  return true;
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (value === null || typeof value !== 'object') return out;
  if (Buffer.isBuffer(value)) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string') out.push(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) {
      collectStrings(descriptor.value, out);
    }
  }
  return out;
}

function assertNoAbsolutePaths(value, label) {
  for (const s of collectStrings(value)) {
    assert.notEqual(
      s.startsWith('/'),
      true,
      `${label} must not embed absolute path string: ${s}`,
    );
    assert.equal(
      s.includes(tmpdir()),
      false,
      `${label} must not embed temp root path: ${s}`,
    );
  }
}

function assertNoSensitiveEventFields(event) {
  const keys = Reflect.ownKeys(event).filter((k) => typeof k === 'string');
  for (const forbidden of ['path', 'home', 'uid', 'bytes']) {
    assert.equal(
      keys.includes(forbidden),
      false,
      `durability event must not expose field "${forbidden}"`,
    );
  }
  assertNoAbsolutePaths(event, 'durability event');
}

function ownEnumerableMethodNames(store) {
  return Reflect.ownKeys(store)
    .filter((key) => typeof key === 'string')
    .filter((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(store, key);
      return (
        descriptor
        && descriptor.enumerable
        && typeof descriptor.value === 'function'
      );
    })
    .sort();
}

function minimalFirstInstallAnchor(overrides = {}) {
  return {
    schemaVersion: 1,
    anchorId: ANCHOR_ID,
    parentAnchorId: null,
    transactionId: TX_ID,
    sourceCommit: SOURCE_COMMIT,
    purpose: 'first-install',
    rollbackFromManifestSha256: null,
    restoreManifestSha256: null,
    controller: { priorState: 'absent' },
    scheduler: { priorState: 'absent' },
    manifest: { priorState: 'absent' },
    loaded: { controller: false, scheduler: false },
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function candidateLeafName(role) {
  if (role === 'controller') return 'controller.plist';
  if (role === 'scheduler') return 'scheduler.plist';
  if (role === 'manifest') return 'active-manifest.json';
  throw new Error(`unexpected role for path helper: ${role}`);
}

async function makeTempMetadataRoot(t) {
  // Temp container only; return a metadataRoot path that does not exist yet so
  // initialize() is exercised as the creator of the root (mode 0700), not a
  // filler of an already-present directory.
  const container = await mkdtemp(join(tmpdir(), 'linke-la-meta-'));
  t.after(async () => {
    await rm(container, { recursive: true, force: true });
  });
  return join(container, 'metadata');
}

function requireFactory(name) {
  const factory = metadataStoreModule[name];
  assert.equal(typeof factory, 'function', `expected ${name} to be a function export`);
  return factory;
}

/**
 * 注册 Task 2.5 行为用例前的无 I/O capability probe。
 * 当前 RED 只由 frozen store surface 缺少 readJournalHeads 触发；
 * production method 出现后才注册完整行为矩阵，避免 TypeError 假 RED。
 */
function hasReadJournalHeadsMethod() {
  const factory = metadataStoreModule.createLaunchAgentMetadataStore;
  if (typeof factory !== 'function') return false;
  try {
    const store = factory({
      metadataRoot: join(tmpdir(), 'linke-la-read-journal-heads-method-probe'),
    });
    return typeof store.readJournalHeads === 'function';
  } catch {
    return false;
  }
}

const HAS_READ_JOURNAL_HEADS = hasReadJournalHeadsMethod();

/**
 * 为只读接口提供窄 mutation trace；所有 FileHandle 方法都绑定原对象，
 * 仅记录可能写入、改模式或触发耐久化的调用。
 */
function createMutationTracingFs(mutations) {
  const fsMutators = new Set([
    'appendFile', 'chmod', 'chown', 'mkdir', 'rename', 'rm', 'rmdir',
    'truncate', 'unlink', 'writeFile',
  ]);
  const handleMutators = new Set([
    'appendFile', 'chmod', 'chown', 'datasync', 'sync', 'truncate', 'write', 'writeFile',
  ]);

  return new Proxy(fsPromises, {
    get(target, property, receiver) {
      if (property === 'open') {
        return async (...args) => {
          const handle = await target.open(...args);
          return new Proxy(handle, {
            get(handleTarget, handleProperty) {
              const value = Reflect.get(handleTarget, handleProperty, handleTarget);
              if (typeof value !== 'function') return value;
              return (...methodArgs) => {
                if (handleMutators.has(handleProperty)) {
                  mutations.push(`handle.${String(handleProperty)}`);
                }
                return value.apply(handleTarget, methodArgs);
              };
            },
          });
        };
      }

      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (fsMutators.has(property)) mutations.push(`fs.${String(property)}`);
        return value.apply(target, args);
      };
    },
  });
}

function identityUnavailable() {
  return { available: false, value: null };
}

function identityAvailable(value) {
  return { available: true, value };
}

/** Canonical lock record plain object (exact keys) for acquire*Lock inputs. */
function validLockRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    transactionId: TX_ID,
    ownerPid: FIXED_OWNER_PID,
    ownerNonce: OWNER_NONCE_A,
    bootSessionIdentity: identityUnavailable(),
    processStartIdentity: identityUnavailable(),
    ...overrides,
  };
}

function isLifecycleErrorWithCode(error, code) {
  return (
    error instanceof LaunchAgentLifecycleError
    && error.code === code
    && error.message === code
  );
}

function isInvalidLifecycleError(error) {
  return isLifecycleErrorWithCode(error, LAUNCHAGENT_LIFECYCLE_CODES.INVALID);
}

/**
 * Independent journal entry hash (test-side): closed projection fields excluding entrySha256,
 * UTF-8 JSON.stringify of fixed-key plain object, SHA-256 hex.
 */
function computeJournalEntrySha256({
  schemaVersion,
  transactionId,
  sequence,
  previousEntrySha256,
  operation,
  state,
  at,
  payload,
}) {
  const plain = {
    schemaVersion,
    transactionId,
    sequence,
    previousEntrySha256,
    operation,
    state,
    at,
    payload,
  };
  return sha256Hex(Buffer.from(JSON.stringify(plain), 'utf8'));
}

/**
 * Build a complete journal entry projection with test-computed entrySha256.
 * Defaults: operation install / state prepared / canonical UTC / payload {hostMutationCount:0}.
 */
function buildJournalEntry(overrides = {}) {
  const {
    entrySha256: entrySha256Override,
    ...rest
  } = overrides;
  const fields = {
    schemaVersion: 1,
    transactionId: TX_ID,
    sequence: 0,
    previousEntrySha256: null,
    operation: 'install',
    state: 'prepared',
    at: JOURNAL_AT,
    payload: { hostMutationCount: 0 },
    ...rest,
  };
  const entrySha256 = entrySha256Override ?? computeJournalEntrySha256(fields);
  return {
    schemaVersion: fields.schemaVersion,
    transactionId: fields.transactionId,
    sequence: fields.sequence,
    previousEntrySha256: fields.previousEntrySha256,
    entrySha256,
    operation: fields.operation,
    state: fields.state,
    at: fields.at,
    payload: fields.payload,
  };
}

function journalLineBuffer(entry) {
  return Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8');
}

/**
 * Exact valid LaunchAgent receipt plain object (closed projection keys).
 * Defaults: install / committed / success true / outcome completed /
 * controller+scheduler created/changed true / SOURCE_COMMIT / TX_ID / ANCHOR_ID /
 * COMPLETED_AT / hostMutationCount 2.
 */
function buildReceipt(overrides = {}) {
  const {
    roles: rolesOverride,
    ...rest
  } = overrides;
  const roles = {
    controller: {
      label: CONTROLLER_LABEL,
      outcome: 'created',
      changed: true,
      ...(rolesOverride && rolesOverride.controller ? rolesOverride.controller : {}),
    },
    scheduler: {
      label: SCHEDULER_LABEL,
      outcome: 'created',
      changed: true,
      ...(rolesOverride && rolesOverride.scheduler ? rolesOverride.scheduler : {}),
    },
  };
  return {
    schemaVersion: 1,
    operation: 'install',
    state: 'committed',
    success: true,
    sourceCommit: SOURCE_COMMIT,
    transactionId: TX_ID,
    anchorId: ANCHOR_ID,
    completedAt: COMPLETED_AT,
    roles,
    hostMutationCount: 2,
    outcome: 'completed',
    ...rest,
    roles,
  };
}

/**
 * Test-side independent UTF-8 JSON bytes for a receipt projection
 * (fixed key order matching validateLaunchAgentReceipt).
 */
function receiptBytes(receipt) {
  const plain = {
    schemaVersion: receipt.schemaVersion,
    operation: receipt.operation,
    state: receipt.state,
    success: receipt.success,
    sourceCommit: receipt.sourceCommit,
    transactionId: receipt.transactionId,
    anchorId: receipt.anchorId,
    completedAt: receipt.completedAt,
    roles: {
      controller: {
        label: receipt.roles.controller.label,
        outcome: receipt.roles.controller.outcome,
        changed: receipt.roles.controller.changed,
      },
      scheduler: {
        label: receipt.roles.scheduler.label,
        outcome: receipt.roles.scheduler.outcome,
        changed: receipt.roles.scheduler.changed,
      },
    },
    hostMutationCount: receipt.hostMutationCount,
    outcome: receipt.outcome,
  };
  return Buffer.from(JSON.stringify(plain), 'utf8');
}

function receiptSha(receipt) {
  return sha256Hex(receiptBytes(receipt));
}

function receiptLeafPath(metadataRoot, transactionId = TX_ID) {
  return join(metadataRoot, 'receipts', `${transactionId}.json`);
}

/**
 * Exact valid consumed-confirmation plain object (closed projection keys).
 * confirmationId !== acceptanceId required by validateLaunchAgentConsumedConfirmation.
 */
function buildConsumedConfirmation(overrides = {}) {
  return {
    schemaVersion: 1,
    confirmationId: CONFIRMATION_ID,
    acceptanceId: ACCEPTANCE_ID,
    sourceCommit: SOURCE_COMMIT,
    runtimeArtifactsSha256: RUNTIME_ARTIFACTS_SHA256,
    consumedAt: CONSUMED_AT,
    ...overrides,
  };
}

/**
 * Test-side independent UTF-8 JSON bytes for a consumed-confirmation projection
 * (fixed key order matching validateLaunchAgentConsumedConfirmation).
 */
function consumedConfirmationBytes(record) {
  const plain = {
    schemaVersion: record.schemaVersion,
    confirmationId: record.confirmationId,
    acceptanceId: record.acceptanceId,
    sourceCommit: record.sourceCommit,
    runtimeArtifactsSha256: record.runtimeArtifactsSha256,
    consumedAt: record.consumedAt,
  };
  return Buffer.from(JSON.stringify(plain), 'utf8');
}

function consumedConfirmationSha(record) {
  return sha256Hex(consumedConfirmationBytes(record));
}

function confirmationLeafPath(metadataRoot, confirmationId = CONFIRMATION_ID) {
  return join(metadataRoot, 'confirmations', `${confirmationId}.json`);
}

function isConfirmationConsumedError(error) {
  return isLifecycleErrorWithCode(
    error,
    LAUNCHAGENT_LIFECYCLE_CODES.CONFIRMATION_CONSUMED,
  );
}

/**
 * Terminal-tx setup: initialize → acquire tx lock → prepared seq0 →
 * terminal seq1 with payload.receiptSha256 of exact receipt bytes.
 * Does not encode business transition validity beyond the Task2 chain.
 */
async function setupTerminalTransaction(store, options = {}) {
  const receipt = options.receipt ?? buildReceipt();
  const terminalState = options.terminalState ?? receipt.state;
  const hostMutationCount = options.hostMutationCount ?? receipt.hostMutationCount;
  const lockRecord = options.lockRecord ?? validLockRecord({
    transactionId: receipt.transactionId,
    ownerNonce: OWNER_NONCE_A,
  });
  const atTerminal = options.atTerminal ?? '2024-01-15T12:00:01.000Z';

  await store.initialize();
  const writerLockRef = await store.acquireTransactionLock(lockRecord);

  const prepared = buildJournalEntry({
    transactionId: receipt.transactionId,
    sequence: 0,
    previousEntrySha256: null,
    operation: receipt.operation,
    state: 'prepared',
    at: JOURNAL_AT,
    payload: { hostMutationCount: 0 },
  });
  await store.appendJournal({
    entry: prepared,
    expectedPrior: null,
    writerLockRef,
  });

  const hash = receiptSha(receipt);
  const payload = terminalState === 'blocked'
    ? {
      hostMutationCount,
      receiptSha256: hash,
      blockedByEntrySha256: Object.hasOwn(options, 'blockedByEntrySha256')
        ? options.blockedByEntrySha256
        : null,
    }
    : {
      hostMutationCount,
      receiptSha256: hash,
    };

  const terminal = buildJournalEntry({
    transactionId: receipt.transactionId,
    sequence: 1,
    previousEntrySha256: prepared.entrySha256,
    operation: receipt.operation,
    state: terminalState,
    at: atTerminal,
    payload,
  });
  await store.appendJournal({
    entry: terminal,
    expectedPrior: priorRefFromEntry(prepared),
    writerLockRef,
  });

  return {
    writerLockRef,
    prepared,
    terminal,
    receipt,
    receiptHash: hash,
    lockRecord,
  };
}

function journalLeafPath(metadataRoot) {
  return join(metadataRoot, JOURNAL_LEAF);
}

async function assertNoJournalLeaf(metadataRoot) {
  await assert.rejects(
    () => access(journalLeafPath(metadataRoot)),
    (error) => error && error.code === 'ENOENT',
    'pre/post condition: transaction-journal.json must not exist',
  );
}

async function readJournalLeafBytes(metadataRoot) {
  return readFile(journalLeafPath(metadataRoot));
}

/**
 * 只读捕获 metadata 临时根的稳定文件树；忽略 atime，仅比较身份、模式、大小、mtime 与内容 hash。
 */
async function snapshotMetadataTree(metadataRoot) {
  const snapshot = [];

  async function visit(relativePath) {
    const absolutePath = relativePath === ''
      ? metadataRoot
      : join(metadataRoot, relativePath);
    const names = (await readdir(absolutePath)).sort();
    for (const name of names) {
      const childRelative = relativePath === '' ? name : join(relativePath, name);
      const childAbsolute = join(metadataRoot, childRelative);
      const st = await lstat(childAbsolute);
      const common = {
        relativePath: childRelative,
        mode: st.mode,
        uid: st.uid,
        size: st.size,
        mtimeMs: st.mtimeMs,
        ctimeMs: st.ctimeMs,
        device: st.dev,
        inode: st.ino,
      };
      if (st.isDirectory()) {
        snapshot.push({ ...common, type: 'directory' });
        await visit(childRelative);
      } else if (st.isFile()) {
        snapshot.push({
          ...common,
          type: 'file',
          sha256: sha256Hex(await readFile(childAbsolute)),
        });
      } else if (st.isSymbolicLink()) {
        snapshot.push({ ...common, type: 'symlink' });
      } else {
        snapshot.push({ ...common, type: 'other' });
      }
    }
  }

  await visit('');
  return snapshot;
}

async function assertJournalLeafMode(metadataRoot) {
  const leafPath = journalLeafPath(metadataRoot);
  const leafStat = await lstat(leafPath);
  assert.equal(leafStat.isFile(), true, `${JOURNAL_LEAF} must be a regular file`);
  assert.equal(leafStat.isSymbolicLink(), false, `${JOURNAL_LEAF} must not be a symlink`);
  assert.equal(leafStat.mode & 0o777, 0o600, `${JOURNAL_LEAF} must be mode 0600`);
  assert.equal(leafStat.uid, process.getuid(), `${JOURNAL_LEAF} owner must be current uid`);
  return leafStat;
}

function priorRefFromEntry(entry) {
  return {
    transactionId: entry.transactionId,
    sequence: entry.sequence,
    entrySha256: entry.entrySha256,
  };
}

function assertClosedJournalReturn(ref, entry) {
  assert.deepEqual(ref, {
    kind: 'journal-entry',
    transactionId: entry.transactionId,
    sequence: entry.sequence,
    entrySha256: entry.entrySha256,
  });
  assert.equal(isDeeplyFrozen(ref), true, 'appendJournal result must be deeply frozen');
  assertNoAbsolutePaths(ref, 'appendJournal result');
  const keys = Reflect.ownKeys(ref).filter((k) => typeof k === 'string').sort();
  assert.deepEqual(
    keys,
    ['entrySha256', 'kind', 'sequence', 'transactionId'].sort(),
    'appendJournal result must be closed to kind/transactionId/sequence/entrySha256',
  );
}

function assertClosedDurabilityEvent(event, expectedArtifact) {
  assert.equal(event === null || typeof event !== 'object', false, 'durability event must be an object');
  assert.equal(isDeeplyFrozen(event), true, 'durability event must be deeply frozen');
  assert.deepEqual(
    Reflect.ownKeys(event).filter((key) => typeof key === 'string').sort(),
    ['artifact', 'kind'].sort(),
    'lock durability event must be closed to kind and artifact only',
  );
  assert.equal(event.artifact, expectedArtifact);
  assertNoSensitiveEventFields(event);
}

function assertLockDurabilityOrder(events, artifact) {
  const lockEvents = events.filter((event) => event && event.artifact === artifact);
  assert.ok(
    lockEvents.length >= 3,
    `successful ${artifact} acquire must emit at least three durability events`,
  );

  const fileSyncIndex = lockEvents.findIndex(
    (event) => event.kind === 'file-sync' && event.artifact === artifact,
  );
  const directorySyncIndex = lockEvents.findIndex(
    (event) => event.kind === 'directory-sync' && event.artifact === artifact,
  );
  const verifyIndex = lockEvents.findIndex(
    (event) => event.kind === 'verify' && event.artifact === artifact,
  );

  assert.notEqual(fileSyncIndex, -1, `must observe file-sync ${artifact} event`);
  assert.notEqual(directorySyncIndex, -1, `must observe directory-sync ${artifact} event`);
  assert.notEqual(verifyIndex, -1, `must observe verify ${artifact} event`);
  assert.ok(
    fileSyncIndex < directorySyncIndex,
    `file-sync ${artifact} must occur before directory-sync ${artifact}`,
  );
  assert.ok(
    directorySyncIndex < verifyIndex,
    `directory-sync ${artifact} must occur before verify ${artifact}`,
  );

  for (const event of lockEvents) {
    assertClosedDurabilityEvent(event, artifact);
  }
}

async function assertNoLockLeaf(metadataRoot, leafName) {
  await assert.rejects(
    () => access(join(metadataRoot, leafName)),
    (error) => error && error.code === 'ENOENT',
    `pre/post condition: ${leafName} must not exist`,
  );
}

async function readLockLeafBytes(metadataRoot, leafName) {
  return readFile(join(metadataRoot, leafName));
}

async function assertOwnedLockLeaf(metadataRoot, leafName, expectedRecord) {
  const leafPath = join(metadataRoot, leafName);
  const leafStat = await lstat(leafPath);
  assert.equal(leafStat.isFile(), true, `${leafName} must be a regular file`);
  assert.equal(leafStat.isSymbolicLink(), false, `${leafName} must not be a symlink`);
  assert.equal(leafStat.mode & 0o777, 0o600, `${leafName} must be mode 0600`);
  assert.equal(leafStat.uid, process.getuid(), `${leafName} owner must be current uid`);

  const onDisk = await readFile(leafPath);
  const parsed = JSON.parse(onDisk.toString('utf8'));
  assert.deepEqual(parsed, expectedRecord, `${leafName} JSON must deep-equal input record`);
  assertNoAbsolutePaths(parsed, `${leafName} on-disk record`);
  return onDisk;
}

test('metadata-store implementation module missing: explicit existence assertion fails', async () => {
  let moduleExists = false;
  try {
    await access(metadataStorePath);
    moduleExists = true;
  } catch {
    moduleExists = false;
  }

  assert.equal(
    moduleExists,
    true,
    'expected src/launchagent-lifecycle/metadata-store.js to exist before metadata-store behavior tests',
  );
});

test('createLaunchAgentMetadataStore factory missing: production factory must be a function', () => {
  assert.equal(
    typeof metadataStoreModule.createLaunchAgentMetadataStore,
    'function',
    'expected createLaunchAgentMetadataStore factory export',
  );
});

test('createLaunchAgentMetadataStoreForTest factory missing: test factory must be a function', () => {
  assert.equal(
    typeof metadataStoreModule.createLaunchAgentMetadataStoreForTest,
    'function',
    'expected createLaunchAgentMetadataStoreForTest factory export',
  );
});

test('store own enumerable methods break contract: surface must match frozen method list exactly', async (t) => {
  const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeTempMetadataRoot(t);
  const store = createLaunchAgentMetadataStore({ metadataRoot });
  assert.equal(store === null || typeof store !== 'object', false, 'factory must return a store object');

  const methods = ownEnumerableMethodNames(store);
  assert.equal(
    methods.includes('readJournalHeads'),
    true,
    'Task 2.5 RED: store.readJournalHeads must exist before behavior tests run',
  );
  assert.deepEqual(
    methods,
    [...EXPECTED_STORE_METHODS].sort(),
    'store own enumerable methods must be exactly the frozen lifecycle surface',
  );

  for (const forbidden of FORBIDDEN_STORE_METHODS) {
    assert.equal(
      typeof store[forbidden],
      'undefined',
      `store must not expose raw fs mutation method ${forbidden}`,
    );
  }
});

test('initialize layout break: must create metadataRoot and fixed mid dirs mode 0700 owned by current uid', async (t) => {
  const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeTempMetadataRoot(t);
  const store = createLaunchAgentMetadataStore({ metadataRoot });
  assert.equal(typeof store.initialize, 'function', 'store.initialize must be a function');

  // Precondition: metadataRoot must not exist before initialize creates it.
  await assert.rejects(
    () => access(metadataRoot),
    (error) => error && error.code === 'ENOENT',
    'precondition: metadataRoot must not exist before initialize',
  );

  const result = await store.initialize();

  assert.deepEqual(result, { rootId: 'linke-launchagent-lifecycle-metadata' });
  assert.equal(isDeeplyFrozen(result), true, 'initialize result must be deeply frozen');
  assertNoAbsolutePaths(result, 'initialize result');

  const rootStat = await lstat(metadataRoot);
  assert.equal(rootStat.isDirectory(), true, 'metadataRoot must be a directory');
  assert.equal(rootStat.mode & 0o777, 0o700, 'metadataRoot must be mode 0700');
  assert.equal(rootStat.uid, process.getuid(), 'metadataRoot owner must be current uid');

  for (const dir of FIXED_MID_DIRS) {
    const midPath = join(metadataRoot, dir);
    const midStat = await lstat(midPath);
    assert.equal(midStat.isDirectory(), true, `${dir} must be a directory`);
    assert.equal(midStat.mode & 0o777, 0o700, `${dir} must be mode 0700`);
    assert.equal(midStat.uid, process.getuid(), `${dir} owner must be current uid`);
  }
});

test('writeCandidate layout break: role leaf path mode and ownership must match fixed candidate contract', async (t) => {
  const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeTempMetadataRoot(t);
  const store = createLaunchAgentMetadataStore({ metadataRoot });
  await store.initialize();

  assert.equal(typeof store.writeCandidate, 'function', 'store.writeCandidate must be a function');
  assert.equal(typeof store.readCandidate, 'function', 'store.readCandidate must be a function');

  const roles = [
    { role: 'controller', bytes: Buffer.from('controller-plist-bytes-v1') },
    { role: 'scheduler', bytes: Buffer.from('scheduler-plist-bytes-v1') },
    { role: 'manifest', bytes: Buffer.from('{"manifest":true}') },
  ];

  for (const { role, bytes } of roles) {
    const expectedSha = sha256Hex(bytes);
    const ref = await store.writeCandidate({ transactionId: TX_ID, role, bytes });

    assert.deepEqual(ref, {
      kind: 'candidate',
      transactionId: TX_ID,
      role,
      sha256: expectedSha,
    });
    assert.equal(isDeeplyFrozen(ref), true, `writeCandidate(${role}) result must be deeply frozen`);
    assertNoAbsolutePaths(ref, `writeCandidate(${role}) result`);

    const txDir = join(metadataRoot, 'candidates', TX_ID);
    const txStat = await lstat(txDir);
    assert.equal(txStat.isDirectory(), true, 'per-transaction candidate dir must exist');
    assert.equal(txStat.mode & 0o777, 0o700, 'per-transaction candidate dir must be mode 0700');
    assert.equal(txStat.uid, process.getuid(), 'per-transaction candidate dir owner must be current uid');

    const leafPath = join(txDir, candidateLeafName(role));
    const leafStat = await lstat(leafPath);
    assert.equal(leafStat.isFile(), true, `${role} candidate must be a regular file`);
    assert.equal(leafStat.isSymbolicLink(), false, `${role} candidate must not be a symlink`);
    assert.equal(leafStat.mode & 0o777, 0o600, `${role} candidate leaf must be mode 0600`);
    assert.equal(leafStat.uid, process.getuid(), `${role} candidate leaf owner must be current uid`);

    const onDisk = await readFile(leafPath);
    assert.equal(Buffer.compare(onDisk, bytes), 0, `${role} candidate bytes on disk must match input`);

    const readBack = await store.readCandidate(ref);
    assert.equal(Buffer.isBuffer(readBack), true, 'readCandidate must return a Buffer');
    assert.equal(Buffer.compare(readBack, bytes), 0, 'readCandidate must return exact candidate bytes');
    assert.notEqual(readBack, bytes, 'readCandidate must return a detached Buffer, not the input reference');
    readBack[0] = readBack[0] ^ 0xff;
    const reread = await store.readCandidate(ref);
    assert.equal(Buffer.compare(reread, bytes), 0, 'mutating readCandidate buffer must not alter stored bytes');
  }
});

test('writeCandidate no-clobber break: second write of different bytes to same target must reject and leave first byte intact', async (t) => {
  const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeTempMetadataRoot(t);
  const store = createLaunchAgentMetadataStore({ metadataRoot });
  await store.initialize();

  const first = Buffer.from('first-candidate-bytes');
  const second = Buffer.from('second-candidate-bytes-different');
  assert.notEqual(Buffer.compare(first, second), 0);

  const ref = await store.writeCandidate({
    transactionId: TX_ID,
    role: 'controller',
    bytes: first,
  });
  assert.equal(ref.sha256, sha256Hex(first));

  await assert.rejects(
    () => store.writeCandidate({
      transactionId: TX_ID,
      role: 'controller',
      bytes: second,
    }),
    (error) => error instanceof Error,
    'second writeCandidate to same target with different bytes must reject',
  );

  const leafPath = join(metadataRoot, 'candidates', TX_ID, 'controller.plist');
  const onDisk = await readFile(leafPath);
  assert.equal(onDisk[0], first[0], 'first byte of original candidate must remain unchanged after rejected clobber');
  assert.equal(Buffer.compare(onDisk, first), 0, 'original candidate bytes must remain completely unchanged');
});

test('writeCandidate validation break: invalid UUID absolute path LaunchAgents role and oversized bytes must reject before mutation', async (t) => {
  const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeTempMetadataRoot(t);
  const store = createLaunchAgentMetadataStore({ metadataRoot });
  await store.initialize();

  const validBytes = Buffer.from('valid-bytes');

  await assert.rejects(
    () => store.writeCandidate({
      transactionId: 'not-a-uuid',
      role: 'controller',
      bytes: validBytes,
    }),
    (error) => error instanceof Error,
    'non-canonical transactionId must reject',
  );

  await assert.rejects(
    () => store.writeCandidate({
      transactionId: '/absolute/not-a-uuid',
      role: 'controller',
      bytes: validBytes,
    }),
    (error) => error instanceof Error,
    'absolute-path shaped transactionId must reject',
  );

  await assert.rejects(
    () => store.writeCandidate({
      transactionId: TX_ID,
      role: 'com.linke.controller.plist',
      bytes: validBytes,
    }),
    (error) => error instanceof Error,
    'LaunchAgents basename role must reject',
  );

  await assert.rejects(
    () => store.writeCandidate({
      transactionId: TX_ID,
      role: 'controller',
      bytes: Buffer.alloc(ONE_MIB + 1, 0x61),
    }),
    (error) => error instanceof Error,
    'bytes larger than 1 MiB must reject before mutation',
  );

  const candidatesRoot = join(metadataRoot, 'candidates');
  const afterInvalid = await lstat(candidatesRoot);
  assert.equal(afterInvalid.isDirectory(), true);
  await assert.rejects(
    () => access(join(candidatesRoot, TX_ID)),
    (error) => error && error.code === 'ENOENT',
    'rejected writeCandidate must not create per-transaction candidate directory',
  );
  await assert.rejects(
    () => access(join(candidatesRoot, 'not-a-uuid')),
    (error) => error && error.code === 'ENOENT',
    'rejected invalid UUID must not create a candidate path segment',
  );
});

test('writeAnchor and readAnchor break: minimal first-install anchor must persist mode 0600 and return frozen projection', async (t) => {
  const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeTempMetadataRoot(t);
  const store = createLaunchAgentMetadataStore({ metadataRoot });
  await store.initialize();

  assert.equal(typeof store.writeAnchor, 'function', 'store.writeAnchor must be a function');
  assert.equal(typeof store.readAnchor, 'function', 'store.readAnchor must be a function');

  const anchor = minimalFirstInstallAnchor();
  const serialized = Buffer.from(JSON.stringify(anchor), 'utf8');
  assert.ok(serialized.byteLength <= FOUR_MIB, 'fixture must stay within 4 MiB anchor cap');
  const expectedSha = sha256Hex(serialized);

  const ref = await store.writeAnchor(anchor);
  assert.deepEqual(ref, {
    kind: 'anchor',
    anchorId: ANCHOR_ID,
    sha256: expectedSha,
  });
  assert.equal(isDeeplyFrozen(ref), true, 'writeAnchor result must be deeply frozen');
  assertNoAbsolutePaths(ref, 'writeAnchor result');

  const anchorPath = join(metadataRoot, 'anchors', `${ANCHOR_ID}.json`);
  const anchorStat = await lstat(anchorPath);
  assert.equal(anchorStat.isFile(), true, 'anchor leaf must be a regular file');
  assert.equal(anchorStat.isSymbolicLink(), false, 'anchor leaf must not be a symlink');
  assert.equal(anchorStat.mode & 0o777, 0o600, 'anchor leaf must be mode 0600');
  assert.equal(anchorStat.uid, process.getuid(), 'anchor leaf owner must be current uid');

  const onDisk = await readFile(anchorPath);
  assert.equal(Buffer.compare(onDisk, serialized), 0, 'anchor on-disk bytes must match serialized input');

  const projection = await store.readAnchor(ANCHOR_ID);
  assert.deepEqual(projection, anchor, 'readAnchor must return exact deeply frozen projection of stored anchor');
  assert.equal(isDeeplyFrozen(projection), true, 'readAnchor projection must be deeply frozen');
  assertNoAbsolutePaths(projection, 'readAnchor projection');
});

test('writeAnchor fail-closed symlink break: target symlink must reject and leave victim bytes unchanged', async (t) => {
  const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeTempMetadataRoot(t);
  const store = createLaunchAgentMetadataStore({ metadataRoot });
  await store.initialize();

  const victimDir = await mkdtemp(join(tmpdir(), 'linke-la-victim-'));
  t.after(async () => {
    await rm(victimDir, { recursive: true, force: true });
  });
  const victimPath = join(victimDir, 'victim.json');
  const victimBytes = Buffer.from('do-not-clobber-victim-bytes');
  await writeFile(victimPath, victimBytes, { mode: 0o600 });

  const anchorPath = join(metadataRoot, 'anchors', `${ANCHOR_ID}.json`);
  await symlink(victimPath, anchorPath);

  const anchor = minimalFirstInstallAnchor();
  await assert.rejects(
    () => store.writeAnchor(anchor),
    (error) => error instanceof Error,
    'writeAnchor must reject when anchor target is a symlink',
  );

  const afterVictim = await readFile(victimPath);
  assert.equal(
    Buffer.compare(afterVictim, victimBytes),
    0,
    'symlink victim bytes must remain unchanged after rejected writeAnchor',
  );

  const linkStat = await lstat(anchorPath);
  assert.equal(linkStat.isSymbolicLink(), true, 'anchor target must remain a symlink after reject');
});

test('readAnchor fail-closed mode break: chmod 0644 anchor must reject without auto-chmod repair', async (t) => {
  const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeTempMetadataRoot(t);
  const store = createLaunchAgentMetadataStore({ metadataRoot });
  await store.initialize();

  const anchor = minimalFirstInstallAnchor();
  await store.writeAnchor(anchor);

  const anchorPath = join(metadataRoot, 'anchors', `${ANCHOR_ID}.json`);
  await chmod(anchorPath, 0o644);
  const degraded = await lstat(anchorPath);
  assert.equal(degraded.mode & 0o777, 0o644, 'precondition: anchor mode degraded to 0644');

  await assert.rejects(
    () => store.readAnchor(ANCHOR_ID),
    (error) => error instanceof Error,
    'readAnchor must reject when anchor mode is not 0600',
  );

  const after = await lstat(anchorPath);
  assert.equal(
    after.mode & 0o777,
    0o644,
    'readAnchor must not auto-chmod a degraded anchor back to 0600',
  );
});

test('store inode-swap fail-closed break: after metadataRoot rename replacement next operation must reject', async (t) => {
  const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeTempMetadataRoot(t);
  const store = createLaunchAgentMetadataStore({ metadataRoot });
  await store.initialize();

  const before = await lstat(metadataRoot);
  const backupPath = `${metadataRoot}.backup-inode-swap`;
  t.after(async () => {
    await rm(backupPath, { recursive: true, force: true });
  });

  await rename(metadataRoot, backupPath);
  await mkdir(metadataRoot, { mode: 0o700 });
  const after = await lstat(metadataRoot);
  assert.notEqual(
    `${before.dev}:${before.ino}`,
    `${after.dev}:${after.ino}`,
    'precondition: replacement metadataRoot must have a different inode identity',
  );
  assert.equal(after.mode & 0o777, 0o700, 'replacement root must be mode 0700');

  await assert.rejects(
    () => store.writeCandidate({
      transactionId: TX_ID,
      role: 'controller',
      bytes: Buffer.from('post-inode-swap'),
    }),
    (error) => error instanceof Error,
    'store operation after metadataRoot inode swap must reject',
  );
});

test('test factory durability event order break: candidate success must emit file-sync then directory-sync then verify without sensitive fields', async (t) => {
  const createLaunchAgentMetadataStoreForTest = requireFactory('createLaunchAgentMetadataStoreForTest');
  const metadataRoot = await makeTempMetadataRoot(t);
  const events = [];

  const store = createLaunchAgentMetadataStoreForTest({
    metadataRoot,
    fs: fsPromises,
    onDurabilityEvent: (event) => {
      events.push(event);
    },
  });
  assert.equal(store === null || typeof store !== 'object', false, 'test factory must return a store object');
  assert.equal(typeof store.initialize, 'function', 'test store.initialize must be a function');
  assert.equal(typeof store.writeCandidate, 'function', 'test store.writeCandidate must be a function');

  await store.initialize();
  events.length = 0;

  const bytes = Buffer.from('durability-candidate-bytes');
  const ref = await store.writeCandidate({
    transactionId: TX_ID,
    role: 'controller',
    bytes,
  });
  assert.equal(ref.sha256, sha256Hex(bytes));

  const candidateEvents = events.filter((event) => event && event.artifact === 'candidate');
  assert.ok(
    candidateEvents.length >= 3,
    'successful candidate write must emit at least three candidate durability events',
  );

  const fileSyncIndex = candidateEvents.findIndex(
    (event) => event.kind === 'file-sync' && event.artifact === 'candidate',
  );
  const directorySyncIndex = candidateEvents.findIndex(
    (event) => event.kind === 'directory-sync' && event.artifact === 'candidate',
  );
  const verifyIndex = candidateEvents.findIndex(
    (event) => event.kind === 'verify' && event.artifact === 'candidate',
  );

  assert.notEqual(fileSyncIndex, -1, 'must observe file-sync candidate event');
  assert.notEqual(directorySyncIndex, -1, 'must observe directory-sync candidate event');
  assert.notEqual(verifyIndex, -1, 'must observe verify candidate event');
  assert.ok(
    fileSyncIndex < directorySyncIndex,
    'file-sync candidate must occur before directory-sync candidate',
  );
  assert.ok(
    directorySyncIndex < verifyIndex,
    'directory-sync candidate must occur before verify candidate',
  );

  for (const event of candidateEvents) {
    assert.equal(isDeeplyFrozen(event), true, 'durability event must be deeply frozen closed object');
    assertNoSensitiveEventFields(event);
    assert.deepEqual(
      Reflect.ownKeys(event).filter((key) => typeof key === 'string').sort(),
      ['artifact', 'kind'].sort(),
      'candidate durability event must be closed to kind and artifact only',
    );
  }
});

test('public return values path-leak break: initialize writeCandidate writeAnchor readAnchor must not embed absolute paths', async (t) => {
  const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeTempMetadataRoot(t);
  const store = createLaunchAgentMetadataStore({ metadataRoot });

  const initResult = await store.initialize();
  assertNoAbsolutePaths(initResult, 'initialize');

  const candidateBytes = Buffer.from('path-leak-candidate');
  const candidateRef = await store.writeCandidate({
    transactionId: TX_ID,
    role: 'manifest',
    bytes: candidateBytes,
  });
  assertNoAbsolutePaths(candidateRef, 'writeCandidate');

  const readBack = await store.readCandidate(candidateRef);
  assert.equal(Buffer.isBuffer(readBack), true);
  assert.equal(Buffer.compare(readBack, candidateBytes), 0);

  const anchor = minimalFirstInstallAnchor();
  const anchorRef = await store.writeAnchor(anchor);
  assertNoAbsolutePaths(anchorRef, 'writeAnchor');

  const projection = await store.readAnchor(ANCHOR_ID);
  assertNoAbsolutePaths(projection, 'readAnchor');
});

// ---------------------------------------------------------------------------
// Lock behavior RED tests (Task 2 lock contracts; production lock path still stubbed)
// ---------------------------------------------------------------------------

test('A transaction lock durable roundtrip: mode 0600 ref verify and independent content hash', async (t) => {
  const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeTempMetadataRoot(t);
  const store = createLaunchAgentMetadataStore({ metadataRoot });
  await store.initialize();

  assert.equal(
    typeof store.acquireTransactionLock,
    'function',
    'store.acquireTransactionLock must be a function',
  );
  assert.equal(
    typeof store.verifyTransactionLock,
    'function',
    'store.verifyTransactionLock must be a function',
  );

  const record = validLockRecord({
    bootSessionIdentity: identityAvailable('opaque-boot-session-identity-v1'),
    processStartIdentity: identityAvailable('opaque-process-start-identity-v1'),
  });
  assert.notEqual(record.transactionId, record.ownerNonce, 'transactionId and ownerNonce must differ');

  const ref = await store.acquireTransactionLock(record);
  const onDisk = await assertOwnedLockLeaf(metadataRoot, TRANSACTION_LOCK_LEAF, record);
  const expectedSha = sha256Hex(onDisk);

  assert.deepEqual(ref, {
    kind: 'transaction-lock',
    transactionId: record.transactionId,
    ownerNonce: record.ownerNonce,
    sha256: expectedSha,
  });
  assert.equal(isDeeplyFrozen(ref), true, 'transaction lock ref must be deeply frozen');
  assertNoAbsolutePaths(ref, 'transaction lock ref');
  assert.equal(
    ref.sha256,
    expectedSha,
    'ref.sha256 must independently hash on-disk UTF-8 lock projection bytes',
  );

  const verified = await store.verifyTransactionLock(ref);
  assert.equal(verified, true, 'verifyTransactionLock must return true for durable matching ref');

  await assertNoLockLeaf(metadataRoot, MANUAL_INTERVENTION_LOCK_LEAF);
});

test('B two-store concurrency: exactly one acquire fulfilled loser is transaction-in-progress', async (t) => {
  const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeTempMetadataRoot(t);

  const storeA = createLaunchAgentMetadataStore({ metadataRoot });
  const storeB = createLaunchAgentMetadataStore({ metadataRoot });
  await storeA.initialize();
  await storeB.initialize();

  const recordA = validLockRecord({
    transactionId: TX_ID,
    ownerNonce: OWNER_NONCE_A,
    ownerPid: FIXED_OWNER_PID,
  });
  const recordB = validLockRecord({
    transactionId: TX_ID_B,
    ownerNonce: OWNER_NONCE_B,
    ownerPid: FIXED_OWNER_PID + 1,
  });
  assert.notEqual(recordA.transactionId, recordB.transactionId);
  assert.notEqual(recordA.ownerNonce, recordB.ownerNonce);

  const settled = await Promise.allSettled([
    storeA.acquireTransactionLock(recordA),
    storeB.acquireTransactionLock(recordB),
  ]);

  const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
  const rejected = settled.filter((entry) => entry.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one concurrent acquire must fulfill');
  assert.equal(rejected.length, 1, 'exactly one concurrent acquire must reject');
  assert.equal(
    isLifecycleErrorWithCode(
      rejected[0].reason,
      LAUNCHAGENT_LIFECYCLE_CODES.TRANSACTION_IN_PROGRESS,
    ),
    true,
    'loser must throw LaunchAgentLifecycleError code/message transaction-in-progress',
  );

  const winnerRecord = fulfilled[0].value.transactionId === recordA.transactionId
    ? recordA
    : recordB;
  const onDisk = await assertOwnedLockLeaf(metadataRoot, TRANSACTION_LOCK_LEAF, winnerRecord);
  assert.equal(fulfilled[0].value.sha256, sha256Hex(onDisk));
  assert.equal(fulfilled[0].value.kind, 'transaction-lock');
});

test('C forged ref and ordinary release fail-closed: lock bytes unchanged and no clobber', async (t) => {
  const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeTempMetadataRoot(t);
  const store = createLaunchAgentMetadataStore({ metadataRoot });
  await store.initialize();

  const record = validLockRecord({
    transactionId: TX_ID,
    ownerNonce: OWNER_NONCE_A,
  });
  const ref = await store.acquireTransactionLock(record);
  const beforeBytes = await readLockLeafBytes(metadataRoot, TRANSACTION_LOCK_LEAF);
  assert.equal(ref.sha256, sha256Hex(beforeBytes));

  const forgedRefs = [
    {
      ...ref,
      ownerNonce: OWNER_NONCE_B,
    },
    {
      ...ref,
      sha256: '0'.repeat(64),
    },
    {
      ...ref,
      kind: 'manual-intervention-lock',
    },
    {
      ...ref,
      transactionId: TX_ID_B,
    },
  ];

  for (const forged of forgedRefs) {
    await assert.rejects(
      () => store.verifyTransactionLock(forged),
      (error) => isInvalidLifecycleError(error),
      'forged verifyTransactionLock must reject with INVALID',
    );
    await assert.rejects(
      () => store.releaseTransactionLock(forged),
      (error) => isInvalidLifecycleError(error),
      'forged releaseTransactionLock must reject with INVALID',
    );
  }

  const afterForged = await readLockLeafBytes(metadataRoot, TRANSACTION_LOCK_LEAF);
  assert.equal(
    Buffer.compare(afterForged, beforeBytes),
    0,
    'forged verify/release must not mutate transaction.lock bytes',
  );

  const secondRecord = validLockRecord({
    transactionId: TX_ID_B,
    ownerNonce: OWNER_NONCE_C,
    ownerPid: FIXED_OWNER_PID + 7,
  });
  await assert.rejects(
    () => store.acquireTransactionLock(secondRecord),
    (error) => isLifecycleErrorWithCode(
      error,
      LAUNCHAGENT_LIFECYCLE_CODES.TRANSACTION_IN_PROGRESS,
    ),
    'second acquire while lock held must reject with transaction-in-progress',
  );

  const afterSecondAcquire = await readLockLeafBytes(metadataRoot, TRANSACTION_LOCK_LEAF);
  assert.equal(
    Buffer.compare(afterSecondAcquire, beforeBytes),
    0,
    'rejected second acquire must not clobber transaction.lock bytes',
  );
  assert.deepEqual(
    JSON.parse(afterSecondAcquire.toString('utf8')),
    record,
    'original lock record must remain on disk after no-clobber reject',
  );

  await assert.rejects(
    () => store.releaseTransactionLock(ref),
    (error) => error instanceof LaunchAgentLifecycleError,
    'ordinary releaseTransactionLock without terminal journal+receipt must fail closed',
  );

  const afterRelease = await readLockLeafBytes(metadataRoot, TRANSACTION_LOCK_LEAF);
  assert.equal(
    Buffer.compare(afterRelease, beforeBytes),
    0,
    'fail-closed release must leave transaction.lock bytes intact',
  );
  const stillThere = await lstat(join(metadataRoot, TRANSACTION_LOCK_LEAF));
  assert.equal(stillThere.isFile(), true, 'fail-closed release must leave lock file present');
});

test('D MIR lock separate identity: ordinary releaseTransactionLock rejects and both leaves stable', async (t) => {
  const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeTempMetadataRoot(t);
  const store = createLaunchAgentMetadataStore({ metadataRoot });
  await store.initialize();

  assert.equal(
    typeof store.acquireManualInterventionLock,
    'function',
    'store.acquireManualInterventionLock must be a function',
  );
  assert.equal(
    typeof store.verifyManualInterventionLock,
    'function',
    'store.verifyManualInterventionLock must be a function',
  );
  assert.equal(
    typeof store.releaseManualInterventionLock,
    'function',
    'store.releaseManualInterventionLock must be a function',
  );

  // Canonical MIR handoff: hold transaction lock first, then publish MIR
  // (same transactionId, different ownerNonce). Crash recovery may leave
  // only MIR; normal acquire must never invent MIR without a held tx lock.
  const txRecord = validLockRecord({
    transactionId: TX_ID,
    ownerNonce: OWNER_NONCE_A,
  });
  const txRef = await store.acquireTransactionLock(txRecord);
  const txBytes = await assertOwnedLockLeaf(
    metadataRoot,
    TRANSACTION_LOCK_LEAF,
    txRecord,
  );
  assert.deepEqual(txRef, {
    kind: 'transaction-lock',
    transactionId: TX_ID,
    ownerNonce: OWNER_NONCE_A,
    sha256: sha256Hex(txBytes),
  });

  const mirRecord = validLockRecord({
    transactionId: TX_ID,
    ownerNonce: OWNER_NONCE_MIR,
    ownerPid: FIXED_OWNER_PID + 3,
  });
  assert.equal(
    mirRecord.transactionId,
    txRecord.transactionId,
    'MIR handoff must stay on the same transaction as the held transaction lock',
  );
  assert.notEqual(
    mirRecord.ownerNonce,
    txRecord.ownerNonce,
    'MIR lock identity must use a distinct ownerNonce from the transaction lock',
  );

  const mirRef = await store.acquireManualInterventionLock(mirRecord);
  const mirBytes = await assertOwnedLockLeaf(
    metadataRoot,
    MANUAL_INTERVENTION_LOCK_LEAF,
    mirRecord,
  );

  assert.deepEqual(mirRef, {
    kind: 'manual-intervention-lock',
    transactionId: mirRecord.transactionId,
    ownerNonce: mirRecord.ownerNonce,
    sha256: sha256Hex(mirBytes),
  });
  assert.equal(isDeeplyFrozen(mirRef), true, 'MIR lock ref must be deeply frozen');
  assertNoAbsolutePaths(mirRef, 'MIR lock ref');

  assert.equal(
    mirRef.transactionId,
    txRef.transactionId,
    'tx and MIR refs must share the same transactionId',
  );
  assert.notEqual(
    mirRef.ownerNonce,
    txRef.ownerNonce,
    'tx and MIR refs must use different ownerNonce values',
  );

  const verified = await store.verifyManualInterventionLock(mirRef);
  assert.equal(verified, true, 'verifyManualInterventionLock must return true');

  // Both leaves remain after successful MIR publish under held tx lock.
  const txAfterMir = await readLockLeafBytes(metadataRoot, TRANSACTION_LOCK_LEAF);
  assert.equal(
    Buffer.compare(txAfterMir, txBytes),
    0,
    'MIR publish must leave held transaction.lock bytes unchanged',
  );
  await assertOwnedLockLeaf(metadataRoot, TRANSACTION_LOCK_LEAF, txRecord);
  await assertOwnedLockLeaf(metadataRoot, MANUAL_INTERVENTION_LOCK_LEAF, mirRecord);

  await assert.rejects(
    () => store.releaseTransactionLock(mirRef),
    (error) => isInvalidLifecycleError(error),
    'releaseTransactionLock must reject MIR ref (kind/identity mismatch)',
  );

  const txAfterWrongRelease = await readLockLeafBytes(metadataRoot, TRANSACTION_LOCK_LEAF);
  assert.equal(
    Buffer.compare(txAfterWrongRelease, txBytes),
    0,
    'wrong-kind releaseTransactionLock must not mutate transaction.lock bytes',
  );
  const mirAfterWrongRelease = await readLockLeafBytes(
    metadataRoot,
    MANUAL_INTERVENTION_LOCK_LEAF,
  );
  assert.equal(
    Buffer.compare(mirAfterWrongRelease, mirBytes),
    0,
    'wrong-kind releaseTransactionLock must not mutate MIR lock bytes',
  );

  await assert.rejects(
    () => store.releaseManualInterventionLock(mirRef),
    (error) => error instanceof LaunchAgentLifecycleError,
    'releaseManualInterventionLock without recovered|blocked terminal journal+receipt must reject',
  );

  const mirAfterOrdinaryRelease = await readLockLeafBytes(
    metadataRoot,
    MANUAL_INTERVENTION_LOCK_LEAF,
  );
  assert.equal(
    Buffer.compare(mirAfterOrdinaryRelease, mirBytes),
    0,
    'fail-closed MIR release must retain manual-intervention.lock bytes',
  );
  const txAfterOrdinaryMirRelease = await readLockLeafBytes(
    metadataRoot,
    TRANSACTION_LOCK_LEAF,
  );
  assert.equal(
    Buffer.compare(txAfterOrdinaryMirRelease, txBytes),
    0,
    'fail-closed MIR release must leave held transaction.lock bytes intact',
  );
});

test('E MIR present blocks acquireTransactionLock before mutation with manual-intervention-required', async (t) => {
  const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeTempMetadataRoot(t);
  const store = createLaunchAgentMetadataStore({ metadataRoot });
  await store.initialize();

  // Establish held transaction lock, then MIR handoff (same tx, different nonce).
  const heldTxRecord = validLockRecord({
    transactionId: TX_ID,
    ownerNonce: OWNER_NONCE_A,
  });
  const heldTxRef = await store.acquireTransactionLock(heldTxRecord);
  assert.equal(heldTxRef.kind, 'transaction-lock');
  const txBytesBefore = await readLockLeafBytes(metadataRoot, TRANSACTION_LOCK_LEAF);

  const mirRecord = validLockRecord({
    transactionId: TX_ID,
    ownerNonce: OWNER_NONCE_MIR,
  });
  assert.equal(mirRecord.transactionId, heldTxRecord.transactionId);
  assert.notEqual(mirRecord.ownerNonce, heldTxRecord.ownerNonce);
  const mirRef = await store.acquireManualInterventionLock(mirRecord);
  assert.equal(mirRef.kind, 'manual-intervention-lock');
  const mirBytes = await readLockLeafBytes(metadataRoot, MANUAL_INTERVENTION_LOCK_LEAF);
  const txBytesAfterMir = await readLockLeafBytes(metadataRoot, TRANSACTION_LOCK_LEAF);
  assert.equal(
    Buffer.compare(txBytesAfterMir, txBytesBefore),
    0,
    'MIR handoff must not mutate held transaction.lock bytes',
  );

  // Competing store/record attempting a new transaction lock must see MIR first.
  const competingStore = createLaunchAgentMetadataStore({ metadataRoot });
  await competingStore.initialize();
  const competingTxRecord = validLockRecord({
    transactionId: TX_ID_B,
    ownerNonce: OWNER_NONCE_B,
    ownerPid: FIXED_OWNER_PID + 11,
  });

  await assert.rejects(
    () => competingStore.acquireTransactionLock(competingTxRecord),
    (error) => isLifecycleErrorWithCode(
      error,
      LAUNCHAGENT_LIFECYCLE_CODES.MANUAL_INTERVENTION_REQUIRED,
    ),
    'acquireTransactionLock must fail closed with manual-intervention-required when MIR lock exists',
  );

  const txUnchanged = await readLockLeafBytes(metadataRoot, TRANSACTION_LOCK_LEAF);
  assert.equal(
    Buffer.compare(txUnchanged, txBytesBefore),
    0,
    'blocked transaction acquire must not mutate original transaction.lock bytes',
  );
  const mirUnchanged = await readLockLeafBytes(metadataRoot, MANUAL_INTERVENTION_LOCK_LEAF);
  assert.equal(
    Buffer.compare(mirUnchanged, mirBytes),
    0,
    'blocked transaction acquire must not mutate MIR lock bytes',
  );
});

test('F invalid lock record rejects with INVALID before creating any lock leaf', async (t) => {
  const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeTempMetadataRoot(t);
  const store = createLaunchAgentMetadataStore({ metadataRoot });
  await store.initialize();

  const invalidRecords = [
    { ...validLockRecord(), unexpectedKey: true },
    validLockRecord({ ownerPid: 0 }),
    validLockRecord({ ownerNonce: TX_ID, transactionId: TX_ID }),
    validLockRecord({
      bootSessionIdentity: { available: false, value: 'must-be-null' },
    }),
    validLockRecord({
      processStartIdentity: { available: true, value: null },
    }),
    validLockRecord({
      bootSessionIdentity: { available: true, value: '' },
    }),
    validLockRecord({
      processStartIdentity: identityAvailable('/absolute/path-like-identity'),
    }),
    validLockRecord({
      bootSessionIdentity: identityAvailable('has\\backslash'),
    }),
    validLockRecord({
      processStartIdentity: identityAvailable('has\0nul'),
    }),
    validLockRecord({
      bootSessionIdentity: identityAvailable('has\nnewline'),
    }),
  ];

  for (const invalid of invalidRecords) {
    await assert.rejects(
      () => store.acquireTransactionLock(invalid),
      (error) => isInvalidLifecycleError(error),
      'invalid transaction lock record must reject with INVALID before mutation',
    );
    await assert.rejects(
      () => store.acquireManualInterventionLock(invalid),
      (error) => isInvalidLifecycleError(error),
      'invalid MIR lock record must reject with INVALID before mutation',
    );
  }

  await assertNoLockLeaf(metadataRoot, TRANSACTION_LOCK_LEAF);
  await assertNoLockLeaf(metadataRoot, MANUAL_INTERVENTION_LOCK_LEAF);

  // Standalone MIR negative: valid record must not invent MIR when transaction.lock is absent.
  const standaloneMirRecord = validLockRecord({
    transactionId: TX_ID,
    ownerNonce: OWNER_NONCE_MIR,
  });
  await assert.rejects(
    () => store.acquireManualInterventionLock(standaloneMirRecord),
    (error) => isInvalidLifecycleError(error),
    'standalone acquireManualInterventionLock without held transaction.lock must reject with INVALID',
  );
  await assertNoLockLeaf(metadataRoot, MANUAL_INTERVENTION_LOCK_LEAF);
  await assertNoLockLeaf(metadataRoot, TRANSACTION_LOCK_LEAF);

  // Selective validation proof: a valid record must still succeed for transaction lock.
  const valid = validLockRecord({
    transactionId: TX_ID,
    ownerNonce: OWNER_NONCE_A,
  });
  const ref = await store.acquireTransactionLock(valid);
  assert.equal(ref.kind, 'transaction-lock');
  await assertOwnedLockLeaf(metadataRoot, TRANSACTION_LOCK_LEAF, valid);
});

test('G lock publication durability events: closed frozen ordering for transaction and MIR locks', async (t) => {
  const createLaunchAgentMetadataStoreForTest = requireFactory('createLaunchAgentMetadataStoreForTest');
  const metadataRoot = await makeTempMetadataRoot(t);
  const events = [];

  const store = createLaunchAgentMetadataStoreForTest({
    metadataRoot,
    fs: fsPromises,
    onDurabilityEvent: (event) => {
      events.push(event);
    },
  });
  await store.initialize();
  events.length = 0;

  const txRecord = validLockRecord({
    transactionId: TX_ID,
    ownerNonce: OWNER_NONCE_A,
  });
  const txRef = await store.acquireTransactionLock(txRecord);
  assert.equal(txRef.kind, 'transaction-lock');
  assertLockDurabilityOrder(events, 'transaction-lock');

  events.length = 0;
  const mirRecord = validLockRecord({
    transactionId: TX_ID,
    ownerNonce: OWNER_NONCE_MIR,
    ownerPid: FIXED_OWNER_PID + 5,
  });
  assert.equal(
    mirRecord.transactionId,
    txRecord.transactionId,
    'MIR handoff must stay on the same transaction as the held transaction lock',
  );
  assert.notEqual(
    mirRecord.ownerNonce,
    txRecord.ownerNonce,
    'MIR lock identity must use a distinct ownerNonce from the transaction lock',
  );
  const mirRef = await store.acquireManualInterventionLock(mirRecord);
  assert.equal(mirRef.kind, 'manual-intervention-lock');
  assertLockDurabilityOrder(events, 'manual-intervention-lock');

  for (const event of events) {
    assertClosedDurabilityEvent(event, 'manual-intervention-lock');
  }
});

// ---------------------------------------------------------------------------
// Journal behavior RED tests (H–N). Production journal remains stubbed;
// these encode the frozen append-only journal contract.
// ---------------------------------------------------------------------------

test('H journal absent read and first append: empty array, mode 0600, ref, readback, events', async (t) => {
  const createLaunchAgentMetadataStoreForTest = requireFactory('createLaunchAgentMetadataStoreForTest');
  const metadataRoot = await makeTempMetadataRoot(t);
  const events = [];
  const store = createLaunchAgentMetadataStoreForTest({
    metadataRoot,
    fs: fsPromises,
    onDurabilityEvent: (event) => {
      events.push(event);
    },
  });
  await store.initialize();

  assert.equal(typeof store.readJournal, 'function', 'store.readJournal must be a function');
  assert.equal(typeof store.appendJournal, 'function', 'store.appendJournal must be a function');

  await assertNoJournalLeaf(metadataRoot);

  const absent = await store.readJournal({ transactionId: TX_ID });
  assert.equal(Array.isArray(absent), true, 'readJournal must return an array when journal is absent');
  assert.deepEqual(absent, [], 'absent journal must yield frozen empty array for the transaction');
  assert.equal(isDeeplyFrozen(absent), true, 'absent readJournal result must be deeply frozen');
  assertNoAbsolutePaths(absent, 'absent readJournal result');
  await assertNoJournalLeaf(metadataRoot);

  const lockRecord = validLockRecord({
    transactionId: TX_ID,
    ownerNonce: OWNER_NONCE_A,
  });
  const writerLockRef = await store.acquireTransactionLock(lockRecord);
  assert.equal(writerLockRef.kind, 'transaction-lock');

  events.length = 0;
  const entry = buildJournalEntry({
    transactionId: TX_ID,
    sequence: 0,
    previousEntrySha256: null,
    operation: 'install',
    state: 'prepared',
    payload: { hostMutationCount: 0 },
  });

  const ref = await store.appendJournal({
    entry,
    expectedPrior: null,
    writerLockRef,
  });
  assertClosedJournalReturn(ref, entry);

  await assertJournalLeafMode(metadataRoot);
  const onDisk = await readJournalLeafBytes(metadataRoot);
  const expectedLine = journalLineBuffer(entry);
  assert.equal(Buffer.compare(onDisk, expectedLine), 0, 'first append must write exact JSON line + LF');
  assert.ok(onDisk.byteLength <= JOURNAL_LINE_MAX_BYTES, 'first line must stay within 256KiB');
  assert.ok(onDisk.byteLength <= SIXTEEN_MIB, 'journal total must stay within 16MiB');

  const readBack = await store.readJournal({ transactionId: TX_ID });
  assert.equal(Array.isArray(readBack), true);
  assert.equal(readBack.length, 1, 'readJournal must return the single appended entry');
  assert.deepEqual(readBack[0], entry, 'readJournal entry must deep-equal closed projection');
  assert.equal(isDeeplyFrozen(readBack), true, 'readJournal array must be deeply frozen');
  assert.equal(isDeeplyFrozen(readBack[0]), true, 'readJournal entry must be deeply frozen');
  assertNoAbsolutePaths(readBack, 'readJournal result');
  for (const s of collectStrings(readBack)) {
    assert.equal(s.includes(JOURNAL_LEAF), false, 'readJournal must not embed journal path leaf');
  }

  assertLockDurabilityOrder(events, 'journal');
});

test('I journal sequence and previousEntrySha256 chain for two entries', async (t) => {
  const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeTempMetadataRoot(t);
  const store = createLaunchAgentMetadataStore({ metadataRoot });
  await store.initialize();

  const writerLockRef = await store.acquireTransactionLock(validLockRecord({
    transactionId: TX_ID,
    ownerNonce: OWNER_NONCE_A,
  }));

  const first = buildJournalEntry({
    transactionId: TX_ID,
    sequence: 0,
    previousEntrySha256: null,
    state: 'prepared',
    payload: { hostMutationCount: 0 },
  });
  const firstRef = await store.appendJournal({
    entry: first,
    expectedPrior: null,
    writerLockRef,
  });
  assertClosedJournalReturn(firstRef, first);

  const second = buildJournalEntry({
    transactionId: TX_ID,
    sequence: 1,
    previousEntrySha256: first.entrySha256,
    state: 'anchored',
    at: '2024-01-15T12:00:01.000Z',
    payload: { hostMutationCount: 1 },
  });
  assert.equal(second.previousEntrySha256, first.entrySha256);
  assert.equal(second.sequence, first.sequence + 1);

  const secondRef = await store.appendJournal({
    entry: second,
    expectedPrior: priorRefFromEntry(first),
    writerLockRef,
  });
  assertClosedJournalReturn(secondRef, second);

  const prefixAfterFirst = journalLineBuffer(first);
  const onDisk = await readJournalLeafBytes(metadataRoot);
  assert.equal(
    Buffer.compare(onDisk.subarray(0, prefixAfterFirst.byteLength), prefixAfterFirst),
    0,
    'second append must preserve exact physical prefix of first line',
  );
  assert.equal(
    Buffer.compare(onDisk, Buffer.concat([prefixAfterFirst, journalLineBuffer(second)])),
    0,
    'journal bytes must be first line + second line exactly',
  );

  const entries = await store.readJournal({ transactionId: TX_ID });
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], first);
  assert.deepEqual(entries[1], second);
  assert.equal(isDeeplyFrozen(entries), true);
  assert.equal(entries[1].previousEntrySha256, entries[0].entrySha256);
  assert.equal(entries[1].sequence, entries[0].sequence + 1);
});

test('J journal stale skip backward and wrong writer reject with journal unchanged', async (t) => {
  const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeTempMetadataRoot(t);
  const store = createLaunchAgentMetadataStore({ metadataRoot });
  await store.initialize();

  const lockRecord = validLockRecord({
    transactionId: TX_ID,
    ownerNonce: OWNER_NONCE_A,
  });
  const writerLockRef = await store.acquireTransactionLock(lockRecord);

  const first = buildJournalEntry({
    transactionId: TX_ID,
    sequence: 0,
    previousEntrySha256: null,
    state: 'prepared',
  });
  await store.appendJournal({
    entry: first,
    expectedPrior: null,
    writerLockRef,
  });

  const beforeBytes = await readJournalLeafBytes(metadataRoot);
  const beforeStat = await lstat(journalLeafPath(metadataRoot));
  const beforeMode = beforeStat.mode;

  const nextValid = buildJournalEntry({
    transactionId: TX_ID,
    sequence: 1,
    previousEntrySha256: first.entrySha256,
    state: 'anchored',
    payload: { hostMutationCount: 1 },
  });

  const stalePrior = {
    transactionId: TX_ID,
    sequence: 0,
    entrySha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  };
  await assert.rejects(
    () => store.appendJournal({
      entry: nextValid,
      expectedPrior: stalePrior,
      writerLockRef,
    }),
    isInvalidLifecycleError,
    'stale expectedPrior entrySha256 must reject INVALID',
  );

  const skipEntry = buildJournalEntry({
    transactionId: TX_ID,
    sequence: 2,
    previousEntrySha256: first.entrySha256,
    state: 'anchored',
    payload: { hostMutationCount: 1 },
  });
  await assert.rejects(
    () => store.appendJournal({
      entry: skipEntry,
      expectedPrior: {
        transactionId: TX_ID,
        sequence: 1,
        entrySha256: first.entrySha256,
      },
      writerLockRef,
    }),
    isInvalidLifecycleError,
    'skip sequence must reject INVALID',
  );

  const backwardEntry = buildJournalEntry({
    transactionId: TX_ID,
    sequence: 0,
    previousEntrySha256: null,
    state: 'published',
    payload: { hostMutationCount: 1 },
  });
  await assert.rejects(
    () => store.appendJournal({
      entry: backwardEntry,
      expectedPrior: null,
      writerLockRef,
    }),
    isInvalidLifecycleError,
    'backward/null expectedPrior after existing latest must reject INVALID',
  );

  await assert.rejects(
    () => store.appendJournal({
      entry: nextValid,
      expectedPrior: priorRefFromEntry(first),
      writerLockRef: {
        kind: 'transaction-lock',
        transactionId: TX_ID,
        ownerNonce: OWNER_NONCE_A,
        sha256: '0000000000000000000000000000000000000000000000000000000000000000',
      },
    }),
    isInvalidLifecycleError,
    'forged writerLockRef sha256 must reject INVALID',
  );

  await assert.rejects(
    () => store.appendJournal({
      entry: nextValid,
      expectedPrior: priorRefFromEntry(first),
      writerLockRef: {
        kind: 'transaction-lock',
        transactionId: TX_ID_B,
        ownerNonce: OWNER_NONCE_A,
        sha256: writerLockRef.sha256,
      },
    }),
    isInvalidLifecycleError,
    'writerLockRef for wrong transaction must reject INVALID',
  );

  await assert.rejects(
    () => store.appendJournal({
      entry: nextValid,
      expectedPrior: priorRefFromEntry(first),
    }),
    isInvalidLifecycleError,
    'missing writerLockRef must reject INVALID',
  );

  const afterBytes = await readJournalLeafBytes(metadataRoot);
  const afterStat = await lstat(journalLeafPath(metadataRoot));
  assert.equal(Buffer.compare(afterBytes, beforeBytes), 0, 'failed appends must leave journal bytes exact');
  assert.equal(afterStat.mode, beforeMode, 'failed appends must not alter journal mode');
});

test('K multi-transaction journal preseed preserves exact prefix and independent sequences', async (t) => {
  const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeTempMetadataRoot(t);
  const store = createLaunchAgentMetadataStore({ metadataRoot });
  await store.initialize();

  const terminalB = buildJournalEntry({
    transactionId: TX_ID_B,
    sequence: 0,
    previousEntrySha256: null,
    operation: 'install',
    state: 'committed',
    payload: {
      hostMutationCount: 0,
      receiptSha256: RECEIPT_SHA256,
    },
  });
  const preseedBytes = journalLineBuffer(terminalB);
  await writeFile(journalLeafPath(metadataRoot), preseedBytes, { mode: 0o600 });
  await assertJournalLeafMode(metadataRoot);

  const writerLockRef = await store.acquireTransactionLock(validLockRecord({
    transactionId: TX_ID,
    ownerNonce: OWNER_NONCE_A,
  }));

  const firstA = buildJournalEntry({
    transactionId: TX_ID,
    sequence: 0,
    previousEntrySha256: null,
    state: 'prepared',
    payload: { hostMutationCount: 0 },
  });
  const refA = await store.appendJournal({
    entry: firstA,
    expectedPrior: null,
    writerLockRef,
  });
  assertClosedJournalReturn(refA, firstA);
  assert.equal(refA.sequence, 0, 'TX_ID sequence must start at 0 independent of TX_ID_B');

  const afterBytes = await readJournalLeafBytes(metadataRoot);
  assert.equal(
    Buffer.compare(afterBytes.subarray(0, preseedBytes.byteLength), preseedBytes),
    0,
    'append for TX_ID must preserve exact physical prefix of preseeded TX_ID_B line',
  );
  assert.equal(
    Buffer.compare(afterBytes, Buffer.concat([preseedBytes, journalLineBuffer(firstA)])),
    0,
    'journal must be preseed line + new TX_ID line exactly',
  );

  const readB = await store.readJournal({ transactionId: TX_ID_B });
  assert.equal(readB.length, 1, 'readJournal(TX_ID_B) must still return exactly one entry');
  assert.deepEqual(readB[0], terminalB, 'preseeded TX_ID_B entry must be unchanged');
  assert.equal(isDeeplyFrozen(readB), true);

  const readA = await store.readJournal({ transactionId: TX_ID });
  assert.equal(readA.length, 1);
  assert.deepEqual(readA[0], firstA);
  assert.equal(readA[0].sequence, 0);
  assert.notEqual(readA[0].transactionId, readB[0].transactionId);
});

test('L journal corrupt truncated hash chain mode fail-closed with exact bytes preserved', async (t) => {
  const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');

  // Behavioral gate: a valid single-line journal must be readable (RED under journal stubs).
  {
    const metadataRoot = await makeTempMetadataRoot(t);
    const store = createLaunchAgentMetadataStore({ metadataRoot });
    await store.initialize();
    const valid = buildJournalEntry({ state: 'prepared' });
    await writeFile(journalLeafPath(metadataRoot), journalLineBuffer(valid), { mode: 0o600 });
    const entries = await store.readJournal({ transactionId: TX_ID });
    assert.equal(entries.length, 1, 'valid journal control must return one entry');
    assert.deepEqual(entries[0], valid);
  }

  const cases = [
    {
      name: 'corrupt-json',
      seed: async (leaf) => {
        await writeFile(leaf, Buffer.from('{not-json\n', 'utf8'), { mode: 0o600 });
      },
    },
    {
      name: 'truncated-last-line-no-lf',
      seed: async (leaf) => {
        const valid = buildJournalEntry({ state: 'prepared' });
        const full = journalLineBuffer(valid);
        await writeFile(leaf, full.subarray(0, full.byteLength - 1), { mode: 0o600 });
      },
    },
    {
      name: 'tampered-entry-hash',
      seed: async (leaf) => {
        const valid = buildJournalEntry({ state: 'prepared' });
        const tampered = {
          ...valid,
          entrySha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        };
        await writeFile(leaf, journalLineBuffer(tampered), { mode: 0o600 });
      },
    },
    {
      name: 'broken-previous-chain',
      seed: async (leaf) => {
        const first = buildJournalEntry({ sequence: 0, previousEntrySha256: null, state: 'prepared' });
        const second = buildJournalEntry({
          sequence: 1,
          previousEntrySha256: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
          state: 'anchored',
          payload: { hostMutationCount: 1 },
        });
        await writeFile(
          leaf,
          Buffer.concat([journalLineBuffer(first), journalLineBuffer(second)]),
          { mode: 0o600 },
        );
      },
    },
    {
      name: 'duplicate-sequence',
      seed: async (leaf) => {
        const first = buildJournalEntry({ sequence: 0, previousEntrySha256: null, state: 'prepared' });
        const dup = buildJournalEntry({
          sequence: 0,
          previousEntrySha256: null,
          state: 'anchored',
          at: '2024-01-15T12:00:01.000Z',
          payload: { hostMutationCount: 1 },
        });
        await writeFile(
          leaf,
          Buffer.concat([journalLineBuffer(first), journalLineBuffer(dup)]),
          { mode: 0o600 },
        );
      },
    },
    {
      name: 'mode-drift-0644',
      seed: async (leaf) => {
        const valid = buildJournalEntry({ state: 'prepared' });
        await writeFile(leaf, journalLineBuffer(valid), { mode: 0o600 });
        await chmod(leaf, 0o644);
      },
    },
  ];

  for (const c of cases) {
    await t.test(`L ${c.name}`, async (st) => {
      const metadataRoot = await makeTempMetadataRoot(st);
      const store = createLaunchAgentMetadataStore({ metadataRoot });
      await store.initialize();
      const leaf = journalLeafPath(metadataRoot);
      await c.seed(leaf);

      const beforeBytes = await readFile(leaf);
      const beforeStat = await lstat(leaf);
      const beforeMode = beforeStat.mode;

      const writerLockRef = await store.acquireTransactionLock(validLockRecord({
        transactionId: TX_ID,
        ownerNonce: OWNER_NONCE_A,
      }));

      await assert.rejects(
        () => store.readJournal({ transactionId: TX_ID }),
        isInvalidLifecycleError,
        `${c.name}: readJournal must reject INVALID`,
      );
      await assert.rejects(
        () => store.appendJournal({
          entry: buildJournalEntry({
            sequence: 0,
            previousEntrySha256: null,
            state: 'prepared',
          }),
          expectedPrior: null,
          writerLockRef,
        }),
        isInvalidLifecycleError,
        `${c.name}: appendJournal must reject INVALID`,
      );

      const afterBytes = await readFile(leaf);
      const afterStat = await lstat(leaf);
      assert.equal(Buffer.compare(afterBytes, beforeBytes), 0, `${c.name}: bytes must stay exact`);
      assert.equal(afterStat.mode, beforeMode, `${c.name}: mode must stay exact (no repair)`);
    });
  }

  await t.test('L symlink journal leaf', async (st) => {
    const metadataRoot = await makeTempMetadataRoot(st);
    const store = createLaunchAgentMetadataStore({ metadataRoot });
    await store.initialize();
    const victim = join(metadataRoot, 'journal-victim.json');
    const victimBytes = Buffer.from('victim-journal-bytes\n', 'utf8');
    await writeFile(victim, victimBytes, { mode: 0o600 });
    await symlink(victim, journalLeafPath(metadataRoot));

    const beforeVictim = await readFile(victim);
    const writerLockRef = await store.acquireTransactionLock(validLockRecord({
      transactionId: TX_ID,
      ownerNonce: OWNER_NONCE_A,
    }));

    await assert.rejects(
      () => store.readJournal({ transactionId: TX_ID }),
      isInvalidLifecycleError,
      'symlink journal must reject readJournal',
    );
    await assert.rejects(
      () => store.appendJournal({
        entry: buildJournalEntry({ state: 'prepared' }),
        expectedPrior: null,
        writerLockRef,
      }),
      isInvalidLifecycleError,
      'symlink journal must reject appendJournal',
    );

    const afterVictim = await readFile(victim);
    assert.equal(Buffer.compare(afterVictim, beforeVictim), 0, 'symlink victim bytes must be unchanged');
    const linkStat = await lstat(journalLeafPath(metadataRoot));
    assert.equal(linkStat.isSymbolicLink(), true, 'journal leaf must remain a symlink (no follow/replace)');
  });

  await t.test('L oversize single line', async (st) => {
    const metadataRoot = await makeTempMetadataRoot(st);
    const store = createLaunchAgentMetadataStore({ metadataRoot });
    await store.initialize();
    // Line including LF exceeds 256KiB.
    const oversize = Buffer.alloc(JOURNAL_LINE_MAX_BYTES + 1, 0x61);
    oversize[oversize.byteLength - 1] = 0x0a;
    await writeFile(journalLeafPath(metadataRoot), oversize, { mode: 0o600 });
    const beforeBytes = await readJournalLeafBytes(metadataRoot);

    const writerLockRef = await store.acquireTransactionLock(validLockRecord({
      transactionId: TX_ID,
      ownerNonce: OWNER_NONCE_A,
    }));
    await assert.rejects(
      () => store.readJournal({ transactionId: TX_ID }),
      isInvalidLifecycleError,
      'oversize journal line must reject readJournal',
    );
    await assert.rejects(
      () => store.appendJournal({
        entry: buildJournalEntry({ state: 'prepared' }),
        expectedPrior: null,
        writerLockRef,
      }),
      isInvalidLifecycleError,
      'oversize journal line must reject appendJournal',
    );
    const afterBytes = await readJournalLeafBytes(metadataRoot);
    assert.equal(Buffer.compare(afterBytes, beforeBytes), 0, 'oversize journal bytes must stay exact');
  });

  await t.test('L oversize total with individually valid lines', async (st) => {
    const metadataRoot = await makeTempMetadataRoot(st);
    const store = createLaunchAgentMetadataStore({ metadataRoot });
    await store.initialize();

    // Many distinct tx chains (seq0 prepared only): each line schema/hash valid and
    // ≤256KiB+LF; total Buffer strictly >16MiB. One in-memory concat, single write.
    const lineBuffers = [];
    let totalBytes = 0;
    let n = 0;
    while (totalBytes <= SIXTEEN_MIB) {
      const tail = n.toString(16).padStart(12, '0');
      const transactionId = `00000000-0000-4000-8000-${tail}`;
      assert.notEqual(transactionId, TX_ID, 'filler UUID must not equal TX_ID');
      assert.notEqual(transactionId, TX_ID_B, 'filler UUID must not equal TX_ID_B');
      const entry = buildJournalEntry({
        transactionId,
        sequence: 0,
        previousEntrySha256: null,
        state: 'prepared',
        payload: { hostMutationCount: 0 },
      });
      const line = journalLineBuffer(entry);
      assert.ok(
        line.byteLength <= JOURNAL_LINE_MAX_BYTES,
        'each constructed journal line must stay within 256KiB',
      );
      assert.equal(line[line.byteLength - 1], 0x0a, 'each journal line must end with LF');
      lineBuffers.push(line);
      totalBytes += line.byteLength;
      n += 1;
    }
    const oversizeTotal = Buffer.concat(lineBuffers);
    assert.ok(
      oversizeTotal.byteLength > SIXTEEN_MIB,
      'constructed journal total must strictly exceed 16MiB',
    );

    await writeFile(journalLeafPath(metadataRoot), oversizeTotal, { mode: 0o600 });
    const beforeBytes = await readJournalLeafBytes(metadataRoot);
    assert.equal(
      Buffer.compare(beforeBytes, oversizeTotal),
      0,
      'on-disk journal must match constructed oversize buffer',
    );
    assert.ok(
      beforeBytes.byteLength > SIXTEEN_MIB,
      'on-disk journal total must strictly exceed 16MiB',
    );
    {
      let offset = 0;
      while (offset < beforeBytes.byteLength) {
        const nl = beforeBytes.indexOf(0x0a, offset);
        assert.notEqual(nl, -1, 'every journal line must be LF-terminated');
        const lineLen = nl - offset + 1;
        assert.ok(
          lineLen <= JOURNAL_LINE_MAX_BYTES,
          'each on-disk journal line must stay within 256KiB',
        );
        offset = nl + 1;
      }
      assert.equal(offset, beforeBytes.byteLength, 'journal must be fully LF-framed lines');
    }

    const writerLockRef = await store.acquireTransactionLock(validLockRecord({
      transactionId: TX_ID,
      ownerNonce: OWNER_NONCE_A,
    }));
    await assert.rejects(
      () => store.readJournal({ transactionId: TX_ID }),
      isInvalidLifecycleError,
      'oversize total journal must reject readJournal',
    );
    await assert.rejects(
      () => store.appendJournal({
        entry: buildJournalEntry({
          sequence: 0,
          previousEntrySha256: null,
          state: 'prepared',
        }),
        expectedPrior: null,
        writerLockRef,
      }),
      isInvalidLifecycleError,
      'oversize total journal must reject appendJournal',
    );
    const afterBytes = await readJournalLeafBytes(metadataRoot);
    assert.equal(
      Buffer.compare(afterBytes, beforeBytes),
      0,
      'oversize total journal bytes must stay exact',
    );
  });
});

test('M journal payload state-specific validator positive and negative behavior', () => {
  const nonterminalStates = [
    'prepared',
    'anchored',
    'published',
    'controller-loaded',
    'controller-ready',
    'scheduler-loaded',
  ];
  const terminalWithReceipt = ['committed', 'recovered', 'no-change'];

  for (const state of nonterminalStates) {
    const entry = buildJournalEntry({
      state,
      payload: { hostMutationCount: 0 },
    });
    const projection = validateLaunchAgentJournal(entry);
    assert.deepEqual(projection, entry, `${state}: exact {hostMutationCount} payload must accept`);
    assert.equal(isDeeplyFrozen(projection), true, `${state}: projection must be deeply frozen`);
  }

  const reversePlan = [];
  const compensating = buildJournalEntry({
    state: 'compensating',
    payload: {
      hostMutationCount: 0,
      reversePlan,
      reversePlanSha256: sha256Hex(Buffer.from(JSON.stringify(reversePlan), 'utf8')),
    },
  });
  const compensatingProjection = validateLaunchAgentJournal(compensating);
  assert.deepEqual(compensatingProjection, compensating);
  assert.equal(isDeeplyFrozen(compensatingProjection), true);
  assert.throws(
    () => validateLaunchAgentJournal(buildJournalEntry({
      state: 'compensating',
      payload: { hostMutationCount: 0 },
    })),
    isInvalidLifecycleError,
    'compensating without a durable reverse plan must reject',
  );

  // Existing prepared contract acceptance must continue.
  const preparedOk = buildJournalEntry({
    state: 'prepared',
    payload: { hostMutationCount: 2 },
  });
  assert.deepEqual(validateLaunchAgentJournal(preparedOk), preparedOk);

  assert.throws(
    () => validateLaunchAgentJournal(buildJournalEntry({
      state: 'prepared',
      payload: {
        hostMutationCount: 0,
        receiptSha256: RECEIPT_SHA256,
      },
    })),
    isInvalidLifecycleError,
    'prepared with receiptSha256 must reject',
  );

  for (const state of terminalWithReceipt) {
    const ok = buildJournalEntry({
      state,
      payload: {
        hostMutationCount: 1,
        receiptSha256: RECEIPT_SHA256,
      },
    });
    const projection = validateLaunchAgentJournal(ok);
    assert.deepEqual(projection, ok, `${state}: exact {hostMutationCount,receiptSha256} must accept`);
    assert.equal(isDeeplyFrozen(projection), true);

    assert.throws(
      () => validateLaunchAgentJournal(buildJournalEntry({
        state,
        payload: { hostMutationCount: 1 },
      })),
      isInvalidLifecycleError,
      `${state}: missing receiptSha256 must reject`,
    );
  }

  const blockedOk = buildJournalEntry({
    state: 'blocked',
    payload: {
      hostMutationCount: 1,
      receiptSha256: RECEIPT_SHA256,
      blockedByEntrySha256: null,
    },
  });
  assert.deepEqual(validateLaunchAgentJournal(blockedOk), blockedOk);

  const blockedByHex = buildJournalEntry({
    state: 'blocked',
    payload: {
      hostMutationCount: 1,
      receiptSha256: RECEIPT_SHA256,
      blockedByEntrySha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  });
  assert.deepEqual(validateLaunchAgentJournal(blockedByHex), blockedByHex);

  assert.throws(
    () => validateLaunchAgentJournal(buildJournalEntry({
      state: 'blocked',
      payload: {
        hostMutationCount: 1,
        receiptSha256: RECEIPT_SHA256,
      },
    })),
    isInvalidLifecycleError,
    'blocked missing blockedByEntrySha256 must reject',
  );

  assert.throws(
    () => validateLaunchAgentJournal(buildJournalEntry({
      state: 'blocked',
      payload: {
        hostMutationCount: 1,
        receiptSha256: RECEIPT_SHA256,
        blockedByEntrySha256: 'not-a-sha256',
      },
    })),
    isInvalidLifecycleError,
    'blocked invalid blockedByEntrySha256 must reject',
  );

  const mirOk = buildJournalEntry({
    state: 'manual-intervention-required',
    payload: { hostMutationCount: 0 },
  });
  assert.deepEqual(
    validateLaunchAgentJournal(mirOk),
    mirOk,
    'manual-intervention-required exact {hostMutationCount} must accept',
  );

  assert.throws(
    () => validateLaunchAgentJournal(buildJournalEntry({
      state: 'manual-intervention-required',
      payload: {
        hostMutationCount: 0,
        receiptSha256: RECEIPT_SHA256,
      },
    })),
    isInvalidLifecycleError,
    'manual-intervention-required with receiptSha256 must reject',
  );
});

test('N journal durability events closed frozen ordering and path hygiene', async (t) => {
  const createLaunchAgentMetadataStoreForTest = requireFactory('createLaunchAgentMetadataStoreForTest');
  const metadataRoot = await makeTempMetadataRoot(t);
  const events = [];
  const store = createLaunchAgentMetadataStoreForTest({
    metadataRoot,
    fs: fsPromises,
    onDurabilityEvent: (event) => {
      events.push(event);
    },
  });
  await store.initialize();

  const writerLockRef = await store.acquireTransactionLock(validLockRecord({
    transactionId: TX_ID,
    ownerNonce: OWNER_NONCE_A,
  }));

  events.length = 0;
  const entry = buildJournalEntry({
    transactionId: TX_ID,
    sequence: 0,
    previousEntrySha256: null,
    state: 'prepared',
    payload: { hostMutationCount: 0 },
  });
  const ref = await store.appendJournal({
    entry,
    expectedPrior: null,
    writerLockRef,
  });
  assertClosedJournalReturn(ref, entry);

  assertLockDurabilityOrder(events, 'journal');

  const journalEvents = events.filter((event) => event && event.artifact === 'journal');
  assert.equal(journalEvents.length, 3, 'successful journal append must emit exactly three journal events');
  assert.deepEqual(
    journalEvents.map((event) => event.kind),
    ['file-sync', 'directory-sync', 'verify'],
    'journal durability kinds must be exact ordered triple',
  );

  for (const event of journalEvents) {
    assertClosedDurabilityEvent(event, 'journal');
    assert.deepEqual(
      Reflect.ownKeys(event).filter((k) => typeof k === 'string').sort(),
      ['artifact', 'kind'].sort(),
    );
    assertNoSensitiveEventFields(event);
    for (const s of collectStrings(event)) {
      assert.equal(s.includes(JOURNAL_LEAF), false, 'journal event must not embed leaf name path');
      assert.equal(s.includes(metadataRoot), false, 'journal event must not embed metadataRoot');
    }
  }

  const readBack = await store.readJournal({ transactionId: TX_ID });
  assertNoAbsolutePaths(readBack, 'readJournal after durable append');
  assert.equal(isDeeplyFrozen(readBack), true);
  for (const s of collectStrings(readBack)) {
    assert.equal(s.startsWith('/'), false, 'readJournal must not leak absolute paths');
  }
});

// ---------------------------------------------------------------------------
// O–U: receipt publication, terminal release gate, MIR handoff/release (Task 2 RED)
// ---------------------------------------------------------------------------

test('O terminal journal then publishReceipt/readReceipt mode ref and frozen projection', async (t) => {
  const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeTempMetadataRoot(t);
  const store = createLaunchAgentMetadataStore({ metadataRoot });

  assert.equal(typeof store.publishReceipt, 'function', 'store.publishReceipt must be a function');
  assert.equal(typeof store.readReceipt, 'function', 'store.readReceipt must be a function');

  const receipt = buildReceipt();
  const expectedBytes = receiptBytes(receipt);
  const expectedSha = receiptSha(receipt);
  assert.ok(expectedBytes.byteLength <= RECEIPT_MAX_BYTES, 'fixture receipt must stay within 256KiB');
  assert.deepEqual(
    validateLaunchAgentReceipt(receipt),
    receipt,
    'buildReceipt default must pass validateLaunchAgentReceipt',
  );

  const { writerLockRef, receiptHash } = await setupTerminalTransaction(store, { receipt });
  assert.equal(receiptHash, expectedSha, 'terminal journal receiptSha256 must equal exact receipt bytes hash');
  assert.equal(writerLockRef.kind, 'transaction-lock');

  const published = await store.publishReceipt({
    receipt,
    lockRef: writerLockRef,
  });
  assert.deepEqual(published, {
    kind: 'receipt',
    transactionId: TX_ID,
    sha256: expectedSha,
  });
  assert.equal(isDeeplyFrozen(published), true, 'publishReceipt result must be deeply frozen');
  assertNoAbsolutePaths(published, 'publishReceipt result');
  assert.deepEqual(
    Reflect.ownKeys(published).filter((k) => typeof k === 'string').sort(),
    ['kind', 'sha256', 'transactionId'].sort(),
    'publishReceipt result must be closed to kind/transactionId/sha256',
  );

  const leafPath = receiptLeafPath(metadataRoot, TX_ID);
  const leafStat = await lstat(leafPath);
  assert.equal(leafStat.isFile(), true, 'receipt must be a regular file');
  assert.equal(leafStat.isSymbolicLink(), false, 'receipt must not be a symlink');
  assert.equal(leafStat.mode & 0o777, 0o600, 'receipt leaf must be mode 0600');
  assert.equal(leafStat.uid, process.getuid(), 'receipt leaf owner must be current uid');
  assert.equal(leafStat.size, expectedBytes.byteLength, 'receipt on-disk size must match exact UTF-8 bytes');

  const onDisk = await readFile(leafPath);
  assert.equal(Buffer.compare(onDisk, expectedBytes), 0, 'receipt on-disk bytes must equal independent JSON.stringify projection');
  assert.equal(sha256Hex(onDisk), expectedSha);

  const readBack = await store.readReceipt(TX_ID);
  assert.deepEqual(readBack, receipt, 'readReceipt must return frozen closed projection');
  assert.equal(isDeeplyFrozen(readBack), true, 'readReceipt projection must be deeply frozen');
  assertNoAbsolutePaths(readBack, 'readReceipt result');
  assert.deepEqual(validateLaunchAgentReceipt(readBack), readBack);
});

test('P releaseTransactionLock rejects before receipt and after tampered or mode-drift receipt; lock stays', async (t) => {
  const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeTempMetadataRoot(t);
  const store = createLaunchAgentMetadataStore({ metadataRoot });

  const receipt = buildReceipt();
  const { writerLockRef, lockRecord } = await setupTerminalTransaction(store, { receipt });
  const lockBytesBefore = await readLockLeafBytes(metadataRoot, TRANSACTION_LOCK_LEAF);
  await assertOwnedLockLeaf(metadataRoot, TRANSACTION_LOCK_LEAF, lockRecord);

  await assert.rejects(
    () => store.releaseTransactionLock(writerLockRef),
    (error) => error instanceof LaunchAgentLifecycleError,
    'release before receipt must fail closed',
  );
  const afterMissing = await readLockLeafBytes(metadataRoot, TRANSACTION_LOCK_LEAF);
  assert.equal(
    Buffer.compare(afterMissing, lockBytesBefore),
    0,
    'missing-receipt release must leave transaction.lock bytes intact',
  );
  const stillHeld = await lstat(join(metadataRoot, TRANSACTION_LOCK_LEAF));
  assert.equal(stillHeld.isFile(), true, 'missing-receipt release must retain lock leaf');

  await store.publishReceipt({ receipt, lockRef: writerLockRef });
  const leafPath = receiptLeafPath(metadataRoot, TX_ID);
  const originalReceiptBytes = await readFile(leafPath);
  assert.equal(Buffer.compare(originalReceiptBytes, receiptBytes(receipt)), 0);

  // Tamper receipt bytes after durable publish: release must reject and keep lock.
  const tamperedBytes = receiptBytes(buildReceipt({ hostMutationCount: 99 }));
  assert.notEqual(sha256Hex(tamperedBytes), receiptSha(receipt));
  await writeFile(leafPath, tamperedBytes, { mode: 0o600 });
  await assert.rejects(
    () => store.releaseTransactionLock(writerLockRef),
    (error) => error instanceof LaunchAgentLifecycleError,
    'release after tampered receipt must reject',
  );
  const afterTamper = await readLockLeafBytes(metadataRoot, TRANSACTION_LOCK_LEAF);
  assert.equal(
    Buffer.compare(afterTamper, lockBytesBefore),
    0,
    'tampered-receipt release must leave transaction.lock bytes intact',
  );
  assert.equal(
    (await lstat(join(metadataRoot, TRANSACTION_LOCK_LEAF))).isFile(),
    true,
    'tampered-receipt release must retain lock leaf',
  );

  // Restore exact receipt bytes then mode-drift: still reject, lock stays.
  await writeFile(leafPath, originalReceiptBytes, { mode: 0o600 });
  await chmod(leafPath, 0o644);
  const driftedMode = (await lstat(leafPath)).mode;
  await assert.rejects(
    () => store.releaseTransactionLock(writerLockRef),
    (error) => error instanceof LaunchAgentLifecycleError,
    'release after receipt mode drift must reject',
  );
  const afterDrift = await readLockLeafBytes(metadataRoot, TRANSACTION_LOCK_LEAF);
  assert.equal(
    Buffer.compare(afterDrift, lockBytesBefore),
    0,
    'mode-drift receipt release must leave transaction.lock bytes intact',
  );
  assert.equal(
    (await lstat(leafPath)).mode,
    driftedMode,
    'reject must not auto-repair receipt mode',
  );
  assert.equal(
    (await lstat(join(metadataRoot, TRANSACTION_LOCK_LEAF))).isFile(),
    true,
    'mode-drift receipt release must retain lock leaf',
  );
});

test('Q terminal journal then receipt durability triple then lock-release; successful transaction release', async (t) => {
  const createLaunchAgentMetadataStoreForTest = requireFactory('createLaunchAgentMetadataStoreForTest');
  const metadataRoot = await makeTempMetadataRoot(t);
  const events = [];
  const store = createLaunchAgentMetadataStoreForTest({
    metadataRoot,
    fs: fsPromises,
    onDurabilityEvent: (event) => {
      events.push(event);
    },
  });

  const receipt = buildReceipt();
  const expectedSha = receiptSha(receipt);

  await store.initialize();
  const writerLockRef = await store.acquireTransactionLock(validLockRecord({
    transactionId: TX_ID,
    ownerNonce: OWNER_NONCE_A,
  }));

  const prepared = buildJournalEntry({
    transactionId: TX_ID,
    sequence: 0,
    previousEntrySha256: null,
    state: 'prepared',
    payload: { hostMutationCount: 0 },
  });
  await store.appendJournal({
    entry: prepared,
    expectedPrior: null,
    writerLockRef,
  });

  events.length = 0;

  const terminal = buildJournalEntry({
    transactionId: TX_ID,
    sequence: 1,
    previousEntrySha256: prepared.entrySha256,
    state: 'committed',
    at: '2024-01-15T12:00:01.000Z',
    payload: {
      hostMutationCount: 2,
      receiptSha256: expectedSha,
    },
  });
  await store.appendJournal({
    entry: terminal,
    expectedPrior: priorRefFromEntry(prepared),
    writerLockRef,
  });

  const published = await store.publishReceipt({
    receipt,
    lockRef: writerLockRef,
  });
  assert.deepEqual(published, {
    kind: 'receipt',
    transactionId: TX_ID,
    sha256: expectedSha,
  });

  const released = await store.releaseTransactionLock(writerLockRef);
  assert.equal(released, true, 'successful releaseTransactionLock must return true');

  await assertNoLockLeaf(metadataRoot, TRANSACTION_LOCK_LEAF);
  const readBack = await store.readReceipt(TX_ID);
  assert.deepEqual(readBack, receipt);

  const journalEvents = events.filter((event) => event && event.artifact === 'journal');
  const receiptEvents = events.filter((event) => event && event.artifact === 'receipt');
  const lockReleaseEvents = events.filter(
    (event) => event && event.kind === 'lock-release' && event.artifact === 'transaction-lock',
  );

  assert.equal(journalEvents.length, 3, 'terminal journal append must emit exact durability triple');
  assert.deepEqual(
    journalEvents.map((event) => event.kind),
    ['file-sync', 'directory-sync', 'verify'],
    'terminal journal durability kinds must be ordered file-sync → directory-sync → verify',
  );
  assertLockDurabilityOrder(events, 'journal');

  assert.equal(receiptEvents.length, 3, 'publishReceipt must emit exact receipt durability triple');
  assert.deepEqual(
    receiptEvents.map((event) => event.kind),
    ['file-sync', 'directory-sync', 'verify'],
    'receipt durability kinds must be ordered file-sync → directory-sync → verify',
  );
  for (const event of receiptEvents) {
    assertClosedDurabilityEvent(event, 'receipt');
  }

  assert.equal(lockReleaseEvents.length, 1, 'successful release must emit exactly one lock-release event');
  assert.deepEqual(lockReleaseEvents[0], {
    kind: 'lock-release',
    artifact: 'transaction-lock',
  });
  assert.equal(isDeeplyFrozen(lockReleaseEvents[0]), true);
  assertNoSensitiveEventFields(lockReleaseEvents[0]);

  let lastJournalVerify = -1;
  let firstReceiptSync = -1;
  let receiptVerify = -1;
  let lockReleaseIndex = -1;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (!event) continue;
    if (event.kind === 'verify' && event.artifact === 'journal') lastJournalVerify = i;
    if (
      firstReceiptSync === -1
      && event.kind === 'file-sync'
      && event.artifact === 'receipt'
    ) {
      firstReceiptSync = i;
    }
    if (
      receiptVerify === -1
      && event.kind === 'verify'
      && event.artifact === 'receipt'
    ) {
      receiptVerify = i;
    }
    if (
      lockReleaseIndex === -1
      && event.kind === 'lock-release'
      && event.artifact === 'transaction-lock'
    ) {
      lockReleaseIndex = i;
    }
  }

  assert.notEqual(lastJournalVerify, -1);
  assert.notEqual(firstReceiptSync, -1);
  assert.notEqual(receiptVerify, -1);
  assert.notEqual(lockReleaseIndex, -1);
  assert.ok(
    lastJournalVerify < firstReceiptSync,
    'terminal journal verify must complete before receipt file-sync',
  );
  assert.ok(
    receiptVerify < lockReleaseIndex,
    'receipt verify must complete before lock-release',
  );
  assert.ok(
    lockReleaseIndex > receiptVerify,
    'must not emit lock-release before receipt verify',
  );

  // Conditional remove boundary: forged identity cannot release an already-covered lock.
  const store2 = createLaunchAgentMetadataStoreForTest({
    metadataRoot,
    fs: fsPromises,
    onDurabilityEvent: () => {},
  });
  // Re-bind layout via initialize on same root; lock leaf is already gone.
  await store2.initialize();
  await assert.rejects(
    () => store2.releaseTransactionLock(writerLockRef),
    (error) => error instanceof LaunchAgentLifecycleError,
    'release after successful remove must reject (lock absent)',
  );
});

test('R invalid and no-clobber receipt: original bytes unchanged; extra fields reject before mutation', async (t) => {
  const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeTempMetadataRoot(t);
  const store = createLaunchAgentMetadataStore({ metadataRoot });

  const receipt = buildReceipt();
  const { writerLockRef } = await setupTerminalTransaction(store, { receipt });
  const leafPath = receiptLeafPath(metadataRoot, TX_ID);

  // Invalid receipt (forbidden host/raw fields) must reject before any leaf creation.
  const forbiddenExtras = ['path', 'argv', 'env', 'rawError', 'anchorBytes'];
  for (const field of forbiddenExtras) {
    const invalid = {
      ...receipt,
      [field]: field === 'argv' ? ['--evil'] : field === 'env' ? { HOME: '/tmp' } : 'forbidden',
    };
    await assert.rejects(
      () => store.publishReceipt({ receipt: invalid, lockRef: writerLockRef }),
      isInvalidLifecycleError,
      `receipt with extra field ${field} must reject INVALID before mutation`,
    );
    await assert.rejects(
      () => access(leafPath),
      (error) => error && error.code === 'ENOENT',
      `invalid ${field} publish must not create receipt leaf`,
    );
  }

  const published = await store.publishReceipt({ receipt, lockRef: writerLockRef });
  assert.equal(published.sha256, receiptSha(receipt));
  const originalBytes = await readFile(leafPath);
  assert.equal(Buffer.compare(originalBytes, receiptBytes(receipt)), 0);

  const different = buildReceipt({
    hostMutationCount: 3,
    outcome: 'no-change',
    success: false,
    state: 'no-change',
  });
  assert.notEqual(receiptSha(different), receiptSha(receipt));
  await assert.rejects(
    () => store.publishReceipt({ receipt: different, lockRef: writerLockRef }),
    (error) => error instanceof LaunchAgentLifecycleError,
    'second different receipt for same transaction must reject (no-clobber)',
  );
  const afterClobberAttempt = await readFile(leafPath);
  assert.equal(
    Buffer.compare(afterClobberAttempt, originalBytes),
    0,
    'no-clobber reject must leave original receipt bytes exact',
  );
  const afterStat = await lstat(leafPath);
  assert.equal(afterStat.mode & 0o777, 0o600, 'no-clobber reject must not alter receipt mode');
});

test('S MIR journal then MIR lock then special releaseTransactionLock leaves MIR', async (t) => {
  const createLaunchAgentMetadataStoreForTest = requireFactory('createLaunchAgentMetadataStoreForTest');
  const metadataRoot = await makeTempMetadataRoot(t);
  const events = [];
  const store = createLaunchAgentMetadataStoreForTest({
    metadataRoot,
    fs: fsPromises,
    onDurabilityEvent: (event) => {
      events.push(event);
    },
  });
  await store.initialize();

  const txRecord = validLockRecord({
    transactionId: TX_ID,
    ownerNonce: OWNER_NONCE_A,
  });
  const txRef = await store.acquireTransactionLock(txRecord);
  const txBytes = await readLockLeafBytes(metadataRoot, TRANSACTION_LOCK_LEAF);

  const prepared = buildJournalEntry({
    transactionId: TX_ID,
    sequence: 0,
    previousEntrySha256: null,
    state: 'prepared',
    payload: { hostMutationCount: 0 },
  });
  await store.appendJournal({
    entry: prepared,
    expectedPrior: null,
    writerLockRef: txRef,
  });

  const mirJournal = buildJournalEntry({
    transactionId: TX_ID,
    sequence: 1,
    previousEntrySha256: prepared.entrySha256,
    state: 'manual-intervention-required',
    at: '2024-01-15T12:00:01.000Z',
    payload: { hostMutationCount: 0 },
  });
  await store.appendJournal({
    entry: mirJournal,
    expectedPrior: priorRefFromEntry(prepared),
    writerLockRef: txRef,
  });

  const mirRecord = validLockRecord({
    transactionId: TX_ID,
    ownerNonce: OWNER_NONCE_MIR,
    ownerPid: FIXED_OWNER_PID + 3,
  });
  const mirRef = await store.acquireManualInterventionLock(mirRecord);
  const mirBytes = await assertOwnedLockLeaf(
    metadataRoot,
    MANUAL_INTERVENTION_LOCK_LEAF,
    mirRecord,
  );

  // Ordinary release / wrong options / missing MIR ref must reject and keep both locks.
  await assert.rejects(
    () => store.releaseTransactionLock(txRef),
    (error) => error instanceof LaunchAgentLifecycleError,
    'ordinary release while latest is manual-intervention-required must reject',
  );
  await assert.rejects(
    () => store.releaseTransactionLock(txRef, {}),
    isInvalidLifecycleError,
    'empty options object must reject special MIR handoff',
  );
  await assert.rejects(
    () => store.releaseTransactionLock(txRef, { unexpected: true }),
    isInvalidLifecycleError,
    'non-exact options keys must reject special MIR handoff',
  );
  await assert.rejects(
    () => store.releaseTransactionLock(txRef, {
      manualInterventionLockRef: {
        ...mirRef,
        sha256: '0'.repeat(64),
      },
    }),
    isInvalidLifecycleError,
    'forged MIR ref must reject special MIR handoff',
  );
  assert.equal(
    Buffer.compare(await readLockLeafBytes(metadataRoot, TRANSACTION_LOCK_LEAF), txBytes),
    0,
    'failed special-release attempts must leave transaction.lock bytes intact',
  );
  assert.equal(
    Buffer.compare(
      await readLockLeafBytes(metadataRoot, MANUAL_INTERVENTION_LOCK_LEAF),
      mirBytes,
    ),
    0,
    'failed special-release attempts must leave MIR lock bytes intact',
  );

  events.length = 0;
  const released = await store.releaseTransactionLock(txRef, {
    manualInterventionLockRef: mirRef,
  });
  assert.equal(released, true, 'special MIR handoff release must return true');

  await assertNoLockLeaf(metadataRoot, TRANSACTION_LOCK_LEAF);
  await assertOwnedLockLeaf(metadataRoot, MANUAL_INTERVENTION_LOCK_LEAF, mirRecord);
  assert.equal(
    Buffer.compare(
      await readLockLeafBytes(metadataRoot, MANUAL_INTERVENTION_LOCK_LEAF),
      mirBytes,
    ),
    0,
    'special release must retain exact MIR lock bytes',
  );

  const lockReleaseEvents = events.filter(
    (event) => event && event.kind === 'lock-release' && event.artifact === 'transaction-lock',
  );
  assert.equal(lockReleaseEvents.length, 1, 'special release must emit transaction-lock lock-release');
  assert.deepEqual(lockReleaseEvents[0], {
    kind: 'lock-release',
    artifact: 'transaction-lock',
  });
  assert.equal(isDeeplyFrozen(lockReleaseEvents[0]), true);
  assertNoSensitiveEventFields(lockReleaseEvents[0]);

  // No receipt is published on MIR-required path.
  await assert.rejects(
    () => access(receiptLeafPath(metadataRoot, TX_ID)),
    (error) => error && error.code === 'ENOENT',
    'MIR handoff must not publish a receipt leaf',
  );
});

test('T MIR writer recovered terminal plus receipt then releaseManualInterventionLock', async (t) => {
  const createLaunchAgentMetadataStoreForTest = requireFactory('createLaunchAgentMetadataStoreForTest');
  const metadataRoot = await makeTempMetadataRoot(t);
  const events = [];
  const store = createLaunchAgentMetadataStoreForTest({
    metadataRoot,
    fs: fsPromises,
    onDurabilityEvent: (event) => {
      events.push(event);
    },
  });
  await store.initialize();

  const txRef = await store.acquireTransactionLock(validLockRecord({
    transactionId: TX_ID,
    ownerNonce: OWNER_NONCE_A,
  }));

  const prepared = buildJournalEntry({
    transactionId: TX_ID,
    sequence: 0,
    previousEntrySha256: null,
    state: 'prepared',
    payload: { hostMutationCount: 0 },
  });
  await store.appendJournal({
    entry: prepared,
    expectedPrior: null,
    writerLockRef: txRef,
  });

  const mirRequired = buildJournalEntry({
    transactionId: TX_ID,
    sequence: 1,
    previousEntrySha256: prepared.entrySha256,
    state: 'manual-intervention-required',
    at: '2024-01-15T12:00:01.000Z',
    payload: { hostMutationCount: 0 },
  });
  await store.appendJournal({
    entry: mirRequired,
    expectedPrior: priorRefFromEntry(prepared),
    writerLockRef: txRef,
  });

  const mirRecord = validLockRecord({
    transactionId: TX_ID,
    ownerNonce: OWNER_NONCE_MIR,
    ownerPid: FIXED_OWNER_PID + 5,
  });
  const mirRef = await store.acquireManualInterventionLock(mirRecord);
  await store.releaseTransactionLock(txRef, { manualInterventionLockRef: mirRef });
  await assertNoLockLeaf(metadataRoot, TRANSACTION_LOCK_LEAF);
  await assertOwnedLockLeaf(metadataRoot, MANUAL_INTERVENTION_LOCK_LEAF, mirRecord);

  // Ordinary MIR release while latest is still MIR-required must fail closed.
  const mirBytesBeforeTerminal = await readLockLeafBytes(
    metadataRoot,
    MANUAL_INTERVENTION_LOCK_LEAF,
  );
  await assert.rejects(
    () => store.releaseManualInterventionLock(mirRef),
    (error) => error instanceof LaunchAgentLifecycleError,
    'releaseManualInterventionLock without recovered|blocked terminal+receipt must reject',
  );
  assert.equal(
    Buffer.compare(
      await readLockLeafBytes(metadataRoot, MANUAL_INTERVENTION_LOCK_LEAF),
      mirBytesBeforeTerminal,
    ),
    0,
    'fail-closed MIR release must retain MIR lock bytes',
  );

  const recoveredReceipt = buildReceipt({
    operation: 'recover',
    state: 'recovered',
    success: true,
    outcome: 'completed',
    hostMutationCount: 2,
  });
  const recoveredHash = receiptSha(recoveredReceipt);
  const recovered = buildJournalEntry({
    transactionId: TX_ID,
    sequence: 2,
    previousEntrySha256: mirRequired.entrySha256,
    operation: 'recover',
    state: 'recovered',
    at: '2024-01-15T12:00:02.000Z',
    payload: {
      hostMutationCount: 2,
      receiptSha256: recoveredHash,
    },
  });
  await store.appendJournal({
    entry: recovered,
    expectedPrior: priorRefFromEntry(mirRequired),
    writerLockRef: mirRef,
  });

  const published = await store.publishReceipt({
    receipt: recoveredReceipt,
    lockRef: mirRef,
  });
  assert.deepEqual(published, {
    kind: 'receipt',
    transactionId: TX_ID,
    sha256: recoveredHash,
  });
  assert.deepEqual(await store.readReceipt(TX_ID), recoveredReceipt);

  events.length = 0;
  const released = await store.releaseManualInterventionLock(mirRef);
  assert.equal(released, true, 'releaseManualInterventionLock must return true after recovered+receipt');

  await assertNoLockLeaf(metadataRoot, MANUAL_INTERVENTION_LOCK_LEAF);
  await assertNoLockLeaf(metadataRoot, TRANSACTION_LOCK_LEAF);

  const mirReleaseEvents = events.filter(
    (event) => event
      && event.kind === 'lock-release'
      && event.artifact === 'manual-intervention-lock',
  );
  assert.equal(mirReleaseEvents.length, 1, 'MIR release must emit lock-release for manual-intervention-lock');
  assert.deepEqual(mirReleaseEvents[0], {
    kind: 'lock-release',
    artifact: 'manual-intervention-lock',
  });
  assert.equal(isDeeplyFrozen(mirReleaseEvents[0]), true);
  assertNoSensitiveEventFields(mirReleaseEvents[0]);
});

test('U foreign nonterminal prefix plus blocked receipt and current lock release', async (t) => {
  const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeTempMetadataRoot(t);
  const store = createLaunchAgentMetadataStore({ metadataRoot });
  await store.initialize();

  const foreignPrepared = buildJournalEntry({
    transactionId: TX_ID_B,
    sequence: 0,
    previousEntrySha256: null,
    operation: 'install',
    state: 'prepared',
    payload: { hostMutationCount: 0 },
  });
  const foreignHash = foreignPrepared.entrySha256;
  const preseedBytes = journalLineBuffer(foreignPrepared);
  await writeFile(journalLeafPath(metadataRoot), preseedBytes, { mode: 0o600 });
  await assertJournalLeafMode(metadataRoot);

  const blockedReceipt = buildReceipt({
    state: 'blocked',
    success: false,
    hostMutationCount: 0,
    outcome: 'transaction-in-progress',
    roles: {
      controller: { label: CONTROLLER_LABEL, outcome: 'unchanged', changed: false },
      scheduler: { label: SCHEDULER_LABEL, outcome: 'unchanged', changed: false },
    },
  });
  const blockedHash = receiptSha(blockedReceipt);
  assert.deepEqual(
    validateLaunchAgentReceipt(blockedReceipt),
    blockedReceipt,
    'blocked receipt fixture must pass schema validation',
  );

  const writerLockRef = await store.acquireTransactionLock(validLockRecord({
    transactionId: TX_ID,
    ownerNonce: OWNER_NONCE_A,
  }));

  // Current tx starts at seq0 blocked (store does not invent foreign discovery).
  const blockedEntry = buildJournalEntry({
    transactionId: TX_ID,
    sequence: 0,
    previousEntrySha256: null,
    operation: 'install',
    state: 'blocked',
    payload: {
      hostMutationCount: 0,
      receiptSha256: blockedHash,
      blockedByEntrySha256: foreignHash,
    },
  });
  await store.appendJournal({
    entry: blockedEntry,
    expectedPrior: null,
    writerLockRef,
  });

  const afterAppend = await readJournalLeafBytes(metadataRoot);
  assert.equal(
    Buffer.compare(afterAppend.subarray(0, preseedBytes.byteLength), preseedBytes),
    0,
    'blocked append for TX_ID must preserve exact physical prefix of foreign prepared line',
  );
  assert.equal(
    Buffer.compare(
      afterAppend,
      Buffer.concat([preseedBytes, journalLineBuffer(blockedEntry)]),
    ),
    0,
    'journal must be foreign preseed line + current blocked line exactly',
  );

  const published = await store.publishReceipt({
    receipt: blockedReceipt,
    lockRef: writerLockRef,
  });
  assert.deepEqual(published, {
    kind: 'receipt',
    transactionId: TX_ID,
    sha256: blockedHash,
  });
  assert.deepEqual(await store.readReceipt(TX_ID), blockedReceipt);

  const released = await store.releaseTransactionLock(writerLockRef);
  assert.equal(released, true, 'blocked terminal with matching receipt must release transaction lock');
  await assertNoLockLeaf(metadataRoot, TRANSACTION_LOCK_LEAF);

  const afterReleaseJournal = await readJournalLeafBytes(metadataRoot);
  assert.equal(
    Buffer.compare(afterReleaseJournal.subarray(0, preseedBytes.byteLength), preseedBytes),
    0,
    'release must leave foreign physical prefix exact',
  );
  assert.equal(
    Buffer.compare(afterReleaseJournal, afterAppend),
    0,
    'release must not mutate journal bytes',
  );

  const readForeign = await store.readJournal({ transactionId: TX_ID_B });
  assert.equal(readForeign.length, 1, 'readJournal(TX_ID_B) must remain a single foreign entry');
  assert.deepEqual(readForeign[0], foreignPrepared, 'foreign nonterminal prepared line must be unchanged');
  assert.equal(isDeeplyFrozen(readForeign), true);

  const readCurrent = await store.readJournal({ transactionId: TX_ID });
  assert.equal(readCurrent.length, 1);
  assert.deepEqual(readCurrent[0], blockedEntry);
});

// ---------------------------------------------------------------------------
// V–Y: durable consumed-confirmation (Task 2 RED — store methods still stubs)
// ---------------------------------------------------------------------------

test('V consumeConfirmation/readConsumedConfirmation roundtrip mode ref and frozen projection', async (t) => {
  const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeTempMetadataRoot(t);
  const store = createLaunchAgentMetadataStore({ metadataRoot });

  assert.equal(
    typeof store.consumeConfirmation,
    'function',
    'store.consumeConfirmation must be a function',
  );
  assert.equal(
    typeof store.readConsumedConfirmation,
    'function',
    'store.readConsumedConfirmation must be a function',
  );

  const record = buildConsumedConfirmation();
  const expectedBytes = consumedConfirmationBytes(record);
  const expectedSha = consumedConfirmationSha(record);
  assert.ok(
    expectedBytes.byteLength <= CONFIRMATION_MAX_BYTES,
    'fixture consumed-confirmation must stay within 256KiB',
  );
  assert.deepEqual(
    validateLaunchAgentConsumedConfirmation(record),
    record,
    'buildConsumedConfirmation default must pass validateLaunchAgentConsumedConfirmation',
  );
  assert.notEqual(record.confirmationId, record.acceptanceId);

  await store.initialize();

  const confDirStat = await lstat(join(metadataRoot, 'confirmations'));
  assert.equal(confDirStat.isDirectory(), true, 'confirmations mid-dir must exist after initialize');
  assert.equal(confDirStat.mode & 0o777, 0o700, 'confirmations mid-dir must be mode 0700');

  const consumed = await store.consumeConfirmation(record);
  assert.deepEqual(consumed, {
    kind: 'consumed-confirmation',
    confirmationId: CONFIRMATION_ID,
    sha256: expectedSha,
  });
  assert.equal(isDeeplyFrozen(consumed), true, 'consumeConfirmation result must be deeply frozen');
  assertNoAbsolutePaths(consumed, 'consumeConfirmation result');
  assert.deepEqual(
    Reflect.ownKeys(consumed).filter((k) => typeof k === 'string').sort(),
    ['confirmationId', 'kind', 'sha256'].sort(),
    'consumeConfirmation result must be closed to kind/confirmationId/sha256',
  );

  const leafPath = confirmationLeafPath(metadataRoot, CONFIRMATION_ID);
  const leafStat = await lstat(leafPath);
  assert.equal(leafStat.isFile(), true, 'consumed-confirmation must be a regular file');
  assert.equal(leafStat.isSymbolicLink(), false, 'consumed-confirmation must not be a symlink');
  assert.equal(leafStat.mode & 0o777, 0o600, 'consumed-confirmation leaf must be mode 0600');
  assert.equal(leafStat.uid, process.getuid(), 'consumed-confirmation leaf owner must be current uid');
  assert.equal(
    leafStat.size,
    expectedBytes.byteLength,
    'consumed-confirmation on-disk size must match exact UTF-8 bytes',
  );

  const onDisk = await readFile(leafPath);
  assert.equal(
    Buffer.compare(onDisk, expectedBytes),
    0,
    'consumed-confirmation on-disk bytes must equal independent JSON.stringify projection',
  );
  assert.equal(sha256Hex(onDisk), expectedSha);

  const readBack = await store.readConsumedConfirmation(CONFIRMATION_ID);
  assert.deepEqual(
    readBack,
    record,
    'readConsumedConfirmation must return frozen closed projection',
  );
  assert.equal(isDeeplyFrozen(readBack), true, 'readConsumedConfirmation projection must be deeply frozen');
  assertNoAbsolutePaths(readBack, 'readConsumedConfirmation result');
  assert.deepEqual(validateLaunchAgentConsumedConfirmation(readBack), readBack);
});

test('W two-store concurrent consume + replay no-clobber is confirmation-consumed', async (t) => {
  const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');
  const metadataRoot = await makeTempMetadataRoot(t);

  const storeA = createLaunchAgentMetadataStore({ metadataRoot });
  const storeB = createLaunchAgentMetadataStore({ metadataRoot });
  await storeA.initialize();
  await storeB.initialize();

  const record = buildConsumedConfirmation();
  const expectedBytes = consumedConfirmationBytes(record);
  const expectedSha = consumedConfirmationSha(record);

  const settled = await Promise.allSettled([
    storeA.consumeConfirmation(record),
    storeB.consumeConfirmation(record),
  ]);

  const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
  const rejected = settled.filter((entry) => entry.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one concurrent consume must fulfill');
  assert.equal(rejected.length, 1, 'exactly one concurrent consume must reject');
  assert.equal(
    isConfirmationConsumedError(rejected[0].reason),
    true,
    'loser must throw LaunchAgentLifecycleError code/message confirmation-consumed (not INVALID/EEXIST leak)',
  );

  const winner = fulfilled[0].value;
  assert.deepEqual(winner, {
    kind: 'consumed-confirmation',
    confirmationId: CONFIRMATION_ID,
    sha256: expectedSha,
  });
  assert.equal(isDeeplyFrozen(winner), true);
  assertNoAbsolutePaths(winner, 'concurrent consume winner ref');

  const leafPath = confirmationLeafPath(metadataRoot, CONFIRMATION_ID);
  const originalBytes = await readFile(leafPath);
  assert.equal(Buffer.compare(originalBytes, expectedBytes), 0);
  const originalStat = await lstat(leafPath);
  assert.equal(originalStat.mode & 0o777, 0o600);
  const originalMode = originalStat.mode;
  const originalSha = sha256Hex(originalBytes);

  // Replay identical bytes through the other store must confirmation-consumed and preserve leaf.
  await assert.rejects(
    () => storeB.consumeConfirmation(record),
    isConfirmationConsumedError,
    'replay of same record must reject with confirmation-consumed',
  );
  await assert.rejects(
    () => storeA.consumeConfirmation(record),
    isConfirmationConsumedError,
    'winner-store replay must also reject with confirmation-consumed',
  );

  // Replay with a different valid binding for the same confirmationId must still no-clobber.
  const rebound = buildConsumedConfirmation({
    acceptanceId: ACCEPTANCE_ID_B,
    consumedAt: '2024-01-15T12:00:01.000Z',
    runtimeArtifactsSha256:
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  });
  assert.equal(rebound.confirmationId, CONFIRMATION_ID);
  assert.notEqual(consumedConfirmationSha(rebound), expectedSha);
  assert.deepEqual(
    validateLaunchAgentConsumedConfirmation(rebound),
    rebound,
    'rebound fixture must still pass closed validator',
  );
  await assert.rejects(
    () => storeA.consumeConfirmation(rebound),
    isConfirmationConsumedError,
    'replay with different valid binding for same confirmationId must be confirmation-consumed',
  );

  const afterReplay = await readFile(leafPath);
  assert.equal(
    Buffer.compare(afterReplay, originalBytes),
    0,
    'replay/no-clobber must leave original confirmation bytes exact',
  );
  assert.equal(sha256Hex(afterReplay), originalSha);
  const afterStat = await lstat(leafPath);
  assert.equal(afterStat.mode, originalMode, 'replay must not alter confirmation mode');
  assert.equal(afterStat.mode & 0o777, 0o600);

  // Independent confirmationId on either store still succeeds (no global single-slot).
  const other = buildConsumedConfirmation({
    confirmationId: CONFIRMATION_ID_B,
    acceptanceId: ACCEPTANCE_ID_B,
  });
  const otherRef = await storeB.consumeConfirmation(other);
  assert.deepEqual(otherRef, {
    kind: 'consumed-confirmation',
    confirmationId: CONFIRMATION_ID_B,
    sha256: consumedConfirmationSha(other),
  });
  assert.equal(
    Buffer.compare(await readFile(leafPath), originalBytes),
    0,
    'consuming a distinct confirmationId must not clobber the original leaf',
  );
});

test('X consumed-confirmation fail-closed: missing corrupt mode symlink directory oversize invalid', async (t) => {
  const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');

  // Behavioral gate: planted canonical bytes must be readable (RED under confirmation stubs).
  {
    const metadataRoot = await makeTempMetadataRoot(t);
    const store = createLaunchAgentMetadataStore({ metadataRoot });
    await store.initialize();
    const record = buildConsumedConfirmation();
    const leaf = confirmationLeafPath(metadataRoot, CONFIRMATION_ID);
    await writeFile(leaf, consumedConfirmationBytes(record), { mode: 0o600 });
    const readBack = await store.readConsumedConfirmation(CONFIRMATION_ID);
    assert.deepEqual(
      readBack,
      record,
      'valid planted confirmation control must return closed projection',
    );
    assert.equal(isDeeplyFrozen(readBack), true);
    assert.deepEqual(validateLaunchAgentConsumedConfirmation(readBack), readBack);
  }

  await t.test('X missing confirmationId', async (st) => {
    const metadataRoot = await makeTempMetadataRoot(st);
    const store = createLaunchAgentMetadataStore({ metadataRoot });
    await store.initialize();

    await assert.rejects(
      () => store.readConsumedConfirmation(CONFIRMATION_ID),
      (error) => error instanceof LaunchAgentLifecycleError,
      'readConsumedConfirmation of absent leaf must fail closed',
    );
    await assert.rejects(
      () => access(confirmationLeafPath(metadataRoot, CONFIRMATION_ID)),
      (error) => error && error.code === 'ENOENT',
      'missing read must not create confirmation leaf',
    );
  });

  await t.test('X corrupt JSON', async (st) => {
    const metadataRoot = await makeTempMetadataRoot(st);
    const store = createLaunchAgentMetadataStore({ metadataRoot });
    await store.initialize();
    const leaf = confirmationLeafPath(metadataRoot, CONFIRMATION_ID);
    const corrupt = Buffer.from('{not-json', 'utf8');
    await writeFile(leaf, corrupt, { mode: 0o600 });
    const before = await readFile(leaf);

    await assert.rejects(
      () => store.readConsumedConfirmation(CONFIRMATION_ID),
      (error) => error instanceof LaunchAgentLifecycleError,
      'corrupt confirmation JSON must fail closed',
    );
    assert.equal(
      Buffer.compare(await readFile(leaf), before),
      0,
      'corrupt reject must not rewrite confirmation bytes',
    );
  });

  await t.test('X extra fields on disk', async (st) => {
    const metadataRoot = await makeTempMetadataRoot(st);
    const store = createLaunchAgentMetadataStore({ metadataRoot });
    await store.initialize();
    const record = buildConsumedConfirmation();
    const withExtra = {
      ...JSON.parse(consumedConfirmationBytes(record).toString('utf8')),
      secret: 'must-not-accept',
    };
    const leaf = confirmationLeafPath(metadataRoot, CONFIRMATION_ID);
    const bytes = Buffer.from(JSON.stringify(withExtra), 'utf8');
    await writeFile(leaf, bytes, { mode: 0o600 });
    const before = await readFile(leaf);

    await assert.rejects(
      () => store.readConsumedConfirmation(CONFIRMATION_ID),
      (error) => error instanceof LaunchAgentLifecycleError,
      'extra on-disk fields must fail closed',
    );
    assert.equal(
      Buffer.compare(await readFile(leaf), before),
      0,
      'extra-field reject must not rewrite confirmation bytes',
    );
  });

  await t.test('X non-canonical key order bytes', async (st) => {
    const metadataRoot = await makeTempMetadataRoot(st);
    const store = createLaunchAgentMetadataStore({ metadataRoot });
    await store.initialize();
    const record = buildConsumedConfirmation();
    const canonical = consumedConfirmationBytes(record);
    // Same logical fields, non-canonical key order → different UTF-8 bytes.
    const nonCanonical = Buffer.from(JSON.stringify({
      consumedAt: record.consumedAt,
      runtimeArtifactsSha256: record.runtimeArtifactsSha256,
      sourceCommit: record.sourceCommit,
      acceptanceId: record.acceptanceId,
      confirmationId: record.confirmationId,
      schemaVersion: record.schemaVersion,
    }), 'utf8');
    assert.notEqual(
      Buffer.compare(nonCanonical, canonical),
      0,
      'precondition: non-canonical key order must differ from projection stringify',
    );
    const leaf = confirmationLeafPath(metadataRoot, CONFIRMATION_ID);
    await writeFile(leaf, nonCanonical, { mode: 0o600 });
    const before = await readFile(leaf);

    await assert.rejects(
      () => store.readConsumedConfirmation(CONFIRMATION_ID),
      (error) => error instanceof LaunchAgentLifecycleError,
      'non-canonical confirmation bytes must fail closed',
    );
    assert.equal(
      Buffer.compare(await readFile(leaf), before),
      0,
      'non-canonical reject must not rewrite confirmation bytes',
    );
  });

  await t.test('X mode drift 0644 without auto-repair', async (st) => {
    const metadataRoot = await makeTempMetadataRoot(st);
    const store = createLaunchAgentMetadataStore({ metadataRoot });
    await store.initialize();
    const record = buildConsumedConfirmation();
    const leaf = confirmationLeafPath(metadataRoot, CONFIRMATION_ID);
    await writeFile(leaf, consumedConfirmationBytes(record), { mode: 0o600 });
    await chmod(leaf, 0o644);
    const degraded = await lstat(leaf);
    assert.equal(degraded.mode & 0o777, 0o644, 'precondition: confirmation mode degraded to 0644');
    const before = await readFile(leaf);

    await assert.rejects(
      () => store.readConsumedConfirmation(CONFIRMATION_ID),
      (error) => error instanceof LaunchAgentLifecycleError,
      'mode-drift confirmation must fail closed',
    );
    const after = await lstat(leaf);
    assert.equal(after.mode & 0o777, 0o644, 'read must not auto-chmod confirmation back to 0600');
    assert.equal(
      Buffer.compare(await readFile(leaf), before),
      0,
      'mode-drift reject must not rewrite confirmation bytes',
    );
  });

  await t.test('X symlink leaf', async (st) => {
    const metadataRoot = await makeTempMetadataRoot(st);
    const store = createLaunchAgentMetadataStore({ metadataRoot });
    await store.initialize();

    const victimDir = await mkdtemp(join(tmpdir(), 'linke-la-conf-victim-'));
    st.after(async () => {
      await rm(victimDir, { recursive: true, force: true });
    });
    const victimPath = join(victimDir, 'victim.json');
    const victimBytes = Buffer.from('do-not-clobber-confirmation-victim');
    await writeFile(victimPath, victimBytes, { mode: 0o600 });

    const leaf = confirmationLeafPath(metadataRoot, CONFIRMATION_ID);
    await symlink(victimPath, leaf);

    await assert.rejects(
      () => store.readConsumedConfirmation(CONFIRMATION_ID),
      (error) => error instanceof LaunchAgentLifecycleError,
      'symlink confirmation leaf must fail closed',
    );
    assert.equal(
      Buffer.compare(await readFile(victimPath), victimBytes),
      0,
      'symlink reject must not clobber victim bytes',
    );
    const linkStat = await lstat(leaf);
    assert.equal(linkStat.isSymbolicLink(), true, 'confirmation leaf must remain a symlink');
  });

  await t.test('X directory at leaf path', async (st) => {
    const metadataRoot = await makeTempMetadataRoot(st);
    const store = createLaunchAgentMetadataStore({ metadataRoot });
    await store.initialize();
    const leaf = confirmationLeafPath(metadataRoot, CONFIRMATION_ID);
    await mkdir(leaf, { mode: 0o700 });
    const beforeStat = await lstat(leaf);
    assert.equal(beforeStat.isDirectory(), true, 'precondition: leaf path is a directory');

    await assert.rejects(
      () => store.readConsumedConfirmation(CONFIRMATION_ID),
      (error) => error instanceof LaunchAgentLifecycleError,
      'directory at confirmation leaf path must fail closed',
    );
    const afterStat = await lstat(leaf);
    assert.equal(afterStat.isDirectory(), true, 'directory leaf must remain a directory');
  });

  await t.test('X oversize leaf', async (st) => {
    const metadataRoot = await makeTempMetadataRoot(st);
    const store = createLaunchAgentMetadataStore({ metadataRoot });
    await store.initialize();
    const leaf = confirmationLeafPath(metadataRoot, CONFIRMATION_ID);
    const oversize = Buffer.alloc(CONFIRMATION_MAX_BYTES + 1, 0x61);
    await writeFile(leaf, oversize, { mode: 0o600 });
    const before = await readFile(leaf);
    assert.equal(before.byteLength, CONFIRMATION_MAX_BYTES + 1);

    await assert.rejects(
      () => store.readConsumedConfirmation(CONFIRMATION_ID),
      (error) => error instanceof LaunchAgentLifecycleError,
      'oversize confirmation leaf must fail closed',
    );
    assert.equal(
      Buffer.compare(await readFile(leaf), before),
      0,
      'oversize reject must not rewrite confirmation bytes',
    );
  });

  await t.test('X invalid record rejects before filesystem mutation', async (st) => {
    const metadataRoot = await makeTempMetadataRoot(st);
    const store = createLaunchAgentMetadataStore({ metadataRoot });
    await store.initialize();
    const base = buildConsumedConfirmation();
    const leaf = confirmationLeafPath(metadataRoot, CONFIRMATION_ID);

    const forbiddenExtras = [
      ['path', '/tmp/evil'],
      ['argv', ['--evil']],
      ['env', { HOME: '/tmp' }],
      ['rawError', 'EEXIST leak'],
      ['secret', 'must-not-persist'],
    ];

    for (const [field, value] of forbiddenExtras) {
      const invalid = { ...base, [field]: value };
      await assert.rejects(
        () => store.consumeConfirmation(invalid),
        isInvalidLifecycleError,
        `consume with extra field ${field} must reject INVALID before mutation`,
      );
      await assert.rejects(
        () => access(leaf),
        (error) => error && error.code === 'ENOENT',
        `invalid ${field} consume must not create confirmation leaf`,
      );
    }

    // confirmationId === acceptanceId is schema-invalid and must not create a leaf.
    const sameIds = buildConsumedConfirmation({
      confirmationId: CONFIRMATION_ID,
      acceptanceId: CONFIRMATION_ID,
    });
    await assert.rejects(
      () => store.consumeConfirmation(sameIds),
      isInvalidLifecycleError,
      'confirmationId === acceptanceId must reject INVALID before mutation',
    );
    await assert.rejects(
      () => access(leaf),
      (error) => error && error.code === 'ENOENT',
      'same-id invalid consume must not create confirmation leaf',
    );
  });
});

test('Y consumeConfirmation durability triple closed frozen ordering and failure silence', async (t) => {
  const createLaunchAgentMetadataStoreForTest = requireFactory('createLaunchAgentMetadataStoreForTest');
  const metadataRoot = await makeTempMetadataRoot(t);
  const events = [];
  const store = createLaunchAgentMetadataStoreForTest({
    metadataRoot,
    fs: fsPromises,
    onDurabilityEvent: (event) => {
      events.push(event);
    },
  });

  await store.initialize();
  events.length = 0;

  const record = buildConsumedConfirmation();
  const expectedSha = consumedConfirmationSha(record);

  const consumed = await store.consumeConfirmation(record);
  assert.deepEqual(consumed, {
    kind: 'consumed-confirmation',
    confirmationId: CONFIRMATION_ID,
    sha256: expectedSha,
  });

  const confirmationEvents = events.filter(
    (event) => event && event.artifact === 'confirmation',
  );
  assert.equal(
    confirmationEvents.length,
    3,
    'successful consumeConfirmation must emit exact confirmation durability triple',
  );
  assert.deepEqual(
    confirmationEvents.map((event) => event.kind),
    ['file-sync', 'directory-sync', 'verify'],
    'confirmation durability kinds must be ordered file-sync → directory-sync → verify',
  );
  for (const event of confirmationEvents) {
    assertClosedDurabilityEvent(event, 'confirmation');
  }
  assert.deepEqual(confirmationEvents[0], {
    kind: 'file-sync',
    artifact: 'confirmation',
  });
  assert.deepEqual(confirmationEvents[1], {
    kind: 'directory-sync',
    artifact: 'confirmation',
  });
  assert.deepEqual(confirmationEvents[2], {
    kind: 'verify',
    artifact: 'confirmation',
  });

  // No path / raw payload / sensitive fields anywhere in the success stream.
  for (const event of events) {
    assertNoSensitiveEventFields(event);
    assertNoAbsolutePaths(event, 'confirmation durability stream');
  }

  const leafPath = confirmationLeafPath(metadataRoot, CONFIRMATION_ID);
  const originalBytes = await readFile(leafPath);
  assert.equal(Buffer.compare(originalBytes, consumedConfirmationBytes(record)), 0);

  // Failure paths must not emit a success durability triple.
  events.length = 0;
  await assert.rejects(
    () => store.consumeConfirmation(record),
    isConfirmationConsumedError,
    'replay after success must be confirmation-consumed',
  );
  const replayConfirmationEvents = events.filter(
    (event) => event && event.artifact === 'confirmation',
  );
  assert.equal(
    replayConfirmationEvents.length,
    0,
    'confirmation-consumed failure must not emit confirmation durability triple',
  );
  assert.equal(
    Buffer.compare(await readFile(leafPath), originalBytes),
    0,
    'failed replay must leave confirmation bytes exact',
  );

  events.length = 0;
  const invalid = {
    ...record,
    path: '/tmp/must-not-reach-disk',
    secret: 'nope',
  };
  await assert.rejects(
    () => store.consumeConfirmation(invalid),
    isInvalidLifecycleError,
    'invalid record must reject INVALID without durability success triple',
  );
  const invalidConfirmationEvents = events.filter(
    (event) => event && event.artifact === 'confirmation',
  );
  assert.equal(
    invalidConfirmationEvents.length,
    0,
    'INVALID consume must not emit confirmation durability triple',
  );
  assert.equal(
    Buffer.compare(await readFile(leafPath), originalBytes),
    0,
    'invalid consume after success must not clobber existing confirmation leaf',
  );

  // Distinct confirmationId still gets its own ordered success triple.
  events.length = 0;
  const other = buildConsumedConfirmation({
    confirmationId: CONFIRMATION_ID_B,
    acceptanceId: ACCEPTANCE_ID_B,
  });
  await store.consumeConfirmation(other);
  const otherEvents = events.filter(
    (event) => event && event.artifact === 'confirmation',
  );
  assert.equal(otherEvents.length, 3, 'second distinct consume must emit its own durability triple');
  assert.deepEqual(
    otherEvents.map((event) => event.kind),
    ['file-sync', 'directory-sync', 'verify'],
  );
  for (const event of otherEvents) {
    assertClosedDurabilityEvent(event, 'confirmation');
  }
});

// ---------------------------------------------------------------------------
// Task 2.5 RED: zero-argument global journal-head snapshot.
// 完整行为仅在 method surface 出现后注册；当前基线只有 frozen surface 的
// readJournalHeads 缺失断言失败，不允许 TypeError/import/fixture 假 RED。
// ---------------------------------------------------------------------------

if (HAS_READ_JOURNAL_HEADS) {
  test('Z readJournalHeads global snapshot contract', async (t) => {
    const createLaunchAgentMetadataStore = requireFactory('createLaunchAgentMetadataStore');
    const createLaunchAgentMetadataStoreForTest = requireFactory(
      'createLaunchAgentMetadataStoreForTest',
    );

    await t.test('Z1 absent journal is stable empty hash, deeply frozen, and read-only', async (st) => {
      const metadataRoot = await makeTempMetadataRoot(st);
      const events = [];
      const mutations = [];
      const store = createLaunchAgentMetadataStoreForTest({
        metadataRoot,
        fs: createMutationTracingFs(mutations),
        onDurabilityEvent: (event) => events.push(event),
      });
      await store.initialize();
      events.length = 0;
      mutations.length = 0;

      const beforeTree = await snapshotMetadataTree(metadataRoot);
      const snapshot = await store.readJournalHeads();
      const afterTree = await snapshotMetadataTree(metadataRoot);

      assert.deepEqual(snapshot, {
        kind: 'journal-heads',
        journalSha256: sha256Hex(Buffer.alloc(0)),
        heads: [],
      });
      assert.deepEqual(
        Reflect.ownKeys(snapshot).filter((key) => typeof key === 'string').sort(),
        ['heads', 'journalSha256', 'kind'],
      );
      assert.equal(isDeeplyFrozen(snapshot), true);
      assertNoAbsolutePaths(snapshot, 'readJournalHeads absent snapshot');
      assert.deepEqual(afterTree, beforeTree, 'absent readJournalHeads must not mutate metadata tree');
      assert.deepEqual(events, [], 'absent readJournalHeads must emit no durability event');
      assert.deepEqual(mutations, [], 'absent readJournalHeads must perform no fs mutation or fsync');
      await assertNoJournalLeaf(metadataRoot);

      await assert.rejects(
        () => store.readJournalHeads({ transactionId: TX_ID }),
        isInvalidLifecycleError,
        'readJournalHeads must reject every argument before mutation',
      );
      assert.deepEqual(
        await snapshotMetadataTree(metadataRoot),
        beforeTree,
        'invalid argument must not mutate metadata tree',
      );
      assert.deepEqual(events, [], 'invalid argument must emit no durability event');
      assert.deepEqual(mutations, [], 'invalid argument must perform no fs mutation or fsync');
    });

    await t.test('Z2 latest heads are sorted, exact-byte hashed, detached, and append-sensitive', async (st) => {
      const metadataRoot = await makeTempMetadataRoot(st);
      const events = [];
      const mutations = [];
      const store = createLaunchAgentMetadataStoreForTest({
        metadataRoot,
        fs: createMutationTracingFs(mutations),
        onDurabilityEvent: (event) => events.push(event),
      });
      await store.initialize();

      const firstA = buildJournalEntry({
        transactionId: TX_ID,
        sequence: 0,
        previousEntrySha256: null,
        operation: 'install',
        state: 'prepared',
        at: '2024-01-15T12:00:00.000Z',
        payload: { hostMutationCount: 0 },
      });
      const firstB = buildJournalEntry({
        transactionId: TX_ID_B,
        sequence: 0,
        previousEntrySha256: null,
        operation: 'stop',
        state: 'prepared',
        at: '2024-01-15T12:00:01.000Z',
        payload: { hostMutationCount: 0 },
      });
      const secondA = buildJournalEntry({
        transactionId: TX_ID,
        sequence: 1,
        previousEntrySha256: firstA.entrySha256,
        operation: 'install',
        state: 'anchored',
        at: '2024-01-15T12:00:02.000Z',
        payload: { hostMutationCount: 0 },
      });
      const secondB = buildJournalEntry({
        transactionId: TX_ID_B,
        sequence: 1,
        previousEntrySha256: firstB.entrySha256,
        operation: 'stop',
        state: 'anchored',
        at: '2024-01-15T12:00:03.000Z',
        payload: { hostMutationCount: 0 },
      });
      const initialBytes = Buffer.concat([
        journalLineBuffer(firstB),
        journalLineBuffer(firstA),
        journalLineBuffer(secondB),
        journalLineBuffer(secondA),
      ]);
      for (const entry of [firstA, firstB, secondA, secondB]) {
        assert.deepEqual(validateLaunchAgentJournal(entry), entry, 'fixture must validate independently');
      }
      await writeFile(journalLeafPath(metadataRoot), initialBytes, { mode: 0o600 });
      events.length = 0;
      mutations.length = 0;

      const beforeTree = await snapshotMetadataTree(metadataRoot);
      const firstSnapshot = await store.readJournalHeads();
      const afterTree = await snapshotMetadataTree(metadataRoot);
      assert.equal(firstSnapshot.kind, 'journal-heads');
      assert.equal(firstSnapshot.journalSha256, sha256Hex(initialBytes));
      assert.deepEqual(firstSnapshot.heads, [secondA, secondB]);
      assert.deepEqual(
        firstSnapshot.heads.map((entry) => entry.transactionId),
        [TX_ID, TX_ID_B],
        'heads must be sorted lexicographically by transactionId',
      );
      assert.equal(isDeeplyFrozen(firstSnapshot), true);
      assertNoAbsolutePaths(firstSnapshot, 'readJournalHeads populated snapshot');
      assert.deepEqual(afterTree, beforeTree, 'populated readJournalHeads must be read-only');
      assert.deepEqual(events, [], 'populated readJournalHeads must emit no durability event');
      assert.deepEqual(mutations, [], 'populated readJournalHeads must perform no fs mutation or fsync');
      assert.throws(
        () => firstSnapshot.heads.push(firstA),
        TypeError,
        'heads array must be frozen',
      );
      assert.throws(
        () => {
          firstSnapshot.heads[0].payload.hostMutationCount = 99;
        },
        TypeError,
        'nested head payload must be frozen',
      );

      const sameBytesSnapshot = await store.readJournalHeads();
      assert.deepEqual(sameBytesSnapshot, firstSnapshot);
      assert.notStrictEqual(sameBytesSnapshot, firstSnapshot, 'snapshots must be detached objects');
      assert.notStrictEqual(sameBytesSnapshot.heads, firstSnapshot.heads, 'heads arrays must be detached');
      assert.notStrictEqual(
        sameBytesSnapshot.heads[0],
        firstSnapshot.heads[0],
        'head entries must be detached projections',
      );
      const mutableClone = JSON.parse(JSON.stringify(sameBytesSnapshot));
      mutableClone.heads[0].payload.hostMutationCount = 77;
      assert.deepEqual(
        await store.readJournalHeads(),
        firstSnapshot,
        'mutating a detached clone must not affect a reread',
      );

      const readA = await store.readJournal({ transactionId: TX_ID });
      const readB = await store.readJournal({ transactionId: TX_ID_B });
      assert.deepEqual(readA, [firstA, secondA]);
      assert.deepEqual(readB, [firstB, secondB]);

      const thirdA = buildJournalEntry({
        transactionId: TX_ID,
        sequence: 2,
        previousEntrySha256: secondA.entrySha256,
        operation: 'install',
        state: 'published',
        at: '2024-01-15T12:00:04.000Z',
        payload: { hostMutationCount: 1 },
      });
      const appendedBytes = Buffer.concat([initialBytes, journalLineBuffer(thirdA)]);
      await writeFile(journalLeafPath(metadataRoot), appendedBytes, { mode: 0o600 });
      events.length = 0;
      mutations.length = 0;
      const beforeSecondRead = await snapshotMetadataTree(metadataRoot);
      const secondSnapshot = await store.readJournalHeads();
      assert.equal(secondSnapshot.journalSha256, sha256Hex(appendedBytes));
      assert.notEqual(secondSnapshot.journalSha256, firstSnapshot.journalSha256);
      assert.deepEqual(secondSnapshot.heads, [thirdA, secondB]);
      assert.deepEqual(firstSnapshot.heads, [secondA, secondB], 'first snapshot must stay detached');
      assert.deepEqual(
        await snapshotMetadataTree(metadataRoot),
        beforeSecondRead,
        'second readJournalHeads call must not mutate metadata tree',
      );
      assert.deepEqual(events, [], 'second readJournalHeads call must emit no durability event');
      assert.deepEqual(mutations, [], 'second readJournalHeads call must perform no fs mutation or fsync');

      assert.deepEqual(
        await store.readJournal({ transactionId: TX_ID }),
        [firstA, secondA, thirdA],
        'existing readJournal return contract must remain unchanged',
      );
    });

    await t.test('Z3 corrupt, truncated, illegal, and operation-drift journals fail closed', async (st) => {
      const valid = buildJournalEntry({
        transactionId: TX_ID,
        sequence: 0,
        previousEntrySha256: null,
        operation: 'install',
        state: 'prepared',
        payload: { hostMutationCount: 0 },
      });
      const drift = buildJournalEntry({
        transactionId: TX_ID,
        sequence: 1,
        previousEntrySha256: valid.entrySha256,
        operation: 'managed-upgrade',
        state: 'anchored',
        at: '2024-01-15T12:00:01.000Z',
        payload: { hostMutationCount: 0 },
      });
      const illegal = {
        ...buildJournalEntry({
          transactionId: TX_ID_B,
          sequence: 0,
          previousEntrySha256: null,
          operation: 'stop',
          state: 'prepared',
          payload: { hostMutationCount: 0 },
        }),
        unexpected: true,
      };
      const validB = buildJournalEntry({
        transactionId: TX_ID_B,
        sequence: 0,
        previousEntrySha256: null,
        operation: 'stop',
        state: 'prepared',
        payload: { hostMutationCount: 0 },
      });
      assert.deepEqual(validateLaunchAgentJournal(valid), valid);
      assert.deepEqual(validateLaunchAgentJournal(drift), drift);
      assert.deepEqual(validateLaunchAgentJournal(validB), validB);

      const cases = [
        [
          'corrupt-json-after-valid-prefix',
          Buffer.concat([journalLineBuffer(valid), Buffer.from('{"broken":\n', 'utf8')]),
        ],
        [
          'truncated-no-lf-after-valid-prefix',
          Buffer.concat([journalLineBuffer(valid), journalLineBuffer(validB).subarray(0, -1)]),
        ],
        [
          'illegal-entry-shape-after-valid-prefix',
          Buffer.concat([journalLineBuffer(valid), journalLineBuffer(illegal)]),
        ],
        [
          'same-transaction-operation-drift',
          Buffer.concat([journalLineBuffer(valid), journalLineBuffer(drift)]),
        ],
      ];

      for (const [name, bytes] of cases) {
        await st.test(name, async (caseTest) => {
          const metadataRoot = await makeTempMetadataRoot(caseTest);
          const events = [];
          const mutations = [];
          const store = createLaunchAgentMetadataStoreForTest({
            metadataRoot,
            fs: createMutationTracingFs(mutations),
            onDurabilityEvent: (event) => events.push(event),
          });
          await store.initialize();
          await writeFile(journalLeafPath(metadataRoot), bytes, { mode: 0o600 });
          events.length = 0;
          mutations.length = 0;
          const beforeBytes = await readJournalLeafBytes(metadataRoot);
          const beforeTree = await snapshotMetadataTree(metadataRoot);

          if (name === 'same-transaction-operation-drift') {
            assert.deepEqual(
              await store.readJournal({ transactionId: TX_ID }),
              [valid, drift],
              'existing readJournal public return contract must remain unchanged for drift fixture',
            );
            mutations.length = 0;
          }

          await assert.rejects(
            () => store.readJournalHeads(),
            isInvalidLifecycleError,
            `${name}: readJournalHeads must reject the entire snapshot`,
          );

          assert.equal(
            Buffer.compare(await readJournalLeafBytes(metadataRoot), beforeBytes),
            0,
            `${name}: rejected snapshot must preserve exact journal bytes`,
          );
          assert.deepEqual(
            await snapshotMetadataTree(metadataRoot),
            beforeTree,
            `${name}: rejected snapshot must not mutate metadata tree`,
          );
          assert.deepEqual(events, [], `${name}: rejected snapshot must emit no durability event`);
          assert.deepEqual(
            mutations,
            [],
            `${name}: rejected snapshot must perform no fs mutation or fsync`,
          );
        });
      }
    });

    await t.test('Z4 production and test factories expose the same read-only method', async (st) => {
      const productionRoot = await makeTempMetadataRoot(st);
      const testRoot = await makeTempMetadataRoot(st);
      const productionStore = createLaunchAgentMetadataStore({ metadataRoot: productionRoot });
      const testStore = createLaunchAgentMetadataStoreForTest({
        metadataRoot: testRoot,
        fs: fsPromises,
        onDurabilityEvent: () => {},
      });
      assert.equal(typeof productionStore.readJournalHeads, 'function');
      assert.equal(typeof testStore.readJournalHeads, 'function');
      assert.deepEqual(
        ownEnumerableMethodNames(productionStore),
        ownEnumerableMethodNames(testStore),
      );
    });
  });
}
