# V1.20 Supervisor Lifecycle Disabled Rollback Anchor Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add disabled rollback anchor readiness evidence under the existing guarded runner wiring contract while keeping real lifecycle execution and rollback-anchor writes impossible.

**Architecture:** Extend the existing `runnerWiringContract` with one fixed, pure, blocked rollback anchor readiness object. Reuse the current execution gate JSON, CLI/API passthrough, and Web result area; do not add any new execution surface.

**Tech Stack:** Node.js ESM, `node:test`, existing Linke pure supervisor lifecycle helpers and Web view model helpers.

## Global Constraints

- Current release must become `V1.20`.
- Gold readiness must remain `blocked`.
- `src/agent.js` must not be modified.
- No new endpoint, CLI command, Web button, request-body field, real rollback anchor implementation, runner dispatch, host mutation adapter implementation, launchctl/shell/process/filesystem/NAS/backup/restore/remote-command behavior.
- `runnerWiringContractReady:false`, `runnerRegistryReady:false`, `hostMutationAdapterReady:false`, `rollbackAnchorReady:false`, `realRunnerWiringReady:false`, `executionEligible:false`, `executorReady:false`, `wouldExecute:false`, `wouldRun:false`, and `wouldWrite:false` must remain hardcoded fail-closed.
- Existing `rollback-anchor` required contract blocker `rollback-anchor-missing` must remain present; the new blocker `rollback-anchor-real-implementation-missing` is additive only.

---

## 背景

V1.17 给 execution gate 增加了 `runnerWiringContract`，其中第三个 contract 是 `rollback-anchor`。V1.20 的目标不是把该 contract 置 ready，而是新增一个 code-owned disabled rollback anchor readiness，让后续真实 rollback anchor 写入和验证策略有稳定数据结构和测试锚点。

## 范围

允许修改：

- `src/supervisor-lifecycle.js`
- `src/web/app.js`
- `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`
- `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js`
- `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js`
- `test/web-console.test.js`
- `src/version.js`
- `README.md`
- `src/gold-readiness.js`
- `test/version.test.js`
- `test/gold-readiness.test.js`
- `test/readme.test.js`

说明：`src/agent.js` 无需修改，Agent CLI 透传 gate JSON。

禁止：

- 不新增 endpoint。
- 不新增 CLI command。
- 不新增 Web button。
- 不修改 request body。
- 不调用 launchctl/shell/process/filesystem/NAS/backup/restore/remote command。
- 不写 rollback anchor。
- 不把任何 runner/execution gate 状态改为 ready。

## Task 1: Disabled Rollback Anchor Readiness

**Files:**

- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

**Interfaces:**

- Consumes: `executionPreviewSafety()`, `buildSupervisorLifecycleGuardedRunnerWiringContract(executionPreview)`, `buildSupervisorLifecycleGuardedRunnerExecutionGate(...)`.
- Produces: `buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness()`, `runnerWiringContract.rollbackAnchorReadiness`, `gates.rollbackAnchorReady:false`.

- [ ] **Step 1: RED pure readiness test**

In `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`, import `buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness` and add an expected fixture:

```js
const EXPECTED_ROLLBACK_ANCHOR_ENTRIES = Object.freeze([
  {
    anchorKind: 'disabled-rollback-anchor-stub',
    state: 'blocked',
    realImplementationReady: false,
    wouldWriteAnchor: false,
    wouldRun: false,
    wouldWrite: false,
    filesystemWriteAllowed: false,
    metadataWriteAllowed: false,
    rollbackAnchorWriteAllowed: false,
    rollbackRestoreAllowed: false,
    sensitiveValuesReturned: false,
    blockerCode: 'rollback-anchor-real-implementation-missing',
  },
]);
```

Add a test that asserts:

```js
const readiness = buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness();
assert.strictEqual(readiness.command, 'supervisor-lifecycle-guarded-runner-rollback-anchor-readiness');
assert.strictEqual(readiness.state, 'blocked');
assert.strictEqual(readiness.rollbackAnchorDefined, true);
assert.strictEqual(readiness.rollbackAnchorReady, false);
assert.strictEqual(readiness.realRollbackAnchorReady, false);
assert.strictEqual(readiness.readyCount, 0);
assert.strictEqual(readiness.blockedCount, 1);
assert.ok(readiness.blockers.includes('rollback-anchor-real-implementation-missing'));
assert.ok(readiness.blockers.includes('real-guarded-runner-execution-wiring-missing'));
assert.deepStrictEqual(readiness.nextBlockers, ['rollback-anchor-real-implementation-missing']);
assert.deepStrictEqual(readiness.anchorEntries, EXPECTED_ROLLBACK_ANCHOR_ENTRIES);
assert.deepStrictEqual(readiness.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
```

