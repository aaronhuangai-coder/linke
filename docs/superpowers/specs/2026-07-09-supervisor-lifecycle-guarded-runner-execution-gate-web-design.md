# V1.16 Supervisor Lifecycle Guarded Runner Execution Gate Web Design

## 目标

V1.16 将 V1.15 的只读 API gate 暴露到现有 Web Console 的 Supervisor lifecycle panel：

```text
Guarded Runner Gate Check
POST /api/supervisor-lifecycle-guarded-runner-execution-gate
```

该控件只在用户手动点击时发送 inline `operation`、`config`、`manifest`、`runnerBinding` 和 `executeRequested:true`。点击代表 operator 想检查执行 gate，而不是执行 lifecycle apply。Web 只渲染 sanitized blocked gate，不新增真实 runner，不新增 install/rollback/uninstall/recover 执行动作，不新增 Web execution surface。

## 设计选择

采用“复用现有 lifecycle approval preview panel”的方案：

- 复用现有 operation select、config textarea、executor manifest textarea、guarded runner binding textarea。
- 复用现有 result area、stats、safety note 样式和 shared in-flight 抑制。
- 新增一个按钮 `supervisor-lifecycle-guarded-runner-execution-gate-button`。
- 新增一个 safety note `supervisor-lifecycle-guarded-runner-execution-gate-safety-note`。
- 新增 `buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel(payload, errorMessage)`，输出与 V1.12 execution preview 相同的数据形状，供既有 `renderSupervisorLifecycleApprovalPreview(...)` 使用。

不新增独立 panel、不新增本地路径输入、不读取 approval textarea、不提交 approval JSON。approval records 只由 server-owned `dataDir` 在 API 层读取。

## 用户交互契约

初始加载：

- 不请求 `/api/supervisor-lifecycle-guarded-runner-execution-gate`。
- 初始结果仍由 existing approval persistence preview unknown state 渲染。

点击 `Guarded Runner Gate Check`：

1. 读取当前 operation。
2. 解析 config JSON；空或非法时本地 fail-closed，不发 API。
3. 解析 executor manifest JSON；空或非法时本地 fail-closed，不发 API。
4. 解析 guarded runner binding JSON；空或非法时本地 fail-closed，不发 API。
5. 发送：

```json
{
  "operation": "install",
  "config": {},
  "manifest": {},
  "runnerBinding": {},
  "executeRequested": true
}
```

发送时必须显式白名单构造 request body，禁止用 spread 从 parsed payload、textarea JSON 或未来对象中继承额外字段：

```js
{
  operation: parsed.payload.operation,
  config: parsed.payload.config,
  manifest: parsed.payload.manifest,
  runnerBinding: parsed.payload.runnerBinding,
  executeRequested: true,
}
```

请求体不得包含：

- `approval`
- `dataDir`
- `apply`
- `output`
- `configPath`
- `manifestPath`
- `runnerBindingPath`

## View Model 契约

`buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel(payload, errorMessage = '')` 输出字段兼容 `renderSupervisorLifecycleApprovalPreview(...)`：

- `statusKey`
- `statusText`
- `approvalValidText`
- `persistenceText`
- `runnerBlockers`
- `blockers`
- `nextBlockers`
- `runnerBindingLines`
- `requiredFields`
- `recordLines`
- `validationLines`
- `safetyLines`
- `messageText`

Unknown state：

- `statusKey:'unknown'`
- `statusText:'未检查'`
- `approvalValidText:'executionEligible:false / executorReady:false'`
- `persistenceText:'readOnly:true / wouldExecute:false'`
- `safetyLines` includes `readOnly:true`, `executionEligible:false`, `executorReady:false`, `wouldExecute:false`, `wouldRun:false`, `wouldWrite:false`

Error state：

- `statusKey:'error'`
- fixed fail-closed copy
- sanitized error text using `sanitizeSupervisorLifecycleGuardedRunnerExecutionPreviewField(...)`

Blocked gate state：

- `statusKey:'blocked'`
- `statusText:'执行 gate 阻塞'`
- `approvalValidText` includes:
  - `executionEligible:false`
  - `executorReady:false`
- `persistenceText` includes:
  - `readOnly:true`
  - `executeRequested:true` when response gate reports it
  - `wouldExecute:false`
- `blockers` includes sanitized `blockers` and prefixed `next:<nextBlocker>` entries.
- `requiredFields` contains `actionCandidates` lines sanitized with `sanitizeSupervisorLifecycleGuardedRunnerExecutionPreviewField(...)`:

```text
candidate:<actionId>:impl:<implementationId>:mode:<mode>:runner:<runnerKind>:status:<status>:wouldExecute:false:wouldRun:false:wouldWrite:false
```

