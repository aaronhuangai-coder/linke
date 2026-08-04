/**
 * V1.46 Task 6B.1 — private one-time manual-repair authority + pure closeout RED.
 *
 * Locks Task 6A prerequisite behavior: mint via public authorize protocol,
 * first consume returns frozen exact authority, subsequent identity forgeries and
 * second genuine consume fail closed with zero further dependency I/O.
 * Task 6 pure closeout matrices drive the real coordinator.recoverAfterManualRepair
 * surface only — no private capability forgery, no helper-side success path.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  LAUNCHAGENT_LIFECYCLE_CODES,
  LaunchAgentLifecycleError,
  validateLaunchAgentAcceptanceRequest,
  validateLaunchAgentCapabilityProjection,
  validateLaunchAgentConfirmationRecord,
  validateLaunchAgentConsumedConfirmation,
  validateLaunchAgentJournal,
  validateLaunchAgentManualRepairAttestation,
  validateLaunchAgentReceipt,
  validateLaunchAgentTransactionPrefix,
} from '../src/launchagent-lifecycle/contracts.js';
import {
  assertAndConsumeLaunchAgentManualRepairAuthority,
  consumeAndAuthorizeManualRepair,
} from '../src/launchagent-lifecycle/acceptance-gate.js';
import * as metadataStoreModule from '../src/launchagent-lifecycle/metadata-store.js';
import { createLaunchAgentLifecycleCoordinator } from '../src/launchagent-lifecycle/transaction-coordinator.js';
import { createLaunchAgentLifecycleHarness } from './helpers/launchagent-lifecycle-harness.js';
import * as launchAgentLifecycleHarnessModule from './helpers/launchagent-lifecycle-harness.js';

// ---------------------------------------------------------------------------
// Literal fixtures (adapted from acceptance-gate conventions; not imported).
// ---------------------------------------------------------------------------

const UUID = Object.freeze({
  manualRepair: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  manualConfirmation: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  mirTx: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  ownerNonce: '11111111-1111-4111-8111-111111111111',
  anchor: '33333333-3333-4333-8333-333333333333',
  txLock: '55555555-5555-4555-8555-555555555555',
  txNonce: '66666666-6666-4666-8666-666666666666',
});

const SHA_MIR_LOCK = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const SHA_TX_LOCK = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const SHA_REPAIR = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const SHA_CONSUMED = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TS_PREPARED = '2026-08-02T10:00:00.000Z';
const TS_CONFIRMED = '2026-08-02T10:05:00.000Z';
const TS_NOW = '2026-08-02T12:00:00.000Z';

/** Non-null transaction lock ref fixture (literal; covered independently). */
const TRANSACTION_LOCK_REF = Object.freeze({
  kind: 'transaction-lock',
  transactionId: UUID.txLock,
  ownerNonce: UUID.txNonce,
  sha256: SHA_TX_LOCK,
});

const MIR_LOCK_REF = Object.freeze({
  kind: 'manual-intervention-lock',
  transactionId: UUID.mirTx,
  ownerNonce: UUID.ownerNonce,
  sha256: SHA_MIR_LOCK,
});

function assertLifecycleCode(error, code) {
  assert.ok(error instanceof LaunchAgentLifecycleError, 'expected LaunchAgentLifecycleError');
  assert.equal(error.code, code);
  assert.equal(error.message, code);
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}

function assertDeeplyFrozen(value) {
  assert.ok(Object.isFrozen(value), 'expected frozen object');
  if (value === null || typeof value !== 'object') return;
  for (const key of Reflect.ownKeys(value)) {
    const child = value[key];
    if (child !== null && typeof child === 'object') assertDeeplyFrozen(child);
  }
}

function expectedManualRequest() {
  return validateLaunchAgentAcceptanceRequest({
    schemaVersion: 1,
    kind: 'manual-repair-request',
    manualRepairRequestId: UUID.manualRepair,
    mirTransactionId: UUID.mirTx,
    mirLockIdentitySha256: SHA_MIR_LOCK,
    anchorId: UUID.anchor,
    repairDeclarationSha256: SHA_REPAIR,
    executeRequested: false,
    manualRepairConfirmed: false,
    preparedAt: TS_PREPARED,
  });
}

function manualConfirmation() {
  return validateLaunchAgentConfirmationRecord({
    schemaVersion: 1,
    kind: 'manual-repair-confirmation',
    confirmationId: UUID.manualConfirmation,
    manualRepairRequestId: UUID.manualRepair,
    confirmed: true,
    confirmedAt: TS_CONFIRMED,
  });
}

/**
 * Boundary fakes only: metadata store + clock + readCurrentFacts counters.
 * No host/process/network; counters prove assertAndConsume performs zero further I/O.
 */
function createAuthorizeFixture() {
  const durable = new Map();
  const counters = {
    clockNow: 0,
    consumeConfirmation: 0,
    readConsumedConfirmation: 0,
    readCurrentFacts: 0,
  };

  const store = Object.freeze({
    async consumeConfirmation(record) {
      counters.consumeConfirmation += 1;
      const projection = validateLaunchAgentConsumedConfirmation(record);
      if (durable.has(projection.confirmationId)) {
        throw new LaunchAgentLifecycleError(
          LAUNCHAGENT_LIFECYCLE_CODES.CONFIRMATION_CONSUMED,
        );
      }
      durable.set(projection.confirmationId, deepFreeze({ ...projection }));
      return deepFreeze({
        kind: 'consumed-confirmation',
        confirmationId: projection.confirmationId,
        sha256: SHA_CONSUMED,
      });
    },
    async readConsumedConfirmation(confirmationId) {
      counters.readConsumedConfirmation += 1;
      const stored = durable.get(confirmationId);
      if (stored === undefined) {
        throw new LaunchAgentLifecycleError();
      }
      return validateLaunchAgentConsumedConfirmation({ ...stored });
    },
  });

  const clock = Object.freeze({
    now() {
      counters.clockNow += 1;
      return TS_NOW;
    },
  });

  function readCurrentFacts() {
    counters.readCurrentFacts += 1;
    return {
      mirTransactionId: UUID.mirTx,
      mirLockRef: { ...MIR_LOCK_REF },
      transactionLockRef: {
        kind: TRANSACTION_LOCK_REF.kind,
        transactionId: TRANSACTION_LOCK_REF.transactionId,
        ownerNonce: TRANSACTION_LOCK_REF.ownerNonce,
        sha256: TRANSACTION_LOCK_REF.sha256,
      },
      anchorId: UUID.anchor,
      repairDeclarationSha256: SHA_REPAIR,
    };
  }

  function snapshotCounters() {
    return {
      clockNow: counters.clockNow,
      consumeConfirmation: counters.consumeConfirmation,
      readConsumedConfirmation: counters.readConsumedConfirmation,
      readCurrentFacts: counters.readCurrentFacts,
    };
  }

  return { store, clock, readCurrentFacts, counters, snapshotCounters };
}

function assertCountersUnchanged(before, after) {
  assert.deepEqual(after, before, 'assertAndConsume must perform zero dependency I/O');
}

function assertDenied(fn) {
  assert.throws(fn, (error) => {
    assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.ACCEPTANCE_GATE_DENIED);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Characterization: private one-time manual repair authority (Task 6A lock-in)
// ---------------------------------------------------------------------------

test('private manual repair authority is one-time, identity-bound, and zero-I/O on consume', async () => {
  const request = expectedManualRequest();
  const confirmation = manualConfirmation();
  const { store, clock, readCurrentFacts, snapshotCounters } = createAuthorizeFixture();

  // 1) Mint genuine public capability through the real Task 6A authorize protocol.
  const capability = await consumeAndAuthorizeManualRepair({
    request,
    confirmation,
    metadataStore: store,
    readCurrentFacts,
    clock,
  });

  const expectedProjection = validateLaunchAgentCapabilityProjection({
    schemaVersion: 1,
    kind: 'launchagent-manual-repair',
    manualRepairRequestId: UUID.manualRepair,
    mirTransactionId: UUID.mirTx,
    mirLockIdentitySha256: SHA_MIR_LOCK,
    anchorId: UUID.anchor,
    repairDeclarationSha256: SHA_REPAIR,
    authorizedAt: TS_NOW,
  });
  assert.deepEqual(capability, expectedProjection);
  assert.ok(Object.isFrozen(capability));
  // Public capability must not leak private authority fields.
  assert.equal(Object.hasOwn(capability, 'manualRepairConfirmationId'), false);
  assert.equal(Object.hasOwn(capability, 'mirLockRef'), false);
  assert.equal(Object.hasOwn(capability, 'transactionLockRef'), false);
  assert.equal(Object.hasOwn(capability, 'projection'), false);

  // 2) Snapshot all dependency sentinels/counters after mint; consume must not move them.
  const countersAfterMint = snapshotCounters();
  assert.ok(countersAfterMint.clockNow > 0, 'mint used clock');
  assert.ok(countersAfterMint.consumeConfirmation > 0, 'mint used metadata consume');
  assert.ok(countersAfterMint.readConsumedConfirmation > 0, 'mint used metadata readback');
  assert.ok(countersAfterMint.readCurrentFacts > 0, 'mint used readCurrentFacts');

  // 3) First consume: deeply frozen plain authority with exactly four keys.
  const authority = assertAndConsumeLaunchAgentManualRepairAuthority(capability);
  assertCountersUnchanged(countersAfterMint, snapshotCounters());

  assert.equal(Object.getPrototypeOf(authority), Object.prototype);
  assertDeeplyFrozen(authority);
  assert.deepEqual(
    Reflect.ownKeys(authority).sort(),
    [
      'manualRepairConfirmationId',
      'mirLockRef',
      'projection',
      'transactionLockRef',
    ].sort(),
  );

  // 4) Projection equals public capability; confirmation/lock refs match literal fixtures.
  assert.deepEqual(authority.projection, capability);
  assert.deepEqual(
    authority.projection,
    validateLaunchAgentCapabilityProjection(capability),
  );
  assert.equal(authority.manualRepairConfirmationId, UUID.manualConfirmation);
  assert.deepEqual(authority.mirLockRef, MIR_LOCK_REF);
  assert.deepEqual(authority.transactionLockRef, TRANSACTION_LOCK_REF);
  assert.notEqual(authority.transactionLockRef, null);

  // 5) Closed denial suite: second genuine consume + forgeries + negatives; zero I/O.
  const lookalike = {
    schemaVersion: 1,
    kind: 'launchagent-manual-repair',
    manualRepairRequestId: UUID.manualRepair,
    mirTransactionId: UUID.mirTx,
    mirLockIdentitySha256: SHA_MIR_LOCK,
    anchorId: UUID.anchor,
    repairDeclarationSha256: SHA_REPAIR,
    authorizedAt: TS_NOW,
  };

  const denialCases = [
    () => assertAndConsumeLaunchAgentManualRepairAuthority(capability),
    () => assertAndConsumeLaunchAgentManualRepairAuthority(structuredClone(capability)),
    () => assertAndConsumeLaunchAgentManualRepairAuthority(
      JSON.parse(JSON.stringify(capability)),
    ),
    () => assertAndConsumeLaunchAgentManualRepairAuthority(new Proxy(capability, {})),
    () => assertAndConsumeLaunchAgentManualRepairAuthority(lookalike),
    () => assertAndConsumeLaunchAgentManualRepairAuthority(null),
    () => assertAndConsumeLaunchAgentManualRepairAuthority(undefined),
    () => assertAndConsumeLaunchAgentManualRepairAuthority('capability'),
    () => assertAndConsumeLaunchAgentManualRepairAuthority(42),
  ];

  for (const deny of denialCases) {
    const before = snapshotCounters();
    assertDenied(deny);
    assertCountersUnchanged(before, snapshotCounters());
  }
});

// ---------------------------------------------------------------------------
// Task 6B.1 Task 3 RED — MIR lock observation / abort recovery lock
// Metadata-only primitives: no host / launchctl / publisher injection.
// Do not invent coordinator behavior yet.
// ---------------------------------------------------------------------------

test('MIR lock observation and abort recovery lock are metadata-only primitives', () => {
  // Hostile host / launchctl / publisher sentinel: any property access is a call.
  let hostileHostSentinelCount = 0;
  const hostileHost = new Proxy({}, {
    get(_target, property) {
      hostileHostSentinelCount += 1;
      throw new Error(`hostile host must not be invoked: ${String(property)}`);
    },
    apply() {
      hostileHostSentinelCount += 1;
      throw new Error('hostile host must not be invoked as function');
    },
  });
  const hostileLaunchctl = new Proxy({}, {
    get(_target, property) {
      hostileHostSentinelCount += 1;
      throw new Error(`hostile launchctl must not be invoked: ${String(property)}`);
    },
  });
  const hostilePublisher = new Proxy({}, {
    get(_target, property) {
      hostileHostSentinelCount += 1;
      throw new Error(`hostile publisher must not be invoked: ${String(property)}`);
    },
  });
  void hostileHost;
  void hostileLaunchctl;
  void hostilePublisher;

  // Primitives live on the metadata-store surface only — no host adapter wiring.
  assert.equal(
    typeof metadataStoreModule.createLaunchAgentMetadataStore,
    'function',
    'metadata store factory must exist for metadata-only MIR primitives',
  );

  // Probe store construction uses only { metadataRoot }; never inject host/launchctl/publisher.
  const store = metadataStoreModule.createLaunchAgentMetadataStore({
    metadataRoot: '/tmp/linke-la-mir-obs-abort-metadata-only-probe',
  });

  assert.equal(
    typeof store.readManualInterventionLockObservation,
    'function',
    'production bug: store.readManualInterventionLockObservation must exist for MIR lock observation',
  );
  assert.equal(
    typeof store.abortRecoveryLockForManualRepair,
    'function',
    'production bug: store.abortRecoveryLockForManualRepair must exist for abort recovery lock',
  );

  // Explicit non-injection contract: these are not host/launchctl/publisher methods.
  assert.equal(typeof store.launchctl, 'undefined');
  assert.equal(typeof store.runLaunchctl, 'undefined');
  assert.equal(typeof store.publishPath, 'undefined');
  assert.equal(typeof store.host, 'undefined');
  assert.equal(typeof store.invokeHost, 'undefined');

  assert.equal(
    hostileHostSentinelCount,
    0,
    'MIR lock observation / abort recovery lock must keep hostile host sentinel count at zero',
  );
});

// ---------------------------------------------------------------------------
// Task 6B.1 Task 4 RED — residual recovery claim resolve is metadata-only
// No host / launchctl / publisher injection; no coordinator recoverAfterManualRepair.
// ---------------------------------------------------------------------------

test('residual recovery claim resolve is a metadata-only primitive without host launchctl publisher', () => {
  let hostileHostSentinelCount = 0;
  const hostileHost = new Proxy({}, {
    get(_target, property) {
      hostileHostSentinelCount += 1;
      throw new Error(`hostile host must not be invoked: ${String(property)}`);
    },
    apply() {
      hostileHostSentinelCount += 1;
      throw new Error('hostile host must not be invoked as function');
    },
  });
  const hostileLaunchctl = new Proxy({}, {
    get(_target, property) {
      hostileHostSentinelCount += 1;
      throw new Error(`hostile launchctl must not be invoked: ${String(property)}`);
    },
  });
  const hostilePublisher = new Proxy({}, {
    get(_target, property) {
      hostileHostSentinelCount += 1;
      throw new Error(`hostile publisher must not be invoked: ${String(property)}`);
    },
  });
  void hostileHost;
  void hostileLaunchctl;
  void hostilePublisher;

  assert.equal(
    typeof metadataStoreModule.createLaunchAgentMetadataStore,
    'function',
    'metadata store factory must exist for residual recovery claim resolve',
  );

  // Probe construction uses only { metadataRoot }; never inject host/launchctl/publisher.
  const store = metadataStoreModule.createLaunchAgentMetadataStore({
    metadataRoot: '/tmp/linke-la-residual-recovery-claim-metadata-only-probe',
  });

  assert.equal(
    typeof store.resolveRecoveryClaimForManualRepair,
    'function',
    'production bug: store.resolveRecoveryClaimForManualRepair must exist for residual recovery claim resolve',
  );

  // Explicit non-injection contract: not a host/launchctl/publisher method.
  assert.equal(typeof store.launchctl, 'undefined');
  assert.equal(typeof store.runLaunchctl, 'undefined');
  assert.equal(typeof store.publishPath, 'undefined');
  assert.equal(typeof store.host, 'undefined');
  assert.equal(typeof store.invokeHost, 'undefined');
  // Task 5 coordinator seam must not be invented on the metadata store.
  assert.equal(typeof store.recoverAfterManualRepair, 'undefined');

  assert.equal(
    hostileHostSentinelCount,
    0,
    'residual recovery claim resolve must keep hostile host sentinel count at zero',
  );
});

// ---------------------------------------------------------------------------
// Task 6B.1 Task 5 GREEN — authorized entry / attestation / recovery lock acquisition
// 单一 FULL 依赖契约：dependencies() / factoryContract() 与生产 DEPENDENCY_METHODS 对齐。
// 不得再使用 BASE/FULL 双表面或 manualRepairDependencies()。
// Do not invent pure-closeout (Task 6) coverage here.
// ---------------------------------------------------------------------------

const FAKE_BOOT = 'fake-boot-session-v1';
const FAKE_PSTART = 'fake-process-start-v1';
const FIXED_OWNER_PID = 4242;
/** Capability authorizedAt 必须 ≤ harness clock.now()（CLOCK_BASE=2026-07-30）以便 attestation attestedAt >= authorizedAt。 */
const TS_CAPABILITY_AUTHORIZED = '2026-07-29T12:00:00.000Z';

/**
 * 单一 FULL 表面构造 coordinator，断言 recoverAfterManualRepair 为 function。
 */
function createCoordinatorOrRed(harness) {
  const coordinator = createLaunchAgentLifecycleCoordinator(harness.dependencies());
  assert.equal(
    typeof coordinator.recoverAfterManualRepair,
    'function',
    'production bug: coordinator.recoverAfterManualRepair must exist for manual repair entry',
  );
  return coordinator;
}

/**
 * 经 public authorize 铸造 genuine capability，绑定 exact facts
 * （mirLockRef / transactionLockRef / anchor / repair hash）。不得伪造私有 brand。
 *
 * @param {{
 *   mirTransactionId: string,
 *   mirLockRef: object,
 *   transactionLockRef: object|null,
 *   anchorId: string,
 *   repairDeclarationSha256?: string,
 *   manualRepairRequestId?: string,
 *   confirmationId?: string,
 * }} facts
 */
async function mintGenuineCapability(facts) {
  if (facts === null || typeof facts !== 'object') {
    throw new Error('mintGenuineCapability requires exact facts');
  }
  const mirTransactionId = facts.mirTransactionId;
  const mirLockRef = facts.mirLockRef;
  const transactionLockRef = Object.hasOwn(facts, 'transactionLockRef')
    ? facts.transactionLockRef
    : null;
  const anchorId = facts.anchorId;
  const repairDeclarationSha256 = facts.repairDeclarationSha256 ?? SHA_REPAIR;
  const manualRepairRequestId = facts.manualRepairRequestId ?? UUID.manualRepair;
  const confirmationId = facts.confirmationId ?? UUID.manualConfirmation;

  const request = validateLaunchAgentAcceptanceRequest({
    schemaVersion: 1,
    kind: 'manual-repair-request',
    manualRepairRequestId,
    mirTransactionId,
    mirLockIdentitySha256: mirLockRef.sha256,
    anchorId,
    repairDeclarationSha256,
    executeRequested: false,
    manualRepairConfirmed: false,
    preparedAt: TS_PREPARED,
  });
  const confirmation = validateLaunchAgentConfirmationRecord({
    schemaVersion: 1,
    kind: 'manual-repair-confirmation',
    confirmationId,
    manualRepairRequestId,
    confirmed: true,
    confirmedAt: TS_CONFIRMED,
  });

  const durable = new Map();
  const store = Object.freeze({
    async consumeConfirmation(record) {
      const projection = validateLaunchAgentConsumedConfirmation(record);
      if (durable.has(projection.confirmationId)) {
        throw new LaunchAgentLifecycleError(
          LAUNCHAGENT_LIFECYCLE_CODES.CONFIRMATION_CONSUMED,
        );
      }
      durable.set(projection.confirmationId, deepFreeze({ ...projection }));
      return deepFreeze({
        kind: 'consumed-confirmation',
        confirmationId: projection.confirmationId,
        sha256: SHA_CONSUMED,
      });
    },
    async readConsumedConfirmation(id) {
      const stored = durable.get(id);
      if (stored === undefined) throw new LaunchAgentLifecycleError();
      return validateLaunchAgentConsumedConfirmation({ ...stored });
    },
  });
  // authorizedAt 取 harness clock 之前的固定时刻，保证后续 attestedAt >= authorizedAt
  const clock = Object.freeze({ now() { return TS_CAPABILITY_AUTHORIZED; } });
  const exactFacts = {
    mirTransactionId,
    mirLockRef: {
      kind: mirLockRef.kind,
      transactionId: mirLockRef.transactionId,
      ownerNonce: mirLockRef.ownerNonce,
      sha256: mirLockRef.sha256,
    },
    transactionLockRef: transactionLockRef === null
      ? null
      : {
        kind: transactionLockRef.kind,
        transactionId: transactionLockRef.transactionId,
        ownerNonce: transactionLockRef.ownerNonce,
        sha256: transactionLockRef.sha256,
      },
    anchorId,
    repairDeclarationSha256,
  };
  function readCurrentFacts() {
    return {
      mirTransactionId: exactFacts.mirTransactionId,
      mirLockRef: { ...exactFacts.mirLockRef },
      transactionLockRef: exactFacts.transactionLockRef === null
        ? null
        : { ...exactFacts.transactionLockRef },
      anchorId: exactFacts.anchorId,
      repairDeclarationSha256: exactFacts.repairDeclarationSha256,
    };
  }

  const capability = await consumeAndAuthorizeManualRepair({
    request,
    confirmation,
    metadataStore: store,
    readCurrentFacts,
    clock,
  });
  return {
    capability,
    request,
    confirmation,
    confirmationId,
    manualRepairRequestId,
    facts: exactFacts,
  };
}

function identityPair() {
  return {
    bootSessionIdentity: { available: true, value: FAKE_BOOT },
    processStartIdentity: { available: true, value: FAKE_PSTART },
  };
}

function lockRecord(transactionId, ownerNonce, ownerPid = FIXED_OWNER_PID) {
  return {
    schemaVersion: 1,
    transactionId,
    ownerPid,
    ownerNonce,
    ...identityPair(),
  };
}

/**
 * 可达 MIR 场景 seed：MIR head + anchor + MIR lock（可选 residual tx / claim）。
 * 返回 exact refs 供 mintGenuineCapability 绑定。
 */
function seedReachableMir(harness, options = {}) {
  const mirTransactionId = options.mirTransactionId ?? UUID.mirTx;
  const anchorId = options.anchorId ?? UUID.anchor;
  const mirOwnerNonce = options.mirOwnerNonce ?? UUID.ownerNonce;
  const mirHead = harness.seedMirHeadAndAnchor({
    transactionId: mirTransactionId,
    anchorId,
  });
  const mirRef = harness.seedManualInterventionLock(
    lockRecord(mirTransactionId, mirOwnerNonce),
  );
  let transactionLockRef = null;
  if (options.transactionLockRecord) {
    transactionLockRef = harness.seedTransactionLock(options.transactionLockRecord);
  }
  let recoveryClaim = null;
  if (options.recoveryClaim) {
    recoveryClaim = harness.seedRecoveryClaim(options.recoveryClaim);
  }
  return {
    mirTransactionId,
    anchorId,
    mirRef,
    mirHead,
    transactionLockRef,
    recoveryClaim,
  };
}

/**
 * 单一 FULL 依赖袋 detached exact clone，仅替换 clock.now 为严格 authority-consumed sentinel。
 * 第一次 now()（attestedAt 路径）内：二次 assertAndConsume 必须 denied，才
 * recordAuthorityConsumedForTest，再委托原 clock.now。证明 consume 在 clock/I/O 前。
 * recordAuthorityConsumedForTest 只允许经此验证过的 sentinel 调用。
 */
function createFullCoordinatorWithAuthoritySentinel(harness, capability) {
  const full = harness.dependencies();
  const originalNow = full.clock.now.bind(full.clock);
  const originalNewId = full.clock.newId.bind(full.clock);
  let firstNowHandled = false;
  const clock = Object.freeze({
    now() {
      if (!firstNowHandled) {
        firstNowHandled = true;
        // 若能力此时仍可消费 → 立即失败（consume 尚未发生在 clock 前）
        assert.throws(
          () => assertAndConsumeLaunchAgentManualRepairAuthority(capability),
          (error) => {
            assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.ACCEPTANCE_GATE_DENIED);
            return true;
          },
          'authority must already be consumed before first clock.now (attestedAt)',
        );
        harness.recordAuthorityConsumedForTest();
      }
      return originalNow();
    },
    newId() {
      return originalNewId();
    },
  });
  // Detached exact clone：九 key 不变，仅 clock.now 替换；其余 surface 引用不变
  const deps = Object.freeze({
    metadataStore: full.metadataStore,
    hostInspector: full.hostInspector,
    profileRenderer: full.profileRenderer,
    plistValidator: full.plistValidator,
    atomicPublisher: full.atomicPublisher,
    launchctlRunner: full.launchctlRunner,
    healthChecker: full.healthChecker,
    clock,
    processIdentityReader: full.processIdentityReader,
  });
  return createLaunchAgentLifecycleCoordinator(deps);
}

/** 单一 FULL coordinator，无 clock sentinel（lookalike 等零 I/O 拒绝路径）。 */
function createFullCoordinator(harness) {
  return createLaunchAgentLifecycleCoordinator(harness.dependencies());
}

async function assertCapabilityReplayDenied(capability) {
  assert.throws(
    () => assertAndConsumeLaunchAgentManualRepairAuthority(capability),
    (error) => {
      assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.ACCEPTANCE_GATE_DENIED);
      return true;
    },
  );
}

function assertZeroHost(harness) {
  assert.equal(harness.sentinels().hostMutationCount, 0);
  assert.equal(harness.sentinels().realLaunchctlCalls, 0);
}

function assertNoAcquireOrPostLock(trace) {
  assert.equal(trace.includes('recovery-lock-acquire'), false);
  assert.equal(trace.includes('post-lock-snapshot'), false);
}

// ---- 9 Task 5 matrices：业务断言一律经单一 FULL coordinator.recoverAfterManualRepair ----

test('manual repair entry with genuine valid authority consumes first and acquires recovery lock', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  createCoordinatorOrRed(harness);

  // seed 可达 MIR + 无 residual tx；mint exact-bound capability；
  // FULL coordinator + authority sentinel → recoverAfterManualRepair。
  const seeded = seedReachableMir(harness);
  const { capability, confirmationId } = await mintGenuineCapability({
    mirTransactionId: seeded.mirTransactionId,
    mirLockRef: seeded.mirRef,
    transactionLockRef: null,
    anchorId: seeded.anchorId,
  });
  harness.resetObservations();
  harness.armPostLockSnapshotEvent();
  // coordinator 仅从 clock.newId() 生成 claimId + freshOwnerNonce；
  // transactionId 固定为 MIR transactionId（非新建 recovery tx）。
  const claimId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const freshOwnerNonce = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  harness.queueClockIds([claimId, freshOwnerNonce]);

  const coordinator = createFullCoordinatorWithAuthoritySentinel(harness, capability);
  const locked = await coordinator.recoverAfterManualRepair(capability);

  // 可选加固：exact frozen locked context；敏感键/private brand absent（不绑定未批准 public keys）。
  assertDeeplyFrozen(locked);
  for (const forbidden of [
    'capability',
    'authority',
    'confirmation',
    'manualRepairConfirmationId',
    'projection',
    'privateBrand',
    'brand',
  ]) {
    assert.equal(
      Object.hasOwn(locked, forbidden),
      false,
      `locked context must not expose ${forbidden}`,
    );
  }

  const trace = harness.trace();
  assert.equal(trace[0], 'authority-consumed');
  assert.ok(trace.includes('attestation-file-sync'));
  assert.ok(trace.includes('attestation-directory-sync'));
  assert.ok(trace.includes('attestation-verify'));
  assert.ok(trace.includes('recovery-lock-acquire'));
  assert.ok(trace.includes('post-lock-snapshot'));
  assert.equal(harness.hasManualRepairAttestation(confirmationId), true);
  assert.equal(harness.hasRecoveryClaim(), false);
  assert.equal(harness.lockState().transactionLock, true);
  const txRef = harness.transactionLockRefForTest();
  assert.equal(txRef.transactionId, seeded.mirTransactionId);
  assert.equal(txRef.ownerNonce, freshOwnerNonce);
  const acquired = harness.lockAcquisitionsForTest();
  assert.ok(acquired.some((item) => item.kind === 'transaction-lock'));
  const history = harness.recoveryAcquisitionsForTest();
  assert.equal(history.length, 1);
  assert.equal(history[0].claimId, claimId);
  assert.equal(history[0].transactionId, seeded.mirTransactionId);
  assert.equal(history[0].ownerNonce, freshOwnerNonce);
  assertZeroHost(harness);
  await assertCapabilityReplayDenied(capability);
});

