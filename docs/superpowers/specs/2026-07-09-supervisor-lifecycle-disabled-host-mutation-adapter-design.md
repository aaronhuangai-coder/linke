# V1.19 Supervisor Lifecycle Disabled Host Mutation Adapter Design

## 目标

V1.19 为 V1.17 的 `runnerWiringContract` 增加 code-owned disabled host mutation adapter readiness。它只声明 Linke 已有一个固定、禁用的 host mutation adapter readiness 数据结构，用于后续真实 guarded host action wiring 的设计锚点；当前仍没有任何真实 host mutation adapter。

V1.19 必须继续保持：

- `runnerWiringContract.state:'blocked'`
- `runnerWiringContractReady:false`
- `runnerRegistryReady:false`
- `hostMutationAdapterReady:false`
- `realRunnerWiringReady:false`
- `executionEligible:false`
- `executorReady:false`
- `wouldExecute:false`
- `real-guarded-runner-execution-wiring-missing`

不新增 endpoint、CLI command、Web button。`src/agent.js` 不需要修改。不得执行 lifecycle apply，不得调用 launchctl/shell，不得读取进程列表，不得读写 filesystem/metadata/audit/approval，不得连接 NAS，不得触发备份/恢复，不得执行远程命令。

## 设计选择

新增纯函数：

```js
buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness()
```

该函数无参数，返回固定 disabled host mutation adapter readiness。它不能读取 config、manifest、runnerBinding、executionPreview、approval、环境变量或文件系统。

输出挂到 V1.17 的 `runnerWiringContract` 内：

```js
runnerWiringContract: {
  ...,
  hostMutationAdapterReadiness: {
    command: 'supervisor-lifecycle-guarded-runner-host-mutation-adapter-readiness',
    state: 'blocked',
    hostMutationAdapterDefined: true,
    hostMutationAdapterReady: false,
    realHostMutationAdapterReady: false,
    readyCount: 0,
    blockedCount: 1,
    adapterEntries: [...],
    blockers: [
      'host-mutation-adapter-real-implementation-missing',
      'real-guarded-runner-execution-wiring-missing'
    ],
    nextBlockers: ['host-mutation-adapter-real-implementation-missing'],
    safety: executionPreviewSafety()
  }
}
```

Execution gate `gates` 新增：

```js
hostMutationAdapterReady: false
```

该 gate 是 `executionEligible` 的必要条件之一，但在 V1.19 必须硬编码为 `false`。它不得由 config、manifest、runnerBinding、executionPreview、registry entry、approval record、API body 或任何 runtime 输入驱动为 `true`。由于 `hostMutationAdapterReady:false`，`executionEligible` 必须继续固定为 `false`。

## Adapter Entries

`adapterEntries` 必须固定为 exactly 1 个 disabled entry：

```js
{
  adapterKind: 'disabled-host-mutation-adapter-stub',
  state: 'blocked',
  realImplementationReady: false,
  wouldMutateHost: false,
  wouldRun: false,
  wouldWrite: false,
  launchctlAllowed: false,
  filesystemWriteAllowed: false,
  processListReadAllowed: false,
  metadataWriteAllowed: false,
  auditWriteAllowed: false,
  rollbackAnchorWriteAllowed: false,
  blockerCode: 'host-mutation-adapter-real-implementation-missing',
}
```

不允许从 runtime payload 生成 entries。不得返回路径、URL、hostname、username、token、secret、Authorization、hash、approval identity、reason、acknowledgement、command、process id。

## 与 V1.17 Contract 的关系

V1.19 不把 V1.17 的 `host-mutation-adapter` required contract 标记为 ready。原因：只有 disabled adapter readiness 数据结构，不代表真实 host mutation adapter 已实现。

`runnerWiringContract.requiredContracts` 仍必须 exactly 5 个，全部 `status:'blocked'`、`requiredForExecution:true`。`host-mutation-adapter` 的 blocker 仍为 `host-mutation-adapter-missing`，且可追加展示 host mutation adapter readiness blocker；不得移除或替换 `host-mutation-adapter-missing`，也不能移除 `real-guarded-runner-execution-wiring-missing`。

`hostMutationAdapterDefined:true` 仅表示静态数据结构存在，不表示真实 host mutation 能力存在。

## Web 显示

Web Console 仍复用 existing execution gate result area。可新增只读 line：

```text
hostMutationAdapter:disabled-host-mutation-adapter-stub:state:blocked:realImplementationReady:false:wouldMutateHost:false:blocker:host-mutation-adapter-real-implementation-missing
```

不得新增按钮、不得改变点击请求体、不得初始请求 gate API。

## 测试要求

1. 纯函数 `buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness()` 返回固定 blocked adapter readiness。
2. `adapterEntries` exactly 1 个，adapterKind 固定 `disabled-host-mutation-adapter-stub`，所有执行/写入/host mutation flag 均 false。
3. Safety deepStrictEqual `executionPreviewSafety()` 完整字段。
4. `runnerWiringContract` 包含 `hostMutationAdapterReadiness`，但 `runnerWiringContractReady:false`、`runnerRegistryReady:false`、`hostMutationAdapterReady:false`、`realRunnerWiringReady:false` 不变。
5. API/CLI 输出透传 host mutation adapter readiness，且不泄露敏感字段。
6. Web view model/DOM 渲染固定 `hostMutationAdapter:` line，与 `candidate:`、`wiringContract:`、`runnerRegistry:` lines 可区分；恶意 payload 即使声明 `hostMutationAdapterReady:true`、`adapterEntries[0].wouldMutateHost:true` 或替换 `adapterEntries[0].adapterKind`，显示仍必须为 blocked/false 且不泄露。
7. Version/README/Gold readiness 同步到 V1.19，Gold 仍 blocked。

## 非目标

- 不实现真实 host mutation adapter。
- 不调用 launchctl、shell 或 process list。
- 不写 plist、metadata、audit 或 rollback anchor。
- 不实现 runner dispatch。
- 不执行 install/uninstall/rollback/recover。
- 不修改 auth/write-route 语义。

## 完成标准

V1.19 只能证明 disabled host mutation adapter readiness 存在。真实 runner wiring 仍缺失，Gold 仍 blocked。
