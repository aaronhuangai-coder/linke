# Supervisor Lifecycle Apply Safety Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the V0.87 supervisor lifecycle apply safety-gate foundation without enabling default host mutation.

**Architecture:** Add a pure lifecycle safety module for approval validation, hash binding, path allowlists, and blocked/ready plan construction. Add an Agent CLI entry that defaults to dry-run/blocked reports and refuses mutation unless all gates are present; real host mutation remains deferred behind a fake-executor-tested contract.

**Tech Stack:** Node.js ESM, built-in `node:test`, existing `src/agent.js` CLI parser, existing config validation, existing audit vocabulary.

## Global Constraints

- No Web lifecycle execution button in V0.87.
- No API lifecycle endpoint in V0.87.
- No default host mutation.
- No real `launchctl` call in tests.
- No writes to real `~/Library/LaunchAgents` in tests.
- No `sudo`, root LaunchDaemons, shell-string execution, unbounded deletion, symlink-following writes, or broad filesystem writes.
- Actual apply remains blocked unless `--apply`, `LINKE_SUPERVISOR_LIFECYCLE_APPLY=enabled`, valid approval, matching config hash, matching plan hash, allowed paths, rollback anchor, audit sink, and a fake-executor-tested lifecycle executor are all present.
- V0.87 does not include that executor, so every `--apply` path returns blocker code `executor-implementation-missing` and performs no host mutation.
- The design-level `executeSupervisorLifecycleApply(plan, executor)` contract and its retry cap of 2 attempts per step remain explicit follow-up work; V0.87 records the missing executor rather than silently omitting it.
- `recover` remains blocked until a separate recovery-supervisor design exists.
- Gold remains blocked.

---

### Task 1: Pure Lifecycle Safety Gate Module

**Files:**
- Create: `src/supervisor-lifecycle.js`
- Create: `test/supervisor-lifecycle.test.js`

**Interfaces:**
- Produces: `hashLifecycleObject(value): string`
- Produces: `validateSupervisorLifecycleApproval(approval, expected): { valid: boolean, blockers: string[] }`
- Produces: `resolveSupervisorLifecyclePathBoundary(input, options): { allowed: boolean, path?: string, blockerCode?: string }`
- Produces: `buildSupervisorLifecycleApplyPlan(config, options): object`

- [ ] **Step 1: Write RED approval/hash/path tests**

Create `test/supervisor-lifecycle.test.js` with tests that import the four functions above.

Required tests and assertions:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import {
  buildSupervisorLifecycleApplyPlan,
  hashLifecycleObject,
  resolveSupervisorLifecyclePathBoundary,
  validateSupervisorLifecycleApproval,
} from '../src/supervisor-lifecycle.js';

const NOW = new Date('2026-07-07T05:00:00.000Z');
const APPROVED_AT = '2026-07-07T04:30:00.000Z';
const EXPIRES_AT = '2026-07-07T05:30:00.000Z';
const BASE_CONFIG = Object.freeze({
  serverUrl: 'http://localhost:3000',
  deviceId: 'macbook-alpha',
  backupJobs: [{ name: 'Documents', sourcePath: '/Users/ah/Documents' }],
});
const EXPECTED = Object.freeze({
  operation: 'install',
  configHash: 'sha256:config',
  planHash: 'sha256:plan',
});

function validApproval(overrides = {}) {
  return {
    operation: 'install',
    configHash: 'sha256:config',
    planHash: 'sha256:plan',
    approved: true,
    schemaVersion: 1,
    approvedBy: 'operator@example.invalid',
    reason: 'V0.87 safety-gate test approval',
    acknowledgements: ['no-real-host-mutation-in-v0.87'],
    approvedAt: APPROVED_AT,
    expiresAt: EXPIRES_AT,
    ignoredByExecutor: 'must-not-grant-approval',
    ...overrides,
  };
}

