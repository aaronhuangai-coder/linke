# NAS Dry-Run Web Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Linke V0.13 Web Console NAS dry-run panel and local API route without adding real NAS connectivity or writes.

**Architecture:** Reuse the existing `buildNasDryRunPlan(config)` pure function. Add `POST /api/nas-dry-run` in `src/server.js`, add a browser panel in `src/web/index.html`, and add request/render logic in `src/web/app.js`. Keep all rendering of user/API values on DOM nodes with `textContent`.

**Tech Stack:** Node.js ESM, browser ESM, built-in `node:test`, zero external runtime dependencies.

## Global Constraints

- V0.13 extends NAS dry-run into the Web Console.
- No real Synology or Ugreen API call.
- No ping, probe, auth check, SMB/WebDAV check, or HTTP fetch to NAS endpoints.
- No remote write.
- No local config persistence.
- No credential fields in sample JSON.
- No `innerHTML` for user-provided config values or API error messages.
- API route must call only `buildNasDryRunPlan(config)` for the dry-run plan.
- Use `npm test` as the verification command.
- In this workspace, run `git commit` only when the user has explicitly approved committing.

---

### Task 1: NAS Dry-Run API Route

**Files:**
- Modify: `src/server.js`
- Modify: `test/web-console.test.js`

**Interfaces:**
- Consumes: `buildNasDryRunPlan(config)` from `src/nas.js`
- Produces: `POST /api/nas-dry-run`

- [ ] **Step 1: Add failing API contract tests**

In `test/web-console.test.js`, inside `describe('Web Console / API contract', ...)` near the existing NAS dry-run tests, add:

```js
  it('POST /api/nas-dry-run returns a dry-run NAS plan without connecting or writing', async () => {
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
            enabled: true,
          },
          {
            name: 'ugreen-web',
            provider: 'ugreen',
            endpoint: 'https://192.168.1.200',
            shareName: 'data',
            remotePath: '/shares/data',
            enabled: false,
          },
        ],
        backupJobs: [{ name: 'documents', sourcePath: '/Users/ah/Documents' }],
      }),
    });
    const body = await res.json();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.mode, 'dry-run');
    assert.strictEqual(body.deviceId, 'web-console-dry-run');
    assert.strictEqual(body.wouldConnect, false);
    assert.strictEqual(body.wouldWrite, false);
    assert.strictEqual(body.targets.length, 2);
    assert.strictEqual(body.jobs.length, 1);
    assert.strictEqual(body.targets[0].provider, 'synology');
    assert.strictEqual(body.targets[1].provider, 'ugreen');
  });

  it('POST /api/nas-dry-run rejects invalid JSON body', async () => {
    const res = await fetch(`http://localhost:${port}/api/nas-dry-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ invalid json',
    });
    const body = await res.json();

    assert.strictEqual(res.status, 400);
    assert.match(body.error, /Invalid JSON body/);
  });

  it('POST /api/nas-dry-run rejects unsupported NAS provider', async () => {
    const res = await fetch(`http://localhost:${port}/api/nas-dry-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'web-console-dry-run',
        nasTargets: [
          {
            name: 'qnap-web',
            provider: 'qnap',
            endpoint: 'http://192.168.1.50',
            shareName: 'backup',
            remotePath: '/backup',
          },
        ],
        backupJobs: [{ name: 'documents', sourcePath: '/Users/ah/Documents' }],
      }),
    });
    const body = await res.json();

    assert.strictEqual(res.status, 400);
    assert.match(body.error, /provider/i);
  });

  it('POST /api/nas-dry-run rejects credential-like fields', async () => {
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
            password: 'do-not-accept',
          },
        ],
        backupJobs: [{ name: 'documents', sourcePath: '/Users/ah/Documents' }],
      }),
    });
    const body = await res.json();

    assert.strictEqual(res.status, 400);
    assert.match(body.error, /credential|not allowed|forbidden/i);
  });

  it('POST /api/nas-dry-run rejects endpoint URL userinfo', async () => {
    const res = await fetch(`http://localhost:${port}/api/nas-dry-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'web-console-dry-run',
        nasTargets: [
          {
            name: 'synology-web',
            provider: 'synology',
            endpoint: 'http://admin:secret@192.168.1.100:5000',
            shareName: 'backup',
            remotePath: '/volume1/backup',
          },
        ],
        backupJobs: [{ name: 'documents', sourcePath: '/Users/ah/Documents' }],
      }),
    });
    const body = await res.json();

    assert.strictEqual(res.status, 400);
    assert.match(body.error, /credential|userinfo|not allowed|forbidden/i);
  });
