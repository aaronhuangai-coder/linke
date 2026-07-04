# Device List Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add read-only device search, status filtering, sorting, and visible-result counts to the Linke Web Console device panel.

**Architecture:** Implement the feature as pure helper functions in `src/web/app.js`, then bind those helpers to a compact toolbar in the existing `devices-panel`. Keep `/api/devices` unchanged and derive the visible list entirely in the browser.

**Tech Stack:** Browser ESM, Node built-in `node:test`, vanilla HTML/CSS/JS, existing Linke HTTP server.

## Global Constraints

- Only modify `src/web/app.js`, `src/web/index.html`, `src/web/styles.css`, `test/web-console.test.js`, `README.md`, and the V0.16 docs.
- Do not add dependencies.
- Do not add API routes.
- Do not call write endpoints from the new controls.
- Do not persist filter state.
- Keep all UI copy Chinese.
- Use TDD: every production behavior must have a failing test before implementation.

---

## File Structure

- `src/web/app.js`: pure filtering/sorting helpers and `initConsole` bindings.
- `src/web/index.html`: static toolbar markup and safety wording inside the existing device panel.
- `src/web/styles.css`: compact toolbar, count, and empty-state styling.
- `test/web-console.test.js`: unit and HTML/source contract tests for V0.16.
- `README.md`: version note and usage summary for V0.16.

### Task 1: Pure Device List Derivation

**Files:**
- Modify: `test/web-console.test.js`
- Modify: `src/web/app.js`

**Interfaces:**
- Produces: `applyDeviceListControls(devices, controls)`.
- Produces: `matchesDeviceSearch(device, query)`.
- Produces: `normalizeDeviceStatus(status)`.
- Produces: `compareDevicesForSort(a, b, sortKey)`.

- [ ] **Step 1: Write failing tests**

Add imports in `test/web-console.test.js`:

```js
import {
  applyDeviceListControls,
  compareDevicesForSort,
  computeFleetSummary,
  formatLastBackup,
  formatLastHeartbeat,
  formatSnapshotJobName,
  formatSnapshotMeta,
  initConsole,
  matchesDeviceSearch,
  normalizeDeviceStatus,
  parseBackupPreflightExcludePatterns,
  parseNasDryRunConfig,
} from '../src/web/app.js';
```

Add tests:

```js
describe('V0.16 device list controls helpers', () => {
  const devices = [
    {
      deviceId: 'mac-alpha',
      hostname: 'Aaron-Mac',
      ipAddress: '10.0.0.20',
      status: 'online',
      lastHeartbeatAt: '2026-07-04T10:00:00.000Z',
      snapshotCount: 2,
    },
    {
      deviceId: 'ipad-beta',
      hostname: 'Design-iPad',
      ipAddress: '10.0.0.5',
      status: 'offline',
      lastHeartbeatAt: '2026-07-04T09:00:00.000Z',
      snapshotCount: 8,
    },
    {
      deviceId: 'phone-gamma',
      hostname: '',
      ipAddress: '192.168.31.9',
      status: '',
      lastHeartbeatAt: '',
      snapshotCount: 0,
    },
  ];

  it('normalizes missing device status to unknown', () => {
    assert.strictEqual(normalizeDeviceStatus('online'), 'online');
    assert.strictEqual(normalizeDeviceStatus('offline'), 'offline');
    assert.strictEqual(normalizeDeviceStatus(''), 'unknown');
    assert.strictEqual(normalizeDeviceStatus(undefined), 'unknown');
  });

  it('matches device search across hostname, device id, and IP address', () => {
    assert.strictEqual(matchesDeviceSearch(devices[0], 'aaron'), true);
    assert.strictEqual(matchesDeviceSearch(devices[1], 'ipad-beta'), true);
    assert.strictEqual(matchesDeviceSearch(devices[2], '192.168'), true);
    assert.strictEqual(matchesDeviceSearch(devices[2], 'missing'), false);
  });

  it('applies search, status filter, and snapshot sort without mutating input', () => {
    const result = applyDeviceListControls(devices, {
      query: '10.0.0',
      status: 'all',
      sort: 'snapshots',
    });

    assert.deepStrictEqual(result.map((device) => device.deviceId), ['ipad-beta', 'mac-alpha']);
    assert.deepStrictEqual(devices.map((device) => device.deviceId), ['mac-alpha', 'ipad-beta', 'phone-gamma']);
  });

  it('filters offline and unknown statuses separately', () => {
    const offline = applyDeviceListControls(devices, { query: '', status: 'offline', sort: 'name' });
    const unknown = applyDeviceListControls(devices, { query: '', status: 'unknown', sort: 'name' });

    assert.deepStrictEqual(offline.map((device) => device.deviceId), ['ipad-beta']);
    assert.deepStrictEqual(unknown.map((device) => device.deviceId), ['phone-gamma']);
  });

  it('sorts devices by latest heartbeat first', () => {
    const result = applyDeviceListControls(devices, { query: '', status: 'all', sort: 'heartbeat' });

    assert.deepStrictEqual(result.map((device) => device.deviceId), ['mac-alpha', 'ipad-beta', 'phone-gamma']);
  });

  it('falls back to name sort for unsupported sort keys', () => {
    const result = [...devices].sort((a, b) => compareDevicesForSort(a, b, 'unsupported'));

    assert.deepStrictEqual(result.map((device) => device.deviceId), ['mac-alpha', 'ipad-beta', 'phone-gamma']);
  });
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- test/web-console.test.js
```

