# NAS App Adapter Dry-Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Linke V0.14 NAS app adapter dry-run plans for Synology and Ugreen targets without adding real NAS app invocation.

**Architecture:** Extend the existing `src/nas.js` dry-run provider module with adapter validation and adapter plan generation. Reuse the existing `POST /api/nas-dry-run`, CLI `nas-dry-run`, and Web Console NAS dry-run panel. Render adapter plan values with DOM nodes and `textContent`.

**Tech Stack:** Node.js ESM, browser ESM, built-in `node:test`, zero external runtime dependencies.

## Global Constraints

- V0.14 extends NAS dry-run with app adapter dry-run plans.
- No real NAS app invocation.
- No Synology DSM API or Ugreen API calls.
- No SMB, WebDAV, rsync, SSH, HTTP NAS endpoint call, ping, probe, auth check, or token exchange.
- No credential storage.
- No config persistence.
- Adapter plan must return `wouldInvokeApp:false`, `wouldConnect:false`, and `wouldWrite:false`.
- Render all adapter values using DOM nodes and `textContent`.
- Use `npm test` as the verification command.
- In this workspace, run `git commit` only when the user has explicitly approved committing.

---

### Task 1: NAS Adapter Validation And Plan Generation

**Files:**
- Modify: `src/nas.js`
- Modify: `test/nas-dry-run.test.js`
- Modify: `test/config.test.js`

**Interfaces:**
- Produces:
  - `validateNasTarget(target)` returns a normalised target with optional `appAdapter`
  - `buildNasAppAdapterDryRunPlan(target, jobs)` returns adapter plan or `null`
  - `buildNasDryRunPlan(config)` includes `adapterPlan` on each target

- [ ] **Step 1: Add failing tests in `test/nas-dry-run.test.js`**

Add these imports:

```js
import {
  validateNasTarget,
  buildNasDryRunPlan,
  runNasDryRunFromConfig,
  buildNasAppAdapterDryRunPlan,
} from '../src/nas.js';
```

Add tests under `describe('validateNasTarget', ...)`:

```js
  it('accepts a valid synology appAdapter', () => {
    const result = validateNasTarget({
      name: 'syno',
      provider: 'synology',
      endpoint: 'http://192.168.1.100:5000',
      shareName: 'backup',
      remotePath: '/volume1/backup',
      appAdapter: {
        appId: 'synology-backup',
        operation: 'backup-plan',
      },
    });

    assert.deepStrictEqual(result.appAdapter, {
      appId: 'synology-backup',
      operation: 'backup-plan',
    });
  });

  it('accepts a valid ugreen appAdapter and defaults operation', () => {
    const result = validateNasTarget({
      name: 'ugreen',
      provider: 'ugreen',
      endpoint: 'https://192.168.1.200',
      shareName: 'data',
      remotePath: '/shares/data',
      appAdapter: {
        appId: 'ugreen-files',
      },
    });

    assert.deepStrictEqual(result.appAdapter, {
      appId: 'ugreen-files',
      operation: 'backup-plan',
    });
  });

  it('rejects appAdapter missing appId', () => {
    assert.throws(
      () =>
        validateNasTarget({
          name: 'syno',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          appAdapter: {
            operation: 'backup-plan',
          },
        }),
      /appAdapter\.appId/,
    );
  });

  it('rejects unknown appAdapter appId', () => {
    assert.throws(
      () =>
        validateNasTarget({
          name: 'syno',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          appAdapter: {
            appId: 'qnap-backup',
          },
        }),
      /appAdapter\.appId|unsupported/i,
    );
  });

  it('rejects provider/appAdapter mismatch', () => {
    assert.throws(
      () =>
        validateNasTarget({
          name: 'syno',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          appAdapter: {
            appId: 'ugreen-backup',
          },
        }),
      /provider|mismatch|appAdapter/i,
    );
  });

  it('rejects credential-like fields inside appAdapter', () => {
    assert.throws(
      () =>
        validateNasTarget({
          name: 'syno',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          appAdapter: {
            appId: 'synology-backup',
            token: 'do-not-accept',
          },
        }),
      /credential|not allowed|forbidden/i,
    );
  });
```

Add tests under `describe('buildNasDryRunPlan', ...)`:

```js
  it('includes adapterPlan with dry-run flags for appAdapter targets', () => {
    const plan = buildNasDryRunPlan({
      deviceId: 'dev',
      nasTargets: [
        {
          name: 'syno',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          appAdapter: {
            appId: 'synology-backup',
            operation: 'backup-plan',
          },
        },
      ],
      backupJobs: [{ name: 'docs', sourcePath: '/Users/ah/Documents' }],
    });

    assert.strictEqual(plan.targets[0].adapterPlan.mode, 'dry-run');
    assert.strictEqual(plan.targets[0].adapterPlan.appId, 'synology-backup');
    assert.strictEqual(plan.targets[0].adapterPlan.operation, 'backup-plan');
    assert.strictEqual(plan.targets[0].adapterPlan.wouldInvokeApp, false);
    assert.strictEqual(plan.targets[0].adapterPlan.wouldConnect, false);
    assert.strictEqual(plan.targets[0].adapterPlan.wouldWrite, false);
    assert.deepStrictEqual(plan.targets[0].adapterPlan.steps, [
      'validate-target',
      'prepare-app-request',
      'map-backup-jobs',
      'preview-remote-destination',
    ]);
  });

  it('sets adapterPlan to null when appAdapter is omitted', () => {
    const plan = buildNasDryRunPlan({
      deviceId: 'dev',
      nasTargets: [
        {
          name: 'syno',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
        },
      ],
      backupJobs: [{ name: 'docs', sourcePath: '/Users/ah/Documents' }],
    });

    assert.strictEqual(plan.targets[0].adapterPlan, null);
  });
```

Add pure function tests:

```js
describe('buildNasAppAdapterDryRunPlan', () => {
  it('returns backup adapter steps for synology-backup', () => {
    const plan = buildNasAppAdapterDryRunPlan(
      {
        name: 'syno',
        provider: 'synology',
        appAdapter: {
          appId: 'synology-backup',
          operation: 'backup-plan',
        },
      },
      [{ name: 'docs', sourcePath: '/Users/ah/Documents' }],
    );

    assert.strictEqual(plan.mode, 'dry-run');
    assert.strictEqual(plan.provider, 'synology');
    assert.strictEqual(plan.appId, 'synology-backup');
    assert.strictEqual(plan.wouldInvokeApp, false);
    assert.deepStrictEqual(plan.steps, [
      'validate-target',
      'prepare-app-request',
      'map-backup-jobs',
      'preview-remote-destination',
    ]);
  });

  it('returns files adapter steps for ugreen-files', () => {
    const plan = buildNasAppAdapterDryRunPlan(
      {
        name: 'ugreen',
        provider: 'ugreen',
        appAdapter: {
          appId: 'ugreen-files',
          operation: 'browse-plan',
        },
      },
      [],
    );

    assert.deepStrictEqual(plan.steps, [
      'validate-target',
      'prepare-file-browser-request',
      'map-share-and-path',
      'preview-file-operation',
    ]);
  });

  it('returns null when target has no appAdapter', () => {
    assert.strictEqual(
      buildNasAppAdapterDryRunPlan({ name: 'plain', provider: 'synology' }, []),
      null,
    );
  });
});
```

In `test/config.test.js`, add a validation test near the existing NAS target tests:

```js
  it('accepts nasTargets with valid appAdapter', () => {
    const cfg = validateConfig({
      serverUrl: 'http://localhost:3000',
      deviceId: 'dev',
      backupJobs: [{ name: 'docs', sourcePath: '/tmp/docs' }],
      nasTargets: [
        {
          name: 'syno',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          appAdapter: {
            appId: 'synology-files',
            operation: 'browse-plan',
          },
        },
      ],
    });

    assert.deepStrictEqual(cfg.nasTargets[0].appAdapter, {
      appId: 'synology-files',
      operation: 'browse-plan',
    });
  });
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npm test
```

Expected: FAIL because `buildNasAppAdapterDryRunPlan` is not exported and `appAdapter` is not preserved.

- [ ] **Step 3: Implement adapter validation in `src/nas.js`**

Add constants:

```js
const VALID_APP_ADAPTERS = Object.freeze({
  synology: ['synology-backup', 'synology-files'],
  ugreen: ['ugreen-backup', 'ugreen-files'],
});

const BACKUP_ADAPTER_STEPS = Object.freeze([
  'validate-target',
  'prepare-app-request',
  'map-backup-jobs',
  'preview-remote-destination',
]);

const FILES_ADAPTER_STEPS = Object.freeze([
  'validate-target',
  'prepare-file-browser-request',
  'map-share-and-path',
  'preview-file-operation',
]);
```

