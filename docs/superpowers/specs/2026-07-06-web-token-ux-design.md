# V0.54 Web Console In-Memory API Token UX Design

## Goal

Add a minimal Web Console token control for the V0.53 optional Bearer token API skeleton, so browser-triggered `/api/*` requests can include `Authorization: Bearer <token>` during local controlled testing.

## Scope

- Add header-level API Token input, apply button, clear button, status text, and safety note.
- Keep the token only in the current page memory.
- Add Bearer header only for relative `/api` and `/api/*` URLs.
- Clear the in-memory token and input when an API response returns `401`.
- Keep the caller-visible HTTP failure path unchanged.
- Keep Gold readiness status blocked.

## Non-Goals

- No production-grade authorization claim.
- No users, roles, token rotation, audit log, rate limiting, or secret management.
- No token persistence in `localStorage`, `sessionStorage`, cookies, metadata, or config files.
- No real NAS connection or remote backup execution.

## Safety And Resilience

- Failure mode: wrong token returns `401`.
- Expected behavior: Web Console clears token memory and input, shows authentication failure, and the calling panel still handles the non-2xx response.
- Observable signal: token status text and existing panel error message.
- Recovery anchor: user re-enters a valid token in the page header.

## Acceptance

- DOM tests cover apply, clear, 401 clearing, no-token behavior, and no browser persistence.
- Helper tests cover relative API URL scoping and POST header preservation.
- README and Gold readiness describe this as partial auth only.
