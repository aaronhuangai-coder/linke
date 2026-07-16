# Linke V2.0 Gold / GA + Cross-LAN Release Design

## 0. 文档元数据

| 字段 | 值 |
| --- | --- |
| 文档类型 | 产品/架构设计（spec） |
| 版本目标 | **V2.0 = Gold / GA 目标版本** |
| 基线 HEAD（文档编写时） | `f21d520`（工作区干净；当前产品里程碑仍为 **V1.33**） |
| 关联 plan | `docs/superpowers/plans/2026-07-16-linke-v2-gold-cross-lan-release.md` |
| 本阶段范围 | **docs only** — 仅允许新增本 spec 与对应 plan；禁止改源码、测试、README、Gold scorecard |
| 上游冻结声明 | V1.33 §12.4：Gold/GA 与跨局域网仅在 V2.0 定义；不得用本机 status / same-LAN / G0a 冒充 |
| G0a 真实证据 | `docs/superpowers/reports/2026-07-13-g0a-real-keychain-lan-acceptance.md` = **same-LAN dual-Mac PASS**，**不是** cross-LAN Gold |

---

## 1. 目标与裁决

### 1.1 产品目标

V2.0 是 Linke **Gold / GA（General Availability）** 的唯一目标版本标签：

1. **Gold ready** 表示：充分必要门禁清单 **全部** 达到 `ready`，且每项具备可审计的真实边界证据。
2. **GA** 与 Gold 同门：V2.0 不设“功能齐但证据残缺”的伪 GA；**仅当 Gold ready 后** 才允许 README / scorecard / 发布声明使用 Gold 或 GA 措辞。
3. **跨局域网（cross-LAN）** 是 Gold **新增强制门禁**，与既有 9 项 scorecard 并列，缺一不可。
4. **V1.x** 继续作为可审计里程碑（本机 lifecycle proof、G0a same-LAN trust 等），**不得**被抬升为 Gold/GA。

### 1.2 当前事实基线（不得美化）

| 事实 | 状态 |
| --- | --- |
| 产品版本 | **V1.33** — second real status observational metadata proof only |
| Gold scorecard (`src/gold-readiness.js`) | overall **`blocked`**；`real-nas-remote-backup` = blocked；`automation-installation` / `security-auth` / `production-hardening` / `nas-dry-run` = partial |
| G0a | 真实双 Mac **same LAN** Keychain/TLS/enrollment/rotate/revoke **PASS** |
| V1.33 real status | 单机 fixed-path metadata 观测；`executionEligible:false`；非 multi-host |
| 跨局域网协议 | **不存在** |
| 出站中继 / reverse connection | **不存在** |
| 生产 inbound 公网端口要求 | 明确 **禁止** 作为 Gold 前置 |

### 1.3 方案比较与裁决

| 方案 | 内容 | 裁决 |
| --- | --- | --- |
| A | V2.0 = Gold/GA 唯一目标；跨局域网为强制新门禁；有限里程碑闭合 | **采用** |
| B | 继续 V1.x 无限堆叠，每版宣称“更接近 Gold”但不冻结门禁 | **拒绝** — 与产品门禁冲突 |
| C | 把 G0a same-LAN 或 V1.33 本机 status 记为 cross-LAN ready | **拒绝** — 威胁模型与拓扑不符 |
| D | 要求家宽/路由器打开 inbound 端口完成跨局域网 | **拒绝** — 用户硬约束；Gold 必须 **no inbound port requirement** |
| E | 中继可解密备份内容或持有设备长期密钥 | **拒绝** — 中继只能转发密文与最小元数据 |

---

## 2. 版本策略（有限路线，禁止无限堆叠）

### 2.1 版本语义冻结

```text
V1.x  = 可审计里程碑（audit trail / proof / partial readiness）
        允许局部 ready fact；禁止 Gold/GA 宣称

V2.0  = Gold/GA 目标版本
        仅当 §3 充分必要门禁全部 ready + 证据齐全 才可标记
        不允许“V2.0-rc 功能齐但 cross-LAN 未验”冒充 Gold

V2.0 内部里程碑 = M0..M7（有限集合，见 §2.2）
        不是对外发布版本号；不创造 V2.01 / V2.02 … 无限系列
```

**硬规则：**

1. 不得在证据不全时把 `src/version.js` / README / Gold scorecard 标为 V2.0 Gold ready。
2. V1.34+ 若在 V2.0 实现阶段前仍需交付，只能继续作为 V1.x 可审计增量，**不得**抢占 Gold 宣称。
3. V2.0 实现阶段内部可用 commit 消息前缀 `feat(v2-mN):`，但 **release version 字符串** 仅在 M7 证据齐备后切到 `V2.0` 并同步 scorecard。
4. **禁止** 用“又加一个 partial readiness stub”替代真实门禁闭合。

### 2.2 有限里程碑 M0–M7（充分必要拆分）

| 里程碑 | 名称 | 出口条件（充分必要子集） | 是否可宣称 Gold |
| --- | --- | --- | --- |
| **M0** | Design freeze | 本 spec + plan 冻结；威胁模型与门禁清单评审通过 | 否 |
| **M1** | Protocol skeleton + unit contracts | **§6.7.7 Noise library selection gate 通过或正式 BLOCKED**；协议状态机、错误码、token scope、消息 schema 单测全绿；无网络副作用 | 否 |
| **M2** | Relay/client handshake dry-run | 本地 loopback 模拟不同拓扑的握手 dry-run；中继不持密钥/明文证明 | 否 |
| **M3** | Encrypted control channel | 端到端加密控制面；双向认证；重放防护；限流；审计事件；密钥轮换 dry-run | 否 |
| **M4** | Data-plane / NAS boundary | 数据面与 NAS 边界隔离；大备份 dry-run vs real 分界清晰；中继不经明文备份内容 | 否 |
| **M5** | Real cross-LAN acceptance | §7 必选项（A1/A2：**独立路由域/NAT + relayForced** 等）PASS + 公网 WSS relay 可达证据 + 脱敏报告；**不**要求 double-symmetric | 否（仅 cross-LAN 项可 partial→ready 候选） |
| **M6** | Remaining Gold gates evidence | **M6a–M6d 四条独立子轨**各自出口满足（§9.3）；单项失败不阻止其它子轨提交；全部齐备后方可进 M7 | 否 |
| **M7** | Gold RC → GA | scorecard **10/10 ready**；签名 evidence 验证通过；发布声明与 README 同步；**M5 与 M6a–M6d 全部出口满足** | **是（唯一窗口）** |

```text
M0 → M1 → M2 → M3 → M4 → M5 ──┐
                      ↘         ├→ M7 (requires 10/10)
         M6a ‖ M6b ‖ M6c ‖ M6d ─┘
         (可与 M3–M5 有限并行；证据独立；单轨失败可回滚该轨)
```

**不允许** M8+ 无限扩展；若 M7 失败，只能：

- 回退到最近 green 里程碑并修复；或
- 显式修订本 spec（变更控制），**不得** silent 降级门禁。

### 2.3 什么明确 **不是** V2.0 Gold 证据

| 证据 | 可作为 | 不可作为 |
| --- | --- | --- |
| V1.33 real status proof | V1.x 里程碑 / lifecycle observational proof | cross-LAN / Gold |
| G0a dual-Mac same-LAN PASS | same-LAN trust foundation（G0a） | cross-LAN / 不同 NAT / relay |
| 同 LAN direct 连接成功 | LAN direct 场景子集 | 跨局域网完整门禁 |
| dry-run / preview / blocked stub | 设计进度 | scorecard ready |
| 单机 mock relay | M1–M4 契约 | M5 real acceptance |
| release-readiness healthy | 可运行版本健康 | Gold overall ready |

---

## 3. V2.0 Gold/GA 充分必要门禁清单

### 3.1 Scorecard 扩展（产品门禁）

现有 `src/gold-readiness.js` 有 9 项。V2.0 **必须** 新增第 10 项：

| id | area | 含义 |
| --- | --- | --- |
| `cross-lan-connectivity` | `network` | 跨局域网 outbound-only relay / reverse connection 能力 + 真实不同 LAN/NAT 验收 |

**Gold ready 充分必要条件（AND）：**

```text
∀ item ∈ {
  release-readiness,
  local-backup-restore,
  fleet-device-management,
  version-consistency,
  nas-dry-run,
  automation-installation,
  security-auth,
  real-nas-remote-backup,
  production-hardening,
  cross-lan-connectivity   // NEW mandatory
}:
  status(item) == ready
  AND evidence artifact valid for current source commit
  AND real-boundary type matches §5 entry criteria

⇒ overall Gold status == ready
⇒ 允许 V2.0 / Gold / GA 发布声明
```

**任一** item 为 `partial` 或 `blocked` ⇒ overall **blocked 或 partial**，**禁止** Gold/GA。

### 3.2 GA 与 Gold 的关系

| 概念 | 定义 |
| --- | --- |
| Gold | 产品能力与真实证据门禁全部闭合 |
| GA | 对外支持边界声明：支持 macOS 控制器 + 多端点 + 预挂载 SMB NAS + **same-LAN direct 与 cross-LAN outbound-only**；明确不支持内容见 §3.3 |
| RC | M7 前的候选构建；可跑全量验收，**不得**改 scorecard 为 ready |

**裁决：** GA ⊆ Gold 证据集。没有“GA 先发、Gold 后补”。

### 3.3 明确非目标（不计 Gold 缺口，也不得降低安全要求）

- 多控制器集群 / 全球 Anycast / **Linke 公共生产中继 SaaS**（V2.0 **不提供**默认托管；仅自建/用户管理 relay，见 §4.1.4）
- 要求用户打开路由器 inbound 端口 / UPnP / 公网 proof API 滥用面
- 中继可持有备份明文、设备长期私钥、会话密钥、或可离线解密材料；中继参与 E2E 密钥派生
- 将 hop mTLS / TLS-to-relay 宣称为 payload E2EE
- 以不稳定/隐私敏感硬件指纹作为 deviceId 或主信任根
- OAuth/OIDC/LDAP 企业 IdP（可后置；不阻塞 V2.0 若本地角色+设备身份完备）
- 非 macOS 端点
- 静默协议降级到无加密 / 无认证 / 无 E2EE 模式
- 自创密码算法或非标准 KE/AEAD 组合
- **PAC/WPAD**、**NTLM/Kerberos/Negotiate** 代理认证、**代理链**、企业 **TLS MITM** 兼容路径（§4.1.5；仅显式 HTTP CONNECT + Basic/Bearer）
- 对 relay/路径观察者 **隐藏流量形状** 或声称 **匿名 / traffic-analysis resistant**（§6.7.1；长度序列为接受残余风险）
- 将 **真实 double-symmetric NAT** 观测结果作为 Gold **必要条件**（§4.1.3；必要门为独立 NAT + `relayForced`）

---

## 4. 跨局域网产品定义

### 4.1 拓扑与连接模式

```text
┌─────────────┐     same LAN      ┌──────────────┐
│ Endpoint A  │◄── direct TLS ──►│  Controller  │
└─────────────┘   (G0a 已证明子集) └──────┬───────┘
                                          │
┌─────────────┐   different LAN/NAT       │ outbound-only
│ Endpoint B  │── reverse / relay ────────┤
└─────────────┘   (两端主动出站)           │
                                          ▼
                                   ┌─────────────┐
                                   │ Relay (opt) │
                                   │  opaque     │
                                   │  forwarder  │
                                   └─────────────┘
```

#### 4.1.1 Same-LAN direct

- 控制器 Agent listener 绑定**管理员显式确认的私有 LAN 地址**（继承 G0a：默认不 `0.0.0.0`）。
- 端点证书 pin + 设备 token；管理面 loopback 与设备面分离。
- **已有证据：** G0a real dual-Mac PASS（同 LAN）。
- **作用：** 作为 trust foundation 与 local fleet 基线；**不**满足 cross-LAN 门禁。

#### 4.1.2 Different-LAN outbound-only relay / reverse connection

**产品定义（强制）：**

1. **No inbound port requirement**：家庭/企业 NAT 后的端点与控制器**均不要求**对公网打开 inbound 端口。
2. 需要跨局域网时，端点与控制器（或双方）对 **relay** 或对方可达的 rendezvous 发起 **outbound** 连接；会话建立后形成 **reverse connection / 双向逻辑信道**。
3. Relay 是 **元数据最小化的密文转发器**，不是控制器、不是备份存储、不是密钥托管；**绝不参与**端到端会话密钥派生（见 §6.7）。
4. 若两端某时刻可达（如 VPN / 临时公网），允许 direct 优先；**必须**支持在仅 outbound 可达时退到 relay，且 **不得** 静默降级加密或身份校验。

#### 4.1.3 NAT 行为分类与连接策略（F-03 / F-P1-M5-SYMMETRIC）

| NAT 类型 | 典型行为 | V2.0 Gold 策略 |
| --- | --- | --- |
| **Full-cone** | 一次 outbound 后外部任意源可达同一映射 | 可尝试 direct / 有限 hole-punch；失败则 relay |
| **Address/Port-restricted** | 仅先前联系过的对端地址/端口可回连 | 可尝试协调 hole-punch；失败则 relay |
| **Symmetric** | 每目标映射不同；外部不可预测 | direct/hole-punch **不可靠**；走 outbound relay |
| **unknown** | 观测/分类工具不可靠或未部署 | **允许**在 evidence 中记 `unknown` / `unknown-documented`；**不**阻塞 Gold（见下硬门） |

**硬规则（可验证必要门，PM 裁决）：**

1. **禁止** 把「必须真实双对称 NAT（symmetric↔symmetric）」设为 Gold **必要条件**。NAT 类型常 **不可可靠观测/复现**（运营商 CGNAT、双层 NAT、STUN 误判、防火墙中间态），故不得以“测到 double-symmetric”作为发布门。
2. **Gold 可验证必要门（M5 / A2 冻结）——独立路由域/NAT + 强制 relay：**
   - 两台 **真实机器** 位于 **两个独立路由域 / 独立 NAT**（不同广播域或不同上行路由边界；单机双进程 / same-LAN **不**满足）；
   - **direct path 显式 disabled**（配置/会话策略禁止直连与 hole-punch 尝试，或等价 fail-closed 关闭 direct 候选）；
   - 全部 **control 与 data** 流量 **必须** 经 **operator-managed-test 或 user-managed** WSS relay（§4.1.5；**禁止** localhost/mock 冒充 M5）；
   - evidence **必须** 记录：`topology.sideA/B.natType`（**允许** `unknown` / `unknown-documented`）与 **`relayForced: true`**。
3. **为何充分验证 deterministic fallback：** 在 direct 被显式关闭、两端仅能经独立 NAT 后的 outbound 到达公网 relay 时，会话与业务路径 **唯一** 可行路由即 WSS relay。若 E2EE 控制/数据面在此拓扑下仍 PASS，即证明产品在「直连不可用 / 不可依赖」条件下的 **确定性 outbound-relay fallback** 成立——这正是双对称 NAT 场景下产品必须保证的行为子集。双对称只是该子集的更严特例，而非可测必要条件。
4. **强推荐扩展 cell（非阻塞）：** 若能获得 **double-symmetric** 环境，应作为 **A2-ext / strongly-recommended extension cell** 额外记录；**缺失不单独阻塞 Gold**。但「独立 NAT + `relayForced:true`」缺失 → 该 M5 门 **必须 `blocked`**，不得 ready。
5. **Outbound relay 是确定性 fallback**：任一端仅能 outbound、direct disabled、或打洞失败时，**必须**能经 relay 建立 E2E 会话且无端口映射步骤；不得因无法证明 NAT 细分类而宣称 cross-LAN 失败。

#### 4.1.4 Relay 部署 / 发现 / TLS trust anchor（V2.0 冻结）

| 维度 | V2.0 冻结选择 |
| --- | --- |
| **部署模型** | **自建 / 用户管理的 relay**（测试机或用户自有主机）。**禁止**暗示已存在 Linke 公共生产 SaaS 中继。 |
| **发现** | 控制器在 enrollment 带外材料中下发 `relayEndpoints[]`（主机名或固定 pin 的端点描述 + 端口 **443**）；端点与控制器均 **主动 outbound** 连接 relay。无公网 DNS-SD 强制依赖。 |
| **TLS trust anchor 注入** | 管理面显式配置 **relay 服务端证书 pin**（SPKI/sha256 digest）或私有 CA pin；写入控制器 dataDir 的 **配置/pin 存储**（非密钥保险箱语义，见 §6.8 对比）。端点经 **enrollment 信任锚**（§6.7）获得同一 pin 集合。**运行时 pin 轮换**见 §4.1.6（不得仅靠静默 TOFU）。 |
| **TLS 角色** | Relay hop TLS **仅**保护 hop/transport（防路径窃听与连接劫持到未 pin 的主机）；**不得**冒充 payload E2EE。 |
| **测试边界** | M2 mock relay（loopback）≠ M5 自建测试 relay ≠ 公共 SaaS。报告必须标明 relay 类型：`mock` / `operator-managed-test` / `user-managed`。**`mock` / localhost 不得用于 M5**（§7.2 / F-P2-RELAY-REACH）。 |
| **M5 前置可达性（F-P2-RELAY-REACH）** | M5 开始前必须验证 **operator/user-managed** relay 的 **公网 TCP 443 / WSS** 可达（DNS 解析、TCP 连通、TLS 1.3 握手、SPKI pin 匹配摘要）。evidence 必填 `relayDeployment`、`reachabilityResult` 与脱敏 DNS/TLS/pin 诊断桶。**localhost、loopback、`relayType=mock` 一律不得作为 M5 证据路径。** |
| **运维责任** | 测试 relay 由验收操作者启停；用户生产 relay 由用户自己部署与轮换 pin；Linke 产品不默认托管。 |

#### 4.1.5 Relay transport framing（P0 冻结，F-10 + F-20）

