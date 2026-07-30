# Linke V1.46 Task 5A.2 Crash-Recovery RED Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不修改生产代码的前提下，为 V1.46 Task 5 Step 4 建立确定性 crash-image harness、完整 crash-recovery 真值表和唯一预期失败为缺少 `coordinator.recover` 的有效 RED。

**Architecture:** 测试 helper 在 journal 或成功 host mutation 的精确持久化边界非抛错地捕获 detached crash image，并从该 image 创建全新 harness。业务与 compensation 矩阵先证明每个 fixture 真实可达，再在 `recover` 公开面出现后自动激活恢复断言；Step 4 通过测试专用 pre-proven lock seam 隔离 Step 7 的真实孤儿锁接管。

**Tech Stack:** Node.js ESM、`node:test`、`node:assert/strict`、内存 fake adapters、现有 LaunchAgent lifecycle contracts/coordinator。

## Global Constraints

- 工作根固定为 `/Users/ah/linke/.worktrees/linke-v0.12-web-panel`，当前 branch 为 `linke-v0.12-web-panel`。
- pre-plan 锚点为 `ca96b9ab9fb5b46c5a3fd78e9d8c5756c6cb0089`；测试执行前必须把用户批准的 amended spec + plan docs-only commit 记录为新的 last-green。
- 本计划实现只允许修改 `test/helpers/launchagent-lifecycle-harness.js` 与 `test/launchagent-lifecycle-recovery.test.js`。
- 保护并禁止修改所有 `src/launchagent-lifecycle/*.js`、已提交 spec、上位 plan/design 及其它测试。
- `package-lock.json` 只允许由 `git status` 显示；禁止读取、hash、修改、stage、commit 或 push。
- 禁止真实 launchctl、`~/Library/LaunchAgents`、LaunchAgent 安装/启动/停止/卸载、部署、生产写入或凭证访问。
- 普通恢复的未来公开输入精确为 `coordinator.recover({ transactionId })`；caller 不得提供 sourceCommit、operation、hash 或批准布尔。
- 原 transaction 的 operation 全链不可变；普通恢复 receipt 继续使用原 operation，禁止改成 `recover`。
- 业务中间态回精确 anchor=`recovered`；只有完整 post-state 才能 `committed`；compensation 只能继续同一 hash-bound reverse plan。
- commit、push 分别受人类硬闸；本计划中的 commit 命令只是建议，未经本轮之后的明确批准不得执行；本计划不含 push。
- worker 写入白名单只含上述两个测试文件；计划文件、spec 和生产文件均为保护文件。

---

## File Map

| File | Responsibility | Change |
| --- | --- | --- |
| `test/helpers/launchagent-lifecycle-harness.js` | 生成真实可达 fake transaction、捕获/恢复 crash image、提供 Step 4 锁接缝与故障注入 | Modify |
| `test/launchagent-lifecycle-recovery.test.js` | 保留 Task 5A.1 回归，新增 crash-image 自测、业务/compensation/terminal/MIR RED 矩阵 | Modify |
| `src/launchagent-lifecycle/transaction-coordinator.js` | 未来生产 `recover` | Protected; do not modify |
| `src/launchagent-lifecycle/contracts.js` | 未来 terminal payload receipt projection schema | Protected; do not modify |

## Task 1: Freeze Evidence and Add Detached Crash-Image Foundation

**Files:**
- Modify: `test/helpers/launchagent-lifecycle-harness.js:219-276,1249-1788`
- Modify: `test/launchagent-lifecycle-recovery.test.js:1-176`
- Protect: `src/launchagent-lifecycle/*.js`

**Interfaces:**
- Consumes: existing `createLaunchAgentLifecycleHarness()` and its in-memory `files`, `candidates`, `store`, `state`, sequence counters.
- Produces: `createLaunchAgentLifecycleHarness(options = {})`, `harness.armCrashCapture(selector)`, `harness.takeCrashImage()`.
- `selector` is exactly `{ kind:'journal-state', state:string, occurrence:positiveInteger }` or `{ kind:'host-mutation', action:string, occurrence:positiveInteger }`.
- `takeCrashImage()` returns a module-branded, detached, deep-frozen plain projection whose byte fields are base64 strings, never mutable Buffer references.

- [ ] **Step 1: Freeze branch, hashes, status, and allowed files**

Run:

```bash
git status --short --branch
git rev-parse HEAD
git rev-parse @{upstream}
git rev-list --left-right --count HEAD...@{upstream}
shasum -a 256 \
  docs/superpowers/specs/2026-07-30-linke-v146-task5a2-crash-recovery-red-design.md \
  docs/superpowers/plans/2026-07-28-linke-v146-user-launchagent-lifecycle.md \
  src/launchagent-lifecycle/contracts.js \
  src/launchagent-lifecycle/host-adapter.js \
  src/launchagent-lifecycle/metadata-store.js \
  src/launchagent-lifecycle/profiles.js \
  src/launchagent-lifecycle/transaction-coordinator.js \
  test/helpers/launchagent-lifecycle-harness.js \
  test/launchagent-lifecycle-recovery.test.js
```

Expected:

```text
HEAD is the user-approved amended-spec + plan docs-only commit
HEAD...upstream=2 0
status contains only untracked package-lock.json before test work
```

Do not run any command that opens or hashes `package-lock.json`.

- [ ] **Step 2: Add active failing harness-surface tests**

Append before the production `recover` surface RED in `test/launchagent-lifecycle-recovery.test.js`:

```js
test('Task 5A.2 harness exposes deterministic crash-image controls', () => {
  const harness = createLaunchAgentLifecycleHarness();
  assert.equal(typeof harness.armCrashCapture, 'function');
  assert.equal(typeof harness.takeCrashImage, 'function');
  assert.throws(
    () => createLaunchAgentLifecycleHarness({ crashImage: {} }),
    /launchagent-harness:/,
  );
});
```

