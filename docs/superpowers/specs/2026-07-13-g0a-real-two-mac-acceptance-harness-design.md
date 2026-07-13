# G0a Real Two-Mac Acceptance Harness Design

## 目标

为 G0a 增加一个仓库内、测试专用、显式启用的真实双 Mac 验收 harness，补齐当前正式 CLI 无法安全证明的真实边界：

- rotate 后旧 token 立即拒绝；
- current 与 N-1 完成 enrollment/heartbeat；
- N-2 固定返回 426；
- revoke 后立即拒绝；
- Controller 与 Endpoint 重启后 TLS identity 和 Keychain token 持久有效；
- Controller fingerprint replacement 无显式接受时 fail-closed，显式接受后旧设备 suspended，重新 enrollment 后恢复 active。

该 harness 只服务专用测试资源，不新增生产 API、正式 Agent CLI 参数或默认启动行为。自动测试仍不等于真实 Keychain / 第二 Mac 验收；只有真实门全部通过并生成脱敏报告后，相关 Gold blocker 才能转 ready。

## 范围与文件边界

新增：

- `test/helpers/g0a-real-common.js`
- `test/helpers/g0a-real-controller-runner.js`
- `test/helpers/g0a-real-endpoint-runner.js`
- `test/g0a-real-acceptance.test.js`

允许按最小需要修改：

- `README.md`：只增加测试专用 harness 的安全操作说明和 blocked 边界。
- `test/readme.test.js`：锁定说明文字与禁止误报 Gold 的边界。

默认不修改：

- `src/agent.js`
- `src/controller-runtime.js`
- `src/device-client.js`
- `src/device-registry.js`
- `src/server.js`
- `package.json`

若实现发现现有公开导出不足，必须先返回 PM 裁决，不得为了方便扩大生产接口。

## 架构

### Common 模块

`test/helpers/g0a-real-common.js` 提供测试专用的纯函数和安全原语：

- 精确环境门校验：只有 `LINKE_REAL_G0A_ACCEPTANCE === 'enabled'` 才允许任何副作用。
- 固定 phase/command 枚举和状态机校验。
- 仅允许固定字段的 sanitized JSON 输出。
- 敏感字段 denylist 与递归输出校验。
- `0600` 原子 JSON 写入：先在同目录写唯一 `.new`，设置 mode，再 rename。
- `0600` 输入文件校验：拒绝 symlink、非普通文件、group/other 权限以及未知 schema 字段。
- 固定错误码映射；原始系统错误不得进入 stdout/stderr、状态或报告。
- 精确清理清单，只能操作本次 run state 中已知的 bundle/state 文件和专用 Keychain service/item。

Common 模块不能访问网络或 Keychain；所有 I/O 依赖必须可注入，便于 RED/GREEN 测试。

### Controller runner

`test/helpers/g0a-real-controller-runner.js` 是长驻测试进程，只在 Controller Mac 上运行。它：

1. 校验显式环境门、专用 run directory marker、私网 Agent host literal 和端口。
2. 在任何 Keychain/网络副作用前原子写入 run state，记录非秘密 run id、专用 Keychain service、阶段和精确清理对象。
3. 使用注入的 `KeychainStore({ service: dedicatedService })` 调用真实 `startController()`；不得使用默认生产 Keychain service。
4. 在内存生成临时 management full token，传给 `startController()`；该 token 不落盘、不进 argv、不进输出。
5. 通过真实 loopback management HTTP route 生成 current、N-1、N-2 三个一次性 enrollment code，验证管理路由本身。
6. 将 Endpoint 所需的短期 enrollment 信息与公开连接元数据写入 `0600` 私密 bundle；bundle 路径由专用 run directory 派生，不在 stdout 或报告中打印。
7. 保持 stdin 控制循环，只接受固定命令：
   - `prepare`
   - `ack-pre-revoke`
   - `revoke-current`
   - `ack-post-revoke`
   - `restart`
   - `ack-post-restart`
   - `replace-identity-confirmed`
   - `prepare-reenrollment`
   - `ack-post-fingerprint-change`
   - `ack-reenroll`
   - `stop`
8. 每个命令只输出 sanitized phase result，不输出 host、IP、URL、路径、fingerprint、code、token、Keychain item 或原始错误。

