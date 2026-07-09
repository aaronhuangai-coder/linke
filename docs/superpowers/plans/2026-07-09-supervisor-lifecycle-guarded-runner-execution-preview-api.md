# Supervisor Lifecycle Guarded Runner Execution Preview API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add V1.11 read-only API access to the guarded runner execution preview while keeping real lifecycle execution blocked.

**Architecture:** The server route composes existing pure lifecycle helpers from inline request JSON and returns the same blocked preview shape as the V1.10 CLI. The release docs and Gold readiness evidence are updated to state V1.11 adds API visibility only, not Web UI or execution wiring.

**Tech Stack:** Node.js ESM, `node:test`, existing Linke HTTP server, existing supervisor lifecycle helpers.

## Global Constraints

- `LINKE_RELEASE_VERSION` must become `V1.11`.
- API path must be `POST /api/supervisor-lifecycle-guarded-runner-execution-preview`.
- The route must not be added to `API_WRITE_ROUTES`.
- A read token must be able to call the route.
- The route must not call `executeSupervisorLifecycleApply`.
- The route must not call launchctl.
- The route must not write files.
- The route must not read process lists.
- The route must not connect to NAS targets.
- The route must not trigger backup or restore.
- The route must not execute remote commands.
- The route must not add Web Console controls.
- The route must consume only inline `operation`, `config`, `manifest`, and `runnerBinding`.
- The route must ignore `approval`, `dataDir`, `apply`, `output`, `configPath`, `manifestPath`, and `runnerBindingPath`.
- Error output must not echo config paths, manifest paths, runner-binding paths, token-like values, URLs from invalid inputs, hostnames, usernames, local directories, raw JSON parse errors, or Node filesystem error names.

---

## File Structure

- Modify `src/server.js`: import `buildSupervisorLifecycleGuardedRunnerExecutionPreview`, add sanitized error constants, and add the read-only route after `supervisor-lifecycle-guarded-runner-readiness`.
- Create `test/supervisor-lifecycle-guarded-runner-execution-preview-api.test.js`: API contract and safety tests.
- Modify `src/version.js`: bump to V1.11.
- Modify `src/gold-readiness.js`: add V1.11 API preview evidence while Gold remains blocked.
- Modify `test/version.test.js`, `test/gold-readiness.test.js`, and `test/readme.test.js`: release and documentation assertions.
- Modify `README.md`: mark V1.11 current, move V1.10 to historical, document API-only safety boundary.

## Task 1: Read-Only Execution Preview API

**Files:**
- Modify: `src/server.js`
- Create: `test/supervisor-lifecycle-guarded-runner-execution-preview-api.test.js`

**Interfaces:**
- Consumes: `validateConfig(body.config)`, `buildSupervisorLifecycleApplyPlan(config, options)`, `validateSupervisorLifecycleExecutorManifest(plan, body.manifest)`, `buildSupervisorLifecycleGuardedRunnerReadiness(manifestReadiness, body.runnerBinding)`, `buildSupervisorLifecycleGuardedRunnerExecutionPreview(plan, guardedRunnerReadiness)`.
- Produces: `POST /api/supervisor-lifecycle-guarded-runner-execution-preview` returning blocked preview JSON.

- [ ] **Step 1: Write the API tests**

Use `test/supervisor-lifecycle-guarded-runner-readiness-api.test.js` as the template. The new test file must define `BASE_CONFIG`, `validInstallManifest()`, `validRunnerBinding()`, `withServer()`, `postJSON()`, and `assertNoSensitiveText()`.

The write-route test must assert:

```js
assert.strictEqual(API_WRITE_ROUTES.length, 4);
assert.strictEqual(isApiWriteRoute('POST', '/api/supervisor-lifecycle-guarded-runner-execution-preview'), false);
assert.strictEqual(API_WRITE_ROUTES.some((route) => (
  route.method === 'POST' && route.path === '/api/supervisor-lifecycle-guarded-runner-execution-preview'
)), false);
```

The valid inline request test must assert:

```js
assert.strictEqual(res.status, 200);
assert.strictEqual(body.command, 'supervisor-lifecycle-guarded-runner-execution-preview');
assert.strictEqual(body.operation, 'install');
assert.strictEqual(body.state, 'blocked');
assert.strictEqual(body.executionReady, false);
assert.strictEqual(body.executorReady, false);
assert.strictEqual(body.wouldExecute, false);
assert.strictEqual(body.runnerBindingsReady, true);
assert.deepStrictEqual(body.blockers, ['guarded-runner-execution-preview-only']);
assert.deepStrictEqual(body.nextBlockers, ['real-guarded-runner-execution-wiring-missing']);
assert.strictEqual(body.actionPreviews.length, 3);
assert.ok(body.actionPreviews.every((entry) =>
  entry.status === 'blocked' &&
  entry.wouldExecute === false &&
  entry.wouldRun === false &&
  entry.wouldWrite === false));
assert.strictEqual(body.safety.readOnly, true);
assert.strictEqual(body.safety.launchctlCalled, false);
assert.strictEqual(body.safety.filesystemWritten, false);
assert.strictEqual(body.safety.processListRead, false);
assert.strictEqual(body.safety.lifecycleApplied, false);
assert.strictEqual(body.safety.metadataWritten, false);
assert.strictEqual(body.safety.rollbackAnchorWritten, false);
assert.strictEqual(body.safety.auditEventWritten, false);
assert.strictEqual(body.safety.approvalPersisted, false);
assert.strictEqual(body.safety.sensitiveValuesReturned, false);
assert.strictEqual(body.safety.nasConnected, false);
assert.strictEqual(body.safety.backupTriggered, false);
assert.strictEqual(body.safety.restoreTriggered, false);
assert.strictEqual(body.safety.remoteCommandExecuted, false);
assert.deepStrictEqual(body.gates, {
  lifecyclePlanValid: true,
  runnerBindingsReady: true,
  executionPreviewOnly: true,
  executorReady: false,
});
await assert.rejects(() => readdir(join(dataDir, 'approvals')), /ENOENT/);
```

The read-token test must configure `readToken: 'read-token'` and `writeToken: 'write-token'`, call with `Authorization: 'Bearer read-token'`, and assert HTTP 200 plus `executionReady:false`.

The unsafe metadata test must mutate runner binding fields:

```js
runnerBinding.bindings[0].implementationId =
  'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
runnerBinding.bindings[0].runnerKind = 'node /Users/ah/.ssh/id_rsa token=SECRET_XYZ';
runnerBinding.bindings[0].mode = 'curl http://unsafe.example password=super-secret';
```

It must assert `runnerBindingsReady === false` and the first `actionPreviews` entry has `[redacted]` for `implementationId`, `runnerKind`, and `mode`.

The missing binding test must omit `runnerBinding` and assert HTTP 200, `state === 'blocked'`, `runnerBindingsReady === false`, `actionPreviews.length === 0`, and `blockers` includes `guarded-runner-readiness-not-ready`.

The invalid input test must assert the fixed operation error and fixed config error:

```js
assert.deepStrictEqual(invalidOperation.body, {
  error: 'operation must be one of: install, uninstall, rollback, recover',
});
assert.deepStrictEqual(invalidConfig.body, {
  error: 'supervisor-lifecycle-guarded-runner-execution-preview failed; verify config is a readable valid Linke config',
});
```

The missing manifest test must omit `manifest` while providing valid `config` and `runnerBinding`, then assert HTTP 400 with the fixed validation error:

```js
const missingManifest = await postJSON(port, '/api/supervisor-lifecycle-guarded-runner-execution-preview', {
  operation: 'install',
  config: BASE_CONFIG,
  runnerBinding: validRunnerBinding(),
});

assert.strictEqual(missingManifest.res.status, 400);
assert.deepStrictEqual(missingManifest.body, {
  error: 'supervisor-lifecycle-guarded-runner-execution-preview failed; execution preview validation did not complete',
});
assertNoSensitiveText(missingManifest.text, dataDir);
```

The invalid manifest test must submit a manifest object that cannot be treated as an executor manifest:

```js
const invalidManifest = await postJSON(port, '/api/supervisor-lifecycle-guarded-runner-execution-preview', {
  operation: 'install',
  config: BASE_CONFIG,
  manifest: { kind: 'wrong-kind', schemaVersion: 1, actions: 'bad' },
  runnerBinding: validRunnerBinding(),
});

assert.strictEqual(invalidManifest.res.status, 400);
assert.deepStrictEqual(invalidManifest.body, {
  error: 'supervisor-lifecycle-guarded-runner-execution-preview failed; execution preview validation did not complete',
});
assertNoSensitiveText(invalidManifest.text, dataDir);
```

The ignored-fields test must include `approval`, `dataDir`, `apply`, `output`, `configPath`, `manifestPath`, and `runnerBindingPath`, then assert HTTP 200 and no sensitive text leaks.

- [ ] **Step 2: Run the new test to verify RED**

Run:

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-preview-api.test.js
```

Expected before implementation: FAIL because the route does not exist.

- [ ] **Step 3: Implement the server route**

In `src/server.js`, update the supervisor lifecycle import list:

```js
import {
  buildSupervisorLifecycleApplyPlan,
  buildSupervisorLifecycleApplyReadiness,
  buildSupervisorLifecycleApprovalPersistencePreview,
  buildSupervisorLifecycleExecutorReadiness,
  buildSupervisorLifecycleGuardedRunnerExecutionPreview,
  buildSupervisorLifecycleGuardedRunnerReadiness,
  validateSupervisorLifecycleExecutorManifest,
} from './supervisor-lifecycle.js';
```

Add constants near the guarded runner readiness constants:

```js
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_PREVIEW_CONFIG_ERROR = 'supervisor-lifecycle-guarded-runner-execution-preview failed; verify config is a readable valid Linke config';
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_PREVIEW_VALIDATION_ERROR = 'supervisor-lifecycle-guarded-runner-execution-preview failed; execution preview validation did not complete';
```

Add this route immediately after `/api/supervisor-lifecycle-guarded-runner-readiness`:

```js
// POST /api/supervisor-lifecycle-guarded-runner-execution-preview
// 只读 fail-closed guarded runner execution preview。仅消费 inline JSON，
// 不读取本地 path 或 approval storage，且刻意不注册为写路由。
if (method === 'POST' && pathname === '/api/supervisor-lifecycle-guarded-runner-execution-preview') {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    if (err.statusCode === 400 || err.statusCode === 413) {
      return sendError(res, err.statusCode, err.message);
    }
    throw err;
  }

  const operation = body?.operation;
  const validOperations = new Set(['install', 'uninstall', 'rollback', 'recover']);
  if (!validOperations.has(operation)) {
    return sendError(res, 400, 'operation must be one of: install, uninstall, rollback, recover');
  }

  let config;
  try {
    config = validateConfig(body?.config);
  } catch (err) {
    return sendError(res, 400, SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_PREVIEW_CONFIG_ERROR);
  }

  const lifecyclePlan = buildSupervisorLifecycleApplyPlan(config, {
    operation,
    apply: true,
    envGateEnabled: true,
  });

  try {
    const manifestReadiness = validateSupervisorLifecycleExecutorManifest(lifecyclePlan, body?.manifest);
    if (manifestReadiness.manifestReady !== true) {
      return sendError(res, 400, SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_PREVIEW_VALIDATION_ERROR);
    }
    const guardedRunnerReadiness = buildSupervisorLifecycleGuardedRunnerReadiness(
      manifestReadiness,
      body?.runnerBinding,
    );
    const executionPreview = buildSupervisorLifecycleGuardedRunnerExecutionPreview(
      lifecyclePlan,
      guardedRunnerReadiness,
    );
    return sendJSON(res, 200, executionPreview);
  } catch (err) {
    return sendError(res, 400, SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_PREVIEW_VALIDATION_ERROR);
  }
}
```

Do not modify `API_WRITE_ROUTES`.

- [ ] **Step 4: Run route tests to verify GREEN**

Run:

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-preview-api.test.js test/supervisor-lifecycle-guarded-runner-readiness-api.test.js test/supervisor-lifecycle-guarded-runner-execution-preview.test.js
```

Expected: PASS.

## Task 2: Release Evidence And Documentation