| 维度 | V2.0 冻结定义 |
| --- | --- |
| **协议** | **WSS** = WebSocket over **TLS 1.3**，目标 **TCP 443** |
| **连接方向** | 端点与控制器 **双方只发 outbound** 连接至 relay；形成双向逻辑信道 |
| **端口语义** | Relay 可在公网 **监听 443** 以接受客户端 outbound；**不等于** 用户端点或控制器家庭/企业 NAT 后设备被要求打开 inbound 端口（仍满足 §4.1.2 no inbound port requirement） |
| **禁止自动降级** | **不**设置 raw TLS（无 WebSocket）自动降级；**不**降到 TLS 1.2 或明文 WS/TCP 作为生产路径；协商失败 → **fail-closed** |
| **HTTP CONNECT 代理（V2.0 唯一代理支持面）** | 仅支持管理员 **显式** 配置的 **HTTP CONNECT** 路径（`proxyUrl`）；代理后仍必须承载 **WSS/TLS 1.3**；证书校验与 SPKI pin **不降级** |
| **代理认证（唯一）** | 仅 **Basic** 或 **Bearer**（`Proxy-Authorization`）；凭据 **只** 存 Keychain **独立 item**。**禁止** 以普通 `0600` 文件作为 Gold 生产路径存放 proxy 口令/Bearer |
| **proxy URL vs 凭据** | `proxyUrl`（主机/端口/scheme，**无**嵌入 userinfo 明文 secret）可写配置；禁止在日志、审计、错误回显、evidence 中出现 proxy secret 或 Authorization 头原文 |
| **代理 non-goal / fail-closed（F-P1-PROXY-SCOPE）** | 下列 **均非** V2.0 Gold 支持面，检测或配置尝试 → **fail-closed**（不得静默忽略后直连成功冒充“代理可用”）：**PAC / WPAD** 自动发现；**NTLM / Kerberos / Negotiate** 等质询式代理认证；**代理链**（多跳 CONNECT / 链式 `proxyUrl`）；**TLS MITM / 企业 HTTPS 拦截**（见下行）。错误码见互斥桶 |
| **企业 TLS 拦截 / MITM 代理（F-PROXY-MITM）** | **企业 TLS-intercept（HTTPS MITM）与 SPKI pin 不兼容**。Gold 路径预期 **fail-closed**：路径上出现可观测的 TLS 拦截证书替换时，pin/链校验失败，**不得**建立生产会话。**禁止** 为“让连接通过”而安装代理 CA、将代理 CA 加入系统信任、或放宽/绕过 SPKI pin。运维文档与 UI 须诚实说明：需要 TLS 拦截的网络环境 **不在** Gold cross-LAN 支持路径内 |
| **代理/连接错误码（互斥桶）** | `proxy-auth-failed`（407/Basic·Bearer 凭据拒绝）；`proxy-connect-failed`（DNS/TCP/CONNECT 隧道建立失败，非凭据语义）；`proxy-unsupported-auth`（质询为 NTLM/Kerberos/Negotiate 等非 Basic/Bearer）；`proxy-pac-unsupported`（配置/环境要求 PAC/WPAD 或自动发现）；`proxy-chain-unsupported`（多跳/链式代理请求）；`relay-tls-pin-mismatch`（TLS 握手到证书阶段但 pin/链校验失败，通用桶）；`proxy-tls-intercepted`（**诊断桶**：代理/企业路径下 TLS 拦截/改证导致 pin 失败；evidence 优先写本桶分诊）；`relay-connect-failed`（非代理路径连接失败）。**不得** 混成单一 `relay-proxy-failed` |
| **证书校验** | 始终执行完整 TLS 证书链校验 + 配置 pin；失败 → `relay-tls-pin-mismatch` 和/或 `proxy-tls-intercepted`（代理拦截场景）；**不得**回退“接受任意证书”、**不得**跳过 pin、**不得**安装代理 CA 绕 pin |
| **Framing 统一** | M2 **mock** 与 M5 **operator-managed-test / user-managed** relay **使用同一 framing 抽象**（WSS message 边界 + 同一 opaque blob 帧头）；mock 仅将底层 socket 换为 loopback，不得发明第二套帧格式；**mock/localhost 不得用于 M5** |
| **连接失败** | DNS/TCP/TLS/WSS 任一阶段失败 → fail-closed；审计仅脱敏错误码桶；**禁止**降级到未认证通道 |
| **验收** | A2 报告必须包含 `proxyResult` / `firewallResult`（pass/fail/not-applicable + 注册错误码桶，无 URL/IP/凭据原文）；A26 覆盖负向：PAC/WPAD、NTLM/Kerberos、代理链、MITM 均 fail-closed + 对应错误码；见 §7.2 evidence schema |

#### 4.1.6 Relay pin 轮换（F-19）

> 证书/SPKI pin **变更不得** 依赖 TOFU 静默接受。在线 fleet 经 **已认证 E2EE 控制通道** 下发签名 pin-set；离线/紧急路径见下表。

| 维度 | 冻结定义 |
| --- | --- |
| **下发通道** | 仅经 **已认证 E2EE 控制通道**（§6.7 `established` 会话）；**禁止** 经未认证 hop 或明文管理面广播信任 pin 变更 |
| **消息类型** | `relay-pin-set-update`（控制面 allowlist） |
| **必填字段** | `relayId`；`oldSpkiPins[]`；`newSpkiPins[]`；`notBefore`（UTC）；`graceUntil`（UTC）；`updateId`（全局唯一）；`trustEpoch`（§6.7.8.1 控制器全局单调信任世代）；**控制器 Ed25519 签名**（对 canonical tbs 覆盖全部上述字段） |
| **端点处理顺序** | （1）校验签名与 `trustEpoch`（拒绝 `trustEpoch ≤ lastAcceptedTrustEpoch` 的回退/重放）；（2）校验 `notBefore` 窗与字段 schema；（3）**先持久化** 新 pin-set（含双 pin overlap 状态）与新 `lastAcceptedTrustEpoch`；（4）持久化成功后发 `relay-pin-set-ack(updateId)`；（5）**禁止** 未持久化先 ack |
| **双 pin overlap** | `[notBefore, graceUntil]` 内 **old 与 new 同时有效**；TLS 校验通过任一匹配 pin 即可；`graceUntil` 之后 **删除** old pin，仅保留 new |
| **失败语义** | 签名/epoch/schema/持久化任一失败 → **保持旧 pin**；返回失败 ack 或静默拒绝更新；管理面/审计 **告警**；**不允许** 跳过 pin 校验“先连上再说” |
| **紧急泄露（revoke old immediately）** | 管理员可将 `graceUntil = notBefore`（或专用 `revokeOldImmediately=true`）使 old **立即失效**；在线端点收到后立即删 old；**仅 new** 有效 |
| **离线端点** | 未收到 pin-set 更新且 old pin 已在服务端吊销时：TLS pin 校验 **fail-closed**（`relay-tls-pin-mismatch`）；恢复路径 = **带外** 重新注入 pin / replace-device / re-enroll（§4.5），**不得** 自动 TOFU 新证书 |
| **审计事件（脱敏）** | `relay-pin-set-issued`、`relay-pin-set-acked`、`relay-pin-set-apply-failed`、`relay-pin-grace-expired`、`relay-pin-old-revoked-immediate`、`relay-tls-pin-mismatch`（无 SPKI 全文；可用短 digest 前缀桶） |
| **验收** | A21 pin 正常轮换 + overlap；A22 更新失败保持旧 pin；A23 紧急吊销 old + 离线 fail-closed（§7.1） |

### 4.2 必须具备的能力清单

| 能力 | 产品要求 |
| --- | --- |
| **设备身份绑定** | 延续 G0a：enrollment → 长期身份材料 digest 绑定唯一 `deviceId` + `enrollmentEpoch`；跨 LAN 会话不得用 IP/自报 hostname/硬件指纹扩大作用域（见 §4.5） |
| **双向认证** | 端点验证控制器（或会话对端）身份；控制器验证设备身份；relay **不**替代双向认证；握手含 transcript binding + key confirmation（§6.7） |
| **端到端加密** | 控制面与数据面载荷对 relay 与路径上的观察者不可读；**hop mTLS/TLS-to-relay 不足以为 E2E**；独立 E2EE session layer 强制（§6.7） |
| **重放防护** | **主防线** = 会话 nonce / 单调 sequence + 持久化防回退（§6.8）；**辅防线** = 有界时钟窗（§6.9）；重放必须 fail-closed |
| **断线重连** | 控制会话可恢复；数据面 session 从 checkpoint resume（§6.10：幂等 ACK、每 transfer 默认自动 5 次/可配 3–10/hard ceiling 10、最终 E2E digest）；重连用指数退避+抖动（§4.4） |
| **离线队列** | **控制消息队列与大数据备份队列物理/逻辑分离**；各自有界；满则按优先级背压/丢弃并审计（§4.4） |
| **限流** | 每设备速率/突发、连接上限、handshake 洪泛防护；设计默认值见 §4.4 |
| **审计** | 跨 LAN 连接建立、失败、轮换、撤销、降级尝试、计数器回退、克隆并发均写脱敏审计；不写 token/密钥/路径原文 |
| **密钥轮换** | 设备 token、会话密钥、enrollment epoch、（若有）relay capability token 可轮换；旧材料立即失效 |
| **Controller Noise static 轮换** | 与 Ed25519 identity 泄露路径分离；Case A 在线签名 `controller-noise-key-update`；Case B 全 fleet re-enroll；统一 `trustEpoch`（§6.7.8） |
| **Relay pin 轮换** | 经 E2EE 签名 pin-set 更新（含 `trustEpoch`）；双 pin grace；失败保旧 pin；紧急吊销；离线 fail-closed（§4.1.6） |
| **会话 keepalive** | 仅 `negotiatedKeepaliveInterval`（默认 30s、可配 5–120s）；**Noise AEAD 应用层** ping/pong；超过 `3 ×` 无应用层确认即断连 + 指数退避；WS ping 不刷新安全 timer（§6.12） |
| **撤销传播** | 活跃会话即时关闭；**L2 控制器权威** epoch/revocation 拒绝（即使 L1 denylist 延迟）；relay denylist 仅减资源滥用；离线设备下次连接先 L2 校验；P0 通道不依赖普通离线队列（§4.6） |
| **中继不持有备份内容/密钥** | relay 仅见密文 blob + 最小路由元数据；无 snapshot 明文、无 Keychain 材料、无长期设备私钥、无会话密钥、无可离线解密材料 |
| **设备克隆/重装闭合** | concurrent session detection、显式 replace-device、旧身份撤销、re-enroll 新 epoch（§4.5） |

### 4.3 用户可见语义（诚实）

- UI/CLI 必须区分：`lan-direct` / `cross-lan-relay` / `offline` / `degraded`。
- `degraded` **不得** 表示“明文可用”；最多表示带宽/延迟降级或仅控制面可达。
- 跨局域网成功 **不得** 自动宣称 NAS 远端备份 ready 或 Gold ready。
- 连接模式展示必须诚实：`via-operator-managed-relay` 不得写作“云中继 SaaS 已托管”。

### 4.4 容量与背压硬上限（F-06，设计级冻结）

实现必须采用下列 **默认硬上限**（可通过管理面配置下调，**不得上调超过 hard ceiling** 除非修订本 spec）：

| 资源 | 默认值 | Hard ceiling | 行为 |
| --- | --- | --- | --- |
| **控制面离线队列：消息数** | 256 条 / device | 1024 | 满：丢弃最低优先级；写审计 `control-queue-overflow`；背压对端 |
| **控制面离线队列：总字节** | 1 MiB / device | 4 MiB | 同上；单条控制消息硬上限 **64 KiB** |
| **数据面离线/待传队列：消息数** | 不缓存完整大文件块于控制队列；数据面独立 upload session | — | **禁止**把 backup chunk 写入控制队列 |
| **数据面 inflight 字节** | 64 MiB / device | 256 MiB | 超限：暂停新 chunk；保留 resume 检查点 |
| **优先级** | `P0 revoke/security` > `P1 session-control` > `P2 status` > `P3 bulk-data-signal` | — | 溢出时自低向高丢弃；**P0 永不与 bulk 混队** |
| **每设备消息速率** | 30 msg/s 持续 | 60 msg/s | 令牌桶；超限 `device-rate-limited` |
| **每设备突发** | 60 msg burst | 120 | 桶容量 |
| **每设备并发会话** | 2（1 active + 1 draining） | 4 | 超额拒绝 `device-session-limit` |
| **每设备并发连接（含 handshake）** | 4 | 8 | 含半开；防洪泛 |
| **全局 relay 入站连接（单控制器视角）** | 512 | 2048 | 超限拒绝新 handshake |
| **重连退避** | 初始 1s，指数 ×2，上限 60s，**满抖动 ±20%** | — | 连续失败计入审计；不 busy-loop |
| **控制面 keepalive 间隔** | 默认 **30s** = `negotiatedKeepaliveInterval`（§6.12） | 可配 **5–120s**；越界拒绝加载并回落 30s | 超过 **`3 × negotiatedKeepaliveInterval`** 无 **应用层** pong/已认证 AEAD 流量确认 → 断连；**WS ping 不计** |
| **Enrollment/handshake 源限流** | 10 次/分钟 / 源指纹（连接元组摘要，非硬件 ID） | 30 | 超限 `enrollment-rate-limited` |

**队列分离硬规则：**

1. **控制消息队列** 与 **大备份数据面** 不得共用同一离线队列结构或同一持久化文件。
2. 撤销/轮换/会话关闭等 P0 控制事件走 **高优先级控制通道**（内存优先 + 专用持久化 ring，容量独立，默认 64 条），不得排在 bulk backup 之后。
3. 队列持久化文件权限 `0600`、属主为服务账户；**0600 仅表示访问控制，不等于 Keychain 级密钥保险箱**（密钥材料仍只进 Keychain / 平台安全存储，见 §6.8）。

### 4.5 设备克隆 / 重装 / 身份生命周期（F-07）

| 场景 | 要求的行为 |
| --- | --- |
| **设备克隆**（磁盘镜像/Time Machine 整机恢复导致相同长期身份材料出现在两台主机） | 控制器检测到 **同 `deviceId` 并发会话**（不同 session 证明或不同连接证明冲突）→ 拒绝后到者或进入 `device-clone-suspected` fail-closed；审计；**不**静默双活 |
| **Keychain/备份迁移** | 长期身份私钥优先 **不可导出** + 平台 ACL（macOS Keychain `this-device` / 访问控制列表，能力允许时）；若迁移导致密钥在新机可用，仍须走 **显式 replace-device 或 re-enroll**，不得自动继承跨机信任 |
| **同 deviceId 并发** | 默认策略：**单 active session**；第二路必须出示 supersede 令牌或被拒；检测窗口内双活 = 安全事件 |
| **重装 re-enrollment** | 干净重装后旧 Keychain 材料不可用 → 必须新 enrollment；分配 **新 `enrollmentEpoch`**；旧 epoch 全部会话/ticket 失效 |
| **旧身份撤销** | 管理员 revoke 或 replace-device 成功后：旧 device token digest、旧 epoch、旧 session tickets **全部**进入吊销集（§4.6） |
| **硬件指纹** | **禁止**作为主信任根或稳定 deviceId 来源（不稳定且隐私敏感）。至多作 **可选、非关键** 的异常信号，不得单独阻断合法 re-enroll |

**Replace-device 显式流程（最小）：**

1. 管理面发起 `replace-device(deviceId)`（需 write/full 角色）。
2. 控制器吊销当前 epoch，生成新 enrollment code（**128-bit**，TTL 10 分钟，单次，新 `codeId`；§6.3）。
3. 新机完成 enrollment → 新 epoch + 新 token digest + 新 Noise static 绑定。
4. 旧机任意重连：先查吊销/epoch → 拒绝并提示 re-enroll。
5. 审计：`device-replaced` / `device-revoked` / `enrollment-epoch-bump`（脱敏）。

### 4.6 撤销传播（F-08 + F-11 两层权威）

> **硬规则：** 不得写“relay 尚未收到 denylist 也必须 reject tunnel”——在同步窗口内该陈述逻辑上不可保证。安全闭合依赖 **控制器权威层**，不依赖 relay 的同步完备性。

#### 4.6.1 两层职责分离

| 层 | 权威性 | 职责 | 失败语义 |
| --- | --- | --- | --- |
| **L1 Relay denylist** | **非权威**；仅减少资源滥用 / 带宽消耗 | 持有短期 denylist：`tunnelId` / `deviceRoutingHandle` + `epoch` 或 `revokeGeneration` 整数；拒绝已标记句柄的 **新** 转发隧道 | 即使 L1 在同步窗口内 **accept** 新 tunnel，也 **不得** 被解释为业务授权 |
| **L2 Controller authoritative state** | **唯一权威** | 每次 E2EE 握手前与每条控制命令前，以本地 **epoch / revocation set** 校验；拒绝已吊销/旧 epoch 身份 | 即便 L1 放行 tunnel，**绝不能**建立 authenticated E2EE session，**绝不能**执行命令 |

#### 4.6.2 冻结行为

