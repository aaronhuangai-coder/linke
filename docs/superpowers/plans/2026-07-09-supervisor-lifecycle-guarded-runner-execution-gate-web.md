# V1.16 Supervisor Lifecycle Guarded Runner Execution Gate Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual read-only Web Console control for the V1.15 guarded runner execution gate API.

**Architecture:** Reuse the existing supervisor lifecycle approval preview panel, manifest textarea, runner binding textarea, shared result renderer, and shared in-flight button suppression. Add only a new button, safety note, view model, fetch handler, focused DOM tests, and release documentation updates.

**Tech Stack:** Browser ESM (`src/web/app.js`), static HTML (`src/web/index.html`), Node.js `node:test`, existing Linke release docs and Gold readiness scorecard.

## Global Constraints

- Current milestone after implementation must be `V1.16`.
- Gold readiness must remain `blocked`.
- Do not modify V1.15 API semantics.
- New Web control must be manual click only; no init request and no polling.
- New control must call exactly `POST /api/supervisor-lifecycle-guarded-runner-execution-gate`.
- Request body must include only inline `operation`, `config`, `manifest`, `runnerBinding`, and `executeRequested:true`.
- Request body must not include `approval`, `dataDir`, `apply`, `output`, `configPath`, `manifestPath`, or `runnerBindingPath`.
- Button label must include `Gate` or `Check` and must not be `Execute`, `Execution`, `Run install`, `Start`, `Launch`, `Rollback`, or `Uninstall`.
- Web rendering must remain fail-closed even if future payloads claim `executionEligible:true`, `wouldExecute:true`, `wouldRun:true`, or `wouldWrite:true`.
- Web rendering must not display paths, URLs, hostnames, token, secret, Authorization, Bearer, approval identity/reason/acknowledgements, `sha256:`, command-like strings, or unsafe raw metadata.
- Do not add real lifecycle execution, guarded runner execution, shell/launchctl/process/NAS/backup/restore/remote command calls, metadata writes, audit writes, or approval writes.

---

### Task 1: Web Execution Gate Control and Tests

**Files:**
- Modify: `src/web/index.html`
- Modify: `src/web/app.js`
- Modify: `test/web-console.test.js`

**Interfaces:**
- Consumes:
  - existing `parseSupervisorLifecycleGuardedRunnerReadinessPayload()`
  - existing `renderSupervisorLifecycleApprovalPreview(viewModel)`
  - existing `apiFetch(...)`
  - existing guarded runner execution sanitizer helpers
- Produces:
  - `buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel(payload, errorMessage = '')`
  - button `supervisor-lifecycle-guarded-runner-execution-gate-button`
  - safety note `supervisor-lifecycle-guarded-runner-execution-gate-safety-note`
  - manual fetch handler for `/api/supervisor-lifecycle-guarded-runner-execution-gate`

- [ ] **Step 1: Add RED tests for HTML and app.js contract**

Update `test/web-console.test.js`:

- In `GET / returns HTML with required data-testid hooks`, assert the gate button and safety note exist.
- In `HTML contains supervisor lifecycle approval persistence preview panel with required data-testid hooks`, assert:
  - `data-testid="supervisor-lifecycle-guarded-runner-execution-gate-button"`
  - `data-testid="supervisor-lifecycle-guarded-runner-execution-gate-safety-note"`
  - button text matches `/Guarded Runner Gate Check/i`
  - button text does not match `/Execute|Execution|Run install|Start|Launch|Rollback|Uninstall/i`
- In the safety note test, assert the panel text includes:
  - `POST /api/supervisor-lifecycle-guarded-runner-execution-gate`
  - `executeRequested:true`
  - `executionEligible:false`
  - `realRunnerWiringReady:false`
  - no lifecycle apply / launchctl / process list / NAS / backup / restore / remote command boundary
