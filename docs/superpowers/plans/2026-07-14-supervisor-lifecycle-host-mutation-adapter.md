# V1.26 Supervisor Lifecycle Host Mutation Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace V1.19 disabled host mutation adapter stub with a code-owned pure fail-closed **restricted** host-mutation-adapter resolver/readiness contract; mark `host-mutation-adapter` required contract ready; keep real host mutation execution and Gold blocked.

**Architecture:** Add `resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(candidates, operation)` as the only adapter resolve path. Convert readiness to fixed ready evidence (`codeOwnedAdapterResolverReady:true`, keep `realHostMutationImplementationReady:false`). Gate calls resolver only with production-derived sanitized `actionCandidates` + allowlisted `operation`, attaches sanitized `adapterDecision` (field `codeOwnedResolverWired:true`), derives local `hostMutationAdapterReady` into policy. Wiring → `readyCount:3` / `blockedCount:3`. Three downstream contracts remain blocked → policy denies with primary `rollback-anchor-not-ready`; side-effect flags stay false. Web uses **strict canonical fail-closed assembly**. Mapping/planner ready must never be treated as real host mutation implementation.

**Tech Stack:** Node.js ESM, `node:test`, existing Web Console view model helpers, README/Gold static scorecard tests.

**Spec:** `docs/superpowers/specs/2026-07-14-supervisor-lifecycle-host-mutation-adapter-design.md`

**Recovery anchor:** `22c33db`

## Global Constraints

- Current release version becomes `V1.26`.
- Do not add endpoint, CLI command, Web button, or request body field.
- Do not modify `src/agent.js`, `src/server.js`, or `package.json`.
- Do not accept request/CLI `adapterDecision` / `adapterContext` / `hostMutationAdapterReady` overrides.
- Do not call host shell / process-control / process list / filesystem / metadata / audit / approval writes / NAS / backup / restore / remote / network / launchctl.
- Do not schedule, dispatch, or invoke runners; do not return functions/commands/paths/hosts/tokens/hashes/raw errors.
- Do not set `realHostMutationImplementationReady:true`, `wouldMutateHost:true`, or any `*Allowed:true`.
- Production path: `policyDecision` always denied; `executionEligible:false`; Gold `blocked`.
- G0a real two-Mac PASS statements stay unchanged.
- Malicious fixtures use **opaque synthetic strings only** (`UNSAFE_SECRET_MATERIAL`, `OPAQUE_UNSAFE_FIELD`).
- Sensitive scans report **category hit counts only**.
- Do **not** change V1.24 `areSupervisorLifecycleGuardedRunnerActionCandidatesReady` maxAttempts contract.
- Do **not** change V1.25 registry resolver catalog / redacted maxAttempts contract.
- Blocker vocabulary **excludes** `host-mutation-adapter-operation-mismatch`, `host-mutation-adapter-action-extra`, `host-mutation-adapter-implementation-mismatch`, `host-mutation-adapter-mutation-kind-mismatch`.
- This planning phase must not modify `src/`, `test/`, `README.md`, `package*`, or version files; implementation phase follows this plan.
- Do **not** create `actual-changes.txt`. Do **not** use `git reset --hard` as a routine recovery step in this plan.

### 固定字段 vs 动态 fact（禁止混淆）

| 名称 | 类型 | V1.26 语义 |
| --- | --- | --- |
| `hostMutationAdapterReadiness.hostMutationAdapterReady` | **固定** readiness 输出 | 恒 `true`（builder 无参） |
| `gates.hostMutationAdapterReady` | **动态** gate fact | readiness ∧ adapterDecision 严格本地 boolean；合法 install fixtures → true；empty candidates → false |
| `adapterDecision.adapterReady` | **动态** decision 字段 | resolved 时 true；unresolved 时 false |
| `validationLines` 中的 `hostMutationAdapterReady` | **动态** Web 派生 | **仅** `canonicalHostMutationAdapterReady`；禁止直接抄 `gates.*` |
| `wouldMutateHost` / `*Allowed` / `realHostMutationImplementationReady` | **固定 false** | 任意 locus 恒 false |
| `executionEligible` / gate 顶层 `wouldExecute` | **固定 false** | 恒 false |

---

### Task 1: Pure Resolver + Ready Adapter Readiness Contract

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

**Interfaces:**
- `resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(candidates, operation): object`
- `buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness(): object` (ready)
- `runnerWiringContract.requiredContracts[2].status:'ready'`
- gate later wires `adapterDecision` + `gates.hostMutationAdapterReady`
- wiring `readyCount:3` / `blockedCount:3`

- [ ] **Step 1: Write the failing pure tests (RED)**

Update imports:

```js
import {
  // existing...
  resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter,
  buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness,
  resolveSupervisorLifecycleGuardedRunnerRegistry,
  buildSupervisorLifecycleGuardedRunnerRegistryReadiness,
  areSupervisorLifecycleGuardedRunnerActionCandidatesReady,
} from '../src/supervisor-lifecycle.js';
```

Fixtures:

