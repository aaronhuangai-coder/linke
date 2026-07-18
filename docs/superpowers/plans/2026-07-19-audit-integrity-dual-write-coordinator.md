# V1.37 Journal-First Crash-Recoverable Audit Dual-Write Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 **M6d T6d.3 still-partial** 的 **journal-first、崩溃可恢复、单进程串行** audit dual-write coordinator：共享 same-resolved-root 写队列（lease-gated）、journal event-link 原子发布、durable single-slot WAL/cursor、public journal-only state-absent gate、retention 两种互斥发布策略、经 `appendAuditEvent` 唯一生产接线。实现后仅升 **V1.37**；Gold 仍 **blocked 4/4/1/9**。

**签字上限（唯一允许的完成宣称）：**
`V1.37 journal-first crash-recoverable audit dual-write coordinator implementation`

**不是：** T6d.3 complete / M6d Exit / production-hardening ready / Gold ready / authenticity / external anchor / HMAC / signature / multi-process exclusive lock / journal rotation / monitor/alert / end-to-end production audit delivery / state continuity under adversarial state deletion / WORM / immutable / forbidden compound（`tamper-`+`evident` 两段拼接；文档不写完整相邻字面量）。

**Architecture:**
- `src/audit-integrity-write-queue.js` — 唯一 same-resolved-root 串行队列 SoT + **module-generated lease** + **AsyncLocalStorage**；**lease settle 仅 queue `finally`**
- `src/audit-integrity-dual-write-state.js` — **C2 真实完整** schema/parser/read/publish/**absent gate**（**非** skeleton/write-only；不 import journal/coordinator/audit-log；bootstrap 归 C3）
- `src/audit-integrity-dual-write.js` — coordinator、bootstrap、prepare/recover；fatal UTF-8 events decode；recovery 仅 fresh lease
- `src/audit-integrity-journal.js` — shared queue + unlocked **plan + publishPlanned** 唯一 SoT；plan raw 在 module-private WeakMap；publish 后**必须核** post；public wrappers：C1 = public journal-only (post-C1 plan/publish SoT; no dual-write coordinator) resolve→queue→plan/publish（**无 gate/state**；**不是** V1.35 safeAppend）；C2+ = queue 内真实 absent gate
- `src/audit-log.js` — `appendAuditEvent` 唯一接线 dual-write；废除生产分裂 queue 旁路与无 retention fast path
- `src/safe-data-files.js` — **`safeReadBytes`（同 fd 二次 fstat size-race）/ `safeAtomicWriteBytes`**；**禁止** truncate/ftruncate；**禁止**用 `safeReadText` UTF-8 replacement 做 partial 分类
- `src/audit-integrity-cross-store.js` — 保持只读；可作 supplemental post-check
- server/agent — **不**直接 import coordinator/journal；**不改** best-effort catch

**Tech Stack:** Node.js ESM、`node:test` / `node:assert/strict`、`node:crypto` SHA-256、`node:async_hooks` AsyncLocalStorage、现有 safe-data-files / error-codes。无新 npm 依赖。

**Design SoT:** `docs/superpowers/specs/2026-07-19-audit-integrity-dual-write-coordinator-design.md`

---

## C0 review gate（implementation PROCEED 前强制）

```text
C0 审查史（强制记录）：
  第一次 GLM verdict = FAIL
    （retention 两阶段发布 / journal-only 旁路 recover / lease 缺失 /
     bounds 层混用 / 错误码计数旧合同 / C3 stub 假绿 / 授权冲突句 等）
  第二次 GLM verdict = FAIL
    （journal exact post 必须 prepared 前由 journal module 只读 plan 签发；
     禁止复制 digest/link 公式 / 禁止先写 journal；
     删除 publish(rawPre,recordLine)；
     lease settle 仅 queue finally；task 无 settle API；
     partial recovery 删除 truncate/ftruncate/reappend → atomic byte image；
     C1 无 state gate stub；C2 才真实 gate；
     prepared+Jpre/Epost 显式 conflict；null partial 六态；
     last* 赋值与 lastSequence 关系；journal-suffix-of-events 可达 canary；
     nested enqueue 不得建议换 root 绕过 等门槛）
  第三次 GLM verdict = PASS（无 P0）
    第四轮窄修并入其 P1/P2 细化并全文一致：
      safeReadBytes 同 fd 二次 fstat size-race；
      recovery 仅靠 next call / explicit recover 的 fresh lease（禁 catch re-grant）；
      journal plan raw 私有化（WeakMap）+ publish 后必须核 post；
      created-empty-partial 为 events 分类、无需 extra flag；
      C2 state 真实完整 schema/parser/publisher/gate（非 skeleton/write-only）；
      nested meta-audit 同/跨 root 均 defer 至 outer settle；
      lastSequence 关系 C2 tests 明确；publish post-write 合同「必须核」
  **fresh Grok** 只读闭环 = PASS / PROCEED YES（无 P0）
    最终措辞修订关闭三条非阻断 finding（本轮；仅 docs）：
      1. C2 concurrent canary 不写「首次 coordinator bootstrap」
         （C2 = 真实 state module + 测试 helper 手工 publish idle|prepared 占位
          ∥ public journal-only init/append；bootstrap 并发迁 C3 行为测 + C6 hostile 复锁）
      2. design §3.2 public init/append gate 明确标 C2+；C1 仅 resolve→queue→plan/publish，
         无 state module/gate；删除无条件 gate 冲突
      3. 「V1.35 direct / production append still V1.35 direct」→
         public journal-only (post-C1 plan/publish SoT; no dual-write coordinator)
         （明确不是保留 V1.35 safeAppend 半写模型；
          历史 baseline 描述 V1.36 现状仍可保留 safeAppend 事实）

实现 PROCEED 门（docs 审查；≠ 实现完成）：
  1. design + 本 plan 完成本最终措辞修订（关闭非阻断 finding）
  2. 第三次 GLM PASS 已记录（无 P0）
  3. **fresh Grok** 只读闭环 = PASS / PROCEED YES 已记录
  4. PM 验收通过后：**C0 可 commit** 并 **开始 C1**

任一 FAIL → 禁止 implementation PROCEED；改 docs，不写代码。
第三次 GLM PASS + fresh Grok PASS/PROCEED YES 已记录；待 PM 验收后 C0 commit → 开始 C1。
**禁止**把本 C0 文档阶段写成 V1.37 实现完成。
```

---

## PM 冻结摘要（实现不得偏离）

```text
MILESTONE     = V1.37 = M6d T6d.3 still partial (dual-write coordinator only)
SIGNATURE     = V1.37 journal-first crash-recoverable audit dual-write coordinator implementation
NOT           = T6d.3 complete | M6d Exit | production-hardening ready | Gold ready
                | authenticity | multi-process lock | rotation | e2e caller delivery
                | state continuity under adversarial state deletion
GOLD          = blocked 4 ready / 4 partial / 1 blocked / total 9
PATHS         = audit/events.jsonl
                audit/integrity-journal.jsonl
                audit/integrity-dual-write-state.json
QUEUE         = src/audit-integrity-write-queue.js
                key = assertSafeDataRoot(resolvedRoot)
                enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => ...)
                assertAuditIntegrityWriteLease(resolvedRoot, lease)
                single Map; failure must not poison next task
                Node 内置 AsyncLocalStorage（无新依赖）
                callback 由 ALS.run(activeLease, ...) 执行
                module-private WeakSet/WeakMap 绑定 root + 有效期
                lease bound to (root, task)
                LEASE SETTLE (P0):
                  ONLY queue infrastructure expires/deletes lease
                  in `finally` of `await task(lease)`
                  task has NO settle API; cannot expire early
                  task Promise settle DEFINES lease lifecycle end
                  detached continuation after settle → expired reject
                RECOVERY LEASE (P1; no catch re-grant / no expired reuse):
                  current task fails → prepared kept → settle → old lease expire
                    → error returned to caller
                  NEXT appendAuditEvent gets brand-new queue task / fresh lease;
                    S3b discovers prepared and recovers under that fresh lease
                  OR explicit internal recoverAuditIntegrityDualWrite(root)
                    itself resolve+enqueue obtains fresh lease
                  process restart same: new call / new lease
                  if current task actively reconciles BEFORE throw:
                    may use current active lease; once settled NEVER reuse
                  FORBIDDEN: queue .catch re-grant; reuse expired lease
                nested enqueue FORBIDDEN for ANY active lease
                  (same-root AND cross-root — self-deadlock + AB/BA)
                  nested meta-audit: same/cross root BOTH reject while lease active
                  meta-audit MUST defer until outer settle
                  FORBIDDEN advice: "switch root" workaround
                  outer task reject/fulfill MUST NOT poison next task
                assert: object identity active ∧ root match ∧ ALS.current === lease
                wrong/missing/expired/cross-root/outside-context → reject
                C1 error = existing path-free SafeDataFileError
                  (internal programmer/bypass; NO new C2 codes in C1)
                journal public wrapper may map to existing journal IO
                NOT a malicious same-process import sandbox
STATE_MOD     = src/audit-integrity-dual-write-state.js  // C2 creates REAL full module
                schema/parser/read/publish/absent gate
                NOT skeleton / NOT write-only
                gate checks state PATH occupancy:
                  exact ENOENT = absent allow;
                  exists/unsafe = occupied block
                gate does NOT use queue lease to judge occupancy;
                  lease only proves critical section
                C2 production still public journal-only
                  (post-C1 plan/publish SoT; no dual-write coordinator);
                  does NOT create state; NOT V1.35 safeAppend half-write
                  cold state absent → public journal-only allowed
                C2 tests hand-publish valid idle|prepared/invalid/unsafe
                  placeholders to verify block (NO bootstrap in C2)
                C3 introduces bootstrap create idle
                parser: shape + relationship invariants (design §4.3.3)
                does NOT recompute full raw post hash from pre hash
                does NOT import journal/coordinator/audit-log
                success idle last*:
                  lastTransactionId = prepared.transactionId
                  lastPayloadDigest = prepared.payloadDigest
                  lastSequence      = prepared.journal.post.sequence
                all-non-null last* ⇒ lastSequence === journal.recordCount-1
                  (C2 state parser tests MUST lock this explicitly)
COORDINATOR   = src/audit-integrity-dual-write.js
                bootstrap/prepare/recover/coordinator only
                events raw → fatal UTF-8 decode (TextDecoder fatal:true)
                partial classify ALWAYS by bytes BEFORE decode
                recovery only under fresh lease (next call / explicit recover)
JOURNAL_PLAN  = planAuditIntegrityEventLinkUnlocked(root, lease, {generationId, event})
                  assert lease; bounded read raw; full verify + append bounds
                  journal module ONLY SoT for payloadDigest/sequence/previous/link
                  NO filesystem mutation / NO enqueue
                  returns module-issued frozen plan with ONLY serializable
                    pre/post metadata (byteLength/sha256/recordCount/sequence/…)
                  FORBIDDEN: rawPre/rawPost Buffer/string as caller-visible plan fields
                  journal module-private WeakMap by plan identity stores
                    {resolvedRoot, leaseIdentity, rawPreText, rawPostText}
                    (immutable JS strings; caller cannot read/write raw)
JOURNAL_PUB   = publishPlannedAuditIntegrityEventLinkAtomicUnlocked(root, lease, plan)
                  assert brand + root + current active lease
                  take exact immutable rawPostText from WeakMap; NEVER trust caller raw
                  re-read current journal fingerprint MUST exact plan.pre
                  safeAtomicWriteText(rawPostText)
                  after atomic write returns MUST verify (not "may"):
                    reopen final nofollow + full verify/hash MUST exact plan.post
                    else typed conflict/io; MUST NOT success receipt
                  expired plan lease → reject; may delete private payload
                  admit post-return multi-process race as limitation
                DELETED: publish(rawPre, recordLine) ambiguous interface
                public appendAuditIntegrityEventUnlocked MUST reuse plan+publish
                recovery (plan/WeakMap lost): if current exact pre → same plan… rebuild
                  + fieldwise assert vs prepared.journal pre/post then publish;
                  if current exact post → verify only; else conflict
                FORBIDDEN: copy journal digest/link formulas; write journal before prepared
EVENTS_PUB    = TWO MUTUALLY EXCLUSIVE strategies:
                retention === null (incl 0/disabled):
                  HOT PATH: safeAppendText(exact eventLineUtf8)
                  classifier six states (design §3.4.2):
                    1 pre-missing + current-missing = exact-pre
                    2 prepared.events.pre.present===false + byteLength===0 + emptyDigest
                      + current events present regular empty
                      = created-empty-partial
                      (EVENTS file class, NOT journal init; NO extra partial flag)
                      no prepared → bootstrap (not recovery classifier)
                      pre.present===true empty + current empty = exact-pre
                    3 pre empty + current empty = exact-pre
                    4 pre + nonempty strict line prefix = byte partial (atomic repair)
                    5 pre nonempty + current empty / flag abnormal / non-prefix = other
                    6 full line = exact-post
                  partial repair: safeReadBytes → preBytes+eventLineBytes
                    → ONE safeAtomicWriteBytes (O(n) recovery ONLY; not hot path)
                  DELETED: safe truncate / ftruncate / truncate→rehash→append
                retention.maxEvents >= 1:
                  BEFORE prepare: compute final retained suffix bytes
                    from strict-valid pre bytes + new line
                  ONE safeAtomicWriteText/Bytes(final retained image)
                  classifier: exact-pre | exact-post | other ONLY
                  NO partial class; NO append-complete/uncompacted intermediate
                prepared.events.post = ALWAYS final visible bytes
                FORBIDDEN: invent intermediate fingerprint
                FORBIDDEN: recover events pre from journal raw (prepared has no pre raw;
                  current partial file prefix after hash verify IS preBytes)
SAFE_BYTES    = safeReadBytes(root,path,{maxBytes})
                  secure parent walk; final O_RDONLY|O_NOFOLLOW;
                  FIRST fstat on same fd: record dev/ino/size/mode;
                    must regular; size ≤ maxBytes
                  offset-loop exact read of first size
                  SECOND fstat on same fd after exact read:
                    dev/ino/size MUST still equal and still regular
                    else SafeDataFileError (size-race / same-inode growth|truncate)
                  premature EOF fail; exact Buffer; NO UTF8 decode
                  atomic pathname rename: open fd old-inode snapshot OK;
                    before later publish/repair MUST re-read pathname and match
                    prepared/plan expected current fingerprint; external change → conflict
                  TEST: append/grow/truncate between the two fstats → fail
                safeAtomicWriteBytes(root,path,buffer,{mode:0o600})
                  same-dir temp O_EXCL|O_NOFOLLOW; fd regular; write all;
                  fsync; close; revalidate; rename; best-effort dir sync;
                  NEVER follow symlink
ORDER         = sanitize/strict → resolve root → shared queue(lease) →
                load/bootstrap/recover/validate idle → preflight bounds →
                journal plan (read-only exact post metadata; raw in WeakMap) +
                events post fingerprints →
                prepared WAL (no raw; write后 read/parse expected status+tx) →
                publishPlanned journal (WeakMap rawPost; write后**必须核** post) →
                events post (mutex strategy) → primary fingerprints +
                supplemental cross-store → idle cursor (last* from prepared;
                write后 read/parse expected status+cursor before success)
                failure mid-S3: keep prepared; settle; old lease expire;
                next call / explicit recover with fresh lease
CRASH_EXTRA   = prepared + Jpre + Epost → recovery-conflict;
                keep prepared; neither store mutated
                (unreachable via single-process normal crash order;
                 external mutation/rollback)
                journal-suffix-of-events success post reachable canary:
                  legacy E=[legacy,a] J=[a] → append x → E=[legacy,a,x] J=[a,x]
                  ONLY after bootstrap retains legacy uncovered baseline
CRASH         = CP0..CP5 + retention atomic rename-before/after canaries;
                recover idempotent; never clear prepared on failure
STATE_SCHEMA  = idle|prepared; exact key order; schemaVersion=1; maxBytes=65536
                publish前 UTF-8 byteLength check → state-invalid if >65536
                read oversize → dual-write-io-error
                direct gate does NOT parse schema; occupancy only
                STRICT_FIELD_ORDER: id, createdAt, type, ...
                eventLineUtf8 must match stringify (id then createdAt then type)
ERRORS        = +5 codes; closed-set 55→60
                dual-write-state-invalid | dual-write-io-error
                dual-write-recovery-conflict | dual-write-cursor-mismatch
                dual-write-direct-mutation-blocked
DIRECT_GATE   = C1: NO state module / NO gate / NO stub
                public journal-only (post-C1 plan/publish SoT; no dual-write coordinator)
                NOT V1.35 safeAppend half-write model
                C2+: public journal init/append FROZEN order (gate ONLY C2+):
                  resolve root
                  enqueue shared root queue
                  inside callback, with active lease:
                    assertDualWriteStateAbsentUnlocked(root, lease)  // REAL gate
                    journal unlocked plan/publish or init
                state EXISTS (idle|prepared|invalid|symlink|dir|any non-ENOENT)
                → path-free DIRECT_MUTATION_BLOCKED; bytes unchanged; NO auto-recover
                state missing (exact ENOENT) → keep public journal-only
                  (post-C1 plan/publish SoT; no dual-write coordinator)
                gate AFTER queue acquire; lease-verified; coordinator+direct mutex
                any state file only from C2 tests / C3+; after C2 gate is real
                FORBIDDEN residual: "先 gate 再 enqueue" / TOCTOU
                FORBIDDEN residual: "direct append first recover then allow"
                FORBIDDEN residual: "init first recover"
                FORBIDDEN residual: C1 gate stub / forward import / always-allow
                FORBIDDEN residual: unconditional public gate (conflicts with C1)
                C2 concurrent canary (NO bootstrap):
                  real state module in shared queue;
                  test helper hand-publish idle|prepared placeholder
                  ∥ public journal-only init/append
                  placeholder first → public rejected
                  public first → journal-only completes then placeholder publish
                  NEVER journal-only write after state occupied
                real `direct append ∥ first coordinator bootstrap`:
                  C3 behavior tests + C6 hostile re-lock (bootstrap is C3)
DAG           = audit-log → coordinator → journal unlocked plan/publish
                                       → dual-write-state
                                       → queue lease
                journal public C1 → shared queue → plan/publish (no gate/state)
                journal public C2+ → shared queue → real absent gate → plan/publish
                dual-write-state ↛ journal/coordinator/audit-log
                journal ↛ coordinator/audit-log
BOOTSTRAP     = only exact NOT_INITIALIZED / ENOENT as missing; else rethrow
                verified OR partial OK for first bootstrap (legacy/uncovered honesty)
                broken → fail-closed
                state missing + verified/partial = bootstrap NOT idle mismatch
                idle cursor mismatch ONLY when state already exists
                Jbad / partial exclusive-create residue → fail-closed; NO auto-repair
                invalid UTF-8 events baseline → fail-closed
                limitation: no state continuity if attacker deletes state
BOUNDS        = PRECISE SPLIT (all preflight BEFORE prepared; no store mutation):
                business event line UTF-8 >16050 → CROSS_STORE_BOUNDS_EXCEEDED
                events strict post count >8192 → CROSS_STORE_BOUNDS_EXCEEDED
                events final/recovery window >16_777_216 → cross-store IO (size≠bounds)
                journal GENERATED link record >374 → AUDIT_INTEGRITY_BOUNDS_EXCEEDED
                journal existing >4096 / post total >4097 → journal bounds
                journal current/post raw >1_572_864 → AUDIT_INTEGRITY_IO_ERROR
                FORBIDDEN: "event line > journal 374" mix
                canaries: legal 500-byte event; 16050/16051; independent journal 374
POST_CHECK    = prepared exact fingerprints PRIMARY
                cross-store verifier SUPPLEMENTAL
                successful post ONLY:
                  equal | events-suffix-of-journal | journal-suffix-of-events
                journal-suffix-of-events REACHABLE canary (legacy baseline)
                empty + uncovered-events: bootstrap receipt ONLY
                  (NOT transaction post commit)
                successful append always has ≥1 journal event-link
                  → uncovered-events impossible as success post
                empty/uncovered as post-check → unexpected → recovery-conflict
                  keep prepared; no idle
                throw/broken/unexpected → keep prepared; no idle; recovery-conflict
WIRING        = appendAuditEvent ONLY production dual-write entry (C5)
                server/agent zero direct coordinator/journal import
                journal MUST NOT import audit-log/coordinator
                dual-write-state MUST NOT import journal/coordinator/audit-log
                cross-store still read-only
                capability sink isolated
SCANS         = REPLACE zero-wiring with exactly-one controlled wiring + zero direct
                + allowlists + lease assert presence
                abolish no-retention fast path / independent auditFileQueues
                (static scan + first cold append test)
                forbid fake green by deleting old scan without replacement
CALLER_LIMIT  = server/agent best-effort catch REMAINS unchanged this version
                honest positive tests only; NO new HTTP failure channel scope
C1_BOUNDARY   = shared queue + lease settle finally + journal plan/publish
                NO state module / NO state file / NO production coordinator
                public journal-only (post-C1 plan/publish SoT; no dual-write coordinator)
                resolve→queue→plan/publish; NO gate stub; NOT V1.35 safeAppend
C2_BOUNDARY   = create real dual-write-state + 5 codes
                wire real absent gate inside public wrappers queue callback (C2+)
                hand-publish idle|prepared placeholder ∥ public journal-only canary
                tests lock: no stub / TODO / always-allow; NO bootstrap in C2
C3_BOUNDARY   = bootstrap create idle + prepared recovery NOT yet exposed
                behavior: direct append ∥ first coordinator bootstrap concurrent
                prepared fixture → fail-closed / recovery-not-yet-exposed
                NEVER no-op as idle
                production appendAuditEvent STILL unwired until C5
C4_BOUNDARY   = implement recovery; replace C3 prepared gate
                partial repair = atomic byte image (NO truncate)
TESTS_ROOT    = only mkdtemp(join(tmpdir(), ...))
VERSION_BUMP  = only after C1–C6 green + C7 temporal
GIT_AUTH      = each boundary tests+review green → PM auto precise stage/commit/push
                NO re-confirmation required; never stage untracked package-lock.json
```

```text
REJECTED = A naive double-append | C SQLite/new-dep/multi-file false atomicity
SELECTED = B single-slot WAL/cursor + journal-first
```

---

## Commit boundaries（强制）

| Boundary | Contents | Commit message（boundary 测试绿后 PM 精确 stage/commit/push） |
| --- | --- | --- |
| **C0 docs** | 仅两份 docs（design + 本 plan） | `docs: design V1.37 journal-first crash-recoverable audit dual-write coordinator` |
| **C1 queue + lease + atomic journal** | shared queue + lease settle finally；journal plan/publish 唯一 SoT；public journal-only (post-C1 plan/publish SoT; no dual-write coordinator)（**无 gate/state**；**不是** V1.35 safeAppend） | `feat: shared audit integrity write queue lease and atomic journal event-link publish` |
| **C2 state schema/errors/gate** | **真实完整** dual-write-state（schema/parser/publisher/gate；非 skeleton/write-only）+5 codes；path occupancy gate（C2+）；C2 production 仍 public journal-only 且不 create state；占位 publish ∥ public journal-only canary（**无 bootstrap**）；lastSequence C2 tests 明确；无 stub/TODO | `feat: add dual-write state schema parser gate and error codes` |
| **C3 bootstrap/idle** | bootstrap 矩阵；idle cursor validate；`direct append ∥ first coordinator bootstrap` 行为并发；prepared fixture fail-closed（recovery 未暴露）；missing vs other errors | `feat: dual-write bootstrap and idle cursor validation` |
| **C4 prepared/recovery** | prepared WAL；CP0–CP5 + Jpre/Epost conflict；atomic byte image repair（无 truncate）；retention atomic canaries | `feat: dual-write prepared WAL and crash recovery core` |
| **C5 production wiring** | `appendAuditEvent` exact-one wiring；废除 fast path/`auditFileQueues`；retention 互斥策略 | `feat: wire appendAuditEvent through dual-write coordinator` |
| **C6 hostile/scans/limits** | crash/hostile/scans/limitations；exactly-one；direct gate；lease abuse | `test: dual-write crash hostile scans and honest limitations` |
| **C7 temporal→V1.37** | version/gold/readme honesty | `chore: release milestone V1.37 dual-write coordinator` |
| **C8 full verify** | full suite + GLM adversarial + fresh Grok closure | 仅在有修复时 `test:`/`fix:` commit |

**规则：**

- Never mix C0 docs-only with code。
- **每个 boundary** 相关测试与审查绿后，**PM 自动精确 stage 该 boundary 文件 → commit → push**；**无需再次确认**（含 C0）。
- **永不** stage 未跟踪的 `package-lock.json`。
- Never bump version before C1–C6 绿。
- 每任务：精确 files、RED/GREEN 命令、期望、commit message、禁止项、回滚。
- 测试写盘 **只能** `mkdtemp(join(tmpdir(), ...))`。
- Commit message / README / Gold **禁止**无限定 T6d.3 complete、M6d Exit、production-hardening ready、完整 forbidden compound 字面量。
- 每个 boundary runtime 必须可运行：真实功能或真实 fail-closed；禁止 silent stub 假绿。

---

## Fresh review / PM gate（代码前）

- [x] **G0:** C0 最终措辞修订关闭非阻断 finding；**第三次 GLM PASS** + **fresh Grok PASS/PROCEED YES** 已记录（第一/二次 GLM FAIL 已记录；无 P0）。**≠ V1.37 实现完成**。
- [x] **G1:** Fresh Grok 对照 design + 本 plan + 源码事实（audit-log / journal / cross-store / schema / safe-data-files / error-codes / server/agent / V1.36）= PASS。
- [x] **G2:** 无 P0（含：C2 canary 不写 bootstrap；§3.2 gate 标 C2+；「V1.35 direct」→ public journal-only post-C1 plan/publish SoT）。
- [ ] **G3:** PM 验收通过后：**C0 可 commit** 并 **开始 C1**（implementation PROCEED 门打开；仍 ≠ V1.37 实现完成）。
- [ ] **G4:** 仅 PM 验收 + C0 commit 后开始 Task 0+ / C1。

若 P0：**停**；改 docs；不写代码。

---

## 全局命令约定

```bash
# queue / journal
node --test test/audit-integrity-write-queue.test.js
node --test test/audit-integrity-journal.test.js test/audit-integrity-journal-scans.test.js

# dual-write
node --test test/audit-integrity-dual-write.test.js
node --test test/audit-integrity-dual-write-state.test.js
node --test test/audit-integrity-dual-write-scans.test.js

# audit-log wiring
node --test test/audit-log.test.js

# cross-store regression
node --test test/audit-integrity-cross-store.test.js test/audit-integrity-cross-store-scans.test.js

# error codes
node --test test/error-codes.test.js

# C7 诚实
node --test test/version.test.js test/gold-readiness.test.js test/cross-lan-m1-exit-audit.test.js

# 相关回归
node --test test/audit-event-schema.test.js test/safe-data-files.test.js

# 全量
npm test
```

期望计数以 **当前 suite 增量** 为准；全量必须以 exit code 0 为准。全量须确认 **仅** 既有 keychain 类 skip（若有）仍为已知 skip，无新增 silent skip。

---

## Task 0: Baseline 确认（无产品代码）

**Files:** Read only — design、本 plan、下列源码/测试：

- `src/audit-log.js`
- `src/audit-integrity-journal.js`
- `src/audit-integrity-cross-store.js`
- `src/audit-event-schema.js`
- `src/safe-data-files.js`
- `src/error-codes.js`
- `src/server.js`（`recordAudit`）
- `src/agent.js`（audit wrapper）
- `src/gold-readiness.js` / `src/version.js`
- `test/audit-log.test.js`
- `test/audit-integrity-journal.test.js`
- `test/audit-integrity-journal-scans.test.js`
- `test/audit-integrity-cross-store*.test.js`
- `test/error-codes.test.js` / `test/version.test.js` / `test/gold-readiness.test.js`

- [ ] **Step 0.1:** 记录 baseline

```bash
node --test test/audit-integrity-journal.test.js test/audit-integrity-journal-scans.test.js \
  test/audit-integrity-cross-store.test.js test/audit-integrity-cross-store-scans.test.js \
  test/audit-event-schema.test.js test/audit-log.test.js test/error-codes.test.js test/version.test.js
```

Expected: exit 0；`LINKE_RELEASE_VERSION === 'V1.36'`；ERROR_CODES length **55**。

- [ ] **Step 0.2:** 确认事实钉扎：

```text
- two module-private queues (auditFileQueues + auditIntegrityJournalQueues)
- journal event-link uses safeAppendText; partial tail possible
- journal caps: 1.5MiB / existing 4096→4097 / GENERATED link line 374
- events verifier caps: 16MiB / 8192 / 16050
- audit-log default retention disabled/unbounded
- historical scans lock zero production wiring
- server/agent best-effort catch
- Gold blocked 4/4/1/9
```

- [ ] **Step 0.3:** 本 Task 不 commit（无产品代码变更）。

**禁止：** 改任何文件。
**回滚：** n/a。

---

## Task 1（C1）: Shared queue + lease + journal plan/publish — RED → GREEN

**Files:**

- Create: `src/audit-integrity-write-queue.js`
- Create: `test/audit-integrity-write-queue.test.js`
- Modify: `src/audit-integrity-journal.js`
- Modify: `test/audit-integrity-journal.test.js`
- Modify: `test/audit-integrity-journal-scans.test.js`（source-contract：queue 迁移 + plan/publish 非 append + lease）
- **禁止：** dual-write 生产接线；version bump；改 server/agent；**任何** state module / state file / gate stub / forward import / always-allow（C2 才有真实 gate）

### 导出合同（queue + lease）

```js
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Sole same-resolved-root serial write queue for audit integrity + dual-write.
 * key MUST be assertSafeDataRoot result (absolute resolved root).
 * Creates a module-generated lease bound to (resolvedRoot, current task);
 * runs task under AsyncLocalStorage.run(lease, ...);
 * ONLY queue infrastructure expires/deletes lease in finally of await task(lease).
 * Task has NO settle API and cannot expire lease early.
 * Task Promise settle DEFINES lease lifecycle end.
 *
 * Nested enqueue: if current async context already holds ANY active audit
 * write lease, reject ALL nested enqueue (same-root AND cross-root).
 * Nested meta-audit: same-root AND cross-root both reject while lease active;
 * must defer until outer settle; do NOT suggest switching root.
 *
 * Recovery lease: NEVER re-grant in queue .catch; NEVER reuse expired lease.
 * Next appendAuditEvent / explicit recoverAuditIntegrityDualWrite obtains fresh lease.
 *
 * C1 errors: existing path-free SafeDataFileError (programmer/bypass).
 * Do NOT invent C2 dual-write error codes in C1.
 */
