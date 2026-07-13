# Linke Gold 单机完整版发布设计

## 目标

Linke Gold 是可在单台 macOS 控制器上正式安装和长期运行的完整备份软件。它管理多台受管 macOS 设备，以群晖或绿联预挂载 SMB 共享作为远端存储，并完整支持安全入站、自动备份、远端复制、端点恢复、保留策略执行、进程托管、权限控制、审计、监控、升级、回滚和卸载。

Gold 完成定义冻结为：Gold scorecard 的 9 个项目全部为 `ready`，不存在 `partial` 或 `blocked`。每个项目升级为 `ready` 必须同时具备真实执行路径、真实环境验收证据、明确安全边界和可复现恢复演练。固定返回 `blocked` 的 readiness stub、dry-run、preview 或文档声明不能作为完成证据。

## 产品边界

### Gold 范围

- 单台 macOS 控制器管理多台设备。
- 受管端点在本机创建可信 snapshot，通过受认证的 LAN TLS 数据面上传控制器；恢复由端点拉取、暂存、复验并在本机发布。
- 群晖和绿联通过 macOS 预挂载 SMB 共享接入。
- 本地 snapshot manifest v2、逐文件 SHA-256 和原子元数据。
- 自动备份、SMB 复制、远端恢复和本地/远端 Retention。
- launchd 安装、启动、停止、异常重启、升级、回滚和卸载。
- 管理员、操作员、只读三种本机角色。
- Linke 自身认证材料使用 macOS Keychain；SMB 凭证由 Finder/macOS Keychain 管理，Linke 永不读取。
- 防篡改审计链、安全轮转、链完整性检查和损坏告警。
- 本机健康聚合、磁盘/调度/快照/SMB/审计/版本状态和本机通知。
- 从干净 Mac 环境完成安装到卸载的全流程真实验收。

### 明确非目标

- 多控制器集群、高可用、服务发现和分布式协调。
- 分布式限流、滚动集群升级和多区域复制。
- OAuth、OIDC、LDAP 或企业集中身份系统。
- 群晖或绿联厂商专有应用 API；Gold 以双方支持的 SMB 协议为正式传输边界。
- 公网 SaaS、生产云部署或远程生产环境变更。
- 非 macOS 受管端点；其它操作系统在 Gold 后另行设计和验收。

上述非目标不计为 Gold 缺口，但不得用来降低单机数据安全、认证、审计、恢复和可运维性要求。

## 方案比较与裁决

### 方案 A：在现有架构上纵向闭环

保留现有 Node.js ESM、零外部运行时依赖、安全边界和测试资产，逐项把 dry-run、preview 和 blocked stub 替换为真实执行能力。

优点：复用现有 manifest v2、SMB 复制、路径防护和 587 项候选测试；每一步都可独立验收和回滚。

风险：`src/agent.js`、`src/server.js` 和 `src/supervisor-lifecycle.js` 已较大，实施时必须把真实执行 adapter 拆成专一模块，避免继续膨胀。

裁决：采用。

### 方案 B：先建设平台内核

先重构调度、安全、生命周期和状态存储，再接入备份能力。

优点：长期边界更整齐。

缺点：短期没有真实用户能力，容易再次出现大量 readiness 骨架；单机产品不需要先建设通用平台。

裁决：不采用。

### 方案 C：重写核心

以新架构重做 Agent、服务端和 Web Console。

优点：可以清理历史累积。

缺点：丢失已经验证的安全规则、兼容性和测试证据；重写期间会同时存在两套数据协议和恢复风险。

裁决：拒绝。

## 总体架构

### 控制面

`src/server.js` 和 Web Console 提供只监听 loopback 的本机管理面。写操作必须经过角色授权、执行门、审计和幂等保护。控制面不得直接处理 SMB 凭证，也不得绕过 Agent 调用真实主机操作。

控制器同时提供独立的 Agent LAN HTTPS listener，只接受受管设备协议，不提供 Web 管理页面。该 listener 使用控制器 TLS 证书固定、设备身份和设备作用域授权；管理面 token 不能替代设备身份，设备 token 也不能访问管理面。

### 受管 Agent 数据面

