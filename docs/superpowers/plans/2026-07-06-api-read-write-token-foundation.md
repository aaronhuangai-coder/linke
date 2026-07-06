# API Read/Write Token Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Linke V0.61 optional read/write Bearer token authorization with tested 403 behavior and Gold-safe documentation.

**Architecture:** Extend `src/server.js` auth handling from a single boolean token check to a scoped decision that supports full, write, read, denied, and forbidden outcomes. Keep scope classification in the server route layer and preserve the existing single-token Web Console UX as an in-memory bearer input.

**Tech Stack:** Node.js ESM, built-in `node:test`, existing HTTP server, audit log, and README/Gold readiness tests.

## Global Constraints

- Do not read or output `.env`, credentials, SSH keys, cloud auth files, tokens, or passwords.
- Use fake token strings only in tests and examples.
- Keep auth disabled by default when no token is configured.
- Keep rate limiting before auth.
- Do not store Authorization headers, Bearer tokens, token prefixes, request bodies, source paths, target paths, NAS endpoints, or credential-like fields in audit events.
- Keep Gold readiness blocked; `security-auth` remains partial.
- Use TDD: add failing tests before production code.

---

### Task 1: Scoped API Auth Behavior

**Files:**
- Modify: `src/server.js`
- Modify: `test/security.test.js`

**Interfaces:**
- Extends: `createServer({ authToken, readToken, writeToken })`
- Produces: scoped auth decisions for `read` and `write` API routes
- Emits: `auth.denied` and `auth.forbidden` audit events without token data

- [x] Add failing tests for read token read success, read token write forbidden/no mutation, forbidden audit event, write token read/write success, unknown token denied, no-token compatibility, and overlapping read/write broadest-scope behavior.
- [x] Run `node --test test/security.test.js` and verify RED.
- [x] Implement scoped auth normalization and decision logic in `src/server.js`.
- [x] Classify `POST /api/heartbeat`, `POST /api/backups`, and `POST /api/restore` as write scope.
- [x] Keep all other current API routes read scope.
- [x] Run `node --test test/security.test.js test/audit-log.test.js test/rate-limit.test.js` and verify GREEN.

### Task 2: Version, Docs, and Gold Evidence

**Files:**
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `src/web/index.html`
- Modify: `README.md`
- Modify: `test/version.test.js`
- Modify: `test/readme.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/web-console.test.js`

- [x] Add failing docs/version/readiness tests for V0.61 and read/write token evidence.
- [x] Update version and docs to V0.61.
- [x] Add `LINKE_READ_TOKEN`, `LINKE_WRITE_TOKEN`, `403 Forbidden`, and `auth.forbidden` as `security-auth` evidence.
- [x] Keep Gold status blocked and item statuses unchanged.
- [x] Run targeted docs/version/readiness tests.

### Task 3: Review and Verification

- [x] Ask Qwen for a short read-only implementation review focused on scoped auth, audit semantics, docs overclaims, and compatibility.
- [x] Address blocker findings only.
- [x] Run `npm test`.
- [x] Run `git diff --check`.
- [x] Run HTTP smoke for read token read success, read token write 403/no mutation, write token write success, unknown token 401, and Gold V0.61 blocked summary.
- [x] Ask ZAI for short English verifier PASS/FAIL.
- [x] Commit and push with `feat: add api read write token foundation`.