export function enqueueAuditIntegrityWriteTask(resolvedRoot, task) {
  // task: async (lease) => ...
}

/**
 * Fail-closed unless:
 *   - lease object identity is active
 *   - lease bound root === resolvedRoot
 *   - ALS current store === lease (object identity)
 * Rejects: wrong-root / missing / expired / cross-root / outside-context.
 */
export function assertAuditIntegrityWriteLease(resolvedRoot, lease) { /* ... */ }
```

实现要点（冻结；无“实现选一”）：

```text
- module-private AsyncLocalStorage instance
- module-private WeakSet/WeakMap: active leases ↔ { root, valid }
- enqueue 开头：if ALS.getStore() is any active lease → SafeDataFileError
- callback: await als.run(lease, () => task(lease)) inside try/finally
- ONLY finally: expireAndDeleteLease(lease)  // queue infrastructure only
- previous.catch(()=>{}) isolates poison ONLY — NEVER re-grant / reuse expired
- task 无 settle API / 不能提前失效
- detached continuation 可能仍带 ALS store → assert 必须 expired 拒绝
```

### 导出合同（journal plan + publish — 唯一 SoT；名称锁死）

```js
/** @internal read-only planning; NO filesystem mutation / NO enqueue */
export async function planAuditIntegrityEventLinkUnlocked(resolvedRoot, lease, {
  generationId, event
}) {
  /* module-issued frozen plan: ONLY serializable pre/post metadata.
   * rawPreText/rawPostText stored in journal module-private WeakMap by plan identity.
   * Caller MUST NOT see/read/write raw fields. */
}

