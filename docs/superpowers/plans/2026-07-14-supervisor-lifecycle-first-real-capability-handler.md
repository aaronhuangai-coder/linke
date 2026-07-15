# V1.32 Supervisor Lifecycle First Real Capability Handler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After V1.31 **capability injection + dry-run registry + execute single-gate hard-deny**, mount the **first honest real implementation** on that interface: **`render` / `render-launch-agent-plist`**. Deliver code-owned deterministic plist rendering with `capability-real-implementation-receipt` (hash/size), keep **`hostSideEffectOccurred:false`**, set only local **`realRenderCapabilityImplementationReady:true`**, and keep **global** `realCapabilityImplementationsReady:false`, `executeCapabilityAuthorized:false`, `realRunnerWiringReady:false`, `runnerWiringContractReady:false`, `executionEligible:false`, gate primary **`real-guarded-runner-execution-wiring-missing`**, Web **`executionSentinel`**, and **Gold blocked**. Verify via **real-proof** API — **not** public execute. Do **not** execute launchctl/fs/process/network/audit-persist/notify. Do **not** accept caller-injected handlers.

**Architecture:** Extend module-private trusted bootstrap to keep **7 dry-run** handlers and add **1 real-implementation** handler for `render` only (`capabilityId:'real-render'`, `supportsModes:['real-proof']`, `sideEffectClass:'none'`). Export real-proof authorize/invoke pure APIs. Execute path remains deny; optionally recompute full execute formula for observable incomplete prerequisites. Gate/Web expose local realRender fact without elevating global real/wiring/execution facts. Pure renderer lives in `supervisor-lifecycle.js` with redacted program/config refs (no real paths).

**Tech Stack:** Node.js ESM, `node:crypto` (sha256), `node:test`, existing Web Console view model helpers, README/Gold static scorecard tests.

**Spec:** `docs/superpowers/specs/2026-07-14-supervisor-lifecycle-first-real-capability-handler-design.md`

**Recovery anchor:** `3cf4848` (`feat: add V1.31 runner capability injection`)

## Global Constraints

- Current release version becomes `V1.32`.
- This is **first real implementation (render only)** — **not** real host runner wiring completion, **not** host side effect, **not** execute authorization.
- **Terminology (must appear in code comments near registry):**
  - `real implementation` = real capability semantics + verifiable artifact（**真实产物非 stub**）
  - `host side effect` = host mutate/read-control/network/audit-persist/notify
  - **real 与 host side effect 正交**：render is real implementation with `hostSideEffectOccurred:false`
  - exact comment phrase（中或英，语义不得弱化）：`real=真实产物非stub，与host side effect正交`
- Do **not** set `realRunnerWiringReady:true`, `runnerWiringContractReady:true`, `executionEligible:true`, `executeCapabilityAuthorized:true`, or **global** `realCapabilityImplementationsReady:true`.
- Do **set** `realRenderCapabilityImplementationReady:true` only when bootstrap+descriptor contract holds.
- Do **not** set any side-effect `would*` / `*Allowed` true; `hostSideEffectOccurred` always false (including real-proof success).
- Do **not** remove or satisfy-away `real-guarded-runner-execution-wiring-missing`.
- Do **not** expand `POLICY_FACT_KEYS`.
- Do **not** add endpoint, CLI command, Web button, or request body field.
- Do **not** modify `src/agent.js`, `src/server.js`, or `package.json`.
- Do **not** call `writeLaunchdDryRun` / `writeFile` / launchctl / child_process / process list / network.
- Do **not** register real handlers for status/write/reload/rollback/audit/notify.
- Do **not** treat G0a dual-Mac PASS as capability dual-host execute locus.
- Do **not** produce completed `capability-execute-receipt`.
- Do **not** use `implementationClass:'real-side-effect'` for render (use `'real-implementation'`).
- Keep wiring aggregate `readyCount:6` / `blockedCount:0` / `state:'blocked'`.
- Keep `wiringPlan.mode:'plan-only'` and plan-only seal semantics.
- Keep policy ready path **authorized** / `primaryBlocker:null` when all existing facts true.
- Keep Web `executionSentinel` **恒** blocked.
- **Must (shall)** add Web realRender fixed line (T15).
- G0a real two-Mac PASS statements stay unchanged.
- Malicious fixtures use **opaque synthetic strings only**.
- Sensitive scans report **category hit counts only**.
- Do **not** change V1.24–V1.31 public pure contract semantics except additive fields listed in spec.
- Planning phase must not modify `src/`, `test/`, `README.md`, `package*`, or version files beyond this docs-only phase; implementation phase follows this plan.
- Do **not** create `actual-changes.txt`. Do **not** use `git reset --hard` as a routine recovery step in this plan.
- Do **not** introduce confusing aliases (`realWiringReady`, `renderReady` alone, `capabilitySeal`).
- **nested `renderInput`** 必须 **独立** exact snapshot（Object.hasOwn + data descriptor；reject symbol/dangerous/extra/getter/function/proxy；validated deep-copy）；**不得**只靠顶层 V1.31 snapshot。
- Exported proof 函数 JSDoc **必须**含：`@internal PROOF ONLY — do not expose via HTTP/CLI/Web endpoint`；server/agent **零引用**。
- RealRenderProof API **render-specific**：未来 real kind **不得**扩本 API 的 kind 范围复用；须独立 proof API 或另设计通用 framework。
- Renderer 字节规范锁定：UTF-8 exact prologue；Unix `\n` only；**无 trailing newline**；TAB 缩进；Label→ProgramArguments→StartInterval 键序；hash = sha256(UTF-8 exact bytes)。
- `xmlEscape` exact：`& < > " '` → `&amp; &lt; &gt; &quot; &apos;`；禁止 double escape；null/control **不得**进入 escape（validation-failed）。
- `renderedByteLength > 0 && < 8192`；fixed golden input → **exact** `contentSha256` 字符串断言。
- Side-effect scan **pass threshold：host mutation call sites = 0**。
- XML/plist 结构测试：**无新依赖**；golden 全文或行级结构断言（spec §4.3.4）。
- TDD 矩阵与 spec 同步为 **T1–T29**（含 fuzz T24–T26）。

