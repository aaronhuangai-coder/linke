# V1.38 Read-Only Audit Integrity Run-Once Monitor/Alert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 **M6d T6d.4 最小可用** 的 **只读、单次运行** audit integrity monitor + **机器可消费本地 alert contract**（固定 JSON + exit 0/1/2）。实现后仅升 **V1.38**；Gold 仍 **blocked 4/4/1/9**；`production-hardening` **partial**；T6d.3 **still partial**。

**签字上限（唯一允许的完成宣称）：**
`V1.38 read-only audit integrity run-once monitor/alert implementation`

**可附带窄句：** T6d.4 minimum viable run-once path **delivered**。

**不是：** T6d.3 complete / M6d Exit / production-hardening ready / Gold ready / managed scheduler / remote notification delivered / production monitoring ready / multi-process exclusive lock / journal rotation / caller delivery enforcement / authenticity / external anchor / HMAC / signature / immutable / state continuity / monitor auto-repair/bootstrap/recovery / HTTP-Web monitor / WORM / forbidden compound（`tamper-`+`evident` 两段拼接；文档不写完整相邻字面量）。

**Architecture:**
- `src/audit-integrity-dual-write.js` — 新增 public **read-only** inspector：`inspectAuditIntegrityDualWriteReadOnly`；`assertSafeDataRoot` 先；RootFail → 冻结 path-free IO observation（enqueue 0）；**仅** valid resolvedRoot → shared queue **exactly once** + **fresh lease** → 只读观察；**禁止** bootstrap/recover/publish/write；**observation.reasonCode SoT**（已注册 ERROR_CODES 或 null；复用本模块既有 ERROR_CODES import/typed errors；**不**新增码；closed-set 仍 60）
- `src/audit-integrity-monitor.js` — **只** import public inspector（**无** error-codes import）；将 observation 视为受信内部合同，**直接映射** reasonCode；结构不满足冻结 shape 时 fail-closed → `integrity-alert` + `reasonCode: null`；**禁止** membership whitelist / **禁止**复制 registry；映射冻结 report；exit helper；JSON formatter；test-only Symbol 经 data-property descriptor 注入 `checkedAt`
- `src/agent.js` — exact-one CLI：`audit-integrity-monitor --data-dir <path>`；stdout JSON；exit 0/2/1
- 复用：write-queue / dual-write-state load / journal inspect-verify / cross-store verify / 既有 cursor+fingerprint+cross-store SoT（**同模块 extraction/reuse；禁止复制 formula**）
- idle cursor：**private granular precise helper**（inspector 专用精确分类）；**禁止** inspector wholesale 调 V1.37 remapping wrapper
- server/web — **zero** wiring；server/agent audit catch **不改**
- ERROR_CODES — **保持 60**；monitor condition `code` 独立 enum；reasonCode membership 不在 monitor 复验

**Tech Stack:** Node.js ESM、`node:test` / `node:assert/strict`、既有 safe-data-files / error-codes / dual-write 栈。无新 npm 依赖。

**Design SoT:** `docs/superpowers/specs/2026-07-19-audit-integrity-monitor-alert-design.md`

---

## C0 review gate（implementation PROCEED 前强制）

```text
C0 审查门（docs 审查；≠ 实现完成）:
  1. design + 本 plan 完稿且自洽
  2. GLM 抗辩 PASS（无 P0）后记录
  3. fresh Grok 只读闭环 PASS / PROCEED YES 后记录
  4. PM 验收通过后：C0 可 commit 并开始 C1

任一 FAIL → 禁止 implementation PROCEED；改 docs，不写代码。
禁止把本 C0 文档阶段写成 V1.38 实现完成。
```

**C0 docs review record（仅 docs 审查证据；≠ 实现完成）：**

```text
GLM C0 verdict: PASS
  P0 = 0
  P1 = 0
  P2 = 3
  PROCEED = YES

P2 disposition（PM；第一轮 GLM）:
  全部 3 个 P2 已在 design + 本 plan 文档收紧，避免实现漂移：
  1) idle + empty / uncovered-events 确定映射（fail-closed integrity-alert）
  2) unsafe/oversize/state IO 与 assertSafeDataRoot 确定映射（io-alert + dual-write-io-error）
  3) Task 0 ERROR_CODES exact preflight（实际 ERROR_CODES / assertRegisteredErrorCode）
  其它冻结合同不变。本记录不得写成实现完成。

fresh Grok C0 verdict（round 1）: PASS
  P0 = 0
  P1 = 0
  P2 = 2
  PROCEED = YES
  FILES_CHANGED = none

P2 disposition（PM；fresh Grok round 1 后收紧；docs only；≠ 实现完成）:
  全部 2 个 P2 已在 design + 本 plan 文档收紧：
  1) cursor SoT / typed error 精确化：
     同模块外科抽取 private read-only granular helper；
     inspector 只调 granular precise helper，
     禁止 wholesale 调用 V1.37 validateIdleCursorAgainstStoresUnlocked
     （该 wrapper 将 cross-store throw / UTF-8 baseline fail remap 为
      audit-integrity-dual-write-cursor-mismatch，破坏 #8/#9/#10 precise priority）；
     production wrapper 必须委托/refactor 后保持 V1.37 外部 remapping 无回归
  2) relationship 输出确定化：
     prepared/cursor-mismatch/typed-error/IO/RootFail → relationship=null 固定；
     state-missing + receipt 成功 → relationship 精确取 receipt enum；
     state-missing + typed error → relationship=null + typed priority；
     idle healthy/empty/uncovered → exact allowed enum
  本记录仅为 docs review PASS + P2 tightened；不是实现完成。

fresh Grok C0 verdict（final）: PASS
  P0 = 0
  P1 = 0
  P2 = 1
  PROCEED = YES
  FILES_CHANGED = none

P2 disposition（PM；fresh Grok final 后收紧；docs only；≠ 实现完成）:
  唯一 1 个 P2 已在 design + 本 plan 文档收紧：
  observation 字段 vs report 字段漂移：
    1) inspector observation **仅** `statePresence`
       enum=absent|idle|prepared|invalid|io-error；**删除** `unsafe`
       （V1.37 load 统一 state safe-read failure→dual-write IO；RootFail 在
        state read 前 IO observation；本版不额外 occupancy 细分）
    2) observation.stateStatus 保持 idle|prepared|null
    3) observation **禁止** dualWriteState；`dualWriteState=unknown` 仅 report（C2）
       C1 RED 断言 observation.statePresence/stateStatus 等，不得写 observation.dualWriteState
    4) journalOutcome enum 扩为 missing|verified|typed-error|skipped
       （未执行≠typed-error；Sio/RootFail 取 skipped）
    5) Sio/RootFail 全 observation 字段冻结（design §3.2 表）：
       statePresence=io-error；stateStatus=null；storesEmpty=false；
       cursorMatch=skipped；journalOutcome=skipped；crossStoreOutcome=skipped；
       relationship=null；reasonCode=audit-integrity-dual-write-io-error；
       errorLayer=state（Sio）/root（RootFail）
  本记录仅为 docs review PASS + P2 tightened；不是实现完成。
```

---

## PM 冻结摘要（实现不得偏离）

