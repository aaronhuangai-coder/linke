# Linke V1.46 用户级双 LaunchAgent 生命周期设计

- **日期：** 2026-07-28
- **状态：** 书面设计已获用户批准，待独立 commit 授权
- **设计基线：** `564f624061b78b882d82c6f55a8f50a985463781`（V1.45）
- **目标版本：** V1.46 implementation candidate
**严格度：** pm-dcw `h`

## 1. 冻结完成定义

本阶段交付用户级双 LaunchAgent 的真实适配器、事务恢复实现和受控验收工具，但不在当前 Mac 安装、不调用真实 `launchctl`、不写 `~/Library/LaunchAgents`、不部署、不写生产环境。

代码阶段只有同时满足以下条件才算完成：

1. controller 与 scheduler 两种 profile 均有严格渲染和 schema 校验。
2. Linke ownership、双 plist 回滚锚点、持久化事务 journal、独占事务锁均实现 fail-closed 契约。
3. install、upgrade、stop、rollback、uninstall、recover 均通过注入式 host adapter 编排。
4. 在新建临时根执行真实文件 write、fsync、同目录 rename、hash、rollback，并以真实 `/usr/bin/plutil -lint` 校验 plist。
5. `launchctl` 使用注入式 fake runner 完成顺序、超时、错误映射和补偿测试；本阶段真实 runner 必须保持禁用。
6. Codex verifier 独立重建有效 RED、GREEN、相关回归和完整 `npm test`。
7. 后续 clean non-production Mac 真实验收仍是单独授权门；未通过前 `automation-installation` 保持 `partial`，项目仍非 Gold。

完成定义冻结后不得通过降低验收口径、改成全 mock、跳过故障注入或修改 Gold 判据来收口。

## 2. 当前事实与问题

- 当前运行版本为 V1.45，Gold 为 `6 ready / 3 partial / 0 blocked / total 9`。
- 剩余 partial 为 `automation-installation`、`security-auth`、`production-hardening`。
- `src/agent.js` 当前只生成 `StartInterval + run-once` 的 launchd dry-run plist，且明确拒绝写入 `~/Library/LaunchAgents`。
- `src/controller-runtime.js` 已提供独立常驻 controller、双 listener、幂等 SIGINT/SIGTERM 关闭和脱敏状态日志。
- `src/supervisor-lifecycle.js` 约 9,000 行，已有大量 plan/readiness/proof 逻辑；全局真实执行事实仍为 false。
- 当前仅 3/7 real-proof capability kinds（render/status/audit），没有托管 launchd 生命周期。
- 未跟踪的 `package-lock.json` 属于用户工作区噪声；本设计、实现、测试和提交均不得读取、修改或纳入。

## 3. 用户批准的设计决策

| 决策 | 已批准内容 |
| --- | --- |
| A | 先实现真实 adapter 与受控验收工具；当前 Mac 不安装；clean Mac 真实验收另行授权 |
| A1 | 仅支持当前用户 LaunchAgent：`gui/<uid>` 与 `~/Library/LaunchAgents`；不支持 LaunchDaemon、`sudo` 或系统级安装 |
| R1 | 两个独立 LaunchAgent：常驻 controller + 定时 scheduler/run-once |
| U1 | 仅当现有 plist 可验证为 Linke 管理且身份匹配时才允许锚定后原子替换；不匹配即拒绝 |
| 架构 A | 新建聚焦 Node adapter/transaction 模块；不把真实宿主变更塞入现有大型 planner，不采用 shell 脚本实现 |

## 4. 范围

### 4.1 本阶段包含

- 用户级 controller profile：`RunAtLoad=true`、`KeepAlive=true`。
- 用户级 scheduler profile：`StartInterval`，`RunAtLoad=false`，`KeepAlive` 缺失或 false。
- 严格的 profile、ownership manifest、anchor、journal、receipt schema。
- U1 身份与哈希校验。
- 同目录原子发布和双 profile 事务补偿。
- 注入式 `launchctl` 参数数组 runner、状态探测器和健康检查器。
- 临时根真实文件边界与真实 `plutil` 契约。
- 后续真实验收 runner 的默认禁用入口、显式 gate 和证据 schema。
- V1.46 文档与 Gold honesty 更新；状态仍为 partial。

### 4.2 本阶段不包含

- 当前 Mac 或任何生产 Mac 的真实 install/start/stop/upgrade/rollback/uninstall。
- 真实 `launchctl` 调用或 `~/Library/LaunchAgents` 写入。
- LaunchDaemon、root、`sudo`、系统级路径。
- Token、密码、API Key、TLS 私钥或其它凭证的存储、迁移、输出或 plist 注入。
- `security-auth`、`production-hardening` 状态提升。
- 自动调度 audit rotation、自动删除、远程通知或生产监控。
- commit、push、部署和 Gold/GA 声明。

## 5. 架构

采用聚焦模块，不向 `src/supervisor-lifecycle.js` 继续堆入真实宿主 I/O。

### 5.1 Profile renderer

职责：

- 纯函数生成 controller 和 scheduler descriptor/plist。
- 验证 Label、文件名、ProgramArguments、布尔项和 schedule 上下限。
- 拒绝未知字段、placeholder、shell 命令、相对可执行路径和敏感环境变量。
- 生成 canonical plist hash。

controller profile：

- 运行 `src/controller-runtime.js` 的独立常驻入口。
- `RunAtLoad=true`。
- `KeepAlive=true`。
- 不使用 `StartInterval`。

scheduler profile：

- 运行 `src/agent.js run-once --config <path>` 或等价的固定代码拥有入口。
- `StartInterval=<validated scheduleSeconds>`。
- `RunAtLoad=false`。
- `KeepAlive` 缺失或 false。
- scheduler 正常退出不算 crash。

plist 可以包含运行所需本地绝对路径，但 receipt、HTTP、Web 和 CLI 摘要不得回显这些路径。认证材料不得进入 ProgramArguments 或 EnvironmentVariables。

Profile renderer 不自行接受任意绝对脚本路径。`runtimeBinder` 从同一个 canonical immutable installation root 解析固定 pathId：controller 的脚本参数必须字节全等于 `src/controller-runtime.js` 的解析结果，scheduler 的脚本参数必须字节全等于 `src/agent.js` 的解析结果，Node executable 也必须等于 binder 解析的固定 host runtime。纯内存 render/schema 可在 pre-lock 门周围发生，但**不得**因此提前 `writeCandidate` 或 plutil candidate I/O。对 installation-root 实际文件的 live runtime revalidation，以及对 LaunchAgents ownership/label/file 的 inspection，必须落在 `prepared` 之后（并在 manifest 发布前、每次 bootstrap 前和 transaction commit 前再次复核）；root、pathId、argv 或 hash 任一不一致均零加载并补偿。

### 5.2 Ownership store

职责：

- 维护当前 Linke 安装身份。
- 决定 `first-install`、`managed-upgrade` 或 `ownership-mismatch`。
- 当前文件哈希与 manifest 不一致时拒绝覆盖。

manifest 为严格闭合 schema：

```json
{
  "schemaVersion": 1,
  "installationId": "opaque-stable-id",
  "scope": "user-launch-agent",
  "sourceCommit": "40-lowercase-hex",
  "runtimeArtifacts": {
    "node": {
      "pathId": "host-node-executable",
      "sha256": "64-lowercase-hex"
    },
    "controller": {
      "pathId": "src/controller-runtime.js",
      "sha256": "64-lowercase-hex"
    },
    "agent": {
      "pathId": "src/agent.js",
      "sha256": "64-lowercase-hex"
    }
  },
  "transactionId": "opaque-id",
  "controller": {
    "label": "fixed-validated-label",
    "filename": "basename-only.plist",
    "plistSha256": "64-lowercase-hex"
  },
  "scheduler": {
    "label": "fixed-validated-label",
    "filename": "basename-only.plist",
    "plistSha256": "64-lowercase-hex"
  },
  "activeAnchorId": "opaque-id",
  "installedAt": "UTC-ISO-8601"
}
```

禁止 manifest 包含 Token、密码、完整 argv、EnvironmentVariables、绝对路径或原始 `launchctl` 输出。

### 5.3 Anchor store

每次改变托管态前冻结一个双 profile last-green 锚点：

- 旧 controller 条目是严格 tagged union：`priorState=bytes` + bytes/SHA-256/identity，或 `priorState=absent`。
- 旧 scheduler 条目使用同一严格 tagged union。
- 旧 manifest 条目也是 `bytes` + 快照/hash，或 `absent`。
- 两个 label 原加载状态布尔值。
- anchor ID、parent anchor ID、transaction ID、source commit、purpose、rollback-from manifest hash/absence、restore manifest hash/absence、创建时间。
- `purpose` 闭合枚举至少包含：`first-install`、`managed-upgrade`、`stop`、`rollback-compensation`、`uninstall-compensation`。`stop` 与其它 purpose 一样必须经 production `validateLaunchAgentAnchor` 闭合验证；非法 schema/字段/枚举在任何 launchctl 或宿主 mutation 前 fail closed。

