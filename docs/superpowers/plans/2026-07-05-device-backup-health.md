# Device Backup Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a V0.21 read-only Device Backup Health panel to the Linke Web Console.

**Architecture:** Keep the feature entirely in the existing static Web Console. Add pure health-classification helpers to `src/web/app.js`, add a read-only panel to `src/web/index.html`, render derived health data after `/api/devices` loads, style compact health items in `src/web/styles.css`, and update tests plus README. No backend route, metadata write, NAS call, backup execution, restore execution, delete, sync, or remote transfer is allowed.

**Tech Stack:** Node.js ESM, built-in `node:test`, static HTML/CSS/JS, no runtime dependencies.

## Global Constraints

- Current version becomes `V0.21`.
- The Device Backup Health panel is a front-end-only derived read-only view.
- Health data is derived only from the existing `/api/devices` response.
- Do not add backend API routes.
- Do not call `POST /api/backups`, `POST /api/restore`, or `POST /api/nas-dry-run`.
- Do not persist health data or write metadata.
- Do not connect to NAS, invoke NAS apps, sync devices, delete snapshots, restore files, or transfer remote files.
- Render device text with `createElement` and `textContent`, not `innerHTML`.
- `buildDeviceBackupHealth()` must accept non-array input and return an empty summary/list.
- Future `lastBackupAt` values are not healthy; classify them as `attention`.
- Do not read or output secrets.
- Do not commit or push; Codex PM owns final verification and human gate.

---

## File Structure

- Modify `src/web/app.js`: add `getDeviceBackupHealthStatus()` and `buildDeviceBackupHealth()`, render health panel from `fetchDevices()`, and wire health-item clicks into the existing device selection path.
- Modify `src/web/index.html`: add the V0.21 Device Backup Health panel with stable `data-testid` hooks and read-only safety copy.
- Modify `src/web/styles.css`: add compact health summary/list styles and long-text overflow handling.
- Modify `test/web-console.test.js`: add pure-function, HTML contract, DOM rendering, click-through, repeated-refresh, and text-only safety tests.
- Modify `README.md`: bump to V0.21 and document the new read-only health panel.
- Modify `test/readme.test.js`: assert V0.21 documentation and safety boundary.

## Worker Routing

- Implementer: AGY must be called with an explicit model. Recommended: `agy --print "<prompt>" --model "Gemini 3.5 Flash (Low)" --sandbox --print-timeout 180s`.
- AGY may modify only files listed in the current task.
- AGY must write a task report under `.superpowers/sdd/v021-task-N-*.md`.
- If AGY returns no schema, no report, or `authentication failed or timed out`, stop and return to Codex PM.
- Codex PM independently verifies every task by reading diff and running task tests.

---

## Task 1: Health Classification Pure Functions

**Files:**
- Modify: `src/web/app.js`
- Test: `test/web-console.test.js`

**Interfaces:**
- Consumes: existing date parsing style in `formatLastBackup()` / `formatLastHeartbeat()`.
- Produces: `getDeviceBackupHealthStatus(device, now = new Date())`.
- Produces: `buildDeviceBackupHealth(devices, now = new Date())`.
- `buildDeviceBackupHealth()` returns:

```js
{
  summary: {
    healthy: 0,
    attention: 0,
    offline: 0,
    unknown: 0,
    total: 0,
  },
  items: [],
}
```

- Each item has:

```js
{
  deviceId,
  hostname,
  ipAddress,
  status,
  healthStatus,
  healthLabel,
  healthReason,
  snapshotCount,
  lastHeartbeatAt,
  lastBackupAt,
}
```

- [ ] **Step 1: Add imports for new helpers**

In `test/web-console.test.js`, extend the import from `../src/web/app.js`:

```js
import {
  applyDeviceListControls,
  buildBackupJobOverview,
  buildBackupJobTimeline,
  buildDeviceBackupHealth,
  compareDevicesForSort,
  computeFleetSummary,
  formatLastBackup,
  formatLastHeartbeat,
  formatSnapshotJobName,
  formatSnapshotMeta,
  getDeviceBackupHealthStatus,
  initConsole,
  matchesDeviceSearch,
  normalizeDeviceStatus,
  parseBackupPreflightExcludePatterns,
  parseNasDryRunConfig,
} from '../src/web/app.js';
```

- [ ] **Step 2: Write failing pure-function tests**

Append this block near the other pure-function tests in `test/web-console.test.js`:

```js
describe('V0.21 device backup health pure functions', () => {
  const now = new Date('2026-07-05T12:00:00.000Z');

  it('classifies online devices with valid backups as healthy', () => {
    const status = getDeviceBackupHealthStatus({
      deviceId: 'healthy-mac',
      status: 'online',
      snapshotCount: 2,
      lastBackupAt: '2026-07-05T11:00:00.000Z',
    }, now);

    assert.strictEqual(status, 'healthy');
  });

  it('classifies online devices without valid backup records as attention', () => {
    assert.strictEqual(getDeviceBackupHealthStatus({
      deviceId: 'no-snapshots',
      status: 'online',
      snapshotCount: 0,
      lastBackupAt: '2026-07-05T11:00:00.000Z',
    }, now), 'attention');

    assert.strictEqual(getDeviceBackupHealthStatus({
      deviceId: 'missing-backup',
      status: 'online',
      snapshotCount: 1,
      lastBackupAt: '',
    }, now), 'attention');

    assert.strictEqual(getDeviceBackupHealthStatus({
      deviceId: 'future-backup',
      status: 'online',
      snapshotCount: 1,
      lastBackupAt: '2026-07-06T00:00:00.000Z',
    }, now), 'attention');
  });

  it('classifies offline and unknown devices separately', () => {
    assert.strictEqual(getDeviceBackupHealthStatus({
      deviceId: 'offline-mac',
      status: 'offline',
      snapshotCount: 5,
      lastBackupAt: '2026-07-05T10:00:00.000Z',
    }, now), 'offline');

    assert.strictEqual(getDeviceBackupHealthStatus({
      deviceId: 'weird-mac',
      status: 'sleeping',
      snapshotCount: 5,
      lastBackupAt: '2026-07-05T10:00:00.000Z',
    }, now), 'unknown');
  });

  it('builds summary counts, stable labels, reasons, fallbacks, and sort order', () => {
    const result = buildDeviceBackupHealth([
      {
        deviceId: 'healthy-device',
        hostname: 'Zulu',
        ipAddress: '10.0.0.4',
        status: 'online',
        snapshotCount: 4,
        lastHeartbeatAt: '2026-07-05T11:55:00.000Z',
        lastBackupAt: '2026-07-05T11:30:00.000Z',
      },
      {
        deviceId: 'needs-attention',
        hostname: 'Alpha',
        ipAddress: '10.0.0.1',
        status: 'online',
        snapshotCount: 0,
        lastHeartbeatAt: '2026-07-05T11:50:00.000Z',
        lastBackupAt: '',
      },
      {
        deviceId: 'offline-device',
        hostname: 'Beta',
        ipAddress: '10.0.0.2',
        status: 'offline',
        snapshotCount: 3,
        lastHeartbeatAt: '2026-07-05T09:00:00.000Z',
        lastBackupAt: '2026-07-05T08:00:00.000Z',
      },
      {
        deviceId: 'unknown-device',
        hostname: '',
        ipAddress: '',
        status: 'sleeping',
        snapshotCount: -2,
        lastHeartbeatAt: 'invalid',
        lastBackupAt: 'invalid',
      },
    ], now);

    assert.deepStrictEqual(result.summary, {
      healthy: 1,
      attention: 1,
      offline: 1,
      unknown: 1,
      total: 4,
    });

    assert.deepStrictEqual(result.items.map((item) => item.healthStatus), [
      'attention',
      'offline',
      'unknown',
      'healthy',
    ]);
    assert.strictEqual(result.items[0].healthLabel, '需关注');
    assert.strictEqual(result.items[0].healthReason, '缺少有效备份');
    assert.strictEqual(result.items[2].hostname, 'unknown');
    assert.strictEqual(result.items[2].ipAddress, 'unknown');
    assert.strictEqual(result.items[2].snapshotCount, 0);
  });

  it('treats non-array input as an empty health result', () => {
    assert.deepStrictEqual(buildDeviceBackupHealth(null, now), {
      summary: {
        healthy: 0,
        attention: 0,
        offline: 0,
        unknown: 0,
        total: 0,
      },
      items: [],
    });

    assert.deepStrictEqual(buildDeviceBackupHealth({ bad: true }, now).items, []);
  });
});
```

- [ ] **Step 3: Run RED tests**

Run:

```bash
node --test test/web-console.test.js
```

Expected: fails because `buildDeviceBackupHealth` and `getDeviceBackupHealthStatus` are not exported.

- [ ] **Step 4: Implement minimal pure functions**

