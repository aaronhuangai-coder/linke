# V1.24 Supervisor Lifecycle Fail-Closed Execution Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace V1.23 disabled execution policy stub with a code-owned pure fail-closed evaluator; mark `execution-policy` required contract ready; keep production execution and Gold blocked.

**Architecture:** Add `evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(context)` as the only authorize path. Export public pure helper `areSupervisorLifecycleGuardedRunnerActionCandidatesReady(candidates, operation)` (boolean only; structural readiness; **≠ authorize/wouldRun**) so A1–A7 are directly unit-testable with synthetic malformed arrays. Convert `buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness()` to fixed ready evidence. Wire gate to build exact-key boolean context from **local production primitive facts only** (never request/options objects), attach sanitized `policyDecision`, set `gates.executionPolicyReady:true` while leaving `executionEligible/wouldExecute/wouldRun/wouldWrite` false because five downstream wiring contracts remain blocked. Web VM must call `buildSupervisorLifecycleGuardedRunnerPolicyDecisionLines` and assemble lines into `requiredFields`. JS cannot reliably detect all Proxies; defense is best-effort validation + gate-local context construction + side-effect flags always false.

**Tech Stack:** Node.js ESM, `node:test`, existing Web Console view model helpers, README/Gold static scorecard tests.

**Spec:** `docs/superpowers/specs/2026-07-14-supervisor-lifecycle-fail-closed-execution-policy-design.md`

**Recovery anchor:** `2b53f4d`

## Global Constraints

- Current release version becomes `V1.24`.
- Do not add endpoint, CLI command, Web button, or request body field.
- Do not accept request/CLI `policyContext` / `policyDecision` overrides.
- Do not call host shell / process-control / process list / filesystem / metadata / audit / approval writes / NAS / backup / restore / remote.
- Production path: `policyDecision` always denied; `executionEligible:false`; Gold `blocked`.
- G0a real two-Mac PASS statements stay unchanged.
- Docs/tests must not embed: username-shaped absolute paths, SSH path forms, concrete IPs/CIDRs, real emails, real command names, credential forms, or 64-hex digests.
- Malicious fixtures use **opaque synthetic strings only** (e.g. `UNSAFE_SECRET_MATERIAL`, `OPAQUE_UNSAFE_FIELD`) with no path/network/host/email/hash/command/credential shape.
- Sensitive scans report **category hit counts only**; never echo matching lines.
- This planning phase must not modify `src/`, `test/`, `README.md`, `package*`, or version files; implementation phase follows this plan.

---

### Task 1: Pure Evaluator + Ready Policy Readiness Contract

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

**Interfaces:**
- Produces: `evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(context): object`
- Produces: **`areSupervisorLifecycleGuardedRunnerActionCandidatesReady(candidates, operation): boolean`** (public pure; JSDoc required; no metadata; **≠ authorize/wouldRun**)
- Produces: `buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness(): object` (ready)
- Produces: `runnerWiringContract.requiredContracts[0].status:'ready'`
- Produces: gate `policyDecision` + `gates.executionPolicyReady:true` + `gates.actionCandidatesReady`（由公开 helper 写入）

- [ ] **Step 1: Write the failing pure tests**

Update imports:

```js
import {
  // existing...
  areSupervisorLifecycleGuardedRunnerActionCandidatesReady,
  buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness,
  evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy,
} from '../src/supervisor-lifecycle.js';
```

Replace expected wiring + policy fixtures:

```js
const EXPECTED_WIRING_CONTRACTS = Object.freeze([
  ['execution-policy', null, 'ready', 'execution-policy-ready'],
  ['runner-registry', 'runner-registry-missing', 'blocked', 'runner-registry-missing'],
  ['host-mutation-adapter', 'host-mutation-adapter-missing', 'blocked', 'host-mutation-adapter-missing'],
  ['rollback-anchor', 'rollback-anchor-missing', 'blocked', 'rollback-anchor-missing'],
  ['attempt-audit', 'attempt-audit-missing', 'blocked', 'attempt-audit-missing'],
  ['operator-recovery', 'operator-recovery-missing', 'blocked', 'operator-recovery-missing'],
]);

const EXPECTED_EXECUTION_POLICY_ENTRIES = Object.freeze([
  {
    policyKind: 'fail-closed-execution-policy',
    state: 'ready',
    realImplementationReady: true,
    approvalPolicyDefined: true,
    approvalPolicyEnforced: true,
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
    blockerCode: null,
    evidenceCode: 'execution-policy-ready',
  },
]);

const POLICY_FACT_KEYS = Object.freeze([
  'lifecyclePlanValid',
  'approvalRecordReady',
  'manifestReady',
  'runnerBindingsReady',
  'executionPreviewVerified',
  'executeRequested',
  'actionCandidatesReady',
  'runnerRegistryReady',
  'hostMutationAdapterReady',
  'rollbackAnchorReady',
  'attemptAuditReady',
  'operatorRecoveryReady',
]);

const POLICY_FACT_BLOCKERS = Object.freeze({
  lifecyclePlanValid: 'lifecycle-plan-not-ready',
  approvalRecordReady: 'approval-record-gate-not-ready',
  manifestReady: 'executor-manifest-not-ready',
  runnerBindingsReady: 'guarded-runner-readiness-not-ready',
  executionPreviewVerified: 'execution-preview-not-verified',
  executeRequested: 'execute-request-missing',
  actionCandidatesReady: 'action-candidates-not-ready',
  runnerRegistryReady: 'runner-registry-not-ready',
  hostMutationAdapterReady: 'host-mutation-adapter-not-ready',
  rollbackAnchorReady: 'rollback-anchor-not-ready',
  attemptAuditReady: 'attempt-audit-not-ready',
  operatorRecoveryReady: 'operator-recovery-not-ready',
});

function buildAllTruePolicyContext(operation = 'install') {
  return {
    operation,
    lifecyclePlanValid: true,
    approvalRecordReady: true,
    manifestReady: true,
    runnerBindingsReady: true,
    executionPreviewVerified: true,
    executeRequested: true,
    actionCandidatesReady: true,
    runnerRegistryReady: true,
    hostMutationAdapterReady: true,
    rollbackAnchorReady: true,
    attemptAuditReady: true,
    operatorRecoveryReady: true,
  };
}

function assertPolicyDecisionInvariants(decision) {
  assert.strictEqual(decision.command, 'supervisor-lifecycle-guarded-runner-execution-policy');
  assert.strictEqual(decision.policyKind, 'fail-closed-execution-policy');
  assert.strictEqual(decision.realImplementationReady, true);
  assert.strictEqual(decision.wouldRun, false);
  assert.strictEqual(decision.wouldWrite, false);
  assert.strictEqual(decision.allowLifecycleApply, false);
  assert.strictEqual(decision.allowHostMutation, false);
  assert.strictEqual(decision.allowLaunchctl, false);
  assert.strictEqual(decision.allowFilesystemWrite, false);
  assert.strictEqual(decision.allowMetadataWrite, false);
  assert.strictEqual(decision.allowAuditWrite, false);
  assert.strictEqual(decision.allowRollbackAnchorWrite, false);
  assert.strictEqual(decision.allowNasConnection, false);
  assert.strictEqual(decision.allowBackupRestore, false);
  assert.strictEqual(decision.allowRemoteCommand, false);
  assert.strictEqual(decision.sensitiveValuesReturned, false);
  assert.deepStrictEqual(decision.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  const authorized = decision.state === 'authorized';
  assert.strictEqual(decision.authorized, authorized);
  assert.strictEqual(decision.wouldAuthorizeExecution, authorized);
  if (authorized) {
    assert.deepStrictEqual(decision.blockers, []);
    assert.strictEqual(decision.primaryBlocker, null);
    assert.deepStrictEqual(decision.nextBlockers, []);
  } else {
    assert.ok(decision.blockers.length >= 1);
    assert.strictEqual(decision.primaryBlocker, decision.blockers[0]);
    assert.deepStrictEqual(decision.nextBlockers, [decision.primaryBlocker]);
  }
}

// Opaque synthetic strings only — no path/host/email/hash/command/credential shapes in docs or fixtures.
// Declared before first use to avoid TDZ in suite bodies below.
const UNSAFE_SECRET_MATERIAL = 'UNSAFE_SECRET_MATERIAL';
```

