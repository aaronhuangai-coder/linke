# V1.30 Supervisor Lifecycle Real Guarded Runner Wiring Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After V1.29 **6/0 pure required contracts**, add a code-owned pure fail-closed **real guarded runner wiring orchestrator / plan / seal** layer that composes production-derived decisions into a deterministic, auditable wiring proof. Keep **`realRunnerWiringReady:false`**, **`runnerWiringContractReady:false`**, **`executionEligible:false`**, all **`real*ImplementationReady:false`**, all side-effect **would\*/\*Allowed:false**, gate primary **`real-guarded-runner-execution-wiring-missing`**, Web **`executionSentinel`**, and **Gold blocked**. Do **not** execute launchctl/fs/process/network.

**Architecture:** Export pure `buildSupervisorLifecycleGuardedRunnerRealWiringPlan(input)` and `buildSupervisorLifecycleGuardedRunnerRealWiringPlanSeal(plan)` plus fixed readiness `buildSupervisorLifecycleGuardedRunnerRealWiringOrchestratorReadiness()`. Gate builds plan input **only** from production-derived sanitized decisions + local structure booleans; attaches sanitized `wiringPlan` / `wiringPlanSeal`; derives local `gates.pureWiringOrchestratorPlanReady` as a **pure plan fact** (NOT policy fact, NOT real wiring; cannot resolve wiring-missing or elevate `realRunnerWiringReady`). `wiringPlanSeal` is a **plan-only seal** (NOT execution receipt, NOT persisted audit, NOT side-effect evidence). Policy vocabulary **unchanged** (ready path stays authorized). Web 方案 A dual locus remains; **must (shall)** add fixed wiringPlan / wiringPlanSeal lines; **executionSentinel 恒 blocked**.

**Tech Stack:** Node.js ESM, `node:test`, existing Web Console view model helpers, README/Gold static scorecard tests.

**Spec:** `docs/superpowers/specs/2026-07-14-supervisor-lifecycle-real-runner-wiring-design.md`

**Recovery anchor:** `d913785` (`feat: add V1.29 operator recovery contract`)

## Global Constraints

- Current release version becomes `V1.30`.
- This is **wiring proof/contract only** — **not** real host runner wiring completion.
- Do **not** set `realRunnerWiringReady:true`, `runnerWiringContractReady:true`, `executionEligible:true`, or any `real*ImplementationReady:true`.
- Do **not** set any side-effect `would*` / `*Allowed` true (mutate/persist/recover/run/write/launchctl/fs/process/network).
- Do **not** remove or satisfy-away `real-guarded-runner-execution-wiring-missing` from gate/wiring `blockers` / `nextBlockers`.
- Do **not** expand `POLICY_FACT_KEYS` or inject wiring-missing into `EXECUTION_POLICY_BLOCKER_CODES` to fake policy deny.
- Do **not** add endpoint, CLI command, Web button, or request body field.
- Do **not** modify `src/agent.js`, `src/server.js`, or `package.json` (rg shows no unavoidable need; any future need is PM-approved scope expansion only).
- Do **not** accept caller/request/CLI overrides for `wiringPlan` / `wiringPlanSeal` / `pureWiringOrchestratorPlanReady` / `realRunnerWiringReady` / `runnerWiringContractReady` / `executionEligible`.
- Do **not** call host shell / process-control / process list / filesystem / metadata / audit / approval writes / NAS / backup / restore / remote / network / launchctl.
- Do **not** schedule, dispatch, or invoke runners; do not return functions/commands/paths/hosts/tokens/hashes/raw errors.
- Do **not** treat `pureWiringOrchestratorPlanReady` as a policy fact, real wiring fact, or as license to drop wiring-missing / elevate `realRunnerWiringReady`.
- Do **not** describe or implement `wiringPlanSeal` as execution receipt, persisted audit, or side-effect evidence.
- Keep wiring aggregate `readyCount:6` / `blockedCount:0` / `state:'blocked'`.
- Keep policy ready path **authorized** / `primaryBlocker:null` when all existing facts true.
- Keep Web `executionSentinel` **恒** blocked until real wiring fully proven in a **later** version.
- **Must (shall)** add Web wiringPlan / wiringPlanSeal fixed lines (T12); never optional.
- G0a real two-Mac PASS statements stay unchanged.
- Malicious fixtures use **opaque synthetic strings only**.
- Sensitive scans report **category hit counts only**.
- Do **not** change V1.24–V1.29 public pure contract semantics (policy/registry/adapter/anchor/audit/recovery).
- Planning phase must not modify `src/`, `test/`, `README.md`, `package*`, or version files; implementation phase follows this plan.
- Do **not** create `actual-changes.txt`. Do **not** use `git reset --hard` as a routine recovery step in this plan.
- Do **not** introduce confusing aliases (`realWiringReady`, `wiringReady`, `runnerReady`) that imply execution eligibility.

