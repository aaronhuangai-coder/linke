# Backup Jobs Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Backup Jobs Overview panel to the Linke Web Console, derived from existing snapshot metadata for the selected device.

**Architecture:** Implement a pure aggregation helper in `src/web/app.js`, then render a new panel from the existing `/api/devices/:deviceId/snapshots` response. Keep the backend unchanged and use stable DOM hooks for contract and interaction tests.

**Tech Stack:** Browser ESM, vanilla HTML/CSS/JS, Node built-in `node:test`, existing Linke HTTP server.

## Global Constraints

- Only modify `src/web/app.js`, `src/web/index.html`, `src/web/styles.css`, `test/web-console.test.js`, `test/readme.test.js`, `README.md`, and the V0.17 docs.
- Do not add dependencies.
- Do not add API routes.
- Do not change storage format.
- Do not call write endpoints from the new panel.
- Do not connect to NAS or invoke NAS apps.
- Do not add backup execution, restore, delete, edit, retry, schedule, or remote-transfer controls.
- Keep all UI copy Chinese.
- Use TDD: write failing tests before production code.
- Do not commit or push; PM/user controls git hard gates.

---

## File Structure

- `src/web/app.js`: pure `buildBackupJobOverview(snapshots)` helper and DOM rendering in `initConsole`.
- `src/web/index.html`: static Backup Jobs Overview panel with required hooks and read-only safety note.
- `src/web/styles.css`: compact overview stats and job-row styling.
- `test/web-console.test.js`: helper tests, HTML/source contract tests, and DOM click-rendering tests.
- `test/readme.test.js`: README version and feature coverage tests.
- `README.md`: V0.17 version table, feature list, Web Console section, safety boundary, and test coverage summary.

### Task 1: Pure Backup Job Aggregation

**Files:**
- Modify: `test/web-console.test.js`
- Modify: `src/web/app.js`

**Interfaces:**
- Produces: `buildBackupJobOverview(snapshots)`.
- Return shape:

```js
{
  jobCount: 2,
  snapshotCount: 3,
  latestBackupAt: '2026-07-04T12:00:00.000Z',
  jobs: [
    {
      key: 'job:documents',
      jobName: 'documents',
      sourcePath: '/Users/ah/Documents',
      snapshotCount: 2,
      latestSnapshotId: '22222222-2222-2222-2222-222222222222',
      latestCreatedAt: '2026-07-04T12:00:00.000Z',
      latestFileCount: 7
    }
  ]
}
```

- [ ] **Step 1: Write failing tests**

Add `buildBackupJobOverview` to the import list in `test/web-console.test.js`.

Add this test block near the existing pure-helper tests:

```js
describe('buildBackupJobOverview', () => {
  it('groups snapshots by jobName and sorts jobs by latest backup first', () => {
    const result = buildBackupJobOverview([
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
    ]);

    assert.strictEqual(result.jobCount, 2);
    assert.strictEqual(result.snapshotCount, 3);
    assert.strictEqual(result.latestBackupAt, '2026-07-04T12:00:00.000Z');
    assert.deepStrictEqual(result.jobs.map((job) => job.jobName), ['photos', 'documents']);
    assert.strictEqual(result.jobs[1].snapshotCount, 2);
    assert.strictEqual(result.jobs[1].latestSnapshotId, '33333333-3333-3333-3333-333333333333');
    assert.strictEqual(result.jobs[1].latestFileCount, 7);
  });

  it('groups unnamed snapshots by sourcePath with stable fallbacks', () => {
    const result = buildBackupJobOverview([
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
    ]);

    assert.strictEqual(result.jobCount, 2);
    assert.strictEqual(result.snapshotCount, 3);
    assert.strictEqual(result.jobs[0].jobName, '未命名任务');
    assert.strictEqual(result.jobs[0].sourcePath, '/Users/ah/Desktop');
    assert.strictEqual(result.jobs[0].snapshotCount, 2);
    assert.strictEqual(result.jobs[0].latestFileCount, 3);
    assert.strictEqual(result.jobs[1].sourcePath, 'unknown');
    assert.doesNotMatch(JSON.stringify(result), /undefined|null|Invalid Date/);
  });

  it('returns an empty overview for an empty snapshot list', () => {
    const result = buildBackupJobOverview([]);

    assert.deepStrictEqual(result, {
      jobCount: 0,
      snapshotCount: 0,
      latestBackupAt: null,
      jobs: [],
    });
  });
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- test/web-console.test.js
```