anchor 只保存 Linke 自己允许写入的非敏感 plist 和 manifest；若现有文件未通过 ownership 校验，不得复制、覆盖或认领。为保证 byte-exact rollback，anchor 允许在 plist bytes 内保留本地绝对运行路径，但必须位于 mode 0700 的 Linke metadata 根、文件 mode 0600，且禁止进入 receipt、日志、HTTP、Web、CLI 摘要或调试附件。

last-green anchor 至少保留到下一次完整事务成功且新锚点验证通过。rollback target 只有在当前 manifest hash/absence 精确等于其 `rollback-from` 且当前 manifest 的 `activeAnchorId` 精确指向它时才可应用；成功恢复后，旧 manifest 快照中的 parent activeAnchorId 自然成为下一目标，已应用 target 因当前身份不再匹配而不能重复应用。rollback attempt 的 compensation anchor 仅用于本次失败恢复，不晋升为 active target。清理策略不在本阶段自动执行。

### 5.4 Host adapter

Host adapter 是真实宿主操作的唯一边界：

- `hostInspector`：只读 lstat、read、hash、canonicalize；不得 open-for-write。
- `metadataStore`：只允许在 mode 0700 metadata 根的固定 journal/anchor/receipt/candidate 名称上执行 open/write/fsync 与条件发布；不能解析或写 LaunchAgents basename。除既有 per-transaction `readJournal({ transactionId })` 外，必须提供零参数只读全局 journal-head snapshot：`readJournalHeads()`（合同见下）。
- `atomicPublisher`：`publishAbsent`、`replaceIfMatch`、`removeIfMatch` 三个条件 mutation 原语；`publishAbsent` / `replaceIfMatch` 精确接收 opaque candidate ref `{ kind:'candidate', transactionId, role, sha256 }`（与 metadata-store `writeCandidate` 返回值同形），不得接受 raw bytes、绝对路径或 basename 旁路。
- `plistValidator`：固定 `/usr/bin/plutil` + 参数数组，不调用 shell。
- `launchctlRunner`：固定 `/bin/launchctl` + 参数数组，不接受命令字符串。
- `healthChecker`：只读 loopback controller health，固定 30 秒上限。
- `clock`、`accountResolver` 和 receipt sink 通过窄接口注入。

#### 5.4.1 `metadataStore.readJournalHeads()`（全局 journal-head snapshot）

只读、零参数接口。不得接受 `transactionId`、路径或任何 caller 过滤参数。不得写、rename、fsync、锁、receipt、durability-event 或其它 I/O mutation。不得改变既有 `readJournal({ transactionId })` 的合同与行为。不得从 safe public `index.js` 导出全局可写或任意索引能力。

实现必须经现有受限 journal 读取/验证路径读取整个 bounded append-only `transaction-journal.json`（沿用 16 MiB 上限）。每一条 entry 都必须完整 schema/chain 验证；同一 `transactionId` 的每条 entry 还必须保持同一个不可变 `operation`。损坏、截断、未知/非法 entry，或 `install -> managed-upgrade` 等 operation 漂移，一律使整个 snapshot fail closed；禁止返回 partial heads、截断修复或跳过坏行。

返回 deeply frozen、detached 的精确闭合对象：

```js
{
  kind: 'journal-heads',
  journalSha256: '64-lowercase-hex',
  heads: [
    /* validated latest entry projection per transactionId, lexicographic ascending by transactionId */
  ],
}
```

- `journalSha256`：本次已经完整验证的 journal **精确 bytes** 的 SHA-256。journal 文件不存在时等于空 bytes 的 SHA-256。该值由 store 计算，不得由 caller 提供或覆盖。
- `heads`：每个 `transactionId` 的最新有效 entry；按 `transactionId` 字节/词典序稳定升序。每个 entry 是 detached、深冻结的 validated projection，不得泄露 raw path、stdout/stderr、argv/env 或 secrets。

本阶段 production/default 组合必须拒绝真实 launchctl；库导出和普通 CLI composition root 只能构造 fake 或 hard-disabled runner。真实 runner 的构造函数需要不可序列化的 acceptance capability；该 capability 只能由独立 acceptance 入口在 `--execute`、非生产确认、当前 uid、canonical 用户 LaunchAgents 根、sourceCommit 与 runtime artifact hashes 对齐全部成立后生成，缺一项均不可构造或注入真实 runner。

capability 由 acceptance-only 密封工厂铸造：constructor/brand 不 export，以模块私有 object identity 校验，不接受 caller 构造的同形对象。真实 acceptance composition root 直接绑定 production `accountResolver`、`hostInspector`、`metadataStore`、`atomicPublisher`、`launchctlRunner` 与 health client，不提供依赖注入参数；测试 composition root 永远只能拿到 fake/hard-disabled runner，不能通过 fake host facts 铸造真实 capability。

`accountResolver` 的真实实现必须从 macOS account database / Directory Service 按当前 uid 解析 home，固定 `LaunchAgentsRoot = resolvedHome/Library/LaunchAgents`；禁止使用 `$HOME`、`os.homedir()`、caller 路径或环境变量作为权限事实。该 OS 解析能力不可用或结果与当前 uid 不闭合时，真实 adapter fail-closed。

非生产确认采用独立两阶段工件：只读 `acceptance prepare` 生成绑定 acceptanceId、uid、canonical root、sourceCommit 与 runtime hashes 的脱敏 request；用户另行确认该精确 acceptanceId 后，真实入口才接受一次性的 `nonProductionConfirmationId` 铸造 capability。铸造前，metadataStore 必须查询 mode 0700 根内的 durable consumed-confirmation index，并用 no-clobber 条件写入/ fsync 绑定 confirmation ID 与 acceptance identity 的消费记录；写入失败、已存在或复核失败都不得 mint，宁可安全烧毁一次性 ID。`--execute` 与 confirmation ID 是两个独立必需输入，receipt 必须记录两者的闭合布尔与 confirmation ID；缺失、重放或绑定不符均拒绝。

允许的后续真实 argv 形态仅包括：

- `bootstrap gui/<uid> <plistPath>`
- `bootout gui/<uid>/<label>`
- `kickstart -k gui/<uid>/<label>`
- `print gui/<uid>/<label>`

不得使用 shell、`eval`、管道、重定向、通配符或用户提供的任意子命令。

真实 adapter 在每次调用时还必须复核：uid 等于当前用户、domain 精确为 `gui/<uid>`、label 在固定双 label allowlist、plistPath canonicalize 后是该 uid 的 `~/Library/LaunchAgents` 直属普通文件且与 manifest filename 一致。入口 gate 通过不替代逐调用复核。

### 5.5 Transaction coordinator

职责：

- 获取独占事务锁。
- 驱动持久化 journal 状态机。
- 编排 install、upgrade、stop、rollback、uninstall、recover。
- 任一步失败时执行逆序补偿。
- 输出闭合枚举的脱敏 receipt。

状态机按 operation 分支；每次宿主可见 mutation 前后都必须有可恢复的 journal 状态：

```text
prepared
  -> anchored

first-install:
  anchored
  -> controller-publish-intent -> controller-published
  -> scheduler-publish-intent -> scheduler-published
  -> manifest-publish-intent -> manifest-published
  -> controller-load-intent -> controller-loaded
  -> controller-ready
  -> scheduler-load-intent -> scheduler-loaded
  -> committed

managed-upgrade / rollback:
  anchored
  -> scheduler-stop-intent -> scheduler-stopped
  -> controller-stop-intent -> controller-stopped
  -> controller-publish-intent -> controller-published
  -> scheduler-publish-intent -> scheduler-published
  -> manifest-publish-intent -> manifest-published
  -> controller-load-intent -> controller-loaded
  -> controller-ready
  -> scheduler-load-intent -> scheduler-loaded
  -> committed

stop:
  anchored
  -> scheduler-stop-intent -> scheduler-stopped
  -> controller-stop-intent -> controller-stopped
  -> committed

uninstall:
  anchored
  -> scheduler-stop-intent -> scheduler-stopped
  -> controller-stop-intent -> controller-stopped
  -> scheduler-remove-intent -> scheduler-removed
  -> controller-remove-intent -> controller-removed
  -> manifest-remove-intent -> manifest-removed
  -> committed

post-lock preflight blocker with zero host mutation:
  prepared -> blocked

any non-terminal operation state
  -> compensating
  -> recovered | manual-intervention-required
```

journal 每次状态推进都必须原子落盘并校验前态；不允许跳跃、倒退或 caller 覆盖状态。每个 `*-intent` 固定记录 role、目标 basename、expected identity/absence、candidate hash 或 remove expectation；进程若在 mutation 返回前退出，recover 必须同时检查该 intent 的合法 pre/post 两种实态。

若某个 candidate hash 与 prior hash 相同，该 role 不得执行替换，而是写入显式 `role-noop` checkpoint；**全部** profile、manifest 与 runtime artifact hash 均未变化时，upgrade 直接返回 `no-change`，host mutation count=0。若仅 `sourceCommit` 变化而 controller/scheduler profile bytes 与 runtime artifact hash 不变，则 **必须** `committed` 且仅 `publish-manifest`（两 plist 写 `role-noop`），**不得** 收口为 `no-change`。真正的 replace post-state 除 candidate hash 外还必须证明 device/inode identity 相对 expected pre-state 已变化，避免相同内容造成 pre/post 歧义。

