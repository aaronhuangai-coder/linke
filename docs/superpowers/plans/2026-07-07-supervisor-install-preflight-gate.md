# Supervisor Install Preflight Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sanitized, static `installPreflight` gate to `agent.js supervisor-install-dry-run` while keeping supervisor installation blocked, dry-run-only, and Gold blocked.

**Architecture:** Extend the existing local-only `buildSupervisorInstallDryRunPlan(config)` output with one pure preflight helper. The helper returns a static, code-owned, blocked checklist and is excluded from `--readiness-summary` output. No runtime probing, launchd access, process inspection, file writing, NAS access, backup, restore, or remote command behavior is added.

**Tech Stack:** Node.js ESM, `node:test`, existing `src/agent.js`, `src/version.js`, `src/gold-readiness.js`, README contract tests.

## Global Constraints

- Do not implement a real installer.
- Do not add `--install`, `--start`, `--load`, or any command that can change system state.
- Do not call `launchctl`.
- Do not read process lists.
- Do not install or start launchd jobs.
- Do not write `~/Library/LaunchAgents`, plist files, metadata, config, device data, snapshots, audit success events, or preflight reports.
- Do not connect NAS.
- Do not trigger backup, restore, or remote commands.
- Do not print config paths, source paths, server URLs, NAS endpoints, credential refs, token values, Authorization headers, environment values, home paths, plist paths, executable paths, or runnable command arguments.
- Do not claim production supervisor, production readiness, Gold readiness, real installer readiness, or managed daemon lifecycle.
- Keep `--readiness-summary` output exactly summary-only: no `installCommandPreview`, no `installPreflight`.
- Keep `automation-installation` and `production-hardening` partial.
- Keep `real-nas-remote-backup` and overall Gold readiness blocked.
- ZAI is not a required closure verifier for V0.82; use Qwen read-only adversarial review and DeepSeek JSON-only auxiliary closure after local verification.

---

## File Structure

- `test/agent-supervisor-install-dry-run.test.js`
  - Add the V0.82 expected preflight fixture.
  - Add helper, full-output, summary-only, fail-on-blocked, exit-code, no-leak, and evidence string assertions.
- `src/agent.js`
  - Add static preflight check definitions.
  - Export `buildSupervisorInstallPreflight()`.
  - Add `installPreflight` to full `buildSupervisorInstallDryRunPlan(config)` output only.
  - Leave CLI branching unchanged: full output prints full plan, summary output prints only `readinessSummary`.
- `src/version.js`
  - Bump `LINKE_RELEASE_VERSION` from `V0.81` to `V0.82`.
- `src/gold-readiness.js`
  - Add preflight evidence under `automation-installation` and `production-hardening`.
  - Keep statuses partial/blocked and keep summary counts unchanged.
  - Update next-step copy to say V0.82 is preflight-only and real install/start remains future work.
- `README.md`
  - Bump title/badge/table from V0.81 to V0.82.
  - Document `installPreflight` and its safety boundaries.
  - Keep Gold blocked and production capability disclaimers explicit.
- `test/version.test.js`, `test/gold-readiness.test.js`, `test/readme.test.js`
  - Update V0.82 expectations and add README/Gold contract assertions for preflight.
- `docs/superpowers/plans/2026-07-07-supervisor-install-preflight-gate.md`
  - Track execution results, verifier results, and final commit/push evidence.

---

### Task 1: Preflight Helper And Agent CLI Output

**Files:**
- Modify: `test/agent-supervisor-install-dry-run.test.js`
- Modify: `src/agent.js`
- Modify: `docs/superpowers/plans/2026-07-07-supervisor-install-preflight-gate.md`

**Interfaces:**
- Consumes: `buildSupervisorInstallDryRunPlan(config)`, `buildSupervisorInstallReadinessSummary()`, `buildSupervisorInstallCommandPreview()`, `runSupervisorInstallDryRun(configPath)`
- Produces: `buildSupervisorInstallPreflight()` returning `{ mode, state, blockedCount, readyCount, checkedCount, checks, safety }`
- Produces: `plan.installPreflight` in full dry-run output only

- [x] **Step 1: Add RED expected preflight fixture**

In `test/agent-supervisor-install-dry-run.test.js`, add this constant after `EXPECTED_SUPERVISOR_INSTALL_COMMAND_PREVIEW`:

```js
const EXPECTED_SUPERVISOR_INSTALL_PREFLIGHT = Object.freeze({
  mode: 'dry-run-only',
  state: 'blocked',
  blockedCount: 6,
  readyCount: 0,
  checkedCount: 6,
  checks: [
    {
      id: 'installer-implementation',
      label: 'Real installer implementation',
      status: 'blocked',
      blockerCode: 'real-install-not-implemented',
      requiredForInstall: true,
      evidence: 'No install command or launchd write path exists in this release.',
    },
    {
      id: 'launchd-lifecycle',
      label: 'Launchd install/start lifecycle',
      status: 'blocked',
      blockerCode: 'launchd-lifecycle-blocked',
      requiredForInstall: true,
      evidence: 'launchctl execution, plist writes, and daemon start remain disabled.',
    },
    {
      id: 'operator-approval',
      label: 'Explicit operator approval gate',
      status: 'blocked',
      blockerCode: 'operator-approval-required',
      requiredForInstall: true,
      evidence: 'No approved write path or production install confirmation flow exists.',
    },
    {
      id: 'secret-management',
      label: 'Production secret management',
      status: 'blocked',
      blockerCode: 'secret-management-incomplete',
      requiredForInstall: true,
      evidence: 'Secret rotation, protected storage, and secret handling are not production-grade.',
    },
    {
      id: 'monitoring-watchdog',
      label: 'Monitoring and watchdog',
      status: 'blocked',
      blockerCode: 'monitoring-watchdog-incomplete',
      requiredForInstall: true,
      evidence: 'No watchdog, health recovery loop, alerting, or managed daemon monitoring is implemented.',
    },
    {
      id: 'rollback-recovery',
      label: 'Rollback and recovery plan',
      status: 'blocked',
      blockerCode: 'rollback-recovery-incomplete',
      requiredForInstall: true,
      evidence: 'No rollback, uninstall, or recovery supervisor lifecycle is implemented.',
    },
  ],
  safety: {
    dryRun: true,
    preflightOnly: true,
    launchctlCalled: false,
    processListRead: false,
    filesystemWritten: false,
    metadataWritten: false,
    nasConnected: false,
    backupTriggered: false,
    restoreTriggered: false,
    remoteCommandExecuted: false,
    sensitiveValuesReturned: false,
  },
});
```

- [x] **Step 2: Add RED no-sensitive-evidence helper**

In `test/agent-supervisor-install-dry-run.test.js`, add this helper after `escapeRegExp(value)`:

```js
function assertNoSensitivePreflightEvidence(preflight) {
  for (const check of preflight.checks) {
    assert.strictEqual(typeof check.evidence, 'string');
    assert.doesNotMatch(check.evidence, /\/Users\/|\/private\/|~\/|https?:\/\//i);
    assert.doesNotMatch(check.evidence, /token|bearer|authorization|credentialRef|secret-ref|nas\.local/i);
    assert.doesNotMatch(check.evidence, /config\.json|LaunchAgents|\.plist/);
  }
}
```

This deliberately treats token-like words and host/path markers as banned inside `evidence`. Keep generic labels separate from generic evidence copy.

- [x] **Step 3: Add RED pure helper/full plan assertions**

In the first test, after the existing `buildSupervisorInstallCommandPreview` line, add:

```js
const buildSupervisorInstallPreflight = app.buildSupervisorInstallPreflight;
if (!buildSupervisorInstallPreflight) {
  throw new Error('buildSupervisorInstallPreflight is not defined in src/agent.js');
}
```

After the existing command preview assertions, add:

```js
assert.deepStrictEqual(
  buildSupervisorInstallPreflight(),
  EXPECTED_SUPERVISOR_INSTALL_PREFLIGHT,
);
assert.deepStrictEqual(
  plan.installPreflight,
  EXPECTED_SUPERVISOR_INSTALL_PREFLIGHT,
);
assert.strictEqual(plan.installPreflight.blockedCount, plan.installPreflight.checks.length);
assert.strictEqual(plan.installPreflight.readyCount, 0);
assert.strictEqual(plan.installPreflight.checkedCount, plan.installPreflight.checks.length);
assert.deepStrictEqual(
  plan.installPreflight.checks.map((check) => check.id),
  [
    'installer-implementation',
    'launchd-lifecycle',
    'operator-approval',
    'secret-management',
    'monitoring-watchdog',
    'rollback-recovery',
  ],
);
for (const check of plan.installPreflight.checks) {
  assert.strictEqual(check.status, 'blocked');
  assert.strictEqual(check.requiredForInstall, true);
  assert.strictEqual(typeof check.blockerCode, 'string');
  assert.ok(check.blockerCode.length > 0);
}
assert.deepStrictEqual(plan.installPreflight.safety, EXPECTED_SUPERVISOR_INSTALL_PREFLIGHT.safety);
assertNoSensitivePreflightEvidence(plan.installPreflight);
```

