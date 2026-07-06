# Supervisor Install Readiness Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--readiness-summary` and `--fail-on-blocked` to `agent.js supervisor-install-dry-run` while keeping supervisor installation blocked and dry-run-only.

**Architecture:** Extend the existing local-only supervisor install dry-run path. Add one pure readiness summary helper, include the summary in full plan output, and wire CLI flags without adding HTTP, child process, launchd, file-write, NAS, backup, restore, or remote-command behavior.

**Tech Stack:** Node.js ESM, `node:test`, existing `src/agent.js`, `src/version.js`, `src/gold-readiness.js`, README contract tests.

## Global Constraints

- Do not implement a real installer.
- Do not call `launchctl`.
- Do not read process lists.
- Do not install or start launchd jobs.
- Do not write `~/Library/LaunchAgents`, plist files, metadata, config, device data, snapshots, or audit success events.
- Do not connect NAS.
- Do not trigger backup, restore, or remote commands.
- Do not print config paths, source paths, server URLs, NAS endpoints, credential refs, token values, Authorization headers, or environment values.
- Keep `automation-installation` and `production-hardening` partial.
- Keep `real-nas-remote-backup` and overall Gold readiness blocked.

---

### Task 1: Supervisor Install Readiness Summary

**Files:**
- Modify: `test/agent-supervisor-install-dry-run.test.js`
- Modify: `src/agent.js`

**Interfaces:**
- Consumes: `buildSupervisorInstallDryRunPlan(config)`
- Produces: `buildSupervisorInstallReadinessSummary(plan)` returning `{ state, blockedCount, blockers, readyCount, checkedCount, failOnBlockedExitCode }`

- [x] **Step 1: Write RED helper and full-output tests**

Add tests that import `buildSupervisorInstallReadinessSummary`, assert the full plan includes `readinessSummary`, and verify the summary remains sanitized.

Expected summary:

```js
{
  state: 'blocked',
  blockedCount: 4,
  blockers: [
    'real-install-not-implemented',
    'launchd-install-blocked',
    'supervisor-start-blocked',
    'production-boundaries-incomplete',
  ],
  readyCount: 0,
  checkedCount: 4,
  failOnBlockedExitCode: 2,
}
```

- [x] **Step 2: Verify RED**

Run: `node --test test/agent-supervisor-install-dry-run.test.js`

Expected: FAIL because `buildSupervisorInstallReadinessSummary` is not exported and full plan output lacks `readinessSummary`.

Observed: RED failed as expected before implementation because the helper export, full-plan `readinessSummary`, and CLI flags were absent.

- [x] **Step 3: Implement minimal helper**

Add constants and helper in `src/agent.js`:

```js
const SUPERVISOR_INSTALL_READINESS_BLOCKERS = Object.freeze([
  'real-install-not-implemented',
  'launchd-install-blocked',
  'supervisor-start-blocked',
  'production-boundaries-incomplete',
]);

export function buildSupervisorInstallReadinessSummary() {
  return {
    state: 'blocked',
    blockedCount: SUPERVISOR_INSTALL_READINESS_BLOCKERS.length,
    blockers: SUPERVISOR_INSTALL_READINESS_BLOCKERS.slice(),
    readyCount: 0,
    checkedCount: SUPERVISOR_INSTALL_READINESS_BLOCKERS.length,
    failOnBlockedExitCode: 2,
  };
}
```

Add `readinessSummary: buildSupervisorInstallReadinessSummary()` to the full dry-run plan.

- [x] **Step 4: Verify GREEN**

Run: `node --test test/agent-supervisor-install-dry-run.test.js`

Expected: PASS for helper/full-output tests, with existing tests updated to include the new field.

Observed: `node --test test/agent-supervisor-install-dry-run.test.js` passed after adding `buildSupervisorInstallReadinessSummary` and full-plan `readinessSummary`.

### Task 2: CLI Readiness Flags

**Files:**
- Modify: `test/agent-supervisor-install-dry-run.test.js`
- Modify: `src/agent.js`

**Interfaces:**
- Consumes: `runSupervisorInstallDryRun(configPath)`, `plan.readinessSummary`
- Produces: CLI support for `--readiness-summary` and `--fail-on-blocked`

- [x] **Step 1: Write RED CLI tests**

Add tests for:

- `--readiness-summary` prints only summary JSON and exit code `0`.
- `--fail-on-blocked` prints full JSON and exits `2`.
- `--readiness-summary --fail-on-blocked` prints only summary JSON and exits `2`.
- `--readiness-summary yes` fails with `--readiness-summary does not accept a value`.
- `--fail-on-blocked yes` fails with `--fail-on-blocked does not accept a value`.
- `--output` remains rejected and creates no plist file.

- [x] **Step 2: Verify RED**

Run: `node --test test/agent-supervisor-install-dry-run.test.js`

Expected: FAIL because the supervisor CLI case does not yet handle the two flags.

