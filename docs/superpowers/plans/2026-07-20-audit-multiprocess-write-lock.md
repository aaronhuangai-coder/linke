# V1.40 Local Multi-Process Audit Integrity Write Exclusive Lock Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** same-dataDir local multi-process audit integrity **write exclusive lock** via **`/usr/bin/lockf` fd form** (BSD flock), embedded in `enqueueAuditIntegrityWriteTask`. Version **V1.40** only after C1–C4 green. Gold stays **blocked 4/4/1/9**；production-hardening **partial**；T6d.3 **still partial**.

**Signature ceiling:**
`V1.40 local multi-process audit integrity write exclusive lock implementation`

**Narrow OK:** `same-dataDir local multi-process write serialization delivered`

**Not:** T6d.3 complete / M6d Exit / production-hardening ready / Gold ready / distributed·network-FS / fair waiters / unbounded wait / hard-link reclaim / mkdir-owner / ORPHAN_GRACE / e2e delivery / M1·M2 edits

**Design SoT:** `docs/superpowers/specs/2026-07-20-audit-multiprocess-write-lock-design.md`
**Master (cite only):** `docs/superpowers/plans/2026-07-16-linke-v2-gold-cross-lan-release.md`

---

## C0 review record（诚实）

```text
HISTORY P1#1: mkdir-then-owner → REJECTED
HISTORY P1#2: hard-link + rename reclaim TOCTOU → REJECTED
  FORBIDDEN: automatic rename/unlink stale reclaim green path

Historical GLM (hard-link docs): FAIL / PROCEED NO / P0=0 / P1=1 / P2=0

Post-lockf-rewrite GLM-5.2: PASS / PROCEED YES / P0=0 / P1=0 / P2=4

PM disposition of P2s (evidence; not blind follow):
  1. -k / non-blocking conflation → REJECTED factual (man: -k=keep file;
     fd form implies -k; probe non-block was -t 0). Docs split -k vs OFD lifetime.
  2. parent SIGKILL during lockf wait residual child → ACCEPTED
     (≤5s exit; no lease/task; auto-release; no permanent dual-hold).
  3. release-fail-after-success “retry safe / no duplicate” → REJECTED unsafe
     (no idempotency evidence; mutations may complete; still reject; no rollback).
  4. audit-log catch may miss lock error / need process-lock import →
     REJECTED source-factual (server/agent required admission bare catch already
     remaps ALL append failures to AUDIT_DELIVERY_UNAVAILABLE).
     ADD C2 mapping regressions only; NO new audit-log catch; sole importer=queue.

Qwen C0 stats:
  PASS / PROCEED YES
  pre-edit lines: design=455, plan=399, total=854
  constraints / boundary / baseline / whitespace: all PASS
  (stats lines are pre-this-P2-doc-edit; not a protocol change)

fresh Grok C0 closed-loop (independent; re-proved lockf fd/OFD, dual process,
  timeout, parent-SIGKILL-during-wait residual child outside repo):
  PASS / PROCEED YES / P0=0 / P1=0 / P2=3

  Grok P2-1 (plan C0 checklist stale “post-rewrite PENDING only”):
    RESOLVED this doc edit — checklist now records historical GLM FAIL,
    post-lockf GLM PASS + PM dispositions, Qwen PASS, fresh Grok PASS/P2=3;
    PM accept is recorded below after post-fix rechecks.
  Grok P2-2 (plan C0 commit gate “after next GLM PASS”):
    RESOLVED this doc edit — gate now: GLM/Qwen/fresh Grok already PASS;
    commit after these P2 fixes + PM accept; no fictional next GLM required.
  Grok P2-3 (C3 missing explicit residual parent-SIGKILL-during-lockf-wait case):
    RESOLVED this doc edit — C3 multi table requires real independent Node
    parent/holder/contender (not C0 scratch) proving residual lockf child ≤5s
    acquire-or-timeout, zero lease/task, lock auto-releases, contender can acquire.

Post-fix rechecks (before this PM acceptance record was appended):
  Qwen post-P2 stats: PASS / PROCEED YES (design=478 / plan=428 / total=906)
  final fresh Grok: PASS / PROCEED YES / P0=0 / P1=0 / P2=0

PM C0 accept (2026-07-20): PASS / ACCEPTED
  docs-only boundary intact; all prior P2s resolved; proceed commit/push → C1.
```

---

