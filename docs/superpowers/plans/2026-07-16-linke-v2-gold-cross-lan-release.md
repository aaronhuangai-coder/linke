# Linke V2.0 Gold / Cross-LAN Release Implementation Plan

> **For agentic workers:** 实现阶段再启用 subagent-driven-development 或 executing-plans。<br>
> **本文件编写阶段（M0）：docs only — 禁止改源码 / 测试 / README / Gold scorecard / commit / push。**

**Goal:** 按已冻结设计把 Linke 从 **V1.33（Gold blocked）** 沿 **有限里程碑 M0–M7** 推进到 **V2.0 Gold/GA**，其中 **跨局域网 outbound-only relay/reverse connection** 为强制新门禁；禁止用 V1.33 本机 status、G0a same-LAN、同 LAN direct 冒充 cross-LAN 或 Gold。

**Architecture:** 继承 Gold 单机控制面（loopback 管理）与设备身份（G0a）；新增 cross-LAN **control plane**（**独立 E2EE session layer**：Ed25519 身份 + **Noise_IK_25519_ChaChaPoly_SHA256**（精确 token 序列 `-> e, es, s, ss` / `<- e, ee, se`，无“或等价”）、双向认证、prologue/transcript binding、forward secrecy、key confirmation、domain separation；重放以 nonce/seq + counter reservation 为主、时钟窗为辅；轮换/撤销 **L2 控制器权威** + L1 relay denylist；控制/bulk 队列分离与 §4.4 硬上限）与 **data plane**（密文 chunk + keyed digest + 幂等 resume，§6.10；与 NAS/smbfs 边界分离）。**Relay transport 冻结 WSS/TLS1.3/TCP443**（§4.1.5）；仅 hop 转发密文，不参与 KE、不持长期私钥/会话密钥/可离线解密材料（spec §6.7）。Supervisor lifecycle execute/gate 与跨局域网通道 **正交**，会话建立不得抬升 `executionEligible`。

**Tech Stack（实现阶段预期）：** Node.js ESM、内置 `node:test` / `node:crypto` / `node:tls` / `node:https` / `node:http`（可选 HTTP CONNECT）、既有 Keychain/TLS/device 模块扩展；Noise **实现库不在 docs-only 阶段点名**——M1 必须先完成 spec §6.7.7 bounded crypto dependency spike/ADR（2–3 候选核维：维护/许可/Node ESM+macOS/IK+25519+ChaChaPoly+SHA256+prologue+vectors/审计记录/供应链）；通过后方可引入依赖或 fixed-fixture 兼容层（单独变更控制）；**无候选通过则 M1 BLOCKED**，禁止静默自研或降级 suite。macOS 双机 + **可选自建/用户管理测试 relay**（非公共生产 SaaS）仅用于 M5。

**Spec:** `docs/superpowers/specs/2026-07-16-linke-v2-gold-cross-lan-release-design.md`

**Baseline:** HEAD `f21d520`（文档编写时）；当前发布版本 **V1.33**；G0a report PASS（same-LAN only）。

---

## Global Constraints

### 本阶段（编写/返修本 plan 时）

- [x] 只允许修改 specs/plans 下本设计相关两份 Markdown（禁止创建其它文件）
- [x] 禁止改 `src/`、`test/`、`README.md`、`src/gold-readiness.js`、`package.json`
- [x] 禁止 commit / push / 子代理 / web 搜索
- [x] 禁止读取并输出 secrets、改生产网络、发邮件

### 实现阶段（M1+）全局

- 不要求用户打开路由器 inbound 端口 / UPnP；**不**把真实 double-symmetric NAT 设为 Gold 必要条件；M5 必要门 = 两独立路由域/NAT + direct disabled + 全部经 operator/user-managed WSS relay（`relayForced:true`；NAT 类型可 unknown）；double-symmetric 仅强推荐扩展
- 不输出 env、token、key、fingerprint 全文、路径、IP/URL 原文到日志或报告
- 中继不得持有备份明文、长期身份私钥、会话密钥或可离线解密材料；**不得参与 E2E 密钥派生**
- hop mTLS/TLS-to-relay **不得**冒充 payload E2EE
- 禁止自创密码算法；遵循 spec §6.7 成熟构件组合
- 不得提供未认证公网 proof/enroll 滥用面
- dry-run / mock / 单机双进程 / same-LAN **不得** 标记 `cross-lan-connectivity: ready`
- 不得因 cross-LAN 成功设置 lifecycle `executionEligible` / `executeCapabilityAuthorized` / `realRunnerWiringReady`
- dataDir `0600` **不等于** Keychain 密钥保险箱；长期私钥、`enrollment-hmac-secret`、**Proxy-Authorization secret** 进 Keychain 独立 item；**禁止** 以 0600 文件作为 Gold 路径存放上述 secret
- enrollment-hmac-secret：**首次启动自动 CSPRNG 32B → Keychain 独立 item**；禁止手输/日志/明文传输；丢失时 **不** 无故全 fleet re-enroll；`enrollment-secret-unavailable` 仅禁新码（spec §6.3.4）
- Controller Noise static 轮换 ≠ Ed25519 identity 泄露：Case A 走 `controller-noise-key-update`；Case B 全 fleet re-enroll；统一 `trustEpoch`（spec §6.7.8）
- 企业 TLS MITM 与 SPKI pin 不兼容：Gold fail-closed；**禁止** 装代理 CA 绕 pin；诊断桶 `proxy-tls-intercepted`（spec §4.1.5）
- Proxy 范围：仅显式 **HTTP CONNECT + Basic/Bearer**（Keychain）；PAC/WPAD、NTLM/Kerberos、代理链 = non-goal fail-closed（`proxy-pac-unsupported` / `proxy-unsupported-auth` / `proxy-chain-unsupported`）
- 残余流量分析：relay 可观察密文/chunk 长度序列、时序、变更量近似；**不**承诺隐藏流量形状；**禁止**声称匿名/traffic-analysis resistant；M4 可选 bucket padding
- Keepalive：仅 **Noise AEAD 应用层** ping/pong 刷新安全会话 timer；RFC6455 WS ping **不**算 authenticated liveness
- Counter：**R=32**，receiver **window=64**，保证 `R < window`；崩溃 forward gap ≤32
- Enrollment 明文仅 loopback UI/CLI 一次显示；不写 dataDir/日志/审计；默认不自动剪贴板；QR=`enrollmentQr/v1` 无 secret/private key
- M5 relay：公网 TCP443/WSS 可达前置；localhost/mock **不得** 用于 M5；evidence 含 `relayDeployment`/`reachabilityResult`
- 外部 artifact 丢失 → cell `EVIDENCE-DEGRADED`；M5/M6 必选 cell 导致对应门与 overall 从 ready 降 partial/blocked 直至复验
- T1.0 BLOCKED 后 **7 个自然日** 内 PM+用户 ADR（替代库/修订协议/暂停 V2.0）；fixed-fixture 兼容层须审查+spec 变更，禁止静默捷径
- denylistVersion 禁止 wrap；近 `UINT64_MAX` → `controller-state-untrusted` + 全 fleet re-enroll
- Gold evidence **不覆盖**；文件名含日期+`sourceCommit` 前缀；工作树 ≥36 月且至下一 major Gold 满 12 月取较晚；外部 artifact 绑定 digest；清理须审批；M7 前禁止删除 M5/M6 evidence（spec §7.2.2）
- 真实 Keychain / 双机 / NAS / launchd / 自建测试 relay 门均需用户明确授权
- 每个 green 任务独立 commit boundary；**未经用户确认不得 commit/push**（遵仓库与用户全局 Git 规范）
- V1.x 可继续作审计里程碑；**仅 M7** 可将版本与 scorecard 标为 V2.0 Gold ready（要求 M5 + M6a–d 全出口且 10/10）

