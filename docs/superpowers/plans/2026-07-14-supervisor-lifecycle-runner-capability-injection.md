# V1.31 Supervisor Lifecycle Runner Capability Injection + Dry-Run/Execute Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After V1.30 **pure real-wiring orchestrator / plan / seal proof**, add the necessary pre-runner surface: **code-owned capability injection interface**, **dry-run-only internal registry**, **execute 单闸 immediate hard-deny**（公式文档化；无 real handler；**非**双闸）, and **capability receipts** (named distinctly from V1.30 `wiringPlanSeal`). Keep **`realRunnerWiringReady:false`**, **`runnerWiringContractReady:false`**, **`executionEligible:false`**, all **`real*ImplementationReady:false`**, all side-effect **would\*/\*Allowed:false**, **`executeCapabilityAuthorized:false`**, gate primary **`real-guarded-runner-execution-wiring-missing`**, Web **`executionSentinel`**, and **Gold blocked**. Do **not** execute launchctl/fs/process/network/audit-persist/notify. Do **not** accept caller-injected handlers/commands/shell.

**Architecture:** Export pure readiness / resolve / authorize / invokeDryRun APIs. Module-private trusted bootstrap registers only `implementationClass:'dry-run-non-side-effect'` handlers for **seven capability kinds**（handler 内 `operation`+`actionId` 分派） derived from the existing ten lifecycle actions. Public APIs accept/return **plain objects only** via §2.7 exact whitelist + structuredClone/validated deep copy (never functions). Gate ignores options overrides; attaches sanitized `capabilityInjectionDecision` (+ optional dry-run receipt summary); derives local `gates.capabilityInjectionReady`. Execute mode → **单闸** `capability-execute-denied-receipt`（不调 handler）。Policy vocabulary unchanged. Web 方案 A dual locus remains; **must (shall)** add capabilityInjection fixed line(s); **executionSentinel 恒 blocked**.

**Tech Stack:** Node.js ESM, `node:test`, existing Web Console view model helpers, README/Gold static scorecard tests.

**Spec:** `docs/superpowers/specs/2026-07-14-supervisor-lifecycle-runner-capability-injection-design.md`

**Recovery anchor:** `7ac8d6c` (`feat: add V1.30 real runner wiring proof`)

## Global Constraints

- Current release version becomes `V1.31`.
- This is **capability injection + dry-run/execute boundary only** — **not** real host runner wiring completion.
- Do **not** set `realRunnerWiringReady:true`, `runnerWiringContractReady:true`, `executionEligible:true`, `executeCapabilityAuthorized:true`, or any `real*ImplementationReady:true` (including `realCapabilityImplementationsReady`).
- Do **not** set any side-effect `would*` / `*Allowed` true; `hostSideEffectOccurred` always false.
- Do **not** remove or satisfy-away `real-guarded-runner-execution-wiring-missing` from gate/wiring `blockers` / `nextBlockers`.
- Do **not** expand `POLICY_FACT_KEYS` or inject wiring-missing into `EXECUTION_POLICY_BLOCKER_CODES` to fake policy deny.
- Do **not** add endpoint, CLI command, Web button, or request body field.
- Do **not** modify `src/agent.js`, `src/server.js`, or `package.json`.
- Do **not** accept caller/request/CLI overrides for capability decision/receipt/ready flags/handlers/capabilities/registry.
- Do **not** export `registerCapability` / accept `options.handlers` / command strings / shell argv as capabilities.
- Do **not** call host shell / process-control / process list / filesystem / metadata / audit / approval writes / NAS / backup / restore / remote / network / launchctl / notify send.
- Do **not** schedule, dispatch, or invoke real runners; do not return functions/commands/paths/hosts/tokens/hashes/raw errors.
- Do **not** treat `pureCapabilityInjectionReady` / dry-run receipt completed as real wiring or license to drop wiring-missing / elevate `executionEligible`.
- Do **not** describe or implement capability receipt as `wiringPlanSeal`, execution receipt alias for seal, or persisted audit.
- Keep wiring aggregate `readyCount:6` / `blockedCount:0` / `state:'blocked'`.
- Keep `wiringPlan.mode:'plan-only'` and `wiringPlanSeal` plan-only seal semantics from V1.30.
- Keep policy ready path **authorized** / `primaryBlocker:null` when all existing facts true.
- Keep Web `executionSentinel` **恒** blocked.
- **Must (shall)** add Web capabilityInjection fixed line (T15); never optional.
- G0a real two-Mac PASS statements stay unchanged.
- Malicious fixtures use **opaque synthetic strings only**.
- Sensitive scans report **category hit counts only**.
- Do **not** change V1.24–V1.30 public pure contract semantics (policy/registry/adapter/anchor/audit/recovery/wiring plan-seal).
- Planning phase must not modify `src/`, `test/`, `README.md`, `package*`, or version files; implementation phase follows this plan.
- Do **not** create `actual-changes.txt`. Do **not** use `git reset --hard` as a routine recovery step in this plan.
- Do **not** introduce confusing aliases (`realWiringReady`, `wiringReady`, `runnerReady`, `capabilitySeal`).

### 固定字段 vs 动态 fact（禁止混淆）

