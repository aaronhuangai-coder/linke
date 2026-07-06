# Supervisor Install Approval Manifest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sanitized, full-output-only `installApprovalManifest` to `agent.js supervisor-install-dry-run` while keeping supervisor installation blocked, dry-run-only, and Gold blocked.

**Architecture:** Extend the existing local-only supervisor install dry-run plan with one pure static manifest helper. The helper describes explicit operator approval and rollback/recovery controls, but never collects approval, persists records, writes files, calls `launchctl`, reads processes, connects NAS, triggers backup/restore, or executes remote commands. `--readiness-summary` remains compact and excludes `installApprovalManifest`.

**Tech Stack:** Node.js ESM, `node:test`, existing `src/agent.js`, `src/version.js`, `src/gold-readiness.js`, README contract tests.

## Global Constraints

- Do not implement a real installer.
- Do not add `--install`, `--start`, `--load`, `--unload`, `--uninstall`, `--approve-install`, or any command that can change system state.
- Do not write approval records, rollback manifests, plist files, LaunchAgents, metadata, audit success events, config, device data, snapshot data, or reports.
- Do not call `launchctl`.
- Do not read process lists.
- Do not install, start, stop, unload, or remove launchd jobs.
- Do not connect NAS.
- Do not trigger backup, restore, or remote commands.
- Do not print config paths, source paths, server URLs, NAS endpoints, credential refs, token values, Authorization headers, environment values, home paths, plist paths, executable paths, approval identity, approval timestamps, or runnable command arguments.
- Do not claim production supervisor, production readiness, Gold readiness, real installer readiness, operator approval completed, rollback readiness, uninstall readiness, or managed daemon lifecycle.
- Keep `automation-installation` and `production-hardening` partial.
- Keep `real-nas-remote-backup` and overall Gold readiness blocked.
- Preserve existing V0.82 `installPreflight`, V0.81 `installCommandPreview`, and `readinessSummary` behavior.
- Design review evidence: Qwen returned `VERDICT: PASS`, required changes `none`; DeepSeek returned `VERDICT: PASS`, `COMMIT_READY: yes`.

---

## File Structure

- `test/agent-supervisor-install-dry-run.test.js`
  - Add the expected approval manifest fixture.
  - Add no-sensitive evidence assertions for `approval.evidence`, `rollback.evidence`, and every `controls[].evidence`.
  - Add helper/full-plan, CLI full-output, summary-only, fail-on-blocked, sibling safety non-interference, blocker-code, and no-leak assertions.
- `src/agent.js`
  - Add static approval manifest control definitions.
  - Export `buildSupervisorInstallApprovalManifest()`.
  - Add `installApprovalManifest` to full `buildSupervisorInstallDryRunPlan(config)` output only.
  - Leave CLI branching unchanged: full output prints the full plan, summary output prints only `readinessSummary`.
- `src/version.js`
  - Bump `LINKE_RELEASE_VERSION` from `V0.82` to `V0.83`.
- `src/gold-readiness.js`
  - Add manifest evidence under `automation-installation` and `production-hardening`.
  - Keep statuses partial/blocked and keep summary counts unchanged.
  - Update next-step copy to say V0.83 is approval/rollback manifest only and real install/start remains future work.
- `README.md`
  - Bump title/badge/table from V0.82 to V0.83.
  - Document `installApprovalManifest` and its safety boundaries.
  - Keep Gold blocked and production capability disclaimers explicit.
- `test/version.test.js`, `test/gold-readiness.test.js`, `test/readme.test.js`
  - Update V0.83 expectations and add README/Gold contract assertions for the approval manifest.
- `docs/superpowers/plans/2026-07-07-supervisor-install-approval-manifest.md`
  - Track execution, review, verification, and commit/push evidence.

---

### Task 1: Approval Manifest Helper And Agent CLI Output

**Files:**
- Modify: `test/agent-supervisor-install-dry-run.test.js`
- Modify: `src/agent.js`
- Modify: `docs/superpowers/plans/2026-07-07-supervisor-install-approval-manifest.md`

