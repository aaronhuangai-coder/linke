# ADR — Linke V2.0 M1/T1.0 Noise Library Selection Gate

| 字段 | 值 |
| --- | --- |
| **文档类型** | Architecture Decision Record（ADR） |
| **里程碑 / 任务** | **M1 / T1.0** — Noise library selection gate（F-23 / design §6.7.7） |
| **状态** | **`BLOCKED`**（gate 未通过；非生产就绪；非条件通过；**非** `PASS_WITH_HARD_CONDITIONS`） |
| **日期** | **2026-07-16**（初稿 / 修订-1）；**2026-07-17**（修订-2：PM findings 闭环 — 供应链方法论、一手复核、向量证据边界、7 日 Asia/Shanghai 口径、downstream labeling、附录截断纪律；同日闭合 fresh reviewer R-01/R-02/R-04：Git 授权与路线/依赖授权拆分、path-specific 提交边界、tarball `dist/` 路径） |
| **复核日** | **2026-07-17**（一手来源实时核验；非搜索摘要） |
| **工作区** | `linke-v0.12-web-panel` worktree |
| **关联 design** | `docs/superpowers/specs/2026-07-16-linke-v2-gold-cross-lan-release-design.md` §6.7、§6.7.7 |
| **关联 plan** | `docs/superpowers/plans/2026-07-16-linke-v2-gold-cross-lan-release.md` T1.0 |
| **范围** | **仅** 本 ADR 文档本身。**不**提交 dependency / `package.json` / `package-lock.json` / 源码 / 测试 / CI 变更。工作树中 untracked `package-lock.json` **不属于本任务**（与本 ADR 同为 untracked 时尤须注意）。**任务纪律（非 git 自动屏障）：** 只允许 `git add -- docs/superpowers/specs/2026-07-16-linke-v2-m1-noise-library-selection-adr.md`；**禁止** `git add .` / `git add -A`（否则会误 stage lockfile）。本任务 **不** 修改、删除或提交 `package-lock.json`。 |
| **7 日裁决截止** | **day 0 = 2026-07-16**；截止 **2026-07-23 23:59 Asia/Shanghai**（design §6.7.7；逾期仍 `BLOCKED`，**不**自动暂停、**不**默认选路线） |

---

## 1. 背景

Linke V2.0 Gold 跨局域网控制面冻结 **唯一** E2EE 握手套件：

```text
Noise_IK_25519_ChaChaPoly_SHA256
token 序列（不可重排/省略）:
  -> e, es, s, ss
  <- e, ee, se
prologue 前缀（应用层）:
  linke-v2/cross-lan/noise-ik/v1 || protocolVersion(uint16 BE) || suiteId=1
```

Design §6.7.2 禁止“或等价 KE / 类似 Noise”漂移；§6.7.7 要求 M1 **入口 hard gate**：在合并任何生产 Noise 依赖或声称“Noise 实现就绪”之前，必须对 **2–3 个当前公开候选** 完成可核维对照，并产出 ADR。

Design §6.7.7 **仅定义两种 gate 结果**：

| 结果 | 条件 |
| --- | --- |
| **通过** | ≥1 候选满足全部硬需求 **且** 供应链风险可接受 → 允许引入该依赖（须单独依赖变更控制） |
| **失败 / 无候选通过** | **M1 = BLOCKED**；禁止静默自研 / 降级 suite / 未经审查的 fixed-fixture 捷径 |

**不存在** 冻结规范授权的第三态（如 `PASS_WITH_HARD_CONDITIONS`）。原草案第三态已在修订-1 否决（§11 / 附录 D）。

本 ADR 完成 T1.0：在 **不降低** suite / prologue / fixed-vector 硬要求、**不将自研密码实现作为默认替代**、**不伪造用户路线 1/2 选择** 的前提下，给出唯一裁决：**`BLOCKED`**。

用户“完整版 V2.0 Gold / 持续闭环”指令 **只排除** “把 partial 当完成”；**不等于** 伪造路线 1/2 之间的具体选择，也 **不等于** 把技术兼容写成 Gold 选型通过。

---

## 2. 硬性验收标准与 gate 通过条件

### 2.1 技术兼容硬要求（H1–H9）

> 下列 H1–H9 仅覆盖 **协议/运行时/许可层面的技术兼容性**。
> **满足 H1–H9 ≠ gate 通过。** Gate 还必须满足 §2.2 全维度条件（含供应链风险可接受）。
> **技术兼容不得写成 Gold 选型通过。**

| ID | 维度 | 技术兼容硬要求 |
| --- | --- | --- |
| H1 | Pattern | **Noise IK**（token：`e,es,s,ss` / `e,ee,se`） |
| H2 | DH | **X25519 (25519)** |
| H3 | AEAD | **ChaCha20-Poly1305 (ChaChaPoly)** |
| H4 | Hash | **SHA-256**（精确 suite 名含 `SHA256`，**不是** BLAKE2b / BLAKE2s 的“可改名等价”） |
| H5 | Prologue | 支持应用层 **prologue** 注入 / handshake hash 绑定 |
| H6 | Fixed vectors | 可对齐 **noise-c / cacophony**（或仓库 frozen fixture）中 `Noise_IK_25519_ChaChaPoly_SHA256` 消息字节 |
| H7 | Runtime | **Node.js ESM** + **macOS** 可安装、可加载、可运行 |
| H8 | License | 与 Gold 兼容的开源许可（MIT / Apache-2.0 / ISC 等；无不明专有条款） |
| H9 | Suite 名 | 实现可使用精确协议名 `Noise_IK_25519_ChaChaPoly_SHA256` |

### 2.2 Gate 全维度通过条件（design §6.7.7 核验维度）

候选须 **同时** 满足下列全部维度，方可计为“通过”：

| 维度 | 通过要求 |
| --- | --- |
| **维护状态** | 可核验的近期维护/响应信号；非 abandoned 且出处可审计 |
| **许可证** | 与 Gold 兼容（与 H8 一致，但须有可核验出处） |
| **运行时** | Node.js ESM + macOS 可构建/可运行（与 H7 一致） |
| **精确套件与向量** | IK + X25519 + ChaChaPoly + SHA256 + prologue + fixed vectors（H1–H6、H9） |
| **审计 / 安全历史** | **必须核验并如实记录**；“无公开审计”本身是 **有效记录结论**（design 明示），**不**单独构成失败项。但审计缺失须与其它供应链事实 **综合** 评估 |
| **供应链风险** | 维护者集中度、install 脚本、传递依赖面、源码/构建 provenance 等 **综合可接受**（方法论见 §2.5） |

**通过公式（冻结 design）：**

```text
通过 ⇔ (存在 ≥1 候选满足全部硬需求) ∧ (该候选供应链风险可接受)
否则 → BLOCKED
```

### 2.3 “不满足即阻断”原则

1. **技术兼容硬要求不满足**（H1–H9 任一明确失败）→ 该候选 **拒绝**；**禁止** 用“条件通过”掩盖套件/ pattern 不匹配。对附录候选：**因单个硬要求失败即可拒绝；后续维度评估截断**——截断 **不得** 理解为其它维度已通过（见附录 A）。
2. **H1–H9 满足，但供应链风险不可接受** → 该候选 **不得** 计为通过；**禁止** 用技术兼容替代 gate 全维度。
3. **无任何候选同时满足“全部硬需求 + 供应链风险可接受”** → T1.0 裁决 **`BLOCKED`**；**禁止** 静默自研 Noise/KE/AEAD；**禁止** 降级 suite；**禁止** 未经完整安全审查 + **显式 spec 变更** 的 fixed-fixture 兼容层作为静默捷径。
4. **`registry tarball + integrity` 只能锁定收到的字节**；**不能** 补足公开源码 provenance、可复现构建与可核验维护历史；**不得** 作为 Gold / T1.0 通过依据。
5. **`npm audit` 0 vulnerabilities ≠ 密码学安全证明**；**OSV/GitHub Advisory 空结果 ≠ 无漏洞证明**；**一次向量字节匹配 ≠ 生产安全证明**；**未加载 / tree-shake 传递依赖 ≠ 消除供应链风险**。
6. 冻结 design **未** 授权 `PASS_WITH_HARD_CONDITIONS` 第三态；任何“有条件通过后引入生产 Noise 依赖”的表述 **无效**。
7. 本 gate **未过**：不得进入 M2 生产握手路径；不得将任何候选标为已选型通过；不得称 **M1 crypto PASS**。