| 名称 | 类型 | V1.31 语义 |
| --- | --- | --- |
| readiness `pureCapabilityInjectionReady` | **固定** builder | 恒 true（pure contract fact only） |
| readiness `dryRunCapabilityRegistryReady` | **固定** builder | 恒 true |
| readiness `executeCapabilityRegistryReady` / `realCapabilityImplementationsReady` | **固定 false** | 恒 false |
| `gates.capabilityInjectionReady` | **动态** | readiness ∧ decision resolved ∧ dry-run ready ∧ executeAuthorized false ∧ 全 real/side-effect false |
| `capabilityInjectionDecision.state` | **动态** | `resolved` / `unresolved` |
| `capabilityReceipt.receiptKind` | **动态** | dry-run / execute-denied（V1.31 无 completed execute） |
| `wiringPlanSeal` | **保持 V1.30** | plan-only seal；**NOT** capability receipt |
| `realRunnerWiringReady` / `runnerWiringContractReady` / `executionEligible` / top-level `wouldExecute` | **固定 false** | 恒 false |
| 全部既有 `real*ImplementationReady` + side-effect would\* / \*Allowed | **固定 false** | 恒 false |
| wiring `readyCount`/`blockedCount` | **固定** | **6 / 0** |
| wiring aggregate `state` | **固定 blocked** | 仍 + wiring-missing |
| ready path `policyDecision` | **动态** | 全部既有 POLICY_FACT_KEYS true → authorized / primary null |
| Web `executionSentinel:` | **固定 blocked** | 恒 wiring-missing |
| Web capabilityInjection 行 | **必须（shall）动态** | resolved 仍带 `executeReady:false` + `realRunnerWiringReady:false` |

### 诚实性检查清单（每个 task 收尾自检）

- [ ] `readyCount:6` / `blockedCount:0` 已断言
- [ ] `runnerWiringContractReady:false` 已断言
- [ ] `realRunnerWiringReady:false` 已断言
- [ ] `executionEligible:false` 已断言
- [ ] `executeCapabilityAuthorized:false` 已断言
- [ ] `realCapabilityImplementationsReady:false` 已断言
- [ ] `hostSideEffectOccurred:false` 已断言
- [ ] gate `nextBlockers` 仍为 `['real-guarded-runner-execution-wiring-missing']`
- [ ] ready path policy **authorized** / primary `null`
- [ ] Web ready path：policy authorized + **executionSentinel blocked** + wiring 行 + **shall** capability 行
- [ ] capability receipt **不是** wiringPlanSeal
- [ ] 无 host 副作用；无 agent/server/package 改动
- [ ] Gold blocked 边界保持

### 10 actions → primary capability（实现常量）

```js
const CODE_OWNED_ACTION_PRIMARY_CAPABILITY_MAP = Object.freeze({
  'render-launch-agent-plist': 'render',
  'write-launch-agent-plist': 'write',
  'load-launch-agent': 'reload',
  'unload-launch-agent': 'reload',
  'remove-launch-agent-plist': 'write',
  'remove-supervisor-metadata': 'write',
  'capture-current-state': 'status',
  'restore-previous-plist': 'rollback',
  'restart-previous-supervisor': 'reload',
  'start-recovery-supervisor': 'reload',
});

const CAPABILITY_KIND_ALLOWLIST = Object.freeze([
  'render', 'write', 'reload', 'status', 'rollback', 'audit', 'notify',
]);
```

### Mode formula（实现注释必须引用）

```text
default mode = dry-run

dryRunCapabilityAuthorized =
  mode==='dry-run' && kind allowlisted && action map-consistent &&
  dryRun registry ready && handler class dry-run-non-side-effect &&
  all real/side-effect flags false && no caller injection

executeCapabilityAuthorized = FULL multi-fact conjunction (spec §4.3)
  → V1.31 implementation: ALWAYS false / 单闸 immediate hard-deny
  → V1.31 架构保证：无 real handler；mode==='execute' 立即 denied receipt；不调 handler
  → V1.32+ 注册 real handlers 后：dispatch 前再次验证完整公式 → 双闸（本版不做）
```

### Prototype / 返回物防护（实现必须引用 spec §2.7）

```text
入参：exact whitelist extraction
  - 禁止 Object.assign / object spread / JSON.stringify+parse 作清洗
  - Object.hasOwn + data-property descriptor 检查
  - 拒绝 __proto__ / constructor / prototype / symbol keys / extra keys

出参：structuredClone(validatedPlain) 或等效 validated manual deep copy
  - function 出现 → fail-closed（不得 silent drop 后 completed）
  - 禁止 assign/spread/JSON round-trip 作返回深拷贝
```

### Receipt 可达 state（V1.31）

| state | 生产公共 API | 说明 |
| --- | --- | --- |
| `completed` / `denied` / `error` | **可达** | 唯一生产可达集合 |
| `partial` / `timeout` | **不可达** | **仅** test harness 模拟 |
| `rolled-back` | **不可达** | V1.32+ 预留 |
| `idempotencyKeyFingerprint` | **固定 `null`** | 不用含糊 sentinel 字符串 |

### write / reload actionId 分派（dry-run 与 V1.32 real 同粒度）

```text
write handler（按 kind 注册 1 个；内部分派）:
  write-launch-agent-plist           → write/create/update
  remove-launch-agent-plist          → remove/delete
  remove-supervisor-metadata         → remove/delete

reload handler（按 kind 注册 1 个；内部分派）:
  load-launch-agent                  → load
  unload-launch-agent                → unload
  restart-previous-supervisor        → restart
  start-recovery-supervisor          → start
```