Controller runner 不监听额外 TCP 管理端口，不新增测试控制 HTTP route。stdin 是唯一控制面，避免额外认证凭证持久化。

所有 `ack-*` 命令只读取 Controller 专用 run directory 下固定名称的 Endpoint phase receipt，不接受 stdin payload 或动态路径。receipt 必须先由 PM 通过 SCP 从第二台 Mac 复制到固定 inbox；runner 校验其 `0600`、非 symlink、schema、run id、phase 和 PASS 状态后才允许迁移。缺失、重复、跨 run、错误 phase 或非 PASS receipt 均 fail-closed，且不得删除当前可恢复状态。

### Endpoint runner

`test/helpers/g0a-real-endpoint-runner.js` 在第二台 Mac 上运行，读取本地 `0600` bundle，并使用独立的专用 Keychain service。支持固定 phase：

- `pre-revoke`
- `post-revoke`
- `post-restart`
- `post-fingerprint-change`
- `reenroll`
- `cleanup`

`pre-revoke` 顺序固定：

1. 用 production `enrollDevice()` 完成 current enrollment，token 只写专用 Keychain。
2. 用 production `heartbeatDevice()` 连续 heartbeat 两次。
3. 从专用 Keychain 读取 current old token，仅保存在当前进程内存。
4. 用 production `rotateDeviceToken()` 完成 begin → Keychain pending write → confirm。
5. 使用 production `requestPinnedJson()` 与内存 old token 请求真实 `/agent/heartbeat`，必须得到 `device-token-invalid`；old token 不写磁盘、不进 argv、不进输出。
6. 再用 production `heartbeatDevice()` 验证 Keychain 中新 token 有效。
7. 用 production `requestPinnedJson()` 发起 protocolVersion=N-1 的真实 enrollment；完整验证响应后把 token 写入专用 Keychain，再从 Keychain 读取并完成 N-1 heartbeat。
8. 用 production `requestPinnedJson()` 发起 protocolVersion=N-2 的真实 enrollment，必须得到 `device-protocol-unsupported` / HTTP 426，且不写 token。
9. 删除已经消费的一次性 enrollment code 字段并原子重写本地 bundle。

`post-revoke` 使用 current 的专用 Keychain token请求真实 heartbeat，必须得到 `device-revoked`。

`post-restart` 使用仍 active 的 N-1 设备完成 heartbeat，证明 Controller registry、TLS identity 和 Endpoint Keychain token 跨进程重启持续有效。

`post-fingerprint-change` 使用旧 fingerprint 发起请求，必须在 secret 写出前得到 `device-tls-fingerprint-mismatch`。`reenroll` 使用新 bundle 完成重新 enrollment，再 heartbeat，证明 suspended 设备只有重新 enrollment 才恢复 active。

N-1 heartbeat 不得调用固定发送 current protocol 的 `heartbeatDevice()`；必须使用 `requestPinnedJson()` 构造 `protocolVersion = current - 1` 的 heartbeat，并从专用 Keychain 读取对应 token。current 设备仍使用 production `heartbeatDevice()`，以分别证明正式 client 与兼容协议路径。

Endpoint 在任何 Keychain/network 副作用前还要创建自己的 `0600` 原子 state。该 state 只记录 run id、phase、专用 Keychain service、由公开 `DeviceCredentialStore.itemId()` 精确派生的已用 item id，以及 receipt/bundle cleanup allowlist；不记录 URL、fingerprint、code 或 token。每次新增凭证前先持久化将要使用的精确 item id，使 crash 后 cleanup 不需要扫描或猜测。

每个 Endpoint phase 完成后，runner 在本地专用 run directory 原子写入固定名称的 sanitized receipt。receipt 只含 schema version、run id、phase、`PASS | FAIL | BLOCKED`、注册错误码、sanitized count/boolean 与 UTC 时间；不得包含 bundle 中的任何连接或认证字段。receipt 必须为普通文件、非 symlink、mode `0600`，并由 Controller runner 在对应 `ack-*` 命令中再次验证。

## 私密 bundle 与状态格式

### 原则

