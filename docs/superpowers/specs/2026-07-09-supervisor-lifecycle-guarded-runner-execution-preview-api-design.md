# Linke V1.11 Supervisor Lifecycle Guarded Runner Execution Preview API Design

## Goal

Expose the V1.10 guarded runner execution preview through a read-only server API endpoint without adding Web UI or real lifecycle execution.

## Scope

- Add `POST /api/supervisor-lifecycle-guarded-runner-execution-preview`.
- Accept inline JSON only: `operation`, `config`, `manifest`, and `runnerBinding`.
- Reuse the existing lifecycle chain: `validateConfig` -> `buildSupervisorLifecycleApplyPlan` -> `validateSupervisorLifecycleExecutorManifest` -> `buildSupervisorLifecycleGuardedRunnerReadiness` -> `buildSupervisorLifecycleGuardedRunnerExecutionPreview`.
- Keep the endpoint outside `API_WRITE_ROUTES` so a read token can call it.
- Return the sanitized blocked preview with `executionReady:false`, `executorReady:false`, `wouldExecute:false`, `wouldRun:false`, `wouldWrite:false`, `guarded-runner-execution-preview-only`, and `real-guarded-runner-execution-wiring-missing`.
- Update release version, README, Gold readiness evidence, and tests to V1.11.

## Out Of Scope

- No Web Console control in V1.11.
- No local config path, manifest path, runner binding path, approval path, `dataDir`, or output path input.
- No `--fail-on-blocked` API behavior; HTTP always reports transport status and the JSON preview remains blocked.
- No lifecycle apply execution.
- No `executeSupervisorLifecycleApply` call.
- No launchctl call.
- No filesystem write.
- No approval-store read or mutation.
- No process list read.
- No NAS connection.
- No backup or restore trigger.
- No remote command execution.

## API Contract

Endpoint:

```http
POST /api/supervisor-lifecycle-guarded-runner-execution-preview
Content-Type: application/json
Authorization: Bearer <read-token-or-write-token>
```

Request body:

```json
{
  "operation": "install",
  "config": {
    "serverUrl": "http://localhost:3000",
    "deviceId": "macbook-alpha",
    "backupJobs": [{ "name": "Documents", "sourcePath": "/tmp/linke-documents" }]
  },
  "manifest": {
    "kind": "supervisor-lifecycle-executor-manifest",
    "schemaVersion": 1,
    "actions": []
  },
  "runnerBinding": {
    "kind": "supervisor-lifecycle-guarded-runner-binding",
    "schemaVersion": 1,
    "bindings": []
  }
}
```

Response for valid inline inputs:

```json
{
  "command": "supervisor-lifecycle-guarded-runner-execution-preview",
  "operation": "install",
  "state": "blocked",
  "executionReady": false,
  "executorReady": false,
  "wouldExecute": false,
  "runnerBindingsReady": true,
  "blockers": ["guarded-runner-execution-preview-only"],
  "nextBlockers": ["real-guarded-runner-execution-wiring-missing"]
}
```

The full response is the object returned by `buildSupervisorLifecycleGuardedRunnerExecutionPreview(plan, guardedRunnerReadiness)`. The JSON must include `actionPreviews`, `gates`, and `safety` exactly as produced by that pure helper. Required `gates` values are `lifecyclePlanValid:true`, `runnerBindingsReady:true`, `executionPreviewOnly:true`, and `executorReady:false` for valid inline metadata. Required `safety` values include `readOnly:true`, `dryRun:true`, `hostMutation:false`, `launchctlCalled:false`, `processListRead:false`, `filesystemWritten:false`, `metadataWritten:false`, `rollbackAnchorWritten:false`, `auditEventWritten:false`, `approvalPersisted:false`, `sensitiveValuesReturned:false`, `lifecycleApplied:false`, `nasConnected:false`, `backupTriggered:false`, `restoreTriggered:false`, and `remoteCommandExecuted:false`. `runnerBindingsReady:true` only means the submitted metadata validates; the endpoint still reports blocked execution and must never claim a real runner can run.

## Error Handling

- Invalid `operation` returns HTTP 400 with `operation must be one of: install, uninstall, rollback, recover`.
- Invalid `config` returns HTTP 400 with `supervisor-lifecycle-guarded-runner-execution-preview failed; verify config is a readable valid Linke config`.
- Missing, invalid, or otherwise not-ready inline `manifest` returns HTTP 400 with `supervisor-lifecycle-guarded-runner-execution-preview failed; execution preview validation did not complete`.
- Runner binding or execution preview validation exceptions return HTTP 400 with `supervisor-lifecycle-guarded-runner-execution-preview failed; execution preview validation did not complete`.
- Missing inline `runnerBinding` is handled by the readiness and preview builders as blocked preview, not as a transport error.
- Submitted extra fields such as `approval`, `dataDir`, `apply`, `output`, `configPath`, `manifestPath`, and `runnerBindingPath` are ignored and must not appear in responses.
- Responses must not echo config paths, manifest paths, runner binding paths, token-like values, URLs from invalid inputs, hostnames, usernames, raw JSON parse errors, Node filesystem error names, or local directories.

## Runtime Resilience

- Normal state: valid inline config, manifest, and runner binding return HTTP 200 with blocked preview JSON.
- Recovery anchor: no state is changed, so failed requests recover by retrying with corrected inline JSON.
- Failure detection: fixed 400 errors and deterministic preview blockers are the observable signals.
- Highest risk path: unsafe runner binding metadata must be redacted in `actionPreviews` while the response remains blocked and read-only.

## Acceptance

- `POST /api/supervisor-lifecycle-guarded-runner-execution-preview` exists.
- The route is absent from `API_WRITE_ROUTES`.
- A read token can call it.
- Valid inline `config`, `manifest`, and `runnerBinding` return blocked execution preview with `runnerBindingsReady:true`.
- Missing inline `runnerBinding` returns blocked execution preview with `runnerBindingsReady:false`.
- Unsafe runner binding metadata is redacted in `actionPreviews`.
- Missing, invalid, or otherwise not-ready inline `manifest` returns the fixed sanitized validation error.
- Invalid operation and config errors are sanitized.
- Extra write-like or path-like fields are ignored and do not leak.
- Tests, README, version, and Gold readiness evidence are updated to V1.11.
