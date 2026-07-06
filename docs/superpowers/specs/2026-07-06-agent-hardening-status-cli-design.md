# Agent Hardening Status CLI Design

Linke V0.71 adds a read-only Agent CLI command for the existing `GET /api/hardening-status` endpoint. The command gives operators and scripts the same sanitized hardening visibility that V0.70 exposed over HTTP, without requiring a browser or raw `curl` command.

## Scope

Add one command:

```bash
node src/agent.js hardening-status --server http://localhost:3000
node src/agent.js hardening-status --server http://localhost:3000 --token dev-read-token
```

The command performs a single GET request to `/api/hardening-status`, prints the server JSON response with two-space formatting, and exits `0` when the HTTP request succeeds. Request failures keep the existing Agent CLI behavior: print `Error: ...` to stderr and exit `1`.

## Non-Goals

- Do not add a hardening readiness gate or new non-zero exit semantics in V0.71.
- Do not change `GET /api/hardening-status` response shape.
- Do not change Web Console fetch behavior, controls, or startup requests; a Gold safety-note text update is allowed.
- Do not enable real NAS transfer, remote commands, credential lookup, token storage, token display, monitoring, deployment hardening, or audit tamper protection.
- Do not mark Gold as unblocked.

## Architecture

`src/agent.js` already has a shared `request()` helper, `--server`, and `--token` handling. V0.71 should add a `hardening-status` command branch that reuses those pieces and mirrors the direct JSON output style of `health`.

Docs and evidence updates should bump the release marker to V0.71 and add the CLI command as additional `production-hardening` evidence while keeping that scorecard item `partial`.

## Normal State

Normal state is:

- `node src/agent.js hardening-status --server <url>` sends exactly one read-only GET request.
- stdout is valid JSON with `status:"partial"`, `service:"linke"`, `version:LINKE_RELEASE_VERSION`, `hardening`, and `safety`.
- stdout does not include token values, Authorization headers, data directory paths, restore root paths, audit paths, or environment values.
- The command does not mutate `dataDir` in no-token mode or when a read token succeeds.

## Recovery Anchor

If the CLI command fails, the operator can use the existing HTTP endpoint directly:

```bash
curl http://localhost:3000/api/hardening-status
```

The V0.70 endpoint remains the source of truth. V0.71 only adds a CLI transport wrapper.

## Bounded Failure Strategy

- Unreachable server: existing CLI catch block prints an error and exits `1`.
- Auth missing or invalid: server returns `401`; the CLI prints `Error: Unauthorized` and exits `1`.
- `--token` without a value: existing Agent guard prints `Error: --token requires a value` and exits `1`.
- Endpoint schema remains owned by `buildHardeningStatusResponse()` tests; the CLI does not reinterpret the response.

## Runtime Detection And Self-Check

Tests cover:

- unauthenticated localhost command prints sanitized JSON and does not mutate `dataDir`;
- read-token command passes Bearer auth, prints sanitized JSON, and creates no success audit event;
- missing or invalid auth exits non-zero without printing hardening fields;
- unreachable server exits non-zero through existing error handling;
- README/version/Gold tests document V0.71 while preserving partial/blocked status.
- Web Console tests only verify updated Gold safety-note copy; V0.71 adds no new Web request behavior.

## Completion Criteria

- `test/agent-hardening-status.test.js` covers the new command.
- `src/agent.js` documents and implements `hardening-status`.
- `src/version.js` is bumped to `V0.71`.
- README current version, version table, CLI examples, endpoint capability summary, testing coverage, and Gold boundary text mention V0.71.
- `src/gold-readiness.js` includes `test/agent-hardening-status.test.js` and `src/agent.js hardening-status` evidence for `production-hardening`, while status remains `partial`.
- `src/web/index.html` Gold safety note may mention the V0.71 CLI wrapper, but `src/web/app.js` must not add a new fetch or button.
- Targeted tests and full `npm test` pass.
