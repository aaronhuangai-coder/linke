# Supervisor Install Preflight Gate Design

## Goal

V0.82 adds a sanitized `installPreflight` gate to `agent.js supervisor-install-dry-run` so an operator can see the production prerequisites that still block a real supervisor install, without executing commands, writing files, touching launchd, or exposing local paths.

## Selected Approach

Add a top-level `installPreflight` object to the existing full supervisor install dry-run JSON. Keep `--readiness-summary` unchanged: it still prints only `readinessSummary`, not `installCommandPreview` or `installPreflight`.

This keeps V0.82 as a safe bridge between the V0.81 command preview and a future real installer. The preflight gate is more specific than `readinessSummary` but still strictly dry-run-only and blocked.

`installPreflight` is a static, code-owned object in V0.82. It must not run host probes, inspect launchd, inspect processes, resolve local paths, or infer readiness from the current machine.

## Alternatives Considered

- Add a new `--install-preflight` flag.
  - Rejected for V0.82 because the full dry-run output is already the operator audit artifact, and another flag would add CLI surface before real install design is ready.
- Convert `readinessSummary.blockers` into detailed objects.
  - Rejected because existing automation already depends on a compact summary shape; V0.82 should preserve that stable gate.
- Start implementing a real installer behind `--install`.
  - Rejected because auth, secret management, production audit, watchdog, monitoring, recovery, launchd lifecycle, and rollback boundaries are still incomplete.

## Non-Goals

- Do not implement a real installer.
- Do not add `--install`, `--start`, `--load`, or any command that can change system state.
- Do not call `launchctl`.
- Do not read process lists.
- Do not install or start launchd jobs.
- Do not write `~/Library/LaunchAgents`, plist files, metadata, config, device data, snapshots, audit success events, or preflight reports.
- Do not connect NAS.
- Do not trigger backup, restore, or remote commands.
- Do not print config paths, source paths, server URLs, NAS endpoints, credential refs, token values, Authorization headers, environment values, home paths, plist paths, executable paths, or runnable command arguments.
- Do not claim production supervisor, production readiness, Gold readiness, real installer readiness, or managed daemon lifecycle.

## User Value

V0.80 exposes that installation is blocked, and V0.81 shows a non-runnable preview of future install actions. Operators still need a machine-readable list of what must be true before real install/start can be designed safely. `installPreflight` turns those missing boundaries into explicit checks that can be reviewed in CI, docs, and future release gates.

## Output Schema

The full dry-run plan adds:

```js
{
  installPreflight: {
    mode: 'dry-run-only',
    state: 'blocked',
    blockedCount: 6,
    readyCount: 0,
    checkedCount: 6,
    checks: [
      {
        id: 'installer-implementation',
        label: 'Real installer implementation',
        status: 'blocked',
        blockerCode: 'real-install-not-implemented',
        requiredForInstall: true,
        evidence: 'No install command or launchd write path exists in this release.'
      },
      {
        id: 'launchd-lifecycle',
        label: 'Launchd install/start lifecycle',
        status: 'blocked',
        blockerCode: 'launchd-lifecycle-blocked',
        requiredForInstall: true,
        evidence: 'launchctl execution, plist writes, and daemon start remain disabled.'
      },
      {
        id: 'operator-approval',
        label: 'Explicit operator approval gate',
        status: 'blocked',
        blockerCode: 'operator-approval-required',
        requiredForInstall: true,
        evidence: 'No approved write path or production install confirmation flow exists.'
      },
      {
        id: 'secret-management',
        label: 'Production secret management',
        status: 'blocked',
        blockerCode: 'secret-management-incomplete',
        requiredForInstall: true,
        evidence: 'Token rotation, credential storage, and secret handling are not production-grade.'
      },
      {
        id: 'monitoring-watchdog',
        label: 'Monitoring and watchdog',
        status: 'blocked',
        blockerCode: 'monitoring-watchdog-incomplete',
        requiredForInstall: true,
        evidence: 'No watchdog, health recovery loop, alerting, or managed daemon monitoring is implemented.'
      },
      {
        id: 'rollback-recovery',
        label: 'Rollback and recovery plan',
        status: 'blocked',
        blockerCode: 'rollback-recovery-incomplete',
        requiredForInstall: true,
        evidence: 'No rollback, uninstall, or recovery supervisor lifecycle is implemented.'
      }
    ],
    safety: {
      dryRun: true,
      preflightOnly: true,
      launchctlCalled: false,
      processListRead: false,
      filesystemWritten: false,
      metadataWritten: false,
      nasConnected: false,
      backupTriggered: false,
      restoreTriggered: false,
      remoteCommandExecuted: false,
      sensitiveValuesReturned: false
    }
  }
}
```

All `evidence` strings must stay generic and must not include local paths, token values, NAS endpoints, credential refs, environment values, or host-specific details.

`blockerCode` values are stable automation identifiers for this release. They should not be renamed without an explicit future version migration note and matching test updates.

## CLI Semantics

- `supervisor-install-dry-run --config <file>`
  - Prints the full sanitized plan with `readinessSummary`, `installCommandPreview`, and `installPreflight`.
  - Exit code `0`.
