# Linke V1.46 Task 5A.2 Crash-Recovery RED 设计

**状态：** 设计 A 已由用户批准；仅授权书面设计与后续测试 RED，不授权生产 GREEN、commit、push、部署或真实 LaunchAgent 操作。

**基线：** `5a316e6d5dce1ea32cb810175a845c22880a900f`

**上位设计：** `docs/superpowers/specs/2026-07-28-linke-v146-user-launchagent-lifecycle-design.md`

**上位计划：** `docs/superpowers/plans/2026-07-28-linke-v146-user-launchagent-lifecycle.md` Task 5 Step 4

## 1. 目标

本子波为 V1.46 Task 5 Step 4 建立可信、可复现、fail-closed 的 crash-recovery 测试 RED：

1. 对每个业务 intent 和每个 compensation intent 覆盖“intent 已持久化、mutation 未发生”与“mutation 已发生、completed checkpoint 未持久化”两个崩溃窗口。
2. 证明普通恢复只接受 checkpoint 允许的精确 pre/post identity。
3. 证明业务中间态回到精确 anchor，完整 post-state 才允许提交。
4. 证明 compensation 只继续 journal 中已经冻结并 hash 绑定的同一 reverse plan。
5. 暴露 terminal journal 已落盘、receipt 文件缺失时无法精确重发 receipt 的现有生产缺口。

本子波的完成状态是“设计已批准、测试 helper 可证明 crash image 忠实、生产 `recover` 缺失形成有效 RED”。它不是 Task 5 GREEN，也不是 V1.46、Gold 或 GA 完成。

## 2. 硬边界

### 2.1 本子波允许

设计阶段新增本文件。进入 RED 实现后只允许修改：

- `test/helpers/launchagent-lifecycle-harness.js`
- `test/launchagent-lifecycle-recovery.test.js`

### 2.2 本子波禁止

- 修改任何 `src/` 生产文件。
- 实现 `recover`、MIR takeover、孤儿锁真实接管或并发锁 GREEN。
- 新增真实 launchctl、`~/Library/LaunchAgents`、LaunchAgent 安装、启动、停止或卸载调用。
- 真实生产写入、部署、commit 或 push。
- 读取、hash、修改、stage、commit 或 push `package-lock.json`。
- 读取 `.env`、凭证、token、SSH、云认证目录或任何身份认证正文。

### 2.3 后续任务边界

- MIR durable handoff 与 `recoverAfterManualRepair`：Task 5 Step 5。
- controller crash-restart 与 job identity：Task 5 Step 6。
- 独立进程竞争、owner death、PID/nonce/boot-session/process-start identity 与孤儿锁接管：Task 5 Step 7。
- 生产 `contracts.js` / `transaction-coordinator.js` GREEN：只有有效 RED 后另行授权。

## 3. 已冻结的公开恢复契约

### 3.1 输入

普通恢复入口为：

```js
coordinator.recover({ transactionId })
```

输入必须是拥有普通对象原型、仅含一个 own enumerable string key 的精确对象。`transactionId` 必须是合法 UUID。任何额外字段、getter、symbol、错误原型、caller 提供的 `sourceCommit`、`operation`、hash 或批准布尔均在读取宿主状态前拒绝。

`sourceCommit`、原 operation、anchor identity 与 reverse plan 只来自完整验证的 durable journal/anchor/candidate evidence，不信任 caller 重述。

### 3.2 operation 不变量

普通 `recover()` 继续原 transaction 的原 operation 链：

- install 仍是 `operation='install'`；
- managed upgrade 仍是 `operation='managed-upgrade'`；
- stop/rollback/uninstall 同理；
- terminal receipt 的 operation 与原链一致。

本子波禁止在普通恢复中把既有链改写为 `operation='recover'`。该 operation 仅保留给后续独立授权的 manual-repair 恢复事务。

### 3.3 收敛选择规则

恢复方向不由实现任意选择：