### 固定字段 vs 动态 fact（禁止混淆）

| 名称 | 类型 | V1.32 语义 |
| --- | --- | --- |
| readiness `pureCapabilityInjectionReady` / `dryRunCapabilityRegistryReady` | **固定** | 保持 true |
| readiness `realRenderCapabilityImplementationReady` | **固定/bootstrap** | bootstrap 成功 → **true** |
| readiness `realCapabilityImplementationsReady` | **固定 false** | 全局 **false** |
| readiness `executeCapabilityRegistryReady` / `executeCapabilityAuthorized` | **固定 false** | **false** |
| `gates.capabilityInjectionReady` | **动态** | 仍要求全局 real/execute false（V1.31 谓词） |
| real-proof receipt | **动态** | completed 时带 hash/size |
| `realRunnerWiringReady` / `runnerWiringContractReady` / `executionEligible` | **固定 false** | 恒 false |
| wiring `readyCount`/`blockedCount` | **固定** | **6 / 0** |
| wiring aggregate `state` | **固定 blocked** | 仍 + wiring-missing |
| Web `executionSentinel:` | **固定 blocked** | 恒 wiring-missing |
| Web realRender 行 | **必须（shall）动态** | ready 仍带全局 real false + realRunnerWiringReady false |

### 诚实性检查清单（每个 task 收尾自检）

- [ ] `readyCount:6` / `blockedCount:0` 已断言
- [ ] `runnerWiringContractReady:false` 已断言
- [ ] `realRunnerWiringReady:false` 已断言
- [ ] `executionEligible:false` 已断言
- [ ] `executeCapabilityAuthorized:false` 已断言
- [ ] `realCapabilityImplementationsReady:false`（全局）已断言
- [ ] `realRenderCapabilityImplementationReady:true`（合法 path）已断言
- [ ] `hostSideEffectOccurred:false`（含 real-proof）已断言
- [ ] gate `nextBlockers` 仍为 `['real-guarded-runner-execution-wiring-missing']`
- [ ] ready path policy **authorized** / primary `null`
- [ ] Web：policy authorized + **executionSentinel blocked** + **shall** realRender 行
- [ ] real-implementation-receipt **不是** wiringPlanSeal / **不是** execute receipt
- [ ] dry-run 与 real-proof 可区分（capabilityId / receiptKind / hash）
- [ ] nested renderInput 独立 snapshot 已测；golden sha256 exact 已测
- [ ] `renderedByteLength > 0 && < 8192`；字节规范（`\n` only / 无 trailing newline）已锁
- [ ] null/control → validation-failed；xmlEscape 五字符 exact
- [ ] proof API `@internal PROOF ONLY`；server/agent 零引用；render-specific
- [ ] host mutation call sites = 0；无 agent/server/package 改动
- [ ] 注释含 `real=真实产物非stub，与host side effect正交`
- [ ] Gold blocked 边界保持

