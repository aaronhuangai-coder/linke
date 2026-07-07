# Supervisor Lifecycle Approval Persist Web/API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add V0.95 guarded Web/API approval persistence using the server `dataDir`, with auth/write-route protection, sanitized audit events, manual Web Console action, and no lifecycle apply execution.

**Architecture:** Reuse the existing supervisor lifecycle preview contract and V0.93/V0.94 approval store. The API accepts inline JSON, never client paths, and writes only sanitized approval records plus sanitized audit events. The Web Console reuses the existing approval preview panel inputs and adds a separate manual persist action.

**Tech Stack:** Node.js ESM, built-in `node:test`, existing HTTP server in `src/server.js`, existing Web Console vanilla JS/HTML.

## Global Constraints

- Add `POST /api/supervisor-lifecycle-approval-persist`.
- Register `POST /api/supervisor-lifecycle-approval-persist` in `API_WRITE_ROUTES`.
- Keep `POST /api/supervisor-lifecycle-approval-persistence-preview` outside `API_WRITE_ROUTES`.
- API accepts inline JSON `operation`, `config`, and `approval`; it must not accept client dataDir/path fields.
- Valid persist response: `201` + sanitized `supervisor-lifecycle-approval-record`.
- Invalid/not-persistable approval response: `409` + sanitized blocked `supervisor-lifecycle-approval-persistence-preview`.
- Input errors: `400`; body-limit errors: existing `413`; write failures: `500` with only `failed to persist approval record`.
- Record sanitized audit events for `201`, `409`, `400`, and `500`; existing auth gate owns `401 auth.denied` and `403 auth.forbidden`.
- Web persist action is manual only, no startup request and no polling.
- Web button test id is `supervisor-lifecycle-approval-persist-button`.
- Web button text includes `Persist Approval Record` and does not include `Apply`, `Install`, `Execute`, `Run install`, `Rollback`, or `Uninstall`.
- No lifecycle apply execution, no Web/API lifecycle apply endpoint, no `launchctl`, no process spawn/exec, no NAS connection, no backup/restore trigger, no remote command, no database/keychain integration.
- Do not leak config path, approval path, dataDir path, sourcePath, serverUrl, NAS endpoint, approvedBy value, approval reason, acknowledgement content, approval timestamps, hash values, `sha256:`, token, Authorization header, hostname, username, process id, local filesystem paths, errno, or raw filesystem exception messages.
- Gold remains blocked.

---

## File Structure

- Modify `src/approval-store.js`: export `isPersistablePreview(...)` so API and CLI share one predicate.
- Modify `src/agent.js`: replace the V0.94 inline persistability predicate with `isPersistablePreview(...)`.
- Modify `src/server.js`: add write-route registration, imports, persist route, sanitized audit events, and route-level write-failure catch.
- Create `test/supervisor-lifecycle-approval-persist-api.test.js`: API, auth, audit, status-code, no-leak, and write-failure coverage.
- Modify `src/web/index.html`: add manual persist button and dedicated safety note in the existing approval preview panel.
- Modify `src/web/app.js`: add persist DOM ref, view model handling, in-flight guard, API call, and rendering.
- Modify `test/web-console.test.js`: static HTML, no startup request, manual call, rendering, duplicate-click, and no-leak Web tests.
- Modify `src/version.js`, `README.md`, `src/gold-readiness.js`, `test/version.test.js`, `test/readme.test.js`, `test/gold-readiness.test.js`: V0.95 release metadata.

---

### Task 1: Shared Persistability Helper

**Files:**
- Modify: `src/approval-store.js`
- Modify: `src/agent.js`
- Modify: `test/approval-store.test.js`
- Test: `test/agent-supervisor-lifecycle-approval-persist.test.js`

**Interfaces:**
- Produces: `export function isPersistablePreview(preview): boolean`
- Consumes: existing `appendSupervisorLifecycleApprovalRecord(dataDir, preview, approval, options)`
- Later tasks rely on `isPersistablePreview(preview)` for API route decisions.

- [ ] **Step 1: Write RED helper export test**

Add to `test/approval-store.test.js` imports:

```js
import {
  appendSupervisorLifecycleApprovalRecord,
  buildSupervisorLifecycleApprovalRecord,
  isPersistablePreview,
  readSupervisorLifecycleApprovalRecords,
} from '../src/approval-store.js';
```