| 要求 | 冻结定义 |
| --- | --- |
| **活跃会话即时关闭** | 控制器本地 revoke 生效后 **≤ 1s** 内关闭本端会话并发送 E2E `session-terminate(revoked)`（若通路仍在）；对端收到后立即清会话密钥 |
| **L2 握手门** | 控制器在 Noise_IK 完成前 / key confirmation 前：查 `(deviceId, enrollmentEpoch, revokeGeneration)`；不匹配 → `stale-epoch-rejected` / `device-revoked` fail-closed，**不**进入 `established` |
| **L1 同步** | Denylist 由控制器经 **已认证的 relay 控制通道**（WSS hop + pin，§4.1.5）下发；**不含**设备长期密钥或会话密钥 |
| **Denylist version / ack** | 每条 denylist 更新带单调 `denylistVersion`（**uint64**）；relay 必须回 `denylist-ack(version)`；控制器记录 last-acked；未 ack 超过 **10s** → 审计 `revoke-propagation-degraded` |
| **denylistVersion 耗尽（F-P2-DENYLIST-U64）** | `denylistVersion` **禁止 wrap**（不得从 `UINT64_MAX` 回到 0）。在即将或已经无法安全分配下一单调值（达到 **`UINT64_MAX`** 前的最后安全边界，实现以注入边界测试为准）时 → **fail-closed** `controller-state-untrusted`：停止以当前权威状态服务 fleet；触发 **控制器信任状态迁移** + **全 fleet replace/re-enroll**（对齐 §6.11）。边界测试 **必须** 用注入近上限值，不得依赖真实跑满 |
| **同步失败 fail-safe** | 允许且仅允许两类安全闭合：（1）relay 在本地策略下拒绝 **新** tunnel；或（2）relay 暂时 accept tunnel 但 **控制器 L2 保持 authoritative reject**。二者任一成立即安全；**禁止**为赶 SLO 跳过 L2 |
| **TTL / tombstone / GC** | denylist 条目：活跃拒绝态 → 过期后转 **tombstone**（保留 `deviceRoutingHandle` + epoch + `revokedAt`）；tombstone 至少保留 **24h**；GC 只删除超过保留期的 tombstone；**GC 不得**使被撤销旧 epoch 重新变为可转发/可接受 |
| **离线设备** | 设备下次 outbound 连接时：先建立 hop，再在 **L2 握手** 完成身份与 epoch 检查；任何旧 epoch 会话票据在数据面前 **必须**失败 |
| **材料失效范围** | 旧 session tickets、旧会话密钥、旧 device token、旧 relay capability token、旧 enrollment code **全部**失效；不得残留“宽限明文窗口” |
| **Re-enroll** | 仅新 epoch 可建立新会话；旧 epoch 不可 rekey 复活 |
| **优先级** | 撤销事件 = **P0**；经 §4.4 高优先级控制通道；**不依赖**普通离线状态队列或 bulk 队列 |
| **审计** | `device-revoked`、`session-terminated-revoked`、`revoke-denylist-updated`、`revoke-denylist-ack`、`revoke-propagation-degraded`、`stale-epoch-rejected`（无密钥/路径） |
| **传播时间 SLO（可接受）** | 在线设备：控制面通路可用时 **≤ 5s** 内 L2 关闭会话；relay denylist 尽力 **≤ 10s** 同步（L1）。离线设备：无实时要求，**下次连接首次业务消息前**必须完成 L2 校验。超过 L1 SLO 记 degraded，**安全仍由 L2 保证** |

---

## 5. 威胁模型

### 5.1 资产

| 资产 | 说明 |
| --- | --- |
| 备份内容 | snapshot 文件字节与 manifest |
| 设备长期身份 | enrollment 派生的 device token / 绑定关系 |
| 控制器 TLS 私钥 | Keychain 中的 listener 身份 |
| 会话密钥 | 跨 LAN E2E 会话材料 |
| 管理面 token | loopback 角色凭据 |
| 审计链 | 防篡改事件序列 |
| 元数据 | deviceId、会话 id、时间、大小量级（仍需最小化） |

### 5.2 攻击者与场景

| ID | 威胁 | 攻击者位置 | 预期防御 | 失败表现 |
| --- | --- | --- | --- | --- |
| T1 | **恶意中继** | 运营/攻陷 relay | 独立 E2EE session layer（§6.7）；relay 不参与密钥派生；最小元数据；无法获得明文/长期私钥/会话密钥/可离线解密材料 | 至多 DoS / 延迟 / 密文长度与时序元数据推断 |
| T2 | **被盗设备** | 物理持有端点 | 撤销 + epoch bump；Keychain ACL；活跃会话即时关闭（§4.6） | 撤销后跨 LAN 与 LAN 均拒绝 |
| T3 | **重放** | 网络观察者 | **主：** nonce/seq + 持久化防回退（§6.8）；**辅：** 时钟窗（§6.9）；单次 enrollment；rotate 后旧材料无效 | `device-replay-detected` / `device-counter-rollback` |
| T4 | **MITM** | 路径中间人 | enrollment 信任锚认证 ephemeral；证书/身份 pin；transcript binding；禁止 TOFU 静默接受变更 | pin mismatch / `handshake-identity-failed` fail-closed |
| T5 | **DNS/证书问题** | 错误解析或伪造证书 | relay/服务端 pin；运行时 **签名 pin-set 轮换**（§4.1.6）或带外 re-enroll；禁止 TOFU | 不静默换 pin；失败保持旧 pin；紧急吊销 old |
| T6 | **NAT/网络切换** | 运营商/用户移动网络 | outbound-only + **强制 relay 可验证门**（独立 NAT + `relayForced`，§4.1.3）；重连退避；不依赖稳定 inbound 映射或可观测 double-symmetric | 短暂中断后恢复或有界失败 |
| T7 | **时钟偏移** | 错误 NTP / 恶意改时 | 默认 ±120s 窗、可配置上限 ±600s（§6.9）；超窗拒绝；**时间窗不是唯一防重放** | `device-clock-skew` + 运维恢复指引 |
| T8 | **DoS** | 公网对 relay/控制器 | §4.4 限流/连接上限/队列硬顶/指数退避+抖动 | 注册背压码；不崩溃不泄密 |
| T9 | **日志泄漏** | 日志收集/支持导出 | 字段 allowlist；禁止 URL/IP 全文、token、fingerprint 全文、路径 | 仅注册错误码与布尔/计数 |
| T10 | **跨账户串线** | 逻辑缺陷 / 恶意客户端 | token→deviceId+epoch 绑定；session 键含 deviceId；禁止跨设备可见 | 越权恒拒绝 |
| T11 | **降级攻击** | 强制对方退回明文/旧协议/无 E2EE | 协议窗口 current/N-1；拒绝 null cipher / auth optional / “TLS-to-relay-only”；domain separation；审计 `protocol-downgrade-attempt` | 连接失败，不降级 |
| T12 | **数据残留** | 磁盘/中继缓存/崩溃 core | 临时文件 0600 + 清理；relay 不落盘明文或密钥；会话密钥不入普通 dataDir | cleanup 证据；无密钥残留 |
| T13 | **Crypto bootstrap 失败 / 弱握手** | 协议缺陷或实现自创算法 | §6.7 冻结成熟构件组合；双向认证+key confirmation+forward secrecy；禁止自创密码算法 | 握手失败；无半开可信会话 |
| T14 | **计数器/nonce 回退** | 崩溃、磁盘回滚、克隆 | 原子持久化 + 回退检测 fail-closed + re-enroll/epoch rollover（§6.8） | `device-counter-rollback`；拒绝会话 |
| T15 | **设备克隆 / 身份分裂** | 镜像拷贝、备份恢复到第二台机器 | 并发会话检测；不可导出密钥（能力允许时）；显式 replace-device（§4.5） | `device-clone-suspected`；拒绝双活 |
| T16 | **撤销延迟 / 旧票复活** | 网络分区或队列饥饿 | P0 撤销通道；**L2 权威拒绝**（即使 L1 denylist ≤10s 窗口未同步）；旧 ticket 全失效；SLO 见 §4.6 | 过期材料 100% 拒绝建立 E2EE/执行命令 |
| T17 | **Enrollment 短码/重放** | 猜测/重放注册码 | 128-bit 码 + HMAC digest + tombstone GC（§6.3）；无 6 位短码默认 | 统一拒绝；不复活 |
| T18 | **Enrollment HMAC secret 丢失/误 rotate** | 运维事故 | §6.3.4：已 enrollment 继续服务；`enrollment-secret-unavailable` 禁新码；显式 regenerate 升 secretVersion；**不** 无故全 fleet re-enroll | 新设备暂停 enrollment；旧设备仍可用 |
| T19 | **Proxy 凭据泄漏 / 超范围代理** | 日志/文件/错误回显；PAC/NTLM/链 | 仅显式 CONNECT+Basic/Bearer；Keychain；PAC/WPAD/NTLM/Kerberos/代理链/MITM non-goal fail-closed（§4.1.5） | 无 secret 落日志；对应错误码 |
| T19b | **企业 TLS MITM / 代理拦截** | 企业代理改证 | SPKI pin 与 TLS 拦截 **不兼容**；Gold fail-closed；禁止装代理 CA 绕 pin；诊断桶 `proxy-tls-intercepted`（§4.1.5） | 连接失败；不降级、不接受任意证书 |
| T20 | **半开僵尸会话** | NAT 静默丢包 | Keepalive 仅 `negotiatedKeepaliveInterval`；**应用层 Noise AEAD** ping/pong；超过 `3 ×` 无应用层确认断连；WS ping **不**算 liveness（§6.12） | 进入退避重连；不无限挂起 |
| T21 | **Evidence 被覆盖/过早删除/外部丢失** | 流程/磁盘清理/外部存储故障 | §7.2.2：不覆盖；36 月与下一 major Gold 12 月取较晚；外部 digest；丢失 → cell `EVIDENCE-DEGRADED`，必选门 overall 降 partial/blocked；仓库 report 体积预算 | 验证器拒绝 ready |
| T22 | **Controller Noise static 泄露（Ed25519 仍可信）** | 运维事故 / 侧信道 | §6.7.8：已认证 E2EE 下发旧 Ed25519 签名的 `controller-noise-key-update`；双 key overlap；grace 后拒旧 key | 新会话仅 new static；旧 key 过 grace 失败 |
| T23 | **Controller Ed25519 identity 泄露 / 可信状态不可证** | 密钥被盗 / 状态全损 | §6.7.8：fail-closed；**全 fleet replace/re-enroll + 新 identity/`trustEpoch`**；**禁止** 用被泄露 identity 在线自证新 key | 旧 identity 全拒；须带外 re-enroll |

### 5.3 信任边界图

```text
[User / Admin band channel] --enrollment code / pin--> [Endpoint]
[Endpoint Keychain] <identity> [Controller Keychain]
[Controller dataDir APFS] --digests only--> not secrets
[Relay] --ciphertext only--> no trust for confidentiality/integrity of payload
[NAS smbfs] --controller local mount--> never via relay as credential proxy
[Supervisor lifecycle execute] --orthogonal--> must not be opened by cross-LAN alone
```

### 5.4 与 supervisor lifecycle 的边界（强制分离）

跨局域网 **不得** 自动抬升：

- `executionEligible`
- `executeCapabilityAuthorized`
- `realRunnerWiringReady`
- host mutation / launchctl 真执行

跨局域网解决的是 **设备可达性与安全会话**；supervisor lifecycle execute/gate 仍遵循 V1.x 公式与独立证据 locus。<br>
**禁止** 把 “cross-LAN heartbeat OK” 写成 lifecycle dual-host execute locus 完成。

---

## 6. 协议与架构边界

### 6.1 Control plane vs data plane

| 平面 | 职责 | 载荷 | 中继可见性 |
| --- | --- | --- | --- |
| **Control plane** | enrollment 后会话、heartbeat、能力协商、token 轮换、撤销信号、任务意图、背压、审计摘要 | 小消息；严格 schema | 仅密文 + 路由 id |
| **Data plane** | snapshot 上传 chunk、恢复拉取、完整性复验信号 | 大流量；独立 session 状态机 | 仅密文 blob；**无** manifest 明文必填字段暴露给 relay |

原则：

1. 控制面先双向认证并建立 E2E 会话密钥，再允许数据面。
2. 数据面 session 身份：`(deviceId, snapshotId, manifestDigest, uploadId)` 继承 Gold 单机设计；跨 LAN 不改变身份语义。
3. NAS 复制仍在**控制器本机**对预挂载 `smbfs` 执行（V1.24/G1 边界）；**relay 不成为 NAS 代理**。

### 6.2 Relay 元数据最小化

Relay **允许** 见到的字段（V2.0 冻结 allowlist；实现 schema 不得超集扩张除非修订 spec）：

- opaque `tunnelId` / 连接 id / `deviceRoutingHandle`（无业务含义的随机句柄）
- 加密后的 blob 长度与传输序号
- 有界 keepalive
- 可选：控制器下发的 **revoke-generation / epoch 整数** denylist 条目（§4.6；非密钥）

Relay **禁止** 见到：

- 设备 token、enrollment code、管理 token
- 长期身份私钥、会话主密钥、traffic keys、可离线解密材料
- snapshot 路径、文件名明文列表（若控制面必须传，须在 E2E 内）
- 用户身份、hostname、局域网 IP 明文（日志同样禁止）
- 握手 transcript 的明文业务字段（仅可转发已加密或已规定为公开的 ephemeral 材料字节）

### 6.3 Device enrollment（跨 LAN 扩展；F-13 熵 / F-17 tombstone）

#### 6.3.1 注册码熵与表示（Gold 默认）

| 维度 | 冻结定义 |
| --- | --- |
| **熵** | 注册码明文 = 密码学安全 **128-bit 随机**（`CSPRNG`，16 字节） |
| **表示** | **base64url**（无填充）字符串；可选 **QR**（§6.3.1.1）。**禁止** 6 位数字短码或其它低熵短码作为 **Gold 默认** enrollment 路径 |
| **TTL** | **10 分钟**（自签发 `issuedAt` 起） |
| **消费** | **单次**：验证成功后立即 `consumed=true` 并转 tombstone 流程（§6.3.3） |
| **限流** | 每 **源指纹**（连接元组摘要）与每 **deviceId 尝试** 默认 10 次/分钟（ceiling 30，对齐 §4.4）；超限 `enrollment-rate-limited` |

#### 6.3.1.1 注册码交付与显示（F-P2-ENROLL-DELIVERY）

| 维度 | 冻结定义 |
| --- | --- |
| **明文显示唯一通道** | 注册码 **明文** 仅允许在 **loopback 管理 UI** 或 **本机 CLI** **一次性** 显示（签发响应内展示）。**禁止** 写入 dataDir、日志、审计链、crash report、evidence、远程管理面或非 loopback 接口 |
| **持久化** | 控制器侧 **仅** 存 digest 字段（§6.3.2）；**永不** 持久化注册码明文 |
| **剪贴板** | **默认不** 自动复制到系统剪贴板。用户 **主动** 触发“复制”时，UI/CLI **必须** 显示风险提示（剪贴板可被其它本机进程读取；复制后尽快完成 enrollment 并清理剪贴板为建议，非强制密钥擦除承诺） |
| **QR payload schema** | 固定 schema 版本字段 **`enrollmentQr/v1`**（实现不得静默漂移版本名）。Payload **仅** 含：`codeId`、`code`（明文 base64url）、`expiry`、**controller 公共元数据**（Ed25519 身份公钥 digest / 展示用 pin 材料）、**relay 公共元数据**（`relayEndpoints[]` 主机名桶或非密钥端点描述 + pin digest 桶）。**禁止** 含：`enrollment-hmac-secret`、任何 **private key**、device token、Proxy-Authorization secret、会话密钥 |
| **QR 纠错级别** | 具体 ECC level（L/M/Q/H）**留给实现**选择与测试；**不得** 因此改变 `enrollmentQr/v1` 字段集或语义 |
| **测试** | 负向：签发后扫描 dataDir/日志/审计 fixture **无** 明文 code；默认路径 **无** clipboard write；主动复制路径有风险提示钩子；QR 解码无 secret/private key 字段（A25 扩展） |

#### 6.3.2 控制器侧存储（仅 digest）

控制器 **永不** 持久化注册码明文。仅存：

| 字段 | 说明 |
| --- | --- |
| `codeId` | 新签发必新 UUID/随机 id（与明文独立） |
| `digest` | `HMAC-SHA256(serverSecret, salt \|\| codePlaintext)` |
| `salt` | 每码独立 ≥16B 随机 salt |
| `version` | digest 方案版本（当前 = 1） |
| `secretVersion` | 签发时绑定的 enrollment-hmac-secret 世代（§6.3.4） |
| `expiry` | 绝对过期时刻 |
| `consumed` | 布尔 |
| `tombstone` | 布尔；见 §6.3.3 |
| `issuedAt` / `consumedAt` | 审计用 UTC |

| 维度 | 冻结定义 |
| --- | --- |
| **server secret** | Keychain 内 **独立 32 字节** `enrollment-hmac-secret`；与设备 token、TLS 私钥、proxy 凭据分项；**默认不导出**（见 §6.3.4） |
| **secretVersion** | 与当前 HMAC secret 绑定的单调整数（从 1 起）；digest 记录与签发路径均绑定 `secretVersion` |
| **比较** | 验证时重算 HMAC，**constant-time compare**；禁止字符串 `===` 短路 |
| **带外材料** | 控制器身份 pin（Ed25519 公钥 digest + Noise static 公钥材料，§6.7.3）+ enrollment code 明文（仅带外一次）+（跨 LAN）`relayEndpoints[]` 与 relay pin（§4.1.4–4.1.6） |
| **绑定结果** | `(deviceId, enrollmentEpoch, ed25519IdentityPublicKey, noiseStaticPublicKey, digests)`（§6.7.3） |

#### 6.3.3 Tombstone 与 GC（F-17）

| 状态转换 | 规则 |
| --- | --- |
| **active** | 未过期且未消费；可被正确明文验证一次 |
| **→ tombstone** | 过期 **或** 已消费：`tombstone=true`，**清除 digest 可用验证路径**（保留 `codeId`、时间戳、结果码供审计）；**永不再次变为 valid/active** |
| **tombstone 保留** | 至少 **24 小时**（固定下限；可配置加长，不得短于 24h）用于 replay/审计查询 |
| **GC** | 仅删除超过保留期的 tombstone 行；GC 后对该 `codeId`/旧明文的任何出示 → **统一拒绝**（`enrollment-code-unknown-or-expired`），**不得** 解释为“未注册空位”而重新接受同一码 |
| **新码** | 每次签发 **必须** 新 `codeId` + 新 128-bit 随机明文 + 新 salt；禁止复用旧 `codeId` 或旧明文 |

#### 6.3.4 Enrollment HMAC secret：首次启动自动 CSPRNG 32B → Keychain 独立 item；禁止手输 / 日志 / 明文传输（F-18 / F-ENROLL-BOOT）

