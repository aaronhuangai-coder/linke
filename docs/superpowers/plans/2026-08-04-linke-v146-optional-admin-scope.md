# Linke V1.46 Optional Admin Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a backward-compatible optional admin bearer-token scope for the two device-administration POST routes.

**Architecture:** Extend the existing centralized bearer-token gate in `src/server.js` with one normalized admin credential and an exact two-route admin classifier. Preserve the current write-token contract when admin is absent, but require full/admin authority before body parsing and write admission when admin is present; expose configuration only as sanitized booleans.

**Tech Stack:** Node.js ESM, built-in HTTP server, `node:test`, strict assertions, filesystem-backed audit fixtures.

## Global Constraints

- Base source checkpoint is `efb8cb6`; source recovery checkpoint before the spec is `54c428d`.
- Only modify `src/server.js`, `test/security.test.js`, `test/health.test.js`, and `test/agent-auth-status.test.js` during implementation.
- Do not modify version, README, Gold matrix, installation state, package files, untracked user files, or credential files.
- Do not read `.env*`, `secrets/`, `credentials/`, SSH, cloud-auth, or provider-auth files.
- `adminToken` is optional; the standalone environment name is exactly `LINKE_ADMIN_TOKEN`.
- With no admin token, full/current-write/previous-write remain admin-capable for compatibility.
- With an admin token, only full/admin may access the two exact device-administration POST routes.
- Admin/full are the broadest scopes; valid insufficient credentials return 403 before body parsing, write admission, or service calls.
- Status may expose only `configuredScopes.admin` and `configuredAuthScopes.admin` booleans, never token material.
- Security-auth remains partial; no Gold/GA/deployment claim is allowed.

---

### Task 1: Optional Admin Scope Contract

**Files:**
- Modify: `src/server.js`
- Test: `test/security.test.js`
- Test: `test/health.test.js`
- Test: `test/agent-auth-status.test.js`

**Interfaces:**
- Consumes: existing `createServer(options)`, `buildAuthStatusResponse(options)`, `buildHardeningStatusResponse(options)`, `API_WRITE_ROUTES`, `authTokensMatch(actual, expected)`, and device-administration routes.
- Produces: optional `adminToken` option on the three server/status builders; standalone `LINKE_ADMIN_TOKEN` wiring; sanitized `admin` booleans in both scope status objects.

- [ ] **Step 1: Add behavior-specific failing status and validation tests**

In `test/health.test.js`, update every exact `configuredScopes` and
`configuredAuthScopes` expectation to include `admin: false`, then add direct
builder cases equivalent to:

```js
const auth = buildAuthStatusResponse({ adminToken: 'admin-status-secret' });
assert.strictEqual(auth.auth.enabled, true);
assert.deepStrictEqual(auth.auth.configuredScopes, {
  full: false,
  read: false,
  write: false,
  admin: true,
});
assert.doesNotMatch(JSON.stringify(auth), /admin-status-secret/);

const hardening = buildHardeningStatusResponse({ adminToken: 'admin-hardening-secret' });
assert.strictEqual(hardening.hardening.authConfigured, true);
assert.deepStrictEqual(hardening.hardening.configuredAuthScopes, {
  full: false,
  read: false,
  write: false,
  admin: true,
});
assert.doesNotMatch(JSON.stringify(hardening), /admin-hardening-secret/);
```

In `test/agent-auth-status.test.js`, update exact scope objects with
`admin: false`, and add an admin-only server case proving the CLI can fetch
`auth-status` with the admin token while stdout contains neither the credential
nor `Bearer`.

In `test/security.test.js`, add construction assertions:

```js
assert.throws(
  () => createServer({ dataDir, adminToken: '   ' }),
  /adminToken must be a non-empty string/,
);
assert.throws(
  () => createServer({ dataDir, adminToken: 42 }),
  /adminToken must be a string/,
);
```

- [ ] **Step 2: Run the focused tests and capture a valid RED**

Run:

```bash
node --test test/security.test.js test/health.test.js test/agent-auth-status.test.js
```

Expected: FAIL because the current production code ignores `adminToken`, does
not report the admin scope, and does not reject invalid admin-token inputs. A
syntax/import/fixture failure is not a valid RED.

- [ ] **Step 3: Add real HTTP authorization-boundary tests**

