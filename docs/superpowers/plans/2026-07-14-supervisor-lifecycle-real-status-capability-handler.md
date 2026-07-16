# V1.33 Supervisor Lifecycle Real Status Capability Handler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After V1.32 **first real render capability** (`c311a7e`), mount the **second honest real implementation** on the dual-track capability registry: **`status` / `capture-current-state` / operation=`rollback`**. Deliver **real observational host metadata read** (async Node `fs/promises`, fixed-path only, **no content read**) with sanitized bounded `statusResult` (`presence` / `isRegularFile` / `readability` / `sizeClass` only). Keep **`hostMutationOccurred:false`**. On real fs observation start set **`hostObservationOccurred:true`** and **`hostSideEffectOccurred:true`** (honor V1.32 definition: reading host-controlled resources is a host side effect — do **not** redefine). Set only local **`realStatusCapabilityImplementationReady:true`**. Keep **global** `realCapabilityImplementationsReady:false` (independent fact), `executeCapabilityAuthorized:false`, `realRunnerWiringReady:false`, `runnerWiringContractReady:false`, `executionEligible:false`, gate primary **`real-guarded-runner-execution-wiring-missing`**, Web **`executionSentinel`**, and **Gold blocked**. Verify via **independent async RealStatusProof** API — **not** public execute, **not** expanded RealRenderProof, **not** static `buildSupervisorStatusResponse`, **not** content hash, **not** sync fs reader. Do **not** execute launchctl write/load/unload, fs write, network, audit persist, notify, shell, process-list dump, or plist content read. Do **not** accept caller-injected handlers/paths as production evidence. Do **not** claim V2.0 Gold/GA or cross-LAN completion.

**Architecture:** Extend module-private trusted bootstrap to keep **7 dry-run** + **real-render**, and add **1 real-status** handler (`capabilityId:'real-status'`, `supportsModes:['real-proof']`, `sideEffectClass:'observational-read'`, `hostObservationAllowed:true`, `contentReadAllowed:false`). Export status-specific authorize (sync) / invoke (**async**) pure proof APIs. Host reader is code-owned async Node `fs/promises`: parent-segment walk `lstat` → target `lstat` → `open(O_RDONLY|O_NOFOLLOW)` → `FileHandle.stat` size-cap recheck → **no content read** → `finally close`; absolute deadline + single-settle; in-flight cap; late results discarded. Path derived only from allowlisted exact-string `targetToken` → fixed basename under internal `os.homedir()` + fixed segments (path never leaves module; errors never leak code/message/stack/path). Execute path remains hard-deny with zero dispatch. Gate/Web expose local realStatus fact **without** live observation (`hostObservationOccurred:false`, `hostSideEffectOccurred:false`) and without elevating global real/wiring/execution facts. Test-only reader inject (`@internal TEST ONLY`) for failure matrix; production bootstrap binds real reader and **never** calls the test hook.

**Tech Stack:** Node.js ESM, `node:fs/promises` + `fs.constants` (`O_RDONLY | O_NOFOLLOW` mandatory on macOS), `node:os` (`homedir` internal only), `node:test` (async tests), existing Web Console view model helpers, README/Gold static scorecard tests. **No** `node:crypto` content hashing for status. **No** Sync fs APIs in production status reader.

**Spec:** `docs/superpowers/specs/2026-07-14-supervisor-lifecycle-real-status-capability-handler-design.md`

**Recovery anchor:** `c311a7e` (`feat: add V1.32 first real render capability`)

## Final Decision (locked)

```text
SELECTED = A  // real observational status / capture-current-state (metadata-only)
REJECTED = B  // §4.5 idempotency store locus
REJECTED = C  // persist audit sink / real audit capability
PROOF    = independent async RealStatusProof
           (NOT RealRenderProof expansion; NOT generic framework)
READER   = async fs/promises metadata-only fixed path
           (NOT sync; NOT content read; NOT shell; NOT launchctl;
            NOT buildSupervisorStatusResponse; NOT contentSha256)
SIDE_EFFECT_SEMANTICS = honor V1.32
  // real fs observation start ⇒
  //   hostObservationOccurred=true
  //   hostSideEffectOccurred=true
  //   hostMutationOccurred=false
  // does NOT elevate execute / global real / wiring / Gold
```

### 拒绝方案（实现不得反转）

| ID | 拒绝 | 原因 |
| --- | --- | --- |
| R-B | idempotency store | 写/durable 状态；不增加 real kind；blast radius > A |
| R-C | persist audit sink | 写 events.jsonl / appendAuditEvent；更高风险 |
| R-Static | 复用 `buildSupervisorStatusResponse` | 静态骨架，假证据 |
| R-Shell | 宽泛 shell / launchctl wrapper | 攻击面与脱敏失败 |
| R-ExpandRender | 扩 RealRenderProof kind | 违反 V1.32 §5.2.1 |
| R-Generic | V1.33 generic multi-kind framework | 过早抽象；另 design |
| R-ProcessList | ps/process table | processListReadAllowed 必须 false；禁 PID |
| R-Execute | 抬升 execute/wiring/Gold | 公式未满足 |
| R-SyncFs | lstatSync/openSync/readSync 生产 reader | 阻塞；timeout 只能 fake；与 F1/F8/F10 生产语义冲突 |
| R-ContentHash | 读 plist 字节 / contentSha256 | 过度暴露；非 metadata status 所需 |
| R-RedefineSideEffect | 把 observational read 的 hostSideEffect 藏成 false | 违反 V1.32 历史定义 |
| R-CrossLAN | 跨局域网 / same-LAN multi-host status 塞入 V1.33 | V2.0 强制里程碑；独立协议/威胁模型 |
| R-GoldClaim | 宣称 Gold/GA | 仅 V2.0 定义 |

## Global Constraints