test('manual repair entry lookalike clone and replay denied before any I/O', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  createCoordinatorOrRed(harness);

  const seeded = seedReachableMir(harness);
  const { capability } = await mintGenuineCapability({
    mirTransactionId: seeded.mirTransactionId,
    mirLockRef: seeded.mirRef,
    transactionLockRef: null,
    anchorId: seeded.anchorId,
  });
  const lookalike = {
    schemaVersion: 1,
    kind: 'launchagent-manual-repair',
    manualRepairRequestId: UUID.manualRepair,
    mirTransactionId: seeded.mirTransactionId,
    mirLockIdentitySha256: seeded.mirRef.sha256,
    anchorId: seeded.anchorId,
    repairDeclarationSha256: SHA_REPAIR,
    authorizedAt: TS_NOW,
  };

  harness.resetObservations();
  const hostBefore = harness.sentinels().hostMutationCount;
  const coordinator = createFullCoordinator(harness);

  await assert.rejects(
    () => coordinator.recoverAfterManualRepair(lookalike),
    (error) => {
      assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.ACCEPTANCE_GATE_DENIED);
      return true;
    },
  );
  await assert.rejects(
    () => coordinator.recoverAfterManualRepair(structuredClone(capability)),
    (error) => {
      assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.ACCEPTANCE_GATE_DENIED);
      return true;
    },
  );

  assert.equal(harness.trace().length, 0, 'lookalike/clone must perform zero harness I/O');
  assert.equal(harness.hasManualRepairAttestation(UUID.manualConfirmation), false);
  assert.equal(harness.lockState().transactionLock, false);
  assert.equal(harness.sentinels().hostMutationCount, hostBefore);
  assert.equal(harness.sentinels().realLaunchctlCalls, 0);
  // Genuine capability still unburned by forgeries
  const authority = assertAndConsumeLaunchAgentManualRepairAuthority(capability);
  assert.equal(authority.manualRepairConfirmationId, UUID.manualConfirmation);
});

test('manual repair attestation same-ID conflicting replay is no-clobber and burns authority', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  createCoordinatorOrRed(harness);

  const seeded = seedReachableMir(harness);
  const originalAttestation = harness.seedManualRepairAttestation(
    validateLaunchAgentManualRepairAttestation({
      schemaVersion: 1,
      kind: 'launchagent-manual-repair-attestation',
      manualRepairConfirmationId: UUID.manualConfirmation,
      manualRepairRequestId: UUID.manualRepair,
      mirTransactionId: seeded.mirTransactionId,
      mirLockIdentitySha256: seeded.mirRef.sha256,
      anchorId: seeded.anchorId,
      // 不同 canonical：与即将 mint 的 capability 修复声明不一致
      repairDeclarationSha256: '1'.repeat(64),
      authorizedAt: TS_NOW,
      attestedAt: '2026-08-02T12:00:01.000Z',
    }),
  );

  const { capability, confirmationId } = await mintGenuineCapability({
    mirTransactionId: seeded.mirTransactionId,
    mirLockRef: seeded.mirRef,
    transactionLockRef: null,
    anchorId: seeded.anchorId,
  });

  harness.resetObservations();
  const coordinator = createFullCoordinatorWithAuthoritySentinel(harness, capability);

  await assert.rejects(
    () => coordinator.recoverAfterManualRepair(capability),
    (error) => {
      assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.CONFIRMATION_CONSUMED);
      return true;
    },
  );

  // 原 attestation 不变；capability 已烧毁；无锁/host mutation
  assert.deepEqual(
    harness.manualRepairAttestationForTest(confirmationId),
    originalAttestation,
  );
  assert.equal(harness.lockState().transactionLock, false);
  assert.equal(harness.lockState().manualInterventionLock, true);
  assert.deepEqual(harness.lockAcquisitionsForTest(), []);
  assert.equal(harness.hasRecoveryClaim(), false);
  assertZeroHost(harness);
  await assertCapabilityReplayDenied(capability);
  await assert.rejects(
    () => coordinator.recoverAfterManualRepair(capability),
    (error) => {
      assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.ACCEPTANCE_GATE_DENIED);
      return true;
    },
  );
});

test('manual repair entry no transaction lock allows recovery lock acquisition path', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  createCoordinatorOrRed(harness);

  const seeded = seedReachableMir(harness);
  assert.equal(harness.lockState().transactionLock, false);

  const { capability, confirmationId } = await mintGenuineCapability({
    mirTransactionId: seeded.mirTransactionId,
    mirLockRef: seeded.mirRef,
    transactionLockRef: null,
    anchorId: seeded.anchorId,
  });

  harness.resetObservations();
  harness.armPostLockSnapshotEvent();
  const claimId = 'a1111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const freshOwnerNonce = 'c3333333-cccc-4ccc-8ccc-cccccccccccc';
  harness.queueClockIds([claimId, freshOwnerNonce]);

  const coordinator = createFullCoordinatorWithAuthoritySentinel(harness, capability);
  await coordinator.recoverAfterManualRepair(capability);

  const trace = harness.trace();
  assert.equal(trace[0], 'authority-consumed');
  assert.ok(trace.includes('attestation-file-sync'));
  assert.ok(trace.includes('attestation-verify'));
  assert.ok(trace.includes('recovery-lock-acquire'));
  assert.ok(trace.includes('post-lock-snapshot'));
  assert.equal(trace.includes('owner-observe-1'), false, 'no residual tx → no owner observe');
  assert.equal(harness.hasManualRepairAttestation(confirmationId), true);
  assert.equal(harness.hasRecoveryClaim(), false);
  assert.equal(harness.lockState().transactionLock, true);
  const txRef = harness.transactionLockRefForTest();
  assert.equal(txRef.transactionId, seeded.mirTransactionId);
  assert.equal(txRef.ownerNonce, freshOwnerNonce);
  const history = harness.recoveryAcquisitionsForTest();
  assert.equal(history.length, 1);
  assert.equal(history[0].claimId, claimId);
  assert.equal(history[0].transactionId, seeded.mirTransactionId);
  assert.equal(history[0].ownerNonce, freshOwnerNonce);
  assertZeroHost(harness);
  await assertCapabilityReplayDenied(capability);
});

test('manual repair entry residual transaction lock requires two consecutive dead owner observations', async () => {
  // --- Block path: dead + alive-same-owner → coordinator 阻断并烧毁能力 ---
  {
    const harness = createLaunchAgentLifecycleHarness();
    createCoordinatorOrRed(harness);

    // residual old lock 必须与 MIR 同 transactionId（不同 ownerNonce）；
    // 真实 metadata store 拒绝 cross-transaction expected ref。
    const oldRecord = lockRecord(UUID.mirTx, UUID.txNonce, FIXED_OWNER_PID);
    const seeded = seedReachableMir(harness, { transactionLockRecord: oldRecord });
    const { capability } = await mintGenuineCapability({
      mirTransactionId: seeded.mirTransactionId,
      mirLockRef: seeded.mirRef,
      transactionLockRef: seeded.transactionLockRef,
      anchorId: seeded.anchorId,
    });

    harness.resetObservations();
    harness.armOwnerObserveStatuses(['dead', 'alive-same-owner']);
    const coordinator = createFullCoordinatorWithAuthoritySentinel(harness, capability);

    await assert.rejects(
      () => coordinator.recoverAfterManualRepair(capability),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
        return true;
      },
    );

    const trace = harness.trace();
    assert.equal(trace[0], 'authority-consumed');
    assert.ok(trace.includes('owner-observe-1'));
    assert.ok(trace.includes('owner-observe-2'));
    assertNoAcquireOrPostLock(trace);
    // residual old lock retained; capability burned; zero host
    assert.equal(harness.lockState().transactionLock, true);
    assert.deepEqual(harness.transactionLockRefForTest(), seeded.transactionLockRef);
    assert.deepEqual(harness.lockAcquisitionsForTest(), []);
    assert.deepEqual(harness.recoveryAcquisitionsForTest(), []);
    assertZeroHost(harness);
    await assertCapabilityReplayDenied(capability);
  }

  // --- Success path: fresh harness + capability, dead+dead → acquisition ---
  {
    const harness = createLaunchAgentLifecycleHarness();
    createCoordinatorOrRed(harness);

    // residual old lock 与 MIR 同 transactionId、不同 ownerNonce
    const oldRecord = lockRecord(UUID.mirTx, UUID.txNonce, FIXED_OWNER_PID);
    const seeded = seedReachableMir(harness, { transactionLockRecord: oldRecord });
    const { capability, confirmationId } = await mintGenuineCapability({
      mirTransactionId: seeded.mirTransactionId,
      mirLockRef: seeded.mirRef,
      transactionLockRef: seeded.transactionLockRef,
      anchorId: seeded.anchorId,
    });

    harness.resetObservations();
    harness.armOwnerObserveStatuses(['dead', 'dead']);
    harness.armPostLockSnapshotEvent();
    const claimId = 'd1111111-dddd-4ddd-8ddd-dddddddddddd';
    const freshOwnerNonce = 'f3333333-ffff-4fff-8fff-ffffffffffff';
    harness.queueClockIds([claimId, freshOwnerNonce]);

    const coordinator = createFullCoordinatorWithAuthoritySentinel(harness, capability);
    await coordinator.recoverAfterManualRepair(capability);

    const trace = harness.trace();
    assert.equal(trace[0], 'authority-consumed');
    assert.ok(trace.includes('owner-observe-1'));
    assert.ok(trace.includes('owner-observe-2'));
    assert.ok(trace.includes('recovery-lock-acquire'));
    assert.ok(trace.includes('post-lock-snapshot'));
    assert.equal(harness.hasManualRepairAttestation(confirmationId), true);
    assert.equal(harness.hasRecoveryClaim(), false);
    assert.equal(harness.lockState().transactionLock, true);
    const txRef = harness.transactionLockRefForTest();
    assert.equal(txRef.transactionId, seeded.mirTransactionId);
    assert.equal(txRef.ownerNonce, freshOwnerNonce);
    assert.equal(txRef.transactionId, seeded.transactionLockRef.transactionId);
    assert.notEqual(txRef.ownerNonce, seeded.transactionLockRef.ownerNonce);
    const history = harness.recoveryAcquisitionsForTest();
    assert.equal(history.length, 1);
    assert.equal(history[0].claimId, claimId);
    assert.equal(history[0].transactionId, seeded.mirTransactionId);
    assert.equal(history[0].ownerNonce, freshOwnerNonce);
    assertZeroHost(harness);
    await assertCapabilityReplayDenied(capability);
  }
});

test('manual repair entry residual claim resolve stops authorization for all safe statuses', async () => {
  const gateHarness = createLaunchAgentLifecycleHarness();
  createCoordinatorOrRed(gateHarness);

  const safeStatuses = [
    {
      status: 'transaction-lock-absent',
      claimId: '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      // claim.ownerNonce 必须等于 freshTransactionLockRef.ownerNonce（生产 cross-binding）
      freshNonce: '33333333-cccc-4ccc-8ccc-cccccccccccc',
      setupTx: null,
    },
    {
      status: 'old-intact',
      claimId: '12121212-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      freshNonce: '34343434-cccc-4ccc-8ccc-cccccccccccc',
      setupTx: 'old',
    },
    {
      status: 'fresh-published',
      claimId: '13131313-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      freshNonce: '35353535-cccc-4ccc-8ccc-cccccccccccc',
      setupTx: 'fresh',
    },
  ];

  for (const row of safeStatuses) {
    const harness = createLaunchAgentLifecycleHarness();
    // 每条 safe status：全新 harness + 全新 genuine capability
    const mirRef = (() => {
      const head = harness.seedMirHeadAndAnchor({
        transactionId: UUID.mirTx,
        anchorId: UUID.anchor,
      });
      void head;
      return harness.seedManualInterventionLock(lockRecord(UUID.mirTx, UUID.ownerNonce));
    })();

    let expectedTransactionLockRef = null;
    let currentTxRecord = null;
    if (row.setupTx === 'old') {
      // residual old 与 MIR 同 transactionId、不同 ownerNonce
      currentTxRecord = lockRecord(UUID.mirTx, UUID.txNonce);
      expectedTransactionLockRef = harness.seedTransactionLock(currentTxRecord);
    } else if (row.setupTx === 'fresh') {
      currentTxRecord = lockRecord(UUID.mirTx, row.freshNonce);
      expectedTransactionLockRef = null;
      harness.seedTransactionLock(currentTxRecord);
    }

    const freshSha = harness.sha256(Buffer.from(JSON.stringify({
      schemaVersion: 1,
      transactionId: UUID.mirTx,
      ownerPid: FIXED_OWNER_PID,
      ownerNonce: row.freshNonce,
      ...identityPair(),
    }), 'utf8'));
    const freshTransactionLockRef = {
      kind: 'transaction-lock',
      transactionId: UUID.mirTx,
      ownerNonce: row.freshNonce,
      sha256: row.setupTx === 'fresh'
        ? harness.transactionLockRefForTest().sha256
        : freshSha,
    };
    // old-intact：expected = current old lock；fresh-published：fresh ref = current
    if (row.setupTx === 'old') {
      // expectedTransactionLockRef already set to old
    }
    if (row.setupTx === 'fresh') {
      // current is fresh; expected remains null; fresh ref matches current
    }

    harness.seedRecoveryClaim({
      schemaVersion: 1,
      kind: 'recovery-claim-lock',
      claimId: row.claimId,
      transactionId: UUID.mirTx,
      ownerPid: FIXED_OWNER_PID,
      // claim.ownerNonce ≡ freshTransactionLockRef.ownerNonce（生产不可分离）
      ownerNonce: row.freshNonce,
      ...identityPair(),
      expectedTransactionLockRef: row.setupTx === 'old' ? expectedTransactionLockRef : null,
      manualInterventionLockRef: mirRef,
      freshTransactionLockRef,
    });

    const { capability, confirmationId } = await mintGenuineCapability({
      mirTransactionId: UUID.mirTx,
      mirLockRef: mirRef,
      transactionLockRef: row.setupTx === 'old' ? expectedTransactionLockRef : (
        row.setupTx === 'fresh' ? harness.transactionLockRefForTest() : null
      ),
      anchorId: UUID.anchor,
      // 每 status 独立 confirmation，避免 attestation 串线
      confirmationId: `c${row.claimId.slice(1)}`,
      manualRepairRequestId: `d${row.claimId.slice(1)}`,
    });

    harness.resetObservations();
    harness.armClaimOwnerObserveStatuses(['dead', 'dead']);
    const coordinator = createFullCoordinatorWithAuthoritySentinel(harness, capability);
    await coordinator.recoverAfterManualRepair(capability);

    const trace = harness.trace();
    assert.equal(trace[0], 'authority-consumed', `safe status ${row.status}`);
    assert.ok(trace.includes('claim-owner-observe-1'), `safe status ${row.status}`);
    assert.ok(trace.includes('claim-owner-observe-2'), `safe status ${row.status}`);
    assert.ok(trace.includes('claim-resolve'), `safe status ${row.status}`);
    assertNoAcquireOrPostLock(trace);
    assert.equal(trace.includes('receipt'), false, 'no terminal after claim-resolve');
    assert.equal(harness.hasRecoveryClaim(), false, `claim cleared for ${row.status}`);
    assert.equal(harness.hasManualRepairAttestation(confirmationId), true);
    assert.deepEqual(harness.lockAcquisitionsForTest(), []);
    assertZeroHost(harness);
    await assertCapabilityReplayDenied(capability);
  }

  // 四个阻断 status：实际调用 coordinator，精确错误，claim retained，无 acquire/host。
  // §6.3.3：claim owner 活跃（alive-same-owner）→ transaction-in-progress；
  // 仅连续两次 dead 才 resolution。pid-reused / unavailable / boot-session-mismatch
  // 仍为 recovery-claim-stalled。活跃分支不得 resolve。
  const blockingRows = [
    {
      status: 'alive-same-owner',
      // RED：当前 source 将活跃 owner 误映射为 recovery-claim-stalled
      expectedCode: LAUNCHAGENT_LIFECYCLE_CODES.TRANSACTION_IN_PROGRESS,
      confirmationId: 'c1000001-eeee-4eee-8eee-eeeeeeeeeeee',
      requestId: 'd1000001-dddd-4ddd-8ddd-dddddddddddd',
    },
    {
      status: 'pid-reused',
      expectedCode: LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_CLAIM_STALLED,
      confirmationId: 'c1000002-eeee-4eee-8eee-eeeeeeeeeeee',
      requestId: 'd1000002-dddd-4ddd-8ddd-dddddddddddd',
    },
    {
      status: 'unavailable',
      expectedCode: LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_CLAIM_STALLED,
      confirmationId: 'c1000003-eeee-4eee-8eee-eeeeeeeeeeee',
      requestId: 'd1000003-dddd-4ddd-8ddd-dddddddddddd',
    },
    {
      status: 'boot-session-mismatch',
      expectedCode: LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_CLAIM_STALLED,
      confirmationId: 'c1000004-eeee-4eee-8eee-eeeeeeeeeeee',
      requestId: 'd1000004-dddd-4ddd-8ddd-dddddddddddd',
    },
  ];

  for (const row of blockingRows) {
    const status = row.status;
    const harness = createLaunchAgentLifecycleHarness();
    const mirRef = harness.seedManualInterventionLock(lockRecord(UUID.mirTx, UUID.ownerNonce));
    harness.seedMirHeadAndAnchor({ transactionId: UUID.mirTx, anchorId: UUID.anchor });
    const claimId = '44444444-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    // claim.ownerNonce 必须等于 freshTransactionLockRef.ownerNonce
    const claimOwnerNonce = '55555555-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const seededClaim = harness.seedRecoveryClaim({
      schemaVersion: 1,
      kind: 'recovery-claim-lock',
      claimId,
      transactionId: UUID.mirTx,
      ownerPid: FIXED_OWNER_PID,
      ownerNonce: claimOwnerNonce,
      ...identityPair(),
      expectedTransactionLockRef: null,
      manualInterventionLockRef: mirRef,
      freshTransactionLockRef: {
        kind: 'transaction-lock',
        transactionId: UUID.mirTx,
        ownerNonce: claimOwnerNonce,
        sha256: 'b'.repeat(64),
      },
    });
    const winnerRefBefore = harness.recoveryClaimRefForTest();

    const { capability, confirmationId } = await mintGenuineCapability({
      mirTransactionId: UUID.mirTx,
      mirLockRef: mirRef,
      transactionLockRef: null,
      anchorId: UUID.anchor,
      confirmationId: row.confirmationId,
      manualRepairRequestId: row.requestId,
    });

    harness.resetObservations();
    harness.armClaimOwnerObserveStatuses([status, status]);
    const coordinator = createFullCoordinatorWithAuthoritySentinel(harness, capability);

    await assert.rejects(
      () => coordinator.recoverAfterManualRepair(capability),
      (error) => {
        assertLifecycleCode(error, row.expectedCode);
        return true;
      },
    );

    const trace = harness.trace();
    assert.equal(trace[0], 'authority-consumed', `blocking ${status}`);
    assert.ok(
      trace.includes('claim-owner-observe-1'),
      `blocking ${status} must observe claim owner`,
    );
    assert.equal(trace.includes('claim-resolve'), false, `no resolve for ${status}`);
    assertNoAcquireOrPostLock(trace);
    assert.equal(harness.hasRecoveryClaim(), true, `claim retained for ${status}`);
    assert.deepEqual(harness.recoveryClaimRefForTest(), winnerRefBefore);
    assert.equal(
      harness.hasManualRepairAttestation(confirmationId),
      true,
      `attestation durable for ${status}`,
    );
    assert.deepEqual(harness.lockAcquisitionsForTest(), []);
    assert.deepEqual(harness.recoveryAcquisitionsForTest(), []);
    assertZeroHost(harness);
    await assertCapabilityReplayDenied(capability);
    void seededClaim;
  }
});

/**
 * §6.4 post-lock snapshot class B / C（Task 5 review-fix RED）。
 * 使用 armPostLockSnapshotEvent + afterEvent('post-lock-snapshot') 在 acquire 成功后、
 * coordinator post-lock reread 之前注入漂移；不得改 harness。
 *
 * B：授权 anchor 漂移，但原 MIR/head + journal 完全未变 → abort 自己 exact recovery tx lock。
 * C：全局 journal heads/journalSha256 漂移，但授权 MIR 自身 head/entries 不变 → 保留自己 recovery lock。
 */
test('manual repair entry post-lock snapshot class B anchor drift and class C global journal drift', async () => {
  // --- Class B：anchor 在 acquire 成功后漂移；原 MIR/head+journal 未变 → abort own lock ---
  {
    const harness = createLaunchAgentLifecycleHarness();
    createCoordinatorOrRed(harness);

    const seeded = seedReachableMir(harness);
    const mirRefBefore = seeded.mirRef;
    const { capability, confirmationId } = await mintGenuineCapability({
      mirTransactionId: seeded.mirTransactionId,
      mirLockRef: seeded.mirRef,
      transactionLockRef: null,
      anchorId: seeded.anchorId,
      confirmationId: 'c6b4000b-eeee-4eee-8eee-eeeeeeeeeeee',
      manualRepairRequestId: 'd6b4000b-dddd-4ddd-8ddd-dddddddddddd',
    });

    const claimId = 'a6b4000b-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const freshOwnerNonce = 'c6b4000b-cccc-4ccc-8ccc-cccccccccccc';
    harness.resetObservations();
    harness.armPostLockSnapshotEvent();
    // acquire 成功后、coordinator post-lock reread 之前删除授权 anchor
    harness.afterEvent('post-lock-snapshot', () => {
      harness.deleteAnchorFor(seeded.anchorId);
    });
    harness.queueClockIds([claimId, freshOwnerNonce]);

    const coordinator = createFullCoordinatorWithAuthoritySentinel(harness, capability);
    await assert.rejects(
      () => coordinator.recoverAfterManualRepair(capability),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
        return true;
      },
    );

    const trace = harness.trace();
    assert.equal(trace[0], 'authority-consumed');
    assert.ok(trace.includes('recovery-lock-acquire'));
    assert.ok(trace.includes('post-lock-snapshot'));
    // class B：只 abort 自己 exact recovery transaction lock
    assert.equal(harness.lockState().transactionLock, false, 'class B must abort own recovery tx lock');
    assert.deepEqual(
      harness.manualInterventionLockRefForTest(),
      mirRefBefore,
      'class B must retain MIR ref exact',
    );
    assert.equal(harness.hasRecoveryClaim(), false, 'class B claim absent');
    assert.equal(harness.hasManualRepairAttestation(confirmationId), true);
    assertZeroHost(harness);
    await assertCapabilityReplayDenied(capability);
  }

  // --- Class C：全局 journal 在 acquire 成功后漂移；授权 MIR head/entries 不变 → 保留 lock ---
  {
    const harness = createLaunchAgentLifecycleHarness();
    createCoordinatorOrRed(harness);

    const seeded = seedReachableMir(harness);
    const mirRefBefore = seeded.mirRef;
    const foreignTransactionId = 'f6b4000c-0000-4000-8000-0000000000c1';
    const { capability, confirmationId } = await mintGenuineCapability({
      mirTransactionId: seeded.mirTransactionId,
      mirLockRef: seeded.mirRef,
      transactionLockRef: null,
      anchorId: seeded.anchorId,
      confirmationId: 'c6b4000c-eeee-4eee-8eee-eeeeeeeeeeee',
      manualRepairRequestId: 'd6b4000c-dddd-4ddd-8ddd-dddddddddddd',
    });

    const claimId = 'a6b4000c-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const freshOwnerNonce = 'c6b4000c-cccc-4ccc-8ccc-cccccccccccc';
    harness.resetObservations();
    harness.armPostLockSnapshotEvent();
    // 注入另一 canonical transaction 的合法非终态 head：MIR 自身不变，全局 heads/journalSha256 改变
    harness.afterEvent('post-lock-snapshot', () => {
      harness.seedForeignNonterminalHead({
        transactionId: foreignTransactionId,
        operation: 'install',
        state: 'prepared',
      });
    });
    harness.queueClockIds([claimId, freshOwnerNonce]);

    const coordinator = createFullCoordinatorWithAuthoritySentinel(harness, capability);
    await assert.rejects(
      () => coordinator.recoverAfterManualRepair(capability),
      (error) => {
        // RED：当前 source 忽略全局 heads/journalSha256，错误返回 locked
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
        return true;
      },
    );

    const trace = harness.trace();
    assert.equal(trace[0], 'authority-consumed');
    assert.ok(trace.includes('recovery-lock-acquire'));
    assert.ok(trace.includes('post-lock-snapshot'));
    // class C：必须保留自己 recovery transaction lock + MIR
    assert.equal(
      harness.lockState().transactionLock,
      true,
      'class C must retain own recovery transaction lock',
    );
    const txRef = harness.transactionLockRefForTest();
    assert.equal(txRef.transactionId, seeded.mirTransactionId);
    assert.equal(txRef.ownerNonce, freshOwnerNonce);
    assert.deepEqual(
      harness.manualInterventionLockRefForTest(),
      mirRefBefore,
      'class C must retain MIR ref exact',
    );
    assert.equal(harness.hasRecoveryClaim(), false, 'class C claim absent');
    assert.equal(harness.hasManualRepairAttestation(confirmationId), true);
    assert.deepEqual(
      harness.journalStates(seeded.mirTransactionId),
      ['manual-intervention-required'],
      'class C must leave authorized MIR head unchanged',
    );
    assert.deepEqual(
      harness.journalStates(foreignTransactionId),
      ['prepared'],
      'class C foreign nonterminal head must be present in global journal',
    );
    assertZeroHost(harness);
    await assertCapabilityReplayDenied(capability);
  }
});

test('manual repair entry MIR ref journal head and anchor drift fail closed with attestation retained', async () => {
  const gateHarness = createLaunchAgentLifecycleHarness();
  createCoordinatorOrRed(gateHarness);

  // --- MIR lock identity drift ---
  {
    const harness = createLaunchAgentLifecycleHarness();
    const seeded = seedReachableMir(harness);
    const { capability, confirmationId } = await mintGenuineCapability({
      mirTransactionId: seeded.mirTransactionId,
      mirLockRef: seeded.mirRef,
      transactionLockRef: null,
      anchorId: seeded.anchorId,
    });
    // mint 后漂移 MIR lock identity（不同 ownerNonce → 不同 sha）
    harness.seedManualInterventionLock(
      lockRecord(seeded.mirTransactionId, '99999999-9999-4999-8999-999999999999'),
    );
    harness.resetObservations();
    const coordinator = createFullCoordinatorWithAuthoritySentinel(harness, capability);
    await assert.rejects(
      () => coordinator.recoverAfterManualRepair(capability),
      (error) => error instanceof LaunchAgentLifecycleError,
    );
    assert.equal(harness.hasManualRepairAttestation(confirmationId), true);
    assert.equal(harness.lockState().transactionLock, false);
    assert.deepEqual(harness.lockAcquisitionsForTest(), []);
    assertZeroHost(harness);
    await assertCapabilityReplayDenied(capability);
  }

  // --- journal head drift（清空 MIR head）---
  {
    const harness = createLaunchAgentLifecycleHarness();
    const seeded = seedReachableMir(harness);
    const { capability, confirmationId } = await mintGenuineCapability({
      mirTransactionId: seeded.mirTransactionId,
      mirLockRef: seeded.mirRef,
      transactionLockRef: null,
      anchorId: seeded.anchorId,
      confirmationId: 'c2000002-eeee-4eee-8eee-eeeeeeeeeeee',
      manualRepairRequestId: 'd2000002-dddd-4ddd-8ddd-dddddddddddd',
    });
    // MIR journal head 漂移为非 MIR checkpoint
    harness.driftMirJournalHeadForTest(seeded.mirTransactionId);
    harness.resetObservations();
    const coordinator = createFullCoordinatorWithAuthoritySentinel(harness, capability);
    await assert.rejects(
      () => coordinator.recoverAfterManualRepair(capability),
      (error) => error instanceof LaunchAgentLifecycleError,
    );
    assert.equal(harness.hasManualRepairAttestation(confirmationId), true);
    assert.equal(harness.lockState().transactionLock, false);
    assertZeroHost(harness);
    await assertCapabilityReplayDenied(capability);
  }

  // --- anchor drift（删除 anchor）---
  {
    const harness = createLaunchAgentLifecycleHarness();
    const seeded = seedReachableMir(harness);
    const { capability, confirmationId } = await mintGenuineCapability({
      mirTransactionId: seeded.mirTransactionId,
      mirLockRef: seeded.mirRef,
      transactionLockRef: null,
      anchorId: seeded.anchorId,
      confirmationId: 'c2000003-eeee-4eee-8eee-eeeeeeeeeeee',
      manualRepairRequestId: 'd2000003-dddd-4ddd-8ddd-dddddddddddd',
    });
    harness.deleteAnchorFor(seeded.anchorId);
    harness.resetObservations();
    const coordinator = createFullCoordinatorWithAuthoritySentinel(harness, capability);
    await assert.rejects(
      () => coordinator.recoverAfterManualRepair(capability),
      (error) => error instanceof LaunchAgentLifecycleError,
    );
    assert.equal(harness.hasManualRepairAttestation(confirmationId), true);
    assert.equal(harness.lockState().transactionLock, false);
    assertZeroHost(harness);
    await assertCapabilityReplayDenied(capability);
  }
});

