# Release Health Web Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Linke V0.48 Web Console release health panel for the existing `GET /api/health` endpoint.

**Architecture:** Add a small read-only Web Console panel with stable `release-health-*` hooks, a manual refresh button, and a pure `buildReleaseHealthViewModel()` helper in `src/web/app.js`. The panel does not auto-poll; it binds inside the existing `initConsole(doc, fetchImpl, intervalImpl)` signature and only calls `/api/health` when the operator clicks refresh.

**Tech Stack:** Node.js ESM, browser DOM APIs, existing mock DOM tests in `test/web-console.test.js`, README contract tests.

## Global Constraints

- Read-only Web Console feature.
- Only calls `GET /api/health`.
- No server route changes.
- No startup health fetch and no health polling in the 10 second `/api/devices` interval.
- No metadata writes, local data writes, NAS connection, NAS app invocation, backup, restore, sync, delete, credential handling, or remote command.
- Keep `initConsole(doc, fetchImpl, intervalImpl)` signature unchanged.
- Use `textContent` only for dynamic health text.
- Disable `release-health-refresh` while one health request is in flight; do not queue concurrent checks.
- `release-health-panel` must expose `data-status="unknown|ok|degraded|error"`.

---

### Task 1: RED Tests

**Files:**
- Modify: `test/web-console.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**
- Consumes existing `buildMockDoc()` helper and `initConsole()`.
- Produces failing expectations for `buildReleaseHealthViewModel`, `release-health-*` HTML hooks, `/api/health` click behavior, CSS state hooks, and V0.48 README docs.

- [ ] **Step 1: Add app.js import for the new pure helper**

In `test/web-console.test.js`, extend the import list from `../src/web/app.js`:

```js
  buildReleaseHealthViewModel,
```

Expected RED failure before implementation:

```text
SyntaxError: The requested module '../src/web/app.js' does not provide an export named 'buildReleaseHealthViewModel'
```

This import failure will prevent `test/web-console.test.js` from loading and can make the whole file fail before individual tests run. Treat that as the expected RED signal for the missing export, not as an existing Web Console regression.

- [ ] **Step 2: Add HTML contract tests**

In the `Web Console / API contract` describe block, after the existing V0.46/V0.47 related tests or near other HTML contract tests, add:

```js
  // ── V0.48 Release Health Web panel ─────────────────────────────

  it('HTML contains release health panel with required data-testid hooks', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.ok(html.includes('data-testid="release-health-panel"'), 'must have release-health-panel');
    assert.ok(html.includes('data-testid="release-health-status"'), 'must have release-health-status');
    assert.ok(html.includes('data-testid="release-health-version"'), 'must have release-health-version');
    assert.ok(html.includes('data-testid="release-health-data-dir"'), 'must have release-health-data-dir');
    assert.ok(html.includes('data-testid="release-health-timestamp"'), 'must have release-health-timestamp');
    assert.ok(html.includes('data-testid="release-health-message"'), 'must have release-health-message');
    assert.ok(html.includes('data-testid="release-health-refresh"'), 'must have release-health-refresh');
    assert.ok(html.includes('data-testid="release-health-safety-note"'), 'must have release-health-safety-note');
    assert.ok(html.includes('data-status="unknown"'), 'initial status must be unknown');
  });

  it('release health panel is read-only and does not expose execution wording', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    const panelMatch = html.match(/data-testid="release-health-panel"[\s\S]*?<\/section>/);

    assert.ok(panelMatch, 'release-health-panel section must exist');
    assert.ok(/只读|GET \/api\/health|健康检查/.test(panelMatch[0]), 'panel must communicate read-only health check behavior');
    assert.ok(/不写入|metadata/i.test(panelMatch[0]), 'panel must state no metadata writes');
    assert.ok(/不连接 NAS|不建立真实 NAS 连接/.test(panelMatch[0]), 'panel must state no NAS connection');
    assert.ok(/不执行远程命令/.test(panelMatch[0]), 'panel must state no remote command execution');
    assert.ok(!/执行备份|创建备份|执行恢复|删除快照|连接 NAS 设备|远程传输/i.test(panelMatch[0]), 'panel must not expose backup/restore/NAS execution wording');
  });

  it('app.js wires release health refresh to /api/health', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();

    assert.ok(js.includes('/api/health'), 'app.js must reference /api/health');
    assert.ok(js.includes('release-health-refresh'), 'app.js must reference release-health-refresh');
    assert.ok(js.includes('buildReleaseHealthViewModel'), 'app.js must normalize release health payloads');
  });

  it('styles.css contains release health state selectors', async () => {
    const res = await fetch(`http://localhost:${port}/styles.css`);
    const css = await res.text();

    assert.ok(css.includes('.release-health-panel[data-status="ok"]'), 'must style ok state');
    assert.ok(css.includes('.release-health-panel[data-status="degraded"]'), 'must style degraded state');
    assert.ok(css.includes('.release-health-panel[data-status="error"]'), 'must style error state');
  });