### Execute 证据 locus 占位（V1.31 全 false / 不存在；schema owner 见 spec §4.5）

| locus | V1.31 | V1.32 schema owner |
| --- | --- | --- |
| idempotency store | 不存在；fingerprint 固定 null | capability idempotency module |
| real rollback anchor | false / 无 sink | rollback-anchor real impl |
| persist audit sink | false / 无 persist | attempt-audit real impl |
| recovery / notify | false / 仅 dry-run plan | recovery real + notify real handler |
| dual-host evidence | 不存在 | dual-host evidence recorder |
| failure injection suite | 生产无 inject；仅 harness | failure-injection evidence suite |

---

### Task 1: Capability maps + private dry-run registry + pure readiness/resolve

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

**Interfaces:**
- `buildSupervisorLifecycleGuardedRunnerCapabilityInjectionReadiness(): object`
- `resolveSupervisorLifecycleGuardedRunnerCapabilityInjection(candidates, operation): object`
- module-private `trustedBootstrapCapabilityRegistry()` (NOT exported)

- [ ] **Step 1: Write the failing pure tests (RED)**

Update imports to include new exports.

Fixtures:

```js
const REAL_WIRING_MISSING = 'real-guarded-runner-execution-wiring-missing';
const CAPABILITY_KINDS = Object.freeze([
  'render', 'write', 'reload', 'status', 'rollback', 'audit', 'notify',
]);

const EXPECTED_CAPABILITY_ENTRY = Object.freeze({
  injectionKind: 'code-owned-capability-injection',
  state: 'ready',
  codeOwnedResolverWired: true,
  dryRunCapabilityRegistryReady: true,
  executeCapabilityRegistryReady: false,
  realCapabilityImplementationsReady: false,
  realRunnerWiringReady: false,
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  hostSideEffectOccurred: false,
  launchctlAllowed: false,
  filesystemWriteAllowed: false,
  processListReadAllowed: false,
  networkAllowed: false,
  blockerCode: null,
  evidenceCode: 'capability-injection-ready',
});
```

Assert readiness:

```js
const r = buildSupervisorLifecycleGuardedRunnerCapabilityInjectionReadiness();
assert.strictEqual(r.state, 'ready');
assert.strictEqual(r.pureCapabilityInjectionReady, true);
assert.strictEqual(r.codeOwnedCapabilityFactoryReady, true);
assert.strictEqual(r.dryRunCapabilityRegistryReady, true);
assert.strictEqual(r.executeCapabilityRegistryReady, false);
assert.strictEqual(r.realCapabilityImplementationsReady, false);
assert.strictEqual(r.realRunnerWiringReady, false);
assert.strictEqual(r.executeCapabilityAuthorized, false);
assert.strictEqual(r.readyCount, 1);
assert.strictEqual(r.blockedCount, 0);
assert.deepStrictEqual(r.nextBlockers, [REAL_WIRING_MISSING]);
assert.deepStrictEqual(r.capabilityKinds, [...CAPABILITY_KINDS]);
// entry side-effect / real flags all false
```

Assert resolve (install production candidates):

```js
const d = resolveSupervisorLifecycleGuardedRunnerCapabilityInjection(installCandidates, 'install');
assert.strictEqual(d.state, 'resolved');
assert.strictEqual(d.capabilityInjectionReady, true);
assert.strictEqual(d.dryRunCapabilityRegistryReady, true);
assert.strictEqual(d.executeCapabilityAuthorized, false);
assert.strictEqual(d.realCapabilityImplementationsReady, false);
assert.strictEqual(d.realRunnerWiringReady, false);
assert.strictEqual(d.runnerWiringContractReady, false);
assert.strictEqual(d.executionEligible, false);
assert.strictEqual(d.hostSideEffectOccurred, false);
assert.strictEqual(d.wouldExecute, false);
assert.strictEqual(d.wouldRun, false);
assert.strictEqual(d.wouldWrite, false);
assert.deepStrictEqual(d.nextBlockers, [REAL_WIRING_MISSING]);
// mappings: render/write/reload for install actions; implementationClass dry-run-non-side-effect
// supportsModes exactly ['dry-run']
// no handler/command/path fields on decision
assert.strictEqual(d.handler, undefined);
assert.strictEqual(d.commandString, undefined);
```

Fail-closed（§2.7 prototype 防护）:

- empty / invalid candidates → unresolved allowlisted primary
- unknown action → `capability-action-unmapped` (or existing candidates-invalid family mapped per spec)
- invalid operation → `capability-operation-invalid`
- extra keys / `__proto__` / `constructor` / `prototype` / symbol keys / accessor descriptors / Proxy → fail-closed
- assert decision JSON-serializable (no functions)
- assert public returns use structuredClone or validated manual deep copy（非 assign/spread/JSON round-trip）

- [ ] **Step 2: Run RED**

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

- [ ] **Step 3: Implement maps + private registry + readiness/resolve (GREEN)**

In `src/supervisor-lifecycle.js`:

