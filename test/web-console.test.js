import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../src/server.js';
import {
  computeFleetSummary,
  formatLastHeartbeat,
  formatSnapshotJobName,
  formatSnapshotMeta,
  initConsole,
  parseBackupPreflightExcludePatterns,
} from '../src/web/app.js';

function postJSON(port, path, body) {
  return fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Web Console / API contract', () => {
  let server, dataDir, port;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'linke-web-'));
    server = createServer({ dataDir });
    await new Promise((r) => server.listen(0, r));
    port = server.address().port;

    // Seed a device so the API has data
    await postJSON(port, '/api/heartbeat', {
      deviceId: 'web-test-pc',
      hostname: 'WebTestPC',
      ipAddress: '10.0.0.1',
    });
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    await rm(dataDir, { recursive: true, force: true });
  });

  it('GET / returns HTML with required data-testid hooks', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('text/html'));

    const html = await res.text();
    assert.ok(html.includes('<!DOCTYPE html'), 'should be valid HTML');
    assert.ok(html.includes('data-testid="linke-app"'), 'must have linke-app');
    assert.ok(html.includes('data-testid="device-list"'), 'must have device-list');
    assert.ok(html.includes('data-testid="snapshot-list"'), 'must have snapshot-list');
    assert.ok(html.includes('data-testid="event-log"'), 'must have event-log');
  });

  it('GET /app.js returns JS that calls real /api/devices', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('javascript'));

    const js = await res.text();
    assert.ok(js.includes('/api/devices'), 'app.js must fetch /api/devices');
    // Should NOT contain hardcoded mock data
    assert.ok(!js.includes('mockDevice'), 'must not contain mock data');
  });

  it('GET /styles.css returns CSS', async () => {
    const res = await fetch(`http://localhost:${port}/styles.css`);
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('text/css'));
    const css = await res.text();
    assert.ok(css.length > 100, 'CSS should have real content');
  });

  it('GET /api/devices returns real data (not mock)', async () => {
    const res = await fetch(`http://localhost:${port}/api/devices`);
    assert.strictEqual(res.status, 200);
    const devices = await res.json();
    assert.ok(Array.isArray(devices));
    assert.ok(devices.length > 0, 'should have seeded device');
    const found = devices.find((d) => d.deviceId === 'web-test-pc');
    assert.ok(found, 'seeded device must appear');
    assert.strictEqual(found.hostname, 'WebTestPC');
  });

  it('GET /api/devices/:id/snapshots returns array for existing device', async () => {
    const res = await fetch(`http://localhost:${port}/api/devices/web-test-pc/snapshots`);
    assert.strictEqual(res.status, 200);
    const snaps = await res.json();
    assert.ok(Array.isArray(snaps));
  });

  it('GET /api/devices/:id/snapshots returns 404 for unknown device', async () => {
    const res = await fetch(`http://localhost:${port}/api/devices/nonexistent/snapshots`);
    assert.strictEqual(res.status, 404);
  });

  it('HTML references /app.js and /styles.css', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    assert.ok(html.includes('src="/app.js"'), 'HTML must reference app.js');
    assert.ok(html.includes('href="/styles.css"'), 'HTML must reference styles.css');
  });

  // ── V0.1 Agent config panel ───────────────────────────────────

  it('HTML contains agent-config-panel with required data-testid hooks', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.ok(html.includes('data-testid="agent-config-panel"'), 'must have agent-config-panel');
    assert.ok(html.includes('data-testid="agent-config-sample"'), 'must have agent-config-sample');
    assert.ok(html.includes('data-testid="launchd-dry-run-command"'), 'must have launchd-dry-run-command');
    assert.ok(html.includes('data-testid="agent-safety-note"'), 'must have agent-safety-note');
  });

  it('agent safety note mentions dry-run and no launchctl', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    // Extract the safety note section
    const safetyMatch = html.match(/data-testid="agent-safety-note"[^>]*>([\s\S]*?)<\/section>/);
    assert.ok(safetyMatch, 'safety note section must exist');
    const safetyText = safetyMatch[1];

    assert.ok(safetyText.includes('dry-run') || safetyText.includes('dry_run'), 'must mention dry-run');
    assert.ok(safetyText.includes('launchctl'), 'must mention launchctl');
    assert.ok(safetyText.includes('未安装'), 'must state not installed (in Chinese)');
  });

  it('agent config sample contains valid JSON structure hints', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    const sampleMatch = html.match(/data-testid="agent-config-sample"[^>]*>([\s\S]*?)<\/pre>/);
    assert.ok(sampleMatch, 'sample section must exist');
    const sampleText = sampleMatch[1];

    assert.ok(sampleText.includes('serverUrl'), 'sample must mention serverUrl');
    assert.ok(sampleText.includes('deviceId'), 'sample must mention deviceId');
    assert.ok(sampleText.includes('backupJobs'), 'sample must mention backupJobs');
    assert.ok(sampleText.includes('excludePatterns'), 'sample must mention excludePatterns');
    assert.ok(sampleText.includes('scheduleSeconds'), 'sample must mention scheduleSeconds');
  });

  it('launchd dry-run command shows the correct CLI invocation', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    const cmdMatch = html.match(/data-testid="launchd-dry-run-command"[^>]*>([\s\S]*?)<\/code>/);
    assert.ok(cmdMatch, 'dry-run command section must exist');
    const cmdText = cmdMatch[1];

    assert.ok(cmdText.includes('launchd-dry-run'), 'must mention launchd-dry-run command');
    assert.ok(cmdText.includes('--config'), 'must mention --config flag');
  });

  it('backup preflight dry-run command shows the correct CLI invocation', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    const cmdMatch = html.match(/data-testid="backup-preflight-dry-run-command"[^>]*>([\s\S]*?)<\/code>/);
    assert.ok(cmdMatch, 'backup-preflight-dry-run-command section must exist');
    const cmdText = cmdMatch[1];

    assert.ok(cmdText.includes('backup-preflight-dry-run'), 'must mention backup-preflight-dry-run command');
    assert.ok(cmdText.includes('--source'), 'must mention --source flag');
    assert.ok(cmdText.includes('--exclude'), 'must mention --exclude flag');
  });

  it('backup preflight safety note states no snapshot, no copy, and no metadata writes', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    const noteMatch = html.match(/data-testid="backup-preflight-command-safety-note"[^>]*>([\s\S]*?)<\/(?:div|section|p)>/);
    assert.ok(noteMatch, 'backup-preflight-command-safety-note must exist');
    const noteText = noteMatch[1];

    assert.ok(/dry-run|预检/.test(noteText), 'must mention dry-run/preflight');
    assert.ok(/不创建.*快照|不.*snapshot/.test(noteText), 'must state no snapshot is created');
    assert.ok(/不复制|no copy/i.test(noteText), 'must state no files are copied');
    assert.ok(/不写入|metadata/i.test(noteText), 'must state no metadata is written');
  });

  // ── V0.3 Fleet Summary ──────────────────────────────────────────

  it('HTML contains fleet-summary section with data-testid and child hooks', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.ok(html.includes('data-testid="fleet-summary"'), 'must have fleet-summary container');
    assert.ok(html.includes('data-testid="fleet-total"'), 'must have fleet-total hook');
    assert.ok(html.includes('data-testid="fleet-online"'), 'must have fleet-online hook');
    assert.ok(html.includes('data-testid="fleet-offline"'), 'must have fleet-offline hook');
    assert.ok(html.includes('data-testid="fleet-snapshots"'), 'must have fleet-snapshots hook');
  });

  // ── V0.7 Retention dry-run Web Console panel ─────────────────────

  it('HTML contains retention dry-run panel with required data-testid hooks', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.ok(html.includes('data-testid="retention-panel"'), 'must have retention-panel');
    assert.ok(html.includes('data-testid="retention-keep-last"'), 'must have retention-keep-last input');
    assert.ok(html.includes('data-testid="retention-keep-count"'), 'must have retention-keep-count');
    assert.ok(html.includes('data-testid="retention-delete-count"'), 'must have retention-delete-count');
    assert.ok(html.includes('data-testid="retention-plan-list"'), 'must have retention-plan-list');
    assert.ok(html.includes('data-testid="retention-safety-note"'), 'must have retention-safety-note');
  });

  it('retention dry-run panel is read-only and has no action button', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    const panelMatch = html.match(/data-testid="retention-panel"[\s\S]*?<\/section>/);

    assert.ok(panelMatch, 'retention-panel section must exist');
    assert.ok(!panelMatch[0].includes('<button'), 'retention panel must not contain action buttons');
    assert.ok(
      /dry-run|只读|预览/.test(panelMatch[0]),
      'retention panel must communicate dry-run/read-only behavior',
    );
  });

  // ── V0.8 Snapshot manifest detail panel ─────────────────────────

  it('HTML contains snapshot manifest detail panel with required data-testid hooks', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.ok(html.includes('data-testid="snapshot-detail-panel"'), 'must have snapshot-detail-panel');
    assert.ok(html.includes('data-testid="snapshot-detail-content"'), 'must have snapshot-detail-content');
    assert.ok(html.includes('data-testid="snapshot-detail-safety-note"'), 'must have snapshot-detail-safety-note');
  });

  it('snapshot manifest detail panel is read-only and has no action button', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    const panelMatch = html.match(/data-testid="snapshot-detail-panel"[\s\S]*?<\/section>/);

    assert.ok(panelMatch, 'snapshot-detail-panel section must exist');
    assert.ok(!panelMatch[0].includes('<button'), 'snapshot detail panel must not contain action buttons');
    assert.ok(
      /只读|查看|清单/.test(panelMatch[0]),
      'snapshot detail panel must communicate read-only manifest viewing',
    );
  });

  // ── V0.9 Snapshot diff dry-run panel ─────────────────────────────

  it('HTML contains snapshot diff dry-run panel with required data-testid hooks', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.ok(html.includes('data-testid="snapshot-diff-panel"'), 'must have snapshot-diff-panel');
    assert.ok(html.includes('data-testid="snapshot-diff-from"'), 'must have snapshot-diff-from');
    assert.ok(html.includes('data-testid="snapshot-diff-to"'), 'must have snapshot-diff-to');
    assert.ok(html.includes('data-testid="snapshot-diff-added-count"'), 'must have snapshot-diff-added-count');
    assert.ok(html.includes('data-testid="snapshot-diff-removed-count"'), 'must have snapshot-diff-removed-count');
    assert.ok(html.includes('data-testid="snapshot-diff-unchanged-count"'), 'must have snapshot-diff-unchanged-count');
    assert.ok(html.includes('data-testid="snapshot-diff-result"'), 'must have snapshot-diff-result');
    assert.ok(html.includes('data-testid="snapshot-diff-safety-note"'), 'must have snapshot-diff-safety-note');
  });

  it('snapshot diff dry-run panel is read-only and has no destructive button', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    const panelMatch = html.match(/data-testid="snapshot-diff-panel"[\s\S]*?<\/section>/);

    assert.ok(panelMatch, 'snapshot-diff-panel section must exist');
    assert.ok(!panelMatch[0].includes('<button'), 'snapshot diff panel must not contain action buttons');
    assert.ok(
      /dry-run|只读|差异/.test(panelMatch[0]),
      'snapshot diff panel must communicate read-only dry-run comparison',
    );
  });

  // ── V0.10 Restore dry-run panel ─────────────────────────────────

  it('HTML contains restore dry-run panel with required data-testid hooks', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.ok(html.includes('data-testid="restore-dry-run-panel"'), 'must have restore-dry-run-panel');
    assert.ok(html.includes('data-testid="restore-dry-run-target"'), 'must have restore-dry-run-target');
    assert.ok(html.includes('data-testid="restore-dry-run-create-count"'), 'must have restore-dry-run-create-count');
    assert.ok(html.includes('data-testid="restore-dry-run-overwrite-count"'), 'must have restore-dry-run-overwrite-count');
    assert.ok(html.includes('data-testid="restore-dry-run-result"'), 'must have restore-dry-run-result');
    assert.ok(html.includes('data-testid="restore-dry-run-safety-note"'), 'must have restore-dry-run-safety-note');
  });

  it('restore dry-run panel is read-only and has no restore execution button', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    const panelMatch = html.match(/data-testid="restore-dry-run-panel"[\s\S]*?<\/section>/);

    assert.ok(panelMatch, 'restore-dry-run-panel section must exist');
    assert.ok(!panelMatch[0].includes('<button'), 'restore dry-run panel must not contain action buttons');
    assert.ok(
      /dry-run|只读|预检|不复制|不覆盖|不写入/.test(panelMatch[0]),
      'restore dry-run panel must communicate read-only preview behavior',
    );
  });

  // ── V0.12 Backup preflight dry-run Web Console panel ─────────────

  it('HTML contains backup preflight dry-run panel with required data-testid hooks', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.ok(html.includes('data-testid="backup-preflight-panel"'), 'must have backup-preflight-panel');
    assert.ok(html.includes('data-testid="backup-preflight-source"'), 'must have backup-preflight-source input');
    assert.ok(html.includes('data-testid="backup-preflight-excludes"'), 'must have backup-preflight-excludes textarea');
    assert.ok(html.includes('data-testid="backup-preflight-run"'), 'must have backup-preflight-run button');
    assert.ok(html.includes('data-testid="backup-preflight-total-count"'), 'must have backup-preflight-total-count');
    assert.ok(html.includes('data-testid="backup-preflight-included-count"'), 'must have backup-preflight-included-count');
    assert.ok(html.includes('data-testid="backup-preflight-excluded-count"'), 'must have backup-preflight-excluded-count');
    assert.ok(html.includes('data-testid="backup-preflight-result"'), 'must have backup-preflight-result');
    assert.ok(html.includes('data-testid="backup-preflight-safety-note"'), 'must have backup-preflight-safety-note');
  });

  it('backup preflight safety note testids are unique by purpose', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    const panelNoteMatches = html.match(/data-testid="backup-preflight-safety-note"/g) || [];
    const commandNoteMatches = html.match(/data-testid="backup-preflight-command-safety-note"/g) || [];

    assert.strictEqual(panelNoteMatches.length, 1, 'panel backup-preflight-safety-note must be unique');
    assert.strictEqual(commandNoteMatches.length, 1, 'command safety note must use its own unique hook');
  });

  it('backup preflight Web panel is dry-run only and has no real backup execution control', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    const panelMatch = html.match(/data-testid="backup-preflight-panel"[\s\S]*?<\/section>/);

    assert.ok(panelMatch, 'backup-preflight-panel section must exist');
    assert.ok(/dry-run|预检|只读/.test(panelMatch[0]), 'panel must communicate dry-run/read-only behavior');
    assert.ok(/不创建.*快照|不.*snapshot/.test(panelMatch[0]), 'panel must state no snapshot is created');
    assert.ok(/不复制|no copy/i.test(panelMatch[0]), 'panel must state no files are copied');
    assert.ok(/不写入|metadata/i.test(panelMatch[0]), 'panel must state no metadata is written');
    assert.ok(!/创建备份|执行备份|real backup|run backup/i.test(panelMatch[0]), 'panel must not expose real backup execution wording');
  });

  // ── V0.3 app.js rendering hooks ─────────────────────────────────

  it('app.js contains fleet summary rendering logic', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();

    assert.ok(
      js.includes('fleet-total') || js.includes('fleetTotal'),
      'app.js must reference fleet-total or fleetTotal',
    );
    assert.ok(
      js.includes('fleet-online') || js.includes('fleetOnline') || js.includes('fleet-online'),
      'app.js must reference fleet-online',
    );
    assert.ok(
      js.includes('fleet-snapshots') || js.includes('fleetSnapshots'),
      'app.js must reference fleet-snapshots',
    );
  });

  it('app.js calls the retention-dry-run endpoint', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();

    assert.ok(
      js.includes('retention-dry-run'),
      'app.js must reference the retention-dry-run endpoint',
    );
  });

  it('app.js calls the snapshot manifest endpoint', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();

    assert.ok(
      js.includes('/manifest'),
      'app.js must reference the snapshot manifest endpoint',
    );
  });

  it('app.js calls the snapshot diff dry-run endpoint', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();

    assert.ok(
      js.includes('diff-dry-run'),
      'app.js must reference the snapshot diff dry-run endpoint',
    );
  });

  it('app.js calls the restore-dry-run endpoint', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();

    assert.ok(
      js.includes('restore-dry-run'),
      'app.js must reference the restore-dry-run endpoint',
    );
  });

  it('app.js renders status badge as distinct element in device items', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();

    assert.ok(
      js.includes('status-badge') || js.includes('statusBadge'),
      'app.js must create status-badge element',
    );
  });

  it('app.js renders device last heartbeat info', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();

    assert.ok(
      js.includes('lastHeartbeat') || js.includes('last-heartbeat'),
      'app.js must reference lastHeartbeat',
    );
  });

  it('app.js renders jobName in snapshot items', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();

    assert.ok(js.includes('jobName'), 'app.js must reference jobName for snapshots');
  });

  it('app.js renders snapshotCount in device items', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();

    assert.ok(
      js.includes('snapshotCount') || js.includes('snapshot-count'),
      'app.js must reference snapshotCount for devices',
    );
  });

  // ── V0.4 NAS Provider Dry-Run ───────────────────────────────────

  it('HTML contains nas-config-sample with data-testid', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.ok(
      html.includes('data-testid="nas-config-sample"'),
      'must have nas-config-sample testid',
    );
  });

  it('NAS config sample mentions synology and ugreen providers', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    const nasMatch = html.match(/data-testid="nas-config-sample"[^>]*>([\s\S]*?)<\/pre>/);
    assert.ok(nasMatch, 'nas-config-sample section must exist');
    const nasText = nasMatch[1];

    assert.ok(nasText.includes('synology'), 'must mention synology provider');
    assert.ok(nasText.includes('ugreen'), 'must mention ugreen provider');
  });

  it('NAS config sample includes nasTargets array structure', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    const nasMatch = html.match(/data-testid="nas-config-sample"[^>]*>([\s\S]*?)<\/pre>/);
    assert.ok(nasMatch, 'nas-config-sample section must exist');
    const nasText = nasMatch[1];

    assert.ok(nasText.includes('nasTargets'), 'must mention nasTargets');
    assert.ok(nasText.includes('provider'), 'must mention provider');
    assert.ok(nasText.includes('endpoint'), 'must mention endpoint');
    assert.ok(nasText.includes('shareName'), 'must mention shareName');
    assert.ok(nasText.includes('remotePath'), 'must mention remotePath');
  });

  it('NAS safety note mentions dry-run and no network connection', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    // Find NAS safety note
    const nasSafetyMatch = html.match(/data-testid="nas-safety-note"[^>]*>([\s\S]*?)<\/(?:div|section|p)>/);
    assert.ok(nasSafetyMatch, 'nas-safety-note must exist');
    const safetyText = nasSafetyMatch[1];

    assert.ok(safetyText.includes('dry-run'), 'must mention dry-run');
    assert.ok(
      safetyText.includes('不连接') || safetyText.includes('不会连接') || safetyText.includes('不发起'),
      'must state no connection is made',
    );
  });
});

