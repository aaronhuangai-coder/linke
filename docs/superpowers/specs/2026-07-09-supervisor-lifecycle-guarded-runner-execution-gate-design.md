# V1.13 Supervisor Lifecycle Guarded Runner Execution Gate Design

## 目标

V1.13 在 `src/supervisor-lifecycle.js` 增加纯函数级 `buildSupervisorLifecycleGuardedRunnerExecutionGate(...)`，把 V1.12 的 execution preview 之后、真实 guarded runner 执行之前的资格门禁显式化。

本阶段仍不执行任何 host 操作，不新增 CLI/API/Web 控制面，不调用 `executeSupervisorLifecycleApply`、launchctl、文件系统写入、进程列表读取、NAS、备份/恢复或远程命令。

## 范围

新增纯函数：

```js
buildSupervisorLifecycleGuardedRunnerExecutionGate(
  plan,
  applyReadiness,
  manifestReadiness,
  guardedRunnerReadiness,
  executionPreview,
  options = {},
)
```

输入均为已有纯函数输出或内存对象：

- `plan`: `buildSupervisorLifecycleApplyPlan(...)` 输出。
- `applyReadiness`: `buildSupervisorLifecycleApplyReadiness(...)` 输出。
- `manifestReadiness`: `validateSupervisorLifecycleExecutorManifest(...)` 输出。
- `guardedRunnerReadiness`: `buildSupervisorLifecycleGuardedRunnerReadiness(...)` 输出。
- `executionPreview`: `buildSupervisorLifecycleGuardedRunnerExecutionPreview(...)` 输出。
- `options.executeRequested`: 仅记录用户是否显式请求进入后续执行门禁，不能触发执行。

## 输出契约

返回对象固定为 blocked/read-only：

```js
{
  command: 'supervisor-lifecycle-guarded-runner-execution-gate',
  operation,
  state: 'blocked',
  executionGateState: 'blocked',
  executionEligible: false,
  executorReady: false,
  wouldExecute: false,
  blockers,
  nextBlockers: ['real-guarded-runner-execution-wiring-missing'],
  actionCandidates,
  gates: {
    lifecyclePlanValid,
    approvalRecordReady,
    manifestReady,
    runnerBindingsReady,
    executionPreviewVerified,
    executeRequested,
    realRunnerWiringReady: false,
  },
  safety,
}
```

`safety` 必须固定为：

- `readOnly:true`
- `dryRun:true`
- `hostMutation:false`
- `launchctlCalled:false`
- `processListRead:false`
- `filesystemWritten:false`
- `metadataWritten:false`
- `rollbackAnchorWritten:false`
- `auditEventWritten:false`
- `approvalPersisted:false`
- `lifecycleApplied:false`
- `nasConnected:false`
- `backupTriggered:false`
- `restoreTriggered:false`
- `remoteCommandExecuted:false`
- `sensitiveValuesReturned:false`

## blocker 规则

只允许输出稳定 blocker，不透传外部任意字符串。

稳定 blocker：

- `invalid-lifecycle-plan`
- `lifecycle-plan-action-mismatch`
- `apply-readiness-invalid`
- `approval-record-gate-not-ready`
- `executor-manifest-readiness-invalid`
- `executor-manifest-not-ready`
- `guarded-runner-readiness-invalid`
- `guarded-runner-readiness-not-ready`
- `execution-preview-invalid`
- `execution-preview-operation-mismatch`
- `execution-preview-not-verified`
- `execute-request-missing`
- `real-guarded-runner-execution-wiring-missing`

当 `options.executeRequested !== true` 时必须包含 `execute-request-missing`。

即使所有前置门禁就绪且 `executeRequested:true`，也必须包含 `real-guarded-runner-execution-wiring-missing`，并保持 `executionEligible:false` / `wouldExecute:false`。

## actionCandidates

`actionCandidates` 只从已验证的 plan 和 execution preview 派生，且只允许显示：

- `actionId`
- `implementationId`
- `runnerKind`
- `mode`
- `status:'blocked'`
- `wouldExecute:false`
- `wouldRun:false`
- `wouldWrite:false`
- `maxAttempts`

所有字符串必须复用 execution preview 的脱敏策略，避免路径、URL、token、secret、Authorization、hash、hostname、username、process id、command、高熵值和短 token 前缀泄露。

## 非目标

- 不新增 Agent CLI。
- 不新增 API route。
- 不新增 Web Console 控件。
- 不读取 approval store 或本地路径。
- 不写文件、不写审计、不写 metadata。
- 不执行任何 real runner、launchctl、shell、NAS、备份或恢复。
- 不把 Gold 标记为 ready。

## 完成标准

- 新增纯函数测试覆盖 ready inputs 仍 blocked、executeRequested gate、invalid/mismatch inputs、敏感字段脱敏。
- `src/version.js` 更新为 `V1.13`。
- `src/gold-readiness.js` 和 README 增加 V1.13 evidence，Gold 仍 blocked。
- `test/version.test.js`、`test/gold-readiness.test.js`、`test/readme.test.js` 同步。
- `node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js` 通过。
- `npm test` 通过。