Add this test in the existing `describe('supervisor lifecycle approval store', ...)` block:

```js
it('identifies persistable previews with the shared helper', () => {
  const { preview } = validPreview('install');
  const invalidPreview = {
    ...preview,
    approvalValid: false,
    blockers: ['approval-plan-hash-mismatch', 'approval-persistence-store-missing'],
  };

  assert.strictEqual(isPersistablePreview(preview), true);
  assert.strictEqual(isPersistablePreview(invalidPreview), false);
  assert.strictEqual(isPersistablePreview(null), false);
});
```

- [ ] **Step 2: Verify RED fails**

Run:

```bash
node --test --test-reporter=spec test/approval-store.test.js
```

Expected: fail because `isPersistablePreview` is not exported.

- [ ] **Step 3: Export helper and update CLI**

In `src/approval-store.js`, change:

```js
function isPersistablePreview(preview) {
```

to:

```js
export function isPersistablePreview(preview) {
```

In `src/agent.js`, change the import:

```js
import { appendSupervisorLifecycleApprovalRecord } from './approval-store.js';
```

to:

```js
import {
  appendSupervisorLifecycleApprovalRecord,
  isPersistablePreview,
} from './approval-store.js';
```

Replace the inline `const isPersistable = ...` predicate in `supervisor-lifecycle-approval-persist` with:

```js
const persistable = isPersistablePreview(preview);
```

Then change the branch to:

```js
if (!persistable) {
  console.log(JSON.stringify(preview, null, 2));
  process.exitCode = 2;
} else {
  let record;
  try {
    record = await appendSupervisorLifecycleApprovalRecord(args['data-dir'], preview, approval);
  } catch (err) {
    throw new Error('failed to persist approval record');
  }
  console.log(JSON.stringify(record, null, 2));
}
```

- [ ] **Step 4: Verify GREEN**

Run:

```bash
node --test --test-reporter=dot test/approval-store.test.js test/agent-supervisor-lifecycle-approval-persist.test.js
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/approval-store.js src/agent.js test/approval-store.test.js
git commit -m "refactor: share approval persistability helper"
```

---

### Task 2: Approval Persist API, Auth, And Audit

**Files:**
- Modify: `src/server.js`
- Create: `test/supervisor-lifecycle-approval-persist-api.test.js`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `isPersistablePreview(preview)`, `appendSupervisorLifecycleApprovalRecord(dataDir, preview, approval)`
- Produces: `POST /api/supervisor-lifecycle-approval-persist`
- Produces audit event types:
  - `api.supervisor_lifecycle_approval_persist.persisted`
  - `api.supervisor_lifecycle_approval_persist.blocked`
  - `api.supervisor_lifecycle_approval_persist.failure`

- [ ] **Step 1: Write RED API tests**

Create `test/supervisor-lifecycle-approval-persist-api.test.js` with tests covering:

```js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, API_WRITE_ROUTES, isApiWriteRoute } from '../src/server.js';
import { readAuditEvents } from '../src/audit-log.js';
import { readSupervisorLifecycleApprovalRecords } from '../src/approval-store.js';
import {
  buildSupervisorLifecycleApplyPlan,
} from '../src/supervisor-lifecycle.js';

const BASE_CONFIG = {
  serverUrl: 'http://localhost:3000',
  deviceId: 'web-api-approval-persist',
  backupJobs: [{ name: 'documents', sourcePath: '/tmp/linke-documents' }],
};

function validApprovalFor(operation = 'install') {
  const dryRunPlan = buildSupervisorLifecycleApplyPlan(BASE_CONFIG, { operation });
  return {
    operation,
    configHash: dryRunPlan.configHash,
    planHash: dryRunPlan.planHash,
    approved: true,
    schemaVersion: 1,
    approvedBy: 'operator@example.invalid',
    reason: 'do not leak this reason',
    acknowledgements: ['do not leak this acknowledgement'],
    approvedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };
}

async function postJSON(port, path, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch {}
  return { res, text, body: parsed };
}
```

Required test cases:

```js
it('registers approval persist as a write route while preview remains read-only', () => {
  assert.strictEqual(isApiWriteRoute('POST', '/api/supervisor-lifecycle-approval-persist'), true);
  assert.ok(API_WRITE_ROUTES.some((route) => route.method === 'POST' && route.path === '/api/supervisor-lifecycle-approval-persist'));
  assert.strictEqual(isApiWriteRoute('POST', '/api/supervisor-lifecycle-approval-persistence-preview'), false);
});
```