### Mode / class 公式（实现注释必须引用）

```text
dry-run (V1.31 unchanged):
  implementationClass = dry-run-non-side-effect
  supportsModes = ['dry-run']

real render (V1.32):
  implementationClass = real-implementation   # NOT real-side-effect
  sideEffectClass = none
  supportsModes = ['real-proof']              # NOT execute
  realImplementationReady = true (descriptor local)
  hostSideEffectOccurred = false always

executeCapabilityAuthorized = FULL multi-fact conjunction (spec §0.6 / V1.31 §4.3)
  → V1.32 implementation: STILL always false
  → on mode==='execute': deny receipt; do not call real or dry-run handler
  → optional: attach allowlisted missing-prerequisite codes from formula recompute

realRenderProofAuthorized = (spec §3.5 local formula)
  → does NOT require realRunnerWiringReady / dual-host / idempotency store
```

### 10 actions → primary capability（不变）

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
```

### programToken allowlist（exact）

```js
const REAL_RENDER_PROGRAM_TOKENS = Object.freeze(['linke-agent-run-once']);
// maps to fixed argv with __LINKE_REDACTED_PROGRAM_REF__ / __LINKE_REDACTED_CONFIG_REF__
```

### Outcome / evidence codes（增量）

```text
capability-real-render-completed
capability-real-render-validation-failed
capability-real-render-redaction-failed
evidence: capability-real-render-implementation-ready
receiptKind: capability-real-implementation-receipt
```

---

### Task 1: Dual-registry bootstrap + pure renderer + readiness fields

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

**Interfaces:**
- Extend `buildSupervisorLifecycleGuardedRunnerCapabilityInjectionReadiness()` fields
- module-private `realCapabilityRegistry` + pure `renderLaunchAgentPlistV1(renderInput)`
- extend `trustedBootstrapCapabilityRegistry()`

- [ ] **Step 1: Write failing tests (RED)**

```js
const REAL_WIRING_MISSING = 'real-guarded-runner-execution-wiring-missing';

const r = buildSupervisorLifecycleGuardedRunnerCapabilityInjectionReadiness();
assert.strictEqual(r.state, 'ready');
assert.strictEqual(r.pureCapabilityInjectionReady, true);
assert.strictEqual(r.dryRunCapabilityRegistryReady, true);
assert.strictEqual(r.realRenderCapabilityImplementationReady, true);
assert.strictEqual(r.realCapabilityImplementationsReady, false);
assert.strictEqual(r.executeCapabilityRegistryReady, false);
assert.strictEqual(r.executeCapabilityAuthorized, false);
assert.strictEqual(r.realRunnerWiringReady, false);
assert.deepStrictEqual(r.nextBlockers, [REAL_WIRING_MISSING]);
// realImplementationEntries length 1, kind render, capabilityId real-render
// implementationClass real-implementation, supportsModes ['real-proof']
// no handler/function fields on public readiness
assert.strictEqual(r.handler, undefined);
```

Also assert dry-run kinds still 7 and status/write have **no** real entry.

- [ ] **Step 2: Run RED**

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

- [ ] **Step 3: Implement bootstrap + pure renderer + readiness (GREEN)**

In `src/supervisor-lifecycle.js`:

1. Add `realCapabilityRegistry = new Map()` (module-private).
2. Add constants: templateId, programToken allowlist, redacted refs, evidence/outcome codes, `REAL_IMPLEMENTATION_CLASS = 'real-implementation'`.
3. Implement `xmlEscape` **exact 五字符映射**（`& < > " '`；单次字符迭代；禁止 double escape；**不**接受 null/control）。
4. Implement `pureRenderLaunchAgentPlistV1({label, scheduleSeconds, programToken})`：
   - exact XML prologue UTF-8：`<?xml version="1.0" encoding="UTF-8"?>`
   - Unix `\n` only；**无 trailing newline**（`.join('\n')` 语义）
   - TAB 缩进；dict 键序 Label → ProgramArguments → StartInterval
   - redacted program/config refs；reject unknown token；**no fs/path**
   - hash 输入 = UTF-8 exact bytes（`createHash('sha256').update(buf)`）
5. Extend `trustedBootstrapCapabilityRegistry`:
   - keep dry-run registration for 7 kinds
   - register only render real descriptor+handler stub (handler may throw until Task 2; or return structure — Task 2 fills)
   - validate class/modes/flags
6. Extend readiness object with `realRenderCapabilityImplementationReady`, global false flags, `realImplementationEntries` plain summaries.
7. Public returns via `capabilityPublicDeepCopy` / structuredClone; function → fail-closed.
8. Comments **exact 语义**：`real=真实产物非stub，与host side effect正交`；execute formula still incomplete.

