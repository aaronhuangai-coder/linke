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
import { test } from 'node:test';

import {
  LAUNCHAGENT_LIFECYCLE_CODES,
  LaunchAgentLifecycleError,
  validateLaunchAgentAcceptanceRequest,
  validateLaunchAgentCapabilityProjection,
  validateLaunchAgentConfirmationRecord,
  validateLaunchAgentConsumedConfirmation,
  validateLaunchAgentManualRepairAttestation,
} from '../src/launchagent-lifecycle/contracts.js';
import {
  assertAndConsumeLaunchAgentManualRepairAuthority,
  consumeAndAuthorizeManualRepair,
} from '../src/launchagent-lifecycle/acceptance-gate.js';
import * as metadataStoreModule from '../src/launchagent-lifecycle/metadata-store.js';
import { createLaunchAgentLifecycleCoordinator } from '../src/launchagent-lifecycle/transaction-coordinator.js';
import { createLaunchAgentLifecycleHarness } from './helpers/launchagent-lifecycle-harness.js';

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
