# Restore Dry-Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Linke V0.10 restore dry-run across API, CLI, Web Console, README, and tests.

**Architecture:** Add a focused pure planner for restore previews, then route API and CLI calls through it. The Web Console displays the preview after a snapshot is selected, using a target-path input and no real restore execution button.

**Tech Stack:** Node.js ESM, `node:test`, built-in `fetch`, zero runtime dependencies.

## Global Constraints

- Use only Node built-in modules.
- Do not read or output secrets, `.env`, credentials, SSH keys, or cloud auth files.
- Do not implement real restore execution from Web Console in V0.10.
- Do not create, copy, overwrite, delete, or rename files during restore dry-run.
- Keep all behavior covered by failing tests before implementation.

---

### Task 1: Restore Dry-Run Planner And API

**Files:**
- Create: `src/restore-dry-run.js`
- Modify: `src/server.js`
- Test: `test/restore-dry-run.test.js`

**Interfaces:**
- Consumes: `getSnapshotManifest(dataDir, deviceId, snapshotId)` from `src/storage.js`.
- Produces: `buildRestoreDryRunPlan(deviceId, manifest, targetPath, existingTargetPaths)` returning the output contract from the spec.

- [ ] **Step 1: Write failing planner and API tests**

Create tests for create/overwrite actions, missing `targetPath`, invalid `snapshotId`, missing snapshot, unchanged manifest hash, and unchanged target directory listing.

- [ ] **Step 2: Run RED**

Run: `npm test -- test/restore-dry-run.test.js`

Expected: fail because `src/restore-dry-run.js` and API route do not exist.

- [ ] **Step 3: Implement minimal planner and API route**

Create `src/restore-dry-run.js`, import it in `src/server.js`, and add:

`GET /api/devices/:deviceId/snapshots/:snapshotId/restore-dry-run?targetPath=...`

- [ ] **Step 4: Run GREEN**

Run: `npm test -- test/restore-dry-run.test.js`

Expected: all restore dry-run tests pass.

### Task 2: Restore Dry-Run CLI

**Files:**
- Modify: `src/agent.js`
- Test: `test/restore-dry-run.test.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: API route from Task 1.
- Produces: command `restore-dry-run` requiring `--device`, `--snapshot`, and `--target`.

- [ ] **Step 1: Write failing CLI tests**

Add tests that the CLI prints JSON for a valid dry-run and exits with errors when required flags are missing.

- [ ] **Step 2: Run RED**

Run: `npm test -- test/restore-dry-run.test.js`

Expected: fail because CLI command is unknown.

- [ ] **Step 3: Implement CLI command**

Add `restore-dry-run` to command comments, usage, and `main()`.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- test/restore-dry-run.test.js`

Expected: CLI tests pass.

### Task 3: Web Console Restore Preview

**Files:**
- Modify: `src/web/index.html`
- Modify: `src/web/app.js`
- Modify: `src/web/styles.css`
- Test: `test/web-console.test.js`

**Interfaces:**
- Consumes: API route from Task 1.
- Produces: a restore dry-run panel with target input, counts, file list, and safety note.

- [ ] **Step 1: Write failing Web Console tests**

Assert the HTML contains `restore-dry-run-panel`, the panel has no real restore execution button, `app.js` calls `restore-dry-run`, and DOM rendering displays counts/actions.

- [ ] **Step 2: Run RED**

Run: `npm test -- test/web-console.test.js`

Expected: fail because panel and client logic do not exist.

- [ ] **Step 3: Implement minimal UI**

Add the panel, target input, safety note, fetch logic after snapshot selection, and render counts/actions using `textContent`.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- test/web-console.test.js`

Expected: Web Console tests pass.

### Task 4: README And Full Verification

**Files:**
- Modify: `README.md`
- Test: `test/readme.test.js`

**Interfaces:**
- Consumes: V0.10 behavior from Tasks 1-3.
- Produces: README version, API table, CLI section, safety section, and testing coverage text.

- [ ] **Step 1: Write failing README tests**

Assert README mentions V0.10, restore dry-run CLI/API/Web Console, and the no-write/no-copy/no-overwrite boundary.

- [ ] **Step 2: Run RED**

Run: `npm test -- test/readme.test.js`

Expected: fail until README is updated.

- [ ] **Step 3: Update README**

Update version table, features, CLI commands, Web Console section, safety boundary, API table, testing coverage, and not-yet-implemented list.

- [ ] **Step 4: Full verification**

Run: `npm test`

Expected: all tests pass with zero failures.