- [ ] **Step 4: Run GREEN**

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

- [ ] **Step 5: Commit (only when user explicitly asks)**

```text
feat: add V1.32 real render registry readiness contract
```

---

### Task 2: real-proof authorize/invoke + receipts + execute deny formula snapshot

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

**Interfaces:**
- `authorizeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(request): object`
- `invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(request): object`
- `invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun` execute branch remains deny (optional formula missing codes)

- [ ] **Step 1: RED tests**

Dry-run regression (must keep no hash):

```js
const dry = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun({
  capabilityKind: 'render',
  actionId: 'render-launch-agent-plist',
  operation: 'install',
  mode: 'dry-run',
  idempotencyKey: null,
  attemptRef: null,
  anchorRef: null,
});
assert.strictEqual(dry.receiptKind, 'capability-dry-run-receipt');
assert.strictEqual(dry.capabilityId, 'dry-run-render');
assert.strictEqual(dry.renderResult, undefined);
assert.strictEqual(dry.hostSideEffectOccurred, false);
```

Real-proof happy path:

```js
const req = {
  capabilityKind: 'render',
  actionId: 'render-launch-agent-plist',
  operation: 'install',
  mode: 'real-proof',
  idempotencyKey: null,
  attemptRef: null,
  anchorRef: null,
  renderInput: {
    label: 'com.linke.test.agent',
    scheduleSeconds: 3600,
    programToken: 'linke-agent-run-once',
  },
};
const auth = authorizeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(req);
assert.strictEqual(auth.state, 'authorized'); // or equivalent
assert.strictEqual(auth.executeCapabilityAuthorized, false);
assert.strictEqual(auth.hostSideEffectOccurred, false);

const rc = invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(req);
assert.strictEqual(rc.command, 'supervisor-lifecycle-guarded-runner-capability-receipt');
assert.strictEqual(rc.receiptKind, 'capability-real-implementation-receipt');
assert.strictEqual(rc.state, 'completed');
assert.strictEqual(rc.mode, 'real-proof');
assert.strictEqual(rc.capabilityId, 'real-render');
assert.strictEqual(rc.implementationClass, 'real-implementation');
assert.strictEqual(rc.outcomeCode, 'capability-real-render-completed');
assert.strictEqual(rc.hostSideEffectOccurred, false);
assert.strictEqual(rc.realRenderCapabilityImplementationReady, true);
assert.strictEqual(rc.realCapabilityImplementationsReady, false);
assert.strictEqual(rc.executeCapabilityAuthorized, false);
assert.strictEqual(rc.realRunnerWiringReady, false);
assert.strictEqual(rc.executionEligible, false);
assert.strictEqual(rc.idempotencyKeyFingerprint, null);
assert.deepStrictEqual(rc.nextBlockers, [REAL_WIRING_MISSING]);
assert.strictEqual(rc.renderResult.contentType, 'application/x-apple-plist-xml');
assert.strictEqual(rc.renderResult.templateId, 'code-owned-launch-agent-plist-v1');
assert.ok(rc.renderResult.renderedByteLength > 0);
assert.ok(rc.renderResult.renderedByteLength < 8192);
assert.match(rc.renderResult.contentSha256, /^[a-f0-9]{64}$/);
// T21 golden exact（GREEN 后锁定常量；禁止只 match 64-hex）
assert.strictEqual(rc.renderResult.contentSha256, GOLDEN_CONTENT_SHA256);
assert.strictEqual(rc.renderResult.deterministic, true);
// NOT seal / NOT execute receipt
assert.strictEqual(rc.sealReady, undefined);
assert.notStrictEqual(rc.receiptKind, 'capability-execute-receipt');
```

Determinism + non-stub + golden:

```js
const a = invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(req);
const b = invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof(req);
assert.strictEqual(a.renderResult.contentSha256, b.renderResult.contentSha256);
assert.strictEqual(a.renderResult.contentSha256, GOLDEN_CONTENT_SHA256);

const other = invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof({
  // 构造时用 exact whitelist 字段拷贝，测试 fixture 本身勿用污染对象
  capabilityKind: 'render',
  actionId: 'render-launch-agent-plist',
  operation: 'install',
  mode: 'real-proof',
  idempotencyKey: null,
  attemptRef: null,
  anchorRef: null,
  renderInput: {
    label: 'com.linke.other.agent',
    scheduleSeconds: 3600,
    programToken: 'linke-agent-run-once',
  },
});
assert.notStrictEqual(other.renderResult.contentSha256, a.renderResult.contentSha256);
```

