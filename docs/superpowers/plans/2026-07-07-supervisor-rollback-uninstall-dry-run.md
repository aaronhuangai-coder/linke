# Supervisor Rollback Uninstall Dry-Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sanitized, blocked `rollbackUninstallPlan` to the full supervisor install dry-run JSON while keeping rollback, uninstall, recovery, installation, launchd lifecycle, NAS, backup, restore, and Gold readiness blocked.

**Architecture:** Extend `src/agent.js` with one pure static helper, `buildSupervisorRollbackUninstallPlan()`, and include its output only in the full `buildSupervisorInstallDryRunPlan(config)` response. Keep summary-only output unchanged. Update release docs, version, and Gold readiness evidence after the schema is tested.

**Tech Stack:** Node.js ESM, `node:test`, existing Linke Agent CLI, existing README/version/Gold readiness tests.

## Global Constraints

- V0.85 must not add `--rollback`, `--uninstall`, `--stop`, `--unload`, `--remove`, `--recover`, `--approve-install`, `--install`, `--start`, or any mutating supervisor command.
- V0.85 must not write config, metadata, LaunchAgents, plist files, rollback manifests, approval records, reports, audit success records, snapshots, device records, NAS data, or recovery state.
- V0.85 must not call `launchctl`, read process lists, inspect installed launch agents, check whether a plist exists, restore a previous plist, stop/unload/uninstall/remove/reinstall/start launchd jobs, connect NAS, trigger backup/restore, run remote copy, or execute remote commands.
- V0.85 must not print config paths, source paths, server URLs, NAS endpoints, credential refs, token values, Authorization headers, environment values, home paths, plist paths, executable paths, previous plist paths, approval identity, approval timestamps, hostnames, usernames, process ids, or runnable command arguments.
- `rollbackUninstallPlan` is full-output-only and must be excluded from `--readiness-summary`.
- `--fail-on-blocked` full JSON includes `rollbackUninstallPlan`; `--readiness-summary --fail-on-blocked` excludes it.
- Existing top-level `safety`, `installApprovalManifest`, `installPreflight`, `installCommandPreview`, and readiness summary contracts remain unchanged.
- `installApprovalManifest.rollback.available:false` remains unchanged.
- `rollbackUninstallPlan.actions` is stable and id-addressed; consumers must use `action.id`, not array index.
- Gold remains blocked.

---

## File Structure

- `src/agent.js`
  - Add `SUPERVISOR_ROLLBACK_UNINSTALL_ACTIONS`.
  - Export `buildSupervisorRollbackUninstallPlan()`.
  - Include `rollbackUninstallPlan` in full `buildSupervisorInstallDryRunPlan(config)` output.
- `test/agent-supervisor-install-dry-run.test.js`
  - Add the expected fixture and evidence leak guard.
  - Assert the helper, full plan output, CLI full output, summary exclusion, and fail-on-blocked behavior.
- `src/version.js`
  - Bump `LINKE_RELEASE_VERSION` to `V0.85`.
- `src/gold-readiness.js`
  - Add V0.85 evidence to `automation-installation` and `production-hardening`.
  - Keep those statuses `partial` and `real-nas-remote-backup` `blocked`.
- `README.md`
  - Mark V0.85 current and V0.84 historical.
  - Document `rollbackUninstallPlan` safety boundaries and Gold blocked status.
- `test/version.test.js`
  - Expect `V0.85`.
- `test/gold-readiness.test.js`
  - Expect `V0.85` and new evidence.
- `test/readme.test.js`
  - Expect README current version and `rollbackUninstallPlan` documentation.

---

### Task 1: Add Supervisor Rollback Uninstall Dry-Run Schema

**Files:**
- Modify: `src/agent.js`
- Modify: `test/agent-supervisor-install-dry-run.test.js`

**Interfaces:**
- Consumes: `buildSupervisorInstallDryRunPlan(config)`, `buildSupervisorInstallReadinessSummary()`, `runSupervisorInstallDryRun(configPath)`.
- Produces: `buildSupervisorRollbackUninstallPlan(): object` and full-plan field `rollbackUninstallPlan`.