Add evaluator suite:

```js
describe('evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy', () => {
  it('authorizes only the pure synthetic all-true exact-key contract', () => {
    for (const operation of ['install', 'uninstall', 'rollback', 'recover']) {
      const context = buildAllTruePolicyContext(operation);
      const decision = evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(context);
      assertPolicyDecisionInvariants(decision);
      assert.strictEqual(decision.operation, operation);
      assert.strictEqual(decision.state, 'authorized');
      assert.strictEqual(decision.authorized, true);
      assert.strictEqual(decision.wouldAuthorizeExecution, true);
      assert.strictEqual(decision.wouldRun, false);
      assert.strictEqual(decision.wouldWrite, false);
    }
  });

  for (const fact of POLICY_FACT_KEYS) {
    it(`denies when ${fact} is false with registered blocker`, () => {
      const context = buildAllTruePolicyContext('install');
      context[fact] = false;
      const decision = evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(context);
      assertPolicyDecisionInvariants(decision);
      assert.strictEqual(decision.state, 'denied');
      assert.strictEqual(decision.authorized, false);
      assert.strictEqual(decision.wouldAuthorizeExecution, false);
      assert.ok(decision.blockers.includes(POLICY_FACT_BLOCKERS[fact]));
      assert.strictEqual(decision.primaryBlocker, decision.blockers[0]);
    });
  }

  it('primaryBlocker follows fixed fact scan order when multiple facts are false', () => {
    const context = buildAllTruePolicyContext('install');
    context.runnerRegistryReady = false;
    context.hostMutationAdapterReady = false;
    context.attemptAuditReady = false;
    const decision = evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(context);
    assert.deepStrictEqual(decision.blockers, [
      'runner-registry-not-ready',
      'host-mutation-adapter-not-ready',
      'attempt-audit-not-ready',
    ]);
    assert.strictEqual(decision.primaryBlocker, 'runner-registry-not-ready');
    assert.deepStrictEqual(decision.nextBlockers, ['runner-registry-not-ready']);
  });

  it('denies unknown keys, missing keys, type-confused values, arrays, null, and non-objects', () => {
    const baselineAllTrue = buildAllTruePolicyContext();
    const samples = [
      null,
      undefined,
      [],
      'install',
      1,
      true,
      { ...baselineAllTrue, extra: true },
      (() => {
        const c = { ...baselineAllTrue };
        delete c.executeRequested;
        return c;
      })(),
      { ...baselineAllTrue, lifecyclePlanValid: 'true' },
      { ...baselineAllTrue, lifecyclePlanValid: 1 },
      { ...baselineAllTrue, executeRequested: null },
      Object.assign(Object.create({ polluted: true }), baselineAllTrue),
    ];
    for (const sample of samples) {
      const decision = evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(sample);
      assertPolicyDecisionInvariants(decision);
      assert.strictEqual(decision.state, 'denied');
      assert.ok(decision.blockers.includes('execution-policy-context-invalid'));
    }
  });

  it('denies invalid operation as cross-operation / operation-invalid', () => {
    const context = buildAllTruePolicyContext();
    context.operation = 'apply-all';
    const decision = evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(context);
    assertPolicyDecisionInvariants(decision);
    assert.strictEqual(decision.state, 'denied');
    assert.ok(decision.blockers.includes('execution-policy-operation-invalid'));
  });

  it('denies empty-actions via actionCandidatesReady false', () => {
    const context = buildAllTruePolicyContext();
    context.actionCandidatesReady = false;
    const decision = evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(context);
    assertPolicyDecisionInvariants(decision);
    assert.ok(decision.blockers.includes('action-candidates-not-ready'));
  });

  it('best-effort rejects observable accessor contexts and maps trap throw to fixed invalid', () => {
    // Not a claim that every Proxy is detectable. Production path never feeds
    // external objects into the evaluator (gate builds local primitives only).
    const withGetter = {};
    for (const [k, v] of Object.entries(buildAllTruePolicyContext())) {
      Object.defineProperty(withGetter, k, {
        enumerable: true,
        configurable: true,
        get() {
          return v;
        },
      });
    }

    const throwingDescriptorTarget = buildAllTruePolicyContext();
    const throwingProxy = new Proxy(throwingDescriptorTarget, {
      getOwnPropertyDescriptor() {
        throw new Error(UNSAFE_SECRET_MATERIAL);
      },
    });

    const opaqueLeakProbe = new Proxy(buildAllTruePolicyContext(), {
      get(obj, prop) {
        if (prop === 'OPAQUE_UNSAFE_FIELD') return UNSAFE_SECRET_MATERIAL;
        return obj[prop];
      },
      ownKeys() {
        return [...Object.keys(buildAllTruePolicyContext()), 'OPAQUE_UNSAFE_FIELD'];
      },
      getOwnPropertyDescriptor(obj, prop) {
        if (prop === 'OPAQUE_UNSAFE_FIELD') {
          return { configurable: true, enumerable: true, value: UNSAFE_SECRET_MATERIAL };
        }
        return Object.getOwnPropertyDescriptor(obj, prop);
      },
    });

    for (const sample of [withGetter, throwingProxy, opaqueLeakProbe]) {
      const decision = evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(sample);
      assertPolicyDecisionInvariants(decision);
      assert.strictEqual(decision.state, 'denied');
      assert.ok(decision.blockers.includes('execution-policy-context-invalid'));
      assert.strictEqual(decision.primaryBlocker, 'execution-policy-context-invalid');
      assert.doesNotMatch(JSON.stringify(decision), new RegExp(UNSAFE_SECRET_MATERIAL, 'i'));
    }
  });

  it('input mutation does not change an already-returned decision; output mutation does not affect later calls', () => {
    const context = buildAllTruePolicyContext();
    const decision = evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(context);
    const snapshot = JSON.stringify(decision);

    // Input mutation must not alter already-returned decision
    context.runnerRegistryReady = false;
    context.operation = 'hacked';
    context.lifecyclePlanValid = false;
    assert.strictEqual(JSON.stringify(decision), snapshot);
    assert.strictEqual(decision.state, 'authorized');
    assert.strictEqual(decision.authorized, true);
    assert.strictEqual(decision.wouldAuthorizeExecution, true);
    assert.strictEqual(decision.wouldRun, false);

    // Output mutation must not poison subsequent calls
    decision.authorized = false;
    decision.wouldAuthorizeExecution = false;
    decision.state = 'denied';
    decision.blockers.push('forged-blocker');
    decision.wouldRun = true;
    decision.primaryBlocker = 'forged-blocker';

    const again = evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(buildAllTruePolicyContext());
    assert.strictEqual(again.state, 'authorized');
    assert.strictEqual(again.authorized, true);
    assert.strictEqual(again.wouldAuthorizeExecution, true);
    assert.strictEqual(again.wouldRun, false);
    assert.strictEqual(again.wouldWrite, false);
    assert.deepStrictEqual(again.blockers, []);
    assert.strictEqual(again.primaryBlocker, null);
    assert.ok(!JSON.stringify(again).includes('forged-blocker'));
    // prior decision remains the mutated object (caller's copy), but is independent
    assert.notStrictEqual(again, decision);
  });

  it('never echoes opaque unsafe material from malicious context bag', () => {
    const context = buildAllTruePolicyContext();
    // unknown keys make this invalid; ensure no leak even if implementation inspects them first
    const malicious = {
      ...context,
      OPAQUE_UNSAFE_FIELD: UNSAFE_SECRET_MATERIAL,
      nestedOpaque: { material: UNSAFE_SECRET_MATERIAL },
    };
    const decision = evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(malicious);
    assert.strictEqual(decision.state, 'denied');
    assert.doesNotMatch(JSON.stringify(decision), new RegExp(UNSAFE_SECRET_MATERIAL, 'i'));
  });
});
```

