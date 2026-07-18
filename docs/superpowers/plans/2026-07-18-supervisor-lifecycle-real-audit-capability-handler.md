# V1.34 Supervisor Lifecycle Real Audit Capability Handler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After V1.33 **second real status capability**, mount the **third honest real implementation** on the dual-track capability registry: **`capabilityKind=audit`** (cross-cutting). Deliver **independent append-only API behavior** to `audit/capability-proof-attempts.jsonl` via new `src/capability-audit-sink.js` (reuse `safe-data-files` only; **never** call `appendAuditEvent` / touch `audit/events.jsonl`). Verify via **independent async RealAuditProof** APIs — **not** expanded RealRender/StatusProof, **not** public execute, **not** HTTP/CLI/Web proof surface. Set only local **`realAuditCapabilityImplementationReady:true`**. Keep **global** `realCapabilityImplementationsReady:false` (3/7), `realAttemptAuditImplementationReady:false`, `executeCapabilityAuthorized:false`, `realRunnerWiringReady:false`, `runnerWiringContractReady:false`, `executionEligible:false`, gate primary **`real-guarded-runner-execution-wiring-missing`**, Web **`executionSentinel`**, and **Gold blocked 4/4/1/9**. This is **M6d-prep only** — **not** T6d.3 audit-chain-integrity, **not** M6d Exit, **not** production-hardening ready. Do **not** claim immutable/WORM/tamper-proof/idempotency/dedup/retention/rotation/Gold/GA/V2.0/cross-LAN. Preserve M1 Exit audit **temporal snapshot** (doc stays V1.33 @ `47dcc2d`); fix runtime test so it does **not** forever require current version V1.33.

**Architecture:** Extract pure shared SoT `src/supervisor-lifecycle-actions.js` (operation→actionIds + helpers; no lifecycle/sink imports) **before** sink. Lifecycle imports SoT: `ALLOWED_OPERATIONS` derived; `buildLifecycleActions` only attaches description/status/would* to shared IDs — **no second action-ID list**. Sink imports `isSupervisorLifecycleActionForOperation` for **existing + incoming** event validation (no ESM cycle). Extend trusted bootstrap to keep **7 dry-run + real-render + real-status**, add **1 real-audit** (`capabilityId:'real-audit'`, `supportsModes:['real-proof']`, `sideEffectClass:'audit-persist'`, `canPersistAuditInProof:true`, intent flags `wouldPersistAudit/auditWriteAllowed/filesystemWriteAllowed/wouldMutateHost:false`). Export audit-specific `authorize` (sync, request-only) / `invoke` (async, request+context). Sink API exact: `appendCapabilityRealAuditProofEvent(resolvedDataRoot, event)`. **Queue single ownership:** per-resolved-root queue, bounded pre-read, existing-line validation, incoming-event validation, and append **all and only** inside that sink function as **one** queue task; **`invoke MUST NOT maintain/enqueue a second queue`** and **MUST NOT pre-read** existing file; sink `capabilityAuditSinkQueues` Map is the **sole** queue SoT (no nested queue / second Map). Invoke order (fingerprint Option A): pure request/context shape → `assertSafeDataRoot` → fingerprint → sync inFlight `has→deny; add` → `await appendCapabilityRealAuditProofEvent(...)` → `finally` delete. Fingerprint **must null** on invalid request / invalid context shape / assertSafeDataRoot fail; **must 64hex** after fingerprint computed (same-inflight, malformed existing, incoming invalid, sink fail, success). JSONL preflight exact design §8.2 (1 MiB + **existing-file** 4096 validation bound — **not** retention; existing 4096 may append line 4097; next preflight with 4097 rejects). Incoming event validated at §8.5 same level as existing §8.3. When FileHandle provides `sync`, safeAppendText always awaits it (no caller off-switch). Success receipt: `hostSideEffectOccurred/hostMutationOccurred/auditPersistOccurred=true`, `mutationOutcome:'persisted'`. Gate/Web expose local realAudit readiness only with **non-live** occurred=false. **Temporal test fix before version bump** (no planned forced-red intermediate). All test writes use `fs.mkdtemp` under `os.tmpdir()` and existing cleanup patterns.

**Tech Stack:** Node.js ESM, `node:crypto` (sha256), `node:fs/promises` only via `safe-data-files`, `node:test`, existing Web/Gold/version/readme tests. **No new dependencies.** **Do not touch `package-lock.json`.**

**Spec:** `docs/superpowers/specs/2026-07-18-supervisor-lifecycle-real-audit-capability-handler-design.md`

**Recovery anchor (implementation):** clean tree commit **after** docs are committed (docs commit is separate). Current pre-docs worktree HEAD at plan authoring: `3405201` (`docs: record blocked v2 m1 exit audit`). Do **not** use `git reset --hard` as a routine step.

**Docs review gate:** This plan must pass **fresh review + PM** before any TDD code. GLM round2 `PROCEED` on design **≠** implementation complete.

---

## Final Decision (locked)

```text
SELECTED = real audit capability (cross-cutting) + independent sink
REJECTED = reuse appendAuditEvent / events.jsonl
REJECTED = expand RealRenderProof / RealStatusProof
REJECTED = generic multi-kind framework this milestone
REJECTED = T6d.3 complete / M6d Exit / production-hardening ready
REJECTED = execute / global real / wiring / realAttemptAudit ready
REJECTED = Gold/GA/V2.0/cross-LAN claims
REJECTED = second action-ID list / sink schema-indifferent / prefer-lifecycle-only validation
REJECTED = invoke second queue / invoke pre-read / nested queue / two queue Maps
REJECTED = fingerprint may/可有 on context/root fail (Option A: MUST null)
REJECTED = 4096 as retention/cap / "file never exceeds 4096" / delete-compaction-rotation
PROOF    = authorizeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(request)
           invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(request, context)
SOT      = src/supervisor-lifecycle-actions.js (unique pure operation/action IDs)
SINK     = src/capability-audit-sink.js → audit/capability-proof-attempts.jsonl
SINK_API = appendCapabilityRealAuditProofEvent(resolvedDataRoot, event)
QUEUE    = sole SoT capabilityAuditSinkQueues inside sink only
MODE     = real-proof only
OPS      = isSupervisorLifecycleOperation / shared frozen map
ACTIONS  = listSupervisorLifecycleActionIds(operation) only
```

### 拒绝方案（实现不得反转）

| ID | 拒绝 | 原因 |
| --- | --- | --- |
| R-Events | 复用 `events.jsonl` / `appendAuditEvent` | GLM round1 BLOCK；schema/retention/确定性冲突 |
| R-Expand | 扩 RealRender/StatusProof | 违反 V1.32/V1.33 合同 |
| R-OpAudit | `operation:'audit'` | operation 权威仅四生命周期 |
| R-CrossOp | 跨 operation action | pure SoT `isSupervisorLifecycleActionForOperation` 权威 |
| R-SecondList | lifecycle/sink 各持一份 action ID list | 唯一 SoT；lifecycle 仅包装 description |
| R-SinkSchemaIndifferent | sink 对 schema/op/action 无关 / prefer lifecycle validation only | 删除冲突表述；sink 必须 shared 校验 |
| R-SecondQueue | invoke 第二 queue / invoke pre-read / 嵌套 queue / 两套 Map | queue 唯一归属 sink；invoke 只 await sink API |
| R-FpOptional | context/root 失败路径 fingerprint may/可有 | Option A：shape/root fail **MUST null**；算后路径 **MUST 64hex** |
| R-Retention4096 | 把 4096 当 retention/cap / 宣称文件永不超过 4096 / delete-compact-rotate | 仅 existing validation bound；4096 可 append 成 4097 |
| R-Idem | idempotency/dedup store | 本版 null key；sequential duplicate 允许 |
| R-Worm | immutable/WORM/tamper-proof | 只称 append-only API behavior |
| R-M6d | M6d Exit / production-hardening ready | 仅 prep |
| R-Global | 全局 real/execute/wiring/realAttemptAudit true | 3/7 + 公式未满足 |
| R-Public | HTTP/CLI/Web proof surface | @internal only |
| R-Dep | 新 dependency / 改 lockfile | 禁止 |
| R-M1Rewrite | 改写 M1 audit 文档当时 V1.33 | temporal snapshot |
| R-AgentServer | 改 agent.js/server.js | public surface 冻结 |

