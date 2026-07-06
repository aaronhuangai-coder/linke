# Hardening Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Linke V0.70 with a read-only `/api/hardening-status` endpoint that reports configured local hardening controls without exposing secrets or paths.

**Architecture:** Add a pure `buildHardeningStatusResponse()` helper in `src/server.js` and a GET-only API route that reuses the existing auth gate. The response is closed and sanitized: it only returns booleans, fixed route labels, `MAX_JSON_BODY_BYTES`, service/version metadata, and safety flags.

**Tech Stack:** Node.js ESM, `node:test`, existing Linke HTTP server, existing audit/rate-limit/auth helpers.

## Global Constraints

- Do not read `.env`, secret managers, SSH keys, cloud credentials, token stores, or NAS credentials.
- Do not return token values, token lengths, token prefixes, token hashes, restore root values, audit file paths, dataDir values, environment variable values, or request headers.
- Do not add real NAS network calls, real NAS writes, NAS app invocation, backup execution, restore execution, or metadata writes for the new endpoint.
- Do not change existing auth enforcement for other API routes.
- Do not change `release-readiness` default pass/fail semantics.
- Keep `real-nas-remote-backup` blocked and Gold readiness blocked.

---

## File Structure

- Modify `src/server.js`: add `buildHardeningStatusResponse()` and `GET /api/hardening-status`.
- Modify `test/health.test.js`: pure response and API/auth contract tests.
- Modify `src/version.js`: bump `LINKE_RELEASE_VERSION` to `V0.70`.
- Modify `src/gold-readiness.js`: add V0.70 hardening-status evidence while keeping `production-hardening` partial.
- Modify `src/web/index.html`: update Gold safety note text to mention V0.70 hardening-status only; no Web behavior change.
- Modify `README.md`: update current version, version table, hardening docs, Gold boundary text, and test coverage.
- Modify `test/version.test.js`, `test/readme.test.js`, `test/gold-readiness.test.js`, `test/web-console.test.js`: align release/version/docs evidence.

## Task 1: Failing Hardening Status Tests

**Files:**
- Modify: `test/health.test.js`

**Interfaces:**
- Consumes: existing `createServer()`, `API_WRITE_ROUTES`, `formatApiRoute`, `MAX_JSON_BODY_BYTES`, `readAuditEvents()`.
- Produces: failing tests for `buildHardeningStatusResponse()` and `GET /api/hardening-status`.

- [x] **Step 1: Import the new helper**

Update the import from `../src/server.js`:

```js
import {
  createServer,
  buildAuthStatusResponse,
  buildHardeningStatusResponse,
  buildHealthResponse,
  API_WRITE_ROUTES,
  formatApiRoute,
  isApiWriteRoute,
  MAX_JSON_BODY_BYTES,
} from '../src/server.js';
```

Keep the existing `readAuditEvents` import from `../src/audit-log.js`; it is still used by the new API auth tests.

- [x] **Step 2: Add pure response tests**

Add after the existing `Auth status response` describe block:

```js
describe('Hardening status response', () => {
  it('buildHardeningStatusResponse returns sanitized disabled status by default', () => {
    const body = buildHardeningStatusResponse();

    assert.deepStrictEqual(body, {
      status: 'partial',
      service: 'linke',
      version: LINKE_RELEASE_VERSION,
      hardening: {
        authConfigured: false,
        configuredAuthScopes: {
          full: false,
          read: false,
          write: false,
        },
        scopedTokensConfigured: false,
        rateLimitConfigured: false,
        auditRetentionConfigured: false,
        restoreRootConfigured: false,
        requestBodyLimitBytes: MAX_JSON_BODY_BYTES,
        writeRoutes: API_WRITE_ROUTES.map(formatApiRoute),
      },
      safety: {
        tokenValuesReturned: false,
        restoreRootValueReturned: false,
        auditPathReturned: false,
        environmentValuesReturned: false,
        successAuditEvent: false,
      },
    });
  });

  it('buildHardeningStatusResponse reports configured controls without values', () => {
    const restoreRoot = '/private/tmp/linke-secret-restore-root';
    const body = buildHardeningStatusResponse({
      authToken: 'full-secret-token',
      readToken: 'read-secret-token',
      writeToken: 'write-secret-token',
      restoreRoot,
      rateLimit: { maxRequests: 3, windowMs: 60000 },
      auditRetention: { maxEvents: 10 },
    });
    const serialized = JSON.stringify(body);

    assert.strictEqual(body.status, 'partial');
    assert.deepStrictEqual(body.hardening.configuredAuthScopes, {
      full: true,
      read: true,
      write: true,
    });
    assert.strictEqual(body.hardening.authConfigured, true);
    assert.strictEqual(body.hardening.scopedTokensConfigured, true);
    assert.strictEqual(body.hardening.rateLimitConfigured, true);
    assert.strictEqual(body.hardening.auditRetentionConfigured, true);
    assert.strictEqual(body.hardening.restoreRootConfigured, true);
    assert.doesNotMatch(serialized, /full-secret-token|read-secret-token|write-secret-token/);
    assert.ok(!serialized.includes(restoreRoot));
  });
});
```

