# Linke V1.43 审计完整性安全轮转基座设计

## 1. 目标与版本签名

V1.43 在 V1.35–V1.40 的 journal、cross-store verifier、journal-first dual-write、run-once monitor 与本地多进程写锁基础上，交付一个**仅显式触发、可恢复、只增不减归档**的审计完整性轮转基座。

唯一允许的完成签名：

```text
V1.43 explicit crash-recoverable audit integrity rotation foundation
```

本版本只推进 M6d T6d.3 / production-hardening 的 partial evidence。实现完成后仍然：

- 不是 T6d.3 complete；
- 不是 M6d Exit；
- 不是 production-hardening ready；
- 不是 Gold / GA / V2；
- 不提供 HMAC、签名、外部可信锚、WORM 或外部日志投递；
- 不提供托管调度、自动阈值轮转、远程通知或跨主机锁；
- Gold scorecard 保持 `4 ready / 4 partial / 1 blocked / 9 total`。

## 2. 已验证的 V1.42 基线

当前 live 审计文件为：

```text
audit/events.jsonl
audit/integrity-journal.jsonl
audit/integrity-dual-write-state.json
audit/integrity-write.lock
```

冻结事实：

1. 普通 `appendAuditEvent` 通过 journal-first dual-write coordinator 写入 journal 与 events。
2. `integrity-dual-write-state.json` 是 schema v1 单槽 WAL/cursor，状态仅有 `idle` / `prepared`。
3. 同一 resolved data root 的写操作经共享进程内 queue、lease 与 `/usr/bin/lockf` 本地多进程排它锁串行。
4. journal v1 第一行是 `generation-open`，其后是 `event-link`；existing 4096 行可追加为 4097 行，再追加返回 typed bounds error。
5. journal v1 的 4097 是 validation bound，不是 retention，不会自动打开下一代。
6. cross-store verifier 支持 `equal`、`events-suffix-of-journal`、`journal-suffix-of-events`；空 J + 非空 E 是 `uncovered-events` partial。
7. run-once monitor 只读，不恢复、不修复、不调度、不发送通知。
8. `safeCreateExclusiveText` 使用 O_EXCL/O_NOFOLLOW、文件 sync、关闭与 best-effort parent sync；原子写 primitive 使用安全临时文件与 rename，但本设计不宣称断电级持久化保证。

## 3. 用户冻结的产品决策

以下决策不得由实现者、reviewer 或 PM 私自降低或替换：

1. **触发方式：** 仅显式 Agent CLI / 库 API；普通 append 不自动轮转；无 HTTP/Web；无托管调度。
2. **删除策略：** V1.43 永不自动删除历史归档；归档只增不减。
3. **归档单元：** 每代封存旧 journal、当时 events 精确快照与 canonical manifest；live `events.jsonl` 继续使用。
4. **跨代链接：** 新代使用 `generation-open` v2，绑定旧 generation、旧 head 与 archive manifest digest。
5. **恢复方向：** manifest commit point 前旧代保持 active；commit point 后只能向前完成新代。
6. **架构：** 独立 rotation coordinator + 独立 rotation WAL；不把 rotating 状态塞入 dual-write state；不迁移为 CURRENT pointer / per-generation live directory。

## 4. 候选方案与裁决

### A. 独立 rotation coordinator + 独立 WAL（选定）

优点：普通 append 热路径改动窄；轮转 phase 与 dual-write transaction phase 不混淆；恢复权威可显式定义。缺点：需要规定双 WAL 的优先级与互斥。

### B. 把 rotating 并入 dual-write state（驳回）

文件更少，但每次普通 append 都要承担轮转 schema、phase 与恢复分支；扩大 V1.37 hot-path 回归面。

### C. 每代目录 + CURRENT pointer（驳回）

长期布局整洁，但要迁移现有 live 路径、reader、monitor 与 dual-write cursor，范围已接近审计存储重构。

## 5. 架构与模块边界

新增模块：

```text
src/audit-integrity-rotation.js
  - rotateAuditIntegrityGeneration
  - recoverAuditIntegrityRotation
  - rotation protocol / preflight / recovery / receipt

src/audit-integrity-rotation-state.js
  - rotation WAL schema/parser/load/publish
  - archive manifest schema/parser/canonical serialization
  - 不 import coordinator / audit-log / agent
```