- `supervisor-install-dry-run --config <file> --fail-on-blocked`
  - Prints the full sanitized plan with `readinessSummary`, `installCommandPreview`, and `installPreflight`.
  - Exit code `2` because readiness remains blocked.
- `supervisor-install-dry-run --config <file> --readiness-summary`
  - Prints only `readinessSummary`.
  - Does not include `installCommandPreview` or `installPreflight`.
  - Exit code `0`.
- `supervisor-install-dry-run --config <file> --readiness-summary --fail-on-blocked`
  - Prints only `readinessSummary`.
  - Does not include `installCommandPreview` or `installPreflight`.
  - Exit code `2`.

Existing boolean flag value rejection and `--output` rejection stay unchanged.

## Safety Boundaries

`installPreflight` must not contain:

- config path
- sourcePath
- serverUrl
- NAS endpoint
- remotePath
- credentialRef
- token
- Authorization header
- Bearer token
- environment values
- real user home directory
- real plist path
- real node executable path
- runnable launchctl command

The full plan must continue reporting all V0.81 false safety fields, including `launchctlCalled:false`, `processListRead:false`, `supervisorInstalled:false`, `launchdFileWritten:false`, `metadataWritten:false`, `nasConnected:false`, `backupTriggered:false`, `restoreTriggered:false`, and `remoteCommandExecuted:false`.

The nested `installPreflight.safety` object is additive to, and distinct from, the top-level full-plan `safety` object. Full output must include both objects; adding preflight safety must not remove or rename the existing top-level V0.81 safety fields.

## Gold Readiness Boundary

V0.82 adds partial evidence to `automation-installation` and `production-hardening`, but it must not move either item to `ready`. `real-nas-remote-backup` remains `blocked`, and overall Gold readiness remains `blocked`.

Gold next steps should state that V0.82 adds a preflight gate only. Real installer, launchd install/start, watchdog, monitoring, managed daemon lifecycle, rollback, secret management, production audit, deployment hardening, and production security review remain future work.

## Operational Resilience

Normal state:

- Full dry-run exits `0` and reports `installPreflight.state:"blocked"`.
- `--fail-on-blocked` exits `2` after printing JSON.
- `--readiness-summary` stays compact and excludes preflight detail.
- No file, process, NAS, launchd, backup, restore, audit success, or metadata state is written.

Recovery anchor:

- Last known green state is V0.81 supervisor install command preview.
- If V0.82 preflight behavior fails, revert only the preflight helper, plan output wiring, tests, version/docs/Gold updates, and V0.82 plan/spec docs.
- Recovery must leave the V0.81 command preview, readiness summary, and existing supervisor install dry-run behavior intact.

Failure modes:

- Missing or invalid config: fail closed with the existing fixed sanitized error and exit `1`.
- Boolean flag value supplied: fail closed with explicit flag error and exit `1`.
- Blocked readiness with `--fail-on-blocked`: print JSON and exit `2`.

Observable signals:

- JSON field `installPreflight.state:"blocked"` in full output.
- `installPreflight.blockedCount === installPreflight.checkedCount`.
- Every preflight check uses `status:"blocked"` and `requiredForInstall:true`.
- Full dry-run exits `0` without `--fail-on-blocked` even when `installPreflight.state` is `blocked`.
- Existing no-write and no-leak tests remain green.

## Testing

Add focused tests in `test/agent-supervisor-install-dry-run.test.js`:

- Pure helper/full plan includes `installPreflight` with six fixed check IDs.
- Every preflight check has `status:"blocked"`, `requiredForInstall:true`, and a stable `blockerCode`.
- `blockedCount`, `readyCount`, and `checkedCount` match the checks array.
- `installPreflight.safety` reports dry-run-only, no-write, no-launchctl, no-NAS, no-backup/restore, no-remote-command, and no sensitive values.
- Full CLI output includes `installPreflight` and still does not leak paths, endpoints, credentials, tokens, or Authorization values.
- Every `evidence` string passes a no-sensitive-values assertion: no absolute paths, no URLs, no token-like patterns, no home directory fragments, and no credential refs.
- Full dry-run exit code is `0` without `--fail-on-blocked` even though `installPreflight.state` is `blocked`.
- `--readiness-summary` output does not include `installCommandPreview` or `installPreflight`.
- `--fail-on-blocked` full output still includes `installPreflight` before exiting `2`.
- Existing `--output`, sanitized config error, no-write, readiness summary, command preview, and no-leak tests remain green.

Update version, README, and Gold readiness tests for V0.82.

## Verification

- `node --test test/agent-supervisor-install-dry-run.test.js`
- `node --test test/version.test.js test/gold-readiness.test.js test/readme.test.js test/agent-supervisor-install-dry-run.test.js`
- `node --test --test-reporter=dot test/*.test.js`
- `git diff --check`
- Overclaim scan on README.md and src for production-ready, Gold-ready, real NAS ready, daemon installed, launchd installed, always-running, real installer, real install ready, and production-ready supervisor claims.
- Qwen read-only adversarial review.
- DeepSeek auxiliary closure verification with strict JSON-only output.
- ZAI is not a required closure verifier for V0.82 because repeated fixed generic responses made it inconclusive for V0.81.