1. Constants: kinds allowlist, action→primary map, evidence/blocker codes, dry-run capabilityIds.
2. Module-private registry Map; `trustedBootstrapCapabilityRegistry()` registers **7 dry-run handlers by capabilityKind** + descriptors; validate class/modes/flags.
3. Each handler dispatches internally by `operation`+`actionId`（write: write vs remove；reload: load/unload/restart/start）；descriptor builder returns plain objects only.
4. `resolve...` validates candidates via existing ready helper patterns + §2.7 exact whitelist extraction; builds mappings in candidate order; never reads options/env.
5. Readiness fixed ready object with execute/real flags false and nextBlockers wiring-missing；§4.5 六 locus 均不存在/false.
6. Deep-copy all public returns via `structuredClone` or validated manual deep copy（function → fail-closed；禁止 assign/spread/JSON round-trip）。

- [ ] **Step 4: Run GREEN**

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

- [ ] **Step 5: Commit (only when user explicitly asks)**

```text
feat: add V1.31 capability injection registry contract
```

---

### Task 2: authorize mode + invokeDryRun + receipts（execute 单闸 hard-deny）

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

**Interfaces:**
- `authorizeSupervisorLifecycleGuardedRunnerCapabilityMode(request): object`
- `invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun(request): object` → capability receipt

- [ ] **Step 1: RED tests**

Dry-run authorize + invoke:

```js
const req = {
  capabilityKind: 'render',
  actionId: 'render-launch-agent-plist',
  operation: 'install',
  mode: 'dry-run',
  idempotencyKey: null,
  attemptRef: null,
  anchorRef: null,
};
const auth = authorizeSupervisorLifecycleGuardedRunnerCapabilityMode(req);
// dry-run path authorized surface (or equivalent state fields per impl)
assert.strictEqual(auth.executeCapabilityAuthorized, false);
assert.strictEqual(auth.hostSideEffectOccurred, false);

const receipt = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun(req);
assert.strictEqual(receipt.command, 'supervisor-lifecycle-guarded-runner-capability-receipt');
assert.strictEqual(receipt.receiptKind, 'capability-dry-run-receipt');
assert.strictEqual(receipt.state, 'completed');
assert.strictEqual(receipt.mode, 'dry-run');
assert.strictEqual(receipt.outcomeCode, 'capability-dry-run-completed');
assert.strictEqual(receipt.hostSideEffectOccurred, false);
assert.strictEqual(receipt.wouldMutateHost, false);
assert.strictEqual(receipt.wouldPersistAudit, false);
assert.strictEqual(receipt.wouldNotifyExternal, false);
assert.strictEqual(receipt.realRunnerWiringReady, false);
assert.strictEqual(receipt.executionEligible, false);
assert.strictEqual(receipt.executeCapabilityAuthorized, false);
assert.deepStrictEqual(receipt.nextBlockers, [REAL_WIRING_MISSING]);
assert.deepStrictEqual(receipt.auditSequence, [
  'authorize', 'mode-check', 'registry-lookup', 'anchor-plan',
  'invoke', 'receipt', 'audit-plan', 'notify-plan',
]);
assert.strictEqual(receipt.redaction.secretsRedacted, true);
assert.strictEqual(receipt.redaction.pathsRedacted, true);
assert.strictEqual(receipt.idempotencyKeyFingerprint, null); // V1.31 固定 null；无 sentinel
// NOT a wiring plan seal
assert.strictEqual(receipt.sealReady, undefined);
assert.notStrictEqual(receipt.command, 'supervisor-lifecycle-guarded-runner-real-wiring-plan-seal');
// 生产可达 state 仅 completed|denied|error
assert.ok(['completed', 'denied', 'error'].includes(receipt.state));
```

Cover all 7 kinds at least once (write/reload/status/rollback/audit/notify).

**write / reload actionId 分派断言（dry-run 模拟分支可观测字段，如 plannedMutation / outcome detail）：**

```js
// write: write/create/update vs remove/delete 必须区分
const writeRc = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun({
  capabilityKind: 'write', actionId: 'write-launch-agent-plist',
  operation: 'install', mode: 'dry-run', idempotencyKey: null, attemptRef: null, anchorRef: null,
});
const removeRc = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun({
  capabilityKind: 'write', actionId: 'remove-launch-agent-plist',
  operation: 'uninstall', mode: 'dry-run', idempotencyKey: null, attemptRef: null, anchorRef: null,
});
assert.strictEqual(writeRc.state, 'completed');
assert.strictEqual(removeRc.state, 'completed');
// 实现须暴露可断言的分支证据（例如 plannedAction 或 auditSequence 子步），write ≠ remove

// reload: load / unload / restart / start 必须区分
for (const [actionId, operation] of [
  ['load-launch-agent', 'install'],
  ['unload-launch-agent', 'uninstall'],
  ['restart-previous-supervisor', 'rollback'],
  ['start-recovery-supervisor', 'recover'],
]) {
  const rc = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun({
    capabilityKind: 'reload', actionId, operation, mode: 'dry-run',
    idempotencyKey: null, attemptRef: null, anchorRef: null,
  });
  assert.strictEqual(rc.state, 'completed');
  assert.strictEqual(rc.hostSideEffectOccurred, false);
}
```

Execute **单闸** hard-deny（V1.31：无 real handler；立即 deny；不形成双闸）:

```js
// 构造 execute 请求时用 exact plain object（测试 fixture 可用字面量；生产路径用 whitelist extract）
const execReq = {
  capabilityKind: 'render',
  actionId: 'render-launch-agent-plist',
  operation: 'install',
  mode: 'execute',
  idempotencyKey: 'opaque-key-1',
  attemptRef: null,
  anchorRef: null,
};
const denied = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun(execReq);
// or authorize + dedicated path — must not host-mutate; must not call any handler
assert.strictEqual(denied.receiptKind, 'capability-execute-denied-receipt');
assert.strictEqual(denied.state, 'denied');
assert.ok([
  'capability-execute-hard-denied',
  'capability-execute-prerequisites-incomplete',
].includes(denied.primaryBlocker) || [
  'capability-execute-hard-denied',
  'capability-execute-prerequisites-incomplete',
].includes(denied.outcomeCode));
assert.strictEqual(denied.hostSideEffectOccurred, false);
assert.strictEqual(denied.executeCapabilityAuthorized, false);
assert.strictEqual(denied.realRunnerWiringReady, false);
assert.strictEqual(denied.executionEligible, false);
assert.strictEqual(denied.idempotencyKeyFingerprint, null);
// 不得产出 partial/timeout/rolled-back（生产路径）
assert.notStrictEqual(denied.state, 'partial');
assert.notStrictEqual(denied.state, 'timeout');
assert.notStrictEqual(denied.state, 'rolled-back');
```

Caller injection reject:

```js
const poisoned = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun({
  capabilityKind: 'render',
  actionId: 'render-launch-agent-plist',
  operation: 'install',
  mode: 'dry-run',
  idempotencyKey: null,
  attemptRef: null,
  anchorRef: null,
  handler: () => {},
  command: 'launchctl load',
  path: '/tmp/x',
});
// must fail closed — exact-key whitelist rejects extra keys OR explicit injection blocker
assert.notStrictEqual(poisoned.state, 'completed');
assert.strictEqual(poisoned.hostSideEffectOccurred, false);
```

Also:

- invalid mode → mode-invalid
- action/kind mismatch → unmapped / validation
- execute missing idempotencyKey → deny (idempotency-key-missing)；fingerprint 仍 null
- timeout/partial **仅** via **internal test helper**（非 request field、非生产可达 state）；`rolled-back` V1.31 不产出
- receipt must be JSON.stringify-safe；无 function
- 返回物深拷贝：mutate 返回对象不得污染 registry / 下次调用

- [ ] **Step 2: Run RED**

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

- [ ] **Step 3: Implement authorize + invokeDryRun (GREEN)**

1. Exact-key request whitelist extraction（§2.7：`Object.hasOwn` + data-descriptor；拒绝 `__proto__`/symbol/extra；**禁止** assign/spread/JSON 清洗）。
2. Mode：required field；缺失 → `capability-mode-invalid`（不默认 execute；与 spec §4.1 fail-closed 一致）。
3. Execute branch：**单闸 immediate hard-deny receipt**；**不**调用任何 handler；**不**声称双闸（V1.32 才在 real dispatch 前重验公式）。
4. Dry-run branch：按 kind 查 private handler；handler 内 `operation`+`actionId` 分派；产出 dry-run receipt；全 side-effect false。
5. Redaction：永不回显 raw idempotency key；**`idempotencyKeyFingerprint` 固定 null**（禁止含糊 sentinel）。
6. Shared receipt base builder：固定 false real-wiring 字段 + nextBlockers wiring-missing；生产 state 仅 completed|denied|error。
7. 公共返回：`structuredClone` 或 validated manual deep copy；function → fail-closed。

- [ ] **Step 4: Run GREEN**

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

- [ ] **Step 5: Commit when user asks**

```text
feat: add V1.31 capability dry-run invoke and execute hard-deny
```

---

### Task 3: Gate integration

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

**Interfaces:**
- `buildSupervisorLifecycleGuardedRunnerExecutionGate` attaches `capabilityInjectionDecision` (+ optional receipt summary)
- `gates.capabilityInjectionReady` / `gates.dryRunCapabilityRegistryReady` local booleans
- wiring may nest `capabilityInjectionReadiness` but stays blocked + wiring-missing

- [ ] **Step 1: RED gate tests**

Production ready path (reuse V1.30 install fixtures + executeRequested true):

