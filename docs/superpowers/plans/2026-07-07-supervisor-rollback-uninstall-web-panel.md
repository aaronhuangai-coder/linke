# Supervisor Rollback Uninstall Web Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the existing V0.85 `rollbackUninstallPlan` inside the Web Console supervisor install dry-run panel without adding any lifecycle execution.

**Architecture:** Reuse the existing `POST /api/supervisor-install-dry-run` route and extend only the Web view-model/rendering allowlist. Documentation/version/Gold updates are a separate task so tests that protect long-lived safety wording are not deleted or weakened.

**Tech Stack:** Node.js built-in test runner, vanilla browser JavaScript in `src/web/app.js`, static HTML/CSS, existing `src/gold-readiness.js` scorecard.

## Global Constraints

- No new API route in V0.86.
- No real rollback, uninstall, recovery supervisor start, install, start, stop, unload, remove, approval, `launchctl`, process list read, filesystem write, metadata write, NAS connection, backup, restore, remote copy, or remote command.
- No raw JSON rendering for `rollbackUninstallPlan`.
- The Web view model may render only `action.id`, `action.kind`, `action.status`, `action.wouldRun`, `action.wouldWrite`, `action.blockerCode`, and allowlisted safety booleans.
- Do not render `action.evidence`, `rollback.evidence`, `uninstall.evidence`, `recovery.evidence`, `command`, `program`, `configSummary`, `serverUrl`, `sourcePath`, NAS endpoint, `remotePath`, `credentialRef`, token values, Authorization headers, environment values, approval identity, timestamps, hostnames, usernames, process ids, home paths, plist paths, executable paths, or runnable command arguments.
- `automation-installation` and `production-hardening` must remain `partial`.
- `real-nas-remote-backup` must remain `blocked`.
- Gold must remain blocked.
- The only new Gold evidence strings permitted for V0.86 are `rollbackUninstallPlan Web Console rendering`, `buildSupervisorInstallDryRunViewModel rollbackUninstallActions`, and `buildSupervisorInstallDryRunViewModel rollbackUninstallSafetyLines`.

---

### Task 1: Web View-Model and Rendering

**Files:**
- Modify: `src/web/app.js`
- Modify: `test/web-console.test.js`

**Interfaces:**
- Consumes: `plan.rollbackUninstallPlan` from the existing `POST /api/supervisor-install-dry-run` response.
- Produces: `buildSupervisorInstallDryRunViewModel(plan).rollbackUninstallActions: string[]`.
- Produces: `buildSupervisorInstallDryRunViewModel(plan).rollbackUninstallSafetyLines: string[]`.
- Produces: `rollbackStateText` value `rollback:false / uninstall:false / recovery:false` when `rollbackUninstallPlan` exists.

- [ ] **Step 1: Extend missing/error payload tests first**

In `test/web-console.test.js`, in `describe('buildSupervisorInstallDryRunViewModel', ...)`, update the missing payload test with these assertions after the existing rollback state assertion:

```js
assert.deepStrictEqual(result.rollbackUninstallActions, []);
assert.deepStrictEqual(result.rollbackUninstallSafetyLines, []);
```

Update the sanitized error-state test with:

```js
assert.deepStrictEqual(result.rollbackUninstallActions, []);
assert.deepStrictEqual(result.rollbackUninstallSafetyLines, []);
```

- [ ] **Step 2: Add the RED view-model fixture assertions**

In the existing `returns sanitized blocked display fields for a full dry-run plan` test, add this `rollbackUninstallPlan` object to the fixture before `safety`:

