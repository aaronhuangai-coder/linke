# Supervisor Rollback Uninstall Dry-Run Design

## Goal

V0.85 adds a sanitized `rollbackUninstallPlan` object to the full JSON output of `agent.js supervisor-install-dry-run`. The object turns the V0.83 approval manifest blockers for rollback, uninstall, and recovery supervisor into a more detailed machine-readable dry-run plan.

This is still a blocked, dry-run-only artifact. It does not roll back, uninstall, stop, unload, remove, restore, install, start, write files, call `launchctl`, read process state, connect NAS, trigger backup/restore, execute remote commands, or claim Gold readiness.

## Current Context

V0.79-V0.84 built the supervisor install dry-run ladder:

- `agent.js supervisor-install-dry-run --config <file>`
- `buildSupervisorInstallDryRunPlan(config)`
- `readinessSummary.state:"blocked"`
- `installCommandPreview.state:"blocked"`
- `installCommandPreview.actions[].wouldRun:false`
- `installPreflight.state:"blocked"`
- `installPreflight.checks:requiredForInstall:true`
- `installApprovalManifest.state:"blocked"`
- `installApprovalManifest.approval.approved:false`
- `installApprovalManifest.rollback.available:false`
- Web Console `supervisor-install-dry-run-panel`
- `POST /api/supervisor-install-dry-run`

V0.83 deliberately kept rollback and uninstall as high-level blockers inside `installApprovalManifest`. V0.85 should refine those blockers into an inspectable plan without introducing a mutating lifecycle command.

## Selected Approach

Add a full-output-only `rollbackUninstallPlan` object to `buildSupervisorInstallDryRunPlan(config)`.

The new helper is pure and static:

- `buildSupervisorRollbackUninstallPlan()`
- no parameters
- no filesystem access
- no process access
- no network access
- no launchd access
- no config value interpolation
- no runtime probing

`--readiness-summary` remains unchanged and prints only `readinessSummary`. The new object is excluded from summary-only output, just like `installCommandPreview`, `installPreflight`, and `installApprovalManifest`.

The Web Console panel can render this object in a later release, but V0.85 does not require Web UI changes. Keeping V0.85 CLI/schema-only reduces the blast radius and gives tests a stable backend contract first.

## Alternatives Considered

### 1. Add a real rollback or uninstall command

Rejected. Real rollback and uninstall need launchd lifecycle design, approval persistence, audit records, rollback state capture, recovery supervisor behavior, and production safety gates. V0.85 must not mutate host state.

### 2. Expand `installApprovalManifest.rollback` in place

Rejected. `installApprovalManifest` is the approval gate and install prerequisite manifest. A separate `rollbackUninstallPlan` keeps lifecycle recovery detail isolated and avoids changing the V0.83 manifest contract beyond adding cross-references in documentation.

### 3. Add Web UI rendering in the same release

Rejected for V0.85. V0.84 already added the Web entry point. The next safe step is a stable JSON contract and tests; Web presentation can follow once the schema has passed adversarial review.

## Non-Goals

- Do not add `--rollback`, `--uninstall`, `--stop`, `--unload`, `--remove`, `--recover`, `--approve-install`, `--install`, `--start`, or any mutating supervisor command.
- Do not write config, metadata, LaunchAgents, plist files, rollback manifests, approval records, reports, audit success records, snapshots, device records, NAS data, or recovery state.
- Do not call `launchctl`.
- Do not read process lists.
- Do not inspect installed launch agents.
- Do not check whether a plist exists.
- Do not restore a previous plist.
- Do not stop, unload, uninstall, remove, reinstall, or start launchd jobs.
- Do not connect NAS.
- Do not trigger backup, restore, remote copy, or remote command execution.
- Do not print config paths, source paths, server URLs, NAS endpoints, credential refs, token values, Authorization headers, environment values, home paths, plist paths, executable paths, previous plist paths, approval identity, approval timestamps, hostnames, usernames, process ids, or runnable command arguments.
- Do not claim production supervisor, production hardening, rollback readiness, uninstall readiness, recovery supervisor readiness, managed daemon lifecycle, or Gold readiness.

## Output Schema

The full dry-run plan adds:

```js
{
  rollbackUninstallPlan: {
    mode: 'dry-run-only',
    state: 'blocked',
    rollback: {
      requiredBeforeInstall: true,
      available: false,
      previousPlistAvailable: false,
      wouldRestorePreviousPlist: false,
      wouldRestartPreviousSupervisor: false,
      blockerCode: 'rollback-not-implemented',
      evidence: 'Rollback state capture, previous plist restore, and supervisor restart are not implemented.'
    },
    uninstall: {
      requiredBeforeInstall: true,
      available: false,
      wouldUnloadLaunchAgent: false,
      wouldRemoveLaunchAgent: false,
      wouldRemoveMetadata: false,
      blockerCode: 'uninstall-not-implemented',
      evidence: 'Launch agent unload, plist removal, and supervisor metadata removal are not implemented.'
    },
    recovery: {
      requiredBeforeInstall: true,
      available: false,
      supervisorAvailable: false,
      wouldStartRecoverySupervisor: false,
      blockerCode: 'recovery-supervisor-not-implemented',
      evidence: 'Recovery supervisor lifecycle is not implemented.'
    },
    actions: [
      {
        id: 'capture-current-state',
        kind: 'rollback',
        status: 'blocked',
        wouldRun: false,
        wouldWrite: false,
        blockerCode: 'rollback-state-capture-missing',
        evidence: 'Current supervisor state capture is not implemented.'
      },
      {
        id: 'unload-launch-agent',
        kind: 'uninstall',
        status: 'blocked',
        wouldRun: false,
        wouldWrite: false,
        blockerCode: 'launchd-unload-blocked',
        evidence: 'launchctl unload behavior is not implemented.'
      },
      {
        id: 'remove-launch-agent-plist',
        kind: 'uninstall',
        status: 'blocked',
        wouldRun: false,
        wouldWrite: false,
        blockerCode: 'launchd-remove-blocked',
        evidence: 'Launch agent plist removal is not implemented.'
      },
      {
        id: 'restore-previous-plist',
        kind: 'rollback',
        status: 'blocked',
        wouldRun: false,
        wouldWrite: false,
        blockerCode: 'previous-plist-unavailable',
        evidence: 'Previous plist restore data is not captured.'
      },
      {
        id: 'start-recovery-supervisor',
        kind: 'recovery',
        status: 'blocked',
        wouldRun: false,
        wouldWrite: false,
        blockerCode: 'recovery-supervisor-missing',
        evidence: 'Recovery supervisor start behavior is not implemented.'
      }
    ],
    safety: {
      dryRun: true,
      planOnly: true,
      rollbackExecuted: false,
      uninstallExecuted: false,
      recoverySupervisorStarted: false,
      launchctlCalled: false,
      processListRead: false,
      filesystemWritten: false,
      metadataWritten: false,
      supervisorInstalled: false,
      supervisorStarted: false,
      launchdFileWritten: false,
      launchdFileRemoved: false,
      previousPlistRestored: false,
      nasConnected: false,
      backupTriggered: false,
      restoreTriggered: false,
      remoteCommandExecuted: false,
      sensitiveValuesReturned: false
    }
  }
}
```

The helper exports `buildSupervisorRollbackUninstallPlan()` so tests and future UI code can depend on one pure builder.

## Compatibility

- `rollbackUninstallPlan` is an additive full-plan key. Existing consumers that only understand the V0.84 schema should ignore unknown keys.
- `installApprovalManifest` remains the install approval and prerequisite gate. `rollbackUninstallPlan` is the detailed lifecycle dry-run plan. Both must keep rollback, uninstall, and recovery unavailable until a future mutating lifecycle design is approved.
- `rollbackUninstallPlan.actions` is a stable, id-addressed list. Consumers must use `action.id` instead of array index. Future releases may append new blocked actions but must not reorder or silently change existing action IDs.
- Existing top-level `safety` remains unchanged.
- Existing `installApprovalManifest.rollback.available:false` remains unchanged.
- Existing `installApprovalManifest.controls` IDs remain unchanged.
- Existing `installPreflight` check IDs remain unchanged.
- `--readiness-summary` output remains unchanged and excludes `rollbackUninstallPlan`.
- `--fail-on-blocked` full JSON output includes `rollbackUninstallPlan` because it prints the full plan.
- `--readiness-summary --fail-on-blocked` still prints only `readinessSummary`.
- `POST /api/supervisor-install-dry-run` returns the same full plan as `buildSupervisorInstallDryRunPlan(config)`, so it will include `rollbackUninstallPlan` automatically. V0.85 does not add Web rendering for that field.

