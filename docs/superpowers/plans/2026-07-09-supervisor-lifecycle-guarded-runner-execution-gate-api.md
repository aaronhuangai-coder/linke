# V1.15 Supervisor Lifecycle Guarded Runner Execution Gate API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only POST API that exposes the guarded runner execution gate using inline metadata and server-owned approval records.

**Architecture:** Extend `src/server.js` with one read-only route that composes existing supervisor lifecycle pure functions and server-owned approval storage. Do not add Web UI, real runner execution, write-route registration, audit success writes, metadata writes, shell/launchctl/process/NAS/backup/restore calls, or remote commands.

**Tech Stack:** Node.js ESM HTTP server, existing Linke API auth/write-route registry, `node:test`.

## Global Constraints

- Current milestone after implementation must be `V1.15`.
- Gold readiness must remain `blocked`.
- New route must be exactly `POST /api/supervisor-lifecycle-guarded-runner-execution-gate`.
- The route must not be added to `API_WRITE_ROUTES`.
- The route must accept read-token authentication.
- Request body consumes only inline `operation`, `config`, `manifest`, `runnerBinding`, and optional boolean `executeRequested`.
- The route must use server-owned `dataDir` for approval records; it must ignore submitted `approval`, `dataDir`, `apply`, `output`, `configPath`, `manifestPath`, and `runnerBindingPath`.
- The route must not call `executeSupervisorLifecycleApply`, launchctl, shell, process listing, NAS, backup, restore, remote command, metadata writes, audit success writes, or approval writes.
- Error output must not leak paths, approval identity/reason, sourcePath, serverUrl, token, secret, Authorization, hashes, raw manifest JSON, raw runner binding JSON, or Node internal filesystem/parser errors.

---

### Task 1: API Route and Tests

**Files:**
- Modify: `src/server.js`
- Create: `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js`

**Interfaces:**
- Consumes:
  - `buildSupervisorLifecycleApplyPlan(config, options)`
  - `buildSupervisorLifecycleApplyReadiness(plan, approvalRecords)`
  - `validateSupervisorLifecycleExecutorManifest(plan, manifest)`
  - `buildSupervisorLifecycleGuardedRunnerReadiness(manifestReadiness, runnerBinding)`
  - `buildSupervisorLifecycleGuardedRunnerExecutionPreview(plan, guardedRunnerReadiness)`
  - `buildSupervisorLifecycleGuardedRunnerExecutionGate(plan, applyReadiness, manifestReadiness, guardedRunnerReadiness, executionPreview, options)`
  - `readSupervisorLifecycleApprovalRecords(dataDir)`
- Produces:
  - `POST /api/supervisor-lifecycle-guarded-runner-execution-gate`
  - Sanitized blocked JSON gate response

- [ ] **Step 1: Add RED API tests**

Create `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js` by adapting helper patterns from:

- `test/supervisor-lifecycle-apply-readiness-api.test.js`
- `test/supervisor-lifecycle-guarded-runner-execution-preview-api.test.js`

Required tests:

1. Write-route/auth:
   - `API_WRITE_ROUTES.length === 4`
   - `isApiWriteRoute('POST', '/api/supervisor-lifecycle-guarded-runner-execution-gate') === false`
   - route is absent from `API_WRITE_ROUTES`

2. Valid inline metadata with no approval records:
   - HTTP 200
   - `command:'supervisor-lifecycle-guarded-runner-execution-gate'`
   - `state:'blocked'`
   - blockers include `approval-record-gate-not-ready`, `execute-request-missing`, and `real-guarded-runner-execution-wiring-missing`
   - `executionEligible:false`
   - `wouldExecute:false`
   - `actionCandidates.length === 3`
   - `safety.readOnly:true`
   - no approval storage created
   - response does not leak serverUrl/sourcePath/dataDir/path/token/secret/approval material

3. Persisted approval record ready + `executeRequested:true`:
   - persist approval using existing `POST /api/supervisor-lifecycle-approval-persist`
   - call new route with same operation/config/manifest/runnerBinding and `executeRequested:true`
   - blockers do not include `execute-request-missing`
   - blockers still include only or at least `real-guarded-runner-execution-wiring-missing`
   - `gates.approvalRecordReady === true`
   - `gates.executeRequested === true`
   - all execution flags remain false

4. Read token:
   - server with read/write tokens accepts read token for the new POST route
   - response is blocked JSON

5. Missing runnerBinding:
   - HTTP 200
   - `runnerBindingsReady:false`
   - blockers include `guarded-runner-readiness-not-ready`
   - `actionCandidates.length === 0`
   - no sensitive values leak

6. Invalid operation/config/manifest/executeRequested:
   - invalid operation returns fixed operation error
   - invalid config returns fixed config error
   - missing/invalid manifest returns fixed validation error
   - `executeRequested:'yes'` returns `executeRequested must be a boolean when provided`
   - `executeRequested:null` returns `executeRequested must be a boolean when provided`
   - no submitted secret/path/raw JSON leaks

7. Ignore submitted write/path-like fields:
   - body includes `approval`, `dataDir`, `apply:true`, `output`, `configPath`, `manifestPath`, `runnerBindingPath`
   - route still uses server-owned approval store
   - response does not leak those submitted values
   - no extra approval/audit/metadata write is created by the new route
   - `assertNoSensitiveText` explicitly rejects `sha256:`

8. Approval records read failure:
   - make the server-owned approval JSONL path unreadable as a file
   - route returns fixed `failed to read supervisor lifecycle approval records`
   - response does not leak the filesystem path or Node error code