```js
assert.strictEqual(result.gates.capabilityInjectionReady, true);
assert.strictEqual(result.gates.dryRunCapabilityRegistryReady, true);
assert.strictEqual(result.capabilityInjectionDecision.state, 'resolved');
assert.strictEqual(result.capabilityInjectionDecision.executeCapabilityAuthorized, false);
assert.strictEqual(result.capabilityInjectionDecision.realCapabilityImplementationsReady, false);
assert.strictEqual(result.capabilityInjectionDecision.hostSideEffectOccurred, false);
// V1.30 surface preserved
assert.strictEqual(result.gates.pureWiringOrchestratorPlanReady, true);
assert.strictEqual(result.wiringPlan.mode, 'plan-only');
assert.strictEqual(result.wiringPlanSeal.state, 'seal-ready');
assert.strictEqual(result.wiringPlanSeal.sealReady, true);
// real wiring / execution still blocked
assert.strictEqual(result.executionEligible, false);
assert.strictEqual(result.wouldExecute, false);
assert.strictEqual(result.realRunnerWiringReady, false);
assert.strictEqual(result.gates.realRunnerWiringReady, false);
assert.strictEqual(result.gates.runnerWiringContractReady, false);
assert.deepStrictEqual(result.nextBlockers, [REAL_WIRING_MISSING]);
assert.ok(result.blockers.includes(REAL_WIRING_MISSING));
assert.strictEqual(result.policyDecision.state, 'authorized');
assert.strictEqual(result.policyDecision.primaryBlocker, null);
// not a policy fact
assert.strictEqual(Object.hasOwn(result.policyDecision, 'capabilityInjectionReady'), false);
// V1.25–V1.29 real facts still false
assert.strictEqual(result.adapterDecision.realHostMutationImplementationReady, false);
assert.strictEqual(result.anchorDecision.realRollbackAnchorImplementationReady, false);
assert.strictEqual(result.auditDecision.realAttemptAuditImplementationReady, false);
assert.strictEqual(result.recoveryDecision.realOperatorRecoveryImplementationReady, false);
assert.strictEqual(result.runnerWiringContract.readyCount, 6);
assert.strictEqual(result.runnerWiringContract.blockedCount, 0);
assert.strictEqual(result.runnerWiringContract.state, 'blocked');
```

Override rejection:

```js
const poisoned = buildSupervisorLifecycleGuardedRunnerExecutionGate(productionArgs, {
  executeRequested: true,
  capabilityInjectionDecision: { state: 'resolved', executeCapabilityAuthorized: true },
  capabilityReceipt: { state: 'completed', mode: 'execute', hostSideEffectOccurred: true },
  handlers: { render: () => {} },
  capabilities: [{ capabilityKind: 'render', handler: () => {} }],
  realCapabilityImplementationsReady: true,
  realRunnerWiringReady: true,
  runnerWiringContractReady: true,
  executionEligible: true,
});
assert.strictEqual(poisoned.realRunnerWiringReady, false);
assert.strictEqual(poisoned.executionEligible, false);
assert.strictEqual(poisoned.gates.runnerWiringContractReady, false);
assert.strictEqual(poisoned.capabilityInjectionDecision.executeCapabilityAuthorized, false);
assert.strictEqual(poisoned.capabilityInjectionDecision.hostSideEffectOccurred, false);
assert.deepStrictEqual(poisoned.nextBlockers, [REAL_WIRING_MISSING]);
```

- [ ] **Step 2: Run RED**

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

- [ ] **Step 3: Implement gate integration (GREEN)**

Inside `buildSupervisorLifecycleGuardedRunnerExecutionGate` after wiring plan/seal:

1. Comment: ignore options capability overrides/handlers.
2. readiness + resolve from production candidates/operation only.
3. Derive `capabilityInjectionReady` with **full** strict conjunction from spec §5.1.
4. Attach fields; keep hardcode false for execution/real wiring facts; keep wiring-missing.
5. Optionally attach one dry-run receipt summary for primary action (identifiers only) — if attached, must be dry-run receiptKind and hostSideEffectOccurred false.
6. Do **not** add capability facts to `POLICY_FACT_KEYS`.
7. Do **not** flip wiring aggregate out of blocked.

- [ ] **Step 4: Run GREEN**

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

- [ ] **Step 5: Commit when user asks**

```text
feat: wire V1.31 capability injection into execution gate
```

---

### Task 4: API / CLI 透传（无 agent.js/server.js 改动）

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

- [ ] **Step 2: Extend assertions (if needed)**

Assert response/CLI JSON includes:

- `capabilityInjectionDecision.state` string resolved/unresolved
- `gates.capabilityInjectionReady` boolean
- still `executionEligible:false`, `realRunnerWiringReady:false`, `runnerWiringContractReady:false`
- still contains `real-guarded-runner-execution-wiring-missing`
- still includes V1.30 `wiringPlan` / `wiringPlanSeal`

- [ ] **Step 3: GREEN**

If tests fail only due to missing assertions, update tests. If they fail due to agent/server needing changes, **stop** and escalate PM scope — do not silently edit agent/server.

---

### Task 5: Web canonical assembly（方案 A 保持 + capability 行 **必须 / shall**）

**Files:**
- Modify: `src/web/app.js`
- Modify: `test/web-console.test.js`

- [ ] **Step 1: RED tests**

Ready path view model must match:

```text
policyDecision:state:authorized:authorized:true:wouldAuthorizeExecution:true:primaryBlocker:none
executionSentinel:state:blocked:executionEligible:false:blocker:real-guarded-runner-execution-wiring-missing
wiringPlan:state:planned:planReady:true:realRunnerWiringReady:false:mode:plan-only:blocker:none
wiringPlanSeal:state:seal-ready:sealReady:true:realRunnerWiringReady:false:blocker:none
capabilityInjection:state:resolved:dryRunReady:true:executeReady:false:realRunnerWiringReady:false:blocker:none
```

If receipt line implemented:

```text
capabilityReceipt:kind:dry-run:state:completed:hostSideEffectOccurred:false:realRunnerWiringReady:false:blocker:none
```

validationLines must include:

```text
capabilityInjectionReady:true
dryRunCapabilityRegistryReady:true
executeCapabilityAuthorized:false
realCapabilityImplementationsReady:false
pureWiringOrchestratorPlanReady:true
realRunnerWiringReady:false
runnerWiringContractReady:false
executionEligible:false
```

