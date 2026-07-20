# V1.40 Local Multi-Process Audit Integrity Write Exclusive Lock Design

## 目标

V1.40 在 **V1.39 pre-side-effect write-admission fail-closed** 之上，交付 **M6d / T6d.3 still partial** 真增量：

- **同一台 macOS、同一 resolved `dataDir`** 上，多 Node 进程对 audit integrity **写路径** 的 **单写者排他锁**
- 协议：**系统自带** `/usr/bin/lockf` 的 **file-descriptor form**（BSD flock on shared open file description）
- 嵌入点：唯一在 `enqueueAuditIntegrityWriteTask` 内层——running task 在 mint ALS lease 前 acquire；task settle 后 expire lease，再 close fd 释放锁

> **签字上限（唯一完成宣称）：**
> `V1.40 local multi-process audit integrity write exclusive lock implementation`
>
> **允许窄句：** `same-dataDir local multi-process write serialization delivered`
>
> **不是：** T6d.3 complete / M6d Exit / production-hardening ready / Gold ready / distributed·cross-host·network-FS lock / fair·FIFO OS waiters / unbounded wait / journal rotation / authenticity·HMAC·signature·anchor·WORM / monitor lock-awareness product feature / e2e audit delivery / 修改 M1·M2

| Master（只引用） | V1.40 |
| --- | --- |
| M6d production-hardening | **仍 partial** |
| T6d.3 | **still partial**（本增量 only） |
| T6d.4 monitor | 10-key / exit 0-1-2 / zero-write **不变** |
| M6d Exit / Gold | **否**；Gold **blocked 4/4/1/9** |
| M1 / M2 | **不得改** |

**能力冻结：**

```text
ALLOWED: local multi-process write exclusive lock via /usr/bin/lockf fd form
         same-dataDir local multi-process write serialization delivered
         write-queue embedding (lease mint only while process lock held)

FORBIDDEN as delivered:
  T6d.3 complete | M6d Exit | production-hardening ready | Gold ready
  distributed/cross-host/network-FS lock | fair OS lock | unbounded wait
  hard-link reclaim | mkdir-then-owner | ORPHAN_GRACE | owner JSON reclaim
  automatic rename/unlink of “stale” lock as reclaim green path
```

**角色：** 本阶段 **仅 docs（C0）** ≠ 实现完成。基线 **V1.39** @ `e05e2d9`，ERROR_CODES **61**。

---

## C0 review record（诚实；禁止伪造 PASS）

```text
HISTORY P1#1 (mkdir-then-owner): REJECTED
  ownerless/incomplete window; ORPHAN_GRACE unsafe steal.

HISTORY P1#2 (hard-link + rename reclaim): REJECTED (blocking)
  inspect→rename TOCTOU dual-hold; rename is not inode/token CAS.

Historical GLM (hard-link docs round):
  FAIL / PROCEED NO / P0=0 / P1=1 / P2=0
  → protocol replaced by /usr/bin/lockf fd form.

Post-lockf-rewrite GLM-5.2:
  PASS / PROCEED YES / P0=0 / P1=0 / P2=4

PM disposition of post-lockf P2s (evidence-based; not blind follow):
  P2-1 “-k means non-blocking contender / lock magic”:
    REJECTED as factually wrong on this macOS man lockf.
    -k = keep lock *file* (not remove) after command; fd form implies -k.
    Non-blocking probe contender used -t 0 (immediate fail), not -k.
    Docs: separate (a) -k keep-file from (b) OFD flock lifetime via parent fd.
  P2-2 child-wait lifecycle if parent SIGKILL during lockf wait:
    ACCEPTED — residual child ≤5s acquire-or-timeout; no lease/task;
    brief acquire auto-releases on child exit/last fd close; no permanent dual-hold.
  P2-3 “release fail after task success ⇒ retry safe / no duplicate event”:
    REJECTED unsafe claim — no idempotency/dedup evidence.
    Docs: mutations may have completed; release still rejects; no rollback;
    do NOT claim caller retry is idempotent or duplicate-free.
  P2-4 “audit-log catch may miss new lock error / need catch or process-lock import”:
    REJECTED as source-factually wrong.
    server recordRequiredWriteAdmissionAudit: bare catch → always 503 AUDIT_DELIVERY_UNAVAILABLE
    agent recordRequiredNasReplicationStartAudit: bare catch → always AUDIT_DELIVERY_UNAVAILABLE / exit1
    best-effort paths already catch-all.
    C2 MUST NOT add audit-log catch or process-lock import.
    C2 MUST add mapping regressions: inject process-lock unavailable →
      required admission still 503 fixed code; NAS CLI still fixed stderr/exit1;
      best-effort unchanged; sole importer remains write-queue.

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
    RESOLVED this doc edit — C3 multi table + design multi matrix require real
    independent Node parent/holder/contender (not C0 scratch) proving residual
    lockf child ≤5s acquire-or-timeout, zero lease/task, lock auto-releases,
    contender can acquire.

Post-fix rechecks (before this PM acceptance record was appended):
  Qwen post-P2 stats: PASS / PROCEED YES
    design=478, plan=428, total=906; dates/status/protocol/boundary/whitespace PASS.
  final fresh Grok confirmation: PASS / PROCEED YES / P0=0 / P1=0 / P2=0
    all three prior Grok P2s resolved; no protocol or boundary regression.

PM C0 accept (2026-07-20): PASS / ACCEPTED
  docs-only boundary intact; lockf fd/OFD protocol is implementable;
  GLM/Qwen/fresh Grok gates passed; historical P1 paths remain rejected;
  PROCEED to C0 commit/push, then C1 TDD implementation.
```