```text
MILESTONE     = V1.38 = M6d T6d.4 minimum viable run-once monitor/alert
SIGNATURE     = V1.38 read-only audit integrity run-once monitor/alert implementation
ALSO_OK       = T6d.4 minimum viable run-once path delivered
NOT           = T6d.3 complete | M6d Exit | production-hardening ready | Gold ready
                | managed scheduler | remote alert delivered | production monitoring ready
                | multi-process lock | monitor writes | --recover | HTTP/Web monitor
GOLD          = blocked 4 ready / 4 partial / 1 blocked / total 9
ERRORS        = ERROR_CODES closed-set remains 60 (default NO new codes)
CONDITION     = healthy|uninitialized|state-missing|recovery-required|integrity-alert|io-alert
REPORT_KEYS   = schemaVersion,status,code,checkedAt,dualWriteState,relationship,
                recoveryRequired,alertRequired,nextAction,reasonCode
                (exact order; frozen; path/body/digest/token-free)
STATUS        = healthy|alert
DUAL_STATE    = idle|prepared|missing|invalid|unknown
                (**report-only**; NEVER on observation)
OBS_FIELDS    = statePresence,stateStatus,storesEmpty,cursorMatch,
                journalOutcome,crossStoreOutcome,relationship,reasonCode,errorLayer
                FORBIDDEN on observation: dualWriteState
STATE_PRESENCE= absent|idle|prepared|invalid|io-error
                (DELETED unsafe — unreachable/unfrozen; V1.37 unifies state
                 symlink/dir/oversize/permission/other safe-read → dual-write IO;
                 RootFail before state read → IO obs; no extra occupancy split)
STATE_STATUS  = idle|prepared|null
CURSOR_MATCH  = n/a|match|mismatch|skipped
JOURNAL_OUT   = missing|verified|typed-error|skipped
                (principle: unexecuted probe MUST NOT be typed-error → use skipped)
CROSS_OUT     = ok|typed-error|skipped
ERROR_LAYER   = none|state|journal|events|cross-store|cursor|root
SIO_OBS       = #7 full freeze (C1 assert every field):
                  statePresence=io-error; stateStatus=null; storesEmpty=false;
                  cursorMatch=skipped; journalOutcome=skipped;
                  crossStoreOutcome=skipped; relationship=null;
                  reasonCode=audit-integrity-dual-write-io-error;
                  errorLayer=state
ROOTFAIL_OBS  = #7b full freeze (C1 assert every field):
                  same as SIO_OBS but errorLayer=root; enqueue 0; no root create
SIO_ROOT_RPT  = report #7/#7b (C2 only): io-alert; dualWriteState=unknown;
                relationship=null; reasonCode=dual-write-io-error
RELATIONSHIP  = empty|equal|events-suffix-of-journal|journal-suffix-of-events|
                uncovered-events|null  (existing enums only; output DETERMINISTIC):
                prepared/cursor-mismatch/typed-error/IO/RootFail/invalid → null fixed
                state-missing + receipt ok → exact receipt enum; reasonCode null
                state-missing + typed error → null + typed code/reason priority
                cold empty → null; idle healthy → exact allowed enum;
                idle empty/uncovered → exact empty|uncovered-events
NEXT_ACTION   = none|initialize-via-production-write|run-explicit-recovery|investigate-integrity
REASON        = registered ERROR_CODES value OR null (never message/path/raw)
                SoT = inspector observation contract (dual-write reuses existing
                ERROR_CODES import/typed errors; NO new codes; closed-set 60)
                idle precise typed via granular helper (NOT remapping wrapper):
                  journal typed / cross-store typed / IO preserved;
                  raw fingerprint mismatch OR receipt strictCount≠idle → cursor-mismatch
                monitor treats observation as trusted internal contract;
                maps reasonCode directly; NO membership whitelist;
                NO error-codes import; NO registry copy
                structure fail-closed only: bad observation shape →
                integrity-alert + reasonCode null
CHECKED_AT    = strict ISO ...sssZ; DEFAULT real clock
                test-only: Object.getOwnPropertyDescriptor(options, SYMBOL) must be
                plain own data property (own value, no get/set) + strict ISO string
                else/throw → real clock; FORBIDDEN ordinary options[SYMBOL] read
                FORBIDDEN claim: monitor never triggers Proxy trap
                REQUIRED: trap may run; must not escape/leak; getter must not run
                CLI never passes test Symbol / no clock override flag
INSPECTOR     = inspectAuditIntegrityDualWriteReadOnly(dataDir, options?)
                options fully reserved: void options; no property/reflection/enumeration
                hostile Proxy traps do NOT run on inspector path
                assertSafeDataRoot first;
                RootFail (path unsafe/nonexistent/non-directory/invalid dataDir)
                  → frozen path-free #7b observation (ROOTFAIL_OBS); enqueue 0
                valid resolvedRoot only → enqueue exactly once + fresh lease
                read-only SoT only
                CURSOR SoT: same-module private granular read-only helper
                  (extract/reuse journal+events fingerprint + cross-store SoT;
                   NO formula copy; NO “pick one” alternative)
                inspector MUST call granular precise helper;
                FORBIDDEN: wholesale call validateIdleCursorAgainstStoresUnlocked
                  (V1.37 remaps cross-store throw/UTF-8 → cursor-mismatch;
                   would break #8/#9/#10 precise typed priority)
                production validateIdleCursorAgainstStoresUnlocked MUST
                  delegate/refactor to same helper and KEEP V1.37 external
                  remapping (cross-store/UTF-8 → cursor-mismatch); dual-write
                  regression tests prove no production path regression
                observation.reasonCode SoT: registered ERROR_CODES | null
                (reuse dual-write existing ERROR_CODES import/typed errors;
                 NO new codes; closed-set 60; C1 membership tests)
                FORBIDDEN: bootstrap/recover/publish/write/plan/publishPlanned
                FORBIDDEN on observation: dualWriteState; statePresence=unsafe
MONITOR_MOD   = src/audit-integrity-monitor.js
                ONLY import public inspector
                reasonCode: direct map from trusted observation; NO membership whitelist
                structure fail-closed only → integrity-alert + reasonCode null
                FORBIDDEN import: error-codes, unlocked mutators, dual-write-state, journal,
                  cross-store, write-queue, audit-log, server, agent, safe-data-files writers
CLI           = node src/agent.js audit-integrity-monitor --data-dir <path>
                accept: command + exact one --data-dir + exact one path value
                reject: token/output/recover/fail-on-blocked/server/extra/duplicate/boolean
                healthy stdout JSON exit 0; alert stdout JSON exit 2; argv contract stderr exit 1
                legal argv + nonexistent/unsafe path → io-alert exit 2 (NOT exit 1)
                do not confuse CLI argv string contract vs library invalid dataDir type
                no network; no file writes; no --recover
CONCURRENCY   = in-process queue only; not multi-process safe
                active writer → monitor waits → stable post
                prepared crash leftover → recovery-required; zero writes
                50 monitors; cross-root; no nested enqueue/deadlock
ZERO_WRITE    = events/journal/state bytes + existence unchanged on all paths
PRIORITY      = design §3.7 frozen short-circuit
SCHEME        = SELECTED A; REJECTED B timer+spool; REJECTED C lock/anchor first
M1_AUDIT_DOC  = do not rewrite
CALLER_CATCH  = server/agent best-effort audit catch UNCHANGED
VERSION_BUMP  = only C5 after C1–C4 green
GIT_AUTH      = each boundary tests+review green → PM precise stage/commit/push
                never stage untracked package-lock.json
IMPLEMENTERS  = Grok codes; GLM adversarial; fresh Grok acceptance per boundary
```

```text
SELECTED = A read-only library inspector + Agent CLI run-once
REJECTED = B server background timer + local alert spool
REJECTED = C multi-process lock or external anchor as first step
```

---

## Commit boundaries（强制）

| Boundary | Contents | Commit message（boundary 测试绿后 PM 精确 stage/commit/push） |
| --- | --- | --- |
| **C0 docs** | 仅两份 docs（design + 本 plan） | `docs: design V1.38 read-only audit integrity run-once monitor/alert` |
| **C1 inspector** | dual-write public read-only inspector + behavior tests | `feat: add read-only audit integrity dual-write inspector` |
| **C2 monitor core** | `audit-integrity-monitor.js` report/alert + tests | `feat: add audit integrity run-once monitor report contract` |
| **C3 Agent CLI** | agent dispatch + spawn CLI tests | `feat: add agent audit-integrity-monitor CLI` |
| **C4 scans/hostile** | hostile / honesty / concurrency / zero-write / isolation scans | `test: audit integrity monitor scans concurrency and honesty` |
| **C5 temporal→V1.38** | version / Gold / README honesty（Gold 仍 4/4/1/9 partial） | `chore: release milestone V1.38 audit integrity run-once monitor` |
| **C6 full suite** | full `npm test` + GLM 抗辩 + fresh Grok closure | 仅在有修复时 `test:`/`fix:` commit |