- [ ] **Step 1: Add failing fixture and helper tests**

In `test/agent-supervisor-install-dry-run.test.js`, add this fixture after `EXPECTED_SUPERVISOR_INSTALL_APPROVAL_MANIFEST`:

```js
const EXPECTED_SUPERVISOR_ROLLBACK_UNINSTALL_PLAN = Object.freeze({
  mode: 'dry-run-only',
  state: 'blocked',
  rollback: {
    requiredBeforeInstall: true,
    available: false,
    previousPlistAvailable: false,
    wouldRestorePreviousPlist: false,
    wouldRestartPreviousSupervisor: false,
    blockerCode: 'rollback-not-implemented',
    evidence: 'Rollback state capture, previous plist restore, and supervisor restart are not implemented.',
  },
  uninstall: {
    requiredBeforeInstall: true,
    available: false,
    wouldUnloadLaunchAgent: false,
    wouldRemoveLaunchAgent: false,
    wouldRemoveMetadata: false,
    blockerCode: 'uninstall-not-implemented',
    evidence: 'Launch agent unload, plist removal, and supervisor metadata removal are not implemented.',
  },
  recovery: {
    requiredBeforeInstall: true,
    available: false,
    supervisorAvailable: false,
    wouldStartRecoverySupervisor: false,
    blockerCode: 'recovery-supervisor-not-implemented',
    evidence: 'Recovery supervisor lifecycle is not implemented.',
  },
  actions: [
    {
      id: 'capture-current-state',
      kind: 'rollback',
      status: 'blocked',
      wouldRun: false,
      wouldWrite: false,
      blockerCode: 'rollback-state-capture-missing',
      evidence: 'Current supervisor state capture is not implemented.',
    },
    {
      id: 'unload-launch-agent',
      kind: 'uninstall',
      status: 'blocked',
      wouldRun: false,
      wouldWrite: false,
      blockerCode: 'launchd-unload-blocked',
      evidence: 'Launch agent unload behavior is not implemented.',
    },
    {
      id: 'remove-launch-agent-plist',
      kind: 'uninstall',
      status: 'blocked',
      wouldRun: false,
      wouldWrite: false,
      blockerCode: 'launchd-remove-blocked',
      evidence: 'Launch agent plist removal is not implemented.',
    },
    {
      id: 'restore-previous-plist',
      kind: 'rollback',
      status: 'blocked',
      wouldRun: false,
      wouldWrite: false,
      blockerCode: 'previous-plist-unavailable',
      evidence: 'Previous plist restore data is not captured.',
    },
    {
      id: 'start-recovery-supervisor',
      kind: 'recovery',
      status: 'blocked',
      wouldRun: false,
      wouldWrite: false,
      blockerCode: 'recovery-supervisor-missing',
      evidence: 'Recovery supervisor start behavior is not implemented.',
    },
  ],
  safety: {
    dryRun: true,
    planOnly: true,
    rollbackExecuted: false,
    uninstallExecuted: false,
    recoverySupervisorStarted: false,
    launchctlCalled: false,
    processListRead: false,
    filesystemWritten: false,
    metadataWritten: false,
    supervisorInstalled: false,
    supervisorStarted: false,
    launchdFileWritten: false,
    launchdFileRemoved: false,
    previousPlistRestored: false,
    nasConnected: false,
    backupTriggered: false,
    restoreTriggered: false,
    remoteCommandExecuted: false,
    sensitiveValuesReturned: false,
  },
});
```

Add this helper after `assertNoSensitiveApprovalManifestEvidence(manifest)`:

```js
function assertNoSensitiveRollbackUninstallEvidence(plan) {
  const evidenceValues = [
    plan.rollback.evidence,
    plan.uninstall.evidence,
    plan.recovery.evidence,
    ...plan.actions.map((action) => action.evidence),
  ];

  for (const evidence of evidenceValues) {
    assert.strictEqual(typeof evidence, 'string');
    assert.doesNotMatch(evidence, /\/Users\/|\/private\/|~\/|https?:\/\//i);
    assert.doesNotMatch(evidence, /token|bearer|authorization|credentialRef|secret-ref|nas\.local/i);
    assert.doesNotMatch(evidence, /config\.json|LaunchAgents|\.plist/i);
    assert.doesNotMatch(evidence, /approver|timestamp|hostname|username|process|pid/i);
    assert.doesNotMatch(evidence, /launchctl\s|rm\s|mv\s|cp\s|unlink\s/i);
  }
}
```

