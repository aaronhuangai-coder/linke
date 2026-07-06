# Write Route Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Linke V0.63 shared write-route registry so auth enforcement and `/api/auth-status` cannot drift.

**Architecture:** Export `API_WRITE_ROUTES`, `formatApiRoute()`, and `isApiWriteRoute()` from `src/server.js`. The auth gate and `buildAuthStatusResponse()` both use these helpers.

**Tech Stack:** Node.js ESM, built-in `node:test`, existing HTTP server.

## Global Constraints

- Do not read or output `.env`, credentials, SSH keys, cloud auth files, tokens, or passwords.
- Do not return token values, token prefixes, Authorization headers, environment variable values, request bodies, source paths, target paths, NAS endpoints, or credential-like fields.
- Keep existing write route semantics unchanged.
- Keep rate limiting before auth.
- Keep Gold readiness blocked; `security-auth` remains partial.
- Use TDD: add failing tests before production code.

---

### Task 1: RED Tests

**Files:**
- Modify: `test/health.test.js`
- Modify: `test/security.test.js`

- [x] Import `API_WRITE_ROUTES`, `formatApiRoute`, and `isApiWriteRoute`.
- [x] Add failing pure tests for registry contents, `API_WRITE_ROUTES.length === 3`, and route formatting.
- [x] Update auth-status tests to compare `writeRoutes` with `API_WRITE_ROUTES.map(formatApiRoute)`.
- [x] Add read-token denial regression coverage for every `API_WRITE_ROUTES` item, with each route asserting `403 Forbidden`, no route-specific mutation, and `auth.forbidden` audit evidence.
- [x] Run `node --test test/health.test.js test/security.test.js` and verify RED.

### Task 2: Implementation

**Files:**
- Modify: `src/server.js`

- [x] Export `API_WRITE_ROUTES`.
- [x] Export `formatApiRoute(route)`.
- [x] Export `isApiWriteRoute(method, pathname)`.
- [x] Use `API_WRITE_ROUTES.map(formatApiRoute)` in `buildAuthStatusResponse()`.
- [x] Use `isApiWriteRoute(method, pathname)` in the auth gate.
- [x] Remove the old inline `isWriteRoute` conditional from the auth gate so the registry is the only write-route source.
- [x] Run `node --test test/health.test.js test/security.test.js test/audit-log.test.js` and verify GREEN.

### Task 3: Version and Docs

**Files:**
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `README.md`
- Modify: `src/web/index.html`
- Modify: version/docs tests as needed

- [x] Move current version to V0.63.
- [x] Document shared write-route registry as a foundation, not production-grade authorization.
- [x] Add registry as foundation evidence to Gold `security-auth` while keeping `security-auth` partial and Gold blocked.
- [x] Run targeted docs/version/readiness tests.

### Task 4: Review and Verification

- [x] Ask Qwen for read-only review focused on registry drift, route semantics, docs overclaims, and auth compatibility.
- [x] Address blockers. Qwen reported no blockers; PM accepted the maintenance-only comment/JSDoc suggestion.
- [x] Run `npm test` (`813` pass, `0` fail).
- [x] Run `git diff --check` (exit `0`).
- [x] Run HTTP smoke for read-token 403 over all registry write routes and auth-status route list.
- [x] Ask ZAI for short English verifier PASS/FAIL (`PASS`, no blockers).
- [x] Commit and push with `feat: add shared write route registry`.