/** @internal publish WeakMap rawPost after re-read current === plan.pre;
 *  after atomic write MUST reopen+full verify exact plan.post */
export async function publishPlannedAuditIntegrityEventLinkAtomicUnlocked(
  resolvedRoot, lease, plan
) { /* ... */ }

/** @internal MUST reuse plan… + publishPlanned… (unique SoT) */
export async function appendAuditIntegrityEventUnlocked(resolvedRoot, lease, options) { /* ... */ }
/** @internal */
export async function initializeAuditIntegrityJournalUnlocked(resolvedRoot, lease, options) { /* ... */ }
// DELETED: publishAuditIntegrityEventLinkAtomicUnlocked(root, lease, { rawPre, recordLine })
```

Public `initialize` / `append`（**C1 无 state module / 无 gate**）：**只** enqueue 一次后调 unlocked plan/publish 并传入 lease；
public journal-only (post-C1 plan/publish SoT; no dual-write coordinator)；**不是** V1.35 `safeAppendText` 半写模型。
**C2+ 冻结顺序（gate 仅 C2+）：** enqueue → callback 内 **真实** `assertDualWriteStateAbsentUnlocked(root, lease)` → unlocked plan/publish（**禁止**先 gate 再 enqueue；**禁止** C1 stub；**禁止**无条件 public gate）。
Event-link：`plan…` → `publishPlanned…`（WeakMap rawPost + atomic write 后**必须核** post），不再 `safeAppendText`。
Init 仍 `safeCreateExclusiveText`。
Unlocked mutators 入口 **必须** `assertAuditIntegrityWriteLease`。

### RED

- [ ] **Step 1.1:** 队列测试最少 **26** it：

1. 同 root 串行：task 内 sleep 证明顺序
2. 不同 root 可交错（无全局大锁污染；**非嵌套**的并行 enqueue）
3. 前一 task reject → 后一 task 仍运行（no poison）
4. cleanup identity：完成后 Map 删除 self
5. 并发 20 enqueue 同 root 最终按序完成
6. resolvedRoot 必须被调用方保证（文档/断言：空字符串失败或透传由上层）
7. 导出存在且无第二 Map 在 journal 内（source scan 后续）
8. 失败 task 的 rejection 可被 caller await 感知
9. callback 收到 module-generated lease（非调用方伪造对象可轻易通过）
10. wrong-root lease assert fail-closed
11. expired lease（callback 结束后再 assert）fail-closed
12. missing / wrong-token lease fail-closed
13. **nested same-root enqueue** 禁止 → `SafeDataFileError`
14. **nested cross-root enqueue** 禁止 → `SafeDataFileError`（防 AB/BA；**不得**建议换 root 绕过）
15. cross-root lease 不能用于另一 root 的 unlocked assert
16. **detached continuation**：callback settle 后 fire-and-forget 仍持 ALS store → assert/enqueue 拒绝
17. **另一 async context 复用 lease**（无 ALS / 错误 ALS）→ assert 拒绝
18. source 使用 `AsyncLocalStorage`（`node:async_hooks`）；无新 npm 依赖
19. **lease settle 仅 queue finally**：source/runtime 证明 task 无 settle API
20. task 内 **不能** 提前失效 lease（若有误用路径 → 仍 active until settle）
21. outer task reject **不** poison 后续 task（含 nested 拒绝后 outer 继续/结束）
22. settle 后任何 assert 一律 expired
23. **禁止 re-grant：** queue `.catch` / poison 隔离路径 **不** 产生可用 expired lease
24. settle 后 **不得** 用 old lease 做任何 mutator/assert 成功
25. **nested meta-audit 同 root** active lease 内拒绝；必须 defer outer settle
26. **nested meta-audit 跨 root** active lease 内同样拒绝（不得换 root 绕过）

```bash
node --test test/audit-integrity-write-queue.test.js
```

Expected: **FAIL**（模块不存在）。

- [ ] **Step 1.2:** journal 测试新增/改写最少 **28** it：

1. public append 仍成功；receipt 字段不变
2. source 含 `planAuditIntegrityEventLinkUnlocked` + `publishPlanned…` 路径
3. source **不再**对 journal path 调用 `safeAppendText`（可用 hasCallSite helper）
4. source **无** `publish…(rawPre, recordLine)` 含糊接口；无复制 digest/link 公式
5. concurrent init∥append 无 partial tail（已有强化）
6. 模拟：若旧 partial tail fixture 仍 chain-broken（读路径）
7. unlocked append **不**二次 enqueue（spy/queue depth canary 或 source 结构）
8. public append 与 public init 共 shared queue（同 root 互斥 canary）
9. bounds preflight 仍 existing>4096 → bounds-exceeded
10. size oversize → io-error ≠ bounds
11. unlocked 无 lease / wrong lease → fail-closed
12. public wrapper 每次只 enqueue 一次（source 或 runtime canary）
13. scans：journal 仍不得 import audit-log；**更新** sole-queue source-contract 指向 shared module
14. **plan 无 filesystem mutation / 无 enqueue**（spy fd/write）
15. plan 同 pre **幂等**（两次 plan 字段相等）
16. plan **frozen**（调用方改字段后 publish 拒绝 forged/invalid plan）
17. public append 与 unlocked plan+publish 得到 **完全相同** line/hash
18. publish 拒 wrong root
19. publish 拒 wrong/expired lease
20. publish 拒 forged plan / 非 module-issued plan
21. publish 拒 current-pre mismatch（外部改 journal 后）
22. C1 public wrapper **无** state gate import/stub/always-allow（source scan）
23. plan 返回对象 **无** caller-accessible rawPre/rawPost 字段；尝试加/改 raw **无效**
24. source 使用 journal module-private WeakMap 存 raw（plan identity）
25. publish 只从 WeakMap 取 rawPost；caller 塞 raw 字段无效
26. **publish post-write 必须核：** atomic write 返回后 reopen+full verify exact plan.post
27. **post-rename swap injected**（write 返回后、verify 前换文件）→ publish **不**报成功
28. plan lease 过期后 publish 拒绝；private payload 可删

```bash
node --test test/audit-integrity-journal.test.js test/audit-integrity-journal-scans.test.js
```

Expected: FAIL until GREEN。

### GREEN

- [ ] **Step 1.3:** 实现 queue + ALS lease settle finally + journal 迁移 + plan/publish 唯一 SoT + unlocked。
- [ ] **Step 1.4:** GREEN

```bash
node --test test/audit-integrity-write-queue.test.js \
  test/audit-integrity-journal.test.js test/audit-integrity-journal-scans.test.js \
  test/audit-integrity-cross-store.test.js test/audit-event-schema.test.js
