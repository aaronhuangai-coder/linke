# Supervisor Install Approval Manifest Design

## Goal

V0.83 adds a sanitized `installApprovalManifest` object to the full JSON output of `agent.js supervisor-install-dry-run`. The manifest makes the two most immediate V0.82 preflight blockers machine-readable: explicit operator approval and rollback/recovery readiness.

This is still a dry-run-only, blocked artifact. It does not approve, install, start, unload, uninstall, roll back, write files, call `launchctl`, read process state, connect NAS, trigger backup/restore, or execute remote commands.

## Selected Approach

Add a full-output-only `installApprovalManifest` object to `buildSupervisorInstallDryRunPlan(config)`.

`--readiness-summary` remains unchanged and prints only `readinessSummary`. The new manifest is excluded from summary-only output, just like `installCommandPreview` and `installPreflight`.

The manifest is static and code-owned in V0.83. It must not collect host state, approval identity, timestamps, local file paths, plist paths, executable paths, token values, NAS endpoints, credential refs, or environment values.

## Alternatives Considered

- Add a new `--approve-install` or `--install` flow.
  - Rejected because V0.83 must not create a mutating command or imply real install readiness.
- Store approval records on disk.
  - Rejected because this would introduce metadata writes and retention/security requirements before the approval model is designed.
- Expand `installPreflight.checks` in place.
  - Rejected because V0.82 already established `installPreflight` as a concise blocker checklist. V0.83 needs a more structured operator/rollback manifest without changing the existing check IDs.

## Non-Goals

- Do not implement a real installer.
- Do not add `--install`, `--start`, `--load`, `--unload`, `--uninstall`, `--approve-install`, or any command that can change system state.
- Do not write approval records, rollback manifests, plist files, LaunchAgents, metadata, audit success events, config, device data, snapshot data, or reports.
- Do not call `launchctl`.
- Do not read process lists.
- Do not install, start, stop, unload, or remove launchd jobs.
- Do not connect NAS.
- Do not trigger backup, restore, or remote commands.
- Do not print config paths, source paths, server URLs, NAS endpoints, credential refs, token values, Authorization headers, environment values, home paths, plist paths, executable paths, approval identity, approval timestamps, or runnable command arguments.
- Do not claim production supervisor, production readiness, Gold readiness, real installer readiness, operator approval completed, rollback readiness, uninstall readiness, or managed daemon lifecycle.

## User Value

V0.82 shows that real installation is blocked by missing approval and rollback/recovery controls. V0.83 turns those controls into a stable dry-run manifest that operators and CI can inspect before any future install design exists.

This helps the project advance toward Gold without prematurely enabling system writes.

## Output Schema

The full dry-run plan adds:

```js
{
  installApprovalManifest: {
    mode: 'dry-run-only',
    state: 'blocked',
    approval: {
      required: true,
      approved: false,
      source: 'not-collected',
      approverReturned: false,
      timestampReturned: false,
      blockerCode: 'operator-approval-required',
      evidence: 'No operator approval workflow or durable approval record exists in this release.'
    },
    rollback: {
      required: true,
      available: false,
      uninstallSupported: false,
      recoverySupervisorSupported: false,
      previousPlistRestoreSupported: false,
      blockerCode: 'rollback-recovery-incomplete',
      evidence: 'No uninstall, rollback, previous plist restore, or recovery supervisor lifecycle exists in this release.'
    },
    controls: [
      {
        id: 'explicit-operator-approval',
        status: 'blocked',
        requiredForInstall: true,
        blockerCode: 'operator-approval-required',
        evidence: 'Install approval is not collected or persisted.'
      },
      {
        id: 'rollback-plan',
        status: 'blocked',
        requiredForInstall: true,
        blockerCode: 'rollback-plan-missing',
        evidence: 'Rollback steps are not implemented.'
      },
      {
        id: 'uninstall-plan',
        status: 'blocked',
        requiredForInstall: true,
        blockerCode: 'uninstall-plan-missing',
        evidence: 'Uninstall steps are not implemented.'
      },
      {
        id: 'recovery-supervisor',
        status: 'blocked',
        requiredForInstall: true,
        blockerCode: 'recovery-supervisor-missing',
        evidence: 'Recovery supervisor lifecycle is not implemented.'
      }
    ],
    safety: {
      dryRun: true,
      manifestOnly: true,
      approvalCollected: false,
      approvalPersisted: false,
      rollbackExecuted: false,
      uninstallExecuted: false,
      recoverySupervisorStarted: false,
      launchctlCalled: false,
      processListRead: false,
      filesystemWritten: false,
      metadataWritten: false,
      supervisorInstalled: false,
      supervisorStarted: false,
      nasConnected: false,
      backupTriggered: false,
      restoreTriggered: false,
      remoteCommandExecuted: false,
      sensitiveValuesReturned: false
    }
  }
}
```