### 2.4 证据分类标签（全文统一）

| 标签 | 含义 |
| --- | --- |
| **来源可证明** | 直接来自公开 README / npm registry 元数据 / 官方 GitHub raw 内容 / 规范文档 / 已检查 tarball 内容；可点 URL 或复现命令复核 |
| **本地 spike 实测** | 在当前环境执行的只读/临时目录实验；结果可复现（见 §9）；**不是**独立权威外部期望值 |
| **尚未证明** | 未获公开材料或未做本地验证；**不得**当作已满足 |

**日期说明：** 文中带 **“约”** 的日期均来自 **npm `time` 元数据** 或 **本地 spike 记录**，非独立时间权威；无法复核的时间点标为 **尚未证明**。

### 2.5 Supply-Chain Methodology（统一基线；A/B/C 同口径）

> 本节定义 **同一** 供应链/安全核验基线。候选 A/B/C **均按此基线记录**。
> 每个维度的结论必须标注 **已证明 / 尚未证明**；**禁止** 用生态活跃、下载量、单次 audit 空结果或 registry integrity **推导**“本包安全已证明”。

| 维度 ID | 核验项 | 能力边界（本 ADR 能/不能证明什么） | 记录要求 |
| --- | --- | --- | --- |
| SC-1 | **维护状态** | 可证：npm `time`、版本计数、公开 repository 上的可见更新信号。不能证：未来维护承诺、SLA、issue 响应 SLA（除非有公开材料） | 写清最近发布/修改时间；abandoned 需有证据或标 **尚未证明** |
| SC-2 | **源码 / provenance** | 可证：npm `repository`/`homepage` 字段、tarball 内文件列表、公开 git URL 可访问性。不能证：tarball 与 git tag 逐字节可复现构建（除非做了 reproducible build 对照） | 无 repository 元数据 → provenance **高风险缺口** |
| SC-3 | **可复现 / 发布出处** | 可证：`dist.tarball` + `dist.integrity`（锁定**收到的字节**）。不能证：构建环境、签名发布者身份链、mirror 与官方 registry 长期一致性策略 | integrity **仅** 字节锁；**≠** Gold 通过依据 |
| SC-4 | **install scripts** | 可证：package.json lifecycle（`preinstall`/`install`/`postinstall`/`prepare`/`prepublish*`）是否存在。不能证：运行时动态投毒、非 lifecycle 隐藏逻辑的完整 malware 逆向 | 有 lifecycle → 记录；未做逆向 → **尚未证明** 无恶意 |
| SC-5 | **直接 / 传递依赖面** | 可证：直接 `dependencies` 列表与其声明 license（npm view）。不能证：完整传递树、optional/peer 解析后的生产闭包（除非 `npm ls` 全树 + 许可证扫描） | 全树许可证未完成 → **重开 gate 前缺口** |
| SC-6 | **许可证** | 可证：包自身 license 字段 + 已查直接依赖 license。不能证：传递闭包无 copyleft/专有冲突（未全树时） | 包级与直接依赖分开记；缺口显式列出 |
| SC-7 | **公开安全政策 / 审计 / CVE** | 可证：SECURITY.md 存在性与内容性质、公开审计报告 URL、OSV/npm advisory 查询结果。不能证：无 CVE ≡ 安全；模板 SECURITY.md ≡ 有效响应流程；无审计 ≡ 失败（design：如实记录即可，须综合评估） | 无证据写 **尚未证明**；空 OSV 写“查询无已知条目”，**不得**写成安全证明 |
| SC-8 | **版本 / 维护者集中度** | 可证：versions 数量、maintainers 列表、单版本/单维护者事实。不能证：bus-factor 未来变化 | 单维护者+单版本 → 集中度高（事实） |
| SC-9 | **registry integrity** | 可证：`dist.integrity` / `shasum` 值本身。不能证：供应链投毒历史、typosquatting 防御、provenance 替代 | **明确能力边界**：只能钉字节 |

**综合判定规则：**

- 供应链“可接受”是 **综合判断**，不是任一单项的机械阈值。
- **禁止** 推论：`npm audit` 0 / OSV `{}` / 单次向量匹配 / registry integrity pin / 生态活跃 → 安全已证明。
- **禁止** 推论：无公开审计单独一项 → 自动失败（design 允许“无公开审计”作为有效记录，但须与 provenance/维护/依赖面等 **综合**）。

---

## 3. 主比较矩阵

> 主矩阵选出 **3 个最相关候选**（精确 suite 或最接近 IK+25519 生态）。其余候选见 **附录 A**。
> 符号：`✓` 满足 · `✗` 不满足 · `~` 部分/有条件 · `?` 未知/未证明
> **本矩阵保留为未来决策的有效输入**；总体结论见 §6：**技术兼容（仅 clatterjs）≠ gate 通过 ≠ Gold 选型**。
> **复核日：2026-07-17**（npm registry 元数据 + 官方 GitHub raw + noise-c cacophony + 临时目录 tarball 检查）。

### 3.1 主候选一览

| 维度 | **A. `@lukeburns/clatterjs@1.0.0`** | **B. `noise-protocol@3.0.2`** | **C. `@chainsafe/libp2p-noise@17.0.0`** |
| --- | --- | --- | --- |
| 许可证（包级） | MIT（npm） | ISC（npm + GitHub package.json） | Apache-2.0 OR MIT（npm） |
| 维护状态 | 单一维护者 `lukeburns`；**仅 1** 个版本 `1.0.0`；npm `time`：version 约 **2026-04-24**，created/modified 约 **2026-05-16**；**无** repository/homepage 元数据 | GitHub `emilbayes/noise-protocol`；npm `time.modified` 约 **2023-01-12**；README 标注 **BETA**；版本历史 10 个 | GitHub `ChainSafe/js-libp2p-noise`；npm `time`：v17.0.0 约 **2025-09-25**，package modified 约 **2026-04-21**；55 个版本；libp2p 生态活跃（**≠** 本包安全证明） |
| Node ESM / macOS | `"type":"module"` + exports；**本地 spike（历史记录）**：macOS + Node v24 可加载运行 | CommonJS（`main: index.js`，无 `type:module`）；ESM interop **尚未证明**（本 ADR 未做 ESM interop spike） | `"type":"module"` + exports；依赖 Noble / libp2p 组件 |
| IK | **✓** tarball `dist/noiseNq.js` 含 `HandshakePattern('IK', …)` token 序列 | **✓** README 支持 `IK` | **✗** 实现 **XX**（`protocolName: 'Noise_XX_25519_ChaChaPoly_SHA256'`） |
| X25519 | **✓** `dist/dhX25519.js` / `X25519_NAME = '25519'` | **✓**（suite 固定 25519） | **✓** |
| ChaChaPoly | **✓**（与 hash 可组合；历史 spike 路径） | **✓** | **✓**（XX suite） |
| SHA256 | **✓**（历史 spike 路径 + 可组合 hash） | **✗** README 明示仅 `Noise_*_25519_ChaChaPoly_BLAKE2b` | **✓**（XX suite 用 SHA256） |
| prologue | **✓** handshake 路径 `mixHash(config.prologue)` | **✓** README `initialize(..., prologue, ...)` | 支持 `prologueBytes`；与 Linke 冻结 prologue **字节对齐未证明**；且 pattern 非 IK |
| 精确 suite 名 | **✓** 可构造 `Noise_IK_25519_ChaChaPoly_SHA256` | **✗** 固定 `…_BLAKE2b` | **✗** `Noise_XX_…` 非 IK |
| Fixed vectors（IK+SHA256） | **msg1/msg2 密文字节：历史本地 spike 匹配 cacophony**（§5）；**handshake hash：无公开 expected → 仅本地 spike 输出** | **✗** 哈希原语不同 | **✗** pattern 非 IK |
| 公开审计 / 安全历史 | **尚未证明** 正式审计；OSV query 无已知条目（**≠** 安全证明） | **尚未证明** 正式审计；README **BETA**；`SECURITY.md` **404**；OSV 无已知条目（**≠** 安全证明） | 仓库存在 `SECURITY.md`，内容为 **GitHub 通用模板**（非项目专用响应承诺）→ 有效安全响应流程 **尚未证明**；本包正式审计 **尚未证明**；OSV 无已知条目（**≠** 安全证明）。libp2p 规范成熟 **不得** 推导本包作为 Linke **IK** 实现安全 |
| 供应链风险（§2.5 综合） | **高 / 不可接受**（§4.1.2） | 技术兼容已失败；供应链维度 **未** 因失败而“通过”；维护偏旧 + BETA + 无专用安全政策 → 额外风险信号（记录，非放行） | 技术兼容已失败；依赖面大 + 模板安全政策 → 额外风险信号（记录，非放行） |
| 技术兼容（H1–H9） | **满足**（在历史 spike + tarball 证据下） | **H4/H9 失败 → 拒绝** | **H1/H9 失败 → 拒绝** |
| **Gate 全维度** | **不通过**（供应链风险不可接受） | **不通过** | **不通过** |
| **Gold 选型** | **未选型** | **未选型** | **未选型** |