## PM 冻结摘要

```text
SELECTED      = /usr/bin/lockf fd form (async spawn; shell:false)
BINARY        = /usr/bin/lockf
ARGV          = ['-s', '-t', '5', '3']   // timeout 5s; fd 3 inherited
STDIO         = ['ignore','ignore','ignore', fileHandle.fd]
ENV           = Object.create(null)     // exact empty; no parent env inherit
EXIT_0        = then MANDATORY revalidate lstat+fileHandle.stat §attrs; only then success
EXIT_75       = EX_TEMPFAIL timeout → best-effort close → unavailable
OTHER_EXIT    = best-effort close → unavailable
SETTLE        = spawn error+exit single-settle; never double resolve/reject
DASH_K        = man: keep lock *file* not remove; fd form implies -k; NOT non-blocking
OFD_HOLD      = lock after child exit 0 = parent still refs shared OFD (≠ -k magic)
T0            = -t 0 immediate fail (probe/tests only); production argv keeps -t 5
CANONICAL     = audit/integrity-write.lock  permanent regular file
EXISTENCE     = NOT lock; never unlink/rename/truncate/chmod as protocol
ATTRS         = regular; same dev+ino; nlink===1; mode exact 0o600;
                uid===geteuid() when geteuid available
OPEN          = O_CREAT|O_RDWR|O_NOFOLLOW 0600; pre-lockf ATTRS + post-exit-0 ATTRS
RELEASE       = verify handle → close FileHandle; kernel drops flock
RELEASE_HONEST= task may have mutated stores; release fail still rejects; no rollback;
                FORBIDDEN: claim retry idempotent / no-duplicate without evidence
CRASH         = OS closes fd; no PID/owner/reclaim
WAIT_CHILD    = parent SIGKILL during lockf wait: residual child ≤5s exit;
                no lease/task; brief flock ends on child last close
NO            = hard-link, candidate, quarantine, owner JSON, poll, ORPHAN_GRACE,
                process.kill liveness, spawnSync, npm lock deps, node:sqlite, O_EXLOCK product API,
                network-FS auto-detect/fail-closed claim, “optional” post-check,
                new audit-log catch / process-lock import outside write-queue
QUEUE         = FIFO outer → lockf acquire → mint lease → task → expire → close
ACQUIRE_FAIL  = zero task / zero lease
RELEASE_WIN   = release failure always wins
ERROR         = +1 only AUDIT_INTEGRITY_PROCESS_LOCK_UNAVAILABLE (61→62)
GOLD          = 4/4/1/9 unchanged; hardening partial
PACKAGE_LOCK  = never read/modify/stage
PLATFORM_GATE = process.platform !== 'darwin' OR lockf missing/unspawnable → unavailable
FS_CONTRACT   = supported deploy = local macOS APFS/HFS+ only (operator duty);
                network FS OOC — implementation does NOT detect/auto-reject
PROBE         = PM Node v24.14.0 feasibility only; C3 re-proves with real children
```

```text
SELECTED = A lockf fd form
REJECTED = B hard-link + rename reclaim (TOCTOU)
REJECTED = C mkdir-then-owner
REJECTED = D memory Map/ALS only
REJECTED = E third-party/daemon/sqlite/O_EXLOCK-as-API
```

---

## Commit boundaries

| Boundary | Contents | Message |
| --- | --- | --- |
| C0 | two docs only | `docs: design V1.40 audit multi-process write lock` |
| C1 | process-lock + ERROR_CODES + unit | `feat: add fail-closed audit process lock` |
| C2 | queue embed + tests | `feat: guard audit write queue across processes` |
| C3 | real multi-process | `test: prove audit dual-write multi-process exclusion` |
| C4 | scans/honesty/62 | `test: lock V1.40 process-lock wiring and honesty` |
| C5 | version/Gold/README | `chore: release milestone V1.40 audit process lock` |
| C6 | full suite + reviews | fix commits only if needed |

Rules: no C0+code mix; no version before C1–C4 green; no package-lock; no same-process Promise as sole multi-process proof; no stale rename reclaim.

---

## Global commands

```bash
node --test test/error-codes.test.js test/audit-integrity-process-lock.test.js
node --test test/audit-integrity-write-queue.test.js \
  test/audit-integrity-process-lock-queue.test.js
node --test test/audit-integrity-multiprocess-lock.test.js
node --test test/audit-integrity-process-lock-scans.test.js test/error-codes.test.js
node --test test/version.test.js test/gold-readiness.test.js test/readme.test.js
npm test
```

