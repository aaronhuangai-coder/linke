# V1.28 Supervisor Lifecycle Attempt Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace V1.21 disabled attempt audit stub with a code-owned pure fail-closed **restricted pure data** attempt-audit resolver/readiness contract; mark `attempt-audit` required contract ready; keep real audit persist/log, real host mutation, real rollback write/restore, `runnerWiringContractReady`, and Gold blocked.

**Architecture:** Add `resolveSupervisorLifecycleGuardedRunnerAttemptAudit(candidates, operation)` as the only attempt-audit resolve path. Convert readiness to fixed ready evidence (`codeOwnedAuditResolverReady:true`, keep `realAttemptAuditImplementationReady:false`). Gate calls resolver only with production-derived sanitized `actionCandidates` + allowlisted `operation`, attaches sanitized `auditDecision` (field `codeOwnedResolverWired:true`), derives local `attemptAuditReady` into policy. Wiring → `readyCount:5` / `blockedCount:1`. Final downstream contract remains blocked → policy denies with primary `operator-recovery-not-ready`; side-effect flags stay false. Web uses **strict canonical fail-closed assembly** (C∧A∧G∧D). Pure data plan ready must never be treated as real persist/log or host mutation. Layer clearly with V1.25–V1.27 (independent trust boundary; does not read mutationKind/anchorKind/registryDecision/adapterDecision/anchorDecision).

**Tech Stack:** Node.js ESM, `node:test`, existing Web Console view model helpers, README/Gold static scorecard tests.

**Spec:** `docs/superpowers/specs/2026-07-14-supervisor-lifecycle-attempt-audit-design.md`

**Recovery anchor:** `b42f57c`

## Global Constraints

- Current release version becomes `V1.28`.
- Do not add endpoint, CLI command, Web button, or request body field.
- Do not modify `src/agent.js`, `src/server.js`, or `package.json`.
- Do not accept request/CLI `auditDecision` / `auditContext` / `attemptAuditReady` overrides.
- Do not call host shell / process-control / process list / filesystem / metadata / audit / approval writes / NAS / backup / restore / remote / network / launchctl / `appendAuditEvent`.
- Do not persist real attempt audits or write real logs.
- Do not schedule, dispatch, or invoke runners; do not return functions/commands/paths/hosts/tokens/hashes/raw errors.
- Do not set `realAttemptAuditImplementationReady:true`, `wouldPersistAudit:true`, `wouldWriteLog:true`, `wouldWriteAudit:true`, `immutableAuditReady:true`, or any `*Allowed:true`.
- Do not set `realHostMutationImplementationReady:true` or `wouldMutateHost:true` (V1.26 remains false).
- Do not set `realRollbackAnchorImplementationReady:true`, `wouldWriteAnchor:true`, or `wouldRestore:true` (V1.27 remains false).
- Do not set `runnerWiringContractReady:true` or claim Gold ready.
- Production path: `policyDecision` always denied; `executionEligible:false`; Gold `blocked`.
- G0a real two-Mac PASS statements stay unchanged.
- Malicious fixtures use **opaque synthetic strings only** (`UNSAFE_SECRET_MATERIAL`, `OPAQUE_UNSAFE_FIELD`).
- Sensitive scans report **category hit counts only**.
- Do **not** change V1.24 `areSupervisorLifecycleGuardedRunnerActionCandidatesReady` maxAttempts contract.
- Do **not** change V1.25 registry resolver catalog / redacted maxAttempts contract.
- Do **not** change V1.26 adapter resolver mutation map / unsafe contract.
- Do **not** change V1.27 anchor resolver anchor map / unsafe contract.
- Blocker vocabulary **excludes** `attempt-audit-operation-mismatch`, `attempt-audit-action-extra`, `attempt-audit-implementation-mismatch`, `attempt-audit-kind-mismatch`, `attempt-audit-adapter-not-ready`, `attempt-audit-anchor-not-ready`.
- This planning phase must not modify `src/`, `test/`, `README.md`, `package*`, or version files; implementation phase follows this plan.
- Do **not** create `actual-changes.txt`. Do **not** use `git reset --hard` as a routine recovery step in this plan.

### 固定字段 vs 动态 fact（禁止混淆）

| 名称 | 类型 | V1.28 语义 |
| --- | --- | --- |
| `attemptAuditReadiness.attemptAuditReady` | **固定** readiness 输出 | 恒 `true`（builder 无参） |
| `gates.attemptAuditReady` | **动态** gate fact | readiness ∧ auditDecision 严格本地 boolean；合法 install fixtures → true；empty candidates → false |
| `auditDecision.auditReady` | **动态** decision 字段 | resolved 时 true；unresolved 时 false |
| `validationLines` 中的 `attemptAuditReady` | **动态** Web 派生 | **仅** `canonicalAttemptAuditReady`；禁止直接抄 `gates.*` |
| `wouldPersistAudit` / `wouldWriteLog` / `wouldWriteAudit` / `*Allowed` / `immutableAuditReady` / `realAttemptAuditImplementationReady` | **固定 false** | 任意 locus 恒 false |
| `executionEligible` / gate 顶层 `wouldExecute` / `runnerWiringContractReady` | **固定 false** | 恒 false |
| `gates.rollbackAnchorReady` / `hostMutationAdapterReady` / `runnerRegistryReady` | **动态**（V1.27/V1.26/V1.25 语义） | **不回退** |