// ── V0.3.1 Pure-function logic tests (TDD RED → GREEN) ─────────────

describe('computeFleetSummary', () => {
  it('computes total/online/offline/totalSnapshots for 3 devices', () => {
    const devices = [
      { deviceId: 'a', status: 'online', snapshotCount: 5 },
      { deviceId: 'b', status: 'offline', snapshotCount: 3 },
      { deviceId: 'c', status: 'online', snapshotCount: 2 },
    ];
    const result = computeFleetSummary(devices);
    assert.strictEqual(result.total, 3);
    assert.strictEqual(result.online, 2);
    assert.strictEqual(result.offline, 1);
    assert.strictEqual(result.totalSnapshots, 10);
  });

  it('treats unknown status as offline', () => {
    const devices = [
      { deviceId: 'x', status: 'unknown', snapshotCount: 1 },
    ];
    const result = computeFleetSummary(devices);
    assert.strictEqual(result.offline, 1);
    assert.strictEqual(result.online, 0);
  });

  it('handles missing snapshotCount as 0', () => {
    const devices = [
      { deviceId: 'y', status: 'online' },
    ];
    const result = computeFleetSummary(devices);
    assert.strictEqual(result.totalSnapshots, 0);
  });

  it('returns zeros for empty array', () => {
    const result = computeFleetSummary([]);
    assert.strictEqual(result.total, 0);
    assert.strictEqual(result.online, 0);
    assert.strictEqual(result.offline, 0);
    assert.strictEqual(result.totalSnapshots, 0);
  });
});