Expected after C1: ERROR_CODES length **62**.

---

## Task 0 — Baseline（只读）

- [ ] Confirm HEAD e05e2d9 系；V1.39；ERROR_CODES 61
- [ ] Confirm enqueue production importers = journal + dual-write only
- [ ] Confirm no process-lock / hard-link reclaim / ORPHAN_GRACE in src

```bash
git rev-parse --short HEAD
node -e "import { ERROR_CODES } from './src/error-codes.js'; import { LINKE_RELEASE_VERSION } from './src/version.js'; console.log(LINKE_RELEASE_VERSION, Object.keys(ERROR_CODES).length)"
rg -n "enqueueAuditIntegrityWriteTask|audit-integrity-process-lock|lockf" src --glob '*.js' || true
```

**Do not read package-lock.json.**

---

## C0 — Docs only

**Files:** these two paths only.

- [x] Design + plan select lockf fd form; P1#1 and P1#2 in HISTORY/REJECTED
- [x] C0 review status recorded accurately (not forged):
  - historical hard-link GLM: FAIL / PROCEED NO / P0=0 / P1=1 / P2=0
  - post-lockf GLM-5.2: PASS / PROCEED YES / P0=0 / P1=0 / P2=4 + PM dispositions applied
  - Qwen C0 stats: PASS / PROCEED YES (pre-edit lines design=455 / plan=399 / total=854)
  - fresh Grok C0: PASS / PROCEED YES / P0=0 / P1=0 / P2=3（本轮 P2 修订已 resolved）
  - post-fix Qwen: PASS / PROCEED YES (design=478 / plan=428 / total=906)
  - final fresh Grok: PASS / PROCEED YES / P0=0 / P1=0 / P2=0
  - PM C0 accept: PASS / ACCEPTED（2026-07-20）
- [x] Whitespace:

```bash
git status --short
git diff --check --no-index /dev/null \
  docs/superpowers/specs/2026-07-20-audit-multiprocess-write-lock-design.md 2>&1 \
  | rg "trailing whitespace" || true
git diff --check --no-index /dev/null \
  docs/superpowers/plans/2026-07-20-audit-multiprocess-write-lock.md 2>&1 \
  | rg "trailing whitespace" || true
```

- [ ] PM commit **after** these Grok P2 doc fixes **and** PM accept
  （current fact: post-lockf GLM + Qwen + fresh Grok already PASS;
  **no** fictional “next GLM” required; not this step alone）:

```bash
git add \
  docs/superpowers/specs/2026-07-20-audit-multiprocess-write-lock-design.md \
  docs/superpowers/plans/2026-07-20-audit-multiprocess-write-lock.md
# git commit -m "docs: design V1.40 audit multi-process write lock"
```

---

## C1 — Module + error code + unit

**Files:**

- Create `src/audit-integrity-process-lock.js`
- Modify `src/error-codes.js` (+1 only)
- Modify `test/error-codes.test.js` (62)
- Create `test/audit-integrity-process-lock.test.js`

**Forbidden:** queue embed yet; hard-link/mkdir reclaim; npm deps; package-lock; spawnSync as production acquire.

### C1.1 ERROR_CODES

- [ ] RED then GREEN: length 62; only
  `AUDIT_INTEGRITY_PROCESS_LOCK_UNAVAILABLE: 'audit-integrity-process-lock-unavailable'`

### C1.2 Implementation sketch

```js
// production acquire (conceptual)
if (process.platform !== 'darwin') throw unavailable;
const fh = await open(canonicalAbs, flagsO_CREAT|O_RDWR|O_NOFOLLOW, 0o600);
// PRE: fileHandle.stat + lstat → regular, same dev+ino, nlink===1, mode 0o600, euid
const child = spawn('/usr/bin/lockf', ['-s', '-t', '5', '3'], {
  shell: false,
  stdio: ['ignore', 'ignore', 'ignore', fh.fd],
  env: Object.create(null),
});
// single-settle on error|exit; non-0 → best-effort close + unavailable
// exit 0 → MANDATORY re-lstat + fh.stat same ATTRS; fail → close + unavailable
// success → keep fh open as handle
```

Exports (suggested):