```

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
npm test
```

Expected: FAIL because `POST /api/nas-dry-run` returns 404.

- [ ] **Step 3: Implement API route**

In `src/server.js`, add the import:

```js
import { buildNasDryRunPlan } from './nas.js';
```

Update `readBody(req)` so invalid JSON becomes a controlled 400 at the route call site:

```js
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf-8') || '{}';
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error('Invalid JSON body');
    err.statusCode = 400;
    throw err;
  }
}
```

Add this route after the existing backup-preflight API route and before restore routes:

```js
      // POST /api/nas-dry-run
      if (method === 'POST' && pathname === '/api/nas-dry-run') {
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
          const plan = buildNasDryRunPlan(body);
          return sendJSON(res, 200, plan);
        } catch (err) {
          return sendError(res, 400, err.message);
        }
      }
```

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
npm test
```

Expected: PASS for the new API tests and no regression in existing tests.

---

### Task 2: Web Panel Shell and README

**Files:**
- Modify: `README.md`
- Modify: `src/web/index.html`
- Modify: `src/web/styles.css`
- Modify: `test/readme.test.js`
- Modify: `test/web-console.test.js`

**Interfaces:**
- Consumes: `POST /api/nas-dry-run` from Task 1
- Produces: stable DOM hooks:
  - `nas-dry-run-panel`
  - `nas-dry-run-config`
  - `nas-dry-run-run`
  - `nas-dry-run-target-count`
  - `nas-dry-run-job-count`
  - `nas-dry-run-result`
  - `nas-dry-run-safety-note`

- [ ] **Step 1: Add failing README tests**

In `test/readme.test.js`, add a version coverage test after the V0.12 test:

```js
  it('mentions V0.13 (Web NAS dry-run panel)', () => {
    assertReadmeContains(/V0\.13/, 'V0.13');
  });
```

In `describe('README — Web Console', ...)`, add:

```js
  it('documents the Web Console NAS dry-run panel', () => {
    assertReadmeContains(
      /Web Console[\s\S]*NAS[\s\S]*dry-run[\s\S]*面板|POST \/api\/nas-dry-run[\s\S]*wouldConnect[\s\S]*wouldWrite|nasTargets[\s\S]*Web Console[\s\S]*不连接/i,
      'Web Console NAS dry-run panel',
    );
  });
```

- [ ] **Step 2: Add failing HTML contract tests**

In `test/web-console.test.js`, near the existing NAS Provider Dry-Run HTML tests, add:

```js
  it('HTML contains NAS dry-run Web panel with required data-testid hooks', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.ok(html.includes('data-testid="nas-dry-run-panel"'), 'must have nas-dry-run-panel');
    assert.ok(html.includes('data-testid="nas-dry-run-config"'), 'must have nas-dry-run-config textarea');
    assert.ok(html.includes('data-testid="nas-dry-run-run"'), 'must have nas-dry-run-run button');
    assert.ok(html.includes('data-testid="nas-dry-run-target-count"'), 'must have nas-dry-run-target-count');
    assert.ok(html.includes('data-testid="nas-dry-run-job-count"'), 'must have nas-dry-run-job-count');
    assert.ok(html.includes('data-testid="nas-dry-run-result"'), 'must have nas-dry-run-result');
    assert.ok(html.includes('data-testid="nas-dry-run-safety-note"'), 'must have nas-dry-run-safety-note');
  });

  it('NAS dry-run Web panel is dry-run only and has no real NAS execution wording', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    const panelMatch = html.match(/data-testid="nas-dry-run-panel"[\s\S]*?<\/section>/);

    assert.ok(panelMatch, 'nas-dry-run-panel section must exist');
    assert.ok(/dry-run|预检|只读/.test(panelMatch[0]), 'panel must communicate dry-run/read-only behavior');
    assert.ok(/不连接|不发起.*网络|no network/i.test(panelMatch[0]), 'panel must state no NAS/network connection is made');
    assert.ok(/不写入|不传输|no write/i.test(panelMatch[0]), 'panel must state no remote write is performed');
    assert.ok(/不保存|不持久化|no persistence/i.test(panelMatch[0]), 'panel must state config is not persisted');
    assert.ok(!/真实.*连接|连接.*NAS.*设备|执行.*NAS.*备份|run NAS backup|connects to NAS/i.test(panelMatch[0]), 'panel must not expose real NAS execution wording');
  });
