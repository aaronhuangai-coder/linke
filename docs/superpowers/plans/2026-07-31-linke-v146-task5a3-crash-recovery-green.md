# Linke V1.46 Task 5A.3 Crash-Recovery GREEN 实施计划

> 状态：DRAFT-REVISED。基于 `987208615fdaf9e7724e0b36db7f12f9c87d9ab3` 的有效 RED 与 GLM-5.2 对抗结论修订；未授权真实 LaunchAgent、部署、Gold/GA、commit 或 push。

## 1. 目标与完成定义

实现普通事务 `coordinator.recover({ transactionId })`，让 crash image 只依赖 durable journal / anchor / candidate / receipt 与当前 host identity 恢复，不复用崩溃前闭包或易失对象。

本子波完成必须同时满足：

- exact 单键输入在任何 dependency call 前闭合拒绝；
- 普通恢复保留原 transaction operation，不写成 `recover`；
- 新 terminal journal 内嵌完整 receipt projection 与 hash；旧 hash-only terminal 仍可读兼容；
- terminal missing receipt 可按 embedded projection no-clobber 重发并复验；
- business intermediate 只回到精确 pre-operation anchor，唯一例外是完整证明的 install post-state 可 `committed`；
- compensation intermediate 只续跑同一个 hash-bound reverse plan，不产生第二计划、不重复已完成 side effect；
- mixed/unknown/CAS/evidence/final-revalidation 失败在已取得 fresh recovery lock 后进入 durable MIR；
- conflicting terminal receipt 在没有 owner-death 证明时只返回只读 MIR 分类，journal、receipt、host 与旧锁全部保持不变；
- focused recovery、contracts、metadata、transactions、profiles、host-adapter 回归通过；
- 真实 `launchctl`、真实 `~/Library/LaunchAgents` 写入、安装/部署均为 0。

## 2. 已冻结边界

### 2.1 允许修改

- `src/launchagent-lifecycle/contracts.js`
- `src/launchagent-lifecycle/transaction-coordinator.js`
- `test/launchagent-lifecycle-recovery.test.js`
- 本计划文件

只有在现有内存 harness 无法表达已经裁决的测试 seam 时，才允许单独提出修改 `test/helpers/launchagent-lifecycle-harness.js`；未经 PM 重新裁决不得改。

### 2.2 保护文件与禁止动作

- `src/launchagent-lifecycle/metadata-store.js`：本子波默认只读；不得增加 stale-lock 读取或 takeover API。
- `test/helpers/launchagent-lifecycle-harness.js`：默认冻结。
- `docs/superpowers/plans/2026-07-30-linke-v146-task5a2-crash-recovery-red.md`：既有未暂存用户差异，禁止触碰或暂存。
- `package-lock.json`：不得读取、hash、修改、暂存或提交。
- 禁止 `git add/commit/push/reset/stash/checkout/clean`。
- 禁止真实 `launchctl`、LaunchAgent 安装、部署、邮件、生产数据与凭证操作。

## 3. 对抗裁决

### 3.1 采纳

1. 当前 nonterminal journal 缺少 `anchorId` / source / candidate refs，不能安全恢复；必须先把闭合恢复上下文写入 hash 链。
2. terminal payload 必须兼容 legacy hash-only 与新 embedded-receipt 两种精确形状；新 coordinator closeout 只写新形状。
3. 缺 owner-death 证明时不得释放或接管 stale transaction lock。
4. 旧 missing-receipt 观察只在 `!recoverImplemented` 时注册；GREEN 测试要求新 closeout 内嵌 receipt。
5. 普通恢复到 anchor 使用 `state='recovered'`、`success=false`，operation 保持原值。

### 3.2 PM 收紧

GLM 建议 conflicting receipt “如可行可发 MIR lock”。本计划不采纳：既定 handoff 顺序是 journal → MIR lock → verify → conditional tx-lock release；没有旧 tx-lock ref 时，不得倒置顺序或制造双锁新状态。该分支只返回闭合、脱敏、只读的 MIR classification，不产生任何 durable mutation。

### 3.3 后置任务

- owner death、PID/nonce/boot-session/process-start 证明与 stale-lock takeover；
- durable conflicting-receipt MIR handoff；
- `recoverAfterManualRepair` 与 acceptance-gate private brand；
- 多进程并发与真实当前用户 LaunchAgent 验收。

## 4. Durable schema

