# Linke V0.18 Backup Job Detail Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only Web Console backup job detail timeline for the selected inferred backup job.

**Architecture:** Reuse the existing snapshots response and V0.17 backup job grouping key. Add one pure helper for timeline derivation, one HTML panel, small CSS additions, and DOM wiring inside the existing `initConsole` flow. No backend route, storage mutation, NAS call, backup execution, restore execution, or persistent job state is added.

**Tech Stack:** Node.js ESM, vanilla browser JavaScript, static HTML/CSS, `node:test`, existing Web Console mock DOM tests.

## Global Constraints

- Current implementation target is V0.18.
- Reuse only `GET /api/devices/:deviceId/snapshots` for timeline data.
- Do not add `/api/devices/:deviceId/backup-jobs` or `/api/devices/:deviceId/backup-jobs/:key`.
- Do not call `POST /api/backups`.
- Do not call `POST /api/restore`.
- Do not call `POST /api/nas-dry-run`.
- Do not write metadata.
- Do not create, restore, delete, overwrite, or transfer files.
- Do not connect NAS and do not invoke NAS apps.
- Do not persist job selection or job state.
- Time line rows are read-only and do not trigger manifest detail or restore dry-run in V0.18.
- Device switching, snapshot loading, and snapshot load failure must clear stale backup job detail.
- Do not read or output credentials, tokens, API keys, `.env`, or other secret files.
- Commit and push require explicit user approval.

---

## File Structure

- Modify `src/web/app.js`
  - Add exported pure helper `buildBackupJobTimeline(snapshots, jobKey)`.
  - Reuse existing `normalizeBackupJobName`, `normalizeSourcePath`, `getSnapshotCreatedAtTime`, and `getSnapshotFileCount`.
  - Add detail-panel DOM references and render helpers inside `initConsole`.
  - Make backup job overview items selectable and read-only.
  - Reset selected backup job and cached snapshots when device state changes.
- Modify `src/web/index.html`
  - Add `backup-job-detail-panel` after `backup-jobs-panel`.
  - Add stable hooks required by the V0.18 spec.
- Modify `src/web/styles.css`
  - Add compact styles for selected backup job items and the detail timeline.
  - Preserve existing panel density and avoid nested-card styling.
- Modify `test/web-console.test.js`
  - Import and test `buildBackupJobTimeline`.
  - Add HTML/source contract tests for the new panel and read-only boundary.
  - Add DOM tests for selecting a backup job and clearing stale detail on device switch.
- Modify `README.md`
  - Update current version to V0.18.
  - Add version table entry and feature text.
  - Add `Web Console 备份任务详情时间线` section.
  - Update test coverage sentence.

---

### Task 1: Pure Timeline Helper

**Files:**
- Modify: `src/web/app.js`
- Modify: `test/web-console.test.js`

**Interfaces:**
- Consumes: existing `buildBackupJobOverview(snapshots)` output key rules.
- Produces: `buildBackupJobTimeline(snapshots, jobKey)`

Return shape:

```js
{
  key: 'job:documents',
  jobName: 'documents',
  sourcePath: '/Users/ah/Documents',
  snapshotCount: 2,
  latestSnapshotId: '22222222-2222-2222-2222-222222222222',
  latestCreatedAt: '2026-07-04T12:00:00.000Z',
  latestFileCount: 8,
  snapshots: [
    {
      snapshotId: '22222222-2222-2222-2222-222222222222',
      createdAt: '2026-07-04T12:00:00.000Z',
      sourcePath: '/Users/ah/Documents',
      fileCount: 8
    }
  ]
}
```

- [ ] **Step 1: Add the failing import**

Modify the import list in `test/web-console.test.js`:

```js
import {
  applyDeviceListControls,
  buildBackupJobOverview,
  buildBackupJobTimeline,
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

- [ ] **Step 2: Write failing pure-helper tests**

Add this block after `describe('buildBackupJobOverview', ...)`:

```js
// ── V0.18 buildBackupJobTimeline ───────────────────────────────────

