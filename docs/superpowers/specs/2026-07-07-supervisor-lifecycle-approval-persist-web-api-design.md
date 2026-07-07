# Supervisor Lifecycle Approval Persist Web/API Design

## Goal

V0.95 adds a guarded Web/API approval persistence surface on top of V0.94's explicit Agent CLI and V0.93's local sanitized approval record store.

The new API persists a sanitized approval record into the server `dataDir` only when the existing approval persistence preview is valid and only has the `approval-persistence-store-missing` blocker. The Web Console exposes this through a manual operator action.

## API

Route:

```text
POST /api/supervisor-lifecycle-approval-persist
```

Request body:

```json
{
  "operation": "install",
  "config": {},
  "approval": {}
}
```

Behavior:

- Validate `operation` as `install | uninstall | rollback | recover`.
- Validate `config` with the existing `validateConfig(...)`.
- Require `approval` to be an object in the request body.
- Build the in-memory lifecycle plan with:
  - `apply: true`
  - `envGateEnabled: true`
  - the submitted `approval`
- Build the existing `buildSupervisorLifecycleApprovalPersistencePreview(plan, approval)`.
- If the preview is persistable, call `appendSupervisorLifecycleApprovalRecord(dataDir, preview, approval)`.
- The API never accepts a data-dir path from the client; it uses only the server-owned `dataDir`.

Response semantics:

- `201`: valid approval persisted; response body is the sanitized `supervisor-lifecycle-approval-record`.
- `409`: approval is invalid or not persistable; response body is the sanitized blocked `supervisor-lifecycle-approval-persistence-preview`; no approval store directory is created by this request. V0.95 uses `409` instead of `422` because the submitted approval cannot transition the server-owned approval store from missing to persisted; this is treated as a persistence-state conflict, not as malformed JSON.
- `400`: invalid operation, invalid config, missing/non-object approval, or malformed JSON; response body uses a static sanitized error.
- `413`: body limit errors keep the existing `MAX_JSON_BODY_BYTES` behavior and are not remapped to `400`.
- `500`: persistence write failure; response body is `{ "error": "failed to persist approval record" }` and must not include filesystem paths or errno values.

## Auth And Route Registry

Because this route writes to the local approval store, it must be added to `API_WRITE_ROUTES`.

When `LINKE_WRITE_TOKEN` is configured:

- write token can call the route
- read token receives `403 Forbidden`
- auth denial audit behavior follows the existing write-route gate

This route must not be treated like the V0.92 preview route, which remains outside `API_WRITE_ROUTES`.

Required route-registry tests:

- `isApiWriteRoute('POST', '/api/supervisor-lifecycle-approval-persist') === true`
- `API_WRITE_ROUTES` contains `POST /api/supervisor-lifecycle-approval-persist`
- `isApiWriteRoute('POST', '/api/supervisor-lifecycle-approval-persistence-preview') === false`
- `API_WRITE_ROUTES` still excludes the V0.92 preview route

## Audit Events

V0.95 records sanitized audit events for the new write route, using the existing `recordAudit(...)` helper. Audit write failure must not change the API response.

Event requirements:

- `201`: `type:"api.supervisor_lifecycle_approval_persist.persisted"`, `statusCode:201`, `outcome:"success"`, `operation`, and request metadata already used by existing API audit events.
- `409`: `type:"api.supervisor_lifecycle_approval_persist.blocked"`, `statusCode:409`, `outcome:"blocked"`, `operation` when valid, and no approval content.
- `400`: `type:"api.supervisor_lifecycle_approval_persist.failure"`, `statusCode:400`, `outcome:"failure"`, and no submitted config/approval values.
- `500`: `type:"api.supervisor_lifecycle_approval_persist.failure"`, `statusCode:500`, `outcome:"failure"`, and static message `failed to persist approval record`.
- Existing `401 auth.denied` and `403 auth.forbidden` behavior remains owned by the existing auth gate.

Audit events must not include config, approval object, approvedBy, reason, acknowledgement text, timestamps, hash values, source paths, dataDir paths, tokens, hostnames, usernames, process ids, or raw filesystem errors.

## Web Console

The Web Console adds a manual persist action in the existing supervisor lifecycle approval preview panel.

Requirements:

- No startup request.
- No automatic polling.
- No local approval path input.
- No dataDir input or display.
- Uses the existing operation/config/approval inputs.
- Sends only `operation`, parsed config JSON, and parsed approval JSON to `POST /api/supervisor-lifecycle-approval-persist`.
- Adds a dedicated manual button with `data-testid="supervisor-lifecycle-approval-persist-button"`.
- Button text must include `Persist Approval Record`.
- Button text must not include `Apply`, `Install`, `Execute`, `Run install`, `Rollback`, or `Uninstall`.
- Displays:
  - persisted record state and operation for `201`
  - explicit text that this persisted only an approval record and did not apply lifecycle changes
  - blocked preview state, approvalValid, and blockers for `409`
  - static sanitized error text for `400/500`
- Keeps the existing preview action available and read-only.
- Adds a dedicated safety note stating that persist only writes a local JSONL approval record and does not execute lifecycle apply, call launchctl, install, uninstall, rollback, or start recovery supervisor.

## Redaction Boundary

API responses and Web rendering must not include:

- config path
- approval path
- dataDir path
- sourcePath
- serverUrl
- NAS endpoint
- credentialRef value
- approvedBy value
- approval reason
- acknowledgement content
- approval approvedAt/expiresAt
- configHash/planHash values
- `sha256:`
- token or Authorization header
- hostname
- username
- process id
- local filesystem paths
- raw errno or filesystem exception messages

Static field names such as `approvedBy`, `configHash`, and `planHash` may appear only where already allowed by required field metadata.

This field-name exception is intentional: `requiredRecordFields` exposes the approval schema shape so operators can understand why an approval is invalid. It is schema metadata only and must never contain submitted field values.

## Implementation Reuse

API input differs from CLI input:

- CLI reads `--config <path>`, `--approval <path>`, and explicit `--data-dir <path>`.
- API accepts inline JSON `config` and `approval`, and uses only the server-owned `dataDir`.
- API does not need approval-path traversal checks because it never accepts a local approval path.
- API must not accept any client-provided dataDir, output path, approval path, source path, or filesystem path.

The API should export and reuse `isPersistablePreview(...)` from `src/approval-store.js` or an equivalent shared helper instead of duplicating the CLI inline persistability predicate. If a shared helper is introduced, existing CLI behavior should be updated to use it so CLI/API persistability rules cannot drift.

## Explicit Non-Goals

- No lifecycle apply execution.
- No Web/API lifecycle apply endpoint.
- No `launchctl`.
- No process spawn/exec.
- No installer, rollback, uninstall, or recovery supervisor.
- No metadata write beyond the approval JSONL store and sanitized audit events listed above.
- No NAS connection.
- No backup or restore trigger.
- No remote command.
- No database or keychain integration.
- No production approval workflow or Gold readiness claim.

## Gold Boundary

V0.95 is still a local prototype milestone. It improves guarded approval persistence visibility and write-route protection, but Gold remains blocked because the project still lacks real NAS remote backup, production authorization, secret management, production audit guarantees, supervisor management, guarded lifecycle apply wiring, rollback, uninstall, and recovery supervisor.