Run:

```bash
node --test --test-name-pattern='Task 5A.2 harness exposes' test/launchagent-lifecycle-recovery.test.js
```

Expected: FAIL because `armCrashCapture` / `takeCrashImage` do not exist, not because of syntax/import or real host access.

- [ ] **Step 3: Add exact option/selector validation and module-private brand**

Add at module scope in the harness:

```js
const CRASH_IMAGE_BRAND = new WeakSet();
const CRASH_SELECTOR_KINDS = new Set(['journal-state', 'host-mutation']);
const CRASH_HOST_ACTIONS = new Set([
  'publish-controller', 'publish-scheduler', 'publish-manifest',
  'bootout-controller', 'bootout-scheduler',
  'bootstrap-controller', 'bootstrap-scheduler',
  'remove-controller', 'remove-scheduler', 'remove-manifest',
  'restore-controller', 'restore-scheduler', 'restore-manifest',
  'load-controller', 'load-scheduler', 'stop-controller', 'stop-scheduler',
]);

function validatePositiveOccurrence(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw harnessError('crash capture occurrence must be a positive integer');
  }
  return value;
}
```

Change the factory signature without changing existing no-argument callers:

```js
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
}
```

Reject symbols, getters, arrays, null, wrong prototypes, unknown keys, invalid kind/state/action/occurrence, double arm, take-before-capture, and repeated take.

- [ ] **Step 4: Serialize durable state without Buffer aliasing**

Add internal exact helpers. Preserve these names for later tasks:

```js
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
  });
  CRASH_IMAGE_BRAND.add(image);
  return image;
}
```

Do not serialize `lastRenderedRuntimeArtifacts`, hooks, failure sets, traces, adapter calls, counters, revalidation marks, exceptions, functions, Promises, paths or environment data.

- [ ] **Step 5: Restore a fresh harness from the branded image**

After normal empty initialization, when `revivedImage !== null`:

```js
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
    candidates.set(item.key, {
      bytes: decodeBytes(item.bytesBase64),
      sha256: item.sha256,
      role: item.role,
      transactionId: item.transactionId,
    });
  }
  store.journal.push(...structuredClone(image.journal));
  for (const [key, value] of image.anchors) store.anchors.set(key, deepFreeze(value));
  for (const [key, value] of image.receipts) store.receipts.set(key, deepFreeze(value));
  store.transactionLock = structuredClone(image.transactionLock);
  store.manualInterventionLock = structuredClone(image.manualInterventionLock);
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
}
```

Validate every restored entry through existing production-facing validators and recompute candidate/file hashes. Keep `state.lastRenderedRuntimeArtifacts = null`; reset `printPhase`, `plistLintValid`, `strictLaunchctlTransitions` and all other observation/failure controls to their fresh-harness defaults. A recovered process must not inherit the old coordinator's render context.

- [ ] **Step 6: Implement arm/take methods and prove detachment**

Use internal state:

```js
let crashSelector = null;
let crashImage = null;
let crashImageTaken = false;
const crashOccurrences = new Map();

function maybeCaptureCrash(kind, value) {
  if (crashSelector === null || crashImage !== null || crashSelector.kind !== kind) return;
  const selected = kind === 'journal-state' ? crashSelector.state : crashSelector.action;
  if (selected !== value) return;
  const key = `${kind}:${value}`;
  const occurrence = (crashOccurrences.get(key) ?? 0) + 1;
  crashOccurrences.set(key, occurrence);
  if (occurrence === crashSelector.occurrence) crashImage = captureDurableState();
}
```

Expose exact methods:

```js
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
  const fields = readExactObject(
    selector,
    kind === 'journal-state'
      ? ['kind', 'state', 'occurrence']
      : ['kind', 'action', 'occurrence'],
  );
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
  } else {
    if (!CRASH_HOST_ACTIONS.has(fields.action)) {
      throw harnessError('unknown crash host action');
    }
    crashSelector = deepFreeze({
      kind,
      action: fields.action,
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
```

Add an active test that arms `controller-publish-intent`, lets install finish, revives the image, and proves:

```js
async function captureInstallImage(selector) {
  const harness = createLaunchAgentLifecycleHarness();
  harness.armCrashCapture(selector);
  const coordinator = createLaunchAgentLifecycleCoordinator(harness.dependencies());
  const completed = validateLaunchAgentReceipt(await coordinator.install({
    sourceCommit: COMMIT_A,
    scheduleSeconds: 300,
    controllerEnvironment: {},
  }));
  const image = harness.takeCrashImage();
  return {
    harness,
    image,
    revived: createLaunchAgentLifecycleHarness({ crashImage: image }),
    transactionId: completed.transactionId,
    completed,
  };
}

const { harness: original, image, revived, transactionId } = await captureInstallImage({
  kind: 'journal-state',
  state: 'controller-publish-intent',
  occurrence: 1,
});
assert.equal(original.journalStates(transactionId).at(-1), 'committed');
assert.equal(revived.journalStates(transactionId).at(-1), 'controller-publish-intent');
assert.deepEqual(revived.trace(), []);
assert.deepEqual(revived.adapterCalls(), []);
assert.throws(() => { image.sequence.clockIndex = 999; }, TypeError);
assert.throws(() => createLaunchAgentLifecycleHarness({
  crashImage: structuredClone(image),
}), /untrusted crash image/);
```

- [ ] **Step 7: Run Task 1 GREEN**

Run:

```bash
node --check test/helpers/launchagent-lifecycle-harness.js
node --check test/launchagent-lifecycle-recovery.test.js
node --test --test-name-pattern='Task 5A.2 harness|crash image' test/launchagent-lifecycle-recovery.test.js
node --test test/launchagent-lifecycle-recovery.test.js
```

Expected: Task 1 tests pass and existing Task 5A.1 recovery file remains GREEN because the production `recover` surface RED has not been added yet.

## Task 2: Capture Exact Mutation Boundaries and Add the Step 4 Lock Seam

**Files:**
- Modify: `test/helpers/launchagent-lifecycle-harness.js:365-405,531-680,920-978,1249-1788`
- Test: `test/launchagent-lifecycle-recovery.test.js`

**Interfaces:**
- Consumes: Task 1 `maybeCaptureCrash()` and branded revived harness.
- Produces: post-mutation capture with semantic action identity and `harness.preProveRecoveryLockRelease({ transactionId })`.
- The lock seam may only operate on a branded revived harness and may only clear the matching fake stale transaction lock after nonterminal/MIR checks.

- [ ] **Step 1: Write failing mutation-order and seam tests**

Add active tests for both windows of `controller-publish-intent`:

```js
test('crash image distinguishes intent/pre-mutation from mutation/pre-completed', async () => {
  const before = await captureInstallImage({
    kind: 'journal-state', state: 'controller-publish-intent', occurrence: 1,
  });
  const after = await captureInstallImage({
    kind: 'host-mutation', action: 'publish-controller', occurrence: 1,
  });
  assert.equal(before.revived.fileBytes('controller'), null);
  assert.ok(after.revived.fileBytes('controller'));
  assert.equal(
    after.revived.journalStates(after.transactionId).at(-1),
    'controller-publish-intent',
  );
});

test('pre-proven lock seam is exact and host-mutation free', async () => {
  const { revived, transactionId } = await captureInstallImage({
    kind: 'journal-state', state: 'controller-publish-intent', occurrence: 1,
  });
  assert.deepEqual(revived.lockState(), {
    transactionLock: true,
    manualInterventionLock: false,
  });
  revived.preProveRecoveryLockRelease({ transactionId });
  assert.deepEqual(revived.lockState(), {
    transactionLock: false,
    manualInterventionLock: false,
  });
  assert.deepEqual(revived.trace(), ['recovery-lock-seam']);
  assert.equal(revived.sentinels().hostMutationCount, 0);
});
```

Expected first run: FAIL because current simple events fire before actual state mutation and the lock seam is missing.

- [ ] **Step 2: Capture journal state only after durable append**

In `metadataStore.appendJournal`, immediately after `store.journal.push(...)` and before observation hooks:

```js
store.journal.push(deepFreeze({ ...entry, payload: deepFreeze({ ...entry.payload }) }));
maybeCaptureCrash('journal-state', entry.state);
```

Do not capture before writer lock, prior link, entry hash, operation continuity, and payload validation succeed.

- [ ] **Step 3: Add a post-state host mutation recorder**

Do not reuse `recordSimpleEvent()` as the capture point because atomicPublisher and launchctl currently call it before state mutation. Add:

```js
function semanticMutationAction(fallbackAction) {
  const transactionId = store.transactionLock?.transactionId ?? null;
  const latest = transactionId === null ? null : latestJournalEntry(transactionId);
  const match = latest?.state.match(/^compensate-([a-z-]+)-intent$/);
  return match ? match[1] : fallbackAction;
}

function recordSuccessfulHostMutation(fallbackAction) {
  maybeCaptureCrash('host-mutation', semanticMutationAction(fallbackAction));
}
```

Call it only after successful state change and counter increment:

```js
placeFile(role, bytes);
counters.publish += 1;
recordSuccessfulHostMutation(`publish-${role}`);
```

```js
removeFile(role);
counters.remove += 1;
recordSuccessfulHostMutation(`remove-${role}`);
```

```js
// After loaded/jobIdentity/printPhase changes for successful bootstrap/bootout.
recordSuccessfulHostMutation(`${operation}-${role}`);
```

Failed/nonzero/conditional-mismatch mutations must never produce a post-mutation crash image.

- [ ] **Step 4: Implement exact pre-proven recovery-lock release**

Track `const revivedFromCrashImage = revivedImage !== null`. Add `recovery-lock-seam` to the closed simple-event vocabulary and expose:

```js
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
```

Add negative tests for wrong transactionId, MIR journal/lock, unbranded fresh harness, extra key, double call, and missing lock. Add positive tests for a normal nonterminal, terminal-without-receipt, terminal-with-exact-receipt-and-stale-lock, and terminal-with-conflicting-receipt; the seam only proves stale-owner lock release and must not pre-judge receipt closure. Every negative case must retain journal/host/lock state byte-for-byte.

- [ ] **Step 5: Run Task 2 GREEN and related regression**

Run:

```bash
node --check test/helpers/launchagent-lifecycle-harness.js
node --test --test-name-pattern='crash image distinguishes|pre-proven lock' test/launchagent-lifecycle-recovery.test.js
node --test \
  test/launchagent-lifecycle-transactions.test.js \
  test/launchagent-lifecycle-recovery.test.js
```

Expected: all tests GREEN; real launchctl sentinel remains 0.

## Task 3: Add Public `recover` RED and the Complete Business-Intent Matrix

**Files:**
- Modify: `test/launchagent-lifecycle-recovery.test.js:1-end`
- Use only: `test/helpers/launchagent-lifecycle-harness.js` public test API from Tasks 1-2

**Interfaces:**
- Consumes: `armCrashCapture`, `takeCrashImage`, revived harness, lock seam, existing install/stop/uninstall/rollback fixtures.
- Produces: `recoverImplemented` capability gate, one active missing-surface RED, 20 business-intent recovery rows, and two intent-between-window rows.
- Every matrix row must first run an active reachability/capture assertion even while `recover` is missing; only the actual recovery assertion is capability-gated.

