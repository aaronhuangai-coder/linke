# NAS CLI Readiness Summary Design

## Goal

Ship Linke V0.68 with a dry-run-only CLI output mode for NAS execution readiness:

```bash
node src/agent.js nas-dry-run --config linke.config.json --readiness-summary
```

The command must output only the existing `readinessSummary` object from `buildNasDryRunPlan()`. It must not connect to NAS endpoints, resolve credentials, invoke NAS apps, write remote data, or echo raw `credentialRef` values.

## Current State

V0.67 added:

- top-level `readinessSummary`
- per-target `executionReadiness`
- fixed NAS blocker codes
- Web Console rendering for readiness fields
- fixed `executionGate.remoteExecutionAllowed:false`

The `nas-dry-run` CLI currently outputs the entire dry-run plan. That is useful for debugging, but automation often needs only the summary status and counts.

## Design

Add one optional CLI flag to the existing `nas-dry-run` command:

- `--readiness-summary`

When the flag is absent, output stays unchanged: the full sanitized dry-run plan is printed as JSON.

When the flag is present, the CLI still calls `runNasDryRunFromConfig(args.config)` and then prints `plan.readinessSummary` as formatted JSON. The output includes only:

- `mode`
- `state`
- target counts
- credential-reference count fields
- `remoteExecutionBlocked`
- fixed blocker code array

The output must not include target endpoint, share, remote path, backup job source paths, raw `credentialRef`, adapter details, or per-target rows.

If `plan.readinessSummary` is missing because of a future regression, the CLI must fail closed with an explicit error instead of printing empty stdout or invalid JSON.

## Flag Validation

`--readiness-summary` is a boolean flag. If a value is supplied, the CLI exits with code `1` through the existing error handler and prints:

```text
Error: --readiness-summary does not accept a value
```

This prevents accidental interpretation of a path or free-form value as a mode.

## Safety Boundaries

- Do not add real NAS network calls.
- Do not read environment variables for NAS credentials.
- Do not add credential resolver or secret manager access.
- Do not invoke NAS apps.
- Do not write local metadata, remote NAS files, or config files.
- Do not echo raw `credentialRef` values.
- Keep `executionGate.remoteExecutionAllowed:false`.
- Keep `real-nas-remote-backup` blocked in Gold readiness.

## Runtime Resilience

Normal state: `nas-dry-run --readiness-summary` returns valid JSON derived from a validated config and exits `0`.

Recovery anchor: the existing full `nas-dry-run` path remains unchanged and can still be used for debugging if the summary output is insufficient.

Failure modes:

- Missing `--config` -> existing `--config is required` error.
- Invalid config -> existing validation error.
- `--readiness-summary` receives a value -> fail closed with exit `1`.
- Missing `readinessSummary` due future regression -> explicit CLI error `readinessSummary missing from dry-run plan` and test suite failure before release.

Observable signals:

- CLI stdout is parseable JSON.
- CLI stderr uses the existing `Error: ...` prefix for invalid usage.
- Tests assert no raw credential reference or endpoint appears in summary stdout.

## Acceptance Criteria

- `node src/agent.js nas-dry-run --config <file> --readiness-summary` prints only `readinessSummary`.
- Missing `plan.readinessSummary` fails closed instead of printing empty stdout.
- The output contains fixed blocker codes such as `remote-execution-blocked`, `credential-ref-missing`, and `target-disabled` when applicable.
- The output does not contain endpoint, shareName, remotePath, sourcePath, target names, or raw `credentialRef`.
- `nas-dry-run` without the flag remains backward compatible.
- README, version, Gold readiness evidence, and tests are updated to V0.68.
- Full test suite passes.