```js
const EXPECTED_WIRING_CONTRACTS = Object.freeze([
  ['execution-policy', null, 'ready', 'execution-policy-ready'],
  ['runner-registry', null, 'ready', 'runner-registry-ready'],
  ['host-mutation-adapter', null, 'ready', 'host-mutation-adapter-ready'],
  ['rollback-anchor', 'rollback-anchor-missing', 'blocked', 'rollback-anchor-missing'],
  ['attempt-audit', 'attempt-audit-missing', 'blocked', 'attempt-audit-missing'],
  ['operator-recovery', 'operator-recovery-missing', 'blocked', 'operator-recovery-missing'],
]);

const EXPECTED_HOST_MUTATION_ADAPTER_ENTRIES = Object.freeze([
  {
    adapterKind: 'code-owned-host-mutation-adapter',
    state: 'ready',
    codeOwnedResolverWired: true,
    realHostMutationImplementationReady: false,
    realImplementationReady: false,
    wouldMutateHost: false,
    wouldExecute: false,
    wouldRun: false,
    wouldWrite: false,
    launchctlAllowed: false,
    filesystemWriteAllowed: false,
    processListReadAllowed: false,
    metadataWriteAllowed: false,
    auditWriteAllowed: false,
    rollbackAnchorWriteAllowed: false,
    blockerCode: null,
    evidenceCode: 'host-mutation-adapter-ready',
  },
]);

const CODE_OWNED_ACTION_MUTATION_MAP = Object.freeze({
  'render-launch-agent-plist': 'render-plist-mutation',
  'write-launch-agent-plist': 'write-plist-mutation',
  'load-launch-agent': 'load-agent-mutation',
  'unload-launch-agent': 'unload-agent-mutation',
  'remove-launch-agent-plist': 'remove-plist-mutation',
  'remove-supervisor-metadata': 'remove-metadata-mutation',
  'capture-current-state': 'capture-state-mutation',
  'restore-previous-plist': 'restore-plist-mutation',
  'restart-previous-supervisor': 'restart-supervisor-mutation',
  'start-recovery-supervisor': 'recovery-supervisor-mutation',
});

// Reuse V1.25 registry map for shared candidate fixtures:
const CODE_OWNED_REGISTRY_MAPPINGS = Object.freeze({
  'render-launch-agent-plist': 'render-plist-impl',
  'write-launch-agent-plist': 'write-plist-impl',
  'load-launch-agent': 'load-agent-impl',
  'unload-launch-agent': 'unload-agent-impl',
  'remove-launch-agent-plist': 'remove-plist-impl',
  'remove-supervisor-metadata': 'remove-metadata-impl',
  'capture-current-state': 'capture-state-impl',
  'restore-previous-plist': 'restore-plist-impl',
  'restart-previous-supervisor': 'restart-supervisor-impl',
  'start-recovery-supervisor': 'recovery-supervisor-impl',
});

const OPERATION_EXPECTED_ACTION_IDS = Object.freeze({
  install: Object.freeze([
    'render-launch-agent-plist',
    'write-launch-agent-plist',
    'load-launch-agent',
  ]),
  uninstall: Object.freeze([
    'unload-launch-agent',
    'remove-launch-agent-plist',
    'remove-supervisor-metadata',
  ]),
  rollback: Object.freeze([
    'capture-current-state',
    'restore-previous-plist',
    'restart-previous-supervisor',
  ]),
  recover: Object.freeze(['start-recovery-supervisor']),
});
```

Helpers（**必须**定义并使用；禁止 “类似 assertUnresolvedExact” 的模糊引用）：