## Testing

Add tests in `test/agent-supervisor-install-dry-run.test.js`:

- `buildSupervisorRollbackUninstallPlan` exists and deep-equals the expected static fixture.
- Full `buildSupervisorInstallDryRunPlan(config)` output includes `rollbackUninstallPlan`.
- Every `rollbackUninstallPlan.actions[]` item has `status:"blocked"`, `wouldRun:false`, `wouldWrite:false`, and a stable non-empty `blockerCode`.
- The three lifecycle groups remain blocked:
  - `rollback.available:false`
  - `uninstall.available:false`
  - `recovery.available:false`
- Safety flags remain false for launchctl, process list, filesystem writes, metadata writes, rollback execution, uninstall execution, recovery supervisor start, install/start, NAS, backup, restore, remote command, previous plist restore, launchd file removal, and sensitive value return.
- Evidence strings do not contain local paths, URLs, NAS hosts, credential refs, token/auth words, config filenames, LaunchAgents paths, plist paths, approver/timestamp/user/host/process identifiers, or runnable command arguments.
- CLI full JSON includes the object and still does not write files next to the config.
- `--readiness-summary` excludes `rollbackUninstallPlan`.
- `--fail-on-blocked` full JSON includes `rollbackUninstallPlan` and exits 2.
- `--readiness-summary --fail-on-blocked` excludes `rollbackUninstallPlan` and exits 2.
- The evidence leak guard must explicitly reject path, URL, credential, auth, user, host, process, plist, LaunchAgents, and runnable-command patterns with regex coverage equivalent to `/\/Users\/|\/private\/|~\/|https?:\/\//i`, `/token|bearer|authorization|credentialRef|secret-ref|nas\.local/i`, `/config\.json|LaunchAgents|\.plist/i`, `/approver|timestamp|hostname|username|process|pid/i`, and `/launchctl\s|rm\s|mv\s|cp\s|unlink\s/i`.

Update docs/version/Gold tests:

- `src/version.js` becomes `V0.85`.
- README current version and supervisor install sections document the new blocked `rollbackUninstallPlan`.
- Gold readiness evidence for `automation-installation` and `production-hardening` includes `buildSupervisorRollbackUninstallPlan` and `rollbackUninstallPlan.state:blocked`.
- Gold remains blocked because real NAS remote backup, real installer, launchd lifecycle, watchdog, monitoring, approval persistence, rollback, uninstall, recovery supervisor, and production hardening are still not complete.

## Resilience Gate

Normal state after V0.85:

- Full supervisor install dry-run JSON includes a sanitized blocked `rollbackUninstallPlan`.
- Summary-only output remains unchanged.
- No host lifecycle action is executed.
- Gold readiness remains blocked.

Recovery anchor:

- The last-green V0.84 dry-run contract remains valid. If V0.85 fails, rollback is the V0.84 schema without `rollbackUninstallPlan`; no runtime state has been mutated.

Bounded failure behavior:

- Invalid config handling remains the existing sanitized `supervisor-install-dry-run failed; verify --config points to a readable valid Linke config` error.
- The new helper is static and cannot fail from IO, network, process, launchd, or config values.
- If docs are updated but schema tests fail, the release is not accepted and the docs must not claim V0.85.

State detection and self-check:

- Unit tests detect schema drift.
- CLI tests detect full-vs-summary output boundaries.
- Sensitive-output guards detect path, URL, credential, auth, user, host, process, and runnable-command leaks.
- Gold readiness tests detect overclaiming by keeping Gold blocked.

## Acceptance Criteria

V0.85 is accepted only if:

- The design and implementation plan pass Qwen read-only adversarial review.
- DeepSeek closure returns PASS or accepted true for the design, plan, and final evidence.
- `node --test --test-reporter=dot test/agent-supervisor-install-dry-run.test.js` passes.
- Focused docs/version/Gold tests pass.
- Full `node --test --test-reporter=dot test/*.test.js` passes.
- `git diff --check` passes.
- PM review confirms no real rollback, uninstall, install, launchctl, process-list, file-write, NAS, backup, restore, or remote-command behavior was added.
- README and Gold readiness continue to state that Gold is blocked.