---

## Global Constraints

- Release version becomes **`V1.34`** (implementation phase Task version).
- Milestone class: **V1.x audit milestone + M6d-prep** — not M6d Exit, not M7, not V2.0.
- Dual registry must become **7 dry-run + 3 real (render + status + audit)**.
- Local readiness only: `realAuditCapabilityImplementationReady:true`.
- Global **all false:** `realCapabilityImplementationsReady`, `executeCapabilityRegistryReady`, `realRunnerWiringReady`, `runnerWiringContractReady`, `executionEligible`, `executeCapabilityAuthorized`, `realAttemptAuditImplementationReady`.
- Descriptor intents stay false: `auditWriteAllowed`, `filesystemWriteAllowed`, `wouldPersistAudit`, `wouldMutateHost`; **options cannot elevate**.
- Descriptor local: `implementationClass:'real-implementation'`, `supportsModes:['real-proof']`, `sideEffectClass:'audit-persist'`, `canPersistAuditInProof:true`, `realImplementationReady:true`.
- `attemptRef` pattern exact: `^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$`; raw never stored/returned.
- `auditInput` exact `{schemaVersion:1}` only.
- `context` exact `{dataDir}` only; not in request; not returned; trusted internal, not tenant isolation claim.
- `assertSafeDataRoot` after pure request/context shape validation, before fingerprint/Set/sink; return value is `resolvedDataRoot`.
- Sink API exact: `appendCapabilityRealAuditProofEvent(resolvedDataRoot, event)` — **not** any `append…Line(dataDir,…)` legacy signature.
- Sink re-validates root/path via safeReadText/safeAppendText; caller string is **not** a security proof.
- **Queue single ownership:** queue key = resolvedDataRoot; **sole** Map lives in sink; pre-read + existing validation + incoming validation + append run **only** inside sink as one queue task; Map cleanup mandatory.
- **`invoke MUST NOT maintain/enqueue a second queue`** and **MUST NOT pre-read** existing sink file; forbid nested queue / two Maps.
- Pure SoT first: `src/supervisor-lifecycle-actions.js` before sink; lifecycle + sink both consume it.
- Fingerprints exact preimages (design §7); schemaVersion event+input shared space = 1.
- **Fingerprint Option A (no may/可有):** shape validation → assertSafeDataRoot → fingerprint → sync inFlight has/add → sink. **null** on invalid request / invalid context shape / assertSafeDataRoot fail; **64hex** only after fingerprint computed (same-inflight, malformed existing, incoming invalid, sink fail, success). same-inflight: compute fingerprint **then** `has`.
- Existing file fail-closed JSONL algorithm design §8.2 exact (1 MiB / **existing** 4096-line validation bound — **not** retention/cap; existing 4096 may append → 4097 lines; next preflight with existing 4097 rejects; no delete/compaction/rotation).
- Incoming event: design §8.5 same-level structural/type/enum/hash/op-action/key-order validation before append; invalid → sink-invalid, append not called, occurred false, file not poisoned.
- Inflight atomic: same sync section `if (inFlightSet.has(fp)) deny; inFlightSet.add(fp);` before any await/sink call; finally delete.
- safeAppendText: if FileHandle provides `sync`, implementation always awaits it; no caller off-switch; do not overclaim durability for test seams without `sync`.
- Sequential duplicate allowed; concurrent same fingerprint denied; no idempotency claim.
- Temporal test green on V1.33 **before** version bump to V1.34.
- Append failure after mutating call: `unknown-after-write-attempt` conservative truth.
- Gate/Web non-live: all occurred false; no event/result display.
- Gold remains **4 ready / 4 partial / 1 blocked / total 9 / overall blocked**; no `cross-lan-connectivity`.
- M1 Exit audit doc snapshot remains V1.33 @ `47dcc2d`; runtime test temporal split.
- No real production dataDir tests; only `mkdtemp`.
- Do not modify `src/audit-log.js` behavior; do not call `appendAuditEvent`.
- Do not modify `src/agent.js`, `src/server.js`, `package.json`, or stage/touch unrelated `package-lock.json`.
- Planning/docs phase must not modify `src/`, `test/`, README, version, gold beyond this plan's later tasks.
- Do not create `actual-changes.txt`. Do not use `git reset --hard` as routine recovery.
- Malicious fixtures: opaque synthetic strings only.
- Sensitive scans: category hit counts only.
- JSDoc on proof exports must include: `@internal PROOF ONLY — do not expose via HTTP/CLI/Web endpoint`.
- Comments near registry/sink must include design terminology contract (real audit / mutationOutcome / no events.jsonl / no global elevate / append-only API behavior only).

### 固定字段 vs 动态 fact

| 名称 | 类型 | V1.34 语义 |
| --- | --- | --- |
| readiness `realAuditCapabilityImplementationReady` | bootstrap | true when registry+descriptor ready |
| readiness `realCapabilityImplementationsReady` | 固定 false | 3/7 incomplete |
| readiness `realAttemptAuditImplementationReady` | 固定 false | not wiring ready |
| receipt `auditPersistOccurred` / mutation flags | 动态 | success true; gate/web false |
| `mutationOutcome` | 动态 enum | three-state |
| wiring 6/0 blocked + wiring-missing | 固定 | keep |
| Web executionSentinel | 固定 blocked | keep |
| Gold 4/4/1/9 blocked | 固定 | keep |

### 诚实性检查清单（每个 task 收尾自检）

- [ ] `realCapabilityImplementationsReady:false`（全局）
- [ ] `realAttemptAuditImplementationReady:false`
- [ ] `executeCapabilityAuthorized:false` / `executionEligible:false`
- [ ] `realRunnerWiringReady:false` / `runnerWiringContractReady:false`
- [ ] `realAuditCapabilityImplementationReady:true`（合法 path）
- [ ] success: sideEffect+mutation+persist true；`mutationOutcome:persisted`
- [ ] pre-append deny: all occurred false；`not-attempted`
- [ ] post-append throw: true/true/false；`unknown-after-write-attempt`
- [ ] fingerprint Option A: request/context/root fail → null；post-fp paths → 64hex
- [ ] queue sole SoT in sink；invoke no second queue / no pre-read
- [ ] incoming invalid → sink-invalid；append not called；file not poisoned
- [ ] 4096 = existing validation bound only（4096→append 4097；next 4097 reject；no retention）
- [ ] `wouldPersistAudit:false` 与 live persist 可并存
- [ ] events.jsonl untouched
- [ ] no agent/server proof refs
- [ ] Gold 4/4/1/9 blocked；无 cross-lan-connectivity
- [ ] M1 audit doc still V1.33 snapshot
- [ ] no package-lock / new deps
- [ ] mkdtemp only