```js
rollbackUninstallPlan: {
  state: 'blocked',
  rollback: {
    available: false,
    evidence: 'restore previous plist from /Users/ah/Library/LaunchAgents/com.linke.agent.plist',
  },
  uninstall: {
    available: false,
    evidence: 'run launchctl unload and rm secret plist',
  },
  recovery: {
    available: false,
    evidence: 'start recovery supervisor on hostname secret-host pid 42',
  },
  actions: [
    {
      id: 'capture-current-state',
      kind: 'rollback',
      status: 'blocked',
      command: 'launchctl print gui/501/com.linke.agent',
      evidence: 'read /Users/ah/private-state.json',
      wouldRun: false,
      wouldWrite: false,
      blockerCode: 'rollback-state-capture-missing',
    },
    {
      id: 'unload-launch-agent',
      kind: 'uninstall',
      status: 'blocked',
      command: 'launchctl bootout gui/501 /Users/ah/Library/LaunchAgents/com.linke.agent.plist',
      evidence: 'operator Aaron timestamp 2026-07-07T00:00:00Z',
      wouldRun: false,
      wouldWrite: false,
      blockerCode: 'launchd-unload-blocked',
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
},
```

Add these assertions after the existing approval-control assertions:

```js
assert.strictEqual(result.rollbackStateText, 'rollback:false / uninstall:false / recovery:false');
assert.deepStrictEqual(result.rollbackUninstallActions, [
  'capture-current-state · rollback · blocked · wouldRun:false · wouldWrite:false · rollback-state-capture-missing',
  'unload-launch-agent · uninstall · blocked · wouldRun:false · wouldWrite:false · launchd-unload-blocked',
]);
assert.ok(result.rollbackUninstallSafetyLines.includes('dryRun:true'));
assert.ok(result.rollbackUninstallSafetyLines.includes('planOnly:true'));
assert.ok(result.rollbackUninstallSafetyLines.includes('rollbackExecuted:false'));
assert.ok(result.rollbackUninstallSafetyLines.includes('uninstallExecuted:false'));
assert.ok(result.rollbackUninstallSafetyLines.includes('recoverySupervisorStarted:false'));
assert.ok(result.rollbackUninstallSafetyLines.includes('launchctlCalled:false'));
assert.ok(result.rollbackUninstallSafetyLines.includes('processListRead:false'));
assert.ok(result.rollbackUninstallSafetyLines.includes('filesystemWritten:false'));
assert.ok(result.rollbackUninstallSafetyLines.includes('metadataWritten:false'));
assert.ok(result.rollbackUninstallSafetyLines.includes('supervisorInstalled:false'));
assert.ok(result.rollbackUninstallSafetyLines.includes('supervisorStarted:false'));
assert.ok(result.rollbackUninstallSafetyLines.includes('launchdFileWritten:false'));
assert.ok(result.rollbackUninstallSafetyLines.includes('launchdFileRemoved:false'));
assert.ok(result.rollbackUninstallSafetyLines.includes('previousPlistRestored:false'));
assert.ok(result.rollbackUninstallSafetyLines.includes('sensitiveValuesReturned:false'));
assert.ok(!text.includes('restore previous plist'), 'view model must not expose lifecycle evidence');
assert.ok(!text.includes('launchctl bootout'), 'view model must not expose runnable rollback command');
assert.ok(!text.includes('secret-host'), 'view model must not expose hostnames');
assert.ok(!text.includes('pid 42'), 'view model must not expose process identifiers');
assert.ok(!text.includes('2026-07-07T00:00:00Z'), 'view model must not expose timestamps');
```

- [ ] **Step 3: Run the RED test**

Run:

```bash
node --test --test-reporter=dot test/web-console.test.js
```

Expected: FAIL because `rollbackUninstallActions`, `rollbackUninstallSafetyLines`, and the richer `rollbackStateText` are not implemented yet.

- [ ] **Step 4: Implement allowlisted lifecycle helpers**

`formatAuditDisplayString(value, maxLength = 160)` already exists in `src/web/app.js` and should only be reused for the allowlisted scalar fields named in this plan. Do not pass raw `evidence`, `command`, `program`, path, URL, credential, host, user, process, plist, executable, or timestamp fields through that helper.

In `src/web/app.js`, add these constants near the existing supervisor install dry-run helpers:

```js
const SUPERVISOR_ROLLBACK_UNINSTALL_SAFETY_KEYS = [
  'dryRun',
  'planOnly',
  'rollbackExecuted',
  'uninstallExecuted',
  'recoverySupervisorStarted',
  'launchctlCalled',
  'processListRead',
  'filesystemWritten',
  'metadataWritten',
  'supervisorInstalled',
  'supervisorStarted',
  'launchdFileWritten',
  'launchdFileRemoved',
  'previousPlistRestored',
  'nasConnected',
  'backupTriggered',
  'restoreTriggered',
  'remoteCommandExecuted',
  'sensitiveValuesReturned',
];
```

Add this helper near `buildSupervisorInstallSafetyLines(source)`:

```js
function buildSupervisorRollbackUninstallSafetyLines(source) {
  if (!source || typeof source !== 'object') return [];
  return SUPERVISOR_ROLLBACK_UNINSTALL_SAFETY_KEYS.map((key) => `${key}:${source[key] === true ? 'true' : 'false'}`);
}
```

In `buildSupervisorInstallDryRunViewModel(plan, errorMessage = '')`:

- Add `rollbackUninstallActions: []` and `rollbackUninstallSafetyLines: []` to the error and unknown return objects.
- Add:

```js
const rollbackUninstallPlan = plan.rollbackUninstallPlan && typeof plan.rollbackUninstallPlan === 'object' ? plan.rollbackUninstallPlan : {};
const rollbackPlan = rollbackUninstallPlan.rollback && typeof rollbackUninstallPlan.rollback === 'object' ? rollbackUninstallPlan.rollback : null;
const uninstallPlan = rollbackUninstallPlan.uninstall && typeof rollbackUninstallPlan.uninstall === 'object' ? rollbackUninstallPlan.uninstall : null;
const recoveryPlan = rollbackUninstallPlan.recovery && typeof rollbackUninstallPlan.recovery === 'object' ? rollbackUninstallPlan.recovery : null;
const hasRollbackUninstallPlan = Boolean(rollbackPlan || uninstallPlan || recoveryPlan || Array.isArray(rollbackUninstallPlan.actions));
```

- Change `rollbackStateText` to:

```js
rollbackStateText: hasRollbackUninstallPlan
  ? `rollback:${rollbackPlan?.available === true ? 'true' : 'false'} / uninstall:${uninstallPlan?.available === true ? 'true' : 'false'} / recovery:${recoveryPlan?.available === true ? 'true' : 'false'}`
  : `available:${rollback.available === true ? 'true' : 'false'}`,
```

- Add:

```js
rollbackUninstallActions: Array.isArray(rollbackUninstallPlan.actions)
  ? rollbackUninstallPlan.actions.map((action) => {
    const source = action && typeof action === 'object' ? action : {};
    return `${formatAuditDisplayString(source.id) || 'unknown'} · ${formatAuditDisplayString(source.kind) || 'unknown'} · ${formatAuditDisplayString(source.status) || 'unknown'} · wouldRun:${source.wouldRun === true ? 'true' : 'false'} · wouldWrite:${source.wouldWrite === true ? 'true' : 'false'} · ${formatAuditDisplayString(source.blockerCode) || 'none'}`;
  })
  : [],
rollbackUninstallSafetyLines: buildSupervisorRollbackUninstallSafetyLines(rollbackUninstallPlan.safety),
```

- [ ] **Step 5: Render lifecycle groups**

In `renderSupervisorInstallDryRun(viewModel)`, insert these calls after `appendSupervisorInstallGroup('Approval manifest', state.approvalControls);` and before top-level safety flags:

```js
appendSupervisorInstallGroup('Rollback / uninstall plan', state.rollbackUninstallActions);
appendSupervisorInstallGroup('Rollback / uninstall safety flags', state.rollbackUninstallSafetyLines);
```

- [ ] **Step 6: Extend the DOM click test**