```

- [ ] **Step 3: Run tests to verify RED**

Run:

```bash
npm test
```

Expected: FAIL because README and HTML do not mention V0.13 panel hooks.

- [ ] **Step 4: Update README to V0.13**

Change title/current version:

```md
# Linke V0.13

> **当前版本：V0.13** — 单机 localhost 原型阶段，尚未具备生产级安全隔离。
```

Add V0.13 to the version table and make V0.12 no longer current:

```md
| V0.12 | Web backup preflight panel | Web Console 新增备份预检 dry-run 面板，可输入 sourcePath / excludePatterns 并查看 included / excluded |
| V0.13 | 当前版本 | Web Console 新增 NAS dry-run 面板，可粘贴 nasTargets 配置并查看 wouldConnect:false / wouldWrite:false 的计划 |
```

Update feature bullets:

```md
- **Web Console** — 管理界面：设备列表 / 快照列表 / 快照清单详情 / 恢复预检 / 备份预检 / NAS 预检 / 快照差异预览 / 事件日志 / 保留计划面板
- **NAS dry-run** — API、CLI 与 Web Console 可验证 Synology / Ugreen 目标配置并输出计划，不连接 NAS、不写远端、不保存凭证
```

Add a new section after `### nas-dry-run`:

```md
### Web Console NAS dry-run

V0.13 在 Web Console 中增加 NAS dry-run 面板。粘贴包含 `deviceId`、`nasTargets` 和可选 `backupJobs` 的配置 JSON 后，控制台会调用 `POST /api/nas-dry-run` 并显示：

- NAS 目标数量和关联任务数量
- 每个目标的 provider、name、endpoint、shareName、remotePath 和 enabled 状态
- `wouldConnect:false` 与 `wouldWrite:false` 的 dry-run 安全结果

该面板只做配置验证和计划预览，不连接 NAS、不发起 NAS 网络请求、不传输文件、不写入远端、不保存配置。配置示例不包含密码、token 或 API key；带 credential 字段或 URL userinfo 的目标会被拒绝。
```

Update test coverage sentence so it includes `NAS dry-run 面板`.

- [ ] **Step 5: Add HTML panel shell**

In `src/web/index.html`, insert this section after the backup preflight panel and before the snapshot diff panel:

```html
      <section class="panel nas-dry-run-panel" data-testid="nas-dry-run-panel">
        <h2>NAS dry-run 预检</h2>
        <div class="nas-dry-run-controls">
          <label for="nas-dry-run-config">配置 JSON</label>
          <textarea
            id="nas-dry-run-config"
            data-testid="nas-dry-run-config"
            rows="10"
          >{
  "deviceId": "web-console-dry-run",
  "nasTargets": [
    {
      "name": "my-synology",
      "provider": "synology",
      "endpoint": "http://192.168.1.100:5000",
      "shareName": "backup",
      "remotePath": "/volume1/backup",
      "enabled": true
    },
    {
      "name": "my-ugreen",
      "provider": "ugreen",
      "endpoint": "https://192.168.1.200",
      "shareName": "data",
      "remotePath": "/shares/data",
      "enabled": false
    }
  ],
  "backupJobs": [
    { "name": "documents", "sourcePath": "/Users/ah/Documents" }
  ]
}</textarea>
          <button id="nas-dry-run-run" data-testid="nas-dry-run-run" type="button">预检 dry-run</button>
        </div>
        <div class="nas-dry-run-stats">
          <div class="nas-dry-run-stat">
            <span id="nas-dry-run-target-count" data-testid="nas-dry-run-target-count">0</span>
            <span>NAS 目标</span>
          </div>
          <div class="nas-dry-run-stat">
            <span id="nas-dry-run-job-count" data-testid="nas-dry-run-job-count">0</span>
            <span>关联任务</span>
          </div>
        </div>
        <div id="nas-dry-run-result" data-testid="nas-dry-run-result">
          <p class="placeholder">请粘贴配置 JSON 进行 NAS dry-run 预检</p>
        </div>
        <div class="nas-dry-run-safety-note" data-testid="nas-dry-run-safety-note">
          <p>NAS dry-run 只做只读配置验证和计划预览，不连接 NAS、不发起 NAS 网络请求、不写入远端、不传输文件、不保存配置。</p>
        </div>
      </section>
```

- [ ] **Step 6: Add CSS**

In `src/web/styles.css`, add a compact panel style matching the existing Linke utility panels:

```css
.nas-dry-run-panel {
  grid-column: 2 / 4;
}

.nas-dry-run-controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}

.nas-dry-run-controls label {
  font-size: 0.82rem;
  font-weight: 700;
  color: #555;
}

.nas-dry-run-controls textarea {
  width: 100%;
  min-height: 180px;
  resize: vertical;
  border: 1px solid #d6d6d6;
  border-radius: 6px;
  padding: 10px;
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 0.78rem;
  line-height: 1.45;
  color: #202124;
  background: #fbfbfb;
}

.nas-dry-run-controls button {
  align-self: flex-start;
  border: 0;
  border-radius: 6px;
  padding: 8px 14px;
  background: #2f5f8f;
  color: #fff;
  font-weight: 700;
  cursor: pointer;
}

.nas-dry-run-stats {
  display: flex;
  gap: 10px;
  margin-bottom: 12px;
}

.nas-dry-run-stat {
  min-width: 92px;
  border: 1px solid #e3e3e3;
  border-radius: 6px;
  padding: 8px 10px;
  background: #fafafa;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.nas-dry-run-stat span:first-child {
  font-size: 1.15rem;
  font-weight: 800;
  color: #202124;
}

.nas-dry-run-stat span:last-child {
  font-size: 0.75rem;
  color: #6b7280;
}

.nas-dry-run-target-list {
  list-style: none;
  display: grid;
  gap: 8px;
}

.nas-dry-run-target-item {
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 9px 10px;
  background: #fff;
}

.nas-dry-run-target-name {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-weight: 800;
}

.nas-dry-run-target-detail {
  margin-top: 4px;
  color: #6b7280;
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}

.nas-dry-run-badge {
  flex: 0 0 auto;
  border-radius: 999px;
  padding: 2px 7px;
  font-size: 0.68rem;
  font-weight: 800;
}

.nas-dry-run-badge.enabled {
  background: #e6f6ef;
  color: #0f6b43;
}

.nas-dry-run-badge.disabled {
  background: #eeeeee;
  color: #666;
}

.nas-dry-run-error {
  border: 1px solid #f0b8b8;
  border-radius: 6px;
  padding: 9px 10px;
  background: #fff6f6;
  color: #9b1c1c;
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 0.78rem;
  overflow-wrap: anywhere;
}

.nas-dry-run-safety-note {
  margin-top: 12px;
  border-left: 3px solid #c2932b;
  background: #fff8e5;
  color: #72520d;
  padding: 10px 12px;
  border-radius: 6px;
  font-size: 0.82rem;
}
```

- [ ] **Step 7: Run tests to verify GREEN**

Run:

```bash
npm test
```

Expected: PASS for README and HTML hook tests.

---