```

- [ ] **Step 3: Add pure view-model tests**

Add a new describe block before `describe('initConsole', ...)`:

```js
describe('V0.48 release health view model', () => {
  it('normalizes ok health payload without path disclosure', () => {
    const result = buildReleaseHealthViewModel({
      status: 'ok',
      service: 'linke',
      version: 'V0.46',
      checks: {
        http: 'ok',
        dataDirReadable: 'ok',
      },
      timestamp: '2026-07-05T00:00:00.000Z',
      dataDir: '/private/tmp/linke-secret-path',
    });

    assert.strictEqual(result.statusKey, 'ok');
    assert.strictEqual(result.statusText, '正常');
    assert.strictEqual(result.versionText, 'V0.46');
    assert.strictEqual(result.dataDirText, '可读');
    assert.strictEqual(result.timestampText, '2026-07-05T00:00:00.000Z');
    assert.strictEqual(result.messageText, 'GET /api/health 成功');
    assert.doesNotMatch(JSON.stringify(result), /private|tmp|linke-secret-path/);
  });

  it('normalizes degraded health payload as visible warning, not failure', () => {
    const result = buildReleaseHealthViewModel({
      status: 'degraded',
      service: 'linke',
      version: 'V0.46',
      checks: {
        http: 'ok',
        dataDirReadable: 'unavailable',
      },
      timestamp: '2026-07-05T00:00:00.000Z',
    });

    assert.strictEqual(result.statusKey, 'degraded');
    assert.strictEqual(result.statusText, '降级');
    assert.strictEqual(result.dataDirText, '不可用');
    assert.match(result.messageText, /降级|checks/);
  });

  it('normalizes failed health checks as error state', () => {
    const result = buildReleaseHealthViewModel(null, 'HTTP 500');

    assert.strictEqual(result.statusKey, 'error');
    assert.strictEqual(result.statusText, '检查失败');
    assert.strictEqual(result.versionText, '—');
    assert.strictEqual(result.dataDirText, '—');
    assert.strictEqual(result.timestampText, '—');
    assert.match(result.messageText, /HTTP 500/);
  });

  it('returns unknown state before a check has run', () => {
    const result = buildReleaseHealthViewModel(null);

    assert.strictEqual(result.statusKey, 'unknown');
    assert.strictEqual(result.statusText, '未检查');
    assert.strictEqual(result.versionText, '—');
    assert.strictEqual(result.dataDirText, '—');
    assert.strictEqual(result.timestampText, '—');
    assert.match(result.messageText, /点击刷新状态/);
  });
});
```

- [ ] **Step 4: Add DOM click behavior tests**

Near other `initConsole` DOM tests, add:

```js
describe('V0.48 Release Health Web Panel DOM tests', () => {
  it('does not fetch /api/health on init, then fetches once when refresh is clicked', async () => {
    const doc = buildMockDoc();
    const calls = [];
    const mockFetch = async (url) => {
      calls.push(url);
      if (url === '/api/health') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'ok',
            service: 'linke',
            version: 'V0.46',
            checks: { http: 'ok', dataDirReadable: 'ok' },
            timestamp: '2026-07-05T00:00:00.000Z',
          }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 20));

    assert.deepStrictEqual(calls.filter((url) => url === '/api/health'), []);

    await doc.getElementById('release-health-refresh')._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.deepStrictEqual(calls.filter((url) => url === '/api/health'), ['/api/health']);
    assert.strictEqual(doc.getElementById('release-health-panel')._attrs['data-status'], 'ok');
    assert.strictEqual(doc.getElementById('release-health-status').textContent, '正常');
    assert.strictEqual(doc.getElementById('release-health-version').textContent, 'V0.46');
    assert.strictEqual(doc.getElementById('release-health-data-dir').textContent, '可读');
    assert.strictEqual(doc.getElementById('release-health-timestamp').textContent, '2026-07-05T00:00:00.000Z');
    assert.match(doc.getElementById('release-health-message').textContent, /成功/);
  });

  it('renders non-2xx health response as error without throwing', async () => {
    const doc = buildMockDoc();
    const mockFetch = async (url) => {
      if (url === '/api/health') {
        return { ok: false, status: 503, json: async () => ({ error: 'unavailable' }) };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 20));
    await doc.getElementById('release-health-refresh')._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(doc.getElementById('release-health-panel')._attrs['data-status'], 'error');
    assert.strictEqual(doc.getElementById('release-health-status').textContent, '检查失败');
    assert.match(doc.getElementById('release-health-message').textContent, /HTTP 503/);
  });

  it('renders malformed health JSON as error without throwing', async () => {
    const doc = buildMockDoc();
    const mockFetch = async (url) => {
      if (url === '/api/health') {
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new Error('Invalid JSON');
          },
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 20));
    await doc.getElementById('release-health-refresh')._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(doc.getElementById('release-health-panel')._attrs['data-status'], 'error');
    assert.strictEqual(doc.getElementById('release-health-status').textContent, '检查失败');
    assert.match(doc.getElementById('release-health-message').textContent, /Invalid JSON/);
  });

  it('disables the release health refresh button while the request is in flight', async () => {
    const doc = buildMockDoc();
    let resolveHealth;
    const healthResponse = new Promise((resolve) => {
      resolveHealth = resolve;
    });
    const mockFetch = async (url) => {
      if (url === '/api/health') return healthResponse;
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 20));

    const refresh = doc.getElementById('release-health-refresh');
    const clickPromise = refresh._listeners.click();
    assert.strictEqual(refresh.disabled, true);
    assert.strictEqual(refresh._attrs['aria-disabled'], 'true');

    resolveHealth({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'degraded',
        service: 'linke',
        version: 'V0.46',
        checks: { http: 'ok', dataDirReadable: 'unavailable' },
        timestamp: '2026-07-05T00:00:00.000Z',
      }),
    });
    await clickPromise;
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(refresh.disabled, false);
    assert.strictEqual(refresh._attrs['aria-disabled'], 'false');
    assert.strictEqual(doc.getElementById('release-health-panel')._attrs['data-status'], 'degraded');
  });
});
```

- [ ] **Step 5: Add README RED tests**

In `test/readme.test.js`:

```js
  it('mentions V0.48 (release health Web panel)', () => {
    assertReadmeContains(/V0\.48/, 'V0.48');
  });