- Current release version becomes `V1.33`.
- This is **second real implementation (status observational metadata only)** — **not** real host runner wiring completion, **not** host mutation, **not** content read, **not** execute authorization, **not** Gold/GA, **not** cross-LAN.
- **Terminology (must appear in code comments near registry):**
  - `real status = 真实宿主元数据观测非 stub；hostMutationOccurred=false`
  - `真实 fs observation 开始后：hostObservationOccurred=true 且 hostSideEffectOccurred=true`
  - `（遵守 V1.32：读 host 受控资源 = side effect；不得重定义）`
  - `observational-read ≠ host mutation；不得抬升 execute / 全局 real / wiring / Gold`
- Dual registry must become **7 dry-run + 2 real (render + status)**.
- Per-kind local readiness: `realRender*` and `realStatus*` **separated**.
- Do **not** set `realRunnerWiringReady:true`, `runnerWiringContractReady:true`, `executionEligible:true`, `executeCapabilityAuthorized:true`, or **global** `realCapabilityImplementationsReady:true`.
- Do **set** `realStatusCapabilityImplementationReady:true` only when bootstrap+descriptor contract holds.
- Do **not** set mutation `would*` / mutation `*Allowed` true; `processListReadAllowed` stays false; `contentReadAllowed` stays false.
- **Tri-boolean contract:**
  - observe path (reader started): `hostObservationOccurred:true`, `hostSideEffectOccurred:true`, `hostMutationOccurred:false`
  - validation/injection before reader: all three observation/sideEffect false; mutation false
  - Gate/Web non-live: observation false, sideEffect false, mutation false
- Do **not** remove or satisfy-away `real-guarded-runner-execution-wiring-missing`.
- Do **not** expand `POLICY_FACT_KEYS`.
- Do **not** add endpoint, CLI command, Web button, or request body field (no path/home/cwd/reader).
- Do **not** modify `src/agent.js`, `src/server.js`, or `package.json`.
- Do **not** call `appendAuditEvent`, write LaunchAgents, launchctl, child_process, process list, network, `readFile`/`readSync`/content streams in status reader.
- Do **not** register real handlers for write/reload/rollback/audit/notify.
- Do **not** treat G0a dual-Mac PASS as capability dual-host execute locus or cross-LAN milestone.
- Do **not** produce completed `capability-execute-receipt`.
- Do **not** use `implementationClass:'real-side-effect'` for status (use `'real-implementation'` + `sideEffectClass:'observational-read'`).
- Keep wiring aggregate `readyCount:6` / `blockedCount:0` / `state:'blocked'`.
- Keep `wiringPlan.mode:'plan-only'` and plan-only seal semantics.
- Keep policy ready path **authorized** / `primaryBlocker:null` when all existing facts true.
- Keep Web `executionSentinel` **恒** blocked.
- **Must (shall)** add Web realStatus fixed line (Task T-Web) showing **gate non-live** facts only.
- Keep V1.32 realRender Web line.
- G0a real two-Mac PASS statements stay unchanged.
- Malicious fixtures use **opaque synthetic strings only**.
- Sensitive scans report **category hit counts only**.
- Do **not** change V1.24–V1.32 public pure contract semantics except additive fields listed in spec.
- Planning phase must not modify `src/`, `test/`, `README.md`, `package*`, or version files beyond this docs-only phase; implementation phase follows this plan.
- Do **not** create `actual-changes.txt`. Do **not** use `git reset --hard` as a routine recovery step in this plan.
- Do **not** introduce confusing aliases (`statusReady` alone, `realWiringReady`, `observationReady` as wiring).
- nested `statusInput` 必须 **独立** exact snapshot（Object.hasOwn + data descriptor；reject null/undefined/non-string/empty/extra/symbol/function/getter/proxy/prototype；validated deep-copy）。
- Exported proof 函数 JSDoc **必须**含：`@internal PROOF ONLY — do not expose via HTTP/CLI/Web endpoint`；server/agent **零引用**。
- Test hook JSDoc **必须**含：`@internal TEST ONLY`；生产 bootstrap **永不**调用；server/agent/Web **零引用**；**不得**让 request 注入 path/reader。
- RealStatusProof API **status-specific**：不得扩 kind；invoke **async**。
- Side-effect scan：**禁止**新增 child_process/launchctl/writeFile/appendAuditEvent/content-read/Sync-fs；**允许** reader 私有区 async lstat/open/stat/close + O_NOFOLLOW。
- TDD 矩阵与 spec 同步为 **T1–T44** + failure **F1–F23**（含 T43 version / T44 README current+historical）。
- F1 / F8 / F10 **必须**同时覆盖生产 async 语义与 test fake；**不得**标 N/A 或 fake-only。
- V2.0 定义 Gold/GA；跨局域网为 V2.0 强制里程碑——**不**扩本版 scope，**不**在 README/Gold nextStep 暗示本版完成。

### 固定字段 vs 动态 fact（禁止混淆）

| 名称 | 类型 | V1.33 语义 |
| --- | --- | --- |
| readiness `pureCapabilityInjectionReady` / `dryRunCapabilityRegistryReady` | **固定** | 保持 true |
| readiness `realRenderCapabilityImplementationReady` | **bootstrap** | 保持 true |
| readiness `realStatusCapabilityImplementationReady` | **bootstrap** | bootstrap 成功 → **true** |
| readiness `realCapabilityImplementationsReady` | **固定 false** | 全局 **false**（**独立事实**，不是 ready 成功输入） |
| readiness `executeCapabilityRegistryReady` / `executeCapabilityAuthorized` | **固定 false** | **false** |
| real-status-proof receipt | **动态 async** | completed 时带 statusResult（metadata enums） |
| `hostObservationOccurred` / `hostSideEffectOccurred` | **动态** | observe 后 **true/true**；validation/Gate/Web **false/false** |
| `hostMutationOccurred` | **固定 false** | 恒 false |
| `realRunnerWiringReady` / `runnerWiringContractReady` / `executionEligible` | **固定 false** | 恒 false |
| wiring `readyCount`/`blockedCount` | **固定** | **6 / 0** |
| wiring aggregate `state` | **固定 blocked** | 仍 + wiring-missing |
| Web `executionSentinel:` | **固定 blocked** | 恒 wiring-missing |
| Web realStatus 行 | **必须（shall）** | ready 仍带全局 real false + realRunnerWiringReady false；**observation false + sideEffect false**（非 live；无 statusResult） |