Add these helpers near the existing pure functions in `src/web/app.js`:

```js
const DEVICE_HEALTH_LABELS = {
  healthy: '健康',
  attention: '需关注',
  offline: '离线',
  unknown: '未知',
};

const DEVICE_HEALTH_REASONS = {
  healthy: '最近备份有效',
  attention: '缺少有效备份',
  offline: '设备离线',
  unknown: '状态未知',
};

const DEVICE_HEALTH_SORT_ORDER = {
  attention: 0,
  offline: 1,
  unknown: 2,
  healthy: 3,
};

function getValidDateTime(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizeDeviceText(value) {
  const text = String(value || '').trim();
  return text || 'unknown';
}

function normalizeSnapshotCount(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function getDeviceDisplayName(device) {
  return normalizeDeviceText(device?.hostname || device?.deviceId);
}

export function getDeviceBackupHealthStatus(device, now = new Date()) {
  const status = device?.status;
  if (status === 'offline') return 'offline';
  if (status !== 'online') return 'unknown';

  const snapshotCount = normalizeSnapshotCount(device?.snapshotCount);
  const backupTime = getValidDateTime(device?.lastBackupAt);
  const nowTime = now instanceof Date ? now.getTime() : Date.parse(now);

  if (snapshotCount > 0 && backupTime > 0 && backupTime <= nowTime) {
    return 'healthy';
  }
  return 'attention';
}

export function buildDeviceBackupHealth(devices, now = new Date()) {
  const summary = {
    healthy: 0,
    attention: 0,
    offline: 0,
    unknown: 0,
    total: 0,
  };

  const safeDevices = Array.isArray(devices) ? devices : [];
  const items = safeDevices.map((device) => {
    const healthStatus = getDeviceBackupHealthStatus(device, now);
    summary[healthStatus] += 1;
    summary.total += 1;

    return {
      deviceId: normalizeDeviceText(device?.deviceId),
      hostname: getDeviceDisplayName(device),
      ipAddress: normalizeDeviceText(device?.ipAddress),
      status: normalizeDeviceStatus(device?.status),
      healthStatus,
      healthLabel: DEVICE_HEALTH_LABELS[healthStatus],
      healthReason: DEVICE_HEALTH_REASONS[healthStatus],
      snapshotCount: normalizeSnapshotCount(device?.snapshotCount),
      lastHeartbeatAt: device?.lastHeartbeatAt || '',
      lastBackupAt: device?.lastBackupAt || '',
    };
  }).sort((a, b) => (
    DEVICE_HEALTH_SORT_ORDER[a.healthStatus] - DEVICE_HEALTH_SORT_ORDER[b.healthStatus]
    || a.hostname.localeCompare(b.hostname)
    || a.deviceId.localeCompare(b.deviceId)
  ));

  return { summary, items };
}
```

- [ ] **Step 5: Run GREEN tests**

Run:

```bash
node --test test/web-console.test.js
```

Expected: all `web-console.test.js` tests pass.

---

## Task 2: Health Panel HTML, Rendering, Styles, And Click Wiring

**Files:**
- Modify: `src/web/index.html`
- Modify: `src/web/app.js`
- Modify: `src/web/styles.css`
- Test: `test/web-console.test.js`

**Interfaces:**
- Consumes: `buildDeviceBackupHealth(devices, now)`.
- Produces: `data-testid="device-health-panel"` section.
- Produces: dynamic `data-testid="device-health-item"` rows with `data-health-status`.
- Reuses existing device selection behavior: select device, clear selected snapshot/job state, render detail, render filtered devices, call `fetchSnapshots(deviceId)`, and call `fetchRetentionPlan(deviceId)`.

- [ ] **Step 1: Write failing HTML contract tests**

Append these tests after the V0.20 Event Log panel HTML tests in `test/web-console.test.js`:

```js
// ── V0.21 Device Backup Health panel HTML contract ────────────────

it('HTML contains V0.21 device backup health panel with required data-testid hooks', async () => {
  const res = await fetch(`http://localhost:${port}/`);
  const html = await res.text();

  assert.ok(html.includes('data-testid="device-health-panel"'), 'must have device-health-panel');
  assert.ok(html.includes('data-testid="device-health-healthy-count"'), 'must have device-health-healthy-count');
  assert.ok(html.includes('data-testid="device-health-attention-count"'), 'must have device-health-attention-count');
  assert.ok(html.includes('data-testid="device-health-offline-count"'), 'must have device-health-offline-count');
  assert.ok(html.includes('data-testid="device-health-unknown-count"'), 'must have device-health-unknown-count');
  assert.ok(html.includes('data-testid="device-health-list"'), 'must have device-health-list');
  assert.ok(html.includes('data-testid="device-health-safety-note"'), 'must have device-health-safety-note');
});