Use existing temporary data directories, real loopback listeners, audit readers,
and a device-administration spy. Cover all of these contracts:

```js
// admin configured: current and previous write are valid credentials but not admin
const deniedOptions = {
  adminToken: 'admin-current',
  writeToken: 'write-current',
  previousWriteToken: 'write-previous',
  deviceAdministration,
};
// For both exact admin routes, current/previous write => 403 Forbidden,
// auth.forbidden audit, and zero issueEnrollment/revokeDevice calls.

// Send malformed JSON with previous-write to one admin route and assert 403,
// proving the gate runs before body parsing (not a later 400).

// admin/full => existing success status on both admin routes.
// admin => GET /api/devices succeeds and POST /api/heartbeat succeeds.
// admin absent => write and previous-write retain existing admin-route access.
// shared admin/write value => broadest admin scope wins.
```

Every denial test must assert audit records contain none of the configured token
values. Keep existing device validation and service-error behavior unchanged.

- [ ] **Step 4: Implement the minimal centralized scope gate**

In `src/server.js`:

1. Add `normalizeAdminToken(adminToken)` matching existing token validation and
   using admin-specific error messages.
2. Add an exact internal classifier for only:

```js
POST /api/device-enrollment-codes
POST /api/device-revoke
```

3. Accept and normalize `adminToken` in `createServer()`. Include it in
   `hasAuth` and `adminAuthConfigured`.
4. During bearer matching, calculate `matchesAuth`, `matchesAdmin`,
   `matchesWrite`, `matchesPreviousWrite`, `matchesRead`, and
   `matchesPreviousRead`. Full/admin set both write and admin authority. Write
   credentials set admin authority only when no admin token is configured.
5. After 401 handling and before existing write-scope/body/write-admission work,
   return audited 403 when an exact admin route is requested without admin
   authority.
6. Accept `adminToken` in both status builders. Add only boolean `admin` fields,
   count admin-only as authentication enabled/configured, and keep token values
   absent.
7. Read `process.env.LINKE_ADMIN_TOKEN` in the standalone entry, pass it to
   `createServer()`, and include its presence in the generic auth-enabled log
   condition without printing it.

Keep the authorization logic centralized; do not add credential persistence,
dynamic APIs, previous-admin overlap, or route-handler-specific token parsing.

- [ ] **Step 5: Run focused GREEN and security source scans**

Run:

```bash
node --test test/security.test.js test/health.test.js test/agent-auth-status.test.js
rg -n "LINKE_ADMIN_TOKEN|adminToken|configuredScopes|configuredAuthScopes" src/server.js test/security.test.js test/health.test.js test/agent-auth-status.test.js
rg -n "rotat" src/server.js
git diff --check
```

Expected: all focused tests pass; admin wiring is present only in the allowed
files; the last `rg` returns no matches because V1.43 source vocabulary guards
forbid `rotat` in `src/server.js`; whitespace check passes.

- [ ] **Step 6: Rebuild valid old-HEAD RED evidence**

Codex verifier creates a detached copy of `efb8cb6`, applies only the three test
file diffs, and runs the focused command. Expected: behavior-specific failures
for missing admin validation/status/authorization, not setup noise. Then apply
`src/server.js` and rerun to prove GREEN.

- [ ] **Step 7: Run full regression and highest-risk resilience drill**

Run:

```bash
npm test
node --test --test-name-pattern="admin scope rejects current and previous write" test/security.test.js
```

The named focused loopback test must configure admin + current/previous write
and prove previous-write receives 403, emits `auth.forbidden`, and never calls
the administration service. Expected: zero failures other than pre-existing
explicit skips; no installation, launchctl, production, email, or external
write occurs.

- [ ] **Step 8: Verify scope and hand off for independent review**

Run:

```bash
git diff --stat
git diff --check
git status --short
```

Expected: implementation changes are a subset of the four allowed files.
`package-lock.json`, `.superpowers/`, and pre-existing untracked plan/spec files
remain untouched and uncommitted. Grok implementer returns its required final
schema; a fresh reviewer inspects the complete diff; Codex independently decides
whether the change is a complete candidate.

- [ ] **Step 9: Commit only after verification**

Codex host, not the worker, stages the exact four allowed implementation files
and uses:

```bash
git commit -m "feat: add optional admin token scope"
```

Push only the verified branch. Do not include unrelated or pre-existing
untracked files.