---

## 1. 现状事实（V1.39）

| 项 | 事实 |
| --- | --- |
| HEAD | `e05e2d9`；version **V1.39**；ERROR_CODES **61** |
| Write queue | same-process FIFO Map + ALS lease；**无**跨进程互斥 |
| Production enqueue importers | `audit-integrity-journal.js` + `audit-integrity-dual-write.js` only |
| dual-write-state | assert lease only |
| dual-write inspect / monitor | inspect 经 enqueue 取 lease；monitor zero-write；10-key 冻结 |
| Admission (V1.39) | append 失败 → `audit-delivery-unavailable`；post-outcome 仍 best-effort |

**嵌入覆盖面：** process lock 包在 queue running task 内 → journal/dual-write bootstrap·recover·append·inspect 与全部 unlocked mutator 经 lease 自动继承跨进程保护。**禁止** call-site 散布 lock 调用。

### 1.1 Inspector / queue 技术裁决（保留）

- monitor/inspector **zero-write**；不增 lock status 键；exit 0-1-2 / 10-key **不变**
- inspect 经 `enqueueAuditIntegrityWriteTask` → 将 **短暂 hold** process lock（共享 queue 副作用，**不是** lock-aware monitor 产品特性）
- acquire 失败：零 task / 零 lease；monitor 走既有 throw→exit1
- 崩溃遗留 prepared 仍可观察；live mid-write 由 lock 串行，非无锁 peek

---

## 2. 方案比较

| | **A 选定** `/usr/bin/lockf` fd form | **B 拒绝** hard-link + rename reclaim | **C 拒绝** mkdir-then-owner | **D 拒绝** 内存 Map/ALS only | **E 拒绝** flock npm / daemon / node:sqlite |
| --- | --- | --- | --- | --- | --- |
| 跨进程互斥 | 是（local macOS） | 意图是 | 意图是 | 否 | 是（代价/面过大） |
| reclaim 安全 | **内核在 last close 释放**；无 path reclaim | **P1 TOCTOU** | **P1 incomplete+grace steal** | N/A | 视实现 |
| 新依赖 | **无**（系统 lockf） | 无 | 无 | 无 | 有或部署面大 |
| event loop | async spawn；非 spawnSync | N/A | N/A | N/A | 视实现 |

```text
SELECTED = A  /usr/bin/lockf file-descriptor form (BSD flock)
REJECTED = B  hard-link publish + inspect→rename dead reclaim (TOCTOU dual-hold)
REJECTED = C  mkdir lock-dir then owner.json (ownerless window + grace steal)
REJECTED = D  memory Map/ALS only
REJECTED = E  third-party lock libs / external daemon / node:sqlite / hardcoded O_EXLOCK path as product API
```

