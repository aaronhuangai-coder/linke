# Device Detail Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Linke V0.15 Web Console device detail panel that shows selected-device identity, IP, status, heartbeat, backup, and snapshot summary from the existing device list payload.

**Architecture:** Reuse the existing `GET /api/devices` response and the current device-list selection flow in `src/web/app.js`. Add a read-only HTML panel with stable test hooks, render selected-device values using DOM nodes and `textContent`, and keep all behavior UI-only with no new backend route or storage writes.

**Tech Stack:** Node.js ESM, browser ESM, built-in `node:test`, zero external runtime dependencies.

## Global Constraints

- V0.15 is UI-only.
- Reuse existing `GET /api/devices`; do not add `GET /api/devices/:deviceId`.
- No device editing.
- No tags, notes, groups, ownership, or labels.
- No device metadata persistence changes.
- No authentication or permission model changes.
- No remote backup, remote command, wake, shutdown, ping, probe, or NAS action.
- No change to backup, restore, retention, NAS dry-run, or adapter behavior.
- Render all selected-device values using DOM nodes and `textContent`.
- Missing or malformed fields must use stable fallbacks and must not render `undefined`, `null`, or `Invalid Date`.
- Use `npm test` as the verification command.
- In this workspace, run `git commit` only when the user has explicitly approved committing.

---

### Task 1: README, HTML Shell, And Contract Tests

**Files:**
- Modify: `README.md`
- Modify: `src/web/index.html`
- Modify: `src/web/styles.css`
- Modify: `test/readme.test.js`
- Modify: `test/web-console.test.js`

**Interfaces:**
- Produces these static DOM hooks for Task 2:
  - `device-detail-panel`
  - `device-detail-content`
  - `device-detail-placeholder`
  - `device-detail-device-id`
  - `device-detail-hostname`
  - `device-detail-ip`
  - `device-detail-status`
  - `device-detail-heartbeat`
  - `device-detail-backup`
  - `device-detail-snapshots`

- [ ] **Step 1: Add failing README tests in `test/readme.test.js`**

Add the V0.15 version test after the V0.14 test:

```js
  it('mentions V0.15 (device detail panel)', () => {
    assertReadmeContains(/V0\.15/, 'V0.15');
  });
```

Add this test in `describe('README — Web Console', ...)` after the NAS app adapter docs test:

```js
  it('documents the Web Console device detail panel', () => {
    assertReadmeContains(
      /设备详情[\s\S]*hostname[\s\S]*ipAddress[\s\S]*lastHeartbeatAt|device detail[\s\S]*hostname[\s\S]*ipAddress[\s\S]*snapshotCount/i,
      'Web Console device detail panel',
    );
  });
```

- [ ] **Step 2: Add failing HTML contract tests in `test/web-console.test.js`**

Add these tests inside `describe('Web Console / API contract', ...)`, near the existing fleet/device-list tests:

```js
  // ── V0.15 Device detail Web Console panel ───────────────────────

  it('HTML contains device detail panel with required data-testid hooks', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.ok(html.includes('data-testid="device-detail-panel"'), 'must have device-detail-panel');
    assert.ok(html.includes('data-testid="device-detail-content"'), 'must have device-detail-content');
    assert.ok(html.includes('data-testid="device-detail-placeholder"'), 'must have device-detail-placeholder');
    assert.ok(html.includes('data-testid="device-detail-device-id"'), 'must have device-detail-device-id');
    assert.ok(html.includes('data-testid="device-detail-hostname"'), 'must have device-detail-hostname');
    assert.ok(html.includes('data-testid="device-detail-ip"'), 'must have device-detail-ip');
    assert.ok(html.includes('data-testid="device-detail-status"'), 'must have device-detail-status');
    assert.ok(html.includes('data-testid="device-detail-heartbeat"'), 'must have device-detail-heartbeat');
    assert.ok(html.includes('data-testid="device-detail-backup"'), 'must have device-detail-backup');
    assert.ok(html.includes('data-testid="device-detail-snapshots"'), 'must have device-detail-snapshots');
  });

  it('device detail panel starts with a select-device placeholder', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    const panelMatch = html.match(/data-testid="device-detail-panel"[\s\S]*?<\/section>/);

    assert.ok(panelMatch, 'device-detail-panel section must exist');
    assert.ok(panelMatch[0].includes('请选择一个设备'), 'panel must ask user to select a device');
    assert.ok(!/编辑|保存|删除|远程执行|ping|probe|wake|shutdown/i.test(panelMatch[0]), 'panel must not expose management actions');
  });
```