```js
export const AUDIT_INTEGRITY_PROCESS_LOCK_REL = 'audit/integrity-write.lock';
export const AUDIT_INTEGRITY_PROCESS_LOCK_TIMEOUT_SECONDS = 5;
export class AuditIntegrityProcessLockError extends Error {}
export async function acquireAuditIntegrityProcessLock(resolvedRoot, options = {}) {}
export async function releaseAuditIntegrityProcessLock(handle) {}
```

`options.deps` for tests: `spawn`, `open`, `lstat`, `filehandle.stat`, platform hooks — **test only**.

### C1.3 Unit / injection tests（必须）

| Case | Expect |
| --- | --- |
| spawn argv | exact `['-s','-t','5','3']` |
| binary | absolute `/usr/bin/lockf` |
| shell | `false` |
| env | `Object.create(null)` / empty; **no** parent credential env keys inherited |
| stdio[3] | parent fd |
| exit 0 + attrs OK | handle returned; fd not closed by acquire |
| exit 0 + post attrs fail | unavailable; fd closed; **no** success handle |
| exit 75 | unavailable; fd closed |
| other exit / spawn error / signal | unavailable; fd closed; single-settle |
| error then exit (or reverse) | exactly one rejection; no double settle |
| errors | path-free; no secret/path leak |
| symlink / non-regular / ino mismatch | unavailable; path not deleted/chmod/renamed |
| nlink ≠ 1 | unavailable; no repair |
| mode ≠ 0o600 | unavailable; no chmod repair |
| uid ≠ geteuid (when applicable) | unavailable |
| non-darwin platform gate | unavailable |
| release | closes handle; second release fail-closed |
| release close throws | failure always wins |
| missing lockf binary | unavailable |
```bash
node --test test/audit-integrity-process-lock.test.js test/error-codes.test.js
```

- [ ] Commit: `feat: add fail-closed audit process lock`

---

## C2 — Queue integration

**Files:** `src/audit-integrity-write-queue.js` + `test/audit-integrity-process-lock-queue.test.js` (+ queue regression tests)

Order in running task:

```text
acquire → mint lease → ALS task → finally expire lease → finally release(close)
```

| Case | Expect |
| --- | --- |
| acquire fail | task never called |
| release fail after task success | reject; mutations may already exist; **no** “retry safe/no duplicate” claim |
| FIFO | ordered; no overlapping lock holds same process |
| nested same/cross root | fail-closed SafeDataFileError |
| poison | next task still acquires |

### C2.2 Admission mapping regressions（**不**改 audit-log / **不** import process-lock）

Source fact (V1.39): required helpers already bare-`catch` **all** `appendAuditEvent` failures and remap:

- `server.js::recordRequiredWriteAdmissionAudit` → HTTP **503** + `audit-delivery-unavailable`
- `agent.js::recordRequiredNasReplicationStartAudit` → fixed stderr/exit **1** + same code
- best-effort `recordAudit` / `appendNasReplicationAudit` remain swallow

Therefore C2:

- [ ] **MUST NOT** add audit-log catch layers or process-lock imports outside write-queue
- [ ] **MUST** test: inject/trigger process-lock unavailable on append path →
  required server write route still **503** + fixed code; mutation not applied
- [ ] **MUST** test: same inject on NAS execute required start → fixed stderr + exit 1; SMB not called
- [ ] **MUST** confirm best-effort paths still swallow (not e2e)
- [ ] sole production process-lock importer remains **write-queue only**

```bash
node --test test/audit-integrity-write-queue.test.js \
  test/audit-integrity-process-lock-queue.test.js \
  test/server-write-admission.test.js \
  test/agent-nas-snapshot-replicate.test.js
```

- [ ] Also regression dual-write/journal tests green
- [ ] Commit: `feat: guard audit write queue across processes`

---

## C3 — Real multi-process（禁止同进程假冒）

**Files:** `test/audit-integrity-multiprocess-lock.test.js` (+ optional worker helper)