describe('formatLastHeartbeat', () => {
  it('returns "无心跳" for null', () => {
    assert.strictEqual(formatLastHeartbeat(null), '无心跳');
  });

  it('returns "无心跳" for undefined', () => {
    assert.strictEqual(formatLastHeartbeat(undefined), '无心跳');
  });

  it('returns "无心跳" for empty string', () => {
    assert.strictEqual(formatLastHeartbeat(''), '无心跳');
  });

  it('returns a locale string for valid ISO date', () => {
    const result = formatLastHeartbeat('2025-01-15T10:30:00Z');
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
    assert.notStrictEqual(result, '无心跳');
  });

  it('returns "无心跳" for invalid date string like "not-a-date"', () => {
    const result = formatLastHeartbeat('not-a-date');
    assert.strictEqual(result, '无心跳');
  });

  it('does not produce "Invalid Date" for any input', () => {
    const badInputs = ['not-a-date', 'abc', '2025-13-40', 'NaN', 'undefined'];
    for (const input of badInputs) {
      const result = formatLastHeartbeat(input);
      assert.ok(!result.includes('Invalid Date'), `got "Invalid Date" for input: ${input}`);
    }
  });
});

describe('formatSnapshotJobName', () => {
  it('returns "未命名任务" when jobName is missing', () => {
    assert.strictEqual(formatSnapshotJobName({}), '未命名任务');
  });

  it('returns "未命名任务" when jobName is null', () => {
    assert.strictEqual(formatSnapshotJobName({ jobName: null }), '未命名任务');
  });

  it('returns "未命名任务" when jobName is empty string', () => {
    assert.strictEqual(formatSnapshotJobName({ jobName: '' }), '未命名任务');
  });

  it('returns actual jobName when present', () => {
    assert.strictEqual(formatSnapshotJobName({ jobName: 'daily-backup' }), 'daily-backup');
  });
});

