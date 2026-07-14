# V1.27 Supervisor Lifecycle Rollback Anchor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace V1.20 disabled rollback anchor stub with a code-owned pure fail-closed **restricted pure data** rollback-anchor resolver/readiness contract; mark `rollback-anchor` required contract ready; keep real rollback write/restore, real host mutation, and Gold blocked.

**Architecture:** Add `resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(candidates, operation)` as the only anchor resolve path. Convert readiness to fixed ready evidence (`codeOwnedAnchorResolverReady:true`, keep `realRollbackAnchorImplementationReady:false`). Gate calls resolver only with production-derived sanitized `actionCandidates` + allowlisted `operation`, attaches sanitized `anchorDecision` (field `codeOwnedResolverWired:true`), derives local `rollbackAnchorReady` into policy. Wiring → `readyCount:4` / `blockedCount:2`. Two downstream contracts remain blocked → policy denies with primary `attempt-audit-not-ready`; side-effect flags stay false. Web uses **strict canonical fail-closed assembly**. Pure data plan ready must never be treated as real write/restore or host mutation. Layer clearly with V1.26 adapter (independent trust boundary; does not read adapterDecision).

**Tech Stack:** Node.js ESM, `node:test`, existing Web Console view model helpers, README/Gold static scorecard tests.

**Spec:** `docs/superpowers/specs/2026-07-14-supervisor-lifecycle-rollback-anchor-design.md`

**Recovery anchor:** `8e89403`

## Global Constraints

- Current release version becomes `V1.27`.
- Do not add endpoint, CLI command, Web button, or request body field.
- Do not modify `src/agent.js`, `src/server.js`, or `package.json`.
- Do not accept request/CLI `anchorDecision` / `anchorContext` / `rollbackAnchorReady` overrides.
- Do not call host shell / process-control / process list / filesystem / metadata / audit / approval writes / NAS / backup / restore / remote / network / launchctl.
- Do not write or restore real rollback anchors.
- Do not schedule, dispatch, or invoke runners; do not return functions/commands/paths/hosts/tokens/hashes/raw errors.
- Do not set `realRollbackAnchorImplementationReady:true`, `wouldWriteAnchor:true`, `wouldRestore:true`, or any `*Allowed:true`.
- Do not set `realHostMutationImplementationReady:true` or `wouldMutateHost:true` (V1.26 remains false).
- Production path: `policyDecision` always denied; `executionEligible:false`; Gold `blocked`.
- G0a real two-Mac PASS statements stay unchanged.
- Malicious fixtures use **opaque synthetic strings only** (`UNSAFE_SECRET_MATERIAL`, `OPAQUE_UNSAFE_FIELD`).
- Sensitive scans report **category hit counts only**.
- Do **not** change V1.24 `areSupervisorLifecycleGuardedRunnerActionCandidatesReady` maxAttempts contract.
- Do **not** change V1.25 registry resolver catalog / redacted maxAttempts contract.
- Do **not** change V1.26 adapter resolver mutation map / unsafe contract.
- Blocker vocabulary **excludes** `rollback-anchor-operation-mismatch`, `rollback-anchor-action-extra`, `rollback-anchor-implementation-mismatch`, `rollback-anchor-kind-mismatch`, `rollback-anchor-adapter-not-ready`.
- This planning phase must not modify `src/`, `test/`, `README.md`, `package*`, or version files; implementation phase follows this plan.
- Do **not** create `actual-changes.txt`. Do **not** use `git reset --hard` as a routine recovery step in this plan.

### 固定字段 vs 动态 fact（禁止混淆）

| 名称 | 类型 | V1.27 语义 |
| --- | --- | --- |
| `rollbackAnchorReadiness.rollbackAnchorReady` | **固定** readiness 输出 | 恒 `true`（builder 无参） |
| `gates.rollbackAnchorReady` | **动态** gate fact | readiness ∧ anchorDecision 严格本地 boolean；合法 install fixtures → true；empty candidates → false |
| `anchorDecision.anchorReady` | **动态** decision 字段 | resolved 时 true；unresolved 时 false |
| `validationLines` 中的 `rollbackAnchorReady` | **动态** Web 派生 | **仅** `canonicalRollbackAnchorReady`；禁止直接抄 `gates.*` |
| `wouldWriteAnchor` / `wouldRestore` / `*Allowed` / `realRollbackAnchorImplementationReady` | **固定 false** | 任意 locus 恒 false |
| `executionEligible` / gate 顶层 `wouldExecute` | **固定 false** | 恒 false |
| `gates.hostMutationAdapterReady` / `gates.runnerRegistryReady` | **动态**（V1.26/V1.25 语义） | **不回退** |

---

### Task 1: Pure Resolver + Ready Anchor Readiness Contract

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

**Interfaces:**
- `resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(candidates, operation): object`
- `buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness(): object` (ready)
- `runnerWiringContract.requiredContracts[3].status:'ready'`
- gate later wires `anchorDecision` + `gates.rollbackAnchorReady`
- wiring `readyCount:4` / `blockedCount:2`

- [ ] **Step 1: Write the failing pure tests (RED)**

Update imports:

```js
import {
  // existing...
  resolveSupervisorLifecycleGuardedRunnerRollbackAnchor,
  buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness,
  resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter,
  buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness,
  resolveSupervisorLifecycleGuardedRunnerRegistry,
  buildSupervisorLifecycleGuardedRunnerRegistryReadiness,
  areSupervisorLifecycleGuardedRunnerActionCandidatesReady,
  buildSupervisorLifecycleApplyPlan, // 用于核验 OPERATION_EXPECTED_ACTION_IDS 与 buildLifecycleActions 一致
} from '../src/supervisor-lifecycle.js';
```

Fixtures:

```js
const EXPECTED_WIRING_CONTRACTS = Object.freeze([
  ['execution-policy', null, 'ready', 'execution-policy-ready'],
  ['runner-registry', null, 'ready', 'runner-registry-ready'],
  ['host-mutation-adapter', null, 'ready', 'host-mutation-adapter-ready'],
  ['rollback-anchor', null, 'ready', 'rollback-anchor-ready'],
  ['attempt-audit', 'attempt-audit-missing', 'blocked', 'attempt-audit-missing'],
  ['operator-recovery', 'operator-recovery-missing', 'blocked', 'operator-recovery-missing'],
]);

// Exact schema 对齐 spec §2.4：
// - 唯一 real-* 字段：realRollbackAnchorImplementationReady（恒 false）
// - 不得含 realImplementationReady / sensitiveValuesReturned / realRollbackAnchorReady
const EXPECTED_ROLLBACK_ANCHOR_ENTRIES = Object.freeze([
  {
    anchorKind: 'code-owned-rollback-anchor',
    state: 'ready',
    codeOwnedResolverWired: true,
    realRollbackAnchorImplementationReady: false,
    wouldWriteAnchor: false,
    wouldRestore: false,
    wouldExecute: false,
    wouldRun: false,
    wouldWrite: false,
    filesystemWriteAllowed: false,
    metadataWriteAllowed: false,
    rollbackAnchorWriteAllowed: false,
    rollbackRestoreAllowed: false,
    blockerCode: null,
    evidenceCode: 'rollback-anchor-ready',
  },
]);

const CODE_OWNED_ACTION_ANCHOR_MAP = Object.freeze({
  'render-launch-agent-plist': 'render-plist-anchor',
  'write-launch-agent-plist': 'write-plist-anchor',
  'load-launch-agent': 'load-agent-anchor',
  'unload-launch-agent': 'unload-agent-anchor',
  'remove-launch-agent-plist': 'remove-plist-anchor',
  'remove-supervisor-metadata': 'remove-metadata-anchor',
  'capture-current-state': 'capture-state-anchor',
  'restore-previous-plist': 'restore-plist-anchor',
  'restart-previous-supervisor': 'restart-supervisor-anchor',
  'start-recovery-supervisor': 'recovery-supervisor-anchor',
});

// Reuse V1.25 registry + V1.26 mutation maps for shared candidate fixtures:
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
// 不变量（每个 allowlisted operation 必须测试断言；经公开 apply plan 路径间接核验，
// 因 buildLifecycleActions 为模块内函数，plan.actions 由其派生）：
//   deepStrictEqual(
//     OPERATION_EXPECTED_ACTION_IDS[operation],
//     buildSupervisorLifecycleApplyPlan({}, { operation }).actions.map((a) => a.id),
//   )
// 生产 resolver 内 expected set **必须** 直接调用 buildLifecycleActions，不得另写可漂移列表。
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

Helpers（**必须**定义并使用；禁止模糊引用）：

```js
function validAnchorCandidate(actionId, maxAttempts = 1) {
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

function validAnchorCandidatesFor(operation) {
  return OPERATION_EXPECTED_ACTION_IDS[operation].map((id) => validAnchorCandidate(id, 1));
}

/**
 * assertAnchorUnresolvedExact：第三参 operation **必传**，禁止默认 `'unknown'`。
 * - typeof operation === 'string' 且 decision.operation === operation（严格全等）
 * - 合法 install/uninstall/rollback/recover 输入上的 **任意** unresolved：第三参传对应合法 operation
 * - **仅** invalid operation 传 expected output `'unknown'`
 */
function assertAnchorUnresolvedExact(decision, primaryBlocker, operation) {
  assert.strictEqual(typeof operation, 'string');
  assert.strictEqual(typeof primaryBlocker, 'string');
  assert.strictEqual(decision.command, 'supervisor-lifecycle-guarded-runner-rollback-anchor');
  assert.strictEqual(decision.operation, operation);
  assert.strictEqual(decision.state, 'unresolved');
  assert.strictEqual(decision.anchorReady, false);
  assert.strictEqual(decision.codeOwnedResolverWired, true);
  assert.strictEqual(decision.realRollbackAnchorImplementationReady, false);
  assert.strictEqual(decision.wouldWriteAnchor, false);
  assert.strictEqual(decision.wouldRestore, false);
  assert.strictEqual(decision.wouldExecute, false);
  assert.strictEqual(decision.wouldRun, false);
  assert.strictEqual(decision.wouldWrite, false);
  assert.strictEqual(decision.filesystemWriteAllowed, false);
  assert.strictEqual(decision.metadataWriteAllowed, false);
  assert.strictEqual(decision.rollbackAnchorWriteAllowed, false);
  assert.strictEqual(decision.rollbackRestoreAllowed, false);
  assert.strictEqual(decision.resolvedCount, 0);
  assert.strictEqual(decision.unresolvedCount, 0);
  assert.deepStrictEqual(decision.anchors, []);
  assert.deepStrictEqual(decision.blockers, [primaryBlocker]);
  assert.strictEqual(decision.primaryBlocker, primaryBlocker);
  assert.deepStrictEqual(decision.nextBlockers, [primaryBlocker]);
  assert.strictEqual(decision.sensitiveValuesReturned, false);
}

function assertAnchorResolved(decision, operation) {
  const expected = OPERATION_EXPECTED_ACTION_IDS[operation];
  assert.strictEqual(decision.command, 'supervisor-lifecycle-guarded-runner-rollback-anchor');
  assert.strictEqual(decision.operation, operation);
  assert.strictEqual(decision.state, 'resolved');
  assert.strictEqual(decision.anchorReady, true);
  assert.strictEqual(decision.codeOwnedResolverWired, true);
  assert.strictEqual(decision.realRollbackAnchorImplementationReady, false);
  assert.strictEqual(decision.wouldWriteAnchor, false);
  assert.strictEqual(decision.wouldRestore, false);
  assert.strictEqual(decision.wouldExecute, false);
  assert.strictEqual(decision.wouldRun, false);
  assert.strictEqual(decision.wouldWrite, false);
  assert.strictEqual(decision.filesystemWriteAllowed, false);
  assert.strictEqual(decision.metadataWriteAllowed, false);
  assert.strictEqual(decision.rollbackAnchorWriteAllowed, false);
  assert.strictEqual(decision.rollbackRestoreAllowed, false);
  assert.strictEqual(decision.resolvedCount, expected.length);
  assert.strictEqual(decision.unresolvedCount, 0);
  assert.strictEqual(decision.primaryBlocker, null);
  assert.deepStrictEqual(decision.blockers, []);
  assert.deepStrictEqual(decision.nextBlockers, []);
  assert.strictEqual(decision.sensitiveValuesReturned, false);
  assert.strictEqual(decision.anchors.length, expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    const row = decision.anchors[i];
    assert.strictEqual(row.actionId, expected[i]);
    assert.strictEqual(row.anchorKind, CODE_OWNED_ACTION_ANCHOR_MAP[expected[i]]);
    assert.strictEqual(row.anchorReady, true);
    assert.strictEqual(row.realRollbackAnchorImplementationReady, false);
    assert.strictEqual(row.wouldWriteAnchor, false);
    assert.strictEqual(row.wouldRestore, false);
    assert.strictEqual(row.wouldExecute, false);
    assert.strictEqual(row.wouldRun, false);
    assert.strictEqual(row.wouldWrite, false);
    assert.strictEqual(row.filesystemWriteAllowed, false);
    assert.strictEqual(row.metadataWriteAllowed, false);
    assert.strictEqual(row.rollbackAnchorWriteAllowed, false);
    assert.strictEqual(row.rollbackRestoreAllowed, false);
    assert.strictEqual(row.blockerCode, null);
    assert.strictEqual(row.evidenceCode, 'rollback-anchor-plan-ready');
  }
}
```

Pure matrix（必须全部 RED 先写）：

| ID | Case | Expected primary |
| --- | --- | --- |
| A1 | install happy path | resolved |
| A2 | uninstall happy path | resolved |
| A3 | rollback happy path | resolved |
| A4 | recover happy path | resolved |
| A5 | non-array / null candidates | `rollback-anchor-candidates-invalid` |
| A6 | install subset len=2 (valid shape) | `rollback-anchor-action-missing` |
| A7 | empty array | `rollback-anchor-candidates-invalid` |
| A8 | extra own key on element | `rollback-anchor-candidates-invalid` |
| A9 | missing own key on element | `rollback-anchor-candidates-invalid` |
| A10 | getter / accessor property | `rollback-anchor-candidates-invalid` |
| A11 | Proxy trap throw on ownKeys | `rollback-anchor-candidates-invalid` |
| A12 | wouldExecute true after exact set | `rollback-anchor-unsafe-anchor` |
| A13 | wouldRun true | `rollback-anchor-unsafe-anchor` |
| A14 | wouldWrite true | `rollback-anchor-unsafe-anchor` |
| A15 | status ≠ blocked | `rollback-anchor-unsafe-anchor` |
| A16 | non-empty string actionId unknown after shape ok | `rollback-anchor-action-unknown` |
| A17 | invalid operation (non-string / not allowlisted) | `rollback-anchor-operation-invalid`；`operation:'unknown'` |
| A18 | duplicate actionId | `rollback-anchor-action-duplicate` |
| A19 | non-catalog implementationId still resolved | resolved（ignore value） |
| A20 | maxAttempts `'[redacted]'` still resolved | resolved（ignore value） |
| A21 | post-call input mutation does not change decision | deep-copy |
| A22 | returned decision mutation does not pollute next call | deep-copy |
| A23 | len>\|E\| + unknown action (no dup) | `rollback-anchor-action-unknown` |
| A24 | len>\|E\| + duplicate | `rollback-anchor-action-duplicate` |
| A25 | snapshot 后 actionId 非非空 string（含 `''`） | **唯一** `rollback-anchor-candidates-invalid` |
| A26 | primary priority：duplicate before unknown | duplicate wins when both present |
| A27 | non-catalog + redacted：anchor resolved **and** adapter resolved **and** registry unresolved（分层） | intentional |

Readiness tests:

```js
it('OPERATION_EXPECTED_ACTION_IDS matches buildLifecycleActions via apply plan actions', () => {
  // buildLifecycleActions 未 export；apply plan.actions 由其派生，顺序 + 成员 exact 一致
  for (const operation of ['install', 'uninstall', 'rollback', 'recover']) {
    assert.deepStrictEqual(
      OPERATION_EXPECTED_ACTION_IDS[operation],
      buildSupervisorLifecycleApplyPlan({}, { operation }).actions.map((a) => a.id),
    );
  }
});

it('buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness returns fixed ready pure data evidence', () => {
  const readiness = buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness();
  assert.strictEqual(readiness.command, 'supervisor-lifecycle-guarded-runner-rollback-anchor-readiness');
  assert.strictEqual(readiness.state, 'ready');
  assert.strictEqual(readiness.rollbackAnchorDefined, true);
  assert.strictEqual(readiness.rollbackAnchorReady, true);
  assert.strictEqual(readiness.codeOwnedAnchorResolverReady, true);
  assert.strictEqual(readiness.realRollbackAnchorImplementationReady, false);
  assert.strictEqual(readiness.readyCount, 1);
  assert.strictEqual(readiness.blockedCount, 0);
  assert.deepStrictEqual(readiness.anchorEntries, EXPECTED_ROLLBACK_ANCHOR_ENTRIES);
  assert.deepStrictEqual(readiness.blockers, []);
  assert.deepStrictEqual(readiness.nextBlockers, []);
  assert.strictEqual(readiness.safety.sensitiveValuesReturned, false);
  // 旧键 / 重叠别名 / entry 级 sensitive 键不得残留（spec §2.3 / §2.4）
  assert.strictEqual(Object.hasOwn(readiness, 'realRollbackAnchorReady'), false);
  assert.strictEqual(Object.hasOwn(readiness, 'realImplementationReady'), false);
  assert.strictEqual(Object.hasOwn(readiness, 'sensitiveValuesReturned'), false);
  const entry = readiness.anchorEntries[0];
  assert.strictEqual(Object.hasOwn(entry, 'realImplementationReady'), false);
  assert.strictEqual(Object.hasOwn(entry, 'sensitiveValuesReturned'), false);
  assert.strictEqual(Object.hasOwn(entry, 'realRollbackAnchorReady'), false);
  assert.strictEqual(entry.realRollbackAnchorImplementationReady, false);
});
```

Wiring contract expectations in shared gate helper fixture:

```js
// V1.27 aggregate：4 ready / 2 blocked（历史 3/3 已废止）
assert.strictEqual(contract.readyCount, 4);
assert.strictEqual(contract.blockedCount, 2);
// contract[3] rollback-anchor → ready/null/rollback-anchor-ready
// contract.slice(4) → attempt-audit / operator-recovery blocked
```

- [ ] **Step 2: Run pure tests — expect RED**

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

Expected: **RED**（fixture/helper 已写 V1.27 期望，实现未就绪）。

- [ ] **Step 3: Implement pure resolver + ready readiness (GREEN)**

In `src/supervisor-lifecycle.js`:

1. Constants：
   - `ROLLBACK_ANCHOR_READY_EVIDENCE = 'rollback-anchor-ready'`
   - `ROLLBACK_ANCHOR_PLAN_READY_EVIDENCE = 'rollback-anchor-plan-ready'`
   - `CODE_OWNED_ROLLBACK_ANCHOR_KIND = 'code-owned-rollback-anchor'`
   - `ROLLBACK_ANCHOR_BLOCKER_CODES`（6 码）
   - `CODE_OWNED_ACTION_ANCHOR_MAP`（10 项）
   - `ROLLBACK_ANCHOR_KIND_ALLOWLIST`
2. 重命名 readiness 字段：`realRollbackAnchorReady` → `realRollbackAnchorImplementationReady`（全文件 + 测试）；**删除** entry/decision/anchor 行上的 `realImplementationReady` 别名（不得残留）
3. Replace `GUARDED_RUNNER_DISABLED_ROLLBACK_ANCHOR_ENTRY` with ready entry（见 spec §2.4 exact keys；**不含** `sensitiveValuesReturned` / `realImplementationReady`）
4. Update `GUARDED_RUNNER_WIRING_CONTRACTS[3]`（rollback-anchor）→ ready + null blocker + evidenceCode ready
5. Update wiring aggregate：`readyCount:4` / `blockedCount:2`
6. Implement `resolveSupervisorLifecycleGuardedRunnerRollbackAnchor`（spec §1 全序评估；expected action set **必须** 由 `buildLifecycleActions(operation).map(a => a.id)` 派生，与 `OPERATION_EXPECTED_ACTION_IDS` deep-equal）
7. Implement `sanitizeRollbackAnchorDecision`
8. Convert `buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness` → ready builder（exact keys 见 spec §2.2）
9. **Do not yet** wire gate fact（Task 2）若测试结构允许分步；否则 Task 1+2 可合并但仍先 RED 全写

评估顺序硬编码（不可重排）：

1. operation-invalid
2. candidates-invalid（shape/trap/empty/non-string actionId）
3. action-duplicate
4. action-unknown
5. action-missing
6. unsafe-anchor

All-or-nothing：unresolved 恒 `anchors:[]`、`resolvedCount:0`、`unresolvedCount:0`。

- [ ] **Step 4: Re-run pure tests — expect GREEN for pure/readiness/wiring fixture parts**

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

---

### Task 2: Gate Wiring — local `rollbackAnchorReady` + `anchorDecision` + policy

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

- [ ] **Step 1: RED gate assertions**

Production path expectations:

```js
// Ignore options.anchorDecision / options.rollbackAnchorReady / options.anchorContext.
const anchorDecision = sanitizeRollbackAnchorDecision(
  resolveSupervisorLifecycleGuardedRunnerRollbackAnchor(actionCandidates, operation),
);

const rollbackAnchorReadiness = runnerWiringContract.rollbackAnchorReadiness;
const rollbackAnchorReady =
  rollbackAnchorReadiness?.rollbackAnchorReady === true &&
  rollbackAnchorReadiness?.codeOwnedAnchorResolverReady === true &&
  rollbackAnchorReadiness?.state === 'ready' &&
  rollbackAnchorReadiness?.realRollbackAnchorImplementationReady === false &&
  anchorDecision?.anchorReady === true &&
  anchorDecision?.state === 'resolved' &&
  anchorDecision?.codeOwnedResolverWired === true &&
  anchorDecision?.realRollbackAnchorImplementationReady === false &&
  anchorDecision?.wouldWriteAnchor === false &&
  anchorDecision?.wouldRestore === false &&
  anchorDecision?.wouldExecute === false &&
  anchorDecision?.wouldRun === false &&
  anchorDecision?.wouldWrite === false &&
  anchorDecision?.filesystemWriteAllowed === false &&
  anchorDecision?.metadataWriteAllowed === false &&
  anchorDecision?.rollbackAnchorWriteAllowed === false &&
  anchorDecision?.rollbackRestoreAllowed === false;
```

Gate matrix:

| ID | Setup | gates.rollbackAnchorReady | gates.hostMutationAdapterReady | gates.runnerRegistryReady | policy primary |
| --- | --- | --- | --- | --- | --- |
| G1 | ready install + executeRequested | true | true | true | `attempt-audit-not-ready`；**不含** `rollback-anchor-not-ready` |
| G2 | ready install + executeRequested false | true | true | true | 上游或 `attempt-audit-not-ready`；anchor fact 仍 true |
| G3 | missing runnerBinding / empty candidates | false | false | false | 含 not-ready 族 |
| G4 | non-catalog implementationId binding | true | true | **false** | 含 `runner-registry-not-ready`；**不含** `rollback-anchor-not-ready` / `host-mutation-adapter-not-ready` |
| G5 | redacted maxAttempts binding | true | true | **false** | 含 `runner-registry-not-ready` |
| G6 | options override `rollbackAnchorReady:true` + fake anchorDecision | 仍由 production 决定 | 不变 | 不变 | override 无效；合法 path 仍 deny + `attempt-audit-not-ready` |
| G7 | gate 顶层 | `executionEligible:false` / `wouldExecute:false` 恒成立 | | | |
| G8 | adapterDecision 仍存在且 V1.26 flags false | — | true | true | 不回归 |

Shared gate helper update:

```js
function assertBlockedGateShape(result, {
  runnerRegistryReady,
  hostMutationAdapterReady,
  rollbackAnchorReady,
}) {
  assert.strictEqual(typeof runnerRegistryReady, 'boolean');
  assert.strictEqual(typeof hostMutationAdapterReady, 'boolean');
  assert.strictEqual(typeof rollbackAnchorReady, 'boolean');
  assert.strictEqual(result.executionEligible, false);
  assert.strictEqual(result.wouldExecute, false);
  assert.strictEqual(result.gates.runnerRegistryReady, runnerRegistryReady);
  assert.strictEqual(result.gates.hostMutationAdapterReady, hostMutationAdapterReady);
  assert.strictEqual(result.gates.rollbackAnchorReady, rollbackAnchorReady);
  assert.strictEqual(result.gates.attemptAuditReady, false);
  assert.strictEqual(result.gates.operatorRecoveryReady, false);
  assert.strictEqual(result.runnerWiringContract.readyCount, 4);
  assert.strictEqual(result.runnerWiringContract.blockedCount, 2);
  // readiness ready entry + contract[3] ready...
  // policyDecision.state === 'denied'; would* false
  // result 必须含 anchorDecision
}
```

- [ ] **Step 2: Implement gate wiring (GREEN)**

1. Call resolver only with production candidates + operation
2. Attach `anchorDecision` to gate output
3. Derive local `rollbackAnchorReady` boolean（strict conjunction）
4. Put into `policyContext.rollbackAnchorReady`（不再 hardcode false）
5. Keep `attemptAuditReady:false` / `operatorRecoveryReady:false`
6. Keep `executionEligible:false` / `wouldExecute:false`
7. Ignore caller overrides
8. Keep V1.25 registry + V1.26 adapter predicates intact

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

- [ ] **Step 1: 改造两个共用 helper 本体 + fixture（RED 期望对齐 V1.27）**

```js
function assertBlockedExecutionGate(body, {
  runnerRegistryReady,
  hostMutationAdapterReady,
  rollbackAnchorReady,
}) {
  assert.strictEqual(typeof runnerRegistryReady, 'boolean');
  assert.strictEqual(typeof hostMutationAdapterReady, 'boolean');
  assert.strictEqual(typeof rollbackAnchorReady, 'boolean');

  assert.strictEqual(body.executionEligible, false);
  assert.strictEqual(body.wouldExecute, false);
  assert.strictEqual(body.gates.runnerRegistryReady, runnerRegistryReady);
  assert.strictEqual(body.gates.hostMutationAdapterReady, hostMutationAdapterReady);
  assert.strictEqual(body.gates.rollbackAnchorReady, rollbackAnchorReady);
  assert.strictEqual(body.gates.attemptAuditReady, false);
  assert.strictEqual(body.gates.operatorRecoveryReady, false);

  assert.strictEqual(body.runnerWiringContract.readyCount, 4);
  assert.strictEqual(body.runnerWiringContract.blockedCount, 2);

  const contracts = body.runnerWiringContract.requiredContracts;
  assert.strictEqual(contracts[3].id, 'rollback-anchor');
  assert.strictEqual(contracts[3].status, 'ready');
  assert.strictEqual(contracts[3].blockerCode, null);
  assert.strictEqual(contracts[3].evidenceCode, 'rollback-anchor-ready');
  for (const c of contracts.slice(4)) {
    assert.strictEqual(c.status, 'blocked');
  }

  const readiness = body.runnerWiringContract.rollbackAnchorReadiness;
  assert.strictEqual(readiness.state, 'ready');
  assert.strictEqual(readiness.rollbackAnchorReady, true);
  assert.strictEqual(readiness.codeOwnedAnchorResolverReady, true);
  assert.strictEqual(readiness.realRollbackAnchorImplementationReady, false);

  assert.strictEqual(body.policyDecision.state, 'denied');
  assert.strictEqual(body.policyDecision.wouldRun, false);
  assert.strictEqual(body.policyDecision.wouldWrite, false);

  assert.ok(body.anchorDecision);
  assert.strictEqual(body.anchorDecision.codeOwnedResolverWired, true);
  assert.strictEqual(body.anchorDecision.realRollbackAnchorImplementationReady, false);
  assert.strictEqual(body.anchorDecision.wouldWriteAnchor, false);
  assert.strictEqual(body.anchorDecision.wouldRestore, false);
}
```

**调用点矩阵（API + CLI 对称）：**

| 场景 | runnerRegistryReady | hostMutationAdapterReady | rollbackAnchorReady | 专属断言 |
| --- | --- | --- | --- | --- |
| valid ready path | true | true | true | `policyDecision.primaryBlocker === 'attempt-audit-not-ready'`；blockers 不含 `rollback-anchor-not-ready`；`anchorDecision.state==='resolved'`；`anchorDecision.anchorReady===true` |
| executeRequested false | true | true | true | anchor fact 仍 true |
| missing runnerBinding | false | false | false | unresolved candidates 族 |
| non-catalog implementationId | false | true | true | 含 `runner-registry-not-ready`；不含 anchor/adapter not-ready |
| redacted maxAttempts | false | true | true | 同上 |
| override body fields（若现有用例有 options 路径） | production 决定 | production 决定 | production 决定 | override 无效 |

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

- [ ] **Step 1: RED Web tests**

1. 从 `WIRING_CONTRACT_CANONICAL_MISSING_BLOCKERS` 移除 `rollback-anchor`（只留 attempt-audit / operator-recovery）。
2. 新增 `isCanonicalRollbackAnchorReady` / `resolveCanonicalRollbackAnchorReady`（C∧A∧G∧D）。
3. Wiring line：ready 仅当 canonical true；否则 fixed `rollback-anchor-missing`。
4. Anchor line：ready/blocked fixed strings（spec §5.2）；禁止 `disabled-rollback-anchor-stub` 正常路径。
5. validationLines：`rollbackAnchorReady` 仅 canonical。
6. 恶意 payload：`wouldWriteAnchor:true` / `wouldRestore:true` / secret anchorKind → 全部 blocked，不泄漏。
7. C/A/G 表面 ready + D side-effect drift → 全部 blocked。
8. 保持 registry/adapter 独立 canonical 不回归。
9. policyDecision 强制 denied；ready path primary 展示 `attempt-audit-not-ready`（allowlist 透传）。

Ready line exact:

```text
rollbackAnchor:code-owned-rollback-anchor:state:ready:codeOwnedResolverWired:true:realRollbackAnchorImplementationReady:false:wouldWriteAnchor:false:wouldRestore:false:blocker:none
```

Blocked line exact:

```text
rollbackAnchor:code-owned-rollback-anchor:state:blocked:codeOwnedResolverWired:true:realRollbackAnchorImplementationReady:false:wouldWriteAnchor:false:wouldRestore:false:blocker:rollback-anchor-not-ready
```

- [ ] **Step 2: Implement Web assembly (GREEN)**

```js
function isCanonicalRollbackAnchorReady({ C, A, G, D }) {
  return (
    C?.status === 'ready' &&
    C?.blockerCode === null &&
    C?.evidenceCode === 'rollback-anchor-ready' &&
    C?.requiredForExecution === true &&
    A?.state === 'ready' &&
    A?.rollbackAnchorReady === true &&
    A?.codeOwnedAnchorResolverReady === true &&
    A?.realRollbackAnchorImplementationReady === false &&
    G === true &&
    D?.state === 'resolved' &&
    D?.anchorReady === true &&
    D?.codeOwnedResolverWired === true &&
    D?.realRollbackAnchorImplementationReady === false &&
    D?.wouldWriteAnchor === false &&
    D?.wouldRestore === false &&
    D?.wouldExecute === false &&
    D?.wouldRun === false &&
    D?.wouldWrite === false &&
    D?.filesystemWriteAllowed === false &&
    D?.metadataWriteAllowed === false &&
    D?.rollbackAnchorWriteAllowed === false &&
    D?.rollbackRestoreAllowed === false
  );
}
```

Wire into `buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel`：

- resolve canonical boolean once
- pass into wiring lines builder
- use for anchor lines + validationLines
- keep attempt-audit / operator-recovery fixed blocked

- [ ] **Step 3: Run Web tests**

```bash
node --test --test-reporter=spec test/web-console.test.js
```

---

### Task 5: Version / README / Gold

**Files:**
- Modify: `src/version.js`
- Modify: `README.md`
- Modify: `src/gold-readiness.js`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js`

- [ ] **Step 1: RED version/README/Gold expectations**

- `LINKE_RELEASE_VERSION === 'V1.27'`
- README 标题 / badge / version table：V1.27 当前；V1.26 历史
- Gold evidence 包含：
  - `resolveSupervisorLifecycleGuardedRunnerRollbackAnchor`
  - `rollbackAnchorReadiness.state:ready`
  - `rollbackAnchorReady:true`
  - `codeOwnedAnchorResolverReady:true`
  - `codeOwnedResolverWired`
  - `rollback-anchor-ready`
  - `realRollbackAnchorImplementationReady:false`
  - `anchorDecision`
  - `readyCount:4`/`blockedCount:2`
- 当前缺口 **不再**以 `rollback-anchor-real-implementation-missing` / `rollback-anchor-missing` 作为 V1.27 主缺口（历史叙述可保留）
- `nextStep` 含 `attempt-audit`，并声明：
  - 真实 rollback anchor write/restore 仍缺失
  - 真实 host mutation implementation 仍缺失
- Gold 仍 `blocked`；G0a PASS 不变

- [ ] **Step 2: Implement version/README/Gold (GREEN)**

- [ ] **Step 3: Run focused version suite**

```bash
node --test --test-reporter=spec \
  test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

---

### Task 6: Full verification + side-effect / sensitive / scope scans

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

- [ ] **Step 2: Full suite**

```bash
npm test
```

- [ ] **Step 3: Side-effect scan（实现差分）**

```bash
git diff 8e89403 -- src/supervisor-lifecycle.js | rg -n \
  'launchctl|child_process|execSync|spawn\(|exec\(|fs\.(write|rm|unlink|mkdir)|process\.kill|net\.|http\.|https\.' \
  && echo 'FAIL: side-effect call pattern in diff' || echo 'ok: no side-effect pattern in lifecycle diff'
```

- [ ] **Step 4: Sensitive category count only**

```bash
git diff 8e89403 -- src/ test/ | rg -c \
  'ssh-rsa|BEGIN (RSA |OPENSSH )?PRIVATE|AKIA[0-9A-Z]{16}|[0-9a-f]{64}' \
  || true
# 期望：无命中；若有命中只报告 count，不得 cat 原文
```

- [ ] **Step 5: Scope / anchor 核对（无写入；不要 hard reset）**

```bash
git merge-base --is-ancestor 8e89403 HEAD && echo 'anchor-ok'
git diff --name-only 8e89403 --
git status --short
git diff --name-only 8e89403 -- src/agent.js src/server.js package.json
# 期望：禁止文件无输出
```

允许修改文件名必须 ⊆：

```text
src/supervisor-lifecycle.js
src/web/app.js
test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js
test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js
test/web-console.test.js
src/version.js
README.md
src/gold-readiness.js
test/version.test.js
test/gold-readiness.test.js
test/readme.test.js
```

另允许设计阶段已存在的 docs（若本实现 commit 不含 docs，亦可）：

```text
docs/superpowers/specs/2026-07-14-supervisor-lifecycle-rollback-anchor-design.md
docs/superpowers/plans/2026-07-14-supervisor-lifecycle-rollback-anchor.md
```

若 `npm test` 失败且涉及未列文件：先停，仅把 **rg 证实** 需要的文件补入允许列表。

### 预期不变量（验收表）

| 不变量 | 期望 |
| --- | --- |
| version | V1.27 |
| wiring ready/blocked | 4 / 2 |
| production `gates.rollbackAnchorReady` | true（ready install fixtures） |
| production `gates.hostMutationAdapterReady` | true |
| production `gates.runnerRegistryReady` | true（非 catalog 路径 false） |
| production policy | denied, primary `attempt-audit-not-ready` |
| gate 顶层 `executionEligible` / `wouldExecute` | false |
| `anchorDecision` wouldWriteAnchor / wouldRestore / *Allowed / would* | false |
| `realRollbackAnchorImplementationReady` | false |
| `realHostMutationImplementationReady` | false（不抬升） |
| Gold / G0a | blocked / PASS 不变 |
| agent/server/package | unmodified |

---

## Test Matrix Summary（实现必须覆盖）

### Pure resolver

| 类 | 覆盖 |
| --- | --- |
| Happy | install/uninstall/rollback/recover → resolved + exact anchor rows |
| Structure invalid | non-array, empty, extra/missing keys, getter, proxy trap, non-string actionId |
| Set mismatch | missing (len<\|E\|), unknown (len>\|E\|), duplicate (len>\|E\| 与 exact-len) |
| Unsafe | status≠blocked, wouldExecute/wouldRun/wouldWrite true |
| Layering | non-catalog impl / redacted maxAttempts → anchor resolved, registry unresolved |
| Priority | duplicate before unknown；operation-invalid only unknown operation |
| Deep copy | input mutation / output mutation isolation |
| All-or-nothing | unresolved anchors=[] counts 0/0 |

### Gate / API / CLI

| 类 | 覆盖 |
| --- | --- |
| Ready path | three facts true；primary=`attempt-audit-not-ready` |
| Empty candidates | three facts false |
| Independent facts | registry false + adapter true + anchor true |
| Override ignore | options/body cannot force anchor ready |
| Side-effect false | all locus would* / Allowed false；gate top-level executionEligible/wouldExecute false |

### Web

| 类 | 覆盖 |
| --- | --- |
| Canonical ready | C∧A∧G∧D 全真 → wiring/anchor/validation ready |
| Canonical blocked | 任一失败 → 三处 blocked 同源 |
| Side-effect drift | wouldWriteAnchor/wouldRestore/*Allowed true → blocked |
| Malicious payload | secret/stub kind 不泄漏 |
| Downstream fixed | attempt-audit / operator-recovery never ready from payload |
| No regression | registry/adapter canonical 仍独立 |

### Version / Gold / README

| 类 | 覆盖 |
| --- | --- |
| Version | V1.27 |
| Gold blocked | evidence 更新；nextStep → attempt-audit |
| G0a | PASS 声明不变 |

---

## Out of Scope（明确）

- 真实 rollback anchor write / restore
- 真实 host mutation implementation（V1.26 遗留）
- attempt-audit / operator-recovery 真实实现
- runner dispatch / launchctl / shell / fs / process / network
- 新增 endpoint / CLI command / Web button / request field
- 修改 `src/agent.js` / `src/server.js` / `package.json`
- 修改 V1.24 actionCandidates helper 契约
- 修改 V1.25 registry resolver 契约
- 修改 V1.26 adapter resolver 契约
- 把 `executionEligible` / Gold 变 ready

---

## Completion Criteria

1. pure resolver 存在；exact schema；allowlist blockers；all-or-nothing；deep copy；无副作用
2. 四 operation happy path resolved；wouldWriteAnchor/wouldRestore/*Allowed 全 false
3. 失败类单一 exact primary；A6/A23/A24/A25 覆盖长度不等式与非法 actionId
4. non-catalog / redacted 分层：anchor（与 adapter）可 resolved，registry unresolved
5. readiness + contract ready；`realRollbackAnchorImplementationReady:false`；`codeOwnedResolverWired`
6. wiring 4/2；后二 blocked；production deny；primary=`attempt-audit-not-ready`；各 locus 副作用 false；gate 顶层仅断言 `executionEligible`/`wouldExecute`
7. Web 共享 `canonicalRollbackAnchorReady`（C∧A∧G∧D）；恶意/side-effect 漂移不能 ready
8. Version V1.27；Gold blocked；G0a PASS；nextStep → attempt-audit + 声明真实 write/restore 与真实 host mutation 仍缺
9. 仅改允许列表；agent/server/package 未改；§ Task 6 scans 通过
10. 与 V1.26 adapter 分层清楚；caller override 无效

---

## 运行韧性（实现期）

**正常态：** production gate `rollbackAnchorReady:true`、`anchorDecision` resolved、`hostMutationAdapterReady:true`、`runnerRegistryReady:true`、`policyDecision` denied（primary=`attempt-audit-not-ready`）、`executionEligible:false`；wiring 4/2；Gold blocked。

**三支柱：**

1. **有界失效：** 畸形 candidates / unsafe would* / 恶意 Web payload → unresolved 或 blocked Web 行 / 强制 denied policy；不抛敏感 raw error。
2. **异常恢复：** 若发现 request 可非法把 `executionEligible` / `wouldExecute` / `rollbackAnchorReady` / `wouldWriteAnchor` / `wouldRestore` 变 true → 立即硬编码 false + pure-only 路径。
3. **状态侦测：** pure / gate / API / CLI / Web / version / README / Gold + `npm test` + 无写入 diff 核对。
