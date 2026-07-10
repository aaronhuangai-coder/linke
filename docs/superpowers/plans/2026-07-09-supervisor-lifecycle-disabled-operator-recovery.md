# V1.22 Supervisor Lifecycle Disabled Operator Recovery Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add disabled operator recovery readiness evidence under the existing guarded runner wiring contract while keeping real lifecycle execution, recovery, retry, notification, and writes impossible.

**Architecture:** Extend the existing `runnerWiringContract` with one fixed, pure, blocked operator recovery readiness object. Reuse the current execution gate JSON, CLI/API passthrough, and Web result area; do not add any new execution surface.

**Tech Stack:** Node.js ESM, `node:test`, existing Linke pure supervisor lifecycle helpers and Web view model helpers.

## Global Constraints

- Current release must become `V1.22`.
- Gold readiness must remain `blocked`.
- `src/agent.js` must not be modified.
- No new endpoint, CLI command, Web button, request-body field, real operator recovery implementation, real retry scheduler, real operator notification, real rollback anchor, runner dispatch, host mutation adapter implementation, launchctl/shell/process/filesystem/NAS/backup/restore/remote-command behavior.
- `runnerWiringContractReady:false`, `runnerRegistryReady:false`, `hostMutationAdapterReady:false`, `rollbackAnchorReady:false`, `attemptAuditReady:false`, `operatorRecoveryReady:false`, `realRunnerWiringReady:false`, `executionEligible:false`, `executorReady:false`, `wouldExecute:false`, `wouldRun:false`, and `wouldWrite:false` must remain hardcoded fail-closed.
- Existing `operator-recovery` required contract blocker `operator-recovery-missing` must remain present; the new blocker `operator-recovery-real-implementation-missing` is additive only.

---

## 背景

V1.17 给 execution gate 增加了 `runnerWiringContract`，第五个 contract 是 `operator-recovery`。V1.22 的目标不是把该 contract 置 ready，而是新增一个 code-owned disabled operator recovery readiness，让后续真实 failure recovery、retry limit 和 operator runbook 有稳定数据结构和测试锚点。

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
- 不执行恢复、重试、通知、runbook、rollback 或 operator escalation。
- 不把任何 runner/execution gate 状态改为 ready。

## Task 1: Disabled Operator Recovery Readiness

**Files:**

- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

**Interfaces:**

- Consumes: `executionPreviewSafety()`, `buildSupervisorLifecycleGuardedRunnerWiringContract(executionPreview)`, `buildSupervisorLifecycleGuardedRunnerExecutionGate(...)`.
- Produces: `buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness()`, `runnerWiringContract.operatorRecoveryReadiness`, `gates.operatorRecoveryReady:false`.

- [ ] **Step 1: RED pure readiness test**

In `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`, import `buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness` and add an expected fixture:

```js
const EXPECTED_OPERATOR_RECOVERY_ENTRIES = Object.freeze([
  {
    recoveryKind: 'disabled-operator-recovery-stub',
    state: 'blocked',
    realImplementationReady: false,
    failureRecoveryReady: false,
    retryLimitReady: false,
    operatorRunbookReady: false,
    wouldRecover: false,
    wouldRetry: false,
    wouldNotifyOperator: false,
    wouldRun: false,
    wouldWrite: false,
    metadataWriteAllowed: false,
    filesystemWriteAllowed: false,
    remoteCommandAllowed: false,
    operatorNotificationAllowed: false,
    sensitiveValuesReturned: false,
    blockerCode: 'operator-recovery-real-implementation-missing',
  },
]);
```

Add a test that asserts:

```js
const readiness = buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness();
assert.strictEqual(readiness.command, 'supervisor-lifecycle-guarded-runner-operator-recovery-readiness');
assert.strictEqual(readiness.state, 'blocked');
assert.strictEqual(readiness.operatorRecoveryDefined, true);
assert.strictEqual(readiness.operatorRecoveryReady, false);
assert.strictEqual(readiness.realOperatorRecoveryReady, false);
assert.strictEqual(readiness.readyCount, 0);
assert.strictEqual(readiness.blockedCount, 1);
assert.ok(readiness.blockers.includes('operator-recovery-real-implementation-missing'));
assert.ok(readiness.blockers.includes('real-guarded-runner-execution-wiring-missing'));
assert.deepStrictEqual(readiness.nextBlockers, ['operator-recovery-real-implementation-missing']);
assert.deepStrictEqual(readiness.recoveryEntries, EXPECTED_OPERATOR_RECOVERY_ENTRIES);
assert.deepStrictEqual(readiness.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
```

