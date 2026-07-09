# Linke V1.06 Supervisor Lifecycle Guarded Runner Readiness CLI

## Goal

Expose the V1.05 guarded runner binding readiness contract through a read-only Agent CLI command.

## Scope

- Add `agent.js supervisor-lifecycle-guarded-runner-readiness`.
- Require explicit `--config`, `--operation`, `--manifest`, and `--runner-binding` inputs.
- Build plan, validate executor manifest readiness, then call `buildSupervisorLifecycleGuardedRunnerReadiness`.
- Print sanitized blocked JSON.
- Support `--fail-on-blocked` with exit code 2 when top-level state is blocked.
- Reject `--apply`, `--approval`, `--data-dir`, and `--output`.
- Update version, README, Gold readiness evidence, and tests to V1.06.

## Out Of Scope

- No API or Web surface in V1.06.
- No runner execution, lifecycle apply, launchctl, filesystem write, NAS connection, backup, restore, remote command, or approval-store mutation.

## Sub-Agent Notes

- AGY was requested as implementer, but the V1.06 prompt drifted into Antigravity CLI scratch and `--print-timeout` analysis instead of the Linke worktree.
- PM interrupted AGY and implemented the bounded fallback.
- Qwen and DeepSeek remain required review and closure stages before commit.

## Verification

Targeted commands:

```bash
node --test --test-reporter=spec test/agent-supervisor-lifecycle-guarded-runner-readiness.test.js test/version.test.js test/gold-readiness.test.js test/readme.test.js
git diff --check
```

Full commands before release commit:

```bash
node --test --test-reporter=dot test/*.test.js
npm test
```