状态机中的 stop/load 边同样允许严格的 `role-stop-noop` / `role-load-noop` 替代 checkpoint：只有目标 loaded 布尔已等于 anchor/operation 目标时才能使用，且必须实际探测确认；no-op 不调用 launchctl。

进入 `compensating` 时必须一次性冻结有界 reverse plan，不允许嵌套生成第二个补偿计划。每个补偿动作都有独立 `compensate-<action>-intent/completed`、固定 expected pre/post 与幂等判定；补偿期间再次崩溃时只恢复或完成当前 action。任何实态不匹配、条件 mutation 失败或补偿 action 复核失败都直接进入 `manual-intervention-required`，不得再启动新的自动宿主 mutation 循环。

#### 5.5.1 全局占用与双快照闭合（`readJournalHeads`）

锁文件不是唯一并发事实。全局 journal-head snapshot 是普通 operation 的权威占用事实源。不得用 per-transaction `readJournal({ transactionId })` 冒充全局 heads；caller 不知道旧 `transactionId` 也不能越过。

对每个普通 install / managed-upgrade / stop / rollback / uninstall：

1. **pre-lock**：在创建新 transaction、追加任何当前 operation journal、acquire lock 或任何 host mutation **之前**，调用 `readJournalHeads()`。
2. **全局阻断（pre-lock）**：任一 head 为非终态，或 head 为 `manual-intervention-required`（MIR），一律全局阻断——即使没有现存 lock、caller 不知道该旧 transactionId、当前意图是 first-install。pre-lock 阻断不得创建新 transaction、不得追加当前 operation journal、不得 acquire lock、不得 host mutation。
3. **终态 head 也必须重验** 同 transaction 的 durable receipt；receipt 缺失、损坏，或 transactionId / receipt hash / state 与 head 不闭合，同样阻断。
4. **pre-lock 通过后**：获取独占锁并验证 lock identity，然后**立即**再读 post-lock `readJournalHeads()`（及对应 receipt 复核）。只有 `journalSha256` 与完整 `heads` identity 都和 pre-lock 精确一致才继续；snapshot 变化或出现 blocker 必须 fail closed。
5. **post-lock 竞争阻断**：若安全可归属当前 transaction，则以当前 transaction 写 `prepared -> blocked`，blocked entry 引用 blocking entry hash / snapshot identity，写闭合 receipt，再释放锁；不得 host mutation。若无法安全证明归属，保留安全失败，不得猜测恢复或改写 foreign chain。
6. **正常顺序冻结为**：

```text
[optional] pure in-memory input/schema/profile render
     (no transaction, no writeCandidate, no plutil candidate I/O,
      no ownership/runtime/label/file or LaunchAgents inspection)
  -> pre-lock readJournalHeads + terminal receipt revalidation
  -> acquire + verify transaction lock
  -> post-lock readJournalHeads + receipt revalidation
     (journalSha256 与 heads identity 必须与 pre-lock 精确一致)
  -> 当前 transaction prepared journal
  -> ownership / runtime / label / file inspections
     (internal mode first-install | managed-upgrade | blocked；
      journal/receipt operation 全程不可变；同锁同 transaction，禁止 unlock 重入)
  -> anchor (production validateLaunchAgentAnchor)
  -> writeCandidate staging + plutil lint on staged plist candidates only
  -> host mutations (publisher candidate refs / launchctl) …
```

任意业务 intent、compensating 子状态、receipt-pending 或 `manual-intervention-required` 即使锁文件缺失，也一律零宿主 mutation 并要求显式 recover，禁止当作 first install 或新事务覆盖。用 transactionId-filtered `readJournal` 代替 `readJournalHeads` 视为合同违规。

成功/可恢复收口的持久化顺序固定为：写并 fsync post-state evidence → 写 terminal journal（含 receipt hash）→ 原子写 receipt → 重新验证 terminal journal/receipt → `removeIfMatch` 释放锁。任一步未完成都保留非终态 journal；不得先释放锁再写 terminal。

所有获得锁后才发现且尚未产生宿主 mutation 的 blocker（包括 label-in-use、锁后 ownership/hash/runtime 复核失败、post-lock heads 竞争在可归属当前 transaction 时）统一先写 `prepared`（若尚未写）再写 terminal `blocked` journal 与闭合 blocker receipt 后再释放锁。`no-change` 使用自己的 terminal journal（亦必须先有 `prepared`）；不得从 `prepared` 直接解锁，也不得把 `blocked`/`no-change` 当作事务第一条 journal。

`manual-intervention-required` 是持有 durable `mir-lock` identity 的阻塞态，不允许普通 operation 获取或覆盖。进入 MIR 的顺序固定为：写并 fsync MIR journal → `publishAbsent` durable mir-lock → 复核 mir-lock identity → `removeIfMatch` 原 transaction lock；中途同时存在两个锁时 mir-lock 具有判定优先级。进程退出后也保留 journal/lock 绑定；只有单独的人类授权门 `recover --after-manual-repair` 才可在复核 journal、anchor、MIR lock、实际文件与修复声明 identity 后条件接管。接管后仍按第 6.7 节证明实态；无法证明则继续 MIR，不得静默转成 first install。MIR lock 只有在 recover 写入并验证合法 terminal journal/receipt 后才能条件释放。

## 6. 生命周期算法

### 6.1 First install

**阶段边界（与 §5.5.1 同序，禁止提前 I/O）：**

- **pre-lock 之前/周围**仅允许：caller 输入的纯闭合字段校验，以及**纯内存** profile render / descriptor schema 校验（不创建 transaction、不 `writeCandidate`、不对 candidate 跑 `plutil`、不做 ownership/runtime/label/file 或 LaunchAgents 宿主 inspection）。
- **锁门**：pre-lock `readJournalHeads` + receipt 重验 → acquire+verify lock → post-lock 同一 snapshot → `prepared`。
- **`prepared` 之后**才允许 ownership/runtime/label/file inspections，并据此选择**内部** `mode ∈ { first-install, managed-upgrade, blocked }`（见下；**不是** caller 字段，**不得**改写 journal/receipt 的 `operation`）。
- **anchor 之后**才 `writeCandidate` stage；仅对已 staged 的固定 candidate 调 `plutil -lint`；publisher 只收 opaque candidate ref。

**Journal `operation` 不可变（公共 API 对齐）：**

- 公共入口 `install()` 创建的 transaction：从首条 `prepared` 到任意 terminal 的每一条 journal entry 的 `operation` **始终**为 `install`；对应 `receipt.operation` 也**始终**为 `install`。
- 公共入口 `managedUpgrade()` 创建的 transaction：全程 `operation` / `receipt.operation` **始终**为 `managed-upgrade`。
- `operation` 是链级闭合字段，同一 transaction 内禁止漂移、改写或“升级为另一 operation”。chain validation 必须能证明全链 `operation` 恒等。
- post-prepared 若发现完整且 ownership 匹配的已管理安装，可在**同一把锁、同一 transaction** 下选择内部 `mode='managed-upgrade'`：mode 仅是闭合内部分支/状态机选择（实现细节），**不是** caller 可注入字段，**不是**新的持久化自由字符串字段，**不**改变 journal/receipt 的 `operation`。
- 该分支的 **anchor `purpose` 仍可为 `managed-upgrade`**（说明 anchor 用途，不是 transaction operation）。
- 内部 managed-upgrade 分支必须复用 `operation='install'` 下已批准/可验证的显式 states 与 payload 形状推进 stop/publish/load；若现有 closed journal payload/schema 无法安全表达所需 checkpoint，则 **fail closed**（blocked/固定码），**绝不能**中途改 `operation`。
- **不得** unlock 后重入，**不得**再次绕过 heads gate，**不得**为该路由创建第二 transaction。

**步骤：**

1. 纯输入闭合校验：scope、uid、目标根 ID、metadata 根 ID、source commit、schedule、controllerEnvironment 与 allowlisted runtime artifact **声明**（尚不做宿主文件 inspection）。
2. （可选，仍属纯内存）按已注入/已校验的 binding 输入做双 profile **内存 render + schema**；**禁止**此时 `writeCandidate`、**禁止** plutil candidate I/O、**禁止** LaunchAgents/label/ownership 探测。
3. **pre-lock** `readJournalHeads()` + 终态 head 的 durable receipt 重验。任一非终态/MIR head、或终态 head 的 receipt 不闭合：全局阻断——不创建 transaction、不 acquire lock、不 host mutation、不 staging。特别地：即使存在 **caller 未知 transactionId** 的 foreign nonterminal head 且无 lock，first-install 也必须被阻断（不得仅记录泛化 event）。
4. 获取事务锁并验证 lock identity；**post-lock** 再读 `readJournalHeads()`，要求 `journalSha256` 与完整 `heads` identity 与 pre-lock 精确一致。
5. 写当前 transaction `prepared` journal：`operation='install'`（由 `install()` 入口创建；此后全链不可变）。
6. **`prepared` 之后**做 ownership / runtime / label / file inspections（含目标 plist/manifest 是否存在、hash、loaded 探测所需的只读 inspect）。**inspection 不得先于 `prepared`。**
   - 两目标与 manifest 均不存在且无冲突 → 内部 `mode='first-install'`，继续下方 first-install 路径；journal `operation` 仍为 `install`。
   - 目标与 manifest 均存在且 ownership、双 hash 完全匹配 → 内部 `mode='managed-upgrade'`，在**同一锁、同一 transaction** 内按 upgrade 状态表推进（stop→publish changed→load 等），journal/receipt `operation` **仍为 `install`**；anchor 可用 `purpose='managed-upgrade'`；**不得**改 operation、**不得** unlock 重入、**不得**再跑 heads gate、**不得**第二 transaction。若 schema 无法安全承载该分支 checkpoint → fail closed。
   - 目标存在但 manifest 缺失、双文件不完整、hash 漂移或 ownership 不匹配 → 内部 `mode='blocked'`：`prepared → blocked`（或可证明时引导显式 recover），零 host mutation；`operation` 仍为 `install`。
