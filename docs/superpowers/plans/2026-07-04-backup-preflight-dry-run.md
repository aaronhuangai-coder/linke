# Backup Preflight Dry-Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Linke V0.11 backup preflight dry-run across API, CLI, Web Console docs, README, and tests.

**Architecture:** Add a focused read-only preflight scanner that reuses the existing exclude matching behavior. Route API and CLI requests through that scanner, while Web Console only exposes a safe command hint in V0.11.

**Tech Stack:** Node.js ESM, `node:test`, built-in `fetch`, zero runtime dependencies.

## Global Constraints

- Use only Node built-in modules.
- Do not read or output secrets, `.env`, credentials, SSH keys, or cloud auth files.
- Do not create snapshots, copy files, write files, create directories, rename files, or modify metadata during backup preflight dry-run.
- Keep all behavior covered by failing tests before implementation.
- V0.11 Web Console must not add a real backup execution button or interactive write action.

---

### Task 1: Preflight Planner And API

**Files:**
- Create: `src/backup-preflight.js`
- Modify: `src/server.js`
- Test: `test/backup-preflight-dry-run.test.js`

**Interfaces:**
- Consumes: `shouldExclude(name, excludePatterns)` from `src/storage.js`.
- Produces: `runBackupPreflightDryRun(sourcePath, excludePatterns)` returning the output contract from the spec.

- [ ] **Step 1: Write failing planner and API tests**

Create tests for included/excluded relative paths, missing `sourcePath`, non-existent source path, no snapshot creation, and unchanged repository contents.

- [ ] **Step 2: Run RED**

Run: `npm test`

Expected: fail because `src/backup-preflight.js` and the API route do not exist.

- [ ] **Step 3: Implement minimal scanner and API route**

Create `src/backup-preflight.js`, import it in `src/server.js`, and add:

`GET /api/backup-preflight-dry-run?sourcePath=...&exclude=...`

- [ ] **Step 4: Run GREEN**

Run: `npm test`

Expected: backup preflight dry-run tests pass.

### Task 2: CLI Command

**Files:**
- Modify: `src/agent.js`
- Test: `test/backup-preflight-dry-run.test.js`

**Interfaces:**
- Consumes: API route from Task 1.
- Produces: command `backup-preflight-dry-run` requiring `--source`, with repeatable `--exclude`.

- [ ] **Step 1: Write failing CLI tests**

Add tests that the CLI prints JSON for a valid dry-run and exits with an error when `--source` is missing.

- [ ] **Step 2: Run RED**

Run: `npm test`

Expected: fail because CLI command is unknown.

- [ ] **Step 3: Implement CLI command**

Add `backup-preflight-dry-run` to command comments, usage, and `main()`.

- [ ] **Step 4: Run GREEN**

Run: `npm test`

Expected: CLI tests pass.

### Task 3: Web Console Command Hint

**Files:**
- Modify: `src/web/index.html`
- Test: `test/web-console.test.js`

**Interfaces:**
- Consumes: CLI command from Task 2.
- Produces: visible command hint and safety note in the Agent config panel.

- [ ] **Step 1: Write failing Web Console tests**

Assert the HTML contains `backup-preflight-dry-run-command` and a safety note stating no snapshot, no copy, and no metadata writes.

- [ ] **Step 2: Run RED**

Run: `npm test`

Expected: fail because Web Console hint does not exist.

- [ ] **Step 3: Implement minimal UI copy**

Add a command hint and safety note to the existing Agent config panel.

- [ ] **Step 4: Run GREEN**

Run: `npm test`

Expected: Web Console tests pass.

### Task 4: README And Full Verification

**Files:**
- Modify: `README.md`
- Test: `test/readme.test.js`

**Interfaces:**
- Consumes: V0.11 behavior from Tasks 1-3.
- Produces: README version, API table, CLI section, safety section, and testing coverage text.

- [ ] **Step 1: Write failing README tests**

Assert README mentions V0.11, backup preflight dry-run CLI/API/Web Console, and no snapshot/no copy/no metadata-write boundary.

- [ ] **Step 2: Run RED**

Run: `npm test`

Expected: fail until README is updated.

- [ ] **Step 3: Update README**

Update version table, features, CLI commands, Web Console section, safety boundary, API table, testing coverage, and not-yet-implemented list if needed.

- [ ] **Step 4: Full verification**

Run: `npm test`

Expected: all tests pass with zero failures.
