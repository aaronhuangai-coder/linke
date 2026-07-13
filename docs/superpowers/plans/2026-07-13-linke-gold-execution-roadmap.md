# Linke Gold Execution Roadmap

> 本文是 Gold 各独立实施计划的依赖索引。每个阶段必须有自己的详细 TDD plan、fresh review 和真实边界证据；路线图本身不替代子计划。

**Goal:** 把已批准的 Gold 设计拆成按依赖顺序交付、独立回滚并最终汇合为 9/9 ready 的实施阶段。

**Architecture:** 先建立安全的多设备信任与数据通道，再闭合 NAS、Retention、调度、生命周期、安全审计和升级监控。控制面继续只监听 loopback，Agent 数据面使用独立私网 HTTPS listener；每个阶段只消费前序已经冻结的接口。

**Tech Stack:** Node.js 24 ESM、Node.js 内置 `node:test`、macOS Keychain、launchd、APFS、预挂载 `smbfs`；不新增 npm 运行时依赖。

## Global Constraints

- Gold 形态固定为一台 macOS 控制器、多台受管 macOS 端点、群晖/绿联预挂载 SMB。
- 管理面只监听 loopback；Agent listener 只绑定管理员显式确认的私有 LAN 地址，默认端口 `3443`，不得默认监听 `0.0.0.0`。
- Linke 永不读取 SMB 凭据；Finder/macOS Keychain 负责 SMB 挂载身份。
- Linke 角色凭据、控制器 TLS 私钥、设备 token 和审计密钥进入 macOS Keychain，Keychain 不可用时 fail-closed。
- 设备协议只兼容当前与 N-1；更旧协议返回 `device-protocol-unsupported`。
- 所有真实写操作遵循 `Plan → Preflight → Execute → Verify`，仅明确的瞬时 I/O 错误允许退避后重试一次。
- dry-run、preview、blocked readiness stub 和静态文字不能提升 Gold 状态。
- 自动测试不能替代真实 Keychain、真实 launchd、真实受管 Mac 或真实 `smbfs` 证据。
- 每个 green task 经过 Grok fresh review、Grok 辅助验收和 Codex PM 独立验证后独立提交、推送。
- 真实生产写入、真实凭据写入和正式发布仍受安全边界约束；测试只使用专用、可清理的 staging 资源。

## Dependency Graph

```text
G0a trust foundation
 ├─ G0b resumable endpoint upload
 │   └─ G0c endpoint restore and concurrency
 │       └─ G1 remote NAS data closure
 ├─ G5 role auth and tamper-evident audit
 └─ G4 launchd lifecycle

G1 ── G2 retention execution ── G3 scheduler
G4 + G5 + G3 ── G6 upgrade, rollback and monitoring
G0a..G6 + real hardware evidence ── G7 Gold qualification
```

## Stage Plans

| 阶段 | 独立交付物 | 入口依赖 | 完成信号 | 主要 Gold item |
| --- | --- | --- | --- | --- |
| G0a | Keychain、TLS identity、enrollment、设备 token、撤销、当前/N-1 协议、双 listener | 已批准设计 | 自动契约全绿；真实 Keychain 与第二 macOS 配对证据齐全 | fleet-device-management、security-auth、version-consistency |
| G0b | manifest v2 上传 session、8 MiB chunk、resume、复验、原子提交 | G0a | 断连恢复、损坏拒绝、跨设备越权测试及真实 LAN 上传 | fleet-device-management、local-backup-restore |
| G0c | 不可变恢复任务、端点 staging、发布、每设备锁、全局背压 | G0b | 两端点并发上传/恢复且互不可见 | fleet-device-management、local-backup-restore |
| G1 | SMB 真实复制、断连恢复、NAS→控制器缓存→端点恢复 | G0c、现有 V1.24 模块 | 真实 `smbfs` 双向逐文件复验 | real-nas-remote-backup、nas-dry-run |
| G2 | 本地/远端 Retention 真执行、冻结清单、删除复验 | G1 | 故障不扩大删除范围，真实文件删除证据 | production-hardening |
| G3 | 持久化调度、排他、超时、重启补偿 | G2 | 长时运行无重叠、积压有界、重启恢复 | production-hardening |
| G4 | launchd 安装、启停、异常重启、卸载、旧状态恢复 | G0a | 干净 Mac 上完整 lifecycle 演练 | automation-installation |
| G5 | 三角色、Keychain 轮换、审计摘要链与轮转 | G0a | 角色矩阵、Keychain 锁定、链损坏写保护 | security-auth、production-hardening |
| G6 | active version 原子切换、last-green 回滚、健康聚合、本机通知 | G3、G4、G5 | 失败升级自动回到 last-green | release-readiness、production-hardening |
| G7 | `gold-evidence-v1` 签名、验证器、全量 E2E、发布声明 | G0a..G6 | `ready:9, partial:0, blocked:0, total:9` | 全部 |

## Stage Exit Gates