- [ ] **Step 3: Run tests to verify RED**

Run:

```bash
npm test
```

Expected: FAIL because README and HTML do not mention V0.15 or the device detail panel yet.

- [ ] **Step 4: Update README to V0.15**

Change the title and current version:

```md
# Linke V0.15

> **当前版本：V0.15** — 单机 localhost 原型阶段，尚未具备生产级安全隔离。
```

Change the V0.14 row from current version to:

```md
| V0.14 | NAS app adapter dry-run | 为 Synology / Ugreen 目标生成应用嵌套调用计划，不调用 NAS app、不连接、不写入 |
```

Add the V0.15 row after V0.14:

```md
| V0.15 | 当前版本 | Web Console 新增只读设备详情面板，展示 deviceId / hostname / ipAddress / status / lastHeartbeatAt / lastBackupAt / snapshotCount |
```

Update the Web Console feature bullet:

```md
- **Web Console** — 管理界面：设备列表 / 设备详情 / 快照列表 / 快照清单详情 / 恢复预检 / 备份预检 / NAS 预检 / 快照差异预览 / 事件日志 / 保留计划面板
```

Add a feature bullet after `设备心跳`:

```md
- **设备详情** — Web Console 可只读查看设备的 deviceId、hostname、IP 地址、状态、最后心跳、最后备份和快照数
```

Add a section after the Agent CLI section or before the existing Web Console feature subsections:

```md
### Web Console 设备详情面板

V0.15 在 Web Console 中增加只读设备详情面板。点击设备列表中的任意设备后，面板会复用现有 `/api/devices` 数据显示：

- `deviceId`
- `hostname`
- `ipAddress`
- `status`
- `lastHeartbeatAt`
- `lastBackupAt`
- `snapshotCount`

该面板只做统一管理视图展示，不新增设备详情 API、不写入设备元数据、不提供编辑、删除、远程命令、ping/probe 或 NAS 操作按钮。缺失字段会显示稳定 fallback，例如 `unknown`、`无心跳`、`无备份` 或 `0`。
```

Update the testing coverage sentence to include `设备详情面板`.

- [ ] **Step 5: Add the HTML panel in `src/web/index.html`**

Place this section immediately after the existing `devices-panel` and before `snapshots-panel`:

```html
      <section class="panel device-detail-panel" data-testid="device-detail-panel">
        <h2>设备详情</h2>
        <div id="device-detail-content" data-testid="device-detail-content">
          <p class="placeholder" data-testid="device-detail-placeholder">请选择一个设备</p>
          <dl class="device-detail-grid">
            <div class="device-detail-row">
              <dt>Device ID</dt>
              <dd data-testid="device-detail-device-id">unknown</dd>
            </div>
            <div class="device-detail-row">
              <dt>Hostname</dt>
              <dd data-testid="device-detail-hostname">unknown</dd>
            </div>
            <div class="device-detail-row">
              <dt>IP 地址</dt>
              <dd data-testid="device-detail-ip">unknown</dd>
            </div>
            <div class="device-detail-row">
              <dt>状态</dt>
              <dd data-testid="device-detail-status">unknown</dd>
            </div>
            <div class="device-detail-row">
              <dt>最后心跳</dt>
              <dd data-testid="device-detail-heartbeat">无心跳</dd>
            </div>
            <div class="device-detail-row">
              <dt>最后备份</dt>
              <dd data-testid="device-detail-backup">无备份</dd>
            </div>
            <div class="device-detail-row">
              <dt>快照数</dt>
              <dd data-testid="device-detail-snapshots">0</dd>
            </div>
          </dl>
        </div>
        <div class="device-detail-safety-note" data-testid="device-detail-safety-note">
          <p>设备详情面板只读展示现有设备状态，不编辑设备、不写入元数据、不执行远程命令。</p>
        </div>
      </section>
```

