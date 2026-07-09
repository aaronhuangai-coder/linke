# V1.18 Supervisor Lifecycle Disabled Runner Registry Design

## 目标

V1.18 为 V1.17 的 `runnerWiringContract` 增加 code-owned disabled runner registry readiness。它只声明 Linke 已有一个固定、禁用的 registry catalog，用于后续真实 runner wiring 的设计锚点；当前仍没有任何真实 runner implementation。

V1.18 必须继续保持：

- `runnerWiringContract.state:'blocked'`
- `runnerWiringContractReady:false`
- `runnerRegistryReady:false`
- `realRunnerWiringReady:false`
- `executionEligible:false`
- `executorReady:false`
- `wouldExecute:false`
- `real-guarded-runner-execution-wiring-missing`

不新增 endpoint、CLI command、Web button。`src/agent.js` 不需要修改。不得执行 lifecycle apply，不得调用 launchctl/shell，不得读取进程列表，不得读写 filesystem/metadata/audit/approval，不得连接 NAS，不得触发备份/恢复，不得执行远程命令。

## 设计选择

新增纯函数：

```js
buildSupervisorLifecycleGuardedRunnerRegistryReadiness()
```

该函数无参数，返回固定 disabled registry readiness。它不能读取 manifest、runnerBinding、executionPreview、config、approval、环境变量或文件系统。

输出挂到 V1.17 的 `runnerWiringContract` 内：

```js
runnerWiringContract: {
  ...,
  runnerRegistryReadiness: {
    command: 'supervisor-lifecycle-guarded-runner-registry-readiness',
    state: 'blocked',
    runnerRegistryDefined: true,
    runnerRegistryReady: false,
    realRunnerImplementationsReady: false,
    readyCount: 0,
    blockedCount: 1,
    registryEntries: [...],
    blockers: [
      'runner-registry-real-implementation-missing',
      'real-guarded-runner-execution-wiring-missing'
    ],
    nextBlockers: ['runner-registry-real-implementation-missing'],
    safety: executionPreviewSafety()
  }
}
```

Execution gate `gates` 新增：

```js
runnerRegistryReady: false
```

该 gate 是 `executionEligible` 的必要条件之一，但在 V1.18 必须硬编码为 `false`。它不得由 config、manifest、runnerBinding、executionPreview、registry entry、approval record、API body 或任何 runtime 输入驱动为 `true`。由于 `runnerRegistryReady:false`，`executionEligible` 必须继续固定为 `false`。

## Registry Entries

`registryEntries` 必须固定为 exactly 1 个 disabled entry：

```js
{
  runnerKind: 'guarded-runner-stub',
  state: 'blocked',
  realImplementationReady: false,
  supportsHostMutation: false,
  wouldExecute: false,
  wouldRun: false,
  wouldWrite: false,
  blockerCode: 'runner-registry-real-implementation-missing',
}
```

不允许从 runtime payload 生成 entries。不得返回路径、URL、hostname、username、token、secret、Authorization、hash、approval identity、reason、acknowledgement、command、process id。

## 与 V1.17 Contract 的关系

V1.18 不把 V1.17 的 `runner-registry` required contract 标记为 ready。原因：只有 disabled registry catalog，不代表真实 runner implementation 已实现。

`runnerWiringContract.requiredContracts` 仍必须 exactly 5 个，全部 `status:'blocked'`、`requiredForExecution:true`。`runner-registry` 的 blocker 仍为 `runner-registry-missing`，且可追加展示 registry readiness blocker；不得移除或替换 `runner-registry-missing`，也不能移除 `real-guarded-runner-execution-wiring-missing`。

`runnerRegistryDefined:true` 仅表示静态数据结构存在，不表示真实 registry lookup 或 runner implementation 存在。

## Web 显示

Web Console 仍复用 existing execution gate result area。可新增只读 line：

```text
runnerRegistry:guarded-runner-stub:state:blocked:realImplementationReady:false:wouldExecute:false:blocker:runner-registry-real-implementation-missing
```

不得新增按钮、不得改变点击请求体、不得初始请求 gate API。

## 测试要求

1. 纯函数 `buildSupervisorLifecycleGuardedRunnerRegistryReadiness()` 返回固定 blocked registry readiness。
2. `registryEntries` exactly 1 个，runnerKind 固定 `guarded-runner-stub`，所有执行/写入 flag 均 false。
3. Safety deepStrictEqual `executionPreviewSafety()` 完整字段。
4. `runnerWiringContract` 包含 `runnerRegistryReadiness`，但 `runnerWiringContractReady:false`、`runnerRegistryReady:false`、`realRunnerWiringReady:false` 不变。
5. API/CLI 输出透传 registry readiness，且不泄露敏感字段。
6. Web view model/DOM 渲染固定 `runnerRegistry:` line，与 `candidate:`、`wiringContract:` lines 可区分；恶意 payload 即使声明 `runnerRegistryReady:true`、`registryEntries[0].wouldExecute:true` 或替换 `registryEntries[0].runnerKind`，显示仍必须为 blocked/false 且不泄露。
7. Version/README/Gold readiness 同步到 V1.18，Gold 仍 blocked。

## 非目标

- 不实现真实 runner registry lookup。
- 不实现 runner dispatch。
- 不实现 host mutation adapter。
- 不写 plist、metadata、audit 或 rollback anchor。
- 不执行 install/uninstall/rollback/recover。
- 不修改 auth/write-route 语义。

## 完成标准

V1.18 只能证明 disabled registry catalog/readiness 存在。真实 runner wiring 仍缺失，Gold 仍 blocked。
