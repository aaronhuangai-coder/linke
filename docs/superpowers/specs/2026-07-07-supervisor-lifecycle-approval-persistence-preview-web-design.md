# Supervisor Lifecycle Approval Persistence Preview Web/API Design

## Goal

V0.92 exposes the sanitized supervisor lifecycle approval persistence preview through the local Web Console and a manual API endpoint:

```text
POST /api/supervisor-lifecycle-approval-persistence-preview
```

The endpoint and panel help an operator paste a Linke config plus optional approval JSON, inspect whether the approval would pass the existing in-memory lifecycle plan checks, and see why persistence is still blocked.

## Boundary

- No lifecycle apply endpoint is added.
- No approval record is persisted.
- No local approval path is accepted or read.
- No approval file, metadata file, audit file, LaunchAgent, rollback anchor, NAS data, backup data, restore data, database row, keychain entry, or remote resource is written.
- No `launchctl`, process spawn, installer, rollback, uninstall, recovery supervisor, NAS app, backup, restore, or remote command is invoked.
- The Web/API preview may only consume JSON pasted into the request body.
- Output must remain sanitized: no approval identity values, reason text, acknowledgement content, timestamps, `sha256:` hash values, source paths, URLs, endpoints, credential refs, tokens, hostnames, usernames, process ids, or raw local paths.
- Static field names such as `approvedBy`, `configHash`, and `planHash` may appear only as schema field names in `requiredRecordFields`.
- Gold remains blocked.

## API Semantics

Request body:

```json
{
  "operation": "install",
  "config": {},
  "approval": {}
}
```

Rules:

- `operation` must be one of `install`, `uninstall`, `rollback`, or `recover`.
- `config` is validated and normalized with `validateConfig`.
- `approval` is optional.
- The server builds an in-memory `buildSupervisorLifecycleApplyPlan(config, { apply:true, envGateEnabled:true, approval })` only to validate hashes and approval consistency.
- The server returns `buildSupervisorLifecycleApprovalPersistencePreview(plan, approval)`.
- The endpoint is a preview route and must not be added to `API_WRITE_ROUTES`.

Expected current state:

```js
command: 'supervisor-lifecycle-approval-persistence-preview'
state: 'blocked'
persistence.previewOnly: true
persistence.wouldPersist: false
safety.approvalPersisted: false
```

## Web Semantics

The Web Console adds `supervisor-lifecycle-approval-preview-panel` with:

- operation selector
- config JSON textarea
- optional approval JSON textarea
- manual run button
- status / approval valid / persistence summary
- allowlisted result groups for blockers, required fields, validation flags, and safety flags
- safety note documenting no persistence and no lifecycle apply

The panel must not request the endpoint on initialization and must not auto-poll.

## Tests

Add or update tests for:

- valid approval returns sanitized blocked preview
- missing approval returns safe blockers
- invalid operation and invalid config return sanitized errors
- HTML contains the panel hooks and safety note
- app.js wires the endpoint and exports the view model
- styles contain panel and error classes
- view model does not expose sensitive approval/config fields
- DOM init makes no endpoint request
- bad local JSON is rejected before fetch
- manual click sends one request and renders sanitized response
- in-flight guard blocks duplicate requests
- non-2xx API errors are sanitized
- version, README, and Gold readiness evidence mention V0.92 while keeping Gold blocked
