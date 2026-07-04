import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../src/server.js';
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

  it('app.js calls the nas-dry-run endpoint', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();

    assert.ok(
      js.includes('nas-dry-run'),
      'app.js must reference the nas-dry-run endpoint',
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

  // ── V0.13 NAS dry-run Web panel HTML contract ────────────────────

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

  // ── V0.13 POST /api/nas-dry-run ──────────────────────────────────

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

  // ── V0.14 NAS app adapter dry-run API ────────────────────────────

  it('POST /api/nas-dry-run returns app adapter dry-run plans', async () => {
    const res = await fetch(`http://localhost:${port}/api/nas-dry-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'web-console-dry-run',
        nasTargets: [
          {
            name: 'synology_web',
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
            name: 'synology_web',
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

  // ── V0.16 Device list controls HTML/source contract ─────────────

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

  // ── V0.17 Backup jobs overview HTML/source contract ─────────────

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
    assert.ok(/不执行恢复/.test(panelMatch[0]), 'safety note must explicitly state no restore is performed');
    assert.ok(!/执行备份|创建备份|删除|编辑|重试|远程传输/i.test(panelMatch[0]), 'panel must not expose execution wording');
  });

  it('app.js wires backup job detail timeline into snapshot loading', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();

    assert.ok(js.includes('buildBackupJobTimeline'), 'app.js must reference buildBackupJobTimeline');
    assert.ok(js.includes('backup-job-detail-list'), 'app.js must reference backup-job-detail-list');
    assert.ok(js.includes('renderBackupJobDetail'), 'app.js must render backup job detail');
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

// ── V0.17 buildBackupJobOverview ────────────────────────────────────

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
    const mockFetch = async (url) => {
      if (url.includes('/retention-dry-run')) {
        return { ok: true, status: 200, json: async () => ({ keepCount: 0, wouldDeleteCount: 0, snapshots: [] }) };
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
    const mockFetch = async (url) => {
      if (url.includes('/retention-dry-run')) {
        return { ok: true, status: 200, json: async () => ({ keepCount: 0, wouldDeleteCount: 0, snapshots: [] }) };
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

  it('blocks NAS dry-run fetch when config JSON is empty', async () => {
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

    doc.getElementById('nas-dry-run-config').value = '   ';
    doc.getElementById('nas-dry-run-run')._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(!calls.some((url) => String(url).includes('/api/nas-dry-run')), 'must not call NAS dry-run API');
    assert.match(doc.getElementById('nas-dry-run-result').textContent, /不能为空/);
  });

  it('blocks NAS dry-run fetch when config JSON is invalid', async () => {
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

    doc.getElementById('nas-dry-run-config').value = '{ invalid json';
    doc.getElementById('nas-dry-run-run')._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(!calls.some((url) => String(url).includes('/api/nas-dry-run')), 'must not call NAS dry-run API');
    assert.match(doc.getElementById('nas-dry-run-result').textContent, /JSON 格式错误/);
  });

  it('calls NAS dry-run API and renders target/job counts and target details', async () => {
    const doc = buildMockDoc();
    const calls = [];
    const mockFetch = async (url, options) => {
      calls.push({ url, options });
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
          }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));

    doc.getElementById('nas-dry-run-config').value = JSON.stringify({
      deviceId: 'web-console-dry-run',
      nasTargets: [],
      backupJobs: [],
    });
    doc.getElementById('nas-dry-run-run')._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    const apiCall = calls.find((call) => String(call.url).includes('/api/nas-dry-run'));
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
    const doc = buildMockDoc();
    const mockFetch = async (url) => {
      if (String(url).includes('/api/nas-dry-run')) {
        return { ok: false, status: 400, json: async () => ({ error: 'nasTargets[].endpoint must be a valid URL' }) };
      }
      return { ok: true, status: 200, json: async () => [] };
    };
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));

    doc.getElementById('nas-dry-run-config').value = JSON.stringify({
      deviceId: 'web-console-dry-run',
      nasTargets: [],
      backupJobs: [],
    });
    doc.getElementById('nas-dry-run-run')._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.match(doc.getElementById('nas-dry-run-result').textContent, /endpoint must be a valid URL/);
  });

  it('renders NAS app adapter dry-run plan details', async () => {
    const doc = buildMockDoc();
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
      return { ok: true, status: 200, json: async () => [] };
    };
    const noopInterval = () => 0;

    initConsole(doc, fetchImpl, noopInterval);
    await new Promise((r) => setTimeout(r, 20));

    doc.getElementById('nas-dry-run-config').value = JSON.stringify({
      deviceId: 'web-console-dry-run',
      nasTargets: [],
      backupJobs: [],
    });
    doc.getElementById('nas-dry-run-run')._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    const text = doc.getElementById('nas-dry-run-result').textContent;
    assert.match(text, /synology-backup/);
    assert.match(text, /backup-plan/);
    assert.match(text, /wouldInvokeApp:false|不调用/);
    assert.match(text, /prepare-app-request/);
    assert.match(text, /未配置应用适配器/);
  });

  it('search and status filter update device list and filter count', async () => {
    const doc = buildMockDoc();
    const devices = [
      { deviceId: 'mac-1', hostname: 'Aaron-Mac', status: 'online', ipAddress: '10.0.0.20', snapshotCount: 2, lastHeartbeatAt: '2026-07-04T10:00:00Z' },
      { deviceId: 'ipad-2', hostname: 'Design-iPad', status: 'offline', ipAddress: '10.0.0.5', snapshotCount: 8, lastHeartbeatAt: '2026-07-04T09:00:00Z' },
      { deviceId: 'phone-3', hostname: 'TestPhone', status: '', ipAddress: '192.168.31.9', snapshotCount: 0, lastHeartbeatAt: '' },
    ];
    const mockFetch = async (url) => ({ ok: true, status: 200, json: async () => (url.includes('/snapshots') ? [] : devices) });
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 30));

    // Initial load: all 3 devices visible, count shows "3 / 3"
    const countEl = doc.querySelector('[data-testid="device-filter-count"]') || doc.getElementById('device-filter-count');
    assert.ok(countEl, 'device-filter-count element must exist');
    assert.strictEqual(countEl.textContent, '3 / 3', 'initial count must show all 3 devices');

    // Search for "ipad" → only 1 device visible
    const searchInput = doc.getElementById('device-search');
    assert.ok(searchInput, 'device-search input must exist');
    searchInput.value = 'ipad';
    assert.ok(searchInput._listeners.input || searchInput._listeners.change, 'search input must have input/change listener');
    if (searchInput._listeners.input) searchInput._listeners.input();
    else searchInput._listeners.change();
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(countEl.textContent, '1 / 3', 'count must show 1 / 3 after iPad search');
    const deviceListEl = doc.getElementById('device-list');
    assert.ok(deviceListEl, 'device-list must exist');
    const visibleItems = deviceListEl.children.filter((c) => c.className && c.className.includes('device-item'));
    assert.strictEqual(visibleItems.length, 1, 'only 1 device item visible after iPad search');
    assert.match(visibleItems[0].textContent, /ipad|iPad/i, 'visible device must be the iPad');

    // Switch to status=unknown, clear search → only phone-3 visible
    searchInput.value = '';
    if (searchInput._listeners.input) searchInput._listeners.input();
    else searchInput._listeners.change();
    await new Promise((r) => setTimeout(r, 20));

    const statusFilter = doc.getElementById('device-status-filter');
    assert.ok(statusFilter, 'device-status-filter must exist');
    statusFilter.value = 'unknown';
    assert.ok(statusFilter._listeners.input || statusFilter._listeners.change, 'status filter must have input/change listener');
    if (statusFilter._listeners.change) statusFilter._listeners.change();
    else statusFilter._listeners.input();
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(countEl.textContent, '1 / 3', 'count must show 1 / 3 for unknown status');
    const unknownItems = deviceListEl.children.filter((c) => c.className && c.className.includes('device-item'));
    assert.strictEqual(unknownItems.length, 1, 'only 1 device item visible for unknown status');
    assert.match(unknownItems[0].textContent, /phone-3|TestPhone/, 'visible device must be the unknown-status phone');
  });

  // ── V0.17 Backup jobs overview DOM interaction ──────────────────

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

  it('clears stale backup-jobs overview immediately when switching to a device with pending snapshots', async () => {
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

    // Deferred promise for device B's snapshots — stays pending until resolved manually
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
          // Hang until we explicitly resolve
          const data = await snapshotsBPromise;
          return { ok: true, status: 200, json: async () => data };
        }
      }
      return { ok: true, status: 200, json: async () => devices };
    };
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));

    // Click device A — snapshots resolve immediately
    const deviceItems = doc._created.filter((el) => el.className && el.className.includes('device-item'));
    assert.ok(deviceItems.length >= 2, 'must have at least 2 device items');
    deviceItems[0]._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    // Verify backup-jobs shows device A data
    assert.strictEqual(doc.getElementById('backup-jobs-device-name').textContent, '— dev-A');
    assert.strictEqual(doc.getElementById('backup-jobs-total-count').textContent, '1');
    const overviewTextA = doc.getElementById('backup-jobs-list').textContent;
    assert.match(overviewTextA, /alpha-job/);

    // Click device B — snapshots request is still pending
    deviceItems[1]._listeners.click();
    // Do NOT await — check immediately (synchronously after microtask)
    await new Promise((r) => setTimeout(r, 0));

    // Backup-jobs must NOT show stale data from device A
    assert.strictEqual(doc.getElementById('backup-jobs-device-name').textContent, '— dev-B');
    assert.strictEqual(doc.getElementById('backup-jobs-total-count').textContent, '0');
    assert.strictEqual(doc.getElementById('backup-jobs-snapshot-count').textContent, '0');
    const overviewTextB = doc.getElementById('backup-jobs-list').textContent;
    assert.doesNotMatch(overviewTextB, /alpha-job/, 'must not contain stale job name from device A');
    assert.doesNotMatch(overviewTextB, /\/alpha\/data/, 'must not contain stale source path from device A');

    // Clean up: resolve the pending promise so the test can finish
    resolveSnapshotsB([]);
    await new Promise((r) => setTimeout(r, 20));
  });

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

  it('clears stale backup job detail and shows 加载失败 when snapshot fetch fails for the new device', async () => {
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

    const mockFetch = async (url) => {
      if (url.includes('/retention-dry-run')) {
        return { ok: true, status: 200, json: async () => ({ keepCount: 0, wouldDeleteCount: 0, snapshots: [] }) };
      }
      if (url.includes('/snapshots')) {
        if (url.includes('dev-A')) {
          return { ok: true, status: 200, json: async () => snapshotsA };
        }
        if (url.includes('dev-B')) {
          return { ok: false, status: 500, json: async () => ({ error: 'Internal Server Error' }) };
        }
      }
      return { ok: true, status: 200, json: async () => devices };
    };
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));

    // Click device A — snapshots resolve immediately
    const deviceItems = doc._created.filter((el) => el.className && el.className.includes('device-item'));
    assert.ok(deviceItems.length >= 2, 'must have at least 2 device items');
    deviceItems[0]._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    // Click alpha-job to populate backup-job-detail with A's data
    const alphaJob = doc._created.find((el) => el.className && el.className.includes('backup-job-item') && /alpha-job/.test(el.textContent));
    assert.ok(alphaJob, 'alpha job item must exist');
    alphaJob._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    // Verify backup-job-detail shows device A's alpha-job data
    assert.match(doc.getElementById('backup-job-detail-list').textContent, /alpha-job|aaaaaaaa|\/alpha\/data/);

    // Click device B — /snapshots returns ok:false → triggers catch
    deviceItems[1]._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    // backup-job-detail must show device B's placeholder with 加载失败
    assert.strictEqual(doc.getElementById('backup-job-detail-device-name').textContent, '— dev-B');
    assert.strictEqual(doc.getElementById('backup-job-detail-title').textContent, '未选择');
    assert.strictEqual(doc.getElementById('backup-job-detail-count').textContent, '0');
    assert.strictEqual(doc.getElementById('backup-job-detail-latest').textContent, '无备份');

    const detailTextB = doc.getElementById('backup-job-detail-list').textContent;
    assert.ok(detailTextB.includes('加载失败'), 'detail list must show 加载失败');
    assert.doesNotMatch(detailTextB, /alpha-job/, 'must not contain stale job name from device A');
    assert.doesNotMatch(detailTextB, /aaaaaaaa/, 'must not contain stale snapshot ID from device A');
    assert.doesNotMatch(detailTextB, /\/alpha\/data/, 'must not contain stale source path from device A');
  });
});

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