7. `mode='first-install'`：在任何 LaunchAgents 文件发布前，用固定 parser 探测双 label；两者必须可证明 unloaded。任一 loaded 或状态不确定 → `label-in-use`，count=0，按“`prepared` → terminal `blocked` + receipt → 条件释放锁”收口。
8. first-install 路径写入双 `priorState=absent` anchor（`purpose=first-install`，经 `validateLaunchAgentAnchor`）。managed-upgrade 内部分支则冻结 pre-state bytes/loaded，`purpose=managed-upgrade`。
9. **anchor 之后**：`writeCandidate` stage controller/scheduler/manifest；**仅两 plist** 对 staged fixed candidate 调 `plutil -lint`；invalid → blocked，count=0，不得 publish。
10. first-install：依次用 `publishAbsent(address, candidateRef)` 发布 controller 与 scheduler（只收 opaque candidate ref），每侧独立 intent/completed；任一目标不再 absent 都停止，绝不覆盖。managed-upgrade 内部分支：按 loaded 布尔 stop 后 `replaceIfMatch` 仅发布 changed roles（同 §6.2 突变规则，但 `operation` 保持 `install`）。
11. 用同一 no-clobber 条件发布新 manifest，重新验证 manifest 与双 plist hash。
12. 重新解析两个 plist 的 ProgramArguments，验证 runtimeBinder 路径与 live artifact hashes 后，加载 controller 并等待健康检查通过。
13. 再次验证 scheduler runtime binding 后加载 scheduler。
14. 重新验证双 label 状态、plist hash、manifest、runtime binding 和 anchor，写 terminal journal + receipt；**`receipt.operation` 必须仍为 `install`**。

controller 必须先 ready，scheduler 才允许加载，避免 scheduler 在 controller 不可用时触发。

首次安装在文件发布或加载后失败时，只有 journal 的本事务 load-intent/completed、candidate plist/manifest hash 和 label identity 同时证明该 loaded job 属于本事务，才允许先停止对应 scheduler/controller；无法证明时不得 bootout 未认领 label并进入 `manual-intervention-required`。随后仅按 candidate identity 删除本事务创建的双 plist，恢复 `priorState=absent`；任何文件 hash 已变化或 loaded 状态不确定都进入 MIR，不得误删。

### 6.2 Managed upgrade

**阶段边界同 §6.1 / §5.5.1：** pre-lock 前后仅纯输入 + 纯内存 render/schema；`writeCandidate` / plutil candidate I/O / ownership/runtime/label/file inspections 均不得早于 `prepared`；staging+plutil 在 anchor 之后。

**步骤：**

1. 纯输入闭合校验（source commit、schedule、controllerEnvironment 等声明字段）。
2. （可选）纯内存渲染/schema 新双 profile；**禁止** candidate staging 与 plutil candidate I/O。
3. **pre-lock** `readJournalHeads()` + 终态 receipt 重验（同 5.5.1）。
4. acquire+verify lock；**post-lock** `readJournalHeads()` 必须与 pre-lock 的 `journalSha256`/heads identity 精确一致。
5. 写 `prepared` journal。
6. **`prepared` 之后**校验现有 manifest、label、文件名、两个实际 plist hash、source commit 与 allowlisted runtime artifact hashes，并记录双 label 的实际 loaded 布尔；ownership/runtime/label/file inspections 不得先于 `prepared`。
7. 一次性冻结旧双 profile、manifest 和加载状态（`purpose=managed-upgrade`，经 `validateLaunchAgentAnchor`）。
8. **anchor 之后**：`writeCandidate` stage 所需 roles；**仅两 plist** 对 staged candidate `plutil -lint`；invalid → blocked，count=0。仅 changed role 进入后续 replace；publisher 只收 opaque candidate ref。
9. 按记录的实际 loaded 布尔处理 scheduler、controller：loaded=true 才写 stop-intent 并 bootout；loaded=false 写 `role-stop-noop` 并复核仍 unloaded。每个实际 bootout 后复查 loaded 状态。任一 bootout 返回失败或状态不确定时，不发布新文件，按下述基于实际状态的补偿规则收口。
10. 分别用 `replaceIfMatch(expected, address, candidateRef)` 条件发布**已改变**的 controller/scheduler profile；相同 bytes 的 role 写显式 `role-noop`。双 plist 整体非原子，依赖 journal 与双锚点实现可证明收敛。
11. 在任何新 job 加载前，用 `replaceIfMatch` 条件发布新 manifest 并复核其双 hash。**仅 sourceCommit 变化而 profiles/runtime hash 不变时：必须 `committed` 且仅 manifest publish，两 plist `role-noop`；不得 `no-change`。**
12. 重新解析新双 plist 的 ProgramArguments，验证它们与同一 manifest/canonical installation root/runtime artifact hashes 绑定。
13. 加载新 controller 并等待 ready。
14. 再次验证 scheduler runtime binding 后加载新 scheduler。
15. 复核完整 post-state、runtime binding 与 sourceCommit，提交 transaction。

**全同判定**：controller/scheduler/manifest/runtime artifact 全部 hash 与 pre-state 一致时才 `no-change`（count=0）。sourceCommit-only 变更不满足全同。

若由公共入口 `install()` 在 **同一锁/同一 transaction** 的 post-prepared inspection 选择内部 `mode='managed-upgrade'`：不得 unlock 重入，不得再次绕过 heads gate，不得创建第二 transaction；后续按 upgrade 状态表推进，但全链 journal/receipt `operation` **保持 `install`**（anchor `purpose` 可为 `managed-upgrade`）。直接调用公共入口 `managedUpgrade()` 时，全链 `operation`/`receipt.operation` **始终**为 `managed-upgrade`。

文件发布后的任一步失败都必须停止本轮新状态、恢复双锚点，并精确回放 anchor 的双 loaded 布尔：只有旧 controller recorded loaded=true 时才 bootstrap 并等待 ready；只有旧 scheduler recorded loaded=true 时才在 controller 条件满足后 bootstrap。recorded loaded=false 或 entry=absent 时禁止加载，只复核 unloaded/absent。

bootout 阶段失败时不得盲目 bootstrap 或覆盖 plist：

- scheduler bootout 失败或结果不确定：立即停止后续步骤并重新探测双 label；若实际状态等于锚点 pre-state，收口为 `recovered`，否则进入 `manual-intervention-required`。
- scheduler 已确认停止、controller bootout 失败或结果不确定：重新探测 controller。若 controller 仍 loaded 且旧 plist hash 未变，仅在 anchor 记录 scheduler loaded=true 时恢复旧 scheduler；若 controller 已停止，则仅按 anchor 中 loaded=true 的 role 恢复 controller/ready 与 scheduler；recorded loaded=false 的 role 始终保持 unloaded。任何状态不确定、所需 health 失败或 hash 不符都进入 `manual-intervention-required`。

同一基于实测状态的 bootout 补偿规则也适用于 rollback 和 uninstall；区别只在于各自锚点记录的 pre-state。任何流程都不得因为 `launchctl` 返回非零而猜测 loaded 状态。

### 6.3 Stop

- pre-lock 周围仅纯输入闭合校验（如 sourceCommit 声明）；**禁止**在 `prepared` 前做 ownership/runtime/label/file inspection 或任何 candidate staging/plutil I/O。
- **pre-lock** `readJournalHeads()` + 终态 receipt 重验（同 5.5.1）→ acquire+verify lock → **post-lock** heads 与 pre-lock 精确一致 → 写 `prepared`。
- **`prepared` 之后**校验 ownership、manifest 与双 hash，并记录 loaded 布尔；再冻结双 profile、manifest 和原 loaded 状态作为补偿锚点，`purpose=stop`，**必须**通过 production `validateLaunchAgentAnchor`。看似合法但 schema 非法的 stop anchor 必须在任何 launchctl 或 host mutation 前被拒绝。
- 按实际 loaded 布尔先处理 scheduler 再处理 controller：loaded=true 且 ownership 可证明才 bootout，loaded=false 走 role-stop-noop；每步推进 operation-specific journal。
- 正常 stop 的终态是两个 label 均未加载。
- 因为 job 已 bootout，controller 不应被 KeepAlive 重启。
- bootout 后必须重新探测双 label；任一仍 loaded 时 stop 失败并输出固定 `stop-incomplete` outcome 与非零 `hostMutationCount`（已发出的 bootout 尝试计入），不继续做自动 mutation。
- stop 未达双 label unloaded 时，即使补偿后精确回到 pre-state，transaction state 也只能是 `recovered`、operation outcome 必须是 `stop-incomplete`、success=false；不得把 recovered 解释为 stop 成功。
- stop 不删除 plist、manifest 或 anchor。