---

### Task 1: Pure Resolver + Ready Attempt-Audit Readiness Contract

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

**Interfaces:**
- `resolveSupervisorLifecycleGuardedRunnerAttemptAudit(candidates, operation): object`
- `buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness(): object` (ready)
- `runnerWiringContract.requiredContracts[4].status:'ready'`
- gate later wires `auditDecision` + `gates.attemptAuditReady`
- wiring `readyCount:5` / `blockedCount:1`

- [ ] **Step 1: Write the failing pure tests (RED)**

Update imports:

```js
import {
  // existing...
  resolveSupervisorLifecycleGuardedRunnerAttemptAudit,
  buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness,
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
  ['attempt-audit', null, 'ready', 'attempt-audit-ready'],
  ['operator-recovery', 'operator-recovery-missing', 'blocked', 'operator-recovery-missing'],
]);

// Exact schema 对齐 spec §2.4：
// - 唯一 real-* 字段：realAttemptAuditImplementationReady（恒 false）
// - 不得含 realImplementationReady / sensitiveValuesReturned / realAttemptAuditReady
// - entry.auditKind='code-owned-attempt-audit' 为 catalog-level 汇总标识
//   （≠ audits[] 行 action-level auditKind，如 render-plist-attempt-audit）
const EXPECTED_ATTEMPT_AUDIT_ENTRIES = Object.freeze([
  {
    auditKind: 'code-owned-attempt-audit',
    state: 'ready',
    codeOwnedResolverWired: true,
    realAttemptAuditImplementationReady: false,
    wouldPersistAudit: false,
    wouldWriteLog: false,
    wouldWriteAudit: false,
    wouldExecute: false,
    wouldRun: false,
    wouldWrite: false,
    auditWriteAllowed: false,
    metadataWriteAllowed: false,
    filesystemWriteAllowed: false,
    immutableAuditReady: false,
    blockerCode: null,
    evidenceCode: 'attempt-audit-ready',
  },
]);

const CODE_OWNED_ACTION_AUDIT_MAP = Object.freeze({
  'render-launch-agent-plist': 'render-plist-attempt-audit',
  'write-launch-agent-plist': 'write-plist-attempt-audit',
  'load-launch-agent': 'load-agent-attempt-audit',
  'unload-launch-agent': 'unload-agent-attempt-audit',
  'remove-launch-agent-plist': 'remove-plist-attempt-audit',
  'remove-supervisor-metadata': 'remove-metadata-attempt-audit',
  'capture-current-state': 'capture-state-attempt-audit',
  'restore-previous-plist': 'restore-plist-attempt-audit',
  'restart-previous-supervisor': 'restart-supervisor-attempt-audit',
  'start-recovery-supervisor': 'recovery-supervisor-attempt-audit',
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
// 不变量（每个 allowlisted operation 必须测试断言；经公开 apply plan 路径间接核验）：
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
function validAuditCandidate(actionId, maxAttempts = 1) {
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

function validAuditCandidatesFor(operation) {
  return OPERATION_EXPECTED_ACTION_IDS[operation].map((id) => validAuditCandidate(id, 1));
}

/**
 * assertAuditUnresolvedExact：第三参 operation **必传**，禁止默认 `'unknown'`。
 * - typeof operation === 'string' 且 decision.operation === operation（严格全等）
 * - 合法 install/uninstall/rollback/recover 输入上的 **任意** unresolved：第三参传对应合法 operation
 * - **仅** invalid operation 传 expected output `'unknown'`
 */
function assertAuditUnresolvedExact(decision, primaryBlocker, operation) {
  assert.strictEqual(typeof operation, 'string');
  assert.strictEqual(typeof primaryBlocker, 'string');
  assert.strictEqual(decision.command, 'supervisor-lifecycle-guarded-runner-attempt-audit');
  assert.strictEqual(decision.operation, operation);
  assert.strictEqual(decision.state, 'unresolved');
  assert.strictEqual(decision.auditReady, false);
  assert.strictEqual(decision.codeOwnedResolverWired, true);
  assert.strictEqual(decision.realAttemptAuditImplementationReady, false);
  assert.strictEqual(decision.wouldPersistAudit, false);
  assert.strictEqual(decision.wouldWriteLog, false);
  assert.strictEqual(decision.wouldWriteAudit, false);
  assert.strictEqual(decision.wouldExecute, false);
  assert.strictEqual(decision.wouldRun, false);
  assert.strictEqual(decision.wouldWrite, false);
  assert.strictEqual(decision.auditWriteAllowed, false);
  assert.strictEqual(decision.metadataWriteAllowed, false);
  assert.strictEqual(decision.filesystemWriteAllowed, false);
  assert.strictEqual(decision.immutableAuditReady, false);
  assert.strictEqual(decision.resolvedCount, 0);
  assert.strictEqual(decision.unresolvedCount, 0);
  assert.deepStrictEqual(decision.audits, []);
  assert.deepStrictEqual(decision.blockers, [primaryBlocker]);
  assert.strictEqual(decision.primaryBlocker, primaryBlocker);
  assert.deepStrictEqual(decision.nextBlockers, [primaryBlocker]);
  assert.strictEqual(decision.sensitiveValuesReturned, false);
}

function assertAuditResolved(decision, operation) {
  const expected = OPERATION_EXPECTED_ACTION_IDS[operation];
  assert.strictEqual(decision.command, 'supervisor-lifecycle-guarded-runner-attempt-audit');
  assert.strictEqual(decision.operation, operation);
  assert.strictEqual(decision.state, 'resolved');
  assert.strictEqual(decision.auditReady, true);
  assert.strictEqual(decision.codeOwnedResolverWired, true);
  assert.strictEqual(decision.realAttemptAuditImplementationReady, false);
  assert.strictEqual(decision.wouldPersistAudit, false);
  assert.strictEqual(decision.wouldWriteLog, false);
  assert.strictEqual(decision.wouldWriteAudit, false);
  assert.strictEqual(decision.wouldExecute, false);
  assert.strictEqual(decision.wouldRun, false);
  assert.strictEqual(decision.wouldWrite, false);
  assert.strictEqual(decision.auditWriteAllowed, false);
  assert.strictEqual(decision.metadataWriteAllowed, false);
  assert.strictEqual(decision.filesystemWriteAllowed, false);
  assert.strictEqual(decision.immutableAuditReady, false);
  assert.strictEqual(decision.resolvedCount, expected.length);
  assert.strictEqual(decision.unresolvedCount, 0);
  assert.strictEqual(decision.primaryBlocker, null);
  assert.deepStrictEqual(decision.blockers, []);
  assert.deepStrictEqual(decision.nextBlockers, []);
  assert.strictEqual(decision.sensitiveValuesReturned, false);
  assert.strictEqual(decision.audits.length, expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    const row = decision.audits[i];
    assert.strictEqual(row.actionId, expected[i]);
    assert.strictEqual(row.auditKind, CODE_OWNED_ACTION_AUDIT_MAP[expected[i]]);
    assert.strictEqual(row.auditReady, true);
    assert.strictEqual(row.realAttemptAuditImplementationReady, false);
    assert.strictEqual(row.wouldPersistAudit, false);
    assert.strictEqual(row.wouldWriteLog, false);
    assert.strictEqual(row.wouldWriteAudit, false);
    assert.strictEqual(row.wouldExecute, false);
    assert.strictEqual(row.wouldRun, false);
    assert.strictEqual(row.wouldWrite, false);
    assert.strictEqual(row.auditWriteAllowed, false);
    assert.strictEqual(row.metadataWriteAllowed, false);
    assert.strictEqual(row.filesystemWriteAllowed, false);
    assert.strictEqual(row.immutableAuditReady, false);
    assert.strictEqual(row.blockerCode, null);
    assert.strictEqual(row.evidenceCode, 'attempt-audit-plan-ready');
  }
}
```

