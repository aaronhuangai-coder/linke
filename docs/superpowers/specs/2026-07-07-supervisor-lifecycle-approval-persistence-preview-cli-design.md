# Supervisor Lifecycle Approval Persistence Preview CLI Design

## Goal

V0.91 exposes the V0.90 approval persistence preview through a safe Agent CLI command:

```bash
node src/agent.js supervisor-lifecycle-approval-persistence-preview --config <path> --operation <operation> [--approval <path>]
```

The command is an operator-facing preview only. It does not apply lifecycle changes, persist approval records, write audit events, add Web/API lifecycle apply endpoints, or claim Gold readiness.

## Boundary

- No approval file write.
- No `fs` write, database, keychain, network persistence, `launchctl`, process spawn, metadata write, rollback anchor write, audit write, NAS command, backup, restore, or remote command.
- The command may read the explicit `--config` file and optional explicit `--approval` file only.
- Forbidden approval paths remain blocked before reading: `.env`, `.ssh`, `secrets`, `credentials`, cloud credential directories.
- `--apply` is not accepted by this preview command.
- The command prints only the sanitized `buildSupervisorLifecycleApprovalPersistencePreview(...)` result.
- Web/API endpoints for lifecycle apply or approval persistence preview remain absent.
- Gold remains blocked.

## CLI Semantics

Required:

- `--config <path>`
- `--operation install|uninstall|rollback|recover`

Optional:

- `--approval <path>`
- `--fail-on-blocked`

Rejected:

- `--apply`

The command builds an apply-shaped lifecycle plan in memory with `apply:true` and `envGateEnabled:true` solely to compute the existing plan identity and validate approval consistency. It never executes the plan. The output `command` is:

```js
'supervisor-lifecycle-approval-persistence-preview'
```

Because no persistence store exists in V0.91, output remains:

```js
state: 'blocked'
persistence.wouldPersist: false
safety.approvalPersisted: false
```

When `--fail-on-blocked` is present and preview `state === 'blocked'`, the command prints JSON and exits 2. Without `--fail-on-blocked`, it exits 0 after printing the blocked preview.

## Redaction Rules

Output must not include:

- approval identity values
- approval reasons
- acknowledgement content
- approval timestamps
- hash values such as `sha256:...`
- config path, source path, server URL, NAS endpoint, credential refs, tokens, hostnames, usernames, PIDs, or forbidden approval path contents

Static field names like `approvedBy`, `configHash`, and `planHash` remain allowed inside `requiredRecordFields`.

## Tests

Add CLI tests for:

- valid approval prints sanitized blocked preview and exits 0
- `--fail-on-blocked` exits 2 after printing JSON
- missing approval still prints safe validation blockers
- invalid operation returns sanitized error
- malformed approval JSON returns sanitized error without path or raw content
- forbidden approval paths are rejected before reading and do not leak contents
- `--apply` is rejected for the preview command
- help output documents the new command and optional approval path

Update version, README, Gold readiness, and tests to mark V0.91 as current while keeping Gold blocked.
