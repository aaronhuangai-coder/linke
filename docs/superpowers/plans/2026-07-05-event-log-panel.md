# Event Log Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance the existing Linke Web Console event log into a structured, bounded, in-memory, read-only operational log for V0.20.

**Architecture:** Keep the feature entirely in the existing static Web Console. Add HTML summary hooks to `src/web/index.html`, enhance `logEvent()` in `src/web/app.js`, and extend existing Node tests to cover DOM behavior and README versioning. No backend route, persistence, NAS call, backup execution, restore execution, or metadata write is allowed.

**Tech Stack:** Node.js ESM, built-in `node:test`, static HTML/CSS/JS, no runtime dependencies.

## Global Constraints

- Current version becomes `V0.20`.
- Event logs are browser-memory-only and reset on page refresh.
- Visible event entries are capped at 50 newest entries.
- Counters are cumulative for the current page lifecycle and are not reduced by visible-entry trimming.
- Event DOM must be built with `createElement` and `textContent`, not `innerHTML`.
- Do not add backend API routes.
- Do not persist event logs to files or metadata.
- Do not connect to NAS or invoke NAS apps.
- Do not trigger real backup, restore, delete, sync, or remote transfer.
- Do not read or output secrets.
- Do not commit or push; Codex PM owns final verification and human gate.

---

## File Structure

- Modify `src/web/index.html`: add event log panel summary counters and safety note.
- Modify `src/web/app.js`: add bounded structured event rendering and cumulative counters.
- Modify `src/web/styles.css`: add compact event summary/entry styles.
- Modify `test/web-console.test.js`: add HTML contract and DOM behavior tests.
- Modify `README.md`: bump to V0.20 and document event log enhancement.
- Modify `test/readme.test.js`: assert V0.20 documentation and safety boundary.

## Task 1: Web Console Event Log Behavior

**Files:**
- Modify: `src/web/index.html`
- Modify: `src/web/app.js`
- Modify: `src/web/styles.css`
- Test: `test/web-console.test.js`

**Interfaces:**
- Consumes: existing `initConsole(doc, fetchImpl, intervalImpl)`.
- Produces: structured event entries with `data-testid="event-entry"` and `data-event-type`.
- Produces: module-level constant or local constant named `EVENT_LOG_VISIBLE_LIMIT` with value `50`.

- [ ] **Step 1: Write failing HTML contract tests**

Add tests to `test/web-console.test.js`:

```js
it('HTML contains V0.20 event log panel summary hooks', async () => {
  const res = await fetch(`http://localhost:${port}/`);
  const html = await res.text();

  assert.ok(html.includes('data-testid="event-log-panel"'), 'must have event-log-panel');
  assert.ok(html.includes('data-testid="event-total-count"'), 'must have event-total-count');
  assert.ok(html.includes('data-testid="event-info-count"'), 'must have event-info-count');
  assert.ok(html.includes('data-testid="event-error-count"'), 'must have event-error-count');
  assert.ok(html.includes('data-testid="event-latest-message"'), 'must have event-latest-message');
  assert.ok(html.includes('data-testid="event-log"'), 'must keep event-log list hook');
  assert.ok(html.includes('data-testid="event-log-safety-note"'), 'must have event-log-safety-note');
});