describe('buildBackupJobTimeline', () => {
  it('filters snapshots by job key and sorts timeline by latest backup first', () => {
    const result = buildBackupJobTimeline([
      {
        snapshotId: '11111111-1111-1111-1111-111111111111',
        jobName: 'documents',
        sourcePath: '/Users/ah/Documents',
        createdAt: '2026-07-04T10:00:00.000Z',
        fileCount: 4,
      },
      {
        snapshotId: '22222222-2222-2222-2222-222222222222',
        jobName: 'photos',
        sourcePath: '/Users/ah/Pictures',
        createdAt: '2026-07-04T12:00:00.000Z',
        fileCount: 9,
      },
      {
        snapshotId: '33333333-3333-3333-3333-333333333333',
        jobName: 'documents',
        sourcePath: '/Users/ah/Documents',
        createdAt: '2026-07-04T11:00:00.000Z',
        fileCount: 7,
      },
    ], 'job:documents');

    assert.strictEqual(result.key, 'job:documents');
    assert.strictEqual(result.jobName, 'documents');
    assert.strictEqual(result.sourcePath, '/Users/ah/Documents');
    assert.strictEqual(result.snapshotCount, 2);
    assert.strictEqual(result.latestSnapshotId, '33333333-3333-3333-3333-333333333333');
    assert.strictEqual(result.latestFileCount, 7);
    assert.deepStrictEqual(result.snapshots.map((snap) => snap.snapshotId), [
      '33333333-3333-3333-3333-333333333333',
      '11111111-1111-1111-1111-111111111111',
    ]);
    assert.doesNotMatch(JSON.stringify(result), /undefined|null|Invalid Date/);
  });

  it('filters unnamed snapshots by sourcePath key with stable fallbacks', () => {
    const result = buildBackupJobTimeline([
      {
        snapshotId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        sourcePath: '/Users/ah/Desktop',
        createdAt: 'not-a-date',
      },
      {
        snapshotId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        jobName: '',
        sourcePath: '/Users/ah/Desktop',
        createdAt: '2026-07-04T13:00:00.000Z',
        fileCount: 3,
      },
      {
        snapshotId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        sourcePath: '',
        createdAt: '',
      },
    ], 'source:/Users/ah/Desktop');

    assert.strictEqual(result.key, 'source:/Users/ah/Desktop');
    assert.strictEqual(result.jobName, '未命名任务');
    assert.strictEqual(result.sourcePath, '/Users/ah/Desktop');
    assert.strictEqual(result.snapshotCount, 2);
    assert.strictEqual(result.latestSnapshotId, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    assert.strictEqual(result.latestFileCount, 3);
    assert.deepStrictEqual(result.snapshots.map((snap) => snap.snapshotId), [
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    ]);
    assert.doesNotMatch(JSON.stringify(result), /undefined|null|Invalid Date/);
  });

  it('returns null when the requested job key has no matching snapshots', () => {
    const result = buildBackupJobTimeline([
      {
        snapshotId: '11111111-1111-1111-1111-111111111111',
        jobName: 'documents',
        sourcePath: '/Users/ah/Documents',
        createdAt: '2026-07-04T10:00:00.000Z',
        fileCount: 4,
      },
    ], 'job:missing');

    assert.strictEqual(result, null);
  });
});
```

- [ ] **Step 3: Run tests to verify red**

Run:

```bash
node --test test/web-console.test.js
```

Expected: fail during module import with an error equivalent to `does not provide an export named 'buildBackupJobTimeline'`.

- [ ] **Step 4: Implement the helper**

In `src/web/app.js`, add this helper before `export function buildBackupJobOverview(snapshots)`:

```js
function getBackupJobKey(snapshot) {
  const rawJobName = String(snapshot?.jobName || '').trim();
  const sourcePath = normalizeSourcePath(snapshot?.sourcePath);
  return rawJobName ? 'job:' + rawJobName : 'source:' + sourcePath;
}
```

Update `buildBackupJobOverview` to use `getBackupJobKey(snapshot)`:

```js
export function buildBackupJobOverview(snapshots) {
  const safeSnapshots = Array.isArray(snapshots) ? snapshots : [];
  const groups = new Map();
  let latestBackupAt = null;
  let latestBackupTime = 0;

  for (const snapshot of safeSnapshots) {
    const rawJobName = String(snapshot?.jobName || '').trim();
    const sourcePath = normalizeSourcePath(snapshot?.sourcePath);
    const key = getBackupJobKey(snapshot);
    const createdAtTime = getSnapshotCreatedAtTime(snapshot);
```

Then add the exported V0.18 helper after `buildBackupJobOverview`:

```js
export function buildBackupJobTimeline(snapshots, jobKey) {
  const safeSnapshots = Array.isArray(snapshots) ? snapshots : [];
  const selectedKey = String(jobKey || '').trim();
  if (!selectedKey) return null;

  const matchingSnapshots = safeSnapshots
    .filter((snapshot) => getBackupJobKey(snapshot) === selectedKey)
    .map((snapshot) => ({
      snapshotId: snapshot?.snapshotId || '',
      createdAt: snapshot?.createdAt || '',
      sourcePath: normalizeSourcePath(snapshot?.sourcePath),
      fileCount: getSnapshotFileCount(snapshot),
      createdAtTime: getSnapshotCreatedAtTime(snapshot),
    }))
    .sort((a, b) => b.createdAtTime - a.createdAtTime || a.snapshotId.localeCompare(b.snapshotId));

  if (matchingSnapshots.length === 0) return null;

  const latestSnapshot = matchingSnapshots[0];
  const rawJobName = String(safeSnapshots.find((snapshot) => getBackupJobKey(snapshot) === selectedKey)?.jobName || '').trim();
  const sourcePath = latestSnapshot.sourcePath;
  const timelineSnapshots = matchingSnapshots.map(({ createdAtTime, ...snapshot }) => snapshot);

  return {
    key: selectedKey,
    jobName: normalizeBackupJobName(rawJobName),
    sourcePath,
    snapshotCount: timelineSnapshots.length,
    latestSnapshotId: latestSnapshot.snapshotId || null,
    latestCreatedAt: latestSnapshot.createdAt,
    latestFileCount: latestSnapshot.fileCount,
    snapshots: timelineSnapshots,
  };
}
```

- [ ] **Step 5: Run tests to verify green for helper**

Run:

```bash
node --test test/web-console.test.js
```

Expected: helper tests pass. Other failures at this point are only acceptable if later tasks have already added failing UI tests.

- [ ] **Step 6: Commit task 1 only after user approval**

Suggested commit:

```bash
git add src/web/app.js test/web-console.test.js
git commit -m "feat: add backup job timeline helper"
```

Do not run this commit unless Aaron has explicitly approved commit for the implementation phase.

---

### Task 2: HTML Hooks and Styling

**Files:**
- Modify: `src/web/index.html`
- Modify: `src/web/styles.css`
- Modify: `test/web-console.test.js`

**Interfaces:**
- Consumes: V0.18 spec DOM hooks.
- Produces: static panel elements:
  - `backup-job-detail-panel`
  - `backup-job-detail-device-name`
  - `backup-job-detail-title`
  - `backup-job-detail-source`
  - `backup-job-detail-count`
  - `backup-job-detail-latest`
  - `backup-job-detail-list`
  - `backup-job-detail-empty`

- [ ] **Step 1: Write failing HTML/source contract tests**

Add these tests after the V0.17 backup jobs overview contract tests:

```js
  // ── V0.18 Backup job detail timeline HTML/source contract ───────

  it('HTML contains V0.18 backup job detail timeline panel hooks', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.ok(html.includes('data-testid="backup-job-detail-panel"'), 'must have backup-job-detail-panel');
    assert.ok(html.includes('data-testid="backup-job-detail-device-name"'), 'must have backup-job-detail-device-name');
    assert.ok(html.includes('data-testid="backup-job-detail-title"'), 'must have backup-job-detail-title');
    assert.ok(html.includes('data-testid="backup-job-detail-source"'), 'must have backup-job-detail-source');
    assert.ok(html.includes('data-testid="backup-job-detail-count"'), 'must have backup-job-detail-count');
    assert.ok(html.includes('data-testid="backup-job-detail-latest"'), 'must have backup-job-detail-latest');
    assert.ok(html.includes('data-testid="backup-job-detail-list"'), 'must have backup-job-detail-list');
    assert.ok(html.includes('data-testid="backup-job-detail-empty"'), 'must have backup-job-detail-empty');
  });

  it('backup job detail panel is read-only and has no execution button', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    const panelMatch = html.match(/data-testid="backup-job-detail-panel"[\s\S]*?<\/section>/);

    assert.ok(panelMatch, 'backup-job-detail-panel section must exist');
    assert.ok(!panelMatch[0].includes('<button'), 'backup job detail panel must not contain action buttons');
    assert.ok(/只读|时间线|不触发|不写入|不连接 NAS/.test(panelMatch[0]), 'panel must communicate read-only behavior');
    assert.ok(!/执行备份|创建备份|删除|编辑|重试|恢复|远程传输/i.test(panelMatch[0]), 'panel must not expose execution wording');
  });
```

- [ ] **Step 2: Run tests to verify red**

Run:

```bash
node --test test/web-console.test.js
```

Expected: HTML contract tests fail because the new panel hooks do not exist yet. The source wiring test also fails until Task 3.

- [ ] **Step 3: Add the HTML panel**

In `src/web/index.html`, insert this section immediately after the existing `backup-jobs-panel` section and before `events-panel`:

```html
      <section class="panel backup-job-detail-panel" data-testid="backup-job-detail-panel">
        <h2>备份任务详情 <span id="backup-job-detail-device-name" class="device-name" data-testid="backup-job-detail-device-name"></span></h2>
        <div class="backup-job-detail-summary">
          <div class="backup-job-detail-stat">
            <span id="backup-job-detail-title" data-testid="backup-job-detail-title">未选择</span>
            <span>任务</span>
          </div>
          <div class="backup-job-detail-stat">
            <span id="backup-job-detail-count" data-testid="backup-job-detail-count">0</span>
            <span>快照数</span>
          </div>
          <div class="backup-job-detail-stat">
            <span id="backup-job-detail-latest" data-testid="backup-job-detail-latest">无备份</span>
            <span>最近备份</span>
          </div>
        </div>
        <div id="backup-job-detail-source" class="backup-job-detail-source" data-testid="backup-job-detail-source">sourcePath: —</div>
        <ul id="backup-job-detail-list" class="backup-job-detail-list" data-testid="backup-job-detail-list">
          <li class="placeholder" data-testid="backup-job-detail-empty">请选择一个备份任务</li>
        </ul>
        <div class="backup-job-detail-safety-note" data-testid="backup-job-detail-safety-note">
          <p>备份任务详情时间线为只读派生视图，只读取现有 snapshot 元数据，不触发备份、不执行恢复、不写入元数据、不连接 NAS。</p>
        </div>
      </section>
```

- [ ] **Step 4: Add compact CSS**

In `src/web/styles.css`, add these styles near the existing `.backup-jobs-panel` rules:

```css
.backup-job-detail-panel {
  grid-column: 2 / 4;
  max-height: 420px;
}

.backup-job-item {
  cursor: pointer;
}

.backup-job-item.selected {
  border-color: #2563eb;
  background: #eff6ff;
}

.backup-job-detail-summary {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
}

.backup-job-detail-stat {
  min-width: 92px;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid #e5e5e5;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 0.75rem;
  color: #666;
}

.backup-job-detail-stat span:first-child {
  font-size: 1.05rem;
  font-weight: 700;
  color: #222;
  overflow-wrap: anywhere;
}

.backup-job-detail-source {
  margin-bottom: 10px;
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 0.78rem;
  color: #4b5563;
  overflow-wrap: anywhere;
}

.backup-job-detail-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.backup-job-timeline-item {
  padding: 9px 10px;
  border: 1px solid #eee;
  border-radius: 6px;
  margin-bottom: 6px;
  display: grid;
  gap: 3px;
}

.backup-job-timeline-id {
  font-weight: 700;
  font-size: 0.86rem;
  color: #222;
  overflow-wrap: anywhere;
}

.backup-job-timeline-created,
.backup-job-timeline-file-count,
.backup-job-timeline-source {
  font-size: 0.76rem;
  color: #6b7280;
  overflow-wrap: anywhere;
}

.backup-job-timeline-source {
  font-family: "SFMono-Regular", Consolas, monospace;
}

.backup-job-detail-safety-note {
  margin-top: 10px;
  color: #6b7280;
  font-size: 0.78rem;
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
node --test test/web-console.test.js
```

Expected: HTML hooks and read-only test pass.

- [ ] **Step 6: Commit task 2 only after user approval**

Suggested commit:

```bash
git add src/web/index.html src/web/styles.css test/web-console.test.js
git commit -m "feat: add backup job detail panel"
```

Do not run this commit unless Aaron has explicitly approved commit for the implementation phase.

---

### Task 3: DOM Data Flow and Read-Only Timeline Rendering

**Files:**
- Modify: `src/web/app.js`
- Modify: `test/web-console.test.js`

**Interfaces:**
- Consumes: `buildBackupJobTimeline(snapshots, jobKey)`.
- Produces:
  - `selectedBackupJobKey` state inside `initConsole`.
  - `cachedSnapshots` state inside `initConsole`.
  - `renderBackupJobDetail(jobKey, snapshots, deviceId)`.
  - Selectable read-only backup job overview items.

- [ ] **Step 1: Write failing DOM test for selecting a backup job**

Add this source wiring test after the V0.18 HTML/source contract tests:

```js
  it('app.js wires backup job detail timeline into snapshot loading', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();

    assert.ok(js.includes('buildBackupJobTimeline'), 'app.js must reference buildBackupJobTimeline');
    assert.ok(js.includes('backup-job-detail-list'), 'app.js must reference backup-job-detail-list');
    assert.ok(js.includes('renderBackupJobDetail'), 'app.js must render backup job detail');
  });
```

Add this test after `renders backup jobs overview when a device is clicked`:

```js
  it('renders backup job detail timeline when a backup job is clicked', async () => {
    const doc = buildMockDoc();
    const devices = [
      {
        deviceId: 'd4',
        hostname: 'host-four',
        status: 'online',
        ipAddress: '10.0.0.4',
        snapshotCount: 3,
        lastHeartbeatAt: '2026-07-04T10:00:00.000Z',
      },
    ];
    const snapshots = [
      {
        snapshotId: '11111111-1111-1111-1111-111111111111',
        jobName: 'documents',
        sourcePath: '/Users/ah/Documents',
        createdAt: '2026-07-04T10:00:00.000Z',
        fileCount: 4,
      },
      {
        snapshotId: '22222222-2222-2222-2222-222222222222',
        jobName: 'photos',
        sourcePath: '/Users/ah/Pictures',
        createdAt: '2026-07-04T12:00:00.000Z',
        fileCount: 9,
      },
      {
        snapshotId: '33333333-3333-3333-3333-333333333333',
        jobName: 'documents',
        sourcePath: '/Users/ah/Documents',
        createdAt: '2026-07-04T11:00:00.000Z',
        fileCount: 7,
      },
    ];
    const mockFetch = async (url) => {
      if (url.includes('/retention-dry-run')) {
        return { ok: true, status: 200, json: async () => ({ keepCount: 0, wouldDeleteCount: 0, snapshots: [] }) };
      }
      return { ok: true, status: 200, json: async () => (url.includes('/snapshots') ? snapshots : devices) };
    };
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));

    const deviceItem = doc._created.find((el) => el.className && el.className.includes('device-item'));
    assert.ok(deviceItem, 'device-item must exist');
    deviceItem._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    const backupJobItems = doc._created.filter((el) => el.className && el.className.includes('backup-job-item'));
    const documentsJob = backupJobItems.find((el) => /documents/.test(el.textContent));
    assert.ok(documentsJob, 'documents backup job item must exist');
    assert.ok(documentsJob._listeners.click, 'backup job item must be selectable');
    documentsJob._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(doc.getElementById('backup-job-detail-device-name').textContent, '— d4');
    assert.strictEqual(doc.getElementById('backup-job-detail-title').textContent, 'documents');
    assert.strictEqual(doc.getElementById('backup-job-detail-count').textContent, '2');
    assert.match(doc.getElementById('backup-job-detail-latest').textContent, /2026|7|04|11/);
    assert.match(doc.getElementById('backup-job-detail-source').textContent, /\/Users\/ah\/Documents/);

    const detailText = doc.getElementById('backup-job-detail-list').textContent;
    assert.match(detailText, /33333333/);
    assert.match(detailText, /11111111/);
    assert.match(detailText, /7 files/);
    assert.match(detailText, /4 files/);
    assert.doesNotMatch(detailText, /22222222/);
    assert.doesNotMatch(detailText, /undefined|null|Invalid Date/);
  });
