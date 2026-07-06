# Supervisor Install Dry-Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `agent.js supervisor-install-dry-run`, a sanitized local dry-run plan for future supervisor installation without touching launchd or system state.

**Architecture:** Reuse existing Agent CLI config loading and validation. Add one pure plan builder plus one CLI case that prints JSON only. Update version, Gold readiness evidence, README, and focused tests while keeping Gold blocked.

**Tech Stack:** Node.js ESM, `node:test`, existing `src/agent.js`, `src/config.js`, README/version/Gold readiness tests.

## Global Constraints

- Do not call `launchctl`.
- Do not read process lists.
- Do not write `~/Library/LaunchAgents`, plist files, metadata, config, device data, snapshots, or audit success events.
- Do not connect NAS, trigger backup/restore, or execute remote commands.
- Do not print config paths, source paths, server URLs, NAS endpoints, credential refs, token values, Authorization headers, or environment values.
- Keep `automation-installation` and `production-hardening` partial; keep Gold blocked.

---

### Task 1: Agent CLI Dry-Run Plan

**Files:**
- Create: `test/agent-supervisor-install-dry-run.test.js`
- Modify: `src/agent.js`

**Interfaces:**
- Consumes: `loadConfig(configPath)`, `validateConfig(raw)`, `LINKE_RELEASE_VERSION`
- Produces: `buildSupervisorInstallDryRunPlan(config)`, `runSupervisorInstallDryRun(configPath)`, CLI command `supervisor-install-dry-run`

- [x] **Step 1: Write RED tests**

Add tests that import `buildSupervisorInstallDryRunPlan` and execute `node src/agent.js supervisor-install-dry-run --config <path>`.

- [x] **Step 2: Verify RED**

Run: `node --test test/agent-supervisor-install-dry-run.test.js`

Expected: FAIL because `buildSupervisorInstallDryRunPlan` is not exported and the CLI command is unknown.

Observed: FAIL with missing `buildSupervisorInstallDryRunPlan`, unknown CLI command, and `--output` mismatch.

- [x] **Step 3: Implement minimal code**

Add `buildSupervisorInstallDryRunPlan(config)`, `runSupervisorInstallDryRun(configPath)`, usage text, and a CLI case. The JSON must set `wouldInstall:false`, `wouldStart:false`, `wouldCallLaunchctl:false`, `launchctlCalled:false`, `processListRead:false`, `supervisorInstalled:false`, `launchdFileWritten:false`, `metadataWritten:false`, `nasConnected:false`, `backupTriggered:false`, `restoreTriggered:false`, and `remoteCommandExecuted:false`.

- [x] **Step 4: Verify GREEN**

Run: `node --test test/agent-supervisor-install-dry-run.test.js`

Expected: PASS.

Observed: PASS, 3/3 tests.

### Task 2: Version, Gold, README Sync

**Files:**
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `README.md`
- Modify: `test/readme.test.js`
- Modify: `docs/superpowers/plans/2026-07-06-supervisor-install-dry-run.md`

**Interfaces:**
- Consumes: `buildSupervisorInstallDryRunPlan`, CLI command `agent.js supervisor-install-dry-run`
- Produces: V0.79 documentation, Gold evidence, and version consistency

- [x] **Step 1: Write/adjust RED docs tests**

Update tests to expect V0.79 current version, V0.78 historical, supervisor-install-dry-run docs, safety boundaries, and Gold partial evidence.

- [x] **Step 2: Verify RED or targeted mismatch**

Run: `node --test test/version.test.js test/gold-readiness.test.js test/readme.test.js`

Expected before docs sync: FAIL on version/docs/Gold mismatches.

Observed: FAIL on expected V0.79 version/docs/Gold/README mismatches before sync.

- [x] **Step 3: Update implementation docs**

Set `LINKE_RELEASE_VERSION` to `V0.79`, update README title/badge/version table/features/testing, add Gold evidence strings, and keep Gold blocked.

- [x] **Step 4: Verify GREEN**

Run: `node --test test/agent-supervisor-install-dry-run.test.js test/version.test.js test/gold-readiness.test.js test/readme.test.js`

Expected: PASS.

Observed: PASS, 327/327 targeted tests.

### Task 3: Full Verification and Review

**Files:**
- Modify: `docs/superpowers/plans/2026-07-06-supervisor-install-dry-run.md`

**Interfaces:**
- Consumes: all V0.79 code/docs changes
- Produces: final evidence, review notes, and commit

- [x] **Step 1: Run full tests**

Run: `node --test --test-reporter=dot test/*.test.js`

Expected: exit 0.

Observed: exit 0.

- [x] **Step 2: Run hygiene checks**

Run: `git diff --check`

Expected: exit 0.

Run: `rg -n "production ready|Gold ready|real NAS remote backup ready|daemon installed|launchd installed|always-running|真实 NAS 备份已实现|生产可用" README.md src`

Expected: no positive overclaim matches.

Observed: `git diff --check` exited 0. README/src overclaim scan returned no positive matches.

- [x] **Step 3: Run Qwen and ZAI checks**

Run a read-only Qwen adversarial review of the uncommitted diff. Run ZAI closure with strict English evidence prompt. Record valid final verdicts only.

Observed: Qwen first pass returned PASS with a config error sanitization test gap. The gap was fixed with missing-config and invalid-config tests plus a sanitized `runSupervisorInstallDryRun` error. Qwen second pass returned PASS with no findings. ZAI closure returned PASS with `BLOCKERS: None`.

- [x] **Step 4: Commit and push**

Commit message: `feat: add supervisor install dry run`