- [x] **Step 3: Add API route tests**

Add after the existing `GET /api/auth-status` describe block:

```js
describe('GET /api/hardening-status', () => {
  it('returns sanitized hardening status in no-token localhost mode and does not mutate dataDir', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-hardening-status-open-'));
    const server = createServer({ dataDir });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      assert.deepStrictEqual(await readdir(dataDir), []);
      const res = await fetch(`http://localhost:${port}/api/hardening-status`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();

      assert.strictEqual(body.status, 'partial');
      assert.strictEqual(body.service, 'linke');
      assert.strictEqual(body.version, LINKE_RELEASE_VERSION);
      assert.strictEqual(body.hardening.authConfigured, false);
      assert.strictEqual(body.hardening.rateLimitConfigured, false);
      assert.strictEqual(body.hardening.auditRetentionConfigured, false);
      assert.strictEqual(body.hardening.restoreRootConfigured, false);
      assert.strictEqual(body.hardening.requestBodyLimitBytes, MAX_JSON_BODY_BYTES);
      assert.deepStrictEqual(body.hardening.writeRoutes, API_WRITE_ROUTES.map(formatApiRoute));
      assert.deepStrictEqual(body.safety, {
        tokenValuesReturned: false,
        restoreRootValueReturned: false,
        auditPathReturned: false,
        environmentValuesReturned: false,
        successAuditEvent: false,
      });
      assert.ok(!JSON.stringify(body).includes(dataDir));
      assert.deepStrictEqual(await readdir(dataDir), []);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('allows readToken to read hardening status without returning token or restoreRoot material', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-hardening-status-read-'));
    const restoreRoot = await mkdtemp(join(tmpdir(), 'linke-hardening-restore-root-'));
    const server = createServer({
      dataDir,
      readToken: 'read-hardening-token',
      writeToken: 'write-hardening-token',
      restoreRoot,
      rateLimit: { maxRequests: 5, windowMs: 60000 },
      auditRetention: { maxEvents: 5 },
    });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/api/hardening-status`, {
        headers: { Authorization: 'Bearer read-hardening-token' },
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      const serialized = JSON.stringify(body);

      assert.strictEqual(body.hardening.authConfigured, true);
      assert.deepStrictEqual(body.hardening.configuredAuthScopes, {
        full: false,
        read: true,
        write: true,
      });
      assert.strictEqual(body.hardening.scopedTokensConfigured, true);
      assert.strictEqual(body.hardening.rateLimitConfigured, true);
      assert.strictEqual(body.hardening.auditRetentionConfigured, true);
      assert.strictEqual(body.hardening.restoreRootConfigured, true);
      assert.doesNotMatch(serialized, /read-hardening-token|write-hardening-token|Bearer/);
      assert.ok(!serialized.includes(restoreRoot));
      assert.deepStrictEqual(await readAuditEvents(dataDir), []);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
      await rm(restoreRoot, { recursive: true, force: true });
    }
  });

  it('rejects unknown tokens before returning hardening fields', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-hardening-status-denied-'));
    const server = createServer({ dataDir, readToken: 'read-hardening-token' });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/api/hardening-status`, {
        headers: { Authorization: 'Bearer unknown-hardening-token' },
      });
      assert.strictEqual(res.status, 401);
      const body = await res.json();
      assert.deepStrictEqual(body, { error: 'Unauthorized' });
      assert.doesNotMatch(JSON.stringify(body), /hardening|configuredAuthScopes|read-hardening-token|unknown-hardening-token/);
      const events = await readAuditEvents(dataDir, { limit: 1 });
      assert.strictEqual(events[0].type, 'auth.denied');
      assert.strictEqual(events[0].path, '/api/hardening-status');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('does not implement mutating methods for /api/hardening-status', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-hardening-status-methods-'));
    const server = createServer({ dataDir });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await fetch(`http://localhost:${port}/api/hardening-status`, { method });
        assert.strictEqual(res.status, 404, `${method} /api/hardening-status must return 404`);
        assert.deepStrictEqual(await res.json(), { error: 'Not Found' });
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
```

- [x] **Step 4: Run RED test**

Run:

```bash
node --test test/health.test.js
```

Expected: FAIL because `buildHardeningStatusResponse` is not exported and `/api/hardening-status` is not implemented.

## Task 2: Server Implementation And Version Sync

**Files:**
- Modify: `src/server.js`
- Modify: `src/version.js`

**Interfaces:**
- Consumes: existing auth gate, `MAX_JSON_BODY_BYTES`, `API_WRITE_ROUTES`, `formatApiRoute()`.
- Produces: `buildHardeningStatusResponse()` and `GET /api/hardening-status`.

- [x] **Step 1: Add response builder**

In `src/server.js`, add this exported function after `buildAuthStatusResponse()`:

```js
export function buildHardeningStatusResponse({
  authToken,
  readToken,
  writeToken,
  restoreRoot,
  rateLimit,
  auditRetention,
} = {}) {
  const normAuth = normalizeAuthToken(authToken);
  const normRead = normalizeReadToken(readToken);
  const normWrite = normalizeWriteToken(writeToken);
  const authConfigured = Boolean(normAuth || normRead || normWrite);

  return {
    status: 'partial',
    service: 'linke',
    version: LINKE_RELEASE_VERSION,
    hardening: {
      authConfigured,
      configuredAuthScopes: {
        full: Boolean(normAuth),
        read: Boolean(normRead),
        write: Boolean(normWrite),
      },
      scopedTokensConfigured: Boolean(normRead || normWrite),
      rateLimitConfigured: Boolean(rateLimit),
      auditRetentionConfigured: Boolean(auditRetention),
      restoreRootConfigured: Boolean(restoreRoot),
      requestBodyLimitBytes: MAX_JSON_BODY_BYTES,
      writeRoutes: API_WRITE_ROUTES.map(formatApiRoute),
    },
    safety: {
      tokenValuesReturned: false,
      restoreRootValueReturned: false,
      auditPathReturned: false,
      environmentValuesReturned: false,
      successAuditEvent: false,
    },
  };
}
```

- [x] **Step 2: Add route**

In `createServer()`, after `GET /api/auth-status`, add:

```js
      // GET /api/hardening-status
      if (method === 'GET' && pathname === '/api/hardening-status') {
        return sendJSON(res, 200, buildHardeningStatusResponse({
          authToken: expectedAuthToken,
          readToken: expectedReadToken,
          writeToken: expectedWriteToken,
          restoreRoot: normalizedRestoreRoot,
          rateLimit: apiRateLimiter,
          auditRetention,
        }));
      }
```

This route must remain after the existing API auth gate, so unknown tokens receive `401` before response fields are built.

- [x] **Step 3: Bump version**

In `src/version.js`:

```js
export const LINKE_RELEASE_VERSION = 'V0.70';
```

- [x] **Step 4: Run GREEN tests for server/version slice**

Run:

```bash
node --test test/health.test.js test/version.test.js
```

Expected: `test/health.test.js` passes; version/docs tests fail until docs and expectations are updated to V0.70.

## Task 3: Docs, Gold Evidence, Web Safety Text, And Test Alignment

**Files:**
- Modify: `README.md`
- Modify: `src/gold-readiness.js`
- Modify: `src/web/index.html`
- Modify: `test/version.test.js`
- Modify: `test/readme.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/web-console.test.js`

**Interfaces:**
- Consumes: V0.70 hardening-status behavior from Task 2.
- Produces: release docs and readiness evidence aligned to V0.70.

- [x] **Step 1: Update version tests**

Change V0.69 expectations to V0.70 in:

```js
assert.strictEqual(LINKE_RELEASE_VERSION, 'V0.70');
assert.strictEqual(report.version, 'V0.70');
```

- [x] **Step 2: Add README tests**

In `test/readme.test.js`, add a V0.70 describe block:

```js
describe('README — V0.70 hardening status endpoint', () => {
  it('title and badge claim V0.70 as current', () => {
    assertReadmeContains(/# Linke V0\.70/, 'README title should mention V0.70');
    assertReadmeContains(/\*\*当前版本：V0\.70\*\*/, 'README badge should mention V0.70');
  });

  it('version table marks V0.69 historical and V0.70 current', () => {
    assertReadmeContains(/\| V0\.69 \| 历史版本 \|/, 'V0.69 should be historical');
    assertReadmeContains(/\| V0\.70 \| 当前版本 \|[^|]*(hardening-status|硬化状态|生产硬化)/i, 'V0.70 should be current hardening-status milestone');
  });

  it('documents hardening-status endpoint safety boundaries', () => {
    assertReadmeContains(/GET \/api\/hardening-status/, 'README should document hardening-status endpoint');
    assertReadmeContains(/tokenValuesReturned:false/, 'README should document tokenValuesReturned false');
    assertReadmeContains(/restoreRootValueReturned:false/, 'README should document restoreRootValueReturned false');
    assertReadmeContains(/auditPathReturned:false/, 'README should document auditPathReturned false');
  });

  it('keeps Gold blocked and rejects production hardening overclaims for V0.70', () => {
    assertReadmeContains(/real-nas-remote-backup[^\\n]*blocked|真实 NAS[^\\n]*blocked/i, 'README should keep real NAS blocked');
    assertReadmeNotContains(new RegExp('production[- ]ready|Gold[- ]ready|' + '无安全' + '隐患', 'i'), 'README should not overclaim readiness');
  });
});
```

- [x] **Step 3: Update README**

Update:

- title and current version badge to V0.70
- version table: V0.69 -> historical, V0.70 -> current
- feature summary to mention `GET /api/hardening-status`
- API/security docs with:

```text
GET /api/hardening-status
```

Document that the response returns only boolean hardening configuration status, fixed write-route labels, request body limit, and safety flags:

```text
tokenValuesReturned:false
restoreRootValueReturned:false
auditPathReturned:false
environmentValuesReturned:false
successAuditEvent:false
```

Keep Gold boundaries clear: this is partial `production-hardening` evidence, not production-grade authorization, monitoring, supervisor, secret management, token rotation, distributed rate limiting, or real NAS backup.

- [x] **Step 4: Update Gold readiness evidence**

In `src/gold-readiness.js`, add to the `production-hardening` evidence array:

```js
'GET /api/hardening-status',
'src/server.js buildHardeningStatusResponse',
```

Update `production-hardening.nextStep` to mention V0.70 hardening-status while keeping status `partial` and keeping monitoring/supervisor/secret/deployment gaps.

- [x] **Step 5: Update Web safety note and tests**

In `src/web/index.html`, update the Gold safety note from V0.69 to V0.70 and mention `GET /api/hardening-status` as read-only status evidence. Do not add new buttons or fetch behavior.

In `test/web-console.test.js`, update the safety note assertion that currently mentions V0.69/V0.67 so it accepts V0.70 and `GET /api/hardening-status`.

- [x] **Step 6: Run targeted docs/readiness tests**

Run:

```bash
node --test test/health.test.js test/version.test.js test/readme.test.js test/gold-readiness.test.js test/web-console.test.js
```

Expected: PASS.

## Task 4: Final Verification

**Files:**
- No new code edits unless verification exposes a defect.

- [x] **Step 1: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

- [x] **Step 2: Check whitespace**

```bash
git diff --check
```

Expected: no output.

- [x] **Step 3: Check safety phrase scan**

```bash
node --input-type=module -e "import { readFileSync } from 'node:fs'; const files=['README.md','docs/superpowers/specs/2026-07-06-hardening-status-design.md','docs/superpowers/plans/2026-07-06-hardening-status.md']; const terms=['production'+' ready','production'+'-ready','Gold'+' ready','Gold'+'-ready','real NAS remote backup'+' ready','无安全'+'隐患']; let failed=false; for (const file of files) { const text=readFileSync(file,'utf8'); for (const term of terms) { if (text.includes(term)) { console.error(file + ': forbidden overclaim phrase'); failed=true; } } } process.exit(failed ? 1 : 0);"
```

Expected: no output.

- [x] **Step 4: Review diff scope**

```bash
git diff --stat
git diff --name-only
```

Expected: only V0.70 hardening-status code, tests, release docs, Gold readiness evidence, Web safety note, and this spec/plan.

- [x] **Step 5: Commit and push**

## Self-Review

- Spec coverage: hardening-status helper, route, auth gate, no-mutation behavior, value redaction, docs, version, Gold evidence, Web safety note, and tests are mapped to tasks.
- Placeholder scan: no unresolved placeholder markers.
- Type consistency: response fields use exact names from the design and test snippets.
- Boundary check: no task enables real NAS, credential reading, token/path disclosure, release-readiness tightening, or Gold promotion.

## PM Verification Evidence

- Implementer: AGY returned `DONE`; PM independently reviewed the diff and added an `auditRetention.maxEvents === 0` disabled regression test plus helper fix.
- Targeted verification: `node --test test/health.test.js test/version.test.js test/readme.test.js test/gold-readiness.test.js test/web-console.test.js` -> 631 pass, 0 fail.
- Full verification: `npm test` -> 943 pass, 0 fail.
- Whitespace: `git diff --check` -> no output.
- Safety wording scan: README/spec/plan scan -> no forbidden overclaim phrases.
- Qwen final blocker review: PASS, no blockers or required changes.
- ZAI auxiliary verification: final structured verdict PASS, no blockers.
- Diff scope: limited to V0.70 hardening-status code, tests, release docs, Gold readiness evidence, Web safety note, and this spec/plan.
