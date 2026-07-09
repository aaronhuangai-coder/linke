# V1.14 Supervisor Lifecycle Guarded Runner Execution Gate CLI Design

## 目标

V1.14 将 V1.13 的纯函数 `buildSupervisorLifecycleGuardedRunnerExecutionGate(...)` 暴露为只读 Agent CLI 命令：

```bash
node src/agent.js supervisor-lifecycle-guarded-runner-execution-gate \
  --config <path> \
  --operation <install|uninstall|rollback|recover> \
  --data-dir <path> \
  --manifest <path> \
  --runner-binding <path>
```

该命令用于把本地配置、已持久化审批记录、executor manifest、guarded runner binding、execution preview 和 execution gate 组合成一个 sanitized blocked JSON 报告。它只证明“真实执行前的门禁链路可由 CLI 串起来”，不代表真实执行能力已经存在。

本阶段仍不调用 `executeSupervisorLifecycleApply`、launchctl、shell、NAS、备份、恢复、远程命令、进程列表读取、metadata 写入、audit 写入或任何真实 guarded runner。

## CLI 契约

新增命令：

```text
supervisor-lifecycle-guarded-runner-execution-gate
```

必需参数：

- `--config <path>`：读取 Linke config，经 `loadConfig` + `validateConfig` 校验。
- `--operation <install|uninstall|rollback|recover>`：沿用 supervisor lifecycle operation allowlist。
- `--data-dir <path>`：只读读取已持久化 approval records。
- `--manifest <path>`：读取 executor manifest JSON。
- `--runner-binding <path>`：读取 guarded runner binding JSON。

可选布尔参数：

- `--execute-requested`：仅把 `options.executeRequested:true` 传给 gate，表示操作员显式请求进入执行门禁；它不能触发真实执行。
- `--fail-on-blocked`：当输出 `state:"blocked"` 时打印 JSON 后退出码为 2。

拒绝参数：

- `--apply`：拒绝，错误为 `--apply is not supported`。
- `--approval`：拒绝，错误为 `--approval is not supported`。
- `--output`：拒绝，错误为 `--output is not supported`。
- `--execute-requested <value>`：拒绝，错误为 `--execute-requested does not accept a value`。
- `--fail-on-blocked <value>`：拒绝，错误为 `--fail-on-blocked does not accept a value`。

## 数据流

命令内部按顺序执行：

1. 读取并校验 config。
2. 只读读取 approval records：`readSupervisorLifecycleApprovalRecords(args['data-dir'])`。
3. 读取并解析 manifest JSON。
4. 读取并解析 runner binding JSON。
5. 构建 plan：

```js
buildSupervisorLifecycleApplyPlan(config, {
  operation: args.operation,
  apply: true,
  envGateEnabled: true,
});
```

6. 构建 apply readiness：

```js
buildSupervisorLifecycleApplyReadiness(plan, approvalRecords);
```

7. 构建 manifest readiness：

```js
validateSupervisorLifecycleExecutorManifest(plan, manifest);
```

8. 构建 guarded runner readiness：

```js
buildSupervisorLifecycleGuardedRunnerReadiness(manifestReadiness, runnerBinding);
```

9. 构建 execution preview：

```js
buildSupervisorLifecycleGuardedRunnerExecutionPreview(plan, guardedRunnerReadiness);
```

10. 构建 execution gate：

```js
buildSupervisorLifecycleGuardedRunnerExecutionGate(
  plan,
  applyReadiness,
  manifestReadiness,
  guardedRunnerReadiness,
  executionPreview,
  { executeRequested: args['execute-requested'] === true },
);
```

## 输出契约

输出必须是 V1.13 gate 的 JSON 原样结构，且固定保持 blocked：

- `command:'supervisor-lifecycle-guarded-runner-execution-gate'`
- `state:'blocked'`
- `executionGateState:'blocked'`
- `executionEligible:false`
- `executorReady:false`
- `wouldExecute:false`
- `gates.realRunnerWiringReady:false`
- `nextBlockers:['real-guarded-runner-execution-wiring-missing']`
- `safety.readOnly:true`
- `safety.dryRun:true`
- `safety.lifecycleApplied:false`
- `safety.filesystemWritten:false`
- `safety.launchctlCalled:false`
- `safety.processListRead:false`
- `safety.auditEventWritten:false`
- `safety.metadataWritten:false`

当未传 `--execute-requested` 时，`blockers` 必须包含 `execute-request-missing`。传入 `--execute-requested` 后，`execute-request-missing` 可以消失，但 `real-guarded-runner-execution-wiring-missing` 必须保留。

## 错误脱敏

所有读文件、JSON parse、校验失败必须返回固定错误，不回显路径、config 内容、approval identity/reason、URL、sourcePath、token、hash、manifest raw JSON、runner binding raw JSON 或 Node 内部错误。

固定错误：

- config：`supervisor-lifecycle-guarded-runner-execution-gate failed; verify --config points to a readable valid Linke config`
- approval store：`failed to read supervisor lifecycle approval records`
- manifest：`supervisor-lifecycle-guarded-runner-execution-gate failed; verify --manifest points to a readable valid executor manifest JSON`
- runner binding：`supervisor-lifecycle-guarded-runner-execution-gate failed; verify --runner-binding points to a readable valid guarded runner binding JSON`
- validation：`supervisor-lifecycle-guarded-runner-execution-gate failed; execution gate validation did not complete`

## 运行韧性门

正常态定义：

- 命令在有效输入下打印一个 sanitized blocked JSON。
- 未传 `--fail-on-blocked` 时退出码 0。
- 传 `--fail-on-blocked` 且 `state:"blocked"` 时退出码 2。
- 命令不写 store、metadata、audit 或其它本地状态。

恢复锚点：

- 任意错误只返回固定错误并退出码 1，不产生部分写入。
- 失败后再次运行同一命令不需要清理中间状态。

三支柱：

1. 有界失效：参数缺失、布尔参数带值、unsupported write-like flags、config/manifest/binding/store 读取失败全部 fail-closed。
2. 异常恢复：没有写入副作用，恢复方式是修正输入后重跑；`--fail-on-blocked` 只影响退出码，不改变 JSON。
3. 状态侦测：测试断言 exit code、JSON blocker、safety flags、store 不被创建、错误输出无路径或敏感值。

## 非目标

- 不新增 API route。
- 不新增 Web Console 控件。
- 不实现真实 guarded runner。
- 不写 approval record。
- 不把 Gold 标记为 ready。
- 不承诺生产级授权、审计、secret management、watchdog、rollback、uninstall 或 recovery supervisor。

## 完成标准

- `src/agent.js` 新增命令、help 文案、参数校验和脱敏错误常量。
- 新增 `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js` 覆盖 valid inputs、`--execute-requested`、`--fail-on-blocked`、unsupported flags、布尔参数值、config/store/manifest/binding 错误脱敏、help 文案。
- `src/version.js` 更新为 `V1.14`。
- `README.md`、`src/gold-readiness.js`、`test/version.test.js`、`test/gold-readiness.test.js`、`test/readme.test.js` 同步 V1.14 evidence，并保持 Gold blocked。
- 验证命令通过：
  - `node --check src/agent.js`
  - `git diff --check`
  - `node --test --test-reporter=spec test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js`
  - `node --test --test-reporter=spec test/version.test.js test/gold-readiness.test.js test/readme.test.js`
  - `npm test`
