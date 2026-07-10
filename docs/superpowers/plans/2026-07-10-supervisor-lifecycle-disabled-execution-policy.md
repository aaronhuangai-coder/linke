# V1.23 Supervisor Lifecycle Disabled Execution Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add disabled execution policy readiness evidence to the guarded runner wiring contract while keeping all real execution behavior blocked.

**Architecture:** Extend the existing `src/supervisor-lifecycle.js` fixed blocked wiring contract with one new no-argument helper, one disabled policy entry, one new required contract, and one new gate flag. Extend existing CLI/API/Web tests through the current execution gate path instead of adding any endpoint, CLI command, or Web button.

**Tech Stack:** Node.js ESM, `node:test`, existing Linke Web Console view model helpers, README/Gold static scorecard tests.

## Global Constraints

- Current release version becomes `V1.23`.
- Do not modify `src/agent.js`.
- Do not add endpoint, CLI command, Web button, request body field, runner dispatch, launchctl/shell/process/filesystem/NAS/backup/restore/remote-command behavior.
- `buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness()` must be no-argument and ignore runtime-looking inputs.
- `executionPolicyReady:false`, `executionEligible:false`, `wouldExecute:false`, `wouldRun:false`, and `wouldWrite:false` must remain fixed.
- `runnerWiringContract.requiredContracts` must become exactly 6 entries and preserve the five V1.22 entries.
- Gold readiness must remain `blocked`.

---

### Task 1: Pure Execution Policy Readiness Contract

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

**Interfaces:**
- Produces: `buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness(): object`
- Produces: `runnerWiringContract.executionPolicyReadiness`
- Produces: `gates.executionPolicyReady:false`

- [ ] **Step 1: Write the failing test**

Add import:

```js
buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness,
```

Add expected entry:

```js
const EXPECTED_EXECUTION_POLICY_ENTRIES = Object.freeze([
  {
    policyKind: 'disabled-execution-policy-stub',
    state: 'blocked',
    realImplementationReady: false,
    approvalPolicyDefined: true,
    approvalPolicyEnforced: false,
    allowLifecycleApply: false,
    allowHostMutation: false,
    allowLaunchctl: false,
    allowFilesystemWrite: false,
    allowMetadataWrite: false,
    allowAuditWrite: false,
    allowRollbackAnchorWrite: false,
    allowNasConnection: false,
    allowBackupRestore: false,
    allowRemoteCommand: false,
    wouldAuthorizeExecution: false,
    wouldRun: false,
    wouldWrite: false,
    sensitiveValuesReturned: false,
    blockerCode: 'execution-policy-real-implementation-missing',
  },
]);
```

Update expected contracts:

```js
const EXPECTED_WIRING_CONTRACTS = Object.freeze([
  ['execution-policy', 'execution-policy-missing'],
  ['runner-registry', 'runner-registry-missing'],
  ['host-mutation-adapter', 'host-mutation-adapter-missing'],
  ['rollback-anchor', 'rollback-anchor-missing'],
  ['attempt-audit', 'attempt-audit-missing'],
  ['operator-recovery', 'operator-recovery-missing'],
]);
```

Add gate assertion:

```js
assert.strictEqual(result.gates.executionPolicyReady, false);
```

Add pure helper tests:

```js
describe('buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness', () => {
  it('returns fixed blocked disabled execution policy readiness evidence', () => {
    const readiness = buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness();

    assert.strictEqual(readiness.command, 'supervisor-lifecycle-guarded-runner-execution-policy-readiness');
    assert.strictEqual(readiness.state, 'blocked');
    assert.strictEqual(readiness.executionPolicyDefined, true);
    assert.strictEqual(readiness.executionPolicyReady, false);
    assert.strictEqual(readiness.realExecutionPolicyReady, false);
    assert.strictEqual(readiness.readyCount, 0);
    assert.strictEqual(readiness.blockedCount, 1);
    assert.ok(readiness.blockers.includes('execution-policy-real-implementation-missing'));
    assert.ok(readiness.blockers.includes('real-guarded-runner-execution-wiring-missing'));
    assert.deepStrictEqual(readiness.nextBlockers, ['execution-policy-real-implementation-missing']);
    assert.deepStrictEqual(readiness.policyEntries, EXPECTED_EXECUTION_POLICY_ENTRIES);
    assert.deepStrictEqual(readiness.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  });

  it('ignores all runtime-looking inputs and never leaks malicious policy material', () => {
    const baseline = buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness();
    const maliciousInput = {
      executionPolicyReady: true,
      policyEntries: [
        {
          policyKind: 'launchctl /Users/ah/.ssh/id_rsa token=SECRET_XYZ',
          wouldAuthorizeExecution: true,
          allowLifecycleApply: true,
          allowRemoteCommand: true,
          wouldRun: true,
          wouldWrite: true,
        },
      ],
      authorization: 'Bearer SECRET_XYZ',
      approval: { approvedBy: 'operator@example.invalid', reason: 'do not leak' },
      hash: 'sha256:abc',
      path: '/Users/ah/private',
    };

    assert.strictEqual(buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness.length, 0);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness(maliciousInput), baseline);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness(null), baseline);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness(), baseline);
    assert.doesNotMatch(
      JSON.stringify(baseline),
      /\/Users\/ah|SECRET_XYZ|operator@example|do not leak|sha256:|launchctl|Bearer/i,
    );
  });
});
```

Update `assertBlockedWiringContract`:

```js
assert.strictEqual(contract.requiredContracts.length, 6);
assert.deepStrictEqual(
  contract.executionPolicyReadiness,
  buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness(),
);
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

Expected: FAIL because `buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness` is not exported.

- [ ] **Step 3: Implement minimal pure contract**

In `src/supervisor-lifecycle.js`, add constants:

```js
const EXECUTION_POLICY_REAL_IMPLEMENTATION_MISSING = 'execution-policy-real-implementation-missing';
const DISABLED_EXECUTION_POLICY_KIND = 'disabled-execution-policy-stub';
const GUARDED_RUNNER_DISABLED_EXECUTION_POLICY_ENTRY = Object.freeze({
  policyKind: DISABLED_EXECUTION_POLICY_KIND,
  state: 'blocked',
  realImplementationReady: false,
  approvalPolicyDefined: true,
  approvalPolicyEnforced: false,
  allowLifecycleApply: false,
  allowHostMutation: false,
  allowLaunchctl: false,
  allowFilesystemWrite: false,
  allowMetadataWrite: false,
  allowAuditWrite: false,
  allowRollbackAnchorWrite: false,
  allowNasConnection: false,
  allowBackupRestore: false,
  allowRemoteCommand: false,
  wouldAuthorizeExecution: false,
  wouldRun: false,
  wouldWrite: false,
  sensitiveValuesReturned: false,
  blockerCode: EXECUTION_POLICY_REAL_IMPLEMENTATION_MISSING,
});
```

Add required contract before `runner-registry`:

```js
{
  id: 'execution-policy',
  status: 'blocked',
  requiredForExecution: true,
  blockerCode: 'execution-policy-missing',
  evidence: 'disabled execution policy readiness only; real execution policy enforcement missing',
}
```

Add helper:

```js
export function buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness() {
  return {
    command: 'supervisor-lifecycle-guarded-runner-execution-policy-readiness',
    state: 'blocked',
    executionPolicyDefined: true,
    executionPolicyReady: false,
    realExecutionPolicyReady: false,
    readyCount: 0,
    blockedCount: 1,
    policyEntries: [{ ...GUARDED_RUNNER_DISABLED_EXECUTION_POLICY_ENTRY }],
    blockers: [
      EXECUTION_POLICY_REAL_IMPLEMENTATION_MISSING,
      REAL_GUARDED_RUNNER_EXECUTION_WIRING_MISSING,
    ],
    nextBlockers: [EXECUTION_POLICY_REAL_IMPLEMENTATION_MISSING],
    safety: executionPreviewSafety(),
  };
}
```

Attach it to `buildSupervisorLifecycleGuardedRunnerWiringContract` and add `executionPolicyReady:false` to gate output.

- [ ] **Step 4: Run GREEN**

Run:

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

Expected: PASS.

### Task 2: API/CLI/Web Evidence

**Files:**
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js`
- Modify: `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js`
- Modify: `src/web/app.js`
- Modify: `test/web-console.test.js`