### 4.1 Recovery context

新生产 journal 在 anchor durable 后的 nonterminal checkpoints 使用一个精确闭合对象：

```js
{
  sourceCommit,
  anchorRef: {
    kind: 'anchor',
    anchorId,
    sha256,
  },
  candidateRefs: {
    controller: candidateRefOrNull,
    scheduler: candidateRefOrNull,
    manifest: candidateRefOrNull,
  },
}
```

约束：

- operation 不重复存入 context，以 journal 顶层不可变 operation 为唯一真相；
- `anchorRef.sha256` 必须等于 `sha256(JSON.stringify(validateLaunchAgentAnchor(readAnchor(anchorId))))`；
- candidate ref 形状固定为 `{kind:'candidate',transactionId,role,sha256}`；
- candidate refs 只允许 `null -> exact ref` 单调推进，不得改写；
- anchored 时 refs 可全为 null；candidate staging 后首个 business checkpoint 及后续 nonterminal checkpoint 必须携带完整 refs；
- recovery 读取完整 journal，选择最后一个 context，并验证所有历史 context 的 anchor 不变与 candidate 单调性；
- legacy nonterminal 链没有 context 时不猜测、不扫描目录，取得 fresh lock 后进入 durable MIR。

### 4.2 Payload 双形状

现有 legacy payload 继续被 validator 接受。新形状仅在原精确 key 集合上增加 `recoveryContext`，不得接受任意额外键：

- anchored / ordinary checkpoint；
- role checkpoint；
- compensating；
- compensation intent / completed；
- manual-intervention-required。

`prepared` 保持 legacy `{hostMutationCount}`，因为 anchor 尚不存在。

### 4.3 Terminal 双形状

legacy：

```js
{ hostMutationCount, receiptSha256 }
```

new：

```js
{ hostMutationCount, receipt, receiptSha256 }
```

`blocked` 两者均额外含 `blockedByEntrySha256`。new 形状必须交叉验证：

- receipt transactionId / operation / state 与 journal 相同；
- receipt hostMutationCount 与 payload 相同；
- canonical validated receipt hash 与 `receiptSha256` 相同。

`validateLaunchAgentTransactionCloseout` 对 embedded receipt 还必须要求它与传入/持久 receipt 精确相同。

### 4.4 Ordinary recovered outcome

新增闭合 outcome `recovered`，仅允许：

```text
state=recovered
success=false
operation in install|managed-upgrade|stop|rollback|uninstall
outcome=recovered
```

既有业务失败 recovery outcomes 保持兼容；`operation='recover' + recovered + success=true + completed` 仍仅保留给后续 manual-repair transaction，不用于普通 recover。

## 5. Coordinator 写路径

1. `writeAnchor` 保存并验证 closed `anchorRef`，再把 recovery context 写入 anchored entry。
2. candidate staging 只做现有 durable write/read 验证；随后 context candidate refs 变为完整闭合 refs。
3. `appendJournal` 对 anchor 后的 nonterminal state 自动加入当前 recovery context；prepared 与 terminal 除外。
4. `closeWithReceipt` 先构造并 validate receipt，再将完整 receipt 与 hash 一同写入 terminal payload；publish、read-back、transaction-closeout、conditional release 顺序不变。
5. 任何现有普通 operation 的 operation、host mutation 顺序、CAS 与 closeout 门不得改变。

## 6. Recover 读路径

### 6.1 输入与 snapshot

1. `validateRecoverInput` 只接受拥有普通原型、精确单键 data property 的 `{transactionId}`；getter/symbol/额外键/错误 UUID 在 dependency call 前拒绝。
2. `readJournalHeads()` 后定位 exact transaction；其它 foreign nonterminal/MIR/unclosed terminal 仍是全局 blocker。
3. `readJournal({transactionId})` 取得完整链，验证 operation 单一、sequence/hash/transition 与 head 相同。

### 6.2 Terminal branches

- matching existing receipt：完整对齐后直接返回，零锁与 host mutation；兼容 legacy/new terminal。
- new embedded terminal + missing receipt：要求 stale lock 已由测试 seam 清除；acquire/verify fresh same-transaction lock，重读 identical heads，publish exact embedded receipt，read-back/closeout，release。
- no-clobber exact race：publish 失败后只重读；精确相同则 closeout/release，不同则 fail closed。
- legacy terminal + missing receipt：无法重建，返回只读 MIR classification，不写 journal/receipt/lock/host。
- conflicting/invalid receipt：返回只读 MIR classification；旧 transaction lock、journal、conflicting receipt 与 host 原样保持。