> **Bootstrap 主文硬规则（必须可见）：** 控制器 **首次启动** 时 **自动** 用 **CSPRNG** 生成 **32 字节** `enrollment-hmac-secret`，写入 Keychain **独立 item**（与设备 token / TLS 私钥 / proxy 凭据分项）。**禁止** 管理员手输或粘贴该 secret 作为 bootstrap；**禁止** 日志、审计、CLI 回显、crash report、evidence 输出 secret；**禁止** 明文传输或把该 secret 作为可复制配置字段下发。<br>
> **范围边界：** `enrollment-hmac-secret` **只** 用于注册码 digest（§6.3.2）。**不** 用于既有设备身份认证、**不** 用于 E2EE 会话密钥、**不** 用于 device token 校验。因此 secret 丢失 **不得** 无理由要求全 fleet re-enroll。

| 场景 | 冻结行为 |
| --- | --- |
| **首次启动 bootstrap** | **自动** CSPRNG **32B** → Keychain **独立 item**；初始化 `secretVersion = 1`。**禁止** 手输/粘贴 bootstrap；**禁止** 日志/审计/CLI/明文传输/可逆导出（见上主文硬规则） |
| **正常运行** | 签发/验证 enrollment code 使用当前 secret + `secretVersion`；既有已 enrollment 设备会话走 Ed25519/Noise/device token 路径，**不读** 该 secret |
| **secret 丢失 / Keychain item 不可读** | （1）既有已 enrollment fleet **继续** 认证与 E2EE 服务（不受影响）；（2）控制器 **立即** 进入 `enrollment-secret-unavailable`：禁止签发新 code、禁止验证新 code；（3）管理面告警；审计 `enrollment-secret-unavailable`（无 secret 内容） |
| **显式 rotate / regenerate** | 仅管理员显式操作：CSPRNG 生成新 32B secret → 写入 Keychain 新/覆盖 item → **`secretVersion` 单调 +1** → 所有 **未消费** 旧 code 与 **旧 secretVersion 的 tombstone namespace** 一律作废（统一拒绝，等同 unknown/expired）→ 仅新 secretVersion 可签发新 code。**不得** 因 rotate 本身强制全 fleet re-enroll |
| **备份策略（默认）** | 产品 **默认不导出** enrollment-hmac-secret。是否可备份取决于平台 Keychain / export policy 与管理员显式授权；若平台允许受控导出，备份 **必须加密**（密钥分置），**禁止** 明文 secret 落盘为唯一副本 |
| **恢复流程** | （A）若存在 **可信加密备份** 且校验通过：恢复 secret + 对齐 `secretVersion` 后退出 `enrollment-secret-unavailable`，可继续签发（未消费旧 code 仍按 TTL/tombstone 规则）。（B）若 **无可信备份**：走 **显式 regenerate**（上表）；旧未消费 code 全废；已 enrollment 设备 **保持**；仅新设备/re-enroll 需新 code |
| **与 §6.11 全损区分** | 控制器 **权威设备绑定/撤销状态** 全损 → §6.11 `controller-state-untrusted` 与 fleet re-enroll。仅 enrollment-hmac-secret 丢失 **≠** 控制器状态全损，**禁止** 混用两条恢复路径 |

跨 LAN 增量：

- enrollment 可经 outbound WSS relay 完成，但 **E2E 身份仍在端点↔控制器之间**；relay 只转发密文/公开材料
- relay **不能** 签发 device token、不能认证业务身份、不能参与 KE
- 禁止“公开 proof API”可被未认证匿名刷 enrollment（见 §6.5）
- 重装/替换设备必须新 epoch（§4.5）；旧 epoch 不可复活

### 6.4 Capability token scope

| Token 类型 | 作用域 | 存储 | 不可用于 |
| --- | --- | --- | --- |
| Management full/read/write | loopback 管理面 | Keychain / 配置注入 | 设备协议、relay 管理 |
| Device token | 单 `deviceId` 设备协议 | 端点 Keychain；控制器仅 digest | 管理面、其它 deviceId |
| Relay capability token（若需要） | 仅建立 tunnel 的短时能力 | 短 TTL；可轮换 | 解密 E2E、访问 snapshot、管理 API |
| Lifecycle approval | supervisor 本机审批 | 本地 approval store | 跨 LAN 远程任意 host mutation |

**Scope 缩小原则：** 任何 token 默认最小权限；跨平面复用 = 设计缺陷。

### 6.5 No inbound / no public proof API abuse

1. 默认部署 **不** 要求端口映射。
2. 不得提供未认证的公网 “proof” / “status” / “enroll-open” API 供扫描器滥用。
3. 测试专用 harness 必须显式 env 门（对齐 G0a `LINKE_REAL_G0A_ACCEPTANCE=enabled` 模式），默认关闭。
4. 真实跨 LAN 验收报告只含脱敏字段（对齐 G0a report 红线）。

### 6.6 与 supervisor lifecycle execute/gate 边界

```text
cross-LAN session ready
  ≠ executionEligible
  ≠ executeCapabilityAuthorized
  ≠ real host mutation allowed

supervisor lifecycle
  仍要求：approval / policy / wiring / real handlers / §4.5 loci / dual-gate
  跨局域网最多提供：多主机可达性传输通道（若未来需要）
  但 V2.0 Gold 不把 remote lifecycle execute 列为 cross-LAN 必达项
```

V2.0 cross-LAN 门禁的 **最小充分集** = 安全可达 + 控制/数据面保护 + 验收矩阵；**不是** 远程 launchctl 执行平台。

### 6.7 Crypto Architecture Constraints（P0 冻结，F-01）

> 本节为 **实现前必须锁死** 的密码学架构约束。任何实现偏离须先修订本 spec，禁止 silent 降级。

#### 6.7.1 Relay 与密钥材料的绝对禁区

| 禁区 | 说明 |
| --- | --- |
| **不参与 E2E 密钥派生** | Relay **绝不**作为 KDF/KE 的参与方；不得贡献、混合或保管用于端到端会话密钥的秘密 |
| **不得获得长期身份私钥** | 设备与控制器的长期身份私钥只存在于各自平台安全存储（Keychain 等） |
| **不得获得会话密钥** | 含 traffic keys、exporter-export 材料、可导出 session secret |
| **不得获得可离线解密材料** | 含可静态解密历史密文的主密钥、可重放派生的 seed |
| **可见范围** | 仅：密文 blob、**密文/chunk 长度**、传输序号、opaque routing handle、有界 transport 辅助帧（≠ 已认证 liveness，§6.12） |
| **残余流量分析（F-P1-SIZE-LEAK，接受）** | Relay 与路径观察者 **可以** 观察：**ciphertext / chunk 长度序列**、**时序**、**变更量近似**（长度直方图与发送节奏）。这是 **接受的残余流量分析风险**。Gold V2.0 **不承诺** 隐藏流量形状，**不得** 声称 **匿名** 或 **traffic-analysis resistant**。可选缓解见 §6.10 固定 bucket padding（M4 可选，非 Gold 必要） |

#### 6.7.2 冻结协议方向（P0 精确握手，F-09）

> **开放措辞禁止：** 本节 **不使用** “或等价 / 类似 Noise / 可选其它 KE” 等可漂移表述。V2.0 Gold 冻结 **唯一** E2EE 握手协议如下。

```text
Hop / transport（§4.1.5）:
  WSS = WebSocket over TLS 1.3 → TCP 443（双方 outbound）
  证书/SPKI pin（relay）
  角色：仅 hop 机密性/完整性与服务器认证；≠ payload E2EE
  禁止 raw TLS 自动降级；HTTP CONNECT 可选但仍承载 WSS/TLS 1.3 + pin

Enrollment trust anchor（带外一次性，§6.3）:
  128-bit 注册码（base64url/QR）+ 控制器 Ed25519 身份 pin
    + 控制器 Noise static 公钥材料 +（跨 LAN）relayEndpoints[] 与 relay pin
  端点用 trust anchor 认证后续握手中的对端静态/瞬时材料

E2EE session layer（端点 ↔ 控制器，跨 relay 强制独立层）:
  套件（唯一 current）:
    Noise Protocol Framework — pattern IK
    DH: X25519 (25519)
    AEAD: ChaCha20-Poly1305 (ChaChaPoly)
    Hash: SHA-256
    记名：Noise_IK_25519_ChaChaPoly_SHA256
  长期应用身份：Ed25519（签名/绑定；node:crypto / 平台能力）
  Noise 静态密钥：各方持有独立 X25519 static key pair（与 Ed25519 身份密钥分离）
  实现选择门（F-23，docs-only 阶段不点名具体 npm 包、不断言“已审计”）：
    M1 必须完成 bounded crypto dependency spike（§6.7.7）并产出 ADR/证据后
    才允许引入依赖或 fixture 兼容层；禁止静默自研 KE/AEAD/transcript 混合
```

##### 6.7.2.1 角色与前置知识

| 角色 | 定义 |
| --- | --- |
| **Initiator** | **Endpoint（设备）**：发起 Noise_IK 握手 |
| **Responder** | **Controller**：响应握手 |
| **前置已知 static** | Initiator 在 enrollment 后持有 **responder（控制器）Noise static public key**（带外/enrollment 绑定并签名验证）；Responder 在设备 enrollment 记录中持有 **initiator（设备）Noise static public key** |
| **身份绑定** | Ed25519 身份公钥、Noise static 公钥、`deviceId`、`enrollmentEpoch` 由 enrollment 签名材料绑定（§6.7.3）；握手时与 prologue/payload 交叉校验 |

##### 6.7.2.2 消息 token 序列（Noise_IK 标准，冻结）

严格遵循 Noise Protocol Framework **IK** pattern 的两条握手消息（无第三条 handshake 消息）：

```text
-> e, es, s, ss
<- e, ee, se
```

| 消息 | 方向 | tokens（顺序固定） | 语义 |
| --- | --- | --- | --- |
| **msg1** | Endpoint → Controller | `e, es, s, ss` | 发送 ephemeral public；DH(es)；发送 initiator static（AEAD 保护）；DH(ss) |
| **msg2** | Controller → Endpoint | `e, ee, se` | 发送 responder ephemeral；DH(ee)；DH(se)；其后 payload 可携 key-confirm 绑定字段 |

**硬规则：**

1. token 顺序 **不可重排**、**不可省略**、**不可插入非 IK 自定义 token**。
2. 实现必须能对照 **固定 test vectors**（官方 Noise 向量或仓库内 frozen fixture，绑定 suite 名与 pattern）逐字节验证 msg1/msg2 密文结构与密钥派生。
3. Relay **只转发** 已成帧的握手字节；不解析 token、不参与 DH、不改写 ciphertext。

##### 6.7.2.3 Prologue / transcript / domain labels

| 项 | 冻结值 |
| --- | --- |
| **Noise protocol_name** | `Noise_IK_25519_ChaChaPoly_SHA256`（ASCII，按 Noise 规范写入 handshake hash） |
| **prologue** | 固定字节串：`linke-v2/cross-lan/noise-ik/v1` \|\| `protocolVersion(uint16 BE)` \|\| `suiteId=1` |
| **应用 domain labels**（HKDF/export 后业务密钥再派生时） | `linke-v2/e2ee/handshake`、`linke-v2/e2ee/traffic-c2d`、`linke-v2/e2ee/traffic-d2c`、`linke-v2/e2ee/rekey`、`linke-v2/e2ee/key-confirm`、`linke-v2/data/chunk-mac`、`linke-v2/relay-cap` |
| **Transcript 绑定字段** | protocol_name、prologue、双方 Noise static/ephemeral 公钥材料、`deviceId`、`enrollmentEpoch`、`controllerId`、msg1/msg2 payloads 的 AEAD AAD 承诺 |

##### 6.7.2.4 Handshake payload 字段（allowlist）

| 消息 | payload 明文字段（经 Noise AEAD 保护后传输） |
| --- | --- |
| **msg1 payload** | `deviceId`、`enrollmentEpoch`、`ed25519IdentityPub`、`identityBindingSig`（Ed25519 对 binding-tbs 签名）、`clientNonce`（32B）、`clientTimeUtc`（用于 §6.9 skew 辅检） |
| **msg2 payload** | `controllerId`、`enrollmentEpoch` echo、`serverNonce`（32B）、`serverTimeUtc`、`keyConfirmServer`（见下）、可选 `rekeyGeneration=0` |
| **binding-tbs** | `SHA-256("linke-v2/enroll-bind/v1" \|\| deviceId \|\| epoch \|\| ed25519Pub \|\| noiseStaticPub \|\| controllerNoiseStaticPub)` |

`identityBindingSig` 验证失败、epoch 不匹配、static 与 enrollment 记录不一致 → `handshake-identity-failed`，**fail-closed**。

##### 6.7.2.5 Key confirmation

| 步骤 | 定义 |
| --- | --- |
| **导出** | 握手完成后按 Noise 规范 split 得到 `ck/k` transport keys；再 `HKDF-SHA256` 以 label `linke-v2/e2ee/key-confirm` 派生 confirm key |
| **Server confirm** | msg2 payload 内 `keyConfirmServer = MAC(confirmKey, "s" \|\| clientNonce \|\| serverNonce \|\| transcriptHash)` |
| **Client confirm** | 握手后 **首条** transport 消息必须为 `key-confirm-client`：`MAC(confirmKey, "c" \|\| serverNonce \|\| clientNonce \|\| transcriptHash)` |
| **状态机** | 仅双方 confirm 校验通过后进入 `established`；缺失/错误 → 销毁密钥，错误码 `handshake-identity-failed` 或 `e2ee-required`，**无半开业务通道**（A17） |

##### 6.7.2.6 失败与降级拒绝

| 条件 | 行为 |
| --- | --- |
| 非 `Noise_IK_25519_ChaChaPoly_SHA256` suite 提议 | 拒绝；`protocol-downgrade-attempt` |
| raw TLS / 无 WSS / 明文 WS / null cipher / auth optional | 拒绝；`protocol-downgrade-attempt` / `e2ee-required` |
| pin 失败、static 未知、binding 签名失败 | `handshake-identity-failed` |
| 时钟超窗（§6.9） | `device-clock-skew`（辅）；主防重放仍为 nonce/seq |
| 旧 epoch / 已撤销 | `stale-epoch-rejected` / `device-revoked`（L2，§4.6） |
| 任意上述失败 | **fail-closed**；禁止回退到“仅 hop TLS 可信”或未认证通道 |

**禁止：**

- 自创密码算法、自创 KE、自创“异或混淆”、用哈希当 MAC 无标准构造
- “或等价 KE 模式”开放实现
- 将 relay 的 TLS 会话密钥导出当作 E2EE
- 无认证 Diffie-Hellman（匿名 KE）生产路径
- TOFU 静默接受控制器身份或 Noise static 变更

#### 6.7.3 Enrollment 如何绑定身份 / Noise static / epoch

1. 带外 enrollment code：控制器只存 **HMAC-SHA256 digest**（§6.3）；端点持 128-bit 明文一次使用。
2. Enrollment 完成时端点生成并出示：
   - **Ed25519** 长期身份密钥对（公钥）
   - **Noise X25519 static** 密钥对（公钥）
3. 控制器验证 code（constant-time HMAC）后写入绑定：
   - `(deviceId, enrollmentEpoch, ed25519IdentityPublicKey, noiseStaticPublicKey, digests)`
   - 控制器将其 **自身** Noise static public + Ed25519 身份 pin 回传端点（E2E 保护或带外已含）
4. 端点用控制器 Ed25519 身份验证 enrollment 响应中的 **控制器 Noise static** 绑定签名；固定后：
   - **仅 Noise X25519 static 轮换**（Ed25519 identity **未**泄露且可信）：走 §6.7.8 在线 `controller-noise-key-update`（**禁止** TOFU 静默接受）。
   - **Ed25519 identity 变更/泄露/可信状态不可证**：fail-closed，**全 fleet replace/re-enroll**（§6.7.8 Case B）；**禁止** 用旧/泄露 identity 在线自证新 key。
5. 后续每次会话：执行 §6.7.2 Noise_IK；`identityBindingSig` + enrollment 记录交叉验证 static 与 epoch；握手时控制器 Noise static 须落在端点已接受的 **active Noise static 集合**（含 grace 双 key overlap，§6.7.8）。
6. Relay **只转发**握手密文与公开 ephemeral/static **密文传输字节**；**不**验证业务身份，**不**改写 transcript。

#### 6.7.4 强制安全性质

| 性质 | 要求 |
| --- | --- |
| **双向身份认证** | Initiator 认证 responder static（IK 先验 + enrollment 绑定）；Responder 认证 initiator static（msg1 `s,ss` + enrollment 记录 + Ed25519 binding） |
| **Transcript binding** | 所有 transport/rekey 密钥绑定完整 Noise transcript + prologue + deviceId/epoch |
| **Forward secrecy** | 每次会话新 ephemeral（`e`）；泄露长期 static/Ed25519 不得解密 **过去** 已销毁 ephemeral 的会话 |
| **Key confirmation** | §6.7.2.5；未 confirm 不得 `established` |
| **Downgrade prevention** | 唯一 suite current；协议版本 current 与 N-1 仅限应用层帧，**不得**改 Noise pattern/DH/AEAD/Hash；拒绝 null cipher / 仅 hop TLS |
| **Domain separation** | §6.7.2.3 labels；禁止跨上下文复用密钥 |

#### 6.7.5 mTLS / hop TLS 与 payload E2EE 的边界

| 层 | 保护对象 | 不得宣称 |
| --- | --- | --- |
| **Relay hop WSS/TLS 1.3** | 客户端↔relay 或 controller↔relay 的传输 | payload E2EE、端到端身份、防恶意 relay 读载荷 |
| **Direct same-LAN TLS**（G0a） | 端点↔控制器 listener | 自动满足 cross-LAN；跨 NAT 时不可假设可达 |
| **E2EE session layer（Noise_IK）** | 端点↔控制器应用载荷（控制面+数据面） | 可被 hop TLS 替代 |

**硬规则：** 两端各自对 relay 终止 TLS 时，**必须**使用 **独立 Noise_IK E2EE session layer**；文档与 scorecard **禁止** 把 “已对 relay 建立 WSS/TLS” 写成 cross-LAN E2EE ready。

#### 6.7.6 向里程碑与测试的传导