**规则：**

- Never mix C0 docs-only with code。
- **每个 boundary** 相关测试与审查绿后，**PM 精确 stage 该 boundary 文件 → commit → push**；永不 stage 未跟踪 `package-lock.json`。
- Never bump version before C1–C4 绿。
- 每任务：精确 files、RED/GREEN 命令、≥关键测试清单、commit message、禁止项、rollback。
- 测试写盘 **只能** `mkdtemp(join(tmpdir(), ...))`。
- Commit message / README / Gold **禁止**无限定 T6d.3 complete、M6d Exit、production-hardening ready、remote alert delivered、production monitoring ready、完整 forbidden compound 字面量。
- 每个 boundary runtime 必须可运行：真实功能或真实 fail-closed；禁止 silent stub 假绿。
- **禁止** “实现选一” / TODO stub 当完成。

---

## Fresh review / PM gate（代码前）

- [ ] **G0:** design + 本 plan 完稿；三方案 A 选定 / B·C 拒绝已写。
- [ ] **G1:** GLM 抗辩 PASS（无 P0）。
- [ ] **G2:** fresh Grok 对照 design + plan + V1.37 源码事实 = PASS / PROCEED YES。
- [ ] **G3:** PM 验收后 **C0 可 commit** 并 **开始 C1**（≠ V1.38 实现完成）。

若 P0：**停**；改 docs；不写代码。

---

## 全局命令约定

```bash
# C1 inspector
node --test test/audit-integrity-dual-write-readonly-inspect.test.js
# 或并入 dual-write suite 时：
node --test test/audit-integrity-dual-write.test.js

# C2 monitor
node --test test/audit-integrity-monitor.test.js

# C3 CLI
node --test test/agent-audit-integrity-monitor.test.js

# C4 scans
node --test test/audit-integrity-monitor-scans.test.js

# 回归
node --test test/audit-integrity-dual-write.test.js \
  test/audit-integrity-dual-write-state.test.js \
  test/audit-integrity-dual-write-scans.test.js \
  test/audit-integrity-journal.test.js \
  test/audit-integrity-cross-store.test.js \
  test/audit-log.test.js \
  test/error-codes.test.js

# C5 诚实
node --test test/version.test.js test/gold-readiness.test.js test/cross-lan-m1-exit-audit.test.js

# 全量
npm test
```

期望：exit 0；ERROR_CODES length **60**；全量仅既有 keychain skip（若有）。

---

## Task 0: Baseline 确认（无产品代码）

**Files:** Read only

- design + 本 plan
- `src/audit-integrity-dual-write.js`
- `src/audit-integrity-dual-write-state.js`
- `src/audit-integrity-write-queue.js`
- `src/audit-integrity-journal.js`
- `src/audit-integrity-cross-store.js`
- `src/audit-log.js`
- `src/agent.js`
- `src/error-codes.js` / `src/version.js` / `src/gold-readiness.js`
- 相关 `test/audit-integrity-*` / `test/agent-*.test.js`

- [ ] **Step 0.1:** 记录 baseline

```bash
node --test test/audit-integrity-dual-write.test.js \
  test/audit-integrity-dual-write-scans.test.js \
  test/error-codes.test.js test/version.test.js
node -e "import { ERROR_CODES } from './src/error-codes.js'; import { LINKE_RELEASE_VERSION } from './src/version.js'; console.log(LINKE_RELEASE_VERSION, Object.keys(ERROR_CODES).length)"
```

Expected: exit 0；version **V1.37**；ERROR_CODES **60**。

- [ ] **Step 0.1b: exact ERROR_CODES preflight（实际 registry；不硬猜）**

```bash
node -e "
import { ERROR_CODES, assertRegisteredErrorCode } from './src/error-codes.js';
const required = [
  'audit-integrity-not-initialized',
  'audit-integrity-cross-store-broken',
  'audit-integrity-dual-write-state-invalid',
  'audit-integrity-dual-write-io-error',
  'audit-integrity-dual-write-cursor-mismatch',
  // 计划/design 实际引用的其它 journal/event/cross-store IO/invalid 码：
  'audit-integrity-io-error',
  'audit-integrity-event-invalid',
  'audit-integrity-bounds-exceeded',
  'audit-integrity-cross-store-io-error',
  'audit-integrity-cross-store-bounds-exceeded',
  'audit-integrity-cross-store-event-invalid',
];
const values = new Set(Object.values(ERROR_CODES));
for (const code of required) {
  if (!values.has(code)) throw new Error('missing code: ' + code);
  assertRegisteredErrorCode(code);
}
if (Object.keys(ERROR_CODES).length !== 60) throw new Error('count');
console.log('preflight-ok', required.length, Object.keys(ERROR_CODES).length);
"
```

Expected:

```text
- exit 0；打印 preflight-ok <n> 60
- 至少下列码存在且 assertRegisteredErrorCode 通过：
  audit-integrity-not-initialized
  audit-integrity-cross-store-broken
  audit-integrity-dual-write-state-invalid
  audit-integrity-dual-write-io-error
  audit-integrity-dual-write-cursor-mismatch
- 以及 plan/design 实际引用的其它 journal/event/cross-store IO/invalid 码
- 总数仍 60；使用实际 ERROR_CODES / assertRegisteredErrorCode，不硬猜字面量集合
- C1 membership tests 保留并对齐同一实际 registry
```

- [ ] **Step 0.2:** 钉扎事实

```text
- inspect/recover/bootstrap exist on dual-write; no read-only monitor surface yet
- agent has no audit-integrity-monitor command
- server/agent audit catch best-effort unchanged
- Gold 4/4/1/9; production-hardening partial
- loadDualWriteStateUnlocked: ENOENT→null; invalid JSON/schema→state-invalid;
  symlink/dir/oversize/permission/other safe-read fail→dual-write-io-error
  → obs #7 Sio: statePresence=io-error; stateStatus=null; storesEmpty=false;
    cursor/journal/crossStore=skipped; errorLayer=state; NO dualWriteState on obs
- assertSafeDataRoot / RootFail → path-free #7b IO observation:
  statePresence=io-error; errorLayer=root; probes skipped; enqueue 0;
  no root create (before enqueue); report dualWriteState=unknown is C2-only
- valid resolvedRoot only → enqueueAuditIntegrityWriteTask exactly once + fresh lease
- V1.37 verifyAuditIntegrityAgainstEventStore: J empty + E nonempty →
    {state:'partial', relationship:'uncovered-events'} (no concurrent cross-store-broken throw)
- V1.37 ALLOWED_SUPPLEMENTAL_RELATIONSHIPS =
    {equal, events-suffix-of-journal, journal-suffix-of-events}  (empty rejected)
- V1.37 validateIdleCursorAgainstStoresUnlocked remaps
    verifyCrossStoreBaseline throw + UTF-8 baseline fail → cursor-mismatch
  （inspector 不得 wholesale 依赖该 remapping 出口）
```

- [ ] **Step 0.3:** 本 Task 不 commit。

**禁止：** 改任何文件。
**回滚：** n/a。
---

## Task 1（C1）: Read-only dual-write inspector — RED → GREEN

**Files:**

- Modify: `src/audit-integrity-dual-write.js`
- Create: `test/audit-integrity-dual-write-readonly-inspect.test.js`
  （若项目惯例并入 `test/audit-integrity-dual-write.test.js` 亦可，但必须可独立 RED/GREEN 指向）
- **禁止：** monitor 模块；agent CLI；version bump；bootstrap/recover 行为变更；ERROR_CODES 变更

### 导出合同（名称锁死）