### 有限里程碑（禁止无限堆叠）

```text
M0 Design freeze
M1 Protocol skeleton tests
M2 Relay/client handshake dry-run
M3 Encrypted control channel
M4 Data-plane / NAS boundary
M5 Real cross-LAN acceptance
M6 Remaining Gold gates evidence
M7 RC → Gold/GA only if 10/10 ready
```

---

## Dependency Graph

```text
M0 (this docs pair)
 └─ M1 protocol skeleton + negative security unit tests
     └─ M2 handshake dry-run (loopback mock relay)
         └─ M3 encrypted control channel
             ├─ M4 data-plane / NAS boundary
             │   └─ M5 real cross-LAN acceptance ──┐
             └─ (parallel track, evidence-independent) │
                M6a automation-installation real      │
                M6b real-nas-remote-backup            ├─ M7 Gold RC
                M6c security-auth production          │
                M6d production-hardening              │
                └─────────────────────────────────────┘
```

**规则：** M5 与 M6a–M6d 可时间并行；单 M6 子轨失败 **不**阻止其它子轨提交；M7 需要 **M5 与 M6a–M6d 全部** 出口条件满足且 scorecard **10/10 ready**。

---

## File Map（实现阶段预期；本阶段不创建）

> 下列路径为设计意图，实现时以最小 diff 为准；若需增减模块须回写 spec 变更记录。