test('manual repair entry recovery claim race loser preserves winner claim and never cleans it', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  createCoordinatorOrRed(harness);

  const seeded = seedReachableMir(harness);
  const { capability, confirmationId } = await mintGenuineCapability({
    mirTransactionId: seeded.mirTransactionId,
    mirLockRef: seeded.mirRef,
    transactionLockRef: null,
    anchorId: seeded.anchorId,
  });

  // Winner claim 仅在下一次 acquire 原子 claim 检查点注入（O_EXCL 竞争赢家），
  // 不得 afterEvent(attestation-verify)/seed 提前写入 store，否则 readRecoveryClaimObservation
  // 会把 winner 误判为 residual claim 而非 acquire race loser。
  const winnerClaimId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const winnerOwnerNonce = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  harness.resetObservations();
  const winner = harness.raceRecoveryClaimOnNextAcquire({
    schemaVersion: 1,
    kind: 'recovery-claim-lock',
    claimId: winnerClaimId,
    transactionId: seeded.mirTransactionId,
    ownerPid: FIXED_OWNER_PID,
    ownerNonce: winnerOwnerNonce,
    ...identityPair(),
    expectedTransactionLockRef: null,
    manualInterventionLockRef: seeded.mirRef,
    freshTransactionLockRef: {
      kind: 'transaction-lock',
      transactionId: seeded.mirTransactionId,
      // claim.ownerNonce ≡ fresh.ownerNonce（生产 cross-binding）
      ownerNonce: winnerOwnerNonce,
      sha256: 'c'.repeat(64),
    },
  });
  const winnerRefBefore = winner.ref;
  // Arm 不得写入 store：pre-acquire residual observation 路径必须真实见 absent
  assert.equal(harness.hasRecoveryClaim(), false);

  // 仅 queue claimId + freshOwnerNonce；transactionId 固定为 MIR
  harness.queueClockIds([
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  ]);

  const coordinator = createFullCoordinatorWithAuthoritySentinel(harness, capability);
  await assert.rejects(
    () => coordinator.recoverAfterManualRepair(capability),
    (error) => {
      assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.TRANSACTION_IN_PROGRESS);
      return true;
    },
  );

  // Winner ref 精确保留；transaction lock absent；attestation durable
  assert.equal(harness.hasRecoveryClaim(), true);
  assert.deepEqual(harness.recoveryClaimRefForTest(), winnerRefBefore);
  assert.equal(winnerRefBefore.claimId, winnerClaimId);
  assert.equal(winnerRefBefore.ownerNonce, winnerOwnerNonce);
  assert.equal(winnerRefBefore.transactionId, seeded.mirTransactionId);
  assert.equal(harness.lockState().transactionLock, false);
  assert.equal(harness.hasManualRepairAttestation(confirmationId), true);

  // 无 successful lock/recovery acquisition history
  assert.deepEqual(harness.lockAcquisitionsForTest(), []);
  assert.deepEqual(harness.recoveryAcquisitionsForTest(), []);

  // acquire 之前的 initial recovery-claim observation 必须见 absent（非 residual）
  const claimObs = harness.recoveryClaimObservationsForTest();
  assert.ok(claimObs.length >= 1, 'must observe recovery claim before acquire');
  assert.equal(claimObs[0].present, false, 'initial recovery-claim observation must see absent');

  // race loser 不得进入 residual resolve 或成功 acquire 路径
  const trace = harness.trace();
  assert.equal(trace.includes('recovery-claim-resolve'), false);
  assert.equal(trace.includes('claim-resolve'), false);
  assert.equal(trace.includes('recovery-lock-acquire'), false);
  assert.equal(trace.includes('post-lock-snapshot'), false);

  assertZeroHost(harness);
  await assertCapabilityReplayDenied(capability);
});

test('manual repair entry claimId MIR transactionId fresh ownerNonce are pairwise distinct', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  createCoordinatorOrRed(harness);

  const seeded = seedReachableMir(harness);
  const { capability, confirmationId } = await mintGenuineCapability({
    mirTransactionId: seeded.mirTransactionId,
    mirLockRef: seeded.mirRef,
    transactionLockRef: null,
    anchorId: seeded.anchorId,
  });

  // coordinator 仅 clock.newId() → claimId + freshOwnerNonce；
  // transactionId 固定为 authority.projection.mirTransactionId（非 clock.newId）。
  const claimId = '11111111-1111-4111-8111-111111111111';
  const freshOwnerNonce = '33333333-3333-4333-8333-333333333333';
  harness.resetObservations();
  harness.armPostLockSnapshotEvent();
  harness.queueClockIds([claimId, freshOwnerNonce]);

  const coordinator = createFullCoordinatorWithAuthoritySentinel(harness, capability);
  await coordinator.recoverAfterManualRepair(capability);

  // claimId / MIR transactionId / fresh ownerNonce 两两不同
  assert.notEqual(claimId, seeded.mirTransactionId);
  assert.notEqual(claimId, freshOwnerNonce);
  assert.notEqual(seeded.mirTransactionId, freshOwnerNonce);

  const txRef = harness.transactionLockRefForTest();
  assert.equal(txRef.transactionId, seeded.mirTransactionId);
  assert.equal(txRef.ownerNonce, freshOwnerNonce);
  assert.notEqual(txRef.transactionId, claimId);
  assert.notEqual(txRef.ownerNonce, claimId);

  // recovery acquisition history：claim 删除后仍可证明 coordinator 传入的 claimId
  const history = harness.recoveryAcquisitionsForTest();
  assert.equal(history.length, 1);
  assert.equal(history[0].claimId, claimId);
  assert.equal(history[0].transactionId, seeded.mirTransactionId);
  assert.equal(history[0].ownerNonce, freshOwnerNonce);
  assert.notEqual(history[0].claimId, history[0].transactionId);
  assert.notEqual(history[0].claimId, history[0].ownerNonce);
  assert.notEqual(history[0].transactionId, history[0].ownerNonce);

  const acquired = harness.lockAcquisitionsForTest();
  assert.ok(acquired.length >= 1);
  const last = acquired[acquired.length - 1];
  assert.equal(last.kind, 'transaction-lock');
  assert.equal(last.record.transactionId, seeded.mirTransactionId);
  assert.equal(last.record.ownerNonce, freshOwnerNonce);
  // lock record 身份来自 processIdentityReader.current（非 fixture 伪造）
  assert.equal(last.record.bootSessionIdentity.value, FAKE_BOOT);
  assert.equal(last.record.processStartIdentity.value, FAKE_PSTART);
  assert.ok(harness.processIdentityCurrentCountForTest() >= 1);

  const trace = harness.trace();
  assert.equal(trace[0], 'authority-consumed');
  assert.ok(trace.includes('recovery-lock-acquire'));
  assert.equal(harness.hasManualRepairAttestation(confirmationId), true);
  assertZeroHost(harness);
  await assertCapabilityReplayDenied(capability);
});

// ---------------------------------------------------------------------------
// Task 6B.1 Task 6 RED — pure closeout / ordered terminal cleanup
// 真实 coordinator.recoverAfterManualRepair 驱动；不得绕开、不得 helper 成功路径。
// hostMutationCount / publisher / bootstrap / bootout 必须保持不变；允许只读 inspect/print。
// ---------------------------------------------------------------------------

function assertPublisherHostUnchanged(harness, before) {
  const after = harness.sentinels();
  assert.equal(after.hostMutationCount, before.hostMutationCount, 'hostMutationCount must stay unchanged');
  assert.equal(after.publish, before.publish, 'publisher publish count must stay unchanged');
  assert.equal(after.remove, before.remove, 'publisher remove count must stay unchanged');
  assert.equal(after.bootstrap, before.bootstrap, 'bootstrap count must stay unchanged');
  assert.equal(after.bootout, before.bootout, 'bootout count must stay unchanged');
  assert.equal(after.realLaunchctlCalls, 0);
}

function assertOrderedTxThenMirRelease(trace) {
  const txRelease = trace.indexOf('lock-release');
  const mirRelease = trace.indexOf('mir-lock-release');
  assert.ok(txRelease !== -1, 'must release recovery transaction lock');
  assert.ok(mirRelease !== -1, 'must release MIR lock after terminal closeout');
  assert.ok(
    txRelease < mirRelease,
    'must release recovery tx lock strictly before MIR lock',
  );
}

/**
 * seed contracts-valid MIR prefix + MIR lock，经 public authorize mint capability，
 * 返回 coordinator 入口所需全部 exact refs。不伪造私有 brand。
 *
 * options.residualTransactionLockRecord：若提供则预置 residual/exact recovery tx lock，
 * 并绑定到 public authorize 的 transactionLockRef（existing terminal cleanup 必填：
 * terminal head 上不能新 acquire，只能绑定并释放已有 exact lock）。
 */
async function seedAuthorizedPureCloseoutScenario(harness, options = {}) {
  const mirTransactionId = options.mirTransactionId ?? UUID.mirTx;
  const anchorId = options.anchorId ?? UUID.anchor;
  const hostMode = options.hostMode ?? 'pending-action';
  const terminal = options.terminal ?? null;
  const confirmationId = options.confirmationId ?? UUID.manualConfirmation;
  const manualRepairRequestId = options.manualRepairRequestId ?? UUID.manualRepair;
  const mirOwnerNonce = options.mirOwnerNonce ?? UUID.ownerNonce;

  const prefix = harness.seedValidMirTransactionPrefix({
    transactionId: mirTransactionId,
    anchorId,
    hostMode,
    terminal,
  });
  const mirRef = harness.seedManualInterventionLock(
    lockRecord(mirTransactionId, mirOwnerNonce),
  );
  let transactionLockRef = null;
  if (options.residualTransactionLockRecord) {
    transactionLockRef = harness.seedTransactionLock(
      options.residualTransactionLockRecord,
    );
  }
  const { capability } = await mintGenuineCapability({
    mirTransactionId,
    mirLockRef: mirRef,
    transactionLockRef,
    anchorId,
    confirmationId,
    manualRepairRequestId,
  });
  return {
    prefix,
    mirRef,
    capability,
    confirmationId,
    mirTransactionId,
    anchorId,
    transactionLockRef,
  };
}

function queueFreshRecoveryIds(harness, claimId, freshOwnerNonce) {
  harness.queueClockIds([claimId, freshOwnerNonce]);
}

test('pure closeout existing exact recovered terminal and receipt performs terminal cleanup only', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  createCoordinatorOrRed(harness);

  // §6.4/6.6 class A cleanup-only：terminal head 上 metadata acquisition 只允许
  // latest MIR，不能新 acquire。fixture 必须预置 exact residual recovery tx lock，
  // public authorize 绑定该 exact ref；两次 dead owner 后只按 tx→MIR 释放，
  // 不 queue claimId/freshOwnerNonce、不期待 recovery-lock-acquire。
  const residualTxRecord = lockRecord(UUID.mirTx, UUID.txNonce, FIXED_OWNER_PID);
  const seeded = await seedAuthorizedPureCloseoutScenario(harness, {
    hostMode: 'recovered-checkpoint',
    terminal: 'recovered',
    residualTransactionLockRecord: residualTxRecord,
    confirmationId: 'c6b60001-eeee-4eee-8eee-eeeeeeeeeeee',
    manualRepairRequestId: 'd6b60001-dddd-4ddd-8ddd-dddddddddddd',
  });
  assert.ok(seeded.transactionLockRef, 'existing terminal must pre-seed exact tx lock');
  assert.deepEqual(
    harness.transactionLockRefForTest(),
    seeded.transactionLockRef,
    'pre-seeded recovery tx lock must be the exact bound ref',
  );
  const statesBefore = harness.journalStates(seeded.mirTransactionId);
  assert.deepEqual(
    statesBefore.at(-1),
    'recovered',
    'fixture must already end with exact recovered terminal',
  );
  const receiptBefore = harness.receiptFor(seeded.mirTransactionId);
  assert.ok(receiptBefore, 'fixture must include matching receipt');
  assert.equal(receiptBefore.state, 'recovered');
  const receiptShaBefore = harness.sha256(
    Buffer.from(JSON.stringify(receiptBefore), 'utf8'),
  );

  harness.resetObservations();
  // residual exact lock owner：连续两次 exact dead 后才允许 cleanup release。
  // 不 arm post-lock / 不 queue claimId+freshOwnerNonce：禁止新 acquisition 路径。
  harness.armOwnerObserveStatuses(['dead', 'dead']);
  const hostBefore = harness.sentinels();
  const coordinator = createFullCoordinatorWithAuthoritySentinel(
    harness,
    seeded.capability,
  );

  // Production bug: pure closeout cleanup-only for existing exact terminal+receipt
  // is not implemented — must verify terminal+matching receipt then release locks
  // in order without re-append/republish or new recovery acquisition.
  const result = await coordinator.recoverAfterManualRepair(seeded.capability);

  assert.equal(result.state, 'recovered');
  assert.equal(result.success, false);
  assert.equal(result.outcome, 'recovered');
  assert.equal(result.operation, seeded.prefix.operation);
  assert.equal(result.transactionId, seeded.mirTransactionId);

  const statesAfter = harness.journalStates(seeded.mirTransactionId);
  assert.deepEqual(
    statesAfter,
    statesBefore,
    'cleanup-only must not append another terminal',
  );
  const recoveredCount = statesAfter.filter((state) => state === 'recovered').length;
  assert.equal(recoveredCount, 1, 'must keep exactly one recovered terminal');
  const receiptAfter = harness.receiptFor(seeded.mirTransactionId);
  assert.deepEqual(receiptAfter, receiptBefore, 'must not republish/replace receipt');
  assert.equal(
    harness.sha256(Buffer.from(JSON.stringify(receiptAfter), 'utf8')),
    receiptShaBefore,
  );

  const locks = harness.lockState();
  assert.equal(locks.transactionLock, false, 'recovery tx lock must be released');
  assert.equal(locks.manualInterventionLock, false, 'MIR lock must be released');
  const trace = harness.trace();
  assert.equal(trace[0], 'authority-consumed');
  assert.ok(trace.includes('owner-observe-1'), 'must observe residual tx owner once');
  assert.ok(trace.includes('owner-observe-2'), 'must observe residual tx owner twice dead');
  assert.equal(
    trace.includes('recovery-lock-acquire'),
    false,
    'existing terminal must not newly acquire recovery lock',
  );
  assert.equal(
    trace.includes('post-lock-snapshot'),
    false,
    'existing terminal must not enter post-lock acquisition path',
  );
  assert.deepEqual(harness.lockAcquisitionsForTest(), []);
  assert.deepEqual(harness.recoveryAcquisitionsForTest(), []);
  assertOrderedTxThenMirRelease(trace);
  assert.equal(harness.hasManualRepairAttestation(seeded.confirmationId), true);
  assertPublisherHostUnchanged(harness, hostBefore);
  await assertCapabilityReplayDenied(seeded.capability);
});

test('pure closeout live state equals legal recovered checkpoint appends recovered receipt and ordered lock release', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  createCoordinatorOrRed(harness);

  const seeded = await seedAuthorizedPureCloseoutScenario(harness, {
    hostMode: 'recovered-checkpoint',
    terminal: null,
    confirmationId: 'c6b60002-eeee-4eee-8eee-eeeeeeeeeeee',
    manualRepairRequestId: 'd6b60002-dddd-4ddd-8ddd-dddddddddddd',
  });
  assert.deepEqual(
    harness.journalStates(seeded.mirTransactionId).at(-1),
    'manual-intervention-required',
  );
  assert.equal(harness.receiptFor(seeded.mirTransactionId), null);

  harness.resetObservations();
  harness.armPostLockSnapshotEvent();
  queueFreshRecoveryIds(
    harness,
    'a6b60002-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'b6b60002-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  );
  const hostBefore = harness.sentinels();
  const coordinator = createFullCoordinatorWithAuthoritySentinel(
    harness,
    seeded.capability,
  );

  // Production bug: pure closeout does not append recovered terminal+receipt when
  // live host already equals the legal recovered checkpoint.
  const result = await coordinator.recoverAfterManualRepair(seeded.capability);

  assert.equal(result.state, 'recovered');
  assert.equal(result.success, false);
  assert.equal(result.outcome, 'recovered');
  assert.equal(result.operation, seeded.prefix.operation);
  assert.equal(result.transactionId, seeded.mirTransactionId);
  assert.equal(result.hostMutationCount, seeded.prefix.hostMutationCount);
  assert.equal(result.anchorId, seeded.anchorId);

  const states = harness.journalStates(seeded.mirTransactionId);
  assert.deepEqual(
    states,
    ['prepared', 'compensating', 'manual-intervention-required', 'recovered'],
  );
  const entries = harness.journalEntries(seeded.mirTransactionId);
  const terminal = entries.at(-1);
  assert.equal(terminal.state, 'recovered');
  assert.equal(terminal.payload.hostMutationCount, seeded.prefix.hostMutationCount);
  assert.ok(Object.hasOwn(terminal.payload, 'receipt'), 'must embed exact receipt');
  assert.equal(
    terminal.payload.receiptSha256,
    harness.sha256(Buffer.from(JSON.stringify(terminal.payload.receipt), 'utf8')),
  );

  const receipt = harness.receiptFor(seeded.mirTransactionId);
  assert.ok(receipt);
  assert.equal(receipt.state, 'recovered');
  assert.equal(receipt.success, false);
  assert.equal(receipt.outcome, 'recovered');
  assert.equal(receipt.operation, seeded.prefix.operation);
  assert.equal(receipt.hostMutationCount, seeded.prefix.hostMutationCount);
  assert.deepEqual(receipt, terminal.payload.receipt);

  const locks = harness.lockState();
  assert.equal(locks.transactionLock, false);
  assert.equal(locks.manualInterventionLock, false);
  assertOrderedTxThenMirRelease(harness.trace());
  assert.equal(harness.hasManualRepairAttestation(seeded.confirmationId), true);
  assertPublisherHostUnchanged(harness, hostBefore);
  await assertCapabilityReplayDenied(seeded.capability);
});

test('safe-disabled blocked pure closeout when both jobs unloaded and owned targets exact', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  createCoordinatorOrRed(harness);

  const seeded = await seedAuthorizedPureCloseoutScenario(harness, {
    hostMode: 'safe-disabled',
    terminal: null,
    confirmationId: 'c6b60003-eeee-4eee-8eee-eeeeeeeeeeee',
    manualRepairRequestId: 'd6b60003-dddd-4ddd-8ddd-dddddddddddd',
  });
  // Host fact: both unloaded, owned targets still present.
  const snap = harness.hostSnapshot();
  assert.equal(snap.loaded.controller, false);
  assert.equal(snap.loaded.scheduler, false);
  assert.ok(snap.controller !== null, 'owned controller target must remain present');
  assert.ok(snap.scheduler !== null, 'owned scheduler target must remain present');

  // 证明（非命名）：frozen reversePlan 每个 action 的 live state 均已是 expectedPost，
  // 因此没有任何待执行主机动作（stop-only plan 已完成）。
  const reversePlan = seeded.prefix.reversePlan;
  assert.ok(Array.isArray(reversePlan) && reversePlan.length > 0, 'safe-disabled must carry frozen reversePlan');
  for (const step of reversePlan) {
    const live = harness.liveReversePlanStepState(step.role);
    assert.deepEqual(
      live,
      step.expectedPost,
      `safe-disabled step ${step.index} (${step.action}/${step.role}): live must already equal expectedPost (no pending host action)`,
    );
    assert.notDeepEqual(
      live,
      step.expectedPre,
      `safe-disabled step ${step.index} (${step.action}/${step.role}): live must not remain at expectedPre`,
    );
  }

  harness.resetObservations();
  harness.armPostLockSnapshotEvent();
  queueFreshRecoveryIds(
    harness,
    'a6b60003-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'b6b60003-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  );
  const hostBefore = harness.sentinels();
  const mirHeadSha = seeded.prefix.mirEntrySha256;
  const coordinator = createFullCoordinatorWithAuthoritySentinel(
    harness,
    seeded.capability,
  );

  // Production bug: proven safe-disabled blocked pure closeout not implemented.
  const result = await coordinator.recoverAfterManualRepair(seeded.capability);

  assert.equal(result.state, 'blocked');
  assert.equal(result.success, false);
  assert.equal(result.outcome, 'recovery-required');
  assert.equal(result.operation, seeded.prefix.operation);
  assert.equal(result.transactionId, seeded.mirTransactionId);
  assert.equal(result.hostMutationCount, seeded.prefix.hostMutationCount);

  const states = harness.journalStates(seeded.mirTransactionId);
  assert.deepEqual(
    states,
    ['prepared', 'compensating', 'manual-intervention-required', 'blocked'],
  );
  const terminal = harness.journalEntries(seeded.mirTransactionId).at(-1);
  assert.equal(terminal.state, 'blocked');
  assert.equal(terminal.payload.blockedByEntrySha256, mirHeadSha);
  assert.equal(terminal.payload.hostMutationCount, seeded.prefix.hostMutationCount);
  assert.ok(Object.hasOwn(terminal.payload, 'receipt'));

  const receipt = harness.receiptFor(seeded.mirTransactionId);
  assert.ok(receipt);
  assert.equal(receipt.state, 'blocked');
  assert.equal(receipt.success, false);
  assert.equal(receipt.outcome, 'recovery-required');
  assert.equal(receipt.operation, seeded.prefix.operation);
  assert.equal(receipt.hostMutationCount, seeded.prefix.hostMutationCount);
  assert.deepEqual(receipt, terminal.payload.receipt);

  const locks = harness.lockState();
  assert.equal(locks.transactionLock, false, 'blocked pure closeout must release recovery tx lock');
  assert.equal(locks.manualInterventionLock, false, 'proven-safe blocked must release MIR');
  assertOrderedTxThenMirRelease(harness.trace());
  assert.equal(harness.hasManualRepairAttestation(seeded.confirmationId), true);
  assertPublisherHostUnchanged(harness, hostBefore);
  await assertCapabilityReplayDenied(seeded.capability);
});

/**
 * pending / unknown / invalid-anchor / hash-drift / unmatched：不写 terminal，保留 MIR。
 * post-lock 一致的 pending/unmatched 须 abort 自己的 recovery tx lock（class B）。
 */
async function assertPureCloseoutRetainsMirWithoutTerminal(options) {
  const harness = createLaunchAgentLifecycleHarness();
  createCoordinatorOrRed(harness);

  const seeded = await seedAuthorizedPureCloseoutScenario(harness, {
    hostMode: options.hostMode,
    terminal: null,
    confirmationId: options.confirmationId,
    manualRepairRequestId: options.manualRepairRequestId,
  });
  if (options.assertFixture) options.assertFixture(harness, seeded);
  if (options.mutate) options.mutate(harness, seeded);

  const mirRefBefore = harness.manualInterventionLockRefForTest();
  const statesBefore = harness.journalStates(seeded.mirTransactionId);
  assert.equal(harness.receiptFor(seeded.mirTransactionId), null);

  harness.resetObservations();
  harness.armPostLockSnapshotEvent();
  queueFreshRecoveryIds(harness, options.claimId, options.freshOwnerNonce);
  const hostBefore = harness.sentinels();
  const coordinator = createFullCoordinatorWithAuthoritySentinel(
    harness,
    seeded.capability,
  );

  // Production bug: pure closeout fail-closed for non-closeable live facts is missing.
  let rejected = false;
  try {
    await coordinator.recoverAfterManualRepair(seeded.capability);
  } catch (error) {
    rejected = true;
    assert.ok(
      error instanceof LaunchAgentLifecycleError,
      `${options.name}: must fail closed with LaunchAgentLifecycleError`,
    );
  }

  const statesAfter = harness.journalStates(seeded.mirTransactionId);
  assert.equal(statesAfter.includes('recovered'), false, `${options.name}: no recovered terminal`);
  assert.equal(statesAfter.includes('blocked'), false, `${options.name}: no blocked terminal`);
  assert.equal(harness.receiptFor(seeded.mirTransactionId), null, `${options.name}: no receipt`);
  if (options.name !== 'hash-drift') {
    assert.deepEqual(statesAfter, statesBefore, `${options.name}: journal unchanged`);
  }

  const mirRefAfter = harness.manualInterventionLockRefForTest();
  assert.ok(mirRefAfter, `${options.name}: must retain MIR lock`);
  if (options.name !== 'hash-drift') {
    assert.deepEqual(mirRefAfter, mirRefBefore, `${options.name}: MIR ref exact`);
  }
  assert.equal(harness.lockState().manualInterventionLock, true, `${options.name}: MIR held`);

  if (options.expectAbortRecoveryLock) {
    assert.equal(
      harness.lockState().transactionLock,
      false,
      `${options.name}: must abort own recovery tx lock and retain MIR`,
    );
  }

  // 成功返回 locked 而不 fail-closed，也是 pure-closeout 缺口。
  assert.equal(
    rejected,
    true,
    `${options.name}: production bug — pure closeout must fail closed without terminal`,
  );
  assert.equal(harness.hasManualRepairAttestation(seeded.confirmationId), true);
  assertPublisherHostUnchanged(harness, hostBefore);
  await assertCapabilityReplayDenied(seeded.capability);
}

test('pure closeout pending action retains MIR without terminal', async () => {
  await assertPureCloseoutRetainsMirWithoutTerminal({
    name: 'pending-action',
    hostMode: 'pending-action',
    confirmationId: 'c6b60004-eeee-4eee-8eee-eeeeeeeeeeee',
    manualRepairRequestId: 'd6b60004-dddd-4ddd-8ddd-dddddddddddd',
    claimId: 'a6b60004-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    freshOwnerNonce: 'b6b60004-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    expectAbortRecoveryLock: true,
    // 证明：至少一个 frozen step 的 live 仍匹配 expectedPre（非全部已是 expectedPost）。
    assertFixture: (harness, seeded) => {
      const reversePlan = seeded.prefix.reversePlan;
      assert.ok(Array.isArray(reversePlan) && reversePlan.length > 0);
      let matchingExpectedPre = 0;
      let matchingExpectedPost = 0;
      for (const step of reversePlan) {
        const live = harness.liveReversePlanStepState(step.role);
        if (JSON.stringify(live) === JSON.stringify(step.expectedPre)) {
          matchingExpectedPre += 1;
        }
        if (JSON.stringify(live) === JSON.stringify(step.expectedPost)) {
          matchingExpectedPost += 1;
        }
      }
      assert.ok(
        matchingExpectedPre >= 1,
        'pending-action must have at least one reversePlan step whose live state matches expectedPre',
      );
      assert.notEqual(
        matchingExpectedPost,
        reversePlan.length,
        'pending-action must not have every reversePlan step already at expectedPost',
      );
    },
  });
});

test('pure closeout unmatched checkpoint retains MIR without terminal', async () => {
  await assertPureCloseoutRetainsMirWithoutTerminal({
    name: 'unmatched-checkpoint',
    hostMode: 'unmatched-checkpoint',
    confirmationId: 'c6b60005-eeee-4eee-8eee-eeeeeeeeeeee',
    manualRepairRequestId: 'd6b60005-dddd-4ddd-8ddd-dddddddddddd',
    claimId: 'a6b60005-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    freshOwnerNonce: 'b6b60005-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    expectAbortRecoveryLock: true,
  });
});

test('pure closeout invalid anchor retains MIR without terminal', async () => {
  await assertPureCloseoutRetainsMirWithoutTerminal({
    name: 'invalid-anchor',
    hostMode: 'recovered-checkpoint',
    confirmationId: 'c6b60006-eeee-4eee-8eee-eeeeeeeeeeee',
    manualRepairRequestId: 'd6b60006-dddd-4ddd-8ddd-dddddddddddd',
    claimId: 'a6b60006-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    freshOwnerNonce: 'b6b60006-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    expectAbortRecoveryLock: false,
    mutate: (h, seeded) => {
      h.deleteAnchorFor(seeded.anchorId);
    },
  });
});

test('pure closeout hash drift retains MIR without terminal', async () => {
  await assertPureCloseoutRetainsMirWithoutTerminal({
    name: 'hash-drift',
    hostMode: 'recovered-checkpoint',
    confirmationId: 'c6b60007-eeee-4eee-8eee-eeeeeeeeeeee',
    manualRepairRequestId: 'd6b60007-dddd-4ddd-8ddd-dddddddddddd',
    claimId: 'a6b60007-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    freshOwnerNonce: 'b6b60007-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    expectAbortRecoveryLock: false,
    mutate: (h, seeded) => {
      h.driftMirJournalHeadForTest(seeded.mirTransactionId);
    },
  });
});

// ---------------------------------------------------------------------------
// Task 6 independent-review HOLD RED — class A/B/C + prior-bytes + broken prefix
// + post-receipt revalidation. 真实 coordinator + public capability；零 host mutation。
// Production bug 名写在各 test 内；helper 不得执行成功路径。
// ---------------------------------------------------------------------------

function assertRetainTxAndMir(harness, options = {}) {
  const locks = harness.lockState();
  assert.equal(locks.transactionLock, true, options.txMsg ?? 'must retain recovery tx lock');
  assert.equal(locks.manualInterventionLock, true, options.mirMsg ?? 'must retain MIR lock');
  assert.equal(
    harness.trace().includes('lock-release'),
    false,
    'must not release recovery tx lock',
  );
  assert.equal(
    harness.trace().includes('mir-lock-release'),
    false,
    'must not release MIR lock',
  );
}

function assertRecoveryRequiredRejected(error, label) {
  assert.ok(
    error instanceof LaunchAgentLifecycleError,
    `${label}: must fail closed with LaunchAgentLifecycleError`,
  );
  assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
}

// ---- A: existing terminal+receipt must re-prove recovered/safe-disabled host ----