1. 实际状态等于完整、可证明的 operation post-state：只读复核全部文件、manifest、runtime binding、job identity、loaded/health 条件后收口为 `committed`。
2. journal 位于任何业务 intent、业务 completed checkpoint 或两个 intent 之间，但实际状态尚非完整 post-state：冻结或读取唯一 reverse plan，收敛到精确 pre-operation anchor，收口为 `recovered`。
3. journal 已进入 `compensating` 或任一 `compensate-*-intent/completed`：只继续该 journal 已冻结、hash 绑定的 reverse plan，从当前 action 的合法 pre/post identity 恢复，最终回到 anchor 并收口为 `recovered`。
4. 实际状态等于当前 intent 的 expected post，只表示 mutation 已发生；除非整个 operation post-state 已完整证明，否则不得借此前向提交。
5. mixed identity、unknown probe、conditional mismatch、evidence 不闭合或最终复核失败进入 `manual-intervention-required`，不得猜测方向或启动第二个补偿计划。

## 4. Terminal receipt 可恢复性

### 4.1 现有缺口

当前 closeout 先计算 receipt，再写只含 `hostMutationCount` 与 `receiptSha256` 的 terminal journal，然后发布 receipt。仅有 hash 无法重建 `completedAt`、roles、outcome 等原始 projection，因此 terminal journal 已落盘而 receipt 缺失时不能精确恢复。

该缺口必须由本子波 RED 暴露，不能由测试 helper 猜测字段或从崩溃前易失对象泄漏 receipt。

### 4.2 后续 GREEN 必须满足的 schema 目标

后续生产 GREEN 的 terminal payload 必须保存完整、已通过生产 validator 的脱敏 receipt projection 及其 hash：

```js
{
  hostMutationCount,
  receipt,
  receiptSha256,
}
```

`blocked` 终态在上述字段之外保留 `blockedByEntrySha256`。journal entry hash 覆盖完整 payload，因此 receipt projection 同时受 journal chain 与 `receiptSha256` 绑定。

### 4.3 terminal-publication 恢复规则

当 terminal journal 合法且 receipt 文件缺失：

1. 不执行任何 host mutation。
2. 从 terminal payload 读取并重新验证完整 receipt projection。
3. 重算 hash，要求精确等于 terminal `receiptSha256`。
4. 通过 no-clobber 发布完全相同的 projection。
5. 重新读取 journal 与 receipt，执行完整 closeout 验证。
6. 仅验证成功后条件释放 transaction lock。

若 no-clobber 时已有 receipt：

- 已有 receipt 与 terminal projection/hash 精确相同：按幂等竞争成功处理，重新验证后可释放锁。
- 已有 receipt 非法、字段不同或 hash 不同：不覆盖，进入 MIR；transaction lock 只有在 MIR durable handoff 规则满足后才可处理，本子波不测试该 handoff。

## 5. 设计 A：确定性 crash image

### 5.1 为什么不用 throwing hook

现有 coordinator 会捕获普通 dependency 异常并进入 compensation。测试 hook 抛异常模拟的是“dependency 失败”，不是进程在 durable 边界后的瞬时死亡，会得到错误的后续 journal/host mutation，因此禁止用 throwing hook 作为 crash 证据。

### 5.2 捕获原则

Harness 采用非抛错的一次性 capture：操作继续运行，但在选定边界立即深拷贝当时的 durable metadata 与 fake host 实态。后续操作不能改变已捕获 image。恢复测试只从 image 创建新 harness，不复用崩溃前 coordinator、闭包、receipt 对象或 observation trace。

### 5.3 精确测试 helper API

在 test helper 中新增：

```js
harness.armCrashCapture({
  kind: 'journal-state',
  state,
  occurrence,
});

harness.armCrashCapture({
  kind: 'host-mutation',
  action,
  occurrence,
});

const image = harness.takeCrashImage();

const revived = createLaunchAgentLifecycleHarness({ crashImage: image });

revived.preProveRecoveryLockRelease({ transactionId });
```

规则：

- 一次 harness 最多 arm 一个 selector。
- `occurrence` 是从 1 开始的正整数，避免同名动作歧义。
- `takeCrashImage()` 在捕获前调用、重复调用或 image 不存在时 fail closed。
- `crashImage` 只允许由 helper module-private brand 产生；任意 caller JSON 不可伪造。
- revive 后 hooks、failure injections、trace、adapterCalls、counters 与 observation marks 全部重置。
- image 必须 detached、deep frozen；崩溃前实例后续变化与 consumer mutation 均不能改变它。

### 5.4 selector 语义

`journal-state` 在合法 journal entry 已追加到 store、entry hash 与 writer lock 已验证后捕获。

`host-mutation` 在 fake 宿主状态真实改变、host mutation count 已增加后捕获，但必须早于对应 completed journal append。`action` 使用闭合枚举：