| 里程碑 | 必须覆盖的 crypto 出口 |
| --- | --- |
| **M1** | **先** §6.7.7 Noise library selection gate（ADR 通过或 M1 BLOCKED）；冻结 suite 名与 token 序列常量；消息 schema 含 msg1/msg2/key-confirm；错误码：`handshake-identity-failed`、`protocol-downgrade-attempt`、`e2ee-required`；状态机仅 key confirm 后 `established`；**fixed vectors**：已知 prologue/keys → 期望 handshake hash / msg 密文前缀；拒绝 null/降级/乱序 token |
| **M2** | Mock relay 仅按 §4.1.5 同 framing 转发；断言日志无密钥；dry-run 跑通 **完整 msg1→msg2→client-confirm 顺序**；对照 frozen fixture；仍 **非** real cross-LAN |
| **M3** | 真实 E2EE：IK 双向认证、transcript 绑定、FS、confirm、domain separation、rekey；**controller-noise-key-update / trustEpoch**（§6.7.8）；负向：恶意 relay fixture 无法读载荷；Case B 无泄露 identity 自证路径 |
| **验收** | A7 重放；A14 恶意 relay；A16 降级拒绝；A17 key confirm 缺失拒绝；A27–A29 Noise static lifecycle（§7.1） |

#### 6.7.7 Noise library selection gate（F-23，M1 hard gate）

> **Docs-only 纪律：** 本阶段 **不** 编造具体 npm 包名，**不** 宣称任何实现“已审计/已选型通过”。协议 suite 冻结（§6.7.2）与 **库实现选型** 分离：前者 M0 冻结；后者在 **M1 联网可核验** 的 bounded spike 中完成。

| 维度 | 冻结定义 |
| --- | --- |
| **时机** | M1 **入口 hard gate**：在合并任何生产依赖或声称“Noise 实现就绪”之前必须完成 |
| **候选数量** | 评估 **2–3 个当前公开候选**（实现阶段由 spike 记录具体坐标；本文不预写包名） |
| **核验维度（每候选必填）** | （1）维护状态（近期提交/issue 响应/是否 abandoned）；（2）许可证与 Gold 兼容性；（3）**Node.js ESM** + **macOS** 可构建/可运行；（4）是否支持 **IK** + **X25519** + **ChaChaPoly** + **SHA256** + **prologue** + 可对齐 **fixed vectors**；（5）已知审计/安全公告/CVE 历史（如实记录“无公开审计”亦为有效结论）；（6）供应链风险（维护者集中度、install 脚本、传递依赖面） |
| **产出** | ADR（`docs/superpowers/` 实现阶段路径，M1 commit）+ 证据表：候选对照矩阵、选择/拒绝理由、vector 对齐结果摘要、许可证结论 |
| **通过** | ≥1 候选满足全部硬需求且供应链风险可接受 → 允许引入该依赖（须单独依赖变更控制）。**fixed-fixture compatibility implementation** 若作为实现路径：**仍须** 完整安全审查 + **显式 spec 变更控制** 后才可合入；**禁止** 作为 T1.0 失败后的静默捷径（见下行 contingency） |
| **失败 / 无候选通过** | **M1 = BLOCKED**；**禁止** 静默自研 Noise/KE/AEAD；**禁止** 降级协议 suite 或改用未冻结 pattern；**禁止** 未经审查的 fixed-fixture 兼容层顶替 gate |
| **BLOCKED 后 7 日裁决（F-P2-M1-CONTINGENCY）** | T1.0 正式 **BLOCKED** 后 **7 个自然日内**，由 **PM + 用户** 书面裁决 ADR，三选一（可并列记录否决项）：（1）**替代合规库**（重新评估候选并通过同一核验矩阵）；（2）**修订协议**（先修订本 spec 变更控制，再重开 M1）；（3）**暂停 V2.0** cross-LAN/Gold 推进直至条件满足。逾期未裁决 → M1 保持 BLOCKED，**不得** 默认选用任何捷径 |
| **与 P0-9 关系** | 本 gate 是 P0-9 的实现前置；gate 未过不得进入 M2 生产握手路径 |

#### 6.7.8 Controller Noise static 生命周期与 `trustEpoch`（F-ROT-CTRL + F-CTRL-EPOCH）

> **必须区分两类泄露/轮换。** Noise X25519 static 与控制器 Ed25519 long-term identity **是分离密钥**；处理路径 **不得** 混用。

##### 6.7.8.1 `trustEpoch`（控制器全局信任世代）

| 维度 | 冻结定义 |
| --- | --- |
| **名称** | **`trustEpoch`**（**禁止** 再使用仅 pin-set 专用的 `controllerEpoch` 字段名；全文档/schema/错误语义统一为 `trustEpoch`） |
| **类型** | 控制器 **全局** 单调递增 **uint64**（非 per-device） |
| **初始值** | 控制器首次可信 bootstrap 后从 **1** 起（或从恢复校验通过的备份中恢复已有值；**禁止** 回退） |
| **递增时机（关键信任更新）** | 至少包括：`relay-pin-set-update`、`controller-noise-key-update`、控制器 Ed25519 identity 重签发/fleet re-enroll 世代切换、以及其它会改变端点“应信任材料集合”的管理面权威更新。每次此类下发 **必须** 使用 **严格大于** 控制器当前已发布最大值的新 `trustEpoch` |
| **端点持久化** | 每端点持久化 `lastAcceptedTrustEpoch`（与 enrollment 绑定材料同级 durability）；更新 **先持久化再 ack**（与 pin-set / noise-key-update 相同顺序） |
| **拒绝语义** | 端点对任何携带 `trustEpoch` 的信任更新消息：若 `trustEpoch ≤ lastAcceptedTrustEpoch` → **拒绝**（重放或回退），错误码 `stale-epoch-rejected`；**不** 应用消息内容。语义与 §6.8 counter rollback 对齐：**已接受的世代不可回退、不可复用** |
| **与 `enrollmentEpoch` 关系** | `enrollmentEpoch` = **per-device** 设备注册/替换世代（§4.5 / §6.7.3）。`trustEpoch` = **controller-global** 信任材料世代。二者 **正交**：**不得** 用 `enrollmentEpoch` 代替 `trustEpoch` 做 pin/noise 更新防回退；**不得** 因 `trustEpoch` 递增强制全 fleet re-enroll（re-enroll 仅 Case B / §6.11 等明确路径） |
| **与 `revokeGeneration` 关系** | `revokeGeneration` 服务设备撤销权威（§4.6 L2）；`trustEpoch` 服务控制器信任材料更新。可并存于同一控制器状态备份（§6.11），但字段语义不合并 |

##### 6.7.8.2 Case A — 仅 Controller Noise X25519 static 泄露/轮换（Ed25519 identity **未**泄露且可信）

| 维度 | 冻结定义 |
| --- | --- |
| **前置** | 控制器 Ed25519 long-term identity 仍由端点 enrollment 信任锚持有且 **未被** 判定泄露；存在 **已认证 E2EE** 控制会话（§6.7 `established`）或可建立此类会话 |
| **消息类型** | `controller-noise-key-update`（控制面 allowlist） |
| **下发通道** | **仅** 经已认证 E2EE 控制通道；**禁止** 经未认证 hop、明文管理面广播或 TOFU 静默接受新 static |
| **必填字段** | `oldNoiseStaticPub`；`newNoiseStaticPub`；`notBefore`（UTC）；`graceUntil`（UTC）；`trustEpoch`；`updateId`（全局唯一）；**控制器 Ed25519 签名**（对 canonical tbs 覆盖上述全部字段，签名密钥 = **当前未泄露的** 旧/现 Ed25519 identity） |
| **端点处理顺序** | （1）用已 pin 的控制器 Ed25519 公钥验签；（2）校验 `trustEpoch`（`>` `lastAcceptedTrustEpoch`）与 schema/`notBefore`；（3）校验 `oldNoiseStaticPub` 属于端点当前 active 集合；（4）**先持久化** 双 key overlap 状态 + 新 `lastAcceptedTrustEpoch` + `updateId` 去重；（5）持久化成功后发 `controller-noise-key-ack(updateId)`；（6）**禁止** 未持久化先 ack |
| **双 key overlap** | `[notBefore, graceUntil]` 内 **old 与 new Noise static 同时可接受** 用于握手先验；`graceUntil` 之后 **删除/拒绝** old static，仅 new 有效；用 old static 发起/完成握手 → `handshake-identity-failed` fail-closed |
| **紧急吊销 old** | 管理员可设 `graceUntil = notBefore`（或 `revokeOldImmediately=true`）使 old **立即**失效 |
| **失败语义** | 签名/epoch/schema/持久化失败 → **保持旧 static 集合**；告警；**不允许** 跳过验签“先连上” |
| **审计（脱敏）** | `controller-noise-key-issued`、`controller-noise-key-acked`、`controller-noise-key-apply-failed`、`controller-noise-key-grace-expired`、`controller-noise-key-old-revoked-immediate`（无私钥；公钥仅短 digest 前缀桶） |
| **验收** | A27 正常轮换+overlap；A28 失败保旧；A29 Ed25519 泄露路径 fail-closed 不自证（§7.1） |

##### 6.7.8.3 Case B — Controller Ed25519 identity 泄露，或可信状态无法证明

| 维度 | 冻结定义 |
| --- | --- |
| **触发** | Ed25519 identity 私钥泄露/疑似泄露；或控制器权威绑定/审计链/状态 **无法** 证明仍可信（含与 §6.11 全损重叠场景） |
| **行为** | **fail-closed**：停止以旧 identity 向 fleet 提供可信信任更新；管理面进入需运维处置状态（可与 `controller-state-untrusted` 对齐或并列告警） |
| **恢复** | **全 fleet replace-device / re-enroll** + 签发 **新** Ed25519 identity + **新** Noise static + 新 `trustEpoch` 世代（从干净 bootstrap/恢复管线建立）；旧 identity、旧 static、旧 enrollment 绑定全部吊销 |
| **硬禁止** | **不得** 使用 **被泄露** 的 Ed25519 identity 在已有会话上“在线自证”新 identity 或新 Noise static；**不得** 把 Case A 消息当作 identity 轮换通道 |
| **与 Case A 边界** | 仅当运维 **能证明** Ed25519 identity **未**泄露且端点侧 pin 仍可信时，才允许 Case A；存在合理怀疑 → 按 Case B |

### 6.8 Counter / Nonce 持久化与防回退（F-02 + F-15 reservation）

> **目标：** 同时满足性能（避免每消息 `fsync`）与安全（崩溃后 **永不复用** 已发出或可能已发出的 counter）。**禁止** 使用 “观测 gap>R 即 rollback” 这类无法区分 **正常保留段跳跃** 与真实回退的模糊规则。<br>
> **硬约束（F-P2-COUNTER-GAP）：** 必须保证 **`R < window`**，使崩溃前向跳跃后接收侧仍有前进余量。

#### 6.8.1 发送侧：reservation / high-watermark

| 维度 | 冻结定义 |
| --- | --- |
| **持久化字段** | 每 `(deviceId, enrollmentEpoch, sessionId, direction=send)`：`reservedEnd`（uint64，**下一段尚未保留的起点**）、可选 `rekeyGeneration`；**不**持久化会话主密钥 |
| **默认 range** | **R = 32**（一次原子保留 `[reservedEnd, reservedEnd+R)`；可配置下调，**不得**上调超过 hard ceiling **256** 除非修订 spec；**且任何配置必须满足 `R < window`**） |
| **算法** | （1）内存持有 `nextCounter` 与当前已保留上界 `memReservedEnd`；（2）当 `nextCounter == memReservedEnd` 时，**先**原子持久化 `reservedEnd' = reservedEnd + R`（temp → `fsync` → `rename`），成功后才允许发送该段内序号；（3）发送仅递增内存 `nextCounter`，**不**每消息 fsync |
| **崩溃恢复** | 启动读取 `reservedEnd`；设 `nextCounter = reservedEnd`（即 **跳过** 整个已保留但可能未确认落盘使用的区间，进入下一段）。可能产生 gap；**禁止** 从小于 `reservedEnd` 的值恢复 |
| **崩溃前向 gap（精确）** | 单次崩溃恢复导致的 **forward gap ≤ R = 32**（跳过至多一整段已 reservation 区间）。因 **`R=32 < window=64`**，接收侧在 `highestAccepted` 之后仍至少保留 **window−R ≥ 32** 的前进余量，可继续接受恢复后的合法序号而 **不** 误触发窗口溢出拒绝 |
| **回退定义（精确）** | 仅当出现以下情况之一才 `device-counter-rollback`：（a）持久化文件显示的 `reservedEnd` **小于** 进程先前已成功持久化并确认的值（磁盘回滚/克隆）；（b）对端接收到的 counter **小于** 该方向已接受的最高 counter（重放/回退）；（c）启动时发现计数器状态签名/校验失败且无法证明权威性（§6.11） |
| **非回退** | 因 reservation 跳号产生的 **forward gap ≤ R（≤32）** 且落在接收窗口内 是 **正常** 行为，**不得** 判 rollback |

#### 6.8.2 接收侧：窗口与重放

| 维度 | 冻结定义 |
| --- | --- |
| **接收窗口** | 默认 **window = 64**（**必须** `window > R`；可独立配置但不得违反不等式）；接受 `counter ∈ (highestAccepted, highestAccepted + window]` 的新序号；位图去重 |
| **拒绝** | `counter ≤ highestAccepted` 且已见 → `device-replay-detected`；`counter > highestAccepted + window` → 拒绝（可要求对端 rekey/重协商，**不**自动当 rollback 除非伴随本地状态回退） |
| **持久化** | 周期性或按 reservation 对称策略原子写 `highestAccepted` / 窗口位图摘要；崩溃后可保守抬高 accepted 水位（只进不退） |

#### 6.8.3 存储与恢复策略

| 维度 | 冻结定义 |
| --- | --- |
| **存储位置** | 控制器/端点 dataDir 专用文件，权限 `0600`、属主服务账户 |
| **权限语义** | `0600` ≠ Keychain；长期私钥仍只进 Keychain |
| **密钥 vs 计数器** | 身份/token → Keychain；计数器状态 → dataDir；会话密钥 → 内存，rekey 后清零 |
| **原子写** | write temp → `fsync` → atomic `rename`；禁止半写 |
| **检测回退后** | **fail-closed**：终止会话；`device-counter-rollback`；审计；**不得**自动重置计数器继续 |
| **恢复** | 仅：（1）管理面 **re-enroll** 新 epoch；或（2）显式 **epoch rollover**。禁止“删计数器文件继续连” |
| **测试（M3）** | 故障注入：进程在保留段中途崩溃 → 重启后 counter ≥ 原 `reservedEnd` 且不复用；**forward gap ≤ 32** 且接收侧在 window=64 下仍可前进；常量契约 **`R=32 < window=64`**；性能：稳态发送路径 **无** 每消息 fsync；负向：人工回滚 dataDir 文件 → rollback fail-closed（A18） |

### 6.9 时钟偏移策略（F-04）

| 维度 | 冻结定义 |
| --- | --- |
| **默认允许 skew** | **±120 秒**（端点 UTC 与控制器 UTC） |
| **可配置范围** | 管理面可调；**下限 30s**（防止过紧误杀）；**上限 600s（±10 分钟）**；超过上限的配置 **拒绝加载** 并回落默认 |
| **错误码** | `device-clock-skew`（含脱敏：方向 ahead/behind 布尔与量级桶，如 `gt-120s`，**不**回传对端绝对时间戳全文到客户端日志） |
| **运维恢复** | 文档化步骤：校准系统时钟（NTP）→ 重试会话 → 仍失败则检查时区/手动时间；**不**建议用户关闭校验；**不**提供“永久忽略 skew”的生产开关 |
| **与防重放关系** | **Nonce / session sequence 是主要防重放机制**；时间窗仅用于 enrollment TTL、审计排序、辅助拒绝明显异常包。实现 **不得** 仅靠时间窗防重放 |
| **测试** | M1/M3：边界内接受、边界外拒绝；注入 skew=121s 必失败；关闭序列校验的构建不得进入发布 |

### 6.10 Data-plane resume 与完整性（F-14 / F-RESUME-LIMIT）

| 维度 | 冻结定义 |
| --- | --- |
| **Chunk 标识** | 每个数据块：`chunkId`（uint64，会话内单调）+ `cipherChunkDigest`（见下）+ `length` |
| **密文摘要** | `cipherChunkDigest = HMAC-SHA256(chunkMacKey, chunkId \|\| ciphertext)`；`chunkMacKey` 由 E2EE 会话以 label `linke-v2/data/chunk-mac` 派生。**禁止** 对明文内容做可被 relay 观察的裸 SHA-256；relay 可见的至多是密文字节与（可选）**keyed** digest，**不可**用于内容推断等价于明文 hash |
| **幂等 ACK** | 接收方对每个 `chunkId` 发 `ack(chunkId, status)`；重复收到同一 `chunkId`：**不重写** 已提交存储；返回成功 ACK（幂等） |
| **Checkpoint** | 持久化 `lastCommittedChunkId` + **manifest Merkle 根**（对已提交 `chunkId` 有序叶子的 SHA-256 Merkle root；叶 = `chunkId \|\| cipherChunkDigest`）；断连后从 `lastCommittedChunkId+1` resume |
| **每 transfer 自动 resume 上限** | **默认 5** 次自动 resume / transfer（uploadId）；管理面可配 **3–10**；**hard ceiling = 10**（配置 >10 **拒绝加载** 并回落默认 5）。**禁止** 无上限或“无限重试”生产路径 |
| **每次 resume 校验** | 每一次自动或显式 resume **必须** 复验 checkpoint（`lastCommittedChunkId` + Merkle 根）与相关 keyed digest 一致性；失败 → 中止该次 resume，计入尝试次数；使用 §4.4 指数退避+抖动，**不得** busy-loop |
| **耗尽语义** | 达到配置上限后标记 `data-resume-exhausted`：**暂停** 该 transfer 自动恢复；**必须** 管理员/调用方 **显式 resume**（或新 `uploadId` 显式重开）。**禁止** 静默从头重传同一 transfer、**禁止** 耗尽后无限循环自动重试 |
| **最终完整性** | upload 结束：发送方提交 `end-of-object` + **end-to-end object digest**（对明文逻辑对象的 digest，仅在 E2E 内传输，**不**暴露给 relay）；接收方复验 manifest Merkle + object digest 一致才 COMPLETED |
| **Relay 禁区** | 无明文、无明文 hash、无可离线内容推断的静态 digest；仅密文 blob + 长度 + 传输序号 + opaque tunnel 元数据（§6.2） |
| **残余长度泄露（接受）** | 与 §6.7.1 一致：relay **可观察** 密文/chunk **长度序列、时序、变更量近似**。Gold V2.0 **不** 承诺隐藏流量形状；**禁止** 文档/营销声称匿名或 traffic-analysis resistant |
| **可选固定 bucket padding（M4，非 Gold 必要）** | 实现 **可** 在数据面将密文 chunk 填充到固定 bucket（候选示例：**64 KiB / 256 KiB / 1 MiB**；**最终 bucket 集合由 M4 测试选型**，须权衡带宽放大与实现复杂度）。该能力为 **可选缓解**，**不是** Gold 必要门；启用与否须在 evidence/配置中诚实标注，且 **不得** 因此声称流量分析免疫 |
| **队列** | 禁止把 backup chunk 写入控制队列（§4.4） |
| **测试** | M4：幂等 ACK / 重复 chunk 不重写；默认上限与 ceiling 常量；最终 digest 失败拒绝 COMPLETED；A14 断言 relay 日志无明文 hash；可选 padding 若启用则测 bucket 对齐与带宽上限。M5 fault：至少 **连续断连 3 次并成功 resume**；另测 **10 次 hard ceiling** 触发 `data-resume-exhausted` 且需显式 resume（A4） |