### 诚实性检查清单（每个 task 收尾自检）

- [ ] `readyCount:6` / `blockedCount:0` 已断言
- [ ] `runnerWiringContractReady:false` 已断言
- [ ] `realRunnerWiringReady:false` 已断言
- [ ] `executionEligible:false` 已断言
- [ ] `executeCapabilityAuthorized:false` 已断言
- [ ] `realCapabilityImplementationsReady:false`（全局独立事实）已断言
- [ ] `realRenderCapabilityImplementationReady:true` 保持
- [ ] `realStatusCapabilityImplementationReady:true`（合法 path）已断言
- [ ] `hostMutationOccurred:false` 已断言
- [ ] observe completed 路径：`hostObservationOccurred:true` **且** `hostSideEffectOccurred:true`
- [ ] validation deny 路径：observation false + sideEffect false
- [ ] Gate/Web 非 live：observation false + sideEffect false；**无** statusResult
- [ ] gate `nextBlockers` 仍为 `['real-guarded-runner-execution-wiring-missing']`
- [ ] ready path policy **authorized** / primary `null`
- [ ] Web：policy authorized + **executionSentinel blocked** + shall realStatus 行 + realRender 行
- [ ] real-implementation-receipt **不是** wiringPlanSeal / **不是** execute receipt
- [ ] dry-run 与 real-status 可区分；**不**使用 `buildSupervisorStatusResponse` 填 statusResult
- [ ] nested statusInput 独立 snapshot + targetToken 类型硬校验已测
- [ ] presence / readability / sizeClass / isRegularFile 合同已锁；**无** contentSha256 / raw size
- [ ] proof API `@internal PROOF ONLY`；invoke async；server/agent 零引用；status-specific
- [ ] TEST ONLY hook 边界；bootstrap 永不调用；request 无 path/reader
- [ ] 无 agent/server/package 改动；无 shell/launchctl/write/content-read/Sync 新增
- [ ] 注释含 observational vs mutation vs V1.32 side-effect 术语
- [ ] Gold blocked 边界保持；无 V2.0 Gold/跨局域网宣称
- [ ] O_NOFOLLOW 强制；close failure 单 receipt；deadline single-settle
- [ ] inject reader 仅测试；生产 bootstrap 绑定真实 async reader

### Mode / class 公式（实现注释必须引用）

```text
dry-run (unchanged):
  implementationClass = dry-run-non-side-effect
  supportsModes = ['dry-run']

real render (V1.32 unchanged):
  implementationClass = real-implementation
  sideEffectClass = none
  supportsModes = ['real-proof']
  hostSideEffectOccurred = false always   # render does not read host-controlled resources

real status (V1.33):
  implementationClass = real-implementation
  sideEffectClass = observational-read
  supportsModes = ['real-proof']              # NOT execute
  hostObservationAllowed = true
  contentReadAllowed = false
  hostMutationOccurred = false always
  hostObservationOccurred = true  iff reader started
  hostSideEffectOccurred  = true  iff reader started   # V1.32 honor
  # hostSideEffectOccurred:true does NOT elevate execute/global real/wiring/Gold

executeCapabilityAuthorized = FULL multi-fact conjunction
  → V1.33 implementation: STILL always false
  → on mode==='execute': deny receipt; do not call any handler/reader
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

### targetToken allowlist + reader constants（exact）

```js
const REAL_STATUS_TARGET_TOKENS = Object.freeze(['linke-launch-agent-default']);
const REAL_STATUS_TARGET_BASENAME_BY_TOKEN = Object.freeze({
  'linke-launch-agent-default': 'com.linke.agent.default.plist',
});
const REAL_STATUS_MAX_METADATA_SIZE_BYTES = 65536;
const REAL_STATUS_OBSERVE_DEADLINE_MS = /* fixed code-owned, e.g. 250 */;
const REAL_STATUS_MAX_IN_FLIGHT = /* small fixed cap, e.g. 2 */;
// open flags on macOS MUST include:
//   fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
```

### Outcome / evidence codes（增量）

```text
capability-real-status-completed
capability-real-status-validation-failed
capability-real-status-observation-failed
capability-real-status-timeout
capability-real-status-redaction-failed
evidence: capability-real-status-implementation-ready
presence enum: present|absent|unreadable|unexpected-type|oversize|symlink-blocked|observation-error
readability enum: readable|unreadable|not-applicable|unknown
sizeClass enum: empty|small|medium|oversize|unknown
```

### P0 / P1 风险（实现中持续核对）

| 级 | ID | 风险 | 缓解（task） |
| --- | --- | --- | --- |
| P0 | P0-1 | 静态 status API 冒充 real | Task 2/5：禁止 import builder；T27 |
| P0 | P0-2 | path/HOME/error 原文泄漏 | sanitize 单点；固定 mapping；T26/T32/F23 |
| P0 | P0-3 | symlink/TOCTOU | parent walk + O_NOFOLLOW 强制 + fh.stat；F11/F16/F17 |
| P0 | P0-4 | 抬升 execute/全局 real/wiring | 全 task 诚实清单 |
| P0 | P0-5 | 扩 RealRenderProof | Task 2 独立 API；scope 扫描 |
| P0 | P0-6 | shell/execFile | 无 child_process；T24 |
| P0 | P0-7 | content read / contentSha256 回潮 | contentReadAllowed false；F22/T40 |
| P0 | P0-8 | 重定义 hostSideEffect 为 false | §1.4；observe 强制 true；T4 |
| P1 | P1-1 | CI LaunchAgents 漂移 | 真实路径允许 absent；present 用 inject |
| P1 | P1-2 | sideEffect true 误读为 mutation/execute | 三布尔分列 + 注释 |
| P1 | P1-3 | Web 误显示 live observation | 固定 false 行；无 statusResult |
| P1 | P1-5 | inject 变生产默认 / path 注入 | bootstrap 永不调用 ForTest；T41 |
| P1 | P1-7 | timeout 仅 fake | 生产 absolute deadline；F1/F8/F10 双覆盖 |
| P1 | P1-8 | close fail 双 settle/泄漏 | F20；observation-failed |
| P1 | P1-9 | timeout 洪泛 | MAX_IN_FLIGHT；F21 |
| P1 | P1-10 | targetToken 弱类型 | §5.4.2；T11 |
| P1 | P1-11 | O_NOFOLLOW 静默降级 | macOS 强制；T42 |

---

## Implementation Tasks（TDD）

### Task 1: Dual-registry + status descriptor + readiness local fact

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

**Interfaces:**
- Extend `buildSupervisorLifecycleGuardedRunnerCapabilityInjectionReadiness()` with `realStatusCapabilityImplementationReady`
- Extend `realCapabilityRegistry` to size 2
- module-private `buildRealStatusCapabilityDescriptor` / `isRealStatusCapabilityRegistryReady`
- extend `trustedBootstrapCapabilityRegistry()`

- [ ] **Step 1: Write failing tests (RED)**

```js
const REAL_WIRING_MISSING = 'real-guarded-runner-execution-wiring-missing';