```

Expected: exit 0。

- [ ] **Step 1.5:** **C1 commit + push**

```text
feat: shared audit integrity write queue lease and atomic journal event-link publish
```

**禁止：** `appendAuditEvent` 接线 dual-write；version；stage `package-lock.json`；外层 dual-write 调 public journal append；nested enqueue（同/跨 root）；新增 C2 error codes；“实现选一”残留；**state module / state file / gate stub / forward import / always-allow**；复制 digest/link 公式；`publish(rawPre,recordLine)`。
**回滚：** 还原本 boundary 文件。

---

## Task 2（C2）: State schema / error codes / **真实完整** absent gate — RED → GREEN

**Files:**

- Modify: `src/error-codes.js`
- Modify: `test/error-codes.test.js`
- Create: `src/audit-integrity-dual-write-state.js`（**真实完整** schema/parser/publish/**absent gate**；**非** skeleton/write-only）
- Create: `src/audit-integrity-dual-write.js`（可先 thin coordinator；**不**假装 recovery 完成；**禁止** silent stub 假绿；**C2 不** bootstrap create idle）
- Create: `test/audit-integrity-dual-write-state.test.js`
- Create: `test/audit-integrity-dual-write.test.js`（可最小 smoke）
- Modify: `src/audit-integrity-journal.js`（public init/append 接线 **真实** state-absent gate 于 queue callback 内）
- Modify: `test/audit-integrity-journal.test.js`（gate 行为；锁无 stub/TODO/always-allow/skeleton/write-only）
- 可选：`src/safe-data-files.js` `safeReadBytes`（同 fd 二次 fstat）/ `safeAtomicWriteBytes` + 测试（完整 hostile 可在 C4）

### 新增 5 码（仅此五项）

```js
AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID:          'audit-integrity-dual-write-state-invalid',
AUDIT_INTEGRITY_DUAL_WRITE_IO_ERROR:               'audit-integrity-dual-write-io-error',
AUDIT_INTEGRITY_DUAL_WRITE_RECOVERY_CONFLICT:      'audit-integrity-dual-write-recovery-conflict',
AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH:        'audit-integrity-dual-write-cursor-mismatch',
AUDIT_INTEGRITY_DUAL_WRITE_DIRECT_MUTATION_BLOCKED:'audit-integrity-dual-write-direct-mutation-blocked',
```

```text
计数：55 → 60  (+5)
```

### RED

- [ ] **Step 2.1:** `EXPECTED_ERROR_CODES` 全表 + 计数 **60**；唯一性/kebab；注释 size≠bounds 类比保持。

```bash
node --test test/error-codes.test.js
```

Expected: FAIL until registry 同步。

- [ ] **Step 2.2:** state parser / publish / gate 测试最少 **48** it：

1. 合法 idle roundtrip（atomic write + load）
2. 合法 prepared roundtrip（含 retention null 与 `{maxEvents:n}`）
3. wrong key order → state-invalid
4. extra key → state-invalid
5. missing key → state-invalid
6. schemaVersion≠1 → state-invalid
7. status 非 idle|prepared → state-invalid
8. generationId 非 32 hex → state-invalid
9. digest 非 64 hex → state-invalid
10. events.present=false 但 byteLength≠0 → state-invalid
11. prepared.event extra field → state-invalid
12. prepared.eventLineUtf8 与 strict stringify 不一致 → state-invalid
13. prepared.eventLineUtf8 字段序必须 id→createdAt→type（**拒绝** createdAt→id 示例）
14. prepared.payloadDigest 与既有 SoT compute 不一致 → state-invalid
15. prepared journal.post.recordCount ≠ pre.recordCount+1 → state-invalid
16. prepared journal.post.sequence ≠ pre.recordCount → state-invalid
17. prepared journal.post.previousLinkDigest ≠ pre.headDigest → state-invalid
18. prepared journal.post.linkDigest ≠ post.headDigest → state-invalid
19. prepared events.post.present ≠ true → state-invalid
20. retention null：events.post.strictRecordCount ≠ pre+1 → state-invalid
21. retention enabled：events.post.strictRecordCount ≠ min(pre+1, maxEvents) → state-invalid
22. idle last* 部分 null 部分 non-null → state-invalid
23. idle last* all-non-null 但 lastSequence ≠ journal.recordCount-1 → state-invalid
24. idle last* all-null 合法（bootstrap）
25. **成功 idle last* 赋值语义文档/helper：** lastTransactionId=prepared.transactionId；lastPayloadDigest=prepared.payloadDigest；lastSequence=prepared.journal.post.sequence
26. **C2 明确锁：** all-non-null last* ⇒ lastSequence === journal.recordCount-1（parser 关系；非仅文档）
27. oversize state **read** → io-error
28. invalid JSON → state-invalid
29. symlink leaf → occupied for gate；load → io-error（或 Safe map 到 dual-write-io）
30. directory leaf → 同上
31. error message === code；无 path 子串
32. 无 event body 泄漏到 message
33. publish 使用 `safeAtomicWriteText`；trailing `\n` 规范
34. publish 前序列化 >65536 → state-invalid（**绝不**先写后失败）
35. 最坏 strict event（NUL + lone surrogate 独立 canary）prepared 序列化 ≤65536 证明
36. 65537 synthetic fixture 拒绝
37. absent gate：state **path** exact ENOENT → allow signal（queue-internal unlocked 形态）
38. dual-write-state 源码 **不** import journal/coordinator/audit-log
39. state parser **不**凭 pre hash 重算 full raw post hash（source/contract 锁职责分层）
40. prepared.journal.* 与 journal plan 字段逐字段相等的 helper/fixture 合同说明（C4 实现时 assert）
41. **无 stub/TODO/always-allow/skeleton/write-only** 在 gate 或 state 模块（source scan）
42. state 模块导出真实 parser + publisher + gate（**非** write-only / skeleton）
43. gate **不**靠 lease 判 occupancy（lease 缺失/错误 → lease 错误；ENOENT 与 occupied 与 lease 正交）
44. **手工发布 valid idle state** → gate occupied block
45. **手工发布 invalid JSON state** → gate occupied block
46. **手工发布 unsafe state（symlink/dir）** → gate occupied block
47. prepared/idle publish 返回后至少可 load 得 exact expected status（post-write 可读核）
48. C2 production path **不** create state 文件（cold absent → public journal-only 允许；bootstrap 归 C3）

```bash
node --test test/audit-integrity-dual-write-state.test.js test/error-codes.test.js
```

Expected: FAIL until GREEN。

- [ ] **Step 2.3:** journal public gate 测试最少 **15** it：

1. state missing → public init 仍工作（public journal-only post-C1 plan/publish SoT；C2 cold absent）
2. state missing → public append 仍工作（需已 init；C2 production 不 create state）
3. state idle → public init 拒绝 DIRECT_MUTATION_BLOCKED；journal bytes 不变
4. state idle → public append 拒绝；journal bytes 不变
5. state prepared → public init 拒绝；**不** recover
6. state prepared → public append 拒绝；**不** recover
7. state invalid JSON 文件 → 拒绝；bytes 不变
8. state symlink/dir → 拒绝；bytes 不变
9. **source/runtime：** public init/append **先 enqueue 再** gate（禁止先 gate 再 enqueue；gate 仅 C2+）
10. gate 在 active lease 下执行（assert lease / unlocked 形态）；lease 只证临界区，**不**判 occupancy
11. **C2 并发 canary（无 bootstrap）：** 真实 state module 在 shared queue 内，
    手工/测试 helper publish idle|prepared 占位 ∥ public journal-only init/append；
    无论队列顺序：占位先 → public 拒绝；public 先 → journal-only 完成后占位发布；
    **绝不** state 已占用后 journal-only 写
    （真正 `direct append ∥ first coordinator bootstrap` 迁 **C3 行为** + **C6 hostile**）
12. gate 实现为 **真实 path occupancy** 检查（**无** always-allow / TODO / stub / skeleton / write-only）
13. 任何 state file 仅测试手工创建；C2 production path **不**写 state（bootstrap 归 C3；gate 真实）
14. 手工 publish valid idle|prepared / invalid / unsafe state 分别阻断 public init/append
15. C2 state module 具备完整 load/parse/publish 能力（非 write-only 假绿）

```bash
node --test test/audit-integrity-journal.test.js test/audit-integrity-dual-write-state.test.js
```

### GREEN

- [ ] **Step 2.4:** 注册五码 + 实现 state 模块（含关系不变量）+ journal gate 接线（queue 内）+ Error class。
- [ ] **Step 2.5:** GREEN 上述测试。

- [ ] **Step 2.6:** **C2 commit + push**

```text
feat: add dual-write state schema parser gate and error codes
```

**禁止：** production wiring；吞非 ENOENT；把 path 写入 Error；gate 内 auto-recover；dual-write-state import journal；先 gate 再 enqueue；stub/TODO/always-allow/skeleton/write-only gate；C1 残留 gate stub；C2 bootstrap create idle（归 C3）；用 lease 判 occupancy。
**回滚：** 还原本 boundary 文件。

---

## Task 3（C3）: Bootstrap / idle validation — RED → GREEN

**Files:**

- Modify: `src/audit-integrity-dual-write.js`
- Modify: `test/audit-integrity-dual-write.test.js`
- 依赖：C1 + C2

### 行为合同

实现 design §6 矩阵最小可测 API，例如：

```js
/** @internal ensure idle cursor ready under queue lease */
export async function ensureAuditIntegrityDualWriteIdleUnlocked(resolvedRoot, lease) { /* ... */ }
```

或经 public test hook：`recoverAndValidateDualWrite(root)` enqueue 包装。

**C3 对 prepared 的硬性边界：**

```text
- production appendAuditEvent 仍未接线（直到 C5）→ 生产路径不会产生 prepared WAL
- 若测试或内部 API 遇到 prepared fixture：
    MUST fail-closed / recovery-not-yet-exposed（typed）
    MUST NOT no-op 当 idle
    MUST NOT clear prepared