### 3.2 证据归属（主矩阵逐行）

| 断言 | 分类 | 直接来源 / 说明 |
| --- | --- | --- |
| clatterjs 许可 MIT、依赖 Noble 四件套、无 repository 元数据、type=module、单版本、maintainer | 来源可证明 | `npm view @lukeburns/clatterjs@1.0.0`（2026-07-17）；https://www.npmjs.com/package/@lukeburns/clatterjs |
| clatterjs integrity / tarball | 来源可证明 | `dist.integrity=sha512-b1uUTULv09SFJuAKKCz3+2pi5XqoyLeRCY5Xt8Ghrl8cEI6ab2gbGHB+upkQrrDx4cy8T00ShO5Sl43GQPbg3A==`；`https://registry.npmjs.org/@lukeburns/clatterjs/-/clatterjs-1.0.0.tgz` |
| clatterjs tarball 含 IK / X25519 / prologue 路径 | 来源可证明（发布 tarball 检查） | 临时目录 `npm pack` + 检查 `dist/noiseNq.js` / `dist/dhX25519.js` / `dist/nqHandshake.js` / `dist/protocolNames.js`（2026-07-17） |
| clatterjs cacophony msg1/msg2 匹配 | **本地 spike 实测**（历史记录，非本修订重跑） | 结果 JSON 见 §5；**不得**当作外部权威认证 |
| cacophony **无** 公开 expected handshake hash | 来源可证明 | https://github.com/rweather/noise-c/blob/master/tests/vector/cacophony.txt — 字段含 `messages[].ciphertext` 等；全文件 **无** `handshake_hash` / `handshakeHash` |
| clatterjs handshakeHash 值 | **本地 spike 输出，非独立权威值** | §5 明确标注；**未** 外部验证 |
| clatterjs 正式密码学审计 | **尚未证明** | 未找到公开审计报告 |
| noise-protocol suite=BLAKE2b、BETA、IK+prologue、ISC | 来源可证明 | https://github.com/emilbayes/noise-protocol/blob/master/README.md · https://www.npmjs.com/package/noise-protocol |
| noise-protocol SECURITY.md | 来源可证明（缺失） | `raw.githubusercontent.com/.../SECURITY.md` → **404**（2026-07-17） |
| libp2p-noise = XX；protocolName 硬编码 | 来源可证明 | tarball `dist/src/performHandshake.js`；https://github.com/ChainSafe/js-libp2p-noise |
| libp2p Noise 规范 XX | 来源可证明 | https://github.com/libp2p/specs/blob/master/noise/README.md |
| libp2p-noise SECURITY.md | 来源可证明（模板） | raw `SECURITY.md` 为 GitHub 通用模板文案（“intentionally generic…”） |
| OSV 对 A/B/C@指定版本 query 返回 `{}` | 来源可证明（查询结果） | `POST https://api.osv.dev/v1/query`（2026-07-17）；**≠** 安全证明 |
| 直接依赖 license（抽样） | 来源可证明 | `npm view <dep>@ver license`（§4.5） |
| 完整传递依赖许可证闭包 | **尚未证明** | 重开 gate 前缺口 |

---

## 4. 候选分项结论

### 4.1 `@lukeburns/clatterjs@1.0.0`（唯一技术兼容匹配；**gate 不通过**；**非 Gold 选型**）

#### 4.1.1 技术兼容证据（与供应链 **分开** 评价；保留供未来决策）

| 项 | 结论 | 证据类 |
| --- | --- | --- |
| Pattern IK + token 序列 | 满足 | 来源可证明（tarball `dist/noiseNq.js`）+ 历史向量路径一致 |
| X25519 / ChaChaPoly / SHA256 | 满足 | 来源可证明（tarball primitives，含 `dist/dhX25519.js`）+ 历史本地 spike |
| 精确协议名 | 满足 | 来源可证明（tarball `dist/protocolNames.js` 可组合） |
| prologue | 满足 | 来源可证明（tarball `dist/nqHandshake.js` mixHash prologue）+ 历史 spike 路径 |
| cacophony `Noise_IK_25519_ChaChaPoly_SHA256` **msg1/msg2 ciphertext** | **历史本地 spike：字节匹配** | **本地 spike 实测**（§5）；对照公开 ciphertext 字段 |
| cacophony **expected handshake hash** | **公开向量不提供** | 来源可证明（cacophony 无该字段） |
| 本 ADR 记载的 `handshakeHash` | **仅本地 spike 输出** | **非独立权威值**；**未** 外部验证 |
| 完整上游向量（含 transport 消息）是否在本 gate 覆盖 | **未覆盖** | cacophony 该 suite 含 **6** 条 messages（2 握手 + 4 transport）；本 gate 仅记录 msg1/msg2 历史匹配 → 重开 gate 须扩到完整 IK/transport vectors（§7.4） |
| 完整上游向量测试套是否打包进 npm | **发布包未见**完整向量测试树 | 来源可证明（tarball 文件列表导向）→ 向量覆盖 **依赖使用方 fixture** |
| 生产级互操作 / 长期 API 稳定 | **尚未证明** | 单版本、无可审计公开源码出处 |

**技术兼容小结：** 在已评估集合中，该包是 **唯一** 同时满足 H1–H9 的公开 npm 候选（基于 tarball 能力 + 历史 macOS/Node v24 spike）。
**这只证明“历史 spike 中握手 msg 密文字节与 noise-c cacophony 对齐”，不证明实现无侧信道、无逻辑漏洞、无供应链投毒，也不构成 gate 通过或 Gold 选型。**

#### 4.1.2 供应链 / 审计 / 维护（§2.5 同基线）→ **风险不可接受**

| SC | 风险项 | 事实（2026-07-17） | 证据类 | 状态 |
| --- | --- | --- | --- | --- |
| SC-1 | 维护状态 | 仅 `1.0.0`；npm 时间约 2026-04/05；无公开仓则无法核验后续提交/issue 响应 | 来源可证明 / 尚未证明 | 维护历史 **不可充分核验** |
| SC-2 | 源码 / provenance | npm **无** `repository`/`homepage`；**未找到** 可审计公开源码仓 | 来源可证明 | **高缺口** |
| SC-3 | 可复现 / 发布出处 | 有 `dist.integrity`（可钉字节）；**未** 做 git↔tarball 可复现构建对照 | 来源可证明 / 尚未证明 | integrity **≠** provenance |
| SC-4 | install scripts | 发布 package.json **无** preinstall/install/postinstall/prepare；有 build/test scripts | 来源可证明 | 无 lifecycle install；完整 malware 逆向 **尚未证明** |
| SC-5 | 依赖面 | 直接依赖 4：`@noble/ciphers@^2.2.0`、`@noble/curves@^2.2.0`、`@noble/hashes@^2.2.0`、`@noble/post-quantum@^0.6.1` | 来源可证明 | 含 **非 Linke 所需** PQ 面 |
| SC-6 | 许可证 | 包 MIT；直接 Noble 四件均为 MIT（npm view） | 来源可证明 | 传递全树 **尚未证明** |
| SC-7 | 审计 / CVE / 安全政策 | 正式审计 **未找到**；无公开 SECURITY；OSV `{}` | 尚未证明 / 查询空 | **不得** 写成安全通过 |
| SC-8 | 维护者集中度 | 单一 maintainer；单版本 | 来源可证明 | **高** |
| SC-9 | registry integrity | integrity 已知 | 来源可证明 | **仅** 字节锁 |

**综合供应链结论（gate 维度）：**