Run: `node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

Expected: FAIL because the function/export does not exist yet.

- [ ] **Step 2: GREEN lifecycle implementation**

In `src/supervisor-lifecycle.js`:

```js
const OPERATOR_RECOVERY_REAL_IMPLEMENTATION_MISSING = 'operator-recovery-real-implementation-missing';
const DISABLED_OPERATOR_RECOVERY_KIND = 'disabled-operator-recovery-stub';
const GUARDED_RUNNER_DISABLED_OPERATOR_RECOVERY_ENTRY = Object.freeze({
  recoveryKind: DISABLED_OPERATOR_RECOVERY_KIND,
  state: 'blocked',
  realImplementationReady: false,
  failureRecoveryReady: false,
  retryLimitReady: false,
  operatorRunbookReady: false,
  wouldRecover: false,
  wouldRetry: false,
  wouldNotifyOperator: false,
  wouldRun: false,
  wouldWrite: false,
  metadataWriteAllowed: false,
  filesystemWriteAllowed: false,
  remoteCommandAllowed: false,
  operatorNotificationAllowed: false,
  sensitiveValuesReturned: false,
  blockerCode: OPERATOR_RECOVERY_REAL_IMPLEMENTATION_MISSING,
});
```

Add:

```js
export function buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness() {
  return {
    command: 'supervisor-lifecycle-guarded-runner-operator-recovery-readiness',
    state: 'blocked',
    operatorRecoveryDefined: true,
    operatorRecoveryReady: false,
    realOperatorRecoveryReady: false,
    readyCount: 0,
    blockedCount: 1,
    recoveryEntries: [{ ...GUARDED_RUNNER_DISABLED_OPERATOR_RECOVERY_ENTRY }],
    blockers: [
      OPERATOR_RECOVERY_REAL_IMPLEMENTATION_MISSING,
      REAL_GUARDED_RUNNER_EXECUTION_WIRING_MISSING,
    ],
    nextBlockers: [OPERATOR_RECOVERY_REAL_IMPLEMENTATION_MISSING],
    safety: executionPreviewSafety(),
  };
}
```

Update `buildSupervisorLifecycleGuardedRunnerWiringContract(...)` to include:

```js
operatorRecoveryReadiness: buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness(),
```

Before expecting this task test to pass, update the wiring contract test fixture/helper in the same step:

```js
assert.strictEqual(contract.requiredContracts.length, 5);
assert.deepStrictEqual(
  contract.operatorRecoveryReadiness,
  buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness(),
);
```

If the local test file uses a full expected contract fixture, add `operatorRecoveryReadiness` to that fixture in this same step. Do not leave fixture synchronization for a later step after adding the new field to the production contract shape.

Update execution gate `gates` to include:

```js
operatorRecoveryReady: false,
```

Run: `node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

Expected: PASS.

- [ ] **Step 3: Contract and malicious input tests**

Update `assertBlockedWiringContract(contract)` to assert:

```js
assert.strictEqual(contract.requiredContracts.length, 5);
assert.deepStrictEqual(
  contract.operatorRecoveryReadiness,
  buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness(),
);
```

Update `assertAlwaysBlockedGate(result)` to assert:

```js
assert.strictEqual(result.gates.operatorRecoveryReady, false);
```

Add a malicious input test that asserts the helper has a zero-argument signature, ignores any runtime-looking object passed by JavaScript callers, and serializes only the fixed fixture:

```js
assert.strictEqual(buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness.length, 0);
assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness(maliciousInput), baseline);
assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness(null), baseline);
assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness(), baseline);
assert.doesNotMatch(
  JSON.stringify(baseline),
  /\/Users\/ah|localhost|SECRET_XYZ|\btoken\b|\bsecret\b|Authorization|operator@example|do not leak|sha256:|launchctl \/|launchctl load|node |curl/i,
);
```