- [x] **Step 4: Add RED CLI assertions**

In the “prints sanitized JSON and does not write files next to the config” test, after command preview assertions, add:

```js
assert.deepStrictEqual(
  body.installPreflight,
  EXPECTED_SUPERVISOR_INSTALL_PREFLIGHT,
);
assert.strictEqual(body.installPreflight.safety.dryRun, true);
assert.strictEqual(body.installPreflight.safety.preflightOnly, true);
assert.strictEqual(body.installPreflight.safety.launchctlCalled, false);
assert.strictEqual(body.installPreflight.safety.processListRead, false);
assert.strictEqual(body.installPreflight.safety.filesystemWritten, false);
assert.strictEqual(body.installPreflight.safety.metadataWritten, false);
assert.strictEqual(body.installPreflight.safety.nasConnected, false);
assert.strictEqual(body.installPreflight.safety.backupTriggered, false);
assert.strictEqual(body.installPreflight.safety.restoreTriggered, false);
assert.strictEqual(body.installPreflight.safety.remoteCommandExecuted, false);
assert.strictEqual(body.installPreflight.safety.sensitiveValuesReturned, false);
assertNoSensitivePreflightEvidence(body.installPreflight);
```

In the `--readiness-summary` test, after `assert.strictEqual(body.installCommandPreview, undefined);`, add:

```js
assert.strictEqual(body.installPreflight, undefined);
```

In the `--fail-on-blocked` full-output test, after command preview assertions, add:

```js
assert.deepStrictEqual(
  body.installPreflight,
  EXPECTED_SUPERVISOR_INSTALL_PREFLIGHT,
);
assertNoSensitivePreflightEvidence(body.installPreflight);
```

In the combined summary/fail test, after `assert.strictEqual(body.installCommandPreview, undefined);`, add:

```js
assert.strictEqual(body.installPreflight, undefined);
```

The existing full CLI test already proves exit code `0` without `--fail-on-blocked`, because `runAgent()` would throw on non-zero exit.

- [x] **Step 5: Run RED test**

Run:

```bash
node --test test/agent-supervisor-install-dry-run.test.js
```

Expected: FAIL with `buildSupervisorInstallPreflight is not defined in src/agent.js` or a missing `installPreflight` assertion.

- [x] **Step 6: Implement static preflight helper**

In `src/agent.js`, add this constant after `SUPERVISOR_INSTALL_COMMAND_PREVIEW_ACTIONS`:

```js
const SUPERVISOR_INSTALL_PREFLIGHT_CHECKS = Object.freeze([
  Object.freeze({
    id: 'installer-implementation',
    label: 'Real installer implementation',
    blockerCode: 'real-install-not-implemented',
    evidence: 'No install command or launchd write path exists in this release.',
  }),
  Object.freeze({
    id: 'launchd-lifecycle',
    label: 'Launchd install/start lifecycle',
    blockerCode: 'launchd-lifecycle-blocked',
    evidence: 'launchctl execution, plist writes, and daemon start remain disabled.',
  }),
  Object.freeze({
    id: 'operator-approval',
    label: 'Explicit operator approval gate',
    blockerCode: 'operator-approval-required',
    evidence: 'No approved write path or production install confirmation flow exists.',
  }),
  Object.freeze({
    id: 'secret-management',
    label: 'Production secret management',
    blockerCode: 'secret-management-incomplete',
    evidence: 'Secret rotation, protected storage, and secret handling are not production-grade.',
  }),
  Object.freeze({
    id: 'monitoring-watchdog',
    label: 'Monitoring and watchdog',
    blockerCode: 'monitoring-watchdog-incomplete',
    evidence: 'No watchdog, health recovery loop, alerting, or managed daemon monitoring is implemented.',
  }),
  Object.freeze({
    id: 'rollback-recovery',
    label: 'Rollback and recovery plan',
    blockerCode: 'rollback-recovery-incomplete',
    evidence: 'No rollback, uninstall, or recovery supervisor lifecycle is implemented.',
  }),
]);
```