Inside the first test, after the existing `buildSupervisorInstallApprovalManifest` existence check, add:

```js
const buildSupervisorRollbackUninstallPlan = app.buildSupervisorRollbackUninstallPlan;
if (!buildSupervisorRollbackUninstallPlan) {
  throw new Error('buildSupervisorRollbackUninstallPlan is not defined in src/agent.js');
}
```

Inside the first test, after the existing `installApprovalManifest` assertions, add:

```js
assert.deepStrictEqual(
  buildSupervisorRollbackUninstallPlan(),
  EXPECTED_SUPERVISOR_ROLLBACK_UNINSTALL_PLAN,
);
assert.deepStrictEqual(
  plan.rollbackUninstallPlan,
  EXPECTED_SUPERVISOR_ROLLBACK_UNINSTALL_PLAN,
);
assert.strictEqual(plan.rollbackUninstallPlan.rollback.available, false);
assert.strictEqual(plan.rollbackUninstallPlan.uninstall.available, false);
assert.strictEqual(plan.rollbackUninstallPlan.recovery.available, false);
assert.deepStrictEqual(
  plan.rollbackUninstallPlan.actions.map((action) => action.id),
  [
    'capture-current-state',
    'unload-launch-agent',
    'remove-launch-agent-plist',
    'restore-previous-plist',
    'start-recovery-supervisor',
  ],
);
for (const action of plan.rollbackUninstallPlan.actions) {
  assert.strictEqual(action.status, 'blocked');
  assert.strictEqual(action.wouldRun, false);
  assert.strictEqual(action.wouldWrite, false);
  assert.strictEqual(typeof action.blockerCode, 'string');
  assert.ok(action.blockerCode.length > 0);
}
assert.deepStrictEqual(plan.rollbackUninstallPlan.safety, EXPECTED_SUPERVISOR_ROLLBACK_UNINSTALL_PLAN.safety);
assertNoSensitiveRollbackUninstallEvidence(plan.rollbackUninstallPlan);
```

Add the new field to the repeated safety/fixture checks in the CLI full-output tests:

```js
assert.deepStrictEqual(
  body.rollbackUninstallPlan,
  EXPECTED_SUPERVISOR_ROLLBACK_UNINSTALL_PLAN,
);
assert.strictEqual(body.rollbackUninstallPlan.safety.dryRun, true);
assert.strictEqual(body.rollbackUninstallPlan.safety.planOnly, true);
assert.strictEqual(body.rollbackUninstallPlan.safety.rollbackExecuted, false);
assert.strictEqual(body.rollbackUninstallPlan.safety.uninstallExecuted, false);
assert.strictEqual(body.rollbackUninstallPlan.safety.recoverySupervisorStarted, false);
assert.strictEqual(body.rollbackUninstallPlan.safety.launchctlCalled, false);
assert.strictEqual(body.rollbackUninstallPlan.safety.processListRead, false);
assert.strictEqual(body.rollbackUninstallPlan.safety.filesystemWritten, false);
assert.strictEqual(body.rollbackUninstallPlan.safety.metadataWritten, false);
assert.strictEqual(body.rollbackUninstallPlan.safety.supervisorInstalled, false);
assert.strictEqual(body.rollbackUninstallPlan.safety.supervisorStarted, false);
assert.strictEqual(body.rollbackUninstallPlan.safety.launchdFileWritten, false);
assert.strictEqual(body.rollbackUninstallPlan.safety.launchdFileRemoved, false);
assert.strictEqual(body.rollbackUninstallPlan.safety.previousPlistRestored, false);
assert.strictEqual(body.rollbackUninstallPlan.safety.nasConnected, false);
assert.strictEqual(body.rollbackUninstallPlan.safety.backupTriggered, false);
assert.strictEqual(body.rollbackUninstallPlan.safety.restoreTriggered, false);
assert.strictEqual(body.rollbackUninstallPlan.safety.remoteCommandExecuted, false);
assert.strictEqual(body.rollbackUninstallPlan.safety.sensitiveValuesReturned, false);
assertNoSensitiveRollbackUninstallEvidence(body.rollbackUninstallPlan);
```

