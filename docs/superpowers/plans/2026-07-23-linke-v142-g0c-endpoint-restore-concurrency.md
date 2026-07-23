# Linke V1.42 G0c — Endpoint-Pull Restore with Crash-Recoverable Rollback Anchor Implementation Plan

> 可执行 TDD 清单。步骤用 checkbox（`- [ ]`）跟踪。实现由 **Grok 原生 CLI worker（`grok-4.5` high）** 按任务推进；**不使用** collaboration subagent 模板。外部多模型审查与 **Codex PM** 门禁决定是否进入下一 C 与是否 commit/push。本会话为 **inline PM loop only**（无 subagent 执行路径）。

| 字段 | 值 |
| --- | --- |
| 文档类型 | 可执行 TDD 实施计划 — **PLAN ONLY / C0** |
| 关联 design | `docs/superpowers/specs/2026-07-23-linke-v142-g0c-endpoint-restore-concurrency-design.md`（**APPROVED**；commit **`8fa69ab`**；SHA-256 **`d8e7234d8dade9319b08056ca9007e178217d30f483103765abacf2c9896bb55`**） |
| 基线 HEAD | `8fa69ab`（design 已入库；本 plan 在其上叠加） |
| 基线工作区 | 仅允许 **本 plan 文件** + 既有 **`?? package-lock.json`** — **绝对禁止**读取/修改/暂存 `package-lock.json`、`.superpowers`、env/凭证/认证文件 |
| 上游路线图 | G0a → G0b → **G0c**；完成信号 = 不可变任务 + endpoint staging/publish/rollback + 每设备锁 + 全局背压 + 双端点并发且互不可见（自动） |
| G0a 证据 | `docs/superpowers/reports/2026-07-13-g0a-real-keychain-lan-acceptance.md`（**只读**；不得改写） |
| G0b 真实 LAN | 报告 **absent**；自动实现 **≠** real-LAN complete |
| V2 Noise | M1 **BLOCKED**；M2 **denied** — 本计划不选择/修改/绕过 |
| 当前 ERROR_CODES | **74**（含既有 `UPLOAD_ERROR_HTTP_CONTRACT`）→ G0c 目标 **88**（**+14** `restore-*` + 新建 `RESTORE_ERROR_HTTP_CONTRACT`；count/contract pins **同 C1 commit**） |
| 当前 Gold | **blocked**，counts **4 / 4 / 1 / 9** — 自动实现与 docs **不得**抬升 |
| 当前版本常量 | `LINKE_RELEASE_VERSION = 'V1.41'` |
| G0c 完成后版本 | **常量**仅 `LINKE_RELEASE_VERSION = 'V1.42'`。**独立 release signature**：`V1.42 G0c endpoint-pull restore with crash-recoverable rollback anchor implementation`。禁止把完整 signature 写入 version 常量值 |
| Implementer | **固定** Grok 原生 CLI **`grok-4.5` high**；**禁止** collaboration subagent；首轮 **fresh** session；**仅**对完整 PM finding 返修才 **resume** |
| Review 链（每 C 强制） | RED→GREEN→聚焦回归 → **GLM adversarial** → **Qwen statistics** → **fresh Kimi closure reviewer（只读）** → **Codex PM verification**；**P0/P1 = 0** 才精确 stage/commit/push。Kimi **不得**裁定真实测试/Git 事实；网络错误 **不是** PASS |
| 本 worker | **只写本 plan**；**不** commit/push；**不**改 src/test/README/package/version/report/design |

**Goal:** 在 G0a same-LAN TLS 与 G0b 可恢复上传冻结契约上，交付 **endpoint-pull** restore（Controller 不可变 `TASK` + 可变 `STATUS`；endpoint 私有 STATE + 隐藏同级 staging/anchor/quarantine；纯 Node 双 rename 非 zero-gap；两阶段 cleanup；与 upload **共用** live binary semaphore）的代码与自动验收；真实第二 Mac/隔离 VM 不可用时允许代码合并但 **real-LAN evidence / Gold 不提升、不创建报告**。

**Architecture:** Loopback 管理面 `write-token + required audit admission` 创建/取消 restore task；Agent TLS 上 endpoint **claim → GET task（含 `files[].path`）→ chunk GET（占全局槽）→ progress → ReceiptObject → CleanupReceipt**；Controller 存 `repo/devices/<slug>/restore-tasks/<taskId>/{TASK.json,STATUS.json}`；endpoint 在 `restoreRoot` 下对 `relativeTarget` 做 preflight（no-follow、same `stat.dev`、EXDEV fail-close）与 dual-rename publish；`anchor-intent` 后 cancel 不得 `cancelled-local`；receipt ACK 仅 `cleanupAuthorized`；cleanup ACK 后才 `cleaned`/`cancelled-final`。

**Tech Stack:** Node.js **24** ESM；内置 `node:test` / `node:https` / `node:crypto` / `node:fs` / `node:path`；**零**新增 npm 运行时依赖；**不读取** `package-lock.json`；复用 `safe-data-files`、`device-registry`、`agent-listener`、`device-client`、`controller-runtime`、`upload-locks`（live-transfer 语义注释对齐）、`upload-service`（C5 收紧 `runTransfer` 仅 putChunk）、`storage` 可读边界、`error-codes`。

**Typed signatures note:** 本 plan 中 `input: Type` / `Promise<Type>` / 对象形参字段列表 等 typed 签名仅为**接口契约记法**，**不是**可粘贴的 TypeScript。实际实现必须是 Node.js ESM **`.js` + JSDoc**；**禁止**把 TypeScript annotation 写入源码。

---

## Global Constraints

1. **C0 本轮 docs-only（本 plan）**；实现从 C1 开始。未实现不得写成已完成。
2. **禁止**读取/修改/暂存 `package-lock.json`、`.superpowers`、env/凭证/认证文件。
3. **禁止**改写 G0a 真实报告、G0b real-LAN 报告（仍 absent）、V2 M1/M2 结论、Gold 9-item statuses。
4. **endpoint-pull + immutable TASK / durable STATUS**；严格 `relativeTarget` + snapshot-root-relative `files[].path`；**无** absolute target wire/log/response；**no-follow** symlink defense；same `stat.dev`；**EXDEV fail-close / no copy**。
5. **纯 Node 双 rename**；**非 zero-gap**；顺序 **target→anchor** 后 **staging→target**；ReceiptObject fingerprint nullability **唯一表**（design §7.4）。
6. **Cancel 线性化点**在 durable **`anchor-intent` 之前**；一旦 `anchor-intent` 已落盘，即使 rename 未发生且 `cancelRequested=true`，也 **不得** `cancelled-local`；合法结局 **仅** `completed` / `rolled-back`；不可能目录组合 **fail-closed**：anchored 非法组合与 rollback 目录歧义 → **唯一** `restore-state-invalid`；publish-intent `(target=yes, staging=yes)` → **唯一** `restore-publish-conflict`。
7. **Receipt ACK** 仅 `cleanupAuthorized=true`；endpoint 删除 task-specific artifacts 后写 **CleanupReceipt**；Controller cleanup ACK 后才 `cleaned` 或 cancel 路径 `cancelled`+`cleanupAckAt`。
8. **upload/restore 共用** live binary semaphore：默认 **4**，合法 **1..16**（0/17 构造 fail-closed，禁 clamp）；**仅** G0b **`putChunk`** + G0c **chunk GET** 调用 `locks.runTransfer`；upload **create/status/finalize/abort** **不得**占全局槽；restore **claim/task/progress/receipt/cleanup** **不得**占全局槽；**claim 不占槽**；同 device upload **OR** restore 互斥（双向 probe + **同一** `locks.runDevice(deviceId, …)` 短临界区包围 admission check + state mutation，禁止分离先查再写 TOCTOU）；不同 device 可并行；settle/abort/timeout **必须** release。
9. **auth-before-lookup**；exact-one triad headers；cross-device **统一 not-found**；chunk **8 MiB**；timeouts/rate limits 按 design §19；client network retry **8**。
10. **C5 前不得**暴露 public restore routes；**C6 是第一 public exposure**，同 commit 必须完整带 limiter/auth/admission/deadline/service wiring + 双向 admission 生产注入。
11. **version 常量**仅 `V1.42` 与 **signature 分离**；Gold 仍 **blocked 4/4/1/9**；无真实硬件证据 **不创建** real-LAN 报告。
12. 每个 C：RED→GREEN→聚焦回归→**GLM adversarial**→**Qwen statistics**→**fresh Kimi closure reviewer（只读）**→**Codex PM verification**；仅 **P0/P1=0** 才精确 stage exact paths、commit、push；**始终**保留 `package-lock` unstaged/unread。
13. **Implementer：** Grok `grok-4.5` high；**不使用** collaboration subagent；首轮 fresh；仅对完整 PM finding 返修 resume。
14. 全量测试期望：**0 fail**；既有硬件 skip **可诚实保留**；**不得**预写具体总测试数（会随实现增长）。
15. 三方 design 审查 **6 个 P2** 全部转为本 plan obligations + tests；**不得遗失**。
16. **禁止** plan 内使用通配路径、模糊省略形参、残缺 options 对象、以及笼统“一次做完所有逻辑”类步骤；每步 checkbox + exact 命令 + 预期 FAIL/PASS 分离。

---

## P2 Obligations Map（三方设计审查 6 项 → 计划/测试）

| # | P2 义务 | 计划位置 | Exact test 文件 | 必须测试 |
| --- | ---: | --- | --- | --- |
| **P2-1** | **rollback 三元目录真值表完整枚举** | **C4** RED Step 6；C9 Step 5 | `test/restore-crash-truth-tables.test.js` | 合法组合推进；目录存在性歧义 → **唯一** `restore-state-invalid`；**rollback rename 抛错**与 fingerprint mismatch → **唯一** `restore-rollback-failed`；**不自动删除**目录/工件；禁止半路径自动删异身份工件 |
| **P2-2** | **anchored 存在性真值表完整枚举** | **C4** RED Step 5 | `test/restore-crash-truth-tables.test.js` | `originalTargetExisted` × `(targetExists, anchorExists)` × 类型；非法组合 → **唯一** `restore-state-invalid`；合法 → 允许 `publish-intent` |
| **P2-3** | **cancelled-local crash 恢复显式** | **C4** RED Step 9；C3 phase 边；C7 cancel | `test/restore-crash-truth-tables.test.js`、`test/restore-client.test.js` | 幂等删未发布 staging → 同 `cleanupId` CleanupReceipt → 重放；禁止 post-anchor 进入 `cancelled-local` |
| **P2-4** | **anchor-intent staging 重校验失败** | **C4** RED Step 8 | `test/restore-crash-truth-tables.test.js` | 不重取、不 publish、不删除；可证原状 → rolled-back receipt；歧义 → **唯一** `restore-state-invalid` |
| **P2-5** | **crash 后 progress 不得回拨** | **C3** RED Steps 6–7；**C6** progress；**C7** resume | `test/restore-endpoint-state.test.js`、`test/restore-agent-routes.test.js`、`test/restore-client.test.js` | durable 仅 fsync+STATE；staging 缺损 fail-close；**绝不**写回更小 `receivedBytes` |
| **P2-6** | **error count 74+14→88** + `UPLOAD_ERROR_HTTP_CONTRACT` 不变 | **C1** 全节 | `test/error-codes.test.js` + **共 9** 个 count-pin（含 `test/audit-integrity-process-lock-scans.test.js` prior/current/next=74/88/89） | length===88；RESTORE contract 14；upload contract deepEqual 不变；pins 同 C1 commit |

---

## Dependency Graph（C5–C6 生产暴露时点）

```text
C1 codes/path/schema validators
 → C2 restore-snapshot-reader adapter + Controller task store (TASK/STATUS/admission/cancel/receipt/cleanup)
 → C3 Endpoint STATE + staging I/O + fingerprints
 → C4 dual-rename publish + rollback + crash truth tables  [P2-1..P2-4 主落地]
 → C5 live-transfer 收紧 + bidirectional admission probes + restore service  [NO public routes]
      [P1-1: upload create/finalize 移出 runTransfer；仅 putChunk 占槽]
      [P1-2: findActiveRestore/findActiveUpload + 共享 runDevice 临界区]
 → C6 agent restore routes + restore IP limiter + deadlines + controller-runtime 交叉注入 + loopback  [FIRST public]
 → C7 device-client requestPinnedDownload + restore-endpoint-engine + hostile/concurrency  [P2-5 端到端]
 → C8 child-process harness + version V1.42 + hardware gate (report only if real PASS)
 → C9 full npm test + multi-model + PM
```

| Commit | 可部署？ | Public `/agent/restore/*`？ | Loopback `/api/.../restore-tasks`？ |
| --- | --- | --- | --- |
| C5 | 是（listener 行为与 G0b 相同，无 restore 入口） | **否** | **否** |
| C6 | 是（完整 fail-closed：limiter→auth→admission→service→semaphore） | **是** | **是** |
| C7+ | 是（增加 client；不削弱服务端） | 是 | 是 |

---

## File Map（实现期总览）

| 动作 | 路径 | 阶段 |
| --- | --- | --- |
| Create | 本 plan | **C0** |
| Modify（已完成） | `docs/superpowers/specs/2026-07-23-linke-v142-g0c-endpoint-restore-concurrency-design.md` @ `8fa69ab` | C0 design |
| Modify | `src/error-codes.js` | **C1** |
| Modify | `test/error-codes.test.js` | C1 |
| Modify | `test/audit-integrity-monitor.test.js` | C1 |
| Modify | `test/audit-integrity-dual-write-scans.test.js` | C1 |
| Modify | `test/audit-integrity-process-lock.test.js` | C1 |
| Modify | `test/audit-integrity-process-lock-scans.test.js` | **C1**（动态 prior/current/next count pin） |
| Modify | `test/agent-audit-integrity-monitor.test.js` | C1 |
| Modify | `test/audit-integrity-dual-write-readonly-inspect.test.js` | C1 |
| Modify | `test/server-write-admission-scans.test.js` | C1 |
| Modify | `test/audit-integrity-monitor-scans.test.js` | C1 |
| Create | `src/restore-path.js`、`test/restore-path.test.js` | C1 |
| Create | `src/restore-schemas.js`、`test/restore-schemas.test.js` | C1 |
| Create | `src/restore-snapshot-reader.js`、`test/restore-snapshot-reader.test.js` | **C2** |
| Create | `src/restore-task-store.js`、`test/restore-task-store.test.js` | **C2** |
| Create | `src/restore-endpoint-state.js`、`test/restore-endpoint-state.test.js` | **C3** |
| Create | `src/restore-fingerprint.js`、`test/restore-fingerprint.test.js` | C3 |
| Create | `src/restore-staging.js`、`test/restore-staging.test.js` | C3 |
| Create | `src/restore-publish.js`、`test/restore-publish.test.js` | **C4** |
| Create | `test/restore-crash-truth-tables.test.js` | **C4**（固定独立文件） |
| Modify | `src/upload-locks.js`、`test/upload-locks.test.js` | **C5**（注释/语义：live binary only） |
| Modify | `src/upload-service.js`、`test/upload-service.test.js` | **C5**（**P1-1** 移出 create/finalize 的 `runTransfer`；**P1-2** `findActiveRestore`） |
| Create | `src/restore-service.js`、`test/restore-service.test.js` | **C5** |
| Create | `test/restore-upload-admission.test.js` | **C5**（固定；**P1-1/P1-2** 表驱动） |
| Modify | `src/agent-listener.js`、`test/agent-listener.test.js` | **C6** |
| Create | `test/restore-agent-routes.test.js` | **C6** |
| Modify | `test/upload-agent-routes.test.js` | **C6**（active restore 时 **upload create admission** → `upload-session-conflict`） |
| Modify | `src/server.js` | **C6** |
| Modify | `test/server.test.js` | **C6** |
| Modify | `test/server-write-admission.test.js` | **C6** |
| Modify | `test/server-write-admission-scans.test.js` | **C6** |
| Modify | `src/controller-runtime.js`、`test/controller-runtime.test.js` | **C6**（共享 locks + 交叉注入 probe） |
| Modify | `src/device-client.js`、`test/device-client.test.js` | **C7** |
| Create | `src/restore-endpoint-engine.js` | **C7**（固定独立文件） |
| Create | `test/restore-client.test.js`、`test/restore-concurrency.test.js` | **C7** |
| Create | `test/helpers/g0c-auto-common.js` | **C8** |
| Create | `test/helpers/g0c-auto-controller-runner.js` | **C8** |
| Create | `test/helpers/g0c-auto-endpoint-runner.js` | **C8** |
| Create | `test/g0c-auto-harness.test.js` | **C8** |
| Create（仅真实 PASS） | `docs/superpowers/reports/2026-07-23-g0c-real-lan-restore-concurrency-acceptance.md` | C8 |
| Modify（V1.42 current surface） | `src/version.js`、`README.md`、`test/readme.test.js`、`test/gold-readiness.test.js`、`src/gold-readiness.js`、`test/version.test.js` | **C8** |
| Modify | `test/g0b-real-acceptance.test.js`（**固定**；当前版本断言 → V1.42/G0c surface；**保留** `V141_SIGNATURE` 与 G0b real-LAN absent 历史断言） | **C8** |
| — | 全量 `npm test` + GLM/Qwen/fresh Kimi/Codex PM | **C9** |