### 6.11 控制器灾难恢复（F-16）

> **不** 将 APFS snapshot 写为唯一恢复方案。APFS snapshot / Time Machine / 加密备份介质均可作为 **载体**，但产品必须定义 **加密备份格式 + 恢复校验 + fail-closed** 语义。

| 维度 | 冻结定义 |
| --- | --- |
| **必须备份的权威状态** | `enrollmentEpoch` 表、设备绑定（deviceId ↔ Ed25519/Noise static digests）、**`trustEpoch`（控制器全局）**、**revocation set** / `revokeGeneration`、relay denylist 版本游标、**审计链头/锚定哈希**、计数器 reservation 元数据（非会话密钥） |
| **备份保护** | 备份 blob **加密**（密钥在 Keychain 或管理员带外保管的恢复密钥）；备份文件权限 `0600`；**禁止** 明文落盘 epoch/revocation 到可被拷贝的未加密目录作为唯一副本 |
| **恢复校验** | 解密后验证：schema 版本、HMAC/AEAD tag、审计链头自洽、epoch 单调性、与当前二进制兼容的 `stateEpoch`；任一失败 → **拒绝加载** |
| **全损或可信状态无法证明** | **fail-closed**：拒绝继续以旧身份服务 fleet；管理面进入 `controller-state-untrusted`；要求 **全 fleet replace/re-enroll + 新全局 epoch 世代**；旧绑定全部吊销 |
| **审计链断裂** | 检测 hash 链缺口/校验失败 → 显式事件 `audit-chain-broken`；**禁止** 静默续写同一链；必须开启 **新链世代**（记录 `priorChainHeadDigest` 若可知）并告警 |
| **可接受恢复载体（非唯一）** | （1）产品加密 state backup 导出/导入；（2）管理员保管的离线加密副本；（3）可选 APFS snapshot **作为载体之一**，但仍须通过同一恢复校验管线——**仅有 snapshot 不等于** 已证明可信状态 |
| **测试（M3/M6d）** | 备份→恢复 round-trip；篡改备份拒绝；审计链破坏触发 `audit-chain-broken` 且不静默续写；全损演练文档化 re-enroll fleet 路径 |

### 6.12 控制面 Keepalive / 会话保活（F-21 / F-KA-LIVENESS / F-P2-WS-PING）

| 维度 | 冻结定义 |
| --- | --- |
| **唯一间隔符号** | **`negotiatedKeepaliveInterval`**（秒）。会话建立时取双方可接受配置的交集/控制器权威值并写入会话状态。**删除** 一切 `max(3 × keepaliveInterval, 3 × configuredInterval)` 或混用多符号的混乱公式；实现与文档 **只** 使用本符号 |
| **默认值** | **`negotiatedKeepaliveInterval = 30`** |
| **可配置范围** | **5–120 秒**（含端点）；越界配置 **拒绝加载** 并回落默认 30s |
| **已认证应用层 ping/pong（唯一 liveness）** | 必须在 **Noise AEAD 保护的控制面** 内发送应用层 `ping` / `pong`（或等价已认证控制帧）。**仅** 此类 pong 与 **已认证** 控制/数据面流量可刷新 **安全会话** last-activity / liveness timer |
| **RFC6455 WebSocket ping/pong（传输层辅助）** | 允许作为 **传输层** 保活/中间盒辅助，**不算** authenticated liveness。**禁止** 用 WS ping/pong **刷新** 安全会话 timer 或推迟 `session-keepalive-timeout` 判定。实现须在测试中证明：仅注入 WS ping/pong **不能** 阻止超时断连 |
| **Ping 发送** | 按 `negotiatedKeepaliveInterval` 周期发送 **应用层** ping；任一方向 **已认证应用流量** 可刷新 last-activity 并 **推迟下一次应用层 ping**，但 **不得** 取消下方 liveness 截止 |
| **断连判定（唯一）** | 若超过 **`3 × negotiatedKeepaliveInterval`** 仍 **未收到** 有效 **应用层** pong **且** 未观察到对等 **已认证流量确认**（控制或数据面 AEAD）→ 判定连接死亡；关闭会话；进入既有 **指数退避重连**（§4.4：1s×2 封顶 60s±20% 抖动） |
| **错误/审计** | 因 keepalive 断连：审计 `session-keepalive-timeout`（记录 `negotiatedKeepaliveInterval` 桶与超时倍数，无载荷）；重连路径复用 `relay-connect-failed` / 会话恢复码，不发明明文降级 |
| **与 lifecycle** | keepalive OK **≠** `executionEligible`（§5.4） |
| **测试** | M1 常量契约（默认 30、范围 5–120、阈值 `3 × negotiatedKeepaliveInterval`）；M3：在 `3 ×` 窗口内无 **应用层** pong/已认证流量 → 断连+退避；窗口内有已认证流量则刷新确认；**仅 WS ping/pong 不刷新 timer**；配置 4s/121s 拒绝（A24） |

---

## 7. 真实验收矩阵

### 7.1 矩阵总表

| ID | 场景 | 需要真实外网/远端机器？ | 可单机模拟？ | 通过标准 | 归属里程碑 |
| --- | --- | --- | --- | --- | --- |
| A1 | **Two-machine different LAN** | **是**（两台真实 Mac，不同广播域/路由） | 否（单机双进程 ≠ 不同 LAN） | 建立 E2E 会话；heartbeat；身份绑定正确 | M5 |
| A2 | **Independent NAT + forced relay**（F-P1-M5-SYMMETRIC） | **是**（两台真实机器、两个独立路由域/NAT；direct 显式 disabled） | 否（mock/同 LAN 不可替代） | 全部 control/data 经 operator/user-managed WSS relay；`relayForced:true`；NAT 类型可 `unknown`；无手工端口映射；含 `proxyResult`/`firewallResult`/`relayDeployment`/`reachabilityResult`；**不**要求 double-symmetric | M5 |
| A3 | **Relay unavailable** | 建议真实；CI 可故障注入 | **是**（kill relay / 拒绝连接） | fail-closed；明确错误码；不降级明文；可恢复 | M3–M5 |
| A4 | **Reconnect / resume 上限** | 建议真实网络抖动 | **是**（断 TCP/WSS） | 控制面重连 + 数据面 checkpoint 幂等 resume；**每 transfer 默认 5 / 可配 3–10 / ceiling 10**；M5 至少 **连续断连 3 次并成功**；另测 **10 次** 触发 `data-resume-exhausted` 后须 **显式 resume**（禁止静默从头/无限循环）；无明文 hash 暴露 | M3–M5 |
| A5 | **Key rotation** | 可用真实 Keychain 更好 | **是**（契约级） | 旧 token/会话密钥立即拒绝；新密钥可用；Controller Noise static 轮换见 A27–A29 | M3、M5 |
| A6 | **Revocation** | 真实双机更佳 | **是** | revoke 后跨 LAN 与任何面均拒绝 | M3、M5 |
| A7 | **Replay** | 可注入 | **是** | 重放包/旧会话消息失败；审计记录 | M1–M3 |
| A8 | **Large backup dry-run** | 否 | **是** | 只规划不传真实大文件；边界标志清晰 | M4 |
| A9 | **Large backup real boundary** | **是**（真实磁盘与链路） | 否 | 大快照跨 LAN 上传完整复验；或显式记录 BLOCKED 不抬升 ready | M5 |
| A10 | **Restore boundary** | 真实恢复演练 | 部分 | 临时区复验后发布；跨设备不可见 | M4–M5 |
| A11 | **Audit evidence** | 本地 dataDir | **是** | 关键事件可查；无密钥/路径泄漏 | M3–M7 |
| A12 | Same-LAN direct regression | 可用 G0a 环境 | 部分 | 不回归 G0a PASS 语义 | M5 前回归 |
| A13 | 时钟偏移 | 可调时钟/注入 | **是** | 默认 ±120s 内可建连；121s 与配置上限外拒绝 `device-clock-skew`；**同时**验证 nonce/seq 仍为重放主防线 | M1–M3 |
| A14 | 恶意 relay 观察 | 测试 relay 记录可见字段 | **是** | 记录中无明文/密钥/会话材料；relay 未参与 KE | M2–M4 |
| A15 | 跨账户串线 | 双 device fixture | **是** | 越权 100% 拒绝 | M1–M3 |
| A16 | 协议/密码降级 | 注入 null cipher / 无 E2EE / 仅 hop TLS | **是** | 全部拒绝；审计 `protocol-downgrade-attempt`；`e2ee-required` | M1–M3 |
| A17 | Key confirmation 缺失 | 截断握手 | **是** | 不得进入 `established`；无半开业务通道 | M2–M3 |
| A18 | 计数器回退 / reservation gap | 崩溃注入/回滚持久化 | **是** | 崩溃 forward gap ≤**32**（R）；`R=32 < window=64` 接收仍有前进余量；真实 rollback → `device-counter-rollback` fail-closed；仅 re-enroll/epoch 恢复 | M3 |
| A19 | 克隆/并发同 deviceId | 双实例同身份 | **是** | 拒绝双活或 `device-clone-suspected`；需 replace-device | M3、M5 |
| A20 | 撤销传播 | 在线/离线/relay denylist | **是**/建议真实 | 在线 ≤5s 关会话；离线下次连接先校验；旧票全废 | M3、M5 |
| A21 | **Relay pin 轮换（正常）** | 建议真实双机 | **是**（契约） | 签名 pin-set 经 E2EE 下发；双 pin overlap；ack 仅在持久化后；grace 后 old 删除；审计事件齐全（§4.1.6） | M3、M5 |
| A22 | **Relay pin 更新失败** | 可注入 | **是** | 坏签名/持久化失败 → **保持旧 pin** + 告警；TLS 仍强制 pin；无跳过校验路径 | M3 |
| A23 | **Relay pin 紧急吊销 / 离线** | 建议真实 | **是**/半真实 | old 立即失效；在线端点仅 new；离线端点 fail-closed `relay-tls-pin-mismatch`；恢复靠带外/re-enroll | M3、M5 |
| A24 | **Keepalive 断连与配置** | 可注入 | **是** | 仅 `negotiatedKeepaliveInterval`：默认 30s；5–120s 边界；超过 `3 ×` 无 **Noise AEAD 应用层** pong/已认证流量 → 断连+退避；**RFC6455 WS ping/pong 不刷新**安全会话 timer（§6.12） | M1、M3 |
| A25 | **Enrollment secret bootstrap/丢失/rotate + 码交付** | 可注入 Keychain | **是** | 首次启动 **自动 CSPRNG 32B → Keychain 独立 item**；禁止手输/日志/明文传输；丢失 → `enrollment-secret-unavailable` 禁新码；已 enrollment 仍服务；rotate 升 `secretVersion` 作废旧码 **不** 强制全 fleet re-enroll；注册码明文仅 loopback UI/CLI 一次显示；默认不剪贴板；QR=`enrollmentQr/v1` 无 secret/private key（§6.3.1.1 / §6.3.4） | M3 |
| A26 | **Proxy 范围 / 凭据 / 负向** | mock CONNECT | **是** | 仅显式 HTTP CONNECT + Basic/Bearer（Keychain）；负向：PAC/WPAD→`proxy-pac-unsupported`、NTLM/Kerberos→`proxy-unsupported-auth`、代理链→`proxy-chain-unsupported`、MITM→`proxy-tls-intercepted` 均 fail-closed；另分 `proxy-auth-failed` / `proxy-connect-failed` / `relay-tls-pin-mismatch`；禁止装代理 CA 绕 pin（§4.1.5） | M2–M3 |
| A27 | **Controller Noise static 轮换（Case A）** | 可注入 | **是** | 已认证 E2EE 下发旧 Ed25519 签名的 `controller-noise-key-update`；含 old/new/`notBefore`/`graceUntil`/`trustEpoch`/`updateId`；先持久化再 ack；双 key overlap；grace 后拒旧 key；审计齐全（§6.7.8） | M3、M5 |
| A28 | **Controller Noise static 更新失败** | 可注入 | **是** | 坏签名 / `trustEpoch` 回退 / 持久化失败 → **保持旧 static** + 告警；无 TOFU；`stale-epoch-rejected` 可观测 | M3 |
| A29 | **Controller Ed25519 泄露路径（Case B）** | 可注入/演练 | **是**/半真实 | fail-closed；全 fleet replace/re-enroll + 新 identity/`trustEpoch`；**证明** 不存在“用泄露 identity 在线自证新 key”路径 | M3、M6d |
| A30 | **denylistVersion uint64 边界** | 注入近 `UINT64_MAX` | **是** | 禁止 wrap；达上限前 fail-closed `controller-state-untrusted`；触发信任状态迁移 + 全 fleet replace/re-enroll（§4.6.2） | M3 |

### 7.2 真实环境前置与 evidence schema（M5，F-12）

执行 A1/A2/A9 前必须：

1. 用户明确授权使用专用测试机器与 **operator/user-managed** 测试 relay（**禁止**假设公共 SaaS）。
2. **M5 relay 可达性前置（F-P2-RELAY-REACH）：** 验证 relay **公网 TCP 443 / WSS** 可达；记录 `relayDeployment`、`reachabilityResult` 与脱敏 DNS/TLS/pin 诊断。**localhost / mock 不得用于 M5。**
3. **禁止** 读取 secrets 目录、生产 `.env`、用户 SSH 私钥内容并输出。
4. **禁止** 修改生产网络设备配置 / 发邮件通知真实用户。
5. 报告遵守下列 **evidence schema**；缺失强制字段 → harness **FAIL**（不得标 PASS）。
6. **A2 可验证门：** 两独立路由域/NAT + `direct path disabled` + `relayForced:true`；NAT 类型可 `unknown`；**不**要求 double-symmetric（A2-ext 可选）。

#### 7.2.1 Cross-LAN evidence schema（F-12，强制）

Harness **必须** 校验 JSON/Markdown 结构化字段与 **当前 source commit** 一致；schema 版本 `cross-lan-evidence/v1`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `schemaVersion` | string | 固定 `cross-lan-evidence/v1` |
| `sourceCommit` | string | 完整 git commit；与被测二进制/app commit 一致 |
| `commandId` | string | 运行实例 id |
| `startedAtUtc` / `finishedAtUtc` | string | ISO-8601 UTC |
| `topology.sideA.natType` | enum | `full-cone` / `address-restricted` / `port-restricted` / `symmetric` / `unknown` / `unknown-documented`（**允许 unknown**；不因 unknown 阻塞 Gold） |
| `topology.sideB.natType` | enum | 同上 |
| `topology.sideA.role` / `sideB.role` | enum | `endpoint` / `controller` |
| `topology.independentNatDomains` | boolean | M5/A2 必填；`true` = 两独立路由域/NAT |
| `relayForced` | boolean | M5/A2 必填；`true` = direct path 显式 disabled，全部 control/data 经 WSS relay |
| `relayType` | enum | `mock` / `operator-managed-test` / `user-managed`；**M5 仅允许后两者** |
| `relayDeployment` | object | M5 必填：`{ kind: operator-managed-test|user-managed, publicListener: true, notesBucket? }`（无主机/IP/URL 原文） |
| `reachabilityResult` | object | M5 必填：`{ status: pass|fail, tcp443?, wss?, dnsBucket?, tlsBucket?, pinBucket?, errorCode? }`（脱敏诊断；无 secret/全文证书） |
| `framing` | enum | 固定生产值 `wss-tls1.3-tcp443`（mock 同 framing 抽象，可注 `loopback=true`；loopback **不得** 用于 M5 overall PASS） |
| `proxyResult` | object | `{ status: pass|fail|not-applicable, errorCode? }`；A2 必填；`errorCode` 可含 `proxy-auth-failed` / `proxy-connect-failed` / `proxy-unsupported-auth` / `proxy-pac-unsupported` / `proxy-chain-unsupported` / `relay-tls-pin-mismatch` / **`proxy-tls-intercepted`** |
| `firewallResult` | object | `{ status: pass|fail|not-applicable, errorCode? }`；A2 必填 |
| `env.osA` / `env.osB` | string | 脱敏 OS 版本桶（如 `macOS-15.x`），无主机名 |
| `env.nodeVersion` | string | Node 版本 |
| `env.appCommit` | string | 与 `sourceCommit` 对齐的应用 commit |
| `cells[]` | array | 每验收格一条 |
| `cells[].id` | string | `A1`…`A30`、`A2-ext` 等 |
| `cells[].status` | enum | `PASS` / `FAIL` / `BLOCKED` / `SKIP` / **`EVIDENCE-DEGRADED`** |
| `cells[].errorCode` | string|null | 注册错误码或 null；外部 artifact 问题可用 `evidence-artifact-missing` / `evidence-artifact-digest-mismatch` |
| `faultInjection` | object | 本 run 注入参数：`{ disconnectCount?, clockSkewSeconds?, relayKilled?, counterRollback?, proxyEnabled?, denylistVersionInjected?, wsPingOnly?, ... }` 仅布尔/计数/枚举 |
| `overall` | enum | 聚合结果；**不得** 在 schema 无效时为 PASS；任一 **Gold 必选 cell** 为 `EVIDENCE-DEGRADED` 时 overall **不得** 宣称可抬升 scorecard ready（见 §7.2.2 / §8.2） |