Expected: fail because `buildBackupJobOverview` is not exported.

- [ ] **Step 3: Implement minimal helper**

Add this helper near the existing pure functions in `src/web/app.js`:

```js
function normalizeBackupJobName(value) {
  const name = String(value || '').trim();
  return name || '未命名任务';
}

function normalizeSourcePath(value) {
  const sourcePath = String(value || '').trim();
  return sourcePath || 'unknown';
}

function getSnapshotCreatedAtTime(snapshot) {
  const value = Date.parse(snapshot?.createdAt || '');
  return Number.isFinite(value) ? value : 0;
}

function getSnapshotFileCount(snapshot) {
  return Number.isFinite(snapshot?.fileCount) ? snapshot.fileCount : 0;
}

export function buildBackupJobOverview(snapshots) {
  const safeSnapshots = Array.isArray(snapshots) ? snapshots : [];
  const groups = new Map();
  let latestBackupAt = null;
  let latestBackupTime = 0;

  for (const snapshot of safeSnapshots) {
    const rawJobName = String(snapshot?.jobName || '').trim();
    const sourcePath = normalizeSourcePath(snapshot?.sourcePath);
    const key = rawJobName ? 'job:' + rawJobName : 'source:' + sourcePath;
    const createdAtTime = getSnapshotCreatedAtTime(snapshot);

    if (createdAtTime > latestBackupTime) {
      latestBackupAt = snapshot.createdAt;
      latestBackupTime = createdAtTime;
    }

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        jobName: normalizeBackupJobName(rawJobName),
        sourcePath,
        snapshotCount: 0,
        latestSnapshotId: null,
        latestCreatedAt: null,
        latestFileCount: 0,
        latestTime: 0,
      });
    }

    const group = groups.get(key);
    group.snapshotCount += 1;

    if (createdAtTime >= group.latestTime) {
      group.sourcePath = sourcePath;
      group.latestSnapshotId = snapshot?.snapshotId || null;
      group.latestCreatedAt = snapshot?.createdAt || null;
      group.latestFileCount = getSnapshotFileCount(snapshot);
      group.latestTime = createdAtTime;
    }
  }

  const jobs = [...groups.values()]
    .sort((a, b) => b.latestTime - a.latestTime || a.jobName.localeCompare(b.jobName))
    .map(({ latestTime, ...job }) => job);

  return {
    jobCount: jobs.length,
    snapshotCount: safeSnapshots.length,
    latestBackupAt,
    jobs,
  };
}
```

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm test -- test/web-console.test.js
```

Expected: tests pass.

### Task 2: Panel Markup, Rendering, And Interaction

**Files:**
- Modify: `test/web-console.test.js`
- Modify: `src/web/index.html`
- Modify: `src/web/app.js`
- Modify: `src/web/styles.css`

**Interfaces:**
- Consumes: `buildBackupJobOverview(snapshots)`.
- Produces DOM hooks listed in the spec.
- Extends existing `fetchSnapshots(deviceId)` success and failure paths.

- [ ] **Step 1: Write failing HTML/source contract tests**

Add tests to the Web Console contract `describe` block:

```js
it('HTML contains V0.17 backup jobs overview panel hooks', async () => {
  const res = await fetch(`http://localhost:${port}/`);
  const html = await res.text();

  assert.ok(html.includes('data-testid="backup-jobs-panel"'), 'must have backup-jobs-panel');
  assert.ok(html.includes('data-testid="backup-jobs-device-name"'), 'must have backup-jobs-device-name');
  assert.ok(html.includes('data-testid="backup-jobs-total-count"'), 'must have backup-jobs-total-count');
  assert.ok(html.includes('data-testid="backup-jobs-snapshot-count"'), 'must have backup-jobs-snapshot-count');
  assert.ok(html.includes('data-testid="backup-jobs-last-backup"'), 'must have backup-jobs-last-backup');
  assert.ok(html.includes('data-testid="backup-jobs-list"'), 'must have backup-jobs-list');
  assert.ok(html.includes('data-testid="backup-jobs-safety-note"'), 'must have backup-jobs-safety-note');
});