**历史两次 P1（必须保留为 HISTORY，不得再当选定绿路径）：**

1. **mkdir-then-owner** — incomplete/ownerless 窗口；`ORPHAN_GRACE` 无法证明 holder 已死
2. **hard-link + rename reclaim** — first-visible complete 成立，但 path rename **非** CAS → dual holders

**禁止：** 任何自动 `rename`/`unlink` “stale” reclaim 作为绿路径（含“降级 P2”）。

---

## 3. 选定协议：`/usr/bin/lockf` fd form

### 3.1 Scope（诚实；无虚假 “network FS 自动拒绝”）

```text
IMPLEMENTED fail-closed gates (only these auto-detect in V1.40):
  - process.platform !== 'darwin' → LOCK_UNAVAILABLE
  - /usr/bin/lockf missing OR cannot spawn → LOCK_UNAVAILABLE

SUPPORTED DEPLOYMENT CONTRACT (not auto-detected):
  - local macOS APFS or HFS+ only
  - same resolved dataDir (assertSafeDataRoot result)
  - absolute binary /usr/bin/lockf; shell:false
  - operator MUST place dataDir on local disk

OUT OF CONTRACT (no promise to detect or auto-reject):
  - network FS / NFS / SMB / AFP / cross-host / distributed dataDir
  - This C0 does NOT introduce FS-type allowlist via statfs/diskutil/node
    bindings. Future auto-reject of network FS = separate increment.
  - MUST NOT claim “network FS → fail-closed detection” as delivered.

Threat honesty (unchanged safe-data boundary; not expanded):
  - Does NOT resist same-privilege active adversary racing parent dir /
    lock path replacement. Fail-closed when local checks detect
    symlink / non-regular / attribute mismatch. Not authenticity / WORM.
```

### 3.2 Canonical lock file + mandatory security attributes

```text
relative path:  audit/integrity-write.lock
type:           permanent regular file
create mode:    0o600 (O_CREAT)
existence:      NOT the lock
content:        no owner JSON protocol; no required payload
after release:  file REMAINS (never unlink/rename/truncate as lock protocol)
after crash:    file REMAINS; kernel drops flock when last fd closes
hard links:     protocol NEVER creates additional hard links to canonical
                → frozen nlink === 1 (no conflict with selected lockf path)

Mandatory attribute checks (fstat AND matching lstat where applicable):
  - is regular file (not symlink/dir/FIFO/…)
  - lstat.dev === fstat.dev AND lstat.ino === fstat.ino
  - nlink === 1
  - permission bits exact 0o600
    (compare st_mode & 0o777 === 0o600; exact user r/w only)
  - when process.geteuid is available: st_uid === process.geteuid()
    (if geteuid unavailable in env: fail-closed unavailable — darwin Node has it)

On any attribute failure:
  - close fd if open
  - throw LOCK_UNAVAILABLE
  - DO NOT chmod, unlink, rename, or “repair” hostile/unexpected inode
```

准备：`ensureSafeRelativeDir(resolvedRoot, 'audit')`，再 open/create canonical。

### 3.3 Acquire

```text
0. if process.platform !== 'darwin' → LOCK_UNAVAILABLE
1. assert queue-safe resolvedRoot
2. ensureSafeRelativeDir(..., 'audit')
3. open canonical with O_CREAT|O_RDWR|O_NOFOLLOW, mode 0o600
   (Node fs.open / fs.promises.open flags equivalent)
4. PRE-lockf attribute gate on open handle + path:
   fileHandle.stat() + lstat(canonical) must satisfy §3.2
   (regular, same dev+ino, nlink===1, mode 0o600, euid owner when geteuid exists)
   fail → best-effort close + LOCK_UNAVAILABLE (do not delete path)
5. async spawn single-settle waiter:
     command: '/usr/bin/lockf'   // absolute only
     args:    ['-s', '-t', '5', '3']
     options: {
       shell: false,
       stdio: ['ignore', 'ignore', 'ignore', fileHandle.fd],
       // fd 3 in child = inherited open file description
       env: Object.create(null)   // exact empty env; NO parent env inheritance
     }
   - NOT spawnSync (must not block service event loop)
   - fd form: NO path command keeper; no trailing utility command
   - man: fd form implies -k → keep/not remove the lock *file* after command
     (NOT “non-blocking”; NOT the reason the lock survives child exit)
   - child lifecycle / single-settle: see §3.3.1
   - argv remains ['-s','-t','5','3'] unchanged
6. on child terminal failure (exit!==0, signal, spawn error):
   best-effort close fd → LOCK_UNAVAILABLE
7. on child exit status 0 ONLY:
   MANDATORY post-lockf re-validation (NOT optional):
     a) pathL = lstat(canonical)
     b) fdS  = fileHandle.stat()   // same open handle; do not re-open for this check
     c) both must pass §3.2 (regular, same dev+ino each other, nlink===1,
        mode 0o600, euid owner when geteuid exists)
     d) any mismatch / IO → best-effort close + LOCK_UNAVAILABLE
        → zero lease / zero task (caller never sees success handle)
   pass → return in-memory handle { resolvedRoot, fileHandle, identity }
```