it('V0.21 device backup health panel is read-only and has no execution controls', async () => {
  const res = await fetch(`http://localhost:${port}/`);
  const html = await res.text();
  const panelMatch = html.match(/data-testid="device-health-panel"[\s\S]*?<\/section>/);

  assert.ok(panelMatch, 'device-health-panel section must exist');
  const content = panelMatch[0];
  assert.ok(!content.includes('<button'), 'health panel must not contain buttons');
  assert.ok(/只读|派生视图/.test(content), 'must state read-only derived behavior');
  assert.ok(/不写入 metadata/.test(content), 'must state no metadata writes');
  assert.ok(/不触发备份/.test(content), 'must state no backup execution');
  assert.ok(/不执行恢复/.test(content), 'must state no restore execution');
  assert.ok(/不连接 NAS/.test(content), 'must state no NAS connection');
});
```

- [ ] **Step 2: Write failing DOM rendering and click tests**

Append these tests near the V0.20 Event Log Panel unit tests in `test/web-console.test.js`:

```js
describe('V0.21 Device Backup Health Panel unit tests', () => {
  it('initConsole() renders health summary and health items after devices load', async () => {
    const doc = buildMockDoc();
    const devices = [
      {
        deviceId: 'attention-device',
        hostname: 'Attention',
        ipAddress: '10.0.0.2',
        status: 'online',
        snapshotCount: 0,
        lastHeartbeatAt: '2026-07-05T11:00:00.000Z',
        lastBackupAt: '',
      },
      {
        deviceId: 'healthy-device',
        hostname: 'Healthy',
        ipAddress: '10.0.0.1',
        status: 'online',
        snapshotCount: 2,
        lastHeartbeatAt: '2026-07-05T11:00:00.000Z',
        lastBackupAt: '2026-07-05T10:00:00.000Z',
      },
    ];
    const mockFetch = async (url) => {
      if (url.includes('/retention-dry-run')) {
        return { ok: true, status: 200, json: async () => ({ keepCount: 0, wouldDeleteCount: 0, snapshots: [] }) };
      }
      return { ok: true, status: 200, json: async () => (url.includes('/snapshots') ? [] : devices) };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(doc.querySelector('[data-testid="device-health-healthy-count"]').textContent, '1');
    assert.strictEqual(doc.querySelector('[data-testid="device-health-attention-count"]').textContent, '1');
    assert.strictEqual(doc.querySelector('[data-testid="device-health-offline-count"]').textContent, '0');
    assert.strictEqual(doc.querySelector('[data-testid="device-health-unknown-count"]').textContent, '0');

    const items = doc._created.filter((el) => el._attrs?.['data-testid'] === 'device-health-item');
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].dataset.healthStatus, 'attention');
    assert.strictEqual(items[0].querySelector('[data-testid="device-health-reason"]').textContent, '缺少有效备份');
    assert.strictEqual(items[1].dataset.healthStatus, 'healthy');
  });

  it('clicking a health item reuses the existing device selection load path', async () => {
    const doc = buildMockDoc();
    const calls = [];
    const devices = [{
      deviceId: 'health-click-device',
      hostname: 'ClickDevice',
      ipAddress: '10.0.0.8',
      status: 'online',
      snapshotCount: 1,
      lastHeartbeatAt: '2026-07-05T11:00:00.000Z',
      lastBackupAt: '2026-07-05T10:00:00.000Z',
    }];
    const mockFetch = async (url) => {
      calls.push(url);
      if (url.includes('/retention-dry-run')) {
        return { ok: true, status: 200, json: async () => ({ keepCount: 0, wouldDeleteCount: 0, snapshots: [] }) };
      }
      if (url.includes('/snapshots')) {
        return { ok: true, status: 200, json: async () => [] };
      }
      return { ok: true, status: 200, json: async () => devices };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 20));

    const item = doc._created.find((el) => el._attrs?.['data-testid'] === 'device-health-item');
    assert.ok(item, 'device-health-item must be rendered');
    item._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(calls.some((url) => url.includes('/api/devices/health-click-device/snapshots')));
    assert.ok(calls.some((url) => url.includes('/api/devices/health-click-device/retention-dry-run')));
    assert.strictEqual(doc.querySelector('[data-testid="device-detail-device-id"]').textContent, 'health-click-device');
  });

  it('second device load replaces health counts instead of accumulating old results', async () => {
    const doc = buildMockDoc();
    const intervalCallbacks = [];
    let callCount = 0;
    const mockFetch = async (url) => {
      if (url.includes('/snapshots') || url.includes('/retention-dry-run')) {
        return { ok: true, status: 200, json: async () => (url.includes('retention') ? { keepCount: 0, wouldDeleteCount: 0, snapshots: [] } : []) };
      }
      callCount += 1;
      if (callCount === 1) {
        return { ok: true, status: 200, json: async () => ([{
          deviceId: 'first',
          status: 'online',
          snapshotCount: 1,
          lastBackupAt: '2026-07-05T10:00:00.000Z',
        }]) };
      }
      return { ok: true, status: 200, json: async () => ([{
        deviceId: 'second',
        status: 'offline',
        snapshotCount: 0,
        lastBackupAt: '',
      }]) };
    };

    initConsole(doc, mockFetch, (fn) => {
      intervalCallbacks.push(fn);
      return 0;
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(doc.querySelector('[data-testid="device-health-healthy-count"]').textContent, '1');

    await intervalCallbacks[0]();
    assert.strictEqual(doc.querySelector('[data-testid="device-health-healthy-count"]').textContent, '0');
    assert.strictEqual(doc.querySelector('[data-testid="device-health-offline-count"]').textContent, '1');
  });

  it('renders device health text as textContent without innerHTML injection', async () => {
    const doc = buildMockDoc();
    const devices = [{
      deviceId: '<script>alert(1)</script>',
      hostname: '<b>Injected</b>',
      ipAddress: '10.0.0.9',
      status: 'online',
      snapshotCount: 0,
      lastHeartbeatAt: '',
      lastBackupAt: '',
    }];
    const mockFetch = async (url) => ({ ok: true, status: 200, json: async () => (url.includes('/snapshots') ? [] : devices) });

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 20));

    const item = doc._created.find((el) => el._attrs?.['data-testid'] === 'device-health-item');
    assert.ok(item, 'device-health-item must be rendered');
    assert.strictEqual(item.innerHTML || '', '');
    assert.strictEqual(item.querySelector('[data-testid="device-health-name"]').textContent, '<b>Injected</b>');
    assert.strictEqual(item.querySelector('[data-testid="device-health-device-id"]').textContent, '<script>alert(1)</script>');
  });
});
```

- [ ] **Step 3: Run RED tests**

Run:

```bash
node --test test/web-console.test.js
```

Expected: fails because HTML hooks and DOM rendering do not exist yet.

- [ ] **Step 4: Add HTML panel**

In `src/web/index.html`, insert this section after `device-detail-panel` and before `snapshots-panel`:

```html
<section class="panel device-health-panel" data-testid="device-health-panel">
  <h2>设备备份健康</h2>
  <div class="device-health-summary">
    <div class="device-health-stat health-healthy">
      <span id="device-health-healthy-count" data-testid="device-health-healthy-count">0</span>
      <span>健康</span>
    </div>
    <div class="device-health-stat health-attention">
      <span id="device-health-attention-count" data-testid="device-health-attention-count">0</span>
      <span>需关注</span>
    </div>
    <div class="device-health-stat health-offline">
      <span id="device-health-offline-count" data-testid="device-health-offline-count">0</span>
      <span>离线</span>
    </div>
    <div class="device-health-stat health-unknown">
      <span id="device-health-unknown-count" data-testid="device-health-unknown-count">0</span>
      <span>未知</span>
    </div>
  </div>
  <ul id="device-health-list" class="device-health-list" data-testid="device-health-list">
    <li class="placeholder">暂无设备健康数据</li>
  </ul>
  <div class="device-health-safety-note" data-testid="device-health-safety-note">
    <p>设备备份健康面板为前端只读派生视图，只读取现有设备状态，不写入 metadata、不触发备份、不执行恢复、不连接 NAS。</p>
  </div>