test('pure closeout existing recovered terminal host drift from anchor retains tx and MIR', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  createCoordinatorOrRed(harness);

  // class A cleanup 前必须再证 live 仍等于 anchor recovered checkpoint；host 漂移不得释锁。
  const residualTxRecord = lockRecord(UUID.mirTx, UUID.txNonce, FIXED_OWNER_PID);
  const seeded = await seedAuthorizedPureCloseoutScenario(harness, {
    hostMode: 'recovered-checkpoint',
    terminal: 'recovered',
    residualTransactionLockRecord: residualTxRecord,
    confirmationId: 'c6b600a1-eeee-4eee-8eee-eeeeeeeeeeee',
    manualRepairRequestId: 'd6b600a1-dddd-4ddd-8ddd-dddddddddddd',
  });
  // host 从 recovered（absent/unloaded）漂移：把 owned target 放回并 reload。
  harness.placeHostBytesForTest('controller', seeded.prefix.controllerBytes);
  harness.seedLoadedJob('controller');
  const snap = harness.hostSnapshot();
  assert.ok(snap.controller !== null, 'fixture: host must have drifted controller present');
  assert.equal(snap.loaded.controller, true, 'fixture: host must have reloaded controller');

  const mirRefBefore = harness.manualInterventionLockRefForTest();
  const txRefBefore = harness.transactionLockRefForTest();
  const statesBefore = harness.journalStates(seeded.mirTransactionId);
  const receiptBefore = harness.receiptFor(seeded.mirTransactionId);

  harness.resetObservations();
  harness.armOwnerObserveStatuses(['dead', 'dead']);
  const hostBefore = harness.sentinels();
  const coordinator = createFullCoordinatorWithAuthoritySentinel(
    harness,
    seeded.capability,
  );

  // Production bug: cleanupExistingExactTerminal ignores host/anchor recovered revalidation.
  let rejected = false;
  try {
    await coordinator.recoverAfterManualRepair(seeded.capability);
  } catch (error) {
    rejected = true;
    assertRecoveryRequiredRejected(error, 'A-recovered-host-drift');
  }
  assert.equal(rejected, true, 'A recovered host drift must fail closed (not cleanup release)');
  assert.deepEqual(
    harness.journalStates(seeded.mirTransactionId),
    statesBefore,
    'must not append/republish terminal',
  );
  assert.deepEqual(
    harness.receiptFor(seeded.mirTransactionId),
    receiptBefore,
    'must not replace existing recovered receipt',
  );
  assertRetainTxAndMir(harness);
  assert.deepEqual(harness.transactionLockRefForTest(), txRefBefore);
  assert.deepEqual(harness.manualInterventionLockRefForTest(), mirRefBefore);
  assert.equal(harness.hasManualRepairAttestation(seeded.confirmationId), true);
  assertPublisherHostUnchanged(harness, hostBefore);
  await assertCapabilityReplayDenied(seeded.capability);
});

test('pure closeout existing blocked terminal job reloaded retains tx and MIR', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  createCoordinatorOrRed(harness);

  const residualTxRecord = lockRecord(UUID.mirTx, UUID.txNonce, FIXED_OWNER_PID);
  const seeded = await seedAuthorizedPureCloseoutScenario(harness, {
    hostMode: 'safe-disabled',
    terminal: 'blocked',
    residualTransactionLockRecord: residualTxRecord,
    confirmationId: 'c6b600a2-eeee-4eee-8eee-eeeeeeeeeeee',
    manualRepairRequestId: 'd6b600a2-dddd-4ddd-8ddd-dddddddddddd',
  });
  // job reload → 不再是 proven safe-disabled；不得 cleanup release。
  harness.seedLoadedJob('scheduler');
  assert.equal(harness.hostSnapshot().loaded.scheduler, true);

  const mirRefBefore = harness.manualInterventionLockRefForTest();
  const txRefBefore = harness.transactionLockRefForTest();
  const statesBefore = harness.journalStates(seeded.mirTransactionId);
  const receiptBefore = harness.receiptFor(seeded.mirTransactionId);

  harness.resetObservations();
  harness.armOwnerObserveStatuses(['dead', 'dead']);
  const hostBefore = harness.sentinels();
  const coordinator = createFullCoordinatorWithAuthoritySentinel(
    harness,
    seeded.capability,
  );

  // Production bug: existing blocked cleanup does not re-prove safe-disabled live facts.
  let rejected = false;
  try {
    await coordinator.recoverAfterManualRepair(seeded.capability);
  } catch (error) {
    rejected = true;
    assertRecoveryRequiredRejected(error, 'A-blocked-job-reload');
  }
  assert.equal(rejected, true, 'A blocked non-safe-disabled must fail closed');
  assert.deepEqual(harness.journalStates(seeded.mirTransactionId), statesBefore);
  assert.deepEqual(harness.receiptFor(seeded.mirTransactionId), receiptBefore);
  assertRetainTxAndMir(harness);
  assert.deepEqual(harness.transactionLockRefForTest(), txRefBefore);
  assert.deepEqual(harness.manualInterventionLockRefForTest(), mirRefBefore);
  assert.equal(harness.hasManualRepairAttestation(seeded.confirmationId), true);
  assertPublisherHostUnchanged(harness, hostBefore);
  await assertCapabilityReplayDenied(seeded.capability);
});

test('pure closeout existing blocked exact safe-disabled still performs terminal cleanup only', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  createCoordinatorOrRed(harness);

  // 对照：existing blocked + exact safe-disabled 仍允许 cleanup-only（A 正向边界）。
  const residualTxRecord = lockRecord(UUID.mirTx, UUID.txNonce, FIXED_OWNER_PID);
  const seeded = await seedAuthorizedPureCloseoutScenario(harness, {
    hostMode: 'safe-disabled',
    terminal: 'blocked',
    residualTransactionLockRecord: residualTxRecord,
    confirmationId: 'c6b600a3-eeee-4eee-8eee-eeeeeeeeeeee',
    manualRepairRequestId: 'd6b600a3-dddd-4ddd-8ddd-dddddddddddd',
  });
  const reversePlan = seeded.prefix.reversePlan;
  for (const step of reversePlan) {
    assert.deepEqual(
      harness.liveReversePlanStepState(step.role),
      step.expectedPost,
      `A3 fixture step ${step.index} must still be exact expectedPost`,
    );
  }
  assert.equal(harness.hostSnapshot().loaded.controller, false);
  assert.equal(harness.hostSnapshot().loaded.scheduler, false);

  const statesBefore = harness.journalStates(seeded.mirTransactionId);
  const receiptBefore = harness.receiptFor(seeded.mirTransactionId);

  harness.resetObservations();
  harness.armOwnerObserveStatuses(['dead', 'dead']);
  const hostBefore = harness.sentinels();
  const coordinator = createFullCoordinatorWithAuthoritySentinel(
    harness,
    seeded.capability,
  );

  const result = await coordinator.recoverAfterManualRepair(seeded.capability);
  assert.equal(result.state, 'blocked');
  assert.equal(result.success, false);
  assert.equal(result.outcome, 'recovery-required');
  assert.deepEqual(harness.journalStates(seeded.mirTransactionId), statesBefore);
  assert.deepEqual(harness.receiptFor(seeded.mirTransactionId), receiptBefore);
  assert.equal(harness.lockState().transactionLock, false);
  assert.equal(harness.lockState().manualInterventionLock, false);
  assertOrderedTxThenMirRelease(harness.trace());
  assert.equal(harness.hasManualRepairAttestation(seeded.confirmationId), true);
  assertPublisherHostUnchanged(harness, hostBefore);
  await assertCapabilityReplayDenied(seeded.capability);
});

// ---- B: foreign global journal head after post-lock exact, before pure classify ----

test('pure closeout post-lock exact foreign journal head pending class C retains both', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  createCoordinatorOrRed(harness);

  const seeded = await seedAuthorizedPureCloseoutScenario(harness, {
    hostMode: 'pending-action',
    terminal: null,
    confirmationId: 'c6b600b1-eeee-4eee-8eee-eeeeeeeeeeee',
    manualRepairRequestId: 'd6b600b1-dddd-4ddd-8ddd-dddddddddddd',
  });
  const mirRefBefore = harness.manualInterventionLockRefForTest();
  const statesBefore = harness.journalStates(seeded.mirTransactionId);
  const foreignTransactionId = 'f6b600b1-0000-4000-8000-0000000000b1';
  const freshOwnerNonce = 'b6b600b1-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  harness.resetObservations();
  harness.armPostLockSnapshotEvent();
  queueFreshRecoveryIds(
    harness,
    'a6b600b1-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    freshOwnerNonce,
  );
  // Task5 post-lock exact 完成后、pure classify/abort 前：首次 inspect 注入 foreign head。
  // post-lock 路径不 inspect host，故 first inspect 恰在 pure closeout classify 窗口。
  let injected = false;
  harness.afterEvent('inspect', () => {
    if (injected) return;
    injected = true;
    harness.seedForeignNonterminalHead({
      transactionId: foreignTransactionId,
      operation: 'install',
      state: 'prepared',
    });
  });
  const hostBefore = harness.sentinels();
  const coordinator = createFullCoordinatorWithAuthoritySentinel(
    harness,
    seeded.capability,
  );

  // Production bug: pending not-pure path aborts own tx without re-checking global
  // journal drift (class C must retain both).
  let rejected = false;
  try {
    await coordinator.recoverAfterManualRepair(seeded.capability);
  } catch (error) {
    rejected = true;
    assertRecoveryRequiredRejected(error, 'B-pending-class-C');
  }
  assert.equal(rejected, true, 'B pending foreign head must fail closed');
  assert.equal(injected, true, 'fixture: foreign head must have been injected');
  assert.deepEqual(
    harness.journalStates(seeded.mirTransactionId),
    statesBefore,
    'pending must not append terminal',
  );
  assert.equal(harness.receiptFor(seeded.mirTransactionId), null);
  assert.deepEqual(
    harness.journalStates(foreignTransactionId),
    ['prepared'],
    'foreign nonterminal head must remain in global journal',
  );
  assertRetainTxAndMir(harness, {
    txMsg: 'class C must retain own recovery tx lock (no abort)',
  });
  const txRef = harness.transactionLockRefForTest();
  assert.ok(txRef, 'class C must keep recovery tx ref');
  assert.equal(txRef.transactionId, seeded.mirTransactionId);
  assert.equal(txRef.ownerNonce, freshOwnerNonce);
  assert.deepEqual(harness.manualInterventionLockRefForTest(), mirRefBefore);
  assert.equal(harness.trace().includes('post-lock-snapshot'), true);
  assert.equal(harness.hasManualRepairAttestation(seeded.confirmationId), true);
  assertPublisherHostUnchanged(harness, hostBefore);
  await assertCapabilityReplayDenied(seeded.capability);
});

test('pure closeout post-lock exact foreign journal head recovered must not append terminal', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  createCoordinatorOrRed(harness);

  const seeded = await seedAuthorizedPureCloseoutScenario(harness, {
    hostMode: 'recovered-checkpoint',
    terminal: null,
    confirmationId: 'c6b600b2-eeee-4eee-8eee-eeeeeeeeeeee',
    manualRepairRequestId: 'd6b600b2-dddd-4ddd-8ddd-dddddddddddd',
  });
  const mirRefBefore = harness.manualInterventionLockRefForTest();
  const statesBefore = harness.journalStates(seeded.mirTransactionId);
  const foreignTransactionId = 'f6b600b2-0000-4000-8000-0000000000b2';
  const freshOwnerNonce = 'b6b600b2-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  harness.resetObservations();
  harness.armPostLockSnapshotEvent();
  queueFreshRecoveryIds(
    harness,
    'a6b600b2-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    freshOwnerNonce,
  );
  let injected = false;
  harness.afterEvent('inspect', () => {
    if (injected) return;
    injected = true;
    harness.seedForeignNonterminalHead({
      transactionId: foreignTransactionId,
      operation: 'install',
      state: 'prepared',
    });
  });
  const hostBefore = harness.sentinels();
  const coordinator = createFullCoordinatorWithAuthoritySentinel(
    harness,
    seeded.capability,
  );

  // Production bug: pure recovered append ignores foreign global journal head after post-lock.
  let rejected = false;
  let result = null;
  try {
    result = await coordinator.recoverAfterManualRepair(seeded.capability);
  } catch (error) {
    rejected = true;
    assertRecoveryRequiredRejected(error, 'B-recovered-foreign-head');
  }
  assert.equal(injected, true, 'fixture: foreign head must have been injected');
  assert.equal(
    harness.journalStates(seeded.mirTransactionId).includes('recovered'),
    false,
    'must not append recovered terminal under foreign global head',
  );
  assert.equal(harness.receiptFor(seeded.mirTransactionId), null, 'must not publish recovered receipt');
  assert.deepEqual(
    harness.journalStates(seeded.mirTransactionId),
    statesBefore,
    'authorized MIR chain must stay at open MIR',
  );
  assert.deepEqual(harness.journalStates(foreignTransactionId), ['prepared']);
  // 不得成功返回 recovered receipt 或 silently locked-with-terminal。
  if (result !== null) {
    assert.notEqual(result.state, 'recovered', 'must not return recovered receipt');
    assert.notEqual(
      result?.kind,
      'manual-repair-recovery-locked',
      'must not return locked after pure recovered attempt with foreign head',
    );
  }
  assert.equal(rejected, true, 'B recovered foreign head must fail closed');
  assertRetainTxAndMir(harness, {
    txMsg: 'class C foreign head must retain recovery tx (no pure closeout release)',
  });
  const txRef = harness.transactionLockRefForTest();
  assert.ok(txRef);
  assert.equal(txRef.ownerNonce, freshOwnerNonce);
  assert.deepEqual(harness.manualInterventionLockRefForTest(), mirRefBefore);
  assert.equal(harness.hasManualRepairAttestation(seeded.confirmationId), true);
  assertPublisherHostUnchanged(harness, hostBefore);
  await assertCapabilityReplayDenied(seeded.capability);
});

// ---- C: safe-disabled plan-all-post but uncovered role (manifest) diverges ----

test('pure closeout safe-disabled plan post with unexpected manifest aborts own tx retains MIR', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  createCoordinatorOrRed(harness);

  const seeded = await seedAuthorizedPureCloseoutScenario(harness, {
    hostMode: 'safe-disabled',
    terminal: null,
    confirmationId: 'c6b600c1-eeee-4eee-8eee-eeeeeeeeeeee',
    manualRepairRequestId: 'd6b600c1-dddd-4ddd-8ddd-dddddddddddd',
  });
  // reversePlan roles 均 expectedPost，但 manifest（final union 未覆盖 role）意外 present。
  for (const step of seeded.prefix.reversePlan) {
    assert.deepEqual(
      harness.liveReversePlanStepState(step.role),
      step.expectedPost,
      'C fixture: every plan step must already be expectedPost',
    );
  }
  assert.equal(harness.hostSnapshot().manifest, null, 'fixture baseline: no manifest');
  harness.placeHostBytesForTest(
    'manifest',
    Buffer.from('{"schemaVersion":1,"unexpectedManifest":true}\n', 'utf8'),
  );
  assert.ok(harness.hostSnapshot().manifest !== null, 'fixture: unexpected manifest present');

  const mirRefBefore = harness.manualInterventionLockRefForTest();
  const statesBefore = harness.journalStates(seeded.mirTransactionId);

  harness.resetObservations();
  harness.armPostLockSnapshotEvent();
  queueFreshRecoveryIds(
    harness,
    'a6b600c1-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'b6b600c1-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  );
  const hostBefore = harness.sentinels();
  const coordinator = createFullCoordinatorWithAuthoritySentinel(
    harness,
    seeded.capability,
  );

  // Production bug: classifyPureCloseoutDisposition treats plan-all-post + unloaded as
  // blocked without verifying controller/scheduler/manifest final union boundary.
  let rejected = false;
  let result = null;
  try {
    result = await coordinator.recoverAfterManualRepair(seeded.capability);
  } catch (error) {
    rejected = true;
    assertRecoveryRequiredRejected(error, 'C-unexpected-manifest');
  }
  assert.equal(
    harness.journalStates(seeded.mirTransactionId).includes('blocked'),
    false,
    'unexpected manifest must not be classified as proven-safe blocked',
  );
  assert.equal(harness.receiptFor(seeded.mirTransactionId), null);
  assert.deepEqual(harness.journalStates(seeded.mirTransactionId), statesBefore);
  if (result !== null) {
    assert.notEqual(result.state, 'blocked', 'must not return blocked receipt');
  }
  assert.equal(rejected, true, 'C must fail closed with RECOVERY_REQUIRED');
  // 原 MIR/global 未变 → class B：abort own tx，MIR 保留。
  assert.equal(
    harness.lockState().transactionLock,
    false,
    'class B: must abort own recovery tx lock',
  );
  assert.equal(harness.lockState().manualInterventionLock, true, 'must retain MIR');
  assert.deepEqual(harness.manualInterventionLockRefForTest(), mirRefBefore);
  assert.equal(harness.trace().includes('mir-lock-release'), false);
  assert.equal(harness.hasManualRepairAttestation(seeded.confirmationId), true);
  assertPublisherHostUnchanged(harness, hostBefore);
  await assertCapabilityReplayDenied(seeded.capability);
});

// ---- D: prior-bytes restored checkpoint → recovered roles restored ----

test('pure closeout prior-bytes restored checkpoint recovered receipt outcomes restored', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  createCoordinatorOrRed(harness);

  const seeded = await seedAuthorizedPureCloseoutScenario(harness, {
    hostMode: 'restored-checkpoint',
    terminal: null,
    confirmationId: 'c6b600d1-eeee-4eee-8eee-eeeeeeeeeeee',
    manualRepairRequestId: 'd6b600d1-dddd-4ddd-8ddd-dddddddddddd',
  });
  const anchor = harness.anchorFor(seeded.anchorId);
  assert.equal(anchor.controller.priorState, 'bytes');
  assert.equal(anchor.scheduler.priorState, 'bytes');
  assert.equal(anchor.manifest.priorState, 'absent');
  assert.equal(anchor.loaded.controller, true);
  assert.equal(anchor.loaded.scheduler, true);
  const snap = harness.hostSnapshot();
  assert.ok(snap.controller !== null);
  assert.ok(snap.scheduler !== null);
  assert.equal(snap.loaded.controller, true);
  assert.equal(snap.loaded.scheduler, true);
  assert.equal(snap.controller.sha256, anchor.controller.sha256);
  assert.equal(snap.scheduler.sha256, anchor.scheduler.sha256);

  harness.resetObservations();
  harness.armPostLockSnapshotEvent();
  queueFreshRecoveryIds(
    harness,
    'a6b600d1-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'b6b600d1-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  );
  const hostBefore = harness.sentinels();
  const coordinator = createFullCoordinatorWithAuthoritySentinel(
    harness,
    seeded.capability,
  );

  // Production bug: pure recovered hardcodes roles outcome removed for both jobs.
  const result = await coordinator.recoverAfterManualRepair(seeded.capability);

  assert.equal(result.state, 'recovered');
  assert.equal(result.success, false);
  assert.equal(result.outcome, 'recovered');
  assert.equal(result.roles.controller.outcome, 'restored');
  assert.equal(result.roles.scheduler.outcome, 'restored');
  assert.equal(result.roles.controller.changed, true);
  assert.equal(result.roles.scheduler.changed, true);

  const receipt = harness.receiptFor(seeded.mirTransactionId);
  assert.ok(receipt);
  assert.equal(receipt.roles.controller.outcome, 'restored');
  assert.equal(receipt.roles.scheduler.outcome, 'restored');
  assert.deepEqual(receipt, result);

  const terminal = harness.journalEntries(seeded.mirTransactionId).at(-1);
  assert.equal(terminal.state, 'recovered');
  assert.equal(terminal.payload.receipt.roles.controller.outcome, 'restored');
  assert.equal(terminal.payload.receipt.roles.scheduler.outcome, 'restored');

  assert.equal(harness.lockState().transactionLock, false);
  assert.equal(harness.lockState().manualInterventionLock, false);
  assertOrderedTxThenMirRelease(harness.trace());
  assert.equal(harness.hasManualRepairAttestation(seeded.confirmationId), true);
  assertPublisherHostUnchanged(harness, hostBefore);
  await assertCapabilityReplayDenied(seeded.capability);
});

// ---- E: broken compensating prefix must RECOVERY_REQUIRED; no-compensating stays locked ----

test('pure closeout broken compensating reversePlan prefix throws RECOVERY_REQUIRED not locked', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  createCoordinatorOrRed(harness);

  const seeded = await seedAuthorizedPureCloseoutScenario(harness, {
    hostMode: 'recovered-checkpoint',
    terminal: null,
    confirmationId: 'c6b600e1-eeee-4eee-8eee-eeeeeeeeeeee',
    manualRepairRequestId: 'd6b600e1-dddd-4ddd-8ddd-dddddddddddd',
  });
  // 链上含 compensating+reversePlan，但 hostMutationCount 非单调 → prefix invalid。
  harness.breakCompensatingPrefixMonotonicityForTest(seeded.mirTransactionId);
  assert.deepEqual(
    harness.journalStates(seeded.mirTransactionId),
    ['prepared', 'compensating', 'manual-intervention-required'],
  );
  const mirRefBefore = harness.manualInterventionLockRefForTest();

  harness.resetObservations();
  harness.armPostLockSnapshotEvent();
  queueFreshRecoveryIds(
    harness,
    'a6b600e1-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'b6b600e1-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  );
  const hostBefore = harness.sentinels();
  const coordinator = createFullCoordinatorWithAuthoritySentinel(
    harness,
    seeded.capability,
  );

  // Production bug: attemptPureCloseoutAfterLock returns null on prefix failure → locked.
  let rejected = false;
  let result = null;
  try {
    result = await coordinator.recoverAfterManualRepair(seeded.capability);
  } catch (error) {
    rejected = true;
    assertRecoveryRequiredRejected(error, 'E-broken-prefix');
  }
  assert.equal(
    result?.kind === 'manual-repair-recovery-locked',
    false,
    'broken compensating prefix must not successfully return locked context',
  );
  assert.equal(rejected, true, 'E broken prefix must throw RECOVERY_REQUIRED');
  assert.equal(
    harness.journalStates(seeded.mirTransactionId).includes('recovered'),
    false,
  );
  assert.equal(harness.receiptFor(seeded.mirTransactionId), null);
  // 不得伪装成功 closeout 释锁；允许 abort own 或 retain both，但禁止 locked 成功返回。
  assert.equal(harness.lockState().manualInterventionLock, true);
  assert.deepEqual(harness.manualInterventionLockRefForTest(), mirRefBefore);
  assert.equal(harness.hasManualRepairAttestation(seeded.confirmationId), true);
  assertPublisherHostUnchanged(harness, hostBefore);
  await assertCapabilityReplayDenied(seeded.capability);
});

test('pure closeout legal MIR without compensating still returns Task5 locked context', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  createCoordinatorOrRed(harness);

  // 合法无 compensating 的 MIR-only chain：Task 5 locked 兼容边界，不得被 E 的 fail-closed 破坏。
  const mirTransactionId = 'f6b600e2-ffff-4fff-8fff-ffffffffffff';
  const anchorId = 'a6b600e2-3333-4333-8333-333333333333';
  const confirmationId = 'c6b600e2-eeee-4eee-8eee-eeeeeeeeeeee';
  const manualRepairRequestId = 'd6b600e2-dddd-4ddd-8ddd-dddddddddddd';
  harness.seedMirHeadAndAnchor({ transactionId: mirTransactionId, anchorId });
  const mirRef = harness.seedManualInterventionLock(
    lockRecord(mirTransactionId, UUID.ownerNonce),
  );
  const { capability } = await mintGenuineCapability({
    mirTransactionId,
    mirLockRef: mirRef,
    transactionLockRef: null,
    anchorId,
    confirmationId,
    manualRepairRequestId,
  });

  harness.resetObservations();
  harness.armPostLockSnapshotEvent();
  queueFreshRecoveryIds(
    harness,
    'a6b600e2-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'b6b600e2-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  );
  const hostBefore = harness.sentinels();
  const coordinator = createFullCoordinatorWithAuthoritySentinel(harness, capability);

  const result = await coordinator.recoverAfterManualRepair(capability);
  assert.equal(result.kind, 'manual-repair-recovery-locked');
  assert.equal(result.mirTransactionId, mirTransactionId);
  assert.equal(harness.lockState().transactionLock, true);
  assert.equal(harness.lockState().manualInterventionLock, true);
  assert.equal(harness.journalStates(mirTransactionId).at(-1), 'manual-intervention-required');
  assert.equal(harness.receiptFor(mirTransactionId), null);
  assert.equal(harness.hasManualRepairAttestation(confirmationId), true);
  assertPublisherHostUnchanged(harness, hostBefore);
  await assertCapabilityReplayDenied(capability);
});

// ---- F: post terminal+receipt, pre lock-release host/anchor drift retains locks ----

test('pure closeout post-receipt host or anchor drift retains tx and MIR', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  createCoordinatorOrRed(harness);

  const seeded = await seedAuthorizedPureCloseoutScenario(harness, {
    hostMode: 'recovered-checkpoint',
    terminal: null,
    confirmationId: 'c6b600f1-eeee-4eee-8eee-eeeeeeeeeeee',
    manualRepairRequestId: 'd6b600f1-dddd-4ddd-8ddd-dddddddddddd',
  });
  const mirRefBefore = harness.manualInterventionLockRefForTest();

  harness.resetObservations();
  harness.armPostLockSnapshotEvent();
  queueFreshRecoveryIds(
    harness,
    'a6b600f1-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'b6b600f1-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  );
  // terminal append+receipt 之后、锁释放之前：窄 afterEvent('receipt') 漂移 anchor。
  // receipt 事件仅在 publishReceipt 成功落盘后触发；production 不得在此窗口无条件释锁。
  let drifted = false;
  harness.afterEvent('receipt', () => {
    if (drifted) return;
    drifted = true;
    harness.deleteAnchorFor(seeded.anchorId);
  });
  const hostBefore = harness.sentinels();
  const coordinator = createFullCoordinatorWithAuthoritySentinel(
    harness,
    seeded.capability,
  );

  // Production bug: pureCloseoutAppendAndRelease re-checks only journal/receipt,
  // not anchor+controlled host, then releases locks.
  let rejected = false;
  try {
    await coordinator.recoverAfterManualRepair(seeded.capability);
  } catch (error) {
    rejected = true;
    assertRecoveryRequiredRejected(error, 'F-post-receipt-drift');
  }
  assert.equal(drifted, true, 'fixture: post-receipt drift must have fired');
  // terminal/receipt 可已存在（崩溃窗口：收据后、锁释放前）。
  const states = harness.journalStates(seeded.mirTransactionId);
  assert.equal(states.includes('recovered'), true, 'terminal may already be appended');
  assert.ok(harness.receiptFor(seeded.mirTransactionId), 'receipt may already be published');
  assert.equal(rejected, true, 'F must fail closed after post-receipt drift');
  assertRetainTxAndMir(harness, {
    txMsg: 'post-receipt drift must not release recovery tx lock',
    mirMsg: 'post-receipt drift must not release MIR lock',
  });
  assert.deepEqual(harness.manualInterventionLockRefForTest(), mirRefBefore);
  assert.equal(harness.hasManualRepairAttestation(seeded.confirmationId), true);
  assertPublisherHostUnchanged(harness, hostBefore);
  await assertCapabilityReplayDenied(seeded.capability);
});

// ---------------------------------------------------------------------------
// Task 6B.1 P0 RED — §6.6 MIR-only terminal cleanup
// 崩溃窗口：tx release 已成功、MIR release 尚未执行。
// journal 已有 exact recovered|blocked terminal + embedded/persisted receipt；
// MIR lock exact 仍在；transaction.lock absent；mint capability 必须绑定
// transactionLockRef:null。正例：只重验 terminal/receipt/evidence/anchor/host，
// 确认 tx absent + MIR exact，然后只 release MIR 并验证双锁 absent。
// 不得 acquire 新 tx、不得 append/republish、不得 owner observe、零 host mutation。
// terminal missing receipt 不在本项（留给 6B.2）。
// ---------------------------------------------------------------------------

/**
 * §6.6 MIR-only：tx 已 absent 时不得出现 lock-release / owner-observe / acquire。
 * 仅允许 mir-lock-release。
 */
function assertMirOnlyTerminalCleanupTrace(trace, label) {
  assert.equal(
    trace.includes('lock-release'),
    false,
    `${label}: must not release already-absent transaction lock`,
  );
  assert.ok(
    trace.includes('mir-lock-release'),
    `${label}: must release MIR lock only`,
  );
  assert.equal(
    trace.includes('owner-observe-1'),
    false,
    `${label}: tx absent must not owner-observe residual tx`,
  );
  assert.equal(
    trace.includes('owner-observe-2'),
    false,
    `${label}: tx absent must not double owner-observe`,
  );
  assert.equal(
    trace.includes('recovery-lock-acquire'),
    false,
    `${label}: must not newly acquire recovery tx lock`,
  );
  assert.equal(
    trace.includes('post-lock-snapshot'),
    false,
    `${label}: must not enter post-lock acquisition path`,
  );
}

