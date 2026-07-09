# V1.19 Supervisor Lifecycle Disabled Host Mutation Adapter Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add disabled host mutation adapter readiness evidence under the existing guarded runner wiring contract while keeping real lifecycle execution impossible.

**Architecture:** Extend the existing `runnerWiringContract` with one fixed, pure, blocked host mutation adapter readiness object. Reuse the current execution gate JSON, CLI/API passthrough, and Web result area; do not add any new execution surface.

**Tech Stack:** Node.js ESM, `node:test`, existing Linke pure supervisor lifecycle helpers and Web view model helpers.

## Global Constraints

- Current release must become `V1.19`.
- Gold readiness must remain `blocked`.
- `src/agent.js` must not be modified.
- No new endpoint, CLI command, Web button, request-body field, real registry lookup, runner dispatch, host mutation adapter implementation, launchctl/shell/process/filesystem/NAS/backup/restore/remote-command behavior.
- `runnerWiringContractReady:false`, `runnerRegistryReady:false`, `hostMutationAdapterReady:false`, `realRunnerWiringReady:false`, `executionEligible:false`, `executorReady:false`, `wouldExecute:false`, `wouldRun:false`, and `wouldWrite:false` must remain hardcoded fail-closed.
- Existing `host-mutation-adapter` required contract blocker `host-mutation-adapter-missing` must remain present; the new blocker `host-mutation-adapter-real-implementation-missing` is additive only.

---

## 背景

V1.17 给 execution gate 增加了 `runnerWiringContract`，其中第二个 contract 是 `host-mutation-adapter`。V1.19 的目标不是把该 contract 置 ready，而是新增一个 code-owned disabled host mutation adapter readiness，让后续真实 restricted host mutation adapter implementation 有稳定数据结构和测试锚点。

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
- 不把任何 runner/execution gate 状态改为 ready。

## Task 1: Disabled Host Mutation Adapter Readiness

**Files:**

- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

**Interfaces:**

- Consumes: `executionPreviewSafety()`, `buildSupervisorLifecycleGuardedRunnerWiringContract(executionPreview)`, `buildSupervisorLifecycleGuardedRunnerExecutionGate(...)`.
- Produces: `buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness()`, `runnerWiringContract.hostMutationAdapterReadiness`, `gates.hostMutationAdapterReady:false`.

- [ ] **Step 1: RED pure readiness test**

In `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`, import `buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness` and add an expected fixture:

```js
const EXPECTED_HOST_MUTATION_ADAPTER_ENTRIES = Object.freeze([
  {
    adapterKind: 'disabled-host-mutation-adapter-stub',
    state: 'blocked',
    realImplementationReady: false,
    wouldMutateHost: false,
    wouldRun: false,
    wouldWrite: false,
    launchctlAllowed: false,
    filesystemWriteAllowed: false,
    processListReadAllowed: false,
    metadataWriteAllowed: false,
    auditWriteAllowed: false,
    rollbackAnchorWriteAllowed: false,
    blockerCode: 'host-mutation-adapter-real-implementation-missing',
  },
]);
```

Add a test that asserts:

```js
const readiness = buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness();
assert.strictEqual(readiness.command, 'supervisor-lifecycle-guarded-runner-host-mutation-adapter-readiness');
assert.strictEqual(readiness.state, 'blocked');
assert.strictEqual(readiness.hostMutationAdapterDefined, true);
assert.strictEqual(readiness.hostMutationAdapterReady, false);
assert.strictEqual(readiness.realHostMutationAdapterReady, false);
assert.strictEqual(readiness.readyCount, 0);
assert.strictEqual(readiness.blockedCount, 1);
assert.ok(readiness.blockers.includes('host-mutation-adapter-real-implementation-missing'));
assert.ok(readiness.blockers.includes('real-guarded-runner-execution-wiring-missing'));
assert.deepStrictEqual(readiness.nextBlockers, ['host-mutation-adapter-real-implementation-missing']);
assert.deepStrictEqual(readiness.adapterEntries, EXPECTED_HOST_MUTATION_ADAPTER_ENTRIES);
assert.deepStrictEqual(readiness.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
```

