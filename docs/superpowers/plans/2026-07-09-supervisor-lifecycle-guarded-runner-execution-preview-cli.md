# Supervisor Lifecycle Guarded Runner Execution Preview CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add V1.10 read-only Agent CLI access to the guarded runner execution preview while keeping real lifecycle execution blocked.

**Architecture:** The CLI command composes existing pure lifecycle helpers in `src/agent.js`, then prints the V1.09 preview JSON. The release docs and Gold readiness evidence are updated to state V1.10 adds CLI visibility only, not execution wiring.

**Tech Stack:** Node.js ESM, `node:test`, existing Linke Agent CLI parser, existing supervisor lifecycle helpers.

## Global Constraints

- `LINKE_RELEASE_VERSION` must become `V1.10`.
- Command name must be `supervisor-lifecycle-guarded-runner-execution-preview`.
- The command must not call `executeSupervisorLifecycleApply`.
- The command must not call launchctl.
- The command must not write files.
- The command must not read process lists.
- The command must not connect to NAS targets.
- The command must not trigger backup or restore.
- The command must not execute remote commands.
- The command must not add API or Web surfaces.
- The command may read only explicit `--config`, `--manifest`, and `--runner-binding` file paths.
- `--fail-on-blocked` must exit 2 after printing blocked preview JSON.
- Error output must not echo config paths, manifest paths, runner-binding paths, token-like values, URLs, hostnames, usernames, local directories, raw JSON parse errors, or Node filesystem error names.

---

## File Structure

- Modify `src/agent.js`: import `buildSupervisorLifecycleGuardedRunnerExecutionPreview`, add help text, sanitized error constants, and a switch case.
- Create `test/agent-supervisor-lifecycle-guarded-runner-execution-preview.test.js`: CLI contract and safety tests.
- Modify `src/version.js`: bump to V1.10.
- Modify `src/gold-readiness.js`: add V1.10 CLI preview evidence while Gold remains blocked.
- Modify `test/version.test.js`, `test/gold-readiness.test.js`, and `test/readme.test.js`: release and documentation assertions.
- Modify `README.md`: mark V1.10 current, move V1.09 to historical, document CLI-only safety boundary.

## Task 1: Agent CLI Execution Preview

**Files:**
- Modify: `src/agent.js`
- Create: `test/agent-supervisor-lifecycle-guarded-runner-execution-preview.test.js`

**Interfaces:**
- Consumes: `buildSupervisorLifecycleApplyPlan(config, options)`, `validateSupervisorLifecycleExecutorManifest(plan, manifest)`, `buildSupervisorLifecycleGuardedRunnerReadiness(manifestReadiness, runnerBinding)`, `buildSupervisorLifecycleGuardedRunnerExecutionPreview(plan, guardedRunnerReadiness)`.
- Produces: Agent CLI command `supervisor-lifecycle-guarded-runner-execution-preview` that prints blocked preview JSON.

- [ ] **Step 1: Write the CLI tests**

Use the existing guarded runner readiness CLI test as the template. The new test file must define `validInstallManifest()`, `validRunnerBinding()`, `writeTempConfig()`, `writeJson()`, `runAgent()`, `runAgentExpectExit()`, and `assertNoSensitiveOutput()`.

Before editing, run the existing template test once to confirm the baseline pattern still passes:

```bash
node --test --test-reporter=spec test/agent-supervisor-lifecycle-guarded-runner-readiness.test.js
```

Expected: PASS.

Key assertions for the valid case:

```js
assert.strictEqual(report.command, 'supervisor-lifecycle-guarded-runner-execution-preview');
assert.strictEqual(report.operation, 'install');
assert.strictEqual(report.state, 'blocked');
assert.strictEqual(report.executionReady, false);
assert.strictEqual(report.executorReady, false);
assert.strictEqual(report.wouldExecute, false);
assert.strictEqual(report.runnerBindingsReady, true);
assert.deepStrictEqual(report.blockers, ['guarded-runner-execution-preview-only']);
assert.deepStrictEqual(report.nextBlockers, ['real-guarded-runner-execution-wiring-missing']);
assert.strictEqual(report.actionPreviews.length, 3);
assert.ok(report.actionPreviews.every((entry) =>
  entry.status === 'blocked' &&
  entry.wouldExecute === false &&
  entry.wouldRun === false &&
  entry.wouldWrite === false));
assert.strictEqual(report.safety.readOnly, true);
assert.strictEqual(report.safety.launchctlCalled, false);
assert.strictEqual(report.safety.filesystemWritten, false);
assert.strictEqual(report.safety.processListRead, false);
assert.strictEqual(report.safety.lifecycleApplied, false);
```

The exact `actionPreviews.length === 3` assertion is intentional for the current install lifecycle plan: `buildSupervisorLifecycleApplyPlan` produces `render-launch-agent-plist`, `write-launch-agent-plist`, and `load-launch-agent` for install. If the lifecycle plan changes in a future version, this test must be updated with that version's intentional action contract rather than loosened silently.

Key assertions for `--fail-on-blocked`:

```js
const error = await runAgentExpectExit([
  'supervisor-lifecycle-guarded-runner-execution-preview',
  '--config', configPath,
  '--operation', 'install',
  '--manifest', manifestPath,
  '--runner-binding', bindingPath,
  '--fail-on-blocked',
], 2);
const report = JSON.parse(error.stdout);
assert.strictEqual(report.state, 'blocked');
assert.strictEqual(report.executionReady, false);
```

Key assertions for unsupported flags:

```js
for (const forbiddenFlag of ['--apply', '--approval', '--data-dir', '--output']) {
  const error = await runAgentExpectExit([
    'supervisor-lifecycle-guarded-runner-execution-preview',
    '--config', configPath,
    '--operation', 'install',
    '--manifest', manifestPath,
    '--runner-binding', bindingPath,
    forbiddenFlag,
    forbiddenFlag === '--apply' ? undefined : join(dir, 'unsafe-value'),
  ].filter(Boolean), 1);
  assert.match(error.stderr, /not supported/);
}
```

- [ ] **Step 2: Run the new test to verify RED**

Run:

```bash
node --test --test-reporter=spec test/agent-supervisor-lifecycle-guarded-runner-execution-preview.test.js
```

Expected before implementation: FAIL because the command is unknown or missing from help.

- [ ] **Step 3: Implement the CLI command**

In `src/agent.js`, update the import list:

```js
import {
  buildSupervisorLifecycleApplyPlan,
  buildSupervisorLifecycleApprovalPersistencePreview,
  buildSupervisorLifecycleApplyReadiness,
  buildSupervisorLifecycleExecutorReadiness,
  buildSupervisorLifecycleGuardedRunnerExecutionPreview,
  buildSupervisorLifecycleGuardedRunnerReadiness,
  validateSupervisorLifecycleExecutorManifest,
} from './supervisor-lifecycle.js';
```

Add sanitized constants near the guarded runner readiness constants:

```js
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_PREVIEW_CONFIG_ERROR = 'supervisor-lifecycle-guarded-runner-execution-preview failed; verify --config points to a readable valid Linke config';
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_PREVIEW_MANIFEST_ERROR = 'supervisor-lifecycle-guarded-runner-execution-preview failed; verify --manifest points to a readable valid executor manifest JSON';
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_PREVIEW_BINDING_ERROR = 'supervisor-lifecycle-guarded-runner-execution-preview failed; verify --runner-binding points to a readable valid guarded runner binding JSON';
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_PREVIEW_VALIDATION_ERROR = 'supervisor-lifecycle-guarded-runner-execution-preview failed; execution preview validation did not complete';
```

Add command text to the top comment and `printUsage()` command list. Add `supervisor-lifecycle-guarded-runner-execution-preview` to the `--config`, `--manifest`, and `--runner-binding` option descriptions.

Add a switch case after `supervisor-lifecycle-guarded-runner-readiness`:

```js
case 'supervisor-lifecycle-guarded-runner-execution-preview': {
  if (!args.config) {
    throw new Error('--config is required');
  }
  if (args.config === true) {
    throw new Error('--config requires a path value');
  }
  if (!args.operation) {
    throw new Error('--operation is required');
  }
  if (args.operation === true) {
    throw new Error('--operation requires a value');
  }
  const validOperations = new Set(['install', 'uninstall', 'rollback', 'recover']);
  if (!validOperations.has(args.operation)) {
    throw new Error('operation must be one of: install, uninstall, rollback, recover');
  }
  if (!args.manifest) {
    throw new Error('--manifest is required');
  }
  if (args.manifest === true) {
    throw new Error('--manifest requires a path value');
  }
  if (!args['runner-binding']) {
    throw new Error('--runner-binding is required');
  }
  if (args['runner-binding'] === true) {
    throw new Error('--runner-binding requires a path value');
  }
  if (args.apply !== undefined) {
    throw new Error('--apply is not supported');
  }
  if (args.approval !== undefined) {
    throw new Error('--approval is not supported');
  }
  if (args['data-dir'] !== undefined) {
    throw new Error('--data-dir is not supported');
  }
  if (args.output !== undefined) {
    throw new Error('--output is not supported');
  }
  if (args['fail-on-blocked'] !== undefined && args['fail-on-blocked'] !== true) {
    throw new Error('--fail-on-blocked does not accept a value');
  }

  let config;
  try {
    const raw = await loadConfig(args.config);
    config = validateConfig(raw);
  } catch (err) {
    throw new Error(SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_PREVIEW_CONFIG_ERROR);
  }

  let manifest;
  try {
    const rawManifest = await readFile(args.manifest, 'utf-8');
    manifest = JSON.parse(rawManifest);
  } catch (err) {
    throw new Error(SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_PREVIEW_MANIFEST_ERROR);
  }

  let runnerBinding;
  try {
    const rawBinding = await readFile(args['runner-binding'], 'utf-8');
    runnerBinding = JSON.parse(rawBinding);
  } catch (err) {
    throw new Error(SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_PREVIEW_BINDING_ERROR);
  }

  const plan = buildSupervisorLifecycleApplyPlan(config, {
    operation: args.operation,
    apply: true,
    envGateEnabled: true,
  });

  let executionPreview;
  try {
    const manifestReadiness = validateSupervisorLifecycleExecutorManifest(plan, manifest);
    const guardedRunnerReadiness = buildSupervisorLifecycleGuardedRunnerReadiness(
      manifestReadiness,
      runnerBinding,
    );
    executionPreview = buildSupervisorLifecycleGuardedRunnerExecutionPreview(
      plan,
      guardedRunnerReadiness,
    );
  } catch (err) {
    throw new Error(SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_PREVIEW_VALIDATION_ERROR);
  }

  console.log(JSON.stringify(executionPreview, null, 2));

  if (args['fail-on-blocked'] === true && executionPreview.state === 'blocked') {
    process.exitCode = 2;
  }
  break;
}
```

The implementation must mirror the existing guarded runner readiness case and call:

```js
const manifestReadiness = validateSupervisorLifecycleExecutorManifest(plan, manifest);
const guardedRunnerReadiness = buildSupervisorLifecycleGuardedRunnerReadiness(
  manifestReadiness,
  runnerBinding,
);
const executionPreview = buildSupervisorLifecycleGuardedRunnerExecutionPreview(
  plan,
  guardedRunnerReadiness,
);
```

- [ ] **Step 4: Run focused CLI tests**

Run:

```bash
node --test --test-reporter=spec test/agent-supervisor-lifecycle-guarded-runner-execution-preview.test.js test/agent-supervisor-lifecycle-guarded-runner-readiness.test.js test/supervisor-lifecycle-guarded-runner-execution-preview.test.js
```

Expected: all tests pass.

## Task 2: Release Version, Gold Evidence, And README

**Files:**
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: V1.10 CLI command from Task 1.
- Produces: release metadata and docs that state V1.10 adds CLI-only execution preview evidence.

- [ ] **Step 1: Update version tests and version constant**