In `test/web-console.test.js`, in `requests supervisor install dry-run once and renders sanitized blocked plan fields`, add this `rollbackUninstallPlan` to the mocked API response before `safety`:

```js
rollbackUninstallPlan: {
  state: 'blocked',
  rollback: { available: false, evidence: 'restore /Users/ah/Library/LaunchAgents/com.linke.agent.plist' },
  uninstall: { available: false, evidence: 'launchctl bootout secret' },
  recovery: { available: false, evidence: 'recovery hostname secret-host pid 42' },
  actions: [
    {
      id: 'capture-current-state',
      kind: 'rollback',
      status: 'blocked',
      command: 'launchctl print secret',
      evidence: 'private /Users/ah/state.json',
      wouldRun: false,
      wouldWrite: false,
      blockerCode: 'rollback-state-capture-missing',
    },
    {
      id: 'unload-launch-agent',
      kind: 'uninstall',
      status: 'blocked',
      command: 'launchctl bootout secret',
      evidence: 'operator Aaron timestamp',
      wouldRun: false,
      wouldWrite: false,
      blockerCode: 'launchd-unload-blocked',
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
},
```

Add these assertions after the existing result text checks:

```js
assert.strictEqual(doc.getElementById('supervisor-install-dry-run-rollback-state').textContent, 'rollback:false / uninstall:false / recovery:false');
assert.match(resultText, /Rollback \/ uninstall plan/);
assert.match(resultText, /capture-current-state/);
assert.match(resultText, /unload-launch-agent/);
assert.match(resultText, /wouldWrite:false/);
assert.match(resultText, /rollback-state-capture-missing/);
assert.match(resultText, /rollbackExecuted:false/);
assert.match(resultText, /uninstallExecuted:false/);
assert.match(resultText, /recoverySupervisorStarted:false/);
assert.match(resultText, /previousPlistRestored:false/);
assert.ok(!resultText.includes('launchctl bootout secret'), 'must not render runnable rollback command');
assert.ok(!resultText.includes('private /Users/ah/state.json'), 'must not render lifecycle evidence paths');
assert.ok(!resultText.includes('secret-host'), 'must not render hostnames from lifecycle evidence');
assert.ok(!resultText.includes('operator Aaron timestamp'), 'must not render approval identity or timestamp evidence');
```

- [ ] **Step 7: Run focused Web tests**

Run:

```bash
node --test --test-reporter=dot test/web-console.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

Run:

```bash
git add src/web/app.js test/web-console.test.js
git diff --cached --check
git commit -m "feat: render supervisor rollback uninstall dry-run plan"
```

---

### Task 2: Version, Documentation, and Gold Boundaries

**Files:**
- Modify: `src/web/index.html`
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `README.md`
- Modify: `test/web-console.test.js`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**
- Consumes: Task 1 Web rendering contract.
- Produces: `V0.86` visible version/docs state.
- Produces: exact display-only Gold evidence strings while keeping Gold blocked.

- [ ] **Step 1: Update tests for version and Gold evidence**

In `test/version.test.js`, replace the expected current version with:

```js
assert.strictEqual(VERSION, 'V0.86');
```

In `test/gold-readiness.test.js`, add assertions that both `automation-installation` and `production-hardening` evidence arrays include exactly:

```js
'rollbackUninstallPlan Web Console rendering',
'buildSupervisorInstallDryRunViewModel rollbackUninstallActions',
'buildSupervisorInstallDryRunViewModel rollbackUninstallSafetyLines',
```

Keep existing assertions that these items remain `partial` and that `real-nas-remote-backup` remains `blocked`.

- [ ] **Step 2: Update Web safety-note tests**

In `test/web-console.test.js`, extend the `supervisor-install-dry-run panel safety note documents manual dry-run boundaries and avoids Gold overclaims` test so the panel content must include:

```js
assert.ok(/rollback|uninstall|recovery supervisor/i.test(content), 'must mention lifecycle dry-run blockers');
assert.ok(content.includes('不执行 rollback 或 uninstall'), 'must say rollback and uninstall are not executed');
assert.ok(/不删除 launchd 文件/.test(content), 'must say launchd files are not deleted');
assert.ok(/不恢复 previous plist/.test(content), 'must say previous plist is not restored');
assert.ok(/不启动 recovery supervisor/.test(content), 'must say recovery supervisor is not started');
assert.ok(/raw evidence|runnable command/.test(content), 'must mention raw evidence and runnable command are not displayed');
```

- [ ] **Step 3: Update README tests without deleting long-lived safety coverage**

In `test/readme.test.js`, replace the V0.85 current-version assertions with V0.86 current-version assertions. Preserve the long-lived version-neutral safety describe block.

Add or update assertions requiring README to contain:

```js
assertReadmeContains(/当前版本：V0\.86/, 'README should identify V0.86 as current');
assertReadmeContains(/\| V0\.86 \| 当前版本 \| Supervisor rollback uninstall Web dry-run panel/i, 'README should document V0.86 current version row');
assertReadmeContains(/rollbackUninstallPlan Web Console rendering/i, 'README should mention display-only rollbackUninstallPlan Web evidence');
assertReadmeContains(/buildSupervisorInstallDryRunViewModel rollbackUninstallActions/i, 'README should mention rollbackUninstallActions evidence');
assertReadmeContains(/buildSupervisorInstallDryRunViewModel rollbackUninstallSafetyLines/i, 'README should mention rollbackUninstallSafetyLines evidence');
assertReadmeContains(/Gold (?:依旧|仍) blocked/i, 'README should keep Gold blocked');
assertReadmeDoesNotContain(/rollback ready|uninstall ready|recovery supervisor ready|Gold ready|production-ready supervisor/i, 'README must not claim lifecycle or Gold readiness');
```

Add negative checks so V0.85 is historical:

```js
assertReadmeDoesNotContain(/\| V0\.85 \| 当前版本/i, 'V0.85 should no longer be the current version row');
assertReadmeContains(/\| V0\.85 \| 历史版本/i, 'V0.85 should be historical after V0.86');
```

- [ ] **Step 4: Run RED docs/version tests**

Run:

```bash
node --test --test-reporter=dot test/version.test.js test/gold-readiness.test.js test/readme.test.js test/web-console.test.js
```

Expected: FAIL until implementation updates version/docs/copy.

- [ ] **Step 5: Update implementation files**

In `src/version.js`, change:

```js
export const VERSION = 'V0.86';
```

In `src/web/index.html`, replace the supervisor install dry-run safety note paragraph with text that preserves the current boundaries and adds lifecycle display-only wording:

```html
<p>Supervisor install dry-run 仅手动 POST /api/supervisor-install-dry-run 生成只读预览，可展示 install、approval、rollback、uninstall 与 recovery supervisor 的 blocked dry-run 计划；无启动请求、不自动轮询、不调用 launchctl、不读取进程列表、不安装或启动 supervisor、不执行 rollback 或 uninstall、不删除 launchd 文件、不恢复 previous plist、不启动 recovery supervisor、不写入 metadata、不连接 NAS、不触发备份或恢复、不执行远程命令；仅展示 allowlist 字段，不显示 token、Authorization header、serverUrl、sourcePath、NAS endpoint、credentialRef、approval identity、timestamp、hostname、username、process id、plist path、executable path、raw evidence 或 runnable command；Gold 仍 blocked，不能声明生产就绪。</p>
```

In `src/gold-readiness.js`, add these exact strings to both `automation-installation.evidence` and `production-hardening.evidence` near the existing Web Console supervisor install dry-run entries:

```js
'rollbackUninstallPlan Web Console rendering',
'buildSupervisorInstallDryRunViewModel rollbackUninstallActions',
'buildSupervisorInstallDryRunViewModel rollbackUninstallSafetyLines',
```

Do not change those capability statuses away from `partial`. Do not change `real-nas-remote-backup` away from `blocked`.

In `README.md`, update:

- Current version summary to V0.86.
- Version table: V0.86 current row and V0.85 historical row.
- Web panel section to mention rendering `rollbackUninstallPlan` actions and lifecycle safety flags.
- Gold boundary section to list only display-only evidence and keep rollback/uninstall/recovery readiness blocked.

- [ ] **Step 6: Run focused docs/version tests**

Run:

```bash
node --test --test-reporter=dot test/version.test.js test/gold-readiness.test.js test/readme.test.js test/web-console.test.js
```

Expected: PASS.

- [ ] **Step 7: Run broader regression tests**

Run:

```bash
node --test --test-reporter=dot test/agent-supervisor-install-dry-run.test.js test/gold-readiness.test.js test/readme.test.js test/version.test.js test/web-console.test.js
node --test --test-reporter=dot test/*.test.js
git diff --check
```

Expected: PASS for both test commands and no diff-check output.

- [ ] **Step 8: Commit Task 2**

Run:

```bash
git add src/web/index.html src/version.js src/gold-readiness.js README.md test/web-console.test.js test/version.test.js test/gold-readiness.test.js test/readme.test.js
git diff --cached --check
git commit -m "docs: document supervisor rollback uninstall web panel"
```

---

### Task 3: Final Review and Closure

**Files:**
- No required code changes.
- Update only ignored PM ledger `.superpowers/sdd/progress.md` if useful for local workflow.

**Interfaces:**
- Consumes: Task 1 and Task 2 commits.
- Produces: final PM acceptance, Qwen adversarial review, DeepSeek closure, and pushed branch.

- [ ] **Step 1: Verify branch state**

Run:

```bash
git status --short --branch
git log --oneline --decorate -5
```

Expected: clean tracked worktree before final review.

- [ ] **Step 2: Run final verification**

Run:

```bash
node --test --test-reporter=dot test/*.test.js
git diff --check 0f60d4c..HEAD
rg -n "# Linke V0\\.85|当前版本：V0\\.85|\\| V0\\.85 \\| 当前版本|Gold ready|rollback ready|uninstall ready|recovery supervisor ready|production-ready supervisor|rollbackExecuted: true|uninstallExecuted: true|recoverySupervisorStarted: true|launchctlCalled: true|processListRead: true|filesystemWritten: true|metadataWritten: true|nasConnected: true|backupTriggered: true|restoreTriggered: true|remoteCommandExecuted: true" README.md src test
```

Expected:

- Full tests PASS.
- Diff check has no output.
- Overclaim scan returns only negative test assertions or pre-existing invalid fixtures outside the V0.86 diff.

- [ ] **Step 3: Qwen final adversarial review**

Run a read-only Qwen review over `0f60d4c..HEAD` with this required verdict shape:

```text
VERDICT: PASS or FAIL.
BLOCKERS: numbered list or none.
EVIDENCE: max 5 bullets.
RISK: low/medium/high.
```

The review must check:

- V0.86 only renders existing `rollbackUninstallPlan` in the Web panel.
- No new API route.
- No real lifecycle execution behavior.
- No raw evidence, commands, paths, tokens, hostnames, users, process ids, plist paths, executable paths, or runnable command arguments are rendered.
- Gold remains blocked and no lifecycle readiness is claimed.

- [ ] **Step 4: DeepSeek final closure**

Run a DeepSeek JSON-only closure using PM evidence and Qwen result. Required schema:

```json
{
  "verdict": "PASS|FAIL|INCONCLUSIVE",
  "accepted": true,
  "blocking_findings": [],
  "evidence_checked": [],
  "remaining_risks": [],
  "gold_status": "blocked|ready|unknown",
  "branch_status": "pushed|unpushed|unknown",
  "reason": "short"
}
```

- [ ] **Step 5: Push**

If all gates pass, push:

```bash
git push
```

Expected: `origin/linke-v0.12-web-panel` advances to the final V0.86 commit.