Byte layout / XML structure（T22/T27；无新依赖）：

```js
// 通过 internal pure recompute helper（若 export 仅 test 可达）或 receipt 旁路
// assert.strictEqual(rendered, GOLDEN_PLIST_XML)  — exact multi-line
// assert.ok(!rendered.includes('\r'))
// assert.ok(!rendered.endsWith('\n'))  // 无 trailing newline
// 键序 Label → ProgramArguments → StartInterval；redacted refs 存在
```

Execute still deny (must not invoke real handler — spy via hash side channel: execute must not return renderResult):

```js
const denied = invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun({
  capabilityKind: 'render',
  actionId: 'render-launch-agent-plist',
  operation: 'install',
  mode: 'execute',
  idempotencyKey: 'opaque-key-1',
  attemptRef: null,
  anchorRef: null,
});
assert.strictEqual(denied.receiptKind, 'capability-execute-denied-receipt');
assert.strictEqual(denied.state, 'denied');
assert.strictEqual(denied.hostSideEffectOccurred, false);
assert.strictEqual(denied.executeCapabilityAuthorized, false);
assert.strictEqual(denied.renderResult, undefined);
// optional: denied.executeFormulaIncomplete === true or missingPrerequisiteCodes includes
// realCapabilityImplementationsReady / dual-host / etc. (allowlisted only)
```

Fail-closed + fuzz/boundary（T10–T12, T24–T26）：

- 顶层 extra keys / `handler` / `path` / `token` → reject
- **nested** `renderInput` extra / `__proto__` / symbol / accessor getter / function value / Proxy → reject（**独立** nested snapshot；不得只靠顶层）
- bad programToken → `capability-real-render-validation-failed`
- label: `''` / len129 / unicode(`'测'`) / `'\0'` / control → **`capability-real-render-validation-failed`**
- label len128 allowlisted charset → accept（边界）
- scheduleSeconds: 59 / 86401 / NaN / Infinity / 3600.5 → **`capability-real-render-validation-failed`**
- scheduleSeconds: 60 / 86400 → accept
- mode `execute` on proof API → mode-invalid / denied
- mode `real-proof` on dry-run API → mode-invalid or not completed as dry-run success with real hash
- status real-proof attempt → unmapped / not registered

- [ ] **Step 2: Run RED**

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

- [ ] **Step 3: Implement authorize + invoke proof + receipt builder (GREEN)**

1. **顶层** exact whitelist extraction（V1.31 §2.7 同构）**并且** **nested `renderInput` 独立** exact snapshot（spec §4.1.2）：
   - nested：`Object.hasOwn` + data descriptor；reject symbol / `__proto__`|`constructor`|`prototype` / extra / getter / function / Proxy
   - validated deep-copy 后再读字段；**禁止**只靠顶层 snapshot 后直接点源对象
2. 字段 validation：label/schedule/programToken 边界；null/control → **`capability-real-render-validation-failed`**
3. `authorize...RealRenderProof` implements §3.5 formula.
4. `invoke...RealRenderProof`: authorize → pure render → **UTF-8 exact bytes** sha256 → receipt；
   `renderedByteLength > 0 && < 8192`；all real/wiring/execute false flags；`hostSideEffectOccurred:false`。
5. Handler registered in bootstrap calls pure renderer (no IO).
6. Execute path in dry-run invoke: keep immediate deny; optional `missingPrerequisiteCodes` from pure formula helper (boolean sources only; no secrets).
7. Never return full plist by default (hash/size only) unless tests need internal pure recompute helper **not** exported with paths.
8. structuredClone returns; function fail-closed.
9. **JSDoc on both export functions（exact 行）：**
   ```js
   /**
    * @internal PROOF ONLY — do not expose via HTTP/CLI/Web endpoint
    * Render-specific proof API. Future real kinds must not expand this kind range;
    * require a separate proof API or a later generic framework.
    */
   ```
10. **禁止** 在此 API 内接受非 render kind（render-specific 合同）。

- [ ] **Step 4: Run GREEN**

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

- [ ] **Step 5: Commit when user asks**

```text
feat: add V1.32 real render proof invoke and receipts
```

---

### Task 3: Gate integration + resolve mapping fields

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

**Interfaces:**
- `buildSupervisorLifecycleGuardedRunnerExecutionGate` exposes local realRender fact
- `resolve...CapabilityInjection` install mapping includes realCapabilityId fields
- `gates.capabilityInjectionReady` still requires global real false