- `validationLines` includes:
  - `lifecyclePlanValid:<boolean>`
  - `approvalRecordReady:<boolean>`
  - `manifestReady:<boolean>`
  - `runnerBindingsReady:<boolean>`
  - `executeRequested:<boolean>`
  - `realRunnerWiringReady:false`
  - `executionEligible:false`
  - `executorReady:false`
- `safetyLines` includes API safety flags and forced fail-closed execution flags:
  - `readOnly:true`
  - `lifecycleApplied:false`
  - `filesystemWritten:false`
  - `auditEventWritten:false`
  - `metadataWritten:false`
  - `executionEligible:false`
  - `executorReady:false`
  - `wouldExecute:false`
  - `wouldRun:false`
  - `wouldWrite:false`

The view model must treat any non-error payload state as blocked display, including future unexpected states such as `ready`, `applied`, or `completed`.
It must never trust future payload drift that claims `executionEligible:true`, `executorReady:true`, `wouldExecute:true`, `wouldRun:true`, `wouldWrite:true`, or `realRunnerWiringReady:true`; display remains fail-closed.

## 脱敏与安全边界

The Web response rendering must not display:

- paths, including `/Users/...`
- URLs or hostnames from config
- `serverUrl`, `sourcePath`, dataDir, config path, manifest path, runner binding path
- token, secret, Authorization, Bearer
- approval identity, reason, acknowledgements
- raw `sha256:` hash values
- command-like strings, including shell/node/python/ruby/perl/curl snippets
- raw manifest or runner binding unsafe metadata

The Web code must not call:

- `executeSupervisorLifecycleApply`
- launchctl
- shell
- process list reads
- NAS APIs
- backup/restore APIs
- remote commands
- metadata/audit/approval writes

## HTML Contract

Add to `src/web/index.html` inside `supervisor-lifecycle-approval-preview-controls`:

```html
<button id="supervisor-lifecycle-guarded-runner-execution-gate-button" data-testid="supervisor-lifecycle-guarded-runner-execution-gate-button" type="button">Guarded Runner Gate Check</button>
```

Add a safety note in the same panel:

```html
<div class="supervisor-lifecycle-approval-preview-safety-note" id="supervisor-lifecycle-guarded-runner-execution-gate-safety-note" data-testid="supervisor-lifecycle-guarded-runner-execution-gate-safety-note">
  ...
</div>
```

Button label must include `Gate` or `Check`; it must not be `Execute`, `Execution`, `Run install`, `Start`, `Launch`, `Rollback`, or `Uninstall`.

## 运行韧性门

正常态定义：

- Initial load makes no gate API request.
- Manual click with valid inline JSON calls only `/api/supervisor-lifecycle-guarded-runner-execution-gate`.
- Response renders blocked gate fields and safety flags.
- Shared result in-flight guard prevents duplicate gate requests and prevents gate request while readiness/preview/persist/read records requests are active.

恢复锚点：

- Any parse/API error renders a sanitized fail-closed error in the shared result area.
- Buttons re-enable after request completion.
- User can correct JSON and retry.

三支柱：

1. 有界失效：local JSON validation blocks invalid requests before network; API errors render sanitized text.
2. 异常恢复：no local state is written; correcting pasted JSON and clicking again is enough.
3. 状态侦测：DOM tests assert no init request, exact request body, disabled buttons during in-flight, and sanitized result content.

## 非目标

- 不新增真实 lifecycle apply。
- 不新增真实 guarded runner。
- 不把 V1.16 标记为 Gold ready。
- 不新增 Web 执行按钮。
- 不持久化 approval record。
- 不新增 server route 或修改 V1.15 API semantics。
- 不读取本地文件路径。

## 完成标准

- `src/web/index.html` 新增 gate button 和 safety note。
- `src/web/app.js` 新增 gate view model、DOM reference、fetch handler、in-flight flag、shared disable integration 和 click binding。
- `test/web-console.test.js` 覆盖 no init request、HTML hooks、button label safety、app.js endpoint/view model/binding contract、本地 JSON validation、view model sanitization、manual API request body、duplicate/cross in-flight suppression。
- `src/version.js` 更新为 `V1.16`。
- `README.md`、`src/gold-readiness.js`、`test/version.test.js`、`test/gold-readiness.test.js`、`test/readme.test.js` 同步 V1.16 evidence，并保持 Gold blocked。
- 验证命令通过：
  - `node --check src/web/app.js`
  - `git diff --check`
  - `node --test --test-reporter=spec test/web-console.test.js`
  - `node --test --test-reporter=spec test/version.test.js test/gold-readiness.test.js test/readme.test.js`
  - `npm test`