```js
function validAdapterCandidate(actionId, maxAttempts = 1) {
  return {
    actionId,
    implementationId: CODE_OWNED_REGISTRY_MAPPINGS[actionId],
    runnerKind: 'guarded-runner-stub',
    mode: 'guarded-host-action',
    status: 'blocked',
    wouldExecute: false,
    wouldRun: false,
    wouldWrite: false,
    maxAttempts,
  };
}

function validAdapterCandidatesFor(operation) {
  return OPERATION_EXPECTED_ACTION_IDS[operation].map((id) => validAdapterCandidate(id, 1));
}

/**
 * assertAdapterUnresolvedExact：第三参 operation **必传**，禁止默认 `'unknown'`。
 * - typeof operation === 'string' 且 decision.operation === operation（严格全等）
 * - 合法 install/uninstall/rollback/recover 输入上的 **任意** unresolved：第三参传对应合法 operation
 * - **仅** invalid operation（H17：非 allowlisted string + 非 string 含 undefined/null/number/boolean）传 expected output `'unknown'`
 */
function assertAdapterUnresolvedExact(decision, primaryBlocker, operation) {
  assert.strictEqual(typeof operation, 'string');
  assert.strictEqual(typeof primaryBlocker, 'string');
  assert.strictEqual(decision.command, 'supervisor-lifecycle-guarded-runner-host-mutation-adapter');
  assert.strictEqual(decision.operation, operation);
  assert.strictEqual(decision.state, 'unresolved');
  assert.strictEqual(decision.adapterReady, false);
  assert.strictEqual(decision.codeOwnedResolverWired, true);
  assert.strictEqual(decision.realHostMutationImplementationReady, false);
  assert.strictEqual(decision.wouldMutateHost, false);
  assert.strictEqual(decision.wouldExecute, false);
  assert.strictEqual(decision.wouldRun, false);
  assert.strictEqual(decision.wouldWrite, false);
  assert.strictEqual(decision.launchctlAllowed, false);
  assert.strictEqual(decision.filesystemWriteAllowed, false);
  assert.strictEqual(decision.processListReadAllowed, false);
  assert.strictEqual(decision.metadataWriteAllowed, false);
  assert.strictEqual(decision.auditWriteAllowed, false);
  assert.strictEqual(decision.rollbackAnchorWriteAllowed, false);
  assert.strictEqual(decision.sensitiveValuesReturned, false);
  assert.strictEqual(decision.resolvedCount, 0);
  assert.strictEqual(decision.unresolvedCount, 0);
  assert.deepStrictEqual(decision.mutations, []);
  assert.deepStrictEqual(decision.blockers, [primaryBlocker]);
  assert.strictEqual(decision.primaryBlocker, primaryBlocker);
  assert.deepStrictEqual(decision.nextBlockers, [primaryBlocker]);
  assert.deepStrictEqual(decision.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  assert.ok(!Object.values(decision).some((v) => typeof v === 'function'));
}

/**
 * assertAdapterResolved：与 design §1.5 mutations 行 schema 全字段一致。
 * - 第二参 operation 决定 expected action 序
 * - mutation row **不含** codeOwnedResolverWired
 */
function assertAdapterResolved(decision, operation) {
  const expected = OPERATION_EXPECTED_ACTION_IDS[operation];
  assert.strictEqual(decision.command, 'supervisor-lifecycle-guarded-runner-host-mutation-adapter');
  assert.strictEqual(decision.operation, operation);
  assert.strictEqual(decision.state, 'resolved');
  assert.strictEqual(decision.adapterReady, true);
  assert.strictEqual(decision.codeOwnedResolverWired, true);
  assert.strictEqual(decision.realHostMutationImplementationReady, false);
  assert.strictEqual(decision.wouldMutateHost, false);
  assert.strictEqual(decision.wouldExecute, false);
  assert.strictEqual(decision.wouldRun, false);
  assert.strictEqual(decision.wouldWrite, false);
  assert.strictEqual(decision.launchctlAllowed, false);
  assert.strictEqual(decision.filesystemWriteAllowed, false);
  assert.strictEqual(decision.processListReadAllowed, false);
  assert.strictEqual(decision.metadataWriteAllowed, false);
  assert.strictEqual(decision.auditWriteAllowed, false);
  assert.strictEqual(decision.rollbackAnchorWriteAllowed, false);
  assert.strictEqual(decision.sensitiveValuesReturned, false);
  assert.strictEqual(decision.resolvedCount, expected.length);
  assert.strictEqual(decision.unresolvedCount, 0);
  assert.strictEqual(decision.mutations.length, expected.length);
  assert.deepStrictEqual(decision.blockers, []);
  assert.strictEqual(decision.primaryBlocker, null);
  assert.deepStrictEqual(decision.nextBlockers, []);
  assert.deepStrictEqual(decision.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  for (let i = 0; i < expected.length; i++) {
    const actionId = expected[i];
    const row = decision.mutations[i];
    assert.strictEqual(row.actionId, actionId);
    assert.strictEqual(row.mutationKind, CODE_OWNED_ACTION_MUTATION_MAP[actionId]);
    assert.strictEqual(row.mutationReady, true);
    assert.strictEqual(row.realHostMutationImplementationReady, false);
    assert.strictEqual(row.wouldMutateHost, false);
    assert.strictEqual(row.wouldExecute, false);
    assert.strictEqual(row.wouldRun, false);
    assert.strictEqual(row.wouldWrite, false);
    assert.strictEqual(row.launchctlAllowed, false);
    assert.strictEqual(row.filesystemWriteAllowed, false);
    assert.strictEqual(row.processListReadAllowed, false);
    assert.strictEqual(row.metadataWriteAllowed, false);
    assert.strictEqual(row.auditWriteAllowed, false);
    assert.strictEqual(row.rollbackAnchorWriteAllowed, false);
    assert.strictEqual(row.blockerCode, null);
    assert.strictEqual(row.evidenceCode, 'host-mutation-adapter-mutation-ready');
    assert.strictEqual(Object.hasOwn(row, 'codeOwnedResolverWired'), false);
  }
}
```

#### Exact test matrix — pure resolver（每个失败类 **单一 exact** primaryBlocker）

**分类不变量（与 design §1.2 / §1.6 一致）：**

- **candidates-invalid 仅限**：非 array、empty、容器/元素 shape/exact-key/accessor/trap/type-confusion、**snapshot 后 actionId 非非空 string**
- **集合偏差**：固定 **duplicate → unknown → missing**
- **`|A| !== |E|` 本身绝不能**直接变 `candidates-invalid`
- **unsafe-mutation**：集合 exact match 后 `status !== 'blocked'` 或任一 would* !== false
- **resolved 成功**才要求集合/长度 exact match（H1–H4）

