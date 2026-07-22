# Linke V1.41 G0b — Resumable Snapshot Upload Implementation Plan

> 可执行 TDD 清单。步骤用 checkbox（`- [ ]`）跟踪。实现由 **CLI worker**（Grok/GLM/Qwen 等）按任务推进；**不使用**协作 subagent 模板。外部多模型审查与 **PM** 门禁决定是否进入下一 C 与是否 commit/push。

| 字段 | 值 |
| --- | --- |
| 文档类型 | 可执行 TDD 实施计划 — **PLAN ONLY / C0** |
| 关联 design | `docs/superpowers/specs/2026-07-22-linke-v141-g0b-resumable-snapshot-upload-design.md` |
| 基线 HEAD | `4064cd14b3c3ca9c1b26b9b515f9714cf82c7b2a` |
| 基线工作区 | 仅 `?? package-lock.json` — **绝对禁止**读取/修改/暂存 |
| 上游路线图 | G0a → **G0b** → G0c；完成信号 = 断连恢复、损坏拒绝、跨设备越权、真实 LAN 上传 |
| G0a 证据 | `docs/superpowers/reports/2026-07-13-g0a-real-keychain-lan-acceptance.md`（**只读**；不得改写） |
| V2 Noise | M1 **BLOCKED**；M2 **denied** — 本计划不选择/修改/绕过 |
| 当前 ERROR_CODES | **62** → G0b 目标 **74**（+12 `upload-*`） |
| 当前 Gold | **blocked**，counts **4 / 4 / 1 / 9** — 自动实现不得抬升 |
| 当前版本常量 | `LINKE_RELEASE_VERSION = 'V1.40'` |
| G0b 完成后版本 | **常量**仅 `LINKE_RELEASE_VERSION = 'V1.41'`。**独立 release signature**（README/Gold evidence/tests）：`V1.41 G0b resumable manifest v2 snapshot upload implementation`。禁止把完整 signature 写入 version 常量值 |

**Goal:** 在 G0a same-LAN TLS 数据面上交付可恢复 manifest v2 snapshot 上传的代码与自动验收；真实第二 Mac 不可用时允许代码合并但 **real-LAN evidence / Gold 不提升**。

**Architecture:** 控制器权威 canonical manifest + session store（`repo/devices/<slug>/upload-sessions/...`）+ 8 MiB contiguous chunk + candidate 物化 + **publish claim（`open("wx")`）** + rename → final + `COMPLETED.json` commit point；index 条目 `origin: "remote-upload"` + digest；**全部** storage direct readers（list/getSnapshotManifest/restore）对 remote pending/corrupt/stale **fail-close**；协议错误码**唯一映射**（无“或/后续锁死”）；**C5** locks/service（无 public routes）；**C6** routes + controller-runtime；**C7** client/hostile；path-aware limiter + dual-timer deadlines（`requestTimeout=0`）。

**Tech Stack:** Node.js 24 ESM、内置 `node:test` / `node:https` / `node:crypto` / `node:fs`；**零**新增 npm 运行时依赖；复用 `safe-data-files`、`device-registry`、`agent-listener`、`device-client`、`controller-runtime`、`storage.safeDevicePath`。

---

## Global Constraints

1. **C0 本轮 docs-only**；实现从 C1 开始。未实现代码不得写成已完成。
2. **禁止**触碰 `package-lock.json`（不得读取/修改/暂存）。
3. **禁止**改写 G0a 真实报告、V2 M1/M2 ADR 结论。
4. **超时唯一架构：** C6 将 `server.requestTimeout = 0`，`headersTimeout = 10s`；handler **monotonic total timer** + chunk **idle 15s（非空 data 重置）** 共用 **idempotent settle gate**；G0a **64 KiB + 15s total** 不松；chunk **15s idle + 120s total**；create **8 MiB + 30s total**（design §6.4 / §6.4.1）。
5. **Limiter：** G0a 路径 60/min；`/agent/upload/*` 独立 **1200/min** pre-auth；命中 `device-rate-limited`；`upload-backpressure` 仅 service 容量。
5b. **Global active-transfer semaphore（对齐 design §10）：** 默认 **4**；配置允许**下调**（≥1）；**硬顶 16**。配置 **>16 或 <1 时构造/配置 fail-closed 拒绝**（**唯一**行为：不静默钳制、不接受 >16 为有效上限；运行时有效并发永远 ≤16）。
6. 全部 authenticated upload routes（**含 abort**）：rawHeaders exact-one `Authorization`、`X-Linke-Device-Id`、`X-Linke-Protocol-Version`；**auth 成功前禁止** body 读与 uploadId lookup。
7. **禁止**中间 commit 暴露未受保护的 public upload routes（C5 无 routes；C6 起完整注入）。
8. **禁止** `agent-listener` 偷读 registry 私有 dataDir；`dataDir` 仅由 controller-runtime / 显式注入传入 store。
9. 客户端 path **不**进 URL/header；目录 `repo/devices/<slug>/...`。
10. G0b **禁止**自动删除过期 session；TTL fail-close；过期不算 active；显式 abort 解除同设备自锁。
11. 不宣称 cross-process lock、cross-LAN、Noise、G0c restore、SMB、Gold/GA。
12. 每个 C：RED→GREEN→回归→多模型+PM 门；通过后 PM loop **自动 commit/push**；精确 path stage；禁 package-lock。
13. 真实 LAN 报告仅成功后；Gold 保持 **4 / 4 / 1 / 9**；version 常量仅 `V1.41`。
14. ERROR_CODES +12→74；`upload-resume-exhausted` = client-local HTTP N/A；507 = capacity 数值状态。

---

## Dependency Graph（C5–C7 生产暴露时点）