- [ ] **Step 1: Define exact business cases and operation fixtures**

Add the closed table:

```js
const BUSINESS_CRASH_CASES = Object.freeze([
  { intent: 'controller-publish-intent', action: 'publish-controller', operation: 'install' },
  { intent: 'scheduler-publish-intent', action: 'publish-scheduler', operation: 'install' },
  { intent: 'manifest-publish-intent', action: 'publish-manifest', operation: 'install' },
  { intent: 'controller-load-intent', action: 'bootstrap-controller', operation: 'install' },
  { intent: 'scheduler-load-intent', action: 'bootstrap-scheduler', operation: 'install' },
  { intent: 'scheduler-stop-intent', action: 'bootout-scheduler', operation: 'stop' },
  { intent: 'controller-stop-intent', action: 'bootout-controller', operation: 'stop' },
  { intent: 'scheduler-remove-intent', action: 'remove-scheduler', operation: 'uninstall' },
  { intent: 'controller-remove-intent', action: 'remove-controller', operation: 'uninstall' },
  { intent: 'manifest-remove-intent', action: 'remove-manifest', operation: 'uninstall' },
]);

const CRASH_PHASES = Object.freeze([
  { phase: 'intent-before-mutation', selectorKind: 'journal-state' },
  { phase: 'mutation-before-completed', selectorKind: 'host-mutation' },
]);
```

Implement exact `runBusinessFixture(row, selector)`:

- install: fresh harness and `coordinator.install({ sourceCommit:COMMIT_A, scheduleSeconds:300, controllerEnvironment:{} })`;
- stop: `seedInstalled({sourceCommit:COMMIT_A, loaded:{controller:true,scheduler:true}})`, reset, then `coordinator.stop({sourceCommit:COMMIT_B})`;
- uninstall: same managed seed/reset, then `coordinator.uninstall({sourceCommit:COMMIT_B})`.

Return `{ image, revived, transactionId, originalOperation, preOperationSnapshot, completedResult }`. Never hand-seed a nonterminal journal.

Use this closed implementation shape:

```js
async function runBusinessFixture(row, selector) {
  const harness = createLaunchAgentLifecycleHarness();
  if (row.operation === 'stop' || row.operation === 'uninstall') {
    harness.seedInstalled({
      sourceCommit: COMMIT_A,
      loaded: { controller: true, scheduler: true },
    });
    harness.resetObservations();
  } else if (row.operation !== 'install') {
    throw new Error(`unsupported business fixture operation: ${row.operation}`);
  }
  const preOperationSnapshot = {
    host: harness.hostSnapshot(),
    bytes: Object.fromEntries(
      ['controller', 'scheduler', 'manifest']
        .map((role) => [role, harness.fileBytes(role)]),
    ),
  };
  harness.armCrashCapture(selector);
  const coordinator = createLaunchAgentLifecycleCoordinator(harness.dependencies());
  let completedResult;
  if (row.operation === 'install') {
    completedResult = await coordinator.install({
      sourceCommit: COMMIT_A,
      scheduleSeconds: 300,
      controllerEnvironment: {},
    });
  } else if (row.operation === 'stop') {
    completedResult = await coordinator.stop({ sourceCommit: COMMIT_B });
  } else {
    completedResult = await coordinator.uninstall({ sourceCommit: COMMIT_B });
  }
  const completedReceipt = validateLaunchAgentReceipt(completedResult);
  const image = harness.takeCrashImage();
  return {
    harness,
    image,
    revived: createLaunchAgentLifecycleHarness({ crashImage: image }),
    transactionId: completedReceipt.transactionId,
    originalOperation: row.operation,
    preOperationSnapshot,
    completedResult: completedReceipt,
  };
}

function selectorFor(row, phase) {
  return phase.selectorKind === 'journal-state'
    ? { kind: 'journal-state', state: row.intent, occurrence: 1 }
    : { kind: 'host-mutation', action: row.action, occurrence: 1 };
}

function assertBusinessIdentity(fixture, row, phase) {
  const host = fixture.revived.hostSnapshot();
  const afterMutation = phase.phase === 'mutation-before-completed';
  if (row.action.startsWith('publish-')) {
    const role = row.action.slice('publish-'.length);
    assert.equal(host[role] !== null, afterMutation, `${row.action}: presence`);
    if (afterMutation) {
      assert.equal(host[role].sha256, fixture.harness.hostSnapshot()[role].sha256);
    }
    return;
  }
  if (row.action.startsWith('bootstrap-')) {
    const role = row.action.slice('bootstrap-'.length);
    assert.equal(host.loaded[role], afterMutation, `${row.action}: loaded`);
    assert.equal(host.jobIdentity[role] !== null, afterMutation, `${row.action}: identity`);
    assert.equal(host[role].sha256, fixture.harness.hostSnapshot()[role].sha256);
    return;
  }
  if (row.action.startsWith('bootout-')) {
    const role = row.action.slice('bootout-'.length);
    assert.equal(host.loaded[role], !afterMutation, `${row.action}: loaded`);
    assert.equal(host.jobIdentity[role] !== null, !afterMutation, `${row.action}: identity`);
    assert.equal(host[role].sha256, fixture.preOperationSnapshot.host[role].sha256);
    return;
  }
  if (row.action.startsWith('remove-')) {
    const role = row.action.slice('remove-'.length);
    assert.equal(host[role] !== null, !afterMutation, `${row.action}: presence`);
    if (!afterMutation) {
      assert.equal(host[role].sha256, fixture.preOperationSnapshot.host[role].sha256);
    }
    return;
  }
  throw new Error(`unsupported business fixture action: ${row.action}`);
}
```

