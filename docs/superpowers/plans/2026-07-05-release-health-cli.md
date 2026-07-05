# Release Health CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Linke V0.47 `node src/agent.js health` as a read-only CLI check for `GET /api/health`.

**Architecture:** Reuse the existing `request()` helper in `src/agent.js`, add a `health` command branch, update usage text and README docs, and test the real CLI against a temporary HTTP server.

**Tech Stack:** Node.js ESM, `node:test`, `child_process.execFile`, existing Linke HTTP server.

## Global Constraints

- Read-only CLI command.
- Only calls `GET /api/health`.
- No metadata writes.
- No data directory path, hostname, environment variable, credential, device, or snapshot disclosure.
- No NAS connection, NAS app invocation, backup, restore, sync, delete, or remote command.
- No authentication or production-ready claim.
- No retry loop, daemon mode, watch mode, or background service.

---

### Task 1: RED Tests

**Files:**
- Create: `test/agent-health.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**
- Expects `node src/agent.js health --server <url>` to print JSON from `/api/health`.

- [x] **Step 1: Add failing CLI health test**

Create `test/agent-health.test.js` with a real temporary server:

```js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../src/server.js';

const exec = promisify(execFile);

describe('Agent health CLI', () => {
  let server, dataDir, port;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-health-'));
    server = createServer({ dataDir });
    await new Promise((resolve) => server.listen(0, resolve));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });

  it('outputs JSON health payload without requiring a device or mutating dataDir', async () => {
    assert.deepStrictEqual(await readdir(dataDir), []);
    const agentPath = join(import.meta.dirname, '..', 'src', 'agent.js');
    const { stdout } = await exec('node', [
      agentPath,
      'health',
      '--server',
      `http://localhost:${port}`,
    ]);

    const body = JSON.parse(stdout);
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(body.service, 'linke');
    assert.strictEqual(body.version, 'V0.46');
    assert.strictEqual(body.checks.http, 'ok');
    assert.strictEqual(body.checks.dataDirReadable, 'ok');
    assert.ok(Number.isFinite(Date.parse(body.timestamp)));
    assert.ok(!stdout.includes(dataDir));
    assert.deepStrictEqual(await readdir(dataDir), []);
  });

  it('exits non-zero when the server is unreachable', async () => {
    const agentPath = join(import.meta.dirname, '..', 'src', 'agent.js');
    await assert.rejects(
      () => exec('node', [
        agentPath,
        'health',
        '--server',
        'http://127.0.0.1:1',
      ]),
      (err) => {
        assert.notStrictEqual(err.code, 0);
        assert.match(err.stderr, /Error:/);
        return true;
      },
    );
  });
});
```

- [x] **Step 2: Add failing README tests**

In `test/readme.test.js`:

- Add V0.47 to version coverage.
- Add `README — V0.47 release health CLI` tests for title/badge/table row, command docs, exit-code semantics, and safety boundary.

- [x] **Step 3: Verify RED**

Run:

```bash
node --test test/agent-health.test.js test/readme.test.js
```

Expected: FAIL because `agent.js health` and V0.47 README docs do not exist.

### Task 2: GREEN Implementation

**Files:**
- Modify: `src/agent.js`
- Modify: `README.md`
- Modify: `test/readme.test.js`

- [x] **Step 1: Add CLI command**

In `src/agent.js`:

- Add `health` to top command comments.
- Add `health` to `printUsage()`.
- Add switch branch:

```js
case 'health': {
  const result = await request(server, '/api/health', 'GET');
  console.log(JSON.stringify(result, null, 2));
  break;
}
```

- [x] **Step 2: Update README**

Update README:

- Title and current badge to V0.47.
- Version table: V0.46 historical row, V0.47 current row.
- Agent CLI example: `node src/agent.js health --server http://localhost:3000`.
- Feature/safety text: read-only, GET-only, no device required, no metadata writes, no NAS, no remote commands, no production-ready/auth claim.
- Exit-code text: `status:"degraded"` still exits 0 when the endpoint responds; callers should inspect JSON `status` and `checks` to enforce release policy.
- Testing coverage includes release health CLI.

- [x] **Step 3: Verify GREEN**

Run:

```bash
node --test test/agent-health.test.js test/readme.test.js
```

Expected: PASS.

### Task 3: Verification

- [x] **Step 1: Run target tests**

```bash
node --test test/agent-health.test.js test/readme.test.js
```

- [x] **Step 2: Run full suite**

```bash
npm test
```

- [x] **Step 3: Run diff check**

```bash
git diff --check
```

- [x] **Step 4: Run Qwen diff review**

Ask Qwen to check CLI scope, read-only behavior, command output JSON, no hidden device requirement, README over-claims, and test coverage.

- [x] **Step 5: Run HTTP/CLI smoke**

Start a local server and run:

```bash
node src/agent.js health --server http://127.0.0.1:<port>
```

Verify stdout is JSON with `status`, `service`, `version`, and `checks`, and no dataDir path.

- [x] **Step 6: Run ZAI auxiliary verifier**

Use strict English evidence-only prompt. If ZAI returns tool errors, empty output, missing status fields, or `I don't have a specific response`, record `INCONCLUSIVE` and do not use it as primary acceptance evidence.

- [ ] **Step 7: Commit and push**

```bash
git add README.md src/agent.js test/agent-health.test.js test/readme.test.js docs/superpowers/specs/2026-07-05-release-health-cli-design.md docs/superpowers/plans/2026-07-05-release-health-cli.md
git commit -m "feat: add release health cli"
git push
```

## Execution Record

- RED: AGY created `test/agent-health.test.js` and README assertions. PM reran `node --test test/agent-health.test.js test/readme.test.js`; failures were expected and matched the missing `health` command plus V0.47 README docs.
- GREEN: AGY implemented `src/agent.js` `health` command and V0.47 README updates.
- PM target verification: `node --test test/agent-health.test.js test/readme.test.js` passed 184 tests.
- PM full verification: `npm test` passed 577 tests.
- PM diff hygiene: `git diff --check` passed.
- Qwen adversarial review: `DONE`, no blocking issues and no non-blocking concerns.
- HTTP/CLI smoke: temporary server on `127.0.0.1:3010`; `node src/agent.js health --server http://127.0.0.1:3010` returned JSON health payload without dataDir path disclosure; `http://127.0.0.1:1` exited non-zero with `Error: fetch failed`; port was closed after smoke.
- ZAI auxiliary verifier: final structured verdict `Status: DONE`; PM treated it as auxiliary evidence only because the tool transcript had intermediate file-view/path tool errors.