```text
C1 codes/manifest
 → C2 session store (TTL/active/abort primitives)
 → C3 chunk ingest
 → C4 commit (claim + rename) + storage direct readers origin=remote-upload fail-close
 → C5 locks + uploadService  [NO public routes]
 → C6 agent routes + limiter + deadlines + controller-runtime wiring  [FIRST public exposure]
 → C7 device-client uploader + concurrency/hostile
 → C8 real-LAN harness (hardware-gated)
 → C9 full suite + reviews
```

| Commit | 可部署？ | Public `/agent/upload/*`？ |
| --- | --- | --- |
| C5 | 是（listener 行为与 G0a 相同，无 upload 入口） | **否** |
| C6 | 是（完整 fail-closed：limiter→auth→locks→service） | **是** |
| C7 | 是（增加 client；不削弱服务端） | 是 |

---

## File Map（实现期总览）

| 动作 | 路径 | 阶段 |
| --- | --- | --- |
| Create/Modify | 本 design + plan | C0 |
| Modify | `src/error-codes.js`、`test/error-codes.test.js`（及 count pin） | C1 |
| Create | `src/upload-manifest.js`、`test/upload-manifest.test.js` | C1 |
| Create | `src/upload-session-store.js`、`test/upload-session-store.test.js` | C2 |
| Create | `src/upload-chunk-ingest.js`、`test/upload-chunk-ingest.test.js` | C3 |
| Create | `src/upload-commit.js`、`test/upload-commit.test.js`（含 publish claim） | C4 |
| Modify | `src/storage.js`、`test/upload-storage-compat.test.js`（list/getSnapshotManifest/restore：origin=remote-upload fail-close + local 兼容） | C4 |
| Optional | `src/safe-data-files.js` 大文件 hash 边界 | C4 |
| Create | `src/upload-locks.js`、`test/upload-locks.test.js` | **C5** |
| Create | `src/upload-service.js`、`test/upload-service.test.js` | **C5** |
| Modify | `src/agent-listener.js`、`test/agent-listener.test.js`、`test/upload-agent-routes.test.js` | **C6** |
| Modify | `src/controller-runtime.js`、`test/controller-runtime.test.js`（及既有相关） | **C6** |
| Modify | `src/device-client.js`、`test/device-client.test.js`、`test/upload-client.test.js` | **C7** |
| Create | `test/upload-concurrency.test.js`、hostile/flood 测试 | **C7** |
| Create | `test/helpers/g0b-real-*.js`、`test/g0b-real-acceptance.test.js` | C8 |
| Create (条件) | `docs/superpowers/reports/2026-07-22-g0b-real-lan-upload-acceptance.md` | C8 仅真实 PASS |
| Modify (条件) | `src/version.js` → **仅** `'V1.41'`；README/evidence signature；**禁止**抬 Gold | C8 |
| — | 全量 `npm test` + GLM/Qwen/fresh Grok + PM | C9 |

---

## 回滚锚点

| 锚点 | 用途 |
| --- | --- |
| `4064cd14b3c3ca9c1b26b9b515f9714cf82c7b2a` | C0 文档前干净实现基线 |
| 每 C 的建议 commit | 独立回滚该 C |
| `repo/devices/<slug>/upload-sessions/<uploadId>/` | 未 committed session；含完整 staging |
| `repo/devices/<slug>/snapshots/.upload-<uploadId>.pending/` | 未 rename 的 candidate；可删后重建 |
| `repo/devices/<slug>/snapshots/.claim-<snapshotId-safe>` | publish claim（`open wx`）；未知 claim 不得自动删 |
| `repo/devices/<slug>/snapshots/<snapshotId>/COMPLETED.json` | remote-upload commit point |
| `snapshots.json` + `device.json` | 非 commit point；COMPLETED 后幂等修；remote 条目含 `origin` |

**回滚规则：** 可删 session/staging/candidate；**禁止**用 upload 覆盖已 COMPLETED snapshot；**禁止**自动删除不同身份 claim。容量预检按 **2×totalBytes + margin**。文档 C0 回滚 = 删除两份 docs。

---

## 外部硬件门

| 门 | Env / 条件 | 缺席行为 |
| --- | --- | --- |
| 真实第二 Mac / 隔离 VM | 用户提供；`LINKE_REAL_G0B_UPLOAD_ACCEPTANCE=enabled`（名称 C8 锁死） | 跳过真实报告；Gold/status 不变 |
| 真实 Keychain | 沿用 G0a 专用 service 模式 | 自动测试用 inject store |
| 真实私网 Agent bind | 显式 RFC1918/ULA literal | 同进程 TLS fixture ≠ real-LAN |

---

## C0 — Docs Only（本轮）

**Files:**
- Create: design + plan（本文件与关联 design）

**Status:** **PROPOSED / PLAN ONLY**