Observed: RED failed as expected before CLI wiring because `--readiness-summary` and `--fail-on-blocked` were ignored for `supervisor-install-dry-run`.

- [x] **Step 3: Implement minimal CLI wiring**

In the `supervisor-install-dry-run` case:

```js
if (args['readiness-summary'] !== undefined && args['readiness-summary'] !== true) {
  throw new Error('--readiness-summary does not accept a value');
}
if (args['fail-on-blocked'] !== undefined && args['fail-on-blocked'] !== true) {
  throw new Error('--fail-on-blocked does not accept a value');
}
const result = await runSupervisorInstallDryRun(args.config);
const output = args['readiness-summary'] === true ? result.readinessSummary : result;
console.log(JSON.stringify(output, null, 2));
if (args['fail-on-blocked'] === true && result.readinessSummary.state === 'blocked') {
  process.exitCode = 2;
}
```

Also update usage text so `--readiness-summary` and `--fail-on-blocked` mention `supervisor-install-dry-run`.

- [x] **Step 4: Verify GREEN**

Run: `node --test test/agent-supervisor-install-dry-run.test.js`

Expected: PASS.

Observed: `node --test test/agent-supervisor-install-dry-run.test.js` passed with summary-only output, blocked exit code 2, combined flags, boolean flag validation, and `--output` rejection.

### Task 3: Version, README, Gold Evidence

**Files:**
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `README.md`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**
- Consumes: `LINKE_RELEASE_VERSION`, README current version contract, Gold readiness static item list
- Produces: V0.80 docs and tests while Gold remains blocked

- [x] **Step 1: Write/adjust RED docs tests**

Update tests to expect:

- `LINKE_RELEASE_VERSION === 'V0.80'`
- README title and badge say V0.80.
- Version table marks V0.79 historical and V0.80 current.
- README documents `supervisor-install-dry-run --readiness-summary` and `--fail-on-blocked`.
- README documents exit code `2`, `readinessSummary.state:"blocked"`, no sensitive values, no install/start/launchctl/plist/write/NAS/backup/restore/remote command.
- Gold evidence includes `buildSupervisorInstallReadinessSummary` and `--fail-on-blocked`; Gold remains blocked.

- [x] **Step 2: Verify RED**

Run: `node --test test/version.test.js test/gold-readiness.test.js test/readme.test.js`

Expected: FAIL until version/docs/Gold are updated.

Observed: RED failed before implementation for V0.80 version mismatch, missing README V0.80 current row, and missing Gold evidence.

- [x] **Step 3: Update implementation docs**

Set `src/version.js` to V0.80. Update README current version text, version table, Agent CLI examples, supervisor install dry-run section, Gold blocker notes, testing coverage, and not-implemented boundary. Update Gold readiness evidence and next steps while keeping item statuses unchanged.

- [x] **Step 4: Verify GREEN**

Run: `node --test test/version.test.js test/gold-readiness.test.js test/readme.test.js test/agent-supervisor-install-dry-run.test.js`

Expected: PASS.

Observed: `node --test test/version.test.js test/gold-readiness.test.js test/readme.test.js test/agent-supervisor-install-dry-run.test.js` passed with 333 tests after V0.80 version, README, and Gold evidence updates.

### Task 4: Verification, Review, Commit

**Files:**
- Modify: `docs/superpowers/plans/2026-07-06-supervisor-install-readiness-gate.md`

**Interfaces:**
- Consumes: all V0.80 changes
- Produces: final validation evidence and commit

- [x] **Step 1: Run full verification**

Run: `node --test --test-reporter=dot test/*.test.js`

Expected: exit `0`.

Run: `git diff --check`

Expected: exit `0`.

Run: `rg -n "production ready|Gold ready|real NAS remote backup ready|daemon installed|launchd installed|always-running|真实 NAS 备份已实现|生产可用" README.md src`

Expected: no matches.

Observed:
- `node --test --test-reporter=dot test/*.test.js` exited 0.
- `git diff --check` exited 0.
- The overclaim scan returned no matches, which is expected for this `rg` command.

- [x] **Step 2: Run external checks**

Run Qwen read-only adversarial review of the uncommitted diff. Run ZAI final closure with strict English evidence prompt. Accept only explicit structured PASS/FAIL verdicts.

Observed:
- Qwen read-only adversarial re-review returned `VERDICT: PASS`, `FINDINGS: none`, `TEST GAPS: none`, `CONFIDENCE: high`.
- ZAI closure returned structured JSON content with `verdict:"PASS"`, `accepted:true`, no blocking findings, `gold_status:"blocked"`, and `confidence:"high"`.

- [x] **Step 3: Commit and push**

Commit message: `feat: add supervisor install readiness gate`

Observed: committed and pushed `1c654a0 feat: add supervisor install readiness gate` to `linke-v0.12-web-panel`.