| ID | Case | Input（可构造） | Expected primaryBlocker / state | `assertAdapterUnresolvedExact` 第三参 / `decision.operation` |
| --- | --- | --- | --- | --- |
| H1 | install happy | `validAdapterCandidatesFor('install')` | resolved；mutations 3；wouldMutateHost false；全部 *Allowed false；`codeOwnedResolverWired:true` | n/a（`assertAdapterResolved`；`operation:'install'`） |
| H2 | uninstall happy | `validAdapterCandidatesFor('uninstall')` | resolved；mutations 3 | n/a（`assertAdapterResolved`；`operation:'uninstall'`） |
| H3 | rollback happy | `validAdapterCandidatesFor('rollback')` | resolved；mutations 3 | n/a（`assertAdapterResolved`；`operation:'rollback'`） |
| H4 | recover happy | `validAdapterCandidatesFor('recover')` | resolved；mutations 1；mutationKind=`recovery-supervisor-mutation` | n/a（`assertAdapterResolved`；`operation:'recover'`） |
| H5 | unknown action | install 中用 `start-recovery-supervisor` 替换 `load-launch-agent`（3 行、无重复） | `host-mutation-adapter-action-unknown` | `'install'` |
| H6 | missing action `len<\|E\|` | install 仅前 2 行合法 shape | `host-mutation-adapter-action-missing` | `'install'` |
| H7 | duplicate action | 两行同为 `render-launch-agent-plist`（凑满 3 行） | `host-mutation-adapter-action-duplicate` | `'install'` |
| H8 | non-catalog implementationId | install 合法 set，首行 `implementationId:'other-plist-impl'` | **resolved**（adapter 忽略 implementationId） | n/a（`assertAdapterResolved`） |
| H9 | redacted maxAttempts | install 合法 set，`maxAttempts:'[redacted]'` | **resolved**（adapter 忽略 maxAttempts） | n/a（`assertAdapterResolved`） |
| H10 | wouldExecute true | install 合法 set，首行 `wouldExecute:true` | `host-mutation-adapter-unsafe-mutation` | `'install'` |
| H11 | wouldRun true | install 合法 set，首行 `wouldRun:true` | `host-mutation-adapter-unsafe-mutation` | `'install'` |
| H12 | wouldWrite true | install 合法 set，首行 `wouldWrite:true` | `host-mutation-adapter-unsafe-mutation` | `'install'` |
| H13 | status not blocked | install 合法 set，首行 `status:'ready'` | `host-mutation-adapter-unsafe-mutation` | `'install'` |
| H14 | non-array candidates | `null` | `host-mutation-adapter-candidates-invalid` | `'install'` |
| H15 | empty candidates | `[]` | `host-mutation-adapter-candidates-invalid` | `'install'` |
| H16 | missing exact key | 去掉 `mode` 键 | `host-mutation-adapter-candidates-invalid` | `'install'` |
| H17 | invalid operation | 分独立 `it`：`operation:'nope'`（非 allowlisted string）；`undefined`；`null`；`0` / `1`（number）；`false` / `true`（boolean） | `host-mutation-adapter-operation-invalid`；`decision.operation==='unknown'` | `'unknown'` |
| H18 | getter trap on element | own getter for `actionId` | `host-mutation-adapter-candidates-invalid` | `'install'` |
| H19 | Proxy element trap | Proxy throws on getOwnPropertyDescriptor | `host-mutation-adapter-candidates-invalid` | `'install'` |
| H20 | deep-copy isolation | resolve → mutate input → decision 不变；mutate decision → 下次 resolve 不受影响 | resolved 两次独立 | n/a |
| H21 | extra key | 元素多 `mutationKind` 键 | `host-mutation-adapter-candidates-invalid` | `'install'` |
| H22 | actionId empty / number | 首行 `actionId:''`；另 it `actionId:1` | `host-mutation-adapter-candidates-invalid` | `'install'` |
| H23 | `len>\|E\|` 外来 id | install 3 合法 + 追加 `start-recovery-supervisor` | `host-mutation-adapter-action-unknown` | `'install'` |
| H24 | `len>\|E\|` 重复 id | install 3 合法 + 追加重复 `render-launch-agent-plist` | `host-mutation-adapter-action-duplicate` | `'install'` |

每个 case 写成独立 `it(...)`。H1–H4 / H8 / H9 调用 `assertAdapterResolved`；失败类调用 `assertAdapterUnresolvedExact`。

#### Exact test matrix — readiness (RED)

```js
it('buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness returns fixed ready contract', () => {
  const readiness = buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness();
  assert.strictEqual(readiness.command, 'supervisor-lifecycle-guarded-runner-host-mutation-adapter-readiness');
  assert.strictEqual(readiness.state, 'ready');
  assert.strictEqual(readiness.hostMutationAdapterDefined, true);
  assert.strictEqual(readiness.hostMutationAdapterReady, true);
  assert.strictEqual(readiness.codeOwnedAdapterResolverReady, true);
  assert.strictEqual(readiness.realHostMutationImplementationReady, false);
  assert.strictEqual(readiness.readyCount, 1);
  assert.strictEqual(readiness.blockedCount, 0);
  assert.deepStrictEqual(readiness.adapterEntries, EXPECTED_HOST_MUTATION_ADAPTER_ENTRIES);
  assert.deepStrictEqual(readiness.blockers, []);
  assert.deepStrictEqual(readiness.nextBlockers, []);
  assert.deepStrictEqual(readiness.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
});
```

#### Wiring contract — 迁移现有 `assertWiringContract` helper 本体（RED；禁止只改 fixture）

`assertWiringContract` 必须断言：

- `readyCount === 3`
- `blockedCount === 3`
- `requiredContracts` map exact `EXPECTED_WIRING_CONTRACTS`（6 项）
- `requiredContracts[2]`：`id:'host-mutation-adapter'`、`status:'ready'`、`blockerCode:null`、`evidenceCode:'host-mutation-adapter-ready'`
- **`requiredContracts.slice(3)`** 后三全 `status:'blocked'`（**禁止** `slice(2)`）
- `hostMutationAdapterReadiness`：ready schema + `EXPECTED_HOST_MUTATION_ADAPTER_ENTRIES`
- `runnerRegistryReadiness` 仍 ready（V1.25）
- wiring aggregate `state:'blocked'`、`realRunnerWiringReady:false`、blockers 含 `real-guarded-runner-execution-wiring-missing`

**同步：** `EXPECTED_WIRING_CONTRACTS[2]` 必须为 `['host-mutation-adapter', null, 'ready', 'host-mutation-adapter-ready']`。fixture + helper 本体 **两者都改**。

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

Expected: **RED**（fixture/helper 已写 V1.26 期望，实现未就绪）。

- [ ] **Step 2: Implement pure resolver + readiness + wiring (GREEN)**

In `src/supervisor-lifecycle.js`：