```js
/**
 * Public read-only consistent observation.
 * assertSafeDataRoot first; RootFail → frozen path-free IO observation
 * (enqueue 0). Valid resolvedRoot only → enqueue exactly once + fresh lease.
 * Must NOT bootstrap/recover/publish/write.
 */
export async function inspectAuditIntegrityDualWriteReadOnly(dataDir, options = {}) {
  // options fully reserved: void options;
  // NO property/reflection/enumeration → hostile Proxy traps never run
  // assertSafeDataRoot first;
  //   RootFail → frozen path-free IO observation; enqueue 0; no root create
  //   valid resolvedRoot → enqueueAuditIntegrityWriteTask exactly once → observe
  // return deep-frozen observation (internal fields per design §3.2)
}
```

实现要点（无“实现选一”；C1 冻结）：

```text
1. options: fully reserved; void options;
   FORBIDDEN: Object.keys / for…in / getOwnProperty* / Reflect.* /
              JSON.stringify(options) / options[any] reads
   → hostile Proxy traps do not run (inspector tests may assert zero trap calls)
2. resolve root via assertSafeDataRoot **before** any enqueue;
   RootFail（path unsafe/nonexistent/non-directory/invalid dataDir）→
     frozen path-free #7b observation（design §3.2 全字段）：
       statePresence=io-error；stateStatus=null；storesEmpty=false；
       cursorMatch=skipped；journalOutcome=skipped；crossStoreOutcome=skipped；
       relationship=null；reasonCode=audit-integrity-dual-write-io-error；
       errorLayer=root；
     enqueue count **0**；NEVER create root
     FORBIDDEN: observation.dualWriteState；statePresence=unsafe；
                journalOutcome=typed-error（未执行 probe）
3. **same-module cursor SoT extraction（冻结；禁止任选）：**
   在 src/audit-integrity-dual-write.js 外科抽取/重构 private read-only
   granular helper，复用现有 journal/events fingerprint 与 cross-store SoT
   （禁止复制 cursor/digest/cross-store formula）：
     1) journal typed error → 原样保留
     2) journal/events raw fingerprint field mismatch → cursor-mismatch
     3) cross-store event invalid/broken/io/bounds（含 UTF-8 baseline）
        → 原 typed error 保留
     4) receipt 成功后 strictRecordCount ≠ idle state → cursor-mismatch
     5) 成功 → 返回 receipt/relationship
   production validateIdleCursorAgainstStoresUnlocked 必须委托/refactor 到
   同一 helper，并保持 V1.37 外部 remapping（cross-store/UTF-8 → cursor-mismatch）；
   既有 dual-write tests 证明无回归。
   inspector **只**调 granular precise helper；
   FORBIDDEN：wholesale 调用会吞分类的 remapping wrapper；
   FORBIDDEN：文档/注释写“可调 wrapper 或自写比较”等模糊句。
4. **only** after successful resolvedRoot:
   enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => {
     assertAuditIntegrityWriteLease(resolvedRoot, lease)
     // state: loadDualWriteStateUnlocked OR occupancy+load（V1.37 事实）
     //   ENOENT → statePresence=absent；stateStatus=null
     //   invalid JSON/schema → statePresence=invalid；stateStatus=null；
     //     reason=state-invalid；relationship=null
     //   symlink/dir/oversize/permission/其它 safe-read failure → #7 Sio:
     //     statePresence=io-error；stateStatus=null；storesEmpty=false；
     //     cursorMatch=skipped；journalOutcome=skipped；
     //     crossStoreOutcome=skipped；relationship=null；
     //     reasonCode=dual-write-io-error；errorLayer=state
     //     FORBIDDEN: dualWriteState on obs；statePresence=unsafe
     // prepared valid → statePresence=prepared；recovery 短路；
     //   relationship=null 固定；不为填充 relationship 继续探测；
     //   NEVER recoverPreparedUnlocked
     // state absent + stores empty → relationship=null
     // state absent + stores nonempty:
     //   receipt 成功 → relationship=精确 receipt enum；reasonCode=null
     //   journal/events/cross-store typed → relationship=null；typed priority
     // idle: 只调 granular precise helper（见上）；NEVER publish
     //   raw fp mismatch / strictCount≠idle → cursor-mismatch + relationship=null
     //   cross-store typed → #8/#9/#10 precise code + relationship=null
     //   relationship=empty → fail-closed #12（非 healthy）
     //   relationship=uncovered-events → fail-closed #13；reasonCode=null 固定
     //   allowed enum → healthy 前驱 #4
     // reasonCode: first registered ERROR_CODES or null; reuse module existing
     //   ERROR_CODES import/typed errors; NO new codes; closed-set 60
     // FORBIDDEN function calls on this path:
     //   bootstrap*, recover*, publishDualWriteState*, plan*, publishPlanned*,
     //   append*, safeAtomic*, safeAppend*, safeCreateExclusive*,
     //   validateIdleCursorAgainstStoresUnlocked（remapping wrapper）as inspect SoT
   })  // valid resolved root: enqueue **exactly once**
5. return frozen observation; path-free；**无** dualWriteState 字段
6. reasonCode membership SoT: any non-null observation.reasonCode must be
   assertRegisteredErrorCode / ∈ actual ERROR_CODES (C1 tests lock this)
7. enqueue contract（禁止绝对句 “must enqueue once on all paths”）:
   valid resolved root → enqueue exactly once + fresh lease
   RootFail → zero enqueue
```

### RED（≥ 38 it）

1. export 存在且为 async function
2. cold empty root → observation: statePresence=`absent` + storesEmpty true；**relationship=null**（不创建任何文件）
3. cold empty：**zero writes**（readdir 仍空或 state/journal/events 不存在）
4. **#2a** state missing + stores nonempty + 只读 cross-store receipt 成功 → statePresence=`absent`；storesEmpty false；**relationship=精确 receipt enum**；**reasonCode=null**
5. 合法 idle（经 production append 或 test helper）→ statePresence=`idle`；stateStatus=`idle`；cursorMatch match + journalOutcome=`verified` + relationship ∈ allowed set（exact receipt enum）
6. idle 后篡改 events 致 **raw fingerprint mismatch** → cursorMatch mismatch；reasonCode=`audit-integrity-dual-write-cursor-mismatch`；**relationship=null**；**不**改写 stores
7. 合法 prepared fixture → statePresence=`prepared`；stateStatus=`prepared`；**relationship=null 固定**；**不**变 idle；bytes 不变；不为 relationship 继续探测
8. prepared 保持 prepared 二次 inspect 稳定（relationship 仍 null）
9. invalid state JSON → statePresence=`invalid`；stateStatus=`null`；reasonCode=`audit-integrity-dual-write-state-invalid`；**relationship=null**；bytes 不变
10. **#7 Sio 全字段冻结 — state symlink：** 逐字段 assert design §3.2 表：
    statePresence=`io-error`；stateStatus=`null`；storesEmpty=`false`；
    cursorMatch=`skipped`；journalOutcome=`skipped`；crossStoreOutcome=`skipped`；
    relationship=`null`；reasonCode=`audit-integrity-dual-write-io-error`；
    errorLayer=`state`；**禁止** observation 含 dualWriteState；**禁止** statePresence=`unsafe`