</section>
```

- [ ] **Step 5: Wire DOM elements and rendering in `app.js`**

Inside `initConsole()` in `src/web/app.js`, add element lookups near other device elements:

```js
const deviceHealthHealthyCountEl = doc.getElementById('device-health-healthy-count');
const deviceHealthAttentionCountEl = doc.getElementById('device-health-attention-count');
const deviceHealthOfflineCountEl = doc.getElementById('device-health-offline-count');
const deviceHealthUnknownCountEl = doc.getElementById('device-health-unknown-count');
const deviceHealthListEl = doc.getElementById('device-health-list');
```

Add reusable selection helper near `renderDevices()`:

```js
function selectDevice(device) {
  selectedDeviceId = device.deviceId;
  selectedSnapshotId = null;
  selectedBackupJobKey = null;
  cachedSnapshots = [];
  setBackupJobDetailPlaceholder('加载中…', device.deviceId);
  renderDeviceDetail(device);
  renderFilteredDevices();
  fetchSnapshots(device.deviceId);
  fetchRetentionPlan(device.deviceId);
}
```

Replace the body of the existing device item click listener with:

```js
selectDevice(device);
```

Add health rendering helpers:

```js
function setDeviceHealthCounts(summary) {
  if (deviceHealthHealthyCountEl) deviceHealthHealthyCountEl.textContent = String(summary.healthy);
  if (deviceHealthAttentionCountEl) deviceHealthAttentionCountEl.textContent = String(summary.attention);
  if (deviceHealthOfflineCountEl) deviceHealthOfflineCountEl.textContent = String(summary.offline);
  if (deviceHealthUnknownCountEl) deviceHealthUnknownCountEl.textContent = String(summary.unknown);
}