**Pure unit tests for public helper A1–A7** (synthetic malformed arrays **directly** reachable; do **not** invent undefined `getInputsWith*` helpers):

```js
describe('areSupervisorLifecycleGuardedRunnerActionCandidatesReady', () => {
  // Public pure boolean helper. Structural readiness only.
  // ≠ authorize / wouldAuthorizeExecution / wouldRun / wouldWrite / executionEligible.
  // Returns boolean only — no metadata object.

  // Build synthetic candidates with exact allowlisted schema keys only.
  // Use opaque ids that match the operation expected set for the chosen operation
  // (derive expected actionId list from existing lifecycle action contract for that operation).
  function validCandidate(actionId) {
    return {
      actionId,
      implementationId: 'impl-synthetic',
      runnerKind: 'guarded-host-action',
      mode: 'guarded-host-action',
      status: 'blocked',
      wouldExecute: false,
      wouldRun: false,
      wouldWrite: false,
      maxAttempts: 1,
    };
  }

  function validCandidatesFor(operation) {
    // Must be the full expected actionId set for operation (order may match contract).
    const expectedIds = /* from existing operation→expected action set helper or fixture */;
    return expectedIds.map((id) => validCandidate(id));
  }

  it('A1: nonempty + exact schema + unique actionId + full expected-set match + sensitive-field-free => true', () => {
    for (const operation of ['install', 'uninstall', 'rollback', 'recover']) {
      assert.strictEqual(
        areSupervisorLifecycleGuardedRunnerActionCandidatesReady(
          validCandidatesFor(operation),
          operation,
        ),
        true,
      );
    }
  });

  it('A2: empty array => false', () => {
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady([], 'install'),
      false,
    );
  });

  it('A3: missing required schema field or unknown key => false', () => {
    const base = validCandidatesFor('install');
    const missingField = base.map((c, i) => (i === 0
      ? {
          actionId: c.actionId,
          // missing implementationId and other required keys
        }
      : c));
    const unknownKey = base.map((c, i) => (i === 0
      ? { ...c, OPAQUE_UNSAFE_FIELD: UNSAFE_SECRET_MATERIAL }
      : c));
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady(missingField, 'install'),
      false,
    );
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady(unknownKey, 'install'),
      false,
    );
  });

  it('A4: duplicate actionId => false', () => {
    const base = validCandidatesFor('install');
    const duped = [...base, { ...base[0] }];
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady(duped, 'install'),
      false,
    );
  });

  it('A5: candidates set does not fully match operation expected set => false', () => {
    const base = validCandidatesFor('install');
    const missingOne = base.slice(0, Math.max(0, base.length - 1));
    const extraOne = [...base, validCandidate('synthetic-extra-action-id')];
    const wrongOpSet = validCandidatesFor('uninstall'); // install operation, uninstall set
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady(missingOne, 'install'),
      false,
    );
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady(extraOne, 'install'),
      false,
    );
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady(wrongOpSet, 'install'),
      false,
    );
  });

  it('A6: trap / getter / non-array / null / invalid operation / type-confused => false', () => {
    const base = validCandidatesFor('install');
    const withGetterElement = [...base];
    const trapped = {};
    for (const [k, v] of Object.entries(base[0])) {
      Object.defineProperty(trapped, k, {
        enumerable: true,
        configurable: true,
        get() {
          return v;
        },
      });
    }
    withGetterElement[0] = trapped;

    const throwingProxy = new Proxy(base, {
      get() {
        throw new Error(UNSAFE_SECRET_MATERIAL);
      },
    });

    const samples = [
      null,
      undefined,
      'install',
      1,
      true,
      { not: 'array' },
      withGetterElement,
      throwingProxy,
      base, // valid candidates but invalid operation below
    ];
    for (const sample of samples.slice(0, -1)) {
      assert.strictEqual(
        areSupervisorLifecycleGuardedRunnerActionCandidatesReady(sample, 'install'),
        false,
      );
    }
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady(base, 'apply-all'),
      false,
    );
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady(base, null),
      false,
    );
  });

  it('A7: sensitive-field-free failure + boolean-only / not authorize-or-wouldRun boundary', () => {
    const base = validCandidatesFor('install');
    // Extra non-allowlisted key that looks like host-side material — must fail schema/sensitive-field-free
    const withSensitive = base.map((c, i) => (i === 0
      ? { ...c, OPAQUE_UNSAFE_FIELD: UNSAFE_SECRET_MATERIAL }
      : c));
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady(withSensitive, 'install'),
      false,
    );
    // Semantic boundary: helper true does not mean authorize / wouldRun
    const ready = areSupervisorLifecycleGuardedRunnerActionCandidatesReady(
      validCandidatesFor('install'),
      'install',
    );
    assert.strictEqual(typeof ready, 'boolean');
    assert.strictEqual(ready, true);
    // helper returns boolean only — never an object with metadata / blockers / reasons
  });
});
```

**Gate integration only** (empty/valid candidates + production five-downstream deny; **no** undefined `getInputsWithSchemaInvalidCandidates` / `getInputsWithDuplicateActionIds` / `getInputsWithOperationSetMismatch`):

```js
describe('gates.actionCandidatesReady gate integration (empty/valid only)', () => {
  // Gate wires areSupervisorLifecycleGuardedRunnerActionCandidatesReady into
  // gates.actionCandidatesReady. A3/A4/A5 malformed paths are pure-tested above.
  // This suite must NOT invent undefined getInputs helpers.

  it('G1: production valid candidates => actionCandidatesReady true but policy denied via five downstream', () => {
    const result = buildGate(getReadyInputs(), { executeRequested: true });
    assert.strictEqual(result.gates.actionCandidatesReady, true);
    // optional consistency: re-call public helper on gate output candidates
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady(
        result.actionCandidates,
        result.operation,
      ),
      true,
    );
    assert.strictEqual(result.policyDecision.state, 'denied');
    assert.strictEqual(result.policyDecision.authorized, false);
    assert.strictEqual(result.executionEligible, false);
    assert.strictEqual(result.wouldExecute, false);
    for (const code of [
      'runner-registry-not-ready',
      'host-mutation-adapter-not-ready',
      'rollback-anchor-not-ready',
      'attempt-audit-not-ready',
      'operator-recovery-not-ready',
    ]) {
      assert.ok(result.policyDecision.blockers.includes(code));
    }
  });

  it('G2: empty sanitized candidates => actionCandidatesReady false + action-candidates-not-ready', () => {
    // Use a reachable production-shaped empty path only — e.g. plan/preview mismatch
    // that makes buildGuardedRunnerExecutionGateActionCandidates return [].
    // Define any local fixture builder inline in this test file from real gate inputs.
    // Do NOT invent undefined getInputsWith* helpers for A3/A4/A5 malformed injection.
    const emptyPathInputs = /* real gate inputs that yield actionCandidates === [] */;
    const result = buildGate(emptyPathInputs, { executeRequested: true });
    assert.deepStrictEqual(result.actionCandidates, []);
    assert.strictEqual(result.gates.actionCandidatesReady, false);
    assert.ok(result.policyDecision.blockers.includes('action-candidates-not-ready'));
    assert.strictEqual(result.executionEligible, false);
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady(result.actionCandidates, result.operation),
      false,
    );
  });
});
```

Replace readiness tests:

```js
describe('buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness', () => {
  it('returns fixed real ready fail-closed execution policy evidence', () => {
    const readiness = buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness();
    assert.strictEqual(readiness.command, 'supervisor-lifecycle-guarded-runner-execution-policy-readiness');
    assert.strictEqual(readiness.state, 'ready');
    assert.strictEqual(readiness.executionPolicyDefined, true);
    assert.strictEqual(readiness.executionPolicyReady, true);
    assert.strictEqual(readiness.realExecutionPolicyReady, true);
    assert.strictEqual(readiness.readyCount, 1);
    assert.strictEqual(readiness.blockedCount, 0);
    assert.deepStrictEqual(readiness.blockers, []);
    assert.deepStrictEqual(readiness.nextBlockers, []);
    assert.deepStrictEqual(readiness.policyEntries, EXPECTED_EXECUTION_POLICY_ENTRIES);
    assert.strictEqual(readiness.policyEntries[0].blockerCode, null);
    assert.strictEqual(readiness.policyEntries[0].evidenceCode, 'execution-policy-ready');
    assert.deepStrictEqual(readiness.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  });

  it('ignores runtime-looking inputs and never leaks opaque unsafe material', () => {
    const baseline = buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness();
    const maliciousInput = {
      executionPolicyReady: false,
      policyEntries: [{
        policyKind: UNSAFE_SECRET_MATERIAL,
        wouldAuthorizeExecution: true,
        allowLifecycleApply: true,
        OPAQUE_UNSAFE_FIELD: UNSAFE_SECRET_MATERIAL,
      }],
      OPAQUE_UNSAFE_FIELD: UNSAFE_SECRET_MATERIAL,
    };
    assert.strictEqual(buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness.length, 0);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness(maliciousInput), baseline);
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness(null), baseline);
    assert.doesNotMatch(JSON.stringify(baseline), new RegExp(UNSAFE_SECRET_MATERIAL, 'i'));
    assert.doesNotMatch(
      JSON.stringify(baseline),
      /disabled-execution-policy-stub|execution-policy-real-implementation-missing/i,
    );
  });
});
```

Update `assertBlockedWiringContract` / rename to `assertWiringContract` (null-safe ready contract):

```js
function assertWiringContract(contract) {
  assert.strictEqual(contract.command, 'supervisor-lifecycle-guarded-runner-wiring-contract');
  assert.strictEqual(contract.state, 'blocked');
  assert.strictEqual(contract.realRunnerWiringReady, false);
  assert.strictEqual(contract.readyCount, 1);
  assert.strictEqual(contract.blockedCount, 5);
  assert.deepStrictEqual(contract.nextBlockers, ['real-guarded-runner-execution-wiring-missing']);
  assert.ok(contract.blockers.includes('real-guarded-runner-execution-wiring-missing'));
  assert.deepStrictEqual(contract.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  assert.strictEqual(contract.requiredContracts.length, 6);
  assert.deepStrictEqual(
    contract.requiredContracts.map((entry) => [
      entry.id,
      entry.blockerCode,
      entry.status,
      entry.evidenceCode,
    ]),
    EXPECTED_WIRING_CONTRACTS,
  );
  const policyContract = contract.requiredContracts[0];
  assert.strictEqual(policyContract.id, 'execution-policy');
  assert.strictEqual(policyContract.status, 'ready');
  // Schema migration: ready => blockerCode is null (not a fake string blocker)
  assert.strictEqual(policyContract.blockerCode, null);
  assert.strictEqual(policyContract.evidenceCode, 'execution-policy-ready');
  assert.ok(contract.requiredContracts.slice(1).every((entry) =>
    entry.status === 'blocked' &&
      entry.requiredForExecution === true &&
      typeof entry.blockerCode === 'string' &&
      entry.blockerCode.length > 0));
  assert.deepStrictEqual(
    contract.executionPolicyReadiness,
    buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness(),
  );
  // remaining five readiness deepStrictEqual unchanged helpers
}
```

Update `assertAlwaysBlockedGate`:

```js
assert.strictEqual(result.gates.executionPolicyReady, true);
// still:
assert.strictEqual(result.executionEligible, false);
assert.strictEqual(result.wouldExecute, false);
assert.strictEqual(result.gates.runnerRegistryReady, false);
// ...
```

Add gate assertions for production path:

```js
it('production ready inputs with executeRequested still deny via policyDecision and keep executionEligible false', () => {
  const result = buildGate(getReadyInputs(), { executeRequested: true });
  assertAlwaysBlockedGate(result);
  assert.strictEqual(result.gates.executionPolicyReady, true);
  assert.strictEqual(result.gates.actionCandidatesReady, true);
  assert.strictEqual(result.policyDecision.state, 'denied');
  assert.strictEqual(result.policyDecision.authorized, false);
  assert.strictEqual(result.policyDecision.wouldAuthorizeExecution, false);
  assert.strictEqual(result.policyDecision.wouldRun, false);
  assert.strictEqual(result.policyDecision.wouldWrite, false);
  for (const code of [
    'runner-registry-not-ready',
    'host-mutation-adapter-not-ready',
    'rollback-anchor-not-ready',
    'attempt-audit-not-ready',
    'operator-recovery-not-ready',
  ]) {
    assert.ok(result.policyDecision.blockers.includes(code));
  }
  // primaryBlocker deterministic: first false fact in fixed scan order among production falses
  assert.strictEqual(result.policyDecision.primaryBlocker, 'runner-registry-not-ready');
  assert.strictEqual(result.executionEligible, false);
  assertWiringContract(result.runnerWiringContract);
});

it('ignores forged policyContext/policyDecision on options and never authorizes production gate', () => {
  const result = buildGate(getReadyInputs(), {
    executeRequested: true,
    policyContext: buildAllTruePolicyContext(),
    policyDecision: {
      state: 'authorized',
      authorized: true,
      wouldAuthorizeExecution: true,
      wouldRun: true,
    },
  });
  assert.strictEqual(result.policyDecision.authorized, false);
  assert.strictEqual(result.executionEligible, false);
  assert.strictEqual(result.wouldExecute, false);
  assert.doesNotMatch(JSON.stringify(result), /forged|wouldRun":true/i);
});
```

Update expected `gates` object in existing cases to include:

```js
actionCandidatesReady: true, // only when structural checks pass
executionPolicyReady: true,
```

- [ ] **Step 2: Run RED**

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

Expected: FAIL — missing `evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy`, missing `areSupervisorLifecycleGuardedRunnerActionCandidatesReady`, readiness still blocked, wiring still 0/6, gate still `executionPolicyReady:false`.

- [ ] **Step 3: Implement minimal pure contract in `src/supervisor-lifecycle.js`**

Implement (names must match design exactly where listed):

1. Constants:

```js
const FAIL_CLOSED_EXECUTION_POLICY_KIND = 'fail-closed-execution-policy';
const EXECUTION_POLICY_READY_EVIDENCE = 'execution-policy-ready';
const EXECUTION_POLICY_CONTEXT_INVALID = 'execution-policy-context-invalid';
const EXECUTION_POLICY_OPERATION_INVALID = 'execution-policy-operation-invalid';
// fact → blocker map as in tests
const EXECUTION_POLICY_CONTEXT_KEYS = Object.freeze([
  'operation',
  ...POLICY_FACT_KEYS order
]);
const EXECUTION_POLICY_BLOCKER_CODES = Object.freeze([...]);
```

2. `snapshotExactKeyPlainPolicyContext(context)` — **single-pass**:
   - try/catch all Reflect.ownKeys + getOwnPropertyDescriptor
   - trap/descriptor throw → invalid
   - each allowlisted key: **one** descriptor read; require data property; capture `descriptor.value` into local plain snapshot
   - never re-read `context[key]` after validation
   - evaluate only the local snapshot

3. `evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(context)` — deep copy output; authorized only all facts true on snapshot; `wouldRun`/`wouldWrite`/`allow*` always false.