每台受管 macOS 设备运行最小权限 Agent。Agent 在设备本地扫描源目录、创建 manifest v2 snapshot，并以不可变 snapshot 身份执行可恢复流式上传。控制器只接受 manifest allowlist 中的普通文件，逐文件复验大小和 SHA-256 后原子提交控制器 snapshot。

恢复任务由控制器创建不可变任务记录；端点 Agent 拉取远端或控制器 snapshot 到本机临时恢复区，完整复验后才发布到批准的恢复根目录。控制器不得把自身文件系统路径当作远程设备路径，也不得直接写远程设备文件系统。

### 信任建立与设备身份

Gold 不使用自动 LAN 发现。管理员在控制器 loopback 管理面创建十分钟有效、仅可使用一次的 256 位随机 enrollment code；控制器只持久化该 code 的摘要、过期时间和使用状态。

控制器首次初始化 Agent listener 时，通过专一 `TlsIdentityStore` 创建或导入服务器证书和私钥。私钥只写入控制器登录用户 Keychain；证书必须包含管理员显式确认的私有 LAN IP 或 DNS SAN。listener 默认端口为 `3443`，必须显式绑定该私有 LAN 地址，不能默认监听 `0.0.0.0`。证书不得静默再生成；指纹改变时现有设备配对全部进入暂停状态，管理员确认新指纹并重新 enrollment 后才能恢复。

管理员通过独立渠道把控制器 LAN URL、TLS 证书 SHA-256 指纹和 enrollment code 交给端点。端点首次连接时必须固定并核对证书指纹，再使用 enrollment code 换取随机设备 token。设备 token 存入端点 Keychain；控制器只保存 token 摘要并绑定唯一 `deviceId`。后续请求同时验证 TLS 指纹、token 摘要、撤销状态、协议版本和请求中的 `deviceId`，任何一项不匹配都 fail-closed。

设备作用域完全由已验证 token 的服务端绑定关系决定，不能由 URL、请求体或 manifest 自报。路由参数和载荷中的 `deviceId` 必须与 token 绑定值相同；存储查询也必须先施加该绑定条件。设备 token 支持轮换和立即撤销；撤销后不得创建上传 session、拉取恢复任务或读取任何 snapshot。

Gold 不实现客户端证书签发或自动 CA 发现。协议版本由单一来源定义；控制器只兼容当前版本和 N-1 Agent。超出边界的端点返回 `device-protocol-unsupported` 和脱敏升级提示，不自动降级协议，也不接受部分兼容写入。

### 上传 Session 状态机

上传 session 使用 `(deviceId, snapshotId, manifestDigest, uploadId)` 作为不可变身份，并按固定状态机运行：

```text
initialized → receiving → verifying → committed
                     └→ aborted
```

- `initialized`：控制器验证设备身份、协议版本、manifest v2 和容量后原子创建 session record。
- `receiving`：按文件路径和固定 8 MiB chunk 接收数据；最后一个 chunk 可以更小。每个 chunk 记录 path、index、offset、size 和 SHA-256，落盘并复验后才原子推进已确认边界。
- `verifying`：所有 chunk 到齐后按 manifest 重新逐文件复验，不信任 chunk 级成功。
- `committed`：控制器 snapshot 原子发布并写完成记录；该状态不可回退、不可覆盖。
- `aborted`：身份、manifest 或完整性冲突时保留脱敏失败记录，不允许 resume。

端点恢复连接时提交同一 session 身份和 manifest digest，控制器返回已确认 chunk 集合与缺失 chunk 集合。身份或 digest 改变必须新建 session。过期未完成 session 只能由独立 Retention 计划清理，清理不得触碰 committed snapshot。

### 并发、隔离与背压

控制器使用每个设备、每个上传 session 和每个 snapshot 的独立锁；锁键必须包含服务端绑定的 `deviceId`。同一设备同时只允许一个备份上传和一个恢复传输，不同设备可以并行。控制器全局传输并发上限默认是 4，可通过非敏感配置下调；达到上限时返回 `upload-backpressure` 或 `restore-backpressure` 与有界 `Retry-After`，不在内存中无限排队。

并发验收必须让两个不同端点同时上传，并在其中一个端点制造断连和恢复。结果必须证明另一端点不受阻、session/chunk/manifest/恢复任务没有跨设备可见性，且同一远端 snapshot 的 SMB 发布仍保持单写者原子语义。