**禁止本计划触碰：** `package-lock.json`、`.superpowers`、`.env*`、`secrets/`、`credentials/`、Gold 9-item 状态分布（无 real PASS 时）。

---

## 回滚锚点

| 锚点 | 用途 |
| --- | --- |
| `8fa69ab` | design 已入库的干净 docs 基线；实现前 HEAD |
| 每 C 的建议 commit | 独立 `git revert` 该 C |
| Controller `.../restore-tasks/<taskId>/TASK.json` | 不可变任务；禁止 rewrite |
| Controller `.../STATUS.json` | 可变；可按状态机回滚语义修复（非删 task） |
| Endpoint `endpointDataDir/restore-tasks/<taskId>/STATE.json` | 崩溃恢复 SoT；损坏 → fail-close |
| Endpoint `RECEIPT.json` / `CLEANUP-RECEIPT.json` | 业务/清理 tombstone；cleanup ACK 前保留 |
| 同级 `.<safeTaskId>.linke-restore-staging/` | 未发布树；仅 cancelled-local 或 cleanup-intent 可删 |
| 同级 `.<safeTaskId>.linke-restore-anchor/` | 旧 target 锚点；**未** cleanupAuthorized 前禁止删 |
| 同级 `.<safeTaskId>.linke-restore-quarantine/` | 失败 published 树；cleanup-intent 才删 |
| Global live-transfer semaphore | 进程内；仅 putChunk + chunk GET；abort/timeout settle 释放 |

**回滚规则：** 可删未 cleanup-authorized 的 **未发布 staging**（cancel 路径）；**禁止**无授权删除 anchor/quarantine/其他 task 工件；**禁止** EXDEV 复制降级；**禁止**自动删除未知身份目录。文档 C0 回滚 = 删除本 plan（design 已在 `8fa69ab`）。

---

## 外部硬件门

| 门 | Env / 条件 | 缺席行为 |
| --- | --- | --- |
| 真实第二 Mac / 隔离 VM | 用户提供；`LINKE_REAL_G0C_RESTORE_ACCEPTANCE=enabled`（名称 **C8 锁死**） | **跳过**真实报告；report 文件 **must absent**；Gold **4/4/1/9** 不变 |
| 自动 child-process harness | 默认 CI 可跑；**≠** real-LAN | 可宣称 auto harness complete；**禁止**宣称 real dual-endpoint LAN complete |
| 真实 Keychain / 私网 Agent bind | 对齐 G0a 模式 | 自动测试用 inject store / 同机 TLS fixture |

**C8 冻结：** 自动 harness 完成 **不等于** real-LAN；真实硬件不可用时 **不要创建报告**；Gold 不抬。

---

## C0 — Docs Only（本轮 plan）

**Files:**
- Create: `docs/superpowers/plans/2026-07-23-linke-v142-g0c-endpoint-restore-concurrency.md`（本文件）
- Design（已完成）: `docs/superpowers/specs/2026-07-23-linke-v142-g0c-endpoint-restore-concurrency-design.md` @ commit **`8fa69ab`**

**Status:** **ACCEPTED / PLAN ONLY / C0 — READY FOR C1**

- [x] **Step 1:** 完整阅读 APPROVED design（SHA-256 `d8e7234d8dade9319b08056ca9007e178217d30f483103765abacf2c9896bb55`）、G0b plan 风格、error-codes/upload-locks/upload-service/routes/controller-runtime/device-client/storage/version 与对应 tests
- [x] **Step 2:** 撰写本 plan（C0–C9 RED/GREEN、File Map、P2 六项、commit gate、硬件门）
- [x] **Step 2b:** Codex PM 自审 finding 返修（P1-1..P1-7 + format）：共享槽调用方、双向 admission、exact 文件/签名、C6 小步 GREEN、streaming 接口、唯一 error 映射
- [x] **Step 3:** 自检 markdown/path；`git diff --no-index --check /dev/null docs/superpowers/plans/2026-07-23-linke-v142-g0c-endpoint-restore-concurrency.md` 无 trailing-space 诊断；确认工作区无 src/test 变更
- [x] **Step 4 (C0 review gate):** **GLM adversarial** → **Qwen statistics** → **fresh Kimi closure reviewer（只读）** → **Codex PM verification**；**P0/P1 = 0** 才进入 Step 5。网络错误 ≠ PASS。
  - Reviewed plan SHA-256: `ee200e97df030957f68a981aecacf57bb47297d425a99e039ae8bde0ac7e7aca`
  - GLM full: PASS, P0=0, P1=0, P2=4, PLAN_READY=YES（4×P2 已返修）
  - GLM focused: PASS, P0=0, P1=0, P2=0, PLAN_READY=YES
  - Qwen full actual-repo: PASS, P0=0, P1=0, P2=2, PLAN_READY=YES（2×P2 已返修）
  - Qwen focused: SHA_CHECK=MATCH, P2_A=CLOSED, P2_B=CLOSED, PASS, P0=0, P1=0, P2=0, PLAN_READY=YES
  - Fresh Kimi compact: PASS, P0=0, P1=0, P2=0, CLOSURE_READY=YES
  - Kimi correction check: PASS / P0=P1=P2=0 / CLOSURE_READY=YES（14 codes 于 C1 注册；next=89 为 future guard）
  - Codex PM mechanical: LF/bytes clean；diff-check 无诊断；仅 plan + 无关 `?? package-lock`
  - Codex PM adjudication: **ACCEPTED**, P0=0, P1=0；Gold **BLOCKED 4/4/1/9**；M1/M2 未变
- [x] **Step 5 (PM 门禁通过后):** 本 checkbox 记录 **PM commit/push 门禁授权**；由 **enclosing PM loop** 立即以 **exact plan-only stage** 执行 commit/push（message：`docs: plan V1.42 G0c endpoint-pull restore concurrency`；禁止 package-lock）。本 plan **不**写入结果 commit hash。

**验证：** 工作区仅本 plan 变更 + 原有 `?? package-lock.json`；design 已在 `8fa69ab`；无 src/test 变更。

**Rollback:** 删除本 plan 文件；design 保留在 `8fa69ab`。

**禁止进入 C1 条件：** C0 review **未** ACCEPTED 或 P0/P1 > 0。（本 C0 gate **已 ACCEPTED**；实现从 C1 起仍须各自 RED/GREEN/PM。）

---

## C1 — Error Codes (+14→88) + Path/Schema Validators

**Files:**
- Modify: `src/error-codes.js`
- Modify: `test/error-codes.test.js`（EXPECTED count **74 → 88**；保留 `UPLOAD_ERROR_HTTP_CONTRACT` pin；新增 `RESTORE_ERROR_HTTP_CONTRACT` pin）
- Modify（count-pin exact 列表 = **9 个文件**，同 commit 全部协调到 V1.42 current=**88** 语义）:
  1. `test/error-codes.test.js`
  2. `test/audit-integrity-monitor.test.js`
  3. `test/audit-integrity-dual-write-scans.test.js`
  4. `test/audit-integrity-process-lock.test.js`
  5. `test/audit-integrity-process-lock-scans.test.js`（**动态** prior/current/next helpers + live `Object.keys(ERROR_CODES).length` pin）
  6. `test/agent-audit-integrity-monitor.test.js`
  7. `test/audit-integrity-dual-write-readonly-inspect.test.js`
  8. `test/server-write-admission-scans.test.js`
  9. `test/audit-integrity-monitor-scans.test.js`
- **`test/audit-integrity-process-lock-scans.test.js` 动态 pin 语义（V1.42 冻结，禁止只写 8 文件）：**
  - **prior = 74**（立即前序 closed-set = V1.41 G0b）
  - **current = 88**（V1.42 G0c = 74 + 14 restore）
  - **next = 89**（future after V1.42）
  - 更新该文件内 `priorClosedSetCount` / `currentClosedSetCount` / `nextClosedSetCount` 与 S7a 等 fixture 文案
  - **保留**历史 V1.40=62 等叙述为独立 historical 事实；**禁止**把 V1.40 证据改写成 88
- 执行前卫生扫描（不替代 Exact stage 列表）：`rg '\\b74\\b' test -g '*.js'`；若出现上表 9 文件外的 **registry count pin**（`Object.keys(ERROR_CODES).length === 74` 同类），**追加进本 C Exact stage paths** 并同 commit 改为 88；历史叙述中的 74 作为 prior/stale 必须标清
- Create: `src/restore-path.js`
- Create: `test/restore-path.test.js`
- Create: `src/restore-schemas.js`
- Create: `test/restore-schemas.test.js`

**Interfaces (target):**

```js
// src/error-codes.js — string-only ERROR_CODES 新增 14 键（值 kebab restore-*）：
ERROR_CODES.RESTORE_TASK_INVALID           // 'restore-task-invalid'
ERROR_CODES.RESTORE_TASK_NOT_FOUND         // 'restore-task-not-found'
ERROR_CODES.RESTORE_TASK_CONFLICT          // 'restore-task-conflict'
ERROR_CODES.RESTORE_STATE_INVALID          // 'restore-state-invalid'
ERROR_CODES.RESTORE_PATH_INVALID           // 'restore-path-invalid'
ERROR_CODES.RESTORE_INTEGRITY_FAILED       // 'restore-integrity-failed'
ERROR_CODES.RESTORE_CAPACITY_INSUFFICIENT  // 'restore-capacity-insufficient'
ERROR_CODES.RESTORE_BACKPRESSURE           // 'restore-backpressure'
ERROR_CODES.RESTORE_INTERRUPTED            // 'restore-interrupted'   // statusCode null
ERROR_CODES.RESTORE_PUBLISH_CONFLICT       // 'restore-publish-conflict'
ERROR_CODES.RESTORE_ROLLBACK_REQUIRED      // 'restore-rollback-required'
ERROR_CODES.RESTORE_ROLLBACK_FAILED        // 'restore-rollback-failed'
ERROR_CODES.RESTORE_CLEANUP_FAILED         // 'restore-cleanup-failed'
ERROR_CODES.RESTORE_RESUME_EXHAUSTED       // 'restore-resume-exhausted' // statusCode null

export const RESTORE_ERROR_HTTP_CONTRACT = Object.freeze({
  [ERROR_CODES.RESTORE_TASK_INVALID]: Object.freeze({ statusCode: 400, retryable: false }),
  [ERROR_CODES.RESTORE_TASK_NOT_FOUND]: Object.freeze({ statusCode: 404, retryable: false }),
  [ERROR_CODES.RESTORE_TASK_CONFLICT]: Object.freeze({ statusCode: 409, retryable: false }),
  [ERROR_CODES.RESTORE_STATE_INVALID]: Object.freeze({ statusCode: 500, retryable: false }),
  [ERROR_CODES.RESTORE_PATH_INVALID]: Object.freeze({ statusCode: 400, retryable: false }),
  [ERROR_CODES.RESTORE_INTEGRITY_FAILED]: Object.freeze({ statusCode: 422, retryable: false }),
  [ERROR_CODES.RESTORE_CAPACITY_INSUFFICIENT]: Object.freeze({ statusCode: 507, retryable: false }),
  [ERROR_CODES.RESTORE_BACKPRESSURE]: Object.freeze({ statusCode: 429, retryable: true }),
  [ERROR_CODES.RESTORE_INTERRUPTED]: Object.freeze({ statusCode: null, retryable: true }),
  [ERROR_CODES.RESTORE_PUBLISH_CONFLICT]: Object.freeze({ statusCode: 409, retryable: false }),
  [ERROR_CODES.RESTORE_ROLLBACK_REQUIRED]: Object.freeze({ statusCode: 409, retryable: false }),
  [ERROR_CODES.RESTORE_ROLLBACK_FAILED]: Object.freeze({ statusCode: 500, retryable: false }),
  [ERROR_CODES.RESTORE_CLEANUP_FAILED]: Object.freeze({ statusCode: 500, retryable: false }),
  [ERROR_CODES.RESTORE_RESUME_EXHAUSTED]: Object.freeze({ statusCode: null, retryable: false }),
});

// LinkeError：RESTORE_ERROR_HTTP_CONTRACT 与 UPLOAD_ERROR_HTTP_CONTRACT 同等 contract 基线；
// RESTORE_RESUME_EXHAUSTED：显式非 null statusCode → throw internal Error('invalid LinkeError options')
// RESTORE_INTERRUPTED：statusCode null + retryable true

// src/restore-path.js
export function assertStrictRelativeTarget(input: unknown): string;
export function assertSnapshotRootRelativeFilePath(input: unknown): string;
// 失败 → LinkeError(ERROR_CODES.RESTORE_PATH_INVALID) 唯一

// Error mapping 唯一表（P1-7；禁止“或/后续决定”）：
// 1. management create relativeTarget 校验失败 → restore-path-invalid
// 2. endpoint restoreRoot/relativeTarget/path 安全失败（逃逸、symlink ancestor、dev 不一致）→ restore-path-invalid
// 3. body exact-key / unknown keys / UUID / safe-int / ISO / fingerprint nullability 表违规 → restore-task-invalid
// 4. Controller 已有记录冲突（幂等 identity 冲突、receipt/cleanup 字段冲突、非法迁移）→ restore-task-conflict

// src/restore-schemas.js
export const RESTORE_CHUNK_SIZE = 8_388_608;
export const MAX_RESTORE_TASK_JSON_BYTES = 1 * 1024 * 1024;
export function projectTaskJson(input: unknown, options: { expectedTaskId: string }): Readonly<object>;
export function projectStatusJson(input: unknown, options: { expectedTaskId: string }): Readonly<object>;
export function projectReceiptObject(input: unknown): Readonly<object>;
export function projectCleanupReceipt(input: unknown): Readonly<object>;
export function projectProgressBody(input: unknown): Readonly<{
  fileIndex: number,
  chunkIndex: number,
  receivedBytes: number,
}>;
export function assertFingerprintNullability(receipt: Readonly<object>): void;
// assertFingerprintNullability 违规 → LinkeError(ERROR_CODES.RESTORE_TASK_INVALID)
```

