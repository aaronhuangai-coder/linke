# Supervisor Lifecycle Guarded Runner Execution Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add V1.09 pure guarded runner execution preview evidence without enabling real host execution.

**Architecture:** Implement one pure function in `src/supervisor-lifecycle.js` that consumes an existing lifecycle plan and guarded runner readiness result. The function returns sanitized, blocked action previews and safety gates. Version, README, Gold evidence, and tests are updated after the pure layer is green.

**Tech Stack:** Node.js ESM, `node:test`, existing Linke supervisor lifecycle helpers.

## Global Constraints

- Do not add CLI, API, or Web Console controls in V1.09.
- Do not call `executeSupervisorLifecycleApply`.
- Do not call launchctl, write files, read process lists, connect to NAS, trigger backup or restore, or run remote commands.
- Keep `executionReady:false`, `executorReady:false`, `wouldExecute:false`, `wouldRun:false`, `wouldWrite:false`.
- Keep Gold blocked.

---

### Task 1: Pure Guarded Runner Execution Preview

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Create: `test/supervisor-lifecycle-guarded-runner-execution-preview.test.js`

**Interfaces:**
- Consumes: `buildSupervisorLifecycleApplyPlan(config, options)`, `validateSupervisorLifecycleExecutorManifest(plan, manifest)`, `buildSupervisorLifecycleGuardedRunnerReadiness(manifestReadiness, runnerBinding)`
- Produces: `buildSupervisorLifecycleGuardedRunnerExecutionPreview(plan, guardedRunnerReadiness)`

- [ ] **Step 1: Write failing tests**

Create `test/supervisor-lifecycle-guarded-runner-execution-preview.test.js` with cases for valid readiness blocked preview, invalid `null` and wrong-type inputs, invalid plan, not-ready readiness, tampered action mismatch, and redaction of unsafe action or runner metadata.

- [ ] **Step 2: Run RED command**

Run: `node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-preview.test.js`

Expected: fail because `buildSupervisorLifecycleGuardedRunnerExecutionPreview` is not exported.

- [ ] **Step 3: Implement the pure function**

Add constants and helper logic to `src/supervisor-lifecycle.js` near the guarded runner readiness helpers. The function must return a deterministic blocked object with `command:"supervisor-lifecycle-guarded-runner-execution-preview"`, `state:"blocked"`, `executionReady:false`, safe blockers, action previews, gates, and safety flags. Bad caller input must return blocked output rather than throwing. Action preview identity fields must be derived from validated plan/readiness metadata, while `wouldExecute:false`, `wouldRun:false`, and `wouldWrite:false` remain hard safety caps. Unsafe path-like, URL, host, token, secret, hash, process, or command-like metadata must be replaced with `[redacted]`.

- [ ] **Step 4: Run GREEN command**

Run: `node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-preview.test.js`

Expected: all tests pass.

### Task 2: Version, Gold, README, and Regression Coverage

**Files:**
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `README.md`
- Modify: `test/readme.test.js`

**Interfaces:**
- Consumes: `LINKE_RELEASE_VERSION`
- Produces: V1.09 release metadata and documented Gold evidence.

- [ ] **Step 1: Update tests first**

Update version, Gold readiness, and README tests to expect V1.09 as current. Assert the README and Gold evidence include `buildSupervisorLifecycleGuardedRunnerExecutionPreview`, `test/supervisor-lifecycle-guarded-runner-execution-preview.test.js`, `executionReady:false`, `wouldExecute:false`, and `guarded-runner-execution-preview-only`.

- [ ] **Step 2: Run RED command**

Run: `node --test --test-reporter=spec test/version.test.js test/gold-readiness.test.js test/readme.test.js`

Expected: fail until docs and metadata are updated.

- [ ] **Step 3: Update metadata and docs**

Set `LINKE_RELEASE_VERSION` to `V1.09`. Add V1.09 evidence to automation and production-hardening Gold items. Update README title, badge, version table, supervisor lifecycle sections, Gold blocker sections, and testing coverage.

- [ ] **Step 4: Run regression command**

Run: `node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-preview.test.js test/version.test.js test/gold-readiness.test.js test/readme.test.js`

Expected: all selected tests pass.

### Task 3: Final Verification and Review Gates

**Files:**
- No new source files beyond Tasks 1-2.

**Interfaces:**
- Consumes: local test and diff evidence.
- Produces: Qwen adversarial review, DeepSeek closure, commit, push.

- [ ] **Step 1: Run full verification**

Run:

```bash
git diff --check
node --check src/supervisor-lifecycle.js
npm test
```

Expected: all commands exit 0.

- [ ] **Step 2: Qwen adversarial review**

Ask Qwen to review scope, safety, test coverage, docs/Gold claims, and no execution overclaim. Treat `DONE_WITH_CONCERNS` as requiring PM closure evidence.

- [ ] **Step 3: DeepSeek closure**

Ask DeepSeek to verify release closure using only local evidence and Qwen closure status.

- [ ] **Step 4: Commit and push**

Commit with `feat: add supervisor lifecycle guarded runner execution preview` and push the current branch.