Run: `node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

Expected: FAIL because the function/export does not exist yet.

- [ ] **Step 2: GREEN lifecycle implementation**

In `src/supervisor-lifecycle.js`:

```js
const HOST_MUTATION_ADAPTER_REAL_IMPLEMENTATION_MISSING = 'host-mutation-adapter-real-implementation-missing';
const DISABLED_HOST_MUTATION_ADAPTER_KIND = 'disabled-host-mutation-adapter-stub';
const GUARDED_RUNNER_DISABLED_HOST_MUTATION_ADAPTER_ENTRY = Object.freeze({
  adapterKind: DISABLED_HOST_MUTATION_ADAPTER_KIND,
  state: 'blocked',
  realImplementationReady: false,
  wouldMutateHost: false,
  wouldRun: false,
  wouldWrite: false,
  launchctlAllowed: false,
  filesystemWriteAllowed: false,
  processListReadAllowed: false,
  metadataWriteAllowed: false,
  auditWriteAllowed: false,
  rollbackAnchorWriteAllowed: false,
  blockerCode: HOST_MUTATION_ADAPTER_REAL_IMPLEMENTATION_MISSING,
});
```

Add:

```js
export function buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness() {
  return {
    command: 'supervisor-lifecycle-guarded-runner-host-mutation-adapter-readiness',
    state: 'blocked',
    hostMutationAdapterDefined: true,
    hostMutationAdapterReady: false,
    realHostMutationAdapterReady: false,
    readyCount: 0,
    blockedCount: 1,
    adapterEntries: [{ ...GUARDED_RUNNER_DISABLED_HOST_MUTATION_ADAPTER_ENTRY }],
    blockers: [
      HOST_MUTATION_ADAPTER_REAL_IMPLEMENTATION_MISSING,
      REAL_GUARDED_RUNNER_EXECUTION_WIRING_MISSING,
    ],
    nextBlockers: [HOST_MUTATION_ADAPTER_REAL_IMPLEMENTATION_MISSING],
    safety: executionPreviewSafety(),
  };
}
```

Update `buildSupervisorLifecycleGuardedRunnerWiringContract(...)` to include:

```js
hostMutationAdapterReadiness: buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness(),
```

Update execution gate `gates` to include:

```js
hostMutationAdapterReady: false,
```

Run: `node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

Expected: PASS.

- [ ] **Step 3: Contract and malicious input tests**

Update `assertBlockedWiringContract(contract)` to assert:

```js
assert.deepStrictEqual(
  contract.hostMutationAdapterReadiness,
  buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness(),
);
```

Update `assertAlwaysBlockedGate(result)` to assert:

```js
assert.strictEqual(result.gates.hostMutationAdapterReady, false);
```

Add a malicious input test that passes a runtime-looking object to `buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness(...)` and asserts the fixed fixture is still returned and serialized output does not contain `/Users/ah`, `localhost`, `token`, `secret`, `launchctl`, `curl`, `Authorization`, or `sha256:`.