| 阶段 | 预期新增/修改 |
| --- | --- |
| M1 | `src/cross-lan-protocol.js`、`src/error-codes.js` 扩展、`test/cross-lan-protocol.test.js`、`test/fixtures/noise-ik-25519-chachapoly-sha256.json`（含 crypto/降级/skew/容量/keepalive/向量契约）；**Noise library spike ADR**（§6.7.7，实现阶段新建 docs 路径，本 M0 不创建） |
| M2 | `src/cross-lan-handshake.js`、`src/cross-lan-transport-wss.js`、`test/cross-lan-handshake-dry-run.test.js`、测试用 **mock** relay helper（loopback **同 WSS framing 抽象**；`relayType=mock`）；proxy CONNECT 错误码桶（含 `proxy-tls-intercepted`） |
| M3 | `src/cross-lan-session.js`、`src/cross-lan-crypto.js`、counter reservation 持久化、撤销 L1/L2、enrollment HMAC/tombstone/**secret lifecycle**、**relay pin-set 轮换**、**controller-noise-key-update / trustEpoch**、keepalive、审计、限流/队列、控制器 state backup；对应 tests |
| M4 | data-plane 适配（chunkId/keyed digest/幂等 ACK/Merkle checkpoint）、与 `smb-snapshot-replication` 边界测试；**禁止** bulk 写入控制队列 |
| M5 | `test/helpers/cross-lan-real-*`、`test/cross-lan-real-acceptance.test.js`、`cross-lan-evidence/v1` schema 校验器、脱敏 report 模板（**日期+sourceCommit 前缀命名、不覆盖**）；可选 **operator-managed-test** relay（同 framing） |
| M6a–d | 各子轨独立 evidence 路径与 harness（见 M6 分节）；互不共享 ready 断言 |
| M7 | `src/gold-readiness.js` 增 `cross-lan-connectivity`；`src/version.js` → V2.0；README；evidence 验证；**仅 10/10** |

**默认长期不改坏：** G0a harness 语义、V1.33 observational status 诚实边界、NAS “不读 SMB 凭证”。

---

## Milestone Plans

### M0 — Design freeze（本阶段）

**Goal:** 冻结 V2.0 Gold 门禁与 cross-LAN 威胁模型/路线。

**Tasks:**

- [x] 撰写 spec：`docs/superpowers/specs/2026-07-16-linke-v2-gold-cross-lan-release-design.md`
- [x] 撰写 plan：本文件
- [ ] PM/用户确认 M0 冻结（人工门）
- [ ] （可选）Qwen/对抗审阅按 spec §11 checklist；P0 必须清零或书面裁决

**Exit:**

- 两份文档在仓库 docs 路径存在且内容覆盖 spec §12 完成标准
- 工作区除上述 docs 外无源码改动
- **不** 修改 Gold scorecard

**Commit boundary:** 用户确认后可单独 `docs:` 提交（**本阶段不自动 commit**）

**Tests:** 无代码测试；人工审查清单 §11.5

---

### M1 — Protocol skeleton + unit contracts

**Goal:** 无网络副作用的协议骨架：消息类型、状态机、token scope 枚举、重放（nonce/seq 主路径）、时钟窗辅路径、错误码、降级拒绝、容量/keepalive 常量、crypto 约束契约（spec §6.7）；**入口完成 Noise library selection gate**（§6.7.7）。

**Tasks（实现阶段展开为 RED→GREEN）：**

- [ ] **T1.0** **Noise library selection gate（F-23 / §6.7.7 hard gate）：** 评估 2–3 个**当时**公开候选（不在本 plan 预写包名）；核验维护状态、许可证、Node ESM/macOS、IK/25519/ChaChaPoly/SHA256/prologue/fixed vectors、审计/安全记录、供应链风险；产出 ADR + 对照矩阵证据。**无候选通过 → M1 BLOCKED**，禁止静默自研/降级 suite。**BLOCKED 后 7 个自然日内** PM+用户书面 ADR 三选一：替代合规库 / 修订协议 / 暂停 V2.0；**fixed-fixture compatibility implementation** 仍须完整安全审查 + spec 变更，**禁止** 静默捷径
- [ ] **T1.1** 注册 cross-LAN 错误码（kebab-case）：至少含 `device-replay-detected`、`device-clock-skew`、`device-counter-rollback`、`device-rate-limited`、`device-session-limit`、`device-clone-suspected`、`handshake-identity-failed`、`protocol-downgrade-attempt`、`e2ee-required`、`enrollment-rate-limited`、`enrollment-code-unknown-or-expired`、`enrollment-secret-unavailable`、`control-queue-overflow`、`stale-epoch-rejected`、`device-revoked`、`relay-connect-failed`、`proxy-auth-failed`、`proxy-connect-failed`、`relay-tls-pin-mismatch`、**`proxy-tls-intercepted`**、`proxy-unsupported-auth`、`proxy-pac-unsupported`、`proxy-chain-unsupported`、`data-resume-exhausted`、`audit-chain-broken`、`controller-state-untrusted`、`revoke-propagation-degraded`、`session-keepalive-timeout`、`evidence-artifact-missing`、`evidence-artifact-digest-mismatch`
- [ ] **T1.2** 定义 control-plane 消息 schema（精确 allowlist 字段）；含 Noise msg1/msg2 payload、key-confirm-client、session-terminate(revoked)、revoke-epoch、denylist-update/ack、**relay-pin-set-update/ack**（字段：relayId、old/new SPKI pins、notBefore、graceUntil、updateId、**`trustEpoch`**、signature）、**controller-noise-key-update/ack**（字段：old/new Noise static pub、notBefore、graceUntil、**`trustEpoch`**、updateId、Ed25519 signature）、**应用层** keepalive ping/pong（Noise AEAD；**非** RFC6455 WS ping）
- [ ] **T1.3** 会话状态机：`idle → handshaking → established → rekeying → closed`（含失败态）；**仅 key confirm 成功后**进入 `established`
- [ ] **T1.4** 重放：nonce/seq 拒绝测试（主防线）；证明不依赖“仅时间窗”
- [ ] **T1.5** 协议降级拒绝：无 “auth optional” / “null cipher” / “TLS-to-relay-only 当作 E2EE” / raw-TLS-without-WSS / 非 `Noise_IK_25519_ChaChaPoly_SHA256`（A16）
- [ ] **T1.6** 跨 deviceId 串线拒绝（A15）
- [ ] **T1.7** 时钟偏移边界：默认 ±120s 内契约通过；121s 与 >600s 配置拒绝（A13）；错误码 `device-clock-skew`
- [ ] **T1.8** 负向：构建会话 **不得** 调用 lifecycle execute 授权路径
- [ ] **T1.9** 冻结容量常量与 hard ceiling（对齐 spec §4.4）：控制队列 256/1MiB 默认、单条 64KiB、速率 30/s、突发 60、会话 2、连接 4、退避 1s×2 封顶 60s±20% 抖动；**仅 `negotiatedKeepaliveInterval`：默认 30s、可配 5–120s；超过 `3 ×` 无 **应用层** pong/已认证流量即断连；断言 WS ping 不刷新 timer**（§6.12 / A24）；**data resume 默认 5 / 可配 3–10 / hard ceiling 10**（§6.10）
- [ ] **T1.10** Domain separation label 常量；**唯一** suite `Noise_IK_25519_ChaChaPoly_SHA256`；protocol_name / prologue 字节冻结（spec §6.7.2.3）
- [ ] **T1.11** 契约注释：relay 不参与 KE；hop WSS/TLS ≠ E2EE
- [ ] **T1.12** **Fixed vectors（F-09）：** 加载 frozen fixture；断言 token 顺序 `e,es,s,ss` 然后 `e,ee,se`；对照期望 handshake hash / 密文前缀；乱序 token 必失败（依赖 T1.0 通过后的实现路径）
- [ ] **T1.13** Enrollment 契约：128-bit 码、HMAC-SHA256 digest 字段、`secretVersion`、constant-time compare 接口、tombstone 状态机；**secret bootstrap：首次启动自动 CSPRNG 32B → Keychain，禁止手输/日志/明文传输**；unavailable/rotate（§6.3.4 / A25）；**交付：** 明文仅 loopback UI/CLI 一次显示；不写 dataDir/日志/审计；默认不自动剪贴板（主动复制须风险提示）；QR schema **`enrollmentQr/v1`** 仅 codeId+code+expiry+controller/relay 公共元数据，无 secret/private key（纠错级别实现自定）
- [ ] **T1.14** Counter reservation 常量：**`R=32`**，receiver **`window=64`**，硬约束 **`R < window`**；崩溃 forward gap ≤32 且接收仍有前进余量；精确 rollback 谓词（非 “gap>R 即 rollback”）；**`trustEpoch` 常量与拒绝谓词**（`≤ lastAcceptedTrustEpoch` → `stale-epoch-rejected`，§6.7.8.1）
- [ ] **T1.15** Evidence schema 常量：`cross-lan-evidence/v1` 必填字段（§7.2.1，含 `relayForced`、`independentNatDomains`、`relayDeployment`、`reachabilityResult`、`proxyResult.errorCode` 含 proxy 负向桶与 `proxy-tls-intercepted`；cell status 含 **`EVIDENCE-DEGRADED`**）+ **命名/不覆盖/保留/体积预算**（§7.2.2：`maxRepoReportBytes = min(512 KiB, 32 KiB + 4 KiB × cellCount + 8 KiB × schemaObjectCount)`；外部丢失→`EVIDENCE-DEGRADED` 传导 partial/blocked）
- [ ] **T1.16** Relay pin-set 消息字段契约（**`trustEpoch`**）与失败保旧 pin 谓词（A21/A22 契约级）
- [ ] **T1.17** Proxy 范围与错误码契约（A26）：仅显式 HTTP CONNECT + Basic/Bearer；负向 `proxy-pac-unsupported` / `proxy-unsupported-auth` / `proxy-chain-unsupported` / `proxy-auth-failed` / `proxy-connect-failed` / `relay-tls-pin-mismatch` / **`proxy-tls-intercepted`**；MITM fail-closed；**禁止** 装代理 CA 绕 pin；无 `0600` 文件存放 proxy secret
- [ ] **T1.18** Controller Noise static lifecycle 契约（§6.7.8 / A27–A29）：Case A `controller-noise-key-update` 字段/验签/双 key overlap/grace 后拒旧；Case B 禁止泄露 identity 在线自证；与 `enrollmentEpoch` 正交
- [ ] **T1.19** denylistVersion uint64 边界契约（A30）：注入近 `UINT64_MAX` → 禁止 wrap；fail-closed `controller-state-untrusted`；触发信任状态迁移 + 全 fleet replace/re-enroll 路径可观测
- [ ] **T1.20** Size-leak / 流量形状诚实契约：常量/注释声明 relay 可见长度序列；**禁止** 匿名/traffic-analysis-resistant 声称；可选 padding bucket 枚举（实现阶段由 M4 测试选型）

**Exit:**

- **T1.0 ADR 通过** 或书面 **M1 BLOCKED**（不得假装通过）；若 BLOCKED，**7 个自然日内** 完成 PM+用户裁决记录（替代库/修协议/暂停）
- 相关 unit tests 全绿（含 fixed vectors；BLOCKED 时不得宣称 crypto 实现就绪）
- 无真实网络、无 Keychain 写入（除非显式 test inject 且默认 off）
- scorecard 仍 blocked；**不** 宣称 partial cross-LAN ready（不改代码 scorecard）
- 数值与术语与 spec §4.1.5 / §4.1.6 / §4.4 / §4.6 / §6.3 / §6.7 / §6.7.8 / §6.8 / §6.9 / §6.10 / §6.12 / §7.2 **完全一致**

**Commit boundary:** `docs:` ADR（T1.0）可先于代码；`test:` / `feat:` 可拆 1–2 个 commit；信息如 `feat(v2-m1): add cross-lan protocol skeleton contracts`

**Rollback:** revert M1 commits；无数据迁移；依赖引入须可整体回退

---

### M2 — Relay/client handshake dry-run

**Goal:** 本地 loopback **mock** relay 完成握手 dry-run；证明中继仅见最小元数据且 **不参与密钥派生**。

**Tasks:**

- [ ] **T2.1** Mock relay：同一 **WSS framing 抽象**（§4.1.5）在 loopback 上转发；只转发握手密文与公开材料；记录可见字段 allowlist；`relayType=mock`；`framing=wss-tls1.3-tcp443`（loopback=true）
- [ ] **T2.2** Client/controller handshake dry-run API（内部或测试入口，默认不暴露公网）；完整 **Noise_IK_25519_ChaChaPoly_SHA256** 路径；**绑定 M1 fixed vectors** 与消息顺序 msg1→msg2→key-confirm-client
- [ ] **T2.3** 断言 relay 观察日志 **无** token/密钥/路径/明文 snapshot/会话材料/明文 hash；断言 KE 在端点↔控制器完成
- [ ] **T2.4** Key confirmation 缺失：不得 `established`（A17）
- [ ] **T2.5** Relay unavailable dry-run：fail-closed `relay-connect-failed`；**无** raw TLS 降级路径
- [ ] **T2.6** 无 inbound 假设：测试不绑定 `0.0.0.0` 公网证明口；双方仅 outbound 语义
- [ ] **T2.7** 文档/注释明确 mock ≠ operator-managed-test ≠ 公共 SaaS；M5 必须复用同一 framing 模块
- [ ] **T2.8** 显式 proxy 路径单测（mock CONNECT）：仅 CONNECT+Basic/Bearer；Keychain mock 注入 secret；仍校验 pin；错误码桶含 auth/connect/pin/**`proxy-tls-intercepted`** / **`proxy-pac-unsupported`** / **`proxy-unsupported-auth`** / **`proxy-chain-unsupported`**（A26）；日志/错误无凭据回显
- [ ] **T2.9** L2 撤销：denylist 未同步时 mock relay 可 accept tunnel，但 handshake 因 stale epoch **不得** established
- [ ] **T2.10** 负向：跳过 pin 校验的构建不得存在；pin mismatch 不得降级；**禁止** 安装代理 CA / 放宽 pin；TLS 拦截 → `proxy-tls-intercepted` fail-closed；PAC/WPAD、NTLM/Kerberos、代理链配置 → 对应 unsupported 错误码 fail-closed（不得静默直连成功）

**Exit:**

- dry-run tests 绿（含 fixed vectors 顺序）
- 明确 “not real cross-LAN acceptance”
- **M2 不改 scorecard ready**
- **前置：** M1 T1.0 library gate 已通过（否则 M2 不得合入生产握手依赖）

**Commit boundary:** `feat(v2-m2): cross-lan handshake dry-run with mock relay`

**Rollback:** 关闭 dry-run 入口；revert

---

### M3 — Encrypted control channel

**Goal:** 真实加密控制通道（仍可在本机双进程或受控网络）；完整 §6.7 E2EE、§6.8 计数器、§4.4 容量、§4.5 克隆检测、§4.6 撤销、限流、审计、轮换。

**Tasks:**

- [ ] **T3.1** E2E 会话：Noise_IK_25519_ChaChaPoly_SHA256 完整实现；relay 不可读载荷；**relay 不在 KE 路径**
- [ ] **T3.2** 双向认证：Ed25519 + Noise static + enrollment epoch 绑定（§6.7.3）；transcript/prologue；key confirmation
- [ ] **T3.3** Forward secrecy + rekey；domain separation labels（§6.7.2.3）
- [ ] **T3.4** Keepalive / 会话保活（§6.12 / A24）：**仅** `negotiatedKeepaliveInterval`（默认 30s；可配 5–120s）；超过 **`3 ×`** 无 **Noise AEAD 应用层** pong/已认证流量 → 断连+退避；**RFC6455 WS ping/pong 不刷新**安全会话 timer（负向单测）
- [ ] **T3.5** Token/session 密钥轮换；旧材料立即拒绝（A5）
- [ ] **T3.6** Revocation **两层**（§4.6）：L2 权威 epoch/revocation 在每次握手/命令前拒绝；L1 denylist version/ack；同步失败 fail-safe + `revoke-propagation-degraded`；tombstone/GC 不复活旧 epoch；在线 L2 关会话 SLO ≤5s；L1 尽力 ≤10s（A6/A20）
- [ ] **T3.7** 每设备速率/突发/连接上限 + 指数退避抖动（§4.4）
- [ ] **T3.8** 控制面有界离线队列 + 背压；**与数据面队列分离**；P0 独立 ring（默认 64）
- [ ] **T3.9** Counter **reservation**（§6.8）：原子持久化 `reservedEnd`、默认 **R=32**、receiver **window=64**（`R < window`）、崩溃 forward gap ≤32 且接收仍有前进余量、精确 rollback 谓词；**禁止**每消息 fsync；M3 fault+perf 测试（A18）
- [ ] **T3.10** 克隆/同 deviceId 并发检测；`device-clone-suspected`；replace-device/epoch bump 路径（A19）
- [ ] **T3.11** 审计事件（allowlist）；敏感扫描测试（A11）；`audit-chain-broken` 不得静默续写；含 pin-set / enrollment-secret / keepalive / proxy 事件脱敏
- [ ] **T3.12** 断线重连控制面（A4）
- [ ] **T3.13** 负向：不抬升 lifecycle execute facts；不把 hop WSS/TLS 标为 E2EE ready
- [ ] **T3.14** 密钥存储：长期私钥/token/**enrollment-hmac-secret**/**proxy Authorization secret** → Keychain **独立 item**；计数器/pin-set 配置 → dataDir 0600（明确 ≠ 密钥保险箱；**禁止** proxy secret 走 0600 文件 Gold 路径）
- [ ] **T3.15** Enrollment（§6.3 + §6.3.1.1 + §6.3.4 / A25）：**首次启动自动 CSPRNG 32B → Keychain**；128-bit 码签发/验证/单次/10min/限流；HMAC + `secretVersion`；tombstone ≥24h；secret 丢失 → `enrollment-secret-unavailable`；rotate 升 secretVersion；**不得** 无故全 fleet re-enroll；**明文仅 loopback UI/CLI 一次显示**；不写 dataDir/日志/审计；默认不自动剪贴板（主动复制风险提示）；QR **`enrollmentQr/v1`** 无 secret/private key
- [ ] **T3.16** 控制器灾难恢复（§6.11）：加密 state backup/restore 校验（含 **`trustEpoch`**）；全损 `controller-state-untrusted` + fleet re-enroll；非唯一依赖 APFS snapshot；与 §6.3.4 secret-only 丢失路径 **区分**；与 §6.7.8 Case B identity 泄露路径 **对齐**
- [ ] **T3.17** Relay pin 轮换（§4.1.6 / A21–A23）：E2EE 下发签名 `relay-pin-set-update`（字段含 **`trustEpoch`**）；先持久化再 ack；双 pin overlap + grace 删 old；失败保持旧 pin + 告警；紧急 `revokeOldImmediately`；离线 fail-closed `relay-tls-pin-mismatch`；带外 replace/re-enroll 恢复；`trustEpoch ≤ lastAccepted` → `stale-epoch-rejected`
- [ ] **T3.18** Proxy 运行时路径（A26）：仅 CONNECT+Basic/Bearer；Keychain 取凭据；错误码含 **`proxy-tls-intercepted`** / pac/unsupported-auth/chain；MITM fail-closed；**禁止** 装代理 CA 绕 pin；无 secret 回显
- [ ] **T3.19** Controller Noise static lifecycle（§6.7.8 / A27–A29）：Case A — 已认证 E2EE 下发旧 Ed25519 签名的 `controller-noise-key-update`（old/new、notBefore、graceUntil、`trustEpoch`、updateId）；端点先持久化再 ack；双 key overlap；grace 后拒旧 key；审计事件齐全。Case B — Ed25519 泄露/可信不可证 → fail-closed 全 fleet replace/re-enroll + 新 identity/`trustEpoch`；**负向**：不存在用泄露 identity 在线自证新 key 的路径
- [ ] **T3.20** denylistVersion 边界（A30 / §4.6.2）：注入近 `UINT64_MAX` → **禁止 wrap**；fail-closed `controller-state-untrusted`；触发控制器信任状态迁移 + 全 fleet replace/re-enroll 可观测路径