| Case | Expect |
| --- | --- |
| 2 real **Node** children | mutual exclusion on same dataDir（re-prove fd hold after lockf child exit; not C0 probe alone） |
| 8 (or 16) barrier append | events/journal/state consistent |
| holder SIGKILL | contender acquires **without** manual delete; lock **file still exists** |
| **parent SIGKILL during lockf wait** | real independent **Node** parent (spawning lockf wait) + holder + contender — **not** C0 scratch/probe as sole proof. Parent is SIGKILL'd while its lockf child is still waiting. Residual lockf child: at most **5s** either acquires then exits, or times out and exits. **Zero lease / zero task** minted for that dead parent path. After residual exit, lock auto-releases; contender can acquire without manual delete. |
| timeout | contender maps unavailable when holder holds through `-t 5` window (or test deps shorter timeout **test-only**) |
| inode permanence | file remains across release; nlink stays 1 under protocol |
| prepared + SIGKILL | kernel frees flock; **existing** dual-write recovery succeeds (no state wipe) |

```bash
node --test test/audit-integrity-multiprocess-lock.test.js
```

- [ ] Commit: `test: prove audit dual-write multi-process exclusion`

---

## C4 — Scans / honesty

**File:** `test/audit-integrity-process-lock-scans.test.js`

- [ ] sole production import of process-lock = `audit-integrity-write-queue.js`
- [ ] production source contains `/usr/bin/lockf` and spawn argv shape
- [ ] production uses `Object.create(null)` (or exact empty env) for lockf spawn
- [ ] mandatory post-exit-0 `lstat` + handle `stat` revalidation present (not optional comments)
- [ ] attr gates include nlink===1, mode 0o600, euid when available
- [ ] **no** selected-path hard-link reclaim / `ORPHAN_GRACE` / mkdir-as-lock / owner JSON reclaim
- [ ] honesty: **no** claim that network FS is auto-detected fail-closed
- [ ] queue orders acquire before lease mint
- [ ] ERROR_CODES 62
- [ ] honesty: no T6d.3 complete / M6d Exit / production-hardening ready / e2e as delivered

```bash
node --test test/audit-integrity-process-lock-scans.test.js test/error-codes.test.js
```

- [ ] Commit: `test: lock V1.40 process-lock wiring and honesty`

---

## C5 — Version / Gold / README

- [ ] `LINKE_RELEASE_VERSION = 'V1.40'`
- [ ] gold `production-hardening` evidence/nextStep only；status **partial**；counts **4/4/1/9**
- [ ] README timeline + concurrency: lockf local multi-process serialization delivered; not distributed/network-FS

```bash
node --test test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

- [ ] Commit: `chore: release milestone V1.40 audit process lock`

---

## C6 — Full suite

- [ ] `npm test` green
- [ ] GLM + Qwen + fresh Grok on **implementation**（separate from C0; C0 multi-model + PM already PASS/ACCEPTED）
- [ ] No package-lock staged

---

## 失败映射

| Layer | Code |
| --- | --- |
| process-lock | `audit-integrity-process-lock-unavailable` |
| queue arg/nested | `safe-data-file-error` |
| admission append fail (incl lock) | `audit-delivery-unavailable` |
| best-effort audit | swallowed（not e2e） |

---

## DoD

- [ ] lockf fd form only selected path
- [ ] no rename/unlink stale reclaim green path
- [ ] real multi-process proofs
- [ ] ERROR_CODES 62
- [ ] Gold 4/4/1/9; hardening partial
- [ ] signature ceiling only
- [ ] package-lock untouched

---

## 修订记录

| 日期 | 说明 |
| --- | --- |
| 2026-07-20 | mkdir plan（P1#1 否决） |
| 2026-07-20 | hard-link plan（P1#2 TOCTOU；GLM FAIL） |
| 2026-07-20 | **lockf fd form plan**；C1 inject + C3 real processes |
| 2026-07-20 | PM pre-GLM tighten plan cases: post-revalidate, attrs, empty env, single-settle, FS OOC honesty |
| 2026-07-20 | Post-lockf GLM PASS P2 dispositions: -k/OFD split; child-wait; release honesty; C2 admission mapping regressions; Qwen/fresh Grok/PM PENDING |
| 2026-07-20 | Qwen C0 PASS/PROCEED YES (stats pre-edit 455/399/854); fresh Grok C0 PASS/PROCEED YES P0=0/P1=0/P2=3; resolve Grok P2s (C0 checklist + commit gate wording; C3 residual parent-SIGKILL-during-wait real multi-process case) |
| 2026-07-20 | Post-P2 Qwen PASS (478/428/906); final fresh Grok PASS P0=0/P1=0/P2=0; PM C0 PASS/ACCEPTED; PM-record final lines 487/435/922; proceed commit/push → C1 |