Run:

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js
```

Expected before implementation: FAIL because the route is not implemented.

- [ ] **Step 2: Update imports and constants**

In `src/server.js`, add `buildSupervisorLifecycleGuardedRunnerExecutionGate` to the supervisor lifecycle import list.

Add constants:

```js
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_GATE_CONFIG_ERROR = 'supervisor-lifecycle-guarded-runner-execution-gate failed; verify config is a readable valid Linke config';
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_GATE_VALIDATION_ERROR = 'supervisor-lifecycle-guarded-runner-execution-gate failed; execution gate validation did not complete';
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_GATE_EXECUTE_REQUESTED_ERROR = 'executeRequested must be a boolean when provided';
```

- [ ] **Step 3: Add the route**

Add the new route after `POST /api/supervisor-lifecycle-guarded-runner-execution-preview` and before mutating API routes.

Implementation outline:

```js
if (method === 'POST' && pathname === '/api/supervisor-lifecycle-guarded-runner-execution-gate') {
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

  if (body?.executeRequested !== undefined && typeof body.executeRequested !== 'boolean') {
    return sendError(res, 400, SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_GATE_EXECUTE_REQUESTED_ERROR);
  }

  let config;
  try {
    config = validateConfig(body?.config);
  } catch (err) {
    return sendError(res, 400, SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_GATE_CONFIG_ERROR);
  }

  const lifecyclePlan = buildSupervisorLifecycleApplyPlan(config, {
    operation,
    apply: true,
    envGateEnabled: true,
  });

  let approvalRecords;
  try {
    approvalRecords = await readSupervisorLifecycleApprovalRecords(dataDir);
  } catch (err) {
    return sendError(res, 400, SUPERVISOR_LIFECYCLE_APPROVAL_RECORDS_READ_ERROR);
  }

  try {
    const applyReadiness = buildSupervisorLifecycleApplyReadiness(lifecyclePlan, approvalRecords);
    const manifestReadiness = validateSupervisorLifecycleExecutorManifest(lifecyclePlan, body?.manifest);
    if (manifestReadiness.manifestReady !== true) {
      return sendError(res, 400, SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_GATE_VALIDATION_ERROR);
    }
    const guardedRunnerReadiness = buildSupervisorLifecycleGuardedRunnerReadiness(
      manifestReadiness,
      body?.runnerBinding,
    );
    const executionPreview = buildSupervisorLifecycleGuardedRunnerExecutionPreview(
      lifecyclePlan,
      guardedRunnerReadiness,
    );
    const executionGate = buildSupervisorLifecycleGuardedRunnerExecutionGate(
      lifecyclePlan,
      applyReadiness,
      manifestReadiness,
      guardedRunnerReadiness,
      executionPreview,
      { executeRequested: body?.executeRequested === true },
    );
    return sendJSON(res, 200, executionGate);
  } catch (err) {
    return sendError(res, 400, SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_GATE_VALIDATION_ERROR);
  }
}
```

Do not add this route to `API_WRITE_ROUTES`.

- [ ] **Step 4: Run focused API test**

Run:

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js
```

Expected: PASS.

### Task 2: Version, Gold, README, and Regression Tests

**Files:**
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `README.md`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**
- Consumes: V1.15 API route and test evidence from Task 1.
- Produces: Current release docs and Gold readiness evidence synced to `LINKE_RELEASE_VERSION === 'V1.15'`.

- [ ] **Step 1: Update version constant and tests**

Set:

```js
export const LINKE_RELEASE_VERSION = 'V1.15';
```

Update `test/version.test.js` and `test/gold-readiness.test.js` expectations from `V1.14` to `V1.15`.

- [ ] **Step 2: Update Gold readiness evidence**

In `src/gold-readiness.js`, add:

- `POST /api/supervisor-lifecycle-guarded-runner-execution-gate`
- `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js`
- `read token`
- `API_WRITE_ROUTES exclusion`
- `executeRequested:true`
- `executionEligible:false`
- `realRunnerWiringReady:false`
- `real-guarded-runner-execution-wiring-missing`

Update `nextStep` text so V1.15 is read-only API composition evidence, V1.14 remains CLI evidence, V1.13 remains pure gate evidence. Keep Gold blocked.

- [ ] **Step 3: Update README**

Update:

- Title and current badge to V1.15.
- Intro paragraph to describe the read-only API route and no-execution boundary.
- Version table:
  - new V1.15 current row
  - V1.14 becomes historical
- Gold readiness sections:
  - V1.15 API gate evidence
  - V1.14 CLI gate evidence remains historical
  - V1.13 pure gate evidence remains historical
  - Gold remains blocked.

- [ ] **Step 4: Update README and Gold tests**

Adjust assertions in:

- `test/readme.test.js`
- `test/gold-readiness.test.js`

They must require V1.15 evidence and ensure V1.14 is no longer current.

- [ ] **Step 5: Run focused docs/version tests**

Run:

```bash
node --test --test-reporter=spec test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

Expected: PASS.

### Task 3: Final Verification and Review Handoff

**Files:**
- No additional code files expected.

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: verified branch candidate for Qwen review, DeepSeek closure, commit, and push.

- [ ] **Step 1: Static checks**

Run:

```bash
node --check src/server.js
git diff --check
```

Expected: both exit 0.

- [ ] **Step 2: Focused tests**

Run:

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js
node --test --test-reporter=spec test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

Expected: all tests pass.

- [ ] **Step 3: Full suite**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Review and closure**

Run Qwen as read-only reviewer over the V1.15 diff with a strict final schema. Run DeepSeek as final closure verifier with strict JSON. Codex PM must independently verify command outputs, diff, and safety claims before commit.

- [ ] **Step 5: Commit and push**

Commit message:

```bash
git commit -m "feat: add guarded runner execution gate api"
```

Push `linke-v0.12-web-panel` to origin and verify local HEAD equals remote HEAD.
