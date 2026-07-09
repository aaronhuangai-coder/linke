# Linke V1.08 Supervisor Lifecycle Guarded Runner Readiness Web Design

## Goal

Expose the V1.07 guarded runner binding readiness API through the existing Web Console supervisor lifecycle panel as a manual read-only check.

## Scope

- Reuse the existing supervisor lifecycle approval preview panel.
- Add a runner binding JSON textarea with `data-testid="supervisor-lifecycle-guarded-runner-readiness-runner-binding"`.
- Add a manual button with `data-testid="supervisor-lifecycle-guarded-runner-readiness-button"`.
- Add a safety note with `data-testid="supervisor-lifecycle-guarded-runner-readiness-safety-note"`.
- Add `buildSupervisorLifecycleGuardedRunnerReadinessViewModel`.
- On click, POST `/api/supervisor-lifecycle-guarded-runner-readiness` with inline `operation`, `config`, `manifest`, and `runnerBinding`.
- Render sanitized blocked readiness in the existing lifecycle result area.

## Out Of Scope

- No server API change.
- No Agent CLI change.
- No real runner execution, lifecycle apply execution, launchctl call, filesystem write, approval-store read/write, NAS access, backup, restore, or remote command.
- No local config path, manifest path, runner binding path, approval path, dataDir, output, or apply flag.

## UX Contract

- Initialization must not call the guarded runner readiness API.
- Empty or invalid config, manifest, or runner binding JSON is rejected locally.
- Approval textarea content is ignored and never sent.
- The request button is disabled while a guarded runner readiness request is in flight.
- The rendered state remains fail-closed: `executorReady:false`, `guarded-runner-execution-disabled`, `wouldRun:false`, `wouldWrite:false`, and read-only safety flags.

## Sanitization

The view model must not render paths, URLs, tokens, secrets, Authorization header values, hashes, hostnames, usernames, process ids, or runnable commands. Unsafe runner binding values must render as blocker codes or redacted values only.

## Acceptance

- HTML exposes the textarea, button, and safety note hooks.
- `app.js` references the guarded runner readiness API and exports the view model.
- DOM tests cover no startup request, local JSON validation, manual request payload, sanitized blocked rendering, and in-flight duplicate suppression.
- README, version, and Gold readiness evidence advance to V1.08 while Gold remains blocked.