Add helper:

```js
function validateNasAppAdapter(provider, appAdapter) {
  if (appAdapter === undefined) return null;
  if (!appAdapter || typeof appAdapter !== 'object' || Array.isArray(appAdapter)) {
    throw new Error('nasTargets[].appAdapter must be an object');
  }

  assertNoCredentials(appAdapter);

  if (!appAdapter.appId || typeof appAdapter.appId !== 'string' || appAdapter.appId.trim() === '') {
    throw new Error('nasTargets[].appAdapter.appId must be a non-empty string');
  }

  const allowed = VALID_APP_ADAPTERS[provider] || [];
  if (!allowed.includes(appAdapter.appId)) {
    throw new Error(
      `nasTargets[].appAdapter.appId "${appAdapter.appId}" is not supported for provider "${provider}"`,
    );
  }

  if (appAdapter.operation !== undefined
    && (typeof appAdapter.operation !== 'string' || appAdapter.operation.trim() === '')) {
    throw new Error('nasTargets[].appAdapter.operation must be a non-empty string');
  }

  return {
    appId: appAdapter.appId,
    operation: appAdapter.operation || 'backup-plan',
  };
}
```

Update `validateNasTarget` return object:

```js
  const appAdapter = validateNasAppAdapter(target.provider, target.appAdapter);

  return {
    name: target.name,
    provider: target.provider,
    endpoint: target.endpoint,
    shareName: target.shareName,
    remotePath: target.remotePath,
    enabled,
    appAdapter,
  };
```

- [ ] **Step 4: Implement adapter plan generation**

Add:

```js
export function buildNasAppAdapterDryRunPlan(target, jobs = []) {
  if (!target.appAdapter) return null;
  const steps = target.appAdapter.appId.endsWith('-files')
    ? FILES_ADAPTER_STEPS
    : BACKUP_ADAPTER_STEPS;

  return {
    mode: 'dry-run',
    provider: target.provider,
    appId: target.appAdapter.appId,
    operation: target.appAdapter.operation,
    wouldInvokeApp: false,
    wouldConnect: false,
    wouldWrite: false,
    steps: [...steps],
    jobCount: jobs.length,
  };
}
```

Update target mapping in `buildNasDryRunPlan`:

```js
    targets: validatedTargets.map((t) => ({
      provider: t.provider,
      name: t.name,
      endpoint: t.endpoint,
      shareName: t.shareName,
      remotePath: t.remotePath,
      enabled: t.enabled,
      appAdapter: t.appAdapter,
      adapterPlan: buildNasAppAdapterDryRunPlan(t, config.backupJobs || []),
    })),
```

- [ ] **Step 5: Mirror config validation**

In `src/config.js`, add matching validation for `appAdapter` in the `nasTargets` loop. Keep this simple and local:

```js
      let appAdapter = null;
      if (t.appAdapter !== undefined) {
        assertNoCredentials(t.appAdapter);
        if (!t.appAdapter || typeof t.appAdapter !== 'object' || Array.isArray(t.appAdapter)) {
          throw new Error('nasTargets[].appAdapter must be an object');
        }
        if (!t.appAdapter.appId || typeof t.appAdapter.appId !== 'string' || t.appAdapter.appId.trim() === '') {
          throw new Error('nasTargets[].appAdapter.appId must be a non-empty string');
        }
        const validApps = {
          synology: ['synology-backup', 'synology-files'],
          ugreen: ['ugreen-backup', 'ugreen-files'],
        };
        if (!validApps[t.provider].includes(t.appAdapter.appId)) {
          throw new Error(
            `nasTargets[].appAdapter.appId "${t.appAdapter.appId}" is not supported for provider "${t.provider}"`,
          );
        }
        if (t.appAdapter.operation !== undefined
          && (typeof t.appAdapter.operation !== 'string' || t.appAdapter.operation.trim() === '')) {
          throw new Error('nasTargets[].appAdapter.operation must be a non-empty string');
        }
        appAdapter = {
          appId: t.appAdapter.appId,
          operation: t.appAdapter.operation || 'backup-plan',
        };
      }
```

Include `appAdapter` in `nasTargets.push(...)`.

- [ ] **Step 6: Run tests to verify GREEN**

Run:

```bash
npm test
```

Expected: PASS.