it('event log panel is read-only and has no execution controls', async () => {
  const res = await fetch(`http://localhost:${port}/`);
  const html = await res.text();
  const panelMatch = html.match(/data-testid="event-log-panel"[\s\S]*?<\/section>/);
  assert.ok(panelMatch, 'event-log-panel section must exist');
  assert.ok(!panelMatch[0].includes('<button'), 'event log panel must not contain action buttons');
  assert.ok(/只读|内存|不写入/.test(panelMatch[0]), 'event log safety note must state read-only memory behavior');
});
```

- [ ] **Step 2: Add DOM behavior tests**

Use or extend the existing minimal DOM stubs in `test/web-console.test.js` so `prepend`, `appendChild`, `removeChild`, `lastChild`, `children`, `dataset`, `setAttribute`, and `querySelector` behavior needed by the event log are real enough to assert children.

Add tests that call `initConsole()` with controlled `fetchImpl`:

```js
it('renders structured event log entries and cumulative counts', async () => {
  const doc = createTestDocumentForConsole();
  const fetchImpl = async (url) => {
    if (url === '/api/devices') {
      return {
        ok: true,
        status: 200,
        json: async () => ([{
          deviceId: 'event-device',
          hostname: 'EventDevice',
          ipAddress: '10.0.0.20',
          status: 'online',
          snapshotCount: 0,
        }]),
      };
    }
    return { ok: true, status: 200, json: async () => [] };
  };

  initConsole(doc, fetchImpl, () => {});
  await new Promise((resolve) => setTimeout(resolve, 20));

  const eventLog = doc.getElementById('event-log');
  assert.ok(eventLog.children.length >= 2, 'startup and device-load events should render');
  assert.strictEqual(doc.querySelector('[data-testid="event-error-count"]').textContent, '0');
  assert.match(doc.querySelector('[data-testid="event-total-count"]').textContent, /^[2-9]\d*|2$/);

  const latest = eventLog.children[0];
  assert.strictEqual(latest.getAttribute('data-testid'), 'event-entry');
  assert.strictEqual(latest.dataset.eventType, 'info');
  assert.ok(latest.querySelector('[data-testid="event-entry-time"]').textContent);
  assert.strictEqual(latest.querySelector('[data-testid="event-entry-type"]').textContent, 'info');
  assert.match(latest.querySelector('[data-testid="event-entry-message"]').textContent, /已加载|Linke 控制台已启动/);
});

it('renders device load failures as text-only error events', async () => {
  const doc = createTestDocumentForConsole();
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });

  initConsole(doc, fetchImpl, () => {});
  await new Promise((resolve) => setTimeout(resolve, 20));

  const eventLog = doc.getElementById('event-log');
  const latest = eventLog.children[0];
  assert.strictEqual(latest.dataset.eventType, 'error');
  assert.strictEqual(doc.querySelector('[data-testid="event-error-count"]').textContent, '1');
  assert.match(latest.querySelector('[data-testid="event-entry-message"]').textContent, /加载设备失败/);
  assert.strictEqual(latest.innerHTML || '', '', 'event entries must not be assembled with innerHTML');
});

it('keeps newest event entries first and trims visible entries to 50', async () => {
  const doc = createTestDocumentForConsole();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return { ok: true, status: 200, json: async () => [] };
    }
    return { ok: false, status: 500 + calls, json: async () => ({}) };
  };
  const intervalCallbacks = [];

  initConsole(doc, fetchImpl, (fn) => {
    intervalCallbacks.push(fn);
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  for (let i = 0; i < 55; i++) {
    await intervalCallbacks[0]();
  }

  const eventLog = doc.getElementById('event-log');
  assert.strictEqual(eventLog.children.length, 50);
  assert.strictEqual(doc.querySelector('[data-testid="event-total-count"]').textContent, '57');
  assert.match(eventLog.children[0].querySelector('[data-testid="event-entry-message"]').textContent, /加载设备失败/);
});
```

- [ ] **Step 3: Run RED tests**

Run:

```bash
node --test test/web-console.test.js
```

Expected: fails because event log panel hooks and structured entries are not implemented yet.

- [ ] **Step 4: Implement HTML panel hooks**

In `src/web/index.html`, change the existing events panel to:

```html
<section class="panel events-panel" data-testid="event-log-panel">
  <h2>事件日志</h2>
  <div class="event-log-summary">
    <div class="event-log-stat">
      <span id="event-total-count" data-testid="event-total-count">0</span>
      <span>累计事件</span>
    </div>
    <div class="event-log-stat">
      <span id="event-info-count" data-testid="event-info-count">0</span>
      <span>Info</span>
    </div>
    <div class="event-log-stat">
      <span id="event-error-count" data-testid="event-error-count">0</span>
      <span>Error</span>
    </div>
  </div>
  <div id="event-latest-message" class="event-latest-message" data-testid="event-latest-message">暂无事件</div>
  <div data-testid="event-log" id="event-log" class="event-log"></div>
  <div class="event-log-safety-note" data-testid="event-log-safety-note">
    <p>事件日志为前端内存中的只读运行轨迹，只展示本页面生命周期内的控制台事件，不写入 metadata、不触发备份、不执行恢复、不连接 NAS。</p>
  </div>