现有模块的窄改动：

```text
src/audit-integrity-journal.js
  - 保留 v1 exact parser/digest
  - 增加 homogeneous v2 generation parser/builder

src/audit-integrity-dual-write.js
  - ordinary append 在解释 dual-write state 前执行 rotation gate
  - 不负责启动或自动恢复 rotation
  - 导出 lease-bound read-only validateAuditIntegrityDualWriteIdleUnlocked
    供 rotation 复用；该 helper 不 bootstrap、不 recover、不写文件

src/audit-integrity-monitor.js
  - 先读取 rotation state
  - 非终态报告 recovery-required
  - completed 时复核最新 archive + live binding

src/agent.js
  - 两个显式 CLI；无 HTTP/Web route
```

依赖方向冻结：

```text
agent CLI
  -> rotation coordinator
       -> rotation-state / journal / dual-write internals / cross-store
       -> shared write queue + process lock lease

audit-log append
  -> dual-write coordinator
       -> rotation gate (read/check only)

monitor
  -> read-only rotation inspector
       -> existing read-only dual-write inspector
```

禁止 rotation-state import coordinator、audit-log、agent 或 monitor，避免循环。

## 6. 文件布局与安全路径

新增 live WAL：

```text
audit/integrity-rotation-state.json
```

每代归档：

```text
audit/archive/<previousGenerationId>/
  integrity-journal.jsonl
  events.jsonl
  manifest.json
```

约束：

- `<previousGenerationId>` 必须匹配 `^[0-9a-f]{32}$`，路径只从已验证的 live journal 生成；调用方不能传 archive 路径。
- 三个 archive leaf 使用 `safeCreateExclusiveText(..., {mode: 0o600})`；禁止 overwrite、rename-over、unlink 或自动清理已发布归档。
- archived journal 是旧 live journal 的完整 UTF-8 字节镜像，保留尾换行。
- archived events 是轮转开始时 live events 的完整 UTF-8 字节镜像；原 events 不存在时仍创建空归档文件，但 manifest 的 `present=false` 保留原始事实。
- manifest 最后创建；已有 leaf 时不区分文件/目录/symlink，对外统一冲突语义。
- 任一已有 archive leaf 的内容必须与 WAL 预期 raw length + SHA-256 精确匹配才可幂等继续；不匹配即 `rotation-conflict`。

## 7. Archive manifest canonical schema

manifest schemaVersion 为 1，canonical JSON 无尾换行，exact key order：

```text
schemaVersion
recordKind
rotationId
createdAt
previousGenerationId
previousJournalSchemaVersion
previousHeadDigest
journal
events
nextGenerationId
rotationEventId
rotationEventPayloadDigest
```

固定值与类型：

- `schemaVersion = 1`
- `recordKind = "audit-integrity-rotation-manifest"`
- `rotationId` / `rotationEventId`：lowercase UUID-like；两者相等
- `createdAt`：严格 ISO 字符串；同时用于 rotation event
- `previousGenerationId` / `nextGenerationId`：32 lowercase hex
- `previousJournalSchemaVersion`：1 或 2
- `previousHeadDigest` / `rotationEventPayloadDigest`：64 lowercase hex
- `journal` exact keys：`rawByteLength`, `rawSha256`, `recordCount`
- `events` exact keys：`present`, `rawByteLength`, `rawSha256`, `strictRecordCount`

`archiveManifestDigest = SHA-256(canonical manifest UTF-8 bytes)`。manifest 不保存自己的 digest，避免自引用。它保存 `nextGenerationId` 与 rotation event digest，但不保存 new journal head，因此不存在 digest cycle。

manifest 大小上界固定为 16 KiB；超限返回 rotation bounds error。

## 8. Journal v2 跨代协议

### 8.1 Homogeneous generation rule

单个 journal 文件必须是 homogeneous generation：

- v1 open 后只能有 v1 event-link；
- v2 open 后只能有 v2 event-link；
- 同一 journal 内混合 v1/v2 记录一律 `audit-chain-broken`；
- v1 archive + v2 live 是合法的跨代组合，不是同文件混合。

### 8.2 generation-open v2 exact keys

