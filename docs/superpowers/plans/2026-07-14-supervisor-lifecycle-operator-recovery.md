# V1.29 Supervisor Lifecycle Operator Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace V1.22 disabled operator recovery stub with a code-owned pure fail-closed **restricted pure data** operator-recovery resolver/readiness contract; mark final required contract `operator-recovery` ready; reach wiring **6/0**; keep real recovery side effects, real host mutation, real rollback write/restore, real attempt audit persist, **`runnerWiringContractReady`**, **`realRunnerWiringReady`**, **`executionEligible`**, and **Gold** blocked.

**Architecture:** Add `resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(candidates, operation)` as the only operator-recovery resolve path. Convert readiness to fixed ready evidence (`codeOwnedRecoveryResolverReady:true` = **product-level readiness**；keep `realOperatorRecoveryImplementationReady:false`). Gate calls resolver only with production-derived sanitized `actionCandidates` + allowlisted `operation`, attaches sanitized `recoveryDecision`（field `codeOwnedResolverWired:true` = **single-decision source-path identifier**，≠ readiness）, derives local `operatorRecoveryReady` into policy. Wiring → `readyCount:6` / `blockedCount:0`. When all `POLICY_FACT_KEYS` are true, policy evaluator **authorizes** (`primaryBlocker:null`) by existing V1.24 rules — **must not** keep `operator-recovery-not-ready` as primary. Side-effect flags stay false; gate/wiring still carry `real-guarded-runner-execution-wiring-missing`; `executionEligible`/`runnerWiringContractReady`/`realRunnerWiringReady` stay false. Web uses **strict canonical fail-closed assembly** (C∧A∧G∧D) plus **方案 A 双 locus**：`policyDecision:` 行诚实镜像 JSON policy truth（authorized path → authorized + `primaryBlocker:none`；denied/恶意 → allowlist fail-closed）；`executionSentinel:` 行 **恒** blocked 直至真实 wiring。**禁止**把 authorized 渲染为 denied、把 null primary 渲染为 `unknown` policy blocker。Pure data plan ready must never be treated as real host recovery or Gold release.

**Tech Stack:** Node.js ESM, `node:test`, existing Web Console view model helpers, README/Gold static scorecard tests.

**Spec:** `docs/superpowers/specs/2026-07-14-supervisor-lifecycle-operator-recovery-design.md`

**Recovery anchor:** `a088630`

## Global Constraints

- Current release version becomes `V1.29`.
- Do not add endpoint, CLI command, Web button, or request body field.
- Do not modify `src/agent.js`, `src/server.js`, or `package.json`.
- Do not accept request/CLI `recoveryDecision` / `recoveryContext` / `operatorRecoveryReady` overrides.
- Do not call host shell / process-control / process list / filesystem / metadata / audit / approval writes / NAS / backup / restore / remote / network / launchctl / appendAuditEvent / retry scheduler / operator notification.
- Do not schedule, dispatch, or invoke runners; do not return functions/commands/paths/hosts/tokens/hashes/raw errors.
- Do not set `realOperatorRecoveryImplementationReady:true`, `wouldRecover:true`, `wouldRetry:true`, `wouldNotifyOperator:true`, `wouldRestartService:true`, `wouldRestoreState:true`, or any `*Allowed:true`.
- Do not set any upstream `real*ImplementationReady:true` or would* true (V1.25–V1.28 remain false).
- Do not set `runnerWiringContractReady:true`, `realRunnerWiringReady:true`, `executionEligible:true`, or claim Gold ready.
- Do **not** expand `POLICY_FACT_KEYS` or inject `real-guarded-runner-execution-wiring-missing` into `EXECUTION_POLICY_BLOCKER_CODES` to fake a policy deny.
- Ready path: if all policy facts true → `policyDecision` **authorized** / primary `null`; still `executionEligible:false`; Gold `blocked`.
- **Forbidden contradiction:** all six contracts ready + `operatorRecoveryReady:true` while policy primary is still `operator-recovery-not-ready`.
- G0a real two-Mac PASS statements stay unchanged.
- Malicious fixtures use **opaque synthetic strings only** (`UNSAFE_SECRET_MATERIAL`, `OPAQUE_UNSAFE_FIELD`).
- Sensitive scans report **category hit counts only**.
- Do **not** change V1.24–V1.28 public contracts (actionCandidates / registry / adapter / anchor / audit).
- Blocker vocabulary **excludes** `operator-recovery-operation-mismatch`, `operator-recovery-action-extra`, `operator-recovery-implementation-mismatch`, `operator-recovery-kind-mismatch`, cross-layer `operator-recovery-*-not-ready` from upstream decisions.
- This planning phase must not modify `src/`, `test/`, `README.md`, `package*`, or version files; implementation phase follows this plan.
- Do **not** create `actual-changes.txt`. Do **not** use `git reset --hard` as a routine recovery step in this plan.
- Do **not** introduce field name `wouldRecoverHost` (use `wouldRecover` + `wouldRestartService` + `wouldRestoreState`).

### 固定字段 vs 动态 fact（禁止混淆）