</section>
```

- [ ] **Step 5: Implement structured `logEvent()`**

In `src/web/app.js`:

```js
const EVENT_LOG_VISIBLE_LIMIT = 50;
```

Inside `initConsole`, get summary elements:

```js
const eventTotalCountEl = doc.querySelector('[data-testid="event-total-count"]');
const eventInfoCountEl = doc.querySelector('[data-testid="event-info-count"]');
const eventErrorCountEl = doc.querySelector('[data-testid="event-error-count"]');
const eventLatestMessageEl = doc.querySelector('[data-testid="event-latest-message"]');
```

Add counters:

```js
let eventTotalCount = 0;
let eventInfoCount = 0;
let eventErrorCount = 0;
```

Replace `logEvent()` with createElement/textContent-only rendering:

```js
function normalizeEventType(type) {
  return type === 'error' ? 'error' : 'info';
}

function updateEventSummary(type, message) {
  eventTotalCount += 1;
  if (type === 'error') eventErrorCount += 1;
  else eventInfoCount += 1;

  if (eventTotalCountEl) eventTotalCountEl.textContent = String(eventTotalCount);
  if (eventInfoCountEl) eventInfoCountEl.textContent = String(eventInfoCount);
  if (eventErrorCountEl) eventErrorCountEl.textContent = String(eventErrorCount);
  if (eventLatestMessageEl) eventLatestMessageEl.textContent = message;
}

function logEvent(msg, type) {
  if (!eventLogEl) return;
  const eventType = normalizeEventType(type);
  const message = String(msg || '');
  updateEventSummary(eventType, message);

  const entry = doc.createElement('div');
  entry.className = 'event-entry event-' + eventType;
  entry.setAttribute('data-testid', 'event-entry');
  entry.setAttribute('data-event-type', eventType);
  entry.dataset.eventType = eventType;

  const time = doc.createElement('span');
  time.className = 'event-entry-time';
  time.setAttribute('data-testid', 'event-entry-time');
  time.textContent = new Date().toLocaleTimeString();

  const badge = doc.createElement('span');
  badge.className = 'event-entry-type event-entry-type-' + eventType;
  badge.setAttribute('data-testid', 'event-entry-type');
  badge.textContent = eventType;

  const text = doc.createElement('span');
  text.className = 'event-entry-message';
  text.setAttribute('data-testid', 'event-entry-message');
  text.textContent = message;

  entry.appendChild(time);
  entry.appendChild(badge);
  entry.appendChild(text);
  eventLogEl.prepend(entry);

  while (eventLogEl.children && eventLogEl.children.length > EVENT_LOG_VISIBLE_LIMIT) {
    eventLogEl.removeChild(eventLogEl.lastChild);
  }
}
```

- [ ] **Step 6: Add CSS**

In `src/web/styles.css`, extend existing event styles:

```css
.event-log-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 10px;
}

.event-log-stat {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 8px;
  background: #f9fafb;
}

.event-log-stat span:first-child {
  display: block;
  font-weight: 700;
  color: #111827;
}

.event-latest-message {
  margin-bottom: 10px;
  color: #374151;
  font-size: 13px;
}

.event-log {
  display: grid;
  gap: 8px;
}

.event-entry {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  gap: 8px;
  align-items: start;
}

.event-entry-message {
  min-width: 0;
  overflow-wrap: anywhere;
}

.event-log-safety-note {
  margin-top: 10px;
  color: #6b7280;
  font-size: 12px;
}
```

- [ ] **Step 7: Run GREEN tests**

Run:

```bash
node --test test/web-console.test.js
```

Expected: all Web Console tests pass.

## Task 2: README V0.20 Documentation

**Files:**
- Modify: `README.md`
- Test: `test/readme.test.js`

**Interfaces:**
- Consumes: V0.20 event log behavior from Task 1.
- Produces: README version and safety documentation for V0.20.

- [ ] **Step 1: Write failing README tests**

Add tests to `test/readme.test.js`:

```js
it('mentions V0.20 (event log panel enhancement)', () => {
  assert.match(readme, /V0\.20/);
});