11. state directory → **同 #10 全字段**（Sio 映射；errorLayer=`state`）
12. state oversize → **同 #10 全字段**（Sio 映射）
13. journal chain-broken fixture → journalOutcome=`typed-error` 分类；**relationship=null**；reason **非** cursor-mismatch
14. cross-store broken fixture → crossStoreOutcome=`typed-error`（reason=`audit-integrity-cross-store-broken`；**#9**；≠ #13）；**relationship=null**；**非** cursor-mismatch
15. 观察路径 source：**无** recover/bootstrap/publish 调用（hasCallSite 或 dependency canary）
16. 同 root：active writer（延迟 hook 或长 task）时 inspect **等待**且最终一致
17. inspect **不** nested-enqueue（queue 内再 enqueue 拒绝的负向若误写）
18. hostile options Proxy：get/getOwnPropertyDescriptor/ownKeys 等 trap **零次**运行（inspector void options 合同）
19. observation deep frozen
20. reasonCode membership SoT：任何非 null `observation.reasonCode` 必须 `assertRegisteredErrorCode` / 属于实际 ERROR_CODES（closed-set 60；不新增码）
21. 不同 root 并行 inspect 无串话
22. path-free：thrown errors message === code 或 SafeDataFile path-free；observation 无绝对 path 字段
23. **#11** idle + journal missing/NOT_INITIALIZED → statePresence=`idle`；reasonCode=`audit-integrity-not-initialized`；relationship=null；**不**当 cold uninitialized
24. **#12** idle + cursor exact match + journal verified + relationship=`empty` → fail-closed；relationship 保留 `empty`；reasonCode=null；**不**标 healthy 前驱
25. **#13** idle + relationship=`uncovered-events` → fail-closed；relationship 保留 `uncovered-events`；**reasonCode=null 固定**（V1.37 partial receipt；**不**抛 cross-store-broken；≠ #9）
26. **#7b RootFail 全字段冻结**（path unsafe/nonexistent/non-directory/invalid dataDir）→ 逐字段 assert design §3.2 表：
    statePresence=`io-error`；stateStatus=`null`；storesEmpty=`false`；
    cursorMatch=`skipped`；journalOutcome=`skipped`；crossStoreOutcome=`skipped`；
    relationship=`null`；reasonCode=`audit-integrity-dual-write-io-error`；
    errorLayer=`root`；**不**创建 root；zero writes；path-free；
    **禁止** observation.dualWriteState；**禁止** statePresence=`unsafe`
27. events/journal/cross-store 自身 typed IO → 对应已注册 `*-io-error`；journalOutcome 或 crossStoreOutcome=`typed-error`（真实 probe）；已知 statePresence 保留；**relationship=null**；**非** cursor-mismatch
28. state permission/其它 safe-read failure → **同 #10 全字段**（Sio；与 symlink/oversize 一致）
29. **enqueue spy/canary — valid resolved root：** `enqueueAuditIntegrityWriteTask` **exactly once** + fresh lease；inspect 路径 **zero writes**
30. **enqueue spy/canary — RootFail：** `enqueueAuditIntegrityWriteTask` 调用次数 **0**；observation 满足 #26 全字段（errorLayer=`root`）；**zero writes**；**不**创建 root
31. **canary（P2-1）：** 构造 state **raw fingerprints 仍匹配** 但 cross-store semantic **broken** 或 **event-invalid** → inspector reasonCode=对应 **cross-store typed** 码；**绝非** `audit-integrity-dual-write-cursor-mismatch`；relationship=null
32. **canary（P2-1）：** 真正 **raw fingerprint field mismatch**（present/byteLength/sha256/journal fields 等）→ reasonCode=`audit-integrity-dual-write-cursor-mismatch`；relationship=null
33. **#2b state-missing + typed error：** statePresence=`absent` + stores nonempty + journal/events/cross-store typed integrity 或 IO → relationship=null；typed priority 前驱（**优先于** state-missing）
34. **production remapping 无回归：** 既有 dual-write suite（含 validateIdleCursor 路径）仍绿；cross-store/UTF-8 在 production wrapper 出口仍 remap 为 cursor-mismatch（与 V1.37 一致）
35. **prepared 零探测：** prepared 路径 **不**为 relationship 调用 cross-store 成功路径（spy/canary 或 source 合同）；relationship 恒 null
36. **cursor-mismatch relationship 锁：** 任一 #5 路径（raw fp mismatch 或 receipt 后 strictCount 不符）→ relationship=null 固定（即便 internal 曾取得 receipt）
37. **observation shape 锁：** observation **不得**拥有 `dualWriteState` 键；statePresence 仅允许 `absent|idle|prepared|invalid|io-error`（**无** `unsafe`）；journalOutcome 仅允许 `missing|verified|typed-error|skipped`
38. **Sio vs RootFail errorLayer 分流：** #10 Sio errorLayer 严格 `state`；#26 RootFail errorLayer 严格 `root`；二者其余 observation 字段同构（design §3.2 表）
```bash
node --test test/audit-integrity-dual-write-readonly-inspect.test.js
```

Expected: **FAIL** until GREEN。

### GREEN

- [ ] **Step 1.1:** 实现 granular helper + production wrapper 委托 + inspector（无 wholesale remapping）。
- [ ] **Step 1.2:** GREEN 上述 + 回归 dual-write 核心（**必须**含既有 dual-write tests，证明 remapping 无回归）

```bash
node --test test/audit-integrity-dual-write-readonly-inspect.test.js \
  test/audit-integrity-dual-write.test.js \
  test/audit-integrity-dual-write-state.test.js \
  test/error-codes.test.js
```

Expected: exit 0；ERROR_CODES 仍 60；既有 dual-write 无回归。

- [ ] **Step 1.3:** **C1 commit + push**

```text
feat: add read-only audit integrity dual-write inspector
```

**禁止：** monitor CLI；version；调用 recover 于 inspect 路径；新增 error code；stage package-lock；inspector wholesale 调 remapping wrapper；复制 cursor/digest/cross-store formula。
**回滚：** 还原本 boundary 文件。

---

## Task 2（C2）: Monitor report/alert core — RED → GREEN

**Files:**

- Create: `src/audit-integrity-monitor.js`
- Create: `test/audit-integrity-monitor.test.js`
- **禁止：** agent CLI wiring（C3）；version；import unlocked/audit-log/server

### 导出合同

```js
export const AUDIT_INTEGRITY_MONITOR_TEST_CHECKED_AT = Symbol(
  'linke.audit-integrity-monitor.test-checkedAt',
);

export const AUDIT_INTEGRITY_MONITOR_CONDITION_CODES = Object.freeze([
  'healthy',
  'uninitialized',
  'state-missing',
  'recovery-required',
  'integrity-alert',
  'io-alert',
]);

export async function runAuditIntegrityMonitor(dataDir, options = {}) { /* ... */ }
export function auditIntegrityMonitorExitCode(report) { /* 0 or 2 only */ }
export function formatAuditIntegrityMonitorReportJson(report) { /* compact + \n */ }
```

映射：design §3.4–§3.7 真值表 **逐行实现**；`alertRequired === (status === 'alert')`。

实现要点（options / checkedAt / 依赖；无“实现选一”）：

```text
1. ONLY import public inspector from audit-integrity-dual-write.js
   FORBIDDEN: import error-codes / unlocked / dual-write-state / journal /
              cross-store / write-queue / audit-log / server / agent / writers
2. reasonCode: treat inspector observation as trusted internal contract;
   map reasonCode DIRECTLY to report. NO ERROR_CODES membership whitelist;
   NO code-list copy; NO error-codes import; NO new ERROR_CODES; NO new
   internal exception codes. Defensive structure only: if observation itself
   fails frozen shape → fail-closed integrity-alert + reasonCode null.
   FORBIDDEN claim: monitor can confirm arbitrary strings are registered
   without depending on registry.
3. checkedAt resolution (design §3.3 / §4):
   a. never enumerate string keys on options
   b. try {
        desc = Object.getOwnPropertyDescriptor(options, AUDIT_INTEGRITY_MONITOR_TEST_CHECKED_AT)
      } catch → real clock
   c. accept only plain own data property:
        desc && hasOwn(desc,'value') && desc.get===undefined && desc.set===undefined
        && typeof desc.value==='string'
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(desc.value)
      else → real clock
   d. FORBIDDEN: options[SYMBOL] / Reflect.get ordinary read (would run getters)
   e. hostile Proxy: getOwnPropertyDescriptor trap MAY run (language fact);
      trap throw / illegal desc → catch → real clock; NEVER leak raw error/path/body/digest/token
   f. do NOT claim "Proxy traps never run" on monitor path
4. map observation → frozen report per truth table; path-free
```

### RED（≥ 40 it）