- bundle 是短期测试秘密载体，不是产品配置格式。
- bundle 只能存在于 Controller 专用 run directory、SCP 传输目标和 Endpoint 专用 run directory。
- 文件必须是普通文件、非 symlink、mode `0600`。
- bundle 不得加入 Git；bundle 实际字段不得出现在 stdout/stderr、报告或聊天中。
- bundle 内容不得进入 argv、环境变量、stdout/stderr、报告或聊天；SCP 只使用专用目录内固定相对文件名，不把任何 bundle 字段展开到命令行。
- Endpoint 成功读取后立即删除已消费 code；Controller 收到阶段成功后删除对应源 bundle。
- admin token 永远只在 Controller runner 内存。

### Schema

bundle 仅包含：

- schema version；
- run id；
- Agent HTTPS URL；
- TLS fingerprint；
- current/N-1/N-2 device id；
- current/N-1/N-2 一次性 enrollment code；
- 专用 Endpoint Keychain service；
- bundle 生成时间和过期时间。

任何未知字段、过期 bundle、重复 run id、空值或错误类型都 fail-closed。实际值不得写入设计、测试快照、错误消息或验收报告。

receipt 仅包含：

- schema version；
- run id；
- phase；
- `PASS | FAIL | BLOCKED`；
- 注册错误码；
- sanitized count/boolean；
- UTC 时间。

receipt 未经校验不得驱动 Controller 状态迁移；FAIL/BLOCKED receipt 只能记录脱敏结果，不能推进状态。

## SSH 与跨 Mac 边界

- 第二台 Mac 只通过用户预配置的 SSH alias 访问；Codex 不读取 `~/.ssh`。
- 命令只包含 alias 与非秘密 phase 名；不得包含 IP、URL、fingerprint、code、token 或密码。
- bundle 通过 SCP 文件传输，不通过 shell interpolation、环境变量、命令替换或聊天粘贴传递内容。
- 传输后 Endpoint runner 必须先验证 `0600`、非 symlink、schema、run id 与过期时间，再执行网络或 Keychain 操作。
- SSH/SCP 失败不自动重试生成新 code；保持同一 run state，允许对同一 bundle 做有界重传。

## Fingerprint replacement

`replace-identity-confirmed` 是破坏性测试阶段，只能在同时满足以下条件时执行：

- 显式真实验收门已启用；
- run state 标记为 dedicated test；
- data directory 位于当前专用 run directory 内；
- Keychain service 以测试专用前缀开头；
- stdin 命令精确为固定确认词；
- Controller 已停止监听。

runner 使用 `KeychainStore.delete('controller-tls-private-key')` 和精确证书文件路径删除成对 identity，不执行通配 `security` 命令。随后：

1. 无 accept 启动，必须因 registry fingerprint mismatch 失败；
2. 使用精确 `LINKE_ACCEPT_TLS_FINGERPRINT_CHANGE` 等价布尔接受路径启动；
3. registry 中旧 active 设备全部转 suspended；
4. 旧 pin 请求在 secret 写出前失败；
5. 新 code + 新 pin 重新 enrollment 后设备恢复 active。

出现只删 key 或只删 cert 的半状态时立即停止，固定报告 `device-tls-identity-incomplete`，不得继续自动修复或重新生成。

`controller-tls-private-key` 与 `controller-cert.pem` 当前是 production identity store 的内部持久化契约，不为 harness 扩大生产导出。harness 以测试专用常量精确固定这两个标识，并用 `TlsIdentityStore` 注入式契约测试捕获 production 命名漂移；契约测试未通过时禁止真实 replacement。

## 输出与证据

runner stdout 只允许：

- `role`；
- `phase`；
- `status: PASS | FAIL | BLOCKED`；
- 注册错误码；
- sanitized count/boolean；
- UTC 时间；
- `promptHandled` 与 allow/deny/lock/unlock 枚举。

禁止：

- host、IP、URL、路径；
- fingerprint 或其前缀；
- enrollment code；
- admin/device token；
- Keychain service/item；
- 私钥/cert 内容；
- 原始系统错误或 stderr；
- bundle/state 原文。

最终报告 `docs/superpowers/reports/2026-07-13-g0a-real-keychain-lan-acceptance.md` 只在真实门执行后生成，并严格使用计划允许的字段。自动测试、mock、同进程 fixture 或 runner 自报不能替代真实证据。