### Agent 与调度器

控制器 Agent 负责调度、Retention、NAS 和生命周期命令；端点 Agent 负责端点本地备份、上传与恢复。新增专一调度模块消费 `scheduleSeconds`，持久化运行记录，防止任务重叠，并在重启后有界补偿未完成任务。

### 本地存储

本地存储继续使用 manifest v2 和逐文件 SHA-256。本地完成 snapshot 是远端复制和恢复的可信锚点。Retention 的真实删除通过独立执行模块调用存储层，不把删除 I/O 放进 dry-run 规划函数。

### NAS 数据面

NAS 数据面复用现有 mounted SMB 复制模块，并增加远端恢复执行器。复制和恢复都只接受 Linke 生成且通过完整性校验的 snapshot，不读取任意原始路径。远端只有通过最终复验且存在有效 `COMPLETED.json` 的 snapshot 才可用于恢复。

### 生命周期层

生命周期层把 launchd、文件安装、版本切换和进程状态封装为显式 adapter。纯计划、审批、执行策略、主机操作、回滚和恢复保持可独立测试的边界。已有 disabled stub 只能被真实实现替换，不继续新增同类 stub。

### 安全与审计

Linke 自身角色凭据、控制器 TLS 私钥、设备 token 和审计密钥材料由 macOS Keychain 保存。Keychain 不可访问时 fail-closed，不回退到明文配置或环境变量。审计日志采用字段 allowlist、序列化追加、前序摘要链和安全轮转；链断裂时高风险写操作进入只读保护状态。

Keychain 是从零新增的高风险 macOS 集成，不是现有 foundation 的小改动。G0a 先实现最小 `KeychainStore` 接口、控制器 TLS 私钥和设备 token 存取；G5 再扩展角色凭据轮换与审计密钥。单元测试可以注入内存 adapter，但只能证明接口逻辑；CI 没有真实登录 Keychain 时必须把真实集成记为未验证，不能记 PASS。Gold 发布必须在真实登录用户 Keychain 上覆盖首次授权、锁定、解锁、轮换、删除和权限拒绝。任何权限弹窗由 macOS 显示并由用户处理，Linke 不尝试绕过。

### 运维与监控

健康聚合覆盖进程、版本、磁盘空间、最近备份、调度延迟、SMB 挂载、审计链和恢复状态。本机通知只报告脱敏状态和固定错误码，不包含路径、凭据或原始系统错误。

### 错误码注册表

所有可观察错误码在单一注册表中维护，格式为小写 kebab-case：`<domain>-<reason>`。domain 固定为 `auth`、`device`、`upload`、`snapshot`、`smb`、`restore`、`retention`、`scheduler`、`lifecycle`、`keychain`、`audit`、`upgrade`。测试必须拒绝重复码、未注册码和回显原始系统错误的码映射。

SMB 边界只区分 `smb-not-mounted`、`smb-mount-unavailable`、`smb-space-insufficient` 和具体的安全/完整性错误。由于 Linke 永不读取 SMB 凭证，它不得声称能区分凭证过期、NAS 网络不可达或 Finder 会话失效；这些情况统一映射为 `smb-mount-unavailable`，运维动作是通过 Finder 检查并重新挂载后再显式恢复。

### 发布证据 Artifact

每个 Gold item 必须生成 `gold-evidence-v1` 脱敏 JSON artifact，包含：capability id、source commit、release version、schema version、验证命令标识、检查项及结果、真实边界类型、证据生成时间、证据有效期和 artifact digest。真实路径、主机名、IP、token、证书、Keychain 内容和原始系统错误不得进入 artifact。

artifact 由审计密钥签名并写入控制器 dataDir 的 release-evidence 目录；仓库只保存脱敏人工报告，不保存本机 artifact。Gold 验证命令必须重新验证 schema、签名、source commit、时效和每个 capability 所需检查项，不接受手工创建、过期、静态占位或来自其它 commit 的 artifact：

```text
node src/agent.js gold-readiness \
  --verify-evidence \
  --data-dir <controller-data-dir> \
  --fail-on-blocked
```

9 个 item 必须分别引用自身 evidence artifact；静态源码字符串只能描述要求，不能改变 ready 状态。每项的固定验证命令标识和真实边界如下：