### 固定字段 vs 动态 fact（禁止混淆）

| 名称 | 类型 | V1.30 语义 |
| --- | --- | --- |
| readiness `pureWiringOrchestratorPlanReady` | **固定** builder | 恒 true（**pure plan fact** only；非 policy fact；非真实 wiring） |
| `gates.pureWiringOrchestratorPlanReady` | **动态** pure plan fact | §5.1 完整 conjunction：readiness ∧ plan planned ∧ seal-ready ∧ 全 side-effect/real-ready false；**不能**消解 wiring-missing；**不能**抬升 `realRunnerWiringReady` |
| `wiringPlan.state` | **动态** | `planned` / `unplanned` |
| `wiringPlanSeal` / `.state` | **动态** plan-only seal | `seal-ready` / `seal-blocked`；**NOT** execution receipt / **NOT** persisted audit / **NOT** side-effect evidence |
| `realRunnerWiringReady` / `runnerWiringContractReady` / `executionEligible` / top-level `wouldExecute` | **固定 false** | 恒 false |
| 全部 `real*ImplementationReady` + side-effect would* / *Allowed | **固定 false** | 恒 false |
| wiring `readyCount`/`blockedCount` | **固定** | **6 / 0** |
| wiring aggregate `state` | **固定 blocked** | 仍 + wiring-missing |
| ready path `policyDecision` | **动态** | 全部既有 POLICY_FACT_KEYS true → authorized / primary null |
| Web `policyDecision:` | **动态** policy truth | authorized path → authorized + `primaryBlocker:none` |
| Web `executionSentinel:` | **固定 blocked** | 恒 wiring-missing |
| Web wiringPlan / wiringPlanSeal 行 | **必须（shall）动态** | planned/seal-ready 仍带 `realRunnerWiringReady:false` |

### 诚实性检查清单（每个 task 收尾自检）

- [ ] `readyCount:6` / `blockedCount:0` 已断言
- [ ] `runnerWiringContractReady:false` 已断言
- [ ] `realRunnerWiringReady:false` 已断言
- [ ] `executionEligible:false` 已断言
- [ ] gate `nextBlockers` 仍为 `['real-guarded-runner-execution-wiring-missing']`
- [ ] ready path policy **authorized** / primary `null`（未伪装 deny）
- [ ] Web ready path：policy authorized + **executionSentinel blocked** + **shall** wiringPlan/wiringPlanSeal 行
- [ ] 若 pure plan ready：`gates.pureWiringOrchestratorPlanReady:true` **且** real wiring facts 仍 false **且** wiring-missing 仍在
- [ ] `wiringPlanSeal` 仅 plan-only seal（非 execution receipt / 非 persisted audit）
- [ ] 无 host 副作用；无 agent/server/package 改动
- [ ] Gold blocked 边界保持

---

### Task 1: Pure Plan + Plan Seal + Orchestrator Readiness

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