In each summary-only assertion block, add:

```js
assert.strictEqual(body.rollbackUninstallPlan, undefined);
```

In the full `--fail-on-blocked` assertion block, add:

```js
assert.deepStrictEqual(
  body.rollbackUninstallPlan,
  EXPECTED_SUPERVISOR_ROLLBACK_UNINSTALL_PLAN,
);
assertNoSensitiveRollbackUninstallEvidence(body.rollbackUninstallPlan);
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --test --test-reporter=dot test/agent-supervisor-install-dry-run.test.js
```

Expected: FAIL because `buildSupervisorRollbackUninstallPlan` is not defined and `rollbackUninstallPlan` is missing.

- [ ] **Step 3: Implement the pure helper**

In `src/agent.js`, add this constant after `SUPERVISOR_INSTALL_APPROVAL_MANIFEST_CONTROLS`:

```js
const SUPERVISOR_ROLLBACK_UNINSTALL_ACTIONS = Object.freeze([
  Object.freeze({
    id: 'capture-current-state',
    kind: 'rollback',
    blockerCode: 'rollback-state-capture-missing',
    evidence: 'Current supervisor state capture is not implemented.',
  }),
  Object.freeze({
    id: 'unload-launch-agent',
    kind: 'uninstall',
    blockerCode: 'launchd-unload-blocked',
    evidence: 'Launch agent unload behavior is not implemented.',
  }),
  Object.freeze({
    id: 'remove-launch-agent-plist',
    kind: 'uninstall',
    blockerCode: 'launchd-remove-blocked',
    evidence: 'Launch agent plist removal is not implemented.',
  }),
  Object.freeze({
    id: 'restore-previous-plist',
    kind: 'rollback',
    blockerCode: 'previous-plist-unavailable',
    evidence: 'Previous plist restore data is not captured.',
  }),
  Object.freeze({
    id: 'start-recovery-supervisor',
    kind: 'recovery',
    blockerCode: 'recovery-supervisor-missing',
    evidence: 'Recovery supervisor start behavior is not implemented.',
  }),
]);
```

In `buildSupervisorInstallDryRunPlan(config)`, add `rollbackUninstallPlan` immediately after `installApprovalManifest`:

```js
rollbackUninstallPlan: buildSupervisorRollbackUninstallPlan(),
```

Add this exported helper immediately after `buildSupervisorInstallApprovalManifest()`:

```js
export function buildSupervisorRollbackUninstallPlan() {
  return {
    mode: 'dry-run-only',
    state: 'blocked',
    rollback: {
      requiredBeforeInstall: true,
      available: false,
      previousPlistAvailable: false,
      wouldRestorePreviousPlist: false,
      wouldRestartPreviousSupervisor: false,
      blockerCode: 'rollback-not-implemented',
      evidence: 'Rollback state capture, previous plist restore, and supervisor restart are not implemented.',
    },
    uninstall: {
      requiredBeforeInstall: true,
      available: false,
      wouldUnloadLaunchAgent: false,
      wouldRemoveLaunchAgent: false,
      wouldRemoveMetadata: false,
      blockerCode: 'uninstall-not-implemented',
      evidence: 'Launch agent unload, plist removal, and supervisor metadata removal are not implemented.',
    },
    recovery: {
      requiredBeforeInstall: true,
      available: false,
      supervisorAvailable: false,
      wouldStartRecoverySupervisor: false,
      blockerCode: 'recovery-supervisor-not-implemented',
      evidence: 'Recovery supervisor lifecycle is not implemented.',
    },
    actions: SUPERVISOR_ROLLBACK_UNINSTALL_ACTIONS.map((action) => ({
      ...action,
      status: 'blocked',
      wouldRun: false,
      wouldWrite: false,
    })),
    safety: {
      dryRun: true,
      planOnly: true,
      rollbackExecuted: false,
      uninstallExecuted: false,
      recoverySupervisorStarted: false,
      launchctlCalled: false,
      processListRead: false,
      filesystemWritten: false,
      metadataWritten: false,
      supervisorInstalled: false,
      supervisorStarted: false,
      launchdFileWritten: false,
      launchdFileRemoved: false,
      previousPlistRestored: false,
      nasConnected: false,
      backupTriggered: false,
      restoreTriggered: false,
      remoteCommandExecuted: false,
      sensitiveValuesReturned: false,
    },
  };
}
```