```js
it('persists valid approval through API with sanitized record and audit event', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'linke-approval-persist-api-'));
  const server = createServer({ dataDir });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    const { res, text, body } = await postJSON(port, '/api/supervisor-lifecycle-approval-persist', {
      operation: 'install',
      config: BASE_CONFIG,
      approval: validApprovalFor('install'),
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(body.command, 'supervisor-lifecycle-approval-record');
    assert.strictEqual(body.state, 'persisted');
    assert.strictEqual(body.safety.approvalPersisted, true);
    assert.strictEqual(body.safety.lifecycleApplied, false);
    assert.deepStrictEqual(await readSupervisorLifecycleApprovalRecords(dataDir), [body]);
    const auditEvents = await readAuditEvents(dataDir, { limit: 10 });
    assert.ok(auditEvents.some((event) => event.type === 'api.supervisor_lifecycle_approval_persist.persisted' && event.statusCode === 201));
    assert.doesNotMatch(text, /operator@example|do not leak|sha256:|localhost|linke-documents|token|secret|\/tmp\/linke-documents/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
```

Also include tests for:

- invalid approval returns `409`, body command is `supervisor-lifecycle-approval-persistence-preview`, `approvalValid:false`, no `approvals` directory, and audit contains `.blocked`
- invalid operation returns `400` with static error and audit `.failure`
- malformed JSON returns `400` and does not leak submitted values
- dataDir write failure returns `500` with `{ error:"failed to persist approval record" }` and does not leak `ENOTDIR`, the dataDir file name, or temp path
- `createServer({ dataDir, readToken:'read', writeToken:'write' })` with read token returns `403 Forbidden` and records `auth.forbidden`
- no token when auth is configured returns `401 Unauthorized` and records `auth.denied`

- [ ] **Step 2: Verify RED fails**