- [ ] **Step 2: Add active reachability tests for all 20 business rows**

For each case/phase:

```js
test(`business crash fixture is reachable: ${row.intent}/${phase.phase}`, async () => {
  const fixture = await runBusinessFixture(row, selectorFor(row, phase));
  const entries = fixture.revived.journalEntries(fixture.transactionId);
  assert.equal(entries.at(-1).state, row.intent);
  assert.equal(entries.at(-1).operation, row.operation);
  assert.equal(fixture.revived.lockState().transactionLock, true);
  assertBusinessIdentity(fixture, row, phase);
});
```

`assertBusinessIdentity` compares the affected file SHA-256 against the completed candidate or pre-operation snapshot wherever presence is expected. Do not infer success from trace alone.

- [ ] **Step 3: Add the one active production surface RED**

After creating a surface coordinator:

```js
const recoverImplemented = typeof surfaceCoordinator.recover === 'function';

test('Task 5A.2 coordinator exposes recover', () => {
  assert.equal(
    typeof surfaceCoordinator.recover,
    'function',
    'expected coordinator.recover to implement Task 5A.2',
  );
});
```

Run:

```bash
node --test --test-name-pattern='Task 5A.2 coordinator exposes recover' \
  test/launchagent-lifecycle-recovery.test.js
```

Expected: exactly one intended FAIL at the method assertion.

- [ ] **Step 4: Add capability-gated business recovery assertions**

Inside `if (recoverImplemented)`, for each of the 20 fixtures:

```js
function expectedBusinessRecoveryState(row, phase) {
  return row.operation === 'install'
    && row.action === 'bootstrap-scheduler'
    && phase.phase === 'mutation-before-completed'
    ? 'committed'
    : 'recovered';
}

function assertPreOperationHostState(fixture) {
  const current = fixture.revived.hostSnapshot();
  const expected = fixture.preOperationSnapshot.host;
  for (const role of ['controller', 'scheduler', 'manifest']) {
    assert.equal(current[role]?.sha256 ?? null, expected[role]?.sha256 ?? null, `${role}: sha256`);
    assert.deepEqual(fixture.revived.fileBytes(role), fixture.preOperationSnapshot.bytes[role]);
  }
  assert.deepEqual(current.loaded, expected.loaded);
  assert.deepEqual(current.jobIdentity, expected.jobIdentity);
}

fixture.revived.preProveRecoveryLockRelease({ transactionId: fixture.transactionId });
const coordinator = createLaunchAgentLifecycleCoordinator(fixture.revived.dependencies());
const receipt = validateLaunchAgentReceipt(
  await coordinator.recover({ transactionId: fixture.transactionId }),
);
assert.equal(receipt.operation, fixture.originalOperation);
const expectedState = expectedBusinessRecoveryState(row, phase);
assert.equal(receipt.state, expectedState);
assert.equal(receipt.success, expectedState === 'committed');
if (expectedState === 'recovered') assertPreOperationHostState(fixture);
else assert.equal(receipt.outcome, 'completed');
assert.equal(countEvent(fixture.revived.trace(), row.action), 0, `${row.action}: no forward replay`);
```

`expectedBusinessRecoveryState` returns `committed` only for the first-install scheduler bootstrap post-mutation image, whose entire operation post-state can be independently verified; every other row returns `recovered` to the pre-operation anchor. If actual coordinator ordering shows another row has a complete post-state, add that row explicitly only after proving all file/job/runtime identities, never by last-state-name heuristic.

- [ ] **Step 5: Add the two intent-between windows**

Capture with journal-state selectors:

```js
const BETWEEN_INTENT_WINDOWS = Object.freeze([
  {
    state: 'manifest-published',
    expected: 'controller+scheduler+manifest published; controller not loaded',
  },
  {
    state: 'controller-ready',
    expected: 'controller loaded and identity-proven; scheduler not loaded',
  },
]);
```

Active reachability assertions must prove exact files/job identities. Capability-gated recovery assertions must converge to the pre-install anchor with `state='recovered'`; neither row may be misclassified as pending intent or forward committed.

- [ ] **Step 6: Validate Task 3 as an effective RED**

Run:

```bash
node --check test/launchagent-lifecycle-recovery.test.js
node --test test/launchagent-lifecycle-recovery.test.js
```

Expected:

- all harness/reachability/Task 5A.1 rows PASS;
- exactly one FAIL: `Task 5A.2 coordinator exposes recover`;
- recovery behavior rows are structurally present but not executed until the capability exists;
- no import, TypeError cascade, real host access, or unrelated failure.

## Task 4: Add the Complete Compensation Matrix

**Files:**
- Modify: `test/launchagent-lifecycle-recovery.test.js`
- Modify only if a missing observation seam is proven: `test/helpers/launchagent-lifecycle-harness.js`

**Interfaces:**
- Consumes: existing `failNextRevalidation('before-commit')`, Task 2 semantic compensation mutation capture, frozen reverse-plan journal payload.
- Produces: 20 reachable compensation crash fixtures and capability-gated assertions that recovery resumes exactly one plan/action.

- [ ] **Step 1: Define the closed compensation table**

```js
const UPGRADE_COMPENSATION_ACTIONS = Object.freeze([
  'stop-scheduler',
  'stop-controller',
  'restore-manifest',
  'restore-scheduler',
  'restore-controller',
  'load-controller',
  'load-scheduler',
]);
```

First verify which actions are reachable from one managed-upgrade failure after the full new post-state is staged/loaded. If the existing frozen reverse plan also contains `remove-*` rather than `restore-*` for a first-install failure, add a second exact fixture:

```js
const INSTALL_COMPENSATION_ACTIONS = Object.freeze([
  'stop-scheduler',
  'stop-controller',
  'remove-manifest',
  'remove-scheduler',
  'remove-controller',
]);
```

Build exactly one reachable fixture family per unique action:

```js
const COMPENSATION_CASES = Object.freeze([
  ...UPGRADE_COMPENSATION_ACTIONS.map((action) => ({ action, operation: 'managed-upgrade' })),
  ...INSTALL_COMPENSATION_ACTIONS
    .filter((action) => !UPGRADE_COMPENSATION_ACTIONS.includes(action))
    .map((action) => ({ action, operation: 'install' })),
]);
```

The 10-row union must equal the production contract set exactly:

```js
assert.deepEqual(
  COMPENSATION_CASES.map(({ action }) => action).sort(),
  [
    'load-controller', 'load-scheduler',
    'remove-controller', 'remove-manifest', 'remove-scheduler',
    'restore-controller', 'restore-manifest', 'restore-scheduler',
    'stop-controller', 'stop-scheduler',
  ],
);
```

Do not invent a fixture for an unreachable action. If a required action cannot be produced by the current operation paths, the Task 4 result is `FAILED_VERIFICATION`, not a hand-seeded substitute.

- [ ] **Step 2: Build reachable install/upgrade compensation fixtures**

Upgrade fixture:

```js
const harness = createLaunchAgentLifecycleHarness();
harness.seedInstalled({
  sourceCommit: COMMIT_A,
  loaded: { controller: true, scheduler: true },
});
harness.resetObservations();
harness.failNextRevalidation('before-commit');
harness.armCrashCapture(selector);
const coordinator = createLaunchAgentLifecycleCoordinator(harness.dependencies());
const result = await coordinator.managedUpgrade(upgradeInput());
```

Install fixture uses a fresh absent host, the same failure boundary, and `coordinator.install(...)`. Each operation may continue after capture; only the captured image is used for revived recovery.

- [ ] **Step 3: Add 20 active reachability assertions**

For each action, capture:

```js
{ kind:'journal-state', state:`compensate-${action}-intent`, occurrence:1 }
{ kind:'host-mutation', action, occurrence:1 }
```

Assert for both images:

```js
const entries = revived.journalEntries(transactionId);
const compensating = entries.find((entry) => entry.state === 'compensating');
const latest = entries.at(-1);
const expectedStep = compensating.payload.reversePlan.find(
  (step) => step.action === action,
);
assert.ok(expectedStep, `${action}: reachable frozen step`);
assert.equal(latest.state, `compensate-${action}-intent`);
assert.equal(latest.payload.action, action);
assert.equal(latest.payload.planIndex, expectedStep.index);
assert.equal(latest.payload.reversePlanSha256, compensating.payload.reversePlanSha256);
assert.deepEqual(compensating.payload.reversePlan[expectedStep.index], expectedStep);
```

The pre-mutation image must equal `expectedPre`; the post-mutation image must equal `expectedPost`, using exact file bytes/hash/job identity rather than trace text.

Use this exact state assertion for the current step role:

```js
function assertReverseExpected(harness, step, expected) {
  const host = harness.hostSnapshot();
  const file = host[step.role];
  if (expected.file.state === 'absent') {
    assert.equal(file, null, `${step.action}: file absent`);
  } else {
    assert.equal(file?.device, expected.file.identity.device);
    assert.equal(file?.inode, expected.file.identity.inode);
    assert.equal(file?.sha256, expected.file.sha256);
    assert.equal(harness.sha256(harness.fileBytes(step.role)), expected.file.sha256);
  }
  if (step.role !== 'manifest') {
    const loaded = expected.job.state === 'loaded';
    assert.equal(host.loaded[step.role], loaded, `${step.action}: loaded`);
    assert.equal(host.jobIdentity[step.role], expected.job.identitySha256);
  }
}

assertReverseExpected(
  revived,
  expectedStep,
  phase === 'intent-before-mutation' ? expectedStep.expectedPre : expectedStep.expectedPost,
);
```

- [ ] **Step 4: Add capability-gated compensation recovery assertions**

For each revived image:

```js
revived.preProveRecoveryLockRelease({ transactionId });
const receipt = validateLaunchAgentReceipt(await createLaunchAgentLifecycleCoordinator(
  revived.dependencies(),
).recover({ transactionId }));
assert.equal(receipt.operation, originalOperation);
assert.equal(receipt.state, 'recovered');
assert.equal(receipt.success, false);
assert.equal(
  new Set(revived.journalEntries(transactionId)
    .filter((entry) => entry.state === 'compensating')
    .map((entry) => entry.payload.reversePlanSha256)).size,
  1,
);
assertPreOperationHostState(fixture);
```

For the post-mutation image, assert the current action's host side effect count does not increase. The first appended recovery checkpoint for that action must be its completed state, followed by the remaining original plan; no second `compensating` entry or new plan hash is allowed.

- [ ] **Step 5: Re-run focused RED without changing its signature**

Run:

```bash
node --check test/launchagent-lifecycle-recovery.test.js
node --test test/launchagent-lifecycle-recovery.test.js
```

Expected: same unique intended missing-`recover` failure; all 20 compensation reachability rows PASS; no new failure signature.

## Task 5: Add Terminal-Publication, Fail-Closed, Input, and Privacy RED

**Files:**
- Modify: `test/launchagent-lifecycle-recovery.test.js`
- Modify if required for deterministic receipt-race injection: `test/helpers/launchagent-lifecycle-harness.js`