| capability id | 验证命令标识 | 必需真实边界 |
| --- | --- | --- |
| `release-readiness` | `gold.verify.release` | 同一候选 commit 的全部有效证据 |
| `local-backup-restore` | `gold.verify.local-data` | 真实 APFS 文件系统备份与恢复 |
| `fleet-device-management` | `gold.verify.fleet` | 两个隔离 macOS 端点、LAN TLS 与撤销 |
| `version-consistency` | `gold.verify.version` | 当前与 N-1 Agent 协议验收 |
| `nas-dry-run` | `gold.verify.nas-plan` | 无写入计划与真实 adapter 语义对照 |
| `automation-installation` | `gold.verify.lifecycle` | 真实 launchd 安装至卸载 |
| `security-auth` | `gold.verify.security` | 真实登录用户 Keychain、角色与审计链 |
| `real-nas-remote-backup` | `gold.verify.remote-data` | 真实 `smbfs` 复制、断连与恢复 |
| `production-hardening` | `gold.verify.hardening` | 长时调度、Retention、监控、升级回滚 |

## 核心数据流

### 自动备份

```text
scheduler
→ run record 与排他锁
→ 端点 Agent 本地创建 manifest v2 snapshot
→ 受认证 LAN TLS 可恢复上传
→ 控制器逐文件完整性复验并原子提交
→ SMB replication
→ 远端最终复验
→ 审计与健康状态更新
```

### 远端恢复

```text
用户显式选择目标设备和远端 snapshot
→ 角色授权与恢复预检
→ 控制器创建不可变恢复任务
→ 控制器从 NAS 拉取到本机恢复缓存并复验，已有可信本地副本时可复用
→ 端点 Agent 校验批准的恢复根目录
→ 从控制器拉取到端点临时恢复区
→ 逐文件 SHA-256 复验
→ 在端点原子发布到目标目录
→ 审计与恢复报告
```

### Retention

```text
策略规划
→ 冻结删除清单
→ 执行门与审批
→ 逐 snapshot 删除
→ 每步物理存在性复验
→ 审计与状态更新
```

### 升级与回滚

```text
验证候选版本
→ 保存当前版本与 plist 锚点
→ 停止服务
→ 原子切换 active version
→ 启动并执行健康检查
→ 成功则确认升级
→ 失败则恢复 last-green 并重启
```

## Gold Scorecard Ready 标准

### 1. release-readiness

- 版本、健康、测试、迁移和真实验收证据一致。
- 发布检查必须读取真实证据产物，不以静态字符串代替。

### 2. local-backup-restore

- 真实创建和恢复 manifest v2 snapshot。
- 目标路径、符号链接、并发和完整性失败均 fail-closed。
- 本地备份与恢复演练通过。

### 3. fleet-device-management

- 多设备心跳、注册、撤销、snapshot 上传、恢复任务、运行状态和错误状态真实可执行且可见。
- 设备路径与任务状态相互隔离。
- 管理 listener 与 Agent listener 隔离，设备身份不能跨设备访问数据。
- Gold 不要求任意远程命令或通用远程主机控制。

### 4. version-consistency

- 版本单一来源，控制器、Agent、API 和 Web 显示一致。
- 控制器与当前、N-1 Agent 的读写协议通过契约和真实端点测试；更旧 Agent fail-closed 并给出迁移提示。

### 5. nas-dry-run

- 保留无写入计划能力。
- 配置、预检、执行和错误语义与真实 SMB adapter 一致。
- dry-run 不再作为真实 NAS 完成证据。

### 6. automation-installation

- launchd 安装、启动、停止、异常重启、升级、回滚和卸载真实可执行。
- 操作具备幂等、恢复锚点和真实 macOS 验收。

### 7. security-auth

- 管理员、操作员、只读角色在所有 API、CLI 和 Web 写入口真实生效。
- Linke 自身凭据、设备身份、控制器 TLS 私钥与审计密钥存入 Keychain 并可轮换。
- Keychain 锁定、凭据缺失和权限失败均 fail-closed。

### 8. real-nas-remote-backup

- 真实 `smbfs` 复制、幂等重放、断连恢复、并发锁和最终完整性校验通过。
- 真实远端恢复到本地并逐文件比对通过。

### 9. production-hardening