- C4 实现 recovery 后替换该门
```

### RED（最少 19 it）

1. `S∅+J∅+E∅` → init journal + idle
2. `S∅+J∅+Elegacy` → init + idle；cross-store partial journal-suffix 或 uncovered 诚实
3. `S∅+J∅+Ebad` → fail-closed；不 init 掩盖
4. `S∅+Jopen+E∅` → idle from open；不改写 journal
5. `S∅+Jevt+E equal` → idle
6. `S∅+Jevt+E partial/uncovered` → **允许** bootstrap idle（非 “partial 一律失败”）
7. `S∅+Jbad` → 传播 journal typed；不 auto-repair
8. journal 非 NOT_INITIALIZED 错误 **不**当 missing
9. state idle 匹配 → ok
10. state idle 但 events 被改 → cursor-mismatch；stores 不被“修复”
11. state idle 但 journal head 被改 → cursor-mismatch
12. generationId 不一致 → cursor-mismatch
13. state prepared 存在 → **fail-closed / recovery-not-yet-exposed**（非 idle；非 no-op）
14. bootstrap 后 state 文件 mode/atomic 可读
15. path-free errors
16. 不自动把 broken J↔E 写成 idle
17. 仅 ENOENT = state missing；`S∅`+verified/partial **不是** cursor-mismatch
18. init O_EXCL 残留 zero/partial journal → Jbad fail-closed
19. **行为并发 canary：** `direct append ∥ first coordinator bootstrap` 同时发起；
    无论队列顺序：coordinator 先创 state → public journal-only 拒绝；
    public journal-only 先完成 → coordinator 合法 bootstrap；
    **绝不** idle 创建后 journal-only 写（C6 hostile 复锁）

```bash
node --test test/audit-integrity-dual-write.test.js \
  test/audit-integrity-dual-write-state.test.js \
  test/audit-integrity-journal.test.js test/audit-integrity-cross-store.test.js