**Interfaces:**
- `buildSupervisorLifecycleGuardedRunnerRealWiringPlan(input): object`
- `buildSupervisorLifecycleGuardedRunnerRealWiringPlanSeal(plan): object` — plan-only seal builder
- `buildSupervisorLifecycleGuardedRunnerRealWiringOrchestratorReadiness(): object`

- [ ] **Step 1: Write the failing pure tests (RED)**

Update imports to include the three new exports.

Fixtures (align spec §2–4):

```js
const REAL_WIRING_MISSING = 'real-guarded-runner-execution-wiring-missing';

const EXPECTED_ORCHESTRATOR_ENTRY = Object.freeze({
  orchestratorKind: 'code-owned-real-wiring-orchestrator',
  state: 'ready',
  codeOwnedResolverWired: true,
  realRunnerWiringReady: false,
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  launchctlAllowed: false,
  filesystemWriteAllowed: false,
  processListReadAllowed: false,
  networkAllowed: false,
  blockerCode: null,
  evidenceCode: 'real-wiring-orchestrator-plan-ready',
});

// Build a production-shaped plan input from existing install fixtures:
// - actionCandidates from verified gate path
// - sanitized authorized policyDecision
// - resolved registry/adapter/anchor/audit/recovery decisions
// - all structure facts true
```

Assert readiness（与 spec §4 exact 断言同步）：

```js
const r = buildSupervisorLifecycleGuardedRunnerRealWiringOrchestratorReadiness();
assert.strictEqual(r.state, 'ready');
assert.strictEqual(r.pureWiringOrchestratorPlanReady, true); // pure plan fact only
assert.strictEqual(r.codeOwnedWiringOrchestratorReady, true);
assert.strictEqual(r.realRunnerWiringReady, false); // cannot elevate real wiring
assert.strictEqual(r.readyCount, 1);
assert.strictEqual(r.blockedCount, 0);
assert.deepStrictEqual(r.nextBlockers, [REAL_WIRING_MISSING]); // cannot resolve wiring-missing
assert.strictEqual(r.entries[0].realRunnerWiringReady, false);
assert.strictEqual(r.entries[0].wouldExecute, false);
assert.strictEqual(r.entries[0].wouldRun, false);
assert.strictEqual(r.entries[0].wouldWrite, false);
assert.strictEqual(r.entries[0].launchctlAllowed, false);
assert.strictEqual(r.entries[0].filesystemWriteAllowed, false);
assert.strictEqual(r.entries[0].processListReadAllowed, false);
assert.strictEqual(r.entries[0].networkAllowed, false);
assert.strictEqual(r.entries[0].evidenceCode, 'real-wiring-orchestrator-plan-ready');
```

Assert planned path（side-effect / real-ready 全量 false，无省略）：