```

- [ ] **Step 2: Write failing DOM test for stale detail clearing**

Add this test after the existing stale overview clearing test:

```js
  it('clears stale backup job detail immediately when switching to a device with pending snapshots', async () => {
    const doc = buildMockDoc();
    const devices = [
      {
        deviceId: 'dev-A',
        hostname: 'Alpha',
        status: 'online',
        ipAddress: '10.0.0.10',
        snapshotCount: 1,
        lastHeartbeatAt: '2026-07-04T10:00:00.000Z',
      },
      {
        deviceId: 'dev-B',
        hostname: 'Beta',
        status: 'online',
        ipAddress: '10.0.0.11',
        snapshotCount: 1,
        lastHeartbeatAt: '2026-07-04T10:00:00.000Z',
      },
    ];
    const snapshotsA = [
      {
        snapshotId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        jobName: 'alpha-job',
        sourcePath: '/alpha/data',
        createdAt: '2026-07-04T10:00:00.000Z',
        fileCount: 3,
      },
    ];

    let resolveSnapshotsB;
    const snapshotsBPromise = new Promise((resolve) => { resolveSnapshotsB = resolve; });

    const mockFetch = async (url) => {
      if (url.includes('/retention-dry-run')) {
        return { ok: true, status: 200, json: async () => ({ keepCount: 0, wouldDeleteCount: 0, snapshots: [] }) };
      }
      if (url.includes('/snapshots')) {
        if (url.includes('dev-A')) {
          return { ok: true, status: 200, json: async () => snapshotsA };
        }
        if (url.includes('dev-B')) {
          const data = await snapshotsBPromise;
          return { ok: true, status: 200, json: async () => data };
        }
      }
      return { ok: true, status: 200, json: async () => devices };
    };
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));

    const deviceItems = doc._created.filter((el) => el.className && el.className.includes('device-item'));
    assert.ok(deviceItems.length >= 2, 'must have at least 2 device items');

    deviceItems[0]._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    const alphaJob = doc._created.find((el) => el.className && el.className.includes('backup-job-item') && /alpha-job/.test(el.textContent));
    assert.ok(alphaJob, 'alpha job item must exist');
    alphaJob._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.match(doc.getElementById('backup-job-detail-list').textContent, /alpha-job|aaaaaaaa|\/alpha\/data/);

    deviceItems[1]._listeners.click();
    await new Promise((r) => setTimeout(r, 0));

    assert.strictEqual(doc.getElementById('backup-job-detail-device-name').textContent, '— dev-B');
    assert.strictEqual(doc.getElementById('backup-job-detail-title').textContent, '未选择');
    assert.strictEqual(doc.getElementById('backup-job-detail-count').textContent, '0');
    assert.strictEqual(doc.getElementById('backup-job-detail-latest').textContent, '无备份');
    const detailTextB = doc.getElementById('backup-job-detail-list').textContent;
    assert.doesNotMatch(detailTextB, /alpha-job/, 'must not contain stale job name from device A');
    assert.doesNotMatch(detailTextB, /aaaaaaaa/, 'must not contain stale snapshot ID from device A');
    assert.doesNotMatch(detailTextB, /\/alpha\/data/, 'must not contain stale source path from device A');

    resolveSnapshotsB([]);
    await new Promise((r) => setTimeout(r, 20));
  });