```text
schemaVersion
recordKind
generationId
previousGenerationId
previousHeadDigest
archiveManifestDigest
sequence
previousLinkDigest
payloadDigest
linkDigest
```

固定语义：

```text
schemaVersion = 2
recordKind = generation-open
sequence = 0
previousLinkDigest = null
payloadDigest = null
```

其余四个 digest/id 字段必须满足 32/64 lowercase hex 格式。

v2 open digest：

```text
SHA-256(
  "linke.audit-integrity-journal.v2.generation-open\0" +
  generationId + "\0" +
  previousGenerationId + "\0" +
  previousHeadDigest + "\0" +
  archiveManifestDigest + "\0" +
  "0\0null\0null"
)
```

### 8.3 event-link v2

event-link v2 继续使用 v1 的 7-key字段集合与顺序，但 `schemaVersion=2`，digest domain 改为：

```text
"linke.audit-integrity-journal.v2.event-link\0"
```

其余 preimage 顺序保持：

```text
generationId \0 sequence \0 previousLinkDigest \0 payloadDigest
```

v1 digest domain 与验证算法完全保留，不重写历史含义。

### 8.4 v2 首次发布

新 live journal 必须以**一次完整原子文件发布**同时包含：

1. generation-open v2（sequence 0）；
2. rotation event-link v2（sequence 1）。

禁止先发布只有 open 的空新代。普通 cross-store verifier 只比较 event-link payload digests，因此新 J 的首个 payload 是 rotation event，并可作为累计 E 的非空尾部，继续使用 `journal-suffix-of-events`。

### 8.5 Line and file bounds

- v1 任意行与 v2 event-link 继续使用既有 374-byte 上界。
- v2 open canonical 10-key 行的精确生成长度为 477 UTF-8 bytes；新增独立上界 477，不扩大 event-link 上界。
- journal 整文件 read bound 保持 1,572,864 bytes。
- record count 语义保持：open 计第 1 条，合法 post 最大 4097 条。

## 9. Rotation event

rotation event 使用现有 strict sanitized audit event schema，不新增自由 metadata：

```json
{
  "id": "<rotationId>",
  "createdAt": "<captured ISO time>",
  "type": "audit-integrity-rotation",
  "outcome": "committed",
  "operation": "generation-transition",
  "message": "audit integrity generation rotation committed"
}
```

事件只表达 manifest commit 后的 generation transition，不提前声明整个 CLI 已完成。previous generation/head/manifest digest 由 v2 open 与 manifest 承担，不塞入 message。

## 10. Rotation WAL schema 与权威优先级

WAL schemaVersion 为 1，最大 128 KiB。状态集合：

```text
prepared
archive-committed
journal-published
events-published
completed
```

顶层 canonical key order：

```text
schemaVersion
status
rotationId
createdAt
previousGenerationId
previousHeadDigest
nextGenerationId
archiveRelativePath
archiveManifestDigest
rotationEvent
journal
events
```

嵌套字段：

- `rotationEvent`：strict canonical event、eventLineUtf8、payloadDigest。
- `journal.previous`：schemaVersion、recordCount、headDigest、rawByteLength、rawSha256。
- `journal.next`：schemaVersion=2、recordCount=2、headDigest、rawByteLength、rawSha256。
- `events.sealed`：present、strictRecordCount、rawByteLength、rawSha256。
- `events.post`：present=true、strictRecordCount=sealed+1、rawByteLength、rawSha256。

WAL 只保存 fingerprints、rotation event line 与重建所需的有限参数，不保存 journal/events/manifest 的大文件 raw：

- recovery 每次从 archive/live 安全重读 raw，并根据 fingerprints 分类；
- next journal raw 由 journal 模块唯一 builder 按冻结参数重新生成并核对 fingerprint；
- events post 由 `sealed prefix + exact rotation event line` 重建并核对 fingerprint。

因此 WAL 的最终嵌套字段只保存 fingerprints，不保存任一大文件 raw。上述限制是强制的，禁止实现者为了方便扩大 WAL 到事件文件量级。

权威顺序：