1. 常量：
   - `CODE_OWNED_HOST_MUTATION_ADAPTER_KIND = 'code-owned-host-mutation-adapter'`
   - `HOST_MUTATION_ADAPTER_READY_EVIDENCE = 'host-mutation-adapter-ready'`
   - `HOST_MUTATION_ADAPTER_MUTATION_READY_EVIDENCE = 'host-mutation-adapter-mutation-ready'`
   - `CODE_OWNED_ACTION_MUTATION_MAP`（10 项）
   - `HOST_MUTATION_ADAPTER_BLOCKER_CODES` + Set
   - `GUARDED_RUNNER_READY_HOST_MUTATION_ADAPTER_ENTRY`（替换 disabled entry 用途）
2. `buildUnresolvedAdapterDecision` / `buildResolvedAdapterDecision` / `sanitizeHostMutationAdapterDecision`
3. export `resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter`（§1 评估顺序）
4. 改 `buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness` → ready schema
5. **字段重命名（显式、不可漏）**：将现有 readiness 字段 `realHostMutationAdapterReady` **重命名**为 `realHostMutationImplementationReady`（V1.26 语义：无真实 host mutation；值仍恒 `false`）。decision / entry / mutation 行同步使用同名新键。**同步测试**：凡断言旧键 `realHostMutationAdapterReady` 的 pure / gate / API / CLI / Web 用例一律改为新键；源码与测试中旧键名不得残留。
6. 改 `GUARDED_RUNNER_WIRING_CONTRACTS[2]` → ready
7. 改 `buildSupervisorLifecycleGuardedRunnerWiringContract`：`readyCount:3`、`blockedCount:3`、hostMutationAdapterReadiness ready

**禁止**在 resolver 内 import/call `child_process` / `fs` / `net` / `http` / launchctl 字符串执行。

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

Expected: pure + readiness + wiring **GREEN**；gate integration 可能仍 RED until Task 2.

---

### Task 2: Execution Gate Production Wiring

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

- [ ] **Step 1: Write failing gate tests (RED)**

#### `assertAlwaysBlockedGate` 动态语义（**禁止**恒 `hostMutationAdapterReady:false` / 恒 `true`）

签名改为（两 fact **均必传**，禁止默认值掩盖漏传）：

```js
function assertAlwaysBlockedGate(result, {
  runnerRegistryReady,
  hostMutationAdapterReady,
}) {
  assert.strictEqual(typeof runnerRegistryReady, 'boolean');
  assert.strictEqual(typeof hostMutationAdapterReady, 'boolean');
  // ...existing blocked gate invariants...
  assert.strictEqual(result.executionEligible, false);
  assert.strictEqual(result.executorReady, false);
  assert.strictEqual(result.wouldExecute, false);
  // 禁止 assert result.wouldRun / result.wouldWrite / result.wouldMutateHost（gate 顶层不存在）
  assert.strictEqual(result.gates.runnerRegistryReady, runnerRegistryReady);
  assert.strictEqual(result.gates.hostMutationAdapterReady, hostMutationAdapterReady);
  assert.strictEqual(result.gates.rollbackAnchorReady, false);
  assert.strictEqual(result.gates.attemptAuditReady, false);
  assert.strictEqual(result.gates.operatorRecoveryReady, false);
  assert.strictEqual(result.runnerWiringContract.readyCount, 3);
  assert.strictEqual(result.runnerWiringContract.blockedCount, 3);
  // hostMutationAdapterReadiness ready schema + entry
  // adapterDecision present; wouldMutateHost/*Allowed false
  // policyDecision.state === 'denied'; wouldRun/wouldWrite false
}
```

**`assertAlwaysBlockedGate` 不得固定：**

- `adapterDecision.state` / `adapterDecision.adapterReady`
- `registryDecision.state`
- `policyDecision.primaryBlocker`

#### Gate matrix

| ID | Case | 构造 | runnerRegistryReady | hostMutationAdapterReady | policy primary（专属 it） |
| --- | --- | --- | --- | --- | --- |
| G1 | ready install + executeRequested | valid plan/preview/manifest/binding | true | true | `rollback-anchor-not-ready`；**不含** `host-mutation-adapter-not-ready` |
| G2 | ready install + executeRequested false | 同上 | true | true | 上游或 `rollback-anchor-not-ready`；adapter fact 仍 true |
| G3 | empty candidates（missing binding path） | 无 runnerBinding → empty candidates | false | false | 含 `host-mutation-adapter-not-ready` 与 `runner-registry-not-ready`（或更上游） |
| G4 | non-catalog implementationId production | binding/preview 使用合法 slug 但非 catalog impl | false | **true** | 含 `runner-registry-not-ready`；**不含** `host-mutation-adapter-not-ready` |
| G5 | redacted maxAttempts production | sanitize 后 maxAttempts redacted 的 production 构造 | false | **true** | 含 `runner-registry-not-ready` |
| G6 | adapterDecision 恒副作用 false | G1 路径 | true | true | `adapterDecision.wouldMutateHost===false`；全部 *Allowed false；`realHostMutationImplementationReady===false` |
| G7 | executionEligible 仍 false | G1 路径 | true | true | `executionEligible:false`；`wouldExecute:false` |
| G8 | ignore options override | `options: { hostMutationAdapterReady: true, adapterDecision: {...malicious} }` | 由 production 派生 | 由 production 派生 | 不得被 options 抬升 executionEligible |

G4/G5 **必须** production 可运行构造（pure H8/H9 **不能**替代）。

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

Expected: **RED** on gate assertions until wired.

- [ ] **Step 2: Wire gate (GREEN)**

In `buildSupervisorLifecycleGuardedRunnerExecutionGate`：