```

### GREEN

- [ ] **Step 3.1:** 实现 bootstrap + idle validate + prepared fail-closed 门。
- [ ] **Step 3.2:** GREEN。
- [ ] **Step 3.3:** **C3 commit + push**

```text
feat: dual-write bootstrap and idle cursor validation
```

**禁止：** 自动重基线；吞 typed 错误；改默认 retention；prepared no-op 当 idle；auto-repair Jbad。
**回滚：** 还原本 boundary 文件。

---

## Task 4（C4）: Prepared WAL + recovery core — RED → GREEN

**Files:**

- Modify: `src/audit-integrity-dual-write.js`
- Modify: `src/audit-integrity-dual-write-state.js`（若需 publish helpers）
- Modify: `src/safe-data-files.js`（`safeReadBytes` / `safeAtomicWriteBytes`；**禁止** truncate/ftruncate 合同）
- Modify: `test/audit-integrity-dual-write.test.js`
- 可选: `test/safe-data-files.test.js`
- 依赖：C1–C3

### 核心 API（示例）

```js
/**
 * Journal-first dual-write under shared queue + lease.
 * @returns sanitized event (same as appendAuditEvent contract)
 */
export async function appendAuditEventWithIntegrityDualWrite(dataDir, event, options = {}) { /* ... */ }

/** @internal recover prepared if any; replaces C3 recovery-not-yet-exposed gate */
export async function recoverAuditIntegrityDualWrite(root) { /* ... */ }
```

### RED — crash fixtures（最少 62 it）

**状态机 happy path：**

1. 空 root 首次 dual-write → journal open+link；events 1 行；state idle；cross-store equal
2. 第二次 append → sequence 2；两边一致
3. receipt/return 为 sanitized event

**Crash points（retention null）：**

4. CP1 fixture（prepared + both pre）→ 同一 `plan…` 重建 + 逐字段 assert → publishPlanned → events → idle；幂等二次 recover
5. CP2（journal post + events pre）→ 只补 events
6. CP3a byte partial（prefix of exact line，含半个多字节 UTF-8 emoji）→ **一次** `safeAtomicWriteBytes(preBytes+eventLineBytes)` → idle（**无** truncate/reappend）
7. CP3a-empty：prepared.events.pre.present===false + emptyDigest + current events present regular empty
   → `created-empty-partial`（**events** 分类；**无** extra flag；**非** journal init）→ atomic repair → idle
8. CP4 both post + prepared → 只写 idle；**不**重复行
9. CP0 无 prepared → no-op recover / bootstrap path（**不**走 recovery classifier）
10. CP-X prepared + **Jpre + Epost** → recovery-conflict；保留 prepared；**两 store 都不改**
11. prepared 字段人为改一位 → recovery conflict 且 **不写** journal/events
12. recovery plan rebuild：current exact pre 时 plan' 与 prepared.journal pre/post 逐字段相等后才 publish

**Crash points（retention enabled — atomic final）：**

13. prepared + both pre → 一次 atomic final → idle
14. rename-before canary：events exact pre；无 intermediate fingerprint
15. rename-after canary：events exact post → 只 idle；幂等
16. size 介于 pre/post 但非 exact → **other** → recovery-conflict（无 partial 修复）

**分类（null 六态 + other）：**

17. events other（中间插字节）→ recovery-conflict；prepared **保留**
18. journal other（与 pre/post 都不匹配）→ recovery-conflict
19. 失败路径禁止把 prepared 写成 idle
20. pre missing+current missing = exact-pre
21. pre present empty（present===true）+ current empty = exact-pre（**非** created-empty-partial）
22. pre nonempty + current empty / flag 异常 / non-prefix = other（append 不会截断 pre）
23. full line = exact-post
24. **禁止**从 journal raw “恢复 events pre”；preBytes 来自 current 前缀 hash 验证或 empty
24b. created-empty 三者锁：#7 / 无 prepared→bootstrap / pre.present=true empty→exact-pre

**Occurrence canaries：**

25. 连续 3 次完全相同 payload → 3 行 events + sequence 递增；非 suffix 猜测
26. 重复 event id（允许若 sanitize 保留）→ 仍 3 occurrence
27. 相同 payloadDigest 历史 + 新写 → 靠 transition 不靠 “digest 已存在则 skip”

**Byte / hostile / bounds：**

28. NUL 字段 event 往返 byte 一致
29. lone surrogate 字段
30. emoji 字段
31. 合法 **500-byte** business event line 成功（证明非 journal 374 混用）
32. event line 16050 边界通过；16051 → cross-store bounds；**不写 prepared**
33. journal generated link >374 → journal bounds（独立 canary）
34. preflight journal at 4096 existing → 仍可写第 4097；再下一笔 bounds 且 **不写 prepared**
35. journal raw >1.5MiB → io-error；events window >16MiB → cross-store io
36. preflight 失败 stores 字节不变
37. prepared 先于 journal 的顺序：plan → prepared WAL → publishPlanned（crash inject 或 write spy 序）
38. **safeReadBytes / safeAtomicWriteBytes** hostile：symlink swap / size grow / short read / premature EOF / kill before|after rename
39. repair 后 bytes hash **必须** equal prepared post
40. source **无** ftruncate / safeTruncate / truncate→reappend 合同
40b. **safeReadBytes 二次 fstat：** 两次 fstat 间 append/grow/truncate → SafeDataFileError
40c. safeReadBytes：初次 fstat 记 dev/ino/size/mode；二次 fstat 同 fd 必须相等且 regular

**并发：**

41. 同 root 50+ concurrent dual-write → 最终 events 行序与 journal payloadDigests 严格一致
42. 不同 root 并行无串话

**Post-check：**

43. 成功 post 允许：equal / events-suffix-of-journal / journal-suffix-of-events（fixture 级）
44. **journal-suffix-of-events 可达 canary：** legacy E=[legacy,a] J=[a] → append x → E=[legacy,a,x] J=[a,x]
45. 成功 append post-check 返回 **uncovered-events** → unexpected → recovery-conflict；保留 prepared
46. 成功 append post-check 返回 **empty** → unexpected → recovery-conflict；保留 prepared
47. broken / 其它 unexpected → 保留 prepared + recovery-conflict

**Decode / UTF-8：**

48. events raw 经 fatal `TextDecoder('utf-8', { fatal: true })` 再 strict parse
49. **invalid UTF-8 baseline** fixture → fail-closed（bootstrap / recovery 均不得当合法基线）
50. partial 分类始终在 decode 前按 bytes 完成（半个多字节字符 canary 已在 CP3）

**Idle last* / plan / lease recovery：**

51. 成功 idle last* = prepared.transactionId / payloadDigest / journal.post.sequence
52. last* all-non-null ⇒ lastSequence === journal.recordCount-1
53. direct append 与 dual/recovery 同一 line/hash（plan SoT）
54. plan raw 私有化：caller 加/改 raw 无效；forged plan 拒绝；post-rename swap → publish 不报成功
55. **old lease expired** 后 assert/mutator fail-closed
56. **next call fresh lease recovery 成功**（非 lease 错误）
57. **next call fresh lease recovery conflict**（typed recovery-conflict；**非** lease 错误）
58. **explicit recoverAuditIntegrityDualWrite obtains fresh lease**（自身 resolve+enqueue）
59. 禁止 queue catch re-grant / 复用 expired 做 recovery
60. prepared/idle 写后至少 read/parse exact expected status+cursor 再推进/返回 success
61. journal publish atomic write 返回后 **必须核** exact plan.post

**安全：**

62. 错误无 path；state 无 secrets

```bash
node --test test/audit-integrity-dual-write.test.js test/safe-data-files.test.js \
  test/audit-integrity-dual-write-state.test.js \
  test/audit-integrity-journal.test.js test/audit-integrity-cross-store.test.js