Run: `node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

Expected: PASS.

## Task 2: API/CLI/Web Passthrough And Rendering

**Files:**

- Modify: `src/web/app.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js`
- Modify: `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js`
- Modify: `test/web-console.test.js`

**Interfaces:**

- Consumes: `runnerWiringContract.hostMutationAdapterReadiness.adapterEntries`.
- Produces: fixed Web display line `hostMutationAdapter:disabled-host-mutation-adapter-stub:state:blocked:realImplementationReady:false:wouldMutateHost:false:blocker:host-mutation-adapter-real-implementation-missing`.

- [ ] **Step 1: API/CLI assertions**

Update gate API and Agent CLI tests to assert:

```js
assert.strictEqual(body.runnerWiringContract.hostMutationAdapterReadiness.state, 'blocked');
assert.strictEqual(body.runnerWiringContract.hostMutationAdapterReadiness.hostMutationAdapterReady, false);
assert.strictEqual(body.runnerWiringContract.hostMutationAdapterReadiness.adapterEntries[0].wouldMutateHost, false);
assert.strictEqual(body.runnerWiringContract.hostMutationAdapterReadiness.adapterEntries[0].wouldRun, false);
assert.strictEqual(body.runnerWiringContract.hostMutationAdapterReadiness.adapterEntries[0].wouldWrite, false);
assert.strictEqual(body.gates.hostMutationAdapterReady, false);
```

Run:

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

Expected: PASS after Task 1.

- [ ] **Step 2: Web helper and rendering**

In `src/web/app.js`, add a helper beside the registry helper:

```js
function buildSupervisorLifecycleGuardedRunnerHostMutationAdapterLines(runnerWiringContract) {
  const adapterEntries = Array.isArray(runnerWiringContract?.hostMutationAdapterReadiness?.adapterEntries)
    ? runnerWiringContract.hostMutationAdapterReadiness.adapterEntries
    : [];
  if (adapterEntries.length < 1) return [];
  return [
    'hostMutationAdapter:disabled-host-mutation-adapter-stub:state:blocked:realImplementationReady:false:' +
      'wouldMutateHost:false:blocker:host-mutation-adapter-real-implementation-missing',
  ];
}
```

Append these lines to the existing execution gate `requiredFields`, after registry lines. Add `hostMutationAdapterReady:false` to unknown/error/normal validation lines.

- [ ] **Step 3: Web malicious payload test**

Update `test/web-console.test.js` execution gate tests so the rendered details include:

```text
hostMutationAdapter:disabled-host-mutation-adapter-stub:state:blocked:realImplementationReady:false:wouldMutateHost:false:blocker:host-mutation-adapter-real-implementation-missing
hostMutationAdapterReady:false
```

Add a malicious payload case:

```js
runnerWiringContract: {
  hostMutationAdapterReadiness: {
    hostMutationAdapterReady: true,
    adapterEntries: [{
      adapterKind: 'launchctl /Users/ah/.ssh/id_rsa token=SECRET_XYZ',
      wouldMutateHost: true,
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
  'hostMutationAdapter:disabled-host-mutation-adapter-stub:state:blocked:realImplementationReady:false:' +
    'wouldMutateHost:false:blocker:host-mutation-adapter-real-implementation-missing',
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

- Consumes: V1.19 feature names and fixed line format.
- Produces: release docs/tests synced to `LINKE_RELEASE_VERSION === 'V1.19'`.

- [ ] **Step 1: Version tests and version constant**

Update `src/version.js`, `test/version.test.js`, and `test/gold-readiness.test.js` from `V1.18` to `V1.19`.

Run: `node --test --test-reporter=spec test/version.test.js test/gold-readiness.test.js`

Expected: FAIL until README/Gold evidence is updated.

- [ ] **Step 2: Gold readiness evidence**

In `src/gold-readiness.js`, add evidence strings:

```text
buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness
hostMutationAdapterReadiness.state:blocked
hostMutationAdapterReady:false
host-mutation-adapter-real-implementation-missing
```

Update `automation-installation.nextStep` and the mirrored production hardening text so V1.19 is current and V1.18 remains historical. Gold must remain blocked.

- [ ] **Step 3: README and README tests**

Update README title, current badge, version table, Gold blockers, automation section, and hardening section to document:

```text
V1.19 disabled host mutation adapter readiness
buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness
hostMutationAdapterReadiness.state:blocked
hostMutationAdapterReady:false
host-mutation-adapter-real-implementation-missing
hostMutationAdapter:disabled-host-mutation-adapter-stub:state:blocked:realImplementationReady:false:wouldMutateHost:false:blocker:host-mutation-adapter-real-implementation-missing
```

Update `test/readme.test.js` with V1.19 assertions and keep V1.18/V1.17 historical assertions intact.

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
- host mutation adapter readiness 是否仍全部 blocked。
- `hostMutationAdapterReady:false` 是否全链路保持。
- `host-mutation-adapter-missing` 是否仍保留在 required contract 中。
- 是否泄露敏感字段。
- Gold 是否仍 blocked。

DeepSeek 给出 ACCEPT/REJECT 后才能 commit/push。

## 验收标准

- V1.19 只新增 disabled host mutation adapter readiness evidence。
- 不减少 V1.17 wiring contract blocker。
- 不新增真实 runner execution 或 host mutation。
- 全量验证和双模型闭环通过。
