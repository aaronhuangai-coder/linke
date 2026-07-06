# NAS CLI Fail-On-Blocked Design

## Goal

Ship Linke V0.69 with a dry-run-only automation gate for NAS readiness:

```bash
node src/agent.js nas-dry-run --config linke.config.json --fail-on-blocked
node src/agent.js nas-dry-run --config linke.config.json --readiness-summary --fail-on-blocked
```

When `readinessSummary.state` is `blocked`, the command must still print valid JSON to stdout and then exit with code `2`. This gives scripts and CI a stable way to detect blocked NAS readiness without parsing business text.

## Current State

V0.68 added `nas-dry-run --readiness-summary`, which prints only the existing top-level `readinessSummary` object. The command still exits `0` even when the summary is blocked.

Because `executionGate.remoteExecutionAllowed` is fixed to `false`, V0.69 `--fail-on-blocked` is expected to return exit code `2` for current valid configs. That is intentional: the flag is an explicit automation gate, not a readiness promotion.

## Design

Add one optional boolean flag to the existing `nas-dry-run` CLI command:

- `--fail-on-blocked`

Behavior:

- Without the flag, V0.68 behavior remains unchanged.
- With the flag, the CLI prints the same JSON it would otherwise print.
- If `plan.readinessSummary.state === "blocked"`, set `process.exitCode = 2` after printing stdout.
- If `plan.readinessSummary` is missing while either `--readiness-summary` or `--fail-on-blocked` needs it, fail closed with `Error: readinessSummary missing from dry-run plan`.
- If `--fail-on-blocked` receives a value, exit `1` with `Error: --fail-on-blocked does not accept a value`.

The flag can be combined with `--readiness-summary`; in that mode stdout remains the summary-only JSON.

## Exit Codes

- `0`: command succeeded and either `--fail-on-blocked` was not requested, or readiness is not blocked.
- `2`: command succeeded, JSON was printed, and `--fail-on-blocked` detected `readinessSummary.state === "blocked"`.
- `1`: invalid CLI usage, invalid config, missing config, or other existing command error.

Exit code `2` intentionally matches the existing `release-readiness` CLI convention for a completed check that is not ready.

No-flag compatibility remains unchanged from V0.68: `nas-dry-run --config <file>` prints the full sanitized plan and exits `0` for valid configs.

## Safety Boundaries

- Do not add real NAS network calls.
- Do not read environment variables for NAS credentials.
- Do not add credential resolver or secret manager access.
- Do not invoke NAS apps.
- Do not write local metadata, config files, audit events, or remote NAS files.
- Do not echo raw `credentialRef` values.
- Keep `executionGate.remoteExecutionAllowed:false`.
- Keep `real-nas-remote-backup` blocked in Gold readiness.

## Runtime Resilience

Normal state: `nas-dry-run --fail-on-blocked` prints parseable JSON and exits `2` while current NAS execution remains blocked.

Recovery anchor: removing `--fail-on-blocked` restores the existing V0.68 exit behavior while preserving JSON output.

Failure modes:

- Missing `--config` -> existing `--config is required` error and exit `1`.
- Invalid config -> existing validation error and exit `1`.
- `--fail-on-blocked` receives a value -> explicit CLI error and exit `1`.
- Missing `readinessSummary` while `--readiness-summary` or `--fail-on-blocked` is active -> explicit CLI error and exit `1`.

Observable signals:

- stdout remains parseable JSON for exit code `2`.
- stderr remains empty for exit code `2`.
- CLI error cases use the existing `Error: ...` stderr prefix.

## Acceptance Criteria

- `nas-dry-run --fail-on-blocked` exits `2` for current blocked NAS readiness and prints the full sanitized dry-run plan.
- `nas-dry-run --readiness-summary --fail-on-blocked` exits `2` and prints only `readinessSummary`.
- `--fail-on-blocked` rejects a supplied value.
- Existing no-flag behavior remains exit `0`.
- Existing no-flag behavior does not add a new unconditional `readinessSummary` failure path.
- Summary/full stdout still does not leak raw `credentialRef`.
- README, version, Gold readiness evidence, and tests are updated to V0.69.
- Full test suite passes.