```

### GREEN

- [ ] **Step 4.1:** 实现 prepare/recover/classify + **atomic byte image repair**（仅 null；无 truncate）+ atomic final（enabled）+ plan rebuild recovery + coordinator 核心（fatal UTF-8）+ 替换 C3 prepared 门。
- [ ] **Step 4.2:** GREEN。
- [ ] **Step 4.3:** **C4 commit + push**

```text
feat: dual-write prepared WAL and crash recovery core
```

**禁止：** 热路径 events 在 retention null 时整文件 rewrite（recovery O(n) atomic image 除外）；enabled 路径 append+compact 两阶段；用 `safeReadText` 做 partial 分类；replacement 修复非法 UTF-8；清 prepared 掩盖失败；虚构 intermediate fingerprint；成功 post 接受 empty/uncovered-events；truncate/ftruncate/reappend；复制 journal digest/link 公式；从 journal raw 恢复 events pre；version bump。
**回滚：** 还原本 boundary 文件。

---

## Task 5（C5）: Production `appendAuditEvent` exact-one wiring — RED → GREEN

**Files:**

- Modify: `src/audit-log.js`
- Modify: `test/audit-log.test.js`
- Modify: `test/audit-integrity-dual-write.test.js`（wiring 集成）
- Modify: scans（若 C6 前需最小 wiring scan）
- **禁止：** server/agent 直接 import dual-write/journal；改 catch 策略

### 行为合同

```js
export async function appendAuditEvent(dataDir, event, options = {}) {
  // sanitize (keep) → dual-write coordinator (shared queue + lease inside)
  // return sanitized
}
```

- **废除**无 retention 时 **跳过 queue 直 append** 旁路（原计划已有；C5 加强静态 scan + 首次 cold append 测试）
- **废除**独立 `auditFileQueues` 作为 production 写路径（避免双队列）
- `readAuditEvents` / retention normalize **语义保持**
- retention null：append 策略；maxEvents≥1：一次 atomic final retained image；idle fingerprint = 最终可见
- **不**存在 append 后再 compact 的 coordinator 步骤

### RED（最少 22 it）

1. append 后 events+journal+state 存在且一致
2. 返回 sanitized 与输入 sanitize 一致
3. retention disabled 多笔不 compact（append 策略）
4. retention maxEvents=3 → 最终 events 后缀 3；journal 仍完整增长
5. retention 并发 serialize 不超 maxEvents（移植强化现网测试）
6. 同 root 50 concurrent via `appendAuditEvent`
7. legacy events 文件 + 新 dual-write → partial 诚实 + 新行入链
8. `readAuditEvents` limit/坏行忽略行为保持
9. audit-log **静态 import** dual-write 模块（exactly one）
10. audit-log **不** import journal public（只经 dual-write）
11. 失败时抛 typed/SafeDataFileError 可观测（不被 audit-log 吞）
12. normalizeAuditRetention 合同保持
13. parseAuditRetentionMaxEvents 合同保持
14. 无 dataDir squatting：symlink root 等 fail-closed（既有 safe root）
15. retention enabled 后 idle 与磁盘最终 image 匹配
16. journal 4096 天花板经 appendAuditEvent 暴露 bounds
17. 不写 capability-proof path
18. 现有 audit-log 安全测试（symlink leaf 等）仍绿
19. **静态 scan：** 无独立 `auditFileQueues` production 写路径 / 无 retention-null fast path 旁路
20. **首次 cold append** 测试：空 root 第一笔也走 shared queue（非旁路）
21. 合法 500-byte event via `appendAuditEvent` 成功
22. 16051 event line → cross-store bounds；stores 不变

```bash
node --test test/audit-log.test.js test/audit-integrity-dual-write.test.js \
  test/audit-integrity-journal.test.js test/audit-integrity-cross-store.test.js
```

### GREEN

- [ ] **Step 5.1:** 接线 `appendAuditEvent`；废除 fast path 与分裂 queue。
- [ ] **Step 5.2:** GREEN。
- [ ] **Step 5.3:** **C5 commit + push**

```text
feat: wire appendAuditEvent through dual-write coordinator
```

**禁止：** server/agent 直接接线；改 catch 策略；默认 retention 变更；stage `package-lock.json`；append+compact 两阶段。
**回滚：** 还原本 boundary 文件。

---

## Task 6（C6）: Crash/hostile/scans/limitations — RED → GREEN

**Files:**

- Create: `test/audit-integrity-dual-write-scans.test.js`
- Modify: `test/audit-integrity-journal-scans.test.js`（zero-wiring → 与 dual-write 协调；journal 仍无 audit-log/coordinator）
- Modify: `test/audit-integrity-cross-store-scans.test.js`（保持 cross-store 无 wiring；允许 dual-write 调 verify）
- Modify: 相关 honesty 测试
- 可选：`test/server-*.test.js` / agent 测试中 best-effort 诚实用例

### Scans 必须覆盖

1. **exactly one controlled wiring：** 仅 `audit-log.js` import dual-write 并调用 coordinator
2. **server/agent zero direct：** 无 dual-write/journal/cross-store/unlocked specifier
3. **journal no audit-log / no coordinator import**
4. **dual-write-state no journal/coordinator/audit-log import**
5. **cross-store read-only**（无 write/append/queue）
6. **capability sink isolated**
7. **unlocked import allowlist** + lease assert 存在
8. honesty phrases 仅 negative/BLOCKED 同 clause（含 state continuity 非 delivered）
9. 禁止完整 forbidden compound 字面量（runtime concat needle）
10. dual-write 源码头注释含签字上限 + BLOCKED 列表
11. 废除 fast path / `auditFileQueues` 旁路的静态证明

### Hostile / limitations 测试

12. CP fixtures 全套再跑（扫描套件可 import 行为测试 helper）
13. retention atomic rename canaries + 幂等
14. direct gate（queue 内）：idle/prepared/invalid/symlink/dir 全拒绝且 bytes 不变
15. state missing 时 public journal APIs 仍工作
16. lease wrong/expired/cross-root/outside-context；nested same-root；nested cross-root；detached continuation
17. gate TOCTOU canary 分层复锁：
    - C2 层：占位 idle|prepared publish ∥ public journal-only（无 bootstrap）
    - C3/C6 层：真正 `direct append ∥ first coordinator bootstrap`
18. bounds 拆分 canaries（500-byte / 16050 / journal 374）
19. invalid UTF-8 events fail-closed canary
20. 成功 post 拒绝 empty/uncovered-events → recovery-conflict
21. state deletion re-bootstrap limitation 文档/注释诚实（非 delivered claim）
22. multi-process **不**宣称（文档/注释 limitation）
23. server `recordAudit`：force append 失败 → 不抛到请求主路径（既有或新增；**不**要求新 HTTP 失败通道）
24. agent audit wrapper swallow
25. 不得出现无限定 “production-hardening ready” / “T6d.3 complete” / “M6d Exit”
26. ERROR_CODES length **60**

```bash
node --test test/audit-integrity-dual-write-scans.test.js \
  test/audit-integrity-dual-write.test.js \
  test/audit-integrity-dual-write-state.test.js \
  test/audit-integrity-journal-scans.test.js \
  test/audit-integrity-cross-store-scans.test.js \
  test/audit-log.test.js \
  test/error-codes.test.js
```

### GREEN

- [ ] **Step 6.1:** 实现/更新 scans 与诚实测试。
- [ ] **Step 6.2:** GREEN。
- [ ] **Step 6.3:** **C6 commit + push**

```text
test: dual-write crash hostile scans and honest limitations
```

**禁止：** 删除旧 zero-wiring 扫描却不替换；fake green；version bump；扩大 catch 策略 scope。
**回滚：** 还原本 boundary 文件。

---

## Task 7（C7）: temporal → V1.37 + Gold/README honesty — RED → GREEN

**Files:**

- Modify: `src/version.js` → `V1.37`
- Modify: `src/gold-readiness.js`（production-hardening evidence/nextStep；**保持** partial 与 4/4/1/9）
- Modify: `README.md` 版本徽章/表/说明（诚实 dual-write；非 M6d Exit）
- Modify: `test/version.test.js` / `test/gold-readiness.test.js`
- **禁止：** 改 M1 exit audit 历史 markdown

### RED

- [ ] **Step 7.1:** 更新测试期望 `V1.37`；Gold 计数锁；`not production-hardening ready` 同 clause 规则。

```bash
node --test test/version.test.js test/gold-readiness.test.js test/cross-lan-m1-exit-audit.test.js
```

Expected: FAIL until sources 同步。

### GREEN

- [ ] **Step 7.2:** 升版本 + Gold/README 诚实叙述（签字上限；T6d.3 partial；caller catch limitation；无 rotation/multi-process；无 state continuity）。
- [ ] **Step 7.3:** GREEN。
- [ ] **Step 7.4:** **C7 commit + push**

```text
chore: release milestone V1.37 dual-write coordinator
```

**禁止：** Gold ready；M6d Exit；production-hardening ready；stage `package-lock.json`。
**回滚：** 还原本 boundary 文件。

---

## Task 8（C8）: Full suite + adversarial + fresh Grok closure

- [ ] **Step 8.1:** 全量

```bash
npm test
```

Expected: exit 0；仅既有 keychain skip（若环境仍 skip）；无新增 skip。

- [ ] **Step 8.2:** 相关回归包

```bash
node --test \
  test/audit-integrity-write-queue.test.js \
  test/audit-integrity-dual-write.test.js \
  test/audit-integrity-dual-write-state.test.js \
  test/audit-integrity-dual-write-scans.test.js \
  test/audit-integrity-journal.test.js \
  test/audit-integrity-journal-scans.test.js \
  test/audit-integrity-cross-store.test.js \
  test/audit-integrity-cross-store-scans.test.js \
  test/audit-log.test.js \
  test/audit-event-schema.test.js \
  test/error-codes.test.js \
  test/version.test.js \
  test/gold-readiness.test.js