### Mode / class 公式（实现注释必须引用）

```text
real audit (V1.34):
  implementationClass = real-implementation
  sideEffectClass = audit-persist
  supportsModes = ['real-proof']              # NOT execute
  canPersistAuditInProof = true
  wouldPersistAudit = false                   # intent
  auditWriteAllowed = false                   # intent
  filesystemWriteAllowed = false              # intent
  wouldMutateHost = false                     # intent
  # live receipt on success:
  hostSideEffectOccurred = true
  hostMutationOccurred = true
  auditPersistOccurred = true
  mutationOutcome = persisted

executeCapabilityAuthorized = FULL multi-fact conjunction
  → V1.34 implementation: STILL always false
  → on mode==='execute': deny; zero dispatch; zero sink write
```

### Operation → actions（唯一 pure SoT；测试矩阵必须覆盖）

**Module:** `src/supervisor-lifecycle-actions.js`（唯一权威；export frozen map + helpers）

```text
install:   render-launch-agent-plist, write-launch-agent-plist, load-launch-agent
uninstall: unload-launch-agent, remove-launch-agent-plist, remove-supervisor-metadata
rollback:  capture-current-state, restore-previous-plist, restart-previous-supervisor
recover:   start-recovery-supervisor
```

```js
// required exports
export const SUPERVISOR_LIFECYCLE_OPERATION_ACTION_IDS // frozen operation→actionIds
export function isSupervisorLifecycleOperation(value)
export function listSupervisorLifecycleActionIds(operation) // safe copy
export function isSupervisorLifecycleActionForOperation(operation, actionId)
```

- `src/supervisor-lifecycle.js` **must** import SoT; derive `ALLOWED_OPERATIONS`; local `buildLifecycleActions` only attaches description/status/would* to shared IDs.
- `src/capability-audit-sink.js` **must** import `isSupervisorLifecycleActionForOperation` for existing-event checks.
- Shared module imports **neither** lifecycle nor sink (no ESM cycle).
- All existing lifecycle tests must prove output **order/content unchanged**.
### Exact fingerprint preimages

```text
attemptRefFingerprint =
  sha256_utf8("linke:v1.34:real-audit-proof:attempt-ref:v1\x1f" + attemptRef) → 64 hex lower

eventFingerprint =
  sha256_utf8("linke:v1.34:real-audit-proof:event:v1\x1f1\x1f" + operation + "\x1f" + actionId + "\x1f" + attemptRef)
```

### Canonical event key order

```text
schemaVersion, eventKind, eventFingerprint, operation, actionId, attemptRefFingerprint, proofMode
```

### Fixed outcome/blocker codes（至少）

```text
capability-caller-injection-rejected
capability-mode-invalid
capability-kind-unknown
capability-action-unmapped
capability-operation-invalid
capability-idempotency-key-invalid
capability-real-audit-input-invalid
capability-real-audit-context-invalid
capability-real-audit-in-flight-denied
capability-real-audit-sink-invalid
capability-real-audit-persist-failed
capability-real-audit-persisted
```

---

## Commit boundaries（强制）

| Boundary | Contents | Message sketch（用户确认后才 commit） |
| --- | --- | --- |
| **C0 docs** | 仅两份 docs（本 design+plan） | `docs: design V1.34 real audit capability M6d-prep` |
| **C1 SoT** | `src/supervisor-lifecycle-actions.js` + lifecycle consume SoT + tests（顺序/内容不变） | `refactor: extract supervisor lifecycle action SoT` |
| **C2 sink** | `src/capability-audit-sink.js` + `test/capability-audit-sink.test.js` | `feat: add capability real-audit proof sink` |
| **C3 proof API** | lifecycle RealAuditProof + gate tests | `feat: add V1.34 real audit capability proof API` |
| **C4 gate/web honesty** | readiness/gate/web non-live + options | `feat: expose non-live realAudit readiness without elevating globals` |
| **C5 temporal→version** | **先** `test/cross-lan-m1-exit-audit.test.js` temporal（仍 V1.33 可绿）**再** version/gold/readme V1.34；可同 commit 或 temporal 独立 commit 在前 | `test: split M1 exit audit temporal semantics` then/with `chore: release milestone V1.34 real audit prep` |

- **Never** mix docs-only C0 with code.
- **Never** stage `package-lock.json` unless user explicitly asks (default: leave untracked).
- **Never** auto `git commit` / `git push` — user must confirm each boundary.
- **Never** bump version before temporal suite is green on V1.33 baseline (no planned forced-red intermediate for old suite).

---

## Fresh review / PM gate（代码前）

- [ ] **Step G1:** Fresh reviewer reads design + this plan against source facts (lifecycle / safe-data-files / audit-log / V1.32–V1.33 / M6 plan / M1 audit).
- [ ] **Step G2:** Confirm no P0: events.jsonl reuse, cross-op actions, global elevate, M6d Exit claim, M1 snapshot rewrite, public surface.
- [ ] **Step G3:** PM records `PROCEED` for **implementation** (separate from docs-only PROCEED).
- [ ] **Step G4:** Only then start Task 0+.

If review finds P0: **stop**; revise docs; do not code.

---

## Implementation Tasks（TDD）

### Task 0: Confirm baseline + fixture helpers (no product code)

**Files:**
- Read only: design, current `src/supervisor-lifecycle.js`, `src/safe-data-files.js`, `src/audit-log.js`, existing gate tests
- Optional test helper local to new tests only (in Task 1+)

- [ ] **Step 1:** Record baseline:

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js test/cross-lan-m1-exit-audit.test.js test/version.test.js
```

Expected: green on current V1.33 baseline (or document any pre-existing skip).

- [ ] **Step 2:** Confirm `package-lock.json` remains untracked/out-of-scope; do not stage.

- [ ] **Step 3:** No commit (unless user asks for docs C0 separately).

---

### Task 1: Pure operation/action SoT extraction — RED then GREEN（**sink 之前**）

**Files:**
- Create: `src/supervisor-lifecycle-actions.js`
- Create: `test/supervisor-lifecycle-actions.test.js`（或把精确覆盖并入既有 lifecycle tests；默认独立文件）
- Modify: `src/supervisor-lifecycle.js` — import/消费 SoT；删除第二份 action ID list
- Modify: existing lifecycle tests as needed to prove order/content unchanged

**Interfaces (minimum exact):**

```js
// src/supervisor-lifecycle-actions.js — pure; imports neither lifecycle nor sink
export const SUPERVISOR_LIFECYCLE_OPERATION_ACTION_IDS = Object.freeze({
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
  recover: Object.freeze([
    'start-recovery-supervisor',
  ]),
});

export function isSupervisorLifecycleOperation(value) { /* boolean */ }
export function listSupervisorLifecycleActionIds(operation) { /* safe copy array */ }
export function isSupervisorLifecycleActionForOperation(operation, actionId) { /* boolean */ }
```

**Lifecycle consume rules:**

```text
ALLOWED_OPERATIONS = derived from Object.keys(SUPERVISOR_LIFECYCLE_OPERATION_ACTION_IDS)
buildLifecycleActions(operation):
  for id of listSupervisorLifecycleActionIds(operation):
    attach existing description/status/wouldRun/wouldWrite fields only
  MUST NOT keep a second local action-ID array/map as authority