| 名称 | 类型 | V1.29 语义 |
| --- | --- | --- |
| `operatorRecoveryReadiness.operatorRecoveryReady` | **固定** readiness 输出 | 恒 `true`（builder 无参） |
| `gates.operatorRecoveryReady` | **动态** gate fact | readiness ∧ recoveryDecision 严格本地 boolean；合法 install fixtures → true；empty candidates → false |
| `recoveryDecision.recoveryReady` | **动态** decision 字段 | resolved 时 true；unresolved 时 false |
| `validationLines` 中的 `operatorRecoveryReady` | **动态** Web 派生 | **仅** `canonicalOperatorRecoveryReady`；禁止直接抄 `gates.*` |
| wouldRecover / wouldRetry / wouldNotifyOperator / wouldRestartService / wouldRestoreState / *Allowed / realOperatorRecoveryImplementationReady | **固定 false** | 任意 locus 恒 false |
| `executionEligible` / gate 顶层 `wouldExecute` / `runnerWiringContractReady` / `realRunnerWiringReady` | **固定 false** | 恒 false |
| wiring `readyCount`/`blockedCount` | **固定** aggregate | **6 / 0**（required contracts）；≠ runnerWiringContractReady |
| wiring aggregate `state` | **固定 blocked** | 仍 `'blocked'` + `real-guarded-runner-execution-wiring-missing` |
| ready path `policyDecision` | **动态** | 全部 POLICY_FACT_KEYS true → **authorized** / primary null |
| Web `policyDecision:` 行 | **动态**（policy truth locus） | 与 JSON 同真；authorized → `primaryBlocker:none`；denied → allowlisted / `unknown` |
| Web `executionSentinel:` 行 | **固定 blocked**（execution eligibility locus） | 恒 `state:blocked` + `blocker:real-guarded-runner-execution-wiring-missing` |
| `codeOwnedRecoveryResolverReady` | **固定** readiness | 产品级 pure resolver contract 已就绪 |
| `codeOwnedResolverWired` | **固定 true** on decision/entry | **单次 decision 来源路径标识**（≠ readiness） |
| `gates.attemptAuditReady` / `rollbackAnchorReady` / `hostMutationAdapterReady` / `runnerRegistryReady` | **动态**（上游语义） | **不回退** |

### 6/0 诚实性检查清单（每个 task 收尾自检）

- [ ] `readyCount:6` / `blockedCount:0` 已断言
- [ ] `runnerWiringContractReady:false` 已断言
- [ ] `realRunnerWiringReady:false` 已断言
- [ ] `executionEligible:false` 已断言
- [ ] ready path **无** `operator-recovery-not-ready` policy primary
- [ ] ready path + executeRequested：`policyDecision.state === 'authorized'` 且 `primaryBlocker === null`
- [ ] gate `nextBlockers` 仍为 `['real-guarded-runner-execution-wiring-missing']`
- [ ] Web ready path：`policyDecision:` **authorized** + `primaryBlocker:none`（**非** denied/unknown）
- [ ] Web **任意路径**：`executionSentinel:` 恒 blocked + wiring-missing
- [ ] Gold blocked 边界保持
---

### Task 1: Pure Resolver + Ready Operator-Recovery Readiness Contract

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

**Interfaces:**
- `resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(candidates, operation): object`
- `buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness(): object` (ready)
- `runnerWiringContract.requiredContracts[5].status:'ready'`
- gate later wires `recoveryDecision` + `gates.operatorRecoveryReady`
- wiring `readyCount:6` / `blockedCount:0`

- [ ] **Step 1: Write the failing pure tests (RED)**

Update imports:

```js
import {
  // existing...
  resolveSupervisorLifecycleGuardedRunnerOperatorRecovery,
  buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness,
  resolveSupervisorLifecycleGuardedRunnerAttemptAudit,
  buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness,
  resolveSupervisorLifecycleGuardedRunnerRollbackAnchor,
  // ... V1.25–V1.27 resolvers/readiness as needed
  areSupervisorLifecycleGuardedRunnerActionCandidatesReady,
  buildSupervisorLifecycleApplyPlan,
} from '../src/supervisor-lifecycle.js';
```

Fixtures:

```js
const EXPECTED_WIRING_CONTRACTS = Object.freeze([
  ['execution-policy', null, 'ready', 'execution-policy-ready'],
  ['runner-registry', null, 'ready', 'runner-registry-ready'],
  ['host-mutation-adapter', null, 'ready', 'host-mutation-adapter-ready'],
  ['rollback-anchor', null, 'ready', 'rollback-anchor-ready'],
  ['attempt-audit', null, 'ready', 'attempt-audit-ready'],
  ['operator-recovery', null, 'ready', 'operator-recovery-ready'],
]);

// Exact schema 对齐 spec §2.4：
// - 唯一 real-* 字段：realOperatorRecoveryImplementationReady（恒 false）
// - 不得含 realOperatorRecoveryReady / realImplementationReady / sensitiveValuesReturned
// - 不得含 failureRecoveryReady / retryLimitReady / operatorRunbookReady
// - entry.recoveryKind='code-owned-operator-recovery' 为 catalog-level 汇总标识
//   （≠ recoveries[] 行 action-level recoveryKind）
const EXPECTED_OPERATOR_RECOVERY_ENTRIES = Object.freeze([
  {
    recoveryKind: 'code-owned-operator-recovery',
    state: 'ready',
    codeOwnedResolverWired: true,
    realOperatorRecoveryImplementationReady: false,
    wouldRecover: false,
    wouldRetry: false,
    wouldNotifyOperator: false,
    wouldRestartService: false,
    wouldRestoreState: false,
    wouldExecute: false,
    wouldRun: false,
    wouldWrite: false,
    metadataWriteAllowed: false,
    filesystemWriteAllowed: false,
    remoteCommandAllowed: false,
    operatorNotificationAllowed: false,
    blockerCode: null,
    evidenceCode: 'operator-recovery-ready',
  },
]);

const CODE_OWNED_ACTION_RECOVERY_MAP = Object.freeze({
  'render-launch-agent-plist': 'render-plist-operator-recovery',
  'write-launch-agent-plist': 'write-plist-operator-recovery',
  'load-launch-agent': 'load-agent-operator-recovery',
  'unload-launch-agent': 'unload-agent-operator-recovery',
  'remove-launch-agent-plist': 'remove-plist-operator-recovery',
  'remove-supervisor-metadata': 'remove-metadata-operator-recovery',
  'capture-current-state': 'capture-state-operator-recovery',
  'restore-previous-plist': 'restore-plist-operator-recovery',
  'restart-previous-supervisor': 'restart-supervisor-operator-recovery',
  'start-recovery-supervisor': 'recovery-supervisor-operator-recovery',
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

// 冻结投影仅作 fixture 便利；权威来源 = buildLifecycleActions(operation).map(a => a.id)
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

Helpers（**必须**定义并使用）：

```js
function validRecoveryCandidate(actionId, maxAttempts = 1) {
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

function validRecoveryCandidatesFor(operation) {
  return OPERATION_EXPECTED_ACTION_IDS[operation].map((id) => validRecoveryCandidate(id, 1));
}

function assertRecoveryResolved(decision, operation) {
  const expected = OPERATION_EXPECTED_ACTION_IDS[operation];
  assert.strictEqual(decision.command, 'supervisor-lifecycle-guarded-runner-operator-recovery');
  assert.strictEqual(decision.operation, operation);
  assert.strictEqual(decision.state, 'resolved');
  assert.strictEqual(decision.recoveryReady, true);
  assert.strictEqual(decision.codeOwnedResolverWired, true);
  assert.strictEqual(decision.realOperatorRecoveryImplementationReady, false);
  assert.strictEqual(decision.wouldRecover, false);
  assert.strictEqual(decision.wouldRetry, false);
  assert.strictEqual(decision.wouldNotifyOperator, false);
  assert.strictEqual(decision.wouldRestartService, false);
  assert.strictEqual(decision.wouldRestoreState, false);
  assert.strictEqual(decision.wouldExecute, false);
  assert.strictEqual(decision.wouldRun, false);
  assert.strictEqual(decision.wouldWrite, false);
  assert.strictEqual(decision.metadataWriteAllowed, false);
  assert.strictEqual(decision.filesystemWriteAllowed, false);
  assert.strictEqual(decision.remoteCommandAllowed, false);
  assert.strictEqual(decision.operatorNotificationAllowed, false);
  assert.strictEqual(decision.resolvedCount, expected.length);
  assert.strictEqual(decision.unresolvedCount, 0);
  assert.strictEqual(decision.primaryBlocker, null);
  assert.deepStrictEqual(decision.blockers, []);
  assert.deepStrictEqual(decision.nextBlockers, []);
  assert.strictEqual(decision.sensitiveValuesReturned, false);
  assert.strictEqual(decision.recoveries.length, expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    const row = decision.recoveries[i];
    assert.strictEqual(row.actionId, expected[i]);
    assert.strictEqual(row.recoveryKind, CODE_OWNED_ACTION_RECOVERY_MAP[expected[i]]);
    assert.strictEqual(row.recoveryReady, true);
    assert.strictEqual(row.realOperatorRecoveryImplementationReady, false);
    assert.strictEqual(row.wouldRecover, false);
    assert.strictEqual(row.wouldRetry, false);
    assert.strictEqual(row.wouldNotifyOperator, false);
    assert.strictEqual(row.wouldRestartService, false);
    assert.strictEqual(row.wouldRestoreState, false);
    assert.strictEqual(row.wouldExecute, false);
    assert.strictEqual(row.wouldRun, false);
    assert.strictEqual(row.wouldWrite, false);
    assert.strictEqual(row.metadataWriteAllowed, false);
    assert.strictEqual(row.filesystemWriteAllowed, false);
    assert.strictEqual(row.remoteCommandAllowed, false);
    assert.strictEqual(row.operatorNotificationAllowed, false);
    assert.strictEqual(row.blockerCode, null);
    assert.strictEqual(row.evidenceCode, 'operator-recovery-plan-ready');
    assert.strictEqual(Object.hasOwn(row, 'codeOwnedResolverWired'), false);
  }
}

function assertRecoveryUnresolvedExact(decision, primaryBlocker, operation) {
  assert.strictEqual(typeof operation, 'string'); // 第三参必传
  assert.strictEqual(decision.state, 'unresolved');
  assert.strictEqual(decision.recoveryReady, false);
  assert.strictEqual(decision.operation, operation);
  assert.strictEqual(decision.primaryBlocker, primaryBlocker);
  assert.deepStrictEqual(decision.blockers, [primaryBlocker]);
  assert.deepStrictEqual(decision.nextBlockers, [primaryBlocker]);
  assert.strictEqual(decision.resolvedCount, 0);
  // all-or-nothing：unresolvedCount 恒 0，不统计 action 失败数；
  // decision 状态仅由 state/primaryBlocker（及 blockers/nextBlockers）表达
  assert.strictEqual(decision.unresolvedCount, 0);
  assert.deepStrictEqual(decision.recoveries, []);
  assert.strictEqual(decision.wouldRecover, false);
  assert.strictEqual(decision.wouldRestartService, false);
  assert.strictEqual(decision.wouldRestoreState, false);
  assert.strictEqual(decision.realOperatorRecoveryImplementationReady, false);
  // codeOwnedResolverWired = 单次 decision 来源路径标识（≠ codeOwnedRecoveryResolverReady readiness）
  assert.strictEqual(decision.codeOwnedResolverWired, true);
}
```

#### Pure / readiness RED→GREEN 测试矩阵
| ID | Case | Expected primary / result |
| --- | --- | --- |
| T1 | install valid candidates | resolved；kinds exact map；counts = 3/0 |
| T2 | uninstall / rollback / recover valid | resolved；expected lengths 3/3/1 |
| T3 | OPERATION_EXPECTED_ACTION_IDS 与 apply plan actions 一致（每 operation） | deepStrictEqual |
| T4 | operation invalid（number/null/unknown string） | `operator-recovery-operation-invalid`；operation=`'unknown'` |
| T5 | candidates non-array / null | `operator-recovery-candidates-invalid` |
| T6 | empty array | `operator-recovery-candidates-invalid` |
| T7 | install 子集 2 行合法 shape | `operator-recovery-action-missing` |
| T8 | install + 外来 start-recovery-supervisor（len 4 无重复） | `operator-recovery-action-unknown` |
| T9 | install + 重复 render（len 4） | `operator-recovery-action-duplicate` |
| T10 | actionId `''` / number / object | `operator-recovery-candidates-invalid`（先于集合类） |
| T11 | extra key / missing key / prototype pollution key | `operator-recovery-candidates-invalid` |
| T12 | own getter / accessor | `operator-recovery-candidates-invalid` |
| T13 | container trap throw / ownKeys throw | `operator-recovery-candidates-invalid`；无 raw error 泄漏 |
| T14 | status ≠ blocked | `operator-recovery-unsafe-recovery` |
| T15 | wouldExecute/wouldRun/wouldWrite true | `operator-recovery-unsafe-recovery` |
| T16 | non-catalog implementationId 仍 resolved（忽略 impl） | resolved |
| T17 | maxAttempts `'[redacted]'` 仍 resolved | resolved |
| T18 | duplicate 优先于 unsafe（同 input 同时成立） | primary=`operator-recovery-action-duplicate` |
| T19 | 深拷贝：改 input 不影响已返回 decision | 不变 |
| T20 | 深拷贝：改 returned decision 不影响下次调用 | 新调用干净 |
| T21 | readiness builder 固定 ready + entry deepEqual EXPECTED | state ready；entry exact |
| T22 | readiness 忽略多余参数 / null | identical baseline |
| T23 | 旧键不残留：`realOperatorRecoveryReady` / `realImplementationReady` / entry `sensitiveValuesReturned` / `failureRecoveryReady` 等 | `Object.hasOwn(...) === false` |
| T24 | wiring contract fixture：EXPECTED_WIRING_CONTRACTS 全 ready；readyCount 6 / blockedCount 0；state still blocked；blockers 含 real-guarded-runner-execution-wiring-missing | exact |
| T25 | operatorRecoveryReadiness 挂在 wiring；realOperatorRecoveryImplementationReady false | exact |
| T26 | recoveryKind 输出 ∈ allowlist；input 带 recoveryKind 键 → candidates-invalid | exact |
| T27 | 分层：valid candidates 时 registry/adapter/anchor/audit/recovery 均可独立 resolved | pure 联调 |
| T28 | safety deepStrictEqual executionPreviewSafety() | exact |

- [ ] **Step 2: Run pure tests — expect RED**

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

Expected: RED on missing export / old blocked readiness / old wiring 5/1 / stub entry.

- [ ] **Step 3: Implement pure resolver + readiness + wiring constants (GREEN for pure parts)**

Implement in `src/supervisor-lifecycle.js`（对照 V1.28 attempt-audit 结构）：

1. Constants：`OPERATOR_RECOVERY_READY_EVIDENCE`、`OPERATOR_RECOVERY_PLAN_READY_EVIDENCE`、`CODE_OWNED_OPERATOR_RECOVERY_KIND`、`OPERATOR_RECOVERY_BLOCKER_CODES`、`CODE_OWNED_ACTION_RECOVERY_MAP`、`OPERATOR_RECOVERY_KIND_ALLOWLIST`、`GUARDED_RUNNER_READY_OPERATOR_RECOVERY_ENTRY`
2. 删除/停用 `GUARDED_RUNNER_DISABLED_OPERATOR_RECOVERY_ENTRY` 与 `DISABLED_OPERATOR_RECOVERY_KIND` 作为 readiness 输出路径
3. `buildUnresolvedOperatorRecoveryDecision` / `buildResolvedOperatorRecoveryDecision` / `sanitizeOperatorRecoveryDecision`
4. `export function resolveSupervisorLifecycleGuardedRunnerOperatorRecovery`
5. Rewrite `buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness` → ready schema
6. `GUARDED_RUNNER_WIRING_CONTRACTS[5]` → ready + `operator-recovery-ready` + `blockerCode:null`
7. wiring aggregate：`readyCount:6`、`blockedCount:0`；**保持** `state:'blocked'`、`realRunnerWiringReady:false`、blockers=`real-guarded-runner-execution-wiring-missing`

评估顺序严格按 spec §1.6。expectedIds **必须** `buildLifecycleActions(operation).map(a => a.id)`。

- [ ] **Step 4: Re-run pure tests — expect GREEN for pure/readiness/wiring fixture parts**

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

---

### Task 2: Gate Wiring — local `operatorRecoveryReady` + `recoveryDecision` + policy

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

- [ ] **Step 1: RED gate assertions**

Production path expectations:

```js
// Ignore options.recoveryDecision / options.operatorRecoveryReady / options.recoveryContext.
const recoveryDecision = sanitizeOperatorRecoveryDecision(
  resolveSupervisorLifecycleGuardedRunnerOperatorRecovery(actionCandidates, operation),
);

const operatorRecoveryReadiness = runnerWiringContract.operatorRecoveryReadiness;
const operatorRecoveryReady =
  operatorRecoveryReadiness?.operatorRecoveryReady === true &&
  operatorRecoveryReadiness?.codeOwnedRecoveryResolverReady === true &&
  operatorRecoveryReadiness?.state === 'ready' &&
  operatorRecoveryReadiness?.realOperatorRecoveryImplementationReady === false &&
  recoveryDecision?.recoveryReady === true &&
  recoveryDecision?.state === 'resolved' &&
  recoveryDecision?.codeOwnedResolverWired === true &&
  recoveryDecision?.realOperatorRecoveryImplementationReady === false &&
  recoveryDecision?.wouldRecover === false &&
  recoveryDecision?.wouldRetry === false &&
  recoveryDecision?.wouldNotifyOperator === false &&
  recoveryDecision?.wouldRestartService === false &&
  recoveryDecision?.wouldRestoreState === false &&
  recoveryDecision?.wouldExecute === false &&
  recoveryDecision?.wouldRun === false &&
  recoveryDecision?.wouldWrite === false &&
  recoveryDecision?.metadataWriteAllowed === false &&
  recoveryDecision?.filesystemWriteAllowed === false &&
  recoveryDecision?.remoteCommandAllowed === false &&
  recoveryDecision?.operatorNotificationAllowed === false;
```

Gate matrix:

| ID | Setup | gates.operatorRecoveryReady | gates.attemptAuditReady | gates.runnerRegistryReady | policy |
| --- | --- | --- | --- | --- | --- |
| G1 | ready install + executeRequested | true | true | true | **`authorized`**；primary=`null`；**不含** `operator-recovery-not-ready`；wouldRun/wouldWrite false |
| G2 | ready install + executeRequested false | true | true | true | denied 含 `execute-request-missing`；**不含** `operator-recovery-not-ready`；recovery fact 仍 true |
| G3 | missing runnerBinding / empty candidates | false | false | false | deny 含 not-ready 族 |
| G4 | non-catalog implementationId binding | true | true | **false** | deny 含 `runner-registry-not-ready`；**不含** `operator-recovery-not-ready` / audit/anchor/adapter not-ready |
| G5 | redacted maxAttempts binding | true | true | **false** | 同上 |
| G6 | options override `operatorRecoveryReady:true` + fake recoveryDecision | 仍由 production 决定 | 不变 | 不变 | override 无效 |
| G7 | gate 顶层恒 false | — | — | — | `executionEligible:false` / `wouldExecute:false` / `runnerWiringContractReady:false` / `realRunnerWiringReady:false` |
| G8 | nextBlockers / blockers 仍含 wiring missing | — | — | — | `nextBlockers === ['real-guarded-runner-execution-wiring-missing']` |
| G9 | 上游 audit/anchor/adapter decision 不回归 | true | true | true | flags 仍 false |

Shared gate helper update:

```js
function assertBlockedGateShape(result, {
  runnerRegistryReady,
  hostMutationAdapterReady,
  rollbackAnchorReady,
  attemptAuditReady,
  operatorRecoveryReady,
}) {
  assert.strictEqual(typeof runnerRegistryReady, 'boolean');
  assert.strictEqual(typeof hostMutationAdapterReady, 'boolean');
  assert.strictEqual(typeof rollbackAnchorReady, 'boolean');
  assert.strictEqual(typeof attemptAuditReady, 'boolean');
  assert.strictEqual(typeof operatorRecoveryReady, 'boolean');

  assert.strictEqual(result.executionEligible, false);
  assert.strictEqual(result.wouldExecute, false);
  assert.strictEqual(result.gates.runnerRegistryReady, runnerRegistryReady);
  assert.strictEqual(result.gates.hostMutationAdapterReady, hostMutationAdapterReady);
  assert.strictEqual(result.gates.rollbackAnchorReady, rollbackAnchorReady);
  assert.strictEqual(result.gates.attemptAuditReady, attemptAuditReady);
  assert.strictEqual(result.gates.operatorRecoveryReady, operatorRecoveryReady);
  assert.strictEqual(result.gates.runnerWiringContractReady, false);
  assert.strictEqual(result.gates.realRunnerWiringReady, false);
  assert.strictEqual(result.realRunnerWiringReady, false);

  assert.strictEqual(result.runnerWiringContract.readyCount, 6);
  assert.strictEqual(result.runnerWiringContract.blockedCount, 0);
  assert.strictEqual(result.runnerWiringContract.state, 'blocked');
  assert.strictEqual(result.runnerWiringContract.realRunnerWiringReady, false);
  assert.ok(result.runnerWiringContract.blockers.includes('real-guarded-runner-execution-wiring-missing'));

  // all 6 required contracts ready via EXPECTED_WIRING_CONTRACTS
  assert.ok(result.recoveryDecision);
  assert.strictEqual(result.recoveryDecision.codeOwnedResolverWired, true);
  assert.strictEqual(result.recoveryDecision.realOperatorRecoveryImplementationReady, false);
  assert.strictEqual(result.recoveryDecision.wouldRecover, false);
  assert.strictEqual(result.recoveryDecision.wouldRestartService, false);
  assert.strictEqual(result.recoveryDecision.wouldRestoreState, false);

  assert.strictEqual(result.policyDecision.wouldRun, false);
  assert.strictEqual(result.policyDecision.wouldWrite, false);
  assert.deepStrictEqual(result.nextBlockers, ['real-guarded-runner-execution-wiring-missing']);
  assert.ok(result.blockers.includes('real-guarded-runner-execution-wiring-missing'));
}
```

**G1 专属（不得放进 shared helper 固定 authorized，因 empty path 不同）：**

```js
assert.strictEqual(result.policyDecision.state, 'authorized');
assert.strictEqual(result.policyDecision.authorized, true);
assert.strictEqual(result.policyDecision.wouldAuthorizeExecution, true);
assert.strictEqual(result.policyDecision.primaryBlocker, null);
assert.deepStrictEqual(result.policyDecision.blockers, []);
assert.ok(!result.policyDecision.blockers.includes('operator-recovery-not-ready'));
assert.strictEqual(result.executionEligible, false);
```

- [ ] **Step 2: Implement gate wiring (GREEN)**

1. Call resolver only with production candidates + operation
2. Attach `recoveryDecision` to gate output
3. Derive local `operatorRecoveryReady` boolean（strict conjunction）
4. Put into `policyContext.operatorRecoveryReady`（**不再 hardcode false**）
5. Keep `executionEligible:false` / `wouldExecute:false` / `runnerWiringContractReady:false` / `realRunnerWiringReady:false`
6. Keep pushing `real-guarded-runner-execution-wiring-missing` to gate blockers/nextBlockers
7. Ignore caller overrides
8. Keep V1.25–V1.28 predicates intact

- [ ] **Step 3: Re-run gate pure file**

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

Expected: GREEN for gate + pure.

---

### Task 3: API / CLI 透传 helper 参数化

**Files:**
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js`
- Modify: `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js`
- **Do not** modify `src/server.js` / `src/agent.js`

- [ ] **Step 1: 改造两个共用 helper 本体 + fixture（RED 期望对齐 V1.29）**

```js
function assertBlockedExecutionGate(body, {
  runnerRegistryReady,
  hostMutationAdapterReady,
  rollbackAnchorReady,
  attemptAuditReady,
  operatorRecoveryReady,
}) {
  assert.strictEqual(typeof runnerRegistryReady, 'boolean');
  assert.strictEqual(typeof hostMutationAdapterReady, 'boolean');
  assert.strictEqual(typeof rollbackAnchorReady, 'boolean');
  assert.strictEqual(typeof attemptAuditReady, 'boolean');
  assert.strictEqual(typeof operatorRecoveryReady, 'boolean');

  assert.strictEqual(body.executionEligible, false);
  assert.strictEqual(body.wouldExecute, false);
  assert.strictEqual(body.gates.runnerRegistryReady, runnerRegistryReady);
  assert.strictEqual(body.gates.hostMutationAdapterReady, hostMutationAdapterReady);
  assert.strictEqual(body.gates.rollbackAnchorReady, rollbackAnchorReady);
  assert.strictEqual(body.gates.attemptAuditReady, attemptAuditReady);
  assert.strictEqual(body.gates.operatorRecoveryReady, operatorRecoveryReady);
  assert.strictEqual(body.gates.runnerWiringContractReady, false);
  assert.strictEqual(body.gates.realRunnerWiringReady, false);

  assert.strictEqual(body.runnerWiringContract.readyCount, 6);
  assert.strictEqual(body.runnerWiringContract.blockedCount, 0);
  assert.strictEqual(body.runnerWiringContract.state, 'blocked');

  const contracts = body.runnerWiringContract.requiredContracts;
  assert.strictEqual(contracts[5].id, 'operator-recovery');
  assert.strictEqual(contracts[5].status, 'ready');
  assert.strictEqual(contracts[5].blockerCode, null);
  assert.strictEqual(contracts[5].evidenceCode, 'operator-recovery-ready');
  assert.ok(contracts.every((c) => c.status === 'ready'));

  const readiness = body.runnerWiringContract.operatorRecoveryReadiness;
  assert.strictEqual(readiness.state, 'ready');
  assert.strictEqual(readiness.operatorRecoveryReady, true);
  assert.strictEqual(readiness.codeOwnedRecoveryResolverReady, true);
  assert.strictEqual(readiness.realOperatorRecoveryImplementationReady, false);
  assert.strictEqual(Object.hasOwn(readiness, 'realOperatorRecoveryReady'), false);

  assert.strictEqual(body.policyDecision.wouldRun, false);
  assert.strictEqual(body.policyDecision.wouldWrite, false);

  assert.ok(body.recoveryDecision);
  assert.strictEqual(body.recoveryDecision.codeOwnedResolverWired, true);
  assert.strictEqual(body.recoveryDecision.realOperatorRecoveryImplementationReady, false);
  assert.strictEqual(body.recoveryDecision.wouldRecover, false);
  assert.strictEqual(body.recoveryDecision.wouldRestartService, false);
  assert.strictEqual(body.recoveryDecision.wouldRestoreState, false);

  // V1.28/V1.27/V1.26/V1.25 不回退
  assert.strictEqual(body.runnerWiringContract.attemptAuditReadiness.state, 'ready');
  assert.strictEqual(body.runnerWiringContract.rollbackAnchorReadiness.state, 'ready');
  assert.strictEqual(body.runnerWiringContract.hostMutationAdapterReadiness.state, 'ready');
  assert.strictEqual(body.runnerWiringContract.runnerRegistryReadiness.state, 'ready');
}
```

**调用点矩阵（API + CLI 对称）：**

| 场景 | reg | ada | anc | aud | rec | 专属断言 |
| --- | --- | --- | --- | --- | --- | --- |
| valid ready path + executeRequested | t | t | t | t | t | `policyDecision.state==='authorized'`；primary `null`；blockers `[]`；**无** `operator-recovery-not-ready`；`recoveryDecision` resolved；`executionEligible:false`；nextBlockers wiring-missing |
| executeRequested false | t | t | t | t | t | recovery fact 仍 true；policy denied 含 `execute-request-missing`；**无** `operator-recovery-not-ready` |
| missing runnerBinding | f | f | f | f | f | unresolved candidates 族 |
| non-catalog implementationId | f | t | t | t | t | 含 `runner-registry-not-ready`；不含 recovery/audit/anchor/adapter not-ready |
| redacted maxAttempts | f | t | t | t | t | 同上 |
| override body fields | production | production | production | production | production | override 无效 |

- [ ] **Step 2: Run API/CLI tests**

```bash
node --test --test-reporter=spec \
  test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js \
  test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

Expected: GREEN after Task 2 gate wiring is complete.

---

### Task 4: Web canonical fail-closed assembly

**Files:**
- Modify: `src/web/app.js`
- Modify: `test/web-console.test.js`

**定位约定（禁止依赖绝对行号）：** 用符号名 / 字符串锚点定位。实现时：

```bash
rg -n 'function buildSupervisorLifecycleGuardedRunnerOperatorRecoveryLines' src/web/app.js
rg -n 'disabled-operator-recovery-stub' src/web/app.js test/web-console.test.js
rg -n 'WIRING_CONTRACT_CANONICAL_MISSING_BLOCKERS' src/web/app.js
rg -n 'operator-recovery-real-implementation-missing' src/web/app.js test/web-console.test.js
rg -n 'operatorRecoveryReady:false' test/web-console.test.js
```

- [ ] **Step 1: RED Web tests**

1. 从 `WIRING_CONTRACT_CANONICAL_MISSING_BLOCKERS` **移除** `operator-recovery`（map 可空）。
2. 新增 `isCanonicalOperatorRecoveryReady` / `resolveCanonicalOperatorRecoveryReady`（C∧A∧G∧D）。
3. Wiring line：ready 仅当 canonical true；否则 fixed `operator-recovery-missing`。
4. Recovery line：ready/blocked fixed strings（spec §5.2）；禁止 `disabled-operator-recovery-stub` 正常路径；禁止旧 `realImplementationReady` 文案残留。
5. validationLines：`operatorRecoveryReady` 仅 canonical。
6. 恶意 payload：`wouldRecover:true` / `wouldRestartService:true` / `wouldRestoreState:true` / secret recoveryKind → 全部 blocked，不泄漏。
7. C/A/G 表面 ready + D side-effect drift → 全部 blocked。
8. 保持 registry/adapter/anchor/audit 独立 canonical 不回归。
9. **方案 A 双 locus（废除“Web 强制 denied”）：**
   - policy truth：`isCanonicalPolicyDecisionAuthorized` 为 true 时输出 authorized 行 + `primaryBlocker:none`；**禁止**把 authorized 渲染为 denied；**禁止**把 null primary 渲染为 `unknown`。
   - 否则 fail-closed denied + allowlisted primary（或 `unknown`）；恶意/secret primary **不回显**。
   - execution eligibility：`executionSentinel` 行 **任意路径恒** blocked + `real-guarded-runner-execution-wiring-missing`。
   - W1–W7 全 GREEN（见 spec §5.2 测试矩阵）。
10. 始终 `runnerWiringContractReady:false` / `realRunnerWiringReady:false` / `executionEligible:false`。

Ready line exact:

```text
operatorRecovery:code-owned-operator-recovery:state:ready:codeOwnedResolverWired:true:realOperatorRecoveryImplementationReady:false:wouldRecover:false:wouldRestartService:false:wouldRestoreState:false:blocker:none
```

Blocked line exact:

```text
operatorRecovery:code-owned-operator-recovery:state:blocked:codeOwnedResolverWired:true:realOperatorRecoveryImplementationReady:false:wouldRecover:false:wouldRestartService:false:wouldRestoreState:false:blocker:operator-recovery-not-ready
```

Wiring ready:

```text
wiringContract:operator-recovery:status:ready:requiredForExecution:true:blocker:none
```

Wiring blocked:

```text
wiringContract:operator-recovery:status:blocked:requiredForExecution:true:blocker:operator-recovery-missing
```

**Policy truth + execution sentinel exact（方案 A 定稿）：**

```text
# authorized JSON path（canonical 谓词全 true）
policyDecision:state:authorized:authorized:true:wouldAuthorizeExecution:true:primaryBlocker:none
executionSentinel:state:blocked:executionEligible:false:blocker:real-guarded-runner-execution-wiring-missing

# denied / 恶意 / incomplete
policyDecision:state:denied:authorized:false:wouldAuthorizeExecution:false:primaryBlocker:<allowlisted-or-unknown>
executionSentinel:state:blocked:executionEligible:false:blocker:real-guarded-runner-execution-wiring-missing
```

#### Web policy / execution 子矩阵（W1–W7；与 pure T1–T28 独立计数）

| ID | Case | policy 行 | executionSentinel |
| --- | --- | --- | --- |
| W1 | canonical authorized JSON | authorized + `primaryBlocker:none` | 恒 blocked + wiring-missing |
| W2 | denied + allowlisted primary | denied + 该 primary | 恒 blocked |
| W3 | primary 非 allowlist / 缺失 | denied + `unknown` | 恒 blocked |
| W4 | 恶意 authorized drift（wouldRun/wouldWrite true 等） | denied fail-closed | 恒 blocked |
| W5 | secret 注入 primaryBlocker | denied + `unknown`（不回显） | 恒 blocked |
| W6 | 缺 policyDecision / 非对象 | denied + `unknown` | 恒 blocked |
| W7 | 任意路径 requiredFields | 恰 1 行 `policyDecision:` | 恰 1 行 `executionSentinel:` |

- [ ] **Step 2: Implement Web assembly (GREEN)**

**必须替换现有函数本体（按函数名定位，非行号）：**

- **整函数替换** `buildSupervisorLifecycleGuardedRunnerOperatorRecoveryLines(...)`：删除 V1.22 硬编码的
  - `disabled-operator-recovery-stub`
  - `realImplementationReady:false`
  - `blocker:operator-recovery-real-implementation-missing`
  - 改为基于 `canonicalOperatorRecoveryReady` 输出 fixed ready/blocked 行
- 更新 `buildSupervisorLifecycleGuardedRunnerWiringContractLines` 增加 operator-recovery canonical 分支（类似 attempt-audit）
- 更新 `buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel`：计算 `canonicalOperatorRecoveryReady`，传入 wiring/recovery lines；validationLines 用 canonical；**禁止**抄 `gates.operatorRecoveryReady` 孤值
- **重写** `buildSupervisorLifecycleGuardedRunnerPolicyDecisionLines`（方案 A）：
  - 删除 V1.24 “Always render denied” 注释与强制 denied 行为
  - 实现 `isCanonicalPolicyDecisionAuthorized`；authorized → fixed authorized 行 + `primaryBlocker:none`
  - denied/恶意 → allowlist primary 或 `unknown`；**不回显** raw payload
  - **始终**附加固定 `executionSentinel:` 行（恒 blocked + wiring-missing）
  - 返回数组长度恒为 **2**（policy 行 + sentinel 行）
- `EXECUTION_POLICY_DECISION_BLOCKER_ALLOWLIST` **可保留** `operator-recovery-not-ready`（仍用于非 ready path / Web denied 透传），但 ready path **不得**用它伪装 policy blocked；execution 阻塞只走 `executionSentinel`
- [ ] **Step 3: Run Web tests**

```bash
node --test --test-reporter=spec test/web-console.test.js
```

---

### Task 5: Version / README / Gold

**Files:**
- Modify: `src/version.js` → `V1.29`
- Modify: `README.md`
- Modify: `src/gold-readiness.js`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js`

- [ ] **Step 1: RED version/readme/gold expectations**

README / Gold 必须包含（当前版本叙述）：

- `resolveSupervisorLifecycleGuardedRunnerOperatorRecovery`
- `operatorRecoveryReadiness.state:ready`
- `operatorRecoveryReady:true`
- `codeOwnedRecoveryResolverReady:true`
- `codeOwnedResolverWired`
- `operator-recovery-ready`
- `realOperatorRecoveryImplementationReady:false`
- `recoveryDecision`
- `readyCount:6` / `blockedCount:0`
- `executionEligible:false`
- `runnerWiringContractReady:false`
- `realRunnerWiringReady:false`
- 明确 **6/0 ≠ Gold ready ≠ real host execution**
- ready path policy 可 authorized 但 wouldRun/wouldWrite false；gate 仍 blocked by `real-guarded-runner-execution-wiring-missing`
- V1.28 降为历史版本行

Gold evidence **移除作为当前缺口**：

- `operatorRecoveryReadiness.state:blocked`
- readiness 主码式 `operatorRecoveryReady:false`（作为“当前 blocked fact”）
- `operator-recovery-real-implementation-missing`（作为 wiring 当前 primary 缺口叙述；历史可保留）

Gold nextStep **必须**指向：

- 真实 guarded runner wiring（`realRunnerWiringReady` / `runnerWiringContractReady` / `real-guarded-runner-execution-wiring-missing`）
- 并并列真实 host mutation / rollback write-restore / attempt audit persist / operator recovery implementation 仍缺失
- **禁止** “next wiring item is operator-recovery”

- [ ] **Step 2: Implement version surfaces (GREEN)**

- [ ] **Step 3: Run version suite**

```bash
node --test --test-reporter=spec \
  test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

---

### Task 6: Full regression + side-effect / sensitive scan + scope check

- [ ] **Step 1: Focused suite**

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
```

- [ ] **Step 2: Full regression**

```bash
npm test
```

- [ ] **Step 3: Side-effect scan（相对 a088630）**

```bash
git diff a088630 -- src/supervisor-lifecycle.js | rg -n \
  'launchctl|child_process|execSync|spawn\(|exec\(|fs\.(write|rm|unlink|mkdir)|process\.kill|net\.|http\.|https\.|appendAuditEvent' \
  && echo 'FAIL: side-effect call pattern in diff' || echo 'ok: no side-effect pattern in lifecycle diff'
```

- [ ] **Step 4: Sensitive category count only**

```bash
git diff a088630 -- src/ test/ | rg -c \
  'ssh-rsa|BEGIN (RSA |OPENSSH )?PRIVATE|AKIA[0-9A-Z]{16}|[0-9a-f]{64}' \
  || true
```

期望：无命中；若有命中只报告 count，不得 cat 原文。

- [ ] **Step 5: Scope / anchor 核对（无写入；不要 hard reset）**

```bash
git merge-base --is-ancestor a088630 HEAD && echo 'anchor-ok'
git rev-parse HEAD
git diff --name-only a088630 --
git status --short
git diff --name-only a088630 -- src/agent.js src/server.js package.json
# 期望：禁止文件无输出
```

允许修改文件名必须 ⊆ spec §8 列表。

若全量测试暴露 **未列入** 文件失败：先停；用 `rg` 证实后仅追加必要文件，禁止猜测扩大。

---

## RED→GREEN 总矩阵（实现验收速查）

| 层 | 关键断言 | RED 触发（旧态） | GREEN（V1.29） |
| --- | --- | --- | --- |
| Pure | T1–T28 | 无 export / stub blocked | resolver + ready readiness |
| Wiring | 6/0 + all contracts ready + aggregate blocked | 5/1 + operator-recovery blocked | 6/0 + state blocked + wiring-missing |
| Gate G1 | operatorRecoveryReady true + policy authorized | hardcode false + deny primary operator-recovery-not-ready | authorized / null + executionEligible false |
| Gate G2–G6 | 分层 + override ignore | 旧 helper | 新矩阵 |
| API/CLI | helper 5 参数 + 6/0 + recoveryDecision | 4 参数 / 5/1 / no recoveryDecision | 对称透传 |
| Web | C∧A∧G∧D + fixed lines + **方案 A 双 locus**（policy truth + executionSentinel） | stub line + always blocked contract + forced policy denied | ready recovery line + authorized policy 行（ready path）+ sentinel 恒 blocked；W1–W7 |
| Version/Gold | V1.29 + nextStep real wiring | V1.28 + nextStep operator-recovery | updated + Gold blocked |
| Safety | no side-effect / sensitive / forbidden files | — | scan clean |

**测试计数（实现验收）：** pure/readiness T1–T28 = **28**；Web policy/sentinel W1–W7 = **7**；gate G1–G9 与 API/CLI 调用点矩阵见各 Task。

---

## 完成标准（实现阶段验收）

1. pure resolver 全矩阵 GREEN（T1–T28）；all-or-nothing（unresolved `unresolvedCount` 恒 0，**不**统计 action 失败数；决策状态由 `state`/`primaryBlocker` 表达）；深拷贝；稳定 blocker 序。
2. readiness fixed ready + entry exact；`codeOwnedRecoveryResolverReady`（readiness）与 `codeOwnedResolverWired`（decision 来源路径标识）语义分离；catalog-level kind ≠ action-level kinds；旧键不残留。
3. wiring `readyCount:6` / `blockedCount:0`；六个 required contracts 全 ready；aggregate 仍 `state:'blocked'` + `real-guarded-runner-execution-wiring-missing`。
4. production gate ready path：`gates.operatorRecoveryReady:true`，`recoveryDecision` resolved，**`policyDecision` authorized / primary null**，**不含** `operator-recovery-not-ready`，`executionEligible:false`，`runnerWiringContractReady:false`，`realRunnerWiringReady:false`，gate nextBlockers 仍 wiring-missing。
5. API/CLI/Web 透传与 C∧A∧G∧D 一致；恶意 side-effect drift fail-closed；Web 替换 operator recovery lines；**Web 方案 A：** policy truth 与 execution sentinel 双 locus（W1–W7）；ready path policy 行 authorized + `primaryBlocker:none`；`executionSentinel` 恒 blocked；**无**“Web 强制 denied/unknown 伪装 authorized”残留。
6. version/README/Gold → V1.29；Gold 仍 blocked；G0a PASS 不变；nextStep 指向真实 wiring 而非 operator-recovery。
7. 无 fs/network/process/shell/launchctl/appendAuditEvent 副作用；禁止文件未改。
8. **不**宣称 `runnerWiringContractReady:true` / `realRunnerWiringReady:true` / `executionEligible:true` / Gold ready。
9. **不**制造 “6/0 全部 ready 但仍以 operator-recovery-not-ready 为 policy primary” 的矛盾。
10. **不**制造 “JSON authorized/null 但 Web policy 行 denied/unknown” 的双重真相矛盾。
11. 全量 `npm test` GREEN；`git diff --check` clean。

---

## 实现后报告模板（给 agent）

完成实现后只报告：

1. 修改文件列表（相对 a088630）
2. Focused + full test 结果摘要
3. Side-effect / sensitive scan 结果（仅 count）
4. 明确声明：
   - wiring 6/0 pure contracts ready
   - `runnerWiringContractReady` / `realRunnerWiringReady` / `executionEligible` / Gold **仍 false/blocked**
   - ready path policy **authorized**（JSON primary null；Web policy 行 `primaryBlocker:none`），**非** Web forced-denied
   - Web `executionSentinel` 恒 blocked + `real-guarded-runner-execution-wiring-missing`
   - gate primary 信号仍 `real-guarded-runner-execution-wiring-missing`
   - `codeOwnedResolverWired` = decision 来源路径标识；`codeOwnedRecoveryResolverReady` = readiness
   - 无真实 recovery / host mutation / Gold 发布
5. **不要** commit / push（除非用户另行明确要求）
