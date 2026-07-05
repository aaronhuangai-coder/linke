# Release Readiness CLI Design

## Goal

Linke V0.50 adds a scriptable release-readiness gate for local release verification. The gate reads the existing `GET /api/health` payload once, evaluates it against the current release expectations, and prints a sanitized JSON readiness report.

## Problem

V0.46 through V0.49 added health reporting, CLI access, a Web Console health panel, and release-version consistency tests. Those pieces prove individual surfaces, but there is not yet one CLI command that can be used as a release gate before declaring a build ready.

## Scope

- Add `src/release-readiness.js` with `buildReleaseReadinessReport(health, options)`.
- Add Agent CLI command:
  - `node src/agent.js release-readiness --server http://localhost:3000`
  - optional `--expected-version <version>` for rolling or external deployment checks.
- The command performs exactly one `GET /api/health` request and prints a JSON report.
- The command exits:
  - `0` when `ready === true`.
  - `2` when the endpoint responded but release readiness failed.
  - `1` for existing request, non-2xx, JSON, or connection errors.
- Update README title, version table, command docs, safety notes, and testing coverage to V0.50.
- Add focused tests for ready, degraded, version mismatch, schema leak, README docs, and version consistency.

## Readiness Rules

The report is ready only when all checks pass:

- Health schema uses only these top-level fields: `status`, `service`, `version`, `checks`, `timestamp`.
- Health `checks` uses only these fields: `http`, `dataDirReadable`.
- `status === "ok"`.
- `service === "linke"`.
- `version === expectedVersion`.
- `checks.http === "ok"`.
- `checks.dataDirReadable === "ok"`.
- `timestamp` is parseable as a date.

The readiness report must not echo the raw health payload. If the health response contains an unexpected field such as `dataDir`, the report may mention the field name but must not print the field value.

## Non-Goals

- No new server routes.
- No change to `agent.js health`; it remains raw health transport output.
- No Web Console change.
- No retries, polling, daemon mode, or watch mode.
- No authentication or production-readiness claim.
- No NAS, backup, restore, sync, delete, remote command, or metadata-write behavior.
- No package publishing or installer work.

## Normal State

When a local Linke server is reachable and `/api/health` reports the current release:

- `release-readiness` exits `0`.
- stdout is parseable JSON.
- `ready` is `true`.
- `expectedVersion` and `actualVersion` match `LINKE_RELEASE_VERSION`.
- The data directory remains unchanged.

## Failure States

When `/api/health` responds with `status:"degraded"`:

- `release-readiness` exits `2`.
- stdout is parseable JSON.
- `ready` is `false`.
- The failed checks include `health.status` and `health.checks.dataDirReadable`.

When `/api/health.version` does not match the expected version:

- `release-readiness` exits `2`.
- stdout is parseable JSON.
- The failed checks include `release.version`.

When the server is unreachable or returns a non-2xx response:

- Existing CLI error handling prints `Error: ...` to stderr.
- Exit code is `1`.

## Safety Boundaries

- Read-only: exactly one `GET /api/health` call.
- No request body.
- No `--device`, `--source`, `--target`, `--snapshot`, or `--config` requirement.
- No local file writes.
- No metadata writes.
- No NAS connection or NAS app invocation.
- No remote command execution.
- No raw health echo, so unexpected path-like values are not reflected to stdout.

## Resilience

- Bounded failure: one HTTP request, no retry loop.
- Recovery anchor: no local state is changed; rerun after fixing server health or expected version.
- Detection signal: exit code plus JSON `ready` and per-check results.

## Qwen Design Review

Qwen returned `DONE_WITH_CONCERNS`. Accepted changes:

- Define `ready:false` exit code as `2`.
- Keep connection/request failures as exit code `1`.
- Add `--expected-version` to make version expectations explicit.
- Replace vague path-leak scanning with a fixed allowed-schema check.
- Document that `health` remains raw transport output and `release-readiness` is the policy gate.

## Acceptance

- Current version becomes `V0.50`.
- `release-readiness` ready path exits `0` and prints sanitized JSON.
- Degraded, version mismatch, and schema-leak paths exit `2` and print sanitized JSON.
- Unreachable server exits non-zero through existing error handling.
- README documents V0.50, command usage, exit codes, and safety boundaries.
- Tests prove the command is read-only and does not echo a leaked path value.
- `npm test` and `git diff --check` pass.
