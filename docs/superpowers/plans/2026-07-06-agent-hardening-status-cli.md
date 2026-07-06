# Agent Hardening Status CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Linke V0.71 with `node src/agent.js hardening-status`, a read-only CLI wrapper over `GET /api/hardening-status`.

**Architecture:** Reuse the existing Agent CLI `request()` helper, `--server`, and `--token` plumbing. Add one command branch that prints the endpoint response unchanged as formatted JSON; keep all hardening policy and sanitization inside the existing server endpoint and tests.

**Tech Stack:** Node.js ESM, `node:test`, built-in `fetch`, existing Linke server test helpers.

## Global Constraints

- `hardening-status` must be read-only and must only call `GET /api/hardening-status`.
- Do not change the response shape of `buildHardeningStatusResponse()`.
- Do not add a new readiness/fail gate in V0.71.
- Do not read, print, store, or derive secrets, `.env` values, token values, Authorization headers, restore root paths, audit paths, or environment values.
- Keep `production-hardening` status `partial`.
- Keep `real-nas-remote-backup` status `blocked`.
- Do not connect to a real NAS, run remote commands, or write remote data.
- Worker must not commit or push; PM performs git operations after verification.

---

## File Structure

- Create `test/agent-hardening-status.test.js`: CLI contract tests for the new command and auth behavior.
- Modify `src/agent.js`: usage text and command switch for `hardening-status`.
- Modify `src/version.js`: bump `LINKE_RELEASE_VERSION` to `V0.71`.
- Modify `README.md`: current version, version table, capability bullets, command examples, API/testing coverage, Gold boundary text.
- Modify `src/web/index.html`: update the Gold safety-note text only; do not add controls or fetch behavior.
- Modify `test/web-console.test.js`: keep the safety-note assertion aligned with V0.71 wording.
- Modify `src/gold-readiness.js`: add CLI evidence for production-hardening while keeping `partial`.
- Modify `test/version.test.js`, `test/gold-readiness.test.js`, `test/readme.test.js`, `test/web-console.test.js`: V0.71 expectations and evidence coverage.

## Task 1: Agent CLI Contract Tests

**Files:**
- Create: `test/agent-hardening-status.test.js`

**Interfaces:**
- Consumes: `createServer({ dataDir, readToken, writeToken, restoreRoot, rateLimit, auditRetention })` from `src/server.js`.
- Consumes: `readAuditEvents(dataDir)` from `src/audit-log.js`.
- Produces: failing tests for `node src/agent.js hardening-status`.

- [ ] **Step 1: Write the failing test file**

Create `test/agent-hardening-status.test.js` with:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  API_WRITE_ROUTES,
  MAX_JSON_BODY_BYTES,
  createServer,
  formatApiRoute,
} from '../src/server.js';
import { readAuditEvents } from '../src/audit-log.js';
import { LINKE_RELEASE_VERSION } from '../src/version.js';

const exec = promisify(execFile);
const agentPath = join(import.meta.dirname, '..', 'src', 'agent.js');

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function runAgent(args) {
  return exec('node', [agentPath, ...args]);
}

async function rejectAgent(args, expectedCode) {
  try {
    await runAgent(args);
  } catch (err) {
    assert.strictEqual(err.code, expectedCode);
    return err;
  }
  assert.fail(`Expected agent command to exit ${expectedCode}`);
}