- **无公开审计** 本身是 design 允许的有效记录，**不是** 单独失败项。
- 结合：**无可审计源码/provenance、维护历史不可充分核验、单维护者、单版本、传递依赖面（含 `@noble/post-quantum`）、无公开正式审计** → 本候选 **剩余供应链风险为高 / 不可接受**。
- **不是** 因为“必须有 GitHub 仓库”这一冻结规范中不存在的绝对规则；而是：本候选缺少可审计源码/provenance，使维护状态与构建出处不能充分核验；在 **本次证据水平** 下风险不可接受。未来若出现 **等效可信来源 / 独立审查 / 可复现材料**，可重新评估。
- **`@noble/post-quantum`：** Linke V2.0 **不需要** PQ KE；扩大攻击面与审计范围。**未加载 / tree-shake 不等于消除供应链风险**；当前 **未处置**。
- 因此：**技术兼容 ✓ · gate 全维度 ✗ · 不得引入 · 非 Gold 选型**。

### 4.2 `noise-protocol@3.0.2` — **拒绝**（技术兼容硬失败）

| 项 | 结论 | 证据类 |
| --- | --- | --- |
| 许可 ISC | 包级可接受 | 来源可证明 |
| IK + prologue | 文档支持 | 来源可证明（README） |
| Hash | **BLAKE2b**，非 SHA256 | 来源可证明（README 明示仅 `Noise_*_25519_ChaChaPoly_BLAKE2b`） |
| BETA | 标注 BETA | 来源可证明 |
| 维护 | npm `time.modified` 约 **2023-01-12**；repository 公开 | 来源可证明 |
| install scripts | 无 install lifecycle（test 相关 scripts 有） | 来源可证明 |
| 安全政策 / 审计 / CVE | `SECURITY.md` **404**；正式审计 **尚未证明**；OSV `{}`（**≠** 安全证明）；**不得** 由“有 GitHub / 曾有提交”推导本包安全 | 来源可证明 / 尚未证明 |
| 直接依赖 license | `clone` MIT、`hmac-blake2b` ISC、`nanoassert` ISC、`sodium-universal` MIT | 来源可证明（直接）；全树 **尚未证明** |

**拒绝理由（技术兼容硬要求）：** H4/H9 失败。改用 BLAKE2b 等于 **变更冻结 suite**，必须走 design 变更控制，**不得** 用条件通过掩盖。
**供应链维度：** 因硬要求已失败，**不** 再将本包评为“供应链可接受”；§2.5 记录的安全/维护信号供未来若修订 suite 时参考，**不是** 当前放行。

### 4.3 `@chainsafe/libp2p-noise@17.0.0` — **拒绝**（技术兼容硬失败）

| 项 | 结论 | 证据类 |
| --- | --- | --- |
| 许可 Apache-2.0 OR MIT | 包级可接受 | 来源可证明 |
| 套件 | `Noise_XX_25519_ChaChaPoly_SHA256` | 来源可证明（tarball `dist/src/performHandshake.js`） |
| IK | libp2p Noise 规范为 XX；本实现硬编码 XX | 来源可证明 |
| 依赖面 | Noble + 多个 `@libp2p/*` + `@chainsafe/*` 等 | 来源可证明 |
| install / lifecycle | 存在 `prepublish: npm run build`（发布生命周期相关）；完整 install 时行为需注意；malware 逆向 **尚未证明** | 来源可证明 / 尚未证明 |
| 安全政策 / 审计 / CVE | 仓库 `SECURITY.md` 为 **通用模板**，专用漏洞响应承诺 **尚未证明**；正式审计 **尚未证明**；OSV `{}`（**≠** 安全证明）；**不得** 由 libp2p 生态活跃推导本包作为 Linke IK 实现的安全 | 来源可证明 / 尚未证明 |
| 直接依赖 license（抽样） | `@noble/*` MIT；`@chainsafe/as-chacha20poly1305` Apache-2.0；`@chainsafe/as-sha256` Apache-2.0；其余 `@libp2p/*` 等全树 **尚未证明** | 部分来源可证明 / 部分尚未证明 |

**拒绝理由（技术兼容硬要求）：** H1/H9 失败（XX ≠ IK）。**不得** 将 XX 实现“适配成 IK”而不变成另一份实现/规范分叉。
**供应链维度：** 硬失败后截断“可接受”结论；安全政策/审计记录见上，**不是** 放行依据。

### 4.4 附录候选（非主矩阵）

见 **附录 A**：`@niomon/noise-js@2.0.1`、`salty-crypto@1.0.0-rc.4`。二者均在硬 AEAD 或 Hash 上失败并 **截断** 后续维度，**拒绝**。截断 **≠** 其它维度通过。

### 4.5 直接依赖许可证抽样（2026-07-17；非全树）

| 包 | 版本（解析目标） | license（npm） | 证据类 |
| --- | --- | --- | --- |
| `@noble/ciphers` | 2.2.0 | MIT | 来源可证明 |
| `@noble/curves` | 2.2.0 | MIT | 来源可证明 |
| `@noble/hashes` | 2.2.0 | MIT | 来源可证明 |
| `@noble/post-quantum` | 0.6.1 | MIT | 来源可证明 |
| `clone` | 2.1.2 | MIT | 来源可证明 |
| `hmac-blake2b` | 2.0.2 | ISC | 来源可证明 |
| `nanoassert` | 2.0.0 | ISC | 来源可证明 |
| `sodium-universal` | 4.0.0 | MIT | 来源可证明 |
| `tweetnacl` | 1.0.1 | Unlicense | 来源可证明 |
| `@chainsafe/as-chacha20poly1305` | 0.1.0 | Apache-2.0 | 来源可证明 |
| `@chainsafe/as-sha256` | 1.2.0 | Apache-2.0 | 来源可证明 |

**缺口（重开 gate 前必须补）：** 任一拟引入候选的 **完整生产传递依赖树** 许可证扫描与 SPDX 兼容结论；当前 **不得** 宣称“许可证已全部完成”。

---

## 5. 固定向量证据边界（诚实记录）

### 5.1 公开向量源（来源可证明）

**向量源：** noise-c 官方 `cacophony.txt` 中条目 `Noise_IK_25519_ChaChaPoly_SHA256`：
https://github.com/rweather/noise-c/blob/master/tests/vector/cacophony.txt
（raw：https://raw.githubusercontent.com/rweather/noise-c/master/tests/vector/cacophony.txt）

**公开字段（该 suite，2026-07-17 复核）：**
`name`, `pattern`, `dh`, `cipher`, `hash`, `init_prologue`, `init_static`, `init_ephemeral`, `init_remote_static`, `resp_prologue`, `resp_static`, `resp_ephemeral`, `messages[]`（每条含 `payload` + `ciphertext`）。

**公开字段中不存在：** `handshake_hash` / `handshakeHash` / 等价“期望握手哈希”字段。
**全文件检索：** cacophony.txt **无** `handshake_hash` / `handshakeHash` 字符串。

因此：**noise-c cacophony 提供可直接对照的 expected handshake message ciphertext，但不提供可直接对照的 expected handshake hash。**

该 suite 的 `messages` **共 6 条**（握手 msg1/msg2 + 后续 transport）。本 gate **未** 声明对全部 6 条完成匹配。

### 5.2 历史本地 spike 摘要（非本修订重跑）

**环境（本地 spike 实测记录）：** macOS + Node **v24** + ESM；包 `@lukeburns/clatterjs@1.0.0`。
**范围：** 对照 cacophony **msg1/msg2 ciphertext** 字节。

```json
{
  "suite": "Noise_IK_25519_ChaChaPoly_SHA256",
  "msg1Matches": true,
  "msg2Matches": true,
  "handshakeHash": "0b0f68fb0c27e03ce9b97565995ed4838cc0581b762ef72b062f6a546419fad7",
  "handshakeHashStatus": "LOCAL_SPIKE_OUTPUT_ONLY_NOT_INDEPENDENTLY_AUTHORITATIVE",
  "publicExpectedHandshakeHashInCacophony": false,
  "transportVectorsCovered": false,
  "package": "@lukeburns/clatterjs@1.0.0",
  "evidenceClass": "local-spike-historical"
}
```

| 字段 | 含义 | 权威性 |
| --- | --- | --- |
| `msg1Matches` / `msg2Matches` | 历史 spike 声称与 cacophony **公开 ciphertext** 一致 | 本地实测记录；可按 §9 复现；**本修订未重跑** |
| `handshakeHash` | spike 实现导出的握手哈希 hex | **仅本地输出**；cacophony **无** 对应 expected 可对照 → **不得** 写成“已通过外部向量验证的 hash” |
| transport | 未覆盖 | 重开 gate 前缺口（§7.4） |

