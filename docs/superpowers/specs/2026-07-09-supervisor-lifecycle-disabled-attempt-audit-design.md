# V1.21 Supervisor Lifecycle Disabled Attempt Audit Design

## 目标

V1.21 为 V1.17 的 `runnerWiringContract` 增加 code-owned disabled attempt audit readiness。它只声明 Linke 已有一个固定、禁用的 real execution attempt audit readiness 数据结构，用于后续真实 guarded lifecycle apply 的不可变执行尝试审计设计；当前仍没有任何真实 audit write 或 immutable audit strategy。

V1.21 必须继续保持：

- `runnerWiringContract.state:'blocked'`
- `runnerWiringContractReady:false`
- `runnerRegistryReady:false`
- `hostMutationAdapterReady:false`
- `rollbackAnchorReady:false`
- `attemptAuditReady:false`
- `realRunnerWiringReady:false`
- `executionEligible:false`
- `executorReady:false`
- `wouldExecute:false`
- `real-guarded-runner-execution-wiring-missing`

不新增 endpoint、CLI command、Web button。`src/agent.js` 不需要修改。不得执行 lifecycle apply，不得调用 launchctl/shell，不得读取进程列表，不得读写 filesystem/metadata/audit/approval，不得写 attempt audit，不得连接 NAS，不得触发备份/恢复，不得执行远程命令。

## 设计选择

新增纯函数：

```js
buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness()
```

该函数无参数，返回固定 disabled attempt audit readiness。它不能读取 config、manifest、runnerBinding、executionPreview、approval、环境变量或文件系统。

输出挂到 V1.17 的 `runnerWiringContract` 内：

```js
runnerWiringContract: {
  ...,
  attemptAuditReadiness: {
    command: 'supervisor-lifecycle-guarded-runner-attempt-audit-readiness',
    state: 'blocked',
    attemptAuditDefined: true,
    attemptAuditReady: false,
    realAttemptAuditReady: false,
    readyCount: 0,
    blockedCount: 1,
    auditEntries: [...],
    blockers: [
      'attempt-audit-real-implementation-missing',
      'real-guarded-runner-execution-wiring-missing'
    ],
    nextBlockers: ['attempt-audit-real-implementation-missing'],
    safety: executionPreviewSafety()
  }
}
```

Execution gate `gates` 新增：

```js
attemptAuditReady: false
```

该 gate 是 `executionEligible` 的必要条件之一，但在 V1.21 必须硬编码为 `false`。它不得由 config、manifest、runnerBinding、executionPreview、approval record、API body 或任何 runtime 输入驱动为 `true`。由于 `attemptAuditReady:false`，`executionEligible` 必须继续固定为 `false`。

## Audit Entries

`auditEntries` 必须固定为 exactly 1 个 disabled entry：

```js
{
  auditKind: 'disabled-attempt-audit-stub',
  state: 'blocked',
  realImplementationReady: false,
  wouldWriteAudit: false,
  wouldRun: false,
  wouldWrite: false,
  auditWriteAllowed: false,
  metadataWriteAllowed: false,
  filesystemWriteAllowed: false,
  immutableAuditReady: false,
  sensitiveValuesReturned: false,
  blockerCode: 'attempt-audit-real-implementation-missing',
}
```

不允许从 runtime payload 生成 entries。不得返回路径、URL、hostname、username、token、secret、Authorization、hash、approval identity、reason、acknowledgement、command、process id。

## 与 V1.17 Contract 的关系

V1.21 不把 V1.17 的 `attempt-audit` required contract 标记为 ready。原因：只有 disabled attempt audit readiness 数据结构，不代表真实 immutable execution attempt audit strategy 已实现。

`runnerWiringContract.requiredContracts` 仍必须 exactly 5 个，全部 `status:'blocked'`、`requiredForExecution:true`。`attempt-audit` 的 blocker 仍为 `attempt-audit-missing`，且可追加展示 attempt audit readiness blocker；不得移除或替换 `attempt-audit-missing`，也不能移除 `real-guarded-runner-execution-wiring-missing`。

`attemptAuditDefined:true` 仅表示静态数据结构存在，不表示真实 audit write 能力存在。

## Web 显示

Web Console 仍复用 existing execution gate result area。可新增只读 line：

```text
attemptAudit:disabled-attempt-audit-stub:state:blocked:realImplementationReady:false:wouldWriteAudit:false:blocker:attempt-audit-real-implementation-missing
```

不得新增按钮、不得改变点击请求体、不得初始请求 gate API。

## 测试要求

1. 纯函数 `buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness()` 返回固定 blocked attempt audit readiness。
2. `auditEntries` exactly 1 个，auditKind 固定 `disabled-attempt-audit-stub`，所有执行/写入/audit flag 均 false。
3. Safety deepStrictEqual `executionPreviewSafety()` 完整字段。
4. `runnerWiringContract` 包含 `attemptAuditReadiness`，但 `runnerWiringContractReady:false`、`runnerRegistryReady:false`、`hostMutationAdapterReady:false`、`rollbackAnchorReady:false`、`attemptAuditReady:false`、`realRunnerWiringReady:false` 不变。
5. API/CLI 输出透传 attempt audit readiness，且不泄露敏感字段。
6. Web view model/DOM 渲染固定 `attemptAudit:` line，与 `candidate:`、`wiringContract:`、`runnerRegistry:`、`hostMutationAdapter:`、`rollbackAnchor:` lines 可区分；恶意 payload 即使声明 `attemptAuditReady:true`、`auditEntries[0].wouldWriteAudit:true` 或替换 `auditEntries[0].auditKind`，显示仍必须为 blocked/false 且不泄露。
7. Version/README/Gold readiness 同步到 V1.21，Gold 仍 blocked。

## 非目标

- 不实现真实 attempt audit writer。
- 不写 audit、metadata、filesystem、approval 或 rollback anchor。
- 不调用 launchctl、shell 或 process list。
- 不实现 runner dispatch。
- 不执行 install/uninstall/rollback/recover。
- 不修改 auth/write-route 语义。

## 完成标准

V1.21 只能证明 disabled attempt audit readiness 存在。真实 runner wiring 仍缺失，Gold 仍 blocked。