Pure matrix（必须全部 RED 先写）：

| ID | Case | Expected primary |
| --- | --- | --- |
| T1 | install happy path | resolved |
| T2 | uninstall happy path | resolved |
| T3 | rollback happy path | resolved |
| T4 | recover happy path | resolved |
| T5 | non-array / null candidates | `attempt-audit-candidates-invalid` |
| T6 | install subset len=2 (valid shape) | `attempt-audit-action-missing` |
| T7 | empty array | `attempt-audit-candidates-invalid` |
| T8 | extra own key on element | `attempt-audit-candidates-invalid` |
| T9 | missing own key on element | `attempt-audit-candidates-invalid` |
| T10 | getter / accessor property | `attempt-audit-candidates-invalid` |
| T11 | Proxy trap throw on ownKeys | `attempt-audit-candidates-invalid` |
| T12 | wouldExecute true after exact set | `attempt-audit-unsafe-audit` |
| T13 | wouldRun true | `attempt-audit-unsafe-audit` |
| T14 | wouldWrite true | `attempt-audit-unsafe-audit` |
| T15 | status ≠ blocked | `attempt-audit-unsafe-audit` |
| T16 | non-empty string actionId unknown after shape ok | `attempt-audit-action-unknown` |
| T17 | invalid operation (non-string / not allowlisted) | `attempt-audit-operation-invalid`；`operation:'unknown'` |
| T18 | duplicate actionId | `attempt-audit-action-duplicate` |
| T19 | non-catalog implementationId still resolved | resolved（ignore value） |
| T20 | maxAttempts `'[redacted]'` still resolved | resolved（ignore value） |
| T21 | post-call input mutation does not change decision | deep-copy |
| T22 | returned decision mutation does not pollute next call | deep-copy |
| T23 | len>\|E\| + unknown action (no dup) | `attempt-audit-action-unknown` |
| T24 | len>\|E\| + duplicate | `attempt-audit-action-duplicate` |
| T25 | snapshot 后 actionId 非非空 string（含 `''`） | **唯一** `attempt-audit-candidates-invalid` |
| T26 | primary priority：duplicate before unknown | duplicate wins when both present |
| T27 | non-catalog + redacted：audit resolved **and** anchor resolved **and** adapter resolved **and** registry unresolved（分层） | intentional |
| T28 | duplicate actionId **与** unsafe `wouldExecute:true` **同时**存在（合法 shape；至少一 actionId 重复，且至少一元素 `wouldExecute:true`） | **唯一** primary=`attempt-audit-action-duplicate`（**不得**落 `attempt-audit-unsafe-audit`；验证评估序 duplicate ≺ unsafe） |

