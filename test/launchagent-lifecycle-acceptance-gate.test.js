/**
 * V1.46 Task 6A Task 3 — acceptance-gate 两阶段 TDD 测试（test-first）。
 *
 * 冻结 prepare / consume-before-mint / 一次性私有人工权限 / 禁用零副作用 facade 的对外契约。
 * RED 阶段：生产模块 acceptance-gate.js 缺席时，仅注册并失败一条存在性断言
 *   （消息「missing acceptance-gate.js is the intended RED」）；不注册行为套件。
 * GREEN / 当前状态：生产模块存在时，存在性断言通过，并在 gateExists 分支内注册完整行为套件。
 * 行为断言始终位于 gateExists 内，避免条件导入或 fixture 语法在缺席时产生第二失败。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as nodeFsPromises from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  LAUNCHAGENT_LIFECYCLE,
  LAUNCHAGENT_LIFECYCLE_CODES,
  LaunchAgentLifecycleError,
  validateLaunchAgentAcceptanceRequest,
  validateLaunchAgentCapabilityProjection,
  validateLaunchAgentConfirmationRecord,
  validateLaunchAgentConsumedConfirmation,
} from '../src/launchagent-lifecycle/contracts.js';
import {
  createLaunchAgentMetadataStoreForTest,
} from '../src/launchagent-lifecycle/metadata-store.js';

// ---------------------------------------------------------------------------
// 两阶段 TDD 骨架：
// RED — 生产模块缺席：仅本条存在性失败（intended RED）；不注册行为套件。
// GREEN / 当前 — 生产模块存在：存在性通过，下方 if (gateExists) 注册完整行为套件。
// ---------------------------------------------------------------------------

const gateUrl = new URL('../src/launchagent-lifecycle/acceptance-gate.js', import.meta.url);
const gateExists = existsSync(fileURLToPath(gateUrl));

test('Task 6A acceptance gate production module exists', () => {
  assert.equal(gateExists, true, 'missing acceptance-gate.js is the intended RED');
});

// ---------------------------------------------------------------------------
// 手写字面量 fixture 与测试辅助（仅依赖已存在的 contracts / metadata-store）。
// ---------------------------------------------------------------------------

/** 规范 UUID（version 4 / variant 8 形态，满足 contracts UUID_PATTERN）。 */
const UUID = Object.freeze({
  acceptance: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  confirmation: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  confirmationAlt: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  manualRepair: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  manualConfirmation: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  mirTx: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  ownerNonce: '11111111-1111-4111-8111-111111111111',
  ownerNonceAlt: '22222222-2222-4222-8222-222222222222',
  anchor: '33333333-3333-4333-8333-333333333333',
  anchorDrift: '44444444-4444-4444-8444-444444444444',
  txLock: '55555555-5555-4555-8555-555555555555',
  txNonce: '66666666-6666-4666-8666-666666666666',
});

const COMMIT_A = '0123456789abcdef0123456789abcdef01234567';
const COMMIT_B = 'fedcba9876543210fedcba9876543210fedcba98';
const SHA_ROOT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_RUNTIME = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SHA_REPAIR = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const SHA_MIR_LOCK = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const SHA_TX_LOCK = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const SHA_DRIFT = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
const TS_PREPARED = '2026-08-02T10:00:00.000Z';
const TS_CONFIRMED = '2026-08-02T10:05:00.000Z';
const TS_NOW = '2026-08-02T12:00:00.000Z';
const TS_NOW_LATER = '2026-08-02T12:00:01.000Z';
const UID_A = 501;

const DISABLED_METHOD_KEYS = Object.freeze([
  'install',
  'managedUpgrade',
  'stop',
  'rollback',
  'uninstall',
  'recover',
  'recoverAfterManualRepair',
]);

/** 断言为闭合生命周期错误码（code/message 同值）。 */
function assertLifecycleCode(error, code) {
  assert.ok(error instanceof LaunchAgentLifecycleError, 'expected LaunchAgentLifecycleError');
  assert.equal(error.code, code);
  assert.equal(error.message, code);
}
/** 固定时钟：now() 返回字面量 UTC。 */
function fixedClock(iso = TS_NOW) {
  return Object.freeze({
    now() {
      return iso;
    },
  });
}
/** 深冻结（测试侧辅助；与生产语义对齐，不替代生产 deepFreeze）。 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}

/** 非生产准备输入（exact keys，不含 schema/kind/flags）。 */
function nonProductionPrepareInput(overrides = {}) {
  return {
    acceptanceId: UUID.acceptance,
    uid: UID_A,
    launchAgentsRootId: LAUNCHAGENT_LIFECYCLE.rootIds.launchAgents,
    launchAgentsRootSha256: SHA_ROOT,
    sourceCommit: COMMIT_A,
    runtimeArtifactsSha256: SHA_RUNTIME,
    preparedAt: TS_PREPARED,
    ...overrides,
  };
}

/** 期望的非生产 request 投影（经真实 validator）。 */
function expectedNonProductionRequest(overrides = {}) {
  return validateLaunchAgentAcceptanceRequest({
    schemaVersion: 1,
    kind: 'non-production-acceptance-request',
    acceptanceId: UUID.acceptance,
    uid: UID_A,
    launchAgentsRootId: LAUNCHAGENT_LIFECYCLE.rootIds.launchAgents,
    launchAgentsRootSha256: SHA_ROOT,
    sourceCommit: COMMIT_A,
    runtimeArtifactsSha256: SHA_RUNTIME,
    executeRequested: false,
    nonProductionConfirmed: false,
    preparedAt: TS_PREPARED,
    ...overrides,
  });
}

/** 人工修复准备输入。 */
function manualPrepareInput(overrides = {}) {
  return {
    manualRepairRequestId: UUID.manualRepair,
    mirTransactionId: UUID.mirTx,
    mirLockIdentitySha256: SHA_MIR_LOCK,
    anchorId: UUID.anchor,
    repairDeclarationSha256: SHA_REPAIR,
    preparedAt: TS_PREPARED,
    ...overrides,
  };
}

/** 期望的人工 request 投影。 */
function expectedManualRequest(overrides = {}) {
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
    ...overrides,
  });
}

/** 非生产 confirmation 字面量（经真实 validator）。 */
function nonProductionConfirmation(overrides = {}) {
  return validateLaunchAgentConfirmationRecord({
    schemaVersion: 1,
    kind: 'non-production-confirmation',
    confirmationId: UUID.confirmation,
    acceptanceId: UUID.acceptance,
    confirmed: true,
    confirmedAt: TS_CONFIRMED,
    ...overrides,
  });
}

/** 人工 confirmation 字面量。 */
function manualConfirmation(overrides = {}) {
  return validateLaunchAgentConfirmationRecord({
    schemaVersion: 1,
    kind: 'manual-repair-confirmation',
    confirmationId: UUID.manualConfirmation,
    manualRepairRequestId: UUID.manualRepair,
    confirmed: true,
    confirmedAt: TS_CONFIRMED,
    ...overrides,
  });
}

/** 非生产 facts 精确形状。 */
function nonProductionFacts(overrides = {}) {
  return {
    uid: UID_A,
    launchAgentsRootId: LAUNCHAGENT_LIFECYCLE.rootIds.launchAgents,
    launchAgentsRootSha256: SHA_ROOT,
    sourceCommit: COMMIT_A,
    runtimeArtifactsSha256: SHA_RUNTIME,
    ...overrides,
  };
}

/** 人工 facts 精确形状（含 lock ref）。 */
function manualFacts(overrides = {}) {
  return {
    mirTransactionId: UUID.mirTx,
    mirLockRef: {
      kind: 'manual-intervention-lock',
      transactionId: UUID.mirTx,
      ownerNonce: UUID.ownerNonce,
      sha256: SHA_MIR_LOCK,
    },
    transactionLockRef: null,
    anchorId: UUID.anchor,
    repairDeclarationSha256: SHA_REPAIR,
    ...overrides,
  };
}

/**
 * 窄 instrumentation store：记录可见轨迹，并可注入 consume/readback 行为。
 * 默认内存 durable map 模拟 O_EXCL no-clobber → confirmation-consumed。
 */
function createInstrumentedConfirmationStore(options = {}) {
  const durable = options.durable ?? new Map();
  const trace = [];
  const consumeImpl = options.consumeImpl;
  const readImpl = options.readImpl;

  return {
    durable,
    trace,
    store: Object.freeze({
      async consumeConfirmation(record) {
        const snapshot = record !== null && typeof record === 'object'
          ? { ...record }
          : record;
        trace.push({ step: 'consumeConfirmation', record: snapshot });
        if (typeof consumeImpl === 'function') {
          return consumeImpl(record, durable, trace);
        }
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
          sha256: SHA_ROOT,
        });
      },
      async readConsumedConfirmation(confirmationId) {
        trace.push({ step: 'readConsumedConfirmation', confirmationId });
        if (typeof readImpl === 'function') {
          return readImpl(confirmationId, durable, trace);
        }
        const stored = durable.get(confirmationId);
        if (stored === undefined) {
          throw new LaunchAgentLifecycleError();
        }
        return validateLaunchAgentConsumedConfirmation({ ...stored });
      },
    }),
  };
}

/** 真实临时 metadata store（并发 / 重放耐久性）。 */
async function createTempMetadataStore(t) {
  const root = await mkdtemp(join(tmpdir(), 'linke-acceptance-gate-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const store = createLaunchAgentMetadataStoreForTest({
    metadataRoot: root,
    fs: nodeFsPromises,
    onDurabilityEvent() {},
  });
  await store.initialize();
  return store;
}