- [ ] **Step 1: RED gate tests**

Production ready path (reuse V1.31 install fixtures + executeRequested true):

```js
assert.strictEqual(result.gates.capabilityInjectionReady, true);
assert.strictEqual(result.gates.dryRunCapabilityRegistryReady, true);
assert.strictEqual(result.realRenderCapabilityImplementationReady, true);
// or gates.realRenderCapabilityImplementationReady — pick one locus and stick to it;
// prefer top-level + gates mirror both false-safe:
assert.strictEqual(result.gates.realRenderCapabilityImplementationReady, true);
assert.strictEqual(result.realCapabilityImplementationsReady, false);
assert.strictEqual(result.capabilityInjectionDecision.realCapabilityImplementationsReady, false);
assert.strictEqual(result.capabilityInjectionDecision.executeCapabilityAuthorized, false);
assert.strictEqual(result.executionEligible, false);
assert.strictEqual(result.wouldExecute, false);
assert.strictEqual(result.realRunnerWiringReady, false);
assert.strictEqual(result.gates.realRunnerWiringReady, false);
assert.strictEqual(result.gates.runnerWiringContractReady, false);
assert.deepStrictEqual(result.nextBlockers, [REAL_WIRING_MISSING]);
assert.strictEqual(result.policyDecision.state, 'authorized');
assert.strictEqual(result.policyDecision.primaryBlocker, null);
assert.strictEqual(result.runnerWiringContract.readyCount, 6);
assert.strictEqual(result.runnerWiringContract.blockedCount, 0);
assert.strictEqual(result.runnerWiringContract.state, 'blocked');
// V1.25–V1.29 real facts still false
assert.strictEqual(result.adapterDecision.realHostMutationImplementationReady, false);
assert.strictEqual(result.anchorDecision.realRollbackAnchorImplementationReady, false);
assert.strictEqual(result.auditDecision.realAttemptAuditImplementationReady, false);
assert.strictEqual(result.recoveryDecision.realOperatorRecoveryImplementationReady, false);
```

Override rejection:

```js
buildSupervisorLifecycleGuardedRunnerExecutionGate(..., {
  executeRequested: true,
  realRenderCapabilityImplementationReady: false, // must recompute true if bootstrap ok OR fail-closed ignore
  realCapabilityImplementationsReady: true, // MUST ignore → still false
  realRunnerWiringReady: true,
  executionEligible: true,
  handlers: { render: () => {} },
});
// assert still realCapabilityImplementationsReady false, executionEligible false, wiring-missing
```

Resolve mapping for install includes `realCapabilityId:'real-render'` on render action without functions.

- [ ] **Step 2: RED run**

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

- [ ] **Step 3: Implement gate/resolve integration (GREEN)**

1. Ignore options overrides for real/execute/wiring/executionEligible/handlers.
2. Derive local realRender from readiness/bootstrap probe only.
3. Keep `deriveCapabilityInjectionReady` requiring **global** `realCapabilityImplementationsReady === false`.
4. Hardcode executionEligible/realRunnerWiring false + wiring-missing nextBlockers.
5. Optional sanitized realRender summary on gate (no full hash required on gate; boolean ready is enough).

- [ ] **Step 4: GREEN run**

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

- [ ] **Step 5: Commit when user asks**

```text
feat: wire V1.32 real render fact into execution gate
```

---

### Task 4: Web view model shall line + validationLines

**Files:**
- Modify: `src/web/app.js`
- Modify: `test/web-console.test.js`

- [ ] **Step 1: RED**

Ready path must include:

```text
realRenderCapability:state:ready:realRenderReady:true:hostSideEffectOccurred:false:realCapabilityImplementationsReady:false:realRunnerWiringReady:false:blocker:none
```

And still:

```text
executionSentinel:state:blocked:executionEligible:false:blocker:real-guarded-runner-execution-wiring-missing
capabilityInjection:state:resolved:dryRunReady:true:executeReady:false:realRunnerWiringReady:false:blocker:none
```

validationLines must include:

```text
realRenderCapabilityImplementationReady:true
realCapabilityImplementationsReady:false
executeCapabilityAuthorized:false
hostSideEffectOccurred:false
realRunnerWiringReady:false
executionEligible:false
```

- [ ] **Step 2: Implement helpers mirroring capabilityInjection line builders**

- [ ] **Step 3: GREEN**

```bash
node --test test/web-console.test.js
```

- [ ] **Step 4: Commit when user asks**

```text
feat: show V1.32 real render capability line in web console
```

---