Run:

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-approval-persist-api.test.js test/server.test.js
```

Expected: fail because the route is missing and not registered.

- [ ] **Step 3: Implement server route**

In `src/server.js`, add import:

```js
import {
  appendSupervisorLifecycleApprovalRecord,
  isPersistablePreview,
} from './approval-store.js';
```

Add to `API_WRITE_ROUTES`:

```js
{ method: 'POST', path: '/api/supervisor-lifecycle-approval-persist' },
```

Add route after the existing V0.92 preview route:

```js
if (method === 'POST' && pathname === '/api/supervisor-lifecycle-approval-persist') {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    if (err.statusCode === 400) {
      await recordAudit(dataDir, {
        type: 'api.supervisor_lifecycle_approval_persist.failure',
        method,
        path: pathname,
        statusCode: 400,
        outcome: 'failure',
        requestId,
        message: 'invalid request body',
      }, auditRetention);
      return sendError(res, 400, err.message);
    }
    throw err;
  }

  const operation = body?.operation;
  const validOperations = new Set(['install', 'uninstall', 'rollback', 'recover']);
  if (!validOperations.has(operation)) {
    await recordAudit(dataDir, {
      type: 'api.supervisor_lifecycle_approval_persist.failure',
      method,
      path: pathname,
      statusCode: 400,
      outcome: 'failure',
      requestId,
      message: 'invalid operation',
    }, auditRetention);
    return sendError(res, 400, 'operation must be one of: install, uninstall, rollback, recover');
  }

  if (!body?.approval || typeof body.approval !== 'object' || Array.isArray(body.approval)) {
    await recordAudit(dataDir, {
      type: 'api.supervisor_lifecycle_approval_persist.failure',
      method,
      path: pathname,
      statusCode: 400,
      outcome: 'failure',
      requestId,
      operation,
      message: 'approval object is required',
    }, auditRetention);
    return sendError(res, 400, 'approval object is required');
  }

  let config;
  try {
    config = validateConfig(body?.config);
  } catch (err) {
    await recordAudit(dataDir, {
      type: 'api.supervisor_lifecycle_approval_persist.failure',
      method,
      path: pathname,
      statusCode: 400,
      outcome: 'failure',
      requestId,
      operation,
      message: 'invalid config',
    }, auditRetention);
    return sendError(res, 400, err.message);
  }

  const approval = body.approval;
  const plan = buildSupervisorLifecycleApplyPlan(config, {
    operation,
    apply: true,
    envGateEnabled: true,
    approval,
  });
  const preview = buildSupervisorLifecycleApprovalPersistencePreview(plan, approval);

  if (!isPersistablePreview(preview)) {
    await recordAudit(dataDir, {
      type: 'api.supervisor_lifecycle_approval_persist.blocked',
      method,
      path: pathname,
      statusCode: 409,
      outcome: 'blocked',
      requestId,
      operation,
      message: 'approval persistence blocked',
    }, auditRetention);
    return sendJSON(res, 409, preview);
  }

  let record;
  try {
    record = await appendSupervisorLifecycleApprovalRecord(dataDir, preview, approval);
  } catch (err) {
    await recordAudit(dataDir, {
      type: 'api.supervisor_lifecycle_approval_persist.failure',
      method,
      path: pathname,
      statusCode: 500,
      outcome: 'failure',
      requestId,
      operation,
      message: 'failed to persist approval record',
    }, auditRetention);
    return sendError(res, 500, 'failed to persist approval record');
  }

  await recordAudit(dataDir, {
    type: 'api.supervisor_lifecycle_approval_persist.persisted',
    method,
    path: pathname,
    statusCode: 201,
    outcome: 'success',
    requestId,
    operation,
    message: 'approval record persisted',
  }, auditRetention);
  return sendJSON(res, 201, record);
}
```

- [ ] **Step 4: Verify GREEN**

Run:

```bash
node --test --test-reporter=dot test/supervisor-lifecycle-approval-persist-api.test.js test/server.test.js test/approval-store.test.js
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/server.js test/supervisor-lifecycle-approval-persist-api.test.js test/server.test.js
git commit -m "feat: add supervisor approval persist api"
```

---

### Task 3: Manual Web Console Persist Action

**Files:**
- Modify: `src/web/index.html`
- Modify: `src/web/app.js`
- Modify: `test/web-console.test.js`

**Interfaces:**
- Consumes: `POST /api/supervisor-lifecycle-approval-persist`
- Produces: manual button `data-testid="supervisor-lifecycle-approval-persist-button"`

- [ ] **Step 1: Write RED Web tests**

Add tests to `test/web-console.test.js` near the existing approval preview tests:

- HTML includes `data-testid="supervisor-lifecycle-approval-persist-button"` and the button text `Persist Approval Record`
- HTML does not put `Apply`, `Install`, `Execute`, `Run install`, `Rollback`, or `Uninstall` inside the persist button text
- HTML includes dedicated safety text: `local JSONL approval record`, `does not execute lifecycle apply`, `does not call launchctl`
- initialization does not call `/api/supervisor-lifecycle-approval-persist`
- clicking persist sends one `POST /api/supervisor-lifecycle-approval-persist` request with operation/config/approval
- duplicate clicks while in-flight send only one request
- `201` response renders `persisted`, operation, and text that record persistence is not lifecycle apply
- `409` response renders blocked preview blockers
- error response renders sanitized static error and does not render `token`, `secret`, path, approvedBy, reason, acknowledgement, or hash values

Use the existing mock document helpers and existing preview tests as the template.

- [ ] **Step 2: Verify RED fails**

Run:

```bash
node --test --test-reporter=spec test/web-console.test.js
```

Expected: fail because the persist button and JS handler are missing.

- [ ] **Step 3: Add HTML controls and safety note**

In `src/web/index.html`, add after the existing preview button:

```html
<button
  id="supervisor-lifecycle-approval-persist-button"
  data-testid="supervisor-lifecycle-approval-persist-button"
  type="button"
>Persist Approval Record</button>
```

Add to the approval preview safety note or a sibling note:

```html
<p data-testid="supervisor-lifecycle-approval-persist-safety-note">
  Persist Approval Record 仅将批准记录写入本地 JSONL approval record；does not execute lifecycle apply、does not call launchctl、不安装、不卸载、不回滚、不启动 recovery supervisor、不连接 NAS、不触发备份或恢复、不执行远程命令；不显示 dataDir、config path、approval path、approval identity、reason、acknowledgement 内容、hash 值、token、hostname、username 或 process id；Gold 仍 blocked。