test('MIR-only terminal cleanup recovered exact with tx absent releases MIR only', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  createCoordinatorOrRed(harness);

  // §6.6 crash after tx release, before MIR release：
  // exact recovered terminal+receipt + MIR exact + transaction.lock absent。
  // public authorize 必须绑定 transactionLockRef:null（不得绑定 residual tx）。
  const seeded = await seedAuthorizedPureCloseoutScenario(harness, {
    hostMode: 'recovered-checkpoint',
    terminal: 'recovered',
    // 故意不传 residualTransactionLockRecord → transaction.lock absent + bind null
    confirmationId: 'c6b6a001-eeee-4eee-8eee-eeeeeeeeeeee',
    manualRepairRequestId: 'd6b6a001-dddd-4ddd-8ddd-dddddddddddd',
  });
  assert.equal(
    seeded.transactionLockRef,
    null,
    'mint capability must bind transactionLockRef:null',
  );
  assert.equal(
    harness.lockState().transactionLock,
    false,
    'fixture: transaction.lock must be absent',
  );
  assert.equal(
    harness.transactionLockRefForTest(),
    null,
    'fixture: no residual recovery tx ref',
  );
  assert.equal(
    harness.lockState().manualInterventionLock,
    true,
    'fixture: MIR lock must remain exact',
  );
  const mirRefBefore = harness.manualInterventionLockRefForTest();
  assert.deepEqual(mirRefBefore, seeded.mirRef, 'fixture: MIR ref exact');

  const statesBefore = harness.journalStates(seeded.mirTransactionId);
  assert.deepEqual(
    statesBefore.at(-1),
    'recovered',
    'fixture must already end with exact recovered terminal',
  );
  const receiptBefore = harness.receiptFor(seeded.mirTransactionId);
  assert.ok(receiptBefore, 'fixture must include matching persisted receipt');
  assert.equal(receiptBefore.state, 'recovered');
  const terminalBefore = harness.journalEntries(seeded.mirTransactionId).at(-1);
  assert.ok(Object.hasOwn(terminalBefore.payload, 'receipt'), 'embedded receipt required');
  assert.deepEqual(terminalBefore.payload.receipt, receiptBefore);
  const receiptShaBefore = harness.sha256(
    Buffer.from(JSON.stringify(receiptBefore), 'utf8'),
  );

  harness.resetObservations();
  // 禁止 arm owner observe / queue claimId / post-lock：不得走 residual-tx 或 acquisition 路径。
  const hostBefore = harness.sentinels();
  const coordinator = createFullCoordinatorWithAuthoritySentinel(
    harness,
    seeded.capability,
  );

  // Production bug: existing terminal cleanup requires residual tx lock and rejects
  // transactionLockRef:null; §6.6 MIR-only path (tx already released) is missing —
  // must re-verify terminal/receipt/evidence/anchor/host, confirm tx absent + MIR exact,
  // then release MIR only without acquire/append/republish/owner-observe.
  const result = await coordinator.recoverAfterManualRepair(seeded.capability);

  assert.equal(result.state, 'recovered');
  assert.equal(result.success, false);
  assert.equal(result.outcome, 'recovered');
  assert.equal(result.operation, seeded.prefix.operation);
  assert.equal(result.transactionId, seeded.mirTransactionId);

  const statesAfter = harness.journalStates(seeded.mirTransactionId);
  assert.deepEqual(
    statesAfter,
    statesBefore,
    'MIR-only cleanup must not append another terminal',
  );
  const recoveredCount = statesAfter.filter((state) => state === 'recovered').length;
  assert.equal(recoveredCount, 1, 'must keep exactly one recovered terminal');
  const receiptAfter = harness.receiptFor(seeded.mirTransactionId);
  assert.deepEqual(receiptAfter, receiptBefore, 'must not republish/replace receipt');
  assert.equal(
    harness.sha256(Buffer.from(JSON.stringify(receiptAfter), 'utf8')),
    receiptShaBefore,
  );

  const locks = harness.lockState();
  assert.equal(locks.transactionLock, false, 'transaction.lock must remain/finish absent');
  assert.equal(locks.manualInterventionLock, false, 'MIR lock must be released');
  const trace = harness.trace();
  assert.equal(trace[0], 'authority-consumed');
  assertMirOnlyTerminalCleanupTrace(trace, 'recovered-tx-absent');
  assert.deepEqual(harness.lockAcquisitionsForTest(), []);
  assert.deepEqual(harness.recoveryAcquisitionsForTest(), []);
  assert.equal(harness.hasManualRepairAttestation(seeded.confirmationId), true);
  assertPublisherHostUnchanged(harness, hostBefore);
  await assertCapabilityReplayDenied(seeded.capability);
});

test('MIR-only terminal cleanup blocked exact safe-disabled with tx absent releases MIR only', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  createCoordinatorOrRed(harness);

  // 对照正例：existing blocked + exact safe-disabled + tx absent → 同样只释 MIR。
  const seeded = await seedAuthorizedPureCloseoutScenario(harness, {
    hostMode: 'safe-disabled',
    terminal: 'blocked',
    confirmationId: 'c6b6a002-eeee-4eee-8eee-eeeeeeeeeeee',
    manualRepairRequestId: 'd6b6a002-dddd-4ddd-8ddd-dddddddddddd',
  });
  assert.equal(seeded.transactionLockRef, null, 'mint must bind transactionLockRef:null');
  assert.equal(harness.lockState().transactionLock, false, 'fixture: tx lock absent');
  assert.equal(harness.transactionLockRefForTest(), null);
  assert.equal(harness.lockState().manualInterventionLock, true, 'fixture: MIR held');

  const reversePlan = seeded.prefix.reversePlan;
  assert.ok(Array.isArray(reversePlan) && reversePlan.length > 0);
  for (const step of reversePlan) {
    assert.deepEqual(
      harness.liveReversePlanStepState(step.role),
      step.expectedPost,
      `safe-disabled step ${step.index} must remain exact expectedPost`,
    );
  }
  assert.equal(harness.hostSnapshot().loaded.controller, false);
  assert.equal(harness.hostSnapshot().loaded.scheduler, false);

  const statesBefore = harness.journalStates(seeded.mirTransactionId);
  assert.deepEqual(statesBefore.at(-1), 'blocked');
  const receiptBefore = harness.receiptFor(seeded.mirTransactionId);
  assert.ok(receiptBefore);
  assert.equal(receiptBefore.state, 'blocked');
  assert.equal(receiptBefore.outcome, 'recovery-required');
  const terminalBefore = harness.journalEntries(seeded.mirTransactionId).at(-1);
  assert.ok(Object.hasOwn(terminalBefore.payload, 'receipt'));
  assert.deepEqual(terminalBefore.payload.receipt, receiptBefore);

  harness.resetObservations();
  const hostBefore = harness.sentinels();
  const coordinator = createFullCoordinatorWithAuthoritySentinel(
    harness,
    seeded.capability,
  );

  // Production bug: blocked exact safe-disabled terminal cleanup also rejects
  // transactionLockRef:null; §6.6 MIR-only release path is missing.
  const result = await coordinator.recoverAfterManualRepair(seeded.capability);

  assert.equal(result.state, 'blocked');
  assert.equal(result.success, false);
  assert.equal(result.outcome, 'recovery-required');
  assert.equal(result.operation, seeded.prefix.operation);
  assert.equal(result.transactionId, seeded.mirTransactionId);
  assert.deepEqual(
    harness.journalStates(seeded.mirTransactionId),
    statesBefore,
    'must not append/republish blocked terminal',
  );
  assert.deepEqual(
    harness.receiptFor(seeded.mirTransactionId),
    receiptBefore,
    'must not replace blocked receipt',
  );

  const locks = harness.lockState();
  assert.equal(locks.transactionLock, false, 'tx must remain absent');
  assert.equal(locks.manualInterventionLock, false, 'MIR must be released');
  const trace = harness.trace();
  assert.equal(trace[0], 'authority-consumed');
  assertMirOnlyTerminalCleanupTrace(trace, 'blocked-safe-disabled-tx-absent');
  assert.deepEqual(harness.lockAcquisitionsForTest(), []);
  assert.deepEqual(harness.recoveryAcquisitionsForTest(), []);
  assert.equal(harness.hasManualRepairAttestation(seeded.confirmationId), true);
  assertPublisherHostUnchanged(harness, hostBefore);
  await assertCapabilityReplayDenied(seeded.capability);
});

test('MIR-only terminal cleanup recovered host drift with tx absent retains MIR', async () => {
  const harness = createLaunchAgentLifecycleHarness();
  createCoordinatorOrRed(harness);

  // 负例：tx absent + recovered terminal + host 已从 anchor recovered checkpoint 漂移
  // → 必须 RECOVERY_REQUIRED，保留 MIR，无任何锁释放（含不得 acquire 新 tx）。
  const seeded = await seedAuthorizedPureCloseoutScenario(harness, {
    hostMode: 'recovered-checkpoint',
    terminal: 'recovered',
    confirmationId: 'c6b6a003-eeee-4eee-8eee-eeeeeeeeeeee',
    manualRepairRequestId: 'd6b6a003-dddd-4ddd-8ddd-dddddddddddd',
  });
  assert.equal(seeded.transactionLockRef, null, 'mint must bind transactionLockRef:null');
  assert.equal(harness.lockState().transactionLock, false, 'fixture: tx absent');
  assert.equal(harness.transactionLockRefForTest(), null);

  // host 从 recovered（absent/unloaded）漂移：owned target 放回并 reload。
  harness.placeHostBytesForTest('controller', seeded.prefix.controllerBytes);
  harness.seedLoadedJob('controller');
  const snap = harness.hostSnapshot();
  assert.ok(snap.controller !== null, 'fixture: host must have drifted controller present');
  assert.equal(snap.loaded.controller, true, 'fixture: host must have reloaded controller');

  const mirRefBefore = harness.manualInterventionLockRefForTest();
  assert.ok(mirRefBefore, 'fixture: MIR must be present before recover');
  const statesBefore = harness.journalStates(seeded.mirTransactionId);
  const receiptBefore = harness.receiptFor(seeded.mirTransactionId);
  assert.ok(receiptBefore);

  harness.resetObservations();
  const hostBefore = harness.sentinels();
  const coordinator = createFullCoordinatorWithAuthoritySentinel(
    harness,
    seeded.capability,
  );

  // Production bug surface for GREEN path is MIR-only success; this negative still
  // requires fail-closed RECOVERY_REQUIRED with MIR retained and zero lock release
  // when re-proving recovered host fails (tx already absent).
  let rejected = false;
  try {
    await coordinator.recoverAfterManualRepair(seeded.capability);
  } catch (error) {
    rejected = true;
    assertRecoveryRequiredRejected(error, 'MIR-only-recovered-host-drift');
  }
  assert.equal(
    rejected,
    true,
    'MIR-only recovered host drift must fail closed (not release MIR)',
  );
  assert.deepEqual(
    harness.journalStates(seeded.mirTransactionId),
    statesBefore,
    'must not append/republish terminal',
  );
  assert.deepEqual(
    harness.receiptFor(seeded.mirTransactionId),
    receiptBefore,
    'must not replace existing recovered receipt',
  );

  // tx was already absent — must stay absent; MIR must be retained exact.
  assert.equal(harness.lockState().transactionLock, false, 'tx must remain absent');
  assert.equal(harness.lockState().manualInterventionLock, true, 'must retain MIR lock');
  assert.deepEqual(
    harness.manualInterventionLockRefForTest(),
    mirRefBefore,
    'MIR ref must stay exact',
  );
  const trace = harness.trace();
  assert.equal(trace.includes('lock-release'), false, 'must not release tx lock');
  assert.equal(trace.includes('mir-lock-release'), false, 'must not release MIR lock');
  assert.equal(trace.includes('recovery-lock-acquire'), false, 'must not acquire new tx');
  assert.equal(trace.includes('owner-observe-1'), false, 'must not owner-observe');
  assert.equal(trace.includes('owner-observe-2'), false, 'must not owner-observe twice');
  assert.deepEqual(harness.lockAcquisitionsForTest(), []);
  assert.deepEqual(harness.recoveryAcquisitionsForTest(), []);
  assert.equal(harness.hasManualRepairAttestation(seeded.confirmationId), true);
  assertPublisherHostUnchanged(harness, hostBefore);
  await assertCapabilityReplayDenied(seeded.capability);
});

// ---------------------------------------------------------------------------
// V1.46 Task 6B.2 Task 1A RED — frozen manual compensation crash-position matrix.
//
// Fixture 真实性：每个 case 先运行真实 coordinator（install / managed-upgrade +
// before-commit revalidation failure），由生产自身 persist contracts-valid
// compensating.payload.reversePlan + reversePlanSha256；crash image 在
// intent-before / intent-persisted-pre / mutation-post 三个崩溃点捕获；
// MIR journal 经真实 metadataStore surface（appendJournal + MIR release）从该
// persisted result 成形，MIR lock 经 harness seed seam 放置。禁止手写 reverse plan。
//
// 每个有效崩溃位 case 表达未来 frozen-plan resume 语义（当前 production 不实现 →
// 全部 RED）：绝大多数位点在 authorized manual path 上 classify 为 not-pure →
// abort 自己 recovery lock → 拒绝 recovery-required；唯一例外是 install 末位 action
// remove-controller 的 after-action-post 位——production 走 pure-closeout 直接追加
// recovered，遗漏 current completed pair 闭合，由 exact journal-pair assertion
// 形成该位点的独立 RED。unknown live-state guard 必须 fail closed，
// 只允许公共 authority 前导（attestation clock + own recovery lock acquire/abort），
// 不得有 compensation host mutation / original-transaction journal / receipt 变化。
// malformed-chain 拒绝矩阵属于 Task 1B，不在本块。
// ---------------------------------------------------------------------------

const FROZEN_COMMIT_PRIOR = 'a'.repeat(40);
const FROZEN_COMMIT_NEXT = 'b'.repeat(40);
const TS_FROZEN_MIR = '2026-08-02T13:00:00.000Z';

/** 生产 buildReversePlan 的已知 plan 顺序；fixture 会再用 persisted plan 精确核对。 */
const FROZEN_PLAN_ACTION_ORDER = Object.freeze({
  install: Object.freeze([
    'stop-scheduler',
    'stop-controller',
    'remove-manifest',
    'remove-scheduler',
    'remove-controller',
  ]),
  'managed-upgrade': Object.freeze([
    'stop-scheduler',
    'stop-controller',
    'restore-manifest',
    'restore-scheduler',
    'restore-controller',
    'load-controller',
    'load-scheduler',
  ]),
});

/** 每个 reachable action 选定的来源 operation（stop-* 两 plan 可达，取 managed-upgrade）。 */
const FROZEN_CASE_OPERATION = Object.freeze({
  'stop-scheduler': 'managed-upgrade',
  'stop-controller': 'managed-upgrade',
  'remove-manifest': 'install',
  'remove-scheduler': 'install',
  'remove-controller': 'install',
  'restore-manifest': 'managed-upgrade',
  'restore-scheduler': 'managed-upgrade',
  'restore-controller': 'managed-upgrade',
  'load-controller': 'managed-upgrade',
  'load-scheduler': 'managed-upgrade',
});

const FROZEN_CRASH_POSITIONS = Object.freeze([
  'before-intent',
  'after-intent-pre',
  'after-action-post',
]);

const FROZEN_COMPENSATION_CASES = Object.freeze(
  Object.entries(FROZEN_CASE_OPERATION).flatMap(([action, operation]) => (
    FROZEN_CRASH_POSITIONS.map((position) => Object.freeze({ action, operation, position }))
  )),
);

const FROZEN_UNKNOWN_ROW = Object.freeze({
  action: 'restore-controller',
  operation: 'managed-upgrade',
  position: 'after-intent-pre',
});

function frozenInstallInput() {
  return {
    sourceCommit: FROZEN_COMMIT_PRIOR,
    scheduleSeconds: 300,
    controllerEnvironment: {},
  };
}

function frozenUpgradeInput() {
  return {
    sourceCommit: FROZEN_COMMIT_NEXT,
    scheduleSeconds: 600,
    controllerEnvironment: { PORT: '9090' },
  };
}

function frozenCaseIds(n) {
  const pad4 = String(n).padStart(4, '0');
  const pad12 = String(n).padStart(12, '0');
  return Object.freeze({
    claimId: `6b2a${pad4}-aaaa-4aaa-8aaa-${pad12}`,
    freshOwnerNonce: `6b2b${pad4}-bbbb-4bbb-8bbb-${pad12}`,
    confirmationId: `6b2c${pad4}-eeee-4eee-8eee-${pad12}`,
    requestId: `6b2d${pad4}-dddd-4ddd-8ddd-${pad12}`,
    mirNonce: `6b2e${pad4}-eeee-4eee-8eee-${pad12}`,
  });
}