it('backup jobs overview panel is read-only and has no execution button', async () => {
  const res = await fetch(`http://localhost:${port}/`);
  const html = await res.text();
  const panelMatch = html.match(/data-testid="backup-jobs-panel"[\s\S]*?<\/section>/);

  assert.ok(panelMatch, 'backup-jobs-panel section must exist');
  assert.ok(!panelMatch[0].includes('<button'), 'backup jobs panel must not contain action buttons');
  assert.ok(/只读|概览|不触发|不创建|不连接 NAS/.test(panelMatch[0]), 'panel must communicate read-only behavior');
  assert.ok(!/执行备份|创建备份|删除|编辑|重试|远程传输/i.test(panelMatch[0]), 'panel must not expose execution wording');
});

it('app.js wires backup jobs overview into snapshot loading', async () => {
  const res = await fetch(`http://localhost:${port}/app.js`);
  const js = await res.text();

  assert.ok(js.includes('buildBackupJobOverview'), 'app.js must reference buildBackupJobOverview');
  assert.ok(js.includes('backup-jobs-list'), 'app.js must reference backup-jobs-list');
  assert.ok(js.includes('renderBackupJobsOverview'), 'app.js must render backup jobs overview');
});
```

- [ ] **Step 2: Write failing DOM interaction test**

Add this test near the existing `initConsole DOM data-testid hooks` tests:

```js
it('renders backup jobs overview when a device is clicked', async () => {
  const doc = buildMockDoc();
  const devices = [
    {
      deviceId: 'd4',
      hostname: 'host-four',
      status: 'online',
      ipAddress: '10.0.0.4',
      snapshotCount: 2,
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
      jobName: 'documents',
      sourcePath: '/Users/ah/Documents',
      createdAt: '2026-07-04T12:00:00.000Z',
      fileCount: 8,
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

  assert.strictEqual(doc.getElementById('backup-jobs-total-count').textContent, '1');
  assert.strictEqual(doc.getElementById('backup-jobs-snapshot-count').textContent, '2');
  const overviewText = doc.getElementById('backup-jobs-list').textContent;
  assert.match(overviewText, /documents/);
  assert.match(overviewText, /\/Users\/ah\/Documents/);
  assert.match(overviewText, /2 快照/);
  assert.match(overviewText, /8 files/);
  assert.doesNotMatch(overviewText, /undefined|null|Invalid Date/);
});
```

- [ ] **Step 3: Verify RED**

Run:

```bash
npm test -- test/web-console.test.js
```

Expected: fail because the panel hooks and renderer do not exist.

- [ ] **Step 4: Implement panel markup**

Add this section after the existing snapshots panel in `src/web/index.html`:

```html
      <section class="panel backup-jobs-panel" data-testid="backup-jobs-panel">
        <h2>备份任务概览 <span id="backup-jobs-device-name" class="device-name" data-testid="backup-jobs-device-name"></span></h2>
        <div class="backup-jobs-stats">
          <div class="backup-jobs-stat">
            <span id="backup-jobs-total-count" data-testid="backup-jobs-total-count">0</span>
            <span>任务数</span>
          </div>
          <div class="backup-jobs-stat">
            <span id="backup-jobs-snapshot-count" data-testid="backup-jobs-snapshot-count">0</span>
            <span>快照数</span>
          </div>
          <div class="backup-jobs-stat">
            <span id="backup-jobs-last-backup" data-testid="backup-jobs-last-backup">无备份</span>
            <span>最近备份</span>
          </div>
        </div>
        <ul id="backup-jobs-list" data-testid="backup-jobs-list">
          <li class="placeholder">请选择一个设备</li>
        </ul>
        <div class="backup-jobs-safety-note" data-testid="backup-jobs-safety-note">
          <p>备份任务概览为只读派生视图，只读取现有 snapshot 元数据，不触发备份、不创建快照、不写入元数据、不连接 NAS。</p>
        </div>
      </section>
```

- [ ] **Step 5: Implement renderer**

In `initConsole`, add element references:

```js
  const backupJobsDeviceName = doc.getElementById('backup-jobs-device-name');
  const backupJobsTotalCountEl = doc.getElementById('backup-jobs-total-count');
  const backupJobsSnapshotCountEl = doc.getElementById('backup-jobs-snapshot-count');
  const backupJobsLastBackupEl = doc.getElementById('backup-jobs-last-backup');
  const backupJobsListEl = doc.getElementById('backup-jobs-list');
```

Add helper functions:

```js
  function setBackupJobsCounts(jobCount, snapshotCount, latestBackupAt) {
    if (backupJobsTotalCountEl) backupJobsTotalCountEl.textContent = String(jobCount);
    if (backupJobsSnapshotCountEl) backupJobsSnapshotCountEl.textContent = String(snapshotCount);
    if (backupJobsLastBackupEl) backupJobsLastBackupEl.textContent = formatLastBackup(latestBackupAt);
  }

  function setBackupJobsPlaceholder(message) {
    clearElement(backupJobsListEl);
    setBackupJobsCounts(0, 0, null);
    if (!backupJobsListEl) return;
    const item = doc.createElement('li');
    item.className = 'placeholder';
    item.textContent = message;
    backupJobsListEl.appendChild(item);
  }

  function renderBackupJobsOverview(snapshots, deviceId) {
    if (!backupJobsListEl) return;
    if (backupJobsDeviceName) backupJobsDeviceName.textContent = '— ' + deviceId;

    const overview = buildBackupJobOverview(snapshots);
    setBackupJobsCounts(overview.jobCount, overview.snapshotCount, overview.latestBackupAt);
    clearElement(backupJobsListEl);

    if (overview.jobs.length === 0) {
      const item = doc.createElement('li');
      item.className = 'placeholder';
      item.textContent = '暂无备份任务';
      backupJobsListEl.appendChild(item);
      return;
    }

    overview.jobs.forEach(function (job) {
      const item = doc.createElement('li');
      item.className = 'backup-job-item';
      item.setAttribute('data-testid', 'backup-job-item');

      const name = doc.createElement('span');
      name.className = 'backup-job-name';
      name.setAttribute('data-testid', 'backup-job-name');
      name.textContent = job.jobName;

      const source = doc.createElement('span');
      source.className = 'backup-job-source';
      source.setAttribute('data-testid', 'backup-job-source');
      source.textContent = job.sourcePath;

      const meta = doc.createElement('span');
      meta.className = 'backup-job-meta';
      meta.setAttribute('data-testid', 'backup-job-meta');
      meta.textContent = String(job.snapshotCount) + ' 快照 · 最近 '
        + formatLastBackup(job.latestCreatedAt) + ' · '
        + String(job.latestFileCount || 0) + ' files';

      item.appendChild(name);
      item.appendChild(source);
      item.appendChild(meta);
      backupJobsListEl.appendChild(item);
    });
  }
```

Update `fetchSnapshots(deviceId)` success path:

```js
      renderSnapshots(snapshots, deviceId);
      renderBackupJobsOverview(snapshots, deviceId);
      renderSnapshotDiffControls(snapshots, deviceId);
```

Update `fetchSnapshots(deviceId)` failure path:

```js
      setBackupJobsPlaceholder('加载失败');
```

- [ ] **Step 6: Add CSS**

Add to `src/web/styles.css` near the snapshot styles:

```css
.backup-jobs-panel {
  grid-column: 2 / 4;
  max-height: 420px;
}

.backup-jobs-stats {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
}

.backup-jobs-stat {
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

.backup-jobs-stat span:first-child {
  font-size: 1.05rem;
  font-weight: 700;
  color: #222;
  overflow-wrap: anywhere;
}

.backup-job-item {
  padding: 9px 10px;
  border: 1px solid #eee;
  border-radius: 6px;
  margin-bottom: 6px;
  display: grid;
  gap: 3px;
}

.backup-job-name {
  font-weight: 700;
  font-size: 0.86rem;
  color: #222;
}

.backup-job-source,
.backup-job-meta {
  font-size: 0.76rem;
  color: #6b7280;
  overflow-wrap: anywhere;
}

.backup-job-source {
  font-family: "SFMono-Regular", Consolas, monospace;
}

.backup-jobs-safety-note {
  margin-top: 10px;
  color: #6b7280;
  font-size: 0.78rem;
}
```

- [ ] **Step 7: Verify GREEN**

Run:

```bash
npm test -- test/web-console.test.js
```

Expected: tests pass.

### Task 3: README And Documentation Tests

**Files:**
- Modify: `test/readme.test.js`
- Modify: `README.md`

**Interfaces:**
- README current version becomes V0.17.
- README documents Backup Jobs Overview as frontend-only and read-only.

- [ ] **Step 1: Write failing README tests**

Add to `test/readme.test.js` version coverage:

```js
  it('mentions V0.17 (backup jobs overview)', () => {
    assertReadmeContains(/V0\.17/, 'V0.17');
  });
```

Add to Web Console README coverage:

```js
  it('documents the Web Console backup jobs overview panel', () => {
    assertReadmeContains(
      /备份任务概览[\s\S]*jobName[\s\S]*sourcePath[\s\S]*快照数|backup jobs overview[\s\S]*jobName[\s\S]*sourcePath[\s\S]*snapshot/i,
      'Web Console backup jobs overview panel',
    );
  });
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- test/readme.test.js
```

Expected: fail because README still says V0.16 and does not document the new panel.

- [ ] **Step 3: Update README**

Update README:

- Title: `# Linke V0.17`
- Current version note: `当前版本：V0.17`
- Version table: add `V0.17 | 当前版本 | Web Console 新增只读备份任务概览面板，从现有 snapshot 元数据按 jobName/sourcePath 聚合任务视图`
- Feature list: add backup jobs overview.
- Web Console feature list: include `备份任务概览`.
- Add section:

```md
### Web Console 备份任务概览

V0.17 在 Web Console 中增加只读备份任务概览面板。选中设备后，控制台复用现有 `/api/devices/:deviceId/snapshots` 响应，从 snapshot 元数据推导备份任务：

- 优先按 `jobName` 聚合
- 缺失 `jobName` 时按 `sourcePath` 聚合
- 展示任务数、快照总数、最近备份时间
- 每个任务展示任务名、源路径、快照数、最近备份时间和最近文件数

该面板只读展示历史快照中可确认存在的任务，不新增 API 路由、不写入 metadata、不触发备份、不创建快照、不连接 NAS、不调用 NAS app、不执行远程传输。尚未执行过、没有历史 snapshot 的配置任务不会出现在 V0.17 概览中。
```

- Test coverage summary: include `备份任务概览面板`.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm test -- test/readme.test.js
```

Expected: tests pass.

### Task 4: Full Verification

**Files:**
- Inspect only unless tests require a small fix.

**Interfaces:**
- Consumes all previous tasks.
- Produces PM-verifiable evidence.

- [ ] **Step 1: Run full tests**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 3: Inspect changed files**

Run:

```bash
git status --short
git diff -- src/web/app.js src/web/index.html src/web/styles.css test/web-console.test.js test/readme.test.js README.md
```

Expected: only V0.17 files and docs changed; no write endpoint, new backend route, credential file, or unrelated refactor.

- [ ] **Step 4: Report**

Write a report to `scratch/qwen-v017-backup-jobs-overview-report.md` with:

```text
角色：implementer
状态：DONE or DONE_WITH_CONCERNS
交接对象：PM
抗辩：
改动文件：
运行命令：
验证结果：
未验证内容：
风险：
```

Do not commit or push.