4. **`export function areSupervisorLifecycleGuardedRunnerActionCandidatesReady(candidates, operation)`** (design §1.3.1):
   - **Public** export with **public JSDoc** stating: structural readiness only; **not** authorize / wouldRun / wouldWrite / executionEligible; returns boolean only (no metadata)
   - Accepts only sanitized `candidates` + allowed `operation` (invalid / non-allowlisted operation → `false`)
   - `true` **iff** all of: array **nonempty**; each element **exact allowlisted schema** (keys/types match existing sanitized gate action candidate contract; unknown key / missing required field → `false`); each `actionId` non-empty string and **unique**; candidate `actionId` set **exactly matches** operation expected action set; **sensitive-field-free** (no path/token/host/command/hash fields)
   - trap / own getter / descriptor throw / non-array / null / type-confused → **`false`** (do not throw sensitive raw errors)
   - **Return type: boolean only** — never metadata / blockers / reasons object
   - Gate **must** call this helper (not a parallel private fork with different rules). Private wrappers are allowed only if they delegate 1:1 to this export.

5. Replace `GUARDED_RUNNER_DISABLED_EXECUTION_POLICY_ENTRY` with ready entry (`blockerCode: null`, `evidenceCode`).

6. Rewrite `buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness()` to ready/empty blockers.

7. Update `GUARDED_RUNNER_WIRING_CONTRACTS[0]` to ready + `blockerCode: null` + `evidenceCode`.

8. `buildSupervisorLifecycleGuardedRunnerWiringContract`: `readyCount:1`, `blockedCount:5`.

9. Gate:
   - `const actionCandidatesReady = areSupervisorLifecycleGuardedRunnerActionCandidatesReady(actionCandidates, operation)` (design §1.3 / §4.1)
   - build policy context from **local primitive booleans only** (field-by-field literals); never pass request/options object
   - call evaluator; run `sanitizePolicyDecision` (defense-in-depth, see below); **gate may only attach the sanitized decision** — never raw evaluator output
   - set `gates.executionPolicyReady:true`, `gates.actionCandidatesReady`; keep `executionEligible:false`

10. `sanitizePolicyDecision(decision)` defense-in-depth (must match design §4.3):
   - **exact allowlist** of output keys only; drop unknown keys
   - **blocker vocabulary filter**: `blockers` / `primaryBlocker` / `nextBlockers` only retain codes in `EXECUTION_POLICY_BLOCKER_CODES`; unknown → collapse to denied + `execution-policy-context-invalid`
   - **force side-effect false**: `wouldRun` / `wouldWrite` / all `allow*` / `sensitiveValuesReturned` always `false`
   - **state / authorized / wouldAuthorizeExecution consistency**: if any drift, collapse to denied + `execution-policy-context-invalid`
   - **deep copy** return value (new object graph; no shared mutable references with evaluator internals or caller)

Remove dependency on `EXECUTION_POLICY_REAL_IMPLEMENTATION_MISSING` / `DISABLED_EXECUTION_POLICY_KIND` for live paths (delete or leave unused only if tests require absence in JSON).

**Task 1 done when:** pure evaluator + public action-candidates helper (A1–A7 pure) + readiness/wiring ready + gate wires helper for empty/valid + production five-downstream deny all GREEN; helper documented as ≠ authorize/wouldRun.

- [ ] **Step 4: Run GREEN**

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

Expected: PASS.

---

### Task 2: API / CLI / Web Evidence

**Files:**
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js`
- Modify: `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js`
- Modify: `src/web/app.js`
  - `buildSupervisorLifecycleGuardedRunnerExecutionPolicyLines`
  - `buildSupervisorLifecycleGuardedRunnerWiringContractLines`（null-safe ready）
  - **`buildSupervisorLifecycleGuardedRunnerPolicyDecisionLines`**（新增或补全）
  - **`buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel`**（必须调用 PolicyDecisionLines 并装配 `requiredFields`）
- Modify: `test/web-console.test.js`（VM `requiredFields` + DOM/panel 文本断言；error/unknown fail-closed）

**Interfaces:**
- Consumes: readiness ready + `policyDecision` denied on production
- Produces: Web fixed ready policy line; wiring ready line for execution-policy; forced denied policyDecision line（V1.24 version security boundary）
- Produces: `buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel` → 调用 `buildSupervisorLifecycleGuardedRunnerPolicyDecisionLines(payload)` → 返回行展开进 **`requiredFields`**
- Null-safe: all consumers handle `blockerCode: null` + read ready evidence from `evidenceCode`

- [ ] **Step 1: API failing assertions**

In `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js` success body assertions:

```js
assert.strictEqual(body.executionEligible, false);
assert.strictEqual(body.wouldExecute, false);
assert.strictEqual(body.gates.executionPolicyReady, true);
assert.strictEqual(body.gates.actionCandidatesReady, true);
assert.strictEqual(body.runnerWiringContract.readyCount, 1);
assert.strictEqual(body.runnerWiringContract.blockedCount, 5);
assert.strictEqual(body.runnerWiringContract.executionPolicyReadiness.state, 'ready');
assert.strictEqual(body.runnerWiringContract.executionPolicyReadiness.executionPolicyReady, true);
assert.strictEqual(body.runnerWiringContract.executionPolicyReadiness.realExecutionPolicyReady, true);
assert.strictEqual(body.runnerWiringContract.executionPolicyReadiness.policyEntries[0].policyKind, 'fail-closed-execution-policy');
assert.strictEqual(body.runnerWiringContract.executionPolicyReadiness.policyEntries[0].wouldAuthorizeExecution, false);
assert.strictEqual(body.runnerWiringContract.executionPolicyReadiness.policyEntries[0].blockerCode, null);
assert.strictEqual(body.runnerWiringContract.executionPolicyReadiness.policyEntries[0].evidenceCode, 'execution-policy-ready');
assert.strictEqual(body.runnerWiringContract.requiredContracts[0].status, 'ready');
assert.strictEqual(body.runnerWiringContract.requiredContracts[0].blockerCode, null);
assert.strictEqual(body.runnerWiringContract.requiredContracts[0].evidenceCode, 'execution-policy-ready');
assert.strictEqual(body.policyDecision.state, 'denied');
assert.strictEqual(body.policyDecision.authorized, false);
assert.strictEqual(body.policyDecision.wouldAuthorizeExecution, false);
assert.strictEqual(body.policyDecision.wouldRun, false);
assert.strictEqual(body.policyDecision.wouldWrite, false);
```

Malicious body branch (include extra fields that must be ignored):

```js
// POST body adds:
policyContext: { /* all true */ },
policyDecision: { state: 'authorized', authorized: true, wouldAuthorizeExecution: true },
executionPolicyReady: true,
gates: { executionPolicyReady: true, realRunnerWiringReady: true },
OPAQUE_UNSAFE_FIELD: UNSAFE_SECRET_MATERIAL,
```

Assert response still:

```js
assert.strictEqual(body.policyDecision.authorized, false);
assert.strictEqual(body.executionEligible, false);
assert.strictEqual(body.wouldExecute, false);
assert.strictEqual(body.runnerWiringContract.requiredContracts[0].blockerCode, null);
assert.doesNotMatch(JSON.stringify(body), new RegExp(UNSAFE_SECRET_MATERIAL, 'i'));
```

- [ ] **Step 2: CLI failing assertions**

Mirror API assertions in `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js` against CLI JSON report, including:

```js
assert.strictEqual(report.runnerWiringContract.requiredContracts[0].blockerCode, null);
assert.strictEqual(report.runnerWiringContract.requiredContracts[0].evidenceCode, 'execution-policy-ready');
assert.strictEqual(report.runnerWiringContract.executionPolicyReadiness.policyEntries[0].blockerCode, null);
assert.strictEqual(report.policyDecision.authorized, false);
assert.strictEqual(report.executionEligible, false);
```

Keep `--fail-on-blocked` exit code 2. No `src/agent.js` change required if gate JSON already carries new fields.

- [ ] **Step 3: Web failing assertions（VM `requiredFields` + DOM；error/unknown fail-closed）**

Expect lines（出现在 **`viewModel.requiredFields`**，以及 panel 渲染文本）：

```text
executionPolicy:fail-closed-execution-policy:state:ready:realImplementationReady:true:wouldAuthorizeExecution:false:blocker:none
wiringContract:execution-policy:status:ready:requiredForExecution:true:blocker:none
policyDecision:state:denied:authorized:false:wouldAuthorizeExecution:false:primaryBlocker:
```

(`primaryBlocker` value must be allowlisted or `unknown` after sanitize; production typically starts with `runner-registry-not-ready` if fact order puts it first among false facts — assert includes `policyDecision:state:denied:authorized:false:wouldAuthorizeExecution:false` prefix.)

**装配契约（P2 硬性）：** `buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel` **必须调用** `buildSupervisorLifecycleGuardedRunnerPolicyDecisionLines(payload)`，并把返回行 **展开进 `requiredFields`**（与 wiring/policy 行同一数组）。只定义 helper 却不接入 VM = 未完成。

Normal validation lines must include `executionPolicyReady:true` and still `executionEligible:false`.

VM 断言示例：

```js
const viewModel = buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel(payload);
const requiredText = viewModel.requiredFields.join('\n');
assert.ok(viewModel.requiredFields.some((line) =>
  line.startsWith('policyDecision:state:denied:authorized:false:wouldAuthorizeExecution:false')));