1. 先解析 rotation WAL；
2. `prepared` / `archive-committed` / `journal-published` / `events-published` 时，普通 append 一律 `rotation-recovery-required`；
3. 只有 rotation WAL exact-missing，或 `completed` 且 current generation 与 receipt 一致时，才允许进入普通 dual-write state 解释；
4. rotation start 前必须确认 dual-write state 为 exact idle，禁止 dual-write prepared 与 rotation prepared 同时成立；
5. rotation state 字段是 recovery hint，不是完成事实；实际文件 pre/post/other 分类拥有最终裁决权。

新一轮 rotation 只能在旧 WAL 为可验证 completed 后原子发布新的 prepared，形成单槽复用。旧 completed receipt 可由 archive manifest 与后续 generation-open 链重建。

## 11. Public API 与 Agent CLI

库级入口：

```js
rotateAuditIntegrityGeneration(dataDir, {
  expectedGenerationId,
  expectedHeadDigest,
})

recoverAuditIntegrityRotation(dataDir)
```

Agent CLI：

```bash
node src/agent.js audit-integrity-rotate \
  --data-dir <path> \
  --expected-generation-id <32hex> \
  --expected-head-digest <64hex>

node src/agent.js audit-integrity-rotation-recover \
  --data-dir <path>
```

禁止新增 HTTP/Web route、按钮、后台 timer 或 scheduler 注册。

成功 receipt exact keys：

```text
state
rotationId
previousGenerationId
generationId
archiveRelativePath
archiveManifestDigest
previousRecordCount
newRecordCount
relationship
```

`state` 只允许 `rotated` / `already-completed`。receipt 不含绝对路径、原始事件、底层 errno、stack 或凭证。

CLI exit：

- `0`：rotated / already-completed；
- `1`：argv 或未分类 program error；
- `2`：typed precondition、recovery-required、conflict、bounds 或 integrity refusal。

## 12. Start protocol

`rotateAuditIntegrityGeneration` 在任何持久写入前完成：

1. 同步读取并冻结 expected generation/head 参数；非法输入快速拒绝。
2. `assertSafeDataRoot` 后进入共享 queue，获取 active lease 与本地 process lock。
3. load rotation WAL：非终态则 recovery-required；completed 必须先做事实复核。
4. load dual-write state：必须 idle；prepared 或 invalid 拒绝。
5. 调用 lease-bound read-only `validateAuditIntegrityDualWriteIdleUnlocked`，复用现有 cursor 与 cross-store SoT 验证 live stores；不复制公式、不 bootstrap、不 recover。
6. actual generation/head 必须等于 expected 值，否则 precondition-failed。
7. 读取并冻结旧 journal/events raw；执行 UTF-8、line、count、size 与 fingerprint 校验。
8. 生成 rotationId、createdAt、nextGenerationId、rotation event、manifest、manifest digest 与完整 v2 journal post fingerprint。
9. 构造 events post = sealed exact bytes + rotation event line；不得应用新的隐式 retention。
10. events post 必须 ≤8192 strict lines、≤16 MiB；journal post 必须满足 v2 line/file/count bounds。
11. 验证 archive relative path 可派生；不读取用户提供的 archive path。
12. 发布 `prepared` WAL，并精确回读。

任何 preflight 错误均保证 archive/live/WAL 未改变。

## 13. Archive 与 cutover protocol

在同一 lease / process lock 下依次执行：

1. exclusive-create archived journal；created=false 时只允许 exact fingerprint match。
2. exclusive-create archived events；同上。
3. 对两者安全回读并重新计算 fingerprints。
4. exclusive-create canonical manifest，安全回读并校验 raw identity/digest。
5. **实际 manifest 存在且三文件验证通过**即 commit point；WAL phase 落后不改变事实。
6. 发布 `archive-committed`。
7. 以 atomic write 发布完整 new v2 journal（open + rotation event-link），回读核对 exact fingerprint。
8. 发布 `journal-published`。
9. 以 atomic write 发布 events post 镜像，回读核对 exact fingerprint。
10. 发布 `events-published`。
11. 发布新的 ordinary dual-write idle：generationId=next；journal/events fingerprints=实际 post；lastTransactionId=rotationId；lastPayloadDigest=rotation event digest；lastSequence=1。
12. 复用 cross-store SoT；期望关系为 `journal-suffix-of-events`，若 sealed events 原本为空则也可为 `equal`。
13. 发布 `completed`。
14. 从实际 archive/live/state 重算最终 receipt，再调用 in-process read-only monitor logic；只有 healthy 才返回 exit 0。