Malicious cases: no secret echo; sentinel still blocked; no `executionEligible:true`; no `executeReady:true` on ready path.

- [ ] **Step 2: Implement view model helpers (GREEN)**

- Reuse strict canonical assembly style from V1.30.
- **Must (shall)** emit capabilityInjection fixed line.
- **Never** drop executionSentinel / wiringPlan / wiringPlanSeal lines.
- **Never** label capabilityReceipt as wiringPlanSeal / persisted audit.
- Map null policy primary → `none` only on authorized path.

- [ ] **Step 3: Run**

```bash
node --test test/web-console.test.js
```

---

### Task 6: Version / README / Gold

**Files:**
- Modify: `src/version.js`
- Modify: `README.md`
- Modify: `src/gold-readiness.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js` if version string asserted

- [ ] **Step 1: RED — version + gold evidence expectations**

Gold `automation-installation` (and production-hardening mirror if present) evidence must include strings such as:

```text
buildSupervisorLifecycleGuardedRunnerCapabilityInjectionReadiness
resolveSupervisorLifecycleGuardedRunnerCapabilityInjection
authorizeSupervisorLifecycleGuardedRunnerCapabilityMode
invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun
pureCapabilityInjectionReady
dryRunCapabilityRegistryReady
executeCapabilityAuthorized:false
realCapabilityImplementationsReady:false
capability-dry-run-receipt
capability-execute-denied-receipt
hostSideEffectOccurred:false
realRunnerWiringReady:false
runnerWiringContractReady:false
executionEligible:false
real-guarded-runner-execution-wiring-missing
readyCount:6
blockedCount:0
wiringPlanSeal.state:seal-ready
```

nextStep must state:

- V1.31 adds code-owned capability injection + dry-run registry + execute **single-gate** immediate hard-deny（无 real handler；非双闸）
- dry-run receipts are NOT wiringPlanSeal / NOT real host evidence
- **does not** set realRunnerWiringReady / runnerWiringContractReady / executionEligible true
- §4.5 六证据 locus（idempotency/rollback/audit/recovery-notify/dual-host/failure-injection）V1.31 不存在/false
- next step：按 7 capability kind 注册 real handlers；handler 内 operation+actionId dispatch；dispatch 前重验完整 execute 公式形成双闸
- Gold remains blocked

README current version **V1.31** with honest capability-injection boundary wording (mirror V1.30 style).

- [ ] **Step 2: Implement docs/scorecard updates (GREEN)**

- [ ] **Step 3: Run**

```bash
node --test test/gold-readiness.test.js test/readme.test.js
```

---

### Task 7: Full regression + side-effect / sensitive scan + scope check

- [ ] **Step 1: Full test**

```bash
node --test
```

- [ ] **Step 2: Diff scope check（相对 7ac8d6c）**

```bash
git diff --name-only 7ac8d6c
git diff --stat 7ac8d6c
```

Allowed paths only (implementation phase):

- `src/supervisor-lifecycle.js`
- `src/web/app.js`
- `src/gold-readiness.js`
- `src/version.js`
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
- public `registerCapability` / options.handlers acceptance

Report **counts by category**, not secret values.

- [ ] **Step 4: Honesty final matrix**

| Check | Expected |
| --- | --- |
| capabilityInjectionReady possible | yes |
| dry-run receipt completed possible | yes |
| execute architecture | **单闸** immediate hard-deny + 无 real handler（非双闸） |
| executeCapabilityAuthorized | false |
| realCapabilityImplementationsReady | false |
| §4.5 六证据 locus | 均不存在 / false |
| receipt 生产 state | completed \| denied \| error only |
| partial/timeout | 仅 harness；rolled-back 不产出 |
| idempotencyKeyFingerprint | 固定 null |
| write/reload actionId 分派 | write≠remove；load≠unload≠restart≠start |
| prototype 防护 §2.7 | exact whitelist；structuredClone/validated copy |
| `realRunnerWiringReady` | false |
| `runnerWiringContractReady` | false |
| `executionEligible` | false |
| wiring-missing present | yes |
| wiringPlanSeal still plan-only | yes |
| policy authorized ready path | yes |
| executionSentinel blocked | yes |
| Gold status | blocked |
| host side effects | none |
| caller handler injection | rejected/ignored |

- [ ] **Step 5: Commit when user asks**

```text
feat: complete V1.31 capability injection dry-run boundary
```

Do **not** push unless user explicitly requests.

---

## RED→GREEN 总矩阵（实现验收速查）

| Task | RED focus | GREEN focus |
| --- | --- | --- |
| 1 | readiness/resolve + 10-action maps + §2.7 pollution | 7-kind private dry-run registry + whitelist extract + deep copy |
| 2 | dry-run receipts + **单闸** hard-deny + write/reload 分派 + fingerprint null | authorize/invokeDryRun + receipt 可达 state |
| 3 | gate fields + hardcode false wiring facts + locus false | production-derived capability facts |
| 4 | API/CLI shape | test-only updates; no agent/server |
| 5 | Web dual locus + wiring + **shall** capability lines | canonical assembly |
| 6 | version/README/Gold evidence + 单闸/占位 locus 措辞 | static scorecard honesty |
| 7 | full suite + scope/scan + honesty matrix | release-ready boundary only |