```text
publish-controller
publish-scheduler
publish-manifest
bootout-controller
bootout-scheduler
bootstrap-controller
bootstrap-scheduler
remove-controller
remove-scheduler
remove-manifest
restore-controller
restore-scheduler
restore-manifest
load-controller
load-scheduler
stop-controller
stop-scheduler
```

同一底层 fake 调用若同时对应业务名和 compensation 名，只记录并捕获当前 journal 所证明的 action，禁止按调用次数猜测角色。

### 5.5 crash image 持久态 allowlist

Image 精确包含：

- journal 全链及 entry bytes/hash；
- anchors；
- candidate bytes/hash/ref；
- receipts 的 projection/hash；
- transaction lock 与 MIR lock record/ref identity；
- fake host 三个目标文件的 bytes、device/inode/sha256；
- controller/scheduler 的 loaded 布尔与 job identity；
- 可复核的 health/probe/runtime artifact 实态；
- fake device/inode 与确定性 UUID/clock 的下一序号，仅用于避免 revived harness 生成重复测试 identity。

Image 禁止包含：

- hooks、函数、Promise、异常对象或任意闭包；
- trace、adapterCalls、counters、failure injection、临时 observation marks；
- 崩溃前 coordinator context、未持久化 receipt 对象或 reverse plan 临时变量；
- 真实路径、HOME、用户名、环境变量、stdout/stderr、argv 或凭证。

所有 durable 写入必须经过 harness adapter 的单一 store/host state，capture 不允许从其它旁路拼装状态。

### 5.6 Step 4 排他锁接缝

真实孤儿 owner 证明与 conditional lock takeover 属于 Step 7。本子波用测试专用前置接缝隔离该依赖：

```js
revived.preProveRecoveryLockRelease({ transactionId });
```

它只能：

1. 验证 revived stale transaction lock、latest recoverable journal 与 `transactionId` 精确一致。latest 可以是普通 nonterminal，也可以是 terminal journal 已落盘但 receipt 缺失/冲突，或精确 receipt 已发布但 stale lock 尚未释放的 terminal-publication 窗口。
2. 验证 latest 不是 `manual-intervention-required`，且 MIR journal/mir-lock 不存在。
3. 以 module-private test capability 将 fake stale lock 标为“已由未来 Step 7 证明并条件释放”。
4. 写入固定 trace `recovery-lock-seam`，host mutation count 保持 0。

它不得把“任意已完成事务”变成可恢复状态：只有匹配 stale lock 的 transaction 才可进入接缝；没有 stale lock 的普通 closed transaction 保持只读幂等返回。它也不得修改 journal、anchor、candidate、receipt、host file 或 loaded/job state。接缝后，生产 `recover()` 仍必须通过现有 `acquireTransactionLock` / `verifyTransactionLock` 获取新的 recovery transaction lock。Step 4 不得因此声称真实孤儿 takeover 已验证。

## 6. 恢复数据流

```text
strict recover input
  -> readJournalHeads + locate exact transaction
  -> validate full journal chain / original operation / sourceCommit
  -> reject MIR evidence for ordinary recovery
  -> acquire + verify fresh recovery lock
  -> re-read heads and require identical snapshot
  -> hydrate anchor/candidate/receipt evidence
  -> inspect exact live file/job/runtime identities
  -> classify terminal / full-post / business-intermediate / compensating / invalid
     -> terminal receipt repair, zero host mutation
     -> full post: read-only verify -> committed
     -> business intermediate: freeze/read one reverse plan -> anchor -> recovered
     -> compensation intermediate: resume same action/plan -> anchor -> recovered
     -> invalid/unknown/mismatch: MIR
  -> terminal journal embeds receipt+hash
  -> no-clobber receipt publish
  -> full closeout revalidation
  -> conditional lock release
```

任何分类前不得 host mutation。普通 recover 看到 MIR evidence 时只返回现有 MIR 分类且 host mutation count=0；MIR lock 的发布、交接与释放不在本子波。

## 7. RED 测试矩阵

### 7.1 首个有效 RED

测试先断言：

```js
typeof coordinator.recover === 'function'
```

当前预期失败原因为缺少 `coordinator.recover`，不得失败于 import、syntax、harness schema、真实路径或 package-lock。