Readiness tests:

```js
it('OPERATION_EXPECTED_ACTION_IDS matches buildLifecycleActions via apply plan actions', () => {
  for (const operation of ['install', 'uninstall', 'rollback', 'recover']) {
    assert.deepStrictEqual(
      OPERATION_EXPECTED_ACTION_IDS[operation],
      buildSupervisorLifecycleApplyPlan({}, { operation }).actions.map((a) => a.id),
    );
  }
});

it('buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness returns fixed ready pure data evidence', () => {
  const readiness = buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness();
  assert.strictEqual(readiness.command, 'supervisor-lifecycle-guarded-runner-attempt-audit-readiness');
  assert.strictEqual(readiness.state, 'ready');
  assert.strictEqual(readiness.attemptAuditDefined, true);
  assert.strictEqual(readiness.attemptAuditReady, true);
  assert.strictEqual(readiness.codeOwnedAuditResolverReady, true);
  assert.strictEqual(readiness.realAttemptAuditImplementationReady, false);
  assert.strictEqual(readiness.readyCount, 1);
  assert.strictEqual(readiness.blockedCount, 0);
  assert.deepStrictEqual(readiness.auditEntries, EXPECTED_ATTEMPT_AUDIT_ENTRIES);
  assert.deepStrictEqual(readiness.blockers, []);
  assert.deepStrictEqual(readiness.nextBlockers, []);
  assert.strictEqual(readiness.safety.sensitiveValuesReturned, false);
  // 旧键 / 重叠别名 / entry 级 sensitive 键不得残留（spec §2.3 / §2.4）
  assert.strictEqual(Object.hasOwn(readiness, 'realAttemptAuditReady'), false);
  assert.strictEqual(Object.hasOwn(readiness, 'realImplementationReady'), false);
  assert.strictEqual(Object.hasOwn(readiness, 'sensitiveValuesReturned'), false);
  const entry = readiness.auditEntries[0];
  assert.strictEqual(Object.hasOwn(entry, 'realImplementationReady'), false);
  assert.strictEqual(Object.hasOwn(entry, 'sensitiveValuesReturned'), false);
  assert.strictEqual(Object.hasOwn(entry, 'realAttemptAuditReady'), false);
  assert.strictEqual(entry.realAttemptAuditImplementationReady, false);
  assert.strictEqual(entry.wouldPersistAudit, false);
  assert.strictEqual(entry.wouldWriteLog, false);
  assert.strictEqual(entry.immutableAuditReady, false);
});
```

Wiring contract expectations in shared gate helper fixture:

```js
// V1.28 aggregate：5 ready / 1 blocked（历史 4/2 已废止）
assert.strictEqual(contract.readyCount, 5);
assert.strictEqual(contract.blockedCount, 1);
// contract[4] attempt-audit → ready/null/attempt-audit-ready
// contract[5] → operator-recovery blocked
```

- [ ] **Step 2: Run pure tests — expect RED**

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

Expected: **RED**（fixture/helper 已写 V1.28 期望，实现未就绪）。

- [ ] **Step 3: Implement pure resolver + ready readiness (GREEN)**

In `src/supervisor-lifecycle.js`:

1. Constants：
   - `ATTEMPT_AUDIT_READY_EVIDENCE = 'attempt-audit-ready'`
   - `ATTEMPT_AUDIT_PLAN_READY_EVIDENCE = 'attempt-audit-plan-ready'`
   - `CODE_OWNED_ATTEMPT_AUDIT_KIND = 'code-owned-attempt-audit'`
   - `ATTEMPT_AUDIT_BLOCKER_CODES`（6 码）
   - `CODE_OWNED_ACTION_AUDIT_MAP`（10 项）
   - `ATTEMPT_AUDIT_KIND_ALLOWLIST`
2. 重命名 readiness 字段：`realAttemptAuditReady` → `realAttemptAuditImplementationReady`（全文件 + 测试）；**删除** entry/decision/audit 行上的 `realImplementationReady` 别名（不得残留）
3. Replace `GUARDED_RUNNER_DISABLED_ATTEMPT_AUDIT_ENTRY` with ready entry（见 spec §2.4 exact keys；**不含** `sensitiveValuesReturned` / `realImplementationReady`）
4. Update `GUARDED_RUNNER_WIRING_CONTRACTS[4]`（attempt-audit）→ ready + null blocker + evidenceCode ready
5. Update wiring aggregate：`readyCount:5` / `blockedCount:1`
6. Implement `resolveSupervisorLifecycleGuardedRunnerAttemptAudit`（spec §1 全序评估；expected action set **必须** 由 `buildLifecycleActions(operation).map(a => a.id)` 派生，与 `OPERATION_EXPECTED_ACTION_IDS` deep-equal）
7. Implement `sanitizeAttemptAuditDecision`
8. Convert `buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness` → ready builder（exact keys 见 spec §2.2）
9. **Do not yet** wire gate fact（Task 2）若测试结构允许分步；否则 Task 1+2 可合并但仍先 RED 全写