- In `app.js wires supervisor lifecycle approval preview rendering contract`, assert:
  - `apiFetch('/api/supervisor-lifecycle-guarded-runner-execution-gate'`
  - `buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel`
  - `supervisor-lifecycle-guarded-runner-execution-gate-button`

Run:

```bash
node --test --test-reporter=spec test/web-console.test.js
```

Expected before implementation: FAIL because the button, safety note, endpoint, and view model do not exist.

- [ ] **Step 2: Add RED tests for local validation and no init request**

Add tests near the existing execution preview tests:

- `does not request /api/supervisor-lifecycle-guarded-runner-execution-gate on initialization`
- `validates guarded runner execution gate config, manifest, and runner binding locally without calling the API`

The validation test should mirror execution preview validation, but check no call to `/api/supervisor-lifecycle-guarded-runner-execution-gate` for:

- empty config
- invalid config JSON
- empty manifest
- invalid manifest JSON
- empty runner binding
- invalid runner binding JSON

Expected before implementation: FAIL because the button listener does not exist.

- [ ] **Step 3: Add RED view model sanitization test**

Add `builds a fail-closed sanitized guarded runner execution gate view model`.

Input payload must include:

```js
{
  command: 'supervisor-lifecycle-guarded-runner-execution-gate',
  state: 'blocked',
  executionGateState: 'blocked',
  executionEligible: true,
  executorReady: true,
  wouldExecute: true,
  blockers: ['real-guarded-runner-execution-wiring-missing'],
  nextBlockers: ['real-guarded-runner-execution-wiring-missing'],
  gates: {
    lifecyclePlanValid: true,
    approvalRecordReady: true,
    manifestReady: true,
    runnerBindingsReady: true,
    executeRequested: true,
    realRunnerWiringReady: true,
  },
  actionCandidates: [{
    actionId: 'render-launch-agent-plist',
    implementationId: 'sha256:abc /Users/ah/secret-path',
    mode: 'curl http://unsafe.example password=super-secret',
    runnerKind: 'node /Users/ah/.ssh/id_rsa token=SECRET_XYZ',
    status: 'ready',
    wouldExecute: true,
    wouldRun: true,
    wouldWrite: true,
    command: '/bin/sh',
  }],
  safety: {
    readOnly: true,
    lifecycleApplied: true,
    filesystemWritten: true,
    auditEventWritten: true,
    metadataWritten: true,
  },
}
```

Assertions:

- `statusText === '执行 gate 阻塞'`
- stats include `executionEligible:false / executorReady:false`
- persistence includes `executeRequested:true`
- rendered text includes `real-guarded-runner-execution-wiring-missing`, `wouldExecute:false`, `wouldRun:false`, `wouldWrite:false`, `realRunnerWiringReady:false`, `executionEligible:false`, `executorReady:false`, `readOnly:true`
- rendered text does not include `/Users/ah`, `SECRET_XYZ`, `sha256:`, `unsafe.example`, `super-secret`, `/bin/sh`, `node`, `curl`, or `password`

Expected before implementation: FAIL because the view model export does not exist.

- [ ] **Step 4: Add RED manual request and in-flight tests**

Add tests:

1. `requests guarded runner execution gate manually with inline payload and executeRequested intent`
   - Fill operation/config/approval/manifest/runnerBinding.
   - Click `supervisor-lifecycle-guarded-runner-execution-gate-button`.
   - Mock endpoint returns blocked gate.
   - Assert request body has operation/config/manifest/runnerBinding and `executeRequested === true`.
   - Assert `Object.keys(requestBody).sort()` equals `['config', 'executeRequested', 'manifest', 'operation', 'runnerBinding']`.
   - Assert request body omits approval/dataDir/apply/output/configPath/manifestPath/runnerBindingPath.
   - Assert rendered result includes fail-closed gate fields and no approval identity.

2. `does not start a second guarded runner execution gate request while one is in flight`
   - First request blocks.
   - Two clicks produce exactly one gate fetch.
   - Shared result buttons are disabled during request and re-enabled after completion.