### RED

- [ ] **Step 1:** 扩展 `test/error-codes.test.js`：
  - `Object.keys(ERROR_CODES).length === 88`（74+14）
  - 14 个新码存在、唯一 kebab、**统一 `restore-` 前缀**、string-only registry（**无** domain 字段）
  - `RESTORE_ERROR_HTTP_CONTRACT` 14 项 exact status/retryable（上表）
  - **既有** `UPLOAD_ERROR_HTTP_CONTRACT` deepEqual 回归 pin **不变**
  - `new LinkeError(RESTORE_RESUME_EXHAUSTED)` → `statusCode === null`；显式 `statusCode: 400` → throw internal `Error('invalid LinkeError options')`
  - `new LinkeError(RESTORE_INTERRUPTED)` → `statusCode === null` 且 `retryable === true`
  - `new LinkeError(RESTORE_BACKPRESSURE)` → 429 / retryable true
  - `new LinkeError(RESTORE_CAPACITY_INSUFFICIENT)` → 507 / false
  - **不**把 `DATA_RESUME_EXHAUSTED` / `UPLOAD_RESUME_EXHAUSTED` 当作 restore resume

- [ ] **Step 2:** `test/restore-path.test.js`：
  - 合法：`docs/a`、`a`、`a/b/c`
  - 非法：空、`/` 开头、`\`、空段、`.`、`..`、重复 `//`、NUL、`\n`、控制字符、UTF-8 >1024 bytes、非 string
  - 失败码 **唯一** `restore-path-invalid`
  - file path 同规则；与 relativeTarget 分 describe

- [ ] **Step 3:** `test/restore-schemas.test.js`：
  - TASK/STATUS exact-key；unknown keys → `restore-task-invalid`
  - hostile prototype getters / non-plain → `restore-task-invalid`
  - UUID / SHA-256 / ISO ms Z / safe integer 边界 → `restore-task-invalid`
  - **ReceiptObject fingerprint nullability 唯一表**（design §7.4 三合法行 + 非法组合全拒 → `restore-task-invalid`）
  - CleanupReceipt：`cancelled` ⇒ `receiptId === null`；completed/rolled-back ⇒ receiptId UUID 必填
  - progress：unknown keys / 负值 → `restore-task-invalid`
  - `chunkSize` 必须 `8388608`

- [ ] **Step 4:** Run RED（预期 **FAIL**：模块/码/contract 缺失）

```bash
node --test test/error-codes.test.js test/restore-path.test.js test/restore-schemas.test.js
```

Expected: **FAIL**（`ERR_MODULE_NOT_FOUND` 或断言 74≠88 / 缺 RESTORE_*）

### GREEN

- [ ] **Step 5:** 在 `src/error-codes.js` 注册 14 codes + `RESTORE_ERROR_HTTP_CONTRACT`；扩展 `LinkeError` 读取 restore contract（upload 行为不变）
- [ ] **Step 6:** 实现 `src/restore-path.js`、`src/restore-schemas.js`（纯函数，无 I/O）
- [ ] **Step 7:** 将 Exact Files 中 **9 个** count-pin 文件的 current pin 改为 **88**；注释写清 `74 + 14 restore = 88`。其中 `test/audit-integrity-process-lock-scans.test.js` 必须设 **prior=74 / current=88 / next=89**（helpers + S7a 类 fixture）；**不得**把 V1.40=62 历史改写成 88
- [ ] **Step 8:** Run GREEN（同 Step 4 命令）

```bash
node --test test/error-codes.test.js test/restore-path.test.js test/restore-schemas.test.js
```

Expected: **PASS**

- [ ] **Step 8b:** Run **全部 9 个** count-pin 相关测试（含动态 scans）

```bash
node --test \
  test/error-codes.test.js \
  test/audit-integrity-monitor.test.js \
  test/audit-integrity-dual-write-scans.test.js \
  test/audit-integrity-process-lock.test.js \
  test/audit-integrity-process-lock-scans.test.js \
  test/agent-audit-integrity-monitor.test.js \
  test/audit-integrity-dual-write-readonly-inspect.test.js \
  test/server-write-admission-scans.test.js \
  test/audit-integrity-monitor-scans.test.js
```

Expected: **PASS**；`Object.keys(ERROR_CODES).length === 88`；process-lock-scans prior/current/next = 74/88/89

- [ ] **Step 9:** 聚焦回归

```bash
node --test test/error-codes.test.js test/device-protocol.test.js test/audit-integrity-process-lock-scans.test.js
```

Expected: **PASS**；upload 12 码仍在

### PM / diff / status gate

- [ ] **Step 10:** **GLM adversarial** → **Qwen statistics** → **fresh Kimi closure reviewer（只读）** → **Codex PM verification**
- [ ] **Step 11:** `git status --short`：仅 C1 exact paths + `?? package-lock.json`；**未读** package-lock
- [ ] **Step 12:** 仅当 **P0/P1=0**：精确 stage 下列路径后 commit/push

**Exact stage paths:**
- `src/error-codes.js`
- `test/error-codes.test.js`
- `test/audit-integrity-monitor.test.js`
- `test/audit-integrity-dual-write-scans.test.js`
- `test/audit-integrity-process-lock.test.js`
- `test/audit-integrity-process-lock-scans.test.js`
- `test/agent-audit-integrity-monitor.test.js`
- `test/audit-integrity-dual-write-readonly-inspect.test.js`
- `test/server-write-admission-scans.test.js`
- `test/audit-integrity-monitor-scans.test.js`
- `src/restore-path.js`
- `test/restore-path.test.js`
- `src/restore-schemas.js`
- `test/restore-schemas.test.js`
- （若 Step 卫生扫描追加了额外 count-pin 文件，列全实际修改文件）

**建议 conventional commit:**
`feat: register G0c restore error codes and path/schema validators`

**Rollback:** revert 该 commit；count 回 74；process-lock-scans prior/current/next 回 62/74/75。

**禁止进入 C2：** C1 测试未绿；count pin 残留 74；`test/audit-integrity-process-lock-scans.test.js` 未更新为 74/88/89；`UPLOAD_ERROR_HTTP_CONTRACT` 被改坏；package-lock 被 stage。

---

## C2 — Snapshot Reader Adapter + Controller Task Store（TASK 不可变 / STATUS / admission / cancel / cleanupAuthorized）

**Files:**
- Create: `src/restore-snapshot-reader.js`
- Create: `test/restore-snapshot-reader.test.js`
- Create: `src/restore-task-store.js`
- Create: `test/restore-task-store.test.js`
- 依赖：C1 schemas/path；**只读** `src/storage.js` 的 `getSnapshotManifest`；**只读** `src/upload-manifest.js` 的 `projectCanonicalUploadManifest`；本 C **不改** storage/upload-manifest 语义

**证据锚点（实现须对齐；plan 冻结算法）：**
- `getSnapshotManifest(dataDir, deviceId, snapshotId)`：remote `access==='readable'` 返回已 `projectCanonicalUploadManifest` 的 frozen canonical；local 返回 `manifest.json` 原始 JSON（schemaVersion 2；`files` 为 path 字符串数组；`integrity.entries[{path,size,sha256}]`；local 的 `deviceId` 字段常为 **slug**；可含 `ipAddress`）
- 本地 createBackup 写盘形状：`storage.js` `buildSnapshotIntegrityUnderRoot` → `files` + `integrity.{algorithm,totalBytes,entries}`
- 远程 digest 权威：G0b canonical UTF-8 `JSON.stringify` + SHA-256（`projectCanonicalUploadManifest`）

**Interfaces (target):**

```js
// src/restore-snapshot-reader.js — Node ESM .js + JSDoc only（禁止 TS 注解进源码）
import { getSnapshotManifest } from './storage.js';
import { projectCanonicalUploadManifest } from './upload-manifest.js';

export const RESTORE_CHUNK_SIZE_BYTES = 8_388_608; // 与 RESTORE_CHUNK_SIZE / design §7.2 一致

/**
 * Production adapter: storage.getSnapshotManifest → task-store storageReader.
 * @param {{
 *   dataDir: string,
 *   getSnapshotManifestFn?: typeof getSnapshotManifest,
 *   projectCanonicalUploadManifestFn?: typeof projectCanonicalUploadManifest,
 * }} options
 */
export function createRestoreSnapshotReader(options) {
  // defaults: getSnapshotManifestFn = getSnapshotManifest
  //           projectCanonicalUploadManifestFn = projectCanonicalUploadManifest
  return Object.freeze({
    assertSnapshotReadable,
  });
}

// assertSnapshotReadable(deviceId, snapshotId) → Promise<{
//   manifestDigest: string,        // 64 lower hex
//   fileCount: number,             // safe int
//   totalBytes: number,            // safe int
//   files: ReadonlyArray<{
//     fileIndex: number,           // 0..n-1 dense after UTF-8 path sort
//     path: string,                // snapshot-root-relative safe path
//     size: number,
//     sha256: string,              // 64 lower hex
//     chunkCount: number,          // size===0 ? 0 : ceil(size / 8388608)
//   }>,
// }>
```

**唯一确定性规范化 / digest 算法（禁止备选算法、禁止“实现时决定”）：**

```text
assertSnapshotReadable(deviceId, snapshotId):
  1. 调用 getSnapshotManifestFn(dataDir, deviceId, snapshotId)
     - 任何 throw / 返回 null / 非 plain object → throw LinkeError(RESTORE_INTEGRITY_FAILED)
     - 不回显 raw error / path / stack
  2. 校验 raw.snapshotId === snapshotId（字符串全等）；否则 RESTORE_INTEGRITY_FAILED
  3. 从 raw 提取 files/entries（两形状共用）:
     - raw.files 必须为 path 字符串 dense 数组（remote canonical 与 local 均如此）
     - raw.integrity 必须为 plain object；algorithm === 'sha256'
     - raw.integrity.entries 必须为 dense 数组，元素 exact keys path/size/sha256
     - raw.integrity.totalBytes 必须为 safe int 且等于 entries size 之和
     - 任一失败 → RESTORE_INTEGRITY_FAILED
  4. 构造 **clean** 投影输入（剥除 local-only 键，尤其 ipAddress；禁止未知顶层键进入 projector）:
     {
       schemaVersion: 2,
       snapshotId,                          // 使用参数 snapshotId
       deviceId,                            // 使用参数 deviceId（覆盖 local slug）
       createdAt: raw.createdAt,            // 须被 projector 接受；否则 integrity-failed
       files: raw.files,                    // path 字符串数组
       integrity: {
         algorithm: 'sha256',
         totalBytes: raw.integrity.totalBytes,
         entries: raw.integrity.entries,    // {path,size,sha256}[]
       },
       // 仅当 raw 自有且为 string 时可选拷贝 hostname / sourcePath；禁止拷贝 ipAddress
     }
  5. 调用 projectCanonicalUploadManifestFn(clean, { authenticatedDeviceId: deviceId })
     - 成功 → { manifest, manifestDigest }
     - 任何 throw → RESTORE_INTEGRITY_FAILED
     - 对 remote 已 readable 路径：因 deviceId/snapshotId/entries 与 COMPLETED 一致，digest **必须**复现 COMPLETED/index 权威 digest
     - 对 local：digest 为上述 clean 投影的确定性 digest（local 盘上 slug deviceId 不进入 TASK digest 输入）
  6. 以 projected.manifest.integrity.entries 的 **既有 UTF-8 path 排序** 顺序枚举：
     fileIndex = i
     path = entry.path
     size = entry.size
     sha256 = entry.sha256
     chunkCount = (size === 0) ? 0 : Math.ceil(size / RESTORE_CHUNK_SIZE_BYTES)
  7. fileCount = entries.length；totalBytes = projected.manifest.integrity.totalBytes
  8. 返回 deep-frozen 结果对象；**永不**包含 endpoint 绝对路径或 restoreRoot
```

**错误映射（唯一）：** 适配器边界上一切不可读/损坏/digest 不一致/形状非法 → **`restore-integrity-failed`**（422）。relativeTarget 非法仍由 store/create 的 `restore-path-invalid` 处理，不在本适配器。

```js
export function createRestoreTaskStore(options: {
  dataDir: string,
  now?: () => Date,
  storageReader: {
    assertSnapshotReadable: (deviceId: string, snapshotId: string) => Promise<{
      manifestDigest: string,
      fileCount: number,
      totalBytes: number,
      files: ReadonlyArray<{
        fileIndex: number,
        path: string,
        size: number,
        sha256: string,
        chunkCount: number,
      }>,
    }>,
  },
  // 生产：storageReader = createRestoreSnapshotReader({ dataDir }). 的返回值
  randomUUID?: () => string,
}): RestoreTaskStore;

// RestoreTaskStore 方法（无 HTTP）：
create(input: {
  deviceId: string,
  snapshotId: string,
  relativeTarget: string,
}): Promise<{ httpHint: 201 | 200, taskSummary: object }>;

get(input: { deviceId: string, taskId: string }): Promise<object>;

cancel(input: { deviceId: string, taskId: string }): Promise<{
  httpHint: 200 | 202,
  status: string,
  cancelRequested: boolean,
}>;

claimNext(input: {
  deviceId: string,
  hasActiveUpload: boolean,
}): Promise<{ task: null | object }>;
// hasActiveUpload===true → throw LinkeError(RESTORE_TASK_CONFLICT)
// claim 不检查/占用 global semaphore

acceptReceipt(input: {
  deviceId: string,
  taskId: string,
  receipt: object,
}): Promise<{
  ok: true,
  taskId: string,
  status: 'completed' | 'rolled-back',
  cleanupAuthorized: true,
  receiptId: string,
}>;
// sets status completed|rolled-back, cleanupAuthorized=true；绝不设 cleaned

acceptCleanup(input: {
  deviceId: string,
  taskId: string,
  cleanupReceipt: object,
}): Promise<{
  ok: true,
  taskId: string,
  status: 'cleaned' | 'cancelled',
  cleanupId: string,
  cleanupAckAt: string,
}>;

updateProgress(input: {
  deviceId: string,
  taskId: string,
  fileIndex: number,
  chunkIndex: number,
  receivedBytes: number,
}): Promise<{ ok: true, cancelRequested: boolean }>;
// receivedBytes 回拨 → RESTORE_TASK_INVALID

listAdmissionNonterminal(deviceId: string): Promise<string[]>;
readTaskImmutable(deviceId: string, taskId: string): Promise<object>;
buildTaskFilesPayload(deviceId: string, taskId: string): Promise<object>;
hasActiveRestore(deviceId: string): Promise<boolean>;
// hasActiveRestore: STATUS.status ∈ {pending, active}
```