</p>
```

- [ ] **Step 4: Add Web JS persist handler**

In `src/web/app.js`, add DOM ref:

```js
const supervisorLifecycleApprovalPersistButton = doc.getElementById('supervisor-lifecycle-approval-persist-button');
```

Add in-flight flag near existing preview flag:

```js
let supervisorLifecycleApprovalPersistInFlight = false;
```

Add helper:

```js
export function buildSupervisorLifecycleApprovalPersistViewModel(payload, httpStatus = 0, errorMessage = '') {
  if (errorMessage) {
    return buildSupervisorLifecycleApprovalPersistencePreviewViewModel(null, errorMessage);
  }
  if (httpStatus === 201 && payload?.command === 'supervisor-lifecycle-approval-record') {
    return {
      statusKey: 'ready',
      statusText: '已记录',
      approvalValidText: payload.approvalValid === true ? 'true' : 'false',
      persistenceText: 'approvalRecord:persisted / lifecycleApply:false',
      blockers: normalizeStringList(payload.blockersResolved),
      requiredFields: [],
      validationLines: buildSupervisorLifecycleApprovalPreviewValidationLines(payload.validation),
      safetyLines: buildSupervisorLifecycleApprovalPreviewSafetyLines(payload.safety),
      messageText: `Persisted approval record for ${payload.operation || 'unknown'}; this is not lifecycle apply.`,
    };
  }
  return buildSupervisorLifecycleApprovalPersistencePreviewViewModel(payload);
}
```

Add fetch handler:

```js
async function persistSupervisorLifecycleApprovalRecord() {
  if (!supervisorLifecycleApprovalPreviewResultEl || supervisorLifecycleApprovalPersistInFlight) return;

  const parsed = parseSupervisorLifecycleApprovalPreviewPayload();
  if (!parsed.ok) {
    setSupervisorLifecycleApprovalPreviewError(parsed.error);
    return;
  }
  if (!parsed.payload.approval || typeof parsed.payload.approval !== 'object') {
    setSupervisorLifecycleApprovalPreviewError('批准 JSON 不能为空');
    return;
  }

  supervisorLifecycleApprovalPersistInFlight = true;
  if (supervisorLifecycleApprovalPersistButton) supervisorLifecycleApprovalPersistButton.disabled = true;
  clearElement(supervisorLifecycleApprovalPreviewResultEl);
  const loading = doc.createElement('p');
  loading.className = 'placeholder';
  loading.textContent = '写入批准记录中...';
  supervisorLifecycleApprovalPreviewResultEl.appendChild(loading);

  try {
    const res = await apiFetch('/api/supervisor-lifecycle-approval-persist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed.payload),
    });
    const body = await res.json();
    if (!res.ok && res.status !== 409) {
      throw new Error(body.error || 'HTTP ' + res.status);
    }
    renderSupervisorLifecycleApprovalPreview(buildSupervisorLifecycleApprovalPersistViewModel(body, res.status));
    logEvent('Supervisor approval record persist request completed', res.status === 201 ? 'info' : 'warning');
  } catch (err) {
    setSupervisorLifecycleApprovalPreviewError(err.message);
    logEvent('Supervisor approval record persist failed: ' + sanitizeSupervisorInstallErrorMessage(err.message), 'error');
  } finally {
    supervisorLifecycleApprovalPersistInFlight = false;
    if (supervisorLifecycleApprovalPersistButton) supervisorLifecycleApprovalPersistButton.disabled = false;
  }
}
```

Register listener:

```js
if (supervisorLifecycleApprovalPersistButton?.addEventListener) {
  supervisorLifecycleApprovalPersistButton.addEventListener('click', persistSupervisorLifecycleApprovalRecord);
}
```

- [ ] **Step 5: Verify GREEN**

Run:

```bash
node --test --test-reporter=dot test/web-console.test.js test/supervisor-lifecycle-approval-persist-api.test.js
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/web/index.html src/web/app.js test/web-console.test.js
git commit -m "feat: add approval persist web action"
```

---

### Task 4: V0.95 Release Metadata And Final Verification

**Files:**
- Modify: `src/version.js`
- Modify: `README.md`
- Modify: `src/gold-readiness.js`
- Modify: `test/version.test.js`
- Modify: `test/readme.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `docs/superpowers/plans/2026-07-07-supervisor-lifecycle-approval-persist-web-api.md`

**Interfaces:**
- Produces: `LINKE_RELEASE_VERSION = 'V0.95'`
- Produces: README current version V0.95
- Produces: Gold evidence for API/Web persist while Gold remains blocked

- [ ] **Step 1: Write RED release tests**

Update `test/version.test.js` expectation to `V0.95`.