- [ ] **Step 6: Add CSS in `src/web/styles.css`**

Add this block near the existing device/fleet styles:

```css
.device-detail-panel {
  align-content: start;
}

.device-detail-grid {
  display: grid;
  gap: 8px;
  margin: 0;
}

.device-detail-row {
  display: grid;
  grid-template-columns: minmax(96px, 140px) 1fr;
  gap: 12px;
  align-items: baseline;
  border-bottom: 1px solid #edf0f2;
  padding: 7px 0;
}

.device-detail-row dt {
  color: #6b7280;
  font-size: 0.78rem;
  font-weight: 700;
}

.device-detail-row dd {
  margin: 0;
  color: #111827;
  font-size: 0.86rem;
  overflow-wrap: anywhere;
}

.device-detail-safety-note {
  margin-top: 10px;
  color: #6b7280;
  font-size: 0.78rem;
}
```

- [ ] **Step 7: Run tests to verify Task 1 GREEN**

Run:

```bash
npm test
```

Expected: PASS for README and HTML contract tests. DOM rendering tests for dynamic selection will be added in Task 2.

---

### Task 2: Device Detail Rendering And Fallbacks

**Files:**
- Modify: `src/web/app.js`
- Modify: `test/web-console.test.js`

**Interfaces:**
- Consumes:
  - Existing device objects from `GET /api/devices`
  - Static hooks from Task 1
- Produces:
  - `formatLastBackup(value)` exported from `src/web/app.js`
  - `renderDeviceDetail(device)` helper inside `initConsole`
  - Detail panel updates when a user clicks a device

- [ ] **Step 1: Add failing formatter tests in `test/web-console.test.js`**

Update the import from `../src/web/app.js` to include `formatLastBackup`:

```js
import {
  computeFleetSummary,
  formatLastBackup,
  formatLastHeartbeat,
  formatSnapshotJobName,
  formatSnapshotMeta,
  initConsole,
  parseBackupPreflightExcludePatterns,
  parseNasDryRunConfig,
} from '../src/web/app.js';
```

Add these tests after `describe('formatLastHeartbeat', ...)`:

```js
describe('formatLastBackup', () => {
  it('returns "无备份" for nullish or empty values', () => {
    assert.strictEqual(formatLastBackup(null), '无备份');
    assert.strictEqual(formatLastBackup(undefined), '无备份');
    assert.strictEqual(formatLastBackup(''), '无备份');
  });

  it('returns "无备份" for invalid dates', () => {
    assert.strictEqual(formatLastBackup('not-a-date'), '无备份');
  });

  it('returns a locale string for valid ISO date', () => {
    const result = formatLastBackup('2025-01-15T10:00:00Z');

    assert.ok(result.length > 0);
    assert.notStrictEqual(result, 'Invalid Date');
    assert.notStrictEqual(result, '无备份');
  });
});
```

- [ ] **Step 2: Add failing DOM rendering tests in `test/web-console.test.js`**

Add these tests inside `describe('initConsole DOM data-testid hooks', ...)`:

```js
  it('renders selected device detail fields when a device is clicked', async () => {
    const doc = buildMockDoc();
    const devices = [
      {
        deviceId: 'd1',
        hostname: 'host-one',
        status: 'online',
        ipAddress: '1.2.3.4',
        snapshotCount: 7,
        lastHeartbeatAt: '2025-01-15T10:00:00Z',
        lastBackupAt: '2025-01-15T11:00:00Z',
      },
    ];
    const mockFetch = async (url) => ({
      ok: true,
      status: 200,
      json: async () => (url.includes('/snapshots') ? [] : devices),
    });
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));

    const deviceItem = doc._created.find((el) => el.className && el.className.includes('device-item'));
    assert.ok(deviceItem, 'device-item must exist');
    deviceItem._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    const detailText = doc.getElementById('device-detail-content').textContent;
    assert.match(detailText, /d1/);
    assert.match(detailText, /host-one/);
    assert.match(detailText, /1\.2\.3\.4/);
    assert.match(detailText, /online/);
    assert.match(detailText, /7/);
    assert.doesNotMatch(detailText, /undefined|null|Invalid Date/);
  });

  it('renders device detail fallbacks for missing fields', async () => {
    const doc = buildMockDoc();
    const devices = [
      {
        deviceId: 'd2',
        status: '',
        lastHeartbeatAt: 'not-a-date',
        lastBackupAt: 'also-not-a-date',
      },
    ];
    const mockFetch = async (url) => ({
      ok: true,
      status: 200,
      json: async () => (url.includes('/snapshots') ? [] : devices),
    });
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));

    const deviceItem = doc._created.find((el) => el.className && el.className.includes('device-item'));
    assert.ok(deviceItem, 'device-item must exist');
    deviceItem._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    const detailText = doc.getElementById('device-detail-content').textContent;
    assert.match(detailText, /d2/);
    assert.match(detailText, /unknown/);
    assert.match(detailText, /无心跳/);
    assert.match(detailText, /无备份/);
    assert.match(detailText, /0/);
    assert.doesNotMatch(detailText, /undefined|null|Invalid Date/);
  });

  it('keeps existing device click behavior while rendering details', async () => {
    const doc = buildMockDoc();
    const calls = [];
    const devices = [
      {
        deviceId: 'd3',
        hostname: 'host-three',
        status: 'online',
        ipAddress: '10.0.0.3',
        snapshotCount: 1,
        lastHeartbeatAt: '2025-01-15T10:00:00Z',
      },
    ];
    const mockFetch = async (url) => {
      calls.push(url);
      if (url.includes('/retention-dry-run')) {
        return { ok: true, status: 200, json: async () => ({ keepCount: 1, wouldDeleteCount: 0, snapshots: [] }) };
      }
      return { ok: true, status: 200, json: async () => (url.includes('/snapshots') ? [] : devices) };
    };
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));

    const deviceItem = doc._created.find((el) => el.className && el.className.includes('device-item'));
    assert.ok(deviceItem, 'device-item must exist');
    deviceItem._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(calls.includes('/api/devices/d3/snapshots'), 'click must still fetch snapshots');
    assert.ok(calls.includes('/api/devices/d3/retention-dry-run?keepLast=3'), 'click must still fetch retention dry-run');
    assert.match(doc.getElementById('device-detail-content').textContent, /host-three/);
  });
```

- [ ] **Step 3: Run tests to verify RED**

Run:

```bash
npm test
```

Expected: FAIL because `formatLastBackup` and dynamic device detail rendering are not implemented.

- [ ] **Step 4: Add `formatLastBackup` in `src/web/app.js`**

Replace the current `formatLastHeartbeat` implementation area with:

```js
function formatDateOrFallback(value, fallback) {
  if (!value || !isValidDate(value)) return fallback;
  return new Date(value).toLocaleString();
}

export function formatLastHeartbeat(value) {
  return formatDateOrFallback(value, '无心跳');
}

export function formatLastBackup(value) {
  return formatDateOrFallback(value, '无备份');
}
```

Keep `isValidDate(value)` unchanged.

- [ ] **Step 5: Read detail panel elements in `initConsole`**

In `initConsole(doc, fetchImpl, intervalImpl)`, add this after the existing `deviceListEl` line:

```js
  const deviceDetailContentEl = doc.getElementById('device-detail-content');
```

- [ ] **Step 6: Add local detail rendering helpers in `src/web/app.js`**

Add these helpers inside `initConsole`, before `fetchDevices()`:

```js
  function appendDeviceDetailRow(parent, testId, label, value) {
    const row = doc.createElement('div');
    row.className = 'device-detail-row';

    const term = doc.createElement('dt');
    term.textContent = label;

    const detail = doc.createElement('dd');
    detail.setAttribute('data-testid', testId);
    detail.textContent = value;

    row.appendChild(term);
    row.appendChild(detail);
    parent.appendChild(row);
  }

  function renderDeviceDetail(device) {
    if (!deviceDetailContentEl) return;
    deviceDetailContentEl.innerHTML = '';
    deviceDetailContentEl.textContent = '';

    if (!device) {
      const placeholder = doc.createElement('p');
      placeholder.className = 'placeholder';
      placeholder.setAttribute('data-testid', 'device-detail-placeholder');
      placeholder.textContent = '请选择一个设备';
      deviceDetailContentEl.appendChild(placeholder);
      return;
    }

    const grid = doc.createElement('dl');
    grid.className = 'device-detail-grid';

    appendDeviceDetailRow(grid, 'device-detail-device-id', 'Device ID', device.deviceId || 'unknown');
    appendDeviceDetailRow(grid, 'device-detail-hostname', 'Hostname', device.hostname || 'unknown');
    appendDeviceDetailRow(grid, 'device-detail-ip', 'IP 地址', device.ipAddress || 'unknown');
    appendDeviceDetailRow(grid, 'device-detail-status', '状态', device.status || 'unknown');
    appendDeviceDetailRow(grid, 'device-detail-heartbeat', '最后心跳', formatLastHeartbeat(device.lastHeartbeatAt));
    appendDeviceDetailRow(grid, 'device-detail-backup', '最后备份', formatLastBackup(device.lastBackupAt));
    appendDeviceDetailRow(grid, 'device-detail-snapshots', '快照数', String(device.snapshotCount || 0));

    deviceDetailContentEl.appendChild(grid);
  }
```

- [ ] **Step 7: Wire detail rendering into device loading and selection**

In `fetchDevices()`, after `cachedDevices = devices;`, add:

```js
      const selectedDevice = devices.find((d) => d.deviceId === selectedDeviceId) || null;
      if (!selectedDevice) selectedDeviceId = null;
      renderDeviceDetail(selectedDevice);
```

In the device click handler, after `selectedSnapshotId = null;`, add:

```js
        renderDeviceDetail(device);
```

The click handler should still call:

```js
        renderDevices(devices);
        fetchSnapshots(device.deviceId);
        fetchRetentionPlan(device.deviceId);
```

- [ ] **Step 8: Run tests to verify Task 2 GREEN**

Run:

```bash
npm test
```

Expected: PASS with the new formatter and DOM rendering tests.

---

### Task 3: Final Verification And Handoff

**Files:**
- Read: `README.md`
- Read: `src/web/index.html`
- Read: `src/web/app.js`
- Read: `src/web/styles.css`
- Read: `test/readme.test.js`
- Read: `test/web-console.test.js`
- Optional read-only smoke: local `GET /`

**Interfaces:**
- Consumes: Completed Tasks 1-2.
- Produces: V0.15 validation evidence.

- [ ] **Step 1: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS with zero failures.

- [ ] **Step 2: Run static safety checks**

Run:

```bash
git diff --check
```

Expected: no output.

Run:

```bash
rg -n "device-detail|V0\\.15|formatLastBackup|lastBackupAt|lastHeartbeatAt|snapshotCount" README.md src/web test docs/superpowers
```

Expected: Shows V0.15 docs, HTML hooks, formatter, render logic, and tests.

Run:

```bash
rg -n "api/devices/:deviceId|/api/devices/\\$|POST /api/devices|remote command|远程命令|ping|probe|wake|shutdown|writeFile|writeFileSync" README.md src test docs/superpowers
```

Expected: No new backend device-detail route, no remote action UI, and no new write path for the device detail panel. Existing negative documentation or unrelated test fixture writes must be inspected rather than treated as failures.

- [ ] **Step 3: Optional local HTTP smoke**

Start the local server only if the execution environment allows binding localhost:

```bash
PORT=3005 HOST=127.0.0.1 DATA_DIR=/Users/ah/linke/data node src/server.js
```

Open or fetch:

```bash
curl -s http://127.0.0.1:3005/ | rg "device-detail-panel|device-detail-content|device-detail-placeholder|请选择一个设备"
```

Expected: HTML includes the device detail panel and placeholder.

- [ ] **Step 4: Commit only if authorized**

If the user explicitly authorizes commit:

```bash
git add README.md src/web/index.html src/web/styles.css src/web/app.js test/readme.test.js test/web-console.test.js docs/superpowers/specs/2026-07-04-device-detail-panel-design.md docs/superpowers/plans/2026-07-04-device-detail-panel.md
git commit -m "feat: add v0.15 device detail panel"
```

- [ ] **Step 5: Handoff report**

Report:

- Implementer result.
- Reviewer result.
- Verifier result.
- `npm test` result.
- Static safety scan result.
- Optional HTTP smoke result or why it was skipped.
- Git status.