**Interfaces:**
- Consumes: `runnerWiringContract.executionPolicyReadiness`
- Produces: fixed Web line `executionPolicy:disabled-execution-policy-stub:state:blocked:realImplementationReady:false:wouldAuthorizeExecution:false:blocker:execution-policy-real-implementation-missing`

- [ ] **Step 1: Write API/CLI failing assertions**

In both API and CLI execution gate tests, assert:

```js
assert.strictEqual(body.executionEligible, false);
assert.strictEqual(body.wouldExecute, false);
assert.strictEqual(body.executorReady, false);
assert.strictEqual(body.gates.executionPolicyReady, false);
assert.strictEqual(body.runnerWiringContract.executionPolicyReadiness.state, 'blocked');
assert.strictEqual(body.runnerWiringContract.executionPolicyReadiness.executionPolicyReady, false);
assert.strictEqual(body.runnerWiringContract.executionPolicyReadiness.policyEntries[0].wouldAuthorizeExecution, false);
assert.strictEqual(body.runnerWiringContract.executionPolicyReadiness.policyEntries[0].allowLifecycleApply, false);
assert.strictEqual(body.runnerWiringContract.executionPolicyReadiness.policyEntries[0].allowRemoteCommand, false);
assert.strictEqual(body.runnerWiringContract.executionPolicyReadiness.policyEntries[0].wouldRun, false);
assert.strictEqual(body.runnerWiringContract.executionPolicyReadiness.policyEntries[0].wouldWrite, false);
```

In both API and CLI tests, also add a malicious policy payload or fixture branch that serializes the result and checks:

```js
assert.doesNotMatch(
  JSON.stringify(body),
  /\/Users\/ah|SECRET_XYZ|launchctl \/|launchctl load|token=|Authorization|sha256:|operator@example/i,
);
```

The malicious input must include `executionPolicyReady:true`, `policyEntries[0].wouldAuthorizeExecution:true`, `allowLifecycleApply:true`, `allowRemoteCommand:true`, and sensitive-looking strings. The returned response must still be fixed blocked evidence.

- [ ] **Step 2: Add Web failing assertions**

Add helper in `src/web/app.js` only after tests fail:

```js
function buildSupervisorLifecycleGuardedRunnerExecutionPolicyLines(runnerWiringContract) {
  const readiness = runnerWiringContract &&
    typeof runnerWiringContract === 'object' &&
    runnerWiringContract.executionPolicyReadiness &&
    typeof runnerWiringContract.executionPolicyReadiness === 'object'
    ? runnerWiringContract.executionPolicyReadiness
    : null;
  const entries = Array.isArray(readiness?.policyEntries) ? readiness.policyEntries : [];
  if (entries.length < 1) return [];
  return [
    'executionPolicy:disabled-execution-policy-stub:state:blocked:realImplementationReady:false:wouldAuthorizeExecution:false:blocker:execution-policy-real-implementation-missing',
  ];
}
```

Before implementation, update Web tests to expect that line and `executionPolicyReady:false` in normal, unknown, and error validation lines. Add malicious payload test with:

```js
executionPolicyReadiness: {
  policyEntries: [{
    policyKind: 'launchctl /Users/ah/.ssh/id_rsa token=SECRET_XYZ',
    wouldAuthorizeExecution: true,
    allowLifecycleApply: true,
    allowRemoteCommand: true,
    wouldRun: true,
    wouldWrite: true,
    blockerCode: 'Authorization sha256:abc operator@example.invalid',
  }],
}
```