```js
const plan = buildSupervisorLifecycleGuardedRunnerRealWiringPlan(validInput);
assert.strictEqual(plan.state, 'planned');
assert.strictEqual(plan.planReady, true);
assert.strictEqual(plan.pureWiringOrchestratorPlanReady, true); // pure plan fact only
assert.strictEqual(plan.realRunnerWiringReady, false);
assert.strictEqual(plan.runnerWiringContractReady, false);
assert.strictEqual(plan.executionEligible, false);
assert.strictEqual(plan.mode, 'plan-only');
assert.strictEqual(plan.evidenceCode, 'real-wiring-orchestrator-plan-ready');
assert.strictEqual(plan.primaryBlocker, null);
assert.strictEqual(plan.wouldExecute, false);
assert.strictEqual(plan.wouldRun, false);
assert.strictEqual(plan.wouldWrite, false);
assert.strictEqual(plan.launchctlAllowed, false);
assert.strictEqual(plan.filesystemWriteAllowed, false);
assert.strictEqual(plan.processListReadAllowed, false);
assert.strictEqual(plan.networkAllowed, false);
assert.deepStrictEqual(plan.nextBlockers, [REAL_WIRING_MISSING]);
assert.ok(Array.isArray(plan.steps) && plan.steps.length > 0);
for (const step of plan.steps) {
  assert.strictEqual(step.wouldExecute, false);
  assert.strictEqual(step.wouldRun, false);
  assert.strictEqual(step.wouldWrite, false);
  assert.equal(typeof step.actionId, 'string');
  // no command/path/url fields
  assert.strictEqual(step.command, undefined);
  assert.strictEqual(step.path, undefined);
}

const seal = buildSupervisorLifecycleGuardedRunnerRealWiringPlanSeal(plan);
assert.strictEqual(seal.state, 'seal-ready');
assert.strictEqual(seal.sealReady, true);
assert.strictEqual(seal.pureWiringOrchestratorPlanReady, true);
assert.strictEqual(seal.evidenceCode, 'real-wiring-orchestrator-plan-seal-ready');
assert.strictEqual(seal.primaryBlocker, null);
assert.strictEqual(seal.realRunnerWiringReady, false);
assert.strictEqual(seal.runnerWiringContractReady, false);
assert.strictEqual(seal.executionEligible, false);
assert.strictEqual(seal.wouldPersistAudit, false); // NOT persisted audit
assert.strictEqual(seal.wouldWriteLog, false);
assert.strictEqual(seal.wouldExecute, false);
assert.strictEqual(seal.wouldRun, false);
assert.strictEqual(seal.wouldWrite, false);
assert.deepStrictEqual(seal.nextBlockers, [REAL_WIRING_MISSING]);
// seal is plan-only: NOT execution receipt / NOT side-effect evidence
```

Fail-closed cases:

- extra keys / non-plain / Proxy → `unplanned` + `real-wiring-plan-input-invalid`
- invalid operation → `real-wiring-plan-operation-invalid`
- empty candidates → `real-wiring-plan-candidates-not-ready`
- policy not authorized → `real-wiring-plan-policy-not-authorized`
- each unresolved decision → corresponding `real-wiring-plan-*-not-resolved`
- incomplete structure facts → `real-wiring-plan-structure-facts-incomplete`
- side-effect flag true on any decision → `real-wiring-plan-side-effect-flag-invalid`
- plan seal on unplanned plan → `seal-blocked`

- [ ] **Step 2: Run tests to verify RED**

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

Expect failures: exports missing / assertions fail.

- [ ] **Step 3: Implement pure builders (GREEN)**

In `src/supervisor-lifecycle.js`:

1. Constants: evidence codes, blocker allowlist, orchestrator kind, readiness entry freeze.
2. `snapshotExactKeyPlainWiringPlanInput` — exact keys only; reject getters/traps.
3. Validate operation, candidates (reuse `areSupervisorLifecycleGuardedRunnerActionCandidatesReady`), six decisions shape + resolved/authorized + side-effect false, structure booleans all true.
4. Build deterministic `steps[]` from candidates order + fixed evidence ref codes only.
5. Deep-copy return; freeze-friendly plain objects.
6. Plan seal validates plan snapshot only (in-memory plan-only seal; no persist/audit/execute).
7. Readiness fixed ready object with `pureWiringOrchestratorPlanReady:true`, `realRunnerWiringReady:false`, and nextBlockers wiring-missing.

- [ ] **Step 4: Run tests to verify GREEN**

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

- [ ] **Step 5: Commit (only when user explicitly asks)**

```text
feat: add V1.30 pure real-wiring orchestrator plan/seal
```

---

### Task 2: Gate Wiring — local plan/seal + pureWiringOrchestratorPlanReady

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

**Interfaces:**
- `buildSupervisorLifecycleGuardedRunnerExecutionGate` attaches `wiringPlan`, `wiringPlanSeal`
- `gates.pureWiringOrchestratorPlanReady` local **pure plan fact** boolean（完整 §5.1 conjunction）
- wiring contract may nest `realWiringOrchestratorReadiness` but stays blocked + wiring-missing

- [ ] **Step 1: Write failing gate tests (RED)**

Production ready path (reuse V1.29 install fixtures + executeRequested true):