1. 在 registry resolve 之后调用：
   ```js
   const adapterDecision = sanitizeHostMutationAdapterDecision(
     resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter(actionCandidates, operation),
   );
   ```
2. 计算 `hostMutationAdapterReady` 本地 boolean（design §4.1 **完整** conjunction；禁止缩短遗漏 *Allowed 检查）
3. `policyContext.hostMutationAdapterReady = hostMutationAdapterReady === true`
4. `gates.hostMutationAdapterReady = hostMutationAdapterReady === true`
5. 返回体附加 `adapterDecision`
6. **忽略** `options.adapterDecision` / `options.hostMutationAdapterReady` / `options.adapterContext`
7. `executionEligible` / `wouldExecute` 保持 false；`rollbackAnchorReady` 等保持 false

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

Expected: **GREEN** pure + gate.

---

### Task 3: API / CLI Passthrough（共用 helper 参数化 + 全调用点矩阵）

**Files:**
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js`
- Modify: `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js`
- **Do not modify:** `src/agent.js`, `src/server.js`

- [ ] **Step 1: 改造两个共用 helper 本体 + fixture（RED 期望对齐 V1.26）**

两文件本地 fixture 与 Task 1 `EXPECTED_HOST_MUTATION_ADAPTER_ENTRIES` **exact 同形**。

##### API helper skeleton

```js
function assertBlockedExecutionGate(body, { runnerRegistryReady, hostMutationAdapterReady }) {
  assert.strictEqual(typeof runnerRegistryReady, 'boolean');
  assert.strictEqual(typeof hostMutationAdapterReady, 'boolean');
  assert.strictEqual(body.executionEligible, false);
  assert.strictEqual(body.wouldExecute, false);
  assert.strictEqual(body.gates.runnerRegistryReady, runnerRegistryReady);
  assert.strictEqual(body.gates.hostMutationAdapterReady, hostMutationAdapterReady);
  assert.strictEqual(body.runnerWiringContract.readyCount, 3);
  assert.strictEqual(body.runnerWiringContract.blockedCount, 3);
  // contract[2] ready host-mutation-adapter
  // slice(3) blocked
  // hostMutationAdapterReadiness ready + EXPECTED entry
  // runnerRegistryReadiness still ready
  // policyDecision.state denied; wouldRun/wouldWrite false
  // adapterDecision.wouldMutateHost false; *Allowed false（若 adapterDecision 存在）
}
```

##### CLI helper skeleton

同形，对 `report`（`JSON.parse(stdout)`）断言。

#### 语义调用矩阵 — API

| 调用点场景 | `runnerRegistryReady` | `hostMutationAdapterReady` |
| --- | --- | --- |
| valid manifest + valid binding（含 executeRequested true/false 变体） | `true` | `true` |
| missing runnerBinding | `false` | `false` |

#### 语义调用矩阵 — CLI

| 调用点场景 | `runnerRegistryReady` | `hostMutationAdapterReady` |
| --- | --- | --- |
| valid binding | `true` | `true` |
| missing binding（若现有 CLI 覆盖） | `false` | `false` |

#### 专属 `it`（**禁止**放进共用 helper）

| 场景 | 断言 |
| --- | --- |
| valid ready path | `policyDecision.primaryBlocker === 'rollback-anchor-not-ready'`；blockers 不含 `host-mutation-adapter-not-ready`；`adapterDecision.state==='resolved'`；`adapterDecision.adapterReady===true` |
| missing binding | `adapterDecision.state==='unresolved'`；`gates.hostMutationAdapterReady===false` |
| （可选）非 catalog 若 API 可构造 | registry false + adapter true |

- [ ] **Step 2: GREEN without server/agent source changes**

```bash
node --test --test-reporter=spec \
  test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js \
  test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

Expected: **GREEN**；helper 参数无默认漏传。

---

### Task 4: Web Strict Canonical Fail-Closed Assembly

**Files:**
- Modify: `src/web/app.js`
- Modify: `test/web-console.test.js`

- [ ] **Step 1: Write failing Web tests (RED)**

实现/断言以下矩阵（每个独立 `it`；**禁止** “W1 或 W2” 合并）：

| ID | Payload 构造 | wiring host-mutation-adapter 行 | hostMutationAdapter 行 | validation `hostMutationAdapterReady` |
| --- | --- | --- | --- | --- |
| W1 | 完整 canonical ready（C ready + A ready + G true + D resolved 全 false flags） | `status:ready...blocker:none` | `state:ready...wouldMutateHost:false:blocker:none` | `true` |
| W2 | 缺 `adapterDecision` | blocked + `host-mutation-adapter-missing` | blocked + `host-mutation-adapter-not-ready` | `false` |
| W3 | `gates.hostMutationAdapterReady:false` | blocked | blocked | `false` |
| W4 | readiness `state:'blocked'` | blocked | blocked | `false` |
| W5 | contract `status:'blocked'` | blocked | blocked | `false` |
| W6 | contract ready 但 `evidenceCode` 错误 | blocked | blocked | `false` |
| W7 | `D.wouldMutateHost:true`（其余表面 ready） | blocked | blocked | `false`；全文无 adapter ready 行 |
| W8 | `D.launchctlAllowed:true`（其余表面 ready） | blocked | blocked | `false` |
| W9 | 恶意 `adapterEntries[0].adapterKind=OPAQUE_UNSAFE_FIELD` + wouldMutateHost true | blocked fixed | blocked fixed（**不**回显 OPAQUE） | `false` |
| W10 | 注入 contract status ready + blocker null 但缺 D | blocked | blocked | `false` |
| W11 | C/A/G 表面 ready、D resolved 但 `D.wouldRun:true` | blocked | blocked | `false` |
| W12 | 后三 contract payload 声称 ready | 后三仍 fixed missing blocked | n/a | 后三 validation false |
| W13 | runner-registry 与 adapter 独立：registry canonical false、adapter canonical true | registry blocked；adapter ready | adapter ready | `hostMutationAdapterReady:true` 且 `runnerRegistryReady:false` |

