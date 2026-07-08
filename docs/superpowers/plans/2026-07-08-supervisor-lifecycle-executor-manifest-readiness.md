# Linke V1.01 Supervisor Lifecycle Executor Manifest Readiness

## Goal

Add a pure, read-only executor implementation manifest readiness contract without adding I/O, API, Web, launchctl, filesystem writes, NAS calls, backup/restore triggers, remote commands, or any Gold-ready claim.

## Role Map

- PM: Codex
- Implementer: AGY, write scope limited to `src/supervisor-lifecycle.js` and `test/supervisor-lifecycle-executor-manifest.test.js`
- Adversary: Qwen, read-only planning review
- Closure verifier: DeepSeek after local verification

## Qwen Planning Finding

Qwen returned `PASS` with conditions:

- Freeze manifest schema in V1.01.
- Define unsafe reasons clearly.
- Do not change the existing `buildSupervisorLifecycleExecutorReadiness` signature.
- Do not introduce manifest file reads or new API/Web surfaces.

PM accepted those findings and narrowed V1.01 to a pure function contract.

## Implementation Scope

- Add `validateSupervisorLifecycleExecutorManifest(plan, manifest)`.
- Return sanitized `supervisor-lifecycle-executor-manifest-readiness`.
- Keep `state:"blocked"` and `executorReady:false` for all outputs.
- Keep `guarded-executor-runner-missing` as the top-level next blocker when manifest schema is valid.
- Validate manifest `kind`, `schemaVersion`, action coverage, required fields, safe slug, guarded mode, approval record requirement, max attempts, extra fields, unresolved placeholders, and secret/path/command-like values.
- Keep every action manifest `wouldRun:false` and `wouldWrite:false`.

## Verification Targets

- `test/supervisor-lifecycle-executor-manifest.test.js`
- `test/supervisor-lifecycle-executor.test.js`
- `test/supervisor-lifecycle*.test.js`
- `test/version.test.js`
- `test/gold-readiness.test.js`
- `test/readme.test.js`
- `git diff --check`
- `npm test`

## Remaining Gold Blockers

- Real guarded lifecycle apply runner binding
- Real installer and launchd install/start
- Watchdog and monitoring
- Rollback, uninstall, and recovery supervisor execution
- Real NAS remote backup
- Production auth, secret management, audit hardening, and managed daemon lifecycle