```

- [ ] **Step 1: RED tests**

1. frozen map keys exact `install|uninstall|rollback|recover`
2. each operation action IDs exact order + content (10 total)
3. `listSupervisorLifecycleActionIds` returns **copy** (mutate return does not corrupt SoT)
4. `isSupervisorLifecycleOperation` true/false matrix
5. `isSupervisorLifecycleActionForOperation` cross-op false / correct-op true
6. existing lifecycle suite: `buildLifecycleActions` / plan action order+content **byte-stable** vs pre-extract baseline

```bash
node --test test/supervisor-lifecycle-actions.test.js test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

Expected RED until module + lifecycle consume land.

- [ ] **Step 2: GREEN** implement pure module + lifecycle import; no sink yet.

- [ ] **Step 3: GREEN verify** same command + any other lifecycle tests that assert action lists.

- [ ] **Step 4: Commit boundary C1（仅当用户明确要求）**

```text
refactor: extract supervisor lifecycle action SoT
```

---

### Task 2: Independent sink module — RED then GREEN

**Files:**
- Create: `src/capability-audit-sink.js`
- Create: `test/capability-audit-sink.test.js`
- Read/import: `src/supervisor-lifecycle-actions.js`（`isSupervisorLifecycleActionForOperation`）
- Read/import: `src/safe-data-files.js`

**Interfaces (exact name + signature):**

```js
// src/capability-audit-sink.js
export const CAPABILITY_REAL_AUDIT_RELATIVE_PATH = 'audit/capability-proof-attempts.jsonl';
export const CAPABILITY_REAL_AUDIT_MAX_PRE_READ_BYTES = 1 * 1024 * 1024;
export const CAPABILITY_REAL_AUDIT_MAX_EVENT_LINES = 4096;

/**
 * Append one canonical event under resolved data root.
 * @internal append-only API behavior only — not immutable/WORM/tamper-proof.
 * Sole queue SoT: per-resolved-root serialization lives ONLY here.
 * @param {string} resolvedDataRoot
 *   invoke 对 exact context 做 assertSafeDataRoot 后返回的 root；
 *   该 assert 在 fingerprint / inFlightSet / sink call 前完成。
 *   sink 仍通过 safeReadText/safeAppendText 重新执行安全 root/path
 *   traversal/no-symlink 检查，不把 caller string 当安全证明。
 * @param {object} event canonical 7-key plain object
 * @returns {Promise<void>} success settle; throw path-free on fail
 *   error stage must align receipt truth:
 *   pre-append fail (existing/incoming/over-bound) → not-attempted / occurred false
 *   post mutating-call throw → unknown-after-write-attempt mapping at lifecycle
 */
export async function appendCapabilityRealAuditProofEvent(resolvedDataRoot, event)
```

**禁止：** 任何 `append…Line(dataDir,…)` 旧签名；禁止 sink 对 schema/op/action 无关或 prefer-lifecycle-only validation 表述；禁止 lifecycle/invoke 第二 queue 或嵌套 Map。

**queue task 单一归属（本函数内全部完成）：**

```text
enqueue capabilityAuditSinkQueues[resolvedDataRoot]  // sole Map SoT
  → bounded pre-read existing file
  → existing-line validation (§8.3)
  → incoming-event validation (§8.5; same level as §8.3)
  → serialize fixed-key-order JSON + '\n'
  → safeAppendText (if FileHandle.sync present → always await; no caller off-switch)
finally Map cleanup
```

**JSONL preflight algorithm（与 design §8.2 同步冻结；1 MiB bound 保留）：**

```text
if raw.length === 0 => empty allow
if !raw.endsWith('\n') => sink-invalid
body = raw.slice(0, -1)
lines = body === '' ? [] : body.split('\n')
if lines.some(line => line.length === 0) => internal blank => sink-invalid
if lines.length > 4096 => sink-invalid
  // 4096 = existing-file validation bound ONLY — not retention/cap
  // existing exactly 4096 valid → allow append → file may have 4097 lines
  // next preflight with existing 4097 → reject
  // forbid delete/compaction/rotation; never claim "file never exceeds 4096"
then exact JSON/canonical validation per line
  including isSupervisorLifecycleActionForOperation(operation, actionId)
then incoming event exact validation (design §8.5; no raw preimage recompute)
```

**Test cleanup pattern (mandatory):**

```js
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

let root;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'linke-cap-audit-'));
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
```

- [ ] **Step 1: Write failing tests (RED)**

Cover at least:

1. **missing** file → create parent `audit/` + append one event
2. **empty** file (`raw.length === 0`) → append ok
3. **单行合法+newline** → second append ok (sequential duplicate ok)
4. **missing final newline** → reject; file unchanged
5. **internal blank** → reject
6. **尾部 newline 不作为 blank/off-by-one**（仅 `"\n"` → body `''` → lines `[]` → allow）
7. **existing 恰好 4096 合法行** → validation pass；allow append 第 4097 行（**not** retention；成功后文件可有 4097 行）
8. **existing 4097 行**（或 >4096）→ 下次 preflight reject；**不** delete/compact/rotate
9. bad JSON line → reject
10. wrong key set / wrong key order → reject
11. wrong eventKind/proofMode/schemaVersion → reject
12. cross-op actionId in existing line → reject（shared SoT）
13. oversize content > 1 MiB → reject
14. file mode 0600 after write（`stat.mode & 0o777` → `0o600` on macOS where supported）
15. concurrent appends same root serialize (different events; both succeed) — **single sink Map only**
16. queue Map does not retain key after settle（repeated many roots / stability）
17. does **not** import/call `appendAuditEvent`（module source scan）
18. writing capability file leaves `audit/events.jsonl` absent or untouched
19. source has **no** legacy `append…Line(dataDir,…)` symbol
20. **hostile/malformed incoming event**（wrong keys/order/enum/hash form/cross-op/extra key）→ sink-invalid；append 未调用；dedicated file 不 poison；随后合法 event 仍可成功
21. source has **no** second queue Map in lifecycle for this sink path；queue SoT only in sink

```js
// Example happy path sketch
import {
  appendCapabilityRealAuditProofEvent,
  CAPABILITY_REAL_AUDIT_RELATIVE_PATH,
} from '../src/capability-audit-sink.js';

const event = buildValidCanonicalEvent({
  operation: 'install',
  actionId: 'render-launch-agent-plist',
  /* fixed fingerprints */
});
await appendCapabilityRealAuditProofEvent(root, event);
const raw = await readFile(join(root, CAPABILITY_REAL_AUDIT_RELATIVE_PATH), 'utf8');
assert.equal(raw.endsWith('\n'), true);
assert.equal(raw.split('\n').filter(Boolean).length, 1);
```

- [ ] **Step 2: Run RED**

```bash
node --test test/capability-audit-sink.test.js
```

Expected: **fail** (module missing and/or assertions fail).

- [ ] **Step 3: Minimal GREEN implementation**

In `src/capability-audit-sink.js`:

1. Import `assertSafeDataRoot`, `safeAppendText`, `safeReadText`, `SafeDataFileError` from `./safe-data-files.js`（assert 若仅由 invoke 调用可不必 re-export；path 安全由 safeRead/safeAppend 再检）.
2. Import `isSupervisorLifecycleActionForOperation`（及所需 operation 校验）from `./supervisor-lifecycle-actions.js` — **not** from lifecycle.
3. Implement **sole** per-resolvedDataRoot queue Map (`capabilityAuditSinkQueues`) with finally delete — **唯一 queue SoT**；禁止嵌套第二 Map.
4. Inside **one** queue task: try `safeReadText` with `maxBytes: 1MiB`; ENOENT → treat as missing; other SafeDataFileError → sink-invalid.
5. Preflight exact design §8.2 JSONL algorithm + per-line SoT op/action check + canonical byte-for-byte（existing §8.3）.
6. **Incoming event** exact validation design §8.5（与 §8.3 同级；无需/不能从 raw attemptRef 重算 preimage）；invalid → throw sink-invalid **before** append.
7. Serialize `event` to fixed-key-order JSON + `'\n'`; `safeAppendText(resolvedDataRoot, REL, line)`（FileHandle 有 `sync` 则总是 await；无调用方关闭开关）.
8. Throw path-free errors mapped to fixed codes **or** let lifecycle map → `capability-real-audit-sink-invalid` / `persist-failed` (choose one layer; tests lock; stages align receipt truth).
9. Comments: append-only API behavior only; not events.jsonl; not WORM; 4096 is existing validation bound not retention; sink must validate schema/op/action via SoT for existing **and** incoming.

- [ ] **Step 4: Run GREEN**

```bash
node --test test/capability-audit-sink.test.js test/supervisor-lifecycle-actions.test.js
```

Expected: pass.

- [ ] **Step 5: Commit boundary C2（仅当用户明确要求）**

```text
feat: add capability real-audit proof sink
```

---

### Task 3: Fingerprint + canonical builder pure helpers + exact vectors

**Files:**
- Modify: `src/supervisor-lifecycle.js`（prefer lifecycle private helpers used by proof; sink validates structure/SoT/op/action but does **not** own fingerprint preimage authority）
- Modify: `test/capability-audit-sink.test.js` and/or gate test

- [ ] **Step 1: RED tests with fixed vectors**

```js
import { createHash } from 'node:crypto';

const attemptRef = 'abcdef0123456789'; // 16 chars, valid pattern
const operation = 'install';
const actionId = 'render-launch-agent-plist';

const attemptPreimage = `linke:v1.34:real-audit-proof:attempt-ref:v1\x1f${attemptRef}`;
const eventPreimage = `linke:v1.34:real-audit-proof:event:v1\x1f1\x1f${operation}\x1f${actionId}\x1f${attemptRef}`;

const attemptRefFingerprint = createHash('sha256').update(attemptPreimage, 'utf8').digest('hex');
const eventFingerprint = createHash('sha256').update(eventPreimage, 'utf8').digest('hex');

assert.equal(attemptRefFingerprint.length, 64);
assert.match(attemptRefFingerprint, /^[0-9a-f]{64}$/);
// assert exported or receipt-computed values equal these exact strings
```

Also assert canonical JSON:

```js
const event = {
  schemaVersion: 1,
  eventKind: 'capability-real-audit-proof',
  eventFingerprint,
  operation,
  actionId,
  attemptRefFingerprint,
  proofMode: 'real-proof',
};
const line = `${JSON.stringify(event)}\n`;
// keys order: assert Object.keys(event) deepEqual ordered list
```

- [ ] **Step 2: RED**