**布局：** `dataDir/repo/devices/<slug>/restore-tasks/<taskId>/{TASK.json,STATUS.json}`
**权限：** 文件 0600 / 目录 0700；no-follow；symlink/type swap → `restore-state-invalid`。

### RED

- [ ] **Step 1:** 编写 `test/restore-snapshot-reader.test.js`（先于 store）：
  - **remote-upload 真实形状：** 经 `getSnapshotManifest` 返回的 canonical（`files[]` path 字符串 + `integrity.entries`）→ digest 与 `projectCanonicalUploadManifest` 一致；fileIndex 0..n-1 dense；path 安全相对；`chunkCount` 对 size=0 为 0、对非零为 `ceil(size/8388608)`
  - **legacy/local 真实形状：** schemaVersion 2 + slug `deviceId` + 可选 `ipAddress` + integrity entries → clean 投影后 digest **确定性**（同 fixture 两次调用 equal）；**不**把 `ipAddress` 带入 TASK
  - ordering：entries 最终顺序 = projector UTF-8 path sort
  - corrupt / missing integrity / size 和 totalBytes 不一致 / 坏 sha256 / 不安全 path → **唯一** `restore-integrity-failed`
  - `getSnapshotManifestFn` throw `UPLOAD_INTEGRITY_FAILED` 或任意 Error → **唯一** `restore-integrity-failed`
  - 结果对象无 absolute path 字段

- [ ] **Step 2:** Run RED（reader）

```bash
node --test test/restore-snapshot-reader.test.js
```

Expected: **FAIL**（`ERR_MODULE_NOT_FOUND`）

- [ ] **Step 3:** 编写 `test/restore-task-store.test.js`（注入 mock 或真实 `createRestoreSnapshotReader`）：
  - create：write TASK 后字段不可变（二次写不同字段 fail-close → `restore-state-invalid`）
  - STATUS 初始：`pending`、`cleanupAuthorized=false`、receipt/cleanup null
  - 幂等键 `(deviceId, snapshotId, relativeTarget)` + 权威 manifestDigest：同 identity nonterminal → httpHint 200；不同 → `restore-task-conflict`
  - terminal 后允许新建不同 taskId
  - admission one-active：第二不同 identity create → `restore-task-conflict`
  - cancel 表：pending → httpHint 200 cancelled；active → httpHint 202 仍 active + cancelRequested；completed → `restore-task-conflict`
  - acceptReceipt completed → status completed + cleanupAuthorized true + **status ≠ cleaned** + receipt 保留
  - acceptCleanup completed → cleaned **且 receipt 仍在**
  - acceptCleanup cancelled 要求 active+cancelRequested + receiptId null → cancelled+cleanupAckAt **≠ cleaned**
  - 跨 device get/claim/receipt → `restore-task-not-found`
  - progress 回拨 → `restore-task-invalid`
  - snapshot 不可读（reader 抛 integrity-failed）→ create `restore-integrity-failed`；参数非法 relativeTarget → `restore-path-invalid`；body 型字段非法由上层 schema → `restore-task-invalid`
  - GET task JSON 估算 > 1 MiB → create `restore-task-invalid`
  - 0600/0700 + symlink swap → `restore-state-invalid`
  - create 调用 `storageReader.assertSnapshotReadable` 一次且 TASK 写入其 digest/files 元数据

- [ ] **Step 4:** Run RED（store）

```bash
node --test test/restore-task-store.test.js
```

Expected: **FAIL**（`ERR_MODULE_NOT_FOUND` 或缺 export）

### GREEN

- [ ] **Step 5:** 实现 `src/restore-snapshot-reader.js` 按上表 **唯一** 算法；默认绑定真实 `getSnapshotManifest` + `projectCanonicalUploadManifest`
- [ ] **Step 6:** Run GREEN（reader）

```bash
node --test test/restore-snapshot-reader.test.js
```

Expected: **PASS**

- [ ] **Step 7:** 实现 store：atomic exclusive create TASK；atomic replace STATUS；create 经 `storageReader.assertSnapshotReadable`
- [ ] **Step 8:** create **不**检查 active upload（design 冻结）；claim 侧 `hasActiveUpload` 由调用方传入
- [ ] **Step 9:** 导出 `hasActiveRestore(deviceId)` 供 C5 upload probe 使用
- [ ] **Step 10:** Run GREEN（store + reader）

```bash
node --test test/restore-snapshot-reader.test.js test/restore-task-store.test.js
```

Expected: **PASS**

- [ ] **Step 11:** 聚焦回归

```bash
node --test test/restore-schemas.test.js test/error-codes.test.js test/upload-storage-compat.test.js
```

Expected: **PASS**（storage getSnapshotManifest 行为不回归）

### PM / diff / status gate

- [ ] **Step 12:** **GLM adversarial** → **Qwen statistics** → **fresh Kimi closure reviewer（只读）** → **Codex PM verification**
- [ ] **Step 13:** 仅当 **P0/P1=0**：exact stage 后 commit/push

**Exact stage paths:**
- `src/restore-snapshot-reader.js`
- `test/restore-snapshot-reader.test.js`
- `src/restore-task-store.js`
- `test/restore-task-store.test.js`

**建议 commit:**
`feat: add G0c restore snapshot reader and controller task store`

**Rollback:** revert C2 commit。

**禁止进入 C3：** receipt ACK 直接 cleaned；cancel active 误标 cancelled；TASK 可变；暴露 HTTP；缺 `restore-snapshot-reader` 或 create 绕过 reader 直接读盘。

---

## C3 — Endpoint STATE 机 + Staging I/O + Fingerprints（**P2-5 基础**）

**Files:**
- Create: `src/restore-endpoint-state.js`
- Create: `test/restore-endpoint-state.test.js`
- Create: `src/restore-fingerprint.js`
- Create: `test/restore-fingerprint.test.js`
- Create: `src/restore-staging.js`
- Create: `test/restore-staging.test.js`

**Interfaces (target):**

```js
// restore-endpoint-state.js — design §10.3 精确 17 个 phase；禁止别名
export const ENDPOINT_PHASES = Object.freeze([
  'planned',
  'receiving',
  'staging-verified',
  'anchor-intent',
  'anchored',
  'publish-intent',
  'published',
  'completed-awaiting-ack',
  'rollback-intent',
  'failed-target-quarantined',
  'anchor-restored',
  'old-fingerprint-verified',
  'rolled-back-awaiting-ack',
  'cancelled-local',
  'cleanup-intent',
  'cleanup-completed-awaiting-ack',
  'cleaned',
]);

export function createEndpointRestoreStateStore(options: {
  endpointDataDir: string,
  now?: () => Date,
}): EndpointRestoreStateStore;

// EndpointRestoreStateStore:
openOrCreateState(init: object): Promise<object>;
readState(taskId: string): Promise<object>;
writeState(taskId: string, patch: object, writeOptions: { fsync: true }): Promise<object>;
writeReceipt(taskId: string, receipt: object): Promise<void>;
writeCleanupReceipt(taskId: string, cleanupReceipt: object): Promise<void>;
readTombstone(taskId: string): Promise<object>;
transitionPhase(taskId: string, from: string, to: string): Promise<object>;
// 非法边 → RESTORE_STATE_INVALID

recordDurableProgress(taskId: string, progress: {
  fileIndex: number,
  chunkIndex: number,
  receivedBytes: number,
}): Promise<object>;
// 仅在 chunk 完整落盘 + fsync 文件 + fsync STATE 后调用
// 拒绝 receivedBytes < state.receivedBytes（P2-5）

recoverReceiving(taskId: string, stagingRoot: string, files: ReadonlyArray<object>): Promise<object>;
// STATE.receivedBytes 声称 durable 但 staging 缺损 → RESTORE_INTEGRITY_FAILED 或 STATE 结构损坏时 RESTORE_STATE_INVALID
// 唯一映射：文件内容/缺文件/短读 → RESTORE_INTEGRITY_FAILED；STATE JSON 损坏 → RESTORE_STATE_INVALID
// 绝不把 receivedBytes 改小写回

// restore-fingerprint.js
import { createHash as defaultCreateHash } from 'node:crypto';
import * as defaultFsOps from 'node:fs/promises';

export async function computeStructureFingerprint(
  rootDir: string,
  options: {
    fsOps?: typeof defaultFsOps,
    createHash?: typeof defaultCreateHash,
  } = {},
): Promise<string>;

export async function computeContentSha256(
  rootDir: string,
  options: {
    fsOps?: typeof defaultFsOps,
    createHash?: typeof defaultCreateHash,
  } = {},
): Promise<string>;
// empty tree contentSha256 === e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
// walk 遇 symlink → RESTORE_INTEGRITY_FAILED（fingerprint 计算路径）；preflight ancestor symlink → RESTORE_PATH_INVALID（staging/preflight 路径）

// restore-staging.js
export function deriveSiblingNames(taskId: string): {
  stagingName: string,
  anchorName: string,
  quarantineName: string,
};
// safeTaskId 必须匹配 UUID 正则且仅 [0-9a-f-]；否则 RESTORE_TASK_INVALID（endpoint 本地 STATE 损坏则 RESTORE_STATE_INVALID）

export async function preflightTarget(input: {
  restoreRoot: string,
  relativeTarget: string,
}): Promise<{
  targetPathAbs: string,
  parentPathAbs: string,
  stagingPathAbs: string,
  anchorPathAbs: string,
  quarantinePathAbs: string,
  originalTargetExisted: boolean,
  parentDev: number,
  targetDev: number | null,
}>;
// abs 仅进程内；禁止写入 STATE 可序列化字段 / 日志 allowlist
// 失败码唯一 RESTORE_PATH_INVALID

export async function materializeChunkToStaging(input: {
  stagingRoot: string,
  filePath: string,
  chunkIndex: number,
  chunkSize: number,
  bytes: Buffer,
  expectedSha256: string,
}): Promise<void>;

export async function verifyStagingTree(input: {
  stagingRoot: string,
  files: ReadonlyArray<{ path: string, size: number, sha256: string }>,
}): Promise<void>;

export async function assertCapacity(input: {
  remainingStagingBytes: number,
  totalBytes: number,
  freeBytes: number | null,
}): void;
// requiredBytes = remainingStagingBytes + max(64MiB, ceil(totalBytes * 0.05))
// 不加 oldTargetBytes；freeBytes===null → RESTORE_CAPACITY_INSUFFICIENT
```

### RED

- [ ] **Step 1:** phase 枚举闭集 17 个 exact string；非法 phase 写入 → `restore-state-invalid`
- [ ] **Step 2:** STATE 0600；禁止序列化 absolute target/staging/anchor 字段
- [ ] **Step 3:** fingerprint：双文件树确定性；symlink → `restore-integrity-failed`；empty content sha 常量
- [ ] **Step 4:** staging 按 `files[].path` 建树；no-follow；chunk size/sha 不匹配 → `restore-integrity-failed`
- [ ] **Step 5:** capacity 公式单测；**无** oldTargetBytes 项
- [ ] **Step 6:** **P2-5：** `recordDurableProgress` 拒绝回拨；仅内存更大 progress 未 fsync 不得进入 STATE
- [ ] **Step 7:** **P2-5：** STATE.receivedBytes=N 但 staging 缺文件/短读 → `recoverReceiving` → `restore-integrity-failed`；**不**把 receivedBytes 改小写入
- [ ] **Step 8:** Run RED

```bash
node --test test/restore-endpoint-state.test.js test/restore-fingerprint.test.js test/restore-staging.test.js
```

Expected: **FAIL**（模块缺失）

### GREEN

- [ ] **Step 9:** 实现三个模块；状态写路径强制 `fsync: true`
- [ ] **Step 10:** Run GREEN

```bash
node --test test/restore-endpoint-state.test.js test/restore-fingerprint.test.js test/restore-staging.test.js
```

Expected: **PASS**

- [ ] **Step 11:** 聚焦回归

```bash
node --test test/restore-task-store.test.js test/restore-path.test.js
```

Expected: **PASS**

### PM / diff / status gate

- [ ] **Step 12:** **GLM adversarial** → **Qwen statistics** → **fresh Kimi closure reviewer（只读）** → **Codex PM verification**
- [ ] **Step 13:** 仅当 **P0/P1=0**：exact stage 后 commit/push

**Exact stage paths:**
- `src/restore-endpoint-state.js`
- `test/restore-endpoint-state.test.js`
- `src/restore-fingerprint.js`
- `test/restore-fingerprint.test.js`
- `src/restore-staging.js`
- `test/restore-staging.test.js`

**建议 commit:**
`feat: add G0c endpoint restore state staging and fingerprints`

**Rollback:** revert C3。

**禁止进入 C4：** progress 可回拨；absolute path 进入 STATE JSON；缺 phase 枚举。

---

## C4 — Dual-Rename Publish + Rollback + Crash Truth Tables（**P2-1..P2-4 主落地**）

**Files:**
- Create: `src/restore-publish.js`
- Create: `test/restore-publish.test.js`
- Create: `test/restore-crash-truth-tables.test.js`（**固定独立文件**；禁止合并进 publish 单文件）

**Interfaces (target):**

```js
export async function publishFromStagingVerified(ctx: {
  stateStore: object,
  paths: {
    targetPathAbs: string,
    stagingPathAbs: string,
    anchorPathAbs: string,
    quarantinePathAbs: string,
  },
  originalTargetExisted: boolean,
  oldStructureFingerprint: string | null,
  oldContentSha256: string | null,
  cancelRequested: boolean,
  rename: (from: string, to: string) => Promise<void>,
  lstat: (path: string) => Promise<{ isDirectory: () => boolean, isSymbolicLink: () => boolean }>,
}): Promise<object>; // ReceiptObject

export async function rollbackPublished(ctx: {
  stateStore: object,
  paths: object,
  originalTargetExisted: boolean,
  oldStructureFingerprint: string | null,
  oldContentSha256: string | null,
  rename: (from: string, to: string) => Promise<void>,
  lstat: (path: string) => Promise<object>,
}): Promise<object>; // ReceiptObject outcome=rolled-back

export async function recoverFromCrash(ctx: {
  stateStore: object,
  paths: object,
  originalTargetExisted: boolean,
  oldStructureFingerprint: string | null,
  oldContentSha256: string | null,
  cancelRequested: boolean,
  rename: (from: string, to: string) => Promise<void>,
  lstat: (path: string) => Promise<object>,
  verifyStagingTree: () => Promise<void>,
  reFetchForbidden: true,
}): Promise<{ action: string, phase: string, receipt?: object }>;

export async function recoverCancelledLocal(ctx: {
  stateStore: object,
  stagingPathAbs: string,
  taskId: string,
  deviceId: string,
  cleanupId: string | null,
  rm: (path: string, opts: { recursive: true, force: true }) => Promise<void>,
}): Promise<object>; // CleanupReceipt outcome=cancelled；cleanupId 稳定重放
```

