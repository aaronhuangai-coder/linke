# Linke V1.02 Supervisor Lifecycle Executor Manifest Readiness CLI

## Goal

Add a read-only Agent CLI command that exposes the V1.01 executor manifest readiness contract without adding real lifecycle execution.

## Role Map

- PM: Codex
- Implementer: AGY requested, but the AGY implementation prompt exited with no output and no diff; AGY smoke also exceeded the wait budget and was killed.
- Adversary: Qwen
- Closure verifier: DeepSeek after local verification

## Qwen Findings

Qwen returned `DONE_WITH_CONCERNS` and flagged three main risks:

- CLI path arguments can appear in argv/shell history.
- Manifest parsing and validation errors must not leak manifest values.
- Blocked output must not dump config, plan, or manifest raw content.

PM accepted the second and third findings as hard implementation constraints. The argv path concern is a known CLI boundary shared with existing `--config` commands; V1.02 mitigates it by never echoing config or manifest paths and documenting the command as local read-only tooling.

## Scope

- Add `agent.js supervisor-lifecycle-executor-manifest-readiness --config <path> --operation <operation> --manifest <path>`.
- Reuse `buildSupervisorLifecycleApplyPlan` and `validateSupervisorLifecycleExecutorManifest`.
- Support `--fail-on-blocked` with exit code 2 when the returned readiness state is blocked.
- Reject `--apply`, `--approval`, `--data-dir`, and `--output`.
- Keep all errors sanitized.

## Verification Targets

- CLI valid manifest remains `state:"blocked"` with `manifestReady:true`, `executorReady:false`, and `guarded-executor-runner-missing`.
- CLI unsafe manifest redacts secret/path/command-like values.
- CLI config and manifest read/parse errors do not leak file paths or content.
- README, version, and Gold readiness evidence stay synchronized to V1.02.

## Gold Boundary

V1.02 still does not implement the guarded executor runner, launchctl integration, rollback, uninstall, recovery supervisor, production auth, or real NAS remote backup.