### 6.4 Crash restart

- 仅在 job 保持 loaded 的情况下终止 controller 子进程。
- 必须观察旧实例消失、新实例出现并重新通过 health。
- 这只在后续 clean Mac 真实验收执行；代码阶段仅验证探测与 receipt 契约。

### 6.5 Rollback

顺序同 §5.5.1：纯输入校验 → pre-lock heads/receipts → acquire+verify lock → post-lock identical snapshot → `prepared` → ownership/runtime/label/file inspections → compensation anchor → mutations。**禁止**在 `prepared` 前做 ownership/file inspection 或 candidate staging/plutil I/O。

1. 纯输入闭合校验（目标 anchorId 等声明字段）。
2. **pre-lock** `readJournalHeads()` + 终态 receipt 重验；通过后 acquire+verify lock；**post-lock** heads 与 pre-lock 精确一致；写 `prepared`。
3. **`prepared` 之后**校验目标 active anchor 与当前 ownership。ownership 缺失、identity 不一致或实际 hash 与 manifest 漂移 → blocked/MIR 引导（可证明 recover 时），不得覆盖当前文件；零 host mutation。
4. 另建本次 rollback 的 compensation anchor，冻结 rollback 前的当前双 plist、manifest 和加载状态；不得覆盖目标 active anchor。
5. 按当前 loaded 布尔先处理 scheduler 再处理 controller：仅 loaded=true 的 role 执行 bootout，其余写 role-stop-noop。
6. 在任何文件 mutation 前重新探测双 label；任一仍 loaded 或状态不确定时，零文件 mutation，按 compensation anchor 恢复原 loaded 布尔并返回固定 `rollback-unload-incomplete` 非成功 outcome。
7. 对目标 anchor 的每个 tagged entry 执行确定动作：`bytes` 用 `replaceIfMatch` 恢复并校验 hash；`absent` 只用 `removeIfMatch` 删除当前 Linke-managed candidate。manifest 使用相同规则，并在任何 job 重新加载前完成。
8. 若目标 manifest=`bytes`，在任何 bootstrap 前验证其 sourceCommit/runtime artifact hashes 与恢复后 plist ProgramArguments 实际指向的 live bytes 全等；旧 runtime bundle 必须作为 immutable input 仍存在且 hash 匹配。生命周期模块不修改或伪造 runtime bundle。缺失/漂移时不得加载或宣称 last-green，固定返回 `rollback-runtime-mismatch`、success=false，并按本次 compensation anchor 恢复 rollback 前已验证状态；只有该补偿失败时才进入 MIR/显式重装门。
9. 逐 role 回放目标 anchor 的 loaded 布尔：仅当 entry=`bytes` 且 recorded loaded=true 时才 bootstrap；controller 需 ready 后方可恢复 recorded loaded=true 的 scheduler。entry=`absent` 或 recorded loaded=false 时禁止 bootstrap，并验证 absent/unloaded。
10. 校验全部 hash/absence、manifest、runtime binding、anchor lineage 和 loaded 状态后提交 rollback receipt；若恢复出旧 manifest，其快照内 parent activeAnchorId 成为下一 rollback target；若恢复为 absent，终态就是未安装且没有 active target。任一步失败按 compensation anchor 恢复 rollback 前状态；补偿自身失败立即进入 `manual-intervention-required`，禁止继续自动 mutation。

### 6.6 Uninstall

顺序同 §5.5.1：`prepared` 前禁止 ownership/file inspection 与 candidate staging/plutil I/O。

1. 纯输入闭合校验。
2. **pre-lock** heads/receipts → acquire+verify lock → **post-lock** identical snapshot → `prepared`。
3. **`prepared` 之后**校验当前双 plist 仍与 Linke manifest hash 一致；不一致则 blocked，零 host mutation。
4. 冻结当前双 plist、manifest 和加载状态作为 uninstall compensation anchor。
5. 按当前 loaded 布尔先处理 scheduler 再处理 controller：仅 loaded=true 的 role 执行 bootout，其余写 role-stop-noop。
6. 在任何文件 mutation 前重新探测双 label；任一仍 loaded 或状态不确定时，零文件 mutation，按 compensation anchor 恢复原 loaded 布尔并返回固定 `uninstall-unload-incomplete` 非成功 outcome。
7. 仅删除两个已验证的 Linke-managed plist。
8. 删除 active manifest，但保留脱敏 uninstall receipt。
9. 验证两个 label 均未加载、两个目标均不存在；任一步失败按 compensation anchor 的双 loaded 布尔恢复精确安装态，无法证明恢复完成则进入 `manual-intervention-required`。

任何 hash 漂移、ownership 缺失或目标类型异常都必须拒绝删除。若仅一个 plist 缺失或漂移，不得删除剩余文件；receipt 只输出闭合 outcome、存在性布尔值和允许的 hash。只有 journal、anchor、manifest identity 仍能闭合时才引导 6.7 的显式 recover，否则返回 ownership blocker / `manual-intervention-required`，由人工处理，不猜测认领。

### 6.7 Recover

- 只依据严格 journal、anchor、manifest 和实际 hash 恢复，不根据文件时间或名称猜测。
- 普通 `recover` 若看到 MIR journal、mir-lock，或二者任一残留，必须返回现有 MIR、host mutation count=0；即使 transaction owner 已消失或普通 transaction lock 缺失也不得接管。该状态唯一入口是经独立人类 gate 的 `recover --after-manual-repair`，且 mir-lock 判定优先于任何普通 lock。
- 排除 MIR 后，recover 执行前必须取得独占事务锁：锁不存在时先按第 7 节原子获取 recovery lock；锁属于仍存活 owner 时返回 `transaction-in-progress`；锁 owner 已消失时，只有 lock、journal 与 anchor 的 transaction identity 完全一致才允许接管，否则返回 `manual-intervention-required`。获取或接管失败均不得写入。
- 若实际状态等于可证明的 pre-state，收口为 `recovered`。
- 若实际状态等于完整 post-state，可验证后收口为 `committed`。
- 若 journal 位于合法业务 checkpoint、业务 `*-intent`、`compensating` 或 `compensate-*-intent/completed`，先证明实际状态精确等于当前 checkpoint 的允许 pre/post 之一；业务中间态按已冻结 reverse plan 进入补偿，补偿中间态只恢复同一 plan 的当前 action。以 anchor bytes/hash 通过 `replaceIfMatch` 恢复、以 `priorState=absent` 通过 `removeIfMatch` 删除本事务 candidate，并逐 role 精确回放 anchor loaded 布尔。补偿每一步都写 intent/completed journal 并复核。
- 只有实际状态不能匹配任何合法 checkpoint、expected/candidate identity 不符、条件 mutation 不可用/失败，或补偿后复核失败时，才返回 `manual-intervention-required` 并停止继续写入。

## 7. 原子性、路径与并发

- 临时文件必须与目标在同一目录，确保 rename 不跨卷。
- candidate 写入顺序固定为 `open no-follow/exclusive -> write -> fsync file -> conditional mutation -> fsync directory`。
- `publishAbsent` 必须以平台级 no-clobber 语义保证目标在提交瞬间仍不存在；`replaceIfMatch` / `removeIfMatch` 必须在同一个不可分割宿主原语中校验 expected identity 后替换/删除。expected identity 至少绑定 canonical parent、basename、类型、owner uid、device、inode 和已验证 SHA-256；一次临近 mutation 的 lstat/hash 复查不能冒充 CAS。
- canonical parent 只在内存中由 `accountResolver` 的固定 rootId 派生并逐次复核；journal/anchor metadata 仅持久化 rootId、role、basename、type、owner uid、device/inode、hash 与 absence 位，禁止写入绝对 parent/home。恢复时必须重新从 Directory Service 解析同一 rootId，不能使用持久化或环境路径替代。
- 若当前 macOS/Node runtime 不能提供上述 race-safe 条件原语，真实 atomicPublisher 构造必须以固定 `conditional-mutation-unsupported` fail-closed；不得退化为普通 rename/unlink，也不得因此开启真实 runner。fake adapter 只能验证契约，不能证明平台能力。
- 目标、父目录、metadata 根和 anchor 根都必须 canonicalize，并拒绝 symlink、非普通文件、路径逃逸和前缀碰撞。
- 目标文件权限必须为当前用户所有且符合固定 mode；不改变第三方文件权限。
- 独占事务锁使用代码拥有的固定 metadata 路径，通过同一平台级 `publishAbsent` no-clobber 原语原子获取；lock record 至少绑定 transaction ID、owner PID、本轮随机 owner nonce、device/inode identity 和 schema version。原语不支持时禁止真实宿主路径。
- 持锁期间每次 journal/anchor mutation 前后都必须证明 lock path 仍与本进程 record identity 一致，保证单 writer；释放使用 `removeIfMatch`，不得普通 unlink。
- 锁存在时普通操作直接 `transaction-in-progress`；不得自动删除未知锁。
- owner 存活探测只用于 fail-closed：PID 存活或无法可靠判定时均视为仍占用；PID 复用造成的误阻塞不得通过强制接管绕过。
- 只有显式 recover 在 owner 已消失且 journal/anchor/lock identity 一致时，才可用 `removeIfMatch` 条件移除孤儿 lock，再用 `publishAbsent` 原子获取新的 recovery lock；任一步竞态失败都停止，不得绕过原语接管。