/** 恶意 accessor 输入：任何属性读取递增 counter。 */
function hostileAccessorBag(base, counter) {
  const keys = Object.keys(base);
  const target = { ...base };
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === 'string') counter.gets += 1;
      return Reflect.get(obj, prop, receiver);
    },
    has(obj, prop) {
      counter.has += 1;
      return Reflect.has(obj, prop);
    },
    ownKeys(obj) {
      counter.ownKeys += 1;
      return Reflect.ownKeys(obj);
    },
    getOwnPropertyDescriptor(obj, prop) {
      counter.descriptors += 1;
      return Reflect.getOwnPropertyDescriptor(obj, prop);
    },
  });
}

// ---------------------------------------------------------------------------
// 行为套件：仅当生产模块存在时注册（GREEN 波次才执行）。
// ---------------------------------------------------------------------------

if (gateExists) {
  const gate = await import(gateUrl.href);

  // ---- 导出面 -------------------------------------------------------------

  test('Task 6A acceptance gate exports the six frozen deep-module functions', () => {
    const frozenExports = [
      'prepareLaunchAgentAcceptanceRequest',
      'prepareLaunchAgentManualRepairRequest',
      'consumeAndAuthorizeNonProductionConfirmation',
      'consumeAndAuthorizeManualRepair',
      'assertAndConsumeLaunchAgentManualRepairAuthority',
      'createDisabledLaunchAgentLifecycleFacade',
    ];
    // 命名空间键集合必须恰好等于冻结六导出，禁止第七个导出混过
    assert.deepEqual(
      Reflect.ownKeys(gate).filter((k) => typeof k === 'string').sort(),
      [...frozenExports].sort(),
    );
    for (const name of frozenExports) {
      assert.equal(typeof gate[name], 'function', `export ${name} must be a function`);
    }
  });

  // ---- 1. 纯 prepare 函数 -------------------------------------------------

  test('prepareLaunchAgentAcceptanceRequest 投影为 exact 非生产 request 且深冻结/脱离', () => {
    const input = nonProductionPrepareInput();
    const prepared = gate.prepareLaunchAgentAcceptanceRequest(input);
    const expected = expectedNonProductionRequest();

    assert.deepEqual(prepared, expected);
    assert.deepEqual(
      prepared,
      validateLaunchAgentAcceptanceRequest(prepared),
    );
    assert.ok(Object.isFrozen(prepared));
    for (const key of Reflect.ownKeys(prepared)) {
      const nested = prepared[key];
      if (nested !== null && typeof nested === 'object') {
        assert.ok(Object.isFrozen(nested));
      }
    }

    // 脱离：调用方事后改写输入不影响输出
    input.acceptanceId = UUID.confirmationAlt;
    input.sourceCommit = COMMIT_B;
    assert.equal(prepared.acceptanceId, UUID.acceptance);
    assert.equal(prepared.sourceCommit, COMMIT_A);
    assert.equal(prepared.executeRequested, false);
    assert.equal(prepared.nonProductionConfirmed, false);
    assert.equal(
      Reflect.ownKeys(prepared).length,
      Reflect.ownKeys(expected).length,
    );
  });

  test('prepareLaunchAgentAcceptanceRequest 对额外键/旧别名/畸形值/true 标志 fail-closed 且不触发 accessor', () => {
    let accessorHits = 0;
    const withAccessorFlag = {
      ...nonProductionPrepareInput(),
      get executeRequested() {
        accessorHits += 1;
        return true;
      },
    };
    assert.throws(
      () => gate.prepareLaunchAgentAcceptanceRequest(withAccessorFlag),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.INVALID);
        return true;
      },
    );
    assert.equal(accessorHits, 0);

    const withExtra = {
      ...nonProductionPrepareInput(),
      nonProductionConfirmed: true,
    };
    assert.throws(
      () => gate.prepareLaunchAgentAcceptanceRequest(withExtra),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.INVALID);
        return true;
      },
    );

    const withOldAlias = {
      ...nonProductionPrepareInput(),
      acceptance_id: UUID.acceptance,
    };
    assert.throws(
      () => gate.prepareLaunchAgentAcceptanceRequest(withOldAlias),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.INVALID);
        return true;
      },
    );

    const malformed = nonProductionPrepareInput({ acceptanceId: 'not-a-uuid' });
    assert.throws(
      () => gate.prepareLaunchAgentAcceptanceRequest(malformed),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.INVALID);
        return true;
      },
    );

    assert.throws(
      () => gate.prepareLaunchAgentAcceptanceRequest(null),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.INVALID);
        return true;
      },
    );
  });

  test('prepareLaunchAgentManualRepairRequest 投影为 exact 人工 request 且深冻结/脱离', () => {
    const input = manualPrepareInput();
    const prepared = gate.prepareLaunchAgentManualRepairRequest(input);
    const expected = expectedManualRequest();

    assert.deepEqual(prepared, expected);
    assert.deepEqual(
      prepared,
      validateLaunchAgentAcceptanceRequest(prepared),
    );
    assert.ok(Object.isFrozen(prepared));

    input.manualRepairRequestId = UUID.confirmationAlt;
    input.repairDeclarationSha256 = SHA_DRIFT;
    assert.equal(prepared.manualRepairRequestId, UUID.manualRepair);
    assert.equal(prepared.repairDeclarationSha256, SHA_REPAIR);
    assert.equal(prepared.executeRequested, false);
    assert.equal(prepared.manualRepairConfirmed, false);
  });

  test('prepareLaunchAgentManualRepairRequest 对额外键/accessor/true 标志 fail-closed 且不触发 getter', () => {
    let hits = 0;
    const withGetter = {
      ...manualPrepareInput(),
      get manualRepairConfirmed() {
        hits += 1;
        return true;
      },
    };
    assert.throws(
      () => gate.prepareLaunchAgentManualRepairRequest(withGetter),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.INVALID);
        return true;
      },
    );
    assert.equal(hits, 0);

    assert.throws(
      () => gate.prepareLaunchAgentManualRepairRequest({
        ...manualPrepareInput(),
        executeRequested: true,
      }),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.INVALID);
        return true;
      },
    );
  });

  // ---- 2. 非生产 consume-before-mint --------------------------------------

  test('consumeAndAuthorizeNonProductionConfirmation 按固定轨迹 consume-before-mint 并返回冻结能力', async () => {
    const timeline = [];
    const request = expectedNonProductionRequest();
    const confirmation = nonProductionConfirmation();
    const facts = nonProductionFacts();
    const { store, durable, trace: storeTrace } = createInstrumentedConfirmationStore();
    // 合并 store 与 facts 到同一可见轨迹
    const originalConsume = store.consumeConfirmation;
    const originalRead = store.readConsumedConfirmation;
    const wrappedStore = Object.freeze({
      async consumeConfirmation(record) {
        timeline.push('consumeConfirmation');
        return originalConsume(record);
      },
      async readConsumedConfirmation(id) {
        timeline.push('readConsumedConfirmation');
        return originalRead(id);
      },
    });
    const factsReader = {
      calls: 0,
      readCurrentFacts() {
        factsReader.calls += 1;
        timeline.push(`facts-${factsReader.calls === 1 ? 'A' : 'B'}`);
        return { ...facts };
      },
    };
    const clock = fixedClock(TS_NOW);

    const capability = await gate.consumeAndAuthorizeNonProductionConfirmation({
      request,
      confirmation,
      metadataStore: wrappedStore,
      readCurrentFacts: () => factsReader.readCurrentFacts(),
      clock,
    });

    // 可见轨迹：facts A → consume → readback → facts B → mint
    assert.deepEqual(timeline, [
      'facts-A',
      'consumeConfirmation',
      'readConsumedConfirmation',
      'facts-B',
    ]);
    assert.equal(factsReader.calls, 2);

    // durable 记录为 legacy 分支（无 kind）
    const expectedConsumed = validateLaunchAgentConsumedConfirmation({
      schemaVersion: 1,
      confirmationId: UUID.confirmation,
      acceptanceId: UUID.acceptance,
      sourceCommit: COMMIT_A,
      runtimeArtifactsSha256: SHA_RUNTIME,
      consumedAt: TS_NOW,
    });
    assert.deepEqual(durable.get(UUID.confirmation), expectedConsumed);
    assert.equal(storeTrace[0].step, 'consumeConfirmation');
    assert.deepEqual(storeTrace[0].record, expectedConsumed);

    // 能力投影
    const expectedCapability = validateLaunchAgentCapabilityProjection({
      schemaVersion: 1,
      acceptanceId: UUID.acceptance,
      confirmationId: UUID.confirmation,
      executeAuthorized: true,
      sourceCommit: COMMIT_A,
      runtimeArtifactsSha256: SHA_RUNTIME,
      issuedAt: TS_NOW,
    });
    assert.deepEqual(capability, expectedCapability);
    assert.ok(Object.isFrozen(capability));
    assert.equal(capability.executeAuthorized, true);
  });

  test('consumeAndAuthorizeNonProductionConfirmation 在 facts 不匹配或 A/B 漂移时 fail-closed 且不 mint', async () => {
    const request = expectedNonProductionRequest();
    const confirmation = nonProductionConfirmation();
    const { store, durable } = createInstrumentedConfirmationStore();

    // 绑定 facts 与 request 不一致（mint 前拒绝）
    await assert.rejects(
      () => gate.consumeAndAuthorizeNonProductionConfirmation({
        request,
        confirmation,
        metadataStore: store,
        readCurrentFacts: () => nonProductionFacts({ sourceCommit: COMMIT_B }),
        clock: fixedClock(),
      }),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.ACCEPTANCE_GATE_DENIED);
        return true;
      },
    );
    assert.equal(durable.size, 0);

    // A/B 漂移：consume 后 facts B 变化 → deny，确认已烧毁
    let n = 0;
    const driftStore = createInstrumentedConfirmationStore();
    await assert.rejects(
      () => gate.consumeAndAuthorizeNonProductionConfirmation({
        request,
        confirmation,
        metadataStore: driftStore.store,
        readCurrentFacts: () => {
          n += 1;
          if (n === 1) return nonProductionFacts();
          return nonProductionFacts({ runtimeArtifactsSha256: SHA_DRIFT });
        },
        clock: fixedClock(),
      }),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.ACCEPTANCE_GATE_DENIED);
        return true;
      },
    );
    assert.ok(driftStore.durable.has(UUID.confirmation));

    // 重放：confirmation-consumed，永不 mint
    await assert.rejects(
      () => gate.consumeAndAuthorizeNonProductionConfirmation({
        request,
        confirmation,
        metadataStore: driftStore.store,
        readCurrentFacts: () => nonProductionFacts(),
        clock: fixedClock(),
      }),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.CONFIRMATION_CONSUMED);
        return true;
      },
    );
  });

  test('consumeAndAuthorizeNonProductionConfirmation 拒绝错误 confirmation 分支与绑定失配', async () => {
    const request = expectedNonProductionRequest();
    const { store, durable } = createInstrumentedConfirmationStore();

    // 人工 confirmation 进入非生产授权
    await assert.rejects(
      () => gate.consumeAndAuthorizeNonProductionConfirmation({
        request,
        confirmation: manualConfirmation(),
        metadataStore: store,
        readCurrentFacts: () => nonProductionFacts(),
        clock: fixedClock(),
      }),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.ACCEPTANCE_GATE_DENIED);
        return true;
      },
    );
    assert.equal(durable.size, 0);

    // acceptanceId 绑定失配
    await assert.rejects(
      () => gate.consumeAndAuthorizeNonProductionConfirmation({
        request,
        confirmation: nonProductionConfirmation({
          confirmationId: UUID.confirmationAlt,
          acceptanceId: UUID.manualRepair,
        }),
        metadataStore: store,
        readCurrentFacts: () => nonProductionFacts(),
        clock: fixedClock(),
      }),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.ACCEPTANCE_GATE_DENIED);
        return true;
      },
    );
    assert.equal(durable.size, 0);
  });

  test('consumeAndAuthorizeNonProductionConfirmation 对畸形依赖/readback 失配/方法形态 fail-closed', async () => {
    const request = expectedNonProductionRequest();
    const confirmation = nonProductionConfirmation();
    const facts = nonProductionFacts();

    // 缺少 metadataStore 方法
    await assert.rejects(
      () => gate.consumeAndAuthorizeNonProductionConfirmation({
        request,
        confirmation,
        metadataStore: {},
        readCurrentFacts: () => facts,
        clock: fixedClock(),
      }),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.INVALID);
        return true;
      },
    );

    // clock.now 非函数
    await assert.rejects(
      () => gate.consumeAndAuthorizeNonProductionConfirmation({
        request,
        confirmation,
        metadataStore: createInstrumentedConfirmationStore().store,
        readCurrentFacts: () => facts,
        clock: { now: TS_NOW },
      }),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.INVALID);
        return true;
      },
    );

    // readback 字节/值失配
    const mismatch = createInstrumentedConfirmationStore({
      readImpl() {
        return validateLaunchAgentConsumedConfirmation({
          schemaVersion: 1,
          confirmationId: UUID.confirmation,
          acceptanceId: UUID.acceptance,
          sourceCommit: COMMIT_B,
          runtimeArtifactsSha256: SHA_RUNTIME,
          consumedAt: TS_NOW,
        });
      },
    });
    await assert.rejects(
      () => gate.consumeAndAuthorizeNonProductionConfirmation({
        request,
        confirmation,
        metadataStore: mismatch.store,
        readCurrentFacts: () => facts,
        clock: fixedClock(),
      }),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.ACCEPTANCE_GATE_DENIED);
        return true;
      },
    );

    // consume 抛错 → 不 mint
    const failConsume = createInstrumentedConfirmationStore({
      consumeImpl() {
        throw new LaunchAgentLifecycleError();
      },
    });
    await assert.rejects(
      () => gate.consumeAndAuthorizeNonProductionConfirmation({
        request,
        confirmation,
        metadataStore: failConsume.store,
        readCurrentFacts: () => facts,
        clock: fixedClock(),
      }),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.INVALID);
        return true;
      },
    );

    // 恶意 Proxy request：在验证阶段 fail-closed，且不得触发任何 trap
    const counter = { gets: 0, has: 0, ownKeys: 0, descriptors: 0 };
    await assert.rejects(
      () => gate.consumeAndAuthorizeNonProductionConfirmation({
        request: hostileAccessorBag(request, counter),
        confirmation,
        metadataStore: createInstrumentedConfirmationStore().store,
        readCurrentFacts: () => facts,
        clock: fixedClock(),
      }),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.INVALID);
        return true;
      },
    );
    assert.equal(counter.gets, 0, 'Proxy get trap must not run');
    assert.equal(counter.has, 0, 'Proxy has trap must not run');
    assert.equal(counter.ownKeys, 0, 'Proxy ownKeys trap must not run');
    assert.equal(counter.descriptors, 0, 'Proxy getOwnPropertyDescriptor trap must not run');
  });

  // ---- 3. 人工 consume-before-mint 与私有 authority -----------------------

  test('consumeAndAuthorizeManualRepair 按轨迹 consume-before-mint 并返回脱敏冻结能力', async () => {
    const timeline = [];
    const request = expectedManualRequest();
    const confirmation = manualConfirmation();
    const facts = manualFacts();
    const { store, durable } = createInstrumentedConfirmationStore();
    const wrappedStore = Object.freeze({
      async consumeConfirmation(record) {
        timeline.push('consumeConfirmation');
        return store.consumeConfirmation(record);
      },
      async readConsumedConfirmation(id) {
        timeline.push('readConsumedConfirmation');
        return store.readConsumedConfirmation(id);
      },
    });
    let factsCalls = 0;
    const capability = await gate.consumeAndAuthorizeManualRepair({
      request,
      confirmation,
      metadataStore: wrappedStore,
      readCurrentFacts: () => {
        factsCalls += 1;
        timeline.push(`facts-${factsCalls === 1 ? 'A' : 'B'}`);
        return {
          mirTransactionId: facts.mirTransactionId,
          mirLockRef: { ...facts.mirLockRef },
          transactionLockRef: facts.transactionLockRef,
          anchorId: facts.anchorId,
          repairDeclarationSha256: facts.repairDeclarationSha256,
        };
      },
      clock: fixedClock(TS_NOW),
    });

    assert.deepEqual(timeline, [
      'facts-A',
      'consumeConfirmation',
      'readConsumedConfirmation',
      'facts-B',
    ]);
    assert.equal(factsCalls, 2);

    const expectedConsumed = validateLaunchAgentConsumedConfirmation({
      schemaVersion: 1,
      kind: 'manual-repair-consumed-confirmation',
      confirmationId: UUID.manualConfirmation,
      manualRepairRequestId: UUID.manualRepair,
      mirTransactionId: UUID.mirTx,
      mirLockIdentitySha256: SHA_MIR_LOCK,
      anchorId: UUID.anchor,
      repairDeclarationSha256: SHA_REPAIR,
      consumedAt: TS_NOW,
    });
    assert.deepEqual(durable.get(UUID.manualConfirmation), expectedConsumed);

    const expectedCapability = validateLaunchAgentCapabilityProjection({
      schemaVersion: 1,
      kind: 'launchagent-manual-repair',
      manualRepairRequestId: UUID.manualRepair,
      mirTransactionId: UUID.mirTx,
      mirLockIdentitySha256: SHA_MIR_LOCK,
      anchorId: UUID.anchor,
      repairDeclarationSha256: SHA_REPAIR,
      authorizedAt: TS_NOW,
    });
    assert.deepEqual(capability, expectedCapability);
    assert.ok(Object.isFrozen(capability));

    // 公开能力不得暴露 confirmationId 或 lock refs
    assert.equal(Object.hasOwn(capability, 'confirmationId'), false);
    assert.equal(Object.hasOwn(capability, 'manualRepairConfirmationId'), false);
    assert.equal(Object.hasOwn(capability, 'mirLockRef'), false);
    assert.equal(Object.hasOwn(capability, 'transactionLockRef'), false);
  });

  test('assertAndConsumeLaunchAgentManualRepairAuthority 仅接受对象身份、删除 brand、返回冻结私有 authority', async () => {
    const request = expectedManualRequest();
    const confirmation = manualConfirmation();
    const facts = manualFacts({
      transactionLockRef: {
        kind: 'transaction-lock',
        transactionId: UUID.txLock,
        ownerNonce: UUID.txNonce,
        sha256: SHA_TX_LOCK,
      },
    });
    const { store } = createInstrumentedConfirmationStore();

    const capability = await gate.consumeAndAuthorizeManualRepair({
      request,
      confirmation,
      metadataStore: store,
      readCurrentFacts: () => ({
        mirTransactionId: facts.mirTransactionId,
        mirLockRef: { ...facts.mirLockRef },
        transactionLockRef: {
          kind: 'transaction-lock',
          transactionId: UUID.txLock,
          ownerNonce: UUID.txNonce,
          sha256: SHA_TX_LOCK,
        },
        anchorId: facts.anchorId,
        repairDeclarationSha256: facts.repairDeclarationSha256,
      }),
      clock: fixedClock(TS_NOW),
    });

    const authority = gate.assertAndConsumeLaunchAgentManualRepairAuthority(capability);
    assert.ok(Object.isFrozen(authority));
    assert.deepEqual(
      Reflect.ownKeys(authority).sort(),
      [
        'manualRepairConfirmationId',
        'mirLockRef',
        'projection',
        'transactionLockRef',
      ].sort(),
    );
    assert.equal(authority.manualRepairConfirmationId, UUID.manualConfirmation);
    assert.deepEqual(authority.mirLockRef, facts.mirLockRef);
    assert.deepEqual(authority.transactionLockRef, facts.transactionLockRef);
    assert.deepEqual(
      authority.projection,
      validateLaunchAgentCapabilityProjection(capability),
    );
    assert.ok(Object.isFrozen(authority.mirLockRef));
    assert.ok(Object.isFrozen(authority.transactionLockRef));
    assert.ok(Object.isFrozen(authority.projection));

    // 二次断言：brand 已删除 → acceptance-gate-denied
    assert.throws(
      () => gate.assertAndConsumeLaunchAgentManualRepairAuthority(capability),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.ACCEPTANCE_GATE_DENIED);
        return true;
      },
    );
  });

  test('assertAndConsumeLaunchAgentManualRepairAuthority 映射 absent/lookalike/clone/Proxy/primitive 为 acceptance-gate-denied', async () => {
    const request = expectedManualRequest();
    const confirmation = manualConfirmation();
    const facts = manualFacts();
    const { store } = createInstrumentedConfirmationStore();
    const capability = await gate.consumeAndAuthorizeManualRepair({
      request,
      confirmation,
      metadataStore: store,
      readCurrentFacts: () => ({
        mirTransactionId: facts.mirTransactionId,
        mirLockRef: { ...facts.mirLockRef },
        transactionLockRef: null,
        anchorId: facts.anchorId,
        repairDeclarationSha256: facts.repairDeclarationSha256,
      }),
      clock: fixedClock(),
    });

    const denied = (fn) => {
      assert.throws(fn, (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.ACCEPTANCE_GATE_DENIED);
        return true;
      });
    };

    denied(() => gate.assertAndConsumeLaunchAgentManualRepairAuthority(undefined));
    denied(() => gate.assertAndConsumeLaunchAgentManualRepairAuthority(null));
    denied(() => gate.assertAndConsumeLaunchAgentManualRepairAuthority('capability'));
    denied(() => gate.assertAndConsumeLaunchAgentManualRepairAuthority(42));
    denied(() => gate.assertAndConsumeLaunchAgentManualRepairAuthority({
      schemaVersion: 1,
      kind: 'launchagent-manual-repair',
      manualRepairRequestId: UUID.manualRepair,
      mirTransactionId: UUID.mirTx,
      mirLockIdentitySha256: SHA_MIR_LOCK,
      anchorId: UUID.anchor,
      repairDeclarationSha256: SHA_REPAIR,
      authorizedAt: TS_NOW,
    }));
    denied(() => gate.assertAndConsumeLaunchAgentManualRepairAuthority(
      structuredClone(capability),
    ));
    denied(() => gate.assertAndConsumeLaunchAgentManualRepairAuthority(
      JSON.parse(JSON.stringify(capability)),
    ));
    denied(() => gate.assertAndConsumeLaunchAgentManualRepairAuthority(
      new Proxy(capability, {}),
    ));

    // 真品仍可一次消费
    const authority = gate.assertAndConsumeLaunchAgentManualRepairAuthority(capability);
    assert.equal(authority.manualRepairConfirmationId, UUID.manualConfirmation);
    // 用后即焚
    denied(() => gate.assertAndConsumeLaunchAgentManualRepairAuthority(capability));
  });

  test('consumeAndAuthorizeManualRepair 错误分支/绑定变更/恶意输入 fail-closed', async () => {
    const request = expectedManualRequest();
    const { store, durable } = createInstrumentedConfirmationStore();

    // 非生产 confirmation 进入人工授权
    await assert.rejects(
      () => gate.consumeAndAuthorizeManualRepair({
        request,
        confirmation: nonProductionConfirmation(),
        metadataStore: store,
        readCurrentFacts: () => manualFacts(),
        clock: fixedClock(),
      }),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.ACCEPTANCE_GATE_DENIED);
        return true;
      },
    );
    assert.equal(durable.size, 0);

    // 绑定变更：confirmation 指向其他 request id
    await assert.rejects(
      () => gate.consumeAndAuthorizeManualRepair({
        request,
        confirmation: manualConfirmation({
          confirmationId: UUID.confirmationAlt,
          manualRepairRequestId: UUID.acceptance,
        }),
        metadataStore: store,
        readCurrentFacts: () => manualFacts(),
        clock: fixedClock(),
      }),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.ACCEPTANCE_GATE_DENIED);
        return true;
      },
    );

    // facts 与 request 不绑定（mirLockIdentitySha256 漂移）
    await assert.rejects(
      () => gate.consumeAndAuthorizeManualRepair({
        request,
        confirmation: manualConfirmation(),
        metadataStore: store,
        readCurrentFacts: () => manualFacts({
          mirLockRef: {
            kind: 'manual-intervention-lock',
            transactionId: UUID.mirTx,
            ownerNonce: UUID.ownerNonce,
            sha256: SHA_DRIFT,
          },
        }),
        clock: fixedClock(),
      }),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.ACCEPTANCE_GATE_DENIED);
        return true;
      },
    );
    assert.equal(durable.size, 0);

    // store readback 失配
    const mismatch = createInstrumentedConfirmationStore({
      readImpl() {
        return validateLaunchAgentConsumedConfirmation({
          schemaVersion: 1,
          kind: 'manual-repair-consumed-confirmation',
          confirmationId: UUID.manualConfirmation,
          manualRepairRequestId: UUID.manualRepair,
          mirTransactionId: UUID.mirTx,
          mirLockIdentitySha256: SHA_MIR_LOCK,
          anchorId: UUID.anchorDrift,
          repairDeclarationSha256: SHA_REPAIR,
          consumedAt: TS_NOW,
        });
      },
    });
    await assert.rejects(
      () => gate.consumeAndAuthorizeManualRepair({
        request,
        confirmation: manualConfirmation(),
        metadataStore: mismatch.store,
        readCurrentFacts: () => manualFacts(),
        clock: fixedClock(),
      }),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.ACCEPTANCE_GATE_DENIED);
        return true;
      },
    );

    // store 方法形态失败
    await assert.rejects(
      () => gate.consumeAndAuthorizeManualRepair({
        request,
        confirmation: manualConfirmation(),
        metadataStore: {
          consumeConfirmation: null,
          readConsumedConfirmation: async () => null,
        },
        readCurrentFacts: () => manualFacts(),
        clock: fixedClock(),
      }),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.INVALID);
        return true;
      },
    );
  });

  test('consumeAndAuthorizeManualRepair 漂移烧毁 confirmation：首次 deny，重放 confirmation-consumed', async () => {
    const request = expectedManualRequest();
    const confirmation = manualConfirmation();
    const baseFacts = manualFacts();
    const { store, durable } = createInstrumentedConfirmationStore();
    let n = 0;

    await assert.rejects(
      () => gate.consumeAndAuthorizeManualRepair({
        request,
        confirmation,
        metadataStore: store,
        readCurrentFacts: () => {
          n += 1;
          if (n === 1) {
            return {
              mirTransactionId: baseFacts.mirTransactionId,
              mirLockRef: { ...baseFacts.mirLockRef },
              transactionLockRef: null,
              anchorId: baseFacts.anchorId,
              repairDeclarationSha256: baseFacts.repairDeclarationSha256,
            };
          }
          return {
            mirTransactionId: baseFacts.mirTransactionId,
            mirLockRef: { ...baseFacts.mirLockRef },
            transactionLockRef: null,
            anchorId: UUID.anchorDrift,
            repairDeclarationSha256: baseFacts.repairDeclarationSha256,
          };
        },
        clock: fixedClock(),
      }),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.ACCEPTANCE_GATE_DENIED);
        return true;
      },
    );
    assert.ok(durable.has(UUID.manualConfirmation));

    await assert.rejects(
      () => gate.consumeAndAuthorizeManualRepair({
        request,
        confirmation,
        metadataStore: store,
        readCurrentFacts: () => ({
          mirTransactionId: baseFacts.mirTransactionId,
          mirLockRef: { ...baseFacts.mirLockRef },
          transactionLockRef: null,
          anchorId: baseFacts.anchorId,
          repairDeclarationSha256: baseFacts.repairDeclarationSha256,
        }),
        clock: fixedClock(),
      }),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.CONFIRMATION_CONSUMED);
        return true;
      },
    );
  });

  /**
   * 表驱动：post-consume facts B 相对 A 的 lock-ref 漂移。
   * 每个 case：首次 acceptance-gate-denied（确认已烧毁）+ 重放 confirmation-consumed。
   */
  test('consumeAndAuthorizeManualRepair post-consume lock-ref 漂移烧毁（表驱动）', async () => {
    const txLockPresent = {
      kind: 'transaction-lock',
      transactionId: UUID.txLock,
      ownerNonce: UUID.txNonce,
      sha256: SHA_TX_LOCK,
    };

    const cases = [
      {
        name: 'mirLockRef.ownerNonce 改变',
        factsA: manualFacts(),
        factsB: manualFacts({
          mirLockRef: {
            kind: 'manual-intervention-lock',
            transactionId: UUID.mirTx,
            ownerNonce: UUID.ownerNonceAlt,
            sha256: SHA_MIR_LOCK,
          },
        }),
      },
      {
        name: 'mirLockRef.sha256 改变',
        factsA: manualFacts(),
        factsB: manualFacts({
          mirLockRef: {
            kind: 'manual-intervention-lock',
            transactionId: UUID.mirTx,
            ownerNonce: UUID.ownerNonce,
            sha256: SHA_DRIFT,
          },
        }),
      },
      {
        name: 'transactionLockRef 从 null 出现',
        factsA: manualFacts({ transactionLockRef: null }),
        factsB: manualFacts({ transactionLockRef: { ...txLockPresent } }),
      },
      {
        name: '非 null transactionLockRef 消失',
        factsA: manualFacts({ transactionLockRef: { ...txLockPresent } }),
        factsB: manualFacts({ transactionLockRef: null }),
      },
      {
        name: '非 null transactionLockRef.ownerNonce 改变',
        factsA: manualFacts({ transactionLockRef: { ...txLockPresent } }),
        factsB: manualFacts({
          transactionLockRef: {
            ...txLockPresent,
            ownerNonce: UUID.ownerNonceAlt,
          },
        }),
      },
      {
        name: '非 null transactionLockRef.sha256 改变',
        factsA: manualFacts({ transactionLockRef: { ...txLockPresent } }),
        factsB: manualFacts({
          transactionLockRef: {
            ...txLockPresent,
            sha256: SHA_DRIFT,
          },
        }),
      },
    ];

    for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
      const testCase = cases[caseIndex];
      const request = expectedManualRequest();
      // 每 case 独立 confirmationId，避免跨 case 确认叶冲突
      const confirmationId = `eeeeeeee-eeee-4eee-8eee-${String(caseIndex).padStart(12, '0')}`;
      const confirmation = manualConfirmation({ confirmationId });
      const { store, durable } = createInstrumentedConfirmationStore();
      let n = 0;

      const cloneFacts = (facts) => ({
        mirTransactionId: facts.mirTransactionId,
        mirLockRef: { ...facts.mirLockRef },
        transactionLockRef: facts.transactionLockRef === null
          ? null
          : { ...facts.transactionLockRef },
        anchorId: facts.anchorId,
        repairDeclarationSha256: facts.repairDeclarationSha256,
      });

      await assert.rejects(
        () => gate.consumeAndAuthorizeManualRepair({
          request,
          confirmation,
          metadataStore: store,
          readCurrentFacts: () => {
            n += 1;
            return n === 1 ? cloneFacts(testCase.factsA) : cloneFacts(testCase.factsB);
          },
          clock: fixedClock(),
        }),
        (error) => {
          assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.ACCEPTANCE_GATE_DENIED);
          return true;
        },
        `case "${testCase.name}" 首次应 acceptance-gate-denied`,
      );
      assert.ok(
        durable.has(confirmationId),
        `case "${testCase.name}" 必须已烧毁 confirmation`,
      );

      await assert.rejects(
        () => gate.consumeAndAuthorizeManualRepair({
          request,
          confirmation,
          metadataStore: store,
          readCurrentFacts: () => cloneFacts(testCase.factsA),
          clock: fixedClock(),
        }),
        (error) => {
          assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.CONFIRMATION_CONSUMED);
          return true;
        },
        `case "${testCase.name}" 重放应 confirmation-consumed`,
      );
    }
  });

  test('consumeAndAuthorizeNonProductionConfirmation 真实 store 上并发仅一胜者，败者与重放 confirmation-consumed', async (t) => {
    const metadataStore = await createTempMetadataStore(t);
    const request = expectedNonProductionRequest();
    const confirmation = nonProductionConfirmation();
    const facts = nonProductionFacts();
    const clock = fixedClock(TS_NOW);

    const makeCall = () => gate.consumeAndAuthorizeNonProductionConfirmation({
      request,
      confirmation,
      metadataStore: {
        consumeConfirmation: (record) => metadataStore.consumeConfirmation(record),
        readConsumedConfirmation: (id) => metadataStore.readConsumedConfirmation(id),
      },
      readCurrentFacts: () => ({ ...facts }),
      clock,
    });

    const results = await Promise.allSettled([makeCall(), makeCall()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one concurrent winner');
    assert.equal(rejected.length, 1, 'exactly one concurrent loser');
    assertLifecycleCode(
      rejected[0].reason,
      LAUNCHAGENT_LIFECYCLE_CODES.CONFIRMATION_CONSUMED,
    );

    const winner = fulfilled[0].value;
    assert.deepEqual(
      winner,
      validateLaunchAgentCapabilityProjection({
        schemaVersion: 1,
        acceptanceId: UUID.acceptance,
        confirmationId: UUID.confirmation,
        executeAuthorized: true,
        sourceCommit: COMMIT_A,
        runtimeArtifactsSha256: SHA_RUNTIME,
        issuedAt: TS_NOW,
      }),
    );

    // 后续重放仍 confirmation-consumed
    await assert.rejects(
      () => makeCall(),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.CONFIRMATION_CONSUMED);
        return true;
      },
    );
  });

  test('consumeAndAuthorizeManualRepair 真实 store 上并发仅一胜者，败者 confirmation-consumed', async (t) => {
    const metadataStore = await createTempMetadataStore(t);
    const request = expectedManualRequest();
    const confirmation = manualConfirmation();
    const facts = manualFacts();
    const clock = fixedClock(TS_NOW);

    const makeCall = () => gate.consumeAndAuthorizeManualRepair({
      request,
      confirmation,
      metadataStore: {
        consumeConfirmation: (record) => metadataStore.consumeConfirmation(record),
        readConsumedConfirmation: (id) => metadataStore.readConsumedConfirmation(id),
      },
      readCurrentFacts: () => ({
        mirTransactionId: facts.mirTransactionId,
        mirLockRef: { ...facts.mirLockRef },
        transactionLockRef: null,
        anchorId: facts.anchorId,
        repairDeclarationSha256: facts.repairDeclarationSha256,
      }),
      clock,
    });

    const results = await Promise.allSettled([makeCall(), makeCall()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one concurrent winner');
    assert.equal(rejected.length, 1, 'exactly one concurrent loser');
    assertLifecycleCode(
      rejected[0].reason,
      LAUNCHAGENT_LIFECYCLE_CODES.CONFIRMATION_CONSUMED,
    );

    const winner = fulfilled[0].value;
    assert.deepEqual(
      winner,
      validateLaunchAgentCapabilityProjection({
        schemaVersion: 1,
        kind: 'launchagent-manual-repair',
        manualRepairRequestId: UUID.manualRepair,
        mirTransactionId: UUID.mirTx,
        mirLockIdentitySha256: SHA_MIR_LOCK,
        anchorId: UUID.anchor,
        repairDeclarationSha256: SHA_REPAIR,
        authorizedAt: TS_NOW,
      }),
    );

    // 耐久重放仍 confirmation-consumed
    await assert.rejects(
      () => makeCall(),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.CONFIRMATION_CONSUMED);
        return true;
      },
    );

    // 胜者 authority 可一次消费
    const authority = gate.assertAndConsumeLaunchAgentManualRepairAuthority(winner);
    assert.equal(authority.manualRepairConfirmationId, UUID.manualConfirmation);
  });

  test('consumeAndAuthorizeManualRepair 真实 store 漂移烧毁后重放 confirmation-consumed', async (t) => {
    const metadataStore = await createTempMetadataStore(t);
    const request = expectedManualRequest();
    const confirmation = manualConfirmation();
    const baseFacts = manualFacts();
    let n = 0;

    await assert.rejects(
      () => gate.consumeAndAuthorizeManualRepair({
        request,
        confirmation,
        metadataStore: {
          consumeConfirmation: (record) => metadataStore.consumeConfirmation(record),
          readConsumedConfirmation: (id) => metadataStore.readConsumedConfirmation(id),
        },
        readCurrentFacts: () => {
          n += 1;
          if (n === 1) {
            return {
              mirTransactionId: baseFacts.mirTransactionId,
              mirLockRef: { ...baseFacts.mirLockRef },
              transactionLockRef: null,
              anchorId: baseFacts.anchorId,
              repairDeclarationSha256: baseFacts.repairDeclarationSha256,
            };
          }
          return {
            mirTransactionId: baseFacts.mirTransactionId,
            mirLockRef: { ...baseFacts.mirLockRef },
            transactionLockRef: null,
            anchorId: UUID.anchorDrift,
            repairDeclarationSha256: baseFacts.repairDeclarationSha256,
          };
        },
        clock: fixedClock(),
      }),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.ACCEPTANCE_GATE_DENIED);
        return true;
      },
    );

    // leaf 已存在
    const consumed = await metadataStore.readConsumedConfirmation(UUID.manualConfirmation);
    assert.equal(consumed.kind, 'manual-repair-consumed-confirmation');
    assert.equal(consumed.confirmationId, UUID.manualConfirmation);

    await assert.rejects(
      () => gate.consumeAndAuthorizeManualRepair({
        request,
        confirmation,
        metadataStore: {
          consumeConfirmation: (record) => metadataStore.consumeConfirmation(record),
          readConsumedConfirmation: (id) => metadataStore.readConsumedConfirmation(id),
        },
        readCurrentFacts: () => ({
          mirTransactionId: baseFacts.mirTransactionId,
          mirLockRef: { ...baseFacts.mirLockRef },
          transactionLockRef: null,
          anchorId: baseFacts.anchorId,
          repairDeclarationSha256: baseFacts.repairDeclarationSha256,
        }),
        clock: fixedClock(TS_NOW_LATER),
      }),
      (error) => {
        assertLifecycleCode(error, LAUNCHAGENT_LIFECYCLE_CODES.CONFIRMATION_CONSUMED);
        return true;
      },
    );
  });

  // ---- 4. 禁用零副作用 facade ---------------------------------------------

  test('createDisabledLaunchAgentLifecycleFacade 冻结 exact 方法键并对每次调用立即 conditional-mutation-unsupported', () => {
    const facade = gate.createDisabledLaunchAgentLifecycleFacade();
    assert.ok(Object.isFrozen(facade));
    assert.deepEqual(
      Reflect.ownKeys(facade).sort(),
      [...DISABLED_METHOD_KEYS].sort(),
    );
    for (const key of DISABLED_METHOD_KEYS) {
      assert.equal(typeof facade[key], 'function');
      assert.throws(
        () => facade[key](),
        (error) => {
          assertLifecycleCode(
            error,
            LAUNCHAGENT_LIFECYCLE_CODES.CONDITIONAL_MUTATION_UNSUPPORTED,
          );
          return true;
        },
      );
    }
  });

  test('disabled facade 方法不检查调用方依赖且不触碰敌意 sentinel', () => {
    const facade = gate.createDisabledLaunchAgentLifecycleFacade();
    const counters = {
      account: 0,
      mint: 0,
      file: 0,
      process: 0,
      coordinator: 0,
      network: 0,
      host: 0,
      get: 0,
      apply: 0,
    };

    const hostile = new Proxy(
      {},
      {
        get(_target, prop) {
          counters.get += 1;
          if (typeof prop === 'string' && Object.hasOwn(counters, prop)) {
            counters[prop] += 1;
          }
          if (prop === 'account' || prop === 'mint' || prop === 'file'
            || prop === 'process' || prop === 'coordinator' || prop === 'network'
            || prop === 'host') {
            counters[prop] += 1;
          }
          return new Proxy(function sentinel() {}, {
            apply() {
              counters.apply += 1;
              counters.host += 1;
              return undefined;
            },
            get() {
              counters.get += 1;
              return undefined;
            },
          });
        },
        has() {
          counters.get += 1;
          return true;
        },
        ownKeys() {
          counters.get += 1;
          return ['account', 'mint', 'file', 'process', 'coordinator', 'network', 'host'];
        },
        getOwnPropertyDescriptor() {
          counters.get += 1;
          return { configurable: true, enumerable: true, value: undefined };
        },
      },
    );

    for (const key of DISABLED_METHOD_KEYS) {
      assert.throws(
        () => facade[key](hostile, hostile, hostile),
        (error) => {
          assertLifecycleCode(
            error,
            LAUNCHAGENT_LIFECYCLE_CODES.CONDITIONAL_MUTATION_UNSUPPORTED,
          );
          return true;
        },
      );
    }

    assert.equal(counters.account, 0);
    assert.equal(counters.mint, 0);
    assert.equal(counters.file, 0);
    assert.equal(counters.process, 0);
    assert.equal(counters.coordinator, 0);
    assert.equal(counters.network, 0);
    assert.equal(counters.host, 0);
    assert.equal(counters.get, 0);
    assert.equal(counters.apply, 0);
  });
}