function appendDeviceHealthField(parent, testId, value) {
  const field = doc.createElement('span');
  field.setAttribute('data-testid', testId);
  field.textContent = value;
  parent.appendChild(field);
  return field;
}

function renderDeviceBackupHealth(devices) {
  const health = buildDeviceBackupHealth(devices);
  setDeviceHealthCounts(health.summary);
  clearElement(deviceHealthListEl);
  if (!deviceHealthListEl) return;

  if (health.items.length === 0) {
    const item = doc.createElement('li');
    item.className = 'placeholder';
    item.textContent = '暂无设备健康数据';
    deviceHealthListEl.appendChild(item);
    return;
  }

  health.items.forEach(function (item) {
    const row = doc.createElement('li');
    row.className = 'device-health-item device-health-' + item.healthStatus
      + (item.deviceId === selectedDeviceId ? ' selected' : '');
    row.setAttribute('data-testid', 'device-health-item');
    row.setAttribute('data-device-id', item.deviceId);
    row.setAttribute('data-health-status', item.healthStatus);
    row.dataset.deviceId = item.deviceId;

    const sourceDevice = cachedDevices.find((device) => device.deviceId === item.deviceId) || {
      deviceId: item.deviceId,
      hostname: item.hostname,
      ipAddress: item.ipAddress,
      status: item.status,
      snapshotCount: item.snapshotCount,
      lastHeartbeatAt: item.lastHeartbeatAt,
      lastBackupAt: item.lastBackupAt,
    };

    row.addEventListener('click', function () {
      selectDevice(sourceDevice);
    });

    appendDeviceHealthField(row, 'device-health-name', item.hostname);
    appendDeviceHealthField(row, 'device-health-device-id', item.deviceId);
    appendDeviceHealthField(row, 'device-health-ip', item.ipAddress);
    appendDeviceHealthField(row, 'device-health-status', item.healthLabel);
    appendDeviceHealthField(row, 'device-health-reason', item.healthReason);
    appendDeviceHealthField(row, 'device-health-snapshots', String(item.snapshotCount) + ' 快照');
    appendDeviceHealthField(row, 'device-health-heartbeat', formatLastHeartbeat(item.lastHeartbeatAt));
    appendDeviceHealthField(row, 'device-health-backup', formatLastBackup(item.lastBackupAt));

    deviceHealthListEl.appendChild(row);
  });
}
```

In `fetchDevices()` success path, after `renderDeviceDetail(selectedDevice);`, add:

```js
renderDeviceBackupHealth(devices);
```

In the `fetchDevices()` catch path, add:

```js
renderDeviceBackupHealth([]);
```

- [ ] **Step 6: Add CSS styles**

Append to `src/web/styles.css`:

```css
.device-health-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 12px;
}

.device-health-stat {
  border: 1px solid #d8dee9;
  border-radius: 6px;
  padding: 8px;
  background: #f8fafc;
}

.device-health-stat span:first-child {
  display: block;
  font-size: 1.25rem;
  font-weight: 700;
}

.device-health-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}