Add `installPreflight` to the returned object in `buildSupervisorInstallDryRunPlan(config)` immediately after `installCommandPreview`:

```js
installPreflight: buildSupervisorInstallPreflight(),
```

Add this exported helper after `buildSupervisorInstallCommandPreview()`:

```js
export function buildSupervisorInstallPreflight() {
  return {
    mode: 'dry-run-only',
    state: 'blocked',
    blockedCount: SUPERVISOR_INSTALL_PREFLIGHT_CHECKS.length,
    readyCount: 0,
    checkedCount: SUPERVISOR_INSTALL_PREFLIGHT_CHECKS.length,
    checks: SUPERVISOR_INSTALL_PREFLIGHT_CHECKS.map((check) => ({
      ...check,
      status: 'blocked',
      requiredForInstall: true,
    })),
    safety: {
      dryRun: true,
      preflightOnly: true,
      launchctlCalled: false,
      processListRead: false,
      filesystemWritten: false,
      metadataWritten: false,
      nasConnected: false,
      backupTriggered: false,
      restoreTriggered: false,
      remoteCommandExecuted: false,
      sensitiveValuesReturned: false,
    },
  };
}
```

Do not change CLI branch logic. The existing line keeps summary-only behavior correct:

```js
const output = args['readiness-summary'] === true ? result.readinessSummary : result;
```

- [x] **Step 7: Run GREEN test**

Run:

```bash
node --test test/agent-supervisor-install-dry-run.test.js
```

Expected: PASS. If the no-sensitive evidence helper fails because evidence contains banned words, revise only the generic `evidence` strings in both test fixture and source constant; do not weaken the helper without PM review.

- [x] **Step 8: Commit Task 1**

Run:

```bash
git add src/agent.js test/agent-supervisor-install-dry-run.test.js docs/superpowers/plans/2026-07-07-supervisor-install-preflight-gate.md
git commit -m "feat: add supervisor install preflight gate"
git push
```

Expected: commit and push succeed.

Observed:
- AGY implementer returned `DONE` and committed `cdafba0 feat: add supervisor install preflight gate`.
- RED evidence from AGY report: `node --test test/agent-supervisor-install-dry-run.test.js` failed with `buildSupervisorInstallPreflight is not defined in src/agent.js`.
- GREEN evidence from AGY report and PM rerun: `node --test test/agent-supervisor-install-dry-run.test.js` passed 9/9.
- PM diff review confirmed only `src/agent.js` and `test/agent-supervisor-install-dry-run.test.js` changed in the task commit.
- `git diff --check d7b47b2..cdafba0` exited 0.
- Qwen read-only Task 1 review returned `VERDICT: PASS`, `REQUIRED CHANGES: none`, `CONFIDENCE: high`. PM rejected Qwen's minor note that direct helper coverage was missing because the test directly asserts `buildSupervisorInstallPreflight()`.

---

### Task 2: Version, README, And Gold Readiness Evidence

**Files:**
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `README.md`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js`
- Modify: `docs/superpowers/plans/2026-07-07-supervisor-install-preflight-gate.md`

**Interfaces:**
- Consumes: `LINKE_RELEASE_VERSION`, `buildGoldReadinessReport({ now })`, README contract tests
- Produces: V0.82 version metadata, README current version row, Gold evidence strings for `buildSupervisorInstallPreflight` and `installPreflight.state:blocked`

- [ ] **Step 1: Update RED version tests**

In `test/version.test.js`, change:

```js
it('LINKE_RELEASE_VERSION is the V0.81 milestone', () => {
  assert.strictEqual(LINKE_RELEASE_VERSION, 'V0.81');
});
```

to:

```js
it('LINKE_RELEASE_VERSION is the V0.82 milestone', () => {
  assert.strictEqual(LINKE_RELEASE_VERSION, 'V0.82');
});
```

In `test/gold-readiness.test.js`, change the first two version tests to:

```js
it('expects LINKE_RELEASE_VERSION to be V0.82', () => {
  assert.strictEqual(LINKE_RELEASE_VERSION, 'V0.82');
});

