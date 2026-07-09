# Linke V1.12 Supervisor Lifecycle Guarded Runner Execution Preview Web Design

## Goal

Expose the V1.11 guarded runner execution preview API through the existing Web Console supervisor lifecycle panel as a manual read-only execution preview.

## Scope

- Reuse the existing `supervisor-lifecycle-approval-preview-panel`.
- Add a manual button with `data-testid="supervisor-lifecycle-guarded-runner-execution-preview-button"`.
- Add a safety note with `data-testid="supervisor-lifecycle-guarded-runner-execution-preview-safety-note"`.
- Reuse the existing operation select, config textarea, executor manifest textarea, runner binding textarea, stats, and result area.
- Add `buildSupervisorLifecycleGuardedRunnerExecutionPreviewViewModel`.
- On click, POST `/api/supervisor-lifecycle-guarded-runner-execution-preview` with inline `operation`, `config`, `manifest`, and `runnerBinding`.
- Render sanitized blocked execution preview in the existing lifecycle result area.
- Update README, version, Gold readiness evidence, and tests to V1.12.

## Out Of Scope

- No server API change.
- No Agent CLI change.
- No real guarded runner execution.
- No lifecycle apply execution.
- No `executeSupervisorLifecycleApply` call.
- No launchctl call.
- No filesystem write.
- No approval textarea read or submission.
- No approval-store read or mutation.
- No local config path, manifest path, runner binding path, approval path, `dataDir`, `output`, or `apply` input.
- No process list read.
- No NAS connection.
- No backup or restore trigger.
- No remote command execution.

## UX Contract

- Initialization must not call `/api/supervisor-lifecycle-guarded-runner-execution-preview`.
- Empty or invalid config, manifest, or runner binding JSON is rejected locally without calling the API.
- Approval textarea content is ignored and never sent.
- The request button is disabled while an execution preview request is in flight.
- Execution preview must not start while another supervisor lifecycle panel request that renders the shared lifecycle result area is in flight.
- While execution preview is in flight, the Web UI must disable the other supervisor lifecycle panel buttons that can overwrite the same result area.
- Loading copy must make clear this is an execution preview, not an execution.
- Successful rendering remains fail-closed: `executionReady:false`, `executorReady:false`, `wouldExecute:false`, `wouldRun:false`, `wouldWrite:false`, `readOnly:true`, and `guarded-runner-execution-preview-only`.
- API transport errors render as a sanitized failure message in the shared lifecycle result area.

## Request Contract

The Web request body must contain only:

```json
{
  "operation": "install",
  "config": {},
  "manifest": {},
  "runnerBinding": {}
}
```

The Web layer must not send `approval`, `approvedBy`, `reason`, `acknowledgement`, `dataDir`, `apply`, `output`, `configPath`, `manifestPath`, or `runnerBindingPath`.

## View Model Contract

`buildSupervisorLifecycleGuardedRunnerExecutionPreviewViewModel(payload, errorMessage = '')` must return the same shape consumed by `renderSupervisorLifecycleApprovalPreview`:

- `statusKey:"blocked"` and `statusText:"执行预览阻塞"` for valid payloads.
- `approvalValidText:"executionReady:false / executorReady:false"`.
- `persistenceText:"readOnly:true / wouldExecute:false"`.
- `blockers` from payload `blockers` and `nextBlockers`, sanitized and prefixed where useful.
- `requiredFields` / `recordLines` from `actionPreviews`, each showing sanitized action metadata and fixed `wouldExecute:false`, `wouldRun:false`, `wouldWrite:false`.
- `validationLines` from gates: `lifecyclePlanValid`, `runnerBindingsReady`, `executionPreviewOnly`, and `executorReady:false`.
- `safetyLines` from safety flags plus explicit `executionReady:false`, `wouldExecute:false`, `wouldRun:false`, and `wouldWrite:false`.
- Unknown payloads render a manual-call placeholder and remain fail-closed.
- Error payloads render `检查失败` and sanitize the message with the same execution-preview redaction layer used for action fields.

## Sanitization

The Web view model must not render paths, URLs, token-like values, secrets, Authorization header values, hashes, hostnames, usernames, process ids, runnable commands, or command-like runner metadata. Unsafe execution preview values must render as blocker codes or redacted values only.

The execution preview view model must render only allowlisted fields from `actionPreviews`: `actionId`, `implementationId`, `mode`, `runnerKind`, `wouldExecute`, `wouldRun`, and `wouldWrite`. Unknown action fields must be ignored. Long base64-like or high-entropy token-like values, common short token prefixes such as `sk-` / GitHub / Slack tokens, and command-like interpreter names such as `python`, `ruby`, or `perl` must be redacted when they appear in allowlisted string fields or error text.

## Runtime Resilience

- Normal state: valid inline metadata returns a blocked preview and updates only DOM text.
- Recovery anchor: no client or server state is changed; the operator retries after correcting pasted JSON.
- Failure detection: local validation messages, sanitized HTTP errors, and deterministic blocked preview fields are the observable signals.
- Highest risk path: unsafe action preview metadata must be redacted while the UI still reports `wouldExecute:false` and `readOnly:true`.
- Shared result-area contention is handled fail-closed: if a guarded runner readiness request is already in flight, execution preview click is ignored and does not issue a second API call.

## Acceptance

- HTML exposes the execution preview button and safety note hooks.
- `app.js` references `/api/supervisor-lifecycle-guarded-runner-execution-preview` and exports the execution preview view model.
- DOM tests cover no startup request, local JSON validation, manual request payload, sanitized blocked rendering, and in-flight duplicate suppression.
- DOM tests cover cross-button duplicate suppression between guarded runner readiness and guarded runner execution preview.
- Tests assert approval textarea content is not submitted.
- Tests assert paths, URLs, tokens, secrets, hostnames, usernames, process ids, and commands do not appear in rendered execution preview text.
- README, version, and Gold readiness evidence advance to V1.12 while Gold remains blocked.