In `test/gold-readiness.test.js`, add evidence assertions for:

```js
assert.ok(automationEvidence.includes('POST /api/supervisor-lifecycle-approval-persist'));
assert.ok(automationEvidence.includes('test/supervisor-lifecycle-approval-persist-api.test.js'));
assert.ok(automationEvidence.includes('supervisor-lifecycle-approval-persist-button'));
assert.ok(automationEvidence.includes('test/web-console.test.js supervisor lifecycle approval persist'));
assert.ok(automationItem.nextStep.includes('V0.95'));
assert.ok(automationItem.nextStep.includes('Gold remains blocked') || automationItem.nextStep.includes('real NAS'));
```

In `test/readme.test.js`, add/replace the current V0.94 block with V0.95 expectations:

- title and badge `V0.95`
- table row `| V0.95 | 当前版本 |`
- V0.94 row becomes historical
- README documents `POST /api/supervisor-lifecycle-approval-persist`
- README documents `API_WRITE_ROUTES`
- README documents `supervisor-lifecycle-approval-persist-button`
- README documents `201`, `409`, `failed to persist approval record`, and Gold blocked

- [ ] **Step 2: Verify RED fails**

Run:

```bash
node --test --test-reporter=spec test/version.test.js test/readme.test.js test/gold-readiness.test.js
```

Expected: fail because version/docs/Gold still say V0.94.

- [ ] **Step 3: Update release metadata**

Set `src/version.js`:

```js
export const LINKE_RELEASE_VERSION = 'V0.95';
```

Update README:

- title: `# Linke V0.95`
- badge: `**当前版本：V0.95**`
- table row for V0.95 as current
- V0.94 row as historical
- feature bullet for approval persist Web/API
- dedicated section describing route, status codes, write-route auth, audit events, Web button, redaction, and Gold blocked

Update `src/gold-readiness.js`:

- add `POST /api/supervisor-lifecycle-approval-persist`
- add `test/supervisor-lifecycle-approval-persist-api.test.js`
- add `supervisor-lifecycle-approval-persist-button`
- add `test/web-console.test.js supervisor lifecycle approval persist`
- update nextStep to mention V0.95 and remaining missing guarded lifecycle apply wiring, real installer, rollback, uninstall, recovery supervisor, real NAS remote backup, production auth, secret management, and production audit guarantees

- [ ] **Step 4: Verify release tests**

Run:

```bash
node --test --test-reporter=dot test/version.test.js test/readme.test.js test/gold-readiness.test.js
```

Expected: exit 0.

- [ ] **Step 5: Full verification**

Run:

```bash
node --test --test-reporter=dot test/approval-store.test.js test/agent-supervisor-lifecycle-approval-persist.test.js test/supervisor-lifecycle-approval-persist-api.test.js test/server.test.js test/web-console.test.js test/version.test.js test/readme.test.js test/gold-readiness.test.js
node --test --test-reporter=dot test/*.test.js
git diff --check
git diff -U0 | rg -n "Gold ready|Gold 发布 ready|production-ready|production ready|production approval workflow|rollback ready|uninstall ready|recovery supervisor ready|hostMutation:true|launchctlCalled:true|lifecycleApplied:true|exec\\(|spawn\\(|launchctl |keychain|secret value|token value"
```

Expected:

- focused suite exit 0
- full suite exit 0
- `git diff --check` exit 0
- diff-only overclaim scan has no matches

- [ ] **Step 6: Qwen adversarial review**

Ask Qwen to read the final diff and verify:

- no sensitive values leak
- no lifecycle apply execution
- persist route is in `API_WRITE_ROUTES`
- preview route remains outside `API_WRITE_ROUTES`
- audit events are sanitized
- Web button cannot be mistaken for apply/install/rollback/uninstall
- Gold remains blocked

- [ ] **Step 7: DeepSeek closure**

Ask DeepSeek for JSON closure with:

```json
{
  "status": "PASS",
  "accepted": true,
  "blocking_findings": [],
  "gold_status": "blocked"
}
```

- [ ] **Step 8: Commit and push**

```bash
git add src/version.js README.md src/gold-readiness.js test/version.test.js test/readme.test.js test/gold-readiness.test.js docs/superpowers/plans/2026-07-07-supervisor-lifecycle-approval-persist-web-api.md
git commit -m "feat: add supervisor approval persist web api"
git push origin linke-v0.12-web-panel
```
