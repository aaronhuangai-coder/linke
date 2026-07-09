# V1.17 Supervisor Lifecycle Guarded Runner Wiring Contract Design

## 目标

V1.17 在现有 `supervisor-lifecycle-guarded-runner-execution-gate` 输出中加入只读 `runnerWiringContract`，用于说明真实 guarded runner 执行 wiring 仍缺哪些生产 contract。

该版本不实现 runner，不执行 lifecycle apply，不调用 launchctl，不写文件，不写 metadata/audit/approval，不读取进程列表，不连接 NAS，不触发备份/恢复，不执行远程命令。`executionEligible:false`、`executorReady:false`、`wouldExecute:false` 和 `realRunnerWiringReady:false` 必须保持不变，Gold 仍 blocked。

## 设计选择

新增一个纯函数：

```js
buildSupervisorLifecycleGuardedRunnerWiringContract(executionPreview)
```

函数返回静态、脱敏、fail-closed 的 readiness contract。它不读取文件、不探测系统、不调用 runner，也不读取 `executionPreview` 的任何字段。`executionPreview` 参数仅用于保持 gate 调用签名语义一致；实现中必须忽略该参数，不能解构、不能遍历、不能根据该参数动态生成 contract。

`buildSupervisorLifecycleGuardedRunnerExecutionGate(...)` 将该 contract 附加到返回 JSON：

```js
{
  runnerWiringContract: {
    command: 'supervisor-lifecycle-guarded-runner-wiring-contract',
    state: 'blocked',
    realRunnerWiringReady: false,
    blockedCount: <number>,
    readyCount: 0,
    requiredContracts: [...],
    blockers: ['real-guarded-runner-execution-wiring-missing', ...],
    nextBlockers: ['real-guarded-runner-execution-wiring-missing'],
    safety: { ... }
  }
}
```

现有 API、CLI、Web gate 不新增 endpoint、不新增按钮、不新增执行面。因为 gate response 是现有 CLI/API/Web 的数据源，V1.17 只把缺口结构化暴露给已有 gate。

## Contract 字段

`requiredContracts` 使用固定 ID 和稳定文案，必须包含且仅包含以下五个 contract，顺序固定：

- `runner-registry`：缺少 code-owned runner registry，不能把 runnerKind 映射到 host implementation。
- `host-mutation-adapter`：缺少受限 host mutation adapter，不能写 plist、load/unload launchd、写 metadata。
- `rollback-anchor`：缺少 rollback anchor 写入与验证策略。
- `attempt-audit`：缺少每次真实执行 attempt 的不可篡改审计策略。
- `operator-recovery`：缺少失败恢复、重试上限、人工恢复 runbook。

每个 contract 固定：

```js
{
  id: 'runner-registry',
  status: 'blocked',
  requiredForExecution: true,
  evidence: 'No code-owned guarded runner registry is wired.',
  blockerCode: 'runner-registry-missing'
}
```

不得包含路径、URL、hostname、username、token、secret、Authorization、hash、approval identity、reason、acknowledgement、command、process id。

`runnerWiringContract.safety` 必须复用 `executionPreviewSafety()` 的完整字段结构，并固定为：

```js
{
  dryRun: true,
  hostMutation: false,
  launchctlCalled: false,
  filesystemWritten: false,
  metadataWritten: false,
  rollbackAnchorWritten: false,
  auditEventWritten: false,
  approvalPersisted: false,
  sensitiveValuesReturned: false,
  readOnly: true,
  processListRead: false,
  lifecycleApplied: false,
  nasConnected: false,
  backupTriggered: false,
  restoreTriggered: false,
  remoteCommandExecuted: false,
}
```

## Gate 集成

Execution gate 必须继续固定：

- `state:'blocked'`
- `executionGateState:'blocked'`
- `executionEligible:false`
- `executorReady:false`
- `wouldExecute:false`
- `gates.realRunnerWiringReady:false`
- `nextBlockers:['real-guarded-runner-execution-wiring-missing']`

可新增：

- `gates.runnerWiringContractReady:false`
- `runnerWiringContract`

`runnerWiringContract` 的存在不能让 `executionEligible` 变 true。即使所有上游 readiness 都 ready 且 `executeRequested:true`，真实 wiring 仍 blocked。
`runnerWiringContract` 不得从 execution preview、manifest、runner binding、approval record 或 config 中派生字段；它始终是同一份静态 blocker evidence。

## Web 显示

V1.17 可以在现有 `buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel(...)` 中把 `runnerWiringContract.requiredContracts` 渲染为额外 blocked lines，但必须继续通过现有 shared result area 显示，不能新增执行按钮。

显示要求：

- 展示 contract ID、status、requiredForExecution、blockerCode。
- 固定 line 格式为 `wiringContract:<id>:status:blocked:requiredForExecution:true:blocker:<blockerCode>`。
- 不展示 evidence 中的敏感值；如果 payload 漂移包含敏感字段，仍使用现有 sanitizer。
- 继续显示 `realRunnerWiringReady:false`、`executionEligible:false`、`executorReady:false`、`wouldExecute:false`。

## 测试要求

新增或更新测试覆盖：

1. 纯函数返回固定 blocked contract，所有 required contract `status:'blocked'`、`requiredForExecution:true`。
2. 纯函数忽略输入：传入正常 execution preview、`null`、`undefined`、带 `wouldExecute:true` 的恶意对象、带路径/token/secret/command 的恶意对象，输出必须完全相同且不包含敏感值。
   测试必须 deepStrictEqual safety 完整字段枚举，不能只断言部分字段。
3. execution gate 包含 `runnerWiringContract` 和 `gates.runnerWiringContractReady:false`，并且 ready inputs + `executeRequested:true` 仍 blocked。
4. API 输出包含 sanitized `runnerWiringContract` 和 `gates.runnerWiringContractReady:false`，不泄露路径、token、secret、hostname、hash、approval 字段或 command。
5. Agent CLI 输出包含该 contract，`--fail-on-blocked` 仍 exit 2；`src/agent.js` 无需修改，CLI 透传 gate JSON。
6. Web view model/DOM 渲染 contract lines，但不新增初始请求、不新增执行按钮、不泄露敏感字段；`wiringContract:` lines 必须与既有 `candidate:` lines 可区分。
7. Version/README/Gold readiness 同步到 V1.17，Gold 仍 blocked。

## 非目标

- 不实现真实 runner registry。
- 不实现 host mutation adapter。
- 不写 rollback anchor。
- 不写真实 execution audit。
- 不执行 install/uninstall/rollback/recover。
- 不修改 auth/write-route 语义。
- 不新增 Web execution surface。

## 完成标准

- 所有新增 contract 证据都只是 read-only blocked evidence。
- 现有 gate 行为保持 fail-closed。
- focused tests、`npm test`、qwen 抗辩、DeepSeek 闭环均通过后才可 commit/push。
