# API Rate-Limit Foundation Design

## Goal

Add Linke V0.59 optional API rate-limit foundation for local hardening without changing default localhost behavior or claiming Gold readiness.

## Scope

- Add `src/rate-limit.js`.
- Implement an in-memory fixed-window limiter.
- Keep rate limiting disabled by default.
- Allow tests and embedders to pass `createServer({ rateLimit: { maxRequests, windowMs, now } })`.
- Allow standalone server startup to opt in with `LINKE_RATE_LIMIT_PER_MINUTE`.
- Apply the limiter only to `/api` and `/api/*`.
- Run the limiter before bearer auth so repeated unauthenticated requests can be throttled without revealing auth state.
- Return `429` with `{ "error": "Rate limit exceeded" }` when the window is exhausted.
- Record `api.rate_limited` audit events through the existing best-effort audit path.

## Non-Goals

- No distributed limiter.
- No Redis, database, proxy integration, or external dependency.
- No `X-Forwarded-For` trust policy.
- No sliding-window or token-bucket algorithm.
- No production-grade abuse protection claim.
- No Gold-ready claim and no readiness item moves to `ready`.

## Behavior

The client key is `req.socket.remoteAddress` only. The limiter must not read Authorization headers, bearer tokens, request bodies, cookies, query strings, or user-controlled identity fields.

If the request is not `/api` or below `/api/`, it is not rate-limited. Static files and Web Console HTML remain unaffected.

If auth and rate-limit would both reject a request, rate-limit wins and returns 429. The 429 response must not reveal whether a token was absent, invalid, or valid.

`LINKE_RATE_LIMIT_PER_MINUTE` accepts a positive integer. Missing, empty, or `0` means disabled. Any other non-positive or non-integer value is a startup configuration error.

## Tests

- Pure limiter allows up to `maxRequests`, rejects the next request, and resets after `windowMs`.
- Pure limiter keeps different client keys isolated.
- `parseRateLimitPerMinute()` handles disabled and invalid env values.
- Default `createServer()` behavior remains unlimited.
- Enabled server returns 429 after the configured limit.
- 429 occurs before auth and records `api.rate_limited`.
- Non-API paths are not rate-limited.
- README and Gold readiness keep `security-auth` and `production-hardening` partial and Gold blocked.

## Qwen Design Review Conditions

- Document that 429 happens before auth and does not reveal auth state.
- Use only `req.socket.remoteAddress` as the client key.
- Add a non-`/api/` path test.
- Do not change Gold readiness statuses.
