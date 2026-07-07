# Supervisor Lifecycle Approval Persistence Preview Design

## Goal

V0.90 adds a sanitized approval persistence preview for supervisor lifecycle apply.
It reduces the approval-persistence Gold blocker by defining the record boundary and safety checks without persisting any approval data.

V0.87 introduced approval validation for `supervisor-lifecycle-apply`.
V0.88 added a fake executor contract.
V0.89 added an audit preview.
V0.90 adds a pure preview describing whether a validated approval would be eligible for future persistence, while keeping real persistence blocked.

## Current Boundary

- No approval file is written.
- No approval metadata is persisted.
- No `fs`, `appendFile`, `writeFile`, `rename`, `mkdir`, database, keychain, or network call is introduced.
- No Web/API lifecycle apply endpoint is introduced.
- Agent CLI `--apply` remains blocked.
- No `launchctl`, LaunchAgents write, metadata write, rollback anchor write, audit write, backup, restore, NAS command, or remote command.
- Gold remains blocked.

## Interface

Add this export to `src/supervisor-lifecycle.js`:

```js
buildSupervisorLifecycleApprovalPersistencePreview(plan, approval, options = {})
```

The function is pure and synchronous.
It accepts an existing lifecycle plan and an approval object, then returns a sanitized preview.

Return shape:

```js
{
  command: 'supervisor-lifecycle-approval-persistence-preview',
  operation,
  state: 'blocked',
  approvalValid,
  blockers,
  persistence,
  safety
}
```

`state` is always `blocked` in V0.90 because no persistence store exists.
Even a valid approval must include `approval-persistence-store-missing`.

## Persistence Preview Shape

`persistence` contains only non-secret booleans, counts, and static field names:

```js
{
  previewOnly: true,
  wouldPersist: false,
  recordSchemaVersion: 1,
  requiredRecordFields: [
    'schemaVersion',
    'operation',
    'configHash',
    'planHash',
    'approvedAt',
    'expiresAt',
    'approvedBy',
    'reason',
    'acknowledgements'
  ],
  validation: {
    approvalValid: false,
    acknowledgementCount: 0,
    windowWithinLimit: false,
    operationMatchesPlan: false,
    configHashMatchesPlan: false,
    planHashMatchesPlan: false
  }
}
```

The preview must never return approval field values.
It may return `acknowledgementCount` because this is a count, not content.

## Redaction Rules

Never include:

- `approvedBy`
- `reason`
- `acknowledgements` content
- `approvedAt` value
- `expiresAt` value
- `configHash` value
- `planHash` value
- local paths, URLs, NAS endpoints, commands, environment variables, tokens, passwords, credential refs, hostnames, usernames, PIDs, or executor errors
- raw unknown blocker strings from tampered inputs

Allowed blocker strings are fixed code-owned values only.

## Validation Semantics

The function must fail closed when:

- `plan.command !== 'supervisor-lifecycle-apply'`
- `plan.operation` is not an allowed lifecycle operation
- `plan.actions` does not match the expected operation action sequence
- `approval` is missing required fields
- `approval.approved !== true`
- approval window is inverted or zero-length
- approval window is wider than one hour
- approval is expired
- approval operation/configHash/planHash does not match the plan

Plan structural validation must run before approval validation.
If the plan is invalid, `approvalValid` must be `false` even when the approval object is otherwise well formed.
Use the existing blocker code `invalid-lifecycle-plan` for missing plans, wrong `plan.command`, missing actions, or invalid operation values.
Use `lifecycle-plan-action-mismatch` for tampered action sequences.

When approval is otherwise valid, the result remains:

```js
state: 'blocked'
blockers: ['approval-persistence-store-missing']
persistence.wouldPersist: false
```

## Safety Invariants

Every return value includes:

```js
safety: {
  dryRun: true,
  hostMutation: false,
  launchctlCalled: false,
  filesystemWritten: false,
  metadataWritten: false,
  rollbackAnchorWritten: false,
  auditEventWritten: false,
  approvalPersisted: false,
  sensitiveValuesReturned: false
}
```

Extend the shared lifecycle safety shape with `approvalPersisted:false` so existing and future lifecycle reports use one consistent non-mutating safety object.
`approvalPersisted:false` and `filesystemWritten:false` are the key V0.90 invariants.

## Tests

Add unit tests for:

- valid approval returns `approvalValid:true` but remains blocked by `approval-persistence-store-missing`
- null or malformed plan returns `invalid-lifecycle-plan` and `approvalValid:false`
- wrong `plan.command` returns `invalid-lifecycle-plan`
- missing approval returns only safe validation blocker codes
- rejected approval returns `approval-not-granted`
- expired approval returns `approval-expired`
- inverted or zero-length approval window returns `approval-window-invalid`
- operation/configHash/planHash mismatch returns safe mismatch blockers
- over-wide approval window returns `approval-window-too-wide`
- tampered plan action id is blocked and not echoed
- frozen or deep-cloned inputs prove the function does not mutate `plan` or `approval`
- unknown/tampered approval fields are not echoed
- acknowledgement content, approvedBy, reason, timestamps, configHash, and planHash values never appear in serialized output
- JSON parse/stringify round-trip preserves no sensitive values
- validation booleans and acknowledgement count are accurate
- safety flags include exactly the expected non-mutating keys with `approvalPersisted:false`

Add runtime isolation regression:

- Agent CLI `supervisor-lifecycle-apply --apply` still has no approval persistence preview and exits blocked
- GET/POST `/api/supervisor-lifecycle-apply` still return 404

Update README, version, Gold readiness, and tests to mark V0.90 as current while keeping Gold blocked.

## Non-Goals

- No persisted approval store.
- No approval JSONL or metadata file.
- No encryption/signing/keychain integration.
- No Web/API lifecycle apply surface.
- No real executor.
- No production authorization claim.
- No Gold-ready claim.