### 5.3 明确不成立的推论（禁止写入发布说明 / 禁止当作 gate 通过）

- ✗ “向量通过 ⇒ 生产安全”
- ✗ “向量通过 + H1–H9 ⇒ T1.0 通过 / M1 crypto PASS / Gold 选型通过”
- ✗ “`npm audit` 0 / OSV 空 ⇒ 无密码学缺陷”
- ✗ “npm 包存在 ⇒ 有公开审计 / 有可信维护历史”
- ✗ “registry integrity pin ⇒ 可接受供应链 provenance”
- ✗ “未加载 / tree-shake `@noble/post-quantum` ⇒ 供应链风险已消除”
- ✗ “handshakeHash 有值 ⇒ 已被 noise-c 官方期望值验证”
- ✗ “msg1/msg2 匹配 ⇒ 完整 IK+transport 向量已覆盖”

---

## 6. T1.0 唯一裁决

### 6.1 裁决

```text
T1.0 VERDICT = BLOCKED
M1 (crypto / production Noise path) = BLOCKED
7-DAY CLOCK:
  day 0     = 2026-07-16 (Asia/Shanghai calendar day)
  deadline  = 2026-07-23 23:59 Asia/Shanghai
USER ROUTE CHOICE = NOT YET SELECTED  → remains BLOCKED
OVERDUE WITHOUT CHOICE → still BLOCKED
  (no auto-pause V2.0; no default route; no silent shortcut)
```

| 字段 | 值 |
| --- | --- |
| **唯一裁决** | **`BLOCKED`** |
| **是否引入任何 Noise 实现库** | **否** — 含 clatterjs；**禁止** 合入生产 Noise/crypto 依赖 |
| **技术兼容唯一匹配（非选型）** | `@lukeburns/clatterjs@1.0.0` **仅** 作为已评估证据中的技术兼容候选记录；**不是** 已通过选型；**不是** Gold 选型通过 |
| **自研默认** | **否** — 自研 Noise **不是** 本 ADR 默认路径 |
| **suite 降级** | **否** — 仍冻结 `Noise_IK_25519_ChaChaPoly_SHA256` |
| **用户书面三选一** | **尚未选择**；截止 **2026-07-23 23:59 Asia/Shanghai**；逾期仍 BLOCKED；**不** 自动暂停 V2.0；**不** 默认选路线 1/2/3 |
| **用户完整 Gold 指令含义** | 排除“把 partial 当完成”；**不** 授权伪造路线选择或伪造 T1.0 PASS |

### 6.2 为何不是 `通过`（design §6.7.7）

通过条件要求：**至少一个候选满足全部硬需求 且 供应链风险可接受**。

- clatterjs：**H1–H9 满足**，但本 ADR **自行判定** 其剩余供应链风险为 **高 / 不可接受**（无公开源码出处、单维护者、单版本、无可核验维护历史、无公开正式审计 + 传递依赖面）。
- 其它候选：技术兼容硬要求失败。
- 因此 **不存在** 满足“硬需求 + 供应链可接受”的候选 → **不得** 判通过。

### 6.3 为何不是（已否决的）`PASS_WITH_HARD_CONDITIONS`

1. Design §6.7.7 **只** 定义“通过”与“失败/M1 BLOCKED”；**未授权** 第三态。
2. 原草案在承认供应链风险高的同时判“条件通过”，与冻结通过公式 **自相矛盾**。
3. 原草案把 `registry tarball + integrity` 当作可执行缓解并据此放行 M1 引入，**错误**：integrity 只能锁定字节，**不能** 补足 provenance / 可复现构建 / 可核验维护历史，**不能** 作为 Gold 通过依据。
4. 因此原草案第三态 **一次性否决**；全文统一为 **`BLOCKED`**（见 §11）。

### 6.4 与 design §6.7.7 与 plan T1.0 的符合性

| 要求 | 符合性 |
| --- | --- |
| 评估 2–3 公开候选 + 核维矩阵 | **符合**（主 3 + 附录 2） |
| 硬 suite 不降级 | **符合** |
| 禁止静默自研 | **符合** |
| 产出 ADR + 证据表 | **符合**（本文） |
| 通过后方可引入依赖 | **符合**：当前 **未通过** → **不得** 引入 |
| fixed-fixture 非静默捷径 | **符合**：BLOCKED 后仍须审查 + **spec 变更**，禁止静默 |
| 无候选通过 → BLOCKED | **适用且已裁决** |
| BLOCKED 后 7 日 PM+用户三选一 | **已启动**；day0 **2026-07-16**；截止 **2026-07-23 23:59 Asia/Shanghai**（§8） |
| 逾期 | **仍 BLOCKED**；**不** 自动暂停；**不** 默认捷径（否决 GLM“逾期自动暂停”） |
| P0-9 / P0-12 前置 | **未满足**：gate 未过 → 不得宣称 crypto 实现就绪；不得进入 M2 生产握手路径 |
| 仅两种 gate 结果 | **符合**（无第三态） |

### 6.5 Gate 未过时的工程边界与 downstream labeling 纪律

| 范围 | 允许 | 禁止 / 强制标签 |
| --- | --- | --- |
| **T1.0 本身** | 本 ADR 书面 **BLOCKED** 记录 | 宣称通过 / 条件通过 / 已选型 / M1 crypto PASS |
| **M1 非 crypto 骨架** | **无 crypto 依赖** 的纯契约 / 错误码 / 消息 schema / 状态机常量与单测骨架（不加载 Noise 实现库） | **任何** 非 crypto scaffold 工作 **必须** 明确标注 **`T1.0 BLOCKED`**；**不得** 称 **M1 crypto PASS**；**不得** 暗示 library gate 已过 |
| **M1 生产 Noise/crypto** | **无** | 引入 clatterjs 或其它库；实现生产握手；宣称 Noise 实现就绪 |
| **M2 生产握手路径** | **无**（design：gate 未过不得进入） | 合入生产握手依赖或路径 |
| **T1.12 fixed vectors（实现路径）** | 仅可准备 **无实现依赖** 的 fixture 契约规划；**不得** 绑定未通过库 | 依赖 T1.0 通过后的实现路径宣称就绪 |
| **fixed-fixture 兼容层** | 仅当走 §8 路线 2（修订协议/spec）+ 完整安全审查 | 作为 T1.0 失败静默捷径 |
| **CI lint / 源码 / 测试实现** | **不在本 ADR 范围**；本 ADR **只记录要求**，**不写代码** | 不得在本任务添加 CI/源码/测试实现（后续 **T1.1+**） |

**Labeling 强制句式（示例，用于后续 PR/提交说明）：**

```text
[status] T1.0 Noise library gate = BLOCKED (not M1 crypto PASS)
[scope] non-crypto protocol scaffold only; no Noise implementation dependency
```

---

## 7. 重新开 gate 所需的最低缓解证据（非当前授权）

> **本节不是当前引入授权。**
> 仅在 **用户通过 §8 书面决策** 选择路线 1 或路线 2 之后，用于 **重新开 gate**。
> **在用户书面选择完成前：不得** 依据本节引入 clatterjs 或任何生产 Noise 依赖。

### 7.1 适用于“替代合规库”（路线 1）

重新评估候选必须 **完整** 通过 §2.1 + §2.2 + §2.5 同一矩阵，并至少提供：

1. 可核验的维护状态与 **可审计源码/provenance**（或 design 认可的等效可信来源）。
2. 许可证、运行时、精确套件与 fixed vectors 证据。
3. 审计/安全历史 **如实记录** 与综合供应链风险判断为 **可接受**。
4. **完整** 传递依赖树审查与许可证结论（**含** 任何 PQ / 非必要密码依赖本身；不得以 tree-shake 宣称已消除风险）。
5. 单独依赖变更控制 + 精确版本 pin（若届时仍使用 registry，integrity 仅为字节锁，**附加于** provenance，而非替代）。

### 7.2 适用于“修订协议 / 风险例外”（路线 2）

若用户书面选择修订协议/spec，并意图在变更控制下考虑原 clatterjs 路径或其它例外：

1. **必须** 先完成 design §6.7 / §6.7.7 **spec 变更控制**；**本 ADR 不得自行批准** 风险例外。
2. 变更控制批准后，重新开 gate 时最低缓解证据应覆盖（可随 spec 修订调整，但不得低于安全审查要求）：
   - 可审计源码出处 **或** 经书面批准的等效 provenance / 独立审查材料；
   - 独立安全复核（与实现者分离），含 handshake 状态机、prologue 绑定、fail-closed、向量回归；
   - 传递依赖审查（**必须** 审查 `@noble/post-quantum` 等传递依赖本身；未加载 ≠ 已处置）；
   - 精确版本 + integrity（仅作字节锁）+ 变更/停止条件；
   - 明确 **禁止** 用 npm audit / OSV 空 / 单次向量通过替代安全结论。
