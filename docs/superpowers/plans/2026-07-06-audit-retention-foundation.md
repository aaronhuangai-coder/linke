# Audit Retention Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Linke V0.60 optional audit-log retention by event count with tests and Gold-safe documentation.

**Architecture:** Extend `src/audit-log.js` with retention parsing, normalization, and per-file queued append/compact behavior. `src/server.js` passes optional retention config into audit writes and parses `LINKE_AUDIT_MAX_EVENTS` for standalone startup.

**Tech Stack:** Node.js ESM, built-in `node:test`, existing HTTP server and audit log JSONL storage.

## Global Constraints

- Do not read or output `.env`, credentials, SSH keys, cloud auth files, tokens, or passwords.
- Keep retention disabled by default.
- Keep audit events allowlisted; do not add `Authorization`, Bearer tokens, source paths, target paths, NAS endpoints, request bodies, or credential-like fields.
- Keep Gold readiness blocked; `production-hardening` remains partial.
- Use TDD: add failing tests before production code.

---

### Task 1: Audit Retention Module Behavior

**Files:**
- Modify: `src/audit-log.js`
- Modify: `test/audit-log.test.js`

**Interfaces:**
- Produces: `parseAuditRetentionMaxEvents(value)`
- Produces: `normalizeAuditRetention(retention)`
- Extends: `appendAuditEvent(dataDir, event, { retention })`

- [x] Add failing tests for disabled parsing, invalid parsing including `1.5`, `{ maxEvents: 0 }` disabled behavior, default unbounded append, retained newest N events, newest-first read ordering after compaction, and concurrent retained appends.
- [x] Run `node --test test/audit-log.test.js` and verify RED.
- [x] Implement retention parsing, normalization, per-file queue, and append-then-compact behavior.
- [x] Run `node --test test/audit-log.test.js` and verify GREEN.

### Task 2: Server Integration

**Files:**
- Modify: `src/server.js`
- Modify: `test/audit-log.test.js`

**Interfaces:**
- Consumes: `parseAuditRetentionMaxEvents(process.env.LINKE_AUDIT_MAX_EVENTS)`
- Consumes: `appendAuditEvent(dataDir, event, { retention: auditRetention })`
- Extends: `createServer({ auditRetention })`

- [x] Add failing API tests proving server-generated audit events are compacted when `auditRetention` is configured and proving `auditRetention: { maxEvents: 0 }` keeps server behavior unbounded.
- [x] Run `node --test test/audit-log.test.js` and verify RED.
- [x] Add `auditRetention` to `createServer()` options.
- [x] Pass retention into `recordAudit()`.
- [x] Wire standalone `LINKE_AUDIT_MAX_EVENTS`.
- [x] Run `node --test test/audit-log.test.js test/security.test.js test/rate-limit.test.js` and verify GREEN.

### Task 3: Version, Docs, and Gold Readiness

**Files:**
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `src/web/index.html`
- Modify: `README.md`
- Modify: version/readiness/readme tests

- [x] Add failing docs/version tests for V0.60 and audit-retention evidence.
- [x] Update docs and version to V0.60.
- [x] Add `LINKE_AUDIT_MAX_EVENTS` and audit retention evidence to `production-hardening`.
- [x] Keep Gold status blocked and item statuses unchanged.
- [x] Run targeted docs/version/readiness tests.

### Task 4: Review and Verification

- [x] Ask Qwen for short read-only implementation review.
- [x] Address blocker findings only.
- [x] Run `npm test`.
- [x] Run `git diff --check`.
- [x] Run HTTP smoke for retained audit event count, newest ordering, sensitive-field exclusion, and Gold V0.60 blocked summary.
- [x] Ask ZAI for short English verifier PASS/FAIL.
- [x] Commit and push with `feat: add audit retention foundation`.