1. cold empty → code `uninitialized`；nextAction `initialize-via-production-write`；**relationship=null**；exit helper 2
2. cold empty **zero writes**
3. **#2a** state missing + non-empty stores + receipt 成功 → `state-missing`；**relationship=精确 receipt enum**；**reasonCode=null**；exit 2
4. healthy idle equal（或允许的 suffix：`events-suffix-of-journal` / `journal-suffix-of-events`）→ status healthy；code healthy；**relationship=exact allowed enum**；nextAction none；exit 0
5. prepared → `recovery-required`；recoveryRequired true；nextAction `run-explicit-recovery`；**relationship=null 固定**；prepared bytes 不变
6. cursor mismatch → integrity-alert；reasonCode=`audit-integrity-dual-write-cursor-mismatch`；**relationship=null 固定**
7. invalid state JSON/schema → integrity-alert；**report** dualWriteState=`invalid`；reasonCode=`audit-integrity-dual-write-state-invalid`；**relationship=null**
8. **#7 Sio report — state symlink：** `code=io-alert`；**report** `dualWriteState=unknown`（C2 才断言 dualWriteState；由 C1 obs.statePresence=io-error 映射）；`relationship=null`；`reasonCode=audit-integrity-dual-write-io-error`；recoveryRequired=false；nextAction=`investigate-integrity`
9. state oversize / directory / permission → 同 #8（report: io-alert + dualWriteState=unknown + dual-write-io-error；relationship=null）
10. journal broken → integrity-alert + journal reason；**relationship=null**；reason **非** cursor-mismatch
11. event invalid / cross-store broken → integrity-alert（broken 典型 reason=`audit-integrity-cross-store-broken`）；**relationship=null**；**非** cursor-mismatch
12. cross-store / journal / events typed IO → io-alert + 对应已注册 `*-io-error`；dualWriteState 保留已知值；**relationship=null**；**非** cursor-mismatch
13. report **exact key order**（Object.keys 逐位）
14. report `Object.isFrozen` + nested freeze
15. `schemaVersion === 1`
16. format JSON parse roundtrip 字段相等；trailing newline
17. format **无** path/body/digest/token 子串 canary
18. test Symbol 以 **plain own data property** 固定 checkedAt；两次 run 其余 deep equal
19. 无 Symbol / 缺 descriptor 时 checkedAt 匹配严格 ISO 正则（真实时钟）
20. CLI 不可达：模块不读 `process.argv` 时间 flag；永不要求 CLI 传 Symbol
21. hostile options 分流：
    - accessor getter on SYMBOL：**不执行**；checkedAt 退回真实时钟；无泄漏
    - Proxy getOwnPropertyDescriptor trap 抛错：捕获 → 真实时钟；report/CLI 无 raw error/path/body/digest/token
    - Proxy trap 返回非法 descriptor：同上 fail-closed
    - **禁止**断言 monitor “完全不触发 Proxy trap”；可断言 trap 不逃逸/不泄漏
22. exit helper：healthy→0；任一 alert code→2；**从不**返回 1
23. reasonCode：**直接映射** observation.reasonCode（受信合同）；**不**做 ERROR_CODES membership whitelist；结构不满足冻结 shape → fail-closed `integrity-alert` + `reasonCode: null`；**无** error-codes import；**不**复制 registry（membership 归属 C1）
24. relationship 仅允许枚举或 null（且符合 design 确定映射；禁止“null 或可读”漂移）
25. dualWriteState 仅允许五值（`idle|prepared|missing|invalid|unknown`）；report **无** statePresence/stateStatus/storesEmpty/cursorMatch/journalOutcome/crossStoreOutcome/errorLayer
26. source：monitor **只** import dual-write public inspector；**无** error-codes import；**无** membership whitelist / registry 字面量副本
27. source：**无** setInterval/setTimeout/setImmediate 调度器
28. ERROR_CODES length 仍 60（本 boundary 不改 registry）
29. **#11** idle + journal missing/NOT_INITIALIZED → `status=alert`；`code=integrity-alert`；`dualWriteState=idle`；`relationship=null`；`recoveryRequired=false`；`nextAction=investigate-integrity`；`reasonCode=audit-integrity-not-initialized`；exit 2
30. **#12** idle + cursor exact match + journal verified + relationship=`empty` → 同上 integrity-alert 形态但 `relationship=empty`；`reasonCode=null`；**绝不** healthy；不新增 code；exit 2
31. **#13** uncovered-events → integrity-alert；`relationship=uncovered-events`；**`reasonCode=null` 固定**（≠ #9 typed broken）；exit 2
32. **#7b RootFail report**（path unsafe/nonexistent/non-directory/invalid dataDir）→ `code=io-alert`；**report** `dualWriteState=unknown`；relationship=null；reasonCode=`audit-integrity-dual-write-io-error`；**不**创建 root；exit 2（库层 enqueue 0 + obs 全字段由 C1 #26/#30 锁）
33. empty **不得**被断言为损坏证据句；仅 run-once attention/fail-closed（honesty canary 可锁注释/测试名）
34. healthy 仅允许 relationship ∈ {equal, events-suffix-of-journal, journal-suffix-of-events}
35. **#2b state-missing + typed error：** relationship=null；code/reason 按 typed priority（integrity-alert 或 io-alert；优先于 state-missing）；exit 2
36. **prepared relationship 锁：** valid prepared → relationship=null（与 recovery-required 同测可拆可合，但必须显式 assert null）
37. **cursor-mismatch relationship 锁：** #5 → relationship=null 显式 assert
38. **canary（映射）：** raw fingerprints 仍 match 但 cross-store semantic broken/event-invalid → report reasonCode=cross-store typed；**非** cursor-mismatch；relationship=null；exit 2
39. **canary（映射）：** 真正 raw fingerprint mismatch → reasonCode=cursor-mismatch；relationship=null；exit 2
40. **obs→report dualWriteState 映射锁：** statePresence=`io-error`（Sio 或 RootFail fixture）→ report.dualWriteState 严格 `unknown`；**不得**映射为 invalid/missing/idle
```bash
node --test test/audit-integrity-monitor.test.js
```

### GREEN

- [ ] **Step 2.1:** 实现 monitor 模块 + 映射表（含 design §3.3 options 分流合同）。
- [ ] **Step 2.2:** GREEN

```bash
node --test test/audit-integrity-monitor.test.js \
  test/audit-integrity-dual-write-readonly-inspect.test.js \
  test/error-codes.test.js
```

- [ ] **Step 2.3:** **C2 commit + push**

```text
feat: add audit integrity run-once monitor report contract
```

**禁止：** agent case；HTTP；spool 文件；新增 error codes；recover 调用；import error-codes；宣称 monitor 完全不触发 Proxy trap。
**回滚：** 还原本 boundary 文件。

---

## Task 3（C3）: Agent CLI + spawn tests — RED → GREEN

**Files:**

- Modify: `src/agent.js`（help 文本 + exact-one `case 'audit-integrity-monitor'`）
- Create: `test/agent-audit-integrity-monitor.test.js`
- **禁止：** version/Gold/README（C5）；server wiring；改 parseArgs 全局语义（除非为严格校验本命令局部）

### CLI 行为（锁死）

```text
args: parseArgs(argv)
command === 'audit-integrity-monitor'
require:
  - args._ length === 1 (only command)
  - args['data-dir'] is non-empty string
  - args['data-dir'] !== true
  - no duplicate data-dir array
  - no other keys except possibly nothing else
reject with exit 1 + stderr fixed short error:
  - missing --data-dir
  - --data-dir without value / boolean
  - duplicate --data-dir
  - extra positional
  - any of: token, server, recover, output, fail-on-blocked, help-as-flag-mix misuse
  - unknown flags
success path (合法 argv；non-empty string path):
  report = await runAuditIntegrityMonitor(dataDir)
  stdout.write(formatAuditIntegrityMonitorReportJson(report))
  process.exitCode = auditIntegrityMonitorExitCode(report)  // 0 or 2
  含：合法 argv + nonexistent/unsafe path → #7b io-alert → exit **2**
     （**不是** argv 合同错误；**不要** exit 1）
no network APIs; no fs write APIs in case body beyond what monitor forbids
```