**红线（仍对齐 G0a）：** 禁止 IP/URL/token/fingerprint 全文、路径原文、密钥材料。仅注册错误码、布尔、计数、枚举桶。

**Harness 强制：**

1. 解析失败 / 缺字段 / `sourceCommit` ≠ 被测 app commit → **退出非零**，不得写 ready。
2. `relayType=mock` 或 localhost/loopback 的 run **不得** 关闭 M5 real 门禁；M5 overall PASS 要求 `relayType ∈ {operator-managed-test, user-managed}`、`relayForced=true`、`topology.independentNatDomains=true`、`reachabilityResult.status=pass`。
3. M2 dry-run 可用同一 schema 子集，但 `relayType` 必须为 `mock` 且 overall 不得宣称 real cross-LAN。
4. 外部 artifact 丢失或 digest 不可校验 → 对应 cell 标 **`EVIDENCE-DEGRADED`**（§7.2.2），不得静默 PASS。

#### 7.2.2 Gold evidence 保留与命名（F-22 / F-EOL-UNDEF）

> **删除不可判定的 “EOL-only” 规则。** 不以“该 major EOL”这类产品日历未定义事件作为 **唯一** 保留条件。下列规则为 **可判定、可执行** 的冻结策略。

| 维度 | 冻结定义 |
| --- | --- |
| **不覆盖** | Gold/M5/M6 **evidence 文件禁止原地覆盖**；每次 run 写 **新** artifact（新路径/新文件名） |
| **文件名** | 必须含 **日期** + **`sourceCommit` 前缀**（完整 commit 或规范短前缀，与报告内 `sourceCommit` 可互证），例如：`YYYY-MM-DD-<sourceCommitPrefix>-cross-lan-real-acceptance.md`（M6 各轨类推独立前缀） |
| **Repo 内脱敏 Gold report + digest** | 已合入 Git 的脱敏 report 与其 **content digest**：**永不覆盖**；通过 **Git 历史** 永久可追溯（force-push 抹史 **禁止** 作为清理手段）。工作树当前检出可清理，但不得改写历史 blob |
| **工作树文件保留下限** | 工作树中的 evidence 文件至少保留 **36 个月**（自 `finishedAtUtc` 或文件名日期起算），**并且** 至少保留到 **下一 major Gold 发布之日起满 12 个月**；两者取 **较晚** 者。例：V2.0 Gold report 在 V3.0 Gold 于 T0 发布后，仍须保留到 `max(finishedAt+36mo, T0+12mo)` |
| **外部大 artifact** | pcap/原始日志等大体量对象 **不得** 无约束堆进 git。外部存储对象同样至少 **36 个月**，且必须在 evidence 中绑定 **不可变 content digest** + 非密钥 URI/句柄 |
| **外部 artifact 丢失 / 不可校验（F-P1-EVIDENCE-LOSS）** | 若外部对象 **丢失** 或 **digest 不匹配/不可校验**：对应 **cell** 状态必须标 **`EVIDENCE-DEGRADED`**（错误码 `evidence-artifact-missing` 或 `evidence-artifact-digest-mismatch`）。**不得** 将该 cell 继续记为 PASS，**不得** 删除 schema 必要字段掩盖缺口 |
| **对 scorecard / overall 的传导** | 若被降级 cell 属于 **M5 或 M6 Gold 必选 cell**（如 A1/A2 及关闭对应 scorecard 项所必需的 cell）：对应 scorecard **门** 与 **overall** 若曾为 `ready`，必须降为 **`partial`**（证据残缺但非“完全无路径”时）并在复验前 **禁止** 重新标 `ready`；若该门在降级前本就无其它可替代真实证据，则保持/记为 **`blocked`**。与 §8.2 一致：**任一必选 cell `EVIDENCE-DEGRADED` ⇒ 该门不得 ready，overall 不得 Gold ready**。恢复路径 = 复验补证 + 新 evidence 文件（不覆盖） |
| **M7 前门禁** | **M7 完成前禁止删除** M5 与 M6a–d evidence（含 FAIL/BLOCKED/`EVIDENCE-DEGRADED` 诚实记录）；仅允许追加 |
| **清理审批 / 审计** | 超过保留下限后的清理必须：（1）书面变更/审批记录（操作者、时间、目标 digest 列表、保留下限计算依据）；（2）审计事件 `evidence-retention-purge-approved`（无敏感载荷）；（3）**禁止** 静默 `rm` 生产 evidence 目录。未达下限的删除 = 流程违规，M7/复验 **拒绝** |
| **仓库 report 体积预算（仅脱敏摘要）** | 合入仓库的 **脱敏摘要 report**（Markdown/JSON，不含外部 pcap/原始日志）必须遵守体积预算，且 **不得** 为压体积而删除 §7.2.1 必要字段、`sourceCommit`、cell 状态、digest 绑定或安全结论。**公式（冻结）：** `maxRepoReportBytes = min(512 KiB, 32 KiB + 4 KiB × cellCount + 8 KiB × schemaObjectCount)`，其中 `cellCount = |cells[]|`，`schemaObjectCount` = 顶层必填对象个数（至少计 topology、proxyResult、firewallResult、relayDeployment、reachabilityResult、env、faultInjection、overall 等 schema 对象）。**Hard ceiling = 512 KiB** / 单 report 文件。超出 → 拆外部 artifact + 仓库仅留摘要与 digest，**禁止** 砍必要字段。该预算 **只约束仓库内脱敏摘要**，不限制外部存储原始证据体积（外部仍受 36 月保留与 digest 绑定约束） |
| **校验** | M7 evidence 验证器必须能定位保留期内全部所需 artifact 与 digest；缺失强制字段、被覆盖痕迹、外部 digest 失败 / cell `EVIDENCE-DEGRADED` → **不得** ready |

### 7.3 单机可完成的最小 CI 门

M1–M4 合并前，CI **必须** 绿：

- 协议 schema / 状态机 / **Noise_IK fixed vectors** 与错误码
- msg1/msg2/key-confirm **消息顺序**契约
- 重放（nonce/seq 主路径）、计数器 reservation/回退、撤销 L2、轮换、串线
- 降级拒绝、key confirmation 缺失拒绝
- 恶意 relay 元数据最小化断言（无密钥/明文/明文 hash）
- 容量上限与队列分离（控制 vs bulk）
- 时钟 skew 边界
- enrollment 128-bit + HMAC digest + tombstone GC 契约；secret bootstrap/unavailable/rotate 契约（A25）
- keepalive 常量与 `3 × negotiatedKeepaliveInterval` 断连契约；**应用层** ping/pong；WS ping 不刷新 timer（A24）
- proxy 错误码桶（含 `proxy-tls-intercepted` / `proxy-unsupported-auth` / `proxy-pac-unsupported` / `proxy-chain-unsupported`）+ pin mismatch；凭据不进日志；禁止代理 CA 绕 pin（A26）
- counter **R=32 / window=64**（`R < window`）与崩溃 forward gap ≤32（A18）
- denylistVersion 近 `UINT64_MAX` 注入 → `controller-state-untrusted`、禁止 wrap（A30）
- enrollment 明文仅 loopback 一次显示；默认无 clipboard；QR `enrollmentQr/v1` 无 secret（A25）
- evidence-degraded：外部 digest 失败 → cell `EVIDENCE-DEGRADED`；仓库 report 体积预算公式（§7.2.2）
- relay pin-set 消息字段（`trustEpoch`）与失败保持旧 pin（A21–A22 可模拟部分）
- controller-noise-key-update 字段/overlap/`trustEpoch` 回退拒绝（A27–A28 契约）
- dry-run 大备份 / resume 幂等边界（默认 5 / 可配 3–10 / ceiling 10）
- evidence schema 校验器（缺字段失败）+ 命名/不覆盖/36 月+下一 major Gold 12 月保留规则（§7.2.2）
- Noise library selection gate ADR 存在性检查（M1；无则 BLOCKED）（§6.7.7）
- 与 lifecycle execute 抬升的负向测试

CI 绿 **不等于** `cross-lan-connectivity: ready`。

---

## 8. 与现有 Gold blockers 映射

### 8.1 总映射表

| Scorecard item | 当前 (V1.33 / f21d520) | V2.0 ready 进入条件 | 主要里程碑 | 与 cross-LAN 关系 |
| --- | --- | --- | --- | --- |
| `release-readiness` | ready（静态/运行健康） | 同 commit 全量 evidence 验证；版本与 README 一致为 **V2.0** 仅在 M7 | M7 | 依赖其它门齐 |
| `local-backup-restore` | ready（原型边界） | 真实 APFS 备份恢复 + 跨 LAN 数据面复验不破坏本地语义 | M4–M5 | 数据面消费方 |
| `fleet-device-management` | ready（只读展示） | 多设备真实注册/撤销/状态；含跨 LAN 设备可见性 | M5 | 强相关 |
| `version-consistency` | ready | 控制器/Agent current+N-1；跨 LAN 协议窗口一致 | M1、M5 | 协议窗口 |
| `nas-dry-run` | partial | 计划语义与真实 SMB adapter 一致；不再用 dry-run 冒充实 NAS | M4、M6 | NAS 不经 relay |
| `automation-installation` | partial | 真实 launchd 安装→卸载；非 lifecycle stub | M6 | 正交；不因 cross-LAN 自动 ready |
| `security-auth` | partial | 角色生效 + Keychain + 轮换 + 设备身份；无明文回退 | M3、M6 | 设备/会话认证基础 |
| `real-nas-remote-backup` | **blocked** | 真实 smbfs 复制+断连恢复+完整性；专用测试共享 | M4、M6 | 控制器侧；非 relay 传输 NAS 凭证 |
| `production-hardening` | partial | Retention 真执行、调度、审计链、监控、升级回滚 | M6 | 审计/限流共享纪律 |
| **`cross-lan-connectivity`** | **不存在 → 视为 blocked** | §4 能力齐全 + §7 A1/A2 等真实项 PASS + 脱敏报告 | M0–M5 | **新门禁** |

### 8.2 每项 ready / partial / blocked 语义（V2.0）

| 状态 | 含义 |
| --- | --- |
| `blocked` | 无真实路径或关键真实边界未过；或必选 cell 证据不可用且无替代 |
| `partial` | 有实现或 dry-run/契约，但缺真实证据/能力子集；**或** 曾 ready 后因外部 artifact 丢失导致必选 cell `EVIDENCE-DEGRADED`（证据残缺） |
| `ready` | 真实路径 + 真实边界证据 + 安全边界文档 + 可复现演练；**全部** 必选 cell 为 PASS 且外部 digest 可校验 |

**固定规则（继承 Gold 单机设计并强化）：**

- dry-run / preview / blocked stub / 静态 scorecard 字符串 **不能** 单独把 item 推到 ready。
- G0a same-LAN PASS 最多支撑 fleet/security 的 **LAN 子集 partial/证据**，**不能** 关闭 `cross-lan-connectivity`。
- **Evidence-degraded 传导（与 §7.2.2 一致）：** M5/M6 Gold 必选 cell 为 `EVIDENCE-DEGRADED` 时，对应 scorecard 门 **不得保持 `ready`**，应降为 **`partial`**（有历史/部分证据）或 **`blocked`**（无可用替代证据）；**overall 不得为 Gold ready**，直至复验补证。
- **`cross-lan-connectivity` ready 额外要求：** A1+A2 以独立 NAT + `relayForced:true` + 非 mock 公网 WSS relay 通过；**不**要求 double-symmetric（A2-ext 可选）。

### 8.3 进入条件 checklist（实现阶段维护）

#### automation-installation

- **partial→ready：** 干净 Mac 上 install/start/stop/crash-restart/uninstall 真实验收；rollback 锚点有效；非 `executor-implementation-missing` 永久 stub。
- **仍 blocked 若：** 仅有 dry-run plan / Web gate 展示。

#### real-nas-remote-backup

- **partial→ready：** 专用 smbfs 目录真实 replicate + 断连 resume + COMPLETED 复验 + 恢复演练。
- **仍 blocked 若：** 仅 nas-dry-run 或本地 tmp 冒充 SMB。

#### security-auth

- **partial→ready：** 三角色写入口生效；Keychain 存密钥；轮换/撤销；跨 LAN 会话认证串联。
- **仍 blocked 若：** 仅 optional bearer skeleton。

#### production-hardening

- **partial→ready：** 审计链、限流、restore root、Retention 真删、调度、监控在真实本机跑通。
- **仍 blocked 若：** 仅 hardening-status 布尔面板。

#### cross-lan-connectivity（新）

- **blocked：** 无协议实现。
- **partial：** M1–M4 契约/dry-run 完成但 M5 真实不同 LAN 未 PASS。
- **ready：** M5 矩阵必选项（含 A1/A2：独立 NAT + `relayForced:true` + operator/user-managed relay 可达）PASS + 报告入库 + 无 `EVIDENCE-DEGRADED` 必选 cell + 无门禁降级；**不**要求 A2-ext double-symmetric。

---

## 9. 实施路线（设计层总览）

> 详细 task/commit boundary 见 plan 文档。此处只冻结顺序与原则。

```text
M0  threat model + design freeze (本阶段)
 → M1  protocol skeleton tests（含 crypto 约束契约）
 → M2  relay/client handshake dry-run（relay 不参与 KE）
 → M3  encrypted control channel（E2EE + 撤销 + 队列 + 计数器）
 → M4  data-plane / NAS boundary
 → M5  real cross-LAN acceptance
 → M6a ‖ M6b ‖ M6c ‖ M6d  remaining Gold gates（独立证据）
 → M7  RC + Gold ready only if 10/10
```

每一步：

1. 先测试/契约（RED→GREEN）
2. 再最小实现
3. 负向安全测试
4. **独立 commit boundary**（实现阶段；本 docs 阶段不 commit）
5. 不满足出口条件不得进入下一里程碑的 ready 宣称

### 9.1 本阶段（docs only）约束

- 只修改/维护：
  - `docs/superpowers/specs/2026-07-16-linke-v2-gold-cross-lan-release-design.md`
  - `docs/superpowers/plans/2026-07-16-linke-v2-gold-cross-lan-release.md`
- 禁止：源码、测试、README、`src/gold-readiness.js`、package、env、secrets
- 禁止：创建其它文件、子代理、web 搜索、commit、push
- 禁止：改生产网络、发邮件、读取并输出 secrets

### 9.2 实现阶段全局安全约束

- 不要求打开路由器端口
- 不输出 env/keys/token/fingerprint 全文
- 测试 relay 仅用专用/用户管理资源；**不暗示公共生产 SaaS**
- 遵守 §6.7 Crypto Architecture Constraints
- 真实写入需用户硬闸
- 不把 cross-LAN 成功写进 lifecycle execute 授权

### 9.3 M6 子轨独立性（F-05）

| 子轨 | Scorecard 目标 | 独立输入 | 失败隔离 |
| --- | --- | --- | --- |
| **M6a** | `automation-installation` → ready | 干净 Mac、launchd 权限、非 lifecycle stub 适配器 | 失败只回滚本轨 evidence/旗标；**不**阻塞 M6b–d 提交 |
| **M6b** | `real-nas-remote-backup` + `nas-dry-run` → ready | 专用 smbfs 测试共享、控制器本机挂载 | 同上；**不得**用 cross-LAN PASS 冒充 NAS ready |
| **M6c** | `security-auth` → ready | Keychain 访问、角色矩阵、设备身份（可与 M3 串联但证据独立） | 同上 |
| **M6d** | `production-hardening` → ready | 本机 Retention/调度/审计链/监控演练环境 | 同上 |

**规则：**

1. 每子轨有独立 tasks / exit / commit boundary / rollback（见 plan）。
2. 单子轨失败 **不得** 阻止其它子轨的代码与 evidence 提交。
3. **M7 必须 10/10**：任一 M6 子轨或 M5 未出口 ⇒ **禁止** Gold/GA。

---

## 10. 与既有文档的关系

| 文档 | 关系 |
| --- | --- |
| `2026-07-13-linke-gold-single-mac-release-design.md` | 单机 Gold 能力基线；V2.0 **继承** 其控制面/数据面/NAS/生命周期要求，并 **叠加** cross-LAN 门禁 |
| `2026-07-13-linke-gold-execution-roadmap.md` | G0a–G7 阶段索引；V2.0 将 G7 重定义为 **必须含 cross-LAN** 的 10/10 |
| G0a harness + report | same-LAN 证据；V2.0 M5 的 **回归基线**，非 cross-LAN 替代 |
| V1.33 real-status spec/plan | 明确 Gold/GA 与 cross-LAN 属 V2.0；本设计兑现该声明 |
| NAS SMB design | 数据面最终落到控制器本地 smbfs；跨 LAN 不改变“不读 SMB 凭证” |

### 10.1 对 G0–G7 的修订声明（产品）

原 G7：`ready:9, partial:0, blocked:0, total:9`<br>
**V2.0 修订：**

```text
G7' / M7: ready:10, partial:0, blocked:0, total:10
  including cross-lan-connectivity
```

G0a 仍是信任基础；新增 **G0x / M1–M5** 为 cross-LAN 轨道，与 G0b/G1 等数据能力并行但 **证据独立**。

---

