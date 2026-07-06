# Audit Log Agent CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Linke V0.73 Agent CLI `audit-log` command that reads sanitized audit events through existing `GET /api/audit-log`.

**Architecture:** Reuse the existing server endpoint and `request()` helper in `src/agent.js`. Add one CLI command with optional `--limit <n>` query parameter, then update version, README, Gold readiness evidence, and focused tests. Do not change audit event storage, server audit semantics, NAS behavior, auth rules, or production-hardening status.

**Tech Stack:** Node.js ESM, built-in `node --test`, `execFile` CLI integration tests, existing Linke HTTP server test fixture.

## Global Constraints

- Scope is read-only CLI visibility only: no real NAS connection, no remote command, no backup, no restore, no metadata write.
- Reuse `GET /api/audit-log`; do not modify server audit event schema, retention logic, auth gate, or rate limiter behavior.
- `audit-log` output must be JSON from the existing sanitized endpoint and must not print token values, Authorization headers, sourcePath, targetPath, restore root paths, NAS endpoints, or dataDir.
- `--limit` is optional; if provided it must be a positive integer string and is sent as `?limit=<n>`.
- Existing `--token <token>` behavior must work for authenticated read access.
- Gold readiness remains blocked; `production-hardening` remains partial.
- Version source remains `src/version.js`; README, tests, and Gold readiness evidence must match `LINKE_RELEASE_VERSION`.
- Commit/push is allowed for this Linke loop by the user's standing instruction.

---

### Task 1: Agent Audit Log CLI Tests

**Files:**
- Create: `test/agent-audit-log.test.js`

**Interfaces:**
- Consumes: `createServer({ dataDir, readToken, writeToken, authToken })`, existing `GET /api/audit-log`, existing Agent CLI `--token`.
- Produces: failing tests for the missing `audit-log` command and `--limit` validation.

- [x] **Step 1: Add CLI integration tests**

Create tests covering:

```text
agent audit-log prints {"events": []} without mutating an empty dataDir
agent audit-log --limit 1 returns only the newest sanitized event
agent audit-log --token <read-token> can read audit log from an authenticated server
missing token exits 1 and does not print audit event JSON
invalid token exits 1 and does not print supplied token
--limit without a value exits 1
unreachable server exits 1 through existing error handling
```

Use local temp directories and a local HTTP server only. Seed real audit events by sending heartbeat requests to the existing server endpoint where needed; do not write audit files directly except via server behavior already covered by audit tests.

- [x] **Step 2: Verify RED**

Run:

```bash
node --test test/agent-audit-log.test.js
```

Expected: FAIL because `src/agent.js` does not recognize `audit-log` yet.

### Task 2: Agent CLI Implementation

**Files:**
- Modify: `src/agent.js`

**Interfaces:**
- Consumes: existing `parseArgs(argv)`, `request(server, path, method, body, options)`, `requestOptions`.
- Produces: `audit-log` command and `--limit <n>` option in help text.

- [x] **Step 1: Add usage text**

Add `audit-log` to the command list and add `--limit <n>` to options:

```text
audit-log           Show sanitized local audit events
--limit <n>         Limit read-only audit-log events
```

- [x] **Step 2: Add command branch**

Add a `case 'audit-log'` branch:

```js
case 'audit-log': {
  const limitRaw = args.limit;
  let path = '/api/audit-log';
  if (limitRaw !== undefined) {
    if (limitRaw === true) {
      throw new Error('--limit requires a positive integer value');
    }
    if (typeof limitRaw !== 'string' || !/^\d+$/.test(limitRaw) || Number(limitRaw) <= 0) {
      throw new Error('--limit must be a positive integer');
    }
    path += `?limit=${encodeURIComponent(limitRaw)}`;
  }
  const result = await apiRequest(path, 'GET');
  console.log(JSON.stringify(result, null, 2));
  break;
}
```

This branch must not read local files and must not create or mutate metadata.

- [x] **Step 3: Verify GREEN**

Run:

```bash
node --test test/agent-audit-log.test.js
```

Expected: PASS.

### Task 3: Version, README, Gold Evidence

**Files:**
- Modify: `src/version.js`
- Modify: `README.md`
- Modify: `src/gold-readiness.js`
- Modify: `test/version.test.js`
- Modify: `test/readme.test.js`
- Modify: `test/gold-readiness.test.js`

**Interfaces:**
- Consumes: `LINKE_RELEASE_VERSION`, README version table, Gold readiness static scorecard.
- Produces: V0.73 docs and tests for audit-log Agent CLI evidence.

- [x] **Step 1: Add failing docs/version tests**

Update tests to require:

```text
LINKE_RELEASE_VERSION === 'V0.73'
README title and badge use V0.73
README marks V0.72 historical and V0.73 current
README documents agent.js audit-log, GET /api/audit-log, --limit, --token, sanitized output, and no production-grade audit claim
Gold production-hardening evidence includes test/agent-audit-log.test.js and src/agent.js audit-log
```

- [x] **Step 2: Verify docs RED**

Run:

```bash
node --test test/version.test.js test/readme.test.js test/gold-readiness.test.js
```

Expected: FAIL because docs/version remain V0.72.

- [x] **Step 3: Update docs and readiness evidence**

Set `src/version.js` to V0.73. Update README title, badge, version table, feature list, quick-start examples, Gold blocker notes, and testing coverage. Add Gold readiness evidence while keeping `production-hardening.status === 'partial'` and `real-nas-remote-backup.status === 'blocked'`.

- [x] **Step 4: Verify docs GREEN**

Run:

```bash
node --test test/version.test.js test/readme.test.js test/gold-readiness.test.js
```

Expected: PASS.

### Task 4: Final Verification

**Files:**
- No additional production files.

**Interfaces:**
- Consumes: all changed files and existing test suite.
- Produces: commit-ready evidence.

- [x] **Step 1: Run targeted tests**

```bash
node --test test/agent-audit-log.test.js test/audit-log.test.js test/version.test.js test/readme.test.js test/gold-readiness.test.js
```

- [x] **Step 2: Run full suite**

```bash
npm test
```

- [x] **Step 3: Run diff hygiene**

```bash
git diff --check
```

- [x] **Step 4: Run overclaim scan**

```bash
rg -n "生产可用|production ready|真实 NAS 备份已实现|real NAS backup is implemented|production-grade audit" README.md src
```

Expected: no matches for positive production-ready claims. Mentions that production-grade audit is not implemented are allowed only if negative in context.

- [ ] **Step 5: Commit and push**

```bash
git add src/agent.js src/version.js src/gold-readiness.js README.md test/agent-audit-log.test.js test/version.test.js test/readme.test.js test/gold-readiness.test.js docs/superpowers/plans/2026-07-06-audit-log-agent-cli.md
git commit -m "feat: add audit log agent cli"
git push
```

Execution evidence:

- RED: `node --test test/agent-audit-log.test.js` initially failed with unknown `audit-log` command.
- GREEN: `node --test test/agent-audit-log.test.js` passed 7/7.
- Docs/version/Gold: `node --test test/version.test.js test/readme.test.js test/gold-readiness.test.js` passed 317/317.
- Targeted: `node --test test/agent-audit-log.test.js test/audit-log.test.js test/version.test.js test/readme.test.js test/gold-readiness.test.js` passed 337/337.
- Full suite: `npm test` passed 967/967.
- Hygiene: `git diff --check` exited 0.
- Overclaim scan: production-ready/real-NAS-positive scan had no matches; `production-grade audit` mentions were negative boundary or next-step contexts.