**CLI exit 分流（锁死；禁止混淆）：**

```text
exit 1 = 仅 argv/parseArgs 合同错误
         （缺 --data-dir / 无值 / boolean / 重复 / 未知 flag / 额外 positional 等）
exit 2 = 合法 argv（string path）产生 alert report
         （含 cold empty / integrity / io-alert / RootFail nonexistent path 等）
exit 0 = healthy report
禁止：把 CLI argv string 合同错误与 library invalid dataDir type 混为一谈
      （library invalid type 由 inspector #7b 映射；CLI 成功路径只传 string）
```

Help 列表增加一行命令说明；**不得**写 remote alert / scheduler delivered。

### RED（≥ 19 it，spawn `node src/agent.js`）

1. healthy fixture → exit 0；stdout JSON status healthy
2. cold empty → exit 2；code uninitialized
3. prepared fixture → exit 2；recovery-required；磁盘 prepared 不变
4. state-missing fixture → exit 2
5. integrity fixture → exit 2
6. missing `--data-dir` → exit 1；stdout 无 report 或不完整 JSON 断言 stderr
7. `--data-dir` 无值 → exit 1
8. 重复 `--data-dir a --data-dir b` → exit 1
9. 额外 positional → exit 1
10. `--recover` → exit 1
11. `--token x` → exit 1
12. `--fail-on-blocked` → exit 1
13. `--server` → exit 1
14. stdout **无**绝对 dataDir 路径（alert/healthy）
15. stderr contract 错误 **无** stack / **无** raw errno path 泄漏 canary
16. help 含 `audit-integrity-monitor` 字样；exit 0 for `--help`
17. 命令运行后 cold dir 仍无文件（zero write）
18. exact-one：source 仅一处 case 分发（C4 复锁；C3 至少 runtime 一次）
19. **合法 argv + nonexistent path** → exit **2**；code=`io-alert`；dualWriteState=`unknown`；reasonCode=`audit-integrity-dual-write-io-error`；**不**创建 root；**不** exit 1

```bash
node --test test/agent-audit-integrity-monitor.test.js
```

### GREEN

- [ ] **Step 3.1:** 接线 CLI。
- [ ] **Step 3.2:** GREEN

```bash
node --test test/agent-audit-integrity-monitor.test.js \
  test/audit-integrity-monitor.test.js
```

- [ ] **Step 3.3:** **C3 commit + push**

```text
feat: add agent audit-integrity-monitor CLI
```

**禁止：** version bump；server import monitor；`--recover` 实现。
**回滚：** 还原本 boundary 文件。

---

## Task 4（C4）: Hostile scans / honesty / concurrency / zero-write — RED → GREEN

**Files:**

- Create: `test/audit-integrity-monitor-scans.test.js`
- 可选强化：`test/audit-integrity-monitor.test.js` / dual-write inspect 并发 canary
- **禁止：** version bump（C5）

### RED（≥ 24 it）

**Static / source**