describe('formatSnapshotMeta', () => {
  it('includes file count in output', () => {
    const result = formatSnapshotMeta({ createdAt: '2025-01-15T10:30:00Z', fileCount: 42 });
    assert.ok(result.includes('42'), `expected meta to include file count, got: ${result}`);
    assert.ok(result.includes('files'), `expected meta to include "files", got: ${result}`);
  });

  it('shows 0 files when fileCount is missing', () => {
    const result = formatSnapshotMeta({ createdAt: '2025-01-15T10:30:00Z' });
    assert.ok(result.includes('0'), `expected 0 files, got: ${result}`);
  });

  it('includes a date representation when createdAt exists', () => {
    const result = formatSnapshotMeta({ createdAt: '2025-01-15T10:30:00Z', fileCount: 5 });
    // Should contain some date representation (locale-dependent)
    assert.ok(result.length > 10, 'meta should contain date + file info');
    assert.ok(result.includes('5'));
  });

  it('handles missing createdAt gracefully', () => {
    const result = formatSnapshotMeta({ fileCount: 3 });
    assert.ok(result.includes('3'));
    assert.ok(result.includes('unknown'), `expected "unknown" date, got: ${result}`);
  });

  it('shows "unknown" fallback for invalid createdAt like "not-a-date"', () => {
    const result = formatSnapshotMeta({ createdAt: 'not-a-date', fileCount: 3 });
    assert.ok(result.includes('unknown'), `expected "unknown" for invalid date, got: ${result}`);
    assert.ok(!result.includes('Invalid Date'), `must not contain "Invalid Date", got: ${result}`);
    assert.ok(result.includes('3'), `must still include fileCount, got: ${result}`);
  });

  it('does not produce "Invalid Date" for any createdAt input', () => {
    const badDates = ['not-a-date', 'abc', 'NaN', '', '2025-13-40'];
    for (const d of badDates) {
      const result = formatSnapshotMeta({ createdAt: d, fileCount: 1 });
      assert.ok(!result.includes('Invalid Date'), `got "Invalid Date" for createdAt: ${d}`);
    }
  });
});

describe('parseBackupPreflightExcludePatterns', () => {
  it('splits newline and comma separated patterns, trims whitespace, and drops empty entries', () => {
    const result = parseBackupPreflightExcludePatterns(' *.tmp, node_modules\n\n.DS_Store ');
    assert.deepStrictEqual(result, ['*.tmp', 'node_modules', '.DS_Store']);
  });

  it('returns an empty array for empty input', () => {
    assert.deepStrictEqual(parseBackupPreflightExcludePatterns('   \n , '), []);
  });
});