```

- [ ] **Step 8.3:** GLM adversarial / fresh Grok reviewer 对照 design §验收清单 + 本 plan DoD。
- [ ] **Step 8.4:** 若有修复：`test:`/`fix:` 精确 commit（仍不 stage `package-lock.json`）。
- [ ] **Step 8.5:** 关闭条件：签字仅
  `V1.37 journal-first crash-recoverable audit dual-write coordinator implementation`
  且明确 **不是** T6d.3 complete / M6d Exit / production-hardening ready / Gold ready。

**禁止：** 无测试的“认为完成”；扩大 scope 到 rotation/HMAC/改 catch。

---

## Definition of Done（实现阶段）

- [ ] C0–C7 均已绿且按 boundary commit（PM 自动精确 commit/push；无需再次确认）
- [ ] ERROR_CODES **60**（+5）
- [ ] `LINKE_RELEASE_VERSION === 'V1.37'`
- [ ] Gold **4/4/1/9 blocked**；production-hardening **partial**
- [ ] 同 root 50+ concurrent 一致
- [ ] CP0–CP5 + Jpre/Epost conflict + retention atomic canaries 恢复幂等
- [ ] journal **plan + publishPlanned** 唯一 SoT；raw 在 WeakMap；publish 后**必须核** post；shared queue **唯一** + lease settle finally
- [ ] recovery 仅 fresh lease（next call / explicit recover）；禁 catch re-grant / 复用 expired
- [ ] retention 互斥策略：null append + atomic byte image repair / enabled 一次 atomic final
- [ ] public journal-only：C1 无 gate；C2+ **真实完整** state schema/parser/publisher/absent gate 绿（path occupancy；非 skeleton/write-only；无 TOCTOU/stub）
- [ ] nested enqueue 同/跨 root + nested meta-audit defer + detached + outside-context 绿；不得换 root 绕过
- [ ] 成功 post 仅 equal/suffix 两类 suffix；journal-suffix 可达 canary；empty/uncovered 仅 bootstrap 绿
- [ ] prepared 关系不变量 + STRICT_FIELD_ORDER eventLineUtf8 绿
- [ ] 成功 idle last* 从 prepared 赋值；lastSequence === recordCount-1 绿（C2 tests 明确）
- [ ] created-empty-partial：events 分类、无 extra flag、非 journal init；三者测试锁死
- [ ] safeReadBytes 同 fd 二次 fstat size-race 绿
- [ ] fatal UTF-8 decode + invalid UTF-8 fail-closed 绿
- [ ] bounds 精确拆分 canaries 绿
- [ ] exactly-one wiring scans 绿；fast path / 分裂 queue 已废除
- [ ] server/agent best-effort 诚实测试绿（catch 未改）
- [ ] full `npm test` 绿
- [ ] 无未跟踪 `package-lock.json` 入 commit
- [ ] 无 truncate/ftruncate repair；无 publish(rawPre,recordLine)；无复制 digest/link 公式

---

## 回滚策略

| Boundary | 回滚 |
| --- | --- |
| C0 | 删两份 docs（仅当未共享） |
| C1–C6 | `git revert` 该 boundary commit；保留 C0 |
| C7 | revert version/gold/readme；代码 boundary 可先留 |
| 任何 | 永不 `reset --hard` 丢未推送他作；永不强推 main |

---

## 附录 A：Crash recovery 速查

```text
# journal plan/publish unique SoT
normal: plan(read-only metadata; raw in WeakMap) → prepared(no raw; post-write read/parse)
        → publishPlanned(WeakMap rawPost; atomic write 后**必须核** plan.post)
recovery plan/WeakMap lost (under FRESH lease only):
  current exact pre  → same plan… rebuild + fieldwise assert vs prepared → publish
  current exact post → verify only
  else               → recovery-conflict (keep prepared; no write)
# recovery lease: next appendAuditEvent / explicit recover; NEVER catch re-grant / expired reuse

# retention === null (append hot path + atomic image repair)
prepared + Jpre  + Epre     → plan rebuild + publishPlanned, events append, idle
prepared + Jpost + Epre     → events append, idle
prepared + Jpost + Epartial → ONE safeAtomicWriteBytes(preBytes+eventLineBytes), idle
prepared + Jpost + created-empty-partial
  (events class: prepared.pre.present=false+emptyDigest + current present empty; NO extra flag)
  → ONE safeAtomicWriteBytes(eventLineBytes), idle
prepared + Jpost + Epost    → idle only
prepared + Jpre  + Epost    → recovery-conflict (keep prepared; neither store mutated)
prepared + *other*          → recovery-conflict (keep prepared)
# DELETED: truncate / ftruncate / truncate→rehash→append

# retention.maxEvents >= 1 (atomic final strategy)
prepared + Jpre  + Epre     → plan rebuild + publishPlanned, one atomic final, idle
prepared + Jpost + Epre     → one atomic final, idle
prepared + Jpost + Epost    → idle only
prepared + mid-size/other   → recovery-conflict (NO partial class)
# rename-before = pre; rename-after = post; NO intermediate fingerprint

# shared
idle mismatch (state EXISTS) → cursor-mismatch (no auto-rebaseline)
state missing + verified/partial → bootstrap (NOT mismatch)
preflight fail              → no prepared write; stores unchanged
direct journal-only + state occupied → DIRECT_MUTATION_BLOCKED (no recover)
  // C2+ gate runs INSIDE shared queue under active lease (no TOCTOU)
  // C1: no gate / no state
successful post relationships ONLY:
  equal | events-suffix-of-journal | journal-suffix-of-events
journal-suffix-of-events REACHABLE after legacy bootstrap baseline
empty | uncovered-events as post-check after successful append
  → recovery-conflict (keep prepared); allowed only as bootstrap receipt
events decode: fatal UTF-8; partial classify by bytes before decode
success idle last*:
  lastTransactionId = prepared.transactionId
  lastPayloadDigest = prepared.payloadDigest
  lastSequence      = prepared.journal.post.sequence
  all-non-null ⇒ lastSequence === journal.recordCount-1
lease settle: ONLY queue finally after await task(lease)
recovery lease: next call / explicit recover fresh lease only; no catch re-grant
nested enqueue: same+cross root rejected; nested meta-audit both reject while active;
  defer meta-audit until outer settle; no "switch root"
safeReadBytes: first+second fstat same fd (dev/ino/size/mode); size-race fail
publish post-write: MUST verify exact plan.post (not "may")
C2 state: real full schema/parser/publisher/gate (not skeleton/write-only);
  path ENOENT vs occupied; lease ≠ occupancy; C3 bootstrap idle
```

## 附录 B：文件清单（实现期预期）

```text
CREATE  src/audit-integrity-write-queue.js
CREATE  src/audit-integrity-dual-write-state.js
CREATE  src/audit-integrity-dual-write.js
CREATE  test/audit-integrity-write-queue.test.js
CREATE  test/audit-integrity-dual-write-state.test.js
CREATE  test/audit-integrity-dual-write.test.js
CREATE  test/audit-integrity-dual-write-scans.test.js
MODIFY  src/audit-integrity-journal.js
MODIFY  src/audit-log.js
MODIFY  src/safe-data-files.js
MODIFY  src/error-codes.js
MODIFY  src/version.js                  # C7 only
MODIFY  src/gold-readiness.js           # C7 only
MODIFY  README.md                       # C7 only
MODIFY  test/audit-integrity-journal*.js
MODIFY  test/audit-log.test.js
MODIFY  test/error-codes.test.js
MODIFY  test/version.test.js            # C7
MODIFY  test/gold-readiness.test.js     # C7
KEEP RO src/audit-integrity-cross-store.js (behavior; scans may tweak allow)
KEEP RO src/server.js / src/agent.js catch policy (honesty tests only; no catch change)
```

## 附录 C：模块 DAG（冻结）

```text
audit-log → audit-integrity-dual-write(coordinator) → journal unlocked plan/publish
                                                   → dual-write-state
                                                   → write-queue (lease + ALS; settle finally)
journal public wrapper C1
  → resolve root → shared queue → plan/publish
  // public journal-only (post-C1 plan/publish SoT; no dual-write coordinator)
  // NO gate/state; NOT V1.35 safeAppend half-write
journal public wrapper C2+
  → resolve root → shared queue
  → inside callback + active lease:
      assertDualWriteStateAbsentUnlocked (REAL; C2+) → journal unlocked plan/publish
dual-write-state ↛ journal / coordinator / audit-log
journal ↛ coordinator / audit-log
// 禁止：先 gate 再 enqueue（TOCTOU）；禁止 C1 gate stub；禁止无条件 public gate
// 禁止：publish(rawPre,recordLine)；禁止 truncate repair
// C2 canary = 占位 publish ∥ public journal-only；bootstrap 并发 = C3/C6
```

## 附录 D：C0 完成标准（本任务）

- [x] design 已写/修订：`docs/superpowers/specs/2026-07-19-audit-integrity-dual-write-coordinator-design.md`
- [x] plan 已写/修订：`docs/superpowers/plans/2026-07-19-audit-integrity-dual-write-coordinator.md`
- [x] 无源码/测试/README/version/Gold/`package-lock.json` 修改
- [x] 明确当前事实 V1.36；设计 PROCEED ≠ 实现完成；**禁止**写 V1.37 实现完成
- [x] 第一/二次 GLM FAIL + **第三次 GLM PASS（无 P0）** + **fresh Grok PASS/PROCEED YES** 已记录；最终措辞修订关闭非阻断 finding；**PM 验收后 C0 可 commit 并开始 C1**
- [x] journal plan/publish 唯一 SoT；raw 私有化 WeakMap；publish 后**必须核** post；删除 publish(rawPre,recordLine)；禁止复制 digest/link 公式
- [x] lease settle 仅 queue finally；task 无 settle API；recovery 仅 fresh lease（禁 catch re-grant）
- [x] partial recovery = atomic byte image（删除 truncate/ftruncate/reappend）；safeReadBytes 同 fd 二次 fstat
- [x] C1 无 state/gate stub；C2 真实完整 schema/parser/publisher/gate（非 skeleton/write-only）；不拆 commit；C3 bootstrap idle
- [x] prepared+Jpre/Epost conflict；null partial 六态（created-empty 为 events、无 flag）；last* 赋值（C2 锁 lastSequence）；journal-suffix 可达 canary
- [x] 错误码合同 55→60（+5）；retention 互斥策略；ALS lease；bounds 拆分；C3/C4 无 stub 假绿
- [x] gate TOCTOU 分层：C2=占位∥public journal-only；C3/C6=direct∥bootstrap；nested enqueue + nested meta-audit defer；成功 post 关系修正；prepared 不变量；fatal UTF-8
- [x] §3.2 public init/append gate 标 C2+；C1 仅 resolve→queue→plan/publish
- [x] 「V1.35 direct」→ public journal-only (post-C1 plan/publish SoT; no dual-write coordinator)

**C0 commit message（PM 验收后精确 commit；本任务不自动 commit/push）：**

```text
docs: design V1.37 journal-first crash-recoverable audit dual-write coordinator
```