Crash-image 自身的捕获、detachment、revive/reset 与 pre-proven lock seam 测试必须在当前生产缺少 `recover` 时仍可独立运行并通过。恢复行为套件以 `recover` capability 为唯一激活条件；测试正文必须完整，禁止 placeholder/TODO。

### 7.2 业务 intent 全矩阵

每项覆盖 intent 后/pre-mutation 与 mutation 后/pre-completed 两行：

| intent | host mutation action |
| --- | --- |
| controller-publish-intent | publish-controller |
| scheduler-publish-intent | publish-scheduler |
| manifest-publish-intent | publish-manifest |
| controller-load-intent | bootstrap-controller |
| scheduler-load-intent | bootstrap-scheduler |
| scheduler-stop-intent | bootout-scheduler |
| controller-stop-intent | bootout-controller |
| controller-remove-intent | remove-controller |
| scheduler-remove-intent | remove-scheduler |
| manifest-remove-intent | remove-manifest |

每行必须断言：原 operation 不变、只接受合法 expected pre/post、host mutation 不重复、最终 anchor byte/hash/loaded 状态精确相等，或完整 post-state 精确证明后 committed。

### 7.3 compensation intent 全矩阵

每个 action 覆盖 `compensate-<action>-intent` 后/pre-mutation 与 mutation 后/pre-completed 两行：

```text
remove-controller
remove-scheduler
remove-manifest
restore-controller
restore-scheduler
restore-manifest
stop-controller
stop-scheduler
load-controller
load-scheduler
```

每行必须来自真实可达的原 operation fixture，不允许手工拼装不可能 journal。断言 `reversePlanSha256`、planIndex、action、expectedPre/expectedPost 与 evidence 不变；post identity 已成立时补 completed checkpoint，不重复 side effect；最终只回到原 anchor，不生成第二计划。

### 7.4 必测 intent 间窗口

固定覆盖：

1. controller、scheduler、manifest 均已发布，controller 尚未加载。
2. controller 已加载且 job identity 已证明，scheduler 尚未加载。

这两项是前一 completed 已落盘、下一 intent 尚未开始的独立窗口，不得错误归入 intent pending。除非完整 operation post-state 已证明，否则按业务中间态逆向恢复到 anchor。

### 7.5 terminal-publication 矩阵

- terminal journal 含 receipt projection/hash，receipt 文件缺失：零 host mutation，精确重发、复验、条件解锁。
- receipt 已存在且精确相同：幂等复验后条件解锁。
- no-clobber 竞争中出现精确相同 receipt：重新读取并按幂等成功处理。
- receipt 非法、projection 不同或 hash 不同：不覆盖，MIR 分类，锁不得普通释放。

### 7.6 fail-closed 代表行

- controller/scheduler/manifest 混合 identity。
- job probe outcome unknown。
- conditional mutation expected identity mismatch。
- compensation 或 terminal closeout 复核失败。

这些行只验证 MIR 分类、停止推进、零后续 host mutation 与不覆盖 evidence；不扩展测试 MIR handoff。

### 7.7 输入与隐私

- 非 UUID、额外字段、getter、symbol、错误原型均在任何 adapter call 前失败。
- receipt/journal/public error 不含绝对路径、用户名、HOME、raw stdout/stderr、argv、环境变量或自由文本 exception。
- 最终 receipt operation 等于原 operation；普通恢复不得输出 `operation='recover'`。

## 8. 正常态、恢复锚点与运行韧性

### 8.1 正常态定义

本代码阶段的 crash-recovery 正常态必须同时满足：

- transaction 只有一个合法 terminal head；
- terminal journal 与 receipt projection/hash 闭合；
- transaction lock 已条件释放；
- 无 MIR lock；
- host state 精确等于原 anchor，或完整且已验证的 operation post-state；
- 测试 sentinel 证明真实 launchctl 与真实 LaunchAgents 调用均为 0。

### 8.2 恢复锚点

恢复锚点是 operation 前已持久化的双 plist、manifest、loaded booleans、runtime binding 与完整 identity/hash 快照。业务或 compensation 中间态只能回到该精确 anchor；不接受“尽量恢复”或部分混合状态。

### 8.3 三支柱任务映射

