# V1.22 Supervisor Lifecycle Disabled Operator Recovery Design

## 目标

V1.22 为 V1.17 的 `runnerWiringContract` 增加 code-owned disabled operator recovery readiness。它只声明 Linke 已有一个固定、禁用的 failure recovery / retry limit / operator runbook readiness 数据结构，用于后续真实 guarded lifecycle apply 的失败恢复设计；当前仍没有任何真实恢复、重试、通知、runbook 执行或 operator workflow。

V1.22 必须继续保持：

- `runnerWiringContract.state:'blocked'`
- `runnerWiringContractReady:false`
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

不新增 endpoint、CLI command、Web button。`src/agent.js` 不需要修改。不得执行 lifecycle apply，不得调用 launchctl/shell，不得读取进程列表，不得读写 filesystem/metadata/audit/approval，不得执行 failure recovery、retry、rollback、operator notification，不得连接 NAS，不得触发备份/恢复，不得执行远程命令。

## 设计选择

新增纯函数：

```js
buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness()
```

该函数无参数，返回固定 disabled operator recovery readiness。它不能读取 config、manifest、runnerBinding、executionPreview、approval、环境变量或文件系统。

输出挂到 V1.17 的 `runnerWiringContract` 内：

```js
runnerWiringContract: {
  ...,
  operatorRecoveryReadiness: {
    command: 'supervisor-lifecycle-guarded-runner-operator-recovery-readiness',
    state: 'blocked',
    operatorRecoveryDefined: true,
    operatorRecoveryReady: false,
    realOperatorRecoveryReady: false,
    readyCount: 0,
    blockedCount: 1,
    recoveryEntries: [...],
    blockers: [
      'operator-recovery-real-implementation-missing',
      'real-guarded-runner-execution-wiring-missing'
    ],
    nextBlockers: ['operator-recovery-real-implementation-missing'],
    safety: executionPreviewSafety()
  }
}
```

Execution gate `gates` 新增：

```js
operatorRecoveryReady: false
```

该 gate 是 `executionEligible` 的必要条件之一，但在 V1.22 必须硬编码为 `false`。它不得由 config、manifest、runnerBinding、executionPreview、approval record、API body 或任何 runtime 输入驱动为 `true`。由于 `operatorRecoveryReady:false`，`executionEligible` 必须继续固定为 `false`。

## Recovery Entries

`recoveryEntries` 必须固定为 exactly 1 个 disabled entry：

```js
{
  recoveryKind: 'disabled-operator-recovery-stub',
  state: 'blocked',
  realImplementationReady: false,
  failureRecoveryReady: false,
  retryLimitReady: false,
  operatorRunbookReady: false,
  wouldRecover: false,
  wouldRetry: false,
  wouldNotifyOperator: false,
  wouldRun: false,
  wouldWrite: false,
  metadataWriteAllowed: false,
  filesystemWriteAllowed: false,
  remoteCommandAllowed: false,
  operatorNotificationAllowed: false,
  sensitiveValuesReturned: false,
  blockerCode: 'operator-recovery-real-implementation-missing',
}
```

不允许从 runtime payload 生成 entries。不得返回路径、URL、hostname、username、token、secret、Authorization、hash、approval identity、reason、acknowledgement、command、process id、operator address 或 notification payload。

## 与 V1.17 Contract 的关系

V1.22 不把 V1.17 的 `operator-recovery` required contract 标记为 ready。原因：只有 disabled operator recovery readiness 数据结构，不代表真实 failure recovery、retry limit 或 operator runbook 已实现。

`runnerWiringContract.requiredContracts` 仍必须 exactly 5 个，全部 `status:'blocked'`、`requiredForExecution:true`。`operator-recovery` 的 blocker 仍为 `operator-recovery-missing`，且可追加展示 operator recovery readiness blocker；不得移除或替换 `operator-recovery-missing`，也不能移除 `real-guarded-runner-execution-wiring-missing`。

`operatorRecoveryDefined:true` 仅表示静态数据结构存在，不表示真实恢复能力存在。

## Web 显示

Web Console 仍复用 existing execution gate result area。可新增只读 line：

```text
operatorRecovery:disabled-operator-recovery-stub:state:blocked:realImplementationReady:false:wouldRecover:false:blocker:operator-recovery-real-implementation-missing
```

不得新增按钮、不得改变点击请求体、不得初始请求 gate API。

## 测试要求

1. 纯函数 `buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness()` 返回固定 blocked operator recovery readiness。
2. `recoveryEntries` exactly 1 个，`recoveryKind` 固定 `disabled-operator-recovery-stub`，所有恢复/重试/通知/执行/写入 flag 均 false。
3. Safety deepStrictEqual `executionPreviewSafety()` 完整字段。
4. `runnerWiringContract` 包含 `operatorRecoveryReadiness`，但 `runnerWiringContractReady:false`、`runnerRegistryReady:false`、`hostMutationAdapterReady:false`、`rollbackAnchorReady:false`、`attemptAuditReady:false`、`operatorRecoveryReady:false`、`realRunnerWiringReady:false` 不变。
5. API/CLI 输出透传 operator recovery readiness，且不泄露敏感字段。
6. Web view model/DOM 渲染固定 `operatorRecovery:` line，与 `candidate:`、`wiringContract:`、`runnerRegistry:`、`hostMutationAdapter:`、`rollbackAnchor:`、`attemptAudit:` lines 可区分；恶意 payload 即使声明 `operatorRecoveryReady:true`、`recoveryEntries[0].wouldRecover:true` 或替换 `recoveryEntries[0].recoveryKind`，显示仍必须为 blocked/false 且不泄露。
7. Version/README/Gold readiness 同步到 V1.22，Gold 仍 blocked。

## 非目标

- 不实现真实 failure recovery。
- 不实现真实 retry scheduler、retry executor 或 retry state store。
- 不实现 operator notification、runbook execution 或 escalation workflow。
- 不写 audit、metadata、filesystem、approval 或 rollback anchor。
- 不调用 launchctl、shell 或 process list。
- 不实现 runner dispatch。
- 不执行 install/uninstall/rollback/recover。
- 不修改 auth/write-route 语义。

## 完成标准

V1.22 只能证明 disabled operator recovery readiness 存在。真实 runner wiring 仍缺失，Gold 仍 blocked。