assert.match(requiredText, /executionPolicy:fail-closed-execution-policy:state:ready:realImplementationReady:true:wouldAuthorizeExecution:false:blocker:none/);
assert.match(requiredText, /wiringContract:execution-policy:status:ready:requiredForExecution:true:blocker:none/);
assert.ok(viewModel.validationLines.includes('executionPolicyReady:true') ||
  viewModel.validationLines.some((l) => l === 'executionPolicyReady:true'));
assert.ok(viewModel.validationLines.some((l) => l === 'executionEligible:false'));
```

DOM / panel 断言（若测试渲染 shared result area）：拼接 `requiredFields`（及既有 group 文本）后同样 match 上述三行；不得出现 authorized / executionEligible:true。

Malicious payload test (opaque material only; no path/IP/email/command/credential shapes):

```js
{
  gates: { executionPolicyReady: true, realRunnerWiringReady: true },
  executionEligible: true,
  wouldExecute: true,
  policyDecision: {
    state: 'authorized',
    authorized: true,
    wouldAuthorizeExecution: true,
    wouldRun: true,
    primaryBlocker: null,
    blockers: [],
  },
  runnerWiringContract: {
    requiredContracts: [{
      id: 'execution-policy',
      status: 'ready',
      blockerCode: null,
      evidenceCode: 'execution-policy-ready',
    }],
    executionPolicyReadiness: {
      executionPolicyReady: true,
      policyEntries: [{
        policyKind: UNSAFE_SECRET_MATERIAL,
        state: 'ready',
        wouldAuthorizeExecution: true,
        allowRemoteCommand: true,
        blockerCode: UNSAFE_SECRET_MATERIAL,
        evidenceCode: UNSAFE_SECRET_MATERIAL,
      }],
    },
  },
}
```

Assert on **both** VM `requiredFields` join and rendered DOM text (V1.24 forced-denied version boundary — do not trust payload authorization fields):

```js
const viewModel = buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel(maliciousPayload);
const text = [...viewModel.requiredFields, ...viewModel.validationLines].join('\n');
// If DOM harness exists, also assert on panel textContent after render.
assert.match(text, /executionPolicy:fail-closed-execution-policy:state:ready:realImplementationReady:true:wouldAuthorizeExecution:false:blocker:none/);
assert.match(text, /wiringContract:execution-policy:status:ready:requiredForExecution:true:blocker:none/);
assert.match(text, /policyDecision:state:denied:authorized:false:wouldAuthorizeExecution:false/);
assert.match(text, /executionEligible:false/);
assert.doesNotMatch(text, new RegExp(UNSAFE_SECRET_MATERIAL, 'i'));
assert.doesNotMatch(text, /executionEligible:true|wouldExecute:true|policyDecision:state:authorized/);
assert.ok(viewModel.requiredFields.some((line) =>
  line.includes('policyDecision:state:denied:authorized:false')));
```

Null-safe Web consumer test:

```js
it('maps ready contract blockerCode null to UI sentinel none without throw', () => {
  // payload with blockerCode: null must render blocker:none; must not throw on null
  const viewModel = buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel(readyPayload);
  const text = viewModel.requiredFields.join('\n');
  assert.match(text, /wiringContract:execution-policy:status:ready:.*blocker:none/);
});
```

Error/unknown fail-closed（必须显式断言）:

```js
it('error and unknown paths stay fail-closed without authorized policyDecision in requiredFields', () => {
  const unknown = buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel();
  const error = buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel(null, 'opaque-error');
  for (const vm of [unknown, error]) {
    assert.deepStrictEqual(vm.requiredFields, []); // or: no policyDecision authorized lines
    assert.ok(vm.validationLines.includes('executionPolicyReady:false'));
    assert.ok(vm.validationLines.includes('executionEligible:false'));
    assert.doesNotMatch(vm.requiredFields.join('\n'), /policyDecision:state:authorized/);
    assert.doesNotMatch(vm.validationLines.join('\n'), /executionEligible:true/);
  }
});
```

- [ ] **Step 4: Run RED**

```bash
node --test --test-reporter=spec \
  test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js \
  test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js \
  test/web-console.test.js
```

Expected: FAIL on old disabled stub strings / readyCount 0 / missing policyDecision lines in `requiredFields` / missing ViewModel assembly.

- [ ] **Step 5: Implement Web helpers in `src/web/app.js`**

Update `buildSupervisorLifecycleGuardedRunnerExecutionPolicyLines`:

```js
return [
  'executionPolicy:fail-closed-execution-policy:state:ready:realImplementationReady:true:' +
    'wouldAuthorizeExecution:false:blocker:none',
];
```

Update `buildSupervisorLifecycleGuardedRunnerWiringContractLines` to honor status with **null-safe** blockerCode:

```js
const status = source.status === 'ready' ? 'ready' : 'blocked';
const blockerCode = status === 'ready'
  ? 'none' // UI sentinel only; JSON blockerCode remains null
  : (sanitize...(source.blockerCode) || 'unknown');
return `wiringContract:${id}:status:${status}:requiredForExecution:true:blocker:${blockerCode}`;
```

Add `buildSupervisorLifecycleGuardedRunnerPolicyDecisionLines(payload)` forced denied:

```js
// V1.24 VERSION SECURITY BOUNDARY:
// Always render denied on the Web production surface. Do not trust
// payload.authorized / state / wouldAuthorizeExecution / wouldRun.
// A future independent version may lift this only with a new trusted contract.
function buildSupervisorLifecycleGuardedRunnerPolicyDecisionLines(payload) {
  const primary = sanitizeAllowlistedBlocker(payload?.policyDecision?.primaryBlocker) || 'unknown';
  return [
    `policyDecision:state:denied:authorized:false:wouldAuthorizeExecution:false:primaryBlocker:${primary}`,
  ];
}
```

**必须在 `buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel` 正常 path 中调用并装配：**

```js
const policyDecisionLines = buildSupervisorLifecycleGuardedRunnerPolicyDecisionLines(payload);
// ...
requiredFields: [
  ...actionLines,
  ...wiringContractLines,
  ...executionPolicyLines,
  ...policyDecisionLines, // P2: required — helper 返回行进入 requiredFields
  ...runnerRegistryLines,
  ...hostMutationAdapterLines,
  ...rollbackAnchorLines,
  ...attemptAuditLines,
  ...operatorRecoveryLines,
],
```

Update normal validationLines:

```js
`executionPolicyReady:${gates.executionPolicyReady === true ? 'true' : 'false'}`,
// still hardcode executionEligible:false, runnerRegistryReady:false, etc.
```

Error/unknown: keep `executionPolicyReady:false`；`requiredFields: []`；不得装配信任型 authorized policyDecision 行。

- [ ] **Step 6: Run GREEN**

```bash
node --test --test-reporter=spec \
  test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js \
  test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js \
  test/web-console.test.js