**Interfaces:**
- Consumes: `buildSupervisorInstallDryRunPlan(config)`, `buildSupervisorInstallReadinessSummary()`, `buildSupervisorInstallCommandPreview()`, `buildSupervisorInstallPreflight()`, `runSupervisorInstallDryRun(configPath)`
- Produces: `buildSupervisorInstallApprovalManifest()` returning `{ mode, state, approval, rollback, controls, safety }`
- Produces: `plan.installApprovalManifest` in full dry-run output only

- [x] **Step 1: Add the failing approval manifest fixture**

In `test/agent-supervisor-install-dry-run.test.js`, add this constant after `EXPECTED_SUPERVISOR_INSTALL_PREFLIGHT`:

```js
const EXPECTED_SUPERVISOR_INSTALL_APPROVAL_MANIFEST = Object.freeze({
  mode: 'dry-run-only',
  state: 'blocked',
  approval: {
    required: true,
    approved: false,
    source: 'not-collected',
    approverReturned: false,
    timestampReturned: false,
    blockerCode: 'operator-approval-required',
    evidence: 'No operator approval workflow or durable approval record exists in this release.',
  },
  rollback: {
    required: true,
    available: false,
    uninstallSupported: false,
    recoverySupervisorSupported: false,
    previousPlistRestoreSupported: false,
    blockerCode: 'rollback-recovery-incomplete',
    evidence: 'No uninstall, rollback, previous plist restore, or recovery supervisor lifecycle exists in this release.',
  },
  controls: [
    {
      id: 'explicit-operator-approval',
      status: 'blocked',
      requiredForInstall: true,
      blockerCode: 'operator-approval-required',
      evidence: 'Install approval is not collected or persisted.',
    },
    {
      id: 'rollback-plan',
      status: 'blocked',
      requiredForInstall: true,
      blockerCode: 'rollback-plan-missing',
      evidence: 'Rollback steps are not implemented.',
    },
    {
      id: 'uninstall-plan',
      status: 'blocked',
      requiredForInstall: true,
      blockerCode: 'uninstall-plan-missing',
      evidence: 'Uninstall steps are not implemented.',
    },
    {
      id: 'recovery-supervisor',
      status: 'blocked',
      requiredForInstall: true,
      blockerCode: 'recovery-supervisor-missing',
      evidence: 'Recovery supervisor lifecycle is not implemented.',
    },
  ],
  safety: {
    dryRun: true,
    manifestOnly: true,
    approvalCollected: false,
    approvalPersisted: false,
    rollbackExecuted: false,
    uninstallExecuted: false,
    recoverySupervisorStarted: false,
    launchctlCalled: false,
    processListRead: false,
    filesystemWritten: false,
    metadataWritten: false,
    supervisorInstalled: false,
    supervisorStarted: false,
    nasConnected: false,
    backupTriggered: false,
    restoreTriggered: false,
    remoteCommandExecuted: false,
    sensitiveValuesReturned: false,
  },
});
```

- [x] **Step 2: Add no-sensitive evidence helper**

In `test/agent-supervisor-install-dry-run.test.js`, add this helper after `assertNoSensitivePreflightEvidence(preflight)`:

```js
function assertNoSensitiveApprovalManifestEvidence(manifest) {
  const evidenceValues = [
    manifest.approval.evidence,
    manifest.rollback.evidence,
    ...manifest.controls.map((control) => control.evidence),
  ];

  for (const evidence of evidenceValues) {
    assert.strictEqual(typeof evidence, 'string');
    assert.doesNotMatch(evidence, /\/Users\/|\/private\/|~\/|https?:\/\//i);
    assert.doesNotMatch(evidence, /token|bearer|authorization|credentialRef|secret-ref|nas\.local/i);
    assert.doesNotMatch(evidence, /config\.json|LaunchAgents|\.plist/);
    assert.doesNotMatch(evidence, /approver|timestamp|hostname|username/i);
  }
}
```

- [x] **Step 3: Add failing pure helper/full plan assertions**

In the first test, after the `buildSupervisorInstallPreflight` lookup, add:

```js
const buildSupervisorInstallApprovalManifest = app.buildSupervisorInstallApprovalManifest;
if (!buildSupervisorInstallApprovalManifest) {
  throw new Error('buildSupervisorInstallApprovalManifest is not defined in src/agent.js');
}
```

After the existing `installPreflight` assertions, add:

```js
assert.deepStrictEqual(
  buildSupervisorInstallApprovalManifest(),
  EXPECTED_SUPERVISOR_INSTALL_APPROVAL_MANIFEST,
);
assert.deepStrictEqual(
  plan.installApprovalManifest,
  EXPECTED_SUPERVISOR_INSTALL_APPROVAL_MANIFEST,
);
assert.strictEqual(plan.installApprovalManifest.approval.approved, false);
assert.strictEqual(plan.installApprovalManifest.rollback.available, false);
assert.deepStrictEqual(
  plan.installApprovalManifest.controls.map((control) => control.id),
  [
    'explicit-operator-approval',
    'rollback-plan',
    'uninstall-plan',
    'recovery-supervisor',
  ],
);
for (const control of plan.installApprovalManifest.controls) {
  assert.strictEqual(control.status, 'blocked');
  assert.strictEqual(control.requiredForInstall, true);
  assert.strictEqual(typeof control.blockerCode, 'string');
  assert.ok(control.blockerCode.length > 0);
}
assert.strictEqual(
  plan.installApprovalManifest.approval.blockerCode,
  plan.installPreflight.checks.find((check) => check.id === 'operator-approval').blockerCode,
);
assert.notStrictEqual(
  plan.installApprovalManifest.controls.find((control) => control.id === 'rollback-plan').blockerCode,
  plan.installPreflight.checks.find((check) => check.id === 'rollback-recovery').blockerCode,
);
assert.deepStrictEqual(plan.safety, {
  dryRun: true,
  configPathReturned: false,
  sourcePathsReturned: false,
  serverUrlReturned: false,
  nasEndpointsReturned: false,
  credentialRefsReturned: false,
  tokenValuesReturned: false,
  launchctlCalled: false,
  processListRead: false,
  supervisorInstalled: false,
  launchdFileWritten: false,
  metadataWritten: false,
  nasConnected: false,
  backupTriggered: false,
  restoreTriggered: false,
  remoteCommandExecuted: false,
});
assert.deepStrictEqual(plan.installCommandPreview.safety, EXPECTED_SUPERVISOR_INSTALL_COMMAND_PREVIEW.safety);
assert.deepStrictEqual(plan.installPreflight.safety, EXPECTED_SUPERVISOR_INSTALL_PREFLIGHT.safety);
assert.deepStrictEqual(plan.installApprovalManifest.safety, EXPECTED_SUPERVISOR_INSTALL_APPROVAL_MANIFEST.safety);
assertNoSensitiveApprovalManifestEvidence(plan.installApprovalManifest);
```

- [x] **Step 4: Add failing CLI assertions**

In the “prints sanitized JSON and does not write files next to the config” test, after the existing `body.installPreflight` assertions, add:

```js
assert.deepStrictEqual(
  body.installApprovalManifest,
  EXPECTED_SUPERVISOR_INSTALL_APPROVAL_MANIFEST,
);
assert.strictEqual(body.installApprovalManifest.safety.dryRun, true);
assert.strictEqual(body.installApprovalManifest.safety.manifestOnly, true);
assert.strictEqual(body.installApprovalManifest.safety.approvalCollected, false);
assert.strictEqual(body.installApprovalManifest.safety.approvalPersisted, false);
assert.strictEqual(body.installApprovalManifest.safety.rollbackExecuted, false);
assert.strictEqual(body.installApprovalManifest.safety.uninstallExecuted, false);
assert.strictEqual(body.installApprovalManifest.safety.recoverySupervisorStarted, false);
assert.strictEqual(body.installApprovalManifest.safety.launchctlCalled, false);
assert.strictEqual(body.installApprovalManifest.safety.processListRead, false);
assert.strictEqual(body.installApprovalManifest.safety.filesystemWritten, false);
assert.strictEqual(body.installApprovalManifest.safety.metadataWritten, false);
assert.strictEqual(body.installApprovalManifest.safety.supervisorInstalled, false);
assert.strictEqual(body.installApprovalManifest.safety.supervisorStarted, false);
assert.strictEqual(body.installApprovalManifest.safety.nasConnected, false);
assert.strictEqual(body.installApprovalManifest.safety.backupTriggered, false);
assert.strictEqual(body.installApprovalManifest.safety.restoreTriggered, false);
assert.strictEqual(body.installApprovalManifest.safety.remoteCommandExecuted, false);
assert.strictEqual(body.installApprovalManifest.safety.sensitiveValuesReturned, false);
assertNoSensitiveApprovalManifestEvidence(body.installApprovalManifest);
```

