# Linke V1.07 Supervisor Lifecycle Guarded Runner Readiness API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only API endpoint for guarded runner binding readiness.

**Architecture:** The server will mirror the existing executor manifest readiness route. It validates inline config and operation, builds the in-memory lifecycle plan, validates the inline executor manifest, then calls the guarded runner readiness pure function with inline `runnerBinding`.

**Tech Stack:** Node.js built-in HTTP server, `node:test`, existing Linke supervisor lifecycle helpers.

## Global Constraints

- No API write route registration for `POST /api/supervisor-lifecycle-guarded-runner-readiness`.
- No Web Console changes in V1.07.
- No local path reads for manifest or runner binding.
- No lifecycle apply execution, launchctl, filesystem writes, approval-store mutation, NAS access, backup, restore, or remote commands.
- Responses must not leak config values, paths, tokens, Authorization headers, unsafe runner values, stack traces, or filesystem errors.

---

### Task 1: API Test Coverage

**Files:**
- Create: `test/supervisor-lifecycle-guarded-runner-readiness-api.test.js`

**Interfaces:**
- Consumes: `createServer`, `API_WRITE_ROUTES`, `isApiWriteRoute` from `src/server.js`.
- Produces: failing tests for the new route contract.

- [ ] **Step 1: Write failing API tests**

Add tests for route registry exclusion, valid inline readiness, read-token access, unsafe runner binding redaction, missing runner binding blocked readiness, sanitized invalid operation/config/validation errors, and ignored extra fields.

- [ ] **Step 2: Verify RED**

Run: `node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-readiness-api.test.js`

Expected: fail because `/api/supervisor-lifecycle-guarded-runner-readiness` does not exist yet.

### Task 2: Server Route

**Files:**
- Modify: `src/server.js`

**Interfaces:**
- Consumes: `buildSupervisorLifecycleGuardedRunnerReadiness(manifestReadiness, runnerBinding)`.
- Produces: `POST /api/supervisor-lifecycle-guarded-runner-readiness`.

- [ ] **Step 1: Import the guarded runner readiness helper**

Add `buildSupervisorLifecycleGuardedRunnerReadiness` to the supervisor lifecycle imports.

- [ ] **Step 2: Add fixed sanitized error constants**

Add guarded runner readiness config and validation error strings near the existing executor manifest readiness constants.

- [ ] **Step 3: Add the read-only route**

Place it next to the executor manifest readiness route. Parse JSON, validate `operation`, validate inline `config`, build an in-memory lifecycle plan, validate inline `manifest`, build guarded runner readiness from inline `runnerBinding`, and return JSON. Do not read approval records or write audit/storage state.

- [ ] **Step 4: Verify GREEN**

Run: `node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-readiness-api.test.js`

Expected: all tests pass.

### Task 3: Release Metadata And Documentation

**Files:**
- Modify: `src/version.js`
- Modify: `test/version.test.js`
- Modify: `src/gold-readiness.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `README.md`
- Modify: `test/readme.test.js`

**Interfaces:**
- Consumes: V1.07 API evidence from Task 2.
- Produces: synchronized release version, README, and Gold readiness evidence.

- [ ] **Step 1: Update release version to V1.07**

Change `LINKE_RELEASE_VERSION` and tests from `V1.06` to `V1.07`.

- [ ] **Step 2: Update README current milestone**

Make V1.07 current, move V1.06 to historical, and document that the new API remains read-only and Gold remains blocked.

- [ ] **Step 3: Update Gold readiness evidence**

Add `POST /api/supervisor-lifecycle-guarded-runner-readiness` and `test/supervisor-lifecycle-guarded-runner-readiness-api.test.js` evidence while keeping Gold blockers.

- [ ] **Step 4: Verify release documentation tests**

Run: `node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-readiness-api.test.js test/version.test.js test/gold-readiness.test.js test/readme.test.js`

Expected: all targeted tests pass.

### Task 4: Final Verification

**Files:**
- No new production files.

**Interfaces:**
- Consumes: all V1.07 changes.
- Produces: release-ready evidence for Qwen and DeepSeek review.

- [ ] **Step 1: Run whitespace check**

Run: `git diff --check`

Expected: no output.

- [ ] **Step 2: Run full tests**

Run: `npm test`

Expected: all tests pass.