const r = buildSupervisorLifecycleGuardedRunnerCapabilityInjectionReadiness();
assert.strictEqual(r.state, 'ready');
assert.strictEqual(r.pureCapabilityInjectionReady, true);
assert.strictEqual(r.dryRunCapabilityRegistryReady, true);
assert.strictEqual(r.realRenderCapabilityImplementationReady, true);
assert.strictEqual(r.realStatusCapabilityImplementationReady, true);
assert.strictEqual(r.realCapabilityImplementationsReady, false); // independent fact
assert.strictEqual(r.executeCapabilityRegistryReady, false);
assert.strictEqual(r.executeCapabilityAuthorized, false);
assert.strictEqual(r.realRunnerWiringReady, false);
assert.deepStrictEqual(r.nextBlockers, [REAL_WIRING_MISSING]);
assert.strictEqual(r.realImplementationEntries.length, 2);
const kinds = r.realImplementationEntries.map((e) => e.capabilityKind).sort();
assert.deepStrictEqual(kinds, ['render', 'status']);
const statusEntry = r.realImplementationEntries.find((e) => e.capabilityKind === 'status');
assert.strictEqual(statusEntry.capabilityId, 'real-status');
assert.strictEqual(statusEntry.implementationClass, 'real-implementation');
assert.strictEqual(statusEntry.sideEffectClass, 'observational-read');
assert.deepStrictEqual(statusEntry.supportsModes, ['real-proof']);
assert.strictEqual(statusEntry.contentReadAllowed, false);
assert.strictEqual(r.handler, undefined);
// write/reload/rollback/audit/notify must not appear as real entries
```

Also assert dry-run kinds still 7.

- [ ] **Step 2: Run RED**

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

- [ ] **Step 3: Implement bootstrap + readiness (GREEN)**

In `src/supervisor-lifecycle.js`:

1. Add constants: `REAL_STATUS_CAPABILITY_ID`, target tokens, basename map, max metadata size, deadline, max in-flight, outcome/blocker/evidence codes, `CAPABILITY_REAL_STATUS_PROOF_REQUEST_KEYS`, `CAPABILITY_STATUS_INPUT_KEYS`.
2. Add `buildRealStatusCapabilityDescriptor()` exact flags per spec §4.2（含 `contentReadAllowed:false`）。
3. Extend `trustedBootstrapCapabilityRegistry` after render registration:
   - validate status descriptor
   - `realCapabilityRegistry.set('status', { descriptor, handler })` (handler stub ok until Task 2–3)
   - assert size === 2; has render+status; no write/reload/…
   - **never** call ForTest hook from bootstrap
4. Implement `isRealStatusCapabilityRegistryReady()` separate from render probe.
5. Extend readiness object + `realImplementationEntries` summaries (plain only).
6. Comments exact 语义：observational vs mutation vs V1.32 hostSideEffect。

- [ ] **Step 4: Run GREEN**

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

- [ ] **Step 5: Commit (only when user explicitly asks)**

```text
feat: add V1.33 real status registry readiness contract
```

---

### Task 2: RealStatusProof authorize/invoke skeleton + exact snapshot + execute deny

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

**Interfaces:**
- `authorizeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(request): object`（sync）
- `invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(request): Promise<object>`（**async**）
- `snapshotRealStatusProofRequest` / `snapshotStatusInput` (private)
- execute path remains zero dispatch

- [ ] **Step 1: RED tests**

```js
function buildRealStatusProofRequest(overrides = {}) {
  return {
    capabilityKind: 'status',
    actionId: 'capture-current-state',
    operation: 'rollback',
    mode: 'real-proof',
    idempotencyKey: null,
    attemptRef: null,
    anchorRef: null,
    statusInput: { targetToken: 'linke-launch-agent-default' },
    ...overrides,
  };
}

// injection / wrong mode / wrong operation
const bad = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof({
  ...buildRealStatusProofRequest(),
  mode: 'execute',
});
assert.strictEqual(bad.state, 'denied');
assert.strictEqual(bad.executeCapabilityAuthorized, false);
assert.strictEqual(bad.hostMutationOccurred, false);
assert.strictEqual(bad.hostObservationOccurred, false);
assert.strictEqual(bad.hostSideEffectOccurred, false);

// targetToken type hard rejects
for (const badToken of [null, undefined, '', 1, true, {}, [], () => {}]) {
  const r = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
    buildRealStatusProofRequest({ statusInput: { targetToken: badToken } }),
  );
  assert.ok(r.state === 'denied' || r.state === 'error');
  assert.strictEqual(r.hostObservationOccurred, false);
  assert.strictEqual(r.hostSideEffectOccurred, false);
}