```

Add a V0.48 block:

```js
describe('README — V0.48 release health Web panel', () => {
  it('title and badge say V0.48', () => {
    assert.match(readme, /^# Linke V0\.48/m);
    assert.match(readme, /当前版本：V0\.48/);
  });

  it('version table has V0.48 row with 当前版本 milestone', () => {
    assert.match(readme, /\| V0\.48 \| 当前版本 \|[^|]*(发布健康检查面板|release health Web panel|\/api\/health)/i);
  });

  it('documents the release health Web panel and manual refresh semantics', () => {
    assert.match(readme, /发布健康检查面板|release health Web panel/i);
    assert.match(readme, /\/api\/health/);
    assert.match(readme, /手动刷新|刷新健康|刷新状态/);
    assert.match(readme, /不自动.*轮询|不.*后台.*轮询|no.*poll/i);
  });

  it('asserts safety docs for release health Web panel', () => {
    assert.match(readme, /只读/);
    assert.match(readme, /不写入(任何)?元数据|不写入(any)?metadata/);
    assert.match(readme, /不连接 NAS|不建立真实 NAS 连接/);
    assert.match(readme, /不执行(任何)?远程命令|不执行远程命令/);
    assert.match(readme, /不新增(后端)?接口|不新增 API|不改变 server route/i);
  });

  it('documents testing coverage includes release health Web panel', () => {
    assert.match(readme, /测试覆盖：.*发布健康检查面板/);
  });
});
```

- [ ] **Step 6: Verify RED**

Run:

```bash
node --test test/web-console.test.js test/readme.test.js
```

Expected: FAIL because the new export, HTML hooks, CSS selectors, DOM behavior, and README V0.48 docs do not exist.

### Task 2: GREEN Implementation

**Files:**
- Modify: `src/web/index.html`
- Modify: `src/web/app.js`
- Modify: `src/web/styles.css`
- Modify: `README.md`

**Interfaces:**
- Produces exported `buildReleaseHealthViewModel(payload, errorMessage)`.
- Produces DOM update path bound to `release-health-refresh`.
- Keeps `initConsole(doc, fetchImpl, intervalImpl)` signature unchanged.

- [ ] **Step 1: Add Web Console HTML panel**

In `src/web/index.html`, add this panel near the top after `fleet-summary`:

```html
      <section id="release-health-panel" class="panel release-health-panel" data-testid="release-health-panel" data-status="unknown">
        <div class="panel-title-row">
          <h2>发布健康检查</h2>
          <button id="release-health-refresh" data-testid="release-health-refresh" type="button" class="release-health-refresh" aria-disabled="false">刷新状态</button>
        </div>
        <dl class="release-health-grid">
          <div class="release-health-row">
            <dt>状态</dt>
            <dd id="release-health-status" data-testid="release-health-status">未检查</dd>
          </div>
          <div class="release-health-row">
            <dt>版本</dt>
            <dd id="release-health-version" data-testid="release-health-version">—</dd>
          </div>
          <div class="release-health-row">
            <dt>数据目录</dt>
            <dd id="release-health-data-dir" data-testid="release-health-data-dir">—</dd>
          </div>
          <div class="release-health-row">
            <dt>时间戳</dt>
            <dd id="release-health-timestamp" data-testid="release-health-timestamp">—</dd>
          </div>
        </dl>
        <p id="release-health-message" class="release-health-message" data-testid="release-health-message">点击刷新状态获取 /api/health</p>
        <div class="release-health-safety-note" data-testid="release-health-safety-note">
          <p>发布健康检查面板为只读视图，仅手动 GET /api/health，不自动后台轮询、不写入 metadata、不连接 NAS、不执行远程命令、不新增后端接口。</p>
        </div>
      </section>
```

- [ ] **Step 2: Add release health view model helper**

In `src/web/app.js`, near other pure functions, add:

```js
export function buildReleaseHealthViewModel(payload, errorMessage = '') {
  if (errorMessage) {
    return {
      statusKey: 'error',
      statusText: '检查失败',
      versionText: '—',
      dataDirText: '—',
      timestampText: '—',
      messageText: '健康检查失败: ' + errorMessage,
    };
  }

  if (!payload || typeof payload !== 'object') {
    return {
      statusKey: 'unknown',
      statusText: '未检查',
      versionText: '—',
      dataDirText: '—',
      timestampText: '—',
      messageText: '点击刷新状态获取 /api/health',
    };
  }

  const status = payload.status === 'degraded' ? 'degraded' : 'ok';
  const dataDirReadable = payload.checks?.dataDirReadable;
  const dataDirText = dataDirReadable === 'ok'
    ? '可读'
    : (dataDirReadable === 'unavailable' ? '不可用' : '未知');

  return {
    statusKey: status,
    statusText: status === 'degraded' ? '降级' : '正常',
    versionText: String(payload.version || 'unknown'),
    dataDirText,
    timestampText: String(payload.timestamp || '—'),
    messageText: status === 'degraded'
      ? 'GET /api/health 成功，但 checks 显示服务降级'
      : 'GET /api/health 成功',
  };
}
```

- [ ] **Step 3: Bind panel elements and render path**

Inside `initConsole()`, add element references with the existing element lookup pattern:

```js
  const releaseHealthPanelEl = doc.getElementById('release-health-panel');
  const releaseHealthStatusEl = doc.getElementById('release-health-status');
  const releaseHealthVersionEl = doc.getElementById('release-health-version');
  const releaseHealthDataDirEl = doc.getElementById('release-health-data-dir');
  const releaseHealthTimestampEl = doc.getElementById('release-health-timestamp');
  const releaseHealthMessageEl = doc.getElementById('release-health-message');
  const releaseHealthRefreshButton = doc.getElementById('release-health-refresh');
```

Add helper functions inside `initConsole()`:

```js
  let releaseHealthInFlight = false;

  function renderReleaseHealth(viewModel) {
    const state = viewModel || buildReleaseHealthViewModel(null);
    if (releaseHealthPanelEl?.setAttribute) {
      releaseHealthPanelEl.setAttribute('data-status', state.statusKey);
    }
    if (releaseHealthStatusEl) releaseHealthStatusEl.textContent = state.statusText;
    if (releaseHealthVersionEl) releaseHealthVersionEl.textContent = state.versionText;
    if (releaseHealthDataDirEl) releaseHealthDataDirEl.textContent = state.dataDirText;
    if (releaseHealthTimestampEl) releaseHealthTimestampEl.textContent = state.timestampText;
    if (releaseHealthMessageEl) releaseHealthMessageEl.textContent = state.messageText;
  }

  function setReleaseHealthRefreshBusy(busy) {
    if (!releaseHealthRefreshButton) return;
    releaseHealthRefreshButton.disabled = Boolean(busy);
    if (releaseHealthRefreshButton.setAttribute) {
      releaseHealthRefreshButton.setAttribute('aria-disabled', busy ? 'true' : 'false');
    }
  }

  async function fetchReleaseHealth() {
    if (releaseHealthInFlight) return;
    releaseHealthInFlight = true;
    setReleaseHealthRefreshBusy(true);
    try {
      const res = await fetchImpl('/api/health');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const payload = await res.json();
      renderReleaseHealth(buildReleaseHealthViewModel(payload));
      logEvent('已刷新发布健康检查', 'info');
    } catch (err) {
      renderReleaseHealth(buildReleaseHealthViewModel(null, err.message));
      logEvent('发布健康检查失败: ' + err.message, 'error');
    } finally {
      releaseHealthInFlight = false;
      setReleaseHealthRefreshBusy(false);
    }
  }
```

Bind the click handler near other event bindings:

```js
  renderReleaseHealth(buildReleaseHealthViewModel(null));

  if (releaseHealthRefreshButton?.addEventListener) {
    releaseHealthRefreshButton.addEventListener('click', fetchReleaseHealth);
  }
```

Do not call `fetchReleaseHealth()` during startup. Do not add it to `intervalImpl`.

- [ ] **Step 4: Add CSS state styling**

In `src/web/styles.css`, add:

```css
.release-health-panel[data-status="ok"] {
  border-top: 3px solid #15803d;
}

.release-health-panel[data-status="degraded"] {
  border-top: 3px solid #ca8a04;
}

.release-health-panel[data-status="error"] {
  border-top: 3px solid #b91c1c;
}

.release-health-grid {
  display: grid;
  gap: 8px;
  margin-bottom: 10px;
}

.release-health-row {
  display: grid;
  grid-template-columns: 90px minmax(0, 1fr);
  gap: 8px;
  font-size: 0.82rem;
}

.release-health-row dt {
  color: #6b7280;
  font-weight: 600;
}

.release-health-row dd {
  color: #111827;
  overflow-wrap: anywhere;
}

.release-health-message,
.release-health-safety-note {
  color: #6b7280;
  font-size: 0.78rem;
  line-height: 1.45;
}

.release-health-refresh {
  padding: 6px 12px;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  background: #f9fafb;
  color: #374151;
  font-size: 0.78rem;
  font-weight: 500;
  cursor: pointer;
}

.release-health-refresh:disabled,
.release-health-refresh[aria-disabled="true"] {
  opacity: 0.45;
  cursor: not-allowed;
}
```

- [ ] **Step 5: Update README to V0.48**

Update `README.md`:

- Title: `# Linke V0.48`
- Badge: `当前版本：V0.48`
- Version table: change V0.47 to `历史版本`; add V0.48 `当前版本`.
- Feature list: add `发布健康检查面板`.
- Add section after V0.47:

```md
### 发布健康检查面板

V0.48 在 Web Console 中新增发布健康检查面板。

- 面板通过手动点击“刷新状态”执行一次只读 GET `/api/health`。
- 面板展示 `status`、版本号、`checks.dataDirReadable` 和响应时间戳。
- 当响应为 `status:"degraded"` 时，面板显示“降级”，但不把降级解释为发布阻断策略；调用者仍需检查 JSON 的 `status` / `checks` 字段。
- 该面板不在启动时自动请求 `/api/health`，也不加入后台轮询。

### 发布健康检查面板安全边界

发布健康检查面板具备以下安全保证：
- **只读**：仅手动 GET `/api/health`。
- **不写入任何元数据**：不会写入 metadata、设备数据、快照数据或本地配置。
- **不新增后端接口**：复用既有 `/api/health`，不改变 server route。
- **不连接 NAS**：不建立真实 NAS 连接，不调用 NAS app。
- **不执行远程命令**：不执行任何本地或远程命令。
- **不自动轮询**：V0.48 不做健康检查后台轮询或重试循环。
```

Update testing coverage sentence with `发布健康检查面板`.

- [ ] **Step 6: Verify GREEN target tests**

Run:

```bash
node --test test/web-console.test.js test/readme.test.js
```

Expected: PASS.

### Task 3: Verification

**Files:**
- No new production edits unless a verification finding requires a targeted fix.

- [ ] **Step 1: Run target tests**

```bash
node --test test/web-console.test.js test/readme.test.js
```

- [ ] **Step 2: Run full suite**

```bash
npm test
```

- [ ] **Step 3: Run diff check**

```bash
git diff --check
```

- [ ] **Step 4: Qwen adversarial review**

Ask Qwen to review current diff for:

- no server route changes;
- no automatic `/api/health` polling;
- only one GET `/api/health` per click;
- disabled refresh button during request;
- no path/secret disclosure;
- no NAS/backup/restore/remote command wording or behavior;
- README and tests matching V0.48.

- [ ] **Step 5: Real HTTP/Web smoke**

Start a temporary local server and verify:

```bash
curl -s http://127.0.0.1:<port>/ | rg "release-health-panel|release-health-refresh"
curl -s http://127.0.0.1:<port>/app.js | rg "/api/health|buildReleaseHealthViewModel"
curl -s http://127.0.0.1:<port>/styles.css | rg "release-health-panel\\[data-status"
```

Then run a small browserless DOM smoke through `node --test test/web-console.test.js`.

- [ ] **Step 6: ZAI auxiliary verifier**

Use a strict English read-only prompt with final schema:

```text
Status: DONE | DONE_WITH_CONCERNS | FAILED_VERIFICATION
Blocking issues:
Non-blocking concerns:
Evidence reviewed:
Final verdict:
```

If ZAI returns only tool errors, empty output, missing status fields, or `I do not have a specific response`, record it as inconclusive and do not use it as primary evidence.

- [ ] **Step 7: Commit and push**

```bash
git add README.md src/web/index.html src/web/app.js src/web/styles.css test/web-console.test.js test/readme.test.js docs/superpowers/plans/2026-07-05-release-health-web-panel.md
git commit -m "feat: add release health web panel"
git push
```