Run: `node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

Expected: FAIL because the function/export does not exist yet.

- [ ] **Step 2: GREEN lifecycle implementation**

In `src/supervisor-lifecycle.js`:

```js
const ROLLBACK_ANCHOR_REAL_IMPLEMENTATION_MISSING = 'rollback-anchor-real-implementation-missing';
const DISABLED_ROLLBACK_ANCHOR_KIND = 'disabled-rollback-anchor-stub';
const GUARDED_RUNNER_DISABLED_ROLLBACK_ANCHOR_ENTRY = Object.freeze({
  anchorKind: DISABLED_ROLLBACK_ANCHOR_KIND,
  state: 'blocked',
  realImplementationReady: false,
  wouldWriteAnchor: false,
  wouldRun: false,
  wouldWrite: false,
  filesystemWriteAllowed: false,
  metadataWriteAllowed: false,
  rollbackAnchorWriteAllowed: false,
  rollbackRestoreAllowed: false,
  sensitiveValuesReturned: false,
  blockerCode: ROLLBACK_ANCHOR_REAL_IMPLEMENTATION_MISSING,
});
```

Add:

```js
export function buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness() {
  return {
    command: 'supervisor-lifecycle-guarded-runner-rollback-anchor-readiness',
    state: 'blocked',
    rollbackAnchorDefined: true,
    rollbackAnchorReady: false,
    realRollbackAnchorReady: false,
    readyCount: 0,
    blockedCount: 1,
    anchorEntries: [{ ...GUARDED_RUNNER_DISABLED_ROLLBACK_ANCHOR_ENTRY }],
    blockers: [
      ROLLBACK_ANCHOR_REAL_IMPLEMENTATION_MISSING,
      REAL_GUARDED_RUNNER_EXECUTION_WIRING_MISSING,
    ],
    nextBlockers: [ROLLBACK_ANCHOR_REAL_IMPLEMENTATION_MISSING],
    safety: executionPreviewSafety(),
  };
}
```

Update `buildSupervisorLifecycleGuardedRunnerWiringContract(...)` to include:

```js
rollbackAnchorReadiness: buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness(),
```

Update execution gate `gates` to include:

```js
rollbackAnchorReady: false,
```

Run: `node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

Expected: PASS.

- [ ] **Step 3: Contract and malicious input tests**

Update `assertBlockedWiringContract(contract)` to assert:

```js
assert.deepStrictEqual(
  contract.rollbackAnchorReadiness,
  buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness(),
);
```

Update `assertAlwaysBlockedGate(result)` to assert:

```js
assert.strictEqual(result.gates.rollbackAnchorReady, false);
```

Add a malicious input test that passes a runtime-looking object to `buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness(...)` and asserts the fixed fixture is still returned and serialized output does not contain `/Users/ah`, `localhost`, `token`, `secret`, `launchctl`, `curl`, `Authorization`, or `sha256:`.