// nested extra key / proxy / getter → injection-rejected；三布尔 false

// request must reject path/home/cwd keys at top or nested

// authorize happy structure (may still fail observation until Task 3)
const auth = authorizeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
  buildRealStatusProofRequest(),
);
assert.strictEqual(auth.executeCapabilityAuthorized, false);
assert.strictEqual(auth.realCapabilityImplementationsReady, false);
```

Assert RealRenderProof still rejects `capabilityKind:'status'` (no expansion).

- [ ] **Step 2: Run RED**

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

- [ ] **Step 3: Implement snapshot + authorize + invoke skeleton (GREEN)**

1. Top-level exact snapshot keys = status proof keys; nested independent `statusInput` snapshot + **targetToken exact string allowlist**.
2. Reject path/home/cwd/homedir/reader injection keys.
3. authorize formula per spec §4.5（registry flags；**尚未**强制 host read 成功）。
4. invoke **async**: validation failures → error/denied with observation/sideEffect **false**；尚未接 reader 时可返回 incomplete/observation-failed（Task 3 接好后改 completed）。
5. JSDoc `@internal PROOF ONLY` on both exports；invoke documents async + V1.32 side-effect semantics.
6. **Do not** modify RealRenderProof kind allowlist.

- [ ] **Step 4: Run GREEN**

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

- [ ] **Step 5: Commit (only when user explicitly asks)**

```text
feat: add V1.33 real status proof authorize/invoke surface
```

---

### Task 3: Async metadata host reader + sanitize statusResult + production handler + TEST ONLY seam

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

**Interfaces:**
- private `createDefaultRealStatusHostReader()` → async metadata observer
- private `sanitizeStatusObservation(raw) → statusResult`（无 content hash）
- private `createRealStatusCapabilityHandler(reader)`
- private deadline/single-settle/in-flight helpers
- test-only:

```js
/**
 * @internal TEST ONLY — never call from production bootstrap / server / agent / web
 * Does not accept path/home/cwd injection from callers.
 */
export function setSupervisorLifecycleGuardedRunnerRealStatusHostReaderForTest(readerOrNull)
```

- [ ] **Step 1: RED tests**

```js
// Production reader path: typically absent on CI → completed + presence absent
const rc = await invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof(
  buildRealStatusProofRequest(),
);
assert.strictEqual(rc.receiptKind, 'capability-real-implementation-receipt');
assert.strictEqual(rc.capabilityId, 'real-status');
assert.strictEqual(rc.outcomeCode, 'capability-real-status-completed');
assert.strictEqual(rc.hostMutationOccurred, false);
assert.strictEqual(rc.hostObservationOccurred, true);
assert.strictEqual(rc.hostSideEffectOccurred, true); // V1.32 honor
assert.strictEqual(rc.realStatusCapabilityImplementationReady, true);
assert.strictEqual(rc.realCapabilityImplementationsReady, false);
assert.strictEqual(rc.executeCapabilityAuthorized, false);
assert.strictEqual(rc.realRunnerWiringReady, false);
assert.strictEqual(rc.executionEligible, false);
assert.strictEqual(rc.idempotencyKeyFingerprint, null);
assert.deepStrictEqual(rc.nextBlockers, [REAL_WIRING_MISSING]);
assert.strictEqual(rc.statusResult.observationClass, 'launch-agent-presence');
assert.strictEqual(rc.statusResult.targetToken, 'linke-launch-agent-default');
assert.ok([
  'present', 'absent', 'unreadable', 'unexpected-type',
  'oversize', 'symlink-blocked', 'observation-error',
].includes(rc.statusResult.presence));
assert.ok(['readable', 'unreadable', 'not-applicable', 'unknown']
  .includes(rc.statusResult.readability));
assert.ok(['empty', 'small', 'medium', 'oversize', 'unknown']
  .includes(rc.statusResult.sizeClass));