**固定超时：** CLI `-t 5` = **5 秒**（5000ms 语义）。`-t 0` = 立即失败/非阻塞（仅 probe/test 语境）。**无** poll 循环、**无** PID liveness、**无** owner schema。

#### 3.3.1 `-k` vs OFD flock lifetime（必须分开写）

```text
Fact A — man lockf on this macOS:
  -k causes the lock *file* to be kept (not removed) after command completes.
  File-descriptor form implies -k (keep file; do not remove path on command end).
  -k is NOT “immediate non-blocking acquire”.
  Immediate fail / non-blocking is -t 0.

Fact B — why lock continues after lockf child exit 0:
  BSD flock is held on the shared open file description (OFD) created by
  parent open and inherited (fork/dup) into the child.
  After child exits, parent FileHandle still references that OFD → lock remains.
  This is OFD reference lifetime — not “-k magic”.

Do not conflate A and B in docs, tests, or reviews.
```

#### 3.3.2 Child lifecycle + single-settle（强制）

```text
While parent awaits lockf child:
  - Parent SIGKILL closes parent fd.
  - Residual lockf child: at most ~5s (-t 5) either acquires then exits, or
    times out and exits. It does NOT mint ALS lease and does NOT run queue task.
  - If residual child briefly holds flock before exit: last close of its fd
    releases; no permanent dual-hold with a dead parent; no lease-backed critical section.
  - After successful child exit 0 path in live parent: ONLY parent FileHandle
    keeps the lock (Fact B above).

Promise settlement for spawn:
  - attach both 'error' and 'exit' (or equivalent)
  - MUST single-settle: at most one resolve/reject path wins
  - after first settle, ignore subsequent error/exit
  - every failure path: best-effort close of parent FileHandle
  - never double-resolve success + failure
```

### 3.4 Release

```text
1. verify handle still active for this resolvedRoot / identity (in-process only)
2. close FileHandle (or fd)
3. kernel releases BSD flock when last reference to OFD closes
4. DO NOT unlink/rename/truncate/chmod lock file
5. close failure → throw LOCK_UNAVAILABLE
6. release failure always wins (covers task success and task failure)
7. double-release: in-memory identity only; never disk token

Honesty when release fails after task body already settled successfully:
  - audit / dual-write / journal mutations MAY already have completed
  - caller Promise still rejects with LOCK_UNAVAILABLE (or mapped admission code)
  - NO rollback of completed mutations
  - MUST NOT claim caller retry is idempotent / “safe” / “no duplicate event”
  - no dedup / exactly-once evidence in this milestone
```

### 3.5 Crash

```text
SIGKILL / process death → OS closes fds → flock released automatically.
No owner record, no process.kill(pid,0), no reclaim rename, no quarantine.
Contender’s next lockf may succeed without manual file deletion.
Lock file path remains on disk (existence still not a lock).
```
### 3.6 lockf man 合同（诚实摘录义务）

实现与测试必须按 man 语义对齐（macOS lockf）：