**Exit:**

- 自动化测试覆盖 A3/A4/A5/A6/A7/A11/A13/A14/A15/A16/A17/A18/A19/A20/A21/A22/A23/A24/A25/A26/A27/A28/A29/A30 的可模拟部分
- 可标实现为 **partial** 候选，但 **`cross-lan-connectivity` ready 仍禁止**
- 无生产网络变更；无公共 SaaS 假设

**Commit boundary:** 按子系统拆分（crypto / session / counter / revoke / pin-set / noise-key-update / trustEpoch / enrollment-secret / keepalive / audit / rate-limit），每 commit 可回滚

**Rollback:** 特性默认 disabled；会话模块卸载；计数器文件随特性清理

---

### M4 — Data-plane / NAS boundary

**Goal:** 数据面密文传输边界清晰；大备份 dry-run vs real 分界；NAS 仍在控制器本机 smbfs，不经中继持凭证。

**Tasks:**

- [ ] **T4.1** 数据面 session 与控制面绑定（deviceId 作用域）
- [ ] **T4.2** 大备份 **dry-run** 路径（A8）：只计划不传
- [ ] **T4.3** Resume（§6.10 / F-RESUME-LIMIT）：`chunkId` + `cipherChunkDigest`（keyed HMAC）、幂等 ACK、重复不重写、Merkle checkpoint；每 transfer **默认 5** 次自动 resume、**可配 3–10**、**hard ceiling 10**；每次校验 checkpoint/digest + §4.4 退避；耗尽 → `data-resume-exhausted` 暂停且须 **显式 resume**（禁止静默从头/无限循环）；最终 E2E object digest（不暴露给 relay）
- [ ] **T4.4** Restore boundary 测试（临时区、跨设备不可见）（A10 可模拟部分）
- [ ] **T4.5** NAS：断言 replicate 不通过 relay 传 SMB 凭证；relay 不出现在 nas credential 路径
- [ ] **T4.6** 明确 real large backup 需 M5 硬件门（A9）
- [ ] **T4.7** A14 扩展：relay 日志无明文 hash / 可用于内容推断的静态 digest
- [ ] **T4.8** Size leak 诚实边界（§6.7.1 / §6.10）：声明 relay 可观察 ciphertext/chunk **长度序列、时序、变更量近似**；**禁止** 声称匿名/traffic-analysis resistant；**可选** 固定 bucket padding（候选 64KiB/256KiB/1MiB，最终集合以 M4 测试选型），非 Gold 必要