```js
assert.strictEqual(result.gates.pureWiringOrchestratorPlanReady, true); // pure plan fact only
assert.strictEqual(result.wiringPlan.state, 'planned');
assert.strictEqual(result.wiringPlan.planReady, true);
assert.strictEqual(result.wiringPlan.pureWiringOrchestratorPlanReady, true);
assert.strictEqual(result.wiringPlan.mode, 'plan-only');
assert.strictEqual(result.wiringPlan.evidenceCode, 'real-wiring-orchestrator-plan-ready');
assert.strictEqual(result.wiringPlan.realRunnerWiringReady, false);
assert.strictEqual(result.wiringPlan.runnerWiringContractReady, false);
assert.strictEqual(result.wiringPlan.executionEligible, false);
assert.strictEqual(result.wiringPlan.wouldExecute, false);
assert.strictEqual(result.wiringPlan.wouldRun, false);
assert.strictEqual(result.wiringPlan.wouldWrite, false);
assert.strictEqual(result.wiringPlan.launchctlAllowed, false);
assert.strictEqual(result.wiringPlan.filesystemWriteAllowed, false);
assert.strictEqual(result.wiringPlan.processListReadAllowed, false);
assert.strictEqual(result.wiringPlan.networkAllowed, false);
assert.strictEqual(result.wiringPlanSeal.state, 'seal-ready');
assert.strictEqual(result.wiringPlanSeal.sealReady, true);
assert.strictEqual(result.wiringPlanSeal.pureWiringOrchestratorPlanReady, true);
assert.strictEqual(result.wiringPlanSeal.evidenceCode, 'real-wiring-orchestrator-plan-seal-ready');
assert.strictEqual(result.wiringPlanSeal.realRunnerWiringReady, false);
assert.strictEqual(result.wiringPlanSeal.runnerWiringContractReady, false);
assert.strictEqual(result.wiringPlanSeal.executionEligible, false);
assert.strictEqual(result.wiringPlanSeal.wouldPersistAudit, false);
assert.strictEqual(result.wiringPlanSeal.wouldWriteLog, false);
assert.strictEqual(result.wiringPlanSeal.wouldExecute, false);
assert.strictEqual(result.wiringPlanSeal.wouldRun, false);
assert.strictEqual(result.wiringPlanSeal.wouldWrite, false);
assert.strictEqual(result.executionEligible, false);
assert.strictEqual(result.wouldExecute, false);
assert.strictEqual(result.realRunnerWiringReady, false);
assert.strictEqual(result.gates.realRunnerWiringReady, false);
assert.strictEqual(result.gates.runnerWiringContractReady, false);
assert.deepStrictEqual(result.nextBlockers, [REAL_WIRING_MISSING]); // pure ready cannot resolve
assert.ok(result.blockers.includes(REAL_WIRING_MISSING));
assert.strictEqual(result.policyDecision.state, 'authorized');
assert.strictEqual(result.policyDecision.primaryBlocker, null);
// pureWiringOrchestratorPlanReady is NOT a policy fact
assert.strictEqual(Object.hasOwn(result.policyDecision, 'pureWiringOrchestratorPlanReady'), false);
// V1.25–V1.29 real facts still false
assert.strictEqual(result.adapterDecision.realHostMutationImplementationReady, false);
assert.strictEqual(result.anchorDecision.realRollbackAnchorImplementationReady, false);
assert.strictEqual(result.auditDecision.realAttemptAuditImplementationReady, false);
assert.strictEqual(result.recoveryDecision.realOperatorRecoveryImplementationReady, false);
assert.strictEqual(result.runnerWiringContract.readyCount, 6);
assert.strictEqual(result.runnerWiringContract.blockedCount, 0);
assert.strictEqual(result.runnerWiringContract.state, 'blocked');
assert.strictEqual(result.runnerWiringContract.realRunnerWiringReady, false);
```

Override rejection:

```js
const poisoned = buildSupervisorLifecycleGuardedRunnerExecutionGate(productionArgs, {
  executeRequested: true,
  wiringPlan: { state: 'planned', planReady: true, realRunnerWiringReady: true },
  wiringPlanSeal: { state: 'seal-ready', sealReady: true, realRunnerWiringReady: true },
  pureWiringOrchestratorPlanReady: true,
  realRunnerWiringReady: true,
  runnerWiringContractReady: true,
  executionEligible: true,
});
assert.strictEqual(poisoned.realRunnerWiringReady, false);
assert.strictEqual(poisoned.executionEligible, false);
assert.strictEqual(poisoned.gates.runnerWiringContractReady, false);
assert.deepStrictEqual(poisoned.nextBlockers, [REAL_WIRING_MISSING]);
// plan/seal must be recomputed from production path, not caller object identity
```

executeRequested false:

```js
assert.strictEqual(result.gates.pureWiringOrchestratorPlanReady, false);
// or plan unplanned due to structure — either way executionEligible false
assert.strictEqual(result.executionEligible, false);
assert.ok(result.policyDecision.blockers.includes('execute-request-missing') ||
  result.policyDecision.primaryBlocker === 'execute-request-missing');
```

- [ ] **Step 2: Run RED**

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

- [ ] **Step 3: Implement gate integration (GREEN)**

Inside `buildSupervisorLifecycleGuardedRunnerExecutionGate` after recoveryDecision/policyDecision:

1. Comment: ignore options wiring overrides.
2. Build exact-key input from local booleans + sanitized decisions + actionCandidates + operation.
3. `wiringPlan` / `wiringPlanSeal` pure calls.
4. Derive `pureWiringOrchestratorPlanReady` with **full** strict conjunction from spec §5.1（禁止 `...` 省略；列出 plan/seal 全部 state/evidence/side-effect/real-ready 条件）.
5. Attach fields; keep hardcode false for execution/real wiring facts; keep wiring-missing blockers.
6. Optionally attach orchestrator readiness under `runnerWiringContract` without flipping aggregate ready flags.
7. Do **not** add `pureWiringOrchestratorPlanReady` to `POLICY_FACT_KEYS`.

- [ ] **Step 4: Run GREEN**

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

- [ ] **Step 5: Commit when user asks**

```text
feat: wire V1.30 real-wiring plan/seal into execution gate
```

---

### Task 3: API / CLI 透传（无 agent.js/server.js 改动）

**Files:**
- Modify only if existing tests hard-assert full JSON shape:
  - `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js`
  - `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js`
- **Do not** modify `src/agent.js` / `src/server.js`

- [ ] **Step 1: Run existing API/CLI gate tests**

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js \
  test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

- [ ] **Step 2: Extend assertions (if needed) for new fields**

Assert response/CLI JSON includes:

- `wiringPlan.state` is `planned` or `unplanned` (string)
- `wiringPlanSeal` present as plan-only seal (`seal-ready` / `seal-blocked`; NOT execution receipt)
- `gates.pureWiringOrchestratorPlanReady` boolean pure plan fact
- still `executionEligible:false`, `realRunnerWiringReady:false`, `runnerWiringContractReady:false`
- still contains `real-guarded-runner-execution-wiring-missing`

- [ ] **Step 3: GREEN**

If tests fail only due to missing assertions, update tests. If they fail due to agent/server needing changes, **stop** and escalate PM scope — do not silently edit agent/server.

---

### Task 4: Web canonical assembly（方案 A 保持 + wiring plan/seal 行 **必须 / shall**）

**Files:**
- Modify: `src/web/app.js`
- Modify: `test/web-console.test.js`

- [ ] **Step 1: RED tests**

Ready path view model must match（T12；wiring 行 **must / shall**，非 optional）：

```text
policyDecision:state:authorized:authorized:true:wouldAuthorizeExecution:true:primaryBlocker:none
executionSentinel:state:blocked:executionEligible:false:blocker:real-guarded-runner-execution-wiring-missing
wiringPlan:state:planned:planReady:true:realRunnerWiringReady:false:mode:plan-only:blocker:none
wiringPlanSeal:state:seal-ready:sealReady:true:realRunnerWiringReady:false:blocker:none
```