---

### Task 2: API, README, And HTML Sample

**Files:**
- Modify: `README.md`
- Modify: `src/web/index.html`
- Modify: `test/readme.test.js`
- Modify: `test/web-console.test.js`

**Interfaces:**
- Consumes: adapter plan fields from Task 1
- Produces: V0.14 documentation and HTML sample config with `appAdapter`

- [ ] **Step 1: Add failing API/README/HTML tests**

In `test/readme.test.js`, add after the V0.13 test:

```js
  it('mentions V0.14 (NAS app adapter dry-run)', () => {
    assertReadmeContains(/V0\.14/, 'V0.14');
  });
```

In `describe('README — Web Console', ...)`, add:

```js
  it('documents NAS app adapter dry-run', () => {
    assertReadmeContains(
      /appAdapter[\s\S]*adapterPlan[\s\S]*wouldInvokeApp:false|NAS app adapter[\s\S]*dry-run[\s\S]*不调用/i,
      'NAS app adapter dry-run docs',
    );
  });
```

In `test/web-console.test.js`, add under the V0.13 API tests:

```js
  it('POST /api/nas-dry-run returns app adapter dry-run plans', async () => {
    const res = await fetch(`http://localhost:${port}/api/nas-dry-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'web-console-dry-run',
        nasTargets: [
          {
            name: 'synology-web',
            provider: 'synology',
            endpoint: 'http://192.168.1.100:5000',
            shareName: 'backup',
            remotePath: '/volume1/backup',
            appAdapter: {
              appId: 'synology-backup',
              operation: 'backup-plan',
            },
          },
        ],
        backupJobs: [{ name: 'documents', sourcePath: '/Users/ah/Documents' }],
      }),
    });
    const body = await res.json();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.targets[0].adapterPlan.appId, 'synology-backup');
    assert.strictEqual(body.targets[0].adapterPlan.wouldInvokeApp, false);
    assert.strictEqual(body.targets[0].adapterPlan.wouldConnect, false);
    assert.strictEqual(body.targets[0].adapterPlan.wouldWrite, false);
  });

  it('POST /api/nas-dry-run rejects provider/app adapter mismatch', async () => {
    const res = await fetch(`http://localhost:${port}/api/nas-dry-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'web-console-dry-run',
        nasTargets: [
          {
            name: 'synology-web',
            provider: 'synology',
            endpoint: 'http://192.168.1.100:5000',
            shareName: 'backup',
            remotePath: '/volume1/backup',
            appAdapter: {
              appId: 'ugreen-backup',
            },
          },
        ],
        backupJobs: [{ name: 'documents', sourcePath: '/Users/ah/Documents' }],
      }),
    });
    const body = await res.json();

    assert.strictEqual(res.status, 400);
    assert.match(body.error, /appAdapter|provider|supported/i);
  });
```

Add HTML sample test:

```js
  it('NAS dry-run Web panel sample includes appAdapter without credentials', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    const panelMatch = html.match(/data-testid="nas-dry-run-panel"[\s\S]*?<\/section>/);

    assert.ok(panelMatch, 'nas-dry-run-panel section must exist');
    assert.ok(panelMatch[0].includes('appAdapter'), 'sample must include appAdapter');
    assert.ok(panelMatch[0].includes('synology-backup'), 'sample must include synology-backup');
    assert.ok(panelMatch[0].includes('ugreen-files'), 'sample must include ugreen-files');
    assert.ok(!/password|token|apiKey|secret|accessKey|refreshToken/.test(panelMatch[0]), 'sample must not include credential fields');
  });
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npm test
```

Expected: FAIL because README/HTML are not updated and API does not return adapter plan yet if Task 1 was not complete.

- [ ] **Step 3: Update README to V0.14**

Change title/current version to V0.14.

Add version row:

```md
| V0.14 | 当前版本 | NAS app adapter dry-run：为 Synology / Ugreen 目标生成应用嵌套调用计划，不调用 NAS app、不连接、不写入 |
```

Change V0.13 row from current to:

```md
| V0.13 | Web NAS dry-run panel | Web Console 新增 NAS dry-run 面板，可粘贴 nasTargets 配置并查看 wouldConnect:false / wouldWrite:false 的计划 |
```

Add feature bullet:

```md
- **NAS app adapter dry-run** — 为 Synology / Ugreen 目标生成 `adapterPlan`，显示 `wouldInvokeApp:false`，不调用 NAS app、不连接、不写远端
```

Add section after `### Web Console NAS dry-run`:

```md
### NAS app adapter dry-run

V0.14 在 NAS dry-run 中增加应用适配器计划。`nasTargets[]` 可声明可选 `appAdapter`：

```json
{
  "appAdapter": {
    "appId": "synology-backup",
    "operation": "backup-plan"
  }
}
```

支持的 appId：

- `synology-backup`
- `synology-files`
- `ugreen-backup`
- `ugreen-files`

dry-run 输出会在对应 target 上增加 `adapterPlan`，包含 `wouldInvokeApp:false`、`wouldConnect:false`、`wouldWrite:false` 和计划步骤。该功能只生成应用嵌套调用预览，不调用 NAS app、不发起认证、不 ping/probe、不连接 NAS、不写入远端、不保存配置。`appAdapter` 内出现 credential 字段会被拒绝，provider 与 appId 不匹配也会被拒绝。
```

Update testing coverage sentence to include `NAS app adapter dry-run`.

- [ ] **Step 4: Update HTML sample**

In `src/web/index.html`, update the NAS dry-run panel textarea sample so Synology includes:

```json
      "appAdapter": {
        "appId": "synology-backup",
        "operation": "backup-plan"
      }
```

and Ugreen includes:

```json
      "appAdapter": {
        "appId": "ugreen-files",
        "operation": "browse-plan"
      }
```

Update the safety note to mention:

```text
不调用 NAS app
```

- [ ] **Step 5: Run tests to verify GREEN**

Run:

```bash
npm test
```

Expected: PASS.

---

### Task 3: Web Console Adapter Rendering

**Files:**
- Modify: `src/web/app.js`
- Modify: `src/web/styles.css`
- Modify: `test/web-console.test.js`

**Interfaces:**
- Consumes: `target.adapterPlan`
- Produces: Web Console rendering for app adapter plan

- [ ] **Step 1: Add failing DOM render tests**

In `describe('initConsole DOM data-testid hooks', ...)`, extend or add a test:

```js
  it('renders NAS app adapter dry-run plan details', async () => {
    const doc = createTestDocument();
    const fetchImpl = async (url) => {
      if (String(url).includes('/api/nas-dry-run')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            mode: 'dry-run',
            deviceId: 'web-console-dry-run',
            wouldConnect: false,
            wouldWrite: false,
            targets: [
              {
                name: 'synology-web',
                provider: 'synology',
                endpoint: 'http://192.168.1.100:5000',
                shareName: 'backup',
                remotePath: '/volume1/backup',
                enabled: true,
                adapterPlan: {
                  mode: 'dry-run',
                  provider: 'synology',
                  appId: 'synology-backup',
                  operation: 'backup-plan',
                  wouldInvokeApp: false,
                  wouldConnect: false,
                  wouldWrite: false,
                  steps: [
                    'validate-target',
                    'prepare-app-request',
                    'map-backup-jobs',
                    'preview-remote-destination',
                  ],
                },
              },
              {
                name: 'plain-web',
                provider: 'synology',
                endpoint: 'http://192.168.1.101:5000',
                shareName: 'backup',
                remotePath: '/volume1/plain',
                enabled: true,
                adapterPlan: null,
              },
            ],
            jobs: [],
          }),
        };
      }
      return jsonResponse([]);
    };
    initConsole(doc, fetchImpl, noopInterval);
    await flushAsync();

    doc.getElementById('nas-dry-run-config').value = JSON.stringify({
      deviceId: 'web-console-dry-run',
      nasTargets: [],
      backupJobs: [],
    });
    doc.getElementById('nas-dry-run-run')._listeners.click();
    await flushAsync();

    const text = doc.getElementById('nas-dry-run-result').textContent;
    assert.match(text, /synology-backup/);
    assert.match(text, /backup-plan/);
    assert.match(text, /wouldInvokeApp:false|不调用/);
    assert.match(text, /prepare-app-request/);
    assert.match(text, /未配置应用适配器/);
  });
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npm test
```

Expected: FAIL because adapter plan details are not rendered.

- [ ] **Step 3: Implement adapter rendering**

In `src/web/app.js`, inside the NAS target rendering loop in `renderNasDryRunPlan(plan)`, after `detail` is appended, add:

```js
      const adapter = doc.createElement('div');
      adapter.className = 'nas-dry-run-adapter-plan';

      if (target.adapterPlan) {
        const adapterTitle = doc.createElement('div');
        adapterTitle.className = 'nas-dry-run-adapter-title';
        adapterTitle.textContent = `${target.adapterPlan.appId} · ${target.adapterPlan.operation} · wouldInvokeApp:false`;
        adapter.appendChild(adapterTitle);

        const steps = doc.createElement('ol');
        steps.className = 'nas-dry-run-adapter-steps';
        (target.adapterPlan.steps || []).forEach((step) => {
          const stepItem = doc.createElement('li');
          stepItem.textContent = step;
          steps.appendChild(stepItem);
        });
        adapter.appendChild(steps);
      } else {
        adapter.textContent = '未配置应用适配器';
      }

      item.appendChild(adapter);
```

- [ ] **Step 4: Add CSS**

In `src/web/styles.css`, add:

```css
.nas-dry-run-adapter-plan {
  margin-top: 8px;
  border-top: 1px solid #edf0f2;
  padding-top: 8px;
  color: #4b5563;
  font-size: 0.75rem;
}

.nas-dry-run-adapter-title {
  font-family: "SFMono-Regular", Consolas, monospace;
  font-weight: 800;
  color: #2f5f8f;
}

.nas-dry-run-adapter-steps {
  margin: 6px 0 0 18px;
  display: grid;
  gap: 2px;
}
```

- [ ] **Step 5: Run tests to verify GREEN**

Run:

```bash
npm test
```

Expected: PASS.

---

### Task 4: Final Verification

**Files:**
- Read: `README.md`
- Read: `src/nas.js`
- Read: `src/config.js`
- Read: `src/web/index.html`
- Read: `src/web/app.js`
- Read: `test/nas-dry-run.test.js`
- Read: `test/web-console.test.js`

**Interfaces:**
- Consumes: Completed Tasks 1-3.
- Produces: Final validation evidence for V0.14.

- [ ] **Step 1: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS with zero failures.

- [ ] **Step 2: Safety scan**

Run:

```bash
rg -n "appAdapter|adapterPlan|wouldInvokeApp|V0\\.14|synology-backup|ugreen-files" README.md src test docs/superpowers
```

Expected: Shows V0.14 docs, adapter validation, plan generation, Web rendering, and tests.

Run:

```bash
rg -n "http\\.request|https\\.request|net\\.connect|createConnection|ping|probe|auth check|token exchange|invoke.*NAS|调用.*NAS app|真实.*NAS app|writeFile|writeFileSync" src/nas.js src/config.js src/server.js src/web README.md test
```

Expected: No new real NAS app invocation, endpoint connection, credential exchange, or write path. README/test negative statements may appear and must be inspected.

- [ ] **Step 3: Local HTTP smoke**

Use the existing local service or start a new one:

```bash
PORT=3005 HOST=127.0.0.1 DATA_DIR=/Users/ah/linke/data node src/server.js
```

POST:

```bash
curl -s -X POST http://127.0.0.1:3005/api/nas-dry-run \
  -H 'Content-Type: application/json' \
  --data '{"deviceId":"smoke","nasTargets":[{"name":"syno","provider":"synology","endpoint":"http://192.168.1.100:5000","shareName":"backup","remotePath":"/volume1/backup","appAdapter":{"appId":"synology-backup","operation":"backup-plan"}}],"backupJobs":[{"name":"docs","sourcePath":"/Users/ah/Documents"}]}'
```

Expected JSON includes:

```json
{
  "adapterPlan": {
    "wouldInvokeApp": false,
    "wouldConnect": false,
    "wouldWrite": false
  }
}
```

- [ ] **Step 4: Commit only if authorized**

If the user explicitly authorizes commit:

```bash
git add README.md src/nas.js src/config.js src/web/index.html src/web/styles.css src/web/app.js test/nas-dry-run.test.js test/config.test.js test/readme.test.js test/web-console.test.js docs/superpowers/specs/2026-07-04-nas-app-adapter-dry-run-design.md docs/superpowers/plans/2026-07-04-nas-app-adapter-dry-run.md
git commit -m "feat: add v0.14 nas app adapter dry-run"
```

- [ ] **Step 5: Handoff**

Report:

- Worker results from Qwen, AGY, and ZAI.
- `npm test` result.
- Safety scan result.
- HTTP smoke result.
- Git status.