**Exit:**

- 契约与集成测试绿
- `real-nas-remote-backup` 不因本里程碑自动 ready
- dry-run/real 标志在 CLI/API 输出中可区分且脱敏

**Commit boundary:** `feat(v2-m4): cross-lan data-plane boundary and nas isolation`

**Rollback:** 禁用跨 LAN 数据面旗标；保留本地备份

---

### M5 — Real cross-LAN acceptance

**Goal:** 真实双机 **两个独立路由域/NAT** 验收；direct path 显式 disabled；全部 control/data 经 **operator/user-managed** 公网 WSS relay（`relayForced:true`）；生成脱敏报告。**不**要求真实 double-symmetric NAT；A2-ext 有则记扩展 PASS。

**前置（人工硬闸）：**

- [ ] 用户授权两台测试 Mac 与网络拓扑说明（不在聊天中粘贴秘密）
- [ ] 用户提供 **operator-managed-test 或 user-managed** relay（**禁止**公共生产 SaaS；**禁止** localhost/mock 充当 M5）
- [ ] **Relay 公网可达性验证（F-P2-RELAY-REACH）：** TCP 443 + WSS 握手成功；记录脱敏 DNS/TLS/pin 诊断 → `reachabilityResult` / `relayDeployment`
- [ ] Relay TLS trust anchor：测试 pin 由操作者注入（非仓库 secrets）
- [ ] 明确 **不做** 路由器端口开放 / UPnP；**direct path disabled**
- [ ] `LINKE_REAL_CROSS_LAN_ACCEPTANCE=enabled`（名称实现时可微调，但必须显式门）

**Tasks:**

- [ ] **T5.1** 验收 harness（对齐 G0a 安全模型：0600 bundle、stdin 控制、脱敏 receipt）；**强制** `cross-lan-evidence/v1` schema + `sourceCommit` 绑定（§7.2.1，含 `relayForced`/`independentNatDomains`/`relayDeployment`/`reachabilityResult`）；缺字段 FAIL；**§7.2.2** 文件名 `YYYY-MM-DD-<sourceCommitPrefix>-…`；**禁止覆盖**；遵守仓库 report 体积预算公式
- [ ] **T5.2** A1 two-machine different LAN/独立路由域；记录 `topology.sideA/B.natType`（可 unknown）、`framing`、`relayType`（非 mock）
- [ ] **T5.3** A2 **独立 NAT + 强制 relay**（§4.1.3）：`relayForced:true`；direct disabled；全部 control/data 经 operator/user-managed WSS/443；**必填** `proxyResult`/`firewallResult`/`reachabilityResult`；**不**要求 double-symmetric；可选 **A2-ext** 若环境可得；TLS 拦截拓扑：fail-closed + `proxy-tls-intercepted`，**不得** 装代理 CA
- [ ] **T5.4** A3 relay unavailable（真实停 relay）；fail-closed 无降级
- [ ] **T5.5** A4 reconnect under real jitter if possible；data resume fault：**至少连续断连 3 次并成功 resume**；另测 **10 次 hard ceiling** → `data-resume-exhausted` 后须显式 resume；可观察 keepalive（`3 × negotiatedKeepaliveInterval`）超时重连
- [ ] **T5.6** A5/A6/A20 key rotation + revocation on real path（L2 拒绝 E2EE；旧票拒绝；可观察 L1 denylist 延迟但仍安全）；A27 Controller Noise static 轮换（真实或诚实 BLOCKED）
- [ ] **T5.7** A9 large backup real **或** 正式 BLOCKED 记录（不得假 PASS）；bulk 不经控制队列；最终 E2E digest
- [ ] **T5.8** A11 audit evidence 抽检（含 pin-set / keepalive / enrollment-secret 事件若触发）
- [ ] **T5.9** A12 G0a same-LAN 回归不破坏
- [ ] **T5.10** A14 恶意/观察型 relay 字段抽检（若使用 operator-managed-test）；同 framing 模块
- [ ] **T5.11** A19 克隆/并发同 deviceId（真实或半真实双实例）
- [ ] **T5.12** 写入 `docs/superpowers/reports/YYYY-MM-DD-<sourceCommitPrefix>-cross-lan-real-acceptance.md`（schema 全字段；仅脱敏；**不覆盖**旧文件）
- [ ] **T5.13** `env.osA/osB`、`env.nodeVersion`、`env.appCommit`、`faultInjection` 写入报告
- [ ] **T5.14** A21/A23 pin 轮换（真实路径或诚实 BLOCKED，字段含 `trustEpoch`）；A26 proxy 路径若拓扑需要（含 `proxy-tls-intercepted` 诊断）；A27–A29 可测部分或诚实 BLOCKED
- [ ] **T5.15** Evidence 保留/降级/体积（§7.2.2）：本 run **不覆盖**历史 M5 文件；大体量原始日志不进 git（摘要 + 外部 digest/URI）；记录保留下限（36 月与下一 major Gold 12 月取较晚）；模拟外部 artifact 丢失 → cell **`EVIDENCE-DEGRADED`** 且必选门不得保持 ready；校验 `maxRepoReportBytes` 预算不砍必要字段

**Exit:**

- 必选真实项 PASS 或诚实 BLOCKED；**A2 必选门**（独立 NAT + `relayForced:true` + 非 mock 公网 relay）缺失 → **blocked**（A2-ext 缺失不单独阻塞）
- **仅当** A1+A2+安全项 PASS 且无必选 cell `EVIDENCE-DEGRADED` 时，才允许后续把 `cross-lan-connectivity` 标为 ready（通常在 M7 与 evidence 验证器一起做）
- 报告红线与 G0a 相同；不写 IP/URL/token/proxy secret 全文
- Evidence 文件符合 §7.2.2 命名/不覆盖/体积预算；外部 digest 可校验

**Commit boundary:**

- harness 代码可先 commit
- 报告在 PASS 后单独 `docs:` commit（新文件名，不 amend 覆盖历史 evidence）
- **不** 在同一 commit 偷偷改 overall Gold ready

**Rollback:** 删除专用 Keychain 项与 run dir；**保留** FAIL/历史 evidence 报告（不删）

---

### M6 — Remaining Gold gates evidence（M6a–M6d 独立子轨）

**Goal:** 关闭既有 partial/blocked 项的真实证据。四子轨 **证据独立、失败隔离**；单项失败不阻止其它子轨提交；**M7 仍必须 10/10**。

**公共规则（四轨共用）：**

- 与 M5 证据 **独立**；禁止用 cross-LAN PASS 冒充 NAS/automation/auth/hardening ready（反之亦然）
- 真实门需用户授权；无 secrets 输出；无生产网络/邮件副作用
- 版本号仍不升 V2.0 直至 M7
- 每轨独立 commit 前缀 `feat(v2-m6a|m6b|m6c|m6d):` / `docs:` evidence
- Evidence **不覆盖**；文件名含日期 + `sourceCommit` 前缀（§7.2.2）；**M7 前禁止删除** 任一子轨 evidence

