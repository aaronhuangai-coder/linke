# Supervisor Install Web Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Web Console supervisor install dry-run panel backed by a non-mutating `/api/supervisor-install-dry-run` preview endpoint.

**Architecture:** The server accepts in-memory Linke config JSON, validates it with the existing `validateConfig`, then returns `buildSupervisorInstallDryRunPlan(config)` without invoking the CLI or touching the filesystem. The Web Console renders a strict allowlist view model so submitted paths, endpoints, credential refs, token-like strings, and runnable command details are not displayed. Documentation and readiness evidence move to V0.84 while Gold remains blocked.

**Tech Stack:** Node.js ESM, built-in `node:test`, existing static Web Console (`src/web/index.html`, `src/web/app.js`, `src/web/styles.css`), existing `src/server.js` HTTP router.

## Global Constraints

- V0.84 remains dry-run-only and Gold-blocked.
- Do not install, start, approve, roll back, uninstall, write files, call `launchctl`, read process lists, connect NAS, trigger backup/restore, execute remote commands, or claim Gold readiness.
- The new POST route is a dry-run preview, not a write operation; do not add it to `API_WRITE_ROUTES`.
- The new route must parse only request-body JSON; it must not read config files or call the CLI.
- The UI must not request `/api/supervisor-install-dry-run` on initialization and must not auto-poll.
- The UI must not render raw `serverUrl`, `sourcePath`, NAS `endpoint`, `remotePath`, `credentialRef`, token-like values, Authorization, approval identity, approval timestamp, config path, plist path, executable path, or runnable command arguments.
- Keep existing V0.83 CLI semantics unchanged: `supervisor-install-dry-run`, `--readiness-summary`, `--fail-on-blocked`, and `--output` rejection still behave as they do now.
- Keep `automation-installation` and `production-hardening` as `partial`; keep `real-nas-remote-backup` as `blocked`.

---

## File Structure

- Modify `src/server.js`
  - Import `validateConfig` and `buildSupervisorInstallDryRunPlan`.
  - Add POST `/api/supervisor-install-dry-run` route after the NAS dry-run route.
- Modify `src/web/index.html`
  - Add `supervisor-install-dry-run-panel` with config textarea, run button, four stat fields, result area, and safety note.
- Modify `src/web/app.js`
  - Export `buildSupervisorInstallDryRunViewModel(plan, errorMessage = '')`.
  - Add DOM refs, renderer, fetch function, in-flight guard, and click listener.
- Modify `src/web/styles.css`
  - Add styling for the new panel, stats, result groups, status rows, and error block.
- Modify `test/web-console.test.js`
  - Add API, HTML, JS/CSS contract, view model, and DOM behavior tests.
- Modify `src/gold-readiness.js`, `src/version.js`, `README.md`, `test/gold-readiness.test.js`, `test/readme.test.js`, `test/version.test.js`
  - Document V0.84 evidence without changing Gold blocked status.

## Task 1: Backend Dry-Run Preview API

**Files:**
- Modify: `src/server.js`
- Modify: `test/web-console.test.js`

**Interfaces:**
- Consumes: `validateConfig(config)` from `src/config.js`; `buildSupervisorInstallDryRunPlan(config)` from `src/agent.js`
- Produces: `POST /api/supervisor-install-dry-run` returning the same sanitized full dry-run plan shape as the CLI full output

- [ ] **Step 1: Write failing API tests**

Add tests near the existing `POST /api/nas-dry-run` tests in `test/web-console.test.js`:

```js
  // ── V0.84 POST /api/supervisor-install-dry-run ─────────────────

  it('POST /api/supervisor-install-dry-run returns a sanitized blocked dry-run supervisor install plan', async () => {
    const res = await fetch(`http://localhost:${port}/api/supervisor-install-dry-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverUrl: 'http://localhost:3000',
        deviceId: 'web-supervisor-dry-run',
        backupJobs: [{ name: 'documents', sourcePath: '/tmp/linke-documents' }],
        excludePatterns: ['*.tmp'],
        scheduleSeconds: 3600,
        nasTargets: [
          {
            name: 'synology-web',
            provider: 'synology',
            endpoint: 'http://192.168.1.100:5000',
            shareName: 'backup',
            remotePath: '/volume1/backup',
            enabled: true,
            credentialRef: 'nas-ref',
          },
        ],
      }),
    });
    const body = await res.json();
    const text = JSON.stringify(body);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.status, 'partial');
    assert.strictEqual(body.command, 'supervisor-install-dry-run');
    assert.strictEqual(body.supervisor.state, 'not_configured');
    assert.strictEqual(body.supervisor.wouldInstall, false);
    assert.strictEqual(body.supervisor.wouldStart, false);
    assert.strictEqual(body.safety.launchctlCalled, false);
    assert.strictEqual(body.safety.processListRead, false);
    assert.strictEqual(body.safety.launchdFileWritten, false);
    assert.strictEqual(body.safety.metadataWritten, false);
    assert.strictEqual(body.safety.nasConnected, false);
    assert.strictEqual(body.safety.backupTriggered, false);
    assert.strictEqual(body.safety.restoreTriggered, false);
    assert.strictEqual(body.safety.remoteCommandExecuted, false);
    assert.strictEqual(body.readinessSummary.state, 'blocked');
    assert.strictEqual(body.installCommandPreview.state, 'blocked');
    assert.ok(body.installCommandPreview.actions.every((action) => action.wouldRun === false));
    assert.ok(body.installCommandPreview.actions.every((action) => action.wouldWrite === false));
    assert.strictEqual(body.installPreflight.state, 'blocked');
    assert.strictEqual(body.installApprovalManifest.state, 'blocked');
    assert.strictEqual(body.installApprovalManifest.approval.approved, false);
    assert.strictEqual(body.installApprovalManifest.rollback.available, false);

    assert.ok(!text.includes('/tmp/linke-documents'), 'must not echo sourcePath');
    assert.ok(!text.includes('http://localhost:3000'), 'must not echo serverUrl');
    assert.ok(!text.includes('192.168.1.100'), 'must not echo NAS endpoint');
    assert.ok(!text.includes('nas-ref'), 'must not echo credentialRef');
  });

  it('POST /api/supervisor-install-dry-run rejects invalid JSON body', async () => {
    const res = await fetch(`http://localhost:${port}/api/supervisor-install-dry-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ invalid json',
    });
    const body = await res.json();

    assert.strictEqual(res.status, 400);
    assert.match(body.error, /Invalid JSON body/);
  });

  it('POST /api/supervisor-install-dry-run rejects invalid config without echoing submitted values', async () => {
    const res = await fetch(`http://localhost:${port}/api/supervisor-install-dry-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverUrl: 'not-a-url-secret-like-value',
        deviceId: 'web-supervisor-dry-run',
        backupJobs: [{ name: 'documents', sourcePath: '/tmp/linke-documents' }],
      }),
    });
    const body = await res.json();
    const text = JSON.stringify(body);

    assert.strictEqual(res.status, 400);
    assert.match(body.error, /serverUrl/i);
    assert.ok(!text.includes('not-a-url-secret-like-value'), 'must not echo invalid serverUrl value');
    assert.ok(!text.includes('/tmp/linke-documents'), 'must not echo sourcePath on validation errors');
  });

  it('POST /api/supervisor-install-dry-run rejects credential-like NAS fields without echoing secret values', async () => {
    const res = await fetch(`http://localhost:${port}/api/supervisor-install-dry-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverUrl: 'http://localhost:3000',
        deviceId: 'web-supervisor-dry-run',
        backupJobs: [{ name: 'documents', sourcePath: '/tmp/linke-documents' }],
        nasTargets: [
          {
            name: 'synology-web',
            provider: 'synology',
            endpoint: 'http://192.168.1.100:5000',
            shareName: 'backup',
            remotePath: '/volume1/backup',
            password: 'do-not-echo-this-secret',
          },
        ],
      }),
    });
    const body = await res.json();
    const text = JSON.stringify(body);

    assert.strictEqual(res.status, 400);
    assert.match(body.error, /credential|not allowed|forbidden|password/i);
    assert.ok(!text.includes('do-not-echo-this-secret'), 'must not echo submitted secret value');
    assert.ok(!text.includes('192.168.1.100'), 'must not echo NAS endpoint on validation errors');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test --test-reporter=dot test/web-console.test.js
```

Expected: FAIL because `/api/supervisor-install-dry-run` returns `404`.

- [ ] **Step 3: Add the server route**

In `src/server.js`, add imports near the existing imports:

```js
import { validateConfig } from './config.js';
import { buildSupervisorInstallDryRunPlan } from './agent.js';
```

Add this route immediately after the `POST /api/nas-dry-run` block:

```js
      // POST /api/supervisor-install-dry-run
      // Dry-run preview only. This POST is not a write operation and must not
      // be copied for mutating routes without also updating API_WRITE_ROUTES.
      if (method === 'POST' && pathname === '/api/supervisor-install-dry-run') {
        let body;
        try {
          body = await readBody(req);
        } catch (err) {
          if (err.statusCode === 400) {
            return sendError(res, 400, err.message);
          }
          throw err;
        }

        try {
          const config = validateConfig(body);
          const plan = buildSupervisorInstallDryRunPlan(config);
          return sendJSON(res, 200, plan);
        } catch (err) {
          return sendError(res, 400, err.message);
        }
      }
```

- [ ] **Step 4: Run API tests**

Run:

```bash
node --test --test-reporter=dot test/web-console.test.js
```

Expected: PASS for the new API tests. If other existing Web Console tests fail, fix only regressions caused by this task.

- [ ] **Step 5: Commit**

```bash
git add src/server.js test/web-console.test.js
git commit -m "feat: add supervisor install dry-run API"
```

## Task 2: Web Console Panel and View Model

**Files:**
- Modify: `src/web/index.html`
- Modify: `src/web/app.js`
- Modify: `src/web/styles.css`
- Modify: `test/web-console.test.js`

**Interfaces:**
- Consumes: `POST /api/supervisor-install-dry-run`
- Produces: `buildSupervisorInstallDryRunViewModel(plan, errorMessage = '')`; DOM hooks listed in the design spec

- [ ] **Step 1: Add failing HTML/JS/CSS contract tests**

Add tests in `test/web-console.test.js` near the supervisor-status and NAS dry-run panel tests:

```js
  it('HTML contains supervisor-install-dry-run panel with required data-testid hooks', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.ok(html.includes('data-testid="supervisor-install-dry-run-panel"'), 'must have supervisor-install-dry-run-panel');
    assert.ok(html.includes('data-testid="supervisor-install-dry-run-config"'), 'must have supervisor-install-dry-run-config textarea');
    assert.ok(html.includes('data-testid="supervisor-install-dry-run-run"'), 'must have supervisor-install-dry-run-run button');
    assert.ok(html.includes('data-testid="supervisor-install-dry-run-status"'), 'must have supervisor-install-dry-run-status stat');
    assert.ok(html.includes('data-testid="supervisor-install-dry-run-install-state"'), 'must have supervisor-install-dry-run-install-state stat');
    assert.ok(html.includes('data-testid="supervisor-install-dry-run-approval-state"'), 'must have supervisor-install-dry-run-approval-state stat');
    assert.ok(html.includes('data-testid="supervisor-install-dry-run-rollback-state"'), 'must have supervisor-install-dry-run-rollback-state stat');
    assert.ok(html.includes('data-testid="supervisor-install-dry-run-result"'), 'must have supervisor-install-dry-run-result');
    assert.ok(html.includes('data-testid="supervisor-install-dry-run-safety-note"'), 'must have supervisor-install-dry-run-safety-note');
  });

  it('supervisor-install-dry-run panel safety note documents manual dry-run boundaries and avoids Gold overclaims', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    const panelMatch = html.match(/data-testid="supervisor-install-dry-run-panel"[\s\S]*?<\/section>/);

    assert.ok(panelMatch, 'supervisor-install-dry-run-panel section must exist');
    const content = panelMatch[0];
    assert.ok(content.includes('POST /api/supervisor-install-dry-run'), 'must mention POST endpoint');
    assert.match(content, /dry-run|只读|预览/);
    assert.match(content, /无启动请求|不自动轮询/);
    assert.match(content, /不调用 launchctl/);
    assert.match(content, /不读取进程列表/);
    assert.match(content, /不安装|不启动/);
    assert.match(content, /不写入 metadata|不写 metadata/);
    assert.match(content, /不连接 NAS/);
    assert.match(content, /不触发备份或恢复|不执行备份或恢复/);
    assert.match(content, /不执行远程命令/);
    assert.match(content, /不声明.*Gold|Gold.*blocked|Gold.*未完成/);
  });

  it('app.js wires supervisor-install-dry-run rendering contract', async () => {
    const js = await readFile(join(process.cwd(), 'src/web/app.js'), 'utf-8');

    assert.ok(js.includes('/api/supervisor-install-dry-run'), 'app.js must reference /api/supervisor-install-dry-run');
    assert.ok(js.includes('buildSupervisorInstallDryRunViewModel'), 'app.js must export supervisor install dry-run view model');
    assert.ok(js.includes('supervisor-install-dry-run-run') || js.includes('supervisorInstallDryRunRun'), 'app.js must reference the run button');
  });

  it('styles.css contains supervisor-install-dry-run panel styles', async () => {
    const css = await readFile(join(process.cwd(), 'src/web/styles.css'), 'utf-8');

    assert.ok(css.includes('.supervisor-install-dry-run-panel'), 'styles.css must contain panel styles');
    assert.ok(css.includes('.supervisor-install-dry-run-error'), 'styles.css must contain error styles');
  });
```

Also update the existing app import list at the top of `test/web-console.test.js` to include:

```js
  buildSupervisorInstallDryRunViewModel,
```

- [ ] **Step 2: Add failing view model tests**

Add these tests near the existing view model tests:

```js
describe('buildSupervisorInstallDryRunViewModel', () => {
  it('returns unknown state for missing payload', () => {
    const result = buildSupervisorInstallDryRunViewModel(null);

    assert.strictEqual(result.statusKey, 'unknown');
    assert.strictEqual(result.statusText, '未检查');
    assert.strictEqual(result.installStateText, '—');
    assert.strictEqual(result.approvalStateText, '—');
    assert.strictEqual(result.rollbackStateText, '—');
    assert.match(result.messageText, /supervisor install dry-run/i);
  });

  it('returns sanitized blocked display fields for a full dry-run plan', () => {
    const result = buildSupervisorInstallDryRunViewModel({
      status: 'partial',
      command: 'supervisor-install-dry-run',
      supervisor: {
        state: 'not_configured',
        wouldInstall: false,
        wouldStart: false,
        program: 'node src/agent.js run-once --config /Users/ah/secret-config.json',
      },
      readinessSummary: {
        state: 'blocked',
        blockers: ['real-install-not-implemented'],
      },
      installCommandPreview: {
        state: 'blocked',
        actions: [
          {
            id: 'write-launch-agent-plist',
            command: 'launchctl bootstrap gui/501 /Users/ah/Library/LaunchAgents/com.linke.agent.plist',
            wouldRun: false,
            wouldWrite: false,
          },
        ],
      },
      installPreflight: {
        state: 'blocked',
        checks: [
          { id: 'launchd-install', status: 'blocked', blockerCode: 'launchd-install-blocked' },
        ],
      },
      installApprovalManifest: {
        state: 'blocked',
        approval: { approved: false },
        rollback: { available: false },
        controls: [
          { id: 'explicit-operator-approval', status: 'blocked', blockerCode: 'operator-approval-required' },
        ],
      },
      safety: {
        launchctlCalled: false,
        processListRead: false,
        launchdFileWritten: false,
        metadataWritten: false,
        nasConnected: false,
        backupTriggered: false,
        restoreTriggered: false,
        remoteCommandExecuted: false,
      },
      configSummary: {
        deviceId: 'secret-device',
      },
    });
    const text = JSON.stringify(result);

    assert.strictEqual(result.statusKey, 'partial');
    assert.strictEqual(result.statusText, 'Partial');
    assert.strictEqual(result.installStateText, 'not_configured / wouldInstall:false / wouldStart:false');
    assert.strictEqual(result.approvalStateText, 'approved:false');
    assert.strictEqual(result.rollbackStateText, 'available:false');
    assert.deepStrictEqual(result.readinessBlockers, ['real-install-not-implemented']);
    assert.deepStrictEqual(result.commandActions, ['write-launch-agent-plist · wouldRun:false · wouldWrite:false']);
    assert.deepStrictEqual(result.preflightChecks, ['launchd-install · blocked · launchd-install-blocked']);
    assert.deepStrictEqual(result.approvalControls, ['explicit-operator-approval · blocked · operator-approval-required']);
    assert.ok(result.safetyLines.includes('launchctlCalled:false'));
    assert.ok(!text.includes('/Users/ah/secret-config.json'), 'view model must not expose config path');
    assert.ok(!text.includes('launchctl bootstrap'), 'view model must not expose runnable command');
    assert.ok(!text.includes('secret-device'), 'view model must not expose arbitrary config summary strings');
  });

  it('returns sanitized error state', () => {
    const result = buildSupervisorInstallDryRunViewModel(null, 'serverUrl secret-value is invalid');

    assert.strictEqual(result.statusKey, 'error');
    assert.strictEqual(result.statusText, '检查失败');
    assert.ok(!result.messageText.includes('secret-value'), 'error message must be sanitized');
  });
});
```

- [ ] **Step 3: Add failing DOM behavior tests**

Add tests near existing DOM tests for NAS dry-run and supervisor-status:

```js
describe('DOM test: supervisor-install-dry-run panel interactions', () => {
  it('does not request /api/supervisor-install-dry-run on initialization', async () => {
    let fetchCount = 0;
    const doc = buildMockDoc();
    const fetchImpl = async (url) => {
      if (String(url).includes('/api/supervisor-install-dry-run')) fetchCount++;
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, fetchImpl, () => {});

    assert.strictEqual(fetchCount, 0, 'should not call /api/supervisor-install-dry-run on init');
  });

  it('validates empty and invalid JSON locally without calling the API', async () => {
    const calls = [];
    const doc = buildMockDoc();
    initConsole(
      doc,
      async (url) => {
        calls.push(url);
        return { ok: true, status: 200, json: async () => [] };
      },
      () => {},
    );

    doc.getElementById('supervisor-install-dry-run-config').value = '   ';
    doc.getElementById('supervisor-install-dry-run-run')._listeners.click();
    assert.ok(!calls.some((url) => String(url).includes('/api/supervisor-install-dry-run')));
    assert.match(doc.getElementById('supervisor-install-dry-run-result').textContent, /不能为空/);

    doc.getElementById('supervisor-install-dry-run-config').value = '{ invalid json';
    doc.getElementById('supervisor-install-dry-run-run')._listeners.click();
    assert.ok(!calls.some((url) => String(url).includes('/api/supervisor-install-dry-run')));
    assert.match(doc.getElementById('supervisor-install-dry-run-result').textContent, /JSON 格式错误/);
  });

  it('requests supervisor install dry-run once and renders sanitized blocked plan fields', async () => {
    const calls = [];
    const doc = buildMockDoc();
    initConsole(
      doc,
      async (url, options) => {
        calls.push({ url, options });
        if (String(url).includes('/api/supervisor-install-dry-run')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
            status: 'partial',
            command: 'supervisor-install-dry-run',
            supervisor: { state: 'not_configured', wouldInstall: false, wouldStart: false },
            readinessSummary: { state: 'blocked', blockers: ['real-install-not-implemented'] },
            installCommandPreview: {
              state: 'blocked',
              actions: [{ id: 'write-launch-agent-plist', command: 'launchctl bootstrap secret', wouldRun: false, wouldWrite: false }],
            },
            installPreflight: {
              state: 'blocked',
              checks: [{ id: 'operator-approval', status: 'blocked', blockerCode: 'operator-approval-required' }],
            },
            installApprovalManifest: {
              state: 'blocked',
              approval: { approved: false },
              rollback: { available: false },
              controls: [{ id: 'explicit-operator-approval', status: 'blocked', blockerCode: 'operator-approval-required' }],
            },
            safety: {
              launchctlCalled: false,
              processListRead: false,
              launchdFileWritten: false,
              metadataWritten: false,
              nasConnected: false,
              backupTriggered: false,
              restoreTriggered: false,
              remoteCommandExecuted: false,
            },
          }),
          };
        }
        return { ok: true, status: 200, json: async () => [] };
      },
      () => {},
    );

    doc.getElementById('supervisor-install-dry-run-config').value = JSON.stringify({
      serverUrl: 'http://secret.localhost:3000',
      deviceId: 'web-supervisor-dry-run',
      backupJobs: [{ name: 'documents', sourcePath: '/tmp/linke-documents' }],
      nasTargets: [{ name: 'synology-web', provider: 'synology', endpoint: 'http://192.168.1.100:5000', shareName: 'backup', remotePath: '/volume1/backup', credentialRef: 'nas-ref' }],
    });
    doc.getElementById('supervisor-install-dry-run-run')._listeners.click();
    await new Promise((resolve) => setImmediate(resolve));

    const apiCall = calls.find((call) => String(call.url).includes('/api/supervisor-install-dry-run'));
    assert.ok(apiCall, 'must call supervisor install dry-run API');
    assert.strictEqual(apiCall.options.method, 'POST');
    assert.strictEqual(doc.getElementById('supervisor-install-dry-run-status').textContent, 'Partial');
    assert.strictEqual(doc.getElementById('supervisor-install-dry-run-install-state').textContent, 'not_configured / wouldInstall:false / wouldStart:false');
    assert.strictEqual(doc.getElementById('supervisor-install-dry-run-approval-state').textContent, 'approved:false');
    assert.strictEqual(doc.getElementById('supervisor-install-dry-run-rollback-state').textContent, 'available:false');

    const resultText = doc.getElementById('supervisor-install-dry-run-result').textContent;
    assert.match(resultText, /real-install-not-implemented/);
    assert.match(resultText, /write-launch-agent-plist/);
    assert.match(resultText, /wouldRun:false/);
    assert.match(resultText, /operator-approval-required/);
    assert.match(resultText, /launchctlCalled:false/);
    assert.ok(!resultText.includes('secret.localhost'), 'must not render serverUrl');
    assert.ok(!resultText.includes('/tmp/linke-documents'), 'must not render sourcePath');
    assert.ok(!resultText.includes('192.168.1.100'), 'must not render NAS endpoint');
    assert.ok(!resultText.includes('nas-ref'), 'must not render credentialRef');
    assert.ok(!resultText.includes('launchctl bootstrap secret'), 'must not render runnable command');
  });

  it('does not start a second supervisor install dry-run request while one is in flight', async () => {
    let fetchCount = 0;
    let resolveRequest;
    const doc = buildMockDoc();
    initConsole(
      doc,
      async (url) => {
        if (String(url).includes('/api/supervisor-install-dry-run')) {
          fetchCount++;
          await new Promise((resolve) => { resolveRequest = resolve; });
          return {
            ok: true,
            status: 200,
            json: async () => ({
            status: 'partial',
            supervisor: { state: 'not_configured', wouldInstall: false, wouldStart: false },
            readinessSummary: { state: 'blocked', blockers: [] },
            installCommandPreview: { state: 'blocked', actions: [] },
            installPreflight: { state: 'blocked', checks: [] },
            installApprovalManifest: { state: 'blocked', approval: { approved: false }, rollback: { available: false }, controls: [] },
            safety: {},
          }),
          };
        }
        return { ok: true, status: 200, json: async () => [] };
      },
      () => {},
    );

    doc.getElementById('supervisor-install-dry-run-config').value = JSON.stringify({
      serverUrl: 'http://localhost:3000',
      deviceId: 'web-supervisor-dry-run',
      backupJobs: [{ name: 'documents', sourcePath: '/tmp/source' }],
    });
    const runBtn = doc.getElementById('supervisor-install-dry-run-run');
    runBtn._listeners.click();
    runBtn._listeners.click();
    assert.strictEqual(fetchCount, 1, 'in-flight guard must block duplicate requests');

    resolveRequest();
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('renders sanitized error on non-2xx supervisor install dry-run response', async () => {
    const doc = buildMockDoc();
    initConsole(
      doc,
      async (url) => {
        if (String(url).includes('/api/supervisor-install-dry-run')) {
          return { ok: false, status: 400, json: async () => ({ error: 'serverUrl secret-value invalid' }) };
        }
        return { ok: true, status: 200, json: async () => [] };
      },
      () => {},
    );

    doc.getElementById('supervisor-install-dry-run-config').value = JSON.stringify({
      serverUrl: 'http://localhost:3000',
      deviceId: 'web-supervisor-dry-run',
      backupJobs: [{ name: 'documents', sourcePath: '/tmp/source' }],
    });
    doc.getElementById('supervisor-install-dry-run-run')._listeners.click();
    await new Promise((resolve) => setImmediate(resolve));

    const text = doc.getElementById('supervisor-install-dry-run-result').textContent;
    assert.match(text, /检查失败|加载失败|失败/);
    assert.ok(!text.includes('secret-value'), 'must redact secret-like error detail');
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run:

```bash
node --test --test-reporter=dot test/web-console.test.js
```

Expected: FAIL because the panel, view model, and DOM wiring do not exist.

- [ ] **Step 5: Add HTML panel**

In `src/web/index.html`, insert after the `supervisor-status-panel` section:

```html
      <section id="supervisor-install-dry-run-panel" class="panel supervisor-install-dry-run-panel" data-testid="supervisor-install-dry-run-panel">
        <h2>Supervisor install dry-run</h2>
        <div class="supervisor-install-dry-run-controls">
          <label for="supervisor-install-dry-run-config">配置 JSON</label>
          <textarea
            id="supervisor-install-dry-run-config"
            data-testid="supervisor-install-dry-run-config"
            rows="10"
          >{
  "serverUrl": "http://localhost:3000",
  "deviceId": "web-supervisor-dry-run",
  "backupJobs": [
    { "name": "documents", "sourcePath": "/tmp/linke-documents" }
  ],
  "excludePatterns": ["*.tmp", "node_modules"],
  "scheduleSeconds": 3600
}</textarea>
          <button id="supervisor-install-dry-run-run" data-testid="supervisor-install-dry-run-run" type="button">Supervisor dry-run</button>
        </div>
        <div class="supervisor-install-dry-run-stats">
          <div class="supervisor-install-dry-run-stat">
            <span id="supervisor-install-dry-run-status" data-testid="supervisor-install-dry-run-status">未检查</span>
            <span>状态</span>
          </div>
          <div class="supervisor-install-dry-run-stat">
            <span id="supervisor-install-dry-run-install-state" data-testid="supervisor-install-dry-run-install-state">—</span>
            <span>安装门禁</span>
          </div>
          <div class="supervisor-install-dry-run-stat">
            <span id="supervisor-install-dry-run-approval-state" data-testid="supervisor-install-dry-run-approval-state">—</span>
            <span>批准</span>
          </div>
          <div class="supervisor-install-dry-run-stat">
            <span id="supervisor-install-dry-run-rollback-state" data-testid="supervisor-install-dry-run-rollback-state">—</span>
            <span>Rollback</span>
          </div>
        </div>
        <div id="supervisor-install-dry-run-result" data-testid="supervisor-install-dry-run-result">
          <p class="placeholder">请粘贴配置 JSON 进行 Supervisor install dry-run 预检</p>
        </div>
        <div class="supervisor-install-dry-run-safety-note" data-testid="supervisor-install-dry-run-safety-note">
          <p>Supervisor install dry-run 仅手动 POST /api/supervisor-install-dry-run 生成只读预览，无启动请求、不自动轮询、不调用 launchctl、不读取进程列表、不安装或启动 supervisor、不写入 metadata、不连接 NAS、不触发备份或恢复、不执行远程命令；仅展示 allowlist 字段，不显示 token、Authorization header、serverUrl、sourcePath、NAS endpoint、credentialRef、approval identity、timestamp、plist path、executable path 或 runnable command；Gold 仍 blocked，不能声明生产就绪。</p>
        </div>
      </section>
```

- [ ] **Step 6: Add view model helper**

In `src/web/app.js`, add the exported helper near the other view model helpers:

```js
function sanitizeSupervisorInstallErrorMessage(message) {
  const raw = String(message || '').trim();
  if (!raw) return '请求失败';
  return raw
    .replace(/https?:\/\/[^\s"']+/gi, '[redacted-url]')
    .replace(/\/Users\/[^\s"']+/g, '[redacted-path]')
    .replace(/secret[-_\w]*/gi, '[redacted-secret]')
    .replace(/token[-_\w]*/gi, '[redacted-token]')
    .slice(0, 180);
}

function normalizeStringList(values) {
  return Array.isArray(values)
    ? values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim())
    : [];
}

function buildSupervisorInstallSafetyLines(safety) {
  const source = safety && typeof safety === 'object' ? safety : {};
  return [
    'launchctlCalled',
    'processListRead',
    'launchdFileWritten',
    'metadataWritten',
    'nasConnected',
    'backupTriggered',
    'restoreTriggered',
    'remoteCommandExecuted',
  ].map((key) => `${key}:${source[key] === true ? 'true' : 'false'}`);
}

export function buildSupervisorInstallDryRunViewModel(plan, errorMessage = '') {
  if (errorMessage) {
    return {
      statusKey: 'error',
      statusText: '检查失败',
      installStateText: '—',
      approvalStateText: '—',
      rollbackStateText: '—',
      readinessBlockers: [],
      commandActions: [],
      preflightChecks: [],
      approvalControls: [],
      safetyLines: [],
      messageText: 'Supervisor install dry-run 检查失败: ' + sanitizeSupervisorInstallErrorMessage(errorMessage),
    };
  }

  if (!plan || typeof plan !== 'object') {
    return {
      statusKey: 'unknown',
      statusText: '未检查',
      installStateText: '—',
      approvalStateText: '—',
      rollbackStateText: '—',
      readinessBlockers: [],
      commandActions: [],
      preflightChecks: [],
      approvalControls: [],
      safetyLines: [],
      messageText: '点击 Supervisor dry-run 手动 POST /api/supervisor-install-dry-run',
    };
  }

  const supervisor = plan.supervisor && typeof plan.supervisor === 'object' ? plan.supervisor : {};
  const readiness = plan.readinessSummary && typeof plan.readinessSummary === 'object' ? plan.readinessSummary : {};
  const commandPreview = plan.installCommandPreview && typeof plan.installCommandPreview === 'object' ? plan.installCommandPreview : {};
  const preflight = plan.installPreflight && typeof plan.installPreflight === 'object' ? plan.installPreflight : {};
  const manifest = plan.installApprovalManifest && typeof plan.installApprovalManifest === 'object' ? plan.installApprovalManifest : {};
  const approval = manifest.approval && typeof manifest.approval === 'object' ? manifest.approval : {};
  const rollback = manifest.rollback && typeof manifest.rollback === 'object' ? manifest.rollback : {};

  const statusKey = ['ready', 'partial', 'blocked'].includes(plan.status) ? plan.status : 'partial';

  return {
    statusKey,
    statusText: formatHardeningStatusText(statusKey),
    installStateText: `${formatAuditDisplayString(supervisor.state) || 'unknown'} / wouldInstall:${supervisor.wouldInstall === true ? 'true' : 'false'} / wouldStart:${supervisor.wouldStart === true ? 'true' : 'false'}`,
    approvalStateText: `approved:${approval.approved === true ? 'true' : 'false'}`,
    rollbackStateText: `available:${rollback.available === true ? 'true' : 'false'}`,
    readinessBlockers: normalizeStringList(readiness.blockers),
    commandActions: Array.isArray(commandPreview.actions)
      ? commandPreview.actions.map((action) => {
        const source = action && typeof action === 'object' ? action : {};
        return `${formatAuditDisplayString(source.id) || 'unknown'} · wouldRun:${source.wouldRun === true ? 'true' : 'false'} · wouldWrite:${source.wouldWrite === true ? 'true' : 'false'}`;
      })
      : [],
    preflightChecks: Array.isArray(preflight.checks)
      ? preflight.checks.map((check) => {
        const source = check && typeof check === 'object' ? check : {};
        return `${formatAuditDisplayString(source.id) || 'unknown'} · ${formatAuditDisplayString(source.status) || 'unknown'} · ${formatAuditDisplayString(source.blockerCode) || 'none'}`;
      })
      : [],
    approvalControls: Array.isArray(manifest.controls)
      ? manifest.controls.map((control) => {
        const source = control && typeof control === 'object' ? control : {};
        return `${formatAuditDisplayString(source.id) || 'unknown'} · ${formatAuditDisplayString(source.status) || 'unknown'} · ${formatAuditDisplayString(source.blockerCode) || 'none'}`;
      })
      : [],
    safetyLines: buildSupervisorInstallSafetyLines(plan.safety),
    messageText: 'POST /api/supervisor-install-dry-run 成功，仍为 blocked dry-run 预览',
  };
}
```

- [ ] **Step 7: Wire DOM refs, renderer, fetch, and listener**

In `initConsole`, add DOM refs near the NAS dry-run refs:

```js
  const supervisorInstallDryRunConfigInput = doc.getElementById('supervisor-install-dry-run-config');
  const supervisorInstallDryRunRunButton = doc.getElementById('supervisor-install-dry-run-run');
  const supervisorInstallDryRunStatusEl = doc.getElementById('supervisor-install-dry-run-status');
  const supervisorInstallDryRunInstallStateEl = doc.getElementById('supervisor-install-dry-run-install-state');
  const supervisorInstallDryRunApprovalStateEl = doc.getElementById('supervisor-install-dry-run-approval-state');
  const supervisorInstallDryRunRollbackStateEl = doc.getElementById('supervisor-install-dry-run-rollback-state');
  const supervisorInstallDryRunResultEl = doc.getElementById('supervisor-install-dry-run-result');
```

Add in-flight state near existing status in-flight booleans:

```js
  let supervisorInstallDryRunInFlight = false;
```

Add renderer and fetch functions near the NAS dry-run functions:

```js
  function setSupervisorInstallDryRunError(message) {
    const viewModel = buildSupervisorInstallDryRunViewModel(null, message);
    renderSupervisorInstallDryRun(viewModel);
  }

  function appendSupervisorInstallGroup(titleText, lines) {
    if (!supervisorInstallDryRunResultEl || lines.length === 0) return;
    const group = doc.createElement('div');
    group.className = 'supervisor-install-dry-run-group';

    const title = doc.createElement('h3');
    title.textContent = titleText;
    group.appendChild(title);

    const list = doc.createElement('ul');
    lines.forEach((line) => {
      const item = doc.createElement('li');
      item.textContent = line;
      list.appendChild(item);
    });
    group.appendChild(list);
    supervisorInstallDryRunResultEl.appendChild(group);
  }

  function renderSupervisorInstallDryRun(viewModel) {
    const state = viewModel || buildSupervisorInstallDryRunViewModel(null);
    if (supervisorInstallDryRunStatusEl) supervisorInstallDryRunStatusEl.textContent = state.statusText;
    if (supervisorInstallDryRunInstallStateEl) supervisorInstallDryRunInstallStateEl.textContent = state.installStateText;
    if (supervisorInstallDryRunApprovalStateEl) supervisorInstallDryRunApprovalStateEl.textContent = state.approvalStateText;
    if (supervisorInstallDryRunRollbackStateEl) supervisorInstallDryRunRollbackStateEl.textContent = state.rollbackStateText;
    if (!supervisorInstallDryRunResultEl) return;

    clearElement(supervisorInstallDryRunResultEl);
    if (state.statusKey === 'error') {
      const error = doc.createElement('div');
      error.className = 'supervisor-install-dry-run-error';
      error.textContent = state.messageText;
      supervisorInstallDryRunResultEl.appendChild(error);
      return;
    }

    const message = doc.createElement('p');
    message.className = 'placeholder';
    message.textContent = state.messageText;
    supervisorInstallDryRunResultEl.appendChild(message);

    appendSupervisorInstallGroup('Readiness blockers', state.readinessBlockers);
    appendSupervisorInstallGroup('Command preview', state.commandActions);
    appendSupervisorInstallGroup('Install preflight', state.preflightChecks);
    appendSupervisorInstallGroup('Approval manifest', state.approvalControls);
    appendSupervisorInstallGroup('Safety flags', state.safetyLines);
  }

  async function fetchSupervisorInstallDryRunPlan() {
    if (!supervisorInstallDryRunResultEl || supervisorInstallDryRunInFlight) return;

    const parsed = parseNasDryRunConfig(supervisorInstallDryRunConfigInput ? supervisorInstallDryRunConfigInput.value : '');
    if (!parsed.ok) {
      setSupervisorInstallDryRunError(parsed.error);
      return;
    }

    supervisorInstallDryRunInFlight = true;
    if (supervisorInstallDryRunRunButton) supervisorInstallDryRunRunButton.disabled = true;
    clearElement(supervisorInstallDryRunResultEl);
    const loading = doc.createElement('p');
    loading.className = 'placeholder';
    loading.textContent = '加载中...';
    supervisorInstallDryRunResultEl.appendChild(loading);

    try {
      const res = await apiFetch('/api/supervisor-install-dry-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.config),
      });
      if (!res.ok) {
        let errBody;
        try {
          errBody = await res.json();
        } catch (_) {
          errBody = {};
        }
        throw new Error(errBody.error || 'HTTP ' + res.status);
      }
      const plan = await res.json();
      renderSupervisorInstallDryRun(buildSupervisorInstallDryRunViewModel(plan));
      logEvent('已加载 Supervisor install dry-run 预检', 'info');
    } catch (err) {
      setSupervisorInstallDryRunError(err.message);
      logEvent('加载 Supervisor install dry-run 失败: ' + sanitizeSupervisorInstallErrorMessage(err.message), 'error');
    } finally {
      supervisorInstallDryRunInFlight = false;
      if (supervisorInstallDryRunRunButton) supervisorInstallDryRunRunButton.disabled = false;
    }
  }
```

Add initialization and listener near the existing NAS dry-run wiring:

```js
  renderSupervisorInstallDryRun(buildSupervisorInstallDryRunViewModel(null));

  if (supervisorInstallDryRunRunButton?.addEventListener) {
    supervisorInstallDryRunRunButton.addEventListener('click', fetchSupervisorInstallDryRunPlan);
  }
```

- [ ] **Step 8: Add CSS**

In `src/web/styles.css`, add styles near the NAS dry-run styles:

```css
.supervisor-install-dry-run-panel {
  border-color: rgba(132, 87, 255, 0.28);
}

.supervisor-install-dry-run-controls {
  display: grid;
  gap: 10px;
}

.supervisor-install-dry-run-controls textarea {
  min-height: 180px;
  resize: vertical;
}

.supervisor-install-dry-run-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
  margin: 14px 0;
}

.supervisor-install-dry-run-stat {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
}

.supervisor-install-dry-run-stat span:first-child {
  display: block;
  font-weight: 700;
}

.supervisor-install-dry-run-group {
  margin-top: 12px;
}

.supervisor-install-dry-run-group h3 {
  margin: 0 0 6px;
  font-size: 0.95rem;
}

.supervisor-install-dry-run-group ul {
  margin: 0;
  padding-left: 18px;
}

.supervisor-install-dry-run-error {
  color: var(--danger);
  font-weight: 700;
}

.supervisor-install-dry-run-safety-note {
  margin-top: 12px;
  color: var(--muted);
  font-size: 0.9rem;
}
```

- [ ] **Step 9: Run Web Console tests**

Run:

```bash
node --test --test-reporter=dot test/web-console.test.js
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/web/index.html src/web/app.js src/web/styles.css test/web-console.test.js
git commit -m "feat: add supervisor install dry-run web panel"
```

## Task 3: V0.84 Docs, Gold Evidence, and Version Sync

**Files:**
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `README.md`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js`
- Modify: `test/version.test.js`

**Interfaces:**
- Consumes: `POST /api/supervisor-install-dry-run`, `supervisor-install-dry-run-panel`, `buildSupervisorInstallDryRunViewModel`
- Produces: V0.84 current version docs and partial Gold evidence

- [ ] **Step 1: Write failing version/readiness/docs tests**

In `test/version.test.js`, update the expected version to:

```js
assert.strictEqual(LINKE_RELEASE_VERSION, 'V0.84');
```

In `test/gold-readiness.test.js`, extend automation and hardening evidence assertions to include:

```js
assert.ok(automationEvidence.includes('POST /api/supervisor-install-dry-run'));
assert.ok(automationEvidence.includes('Web Console supervisor-install-dry-run-panel'));
assert.ok(automationEvidence.includes('src/web/app.js buildSupervisorInstallDryRunViewModel'));
assert.ok(hardeningEvidence.includes('POST /api/supervisor-install-dry-run'));
assert.ok(hardeningEvidence.includes('Web Console supervisor-install-dry-run-panel'));
assert.ok(hardeningEvidence.includes('src/web/app.js buildSupervisorInstallDryRunViewModel'));
```

In `test/readme.test.js`, add coverage assertions:

```js
it('documents supervisor-install-dry-run Web panel safety boundaries', () => {
  assertReadmeContains(/supervisor-install-dry-run-panel|POST `?\/api\/supervisor-install-dry-run`?|buildSupervisorInstallDryRunViewModel/i, 'README should document supervisor install dry-run Web panel');
  assertReadmeContains(/不调用 launchctl[\s\S]*不读取进程列表[\s\S]*不安装[\s\S]*不启动/i, 'README should preserve supervisor install Web panel safety boundaries');
  assertReadmeContains(/Gold.*blocked|Gold.*未完成/i, 'README should keep Gold blocked for supervisor install Web panel');
});
```

- [ ] **Step 2: Run focused tests to verify they fail**

Run:

```bash
node --test --test-reporter=dot test/gold-readiness.test.js test/readme.test.js test/version.test.js
```

Expected: FAIL because V0.84 docs/evidence/version are not updated yet.

- [ ] **Step 3: Update version**

In `src/version.js`:

```js
export const LINKE_RELEASE_VERSION = 'V0.84';
```

- [ ] **Step 4: Update Gold readiness evidence**

In `src/gold-readiness.js`, add these evidence strings to both `automation-installation` and `production-hardening` without changing their statuses:

```js
'POST /api/supervisor-install-dry-run',
'Web Console supervisor-install-dry-run-panel',
'src/web/app.js buildSupervisorInstallDryRunViewModel',
```

Keep both capability statuses as `partial`. Keep `real-nas-remote-backup` as `blocked`.

- [ ] **Step 5: Update README**

Update README with these exact facts:

```markdown
> **当前版本：V0.84** — 单机 localhost 原型阶段，新增 Web Console `supervisor-install-dry-run-panel` 与 dry-run-only `POST /api/supervisor-install-dry-run`，用于手动渲染 sanitized supervisor install dry-run 计划；固定 `readinessSummary.state:"blocked"`、`installApprovalManifest.approval.approved:false` 与 `installApprovalManifest.rollback.available:false`，不调用 launchctl、不读取进程列表、不安装、不启动、不写 metadata、不连接 NAS、不触发备份/恢复、不执行远程命令，Gold 依旧 blocked
```

Add a V0.84 current version table row and move V0.83 to historical:

```markdown
| V0.84 | 当前版本 | Supervisor install Web dry-run panel：新增 Web Console `supervisor-install-dry-run-panel` 与 dry-run-only `POST /api/supervisor-install-dry-run`，复用 `buildSupervisorInstallDryRunPlan` 展示 allowlisted blocked 安装计划、command preview、preflight、approval manifest 与 safety flags；不自动请求、不自动轮询、不读取 config path、不调用 CLI、不调用 launchctl、不读取进程列表、不安装、不启动、不写 LaunchAgents/plist/metadata、不连接 NAS、不触发备份/恢复、不执行远程命令、不回显 serverUrl、sourcePath、NAS endpoint、credentialRef、token、Authorization、approval identity、timestamp、plist path、executable path 或 runnable command，Gold 依旧 blocked |
```

Add or update feature docs so README mentions:

- `POST /api/supervisor-install-dry-run`
- `supervisor-install-dry-run-panel`
- `buildSupervisorInstallDryRunViewModel`
- no startup request
- no auto polling
- no `launchctl`
- no process list read
- no install/start
- no metadata write
- no NAS connection
- no backup/restore
- no remote command
- Gold remains blocked

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --test --test-reporter=dot test/gold-readiness.test.js test/readme.test.js test/version.test.js
```

Expected: PASS.

- [ ] **Step 7: Run full verification**

Run:

```bash
node --test --test-reporter=dot test/*.test.js
git diff --check
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/version.js src/gold-readiness.js README.md test/gold-readiness.test.js test/readme.test.js test/version.test.js
git commit -m "docs: document supervisor install web panel"
```

## Final Review and Delivery

After all tasks:

1. Run:

```bash
node --test --test-reporter=dot test/*.test.js
git diff --check
```

2. Qwen read-only adversarial review must inspect the final diff for:
   - no unsafe install/start/launchctl/process/NAS/backup/restore/remote behavior
   - no raw config/path/endpoint/credential/token rendering
   - no startup request/polling
   - no Gold overclaim

3. DeepSeek closure verifier must inspect final diff and test evidence and return `STATUS: PASS` and `COMMIT_READY: yes`.

4. Push after commit:

```bash
git push
```