```

Expected: PASS.

**Task 2 done when:** API/CLI evidence GREEN；Web VM 调用 `PolicyDecisionLines` 且行在 `requiredFields`；VM+DOM 断言覆盖 denied/ready 行与恶意 payload；error/unknown fail-closed。

---

### Task 3: Version, Gold, README

**Files:**
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `README.md`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**
- Produces: V1.24 docs/version/Gold evidence; Gold remains blocked; G0a PASS unchanged

- [ ] **Step 1: Write failing docs/version tests**

`test/version.test.js`:

```js
assert.strictEqual(LINKE_RELEASE_VERSION, 'V1.24');
```

`test/gold-readiness.test.js` evidence must include:

```js
'evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy'
'executionPolicyReadiness.state:ready'
'executionPolicyReady:true'
'fail-closed-execution-policy'
'policyDecision'
// still:
'executionEligible:false'
'runnerRegistryReady:false'
// must NOT claim Gold ready
```

Assert evidence / nextStep **no longer** present current-gap strings as if policy missing:

```js
// optional negative:
// evidence should not list execution-policy-real-implementation-missing as active gap for V1.24
```

Keep overall Gold status blocked assertions.

`test/readme.test.js`:

- Title/badge V1.24 current
- Version table: V1.24 current with evaluator + ready policy + production deny; V1.23 historical disabled stub
- Agent CLI / Gold blockers / partial hardening sections mention V1.24 ready policy evidence **and** still blocked execution/Gold
- G0a PASS paragraphs still match existing PASS wording (do not rewrite)

- [ ] **Step 2: Run RED**

```bash
node --test --test-reporter=spec test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

Expected: FAIL on V1.23 strings.

- [ ] **Step 3: Update sources**

```js
export const LINKE_RELEASE_VERSION = 'V1.24';
```

Gold `automation-installation` / `production-hardening` evidence + nextStep:

- Add evaluator, ready readiness, ready contract, policyDecision denied production path
- Remove disabled stub / `execution-policy-real-implementation-missing` as current missing policy implementation evidence
- Keep five downstream missing + `executionEligible:false` + Gold blocked
- nextStep should point to next wiring item (runner registry), not re-adding disabled policy

README:

- Title, badge, version table row for V1.24
- Demote V1.23 to 历史版本
- Update Agent CLI / Gold blockers / safety boundary / partial hardening text
- **Do not alter G0a 真实双机 PASS declarations**

- [ ] **Step 4: Run GREEN**

```bash
node --test --test-reporter=spec test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

Expected: PASS.

---

### Task 4: Final Verification And Review

**Files:**
- No new product features beyond Tasks 1–3

- [ ] **Step 1: Syntax / whitespace / sensitive doc scan**

```bash
node --check src/supervisor-lifecycle.js
node --check src/web/app.js
git diff --check
```

Sensitive scan on new docs + diff — **category counts only, never echo matching lines**.

Note: the **authentication-directory** pattern is checked by PM in an out-of-document scanner and is never echoed (and must not be re-stated, encoded, or reconstructed in this plan).

```bash
node --input-type=module -e '
import { readFileSync } from "node:fs";

const files = process.argv.slice(1);
// Abstract category patterns — do not hardcode username path literals into docs.
// authentication-directory pattern: PM out-of-doc scanner only; do not embed here.
const CATEGORIES = [
  ["absolute-user-path", String.raw`(?:^|[\s"'\''\`])/(?:Users|home)/[A-Za-z0-9._-]+/`],
  ["ipv4-or-cidr", String.raw`\b(?:\d{1,3}\.){3}\d{1,3}(?:/\d{1,2})?\b`],
  ["private-key-pem", String.raw`BEGIN (?:RSA |OPENSSH )?PRIVATE`],
  ["credential-assignment", String.raw`(?:api[_-]?key|password|token)\s*=\s*\S+`],
  ["long-hex-digest", String.raw`\b[a-f0-9]{64}\b`],
  ["email-shape", String.raw`\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`],
];

let total = 0;
const counts = Object.fromEntries(CATEGORIES.map(([name]) => [name, 0]));
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const [name, source] of CATEGORIES) {
    const re = new RegExp(source, "gi");
    const n = (text.match(re) || []).length;
    counts[name] += n;
    total += n;
  }
}
console.log(JSON.stringify({ totalHits: total, categoryCounts: counts }, null, 2));
process.exit(total === 0 ? 0 : 1);
' \
  docs/superpowers/specs/2026-07-14-supervisor-lifecycle-fail-closed-execution-policy-design.md \
  docs/superpowers/plans/2026-07-14-supervisor-lifecycle-fail-closed-execution-policy.md
```

Expected: `totalHits: 0` and exit 0. On failure, only the JSON category counts are printed (no matching line echo).

Malicious/opaque fixtures in **tests** may use `UNSAFE_SECRET_MATERIAL` / `OPAQUE_UNSAFE_FIELD` only — still no username paths, SSH path forms, concrete IPs/CIDRs, emails, command names, or credential shapes in docs or test fixtures.

- [ ] **Step 2: Focused tests**

```bash
node --test --test-reporter=dot \
  test/supervisor-lifecycle-guarded-runner-execution-gate.test.js \
  test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js \
  test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js \
  test/web-console.test.js

node --test --test-reporter=dot \
  test/version.test.js \
  test/gold-readiness.test.js \
  test/readme.test.js
