# Supervisor Lifecycle Fake Executor Contract Design

## Goal

V0.88 adds a fake-executor contract for supervisor lifecycle apply.
The purpose is to make the future execution boundary testable without enabling real host mutation.

V0.87 already added `buildSupervisorLifecycleApplyPlan()` and the `supervisor-lifecycle-apply` CLI gate.
Every apply path still returns `executor-implementation-missing`.
V0.88 keeps that production blocker in place and adds a pure execution harness that can be driven only by an injected fake executor in unit tests.

## Current Boundary

- `buildSupervisorLifecycleApplyPlan(config, options)` remains the source of plan shape, hashes, blockers, gates, actions, and safety flags.
- The Agent CLI must continue to print blocked reports and exit `2` for `--apply`, even when the approval and environment gate are valid.
- No Web Console lifecycle apply button, API apply endpoint, LaunchAgents write, `launchctl` call, metadata write, audit file write, NAS command, backup, restore, or remote command is introduced in V0.88.
- Gold remains blocked.

## Interface

Add this export to `src/supervisor-lifecycle.js`:

```js
executeSupervisorLifecycleApply(plan, executor, options = {})
```

The function accepts only an existing lifecycle plan plus an injected executor. It does not read config files, approval files, environment variables, process lists, or host paths.

Required fake-mode guard:

- `options.mode` must equal `fake-test-only`.
- `executor.kind` must equal `fake-supervisor-lifecycle-executor`.
- `executor.runAction` must be a function.
- The input plan must be a supervisor lifecycle plan with an operation, actions, and a blocker list.
- Simulation is allowed only when `plan.blockers` is exactly `['executor-implementation-missing']`.
  A plan with an empty blocker list, missing executor blocker, or any additional blocker is blocked.
- The plan action ids must exactly match the known action sequence for the requested operation.
  Tampered action ids are blocked before the executor is called and are not echoed in the result.
- Returned blocker values must come from a fixed safe allowlist.
  Unknown blocker strings from a tampered plan are replaced with a generic blocker code.

If any guard fails, the result is blocked and `executor.runAction` is not called.

## Execution Semantics

V0.88 is simulation only. A successful fake execution returns `state:"simulated"`, never `state:"completed"`.

The function may simulate only when the plan has no blockers except `executor-implementation-missing`.
That means approval, environment gate, and operation-specific gates still matter.
For `recover`, the existing `recovery-supervisor-design-missing` blocker prevents simulation.

When simulation is allowed:

1. Iterate plan actions in order.
2. Call `executor.runAction(action, context)` with structured data, not shell strings.
3. Retry each action at most two attempts total.
4. Stop on the first failed action after retries.
5. Return sanitized events for each attempt.

V0.88 uses immediate fake retries only.
It must not add `setTimeout`, sleep, backoff, polling, timers, or retry delay logic.
Real executor delay policy is future work.

`context` contains only:

- `operation`
- `actionId`
- `attempt`
- `maxAttempts`
- `mode:"fake-test-only"`

It must not contain approval metadata, config contents, local path values, shell command strings, tokens, or user identity.

## Failure Semantics

Guard failure returns:

```js
{
  command: 'supervisor-lifecycle-apply',
  operation,
  state: 'blocked',
  blockers: [...],
  events: [],
  safety: { ...all mutation flags false... }
}
```

Action failure returns `state:"failed"` with blocker `fake-executor-action-failed`.
The response identifies only `failedActionId` and `attempts`.
It does not include thrown error messages or executor-provided sensitive text.

## Event Redaction

Events are intentionally narrow:

```js
{
  operation,
  actionId,
  attempt,
  status: 'simulated' | 'failed',
  mode: 'fake-test-only'
}
```

Events must not include:

- approval fields such as `approvedBy`, `reason`, `acknowledgements`, `approvedAt`, or `expiresAt`
- config values or backup source paths
- absolute filesystem paths
- command names or arguments
- environment variables
- hostnames, usernames, PIDs, tokens, passwords, or secrets

## Safety Invariants

Every V0.88 execution result keeps:

```js
safety: {
  dryRun: true,
  hostMutation: false,
  launchctlCalled: false,
  filesystemWritten: false,
  metadataWritten: false,
  rollbackAnchorWritten: false,
  auditEventWritten: false,
  sensitiveValuesReturned: false
}
```

The fake executor may record calls in test memory, but the production code must not instantiate a real executor or perform host writes.

## Tests

Add unit tests for:

- guard failure when the plan is missing or invalid
- guard failure when the executor is missing
- guard failure when mode is missing
- guard failure when executor kind is wrong
- guard failure when required plan gates are still blocked
- guard failure when a tampered plan has no `executor-implementation-missing` blocker
- guard failure when a tampered plan changes the expected action sequence
- redaction when a tampered plan includes unsafe blocker strings
- valid fake simulation with ordered actions
- successful fake simulation returns `state:"simulated"` and never `state:"completed"`
- retry cap of two attempts per action
- `runAction` is never called more than `actions.length * 2` times
- first failed action stops the sequence
- `recover` remains blocked
- returned events do not leak approval metadata, local paths, command strings, or secret-like text
- executor context contains exactly `operation`, `actionId`, `attempt`, `maxAttempts`, and `mode`
- safety flags remain false

Add CLI regression coverage proving the Agent CLI still does not invoke the fake executor and valid apply approval still exits `2` with `executor-implementation-missing`.
Add Web/API regression coverage proving no supervisor lifecycle apply endpoint exists and no server route invokes the fake executor.

Update README, version, Gold readiness, and documentation tests to mark V0.88 as current while keeping Gold blocked.

## Non-Goals

- No real supervisor executor.
- No `launchctl`.
- No LaunchAgents write.
- No approval persistence.
- No rollback anchor persistence.
- No audit event write.
- No Web/API lifecycle apply surface.
- No recovery supervisor implementation.
- No Gold-ready claim.

## Acceptance Criteria

- `executeSupervisorLifecycleApply()` exists and is covered by focused unit tests.
- Tests prove the fake executor is simulation-only and cannot be reached from the CLI.
- Full test suite passes.
- Overclaim scans show no production-ready, launchctl, filesystem write, or Gold-ready claim introduced by V0.88.
- Qwen adversarial review and DeepSeek closed-loop verification return pass or no blocking findings, with PM independently verifying the evidence.