---

#### M6a — automation-installation

| 字段 | 内容 |
| --- | --- |
| **Scorecard** | `automation-installation` → ready |
| **独立输入** | 干净测试 Mac；launchd 安装权限；非 `executor-implementation-missing` 永久 stub 的真实 adapter；回滚锚点 |
| **不依赖** | M5 cross-LAN PASS、M6b NAS、M6c/M6d 完成态 |

**Tasks:**

- [ ] **T6a.1** 确认/补真实 install→start→stop→crash-restart→uninstall 路径（RED→GREEN）
- [ ] **T6a.2** 真实验收脚本 + 脱敏报告字段（commandId、PASS/FAIL、UTC、布尔/计数）
- [ ] **T6a.3** 负向：dry-run/gate UI **不得** 单独把本项标 ready
- [ ] **T6a.4** 证据 artifact 绑定 source commit

**Exit:**

- 干净 Mac 真实验收 PASS；rollback 锚点有效
- 本项达到 spec §8.3 `automation-installation` ready 进入条件
- **不** 改 overall Gold；**不** 改其它 scorecard 项

**Commit boundary:** `feat(v2-m6a):` 实现 / `docs:` 报告 可分提交

**Rollback / 失败隔离:** 作废本轨 evidence；revert 本轨 commits；**不影响** M6b–d 与 M5 提交与旗标

---

#### M6b — real-nas-remote-backup + nas-dry-run

| 字段 | 内容 |
| --- | --- |
| **Scorecard** | `real-nas-remote-backup` → ready；`nas-dry-run` → ready（语义与真实 adapter 一致） |
| **独立输入** | 专用 smbfs 测试共享；控制器本机预挂载；**不**经 relay 传 SMB 凭证 |
| **不依赖** | M5 cross-LAN ready；M6a/c/d 完成态 |

**Tasks:**

- [ ] **T6b.1** 真实 replicate + 断连 resume + COMPLETED 完整性复验
- [ ] **T6b.2** 恢复演练（临时区边界）
- [ ] **T6b.3** 断言：NAS 路径不出现 relay credential proxy；local tmp **不得** 冒充 smbfs ready
- [ ] **T6b.4** nas-dry-run 与 real 标志可区分且脱敏
- [ ] **T6b.5** 脱敏 evidence 报告

**Exit:**

- 两项目均达 spec §8.3 进入条件
- **不** 因本轨成功把 `cross-lan-connectivity` 标 ready

**Commit boundary:** `feat(v2-m6b):` / `docs:`

**Rollback / 失败隔离:** 仅回滚 NAS 相关旗标与 evidence；**不**阻塞 M6a/c/d

---

#### M6c — security-auth

| 字段 | 内容 |
| --- | --- |
| **Scorecard** | `security-auth` → ready |
| **独立输入** | Keychain 访问授权；三角色（full/read/write）；设备身份材料；可与 M3 会话认证串联但 **evidence 独立归档** |
| **不依赖** | M5 真实双 NAT；M6a/b/d 完成态 |

**Tasks:**

- [ ] **T6c.1** 角色写入口强制生效矩阵测试 + 真实路径
- [ ] **T6c.2** Keychain 存密钥；轮换；撤销；锁定 fail-closed
- [ ] **T6c.3** 跨 LAN 会话认证串联证据（若 M3 已合入）或 LAN 设备认证 + 契约声明跨 LAN 复用同一绑定
- [ ] **T6c.4** 负向：optional bearer skeleton **不得** 当生产 ready
- [ ] **T6c.5** 脱敏 evidence

**Exit:**

- 达 spec §8.3 `security-auth` ready 进入条件
- 不单独宣布 Gold

**Commit boundary:** `feat(v2-m6c):` / `docs:`

**Rollback / 失败隔离:** 回滚 auth 旗标与本轨 evidence；**不**阻塞其它 M6 子轨

---

#### M6d — production-hardening

| 字段 | 内容 |
| --- | --- |
| **Scorecard** | `production-hardening` → ready |
| **独立输入** | 本机 Retention 真删目录、调度器、审计链存储、监控探针、升级回滚演练环境 |
| **不依赖** | M5 cross-LAN；M6a–c 完成态（限流/审计实现可复用代码，但 ready 证据独立） |

**Tasks:**

- [ ] **T6d.1** Retention 真执行 + 可恢复演练记录
- [ ] **T6d.2** 调度任务真实触发
- [ ] **T6d.3** 审计链完整性与敏感字段扫描
- [ ] **T6d.4** 监控/告警路径最小可用
- [ ] **T6d.5** 升级回滚演练
- [ ] **T6d.6** 负向：仅 hardening-status 布尔面板 **不得** ready
- [ ] **T6d.7** 脱敏 evidence

**Exit:**

- 达 spec §8.3 `production-hardening` ready 进入条件
- 不单独宣布 Gold

**Commit boundary:** `feat(v2-m6d):` / `docs:`

**Rollback / 失败隔离:** 回滚 hardening 旗标与本轨 evidence；**不**阻塞其它 M6 子轨

---

#### M6 总出口（进入 M7 前）

```text
M6a exit AND M6b exit AND M6c exit AND M6d exit
AND 旧九项中与 M6 相关的 partial/blocked 均已按 §8 ready
AND M5 出口满足（可时间上后于或先于，但 M7 前必须同时真）
⇒ 允许进入 M7 发布清单
⇒ 仍禁止在 M6 将 overall Gold 标 ready
```

---

### M7 — Release candidate → Gold/GA

**Goal:** 唯一允许声明 V2.0 Gold/GA 的窗口。

**Tasks:**

- [ ] **T7.1** 扩展 `src/gold-readiness.js`：新增 `cross-lan-connectivity`；**仅在证据验证通过的构建策略下** 标 ready（推荐：静态 scorecard 在 evidence 验证命令确认后人工/脚本更新，避免假 ready）
- [ ] **T7.2** `gold-evidence-v1`（或既有设计）校验：schema、签名、source commit、时效；含 M5 + M6a–d artifacts；**§7.2.2** 命名/不覆盖/可判定保留下限（工作树 ≥36 月且至下一 major Gold 满 12 月取较晚；外部 artifact digest 绑定；丢失则证据降级；清理须审批审计；**M7 前不得删除** M5/M6 evidence）
- [ ] **T7.3** `src/version.js` → `V2.0` 与 README / health / tests 一致性
- [ ] **T7.4** 全量 `node --test` + 真实门复跑摘要
- [ ] **T7.5** 发布声明：支持边界 + 非目标 + 安全红线（含：无公共 relay SaaS 默认托管；hop TLS ≠ E2EE；enrollment secret/proxy secret 边界）
- [ ] **T7.6** 最终对抗清单 §11 全勾选；确认无 P0（含 crypto bootstrap + §6.7.7 library gate ADR 存在）
- [ ] **T7.7** 确认当前基线事实已翻转为证据支持的 V2.0 状态后才改 scorecard（**在此之前保持诚实：实现完成前仍是 V1.33 叙事**）
- [ ] **T7.8** 确认 M1 Noise library ADR 仍有效且依赖未 silent 替换；确认 A21–A29 契约在实现中可追溯

**Exit（充分必要）：**

```text
ready == 10 AND partial == 0 AND blocked == 0
AND M5 real report PASS for required cells
AND M6a AND M6b AND M6c AND M6d exits
AND no P0 open (including §6.7 crypto constraints + §6.7.7 library gate)
AND evidence retention rules §7.2.2 satisfied
AND user approval to tag GA
```

**Commit boundary:**