describe('initConsole', () => {
  it('is exported as a function', () => {
    assert.strictEqual(typeof initConsole, 'function');
  });

  it('calls fetchImpl during init to load devices', async () => {
    const calls = [];
    const mockFetch = async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => [],
      };
    };
    let setIntervalCalled = false;
    const mockInterval = (_fn, _ms) => {
      setIntervalCalled = true;
      return 0;
    };

    // Minimal DOM stub
    const elements = {};
    const mockDoc = {
      getElementById: (id) => {
        if (!elements[id]) {
          elements[id] = { textContent: '', innerHTML: '', prepend: () => {}, className: '' };
        }
        return elements[id];
      },
      querySelector: (sel) => {
        if (!elements[sel]) {
          elements[sel] = { textContent: '' };
        }
        return elements[sel];
      },
      createElement: (tag) => ({
        tagName: tag,
        className: '',
        textContent: '',
        children: [],
        appendChild(child) { this.children.push(child); },
        addEventListener() {},
        setAttribute() {},
        prepend() {},
      }),
    };

    initConsole(mockDoc, mockFetch, mockInterval);
    // Allow microtask for async fetchDevices
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(calls.some((u) => u.includes('/api/devices')), 'should fetch /api/devices');
    assert.ok(setIntervalCalled, 'should set up auto-refresh interval');
  });
});

// ── V0.3.1 DOM data-testid hooks (TDD RED → GREEN) ────────────────

function buildMockDoc() {
  const elements = {};
  const createdElements = [];

  function getOrCreate(id) {
    if (!elements[id]) {
      elements[id] = {
        textContent: '',
        innerHTML: '',
        value: '',
        prepend: () => {},
        className: '',
        dataset: {},
        children: [],
        _attrs: {},
        _listeners: {},
        appendChild(c) {
          this.children.push(c);
          if (c.textContent) this.textContent += c.textContent;
        },
        addEventListener(type, fn) { this._listeners[type] = fn; },
        setAttribute(k, v) { this._attrs[k] = v; this[k] = v; },
      };
    }
    return elements[id];
  }

  const doc = {
    _created: createdElements,
    getElementById: (id) => getOrCreate(id),
    querySelector: (sel) => getOrCreate(sel),
    createElement: (tag) => {
      const el = {
        tagName: tag,
        className: '',
        textContent: '',
        dataset: {},
        children: [],
        _attrs: {},
        _listeners: {},
        appendChild(child) {
          this.children.push(child);
          if (child.textContent) this.textContent += child.textContent;
        },
        addEventListener(type, fn) { this._listeners[type] = fn; },
        setAttribute(k, v) { this._attrs[k] = v; },
        prepend() {},
      };
      createdElements.push(el);
      return el;
    },
  };
  return doc;
}