**唯一 error 映射（P1-7）：**
- anchored 非法存在性组合（含 symlink/非 directory）→ **唯一** `restore-state-invalid`
- publish-intent `(target=yes, staging=yes)` → **唯一** `restore-publish-conflict`
- publish-intent `(target=no, staging=no)` → **唯一** `restore-state-invalid`
- rollback 目录存在性歧义 → **唯一** `restore-state-invalid`
- **EXDEV 唯一映射（design §6.3）：** pre-publish 的 `target→anchor` 或 `staging→target` rename 若实际返回 EXDEV → **唯一** `restore-path-invalid` fail-close；STATE **保留** durable intent；**零** copy。rollback 路径 rename 失败 → **唯一** `restore-rollback-failed`。回滚后 fingerprint mismatch → **唯一** `restore-rollback-failed`

### RED — 必须含完整真值表

- [ ] **Step 1:** 成功路径写在 `test/restore-publish.test.js`：
  - original existed：anchor 出现、receipt completed 双 fingerprint non-null、`anchorPresentBeforePublish=true`
  - original absent：无伪 anchor、completed 双 hex、`anchorPresentBeforePublish=false`

- [ ] **Step 2:** 非 zero-gap：hook 计数证明两 rename 之间允许 target absent 窗口；**不**断言 single-syscall exchange

- [ ] **Step 3:** EXDEV：pre-publish mock rename EXDEV → **唯一** `restore-path-invalid`；STATE 仍保留 durable intent；**零** copy 调用计数

- [ ] **Step 4:** Cancel 线性化 canary：`phase=anchor-intent` + target=yes + anchor=no + cancelRequested=true → **不得** `cancelled-local`；必须继续 publish；结局 completed 或 rolled-back

- [ ] **Step 5: P2-2** 在 `test/restore-crash-truth-tables.test.js`：anchored 存在性全矩阵；非法 → **唯一** `restore-state-invalid`

- [ ] **Step 6: P2-1** 同文件 `test/restore-crash-truth-tables.test.js`：
  - rollback 三元目录全矩阵；歧义 → **唯一** `restore-state-invalid`
  - fingerprint mismatch after rollback → **唯一** `restore-rollback-failed`
  - **新增：** mock rollback 路径 `rename` **抛错**（非仅 fingerprint mismatch）→ **唯一** `restore-rollback-failed`；staging/anchor/quarantine/target **不自动删除**（目录/工件保留）

- [ ] **Step 7:** publish-intent 四象限：
  - (N,Y) 重试 rename
  - (Y,N) 写 published 并全量重验
  - (Y,Y) → `restore-publish-conflict`
  - (N,N) → `restore-state-invalid`

- [ ] **Step 8: P2-4** anchor-intent staging 重校验失败：不 re-fetch、不 publish、不删除；可证原状 → rolled-back receipt；歧义 → `restore-state-invalid`

- [ ] **Step 9: P2-3** cancelled-local crash：半删 staging / 未写 CleanupReceipt / 已写未 ACK；同 cleanupId 重放；禁止从 anchor-intent+ 恢复成 cancelled-local

- [ ] **Step 10:** Run RED

```bash
node --test test/restore-publish.test.js test/restore-crash-truth-tables.test.js
```

Expected: **FAIL**（模块缺失）

### GREEN

- [ ] **Step 11:** 实现 `src/restore-publish.js`：仅用 `fs.promises.rename`；每次 rename 后 lstat；STATE fsync 在每个 intent/phase
- [ ] **Step 12:** `recoverFromCrash` 纯表驱动；default 分支 `restore-state-invalid`
- [ ] **Step 13:** Run GREEN

```bash
node --test test/restore-publish.test.js test/restore-crash-truth-tables.test.js
```

Expected: **PASS**

- [ ] **Step 14:** 聚焦回归

```bash
node --test test/restore-fingerprint.test.js test/restore-staging.test.js test/restore-endpoint-state.test.js
```

Expected: **PASS**

### PM / diff / status gate

- [ ] **Step 15:** **GLM adversarial** → **Qwen statistics** → **fresh Kimi closure reviewer（只读）** → **Codex PM verification**（审查员核对 **P2-1..P2-4** 是否完整枚举；缺一行 = P1）
- [ ] **Step 16:** 仅当 **P0/P1=0**：exact stage 后 commit/push

**Exact stage paths:**
- `src/restore-publish.js`
- `test/restore-publish.test.js`
- `test/restore-crash-truth-tables.test.js`

**建议 commit:**
`feat: implement G0c dual-rename publish rollback and crash recovery`

**Rollback:** revert C4。

**禁止进入 C5：** 真值表缺行；cancel canary 失败；EXDEV 复制降级；public routes。

---

## C5 — Shared Live-Transfer 收紧 + Bidirectional Admission + Restore Service（**NO public routes**）

**Files:**
- Modify: `src/upload-locks.js`
- Modify: `test/upload-locks.test.js`
- Modify: `src/upload-service.js`（**P1-1** + **P1-2**）
- Modify: `test/upload-service.test.js`（**P1-1** + **P1-2**）
- Create: `src/restore-service.js`
- Create: `test/restore-service.test.js`
- Create: `test/restore-upload-admission.test.js`（**固定**；P1-1/P1-2 表驱动）
- **不**修改 `src/agent-listener.js` 路由注册；**不**修改 `src/server.js` 管理面；**不**在 `src/controller-runtime.js` 生产装配 restore routes

**既有 locks 接口（禁止发明新方法名）：**

```js
// src/upload-locks.js — 保持导出形状
export function createUploadLocks(options?: { maxGlobalTransfers?: number }): {
  maxGlobalTransfers: number,
  runTransfer: (task: () => unknown) => Promise<unknown>,
  runDevice: (deviceId: string, task: () => unknown) => Promise<unknown>,
  runSession: (deviceId: string, uploadId: string, task: () => unknown) => Promise<unknown>,
  runSnapshot: (deviceId: string, snapshotId: string, task: () => unknown) => Promise<unknown>,
};
// 注释更新：runTransfer = live binary only（G0b putChunk + G0c chunk GET）
// 默认 4；合法 1..16；0/17 构造 throw Error('invalid maxGlobalTransfers')
```

**upload-service 变更（P1-1 必须）：**

```js
// 当前事实：create 与 finalize 错误地使用 locks.runTransfer；status/abort 已不占槽。
// C5 目标：
// create  → 仅 locks.runDevice(deviceId, ...) 包围 admission + createSession；**无** runTransfer
// status  → 保持不占 runTransfer
// putChunk → 保留 locks.runTransfer → runSession
// finalize → 仅 runSession → runSnapshot；**无** runTransfer
// abort   → 保持 runSession only

export function createUploadService(options: {
  dataDir: string,
  store: object,
  locks: ReturnType<typeof createUploadLocks>,
  ingest: object,
  commit: object,
  now: () => Date,
  // now 与现有构造器一致：required（不是可缺省）
  findActiveRestore?: (deviceId: string) => boolean | Promise<boolean>,
  // findActiveRestore 缺省：async () => false（仅 C5 旧调用兼容）
  // C6 生产注入为强制：findActiveRestore: (id) => restoreTaskStore.hasActiveRestore(id)
  // C6 测试门必须证明生产路径显式注入，不得依赖缺省 false
}): {
  create: Function,
  status: Function,
  putChunk: Function,
  finalize: Function,
  abort: Function,
};

// create 伪码约束（禁止 TOCTOU）：
// return locks.runDevice(deviceId, async () => {
//   if (await findActiveRestore(deviceId)) throw new LinkeError(UPLOAD_SESSION_CONFLICT);
//   // 既有 active-upload session 检查 + createSession 均在此临界区内
// });
```

**restore-service：**

```js
export function createRestoreService(options: {
  taskStore: object,
  locks: ReturnType<typeof createUploadLocks>,
  storageReader: object,
  now?: () => Date,
  findActiveUpload: (deviceId: string) => boolean | Promise<boolean>,
}): RestoreService;

// RestoreService（无 HTTP）：
claim(input: { deviceId: string }): Promise<{ task: null | object }>;
// 必须：
// return locks.runDevice(deviceId, async () => {
//   if (await findActiveUpload(deviceId)) throw new LinkeError(RESTORE_TASK_CONFLICT);
//   return taskStore.claimNext({ deviceId, hasActiveUpload: false }); // 已在临界区内查过 upload
// });
// 注：hasActiveUpload 实参在临界区内以 findActiveUpload 结果为准，禁止临界区外先查再进区

getTask(input: { deviceId: string, taskId: string }): Promise<object>;
// files[] 含 path；cancelRequested；cleanupAuthorized；**不**调用 runTransfer

getChunk(input: {
  deviceId: string,
  taskId: string,
  fileIndex: number,
  chunkIndex: number,
}): Promise<{
  body: Buffer,
  headers: {
    contentType: 'application/octet-stream',
    contentLength: number,
    taskId: string,
    fileIndex: number,
    chunkIndex: number,
    chunkOffset: number,
    chunkSize: number,
    chunkSha256: string,
  },
}>;
// 内部：
// try {
//   return await locks.runTransfer(async () => { /* read+hash */ });
// } catch (err) {
//   // 仅此边界：runTransfer 满载抛既有 upload-backpressure
//   if (err instanceof LinkeError && err.code === ERROR_CODES.UPLOAD_BACKPRESSURE) {
//     throw new LinkeError(ERROR_CODES.RESTORE_BACKPRESSURE);
//   }
//   throw err; // 其它错误不换码
// }
// 禁止：把非 backpressure 错误映射为 restore-backpressure

updateProgress(input: {
  deviceId: string,
  taskId: string,
  fileIndex: number,
  chunkIndex: number,
  receivedBytes: number,
}): Promise<{ ok: true, cancelRequested: boolean }>;

acceptReceipt(input: {
  deviceId: string,
  taskId: string,
  receipt: object,
}): Promise<{
  ok: true,
  taskId: string,
  status: 'completed' | 'rolled-back',
  cleanupAuthorized: true,
  receiptId: string,
}>;

acceptCleanup(input: {
  deviceId: string,
  taskId: string,
  cleanupReceipt: object,
}): Promise<{
  ok: true,
  taskId: string,
  status: 'cleaned' | 'cancelled',
  cleanupId: string,
  cleanupAckAt: string,
}>;

createTask(input: {
  deviceId: string,
  snapshotId: string,
  relativeTarget: string,
}): Promise<{ httpHint: 201 | 200, taskSummary: object }>;
// **冻结：** createTask **不**调用 `findActiveUpload`；Controller **允许** pending restore
// 与 active upload 并存。真正 upload/restore admission 仅在 endpoint `claim`
//（check+mutation 同一次 `locks.runDevice`）。禁止实现者把 active-upload 检查塞进 createTask。

cancelTask(input: {
  deviceId: string,
  taskId: string,
}): Promise<{ httpHint: 200 | 202, status: string, cancelRequested: boolean }>;

getStatus(input: { deviceId: string, taskId: string }): Promise<object>;

hasActiveRestore(deviceId: string): Promise<boolean>;
```

### RED

- [ ] **Step 1:** `test/upload-locks.test.js`：默认 4；第 5 个并行 `runTransfer` → `upload-backpressure`；0/17 构造失败；16 可构造

- [ ] **Step 2:** `test/upload-service.test.js` **P1-1**：
  - 占满 global slot（4 个挂起 `runTransfer`）时：`create` / `status` / `finalize` / `abort` **均不得**抛 `upload-backpressure`
  - 同条件下 `putChunk` **必须**抛 `upload-backpressure`
  - create/finalize 源码路径不再包 `runTransfer`（可用 spy：`runTransfer` call count 在 create/finalize 为 0）

- [ ] **Step 3:** `test/upload-service.test.js` **P1-2**：
  - `findActiveRestore` 返回 true → create → `upload-session-conflict`
  - `findActiveRestore` 缺省 false 时旧行为不回归
  - admission check 与 createSession 在同一 `runDevice` 临界区（竞态测试：restore claim 与 upload create 并发，仅一方成功）

- [ ] **Step 4:** `test/restore-service.test.js`：
  - claim 成功路径；无 pending → `{ task: null }`
  - `findActiveUpload` true → claim → `restore-task-conflict`
  - **createTask 在 active upload 下仍可成功创建 pending**（`findActiveUpload` **不被** createTask 调用；spy call count 0）
  - **getChunk backpressure 换码 pin：** mock `locks.runTransfer` 抛 `LinkeError(UPLOAD_BACKPRESSURE)` → getChunk 对外 **唯一** `restore-backpressure`；输入码 `upload-backpressure`，输出码 `restore-backpressure`
  - getChunk 其它 `LinkeError` / 非 LinkeError **原样抛出、不换码**
  - claim/getTask/updateProgress/acceptReceipt/acceptCleanup/createTask **不**调用 `runTransfer`（spy count 0）
  - getChunk **调用** `runTransfer` 且 settle 后释放
  - **无 public restore route（本 C 固定写入本文件）：** 在 `test/restore-service.test.js` 内构造 `createAgentListener`（**不**传 `restoreService`）并对 `POST /agent/restore/tasks/claim` 断言 **404**；**不**修改 `test/agent-listener.test.js`（该文件不在 C5 Exact stage）

- [ ] **Step 5:** `test/restore-upload-admission.test.js` 表驱动（P1-1 + P1-2）：

| # | 场景 | 期望 |
| --- | --- | --- |
| A | global slot 满 | upload create/status/finalize/abort 成功或既有业务错误；**非** upload-backpressure |
| B | global slot 满 | putChunk → upload-backpressure |
| C | global slot 满 | restore claim/task/progress/receipt/cleanup **非** restore-backpressure |
| D | global slot 满 | restore getChunk → restore-backpressure |
| E | same device active restore | upload create → upload-session-conflict |
| F | same device active upload | restore claim → restore-task-conflict |
| G | same device 并发 upload create vs restore claim | 恰好一方成功；另一方 conflict |
| H | different devices | 双方 create/claim 均可成功（受全局槽限制仅影响 binary） |

- [ ] **Step 6:** Run RED

```bash
node --test test/upload-locks.test.js test/upload-service.test.js test/restore-service.test.js test/restore-upload-admission.test.js
```

Expected: **FAIL**（restore-service 模块缺失；upload create 仍占槽导致 A/C 失败；缺 findActiveRestore）

### GREEN

- [ ] **Step 7:** 修改 `src/upload-service.js`：create/finalize 移除 `runTransfer`；create 注入 `findActiveRestore` 并在 `runDevice` 内检查；`now` 保持 required
- [ ] **Step 8:** 更新 `src/upload-locks.js` 注释：live binary only
- [ ] **Step 9:** 实现 `src/restore-service.js`：
  - claim：`runDevice` 内 `findActiveUpload` + claimNext（check+mutation 同临界区）
  - **createTask：只委托 taskStore.create；禁止调用 `findActiveUpload`**
  - getChunk：仅用 `runTransfer`；**仅** catch `UPLOAD_BACKPRESSURE` → throw `RESTORE_BACKPRESSURE`；其它错误不换码
- [ ] **Step 10:** 在 `test/restore-service.test.js` 落地（见 RED Step 4）：
  - 无 `restoreService` 时 claim **404**
  - getChunk：输入 `upload-backpressure` → 输出 `restore-backpressure` pin
  - createTask 不调用 `findActiveUpload` pin