Expected fixed line is present and these strings are absent:

```js
/\/Users\/ah|SECRET_XYZ|launchctl \/|launchctl load|token=|Authorization|sha256:|operator@example/i
```

- [ ] **Step 3: Run RED**

Run:

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js test/web-console.test.js
```

Expected: FAIL on missing Web policy line and missing `executionPolicyReady:false`.

- [ ] **Step 4: Implement Web fixed line**

Add `buildSupervisorLifecycleGuardedRunnerExecutionPolicyLines` to `src/web/app.js`, call it near the other guarded runner wiring line builders, append the line before `runnerRegistryLines`, and add `executionPolicyReady:false` to error, unknown, and normal validation lines.

- [ ] **Step 5: Run GREEN**

Run:

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js test/web-console.test.js
```

Expected: PASS.

### Task 3: Version, Gold, README

**Files:**
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `README.md`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**
- Consumes: V1.23 execution policy readiness evidence.
- Produces: static docs and Gold evidence that keep Gold blocked.

- [ ] **Step 1: Write failing docs/version tests**

Update tests to expect:

```js
V1.23
buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness
executionPolicyReadiness.state:blocked
executionPolicyReady:false
execution-policy-real-implementation-missing
```

Update README tests so V1.23 is current and V1.22 is historical.

- [ ] **Step 2: Run RED**

Run:

```bash
node --test --test-reporter=spec test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

Expected: FAIL because source docs still say V1.22.

- [ ] **Step 3: Update source docs and version**

Set:

```js
export const LINKE_RELEASE_VERSION = 'V1.23';
```

Add V1.23 execution policy evidence to `automation-installation` and `production-hardening` Gold evidence and next steps. Update README title, badge, version table, Gold blockers, partial hardening, and safety boundary text. Keep Gold blocked.

- [ ] **Step 4: Run GREEN**

Run:

```bash
node --test --test-reporter=spec test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

Expected: PASS.

### Task 4: Final Verification And Review

**Files:**
- No new source files.

**Interfaces:**
- Verifies all prior tasks.

- [ ] **Step 1: Syntax and whitespace checks**

Run:

```bash
node --check src/supervisor-lifecycle.js
node --check src/web/app.js
git diff --check
```

Expected: all exit 0.

- [ ] **Step 2: Focused tests**

Run:

```bash
node --test --test-reporter=dot test/supervisor-lifecycle-guarded-runner-execution-gate.test.js test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js test/web-console.test.js
node --test --test-reporter=dot test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

Expected: both commands exit 0.

- [ ] **Step 3: Full test suite**

Run:

```bash
npm test
```

Expected: exit 0.

- [ ] **Step 4: Adversarial review**

Send the uncommitted diff to Qwen as a read-only reviewer. Required verdict schema:

```text
RESULT: PASS or FAIL
BLOCKING_FINDINGS: numbered list or none
REQUIRED_CHANGES: numbered list or none
TEST_GAPS: numbered list or none
CONFIDENCE: low/medium/high
```

The prompt must ask Qwen to verify no `src/agent.js` changes, no new endpoint/CLI/Web button/request field, no real policy enforcement, no real runner dispatch, requiredContracts exactly 6, Gold blocked, and malicious payloads do not leak.

- [ ] **Step 5: DeepSeek closure**

Send the diff, spec, and plan to DeepSeek with strict English output:

```text
VERDICT: ACCEPT or REJECT
BLOCKING_FINDINGS: numbered list or none
REQUIRED_CHANGES: numbered list or none
RESIDUAL_RISKS: numbered list or none
COMMIT_READY: yes or no
GOLD_STATUS: blocked or ready
CONFIDENCE: low/medium/high
```

Expected: `VERDICT: ACCEPT`, `COMMIT_READY: yes`, `GOLD_STATUS: blocked`.