1. monitor 无 `safeAtomicWrite` / `safeAppend` / `safeCreateExclusive` / `publishDualWrite` / `bootstrap` / `recoverAudit` call-sites
2. monitor 无 import audit-log / server / agent / write-queue / dual-write-state / journal / cross-store / error-codes
3. monitor 仅 import dual-write **public** inspector 符号；**无** error-codes；**无** reasonCode membership whitelist / **无** registry 复制；结构 fail-closed 仅 `integrity-alert` + `reasonCode: null`
4. agent 仅 import public monitor API（run/format/exit）
5. server.js / web/** 无 monitor 字符串 wiring
6. agent exact-one `case 'audit-integrity-monitor'`
7. monitor 无 `setInterval` / 常驻 timer
8. 无 alert spool path 字面量（如 `alert-spool` / `monitor-alerts`）

**Concurrency / zero-write**

9. active dual-write writer 进行中启动 monitor → 等待后 healthy 或稳定态；无中间态 prepared 假报告（除非 crash leftover fixture）
10. failed writer 留 prepared → monitor recovery-required；三文件 bytes 不变
11. 50 parallel `runAuditIntegrityMonitor` 同 root → 全完成；报告一致（checkedAt 除外）
12. cross-root 并行无死锁
13. 全矩阵 zero-write helper：existence + sha256/size 快照前后相等

**Honesty**

14. forbidden compound runtime needle 不出现在 monitor 源/测/本 design/plan
15. 无限定 `T6d.3 complete` / `M6d Exit` / `production-hardening ready` / `remote alert delivered` / `production monitoring ready` 假绿句
16. 允许 BLOCKED/Not/未 限定句
17. ERROR_CODES === 60
18. signature 字面量仅允许签字上限句（测试 canary 可持有期望字符串）

**CLI 再锁**

19. spawn 无网络：不监听端口 / 不 fetch（源码 case 无 request）
20. help 合同不宣称 scheduler/remote delivered
21. repeated CLI healthy：exit 0 稳定
22. nested enqueue 不被 monitor 引入（source + runtime）
23. multi-process limitation 有正向诚实注释或测试名（非 delivered）
24. C6/C7 honesty 预备：文件列表 allowlist 含新 docs/src/test

```bash
node --test test/audit-integrity-monitor-scans.test.js \
  test/audit-integrity-monitor.test.js \
  test/agent-audit-integrity-monitor.test.js \
  test/audit-integrity-dual-write-scans.test.js
```

### GREEN

- [ ] **Step 4.1:** 实现 scans + 补并发/zero-write。
- [ ] **Step 4.2:** GREEN。
- [ ] **Step 4.3:** **C4 commit + push**

```text
test: audit integrity monitor scans concurrency and honesty
```

**禁止：** version/README 假 complete；改 catch。
**回滚：** 还原本 boundary 文件。

---

## Task 5（C5）: Version / Gold / README honesty — RED → GREEN

**Files:**

- Modify: `src/version.js` → `V1.38`
- Modify: `src/gold-readiness.js`（evidence 可加 monitor 测试/CLI；**status 仍 partial**；计数 **4/4/1/9**）
- Modify: `README.md`（若项目惯例需要版本表/CLI 列表）
- Modify: 相关 `test/version.test.js` / `test/gold-readiness.test.js` 期望
- **禁止：** 改 `docs/superpowers/specs/2026-07-18-linke-v2-m1-exit-audit.md`
- **禁止：** production-hardening → ready；overall Gold ready

### 诚实句模板（必须）

```text
V1.38 read-only audit integrity run-once monitor/alert implementation
T6d.4 minimum viable run-once path delivered
Not T6d.3 complete; not M6d Exit; production-hardening remains partial
Not remote notification delivery; not managed scheduler; not production monitoring ready
Gold remains blocked 4/4/1/9
```

### RED → GREEN

```bash
node --test test/version.test.js test/gold-readiness.test.js \
  test/cross-lan-m1-exit-audit.test.js \
  test/audit-integrity-monitor-scans.test.js
```

- [ ] **Step 5.1:** 升级版本与诚实文档。
- [ ] **Step 5.2:** GREEN。
- [ ] **Step 5.3:** **C5 commit + push**

```text
chore: release milestone V1.38 audit integrity run-once monitor
```

**回滚：** 还原本 boundary 文件。

---

## Task 6（C6）: Full suite + GLM + fresh Grok closure

- [ ] **Step 6.1:**

```bash
npm test
```

Expected: exit 0；仅既有 keychain skip（若有）；无新增 silent skip。

- [ ] **Step 6.2:** 回归包（既有 C8 13-file 意识 + 本版新增）

```bash
node --test \
  test/audit-integrity-dual-write.test.js \
  test/audit-integrity-dual-write-state.test.js \
  test/audit-integrity-dual-write-scans.test.js \
  test/audit-integrity-dual-write-readonly-inspect.test.js \
  test/audit-integrity-monitor.test.js \
  test/audit-integrity-monitor-scans.test.js \
  test/agent-audit-integrity-monitor.test.js \
  test/audit-integrity-journal.test.js \
  test/audit-integrity-cross-store.test.js \
  test/audit-log.test.js \
  test/error-codes.test.js \
  test/version.test.js \
  test/gold-readiness.test.js
```

- [ ] **Step 6.3:** GLM 抗辩（实现）— 无 P0：zero-write、真值表、exit 表、无 recover、ERROR_CODES 60、Gold 4/4/1/9、无 remote/scheduler 假宣称。
- [ ] **Step 6.4:** fresh Grok 验收 PASS。
- [ ] **Step 6.5:** 仅当有修复时 `test:`/`fix:` commit；否则无额外 commit。

**禁止：** 把 run-once exit 2 写成 remote alert delivered；把 C0/docs 写成唯一交付物。

---

## 测试矩阵总表（跨 C1–C4 必须覆盖）

| 场景 | 期望 code | dualWriteState | relationship | reasonCode（典型） | exit(CLI) | writes |
| --- | --- | --- | --- | --- | --- | --- |
| healthy idle（equal 或允许 suffix） | healthy | idle | **exact allowed enum** | null | 0 | 0 |
| cold empty | uninitialized | missing | **null 固定** | null | 2 | 0 |
| **#2a** state missing + stores non-empty + receipt 成功 | state-missing | missing | **精确 receipt enum** | **null** | 2 | 0 |
| **#2b** state missing + stores non-empty + typed error | integrity-alert 或 io-alert | missing | **null 固定** | **typed 注册码** | 2 | 0 |
| prepared valid | recovery-required | prepared | **null 固定** | null | 2 | 0（保持 prepared；不继续探测） |
| invalid state JSON/schema | integrity-alert | **invalid** | **null 固定** | dual-write-state-invalid | 2 | 0 |
| state symlink/dir/oversize/permission（#7 Sio；obs statePresence=io-error / errorLayer=state / probes skipped） | **io-alert** | **unknown**（report only） | **null 固定** | **dual-write-io-error** | 2 | 0 |
| root path unsafe/nonexistent/non-directory/invalid dataDir（#7b RootFail；obs statePresence=io-error / errorLayer=root / probes skipped） | **io-alert** | **unknown**（report only） | **null 固定** | **dual-write-io-error** | 2（合法 argv） | 0（不创建 root；enqueue 0） |
| cursor mismatch（raw fp 或 strictCount≠idle） | integrity-alert | idle | **null 固定** | dual-write-cursor-mismatch | 2 | 0 |
| journal broken | integrity-alert | 已知 state | **null 固定** | journal 注册码（**非** cursor-mismatch） | 2 | 0 |
| event invalid | integrity-alert | 已知 state | **null 固定** | event/cross-store 注册码（**非** cursor-mismatch） | 2 | 0 |
| cross-store broken（#9 typed） | integrity-alert | 已知 state | **null 固定** | cross-store-broken（**非** cursor-mismatch） | 2 | 0 |
| events/journal/cross-store typed IO | **io-alert** | **已知 state 保留** | **null 固定** | 对应 `*-io-error`（**非** cursor-mismatch） | 2 | 0 |
| **canary：raw fp match + cross-store semantic broken/event-invalid** | integrity-alert | idle（或已知） | **null 固定** | **cross-store typed**（**非** cursor-mismatch） | 2 | 0 |
| **canary：真正 raw fingerprint mismatch** | integrity-alert | idle | **null 固定** | dual-write-cursor-mismatch | 2 | 0 |
| **#11 idle + journal NOT_INITIALIZED** | **integrity-alert** | **idle** | **null 固定** | **not-initialized** | 2 | 0 |
| **#12 idle + relationship=empty** | **integrity-alert** | **idle** | **empty 固定** | **null** | 2 | 0 |
| **#13 idle + uncovered-events** | **integrity-alert** | **idle** | **uncovered-events 固定** | **null**（固定） | 2 | 0 |
| CLI argv/parseArgs 合同错误 | n/a | n/a | n/a | n/a | 1 | 0 |

**确定映射备注（防漂移）：**

- #12 empty：本版保守 fail-closed attention；**不** healthy；**不**声称 empty 是损坏证据；V1.37 supplemental allowed set 拒 empty。
- #13 uncovered-events：V1.37 verifier 对 J empty + E nonempty 返回 partial receipt；**reasonCode=null 固定**；**同一次 receipt 不**抛 cross-store-broken；真正 typed broken 是 #9。
- #7/#7b state/root IO：**统一** report io-alert + dualWriteState=unknown + dual-write-io-error；**obs** statePresence=io-error + probes skipped + storesEmpty=false；Sio errorLayer=state / RootFail errorLayer=root；**禁止** “io 或 integrity” / “invalid/unknown 二选一” / observation.dualWriteState / statePresence=unsafe。
- #7b RootFail：enqueue **前**捕获；enqueue 0；valid resolved root 才 enqueue exactly once。
- invalid JSON/schema **单独** integrity-alert + report dualWriteState=invalid + state-invalid；obs statePresence=invalid。
- CLI：合法 argv + nonexistent path → exit **2** io-alert；argv 合同错误 → exit **1**；禁止混淆 CLI argv string 与 library invalid type。
- **P2-1 cursor SoT：** inspector 只调 same-module granular precise helper；禁止 wholesale remapping wrapper；production wrapper 委托后保持 V1.37 cross-store/UTF-8 → cursor-mismatch。
- **P2-2 relationship：** 禁止 “null 或可读枚举” / “可填或 null”；prepared/cursor-mismatch/typed-error 一律 null；state-missing 分 #2a/#2b。
- **P2-final observation vs report：** C1 只 assert obs.*；C2 才 assert report.dualWriteState；journalOutcome 含 skipped；未执行≠typed-error。
- **error priority 自洽：** idle 上 journal typed / cross-store typed / IO **先于** cursor-mismatch remapping；仅 raw fingerprint mismatch 或 receipt 后 strictCount 不符 → cursor-mismatch；cursor-mismatch **从不**输出 relationship。

**Concurrency：** active writer 前后；failed writer；50 monitors；cross-root；no deadlock/nested enqueue；valid root enqueue once / RootFail enqueue zero。
**Repeatability：** 仅 checkedAt 变。
**Scans：** design §3.10 全锁。
---

## 回滚策略（总）

| Boundary | 回滚 |
| --- | --- |
| C0 | 删除两份 docs |
| C1 | 还原 dual-write + 删除 inspect 测试 |
| C2 | 删除 monitor 模块+测试 |
| C3 | 还原 agent + 删除 CLI 测试 |
| C4 | 删除/还原 scans |
| C5 | 还原 version/gold/readme 至 V1.37 诚实态 |
| C6 | 针对修复 commit revert |

---

## 实现阶段角色

```text
Coder          = Grok（按本 plan boundary 执行 TDD）
Adversary      = GLM（每 boundary 绿后抗辩；P0 阻断）
Acceptor       = fresh Grok（只读验收）
Committer      = PM 精确 stage/commit/push（永不 package-lock）
```

---

## Plan 验收清单

- [x] 三方案比较并选定 A
- [x] inspector / monitor / CLI 合同可执行、无 stub 选一
- [x] 真值表 / 优先级 / report schema / exit table / 并发 / 安全边界
- [x] C0–C6 boundaries + RED/GREEN + 测试清单 + commit message + 禁止项 + rollback
- [x] ERROR_CODES 保持 60；condition 独立 enum
- [x] Gold 4/4/1/9；T6d.3 partial；T6d.4 minimum viable only
- [x] 签字上限冻结；无完整 forbidden compound 相邻字面量
- [x] 不改 M1 exit audit；不改 server/agent catch
- [x] C0 ≠ V1.38 实现完成

**本 plan 本身不提升任何 runtime flag。当前事实仍为 V1.37。**