- [ ] **Step 11:** 完成 `test/restore-upload-admission.test.js` 表驱动断言
- [ ] **Step 12:** Run GREEN

```bash
node --test test/upload-locks.test.js test/upload-service.test.js test/restore-service.test.js test/restore-upload-admission.test.js
```

Expected: **PASS**

- [ ] **Step 13:** 聚焦回归（仅 C5 Exact 文件 + 既有 upload locks/service；**不**改 `test/agent-listener.test.js`）

```bash
node --test test/upload-service.test.js test/upload-locks.test.js
```

Expected: **PASS**；upload service 与 G0b 一致（本 C 未注册 restore public routes）

### PM / diff / status gate

- [ ] **Step 14:** **GLM adversarial** → **Qwen statistics** → **fresh Kimi closure reviewer（只读）** → **Codex PM verification**（重点：P1-1 槽占用；P1-2 TOCTOU 临界区）
- [ ] **Step 15:** 仅当 **P0/P1=0**：exact stage 后 commit/push

**Exact stage paths:**
- `src/upload-locks.js`
- `test/upload-locks.test.js`
- `src/upload-service.js`
- `test/upload-service.test.js`
- `src/restore-service.js`
- `test/restore-service.test.js`
- `test/restore-upload-admission.test.js`

**建议 commit:**
`feat: add G0c restore service and tighten live-transfer slot ownership`

**Production exposure：** **无**

**Rollback:** revert C5。

**禁止进入 C6：** putChunk 以外仍占 runTransfer；双向 admission 缺一；C5 commit 含 listener restore 生产注册；package-lock stage。

---

## C6 — First Public Exposure：Routes + Limiter + Deadlines + Runtime Wiring

**Files:**
- Modify: `src/agent-listener.js`
- Modify: `test/agent-listener.test.js`
- Create: `test/restore-agent-routes.test.js`
- Modify: `test/upload-agent-routes.test.js`
- Modify: `src/server.js`
- Modify: `test/server.test.js`
- Modify: `test/server-write-admission.test.js`
- Modify: `test/server-write-admission-scans.test.js`
- Modify: `src/controller-runtime.js`
- Modify: `test/controller-runtime.test.js`
- 注：`src/upload-service.js` / `test/upload-service.test.js` 的 **findActiveRestore + runTransfer 收紧** 必须在 **C5 完成**；C6 **不再**修改 upload-service 源文件，仅通过 controller-runtime 注入生产 probe

**Routes（同 commit 完整注入；缺一不可）：**

| 面 | Method | Path |
| --- | --- | --- |
| Agent | `POST` | `/agent/restore/tasks/claim` |
| Agent | `GET` | `/agent/restore/tasks/:taskId` |
| Agent | `GET` | `/agent/restore/tasks/:taskId/files/:fileIndex/chunks/:chunkIndex` |
| Agent | `POST` | `/agent/restore/tasks/:taskId/progress` |
| Agent | `POST` | `/agent/restore/tasks/:taskId/receipts` |
| Agent | `POST` | `/agent/restore/tasks/:taskId/cleanup` |
| Loopback | `POST` | `/api/devices/:deviceId/restore-tasks` |
| Loopback | `GET` | `/api/devices/:deviceId/restore-tasks/:taskId` |
| Loopback | `POST` | `/api/devices/:deviceId/restore-tasks/:taskId/cancel` |

**Wiring 冻结顺序（每个 Agent restore 请求）：**
0. path-aware restore IP limiter **1200/min**（独立桶）→ `device-rate-limited`
1. exact-one triad headers → auth
2. **auth 成功前禁止** body 读与 taskId lookup
3. service 调用；chunk 路径 `locks.runTransfer` / release on settle|abort|timeout
4. single-settle；`requestTimeout=0` 保持；JSON routes total **15s**；chunk total **120s**

**controller-runtime 交叉注入（P1-2 生产；接口已核实）：**
- 共享 **同一** `createUploadLocks(...)` 实例
- **Snapshot reader 生产装配（单值，禁止其它路径）：**
  ```js
  import { getSnapshotManifest } from './storage.js';
  import { createRestoreSnapshotReader } from './restore-snapshot-reader.js';
  import { createRestoreTaskStore } from './restore-task-store.js';

  const restoreSnapshotReader = createRestoreSnapshotReader({
    dataDir,
    getSnapshotManifestFn: getSnapshotManifest,
  });
  const restoreTaskStore = createRestoreTaskStore({
    dataDir,
    now,
    storageReader: restoreSnapshotReader,
  });
  ```
  - 默认形参亦可 `createRestoreSnapshotReader({ dataDir })`（内部 default = 真实 `getSnapshotManifest`）；生产须可被测试 spy
- `uploadService = createUploadService({ ..., locks, now, findActiveRestore: (id) => restoreTaskStore.hasActiveRestore(id) })`
  - `findActiveRestore` **强制显式注入**（不得依赖 C5 缺省 false）
- `restoreService = createRestoreService({ ..., locks, findActiveUpload: async (id) => (await uploadStore.findActiveSession(id)) !== null })`
  - **冻结真实接口：** `uploadStore.findActiveSession(deviceId)`（`src/upload-session-store.js` 已导出）
  - **禁止**“以实现时为准”的其它方法名
- 注入 `createAgentListener({ uploadService, restoreService, uploadRateLimit, restoreRateLimit, ... })`
- 注入 management server restore-tasks handlers
- 缺 `restoreService`：restore routes **不匹配 / 404**（与 upload 对称）
- **禁止** C5 前通过 runtime 暴露 public restore routes（不变）

### RED

- [ ] **Step 1:** 在 `test/restore-agent-routes.test.js` 写失败用例骨架（模块行为未接线时期望 FAIL）：
  - auth 失败：lookup/body 计数器 = 0
  - 跨 device 全部 restore routes → **唯一** `restore-task-not-found`
  - 重复 headers → `device-request-invalid`
  - path **不**在 URL/header；GET task body **必须**含 `files[].path`
  - chunk 满载 → `restore-backpressure` 429 + Retry-After 1..30（service 已把 upload-backpressure 译为 restore-backpressure）；timeout 释放槽
  - claim 全局满载仍 200
  - progress 回拨 → `restore-task-invalid`（**P2-5**）
  - receipt ACK：`cleanupAuthorized: true` 且 status ≠ cleaned
  - cleanup 表 §8.9；冲突 409；持久化失败 500 `restore-cleanup-failed`
  - 响应 allowlist：无 endpoint 绝对 path、stack、errno、token
  - restore 1200/min 与 G0a 60、upload 1200 **隔离**

- [ ] **Step 1b:** 管理面 create（`test/server.test.js` / `test/restore-agent-routes` 若覆盖）：
  - **active upload 存在时 management createTask 仍可 201/200 pending**
  - 注释/断言：**admission 不在 create**；仅 endpoint claim 在 `runDevice` 内 check+mutation
  - spy：createTask 路径 **零** `findActiveUpload` / `findActiveSession` 调用

- [ ] **Step 2:** `test/upload-agent-routes.test.js` 追加反向门：**active restore** 时 **upload create admission** → **唯一** `upload-session-conflict`。**不**把 existing impossible-state chunk 纳入本计划新增 admission 语义；**不**写“create/chunk 相关”。

- [ ] **Step 3:** `test/server.test.js` + `test/server-write-admission.test.js`：
  - create：write-token + audit admission **先于**写入
  - cancel 200/202 表
  - 管理面不返回 endpoint 绝对 path

- [ ] **Step 4:** `test/controller-runtime.test.js`：
  - 启动后 restore 依赖齐全
  - 缺 restoreService 时 restore 404
  - 共享 locks 实例；交叉 probe 生效
  - **pin：** restore 侧 `findActiveUpload` **确实调用** `uploadStore.findActiveSession`（spy/mock call count ≥ 1）
  - **pin：** upload 侧生产路径 **显式**注入 `findActiveRestore`（非缺省 false）
  - **pin：** 生产路径使用 `createRestoreSnapshotReader` + 真实 `getSnapshotManifest`：management create 时 spy `getSnapshotManifest` 被调用，且 TASK/create 摘要含规范化后的 `manifestDigest` / `fileCount` / `totalBytes`（真实 remote 或 local fixture 形状均可）
  - same-device 竞态仅一方成功；different devices 并行

- [ ] **Step 5:** Run RED

```bash
node --test test/restore-agent-routes.test.js test/upload-agent-routes.test.js test/agent-listener.test.js test/server.test.js test/server-write-admission.test.js test/server-write-admission-scans.test.js test/controller-runtime.test.js
```

Expected: **FAIL**（restore routes 未注册 / runtime 未注入）

### GREEN（小步；禁止单步笼统覆盖全部 routes）

- [ ] **Step 6:** 在 `src/agent-listener.js` 增加 restore route matcher + `resolveRestoreService` surface（无 service → 不匹配）

```bash
node --test test/agent-listener.test.js test/restore-agent-routes.test.js
```

Expected: 部分仍 FAIL（handlers 未完成），matcher 相关新断言开始收敛

- [ ] **Step 7:** 实现 `POST /agent/restore/tasks/claim` handler：pre-auth restore limiter → auth-before-lookup → service.claim

```bash
node --test test/restore-agent-routes.test.js
```

Expected: claim 相关用例 **PASS**；其余 routes 仍可 FAIL

- [ ] **Step 8:** 实现 `GET /agent/restore/tasks/:taskId`（files[].path + cancelRequested + cleanupAuthorized）

```bash
node --test test/restore-agent-routes.test.js
```

Expected: getTask 相关 **PASS**

- [ ] **Step 9:** 实现 chunk GET：runTransfer + identity headers + 120s deadline + timeout release

```bash
node --test test/restore-agent-routes.test.js
```

Expected: chunk/backpressure/timeout 相关 **PASS**

- [ ] **Step 10:** 实现 progress / receipts / cleanup handlers + single-settle JSON 15s

```bash
node --test test/restore-agent-routes.test.js
```

Expected: progress/receipt/cleanup 相关 **PASS**

- [ ] **Step 11:** 实现 restore IP limiter 独立桶 + timers 与 G0a/upload 隔离断言

```bash
node --test test/restore-agent-routes.test.js test/agent-listener.test.js
```

Expected: limiter 隔离 **PASS**

- [ ] **Step 12:** 在 `src/server.js` 实现 loopback create/get/cancel + write-token + required audit admission

```bash
node --test test/server.test.js test/server-write-admission.test.js test/server-write-admission-scans.test.js
```

Expected: 管理面 restore-tasks 相关 **PASS**

- [ ] **Step 13:** 在 `src/controller-runtime.js` 装配共享 locks/stores/services：
  - `createRestoreSnapshotReader({ dataDir, getSnapshotManifestFn: getSnapshotManifest })`
  - `createRestoreTaskStore({ dataDir, now, storageReader: restoreSnapshotReader })`
  - `findActiveRestore: (id) => restoreTaskStore.hasActiveRestore(id)`
  - `findActiveUpload: async (id) => (await uploadStore.findActiveSession(id)) !== null`
  - 注入 listener + management

```bash
node --test test/controller-runtime.test.js
```

Expected: **PASS**（含 `findActiveSession` call pin + snapshot-reader/`getSnapshotManifest` production pin）

- [ ] **Step 14:** upload reverse gate：仅 **create admission** under active restore

```bash
node --test test/upload-agent-routes.test.js test/restore-upload-admission.test.js
```

Expected: **PASS**

- [ ] **Step 15:** 全 C6 套件 GREEN

```bash
node --test test/restore-agent-routes.test.js test/upload-agent-routes.test.js test/agent-listener.test.js test/server.test.js test/server-write-admission.test.js test/server-write-admission-scans.test.js test/controller-runtime.test.js test/restore-upload-admission.test.js
```

Expected: **PASS**

- [ ] **Step 16:** 聚焦回归 G0a/G0b

```bash
node --test test/agent-listener.test.js test/upload-agent-routes.test.js test/device-client.test.js
```

Expected: **PASS**

### PM / diff / status gate

- [ ] **Step 17:** **GLM adversarial** → **Qwen statistics** → **fresh Kimi closure reviewer（只读）** → **Codex PM verification**（半接线 = P0）
- [ ] **Step 18:** 仅当 **P0/P1=0**：exact stage 后 commit/push

**Exact stage paths:**
- `src/agent-listener.js`
- `test/agent-listener.test.js`
- `test/restore-agent-routes.test.js`
- `test/upload-agent-routes.test.js`
- `src/server.js`
- `test/server.test.js`
- `test/server-write-admission.test.js`
- `test/server-write-admission-scans.test.js`
- `src/controller-runtime.js`
- `test/controller-runtime.test.js`

**建议 commit:**
`feat: expose fail-closed G0c restore routes via controller-runtime`

**Production exposure：** **是（首次）**

**Rollback:** revert C6 → 回到 C5 无 restore 入口。

**禁止进入 C7：** 缺 limiter/auth/admission/semaphore；receipt 直接 cleaned；双向 probe 未生产注入；package-lock stage。

---

## C7 — Pinned Download Client + Endpoint Engine + Hostile/Concurrency（**P2-5 端到端**）

**Files:**
- Modify: `src/device-client.js`
- Modify: `test/device-client.test.js`
- Create: `src/restore-endpoint-engine.js`（**固定独立文件**；禁止并入 device-client）
- Create: `test/restore-client.test.js`
- Create: `test/restore-concurrency.test.js`
- Modify: `docs/superpowers/specs/2026-07-23-linke-v142-g0c-endpoint-restore-concurrency-design.md`（**multi-chunk frozen-wire / local-resume** contract clarification）
- Modify: `docs/superpowers/plans/2026-07-23-linke-v142-g0c-endpoint-restore-concurrency.md`（**multi-chunk frozen-wire / local-resume** contract clarification；本文件 C7 Interfaces/流程）

**Interfaces (target):**