/** 与生产 journalEntrySha256 同一 canonical subset；仅用于成形 MIR entry。 */
function frozenJournalEntrySha256(entry) {
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

function countFrozenEvent(trace, name) {
  return trace.filter((event) => event === name).length;
}

const FROZEN_ACTION_VERB = Object.freeze({
  stop: 'bootout',
  remove: 'remove',
  restore: 'publish',
  load: 'bootstrap',
});

function frozenVerbFor(action) {
  const verb = FROZEN_ACTION_VERB[action.split('-')[0]];
  if (verb === undefined) throw new Error(`unsupported frozen action: ${action}`);
  return verb;
}

/** 当前 compensation action 的宿主 side-effect trace event（不直接统计 semantic 名）。 */
function frozenHostEventFor(action) {
  return `${frozenVerbFor(action)}-${action.split('-')[1]}`;
}

/** 与生产 restoredBefore 同规则：role 在 position 之前是否已被 restore（inode 放宽）。 */
function frozenRestoredBefore(plan, role, position) {
  return plan.some((step) => (
    step.role === role && step.action.startsWith('restore-') && step.index < position
  ));
}

/**
 * 崩溃位 live state 必须精确等于 frozen step 的 expectedPre/expectedPost
 * （inodeExact 规则与生产 matchExpectedLive 一致：restored-before 的 role 只比对
 * device/sha256/bytes + job，其余逐字段 deepEqual）。
 */
function assertFrozenLiveMatches(harness, plan, step, which) {
  const expected = step[which];
  const inodeExact = !frozenRestoredBefore(
    plan,
    step.role,
    which === 'expectedPost' ? step.index + 1 : step.index,
  );
  const live = harness.liveReversePlanStepState(step.role);
  if (expected.file.state === 'absent') {
    assert.equal(live.file.state, 'absent', `${step.action}/${which}: live file must be absent`);
  } else {
    assert.equal(live.file.state, 'present', `${step.action}/${which}: live file must be present`);
    assert.equal(live.file.sha256, expected.file.sha256, `${step.action}/${which}: live sha256`);
    assert.equal(
      harness.sha256(harness.fileBytes(step.role)),
      expected.file.sha256,
      `${step.action}/${which}: live bytes sha256`,
    );
    if (inodeExact) {
      assert.deepEqual(
        live.file,
        expected.file,
        `${step.action}/${which}: live file identity must be exact`,
      );
    } else {
      assert.equal(live.file.identity.device, expected.file.identity.device);
      assert.equal(
        typeof live.file.identity.inode,
        'string',
        `${step.action}/${which}: restored file carries a fresh inode`,
      );
    }
  }
  assert.deepEqual(live.job, expected.job, `${step.action}/${which}: live job must be exact`);
}

function frozenCrashSelector(row, planIndex, planOrder) {
  if (row.position === 'before-intent') {
    return {
      kind: 'journal-state',
      state: planIndex === 0
        ? 'compensating'
        : `compensate-${planOrder[planIndex - 1]}-completed`,
      occurrence: 1,
    };
  }
  if (row.position === 'after-intent-pre') {
    return { kind: 'journal-state', state: `compensate-${row.action}-intent`, occurrence: 1 };
  }
  if (row.position === 'after-action-post') {
    return { kind: 'host-mutation', action: row.action, occurrence: 1 };
  }
  throw new Error(`unsupported frozen crash position: ${row.position}`);
}

/** 运行真实 coordinator 到 recovered，读取生产自身 persisted 的 frozen plan actions。 */
async function persistedFrozenPlanActions(operation) {
  const harness = createLaunchAgentLifecycleHarness();
  if (operation === 'managed-upgrade') {
    harness.seedInstalled({
      sourceCommit: FROZEN_COMMIT_PRIOR,
      loaded: { controller: true, scheduler: true },
    });
    harness.resetObservations();
  }
  harness.failNextRevalidation('before-commit');
  const coordinator = createLaunchAgentLifecycleCoordinator(harness.dependencies());
  const receipt = validateLaunchAgentReceipt(operation === 'managed-upgrade'
    ? await coordinator.managedUpgrade(frozenUpgradeInput())
    : await coordinator.install(frozenInstallInput()));
  assert.equal(receipt.state, 'recovered', 'uninterrupted run must close recovered');
  const frozen = harness.journalEntries(receipt.transactionId)
    .find((entry) => entry.state === 'compensating');
  assert.ok(frozen, 'real coordinator must persist its own compensating entry');
  assert.ok(Array.isArray(frozen.payload.reversePlan) && frozen.payload.reversePlan.length > 0);
  assert.equal(
    frozen.payload.reversePlanSha256,
    harness.sha256(Buffer.from(JSON.stringify(frozen.payload.reversePlan), 'utf8')),
    'persisted plan must be hash-bound',
  );
  return frozen.payload.reversePlan.map((step) => step.action);
}

/**
 * 单个崩溃位 fixture：真实 coordinator persist frozen plan → crash image → revive →
 * 经真实 metadataStore surface 追加 MIR entry（writer lock 取自 image）→ seed MIR lock →
 * MIR release 原 tx → mint genuine capability（transactionLockRef:null）→ arm/queue。
 * 返回驱动 recoverAfterManualRepair 所需的全部 exact 观测锚点。
 */
async function buildFrozenCompensationFixture(row, caseNumber) {
  const planOrder = FROZEN_PLAN_ACTION_ORDER[row.operation];
  const planIndex = planOrder.indexOf(row.action);
  assert.ok(planIndex !== -1, `${row.action}: unknown plan action`);

  // 1) 真实 coordinator 运行到自身 persist compensating plan；crash capture 于崩溃位。
  const runHarness = createLaunchAgentLifecycleHarness();
  if (row.operation === 'managed-upgrade') {
    runHarness.seedInstalled({
      sourceCommit: FROZEN_COMMIT_PRIOR,
      loaded: { controller: true, scheduler: true },
    });
    runHarness.resetObservations();
  } else if (row.operation !== 'install') {
    throw new Error(`unsupported frozen fixture operation: ${row.operation}`);
  }
  runHarness.failNextRevalidation('before-commit');
  runHarness.armCrashCapture(frozenCrashSelector(row, planIndex, planOrder));
  const runCoordinator = createLaunchAgentLifecycleCoordinator(runHarness.dependencies());
  const runReceipt = validateLaunchAgentReceipt(row.operation === 'managed-upgrade'
    ? await runCoordinator.managedUpgrade(frozenUpgradeInput())
    : await runCoordinator.install(frozenInstallInput()));
  assert.equal(runReceipt.state, 'recovered', 'fixture: uninterrupted run must close recovered');
  const transactionId = runReceipt.transactionId;
  const image = runHarness.takeCrashImage();

  // 2) 从 persisted result 成形 crash image；step 一律从 persisted plan 派生并核对。
  const harness = createLaunchAgentLifecycleHarness({ crashImage: image });
  const crashEntries = harness.journalEntries(transactionId);
  const frozen = crashEntries.find((entry) => entry.state === 'compensating');
  assert.ok(frozen, 'fixture: persisted compensating entry must exist');
  assert.ok(Array.isArray(frozen.payload.reversePlan) && frozen.payload.reversePlan.length > 0);
  const frozenHash = frozen.payload.reversePlanSha256;
  assert.equal(
    frozenHash,
    harness.sha256(Buffer.from(JSON.stringify(frozen.payload.reversePlan), 'utf8')),
    'fixture: persisted reversePlan must match persisted reversePlanSha256',
  );
  assert.deepEqual(
    frozen.payload.reversePlan.map((step) => step.action),
    planOrder,
    'fixture: persisted plan action order must equal the production plan order',
  );
  const plan = frozen.payload.reversePlan;
  const step = plan.find((candidate) => candidate.action === row.action);
  assert.ok(step, `${row.action}: persisted plan must contain the exact selected step`);
  assert.deepEqual(plan[step.index], step, `${row.action}: plan[index] must be the exact step`);
  assert.equal(step.index, planIndex, `${row.action}: persisted plan index`);

  // 3) 崩溃位形状与 live state 证明（fixture validity，先于任何 recovery 驱动）。
  const crashHead = crashEntries.at(-1);
  if (row.position === 'before-intent') {
    assert.equal(
      crashHead.state,
      planIndex === 0 ? 'compensating' : `compensate-${planOrder[planIndex - 1]}-completed`,
      `${row.action}/before-intent: crash head must be the prior completed step`,
    );
    assertFrozenLiveMatches(harness, plan, step, 'expectedPre');
  } else if (row.position === 'after-intent-pre') {
    assert.equal(crashHead.state, `compensate-${row.action}-intent`);
    assert.equal(crashHead.payload.action, row.action);
    assert.equal(crashHead.payload.planIndex, step.index);
    assert.equal(crashHead.payload.reversePlanSha256, frozenHash);
    assertFrozenLiveMatches(harness, plan, step, 'expectedPre');
  } else {
    assert.equal(crashHead.state, `compensate-${row.action}-intent`);
    assert.equal(crashHead.payload.action, row.action);
    assert.equal(crashHead.payload.planIndex, step.index);
    assert.equal(crashHead.payload.reversePlanSha256, frozenHash);
    assertFrozenLiveMatches(harness, plan, step, 'expectedPost');
    assert.equal(
      crashEntries.some((entry) => entry.state === `compensate-${row.action}-completed`),
      false,
      `${row.action}/after-action-post: current completed entry must be absent`,
    );
  }

  // 4) MIR journal 成形：经真实 appendJournal（writer = image tx lock），hmc 镜像
  // 生产 enterManualIntervention 记账（post 位 mutation 已计入 context）。
  const imageTxLockRef = {
    kind: 'transaction-lock',
    transactionId: image.transactionLock.transactionId,
    ownerNonce: image.transactionLock.ownerNonce,
    sha256: harness.sha256(Buffer.from(JSON.stringify(image.transactionLock), 'utf8')),
  };
  const mirEntry = {
    schemaVersion: 1,
    transactionId,
    sequence: crashHead.sequence + 1,
    previousEntrySha256: crashHead.entrySha256,
    operation: row.operation,
    state: 'manual-intervention-required',
    at: TS_FROZEN_MIR,
    payload: {
      hostMutationCount: crashHead.payload.hostMutationCount
        + (row.position === 'after-action-post' ? 1 : 0),
    },
  };
  mirEntry.entrySha256 = frozenJournalEntrySha256(mirEntry);
  validateLaunchAgentJournal(mirEntry);
  await harness.dependencies().metadataStore.appendJournal({
    entry: mirEntry,
    expectedPrior: {
      transactionId,
      sequence: crashHead.sequence,
      entrySha256: crashHead.entrySha256,
    },
    writerLockRef: imageTxLockRef,
  });
  assert.deepEqual(
    harness.journalStates(transactionId),
    [...crashEntries.map((entry) => entry.state), 'manual-intervention-required'],
    'fixture: MIR must follow the crash-position entries',
  );

  // 5) MIR lock + MIR release 原 tx（生产 MIR handoff 的 durable 终态）。
  const ids = frozenCaseIds(caseNumber);
  const mirRef = harness.seedManualInterventionLock(lockRecord(transactionId, ids.mirNonce));
  await harness.dependencies().metadataStore.releaseTransactionLock(imageTxLockRef, {
    manualInterventionLockRef: mirRef,
  });
  assert.deepEqual(
    harness.lockState(),
    { transactionLock: false, manualInterventionLock: true },
    'fixture: MIR handoff must leave MIR held and tx absent',
  );

  // 6) public authorize 铸造 genuine capability；tx 已 absent → 绑定 null。
  const anchor = harness.anchorsWritten().find((candidate) => (
    candidate.transactionId === transactionId
  ));
  assert.ok(anchor, 'fixture: operation anchor must be persisted');
  const { capability, confirmationId } = await mintGenuineCapability({
    mirTransactionId: transactionId,
    mirLockRef: mirRef,
    transactionLockRef: null,
    anchorId: anchor.anchorId,
    confirmationId: ids.confirmationId,
    manualRepairRequestId: ids.requestId,
  });

  harness.resetObservations();
  harness.armPostLockSnapshotEvent();
  harness.queueClockIds([ids.claimId, ids.freshOwnerNonce]);
  const hostBefore = harness.sentinels();
  const clockBefore = harness.clockCallCountsForTest();

  return {
    row,
    harness,
    capability,
    confirmationId,
    transactionId,
    anchorId: anchor.anchorId,
    plan,
    step,
    frozenHash,
    crashEntries,
    mirEntry,
    mirRef,
    runReceipt,
    ids,
    hostBefore,
    clockBefore,
  };
}

/** 未来 frozen-plan resume 语义（当前 production 不实现 → 全部 RED）。 */
async function assertFrozenResumeResult(fixture, result) {
  const {
    row,
    harness,
    transactionId,
    anchorId,
    plan,
    step,
    frozenHash,
    crashEntries,
    mirEntry,
    runReceipt,
    ids,
    hostBefore,
    clockBefore,
  } = fixture;

  // recovered receipt 身份与记账：与不间断 recovered run 完全同一 transaction/anchor/
  // sourceCommit/hostMutationCount（mutation 是物理事件，resume 不得重复或遗漏计数）。
  assert.equal(result.state, 'recovered');
  assert.equal(result.success, false);
  assert.equal(result.outcome, 'recovered');
  assert.equal(result.operation, row.operation);
  assert.equal(result.transactionId, transactionId);
  assert.equal(result.sourceCommit, runReceipt.sourceCommit);
  assert.equal(result.anchorId, anchorId);
  assert.equal(
    result.hostMutationCount,
    runReceipt.hostMutationCount,
    'resume must account exactly the mutations of the uninterrupted recovered run',
  );
  const expectedRoleOutcome = row.operation === 'install' ? 'removed' : 'restored';
  assert.equal(result.roles.controller.outcome, expectedRoleOutcome);
  assert.equal(result.roles.scheduler.outcome, expectedRoleOutcome);
  assert.equal(result.roles.controller.changed, true);
  assert.equal(result.roles.scheduler.changed, true);
  assert.equal(typeof result.completedAt, 'string');

  // original-transaction journal + MIR entry 逐字节保留；resume 只向后追加。
  const entries = harness.journalEntries(transactionId);
  const preservedPrefix = [...crashEntries, mirEntry];
  assert.deepEqual(
    entries.slice(0, preservedPrefix.length),
    preservedPrefix,
    'original crash-position entries and the MIR entry must be preserved exact',
  );
  const appended = entries.slice(preservedPrefix.length);
  const expectedAppendedStates = [];
  if (row.position !== 'before-intent') {
    // intent 已持久化：只补 current completed（pre 位恰好执行一次；post 位只补账不重放）。
    expectedAppendedStates.push(`compensate-${step.action}-completed`);
  }
  for (const remaining of plan.slice(row.position === 'before-intent' ? step.index : step.index + 1)) {
    expectedAppendedStates.push(`compensate-${remaining.action}-intent`);
    expectedAppendedStates.push(`compensate-${remaining.action}-completed`);
  }
  expectedAppendedStates.push('recovered');
  assert.deepEqual(
    appended.map((entry) => entry.state),
    expectedAppendedStates,
    'resume must append current completed then the remaining frozen pairs in plan order',
  );

  // frozen plan 连续性：全 journal 仅一个 compensating、一个 plan hash；追加 intent 全部
  // 绑定 frozen hash 与 planIndex。
  const compensatingEntries = entries.filter((entry) => entry.state === 'compensating');
  assert.equal(compensatingEntries.length, 1, 'must not append a second compensating entry');
  assert.equal(compensatingEntries[0].payload.reversePlanSha256, frozenHash);
  for (const intent of appended.filter((entry) => entry.state.endsWith('-intent'))) {
    const intentStep = plan[intent.payload.planIndex];
    assert.ok(intentStep, 'appended intent must reference a frozen plan index');
    assert.equal(intent.state, `compensate-${intentStep.action}-intent`);
    assert.equal(intent.payload.action, intentStep.action);
    assert.equal(intent.payload.reversePlanSha256, frozenHash);
  }

  // terminal + receipt：append 一次、publish 一次、embedded 与持久化逐字节一致。
  const terminal = entries.at(-1);
  assert.equal(terminal.state, 'recovered');
  assert.ok(Object.hasOwn(terminal.payload, 'receipt'), 'terminal must embed the receipt');
  assert.deepEqual(terminal.payload.receipt, result);
  assert.equal(
    terminal.payload.receiptSha256,
    harness.sha256(Buffer.from(JSON.stringify(terminal.payload.receipt), 'utf8')),
  );
  assert.deepEqual(
    harness.receiptFor(transactionId),
    result,
    'must publish exactly the returned recovered receipt',
  );
  assert.equal(
    countFrozenEvent(harness.trace(), 'receipt'),
    1,
    'must publish the receipt exactly once',
  );

  // host 收敛到 anchor 恢复目标：install → owned 目标全移除且 unloaded；
  // managed-upgrade → prior bytes 精确恢复且 jobs loaded 绑定文件 sha。
  const snap = harness.hostSnapshot();
  if (row.operation === 'install') {
    assert.equal(snap.controller, null, 'install resume must remove controller');
    assert.equal(snap.scheduler, null, 'install resume must remove scheduler');
    assert.equal(snap.manifest, null, 'install resume must remove manifest');
    assert.deepEqual(snap.loaded, { controller: false, scheduler: false });
    assert.deepEqual(snap.jobIdentity, { controller: null, scheduler: null });
  } else {
    const anchor = harness.anchorFor(anchorId);
    for (const role of ['controller', 'scheduler', 'manifest']) {
      assert.ok(snap[role] !== null, `${role} must be restored`);
      assert.equal(snap[role].sha256, anchor[role].sha256, `${role} must equal anchor prior bytes`);
      assert.equal(harness.sha256(harness.fileBytes(role)), anchor[role].sha256);
    }
    assert.deepEqual(snap.loaded, { controller: true, scheduler: true });
    assert.equal(snap.jobIdentity.controller, snap.controller.sha256);
    assert.equal(snap.jobIdentity.scheduler, snap.scheduler.sha256);
  }

  // host side effect 显式 before/after：当前 action 在 pre 位恰好执行一次、post 位绝不
  // 重放；每个剩余 frozen step 恰好执行一次（publisher/remove/bootstrap/bootout 分计数）。
  const trace = harness.trace();
  assert.equal(
    countFrozenEvent(trace, frozenHostEventFor(row.action)),
    row.position === 'after-action-post' ? 0 : 1,
    `${row.action}/${row.position}: current side effect must run once pre, never replay post`,
  );
  const executedSteps = plan.slice(
    row.position === 'after-action-post' ? step.index + 1 : step.index,
  );
  const expectedVerbCounts = { publish: 0, remove: 0, bootstrap: 0, bootout: 0 };
  for (const executed of executedSteps) expectedVerbCounts[frozenVerbFor(executed.action)] += 1;
  const sentinels = harness.sentinels();
  assert.equal(sentinels.publish, hostBefore.publish + expectedVerbCounts.publish, 'publish count');
  assert.equal(sentinels.remove, hostBefore.remove + expectedVerbCounts.remove, 'remove count');
  assert.equal(
    sentinels.bootstrap,
    hostBefore.bootstrap + expectedVerbCounts.bootstrap,
    'bootstrap count',
  );
  assert.equal(sentinels.bootout, hostBefore.bootout + expectedVerbCounts.bootout, 'bootout count');
  assert.equal(sentinels.realLaunchctlCalls, 0);

  // authority/attestation/recovery-lock 流 + 终态后有序释锁 + replay denial。
  assert.equal(trace[0], 'authority-consumed');
  assert.ok(trace.includes('attestation-file-sync'));
  assert.ok(trace.includes('attestation-directory-sync'));
  assert.ok(trace.includes('attestation-verify'));
  assert.ok(trace.includes('recovery-lock-acquire'));
  assert.ok(trace.includes('post-lock-snapshot'));
  assertOrderedTxThenMirRelease(trace);
  const locks = harness.lockState();
  assert.equal(locks.transactionLock, false, 'recovery tx lock must be released');
  assert.equal(locks.manualInterventionLock, false, 'MIR lock must be released after recovered');
  assert.deepEqual(harness.recoveryAcquisitionsForTest(), [{
    claimId: ids.claimId,
    transactionId,
    ownerNonce: ids.freshOwnerNonce,
  }]);
  assert.equal(harness.hasRecoveryClaim(), false);
  const attestation = harness.manualRepairAttestationForTest(fixture.confirmationId);
  assert.ok(attestation, 'attestation must be durable');
  assert.equal(
    attestation.mirTransactionId,
    transactionId,
    'attestation must bind the exact MIR transaction',
  );
  assert.equal(
    attestation.manualRepairConfirmationId,
    fixture.confirmationId,
    'attestation must bind the exact confirmation',
  );
  assert.equal(typeof attestation.attestedAt, 'string');
  assert.ok(attestation.attestedAt <= result.completedAt, 'attestation clock precedes receipt clock');

  // clock 显式 before/after：now delta = expectedAppendedStates.length + 2
  //（每次 appendJournal 为 entry.at 消耗 1 次 now，全部追加 entry 含 terminal
  // recovered 已由 expectedAppendedStates 精确列出；+2 = attestation attestedAt +
  // receipt completedAt）；newId delta = 2（claimId + freshOwnerNonce）。任何额外
  // clock/id 消费都会打破该 exact delta。
  const clockAfter = harness.clockCallCountsForTest();
  assert.deepEqual(clockBefore, { now: 0, newId: 0 }, 'clock counts zeroed before drive');
  assert.equal(
    clockAfter.now - clockBefore.now,
    expectedAppendedStates.length + 2,
    'exactly one clock per appended journal entry plus attestation and receipt completedAt',
  );
  assert.equal(clockAfter.newId - clockBefore.newId, 2, 'exactly claimId + freshOwnerNonce');

  await assertCapabilityReplayDenied(fixture.capability);
}

test('frozen manual compensation action union is exactly the ten production-reachable actions', async () => {
  const requiredUnion = [
    'stop-scheduler',
    'stop-controller',
    'remove-manifest',
    'remove-scheduler',
    'remove-controller',
    'restore-manifest',
    'restore-scheduler',
    'restore-controller',
    'load-controller',
    'load-scheduler',
  ].sort();

  // union 来自真实 coordinator 各自 persisted 的 compensating plan（非手写常量自证）。
  const installActions = await persistedFrozenPlanActions('install');
  const upgradeActions = await persistedFrozenPlanActions('managed-upgrade');
  assert.deepEqual(installActions, FROZEN_PLAN_ACTION_ORDER.install);
  assert.deepEqual(upgradeActions, FROZEN_PLAN_ACTION_ORDER['managed-upgrade']);
  assert.deepEqual([...new Set([...installActions, ...upgradeActions])].sort(), requiredUnion);

  // RED 矩阵恰好覆盖每个 reachable action × 三个崩溃位，无缺失无多余。
  assert.deepEqual(
    [...new Set(FROZEN_COMPENSATION_CASES.map((row) => row.action))].sort(),
    requiredUnion,
  );
  for (const action of requiredUnion) {
    assert.deepEqual(
      FROZEN_COMPENSATION_CASES.filter((row) => row.action === action)
        .map((row) => row.position)
        .sort(),
      ['after-action-post', 'after-intent-pre', 'before-intent'],
      `${action}: matrix must cover exactly the three crash positions`,
    );
  }
});

for (const [caseIndex, row] of FROZEN_COMPENSATION_CASES.entries()) {
  test(`frozen manual compensation ${row.action} ${row.position} resumes the frozen plan through the authorized manual path`, async () => {
    const fixture = await buildFrozenCompensationFixture(row, caseIndex + 1);
    const coordinator = createFullCoordinatorWithAuthoritySentinel(
      fixture.harness,
      fixture.capability,
    );

    // Production bug: recoverAfterManualRepair does not resume the frozen plan through
    // the authorized manual path. 绝大多数位点 classify 为 not-pure → abort own
    // recovery lock → 拒绝 recovery-required；唯一例外是 install 末位
    // remove-controller/after-action-post：走 pure-closeout 直接追加 recovered，
    // 遗漏 current completed pair 闭合，由 exact journal-pair assertion 形成该位点的
    // 独立 RED。
    const result = await coordinator.recoverAfterManualRepair(fixture.capability);

    await assertFrozenResumeResult(fixture, result);
  });
}

test('frozen manual compensation unknown live state fails closed without mutation and aborts only its own recovery lock', async () => {
  const fixture = await buildFrozenCompensationFixture(FROZEN_UNKNOWN_ROW, 31);
  const { harness, transactionId } = fixture;

  // fixture 已证明 live 原本精确等于 current step expectedPre；随后把当前 step role 的
  // job probe 置为 unknown → live 不再匹配任一 expected boundary。
  harness.setProbeMode(fixture.step.role, 'unknown');

  const entriesBefore = harness.journalEntries(transactionId);
  const mirRefBefore = harness.manualInterventionLockRefForTest();
  assert.deepEqual(mirRefBefore, fixture.mirRef, 'fixture: MIR ref exact before drive');
  assert.equal(harness.receiptFor(transactionId), null, 'fixture: no receipt before drive');
  const hostBefore = harness.sentinels();
  const clockBefore = harness.clockCallCountsForTest();
  const coordinator = createFullCoordinatorWithAuthoritySentinel(harness, fixture.capability);

  await assert.rejects(
    () => coordinator.recoverAfterManualRepair(fixture.capability),
    (error) => {
      assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      return true;
    },
  );

  // 公共 authority 前导必须精确发生：attestation（clock 消费）+ own recovery lock
  // acquire（claimId/freshOwnerNonce 两个 queued id）；probe 必须真实被咨询。
  const trace = harness.trace();
  assert.equal(trace[0], 'authority-consumed');
  assert.ok(trace.includes('attestation-file-sync'));
  assert.ok(trace.includes('attestation-directory-sync'));
  assert.ok(trace.includes('attestation-verify'));
  assert.ok(trace.includes('recovery-lock-acquire'));
  assert.ok(trace.includes('post-lock-snapshot'));
  assert.ok(
    trace.includes(`inspect-job-${fixture.step.role}`),
    'unknown live probe must actually be consulted',
  );

  // 不得有 compensation host mutation / journal mutation / receipt / 终态释锁事件。
  assert.deepEqual(harness.compensationEvents(), [], 'no compensation journal events');
  assert.equal(trace.includes('receipt'), false, 'no receipt publish');
  assert.equal(trace.includes('lock-release'), false, 'no terminal tx release');
  assert.equal(trace.includes('mir-lock-release'), false, 'no MIR release');
  assert.equal(trace.includes('claim-resolve'), false, 'no claim resolve');
  assertPublisherHostUnchanged(harness, hostBefore);
  assert.equal(
    harness.sentinels().receipt,
    hostBefore.receipt,
    'no receipt-store call/mutation may occur',
  );

  // clock 显式 before/after：恰好 now=1（attestation attestedAt）且 newId=2
  //（claimId + freshOwnerNonce）——直接证明没有额外 completion/receipt clock 或 id。
  const clockAfter = harness.clockCallCountsForTest();
  assert.deepEqual(clockBefore, { now: 0, newId: 0 }, 'clock counts zeroed before drive');
  assert.equal(clockAfter.now - clockBefore.now, 1, 'exactly the attestation clock value');
  assert.equal(clockAfter.newId - clockBefore.newId, 2, 'exactly claimId + freshOwnerNonce');

  // original-transaction journal entries/states 与 receipt presence 完全不变。
  assert.deepEqual(harness.journalEntries(transactionId), entriesBefore);
  assert.deepEqual(
    harness.journalStates(transactionId),
    entriesBefore.map((entry) => entry.state),
  );
  assert.equal(harness.receiptFor(transactionId), null, 'no receipt may appear');

  // own recovery transaction lock 已 acquire 又必须被 abort（释放）；MIR lock/ref 精确保留。
  assert.deepEqual(harness.recoveryAcquisitionsForTest(), [{
    claimId: fixture.ids.claimId,
    transactionId,
    ownerNonce: fixture.ids.freshOwnerNonce,
  }]);
  assert.equal(harness.lockAcquisitionsForTest().length, 1, 'exactly one own lock acquisition');
  assert.equal(
    harness.lockState().transactionLock,
    false,
    'own recovery lock must be aborted (released)',
  );
  assert.equal(harness.lockState().manualInterventionLock, true, 'MIR lock must be retained');
  assert.deepEqual(harness.manualInterventionLockRefForTest(), mirRefBefore, 'MIR ref retained exact');

  // attestation 已消费且 durable；capability 已烧毁；replay denied。
  const attestation = harness.manualRepairAttestationForTest(fixture.confirmationId);
  assert.ok(attestation, 'attestation must be consumed and durable');
  assert.equal(attestation.mirTransactionId, transactionId);
  assert.equal(typeof attestation.attestedAt, 'string');
  assert.equal(harness.hasRecoveryClaim(), false);
  await assertCapabilityReplayDenied(fixture.capability);
});

// ---------------------------------------------------------------------------
// Task 6B.2 Task 1B — frozen-chain 拒绝矩阵（Stratum A envelope / Stratum B semantic）。
// 每行从真实 coordinator persisted frozen fixture 出发（复用 Task 1A builder：
// run → crash image → revive → MIR append → MIR lock → genuine capability），
// 经 harness 闭合 enumerated seam mutateFrozenChainForTest 施加恰一种 durable
// corruption，再驱动公共 coordinator.recoverAfterManualRepair。
//
// Stratum A（acquire 前 envelope 拒绝）：被污染的 persisted entry 过不了
// validateLaunchAgentJournal / hash-link 加载层，route 在任一 acquisition 之前
// 拒绝；今天 deny-all 行为已强制 → guard PASS，绝不强造 RED。
// Stratum B（acquire 后 semantic 拒绝）：entry 逐条合法、hash-linked、head MIR、
// 可过 6B.1 pre-lock snapshot，但整链文法 / frozen evidence / live union 违例；
// 当前 production abort 自己的 recovery tx lock（class B），未来 approved target
// 是 fail-closed class C retain both locks —— 该 lock-state 差异是唯一合法 RED 点。
// 不绑定 parser 内部错误码/消息；setup/mutator throw 一律是 fixture 失败而非 RED。
// ---------------------------------------------------------------------------

const FROZEN_REJECTION_CASES = Object.freeze([
  // —— Stratum A：persisted compensating envelope（4 行，今天 guard PASS）——
  Object.freeze({
    caseNumber: 41,
    mutation: 'reverse-plan-hash-field-drift',
    stratum: 'A',
    chainGrammar: false,
    title: 'a drifted persisted reverse-plan hash field',
    baseRow: Object.freeze({
      operation: 'install',
      action: 'stop-scheduler',
      position: 'before-intent',
    }),
  }),
  Object.freeze({
    caseNumber: 42,
    mutation: 'reverse-plan-order-corruption',
    stratum: 'A',
    chainGrammar: false,
    title: 'a reordered persisted reverse plan',
    baseRow: Object.freeze({
      operation: 'install',
      action: 'stop-scheduler',
      position: 'before-intent',
    }),
  }),
  Object.freeze({
    caseNumber: 43,
    mutation: 'reverse-plan-action-corruption',
    stratum: 'A',
    chainGrammar: false,
    title: 'a corrupted persisted reverse-plan action',
    baseRow: Object.freeze({
      operation: 'install',
      action: 'stop-scheduler',
      position: 'before-intent',
    }),
  }),
  Object.freeze({
    caseNumber: 44,
    mutation: 'reverse-plan-index-corruption',
    stratum: 'A',
    chainGrammar: false,
    title: 'a corrupted persisted reverse-plan index',
    baseRow: Object.freeze({
      operation: 'install',
      action: 'stop-scheduler',
      position: 'before-intent',
    }),
  }),
  // —— Stratum B 链文法（7 行，今天 RED 于 retain-both-locks 边界）——
  Object.freeze({
    caseNumber: 45,
    mutation: 'second-compensating-entry',
    stratum: 'B',
    chainGrammar: true,
    title: 'a second compensating entry',
    baseRow: Object.freeze({
      operation: 'install',
      action: 'stop-scheduler',
      position: 'before-intent',
    }),
  }),
  Object.freeze({
    caseNumber: 46,
    mutation: 'duplicate-intent',
    stratum: 'B',
    chainGrammar: true,
    title: 'a duplicate intent entry',
    baseRow: Object.freeze({
      operation: 'install',
      action: 'stop-scheduler',
      position: 'after-intent-pre',
    }),
  }),
  Object.freeze({
    caseNumber: 47,
    mutation: 'completed-without-intent',
    stratum: 'B',
    chainGrammar: true,
    title: 'a completed entry without its intent',
    baseRow: Object.freeze({
      operation: 'install',
      action: 'stop-controller',
      position: 'before-intent',
    }),
  }),
  Object.freeze({
    caseNumber: 48,
    mutation: 'open-intent-then-later-intent',
    stratum: 'B',
    chainGrammar: true,
    title: 'an open intent followed by a later intent',
    baseRow: Object.freeze({
      operation: 'install',
      action: 'stop-scheduler',
      position: 'after-intent-pre',
    }),
  }),
  Object.freeze({
    caseNumber: 49,
    mutation: 'duplicate-completed',
    stratum: 'B',
    chainGrammar: true,
    title: 'a duplicate completed entry',
    baseRow: Object.freeze({
      operation: 'install',
      action: 'stop-controller',
      position: 'before-intent',
    }),
  }),
  Object.freeze({
    caseNumber: 50,
    mutation: 'second-mir-marker',
    stratum: 'B',
    chainGrammar: true,
    title: 'a second manual-intervention-required marker',
    baseRow: Object.freeze({
      operation: 'install',
      action: 'stop-scheduler',
      position: 'before-intent',
    }),
  }),
  Object.freeze({
    caseNumber: 51,
    mutation: 'terminal-before-plan-completion',
    stratum: 'B',
    chainGrammar: true,
    title: 'a terminal entry before frozen plan completion',
    baseRow: Object.freeze({
      operation: 'install',
      action: 'stop-scheduler',
      position: 'before-intent',
    }),
  }),
  // —— Stratum B evidence/live 单侧漂移（3 行，链不动）——
  Object.freeze({
    caseNumber: 52,
    mutation: 'candidate-evidence-mismatch',
    stratum: 'B',
    chainGrammar: false,
    title: 'candidate evidence drift',
    baseRow: Object.freeze({
      operation: 'install',
      action: 'stop-scheduler',
      position: 'before-intent',
    }),
  }),
  Object.freeze({
    caseNumber: 53,
    mutation: 'anchor-evidence-mismatch',
    stratum: 'B',
    chainGrammar: false,
    title: 'anchor evidence drift',
    baseRow: Object.freeze({
      operation: 'managed-upgrade',
      action: 'stop-scheduler',
      position: 'before-intent',
    }),
  }),
  Object.freeze({
    caseNumber: 54,
    mutation: 'non-current-live-union-mismatch',
    stratum: 'B',
    chainGrammar: false,
    title: 'a non-current live union mismatch',
    baseRow: Object.freeze({
      operation: 'install',
      action: 'remove-controller',
      position: 'before-intent',
    }),
  }),
]);

function frozenRejectionTestName(row) {
  return row.stratum === 'A'
    ? `frozen manual compensation rejects ${row.title} before recovery lock acquisition`
    : `frozen manual compensation rejects ${row.title} retaining both locks after acquisition`;
}

/**
 * Task 1B fixture：Task 1A 真实 persisted frozen fixture + 恰一种 seam corruption +
 * per-stratum fixture proof（A：恰好一条 entry 不过 validateLaunchAgentJournal 且
 * envelope 自洽、head MIR；B 链行：逐条合法 + sequence/link 自洽 + prefix 必败；
 * B evidence/live 行：prefix 仍合法 + 单侧漂移证明）。proof 的只读 I/O 不属 route
 * 观测：之后重新 resetObservations + armPostLockSnapshotEvent（queued clock ids
 * 不属 reset 范围而保留），再捕获 route 前锚点。
 */
async function buildFrozenRejectionFixture(row) {
  const fixture = await buildFrozenCompensationFixture(row.baseRow, row.caseNumber);
  const { harness, transactionId } = fixture;

  const mutationResult = harness.mutateFrozenChainForTest({
    transactionId,
    mutation: row.mutation,
    sourceJournal: fixture.crashEntries,
  });
  assert.equal(mutationResult.mutation, row.mutation);
  assert.equal(mutationResult.transactionId, transactionId);

  const entries = harness.journalEntries(transactionId);
  if (row.stratum === 'A') {
    let invalidCount = 0;
    for (const entry of entries) {
      assert.equal(
        frozenJournalEntrySha256(entry),
        entry.entrySha256,
        `${row.mutation}: entry envelope hash must stay self-consistent`,
      );
      try {
        validateLaunchAgentJournal(entry);
      } catch {
        invalidCount += 1;
      }
    }
    assert.equal(
      invalidCount,
      1,
      `${row.mutation}: exactly the persisted compensating entry must fail validation`,
    );
    assert.equal(entries.at(-1).state, 'manual-intervention-required', 'head must stay MIR');
  } else if (row.chainGrammar) {
    let previousEntrySha256 = null;
    for (const [index, entry] of entries.entries()) {
      validateLaunchAgentJournal(entry);
      assert.equal(
        frozenJournalEntrySha256(entry),
        entry.entrySha256,
        `${row.mutation}: every entry must stay individually valid`,
      );
      assert.equal(entry.sequence, index, `${row.mutation}: sequence must stay linked`);
      assert.equal(
        entry.previousEntrySha256,
        previousEntrySha256,
        `${row.mutation}: previous hash must stay linked`,
      );
      previousEntrySha256 = entry.entrySha256;
    }
    assert.equal(entries.at(-1).state, 'manual-intervention-required', 'head must stay MIR');
    assert.throws(
      () => validateLaunchAgentTransactionPrefix({ entries }),
      (error) => error instanceof LaunchAgentLifecycleError,
      `${row.mutation}: mutated chain must fail the frozen-chain prefix`,
    );
  } else {
    // evidence/live 行：链完全未动，prefix 必须仍然合法；只证明比较的一侧漂移。
    validateLaunchAgentTransactionPrefix({ entries });
    if (row.mutation === 'candidate-evidence-mismatch') {
      const step = fixture.plan.find((candidate) => (
        candidate.evidence.kind === 'candidate' && candidate.role === mutationResult.role
      ));
      assert.ok(step, 'fixture: candidate-evidence step must exist');
      const bytes = await harness.dependencies().metadataStore.readCandidate({
        kind: 'candidate',
        transactionId,
        role: step.role,
        sha256: step.evidence.sha256,
      });
      assert.notEqual(
        harness.sha256(bytes),
        step.evidence.sha256,
        'fixture: candidate bytes must drift from the frozen evidence hash',
      );
    } else if (row.mutation === 'anchor-evidence-mismatch') {
      const step = fixture.plan.find((candidate) => (
        candidate.evidence.kind === 'anchor' && candidate.role === mutationResult.role
      ));
      assert.ok(step, 'fixture: anchor-evidence step must exist');
      assert.equal(step.evidence.anchorId, fixture.anchorId);
      const anchor = harness.anchorFor(fixture.anchorId);
      assert.notEqual(
        anchor.loaded[step.role],
        step.evidence.loaded,
        'fixture: anchor loaded must drift from the frozen evidence',
      );
    } else if (row.mutation === 'non-current-live-union-mismatch') {
      const role = mutationResult.role;
      const live = harness.liveReversePlanStepState(role);
      assert.equal(live.file.state, 'present', 'fixture: drifted role file must be present');
      const unionShas = new Set();
      for (const candidate of fixture.plan) {
        if (candidate.role !== role) continue;
        for (const expected of [candidate.expectedPre, candidate.expectedPost]) {
          if (expected.file.state === 'present') unionShas.add(expected.file.sha256);
        }
      }
      assert.ok(
        !unionShas.has(live.file.sha256),
        'fixture: live identity must land outside the frozen union boundary',
      );
      // non-current 语义：current step 一侧绝不漂移。
      assertFrozenLiveMatches(harness, fixture.plan, fixture.step, 'expectedPre');
    } else {
      throw new Error(`unsupported non-chain rejection mutation: ${row.mutation}`);
    }
  }

  harness.resetObservations();
  harness.armPostLockSnapshotEvent();
  const entriesBefore = harness.journalEntries(transactionId);
  const statesBefore = harness.journalStates(transactionId);
  const mirRefBefore = harness.manualInterventionLockRefForTest();
  assert.deepEqual(mirRefBefore, fixture.mirRef, 'fixture: MIR ref exact before drive');
  assert.equal(harness.receiptFor(transactionId), null, 'fixture: no receipt before drive');
  const hostBefore = harness.sentinels();
  const clockBefore = harness.clockCallCountsForTest();
  return {
    ...fixture,
    mutationResult,
    entriesBefore,
    statesBefore,
    mirRefBefore,
    hostBefore,
    clockBefore,
  };
}

/** Stratum A/B 共享 route 后不变量：authority/attestation 前导 + 零 forbidden mutation。 */
function assertFrozenRejectionCommonInvariants(fixture) {
  const { harness, transactionId } = fixture;
  const trace = harness.trace();
  assert.equal(trace[0], 'authority-consumed', 'capability consume must be the first event');
  assert.ok(trace.includes('attestation-file-sync'), 'attestation write must be durable');
  assert.ok(trace.includes('attestation-directory-sync'), 'attestation fsync must be durable');
  assert.ok(trace.includes('attestation-verify'), 'attestation read-back must occur');
  for (const forbidden of [
    'receipt',
    'lock-release',
    'mir-lock-release',
    'mir-transaction-lock-release',
    'claim-resolve',
  ]) {
    assert.equal(trace.includes(forbidden), false, `forbidden event must not appear: ${forbidden}`);
  }
  assert.deepEqual(harness.compensationEvents(), [], 'no compensation journal events');
  assertPublisherHostUnchanged(harness, fixture.hostBefore);
  assert.equal(
    harness.sentinels().receipt,
    fixture.hostBefore.receipt,
    'no receipt-store call/mutation may occur',
  );
  assert.deepEqual(fixture.clockBefore, { now: 0, newId: 0 }, 'clock counts zeroed before drive');
  assert.deepEqual(harness.journalEntries(transactionId), fixture.entriesBefore);
  assert.deepEqual(harness.journalStates(transactionId), fixture.statesBefore);
  assert.equal(harness.receiptFor(transactionId), null, 'no receipt may appear');
  assert.equal(harness.lockState().manualInterventionLock, true, 'MIR lock must be retained');
  assert.deepEqual(
    harness.manualInterventionLockRefForTest(),
    fixture.mirRefBefore,
    'MIR ref retained exact',
  );
  const attestation = harness.manualRepairAttestationForTest(fixture.confirmationId);
  assert.ok(attestation, 'attestation must be consumed and durable');
  assert.equal(attestation.mirTransactionId, transactionId);
  assert.equal(attestation.manualRepairConfirmationId, fixture.confirmationId);
  assert.equal(typeof attestation.attestedAt, 'string');
  assert.equal(harness.hasRecoveryClaim(), false);
  return trace;
}

/**
 * Stratum A：公共 route 在任一 acquisition 之前拒绝（不绑定 parser 内部 code）。
 * clock delta 恰 {now:1, newId:0}；无任何 own tx/recovery lock acquisition。
 */
async function assertFrozenStratumARejection(fixture) {
  const { harness } = fixture;
  const coordinator = createFullCoordinatorWithAuthoritySentinel(harness, fixture.capability);
  await assert.rejects(
    () => coordinator.recoverAfterManualRepair(fixture.capability),
    (error) => {
      assert.ok(error instanceof LaunchAgentLifecycleError, 'rejection must be a lifecycle error');
      return true;
    },
  );
  const trace = assertFrozenRejectionCommonInvariants(fixture);
  assertNoAcquireOrPostLock(trace);
  const clockAfter = harness.clockCallCountsForTest();
  assert.equal(clockAfter.now - fixture.clockBefore.now, 1, 'exactly the attestation clock');
  assert.equal(clockAfter.newId - fixture.clockBefore.newId, 0, 'no acquisition id may be consumed');
  assert.deepEqual(harness.lockAcquisitionsForTest(), [], 'no own tx lock acquisition');
  assert.deepEqual(harness.recoveryAcquisitionsForTest(), [], 'no recovery lock acquisition');
  assert.equal(harness.lockState().transactionLock, false, 'no own recovery tx lock may exist');
  await assertCapabilityReplayDenied(fixture.capability);
}

/**
 * Stratum B：公共 route 完成 authority 前导 + 恰两个 newId + 一次 own recovery
 * acquisition 后拒绝（RECOVERY_REQUIRED = 当前 class B 与未来 class C 的公共 route
 * code；不绑定 parser 内部 code）。唯一预期 RED 点在最后：未来 target retain both
 * locks，当前 production abort 自己的 recovery tx lock。
 */
async function assertFrozenStratumBRejection(fixture) {
  const { harness, transactionId } = fixture;
  const coordinator = createFullCoordinatorWithAuthoritySentinel(harness, fixture.capability);
  await assert.rejects(
    () => coordinator.recoverAfterManualRepair(fixture.capability),
    (error) => {
      assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      return true;
    },
  );
  const trace = assertFrozenRejectionCommonInvariants(fixture);
  assert.ok(trace.includes('recovery-lock-acquire'), 'own recovery lock acquisition must occur');
  assert.ok(trace.includes('post-lock-snapshot'), 'post-lock snapshot must occur');
  const clockAfter = harness.clockCallCountsForTest();
  assert.equal(clockAfter.now - fixture.clockBefore.now, 1, 'exactly the attestation clock');
  assert.equal(
    clockAfter.newId - fixture.clockBefore.newId,
    2,
    'exactly claimId + freshOwnerNonce',
  );
  assert.deepEqual(harness.recoveryAcquisitionsForTest(), [{
    claimId: fixture.ids.claimId,
    transactionId,
    ownerNonce: fixture.ids.freshOwnerNonce,
  }]);
  assert.equal(harness.lockAcquisitionsForTest().length, 1, 'exactly one own lock acquisition');
  await assertCapabilityReplayDenied(fixture.capability);

  // —— 唯一预期 RED 点（未来 class C fail-closed target：retain both locks 且不追加
  // journal/receipt、不变 host、烧毁 authority）。当前 production class B abort
  // 自己的 recovery tx lock → 以下断言今天失败；此外不得有任何其它失败。 ——
  assert.equal(
    harness.lockState().transactionLock,
    true,
    'future malformed-chain target must retain the acquired recovery tx lock',
  );
  const retained = harness.transactionLockRefForTest();
  assert.equal(retained.transactionId, transactionId, 'retained lock must bind the MIR transaction');
  assert.equal(
    retained.ownerNonce,
    fixture.ids.freshOwnerNonce,
    'retained lock must bind the fresh owner nonce',
  );
}

for (const row of FROZEN_REJECTION_CASES) {
  test(frozenRejectionTestName(row), async () => {
    const fixture = await buildFrozenRejectionFixture(row);
    if (row.stratum === 'A') {
      await assertFrozenStratumARejection(fixture);
    } else {
      await assertFrozenStratumBRejection(fixture);
    }
  });
}

test('frozen manual compensation rejection matrix covers the required durable corruptions exactly once', () => {
  // 表与 harness 闭合 enumerated 词汇精确一致：无缺失、无多余、无 generic mutator。
  const harnessNames = createLaunchAgentLifecycleHarness().frozenChainMutationNamesForTest();
  assert.deepEqual(
    FROZEN_REJECTION_CASES.map((row) => row.mutation).sort(),
    harnessNames,
  );

  // 每个要求的 durable corruption 恰好一次；caseNumber 41–54 唯一连续。
  assert.equal(FROZEN_REJECTION_CASES.length, 14);
  assert.deepEqual(
    FROZEN_REJECTION_CASES.map((row) => row.caseNumber),
    [41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54],
  );
  assert.equal(
    new Set(FROZEN_REJECTION_CASES.map((row) => row.mutation)).size,
    FROZEN_REJECTION_CASES.length,
    'each mutation must appear exactly once',
  );

  // 分层：恰好 4 行 Stratum A envelope；10 行 Stratum B，其中 7 行链文法。
  const stratumA = FROZEN_REJECTION_CASES.filter((row) => row.stratum === 'A');
  const stratumB = FROZEN_REJECTION_CASES.filter((row) => row.stratum === 'B');
  assert.equal(stratumA.length, 4, 'exactly the four envelope corruptions are Stratum A');
  assert.equal(stratumB.length, 10, 'the remaining ten corruptions are Stratum B');
  assert.equal(
    stratumB.filter((row) => row.chainGrammar).length,
    7,
    'exactly the seven chain-grammar corruptions',
  );
  assert.ok(stratumA.every((row) => row.chainGrammar === false));

  // 每行 baseRow 必须是真实可达 plan action × 受支持 crash position；
  // 测试名必须带冻结前缀。
  for (const row of FROZEN_REJECTION_CASES) {
    assert.ok(
      FROZEN_PLAN_ACTION_ORDER[row.baseRow.operation].includes(row.baseRow.action),
      `${row.mutation}: base action must be plan-reachable`,
    );
    assert.ok(
      FROZEN_CRASH_POSITIONS.includes(row.baseRow.position),
      `${row.mutation}: base position must be supported`,
    );
    assert.ok(
      frozenRejectionTestName(row).startsWith('frozen manual compensation'),
      `${row.mutation}: test name must carry the frozen prefix`,
    );
  }
});

// ---------------------------------------------------------------------------
// Task 6B.2 Task 4B — 11 窗口 fresh-restart（manual repair crash window）。
// 生产可达 frozen fixture：install / stop-scheduler / before-intent。
// 首轮预置 residual old transaction lock + owner dead×2，经真实 acquire 覆盖
// old-intact → old-removed → fresh-published → claim-cleared；crash capture 不中止
// 首轮，完成后 takeCrashImage → 丢弃 live → branded fresh revive + 新授权驱动。
// 禁止私有 capability 伪造 / helper 直接终态 / 直接改 receipt·locks。
// ---------------------------------------------------------------------------

const CRASH_WINDOW_BASE_ROW = Object.freeze({
  operation: 'install',
  action: 'stop-scheduler',
  position: 'before-intent',
});

/** crash image 顶层 durable allowlist；只查 own keys/types，不 dump 整图。 */
const CRASH_IMAGE_TOP_KEYS = Object.freeze([
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

const CRASH_WINDOW_CASES = Object.freeze([
  Object.freeze({
    name: 'attestation-verify',
    selector: Object.freeze({
      kind: 'event',
      event: 'attestation-verify',
      occurrence: 1,
    }),
    family: 'early',
  }),
  Object.freeze({
    name: 'recovery-claim-durable-old-intact',
    selector: Object.freeze({
      kind: 'event',
      event: 'recovery-claim-durable-old-intact',
      occurrence: 1,
    }),
    family: 'claim',
    resolveStatus: 'old-intact',
  }),
  Object.freeze({
    name: 'old-transaction-lock-removed',
    selector: Object.freeze({
      kind: 'event',
      event: 'old-transaction-lock-removed',
      occurrence: 1,
    }),
    family: 'claim',
    resolveStatus: 'transaction-lock-absent',
  }),
  Object.freeze({
    name: 'fresh-transaction-lock-published',
    selector: Object.freeze({
      kind: 'event',
      event: 'fresh-transaction-lock-published',
      occurrence: 1,
    }),
    family: 'claim',
    resolveStatus: 'fresh-published',
  }),
  Object.freeze({
    name: 'recovery-lock-acquire',
    selector: Object.freeze({
      kind: 'event',
      event: 'recovery-lock-acquire',
      occurrence: 1,
    }),
    family: 'post-acquire',
  }),
  Object.freeze({
    name: 'compensation-host-action',
    selector: Object.freeze({
      kind: 'host-mutation',
      action: 'stop-scheduler',
      occurrence: 1,
    }),
    family: 'compensation-host',
  }),
  Object.freeze({
    name: 'compensation-completed',
    selector: Object.freeze({
      kind: 'journal-state',
      state: 'compensate-stop-scheduler-completed',
      occurrence: 1,
    }),
    family: 'compensation-completed',
  }),
  Object.freeze({
    name: 'terminal-journal',
    selector: Object.freeze({
      kind: 'journal-state',
      state: 'recovered',
      occurrence: 1,
    }),
    family: 'closeout-terminal',
  }),
  Object.freeze({
    name: 'receipt-published',
    selector: Object.freeze({
      kind: 'event',
      event: 'receipt-published',
      occurrence: 1,
    }),
    family: 'closeout-receipt',
  }),
  Object.freeze({
    name: 'recovery-transaction-lock-released',
    selector: Object.freeze({
      kind: 'event',
      event: 'recovery-transaction-lock-released',
      occurrence: 1,
    }),
    family: 'closeout-tx-release',
  }),
  Object.freeze({
    name: 'mir-lock-released',
    selector: Object.freeze({
      kind: 'event',
      event: 'mir-lock-released',
      occurrence: 1,
    }),
    family: 'closeout-mir-release',
  }),
]);

function crashWindowIds(caseNumber, round) {
  const pad4 = String(caseNumber).padStart(4, '0');
  const pad12 = String(caseNumber).padStart(12, '0');
  const r = round === 1 ? '1' : round === 2 ? '2' : '3';
  // 仅 0-9a-f；首段 8 hex，round/case 嵌入保证互不冲突。
  return Object.freeze({
    claimId: `c4b${r}${pad4}-aaaa-4aaa-8aaa-${pad12}`,
    freshOwnerNonce: `f4b${r}${pad4}-bbbb-4bbb-8bbb-${pad12}`,
    confirmationId: `a4b${r}${pad4}-eeee-4eee-8eee-${pad12}`,
    requestId: `d4b${r}${pad4}-dddd-4ddd-8ddd-${pad12}`,
    residualOldNonce: `e4b0${pad4}-ffff-4fff-8fff-${pad12}`,
  });
}

function assertCrashImageSafeSurface(image, label) {
  assert.ok(image !== null && typeof image === 'object', `${label}: image present`);
  const ownKeys = Reflect.ownKeys(image);
  assert.ok(ownKeys.every((key) => typeof key === 'string'), `${label}: keys are strings`);
  assert.deepEqual(
    [...ownKeys].sort(),
    [...CRASH_IMAGE_TOP_KEYS].sort(),
    `${label}: crash image own keys must equal durable allowlist`,
  );
  for (const forbidden of [
    'capability',
    'authority',
    'brand',
    'hooks',
    'trace',
    'env',
    'secret',
    'path',
    'rawPath',
    'failureInjection',
    'process',
  ]) {
    assert.equal(Object.hasOwn(image, forbidden), false, `${label}: no ${forbidden}`);
  }
  for (const key of ownKeys) {
    assert.notEqual(typeof image[key], 'function', `${label}: ${key} must not be function`);
  }
  assert.equal(image.schemaVersion, 1, `${label}: schemaVersion 1`);
  assert.ok(Array.isArray(image.attestations), `${label}: attestations array`);
  assert.ok(
    image.recoveryClaim === null || typeof image.recoveryClaim === 'object',
    `${label}: recoveryClaim null|object`,
  );
}

/**
 * 首轮：frozen MIR fixture + residual old tx + owner dead×2 + arm crash selector。
 * 真实 recoverAfterManualRepair 跑完全程；capture 不中止；返回 image 与 exact 锚点。
 */
async function buildCrashWindowCapturedRun(row, caseNumber) {
  const base = await buildFrozenCompensationFixture(CRASH_WINDOW_BASE_ROW, caseNumber);
  const {
    harness,
    transactionId,
    mirRef,
    anchorId,
    plan,
    step,
    frozenHash,
    crashEntries,
    mirEntry,
    runReceipt,
    ids: fixtureIds,
  } = base;

  // residual old nonce 独立；claimId/freshOwnerNonce 复用 fixture 已 queue 的 ids
  // （resetObservations 不清 clock 队列，禁止二次 queueClockIds）。
  const residualIds = crashWindowIds(caseNumber, 1);
  const residualOldRecord = lockRecord(transactionId, residualIds.residualOldNonce);
  const residualOldRef = harness.seedTransactionLock(residualOldRecord);
  assert.deepEqual(
    harness.transactionLockRefForTest(),
    residualOldRef,
    'fixture: residual old transaction lock must be exact',
  );
  assert.deepEqual(
    harness.lockState(),
    { transactionLock: true, manualInterventionLock: true },
    'fixture: residual old tx + MIR both present before first resume',
  );

  // 重新 mint：绑定 residual old（fixture 自带 null-bound capability 不使用）。
  // confirmation/request 用本行独立 UUID，避免与 fixture 铸造冲突。
  const { capability, confirmationId } = await mintGenuineCapability({
    mirTransactionId: transactionId,
    mirLockRef: mirRef,
    transactionLockRef: residualOldRef,
    anchorId,
    confirmationId: residualIds.confirmationId,
    manualRepairRequestId: residualIds.requestId,
  });

  // 保留 fixture 已 queue 的 claimId/freshOwnerNonce；只重装观测与 crash selector。
  harness.resetObservations();
  harness.armPostLockSnapshotEvent();
  harness.armOwnerObserveStatuses(['dead', 'dead']);
  harness.armCrashCapture(structuredClone(row.selector));
  // clock 队列仍持有 fixtureIds（reset 不清队列）——不得再 queue。

  const firstIds = Object.freeze({
    claimId: fixtureIds.claimId,
    freshOwnerNonce: fixtureIds.freshOwnerNonce,
    confirmationId: residualIds.confirmationId,
    requestId: residualIds.requestId,
    residualOldNonce: residualIds.residualOldNonce,
  });

  const coordinator = createFullCoordinatorWithAuthoritySentinel(harness, capability);
  const firstResult = validateLaunchAgentReceipt(
    await coordinator.recoverAfterManualRepair(capability),
  );
  assert.equal(firstResult.state, 'recovered', 'fixture first resume must close recovered');
  assert.equal(firstResult.success, false);
  assert.equal(firstResult.outcome, 'recovered');
  assert.equal(firstResult.transactionId, transactionId);
  assert.deepEqual(
    harness.lockState(),
    { transactionLock: false, manualInterventionLock: false },
    'fixture first resume must release both locks',
  );
  assert.equal(harness.hasRecoveryClaim(), false);
  await assertCapabilityReplayDenied(capability);

  const image = harness.takeCrashImage();
  assertCrashImageSafeSurface(image, `${row.name}/captured`);

  // 丢弃首轮 live harness：只携带 branded image 与 exact 锚点进入 revive。
  return {
    row,
    caseNumber,
    image,
    firstConfirmationId: confirmationId,
    firstCapability: capability,
    firstIds,
    residualOldRef,
    mirRef,
    transactionId,
    anchorId,
    plan,
    step,
    frozenHash,
    crashEntries,
    mirEntry,
    runReceipt,
    firstResult,
  };
}

function mintFactsForRevived(captured, harness, ids) {
  const observedTx = harness.transactionLockRefForTest();
  return {
    mirTransactionId: captured.transactionId,
    // 即使 image 中 MIR 已 absent，capability 仍绑定崩溃前 exact MIR identity。
    mirLockRef: captured.mirRef,
    transactionLockRef: observedTx,
    anchorId: captured.anchorId,
    confirmationId: ids.confirmationId,
    manualRepairRequestId: ids.requestId,
  };
}

async function driveFreshAuthorization(harness, captured, ids, options = {}) {
  const facts = mintFactsForRevived(captured, harness, ids);
  if (Object.hasOwn(options, 'transactionLockRef')) {
    facts.transactionLockRef = options.transactionLockRef;
  }
  const { capability, confirmationId } = await mintGenuineCapability(facts);
  harness.resetObservations();

  if (options.claimOwnerDead) {
    harness.armClaimOwnerObserveStatuses(['dead', 'dead']);
  } else if (options.ownerDead) {
    harness.armOwnerObserveStatuses(['dead', 'dead']);
  }
  if (options.queueAcquireIds) {
    harness.queueClockIds([ids.claimId, ids.freshOwnerNonce]);
  }
  if (options.armPostLock) {
    harness.armPostLockSnapshotEvent();
  }

  const coordinator = createFullCoordinatorWithAuthoritySentinel(harness, capability);
  const result = await coordinator.recoverAfterManualRepair(capability);
  await assertCapabilityReplayDenied(capability);
  return { result, capability, confirmationId, facts };
}

function countTraceName(trace, name) {
  return trace.filter((event) => event === name).length;
}

/**
 * 11 行通用终态：recovered receipt、单 terminal、单 receipt、双锁/claim absent、
 * 无真实 launchctl、host exact、无第二 compensating/MIR。
 */
function assertCrashWindowFinalRecovered(harness, captured, result, options = {}) {
  const { transactionId, anchorId, plan, frozenHash, crashEntries, mirEntry, runReceipt } = captured;
  const expectedReceiptTrace = options.expectedReceiptTrace ?? 1;
  const expectHostMutation = options.expectHostMutation === true;

  assert.equal(result.state, 'recovered');
  assert.equal(result.success, false);
  assert.equal(result.outcome, 'recovered');
  assert.equal(result.operation, 'install');
  assert.equal(result.transactionId, transactionId);
  assert.equal(result.anchorId, anchorId);
  assert.equal(result.sourceCommit, runReceipt.sourceCommit);
  assert.equal(
    result.hostMutationCount,
    runReceipt.hostMutationCount,
    'hostMutationCount must match uninterrupted recovered run',
  );
  assert.equal(result.roles.controller.outcome, 'removed');
  assert.equal(result.roles.scheduler.outcome, 'removed');
  assert.equal(result.roles.controller.changed, true);
  assert.equal(result.roles.scheduler.changed, true);

  const entries = harness.journalEntries(transactionId);
  const terminals = entries.filter((entry) => entry.state === 'recovered');
  assert.equal(terminals.length, 1, 'exactly one recovered terminal');
  const terminal = terminals[0];
  assert.equal(entries.at(-1).state, 'recovered');
  assert.ok(Object.hasOwn(terminal.payload, 'receipt'), 'terminal embeds receipt');
  assert.deepEqual(terminal.payload.receipt, result);
  assert.equal(
    terminal.payload.receiptSha256,
    harness.sha256(Buffer.from(JSON.stringify(terminal.payload.receipt), 'utf8')),
  );
  assert.deepEqual(harness.receiptFor(transactionId), result, 'exactly one matching receipt');

  // original crash-position prefix + MIR 精确保留；不得第二 compensating / 第二 MIR。
  const preservedPrefix = [...crashEntries, mirEntry];
  assert.deepEqual(
    entries.slice(0, preservedPrefix.length),
    preservedPrefix,
    'original crash-position entries and MIR must remain exact',
  );
  assert.equal(
    entries.filter((entry) => entry.state === 'compensating').length,
    1,
    'no second compensating entry',
  );
  assert.equal(
    entries.filter((entry) => entry.state === 'manual-intervention-required').length,
    1,
    'no second MIR entry',
  );
  const frozen = entries.find((entry) => entry.state === 'compensating');
  assert.equal(frozen.payload.reversePlanSha256, frozenHash);
  assert.deepEqual(
    frozen.payload.reversePlan.map((item) => item.action),
    plan.map((item) => item.action),
  );
  validateLaunchAgentTransactionPrefix({ entries });

  assert.deepEqual(harness.lockState(), {
    transactionLock: false,
    manualInterventionLock: false,
  });
  assert.equal(harness.hasRecoveryClaim(), false);
  assert.equal(harness.sentinels().realLaunchctlCalls, 0);

  const snap = harness.hostSnapshot();
  assert.equal(snap.controller, null);
  assert.equal(snap.scheduler, null);
  assert.equal(snap.manifest, null);
  assert.deepEqual(snap.loaded, { controller: false, scheduler: false });
  assert.deepEqual(snap.jobIdentity, { controller: null, scheduler: null });

  const trace = harness.trace();
  assert.equal(
    countTraceName(trace, 'receipt'),
    expectedReceiptTrace,
    `receipt publish count on revived harness must be ${expectedReceiptTrace}`,
  );
  if (!expectHostMutation) {
    assert.equal(harness.sentinels().hostMutationCount, 0, 'closeout must not host-mutate');
    assert.equal(countTraceName(trace, 'bootout-scheduler'), 0);
    assert.equal(countTraceName(trace, 'bootout-controller'), 0);
    assert.equal(countTraceName(trace, 'remove-scheduler'), 0);
    assert.equal(countTraceName(trace, 'remove-controller'), 0);
    assert.equal(countTraceName(trace, 'remove-manifest'), 0);
  }

  // 不得绑定私有函数名；只验证契约终态。
  void anchorId;
}

test('manual repair crash window selector contract rejects unknown event extra fields and non-positive occurrence', () => {
  // 未知 event
  {
    const harness = createLaunchAgentLifecycleHarness();
    assert.throws(
      () => harness.armCrashCapture({
        kind: 'event',
        event: 'not-a-closed-event',
        occurrence: 1,
      }),
      /unknown crash event name/,
    );
  }
  // 额外字段
  {
    const harness = createLaunchAgentLifecycleHarness();
    assert.throws(
      () => harness.armCrashCapture({
        kind: 'event',
        event: 'attestation-verify',
        occurrence: 1,
        extra: true,
      }),
      /launchagent-lifecycle-invalid/,
    );
  }
  // 非正 occurrence
  for (const occurrence of [0, -1, 1.5, Number.NaN, '1']) {
    const harness = createLaunchAgentLifecycleHarness();
    assert.throws(
      () => harness.armCrashCapture({
        kind: 'event',
        event: 'attestation-verify',
        occurrence,
      }),
      /crash capture occurrence must be a positive integer/,
    );
  }
  // 现有 journal-state / host-mutation 仍可用；event 合法名可用
  {
    const harness = createLaunchAgentLifecycleHarness();
    assert.equal(
      harness.armCrashCapture({ kind: 'journal-state', state: 'prepared', occurrence: 1 }),
      true,
    );
  }
  {
    const harness = createLaunchAgentLifecycleHarness();
    assert.equal(
      harness.armCrashCapture({
        kind: 'host-mutation',
        action: 'stop-scheduler',
        occurrence: 1,
      }),
      true,
    );
  }
  {
    const harness = createLaunchAgentLifecycleHarness();
    assert.equal(
      harness.armCrashCapture({
        kind: 'event',
        event: 'receipt-published',
        occurrence: 1,
      }),
      true,
    );
  }
});

for (const [index, row] of CRASH_WINDOW_CASES.entries()) {
  test(`manual repair crash window ${row.name} fresh-restarts through authorized recoverAfterManualRepair`, async () => {
    const caseNumber = 201 + index;
    const captured = await buildCrashWindowCapturedRun(row, caseNumber);
    const harness = createLaunchAgentLifecycleHarness({ crashImage: captured.image });
    assertCrashImageSafeSurface(captured.image, `${row.name}/revive`);

    // 首轮 attestation 必须 durable 于 image；原能力已烧毁。
    assert.equal(
      harness.hasManualRepairAttestation(captured.firstConfirmationId),
      true,
      'first-round durable attestation must revive',
    );
    await assertCapabilityReplayDenied(captured.firstCapability);

    if (row.family === 'claim') {
      // —— claim 三行：第一次授权只 resolve；第二次才闭环 ——
      assert.equal(harness.hasRecoveryClaim(), true, `${row.name}: residual claim present`);
      const claimRefBefore = harness.recoveryClaimRefForTest();
      assert.ok(claimRefBefore, 'residual claim ref exact');
      const journalBefore = harness.journalEntries(captured.transactionId);
      const hostBefore = harness.sentinels();
      const ids1 = crashWindowIds(caseNumber, 2);

      const first = await driveFreshAuthorization(harness, captured, ids1, {
        claimOwnerDead: true,
        // resolve 路径不 acquire：不 queue claim/fresh ids
      });
      assert.deepEqual(
        first.result,
        {
          kind: 'manual-repair-recovery-claim-resolved',
          status: row.resolveStatus,
          mirTransactionId: captured.transactionId,
          recoveryClaimRef: claimRefBefore,
        },
        `${row.name}: first auth must only resolve exact status`,
      );
      assert.equal(harness.hasRecoveryClaim(), false, 'claim cleared after resolve');
      assert.deepEqual(
        harness.journalEntries(captured.transactionId),
        journalBefore,
        'first auth must not append journal',
      );
      assert.equal(harness.receiptFor(captured.transactionId), null);
      assert.equal(countTraceName(harness.trace(), 'recovery-lock-acquire'), 0);
      assert.equal(countTraceName(harness.trace(), 'receipt'), 0);
      assert.equal(harness.sentinels().hostMutationCount, hostBefore.hostMutationCount);
      assert.equal(harness.sentinels().realLaunchctlCalls, 0);
      assertNoAcquireOrPostLock(harness.trace());

      // 第二授权：按 resolve 后实际 tx 绑定；tx present → owner dead；queue acquire ids。
      const observedTx = harness.transactionLockRefForTest();
      if (row.resolveStatus === 'old-intact') {
        assert.ok(observedTx, 'old-intact leaves residual old tx');
        assert.equal(observedTx.ownerNonce, captured.firstIds.residualOldNonce);
      } else if (row.resolveStatus === 'transaction-lock-absent') {
        assert.equal(observedTx, null);
      } else {
        assert.ok(observedTx, 'fresh-published leaves residual fresh tx');
        assert.equal(observedTx.ownerNonce, captured.firstIds.freshOwnerNonce);
      }
      const ids2 = crashWindowIds(caseNumber, 3);
      const second = await driveFreshAuthorization(harness, captured, ids2, {
        transactionLockRef: observedTx,
        ownerDead: observedTx !== null,
        queueAcquireIds: true,
        armPostLock: true,
      });
      const receipt = validateLaunchAgentReceipt(second.result);
      assertCrashWindowFinalRecovered(harness, captured, receipt, {
        expectedReceiptTrace: 1,
        expectHostMutation: true,
      });
      return;
    }

    if (row.family === 'closeout-terminal'
        || row.family === 'closeout-receipt'
        || row.family === 'closeout-tx-release'
        || row.family === 'closeout-mir-release') {
      const states = harness.journalStates(captured.transactionId);
      assert.equal(states.at(-1), 'recovered', `${row.name}: terminal already present`);
      const terminalCountBefore = states.filter((state) => state === 'recovered').length;
      assert.equal(terminalCountBefore, 1);
      const receiptBefore = harness.receiptFor(captured.transactionId);
      if (row.family === 'closeout-terminal') {
        assert.equal(receiptBefore, null, 'terminal-journal image: receipt not yet durable');
      } else {
        assert.ok(receiptBefore, `${row.name}: receipt already durable`);
      }
      const locks = harness.lockState();
      if (row.family === 'closeout-mir-release') {
        assert.equal(locks.transactionLock, false);
        assert.equal(locks.manualInterventionLock, false);
      } else if (row.family === 'closeout-tx-release') {
        assert.equal(locks.transactionLock, false);
        assert.equal(locks.manualInterventionLock, true);
      } else {
        assert.equal(locks.transactionLock, true);
        assert.equal(locks.manualInterventionLock, true);
      }

      const ids = crashWindowIds(caseNumber, 2);
      const observedTx = harness.transactionLockRefForTest();
      const driven = await driveFreshAuthorization(harness, captured, ids, {
        transactionLockRef: observedTx,
        // terminal cleanup：tx present 时 owner dead；不 acquire 新 claim ids
        ownerDead: observedTx !== null,
        queueAcquireIds: false,
      });
      const receipt = validateLaunchAgentReceipt(driven.result);
      assertCrashWindowFinalRecovered(harness, captured, receipt, {
        // terminal-journal 需从 embedded 补 exact receipt（1 次）；后三行不得 republish。
        expectedReceiptTrace: row.family === 'closeout-terminal' ? 1 : 0,
        expectHostMutation: false,
      });
      assert.equal(
        harness.journalStates(captured.transactionId)
          .filter((state) => state === 'recovered').length,
        1,
        'must not append a second terminal',
      );
      return;
    }

    // —— early / post-acquire / compensation*：单次 fresh auth 闭环 ——
    const ids = crashWindowIds(caseNumber, 2);
    const observedTx = harness.transactionLockRefForTest();
    if (row.family === 'early') {
      // attestation 后：claim absent，residual old 仍 intact
      assert.equal(harness.hasRecoveryClaim(), false);
      assert.ok(observedTx, 'early image retains residual old tx');
      assert.equal(observedTx.ownerNonce, captured.firstIds.residualOldNonce);
    } else if (row.family === 'post-acquire') {
      assert.equal(harness.hasRecoveryClaim(), false);
      assert.ok(observedTx, 'post-acquire image has fresh recovery tx');
      assert.equal(observedTx.ownerNonce, captured.firstIds.freshOwnerNonce);
    } else if (row.family === 'compensation-host') {
      assert.equal(
        harness.journalStates(captured.transactionId)
          .includes('compensate-stop-scheduler-completed'),
        false,
        'host-action image: completed not yet journaled',
      );
    } else if (row.family === 'compensation-completed') {
      assert.ok(
        harness.journalStates(captured.transactionId)
          .includes('compensate-stop-scheduler-completed'),
        'completed image must include stop-scheduler completed',
      );
    }

    const driven = await driveFreshAuthorization(harness, captured, ids, {
      transactionLockRef: observedTx,
      ownerDead: observedTx !== null,
      queueAcquireIds: true,
      armPostLock: true,
    });
    const receipt = validateLaunchAgentReceipt(driven.result);
    assertCrashWindowFinalRecovered(harness, captured, receipt, {
      expectedReceiptTrace: 1,
      expectHostMutation: true,
    });

    if (row.family === 'compensation-host' || row.family === 'compensation-completed') {
      // host-action / compensation-completed：stop-scheduler 已物理完成，不得重放；
      // 从 captured step.index + 1 起每个 frozen step 的 host event 恰 1 次。
      // 复用 frozenHostEventFor；不得以 journal includes recovered 代替动作计数。
      const resumeTrace = harness.trace();
      assert.equal(
        countTraceName(resumeTrace, frozenHostEventFor(captured.step.action)),
        0,
        `${row.name}: stop-scheduler must not replay`,
      );
      for (const remaining of captured.plan.slice(captured.step.index + 1)) {
        assert.equal(
          countTraceName(resumeTrace, frozenHostEventFor(remaining.action)),
          1,
          `${row.name}: remaining step ${remaining.action} host event must run exactly once`,
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Task 6B.2 Task 4D P1 RED — both-absent 不得把无 MIR 历史的 ordinary recovered
// compensation 误当 manual-repair 幂等成功。真实 coordinator install + before-commit
// revalidation failure → ordinary recovered；不 seed MIR / terminal helper。
// 以陈旧 closed-shape mirLockRef（不入 store）铸造 genuine capability；公共
// recoverAfterManualRepair 必须 RECOVERY_REQUIRED。当前 production 错误返回
// ordinary recovered receipt → 本测唯一有效 RED。
// ---------------------------------------------------------------------------

test('manual repair crash window both-absent rejects ordinary recovered transaction without MIR history', async () => {
  // 1) fresh harness；真实 coordinator 普通 install → before-commit 失败进入
  // ordinary frozen compensation 并成功 recovered；不得 helper 直接 seed terminal。
  const harness = createLaunchAgentLifecycleHarness();
  createCoordinatorOrRed(harness);
  harness.failNextRevalidation('before-commit');
  const runCoordinator = createFullCoordinator(harness);
  const ordinaryReceipt = validateLaunchAgentReceipt(
    await runCoordinator.install(frozenInstallInput()),
  );
  // ordinary before-commit revalidation failure：state=recovered、
  // outcome=rollback-runtime-mismatch（非 manual pure-closeout 的 outcome=recovered）。
  assert.equal(ordinaryReceipt.state, 'recovered', 'ordinary install must close recovered');
  assert.equal(ordinaryReceipt.success, false);
  assert.equal(
    ordinaryReceipt.outcome,
    'rollback-runtime-mismatch',
    'ordinary revalidation failure must carry rollback-runtime-mismatch outcome',
  );
  const transactionId = ordinaryReceipt.transactionId;
  const anchorId = ordinaryReceipt.anchorId;

  // 2) journal 有 compensating + 完整 terminal/embedded/persisted receipt，
  // 但 manual-intervention-required 数量为 0；两锁/claim absent；host 为 recovered。
  const entriesBefore = harness.journalEntries(transactionId);
  assert.ok(
    entriesBefore.some((entry) => entry.state === 'compensating'),
    'fixture: ordinary recovered must persist compensating',
  );
  assert.equal(
    entriesBefore.filter((entry) => entry.state === 'manual-intervention-required').length,
    0,
    'fixture: ordinary recovered must have zero MIR history',
  );
  const terminals = entriesBefore.filter((entry) => entry.state === 'recovered');
  assert.equal(terminals.length, 1, 'fixture: exactly one recovered terminal');
  const terminal = terminals[0];
  assert.equal(entriesBefore.at(-1).state, 'recovered');
  assert.ok(Object.hasOwn(terminal.payload, 'receipt'), 'fixture: terminal embeds receipt');
  assert.deepEqual(terminal.payload.receipt, ordinaryReceipt);
  assert.equal(
    terminal.payload.receiptSha256,
    harness.sha256(Buffer.from(JSON.stringify(terminal.payload.receipt), 'utf8')),
  );
  const receiptBefore = harness.receiptFor(transactionId);
  assert.deepEqual(receiptBefore, ordinaryReceipt, 'fixture: persisted receipt exact');
  assert.deepEqual(harness.lockState(), {
    transactionLock: false,
    manualInterventionLock: false,
  });
  assert.equal(harness.hasRecoveryClaim(), false);
  assert.equal(harness.manualInterventionLockRefForTest(), null);
  assert.equal(harness.transactionLockRefForTest(), null);
  const hostBefore = structuredClone(harness.hostSnapshot());
  assert.equal(hostBefore.controller, null);
  assert.equal(hostBefore.scheduler, null);
  assert.equal(hostBefore.manifest, null);
  assert.deepEqual(hostBefore.loaded, { controller: false, scheduler: false });
  assert.deepEqual(hostBefore.jobIdentity, { controller: null, scheduler: null });
  const anchor = harness.anchorsWritten().find((candidate) => (
    candidate.transactionId === transactionId && candidate.anchorId === anchorId
  ));
  assert.ok(anchor, 'fixture: recovered anchor target must be present');
  validateLaunchAgentTransactionPrefix({ entries: entriesBefore });

  // 3) public mintGenuineCapability：mirTransactionId 绑定 ordinary tx；
  // transactionLockRef null；anchorId 绑定 receipt；mirLockRef 为 closed valid
  // shape 且 transactionId 绑定该 tx，但不向 store seed MIR（陈旧/历史 identity）。
  // UUID/confirmation/request 独立。
  const staleMirLockRef = Object.freeze({
    kind: 'manual-intervention-lock',
    transactionId,
    ownerNonce: 'b4d00001-bbbb-4bbb-8bbb-0000000000b1',
    sha256: 'd4d0'.repeat(16),
  });
  assert.equal(
    harness.lockState().manualInterventionLock,
    false,
    'stale mirLockRef must not be seeded into store',
  );
  const { capability, confirmationId } = await mintGenuineCapability({
    mirTransactionId: transactionId,
    mirLockRef: staleMirLockRef,
    transactionLockRef: null,
    anchorId,
    confirmationId: 'a4d00001-eeee-4eee-8eee-0000000000e1',
    manualRepairRequestId: 'd4d00001-dddd-4ddd-8ddd-0000000000d1',
  });

  harness.resetObservations();
  const hostSentinelsBefore = harness.sentinels();
  const coordinator = createFullCoordinatorWithAuthoritySentinel(harness, capability);

  // 4) 公共 recoverAfterManualRepair 必须 reject RECOVERY_REQUIRED。
  // 当前 production 错误返回 ordinary recovered receipt → assert.rejects missing rejection（有效 RED）。
  await assert.rejects(
    () => coordinator.recoverAfterManualRepair(capability),
    (error) => {
      assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);
      return true;
    },
  );

  // 5) rejection 后：journal/receipt/host exact unchanged；tx/MIR/claim 仍 absent；
  // 无 acquire / owner observe / receipt publish / lock release / host mutation；
  // 只允许 authority/attestation 前导；capability replay denied。
  assert.deepEqual(
    harness.journalEntries(transactionId),
    entriesBefore,
    'must not append/mutate ordinary recovered journal',
  );
  assert.deepEqual(
    harness.receiptFor(transactionId),
    receiptBefore,
    'must not republish/replace ordinary recovered receipt',
  );
  assert.deepEqual(
    harness.hostSnapshot(),
    hostBefore,
    'host must remain the ordinary recovered anchor target',
  );
  assert.deepEqual(harness.lockState(), {
    transactionLock: false,
    manualInterventionLock: false,
  });
  assert.equal(harness.hasRecoveryClaim(), false);
  assert.equal(harness.transactionLockRefForTest(), null);
  assert.equal(harness.manualInterventionLockRefForTest(), null);

  const trace = harness.trace();
  assert.equal(trace[0], 'authority-consumed', 'authority must lead');
  assert.ok(trace.includes('attestation-verify'), 'attestation preamble required');
  assert.equal(trace.includes('recovery-lock-acquire'), false, 'no acquire');
  assert.equal(trace.includes('post-lock-snapshot'), false, 'no post-lock');
  assert.equal(trace.includes('owner-observe-1'), false, 'no owner observe');
  assert.equal(trace.includes('owner-observe-2'), false, 'no second owner observe');
  assert.equal(countTraceName(trace, 'receipt'), 0, 'no receipt publish');
  assert.equal(trace.includes('lock-release'), false, 'no tx lock release');
  assert.equal(trace.includes('mir-lock-release'), false, 'no MIR lock release');
  assert.deepEqual(harness.lockAcquisitionsForTest(), []);
  assert.deepEqual(harness.recoveryAcquisitionsForTest(), []);
  assertPublisherHostUnchanged(harness, hostSentinelsBefore);
  assert.equal(harness.hasManualRepairAttestation(confirmationId), true);
  await assertCapabilityReplayDenied(capability);
});

// ---------------------------------------------------------------------------
// Task 6B.2 Task 5 — highest-risk real-process manual repair path.
// Owner child builds MIR frozen-compensation fixture (install final action
// remove-controller / after-intent-pre), arms selected fake host evidence,
// runs authorized recover until post-mutation pre-completed, serializes crash
// image, emits READY_TO_KILL, then hangs. Parent SIGKILLs only that PID.
// Recovery child revives image, proves real dead observations, claim-fenced
// takeover, resumes without replaying the selected action.
// ---------------------------------------------------------------------------

const HIGHEST_RISK_HELPER_LEAF = 'launchagent-lock-contender.js';
const HIGHEST_RISK_HELPER_PATH = fileURLToPath(
  new URL(`./helpers/${HIGHEST_RISK_HELPER_LEAF}`, import.meta.url),
);
const HIGHEST_RISK_ROOT_PREFIX = 'linke-la-realproc-';
const HIGHEST_RISK_CHILD_TIMEOUT_MS = 20_000;
const HIGHEST_RISK_STDOUT_CAP = 64 * 1024;
const HIGHEST_RISK_STDERR_CAP = 16 * 1024;
const HIGHEST_RISK_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const HIGHEST_RISK_RESULT_MAX_BYTES = 64 * 1024;
const HIGHEST_RISK_READY_LINE = 'READY_TO_KILL\n';
const HIGHEST_RISK_SELECTED_ACTION = 'remove-controller';

const HIGHEST_RISK_FIXTURE_KEYS = Object.freeze([
  'schemaVersion',
  'operation',
  'action',
  'position',
  'sourceCommit',
  'scheduleSeconds',
  'claimId',
  'freshOwnerNonce',
  'confirmationId',
  'requestId',
  'mirNonce',
]);

const HIGHEST_RISK_RESULT_KEYS = Object.freeze([
  'status',
  'transactionId',
  'terminalJournalState',
  'receiptCount',
  'receiptValid',
  'transactionLockPresent',
  'manualInterventionLockPresent',
  'recoveryClaimPresent',
  'selectedFakeHostActionCount',
  'ownerObservationStatuses',
]);

function highestRiskCanonicalJson(value) {
  return `${JSON.stringify(value)}\n`;
}

function forceTerminateHighestRiskChild(child) {
  if (!child) return;
  try {
    if (typeof child.connected === 'boolean' && child.connected && typeof child.disconnect === 'function') {
      child.disconnect();
    }
  } catch {
    // ignore
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // ignore
  }
}

/**
 * Spawn a highest-risk contender mode with bounded stdout/stderr and watchdog.
 * @param {import('node:test').TestContext} t
 * @param {string[]} argv
 */
function spawnHighestRiskChild(t, argv) {
  const state = {
    stdout: '',
    stderr: '',
    exited: false,
    exitCode: null,
    exitSignal: null,
    failure: null,
    settled: false,
    timer: null,
    ready: false,
  };
  /** @type {{ resolve: Function, reject: Function }[]} */
  const readyWaiters = [];
  /** @type {{ resolve: Function, reject: Function }[]} */
  const exitWaiters = [];

  // Strip color-env conflict that Node emits on stderr (FORCE_COLOR + NO_COLOR).
  const childEnv = { ...process.env };
  delete childEnv.FORCE_COLOR;
  delete childEnv.NO_COLOR;
  const child = fork(HIGHEST_RISK_HELPER_PATH, argv, {
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'json',
    env: childEnv,
  });

  const settleFailure = (message) => {
    if (state.settled) return;
    state.settled = true;
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    forceTerminateHighestRiskChild(child);
    const error = new assert.AssertionError({ message });
    state.failure = error;
    for (const waiter of readyWaiters.splice(0)) waiter.reject(error);
    for (const waiter of exitWaiters.splice(0)) waiter.reject(error);
  };

  state.timer = setTimeout(() => {
    settleFailure('highest-risk real-process manual repair: child watchdog timeout');
  }, HIGHEST_RISK_CHILD_TIMEOUT_MS);

  t.after(() => {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    forceTerminateHighestRiskChild(child);
    try {
      if (child.stdout) child.stdout.destroy();
    } catch {
      // ignore
    }
    try {
      if (child.stderr) child.stderr.destroy();
    } catch {
      // ignore
    }
  });

  child.on('error', () => {
    settleFailure('highest-risk real-process manual repair: child process error');
  });

  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (state.stdout.length < HIGHEST_RISK_STDOUT_CAP) {
        state.stdout += chunk;
      }
      if (!state.ready && state.stdout.includes(HIGHEST_RISK_READY_LINE)) {
        // exact single READY line only (no other stdout before ready)
        if (state.stdout !== HIGHEST_RISK_READY_LINE) {
          settleFailure(
            'highest-risk real-process manual repair: owner stdout must be exactly READY_TO_KILL',
          );
          return;
        }
        state.ready = true;
        for (const waiter of readyWaiters.splice(0)) waiter.resolve(undefined);
      }
    });
  }
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (state.stderr.length < HIGHEST_RISK_STDERR_CAP) {
        state.stderr += chunk;
      }
    });
  }

  child.on('exit', (code, signal) => {
    state.exited = true;
    state.exitCode = code;
    state.exitSignal = signal;
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    for (const waiter of exitWaiters.splice(0)) {
      waiter.resolve({ code, signal });
    }
  });

  return {
    child,
    get pid() {
      return child.pid;
    },
    get stdout() {
      return state.stdout;
    },
    get stderr() {
      return state.stderr;
    },
    get exitCode() {
      return state.exitCode;
    },
    get exitSignal() {
      return state.exitSignal;
    },
    waitReady() {
      if (state.failure) return Promise.reject(state.failure);
      if (state.ready) return Promise.resolve();
      return new Promise((resolve, reject) => {
        readyWaiters.push({ resolve, reject });
      });
    },
    waitExit() {
      if (state.failure) return Promise.reject(state.failure);
      if (state.exited) {
        return Promise.resolve({ code: state.exitCode, signal: state.exitSignal });
      }
      return new Promise((resolve, reject) => {
        exitWaiters.push({ resolve, reject });
      });
    },
  };
}

test('highest-risk real-process manual repair recovers after owner SIGKILL at selected host action', async (t) => {
  // Task 5 exports must exist on the harness module (serialize/revive binary envelope).
  assert.equal(
    typeof launchAgentLifecycleHarnessModule.serializeLaunchAgentLifecycleCrashImageForTest,
    'function',
    'serializeLaunchAgentLifecycleCrashImageForTest must be exported',
  );
  assert.equal(
    typeof launchAgentLifecycleHarnessModule.reviveLaunchAgentLifecycleCrashImageForTest,
    'function',
    'reviveLaunchAgentLifecycleCrashImageForTest must be exported',
  );
  const serializeCrashImage =
    launchAgentLifecycleHarnessModule.serializeLaunchAgentLifecycleCrashImageForTest;
  const reviveCrashImage =
    launchAgentLifecycleHarnessModule.reviveLaunchAgentLifecycleCrashImageForTest;

  // Private temp root under realproc prefix; fixture/image/result files only.
  const tempRoot = await mkdtemp(join(tmpdir(), HIGHEST_RISK_ROOT_PREFIX));
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });
  await chmod(tempRoot, 0o700);

  const fixturePath = join(tempRoot, 'fixture.json');
  const crashImagePath = join(tempRoot, 'crash-image.bin');
  const resultPath = join(tempRoot, 'result.json');

  const fixture = {
    schemaVersion: 1,
    operation: 'install',
    action: HIGHEST_RISK_SELECTED_ACTION,
    position: 'after-intent-pre',
    sourceCommit: FROZEN_COMMIT_PRIOR,
    scheduleSeconds: 300,
    claimId: 'a5b20001-aaaa-4aaa-8aaa-000000000001',
    freshOwnerNonce: 'b5b20001-bbbb-4bbb-8bbb-000000000001',
    confirmationId: 'c5b20001-cccc-4ccc-8ccc-000000000001',
    requestId: 'd5b20001-dddd-4ddd-8ddd-000000000001',
    mirNonce: 'e5b20001-eeee-4eee-8eee-000000000001',
  };
  assert.deepEqual(Object.keys(fixture), [...HIGHEST_RISK_FIXTURE_KEYS]);
  await writeFile(fixturePath, highestRiskCanonicalJson(fixture), { mode: 0o600 });
  await chmod(fixturePath, 0o600);

  // 1) Owner: build MIR fixture, arm evidence, crash post selected host action.
  const owner = spawnHighestRiskChild(t, [
    'manual-repair-crash-owner',
    fixturePath,
    crashImagePath,
  ]);
  assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 0, 'owner pid recorded');
  const ownerPid = owner.pid;
  await owner.waitReady();
  assert.equal(owner.stdout, HIGHEST_RISK_READY_LINE, 'exactly one READY_TO_KILL line');
  assert.equal(owner.stderr, '', 'owner stderr must be empty');

  // Bounded grace window: owner must remain alive after READY until external SIGKILL.
  // A pending Promise alone is not a referenced event-loop handle; catch natural exit races.
  await new Promise((resolve) => {
    setTimeout(resolve, 100);
  });
  assert.equal(owner.exitCode, null, 'owner must not exit during READY grace window');
  assert.equal(owner.exitSignal, null, 'owner must not receive a signal during READY grace window');
  assert.equal(owner.child.exitCode, null, 'recorded owner child must still be running');
  assert.equal(owner.child.signalCode, null, 'recorded owner child must not have a signal yet');

  // SIGKILL only the recorded owner PID; await confirmed signal.
  process.kill(ownerPid, 'SIGKILL');
  const ownerExit = await owner.waitExit();
  assert.equal(ownerExit.signal, 'SIGKILL', 'owner must die by SIGKILL');
  assert.equal(ownerExit.code, null);

  // 2) Persisted image: stale recovery tx lock, post-action host/evidence,
  // missing selected completed, one MIR, no residual claim.
  const imageBytes = await readFile(crashImagePath);
  assert.ok(imageBytes.length > 0, 'crash image must be non-empty');
  assert.ok(
    imageBytes.length <= HIGHEST_RISK_IMAGE_MAX_BYTES,
    'crash image must be <= 4 MiB',
  );
  const image = reviveCrashImage(imageBytes);
  assert.equal(image.schemaVersion, 1);
  assert.ok(image.transactionLock !== null, 'stale recovery transaction lock present');
  assert.equal(
    image.transactionLock.ownerPid,
    ownerPid,
    'stale recovery lock must bind dead owner PID',
  );
  assert.ok(image.manualInterventionLock !== null, 'exactly one MIR lock');
  assert.equal(image.recoveryClaim, null, 'no residual recovery claim');
  assert.ok(
    image.selectedFakeHostActionEvidence !== null
      && image.selectedFakeHostActionEvidence.action === HIGHEST_RISK_SELECTED_ACTION
      && image.selectedFakeHostActionEvidence.count === 1,
    'selected fake host action evidence must be exactly once in image',
  );
  const imageJournalStates = image.journal
    .filter((entry) => typeof entry.state === 'string')
    .map((entry) => entry.state);
  assert.equal(
    imageJournalStates.includes(`compensate-${HIGHEST_RISK_SELECTED_ACTION}-completed`),
    false,
    'selected completed journal state must be absent in crash image',
  );
  assert.equal(
    imageJournalStates.filter((state) => state === 'manual-intervention-required').length,
    1,
    'exactly one MIR journal marker',
  );
  assert.equal(
    image.host.loaded.controller,
    false,
    'post-action host: controller unloaded after remove-controller',
  );
  // Controller file removed by selected action (install compensation final step).
  const controllerFilePresent = image.files.some((item) => (
    typeof item.key === 'string' && item.key.endsWith(':ai.linke.controller.plist')
  ));
  assert.equal(controllerFilePresent, false, 'post-action host: controller file absent');

  // Round-trip serialize of revived branded image must re-encode under 4 MiB.
  const reencoded = serializeCrashImage(image);
  assert.ok(Buffer.isBuffer(reencoded));
  assert.ok(reencoded.length <= HIGHEST_RISK_IMAGE_MAX_BYTES);

  // 3) Recovery child: fresh auth, real dead observations, no selected replay.
  const recovery = spawnHighestRiskChild(t, [
    'manual-repair-recover',
    crashImagePath,
    resultPath,
  ]);
  const recoveryExit = await recovery.waitExit();
  assert.equal(recoveryExit.code, 0, 'recovery must exit 0');
  assert.equal(recoveryExit.signal, null);
  assert.equal(recovery.stderr, '', 'recovery stderr must be empty');
  // Child contract: result-file-only — recovery stdout must be exact empty.
  assert.equal(recovery.stdout, '', 'recovery stdout must be exact empty (result-file-only)');

  const resultBytes = await readFile(resultPath);
  assert.ok(resultBytes.length > 0);
  assert.ok(resultBytes.length <= HIGHEST_RISK_RESULT_MAX_BYTES);
  const resultText = resultBytes.toString('utf8');
  assert.equal(resultText.endsWith('\n'), true, 'result must be newline-terminated');
  const resultLine = resultText.slice(0, -1);
  assert.equal(resultLine.includes('\n'), false, 'exactly one result line');
  const result = JSON.parse(resultLine);
  assert.deepEqual(
    Reflect.ownKeys(result).filter((key) => typeof key === 'string'),
    [...HIGHEST_RISK_RESULT_KEYS],
    'result envelope exact keys',
  );
  assert.equal(result.status, 'recovered');
  assert.equal(typeof result.transactionId, 'string');
  assert.match(
    result.transactionId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(result.terminalJournalState, 'recovered');
  assert.equal(result.receiptCount, 1);
  assert.equal(result.receiptValid, true);
  assert.equal(result.transactionLockPresent, false);
  assert.equal(result.manualInterventionLockPresent, false);
  assert.equal(result.recoveryClaimPresent, false);
  assert.equal(
    result.selectedFakeHostActionCount,
    1,
    'selected fake host action count exactly 1 across image/result',
  );
  assert.deepEqual(
    result.ownerObservationStatuses,
    ['dead', 'dead'],
    'two real dead owner observations required',
  );

  // No real host writes: harness-only fakes; temp root must not contain LaunchAgents.
  assert.equal(owner.stderr, '');
  assert.equal(recovery.stderr, '');
});