双 plist 不是文件系统级原子组；本设计通过 durable journal、双锚点和有界补偿实现可证明收敛，不宣称不存在短暂中间态。

## 8. 正常态、恢复锚点与三支柱

### 8.1 正常态定义

真实安装正常态必须同时满足：

- 双 plist hash 与 manifest 完全一致。
- controller label loaded 且 health ready。
- scheduler label loaded，具有 StartInterval，且 KeepAlive 缺失或 false。
- journal 为 `committed`，无活动 transaction。
- active anchor 可解析且 hash 有效。
- receipt 通过闭合 schema 校验。

代码阶段正常态仅表示实现候选：临时根真实文件和 `plutil` 通过、fake launchctl 契约通过、真实 launchctl sentinel 为零、Gold 状态未提升。

### 8.2 恢复锚点

恢复锚点是变更前双 plist、manifest、加载状态和完整 hash 的 last-green 快照。任何恢复必须回到该精确状态；不允许部分恢复或“尽量恢复”。

### 8.3 有界失效

| Failure mode | 预期行为 | 可观测信号 |
| --- | --- | --- |
| ownership/schema/plutil/path preflight 失败 | 零宿主改动 | 固定 blocker code，host mutation count=0 |
| anchor 完成前崩溃 | 保留旧状态，清理本轮临时文件 | journal=`prepared` |
| 单个 plist 已发布或任一 intent 后崩溃 | recover 证明合法 checkpoint 后逆序恢复双锚点，拒绝混合版本 | journal=`compensating/recovered` |
| 条件 mutation 原语缺失或 expected identity 不符 | 不调用普通 rename/unlink，不开启真实 runner | `conditional-mutation-unsupported/mismatch` |
| scheduler bootout 失败或结果不确定 | 停止升级并复查双 label；仅 pre-state 完整时收口 | `recovered/manual-intervention-required` |
| controller bootout 失败或结果不确定 | 不盲目重载；按实测 loaded/health 恢复旧 scheduler 或旧双状态 | `recovered/manual-intervention-required` |
| controller load/health 失败 | 卸载新状态，恢复旧双状态 | `controller-not-ready` |
| scheduler load 失败 | 停止新 controller，恢复旧双状态 | `scheduler-load-failed` |
| launchctl 权限/超时/非零 | 不无界重试，立即补偿 | 固定 launchctl outcome enum |
| 实际 hash 非 pre/post | 停止写入 | `manual-intervention-required` |
| 并发锁存在 | 拒绝第二事务 | `transaction-in-progress` |

写操作和 launchctl mutation 不做自动无界重试。controller health 最多等待 30 秒，使用固定上限轮询。

### 8.4 异常恢复

最高风险演练固定为：

```text
new controller ready
  -> scheduler load failure
  -> failure signal observed
  -> new controller unloaded
  -> both anchors restored
  -> old controller restored and ready
  -> old scheduler restored
  -> hashes, loaded states and health equal last-green
```

另一个固定演练从显式 stop 后的双 unloaded pre-state 开始：upgrade 在任一 publish/load 阶段失败后必须恢复旧双 plist 与 manifest，但保持 controller/scheduler 均 unloaded；不得为了 health 检查重新拉起 controller。

### 8.5 状态侦测与运行后自检

- 真实验收通过 `launchctl print gui/<uid>/<label>` 探测 loaded 状态。
- `launchctl print` 原始输出只在内存中交给固定 parser；允许在内存中提取 loaded 布尔、PID、固定状态以及 job origin/ProgramArguments，并立即 canonicalize 后计算 `jobIdentitySha256` 与本事务 candidate/runtimeBinder 比较。对外只保留布尔、PID、状态枚举和不可逆 identity hash，原始路径/argv 随即丢弃，禁止写入 journal、anchor、receipt、日志或调试附件。若平台输出不足以证明 load-intent 后的 job identity，恢复固定进入 MIR，绝不 bootout 未认领 label。
- controller 通过只读 loopback health 探测 ready。
- healthChecker 只提取固定状态码、布尔值和计数；response body 不得进入日志或 receipt，运行时日志遵循与 receipt 相同的脱敏规则。
- scheduler 成功通过验收 fixture 中的 heartbeat/snapshot 结果确认，不以 stdout chatter 代替。
- 每个操作完成后重新读取双 plist、manifest、journal、anchor 和 loaded 状态。
- 自检异常只报告固定 code、布尔值和计数，不回显 raw stderr。

## 9. Secret 与输出边界

- plist、manifest、journal、anchor、receipt 都禁止 Token、密码、API Key、私钥和完整 EnvironmentVariables。
- plist 及其 byte-exact anchor 副本可含运行必需的本地绝对路径，这是内部持久化的唯一例外；metadata 根/文件权限固定为 0700/0600，任何对外 schema、日志或调试产物都不得复制这些路径。
- 禁止把任何凭证放在 argv。
- controller 需要认证材料的生产配置由 `security-auth` 后续单独设计；本阶段不得以明文环境变量填补该缺口。
- 事务 operation receipt 只允许：schemaVersion、operation、state、sourceCommit、transactionId、anchorId、UTC、固定 label/role、hash、布尔值、计数和闭合 outcome code。
- 后续真实 acceptance receipt 使用独立闭合 schema；除上述字段外只增加 acceptanceId、nonProductionConfirmationId、executeAuthorized 布尔、runtimeVersion 和有序 step result（固定 step name、PASS/FAIL、固定 outcome、布尔值、计数、hash），不得包含自由文本或下面禁止的内容。
- receipt 不允许：绝对路径、用户名、home、原始 stderr/stdout、完整 argv、环境变量、配置正文和任意 exception message。

## 10. 验收设计

### 10.1 纯函数测试

- 双 profile 精确字段与互斥约束。
- XML 转义、Label/文件名一致性、schedule 边界。
- manifest/journal/anchor/receipt 闭合 schema。
- 未知字段、placeholder、命令样文本、敏感字段和 hostile getters fail-closed。
- runtimeBinder 必须把 ProgramArguments 的 Node/controller/agent 实际路径与 manifest pathId/hash/sourceCommit/installation root 双向绑定；路径同形但不同 root、hash 漂移或 argv 指向其它版本均失败。
- journal/anchor metadata 只允许 rootId/basename/identity，不得出现绝对 parent、home 或 `$HOME` 派生值。

### 10.2 临时根真实文件边界

- 新建隔离临时根；不复用历史路径。
- 真实 write/fsync/hash/rollback，以及 `publishAbsent`、`replaceIfMatch`、`removeIfMatch` 的平台契约探测。
- 真实 `/usr/bin/plutil -lint`。
- symlink、路径逃逸、非普通文件、哈希漂移、跨卷、条件 mutation 不支持和 mutation 失败。
- 在 preflight 后、条件 mutation 提交前注入目标创建/inode 替换/hash 漂移，断言零第三方覆盖；普通 rename/unlink fallback 必须被测试拒绝。
- 证明 coordinator 无法通过 hostInspector/metadataStore 对 LaunchAgents 或 active manifest 进行通用 open-for-write；目标 mutation 只能经过 atomicPublisher。
- 将 `$HOME`/`os.homedir()` 指向伪根，断言真实 root 仍来自按 uid 查询的 account database；查询不可用时真实 adapter 构造失败。
- 验证当前用户 LaunchAgents 和真实 launchctl sentinel 均未发生变化。

### 10.3 注入式 launchctl 契约

- 精确 argv、调用顺序、timeout 和错误映射。
- first install、upgrade、stop、rollback、uninstall、recover。
- crash restart 的 loaded/health 探测与 receipt 契约；只用 fake runner 验证，不终止真实进程。
- 每个 journal 阶段故障注入。
- 每个 publish/stop/load/remove 的 intent 前、mutation 后但 completed journal 前分别模拟崩溃，断言 recover 只接受合法 pre/post 并收敛到精确 anchor 或完整 post-state。
- 每个 `compensate-*-intent` 在 action 前、action 后但 completed 前分别模拟崩溃，断言只恢复同一有界 reverse plan，不重复 side effect、不嵌套补偿。
- 固定覆盖“双 plist 已发布、manifest 已发布、controller load 前”以及“controller loaded、scheduler load 前”的身份一致性窗口。
- 固定覆盖 rollback-to-absent、recorded loaded=false、stop 后 upgrade 失败，以及 rollback/uninstall bootout 未完成时零文件 mutation。
- first-install 在双 label 任一已 loaded/未知时返回 `label-in-use` 且零 LaunchAgents mutation；未证明为本事务的 label 在补偿中绝不 bootout。
- first-install bootstrap 成功但 load-completed journal 前崩溃时，只有内存解析出的 jobIdentitySha256 与 candidate/runtimeBinder 一致才可补偿 bootout；输出不足或不匹配固定进入 MIR。
- rollback 恢复旧 manifest 后若 live runtime bundle 缺失或 hash 漂移，断言零 bootstrap、`rollback-runtime-mismatch`、success=false，并恢复 rollback 前 compensation anchor；只有补偿失败才 MIR，且不得报告 last-green。
- controller load 成功但 health 失败。
- controller ready 后 scheduler load 失败的最高风险恢复闭环。
- stop 与 crash-restart 信号不可混淆。