```

- [ ] **Step 3: Run tests to verify red**

Run:

```bash
node --test test/web-console.test.js
```

Expected: DOM tests fail because backup job items have no click listener and detail rendering does not exist.

- [ ] **Step 4: Add DOM references and state**

In `src/web/app.js`, add detail element references near existing backup jobs references:

```js
  const backupJobDetailDeviceName = doc.getElementById('backup-job-detail-device-name');
  const backupJobDetailTitleEl = doc.getElementById('backup-job-detail-title');
  const backupJobDetailSourceEl = doc.getElementById('backup-job-detail-source');
  const backupJobDetailCountEl = doc.getElementById('backup-job-detail-count');
  const backupJobDetailLatestEl = doc.getElementById('backup-job-detail-latest');
  const backupJobDetailListEl = doc.getElementById('backup-job-detail-list');
```

Add state near `selectedSnapshotId`:

```js
  let selectedBackupJobKey = null;
  let cachedSnapshots = [];
```

- [ ] **Step 5: Add detail render helpers**

In `src/web/app.js`, add these functions near `setBackupJobsPlaceholder`:

```js
  function setBackupJobDetailSummary(title, sourcePath, snapshotCount, latestBackupAt) {
    if (backupJobDetailTitleEl) backupJobDetailTitleEl.textContent = title;
    if (backupJobDetailSourceEl) backupJobDetailSourceEl.textContent = 'sourcePath: ' + sourcePath;
    if (backupJobDetailCountEl) backupJobDetailCountEl.textContent = String(snapshotCount);
    if (backupJobDetailLatestEl) backupJobDetailLatestEl.textContent = formatLastBackup(latestBackupAt);
  }

  function setBackupJobDetailPlaceholder(message, deviceId) {
    if (backupJobDetailDeviceName) backupJobDetailDeviceName.textContent = deviceId ? '— ' + deviceId : '';
    setBackupJobDetailSummary('未选择', '—', 0, null);
    clearElement(backupJobDetailListEl);
    if (!backupJobDetailListEl) return;

    const item = doc.createElement('li');
    item.className = 'placeholder';
    item.setAttribute('data-testid', 'backup-job-detail-empty');
    item.textContent = message;
    backupJobDetailListEl.appendChild(item);
  }

  function renderBackupJobDetail(jobKey, snapshots, deviceId) {
    if (backupJobDetailDeviceName) backupJobDetailDeviceName.textContent = deviceId ? '— ' + deviceId : '';

    const timeline = buildBackupJobTimeline(snapshots, jobKey);
    if (!timeline) {
      setBackupJobDetailPlaceholder('请选择一个备份任务', deviceId);
      return;
    }

    setBackupJobDetailSummary(timeline.jobName, timeline.sourcePath, timeline.snapshotCount, timeline.latestCreatedAt);
    clearElement(backupJobDetailListEl);
    if (!backupJobDetailListEl) return;

    timeline.snapshots.forEach(function (snapshot) {
      const item = doc.createElement('li');
      item.className = 'backup-job-timeline-item';
      item.setAttribute('data-testid', 'backup-job-timeline-item');

      const id = doc.createElement('span');
      id.className = 'backup-job-timeline-id';
      id.setAttribute('data-testid', 'backup-job-timeline-id');
      id.textContent = snapshot.snapshotId ? snapshot.snapshotId.slice(0, 8) + '…' : 'unknown';

      const created = doc.createElement('span');
      created.className = 'backup-job-timeline-created';
      created.setAttribute('data-testid', 'backup-job-timeline-created');
      created.textContent = '创建时间 ' + formatLastBackup(snapshot.createdAt);

      const fileCount = doc.createElement('span');
      fileCount.className = 'backup-job-timeline-file-count';
      fileCount.setAttribute('data-testid', 'backup-job-timeline-file-count');
      fileCount.textContent = String(snapshot.fileCount || 0) + ' files';

      const source = doc.createElement('span');
      source.className = 'backup-job-timeline-source';
      source.setAttribute('data-testid', 'backup-job-timeline-source');
      source.textContent = snapshot.sourcePath;

      item.appendChild(id);
      item.appendChild(created);
      item.appendChild(fileCount);
      item.appendChild(source);
      backupJobDetailListEl.appendChild(item);
    });
  }
