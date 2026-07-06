# Auth Status Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Linke V0.62 read-only `/api/auth-status` with sanitized scope configuration, tests, and Gold-safe documentation.

**Architecture:** Add a pure `buildAuthStatusResponse()` helper in `src/server.js` and expose it through a read-scope `GET /api/auth-status` route. Reuse the existing `/api/*` auth gate so the endpoint is public only in no-token localhost mode and authenticated when any token is configured.

**Tech Stack:** Node.js ESM, built-in `node:test`, existing HTTP server and audit log.

## Global Constraints

- Do not read or output `.env`, credentials, SSH keys, cloud auth files, tokens, or passwords.
- Do not return token values, token prefixes, Authorization headers, environment variable values, request bodies, source paths, target paths, NAS endpoints, or credential-like fields.
- Keep auth disabled by default when no token is configured.
- Keep rate limiting before auth.
- Keep Gold readiness blocked; `security-auth` remains partial.
- Use TDD: add failing tests before production code.

---

### Task 1: Auth Status API Behavior

**Files:**
- Modify: `src/server.js`
- Modify: `test/health.test.js`

**Interfaces:**
- Produces: `buildAuthStatusResponse({ authToken, readToken, writeToken })`
- Adds: `GET /api/auth-status`

- [x] Add failing pure and API tests for auth status schema, no-auth mode, read token success, unknown token 401, token value exclusion, no audit success event, and mutating method 404.
- [x] Run `node --test test/health.test.js` and verify RED.
- [x] Implement `buildAuthStatusResponse()`.
- [x] Add read-scope `GET /api/auth-status` route.
- [x] Run `node --test test/health.test.js test/security.test.js test/audit-log.test.js` and verify GREEN.

### Task 2: Version, Docs, and Gold Evidence

**Files:**
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `src/web/index.html`
- Modify: `README.md`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js`
- Modify: `test/web-console.test.js`

- [x] Add failing docs/version/readiness tests for V0.62 and auth-status evidence.
- [x] Update version and docs to V0.62.
- [x] Add `GET /api/auth-status` and `buildAuthStatusResponse` as `security-auth` evidence.
- [x] Keep Gold status blocked and item statuses unchanged.
- [x] Run targeted docs/version/readiness tests.

### Task 3: Review and Verification

- [x] Ask Qwen for a short read-only implementation review focused on auth status leakage, auth gate behavior, docs overclaims, and compatibility.
- [x] Address blocker findings only.
- [x] Run `npm test`.
- [x] Run `git diff --check`.
- [x] Run HTTP smoke for no-auth status, read-token status, unknown-token 401, token non-leakage, and Gold V0.62 blocked summary.
- [x] Ask ZAI for short English verifier PASS/FAIL.
- [ ] Commit and push with `feat: add auth status readiness api`.