Expected: fail because `applyDeviceListControls`, `matchesDeviceSearch`, `normalizeDeviceStatus`, and `compareDevicesForSort` are not exported.

- [ ] **Step 3: Implement helpers**

Add to `src/web/app.js` near the existing pure functions:

```js
export function normalizeDeviceStatus(status) {
  if (status === 'online' || status === 'offline') return status;
  return 'unknown';
}

function normalizeSearchValue(value) {
  return String(value || '').trim().toLowerCase();
}

export function matchesDeviceSearch(device, query) {
  const normalizedQuery = normalizeSearchValue(query);
  if (!normalizedQuery) return true;
  return [
    device?.hostname,
    device?.deviceId,
    device?.ipAddress,
  ].some((value) => normalizeSearchValue(value).includes(normalizedQuery));
}

function getDeviceName(device) {
  return String(device?.hostname || device?.deviceId || '').toLowerCase();
}

function getDeviceIp(device) {
  return String(device?.ipAddress || '').toLowerCase();
}

function getDeviceHeartbeatTime(device) {
  const value = Date.parse(device?.lastHeartbeatAt || '');
  return Number.isFinite(value) ? value : 0;
}

export function compareDevicesForSort(a, b, sortKey) {
  if (sortKey === 'ip') {
    return getDeviceIp(a).localeCompare(getDeviceIp(b)) || getDeviceName(a).localeCompare(getDeviceName(b));
  }
  if (sortKey === 'heartbeat') {
    return getDeviceHeartbeatTime(b) - getDeviceHeartbeatTime(a) || getDeviceName(a).localeCompare(getDeviceName(b));
  }
  if (sortKey === 'snapshots') {
    return (b?.snapshotCount || 0) - (a?.snapshotCount || 0) || getDeviceName(a).localeCompare(getDeviceName(b));
  }
  return getDeviceName(a).localeCompare(getDeviceName(b));
}

export function applyDeviceListControls(devices, controls) {
  const status = controls?.status || 'all';
  const sort = controls?.sort || 'name';
  return [...devices]
    .filter((device) => matchesDeviceSearch(device, controls?.query || ''))
    .filter((device) => status === 'all' || normalizeDeviceStatus(device?.status) === status)
    .sort((a, b) => compareDevicesForSort(a, b, sort));
}
```

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm test -- test/web-console.test.js
```

Expected: tests pass.

### Task 2: Toolbar DOM, Rendering, And Docs

**Files:**
- Modify: `test/web-console.test.js`
- Modify: `src/web/index.html`
- Modify: `src/web/app.js`
- Modify: `src/web/styles.css`
- Modify: `README.md`

**Interfaces:**
- Consumes: `applyDeviceListControls(devices, controls)`.
- Produces DOM hooks: `device-search`, `device-status-filter`, `device-sort`, `device-filter-count`.

- [ ] **Step 1: Write failing contract tests**

Add tests:

```js
it('HTML contains V0.16 device list controls hooks', async () => {
  const res = await fetch(`http://localhost:${port}/`);
  const html = await res.text();

  assert.ok(html.includes('data-testid="device-search"'), 'must have device-search input');
  assert.ok(html.includes('data-testid="device-status-filter"'), 'must have device-status-filter select');
  assert.ok(html.includes('data-testid="device-sort"'), 'must have device-sort select');
  assert.ok(html.includes('data-testid="device-filter-count"'), 'must have device-filter-count');
});

it('device controls are read-only and do not expose execution wording', async () => {
  const res = await fetch(`http://localhost:${port}/`);
  const html = await res.text();
  const panelMatch = html.match(/<section class="panel devices-panel"[\s\S]*?<\/section>/);

  assert.ok(panelMatch, 'devices-panel section must exist');
  assert.ok(/搜索|筛选|排序/.test(panelMatch[0]), 'controls must communicate search/filter/sort behavior');
  assert.ok(!/执行备份|创建备份|删除快照|连接 NAS|远程传输/i.test(panelMatch[0]), 'controls must not expose real execution wording');
});