### 10.4 并发与幂等

- 两个独立 Node 进程竞争同一 metadata 根，仅一个获得事务锁。
- 验证锁只能由 no-clobber 原语获取、持有期间 journal 单 writer identity 不变、孤儿接管必须 conditional remove 后重新原子获取。
- 删除锁但保留每一种非终态 journal，断言所有普通 operation 都是零宿主 mutation；terminal journal/receipt 必须先持久化并复核，之后才允许条件释放锁。
- **真实 seed 未知 transactionId 的 foreign nonterminal head**（无 lock）：first-install / 其它普通 operation 经 `readJournalHeads()` 全局阻断；不得仅记录泛化 event，不得用 filtered `readJournal` 冒充。
- `readJournalHeads()`：空/不存在 journal 稳定 empty-bytes hash；多 transaction latest-head 稳定排序；append 后 snapshot/hash 改变；损坏/截断/非法 fail closed；同 transaction 的合法 sequence/hash 但 operation 漂移 fixture 也必须整体拒绝且无 partial heads；返回 detached/deep frozen；调用前后无文件/事件/耐久化 mutation；既有 `readJournal` 公开合同回归不变。
- 每个 post-lock/zero-host-mutation blocker 必须写 `prepared`（若尚未写）→ terminal `blocked` journal + receipt 后才释放锁；`prepared` 解锁必须 RED。
- MIR 保留 durable mir-lock；普通 operation 与普通 recover 永久拒绝且 mutation count=0，只有显式 `recover --after-manual-repair` + 独立人类 gate 可接管，无法证明修复后实态时继续 MIR。
- 在“写 MIR journal / 发布 mir-lock / 删除 transaction lock”每个边界注入崩溃，断言 mir-lock 优先且不存在普通 recover 接管窗口。
- 全相同 candidate（含 manifest/runtime）返回 `no-change` 且 mutation count=0；单 role hash 相同走显式 role-noop；**sourceCommit-only** 变更必须 `committed` 且仅 manifest publish；改变的 role 必须证明 inode identity 变迁。
- publisher 调用必须携带 opaque `{ kind:'candidate', transactionId, role, sha256 }`；测试断言非 bytes/路径。
- stop anchor 必须通过 production `validateLaunchAgentAnchor`（含 `purpose=stop`）；非法 schema 在 launchctl/host mutation 前拒绝。
- happy path 顺序严格：optional 纯内存 render → pre-lock heads/receipts → lock → post-lock identical heads/receipts → prepared → inspections → anchor → writeCandidate/plutil → mutations；inspection、candidate staging、plutil candidate I/O 不得先于 prepared。
- **同一 transaction 全链 journal `operation` 不可变**：`install()` 入口始终 `operation='install'`（即便内部 mode 走 managed-upgrade 分支）；`managedUpgrade()` 入口始终 `operation='managed-upgrade'`；receipt.operation 与之对齐；表驱动/链检查必须拒绝中途改 operation。
- 重复 install/stop/rollback/uninstall 返回固定幂等状态或固定 blocker。
- 未知锁、错误 journal、错误 anchor、混合 hash 一律停止。
- acceptance prepare/execute 两阶段必须绑定一次性 nonProductionConfirmationId；消费记录必须在 mint 前 no-clobber+fsync，缺失、重放、uid/root/sourceCommit/runtime hash 不匹配、写入失败或 fake host dependency 均不能铸造真实 capability。

### 10.5 Codex verifier

1. 从父提交隔离树只应用测试变更，确认因目标行为缺失而 RED；语法、import、fixture 错误不算有效 RED。
2. 应用实现后跑 focused GREEN。
3. 跑 supervisor、controller、agent、Gold honesty 相关回归，并以机器断言锁定 `ready=6, partial=3, blocked=0, total=9`、`automation-installation=partial` 与五项 false flags；任何翻转都必须 RED。
4. 跑完整 `npm test`。
5. 检查 `git diff --check`、全部变化路径、敏感字面量、真实 launchctl sentinel 和 `package-lock.json` 边界。

## 11. 后续 clean Mac 真实验收门

真实验收必须由用户另行确认该机器或用户会话是非生产测试环境，通过 `--execute` 实现独立显式 gate，并单独授权 launchd 与 LaunchAgents 写入。验收绑定实现提交的精确 40 位小写十六进制 source commit 以及 manifest 中 allowlisted runtime artifact hashes；若当前代码 commit 或任一入口文件 hash 与目标机器 manifest 不同，拒绝开始验收，必须先通过 managed upgrade 或经单独批准的 uninstall + install 对齐版本。

顺序固定为：

```text
acceptance gate + real adapter construction
  -> conditional mutation capability probe
  -> install
  -> controller ready
  -> scheduler loaded
  -> scheduled run-once succeeds
  -> normal stop remains stopped
  -> controller crash triggers KeepAlive restart
  -> managed upgrade
  -> injected scheduler-load failure restores last-green
  -> explicit rollback
  -> uninstall leaves no loaded label or managed plist
```

真实 receipt 必须是脱敏 JSON + Markdown，含 sourceCommit、运行时版本、acceptance ID、nonProductionConfirmationId、executeAuthorized、每步 PASS/FAIL、UTC、计数、hash 和最终残留检查。任一步失败、receipt 版本不符、confirmation 绑定不符或 source commit 不符都不能提升 scorecard。

## 12. Gold 与版本边界

代码阶段完成后可更新为 V1.46 implementation candidate，但必须保持：

- `automation-installation=partial`。
- Gold `ready=6, partial=3, blocked=0, total=9`。
- `realCapabilityImplementationsReady=false`。
- `realRunnerWiringReady=false`。
- `runnerWiringContractReady=false`。
- `executeCapabilityAuthorized=false`。
- `executionEligible=false`。
- `security-auth=partial`。
- `production-hardening=partial`。
- 项目仍为 not Gold / not GA。

只有后续 version-exact clean Mac lifecycle receipt 通过独立验证后，才能单独设计和批准 `automation-installation` 的状态提升；该提升也不等于整体 Gold。

## 13. Fresh adversary finding 裁决

| Finding | PM 裁决 |
| --- | --- |
| 双 Agent 非文件系统级原子，需要 durable journal + 双锚点 + 有界补偿 | 采纳 |
| 已加载 plist 升级必须 stop/unload、replace、reload，失败恢复旧加载态 | 采纳 |
| stop 与 crash-restart 必须分离 | 采纳 |
| ownership manifest 与 source commit 绑定 | 采纳 |
| `plutil` 之外还需字段级 schema | 采纳 |
| 本阶段禁止翻转真实执行和 Gold flags | 采纳 |
| 先加载 scheduler 再 controller | 驳回；scheduler 依赖 controller ready，固定 controller-first |
| 两个 Agent 都调用 `agent.js`，因此据此新增共享锁 | 驳回事实前提；controller 调用 `controller-runtime.js`，scheduler 调用 `agent.js run-once`；不在本阶段新增无证据的跨角色锁需求 |

第二轮对完整书面 spec 的抗辩先返回 `BLOCKED`。PM 对 11 条 finding 的裁决如下：

| Finding group | PM 裁决 |
| --- | --- |
| upgrade 两步 bootout 失败缺少基于实际 loaded/health 的补偿 | 采纳并加强；禁止盲目 bootstrap，按实测 pre-state 收口或进入 manual |
| uninstall 单文件缺失/漂移会留下半残留 | 采纳并收窄；不得删除剩余文件，仅 identity 可证明时引导 recover，否则人工处理 |
| first install、rollback、recover 的异常路由不完整 | 采纳；补全 ownership blocker、显式 recover 与锁接管门 |
| recover 在锁缺失、活 owner、孤儿 lock 下的语义不清 | 采纳并加强；lock 绑定 transaction/PID/nonce，无法证明 owner 消失时 fail-closed |
| upgrade 的“原子发布双 profile”措辞不真实 | 采纳；改为两个同目录原子替换，明确整体非原子 |
| `--execute`、40 位 sourceCommit 和目标 manifest 对齐门不够明确 | 采纳 |
| crash-restart 缺少代码阶段 fake 契约项 | 采纳 |
| health response body 脱敏与 stop 后异常 loaded 侦测不明确 | 采纳；仅允许固定字段并增加 `stop-incomplete` |
| generic journal 未覆盖 stop/uninstall/upgrade 的宿主 mutation | PM 自审新增；改为 operation-specific 分支状态机 |