### Task 5: Gold + version + README

**Files:**
- Modify: `src/gold-readiness.js`
- Modify: `src/version.js`
- Modify: `README.md`
- Modify: `test/gold-readiness.test.js`
- Modify: any version-consistency tests if present

- [ ] **Step 1: RED**

- `LINKE_RELEASE_VERSION === 'V1.32'`
- Gold overall still blocked
- evidence includes:
  - `realRenderCapabilityImplementationReady:true`
  - `realCapabilityImplementationsReady:false`
  - `capability-real-implementation-receipt`
  - `hostSideEffectOccurred:false`
  - `invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof`
  - still `realRunnerWiringReady:false` / wiring-missing
- nextStep points to next real kind / §4.5 loci / dual-gate execute — **not** Gold ready
- README version blurb matches honest V1.32 scope

- [ ] **Step 2: Implement GREEN**

- [ ] **Step 3: Run**

```bash
node --test test/gold-readiness.test.js
node --test test/web-console.test.js
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

- [ ] **Step 4: Commit when user asks**

```text
docs: mark V1.32 first real render capability handler
```

---

### Task 6: Safety scan + full test + scope check

**Files:** none intentional; verification only

- [ ] **Step 1: Focused + full tests**

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
node --test test/web-console.test.js
node --test test/gold-readiness.test.js
node --test
```

- [ ] **Step 2: Scope check vs 3cf4848**

```bash
git diff --name-only 3cf4848 --
# expect only allowed files from spec §9.1
# must NOT include src/agent.js src/server.js package.json
```

- [ ] **Step 3: Host side-effect scan (category counts only；pass threshold 强制)**

```bash
# report counts only — do not print secrets
# Pass threshold: host mutation call sites = 0
# （相对 3cf4848 新增 / real render 路径；FAIL if any NEW host mutation call site）
rg -n "launchctl|child_process|execFile|spawn|writeFile|process\.kill|net\.|fetch\(" src/supervisor-lifecycle.js | wc -l
# real render path must not reference writeFile/launchctl/child_process
```

- [ ] **Step 4: Proof API exposure + scope 引用扫描**

```bash
# server/agent 必须 0 hits
rg -n "RealRenderProof" src/server.js src/agent.js || true
# export 处必须含 @internal PROOF ONLY 标记
rg -n "PROOF ONLY" src/supervisor-lifecycle.js
rg -n "真实产物非stub|host side effect 正交" src/supervisor-lifecycle.js
```

- [ ] **Step 5: Sensitive category scan on new receipt fixtures**

- no path/token/Authorization/hostname in test expected strings beyond opaque synthetics
- report category hit counts only

- [ ] **Step 6: Final honesty checklist** (Global Constraints list) + **T1–T29** 覆盖确认

- [ ] **Step 7: Commit when user asks (single squashed option)**

```text
feat: add V1.32 first real render capability handler
```

---

## Execution formula incompleteness (implementer note)

V1.32 **must not** claim dual-gate execute success. Minimum executable comment near execute deny:

```text
// V1.32: real-render exists for real-proof only.
// Full executeCapabilityAuthorized still false because e.g.:
// - realCapabilityImplementationsReady (global) false
// - executeCapabilityRegistryReady false (no execute-mode handlers)
// - realRunnerWiringReady / runnerWiringContractReady false
// - idempotency store absent
// - dual-host capability locus absent (G0a PASS is not this locus)
// - failure-injection suite evidence absent
// - other real*ImplementationReady false
// Therefore: deny execute; verify render via RealRenderProof API only.
// RealRenderProof is render-specific — do not expand kind range for future reals.
```

---

## Out of scope reminders

- real `status` observational handler (permissions/timeout/argv allowlist deferred)
- any host side effect capability
- public execute success / HTTP·CLI·Web 暴露 proof API
- 将 RealRenderProof 扩 kind 复用（须独立 proof API 或通用 framework 另设计）
- Gold ready
- G0a report rewrite
- agent.js plist path embedding parity (intentionally redacted refs)
- 引入 xml2js / fast-xml-parser / plist 等新依赖做结构测试

---

## RED→GREEN 总矩阵（实现验收速查；T 编号与 spec §10 同步）

| Task | RED focus | GREEN focus | T 覆盖 |
| --- | --- | --- | --- |
| 1 | readiness + pure renderer 字节/xmlEscape | bootstrap 双轨 + 注释正交 | T1–T2, T22–T23, T28–T29 |
| 2 | proof happy/golden/fuzz/nested snapshot/execute deny | authorize+invoke + receipt | T3–T12, T21, T24–T27 |
| 3 | gate local realRender + 全局 false | ignore overrides | T13–T14, T20 |
| 4 | Web shall realRender + sentinel | view model lines | T15 |
| 5 | Gold/version/README | scorecard evidence | T16 |
| 6 | full + scope + host mutation=0 + proof 零引用 | honesty matrix | T17–T19, T28 |

