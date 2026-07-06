# Supervisor Install Command Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sanitized, non-runnable `installCommandPreview` to `agent.js supervisor-install-dry-run` while keeping supervisor installation blocked and dry-run-only.

**Architecture:** Extend the existing local-only `buildSupervisorInstallDryRunPlan(config)` output with one pure command preview helper. The preview is static, redacted, non-runnable, and excluded from `--readiness-summary` output.

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
- Do not output a real user home path, real config path, real plist path, real executable path, or real launchctl command with runnable arguments.
- Do not claim production supervisor, production readiness, Gold readiness, or managed daemon lifecycle.
- Keep `automation-installation` and `production-hardening` partial.
- Keep `real-nas-remote-backup` and overall Gold readiness blocked.

---

### Task 1: Install Command Preview Helper And CLI Output

**Files:**
- Modify: `test/agent-supervisor-install-dry-run.test.js`
- Modify: `src/agent.js`

**Interfaces:**
- Consumes: `buildSupervisorInstallDryRunPlan(config)`, `runSupervisorInstallDryRun(configPath)`
- Produces: `buildSupervisorInstallCommandPreview()` returning `{ mode, state, actions, safety }`
- Produces: `plan.installCommandPreview`

- [x] **Step 1: Write RED helper/full-output tests**

In `test/agent-supervisor-install-dry-run.test.js`, add:

```js
const EXPECTED_SUPERVISOR_INSTALL_COMMAND_PREVIEW = Object.freeze({
  mode: 'dry-run-only',
  state: 'blocked',
  actions: [
    {
      id: 'render-launch-agent-plist',
      description: 'Render a launch agent plist preview with redacted config path.',
      command: 'generate launchd plist preview',
      wouldRun: false,
      wouldWrite: false,
      sensitiveValuesReturned: false,
    },
    {
      id: 'write-launch-agent-plist',
      description: 'Future installer would write a launch agent plist to a user LaunchAgents location.',
      command: 'write launch agent plist to [redacted]',
      wouldRun: false,
      wouldWrite: false,
      sensitiveValuesReturned: false,
    },
    {
      id: 'load-launch-agent',
      description: 'Future installer would ask launchd to load the agent after explicit operator approval.',
      command: 'launchctl bootstrap gui/[redacted] [redacted]',
      wouldRun: false,
      wouldWrite: false,
      sensitiveValuesReturned: false,
    },
    {
      id: 'start-launch-agent',
      description: 'Future installer would start the launch agent after successful load.',
      command: 'launchctl kickstart gui/[redacted]/[redacted]',
      wouldRun: false,
      wouldWrite: false,
      sensitiveValuesReturned: false,
    },
  ],
  safety: {
    executableResolved: false,
    configPathResolved: false,
    plistPathResolved: false,
    launchctlCommandsRunnable: false,
    launchctlCalled: false,
    launchdFileWritten: false,
    metadataWritten: false,
  },
});
```

In the pure helper test:

```js
const buildSupervisorInstallCommandPreview = app.buildSupervisorInstallCommandPreview;
if (!buildSupervisorInstallCommandPreview) {
  throw new Error('buildSupervisorInstallCommandPreview is not defined in src/agent.js');
}
assert.deepStrictEqual(
  buildSupervisorInstallCommandPreview(),
  EXPECTED_SUPERVISOR_INSTALL_COMMAND_PREVIEW,
);
assert.deepStrictEqual(
  plan.installCommandPreview,
  EXPECTED_SUPERVISOR_INSTALL_COMMAND_PREVIEW,
);
```

Add a loop in the same test:

```js
for (const action of plan.installCommandPreview.actions) {
  assert.strictEqual(action.wouldRun, false);
  assert.strictEqual(action.wouldWrite, false);
  assert.strictEqual(action.sensitiveValuesReturned, false);
}
assert.deepStrictEqual(
  plan.installCommandPreview.actions.map((action) => action.id),
  [
    'render-launch-agent-plist',
    'write-launch-agent-plist',
    'load-launch-agent',
    'start-launch-agent',
  ],
);
```

- [x] **Step 2: Extend existing CLI tests**

In the existing “prints sanitized JSON” test, assert:

```js
assert.deepStrictEqual(
  body.installCommandPreview,
  EXPECTED_SUPERVISOR_INSTALL_COMMAND_PREVIEW,
);
assert.strictEqual(body.installCommandPreview.safety.launchctlCalled, false);
assert.strictEqual(body.installCommandPreview.safety.launchdFileWritten, false);
assert.strictEqual(body.installCommandPreview.safety.metadataWritten, false);
```

In the `--readiness-summary` test and combined summary/fail test, assert:

```js
assert.strictEqual(body.installCommandPreview, undefined);
```

In the `--fail-on-blocked` full-output test, assert:

```js
assert.deepStrictEqual(
  body.installCommandPreview,
  EXPECTED_SUPERVISOR_INSTALL_COMMAND_PREVIEW,
);
```

- [x] **Step 3: Verify RED**

Run:

```bash
node --test test/agent-supervisor-install-dry-run.test.js
```

Expected: FAIL because `buildSupervisorInstallCommandPreview` is not exported and full plan output lacks `installCommandPreview`.

Observed: RED failed with missing `buildSupervisorInstallCommandPreview` and missing `installCommandPreview` in full JSON while summary-only tests stayed green.

- [x] **Step 4: Implement minimal helper**

In `src/agent.js`, add:

```js
const SUPERVISOR_INSTALL_COMMAND_PREVIEW_ACTIONS = Object.freeze([
  Object.freeze({
    id: 'render-launch-agent-plist',
    description: 'Render a launch agent plist preview with redacted config path.',
    command: 'generate launchd plist preview',
  }),
  Object.freeze({
    id: 'write-launch-agent-plist',
    description: 'Future installer would write a launch agent plist to a user LaunchAgents location.',
    command: 'write launch agent plist to [redacted]',
  }),
  Object.freeze({
    id: 'load-launch-agent',
    description: 'Future installer would ask launchd to load the agent after explicit operator approval.',
    command: 'launchctl bootstrap gui/[redacted] [redacted]',
  }),
  Object.freeze({
    id: 'start-launch-agent',
    description: 'Future installer would start the launch agent after successful load.',
    command: 'launchctl kickstart gui/[redacted]/[redacted]',
  }),
]);
```

Add:

```js
export function buildSupervisorInstallCommandPreview() {
  return {
    mode: 'dry-run-only',
    state: 'blocked',
    actions: SUPERVISOR_INSTALL_COMMAND_PREVIEW_ACTIONS.map((action) => ({
      ...action,
      wouldRun: false,
      wouldWrite: false,
      sensitiveValuesReturned: false,
    })),
    safety: {
      executableResolved: false,
      configPathResolved: false,
      plistPathResolved: false,
      launchctlCommandsRunnable: false,
      launchctlCalled: false,
      launchdFileWritten: false,
      metadataWritten: false,
    },
  };
}
```

Add this field to `buildSupervisorInstallDryRunPlan(config)`:

```js
installCommandPreview: buildSupervisorInstallCommandPreview(),
```

- [x] **Step 5: Verify GREEN**

Run:

```bash
node --test test/agent-supervisor-install-dry-run.test.js
```

Expected: PASS.

Observed: `node --test test/agent-supervisor-install-dry-run.test.js` passed 9/9 after adding `buildSupervisorInstallCommandPreview` and full-plan `installCommandPreview`. During GREEN, the preview text was changed from an `authorization` phrase to `operator approval` to avoid matching existing sensitive-header leak guards.

### Task 2: Version, README, Gold Evidence

**Files:**
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `README.md`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**
- Consumes: `LINKE_RELEASE_VERSION`, `buildGoldReadinessReport()`, README current version contract
- Produces: V0.81 docs and tests while Gold remains blocked

- [x] **Step 1: Write/adjust RED docs tests**

Update tests to expect:

```js
assert.strictEqual(LINKE_RELEASE_VERSION, 'V0.81');
assert.strictEqual(report.version, 'V0.81');
```

In Gold evidence tests, require:

```js
assert.ok(automationEvidence.includes('src/agent.js buildSupervisorInstallCommandPreview'));
assert.ok(automationEvidence.includes('installCommandPreview.state:blocked'));
assert.ok(automationEvidence.includes('installCommandPreview.actions:wouldRun:false'));
assert.ok(hardeningEvidence.includes('src/agent.js buildSupervisorInstallCommandPreview'));
assert.ok(hardeningEvidence.includes('installCommandPreview.state:blocked'));
assert.ok(hardeningEvidence.includes('installCommandPreview.actions:wouldRun:false'));
```

In README tests, update the V0.80 section to V0.81 and require:

```js
assertReadmeContains(/# Linke V0\.81/, 'README title should mention V0.81');
assertReadmeContains(/\*\*当前版本：V0\.81\*\*/, 'README badge should mention V0.81');
assertReadmeContains(/\| V0\.80 \| 历史版本 \|[^|]*(readinessSummary|readiness-summary|fail-on-blocked|blocked)/i, 'V0.80 should be historical readiness gate milestone');
assertReadmeContains(/\| V0\.81 \| 当前版本 \|[^|]*(installCommandPreview|command preview|wouldRun:false|wouldWrite:false|blocked)/i, 'V0.81 should be current command preview milestone');
assertReadmeContains(/installCommandPreview/i, 'README should document installCommandPreview');
assertReadmeContains(/wouldRun:false|wouldWrite:false|non-runnable|不可执行/i, 'README should document non-runnable command preview');
assertReadmeContains(/buildSupervisorInstallCommandPreview|installCommandPreview\.state:blocked/i, 'README should document command preview coverage');
```

