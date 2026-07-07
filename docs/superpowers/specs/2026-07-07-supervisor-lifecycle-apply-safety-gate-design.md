# Supervisor Lifecycle Apply Safety Gate Design

## Goal

V0.87 designs the first real supervisor lifecycle apply path for install, uninstall, rollback, and recovery supervisor operations, but only behind explicit safety gates.

This is a design step for moving from blocked dry-run visibility toward Gold. It must not let a future implementer add an always-on installer, hidden `launchctl` call, broad filesystem write, Web one-click lifecycle button, or production-ready claim.

## Current Context

The project already has a staged supervisor ladder:

- `launchd-dry-run` can render launchd plist content without installing it.
- `supervisor-install-dry-run` validates Linke config and emits a sanitized install plan.
- `readinessSummary.state:"blocked"` keeps automation fail-closed.
- `installCommandPreview.actions[].wouldRun:false` and `wouldWrite:false` prevent runnable command leakage.
- `installPreflight.state:"blocked"` lists missing production controls.
- `installApprovalManifest.approval.approved:false` and `rollback.available:false` make approval and rollback gaps explicit.
- `rollbackUninstallPlan.state:"blocked"` describes rollback, uninstall, and recovery supervisor steps as non-runnable plan data.
- Web Console can display the dry-run plan but has no lifecycle execution buttons.
- Auth, audit-log, hardening-status, and read/write token foundations exist but are not production-grade.

V0.87 should define the safety envelope for a future mutating lifecycle path. The implementation plan may still break this into smaller releases if a full apply path is too large.

## Selected Approach

Add a new lifecycle apply design centered on a fail-closed command:

```text
agent.js supervisor-lifecycle-apply --operation install|uninstall|rollback|recover --config <file> --approval <file> [--apply]
```

Default behavior without `--apply` is dry-run output only. Actual host mutation is permitted only when all gates pass:

1. `--apply` is present.
2. Environment variable `LINKE_SUPERVISOR_LIFECYCLE_APPLY=enabled` is set.
3. Approval file exists and validates against the V0.87 approval schema.
4. Approval file is bound to the exact operation, config hash, plan hash, and expiry window.
5. Operation target paths pass allowlist checks.
6. A rollback anchor can be written before any lifecycle mutation.
7. Audit sink can write sanitized start/failure/success events.
8. `launchctl` executor is explicitly enabled by configuration and uses argument arrays, not shell strings.

If any gate fails, the command returns a sanitized blocked report and does not write files or call `launchctl`.

## Approval File Contract

The approval file is local JSON. It must not be passed through environment variables or embedded in CLI arguments.

Required fields:

```json
{
  "schemaVersion": 1,
  "operation": "install",
  "configHash": "sha256:<hex>",
  "planHash": "sha256:<hex>",
  "approved": true,
  "approvedBy": "operator-id",
  "approvedAt": "2026-07-07T00:00:00.000Z",
  "expiresAt": "2026-07-07T01:00:00.000Z",
  "reason": "operator supplied reason",
  "acknowledgements": {
    "hostMutation": true,
    "rollbackReviewed": true,
    "goldStillBlocked": true
  }
}
```

Validation rules:

- `approved` must be `true`.
- `operation` must exactly match the requested operation.
- `configHash` must match the normalized config used to build the plan.
- `planHash` must match the exact lifecycle plan to execute.
- `approvedAt` and `expiresAt` must be valid ISO timestamps.
- `expiresAt` must be in the future and no more than 1 hour after `approvedAt`.
- `approvedBy` and `reason` may be stored in audit metadata, but must never be printed in normal Web panel rendering.
- Unknown fields are ignored for execution and must not bypass required fields.

## Lifecycle Executor Contract

Implementation must split planning from execution:

```js
buildSupervisorLifecycleApplyPlan(config, options)
executeSupervisorLifecycleApply(plan, executor)
```

`buildSupervisorLifecycleApplyPlan` is pure. It returns operation steps, target paths, plan hash, config hash, rollback anchor requirements, and blocked/ready gate status.

`executeSupervisorLifecycleApply` is the only mutating function. It accepts an injected executor:

```js
{
  writeFileAtomic(path, contents),
  rename(from, to),
  removeFile(path),
  readFile(path),
  fileExists(path),
  spawnFile(file, args, options),
  writeAuditEvent(event)
}
```

Tests must use fake executors and temporary directories. Unit tests must not call real `launchctl`, write real `~/Library/LaunchAgents`, or mutate the user's actual host state.

## Operation Semantics

### Install

Install steps:

1. Validate config.
2. Build plist content from existing launchd dry-run logic.
3. Capture existing plist, if any, into rollback anchor metadata.
4. Write new plist atomically.
5. Optionally call `launchctl bootstrap` through `spawnFile('launchctl', ['bootstrap', ...])` only if executor gate is enabled.
6. Write sanitized audit event.

### Uninstall

Uninstall steps:

1. Validate approval and plan hash.
2. Capture current plist and status into rollback anchor metadata.
3. Optionally call `launchctl bootout` through argument-array executor.
4. Remove the installed plist only after rollback anchor write succeeds.
5. Write sanitized audit event.