### Task 3: Browser Request and Rendering

**Files:**
- Modify: `src/web/app.js`
- Modify: `test/web-console.test.js`

**Interfaces:**
- Consumes: `POST /api/nas-dry-run`
- Produces:
  - `parseNasDryRunConfig(value): { ok: true, config: object } | { ok: false, error: string }`
  - DOM rendering under `nas-dry-run-result`

- [ ] **Step 1: Add failing import and parser tests**

In the `test/web-console.test.js` import from `../src/web/app.js`, add `parseNasDryRunConfig`.

Add tests near the other pure-function tests:

```js
describe('parseNasDryRunConfig', () => {
  it('parses valid NAS dry-run JSON config', () => {
    const result = parseNasDryRunConfig('{"deviceId":"dev","nasTargets":[]}');

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.config.deviceId, 'dev');
    assert.deepStrictEqual(result.config.nasTargets, []);
  });

  it('rejects empty config text without throwing', () => {
    const result = parseNasDryRunConfig('   ');

    assert.strictEqual(result.ok, false);
    assert.match(result.error, /不能为空/);
  });

  it('rejects invalid JSON without throwing', () => {
    const result = parseNasDryRunConfig('{ invalid json');

    assert.strictEqual(result.ok, false);
    assert.match(result.error, /JSON 格式错误/);
  });
});
```

- [ ] **Step 2: Add failing DOM behavior tests**

In `describe('initConsole DOM data-testid hooks', ...)`, add:

```js
  it('blocks NAS dry-run fetch when config JSON is empty', async () => {
    const doc = createTestDocument();
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return jsonResponse([]);
    };
    initConsole(doc, fetchImpl, noopInterval);
    await flushAsync();

    doc.getElementById('nas-dry-run-config').value = '   ';
    doc.getElementById('nas-dry-run-run').dispatchEvent({ type: 'click' });
    await flushAsync();

    assert.ok(!calls.some((call) => call.url === '/api/nas-dry-run'), 'must not call NAS dry-run API');
    assert.match(doc.getElementById('nas-dry-run-result').textContent, /不能为空/);
  });

  it('blocks NAS dry-run fetch when config JSON is invalid', async () => {
    const doc = createTestDocument();
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return jsonResponse([]);
    };
    initConsole(doc, fetchImpl, noopInterval);
    await flushAsync();

    doc.getElementById('nas-dry-run-config').value = '{ invalid json';
    doc.getElementById('nas-dry-run-run').dispatchEvent({ type: 'click' });
    await flushAsync();

    assert.ok(!calls.some((call) => call.url === '/api/nas-dry-run'), 'must not call NAS dry-run API');
    assert.match(doc.getElementById('nas-dry-run-result').textContent, /JSON 格式错误/);
  });

  it('calls NAS dry-run API and renders target/job counts and target details', async () => {
    const doc = createTestDocument();
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      if (url === '/api/nas-dry-run') {
        return jsonResponse({
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
            },
            {
              name: 'ugreen-web',
              provider: 'ugreen',
              endpoint: 'https://192.168.1.200',
              shareName: 'data',
              remotePath: '/shares/data',
              enabled: false,
            },
          ],
          jobs: [{ name: 'documents', sourcePath: '/Users/ah/Documents' }],
        });
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
    doc.getElementById('nas-dry-run-run').dispatchEvent({ type: 'click' });
    await flushAsync();

    const apiCall = calls.find((call) => call.url === '/api/nas-dry-run');
    assert.ok(apiCall, 'must call NAS dry-run API');
    assert.strictEqual(apiCall.options.method, 'POST');
    assert.deepStrictEqual(JSON.parse(apiCall.options.body), {
      deviceId: 'web-console-dry-run',
      nasTargets: [],
      backupJobs: [],
    });
    assert.strictEqual(doc.getElementById('nas-dry-run-target-count').textContent, '2');
    assert.strictEqual(doc.getElementById('nas-dry-run-job-count').textContent, '1');
    assert.match(doc.getElementById('nas-dry-run-result').textContent, /synology-web/);
    assert.match(doc.getElementById('nas-dry-run-result').textContent, /ugreen-web/);
    assert.match(doc.getElementById('nas-dry-run-result').textContent, /已启用/);
    assert.match(doc.getElementById('nas-dry-run-result').textContent, /已禁用/);
  });

  it('renders NAS dry-run API errors as text', async () => {
    const doc = createTestDocument();
    const fetchImpl = async (url) => {
      if (url === '/api/nas-dry-run') {
        return jsonResponse({ error: 'nasTargets[].endpoint must be a valid URL' }, { ok: false, status: 400 });
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
    doc.getElementById('nas-dry-run-run').dispatchEvent({ type: 'click' });
    await flushAsync();

    assert.match(doc.getElementById('nas-dry-run-result').textContent, /endpoint must be a valid URL/);
  });
```