---

## 完成标准（实现阶段验收；与 spec §13 同步）

1. 选定 **render**；注释含 **`real=真实产物非stub，与host side effect正交`**；与 README 一致
2. trusted bootstrap **同时**注册 7 dry-run + 1 real render；identity/mode 正确
3. real-proof API 产出 `capability-real-implementation-receipt` + contentSha256/size；`hostSideEffectOccurred:false`；`renderedByteLength > 0 && < 8192`
4. **不是** dry-run stub：对照 + 确定性 + **golden sha256 exact** + XML/plist 结构（无新依赖）
5. execute 仍 hard-deny；**不**调 real handler
6. **仅** `realRenderCapabilityImplementationReady` 可 true；全局 real / wiring / execution / Gold 边界保持
7. Web shall realRender 行 + executionSentinel 恒 blocked
8. 无 agent.js / server.js / package.json 变更；**server/agent 零引用** proof API
9. **host mutation call sites = 0**；敏感扫描 category counts only
10. 恢复锚点 `3cf4848` 文档化
11. **不**宣称 Gold 发布或 real runner wiring 完成
12. nested `renderInput` **独立** exact snapshot（Object.hasOwn + data descriptor + reject symbol/dangerous/extra/getter/function/proxy + validated deep-copy）
13. export proof 函数 `@internal PROOF ONLY — do not expose via HTTP/CLI/Web endpoint`；**render-specific** 不扩 kind
14. 固定 renderer 字节规范 + `xmlEscape` 五字符 exact；null/control → **validation-failed**
15. TDD **T1–T29** 全覆盖（含 fuzz T24–T26）

---

## 实现后报告模板（给 agent；与 spec 同步）

```text
V1.32 实现完成（first real capability handler = render only）

基线锚点: 3cf4848
版本: V1.32

变更文件:
- （仅列实现阶段实际 diff 路径；须 ⊆ spec §9.1）

事实矩阵:
- readyCount/blockedCount: 6/0
- realRenderCapabilityImplementationReady: true
- realCapabilityImplementationsReady: false（全局）
- executeCapabilityAuthorized: false
- realRunnerWiringReady / runnerWiringContractReady / executionEligible: false
- hostSideEffectOccurred: false（含 real-proof）
- nextBlockers: [real-guarded-runner-execution-wiring-missing]
- receiptKind: capability-real-implementation-receipt（NOT execute / NOT wiringPlanSeal）
- renderedByteLength: >0 && <8192
- golden contentSha256: exact 断言通过
- nested renderInput independent snapshot: 已测
- proof API: @internal PROOF ONLY；render-specific；server/agent 引用=0
- xmlEscape 五字符 + 字节规范（UTF-8 / \n only / 无 trailing newline）: 锁定
- XML/plist 结构断言: 无新依赖
- 注释 real=真实产物非stub，与host side effect正交: 已写
- policy ready path: authorized / primary null
- executionSentinel: blocked
- Web realRender 行: present (shall)
- Gold: blocked

TDD: T1–T29 PASS/FAIL 摘要

测试:
- focused: PASS/FAIL
- full: PASS/FAIL

scope check: agent.js/server.js/package.json 未改；RealRenderProof 引用 server/agent=0
side-effect scan: host mutation call sites = 0（pass threshold）
敏感扫描: category counts only

下一步（非本版）:
- 下一 real kind：独立 proof API 或通用 framework（禁止扩 RealRenderProof kind）
- §4.5 loci / execute 双闸 / realRunnerWiringReady 谓词化
```

---

## 设计阶段（当前）完成定义

本轮 **仅** 修订两份文档（关闭 Qwen P1×6 + P2×5）：

- `docs/superpowers/specs/2026-07-14-supervisor-lifecycle-first-real-capability-handler-design.md`
- `docs/superpowers/plans/2026-07-14-supervisor-lifecycle-first-real-capability-handler.md`

**不**改源码/测试、**不**提交、**不**推送。

---

## Recovery

- Anchor: `3cf4848` — `feat: add V1.31 runner capability injection`
- On scope breach: discard in-progress src changes, restore clean tree at anchor, re-apply plan
- **Do not** document `git reset --hard` as a routine checkbox step