- 本地/远端 Retention 真执行。
- 自动调度、进程看护、监控、本机通知、审计链、升级和回滚全部通过真实本机验收。
- 已声明 Gold 范围中不存在“尚未实现”项。

## 能力路线与依赖顺序

### G0a：信任基础

- 实现最小 `KeychainStore` 和 `TlsIdentityStore`，完成 TLS 身份创建/导入、锁定失败和显式指纹变更。
- 拆分 loopback 管理 listener 与显式私网地址上的 LAN Agent HTTPS listener。
- 实现十分钟单次 enrollment、设备 token、服务端设备作用域、轮换、撤销和当前/N-1 协议门。
- 用真实登录用户 Keychain 和第二个隔离 macOS 环境验证首次配对、重启持久化、撤销及证书指纹变化。

### G0b：端点上传闭环

- 实现端点 manifest v2 snapshot 创建和不可变上传 session 状态机。
- 实现固定 chunk、可恢复上传、容量预检、控制器复验与原子提交。
- 故障测试覆盖错序/重复/损坏 chunk、manifest 冲突、断连恢复、session 过期和设备越权。

### G0c：端点恢复与并发

- 实现不可变恢复任务、端点拉取、临时区复验和安全发布。
- 两个端点并行执行上传和恢复，验证每设备/每 session 锁、全局背压与跨设备不可见。
- 使用两台真实 macOS 设备或一台真实设备加隔离虚拟机完成 LAN 边界验收；同进程 fixture 不能替代。

### G1：远端数据闭环

- 完成 V1.24 真实 SMB 验收。
- 增加远端恢复、断连检测、重挂载后的显式恢复和最终完整性复验。
- 外部 NAS 暂不可用时允许提交代码与自动测试，但不得提升 Gold 状态。

### G2：Retention 真执行

- 增加带执行门的本地和远端删除。
- 删除前冻结计划并记录审计。
- 单 snapshot 失败时停止扩大删除范围。

### G3：自动调度

- 消费现有 `scheduleSeconds`。
- 自动编排备份、NAS 复制和 Retention。
- 持久化运行记录、防重入、超时和重启补偿。

### G4：launchd 托管生命周期

- 实现安装、启动、停止、异常重启和卸载。
- 安装失败恢复旧 plist 和旧运行状态。
- 用真实 adapter 替换 blocked lifecycle stub。

### G5：本机安全与审计

- 实现三角色授权、Keychain、密钥轮换和审计链。
- 审计链损坏时进入高风险写保护。

### G6：升级、回滚和监控

- 使用版本目录和原子 active version 切换。
- 健康检查失败自动回滚 last-green。
- 聚合所有关键运行状态并提供本机通知。

### G7：Gold 发布资格

- 补齐所有真实硬件门。
- 完成从干净安装到卸载的端到端验收。
- 只有 9/9 ready 后才更新 Gold 版本和正式发布声明。

推荐开发顺序：`G0a → G0b → G0c → G1 代码补全 → G2 → G3 → G4 → G5 → G6 → 补齐 G0/G1 真实设备与 NAS 验收 → G7`。这允许在 NAS 未挂载时继续开发，但最终发布门不绕过真实硬件。

## 统一执行与恢复协议

所有真实写操作必须遵循：

```text
Plan → Preflight → Execute → Verify
```

- Plan 输出确定性动作清单和不可变任务身份。
- Preflight 校验权限、路径、空间、版本、完整性、挂载和恢复锚点。
- Execute 只执行计划中的动作，使用排他锁和幂等键。
- Verify 从真实目标重新读取状态，不信任进程内返回值。

失败时返回固定错误码和脱敏状态。权限、空间不足、路径越界、完整性冲突和审计链损坏不自动重试。仅明确的瞬时 I/O 错误允许退避后重试一次。同一失败签名连续两次进入恢复路径，禁止无限重跑。

## 运行韧性

### 正常态定义

- Agent 由 launchd 托管并通过健康检查。
- 管理 listener 仅在 loopback，Agent listener 使用有效 TLS 与设备身份。
- 受管设备注册有效，端点 snapshot 已安全提交控制器。
- 调度任务没有超期或重叠。
- 最近一次备份和复制具有有效完成标记与完整性证据。
- SMB 未挂载时状态明确降级，不产生远端成功声明。
- 审计链连续，版本一致，磁盘空间高于安全阈值。

