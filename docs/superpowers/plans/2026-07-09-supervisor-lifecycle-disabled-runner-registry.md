# V1.18 Supervisor Lifecycle Disabled Runner Registry Plan

## 背景

V1.17 给 execution gate 增加了 `runnerWiringContract`，其中第一个 contract 是 `runner-registry`。V1.18 的目标不是把该 contract 置 ready，而是新增一个 code-owned disabled runner registry readiness，让后续真实 runner registry implementation 有稳定数据结构和测试锚点。

## 范围

允许修改：

- `src/supervisor-lifecycle.js`
- `src/web/app.js`
- `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`
- `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js`
- `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js`
- `test/web-console.test.js`
- `src/version.js`
- `README.md`
- `src/gold-readiness.js`
- `test/version.test.js`
- `test/gold-readiness.test.js`
- `test/readme.test.js`

说明：`src/agent.js` 无需修改，Agent CLI 透传 gate JSON。

禁止：

- 不新增 endpoint。
- 不新增 CLI command。
- 不新增 Web button。
- 不修改 request body。
- 不调用 launchctl/shell/process/filesystem/NAS/backup/restore/remote command。
- 不把任何 runner/execution gate 状态改为 ready。

## 步骤

### 1. RED: 纯 registry readiness 测试

在 `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js` 中：

- import `buildSupervisorLifecycleGuardedRunnerRegistryReadiness`。
- 断言输出：
  - `command:'supervisor-lifecycle-guarded-runner-registry-readiness'`
  - `state:'blocked'`
  - `runnerRegistryDefined:true`
  - `runnerRegistryReady:false`
  - `realRunnerImplementationsReady:false`
  - `readyCount:0`
  - `blockedCount:1`
  - `blockers` includes `runner-registry-real-implementation-missing`
  - `blockers` includes `real-guarded-runner-execution-wiring-missing`
  - `nextBlockers:['runner-registry-real-implementation-missing']`
  - safety deepStrictEqual existing execution preview safety fixture.
- `registryEntries` exactly:

```js
[
  {
    runnerKind: 'guarded-runner-stub',
    state: 'blocked',
    realImplementationReady: false,
    supportsHostMutation: false,
    wouldExecute: false,
    wouldRun: false,
    wouldWrite: false,
    blockerCode: 'runner-registry-real-implementation-missing',
  },
]
```

### 2. GREEN: lifecycle 实现

在 `src/supervisor-lifecycle.js`：

- 添加 `RUNNER_REGISTRY_REAL_IMPLEMENTATION_MISSING` 常量。
- 添加 frozen disabled registry entry fixture。
- export `buildSupervisorLifecycleGuardedRunnerRegistryReadiness()`.
- 在 `buildSupervisorLifecycleGuardedRunnerWiringContract(...)` 返回中附加 `runnerRegistryReadiness: buildSupervisorLifecycleGuardedRunnerRegistryReadiness()`。
- 在 execution gate `gates` 中附加 `runnerRegistryReady:false`。
- `runnerRegistryReady:false` 是 `executionEligible` 的必要条件之一，必须硬编码为 false，不得由任何输入驱动。
- 不改变 `runnerWiringContractReady:false`、`realRunnerWiringReady:false`、`executionEligible:false`、`wouldExecute:false`。

### 3. API/CLI 测试

更新 API/CLI gate helper assertions：

- `runnerWiringContract.runnerRegistryReadiness.state === 'blocked'`
- `runnerWiringContract.runnerRegistryReadiness.runnerRegistryReady === false`
- `runnerWiringContract.runnerRegistryReadiness.registryEntries[0].wouldExecute === false`
- `gates.runnerRegistryReady === false`
- 同时断言 `runnerWiringContractReady:false`、`realRunnerWiringReady:false`、`executionEligible:false`、`wouldExecute:false`，并断言 action candidates 和 registry entries 的 `wouldRun:false` / `wouldWrite:false` 未改变。
- 输出不泄露 path/token/secret/hash/approval/command。

### 4. Web 显示

在 `src/web/app.js`：

- 新增 helper 读取 `payload.runnerWiringContract.runnerRegistryReadiness.registryEntries`。
- 输出固定 line：

```text
runnerRegistry:guarded-runner-stub:state:blocked:realImplementationReady:false:wouldExecute:false:blocker:runner-registry-real-implementation-missing
```

- 将该 line 放入现有 `requiredFields`。
- `validationLines` 增加 `runnerRegistryReady:false`。

测试：

- view model/DOM 可见 exact `runnerRegistry:` line。
- 同时可见并可区分 `candidate:`、`wiringContract:`、`runnerRegistry:`。
- 恶意 payload 中的 ready/true/path/token/command 不会改变显示为 blocked/false，也不泄露。
- 恶意 payload 至少包含：
  - `runnerWiringContract.runnerRegistryReadiness.runnerRegistryReady = true`
  - `runnerWiringContract.runnerRegistryReadiness.registryEntries[0].wouldExecute = true`
  - `runnerWiringContract.runnerRegistryReadiness.registryEntries[0].runnerKind = 'node /Users/ah/.ssh/id_rsa token=SECRET_XYZ'`

### 5. Version/README/Gold

- `src/version.js` -> `V1.18`
- README 当前版本/版本表/安全边界/测试覆盖同步。
- `src/gold-readiness.js` evidence 添加：
  - `buildSupervisorLifecycleGuardedRunnerRegistryReadiness`
  - `runnerRegistryReadiness.state:blocked`
  - `runnerRegistryReady:false`
  - `runner-registry-real-implementation-missing`
- Gold 仍 blocked，summary 不变。

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

### 7. 抗辩/闭环

qwen 必查：

- 是否新增真实 execution surface。
- registry readiness 是否仍全部 blocked。
- `runnerRegistryReady:false` 是否全链路保持。
- 是否泄露敏感字段。
- Gold 是否仍 blocked。

DeepSeek 给出 ACCEPT/REJECT 后才能 commit/push。

## 验收标准

- V1.18 只新增 disabled runner registry readiness evidence。
- 不减少 V1.17 wiring contract blocker。
- 不新增真实 runner execution。
- 全量验证和双模型闭环通过。
