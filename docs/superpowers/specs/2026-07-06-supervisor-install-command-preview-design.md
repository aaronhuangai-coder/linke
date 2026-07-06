# Supervisor Install Command Preview Design

## Goal

V0.81 adds a sanitized `installCommandPreview` to `agent.js supervisor-install-dry-run` so an operator can audit the future supervisor installation sequence without executing commands, writing files, touching launchd, or exposing local paths.

## Selected Approach

Add a top-level `installCommandPreview` object to the existing full supervisor install dry-run JSON. Keep `--readiness-summary` unchanged: it still prints only `readinessSummary`, not the command preview.

This is narrower than adding a new CLI command and clearer than embedding command strings in `nextSteps`. It makes the future install sequence machine-readable while preserving the existing blocked readiness gate.

## Alternatives Considered

- Add a new `--command-preview` flag.
  - Rejected for V0.81 because the full dry-run output is already the audit artifact, and another flag would add CLI surface without enough value.
- Put command hints only in `nextSteps`.
  - Rejected because `nextSteps` is free text and not stable enough for tests or automation.
- Reuse `launchd-dry-run` output.
  - Rejected because that command can write an output file with `--output`; V0.81 must remain no-write and supervisor-specific.

## Non-Goals

- Do not implement a real installer.
- Do not call `launchctl`.
- Do not read process lists.
- Do not install or start launchd jobs.
- Do not write `~/Library/LaunchAgents`, plist files, metadata, config, device data, snapshots, or audit success events.
- Do not connect NAS.
- Do not trigger backup, restore, or remote commands.
- Do not print config paths, source paths, server URLs, NAS endpoints, credential refs, token values, Authorization headers, or environment values.
- Do not output a real user home path, real config path, real plist path, real executable path, or real launchctl command with runnable arguments.
- Do not claim production supervisor, production readiness, Gold readiness, or managed daemon lifecycle.

## User Value

The existing dry-run says installation is blocked, but an operator still cannot see what future work is being blocked in a structured way. `installCommandPreview` provides a stable audit checklist for future installer design, review, and automation evidence while keeping the implementation dry-run-only.

## Output Schema

The full dry-run plan adds:

```js
{
  installCommandPreview: {
    mode: 'dry-run-only',
    state: 'blocked',
    actions: [
      {
        id: 'render-launch-agent-plist',
        description: 'Render a launch agent plist preview with redacted config path.',
        command: 'generate launchd plist preview',
        wouldRun: false,
        wouldWrite: false,
        sensitiveValuesReturned: false
      },
      {
        id: 'write-launch-agent-plist',
        description: 'Future installer would write a launch agent plist to a user LaunchAgents location.',
        command: 'write launch agent plist to [redacted]',
        wouldRun: false,
        wouldWrite: false,
        sensitiveValuesReturned: false
      },
      {
        id: 'load-launch-agent',
        description: 'Future installer would ask launchd to load the agent after explicit operator approval.',
        command: 'launchctl bootstrap gui/[redacted] [redacted]',
        wouldRun: false,
        wouldWrite: false,
        sensitiveValuesReturned: false
      },
      {
        id: 'start-launch-agent',
        description: 'Future installer would start the launch agent after successful load.',
        command: 'launchctl kickstart gui/[redacted]/[redacted]',
        wouldRun: false,
        wouldWrite: false,
        sensitiveValuesReturned: false
      }
    ],
    safety: {
      executableResolved: false,
      configPathResolved: false,
      plistPathResolved: false,
      launchctlCommandsRunnable: false,
      launchctlCalled: false,
      launchdFileWritten: false,
      metadataWritten: false
    }
  }
}
```

All command strings are intentionally non-runnable and use redacted markers.

## CLI Semantics

- `supervisor-install-dry-run --config <file>`
  - Prints the full sanitized plan with `installCommandPreview` and `readinessSummary`.
  - Exit code `0`.
- `supervisor-install-dry-run --config <file> --fail-on-blocked`
  - Prints the full sanitized plan with `installCommandPreview` and `readinessSummary`.
  - Exit code `2` because readiness remains blocked.
- `supervisor-install-dry-run --config <file> --readiness-summary`
  - Prints only `readinessSummary`.
  - Does not include `installCommandPreview`.
  - Exit code `0`.
- `supervisor-install-dry-run --config <file> --readiness-summary --fail-on-blocked`
  - Prints only `readinessSummary`.
  - Does not include `installCommandPreview`.
  - Exit code `2`.

Existing boolean flag value rejection and `--output` rejection stay unchanged.

## Safety Boundaries

`installCommandPreview` must not contain:

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

The full plan must continue reporting all V0.80 false safety fields, including `launchctlCalled:false`, `processListRead:false`, `supervisorInstalled:false`, `launchdFileWritten:false`, `metadataWritten:false`, `nasConnected:false`, `backupTriggered:false`, `restoreTriggered:false`, and `remoteCommandExecuted:false`.

## Gold Readiness Boundary

V0.81 adds partial evidence to `automation-installation` and `production-hardening`, but it must not move either item to `ready`. `real-nas-remote-backup` remains `blocked`, and overall Gold readiness remains `blocked`.

Gold next steps should state that V0.81 adds a non-runnable command preview only. Real installer, launchd install/start, watchdog, monitoring, managed daemon lifecycle, deployment hardening, secret management, and production security review remain future work.

## Testing

Add focused tests in `test/agent-supervisor-install-dry-run.test.js`:

- Pure helper/full plan includes `installCommandPreview` with four fixed action IDs.
- Every preview action has `wouldRun:false`, `wouldWrite:false`, and `sensitiveValuesReturned:false`.
- Full CLI output includes `installCommandPreview` and still does not leak paths, endpoints, credentials, tokens, or Authorization values.
- `--readiness-summary` output does not include `installCommandPreview`.
- `--fail-on-blocked` full output still includes `installCommandPreview` before exiting `2`.
- Existing `--output`, sanitized config error, no-write, readiness summary, and no-leak tests remain green.

Update version, README, and Gold readiness tests for V0.81.

## Verification

- `node --test test/agent-supervisor-install-dry-run.test.js`
- `node --test test/version.test.js test/gold-readiness.test.js test/readme.test.js test/agent-supervisor-install-dry-run.test.js`
- `node --test --test-reporter=dot test/*.test.js`
- `git diff --check`
- Overclaim scan on README.md and src for production-ready, Gold-ready, real NAS ready, daemon installed, launchd installed, always-running, real installer, and production-ready supervisor claims.
- Qwen read-only adversarial review and ZAI closure verification.