// ---------------------------------------------------------------------------
// Task 4 — index.js 公共表面（两阶段 TDD：缺席仅 safe index 存在性 RED）。
// index.js 缺席：仅注册一条存在性失败（missing index.js is the intended RED）。
// index.js 存在：动态导入并注册 exact 15 导出集 + 子进程 import 副作用守卫。
// ---------------------------------------------------------------------------

const indexUrl = new URL('../src/launchagent-lifecycle/index.js', import.meta.url);
const indexPath = fileURLToPath(indexUrl);
const indexExists = existsSync(indexPath);

const TASK4_EXPECTED_EXPORTS = Object.freeze([
  'LAUNCHAGENT_LIFECYCLE',
  'LAUNCHAGENT_LIFECYCLE_CODES',
  'bindLaunchAgentRuntime',
  'createDisabledLaunchAgentLifecycleFacade',
  'prepareLaunchAgentAcceptanceRequest',
  'prepareLaunchAgentManualRepairRequest',
  'renderLaunchAgentProfiles',
  'validateLaunchAgentAcceptanceRequest',
  'validateLaunchAgentAnchor',
  'validateLaunchAgentCapabilityProjection',
  'validateLaunchAgentConfirmationRecord',
  'validateLaunchAgentConsumedConfirmation',
  'validateLaunchAgentJournal',
  'validateLaunchAgentManifest',
  'validateLaunchAgentReceipt',
].sort());

