# V1.20 Supervisor Lifecycle Disabled Rollback Anchor Design

## 目标

V1.20 为 V1.17 的 `runnerWiringContract` 增加 code-owned disabled rollback anchor readiness。它只声明 Linke 已有一个固定、禁用的 rollback anchor readiness 数据结构，用于后续真实 guarded lifecycle apply 的回滚锚点设计；当前仍没有任何真实 rollback anchor 写入或验证能力。

V1.20 必须继续保持：

- `runnerWiringContract.state:'blocked'`
- `runnerWiringContractReady:false`
- `runnerRegistryReady:false`
- `hostMutationAdapterReady:false`
- `rollbackAnchorReady:false`
- `realRunnerWiringReady:false`
- `executionEligible:false`
- `executorReady:false`
- `wouldExecute:false`
- `real-guarded-runner-execution-wiring-missing`

不新增 endpoint、CLI command、Web button。`src/agent.js` 不需要修改。不得执行 lifecycle apply，不得调用 launchctl/shell，不得读取进程列表，不得读写 filesystem/metadata/audit/approval，不得写 rollback anchor，不得连接 NAS，不得触发备份/恢复，不得执行远程命令。

## 设计选择

新增纯函数：

```js
buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness()
```

该函数无参数，返回固定 disabled rollback anchor readiness。它不能读取 config、manifest、runnerBinding、executionPreview、approval、环境变量或文件系统。

输出挂到 V1.17 的 `runnerWiringContract` 内：

```js
runnerWiringContract: {
  ...,
  rollbackAnchorReadiness: {
    command: 'supervisor-lifecycle-guarded-runner-rollback-anchor-readiness',
    state: 'blocked',
    rollbackAnchorDefined: true,
    rollbackAnchorReady: false,
    realRollbackAnchorReady: false,
    readyCount: 0,
    blockedCount: 1,
    anchorEntries: [...],
    blockers: [
      'rollback-anchor-real-implementation-missing',
      'real-guarded-runner-execution-wiring-missing'
    ],
    nextBlockers: ['rollback-anchor-real-implementation-missing'],
    safety: executionPreviewSafety()
  }
}
```

Execution gate `gates` 新增：

```js
rollbackAnchorReady: false
```

该 gate 是 `executionEligible` 的必要条件之一，但在 V1.20 必须硬编码为 `false`。它不得由 config、manifest、runnerBinding、executionPreview、approval record、API body 或任何 runtime 输入驱动为 `true`。由于 `rollbackAnchorReady:false`，`executionEligible` 必须继续固定为 `false`。

## Anchor Entries

`anchorEntries` 必须固定为 exactly 1 个 disabled entry：

```js
{
  anchorKind: 'disabled-rollback-anchor-stub',
  state: 'blocked',
  realImplementationReady: false,
  wouldWriteAnchor: false,
  wouldRun: false,
  wouldWrite: false,
  filesystemWriteAllowed: false,
  metadataWriteAllowed: false,
  rollbackAnchorWriteAllowed: false,
  rollbackRestoreAllowed: false,
  sensitiveValuesReturned: false,
  blockerCode: 'rollback-anchor-real-implementation-missing',
}
```

不允许从 runtime payload 生成 entries。不得返回路径、URL、hostname、username、token、secret、Authorization、hash、approval identity、reason、acknowledgement、command、process id。

## 与 V1.17 Contract 的关系

V1.20 不把 V1.17 的 `rollback-anchor` required contract 标记为 ready。原因：只有 disabled rollback anchor readiness 数据结构，不代表真实 rollback anchor 写入和验证策略已实现。

`runnerWiringContract.requiredContracts` 仍必须 exactly 5 个，全部 `status:'blocked'`、`requiredForExecution:true`。`rollback-anchor` 的 blocker 仍为 `rollback-anchor-missing`，且可追加展示 rollback anchor readiness blocker；不得移除或替换 `rollback-anchor-missing`，也不能移除 `real-guarded-runner-execution-wiring-missing`。

`rollbackAnchorDefined:true` 仅表示静态数据结构存在，不表示真实 rollback anchor 写入能力存在。

## Web 显示

Web Console 仍复用 existing execution gate result area。可新增只读 line：

```text
rollbackAnchor:disabled-rollback-anchor-stub:state:blocked:realImplementationReady:false:wouldWriteAnchor:false:blocker:rollback-anchor-real-implementation-missing
```

不得新增按钮、不得改变点击请求体、不得初始请求 gate API。

## 测试要求

1. 纯函数 `buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness()` 返回固定 blocked rollback anchor readiness。
2. `anchorEntries` exactly 1 个，anchorKind 固定 `disabled-rollback-anchor-stub`，所有执行/写入/anchor flag 均 false。
3. Safety deepStrictEqual `executionPreviewSafety()` 完整字段。
4. `runnerWiringContract` 包含 `rollbackAnchorReadiness`，但 `runnerWiringContractReady:false`、`runnerRegistryReady:false`、`hostMutationAdapterReady:false`、`rollbackAnchorReady:false`、`realRunnerWiringReady:false` 不变。
5. API/CLI 输出透传 rollback anchor readiness，且不泄露敏感字段。
6. Web view model/DOM 渲染固定 `rollbackAnchor:` line，与 `candidate:`、`wiringContract:`、`runnerRegistry:`、`hostMutationAdapter:` lines 可区分；恶意 payload 即使声明 `rollbackAnchorReady:true`、`anchorEntries[0].wouldWriteAnchor:true` 或替换 `anchorEntries[0].anchorKind`，显示仍必须为 blocked/false 且不泄露。
7. Version/README/Gold readiness 同步到 V1.20，Gold 仍 blocked。

## 非目标

- 不实现真实 rollback anchor。
- 不写 plist、metadata、audit、approval 或 rollback anchor。
- 不调用 launchctl、shell 或 process list。
- 不实现 runner dispatch。
- 不执行 install/uninstall/rollback/recover。
- 不修改 auth/write-route 语义。

## 完成标准

V1.20 只能证明 disabled rollback anchor readiness 存在。真实 runner wiring 仍缺失，Gold 仍 blocked。