All evidence strings are generic. They must not include local paths, URLs, tokens, Authorization headers, credential refs, NAS endpoints, usernames, hostnames, home-directory fragments, plist paths, executable paths, approval identities, or timestamps.

`blockerCode` values are stable automation identifiers for this release. Future versions may add real approval or rollback behavior only after a separate design updates the Gold readiness boundary and safety tests.

`operator-approval-required` intentionally appears both in V0.82 `installPreflight` and V0.83 `installApprovalManifest`; it represents the same missing explicit operator approval gate in both artifacts. The new rollback-related manifest codes are distinct from V0.82 preflight codes because they split rollback into plan, uninstall, and recovery-supervisor sub-controls.

JSON object key order is not a public contract. Consumers must select fields by key, not by position.

## CLI Semantics

- `supervisor-install-dry-run --config <file>`
  - Prints the full sanitized plan with `readinessSummary`, `installCommandPreview`, `installPreflight`, and `installApprovalManifest`.
  - Exit code `0`.
- `supervisor-install-dry-run --config <file> --fail-on-blocked`
  - Prints the full sanitized plan with `installApprovalManifest`.
  - Exit code `2` because `readinessSummary.state` remains `blocked`.
- `supervisor-install-dry-run --config <file> --readiness-summary`
  - Prints only `readinessSummary`.
  - Does not include `installCommandPreview`, `installPreflight`, or `installApprovalManifest`.
  - Exit code `0`.
- `supervisor-install-dry-run --config <file> --readiness-summary --fail-on-blocked`
  - Prints only `readinessSummary`.
  - Does not include `installApprovalManifest`.
  - Exit code `2`.

Existing boolean flag value rejection and `--output` rejection stay unchanged.

## Safety Boundaries

`installApprovalManifest` must not contain:

- config path
- sourcePath
- serverUrl
- NAS endpoint
- remotePath
- credentialRef
- token
- Authorization header
- Bearer token
- environment value
- user name
- host name
- approval identity
- approval timestamp
- real user home directory
- real plist path
- real node executable path
- runnable launchctl command

The full plan must continue reporting the V0.82 false safety fields, including `launchctlCalled:false`, `processListRead:false`, `supervisorInstalled:false`, `launchdFileWritten:false`, `metadataWritten:false`, `nasConnected:false`, `backupTriggered:false`, `restoreTriggered:false`, and `remoteCommandExecuted:false`.

The nested `installApprovalManifest.safety` object is additive. It must not remove or rename existing top-level safety fields, `installCommandPreview.safety`, or `installPreflight.safety`.

## Gold Readiness Boundary

V0.83 adds partial evidence to `automation-installation` and `production-hardening`, but it must not move either item to `ready`. `real-nas-remote-backup` remains `blocked`, and overall Gold readiness remains `blocked`.

Gold next steps should state that V0.83 adds a dry-run approval and rollback manifest only. Real installer, launchd install/start, approval persistence, uninstall, rollback execution, recovery supervisor, watchdog, monitoring, secret management, deployment hardening, production audit, and production security review remain future work.