**Files:**
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: `LINKE_RELEASE_VERSION` and current Gold readiness item evidence arrays.
- Produces: V1.11 current release docs and tests that preserve V1.10 CLI evidence as historical.

- [ ] **Step 1: Update version tests and constant**

Change `LINKE_RELEASE_VERSION` to `V1.11` in `src/version.js`.

Update exact version assertions in `test/version.test.js` and `test/gold-readiness.test.js` from `V1.10` to `V1.11`.

- [ ] **Step 2: Update Gold readiness evidence**

In `src/gold-readiness.js`, add these evidence strings to the automation and hardening evidence where V1.10 execution preview evidence is already listed:

```js
'POST /api/supervisor-lifecycle-guarded-runner-execution-preview',
'test/supervisor-lifecycle-guarded-runner-execution-preview-api.test.js',
```

Update `nextStep` strings so V1.11 is described as read-only API visibility and V1.10 remains read-only CLI visibility. Keep Gold blocked and keep `real-nas-remote-backup`, production auth, secret management, monitoring, real guarded lifecycle apply execution wiring, rollback, uninstall, recovery supervisor, and managed daemon lifecycle as missing.

Update `test/gold-readiness.test.js` assertions to require both new V1.11 strings and to keep the V1.10 strings.

- [ ] **Step 3: Update README and README tests**

Update `README.md`:

- Title: `# Linke V1.11`.
- Badge: `**当前版本：V1.11**`.
- Version table: add V1.11 as current and move V1.10 to historical.
- Document `POST /api/supervisor-lifecycle-guarded-runner-execution-preview` as inline-only, read-token-callable, outside `API_WRITE_ROUTES`, sanitized, blocked, missing/invalid/not-ready manifest returning fixed sanitized validation error, and no Web in V1.11.
- Keep V1.10 CLI evidence and V1.09 pure evidence.
- Replace V1.10 "no API" wording where it refers to current state; keep "V1.10 no API" only as historical CLI boundary.

Update `test/readme.test.js` by converting the V1.10 describe block to V1.11 and adding assertions for:

```js
assertReadmeContains(/# Linke V1\.11/, 'README title should mention V1.11');
assertReadmeContains(/\*\*当前版本：V1\.11\*\*/, 'README badge should mention V1.11');
assertReadmeContains(/\| V1\.11 \| 当前版本 \|[^|]*POST \/api\/supervisor-lifecycle-guarded-runner-execution-preview[^|]*API_WRITE_ROUTES[^|]*read token[^|]*executionReady:false[^|]*wouldExecute:false[^|]*test\/supervisor-lifecycle-guarded-runner-execution-preview-api\.test\.js/i, 'V1.11 should be current guarded runner execution preview API milestone');
assertReadmeContains(/\| V1\.10 \| 历史版本 \|[^|]*agent\.js supervisor-lifecycle-guarded-runner-execution-preview[^|]*test\/agent-supervisor-lifecycle-guarded-runner-execution-preview\.test\.js/i, 'V1.10 should become historical CLI milestone');
assertReadmeContains(/POST \/api\/supervisor-lifecycle-guarded-runner-execution-preview/, 'README should document V1.11 API surface');
assertReadmeContains(/不注册到 `?API_WRITE_ROUTES`?|read token 可调用|read token.*call/i, 'README should document execution preview API read-only auth boundary');
assertReadmeContains(/不新增 Web|no Web/i, 'README should document V1.11 adds no Web surface');
```

Keep existing safety assertions for `executeSupervisorLifecycleApply`, launchctl, filesystem writes, process list reads, NAS, backup, restore, and remote commands.

- [ ] **Step 4: Run release and documentation tests**

Run:

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-preview-api.test.js test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

Expected: PASS.

## Final Verification

Run these commands before handing back to PM:

```bash
node --check src/server.js
git diff --check
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-preview-api.test.js test/supervisor-lifecycle-guarded-runner-readiness-api.test.js test/supervisor-lifecycle-guarded-runner-execution-preview.test.js
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-preview-api.test.js test/version.test.js test/gold-readiness.test.js test/readme.test.js
npm test
```

Expected: every command exits 0.