validationLines must include:

```text
pureWiringOrchestratorPlanReady:true
realRunnerWiringReady:false
runnerWiringContractReady:false
executionEligible:false
```

and dynamic `pureWiringOrchestratorPlanReady:true` only under canonical §5.1 conjunction（pure plan fact only；不得暗示 real wiring ready）。

Malicious cases: no secret echo; sentinel still blocked; no `executionEligible:true`.

- [ ] **Step 2: Implement view model helpers (GREEN)**

- Reuse strict canonical assembly style from V1.29 (C∧A∧G∧D style where applicable).
- **Must (shall)** emit wiringPlan + wiringPlanSeal fixed lines.
- **Never** drop executionSentinel.
- **Never** render authorized as denied.
- **Never** label wiringPlanSeal as execution receipt / audit persist evidence.
- Map null policy primary → `none` only on authorized path.

- [ ] **Step 3: Run**

```bash
node --test test/web-console.test.js
```

---

### Task 5: Version / README / Gold

**Files:**
- Modify: `src/version.js` (or project version locus)
- Modify: `README.md`
- Modify: `src/gold-readiness.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js` if version string asserted

- [ ] **Step 1: RED — version + gold evidence expectations**

Gold `automation-installation` (and production-hardening mirror if present) evidence must include strings such as:

```text
buildSupervisorLifecycleGuardedRunnerRealWiringPlan
buildSupervisorLifecycleGuardedRunnerRealWiringPlanSeal
pureWiringOrchestratorPlanReady
wiringPlan.state:planned
wiringPlanSeal.state:seal-ready
mode:plan-only
realRunnerWiringReady:false
runnerWiringContractReady:false
executionEligible:false
real-guarded-runner-execution-wiring-missing
readyCount:6
blockedCount:0
```

nextStep must state:

- V1.30 adds pure real-wiring orchestrator plan/seal (plan-only seal, not execution receipt)
- pureWiringOrchestratorPlanReady is pure plan fact only — does not resolve wiring-missing
- **does not** set realRunnerWiringReady true
- next step is capability injection + real host implementations
- Gold remains blocked

README current version **V1.30** with honest proof/contract wording (mirror V1.29 style).

- [ ] **Step 2: Implement docs/scorecard updates (GREEN)**

- [ ] **Step 3: Run**

```bash
node --test test/gold-readiness.test.js test/readme.test.js
```

---

### Task 6: Full regression + side-effect / sensitive scan + scope check

- [ ] **Step 1: Full test**

```bash
node --test
```

- [ ] **Step 2: Diff scope check（相对 d913785）**

```bash
git diff --name-only d913785
git diff --stat d913785
```

Allowed paths only (implementation phase):

- `src/supervisor-lifecycle.js`
- `src/web/app.js`
- `src/gold-readiness.js`
- `src/version.js` (if used)
- `README.md`
- listed tests
- these two docs (already present)

**Fail** if `src/agent.js` / `src/server.js` / `package.json` appear.

- [ ] **Step 3: Side-effect scan（category counts only）**

Search implementation diff for new uses of:

- `launchctl`, `child_process`, `execFile`, `spawn`, `process.kill`
- `fs.write`, `writeFile`, `appendFile`, `mkdir` (unexpected)
- `net.`, `fetch(`, `http.request`
- raw token/Authorization echo patterns

Report **counts by category**, not secret values.

- [ ] **Step 4: Honesty final matrix**

| Check | Expected |
| --- | --- |
| pure plan ready possible | yes |
| `realRunnerWiringReady` | false |
| `runnerWiringContractReady` | false |
| `executionEligible` | false |
| wiring-missing present | yes |
| policy authorized ready path | yes |
| executionSentinel blocked | yes |
| Gold status | blocked |
| host side effects | none |