/**
 * Task 5 P1: focused negative coverage for serialize/revive envelope + nested
 * closed projection. Name includes the focused pattern so existing runners pick it up.
 * Starts from one valid serialized branded image; no branding seam exposed.
 */
test('highest-risk real-process manual repair serialize/revive envelope rejects noncanonical and nested corruption', async () => {
  assert.equal(
    typeof launchAgentLifecycleHarnessModule.serializeLaunchAgentLifecycleCrashImageForTest,
    'function',
  );
  assert.equal(
    typeof launchAgentLifecycleHarnessModule.reviveLaunchAgentLifecycleCrashImageForTest,
    'function',
  );
  const serializeCrashImage =
    launchAgentLifecycleHarnessModule.serializeLaunchAgentLifecycleCrashImageForTest;
  const reviveCrashImage =
    launchAgentLifecycleHarnessModule.reviveLaunchAgentLifecycleCrashImageForTest;

  // One valid branded image via real coordinator crash capture (bounded, harness-only).
  const runHarness = createLaunchAgentLifecycleHarness();
  runHarness.failNextRevalidation('before-commit');
  runHarness.armCrashCapture({
    kind: 'journal-state',
    state: 'compensating',
    occurrence: 1,
  });
  const runCoordinator = createLaunchAgentLifecycleCoordinator(runHarness.dependencies());
  const runReceipt = validateLaunchAgentReceipt(
    await runCoordinator.install(frozenInstallInput()),
  );
  assert.equal(runReceipt.state, 'recovered');
  const brandedImage = runHarness.takeCrashImage();
  const goodBytes = serializeCrashImage(brandedImage);
  assert.ok(Buffer.isBuffer(goodBytes));
  assert.ok(goodBytes.length > 0);
  assert.ok(goodBytes.length <= HIGHEST_RISK_IMAGE_MAX_BYTES);
  // Round-trip sanity: valid path still revives.
  const revivedOk = reviveCrashImage(goodBytes);
  assert.equal(revivedOk.schemaVersion, 1);

  // unbranded serialize rejects (no branding seam — plain object is not branded).
  assert.throws(
    () => serializeCrashImage({
      schemaVersion: 1,
      files: [],
      candidates: [],
      journal: [],
      anchors: [],
      receipts: [],
      transactionLock: null,
      manualInterventionLock: null,
      attestations: [],
      recoveryClaim: null,
      host: revivedOk.host,
      sequence: revivedOk.sequence,
      selectedFakeHostActionEvidence: null,
    }),
    /branded|serialize/,
    'unbranded serialize must reject',
  );

  // empty and non-Buffer revive reject.
  assert.throws(() => reviveCrashImage(Buffer.alloc(0)), /empty|revive/);
  assert.throws(() => reviveCrashImage(/** @type {any} */ ('not-a-buffer')), /Buffer|revive/);
  assert.throws(() => reviveCrashImage(/** @type {any} */ (null)), /Buffer|revive/);

  // invalid UTF-8 rejects.
  assert.throws(
    () => reviveCrashImage(Buffer.from([0xff, 0xfe, 0xfd])),
    /UTF-8|utf-8|revive/i,
  );

  // whitespace / noncanonical JSON rejects.
  const pretty = `${JSON.stringify(JSON.parse(goodBytes.toString('utf8')), null, 2)}`;
  assert.throws(
    () => reviveCrashImage(Buffer.from(pretty, 'utf8')),
    /noncanonical|revive/,
    'pretty-printed JSON must reject',
  );
  assert.throws(
    () => reviveCrashImage(Buffer.from(` ${goodBytes.toString('utf8')}`, 'utf8')),
    /noncanonical|JSON|revive/,
    'leading whitespace JSON must reject',
  );

  // helper: mutate parsed envelope and re-encode (digest may be stale/wrong).
  function envelopeBytes(mutator) {
    const parsed = JSON.parse(goodBytes.toString('utf8'));
    mutator(parsed);
    return Buffer.from(JSON.stringify(parsed), 'utf8');
  }

  // extra / missing envelope key rejects.
  assert.throws(
    () => reviveCrashImage(envelopeBytes((e) => {
      e.extra = true;
    })),
    /key|envelope|revive|crash image/i,
    'extra envelope key must reject',
  );
  assert.throws(
    () => reviveCrashImage(envelopeBytes((e) => {
      delete e.sha256;
    })),
    /key|envelope|revive|crash image/i,
    'missing envelope key must reject',
  );

  // image digest mismatch rejects.
  assert.throws(
    () => reviveCrashImage(envelopeBytes((e) => {
      e.sha256 = 'b'.repeat(64);
    })),
    /digest|mismatch|revive/,
    'image digest mismatch must reject',
  );

  // >4 MiB rejects before parse.
  assert.throws(
    () => reviveCrashImage(Buffer.alloc(HIGHEST_RISK_IMAGE_MAX_BYTES + 1)),
    /4 MiB|over|revive/,
    '>4 MiB must reject before parse',
  );

  // one representative nested extra-key corruption rejects (runtimeArtifacts extra field).
  assert.throws(
    () => reviveCrashImage(envelopeBytes((e) => {
      e.image.host.runtimeArtifacts.extra = { pathId: 'nope', sha256: 'c'.repeat(64) };
      e.sha256 = 'a'.repeat(64);
    })),
    /runtimeArtifacts|key|crash image|revive/i,
    'runtimeArtifacts extra field must reject',
  );

  // one representative nested hash/binding corruption rejects (candidate hash).
  assert.ok(
    Array.isArray(revivedOk.candidates) && revivedOk.candidates.length > 0,
    'fixture must expose at least one candidate for nested hash corruption',
  );
  assert.throws(
    () => reviveCrashImage(envelopeBytes((e) => {
      e.image.candidates[0].sha256 = 'd'.repeat(64);
      e.sha256 = 'a'.repeat(64);
    })),
    /hash|mismatch|candidate|crash image|revive/i,
    'nested candidate hash corruption must reject',
  );

  // compact: one duplicate logical key in map-like array rejects (files).
  assert.ok(
    Array.isArray(revivedOk.files) && revivedOk.files.length > 0,
    'fixture must expose at least one file for duplicate-key corruption',
  );
  assert.throws(
    () => reviveCrashImage(envelopeBytes((e) => {
      e.image.files.push(structuredClone(e.image.files[0]));
      e.sha256 = 'a'.repeat(64);
    })),
    /duplicate|files|crash image|revive/i,
    'duplicate files logical key must reject',
  );
});