describe('README — V0.20 event log panel enhancement', () => {
  it('title says V0.20', () => {
    assert.match(readme, /^# Linke V0\.20/m);
  });

  it('version badge says 当前版本：V0.20', () => {
    assert.match(readme, /当前版本：V0\.20/);
  });

  it('version table has V0.20 row with 当前版本 milestone', () => {
    assert.match(readme, /\| V0\.20 \| 当前版本 \|[^|]*事件日志/);
  });

  it('documents event log enhancement as in-memory read-only view', () => {
    assert.match(readme, /事件日志面板增强/);
    assert.match(readme, /前端内存|内存态/);
    assert.match(readme, /只读/);
  });

  it('states event log enhancement does not write metadata or execute operations', () => {
    assert.match(readme, /事件日志[\s\S]*不写入 metadata/);
    assert.match(readme, /事件日志[\s\S]*不触发备份/);
    assert.match(readme, /事件日志[\s\S]*不执行恢复/);
    assert.match(readme, /事件日志[\s\S]*不连接 NAS/);
  });

  it('documents event log test coverage', () => {
    assert.match(readme, /事件日志面板增强/);
    assert.match(readme, /测试覆盖[\s\S]*事件日志面板增强/);
  });
});
```

- [ ] **Step 2: Run RED README tests**

Run:

```bash
node --test test/readme.test.js
```

Expected: fails because README is still V0.19.

- [ ] **Step 3: Update README**

Required documentation changes:

- Change `# Linke V0.19` to `# Linke V0.20`.
- Change current version badge to `V0.20`.
- Change V0.19 row from `当前版本` to `备份任务时间线 snapshot 联动`.
- Add V0.20 row:

```markdown
| V0.20 | 当前版本 | Web Console 事件日志面板增强，展示前端内存态结构化事件、累计计数、最近事件和 50 条可见上限 |
```

- Add feature bullet:

```markdown
- **事件日志面板增强** — Web Console 以只读前端内存态展示结构化事件日志、累计 info/error 计数、最近事件和最新 50 条可见事件
```

- Add section after V0.19 section:

```markdown
### Web Console 事件日志面板增强

V0.20 增强现有事件日志面板。控制台会在当前页面生命周期内，以前端内存态记录关键只读运行事件：

- 控制台启动
- 设备加载成功或失败
- 快照、快照清单、恢复预检、备份预检、NAS dry-run、快照差异和保留计划加载结果
- 累计事件数、info 数、error 数和最近事件
- 最新 50 条可见事件，最新在前

事件日志面板只展示当前页面内存中的运行轨迹，刷新页面后重置。它不新增 API 路由、不持久化日志、不写入 metadata、不触发备份、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程传输。
```

- Add security section:

```markdown
### 事件日志面板增强安全保证

- 事件日志仅保存在浏览器当前页面内存中，刷新后丢失。
- 事件日志不写入 `device.json`、`snapshots.json`、`manifest.json` 或其他 metadata。
- 事件日志不新增 API 路由，不连接 NAS，不调用 NAS app。
- 事件日志不触发备份、不执行恢复、不复制文件、不覆盖文件、不删除快照、不执行远程传输。
```

- Update test coverage summary to include `事件日志面板增强`.

- [ ] **Step 4: Run GREEN README tests**

Run:

```bash
node --test test/readme.test.js
```

Expected: all README tests pass.

## Task 3: Final Verification

**Files:**
- Read only: all modified files.

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces: verification evidence for Codex PM.

- [ ] **Step 1: Run focused tests**

```bash
node --test test/web-console.test.js
node --test test/readme.test.js
```

Expected: both pass.

- [ ] **Step 2: Run full suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Run whitespace check**

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 4: Inspect changed files**

```bash
git status -sb
git diff --stat
git diff -- src/web/index.html src/web/app.js src/web/styles.css test/web-console.test.js README.md test/readme.test.js
```

Expected: only V0.20 event log panel enhancement, tests, README, and this spec/plan are changed.

- [ ] **Step 5: HTTP smoke**

Start:

```bash
PORT=3006 HOST=127.0.0.1 DATA_DIR=/tmp/linke-v020-smoke node src/server.js
```

Probe:

```bash
node --input-type=module -e "const base='http://127.0.0.1:3006'; const html=await fetch(base+'/').then(r=>r.text()); const js=await fetch(base+'/app.js').then(r=>r.text()); const devices=await fetch(base+'/api/devices').then(r=>r.json()); console.log(JSON.stringify({html: html.includes('event-log-panel') && html.includes('event-total-count'), js: js.includes('EVENT_LOG_VISIBLE_LIMIT') && js.includes('event-entry-message'), devices: Array.isArray(devices)}));"
```

Expected:

```json
{"html":true,"js":true,"devices":true}
```

- [ ] **Step 6: Stop smoke server**

Ensure no process is listening on the smoke port.

## PM Review Notes

- Reject any implementation that uses `innerHTML` to build event entries.
- Reject any implementation that makes counters depend on visible 50-entry capacity.
- Reject any implementation that adds backend event APIs or persistence.
- Reject any implementation that adds execution controls to the event panel.
- Do not commit or push without explicit user confirmation.