describe('Agent hardening-status CLI', () => {
  it('prints sanitized hardening JSON without mutating dataDir in no-token mode', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-hardening-open-'));
    const server = createServer({ dataDir });
    const port = await listen(server);

    try {
      assert.deepStrictEqual(await readdir(dataDir), []);
      const { stdout } = await runAgent([
        'hardening-status',
        '--server',
        `http://127.0.0.1:${port}`,
      ]);
      const body = JSON.parse(stdout);

      assert.strictEqual(body.status, 'partial');
      assert.strictEqual(body.service, 'linke');
      assert.strictEqual(body.version, LINKE_RELEASE_VERSION);
      assert.strictEqual(body.hardening.authConfigured, false);
      assert.strictEqual(body.hardening.scopedTokensConfigured, false);
      assert.strictEqual(body.hardening.rateLimitConfigured, false);
      assert.strictEqual(body.hardening.auditRetentionConfigured, false);
      assert.strictEqual(body.hardening.restoreRootConfigured, false);
      assert.strictEqual(body.hardening.requestBodyLimitBytes, MAX_JSON_BODY_BYTES);
      assert.deepStrictEqual(body.hardening.writeRoutes, API_WRITE_ROUTES.map(formatApiRoute));
      assert.strictEqual(body.safety.tokenValuesReturned, false);
      assert.strictEqual(body.safety.restoreRootValueReturned, false);
      assert.strictEqual(body.safety.auditPathReturned, false);
      assert.strictEqual(body.safety.environmentValuesReturned, false);
      assert.strictEqual(body.safety.successAuditEvent, false);
      assert.ok(!stdout.includes(dataDir));
      assert.deepStrictEqual(await readdir(dataDir), []);
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('passes --token as bearer auth and does not print token or restoreRoot material', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-hardening-auth-'));
    const restoreRoot = await mkdtemp(join(tmpdir(), 'linke-agent-hardening-root-'));
    const server = createServer({
      dataDir,
      readToken: 'hardening-read-token',
      writeToken: 'hardening-write-token',
      restoreRoot,
      rateLimit: { maxRequests: 5, windowMs: 60000 },
      auditRetention: { maxEvents: 5 },
    });
    const port = await listen(server);

    try {
      const { stdout } = await runAgent([
        'hardening-status',
        '--server',
        `http://127.0.0.1:${port}`,
        '--token',
        'hardening-read-token',
      ]);
      const body = JSON.parse(stdout);

      assert.strictEqual(body.hardening.authConfigured, true);
      assert.deepStrictEqual(body.hardening.configuredAuthScopes, {
        full: false,
        read: true,
        write: true,
      });
      assert.strictEqual(body.hardening.rateLimitConfigured, true);
      assert.strictEqual(body.hardening.auditRetentionConfigured, true);
      assert.strictEqual(body.hardening.restoreRootConfigured, true);
      assert.doesNotMatch(stdout, /hardening-read-token|hardening-write-token|Bearer/);
      assert.ok(!stdout.includes(restoreRoot));
      assert.deepStrictEqual(await readAuditEvents(dataDir), []);
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
      await rm(restoreRoot, { recursive: true, force: true });
    }
  });

  it('exits 1 when auth is required and no token is provided', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-hardening-missing-auth-'));
    const server = createServer({ dataDir, readToken: 'hardening-read-token' });
    const port = await listen(server);

    try {
      const err = await rejectAgent([
        'hardening-status',
        '--server',
        `http://127.0.0.1:${port}`,
      ], 1);

      assert.match(err.stderr, /Unauthorized/);
      assert.doesNotMatch(err.stdout, /hardening|configuredAuthScopes|hardening-read-token/);
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('exits 1 when an invalid token is provided', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-hardening-invalid-auth-'));
    const server = createServer({ dataDir, readToken: 'hardening-read-token' });
    const port = await listen(server);

    try {
      const err = await rejectAgent([
        'hardening-status',
        '--server',
        `http://127.0.0.1:${port}`,
        '--token',
        'wrong-hardening-token',
      ], 1);

      assert.match(err.stderr, /Unauthorized/);
      assert.doesNotMatch(err.stdout, /hardening|configuredAuthScopes|hardening-read-token|wrong-hardening-token/);
    } finally {
      await close(server);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('exits 1 through existing error handling when the server is unreachable', async () => {
    const err = await rejectAgent([
      'hardening-status',
      '--server',
      'http://127.0.0.1:1',
    ], 1);

    assert.match(err.stderr, /Error:/);
  });
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run:

```bash
node --test test/agent-hardening-status.test.js
```

Expected: FAIL because `hardening-status` is still an unknown command.

## Task 2: Agent CLI Implementation

**Files:**
- Modify: `src/agent.js`
- Test: `test/agent-hardening-status.test.js`

**Interfaces:**
- Consumes: `apiRequest(path, method, body)`.
- Produces: `hardening-status` Agent command.

- [ ] **Step 1: Update CLI command documentation**

In the top command list and `printUsage()` command list, add:

```text
  hardening-status  Show sanitized hardening status
```

- [ ] **Step 2: Add the command branch**

Add this switch case near `health` and `release-readiness`:

```javascript
      case 'hardening-status': {
        const result = await apiRequest('/api/hardening-status', 'GET');
        console.log(JSON.stringify(result, null, 2));
        break;
      }
```

- [ ] **Step 3: Run the CLI test and confirm GREEN**

Run:

```bash
node --test test/agent-hardening-status.test.js
```

Expected: PASS.

## Task 3: Version, Gold Evidence, And Docs

**Files:**
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `src/web/index.html`
- Modify: `README.md`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js`
- Modify: `test/web-console.test.js`

**Interfaces:**
- Consumes: V0.71 CLI behavior from Task 2.
- Produces: release metadata and docs that describe V0.71 without changing Gold blocked status.

- [ ] **Step 1: Update version constant and version tests**

Set:

```javascript
export const LINKE_RELEASE_VERSION = 'V0.71';
```

Update version/gold tests that assert the explicit milestone from `V0.70` to `V0.71`.

- [ ] **Step 2: Update Gold production-hardening evidence**

Add these evidence strings to the `production-hardening` item:

```javascript
'test/agent-hardening-status.test.js',
'src/agent.js hardening-status',
```

Keep the item status `partial`, keep report status `blocked`, and keep `real-nas-remote-backup` blocked.

- [ ] **Step 3: Update README**

Update README current version text to V0.71, add a version table row for V0.71 as current, make V0.70 historical, add a command example:

```bash
node src/agent.js hardening-status --server http://localhost:3000
node src/agent.js hardening-status --server http://localhost:3000 --token dev-test-token
```

Mention that the command is read-only and mirrors `GET /api/hardening-status`. Keep text explicit that full hardening, real NAS transfer, and Gold release blockers remain incomplete.

- [ ] **Step 4: Update Web Gold safety note text only**

In `src/web/index.html`, update the existing Gold safety note to mention V0.71 `agent.js hardening-status` as a read-only CLI wrapper. Do not add any new element, button, event listener, or request in `src/web/app.js`.

Update `test/web-console.test.js` so the existing safety-note assertion accepts V0.71 and the CLI wording.

- [ ] **Step 5: Run targeted tests**

Run:

```bash
node --test test/agent-hardening-status.test.js test/agent-health.test.js test/health.test.js test/version.test.js test/gold-readiness.test.js test/readme.test.js test/web-console.test.js
```

Expected: PASS.

## Task 4: Final Verification

**Files:**
- All changed files.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: PM-verifiable evidence for commit.

- [ ] **Step 1: Run full suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 2: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output and exit `0`.

- [ ] **Step 3: Run overclaim safety scan**

Run:

```bash
node --input-type=module -e "import { readFileSync } from 'node:fs'; const files=['README.md','src/gold-readiness.js','src/web/index.html','docs/superpowers/specs/2026-07-06-agent-hardening-status-cli-design.md','docs/superpowers/plans/2026-07-06-agent-hardening-status-cli.md']; const terms=['production'+' ready','production'+'-ready','Gold'+' ready','Gold'+'-ready','real NAS remote backup'+' ready','无安全'+'隐患']; let failed=false; for (const file of files) { const text=readFileSync(file,'utf8'); for (const term of terms) { if (text.includes(term)) { console.error(file + ': forbidden overclaim phrase'); failed=true; } } } process.exit(failed ? 1 : 0);"
```

Expected: exit `0`.

- [ ] **Step 4: Inspect diff scope**

Run:

```bash
git diff --stat
```

Expected: only V0.71 hardening-status CLI code, tests, docs, Gold evidence, and this spec/plan changed.

## Self-Review

- Spec coverage: command behavior, auth, no-mutation, safety redaction, docs, version, Gold evidence, and test coverage are mapped to tasks.
- Placeholder scan: no placeholder markers.
- Boundary check: no task enables real NAS, remote commands, credential lookup, token/path disclosure, Web behavior changes, or Gold promotion.
- TDD order: Task 1 creates the failing CLI test before Task 2 changes production code.
