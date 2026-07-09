# Linke V1.07 Supervisor Lifecycle Guarded Runner Readiness API Design

## Goal

Expose the V1.06 guarded runner binding readiness contract through a read-only server API endpoint without adding Web UI or real lifecycle execution.

## Scope

- Add `POST /api/supervisor-lifecycle-guarded-runner-readiness`.
- Accept inline JSON only: `operation`, `config`, `manifest`, and `runnerBinding`.
- Reuse `validateConfig`, `buildSupervisorLifecycleApplyPlan`, `validateSupervisorLifecycleExecutorManifest`, and `buildSupervisorLifecycleGuardedRunnerReadiness`.
- Keep the endpoint outside `API_WRITE_ROUTES` so a read token can call it.
- Return sanitized blocked readiness with `executorReady:false`, `guarded-runner-execution-disabled`, `wouldRun:false`, `wouldWrite:false`, and read-only safety flags.

## Out Of Scope

- No Web Console control in V1.07.
- No local config path, manifest path, runner binding path, approval path, or dataDir input.
- No runner execution, lifecycle apply execution, launchctl call, filesystem write, approval-store mutation, NAS access, backup, restore, or remote command.

## Error Handling

- Invalid operation returns the existing fixed 400 operation message.
- Invalid config returns a fixed sanitized 400 message.
- Invalid manifest or runner binding validation failures return a fixed sanitized 400 message.
- Missing inline runner binding is handled by the readiness builder as blocked readiness, not as a transport error.
- Submitted extra fields such as `approval`, `dataDir`, `apply`, `output`, or path-like fields are ignored and must not leak in responses.

## Runtime Resilience

- Normal state: request returns HTTP 200 blocked readiness for valid inline config and manifest.
- Recovery anchor: no state is changed, so failed requests recover by retrying with corrected inline JSON.
- Failure detection: validation blockers and fixed 400 messages are the observable signals.
- Highest risk path: unsafe runner binding values must be redacted while the response remains blocked and read-only.

## Acceptance

- API route is absent from `API_WRITE_ROUTES`.
- Read token can call it.
- Valid inline manifest and runner binding return blocked readiness with `runnerBindingsReady:true` and `executorReady:false`.
- Unsafe runner binding values are redacted.
- Missing runner binding returns blocked readiness with runner blockers.
- Invalid operation/config/validation errors are sanitized.
- Tests, README, version, and Gold readiness evidence are updated to V1.07.