describe('initConsole DOM data-testid hooks', () => {
  it('sets data-testid="device-status" on status badge', async () => {
    const doc = buildMockDoc();
    const devices = [{ deviceId: 'd1', hostname: 'h1', status: 'online', ipAddress: '1.2.3.4', snapshotCount: 0, lastHeartbeatAt: '2025-01-15T10:00:00Z' }];
    const mockFetch = async (url) => ({ ok: true, status: 200, json: async () => (url.includes('/snapshots') ? [] : devices) });
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));

    const badge = doc._created.find((el) => el.className && el.className.includes('status-badge'));
    assert.ok(badge, 'status-badge element must be created');
    assert.strictEqual(badge._attrs['data-testid'], 'device-status');
  });

  it('sets data-testid="device-heartbeat" on device meta element', async () => {
    const doc = buildMockDoc();
    const devices = [{ deviceId: 'd1', hostname: 'h1', status: 'online', ipAddress: '1.2.3.4', snapshotCount: 0, lastHeartbeatAt: '2025-01-15T10:00:00Z' }];
    const mockFetch = async (url) => ({ ok: true, status: 200, json: async () => (url.includes('/snapshots') ? [] : devices) });
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));

    const meta = doc._created.find((el) => el.className && el.className.includes('device-meta'));
    assert.ok(meta, 'device-meta element must be created');
    assert.strictEqual(meta._attrs['data-testid'], 'device-heartbeat');
  });

  it('sets data-testid="snapshot-jobname" on job name element', async () => {
    const doc = buildMockDoc();
    const devices = [{ deviceId: 'd1', hostname: 'h1', status: 'online', ipAddress: '1.2.3.4', snapshotCount: 1, lastHeartbeatAt: '2025-01-15T10:00:00Z' }];
    const snapshots = [{ snapshotId: 'abcdef12-3456', jobName: 'backup-daily', createdAt: '2025-01-15T10:00:00Z', fileCount: 5 }];
    const mockFetch = async (url) => ({ ok: true, status: 200, json: async () => (url.includes('/snapshots') ? snapshots : devices) });
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));

    // Click the device item to trigger snapshot loading
    const deviceItem = doc._created.find((el) => el.className && el.className.includes('device-item'));
    assert.ok(deviceItem, 'device-item must exist');
    assert.ok(deviceItem._listeners.click, 'device-item must have click handler');
    deviceItem._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    const jobEl = doc._created.find((el) => el.className && el.className.includes('snapshot-job'));
    assert.ok(jobEl, 'snapshot-job element must be created');
    assert.strictEqual(jobEl._attrs['data-testid'], 'snapshot-jobname');
  });

  it('sets data-testid="snapshot-files" on snapshot meta element', async () => {
    const doc = buildMockDoc();
    const devices = [{ deviceId: 'd1', hostname: 'h1', status: 'online', ipAddress: '1.2.3.4', snapshotCount: 1, lastHeartbeatAt: '2025-01-15T10:00:00Z' }];
    const snapshots = [{ snapshotId: 'abcdef12-3456', jobName: 'backup-daily', createdAt: '2025-01-15T10:00:00Z', fileCount: 5 }];
    const mockFetch = async (url) => ({ ok: true, status: 200, json: async () => (url.includes('/snapshots') ? snapshots : devices) });
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));

    // Click the device item to trigger snapshot loading
    const deviceItem = doc._created.find((el) => el.className && el.className.includes('device-item'));
    assert.ok(deviceItem, 'device-item must exist');
    assert.ok(deviceItem._listeners.click, 'device-item must have click handler');
    deviceItem._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    const metaEl = doc._created.find((el) => el.className && el.className.includes('snapshot-meta'));
    assert.ok(metaEl, 'snapshot-meta element must be created');
    assert.strictEqual(metaEl._attrs['data-testid'], 'snapshot-files');
  });

  it('appends snapshot-job and snapshot-meta as children of snapshot-info container', async () => {
    const doc = buildMockDoc();
    const devices = [{ deviceId: 'd1', hostname: 'h1', status: 'online', ipAddress: '1.2.3.4', snapshotCount: 1, lastHeartbeatAt: '2025-01-15T10:00:00Z' }];
    const snapshots = [{ snapshotId: 'abcdef12-3456', jobName: 'backup-daily', createdAt: '2025-01-15T10:00:00Z', fileCount: 5 }];
    const mockFetch = async (url) => ({ ok: true, status: 200, json: async () => (url.includes('/snapshots') ? snapshots : devices) });
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));

    // Click the device item to trigger snapshot loading
    const deviceItem = doc._created.find((el) => el.className && el.className.includes('device-item'));
    assert.ok(deviceItem, 'device-item must exist');
    deviceItem._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    // Find the snapshot-info container
    const infoEl = doc._created.find((el) => el.className === 'snapshot-info');
    assert.ok(infoEl, 'snapshot-info container must exist');

    // Assert snapshot-job is a child of snapshot-info with correct textContent
    const jobChild = infoEl.children.find((child) => child.className === 'snapshot-job');
    assert.ok(jobChild, 'snapshot-info must contain snapshot-job as child');
    assert.strictEqual(jobChild.textContent, 'backup-daily', 'snapshot-job textContent must be backup-daily');

    // Assert snapshot-meta is a child of snapshot-info with textContent containing '5 files'
    const metaChild = infoEl.children.find((child) => child.className === 'snapshot-meta');
    assert.ok(metaChild, 'snapshot-info must contain snapshot-meta as child');
    assert.ok(metaChild.textContent.includes('5 files'), `snapshot-meta textContent must include '5 files', got: ${metaChild.textContent}`);
  });

  it('fetches and renders retention dry-run when selecting a device', async () => {
    const doc = buildMockDoc();
    const calls = [];
    const devices = [{ deviceId: 'd1', hostname: 'h1', status: 'online', ipAddress: '1.2.3.4', snapshotCount: 3, lastHeartbeatAt: '2025-01-15T10:00:00Z' }];
    const snapshots = [{ snapshotId: 'abcdef12-3456', jobName: 'backup-daily', createdAt: '2025-01-15T10:00:00Z', fileCount: 5 }];
    const retentionPlan = {
      keepCount: 2,
      wouldDeleteCount: 1,
      snapshots: [
        { snapshotId: 'keep-1111', jobName: 'daily', createdAt: '2025-01-15T10:00:00Z', fileCount: 5, action: 'keep', reason: 'within-keep-last' },
        { snapshotId: 'drop-2222', jobName: 'weekly', createdAt: '2025-01-14T10:00:00Z', fileCount: 3, action: 'would-delete', reason: 'older-than-keep-last' },
      ],
    };
    const mockFetch = async (url) => {
      calls.push(url);
      if (url.includes('/retention-dry-run')) {
        return { ok: true, status: 200, json: async () => retentionPlan };
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

    assert.ok(
      calls.includes('/api/devices/d1/retention-dry-run?keepLast=3'),
      `must fetch retention dry-run with default keepLast=3, got calls: ${calls.join(', ')}`,
    );
    assert.strictEqual(doc.getElementById('retention-keep-count').textContent, '2');
    assert.strictEqual(doc.getElementById('retention-delete-count').textContent, '1');

    const retentionList = doc.getElementById('retention-plan-list');
    assert.strictEqual(retentionList.children.length, 2);
    assert.ok(
      retentionList.children.some((child) => child.textContent.includes('保留')),
      'retention list must render keep action',
    );
    assert.ok(
      retentionList.children.some((child) => child.textContent.includes('拟淘汰')),
      'retention list must render would-delete action',
    );
  });

  it('refetches retention dry-run when keepLast changes and blocks invalid values', async () => {
    const doc = buildMockDoc();
    const calls = [];
    const devices = [{ deviceId: 'd1', hostname: 'h1', status: 'online', ipAddress: '1.2.3.4', snapshotCount: 3, lastHeartbeatAt: '2025-01-15T10:00:00Z' }];
    const mockFetch = async (url) => {
      calls.push(url);
      if (url.includes('/retention-dry-run')) {
        return { ok: true, status: 200, json: async () => ({ keepCount: 1, wouldDeleteCount: 2, snapshots: [] }) };
      }
      return { ok: true, status: 200, json: async () => (url.includes('/snapshots') ? [] : devices) };
    };
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));

    const deviceItem = doc._created.find((el) => el.className && el.className.includes('device-item'));
    deviceItem._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    const input = doc.getElementById('retention-keep-last');
    assert.strictEqual(input.value, '3');
    assert.ok(input._listeners.change, 'retention keepLast input must have change listener');

    input.value = '5';
    input._listeners.change();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(
      calls.includes('/api/devices/d1/retention-dry-run?keepLast=5'),
      `must refetch with changed keepLast=5, got calls: ${calls.join(', ')}`,
    );

    const beforeInvalid = calls.filter((url) => url.includes('/retention-dry-run')).length;
    input.value = '0';
    input._listeners.change();
    await new Promise((r) => setTimeout(r, 20));
    const afterInvalid = calls.filter((url) => url.includes('/retention-dry-run')).length;
    assert.strictEqual(afterInvalid, beforeInvalid, 'invalid keepLast must not trigger retention fetch');
  });

  it('blocks backup preflight fetch when sourcePath is empty', async () => {
    const doc = buildMockDoc();
    const calls = [];
    const mockFetch = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => [] };
    };
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));
    calls.length = 0;

    doc.getElementById('backup-preflight-source').value = '   ';
    doc.getElementById('backup-preflight-run')._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(!calls.some((url) => String(url).includes('/api/backup-preflight-dry-run')), 'empty sourcePath must not call backup preflight API');
    assert.ok(doc.getElementById('backup-preflight-result').textContent.includes('请输入源路径'), 'must show sourcePath validation message');
  });

  it('calls backup preflight API with repeated exclude query parameters', async () => {
    const doc = buildMockDoc();
    const calls = [];
    const plan = {
      mode: 'dry-run',
      wouldWrite: false,
      sourcePath: '/tmp/source',
      excludePatterns: ['*.tmp', 'node_modules', '.DS_Store'],
      summary: { totalFiles: 3, includedCount: 1, excludedCount: 2 },
      included: ['keep.txt'],
      excluded: [
        { sourceRelativePath: 'skip.tmp', matchedPattern: '*.tmp' },
        { sourceRelativePath: 'node_modules/pkg.js', matchedPattern: 'node_modules' },
      ],
    };
    const mockFetch = async (url) => {
      calls.push(url);
      if (String(url).includes('/api/backup-preflight-dry-run')) {
        return { ok: true, status: 200, json: async () => plan };
      }
      return { ok: true, status: 200, json: async () => [] };
    };
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));
    calls.length = 0;

    doc.getElementById('backup-preflight-source').value = '/tmp/source';
    doc.getElementById('backup-preflight-excludes').value = '*.tmp, node_modules\n.DS_Store';
    doc.getElementById('backup-preflight-run')._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    const url = calls.find((entry) => String(entry).includes('/api/backup-preflight-dry-run'));
    assert.ok(url, 'must call backup preflight API');
    const params = new URLSearchParams(String(url).split('?')[1]);
    assert.strictEqual(params.get('sourcePath'), '/tmp/source');
    assert.deepStrictEqual(params.getAll('exclude'), ['*.tmp', 'node_modules', '.DS_Store']);
  });

  it('renders backup preflight counts, included paths, excluded paths, and matched patterns', async () => {
    const doc = buildMockDoc();
    const plan = {
      mode: 'dry-run',
      wouldWrite: false,
      sourcePath: '/tmp/source',
      excludePatterns: ['*.tmp'],
      summary: { totalFiles: 2, includedCount: 1, excludedCount: 1 },
      included: ['keep.txt'],
      excluded: [
        { sourceRelativePath: 'skip.tmp', matchedPattern: '*.tmp' },
      ],
    };
    const mockFetch = async (url) => {
      if (String(url).includes('/api/backup-preflight-dry-run')) {
        return { ok: true, status: 200, json: async () => plan };
      }
      return { ok: true, status: 200, json: async () => [] };
    };
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));

    doc.getElementById('backup-preflight-source').value = '/tmp/source';
    doc.getElementById('backup-preflight-excludes').value = '*.tmp';
    doc.getElementById('backup-preflight-run')._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(doc.getElementById('backup-preflight-total-count').textContent, '2');
    assert.strictEqual(doc.getElementById('backup-preflight-included-count').textContent, '1');
    assert.strictEqual(doc.getElementById('backup-preflight-excluded-count').textContent, '1');
    const resultText = doc.getElementById('backup-preflight-result').textContent;
    assert.ok(resultText.includes('keep.txt'), 'must render included path');
    assert.ok(resultText.includes('skip.tmp'), 'must render excluded path');
    assert.ok(resultText.includes('*.tmp'), 'must render matchedPattern');
  });

  it('renders backup preflight API errors', async () => {
    const doc = buildMockDoc();
    const mockFetch = async (url) => {
      if (String(url).includes('/api/backup-preflight-dry-run')) {
        return { ok: false, status: 400, json: async () => ({ error: 'Source path does not exist: /missing' }) };
      }
      return { ok: true, status: 200, json: async () => [] };
    };
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));

    doc.getElementById('backup-preflight-source').value = '/missing';
    doc.getElementById('backup-preflight-run')._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(
      doc.getElementById('backup-preflight-result').textContent.includes('Source path does not exist'),
      'must render API error message',
    );
  });

  it('fetches and renders snapshot manifest details when selecting a snapshot', async () => {
    const doc = buildMockDoc();
    const calls = [];
    const devices = [{ deviceId: 'd1', hostname: 'h1', status: 'online', ipAddress: '1.2.3.4', snapshotCount: 1, lastHeartbeatAt: '2025-01-15T10:00:00Z' }];
    const snapshots = [{ snapshotId: 'abcdef12-3456', jobName: 'backup-daily', createdAt: '2025-01-15T10:00:00Z', fileCount: 2 }];
    const manifest = {
      snapshotId: 'abcdef12-3456',
      deviceId: 'd1',
      createdAt: '2025-01-15T10:00:00Z',
      sourcePath: '/Users/ah/Documents',
      files: ['root.txt', 'sub/config.yaml'],
    };
    const mockFetch = async (url) => {
      calls.push(url);
      if (url.includes('/manifest')) {
        return { ok: true, status: 200, json: async () => manifest };
      }
      if (url.includes('/retention-dry-run')) {
        return { ok: true, status: 200, json: async () => ({ keepCount: 1, wouldDeleteCount: 0, snapshots: [] }) };
      }
      return { ok: true, status: 200, json: async () => (url.includes('/snapshots') ? snapshots : devices) };
    };
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));

    const deviceItem = doc._created.find((el) => el.className && el.className.includes('device-item'));
    deviceItem._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    const snapshotItem = doc._created.find((el) => el.className && el.className.includes('snapshot-item'));
    assert.ok(snapshotItem, 'snapshot-item must exist');
    assert.ok(snapshotItem._listeners.click, 'snapshot-item must have click handler');
    snapshotItem._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(
      calls.includes('/api/devices/d1/snapshots/abcdef12-3456/manifest'),
      `must fetch manifest endpoint, got calls: ${calls.join(', ')}`,
    );

    const detail = doc.getElementById('snapshot-detail-content');
    assert.ok(detail.textContent.includes('abcdef12-3456'), 'detail must render snapshotId');
    assert.ok(detail.textContent.includes('/Users/ah/Documents'), 'detail must render sourcePath');
    assert.ok(detail.textContent.includes('2 files'), 'detail must render file count');
    assert.ok(detail.textContent.includes('sub/config.yaml'), 'detail must render nested file path');

    const sourcePath = doc._created.find((el) => el._attrs['data-testid'] === 'manifest-source-path');
    assert.ok(sourcePath, 'manifest-source-path element must exist');
    assert.strictEqual(sourcePath.textContent, '/Users/ah/Documents');
  });

  it('renders manifest file names as text without injecting HTML', async () => {
    const doc = buildMockDoc();
    const devices = [{ deviceId: 'd1', hostname: 'h1', status: 'online', ipAddress: '1.2.3.4', snapshotCount: 1, lastHeartbeatAt: '2025-01-15T10:00:00Z' }];
    const snapshots = [{ snapshotId: 'abcdef12-3456', jobName: 'backup-daily', createdAt: '2025-01-15T10:00:00Z', fileCount: 1 }];
    const manifest = {
      snapshotId: 'abcdef12-3456',
      deviceId: 'd1',
      createdAt: '2025-01-15T10:00:00Z',
      sourcePath: '/tmp/source',
      files: ['\"><script>alert(1)</script>.txt'],
    };
    const mockFetch = async (url) => {
      if (url.includes('/manifest')) {
        return { ok: true, status: 200, json: async () => manifest };
      }
      if (url.includes('/retention-dry-run')) {
        return { ok: true, status: 200, json: async () => ({ keepCount: 1, wouldDeleteCount: 0, snapshots: [] }) };
      }
      return { ok: true, status: 200, json: async () => (url.includes('/snapshots') ? snapshots : devices) };
    };
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));

    const deviceItem = doc._created.find((el) => el.className && el.className.includes('device-item'));
    deviceItem._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    const snapshotItem = doc._created.find((el) => el.className && el.className.includes('snapshot-item'));
    snapshotItem._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    const detail = doc.getElementById('snapshot-detail-content');
    assert.ok(
      detail.textContent.includes('\"><script>alert(1)</script>.txt'),
      'malicious-looking file name must render as text',
    );
    assert.strictEqual(detail.innerHTML, '', 'manifest detail content must not use innerHTML for API fields');
  });

  it('fetches and renders snapshot diff dry-run when a device has two snapshots', async () => {
    const doc = buildMockDoc();
    const calls = [];
    const devices = [{ deviceId: 'd1', hostname: 'h1', status: 'online', ipAddress: '1.2.3.4', snapshotCount: 2, lastHeartbeatAt: '2025-01-15T10:00:00Z' }];
    const snapshots = [
      { snapshotId: 'from-1111', jobName: 'first', createdAt: '2025-01-15T10:00:00Z', fileCount: 2 },
      { snapshotId: 'to-2222', jobName: 'second', createdAt: '2025-01-16T10:00:00Z', fileCount: 2 },
    ];
    const diffPlan = {
      mode: 'dry-run',
      added: ['new.txt'],
      removed: ['old.txt'],
      unchanged: ['shared.txt'],
      summary: { addedCount: 1, removedCount: 1, unchangedCount: 1, comparedBy: 'manifest.files' },
    };
    const mockFetch = async (url) => {
      calls.push(url);
      if (url.includes('/diff-dry-run')) {
        return { ok: true, status: 200, json: async () => diffPlan };
      }
      if (url.includes('/retention-dry-run')) {
        return { ok: true, status: 200, json: async () => ({ keepCount: 2, wouldDeleteCount: 0, snapshots: [] }) };
      }
      return { ok: true, status: 200, json: async () => (url.includes('/snapshots') ? snapshots : devices) };
    };
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));

    const deviceItem = doc._created.find((el) => el.className && el.className.includes('device-item'));
    deviceItem._listeners.click();
    await new Promise((r) => setTimeout(r, 40));

    assert.ok(
      calls.includes('/api/devices/d1/snapshots/diff-dry-run?from=from-1111&to=to-2222'),
      `must fetch diff dry-run endpoint, got calls: ${calls.join(', ')}`,
    );
    assert.strictEqual(doc.getElementById('snapshot-diff-added-count').textContent, '1');
    assert.strictEqual(doc.getElementById('snapshot-diff-removed-count').textContent, '1');
    assert.strictEqual(doc.getElementById('snapshot-diff-unchanged-count').textContent, '1');

    const result = doc.getElementById('snapshot-diff-result');
    assert.ok(result.textContent.includes('new.txt'), 'diff result must render added file');
    assert.ok(result.textContent.includes('old.txt'), 'diff result must render removed file');
    assert.ok(result.textContent.includes('shared.txt'), 'diff result must render unchanged file');
  });

  it('fetches and renders restore dry-run when selecting a snapshot', async () => {
    const doc = buildMockDoc();
    const calls = [];
    const devices = [{ deviceId: 'd1', hostname: 'h1', status: 'online', ipAddress: '1.2.3.4', snapshotCount: 1, lastHeartbeatAt: '2025-01-15T10:00:00Z' }];
    const snapshots = [{ snapshotId: 'restore-1111', jobName: 'daily', createdAt: '2025-01-15T10:00:00Z', fileCount: 2 }];
    const manifest = {
      snapshotId: 'restore-1111',
      deviceId: 'd1',
      createdAt: '2025-01-15T10:00:00Z',
      sourcePath: '/tmp/source',
      files: ['alpha.txt', 'nested/beta.txt'],
    };
    const restorePlan = {
      mode: 'dry-run',
      wouldWrite: false,
      summary: { totalFiles: 2, wouldCreateCount: 1, wouldOverwriteCount: 1 },
      files: [
        { sourceRelativePath: 'alpha.txt', targetPath: '/tmp/restore/alpha.txt', action: 'would-overwrite' },
        { sourceRelativePath: 'nested/beta.txt', targetPath: '/tmp/restore/nested/beta.txt', action: 'would-create' },
      ],
    };
    const mockFetch = async (url) => {
      calls.push(url);
      if (url.includes('/restore-dry-run')) {
        return { ok: true, status: 200, json: async () => restorePlan };
      }
      if (url.includes('/manifest')) {
        return { ok: true, status: 200, json: async () => manifest };
      }
      if (url.includes('/retention-dry-run')) {
        return { ok: true, status: 200, json: async () => ({ keepCount: 1, wouldDeleteCount: 0, snapshots: [] }) };
      }
      return { ok: true, status: 200, json: async () => (url.includes('/snapshots') ? snapshots : devices) };
    };
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));

    const targetInput = doc.getElementById('restore-dry-run-target');
    targetInput.value = '/tmp/restore';

    const deviceItem = doc._created.find((el) => el.className && el.className.includes('device-item'));
    deviceItem._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    const snapshotItem = doc._created.find((el) => el.className && el.className.includes('snapshot-item'));
    snapshotItem._listeners.click();
    await new Promise((r) => setTimeout(r, 40));

    assert.ok(
      calls.includes('/api/devices/d1/snapshots/restore-1111/restore-dry-run?targetPath=%2Ftmp%2Frestore'),
      `must fetch restore dry-run endpoint, got calls: ${calls.join(', ')}`,
    );
    assert.strictEqual(doc.getElementById('restore-dry-run-create-count').textContent, '1');
    assert.strictEqual(doc.getElementById('restore-dry-run-overwrite-count').textContent, '1');

    const result = doc.getElementById('restore-dry-run-result');
    assert.ok(result.textContent.includes('alpha.txt'), 'restore plan must render overwrite file');
    assert.ok(result.textContent.includes('nested/beta.txt'), 'restore plan must render create file');
    assert.ok(result.textContent.includes('would-overwrite'), 'restore plan must render overwrite action');
    assert.ok(result.textContent.includes('would-create'), 'restore plan must render create action');
  });
});