- [ ] **Step 4: Run GREEN**

Run:

```bash
node --test --test-reporter=dot test/agent-supervisor-install-dry-run.test.js
```

Expected: PASS.

- [ ] **Step 5: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output, exit 0.

- [ ] **Step 6: Commit Task 1**

Run:

```bash
git add src/agent.js test/agent-supervisor-install-dry-run.test.js
git commit -m "feat: add supervisor rollback uninstall dry-run plan"
```

---

### Task 2: Document V0.85 and Keep Gold Blocked

**Files:**
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `README.md`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**
- Consumes: `LINKE_RELEASE_VERSION`, `buildGoldReadinessReport()`, README current-version conventions.
- Produces: V0.85 release metadata and Gold evidence that references `buildSupervisorRollbackUninstallPlan` without changing readiness to ready.

- [ ] **Step 1: Update failing tests first**

In `test/version.test.js`, change:

```js
it('LINKE_RELEASE_VERSION is the V0.84 milestone', () => {
  assert.strictEqual(LINKE_RELEASE_VERSION, 'V0.84');
});
```

to:

```js
it('LINKE_RELEASE_VERSION is the V0.85 milestone', () => {
  assert.strictEqual(LINKE_RELEASE_VERSION, 'V0.85');
});
```

In `test/gold-readiness.test.js`, change the two V0.84 version tests to V0.85:

```js
it('expects LINKE_RELEASE_VERSION to be V0.85', () => {
  assert.strictEqual(LINKE_RELEASE_VERSION, 'V0.85');
});

it('expects report.version to be V0.85', () => {
  const report = buildGoldReadinessReport({ now: new Date("2026-07-07T12:00:00.000Z") });
  assert.strictEqual(report.version, 'V0.85');
});
```

In the automation evidence test, add:

```js
assert.ok(automationEvidence.includes('src/agent.js buildSupervisorRollbackUninstallPlan'));
assert.ok(automationEvidence.includes('rollbackUninstallPlan.state:blocked'));
assert.ok(automationEvidence.includes('rollbackUninstallPlan.actions:wouldRun:false'));
assert.ok(automationItem.nextStep.includes('V0.85'));
assert.ok(automationItem.nextStep.includes('rollbackUninstallPlan'));
```

Replace the older `automationItem.nextStep.includes('V0.84')` assertion with the V0.85 assertion above.

In the production hardening evidence test, add:

```js
assert.ok(hardeningEvidence.includes('src/agent.js buildSupervisorRollbackUninstallPlan'));
assert.ok(hardeningEvidence.includes('rollbackUninstallPlan.state:blocked'));
assert.ok(hardeningEvidence.includes('rollbackUninstallPlan.actions:wouldRun:false'));
assert.ok(hardeningItem.nextStep.includes('V0.85'));
assert.ok(hardeningItem.nextStep.includes('rollbackUninstallPlan'));
```

Replace the older `hardeningItem.nextStep.includes('V0.84')` assertion with the V0.85 assertion above.

In `test/readme.test.js`, replace the existing `describe('README — V0.84 Supervisor install Web panel', ...)` block instead of adding a second current-version block. The old V0.84 title, badge, and `当前版本` positive assertions must not remain after this edit. The replacement block must keep V0.84 as historical evidence and make V0.85 the only current supervisor lifecycle milestone:

```js
describe('README — V0.85 Supervisor rollback uninstall dry-run', () => {
  it('title and badge claim V0.85 as current', () => {
    assertReadmeContains(/# Linke V0\.85/, 'README title should mention V0.85');
    assertReadmeContains(/\*\*当前版本：V0\.85\*\*/, 'README badge should mention V0.85');
    assertReadmeDoesNotContain(/^# Linke V0\.84/m, 'README title must not still claim V0.84');
    assertReadmeDoesNotContain(/\*\*当前版本：V0\.84\*\*/, 'README badge must not still claim V0.84');
  });

  it('version table marks V0.84 historical and V0.85 current', () => {
    assertReadmeContains(/\| V0\.84 \| 历史版本 \|[^|]*(supervisor-install-dry-run-panel|POST `?\/api\/supervisor-install-dry-run`?|buildSupervisorInstallDryRunViewModel|blocked)/i, 'V0.84 should become historical Web panel milestone');
    assertReadmeContains(/\| V0\.85 \| 当前版本 \|[^|]*(rollbackUninstallPlan|rollback|uninstall|blocked)/i, 'V0.85 should be current rollback uninstall dry-run milestone');
    assertReadmeDoesNotContain(/\| V0\.84 \| 当前版本 \|/i, 'V0.84 must not remain marked as current');
  });

  it('documents rollbackUninstallPlan as full-output only and dry-run-only', () => {
    assertReadmeContains(/rollbackUninstallPlan\.state:"blocked"/, 'README should document blocked rollback uninstall plan state');
    assertReadmeContains(/buildSupervisorRollbackUninstallPlan/, 'README should document rollback uninstall plan helper');
    assertReadmeContains(/rollbackUninstallPlan\.actions:wouldRun:false/, 'README should document non-runnable rollback uninstall actions');
    assertReadmeContains(/--readiness-summary[^\\n]*(不输出|excludes)[^\\n]*rollbackUninstallPlan/i, 'README should say readiness summary excludes rollbackUninstallPlan');
    assertReadmeContains(/不执行 rollback|不执行.*rollback|does not.*rollback/i, 'README should say rollback is not executed');
    assertReadmeContains(/不执行 uninstall|不执行.*uninstall|does not.*uninstall/i, 'README should say uninstall is not executed');
  });

  it('keeps Gold blocked and rejects lifecycle overclaims for V0.85', () => {
    assertReadmeContains(/Gold (依旧|仍然|remains) blocked/i, 'README should keep Gold blocked');
    assertReadmeContains(/真实 installer|real installer/i, 'README should still call out missing real installer');
    assertReadmeContains(/rollback[\s\S]*uninstall[\s\S]*recovery supervisor/i, 'README should call out missing lifecycle capabilities');
    assertReadmeDoesNotContain(/Gold ready|Gold 发布 ready|生产可用 supervisor|rollback ready|uninstall ready/i, 'README must not overclaim Gold or lifecycle readiness');
  });

  it('keeps later Gold readiness sections synced to V0.85 rollback uninstall evidence', () => {
    assertReadmeContains(/Agent CLI[\s\S]*?V0\.85[\s\S]*?rollbackUninstallPlan/i, 'README Agent CLI Gold section should mention V0.85 rollbackUninstallPlan');
    assertReadmeContains(/Gold blockers[\s\S]*?V0\.85[\s\S]*?buildSupervisorRollbackUninstallPlan[\s\S]*?rollbackUninstallPlan\.state:blocked/i, 'README Gold blockers section should mention V0.85 rollback uninstall evidence');
    assertReadmeContains(/NAS、认证和生产硬化仍是 partial[\s\S]*?V0\.85[\s\S]*?rollbackUninstallPlan\.actions:wouldRun:false/i, 'README partial hardening section should mention V0.85 rollback uninstall evidence');
  });
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --test --test-reporter=dot test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

Expected: FAIL because source/docs still say V0.84 and do not mention `rollbackUninstallPlan`.

- [ ] **Step 3: Update source metadata**

In `src/version.js`, change:

```js
export const LINKE_RELEASE_VERSION = 'V0.84';
```

to:

```js
export const LINKE_RELEASE_VERSION = 'V0.85';
```

In `src/gold-readiness.js`, add these evidence strings to both `automation-installation` and `production-hardening`:

```js
'src/agent.js buildSupervisorRollbackUninstallPlan',
'rollbackUninstallPlan.state:blocked',
'rollbackUninstallPlan.actions:wouldRun:false',
```

Update `automation-installation.nextStep` to mention:

```text
V0.85 adds a blocked rollbackUninstallPlan on top of the V0.84 supervisor install Web dry-run panel, while supervisor install, rollback, uninstall, and recovery supervisor remain blocked and not_configured; add real installer, launchd install/start, watchdog, monitoring, approval persistence, rollback, uninstall, recovery supervisor, secret management, and managed daemon lifecycle only after production boundaries are designed.
```

Update `production-hardening.nextStep` to mention:

```text
Recent releases add read-only Agent/Web visibility, supervisor-status not_configured reporting, supervisor install dry-run planning, supervisor install readiness gating, non-runnable install command preview, blocked install preflight checks, a dry-run approval/rollback manifest, the V0.84 supervisor install Web dry-run panel, and the V0.85 blocked rollbackUninstallPlan; still add deployment hardening, audit rotation, tamper-proof audit storage, distributed rate limiting, secret management, monitoring, approval persistence, rollback, uninstall, and recovery supervisor.
```

- [ ] **Step 4: Update README**

Update the README title and badge:

```md
# Linke V0.85