```js
// src/device-client.js — 新增；不替换既有 requestPinnedBinary（仍用于有界 JSON/buffer）
export async function requestPinnedDownload(input: {
  agentUrl: string,
  path: string,
  tlsFingerprint: string,
  token: string,
  deviceId: string,
  protocolVersion: number,
  expectedLength: number,
  expectedSha256?: string, // optional — C7 contract clarification from files[] frozen shape
  onChunk: (chunk: Buffer) => void | Promise<void>,
  timeoutMs?: number,      // default 120_000
  idleTimeoutMs?: number,  // default 15_000
  signal?: AbortSignal,
}): Promise<{ bytesReceived: number, sha256: string }>;

// 行为冻结：
// 1. pin 验证成功前不得调用 onChunk，不得 accept/落盘 secret-bearing body
// 2. mandatory exact-one triad headers
// 3. exact-one Content-Length + exact-one X-Linke-Chunk-Sha256（合法 lower hex64）
//    - body SHA 必须 === header digest；返回 sha256 为已校验 header/body digest
//    - expectedSha256 **可选**：undefined 仅 multi-chunk（files[] 无 per-chunk digest）；
//      若提供则 header === expectedSha256（单分块整文件 sha 四者全等）
//    - null/坏格式 → socket 前 DEVICE_REQUEST_INVALID（不改 wire）
// 4. nonempty data 重置 idle timer（idleTimeoutMs）
// 5. total timer timeoutMs
// 6. single settle；late events 无二次 onChunk/无二次 reject
// 7. under-read / over-read / early EOF → RESTORE_INTEGRITY_FAILED fail-close
// 8. 网络瞬时 → 调用方可映射 RESTORE_INTERRUPTED

// src/restore-endpoint-engine.js
export async function runEndpointRestore(input: {
  agentUrl: string,
  tlsFingerprint: string,
  token: string,
  deviceId: string,
  protocolVersion: number,
  restoreRoot: string,
  endpointDataDir: string, // required — local nonterminal STATE discovery root
  retryBudget?: number, // default 8
  stateStore: object,
  publish: {
    publishFromStagingVerified: Function,
    rollbackPublished: Function,
    recoverFromCrash: Function,
    recoverCancelledLocal: Function,
  },
  // 有界 JSON GET/POST：claim / getTask / progress / receipt / cleanup
  // 全局一致命名 requestJson；类型 = 既有 requestPinnedBinary（不替换其实现）
  requestJson: typeof requestPinnedBinary,
  // 仅 chunk 流式下载
  download: typeof requestPinnedDownload,
  now?: () => Date,
  signal?: AbortSignal,
}): Promise<{ outcome: 'completed' | 'rolled-back' | 'cancelled' }>;

// 流程（design §10.4 Plan）：
//   1) 安全发现 endpointDataDir/restore-tasks 本 device nonterminal STATE
//      （ensureSafeDataRoot + ensureSafeRelativeDir + bounded readdir；不改 C3 surface）
//   2) 若存在 → 0 claim；GET task 对齐；durable originalTargetExisted/fingerprints；不 openOrCreate
//   3) 若不存在 → claim → GET → preflight → fingerprint live FS → openOrCreate
//   4) progress/receipt/cleanup → requestJson；chunk → download only
//   5) multi-chunk 省略 expectedSha256；返回 digest 写 staging；verifyStagingTree 整文件 e2e
//   6) publish ctx 使用 durable STATE originalTargetExisted/old fingerprints（非 live paths）
//   7) capacity gate 仅 planned/receiving；post-anchor recovery 不阻断
// Retry: network budget default 8；parts 每次 attempt 新建（P1-1 isolation）
//       integrity/path/capacity/state/publish/rollback → no retry
// 耗尽 → local RESTORE_RESUME_EXHAUSTED (HTTP N/A)
```

### RED

- [ ] **Step 1:** `test/device-client.test.js` / `test/restore-client.test.js`：pin 失败不调用 onChunk、不落盘
- [ ] **Step 2:** 断连 resume：仅从 durable STATE 进度继续；**P2-5** 不回拨
- [ ] **Step 3:** corrupt chunk → integrity-failed；不 retry
- [ ] **Step 4:** pre-anchor cancel → cancelled-local → CleanupReceipt cancelled
- [ ] **Step 5:** post-anchor cancelRequested → 仍 completed/rolled-back
- [ ] **Step 6:** two-device parallel + 跨设备 deny
- [ ] **Step 7:** backpressure + IP limiter 有界；无无限队列
- [ ] **Step 8:** same-device upload OR restore 冲突
- [ ] **Step 9:** STATE durable 与 staging 缺损 → fail-close（P2-5 e2e）
- [ ] **Step 10:** under/over/early EOF + idle reset + total timeout single-settle
- [ ] **Step 10b:** **requestJson vs download 分流 pin：**
  - claim / getTask / progress / receipt / cleanup **仅**调用 `requestJson`（= `requestPinnedBinary`）
  - **不**调用 `download` / `requestPinnedDownload`
  - chunk 路径 **仅**调用 `download`
  - 非 chunk 调用仍满足 exact-one triad / single-settle / TLS pin-first（pin 失败不落盘 body）
- [ ] **Step 11:** Run RED

```bash
node --test test/device-client.test.js test/restore-client.test.js test/restore-concurrency.test.js
```

Expected: **FAIL**（`requestPinnedDownload` / `restore-endpoint-engine` 缺失）

### GREEN

- [ ] **Step 12:** 实现 `requestPinnedDownload` 于 `src/device-client.js`（保留既有 `requestPinnedBinary` 有界 helper）
- [ ] **Step 13:** 实现 `src/restore-endpoint-engine.js`：
  - 注入并使用 `requestJson`（claim/getTask/progress/receipt/cleanup）
  - 注入并使用 `download`（**仅** chunk）
  - 接线 publish/recover/cleanup
- [ ] **Step 14:** Run GREEN

```bash
node --test test/device-client.test.js test/restore-client.test.js test/restore-concurrency.test.js
```

Expected: **PASS**

- [ ] **Step 15:** 聚焦回归

```bash
node --test test/device-client.test.js test/upload-client.test.js test/restore-agent-routes.test.js
```

Expected: **PASS**

### PM / diff / status gate

- [ ] **Step 16:** **GLM adversarial** → **Qwen statistics** → **fresh Kimi closure reviewer（只读）** → **Codex PM verification**
- [ ] **Step 17:** 仅当 **P0/P1=0**：exact stage 后 commit/push

**Exact stage paths:**
- `src/device-client.js`
- `test/device-client.test.js`
- `src/restore-endpoint-engine.js`
- `test/restore-client.test.js`
- `test/restore-concurrency.test.js`
- `docs/superpowers/specs/2026-07-23-linke-v142-g0c-endpoint-restore-concurrency-design.md`（multi-chunk frozen-wire / local-resume contract clarification）
- `docs/superpowers/plans/2026-07-23-linke-v142-g0c-endpoint-restore-concurrency.md`（multi-chunk frozen-wire / local-resume contract clarification）

**建议 commit:**
`feat: add pinned G0c restore client with cancel and concurrency tests`

**Rollback:** revert C7。

**禁止进入 C8：** e2e 主路径未绿；P2-5 回拨漏洞；`requestPinnedBinary` 被误改成 8MiB 流式唯一路径（应保留有界 helper + 新 download API）。

---

## C8 — Child-Process Harness + Version V1.42 + Hardware Gate

**Files:**

**Create（auto harness helpers — 固定三文件名）：**
- `test/helpers/g0c-auto-common.js`
- `test/helpers/g0c-auto-controller-runner.js`
- `test/helpers/g0c-auto-endpoint-runner.js`
- `test/g0c-auto-harness.test.js`

**Create（仅真实 overall PASS）：**
- `docs/superpowers/reports/2026-07-23-g0c-real-lan-restore-concurrency-acceptance.md`

**Modify — V1.42 current surface（必须更新为 G0c 当前版本/signature）：**
- `src/version.js` → **仅** `export const LINKE_RELEASE_VERSION = 'V1.42';`
- `README.md` — 当前版本行/表改为 V1.42 + signature `V1.42 G0c endpoint-pull restore with crash-recoverable rollback anchor implementation`；诚实写 auto harness ≠ real-LAN；Gold **4/4/1/9**；**禁止**把 signature 写入 version 常量
- `test/readme.test.js` — pin 当前 surface 到 V1.42 + G0c signature
- `test/version.test.js` — `LINKE_RELEASE_VERSION === 'V1.42'`；signature 常量与 version 分离
- `src/gold-readiness.js` — current evidence/nextStep 文案切到 G0c signature；**不**抬 9-item statuses
- `test/gold-readiness.test.js` — 对应 pin V1.42/G0c signature；Gold counts 仍 4/4/1/9
- `test/g0b-real-acceptance.test.js` — **固定必须最小修改（已核实硬 pin `LINKE_RELEASE_VERSION === 'V1.41'`、gold-readiness current version/nextStep、README current surface）**：
  - 将**当前版本**断言改为 `V1.42` / G0c current surface（与 `src/version.js`、README、gold-readiness 一致）
  - **保留** `V141_SIGNATURE = 'V1.41 G0b resumable manifest v2 snapshot upload implementation'` 与 **G0b real-LAN evidence absent** 为**历史**断言
  - **禁止**把本文件改成宣称 G0c real-LAN complete；**禁止**删除 G0b historical/absent 边界

### 自动 harness（≠ real-LAN）

- [ ] **Step 1:** 实现三 helper + `test/g0c-auto-harness.test.js`：至少 **child_process** 双 endpoint 独立进程
- [ ] **Step 2:** 覆盖：主路径 completed、rollback、pre-anchor cancel、跨设备 deny、断连恢复、全局背压 smoke
- [ ] **Step 3:** 默认 CI 跑 auto harness；真实门关闭
- [ ] **Step 4:** import 测试文件不创建 real-LAN 报告

### 真实硬件门

- [ ] **Step 5:** 仅当 `LINKE_REAL_G0C_RESTORE_ACCEPTANCE=enabled` **且** 用户提供第二 Mac/隔离 VM 时执行真实套件
- [ ] **Step 6:** 真实 overall PASS 后才写脱敏报告
- [ ] **Step 7:** 失败或不可用：**不**写报告；**不** fake PASS；Gold 保持 **4/4/1/9**
- [ ] **Step 8:** 无硬件时断言报告 absent：

```bash
test ! -e docs/superpowers/reports/2026-07-23-g0c-real-lan-restore-concurrency-acceptance.md
```

Expected: **exit 0**

### Version / signature

- [ ] **Step 9:** `LINKE_RELEASE_VERSION === 'V1.42'` 且 **不含** signature 子串
- [ ] **Step 10:** Exact signature 字符串出现在 `README.md`、`src/gold-readiness.js`、`test/version.test.js`、`test/readme.test.js`、`test/gold-readiness.test.js` 的 **当前 surface** pin 中

### RED

- [ ] **Step 11:** Run RED

```bash
node --test test/g0c-auto-harness.test.js test/version.test.js test/readme.test.js test/gold-readiness.test.js test/g0b-real-acceptance.test.js
```

Expected: **FAIL**（helpers/version surface 未更新；`g0b-real-acceptance` 仍硬 pin `V1.41` current）

### GREEN

- [ ] **Step 12:** 实现 helpers + harness；更新 V1.42 current surface 文件（含 **固定** `test/g0b-real-acceptance.test.js` 最小修改）
- [ ] **Step 13:** Run GREEN

```bash
node --test test/g0c-auto-harness.test.js test/version.test.js test/readme.test.js test/gold-readiness.test.js test/g0b-real-acceptance.test.js
```

Expected: **PASS**（g0b-real：current=`V1.42`/G0c；`V141_SIGNATURE` + G0b real-LAN absent 历史保留；默认 gate off 不得假 PASS real-LAN）

- [ ] **Step 14:** 默认/无真实硬件 lane — 报告 absent

```bash
test ! -e docs/superpowers/reports/2026-07-23-g0c-real-lan-restore-concurrency-acceptance.md
```

Expected: **exit 0**

### PM / diff / status gate

- [ ] **Step 15:** **GLM adversarial** → **Qwen statistics** → **fresh Kimi closure reviewer（只读）** → **Codex PM verification**（诚实边界：auto ≠ real-LAN）
- [ ] **Step 16:** 仅当 **P0/P1=0**：exact stage 后 commit/push

**Exact stage paths（无硬件）：**
- `test/helpers/g0c-auto-common.js`
- `test/helpers/g0c-auto-controller-runner.js`
- `test/helpers/g0c-auto-endpoint-runner.js`
- `test/g0c-auto-harness.test.js`
- `src/version.js`
- `README.md`
- `test/readme.test.js`
- `test/version.test.js`
- `src/gold-readiness.js`
- `test/gold-readiness.test.js`
- `test/g0b-real-acceptance.test.js`

**建议 commit（无硬件）:**
`feat: add G0c restore auto harness and version V1.42 (real-LAN evidence absent)`

**若真实 PASS 另提交 Exact stage:**
- `docs/superpowers/reports/2026-07-23-g0c-real-lan-restore-concurrency-acceptance.md`
message: `test: add sanitized G0c real-LAN restore concurrency acceptance report`
（仍不抬 Gold）

**Rollback:** revert C8；version 回 `V1.41`。

**禁止进入 C9：** version 写成完整 signature；无硬件却创建 report；Gold 被改。

---

## C9 — Full Suite + Multi-Model Review + PM Closure

**Files:** 仅修复 review findings 所需的 exact paths；**禁止**顺手重构。

### Steps

- [ ] **Step 1:** 全量

```bash
npm test
```

Expected: **0 fail**；既有硬件 skip **诚实保留**；**不**预写/断言具体总测试数

- [ ] **Step 2:** 卫生扫描

```bash
rg 'package-lock' -g '!.git/**' || true
rg 'LINKE_RELEASE_VERSION' src/version.js
node -e "import('./src/error-codes.js').then(m=>console.log(Object.keys(m.ERROR_CODES).length))"
```

Expected:
- 无 package-lock 业务变更
- `LINKE_RELEASE_VERSION` 仅为 `V1.42`
- ERROR_CODES length **88**
- G0a 报告未改；G0b real-LAN 仍 absent（历史）；M1/M2 docs 未改

- [ ] **Step 2b — 默认/无真实硬件 lane（report absent）：**

```bash
test ! -e docs/superpowers/reports/2026-07-23-g0c-real-lan-restore-concurrency-acceptance.md
```

Expected: **exit 0**。**禁止**使用 `|| echo` 或任何把 report present 转成成功的写法。

- [ ] **Step 2c — 真实 overall PASS lane（仅当真实硬件套件 overallStatus=PASS）：**
  - 报告路径 **必须存在**：`docs/superpowers/reports/2026-07-23-g0c-real-lan-restore-concurrency-acceptance.md`
  - 报告脱敏且 `overallStatus=PASS`
  - **仅此 lane** 允许该报告存在
  - 非此 lane 不得创建或保留该报告

- [ ] **Step 3:** secret/path/raw-error 扫描（既有红队测试 + 人工 diff）
- [ ] **Step 4:** G0a/G0b 回归聚焦

```bash
node --test test/agent-listener.test.js test/device-client.test.js test/device-registry.test.js test/upload-agent-routes.test.js test/g0a-real-acceptance.test.js test/g0b-real-acceptance.test.js
```

Expected: **PASS**（real gates off / skip 诚实）

- [ ] **Step 5:** **P2-1..P2-6 exact 锚点复跑**

```bash
# P2-1（含 rollback rename 抛错 → restore-rollback-failed）、P2-2、P2-3、P2-4
node --test test/restore-crash-truth-tables.test.js test/restore-publish.test.js
# P2-5
node --test test/restore-endpoint-state.test.js test/restore-agent-routes.test.js test/restore-client.test.js
# P2-6（含 9 个 count-pin 中的动态 scans）
node --test test/error-codes.test.js test/audit-integrity-process-lock-scans.test.js
# C2 snapshot reader 生产适配器
node --test test/restore-snapshot-reader.test.js test/restore-task-store.test.js
# P1-1 / P1-2 + getChunk upload→restore backpressure 换码 + createTask 不查 upload
node --test test/restore-upload-admission.test.js test/upload-service.test.js test/restore-service.test.js
# C7 requestJson vs download 分流
node --test test/restore-client.test.js test/device-client.test.js
```

Expected: **PASS**

- [ ] **Step 6:** **GLM adversarial** → **Qwen statistics** → **fresh Kimi closure reviewer（只读）** → **Codex PM verification**
- [ ] **Step 7:** 关闭所有 P0/P1；P2 记录在案但不阻塞除非 PM 升级
- [ ] **Step 8:** 仅当有修复且 **P0/P1=0** 时 commit：

