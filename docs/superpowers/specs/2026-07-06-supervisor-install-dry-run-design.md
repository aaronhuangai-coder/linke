# Supervisor Install Dry-Run Design

## Goal

V0.79 adds `agent.js supervisor-install-dry-run`, a local CLI-only dry-run that explains what a future supervisor installation would need without installing, starting, probing, or managing any daemon.

## Non-Goals

- Do not call `launchctl`.
- Do not read process lists.
- Do not write `~/Library/LaunchAgents` or any launchd plist.
- Do not write metadata, device data, snapshots, audit success events, or config.
- Do not connect NAS.
- Do not trigger backup, restore, or remote commands.
- Do not print config paths, source paths, server URLs, NAS endpoints, credential refs, token values, Authorization headers, or environment values.
- Do not claim production supervisor, production readiness, Gold readiness, or managed daemon lifecycle.

## User Value

Operators need a safe bridge between the existing `launchd-dry-run` plist generator and a future real installer. This command provides a tested, sanitized install readiness plan that can be reviewed in automation without touching macOS launchd state.

## Architecture

- Reuse `loadConfig()` and `validateConfig()` from `src/config.js` so the plan is based on the same normalized config as `run-once` and `launchd-dry-run`.
- Add a pure `buildSupervisorInstallDryRunPlan(config)` helper in `src/agent.js`.
- Add `supervisor-install-dry-run --config <path>` CLI wiring in `src/agent.js`.
- The command prints JSON only. It never writes files and rejects `--output` because output paths belong to `launchd-dry-run`, not this safety report.

## Output Schema

```js
{
  status: 'partial',
  service: 'linke',
  version: 'V0.79',
  command: 'supervisor-install-dry-run',
  supervisor: {
    state: 'not_configured',
    installPlan: 'dry_run_only',
    label: 'com.linke.agent.device-id',
    scheduleSeconds: 3600,
    target: 'user-launch-agent',
    program: 'node src/agent.js run-once --config [redacted]',
    wouldInstall: false,
    wouldStart: false,
    wouldCallLaunchctl: false,
    wouldWriteLaunchAgent: false,
    wouldWriteMetadata: false
  },
  configSummary: {
    deviceId: 'device-id',
    backupJobCount: 1,
    nasTargetCount: 0,
    excludePatternCount: 0
  },
  safety: {
    dryRun: true,
    configPathReturned: false,
    sourcePathsReturned: false,
    serverUrlReturned: false,
    nasEndpointsReturned: false,
    credentialRefsReturned: false,
    tokenValuesReturned: false,
    launchctlCalled: false,
    processListRead: false,
    supervisorInstalled: false,
    launchdFileWritten: false,
    metadataWritten: false,
    nasConnected: false,
    backupTriggered: false,
    restoreTriggered: false,
    remoteCommandExecuted: false
  },
  nextSteps: [
    'Review this sanitized dry-run plan.',
    'Use launchd-dry-run separately if a plist preview is needed.',
    'Real install/start remains out of scope.'
  ]
}
```

## Error Handling

- Missing `--config` fails with `--config is required`.
- Config read or validation failure returns a fixed sanitized error: `supervisor-install-dry-run failed; verify --config points to a readable valid Linke config`.
- `--output` fails with `--output is not supported by supervisor-install-dry-run`.
- Error messages must not include config path, sourcePath, serverUrl, NAS endpoint, remotePath, credentialRef, user-provided token values, Authorization headers, environment values, or raw config content.

## Testing

- Pure helper test: plan schema, false safety fields, counts, and no sensitive config values.
- CLI test: prints valid JSON and does not create files beyond the input config.
- CLI test: config read and validation errors are sanitized and do not echo config paths or sensitive config values.
- CLI test: rejects `--output` without writing the requested file.
- README/version/Gold tests: V0.79 is current; `automation-installation` and `production-hardening` remain partial; Gold remains blocked.

## Verification

- Targeted tests for `test/agent-supervisor-install-dry-run.test.js`, `test/version.test.js`, `test/gold-readiness.test.js`, and `test/readme.test.js`.
- Full `node --test --test-reporter=dot test/*.test.js`.
- `git diff --check`.
- Overclaim scan for production-ready, Gold-ready, real NAS ready, daemon installed, launchd installed, and always-running claims.
- Qwen read-only adversarial review and ZAI closure verification.