```bash
node --test test/capability-audit-sink.test.js test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

- [ ] **Step 3: GREEN** — implement pure hash/build helpers in lifecycle (private).

- [ ] **Step 4: GREEN verify**

```bash
node --test test/capability-audit-sink.test.js
```

- [ ] **Step 5:** No separate commit required if folded into C2/C3; prefer include in C3 if helpers only used by proof.

---

### Task 4: Registry descriptor + local readiness (no sink write yet)

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

- [ ] **Step 1: RED tests**

```js
const r = buildSupervisorLifecycleGuardedRunnerCapabilityInjectionReadiness();
assert.equal(r.realRenderCapabilityImplementationReady, true);
assert.equal(r.realStatusCapabilityImplementationReady, true);
assert.equal(r.realAuditCapabilityImplementationReady, true);
assert.equal(r.realCapabilityImplementationsReady, false);
assert.equal(r.realAttemptAuditImplementationReady, false);
assert.equal(r.executeCapabilityAuthorized, false);
assert.equal(r.realRunnerWiringReady, false);
assert.equal(r.runnerWiringContractReady, false);
assert.equal(r.executionEligible, false);
assert.equal(r.realImplementationEntries.length, 3);
const kinds = r.realImplementationEntries.map((e) => e.capabilityKind).sort();
assert.deepEqual(kinds, ['audit', 'render', 'status']);
const audit = r.realImplementationEntries.find((e) => e.capabilityKind === 'audit');
assert.equal(audit.capabilityId, 'real-audit');
assert.equal(audit.implementationClass, 'real-implementation');
assert.equal(audit.sideEffectClass, 'audit-persist');
assert.deepEqual(audit.supportsModes, ['real-proof']);
assert.equal(audit.canPersistAuditInProof, true);
assert.equal(audit.wouldPersistAudit, false);
assert.equal(audit.auditWriteAllowed, false);
assert.equal(audit.filesystemWriteAllowed, false);
assert.equal(audit.wouldMutateHost, false);
assert.equal(r.handler, undefined);
```

- [ ] **Step 2: RED**

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

Expected fail on missing `realAudit*` fields / size 2.

- [ ] **Step 3: GREEN**

1. Constants: `REAL_AUDIT_CAPABILITY_ID`, evidence code, request keys list, attemptRef pattern, outcome/blocker codes.
2. `buildRealAuditCapabilityDescriptor()` exact；`actionIds` from shared SoT（all 10），非第二份硬编码 list.
3. Bootstrap register size 3.
4. `isRealAuditCapabilityRegistryReady()` separate probe.
5. Extend readiness + mappings; **never** set global real true.
6. Comments per design terminology.

- [ ] **Step 4: GREEN verify** same command.

- [ ] **Step 5:** Include in C3 commit when proof lands, or intermediate only if user wants.

---

### Task 5: RealAuditProof authorize (sync pure) + invoke skeleton

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

**Exports:**

```js
export function authorizeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(request)
export async function invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(request, context)
```

- [ ] **Step 1: RED — request/context hostile + happy authorize**

Helper:

```js
function validAttemptRef() {
  return 'a'.repeat(16); // or opaque fixed fixture
}
function buildRealAuditProofRequest(overrides = {}) {
  return {
    capabilityKind: 'audit',
    actionId: 'render-launch-agent-plist',
    operation: 'install',
    mode: 'real-proof',
    idempotencyKey: null,
    attemptRef: validAttemptRef(),
    anchorRef: null,
    auditInput: { schemaVersion: 1 },
    ...overrides,
  };
}
function buildContext(dir) {
  return { dataDir: dir };
}
```

Tests:

1. authorize valid → authorized true；execute false；no IO
2. mode execute / dry-run → mode-invalid or denied
3. kind not audit → kind-unknown
4. operation invalid → operation-invalid
5. action not in operation set (cross-op) → action-unmapped（via shared SoT）
6. idempotencyKey non-null → idempotency-key-invalid
7. anchorRef non-null → input-invalid（or fixed code）
8. attemptRef too short/long/whitespace/control → input-invalid
9. auditInput extra keys / wrong schemaVersion → real-audit-input-invalid
10. getter/proxy/symbol/dangerous keys → caller-injection-rejected
11. request contains dataDir → reject
12. four operations × each action authorize matrix (parameterized)

- [ ] **Step 2: RED run**

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

- [ ] **Step 3: GREEN authorize path** — exact snapshot + validation only; no context param.

- [ ] **Step 4: RED invoke happy path**

```js
const dir = await mkdtemp(join(tmpdir(), 'linke-audit-proof-'));
try {
  const receipt = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof(
    buildRealAuditProofRequest(),
    buildContext(dir),
  );
  assert.equal(receipt.receiptKind, 'capability-real-implementation-receipt');
  assert.equal(receipt.state, 'completed');
  assert.equal(receipt.outcomeCode, 'capability-real-audit-persisted');
  assert.equal(receipt.hostSideEffectOccurred, true);
  assert.equal(receipt.hostMutationOccurred, true);
  assert.equal(receipt.auditPersistOccurred, true);
  assert.equal(receipt.mutationOutcome, 'persisted');
  assert.equal(receipt.wouldPersistAudit, false);
  assert.equal(receipt.wouldMutateHost, false);
  assert.equal(receipt.realCapabilityImplementationsReady, false);
  assert.equal(receipt.realAttemptAuditImplementationReady, false);
  assert.equal(receipt.executeCapabilityAuthorized, false);
  assert.match(receipt.auditEventFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(receipt.dataDir, undefined);
  assert.equal(Object.hasOwn(receipt, 'dataDir'), false);
  // raw attemptRef absent
  assert.equal(JSON.stringify(receipt).includes(validAttemptRef()), false);
  const raw = await readFile(join(dir, 'audit/capability-proof-attempts.jsonl'), 'utf8');
  assert.equal(raw.endsWith('\n'), true);
  assert.equal(await fileExists(join(dir, 'audit/events.jsonl')), false);
} finally {
  await rm(dir, { recursive: true, force: true });
}
```

- [ ] **Step 5: GREEN invoke** full pipeline design §6.4 + receipt tables §10.

Invoke order（fingerprint Option A；与 design §4.5/§6.4/§10.4 同步）:

```text
1. pure request/context shape validation  → fail: auditEventFingerprint MUST null
2. assertSafeDataRoot(context.dataDir) → resolvedDataRoot
   → fail: auditEventFingerprint MUST null
3. compute fingerprints in memory          → only after this: 64hex allowed
4. inFlight atomic (same sync section; before any await / sink call):
     if (inFlightSet.has(eventFingerprint)) deny;  // fingerprint already computed
     inFlightSet.add(eventFingerprint);
5. await appendCapabilityRealAuditProofEvent(resolvedDataRoot, event)
   // sole sink entry; NO invoke pre-read; NO second queue
6. finally: inFlightSet.delete(eventFingerprint)
```

**Hard rules (tests must lock):**

```text
invoke MUST NOT maintain/enqueue a second queue
invoke MUST NOT pre-read existing sink file
sink capabilityAuditSinkQueues Map is the sole queue SoT
forbid nested queue / two Maps
```

Call sink only as:

```js
await appendCapabilityRealAuditProofEvent(resolvedDataRoot, event)
```

where `resolvedDataRoot` is the return of `assertSafeDataRoot` (assert before fingerprint/Set/sink).

- [ ] **Step 6: Operation/action matrix GREEN** — loop all 10 actions under correct ops; one cross-op negative per op.

- [ ] **Step 7: Commit boundary C3（用户确认后）**

```text
feat: add V1.34 real audit capability proof API
```

---

### Task 6: Fail-closed paths + concurrency + append failure truth

**Files:**
- Modify: `src/supervisor-lifecycle.js` / `src/capability-audit-sink.js` as needed
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`
- Modify: `test/capability-audit-sink.test.js`

- [ ] **Step 1: RED tests**

| Case | Expect |
| --- | --- |
| invalid request hostile | input/injection-invalid; occurred false; not-attempted; **`auditEventFingerprint` MUST null** |
| invalid context `{}` / extra key / getter dataDir | context-invalid; occurred false; not-attempted; **`auditEventFingerprint` MUST null** |
| missing dataDir root / assertSafeDataRoot fail | context-invalid; no file created; **`auditEventFingerprint` MUST null** |
| symlink dataDir | context-invalid; **`auditEventFingerprint` MUST null** |
| malformed existing sink | sink-invalid; no additional append; **`auditEventFingerprint` MUST 64hex** |
| oversize / existing >4096 lines | sink-invalid; **64hex** |
| existing exactly 4096 valid → append | success → file has **4097** lines; next call with existing 4097 → sink-invalid（**not** retention; no delete/compact） |
| hostile/malformed **incoming** event | sink-invalid; append not called; occurred false; **64hex**; dedicated file not poisoned; later valid event still succeeds |
| concurrent same fingerprint（**barrier**） | **second** denied with `capability-real-audit-in-flight-denied`, occurred false；**零第二写**；双方 **64hex**；证明 fingerprint 先算再 `has→deny; add` 在 await/sink 前同一同步段；**无** invoke 第二 queue |
| sequential same fingerprint | both persisted; two lines |
| different fingerprints concurrent | both succeed; **sink-only** queue serial（barrier 不误伤；禁止 nested queue / 两套 Map） |
| force append throw after invoke started (test seam **only if** already style-matched; else inject deps in sink TEST ONLY with JSDoc `@internal TEST ONLY`, production never calls) | state error; persist-failed; true/true/false; unknown-after-write-attempt; **64hex**；do not overclaim if seam FileHandle lacks `sync` |
| reentry: handler must not call invoke again | source/architecture assert |
| Set/Map cleanup after success and after deny | subsequent same fingerprint sequential allowed；sink Map sole SoT |
| execute mode on proof API | denied; zero write |
| options elevate realAudit/global flags | ignored |
| dry-run / execute capability invoke paths | zero sink write (spy or file absence) |
| JSONL algorithm edge matrix | missing/empty/单行+newline/existing-4096-allow-append-to-4097/existing-4097-reject/internal blank/missing final newline/trailing-newline-not-blank |
| source architecture | invoke has **no** enter-queue / pre-read path; only `await appendCapabilityRealAuditProofEvent` |

- [ ] **Step 2: RED**

```bash
node --test test/capability-audit-sink.test.js test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

- [ ] **Step 3: GREEN** implement inflight Set with exact atomic timing (fingerprint then has/add), failure mapping, sink-only queue, incoming validation, test-only throw seam if used (bootstrap never calls).

- [ ] **Step 4: GREEN verify** same command.

---

### Task 7: Gate non-live + Web realAudit line + options cannot elevate

**Files:**
- Modify: `src/supervisor-lifecycle.js`（gate readiness fields if not done）
- Modify: `src/web/app.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`
- Modify: `test/web-console.test.js`

- [ ] **Step 1: RED**

Gate production ready path:

```js
// hostSideEffectOccurred/hostMutationOccurred/auditPersistOccurred all false on gate snapshot
// realAuditCapabilityImplementationReady true
// no auditEventFingerprint / event body required on gate
// nextBlockers still wiring-missing
// readyCount 6 / blockedCount 0
```

Web:

```js
// shall include realAudit fixed line
// shows local ready + global real false + wiring false
// does NOT show live fingerprint/event
// executionSentinel still blocked
// keep realRender + realStatus lines
```

- [ ] **Step 2: RED**

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js test/web-console.test.js
```

- [ ] **Step 3: GREEN** minimal web string/view model line; no button; no API field.

- [ ] **Step 4: Commit boundary C4（用户确认后）**

```text
feat: expose non-live realAudit readiness without elevating globals
```

---

### Task 8: M1 Exit audit temporal semantics（**必须先于** version bump；仍 V1.33 时验证可绿）

**Files:**
- Modify: `test/cross-lan-m1-exit-audit.test.js` **only**
- **Do not modify** `docs/superpowers/specs/2026-07-18-linke-v2-m1-exit-audit.md` historical version claims（V1.33@47dcc2d snapshot 不改）

**Order lock（强制 — 禁止计划内必红中间态）：**

```text
1. 本 Task 修改 temporal suite
2. 在仍为 V1.33 时运行:
   node --test test/cross-lan-m1-exit-audit.test.js
   → 必须 GREEN（旧 suite 不得被设计成“等 bump 才修”的必红）
3. 然后才进入 Task 9 version/gold/readme bump
4. bump 后再跑 temporal + version + gold → 仍 GREEN
```

Commit：可与 Task 9 同 C5 boundary（步骤仍先 temporal 后 bump），或 temporal 独立 commit 在前。

- [ ] **Step 1: Rewrite runtime test contract（目标：V1.33 下即绿）**

Replace forever-V1.33 runtime assertion with temporal split:

```js
it('M1 exit audit doc snapshot remains V1.33 @ 47dcc2d; VERSION_MUTATION NONE is audit-local', () => {
  const audit = readAuditOrFail();
  assertContains(audit, '47dcc2d');
  assertContains(audit, 'V1.33');
  assertContains(audit, '4 ready');
  assertContains(audit, '4 partial');
  assertContains(audit, '1 blocked');
  assertContains(audit, 'total: 9');
  assertContains(audit, 'VERSION_MUTATION: NONE');
  assertContains(audit, 'SCORECARD_MUTATION: NONE');
  assertContains(audit, 'neither is changed by the audit');
  // must NOT require that the audit document claims current runtime is V1.34
});

it('runtime gold remains blocked without cross-lan-connectivity; M1/M2 not elevated', () => {
  // Allow current runtime version (V1.33 now; V1.34 after Task 9) — no permanent V1.33 lock
  assert.match(LINKE_RELEASE_VERSION, /^V1\.\d+$/);

  const report = buildGoldReadinessReport();
  assert.equal(report.status, 'blocked');
  assert.deepEqual(report.summary, {
    ready: 4,
    partial: 4,
    blocked: 1,
    total: 9,
  });
  assert.equal(report.items.some((i) => i.id === 'cross-lan-connectivity'), false);
  // Do not assert report.version === 'V1.33'
  assert.equal(report.version, LINKE_RELEASE_VERSION);
});
```

Remove or replace:

```js
// DELETE permanent lock:
// assert.equal(LINKE_RELEASE_VERSION, 'V1.33');
// assert.equal(report.version, 'V1.33');
```

Keep doc-content locks for V1.33 snapshot strings.

- [ ] **Step 2: Verify GREEN while still V1.33**

```bash
node --test test/cross-lan-m1-exit-audit.test.js
```

Expected: **pass on V1.33** (no planned forced-red).

- [ ] **Step 3:** Optional intermediate commit（用户确认后）:

```text
test: split M1 exit audit snapshot from runtime version
```

Otherwise fold into C5 with Task 9（仍先完成本 Task 再 bump）。

---

### Task 9: Version V1.34 + Gold honesty + README（**仅在 Task 8 绿之后**）

**Files:**
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `README.md`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js`

- [ ] **Step 1: RED**

```js
// version.test.js expects V1.34
assert.equal(LINKE_RELEASE_VERSION, 'V1.34');
```

Gold:

```js
assert.equal(report.status, 'blocked');
assert.deepEqual(report.summary, { ready: 4, partial: 4, blocked: 1, total: 9 });
assert.equal(report.items.some((i) => i.id === 'cross-lan-connectivity'), false);
// production-hardening still not ready
const ph = report.items.find((i) => i.id === 'production-hardening');
assert.ok(ph);
assert.notEqual(ph.status, 'ready');
// evidence/nextStep may mention V1.34 real audit prep / M6d-prep — must NOT say M6d complete or Gold ready
```

README:

- current milestone **V1.34**
- historical V1.32 / V1.33 remain
- wording: third real capability audit proof; independent sink; not M6d Exit; not Gold; not cross-LAN

- [ ] **Step 2: RED**

```bash
node --test test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

- [ ] **Step 3: GREEN** minimal version bump + evidence strings + README lines.

- [ ] **Step 4: Re-verify temporal still green after bump**

```bash
node --test test/cross-lan-m1-exit-audit.test.js test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

Expected: all pass；runtime may now assert `LINKE_RELEASE_VERSION === 'V1.34'` only as **current** version, never rewrite M1 audit markdown.

- [ ] **Step 5: Commit boundary C5（用户确认后）**

```text
chore: release milestone V1.34 real audit prep
```

（若 Task 8 未单独 commit，本 boundary 消息可拆成 temporal + chore 两条，或一条写清 “temporal then V1.34 bump”。）

---

### Task 10: Side-effect / sensitive / scope scans

**Files:** tests only or scripted assertions inside gate test

- [ ] **Step 1: RED/GREEN assertions**

```js
// Source scans (readFileSync UTF-8):
// - src/agent.js has zero RealAuditProof / capability-audit-sink imports
// - src/server.js same
// - src/supervisor-lifecycle.js does not call appendAuditEvent
// - src/capability-audit-sink.js does not import audit-log.js
// - src/capability-audit-sink.js does not import supervisor-lifecycle.js (no cycle)
// - src/supervisor-lifecycle-actions.js imports neither lifecycle nor sink
// - no legacy append…Line(dataDir,…) symbol anywhere in src/test
// - no sink-schema-indifferent contract language in docs/src
// - no invoke second queue / enter-queue / invoke pre-read for capability audit path
// - no nested queue / two Map SoTs for capability audit sink
// - package.json dependencies unchanged (hash or exact no new deps) — do not rewrite lockfile
```

Sensitive category on successful receipt JSON:

- no absolute path
- no raw attemptRef
- no `dataDir` key
- no `events.jsonl` content
- no stack / errno message

- [ ] **Step 2: Run**

```bash
node --test \
  test/supervisor-lifecycle-actions.test.js \
  test/capability-audit-sink.test.js \
  test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

---

### Task 11: Full verification + honesty final gate

- [ ] **Step 1: Targeted**

```bash
node --test \
  test/supervisor-lifecycle-actions.test.js \
  test/capability-audit-sink.test.js \
  test/supervisor-lifecycle-guarded-runner-execution-gate.test.js \
  test/web-console.test.js \
  test/gold-readiness.test.js \
  test/version.test.js \
  test/readme.test.js \
  test/cross-lan-m1-exit-audit.test.js
```

Expected: all pass.

- [ ] **Step 2: Full**

```bash
node --test
```

Expected: all pass (or only pre-existing unrelated skips).

- [ ] **Step 3: Diff hygiene**

```bash
git status --short
git diff --check
```

Confirm:

- no unintended `package-lock.json` staging
- no `agent.js` / `server.js` / `audit-log.js` edits
- only allowlisted files
- pure SoT + sink + lifecycle consume present

- [ ] **Step 4: Final honesty checklist**（全部勾选才可称 implementation complete）

- [ ] real registry 3/7；local realAudit true
- [ ] global flags all false listed in design §11
- [ ] sink independent；events.jsonl untouched in tests
- [ ] unique SoT；no second action-ID list；sink validates schema/op/action via SoT
- [ ] sink API `appendCapabilityRealAuditProofEvent(resolvedDataRoot, event)` only
- [ ] queue sole SoT in sink；invoke MUST NOT second queue / pre-read
- [ ] fingerprint Option A null/64hex matrix locked
- [ ] incoming event §8.5 validation + no file poison
- [ ] 4096 existing validation bound（not retention）
- [ ] receipt truth tables covered
- [ ] Gold 4/4/1/9 blocked；no cross-lan-connectivity
- [ ] V1.34 version；M1 doc still V1.33 snapshot；temporal fixed before bump
- [ ] Web non-live
- [ ] no forbidden claims in README/gold evidence
- [ ] mkdtemp only
- [ ] **Not claimed:** M6d Exit, T6d.3 complete, Gold ready, PROCEED=done without tests, review PASS

- [ ] **Step 5:** Request **fresh review** of code diff vs design; PM sign-off before merge/push（用户确认）。

---

## Verification commands (summary)

### Focused

```bash
node --test test/supervisor-lifecycle-actions.test.js
node --test test/capability-audit-sink.test.js
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
node --test test/web-console.test.js
node --test test/gold-readiness.test.js
node --test test/version.test.js
node --test test/readme.test.js
node --test test/cross-lan-m1-exit-audit.test.js
```

### Full

```bash
node --test
```

### Docs-only phase (this authoring session)

```bash
# untracked docs: stage temporarily for whitespace check, then restore
git add \
  docs/superpowers/specs/2026-07-18-supervisor-lifecycle-real-audit-capability-handler-design.md \
  docs/superpowers/plans/2026-07-18-supervisor-lifecycle-real-audit-capability-handler.md
git diff --cached --check
git restore --staged \
  docs/superpowers/specs/2026-07-18-supervisor-lifecycle-real-audit-capability-handler-design.md \
  docs/superpowers/plans/2026-07-18-supervisor-lifecycle-real-audit-capability-handler.md
git status --short
```

---

## Side-effect / sensitive scan (implementation relative to pre-code anchor)

| Category | Rule |
| --- | --- |
| `appendAuditEvent` | **0** new call sites from lifecycle/sink |
| `audit/events.jsonl` | **0** writes from capability audit path |
| `child_process` / launchctl / net / fetch | **0** new |
| `safeAppendText` / `safeReadText` / `assertSafeDataRoot` | **allowed** in sink |
| directory mode 0700 | **do not claim** |
| file mode 0600 | **assert** on sink file |
| server/agent RealAuditProof refs | **0** |
| secrets in receipts | category counts **0** for path/raw attemptRef/dataDir/stack |
| package deps | **unchanged** |

---

## P0 / P1 risks during implementation

| 级 | ID | 风险 | 缓解 |
| --- | --- | --- | --- |
| P0 | P0-1 | 复用 events.jsonl | Task2 source scan; Task5 untouched assert |
| P0 | P0-2 | 抬升 global real/execute/wiring/realAttemptAudit | Task4/7/9 asserts |
| P0 | P0-3 | raw attemptRef / dataDir 泄漏 | Task5 receipt stringify asserts |
| P0 | P0-4 | 跨 operation action 接受 | Task1 SoT + Task5 matrix negative |
| P0 | P0-5 | malformed file still append | Task2/6 sink-invalid + §8.2 algorithm |
| P0 | P0-6 | 成功路径 mutationOccurred false | Task5 success truth |
| P0 | P0-7 | 写失败却 claim not-attempted | Task6 unknown-after-write-attempt |
| P0 | P0-8 | M1 audit 文档被改成 V1.34 | Task8 only test file；markdown 不改 |
| P0 | P0-9 | Gold counts 变化 / cross-lan 出现 | Task9 locks 4/4/1/9 |
| P0 | P0-10 | public surface / agent/server refs | Task10 scan |
| P0 | P0-11 | 第二份 action ID list / ESM cycle | Task1 SoT；sink/lifecycle 均 import pure module |
| P0 | P0-12 | version bump 先于 temporal 导致计划内必红 | Task8 先绿（V1.33）再 Task9 bump |
| P1 | P1-1 | queue/Set 泄漏 | Task6 cleanup tests |
| P1 | P1-2 | Web 显示 live event | Task7 non-live |
| P1 | P1-3 | 目录 0700 过度宣称 | docs+comments only 0600 file |
| P1 | P1-4 | sequential duplicate 被误做成 dedup | Task6 two lines |
| P1 | P1-5 | test 写真实 home dataDir | mkdtemp mandatory |
| P1 | P1-6 | package-lock 被暂存 | status check each commit |
| P1 | P1-7 | inflight 非原子（await 后 add） | Task6 barrier same-fp concurrent |
| P1 | P1-8 | 旧 sink API 签名残留 | Task2/10 scan no append…Line(dataDir) |
| P1 | P1-9 | fingerprint 在 context/root fail 仍返回 / may 措辞 | Task5/6 Option A null vs 64hex matrix |
| P1 | P1-10 | invoke 第二 queue / pre-read / 嵌套 Map | Task2/5/6 architecture + source scan |
| P1 | P1-11 | 4096 被实现成 retention/cap | Task2/6 existing-4096→4097 then reject |
| P1 | P1-12 | incoming event 未校验即 append | Task2/6 hostile incoming + no poison |

---

## Rollback (implementation)

| 场景 | 动作 |
| --- | --- |
| Task fails mid-way | stop; do not mix commit boundaries; fix or discard task files |
| Accidental events.jsonl coupling | remove; restore audit-log untouched; re-RED |
| Version/Gold false ready | revert version/gold/readme to blocked honesty |
| M1 doc edited by mistake | restore doc from git; keep only test temporal fix |

---

## Completion criteria

### Docs phase (now)

- [x] design + plan created only
- [ ] staged `git diff --cached --check` clean on both docs then `git restore --staged`
- [ ] `git status` shows only intended untracked docs (+ pre-existing unrelated package-lock if any)
- [ ] no src/test changes
- [ ] **not** claiming implementation complete or review PASS

### Implementation phase (later)

- [ ] All tasks T0–T11 green
- [ ] Full `node --test` green
- [ ] Commit boundaries respected with user approval
- [ ] Fresh code review + PM gate
- [ ] Forbidden claims absent
- [ ] Still **not** M6d Exit / T6d.3 complete / Gold ready

---

## Forbidden claims (copy into PR/README review)

Do **not** claim any of:

Gold ready · GA · M2 complete · cross-LAN · dual-host · execute authorized · wiring ready · global real ready · production-grade audit · realAttemptAudit wiring ready · idempotency store · dedup store · retention complete · rotation complete · tamper-proof · immutable · WORM · audit chain integrity complete · durability chronology proved · failure-injection evidence ready · scorecard production-hardening ready · M6d Exit · V2.0 · review PASS without fresh reviewer · docs PROCEED = code complete

---

**Plan status:** executable TDD plan frozen for review (docs only).
**Next:** fresh review + PM → Task 0.
**Reminder:** docs `PROCEED` ≠ code complete；本阶段不声称审核 PASS。