.device-health-item {
  display: grid;
  grid-template-columns: minmax(120px, 1.2fr) minmax(100px, 1fr) minmax(90px, 0.8fr) minmax(90px, 0.8fr);
  gap: 6px 10px;
  border: 1px solid #d8dee9;
  border-left: 4px solid #94a3b8;
  border-radius: 6px;
  padding: 10px;
  cursor: pointer;
  background: #ffffff;
}

.device-health-item:hover,
.device-health-item.selected {
  border-color: #2563eb;
}

.device-health-healthy {
  border-left-color: #16a34a;
}

.device-health-attention {
  border-left-color: #d97706;
}

.device-health-offline {
  border-left-color: #64748b;
}

.device-health-unknown {
  border-left-color: #7c3aed;
}

.device-health-item span {
  min-width: 0;
  overflow-wrap: anywhere;
}

[data-testid="device-health-name"] {
  font-weight: 700;
}

[data-testid="device-health-status"] {
  font-weight: 700;
}

@media (max-width: 760px) {
  .device-health-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .device-health-item {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 7: Run GREEN tests**

Run:

```bash
node --test test/web-console.test.js
```

Expected: all `web-console.test.js` tests pass.

---

## Task 3: README V0.21 Documentation And Safety Tests

**Files:**
- Modify: `README.md`
- Test: `test/readme.test.js`

**Interfaces:**
- Consumes: V0.21 behavior from Task 1 and Task 2.
- Produces: README current version `V0.21`.
- Produces: README safety documentation for the Device Backup Health panel.

- [ ] **Step 1: Write failing README tests**

In `test/readme.test.js`, update version coverage:

```js
it('mentions V0.21 (device backup health panel)', () => {
  assertReadmeContains(/V0\.21/, 'V0.21');
});
```

Replace the current V0.20-specific version assertions with V0.21 assertions, and keep V0.20 as a previous milestone:

```js
// ── V0.21 documentation ────────────────────────────────────────────

describe('README — V0.21 device backup health panel', () => {
  it('title says V0.21', () => {
    assert.match(readme, /^# Linke V0\.21/m);
  });

  it('version badge says 当前版本：V0.21', () => {
    assert.match(readme, /当前版本：V0\.21/);
  });

  it('version table has V0.21 row with 当前版本 milestone', () => {
    assert.match(readme, /\| V0\.21 \| 当前版本 \|[^|]*设备备份健康/);
  });

  it('version table keeps V0.20 as 事件日志面板增强 milestone', () => {
    assert.match(readme, /\| V0\.20 \| 事件日志面板增强 \|/);
  });

  it('documents device backup health as front-end read-only derived view', () => {
    assert.match(readme, /设备备份健康/);
    assert.match(readme, /前端.*只读.*派生视图|只读.*前端.*派生视图/);
  });

  it('documents device backup health statuses and reasons', () => {
    assert.match(readme, /健康/);
    assert.match(readme, /需关注/);
    assert.match(readme, /离线/);
    assert.match(readme, /未知/);
    assert.match(readme, /缺少有效备份|最近备份有效/);
  });

  it('asserts safety docs for device backup health panel', () => {
    assert.match(readme, /设备备份健康安全保证/);
    assert.match(readme, /不新增 API/);
    assert.match(readme, /不写入(任何)?元数据|不写入(any)?metadata/);
    assert.match(readme, /不触发备份|不进行备份/);
    assert.match(readme, /不执行恢复|不进行恢复/);
    assert.match(readme, /不删除快照|不进行删除/);
    assert.match(readme, /不连接 NAS|不建立真实 NAS 连接/);
    assert.match(readme, /不调用 NAS app|不调用 NAS 应用/);
    assert.match(readme, /不执行远程传输|不进行远程文件传输/);
  });

  it('documents test coverage includes device backup health panel', () => {
    assert.match(readme, /设备备份健康面板/);
  });
});
```

- [ ] **Step 2: Run RED README tests**

Run:

```bash
node --test test/readme.test.js
```

Expected: fails because README is still V0.20 and has no V0.21 device backup health docs.

- [ ] **Step 3: Update README version and feature list**

In `README.md`:

Change:

```md
# Linke V0.20
```

to:

```md
# Linke V0.21
```

Change the current-version badge to `V0.21`.

Change the V0.20 version-table row from `当前版本` to `事件日志面板增强`, and add:

```md
| V0.21 | 当前版本 | Web Console 新增设备备份健康面板，基于现有设备状态、快照数和最后备份时间生成只读健康分类 |
```

Add a feature bullet:

```md
- **设备备份健康** — Web Console 基于现有 `/api/devices` 数据生成前端只读健康分类，展示健康、需关注、离线和未知设备数量
```

Add `设备备份健康` to the Web Console feature summary.

- [ ] **Step 4: Add README V0.21 behavior section**

Add this section after the V0.20 event log section:

```md
### Web Console 设备备份健康

V0.21 在 Web Console 中新增设备备份健康面板。控制台复用现有 `/api/devices` 响应，在前端生成只读健康分类：

- `健康`：设备在线，快照数大于 0，且最后备份时间有效且不晚于当前时间
- `需关注`：设备在线，但缺少有效备份记录，例如快照数为 0、缺少最后备份时间或最后备份时间无效
- `离线`：设备状态为 offline
- `未知`：设备状态缺失或不是 online / offline

面板会展示健康、需关注、离线和未知数量，并列出每台设备的 hostname、Device ID、IP 地址、状态、快照数、最后心跳、最后备份和健康原因。点击健康项会复用现有设备选择流程，加载设备详情、快照、保留计划和备份任务视图。

该面板是前端只读派生视图，不新增 API、不写入 metadata、不触发备份、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。健康结果刷新页面后会重新从 `/api/devices` 派生，不会被持久化保存。
```

- [ ] **Step 5: Add README safety section**

In the safety boundary area, add:

```md
### 设备备份健康安全保证

- 设备备份健康面板只读取现有 `/api/devices` 响应，在前端生成只读派生视图。
- 不新增 API，不写入任何元数据，不保存健康分类结果。
- 不触发备份、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。
- 未来时间的最后备份会被视为无效备份，避免因时钟漂移误报健康。
```

Update the test coverage line to include:

```md
设备备份健康面板
```

- [ ] **Step 6: Run GREEN README tests**

Run:

```bash
node --test test/readme.test.js
```

Expected: all README tests pass.

---

## Task 4: Final Integration Verification

**Files:**
- Modify: none expected beyond Tasks 1-3.
- Test: full repository.

**Interfaces:**
- Consumes: all V0.21 implementation and docs.
- Produces: PM verification evidence.

- [ ] **Step 1: Run focused tests**

Run:

```bash
node --test test/web-console.test.js
node --test test/readme.test.js
```

Expected: both pass.

- [ ] **Step 2: Run compact full test suite**

Run:

```bash
node --test --test-reporter=dot test/*.test.js
```

Expected: exit code 0.

If sandbox returns `listen EPERM: operation not permitted 127.0.0.1`, rerun the same command outside the sandbox with user-approved escalation.

- [ ] **Step 3: Run diff whitespace check**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 4: Run HTTP smoke**

Start the server on a free localhost port:

```bash
PORT=3006 HOST=127.0.0.1 DATA_DIR=/tmp/linke-v021-smoke node src/server.js
```

In another command, assert:

```bash
node --input-type=module -e "
const base = 'http://127.0.0.1:3006';
const html = await (await fetch(base + '/')).text();
const js = await (await fetch(base + '/app.js')).text();
const devices = await (await fetch(base + '/api/devices')).json();
if (!html.includes('device-health-panel')) throw new Error('missing device-health-panel');
if (!html.includes('device-health-list')) throw new Error('missing device-health-list');
if (!html.includes('device-health-safety-note')) throw new Error('missing device-health-safety-note');
if (!js.includes('buildDeviceBackupHealth')) throw new Error('missing buildDeviceBackupHealth');
if (!js.includes('device-health-item')) throw new Error('missing device-health-item');
if (!js.includes('data-health-status')) throw new Error('missing data-health-status');
if (!Array.isArray(devices)) throw new Error('/api/devices must return array');
console.log(JSON.stringify({ html: true, js: true, devices: true }));
"
```

Expected output:

```json
{"html":true,"js":true,"devices":true}
```

Stop the server after the smoke.

- [ ] **Step 5: Safety scan**

Run:

```bash
git diff -- src test README.md docs/superpowers/specs docs/superpowers/plans
```

Expected:

- V0.21 health panel, tests, README, spec, and this plan are the only intentional changes.
- No new backend API routes.
- No new metadata writes.
- No new NAS connection or remote transfer code.
- Health item rendering uses `createElement` and `textContent`.

- [ ] **Step 6: Report**

Return this schema to Codex PM:

```text
角色：implementer / verifier
状态：DONE / DONE_WITH_CONCERNS / FAILED_VERIFICATION
交接对象：PM
改动文件：
运行命令：
验证结果：
未验证内容：
风险：
```
