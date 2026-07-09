# Linke V1.05 Supervisor Lifecycle Guarded Runner Readiness

## Goal

Add a pure, read-only readiness layer after executor manifest readiness that validates guarded runner binding metadata without running lifecycle apply or touching the host.

## Scope

- Add `buildSupervisorLifecycleGuardedRunnerReadiness(manifestReadiness, runnerBinding)`.
- Validate `kind:"supervisor-lifecycle-guarded-runner-binding"` and `schemaVersion:1`.
- Require one binding per action manifest with exact `actionId`, `implementationId`, and `mode` match.
- Keep `executorReady:false`, `state:"blocked"`, and `guarded-runner-execution-disabled` even when bindings are complete.
- Keep every runner binding `wouldRun:false` and `wouldWrite:false`.
- Update release version, Gold readiness evidence, README, and tests to V1.05.

## Out Of Scope

- No CLI, API, or Web surface in V1.05.
- No real runner implementation.
- No launchctl, filesystem write, NAS connection, backup, restore, remote command, approval-store mutation, or lifecycle apply.

## Sub-Agent Notes

- AGY was requested as implementer, but both the bounded implementation prompt and a minimal smoke prompt returned `authentication failed or timed out`.
- PM implemented the scoped fallback to keep loop engineering moving.
- Qwen remains the adversarial review stage.
- DeepSeek remains the closure verification stage.

## Verification

Targeted commands:

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-readiness.test.js test/version.test.js test/gold-readiness.test.js test/readme.test.js
git diff --check
```

Full commands before release commit:

```bash
node --test --test-reporter=dot test/*.test.js
npm test
```