- [ ] **Step 5: Commit when user asks**

```text
feat: complete V1.30 real-wiring orchestrator proof/contract
```

Do **not** push unless user explicitly requests.

---

## RED→GREEN 总矩阵（实现验收速查）

| Task | RED focus | GREEN focus |
| --- | --- | --- |
| 1 | pure plan/plan-seal/readiness exports | fail-closed pure builders |
| 2 | gate fields + hardcode false wiring facts | production-derived pure plan fact（§5.1 full conjunction） |
| 3 | API/CLI shape | test-only updates; no agent/server |
| 4 | Web dual locus + **shall** wiringPlan/wiringPlanSeal lines | canonical assembly |
| 5 | version/README/Gold evidence | static scorecard honesty |
| 6 | full suite + scope/scan | release-ready proof/contract only |

---

## 完成标准（实现阶段验收）

1. Pure plan / plan-seal / readiness APIs exist and are fail-closed; `wiringPlanSeal` is plan-only seal (NOT execution receipt / NOT persisted audit / NOT side-effect evidence).
2. Production gate ready path exposes `wiringPlan`/`wiringPlanSeal` with `gates.pureWiringOrchestratorPlanReady:true` under **full** spec §5.1 conjunction.
3. `pureWiringOrchestratorPlanReady` is **pure plan fact only** — not policy fact, not real wiring; cannot resolve wiring-missing; cannot elevate `realRunnerWiringReady`.
4. **Simultaneously** `realRunnerWiringReady:false`, `runnerWiringContractReady:false`, `executionEligible:false`, `wouldExecute:false`.
5. Gate + wiring still carry `real-guarded-runner-execution-wiring-missing` as next/primary execution blocker.
6. Wiring aggregate remains `readyCount:6` / `blockedCount:0` / `state:'blocked'`.
7. All V1.25–V1.29 `real*ImplementationReady` and side-effect would* / *Allowed remain false.
8. Policy ready path remains authorized; Web keeps executionSentinel blocked **and shall** render wiringPlan / wiringPlanSeal lines.
9. No `src/agent.js` / `src/server.js` / `package.json` changes.
10. No host side-effect calls.
11. Gold overall blocked; README labels V1.30 as wiring proof/contract.
12. Recovery anchor `d913785` documented.
13. **No claim** that real runner wiring or Gold release is complete.

---

## 实现后报告模板（给 agent）

```text
V1.30 实现完成（wiring proof/contract only）

基线锚点: d913785
版本: V1.30

变更文件:
- （仅列实现阶段实际 diff 路径）

事实矩阵:
- readyCount/blockedCount: 6/0
- pureWiringOrchestratorPlanReady (gate ready path pure plan fact): true
- pureWiringOrchestratorPlanReady is NOT policy fact / NOT real wiring
- wiringPlanSeal: seal-ready (plan-only seal; NOT execution receipt / NOT persisted audit)
- realRunnerWiringReady: false
- runnerWiringContractReady: false
- executionEligible: false
- nextBlockers: [real-guarded-runner-execution-wiring-missing]
- policy ready path: authorized / primary null
- executionSentinel: blocked
- Web wiringPlan/wiringPlanSeal lines: present (shall)
- Gold: blocked

测试:
- focused: PASS/FAIL
- full: PASS/FAIL

scope check: agent.js/server.js/package.json 未改
side-effect scan: 无新增 host API
敏感扫描: category counts only

下一步（非本版）:
- capability injection + dry-run/execute
- real*ImplementationReady 抬升所需双机/失败注入证据
```

---

## 设计阶段（当前）完成定义

本 plan/spec 撰写阶段 **仅** 新增两份文档：

- `docs/superpowers/specs/2026-07-14-supervisor-lifecycle-real-runner-wiring-design.md`
- `docs/superpowers/plans/2026-07-14-supervisor-lifecycle-real-runner-wiring.md`

**不**改源码、**不**跑测试作为发布依据、**不**提交、**不**推送。