```

- [ ] **Step 6: Reset detail during device click and snapshot loading**

In the device item click listener, update the state before rendering:

```js
      li.addEventListener('click', function () {
        selectedDeviceId = device.deviceId;
        selectedSnapshotId = null;
        selectedBackupJobKey = null;
        cachedSnapshots = [];
        setBackupJobDetailPlaceholder('加载中…', device.deviceId);
        renderDeviceDetail(device);
        renderFilteredDevices();
        fetchSnapshots(device.deviceId);
        fetchRetentionPlan(device.deviceId);
      });
```

In `fetchSnapshots(deviceId)`, add resets:

```js
  async function fetchSnapshots(deviceId) {
    snapshotDeviceName.textContent = '— ' + deviceId;
    snapshotListEl.innerHTML = '<li class="placeholder">加载中…</li>';
    selectedBackupJobKey = null;
    cachedSnapshots = [];
    if (backupJobsDeviceName) backupJobsDeviceName.textContent = '— ' + deviceId;
    setBackupJobsPlaceholder('加载中…');
    setBackupJobDetailPlaceholder('加载中…', deviceId);
```

On success, cache snapshots and render the detail placeholder:

```js
      const snapshots = await res.json();
      cachedSnapshots = Array.isArray(snapshots) ? snapshots : [];
      renderSnapshots(cachedSnapshots, deviceId);
      renderBackupJobsOverview(cachedSnapshots, deviceId);
      renderBackupJobDetail(null, cachedSnapshots, deviceId);
      renderSnapshotDiffControls(cachedSnapshots, deviceId);
      logEvent('已加载 ' + cachedSnapshots.length + ' 个快照 (' + deviceId + ')', 'info');
```

On failure, clear cache and detail:

```js
    } catch (err) {
      cachedSnapshots = [];
      selectedBackupJobKey = null;
      snapshotListEl.innerHTML = '<li class="placeholder">加载失败</li>';
      setBackupJobsPlaceholder('加载失败');
      setBackupJobDetailPlaceholder('加载失败', deviceId);
      setSnapshotDiffPlaceholder('加载失败');
      setRestoreDryRunPlaceholder('加载失败');
      logEvent('加载快照失败: ' + err.message, 'error');
    }
