# Supervisor Lifecycle Audit Preview Design

## Goal

V0.89 adds a sanitized audit preview for supervisor lifecycle apply results.
It prepares the audit boundary for future real lifecycle execution without writing audit files or enabling host mutation.

V0.88 added `executeSupervisorLifecycleApply(plan, executor, options)` as a fake-test-only execution contract.
V0.89 uses the plan and result shapes from V0.87/V0.88 to produce an audit event preview that is safe to inspect and compatible with the existing audit-log allowlist.

## Current Boundary

- No call to `appendAuditEvent`.
- No write to `dataDir/audit/events.jsonl`.
- No Web Console lifecycle apply UI.
- No API lifecycle apply route.
- No Agent CLI lifecycle apply success path.
- No `launchctl`, LaunchAgents write, metadata write, rollback anchor write, backup, restore, NAS command, or remote command.
- Gold remains blocked.

## Interface

Add this export to `src/supervisor-lifecycle.js`:

```js
buildSupervisorLifecycleAuditPreview(plan, lifecycleResult, options = {})
```

The function is pure and synchronous.
It accepts an existing lifecycle plan and a lifecycle result from the V0.88 fake executor contract or a blocked dry-run/apply report.

It returns:

```js
{
  command: 'supervisor-lifecycle-apply',
  state: 'preview',
  operation,
  auditEvent,
  safety
}
```

For invalid inputs, it returns:

```js
{
  command: 'supervisor-lifecycle-apply',
  state: 'blocked',
  operation: 'unknown' | '<safe operation>',
  blockers: [...],
  auditEvent: null,
  safety
}
```

## Audit Event Shape

`auditEvent` must contain only fields already accepted by `sanitizeAuditEvent`:

```js
{
  type: 'supervisor.lifecycle.<operation>.<resultState>',
  createdAt: '<ISO timestamp>',
  outcome: '<resultState>',
  message: 'supervisor lifecycle <operation> <resultState>; audit preview only; no host mutation',
  requestId: '<safe request id>' // optional
}
```

Allowed operations:

- `install`
- `uninstall`
- `rollback`
- `recover`

Allowed result states:

- `blocked`
- `failed`
- `simulated`

The function must never produce `completed`, `success`, `ready`, or `production` lifecycle event types or outcomes.

## Redaction Rules

The audit preview must not include or echo:

- approval metadata (`approvedBy`, `reason`, `acknowledgements`, timestamps from approval)
- config values, local paths, source paths, target paths, LaunchAgents paths, NAS endpoints, URLs, credentials, tokens, Authorization headers, env vars
- raw blocker strings that are not known safe blocker codes
- action descriptions or tampered action ids
- executor error messages
- hostname, username, PID, process details, or command strings
- `configHash` or `planHash` unless a future design explicitly adds hash fields to the audit-log allowlist

`requestId` is optional and must pass a strict safe pattern before being included:

```text
^[A-Za-z0-9._:-]{1,80}$
```

Unsafe `requestId` values are omitted rather than returned in sanitized form.

## Safety Invariants

Every return value must include:

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

`auditEventWritten:false` is the key V0.89 invariant.
V0.89 produces a preview object only.

## Validation Semantics

The function must fail closed when:

- `plan.command !== 'supervisor-lifecycle-apply'`
- `plan.operation` is not one of the allowed operations
- `lifecycleResult.command !== 'supervisor-lifecycle-apply'`
- `lifecycleResult.operation` does not match `plan.operation`
- `lifecycleResult.state` is not `blocked`, `failed`, or `simulated`
- `plan.actions` does not match the expected operation action sequence

Failure blockers are stable generic codes and must not include raw input strings.

## Tests

Add unit tests for:

- simulated install result produces exactly the allowed audit event fields
- blocked dry-run result produces a blocked preview
- failed rollback result produces a failed preview without executor error text
- invalid plan blocks with `invalid-lifecycle-plan`
- operation mismatch blocks with `lifecycle-audit-operation-mismatch`
- unsupported result state blocks and does not echo the state
- unsafe requestId is omitted
- safe requestId is preserved
- tampered action id is blocked and not echoed
- preview event survives `sanitizeAuditEvent()` with no extra fields
- `sanitizeAuditEvent(preview.auditEvent)` preserves the same field set used by the preview
- raw unknown blocker strings from `plan.blockers` are never echoed
- `auditEvent.type` and `auditEvent.outcome` never contain `completed`, `success`, `ready`, or `production`
- safety flags all remain non-mutating and `auditEventWritten:false`

Add runtime isolation regressions:

- Agent CLI `supervisor-lifecycle-apply --apply` still returns blocked with no `auditEvent`
- GET/POST `/api/supervisor-lifecycle-apply` still return 404

Update README, version, Gold readiness, and documentation tests to mark V0.89 as current while keeping Gold blocked.

## Non-Goals

- No call to `appendAuditEvent`.
- No audit JSONL write.
- No audit retention change.
- No API or Web lifecycle apply surface.
- No real supervisor executor.
- No production audit claim.
- No Gold-ready claim.