const TASK4_FORBIDDEN_EXPORT_NAMES = Object.freeze([
  'LaunchAgentLifecycleError',
  'consumeAndAuthorizeNonProductionConfirmation',
  'consumeAndAuthorizeManualRepair',
  'assertAndConsumeLaunchAgentManualRepairAuthority',
]);

const TASK4_FORBIDDEN_SURFACE_PATTERNS = Object.freeze([
  /metadata[_-]?store/i,
  /host[_-]?adapter/i,
  /transaction[_-]?coordinator/i,
  /process[_-]?identity/i,
  /^consumeAndAuthorize/,
]);

test('Task 4 safe index production module exists', () => {
  assert.equal(indexExists, true, 'missing index.js is the intended RED');
});

/**
 * Task 4 allowlist：仅 safe index 的五条静态模块路径，各允许一次只读 loader openSync。
 */
function getTask4Allowlist() {
  const lifecycleDir = resolve(
    fileURLToPath(new URL('../src/launchagent-lifecycle/', import.meta.url)),
  );
  return [
    resolve(lifecycleDir, 'index.js'),
    resolve(lifecycleDir, 'contracts.js'),
    resolve(lifecycleDir, 'profiles.js'),
    resolve(lifecycleDir, 'acceptance-gate.js'),
    resolve(lifecycleDir, '..', 'management-auth-keychain.js'),
  ];
}

