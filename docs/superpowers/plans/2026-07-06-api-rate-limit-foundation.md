# API Rate-Limit Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Linke V0.59 optional in-memory API rate limiting with tested 429 behavior and Gold-safe documentation.

**Architecture:** Put rate-limit state and parsing in `src/rate-limit.js`. `src/server.js` creates one limiter per server instance and checks `/api/*` requests before bearer auth. Audit logging records `api.rate_limited` without reading tokens or request bodies.

**Tech Stack:** Node.js ESM, built-in `node:test`, existing HTTP server and audit log.

## Global Constraints

- Do not read or output `.env`, credentials, SSH keys, cloud auth files, tokens, or passwords.
- Do not read Authorization headers or request bodies to compute rate-limit keys.
- Client key must be `req.socket.remoteAddress` only.
- Non-API paths must not be rate-limited.
- Gold readiness remains blocked; `security-auth` and `production-hardening` remain partial.
- Use TDD: add failing tests before production code.

---

### Task 1: Rate-Limit Module

**Files:**
- Create: `src/rate-limit.js`
- Create: `test/rate-limit.test.js`

**Interfaces:**
- Produces: `createFixedWindowRateLimiter(config)`
- Produces: `normalizeRateLimitConfig(rateLimit)`
- Produces: `parseRateLimitPerMinute(value)`

- [x] Add failing pure tests for allow/reject/reset, key isolation, disabled config, and invalid env parsing.
- [x] Run `node --test test/rate-limit.test.js` and verify RED.
- [x] Implement `src/rate-limit.js`.
- [x] Run `node --test test/rate-limit.test.js` and verify GREEN for pure tests.

### Task 2: Server Integration

**Files:**
- Modify: `src/server.js`
- Modify: `test/rate-limit.test.js`

**Interfaces:**
- Consumes: `createFixedWindowRateLimiter(rateLimit)`
- Consumes: `parseRateLimitPerMinute(process.env.LINKE_RATE_LIMIT_PER_MINUTE)`

- [x] Add failing API tests for default disabled behavior, enabled 429, window reset, auth-before/after ordering, non-API bypass, and `api.rate_limited` audit event.
- [x] Run `node --test test/rate-limit.test.js` and verify RED.
- [x] Add `rateLimit` to `createServer()` options.
- [x] Check limiter before bearer auth for `/api` and `/api/*`.
- [x] Return 429 `{ error: 'Rate limit exceeded' }`.
- [x] Record `api.rate_limited` with method/path/status/outcome/requestId only.
- [x] Wire standalone `LINKE_RATE_LIMIT_PER_MINUTE`.
- [x] Run `node --test test/rate-limit.test.js test/audit-log.test.js test/security.test.js` and verify GREEN.

### Task 3: Version, Docs, and Gold Readiness

**Files:**
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `src/web/index.html`
- Modify: `README.md`
- Modify: version/readiness/readme tests

- [x] Add failing docs/version tests for V0.59 and rate-limit evidence.
- [x] Update docs and version to V0.59.
- [x] Add `src/rate-limit.js`, `LINKE_RATE_LIMIT_PER_MINUTE`, `429 Rate limit exceeded`, and `test/rate-limit.test.js` as partial evidence.
- [x] Keep Gold status blocked and item statuses unchanged.
- [x] Run targeted docs/version/readiness tests.

### Task 4: Review and Verification

- [x] Ask Qwen for short read-only implementation review.
- [x] Address blocker findings only.
- [x] Run `npm test`.
- [x] Run `git diff --check`.
- [x] Run HTTP smoke for 429-before-auth, window reset, audit event, non-API bypass, and Gold V0.59 blocked summary.
- [x] Ask ZAI for short English verifier PASS/FAIL.
- [x] Commit and push with `feat: add api rate limit foundation`.