**Interfaces:**
- Consumes: terminal journal-state crash capture, existing `deleteReceiptFor`, `misalignReceiptHashFor`, `driftHostFile`, `setProbeMode`, `failNextAtomicExpectedValidation`, `failNextRevalidation`.
- Produces: terminal receipt repair matrix, four MIR classification rows, exact input rejection, original-operation and privacy assertions.

- [ ] **Step 1: Capture the real current terminal-journal/receipt gap**

Arm `{ kind:'journal-state', state:'committed', occurrence:1 }` during first install. The active reachability test must prove:

```js
const latest = revived.journalEntries(transactionId).at(-1);
assert.equal(latest.state, 'committed');
assert.equal(revived.receiptFor(transactionId), null);
assert.equal(typeof latest.payload.receiptSha256, 'string');
assert.equal(Object.hasOwn(latest.payload, 'receipt'), false);
assert.equal(revived.sentinels().hostMutationCount, 0);
```

This active test documents the current production gap without adding a second active RED. Inside `if (recoverImplemented)`, require terminal payload `receipt` projection/hash closure and exact no-clobber republish; current production must then fail until future GREEN updates the schema.

- [ ] **Step 2: Add terminal receipt variants**

Capability-gated cases:

1. missing receipt from the committed crash image: zero host mutation, publish exact embedded projection, revalidate, release lock;
2. exact already-existing receipt from `seedInstalled`: return/revalidate it idempotently, zero host mutation;
3. no-clobber race creates the exact receipt before publish: re-read exact receipt and succeed;
4. `misalignReceiptHashFor(transactionId)`: do not overwrite, classify MIR, ordinary lock release forbidden.

If case 3 needs a new helper method, name it exactly:

```js
harness.raceExactTerminalReceiptOnNextPublish({ transactionId });
```

It may only arm one race, must derive the exact projection from the validated terminal payload at call time, and must reject terminals without an embedded receipt. It is an injection, not a seed path.

Implement it with one pending transaction id and inject immediately before the existing receipt-exists check in `metadataStore.publishReceipt`:

```js
let exactReceiptRaceTransactionId = null;

// harness method
raceExactTerminalReceiptOnNextPublish(input) {
  const fields = readExactObject(input, ['transactionId']);
  const transactionId = requireUuid(fields.transactionId);
  if (exactReceiptRaceTransactionId !== null) {
    throw harnessError('terminal receipt race already armed');
  }
  exactReceiptRaceTransactionId = transactionId;
},

// metadataStore.publishReceipt, after terminal/lock/hash validation
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
```

The future coordinator must handle this no-clobber failure by re-reading and accepting only an exact receipt; the helper must not make `publishReceipt` itself silently succeed.
`resetObservations()` must set `exactReceiptRaceTransactionId = null`; crash-image capture excludes it and revived harnesses start with it unarmed.

- [ ] **Step 3: Add the four fail-closed representative rows**

Create reachable crash images, then apply existing deterministic fault seams before `recover`:

```text
mixed file identity       -> driftHostFile('scheduler')
unknown job probe         -> setProbeMode('controller', 'unknown')
conditional CAS mismatch -> failNextAtomicExpectedValidation('replace', 'controller')
final verification fail  -> failNextRevalidation('compensate-before-close')
```

Each capability-gated assertion must prove:

```js
const receiptBefore = revived.receiptFor(transactionId);
const result = validateLaunchAgentReceipt(await coordinator.recover({ transactionId }));
assert.equal(result.state, 'manual-intervention-required');
assert.equal(result.success, false);
assert.deepEqual(revived.receiptFor(transactionId), receiptBefore);
const afterEntries = revived.journalEntries(transactionId);
const planEntries = afterEntries.filter((entry) => entry.state === 'compensating');
assert.ok(planEntries.length <= 1, 'must not create a second compensation plan');
assert.ok(new Set(planEntries.map((entry) => entry.payload.reversePlanSha256)).size <= 1);
assert.equal(afterEntries.at(-1).state, 'manual-intervention-required');
```

For mixed identity, unknown probe, and CAS mismatch also assert `revived.sentinels().hostMutationCount === 0`. The final-verification row may contain the already completed frozen reverse-plan mutations, but its trace must end at the failed revalidation/MIR journal with no subsequent host event. Do not test MIR lock handoff/takeover/release; that remains Step 5 of the parent plan.

- [ ] **Step 4: Add exact input and hostile-object rejection**

Inside the capability gate, call `recover` with:

```js
const validId = fixture.transactionId;
[
  null,
  {},
  { transactionId: 'not-a-uuid' },
  { transactionId: validId, sourceCommit: COMMIT_A },
  { transactionId: validId, operation: 'install' },
  { transactionId: validId, approved: true },
  Object.create(null),
]
```

Also construct own getter and symbol-key cases with `Object.defineProperty`. Every case must reject with exact `launchagent-lifecycle-invalid` before any adapter call or host mutation.

- [ ] **Step 5: Add original-operation, schema, and privacy assertions**

For install/upgrade/stop/rollback/uninstall recovery fixtures assert:

```js
assert.equal(receipt.operation, originalOperation);
assert.notEqual(receipt.operation, 'recover');
assert.deepEqual(Reflect.ownKeys(receipt).sort(), [
  'anchorId', 'completedAt', 'hostMutationCount', 'operation', 'outcome',
  'roles', 'schemaVersion', 'sourceCommit', 'state', 'success', 'transactionId',
].sort());
```

Recursively reject public keys/values matching absolute path, HOME, username, `stdout`, `stderr`, `argv`, `environment`, `token`, `secret`, or free-form exception message patterns. Keep the existing narrow public identifier exceptions already accepted by the lifecycle contracts.

Use a closed receipt checker rather than scanning arbitrary internal fixtures:

```js
function assertSafeReceiptProjection(value) {
  const forbiddenKey = /^(?:path|home|username|stdout|stderr|argv|environment|token|secret|message)$/iu;
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, nested] of Object.entries(node)) {
        assert.equal(forbiddenKey.test(key), false, `forbidden receipt key: ${key}`);
        visit(nested);
      }
      return;
    }
    if (typeof node === 'string') {
      assert.equal(node.startsWith('/'), false, 'absolute path in receipt');
      assert.equal(node.includes('$HOME'), false, 'HOME token in receipt');
      assert.equal(node.includes('launchagent-harness:'), false, 'exception text in receipt');
    }
  };
  visit(value);
}
```

- [ ] **Step 6: Verify the final RED signature**

Run:

```bash
node --check test/helpers/launchagent-lifecycle-harness.js
node --check test/launchagent-lifecycle-recovery.test.js
node --test test/launchagent-lifecycle-recovery.test.js
```

Expected: exactly one active failure, `Task 5A.2 coordinator exposes recover`; all helper, reachability, Task 5A.1, terminal-gap observation, input test definitions and privacy setup parse correctly; no production file changed.

## Task 6: Independent Verification, Review, and Human Commit Gate

**Files:**
- Verify only: the two allowed test files and protected hashes.
- Do not modify: production, spec, parent plan, package-lock, deployment or host files.

**Interfaces:**
- Consumes: completed Task 1-5 test-only diff.
- Produces: reproducible intended RED evidence, regression evidence, diff/allowlist report, fresh reviewer finding table, Codex PM verdict.

- [ ] **Step 1: Verify syntax and unique intended RED**

Run:

```bash
node --check test/helpers/launchagent-lifecycle-harness.js
node --check test/launchagent-lifecycle-recovery.test.js
node --test test/launchagent-lifecycle-recovery.test.js
```

Expected: checks exit 0; focused test exits nonzero with exactly the missing `coordinator.recover` surface failure. Count pass/fail/skip explicitly; a TypeError cascade, import error, helper failure or unrelated Task 5A.1 regression is `FAILED_VERIFICATION`.

- [ ] **Step 2: Run related regression excluding the intentional RED file**

Run:

```bash
node --test \
  test/launchagent-lifecycle-contracts.test.js \
  test/launchagent-lifecycle-metadata.test.js \
  test/launchagent-lifecycle-profiles.test.js \
  test/launchagent-lifecycle-host-adapter.test.js \
  test/launchagent-lifecycle-transactions.test.js
```

Expected: all existing related tests pass. This does not claim full-repo GREEN because the new focused RED is intentionally failing.

- [ ] **Step 3: Verify allowlist and protected hashes**

Run:

```bash
git status --short --branch
git diff --check -- \
  test/helpers/launchagent-lifecycle-harness.js \
  test/launchagent-lifecycle-recovery.test.js
git diff --name-only
git diff --stat -- \
  test/helpers/launchagent-lifecycle-harness.js \
  test/launchagent-lifecycle-recovery.test.js
shasum -a 256 \
  docs/superpowers/specs/2026-07-30-linke-v146-task5a2-crash-recovery-red-design.md \
  src/launchagent-lifecycle/contracts.js \
  src/launchagent-lifecycle/host-adapter.js \
  src/launchagent-lifecycle/metadata-store.js \
  src/launchagent-lifecycle/profiles.js \
  src/launchagent-lifecycle/transaction-coordinator.js
```

Expected: implementation diff contains only the two allowed test files; the untracked plan file may exist as PM documentation; protected hashes equal Task 1. Never open/hash `package-lock.json`.

- [ ] **Step 4: Fresh reviewer and Codex PM verification**

Dispatch one fresh read-only reviewer with:

- exact spec/plan excerpts;
- full two-file diff;
- focused RED output;
- related regression totals;
- protected hash and allowlist evidence;
- explicit instruction not to edit, run commands, or claim local access.

Reviewer must return `PASS`, `PASS_WITH_FINDINGS`, or `REJECT` with P0/P1 findings. Codex PM independently reproduces syntax, focused RED, related regression, status, diff and hashes; worker narrative alone is not evidence.

- [ ] **Step 5: Stop at the human commit gate**

If and only if the RED is valid and review has no unresolved P0/P1, propose:

```bash
git add -- \
  test/helpers/launchagent-lifecycle-harness.js \
  test/launchagent-lifecycle-recovery.test.js
git commit -m "test: add V1.46 crash recovery RED"
```

Do not run these commands without a new explicit commit approval. Do not push. Do not begin production GREEN under this plan.

## Completion Checklist

- [ ] The user-approved amended-spec + plan docs-only commit is the last-green anchor before test work.
- [ ] Crash image is module-branded, base64 byte encoded, detached and deep-frozen.
- [ ] Revive restores only durable allowlisted state and resets all observations/failures/hooks.
- [ ] Journal capture occurs after durable append; host capture occurs after successful state mutation and before completed journal.
- [ ] Pre-proven lock seam is test-only, exact, zero-host-mutation and does not claim Step 7.
- [ ] All 20 business and all 20 compensation pre/post fixtures are reachable without hand-seeded nonterminal chains.
- [ ] Two fixed intent-between windows are covered.
- [ ] Terminal missing/exact/race/mismatch variants are defined.
- [ ] Mixed/unknown/CAS/final-verification cases fail closed without a second plan.
- [ ] Exact recover input, original operation and privacy contracts are asserted.
- [ ] Focused result has exactly one intended missing-`recover` failure.
- [ ] Related lifecycle regression is green.
- [ ] Diff contains only the two allowed test files; package-lock remains untouched.
- [ ] No commit, push, real LaunchAgent or production action occurs without a new explicit gate.