/**
 * 构造 Task 4 守卫子进程：先装守卫，再真实 file-URL import 一次。
 * - 每条 allowlist 路径恰好一次只读 openSync 预算（防业务复开同源伪装 loaderFs）
 * - 返回 exportKeys / 计数 / 活跃资源快照；Task 4 导出检查不在父进程直接 import index.js
 * - canary：命名 node:fs/promises.readFile + spawn + network + Node 24 新增入口（有则测）
 */
function buildTask4ImportSideEffectChildSource(config) {
  return `
import fs from 'node:fs';
import childProcess from 'node:child_process';
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import http2 from 'node:http2';
import module from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWLIST_ORDERED = ${JSON.stringify(config.allowlist)};
const ALLOWLIST = new Set(ALLOWLIST_ORDERED);
const INDEX_URL = ${JSON.stringify(config.indexUrl)};

const counters = { fs: 0, spawn: 0, network: 0 };
const canaryCounters = { fs: 0, spawn: 0, network: 0 };
const expectedCanaryCounters = { fs: 0, spawn: 0, network: 0 };
const canaryHits = [];
const guardedEntryPoints = [];
let phase = 'import';
let loaderFs = 0;
const loaderFds = new Set();
const loaderPathsSeen = [];
const loaderOpenCounts = new Map(ALLOWLIST_ORDERED.map((p) => [p, 0]));

function fail(message) {
  process.stderr.write(String(message));
  process.exit(1);
}

function bump(category) {
  if (phase === 'import') counters[category] += 1;
  else canaryCounters[category] += 1;
}

function normalizePath(p) {
  if (p instanceof URL) {
    return resolve(fileURLToPath(p));
  }
  return resolve(String(p));
}

function isReadOnlyFlag(flags) {
  if (flags === undefined || flags === null) return true;
  if (typeof flags === 'string') {
    return flags === 'r' || flags === 'rs' || flags === 'sr';
  }
  if (typeof flags === 'number') {
    const writeish =
      (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT |
       fs.constants.O_TRUNC | fs.constants.O_APPEND);
    return (flags & writeish) === 0;
  }
  if (typeof flags === 'object') {
    const nested = flags.flag ?? flags.flags;
    if (nested === undefined) return true;
    return isReadOnlyFlag(nested);
  }
  return false;
}

function sortedActiveResources() {
  if (typeof process.getActiveResourcesInfo !== 'function') {
    return [];
  }
  return [...process.getActiveResourcesInfo()].sort();
}

const original = {
  openSync: fs.openSync.bind(fs),
  read: fs.read.bind(fs),
  readSync: fs.readSync.bind(fs),
  fstat: fs.fstat.bind(fs),
  fstatSync: fs.fstatSync.bind(fs),
  close: fs.close.bind(fs),
  closeSync: fs.closeSync.bind(fs),
};

function blockFsHighLevel(name) {
  return function blockedFs() {
    bump('fs');
    throw new Error('blocked-fs:' + name);
  };
}

const highLevelFsNames = [
  'access', 'accessSync', 'appendFile', 'appendFileSync',
  'chmod', 'chmodSync', 'chown', 'chownSync',
  'copyFile', 'copyFileSync', 'cp', 'cpSync',
  'createReadStream', 'createWriteStream',
  'exists', 'existsSync',
  'glob', 'globSync',
  'lchmod', 'lchmodSync', 'lchown', 'lchownSync',
  'link', 'linkSync', 'lstat', 'lstatSync',
  'lutimes', 'lutimesSync',
  'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync', 'mkdtempDisposableSync',
  'open', 'openAsBlob', 'opendir', 'opendirSync',
  'readFile', 'readFileSync', 'readdir', 'readdirSync',
  'readlink', 'readlinkSync', 'readv', 'readvSync',
  'realpath', 'realpathSync',
  'rename', 'renameSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync',
  'stat', 'statSync', 'statfs', 'statfsSync',
  'symlink', 'symlinkSync',
  'truncate', 'truncateSync',
  'unlink', 'unlinkSync',
  'utimes', 'utimesSync',
  'watch', 'watchFile', 'unwatchFile',
  'write', 'writeSync', 'writeFile', 'writeFileSync', 'writev', 'writevSync',
  'fchmod', 'fchmodSync', 'fchown', 'fchownSync',
  'fdatasync', 'fdatasyncSync', 'fsync', 'fsyncSync',
  'ftruncate', 'ftruncateSync', 'futimes', 'futimesSync',
];

for (const name of highLevelFsNames) {
  if (typeof fs[name] === 'function') {
    fs[name] = blockFsHighLevel(name);
  }
}

// Node 24 stream / constructor entry points (when present).
// Descriptor-aware: assignment for writable/setter; defineProperty for getter-only configurable.
for (const name of [
  'ReadStream', 'FileReadStream', 'WriteStream', 'FileWriteStream', 'Utf8Stream',
]) {
  if (typeof fs[name] !== 'function') continue;
  const blockedName = name;
  const blocked = function blockedFsStreamCtor() {
    bump('fs');
    throw new Error('blocked-fs:' + blockedName);
  };
  const desc = Object.getOwnPropertyDescriptor(fs, name);
  if (desc === undefined) {
    fail('cannot guard fs.' + name + ': missing own property descriptor');
  } else if (
    (Object.prototype.hasOwnProperty.call(desc, 'value') && desc.writable === true)
    || typeof desc.set === 'function'
  ) {
    fs[name] = blocked;
  } else if (
    typeof desc.get === 'function'
    && typeof desc.set !== 'function'
    && desc.configurable === true
  ) {
    Object.defineProperty(fs, name, {
      configurable: desc.configurable,
      enumerable: desc.enumerable,
      writable: true,
      value: blocked,
    });
  } else if (
    Object.prototype.hasOwnProperty.call(desc, 'value')
    && desc.writable === false
    && desc.configurable === true
  ) {
    Object.defineProperty(fs, name, {
      configurable: desc.configurable,
      enumerable: desc.enumerable,
      writable: true,
      value: blocked,
    });
  } else {
    fail('cannot guard fs.' + name + ': property not safely replaceable');
  }
  guardedEntryPoints.push('fs.' + name);
}
// mkdtempDisposableSync is in highLevelFsNames; record when the blocked entry is present
if (typeof fs.mkdtempDisposableSync === 'function') {
  guardedEntryPoints.push('fs.mkdtempDisposableSync');
}

if (fs.promises && typeof fs.promises === 'object') {
  for (const name of Reflect.ownKeys(fs.promises)) {
    if (typeof name === 'string' && typeof fs.promises[name] === 'function') {
      fs.promises[name] = blockFsHighLevel('promises.' + name);
    }
  }
}

// 精确一次 open 预算：同路径二次 open / 非只读 / 非 allowlist → 业务 fs
fs.openSync = function patchedOpenSync(path, flags, mode) {
  const key = normalizePath(path);
  const prior = loaderOpenCounts.has(key) ? loaderOpenCounts.get(key) : null;
  if (
    ALLOWLIST.has(key)
    && isReadOnlyFlag(flags)
    && prior === 0
  ) {
    const fd = original.openSync(path, flags, mode);
    loaderFds.add(fd);
    loaderFs += 1;
    loaderOpenCounts.set(key, 1);
    loaderPathsSeen.push(key);
    return fd;
  }
  bump('fs');
  throw new Error('blocked-fs:openSync');
};

function allowLoaderFdOrBlock(methodName, fd, invoke) {
  if (loaderFds.has(fd)) {
    loaderFs += 1;
    return invoke();
  }
  bump('fs');
  throw new Error('blocked-fs:' + methodName);
}

fs.readSync = function patchedReadSync(fd, ...args) {
  return allowLoaderFdOrBlock('readSync', fd, () => original.readSync(fd, ...args));
};

fs.read = function patchedRead(fd, ...args) {
  return allowLoaderFdOrBlock('read', fd, () => original.read(fd, ...args));
};

fs.fstatSync = function patchedFstatSync(fd, ...args) {
  return allowLoaderFdOrBlock('fstatSync', fd, () => original.fstatSync(fd, ...args));
};

fs.fstat = function patchedFstat(fd, ...args) {
  return allowLoaderFdOrBlock('fstat', fd, () => original.fstat(fd, ...args));
};

fs.closeSync = function patchedCloseSync(fd, ...args) {
  return allowLoaderFdOrBlock('closeSync', fd, () => {
    const result = original.closeSync(fd, ...args);
    loaderFds.delete(fd);
    return result;
  });
};

fs.close = function patchedClose(fd, ...args) {
  return allowLoaderFdOrBlock('close', fd, () => {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') {
      return original.close(fd, (...cbArgs) => {
        loaderFds.delete(fd);
        cb(...cbArgs);
      });
    }
    const result = original.close(fd, ...args);
    loaderFds.delete(fd);
    return result;
  });
};

function blockSpawn(name) {
  return function blockedSpawn() {
    bump('spawn');
    throw new Error('blocked-spawn:' + name);
  };
}

for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  if (typeof childProcess[name] === 'function') {
    childProcess[name] = blockSpawn(name);
  }
}

function blockNetwork(name) {
  return function blockedNetwork() {
    bump('network');
    throw new Error('blocked-network:' + name);
  };
}

net.connect = blockNetwork('net.connect');
net.createConnection = blockNetwork('net.createConnection');
net.createServer = blockNetwork('net.createServer');
if (net.Socket && net.Socket.prototype) {
  net.Socket.prototype.connect = blockNetwork('net.Socket.prototype.connect');
}
if (net.Server && net.Server.prototype && typeof net.Server.prototype.listen === 'function') {
  net.Server.prototype.listen = blockNetwork('net.Server.prototype.listen');
  guardedEntryPoints.push('net.Server.prototype.listen');
}

if (typeof dgram.createSocket === 'function') {
  dgram.createSocket = blockNetwork('dgram.createSocket');
}

for (const name of ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6',
  'resolveAny', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs',
  'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse']) {
  if (typeof dns[name] === 'function') dns[name] = blockNetwork('dns.' + name);
}
if (dns.promises && typeof dns.promises === 'object') {
  for (const name of Reflect.ownKeys(dns.promises)) {
    if (typeof name === 'string' && typeof dns.promises[name] === 'function') {
      dns.promises[name] = blockNetwork('dns.promises.' + name);
    }
  }
}

http.request = blockNetwork('http.request');
http.get = blockNetwork('http.get');
http.createServer = blockNetwork('http.createServer');
if (typeof http.ClientRequest === 'function') {
  http.ClientRequest = function blockedHttpClientRequest() {
    bump('network');
    throw new Error('blocked-network:http.ClientRequest');
  };
  guardedEntryPoints.push('http.ClientRequest');
}
https.request = blockNetwork('https.request');
https.get = blockNetwork('https.get');
https.createServer = blockNetwork('https.createServer');

if (typeof tls.connect === 'function') tls.connect = blockNetwork('tls.connect');
if (typeof tls.createServer === 'function') tls.createServer = blockNetwork('tls.createServer');
if (typeof http2.connect === 'function') http2.connect = blockNetwork('http2.connect');
if (typeof http2.createServer === 'function') {
  http2.createServer = blockNetwork('http2.createServer');
}
if (typeof http2.createSecureServer === 'function') {
  http2.createSecureServer = blockNetwork('http2.createSecureServer');
}

if (typeof globalThis.fetch === 'function') {
  globalThis.fetch = blockNetwork('globalThis.fetch');
}
if (typeof globalThis.WebSocket === 'function') {
  globalThis.WebSocket = function blockedWebSocket() {
    bump('network');
    throw new Error('blocked-network:globalThis.WebSocket');
  };
  guardedEntryPoints.push('globalThis.WebSocket');
}

module.syncBuiltinESMExports();

const activeResourcesBefore = sortedActiveResources();
const indexModule = await import(INDEX_URL);
// 有界 post-import 事件环检查点：排空 microtask + 一轮 immediate/timer，再冻结 import 计数
await Promise.resolve();
await new Promise((resolve) => {
  setImmediate(() => {
    setTimeout(resolve, 0);
  });
});
const activeResourcesAfter = sortedActiveResources();

const exportKeys = Reflect.ownKeys(indexModule)
  .filter((key) => typeof key === 'string')
  .sort();

const importCounters = {
  fs: counters.fs,
  spawn: counters.spawn,
  network: counters.network,
  loaderFs,
};

const loaderOpenCountsObject = Object.fromEntries(loaderOpenCounts.entries());
const loaderPathsSorted = [...loaderPathsSeen].sort();
const allowlistSorted = [...ALLOWLIST_ORDERED].sort();

if (importCounters.fs !== 0 || importCounters.spawn !== 0 || importCounters.network !== 0) {
  fail('import business counters non-zero');
}
for (const pathKey of ALLOWLIST_ORDERED) {
  if (loaderOpenCounts.get(pathKey) !== 1) {
    fail('loader open budget violated for ' + pathKey);
  }
}
if (JSON.stringify(loaderPathsSorted) !== JSON.stringify(allowlistSorted)) {
  fail('loader path multiset !== exact four-path allowlist');
}
if (loaderFds.size !== 0) {
  fail('loader fd set not empty after import');
}
if (JSON.stringify(activeResourcesBefore) !== JSON.stringify(activeResourcesAfter)) {
  fail('active resources multiset changed across import checkpoint');
}
if (!Array.isArray(exportKeys) || exportKeys.length === 0) {
  fail('exportKeys not captured');
}

phase = 'canary';

// 基础 fs canary：patch + sync 后动态命名 import readFile（依赖面真实形状）
const { readFile: fspReadFile } = await import('node:fs/promises');
try {
  await fspReadFile('/__task4_canary_blocked__/no-such-file');
} catch {
  // expected: guard throws without performing I/O
}
expectedCanaryCounters.fs += 1;
canaryHits.push('fsp.readFile');

try {
  childProcess.spawn(process.execPath, ['-e', '0']);
} catch {
  // expected
}
expectedCanaryCounters.spawn += 1;
canaryHits.push('childProcess.spawn');

try {
  net.connect({ port: 1, host: '127.0.0.1' });
} catch {
  // expected
}
expectedCanaryCounters.network += 1;
canaryHits.push('net.connect');

// Node 24 新增入口 canary：真实构造/方法调用，由 try/catch 接住；不写盘、不建真实网络
for (const name of [
  'ReadStream', 'FileReadStream', 'WriteStream', 'FileWriteStream', 'Utf8Stream',
]) {
  if (typeof fs[name] === 'function') {
    try {
      new fs[name]('/__task4_canary_blocked__/stream');
    } catch {
      // expected
    }
    expectedCanaryCounters.fs += 1;
    canaryHits.push('fs.' + name);
  }
}
if (typeof fs.mkdtempDisposableSync === 'function') {
  try {
    fs.mkdtempDisposableSync('/__task4_canary_blocked__/');
  } catch {
    // expected
  }
  expectedCanaryCounters.fs += 1;
  canaryHits.push('fs.mkdtempDisposableSync');
}
if (net.Server && net.Server.prototype && typeof net.Server.prototype.listen === 'function') {
  try {
    Reflect.apply(net.Server.prototype.listen, {}, []);
  } catch {
    // expected
  }
  expectedCanaryCounters.network += 1;
  canaryHits.push('net.Server.prototype.listen');
}
if (typeof http.ClientRequest === 'function') {
  try {
    new http.ClientRequest({});
  } catch {
    // expected
  }
  expectedCanaryCounters.network += 1;
  canaryHits.push('http.ClientRequest');
}
if (typeof globalThis.WebSocket === 'function') {
  try {
    new globalThis.WebSocket('ws://127.0.0.1:1');
  } catch {
    // expected
  }
  expectedCanaryCounters.network += 1;
  canaryHits.push('globalThis.WebSocket');
}

if (
  canaryCounters.fs !== expectedCanaryCounters.fs
  || canaryCounters.spawn !== expectedCanaryCounters.spawn
  || canaryCounters.network !== expectedCanaryCounters.network
) {
  fail(
    'canary counters mismatch fs=' + canaryCounters.fs + '/' + expectedCanaryCounters.fs
    + ' spawn=' + canaryCounters.spawn + '/' + expectedCanaryCounters.spawn
    + ' network=' + canaryCounters.network + '/' + expectedCanaryCounters.network,
  );
}

const payload = {
  importCounters,
  canaryCounters: {
    fs: canaryCounters.fs,
    spawn: canaryCounters.spawn,
    network: canaryCounters.network,
  },
  expectedCanaryCounters: {
    fs: expectedCanaryCounters.fs,
    spawn: expectedCanaryCounters.spawn,
    network: expectedCanaryCounters.network,
  },
  canaryHits,
  guardedEntryPoints,
  activeResourcesBefore,
  activeResourcesAfter,
  exportKeys,
  loaderOpenCounts: loaderOpenCountsObject,
  loaderPathsSeen,
  loaderFdsRemaining: loaderFds.size,
};

// 仅输出结构化结果；成功路径自然退出（不 process.exit(0)）；违规仍 fail-closed exit(1)
process.stdout.write(JSON.stringify(payload));
`;
}