3. fixed-fixture 兼容层路径：**完整安全审查 + 显式 spec 变更** 后才可；**禁止** 静默捷径。

### 7.3 明确未授权事项（当前）

- **不得** 引入 `@lukeburns/clatterjs@1.0.0` 或任何 Noise 实现库。
- **不得** 将 registry tarball + integrity 当作当前通过依据。
- **不得** 将本节当作 M1/M2 crypto 绿灯。
- **`@noble/post-quantum`：当前未处置**；未来重评必须纳入，不得声称已消除。

### 7.4 重开 gate：向量覆盖扩展（强制记录）

重开 gate（路线 1 或路线 2 批准后的实现路径）时，固定向量覆盖须 **至少** 扩展到：

1. cacophony（或仓库 frozen fixture）中 `Noise_IK_25519_ChaChaPoly_SHA256` 的 **完整 messages 列表**（含 handshake **与** transport）；
2. 若声称 handshake hash 断言：必须提供 **独立权威 expected**（上游公开字段或仓库 frozen 并经审查的 fixture），**禁止** 仅用实现自导出 hash 自我证明；
3. 负向：乱序 token / 错误 prologue / suite 降级拒绝。

### 7.5 Gold runtime baseline 记录

| 项 | 状态 |
| --- | --- |
| `package.json` `engines` | **未声明**（2026-07-17 查证） |
| plan Tech Stack | “Node.js ESM …”（**无** 冻结 Node LTS 版本号） |
| design §6.7.7 | 要求 Node.js ESM + macOS 可运行；**无** 具体 LTS pin |
| README G0a 真实验收 | 记录 Controller/PM 观测：Node major `24`、macOS major `26`（**G0a 验收观测**，Endpoint 未独立记录） |
| **V2.0 Gold 运行时 baseline** | **尚未冻结** 为正式 engines/LTS 门禁 |

**纪律：** 本 ADR **不得擅自规定** Node LTS。历史 spike 使用 Node v24 仅作 spike 环境记录。重开 gate / 引入依赖前应由 PM+实现阶段 **显式冻结** Gold runtime baseline。

### 7.6 重开 gate 前未验证缺口清单（汇总）

| ID | 缺口 | 状态 |
| --- | --- | --- |
| G-1 | 任一候选完整传递依赖树 + 许可证闭包 | **尚未证明** |
| G-2 | clatterjs（或替代库）可审计源码 provenance / 可复现构建 | **尚未证明**（clatterjs） |
| G-3 | 正式密码学审计或经批准的等效独立审查 | **尚未证明** |
| G-4 | 完整 IK + transport 向量覆盖 + 权威 handshake hash（若使用） | **尚未证明** / 部分历史 spike 仅 msg1/msg2 |
| G-5 | Gold runtime baseline（Node engines/LTS）正式冻结 | **尚未冻结** |
| G-6 | install/lifecycle 与 tarball 的完整安全逆向 | **尚未证明** |
| G-7 | 用户书面路线 1/2/3 选择 | **尚未选择** |

---

## 8. BLOCKED 后 7 日三选一（design §6.7.7）

### 8.1 时钟与逾期语义（冻结口径）

| 项 | 值 |
| --- | --- |
| **day 0** | **2026-07-16**（T1.0 正式 BLOCKED 的日历日，Asia/Shanghai） |
| **截止** | **2026-07-23 23:59 Asia/Shanghai**（7 个自然日窗口末端） |
| **决策人** | **PM + 用户** 书面裁决（可并列记录否决项） |
| **当前** | **用户尚未选择** → 状态持续 **`BLOCKED`** |
| **逾期未选择** | M1 **仍保持 BLOCKED**；**不得** 默认选用任何捷径；**不得** 自动执行“暂停 V2.0”；**不得** 自动选路线 1/2/3 |
| **否决** | GLM 主张“逾期自动暂停 V2.0” — **不采用**（与冻结 design“逾期未裁决 → M1 保持 BLOCKED，不得默认捷径”一致；暂停是路线 3 的 **显式书面选择**，不是逾期副作用） |

### 8.2 三选一内容

| 路线 | 内容 | 允许继续？ |
| --- | --- | --- |
| **1. 替代合规库** | 重新评估候选并通过 **同一** 核验矩阵（§2.1 + §2.2 + §2.5） | 是（新 ADR 或修订本 ADR 为通过后，方可依赖变更控制引入） |
| **2. 修订协议** | 先修订 design/spec 变更控制，再重开 M1。**若要批准 clatterjs 风险例外，也必须走本路径**；**禁止** 在本 ADR 内自行批准 | 仅在 spec 变更控制完成后 |
| **3. 暂停 V2.0** | 暂停 cross-LAN/Gold 推进直至条件满足 | 否（M1 crypto / 跨 LAN Gold 路径停止）— **须书面选择**，非逾期自动 |

### 8.3 Route Decision pending 模板（供 PM+用户填写；当前未填）

```text
================================================================
Linke V2.0 Gold — T1.0 Noise Library Gate — Route Decision
================================================================
ADR: docs/superpowers/specs/2026-07-16-linke-v2-m1-noise-library-selection-adr.md
Gate status at decision time: BLOCKED (immutable unless this decision reopens process)
day 0: 2026-07-16
deadline: 2026-07-23 23:59 Asia/Shanghai
Decision timestamp (Asia/Shanghai): ____________________
Decision makers (PM + User): ____________________

SELECTED ROUTE (exactly one):
  [ ] 1 — Alternate compliant library (re-evaluate under same matrix)
  [ ] 2 — Revise protocol/spec under change control, then reopen M1
  [ ] 3 — Pause V2.0 cross-LAN/Gold until conditions met

If Route 1: candidate id/name/version under evaluation: ____________________
If Route 2: spec change ticket/ref: ____________________
If Route 3: resume conditions: ____________________

Explicit non-defaults acknowledged:
  [ ] No silent self-implementation of Noise/KE/AEAD
  [ ] No suite downgrade without spec change
  [ ] No silent fixed-fixture shortcut
  [ ] Overdue without this form ⇒ remains BLOCKED (no auto-pause, no default route)

Signatures / written ack:
  PM: ____________________
  User: ____________________
================================================================
STATUS OF THIS TEMPLATE IN REPO: PENDING — NOT FILLED
USER CHOICE: NOT YET SELECTED
================================================================
```

### 8.4 BLOCKED 期间硬禁止

- 继续 M1 **生产** Noise 握手实现代码路径；
- 引入 clatterjs 或其它未通过库；
- 静默 fixed-fixture 顶替；
- 静默自研 Noise/KE/AEAD；
- 降级 suite / 改用未冻结 pattern；
- 进入 M2 生产握手路径；
- 将“纯契约骨架可做”解释为 T1.0 通过、M1 crypto PASS 或 crypto 可继续；
- 伪造用户已在路线 1/2 间作出选择。

---

## 9. 证据复现（只读 / 临时目录思路）

> **纪律：** 不在仓库新增脚本；不在项目目录安装依赖；不读取 `.env` / credentials / SSH；不输出任何 secret；**不修改** `package-lock.json` / `package.json` / `src/**` / `test/**`。
> 以下为 **可复现命令骨架**；路径与包内容以执行时 registry 为准。
> 修订-2 已对 npm 元数据、cacophony 字段、GitHub raw README/SECURITY、OSV query、tarball 关键内容做了 **2026-07-17** 复核；**未** 在本修订中重跑完整握手向量 spike。

### 9.1 只读核验 npm 元数据

```bash
# 优先官方 registry（避免 mirror 混淆）
npm view @lukeburns/clatterjs@1.0.0 --registry https://registry.npmjs.org/ \
  name version license repository homepage engines type maintainers \
  dependencies time dist.tarball dist.integrity dist.shasum
npm view noise-protocol@3.0.2 --registry https://registry.npmjs.org/ \
  name version license repository homepage dependencies time dist.integrity
npm view @chainsafe/libp2p-noise@17.0.0 --registry https://registry.npmjs.org/ \
  name version license repository homepage dependencies time dist.integrity
npm view @niomon/noise-js@2.0.1 --registry https://registry.npmjs.org/ name version license repository
npm view salty-crypto@1.0.0-rc.4 --registry https://registry.npmjs.org/ name version license repository
```