- [ ] **Step 3: Run tests to verify RED**

Run:

```bash
npm test
```

Expected: FAIL because `parseNasDryRunConfig` and DOM logic do not exist.

- [ ] **Step 4: Implement parser and DOM references**

In `src/web/app.js`, add:

```js
export function parseNasDryRunConfig(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return { ok: false, error: '配置 JSON 不能为空' };
  }
  try {
    return { ok: true, config: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: 'JSON 格式错误: ' + err.message };
  }
}
```

Inside `initConsole`, add DOM references:

```js
  const nasDryRunConfigInput = doc.getElementById('nas-dry-run-config');
  const nasDryRunRunButton = doc.getElementById('nas-dry-run-run');
  const nasDryRunTargetCountEl = doc.getElementById('nas-dry-run-target-count');
  const nasDryRunJobCountEl = doc.getElementById('nas-dry-run-job-count');
  const nasDryRunResultEl = doc.getElementById('nas-dry-run-result');
```

- [ ] **Step 5: Implement safe rendering helpers**

In `src/web/app.js`, inside `initConsole`, add:

```js
  function setNasDryRunError(message) {
    if (!nasDryRunResultEl) return;
    clearElement(nasDryRunResultEl);
    const error = doc.createElement('div');
    error.className = 'nas-dry-run-error';
    error.textContent = message;
    nasDryRunResultEl.appendChild(error);
  }

  function renderNasDryRunPlan(plan) {
    if (!nasDryRunResultEl) return;
    const targets = Array.isArray(plan.targets) ? plan.targets : [];
    const jobs = Array.isArray(plan.jobs) ? plan.jobs : [];

    nasDryRunTargetCountEl.textContent = String(targets.length);
    nasDryRunJobCountEl.textContent = String(jobs.length);
    clearElement(nasDryRunResultEl);

    if (targets.length === 0) {
      const placeholder = doc.createElement('p');
      placeholder.className = 'placeholder';
      placeholder.textContent = '未配置任何 NAS 目标';
      nasDryRunResultEl.appendChild(placeholder);
      return;
    }

    const list = doc.createElement('ul');
    list.className = 'nas-dry-run-target-list';

    targets.forEach((target) => {
      const item = doc.createElement('li');
      item.className = 'nas-dry-run-target-item';

      const nameRow = doc.createElement('div');
      nameRow.className = 'nas-dry-run-target-name';

      const name = doc.createElement('span');
      name.textContent = `${target.name || 'unnamed'} [${target.provider || 'unknown'}]`;

      const badge = doc.createElement('span');
      badge.className = 'nas-dry-run-badge ' + (target.enabled ? 'enabled' : 'disabled');
      badge.textContent = target.enabled ? '已启用' : '已禁用';

      const detail = doc.createElement('div');
      detail.className = 'nas-dry-run-target-detail';
      detail.textContent = `${target.endpoint || 'unknown'} · ${target.shareName || 'unknown'} · ${target.remotePath || 'unknown'}`;

      nameRow.appendChild(name);
      nameRow.appendChild(badge);
      item.appendChild(nameRow);
      item.appendChild(detail);
      list.appendChild(item);
    });

    nasDryRunResultEl.appendChild(list);
  }
```

