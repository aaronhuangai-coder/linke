# Release Health Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Linke V0.46 `GET /api/health` as a read-only liveness endpoint for release smoke tests.

**Architecture:** Keep the endpoint inside the existing Node HTTP server. Add a pure `buildHealthResponse()` helper plus a read-only data directory readability check, route `GET /api/health` before mutating API routes, and test the real HTTP boundary with temporary data directories.

**Tech Stack:** Node.js ESM, `node:http`, `node:test`, built-in `fetch`.

## Global Constraints

- Read-only endpoint.
- No metadata writes.
- No data directory path, hostname, environment variable, credential, device, or snapshot disclosure.
- No backup, restore, retention, diff, backup preflight, NAS dry-run, NAS app invocation, sync, delete, or remote command.
- No authentication or production-ready claim.
- `POST`, `PUT`, `PATCH`, and `DELETE /api/health` must not be added.

---

### Task 1: RED Tests

**Files:**
- Create: `test/health.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**
- Expects `buildHealthResponse({ dataDirReadable, now }): { status, service, version, checks, timestamp }`.
- Expects `GET /api/health` JSON endpoint.

- [x] **Step 1: Add failing pure helper test**

Create `test/health.test.js`:

```js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, buildHealthResponse } from '../src/server.js';

describe('Release health response', () => {
  it('buildHealthResponse returns a stable V0.46 liveness payload without path disclosure', () => {
    assert.deepStrictEqual(buildHealthResponse({
      dataDirReadable: true,
      now: new Date('2026-07-05T00:00:00.000Z'),
    }), {
      status: 'ok',
      service: 'linke',
      version: 'V0.46',
      checks: {
        http: 'ok',
        dataDirReadable: 'ok',
      },
      timestamp: '2026-07-05T00:00:00.000Z',
    });
  });

  it('buildHealthResponse reports degraded when dataDir is unreadable', () => {
    assert.deepStrictEqual(buildHealthResponse({
      dataDirReadable: false,
      now: new Date('2026-07-05T00:00:00.000Z'),
    }), {
      status: 'degraded',
      service: 'linke',
      version: 'V0.46',
      checks: {
        http: 'ok',
        dataDirReadable: 'unavailable',
      },
      timestamp: '2026-07-05T00:00:00.000Z',
    });
  });
});
```

- [x] **Step 2: Add failing HTTP endpoint tests**

Append to `test/health.test.js`:

```js
describe('GET /api/health', () => {
  let server, dataDir, port;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'linke-health-'));
    server = createServer({ dataDir });
    await new Promise((resolve) => server.listen(0, resolve));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });

  it('returns 200 JSON liveness data and does not mutate dataDir', async () => {
    assert.deepStrictEqual(await readdir(dataDir), []);
    const res = await fetch(`http://localhost:${port}/api/health`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(body.service, 'linke');
    assert.strictEqual(body.version, 'V0.46');
    assert.strictEqual(body.checks.http, 'ok');
    assert.strictEqual(body.checks.dataDirReadable, 'ok');
    assert.ok(Number.isFinite(Date.parse(body.timestamp)));
    assert.ok(!JSON.stringify(body).includes(dataDir));
    assert.deepStrictEqual(await readdir(dataDir), []);
  });

  it('does not implement mutating methods for /api/health', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`http://localhost:${port}/api/health`, { method });
      assert.strictEqual(res.status, 404, `${method} /api/health must return 404`);
      assert.deepStrictEqual(await res.json(), { error: 'Not Found' });
    }
  });
});
```

Add a second HTTP test for missing data directory:

```js
describe('GET /api/health with missing dataDir', () => {
  let server, rootDir, dataDir, port;

  before(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'linke-health-missing-'));
    dataDir = join(rootDir, 'missing-data-dir');
    server = createServer({ dataDir });
    await new Promise((resolve) => server.listen(0, resolve));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(rootDir, { recursive: true, force: true });
  });

  it('reports degraded without creating the missing directory', async () => {
    const res = await fetch(`http://localhost:${port}/api/health`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, 'degraded');
    assert.strictEqual(body.checks.dataDirReadable, 'unavailable');
    await assert.rejects(() => readdir(dataDir), /ENOENT/);
    assert.ok(!JSON.stringify(body).includes(dataDir));
  });
});
```

- [x] **Step 3: Add failing README tests**

In `test/readme.test.js`:

```js
it('mentions V0.46 (release health endpoint)', () => {
  assertReadmeContains(/V0\.46/, 'V0.46');
});
```

Add a V0.46 describe block:

```js
describe('README — V0.46 release health endpoint', () => {
  it('title and badge say V0.46', () => {
    assert.match(readme, /^# Linke V0\.46/m);
    assert.match(readme, /当前版本：V0\.46/);
  });

  it('version table has V0.46 row with 当前版本 milestone', () => {
    assert.match(readme, /\| V0\.46 \| 当前版本 \|[^|]*(发布健康检查|release health|\/api\/health)/i);
  });

  it('documents the health endpoint and safety boundary', () => {
    assert.match(readme, /\/api\/health/);
    assert.match(readme, /status.*ok|ok.*status/i);
    assert.match(readme, /degraded|dataDirReadable|unavailable/);
    assert.match(readme, /不写入(任何)?元数据|不写入(any)?metadata/);
    assert.match(readme, /不暴露(本机)?路径|不暴露 DATA_DIR|no path disclosure/i);
    assert.match(readme, /不连接 NAS|不建立真实 NAS 连接/);
    assert.match(readme, /不执行(任何)?远程命令|不执行远程命令/);
  });

  it('documents testing coverage includes release health endpoint', () => {
    assert.match(readme, /测试覆盖：.*发布健康检查/);
  });
});
```

- [x] **Step 4: Verify RED**

Run:

```bash
node --test test/health.test.js test/readme.test.js
```

Expected: FAIL because `buildHealthResponse`, `/api/health`, and V0.46 README docs do not exist yet.

### Task 2: GREEN Implementation

**Files:**
- Modify: `src/server.js`
- Modify: `README.md`

**Interfaces:**
- Produces: `buildHealthResponse({ dataDirReadable, now }): object`.
- Produces: `GET /api/health`.

- [x] **Step 1: Add pure helper**

In `src/server.js`, export:

```js
const LINKE_RELEASE_VERSION = 'V0.46';

export function buildHealthResponse({ dataDirReadable, now = new Date() } = {}) {
  const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const readable = Boolean(dataDirReadable);
  return {
    status: readable ? 'ok' : 'degraded',
    service: 'linke',
    version: LINKE_RELEASE_VERSION,
    checks: {
      http: 'ok',
      dataDirReadable: readable ? 'ok' : 'unavailable',
    },
    timestamp,
  };
}
```

Also add a read-only helper:

```js
async function isDataDirReadable(dataDir) {
  try {
    await access(dataDir, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
```

Import `access` from `node:fs/promises` and `constants` from `node:fs`.

- [x] **Step 2: Add route**

Inside `createServer()` before mutating API routes:

```js
if (method === 'GET' && pathname === '/api/health') {
  return sendJSON(res, 200, buildHealthResponse({
    dataDirReadable: await isDataDirReadable(dataDir),
  }));
}
```

Do not add a `POST /api/health` branch.

- [x] **Step 3: Update README**

Update README:

```text
# Linke V0.46
当前版本：V0.46
| V0.45 | 设备筛选计数指标 | ... |
| V0.46 | 当前版本 | 发布健康检查：新增 GET /api/health 只读健康检查端点 |
```

Add feature/API/safety/testing text for `/api/health`. The text must state: read-only, `status:"ok"` for readable dataDir, `status:"degraded"` when the dataDir is unavailable, no metadata writes, no path disclosure, no NAS connection, no remote command, no production-ready/auth claim.

- [x] **Step 4: Verify GREEN**

Run:

```bash
node --test test/health.test.js test/readme.test.js
```

Expected: PASS.

### Task 3: Verification

- [x] **Step 1: Run target tests**

```bash
node --test test/health.test.js test/readme.test.js
```

- [x] **Step 2: Run full suite**

```bash
node --test --test-reporter=dot test/*.test.js
```

- [x] **Step 3: Run diff check**

```bash
git diff --check
```

- [x] **Step 4: Run Qwen diff review**

Ask Qwen to check blockers for endpoint mutability, data path disclosure, method scope, README over-claims, tests, and Gold release usefulness.

- [x] **Step 5: Run HTTP smoke**

Start a local server and verify:

```text
GET /api/health returns JSON with status ok, service linke, version V0.46, checks.dataDirReadable ok.
POST /api/health returns 404; PUT/PATCH/DELETE are covered in automated tests.
GET / still serves the Web Console.
GET /api/devices still returns an array.
```

- [x] **Step 6: Run ZAI final verifier**

Use strict English evidence-only prompt. If ZAI returns tool errors, empty output, missing status fields, or `I don't have a specific response`, record `INCONCLUSIVE` and do not use it as primary acceptance evidence.

- [ ] **Step 7: Commit and push**

```bash
git add README.md src/server.js test/health.test.js test/readme.test.js docs/superpowers/specs/2026-07-05-release-health-endpoint-design.md docs/superpowers/plans/2026-07-05-release-health-endpoint.md
git commit -m "feat: add release health endpoint"
git push
```

## Execution Notes

- RED confirmed with `node --test test/health.test.js test/readme.test.js`: failed before implementation because `buildHealthResponse`, `/api/health`, and V0.46 README docs were missing.
- AGY implemented GREEN in `src/server.js`, `README.md`, and README tests. A narrow AGY follow-up for stronger V0.45 historical assertions exited with no output and no file changes (`EXITED_NO_OUTPUT`); PM applied the small test-strengthening integration fix.
- PM verification passed:
  - `node --test test/health.test.js test/readme.test.js` => 180 tests passed.
  - `npm test` => 568 tests passed.
  - `git diff --check` => passed.
- Sandbox note: direct sandboxed `node --test` runs that open local HTTP listeners can fail with `EPERM` and Node v24.14.0 native assertion; PM reran the target command with approved `node --test` execution and verified it passed.
- Qwen adversarial review returned `DONE`, no blocking findings.
- HTTP smoke on `127.0.0.1:3010` passed:
  - `GET /api/health` returned `status:"ok"`, `service:"linke"`, `version:"V0.46"`, `checks.http:"ok"`, `checks.dataDirReadable:"ok"` without dataDir path disclosure.
  - `POST /api/health` returned 404.
  - `GET /` returned 200 Web Console HTML.
  - `GET /api/devices` returned 200 with an array.
- ZAI auxiliary verifier returned final `Status: DONE` and no blocking findings. PM treated ZAI as auxiliary because its transcript included tool-path errors before the final structured verdict.