---

## 完成标准（实现阶段验收）

1. Capability interface + 7-kind dry-run registry + resolve/readiness/authorize/invokeDryRun exist and are fail-closed.
2. Public APIs never accept/return functions/commands/shell; caller injection rejected; **§2.7** exact whitelist + `Object.hasOwn`/data-descriptor + `structuredClone`/validated deep copy；function 不可 clone → fail-closed。
3. Dry-run invoke yields `capability-dry-run-receipt` (**NOT** `wiringPlanSeal`).
4. Execute is **单闸 immediate hard-deny**（无 real handler；**非**双闸）；`executeCapabilityAuthorized:false`；`hostSideEffectOccurred:false`。
5. Production gate ready path can expose `gates.capabilityInjectionReady:true` **while** `realRunnerWiringReady:false`, `runnerWiringContractReady:false`, `executionEligible:false`.
6. Gate + wiring still carry `real-guarded-runner-execution-wiring-missing`.
7. Wiring aggregate remains `readyCount:6` / `blockedCount:0` / `state:'blocked'`.
8. All V1.25–V1.30 `real*ImplementationReady` and side-effect would\* / \*Allowed remain false；§4.5 六证据 locus 均不存在/false。
9. Policy ready path remains authorized; Web keeps executionSentinel blocked **and shall** render capabilityInjection line; V1.30 wiring lines remain.
10. No `src/agent.js` / `src/server.js` / `package.json` changes.
11. No host side-effect calls.
12. Gold overall blocked; README labels V1.31 as capability injection + dry-run boundary (not real runner completion).
13. Recovery anchor `7ac8d6c` documented.
14. Receipt 生产可达 state **仅** `completed|denied|error`；`partial`/`timeout` 仅 harness；`rolled-back` V1.32+ 预留；`idempotencyKeyFingerprint` **固定 null**。
15. `write`/`reload` dry-run handlers 按 actionId/operation 分派（write≠remove；load≠unload≠restart≠start）；与 V1.32 real 7-kind 注册粒度一致。
16. **No claim** that real runner wiring、Gold release、或 V1.31 execute 双闸 is complete.

---

## V1.32 挂载指南（本版仅文档预留；实现阶段不写 real handlers）

```text
1. trustedBootstrap 按 7 capability kind 注册 real-side-effect handlers（非 10 action 各一）
2. handler 内 operation+actionId dispatch：
   write  → write/create/update vs remove/delete
   reload → load / unload / restart / start
3. 注册 real 后，每次 dispatch 前再次验证完整 executeCapabilityAuthorized 公式 → 双闸
4. 落地 §4.5 六 locus（idempotency store / real rollback / audit sink / recovery-notify / dual-host / failure-injection）
5. 抬升对应 real*ImplementationReady 后谓词化 realRunnerWiringReady / runnerWiringContractReady
```

---

## 实现后报告模板（给 agent）

```text
V1.31 实现完成（capability injection + dry-run boundary only）

基线锚点: 7ac8d6c
版本: V1.31

变更文件:
- （仅列实现阶段实际 diff 路径）

事实矩阵:
- readyCount/blockedCount: 6/0
- pureCapabilityInjectionReady: true
- dryRunCapabilityRegistryReady: true
- gates.capabilityInjectionReady (ready path): true
- execute architecture: 单闸 immediate hard-deny + 无 real handler（非双闸）
- executeCapabilityAuthorized: false
- realCapabilityImplementationsReady: false
- §4.5 loci (idempotency/rollback/audit/recovery-notify/dual-host/failure-injection): 均不存在/false
- capability receipt: dry-run completed OR execute denied OR error (NOT wiringPlanSeal)
- receipt 生产 state: completed|denied|error only；fingerprint: null
- write/reload actionId 分派: 已测
- prototype §2.7 + structuredClone/validated deep copy: 已测
- hostSideEffectOccurred: false
- pureWiringOrchestratorPlanReady: true (V1.30 preserved)
- wiringPlanSeal: seal-ready (plan-only)
- realRunnerWiringReady: false
- runnerWiringContractReady: false
- executionEligible: false
- nextBlockers: [real-guarded-runner-execution-wiring-missing]
- policy ready path: authorized / primary null
- executionSentinel: blocked
- Web capabilityInjection line: present (shall)
- Gold: blocked

测试:
- focused: PASS/FAIL
- full: PASS/FAIL

scope check: agent.js/server.js/package.json 未改
side-effect scan: 无新增 host API
敏感扫描: category counts only

下一步（非本版 / V1.32 挂载）:
- 按 7 capability kind 注册 real-side-effect handlers；handler 内 operation+actionId dispatch
- dispatch 前重验完整 execute 公式 → 双闸
- 落地 §4.5 六证据 locus
- 抬升 real*ImplementationReady 后谓词化 realRunnerWiringReady / runnerWiringContractReady
```

---

## 设计阶段（当前）完成定义

本 plan/spec 撰写阶段 **仅** 新增两份文档：

- `docs/superpowers/specs/2026-07-14-supervisor-lifecycle-runner-capability-injection-design.md`
- `docs/superpowers/plans/2026-07-14-supervisor-lifecycle-runner-capability-injection.md`

**不**改源码、**不**跑测试作为发布依据、**不**提交、**不**推送。