| 支柱 | 本子波 task | 成功判据 | 证据 |
| --- | --- | --- | --- |
| 有界失效 | 全 intent/compensation pre/post、mixed/unknown/CAS/verify 行 | 不猜测、不重复 mutation、错误进入 MIR | focused RED 输出与 trace/计数断言 |
| 异常恢复 | crash image revive + 同一 reverse plan 收敛 | 精确 anchor=`recovered` 或完整 post=`committed` | journal/receipt/host snapshot 断言 |
| 状态侦测与自检 | terminal closeout 与最终 host/job/runtime revalidation | receipt/hash/terminal/lock 全闭合 | closeout validator 与 sentinel |

### 8.4 运行风险扫描

| 风险 | 本子波处理 |
| --- | --- |
| 外部依赖退化 | fake launchctl/health unknown 固定 fail closed；真实依赖验收后置 |
| 数据持久化/一致性 | crash image 必须只含 durable allowlist；terminal receipt 双绑定 |
| 队列积压/重试耗尽 | N/A：本组件没有队列或自动重试 |
| 配置/凭证缺失 | 不读取凭证；runtime evidence 缺失即 MIR/blocked |
| 启动/关闭顺序 | 两个固定 intent 间窗口与 controller-first/scheduler-first 规则 |
| 迁移/回滚 | 同一 frozen reverse plan；不嵌套补偿 |
| 资源耗尽 | journal/reverse plan 继续受既有上限约束；无无界循环 |
| 告警阈值 | 本子波只有固定状态/错误码；运行告警 wiring 后置 |

本 RED 使用确定性 fake contract，不能单独满足最终 Stage 5 的真实边界验收。后续 Task 5 GREEN 至少还需临时根真实文件/条件 mutation 契约演练；真实 current-user LaunchAgent clean-Mac 验收仍须独立授权。

## 9. 验证与保护

RED 实现前记录：

- HEAD、branch、upstream 与 status；
- 本 spec 与上位 plan/design hash；
- 所有 `src/launchagent-lifecycle/*.js` hash；
- 允许修改的两个测试文件 hash；
- `package-lock.json` 只按 `git status` 观察其存在，禁止读取/hash。

RED 验证顺序：

```bash
node --check test/helpers/launchagent-lifecycle-harness.js
node --check test/launchagent-lifecycle-recovery.test.js
node --test test/launchagent-lifecycle-recovery.test.js
```

预期：helper 自测通过，focused test 仅在缺少 `coordinator.recover` 的公开面断言上失败；不得出现 syntax/import/harness/真实宿主错误。

随后运行现有相关回归，证明新增 helper seam 未破坏 Task 4/5A.1；RED 阶段不要求全仓 GREEN，也不得把预期 RED 冒充完成。

## 10. Kimi 抗辩裁决

| Finding | PM 裁决 |
| --- | --- |
| terminal journal 必须携带完整 receipt projection+hash | 采纳，作为明确生产缺口和 RED |
| crash image 必须列出持久态 allowlist 且无共享引用 | 采纳，见 5.5 |
| intent 间窗口与收敛方向未冻结 | 采纳，见 3.3、7.4 |
| recover 输入只含 transactionId | 采纳，见 3.1 |
| Step 4 锁 seam 必须诚实隔离 Step 7 | 采纳，见 5.6 |
| throwing hook 不是真崩溃 | 采纳并禁止，见 5.1 |
| 手工 seed 可能构造不可能状态 | 采纳；全矩阵必须由可达 operation 捕获 |
| 子进程 SIGKILL 会扩域到 Step 7 | 采纳；本子波拒绝 |

## 11. 备选方案与否决理由

### B. 手工 seed crash checkpoint

否决。虽然实现更短，但 journal、anchor、candidate、lock、host identity 之间的关系容易由测试自己伪造，无法证明 fixture 在生产状态机中可达。

### C. 子进程 SIGKILL + temp-root durable adapter

本子波否决。它会提前引入独立进程锁、owner liveness、孤儿 takeover 与真实 adapter 范围；这些属于 Step 7 和最终验收。后续可作为更强验收，不替代本 RED。

## 12. 完成定义与人类闸

本设计阶段完成需：

- 无 TBD/TODO/placeholder；
- 无与上位设计/计划冲突；
- scope 只到 test-only RED；
- 用户复核本书面 spec；
- commit 另行取得显式批准。

用户批准书面 spec 后，才进入 `writing-plans` 拆分 RED 实施步骤；再经 worktree/TDD 规则执行测试改动。生产 GREEN、commit、push、真实宿主动作均保持独立授权。