| 事实 | 合同 |
| --- | --- |
| Lock type | exclusive **BSD flock** style via lockf |
| Mere existence of lock file | **not** a held lock |
| `-k` | keep lock **file** (not remove) after command；fd form implies `-k` |
| Lock after child exit | **OFD** still referenced by parent fd（≠ `-k` magic） |
| `-t 0` | immediate fail / non-blocking |
| Never breaks held lock | timeout 不会强拆他人锁 |
| Timeout without command | fd form 无 command 可执行；`-t 5` 超时 → EX_TEMPFAIL |
| EX_TEMPFAIL | **75** |
| Invocation | absolute `/usr/bin/lockf`；**shell: false**；argv `['-s','-t','5','3']` |

### 3.7 模块边界

```text
src/audit-integrity-process-lock.js   NEW — acquire/release via lockf fd form
src/audit-integrity-write-queue.js    ONLY production importer of process-lock
src/error-codes.js                    +1 only (61→62)

NOT importers: journal, dual-write*, monitor, server, agent
```

### 3.8 Queue 时序（外/内层）

```text
outer (same process): FIFO Map chain; nested enqueue guard unchanged
inner (each running task):
  acquire (async lockf) → mint lease → ALS.run(task)
  → finally expire lease → finally close fd (release)
  acquire fail ⇒ zero task, zero lease
  poison isolation / observer 合同保持
```

### 3.9 错误码

```js
// ERROR_CODES 61 → 62; only this addition
AUDIT_INTEGRITY_PROCESS_LOCK_UNAVAILABLE: 'audit-integrity-process-lock-unavailable'
```

path-free registered error（专用 class 或 LinkeError）。禁止 path/secret 进入 message。

| 场景 | 码 |
| --- | --- |
| lockf timeout 75 / spawn fail / non-zero / signal | `audit-integrity-process-lock-unavailable` |
| open / pre or post attribute fail (symlink/non-regular/dev+ino/nlink/mode/uid) | 同上 |
| non-darwin platform / lockf binary unavailable | 同上 |
| release close fail / double-release misuse | 同上 |
| V1.39 required admission 路径上的 append 失败（含 lock） | **`audit-delivery-unavailable`**（保持映射） |

---

## 4. C0 可行性探测（PM 本机；≠ C1/C3 验收）

**环境：** Node **v24.14.0**（PM 报告）。**C0 feasibility probe only** — 证明 **当前** macOS/Node 环境下 “child exit 后 parent fd 维持锁”。

```text
Probe (manual / scratch):
  1) Node opens canonical fd; spawn lockf -s -t 0 3 with fd inherited as 3
     → child exit 0 (lock acquired on OFD; parent keeps fd)
  2) While parent keeps fd open, independent path contender:
     lockf -s -t 0 -k <path> /usr/bin/true → exit 75
     Causal note: non-blocking fail is from **-t 0**, not from -k.
     -k here only keeps the path file per man (fd form also implies -k).
  3) Parent closes fd; independent contender → exit 0
     Causal note: release is OFD last-close, not “clearing -k”.

Exact boundary (MUST keep honest):
  - Proves OFD hold after child exit on PM’s current macOS + Node v24.14.0
  - Does NOT expand to a cross-version / cross-FS guarantee
  - Does NOT replace C1 unit/integration
  - C3 MUST re-prove mutual exclusion + hold-after-child-exit with real
    independent Node child processes (not this probe alone)
```

---

## 5. 威胁与非目标

**In scope：** 两进程写互斥（local darwin + lockf）；holder 崩溃自动释锁；timeout fail-closed；attribute/symlink mismatch fail-closed；queue 唯一嵌入；mandatory post-exit-0 revalidation。

**Out of scope：** distributed；**network FS correctness or detection**；fair waiters；authenticity；journal rotation；e2e delivery；M6d Exit；Gold ready；抵抗同权限恶意换路径；path-based stale reclaim；statfs allowlist。

---

## 6. 测试矩阵（设计级；细节见 plan）