journal 与 events 是两个文件，不能宣称跨文件原子。`journal-published` 与 `events-published` 之间的中间态由 nonterminal rotation WAL 隔离；普通 append/monitor 不得把它当正常态。

## 14. Recovery protocol

`recoverAuditIntegrityRotation` 必须显式调用，不由普通 append 暗中触发。

### 14.1 Commit point 前

- manifest 不存在：旧 live journal + old dual-write idle 是恢复锚点。
- archive journal/events exact missing：创建。
- archive leaf 已存在且 exact match：幂等跳过。
- archive leaf 占用但不匹配：conflict；不覆盖、不删除。
- old live 任一 fingerprint 变化：conflict；不基于新内容重基线。

### 14.2 Commit point 后

manifest 存在且完整 bundle 验证通过后，只允许向前：

| Store | exact pre | exact post | other |
|---|---|---|---|
| live journal | 发布 v2 post | 跳过 | conflict |
| live events | 发布 events post | 跳过 | conflict |
| dual-write idle | 发布 new idle | 跳过 | conflict |

每步实际文件可以领先 WAL phase；recovery 依据 bytes/fingerprints 前进，然后补 phase。禁止仅凭 status 字段跳过验证。

### 14.3 Completed idempotency

`already-completed` 必须同时满足：

1. archive manifest raw digest 自校验；
2. archive journal/events fingerprints 与 manifest 一致；
3. live v2 open 的 previous generation/head/manifest digest 与 archive 一致；
4. dual-write state idle generationId 与 live v2 journal 一致；
5. cursor 与 cross-store 实际验证成功；
6. rotation event 在 new journal 中精确出现一次；若 live events 仍保留该事件则也只能出现一次。后续合法 retention 可以从 live events 删除该旧事件，此时以既有 `events-suffix-of-journal` 关系验证，不把缺失误判为 rotation failure。

WAL `status=completed` 单独不构成成功。

## 15. Ordinary append 与 monitor gate

### 15.1 Append

普通 append 获取同一 queue/lease/lock 后，在解释 dual-write state 前检查 rotation state：

- exact missing：继续既有流程；
- valid completed 且 current generation 等于 receipt next generation：继续既有流程；
- nonterminal：`audit-integrity-rotation-recovery-required`；
- invalid/io：返回对应 typed rotation error；
- 不自动 recover、不写 archive、不静默继续旧代。

### 15.2 Monitor

monitor 保持 read-only：

- nonterminal：condition=`rotation-recovery-required`，exit 2；
- rotation state invalid/io：integrity alert，exit 2；
- completed：从实际文件验证 current binding 与**最近一代** archive bundle；
- 验证通过后再运行既有 dual-write/journal/cross-store checks；
- 不调用 recover、不写文件、不删除归档、不读取报告文件作为权威。

V1.43 monitor 不承诺每次运行深扫所有历史 archive bytes；完成时深验本次 bundle，后续 monitor 深验 current 直接引用的最近 archive。全历史离线扫描与外部投递属于后续 milestone。

## 16. Error contract

新增最小 ERROR_CODES：

```text
AUDIT_INTEGRITY_ROTATION_STATE_INVALID
  audit-integrity-rotation-state-invalid

AUDIT_INTEGRITY_ROTATION_IO_ERROR
  audit-integrity-rotation-io-error

AUDIT_INTEGRITY_ROTATION_PRECONDITION_FAILED
  audit-integrity-rotation-precondition-failed

AUDIT_INTEGRITY_ROTATION_RECOVERY_REQUIRED
  audit-integrity-rotation-recovery-required

AUDIT_INTEGRITY_ROTATION_CONFLICT
  audit-integrity-rotation-conflict

AUDIT_INTEGRITY_ROTATION_BOUNDS_EXCEEDED
  audit-integrity-rotation-bounds-exceeded
```

现有 journal、cross-store、dual-write 与 process-lock typed errors 原样传播。所有新增错误 path-free：message===registered code；不附 cause/path/errno/raw content。

