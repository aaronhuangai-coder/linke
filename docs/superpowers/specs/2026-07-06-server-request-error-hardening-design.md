# V0.55 Server Request/Error Hardening Design

## Goal

Add bounded request-body handling and sanitized unexpected 500 responses for the Linke localhost prototype without changing intentional 4xx API behavior.

## Scope

- Limit JSON request bodies to 1 MiB while reading chunks.
- Return `413` with `Request body too large` before any route-level mutation when the limit is exceeded.
- Preserve specific intentional 4xx messages marked with `statusCode`.
- Sanitize unexpected 500 responses to `Internal Server Error`.
- Keep local server logs useful for debugging.
- Update Gold readiness so `production-hardening` becomes partial, while Gold remains blocked.

## Non-Goals

- No full production hardening claim.
- No rate limiting, WAF, auth roles, token rotation, audit log, metrics, monitoring, supervisor, or recovery automation.
- No change to real NAS remote backup execution.

## Safety And Resilience

- Failure mode: oversized JSON body.
- Expected behavior: fail before business handler writes metadata.
- Observable signal: HTTP `413` and JSON `{ "error": "Request body too large" }`.
- Recovery anchor: retry with a body at or below 1 MiB.

## Acceptance

- Oversized JSON body returns 413 and does not mutate dataDir.
- Near-limit JSON body still works.
- Invalid JSON remains 400 with `Invalid JSON body`.
- Missing required field remains a specific 400.
- Unexpected restore failure returns 500 with `Internal Server Error` and no internal detail.
- README, version, tests, and Gold readiness are aligned.