1. evidence + scorecard + version + README 可同一发布 commit 或紧邻 stack
2. **必须** 用户确认后才 commit/push/tag
3. 若任何门失败：**禁止** 升 V2.0 ready

**Rollback:**

- 立即回退 version/scorecard/README 至 blocked
- 作废错误 GA 声明
- 保留失败审计

---

## Test Strategy Summary

| 层级 | M1 | M2 | M3 | M4 | M5 | M6a–d | M7 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Unit / contract | 必 | 必 | 必 | 必 | 回归 | 分项 | 全量 |
| Fault injection | 重放/串线/降级/skew/容量/向量乱序 | relay down / no confirm / proxy fail | 限流/重连/reservation 崩溃/L2 撤销/克隆/备份损坏 | dry-run resume 幂等 / 队列分离 | 真实抖动/NAT/proxy/firewall | 分项真实故障 | 全 |
| Crypto / E2EE | fixed vectors + 顺序 | dry-run IK + 同 framing | **完整 §6.7 IK** | keyed resume digest | 真实路径抽检 | M6c 串联 | 复验 |
| Real Keychain | 否 | 否 | 可选 | 否 | 建议 | M6c 是 | 是 |
| Real dual-machine | 否 | 否 | 否 | 否 | **是** | M6a 视项 | 是 |
| Real different LAN/NAT | 否 | 否 | 否 | 否 | **是** | 否 | 复验 |
| Scorecard ready 允许 | 否 | 否 | 否 | 否 | 仅 cross-lan 候选 | 分项候选 | **10/10** |

---

## Mapping to Current Blockers（执行检查表）

| Item | 当前（V1.33 事实） | M 轨 | ready 前禁止事项 |
| --- | --- | --- | --- |
| automation-installation | partial | M6a | 仅 dry-run/gate UI |
| real-nas-remote-backup | blocked | M6b | 本地 tmp 冒充 smbfs；经 relay 传 SMB 凭证 |
| nas-dry-run | partial | M6b | dry-run 冒充实 NAS |
| security-auth | partial | M3+M6c | optional bearer 当生产；hop TLS 当 E2EE |
| production-hardening | partial | M6d | 仅 hardening-status 面板 |
| cross-lan-connectivity | 缺失=blocked | M1–M5 | G0a/V1.33/同 LAN/mock/mTLS 冒充 |
| 其它 ready 项 | ready（原型） | M4–M7 复验 | 回归失败时降级 |

---

## Commit Boundary Cheat Sheet

| 里程碑 | 建议 commit 前缀 | 可否改 Gold overall ready |
| --- | --- | --- |
| M0 | `docs:` | 否 |
| M1 | `test:` / `feat(v2-m1):` | 否 |
| M2 | `feat(v2-m2):` | 否 |
| M3 | `feat(v2-m3):` | 否 |
| M4 | `feat(v2-m4):` | 否 |
| M5 harness | `test:` / `feat(v2-m5):` | 否 |
| M5 report | `docs:` | 否 |
| M6a | `feat(v2-m6a):` | 仅本项候选；overall 否 |
| M6b | `feat(v2-m6b):` | 仅本项候选；overall 否 |
| M6c | `feat(v2-m6c):` | 仅本项候选；overall 否 |
| M6d | `feat(v2-m6d):` | 仅本项候选；overall 否 |
| M7 | `release:` / `feat(v2.0):` | **是（唯一；且 10/10）** |

---

## Frozen numeric defaults（与 spec 对齐，防漂移）

| 项 | 值 |
| --- | --- |
| Clock skew 默认 | ±120s |
| Clock skew 配置上限 | ±600s（下限 30s） |
| 控制队列默认 | 256 msg / 1 MiB / device；单条 64 KiB |
| 控制队列 hard ceiling | 1024 msg / 4 MiB |
| P0 撤销 ring | 64 条，独立于普通控制队列 |
| 数据面 inflight 默认 | 64 MiB / device（ceiling 256 MiB） |
| 速率 | 30 msg/s，burst 60（ceiling 60/s，burst 120） |
| 会话/连接 | 2 会话 / 4 连接（ceiling 4 / 8） |
| 重连退避 | 1s ×2，cap 60s，抖动 ±20% |
| Keepalive 间隔 | **仅** `negotiatedKeepaliveInterval`：默认 30s；可配 5–120s；超过 `3 ×` 无 **应用层** pong/已认证流量 → 断连；WS ping 不刷新 timer |
| 接收序号窗口 | **64**（必须 `window > R`） |
| Counter reservation R | **32**（ceiling 256；硬约束 `R < window`；崩溃 gap ≤32） |
| `trustEpoch` | 控制器全局单调 uint64；关键信任更新递增；端点拒绝 `≤ lastAcceptedTrustEpoch`；与 `enrollmentEpoch` 正交 |
| 撤销在线 SLO | L2 ≤5s 关会话；L1 denylist 尽力 ≤10s（非权威） |
| Denylist tombstone | ≥24h 后可 GC；GC 不复活旧 epoch |
| Enrollment code | 128-bit CSPRNG；base64url/QR；TTL 10min；单次；HMAC-SHA256 digest |
| Enrollment HMAC secret | **首次启动自动** 32B CSPRNG → Keychain 独立 item；禁手输/日志/明文传输；`secretVersion`；丢失 → `enrollment-secret-unavailable`（不强制全 fleet re-enroll） |
| Enrollment tombstone | ≥24h；GC 后统一拒绝；secret rotate 作废旧 secretVersion namespace |
| Enrollment 交付 | 明文仅 loopback UI/CLI 一次；默认不剪贴板；QR=`enrollmentQr/v1` 无 secret/private key |
| denylistVersion | uint64 单调；禁止 wrap；近 `UINT64_MAX` → `controller-state-untrusted` + fleet re-enroll |
| Size leak | 接受长度/时序观察；可选 M4 bucket padding；不承诺 traffic-analysis resistance |
| M5 relay | operator/user-managed 公网 443/WSS；mock/localhost 禁用；`relayForced:true` |
| Data resume | 每 transfer 默认 **5** 次自动；可配 **3–10**；hard ceiling **10**；keyed cipherChunkDigest；Merkle checkpoint；耗尽须显式 resume |
| Transport | WSS / TLS 1.3 / TCP 443；双方 outbound；无 raw TLS 降级 |
| Proxy | 仅显式 HTTP CONNECT + Basic/Bearer；secret→Keychain；错误码含 auth/connect/pin/**`proxy-tls-intercepted`**/pac/unsupported-auth/chain；PAC/NTLM/链/MITM non-goal fail-closed |
| Relay pin 轮换 | E2EE 签名 pin-set + **`trustEpoch`**；双 pin overlap；先持久化后 ack；失败保旧 pin；紧急吊销 old |
| Controller Noise static | Case A：`controller-noise-key-update` + 旧 Ed25519 签名 + 双 key overlap；Case B：identity 泄露 → 全 fleet re-enroll（禁止泄露 identity 自证） |
| Crypto | Ed25519 身份 + Noise_IK_25519_ChaChaPoly_SHA256（唯一）；prologue `linke-v2/cross-lan/noise-ik/v1`；库选型 M1 §6.7.7 gate |
| Evidence | `cross-lan-evidence/v1` + sourceCommit + `relayForced`/`reachabilityResult`；不覆盖；36 月+下一 major 12 月；外部 digest；丢失→`EVIDENCE-DEGRADED`；`maxRepoReportBytes = min(512 KiB, 32 KiB + 4 KiB × cellCount + 8 KiB × schemaObjectCount)` |

---

## Qwen 抗辩 Checklist（执行用）

### P0 — 阻塞发布