/**
 * 启动一次全新守卫子进程。
 * Task 4 导出/副作用检查不在父进程直接 import index.js；由守卫子进程执行受控 index import。
 * 父进程既有 Task 3 对 contracts / metadata-store 的 import 属已批准先验结构，不在本 helper 范围内。
 */
async function runTask4GuardedChild() {
  const allowlist = getTask4Allowlist();
  const childSource = buildTask4ImportSideEffectChildSource({
    allowlist,
    indexUrl: indexUrl.href,
  });

  const childResult = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '--eval', childSource],
      {
        cwd: resolve(fileURLToPath(new URL('..', import.meta.url))),
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });

  assert.equal(
    childResult.code,
    0,
    `Task 4 guarded child must exit 0; stderr=${childResult.stderr}`,
  );

  const payload = JSON.parse(childResult.stdout);
  return { allowlist, payload, childResult };
}

/**
 * 父进程对守卫子进程 payload 的共享严格断言（loader 预算 + 业务零 + canary + 活跃资源）。
 */
function assertTask4GuardedPayload(allowlist, payload) {
  assert.equal(payload.importCounters.fs, 0, 'import business fs must be 0');
  assert.equal(payload.importCounters.spawn, 0, 'import business spawn must be 0');
  assert.equal(payload.importCounters.network, 0, 'import business network must be 0');
  assert.ok(
    payload.importCounters.loaderFs >= 1,
    'import loaderFs must be >= 1 (path/fd-aware loader openSync path exercised)',
  );

  const allowlistSorted = [...allowlist].sort();
  assert.deepEqual(
    [...payload.loaderPathsSeen].sort(),
    allowlistSorted,
    'loader path multiset must equal exact five-path allowlist',
  );
  for (const pathKey of allowlist) {
    assert.equal(
      payload.loaderOpenCounts[pathKey],
      1,
      `loader open count must be exactly 1 for ${pathKey}`,
    );
  }
  assert.equal(
    payload.loaderFdsRemaining,
    0,
    'loader fd set must be empty after import',
  );

  assert.ok(Array.isArray(payload.activeResourcesBefore), 'activeResourcesBefore must be array');
  assert.ok(Array.isArray(payload.activeResourcesAfter), 'activeResourcesAfter must be array');
  assert.deepEqual(
    payload.activeResourcesAfter,
    payload.activeResourcesBefore,
    'active resources multiset must be unchanged across import checkpoint',
  );

  assert.ok(payload.expectedCanaryCounters, 'expectedCanaryCounters must be present');
  assert.equal(
    payload.canaryCounters.fs,
    payload.expectedCanaryCounters.fs,
    'fs canary total must equal expected',
  );
  assert.equal(
    payload.canaryCounters.spawn,
    payload.expectedCanaryCounters.spawn,
    'spawn canary total must equal expected',
  );
  assert.equal(
    payload.canaryCounters.network,
    payload.expectedCanaryCounters.network,
    'network canary total must equal expected',
  );
  // 既有三类基础 canary 必须仍恰好贡献 1；Node 24 新增入口叠加在其上
  assert.equal(payload.expectedCanaryCounters.spawn, 1, 'spawn canary must remain exactly 1');
  assert.ok(
    payload.expectedCanaryCounters.fs >= 1,
    'fs canary must include at least named fsp.readFile',
  );
  assert.ok(
    payload.expectedCanaryCounters.network >= 1,
    'network canary must include at least net.connect',
  );
  assert.ok(Array.isArray(payload.canaryHits), 'canaryHits must be captured');
  assert.ok(payload.canaryHits.includes('fsp.readFile'), 'fsp.readFile canary must run');
  assert.ok(payload.canaryHits.includes('childProcess.spawn'), 'spawn canary must run');
  assert.ok(payload.canaryHits.includes('net.connect'), 'net.connect canary must run');
  assert.ok(Array.isArray(payload.guardedEntryPoints), 'guardedEntryPoints must be captured');
  for (const entry of payload.guardedEntryPoints) {
    assert.ok(
      payload.canaryHits.includes(entry),
      `guarded entry point must be canaried: ${entry}`,
    );
  }

  assert.ok(Array.isArray(payload.exportKeys), 'exportKeys must be captured');
}