错误优先级：argv/input → root/rotation-state IO/schema → nonterminal gate → dual-write idle/cursor → expected precondition → bounds → archive/cutover conflict。

## 17. 并发、TOCTOU 与安全边界

- rotate/recover/append 使用同一 resolved-root queue key 与同一 process lock；一次只允许一个 mutation task。
- 所有调用参数在首个 await 前冻结；Proxy/getter/extra/symbol key 按既有 hostile-object 风格 fail-closed。
- expected generation/head 只作 stale-operator precondition，不是认证。
- archive identity 由 old generationId 派生；随机 rotationId 不进入路径选择。
- dual-write prepared 与 rotation prepared 互斥；rotation state 优先于 stale old dual-write idle。
- process lock 仅保证同一 Mac、本地受支持文件系统上的排它；不宣称 distributed / cross-host / network-FS correctness。
- SHA-256 只提供结构绑定与字节比较，不提供外部真实性。
- 不读取 `.env`、凭证、SSH、云认证目录或任何 API key。

## 18. 项目级运行韧性设计门

### 18.1 正常态

- rotation WAL exact missing，或 valid completed；
- current dual-write state idle；
- live journal/events/cursor match；
- current v2 open 与最近 archive manifest/old head 绑定一致；
- monitor healthy；rotate/recover exit 0。

### 18.2 恢复锚点

- commit 前：old live journal + old idle cursor；
- commit 后：exclusive archive bundle + canonical manifest；
- completed：new live journal/events + new idle + archive bundle。

### 18.3 三支柱

**有界失效：** exact schema/size/count/path bounds；5-second process-lock timeout沿用；O_EXCL archive；pre/post/other 分类；任何不确定态 fail-closed。

**异常恢复：** process crash 后显式 recover；commit 前按 old anchor 续建 archive，commit 后确定性 roll-forward；不回滚/覆盖已提交 archive；重复 recover 幂等。

**状态侦测与运行后自检：** rotation WAL priority gate；monitor nonterminal alert；每步 post-read fingerprint；最终 archive/live/cursor/cross-store/monitor 全部重算。

### 18.4 最低风险扫描

| 风险 | 设计处置 |
|---|---|
| 外部依赖退化 | 无网络依赖；本地 lockf unavailable typed fail-closed |
| 数据持久化/一致性 | phase WAL + actual byte classification；不宣称断电级保证 |
| 队列积压/超时 | 复用 bounded lock timeout；不无限重试 |
| 配置/凭证缺失 | 无新增凭证；expected args 显式校验 |
| 启动/关闭顺序 | explicit rotate/recover；nonterminal append/monitor gate |
| 迁移/回滚 | v1 read compatibility；commit 后无 archive rollback |
| 资源耗尽 | 既有 journal/events bounds + WAL/manifest bounds |
| 告警 | run-once monitor exit 2；无远程通知 |

最高风险验收路径：manifest committed 后，在 journal/events/state 三个 cutover 边界终止真实子进程；重启 recover 必须检测信号、前向完成、回到正常态。

## 19. 测试与验收

Qwen 只读统计给出的下限经 Codex 修订为新增 64 项：

| 类别 | 最低新增 |
|---|---:|
| rotation schema/state parser | 7 |
| journal v1/v2 与跨代绑定 | 6 |
| archive/manifest | 7 |
| coordinator phases/commit point | 7 |
| crash recovery/idempotency | 9 |
| concurrency/real multiprocess lock | 6 |
| append/monitor/retention gates | 7 |
| Agent CLI | 5 |
| source/security/version scans | 4 |
| real filesystem acceptance | 6 |
| **总计** | **64** |

现有选定审计测试文件共有 437 个 `it/test` 基线；这不是全仓总数。64 是计划下限，不是已存在或已通过声明。

### 19.1 Effective RED

从 V1.42 父提交隔离树仅应用新增测试；必须因缺少 rotation API/schema/behavior 失败。syntax/import/fixture/path 错误不算 RED。

### 19.2 GREEN 与回归

1. focused rotation tests；
2. existing 437 audit tests；
3. full `npm test`；
4. source/security/version scans；
5. Git status/diff/allowlist 与 protected-file hashes。

### 19.3 Crash points

至少覆盖：