## 状态机与恢复

正常阶段：

```text
initialized
→ controller-ready
→ bundle-prepared
→ endpoint-pre-revoke-passed
→ current-revoked
→ endpoint-post-revoke-passed
→ controller-restarted
→ restart-passed
→ fingerprint-replaced
→ reenrollment-bundle-prepared
→ fingerprint-mismatch-passed
→ reenrollment-passed
→ cleaned
```

规则：

- 每次阶段转换先验证当前状态，再执行副作用，最后原子持久化下一状态。
- 重复同一已完成 phase 返回 sanitized idempotent PASS，不重复生成 code、token 或 identity。
- 跳阶段、倒序、未知命令或跨 run bundle 固定拒绝。
- `ack-*` 只消费当前预期 phase 的固定 receipt；成功迁移后精确删除该 receipt，重复 ack 返回 idempotent PASS 且不重复副作用。
- crash 后只从已持久化状态继续；不得猜测 Keychain 内容或自动扫描。
- SCP/SSH 失败保持 `bundle-prepared`，允许有界重传同一 bundle；不得新签发 code。
- 若 bundle 过期，必须由 Controller runner 精确废弃旧 state 后重新 `prepare`，不得复用旧 code。
- cleanup 只处理 state 中已知的专用文件和专用 Keychain items；任何不确定项转人工处理。

## 运行韧性设计门

正常态定义：每个 phase 只输出 sanitized PASS/FAIL/BLOCKED；所有 secret 只存在于内存、专用 Keychain 或 `0600` 短期 bundle；状态机可证明阶段顺序；真实 Controller/Endpoint 路径按计划运行。

恢复锚点：最近 green commit `1bb43d1`。harness 工作树出现越界、泄漏或测试失败时，不修改现有 G0a 生产代码；回到该提交并丢弃 harness 变更需遵守 Git destructive action 人类边界。

### 有界失效

| failureMode | 预期行为 | 兜底机制 | 可观测信号 | 验证 |
| --- | --- | --- | --- | --- |
| 环境门缺失 | 零副作用退出 | exact gate | fixed blocker | 单测 |
| bundle 权限/schema 非法 | 网络/Keychain 前拒绝 | lstat/mode/schema validation | fixed code | 单测 |
| SCP/SSH 中断 | 不生成新 code | 状态停在 bundle-prepared | BLOCKED | fault test + real drill |
| rotate 中断 | 保留 Keychain pending recovery 语义 | production rotate recovery | fixed code | 单测 + real retry |
| rotate pending 过期 | 有界 FAIL，不重新 begin | production TTL 边界 | fixed code | fault test |
| old token 意外成功 | 立即停止 | strict expected error | FAIL | real gate |
| N-2 非 426 | 立即停止 | strict expected status/code | FAIL | real gate |
| identity 半状态 | fail-closed | paired delete/validation | device-tls-identity-incomplete | fault test |
| raw error/secret 将输出 | 终止输出 | allowlist serializer | sanitized failure | adversarial tests |

### 异常恢复

- 以原子 run state 为唯一恢复锚点。
- 网络传输失败只重传同一 bundle。
- rotate confirm 中断复用 production pending-token confirm recovery。
- rotate pending 超过 production TTL 后固定 FAIL 并停止；不得无限重试、重新 begin 或把过期恢复误报为 PASS，后续只能按专用测试清理/重建流程恢复。
- Controller 重启复用同一 dedicated data directory 与 Keychain service。
- identity replacement 半状态不自愈，明确 fail-closed 并转人工恢复。

### 状态侦测与运行后自检

- phase 状态机和固定 sanitized result 是运行信号。
- Controller status 只检查 boolean/count，不输出地址或 fingerprint。
- Endpoint 每阶段检查 Keychain/network/pin/错误码不变量。
- 自动测试覆盖 gate、mode、schema、redaction、状态机、幂等和 fault injection。
- 真实验收覆盖真实 Keychain、真实 TLS/LAN/SSH、两台 Mac、rotate/revoke/restart/fingerprint replacement。

## TDD 测试要求

`test/g0a-real-acceptance.test.js` 必须先 RED，至少覆盖：