- [x] **Step 1:** 完整阅读权威 Gold design G0b 条款、roadmap、G0a 源码与报告、storage/safe-data-files、error-codes
- [x] **Step 2:** 撰写 design（目标/非目标、方案裁决、状态机、schema、API、存储、威胁、恢复、验收、Gold）
- [x] **Step 3:** 撰写 plan（C0–C9 RED/GREEN、文件图、commit gate、硬件门）
- [x] **Step 4:** 自检 markdown/path/关键短语；`git diff --check`；`git status --short`
- [x] **Step 4b:** PM 通读后修订：version 常量 vs signature；auth 三元组；`repo/devices`；索引幂等；resume-exhausted client-local
- [x] **Step 4c:** **GLM adversarial FAIL 闭环修订**（P0/P1）：controller-runtime + C5–C7 重排；timeouts；limiter；abort；507 等
- [x] **Step 4d:** **GLM re-review PASS 后 P2 闭环（四项）**：`origin: remote-upload`；publish claim `open(wx)`；deadline dual-timer settle；statfs unavailable fail-close。**≠ 总 gate 通过**
- [x] **Step 4e:** **GLM 最终 PASS 末条 P2**：C2 create 同身份幂等 vs 不同身份 conflict 互斥分支（对齐 design §5.5）。**≠ 总 gate 通过**
- [x] **Step 4f:** **Qwen PASS 后 2 个 P2 一致性**：global transfer **硬顶 16** 镜像 design §10；C2 commit message 统一为 `...TTL and abort`。**≠ 总 gate 通过**（Qwen PASS ≠ 最终 PM gate）
- [x] **Step 4g:** **fresh Grok closure P2=2 闭环**：design §10/§1.1 唯一化 global transfer 1..16 fail-closed 拒绝（禁 clamp）；C1 RED 去掉 `domain=`，改为 12 码 kebab 值统一 `upload-` 前缀（string-only，无 domain 字段）。**≠ 总 gate 通过**
- [x] **Step 4h:** **第 2 次 fresh Grok closure P2=3 闭环**：① remote-upload **全部** direct readers（list/getSnapshotManifest/restore）fail-close；② 协议错误码消灭“或/后续锁死一码”；③ §17 收紧 + `ipAddress` 禁止进 upload canonical。**≠ 总 gate 通过**
- [x] **Step 5 (C0 review gate):** 在 commit 前必须 **fresh Grok re-review + PM ACCEPTED**（GLM/Qwen/先前 fresh Grok statistics 已 PASS 仍须 re-review + PM），且 **P0/P1 = 0**。
  **最终状态：GLM PASS + Qwen PASS + fresh Grok re-review PASS（P0/P1/P2 = 0）+ Codex PM ACCEPTED。**
- [x] **Step 6 (PM 门禁通过后):** 由 PM loop **自动** commit/push（精确 stage 两份 docs；禁止 package-lock）
  message：`docs: design V1.41 G0b resumable snapshot upload`
  **本 worker 不提交**

**验证：** 工作区仅两份 docs 变更 + 原有 `?? package-lock.json`；无 src/test 变更。

---

## C1 — Error Codes + Canonical Manifest / Session Schema

**Files:**
- Modify: `src/error-codes.js`
- Modify: `test/error-codes.test.js`（EXPECTED count **62 → 74**）
- Modify: 所有硬编码 `62` 的测试（至少 `test/agent-audit-integrity-monitor.test.js`、`test/audit-integrity-dual-write-readonly-inspect.test.js` 等；以 `rg '62' test` 为准）
- Create: `src/upload-manifest.js`
- Create: `test/upload-manifest.test.js`

**Interfaces (target):**
- `ERROR_CODES.UPLOAD_*` 十二码（design §7）
- `projectCanonicalUploadManifest(input, { authenticatedDeviceId }) → { manifest, manifestDigest }`
- `assertSafeManifestPath(path) → string`
- `LinkeError` status/retryable 映射表导出或集中常量
- `UPLOAD_RESUME_EXHAUSTED`：注册但 **HTTP status = N/A**；仅 client 构造；测试断言不得当作服务端 429

### RED