it('hashLifecycleObject returns stable sha256 hashes for normalized objects', () => {
  const first = hashLifecycleObject({ b: 2, a: { y: [3, 2], z: 1 } });
  const second = hashLifecycleObject({ a: { z: 1, y: [3, 2] }, b: 2 });
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.strictEqual(first, second);
  assert.notStrictEqual(first, hashLifecycleObject({ b: 3, a: { y: [3, 2], z: 1 } }));
});

it('validateSupervisorLifecycleApproval accepts exact matching approval within one hour', () => {
  const result = validateSupervisorLifecycleApproval(validApproval(), { ...EXPECTED, now: NOW });
  assert.deepStrictEqual(result, { valid: true, blockers: [] });
});

it('validateSupervisorLifecycleApproval rejects approvals that are not explicitly granted', () => {
  const result = validateSupervisorLifecycleApproval(
    validApproval({ approved: false }),
    { ...EXPECTED, now: NOW },
  );
  assert.deepStrictEqual(result.blockers, ['approval-not-granted']);
});

it('validateSupervisorLifecycleApproval rejects expired or over-wide approval windows', () => {
  assert.deepStrictEqual(
    validateSupervisorLifecycleApproval(validApproval({
      approvedAt: '2026-07-07T03:00:00.000Z',
      expiresAt: '2026-07-07T05:01:00.000Z',
    }), { ...EXPECTED, now: NOW }).blockers,
    ['approval-window-too-wide'],
  );
  assert.deepStrictEqual(
    validateSupervisorLifecycleApproval(validApproval({
      approvedAt: '2026-07-07T03:00:00.000Z',
      expiresAt: '2026-07-07T04:00:00.000Z',
    }), { ...EXPECTED, now: NOW }).blockers,
    ['approval-expired'],
  );
});

it('validateSupervisorLifecycleApproval rejects operation, configHash, and planHash mismatches', () => {
  const result = validateSupervisorLifecycleApproval(validApproval({
    operation: 'rollback',
    configHash: 'sha256:other-config',
    planHash: 'sha256:other-plan',
  }), { ...EXPECTED, now: NOW });
  assert.deepStrictEqual(result.blockers, [
    'approval-operation-mismatch',
    'approval-config-hash-mismatch',
    'approval-plan-hash-mismatch',
  ]);
});

it('resolveSupervisorLifecyclePathBoundary allows user LaunchAgents, staging root, and metadata root only', () => {
  const options = {
    userLaunchAgentsDir: '/Users/ah/Library/LaunchAgents',
    stagingRoot: '/tmp/linke-supervisor-staging',
    metadataRoot: '/tmp/linke-supervisor-metadata',
  };
  assert.strictEqual(resolveSupervisorLifecyclePathBoundary('/Users/ah/Library/LaunchAgents/com.linke.agent.plist', options).allowed, true);
  assert.strictEqual(resolveSupervisorLifecyclePathBoundary('/tmp/linke-supervisor-staging/com.linke.agent.plist', options).allowed, true);
  assert.strictEqual(resolveSupervisorLifecyclePathBoundary('/tmp/linke-supervisor-metadata/rollback.json', options).allowed, true);
  assert.deepStrictEqual(
    resolveSupervisorLifecyclePathBoundary('/Users/ah/Desktop/com.linke.agent.plist', options),
    { allowed: false, blockerCode: 'path-outside-allowed-roots' },
  );
});

it('resolveSupervisorLifecyclePathBoundary rejects traversal and symlink-like unresolved paths', () => {
  const options = { userLaunchAgentsDir: '/Users/ah/Library/LaunchAgents', stagingRoot: '/tmp/staging' };
  assert.deepStrictEqual(
    resolveSupervisorLifecyclePathBoundary('/tmp/staging/../escape.plist', options),
    { allowed: false, blockerCode: 'path-traversal-or-unresolved' },
  );
  assert.deepStrictEqual(
    resolveSupervisorLifecyclePathBoundary('', options),
    { allowed: false, blockerCode: 'path-not-string' },
  );
});