it('app.js wires V0.16 controls into device rendering', async () => {
  const res = await fetch(`http://localhost:${port}/app.js`);
  const js = await res.text();

  assert.ok(js.includes('device-search'), 'app.js must reference device-search');
  assert.ok(js.includes('device-status-filter'), 'app.js must reference device-status-filter');
  assert.ok(js.includes('device-sort'), 'app.js must reference device-sort');
  assert.ok(js.includes('applyDeviceListControls'), 'app.js must use applyDeviceListControls');
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- test/web-console.test.js
```

Expected: fail because the HTML and runtime wiring are missing.

- [ ] **Step 3: Implement HTML toolbar**

In `src/web/index.html`, replace the devices panel heading area with:

```html
<section class="panel devices-panel">
  <div class="panel-title-row">
    <h2>设备</h2>
    <span class="device-filter-count" data-testid="device-filter-count">0 / 0</span>
  </div>
  <div class="device-controls" data-testid="device-controls">
    <label for="device-search">搜索</label>
    <input id="device-search" data-testid="device-search" type="search" placeholder="名称 / ID / IP">
    <label for="device-status-filter">状态</label>
    <select id="device-status-filter" data-testid="device-status-filter">
      <option value="all">全部</option>
      <option value="online">在线</option>
      <option value="offline">离线</option>
      <option value="unknown">未知</option>
    </select>
    <label for="device-sort">排序</label>
    <select id="device-sort" data-testid="device-sort">
      <option value="name">名称</option>
      <option value="ip">IP</option>
      <option value="heartbeat">最后心跳</option>
      <option value="snapshots">快照数</option>
    </select>
  </div>
  <ul data-testid="device-list" id="device-list"></ul>
</section>
```

- [ ] **Step 4: Implement runtime wiring**

In `src/web/app.js`, add DOM refs inside `initConsole`:

```js
const deviceSearchInput = doc.getElementById('device-search');
const deviceStatusFilter = doc.getElementById('device-status-filter');
const deviceSortSelect = doc.getElementById('device-sort');
const deviceFilterCountEl = doc.querySelector('[data-testid="device-filter-count"]');
```

Add helpers inside `initConsole`:

```js
function getDeviceControls() {
  return {
    query: deviceSearchInput?.value || '',
    status: deviceStatusFilter?.value || 'all',
    sort: deviceSortSelect?.value || 'name',
  };
}

function renderFilteredDevices() {
  const visibleDevices = applyDeviceListControls(cachedDevices, getDeviceControls());
  renderDeviceFilterCount(visibleDevices.length, cachedDevices.length);
  renderDevices(visibleDevices);
}

function renderDeviceFilterCount(visibleCount, totalCount) {
  if (deviceFilterCountEl) {
    deviceFilterCountEl.textContent = String(visibleCount) + ' / ' + String(totalCount);
  }
}
```

Change `fetchDevices()` to call `renderFilteredDevices()` instead of `renderDevices(devices)`.

Change the empty list copy in `renderDevices(devices)` to:

```js
deviceListEl.innerHTML = '<li class="placeholder">无匹配设备</li>';
```

Add event bindings before the first `fetchDevices()` call:

```js
for (const control of [deviceSearchInput, deviceStatusFilter, deviceSortSelect]) {
  if (control) {
    control.addEventListener('input', renderFilteredDevices);
    control.addEventListener('change', renderFilteredDevices);
  }
}
```

- [ ] **Step 5: Add CSS**

Add compact styles to `src/web/styles.css`:

```css
.panel-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid #eee;
  margin-bottom: 12px;
}

.panel-title-row h2 {
  border-bottom: 0;
  margin-bottom: 0;
}

.device-filter-count {
  color: #6b7280;
  font-size: 0.78rem;
  font-weight: 600;
}

.device-controls {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 6px 8px;
  align-items: center;
  margin-bottom: 12px;
  color: #555;
  font-size: 0.78rem;
}

.device-controls input,
.device-controls select {
  min-width: 0;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  padding: 6px 8px;
  background: #fff;
  color: #111827;
  font-size: 0.8rem;
}
```

- [ ] **Step 6: Update README**

Add V0.16 to the feature list and roadmap:

```md
### V0.16 多设备列表控制

- Web Console 设备面板支持按名称 / Device ID / IP 搜索。
- 支持按全部 / 在线 / 离线 / 未知状态过滤。
- 支持按名称、IP、最后心跳、快照数排序。
- 仅前端只读派生视图，不新增写接口、不触发备份、不连接 NAS。
```

- [ ] **Step 7: Verify GREEN**

Run:

```bash
npm test -- test/web-console.test.js
npm test
git diff --check
```

Expected: all commands pass.

## Self-Review

- Spec coverage: the tasks cover search, status filtering, sorting, count display, read-only boundary, and docs.
- Placeholder scan: no unfinished placeholder markers are present.
- Type consistency: helper names in tests and implementation steps match exactly.
