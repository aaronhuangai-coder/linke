# V1.13 Supervisor Lifecycle Guarded Runner Execution Gate Plan

## 背景

V1.12 已经把 guarded runner execution preview 暴露到 Web Console，并保持只读、fail-closed、无真实执行。Gold 仍被 `real-guarded-runner-execution-wiring-missing` 阻塞。V1.13 的任务是把“真实执行之前的资格门禁”做成独立纯函数，为后续 CLI/API/Web 或真实 runner 设计提供可测试边界。

## Step 1: TDD 测试

新增 `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`。

覆盖用例：

1. valid plan + ready applyReadiness + ready manifestReadiness + ready guardedRunnerReadiness + executionPreview + `executeRequested:false`：
   - `state:'blocked'`
   - `executionEligible:false`
   - `wouldExecute:false`
   - blockers 包含 `execute-request-missing` 和 `real-guarded-runner-execution-wiring-missing`
   - `actionCandidates` 保持 fixed `wouldExecute:false/wouldRun:false/wouldWrite:false`

2. 相同输入但 `executeRequested:true`：
   - 不包含 `execute-request-missing`
   - 仍包含 `real-guarded-runner-execution-wiring-missing`
   - `realRunnerWiringReady:false`
   - 仍不执行

3. approval record 未 ready：
   - blocker `approval-record-gate-not-ready`
   - 不透传 approval identity/reason/hash/path/URL/token。

4. manifest、runner readiness、execution preview 缺失或 operation mismatch：
   - 使用稳定 blocker
   - 不抛异常

5. action preview 带 unsafe metadata：
   - `actionCandidates` 脱敏
   - 输出不包含 `/Users/ah`、`localhost`、`token`、`secret`、`launchctl`、`curl`、`sk-abc`、`ghp_ab`、`xoxb-abc` 等。

## Step 2: 实现纯函数

在 `src/supervisor-lifecycle.js`：

- 增加 shape 校验 helper：
  - `isApplyReadinessShape`
  - `isExecutorManifestReadinessShape`
  - `isGuardedRunnerExecutionPreviewShape`
- 增加 `buildGuardedRunnerExecutionGateActionCandidates(plan, executionPreview)`。
- 导出 `buildSupervisorLifecycleGuardedRunnerExecutionGate(...)`。
- 复用已有 `hasExpectedLifecycleActions`、`sanitizeExecutionPreviewMetadata`、`sanitizeExecutionPreviewMaxAttempts`、`executionPreviewSafety`。
- 不新增文件写入、网络、process、launchctl、NAS 或 CLI/API/Web 代码。

## Step 3: 版本与文档

更新：

- `src/version.js`: `V1.13`
- `src/gold-readiness.js`:
  - automation-installation evidence 增加：
    - `buildSupervisorLifecycleGuardedRunnerExecutionGate`
    - `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`
    - `supervisor-lifecycle-guarded-runner-execution-gate`
    - `executionEligible:false`
    - `execute-request-missing`
    - `realRunnerWiringReady:false`
  - production-hardening evidence 同步。
  - nextStep 说明 V1.13 为 pure execution gate，Gold 仍 blocked。
- `README.md`:
  - 标题和当前版本更新为 V1.13。
  - 版本表新增 V1.13 当前版本，V1.12 改历史版本。
  - Gold/feature section 增加 V1.13 说明。

同步测试：

- `test/version.test.js`
- `test/gold-readiness.test.js`
- `test/readme.test.js`

## Step 4: 验证

最小命令：

```bash
node --check src/supervisor-lifecycle.js
git diff --check
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
node --test --test-reporter=spec test/version.test.js test/gold-readiness.test.js test/readme.test.js
npm test
```

## Step 5: Review/Closure

- Qwen 做设计和代码抗辩，要求返回结构化结论。
- DeepSeek 做最终闭环验收。
- PM 独立复核测试输出。
- commit/push 后继续下一阶段。