it('buildSupervisorLifecycleApplyPlan blocks recover until recovery supervisor design exists', () => {
  const plan = buildSupervisorLifecycleApplyPlan(BASE_CONFIG, { operation: 'recover', now: NOW });
  assert.strictEqual(plan.operation, 'recover');
  assert.strictEqual(plan.state, 'blocked');
  assert.ok(plan.blockers.includes('recovery-supervisor-design-missing'));
  assert.strictEqual(plan.safety.launchctlCalled, false);
  assert.strictEqual(plan.safety.filesystemWritten, false);
});

it('buildSupervisorLifecycleApplyPlan defaults to blocked dry-run with no host mutation', () => {
  const plan = buildSupervisorLifecycleApplyPlan(BASE_CONFIG, { operation: 'install', now: NOW });
  assert.strictEqual(plan.mode, 'dry-run-only');
  assert.strictEqual(plan.operation, 'install');
  assert.strictEqual(plan.applyRequested, false);
  assert.strictEqual(plan.state, 'blocked');
  assert.ok(plan.blockers.includes('apply-flag-required'));
  assert.ok(plan.blockers.includes('executor-implementation-missing'));
  assert.match(plan.configHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(plan.planHash, /^sha256:[a-f0-9]{64}$/);
  assert.ok(plan.actions.every((action) => action.wouldRun === false && action.wouldWrite === false));
  assert.deepStrictEqual(plan.safety, {
    dryRun: true,
    hostMutation: false,
    launchctlCalled: false,
    filesystemWritten: false,
    metadataWritten: false,
    rollbackAnchorWritten: false,
    auditEventWritten: false,
    sensitiveValuesReturned: false,
  });
});
```

Run:

```bash
node --test --test-reporter=dot test/supervisor-lifecycle.test.js
```

Expected: FAIL because `src/supervisor-lifecycle.js` does not exist.

- [ ] **Step 2: Implement pure module**

Create `src/supervisor-lifecycle.js`.

Implementation requirements:

- Use `node:crypto` to produce `sha256:<hex>` hashes from stable JSON.
- Stable JSON sorts object keys recursively.
- Approval max window is exactly 1 hour.
- Approval must include `schemaVersion:1`, `approved:true`, non-empty `approvedBy`, non-empty `reason`, and non-empty `acknowledgements`.
- Unknown approval fields are ignored for execution and must not compensate for any required missing field.
- Approval blocker ordering must be deterministic: malformed or missing fields, not granted, window too wide, expired, operation mismatch, config hash mismatch, plan hash mismatch.
- Sanitized plans and CLI output must not include `approvedBy`, `reason`, or `acknowledgements`.
- Allowed operations are `install`, `uninstall`, `rollback`, and `recover`.
- `recover` returns blocked plan state with blocker code `recovery-supervisor-design-missing`.
- Missing `--apply` returns blocker code `apply-flag-required`.
- Missing `LINKE_SUPERVISOR_LIFECYCLE_APPLY=enabled` returns blocker code `env-gate-disabled`.
- Missing approval returns blocker code `approval-missing`; approval mismatch returns the exact mismatch codes used in the tests.
- V0.87 always includes blocker code `executor-implementation-missing` for `--apply`, because lifecycle execution is not implemented yet.
- Path boundary resolves paths with `node:path` and rejects paths outside either:
  - user LaunchAgents directory passed as `userLaunchAgentsDir`
  - staging root passed as `stagingRoot`
  - metadata root passed as `metadataRoot`
- Do not read `.env`, secrets, SSH keys, or credential directories.
- Do not write files.

Suggested exported shape:

```js
export function hashLifecycleObject(value) {
  // Return `sha256:<hex>` of stable JSON with recursively sorted object keys.
}

export function validateSupervisorLifecycleApproval(approval, expected) {
  // Return `{ valid, blockers }`; never throw for bad approval content.
}

export function resolveSupervisorLifecyclePathBoundary(input, options = {}) {
  // Return `{ allowed: true, path }` or `{ allowed: false, blockerCode }`.
}

export function buildSupervisorLifecycleApplyPlan(config, options = {}) {
  // Return a sanitized lifecycle plan with `actions`, `blockers`, `gates`, hashes, and safety booleans.
}
```

- [ ] **Step 3: Run GREEN tests**

Run:

```bash
node --test --test-reporter=dot test/supervisor-lifecycle.test.js
git diff --check
```

Expected: PASS.

- [ ] **Step 4: Commit Task 1**

```bash
git add src/supervisor-lifecycle.js test/supervisor-lifecycle.test.js
git diff --cached --check
git commit -m "feat: add supervisor lifecycle safety gate foundation"
```

---

### Task 2: Agent CLI Dry-Run and Blocked Apply Entry

**Files:**
- Modify: `src/agent.js`
- Create: `test/agent-supervisor-lifecycle-apply.test.js`

**Interfaces:**
- Consumes: `buildSupervisorLifecycleApplyPlan(config, options)`
- Produces: CLI command `supervisor-lifecycle-apply`

- [ ] **Step 1: Write RED CLI tests**

Create `test/agent-supervisor-lifecycle-apply.test.js`.

Required tests and assertions:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const agentPath = join(import.meta.dirname, '..', 'src', 'agent.js');

async function writeTempConfig(dir) {
  const configPath = join(dir, 'linke-config.json');
  await writeFile(configPath, JSON.stringify({
    serverUrl: 'http://localhost:3000',
    deviceId: 'macbook-alpha',
    backupJobs: [{ name: 'Documents', sourcePath: join(dir, 'Documents') }],
  }));
  return configPath;
}

async function runAgent(args, options = {}) {
  return exec(process.execPath, [agentPath, ...args], {
    env: { ...process.env, ...options.env },
  });
}

async function runAgentExpectExit(args, expectedCode, options = {}) {
  try {
    const result = await runAgent(args, options);
    assert.fail(`expected exit ${expectedCode}, got success with stdout ${result.stdout}`);
  } catch (error) {
    assert.strictEqual(error.code, expectedCode);
    return error;
  }
}

it('prints blocked dry-run plan without --apply and exits 0', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linke-lifecycle-cli-'));
  try {
    const configPath = await writeTempConfig(dir);
    const { stdout } = await runAgent(['supervisor-lifecycle-apply', '--config', configPath, '--operation', 'install']);
    const report = JSON.parse(stdout);
    assert.strictEqual(report.command, 'supervisor-lifecycle-apply');
    assert.strictEqual(report.mode, 'dry-run-only');
    assert.strictEqual(report.operation, 'install');
    assert.strictEqual(report.applyRequested, false);
    assert.strictEqual(report.state, 'blocked');
    assert.ok(report.blockers.includes('apply-flag-required'));
    assert.strictEqual(report.safety.launchctlCalled, false);
    assert.strictEqual(report.safety.filesystemWritten, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('--apply without env gate prints blocked report and exits 2 without writing files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linke-lifecycle-cli-'));
  const launchdDir = join(dir, 'LaunchAgents');
  try {
    const configPath = await writeTempConfig(dir);
    const error = await runAgentExpectExit([
      'supervisor-lifecycle-apply',
      '--config', configPath,
      '--operation', 'install',
      '--apply',
      '--launchd-dir', launchdDir,
    ], 2);
    const report = JSON.parse(error.stdout);
    assert.ok(report.blockers.includes('env-gate-disabled'));
    assert.ok(report.blockers.includes('executor-implementation-missing'));
    assert.strictEqual(report.safety.launchctlCalled, false);
    assert.strictEqual(report.safety.filesystemWritten, false);
    await assert.rejects(readdir(launchdDir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('--apply with missing approval prints blocked report and exits 2', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linke-lifecycle-cli-'));
  try {
    const configPath = await writeTempConfig(dir);
    const error = await runAgentExpectExit([
      'supervisor-lifecycle-apply',
      '--config', configPath,
      '--operation', 'rollback',
      '--apply',
    ], 2, { env: { LINKE_SUPERVISOR_LIFECYCLE_APPLY: 'enabled' } });
    const report = JSON.parse(error.stdout);
    assert.ok(report.blockers.includes('approval-missing'));
    assert.strictEqual(report.safety.metadataWritten, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('invalid operation exits 1 with sanitized error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linke-lifecycle-cli-'));
  try {
    const configPath = await writeTempConfig(dir);
    const error = await runAgentExpectExit([
      'supervisor-lifecycle-apply',
      '--config', configPath,
      '--operation', 'restart',
    ], 1);
    assert.match(error.stderr, /operation must be one of: install, uninstall, rollback, recover/);
    assert.doesNotMatch(error.stderr, /Documents|token|secret|password/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('recover remains blocked even with apply flags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linke-lifecycle-cli-'));
  try {
    const configPath = await writeTempConfig(dir);
    const dryRun = await runAgent(['supervisor-lifecycle-apply', '--config', configPath, '--operation', 'recover']);
    const dryRunReport = JSON.parse(dryRun.stdout);
    const approvalPath = join(dir, 'approval.json');
    await writeFile(approvalPath, JSON.stringify({
      operation: 'recover',
      configHash: dryRunReport.configHash,
      planHash: dryRunReport.planHash,
      approved: true,
      schemaVersion: 1,
      approvedBy: 'operator@example.invalid',
      reason: 'V0.87 recover must remain blocked',
      acknowledgements: ['no-real-host-mutation-in-v0.87'],
      approvedAt: '2026-07-07T04:30:00.000Z',
      expiresAt: '2026-07-07T05:30:00.000Z',
    }));
    const error = await runAgentExpectExit([
      'supervisor-lifecycle-apply',
      '--config', configPath,
      '--operation', 'recover',
      '--approval', approvalPath,
      '--apply',
    ], 2, { env: { LINKE_SUPERVISOR_LIFECYCLE_APPLY: 'enabled' } });
    const report = JSON.parse(error.stdout);
    assert.ok(report.blockers.includes('recovery-supervisor-design-missing'));
    assert.strictEqual(report.safety.hostMutation, false);
    assert.doesNotMatch(error.stdout, /operator@example|recover must remain blocked|acknowledgements/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('help documents supervisor-lifecycle-apply and safety gates', async () => {
  const { stdout } = await runAgent(['--help']);
  assert.match(stdout, /supervisor-lifecycle-apply/);
  assert.match(stdout, /LINKE_SUPERVISOR_LIFECYCLE_APPLY=enabled/);
  assert.match(stdout, /--approval <path>/);
});
```

Tests must use temp config files and must not write LaunchAgents, call real `launchctl`, or require real approval secrets.

Run:

```bash
node --test --test-reporter=dot test/agent-supervisor-lifecycle-apply.test.js
```

Expected: FAIL because the command is unknown.

- [ ] **Step 2: Add CLI parser and command branch**

In `src/agent.js`:

- Add `supervisor-lifecycle-apply` to usage.
- Add options:
  - `--operation <install|uninstall|rollback|recover>`
  - `--approval <path>`
  - `--apply`
  - `--launchd-dir <path>`
- Reject boolean flags with values using the existing parser pattern.
- Reuse config loading/validation from supervisor install dry-run.
- Print JSON plan or blocked report.
- Exit `0` for dry-run without `--apply`.
- Exit `2` for blocked `--apply`.
- Exit `1` for invalid command arguments.
- Do not read approval from `.env`; approval must be a JSON file passed by `--approval`.
- When `--apply` is present, return exit `2` with `executor-implementation-missing` in V0.87 even if every other gate is present.
- Do not print raw approval metadata (`approvedBy`, `reason`, `acknowledgements`) to stdout, stderr, or audit-like output.

Do not implement real host mutation in Task 2.

- [ ] **Step 3: Run GREEN CLI tests**

Run:

```bash
node --test --test-reporter=dot test/agent-supervisor-lifecycle-apply.test.js test/supervisor-lifecycle.test.js
git diff --check
```

Expected: PASS.

- [ ] **Step 4: Commit Task 2**

```bash
git add src/agent.js test/agent-supervisor-lifecycle-apply.test.js
git diff --cached --check
git commit -m "feat: add supervisor lifecycle apply cli gate"
```

---

### Task 3: Version, Docs, Gold, and Final Closure

**Files:**
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `README.md`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**
- Consumes: Task 1 module and Task 2 CLI command.
- Produces: `V0.87` documented current version while Gold remains blocked.

- [ ] **Step 1: Write RED docs/version tests**

Update tests to expect:

- `LINKE_RELEASE_VERSION === 'V0.87'`
- README title and badge V0.87
- V0.86 historical row
- V0.87 current row for supervisor lifecycle apply safety gate
- Gold evidence includes:
  - `src/supervisor-lifecycle.js`
  - `test/supervisor-lifecycle.test.js`
  - `src/agent.js supervisor-lifecycle-apply`
  - `test/agent-supervisor-lifecycle-apply.test.js`
  - `supervisorLifecycleApply.state:blocked`
- `automation-installation` and `production-hardening` remain `partial`
- `real-nas-remote-backup` remains `blocked`
- README rejects `production-ready supervisor`, `Gold ready`, `rollback ready`, `uninstall ready`, and `recovery supervisor ready`

Run:

```bash
node --test --test-reporter=dot test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

Expected: FAIL until docs/version are updated.

- [ ] **Step 2: Update docs and version**

Update:

- `src/version.js` to `V0.87`
- `src/gold-readiness.js` evidence arrays for `automation-installation` and `production-hardening`
- README current summary, version table, supervisor lifecycle apply section, Gold blockers, and partial-hardening section

Text must state:

- V0.87 adds a safety-gated lifecycle apply foundation.
- Default command is dry-run/blocked without `--apply`.
- `--apply` remains blocked unless all gates pass.
- `recover` remains blocked.
- No Web lifecycle button.
- No production-ready or Gold-ready claim.

- [ ] **Step 3: Run final verification**

Run:

```bash
node --test --test-reporter=dot test/supervisor-lifecycle.test.js test/agent-supervisor-lifecycle-apply.test.js test/version.test.js test/gold-readiness.test.js test/readme.test.js
node --test --test-reporter=dot test/*.test.js
git diff --check
rg -n "# Linke V0\\.86|当前版本：V0\\.86|\\| V0\\.86 \\| 当前版本|Gold ready|rollback ready|uninstall ready|recovery supervisor ready|production-ready supervisor|launchctlCalled: true|filesystemWritten: true|metadataWritten: true|remoteCommandExecuted: true" README.md src test
```

Expected:

- Tests PASS.
- Diff-check has no output.
- Overclaim scan only hits negative test assertions or pre-existing invalid fixtures outside V0.87.

- [ ] **Step 4: Commit Task 3**

```bash
git add src/version.js src/gold-readiness.js README.md test/version.test.js test/gold-readiness.test.js test/readme.test.js
git diff --cached --check
git commit -m "docs: document supervisor lifecycle apply safety gate"
```

- [ ] **Step 5: Final Qwen and DeepSeek closure**

Run final Qwen read-only review over the V0.87 diff, then DeepSeek JSON closure. Acceptance requires:

- all tests pass
- branch pushed
- Gold blocked
- no real host mutation by default
- no Web lifecycle button
- no production-ready overclaim

Push after PASS:

```bash
git push
```