> **当前版本：V0.85** — 单机 localhost 原型阶段，新增 full JSON `rollbackUninstallPlan`，用于把 supervisor rollback、uninstall 与 recovery supervisor 生命周期继续固定为 sanitized blocked dry-run 计划；固定 `readinessSummary.state:"blocked"`、`installApprovalManifest.approval.approved:false`、`installApprovalManifest.rollback.available:false`、`rollbackUninstallPlan.state:"blocked"` 与 `rollbackUninstallPlan.actions:wouldRun:false`，不调用 launchctl、不读取进程列表、不安装、不启动、不回滚、不卸载、不写 metadata、不连接 NAS、不触发备份/恢复、不执行远程命令，Gold 依旧 blocked
```

Update the version table so V0.84 is historical and V0.85 is current:

```md
| V0.84 | 历史版本 | Supervisor install Web dry-run panel：新增 Web Console `supervisor-install-dry-run-panel` 与 dry-run-only `POST /api/supervisor-install-dry-run`，复用 `buildSupervisorInstallDryRunPlan` 展示 allowlisted blocked 安装计划、command preview、preflight、approval manifest 与 safety flags；不自动请求、不自动轮询、不读取 config path、不调用 CLI、不调用 launchctl、不读取进程列表、不安装、不启动、不写 LaunchAgents/plist/metadata、不连接 NAS、不触发备份/恢复、不执行远程命令、不回显 serverUrl、sourcePath、NAS endpoint、credentialRef、token、Authorization、approval identity、timestamp、plist path、executable path 或 runnable command，Gold 依旧 blocked |
| V0.85 | 当前版本 | Supervisor rollback uninstall dry-run plan：`agent.js supervisor-install-dry-run` full JSON 增加 sanitized `rollbackUninstallPlan`，固定 `state:"blocked"`，rollback、uninstall 与 recovery 均 `available:false`，所有 action 均 `wouldRun:false`、`wouldWrite:false`；`--readiness-summary` 不输出 rollbackUninstallPlan；不调用 launchctl、不读取进程列表、不安装、不启动、不回滚、不卸载、不删除 launchd 文件、不恢复 previous plist、不写 metadata、不连接 NAS、不触发备份/恢复、不执行远程命令、不回显 config path、sourcePath、serverUrl、NAS endpoint、credentialRef、token、Authorization、approval identity、timestamp、hostname、username、process id、plist path、executable path 或 runnable command，Gold 依旧 blocked |
```

In the supervisor install CLI section, add a V0.85 sentence:

```md
V0.85 在 full JSON 中增加 sanitized `rollbackUninstallPlan`，用于细化 rollback、uninstall 与 recovery supervisor 生命周期 blocker；该 plan 固定 `state:"blocked"`，rollback/uninstall/recovery 均不可用，所有 action 均 `wouldRun:false` 与 `wouldWrite:false`，且 `--readiness-summary` 不输出该字段。
```

Add a bullet near the existing `installApprovalManifest` bullet:

```md
- **rollbackUninstallPlan 字段**：由 `buildSupervisorRollbackUninstallPlan` 构造，只出现在完整 dry-run JSON 中，`--readiness-summary` 不输出该字段；当前固定返回 `state:"blocked"`，rollback、uninstall 与 recovery 均 `available:false`，action 包括 `capture-current-state`、`unload-launch-agent`、`remove-launch-agent-plist`、`restore-previous-plist` 与 `start-recovery-supervisor`；所有 action 都固定 `status:"blocked"`、`wouldRun:false`、`wouldWrite:false` 与稳定 `blockerCode`；plan safety 固定 `dryRun:true`、`planOnly:true`、`rollbackExecuted:false`、`uninstallExecuted:false`、`recoverySupervisorStarted:false`、`launchctlCalled:false`、`processListRead:false`、`filesystemWritten:false`、`metadataWritten:false`、`supervisorInstalled:false`、`supervisorStarted:false`、`launchdFileWritten:false`、`launchdFileRemoved:false`、`previousPlistRestored:false`、`nasConnected:false`、`backupTriggered:false`、`restoreTriggered:false`、`remoteCommandExecuted:false` 与 `sensitiveValuesReturned:false`。
```

Update Gold readiness paragraphs to include `buildSupervisorRollbackUninstallPlan`, `rollbackUninstallPlan.state:blocked`, and `rollbackUninstallPlan.actions:wouldRun:false`, while keeping Gold blocked.

- [ ] **Step 5: Run focused GREEN**

Run:

```bash
node --test --test-reporter=dot test/version.test.js test/gold-readiness.test.js test/readme.test.js test/agent-supervisor-install-dry-run.test.js
```

Expected: PASS.

- [ ] **Step 6: Run full test suite and diff check**

Run:

```bash
node --test --test-reporter=dot test/*.test.js
git diff --check
```

Expected: both pass.

- [ ] **Step 7: Commit Task 2**

Run:

```bash
git add README.md src/version.js src/gold-readiness.js test/version.test.js test/gold-readiness.test.js test/readme.test.js
git commit -m "docs: document supervisor rollback uninstall dry-run"
```

---

## Final Verification

After both tasks:

- Run `node --test --test-reporter=dot test/*.test.js`.
- Run `git diff --check`.
- Run a safety scan:

```bash
rg -n "rollback ready|uninstall ready|Gold ready|launchctl (bootstrap|bootout|kickstart|remove)|processListRead: true|rollbackExecuted: true|uninstallExecuted: true|recoverySupervisorStarted: true|filesystemWritten: true|metadataWritten: true|nasConnected: true|backupTriggered: true|restoreTriggered: true|remoteCommandExecuted: true" README.md src test
```

Expected: no overclaiming or unsafe true flags introduced by V0.85.

Then run Qwen read-only final review and DeepSeek closure before push:

```bash
qwen -p "You are the read-only adversarial reviewer for Linke V0.85 final diff. Do not modify files. Review the current repository diff. PASS only if V0.85 adds only a sanitized blocked rollbackUninstallPlan to supervisor-install-dry-run full JSON, excludes it from --readiness-summary, keeps --fail-on-blocked behavior correct, adds no real rollback/uninstall/install/launchctl/process/filesystem/NAS/backup/restore/remote-command behavior, prevents sensitive/path/identity leakage, updates docs/version/Gold, keeps Gold blocked, and tests are sufficient. Return: VERDICT, BLOCKING_FINDINGS, REQUIRED_CHANGES, CONFIDENCE." -o text
```

DeepSeek closure prompt should use the PM verification evidence and require JSON-only PASS/FAIL/INCONCLUSIVE.
