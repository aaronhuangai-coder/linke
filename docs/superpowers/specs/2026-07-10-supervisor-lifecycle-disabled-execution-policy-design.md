# V1.23 Supervisor Lifecycle Disabled Execution Policy Design

## 目标

V1.23 为 guarded runner wiring contract 增加 code-owned disabled execution policy readiness。它只声明 Linke 已有一个固定、禁用的执行策略门数据结构，用于后续真实 guarded lifecycle apply 前的授权、允许动作和拒绝动作边界表达。

V1.23 必须继续保持：

- `runnerWiringContract.state:'blocked'`
- `runnerWiringContractReady:false`
- `executionPolicyReady:false`
- `runnerRegistryReady:false`
- `hostMutationAdapterReady:false`
- `rollbackAnchorReady:false`
- `attemptAuditReady:false`
- `operatorRecoveryReady:false`
- `realRunnerWiringReady:false`
- `executionEligible:false`
- `executorReady:false`
- `wouldExecute:false`
- `wouldRun:false`
- `wouldWrite:false`
- `real-guarded-runner-execution-wiring-missing`

不新增 endpoint、CLI command、Web button 或 request body field。`src/agent.js` 不需要修改。不得执行 lifecycle apply，不得调用 launchctl/shell，不得读取进程列表，不得读写 filesystem/metadata/audit/approval，不得调度 runner，不得实现真实 execution policy enforcement，不得连接 NAS，不得触发备份/恢复，不得执行远程命令。

## 设计选择

新增纯函数：

```js
buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness()
```

该函数无参数，返回固定 disabled execution policy readiness。它不能读取 config、manifest、runnerBinding、executionPreview、approval、环境变量或文件系统。

输出挂到 `runnerWiringContract` 内：

```js
runnerWiringContract: {
  ...,
  executionPolicyReadiness: {
    command: 'supervisor-lifecycle-guarded-runner-execution-policy-readiness',
    state: 'blocked',
    executionPolicyDefined: true,
    executionPolicyReady: false,
    realExecutionPolicyReady: false,
    readyCount: 0,
    blockedCount: 1,
    policyEntries: [...],
    blockers: [
      'execution-policy-real-implementation-missing',
      'real-guarded-runner-execution-wiring-missing'
    ],
    nextBlockers: ['execution-policy-real-implementation-missing'],
    safety: executionPreviewSafety()
  }
}
```

Execution gate `gates` 新增：

```js
executionPolicyReady: false
```

该 gate 是 `executionEligible` 的必要条件之一，但在 V1.23 必须硬编码为 `false`。它不得由 config、manifest、runnerBinding、executionPreview、approval record、API body 或任何 runtime 输入驱动为 `true`。

## Policy Entries

`policyEntries` 必须固定为 exactly 1 个 disabled entry：

```js
{
  policyKind: 'disabled-execution-policy-stub',
  state: 'blocked',
  realImplementationReady: false,
  approvalPolicyDefined: true,
  approvalPolicyEnforced: false,
  allowLifecycleApply: false,
  allowHostMutation: false,
  allowLaunchctl: false,
  allowFilesystemWrite: false,
  allowMetadataWrite: false,
  allowAuditWrite: false,
  allowRollbackAnchorWrite: false,
  allowNasConnection: false,
  allowBackupRestore: false,
  allowRemoteCommand: false,
  wouldAuthorizeExecution: false,
  wouldRun: false,
  wouldWrite: false,
  sensitiveValuesReturned: false,
  blockerCode: 'execution-policy-real-implementation-missing',
}
```

不允许从 runtime payload 生成 entries。不得返回路径、URL、hostname、username、token、secret、Authorization、hash、approval identity、reason、acknowledgement、command、process id、operator address 或 notification payload。

## 与 V1.17-V1.22 Contract 的关系

V1.23 将 `runnerWiringContract.requiredContracts` 从 5 个扩展为 6 个：

1. `execution-policy`
2. `runner-registry`
3. `host-mutation-adapter`
4. `rollback-anchor`
5. `attempt-audit`
6. `operator-recovery`

全部仍为 `status:'blocked'`、`requiredForExecution:true`。新增 `execution-policy` 的 blocker 为 `execution-policy-missing`。现有五个 contract 的 blocker 不得移除或改名。

`executionPolicyDefined:true` 仅表示静态数据结构存在，不表示真实执行授权、策略校验或 enforcement 已实现。

## Web 显示

Web Console 仍复用 existing execution gate result area。可新增只读 line：

```text
executionPolicy:disabled-execution-policy-stub:state:blocked:realImplementationReady:false:wouldAuthorizeExecution:false:blocker:execution-policy-real-implementation-missing
```

不得新增按钮、不得改变点击请求体、不得初始请求 gate API。

## 测试要求

1. 纯函数 `buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness()` 返回固定 blocked execution policy readiness。
2. `policyEntries` exactly 1 个，`policyKind` 固定 `disabled-execution-policy-stub`，所有授权、执行、写入、host/NAS/remote flag 均 false。
3. Safety deepStrictEqual `executionPreviewSafety()` 完整字段。
4. `runnerWiringContract.requiredContracts` exactly 6 个，并包含 `execution-policy` / `execution-policy-missing`，同时保留现有五个 contract。
5. `runnerWiringContract` 包含 `executionPolicyReadiness`，但 `runnerWiringContractReady:false`、`executionPolicyReady:false`、`runnerRegistryReady:false`、`hostMutationAdapterReady:false`、`rollbackAnchorReady:false`、`attemptAuditReady:false`、`operatorRecoveryReady:false`、`realRunnerWiringReady:false` 不变。
6. API/CLI 输出透传 execution policy readiness，且不泄露敏感字段。
7. Web view model/DOM 渲染固定 `executionPolicy:` line，与现有 lines 可区分；恶意 payload 即使声明 `executionPolicyReady:true`、`policyEntries[0].wouldAuthorizeExecution:true` 或替换 `policyEntries[0].policyKind`，显示仍必须为 blocked/false 且不泄露。
8. Version/README/Gold readiness 同步到 V1.23，Gold 仍 blocked。

## 非目标

- 不实现真实 execution policy enforcement。
- 不实现真实 runner authorization。
- 不实现真实 lifecycle apply dispatch。
- 不实现真实 retry、recovery、notification 或 runbook。
- 不写 audit、metadata、filesystem、approval 或 rollback anchor。
- 不调用 launchctl、shell 或 process list。
- 不实现 runner dispatch。
- 不执行 install/uninstall/rollback/recover。
- 不修改 auth/write-route 语义。

## 运行韧性设计门

正常态定义：V1.23 正常态是所有 policy readiness 输出均为 blocked/false，Web/API/CLI/pure contract 都能显示 `executionPolicyReady:false`，Gold 继续 blocked。

恢复锚点：最近 green commit `14d65e7`。如实现出现越界执行能力或测试失败，回到该 commit 的 V1.22 disabled operator recovery readiness 状态。

三支柱策略：

- 有界失效：任何 runtime-looking input 只能被忽略或被固定 blocked line 覆盖，验证 task 为 malicious payload tests。
- 异常恢复：发现 policy readiness 被 runtime payload 驱动为 true 时，恢复到固定 no-arg helper 与 hardcoded Web line。
- 状态侦测：测试必须检查 pure/API/CLI/Web/README/Gold/version；`npm test` 是最终全量信号。

## 完成标准

V1.23 只能证明 disabled execution policy readiness 存在。真实 runner wiring、真实 execution policy enforcement 与 Gold 发布能力仍缺失，Gold 仍 blocked。