评估顺序硬编码（不可重排）：

1. operation-invalid
2. candidates-invalid（shape/trap/empty/non-string actionId）
3. action-duplicate
4. action-unknown
5. action-missing
6. unsafe-audit

All-or-nothing：unresolved 恒 `audits:[]`、`resolvedCount:0`、`unresolvedCount:0`。
**说明（防误读）：** all-or-nothing 下 `unresolvedCount` **恒为 0 是刻意选择**——任一失败即整单 unresolved，**不**累计部分失败行数或 `input.length`；失败细节只落在单一 `primaryBlocker`。**不是**漏计数。

- [ ] **Step 4: Re-run pure tests — expect GREEN for pure/readiness/wiring fixture parts**

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

---

### Task 2: Gate Wiring — local `attemptAuditReady` + `auditDecision` + policy

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

- [ ] **Step 1: RED gate assertions**

Production path expectations:

```js
// Ignore options.auditDecision / options.attemptAuditReady / options.auditContext.
const auditDecision = sanitizeAttemptAuditDecision(
  resolveSupervisorLifecycleGuardedRunnerAttemptAudit(actionCandidates, operation),
);

const attemptAuditReadiness = runnerWiringContract.attemptAuditReadiness;
const attemptAuditReady =
  attemptAuditReadiness?.attemptAuditReady === true &&
  attemptAuditReadiness?.codeOwnedAuditResolverReady === true &&
  attemptAuditReadiness?.state === 'ready' &&
  attemptAuditReadiness?.realAttemptAuditImplementationReady === false &&
  auditDecision?.auditReady === true &&
  auditDecision?.state === 'resolved' &&
  auditDecision?.codeOwnedResolverWired === true &&
  auditDecision?.realAttemptAuditImplementationReady === false &&
  auditDecision?.wouldPersistAudit === false &&
  auditDecision?.wouldWriteLog === false &&
  auditDecision?.wouldWriteAudit === false &&
  auditDecision?.wouldExecute === false &&
  auditDecision?.wouldRun === false &&
  auditDecision?.wouldWrite === false &&
  auditDecision?.auditWriteAllowed === false &&
  auditDecision?.metadataWriteAllowed === false &&
  auditDecision?.filesystemWriteAllowed === false &&
  auditDecision?.immutableAuditReady === false;
```

Gate matrix:

| ID | Setup | gates.attemptAuditReady | gates.rollbackAnchorReady | gates.hostMutationAdapterReady | gates.runnerRegistryReady | policy primary |
| --- | --- | --- | --- | --- | --- | --- |
| G1 | ready install + executeRequested | true | true | true | true | `operator-recovery-not-ready`；**不含** `attempt-audit-not-ready` |
| G2 | ready install + executeRequested false | true | true | true | true | 上游或 `operator-recovery-not-ready`；audit fact 仍 true |
| G3 | missing runnerBinding / empty candidates | false | false | false | false | 含 not-ready 族 |
| G4 | non-catalog implementationId binding | true | true | true | **false** | 含 `runner-registry-not-ready`；**不含** `attempt-audit-not-ready` / `rollback-anchor-not-ready` / `host-mutation-adapter-not-ready` |
| G5 | redacted maxAttempts binding | true | true | true | **false** | 含 `runner-registry-not-ready` |
| G6 | options override `attemptAuditReady:true` + fake auditDecision | 仍由 production 决定 | 不变 | 不变 | 不变 | override 无效；合法 path 仍 deny + `operator-recovery-not-ready` |
| G7 | gate 顶层 | `executionEligible:false` / `wouldExecute:false` / `runnerWiringContractReady:false` 恒成立 | | | | |
| G8 | anchorDecision / adapterDecision 仍存在且 V1.27/V1.26 flags false | true | true | true | true | 不回归 |

Shared gate helper update:

```js
function assertBlockedGateShape(result, {
  runnerRegistryReady,
  hostMutationAdapterReady,
  rollbackAnchorReady,
  attemptAuditReady,
}) {
  assert.strictEqual(typeof runnerRegistryReady, 'boolean');
  assert.strictEqual(typeof hostMutationAdapterReady, 'boolean');
  assert.strictEqual(typeof rollbackAnchorReady, 'boolean');
  assert.strictEqual(typeof attemptAuditReady, 'boolean');
  assert.strictEqual(result.executionEligible, false);
  assert.strictEqual(result.wouldExecute, false);
  assert.strictEqual(result.gates.runnerRegistryReady, runnerRegistryReady);
  assert.strictEqual(result.gates.hostMutationAdapterReady, hostMutationAdapterReady);
  assert.strictEqual(result.gates.rollbackAnchorReady, rollbackAnchorReady);
  assert.strictEqual(result.gates.attemptAuditReady, attemptAuditReady);
  assert.strictEqual(result.gates.operatorRecoveryReady, false);
  assert.strictEqual(result.gates.runnerWiringContractReady, false);
  assert.strictEqual(result.runnerWiringContract.readyCount, 5);
  assert.strictEqual(result.runnerWiringContract.blockedCount, 1);
  // readiness ready entry + contract[4] ready...
  // policyDecision.state === 'denied'; would* false
  // result 必须含 auditDecision
  assert.ok(result.auditDecision);
  assert.strictEqual(result.auditDecision.codeOwnedResolverWired, true);
  assert.strictEqual(result.auditDecision.realAttemptAuditImplementationReady, false);
  assert.strictEqual(result.auditDecision.wouldPersistAudit, false);
  assert.strictEqual(result.auditDecision.wouldWriteLog, false);
  assert.strictEqual(result.auditDecision.wouldWriteAudit, false);
  assert.strictEqual(result.auditDecision.immutableAuditReady, false);
}
```

- [ ] **Step 2: Implement gate wiring (GREEN)**

1. Call resolver only with production candidates + operation
2. Attach `auditDecision` to gate output
3. Derive local `attemptAuditReady` boolean（strict conjunction）
4. Put into `policyContext.attemptAuditReady`（不再 hardcode false）
5. Keep `operatorRecoveryReady:false`
6. Keep `executionEligible:false` / `wouldExecute:false` / `runnerWiringContractReady:false`
7. Ignore caller overrides
8. Keep V1.25 registry + V1.26 adapter + V1.27 anchor predicates intact

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

- [ ] **Step 1: 改造两个共用 helper 本体 + fixture（RED 期望对齐 V1.28）**

```js
function assertBlockedExecutionGate(body, {
  runnerRegistryReady,
  hostMutationAdapterReady,
  rollbackAnchorReady,
  attemptAuditReady,
}) {
  assert.strictEqual(typeof runnerRegistryReady, 'boolean');
  assert.strictEqual(typeof hostMutationAdapterReady, 'boolean');
  assert.strictEqual(typeof rollbackAnchorReady, 'boolean');
  assert.strictEqual(typeof attemptAuditReady, 'boolean');

  assert.strictEqual(body.executionEligible, false);
  assert.strictEqual(body.wouldExecute, false);
  assert.strictEqual(body.gates.runnerRegistryReady, runnerRegistryReady);
  assert.strictEqual(body.gates.hostMutationAdapterReady, hostMutationAdapterReady);
  assert.strictEqual(body.gates.rollbackAnchorReady, rollbackAnchorReady);
  assert.strictEqual(body.gates.attemptAuditReady, attemptAuditReady);
  assert.strictEqual(body.gates.operatorRecoveryReady, false);
  assert.strictEqual(body.gates.runnerWiringContractReady, false);

  assert.strictEqual(body.runnerWiringContract.readyCount, 5);
  assert.strictEqual(body.runnerWiringContract.blockedCount, 1);

  const contracts = body.runnerWiringContract.requiredContracts;
  assert.strictEqual(contracts[4].id, 'attempt-audit');
  assert.strictEqual(contracts[4].status, 'ready');
  assert.strictEqual(contracts[4].blockerCode, null);
  assert.strictEqual(contracts[4].evidenceCode, 'attempt-audit-ready');
  assert.strictEqual(contracts[5].id, 'operator-recovery');
  assert.strictEqual(contracts[5].status, 'blocked');

  const readiness = body.runnerWiringContract.attemptAuditReadiness;
  assert.strictEqual(readiness.state, 'ready');
  assert.strictEqual(readiness.attemptAuditReady, true);
  assert.strictEqual(readiness.codeOwnedAuditResolverReady, true);
  assert.strictEqual(readiness.realAttemptAuditImplementationReady, false);

  assert.strictEqual(body.policyDecision.state, 'denied');
  assert.strictEqual(body.policyDecision.wouldRun, false);
  assert.strictEqual(body.policyDecision.wouldWrite, false);

  assert.ok(body.auditDecision);
  assert.strictEqual(body.auditDecision.codeOwnedResolverWired, true);
  assert.strictEqual(body.auditDecision.realAttemptAuditImplementationReady, false);
  assert.strictEqual(body.auditDecision.wouldPersistAudit, false);
  assert.strictEqual(body.auditDecision.wouldWriteLog, false);
  assert.strictEqual(body.auditDecision.wouldWriteAudit, false);
  assert.strictEqual(body.auditDecision.immutableAuditReady, false);

  // V1.27/V1.26 不回退
  assert.strictEqual(body.runnerWiringContract.rollbackAnchorReadiness.state, 'ready');
  assert.strictEqual(body.runnerWiringContract.hostMutationAdapterReadiness.state, 'ready');
}
```

**调用点矩阵（API + CLI 对称）：**