- [x] **Step 2: Verify RED**

Run:

```bash
node --test test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

Expected: FAIL until version/docs/Gold are updated.

Observed: RED failed for V0.81 version mismatch, missing Gold evidence, missing README V0.81 current row, and missing README `installCommandPreview` documentation.

- [x] **Step 3: Update implementation docs**

Set `src/version.js`:

```js
export const LINKE_RELEASE_VERSION = 'V0.81';
```

Add Gold evidence to both `automation-installation.evidence` and `production-hardening.evidence`:

```js
'src/agent.js buildSupervisorInstallCommandPreview',
'installCommandPreview.state:blocked',
'installCommandPreview.actions:wouldRun:false',
```

Update README:

- Title and badge to V0.81.
- Version table: V0.80 becomes historical; add V0.81 current row.
- Feature bullet for supervisor install dry-run mentions `installCommandPreview`.
- Supervisor install dry-run foundation documents command preview fields and safety.
- Gold sections mention V0.81 evidence while keeping partial/blocked status.
- Testing coverage includes `buildSupervisorInstallCommandPreview`, `installCommandPreview.state:blocked`, `wouldRun:false`, and `wouldWrite:false`.
- Not implemented section says current supervisor scope is status, install dry-run, blocked readiness gate, and non-runnable command preview only.

- [x] **Step 4: Verify GREEN**

Run:

```bash
node --test test/version.test.js test/gold-readiness.test.js test/readme.test.js test/agent-supervisor-install-dry-run.test.js
```

Expected: PASS.

Observed: `node --test test/version.test.js test/gold-readiness.test.js test/readme.test.js test/agent-supervisor-install-dry-run.test.js` passed 333/333 after V0.81 version, README, and Gold evidence updates.

### Task 3: Verification, External Review, Commit

**Files:**
- Modify: `docs/superpowers/plans/2026-07-06-supervisor-install-command-preview.md`

**Interfaces:**
- Consumes: all V0.81 changes
- Produces: final validation evidence and commit

- [x] **Step 1: Run full verification**

Run:

```bash
node --test --test-reporter=dot test/*.test.js
```

Expected: exit `0`.

Run:

```bash
git diff --check
```

Expected: exit `0`.

Run:

```bash
rg -n "production ready|Gold ready|real NAS remote backup ready|daemon installed|launchd installed|always-running|real installer implemented|production-ready supervisor|真实 NAS 备份已实现|生产可用" README.md src
```

Expected: no matches.

Observed:
- `node --test --test-reporter=dot test/*.test.js` exited 0.
- `git diff --check` exited 0.
- The overclaim scan returned no matches, which is expected for this `rg` command.

- [x] **Step 2: Run external checks**

Run Qwen read-only adversarial review of the uncommitted diff. Require an explicit `VERDICT: PASS` or `VERDICT: FAIL`.

Run ZAI final closure with a strict English evidence prompt. Require structured JSON with `verdict:"PASS"`, `accepted:true`, empty `blocking_findings`, `gold_status:"blocked"`.

Observed:
- Qwen read-only adversarial review returned `VERDICT: PASS`, `FINDINGS: none`, `TEST GAPS: none`, `CONFIDENCE: high`.
- ZAI was attempted three times with strict JSON-only prompts, but each response returned the fixed generic sentence `I understand, but I don't have a specific response.` and was not accepted as an effective closure verdict.
- PM decision after user-selected option 2: ZAI is downgraded to `verifier inconclusive` for this milestone and DeepSeek CLI is used as auxiliary closure verifier.
- DeepSeek first verifier attempt returned `INCONCLUSIVE` because the PM evidence summary was too coarse for behavioral acceptance.
- DeepSeek second verifier attempt used specific source/test evidence and returned structured JSON with `verdict:"PASS"`, `accepted:true`, no blocking findings, `gold_status:"blocked"`, `risk:"low"`, and no unverified items. PM accepts this as auxiliary closure evidence, with final fact judgment still based on local verification plus Qwen review.

- [x] **Step 3: Commit and push**

Commit message:

```bash
feat: add supervisor install command preview
```

Observed: committed and pushed `10cb9da feat: add supervisor install command preview` to `linke-v0.12-web-panel`.
