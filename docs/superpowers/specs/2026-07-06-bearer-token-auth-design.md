# V0.53 Optional Bearer Token Auth Skeleton Design

## Goal

Add a small, optional API authentication skeleton that moves `security-auth` from `blocked` to `partial` without claiming production-grade authorization.

## Scope

- Server accepts an optional `authToken`.
- Standalone server reads `LINKE_AUTH_TOKEN` and the compatibility fallback `LINKE_TOKEN`.
- When a non-empty token is configured, requests to `/api` and `/api/*` must include `Authorization: Bearer <token>`.
- Missing, malformed, or wrong tokens return `401` JSON before route handlers run.
- Agent CLI accepts `--token <token>` and forwards it as a Bearer header.
- README and Gold readiness scorecard document this as partial auth only.

## Non-Goals

- No users, roles, sessions, login UI, token storage, token rotation, rate limiting, audit trail, or secret management.
- No Web Console token-entry UX in this version.
- No production-readiness claim.
- No real NAS connection or remote backup execution.

## Runtime Behavior

- Default behavior remains compatible with the existing localhost prototype when no token is configured.
- Whitespace-only tokens fail fast.
- Token comparison uses `crypto.timingSafeEqual` after length checking.
- Static Web Console assets are not the auth target in this slice; the API is. With auth enabled, Web Console API calls fail until a later Web token UX exists.

## Resilience And Safety

- Normal state: API requests either pass auth and reach existing handlers, or fail closed with `401`.
- Recovery anchor: unsetting the token returns the app to V0.x localhost prototype behavior.
- Failure signal: wrong or missing token returns `{ "error": "Unauthorized" }`.
- Known remaining risks: no request body size limit, no role-based authorization, no token rotation, and no Web token UX.

## Review Notes

Qwen initial adversarial review rejected a host-binding guard as low value and recommended a minimal token auth skeleton instead. Qwen re-review found no blockers after `/api` exact path protection, POST auth tests, whitespace token fail-fast, and `timingSafeEqual` were added. ZAI final auxiliary verification returned `PASS`.