| 场景 | runnerRegistryReady | hostMutationAdapterReady | rollbackAnchorReady | attemptAuditReady | 专属断言 |
| --- | --- | --- | --- | --- | --- |
| valid ready path | true | true | true | true | `policyDecision.primaryBlocker === 'operator-recovery-not-ready'`；blockers 不含 `attempt-audit-not-ready`；`auditDecision.state==='resolved'`；`auditDecision.auditReady===true` |
| executeRequested false | true | true | true | true | audit fact 仍 true |
| missing runnerBinding | false | false | false | false | unresolved candidates 族 |
| non-catalog implementationId | false | true | true | true | 含 `runner-registry-not-ready`；不含 audit/anchor/adapter not-ready |
| redacted maxAttempts | false | true | true | true | 同上 |
| override body fields（若现有用例有 options 路径） | production 决定 | production 决定 | production 决定 | production 决定 | override 无效 |

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

**定位约定（禁止依赖绝对行号）：** 用符号名 / 字符串锚点定位，**不要**依赖易漂移的 `app.js:NNNN` 行号。实现时 `rg -n 'function buildSupervisorLifecycleGuardedRunnerAttemptAuditLines'` / `rg -n 'disabled-attempt-audit-stub'` / `rg -n 'realImplementationReady'` 定位后整段替换。

- [ ] **Step 1: RED Web tests**

1. 从 `WIRING_CONTRACT_CANONICAL_MISSING_BLOCKERS` 移除 `attempt-audit`（只留 `operator-recovery`）。
2. 新增 `isCanonicalAttemptAuditReady` / `resolveCanonicalAttemptAuditReady`（C∧A∧G∧D）。
3. Wiring line：ready 仅当 canonical true；否则 fixed `attempt-audit-missing`。
4. Audit line：ready/blocked fixed strings（spec §5.2）；禁止 `disabled-attempt-audit-stub` 正常路径；禁止旧 `realImplementationReady` 文案残留于 attempt-audit 行。
5. validationLines：`attemptAuditReady` 仅 canonical。
6. 恶意 payload：`wouldPersistAudit:true` / `wouldWriteLog:true` / secret auditKind → 全部 blocked，不泄漏。
7. C/A/G 表面 ready + D side-effect drift → 全部 blocked。
8. 保持 registry/adapter/anchor 独立 canonical 不回归。
9. policyDecision 强制 denied；ready path primary 展示 `operator-recovery-not-ready`（allowlist 透传）。
10. 始终 `runnerWiringContractReady:false` / `executionEligible:false`。

Ready line exact:

```text
attemptAudit:code-owned-attempt-audit:state:ready:codeOwnedResolverWired:true:realAttemptAuditImplementationReady:false:wouldPersistAudit:false:wouldWriteLog:false:blocker:none
```

Blocked line exact:

```text
attemptAudit:code-owned-attempt-audit:state:blocked:codeOwnedResolverWired:true:realAttemptAuditImplementationReady:false:wouldPersistAudit:false:wouldWriteLog:false:blocker:attempt-audit-not-ready
```

- [ ] **Step 2: Implement Web assembly (GREEN)**

**必须替换现有函数本体（按函数名定位，非行号）：**

- **整函数替换** `buildSupervisorLifecycleGuardedRunnerAttemptAuditLines(...)` 的函数体：删除 V1.21 路径上硬编码的
  - `disabled-attempt-audit-stub`
  - `realImplementationReady:false`（旧通用别名文案）
  - `blocker:attempt-audit-real-implementation-missing`
  等旧字符串；改为仅基于 `canonicalAttemptAuditReady` 输出上列 ready/blocked **fixed** 行（catalog 汇总 kind `code-owned-attempt-audit` + `realAttemptAuditImplementationReady:false` + wouldPersist/Log false）。
- 签名可按调用需要扩展（例如接收 canonical boolean / `auditDecision`），但 **替换的是该具名函数本体**，不是“在附近某绝对行号旁插入新函数而留下旧 stub 路径”。
- 调用点（`buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel` 内对 `buildSupervisorLifecycleGuardedRunnerAttemptAuditLines` 的调用）同步改为传入 canonical 结果；**禁止**仅改 call site 而保留旧 stub 实现。

```js
function isCanonicalAttemptAuditReady({ C, A, G, D }) {
  return (
    C?.status === 'ready' &&
    C?.blockerCode === null &&
    C?.evidenceCode === 'attempt-audit-ready' &&
    C?.requiredForExecution === true &&
    A?.state === 'ready' &&
    A?.attemptAuditReady === true &&
    A?.codeOwnedAuditResolverReady === true &&
    A?.realAttemptAuditImplementationReady === false &&
    G === true &&
    D?.state === 'resolved' &&
    D?.auditReady === true &&
    D?.codeOwnedResolverWired === true &&
    D?.realAttemptAuditImplementationReady === false &&
    D?.wouldPersistAudit === false &&
    D?.wouldWriteLog === false &&
    D?.wouldWriteAudit === false &&
    D?.wouldExecute === false &&
    D?.wouldRun === false &&
    D?.wouldWrite === false &&
    D?.auditWriteAllowed === false &&
    D?.metadataWriteAllowed === false &&
    D?.filesystemWriteAllowed === false &&
    D?.immutableAuditReady === false
  );
}
```

Wire into `buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel`：