In each summary-only assertion that already checks `body.installCommandPreview === undefined` and `body.installPreflight === undefined`, add:

```js
assert.strictEqual(body.installApprovalManifest, undefined);
```

In the full-output `--fail-on-blocked` test, add:

```js
assert.deepStrictEqual(
  body.installApprovalManifest,
  EXPECTED_SUPERVISOR_INSTALL_APPROVAL_MANIFEST,
);
assertNoSensitiveApprovalManifestEvidence(body.installApprovalManifest);
```

- [x] **Step 5: Run RED test**

Run:

```bash
node --test test/agent-supervisor-install-dry-run.test.js
```

Expected result: FAIL because `buildSupervisorInstallApprovalManifest` is not exported and `plan.installApprovalManifest` does not exist yet.

- [x] **Step 6: Add static manifest definitions**

In `src/agent.js`, add this constant after `SUPERVISOR_INSTALL_PREFLIGHT_CHECKS`:

```js
const SUPERVISOR_INSTALL_APPROVAL_MANIFEST_CONTROLS = Object.freeze([
  Object.freeze({
    id: 'explicit-operator-approval',
    blockerCode: 'operator-approval-required',
    evidence: 'Install approval is not collected or persisted.',
  }),
  Object.freeze({
    id: 'rollback-plan',
    blockerCode: 'rollback-plan-missing',
    evidence: 'Rollback steps are not implemented.',
  }),
  Object.freeze({
    id: 'uninstall-plan',
    blockerCode: 'uninstall-plan-missing',
    evidence: 'Uninstall steps are not implemented.',
  }),
  Object.freeze({
    id: 'recovery-supervisor',
    blockerCode: 'recovery-supervisor-missing',
    evidence: 'Recovery supervisor lifecycle is not implemented.',
  }),
]);
```

- [x] **Step 7: Add helper implementation**

In `src/agent.js`, add this exported helper after `buildSupervisorInstallPreflight()`:

```js
export function buildSupervisorInstallApprovalManifest() {
  return {
    mode: 'dry-run-only',
    state: 'blocked',
    approval: {
      required: true,
      approved: false,
      source: 'not-collected',
      approverReturned: false,
      timestampReturned: false,
      blockerCode: 'operator-approval-required',
      evidence: 'No operator approval workflow or durable approval record exists in this release.',
    },
    rollback: {
      required: true,
      available: false,
      uninstallSupported: false,
      recoverySupervisorSupported: false,
      previousPlistRestoreSupported: false,
      blockerCode: 'rollback-recovery-incomplete',
      evidence: 'No uninstall, rollback, previous plist restore, or recovery supervisor lifecycle exists in this release.',
    },
    controls: SUPERVISOR_INSTALL_APPROVAL_MANIFEST_CONTROLS.map((control) => ({
      ...control,
      status: 'blocked',
      requiredForInstall: true,
    })),
    safety: {
      dryRun: true,
      manifestOnly: true,
      approvalCollected: false,
      approvalPersisted: false,
      rollbackExecuted: false,
      uninstallExecuted: false,
      recoverySupervisorStarted: false,
      launchctlCalled: false,
      processListRead: false,
      filesystemWritten: false,
      metadataWritten: false,
      supervisorInstalled: false,
      supervisorStarted: false,
      nasConnected: false,
      backupTriggered: false,
      restoreTriggered: false,
      remoteCommandExecuted: false,
      sensitiveValuesReturned: false,
    },
  };
}
```

- [x] **Step 8: Wire manifest into full dry-run plan**

In `buildSupervisorInstallDryRunPlan(config)`, add this field immediately after `installPreflight`:

```js
    installApprovalManifest: buildSupervisorInstallApprovalManifest(),
```

Do not change the CLI summary branch:

```js
const output = args['readiness-summary'] === true ? result.readinessSummary : result;
```

- [x] **Step 9: Run focused GREEN tests**

Run:

```bash
node --test test/agent-supervisor-install-dry-run.test.js
```

Expected result: PASS.

- [x] **Step 10: Update plan progress**

Append a short Task 1 execution note to this plan:

```markdown
## Task 1 Execution Evidence

- RED: `node --test test/agent-supervisor-install-dry-run.test.js` failed before `buildSupervisorInstallApprovalManifest` existed.
- GREEN: `node --test test/agent-supervisor-install-dry-run.test.js` passed after adding the static manifest helper and full-output wiring.
- Safety: no launchctl, process read, filesystem write, metadata write, NAS, backup, restore, remote command, approval collection, approval persistence, rollback, uninstall, or recovery supervisor behavior was added.
```

---

### Task 2: Version, Gold Readiness, README, And Contract Tests

**Files:**
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-07-07-supervisor-install-approval-manifest.md`

**Interfaces:**
- Consumes: `buildSupervisorInstallApprovalManifest()`
- Produces: `LINKE_RELEASE_VERSION === 'V0.83'`
- Produces: Gold evidence strings for `installApprovalManifest`
- Produces: README version/docs coverage for V0.83

- [x] **Step 1: Update version expectation test first**

In `test/version.test.js`, change:

```js
it('LINKE_RELEASE_VERSION is the V0.82 milestone', () => {
  assert.strictEqual(LINKE_RELEASE_VERSION, 'V0.82');
});
```

to:

```js
it('LINKE_RELEASE_VERSION is the V0.83 milestone', () => {
  assert.strictEqual(LINKE_RELEASE_VERSION, 'V0.83');
});
```

- [x] **Step 2: Add Gold readiness RED assertions**

In `test/gold-readiness.test.js`, inside the `automation-installation` test after the preflight assertions, add:

```js
assert.ok(automationEvidence.includes('src/agent.js buildSupervisorInstallApprovalManifest'));
assert.ok(automationEvidence.includes('installApprovalManifest.state:blocked'));
assert.ok(automationEvidence.includes('installApprovalManifest.approval.approved:false'));
assert.ok(automationEvidence.includes('installApprovalManifest.rollback.available:false'));
assert.ok(automationItem.nextStep.includes('V0.83'));
assert.ok(automationItem.nextStep.includes('approval'));
assert.ok(automationItem.nextStep.includes('rollback'));
```

Inside the `production-hardening` test after the preflight assertions, add:

```js
assert.ok(hardeningEvidence.includes('src/agent.js buildSupervisorInstallApprovalManifest'));
assert.ok(hardeningEvidence.includes('installApprovalManifest.state:blocked'));
assert.ok(hardeningEvidence.includes('installApprovalManifest.approval.approved:false'));
assert.ok(hardeningEvidence.includes('installApprovalManifest.rollback.available:false'));
assert.ok(hardeningItem.nextStep.includes('approval'));
assert.ok(hardeningItem.nextStep.includes('rollback'));
assert.ok(hardeningItem.nextStep.includes('uninstall'));
```

- [x] **Step 3: Add README RED assertions**

In `test/readme.test.js`, in `describe('README — V0.82 Supervisor install preflight gate', ...)`, rename the describe title to:

```js
describe('README — V0.83 Supervisor install approval manifest', () => {
```

Change the current version row assertion to require V0.83:

```js
assertReadmeContains(/\| V0\.83 \| 当前版本 \|[^|]*(installApprovalManifest|approval|rollback|blocked)/i, 'V0.83 should be current approval manifest milestone');
```

Add a separate historical V0.82 assertion:

```js
assertReadmeContains(/\| V0\.82 \| 历史版本 \|[^|]*(installPreflight|preflight|requiredForInstall:true|blocked)/i, 'V0.82 should become historical preflight gate milestone');
```

Add a manifest docs test in the same describe block:

```js
it('documents installApprovalManifest as full-output only and dry-run-only', () => {
  assertReadmeContains(/installApprovalManifest\.state:"blocked"/, 'README should document blocked approval manifest state');
  assertReadmeContains(/installApprovalManifest\.approval\.approved:false/, 'README should document unapproved operator approval state');
  assertReadmeContains(/installApprovalManifest\.rollback\.available:false/, 'README should document unavailable rollback state');
  assertReadmeContains(/--readiness-summary[^\n]*(不输出|excludes)[^\n]*installApprovalManifest/i, 'README should say readiness summary excludes installApprovalManifest');
  assertReadmeContains(/不收集批准|approvalCollected:false|approvalPersisted:false/i, 'README should document no approval collection or persistence');
  assertReadmeContains(/rollbackExecuted:false|uninstallExecuted:false|recoverySupervisorStarted:false/i, 'README should document no rollback, uninstall, or recovery supervisor execution');
});
```

Extend the existing supervisor-install-dry-run docs coverage assertion so it includes `buildSupervisorInstallApprovalManifest`:

```js
assertReadmeContains(/buildSupervisorInstallDryRunPlan|buildSupervisorInstallReadinessSummary|buildSupervisorInstallCommandPreview|buildSupervisorInstallPreflight|buildSupervisorInstallApprovalManifest|test\/agent-supervisor-install-dry-run\.test\.js/, 'README should document supervisor-install-dry-run test coverage');
```

- [x] **Step 4: Run RED docs/version tests**

Run:

```bash
node --test test/gold-readiness.test.js test/readme.test.js test/version.test.js
```

Expected result: FAIL because version/docs/Gold evidence still describe V0.82.

- [x] **Step 5: Update `src/version.js`**

Change:

```js
export const LINKE_RELEASE_VERSION = 'V0.82';
```

to:

```js
export const LINKE_RELEASE_VERSION = 'V0.83';
```

- [x] **Step 6: Update Gold readiness evidence**

In `src/gold-readiness.js`, add these evidence strings to both `automation-installation.evidence` and `production-hardening.evidence`, immediately after the V0.82 preflight evidence:

```js
'src/agent.js buildSupervisorInstallApprovalManifest',
'installApprovalManifest.state:blocked',
'installApprovalManifest.approval.approved:false',
'installApprovalManifest.rollback.available:false',
```

Update `automation-installation.nextStep` to:

```js
nextStep: 'V0.83 adds a dry-run approval and rollback manifest, while supervisor install remains blocked and not_configured; add real installer, launchd install/start, watchdog, monitoring, approval persistence, rollback, uninstall, recovery supervisor, secret management, and managed daemon lifecycle only after production boundaries are designed.',
```

Update `production-hardening.nextStep` to include the new V0.83 scope:

```js
nextStep: 'Recent releases add read-only Agent/Web visibility, supervisor-status not_configured reporting, supervisor install dry-run planning, supervisor install readiness gating, non-runnable install command preview, blocked install preflight checks, and a dry-run approval/rollback manifest; still add deployment hardening, audit rotation, tamper-proof audit storage, distributed rate limiting, secret management, monitoring, approval persistence, rollback, uninstall, and recovery supervisor.',
```

- [x] **Step 7: Update README version and feature docs**

In `README.md`:

- Change first line to `# Linke V0.83`.
- Change current version badge to `**当前版本：V0.83**`.
- Change V0.82 table row from `当前版本` to `历史版本`.
- Add a V0.83 table row:

```markdown
| V0.83 | 当前版本 | Supervisor install approval manifest：`agent.js supervisor-install-dry-run` full JSON 增加 sanitized `installApprovalManifest`，固定 `state:"blocked"`、`approval.approved:false` 与 `rollback.available:false`；`--readiness-summary` 不输出 installApprovalManifest、installPreflight 或 command preview；不收集或持久化批准、不执行 rollback/uninstall/recovery supervisor、不调用 launchctl、不读取进程列表、不安装、不启动、不写 LaunchAgents/plist/metadata、不连接 NAS、不触发备份/恢复、不执行远程命令、不回显 config path、sourcePath、serverUrl、NAS endpoint、credentialRef、token、Authorization、approval identity 或 timestamp，Gold 依旧 blocked |
```

In the supervisor install dry-run section, add a new bullet after `installPreflight 字段`:

```markdown
- **installApprovalManifest 字段**：由 `buildSupervisorInstallApprovalManifest` 构造，只出现在完整 dry-run JSON 中，`--readiness-summary` 不输出该字段；当前固定返回 `state:"blocked"`、`approval.approved:false`、`rollback.available:false`，control 包括 `explicit-operator-approval`、`rollback-plan`、`uninstall-plan` 与 `recovery-supervisor`；所有 control 都固定 `status:"blocked"`、`requiredForInstall:true` 与稳定 `blockerCode`；manifest safety 固定 `dryRun:true`、`manifestOnly:true`、`approvalCollected:false`、`approvalPersisted:false`、`rollbackExecuted:false`、`uninstallExecuted:false`、`recoverySupervisorStarted:false`、`launchctlCalled:false`、`processListRead:false`、`filesystemWritten:false`、`metadataWritten:false`、`supervisorInstalled:false`、`supervisorStarted:false`、`nasConnected:false`、`backupTriggered:false`、`restoreTriggered:false`、`remoteCommandExecuted:false` 与 `sensitiveValuesReturned:false`。
```

Update Gold boundary paragraphs so current evidence starts with V0.83 and includes:

```text
buildSupervisorInstallApprovalManifest、installApprovalManifest.state:"blocked"、installApprovalManifest.approval.approved:false 与 installApprovalManifest.rollback.available:false
```

Keep all production/Gold disclaimers negative.

- [x] **Step 8: Run GREEN docs/version tests**

Run:

```bash
node --test test/gold-readiness.test.js test/readme.test.js test/version.test.js
```

Expected result: PASS.

- [x] **Step 9: Run full verification**

Run:

```bash
node --test test/agent-supervisor-install-dry-run.test.js
node --test test/*.test.js
git diff --check
rg -n "production ready|Gold ready|real NAS remote backup ready|daemon installed|launchd installed|always-running|real installer implemented|real install ready|production-ready supervisor|approval completed|rollback ready|uninstall ready|recovery supervisor ready|真实 NAS 备份已实现|生产可用" README.md src docs/superpowers/specs/2026-07-07-supervisor-install-approval-manifest-design.md
```

Expected result:
- Both `node --test` commands pass.
- `git diff --check` exits `0`.
- `rg` finds only negative boundary language or scan-list mentions; any positive claim blocks the task.

- [x] **Step 10: Update plan progress**

Append:

```markdown
## Task 2 Execution Evidence

- RED: `node --test test/gold-readiness.test.js test/readme.test.js test/version.test.js` failed before V0.83 version/docs/Gold evidence existed.
- GREEN: `node --test test/gold-readiness.test.js test/readme.test.js test/version.test.js` passed after version/docs/Gold updates.
- FULL: `node --test test/*.test.js` passed.
- Safety: Gold remained blocked; `automation-installation` and `production-hardening` remained partial; `real-nas-remote-backup` remained blocked.
```

## Task 2 Execution Evidence Actual

- Worker recovery: AGY first Task 2 run exited `0` with no final output, left an incomplete uncommitted diff, and did not replace the stale V0.21 report. AGY fix retry then failed with `authentication failed or timed out`. PM took over the bounded version/docs/test completion to avoid loop stalling.
- RED: `node --test --test-reporter=dot test/gold-readiness.test.js test/readme.test.js test/version.test.js` failed before README V0.83 docs were added and before the precise `available:false` schema evidence exception was applied.
- GREEN: `node --test --test-reporter=dot test/gold-readiness.test.js test/readme.test.js test/version.test.js` passed after V0.83 version/docs/Gold updates.
- FULL: `node --test --test-reporter=dot test/*.test.js` passed.
- DIFF: `git diff --check` passed.
- Safety scan: overclaim scan only matched negative constraints in `docs/superpowers/specs/2026-07-07-supervisor-install-approval-manifest-design.md`.
- Safety: Gold remained blocked; `automation-installation` and `production-hardening` remained partial; `real-nas-remote-backup` remained blocked.

---

## Review And Closure Gates

- [x] **AGY/ayg implementer gate:** AGY completed Task 1. AGY Task 2 failed twice (`no final output/stale report`, then `authentication failed or timed out`), so PM takeover was recorded and bounded to the Task 2 file list.
- [x] **PM local verification gate:** Codex PM reran focused docs/version tests, full `node --test test/*.test.js`, `git diff --check`, and overclaim scan.
- [x] **Qwen adversarial review gate:** Qwen reviewed the final diff read-only and returned `VERDICT: PASS`, `REQUIRED CHANGES: none`, `CONFIDENCE: high`.
- [x] **DeepSeek closure gate:** DeepSeek received the final diff and PM evidence and returned `VERDICT: PASS`, `COMMIT_READY: yes`, `CONFIDENCE: high`.
- [ ] **Commit/push gate:** Commit message should be `feat: add supervisor approval manifest dry-run`; push to `origin/linke-v0.12-web-panel`.
