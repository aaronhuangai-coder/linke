# V1.17 Supervisor Lifecycle Guarded Runner Wiring Contract Plan

## 背景

V1.16 已把 execution gate 暴露到 Web，但 gate 仍只给出 `real-guarded-runner-execution-wiring-missing`。V1.17 的任务是把该 blocker 拆成结构化、只读、可测试的 runner wiring contract readiness，帮助后续逐项实现真实 runner，而不在本阶段接入真实执行。

## 范围

允许修改：

- `src/supervisor-lifecycle.js`
- `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`
- `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js`
- `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js`
- `src/web/app.js`
- `test/web-console.test.js`
- `src/version.js`
- `README.md`
- `src/gold-readiness.js`
- `test/version.test.js`
- `test/gold-readiness.test.js`
- `test/readme.test.js`

说明：`src/agent.js` 无需修改；现有 Agent CLI 会透传 execution gate JSON，`runnerWiringContract` 会随 gate 输出自动出现在 CLI 结果中。

禁止修改：

- 不新增 server route。
- 不新增 CLI command。
- 不新增 Web button。
- 不修改 auth/write-route 语义。
- 不引入 shell/launchctl/process/filesystem/NAS/backup/restore/remote command 调用。

## 实施步骤

### 1. RED: 纯函数与 gate contract 测试

在 `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js` 中先添加失败测试：

- import `buildSupervisorLifecycleGuardedRunnerWiringContract`。
- 断言纯函数输出：
  - `command:'supervisor-lifecycle-guarded-runner-wiring-contract'`
  - `state:'blocked'`
  - `realRunnerWiringReady:false`
  - `readyCount:0`
  - `blockedCount === requiredContracts.length`
  - 每个 contract `status:'blocked'`
  - 每个 contract `requiredForExecution:true`
  - `nextBlockers` 包含 `real-guarded-runner-execution-wiring-missing`
  - safety 全 false/no-write/no-execute。
- 断言 `buildSupervisorLifecycleGuardedRunnerExecutionGate(..., { executeRequested:true })` 包含 `runnerWiringContract`，且 top-level 仍 `executionEligible:false` / `wouldExecute:false`。
- 断言 gate 的 `gates.runnerWiringContractReady === false`。
- 断言 `buildSupervisorLifecycleGuardedRunnerWiringContract(null)`、`buildSupervisorLifecycleGuardedRunnerWiringContract(undefined)`、正常 execution preview、带 `wouldExecute:true` 的恶意对象、带路径/token/secret/command 的恶意对象，输出完全相同。
- 断言恶意输入的敏感字段不会出现在 contract JSON 中。
- deepStrictEqual 断言 `runnerWiringContract.safety` 完整字段枚举，与 spec 中的 `executionPreviewSafety()` 字段一致。

### 2. GREEN: lifecycle 纯函数实现

在 `src/supervisor-lifecycle.js` 中：

- 添加固定 contract fixture 或 builder。
- export `buildSupervisorLifecycleGuardedRunnerWiringContract(executionPreview)`.
- `buildSupervisorLifecycleGuardedRunnerWiringContract` 必须忽略 `executionPreview` 的全部内容，不解构、不读取、不遍历该参数；参数只用于保持 gate 调用签名语义一致。
- required contracts 必须 exactly 5 个，顺序固定：`runner-registry`、`host-mutation-adapter`、`rollback-anchor`、`attempt-audit`、`operator-recovery`。
- safety 必须复用 `executionPreviewSafety()` 的完整字段结构。
- 在 `buildSupervisorLifecycleGuardedRunnerExecutionGate(...)` 中附加：
  - `runnerWiringContract`
  - `gates.runnerWiringContractReady:false`
- 不修改 `executeSupervisorLifecycleApply`。
- 不新增任何真实 execution 分支。

### 3. API/CLI 覆盖

更新 API/CLI tests：

- API route 输出包含 `runnerWiringContract.state:'blocked'`。
- API route 输出包含 `gates.runnerWiringContractReady:false`。
- API 输出不泄露 path/token/secret/hostname/hash/approval/command。
- CLI 输出包含 `runnerWiringContract`。
- `--fail-on-blocked` 仍 exit 2。

### 4. Web 显示覆盖

在 `src/web/app.js` 的 gate view model 中渲染 contract lines 到现有 `requiredFields` 或 `validationLines`。

推荐格式：

```text
wiringContract:<id>:status:blocked:requiredForExecution:true:blocker:<blockerCode>
```

测试：

- View model/DOM 能看到 `runner-registry` 和 `runner-registry-missing`。
- View model/DOM 同时存在 `candidate:` 和 `wiringContract:` lines 时，二者可区分。
- 断言 Web line 完全匹配 `wiringContract:runner-registry:status:blocked:requiredForExecution:true:blocker:runner-registry-missing`。
- payload 漂移时依然不显示路径、token、secret、hostname、hash、approval identity/reason/acknowledgement 或 command。
- 不新增初始请求、不新增按钮。

### 5. Version/README/Gold

更新：

- `src/version.js` -> `V1.17`
- README 当前版本、版本表、V1.17 描述、测试覆盖和 Gold 边界。
- `src/gold-readiness.js` automation-installation evidence 添加：
  - `buildSupervisorLifecycleGuardedRunnerWiringContract`
  - `runnerWiringContract.state:blocked`
  - `runnerWiringContract.requiredContracts`
  - `runnerWiringContractReady:false`
- Tests 同步。

### 6. 验证

PM 必跑：

```bash
node --check src/supervisor-lifecycle.js
node --check src/web/app.js
git diff --check
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js test/web-console.test.js
node --test --test-reporter=spec test/version.test.js test/gold-readiness.test.js test/readme.test.js
npm test
```

### 7. 抗辩与闭环

qwen 只读 review 必查：

- 是否新增真实执行。
- 是否改变 API/CLI/Web 为执行面。
- `runnerWiringContract` 是否全部 blocked。
- 是否有路径/secret/token/command 泄露。
- Version/README/Gold 是否同步且 Gold blocked。

DeepSeek 闭环验收必须给出 `ACCEPT/REJECT`。

## 验收标准

- `runnerWiringContract` 只是 read-only blocked evidence。
- Ready inputs + approval record + manifest + runner binding + `executeRequested:true` 仍不能执行。
- `realRunnerWiringReady:false` 和 `real-guarded-runner-execution-wiring-missing` 仍是最终 blocker。
- 全量测试通过后 commit/push。