### 9.2 临时目录 tarball 检查 + audit（非密码学审计）

```bash
TMP="$(mktemp -d)"
cd "$TMP"
npm pack @lukeburns/clatterjs@1.0.0 --registry https://registry.npmjs.org/
# 记录 tarball 文件名与 shasum -a 512；对照 dist.integrity
tar tzf lukeburns-clatterjs-1.0.0.tgz | head
tar xzf lukeburns-clatterjs-1.0.0.tgz package/package.json
# 检查 lifecycle scripts；grep IK / prologue / protocol name builder
mkdir app && cd app
npm init -y
npm install ../lukeburns-clatterjs-1.0.0.tgz --ignore-scripts
npm audit --production   # 仅已知 CVE 扫描；≠ 密码学审计
# 完成后: rm -rf "$TMP"
```

### 9.3 cacophony 向量对照（思路 + 证据边界）

```text
1. 只读获取 noise-c tests/vector/cacophony.txt 中
   Noise_IK_25519_ChaChaPoly_SHA256 段
2. 确认公开字段：messages[].ciphertext 可对照；
   确认不存在 handshake_hash 期望字段
3. 在临时 ESM 脚本中调用候选库按 Noise 规范跑 IK handshake
4. 比较 msg1、msg2 密文字节与向量
5. 若打印 handshakeHash：标注为 LOCAL SPIKE OUTPUT ONLY
6. 扩展：对 messages[2..] transport 同样对照（重开 gate 要求）
7. 删除临时目录
```

**向量源 URL：**
https://github.com/rweather/noise-c/blob/master/tests/vector/cacophony.txt

### 9.4 OSV 查询（空结果 ≠ 安全证明）

```bash
curl -sS -X POST https://api.osv.dev/v1/query \
  -H 'Content-Type: application/json' \
  -d '{"package":{"name":"@lukeburns/clatterjs","ecosystem":"npm"},"version":"1.0.0"}'
# 同理 noise-protocol@3.0.2 、 @chainsafe/libp2p-noise@17.0.0
```

### 9.5 直接来源 URL 清单（复核用）

| 对象 | URL |
| --- | --- |
| clatterjs npm | https://www.npmjs.com/package/@lukeburns/clatterjs |
| clatterjs tarball | https://registry.npmjs.org/@lukeburns/clatterjs/-/clatterjs-1.0.0.tgz |
| noise-protocol GitHub | https://github.com/emilbayes/noise-protocol |
| noise-protocol README (raw) | https://raw.githubusercontent.com/emilbayes/noise-protocol/master/README.md |
| noise-protocol npm | https://www.npmjs.com/package/noise-protocol |
| @niomon/noise-js npm | https://www.npmjs.com/package/@niomon/noise-js |
| salty-crypto npm | https://www.npmjs.com/package/salty-crypto |
| js-libp2p-noise | https://github.com/ChainSafe/js-libp2p-noise |
| js-libp2p-noise SECURITY (raw) | https://raw.githubusercontent.com/ChainSafe/js-libp2p-noise/master/SECURITY.md |
| libp2p Noise spec | https://github.com/libp2p/specs/blob/master/noise/README.md |
| noise-c cacophony vectors | https://github.com/rweather/noise-c/blob/master/tests/vector/cacophony.txt |
| OSV API | https://api.osv.dev/v1/query |

---

## 10. 推荐决定（务实 / 保守 / 可审计）

1. **T1.0 记录为 `BLOCKED`**；7 日时钟已自 **2026-07-16** 运行；截止 **2026-07-23 23:59 Asia/Shanghai**。
2. **不得** 引入 clatterjs；**不得** 开始依赖该库的生产 Noise/crypto 实现；**不得** 进入 M2 生产握手路径。
3. **保留** 候选矩阵与 clatterjs 技术兼容证据，作为路线 1/2 的输入；总体结论固定为 **“技术兼容、gate 不通过、非 Gold 选型”**。
4. **立即拒绝** 将 BLAKE2b / AESGCM / XX-only / RC-only-SHA256-TODO 库当作可静默替代。
5. **不虚构** 公开审计、git 仓库、长期维护历史、“第三态通过”、或用户已选路线。
6. **可选并行（非 crypto）：** 在 **不引入** Noise 实现库的前提下，推进错误码 / 消息 schema / 状态机常量等纯契约骨架——**且必须** 标注 **`T1.0 BLOCKED`**，**不得** 声称 T1.0 通过或 M1 crypto PASS。
7. **下一步决策（用户）：** 于截止前书面选择 §8 三选一之一（可用 §8.3 模板）；逾期仍 BLOCKED，不自动暂停、不默认选路线。
8. **CI lint / 实现代码：** 属 **T1.1+**；本 ADR 只记录要求，不提交代码。

---

## 11. 修订记录

### 11.1 修订-1（2026-07-16）— 否决第三态

| 原草案主张 | 否决理由 |
| --- | --- |
| 状态 `PASS_WITH_HARD_CONDITIONS` | Design §6.7.7 仅“通过 / 失败·BLOCKED”；无第三态授权 |
| 在供应链风险自评为高时仍“条件通过”并允许 pin 后引入 | 与通过公式“硬需求 **且** 供应链可接受”矛盾 |
| `registry tarball + integrity` 作为出处锚点支撑通过 | 仅锁字节，不能补足 provenance / 可复现构建 / 可核验维护历史 |
| §7 写成当前可执行的合入授权清单 | 越权；改为“用户书面决策后重开 gate 的最低缓解证据” |
| 7 日流程仅作“未来停止条件触发后预置” | 当前即应 BLOCKED 并 **立即** 启动 7 日时钟 |

### 11.2 修订-2（2026-07-17）— PM findings 闭环

| ID | Finding | 处理 |
| --- | --- | --- |
| 1 | Supply-Chain Methodology 统一基线 | **接受** → §2.5；A/B/C 同口径；已证明/尚未证明 |
| 2 | 2026-07-17 一手复核 A/B/C/附录 | **接受** → npm registry、GitHub raw、cacophony、tarball、OSV |
| 3 | clatterjs 向量 / cacophony expected hash | **接受** → §5：无公开 expected hash；hash 标本地 spike；msg 仅历史 spike |
| 4 | B/C audit/security/CVE/维护响应 | **接受** → 无证据写尚未证明；不由生态活跃推导 |
| 5 | 7 日口径 + Route Decision 模板 | **接受** → day0/截止 Asia/Shanghai；逾期仍 BLOCKED；否决自动暂停 |
| 6 | downstream labeling | **接受** → §6.5 强制 `T1.0 BLOCKED`；CI 属 T1.1+ |
| 7 | 附录硬失败截断纪律 | **接受** → 附录 A 明示截断 ≠ 其它维度通过 |
| 8 | 完整向量 + Gold runtime baseline | **接受** → §7.4/§7.5；baseline **尚未冻结** |
| 9 | 传递依赖许可证 | **接受** → §4.5 抽样 + G-1 缺口 |
| 10 | scope / package-lock 边界 | **接受** → 页眉范围；不改 lock；path-specific `git add` only（见 R-02） |
| — | 不采用逾期自动暂停 | **接受**（与 design 一致） |
| — | 不添加 CI/源码/测试 | **接受** |
| — | 不把 integrity/audit/单次向量当安全证明 | **接受** |
| — | 不改为 PASS_WITH_HARD_CONDITIONS | **接受**；裁决仍唯一 `BLOCKED` |
| R-01 | Git 授权 vs 路线/依赖授权混写 | **接受** → 附录 B 拆分；Git auto commit/push（2026-07-17 Gold 持续目标）≠ 路线/依赖/spec 授权 |
| R-02 | package-lock 排除非 git 自动屏障 | **接受** → 仅允许 path-specific `git add -- <本 ADR>`；禁止 `git add .` / `-A` |
| R-04 | tarball 路径缺 `dist/` | **接受** → clatterjs 路径写 `dist/noiseNq.js` 等 |

### 11.3 Qwen 审查意见处理结果（修订-1 继承）