- [ ] **Step 6: Wire the run button**

In `src/web/app.js`, inside `initConsole`, add:

```js
  if (nasDryRunRunButton) {
    nasDryRunRunButton.addEventListener('click', async function () {
      const parsed = parseNasDryRunConfig(nasDryRunConfigInput ? nasDryRunConfigInput.value : '');
      if (!parsed.ok) {
        setNasDryRunError(parsed.error);
        return;
      }

      try {
        const res = await fetchImpl('/api/nas-dry-run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parsed.config),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
        renderNasDryRunPlan(data);
        logEvent('NAS dry-run 预检完成', 'info');
      } catch (err) {
        setNasDryRunError('NAS dry-run 失败: ' + err.message);
        logEvent('NAS dry-run 失败: ' + err.message, 'error');
      }
    });
  }
```

- [ ] **Step 7: Run tests to verify GREEN**

Run:

```bash
npm test
```

Expected: PASS for all tests.

---

### Task 4: Final Verification and Safety Smoke

**Files:**
- Read: `README.md`
- Read: `src/server.js`
- Read: `src/web/index.html`
- Read: `src/web/app.js`
- Read: `test/web-console.test.js`
- Read: `test/readme.test.js`

**Interfaces:**
- Consumes: Completed Tasks 1-3.
- Produces: Final validation evidence for V0.13.

- [ ] **Step 1: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS with zero failures.

- [ ] **Step 2: Safety scan**

Run:

```bash
rg -n "nas-dry-run|V0\\.13|parseNasDryRunConfig|buildNasDryRunPlan" README.md src test docs/superpowers
```

Expected: Shows V0.13 README docs, API route, Web panel hooks, parser tests, and app logic.

Run:

```bash
rg -n "fetch\\(|request\\(|http\\.request|https\\.request|net\\.connect|createConnection|ping|connect.*NAS|写入远端|真实.*NAS" src/nas.js src/server.js src/web README.md test
```

Expected: Existing local Web/API `fetch` references are acceptable. There must be no new NAS endpoint network call or real NAS execution claim.

- [ ] **Step 3: Local HTTP smoke**

If a Linke server is already running on the chosen port, use a different port. Run:

```bash
PORT=3004 HOST=127.0.0.1 DATA_DIR=/Users/ah/linke/data node src/server.js
```

Then POST:

```bash
curl -s -X POST http://127.0.0.1:3004/api/nas-dry-run \
  -H 'Content-Type: application/json' \
  --data '{"deviceId":"smoke","nasTargets":[{"name":"syno","provider":"synology","endpoint":"http://192.168.1.100:5000","shareName":"backup","remotePath":"/volume1/backup","enabled":true}],"backupJobs":[{"name":"docs","sourcePath":"/Users/ah/Documents"}]}'
```

Expected JSON includes:

```json
{
  "mode": "dry-run",
  "wouldConnect": false,
  "wouldWrite": false
}
```

Then verify HTML hook:

```bash
curl -s http://127.0.0.1:3004/ | rg "nas-dry-run-panel|nas-dry-run-config|nas-dry-run-run|nas-dry-run-result"
```

Expected: all four hooks appear.

- [ ] **Step 4: Git status**

Run:

```bash
git status --short
```

Expected: only V0.13 implementation files and pre-existing untracked V0.12 plan if commits are not authorized.

- [ ] **Step 5: Commit only if authorized**

If the user explicitly authorizes commit, use:

```bash
git add README.md src/server.js src/web/index.html src/web/styles.css src/web/app.js test/readme.test.js test/web-console.test.js docs/superpowers/specs/2026-07-04-nas-dry-run-web-panel-design.md docs/superpowers/plans/2026-07-04-nas-dry-run-web-panel.md
git commit -m "feat: add v0.13 nas dry-run web panel"
```

- [ ] **Step 6: Final handoff**

Report:

- Worker results from AGY, Qwen, and ZAI.
- `npm test` result.
- Local HTTP smoke result.
- Remaining uncommitted files.
- Whether commit/push was performed.