W1 ready 行 **exact**：

```text
hostMutationAdapter:code-owned-host-mutation-adapter:state:ready:codeOwnedResolverWired:true:realHostMutationImplementationReady:false:wouldMutateHost:false:blocker:none
```

W1 wiring **exact**：

```text
wiringContract:host-mutation-adapter:status:ready:requiredForExecution:true:blocker:none
```

Blocked adapter 行 **exact**：

```text
hostMutationAdapter:code-owned-host-mutation-adapter:state:blocked:codeOwnedResolverWired:true:realHostMutationImplementationReady:false:wouldMutateHost:false:blocker:host-mutation-adapter-not-ready
```

- [ ] **Step 2: Implement Web assembly (GREEN)**

In `src/web/app.js`：

1. 从 `WIRING_CONTRACT_CANONICAL_MISSING_BLOCKERS` **删除** `host-mutation-adapter` 键。
2. 新增 `isCanonicalHostMutationAdapterReady` + `resolveCanonicalHostMutationAdapterReady`（design §5.2 **完整** conjunction）。
3. `buildSupervisorLifecycleGuardedRunnerWiringContractLines`：增加 `canonicalHostMutationAdapterReady` 参数（或从 payload 解析）；host-mutation-adapter 分支用该 boolean。
4. 改 `buildSupervisorLifecycleGuardedRunnerHostMutationAdapterLines`：接受 `canonicalHostMutationAdapterReady`；**不再**读 payload adapterKind 渲染；恒输出 fixed ready/blocked 单行。
5. `buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel`：
   - 计算 `canonicalHostMutationAdapterReady`
   - validationLines：`hostMutationAdapterReady:${canonical ? 'true' : 'false'}`
   - 传 boolean 给 wiring/adapter line builders
6. 保持 runner-registry 的 V1.25 C∧R∧G∧D 独立 predicate。
7. 后三仍 fixed blocked。

```bash
node --test --test-reporter=spec test/web-console.test.js
```

Expected: **GREEN**（或至少 gate 相关 describe 全绿；全文件绿为完成标准）。

---

### Task 5: Version / README / Gold / No-Side-Effect Assertions

**Files:**
- Modify: `src/version.js`
- Modify: `README.md`
- Modify: `src/gold-readiness.js`
- Modify: `test/version.test.js`
- Modify: `test/readme.test.js`
- Modify: `test/gold-readiness.test.js`

- [ ] **Step 1: RED version/readme/gold expectations**

- `LINKE_RELEASE_VERSION === 'V1.26'`
- README 标题 / badge / version table：V1.26 当前；V1.25 历史
- Gold evidence 含：
  - `resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter`
  - `hostMutationAdapterReadiness.state:ready`
  - `hostMutationAdapterReady:true`
  - `codeOwnedAdapterResolverReady:true`
  - `codeOwnedResolverWired`
  - `host-mutation-adapter-ready`
  - `realHostMutationImplementationReady:false`
  - `adapterDecision`
  - `readyCount:3` / `blockedCount:3`
- 当前缺口 **不再**以 `host-mutation-adapter-real-implementation-missing` / `host-mutation-adapter-missing` 作为 V1.26 主缺口（历史叙述可保留）
- `nextStep` 含 `rollback-anchor`，并声明真实 host mutation implementation 仍缺失
- Gold status 仍 `blocked`
- G0a PASS 叙述不变

- [ ] **Step 2: GREEN version/docs updates**

```bash
node --test --test-reporter=spec \
  test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

Expected: **GREEN**.

---

### Task 6: Full Verification + 无写入 Scope 核对

- [ ] **Step 1: Focused + full tests**

```bash
node --check src/supervisor-lifecycle.js
node --check src/web/app.js
git diff --check
node --test --test-reporter=spec \
  test/supervisor-lifecycle-guarded-runner-execution-gate.test.js \
  test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js \
  test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js \
  test/web-console.test.js
node --test --test-reporter=spec \
  test/version.test.js test/gold-readiness.test.js test/readme.test.js
npm test
```

- [ ] **Step 2: 无 side-effect 源码检查**

```bash
git diff 22c33db -- src/supervisor-lifecycle.js | rg -n \
  'launchctl|child_process|execSync|spawn\(|exec\(|fs\.(write|rm|unlink|mkdir)|process\.kill|net\.|http\.|https\.' \
  && echo 'FAIL: side-effect call pattern in lifecycle diff' || echo 'ok: no side-effect pattern in lifecycle diff'

# 敏感类别计数 only（有命中只报 count；禁止打印匹配原文）
git diff 22c33db -- src/ test/ | rg -c \
  'ssh-rsa|BEGIN (RSA |OPENSSH )?PRIVATE|AKIA[0-9A-Z]{16}|[0-9a-f]{64}' \
  || true
```

期望：side-effect pattern 无命中；敏感类别无命中。

- [ ] **Step 3: 无写入 anchor / allowlist 核对（禁止 actual-changes.txt；禁止 hard reset 步骤）**

```bash
# 1) 恢复锚点是当前 HEAD 祖先
git merge-base --is-ancestor 22c33db HEAD && echo anchor-ok

# 2) 列出相对锚点的变更文件，人工 ⊆ 允许列表
git diff --name-only 22c33db --
git status --short