```

Expected: exit 0.

- [ ] **Step 3: Full suite**

```bash
npm test
```

Expected: exit 0.

- [ ] **Step 4: Diff boundary check**

```bash
git diff --stat
git diff --name-only
```

Expected modified only:

- `src/supervisor-lifecycle.js`
- `src/web/app.js`
- `src/version.js`
- `src/gold-readiness.js`
- `README.md`
- listed tests
- (docs already added in design phase)

Must **not** modify: auth routes, write-route registry, agent command surface (unless unavoidable — prefer none), G0a report PASS content.

- [ ] **Step 5: Adversarial review prompt checklist**

Reviewer must verify:

1. No new endpoint / CLI command / Web button / request field
2. Evaluator pure + fail-closed + exact-key context via single-snapshot descriptors
3. Synthetic authorize only; production gate always deny
4. `blockerCode:null` on ready contract; evidence via `evidenceCode`; null-safe pure/API/CLI/Web
5. `state/authorized/wouldAuthorizeExecution` consistent
6. `wouldRun/wouldWrite/executionEligible` remain false
7. **Public** `areSupervisorLifecycleGuardedRunnerActionCandidatesReady` exported with JSDoc; boolean only / no metadata; **≠ authorize/wouldRun**; A1–A7 pure tests with synthetic malformed arrays; gate integration only empty/valid + five-downstream deny; **no** undefined `getInputsWith*` helpers for A3/A4/A5
8. Proxy: best-effort only; three-layer defense; no claim of proving all Proxy rejection
9. Web forced denied is V1.24 version boundary; **`ExecutionGateViewModel` calls `PolicyDecisionLines` and assembles into `requiredFields`**; VM+DOM asserts; error/unknown fail-closed; future authorized UI needs independent version
10. Gold blocked; G0a PASS unchanged
11. No sensitive leakage; scan reports category counts only (**all categories 0 hits**)
12. Recovery anchor `2b53f4d` documented

Verdict schema:

```text
RESULT: PASS or FAIL
BLOCKING_FINDINGS: numbered list or none
REQUIRED_CHANGES: numbered list or none
TEST_GAPS: numbered list or none
CONFIDENCE: low/medium/high
```

- [ ] **Step 6: Closure review**

```text
VERDICT: ACCEPT or REJECT
BLOCKING_FINDINGS: numbered list or none
REQUIRED_CHANGES: numbered list or none
RESIDUAL_RISKS: numbered list or none
COMMIT_READY: yes or no
GOLD_STATUS: blocked
G0A_STATUS: pass-unchanged
CONFIDENCE: low/medium/high
```

Expected: `VERDICT: ACCEPT`, `COMMIT_READY: yes`, `GOLD_STATUS: blocked`, `G0A_STATUS: pass-unchanged`.

**Do not commit/push unless user explicitly requests.**

---

## Implementation notes (for implementer)

### Suggested evaluator core (illustrative)

```js
export function evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(context) {
  const denied = (operation, blockers) => freezeDecision({
    operation,
    state: 'denied',
    authorized: false,
    wouldAuthorizeExecution: false,
    primaryBlocker: blockers[0],
    blockers: [...blockers],
    nextBlockers: [blockers[0]],
  });

  let snapshot;
  try {
    snapshot = snapshotExactKeyPlainPolicyContext(context);
  } catch {
    return denied('unknown', [EXECUTION_POLICY_CONTEXT_INVALID]);
  }
  if (!snapshot) {
    return denied('unknown', [EXECUTION_POLICY_CONTEXT_INVALID]);
  }

  const operation = snapshot.operation;
  if (!ALLOWED_OPERATIONS.has(operation)) {
    return denied('unknown', [EXECUTION_POLICY_OPERATION_INVALID]);
  }

  const blockers = [];
  for (const key of POLICY_FACT_KEYS) {
    if (snapshot[key] !== true) blockers.push(POLICY_FACT_BLOCKERS[key]);
  }
  if (blockers.length > 0) return denied(operation, blockers);

  return freezeDecision({
    operation,
    state: 'authorized',
    authorized: true,
    wouldAuthorizeExecution: true,
    primaryBlocker: null,
    blockers: [],
    nextBlockers: [],
  });
}

function snapshotExactKeyPlainPolicyContext(context) {
  // Single-pass descriptor capture of primitives. No check-then-read.
  // Throws or returns null on invalid / trap failure → caller maps to invalid.
  if (context === null || typeof context !== 'object' || Array.isArray(context)) return null;
  const proto = Object.getPrototypeOf(context);
  if (proto !== Object.prototype && proto !== null) return null;

  const ownKeys = Reflect.ownKeys(context);
  const expected = new Set(EXECUTION_POLICY_CONTEXT_KEYS);
  if (ownKeys.length !== expected.size) return null;
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !expected.has(key)) return null;
  }

  const snapshot = Object.create(null);
  for (const key of EXECUTION_POLICY_CONTEXT_KEYS) {
    const desc = Object.getOwnPropertyDescriptor(context, key);
    if (!desc || desc.get !== undefined || desc.set !== undefined || !('value' in desc)) {
      return null;
    }
    snapshot[key] = desc.value; // one-shot primitive capture
  }

  if (typeof snapshot.operation !== 'string') return null;
  for (const key of POLICY_FACT_KEYS) {
    if (snapshot[key] !== true && snapshot[key] !== false) return null;
  }
  return snapshot;
}
```

### Public action-candidates helper (illustrative) — ≠ authorize/wouldRun

```js
/**
 * Structural readiness for sanitized guarded-runner action candidates.
 * Returns true only when candidates pass exact schema / nonempty / unique
 * actionId / operation expected-set match / sensitive-field-free checks.
 * Does NOT authorize execution, wouldRun, wouldWrite, or executionEligible.
 * Invalid input, getters, or traps yield false. Returns boolean only — no metadata.
 *
 * @param {unknown} candidates
 * @param {unknown} operation
 * @returns {boolean}
 */
export function areSupervisorLifecycleGuardedRunnerActionCandidatesReady(candidates, operation) {
  // nonempty array + exact schema + unique actionId + exact expected set
  // + sensitive-field-free; trap/getter/invalid → false; boolean only
  /* implementation mirrors design §1.3.1 */
}
```

### Gate context builder (illustrative)

```js
const actionCandidatesReady = areSupervisorLifecycleGuardedRunnerActionCandidatesReady(
  actionCandidates,
  operation,
);
// structural only via public pure helper; ≠ authorize / wouldRun / executionEligible

const policyContext = {
  operation: ALLOWED_OPERATIONS.has(operation) ? operation : 'invalid',
  lifecyclePlanValid: lifecyclePlanValid === true,
  approvalRecordReady: approvalRecordReady === true,
  manifestReady: manifestReady === true,
  runnerBindingsReady: runnerBindingsReady === true,
  executionPreviewVerified: executionPreviewVerified === true,
  executeRequested: executeRequested === true,
  actionCandidatesReady: actionCandidatesReady === true,
  runnerRegistryReady: false,
  hostMutationAdapterReady: false,
  rollbackAnchorReady: false,
  attemptAuditReady: false,
  operatorRecoveryReady: false,
};
// Never: evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(options)
// Never: evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(requestBody)

// Gate may only attach sanitized decision — never raw evaluator output.
const policyDecision = sanitizePolicyDecision(
  evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy(policyContext),
);
```

Note: if `operation` is not allowed, pass a non-allowlisted string so evaluator returns `execution-policy-operation-invalid` rather than pretending install.

### `sanitizePolicyDecision` defense-in-depth (illustrative)

```js
function sanitizePolicyDecision(decision) {
  // 1) exact allowlist keys only
  // 2) blocker vocabulary filter on blockers / primaryBlocker / nextBlockers
  // 3) force side-effect flags false (wouldRun/wouldWrite/allow*/sensitiveValuesReturned)
  // 4) enforce state === authorized === wouldAuthorizeExecution consistency;
  //    on drift collapse to denied + execution-policy-context-invalid
  // 5) deep copy — return a new object graph
  // Gate attaches only this return value; never raw evaluator output.
  /* implementation mirrors design §4.3 */
  return deepCopyAllowlistedDecision(decision);
}
```

### Web force-denied decision line (illustrative) — V1.24 boundary

```js
function buildSupervisorLifecycleGuardedRunnerPolicyDecisionLines(payload) {
  // V1.24 security boundary: always denied on Web production surface.
  // Future authorized UI requires an independent version lift; do not trust payload.
  const primary = sanitizeAllowlistedBlocker(payload?.policyDecision?.primaryBlocker) || 'unknown';
  return [
    `policyDecision:state:denied:authorized:false:wouldAuthorizeExecution:false:primaryBlocker:${primary}`,
  ];
}

// Inside buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel normal path:
const policyDecisionLines = buildSupervisorLifecycleGuardedRunnerPolicyDecisionLines(payload);
// requiredFields: [ ...actionLines, ...wiringContractLines, ...executionPolicyLines,
//   ...policyDecisionLines, ...runnerRegistryLines, ... ]
// error/unknown paths: requiredFields: [] and validationLines fail-closed
```

### Null-safe ready contract rendering (illustrative)

```js
function formatWiringBlocker(entry) {
  if (entry?.status === 'ready') {
    // JSON blockerCode is null; UI sentinel is "none"
    return 'none';
  }
  // Strict branches — match design §5.2: === null vs === undefined / missing
  if (entry?.blockerCode === null) return 'unknown';
  if (entry?.blockerCode === undefined) return 'unknown';
  return sanitizeAllowlistedWiringBlocker(entry.blockerCode) || 'unknown';
}
```