```text
CP0 after prepared
CP1 after archive journal
CP2 after archive events
CP3 after manifest commit
CP4 after new journal publish
CP5 after events publish
CP6 after new dual-write idle publish
```

每点验证：信号出现 → process exit → fresh recover → exact convergence → second recover idempotent → normal append succeeds。

### 19.4 Real boundary

- 临时真实 data root；
- 真实 safe file operations / rename / exclusive create；
- 真实 `/usr/bin/lockf`；
- 真实 child process termination；
- 至少两进程 rotate-vs-append、rotate-vs-rotate；
- archive files byte-for-byte 检查；
- 不使用生产数据，不触发网络/邮件/调度。

### 19.5 Required canaries

- v1 old journal → v2 new journal；同 journal 混合 v1/v2 拒绝。
- v2 open 字段、key order、477-byte bound 与 digest vectors。
- journal 4097；events 8192 / 16 MiB；所有失败发生在 prepared 前。
- retention enabled/disabled 的 current cross-store relation。
- archive EEXIST exact match vs mismatch。
- manifest exists + WAL phase stale。
- journal/events/state each pre/post/other。
- rotation event 在 journal 中 exactly once；完成瞬间在 live events 中 exactly once；后续 retention 删除旧事件仍保持合法关系。
- nonterminal append recovery-required；monitor read-only exit 2。
- 无 scheduler/auto rotate/HTTP/Web/archive deletion path。
- path-free receipts/errors；无 absolute path、raw event、errno、stack、secret。

## 20. 文档、版本与 Git 边界

实现阶段允许按 plan 明确列出的文件修改；`package-lock.json` 是用户未跟踪文件，始终禁止读取、修改、暂存或提交。

版本升至 V1.43 时，README/version/gold-readiness 必须同时写明：

- explicit crash-recoverable audit integrity rotation foundation delivered；
- no automatic rotation / scheduler / remote notification；
- archives are append-only by product policy but not WORM/authenticity；
- T6d.3 still partial；production-hardening partial；Gold blocked 4/4/1/9；
- no M6d Exit / Gold / GA overclaim。

设计文档本身不改变 runtime/version/Gold 状态。

## 21. Review record

### 21.1 GLM-5.2 fresh adversary

状态：`DONE_WITH_CONCERNS`。

采纳：

- 新 journal 必须一次发布 open+rotation event，消除空新代窗口；
- rotation WAL 优先于 stale dual-write idle；
- 双 WAL 互斥与恢复顺序必须冻结；
- events sealed fingerprint/byte cursor 必须进入协议；
- completed receipt 必须由实际文件重算；
- monitor success 使用 in-process只读逻辑，不依赖报告文件。

驳回：

- “跨代必须新增 scoped cross-store relation”。源码事实显示 current-generation 非空 J 是累计 E 的尾部时，既有 `journal-suffix-of-events` 已可表达；采用 open+rotation event 同图发布后无需复制或分叉 cross-store 公式。

### 21.2 Qwen statistics

状态：`DONE_WITH_CONCERNS`。

采纳 64 项计划下限；修正“同一 journal v1/v2 mixed chain”为“v1 archive → v2 live transition”，并在 64 内补入 retention/cross-store interactions。

### 21.3 GLM-5.2 second fresh adversary attempt

第二轮 fresh 调用等待完整 300 秒后返回 `dashscope_glm_error:timeout`，没有模型结论。该结果既不是反对意见，也不是 PASS，不纳入设计通过证据。流程进入 `SUB_AGENT_REVIEW_HOLD` 后，用户选择 A：丢弃该超时输出，以第一轮有效 GLM 抗辩、Qwen 统计与 Codex 自审作为设计证据，并批准提交本文。

## 22. Definition of Done

设计阶段完成标准：

- 用户批准架构、状态机、接口、韧性与测试五节；
- 本文不存在未决占位项；
- GLM findings 有明确采纳/驳回证据；
- Qwen 统计经 Codex 修订；
- 用户复核本文后才进入 writing-plans。

实现阶段完成标准由后续 plan 拆解，但至少包括：有效 RED、focused GREEN、现有审计回归、full suite、真实进程 crash recovery、fresh reviewer、Kimi closure reviewer 与 Codex verifier 终验。任何模型 PASS 都不替代 Codex 的可复现实证。