### 6.3 Nonterminal branches

1. 只有测试 seam 已证明并清除 stale lock 后，才能 acquire/verify fresh same-transaction recovery lock；失败只返回既有闭合错误，不 takeover。
2. 锁后重读 heads，要求 journal hash 与完整 heads identity 未变化。
3. 从完整链恢复最后一个 recovery context，验证历史单调性；读取 anchor/candidates 并重算 hash。
4. 从 anchor 构造精确 pre-operation snapshot；从 inspector/probe/runtime 读取 live union state。
5. 仅完整证明 install post-state时 close `committed/completed/true`；其它 business intermediate 生成一次 reverse plan 并回到 anchor。
6. 若已有 `compensating`，只使用其 frozen plan/hash：
   - current intent live=expectedPre：执行 side effect 一次，只补 completed；
   - current intent live=expectedPost：零重复 side effect，只补 completed；
   - 余下 step 依次 intent/completed；
   - 不再追加第二个 compensating。
7. 最终 anchor/runtime/job/health 复验后 close `recovered/recovered/false`。

### 6.4 Fail-closed

- fresh recovery lock 已取得后，mixed identity、unknown probe、candidate/anchor/hash/CAS/final verify 异常使用现有 durable MIR handoff。
- 在任何 host mutation 前必须验证 recovery context、anchor、candidate 与当前 union state。
- host mutation 已发生而最终复验失败时，保留准确 mutation count，追加 MIR 后不得再有 host/plan event。
- 任何分支都不得猜测 sourceCommit、anchor、candidate、PORT、loaded/job identity 或 reverse plan。

## 7. TDD 顺序

### Stage 0：安全 RED 修正

- 已完成：missing-receipt observation 加 `!recoverImplemented` 门；conflicting receipt 改为只读 fail-closed。
- 必须保持 `87/86/1`，唯一失败为缺 `coordinator.recover`。

### Stage 1：Contracts

- 实现 recovery context 闭合 validator、legacy/new payload、terminal embedded cross-check、outcome `recovered`。
- 运行 `node --test test/launchagent-lifecycle-contracts.test.js`，不得改测试降口径。

### Stage 2：Durable write path

- coordinator 写 recovery context 与 embedded terminal receipt。
- recover 尚未公开前，运行 contracts + metadata + transactions + profiles + host-adapter；除预期 recovery surface RED 外不得新增失败。

### Stage 3：Terminal recover

- 先实现 exact input、matching existing receipt、missing embedded receipt、exact no-clobber race、legacy/conflicting只读分类。
- 临时不得通过 placeholder `recover` 激活 business matrix；同一提交工作树内立即进入 Stage 4，不在半实现状态声明 GREEN。

### Stage 4：Business recover

- hydrate durable context、anchor/candidates/current union；完整 install post-state committed，其余一次 reverse plan 回 anchor。

### Stage 5：Compensation resume 与 MIR

- resume frozen plan，不重复 current side effect；完成四个代表性 fail-closed fault seams。

### Stage 6：Codex 独立验收

```bash
node --check src/launchagent-lifecycle/contracts.js
node --check src/launchagent-lifecycle/transaction-coordinator.js
node --check test/launchagent-lifecycle-recovery.test.js
node --test test/launchagent-lifecycle-recovery.test.js
node --test test/launchagent-lifecycle-contracts.test.js
node --test test/launchagent-lifecycle-metadata.test.js
node --test test/launchagent-lifecycle-transactions.test.js
node --test test/launchagent-lifecycle-profiles.test.js
node --test test/launchagent-lifecycle-host-adapter.test.js
git diff --check
```

再运行全部 `test/launchagent-lifecycle-*.test.js`。任何失败、skip/todo 增加、越界 diff、缺 artifact 或 worker 结论冲突均为 HOLD。

## 8. 交付门

实现与本地验证通过后仍只代表 Task 5A.3 本地 GREEN：

- 不自动 commit；先展示精确 staged proposal、diff、哈希与测试证据，等待用户单独批准；
- push 为下一道独立批准；
- 不宣称 V1.46、Gold、GA 或完整版发布；
- 真实 current-user LaunchAgent 安装/崩溃/恢复/回滚/卸载验收仍需单独授权。