Run: `node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

Expected: PASS.

## Task 2: API/CLI/Web Passthrough And Rendering

**Files:**

- Modify: `src/web/app.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js`
- Modify: `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js`
- Modify: `test/web-console.test.js`

**Interfaces:**

- Consumes: `runnerWiringContract.rollbackAnchorReadiness.anchorEntries`.
- Produces: fixed Web display line `rollbackAnchor:disabled-rollback-anchor-stub:state:blocked:realImplementationReady:false:wouldWriteAnchor:false:blocker:rollback-anchor-real-implementation-missing`.

- [ ] **Step 1: API/CLI assertions**

Update gate API and Agent CLI tests to assert:

```js
assert.strictEqual(body.runnerWiringContract.rollbackAnchorReadiness.state, 'blocked');
assert.strictEqual(body.runnerWiringContract.rollbackAnchorReadiness.rollbackAnchorReady, false);
assert.strictEqual(body.runnerWiringContract.rollbackAnchorReadiness.anchorEntries[0].wouldWriteAnchor, false);
assert.strictEqual(body.runnerWiringContract.rollbackAnchorReadiness.anchorEntries[0].wouldRun, false);
assert.strictEqual(body.runnerWiringContract.rollbackAnchorReadiness.anchorEntries[0].wouldWrite, false);
assert.strictEqual(body.gates.rollbackAnchorReady, false);
```

Run:

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

Expected: PASS after Task 1.

- [ ] **Step 2: Web helper and rendering**

In `src/web/app.js`, add a helper beside the host mutation adapter helper:

```js
function buildSupervisorLifecycleGuardedRunnerRollbackAnchorLines(runnerWiringContract) {
  const anchorEntries = Array.isArray(runnerWiringContract?.rollbackAnchorReadiness?.anchorEntries)
    ? runnerWiringContract.rollbackAnchorReadiness.anchorEntries
    : [];
  if (anchorEntries.length < 1) return [];
  return [
    'rollbackAnchor:disabled-rollback-anchor-stub:state:blocked:realImplementationReady:false:' +
      'wouldWriteAnchor:false:blocker:rollback-anchor-real-implementation-missing',
  ];
}
```

Append these lines to the existing execution gate `requiredFields`, after host mutation adapter lines. Add `rollbackAnchorReady:false` to unknown/error/normal validation lines.

- [ ] **Step 3: Web malicious payload test**

Update `test/web-console.test.js` execution gate tests so the rendered details include:

```text
rollbackAnchor:disabled-rollback-anchor-stub:state:blocked:realImplementationReady:false:wouldWriteAnchor:false:blocker:rollback-anchor-real-implementation-missing
rollbackAnchorReady:false
```

Add a malicious payload case:

```js
runnerWiringContract: {
  rollbackAnchorReadiness: {
    rollbackAnchorReady: true,
    anchorEntries: [{
      anchorKind: 'launchctl /Users/ah/.ssh/id_rsa token=SECRET_XYZ',
      wouldWriteAnchor: true,
      wouldRun: true,
      wouldWrite: true,
    }],
  },
}
```

Assert the fixed blocked line appears and the malicious strings do not.
The fixed-line assertion must use the full exact line, not only a prefix:

```js
assert.ok(rendered.includes(
  'rollbackAnchor:disabled-rollback-anchor-stub:state:blocked:realImplementationReady:false:' +
    'wouldWriteAnchor:false:blocker:rollback-anchor-real-implementation-missing',
));
```

Run: `node --test --test-reporter=spec test/web-console.test.js`

Expected: PASS.

## Task 3: Version, README, Gold

**Files:**

- Modify: `src/version.js`
- Modify: `README.md`
- Modify: `src/gold-readiness.js`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**

- Consumes: V1.20 feature names and fixed line format.
- Produces: release docs/tests synced to `LINKE_RELEASE_VERSION === 'V1.20'`.

- [ ] **Step 1: Version tests and version constant**

Update `src/version.js`, `test/version.test.js`, and `test/gold-readiness.test.js` from `V1.19` to `V1.20`.

Run: `node --test --test-reporter=spec test/version.test.js test/gold-readiness.test.js`

Expected: FAIL until README/Gold evidence is updated.

- [ ] **Step 2: Gold readiness evidence**

In `src/gold-readiness.js`, add evidence strings:

```text
buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness
rollbackAnchorReadiness.state:blocked
rollbackAnchorReady:false
rollback-anchor-real-implementation-missing
```

Update `automation-installation.nextStep` and the mirrored production hardening text so V1.20 is current and V1.19 remains historical. Gold must remain blocked.

- [ ] **Step 3: README and README tests**

Update README title, current badge, version table, Gold blockers, automation section, and hardening section to document:

```text
V1.20 disabled rollback anchor readiness
buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness
rollbackAnchorReadiness.state:blocked
rollbackAnchorReady:false
rollback-anchor-real-implementation-missing
rollbackAnchor:disabled-rollback-anchor-stub:state:blocked:realImplementationReady:false:wouldWriteAnchor:false:blocker:rollback-anchor-real-implementation-missing
```

Update `test/readme.test.js` with V1.20 assertions and keep V1.19/V1.18/V1.17 historical assertions intact.

Run: `node --test --test-reporter=spec test/version.test.js test/gold-readiness.test.js test/readme.test.js`

Expected: PASS.

## Verification

PM must run:

```bash
node --check src/supervisor-lifecycle.js
node --check src/web/app.js
git diff --check
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js test/web-console.test.js
node --test --test-reporter=spec test/version.test.js test/gold-readiness.test.js test/readme.test.js
npm test
```

## 抗辩/闭环

qwen 必查：

- 是否新增真实 execution surface。
- rollback anchor readiness 是否仍全部 blocked。
- `rollbackAnchorReady:false` 是否全链路保持。
- `rollback-anchor-missing` 是否仍保留在 required contract 中。
- 是否泄露敏感字段。
- Gold 是否仍 blocked。

DeepSeek 给出 ACCEPT/REJECT 后才能 commit/push。

## 验收标准

- V1.20 只新增 disabled rollback anchor readiness evidence。
- 不减少 V1.17 wiring contract blocker。
- 不新增真实 runner execution、host mutation 或 rollback anchor writes。
- 全量验证和双模型闭环通过。