## 11. Qwen 抗辩 Checklist

### 11.1 P0 风险（必须在实现前锁死）

| ID | 风险 | 失败条件 | 缓解 / 回滚 |
| --- | --- | --- | --- |
| P0-1 | 用 G0a/V1.33 冒充 cross-LAN Gold | scorecard 在无 A1/A2 时变 ready | 本 spec 硬规则；测试拒绝；回滚 scorecard 改动 |
| P0-2 | 中继可见明文或密钥 / 参与 KE | relay 日志/内存出现 token/snapshot 明文或会话密钥 | §6.7 E2EE；元数据 allowlist；A14；关闭 relay 路径 |
| P0-3 | 要求用户开端口 | 文档/安装指南出现端口映射必选项 | 产品拒绝；验收禁止端口映射步骤 |
| P0-4 | 公开未认证 proof/enroll API | 公网可刷 | 默认绑定与认证门；无匿名 proof |
| P0-5 | 跨 LAN 抬升 lifecycle execute | `executionEligible:true` 仅因会话建立 | 负向测试；边界文档 |
| P0-6 | 降级到明文/无认证/无 E2EE | 存在可协商 null 或 “仅 hop TLS” 模式 | §6.7；A16；审计 `protocol-downgrade-attempt` |
| P0-7 | 日志/报告泄密 | 报告含 IP/URL/token | G0a 级红线扫描 |
| P0-8 | 无限版本堆叠 | 出现 V2.0.1-gold-almost… | 仅 M0–M7；变更走 spec 修订 |
| P0-9 | Crypto bootstrap 未冻结或自创算法 | 实现偏离 §6.7 或 relay 持可解密材料 | M0 锁死 §6.7 Noise_IK_25519_ChaChaPoly_SHA256；**M1 §6.7.7 library gate** + fixed vectors；无候选通过则 M1 BLOCKED；失败则停 M7 |
| P0-10 | 握手协议开放措辞导致实现漂移 | 出现“或等价 KE”实现分叉 | §6.7.2 唯一 pattern/suite；审查禁开放措辞 |
| P0-11 | Transport 降级 / 错误 framing | raw TLS 或非 WSS 生产路径 | §4.1.5 冻结 WSS/TLS1.3/443；fail-closed |
| P0-12 | 静默自研 Noise / 无 ADR 选型 | M1 未过 library gate 即合入握手实现 | §6.7.7 hard gate；BLOCKED 必须变更控制 |

### 11.2 P1 风险

| ID | 风险 | 缓解 |
| --- | --- | --- |
| P1-1 | 单机 mock 被记 M5 PASS | Real-boundary ledger；commandId 门；relay 类型标注；§7.2.1 schema |
| P1-2 | 时钟偏移导致大规模拒绝或误当主防重放 | §6.9 默认 ±120s / 上限 ±600s；nonce/seq 主防重放；运维恢复 |
| P1-3 | 离线队列内存膨胀 / 控制与 bulk 混队 | §4.4 硬上限 + 队列分离 + 背压 |
| P1-4 | NAT 切换会话风暴 / 把 double-symmetric 设为不可验证硬门 | §4.1.3：独立 NAT+`relayForced` 为必要门；double-symmetric 仅 A2-ext；§4.4 退避 |
| P1-5 | 与 NAS 真实门互相阻塞进度 | M6 子轨独立；**禁止**互相冒充 ready |
| P1-6 | 文档与 scorecard 长期漂移 | M7 单一发布清单；readme/gold 测试 |
| P1-7 | 计数器回退未 fail-closed / gap 与窗口关系错误 / 每消息 fsync | §6.8 **R=32 / window=64**（`R < window`）；forward gap≤32；精确 rollback；M3 测 |
| P1-8 | 设备克隆双活 | §4.5 concurrent detection + replace-device |
| P1-9 | 撤销误写“relay 必拒”导致虚假保证 | §4.6 两层：L1 减滥用、L2 权威拒绝 E2EE |
| P1-10 | 暗示公共生产 relay SaaS | §4.1.4 仅自建/用户管理；报告标注 relay 类型 |
| P1-11 | Evidence 缺拓扑/代理/relayForced/可达性字段 | §7.2.1 强制 schema + `relayForced` + reachability + source commit |
| P1-12 | 低熵 enrollment / digest 明文 | §6.3 128-bit + HMAC + Keychain secret |
| P1-13 | 数据面 resume 重写、无限重试或泄露明文 hash | §6.10 幂等 ACK + keyed digest；默认 5/可配 3–10/ceiling 10；耗尽须显式 resume |
| P1-14 | 控制器状态全损后静默续服 | §6.11 fail-closed + fleet re-enroll |
| P1-15 | 过期码 GC 后被重放接受 | §6.3.3 tombstone ≥24h；GC 后统一拒绝 |
| P1-16 | Enrollment secret 丢失被误判为全 fleet re-enroll | §6.3.4：仅禁新码；已 enrollment 继续；显式 rotate + secretVersion |
| P1-17 | Relay pin 轮换 TOFU / 跳过校验 | §4.1.6 签名 pin-set、`trustEpoch`、先持久化后 ack、失败保旧 pin、紧急吊销、离线 fail-closed |
| P1-18 | Proxy 超范围（PAC/NTLM/链）或 secret 进文件/日志；装代理 CA 绕 pin | §4.1.5 仅 CONNECT+Basic/Bearer；non-goal fail-closed；Keychain；禁止回显 |
| P1-19 | Keepalive 用 WS ping 冒充认证 liveness 或过松/过紧 | §6.12 仅应用层 Noise AEAD ping/pong 刷新 timer；WS ping 辅助不计入 |
| P1-20 | Gold evidence 覆盖/过早删除/外部丢失未降级 | §7.2.2：`EVIDENCE-DEGRADED` 传导；体积预算；清理审批 |
| P1-21 | Controller Noise static 与 Ed25519 identity 泄露路径混淆 | §6.7.8 Case A 在线签名更新 vs Case B 全 fleet re-enroll；禁止泄露 identity 自证 |
| P1-22 | `trustEpoch` 语义冲突/回退 | §6.7.8.1 全局单调 uint64；拒绝 ≤ lastAccepted；与 `enrollmentEpoch` 正交 |
| P1-23 | 把真实 double-symmetric NAT 设为 Gold 硬门导致不可验证 | §4.1.3 / A2：独立 NAT+强制 relay；A2-ext 可选 |
| P1-24 | 声称流量分析免疫 / 隐藏长度序列 | §6.7.1 / §6.10：接受残余 size leak；可选 padding 非必要 |
| P1-25 | denylistVersion wrap | §4.6.2：`UINT64_MAX` 前 fail-closed `controller-state-untrusted` |
| P1-26 | T1.0 BLOCKED 后静默 fixed-fixture 捷径 | §6.7.7：7 日内 PM+用户 ADR；兼容层须审查+spec 变更 |

### 11.3 失败条件（任一即不得 Gold）

1. `cross-lan-connectivity` 非 ready<br>
2. 任一既有 9 项非 ready<br>
3. 真实验收报告缺失、过期、或 commit 不匹配<br>
4. 存在可复现的 P0 安全失败（泄密/降级/越权）<br>
5. 发布声明与 scorecard 不一致<br>

### 11.4 可回滚策略

| 阶段 | 回滚 |
| --- | --- |
| M0 docs | 删除或修订两份 md；不影响运行时 |
| M1–M4 代码 | 特性旗标默认 off；revert 独立 commit；不改 Gold ready |
| M5 验收失败 | 保持 item blocked/partial；保留脱敏 FAIL 报告 |
| M7 误标 ready | **立即** 回退 version/scorecard/README 声明至 blocked；作废证据 |

### 11.5 验收前置条件

- [ ] 本 spec 与 plan 经 PM 冻结（M0）
- [ ] 实现阶段环境：Node 与现仓库基线一致；专用测试资源
- [ ] 用户授权真实双机 / 可选测试 relay（M5）
- [ ] 不读取、不输出 secrets
- [ ] 不改生产网络、不发邮件
- [ ] G0a same-LAN 回归仍可执行
- [ ] 全量自动化测试绿后方可进入真实门
- [ ] Gold ready 仅在 10/10 + 证据验证命令通过后

### 11.6 抗辩问答（预置）

**Q: 为何 G0a PASS 还不够？**<br>
A: G0a 证明 same-LAN Keychain/TLS/enrollment。跨局域网引入恶意中继、NAT、outbound-only、不同路由域等新威胁，必须独立证据。

**Q: 为何不先开端口做简单公网 TLS？**<br>
A: 产品硬约束 no inbound；开端口扩大攻击面且家庭网络不可运维。

**Q: 为何 V2.0 才是 Gold，而不是 V1.40？**<br>
A: 停止无限 partial 堆叠；用有限 M0–M7 闭合门禁；V1.x 保留审计历史。

**Q: cross-LAN ready 是否等于可远程执行 supervisor？**<br>
A: 否。通道与 execute 门禁正交。

**Q: 对 relay 做了 mTLS 是否算 E2EE？**<br>
A: 否。hop TLS 只保护到 relay 的传输；payload 必须走 §6.7 独立 E2EE session layer。Relay 不参与 KE。

**Q: 双对称 NAT 打洞失败是否 Gold 失败？**<br>
A: 否。direct/hole-punch 非必需；Gold 必要门是独立 NAT + 强制 relay（`relayForced:true`），非“必须测到 double-symmetric”。outbound relay 是确定性 fallback（§4.1.3）。

**Q: dataDir 0600 能否存长期私钥？**<br>
A: 否。0600 只是文件访问控制；长期私钥/设备 token / enrollment-hmac-secret / proxy Authorization secret 进 Keychain。计数器状态可放 dataDir。

**Q: enrollment-hmac-secret 丢失是否必须全 fleet re-enroll？**<br>
A: 否。该 secret 只服务注册码 digest。已 enrollment 设备继续认证；进入 `enrollment-secret-unavailable` 仅禁止新码；显式 regenerate 后升 secretVersion 并作废未消费旧码（§6.3.4）。首次启动为自动 CSPRNG 32B → Keychain，禁止手输/日志/明文传输。

**Q: docs 阶段是否已选定某个 Noise npm 包？**<br>
A: 否。suite 已冻结；具体库由 M1 §6.7.7 spike/ADR 核验，无候选通过则 M1 BLOCKED，禁止静默自研。

**Q: Controller Noise static 泄露是否等于 identity 泄露？**<br>
A: 否。仅 Noise static 且 Ed25519 仍可信 → Case A：E2EE 下发旧 identity 签名的 `controller-noise-key-update`。Ed25519 泄露或可信不可证 → Case B：fail-closed 全 fleet re-enroll；禁止用泄露 identity 在线自证（§6.7.8）。

**Q: 企业 TLS 拦截代理能否装 CA 通过 SPKI pin？**<br>
A: 否。TLS MITM 与 SPKI pin 不兼容；Gold 路径 fail-closed；记录 `proxy-tls-intercepted`；禁止为绕 pin 安装代理 CA（§4.1.5）。

**Q: `trustEpoch` 与 `enrollmentEpoch` 是否同一字段？**<br>
A: 否。`trustEpoch` 是控制器全局单调信任世代；`enrollmentEpoch` 是 per-device 注册世代。信任更新拒绝 `trustEpoch ≤ lastAcceptedTrustEpoch`（§6.7.8.1）。

**Q: double-symmetric NAT 是否 Gold 必要条件？**<br>
A: **否。** 必要门是两独立路由域/NAT + direct disabled + 全部流量经 operator/user-managed WSS relay（`relayForced:true`）；NAT 类型可 unknown。double-symmetric 为强推荐扩展 cell（A2-ext），缺失不单独阻塞 Gold（§4.1.3）。

**Q: 是否承诺对 relay 隐藏流量形状？**<br>
A: **否。** Relay 可观察密文/chunk 长度序列、时序与变更量近似；此为接受的残余风险。M4 可选 bucket padding；不得声称匿名或 traffic-analysis resistant（§6.7.1 / §6.10）。

**Q: V2.0 是否支持 PAC/WPAD 或 NTLM 代理？**<br>
A: **否。** 仅显式 HTTP CONNECT + Basic/Bearer；PAC/WPAD、NTLM/Kerberos、代理链、TLS MITM 均为 non-goal 且 fail-closed（§4.1.5）。

**Q: RFC6455 WebSocket ping 能否维持安全会话？**<br>
A: **否。** 必须使用 Noise AEAD 应用层 ping/pong；WS ping 仅传输层辅助，不刷新安全会话 timer（§6.12）。

**Q: 外部 evidence artifact 丢失怎么办？**<br>
A: 对应 cell 标 `EVIDENCE-DEGRADED`；若为 M5/M6 必选 cell，scorecard 门与 overall 从 ready 降为 partial/blocked，直至复验补证（§7.2.2 / §8.2）。

**Q: T1.0 library gate BLOCKED 后能否直接合入 fixed-fixture 实现？**<br>
A: **否。** 7 个自然日内 PM+用户裁决 ADR（替代库/修订协议/暂停 V2.0）；fixed-fixture 兼容层仍须完整安全审查与 spec 变更，禁止静默捷径（§6.7.7）。


---

## 12. 完成标准（本设计阶段）

1. 写出 V2.0 = Gold/GA 充分必要门禁（10 项）与有限里程碑 M0–M7<br>
2. 跨局域网产品定义覆盖 §4.2 全部能力<br>
3. 威胁模型覆盖用户列出的全部场景（§5.2）<br>
4. 协议边界：control/data plane、relay 最小化、enrollment、token scope、no inbound、与 lifecycle 分离<br>
5. **§6.7 Crypto Architecture Constraints** 冻结为 **Noise_IK_25519_ChaChaPoly_SHA256**（无“或等价”）；传导至威胁模型与 M1–M3/验收<br>
6. §4.1.5 WSS framing + proxy 凭据/`proxy-tls-intercepted`、§4.1.6 pin 轮换（`trustEpoch`）、§4.4 容量+keepalive、§4.5 克隆/重装、§4.6 两层撤销、§6.3 enrollment/tombstone/secret lifecycle（bootstrap 主文）、§6.7.8 Noise static lifecycle + `trustEpoch`、§6.8 reservation 计数器、§6.9 时钟、§6.10 data resume（默认 5/ceiling 10）、§6.11 控制器 DR、§6.12 keepalive（仅 `negotiatedKeepaliveInterval`）齐全<br>
7. 真实验收矩阵区分真实外网 vs 单机模拟（含 A16–A29）；§7.2.1 evidence schema + §7.2.2 可判定保留策略（非 EOL-only）<br>
8. 映射全部既有 Gold blockers + 新门禁；M6a–d 独立<br>
9. 明确禁止 V1.33 / G0a / 同 LAN / hop TLS 冒充 cross-LAN E2EE / Gold<br>
10. 实施路线与 commit boundary 在 plan 中可执行；无 TBD/TODO/FIXME 占位<br>
11. Scope 与安全红线写清；当前事实保持 V1.33 / Gold blocked / cross-LAN 未实现<br>
12. Qwen 抗辩 checklist 完整（含 F-01–F-23 与历史返修项，以及第五轮 **F-P1-M5-SYMMETRIC / F-P1-SIZE-LEAK / F-P1-PROXY-SCOPE / F-P1-EVIDENCE-LOSS / F-P2-COUNTER-GAP / F-P2-WS-PING / F-P2-ENROLL-DELIVERY / F-P2-RELAY-REACH / F-P2-M1-CONTINGENCY / F-P2-DENYLIST-U64**）<br>
13. §6.7.7 Noise library selection gate：docs-only 不点名包、不宣称已审计；M1 hard gate + **BLOCKED 后 7 日 ADR 裁决** 冻结<br>
14. 计数器 **R=32 / window=64**；keepalive 应用层 vs WS ping 分离；proxy 范围与 enrollment 交付；evidence-degraded 与 report 体积预算闭合<br>

**本阶段不要求也不允许实现代码。**

---

## 13. 结论（PM）

| 结论 | 内容 |
| --- | --- |
| Gold 版本 | **V2.0** 是唯一 Gold/GA 目标版本（未来目标，非当前状态） |
| 当前 | **V1.33**；Gold **blocked**；cross-LAN **未实现**；无公共生产 relay SaaS |
| 新门禁 | `cross-lan-connectivity` 强制加入 Gold，总数 10 |
| Crypto | §6.7 冻结：Noise_IK_25519_ChaChaPoly_SHA256；独立 E2EE；relay 不参与 KE；禁止自创算法；§6.7.7 M1 library gate |
| Transport | §4.1.5：WSS/TLS1.3/443 outbound-only；仅 CONNECT+Basic/Bearer；PAC/NTLM/链/MITM non-goal；pin 轮换 §4.1.6 |
| M5 NAT 门 | §4.1.3：独立 NAT + `relayForced:true` 必要；double-symmetric 仅扩展；NAT 可 unknown |
| Keepalive | §6.12：仅应用层 Noise AEAD ping/pong 刷新 timer；WS ping 不计入；默认 30s、5–120s；`3 ×` |
| Counter | §6.8：R=32，window=64，`R < window`；崩溃 gap≤32 |
| Enrollment secret | §6.3.4：首次启动自动 CSPRNG 32B→Keychain；禁手输/日志/明文；丢失不强制全 fleet re-enroll |
| Controller Noise static | §6.7.8：Case A 在线签名更新 vs Case B 全 fleet re-enroll；`trustEpoch` 全局单调 |
| Resume | §6.10：默认 5/可配 3–10/ceiling 10；耗尽须显式 resume |
| Evidence | §7.2.1 schema（含 relayForced/reachability）；丢失→`EVIDENCE-DEGRADED`；report 体积预算；36 月+下一 major 12 月 |
| Revocation | §4.6：L1 denylist 非权威；L2 控制器权威拒绝 E2EE |
| G0a | same-LAN 信任基础 PASS，**非** cross-LAN Gold |
| 路径 | 有限 M0–M7（M6= a–d 独立子轨）；禁止无限堆叠宣称 |
| 本阶段 | docs only；实现与 scorecard 变更留给后续经授权的实现阶段 |