3. `does not start guarded runner execution gate while guarded runner readiness or execution preview is in flight`
   - Start readiness request or preview request.
   - Click gate button.
   - Assert gate fetch count remains 0.

Expected before implementation: FAIL.

- [ ] **Step 5: Implement HTML button and safety note**

In `src/web/index.html`, add the new button after `Guarded Runner Execution Preview`:

```html
<button id="supervisor-lifecycle-guarded-runner-execution-gate-button" data-testid="supervisor-lifecycle-guarded-runner-execution-gate-button" type="button">Guarded Runner Gate Check</button>
```

Add safety note after `supervisor-lifecycle-guarded-runner-execution-preview-safety-note`:

```html
<div class="supervisor-lifecycle-approval-preview-safety-note" id="supervisor-lifecycle-guarded-runner-execution-gate-safety-note" data-testid="supervisor-lifecycle-guarded-runner-execution-gate-safety-note">
  <p>Guarded Runner Gate Check 仅由用户点击后手动 POST /api/supervisor-lifecycle-guarded-runner-execution-gate，并且请求体只包含 inline operation、config、manifest、runnerBinding 与 executeRequested:true；不读取 approval textarea、不提交 approval JSON、不提交 dataDir/path/apply/output、不写文件、不执行 lifecycle apply、不调用 launchctl、不安装、不卸载、不回滚、不启动 recovery supervisor、不读取进程列表、不连接 NAS、不触发备份或恢复、不执行远程命令；仅展示 executionEligible:false、executorReady:false、wouldExecute:false、realRunnerWiringReady:false、actionCandidates wouldRun:false/wouldWrite:false、blockers、nextBlockers 与 safety flags，不显示路径、URL、token、Authorization header、secret、hash、hostname、username、process id 或 command；Gold 仍 blocked。</p>
</div>
```

- [ ] **Step 6: Implement view model**

In `src/web/app.js`, add `buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel` after `buildSupervisorLifecycleGuardedRunnerExecutionPreviewViewModel`.

Implementation requirements:

- Reuse `sanitizeSupervisorLifecycleGuardedRunnerExecutionPreviewField(...)` for error text, action candidate IDs, implementation IDs, modes, runner kinds, and statuses.
- Treat every gate payload as blocked for display.
- Treat future unexpected payload states such as `ready`, `applied`, or `completed` as blocked display.
- Sanitize `actionCandidates` into candidate lines.
- Force display booleans for execution to false:
  - `executionEligible:false`
  - `executorReady:false`
  - `wouldExecute:false`
  - `wouldRun:false`
  - `wouldWrite:false`
  - `realRunnerWiringReady:false`
- Only show `executeRequested:true` when `payload.gates?.executeRequested === true`.
- Use `sanitizeSupervisorLifecycleGuardedRunnerReadinessList(...)` for blockers.

- [ ] **Step 7: Implement DOM wiring and fetch handler**

In `src/web/app.js`:

- Add DOM reference:

```js
const supervisorLifecycleGuardedRunnerExecutionGateButton = doc.getElementById('supervisor-lifecycle-guarded-runner-execution-gate-button');
```

- Add in-flight flag:

```js
let supervisorLifecycleGuardedRunnerExecutionGateInFlight = false;
```

- Include this flag in `hasSupervisorLifecycleSharedResultRequestInFlight()`.
- Include this button in `setSupervisorLifecycleSharedResultButtonsDisabled(...)`.
- Add `setSupervisorLifecycleGuardedRunnerExecutionGateError(message)`.
- Add `fetchSupervisorLifecycleGuardedRunnerExecutionGate()`:
  - if shared result request is in flight, return.
  - parse `parseSupervisorLifecycleGuardedRunnerReadinessPayload()`.
  - on parse failure, render gate error and return.
  - POST `/api/supervisor-lifecycle-guarded-runner-execution-gate`.
  - body is an explicit allowlist, never a spread:

```js
JSON.stringify({
  operation: parsed.payload.operation,
  config: parsed.payload.config,
  manifest: parsed.payload.manifest,
  runnerBinding: parsed.payload.runnerBinding,
  executeRequested: true,
})
```

  - render `buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel(body)`.
  - log warning on success and sanitized error on failure.
  - re-enable shared buttons in `finally`.
- Bind click listener.

- [ ] **Step 8: Run focused Web test**

Run:

```bash
node --test --test-reporter=spec test/web-console.test.js
```

Expected: PASS.

### Task 2: Version, README, Gold, and Release Tests

**Files:**
- Modify: `src/version.js`
- Modify: `README.md`
- Modify: `src/gold-readiness.js`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**
- Consumes: V1.16 Web evidence from Task 1.
- Produces: release metadata and docs synchronized to `LINKE_RELEASE_VERSION === 'V1.16'`.

- [ ] **Step 1: Update version**

Set:

```js
export const LINKE_RELEASE_VERSION = 'V1.16';
```

Update version expectations in:

- `test/version.test.js`
- `test/gold-readiness.test.js`

- [ ] **Step 2: Update README**

Update:

- title `# Linke V1.16`
- current version badge
- version table:
  - V1.16 current
  - V1.15 historical
- feature/evidence sections with:
  - `supervisor-lifecycle-guarded-runner-execution-gate-button`
  - `src/web/app.js buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel`
  - `test/web-console.test.js supervisor lifecycle guarded runner execution gate`
  - `executeRequested:true`
  - `executionEligible:false`
  - `wouldExecute:false`
  - `realRunnerWiringReady:false`
  - no lifecycle apply / no real execution / Gold blocked

- [ ] **Step 3: Update Gold readiness**

In `src/gold-readiness.js`, add V1.16 evidence to relevant partial areas:

- `supervisor-lifecycle-guarded-runner-execution-gate-button`
- `src/web/app.js buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel`
- `test/web-console.test.js supervisor lifecycle guarded runner execution gate`
- `executeRequested:true`
- `executionEligible:false`
- `wouldExecute:false`
- `realRunnerWiringReady:false`

Keep all Gold blockers, especially real guarded lifecycle apply execution wiring and real NAS remote backup.

- [ ] **Step 4: Update docs tests**

Update `test/readme.test.js` and `test/gold-readiness.test.js` to assert V1.16 current evidence and V1.15 historical evidence.

- [ ] **Step 5: Run docs/version tests**

Run:

```bash
node --test --test-reporter=spec test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

Expected: PASS.

### Task 3: Final Verification

**Files:**
- No new source files beyond Tasks 1-2.

**Interfaces:**
- Consumes: completed Web and docs changes.
- Produces: verified V1.16 deliverable.

- [ ] **Step 1: Run syntax and whitespace checks**

Run:

```bash
node --check src/web/app.js
git diff --check
```

Expected: both exit 0.

- [ ] **Step 2: Run focused suites**

Run:

```bash
node --test --test-reporter=spec test/web-console.test.js
node --test --test-reporter=spec test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

Expected: all pass.

- [ ] **Step 3: Run full suite**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Review safety boundary**

Verify in diff:

- no server route semantics changed
- no new API write route
- no real execution wording in button label
- no direct approval persistence in gate flow
- no sensitive file/path/token output

- [ ] **Step 5: Commit**

After PM/Qwen/DeepSeek verification, commit:

```bash
git add src/web/index.html src/web/app.js test/web-console.test.js README.md src/version.js src/gold-readiness.js test/version.test.js test/gold-readiness.test.js test/readme.test.js docs/superpowers/specs/2026-07-09-supervisor-lifecycle-guarded-runner-execution-gate-web-design.md docs/superpowers/plans/2026-07-09-supervisor-lifecycle-guarded-runner-execution-gate-web.md
git commit -m "feat: add guarded runner execution gate web control"
git push origin linke-v0.12-web-panel
```