# 3) 禁止文件必须无 diff
git diff --name-only 22c33db -- src/agent.js src/server.js package.json
# 期望：无输出
```

若允许列表外文件出现：停止；仅回退越界文件或（有 rg 证据时）更新设计允许列表。**不要** `git reset --hard`。

- [ ] **Step 4: Confirm invariants**

| Check | Expected |
| --- | --- |
| version | V1.26 |
| export resolve...HostMutationAdapter | present, pure |
| readiness | ready + `codeOwnedAdapterResolverReady:true` + `realHostMutationImplementationReady:false` |
| decision field | `codeOwnedResolverWired:true`；`adapterReady` dynamic |
| wouldMutateHost / *Allowed | 任意 locus 恒 false |
| wiring | 3 / 3 |
| production hostMutationAdapterReady | true on ready install |
| production runnerRegistryReady | true on ready install |
| G4/G5 layering | registry false + adapter true |
| production policy | denied, primary `rollback-anchor-not-ready` |
| side effects | false |
| agent/server/package | unmodified |
| Gold / G0a | blocked / PASS |
| blocker vocabulary | no operation-mismatch / action-extra / implementation-mismatch / mutation-kind-mismatch |

---

## TDD Order Summary

1. **RED** pure H1–H24 + readiness + wiring（含 H5/H6/H23/H24 集合类 ≠ candidates-invalid；H10–H13 unsafe；H8/H9 intentional resolve；`assertAdapterUnresolvedExact` 第三参必传；**迁移 `assertWiringContract` 本体** 3/3 + slice(3) + readiness ready）
2. **GREEN** resolver/readiness/wiring in `supervisor-lifecycle.js`
3. **RED** gate G1–G8 + 迁移 `assertAlwaysBlockedGate` 参数化（`runnerRegistryReady` + `hostMutationAdapterReady` 均必传）
4. **GREEN** gate integrate resolver + local boolean + `adapterDecision`
5. **RED→GREEN** API/CLI：改造共用 helper 必传两 fact + 全调用点矩阵；decision/primary 仅专属 it（不改 agent/server 源码）
6. **RED** Web W1–W13 共享单一 canonical predicate
7. **GREEN** Web assembly（wiring/adapter/validation 同源 boolean）
8. **RED→GREEN** version/README/Gold
9. **Verify** focused + `npm test` + side-effect scan + 无写入 merge-base/diff 允许列表

---

## Scope File List（rg 实证；实现阶段仅这些）

### Allowed

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

### Forbidden

- `src/agent.js`
- `src/server.js`
- `package.json` / lockfiles
- new endpoints / CLI commands / Web buttons / request body fields
- host mutation / runner dispatch / network / fs write / launchctl paths

全量 `npm test` 为兜底；间接失败时不得猜测扩 scope。

---

## Non-Goals

- 真实 host mutation execution（launchctl / shell / process list / fs / metadata / audit）
- 后三 wiring 真实实现（rollback-anchor / attempt-audit / operator-recovery）
- `executionEligible` 或 Gold ready
- `realHostMutationImplementationReady:true` / `wouldMutateHost:true` / 任一 `*Allowed:true`
- 修改 V1.24 actionCandidates helper 契约
- 修改 V1.25 registry resolver 契约
- 真实 recovery supervisor 执行
- 不可达 blocker 词汇（operation-mismatch / action-extra / implementation-mismatch / mutation-kind-mismatch）

---

## Completion Criteria

1. Pure matrix H1–H24 全绿；失败类单一 exact blocker；`|A|≠|E|` 不进 candidates-invalid；H6 missing / H23 unknown / H24 duplicate 锁定分类；H10–H13 unsafe；H8/H9 intentional resolve；`assertAdapterUnresolvedExact` 第三参必传（合法 operation 回显；**仅 H17**——含非 allowlisted string 与非 string `undefined`/`null`/number/boolean——expected `'unknown'`）；readiness 字段已从 `realHostMutationAdapterReady` 重命名为 `realHostMutationImplementationReady` 且测试已同步
2. Readiness ready + `realHostMutationImplementationReady:false` + `codeOwnedAdapterResolverReady:true`
3. Decision / entry 使用 `codeOwnedResolverWired`；mutation 行全字段含 wouldMutateHost false + 全部 *Allowed false
4. Wiring 3/3；host-mutation-adapter ready null-safe；**`assertWiringContract` helper 本体**断言 readyCount 3 / blockedCount 3 / map exact EXPECTED / contract[2] ready / **slice(3)** 后三 blocked / readiness ready schema
5. Gate 本地 boolean + sanitized `adapterDecision`；G4/G5 production layering；`assertAlwaysBlockedGate` 两 fact 参数化（非恒 true/false）
6. Policy 仍 deny；ready path primary=`rollback-anchor-not-ready`；各 locus 副作用 false；gate 顶层仅断言 `executionEligible`/`wouldExecute`
7. API/CLI/Web 通过；共用 helper 固定 wiring 3/3 + readiness ready + 参数化两 gate fact；Web 共享单一 C∧A∧G∧D predicate；W7/W8/W11 side-effect 漂移双行 blocked；ready 行含 realHostMutationImplementationReady:false + wouldMutateHost:false
8. Version V1.26；Gold blocked；G0a PASS；nextStep → rollback-anchor + 声明真实 host mutation 仍缺
9. `npm test` green；`git diff --check` clean；side-effect scan clean；merge-base 祖先 + name-only ⊆ 允许列表
10. agent/server/package 未修改

Do **not** commit or push unless the user explicitly requests it after review.
