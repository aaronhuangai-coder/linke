# Release Health CLI Design

## Goal

Add Linke V0.47 `agent.js health` as a read-only command-line check for the V0.46 `GET /api/health` endpoint.

## Scope

- Add a CLI command: `node src/agent.js health --server http://localhost:3000`.
- The command performs one `GET /api/health` request and prints the JSON response.
- Document the command in README and README tests.
- Do not add or change server routes.
- Do not add any NAS, backup, restore, sync, delete, remote command, credential, or metadata behavior.

## Non-Goals

- No authentication.
- No production readiness claim.
- No daemon/watch mode.
- No retries or polling loop.
- No strict failure policy for `status:"degraded"` in V0.47; the command exposes the server health payload and leaves release policy to the caller.

## Normal State

When a Linke server is reachable and its data directory is readable:

- `agent.js health` exits 0.
- stdout is parseable JSON.
- JSON contains `status:"ok"`, `service:"linke"`, `version:"V0.46"`, `checks.http:"ok"`, `checks.dataDirReadable:"ok"`, and `timestamp`.
- The output does not contain local data directory paths.

When the server returns a valid degraded health payload:

- `agent.js health` still exits 0 and prints the JSON payload.
- Callers can inspect `status:"degraded"` and `checks.dataDirReadable:"unavailable"`.
- The exit code means the command successfully reached the health endpoint; it does not mean the service is fully healthy.

When the server is unreachable or returns a non-2xx response:

- Existing CLI error handling prints `Error: ...` to stderr and exits non-zero.

## Safety Boundaries

- The command is read-only.
- It only calls `GET /api/health`.
- It does not send a request body.
- It does not require `--device`, `--source`, `--target`, `--snapshot`, or `--config`.
- It does not create, modify, or delete local data.
- It does not write metadata.
- It does not connect to NAS or invoke NAS applications.
- It does not execute remote commands.
- It does not output `.env`, credentials, tokens, or path-like local dataDir values.

## Resilience

- Bounded failure: one HTTP request, no retry loop.
- Recovery anchor: no local state is changed; a failed command leaves the repository and data directory unchanged.
- Detection signal: exit code plus JSON `status`/`checks` fields.

## Test Plan

- RED test for `agent.js health` command against a real local server.
- Assert stdout is JSON and includes V0.46 health fields.
- Assert stdout does not include the temporary dataDir path.
- Assert the command works without `--device`.
- Assert an unreachable server causes a non-zero CLI exit and stderr error.
- README test for command listing, example, and safety boundaries.
- README test for exit-code semantics: callers must inspect JSON `status`/`checks` for health policy.
- Full suite plus HTTP command smoke.

## Qwen Design Review

- Status: `DONE_WITH_CONCERNS`, not blocking.
- Accepted finding: add an unreachable-server error path test.
- Accepted finding: document that `degraded` still exits 0 and callers should inspect JSON fields.
