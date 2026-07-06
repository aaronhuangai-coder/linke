# Supervisor Install Readiness Gate Design

## Goal

V0.80 adds an automation-friendly readiness gate to `agent.js supervisor-install-dry-run` so CI or local scripts can detect that real supervisor installation remains blocked without installing, starting, probing, or writing any macOS launchd state.

## Selected Approach

Add two local CLI options to the existing `supervisor-install-dry-run` command:

- `--readiness-summary`: print only a compact sanitized readiness summary.
- `--fail-on-blocked`: print the normal plan or summary, then set exit code `2` when readiness is blocked.

This mirrors the proven `nas-dry-run --readiness-summary --fail-on-blocked` pattern while keeping supervisor installation strictly dry-run-only.

## Non-Goals

- Do not implement a real installer.
- Do not call `launchctl`.
- Do not read process lists.
- Do not install or start launchd jobs.
- Do not write `~/Library/LaunchAgents`, plist files, metadata, config, device data, snapshots, or audit success events.
- Do not connect NAS.
- Do not trigger backup, restore, or remote commands.
- Do not print config paths, source paths, server URLs, NAS endpoints, credential refs, token values, Authorization headers, or environment values.
- Do not claim production supervisor, production readiness, Gold readiness, or managed daemon lifecycle.

## User Value

Operators already have a sanitized install dry-run plan, but automation still needs a stable blocked signal. `--fail-on-blocked` lets scripts fail closed before any real installation work exists, and `--readiness-summary` keeps logs short enough for CI, cron dry-runs, and remote operator reports.

## Architecture

The existing `buildSupervisorInstallDryRunPlan(config)` remains the source of truth. V0.80 adds a pure `buildSupervisorInstallReadinessSummary(plan)` helper in `src/agent.js` and extends the CLI case for `supervisor-install-dry-run`.

The command flow stays local:

```text
parse args -> reject unsupported values -> runSupervisorInstallDryRun(configPath)
  -> buildSupervisorInstallDryRunPlan(validatedConfig)
  -> optionally buildSupervisorInstallReadinessSummary(plan)
  -> print JSON -> optionally set process.exitCode = 2
```

No HTTP request, NAS call, child process, process list read, file write, or launchd interaction is added.

## Output Schema

The existing full dry-run plan keeps its V0.79 fields and adds one top-level field:

```js
{
  readinessSummary: {
    state: 'blocked',
    blockedCount: 4,
    blockers: [
      'real-install-not-implemented',
      'launchd-install-blocked',
      'supervisor-start-blocked',
      'production-boundaries-incomplete'
    ],
    readyCount: 0,
    checkedCount: 4,
    failOnBlockedExitCode: 2
  }
}
```

`--readiness-summary` prints only that object.

`state` is fixed to `blocked` in V0.80 because real installation, launchd install/start, managed daemon lifecycle, and production boundaries are intentionally not implemented.

## CLI Semantics

- `node src/agent.js supervisor-install-dry-run --config linke.config.json`
  - Prints the full sanitized plan with `readinessSummary`.
  - Exit code `0`.
- `node src/agent.js supervisor-install-dry-run --config linke.config.json --readiness-summary`
  - Prints only `readinessSummary`.
  - Exit code `0`.
- `node src/agent.js supervisor-install-dry-run --config linke.config.json --fail-on-blocked`
  - Prints the full sanitized plan with `readinessSummary`.
  - Exit code `2` because `state:"blocked"`.
- `node src/agent.js supervisor-install-dry-run --config linke.config.json --readiness-summary --fail-on-blocked`
  - Prints only `readinessSummary`.
  - Exit code `2`.

Boolean flags reject values:

- `--readiness-summary yes` fails with `--readiness-summary does not accept a value`.
- `--fail-on-blocked yes` fails with `--fail-on-blocked does not accept a value`.

`--output` remains unsupported and still fails before any config read or file write.

## Safety Boundaries

The readiness summary must not include:

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

The full plan and summary must continue to report:

- `wouldInstall:false`
- `wouldStart:false`
- `wouldCallLaunchctl:false`
- `wouldWriteLaunchAgent:false`
- `wouldWriteMetadata:false`
- `launchctlCalled:false`
- `processListRead:false`
- `supervisorInstalled:false`
- `launchdFileWritten:false`
- `metadataWritten:false`
- `nasConnected:false`
- `backupTriggered:false`
- `restoreTriggered:false`
- `remoteCommandExecuted:false`

Config read and validation errors keep the existing fixed sanitized error message:

```text
supervisor-install-dry-run failed; verify --config points to a readable valid Linke config
```

## Gold Readiness Boundary

V0.80 adds partial evidence to `automation-installation` and `production-hardening`, but it must not move either item to `ready`. `real-nas-remote-backup` remains `blocked`, and overall Gold readiness remains `blocked`.

Gold next steps should mention that V0.80 adds an automation gate only. Real installer, launchd install/start, watchdog, monitoring, managed daemon lifecycle, deployment hardening, secret management, and production security review remain future work.

## Testing

Add focused tests to `test/agent-supervisor-install-dry-run.test.js`:

- Pure helper returns a blocked `readinessSummary`.
- Full CLI output includes sanitized `readinessSummary`.
- `--readiness-summary` prints only summary JSON and does not leak sensitive values.
- `--fail-on-blocked` exits `2` while still printing valid JSON.
- Combined `--readiness-summary --fail-on-blocked` exits `2`.
- Boolean flag values are rejected.
- Existing `--output`, sanitized config error, no write, and sensitive-value tests remain green.

Update existing version, README, and Gold readiness tests for V0.80.

## Operational Resilience

Normal state:

- The command exits `0` for dry-run output unless `--fail-on-blocked` is set.
- Summary state is `blocked`.
- No files or system state are written.

Recovery anchor:

- Last known green state is V0.79 supervisor install dry-run.
- If V0.80 summary behavior fails, revert only the readiness summary helper, CLI option wiring, tests, and V0.80 docs.

Failure modes:

- Missing or invalid config: fail closed with the fixed sanitized error and exit `1`.
- Boolean flag value supplied: fail closed with explicit flag error and exit `1`.
- Blocked readiness with `--fail-on-blocked`: print JSON and exit `2`.

Observable signals:

- Exit code `0`, `1`, or `2`.
- JSON field `state:"blocked"` in `readinessSummary`.
- Existing no-write and no-leak tests.

## Verification

- `node --test test/agent-supervisor-install-dry-run.test.js`
- `node --test test/version.test.js test/gold-readiness.test.js test/readme.test.js test/agent-supervisor-install-dry-run.test.js`
- `node --test --test-reporter=dot test/*.test.js`
- `git diff --check`
- Overclaim scan on README.md and src for production-ready, Gold-ready, real NAS ready, daemon installed, launchd installed, and always-running claims.
- Qwen read-only adversarial review and ZAI closure verification.