1. gate 缺失时所有依赖调用次数为零。
2. run state 先于 Keychain/network 副作用持久化。
3. bundle/state 原子写入且最终 mode `0600`。
4. symlink、非普通文件、0644、未知字段、过期和 run id mismatch 在任何 secret/network 前拒绝。
5. sanitized serializer 拒绝递归敏感键和值；合成 path/IP/URL/fingerprint/code/token/private key/raw error 不得输出。
6. Controller 固定 stdin 命令与状态转换；跳阶段和重复副作用拒绝。
7. Endpoint receipt 的 mode/schema/run id/phase/PASS 校验；FAIL/BLOCKED、跨 run 或错误 phase 不推进状态。
8. management token 只传内存 adapter，不进入 bundle/state/output。
9. current production enroll/heartbeat/rotate 调用顺序。
10. old token 只存在闭包/局部内存，rotate 后真实 request adapter 得到固定拒绝。
11. N-1 enrollment/heartbeat body 使用 current-1；N-2 body 使用 current-2 并严格要求 426。
12. revoke、restart、fingerprint replacement 与 reenrollment 的状态迁移。
13. SCP 中断保持同一 bundle 可重传，不签发新 code。
14. Endpoint state 在凭证写入前记录由 `DeviceCredentialStore.itemId()` 精确派生的 item id；cleanup 只能删除 state allowlist 中的精确对象。
15. TLS identity 内部标识的注入式契约测试，命名漂移时在真实 replacement 前失败。
16. rotate pending 未过期可恢复，过期后固定 FAIL 且不重新 begin。
17. import helper 不自动执行、不注册 signal、不访问 Keychain/network。
18. README 明确 test-only、显式 gate、SSH alias、secret-safe bundle 和 Gold 仍 blocked。

自动测试使用注入 adapter、临时目录与合成 secret；它只证明 harness 契约，不得标记真实门 PASS。

## 真实验收顺序

1. Controller Mac real Keychain allow round-trip。
2. 用户 UI deny、lock、unlock 的 fail-closed / recovery。
3. 启动 Controller runner，验证 management loopback 与 Agent private bind。
4. `prepare`，通过 SCP alias 传输私密 bundle。
5. Endpoint `pre-revoke`：current、heartbeats、rotate、old-token reject、N-1、N-2。
6. 回传并 `ack-pre-revoke`，Controller `revoke-current`，Endpoint `post-revoke`，回传并 `ack-post-revoke`。
7. Controller `restart`，Endpoint `post-restart`，回传并 `ack-post-restart`。
8. 在已批准的 dedicated identity replacement 门下执行 replacement 与无 accept/accept 两相。
9. `prepare-reenrollment` 后传输新 bundle；Endpoint `post-fingerprint-change`、回传并 `ack-post-fingerprint-change`，再执行 `reenroll`、回传并 `ack-reenroll`。
10. 精确 cleanup，运行 Grok fresh review 和 Codex PM 终验，生成脱敏报告。

## 非目标

- 不新增生产 endpoint、正式 CLI command、Web UI 或默认脚本。
- 不增加自动网卡发现。
- 不读取或修改 `~/.ssh`。
- 不支持公网、wildcard、hostname 或非专用环境。
- 不把管理 token、device token、code 或 fingerprint 放入 argv/env/log/report。
- 不提供 Keychain 通配发现、扫描或批量删除。
- 不自动执行 macOS Keychain lock/unlock 或修改密码。
- 不绕过 TLS pin，不使用 `rejectUnauthorized:false` 作为信任替代。
- 不用 mock 或自动测试填充真实证据。

## 完成标准

- 设计和计划无占位符、矛盾或模糊 secret 流。
- harness RED/GREEN、focused、Step 4 与全量测试全部通过。
- Qwen adversary 与 Grok fresh reviewer 的有效 finding 已裁决；任何错误输出按 pm-dcw HOLD 处理。
- Codex PM 独立验证 scope、diff、mode、泄漏扫描、状态机和真实边界。
- 真实 Keychain allow/deny/lock/unlock 与第二 Mac 全流程通过。
- 最终报告只含允许字段；Git 中没有 bundle/state/secret。
- 所有真实门通过前，Gold 及相关 capability 继续 `BLOCKED`。