## Operational Resilience

Normal state:

- Full dry-run exits `0` and reports `installApprovalManifest.state:"blocked"`.
- `--fail-on-blocked` exits `2` after printing JSON.
- `--readiness-summary` stays compact and excludes the approval manifest.
- No file, process, NAS, launchd, backup, restore, approval, rollback, audit success, or metadata state is written.

Recovery anchor:

- Last known green state is V0.82 supervisor install preflight gate.
- If V0.83 approval manifest behavior fails, revert only the manifest helper, full-plan wiring, tests, version/docs/Gold updates, and V0.83 plan/spec docs.
- Recovery must leave V0.82 `installPreflight`, V0.81 command preview, readiness summary, and existing supervisor install dry-run behavior intact.

Failure modes:

- Missing or invalid config: fail closed with the existing fixed sanitized error and exit `1`.
- Boolean flag value supplied: fail closed with explicit flag error and exit `1`.
- Blocked readiness with `--fail-on-blocked`: print JSON and exit `2`.
- Missing approval manifest helper during implementation: tests fail before docs can claim V0.83.

Observable signals:

- JSON field `installApprovalManifest.state:"blocked"` in full output.
- `installApprovalManifest.approval.approved === false`.
- `installApprovalManifest.rollback.available === false`.
- Every manifest control uses `status:"blocked"` and `requiredForInstall:true`.
- Full dry-run exits `0` without `--fail-on-blocked` even though the manifest is blocked.
- Existing no-write and no-leak tests remain green.

## Testing

Add focused tests in `test/agent-supervisor-install-dry-run.test.js`:

- Pure helper/full plan includes `installApprovalManifest` with fixed approval and rollback sections.
- Manifest controls include `explicit-operator-approval`, `rollback-plan`, `uninstall-plan`, and `recovery-supervisor`.
- Every control has `status:"blocked"`, `requiredForInstall:true`, and a stable `blockerCode`.
- `installApprovalManifest.safety` reports dry-run-only, manifest-only, no approval collection, no approval persistence, no rollback/uninstall execution, no recovery supervisor start, no launchctl, no process read, no filesystem write, no metadata write, no NAS, no backup/restore, no remote command, and no sensitive values.
- Full CLI output includes `installApprovalManifest` and still does not leak paths, endpoints, credentials, tokens, Authorization values, approval identity, or timestamps.
- `approval.evidence`, `rollback.evidence`, and every `controls[].evidence` string each pass no-sensitive-values assertions.
- Adding `installApprovalManifest.safety` does not remove, rename, or alter any top-level `safety` field, `installCommandPreview.safety` field, or `installPreflight.safety` field.
- Manifest `blockerCode` values are stable; tests document that `operator-approval-required` is intentionally shared with V0.82 preflight while rollback sub-control codes remain distinct.
- `--readiness-summary` output does not include `installCommandPreview`, `installPreflight`, or `installApprovalManifest`.
- `--fail-on-blocked` full output still includes `installApprovalManifest` before exiting `2`.
- Existing `--output`, sanitized config error, no-write, readiness summary, command preview, preflight, and no-leak tests remain green.

Update `src/version.js`, `README.md`, `src/gold-readiness.js`, `test/version.test.js`, `test/gold-readiness.test.js`, and `test/readme.test.js` for V0.83 while keeping Gold blocked.

## Verification

- `node --test test/agent-supervisor-install-dry-run.test.js`
- `node --test test/gold-readiness.test.js test/readme.test.js test/version.test.js`
- `node --test test/*.test.js`
- `git diff --check`
- Overclaim scan for production-ready, Gold-ready, real NAS backup ready, daemon installed, launchd installed, always-running, real installer implemented, real install ready, production-ready supervisor, approval completed, rollback ready, uninstall ready, recovery supervisor ready, `真实 NAS 备份已实现`, and `生产可用`.