Change the expected version to `V1.10` in `test/version.test.js` and `test/gold-readiness.test.js`. Change `src/version.js`:

```js
export const LINKE_RELEASE_VERSION = 'V1.10';
```

- [ ] **Step 2: Update Gold readiness evidence**

In `src/gold-readiness.js`, add evidence strings to both the `automation-installation` and `production-hardening` item evidence arrays, matching the V1.09 placement pattern. Add these exact evidence strings where the neighboring V1.09 execution preview evidence already lives:

```text
src/agent.js supervisor-lifecycle-guarded-runner-execution-preview
test/agent-supervisor-lifecycle-guarded-runner-execution-preview.test.js
supervisor-lifecycle-guarded-runner-execution-preview
executionReady:false
executorReady:false
wouldExecute:false
guarded-runner-execution-preview-only
real-guarded-runner-execution-wiring-missing
```

The next step text must say V1.10 adds a read-only Agent CLI execution preview and still does not add real guarded lifecycle apply execution wiring.

- [ ] **Step 3: Update README and README tests**

README must say:

- Title and badge are V1.10.
- Version table marks V1.10 as current and V1.09 as historical.
- V1.10 documents `agent.js supervisor-lifecycle-guarded-runner-execution-preview --config <path> --operation <operation> --manifest <path> --runner-binding <path>`.
- V1.10 supports `--fail-on-blocked` exit 2.
- V1.10 rejects `--apply`, `--approval`, `--data-dir`, and `--output`.
- V1.10 adds no API/Web surface and does not execute lifecycle apply.
- Gold remains blocked.

`test/readme.test.js` must add a dedicated `README — V1.10 Supervisor lifecycle guarded runner execution preview CLI` describe block that asserts:

```js
assertReadmeContains(/# Linke V1\.10/, 'README title should mention V1.10');
assertReadmeContains(/\*\*当前版本：V1\.10\*\*/, 'README badge should mention V1.10');
assertReadmeContains(/\| V1\.10 \| 当前版本 \|[^|]*supervisor lifecycle guarded runner execution preview CLI[^|]*supervisor-lifecycle-guarded-runner-execution-preview[^|]*--config <path>[^|]*--operation <operation>[^|]*--manifest <path>[^|]*--runner-binding <path>[^|]*--fail-on-blocked[^|]*test\/agent-supervisor-lifecycle-guarded-runner-execution-preview\.test\.js/i, 'V1.10 should be current Agent CLI execution preview milestone');
assertReadmeContains(/\| V1\.09 \| 历史版本 \|[^|]*buildSupervisorLifecycleGuardedRunnerExecutionPreview/i, 'V1.09 should remain historical pure function evidence');
assertReadmeContains(/--apply[\s\S]*not supported|拒绝[\s\S]*--apply/i, 'README should document --apply rejection');
assertReadmeContains(/--approval[\s\S]*not supported|拒绝[\s\S]*--approval/i, 'README should document --approval rejection');
assertReadmeContains(/--data-dir[\s\S]*not supported|拒绝[\s\S]*--data-dir/i, 'README should document --data-dir rejection');
assertReadmeContains(/--output[\s\S]*not supported|拒绝[\s\S]*--output/i, 'README should document --output rejection');
assertReadmeContains(/不新增 API|no API/i, 'README should document V1.10 adds no API surface');
assertReadmeContains(/不新增 Web|no Web/i, 'README should document V1.10 adds no Web surface');
assertReadmeContains(/Gold 依旧 blocked|Gold remains blocked/i, 'README should keep Gold blocked');
```

- [ ] **Step 4: Run release/doc tests**

Run:

```bash
node --test --test-reporter=spec test/agent-supervisor-lifecycle-guarded-runner-execution-preview.test.js test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

Expected: all tests pass.

## Final Verification

Run:

```bash
git diff --check
node --check src/agent.js
node --check src/supervisor-lifecycle.js
npm test
```

Expected:

- `git diff --check` exits 0.
- Both `node --check` commands exit 0.
- `npm test` exits 0 with all tests passing.
