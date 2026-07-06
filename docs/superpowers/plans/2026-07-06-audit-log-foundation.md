# Audit Log Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Linke V0.58 local audit-log foundation with safe JSONL storage, a read-only query API, tests, and Gold-readiness documentation.

**Architecture:** Keep audit logic in `src/audit-log.js` so `src/server.js` only decides when to emit events. Use an allowlist sanitizer before JSONL append. The audit API reads newest events without exposing request bodies, tokens, absolute paths, or NAS endpoint data.

**Tech Stack:** Node.js ESM, built-in `node:test`, `node:fs/promises`, `node:path`, `node:crypto`, existing Linke HTTP server.

## Global Constraints

- Do not read or output `.env`, credentials, SSH keys, cloud auth files, tokens, or passwords.
- Do not store Authorization headers, request bodies, `sourcePath`, `targetPath`, NAS endpoints, or credential-like keys in audit events.
- `GET /api/audit-log` must be read-only and protected by the existing `/api/*` auth gate when bearer auth is configured.
- Audit append failure is best-effort in V0.58 and must not include the event payload in stderr.
- Gold readiness remains blocked; `production-hardening` remains partial.
- Use TDD: add failing tests before production code.

---

### Task 1: Audit Log Module

**Files:**
- Create: `src/audit-log.js`
- Create: `test/audit-log.test.js`

**Interfaces:**
- Produces: `appendAuditEvent(dataDir, event)`
- Produces: `readAuditEvents(dataDir, { limit } = {})`
- Produces: `sanitizeAuditEvent(event, now = new Date())`

- [ ] Add failing tests for sanitize allowlist, append/read newest-first limit, missing file, and concurrent append count.
- [ ] Run `node --test test/audit-log.test.js` and verify RED.
- [ ] Implement `src/audit-log.js` with JSONL append/read and allowlist sanitization.
- [ ] Run `node --test test/audit-log.test.js` and verify GREEN.

### Task 2: Server Audit Events and API

**Files:**
- Modify: `src/server.js`
- Modify: `test/audit-log.test.js`

**Interfaces:**
- Consumes: `appendAuditEvent(dataDir, event)`
- Consumes: `readAuditEvents(dataDir, { limit })`

- [ ] Add failing API tests for `auth.denied`, `GET /api/audit-log`, backup success, restore success, restore 400 failure, and `limit` clamping.
- [ ] Run `node --test test/audit-log.test.js` and verify RED.
- [ ] Import audit helpers in `src/server.js`.
- [ ] Generate one `requestId` per request.
- [ ] Add best-effort `recordAudit()` that logs a generic stderr message on write failure.
- [ ] Add `GET /api/audit-log?limit=N`.
- [ ] Record heartbeat, backup, restore, and auth denied audit events.
- [ ] Run `node --test test/audit-log.test.js test/security.test.js test/restore.test.js` and verify GREEN.

### Task 3: Version, Docs, and Gold Readiness

**Files:**
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `src/web/index.html`
- Modify: `README.md`
- Modify: `test/version.test.js`
- Modify: `test/health.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**
- Consumes: `LINKE_RELEASE_VERSION`
- Consumes: Gold readiness static item evidence list

- [ ] Add failing version/readme/gold tests for V0.58 and audit-log evidence.
- [ ] Run targeted docs/version tests and verify RED.
- [ ] Update version and docs to V0.58.
- [ ] Add `src/audit-log.js` and `GET /api/audit-log` evidence to `production-hardening`.
- [ ] Keep Gold status blocked and `production-hardening` partial.
- [ ] Run targeted docs/version tests and verify GREEN.

### Task 4: Review and Verification

**Files:**
- No new production files unless review requires fixes.

- [ ] Ask Qwen for a short read-only implementation review focused on event schema, sensitive data exclusion, auth behavior, and Gold overclaims.
- [ ] Address blocker findings only; rerun affected tests after any change.
- [ ] Run `npm test`.
- [ ] Run `git diff --check`.
- [ ] Run an HTTP smoke that verifies unauthorized audit event, backup/restore events, `GET /api/audit-log`, and Gold V0.58 blocked summary.
- [ ] Ask ZAI for short English verifier PASS/FAIL from PM-provided evidence.
- [ ] Commit and push with `feat: add audit log foundation`.
