# Supervisor Lifecycle Guarded Runner Execution Preview Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add V1.12 Web Console access to the guarded runner execution preview API while keeping real lifecycle execution blocked.

**Architecture:** The existing supervisor lifecycle approval preview panel gains one manual button and one safety note. `src/web/app.js` reuses the current inline config/manifest/runnerBinding parser, posts to the V1.11 read-only API, and renders a sanitized blocked execution preview through the existing approval preview result renderer.

**Tech Stack:** Node.js ESM, browser DOM code, `node:test`, existing Linke Web Console test harness.

## Global Constraints

- `LINKE_RELEASE_VERSION` must become `V1.12`.
- Web button test id must be `supervisor-lifecycle-guarded-runner-execution-preview-button`.
- Web safety note test id must be `supervisor-lifecycle-guarded-runner-execution-preview-safety-note`.
- API path must be `POST /api/supervisor-lifecycle-guarded-runner-execution-preview`.
- Web initialization must not call the execution preview API.
- Execution preview must not start while another supervisor lifecycle panel request that renders the shared lifecycle result area is in flight.
- Execution preview must disable other supervisor lifecycle panel buttons while its request is in flight.
- Web request body must contain only inline `operation`, `config`, `manifest`, and `runnerBinding`.
- Web must not read or submit approval textarea content.
- Web must not submit `approval`, `dataDir`, `apply`, `output`, `configPath`, `manifestPath`, or `runnerBindingPath`.
- Web must not add server API or Agent CLI behavior.
- Web must not call `executeSupervisorLifecycleApply`.
- Web must not call launchctl.
- Web must not write files.
- Web must not read process lists.
- Web must not read or mutate approval storage.
- Web must not connect to NAS targets.
- Web must not trigger backup or restore.
- Web must not execute remote commands.
- Rendered text must not expose paths, URLs, token-like values, secrets, Authorization header values, hashes, hostnames, usernames, process ids, or runnable commands.
- Execution preview action rendering must ignore unknown `actionPreviews` fields and only render allowlisted fields.
- Long base64-like token values in allowlisted execution preview fields must be redacted.
- Short token prefixes such as `sk-`, GitHub `ghp_` / `ghs_`, and Slack `xox...` values must be redacted.
- Command-like interpreter names such as `python`, `python3`, `ruby`, `perl`, `php`, `powershell`, and `pwsh` must be redacted.
- Gold readiness remains blocked.

---

## File Structure

- Modify `src/web/index.html`: add the execution preview button and safety note next to guarded runner readiness controls.
- Modify `src/web/app.js`: add DOM references, view model, sanitized action preview rendering, local validation handler, API call, in-flight guard, listener binding, and loading/error copy.
- Modify `test/web-console.test.js`: add DOM tests for no startup request, local validation, request payload, sanitized rendering, and duplicate suppression.
- Modify `src/version.js`: bump to V1.12.
- Modify `src/gold-readiness.js`: add V1.12 Web evidence while Gold remains blocked.
- Modify `README.md`: mark V1.12 current and move V1.11 to historical.
- Modify `test/version.test.js`, `test/gold-readiness.test.js`, and `test/readme.test.js`: update release and documentation assertions.

## Task 1: Web Console Execution Preview Control

**Files:**
- Modify: `src/web/index.html`
- Modify: `src/web/app.js`
- Modify: `test/web-console.test.js`

**Interfaces:**
- Consumes: existing operation/config/manifest/runnerBinding DOM inputs.
- Consumes: existing `parseSupervisorLifecycleGuardedRunnerReadinessPayload()` payload shape.
- Produces: `buildSupervisorLifecycleGuardedRunnerExecutionPreviewViewModel(payload, errorMessage = '')`.
- Produces: manual POST `/api/supervisor-lifecycle-guarded-runner-execution-preview`.

- [ ] **Step 1: Add failing DOM tests**

Add tests near the existing guarded runner readiness tests in `test/web-console.test.js`.

The no-startup test must initialize the console and assert:

```js
assert.strictEqual(fetchCount, 0, 'should not call guarded runner execution preview API on init');
```

The local validation test must click `supervisor-lifecycle-guarded-runner-execution-preview-button` and assert no call to `/api/supervisor-lifecycle-guarded-runner-execution-preview` for these cases:

```js
// config empty -> /配置 JSON 不能为空/
// config invalid -> /配置 JSON 格式错误/
// manifest empty -> /执行器 Manifest JSON 不能为空/
// manifest invalid -> /执行器 Manifest JSON 格式错误/
// runner binding empty -> /Runner Binding JSON 不能为空/
// runner binding invalid -> /Runner Binding JSON 格式错误/
```