if (indexExists) {
  test('Task 4 safe index exports exact sorted public surface of 15 names only', async () => {
    const { allowlist, payload } = await runTask4GuardedChild();
    assertTask4GuardedPayload(allowlist, payload);

    assert.deepEqual(payload.exportKeys, [...TASK4_EXPECTED_EXPORTS]);

    for (const forbidden of TASK4_FORBIDDEN_EXPORT_NAMES) {
      assert.equal(
        payload.exportKeys.includes(forbidden),
        false,
        `forbidden export must be absent: ${forbidden}`,
      );
    }

    for (const key of payload.exportKeys) {
      assert.equal(
        key.startsWith('consumeAndAuthorize'),
        false,
        `forbidden consumeAndAuthorize* export: ${key}`,
      );
      for (const pattern of TASK4_FORBIDDEN_SURFACE_PATTERNS) {
        assert.equal(
          pattern.test(key),
          false,
          `forbidden surface export ${key} matched ${pattern}`,
        );
      }
    }
  });

  test('Task 4 safe index fresh import has zero business fs/spawn/network side effects', async () => {
    const { allowlist, payload } = await runTask4GuardedChild();
    assertTask4GuardedPayload(allowlist, payload);
    assert.deepEqual(
      payload.exportKeys,
      [...TASK4_EXPECTED_EXPORTS],
      'side-effect child must still capture exact export surface',
    );
  });
}