### 恢复锚点

- 已完成的本地 manifest v2 snapshot。
- 端点上传 session、已验证 chunk 边界和控制器已提交 snapshot。
- 不可变端点恢复任务与端点临时恢复区。
- 远端经过复验的 `COMPLETED.json` snapshot。
- 持久化调度 run record。
- 安装前 plist、运行状态和 active version。
- last-green 版本目录。
- 审计链最近一次已验证摘要和轮转边界。

### 有界失效

- 复制中断保留 staging 和 attempt 元数据，不污染 final。
- 恢复先写临时区，复验后发布，不直接覆盖目标。
- Retention 逐 snapshot 执行，不把单项失败扩大为批量删除。
- 调度超时释放本轮执行资格，但不并发启动重复任务。
- lifecycle 操作失败恢复旧 plist、旧版本和旧运行状态。
- Keychain 或审计链异常时高风险写操作 fail-closed。
- 上传中断保留已验证 chunk 边界；设备身份撤销后拒绝新上传和恢复任务。

### 状态侦测与运行后自检

- launchd 进程与 HTTP health 双重检测。
- 管理 listener/Agent listener 隔离、证书有效期、设备身份与撤销状态检测。
- 上传 session、最后确认 chunk、端点恢复任务和设备最后成功时间检测。
- 调度延迟、最近成功、失败签名和运行锁检测。
- 本地/远端 snapshot 完整性抽检。
- `smbfs` 类型、挂载身份、空间和重挂载检测。
- 审计链和轮转锚点验证。
- 升级后版本、数据协议和关键端到端冒烟测试。

## 最高风险失败演练

```text
自动备份触发
→ 端点本地 snapshot 完成
→ LAN 上传中断并从已验证 chunk 恢复
→ 控制器完整性复验并提交
→ SMB 复制中途断连
→ 挂载失效信号出现
→ staging 与恢复元数据保留
→ 用户或系统重挂载共享
→ 显式恢复或幂等重试
→ 远端完整性复验
→ 完成标记生成
→ 从 NAS 恢复到临时目录
→ 逐文件 SHA-256 与源 snapshot 一致
```

缺少任一信号、恢复动作或最终复验，都不能算演练通过。

## 测试与验收

每个子项目必须通过：

1. 单元测试：纯函数、状态机、固定错误码和路径边界。
2. 契约测试：CLI、API、Web、配置和持久化格式一致。
3. 故障测试：断连、空间不足、权限失败、并发、进程终止和数据损坏。
4. 本机真实测试：真实文件系统、HTTP、进程、Keychain 和 launchd。
5. 外部真实测试：真实受管 macOS Agent LAN 上传/恢复，以及真实 `smbfs` NAS 复制与恢复。

mock 可以验证逻辑和故障注入，但不能代替第 4、5 层真实证据。

## 实现闭环

```text
Grok TDD 实现
→ Grok 自检
→ Codex PM 检查 diff、越界和测试
→ Grok fresh review
→ Grok 辅助验收
→ Codex PM 独立复现实证
→ green task 自动 commit/push
→ 进入下一任务
```

每个可独立回滚的任务单独提交。代码或自动测试完成但真实硬件门未满足时，可以提交阶段成果，但不得修改 Gold 状态或发布声明。

## 最终发布门

- Gold scorecard 为 `ready:9, partial:0, blocked:0, total:9`。
- README 不再包含属于已声明 Gold 范围的未实现能力。
- 全量自动测试通过。
- 敏感数据和路径泄漏扫描通过。
- 真实多设备注册、撤销、LAN TLS 上传和端点恢复通过。
- 真实 SMB 复制、断连恢复和远端恢复通过。
- 真实 launchd 安装、重启、升级、回滚和卸载通过。
- 真实 Keychain 锁定与轮换场景通过。
- Retention、调度、审计链和监控真实运行通过。
- 最高风险失败演练闭环。
- Qwen 最终抗辩没有未闭合 P0/P1 finding。
- Grok fresh 验收通过。
- Codex PM 独立复现实证齐全。

只有全部条件满足，才允许写入 Gold 正式版本、更新发布声明并执行发布流程。