`test: close G0c review findings`

exact paths only（列全实际修改文件；禁 package-lock）

**禁止：** 无真实报告把 Gold 标 ready；宣称 G0c real-LAN complete；网络错误当 PASS。

---

## 测试矩阵（总清单）

| 域 | 必须覆盖 |
| --- | --- |
| Codes | **9** count-pin 文件；current **88**；process-lock-scans prior/current/next=**74/88/89**；RESTORE contract 14；UPLOAD contract 不变 |
| Path/schema | relativeTarget + file path；Receipt fingerprint 表；CleanupReceipt；唯一 error 映射 |
| Snapshot reader | `createRestoreSnapshotReader`；remote+local 真实形状；唯一 clean→`projectCanonicalUploadManifest` 算法；integrity-failed；无 abs path |
| Task store | 经 storageReader；TASK 不可变；cancel 200/202；cleanupAuthorized；cleaned 保留 receipt；hasActiveRestore |
| Endpoint STATE | 17 phases；0600；无 abs path；**P2-5** durable progress |
| Fingerprint/staging | symlink fail；capacity 无 oldTargetBytes；path 建树 |
| Crash | **P2-1** rollback 三元 + **rename 抛错** → `restore-rollback-failed`（不自动删工件）+ fingerprint mismatch；**P2-2** anchored；**P2-3** cancelled-local；**P2-4** staging re-verify；四象限；cancel canary |
| **P1-1 Live slot** | create/status/finalize/abort **不**占 `runTransfer`；仅 putChunk + restore chunk GET；表驱动 A–D |
| **P1-2 Admission** | findActiveRestore / findActiveUpload **仅 claim/create(upload)**；共享 `runDevice`；**createTask 不查 upload**；E–H；C6 路由双向拒绝 |
| Locks/service | 共享槽；claim 不占槽；getChunk **仅**将 `upload-backpressure` 译为 `restore-backpressure`；1..16 |
| Routes | auth-before-lookup；not-found；limiter 隔离；deadlines；single-settle；mgmt create 可与 active upload 并存 |
| Client | `requestJson`（= `requestPinnedBinary`）有界 JSON；`requestPinnedDownload` 仅 chunk；分流 pin；retry 8；cancel/concurrency |
| Harness | 三 exact helpers + auto harness；real 门 `test ! -e` absent |
| Hygiene | version/signature exact 文件；Gold 4/4/1/9；package-lock untouched；M1/M2 untouched |
| Full | `npm test` 0 fail |

---

## 建议 Conventional Commits（汇总）

| C | Message |
| --- | --- |
| C0 design | `docs: design V1.42 G0c endpoint-pull restore concurrency`（**已完成** @ `8fa69ab`） |
| C0 plan | `docs: plan V1.42 G0c endpoint-pull restore concurrency` |
| C1 | `feat: register G0c restore error codes and path/schema validators` |
| C2 | `feat: add G0c restore snapshot reader and controller task store` |
| C3 | `feat: add G0c endpoint restore state staging and fingerprints` |
| C4 | `feat: implement G0c dual-rename publish rollback and crash recovery` |
| C5 | `feat: add G0c restore service and tighten live-transfer slot ownership` |
| C6 | `feat: expose fail-closed G0c restore routes via controller-runtime` |
| C7 | `feat: add pinned G0c restore client with cancel and concurrency tests` |
| C8 | `feat: add G0c restore auto harness and version V1.42 (real-LAN evidence absent)` 或真实报告 test commit |
| C9 | `test: close G0c review findings`（如有） |

---

## Implementation Completion Checklist

- [ ] C1：88 codes + RESTORE contract + path/schema；UPLOAD contract 不变；**9** 个 count-pin（含 `test/audit-integrity-process-lock-scans.test.js` prior/current/next=74/88/89）同 commit
- [ ] C2：`createRestoreSnapshotReader` + TASK/STATUS store；生产 digest 算法唯一；`hasActiveRestore`；无 HTTP
- [ ] C3：17 phases + staging + fingerprints；P2-5 durable progress
- [ ] C4：dual-rename + 独立 `test/restore-crash-truth-tables.test.js`；P2-1..P2-4 真值表全绿；rollback rename 抛错 → `restore-rollback-failed` 不自动删；唯一 error 映射
- [ ] C5：**P1-1** 仅 putChunk 占槽；**P1-2** claim 内 `findActiveUpload` + `runDevice`；**createTask 不查 upload**；getChunk **仅** `upload-backpressure`→`restore-backpressure`；无 restoreService claim **404**；`now` required
- [ ] C6：第一 public exposure；runtime 装配 `createRestoreSnapshotReader({ getSnapshotManifestFn: getSnapshotManifest })` + pin；`findActiveSession` pin；upload **create admission only** 反向门；mgmt create 可与 active upload 并存
- [ ] C7：`requestJson`（= `requestPinnedBinary`）+ `requestPinnedDownload` 分流 + 固定 `src/restore-endpoint-engine.js` + cancel/concurrency + P2-5 e2e
- [ ] C8：三 exact helpers；version `V1.42`；current surface + **固定** Modify `test/g0b-real-acceptance.test.js`；无硬件 `test ! -e` report absent；Gold **4/4/1/9**
- [ ] C9：`npm test` 0 fail；P2-1..P2-6 exact 命令；report 双 lane（absent vs real PASS）；**GLM→Qwen→fresh Kimi→Codex PM**；P0/P1=0
- [ ] 全程 package-lock unstaged/unread
- [ ] 无 collaboration subagent；implementer 仅 Grok `grok-4.5` high（fresh / PM-resume）
- [ ] 执行路径：**仅 inline PM loop**（无 subagent 选项）

---

## PM Per-C Status Template

```text
## C? — <title>
- Implementer: Grok grok-4.5 high (fresh|resume)
- RED commands: <exact>
- RED observed: FAIL — <reason>
- GREEN commands: <exact>
- GREEN observed: PASS
- Focused regression: <commands + PASS>
- GLM adversarial: PASS|FAIL — <notes>
- Qwen statistics: PASS|FAIL
- fresh Kimi closure (read-only): PASS|FAIL — P0=? P1=? P2=?
- Codex PM verification: ACCEPTED|REJECTED
- Network errors treated as: NOT PASS
- git status --short: <paste>
- exact paths staged: <list>
- package-lock: unstaged
- commit: <sha> <message>
- push: <yes/no>
- P1-1 slot ownership verified: yes|no|n/a
- P1-2 bidirectional admission verified: yes|no|n/a
- P2 anchors touched this C: <P2-n list>
- Blockers: <none|...>
- Next C allowed: yes|no
```

---

## Stop / Hold Conditions

1. 任意 C 的 P0/P1 > 0 → **停止** commit/push；返修后重跑完整审查链。
2. 发现 public restore routes 在 C5 或更早暴露 → **立即 hold**；revert 至 C5 前。
3. C6 半接线（缺 limiter/auth/semaphore/cleanup/交叉 probe）→ **禁止** merge/push。
4. progress 回拨或伪造较小 durable bytes（P2-5）→ P0 hold。
5. anchor-intent 后出现 `cancelled-local` → P0 hold。
6. EXDEV 复制降级 / absolute path 进 wire/log → P0 hold。
7. upload create/finalize 仍调用 `runTransfer`（P1-1 违规）→ P0 hold。
8. 双向 admission 使用分离先查再写造成 TOCTOU（P1-2 违规）→ P0 hold。
9. 无硬件却创建 real-LAN 报告或抬 Gold → P0 hold；删除伪报告。
10. package-lock 被 stage/read 进 diff → hold；unstage；不提交。
11. 网络错误导致审查工具失败 → **不是 PASS**；重试或人工 PM 裁决，禁止当作通过。
12. implementer 使用 collaboration subagent → 违反本计划；PM **拒绝**该 C 产出。
13. `LINKE_RELEASE_VERSION` 写入完整 signature → hold；改回仅 `V1.42`。
14. ERROR_CODES ≠ 88 或 UPLOAD contract 回归失败 → C1/C9 hold。

---

## 执行方式说明

| 角色 | 责任 |
| --- | --- |
| **本会话 inline PM loop** | 按 C 门禁验收；发起 GLM/Qwen/Kimi/Codex 审查；仅 P0/P1=0 时自动精确 stage/commit/push |
| **Grok 外部 worker** | 原生 CLI **`grok-4.5` high** 实现 C1–C9；**首轮 fresh**；**仅**对完整 PM finding 包 **resume** 返修 |
| **Kimi** | **只读** closure reviewer；**不得**裁定真实测试输出/Git 事实 |
| **Codex PM** | 真实测试与 Git 事实最终裁决 |
| **Collaboration subagents** | **不使用**；**无** subagent 执行选项 |

本计划执行路径 **仅** inline PM loop + 外部 Grok worker；不以任何 subagent-driven 模板替代。

---

## 附录 A — 错误码 HTTP 速查（G0c 钉死）

| code | status | retryable | 唯一场景（摘要） |
| --- | --- | --- | --- |
| restore-task-invalid | 400 | no | schema/unknown keys/非法 index/fingerprint 表违规/progress 回拨等 |
| restore-task-not-found | 404 | no | 不存在或跨 device（不泄漏） |
| restore-task-conflict | 409 | no | admission、非法迁移、receipt/cleanup 冲突、同设备 upload/restore 互斥 |
| restore-state-invalid | 500 | no | STATE/TASK 损坏、symlink/type swap、崩溃歧义、anchored 非法组合、rollback 目录歧义 |
| restore-path-invalid | 400 | no | relativeTarget/restoreRoot/symlink ancestor/dev 不一致；**pre-publish** target→anchor 或 staging→target rename **EXDEV**（design §6.3；不 copy；STATE 保留 durable intent） |
| restore-integrity-failed | 422 | no | chunk/树 hash、early EOF、snapshot 不可读、staging 缺损 |
| restore-capacity-insufficient | **507** | no | 磁盘不足或 freeBytes 不可用 |
| restore-backpressure | **429** | yes + Retry-After | **仅 chunk GET** 全局槽满 |
| restore-interrupted | N/A | yes | client 瞬时传输信号 |
| restore-publish-conflict | 409 | no | **仅** publish-intent `(target=yes, staging=yes)` |
| restore-rollback-required | 409 | no | published 后必须回滚 |
| restore-rollback-failed | 500 | no | rollback rename 失败或回滚后 fingerprint 不一致 |
| restore-cleanup-failed | 500 | no | CleanupReceipt 接受路径持久化失败 |
| restore-resume-exhausted | N/A | no | client-local only |
| device-rate-limited（既有） | 429 | yes | restore IP 1200/min 与 G0a/upload 隔离 |
| upload-backpressure（既有） | 429 | yes | **仅** putChunk 全局槽满 |
| upload-session-conflict（既有） | 409 | no | 含 active restore 时 upload create（P1-2） |
| upload-*（既有） | 见 G0b | — | **本阶段不改语义**；`UPLOAD_ERROR_HTTP_CONTRACT` 保留 |

---

## 附录 B — Receipt fingerprint nullability（实现钉死）

| outcome | anchorPresentBeforePublish | contentSha256 | structureFingerprint |
| --- | --- | --- | --- |
| completed | true 或 false | **必须** 64 hex | **必须** 64 hex |
| rolled-back | true | **必须** 64 hex | **必须** 64 hex |
| rolled-back | false | **必须** null | **必须** null |

其它组合 → schema `restore-task-invalid` 400；过 schema 后与 Controller 期望冲突 → `restore-task-conflict` 409。

---

## 附录 C — Cancel / Cleanup 时序（实现钉死）

```text
pending  --cancel--> cancelled (200; no endpoint artifacts)
active   --cancel--> active + cancelRequestedAt (202)
  pre-anchor endpoint: cancelled-local → CleanupReceipt(cancelled) → Controller cancelled + cleanupAckAt
  post-anchor-intent: MUST completed|rolled-back ReceiptObject (even if cancelRequested)
                      → cleanupAuthorized → CleanupReceipt → cleaned
receipt ACK = cleanupAuthorized only (NEVER cleaned)
cleanup ACK = cleaned | cancelled-final
```

---

## 附录 D — Live-transfer 与 Admission 冻结表（P1-1 / P1-2）

| 操作 | runTransfer？ | runDevice？ | 备注 |
| --- | --- | --- | --- |
| upload create | **否** | **是**（含 findActiveRestore） | P1-1 + P1-2 |
| upload status | **否** | 否 | |
| upload putChunk | **是** | 否（runSession） | 唯一 upload 占槽点 |
| upload finalize | **否** | 否（runSession→runSnapshot） | P1-1 |
| upload abort | **否** | 否（runSession） | |
| restore claim | **否** | **是**（含 findActiveUpload） | P1-2 |
| restore getTask | **否** | 短互斥可 per-task | 不占全局槽 |
| restore getChunk | **是** | 否 | 唯一 restore 占槽点；`runTransfer` 满载抛 `upload-backpressure` → **仅此** 译为 `restore-backpressure` |
| restore createTask | **否** | 否 | **不**调用 `findActiveUpload`；可与 active upload 并存 pending |
| restore progress/receipt/cleanup | **否** | per-task 可 | 不占全局槽 |

**TOCTOU 禁止：** 不得在 `runDevice` 外先 `findActive*` 再进入另一临界区写 session/STATUS；admission check + mutation **同一次** `locks.runDevice(deviceId, …)` 回调内完成。

---

## 附录 E — 冻结不变量（每 C 自检）

1. endpoint-pull；immutable TASK；durable STATUS
2. relativeTarget + files.path only；no absolute target wire/log
3. no-follow；same stat.dev；EXDEV no copy
4. pure Node dual rename；non zero-gap；target→anchor then staging→target
5. cancel linearization before durable anchor-intent
6. receipt ACK ≠ cleaned；CleanupReceipt 后终态
7. shared live semaphore 4 default / 1..16；**only putChunk + chunk GET**；claim free；create/finalize free
8. bidirectional admission under shared `runDevice`
9. auth-before-lookup；exact-one triad；cross-device not-found
10. 8 MiB chunks；retry 8；timeouts/limiters per design §19
11. version `V1.42` ≠ signature；Gold blocked 4/4/1/9；no fake hardware report
12. P2-1..P2-6 不遗失；exact test 文件锚点
13. package-lock unread/unstaged

---

## C0 完成定义（本轮 plan author）

1. 本 plan 文件存在；映射 design §20 C1–C9 与 P2 六项；消化 Codex PM P1-1..P1-7。
2. 无 src/test/README/package/version/Gold/design 变更（本 worker）。
3. 未读取/修改/暂存 `package-lock.json`。
4. 文档 **PLAN ONLY / C0**；未把未实现标为完成；Gold 仍 **blocked 4/4/1/9**。
5. C0 review **已 ACCEPTED**（reviewed SHA `ee200e97df030957f68a981aecacf57bb47297d425a99e039ae8bde0ac7e7aca`）；**PM loop** 负责 exact plan-only commit/push（本 plan 不写结果 hash）。

---

**END OF PLAN — PLAN ONLY / C0 — NOT IMPLEMENTED**