```

- [ ] **Step 7: Make overview items selectable**

Inside `renderBackupJobsOverview`, update each item:

```js
    overview.jobs.forEach(function (job) {
      const item = doc.createElement('li');
      item.className = 'backup-job-item' + (job.key === selectedBackupJobKey ? ' selected' : '');
      item.setAttribute('data-testid', 'backup-job-item');
      item.dataset.backupJobKey = job.key;
      item.addEventListener('click', function () {
        selectedBackupJobKey = job.key;
        renderBackupJobsOverview(cachedSnapshots, deviceId);
        renderBackupJobDetail(selectedBackupJobKey, cachedSnapshots, deviceId);
      });
```

Keep the existing child element creation for `name`, `source`, and `meta`.

- [ ] **Step 8: Run DOM tests**

Run:

```bash
node --test test/web-console.test.js
```

Expected: V0.18 DOM tests pass and no existing V0.17 tests regress.

- [ ] **Step 9: Commit task 3 only after user approval**

Suggested commit:

```bash
git add src/web/app.js test/web-console.test.js
git commit -m "feat: render backup job timeline"
```

Do not run this commit unless Aaron has explicitly approved commit for the implementation phase.

---

### Task 4: README, Safety Contracts, and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `test/web-console.test.js`

**Interfaces:**
- Consumes: implemented V0.18 UI and helper.
- Produces: README V0.18 documentation and final verification evidence.

- [ ] **Step 1: Write README contract test updates**

In `test/web-console.test.js`, locate the README version/documentation tests and update or add assertions equivalent to:

```js
  it('README documents V0.18 backup job detail timeline', async () => {
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

    assert.match(readme, /^# Linke V0\.18/m);
    assert.match(readme, /当前版本：V0\.18/);
    assert.match(readme, /备份任务详情时间线/);
    assert.match(readme, /只读派生视图/);
    assert.match(readme, /不触发备份/);
    assert.match(readme, /不执行恢复/);
    assert.match(readme, /不连接 NAS/);
  });
```

If `readFile` is not already imported, update the import line:

```js
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
```

- [ ] **Step 2: Run tests to verify red**

Run:

```bash
node --test test/web-console.test.js
```

Expected: README V0.18 documentation test fails while README still says V0.17.

- [ ] **Step 3: Update README version and feature summary**

Apply these README edits:

```markdown
# Linke V0.18
```

```markdown
> **当前版本：V0.18** — 单机 localhost 原型阶段，尚未具备生产级安全隔离。
```

Add version table row after V0.17:

```markdown
| V0.18 | 当前版本 | Web Console 新增只读备份任务详情时间线，从既有 snapshot 元数据展示单个任务的历史版本 |
```

Change the V0.17 row milestone from `当前版本` to `备份任务概览`:

```markdown
| V0.17 | 备份任务概览 | Web Console 新增只读备份任务概览面板，从现有 snapshot 元数据按 jobName/sourcePath 聚合任务视图 |
```

Add a feature bullet near the existing backup jobs bullet:

```markdown
- **备份任务详情时间线** — Web Console 可从备份任务概览中选择一个任务，只读查看该任务的历史快照时间线、源路径、快照数量和最近备份时间
```

Update the Web Console feature list to include `备份任务详情时间线`:

```markdown
- **Web Console** — 管理界面：设备列表 / 设备详情 / 快照列表 / 快照清单详情 / 恢复预检 / 备份预检 / NAS 预检 / 快照差异预览 / 事件日志 / 保留计划面板 / 备份任务概览 / 备份任务详情时间线
```

- [ ] **Step 4: Add README V0.18 section**

Insert this section immediately after `### Web Console 备份任务概览`:

```markdown
### Web Console 备份任务详情时间线

V0.18 在 Web Console 中增加只读备份任务详情时间线。选中设备后，先在“备份任务概览”中选择一个从历史 snapshot 推导出的任务，控制台会继续复用现有 `/api/devices/:deviceId/snapshots` 响应展示该任务的历史版本：

- 任务名称
- 源路径
- 快照数量
- 最近备份时间
- 每个历史快照的 snapshot ID、创建时间、文件数量和 sourcePath

该面板是只读派生视图，不新增 API 路由、不写入 metadata、不触发备份、不执行恢复、不创建快照、不删除快照、不连接 NAS、不调用 NAS app、不执行远程传输。时间线行在 V0.18 中不联动 manifest detail 或 restore dry-run。尚未执行过、没有历史 snapshot 的配置任务不会出现在详情时间线中。
```

- [ ] **Step 5: Update test coverage sentence**

In README test coverage text, append `备份任务详情时间线面板`:

```markdown
测试覆盖：心跳、备份/恢复、并发隔离、路径安全、excludePatterns、run-once、launchd-dry-run、nas-dry-run、NAS app adapter dry-run、retention-dry-run、restore-dry-run、backup-preflight-dry-run、manifest 详情 API、snapshot diff dry-run API、Web Console 契约、保留计划面板、快照清单详情面板、恢复预检面板、备份预检面板、NAS dry-run 面板、备份预检命令提示与快照差异预览面板、设备详情面板、备份任务概览面板、备份任务详情时间线面板。
```

- [ ] **Step 6: Run focused test file**

Run:

```bash
node --test test/web-console.test.js
```

Expected: all tests in `test/web-console.test.js` pass.

- [ ] **Step 7: Run full test suite**

Run:

```bash
npm test
```

Expected: all repository tests pass.

- [ ] **Step 8: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 9: Run local HTTP smoke**

Start the server on an unused localhost port:

```bash
PORT=3005 HOST=127.0.0.1 DATA_DIR=/Users/ah/linke/scratch/v018-smoke-data node src/server.js
```

Then request the UI and app bundle from another shell:

```bash
curl -fsS http://127.0.0.1:3005/ > /tmp/linke-v018.html
curl -fsS http://127.0.0.1:3005/app.js > /tmp/linke-v018-app.js
rg -n 'backup-job-detail-panel|backup-job-detail-list|renderBackupJobDetail|buildBackupJobTimeline' /tmp/linke-v018.html /tmp/linke-v018-app.js
```

Expected: `rg` finds all four terms. Stop the server after the smoke check.

- [ ] **Step 10: Commit task 4 only after user approval**

Suggested commit:

```bash
git add README.md test/web-console.test.js
git commit -m "docs: document v0.18 backup job timeline"
```

Do not run this commit unless Aaron has explicitly approved commit for the implementation phase.

---

## PM Handoff for pm-dcw

Recommended roleMap for implementation:

```text
roleMap:
- adversary: PM-only for this narrow V0.18 continuation unless Aaron requests another model
- implementer: Qwen, writable only inside /Users/ah/linke/.worktrees/linke-v0.12-web-panel
- reviewer: AGY, read-only fresh diff review; if AGY returns empty output, lacks schema, or hangs beyond budget, mark invalid and stop for PM decision
- verifier: Codex PM; optional ZAI second opinion with strict English prompt after PM verification
```

Qwen implementer prompt must be narrow:

```text
Implement Linke V0.18 backup job detail timeline exactly from docs/superpowers/specs/2026-07-04-backup-job-detail-timeline-design.md and docs/superpowers/plans/2026-07-05-backup-job-detail-timeline.md.

Boundaries:
- Modify only src/web/app.js, src/web/index.html, src/web/styles.css, test/web-console.test.js, and README.md.
- Do not modify backend routes or storage code.
- Do not read .env or credential files.
- Do not add dependencies.
- Do not run git commit or git push.
- Keep the feature read-only.

Required output:
- Status: DONE / BLOCKED / NEEDS_PM
- Files changed
- Tests run with exact commands and exit status
- Summary of implementation
- Any risks or deviations
```

AGY reviewer prompt must be read-only and bounded:

```text
Review the current git diff for Linke V0.18 backup job detail timeline.

Check only:
1. The feature remains frontend-only and read-only.
2. No backend route, write endpoint call, NAS call, restore execution, backup execution, or metadata write was added.
3. Device switching and snapshot failure clear stale backup job detail.
4. buildBackupJobTimeline uses the same key rules as buildBackupJobOverview.
5. Tests meaningfully cover helper logic, DOM selection, stale-state clearing, README, and safety contracts.

Required schema:
STATUS: PASS / FAIL / INCONCLUSIVE
FINDINGS:
- severity | file:line | issue | suggested fix
TEST_GAPS:
- item or "none"
FINAL_RISK:
- concise risk statement
```

ZAI verifier prompt must be English, strict, and patient:

```text
You are a read-only verification reviewer for the Linke V0.18 backup job detail timeline.

Objective:
Determine whether the current git diff satisfies the V0.18 spec and remains read-only.

Context:
- Project path: /Users/ah/linke/.worktrees/linke-v0.12-web-panel
- Spec: docs/superpowers/specs/2026-07-04-backup-job-detail-timeline-design.md
- Plan: docs/superpowers/plans/2026-07-05-backup-job-detail-timeline.md

Boundaries:
- Read-only review only.
- Do not modify files.
- Do not read .env, credentials, tokens, SSH keys, or secret files.
- Do not infer test success unless evidence is present in the prompt or local files.

Required output schema:
STATUS: PASS / FAIL / INCONCLUSIVE
SPEC_MATCH:
- yes/no with concise evidence
READ_ONLY_BOUNDARY:
- yes/no with concise evidence
TEST_COVERAGE:
- sufficient/insufficient with concise evidence
FINDINGS:
- severity | file:line | issue | suggested fix
FINAL_VERDICT:
- one paragraph

If you cannot inspect enough evidence, return STATUS: INCONCLUSIVE and explain exactly what evidence is missing.
```

---

## Self-Review Checklist

- Spec coverage:
  - Pure helper and grouping key: Task 1.
  - DOM hooks and read-only panel: Task 2.
  - Click-to-detail timeline: Task 3.
  - Device switch and loading failure stale clearing: Task 3.
  - README V0.18 documentation: Task 4.
  - No new backend route or write call: Tasks 2, 3, and 4 tests plus final verification.
- Placeholder scan:
  - No unresolved placeholder markers.
  - No deferred implementation wording.
  - No vague edge-case instruction without concrete code or command.
  - No unspecified edge-case instruction.
- Type consistency:
  - `buildBackupJobTimeline(snapshots, jobKey)` is the only new exported helper.
  - `selectedBackupJobKey` and `cachedSnapshots` are only `initConsole` state.
  - DOM hook names match the V0.18 spec.
  - The timeline item test IDs match the renderer.