- resolve canonical boolean once
- pass into wiring lines builder
- pass into **替换后的** `buildSupervisorLifecycleGuardedRunnerAttemptAuditLines` + validationLines
- keep operator-recovery fixed blocked
- keep registry/adapter/anchor independent canonicals
- 实现后 `rg 'disabled-attempt-audit-stub' src/web/app.js` 在 attempt-audit 路径上 **无命中**；`rg 'realImplementationReady' src/web/app.js` 在 attempt-audit 行拼装处 **无命中**（operator-recovery 旧 stub 若仍存在则不动，本 Task 范围仅 attempt-audit）

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

- `LINKE_RELEASE_VERSION === 'V1.28'`
- README 标题 / badge / version table：V1.28 当前；V1.27 历史
- Gold evidence 包含：
  - `resolveSupervisorLifecycleGuardedRunnerAttemptAudit`
  - `attemptAuditReadiness.state:ready`
  - `attemptAuditReady:true`
  - `codeOwnedAuditResolverReady:true`
  - `codeOwnedResolverWired`
  - `attempt-audit-ready`
  - `realAttemptAuditImplementationReady:false`
  - `auditDecision`
  - `readyCount:5`/`blockedCount:1`
- 当前缺口 **不再**以 `attempt-audit-real-implementation-missing` / `attempt-audit-missing` 作为 V1.28 主缺口（历史叙述可保留）
- `nextStep` 含 `operator-recovery`，并声明：
  - 真实 attempt audit persist/log 仍缺失
  - 真实 rollback anchor write/restore 仍缺失
  - 真实 host mutation implementation 仍缺失
  - `runnerWiringContractReady` 仍 false；Gold 仍 blocked
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
git diff b42f57c -- src/supervisor-lifecycle.js | rg -n \
  'launchctl|child_process|execSync|spawn\(|exec\(|fs\.(write|rm|unlink|mkdir)|process\.kill|net\.|http\.|https\.|appendAuditEvent' \
  && echo 'FAIL: side-effect call pattern in diff' || echo 'ok: no side-effect pattern in lifecycle diff'
```

- [ ] **Step 4: Sensitive category count only**

```bash
git diff b42f57c -- src/ test/ | rg -c \
  'ssh-rsa|BEGIN (RSA |OPENSSH )?PRIVATE|AKIA[0-9A-Z]{16}|[0-9a-f]{64}' \
  || true
# 期望：无命中；若有命中只报告 count，不得 cat 原文
```

- [ ] **Step 5: Scope / anchor 核对（无写入；不要 hard reset）**

```bash
git merge-base --is-ancestor b42f57c HEAD && echo 'anchor-ok'
git rev-parse HEAD
git diff --name-only b42f57c --
git status --short
git diff --name-only b42f57c -- src/agent.js src/server.js package.json
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
docs/superpowers/specs/2026-07-14-supervisor-lifecycle-attempt-audit-design.md
docs/superpowers/plans/2026-07-14-supervisor-lifecycle-attempt-audit.md
```

---

## RED → GREEN 测试矩阵总表

| 层 | 测试文件 | 关键断言 |
| --- | --- | --- |
| Pure resolver | `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js` | T1–T28；all-or-nothing（unresolvedCount 恒 0 非漏计）；深拷贝；分层 ignore impl/redacted；T28 duplicate≺unsafe |
| Readiness | 同上 | ready entry exact；旧键不残留；wouldPersist/Log false |
| Wiring | 同上 | readyCount:5 / blockedCount:1；contract[4] ready |
| Gate | 同上 | G1–G8；primary=`operator-recovery-not-ready`；executionEligible false；runnerWiringContractReady false |
| API | `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js` | helper 参数化；透传 auditDecision；override 无效 |
| CLI | `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js` | 与 API 对称（不改 agent.js） |
| Web | `test/web-console.test.js` | C∧A∧G∧D；ready/blocked exact lines；side-effect drift fail-closed |
| Version/README/Gold | `test/version.test.js` / `test/readme.test.js` / `test/gold-readiness.test.js` | V1.28；Gold blocked；nextStep=operator-recovery |

---

## Self-Review Checklist

1. **Spec coverage：** resolver / readiness / wiring 5/1 / gate / API / CLI / Web C∧A∧G∧D / version-README-Gold / scans 均有 Task。
2. **No premature ready：** 明确禁止 `runnerWiringContractReady:true` 与 Gold ready；primary 仅为 `operator-recovery-not-ready`。
3. **Layer independence：** 不读 mutationKind/anchorKind；non-catalog/redacted 下 audit 可 resolved。
4. **Side-effect false locus：** wouldPersistAudit / wouldWriteLog / wouldWriteAudit / *Allowed / immutableAuditReady / realAttemptAuditImplementationReady 恒 false。
5. **V1.26/V1.27 不抬升：** realHostMutation / realRollback write-restore 仍 false。
6. **Forbidden files：** agent.js / server.js / package.json 不改；无新 endpoint/button/request field。
7. **Recovery：** b42f57c；无 `git reset --hard` 常规步骤。
8. **Placeholders：** 无 TBD/TODO；矩阵与 helper 完整。