Run: `node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

Expected: PASS.

## Task 2: API/CLI/Web Passthrough And Rendering

**Files:**

- Modify: `src/web/app.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js`
- Modify: `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js`
- Modify: `test/web-console.test.js`

**Interfaces:**

- Consumes: `runnerWiringContract.operatorRecoveryReadiness.recoveryEntries`.
- Produces: fixed Web display line `operatorRecovery:disabled-operator-recovery-stub:state:blocked:realImplementationReady:false:wouldRecover:false:blocker:operator-recovery-real-implementation-missing`.

- [ ] **Step 1: API/CLI assertions**

Update gate API and Agent CLI tests to assert:

```js
assert.strictEqual(body.runnerWiringContract.operatorRecoveryReadiness.state, 'blocked');
assert.strictEqual(body.runnerWiringContract.operatorRecoveryReadiness.operatorRecoveryReady, false);
assert.strictEqual(body.runnerWiringContract.operatorRecoveryReadiness.recoveryEntries[0].wouldRecover, false);
assert.strictEqual(body.runnerWiringContract.operatorRecoveryReadiness.recoveryEntries[0].wouldRetry, false);
assert.strictEqual(body.runnerWiringContract.operatorRecoveryReadiness.recoveryEntries[0].wouldRun, false);
assert.strictEqual(body.runnerWiringContract.operatorRecoveryReadiness.recoveryEntries[0].wouldWrite, false);
assert.strictEqual(body.gates.operatorRecoveryReady, false);
```

Run:

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

Expected: PASS after Task 1.

- [ ] **Step 2: Web helper and rendering**

In `src/web/app.js`, add a helper beside the attempt audit helper:

```js
function buildSupervisorLifecycleGuardedRunnerOperatorRecoveryLines(runnerWiringContract) {
  const recoveryEntries = Array.isArray(runnerWiringContract?.operatorRecoveryReadiness?.recoveryEntries)
    ? runnerWiringContract.operatorRecoveryReadiness.recoveryEntries
    : [];
  if (recoveryEntries.length < 1) return [];
  return [
    'operatorRecovery:disabled-operator-recovery-stub:state:blocked:realImplementationReady:false:' +
      'wouldRecover:false:blocker:operator-recovery-real-implementation-missing',
  ];
}
```

Append these lines to the existing execution gate `requiredFields`, after attempt audit lines. Add `operatorRecoveryReady:false` to unknown/error/normal validation lines.

The invalid-payload branch, unknown/initial branch, and normal blocked branch must all contain:

```js
'operatorRecoveryReady:false',
```

This is required in each branch because `buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel(...)` has separate `validationLines` arrays for error, unknown, and normal results.

- [ ] **Step 3: Web malicious payload test**

Update `test/web-console.test.js` execution gate tests so the rendered details include:

```text
operatorRecovery:disabled-operator-recovery-stub:state:blocked:realImplementationReady:false:wouldRecover:false:blocker:operator-recovery-real-implementation-missing
operatorRecoveryReady:false
```

Add a malicious payload case:

```js
runnerWiringContract: {
  operatorRecoveryReadiness: {
    operatorRecoveryReady: true,
    recoveryEntries: [{
      recoveryKind: 'launchctl /Users/ah/.ssh/id_rsa token=SECRET_XYZ',
      wouldRecover: true,
      wouldRetry: true,
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
  'operatorRecovery:disabled-operator-recovery-stub:state:blocked:realImplementationReady:false:' +
    'wouldRecover:false:blocker:operator-recovery-real-implementation-missing',
));
assert.match(rendered, /operatorRecoveryReady:false/);
assert.ok(!rendered.includes('/Users/ah'), 'must not expose path in malicious payload');
assert.ok(!rendered.includes('SECRET_XYZ'), 'must not expose token in malicious payload');
assert.ok(!rendered.includes('launchctl'), 'must not expose launchctl in malicious payload');
assert.ok(!rendered.includes('token='), 'must not expose token assignment in malicious payload');
assert.ok(!rendered.includes('Authorization'), 'must not expose Authorization in malicious payload');
assert.ok(!rendered.includes('sha256:'), 'must not expose hash material in malicious payload');
assert.ok(!rendered.includes('operator@example'), 'must not expose operator identity in malicious payload');
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

- Consumes: V1.22 feature names and fixed line format.
- Produces: release docs/tests synced to `LINKE_RELEASE_VERSION === 'V1.22'`.

- [ ] **Step 1: Version tests and version constant**

Update `src/version.js`, `test/version.test.js`, and `test/gold-readiness.test.js` from `V1.21` to `V1.22`.

Run: `node --test --test-reporter=spec test/version.test.js test/gold-readiness.test.js`

Expected: FAIL until README/Gold evidence is updated.

- [ ] **Step 2: Gold readiness evidence**

In `src/gold-readiness.js`, add evidence strings:

```text
buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness
operatorRecoveryReadiness.state:blocked
operatorRecoveryReady:false
operator-recovery-real-implementation-missing
```

Update `automation-installation.nextStep` and the mirrored production hardening text so V1.22 is current and V1.21 remains historical. Gold must remain blocked.

- [ ] **Step 3: README and README tests**

Update README title, current badge, version table, Gold blockers, automation section, and hardening section to document:

```text
V1.22 disabled operator recovery readiness
buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness
operatorRecoveryReadiness.state:blocked
operatorRecoveryReady:false
operator-recovery-real-implementation-missing
operatorRecovery:disabled-operator-recovery-stub:state:blocked:realImplementationReady:false:wouldRecover:false:blocker:operator-recovery-real-implementation-missing
```

Update `test/readme.test.js` with V1.22 assertions and keep V1.21/V1.20/V1.19/V1.18/V1.17 historical assertions intact.

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

- 是否新增真实 execution/recovery surface。
- operator recovery readiness 是否仍全部 blocked。
- `operatorRecoveryReady:false` 是否全链路保持。
- `operator-recovery-missing` 是否仍保留在 required contract 中。
- 是否泄露敏感字段。
- Gold 是否仍 blocked。

DeepSeek 给出 ACCEPT/REJECT 后才能 commit/push。

## 验收标准

- V1.22 只新增 disabled operator recovery readiness evidence。
- 不减少 V1.17 wiring contract blocker。
- 不新增真实 runner execution、host mutation、rollback anchor writes、audit writes、operator recovery、retry 或 notification。
- 全量验证和双模型闭环通过。
