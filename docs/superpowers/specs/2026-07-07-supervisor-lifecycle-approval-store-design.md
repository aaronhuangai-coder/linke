# Supervisor Lifecycle Approval Store Design

## Goal

V0.93 adds the first local supervisor lifecycle approval persistence store foundation. It creates and appends sanitized approval records under a caller-provided `dataDir` so tests and future guarded flows can prove that an approval can be persisted without leaking approval content or executing lifecycle actions.

## Scope

- Add a small `src/approval-store.js` module.
- Persist only sanitized JSONL records for valid `supervisor-lifecycle-approval-persistence-preview` outputs.
- Read stored records newest-first for tests and future status surfaces.
- Keep the store disconnected from Web/API lifecycle apply and Agent lifecycle apply.
- Keep Gold blocked.

## Non-Goals

- No `/api/supervisor-lifecycle-apply` endpoint.
- No Web/API approval persist endpoint.
- No Agent CLI approval persist command in V0.93.
- No launchd install/start, rollback, uninstall, recovery supervisor, NAS, backup, restore, audit write, keychain, database, or remote command.
- No production deployment or Gold-ready claim.

## Record Rules

A preview is persistable only when:

- `preview.command === "supervisor-lifecycle-approval-persistence-preview"`
- `preview.approvalValid === true`
- `preview.persistence.previewOnly === true`
- `preview.persistence.wouldPersist === false`
- `preview.blockers` contains only `approval-persistence-store-missing`

The stored record may include:

- generated `id`
- record `createdAt`
- schema version
- operation
- `approvalValid`
- validation booleans and acknowledgement count
- resolved blocker code `approval-persistence-store-missing`
- safety flags

The stored record must not include:

- `approvedBy` value
- approval reason
- acknowledgement text
- approval `approvedAt` or `expiresAt`
- `configHash` or `planHash` values
- `sha256:` strings
- config path, source path, server URL, NAS endpoint, credential ref, token, Authorization header, hostname, username, process id, or local path

## Storage

- Path: `<dataDir>/approvals/supervisor-lifecycle-approvals.jsonl`
- Append one sanitized JSON object per line.
- Create the directory on append.
- Missing store reads as an empty array.
- Corrupt or empty lines are ignored on read.

## Safety Semantics

`buildSupervisorLifecycleApprovalRecord(...)` is pure and reports:

```js
approvalPersisted: false
filesystemWritten: false
hostMutation: false
launchctlCalled: false
lifecycleApplied: false
sensitiveValuesReturned: false
```

`appendSupervisorLifecycleApprovalRecord(...)` returns the stored record with:

```js
approvalPersisted: true
filesystemWritten: true
hostMutation: false
launchctlCalled: false
lifecycleApplied: false
sensitiveValuesReturned: false
```

These true flags only describe explicit local `dataDir` JSONL persistence, not host mutation or lifecycle apply.
