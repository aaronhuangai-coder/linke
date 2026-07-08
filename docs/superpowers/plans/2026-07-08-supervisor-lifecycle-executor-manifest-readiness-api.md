# Linke V1.03 Supervisor Lifecycle Executor Manifest Readiness API

## Goal

Add a read-only server API endpoint that exposes the executor manifest readiness contract without adding real lifecycle execution.

## Role Map

- PM: Codex
- Implementer: AGY requested, but AGY returned no useful implementation output in the prior V1.03 handoff; PM implemented the fallback under the user's standing loop authorization.
- Adversary: Qwen
- Closure verifier: DeepSeek after local verification

## Qwen Findings

Qwen returned `DONE_WITH_CONCERNS` and recommended proceeding with these constraints:

- Do not copy existing API handlers that return raw `validateConfig` messages.
- Keep config and manifest validation failures on fixed sanitized 400 responses.
- Keep this route outside `API_WRITE_ROUTES` so read tokens can call it as a read-only preflight.
- Do not accept local manifest paths, approval store paths, lifecycle apply flags, or dataDir input.

PM accepted all four findings as implementation requirements.

## Scope

- Add `POST /api/supervisor-lifecycle-executor-manifest-readiness`.
- Accept only inline `operation`, `config`, and `manifest`.
- Reuse `validateConfig`, `buildSupervisorLifecycleApplyPlan`, and `validateSupervisorLifecycleExecutorManifest`.
- Return blocked manifest readiness for missing inline manifests instead of throwing.
- Keep errors and blocked output sanitized.
- Keep README, version, and Gold readiness evidence synchronized to V1.03.

## Verification Targets

- Read token can call the endpoint.
- The endpoint is not registered in `API_WRITE_ROUTES`.
- Valid inline manifest returns `state:"blocked"`, `manifestReady:true`, `executorReady:false`, and `guarded-executor-runner-missing`.
- Unsafe manifest values are redacted.
- Invalid operation and config errors do not echo submitted values.
- Submitted approval/dataDir fields are ignored and do not create approval storage.

## Gold Boundary

V1.03 still does not implement the guarded executor runner, launchctl integration, rollback, uninstall, recovery supervisor, production auth, or real NAS remote backup.