### Rollback

Rollback steps:

1. Validate approval and plan hash.
2. Load rollback anchor.
3. Restore previous plist atomically if available.
4. Optionally call `launchctl bootstrap` for the restored plist through argument-array executor.
5. Write sanitized audit event.

### Recover

Recovery supervisor remains future work unless a dedicated recovery executable and health contract exist. V0.87 design may define plan and approval shape, but implementation must keep `recover` blocked until a separate recovery-supervisor design exists.

## Filesystem Boundaries

Allowed path classes:

- Config file: read-only, provided through `--config`.
- Approval file: read-only, provided through `--approval`.
- Metadata directory: project data directory by default. `LINKE_SUPERVISOR_METADATA_DIR` is allowed only when the resolved path is inside the project data directory or inside explicit `LINKE_SUPERVISOR_STAGING_ROOT`.
- LaunchAgents directory: user `~/Library/LaunchAgents` by default. `--launchd-dir` is allowed only when the resolved path is exactly the user's LaunchAgents directory or inside explicit `LINKE_SUPERVISOR_STAGING_ROOT`.
- Temporary test directories in tests.

Forbidden:

- `sudo`.
- root-owned LaunchDaemons.
- system LaunchDaemons.
- writes outside the selected launchd/metadata directories.
- following symlinks for lifecycle writes.
- using a staging root that is a symlink or resolves outside its declared root.
- unbounded glob deletion.
- shell-string command execution.
- printing plist path, config path, approval path, executable path, hostname, username, process id, token, Authorization, NAS endpoint, or raw environment values in normal output.

## API and Web Boundary

V0.87 should not add Web lifecycle buttons. Web Console remains display-only unless a later design adds separate write-token UX, CSRF protection, approval review, audit history, and explicit human confirmation.

If an API endpoint is ever added, it must be in `API_WRITE_ROUTES`, require write-token authorization, write audit events, and never run on page load or polling.

## Observability and Audit

Every apply attempt must produce sanitized audit events:

- `supervisor.lifecycle_apply.blocked`
- `supervisor.lifecycle_apply.started`
- `supervisor.lifecycle_apply.failed`
- `supervisor.lifecycle_apply.completed`

Audit events may include operation, step id, sanitized outcome, blocker code, and plan hash prefix. They must not include config path, approval path, plist path, executable path, raw command arguments, token, Authorization, NAS endpoint, hostname, username, or process id.

## Failure Behavior

The lifecycle apply path is fail-closed:

- Missing `--apply`: print dry-run plan, no mutation.
- Missing env gate: blocked, no mutation.
- Missing or expired approval: blocked, no mutation.
- Hash mismatch: blocked, no mutation.
- Rollback anchor cannot be written: blocked, no mutation.
- Audit start event cannot be written: blocked, no mutation.
- Launchctl timeout: fail, attempt rollback if rollback anchor exists, write failure audit event.
- Partial filesystem write: attempt rollback to previous plist, write failure audit event.

No failure path may delete the only known rollback anchor.

## Gold Boundary

V0.87 may move `automation-installation` and `production-hardening` forward only as partial evidence for lifecycle safety design. It must not mark them ready.

Gold remains blocked until all of these exist and pass real operational acceptance:

- production-grade auth and write authorization
- durable audit with retention/tamper strategy
- real NAS remote backup/restore
- tested installer with real launchd lifecycle
- uninstall and rollback acceptance on a controlled host
- recovery supervisor implementation
- monitoring/watchdog/health checks
- documented operator runbook and rollback runbook

## Testing Strategy

Future implementation must use TDD with these test families:

- Approval schema validation.
- Config hash and plan hash binding.
- Dry-run default path does not mutate.
- Missing `--apply`, env gate, approval, hash, audit, or rollback anchor blocks before mutation.
- Fake executor install writes plist atomically and records launchctl args without shell strings.
- Fake executor uninstall captures rollback anchor before removal.
- Fake executor rollback restores previous plist.
- Fake launchctl timeout attempts rollback and reports failure.
- Symlink and path traversal targets are rejected.
- Normal output and audit output are sanitized.
- Web Console has no lifecycle execution button.
- Gold/readme tests keep Gold blocked and reject production-ready overclaims.

## Resilience Gate

Normal state:

- Without `--apply`, lifecycle apply is a dry-run report.
- With `--apply`, all gates must pass before mutation.
- Successful mutation has audit evidence and rollback anchor.

Recovery anchor:

- Previous plist snapshot plus metadata written before mutation.
- Last known green state is the dry-run-only V0.86 panel if lifecycle apply gates fail.

Bounded failure:

- Any missing gate blocks before mutation.
- Any executor error fails closed and attempts rollback only from a verified anchor.
- No loop retries without a bounded retry count and explicit audit trail. Lifecycle executor retries are capped at 2 attempts per step.

State detection:

- Plan state reports `blocked`, `ready_to_apply`, `applying`, `failed`, or `completed`.
- Audit events show step transitions.
- Tests verify no mutation occurs before all gates pass.