The manual request test must set valid config, approval, manifest, and runner binding textareas, click the execution preview button, and assert:

```js
const apiCall = calls.find((call) => String(call.url) === '/api/supervisor-lifecycle-guarded-runner-execution-preview');
assert.ok(apiCall, 'must call guarded runner execution preview API');
assert.strictEqual(apiCall.options.method, 'POST');
const requestBody = JSON.parse(apiCall.options.body);
assert.strictEqual(requestBody.operation, 'install');
assert.strictEqual(requestBody.config.deviceId, 'web-lifecycle-guarded-runner-execution-preview');
assert.strictEqual(requestBody.manifest.kind, 'supervisor-lifecycle-executor-manifest');
assert.strictEqual(requestBody.runnerBinding.kind, 'supervisor-lifecycle-guarded-runner-binding');
assert.ok(requestBody.approval === undefined, 'must not submit approval JSON');
assert.ok(requestBody.dataDir === undefined, 'must not submit dataDir');
assert.ok(requestBody.apply === undefined, 'must not submit apply flag');
assert.ok(requestBody.output === undefined, 'must not submit output path');
assert.ok(requestBody.configPath === undefined, 'must not submit config path');
assert.ok(requestBody.manifestPath === undefined, 'must not submit manifest path');
assert.ok(requestBody.runnerBindingPath === undefined, 'must not submit runner binding path');
```

Mock the API response with:

```js
{
  command: 'supervisor-lifecycle-guarded-runner-execution-preview',
  operation: 'install',
  state: 'blocked',
  executionReady: false,
  executorReady: false,
  wouldExecute: false,
  runnerBindingsReady: true,
  blockers: ['guarded-runner-execution-preview-only'],
  nextBlockers: ['real-guarded-runner-execution-wiring-missing'],
  actionPreviews: [
    {
      actionId: 'render-launch-agent-plist',
      implementationId: 'QWxhZGRpbjpvcGVuIHNlc2FtZQ==',
      mode: 'curl http://unsafe.example password=super-secret',
      runnerKind: 'node /Users/ah/.ssh/id_rsa token=SECRET_XYZ',
      status: 'blocked',
      wouldExecute: false,
      wouldRun: false,
      wouldWrite: false,
      command: 'command=/bin/sh',
    },
  ],
  gates: {
    lifecyclePlanValid: true,
    runnerBindingsReady: true,
    executionPreviewOnly: true,
    executorReady: false,
  },
  safety: {
    readOnly: true,
    dryRun: true,
    hostMutation: false,
    launchctlCalled: false,
    processListRead: false,
    filesystemWritten: false,
    lifecycleApplied: false,
    sensitiveValuesReturned: false,
    nasConnected: false,
    backupTriggered: false,
    restoreTriggered: false,
    remoteCommandExecuted: false,
  },
}
```

Assert rendered stats:

```js
assert.strictEqual(doc.getElementById('supervisor-lifecycle-approval-preview-status').textContent, '执行预览阻塞');
assert.strictEqual(doc.getElementById('supervisor-lifecycle-approval-preview-valid').textContent, 'executionReady:false / executorReady:false');
assert.strictEqual(doc.getElementById('supervisor-lifecycle-approval-preview-persist').textContent, 'readOnly:true / wouldExecute:false');
```

Assert rendered text contains:

```js
/guarded-runner-execution-preview-only/
/real-guarded-runner-execution-wiring-missing/
/wouldExecute:false/
/wouldRun:false/
/wouldWrite:false/
/executionPreviewOnly:true/
/executorReady:false/
/readOnly:true/
```

Assert rendered text does not contain:

```js
'/Users/ah'
'SECRET_XYZ'
'unsafe.example'
'super-secret'
'operator@example.invalid'
/\bnode\b/i
/\bcurl\b/i
```

The in-flight test must click the execution preview button twice before resolving fetch and assert:

```js
assert.strictEqual(fetchCount, 1, 'in-flight guard must block duplicate guarded runner execution preview requests');
```

The cross-button shared-result test must start a guarded runner readiness request, leave it unresolved, click the execution preview button, and assert:

```js
assert.strictEqual(executionFetchCount, 0, 'execution preview must not start while guarded runner readiness is in flight');
```

The sanitizer assertions must also include:

```js
assert.ok(!resultText.includes('QWxhZGRpbjpvcGVuIHNlc2FtZQ=='), 'must not expose base64-like secrets');
assert.ok(!resultText.includes('command=/bin/sh'), 'must not expose command fields');
assert.ok(!resultText.includes('sk-abc123def456'), 'must not expose short sk-prefixed token values');
assert.ok(!resultText.includes('ghp_abc123def456'), 'must not expose short ghp-prefixed token values');
assert.ok(!resultText.includes('ghs_abc123def456'), 'must not expose short ghs-prefixed token values');
assert.doesNotMatch(resultText, /\bpython3\b/i, 'must not expose python3 command-like runner metadata');
assert.doesNotMatch(resultText, /\bruby\b/i, 'must not expose ruby command-like runner metadata');
assert.doesNotMatch(resultText, /\bperl\b/i, 'must not expose perl command-like runner metadata');
```

- [ ] **Step 2: Run the targeted Web Console test to verify RED**

Run:

```bash
node --test --test-reporter=spec test/web-console.test.js
```

Expected before implementation: FAIL because the button, handler, and view model do not exist.

- [ ] **Step 3: Add HTML controls**

In `src/web/index.html`, add this button after `supervisor-lifecycle-guarded-runner-readiness-button`:

```html
<button id="supervisor-lifecycle-guarded-runner-execution-preview-button" data-testid="supervisor-lifecycle-guarded-runner-execution-preview-button" type="button">Guarded Runner Execution Preview</button>
```

Add this safety note after `supervisor-lifecycle-guarded-runner-readiness-safety-note`:

```html
<div class="supervisor-lifecycle-approval-preview-safety-note" id="supervisor-lifecycle-guarded-runner-execution-preview-safety-note" data-testid="supervisor-lifecycle-guarded-runner-execution-preview-safety-note">
  <p>Guarded Runner Execution Preview 仅由用户点击后手动 POST /api/supervisor-lifecycle-guarded-runner-execution-preview，并且请求体只包含 inline operation、config、manifest 与 runnerBinding；不读取 approval textarea、不提交 approval JSON、不读取 approval store、不读取本地 path、不写文件、不执行 lifecycle apply、不调用 launchctl、不安装、不卸载、不回滚、不启动 recovery supervisor、不读取进程列表、不连接 NAS、不触发备份或恢复、不执行远程命令；仅展示 executionReady:false、executorReady:false、wouldExecute:false、actionPreviews wouldRun:false/wouldWrite:false、blockers、nextBlockers 与 safety flags，不显示路径、URL、token、Authorization header、secret、hash、hostname、username、process id 或 command；Gold 仍 blocked。</p>
</div>
```

- [ ] **Step 4: Add the execution preview view model and handler**

In `src/web/app.js`, reuse the existing guarded runner readiness sanitizer. Add:

```js
function buildSupervisorLifecycleGuardedRunnerExecutionSafetyLines(safety) {
  const source = safety && typeof safety === 'object' ? safety : {};
  return [
    ...SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_READINESS_SAFETY_KEYS.map((key) => `${key}:${source[key] === true ? 'true' : 'false'}`),
    'executionReady:false',
    'executorReady:false',
    'wouldExecute:false',
    'wouldRun:false',
    'wouldWrite:false',
  ];
}
```

Add an execution-preview-specific sanitizer wrapper:

```js
function sanitizeSupervisorLifecycleGuardedRunnerExecutionPreviewField(value, key = '') {
  const sanitized = sanitizeSupervisorLifecycleGuardedRunnerReadinessValue(value, key);
  const redactedHighEntropy = sanitized.replace(/\b[A-Za-z0-9+/]{24,}={0,2}\b/g, '[redacted-secret]');
  return redactedHighEntropy.includes('[redacted') ? '[redacted]' : redactedHighEntropy;
}
```

Add exported view model:

```js
export function buildSupervisorLifecycleGuardedRunnerExecutionPreviewViewModel(payload, errorMessage = '') {
  if (errorMessage) {
    return {
      statusKey: 'error',
      statusText: '检查失败',
      approvalValidText: '—',
      persistenceText: '—',
      blockers: [],
      requiredFields: [],
      recordLines: [],
      validationLines: [],
      safetyLines: [],
      messageText: 'Guarded runner execution preview 检查失败: ' + sanitizeSupervisorLifecycleGuardedRunnerExecutionPreviewField(errorMessage),
    };
  }

  if (!payload || typeof payload !== 'object') {
    return {
      statusKey: 'unknown',
      statusText: '未检查',
      approvalValidText: 'executionReady:false / executorReady:false',
      persistenceText: 'readOnly:true / wouldExecute:false',
      blockers: [],
      requiredFields: [],
      recordLines: [],
      validationLines: [],
      safetyLines: ['readOnly:true', 'executionReady:false', 'executorReady:false', 'wouldExecute:false', 'wouldRun:false', 'wouldWrite:false'],
      messageText: '点击手动 POST /api/supervisor-lifecycle-guarded-runner-execution-preview 获取 guarded runner execution preview',
    };
  }

  const actionPreviews = Array.isArray(payload.actionPreviews) ? payload.actionPreviews : [];
  const actionLines = actionPreviews.map((action) => {
    const source = action && typeof action === 'object' ? action : {};
    const actionId = sanitizeSupervisorLifecycleGuardedRunnerExecutionPreviewField(source.actionId, 'actionId') || 'unknown';
    const implementationId = sanitizeSupervisorLifecycleGuardedRunnerExecutionPreviewField(source.implementationId, 'implementationId') || 'unknown';
    const mode = sanitizeSupervisorLifecycleGuardedRunnerExecutionPreviewField(source.mode, 'mode') || 'unknown';
    const runnerKind = sanitizeSupervisorLifecycleGuardedRunnerExecutionPreviewField(source.runnerKind, 'runnerKind') || 'unknown';
    return `action:${actionId}:impl:${implementationId}:mode:${mode}:runner:${runnerKind}:wouldExecute:${source.wouldExecute === true ? 'true' : 'false'}:wouldRun:${source.wouldRun === true ? 'true' : 'false'}:wouldWrite:${source.wouldWrite === true ? 'true' : 'false'}`;
  });
  const gates = payload.gates && typeof payload.gates === 'object' ? payload.gates : {};

  return {
    statusKey: 'blocked',
    statusText: '执行预览阻塞',
    approvalValidText: 'executionReady:false / executorReady:false',
    persistenceText: 'readOnly:true / wouldExecute:false',
    blockers: [
      ...sanitizeSupervisorLifecycleGuardedRunnerReadinessList(payload.blockers),
      ...sanitizeSupervisorLifecycleGuardedRunnerReadinessList(payload.nextBlockers).map((blocker) => `next:${blocker}`),
    ],
    requiredFields: actionLines,
    recordLines: [],
    validationLines: [
      `lifecyclePlanValid:${gates.lifecyclePlanValid === true ? 'true' : 'false'}`,
      `runnerBindingsReady:${gates.runnerBindingsReady === true ? 'true' : 'false'}`,
      `executionPreviewOnly:${gates.executionPreviewOnly === true ? 'true' : 'false'}`,
      'executorReady:false',
    ],
    safetyLines: buildSupervisorLifecycleGuardedRunnerExecutionSafetyLines(payload.safety),
    messageText: 'Guarded runner execution preview completed; execution remains fail-closed.',
  };
}
```

Add DOM reference:

```js
const supervisorLifecycleGuardedRunnerExecutionPreviewButton = doc.getElementById('supervisor-lifecycle-guarded-runner-execution-preview-button');
```

Add in-flight state:

```js
let supervisorLifecycleGuardedRunnerExecutionPreviewInFlight = false;
```

When adding the handler, guard against already-running shared result-area requests:

```js
function hasSupervisorLifecycleSharedResultRequestInFlight() {
  return (
    supervisorLifecycleApprovalPreviewInFlight ||
    supervisorLifecycleApprovalPersistInFlight ||
    supervisorLifecycleApprovalRecordsInFlight ||
    supervisorLifecycleApplyReadinessInFlight ||
    supervisorLifecycleExecutorReadinessInFlight ||
    supervisorLifecycleExecutorManifestReadinessInFlight ||
    supervisorLifecycleGuardedRunnerReadinessInFlight ||
    supervisorLifecycleGuardedRunnerExecutionPreviewInFlight
  );
}

function setSupervisorLifecycleSharedResultButtonsDisabled(disabled) {
  [
    supervisorLifecycleApprovalPreviewRunButton,
    supervisorLifecycleApprovalPersistButton,
    supervisorLifecycleApprovalRecordsButton,
    supervisorLifecycleApplyReadinessButton,
    supervisorLifecycleExecutorReadinessButton,
    supervisorLifecycleExecutorManifestReadinessButton,
    supervisorLifecycleGuardedRunnerReadinessButton,
    supervisorLifecycleGuardedRunnerExecutionPreviewButton,
  ].forEach((button) => {
    if (button) button.disabled = disabled;
  });
}
```

Add handler:

```js
async function fetchSupervisorLifecycleGuardedRunnerExecutionPreview() {
  if (!supervisorLifecycleApprovalPreviewResultEl || hasSupervisorLifecycleSharedResultRequestInFlight()) return;
  const parsed = parseSupervisorLifecycleGuardedRunnerReadinessPayload();
  if (!parsed.ok) {
    renderSupervisorLifecycleApprovalPreview(buildSupervisorLifecycleGuardedRunnerExecutionPreviewViewModel(null, parsed.error));
    return;
  }
  supervisorLifecycleGuardedRunnerExecutionPreviewInFlight = true;
  setSupervisorLifecycleSharedResultButtonsDisabled(true);
  clearElement(supervisorLifecycleApprovalPreviewResultEl);
  const loading = doc.createElement('p');
  loading.className = 'placeholder';
  loading.textContent = '生成 guarded runner execution preview 中...';
  supervisorLifecycleApprovalPreviewResultEl.appendChild(loading);
  try {
    const res = await apiFetch('/api/supervisor-lifecycle-guarded-runner-execution-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed.payload),
    });
    let body;
    try {
      body = await res.json();
    } catch (_) {
      body = {};
    }
    if (!res.ok) {
      throw new Error(body.error || 'HTTP ' + res.status);
    }
    renderSupervisorLifecycleApprovalPreview(buildSupervisorLifecycleGuardedRunnerExecutionPreviewViewModel(body));
    logEvent('Supervisor lifecycle guarded runner execution preview completed', 'warning');
  } catch (err) {
    renderSupervisorLifecycleApprovalPreview(buildSupervisorLifecycleGuardedRunnerExecutionPreviewViewModel(null, err.message));
    logEvent('Supervisor lifecycle guarded runner execution preview failed: ' + sanitizeSupervisorLifecycleGuardedRunnerExecutionPreviewField(err.message), 'error');
  } finally {
    supervisorLifecycleGuardedRunnerExecutionPreviewInFlight = false;
    setSupervisorLifecycleSharedResultButtonsDisabled(false);
  }
}
```

Add listener:

```js
if (supervisorLifecycleGuardedRunnerExecutionPreviewButton?.addEventListener) {
  supervisorLifecycleGuardedRunnerExecutionPreviewButton.addEventListener('click', fetchSupervisorLifecycleGuardedRunnerExecutionPreview);
}
```

- [ ] **Step 5: Run targeted tests to verify GREEN**

Run:

```bash
node --check src/web/app.js
node --test --test-reporter=spec test/web-console.test.js
```

Expected: both exit 0.

## Task 2: Release Docs And Gold Evidence

**Files:**
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `README.md`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**
- Produces: release version `V1.12`.
- Produces: README current row for V1.12 and historical row for V1.11.
- Produces: Gold readiness evidence for Web execution preview while Gold remains blocked.

- [ ] **Step 1: Add failing release/documentation assertions**

Update tests to assert these evidence strings exist:

```js
'V1.12'
'supervisor-lifecycle-guarded-runner-execution-preview-button'
'src/web/app.js buildSupervisorLifecycleGuardedRunnerExecutionPreviewViewModel'
'test/web-console.test.js supervisor lifecycle guarded runner execution preview'
'executionReady:false'
'wouldExecute:false'
```

- [ ] **Step 2: Run release/doc tests to verify RED**

Run:

```bash
node --test --test-reporter=spec test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

Expected before docs/version implementation: FAIL on V1.12 assertions.

- [ ] **Step 3: Update version, README, and Gold evidence**

Set:

```js
export const LINKE_RELEASE_VERSION = 'V1.12';
```

README current summary must say V1.12 adds Web Console guarded runner execution preview only. The V1.11 row must become historical API-only.

Gold readiness `automation-installation` evidence must add:

```js
'supervisor-lifecycle-guarded-runner-execution-preview-button',
'src/web/app.js buildSupervisorLifecycleGuardedRunnerExecutionPreviewViewModel',
'test/web-console.test.js supervisor lifecycle guarded runner execution preview',
```

The `nextStep` must keep Gold blocked and mention no real guarded lifecycle apply execution wiring.

- [ ] **Step 4: Run release/doc tests to verify GREEN**

Run:

```bash
node --test --test-reporter=spec test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

Expected: exit 0.

## Final Verification

Run:

```bash
node --check src/web/app.js
git diff --check
node --test --test-reporter=spec test/web-console.test.js
node --test --test-reporter=spec test/version.test.js test/gold-readiness.test.js test/readme.test.js
npm test
```

Expected: all commands exit 0. Then run Qwen code review and DeepSeek closure verification before commit/push.