| ID | 意见要点 | 处理 |
| --- | --- | --- |
| **P0** | 不得使用未授权第三态；与 design 通过公式矛盾时应 BLOCKED | **接受** → 全文 `BLOCKED` |
| **P0** | 供应链自评高则不能判通过 | **接受** → clatterjs gate 不通过 |
| **P0** | integrity 不能充当 provenance / Gold 通过依据 | **接受** |
| **P0** | 必须启动 7 日三选一，截止日期明确 | **接受** → 2026-07-23 23:59 Asia/Shanghai |
| **P0** | gate 未过禁止引入 clatterjs / M1 生产 crypto / M2 握手 | **接受** |
| **P1** | 无公开审计单独一项不必然失败 | **接受** → 综合供应链判断 |
| **P1** | 不要新增“必须有 GitHub”绝对规则 | **接受** |
| **P1** | H1–H9 与 gate 全维度分离 | **接受** |
| **P1** | `@noble/post-quantum` tree-shake ≠ 消除风险 | **接受** |
| **P1** | 日期“约”须标明来源 | **接受** |

---

## 附录 A — 其余候选（硬失败截断；拒绝摘要）

> **截断纪律：** 下列候选在 **单个硬要求失败** 后即拒绝；**后续维度评估截断**。
> **不得** 将截断理解为许可证/维护/审计/供应链等其它维度已通过或已充分评估。

### A.1 `@niomon/noise-js@2.0.1` — **拒绝**（截断于 H3）

| 项 | 事实 | 证据类 |
| --- | --- | --- |
| 许可 | Apache-2.0（npm） | 来源可证明 |
| repository | https://gitlab.com/blocksq/noise-js | 来源可证明 |
| 25519 / SHA256 / IK | README 支持 | 来源可证明 |
| AEAD | 列出 **AESGCM**；**无 ChaChaPoly** | 来源可证明（README） |
| npm time | modified 约 **2022-05-26** | 来源可证明 |
| lifecycle | `prepare: yarn build` 存在 | 来源可证明 |
| 后续维度（审计/全树许可/完整供应链综合“可接受”） | **截断，未评通过** | — |
| URL | https://www.npmjs.com/package/@niomon/noise-js | — |

**硬失败：** H3（ChaChaPoly）。**截断 ≠ 其它维度通过。**

### A.2 `salty-crypto@1.0.0-rc.4` — **拒绝**（截断于 H4/H9）

| 项 | 事实 | 证据类 |
| --- | --- | --- |
| 许可 | MIT（npm） | 来源可证明 |
| 模块 | ESM/CJS exports；无运行时 dependencies | 来源可证明 |
| 新鲜度 | npm 元数据约 **2025-12-30**；仍为 **RC** | 来源可证明 |
| 套件 | 仅 `Noise_*_25519_ChaChaPoly_BLAKE2s`；README 将 **SHA256 列为后续/TODO** | 来源可证明 |
| lifecycle | `prepare` 存在（yarn clean/compile/bundle） | 来源可证明 |
| 后续维度 | **截断，未评通过** | — |
| URL | https://www.npmjs.com/package/salty-crypto | — |

**硬失败：** H4/H9（BLAKE2s ≠ SHA256）；RC 叠加供应链不确定性（记录，非单独第三态）。**截断 ≠ 其它维度通过。**

---

## 附录 B — 决策记录元数据

| 项 | 内容 |
| --- | --- |
| 决策者角色 | Linke V2.0 Gold pm-dcw 实现者（Grok）按 design §6.7.7 / plan T1.0 落盘 |
| Git 授权（提交/推送） | 用户已于 **2026-07-17** 对本 Gold 持续目标 **明确授权自动 commit/push**。因此本 ADR 可在 **PM 验收后** 自动 **path-specific** 提交/推送（仅本文件路径）。**不得** 用 `git add .` / `git add -A`。 |
| 安全/范围授权（未获） | **Noise 依赖引入**、**路线 1/2/3**、**suite/spec 变更** 仍 **未** 获得用户具体书面选择/授权；**不得** 由 Git 授权推导上述任一项。 |
| 当前状态 | **`BLOCKED`**；day0 **2026-07-16**；截止 **2026-07-23 23:59 Asia/Shanghai**；用户 **尚未选择** 路线 |
| 有效期 | 直至用户书面三选一完成并（若适用）重开 gate 修订本 ADR；或用户书面选择暂停 V2.0 |
| 相关 P0 | P0-9（crypto bootstrap + library gate）、P0-12（无 ADR 静默自研）、P1-26（BLOCKED 后 7 日 ADR；禁止静默 fixed-fixture） |
| 本任务文件 / 提交边界 | 仅本 ADR；**不** 改 `package-lock.json` / `package.json` / `src/**` / `test/**` / 其它 docs。**纪律（非 git 自动屏障）：** 只允许 `git add -- docs/superpowers/specs/2026-07-16-linke-v2-m1-noise-library-selection-adr.md`；**禁止** `git add .` / `git add -A`（同树 untracked `package-lock.json` 会被误 stage） |

---

## 附录 C — 一页纸裁决条

```text
ADR: 2026-07-16-linke-v2-m1-noise-library-selection
REV: 2026-07-17 revision-2
VERDICT: BLOCKED
SUITE:   Noise_IK_25519_ChaChaPoly_SHA256 (frozen; no downgrade)
TECH_FIT_ONLY: @lukeburns/clatterjs@1.0.0 (H1–H9 yes; NOT selected; NOT Gold pick)
GATE:    supply-chain risk unacceptable → NOT PASS
NO_INTRO: clatterjs / any Noise lib / M1 production crypto / M2 handshake
CLOCK:   day0 2026-07-16 → deadline 2026-07-23 23:59 Asia/Shanghai
OVERDUE: still BLOCKED; no auto-pause; no default route
OPTIONS: (1) alternate compliant lib  (2) revise protocol/spec  (3) pause V2.0
USER:    NOT YET SELECTED (Route Decision template PENDING)
SKELETON: non-crypto contracts only; MUST label T1.0 BLOCKED; ≠ M1 crypto PASS
VECTORS: msg1/msg2 local-spike only; handshakeHash LOCAL ONLY; no public expected hash in cacophony
BASELINE: Gold Node runtime NOT FROZEN (do not invent LTS)
REJECTED_ONCE: PASS_WITH_HARD_CONDITIONS (unauthorized third state)
SCOPE:   docs ADR only; package-lock.json out of task scope
GIT:     auto commit/push authorized 2026-07-17 for Gold continuous goal → path-specific ADR only after PM accept
AUTH:    NO route 1/2/3 · NO Noise dep intro · NO suite/spec change (not implied by Git auth)
ADD:     only `git add -- docs/superpowers/specs/2026-07-16-linke-v2-m1-noise-library-selection-adr.md`
         forbid `git add .` / `git add -A` (discipline, not gitignore)
```

---

## 附录 D — 文档自检清单（修订-2）

| 检查项 | 结果 |
| --- | --- |
| 全文状态/裁决/一页纸均为 `BLOCKED` | 是 |
| 无残留有效的 `PASS_WITH_HARD_CONDITIONS` 授权（仅否决记录） | 是 |
| 无“当前可引入 clatterjs / M1 crypto PASS / M2 可进”表述 | 是 |
| H1–H9 = 技术兼容；§2.2 = gate 全维度；§2.5 = 供应链方法论 | 是 |
| 技术兼容未写成 Gold 选型通过 | 是 |
| 无审计单独失败 / 无强制 GitHub 绝对规则 | 是 |
| 三选一与 design 一致；day0/截止 Asia/Shanghai；未选/逾期仍 BLOCKED；无自动暂停 | 是 |
| Route Decision 模板存在且 PENDING | 是 |
| §7 为重开 gate 证据，非当前授权 | 是 |
| handshakeHash 标为本地 spike、非权威 expected | 是 |
| B/C 安全政策/审计无证据则尚未证明 | 是 |
| 附录截断纪律明确 | 是 |
| 完整向量扩展 + runtime baseline 尚未冻结 已记录 | 是 |
| 传递许可全树缺口已列 | 是 |
| `@noble/post-quantum` 未声称已处置 | 是 |
| downstream labeling 纪律明确；CI 不在本 ADR 实现 | 是 |
| package-lock.json 不在范围且未改；path-specific add only；禁 `git add .`/`-A` | 是（任务纪律，非 git 自动屏障） |
| 仅修改本 ADR；无依赖/源码/测试变更 | 是（任务边界） |
| Git auto commit/push（2026-07-17 Gold 持续目标）与路线/依赖/spec 授权已拆分 | 是（附录 B / 一页纸） |
| tarball clatterjs 路径含 `dist/` 前缀 | 是 |