修订版经用户批准从连续 timeout 的 GLM 通道切换到 fresh Grok plan-only 抗辩。Grok 返回 2 P0 / 5 P1 / 2 P2，PM 裁决如下：

| Finding group | PM 裁决 |
| --- | --- |
| recover 对合法中间态只进入 manual，无法消费 journal/anchor | 采纳；按 intent/checkpoint 证明实态并逆序补偿，仅非法状态或补偿失败进入 manual |
| 普通 rename 在 preflight 后仍可覆盖竞态写入的第三方目标 | 采纳并加强；定义平台级 `publishAbsent`/`replaceIfMatch`/`removeIfMatch`，不支持则禁用真实 adapter，临近复查不算 CAS |
| 双 profile 与 remove journal 缺逐侧 intent/completed 状态 | 采纳；所有宿主 mutation 拆分 before/after checkpoint |
| stop 恢复 pre-state 与 `stop-incomplete` 语义冲突 | 采纳；transaction=`recovered` 但 operation success=false，不得报 stop 成功 |
| rollback 未定义 `priorState=absent`、lineage 与补偿失败 | 采纳；tagged entry、rollback-from identity、parent target 与 MIR 终态均冻结 |
| 真实 runner 可被任意注入且 bootstrap path 未绑定目标根 | 采纳；真实 runner 仅由 acceptance capability 构造，并逐调用验证 uid/domain/label/path |
| manifest 在 jobs 加载后才发布 | 采纳；manifest 条件发布移到任何 bootstrap 前，并增加崩溃窗口测试 |
| raw `launchctl print` 可能经日志旁路泄露 | 采纳；固定 parser 后立即丢弃原文 |
| Gold tuple 与五 flags 缺机器锁定 | 采纳；加入 verifier 必须 RED 的字面不变量 |

第二次 fresh Grok 对修订版仍返回 2 P0 / 5 P1 / 2 P2，PM 裁决如下：

| Finding group | PM 裁决 |
| --- | --- |
| rollback-to-absent 仍统一执行 load/ready | 采纳；按 entry bytes/absent 与 recorded loaded 布尔严格分支 |
| stop 后 upgrade 失败可能把原 unloaded jobs 拉起 | 采纳；所有补偿只回放 anchor loaded 布尔，并加入 unloaded 演练 |
| 事务锁缺少与文件 CAS 同级的原子获取/释放与单 writer 不变量 | 采纳；锁使用 publishAbsent/removeIfMatch，接管也不得绕过 |
| candidate 与 prior 同 hash 时 intent pre/post 不可区分 | 采纳；全同返回 no-change，单 role 相同写 no-op，真实 replace 必须证明 identity 变迁 |
| rollback/uninstall 未在文件 mutation 前确认双 label unloaded | 采纳；增加实测 gate 与固定非成功 outcome |
| compensation 自身崩溃没有可恢复子状态机 | 采纳；冻结单一有界 reverse plan 和逐 action intent/completed，禁止嵌套补偿 |
| acceptance capability 仍可经 fake host dependencies 伪造 | 采纳；密封工厂、private brand、真实 composition root 禁止 DI fake |
| sourceCommit 未绑定实际 runtime entrypoint bytes | 采纳；manifest 与验收增加 allowlisted runtime artifact hashes |
| anchor plist bytes 含绝对路径 | 部分采纳；byte-exact rollback 不能剥离路径，改为 0700/0600 本地保护并禁止任何外部输出 |

第三次 fresh Grok 达到本设计门最大尝试边界并返回 2 P0 / 5 P1 / 2 P2。用户批准由 Codex 闭合后改派 fresh Kimi 作最终设计抗辩；PM 裁决如下：

| Finding group | PM 裁决 |
| --- | --- |
| ProgramArguments 实际目标未与 manifest runtime identity/installation root 强绑定 | 采纳；新增 runtimeBinder，在 manifest 前、bootstrap 前和 commit 前双向复核路径与 live bytes |
| 非终态 journal 在锁缺失时可被普通事务覆盖 | 采纳；普通入口锁前/锁后双检 journal，terminal journal/receipt 在释放锁前持久化，MIR 保持 durable lock |
| 通用 fsOps write 可绕过 atomicPublisher | 采纳；拆为只读 hostInspector 与 metadata-only store，LaunchAgents mutation 仅能走条件原语 |
| first-install 未拒绝已 loaded label，补偿可能 bootout 外来 job | 采纳；发布前双 label 必须 unloaded，补偿 bootout 需要本事务 load+candidate identity 双证明 |
| rollback 恢复旧 manifest 但 live runtime bytes 可能仍是新版本 | 采纳；旧 immutable bundle/hash 必须匹配，否则零 bootstrap + `rollback-runtime-mismatch` |
| LaunchAgents root 可能被 `$HOME`/`os.homedir()` 伪造 | 采纳；真实 accountResolver 仅从 uid 的 macOS account database 派生 root |
| MIR 的锁持有、人工修复再入与释放语义缺失 | 采纳；MIR durable mir-lock，仅独立授权的 after-manual-repair recover 可条件接管 |
| journal CAS identity 与绝对路径禁写边界冲突 | 采纳；持久化 rootId/basename/identity，绝对 parent 每次在内存从 Directory Service 派生 |
| 非生产确认只是泛化布尔 | 采纳；prepare/execute 两阶段绑定一次性 nonProductionConfirmationId 并写入 receipt |

fresh Kimi 最终设计抗辩返回 0 P0 / 3 P1 / 3 P2。PM 对全部 finding 的裁决如下：

| Finding group | PM 裁决 |
| --- | --- |
| rollback-runtime-mismatch 与统一 compensation 规则冲突 | 采纳；先恢复 rollback 前已验证状态，只有补偿失败才 MIR |
| 普通 recover 可绕过 MIR/mir-lock 的人工 gate | 采纳；普通 recover 遇任一 MIR 证据均零 mutation，唯一入口为 after-manual-repair |
| label-in-use 在 prepared journal 下直接释放锁 | 采纳并推广；所有 post-lock blocker 先写 terminal blocked journal + receipt 再解锁 |
| MIR journal、mir-lock 与 transaction lock 交接顺序不明 | 采纳；固定 journal → mir-lock → 条件删除 transaction lock，mir-lock 判定优先 |
| load intent 后崩溃缺 loaded job identity 证明 | 采纳；raw print 仅在内存计算 jobIdentitySha256，不可证明则 MIR 且不 bootout |
| confirmation ID 无 durable consumed record | 采纳；mint 前 no-clobber+fsync 消费记录，写失败或重放都拒绝 |

### 13.1 设计 A：全局 journal-head snapshot（Task 2.5）用户批准

Task 4 首版 RED 被 Codex 与独立 GLM 判定 HOLD：缺少可证明的全局 journal 占用 seam，foreign nonterminal 在 caller 不知 transactionId、无 lock 时无法阻断 first-install。用户批准 **设计 A**：

| 项 | 冻结内容 |
| --- | --- |
| 新接口 | `metadataStore.readJournalHeads()` 零参数只读全局 heads snapshot（见 5.4.1） |
| 插入点 | Task 2 与 Task 4 之间新增独立 **Task 2.5**（Task 3 host-adapter 历史可已完成；Task 4 硬依赖 Task 2.5） |
| Task 2.5 范围 | RED 仅 `test/launchagent-lifecycle-metadata.test.js`；GREEN 仅 `src/launchagent-lifecycle/metadata-store.js` |
| Task 4 消费 | coordinator 必须调用 `readJournalHeads()`，按 5.5.1 双快照顺序 fail closed；不得用 filtered `readJournal` 冒充 |
| 六项 RED 整改 | foreign nonterminal 真实 seed；publisher 精确 candidate ref；stop anchor 走 production validator；happy path 新顺序；sourceCommit-only → committed+manifest-only；heads seam 用真实接口 |
| 角色事实 | implementer = 同一 isolated opencode worker（Grok 4.5 high）；Codex = 主脑/独立验证；GLM = 独立抗辩；Qwen = 仅统计；Kimi = 后续闭环验收。**不宣称任何模型已批准代码** |

## 14. 角色与后续流程

```text
hostController / orchestrator / pm / verifier: Codex（主脑与独立 RED/GREEN 观察；不代替实现）
implementer: 同一 isolated opencode worker，backed by Grok 4.5 high（文档固化与后续 TDD 实现）
adversary / independent challenge: GLM（独立抗辩；read-only evidence）
statistics: Qwen CLI（仅计数与边界统计；不决定正确性）
closure acceptance: Kimi（后续闭环验收；本阶段不宣称已批准代码）
```

独立 TDD 停点（每步需 Codex 观察；同一次 worker 阶段不得先写生产绕过 RED 检查点）：

```text
docs 固化（本阶段）
  -> Task 2.5 RED -> Codex RED
  -> Task 2.5 GREEN -> Codex GREEN
  -> Task 4 RED rework -> Codex RED
  -> Task 4 contracts RED -> Codex RED
  -> Task 4 GREEN -> Codex GREEN
  -> 后续 Task 5+ …
```

实现、设计/计划文档 commit、push、真实 launchd 验收和任何部署均是各自独立的用户授权门。本阶段仅文档固化，不执行 commit/push。