每个阶段只有满足以下条件才进入依赖它的下一阶段：

1. 详细实施计划已经通过 Qwen fresh adversarial review，所有 P0/P1 finding 已裁决。
2. 每个 task 按 RED→GREEN 实施，且变更范围与计划一致。
3. Grok fresh reviewer 没有未闭合 P0/P1 finding。
4. Codex PM 复跑聚焦测试和必要回归，检查 diff、敏感信息、路径边界与错误码。
5. 能执行的真实边界已有证据；暂缺硬件的边界明确保持 `blocked`，不伪装 PASS。
6. green task 使用约定式提交并推送到 `linke-v0.12-web-panel`。

## Resilience Work Breakdown

### 有界失效

| failureMode | 预期行为 | 兜底机制 | 信号 | 对应阶段 |
| --- | --- | --- | --- | --- |
| Keychain 锁定/拒绝 | 不启动 Agent listener，不回退明文 | fail-closed、固定错误码 | `keychain-unavailable` | G0a、G5 |
| enrollment 重放/过期 | 不签发 token | 单次摘要、十分钟 TTL、原子消费 | `device-enrollment-invalid` | G0a |
| Agent 协议过旧 | 拒绝读写 | 当前/N-1 门 | `device-protocol-unsupported` | G0a |
| LAN 上传中断 | final 不可见 | chunk 检查点、session resume | `upload-interrupted` | G0b |
| 端点恢复中断 | 目标不被覆盖 | 本机 staging、发布前复验 | `restore-interrupted` | G0c |
| SMB 断连 | 不产生远端成功声明 | staging、attempt、显式 resume | `smb-mount-unavailable` | G1 |
| Retention 单项失败 | 停止扩大删除 | 冻结清单、逐项复验 | `retention-delete-failed` | G2 |
| 调度积压 | 不无限排队、不重叠 | 每设备锁、全局上限、超时 | `scheduler-backpressure` | G3 |
| launchd 操作失败 | 恢复旧 plist/运行态 | 安装前锚点、补偿 | `lifecycle-rollback-required` | G4 |
| 审计链断裂 | 高风险写入口只读保护 | 最近可信摘要锚点 | `audit-chain-invalid` | G5 |
| 升级健康失败 | 自动恢复 last-green | 原子 active 切换、回滚 | `upgrade-health-failed` | G6 |

### 异常恢复

- G0a：证书与 Keychain 项必须成对存在；不完整身份只能由管理员显式修复，不能静默再生成。
- G0b：上传从服务端已确认 chunk 集合恢复，manifest digest 改变必须创建新 session。
- G0c：恢复只从不可变任务与端点 staging 恢复，目标目录只在完整复验后发布。
- G1：SMB attempt/staging 是恢复锚点，重挂载后显式 resume，final 与 `COMPLETED.json` 不被覆盖。
- G2：冻结删除清单和每项状态是恢复锚点，失败后只重放未完成项。
- G3：持久化 run record 是调度恢复锚点，重启仅补偿符合期限的未完成任务。
- G4：旧 plist、旧运行状态和已安装文件清单是 lifecycle 恢复锚点。
- G5：最近一次验证通过的摘要与轮转边界是审计恢复锚点。
- G6：last-green 版本目录和 active symlink 是升级恢复锚点。

### 状态侦测与运行后自检

- G0a：双 listener 绑定、证书指纹、协议边界、设备 active/revoked 状态。
- G0b/G0c：session 状态、确认 chunk、恢复任务、每设备最后成功时间、全局传输占用。
- G1/G2：`smbfs` 类型、挂载状态、空间、snapshot 完成标记、保留策略物理结果。
- G3/G4：调度延迟、运行锁、launchd 进程和 HTTP health。
- G5/G6：Keychain 可访问性、审计链、版本一致性、last-green、通知送达状态。
- G7：每个 capability 的 schema、签名、source commit、时效和真实边界证据。

## Real-Boundary Ledger

| 边界 | 当前状态 | 解除条件 |
| --- | --- | --- |
| 本机 APFS/HTTP/进程 | `task` | 每个相关阶段由 Codex PM 复跑 |
| macOS Keychain | `blocked` | 用户明确允许专用测试项写入后，执行创建/读取/锁定/解锁/轮换/删除 |
| 第二受管 macOS/隔离虚拟机 | `blocked` | 提供可达测试端点并明确允许私网测试请求 |
| 真实 `smbfs` NAS | `blocked` | 提供专用测试共享目录并明确允许 fixture 写入/清理 |
| launchd | `task` | G4 在专用 label 上执行真实安装到卸载 |
| 正式 Gold 发布 | `blocked` | 9/9 ready 且用户确认发布 |

## Plan Index

- G0a：`docs/superpowers/plans/2026-07-13-linke-gold-g0a-trust-foundation.md`
- 其余阶段的详细 plan 在其入口依赖全部 green 后创建，避免用未验证接口提前固化实现。