- [ ] P0-1 无 G0a/V1.33/同 LAN 冒充 cross-LAN ready 的代码路径或文档措辞
- [ ] P0-2 relay 元数据最小化测试存在且失败会红；relay **不参与 KE**、无会话/长期密钥
- [ ] P0-3 安装/运维文档无“必须端口映射”
- [ ] P0-4 无未认证公网 proof/enroll
- [ ] P0-5 cross-LAN 不抬升 lifecycle execute
- [ ] P0-6 无协议降级明文/无 E2EE/仅 hop TLS 模式
- [ ] P0-7 报告/日志敏感扫描通过
- [ ] P0-8 无无限版本号堆叠宣称
- [ ] P0-9 §6.7 Noise_IK_25519_ChaChaPoly_SHA256 已实现；§6.7.7 library gate ADR 通过；fixed vectors + A16/A17
- [ ] P0-10 无“或等价 KE”开放实现；token 序列冻结
- [ ] P0-11 Transport 仅为 WSS/TLS1.3/443；无 raw TLS 自动降级
- [ ] P0-12 无静默自研 Noise / 无 ADR 合入握手实现

### P1 — 发布前应关闭或书面接受

- [ ] P1-1 M5 与 mock 结果隔离；`relayType` + §7.2.1 schema
- [ ] P1-2 时钟偏移：默认 ±120s、上限 ±600s、错误码、运维恢复；nonce/seq 主防重放
- [ ] P1-3 离线队列硬上限 + 控制/bulk 分离 + P0 独立 ring
- [ ] P1-4 重连退避与连接上限；独立 NAT+`relayForced` 必要门；A2-ext 可选；A2 proxy/firewall/reachability
- [ ] P1-5 NAS 与 cross-LAN 证据不互相替代；M6 子轨失败隔离
- [ ] P1-6 README / scorecard / version 一致
- [ ] P1-7 计数器 R=32 / window=64（`R < window`）+ gap≤32 + 精确 rollback + re-enroll；0600 ≠ Keychain
- [ ] P1-8 克隆/并发 deviceId + replace-device；无硬件指纹主信任
- [ ] P1-9 撤销两层 L1/L2 + 旧票全废 + SLO；不依赖“relay 必先拒”
- [ ] P1-10 无公共生产 relay SaaS 暗示；仅自建/用户管理
- [ ] P1-11 Evidence 含 topology NAT、`relayForced`、reachability、framing、proxy/firewall、perCell、env、faultInjection；§7.2.2 命名/保留/体积/`EVIDENCE-DEGRADED`
- [ ] P1-12 Enrollment 128-bit + HMAC + tombstone + secret lifecycle + loopback 一次显示 + QR v1
- [ ] P1-13 Data resume 幂等 + keyed digest + 默认 5/可配 3–10/ceiling 10；耗尽须显式 resume
- [ ] P1-14 控制器加密备份/恢复校验；全损 fail-closed
- [ ] P1-15 过期码 GC 后统一拒绝
- [ ] P1-16 Enrollment secret 首次启动自动 CSPRNG 32B→Keychain；丢失不误判全 fleet re-enroll
- [ ] P1-17 Relay pin 轮换签名/`trustEpoch`/overlap/失败保旧/紧急吊销/离线 fail-closed
- [ ] P1-18 Proxy 仅 CONNECT+Basic/Bearer；Keychain；PAC/NTLM/链/MITM fail-closed；无日志回显
- [ ] P1-19 Keepalive 应用层 AEAD ping/pong；WS ping 不刷新 timer；30s/5–120s/`3 ×`
- [ ] P1-20 Gold evidence 不覆盖；`EVIDENCE-DEGRADED` 传导；体积预算；清理审批；M7 前不删 M5/M6
- [ ] P1-21 Controller Noise static Case A 在线更新 vs Case B 全 fleet re-enroll；禁止泄露 identity 自证
- [ ] P1-22 `trustEpoch` 全局单调；拒绝 ≤ lastAccepted；与 `enrollmentEpoch` 正交
- [ ] P1-23 不把 double-symmetric 设为 Gold 硬门；A2=`relayForced`+独立 NAT
- [ ] P1-24 不声称 traffic-analysis resistant；size leak 诚实
- [ ] P1-25 denylistVersion 禁止 wrap；近 UINT64_MAX → controller-state-untrusted
- [ ] P1-26 T1.0 BLOCKED 7 日 ADR；fixed-fixture 非静默捷径
- [ ] P1-27 M5 禁用 mock/localhost；公网 relay 可达性证据

### 失败条件（命中即停止 M7）

- [ ] 任一门禁 non-ready（非 10/10）
- [ ] M6a–d 任一未出口
- [ ] 真实报告缺失或 commit 不匹配
- [ ] 可复现 P0（含 crypto / library gate）
- [ ] 用户未授权真实门却标记 PASS
- [ ] Evidence 被覆盖或 M7 前删除导致不可审计
- [ ] 必选 cell `EVIDENCE-DEGRADED` 仍宣称 ready
- [ ] M5 使用 mock/localhost 或缺少 `relayForced:true`

### 回滚策略（演练）

- [ ] 文档 M0 可删改
- [ ] 功能旗标可关
- [ ] 单 M6 子轨 evidence 可作废（标记作废，**不**物理抹掉 M7 前所需历史）而不拖垮其它轨
- [ ] M7 误发可回退 version/scorecard
- [ ] 测试 Keychain/run dir 可 cleanup

### 验收前置

- [ ] Spec 冻结确认（含 §4.1.3 / §4.1.5 / §4.1.6 / §4.4 / §4.5 / §4.6 / §6.3 / §6.3.1.1 / §6.3.4 / §6.7 / §6.7.7 / §6.7.8 / §6.8 / §6.9 / §6.10 / §6.11 / §6.12 / §7.2.1 / §7.2.2）
- [ ] 自动化全绿
- [ ] 真实资源授权（双机 / 可选 operator-managed-test relay / NAS / launchd）
- [ ] 无 secrets 输出
- [ ] 无生产网络/邮件副作用
- [ ] G0a 回归策略明确
- [ ] M1 Noise library ADR 已归档且未过期失效

---

## Phase 0（现在）完成定义

1. Spec + Plan 已写入指定路径，并闭合 **F-01–F-23**、历史返修项，以及第五轮 **F-P1-M5-SYMMETRIC / F-P1-SIZE-LEAK / F-P1-PROXY-SCOPE / F-P1-EVIDENCE-LOSS / F-P2-COUNTER-GAP / F-P2-WS-PING / F-P2-ENROLL-DELIVERY / F-P2-RELAY-REACH / F-P2-M1-CONTINGENCY / F-P2-DENYLIST-U64**<br>
2. 未修改源码/测试/README/Gold scorecard；未创建其它文件<br>
3. 未 commit / push<br>
4. 当前事实保持：**V1.33**、Gold **blocked**、cross-LAN **未实现**；文档仅定义未来 V2.0 目标<br>
5. 无 TBD/TODO/FIXME；spec↔plan 数值/术语/门禁/M0–M7 一致<br>

**下一步（需用户明确启动实现时）：** 确认 M0 → 开 M1（**先 T1.0 library gate**）RED 测试任务；仍禁止擅自 commit/push。

---

## References

- Spec: `docs/superpowers/specs/2026-07-16-linke-v2-gold-cross-lan-release-design.md`
- Gold single-mac: `docs/superpowers/specs/2026-07-13-linke-gold-single-mac-release-design.md`
- Gold roadmap: `docs/superpowers/plans/2026-07-13-linke-gold-execution-roadmap.md`
- G0a report: `docs/superpowers/reports/2026-07-13-g0a-real-keychain-lan-acceptance.md`
- V1.33 design: `docs/superpowers/specs/2026-07-14-supervisor-lifecycle-real-status-capability-handler-design.md`
- Scorecard source: `src/gold-readiness.js`（实现阶段再改）