it('expects report.version to be V0.82', () => {
  const report = buildGoldReadinessReport({ now: new Date("2026-07-07T12:00:00.000Z") });
  assert.strictEqual(report.version, 'V0.82');
});
```

Do not change the summary count test; expected summary remains:

```js
assert.deepStrictEqual(report.summary, { ready: 4, partial: 4, blocked: 1, total: 9 });
```

- [ ] **Step 2: Add RED Gold evidence assertions**

In `test/gold-readiness.test.js`, find the automation-installation / production-hardening evidence tests. Add assertions equivalent to:

```js
const automationItem = report.items.find(item => item.id === 'automation-installation');
assert.ok(automationItem, 'automation-installation item should exist');
assert.strictEqual(automationItem.status, 'partial');
const automationEvidence = evidenceText(automationItem);
assert.ok(automationEvidence.includes('src/agent.js buildSupervisorInstallPreflight'));
assert.ok(automationEvidence.includes('installPreflight.state:blocked'));
assert.ok(automationEvidence.includes('installPreflight.checks:requiredForInstall:true'));
assert.ok(automationItem.nextStep.includes('V0.82'));
assert.ok(automationItem.nextStep.includes('preflight'));
assert.ok(automationItem.nextStep.includes('real installer'));

const hardeningItem = report.items.find(item => item.id === 'production-hardening');
assert.ok(hardeningItem, 'production-hardening item should exist');
assert.strictEqual(hardeningItem.status, 'partial');
const hardeningEvidence = evidenceText(hardeningItem);
assert.ok(hardeningEvidence.includes('src/agent.js buildSupervisorInstallPreflight'));
assert.ok(hardeningEvidence.includes('installPreflight.state:blocked'));
assert.ok(hardeningItem.nextStep.includes('preflight'));
assert.ok(hardeningItem.nextStep.includes('secret management'));
assert.ok(hardeningItem.nextStep.includes('monitoring'));
assert.ok(hardeningItem.nextStep.includes('recovery supervisor'));
```

Use the existing local test structure rather than creating duplicate `report` variables if that file already groups these items.

- [ ] **Step 3: Add RED README tests**

In `test/readme.test.js`, update V0.81 current-version expectations to V0.82. Add or update a section named:

```js
describe('README — V0.82 Supervisor install preflight gate', () => {
  it('title and badge claim V0.82 as current', () => {
    assertReadmeContains(/# Linke V0\.82/, 'README title should mention V0.82');
    assertReadmeContains(/\*\*当前版本：V0\.82\*\*/, 'README badge should mention V0.82');
  });

  it('version table marks V0.81 historical and V0.82 current', () => {
    assertReadmeContains(/\| V0\.81 \| 历史版本 \|[^|]*(installCommandPreview|command preview|wouldRun:false|wouldWrite:false|blocked)/i, 'V0.81 should be historical command preview milestone');
    assertReadmeContains(/\| V0\.82 \| 当前版本 \|[^|]*(installPreflight|preflight|requiredForInstall:true|blocked)/i, 'V0.82 should be current preflight gate milestone');
  });

  it('documents installPreflight as full-output only and dry-run-only', () => {
    assertReadmeContains(/installPreflight\.state:"blocked"/, 'README should document blocked preflight state');
    assertReadmeContains(/installPreflight\.checks:requiredForInstall:true/, 'README should document required preflight checks');
    assertReadmeContains(/--readiness-summary[^\\n]*(不输出|excludes)[^\\n]*installPreflight/i, 'README should say readiness summary excludes installPreflight');
    assertReadmeContains(/不调用 launchctl|launchctlCalled:false/, 'README should keep launchctl boundary');
    assertReadmeContains(/不写 LaunchAgents|launchdFileWritten:false/, 'README should keep launchd write boundary');
    assertReadmeContains(/不连接 NAS|nasConnected:false/, 'README should keep NAS boundary');
  });

  it('keeps Gold blocked and rejects production hardening overclaims for V0.82', () => {
    assertReadmeContains(/Gold[^\\n]*(blocked|阻塞|依旧 blocked|仍 blocked)/i, 'README should keep Gold blocked');
    assertReadmeContains(/真实 installer|real installer|真实安装/, 'README should say real installer remains future work');
    assertReadmeContains(/watchdog|monitoring|recovery supervisor|secret management/i, 'README should list remaining hardening gaps');
    assertReadmeDoesNotContain(/Gold ready|production ready|real NAS remote backup ready|daemon installed|launchd installed|always-running|real installer implemented|production-ready supervisor|真实 NAS 备份已实现|生产可用/i, 'README should not claim production readiness');
  });
});
```

If helpers are named differently, use the existing `assertReadmeContains` / `assertReadmeDoesNotContain` helpers already present in `test/readme.test.js`.

- [ ] **Step 4: Run RED docs/version tests**

Run:

```bash
node --test test/version.test.js test/gold-readiness.test.js test/readme.test.js test/agent-supervisor-install-dry-run.test.js
```

Expected: FAIL because source version, README, and Gold evidence still say V0.81 and do not document `installPreflight`.

- [ ] **Step 5: Bump release version**

In `src/version.js`, change:

```js
export const LINKE_RELEASE_VERSION = 'V0.81';
```

to:

```js
export const LINKE_RELEASE_VERSION = 'V0.82';
```

- [ ] **Step 6: Update Gold readiness evidence**

In `src/gold-readiness.js`, add these evidence strings to both `automation-installation.evidence` and `production-hardening.evidence` near the existing supervisor install dry-run entries:

```js
'src/agent.js buildSupervisorInstallPreflight',
'installPreflight.state:blocked',
'installPreflight.checks:requiredForInstall:true',
```

Update `automation-installation.nextStep` to:

```js
nextStep: 'V0.82 adds a sanitized supervisor install preflight gate but still only reports blocked readiness and not_configured supervisor state; add real installer, launchd install/start, watchdog, monitoring, rollback, secret management, and managed daemon lifecycle only after production boundaries are designed.',
```

Update `production-hardening.nextStep` to:

```js
nextStep: 'Recent releases add read-only Agent/Web visibility, supervisor-status not_configured reporting, supervisor install dry-run planning, supervisor install readiness gating, non-runnable install command preview, and blocked install preflight checks; still add deployment hardening, audit rotation, tamper-proof audit storage, distributed rate limiting, secret management, monitoring, rollback, and recovery supervisor.',
```

Keep statuses unchanged:

```js
status: 'partial',
```

for both `automation-installation` and `production-hardening`; keep `real-nas-remote-backup` status `blocked`.

- [ ] **Step 7: Update README**

Update README consistently:

```md
# Linke V0.82
```

Change the badge line to start with:

```md
> **当前版本：V0.82** — 单机 localhost 原型阶段，新增 `agent.js supervisor-install-dry-run` full JSON 内的 sanitized `installPreflight` 安装前预检门禁，固定 `installPreflight.state:"blocked"`，所有 preflight check 均为 `requiredForInstall:true`
```

In the version table:

```md
| V0.81 | 历史版本 | Supervisor install command preview：... |
| V0.82 | 当前版本 | Supervisor install preflight gate：`agent.js supervisor-install-dry-run` full JSON 增加 sanitized `installPreflight`，固定 `state:"blocked"`，所有 check 均为 `requiredForInstall:true` 且使用稳定 blockerCode；`--readiness-summary` 仍只输出 readinessSummary，不输出 command preview 或 installPreflight；不调用 launchctl、不读取进程列表、不安装、不启动、不写 LaunchAgents/plist/metadata、不连接 NAS、不触发备份/恢复、不执行远程命令、不回显 config path、sourcePath、serverUrl、NAS endpoint、credentialRef、token、Authorization 或 env 值，Gold 依旧 blocked |
```

In the Supervisor install dry-run foundation section, update the opening paragraph:

```md
V0.79 增加本地 `agent.js supervisor-install-dry-run --config <file>`，用于在不安装、不启动、不写 plist 的前提下输出 sanitized supervisor 安装计划。V0.80 在该 dry-run 上增加 blocked readiness gate：完整计划包含 `readinessSummary.state:"blocked"`，并提供 `--readiness-summary` 与 `--fail-on-blocked` 供自动化判断。V0.81 在 full JSON 中增加 sanitized `installCommandPreview`，用于审计未来安装步骤，但其中所有 action 均不可执行且固定 `wouldRun:false` / `wouldWrite:false`。V0.82 在 full JSON 中增加 sanitized `installPreflight`，用于列出真实安装前仍阻塞的生产边界；所有 check 均固定 `status:"blocked"` 与 `requiredForInstall:true`，不执行探测、不读取主机状态、不写任何报告。
```

Add a bullet after the `installCommandPreview` bullet:

```md
- **installPreflight 字段**：由 `buildSupervisorInstallPreflight` 构造，只出现在完整 dry-run JSON 中，`--readiness-summary` 不输出该字段；当前固定返回 `state:"blocked"`、`blockedCount:6`、`readyCount:0`、`checkedCount:6`，check 包括 `installer-implementation`、`launchd-lifecycle`、`operator-approval`、`secret-management`、`monitoring-watchdog` 与 `rollback-recovery`，所有 check 都是安装前阻塞项，且固定 `status:"blocked"`、`requiredForInstall:true` 与稳定 `blockerCode`；preflight safety 固定 `dryRun:true`、`preflightOnly:true`、`launchctlCalled:false`、`processListRead:false`、`filesystemWritten:false`、`metadataWritten:false`、`nasConnected:false`、`backupTriggered:false`、`restoreTriggered:false`、`remoteCommandExecuted:false` 与 `sensitiveValuesReturned:false`。
```

Update Gold boundary bullet:

```md
- **Gold 边界**：supervisor-install-dry-run、`buildSupervisorInstallReadinessSummary`、`buildSupervisorInstallCommandPreview`、`buildSupervisorInstallPreflight`、`--readiness-summary`、`--fail-on-blocked`、`readinessSummary.state:"blocked"`、`installCommandPreview.state:"blocked"` 与 `installPreflight.state:"blocked"` 只是 `automation-installation` 与 `production-hardening` 的 partial evidence；真实 installer、launchd install/start、watchdog、监控、rollback、recovery supervisor、部署硬化和生产安全边界仍未实现，Gold 发布仍 blocked。
```

Search README for V0.81 current phrasing and update it to V0.82. V0.81 must be historical.

- [ ] **Step 8: Run GREEN docs/version tests**

Run:

```bash
node --test test/version.test.js test/gold-readiness.test.js test/readme.test.js test/agent-supervisor-install-dry-run.test.js
```

Expected: PASS.

- [ ] **Step 9: Commit Task 2**

Run:

```bash
git add src/version.js src/gold-readiness.js README.md test/version.test.js test/gold-readiness.test.js test/readme.test.js docs/superpowers/plans/2026-07-07-supervisor-install-preflight-gate.md
git commit -m "docs: document supervisor install preflight gate"
git push
```

Expected: commit and push succeed.

---

### Task 3: Full Verification, External Review, And Closure

**Files:**
- Modify: `docs/superpowers/plans/2026-07-07-supervisor-install-preflight-gate.md`

**Interfaces:**
- Consumes: all V0.82 changes
- Produces: verification evidence, Qwen adversarial review result, DeepSeek auxiliary closure result, final commit/push notes

- [ ] **Step 1: Run full local verification**

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
rg -n "production ready|Gold ready|real NAS remote backup ready|daemon installed|launchd installed|always-running|real installer implemented|real install ready|production-ready supervisor|真实 NAS 备份已实现|生产可用" README.md src
```

Expected: no matches except if the pattern appears only inside a documented verification command in a plan file; for `README.md src`, expected no matches.

- [ ] **Step 2: Run Qwen read-only adversarial review**

Run Qwen with this prompt:

```bash
qwen -p "You are the read-only adversarial reviewer for Linke V0.82. Review the current git diff and repository state. Do not modify files. Verify that V0.82 only adds a sanitized static installPreflight gate to supervisor-install-dry-run full JSON; readiness-summary excludes installPreflight; no real installer, launchctl call, process list read, launchd install/start, plist write, metadata write, NAS connection, backup, restore, remote command, or sensitive value/path output is introduced; Gold remains blocked; tests are sufficient. Return exactly: VERDICT: PASS or FAIL. FINDINGS: list. TEST GAPS: list. REQUIRED CHANGES: list or none. CONFIDENCE: low/medium/high." -o text
```

Expected: `VERDICT: PASS`. If Qwen returns `FAIL` or concrete findings, record them here and fix only accepted findings after PM review.

- [ ] **Step 3: Run DeepSeek JSON-only auxiliary closure**

Run DeepSeek with an evidence-rich prompt after local verification and Qwen review:

```bash
deepseek -q "You are an auxiliary release verifier for Linke V0.82. Use only the evidence in this prompt. Do not ask for tools. Do not modify files. Return only one JSON object with schema: {\"verdict\":\"PASS|FAIL|INCONCLUSIVE\",\"accepted\":true|false,\"blocking_findings\":[],\"evidence_checked\":[],\"unverified_items\":[],\"gold_status\":\"blocked|ready|unknown\",\"risk\":\"low|medium|high\",\"reason\":\"short\"}. PASS only if evidence proves V0.82 adds a sanitized static installPreflight gate to supervisor-install-dry-run full JSON; every check is blocked and requiredForInstall:true; readiness-summary excludes installCommandPreview and installPreflight; fail-on-blocked still prints JSON and exits 2; no launchctl, process-list, launchd install/start, plist write, metadata write, NAS connection, backup, restore, or remote command behavior is introduced; sensitive values and local paths are not returned; Gold remains blocked. Evidence: src/agent.js exports buildSupervisorInstallPreflight and buildSupervisorInstallDryRunPlan includes installPreflight in full output. test/agent-supervisor-install-dry-run.test.js asserts installPreflight deepStrictEqual to the expected blocked fixture, six fixed check IDs, every check status blocked, every check requiredForInstall true, stable blockerCode strings, safety dryRun true, preflightOnly true, launchctlCalled false, processListRead false, filesystemWritten false, metadataWritten false, nasConnected false, backupTriggered false, restoreTriggered false, remoteCommandExecuted false, sensitiveValuesReturned false, and no sensitive evidence strings. Tests assert --readiness-summary output excludes installCommandPreview and installPreflight. Tests assert --fail-on-blocked exits 2 and full output includes installPreflight. src/version.js exports V0.82. README documents V0.82, installPreflight.state blocked, installPreflight.checks requiredForInstall true, readiness-summary exclusion, no launchctl, no LaunchAgents write, no NAS connection, and Gold remains blocked. src/gold-readiness.js keeps automation-installation and production-hardening partial, real-nas-remote-backup blocked, and includes buildSupervisorInstallPreflight evidence. PM local verification completed before this call: node --test --test-reporter=dot test/*.test.js exited 0; git diff --check exited 0; the README/src overclaim scan returned no matches; Qwen read-only adversarial review returned VERDICT PASS with no blocking findings. Required output: JSON only." --no-stream --json -r
```

Expected: structured JSON with `verdict:"PASS"`, `accepted:true`, `blocking_findings:[]`, `gold_status:"blocked"`.

If DeepSeek returns `INCONCLUSIVE`, improve the evidence summary with concrete source/test facts and run once more. Do not use ZAI as a required verifier for V0.82.

- [ ] **Step 4: Record closure evidence**

Append an `Observed:` block under this task with:

```md
Observed:
- Full local tests: `<command>` exited `<code>`.
- `git diff --check`: exited `<code>`.
- Overclaim scan: `<result>`.
- Qwen review: `<verdict summary>`.
- DeepSeek closure: `<verdict summary>`.
- ZAI: not required for V0.82 due V0.81 repeated fixed generic response; no PASS/FAIL accepted from ZAI.
```

- [ ] **Step 5: Commit Task 3 closure notes**

Run:

```bash
git add docs/superpowers/plans/2026-07-07-supervisor-install-preflight-gate.md
git commit -m "docs: close supervisor install preflight gate plan"
git push
```

Expected: commit and push succeed.

---

## Stop Conditions

- Stop and record `SUB_AGENT_REVIEW_HOLD` if any worker claims PASS without schema, gives stale V0.81 findings, changes files while assigned read-only review, or contradicts local evidence.
- Stop if local tests fail after two fix attempts with the same failure signature.
- Stop if any implementation introduces system writes, launchctl calls, process list reads, NAS connections, backup/restore execution, or remote commands.
- Stop if README or Gold readiness claims production readiness, Gold readiness, real installer readiness, daemon installed, launchd installed, always-running supervisor, or real NAS remote backup readiness.

## Completion Criteria

- `buildSupervisorInstallPreflight()` is exported and covered by tests.
- Full `supervisor-install-dry-run` JSON includes `installPreflight`.
- `--readiness-summary` excludes `installCommandPreview` and `installPreflight`.
- `--fail-on-blocked` still prints JSON and exits `2` when blocked.
- No new write/system/NAS/backup/restore/remote-command behavior exists.
- V0.82 version, README, and Gold readiness evidence are synchronized.
- Gold remains blocked.
- Full local tests, diff check, overclaim scan, Qwen review, and DeepSeek auxiliary closure are recorded.