| 层 | 必须 |
| --- | --- |
| unit | inject spawn/open/close；argv=`['-s','-t','5','3']`；binary absolute；shell false；`env` is empty object (`Object.create(null)` / no inherited credentials)；exit 0/75/other；close on fail；single-settle error+exit |
| unit | pre-lockf + **mandatory post-exit-0** revalidation: regular, same dev+ino, nlink===1, mode 0o600, euid owner |
| unit | symlink / non-regular / ino mismatch / nlink≠1 / mode≠0600 / wrong uid → unavailable；**no** chmod/unlink/rename repair |
| unit | release close failure always wins；double-release fail-closed |
| multi | real 2 / 8+ Node processes（**禁止**同进程 Promise 冒充） |
| multi | holder SIGKILL → contender acquires without manual delete；lock file remains；fd-lifetime hold after lockf child exit |
| multi | **parent SIGKILL while lockf child is waiting**（real independent Node parent / holder / contender；**not** C0 scratch）：residual lockf child ≤5s acquire-or-timeout then exit；zero lease / zero task；lock auto-releases；contender can acquire |
| multi | real append → events/journal/state 一致；prepared recovery 既有 dual-write（不删 state 假绿） |
| queue | FIFO / nested / poison；acquire fail zero task/lease |
| scans | sole importer = write-queue；`/usr/bin/lockf`；`Object.create(null)` env；mandatory post-check present；no hard-link reclaim / mkdir-owner / ORPHAN_GRACE；no false “network FS auto fail-closed” claim；ERROR_CODES 62 |

---

## 7. Gold / package-lock / master

```text
C5 only: version V1.40; production-hardening evidence/nextStep text only
statuses/flags: UNCHANGED 4 ready / 4 partial / 1 blocked / total 9
package-lock: never read / modify / stage
master plan 2026-07-16 + M1/M2: cite only; never edit
```

---

## 8. Boundaries（C0–C6）

| | 内容 | commit message（实现后 PM） |
| --- | --- | --- |
| C0 | 本 design + plan only | `docs: design V1.40 audit multi-process write lock` |
| C1 | process-lock + ERROR_CODES + unit | `feat: add fail-closed audit process lock` |
| C2 | queue embed + integration | `feat: guard audit write queue across processes` |
| C3 | real multi-process | `test: prove audit dual-write multi-process exclusion` |
| C4 | scans/honesty/62 | `test: lock V1.40 process-lock wiring and honesty` |
| C5 | version/Gold/README | `chore: release milestone V1.40 audit process lock` |
| C6 | full suite + multi-model | fix commits only if needed |

---

## 9. 删除的旧协议（不得再出现为选定算法）

```text
FORBIDDEN as selected (HISTORY/REJECTED only):
  - hard-link candidate publish / fs.link canonical
  - owner.json schema v1 / token / processStartId / candidate files
  - quarantine rename reclaim / multi-reclaimer rename winner
  - mkdir lock-directory / ORPHAN_GRACE_MS / poll loops
  - process.kill liveness / dead-owner path steal
  - OWNER_MAX_BYTES / WAIT poll constants as lock protocol
```

---

## 10. 修订记录

| 日期 | 说明 |
| --- | --- |
| 2026-07-20 | 初稿 mkdir-then-owner（P1#1 否决） |
| 2026-07-20 | 改 hard-link+rename（P1#2 TOCTOU；GLM FAIL P1=1） |
| 2026-07-20 | **重写选定 `/usr/bin/lockf` fd form**；删除 reclaim/path CAS |
| 2026-07-20 | PM pre-GLM tighten: mandatory post-exit-0 revalidation; nlink/mode/euid; honest network-FS OOC; env Object.create(null); single-settle; probe≠cross-version |
| 2026-07-20 | Post-lockf GLM PASS/PROCEED YES P2=4; PM dispositions applied (-k/OFD split; child-wait; release honesty; admission mapping regressions); Qwen/fresh Grok/PM still PENDING |
| 2026-07-20 | Qwen C0 PASS/PROCEED YES (stats pre-edit design=455/plan=399/total=854); fresh Grok C0 PASS/PROCEED YES P0=0/P1=0/P2=3; resolve Grok P2s (checklist/commit-gate wording; C3 residual parent-SIGKILL-during-wait case) |
| 2026-07-20 | Post-P2 Qwen PASS (478/428/906); final fresh Grok PASS P0=0/P1=0/P2=0; PM C0 PASS/ACCEPTED; PM-record final lines 487/435/922; proceed commit/push → C1 |
