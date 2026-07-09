# V1.15 Supervisor Lifecycle Guarded Runner Execution Gate API Design

## 目标

V1.15 将 V1.14 的只读 Agent CLI gate 推进到只读 API：

```text
POST /api/supervisor-lifecycle-guarded-runner-execution-gate
```

该 endpoint 从 request body 接收 inline `operation`、`config`、`manifest`、`runnerBinding` 和可选 `executeRequested`，并从 server-owned `dataDir` 读取已持久化 approval records，组合 apply readiness、manifest readiness、guarded runner readiness、execution preview 和 V1.13 execution gate，返回 sanitized blocked JSON。

本阶段只提供 API 可见性，不新增 Web Console 控件，不执行 lifecycle apply，不执行 guarded runner，不调用 launchctl/shell，不读取进程列表，不写 metadata/audit/approval，不连接 NAS，不触发备份/恢复或远程命令。

## Route 契约

新增 route：

```text
POST /api/supervisor-lifecycle-guarded-runner-execution-gate
```

该 route 不加入 `API_WRITE_ROUTES`：

- read token 可调用。
- write token 也可调用。
- 缺 token 时按既有 auth 规则返回 401。
- 该 route 不记录 success audit event。

请求体：

```json
{
  "operation": "install",
  "config": {},
  "manifest": {},
  "runnerBinding": {},
  "executeRequested": false
}
```

字段规则：

- `operation` 必须是 `install`、`uninstall`、`rollback`、`recover`。
- `config` 必须通过 `validateConfig`。
- `manifest` 必须能生成 `manifestReady:true`，否则返回固定 validation error。
- `runnerBinding` 可以缺失；缺失时返回 blocked gate，`runnerBindingsReady:false`，`actionCandidates:[]`。
- `executeRequested` 可省略；省略等同 `false`。
- `executeRequested` 如提供，必须是 boolean；`null`、字符串、数字、对象等非 boolean 返回固定错误 `executeRequested must be a boolean when provided`。

明确忽略且不得泄露的输入：

- `approval`
- `dataDir`
- `apply`
- `output`
- `configPath`
- `manifestPath`
- `runnerBindingPath`

## 数据流

Route 内部：

1. `readBody(req)`，沿用 400/413 错误处理。
2. 校验 `operation`。
3. 校验 `executeRequested` 类型。
4. `validateConfig(body?.config)`，失败返回固定 config error。
5. `readSupervisorLifecycleApprovalRecords(dataDir)`，失败返回 `failed to read supervisor lifecycle approval records`。
6. 构建 plan：

```js
buildSupervisorLifecycleApplyPlan(config, {
  operation,
  apply: true,
  envGateEnabled: true,
});
```

7. 构建 apply readiness：

```js
buildSupervisorLifecycleApplyReadiness(lifecyclePlan, approvalRecords);
```

8. 构建 manifest readiness：

```js
validateSupervisorLifecycleExecutorManifest(lifecyclePlan, body?.manifest);
```

`manifestReady !== true` 时返回 fixed validation error。

9. 构建 guarded runner readiness：

```js
buildSupervisorLifecycleGuardedRunnerReadiness(manifestReadiness, body?.runnerBinding);
```

10. 构建 execution preview：

```js
buildSupervisorLifecycleGuardedRunnerExecutionPreview(lifecyclePlan, guardedRunnerReadiness);
```

11. 构建 execution gate：

```js
buildSupervisorLifecycleGuardedRunnerExecutionGate(
  lifecyclePlan,
  applyReadiness,
  manifestReadiness,
  guardedRunnerReadiness,
  executionPreview,
  { executeRequested: body?.executeRequested === true },
);
```

## 输出契约

成功响应 HTTP 200，body 为 V1.13 gate 对象，固定保持：

- `command:'supervisor-lifecycle-guarded-runner-execution-gate'`
- `state:'blocked'`
- `executionGateState:'blocked'`
- `executionEligible:false`
- `executorReady:false`
- `wouldExecute:false`
- `gates.realRunnerWiringReady:false`
- `nextBlockers:['real-guarded-runner-execution-wiring-missing']`
- `safety.readOnly:true`
- `safety.lifecycleApplied:false`
- `safety.filesystemWritten:false`
- `safety.auditEventWritten:false`
- `safety.metadataWritten:false`

未传 `executeRequested:true` 时包含 `execute-request-missing`。传 `executeRequested:true` 时可以移除该 blocker，但必须保留 `real-guarded-runner-execution-wiring-missing`。

`gates.realRunnerWiringReady:false` 来自 `buildSupervisorLifecycleGuardedRunnerExecutionGate(...)` 的 gate 对象，不属于 `safety` 字段。

## 错误脱敏

固定错误：

- invalid operation：`operation must be one of: install, uninstall, rollback, recover`
- invalid executeRequested：`executeRequested must be a boolean when provided`
- config：`supervisor-lifecycle-guarded-runner-execution-gate failed; verify config is a readable valid Linke config`
- approval records：`failed to read supervisor lifecycle approval records`
- validation：`supervisor-lifecycle-guarded-runner-execution-gate failed; execution gate validation did not complete`

响应不得泄露：

- `serverUrl`
- `sourcePath`
- approval identity/reason/acknowledgements
- token、secret、Authorization、Bearer
- `dataDir` 或任意 path-like body 字段
- manifest/runner binding 原始 JSON 中的路径、hash、command-like 字符串
- `sha256:` hash 前缀
- Node 内部错误，例如 `ENOENT`、`ENOTDIR`、`SyntaxError`

## 运行韧性门

正常态定义：

- 有效 body 返回 HTTP 200 + sanitized blocked gate JSON。
- endpoint 不在 `API_WRITE_ROUTES` 中。
- read token 可调用。
- 没有 approval records 时返回 blocked gate，而不是写入或创建 approval storage。

恢复锚点：

- 所有失败都是 fail-closed HTTP 400/401/413，不产生部分写入。
- 修正请求体后可重试。

三支柱：

1. 有界失效：invalid operation、invalid config、approval store read failure、invalid/missing manifest、invalid executeRequested 全部固定错误。
2. 异常恢复：无写入副作用，失败后重发请求即可。
3. 状态侦测：测试断言 status code、auth behavior、write-route exclusion、JSON gate flags、approval storage 不被创建、敏感字段不泄露。

## 非目标

- 不新增 Web Console button 或 view model。
- 不新增真实 runner。
- 不持久化 approval record。
- 不注册写路由。
- 不把 Gold 标记为 ready。
- 不承诺生产级 auth、audit、secret management、watchdog、rollback、uninstall 或 recovery supervisor。

## 完成标准

- `src/server.js` 新增 import、固定错误常量和 route。
- 新增 `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js`。
- `src/version.js` 更新为 `V1.15`。
- `README.md`、`src/gold-readiness.js`、`test/version.test.js`、`test/gold-readiness.test.js`、`test/readme.test.js` 同步 V1.15 evidence，并保持 Gold blocked。
- 验证命令通过：
  - `node --check src/server.js`
  - `git diff --check`
  - `node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js`
  - `node --test --test-reporter=spec test/version.test.js test/gold-readiness.test.js test/readme.test.js`
  - `npm test`