assert.strictEqual(rc.statusResult.contentSha256, undefined);
// must not leak path/home/error
const json = JSON.stringify(rc);
assert.ok(!/\/Users\//.test(json));
assert.ok(!/LaunchAgents/.test(json));
assert.ok(!json.includes(process.env.HOME || '___no_home___'));
assert.ok(!/"ENOENT"/.test(json)); // raw error.code not in receipt
```

Inject present metadata (no bytes):

```js
setReaderForTest({
  async observe() {
    return {
      kind: 'regular-file',
      size: 4, // metadata only — no bytes field required
    };
  },
});
const a = await invoke...RealStatusProof(req);
const b = await invoke...RealStatusProof(req);
assert.strictEqual(a.statusResult.presence, 'present');
assert.strictEqual(a.statusResult.isRegularFile, true);
assert.strictEqual(a.statusResult.readability, 'readable');
assert.strictEqual(a.statusResult.sizeClass, 'small');
assert.strictEqual(a.statusResult.contentSha256, undefined);
assert.deepStrictEqual(
  {
    presence: a.statusResult.presence,
    sizeClass: a.statusResult.sizeClass,
  },
  {
    presence: b.statusResult.presence,
    sizeClass: b.statusResult.sizeClass,
  },
);
// change metadata size bucket → sizeClass changes; still no content read
```

Inject / harness cases (production + fake where required):

- F1 timeout (slow fake + production deadline race)
- F2 ENOENT, F3 EACCES, F5 oversize metadata
- F8 concurrent double-settle, F10 late resolve/reject
- F11 target symlink, F12 directory, F16 parent symlink
- F17 target swap, F18 deadline before open, F19 after open
- F20 close failure, F21 in-flight cap, F22 no read APIs, F23 no raw error leak

- [ ] **Step 2: Run RED**

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

- [ ] **Step 3: Implement async reader + sanitize + handler (GREEN)**

1. Path derivation internal only: `os.homedir()` + `Library/LaunchAgents` + basename(token)；never echo.
2. Default async reader:
   - parent segment walk with `fs.lstat`；symlink / non-directory fail-closed
   - target `fs.lstat`
   - `fs.open(path, O_RDONLY | O_NOFOLLOW)` — **macOS 必须启用 O_NOFOLLOW**（不写「若支持」）
   - `fh.stat()` reconfirm regular + metadata size cap
   - **禁止** `fh.read` / `readFile` / streams
   - `finally` `fh.close()`；close failure → 若不已 completed 则保守 `observation-failed`；single receipt；不泄漏
3. Absolute deadline + single-settle guard；late discard + catch；AbortSignal 协作取消可选，但**不得**谎称 syscall 可强制取消。
4. In-flight cap + 防重复启动。
5. Sanitize **only** enums/boolean/token；strip any path/error raw fields；**无** contentSha256 / raw size。
6. Handler returns plannedAction `capture-state` + statusResult for receipt assembly。
7. Observe 路径 receipt 三布尔：observation true + sideEffect true + mutation false。
8. Production bootstrap uses default reader；ForTest hook swaps reader and **must reset in `afterEach`**；bootstrap **永不**调用 hook。
9. **Forbidden:** import/call `buildSupervisorStatusResponse`；child_process；launchctl；Sync fs；content hash。

- [ ] **Step 4: Run GREEN**

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

- [ ] **Step 5: Commit (only when user explicitly asks)**

```text
feat: add V1.33 observational status async metadata host reader and proof receipts
```

---

### Task 4: Resolve mappings + gate integration + per-kind separation + execute zero-dispatch proof

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

- [ ] **Step 1: RED**

```js
// rollback resolve surfaces realStatus fields on capture-current-state mapping
const decision = resolveSupervisorLifecycleGuardedRunnerCapabilityInjection(
  rollbackCandidates,
  'rollback',
);
const row = decision.mappings.find((m) => m.actionId === 'capture-current-state');
assert.strictEqual(row.primaryCapabilityKind, 'status');
assert.strictEqual(row.realCapabilityId, 'real-status');
assert.strictEqual(row.realStatusCapabilityImplementationReady, true);
assert.strictEqual(row.hostObservationOccurred, false); // resolve does not observe
assert.strictEqual(row.hostSideEffectOccurred, false);
assert.strictEqual(decision.executeCapabilityAuthorized, false);
assert.strictEqual(decision.realCapabilityImplementationsReady, false);

// gate production ready — global false is independent fact, not "ready success input"
const gate = buildSupervisorLifecycleGuardedRunnerExecutionGate(/* production ready inputs */);
assert.strictEqual(gate.realStatusCapabilityImplementationReady, true);
assert.strictEqual(gate.realRenderCapabilityImplementationReady, true);
assert.strictEqual(gate.realCapabilityImplementationsReady, false);
assert.strictEqual(gate.executionEligible, false);
assert.strictEqual(gate.realRunnerWiringReady, false);
assert.strictEqual(gate.hostObservationOccurred, false);
assert.strictEqual(gate.hostSideEffectOccurred, false);
assert.strictEqual(gate.statusResult, undefined); // gate has no live statusResult
assert.deepStrictEqual(gate.nextBlockers, [REAL_WIRING_MISSING]);
// options override ignored
const poisoned = buildSupervisorLifecycleGuardedRunnerExecutionGate(prod, {
  realStatusCapabilityImplementationReady: false,
  hostObservationOccurred: true,
  hostSideEffectOccurred: true,
  executeCapabilityAuthorized: true,
  realCapabilityImplementationsReady: true,
});
assert.strictEqual(poisoned.realStatusCapabilityImplementationReady, true);
assert.strictEqual(poisoned.hostObservationOccurred, false);
assert.strictEqual(poisoned.hostSideEffectOccurred, false);
assert.strictEqual(poisoned.executeCapabilityAuthorized, false);
assert.strictEqual(poisoned.realCapabilityImplementationsReady, false);

// execute dry-run entry still hard-deny; status reader not called
// (spy via ForTest reader that throws if called)
```

Per-kind: document/test that render probe and status probe are independent.

- [ ] **Step 2–4: RED → implement → GREEN**

Wire mappings（mirror V1.32 render mapping pattern for status action only）、gate fields、ignore overrides。Gate 注释：`realCapabilityImplementationsReady:false` 是独立 fail-closed 事实，不是 ready 成功信号。

- [ ] **Step 5: Commit (only when user explicitly asks)**

```text
feat: wire V1.33 real status readiness into gate and mappings
```

---

### Task 5: Web shall line + Gold evidence + version/README + scope/sensitive scans

**Files:**
- Modify: `src/web/app.js`
- Modify: `test/web-console.test.js`
- Modify: `src/gold-readiness.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `src/version.js` → `V1.33`
- Modify: `README.md`（版本条 + 诚实边界；V1.33 current；V1.32 historical 仍在且不再 current）
- Modify: `test/version.test.js`（当前里程碑断言 → V1.33；现有 L16–17 仍断言 V1.32）
- Modify: `test/readme.test.js`（V1.33 current + V1.32 historical；现有约 L1871+ 仍断言 V1.32 current milestone）

- [ ] **Step 1: RED Web + Gold + version/README**

```js
// ready path includes gate non-live facts only:
// realStatusCapability:state:ready:realStatusReady:true:hostObservationOccurred:false:hostSideEffectOccurred:false:hostMutationOccurred:false:realCapabilityImplementationsReady:false:realRunnerWiringReady:false:blocker:none
// validationLines: hostObservationOccurred:false, hostSideEffectOccurred:false, realCapabilityImplementationsReady:false — NO statusResult
// executionSentinel still blocked
// realRenderCapability line still present
// existing web consumption points display gate non-live facts only (not live observation)
```

- evidence 含 RealStatusProof 函数名、`realStatusCapabilityImplementationReady:true`、observe 三布尔语义、`realCapabilityImplementationsReady:false`、`capability-real-status-completed`、metadata-only / no content hash 等
- overall blocked
- nextStep 指向 V1.33 observational status metadata completed + 下一步仍为更多 real kinds / §4.5 loci / dual-gate execute；Gold remains blocked
- **不得**暗示 cross-LAN 或 V2.0 Gold/GA 已由本版完成

**version/README RED（必做；否则 full `node --test` 必红）：**

```bash
# 先写/改测试期望为 V1.33 current，在实现 version/README 之前跑 → 期望失败（RED）
node --test test/version.test.js
node --test test/readme.test.js
# version.test.js：LINKE_RELEASE_VERSION 当前里程碑从 V1.32 → V1.33
# readme.test.js：title/badge/version table 以 V1.33 为当前；V1.32 历史条目仍存在且不再 current
```

- [ ] **Step 2: Implement Web + Gold + version + README + version/readme tests (GREEN)**

1. `buildSupervisorLifecycleGuardedRunnerRealStatusCapabilityLines` 镜像 realRender 行模式，含 sideEffect false（非 live）。
2. validationLines 增量字段；**无** statusResult 行。
3. **不** live 调用 proof API。
4. `src/version.js` → `V1.33`；同步 `test/version.test.js` 当前里程碑断言。
5. README：V1.33 = second real capability = observational **metadata** status only；hostSideEffect true on live observe（V1.32 语义）；非 Gold/GA；非跨局域网；**保留** V1.32 历史条目且标记为历史（不再 current）。
6. 同步 `test/readme.test.js`：V1.33 current + V1.32 historical 合同。

- [ ] **Step 3: GREEN focused verification + Scope & scans**

```bash
# server/agent/web zero refs to proof/test seam
rg -n "RealStatusProof|RealRenderProof|RealStatusHostReaderForTest" src/server.js src/agent.js src/web/app.js
# expect no matches for RealStatusProof / ForTest in server/agent/web

# no shell/exec/content-read/sync in lifecycle status path (category counts)
rg -n "child_process|execFile|spawn\(|shell:\s*true|launchctl|appendAuditEvent|writeFile|appendFile|readFile|readSync|lstatSync|openSync|createReadStream" src/supervisor-lifecycle.js

# O_NOFOLLOW present
rg -n "O_NOFOLLOW" src/supervisor-lifecycle.js

# focused tests（含 version/readme；遗漏则 full test 红）
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
node --test test/web-console.test.js
node --test test/gold-readiness.test.js
node --test test/version.test.js
node --test test/readme.test.js

# full
node --test
```

Assert: no import of `buildSupervisorStatusResponse` from lifecycle；no `contentSha256` on statusResult。

Scope：diff 路径 ⊆ §9.1 **精确 10 files**（README + 4 src + 5 tests：gate/web/gold/version/readme）；**默认禁止** agent/server/package。

- [ ] **Step 4: Commit (only when user explicitly asks)**

```text
feat: add V1.33 real observational status capability handler
```

---

### Task 6: Full TDD matrix closeout（T1–T44 / F1–F23）+ 自检

**Files:** tests only if gaps remain; no new product files beyond §9.1 精确 10 files.

- [ ] **Step 1: Checklist pass**

对照 spec §10 T1–T44 与 §6 F1–F23，补齐缺失用例（尤其 F1/F8/F10 生产+fake、F16–F23、T35–T44、三布尔、无 content hash、O_NOFOLLOW、TEST ONLY hook、Web 无 statusResult、version V1.33 current、README V1.32 historical 仍在且不再 current）。

- [ ] **Step 2: Full test**

```bash
node --test
```

- [ ] **Step 3: Final honesty checklist**（见文首清单）全部勾选

- [ ] **Step 4: Confirm recovery anchor documented as `c311a7e`**；确认 plan/tasks **无** `git reset --hard` 常规步骤；确认 **无** V2.0 Gold/跨局域网实现任务；确认 scope **精确 10 files**

- [ ] **Step 5: Commit (only when user explicitly asks)** — 若 Task 5 已 monorepo 一次提交，本 task 仅补测试：

```text
test: complete V1.33 real status observational proof matrix
```

---

## Verification Commands（汇总）

### Focused

```bash
node --test test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
node --test test/web-console.test.js
node --test test/gold-readiness.test.js
node --test test/version.test.js
node --test test/readme.test.js
```

### Full

```bash
node --test
```

### Scope / sensitive / side-effect

```bash
rg -n "RealStatusProof|RealRenderProof|RealStatusHostReaderForTest" src/server.js src/agent.js src/web/app.js
rg -n "buildSupervisorStatusResponse" src/supervisor-lifecycle.js
rg -n "child_process|execFile|spawn\(|shell:\s*true|appendAuditEvent|readFile|readSync|lstatSync|openSync|createReadStream" src/supervisor-lifecycle.js
rg -n "O_NOFOLLOW|fs/promises|hostSideEffectOccurred|contentReadAllowed" src/supervisor-lifecycle.js
# Public receipt samples in tests: assert no /Users/, HOME, LaunchAgents absolute,
# pid lists, contentSha256, raw error codes/messages, raw size
# Scope: exact 10 files only — README + 4 src + 5 tests (gate/web/gold/version/readme)
# Default forbidden: src/agent.js src/server.js package.json
```

**Pass rules:**

- server/agent/Web proof & ForTest refs = 0
- lifecycle 不引用 `buildSupervisorStatusResponse`
- 无 child_process / appendAuditEvent / content-read / Sync-fs 于 status 路径
- async lstat/open/stat/close + O_NOFOLLOW 仅出现在 status reader 私有区
- 敏感 category 回显 = 0（测试断言）
- observe 路径三布尔 true/true/false；Gate/Web false/false/false
- scope **精确 10 files**；version V1.33 current；README V1.32 historical 仍在且不再 current

### Recovery

- Anchor: **`c311a7e`** — `feat: add V1.32 first real render capability`
- On scope escape: discard WIP and re-apply from clean tree at anchor
- **Do not** list `git reset --hard` as a normal implementation step

---

## Implementation Scope Summary（预计实现阶段）

**精确 10 files：** README + 4 src + 5 tests（gate / web / gold / version / readme）。**默认禁止** `src/agent.js` / `src/server.js` / `package.json`。

| 路径 | 动作 |
| --- | --- |
| `src/supervisor-lifecycle.js` | real-status registry、**async metadata** reader、async RealStatusProof、deadline/single-settle/in-flight、readiness/gate/mappings、TEST ONLY hook |
| `src/web/app.js` | shall realStatus 行 + validationLines（**非 live**；无 statusResult） |
| `src/gold-readiness.js` | evidence + nextStep（仍 blocked；无 V2.0 Gold 宣称） |
| `src/version.js` | V1.33 |
| `README.md` | 版本/边界（metadata-only；V1.32 side-effect 语义；非 Gold/跨局域网）；V1.33 current；**保留** V1.32 历史且不再 current |
| `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js` | 主 TDD async 矩阵 T1–T44 / F1–F23 |
| `test/web-console.test.js` | Web 行 |
| `test/gold-readiness.test.js` | Gold |
| `test/version.test.js` | 当前里程碑 → V1.33（先 RED 后 GREEN） |
| `test/readme.test.js` | V1.33 current + V1.32 historical 合同（先 RED 后 GREEN） |

**默认不改：** `src/agent.js`、`src/server.js`、`package.json`、audit-log、任何 NAS/G0a 报告、跨局域网协议模块。

**预计实现规模（相对旧 sync+content 方案）：** 略增于 async deadline/race/close/in-flight 测试；**删除** content hash / Sync read 实现与相关测试；**不**增加跨局域网或 Gold 任务；**必须**同步 version/readme 测试否则 full test 红。

---

## Completion Criteria

1. Decision **A** implemented; B/C not implemented.
2. Registry **7 dry-run + 2 real (render/status)**; global real false (independent fact); per-kind local ready separated.
3. Independent **async** RealStatusProof with `@internal PROOF ONLY`; RealRenderProof unchanged kind; server/agent zero refs.
4. Honest **async metadata-only** observational reader (Node `fs/promises` fixed path); **not** static server status; **not** shell; **not** Sync; **not** content read.
5. `statusResult` sanitized enums/boolean only (`presence`/`isRegularFile`/`readability`/`sizeClass`); no path/HOME/username/pid/stdout/plist body/raw size/content hash/error raw fields.
6. Observe path: `hostMutationOccurred:false` + `hostObservationOccurred:true` + `hostSideEffectOccurred:true` (V1.32 honor). Validation/Gate/Web: observation+sideEffect false.
7. Execute hard-deny zero dispatch; no elevation of execute/wiring/executionEligible/Gold; wiring-missing retained.
8. Failure injection matrix F1–F23 covered; F1/F8/F10 production+fake; test fakes ≠ production evidence.
9. Web shall realStatus line (non-live only); sentinel blocked; Gold blocked with updated evidence; no V2.0 Gold/cross-LAN claim.
10. Scope **exact 10 files**: README + 4 src + 5 tests (gate/web/gold/version/readme); default forbid agent/server/package.
11. Tests T1–T44 green (incl. version V1.33 current + README V1.32 historical still present, no longer current); focused + full `node --test` green.
12. Scans pass; O_NOFOLLOW forced; recovery anchor `c311a7e` documented.
13. **No** claim of Gold/GA release, cross-LAN completion, or real runner wiring complete.

---

## Self-check（文档阶段完成）

- [x] 仅新增 specs + plans 下 V1.33 两文档（本阶段）
- [x] 决策矩阵 A/B/C 与源码证据
- [x] 选定 A；拒绝 B/C/静态/shell/Sync/content-hash/扩 RenderProof/重定义 sideEffect/跨局域网
- [x] RealStatusProof 独立 async 论证
- [x] 固定 allowlist + async metadata reader + sanitize schema
- [x] V1.32 hostSideEffect 语义恢复并全量同步
- [x] 失败注入矩阵 F1–F23（含 concurrent/late/close/parent symlink/target swap/deadline/oversize/no-content）
- [x] hostMutation / hostObservation / hostSideEffect 术语
- [x] execute 边界与 dual registry 7+2；全局 false 独立事实
- [x] Gate/Web 非 live；validation 无 statusResult
- [x] V2.0 Gold/GA + 跨局域网声明（非本版 scope）
- [x] TDD 分 task；**精确 10 files** allowlist（README + 4 src + 5 tests：gate/web/gold/version/readme）；默认禁止 agent/server/package
- [x] version/readme 测试纳入 Task5 Files / focused / scope（遗漏则 full test 红）；V1.32 historical 仍在且不再 current
- [x] 验证命令、扫描、锚点 c311a7e
- [x] 无 git reset --hard 常规步骤
- [x] P0/P1 与完成标准更新

---

## Notes for implementers

- Prefer **async** `fs/promises` only for production status reader; **do not** use Sync APIs.
- On real fs observation start: set **both** `hostObservationOccurred` and `hostSideEffectOccurred` true; mutation false. This honors V1.32 and does **not** elevate execute/global real/wiring/Gold.
- **Never** read file content or emit `contentSha256` on statusResult.
- `presence:'absent'` is a **successful** real observation.
- macOS: `O_NOFOLLOW` **must** be set on open; do not write “if supported”.
- Close failure: no leak; conservative fixed observation-failed if not already completed; single receipt.
- Absolute deadline + single-settle; late results discarded with rejection catch and best-effort close; do not claim all syscalls are force-cancellable.
- In-flight cap / anti-duplicate start to prevent timeout floods.
- F1/F8/F10 must exercise production async semantics **and** test fakes.
- Never write into the user's LaunchAgents directory in tests.
- Reset test reader hooks in `afterEach` to avoid cross-test pollution.
- TEST ONLY hook: JSDoc required; never called from production bootstrap; never referenced from server/agent/Web; never injectable via request.
- Do not start implementation in the docs-only phase; wait for explicit implement instruction.
- Cross-LAN and Gold/GA are **V2.0** concerns — out of scope here.