- [ ] **Step 1:** 扩展 `test/error-codes.test.js`：断言 12 个新码存在、唯一 kebab-case 字符串值、**统一 `upload-` 前缀**、count=74；**string-only registry**（与现 `ERROR_CODES` 一致；**不**新增 domain 字段/元数据）；断言 **不** 把 `DATA_RESUME_EXHAUSTED` 当作 upload resume。
- [ ] **Step 2:** `test/upload-manifest.test.js` 覆盖：
  - exact-key projection；未知键失败
  - hostile prototype getters / non-plain objects
  - duplicate paths
  - UTF-8 byte sort 与 digest 稳定性
  - path：空段、dot、dotdot、`\`、NUL、control、>1024 bytes、绝对路径
  - files ↔ entries 一一对应；algorithm；safe integers；64 lower hex
  - 上限：file count、单文件 512 GiB、totalBytes 不一致
  - deviceId 必须等于 authenticatedDeviceId；不等 → **唯一** `upload-manifest-invalid`
  - 客户端自报 digest ≠ canonical → **唯一** `upload-manifest-invalid`（**禁止**强制新身份继续）
  - `hostname`/`sourcePath` 可选可投影；`sourcePath` validator 不 fs 访问
  - **`ipAddress` 出现在 create/canonical 输入 → `upload-manifest-invalid`**（禁止投影/持久化/回显）

- [ ] **Step 3:** Run
  `node --test test/error-codes.test.js test/upload-manifest.test.js`
  Expected: **FAIL**（模块/码缺失）

### GREEN

- [ ] **Step 4:** 实现 12 codes + `upload-manifest.js`（纯函数，无 I/O）
- [ ] **Step 5:** 协调所有 ERROR_CODES count pins → 74
- [ ] **Step 6:** Run 同上 → **PASS**
- [ ] **Step 7:** `node --test test/device-protocol.test.js test/agent-listener.test.js` 聚焦回归

**Commit gate (建议):**
`feat: register G0b upload error codes and canonical manifest validators`

**Rollback:** revert 该 commit；count 回到 62。

---

## C2 — Persistent Session Store + TTL / Terminal / Reconcile

**Files:**
- Create: `src/upload-session-store.js`
- Create: `test/upload-session-store.test.js`
- Uses: `safe-data-files`、`safeDevicePath`（`deviceRel = repo/devices/<slug>`）、`crypto.randomUUID`

**Interfaces (target):**
- `createUploadSessionStore({ dataDir, now = () => Date, ... })` — **dataDir 显式注入**，不读 registry 私有字段
- layout：`repo/devices/<slug>/upload-sessions/<uploadId>/`
- `createSession` / `getSession` / `abortSession` / `findActiveSession(deviceId)`
- `createSession` **幂等分支**（对齐 design §5.5）：同 authenticated `deviceId` + 同 `snapshotId` + 同 `manifestDigest` 不得一律 conflict
- `isActiveNonterminal(session, now)` = status∈{initialized,receiving,verifying} **且** now < createdAt+24h
- `listConfirmedBoundaries` / `advanceBoundary` / `markVerifying` / `markCommitted` / `markAborted`
- `assertNotExpired`；`reconcileStagingChunk` — re-hash only

### RED

- [ ] **Step 1:** 测试：
  - 路径 `repo/devices/<slug>/upload-sessions/...`（禁止 `dataDir/devices/`）
  - 身份四元组不可变；uploadId 服务端生成
  - 状态单调；terminal 不可回退
  - 24h TTL；过期 fail-close 且记录仍在（**无删除**）；**过期不算 active**
  - abort：nonterminal→aborted；aborted 幂等；committed 拒绝 → **唯一** `upload-commit-conflict`
  - **重复 create 互斥分支（不得把同身份与冲突混为一谈）：**
    1. **同身份幂等**（同 authenticated deviceId + 同 snapshotId + 同 manifestDigest，及协议要求的同一不可变身份）：
       - 已有 **active 且未过期**、状态兼容（initialized/receiving/verifying）→ **幂等返回既有 session / 既有 uploadId**；**不**新建 session；**不**返回 `upload-session-conflict`
       - 已 **committed** 且 digest/device 一致 → **幂等返回 committed 安全摘要**；不重发 chunk、不覆盖 snapshot、不新建 uploadId
       - 旧 session **expired** → 不算 active → **允许创建新 session**（新 uploadId）；旧记录/staging **保留**（无自动删除）
    2. **不同身份冲突**：同 device 但 `snapshotId` **或** `manifestDigest`（upload identity）**不同**，且存在**未过期 active** session → `upload-session-conflict` + **仅本设备**可见 active locator；**不得**自动抢占/中止旧 session
    3. abort 后 / 过期后：可 create 新（不同或相同 snapshot，按上列规则）
  - **跨 device**：永不返回他设备 locator；lookup/create 作用域拒绝 → not-found / scope fail-closed（不泄漏存在性）
  - symlink/path swap → fail-closed
  - corrupt session.json → fail-closed
  - crash window：chunk 文件在、boundary 未进 → re-hash only
  - 跨 deviceId 读取 → not-found

- [ ] **Step 2:** Run `node --test test/upload-session-store.test.js` → **FAIL**

### GREEN

- [ ] **Step 3:** 实现 store；layout 对齐 design §8.1；`createSession` 按 §5.5 / 上列三分支实现（同身份幂等 vs 不同身份 conflict）
- [ ] **Step 4:** Run → **PASS**（含同身份重复 create 幂等 + 不同 snapshot active conflict 对照用例）
- [ ] **Step 5:** 回归 `test/safe-data-files.test.js` 子集

**Commit gate:**
`feat: add persistent G0b upload session store with TTL and abort`

**Rollback:** 删除 store 模块与测试；不影响 snapshots/。

---

## C3 — Bounded Chunk Ingest + Resume Idempotency

**Files:**
- Create: `src/upload-chunk-ingest.js`
- Create: `test/upload-chunk-ingest.test.js`

**Interfaces (target):**
- `parseChunkHeaders(rawHeaders / req) → ChunkIdentity`（exact-one）
- `assertContiguousOrder(session, identity)`
- `ingestChunkBody(req, { maxBytes, expectedSize, onOversize })` — single settle
- `commitChunk({ store, session, identity, bodyHash, tempPublish })`

### RED

- [ ] **Step 1:** 测试矩阵（错误码**唯一**；禁止“或”）：
  - under-size / over-size / early EOF
  - missing / duplicate Content-Length 与 Authorization / Device-Id / Protocol-Version → **`upload-chunk-invalid`**（读 body 前；不推进）
  - `X-Linke-Chunk-Size` 必须 positive；size=0 chunk → **`upload-chunk-invalid`**；0-byte 文件不发 chunk
  - auth/header preflight 失败时 body **未**完整读入内存（可用 mock stream 断言）
  - chunk URL/header/session 身份不一致 → **`upload-chunk-invalid`** + abort（design §6.0）
  - exact duplicate → 幂等 ACK
  - future / gap / offset ≠ confirmed boundary → **409 `upload-chunk-out-of-order`**；boundary **不变**；**不** abort
  - 同已确认坐标 size/hash 与既有/manifest 冲突 → **`upload-integrity-failed`** + abort
  - 非末块 size ≠ 8 MiB → **`upload-chunk-invalid`**
  - 末块允许更小但 **> 0**

- [ ] **Step 2:** Run → **FAIL**

### GREEN

- [ ] **Step 3:** 实现 ingest；硬界限 8 MiB；超限 destroy/drain
- [ ] **Step 4:** Run → **PASS**

**Commit gate:**
`feat: implement bounded contiguous chunk ingest with idempotent ACK`

---

## C4 — Candidate + Publish Claim + COMPLETED + storage direct readers

**Files:**
- Create: `src/upload-commit.js`、`test/upload-commit.test.js`（claim 逻辑在此模块；**无需**新源码文件）
- **Modify:** `src/storage.js`（**明确**：`listSnapshots` / `getSnapshotManifest` / `restoreSnapshot` 及等价 direct readers）
- Modify: `test/upload-storage-compat.test.js`（及必要时扩展 restore/manifest 相关测试）
- Optional: `src/safe-data-files.js` elevated hash cap

**Interfaces (target):**
- `preflightCapacity(dataDir, totalBytes)` → `2*totalBytes + max(64MiB,5%)`；不足或 **statfs 不可用/不可信/抛错** → **唯一** `upload-capacity-insufficient`（507）；**不创建 session**
- `verifyAndCommitSession({ store, dataDir, deviceId, uploadId })`
- candidate：`.../snapshots/.upload-<uploadId>.pending/`（rename 前**自然不可**被 direct readers 当完成）
- claim：`.../snapshots/.claim-<snapshotId-safe>` via **`open(..., "wx")`**
- final：`.../snapshots/<snapshotId>/`
- index upsert 仅 COMPLETED 后；remote 条目必含 `origin: "remote-upload"` + `manifestDigest` + `committedAt` + `snapshotId`
- rename 后 pending metadata **至少保留到** valid COMPLETED；COMPLETED 后清/留 pending 均不得使 readers 误判
- **`src/storage.js` helper 判定（design §8.4 冻结）：**
  - final 有 valid COMPLETED（`origin=remote-upload`）+ digest 一致 → remote **可读**
  - final 有 pending metadata 但无 valid COMPLETED，**或** index `origin=remote-upload` 但 marker missing/corrupt/digest mismatch → **list/get/restore 全部 fail-close**，**不**返回 manifest/files
  - COMPLETED/pending 均不存在且 entry 无 origin 或 `origin!==remote-upload` → **旧 local 行为**，不要求 marker

### RED

- [ ] **Step 1:** 测试：
  - 缺 chunk / hash 失败 → 不写 COMPLETED；staging 完整
  - 成功：staging 不动 → candidate 物化/复验 → **claim wx** → rename → COMPLETED → index（含 origin）→ session
  - **回归：空 target 目录上 rename 可替换**（fixture 证明 OS 行为）；互斥**不得**依赖 EEXIST
  - 两竞争 claim：仅一个 `open("wx")` 成功；败者 conflict 或同身份恢复
  - claim 损坏 / 不同身份 → commit-conflict；**不**自动删未知 claim
  - 同身份 claim 恢复/接管
  - candidate 崩溃窗口：final 不存在；可重建；**get/restore 不可读 candidate**
  - rename 后 / COMPLETED 前：pending 身份一致才完成；否则 conflict 不覆盖；**pending-without-marker → list 隐藏 + getSnapshotManifest/restore fail-close（不返回内容）**
  - COMPLETED 后 / index 前：幂等修 indexes；无重复 snapshotId
  - COMPLETED 后残留 claim：同身份幂等清理；失败不反转 committed
  - **direct readers 矩阵（修改 `src/storage.js`；list + getSnapshotManifest + restore）：**
    - remote **pending-without-marker** → fail-close（不返回 manifest/files）
    - remote **corrupt marker** → fail-close
    - remote **stale index**（origin=remote-upload 但 marker missing/digest mismatch）→ fail-close
    - valid COMPLETED + digest 一致 → 可读
    - **旧 local** direct read/restore **不回归**（无 origin / origin≠remote-upload 不要求 marker）
  - listSnapshots：local 无 origin 仍可见；remote 无/坏 marker **隐藏**；index≠commit point
  - index schema：remote 缺 origin/digest 的写入拒绝或隐藏（C4 锁死）
  - 容量：双份峰值；**statfs mock 失败/不可用 → 507 且无 session**
  - 重复 finalize 幂等

- [ ] **Step 2:** Run → **FAIL**

### GREEN

- [ ] **Step 3:** 实现 claim 协议 + **`src/storage.js` list/get/restore** remote fail-close 契约（禁 EEXIST-no-replace 神话）
- [ ] **Step 4:** `test/restore.test.js` 冒烟（**local direct read/restore 不回归**）

**Commit gate:**
`feat: commit remote-upload snapshots with publish claim and origin index`

---

## C5 — Locks / Backpressure + Upload Service Orchestration（**无 public routes**）

**Files:**
- Create: `src/upload-locks.js`、`test/upload-locks.test.js`
- Create: `src/upload-service.js`、`test/upload-service.test.js`
- **不**修改 `agent-listener` 路由表；**不**修改 `controller-runtime` production 暴露（可导出工厂供单测）

**Interfaces (target):**
- `createUploadLocks({ maxGlobalTransfers = 4 })` — 默认 **4**；允许配置 **下调**（≥1）；**硬顶 16**（design §10）
- 配置 `maxGlobalTransfers > 16` 或 `< 1`：**构造 fail-closed 拒绝**（**唯一**行为；**禁止**静默钳制、**禁止**接受 >16 为有效上限）
- `createUploadService({ dataDir, store, locks, ingest, commit, now })`
- API：`create` / `status` / `putChunk` / `finalize` / `abort`（纯函数/方法，**无 HTTP**）
- per-device active 冲突 → `upload-session-conflict` + locator
- 全局信号量满 → `upload-backpressure`（retryable）

### RED

- [ ] **Step 1:** 测试：
  - 同设备第二 active create → conflict + locator；abort 后可 create
  - 默认上限 4：第 5 个 active transfer → `upload-backpressure`；**不**无限排队
  - 配置下调（如 2）时第 3 个 active → backpressure
  - **硬顶 16：** `maxGlobalTransfers=17`（及更大）以及 `0` → **构造失败**；有效运行上限**永远 ≤16**，**不能**被配置放大
  - service 编排 create→chunks→finalize 内存/temp dataDir 成功路径
  - **断言生产 listener 默认仍 404 upload paths**（本 C 不注册）

- [ ] **Step 2:** Run → **FAIL**

### GREEN

- [ ] **Step 3:** 实现 locks + service
- [ ] **Step 4:** 确认无 agent-listener upload routes；G0a 测试不受影响

**Commit gate:**
`feat: add G0b upload locks and service without public routes`

**Production exposure：** **无** — 可部署，upload 仍 fail-closed 404。

---

## C6 — Agent Routes + Path-Aware Limiter + Deadlines + controller-runtime Wiring

**Files:**
- Modify: `src/agent-listener.js`
- Modify: `src/controller-runtime.js`
- Create/Modify: `test/upload-agent-routes.test.js`、`test/agent-listener.test.js`、`test/controller-runtime.test.js`

**Routes（首次 public）：**
- `POST /agent/upload/sessions`
- `GET  /agent/upload/sessions/:uploadId`
- `POST /agent/upload/sessions/:uploadId/chunks`
- `POST /agent/upload/sessions/:uploadId/finalize`
- `POST /agent/upload/sessions/:uploadId/abort`

**Server timeouts（冻结；design §6.4.1）：**
- `headersTimeout = 10_000`
- `requestTimeout = 0`
- **Handler monotonic total timer** + **chunk idle timer**（每非空 data 重置 15s）共用 **idempotent abort/settle gate**
- 超时：停 hash/write/state；destroy 输入；**单次**脱敏响应；clear 双 timer；late events 不得二次响应/推进
- 预算：G0a **64KiB / 15s total only**；create **8MiB / 30s total**；chunk **15s idle + 120s total**；status/finalize/abort **15s total**

**Limiter（冻结）：**
- G0a paths：**60/min/IP**
- `/agent/upload/*`：**1200/min/IP** pre-auth → `device-rate-limited`
- service 满 → `upload-backpressure`

**Wiring（冻结）：**
- `controller-runtime`：`ensureSafeDataRoot(dataDir)` → `createUploadSessionStore` / locks / service → 注入 `createAgentListener({ registry, uploadService, rateLimit, ... })`
- listener **不得**从 registry 偷 dataDir
- 缺 `uploadService` 时 upload routes 不注册或硬 404

**Auth contract（create/status/chunk/finalize/abort）：**
- exact-one `Authorization`、`X-Linke-Device-Id`、`X-Linke-Protocol-Version`
- **auth-before-lookup/body**

### RED

- [ ] **Step 1:**
  - auth 失败不 lookup/body（mock 计数）
  - 跨设备 100% deny（含 abort）→ status/finalize/abort **唯一** `upload-session-not-found`（不泄漏）
  - abort 幂等；committed 不可 abort → **唯一** `upload-commit-conflict`
  - create：manifest/body deviceId ≠ auth → **`upload-manifest-invalid`**；客户端 digest 不一致 → **`upload-manifest-invalid`**
  - G0a 64KiB + 15s body parse/size/deadline → **唯一**既有 **`device-request-invalid`（400）**；**不松**（requestTimeout=0 后由 reader 强制）；**禁止**“或既有映射”
  - upload create body **30s** total deadline / 越界 → **唯一** **`device-request-invalid`（400）**；不创建/不推进 session；**禁止** `upload-io-error`
  - fake timers：chunk slow drip 重置 idle；total/idle 超时 single-settle；late event 不二次响应/不推进 state
  - chunk：out-of-order → `upload-chunk-out-of-order`（不 abort）；同坐标 hash 冲突 → `upload-integrity-failed`+abort；header/CL 非法 → `upload-chunk-invalid`（读 body 前）
  - 128 chunks 模拟 1GiB **不被** 60/min 误杀；upload flood 仍被 1200/min 有界
  - 507 capacity（含 statfs 失败路径）客户端 **数字 statusCode** 映射测试
  - `controller-runtime` 启动后 upload 依赖齐全；缺依赖 fail-closed
  - 响应无 path/token/fingerprint/`ipAddress`/sourcePath

- [ ] **Step 2:** Run → **FAIL**

### GREEN

- [ ] **Step 3:** 实现 routes + limiter + deadlines + runtime wiring
- [ ] **Step 4:** upload routes + agent-listener + controller-runtime + G0a 回归 → **PASS**

**Commit gate:**
`feat: expose fail-closed G0b upload routes via controller-runtime`

**Production exposure：** **是（首次）** — 每个请求：IP limit → auth → locks/service。

---

## C7 — Pinned Client / Resume / Abort + Concurrency Hostile Integration

**Files:**
- Modify: `src/device-client.js`
- Create: `test/upload-client.test.js`、`test/upload-concurrency.test.js`
- Modify: `test/device-client.test.js`

**Interfaces (target):**
- `requestPinnedBinary(...)`；mandatory auth 三元组 headers
- `uploadSnapshotResumable(...)`：create→chunks（跳过 0-byte）→finalize；status resume；**显式 abort** API
- 429：`device-rate-limited` vs `upload-backpressure` 分码 + Retry-After
- 507 数值处理；local `UPLOAD_RESUME_EXHAUSTED`
- 不得自动抢占不同 snapshot 的 active session

### RED

- [ ] **Step 1:**
  - pin 失败不写 body
  - 断连 resume；corrupt 拒绝
  - abort 后可新 session；active 不同 snapshot → conflict fail-close
  - resume exhausted = local LinkeError HTTP N/A
  - two-device parallel + one disconnect 状态不串
  - backpressure + IP limiter 有界；无无限队列

- [ ] **Step 2:** Run → **FAIL**

### GREEN

- [ ] **Step 3:** 实现 client + 集成敌意测试
- [ ] **Step 4:** PASS + G0a client 回归

**Commit gate:**
`feat: add pinned G0b upload client with resume and concurrency tests`

---

## C8 — Real-LAN Harness + Honesty (Hardware-Gated)

**Files:**
- Create: `test/helpers/g0b-real-common.js`（或扩展 g0a helpers，优先少重复）
- Create: `test/helpers/g0b-real-controller-runner.js`
- Create: `test/helpers/g0b-real-endpoint-runner.js`
- Create: `test/g0b-real-acceptance.test.js`
- Create (仅 PASS): `docs/superpowers/reports/2026-07-22-g0b-real-lan-upload-acceptance.md`
- Modify (允许): `src/version.js` → **仅** `LINKE_RELEASE_VERSION = 'V1.41'`
- Modify (允许): README / evidence / tests 使用独立 signature
  `V1.41 G0b resumable manifest v2 snapshot upload implementation`
  （**禁止**把完整 signature 写入 `LINKE_RELEASE_VERSION`）
- Modify (允许): README **诚实**段落 — 写清 auto complete ≠ real-LAN complete；Gold 仍 **4 / 4 / 1 / 9**
- **禁止:** 抬升 `src/gold-readiness.js` 9-item statuses（默认）
- **禁止:** 宣称 G0b real-LAN complete / Gold / GA（无 PASS 报告时）

### 自动 harness 要求

- [ ] 至少 **child_process** 独立 endpoint 进程；**禁止**同进程 mock 冒充 LAN evidence
- [ ] 覆盖：断连+resume、corrupt chunk、manifest conflict、跨设备 deny
- [ ] 默认 CI：gate 关闭时 skip；零副作用 import

### 真实门

- [ ] 用户提供第二 Mac/VM 并显式 enable env
- [ ] 成功后写脱敏报告（对齐 G0a 红线字段）
- [ ] 失败或不可用：**不**写伪 PASS；Gold 不变

**Commit gate (无硬件):**
`feat: add G0b upload auto acceptance harness (real-LAN evidence absent)`

**Commit gate (有硬件 PASS):**
`test: add sanitized G0b real-LAN upload acceptance report`
（仍不抬 Gold，除非另有 PM 裁决）

---

## C9 — Full Suite + Multi-Model Review + PM

- [ ] **Step 1:** `npm test` 全量绿
- [ ] **Step 2:** `rg` 扫描：无 package-lock 变更；M1/M2 docs 未改；G0a 报告未改
- [ ] **Step 3:** secret/path/raw-error 扫描（测试已覆盖 + 人工 diff）
- [ ] **Step 4:** G0a 回归：`test/agent-listener.test.js` `test/device-client.test.js` `test/device-registry.test.js` `test/g0a-real-acceptance.test.js`（gate off）
- [ ] **Step 5:** 外部：GLM / Qwen adversarial + fresh Grok review + Codex PM
- [ ] **Step 6:** 关闭所有 P0/P1；更新 design 仅当冻结条款变更（需显式 docs commit）

**Commit gate:** 通常无代码；或
`test: close G0b review findings`
**禁止**在无真实报告时把 Gold 标 ready。

---

## 测试矩阵（总清单）

| 域 | 必须覆盖 |
| --- | --- |
| Manifest pure | hostile getters/prototypes、duplicate paths、overflow、canonical digest |
| Store | symlink/path swap、TTL/active、abort 幂等；**同身份 create 幂等** vs **不同 snapshot/digest active → conflict+本设备 locator**；跨 device 无 locator；crash reconcile |
| Binary body | under/over/early EOF、duplicate headers、auth-before-body/lookup、Chunk-Size>0、single settle；码唯一：invalid / out-of-order / integrity-failed |
| Timeouts | requestTimeout=0；dual-timer + single settle；fake timers/slow drip/late event；G0a 15s → **`device-request-invalid`**；create 30s → **`device-request-invalid`**（禁 upload-io-error） |
| Limiter | G0a 60/min 隔离；upload 1200/min；128 chunks 不受 60/min 误杀；flood 有界 |
| TLS + registry | auth 三元组；cross-device session/status/chunk/finalize/**abort** 100% deny → not-found；committed abort → commit-conflict |
| Protocol codes | digest 不一致 / create deviceId 不符 → manifest-invalid；chunk 身份 → chunk-invalid+abort；无“或/后续锁死一码” |
| Commit | claim `open(wx)`；空 target rename 替换回归；双 claim 竞争；corrupt/异身份 claim；同身份恢复；COMPLETED 后清 claim；pending 至少到 COMPLETED |
| Capacity | 双份峰值；statfs unavailable/throw → 507 无 session |
| Direct readers | **`src/storage.js`** list+getSnapshotManifest+restore：pending-without-marker / corrupt marker / remote stale index **fail-close**；local read/restore 不回归；index≠commit |
| Wiring | controller-runtime 注入；listener 无偷 dataDir；C5 无 public routes |
| Client | resume/abort；429 双码；507 数字；resume-exhausted local N/A |
| Concurrency | two-device + disconnect；backpressure；无无限队列；global transfer 默认 4、可下调、**硬顶 16**（>16 构造拒绝） |
| Hygiene | secret scan；G0a 回归；M1/M2 untouched；ERROR_CODES 74；package-lock untouched |
| Full | `npm test` |

---

## 建议 Conventional Commits（汇总）

| C | Message |
| --- | --- |
| C0 | `docs: design V1.41 G0b resumable snapshot upload` |
| C1 | `feat: register G0b upload error codes and canonical manifest validators` |
| C2 | `feat: add persistent G0b upload session store with TTL and abort` |
| C3 | `feat: implement bounded contiguous chunk ingest with idempotent ACK` |
| C4 | `feat: commit remote-upload snapshots with publish claim and origin index` |
| C5 | `feat: add G0b upload locks and service without public routes` |
| C6 | `feat: expose fail-closed G0b upload routes via controller-runtime` |
| C7 | `feat: add pinned G0b upload client with resume and concurrency tests` |
| C8 | `feat: add G0b upload auto acceptance harness (real-LAN evidence absent)` 或真实报告 test commit |
| C9 | `test: close G0b review findings`（如有） |

---

## C0 完成定义（本轮）

1. 两份文档存在；已纳入 PM 通读 + GLM FAIL 闭环 + **GLM PASS P2 闭环**（总 gate 仍未通过）。
2. 无 src/test/README/package/version/Gold 变更。
3. 未读取/修改/暂存 `package-lock.json`。
4. untracked docs 用 `git diff --no-index --check /dev/null <file>` 确认 **无 whitespace diagnostic**。
5. 文档 **PROPOSED / PLAN ONLY**；未把未实现标为完成。
6. **本 worker 不提交**；仅当 **Qwen + fresh Grok + PM ACCEPTED**（P0/P1=0）后由 PM loop 自动 commit/push。

---

## 附录 A — 错误码 HTTP 速查（实现钉死；无“或/后续锁死”）

| code | status | retryable | 唯一场景（摘要） |
| --- | --- | --- | --- |
| upload-manifest-invalid | 400 | no | create digest 不一致；create deviceId 不符；manifest 语义/path/`ipAddress` 等 |
| upload-session-conflict | 409 | no | 同设备不同 snapshot/digest active |
| upload-session-not-found | 404 | no | status/finalize/abort 跨 device 或不存在（不泄漏） |
| upload-session-expired | 410 | no | TTL |
| upload-chunk-invalid | 400 | no | header/CL/语法非法（读 body 前）；chunk 身份不一致（+abort） |
| upload-chunk-out-of-order | 409 | yes* | future/gap/offset≠boundary；不推进、不 abort |
| upload-integrity-failed | 409 | no | 同坐标 size/hash 冲突或 finalize 复验；abort |
| upload-capacity-insufficient | **507**（数值；非 WebDAV；亦覆盖 statfs unavailable） | no | 唯一 capacity 码 |
| upload-backpressure | **429** | yes + Retry-After（service 容量；**≠** IP limiter） | service 容量/锁饱和 |
| upload-commit-conflict | 409 | no | snapshot 冲突；**committed abort 唯一码** |
| upload-io-error | 500 | no | 脱敏 I/O；**不**用于 create/G0a deadline |
| upload-resume-exhausted | **N/A（client-local only）** | no | 仅客户端本地 |
| device-request-invalid（既有） | 400 | no | **唯一**：G0a body/15s；upload create body/30s（不建 session） |
| device-rate-limited（既有） | 429 | yes + Retry-After（G0a + upload IP limiter） | pre-auth IP limiter |

\* 仅在客户端先 status 重对齐后有意义。

---

## 附录 B — 与 G0a / G0c 接口边界

```text
G0a: enroll / token / TLS pin / registry scope / 60/min IP
        ↓ (freeze)
G0b: upload service → (C6) routes + controller-runtime wiring
        ↓
G0c: restore task / endpoint publish / 同锁扩展
```

G0b **不得**提前实现 G0c restore routes；全局 transfer 计数可为 G0c 预留钩子，但 restore-backpressure 码不在本阶段注册。

---

## 附录 C — 审查闭环记录（文档侧）

### C-1 GLM FAIL（P0/P1）已闭环

| Finding | 文档处置 |
| --- | --- |
| controller-runtime / 未保护 routes | C5 service-only；C6 routes+runtime |
| 15s vs 120s timeout | requestTimeout=0 + per-route deadlines |
| 60/min vs chunks | path-aware 1200/min |
| publish 半迁移 | candidate + staging 不动 |
| listSnapshots 初版 | marker 真实性 |
| 24h 自锁 | abort + active/TTL |
| HTTP 507 | 数值映射 |
| 里程碑 | C5–C7 重排 |

### C-2 GLM PASS 后 P2 闭环（本轮）

| P2 | 文档处置 |
| --- | --- |
| snapshots.json remote 识别 | 强制 `origin: "remote-upload"` + manifestDigest；**仅**该 origin 做 marker；local 永不因 marker 隐藏 |
| rename EEXIST 神话 | **拒绝**；冻结 publish claim `open("wx")`；空 target rename 替换回归；双 claim 竞争测试 |
| deadline 实现锚点 | total monotonic + chunk idle 重置；共享 settle gate；late event 测试 |
| statfs unavailable | create fail-close capacity-insufficient；不建 session；C1/C4 映射一致 |

### C-3 GLM 最终 PASS 末条 P2

| P2 | 文档处置 |
| --- | --- |
| create 同身份被误写成一律 conflict | C2 RED/GREEN + 测试矩阵：同 device+snapshotId+digest → active/committed **幂等**；不同 snapshot/digest + active → **conflict+本设备 locator**；expired 可新 create；跨 device 无 locator |

### C-4 Qwen PASS 后一致性 P2

| P2 | 文档处置 |
| --- | --- |
| global transfer 硬顶 16 未镜像 | Global Constraints 5b + C5 RED + 测试矩阵：默认 4、可下调、硬顶 16，>16 **构造拒绝**（唯一） |
| C2 commit message 双版本 | 统一为 `feat: add persistent G0b upload session store with TTL and abort` |

### C-5 fresh Grok PASS 后 P2（本轮）

| P2 | 文档处置 |
| --- | --- |
| design §10 未唯一化 fail-closed vs clamp | design §10 + §1.1：有效范围仅 1..16；`<1`/`>16` 构造/启动 **fail-closed 拒绝**；禁止静默钳制、禁止放大硬顶、禁止 “reject 或 clamp” 二选一；补最小测试说明 |
| C1 RED `domain=upload` 与 string-only ERROR_CODES 不符 | C1 RED Step 1：12 新码 kebab-case 字符串值统一 `upload-` 前缀；**不**新增 domain 字段/元数据 |

### C-6 第 2 次 fresh Grok PASS 后 P2（本轮）

| P2 | 文档处置 |
| --- | --- |
| remote-upload 仅 list 收紧 | design §1.1/§8.4/§11 + plan C4/File Map/测试矩阵：`listSnapshots`+`getSnapshotManifest`+`restoreSnapshot` 全部 fail-close；pending-without-marker / corrupt / stale index 不返回 manifest/files；local 不回归；pending 至少保留到 COMPLETED |
| 协议错误“或/后续锁死一码” | committed abort→`upload-commit-conflict`；digest/create deviceId→`upload-manifest-invalid`；chunk 身份→`upload-chunk-invalid`+abort；跨 device lookup→`upload-session-not-found`；out-of-order vs integrity vs invalid 三分；create 30s/G0a 15s→唯一 `device-request-invalid`；删 §6.3 二选一 |
| §17 hostname/ipAddress 仍开放 | §5.2 冻结 hostname/sourcePath 可选（sourcePath opaque）；**禁止 ipAddress** 进 upload canonical/create；§17 仅保留非 wire 实现细节 |

**Gate 状态：** GLM **PASS** + Qwen **PASS** + fresh Grok **PASS**（第 2 次 P0=0 / P1=0 / P2=3 已修）；**修订后仍须 fresh re-review + PM** → 总 C0 commit gate 仍 **未勾选通过**。任何单模型 PASS **不等于** 最终 PM gate。

---

**END OF PLAN — C0 PLAN ONLY; IMPLEMENTATION STARTS AT C1**
