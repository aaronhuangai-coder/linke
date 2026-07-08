import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../src/server.js';
import { validateConfig } from '../src/config.js';
import { LINKE_RELEASE_VERSION } from '../src/version.js';
import {
  applyDeviceListControls,
  buildBackupJobOverview,
  buildBackupJobTimeline,
  buildBackupVersionConsistency,
  buildDeviceBackupHealth,
  compareDevicesForSort,
  computeFleetSummary,
  filterVersionConsistencyGroups,
  formatLastBackup,
  formatLastHeartbeat,
  formatSnapshotJobName,
  formatSnapshotMeta,
  getDeviceBackupHealthStatus,
  getDeviceManagementHint,
  buildDeviceEmptyFilterContext,
  isDeviceFilterResetActive,
  buildDeviceActiveFilterSummary,
  buildDeviceActiveFilterSummaryState,
  DEVICE_FILTER_SORT_LABELS,
  getDeviceManagementState,
  getDeviceManagementStateKey,
  buildApiFetchOptions,
  buildDeviceManagementSummary,
  buildDeviceManagementSummaryScope,
  initConsole,
  isApiRequestUrl,
  matchesDeviceSearch,
  normalizeDeviceStatus,
  parseBackupPreflightExcludePatterns,
  parseNasDryRunConfig,
  buildDeviceFilterCountState,
  buildReleaseHealthViewModel,
  buildGoldReadinessViewModel,
  buildAuditLogViewModel,
  buildSupervisorInstallDryRunViewModel,
  buildSupervisorLifecycleApprovalPersistencePreviewViewModel,
  buildSupervisorLifecycleApprovalPersistViewModel,
} from '../src/web/app.js';
import { buildSupervisorLifecycleApplyPlan } from '../src/supervisor-lifecycle.js';

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

  it('GET / returns HTML with device-filter-count element having data-filtered="false" and no aria-live', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    const countMatch = html.match(/<span[^>]+data-testid="device-filter-count"[^>]*>/);
    assert.ok(countMatch, 'device-filter-count element must exist in HTML');
    const tag = countMatch[0];
    assert.ok(tag.includes('data-filtered="false"'));
    assert.ok(tag.includes('data-visible-count="0"'));
    assert.ok(tag.includes('data-total-count="0"'));
    assert.ok(!tag.includes('aria-live'));
  });

  it('styles.css contains .device-filter-count[data-filtered="true"] but not bare [data-filtered="true"]', async () => {
    const res = await fetch(`http://localhost:${port}/styles.css`);
    const css = await res.text();
    assert.ok(css.includes('.device-filter-count[data-filtered="true"]'), 'styles.css must contain .device-filter-count[data-filtered="true"]');
    const barePattern = /(?<!\.device-filter-count)\[data-filtered\s*=\s*["']?true["']?\]/;
    assert.ok(!barePattern.test(css), 'styles.css must not contain a bare [data-filtered="true"] selector');
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
    assert.strictEqual(body.executionGate.remoteExecutionAllowed, false);
    assert.strictEqual(body.targets.length, 2);
    assert.strictEqual(body.jobs.length, 1);
    assert.strictEqual(body.targets[0].provider, 'synology');
    assert.strictEqual(body.targets[1].provider, 'ugreen');

    // Readiness fields
    assert.ok(body.readinessSummary);
    assert.strictEqual(body.readinessSummary.mode, 'dry-run');
    assert.strictEqual(body.readinessSummary.state, 'blocked');
    assert.strictEqual(body.readinessSummary.totalTargets, 2);
    assert.strictEqual(body.readinessSummary.enabledTargets, 1);
    assert.strictEqual(body.readinessSummary.disabledTargets, 1);
    assert.strictEqual(body.readinessSummary.credentialRefConfiguredTargets, 0);
    assert.strictEqual(body.readinessSummary.enabledCredentialRefMissingTargets, 1);
    assert.strictEqual(body.readinessSummary.blockedTargets, 2);
    assert.strictEqual(body.readinessSummary.remoteExecutionBlocked, true);
    assert.deepStrictEqual(body.readinessSummary.blockers.sort(), ['credential-ref-missing', 'remote-execution-blocked', 'target-disabled'].sort());

    assert.ok(body.targets[0].executionReadiness);
    assert.strictEqual(body.targets[0].executionReadiness.state, 'blocked');
    assert.deepStrictEqual(body.targets[0].executionReadiness.blockers.sort(), ['credential-ref-missing', 'remote-execution-blocked'].sort());

    assert.ok(body.targets[1].executionReadiness);
    assert.strictEqual(body.targets[1].executionReadiness.state, 'blocked');
    assert.deepStrictEqual(body.targets[1].executionReadiness.blockers.sort(), ['remote-execution-blocked', 'target-disabled'].sort());
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

  it('POST /api/nas-dry-run rejects new credential-like fields without echoing field values', async () => {
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
            connectionString: 'nas://user:secret-value@192.168.1.100/backup',
          },
        ],
        backupJobs: [{ name: 'documents', sourcePath: '/Users/ah/Documents' }],
      }),
    });
    const body = await res.json();
    const text = JSON.stringify(body);

    assert.strictEqual(res.status, 400);
    assert.match(body.error, /credential|not allowed|forbidden|connectionString/i);
    assert.ok(!text.includes('secret-value'), 'must not echo forbidden credential-like field values');
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

  // ── V0.84 POST /api/supervisor-install-dry-run ─────────────────

  it('POST /api/supervisor-install-dry-run returns a sanitized blocked dry-run supervisor install plan', async () => {
    const res = await fetch(`http://localhost:${port}/api/supervisor-install-dry-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverUrl: 'http://localhost:3000',
        deviceId: 'web-supervisor-dry-run',
        backupJobs: [{ name: 'documents', sourcePath: '/tmp/linke-documents' }],
        excludePatterns: ['*.tmp'],
        scheduleSeconds: 3600,
        nasTargets: [
          {
            name: 'synology-web',
            provider: 'synology',
            endpoint: 'http://192.168.1.100:5000',
            shareName: 'backup',
            remotePath: '/volume1/backup',
            enabled: true,
            credentialRef: 'nas-ref',
          },
        ],
      }),
    });
    const body = await res.json();
    const text = JSON.stringify(body);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.status, 'partial');
    assert.strictEqual(body.command, 'supervisor-install-dry-run');
    assert.strictEqual(body.supervisor.state, 'not_configured');
    assert.strictEqual(body.supervisor.wouldInstall, false);
    assert.strictEqual(body.supervisor.wouldStart, false);
    assert.strictEqual(body.safety.launchctlCalled, false);
    assert.strictEqual(body.safety.processListRead, false);
    assert.strictEqual(body.safety.launchdFileWritten, false);
    assert.strictEqual(body.safety.metadataWritten, false);
    assert.strictEqual(body.safety.nasConnected, false);
    assert.strictEqual(body.safety.backupTriggered, false);
    assert.strictEqual(body.safety.restoreTriggered, false);
    assert.strictEqual(body.safety.remoteCommandExecuted, false);
    assert.strictEqual(body.readinessSummary.state, 'blocked');
    assert.strictEqual(body.installCommandPreview.state, 'blocked');
    assert.ok(body.installCommandPreview.actions.every((action) => action.wouldRun === false));
    assert.ok(body.installCommandPreview.actions.every((action) => action.wouldWrite === false));
    assert.strictEqual(body.installPreflight.state, 'blocked');
    assert.strictEqual(body.installApprovalManifest.state, 'blocked');
    assert.strictEqual(body.installApprovalManifest.approval.approved, false);
    assert.strictEqual(body.installApprovalManifest.rollback.available, false);

    assert.ok(!text.includes('/tmp/linke-documents'), 'must not echo sourcePath');
    assert.ok(!text.includes('http://localhost:3000'), 'must not echo serverUrl');
    assert.ok(!text.includes('192.168.1.100'), 'must not echo NAS endpoint');
    assert.ok(!text.includes('nas-ref'), 'must not echo credentialRef');
  });

  it('POST /api/supervisor-install-dry-run rejects invalid JSON body', async () => {
    const res = await fetch(`http://localhost:${port}/api/supervisor-install-dry-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ invalid json',
    });
    const body = await res.json();

    assert.strictEqual(res.status, 400);
    assert.match(body.error, /Invalid JSON body/);
  });

  it('POST /api/supervisor-install-dry-run rejects invalid config without echoing submitted values', async () => {
    const res = await fetch(`http://localhost:${port}/api/supervisor-install-dry-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverUrl: 'not-a-url-secret-like-value',
        deviceId: 'web-supervisor-dry-run',
        backupJobs: [{ name: 'documents', sourcePath: '/tmp/linke-documents' }],
      }),
    });
    const body = await res.json();
    const text = JSON.stringify(body);

    assert.strictEqual(res.status, 400);
    assert.match(body.error, /serverUrl/i);
    assert.ok(!text.includes('not-a-url-secret-like-value'), 'must not echo invalid serverUrl value');
    assert.ok(!text.includes('/tmp/linke-documents'), 'must not echo sourcePath on validation errors');
  });

  it('POST /api/supervisor-install-dry-run rejects credential-like NAS fields without echoing secret values', async () => {
    const res = await fetch(`http://localhost:${port}/api/supervisor-install-dry-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverUrl: 'http://localhost:3000',
        deviceId: 'web-supervisor-dry-run',
        backupJobs: [{ name: 'documents', sourcePath: '/tmp/linke-documents' }],
        nasTargets: [
          {
            name: 'synology-web',
            provider: 'synology',
            endpoint: 'http://192.168.1.100:5000',
            shareName: 'backup',
            remotePath: '/volume1/backup',
            password: 'do-not-echo-this-secret',
          },
        ],
      }),
    });
    const body = await res.json();
    const text = JSON.stringify(body);

    assert.strictEqual(res.status, 400);
    assert.match(body.error, /credential|not allowed|forbidden|password/i);
    assert.ok(!text.includes('do-not-echo-this-secret'), 'must not echo submitted secret value');
    assert.ok(!text.includes('192.168.1.100'), 'must not echo NAS endpoint on validation errors');
  });

  // ── V0.92 POST /api/supervisor-lifecycle-approval-persistence-preview ──

  it('POST /api/supervisor-lifecycle-approval-persistence-preview returns sanitized blocked preview for valid approval', async () => {
    const config = {
      serverUrl: 'http://localhost:3000',
      deviceId: 'web-lifecycle-approval-preview',
      backupJobs: [{ name: 'documents', sourcePath: '/tmp/linke-documents' }],
    };
    const plan = buildSupervisorLifecycleApplyPlan(validateConfig(config), { operation: 'install' });
    const now = Date.now();
    const res = await postJSON(port, '/api/supervisor-lifecycle-approval-persistence-preview', {
      operation: 'install',
      config,
      approval: {
        operation: 'install',
        configHash: plan.configHash,
        planHash: plan.planHash,
        approved: true,
        schemaVersion: 1,
        approvedBy: 'operator@example.invalid',
        reason: 'V0.92 Web preview approval should not leak',
        acknowledgements: ['operator accepts Web preview only'],
        approvedAt: new Date(now - 5 * 60 * 1000).toISOString(),
        expiresAt: new Date(now + 30 * 60 * 1000).toISOString(),
      },
    });
    const body = await res.json();
    const text = JSON.stringify(body);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.command, 'supervisor-lifecycle-approval-persistence-preview');
    assert.strictEqual(body.operation, 'install');
    assert.strictEqual(body.state, 'blocked');
    assert.strictEqual(body.approvalValid, true);
    assert.deepStrictEqual(body.blockers, ['approval-persistence-store-missing']);
    assert.strictEqual(body.persistence.previewOnly, true);
    assert.strictEqual(body.persistence.wouldPersist, false);
    assert.strictEqual(body.persistence.validation.acknowledgementCount, 1);
    assert.strictEqual(body.safety.approvalPersisted, false);
    assert.ok(!text.includes('operator@example'), 'must not echo approval identity');
    assert.ok(!text.includes('Web preview approval'), 'must not echo approval reason');
    assert.ok(!text.includes('operator accepts'), 'must not echo acknowledgement content');
    assert.ok(!text.includes('sha256:'), 'must not echo hashes');
    assert.ok(!text.includes('/tmp/linke-documents'), 'must not echo sourcePath');
    assert.ok(!text.includes('localhost:3000'), 'must not echo serverUrl');
  });

  it('POST /api/supervisor-lifecycle-approval-persistence-preview returns safe blockers when approval is missing', async () => {
    const res = await postJSON(port, '/api/supervisor-lifecycle-approval-persistence-preview', {
      operation: 'rollback',
      config: {
        serverUrl: 'http://localhost:3000',
        deviceId: 'web-lifecycle-approval-preview',
        backupJobs: [{ name: 'documents', sourcePath: '/tmp/linke-documents' }],
      },
    });
    const body = await res.json();
    const text = JSON.stringify(body);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.approvalValid, false);
    assert.ok(body.blockers.includes('approval-missing-required-fields'));
    assert.ok(body.blockers.includes('approval-persistence-store-missing'));
    assert.strictEqual(body.persistence.validation.acknowledgementCount, 0);
    assert.ok(!text.includes('/tmp/linke-documents'), 'must not echo sourcePath');
    assert.ok(!text.includes('localhost:3000'), 'must not echo serverUrl');
  });

  it('POST /api/supervisor-lifecycle-approval-persistence-preview rejects invalid input without echoing submitted values', async () => {
    const invalidOperation = await postJSON(port, '/api/supervisor-lifecycle-approval-persistence-preview', {
      operation: 'restart',
      config: {
        serverUrl: 'http://localhost:3000',
        deviceId: 'web-lifecycle-approval-preview',
        backupJobs: [{ name: 'documents', sourcePath: '/tmp/linke-documents' }],
      },
    });
    const invalidOperationBody = await invalidOperation.json();
    assert.strictEqual(invalidOperation.status, 400);
    assert.match(invalidOperationBody.error, /operation must be one of/i);
    assert.doesNotMatch(JSON.stringify(invalidOperationBody), /linke-documents|localhost/);

    const invalidConfig = await postJSON(port, '/api/supervisor-lifecycle-approval-persistence-preview', {
      operation: 'install',
      config: {
        serverUrl: 'not-a-url-secret-like-value',
        deviceId: 'web-lifecycle-approval-preview',
        backupJobs: [{ name: 'documents', sourcePath: '/tmp/linke-documents' }],
      },
    });
    const invalidConfigBody = await invalidConfig.json();
    assert.strictEqual(invalidConfig.status, 400);
    assert.match(invalidConfigBody.error, /serverUrl/i);
    assert.doesNotMatch(JSON.stringify(invalidConfigBody), /not-a-url-secret-like-value|linke-documents/);
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
    assert.ok(js.includes('selectSnapshotForDetail'), 'app.js must share snapshot detail selection logic');
    assert.ok(js.includes('dataset.snapshotId'), 'timeline rows must store snapshot id for selection');
  });

  // ── V0.20 Event Log panel HTML contract ─────────────────────────

  it('HTML contains V0.20 Event Log panel with required data-testid hooks', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.ok(html.includes('data-testid="event-log-panel"'), 'must have event-log-panel');
    assert.ok(html.includes('data-testid="event-total-count"'), 'must have event-total-count');
    assert.ok(html.includes('data-testid="event-info-count"'), 'must have event-info-count');
    assert.ok(html.includes('data-testid="event-error-count"'), 'must have event-error-count');
    assert.ok(html.includes('data-testid="event-latest-message"'), 'must have event-latest-message');
    assert.ok(html.includes('data-testid="event-log-safety-note"'), 'must have event-log-safety-note');
  });

  it('V0.20 Event Log panel is read-only, has no button, and contains safety note', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    const panelMatch = html.match(/<section class="panel events-panel" data-testid="event-log-panel">([\s\S]*?)<\/section>/);

    assert.ok(panelMatch, 'event-log-panel section must exist');
    const content = panelMatch[0];
    assert.ok(!content.includes('<button'), 'event log panel must not contain any button');
    assert.ok(content.includes('前端内存'), 'must mention 前端内存');
    assert.ok(content.includes('只读'), 'must mention 只读');
    assert.ok(content.includes('不写入 metadata'), 'must mention 不写入 metadata');
    assert.ok(content.includes('不触发备份'), 'must mention 不触发备份');
    assert.ok(content.includes('不执行恢复'), 'must mention 不执行恢复');
    assert.ok(content.includes('不连接 NAS'), 'must mention 不连接 NAS');
  });

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

  // ── V0.22 Backup version consistency panel HTML contract ─────────

  it('HTML contains V0.22 backup version consistency panel with required data-testid hooks', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.ok(html.includes('data-testid="version-consistency-panel"'), 'must have version-consistency-panel');
    assert.ok(html.includes('data-testid="version-consistency-synced-count"'), 'must have version-consistency-synced-count');
    assert.ok(html.includes('data-testid="version-consistency-drifted-count"'), 'must have version-consistency-drifted-count');
    assert.ok(html.includes('data-testid="version-consistency-single-count"'), 'must have version-consistency-single-count');
    assert.ok(html.includes('data-testid="version-consistency-total-count"'), 'must have version-consistency-total-count');
    assert.ok(html.includes('data-testid="version-consistency-list"'), 'must have version-consistency-list');
    assert.ok(html.includes('data-testid="version-consistency-safety-note"'), 'must have version-consistency-safety-note');
  });

  it('V0.22 backup version consistency panel is read-only and has no execution controls', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    const panelMatch = html.match(/data-testid="version-consistency-panel"[\s\S]*?<\/section>/);

    assert.ok(panelMatch, 'version-consistency-panel section must exist');
    const content = panelMatch[0];
    assert.ok(!content.includes('<button'), 'version consistency panel must not contain buttons');
    assert.ok(/只读|派生视图/.test(content), 'must state read-only derived behavior');
    assert.ok(/不写入 metadata/.test(content), 'must state no metadata writes');
    assert.ok(/不触发备份/.test(content), 'must state no backup execution');
    assert.ok(/不执行同步/.test(content), 'must state no sync execution');
    assert.ok(/不执行恢复/.test(content), 'must state no restore execution');
    assert.ok(/不连接 NAS/.test(content), 'must state no NAS connection');
  });

  it('app.js wires V0.23 version consistency device rows to existing snapshot detail loaders', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();

    assert.ok(js.includes('selectVersionConsistencySnapshot'), 'app.js must expose a version consistency click path');
    assert.ok(js.includes('data-snapshot-id'), 'version device rows must expose snapshot id');
    assert.ok(js.includes('fetchSnapshotManifest'), 'click path must reuse manifest detail loader');
    assert.ok(js.includes('fetchRestoreDryRunPlan'), 'click path must reuse restore dry-run loader');
  });

  // ── V0.24 Version consistency controls HTML contract ────────────

  it('HTML contains V0.24 version consistency filter controls', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.ok(html.includes('data-testid="version-consistency-search"'), 'must have version-consistency-search');
    assert.ok(html.includes('data-testid="version-consistency-status-filter"'), 'must have version-consistency-status-filter');
    assert.ok(html.includes('data-testid="version-consistency-sort"'), 'must have version-consistency-sort');
    assert.ok(html.includes('data-testid="version-consistency-filter-count"'), 'must have version-consistency-filter-count');
    assert.ok(html.includes('value="drifted"'), 'status filter must include drifted option');
    assert.ok(html.includes('value="single-device"'), 'status filter must include single-device option');
    assert.ok(html.includes('value="synced"'), 'status filter must include synced option');
    assert.ok(html.includes('value="risk"'), 'sort must include risk option');
    assert.ok(html.includes('value="max-drift"'), 'sort must include max-drift option');
    assert.ok(html.includes('value="stale-count"'), 'sort must include stale-count option');
    assert.ok(html.includes('value="latest"'), 'sort must include latest option');
    assert.ok(html.includes('value="name"'), 'sort must include name option');
  });

  // ── V0.27 Version consistency coverage summary HTML contract ─────

  it('HTML contains V0.27 version consistency coverage summary hook', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    assert.ok(html.includes('data-testid="version-consistency-coverage-summary"'), 'must have version-consistency-coverage-summary');
  });

  // ── V0.28 版本一致性覆盖筛选 HTML 契约 ───────────────────────────

  it('HTML contains V0.28 version consistency coverage filter control', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    assert.ok(html.includes('data-testid="version-consistency-coverage-filter"'), 'must have version-consistency-coverage-filter');
    assert.ok(html.includes('value="all"'), 'coverage filter must include all option');
    assert.ok(html.includes('value="gap"'), 'coverage filter must include gap option');
    assert.ok(html.includes('value="full"'), 'coverage filter must include full option');
    assert.ok(html.includes('value="unobservable"'), 'coverage filter must include unobservable option');
  });

  // ── V0.29 版本一致性覆盖缺口排序 HTML 契约 ────────────────────────

  it('HTML contains V0.29 version consistency coverage gap sort option', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    assert.ok(html.includes('data-testid="version-consistency-sort"'), 'must have version-consistency-sort');
    assert.ok(html.includes('value="coverage-gap"'), 'sort must include coverage-gap option');
  });

  it('GET /app.js source contract expects device-management-state and device-detail-management-state hooks', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    assert.strictEqual(res.status, 200);
    const js = await res.text();
    assert.ok(js.includes('device-management-state'), 'app.js must reference device-management-state');
    assert.ok(js.includes('device-detail-management-state'), 'app.js must reference device-detail-management-state');
  });

  // ── V0.34 device-management-filter HTML/source contract ─────────────

  it('HTML contains V0.34 device management filter with required option values', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    assert.ok(html.includes('data-testid="device-management-filter"'), 'must have device-management-filter select');
    assert.ok(html.includes('value="all"'), 'management filter must include all option');
    assert.ok(html.includes('value="visible"'), 'management filter must include visible option');
    assert.ok(html.includes('value="missing-ip"'), 'management filter must include missing-ip option');
    assert.ok(html.includes('value="offline-retained"'), 'management filter must include offline-retained option');
    assert.ok(html.includes('value="unknown"'), 'management filter must include unknown option');
  });

  it('app.js source contract expects device-management-filter reference', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();
    assert.ok(js.includes('device-management-filter'), 'app.js must reference device-management-filter');
  });

  // ── V0.35 device-management-summary HTML/source contract ─────────────

  it('HTML contains V0.35 device management summary elements and bucket controls', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    assert.ok(html.includes('data-testid="device-management-summary"'), 'must have device-management-summary wrapper');
    assert.ok(html.includes('data-testid="device-management-summary-all"'), 'must have device-management-summary-all control');
    assert.ok(html.includes('data-testid="device-management-summary-visible"'), 'must have device-management-summary-visible control');
    assert.ok(html.includes('data-testid="device-management-summary-missing-ip"'), 'must have device-management-summary-missing-ip control');
    assert.ok(html.includes('data-testid="device-management-summary-offline-retained"'), 'must have device-management-summary-offline-retained control');
    assert.ok(html.includes('data-testid="device-management-summary-unknown"'), 'must have device-management-summary-unknown control');
  });

  it('app.js source contract expects device-management-summary and buildDeviceManagementSummary reference', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();
    assert.ok(js.includes('device-management-summary'), 'app.js must reference device-management-summary');
    assert.ok(js.includes('buildDeviceManagementSummary'), 'app.js must reference buildDeviceManagementSummary');
  });

  // ── V0.36 device-management-summary active accessible controls ─────

  it('HTML contains V0.36 accessible device management summary buttons', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    assert.ok(html.includes('<button type="button" data-testid="device-management-summary-all"'), 'all summary control must be a button');
    assert.ok(html.includes('<button type="button" data-testid="device-management-summary-visible"'), 'visible summary control must be a button');
    assert.ok(html.includes('data-management-filter-value="all"'), 'all summary button must declare filter value');
    assert.ok(html.includes('data-management-filter-value="visible"'), 'visible summary button must declare filter value');
    assert.ok(html.includes('aria-pressed="true"'), 'initial active summary button must expose aria-pressed');
  });

  it('app.js source contract expects active summary state rendering', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();
    assert.ok(js.includes('setDeviceManagementSummaryActive'), 'app.js must render active summary state');
    assert.ok(js.includes('aria-pressed'), 'app.js must update aria-pressed');
    assert.ok(js.includes('data-active'), 'app.js must update data-active');
  });

  // ── V0.38 device-management-hint source contract ─────────────────

  it('app.js source contract expects device management hint rendering', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();
    assert.ok(js.includes('getDeviceManagementHint'), 'app.js must expose getDeviceManagementHint');
    assert.ok(js.includes('device-management-hint'), 'app.js must render list management hint hook');
    assert.ok(js.includes('device-detail-management-hint'), 'app.js must render detail management hint hook');
  });

  // ── V0.39 device-empty-filter-context source contract ─────────────

  it('app.js source contract expects V0.39 empty filter context rendering', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();
    assert.ok(js.includes('buildDeviceEmptyFilterContext'), 'app.js must expose empty filter context builder');
    assert.ok(js.includes('device-empty-state'), 'app.js must render empty state hook');
    assert.ok(js.includes('device-empty-filter-context'), 'app.js must render empty filter context hook');
  });

  // ── V0.40 device-filter-reset HTML/source contract ─────────────

  it('HTML contains V0.40 device filter reset button', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    assert.ok(html.includes('data-testid="device-filter-reset"'), 'must have device-filter-reset button');
    assert.ok(html.includes('id="device-filter-reset"'), 'must have device-filter-reset id');
    assert.ok(html.includes('重置筛选'), 'device-filter-reset button must have visible reset text');
  });

  // ── V0.41 device-filter-reset state HTML/source contract ─────────

  it('HTML initializes V0.41 device filter reset as disabled and inactive', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    const buttonMatch = html.match(/<button[^>]+data-testid="device-filter-reset"[^>]*>/);
    assert.ok(buttonMatch, 'device-filter-reset button must exist');
    assert.ok(buttonMatch[0].includes('disabled'), 'device-filter-reset must start disabled');
    assert.ok(buttonMatch[0].includes('aria-disabled="true"'), 'device-filter-reset must start aria-disabled true');
    assert.ok(buttonMatch[0].includes('data-active="false"'), 'device-filter-reset must start data-active false');
  });

  it('app.js source contract expects device-filter-reset reference', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();
    assert.ok(js.includes('device-filter-reset'), 'app.js must reference device-filter-reset');
    assert.ok(js.includes('isDeviceFilterResetActive'), 'app.js must expose reset active helper');
    assert.ok(js.includes('syncDeviceFilterResetState'), 'app.js must sync reset button state');
  });

  // ── V0.42 device active filter summary HTML/source contract ─────────

  it('HTML contains V0.42 device active filter summary hooks', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('data-testid="device-active-filter-summary"'), 'must have device-active-filter-summary');
    assert.ok(html.includes('role="status"'), 'must have role="status"');
    assert.ok(html.includes('aria-live="polite"'), 'must have aria-live="polite"');
  });

  it('app.js source contract expects buildDeviceActiveFilterSummary and DEVICE_FILTER_SORT_LABELS', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    assert.strictEqual(res.status, 200);
    const js = await res.text();
    assert.ok(js.includes('buildDeviceActiveFilterSummary'), 'app.js must export buildDeviceActiveFilterSummary');
    assert.ok(js.includes('DEVICE_FILTER_SORT_LABELS'), 'app.js must contain DEVICE_FILTER_SORT_LABELS');
  });

  // ── V0.43 device active filter summary HTML/source contract ─────────

  it('HTML summary has correct initial attributes and no aria-label', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    const summaryMatch = html.match(/<div[^>]+data-testid="device-active-filter-summary"[^>]*>/);

    assert.ok(summaryMatch, 'device-active-filter-summary must exist');
    assert.ok(summaryMatch[0].includes('role="status"'), 'summary should have role="status"');
    assert.ok(summaryMatch[0].includes('aria-live="polite"'), 'summary should have aria-live="polite"');
    assert.ok(summaryMatch[0].includes('aria-atomic="true"'), 'summary should have aria-atomic="true"');
    assert.ok(summaryMatch[0].includes('data-active="false"'), 'summary should have data-active="false"');
    assert.ok(!summaryMatch[0].includes('aria-label='), 'summary should not have aria-label');
  });

  it('app.js exports buildDeviceActiveFilterSummaryState', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    assert.strictEqual(res.status, 200);
    const js = await res.text();
    assert.ok(js.includes('buildDeviceActiveFilterSummaryState'), 'app.js must export buildDeviceActiveFilterSummaryState');
  });

  it('styles.css contains .device-active-filter-summary[data-active="true"] and no bare [data-active="true"]', async () => {
    const res = await fetch(`http://localhost:${port}/styles.css`);
    assert.strictEqual(res.status, 200);
    const css = await res.text();

    assert.ok(css.includes('.device-active-filter-summary[data-active="true"]'), 'CSS must style the active summary explicitly');
    const bareActiveMatch = css.match(/(?:^|\}|\s)\[data-active=["']?true["']?\]/);
    assert.ok(!bareActiveMatch, 'styles.css must not contain a bare [data-active="true"] selector');
  });

  // ── V0.48 Release Health panel HTML/source contract ────────────────

  it('HTML contains V0.48 release health panel with required data-testid hooks and initial data-status="unknown"', async () => {
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

    assert.ok(html.includes('data-status="unknown"'), 'must have data-status="unknown" initially');
  });

  it('V0.48 release health panel safety note documents security boundaries and avoids prohibited words', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    const panelMatch = html.match(/data-testid="release-health-panel"[\s\S]*?<\/(?:section|div)>/);

    assert.ok(panelMatch, 'release-health-panel section/div must exist');
    const content = panelMatch[0];
    assert.ok(content.includes('只读'), 'must contain 只读');
    assert.ok(content.includes('GET /api/health'), 'must contain GET /api/health');
    assert.ok(/不写入\s*metadata|不写入\s*元数据/i.test(content), 'must contain 不写入 metadata');
    assert.ok(/不连接\s*NAS/i.test(content), 'must contain 不连接 NAS');
    assert.ok(content.includes('不执行远程命令'), 'must contain 不执行远程命令');

    assert.ok(!content.includes('执行备份'), 'must not contain 执行备份');
    assert.ok(!content.includes('创建备份'), 'must not contain 创建备份');
    assert.ok(!content.includes('执行恢复'), 'must not contain 执行恢复');
    assert.ok(!content.includes('删除快照'), 'must not contain 删除快照');
    assert.ok(!content.includes('连接 NAS 设备') && !content.includes('连接NAS设备'), 'must not contain 连接 NAS 设备');
    assert.ok(!content.includes('远程传输'), 'must not contain 远程传输');
  });

  it('app.js wires release health rendering contract', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();

    assert.ok(js.includes('/api/health'), 'app.js must reference /api/health');
    assert.ok(js.includes('release-health-refresh'), 'app.js must reference release-health-refresh');
    assert.ok(js.includes('buildReleaseHealthViewModel'), 'app.js must reference buildReleaseHealthViewModel');
  });

  it('styles.css contains V0.48 release health status selectors', async () => {
    const res = await fetch(`http://localhost:${port}/styles.css`);
    const css = await res.text();

    assert.ok(css.includes('.release-health-panel[data-status="ok"]'), 'styles.css must contain .release-health-panel[data-status="ok"]');
    assert.ok(css.includes('[data-status="degraded"]'), 'styles.css must contain [data-status="degraded"]');
    assert.ok(css.includes('[data-status="error"]'), 'styles.css must contain [data-status="error"]');
  });

  // ── V0.51 Release Readiness HTML/source contract ────────────────

  it('HTML contains V0.51 release readiness subsection with required data-testid hooks', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.ok(html.includes('data-testid="release-readiness-status"'), 'must have release-readiness-status');
    assert.ok(html.includes('data-testid="release-readiness-refresh"'), 'must have release-readiness-refresh');
    assert.ok(html.includes('data-testid="release-readiness-expected-version"'), 'must have release-readiness-expected-version');
    assert.ok(html.includes('data-testid="release-readiness-actual-version"'), 'must have release-readiness-actual-version');
    assert.ok(html.includes('data-testid="release-readiness-failed-count"'), 'must have release-readiness-failed-count');
    assert.ok(html.includes('data-testid="release-readiness-checklist"'), 'must have release-readiness-checklist');
    assert.ok(html.includes('data-testid="release-readiness-message"'), 'must have release-readiness-message');
    assert.ok(html.includes('data-testid="release-readiness-safety-note"'), 'must have release-readiness-safety-note');
  });

  it('V0.51 release readiness safety note documents security boundaries and avoids prohibited words', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    const panelMatch = html.match(/data-testid="release-health-panel"[\s\S]*?<\/(?:section|div)>/);

    assert.ok(panelMatch, 'release-health-panel section/div must exist');
    const content = panelMatch[0];
    assert.ok(content.includes('只读'), 'must contain 只读');
    assert.ok(content.includes('GET /api/release-readiness'), 'must contain GET /api/release-readiness');
    assert.ok(/不写入\s*metadata|不写入\s*元数据/i.test(content), 'must contain 不写入 metadata');
    assert.ok(/不连接\s*NAS/i.test(content), 'must contain 不连接 NAS');
    assert.ok(content.includes('不执行远程命令'), 'must contain 不执行远程命令');
    assert.ok(content.includes('无启动请求') || content.includes('不触发启动请求') || content.includes('无 init 请求'), 'must mention no startup request');
    assert.ok(content.includes('不自动轮询'), 'must mention no auto polling');

    assert.ok(!content.includes('执行备份'), 'must not contain 执行备份');
    assert.ok(!content.includes('创建备份'), 'must not contain 创建备份');
    assert.ok(!content.includes('执行恢复'), 'must not contain 执行恢复');
    assert.ok(!content.includes('删除快照'), 'must not contain 删除快照');
    assert.ok(!content.includes('连接 NAS 设备') && !content.includes('连接NAS设备'), 'must not contain 连接 NAS 设备');
    assert.ok(!content.includes('远程传输'), 'must not contain 远程传输');
  });

  it('app.js wires release readiness rendering contract', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();

    assert.ok(js.includes('/api/release-readiness'), 'app.js must reference /api/release-readiness');
    assert.ok(js.includes('release-readiness-refresh'), 'app.js must reference release-readiness-refresh');
    assert.ok(js.includes('buildReleaseReadinessViewModel'), 'app.js must reference buildReleaseReadinessViewModel');
  });

  it('styles.css contains V0.51 release readiness selectors', async () => {
    const res = await fetch(`http://localhost:${port}/styles.css`);
    const css = await res.text();

    assert.ok(css.includes('.release-readiness-panel[data-status="ready"]') || css.includes('[data-status="ready"]'), 'styles.css must contain ready status styling');
    assert.ok(css.includes('[data-status="not-ready"]'), 'styles.css must contain not-ready status styling');
    assert.ok(css.includes('[data-status="error"]'), 'styles.css must contain error status styling');
  });

  // ── V0.52 Gold readiness HTML/source contract ───────────────────

  it('HTML contains V0.52 gold readiness panel with required data-testid hooks', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.ok(html.includes('data-testid="gold-readiness-panel"'), 'must have gold-readiness-panel');
    assert.ok(html.includes('data-testid="gold-readiness-refresh"'), 'must have gold-readiness-refresh');
    assert.ok(html.includes('data-testid="gold-readiness-status"'), 'must have gold-readiness-status');
    assert.ok(html.includes('data-testid="gold-readiness-ready-count"'), 'must have gold-readiness-ready-count');
    assert.ok(html.includes('data-testid="gold-readiness-partial-count"'), 'must have gold-readiness-partial-count');
    assert.ok(html.includes('data-testid="gold-readiness-blocked-count"'), 'must have gold-readiness-blocked-count');
    assert.ok(html.includes('data-testid="gold-readiness-total-count"'), 'must have gold-readiness-total-count');
    assert.ok(html.includes('data-testid="gold-readiness-list"'), 'must have gold-readiness-list');
    assert.ok(html.includes('data-testid="gold-readiness-message"'), 'must have gold-readiness-message');
    assert.ok(html.includes('data-testid="gold-readiness-safety-note"'), 'must have gold-readiness-safety-note');
  });

  it('V0.52 gold readiness safety note documents boundaries and avoids overclaims', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    const panelMatch = html.match(/data-testid="gold-readiness-panel"[\s\S]*?<\/section>/);

    assert.ok(panelMatch, 'gold-readiness-panel section must exist');
    const content = panelMatch[0];
    assert.ok(/只读|read-only/i.test(content), 'must mention read-only behavior');
    assert.ok(content.includes('GET /api/gold-readiness'), 'must mention GET /api/gold-readiness');
    assert.ok(/无启动请求|不触发启动请求|no startup/i.test(content), 'must mention no startup request');
    assert.ok(/不自动轮询|no polling|no auto/i.test(content), 'must mention no auto polling');
    assert.ok(/不连接\s*NAS|no NAS connection/i.test(content), 'must mention no NAS connection');
    assert.ok(/不执行.*备份|不执行.*恢复|no backup|no restore/i.test(content), 'must mention no backup/restore execution');
    assert.ok(/不写入\s*metadata|不写入\s*元数据|no metadata/i.test(content), 'must mention no metadata writes');
    assert.ok(/不声明.*生产|no production-readiness claim|not production ready/i.test(content), 'must avoid production readiness claim');
    assert.ok(!/生产可用|production ready/i.test(content), 'must not claim production ready');
    assert.ok(!/执行.*NAS.*备份|real NAS backup/i.test(content), 'must not claim real NAS backup execution');
  });

  it('app.js wires gold readiness rendering contract', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();

    assert.ok(js.includes('/api/gold-readiness'), 'app.js must reference /api/gold-readiness');
    assert.ok(js.includes('gold-readiness-refresh'), 'app.js must reference gold-readiness-refresh');
    assert.ok(js.includes('buildGoldReadinessViewModel'), 'app.js must reference buildGoldReadinessViewModel');
  });

  it('styles.css contains V0.52 gold readiness status selectors', async () => {
    const res = await fetch(`http://localhost:${port}/styles.css`);
    const css = await res.text();

    assert.ok(css.includes('.gold-readiness-panel[data-status="ready"]'), 'styles.css must contain ready status styling');
    assert.ok(css.includes('.gold-readiness-panel[data-status="partial"]'), 'styles.css must contain partial status styling');
    assert.ok(css.includes('.gold-readiness-panel[data-status="blocked"]'), 'styles.css must contain blocked status styling');
    assert.ok(css.includes('.gold-readiness-panel[data-status="error"]'), 'styles.css must contain error status styling');
  });

  // ── V0.54 API Token UX HTML contract ─────────────────────────────
  it('HTML contains V0.54 API token controls with required data-testid hooks', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.ok(html.includes('data-testid="api-token-input"'), 'must have api-token-input');
    assert.ok(html.includes('data-testid="api-token-apply"'), 'must have api-token-apply');
    assert.ok(html.includes('data-testid="api-token-clear"'), 'must have api-token-clear');
    assert.ok(html.includes('data-testid="api-token-status"'), 'must have api-token-status');
    assert.ok(html.includes('data-testid="api-token-safety-note"'), 'must have api-token-safety-note');
  });

  it('HTML safety notes document V0.61 read/write token boundary without claiming production readiness', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.match(html, /V0\.61|V0\.62|V0\.63|V0\.65|V0\.66|V0\.67/);
    assert.match(html, /LINKE_READ_TOKEN/);
    assert.match(html, /LINKE_WRITE_TOKEN/);
    assert.match(html, /403\s+Forbidden|auth\.forbidden/);
    assert.match(html, /完整鉴权|生产级审计|生产硬化|production/i);
    assert.ok(!/生产可用|production ready/i.test(html), 'HTML must not claim production ready');
  });

  it('HTML safety notes document V0.62 auth-status boundary without exposing token material', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.match(html, /V0\.62|V0\.63|V0\.65|V0\.66|V0\.67/);
    assert.match(html, /GET \/api\/auth-status|auth-status/);
    assert.match(html, /configuredScopes|writeRoutes|认证状态|写入路由/);
    assert.match(html, /不返回.*token|tokenValuesReturned|不暴露.*token/i);
    assert.ok(!/生产可用|production ready/i.test(html), 'HTML must not claim production ready');
  });

  it('HTML safety notes document V0.63 shared write-route registry without claiming production readiness', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.match(html, /V0\.63|V0\.65|V0\.66|V0\.67/);
    assert.match(html, /API_WRITE_ROUTES|isApiWriteRoute|write-route|写入路由/);
    assert.match(html, /共享|同一来源|registry|注册表/i);
    assert.match(html, /partial|完整鉴权|生产级审计|生产硬化|production/i);
    assert.ok(!/生产可用|production ready/i.test(html), 'HTML must not claim production ready');
  });

  it('HTML safety notes document V0.66 NAS credential reference gate without exposing credentialRef values', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.match(html, /V0\.66|V0\.67/);
    assert.match(html, /credentialRef|credentialRefConfigured|executionGate/);
    assert.match(html, /credential-like|15 个|FORBIDDEN_NAS_CREDENTIAL_FIELDS|凭证字段/i);
    assert.match(html, /remoteExecutionAllowed|真实 NAS|real NAS/i);
    assert.match(html, /不回显|不返回|不暴露|non-secret|非密钥/i);
    assert.match(html, /blocked|阻塞|不连接 NAS|不写远端/i);
    assert.ok(!/生产可用|production ready/i.test(html), 'HTML must not claim production ready');
  });

  it('HTML safety notes document V0.67 NAS execution readiness summary without claiming production readiness', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.match(html, /V0\.67/);
    assert.match(html, /readinessSummary|executionReadiness|就绪性摘要|阻碍卡点代码/);
    assert.ok(!/生产可用|production ready/i.test(html), 'HTML must not claim production ready');
  });

  it('HTML safety notes document V0.71 hardening status CLI without claiming production readiness', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.match(html, /V0\.71/);
    assert.match(html, /agent\.js hardening-status|GET\s*\/api\/hardening-status|hardening-status|硬化状态/);
    assert.ok(!/生产可用|production ready/i.test(html), 'HTML must not claim production ready');
  });

  // ── V0.72 hardening-status Web panel contract tests ──────────────────

  it('HTML contains hardening-status panel with required data-testid hooks', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.ok(html.includes('data-testid="hardening-status-panel"'), 'must have hardening-status-panel');
    assert.ok(html.includes('data-testid="hardening-status-refresh"'), 'must have hardening-status-refresh');
    assert.ok(html.includes('data-testid="hardening-status-auth"'), 'must have hardening-status-auth');
    assert.ok(html.includes('data-testid="hardening-status-scoped-tokens"'), 'must have hardening-status-scoped-tokens');
    assert.ok(html.includes('data-testid="hardening-status-rate-limit"'), 'must have hardening-status-rate-limit');
    assert.ok(html.includes('data-testid="hardening-status-audit-retention"'), 'must have hardening-status-audit-retention');
    assert.ok(html.includes('data-testid="hardening-status-restore-root"'), 'must have hardening-status-restore-root');
    assert.ok(html.includes('data-testid="hardening-status-request-limit"'), 'must have hardening-status-request-limit');
    assert.ok(html.includes('data-testid="hardening-status-write-routes"'), 'must have hardening-status-write-routes');
    assert.ok(html.includes('data-testid="hardening-status-message"'), 'must have hardening-status-message');
    assert.ok(html.includes('data-testid="hardening-status-safety-note"'), 'must have hardening-status-safety-note');
  });

  it('app.js contains wiring strings for hardening status', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();

    assert.ok(js.includes('/api/hardening-status'), 'app.js must fetch /api/hardening-status');
    assert.ok(
      js.includes('hardening-status-refresh') || js.includes('hardeningStatusRefresh'),
      'app.js must reference hardening-status-refresh'
    );
    assert.ok(js.includes('buildHardeningStatusViewModel'), 'app.js must reference buildHardeningStatusViewModel');
  });

  it('styles.css contains hardening status panel CSS status selectors partial and error', async () => {
    const res = await fetch(`http://localhost:${port}/styles.css`);
    const css = await res.text();

    assert.ok(
      css.includes('hardening-status-panel[data-status="partial"]'),
      'styles.css must contain partial status styling'
    );
    assert.ok(
      css.includes('hardening-status-panel[data-status="error"]'),
      'styles.css must contain error status styling'
    );
  });

  // ── V0.78 supervisor-status Web panel contract tests ────────────────

  it('HTML contains supervisor-status panel with required data-testid hooks', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.ok(html.includes('data-testid="supervisor-status-panel"'), 'must have supervisor-status-panel');
    assert.ok(html.includes('data-testid="supervisor-status-refresh"'), 'must have supervisor-status-refresh');
    assert.ok(html.includes('data-testid="supervisor-status-state"'), 'must have supervisor-status-state');
    assert.ok(html.includes('data-testid="supervisor-status-installed"'), 'must have supervisor-status-installed');
    assert.ok(html.includes('data-testid="supervisor-status-managed"'), 'must have supervisor-status-managed');
    assert.ok(html.includes('data-testid="supervisor-status-launchd"'), 'must have supervisor-status-launchd');
    assert.ok(html.includes('data-testid="supervisor-status-watchdog"'), 'must have supervisor-status-watchdog');
    assert.ok(html.includes('data-testid="supervisor-status-monitoring"'), 'must have supervisor-status-monitoring');
    assert.ok(html.includes('data-testid="supervisor-status-recovery"'), 'must have supervisor-status-recovery');
    assert.ok(html.includes('data-testid="supervisor-status-safety"'), 'must have supervisor-status-safety');
    assert.ok(html.includes('data-testid="supervisor-status-message"'), 'must have supervisor-status-message');
    assert.ok(html.includes('data-testid="supervisor-status-safety-note"'), 'must have supervisor-status-safety-note');
  });

  it('supervisor-status Web panel safety note documents read-only boundaries and avoids overclaims', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    const panelMatch = html.match(/data-testid="supervisor-status-panel"[\s\S]*?<\/section>/);

    assert.ok(panelMatch, 'supervisor-status-panel section must exist');
    const content = panelMatch[0];
    assert.ok(/只读|read-only/i.test(content), 'must mention read-only behavior');
    assert.ok(content.includes('GET /api/supervisor-status'), 'must mention GET /api/supervisor-status');
    assert.ok(/无启动请求|不触发启动请求|no startup/i.test(content), 'must mention no startup request');
    assert.ok(/不自动轮询|no polling|no auto/i.test(content), 'must mention no auto polling');
    assert.ok(/不调用\s*launchctl|launchctlCalled:false/i.test(content), 'must mention no launchctl call');
    assert.ok(/不读取.*进程|processListRead:false/i.test(content), 'must mention no process-list read');
    assert.ok(/不安装|supervisorInstalled:false/i.test(content), 'must mention no supervisor install');
    assert.ok(/不写入\s*metadata|不写入\s*元数据|metadataWritten:false/i.test(content), 'must mention no metadata writes');
    assert.ok(/不连接\s*NAS|nasConnected:false/i.test(content), 'must mention no NAS connection');
    assert.ok(/不触发.*备份|不触发.*恢复|不执行远程命令|backupTriggered:false|restoreTriggered:false|remoteCommandExecuted:false/i.test(content), 'must mention no backup/restore/remote command');
    assert.ok(!/生产可用|production ready/i.test(content), 'must not claim production ready');
    assert.ok(!/已安装守护进程|daemon installed|launchd installed/i.test(content), 'must not claim daemon installation');
  });

  it('app.js wires supervisor-status rendering contract', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();

    assert.ok(js.includes('/api/supervisor-status'), 'app.js must reference /api/supervisor-status');
    assert.ok(
      js.includes('supervisor-status-refresh') || js.includes('supervisorStatusRefresh'),
      'app.js must reference supervisor-status-refresh'
    );
    assert.ok(js.includes('buildSupervisorStatusViewModel'), 'app.js must reference buildSupervisorStatusViewModel');
  });

  it('styles.css contains supervisor-status panel CSS status selectors partial and error', async () => {
    const res = await fetch(`http://localhost:${port}/styles.css`);
    const css = await res.text();

    assert.ok(
      css.includes('supervisor-status-panel[data-status="partial"]'),
      'styles.css must contain partial status styling'
    );
    assert.ok(
      css.includes('supervisor-status-panel[data-status="error"]'),
      'styles.css must contain error status styling'
    );
  });

  // ── V0.74 audit-log Web panel contract tests ────────────────────────

  it('HTML contains audit-log panel with required data-testid hooks', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.ok(html.includes('data-testid="audit-log-panel"'), 'must have audit-log-panel');
    assert.ok(html.includes('data-testid="audit-log-refresh"'), 'must have audit-log-refresh');
    assert.ok(html.includes('data-testid="audit-log-count"'), 'must have audit-log-count');
    assert.ok(html.includes('data-testid="audit-log-latest-type"'), 'must have audit-log-latest-type');
    assert.ok(html.includes('data-testid="audit-log-latest-device"'), 'must have audit-log-latest-device');
    assert.ok(html.includes('data-testid="audit-log-list"'), 'must have audit-log-list');
    assert.ok(html.includes('data-testid="audit-log-message"'), 'must have audit-log-message');
    assert.ok(html.includes('data-testid="audit-log-safety-note"'), 'must have audit-log-safety-note');
  });

  it('audit-log Web panel safety note documents read-only boundaries and avoids overclaims', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    const panelMatch = html.match(/data-testid="audit-log-panel"[\s\S]*?<\/section>/);

    assert.ok(panelMatch, 'audit-log-panel section must exist');
    const content = panelMatch[0];
    assert.ok(/只读|read-only/i.test(content), 'must mention read-only behavior');
    assert.ok(content.includes('GET /api/audit-log'), 'must mention GET /api/audit-log');
    assert.ok(/无启动请求|不触发启动请求|no startup/i.test(content), 'must mention no startup request');
    assert.ok(/不自动轮询|no polling|no auto/i.test(content), 'must mention no auto polling');
    assert.ok(/不写入\s*metadata|不写入\s*元数据|no metadata/i.test(content), 'must mention no metadata writes');
    assert.ok(/不连接\s*NAS|no NAS/i.test(content), 'must mention no NAS connection');
    assert.ok(/不执行.*备份|不执行.*恢复|不执行远程命令|no backup|no restore/i.test(content), 'must mention no backup/restore/remote execution');
    assert.ok(/不显示.*token|Authorization|sourcePath|targetPath|脱敏|sanitized/i.test(content), 'must mention sensitive fields are not displayed');
    assert.ok(!/生产可用|production ready/i.test(content), 'must not claim production ready');
    assert.ok(!/执行.*NAS.*备份|real NAS backup/i.test(content), 'must not claim real NAS backup execution');
  });

  it('app.js wires audit-log rendering contract', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();

    assert.ok(js.includes('/api/audit-log'), 'app.js must reference /api/audit-log');
    assert.ok(js.includes('audit-log-refresh') || js.includes('auditLogRefresh'), 'app.js must reference audit-log-refresh');
    assert.ok(js.includes('buildAuditLogViewModel'), 'app.js must reference buildAuditLogViewModel');
  });

  it('styles.css contains audit-log panel CSS status selectors ready and error', async () => {
    const res = await fetch(`http://localhost:${port}/styles.css`);
    const css = await res.text();

    assert.ok(css.includes('.audit-log-panel[data-status="ready"]'), 'styles.css must contain ready status styling');
    assert.ok(css.includes('.audit-log-panel[data-status="empty"]'), 'styles.css must contain empty status styling');
    assert.ok(css.includes('.audit-log-panel[data-status="error"]'), 'styles.css must contain error status styling');
  });

  it('HTML contains supervisor-install-dry-run panel with required data-testid hooks', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.ok(html.includes('data-testid="supervisor-install-dry-run-panel"'), 'must have supervisor-install-dry-run-panel');
    assert.ok(html.includes('data-testid="supervisor-install-dry-run-config"'), 'must have supervisor-install-dry-run-config textarea');
    assert.ok(html.includes('data-testid="supervisor-install-dry-run-run"'), 'must have supervisor-install-dry-run-run button');
    assert.ok(html.includes('data-testid="supervisor-install-dry-run-status"'), 'must have supervisor-install-dry-run-status stat');
    assert.ok(html.includes('data-testid="supervisor-install-dry-run-install-state"'), 'must have supervisor-install-dry-run-install-state stat');
    assert.ok(html.includes('data-testid="supervisor-install-dry-run-approval-state"'), 'must have supervisor-install-dry-run-approval-state stat');
    assert.ok(html.includes('data-testid="supervisor-install-dry-run-rollback-state"'), 'must have supervisor-install-dry-run-rollback-state stat');
    assert.ok(html.includes('data-testid="supervisor-install-dry-run-result"'), 'must have supervisor-install-dry-run-result');
    assert.ok(html.includes('data-testid="supervisor-install-dry-run-safety-note"'), 'must have supervisor-install-dry-run-safety-note');
  });

  it('supervisor-install-dry-run panel safety note documents manual dry-run boundaries and avoids Gold overclaims', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    const panelMatch = html.match(/data-testid="supervisor-install-dry-run-panel"[\s\S]*?<\/section>/);

    assert.ok(panelMatch, 'supervisor-install-dry-run-panel section must exist');
    const content = panelMatch[0];
    assert.ok(content.includes('POST /api/supervisor-install-dry-run'), 'must mention POST endpoint');
    assert.match(content, /dry-run|只读|预览/);
    assert.match(content, /rollback|uninstall|recovery supervisor/i);
    assert.match(content, /无启动请求|不自动轮询/);
    assert.match(content, /不调用 launchctl/);
    assert.match(content, /不读取进程列表/);
    assert.match(content, /不安装|不启动/);
    assert.ok(content.includes('不执行 rollback 或 uninstall'), 'must say rollback and uninstall are not executed');
    assert.ok(content.includes('不删除 launchd 文件'), 'must say launchd files are not deleted');
    assert.ok(content.includes('不恢复 previous plist'), 'must say previous plist is not restored');
    assert.ok(content.includes('不启动 recovery supervisor'), 'must say recovery supervisor is not started');
    assert.match(content, /不写入 metadata|不写 metadata/);
    assert.match(content, /不连接 NAS/);
    assert.match(content, /不触发备份或恢复|不执行备份或恢复/);
    assert.match(content, /不执行远程命令/);
    assert.match(content, /raw evidence|runnable command/);
    assert.match(content, /不声明.*Gold|Gold.*blocked|Gold.*未完成/);
  });

  it('app.js wires supervisor-install-dry-run rendering contract', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();

    assert.ok(js.includes('/api/supervisor-install-dry-run'), 'app.js must reference /api/supervisor-install-dry-run');
    assert.ok(js.includes('buildSupervisorInstallDryRunViewModel'), 'app.js must export supervisor install dry-run view model');
    assert.ok(js.includes('supervisor-install-dry-run-run') || js.includes('supervisorInstallDryRunRun'), 'app.js must reference the run button');
  });

  it('styles.css contains supervisor-install-dry-run panel styles', async () => {
    const res = await fetch(`http://localhost:${port}/styles.css`);
    const css = await res.text();

    assert.ok(css.includes('.supervisor-install-dry-run-panel'), 'styles.css must contain panel styles');
    assert.ok(css.includes('.supervisor-install-dry-run-error'), 'styles.css must contain error styles');
  });

  it('HTML contains supervisor lifecycle approval persistence preview panel with required data-testid hooks', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    assert.ok(html.includes('data-testid="supervisor-lifecycle-approval-preview-panel"'), 'must have approval preview panel');
    assert.ok(html.includes('data-testid="supervisor-lifecycle-approval-preview-config"'), 'must have config textarea');
    assert.ok(html.includes('data-testid="supervisor-lifecycle-approval-preview-approval"'), 'must have approval textarea');
    assert.ok(html.includes('data-testid="supervisor-lifecycle-approval-preview-operation"'), 'must have operation selector');
    assert.ok(html.includes('data-testid="supervisor-lifecycle-approval-preview-run"'), 'must have run button');
    assert.ok(html.includes('data-testid="supervisor-lifecycle-approval-persist-button"'), 'must have persist button');
    assert.ok(html.includes('data-testid="supervisor-lifecycle-approval-preview-status"'), 'must have status stat');
    assert.ok(html.includes('data-testid="supervisor-lifecycle-approval-preview-valid"'), 'must have approval valid stat');
    assert.ok(html.includes('data-testid="supervisor-lifecycle-approval-preview-persist"'), 'must have persistence stat');
    assert.ok(html.includes('data-testid="supervisor-lifecycle-approval-preview-result"'), 'must have result container');
    assert.ok(html.includes('data-testid="supervisor-lifecycle-approval-preview-safety-note"'), 'must have safety note');
    assert.ok(html.includes('data-testid="supervisor-lifecycle-approval-persist-safety-note"'), 'must have persist safety note');
    const buttonMatch = html.match(/<button[^>]*data-testid="supervisor-lifecycle-approval-persist-button"[^>]*>([\s\S]*?)<\/button>/);
    assert.ok(buttonMatch, 'persist button must exist');
    assert.match(buttonMatch[1], /Persist Approval Record/);
    assert.doesNotMatch(buttonMatch[1], /Apply|Install|Execute|Run install|Rollback|Uninstall/i);
  });

  it('supervisor lifecycle approval preview panel safety note documents manual preview boundaries', async () => {
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    const panelMatch = html.match(/data-testid="supervisor-lifecycle-approval-preview-panel"[\s\S]*?<\/section>/);

    assert.ok(panelMatch, 'approval preview panel section must exist');
    const content = panelMatch[0];
    assert.ok(content.includes('POST /api/supervisor-lifecycle-approval-persistence-preview'), 'must mention POST endpoint');
    assert.match(content, /只读|预览|manual/i);
    assert.match(content, /不写 approval|不持久化批准|approvalPersisted:false/i);
    assert.match(content, /不调用 launchctl/);
    assert.match(content, /不新增.*apply|不执行.*apply|不执行生命周期/);
    assert.match(content, /local JSONL approval record|本地 JSONL approval record/i);
    assert.match(content, /does not execute lifecycle apply|不执行生命周期 apply/i);
    assert.match(content, /does not call launchctl|不调用 launchctl/i);
    assert.match(content, /不显示.*token|不显示.*hash|不显示.*路径|不返回.*approvedBy/);
    assert.match(content, /Gold.*blocked|Gold.*仍|Gold.*未完成/);
  });

  it('app.js wires supervisor lifecycle approval preview rendering contract', async () => {
    const res = await fetch(`http://localhost:${port}/app.js`);
    const js = await res.text();

    assert.ok(js.includes('/api/supervisor-lifecycle-approval-persistence-preview'), 'app.js must reference approval preview endpoint');
    assert.ok(
      js.includes("apiFetch('/api/supervisor-lifecycle-approval-persist'"),
      'app.js must call approval persist endpoint directly',
    );
    assert.ok(js.includes('buildSupervisorLifecycleApprovalPersistencePreviewViewModel'), 'app.js must export approval preview view model');
    assert.ok(js.includes('buildSupervisorLifecycleApprovalPersistViewModel'), 'app.js must export approval persist view model');
    assert.ok(js.includes('supervisor-lifecycle-approval-preview-run') || js.includes('supervisorLifecycleApprovalPreviewRun'), 'app.js must reference the run button');
    assert.ok(js.includes('supervisor-lifecycle-approval-persist-button') || js.includes('supervisorLifecycleApprovalPersistButton'), 'app.js must reference the persist button');
  });

  it('styles.css contains supervisor lifecycle approval preview panel styles', async () => {
    const res = await fetch(`http://localhost:${port}/styles.css`);
    const css = await res.text();

    assert.ok(css.includes('.supervisor-lifecycle-approval-preview-panel'), 'styles.css must contain approval preview panel styles');
    assert.ok(css.includes('.supervisor-lifecycle-approval-preview-error'), 'styles.css must contain approval preview error styles');
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

describe('API token fetch helpers', () => {
  it('treats only relative /api and /api/* URLs as API requests', () => {
    assert.strictEqual(isApiRequestUrl('/api'), true);
    assert.strictEqual(isApiRequestUrl('/api/health'), true);
    assert.strictEqual(isApiRequestUrl('/api/nas-dry-run?x=1'), true);
    assert.strictEqual(isApiRequestUrl('/api?x=1'), true);
    assert.strictEqual(isApiRequestUrl('/app.js'), false);
    assert.strictEqual(isApiRequestUrl('/apix/health'), false);
    assert.strictEqual(isApiRequestUrl('https://example.com/api/health'), false);
  });

  it('does not add Authorization to non-API URLs even when a token exists', () => {
    const originalOptions = { headers: { 'X-Test': '1' } };
    const result = buildApiFetchOptions('/app.js', originalOptions, 'secret-token-123');

    assert.strictEqual(result, originalOptions);
    assert.deepStrictEqual(originalOptions.headers, { 'X-Test': '1' });
  });

  it('adds Authorization to API POST requests while preserving existing headers without mutating input', () => {
    const originalOptions = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    };

    const result = buildApiFetchOptions('/api/nas-dry-run', originalOptions, 'secret-token-123');

    assert.notStrictEqual(result, originalOptions);
    assert.notStrictEqual(result.headers, originalOptions.headers);
    assert.strictEqual(result.method, 'POST');
    assert.strictEqual(result.body, '{}');
    assert.strictEqual(result.headers['Content-Type'], 'application/json');
    assert.strictEqual(result.headers.Authorization, 'Bearer secret-token-123');
    assert.deepStrictEqual(originalOptions.headers, { 'Content-Type': 'application/json' });
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

  function normalizeKey(key) {
    if (typeof key !== 'string') return key;
    let k = key.trim();
    if (k.startsWith('#')) {
      k = k.slice(1);
    }
    const match = k.match(/^\[data-testid=["']([^"']+)["']\]$/);
    if (match) {
      k = match[1];
    }
    return k;
  }

  function getOrCreate(id) {
    const norm = normalizeKey(id);
    if (!elements[norm]) {
      elements[norm] = {
        textContent: '',
        innerHTML: '',
        value: '',
        prepend(c) {
          this.children.unshift(c);
          if (c.textContent) {
            this.textContent = c.textContent + this.textContent;
          }
        },
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
        setAttribute(k, v) {
          this._attrs[k] = v;
          this[k] = v;
          if (k.startsWith('data-')) {
            const camel = k.slice(5).replace(/-([a-z])/g, (g) => g[1].toUpperCase());
            this.dataset[camel] = v;
          }
        },
        getAttribute(k) { return this._attrs[k] || null; },
        get lastChild() { return this.children[this.children.length - 1] || null; },
        removeChild(c) {
          const idx = this.children.indexOf(c);
          if (idx !== -1) {
            this.children.splice(idx, 1);
          }
          this.textContent = this.children.map(child => child.textContent || '').join('');
          return c;
        },
        querySelector(sel) {
          const norm = normalizeKey(sel);
          return this.children.find(c => {
            if (c._attrs?.['data-testid'] === norm) return true;
            if (c._attrs?.['id'] === norm) return true;
            if (c.id === norm) return true;
            if (typeof sel === 'string' && sel.startsWith('.') && c.className?.includes(sel.slice(1))) return true;
            return false;
          }) || null;
        }
      };
    }
    return elements[norm];
  }

  const doc = {
    _created: createdElements,
    getElementById: (id) => getOrCreate(id),
    querySelector: (sel) => {
      const norm = normalizeKey(sel);
      if (elements[norm]) return elements[norm];
      function findIn(el) {
        if (el._attrs?.['data-testid'] === norm || el.id === norm || el._attrs?.['id'] === norm) return el;
        if (typeof sel === 'string' && sel.startsWith('.') && el.className?.includes(sel.slice(1))) return el;
        if (el.children) {
          for (const child of el.children) {
            const found = findIn(child);
            if (found) return found;
          }
        }
        return null;
      }
      for (const el of createdElements) {
        const found = findIn(el);
        if (found) return found;
      }
      return getOrCreate(sel);
    },
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
        setAttribute(k, v) {
          this._attrs[k] = v;
          if (k.startsWith('data-')) {
            const camel = k.slice(5).replace(/-([a-z])/g, (g) => g[1].toUpperCase());
            this.dataset[camel] = v;
          }
        },
        getAttribute(k) { return this._attrs[k] || null; },
        prepend(c) {
          this.children.unshift(c);
          if (c.textContent) {
            this.textContent = c.textContent + this.textContent;
          }
        },
        get lastChild() { return this.children[this.children.length - 1] || null; },
        removeChild(c) {
          const idx = this.children.indexOf(c);
          if (idx !== -1) {
            this.children.splice(idx, 1);
          }
          this.textContent = this.children.map(child => child.textContent || '').join('');
          return c;
        },
        querySelector(sel) {
          const norm = normalizeKey(sel);
          return this.children.find(c => {
            if (c._attrs?.['data-testid'] === norm) return true;
            if (c._attrs?.['id'] === norm) return true;
            if (c.id === norm) return true;
            if (typeof sel === 'string' && sel.startsWith('.') && c.className?.includes(sel.slice(1))) return true;
            return false;
          }) || null;
        }
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

  it('DOM test: renders NAS execution readiness summary and target blockers without leaking credentialRef', async () => {
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
            executionGate: {
              remoteExecutionAllowed: false,
              blockingReason: 'real NAS transport not implemented',
            },
            readinessSummary: {
              mode: 'dry-run',
              state: 'blocked',
              totalTargets: 3,
              enabledTargets: 2,
              disabledTargets: 1,
              credentialRefConfiguredTargets: 1,
              enabledCredentialRefMissingTargets: 1,
              blockedTargets: 3,
              remoteExecutionBlocked: true,
              blockers: ['remote-execution-blocked', 'credential-ref-missing', 'target-disabled'],
            },
            targets: [
              {
                name: 'synology-configured',
                provider: 'synology',
                endpoint: 'http://192.168.1.100:5000',
                shareName: 'backup',
                remotePath: '/volume1/backup',
                enabled: true,
                credentialRefConfigured: true,
                executionReadiness: {
                  state: 'blocked',
                  blockers: ['remote-execution-blocked'],
                },
              },
              {
                name: 'synology-missing',
                provider: 'synology',
                endpoint: 'http://192.168.1.100:5000',
                shareName: 'backup',
                remotePath: '/volume1/backup',
                enabled: true,
                credentialRefConfigured: false,
                executionReadiness: {
                  state: 'blocked',
                  blockers: ['credential-ref-missing', 'remote-execution-blocked'],
                },
              },
              {
                name: 'synology-disabled',
                provider: 'synology',
                endpoint: 'http://192.168.1.100:5000',
                shareName: 'backup',
                remotePath: '/volume1/backup',
                enabled: false,
                credentialRefConfigured: false,
                executionReadiness: {
                  state: 'blocked',
                  blockers: ['target-disabled', 'remote-execution-blocked'],
                },
              },
            ],
            jobs: [],
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
      nasTargets: [
        {
          name: 'synology-configured',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          enabled: true,
          credentialRef: 'home-synology', // should not be leaked in UI text content
        }
      ],
      backupJobs: [],
    });
    doc.getElementById('nas-dry-run-run')._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    const resultText = doc.getElementById('nas-dry-run-result').textContent;

    // Assert readiness summary text
    assert.match(resultText, /NAS 执行就绪性摘要/);
    assert.match(resultText, /状态:\s*blocked/);
    assert.match(resultText, /总目标:\s*3/);
    assert.match(resultText, /已启用:\s*2/);
    assert.match(resultText, /已禁用:\s*1/);
    assert.match(resultText, /凭证配置:\s*1/);
    assert.match(resultText, /启用缺凭证:\s*1/);
    assert.match(resultText, /受阻目标:\s*3/);
    assert.match(resultText, /就绪性卡点:\s*remote-execution-blocked,\s*credential-ref-missing,\s*target-disabled/);

    // Assert per-target text
    assert.match(resultText, /synology-configured/);
    assert.match(resultText, /synology-missing/);
    assert.match(resultText, /synology-disabled/);
    assert.match(resultText, /执行就绪状态:\s*blocked/);
    assert.match(resultText, /卡点:\s*remote-execution-blocked/);
    assert.match(resultText, /卡点:\s*credential-ref-missing/);
    assert.match(resultText, /卡点:\s*target-disabled/);

    // Verify credentialRef name is not leaked
    assert.strictEqual(resultText.includes('home-synology'), false, 'must not leak raw credentialRef values');
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

  it('renders top-level executionGate and blocking reason', async () => {
    const doc = buildMockDoc();
    const mockFetch = async (url) => {
      if (String(url).includes('/api/nas-dry-run')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            mode: 'dry-run',
            deviceId: 'web-console-dry-run',
            wouldConnect: false,
            wouldWrite: false,
            executionGate: {
              remoteExecutionAllowed: false,
              blockingReason: 'real NAS transport not implemented'
            },
            targets: [],
            jobs: [],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };
    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 20));

    doc.getElementById('nas-dry-run-config').value = JSON.stringify({
      deviceId: 'web-console-dry-run',
      nasTargets: [],
      backupJobs: [],
    });
    doc.getElementById('nas-dry-run-run')._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    const text = doc.getElementById('nas-dry-run-result').textContent;
    assert.match(text, /远程执行：已阻止/);
    assert.match(text, /阻止原因：real NAS transport not implemented/);
    assert.match(text, /dry-run/);
  });

  it('renders credentialRefConfigured true/false rendering without leaking raw credentialRef', async () => {
    const doc = buildMockDoc();
    const mockFetch = async (url) => {
      if (String(url).includes('/api/nas-dry-run')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            mode: 'dry-run',
            deviceId: 'web-console-dry-run',
            wouldConnect: false,
            wouldWrite: false,
            executionGate: {
              remoteExecutionAllowed: false,
              blockingReason: 'real NAS transport not implemented'
            },
            targets: [
              {
                name: 'synology-configured',
                provider: 'synology',
                endpoint: 'http://192.168.1.100:5000',
                shareName: 'backup',
                remotePath: '/volume1/backup',
                enabled: true,
                credentialRefConfigured: true,
              },
              {
                name: 'synology-unconfigured',
                provider: 'synology',
                endpoint: 'http://192.168.1.101:5000',
                shareName: 'backup',
                remotePath: '/volume1/plain',
                enabled: true,
                credentialRefConfigured: false,
              },
            ],
            jobs: [],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };
    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 20));

    doc.getElementById('nas-dry-run-config').value = JSON.stringify({
      deviceId: 'web-console-dry-run',
      nasTargets: [
        {
          name: 'synology-configured',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          enabled: true,
          credentialRef: 'my-secret-credential-slug'
        }
      ],
      backupJobs: [],
    });
    doc.getElementById('nas-dry-run-run')._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    const text = doc.getElementById('nas-dry-run-result').textContent;
    assert.match(text, /凭证引用：已配置/);
    assert.match(text, /凭证引用：未配置/);
    assert.ok(!text.includes('my-secret-credential-slug'), 'must not render or leak the raw credentialRef value');
  });

  it('does not render raw credentialRef slug from input config in the result area', async () => {
    const doc = buildMockDoc();
    const mockFetch = async (url) => {
      if (String(url).includes('/api/nas-dry-run')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            mode: 'dry-run',
            deviceId: 'web-console-dry-run',
            wouldConnect: false,
            wouldWrite: false,
            executionGate: {
              remoteExecutionAllowed: false,
              blockingReason: 'real NAS transport not implemented'
            },
            targets: [
              {
                name: 'synology-configured',
                provider: 'synology',
                endpoint: 'http://192.168.1.100:5000',
                shareName: 'backup',
                remotePath: '/volume1/backup',
                enabled: true,
                credentialRefConfigured: true,
              }
            ],
            jobs: [],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };
    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 20));

    doc.getElementById('nas-dry-run-config').value = JSON.stringify({
      deviceId: 'web-console-dry-run',
      nasTargets: [
        {
          name: 'synology-configured',
          provider: 'synology',
          endpoint: 'http://192.168.1.100:5000',
          shareName: 'backup',
          remotePath: '/volume1/backup',
          enabled: true,
          credentialRef: 'very-secret-ref-slug-abc'
        }
      ],
      backupJobs: [],
    });
    doc.getElementById('nas-dry-run-run')._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    const resultEl = doc.getElementById('nas-dry-run-result');
    const resultText = resultEl.textContent + ' ' + resultEl.innerHTML;
    assert.ok(!resultText.includes('very-secret-ref-slug-abc'), 'very-secret-ref-slug-abc must not leak into the DOM result rendering');
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

  // ── V0.19 Timeline snapshot selection ────────────────────────────

  it('clicking a backup job timeline snapshot loads manifest detail and restore dry-run', async () => {
    const doc = buildMockDoc();
    const calls = [];
    const devices = [
      {
        deviceId: 'd5',
        hostname: 'host-five',
        status: 'online',
        ipAddress: '10.0.0.5',
        snapshotCount: 2,
        lastHeartbeatAt: '2026-07-05T10:00:00.000Z',
      },
    ];
    const snapshots = [
      {
        snapshotId: 'timeline-1111',
        jobName: 'documents',
        sourcePath: '/Users/ah/Documents',
        createdAt: '2026-07-05T10:00:00.000Z',
        fileCount: 3,
      },
      {
        snapshotId: 'timeline-2222',
        jobName: 'documents',
        sourcePath: '/Users/ah/Documents',
        createdAt: '2026-07-05T11:00:00.000Z',
        fileCount: 5,
      },
    ];
    const manifest = {
      snapshotId: 'timeline-2222',
      deviceId: 'd5',
      createdAt: '2026-07-05T11:00:00.000Z',
      sourcePath: '/Users/ah/Documents',
      files: ['new.txt', 'nested/version.md'],
    };
    const restorePlan = {
      mode: 'dry-run',
      wouldWrite: false,
      summary: { totalFiles: 2, wouldCreateCount: 1, wouldOverwriteCount: 1 },
      files: [
        { sourceRelativePath: 'new.txt', targetPath: '/tmp/linke/new.txt', action: 'would-create' },
        { sourceRelativePath: 'nested/version.md', targetPath: '/tmp/linke/nested/version.md', action: 'would-overwrite' },
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
        return { ok: true, status: 200, json: async () => ({ keepCount: 0, wouldDeleteCount: 0, snapshots: [] }) };
      }
      return { ok: true, status: 200, json: async () => (url.includes('/snapshots') ? snapshots : devices) };
    };
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));

    doc.getElementById('restore-dry-run-target').value = '/tmp/linke';

    const deviceItem = doc._created.find((el) => el.className && el.className.includes('device-item'));
    deviceItem._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    const backupJob = doc._created.find((el) => el.className && el.className.includes('backup-job-item'));
    backupJob._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    const timelineRows = doc._created.filter((el) => el.className && el.className.includes('backup-job-timeline-item'));
    const newestRow = timelineRows.find((el) => el.dataset.snapshotId === 'timeline-2222');
    assert.ok(newestRow, 'newest timeline row must expose data-snapshot-id');
    assert.ok(newestRow._listeners.click, 'timeline row must have click handler');
    newestRow._listeners.click();
    await new Promise((r) => setTimeout(r, 40));

    assert.ok(
      calls.includes('/api/devices/d5/snapshots/timeline-2222/manifest'),
      `must fetch manifest endpoint, got calls: ${calls.join(', ')}`,
    );
    assert.ok(
      calls.includes('/api/devices/d5/snapshots/timeline-2222/restore-dry-run?targetPath=%2Ftmp%2Flinke'),
      `must fetch restore dry-run endpoint, got calls: ${calls.join(', ')}`,
    );
    assert.match(newestRow.className, /selected/);
    assert.match(doc.getElementById('snapshot-detail-content').textContent, /nested\/version\.md/);
    assert.match(doc.getElementById('restore-dry-run-result').textContent, /would-overwrite/);
  });

  it('clears selected backup job timeline snapshot when switching devices', async () => {
    const doc = buildMockDoc();
    const devices = [
      { deviceId: 'dev-A', hostname: 'A', status: 'online', ipAddress: '10.0.0.10', snapshotCount: 1 },
      { deviceId: 'dev-B', hostname: 'B', status: 'online', ipAddress: '10.0.0.11', snapshotCount: 0 },
    ];
    const snapshotsA = [
      {
        snapshotId: 'dev-a-snap',
        jobName: 'documents',
        sourcePath: '/Users/ah/Documents',
        createdAt: '2026-07-05T10:00:00.000Z',
        fileCount: 2,
      },
    ];
    const calls = [];
    const mockFetch = async (url) => {
      calls.push(url);
      if (url.includes('/retention-dry-run')) {
        return { ok: true, status: 200, json: async () => ({ keepCount: 0, wouldDeleteCount: 0, snapshots: [] }) };
      }
      if (url.includes('/manifest')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            snapshotId: 'dev-a-snap',
            deviceId: 'dev-A',
            sourcePath: '/Users/ah/Documents',
            createdAt: '2026-07-05T10:00:00.000Z',
            files: ['a.txt'],
          }),
        };
      }
      if (url.includes('/restore-dry-run')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            mode: 'dry-run',
            wouldWrite: false,
            summary: { totalFiles: 0, wouldCreateCount: 0, wouldOverwriteCount: 0 },
            files: [],
          }),
        };
      }
      if (url.includes('/api/devices/dev-A/snapshots')) {
        return { ok: true, status: 200, json: async () => snapshotsA };
      }
      if (url.includes('/api/devices/dev-B/snapshots')) {
        return { ok: true, status: 200, json: async () => [] };
      }
      return { ok: true, status: 200, json: async () => devices };
    };
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));

    const deviceA = doc._created.find((el) => el.dataset.deviceId === 'dev-A');
    const deviceB = doc._created.find((el) => el.dataset.deviceId === 'dev-B');

    deviceA._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    const backupJob = doc._created.find((el) => el.className && el.className.includes('backup-job-item'));
    backupJob._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    const timelineRow = doc._created.find((el) => el.className && el.className.includes('backup-job-timeline-item'));
    timelineRow._listeners.click();
    await new Promise((r) => setTimeout(r, 40));
    assert.match(timelineRow.className, /selected/);

    deviceB._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.doesNotMatch(doc.getElementById('backup-job-detail-list').textContent, /dev-a-snap/);
    assert.strictEqual(doc.getElementById('backup-job-detail-title').textContent, '未选择');
    calls.length = 0;

    doc.getElementById('restore-dry-run-target')._listeners.change();
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(!calls.some((url) => String(url).includes('dev-a-snap')), 'old selected snapshot must not be reused after device switch');
  });

  it('renders device-management-state and V0.38 device-management-hint in list items and selected device detail', async () => {
    const doc = buildMockDoc();
    const devices = [
      { deviceId: 'd1', hostname: 'host-one', status: 'online', ipAddress: '1.2.3.4', snapshotCount: 0 },
      { deviceId: 'd2', hostname: 'host-two', status: 'online', ipAddress: '', snapshotCount: 0 },
      { deviceId: 'd3', hostname: 'host-three', status: 'offline', ipAddress: '1.2.3.4', snapshotCount: 0 },
      { deviceId: 'd4', hostname: 'host-four', status: 'unknown', ipAddress: '1.2.3.4', snapshotCount: 0 },
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

    // Verify list items management state hooks and text contents
    const listItems = doc._created.filter((el) => el.className && el.className.includes('device-item'));
    assert.strictEqual(listItems.length, 4);

    const item1 = listItems.find((el) => el.dataset.deviceId === 'd1');
    const item2 = listItems.find((el) => el.dataset.deviceId === 'd2');
    const item3 = listItems.find((el) => el.dataset.deviceId === 'd3');
    const item4 = listItems.find((el) => el.dataset.deviceId === 'd4');

    const stateEl1 = item1.querySelector('[data-testid="device-management-state"]');
    const stateEl2 = item2.querySelector('[data-testid="device-management-state"]');
    const stateEl3 = item3.querySelector('[data-testid="device-management-state"]');
    const stateEl4 = item4.querySelector('[data-testid="device-management-state"]');
    const hintEl1 = item1.querySelector('[data-testid="device-management-hint"]');
    const hintEl2 = item2.querySelector('[data-testid="device-management-hint"]');
    const hintEl3 = item3.querySelector('[data-testid="device-management-hint"]');
    const hintEl4 = item4.querySelector('[data-testid="device-management-hint"]');

    assert.ok(stateEl1, 'd1 list item must render device-management-state element');
    assert.ok(stateEl2, 'd2 list item must render device-management-state element');
    assert.ok(stateEl3, 'd3 list item must render device-management-state element');
    assert.ok(stateEl4, 'd4 list item must render device-management-state element');
    assert.ok(hintEl1, 'd1 list item must render device-management-hint element');
    assert.ok(hintEl2, 'd2 list item must render device-management-hint element');
    assert.ok(hintEl3, 'd3 list item must render device-management-hint element');
    assert.ok(hintEl4, 'd4 list item must render device-management-hint element');

    assert.strictEqual(stateEl1.textContent.trim(), '在线可见');
    assert.strictEqual(stateEl2.textContent.trim(), '在线缺 IP');
    assert.strictEqual(stateEl3.textContent.trim(), '离线保留');
    assert.strictEqual(stateEl4.textContent.trim(), '未知待确认');
    assert.strictEqual(hintEl1.textContent.trim(), '在线且 IP 可用，可纳入统一管理');
    assert.strictEqual(hintEl2.textContent.trim(), '设备在线但缺少可用 IP，需补充 IP 信息');
    assert.strictEqual(hintEl3.textContent.trim(), '设备离线，保留历史记录和备份上下文');
    assert.strictEqual(hintEl4.textContent.trim(), '状态未知，需确认设备心跳');

    function querySelectorDeep(el, testId) {
      if (!el) return null;
      if (el._attrs?.['data-testid'] === testId || el.id === testId || el._attrs?.['id'] === testId) {
        return el;
      }
      if (el.children) {
        for (const child of el.children) {
          const found = querySelectorDeep(child, testId);
          if (found) return found;
        }
      }
      return null;
    }

    // Click d1 to check detail view
    item1._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    const detailEl = querySelectorDeep(doc.getElementById('device-detail-content'), 'device-detail-management-state');
    const detailHintEl = querySelectorDeep(doc.getElementById('device-detail-content'), 'device-detail-management-hint');
    assert.ok(detailEl, 'selected device detail must render device-detail-management-state element');
    assert.ok(detailHintEl, 'selected device detail must render device-detail-management-hint element');
    assert.strictEqual(detailEl.textContent.trim(), '在线可见');
    assert.strictEqual(detailHintEl.textContent.trim(), '在线且 IP 可用，可纳入统一管理');

    // Click d2 to check detail view
    item2._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    const detailEl2 = querySelectorDeep(doc.getElementById('device-detail-content'), 'device-detail-management-state');
    const detailHintEl2 = querySelectorDeep(doc.getElementById('device-detail-content'), 'device-detail-management-hint');
    assert.ok(detailEl2, 'selected device detail must render device-detail-management-state element');
    assert.ok(detailHintEl2, 'selected device detail must render device-detail-management-hint element');
    assert.strictEqual(detailEl2.textContent.trim(), '在线缺 IP');
    assert.strictEqual(detailHintEl2.textContent.trim(), '设备在线但缺少可用 IP，需补充 IP 信息');
  });

  it('DOM test: changing device-management-filter updates device list and device-filter-count without refetching /api/devices', async () => {
    const doc = buildMockDoc();
    const localDevices = [
      { deviceId: 'mac-1', hostname: 'Aaron-Mac', status: 'online', ipAddress: '10.0.0.20', snapshotCount: 2, lastHeartbeatAt: '2026-07-04T10:00:00Z' }, // visible
      { deviceId: 'mac-2', hostname: 'Beta-Mac', status: 'online', ipAddress: '', snapshotCount: 0, lastHeartbeatAt: '2026-07-04T10:00:00Z' }, // missing-ip
      { deviceId: 'ipad-3', hostname: 'Design-iPad', status: 'offline', ipAddress: '10.0.0.5', snapshotCount: 8, lastHeartbeatAt: '2026-07-04T09:00:00Z' }, // offline-retained
      { deviceId: 'phone-4', hostname: 'TestPhone', status: '', ipAddress: '192.168.31.9', snapshotCount: 0, lastHeartbeatAt: '' }, // unknown
    ];

    let fetchCount = 0;
    const mockFetch = async (url) => {
      if (url === '/api/devices') {
        fetchCount++;
      }
      return { ok: true, status: 200, json: async () => (url.includes('/snapshots') ? [] : localDevices) };
    };
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(fetchCount, 1, 'should fetch devices once initially');

    const countEl = doc.querySelector('[data-testid="device-filter-count"]') || doc.getElementById('device-filter-count');
    assert.ok(countEl, 'device-filter-count element must exist');
    assert.strictEqual(countEl.textContent, '4 / 4', 'initial count must show all 4 devices');

    const managementFilter = doc.getElementById('device-management-filter');
    assert.ok(managementFilter, 'device-management-filter select element must exist');

    // Filter by 'visible'
    managementFilter.value = 'visible';
    if (managementFilter._listeners.change) managementFilter._listeners.change();
    else if (managementFilter._listeners.input) managementFilter._listeners.input();
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(countEl.textContent, '1 / 4', 'count must show 1 / 4 for visible management filter');
    const deviceListEl = doc.getElementById('device-list');
    const visibleItems = deviceListEl.children.filter((c) => c.className && c.className.includes('device-item'));
    assert.strictEqual(visibleItems.length, 1);
    assert.match(visibleItems[0].textContent, /Aaron-Mac/);

    // Filter by 'missing-ip'
    managementFilter.value = 'missing-ip';
    if (managementFilter._listeners.change) managementFilter._listeners.change();
    else if (managementFilter._listeners.input) managementFilter._listeners.input();
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(countEl.textContent, '1 / 4', 'count must show 1 / 4 for missing-ip management filter');
    const missingIpItems = deviceListEl.children.filter((c) => c.className && c.className.includes('device-item'));
    assert.strictEqual(missingIpItems.length, 1);
    assert.match(missingIpItems[0].textContent, /Beta-Mac/);

    assert.strictEqual(fetchCount, 1, 'should not have refetched /api/devices during filter changes');
  });

  it('DOM test: V0.35 device-management-summary displays counts, clicking bucket control updates device-management-filter value, device list and device-filter-count without refetching /api/devices', async () => {
    const doc = buildMockDoc();
    const localDevices = [
      { deviceId: 'mac-1', hostname: 'Aaron-Mac', status: 'online', ipAddress: '10.0.0.20', snapshotCount: 2, lastHeartbeatAt: '2026-07-04T10:00:00Z' }, // visible
      { deviceId: 'mac-2', hostname: 'Beta-Mac', status: 'online', ipAddress: '', snapshotCount: 0, lastHeartbeatAt: '2026-07-04T10:00:00Z' }, // missing-ip
      { deviceId: 'ipad-3', hostname: 'Design-iPad', status: 'offline', ipAddress: '10.0.0.5', snapshotCount: 8, lastHeartbeatAt: '2026-07-04T09:00:00Z' }, // offline-retained
      { deviceId: 'phone-4', hostname: 'TestPhone', status: '', ipAddress: '192.168.31.9', snapshotCount: 0, lastHeartbeatAt: '' }, // unknown
    ];

    let fetchCount = 0;
    const mockFetch = async (url) => {
      if (url === '/api/devices') {
        fetchCount++;
      }
      return { ok: true, status: 200, json: async () => (url.includes('/snapshots') ? [] : localDevices) };
    };
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(fetchCount, 1, 'should fetch devices once initially');

    const allSummary = doc.querySelector('[data-testid="device-management-summary-all"]');
    const visibleSummary = doc.querySelector('[data-testid="device-management-summary-visible"]');
    const missingIpSummary = doc.querySelector('[data-testid="device-management-summary-missing-ip"]');
    const offlineRetainedSummary = doc.querySelector('[data-testid="device-management-summary-offline-retained"]');
    const unknownSummary = doc.querySelector('[data-testid="device-management-summary-unknown"]');

    assert.ok(allSummary, 'summary-all must render');
    assert.ok(visibleSummary, 'summary-visible must render');
    assert.ok(missingIpSummary, 'summary-missing-ip must render');
    assert.ok(offlineRetainedSummary, 'summary-offline-retained must render');
    assert.ok(unknownSummary, 'summary-unknown must render');

    assert.match(allSummary.textContent, /4/);
    assert.match(visibleSummary.textContent, /1/);
    assert.match(missingIpSummary.textContent, /1/);
    assert.match(offlineRetainedSummary.textContent, /1/);
    assert.match(unknownSummary.textContent, /1/);

    const managementFilter = doc.getElementById('device-management-filter');
    assert.ok(managementFilter, 'management filter element must exist');

    // Click visible summary bucket control
    visibleSummary._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(managementFilter.value, 'visible');

    const countEl = doc.querySelector('[data-testid="device-filter-count"]') || doc.getElementById('device-filter-count');
    assert.strictEqual(countEl.textContent, '1 / 4', 'count must show 1 / 4 after quick switch to visible');

    const deviceListEl = doc.getElementById('device-list');
    const visibleItems = deviceListEl.children.filter((c) => c.className && c.className.includes('device-item'));
    assert.strictEqual(visibleItems.length, 1);
    assert.match(visibleItems[0].textContent, /Aaron-Mac/);

    // Click missing-ip summary bucket control
    missingIpSummary._listeners.click();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(managementFilter.value, 'missing-ip');
    assert.strictEqual(countEl.textContent, '1 / 4');

    // Click all summary bucket control
    allSummary._listeners.click();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(managementFilter.value, 'all');
    assert.strictEqual(countEl.textContent, '4 / 4');

    assert.strictEqual(fetchCount, 1, 'fetch count should remain 1');
  });

  it('DOM test: V0.36 device-management-summary active aria state follows bucket clicks and manual filter changes without refetching /api/devices', async () => {
    const doc = buildMockDoc();
    const localDevices = [
      { deviceId: 'mac-1', hostname: 'Aaron-Mac', status: 'online', ipAddress: '10.0.0.20', snapshotCount: 2, lastHeartbeatAt: '2026-07-04T10:00:00Z' },
      { deviceId: 'mac-2', hostname: 'Beta-Mac', status: 'online', ipAddress: '', snapshotCount: 0, lastHeartbeatAt: '2026-07-04T10:00:00Z' },
      { deviceId: 'ipad-3', hostname: 'Design-iPad', status: 'offline', ipAddress: '10.0.0.5', snapshotCount: 8, lastHeartbeatAt: '2026-07-04T09:00:00Z' },
      { deviceId: 'phone-4', hostname: 'TestPhone', status: '', ipAddress: '192.168.31.9', snapshotCount: 0, lastHeartbeatAt: '' },
    ];

    let fetchCount = 0;
    const mockFetch = async (url) => {
      if (url === '/api/devices') fetchCount++;
      return { ok: true, status: 200, json: async () => (url.includes('/snapshots') ? [] : localDevices) };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    const allSummary = doc.querySelector('[data-testid="device-management-summary-all"]');
    const visibleSummary = doc.querySelector('[data-testid="device-management-summary-visible"]');
    const missingIpSummary = doc.querySelector('[data-testid="device-management-summary-missing-ip"]');
    const unknownSummary = doc.querySelector('[data-testid="device-management-summary-unknown"]');
    const managementFilter = doc.getElementById('device-management-filter');
    const countEl = doc.querySelector('[data-testid="device-filter-count"]') || doc.getElementById('device-filter-count');

    assert.strictEqual(allSummary.getAttribute('aria-pressed'), 'true');
    assert.strictEqual(allSummary.getAttribute('data-active'), 'true');
    assert.match(allSummary.className, /is-active/);
    assert.strictEqual(visibleSummary.getAttribute('aria-pressed'), 'false');

    visibleSummary._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(managementFilter.value, 'visible');
    assert.strictEqual(allSummary.getAttribute('aria-pressed'), 'false');
    assert.strictEqual(visibleSummary.getAttribute('aria-pressed'), 'true');
    assert.strictEqual(visibleSummary.getAttribute('data-active'), 'true');
    assert.match(visibleSummary.className, /is-active/);
    assert.strictEqual(countEl.textContent, '1 / 4');

    managementFilter.value = 'missing-ip';
    managementFilter._listeners.change();
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(missingIpSummary.getAttribute('aria-pressed'), 'true');
    assert.strictEqual(visibleSummary.getAttribute('aria-pressed'), 'false');
    assert.strictEqual(countEl.textContent, '1 / 4');

    managementFilter.value = 'unknown';
    managementFilter._listeners.input();
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(unknownSummary.getAttribute('aria-pressed'), 'true');
    assert.strictEqual(missingIpSummary.getAttribute('aria-pressed'), 'false');
    assert.strictEqual(countEl.textContent, '1 / 4');
    assert.strictEqual(fetchCount, 1, 'active state changes must not refetch /api/devices');
  });

  it('DOM test: V0.37 device-management-summary counts follow search/status scope and ignore management filter changes', async () => {
    const doc = buildMockDoc();
    const localDevices = [
      { deviceId: 'mac-1', hostname: 'Aaron-Mac', status: 'online', ipAddress: '10.0.0.20', snapshotCount: 2, lastHeartbeatAt: '2026-07-04T10:00:00Z' },
      { deviceId: 'mac-2', hostname: 'Beta-Mac', status: 'online', ipAddress: '', snapshotCount: 0, lastHeartbeatAt: '2026-07-04T10:00:00Z' },
      { deviceId: 'ipad-3', hostname: 'Design-iPad', status: 'offline', ipAddress: '10.0.0.5', snapshotCount: 8, lastHeartbeatAt: '2026-07-04T09:00:00Z' },
      { deviceId: 'phone-4', hostname: 'TestPhone', status: '', ipAddress: '192.168.31.9', snapshotCount: 0, lastHeartbeatAt: '' },
    ];

    let fetchCount = 0;
    const mockFetch = async (url) => {
      if (url === '/api/devices') fetchCount++;
      return { ok: true, status: 200, json: async () => (url.includes('/snapshots') ? [] : localDevices) };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    const searchInput = doc.getElementById('device-search');
    const statusFilter = doc.getElementById('device-status-filter');
    const managementFilter = doc.getElementById('device-management-filter');
    const allSummary = doc.querySelector('[data-testid="device-management-summary-all"]');
    const visibleSummary = doc.querySelector('[data-testid="device-management-summary-visible"]');
    const missingIpSummary = doc.querySelector('[data-testid="device-management-summary-missing-ip"]');
    const offlineRetainedSummary = doc.querySelector('[data-testid="device-management-summary-offline-retained"]');
    const unknownSummary = doc.querySelector('[data-testid="device-management-summary-unknown"]');
    const countEl = doc.querySelector('[data-testid="device-filter-count"]') || doc.getElementById('device-filter-count');

    statusFilter.value = 'online';
    statusFilter._listeners.change();
    await new Promise((r) => setTimeout(r, 20));

    assert.match(allSummary.textContent, /2/);
    assert.match(visibleSummary.textContent, /1/);
    assert.match(missingIpSummary.textContent, /1/);
    assert.match(offlineRetainedSummary.textContent, /0/);
    assert.match(unknownSummary.textContent, /0/);
    assert.strictEqual(countEl.textContent, '2 / 4');

    managementFilter.value = 'visible';
    managementFilter._listeners.change();
    await new Promise((r) => setTimeout(r, 20));

    assert.match(allSummary.textContent, /2/, 'management filter must not change scoped summary total');
    assert.match(visibleSummary.textContent, /1/, 'visible bucket stays based on search/status scope');
    assert.match(missingIpSummary.textContent, /1/, 'missing-ip bucket remains available for switching');
    assert.strictEqual(countEl.textContent, '1 / 4');

    searchInput.value = 'Beta';
    searchInput._listeners.input();
    await new Promise((r) => setTimeout(r, 20));

    assert.match(allSummary.textContent, /1/);
    assert.match(visibleSummary.textContent, /0/);
    assert.match(missingIpSummary.textContent, /1/);
    assert.strictEqual(countEl.textContent, '0 / 4');

    missingIpSummary._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(managementFilter.value, 'missing-ip');
    assert.match(allSummary.textContent, /1/);
    assert.match(missingIpSummary.textContent, /1/);
    assert.strictEqual(countEl.textContent, '1 / 4');
    assert.strictEqual(fetchCount, 1, 'scoped summary changes must not refetch /api/devices');
  });

  it('DOM test: V0.39 empty device list shows current filter context without refetching /api/devices', async () => {
    const doc = buildMockDoc();
    const localDevices = [
      { deviceId: 'mac-1', hostname: 'Aaron-Mac', status: 'online', ipAddress: '10.0.0.20', snapshotCount: 2, lastHeartbeatAt: '2026-07-04T10:00:00Z' },
      { deviceId: 'mac-2', hostname: 'Beta-Mac', status: 'online', ipAddress: '', snapshotCount: 0, lastHeartbeatAt: '2026-07-04T10:00:00Z' },
      { deviceId: 'ipad-3', hostname: 'Design-iPad', status: 'offline', ipAddress: '10.0.0.5', snapshotCount: 8, lastHeartbeatAt: '2026-07-04T09:00:00Z' },
      { deviceId: 'phone-4', hostname: 'TestPhone', status: '', ipAddress: '192.168.31.9', snapshotCount: 0, lastHeartbeatAt: '' },
    ];

    let fetchCount = 0;
    const mockFetch = async (url) => {
      if (url === '/api/devices') fetchCount++;
      return { ok: true, status: 200, json: async () => (url.includes('/snapshots') ? [] : localDevices) };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    const searchInput = doc.getElementById('device-search');
    const statusFilter = doc.getElementById('device-status-filter');
    const managementFilter = doc.getElementById('device-management-filter');
    const deviceListEl = doc.getElementById('device-list');
    const countEl = doc.querySelector('[data-testid="device-filter-count"]') || doc.getElementById('device-filter-count');

    searchInput.value = 'NoMatch';
    searchInput._listeners.input();
    await new Promise((r) => setTimeout(r, 20));

    const firstEmptyState = deviceListEl.children.find((c) => c._attrs?.['data-testid'] === 'device-empty-state');
    assert.ok(firstEmptyState, 'empty list must render device-empty-state hook');
    assert.match(firstEmptyState.textContent, /无匹配设备/);
    const firstContext = firstEmptyState.querySelector('[data-testid="device-empty-filter-context"]');
    assert.ok(firstContext, 'empty list must render device-empty-filter-context hook');
    assert.match(firstContext.textContent, /搜索: NoMatch/);
    assert.match(firstContext.textContent, /状态: 全部/);
    assert.match(firstContext.textContent, /管理态: 全部/);
    assert.strictEqual(countEl.textContent, '0 / 4');

    searchInput.value = 'Beta';
    statusFilter.value = 'online';
    managementFilter.value = 'visible';
    statusFilter._listeners.change();
    managementFilter._listeners.change();
    await new Promise((r) => setTimeout(r, 20));

    const secondEmptyState = deviceListEl.children.find((c) => c._attrs?.['data-testid'] === 'device-empty-state');
    assert.ok(secondEmptyState, 'combined filters must still render device-empty-state hook');
    const secondContext = secondEmptyState.querySelector('[data-testid="device-empty-filter-context"]');
    assert.ok(secondContext, 'combined filters must still render device-empty-filter-context hook');
    assert.match(secondContext.textContent, /搜索: Beta/);
    assert.match(secondContext.textContent, /状态: 在线/);
    assert.match(secondContext.textContent, /管理态: 在线可见/);
    assert.strictEqual(countEl.textContent, '0 / 4');
    assert.strictEqual(fetchCount, 1, 'empty-state filter changes must not refetch /api/devices');
  });

  it('DOM test: V0.40 device filter reset button clears all filters and rerenders without refetching /api/devices', async () => {
    const doc = buildMockDoc();
    const localDevices = [
      { deviceId: 'mac-1', hostname: 'Aaron-Mac', status: 'online', ipAddress: '10.0.0.20', snapshotCount: 2, lastHeartbeatAt: '2026-07-04T10:00:00Z' },
      { deviceId: 'mac-2', hostname: 'Beta-Mac', status: 'online', ipAddress: '', snapshotCount: 0, lastHeartbeatAt: '2026-07-04T10:00:00Z' },
      { deviceId: 'ipad-3', hostname: 'Design-iPad', status: 'offline', ipAddress: '10.0.0.5', snapshotCount: 8, lastHeartbeatAt: '2026-07-04T09:00:00Z' },
      { deviceId: 'phone-4', hostname: 'TestPhone', status: '', ipAddress: '192.168.31.9', snapshotCount: 0, lastHeartbeatAt: '' },
    ];

    let fetchCount = 0;
    const mockFetch = async (url) => {
      if (url === '/api/devices') fetchCount++;
      return { ok: true, status: 200, json: async () => (url.includes('/snapshots') ? [] : localDevices) };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(fetchCount, 1, 'initial fetch should happen');

    const searchInput = doc.getElementById('device-search');
    const statusFilter = doc.getElementById('device-status-filter');
    const managementFilter = doc.getElementById('device-management-filter');
    const sortSelect = doc.getElementById('device-sort');
    const deviceListEl = doc.getElementById('device-list');
    const countEl = doc.querySelector('[data-testid="device-filter-count"]') || doc.getElementById('device-filter-count');
    const summaryAll = doc.querySelector('[data-testid="device-management-summary-all"]');
    const summaryVisible = doc.querySelector('[data-testid="device-management-summary-visible"]');
    const resetButton = doc.getElementById('device-filter-reset');

    assert.ok(resetButton, 'device-filter-reset button must exist');

    // 1. Manually set filters to non-default values
    searchInput.value = 'Beta';
    statusFilter.value = 'online';
    managementFilter.value = 'visible';
    sortSelect.value = 'ip';

    // Trigger update
    if (searchInput._listeners.input) searchInput._listeners.input();
    await new Promise((r) => setTimeout(r, 20));

    // Confirm that filter is active
    assert.strictEqual(countEl.textContent, '0 / 4', 'Beta-Mac lacks IP so it is missing-ip, hence 0 matches under visible');
    assert.ok(summaryVisible.className.includes('is-active'), 'visible bucket should be active');

    // 2. Click the reset button
    if (resetButton._listeners.click) resetButton._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    // 3. Verify all fields are reset to default
    assert.strictEqual(searchInput.value, '', 'search input should be cleared');
    assert.strictEqual(statusFilter.value, 'all', 'status filter should be all');
    assert.strictEqual(managementFilter.value, 'all', 'management filter should be all');
    assert.strictEqual(sortSelect.value, 'name', 'sort should be name');

    // 4. Verify count and list are rerendered
    assert.strictEqual(countEl.textContent, '4 / 4', 'count should show all devices');
    const listItems = deviceListEl.children.filter((c) => c.className && c.className.includes('device-item'));
    assert.strictEqual(listItems.length, 4, 'all 4 devices should be rendered');

    // 5. Verify management summary active state updates
    assert.ok(summaryAll.className.includes('is-active'), 'all bucket should be active after reset');
    assert.strictEqual(summaryAll.getAttribute('aria-pressed'), 'true', 'all bucket aria-pressed should be true');
    assert.strictEqual(summaryAll.getAttribute('data-active'), 'true', 'all bucket data-active should be true');
    assert.ok(!summaryVisible.className.includes('is-active'), 'visible bucket should not be active');

    // 6. Verify fetch count did not increase
    assert.strictEqual(fetchCount, 1, 'should not have refetched /api/devices');
  });

  it('DOM test: V0.41 device filter reset state enables only when controls differ from defaults', async () => {
    const doc = buildMockDoc();
    const localDevices = [
      { deviceId: 'mac-1', hostname: 'Aaron-Mac', status: 'online', ipAddress: '10.0.0.20', snapshotCount: 2, lastHeartbeatAt: '2026-07-04T10:00:00Z' },
      { deviceId: 'mac-2', hostname: 'Beta-Mac', status: 'online', ipAddress: '', snapshotCount: 0, lastHeartbeatAt: '2026-07-04T10:00:00Z' },
    ];

    let fetchCount = 0;
    const mockFetch = async (url) => {
      if (url === '/api/devices') fetchCount++;
      return { ok: true, status: 200, json: async () => (url.includes('/snapshots') ? [] : localDevices) };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    const searchInput = doc.getElementById('device-search');
    const statusFilter = doc.getElementById('device-status-filter');
    const managementFilter = doc.getElementById('device-management-filter');
    const sortSelect = doc.getElementById('device-sort');
    const resetButton = doc.getElementById('device-filter-reset');

    assert.ok(resetButton, 'device-filter-reset button must exist');
    assert.strictEqual(resetButton.disabled, true, 'reset button starts disabled');
    assert.strictEqual(resetButton.getAttribute('aria-disabled'), 'true');
    assert.strictEqual(resetButton.getAttribute('data-active'), 'false');

    searchInput.value = 'Beta';
    searchInput._listeners.input();
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(resetButton.disabled, false, 'query change enables reset button');
    assert.strictEqual(resetButton.getAttribute('aria-disabled'), 'false');
    assert.strictEqual(resetButton.getAttribute('data-active'), 'true');

    searchInput.value = '';
    searchInput._listeners.input();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(resetButton.disabled, true, 'returning query to default disables reset button');
    assert.strictEqual(resetButton.getAttribute('data-active'), 'false');

    statusFilter.value = 'online';
    statusFilter._listeners.change();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(resetButton.disabled, false, 'status change enables reset button');

    statusFilter.value = 'all';
    managementFilter.value = 'visible';
    managementFilter._listeners.change();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(resetButton.disabled, false, 'management change enables reset button');

    managementFilter.value = 'all';
    sortSelect.value = 'snapshots';
    sortSelect._listeners.change();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(resetButton.disabled, false, 'sort change enables reset button');

    resetButton._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(searchInput.value, '');
    assert.strictEqual(statusFilter.value, 'all');
    assert.strictEqual(managementFilter.value, 'all');
    assert.strictEqual(sortSelect.value, 'name');
    assert.strictEqual(resetButton.disabled, true, 'reset disables button after restoring defaults');
    assert.strictEqual(resetButton.getAttribute('aria-disabled'), 'true');
    assert.strictEqual(resetButton.getAttribute('data-active'), 'false');
    assert.strictEqual(fetchCount, 1, 'reset state changes must not refetch /api/devices');
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

  it('V0.34 applyDeviceListControls supports controls.management filters and combines them with status and query', () => {
    const localDevices = [
      { deviceId: 'd1', status: 'online', ipAddress: '192.168.1.1', hostname: 'A-PC-One' },
      { deviceId: 'd2', status: 'online', ipAddress: '', hostname: 'B-PC-Two' },
      { deviceId: 'd3', status: 'offline', ipAddress: '192.168.1.3', hostname: 'C-PC-Three' },
      { deviceId: 'd4', status: 'unknown', ipAddress: '192.168.1.4', hostname: 'D-PC-Four' },
      { deviceId: 'd5', status: 'online', ipAddress: '192.168.1.5', hostname: 'E-Laptop' },
    ];

    // management = 'all'
    const resAll = applyDeviceListControls(localDevices, { query: '', status: 'all', management: 'all', sort: 'name' });
    assert.deepStrictEqual(resAll.map(d => d.deviceId), ['d1', 'd2', 'd3', 'd4', 'd5']);

    // management = 'visible'
    const resVisible = applyDeviceListControls(localDevices, { query: '', status: 'all', management: 'visible', sort: 'name' });
    assert.deepStrictEqual(resVisible.map(d => d.deviceId), ['d1', 'd5']);

    // management = 'missing-ip'
    const resMissing = applyDeviceListControls(localDevices, { query: '', status: 'all', management: 'missing-ip', sort: 'name' });
    assert.deepStrictEqual(resMissing.map(d => d.deviceId), ['d2']);

    // management = 'offline-retained'
    const resOffline = applyDeviceListControls(localDevices, { query: '', status: 'all', management: 'offline-retained', sort: 'name' });
    assert.deepStrictEqual(resOffline.map(d => d.deviceId), ['d3']);

    // management = 'unknown'
    const resUnknown = applyDeviceListControls(localDevices, { query: '', status: 'all', management: 'unknown', sort: 'name' });
    assert.deepStrictEqual(resUnknown.map(d => d.deviceId), ['d4']);

    // combining: query = 'PC', status = 'online', management = 'visible' -> matches d1
    const resCombined1 = applyDeviceListControls(localDevices, { query: 'PC', status: 'online', management: 'visible', sort: 'name' });
    assert.deepStrictEqual(resCombined1.map(d => d.deviceId), ['d1']);

    // combining: query = 'PC', status = 'online', management = 'missing-ip' -> matches d2
    const resCombined2 = applyDeviceListControls(localDevices, { query: 'PC', status: 'online', management: 'missing-ip', sort: 'name' });
    assert.deepStrictEqual(resCombined2.map(d => d.deviceId), ['d2']);

    // verify no mutation
    assert.strictEqual(localDevices.length, 5);
    assert.strictEqual(localDevices[0].deviceId, 'd1');
  });
});

// ── V0.20 Event Log Panel unit tests ───────────────────────────────────

describe('V0.20 Event Log Panel unit tests', () => {
  it('initConsole() renders structured event entries with child hooks', async () => {
    const doc = buildMockDoc();
    const devices = [];
    const mockFetch = async () => ({ ok: true, status: 200, json: async () => devices });
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));

    const eventLogEl = doc.getElementById('event-log');
    assert.ok(eventLogEl, 'event-log element must exist');

    const entries = eventLogEl.children.filter(
      (el) => el._attrs?.['data-testid'] === 'event-entry'
    );
    assert.ok(entries.length > 0, 'must render event-entry element(s)');

    const entry = entries.find(el => el.textContent.includes('Linke 控制台已启动')) || entries[0];
    assert.strictEqual(entry._attrs['data-event-type'], 'info');

    // Check child hooks
    const timeEl = entry.children.find((el) => el._attrs?.['data-testid'] === 'event-entry-time');
    const typeEl = entry.children.find((el) => el._attrs?.['data-testid'] === 'event-entry-type');
    const messageEl = entry.children.find((el) => el._attrs?.['data-testid'] === 'event-entry-message');

    assert.ok(timeEl, 'must have event-entry-time child hook');
    assert.ok(typeEl, 'must have event-entry-type child hook');
    assert.ok(messageEl, 'must have event-entry-message child hook');

    assert.strictEqual(typeEl.textContent, 'info', 'typeEl textContent must be info');
    assert.ok(messageEl.textContent.includes('Linke 控制台已启动'), 'message hook must contain the logged message');
  });

  it('Device load failure renders an error event as text', async () => {
    const doc = buildMockDoc();
    const mockFetch = async () => {
      throw new Error('Connection refused');
    };
    const mockInterval = () => 0;

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));

    const eventLogEl = doc.getElementById('event-log');
    const entries = eventLogEl.children.filter(
      (el) => el._attrs?.['data-testid'] === 'event-entry'
    );

    const errorEntry = entries.find((el) => el._attrs?.['data-event-type'] === 'error');
    assert.ok(errorEntry, 'must log an error event on load failure');

    const typeEl = errorEntry.children.find((el) => el._attrs?.['data-testid'] === 'event-entry-type');
    const messageEl = errorEntry.children.find((el) => el._attrs?.['data-testid'] === 'event-entry-message');
    assert.ok(typeEl, 'must have event-entry-type hook');
    assert.ok(messageEl, 'must have event-entry-message hook');
    assert.strictEqual(typeEl.textContent, 'error', 'typeEl textContent must be error');
    assert.ok(messageEl.textContent.includes('Connection refused'), 'must render error message as text');
  });

  it('Newest event appears first', async () => {
    const doc = buildMockDoc();
    const devices = [];
    let fetchCount = 0;
    const mockFetch = async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return { ok: true, status: 200, json: async () => devices };
      } else {
        throw new Error('Failure ' + fetchCount);
      }
    };
    let intervalCallback;
    const mockInterval = (fn) => {
      intervalCallback = fn;
      return 123;
    };

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(intervalCallback, 'should register interval callback');
    await intervalCallback();
    await new Promise((r) => setTimeout(r, 20));

    const eventLogEl = doc.getElementById('event-log');
    const entries = eventLogEl.children.filter(
      (el) => el._attrs?.['data-testid'] === 'event-entry'
    );

    assert.ok(entries.length >= 2, 'should have at least two entries');
    const firstEntry = entries[0];
    assert.strictEqual(firstEntry._attrs['data-event-type'], 'error', 'newest event must be error');
    const firstMsgEl = firstEntry.children.find((el) => el._attrs?.['data-testid'] === 'event-entry-message');
    assert.ok(firstMsgEl.textContent.includes('Failure 2'), 'first entry must be the newest message');
  });

  it('Visible event entries are capped at 50, and cumulative counts are not reduced', async () => {
    const doc = buildMockDoc();
    const devices = [];
    let fetchCount = 0;
    const mockFetch = async () => {
      fetchCount++;
      if (fetchCount <= 30) {
        return { ok: true, status: 200, json: async () => devices };
      } else {
        throw new Error('Simulated failure ' + fetchCount);
      }
    };
    let intervalCallback;
    const mockInterval = (fn) => {
      intervalCallback = fn;
      return 123;
    };

    initConsole(doc, mockFetch, mockInterval);
    await new Promise((r) => setTimeout(r, 20));

    for (let i = 0; i < 59; i++) {
      await intervalCallback();
    }
    await new Promise((r) => setTimeout(r, 20));

    const eventLogEl = doc.getElementById('event-log');
    const entries = eventLogEl.children.filter(
      (el) => el._attrs?.['data-testid'] === 'event-entry'
    );

    assert.strictEqual(entries.length, 50, 'visible entries must be capped at 50');

    const totalCountEl = doc.getElementById('event-total-count');
    const infoCountEl = doc.getElementById('event-info-count');
    const errorCountEl = doc.getElementById('event-error-count');
    const latestMessageEl = doc.getElementById('event-latest-message');

    assert.strictEqual(totalCountEl.textContent, '61', 'cumulative total count must show 61');
    assert.strictEqual(infoCountEl.textContent, '31', 'cumulative info count must show 31');
    assert.strictEqual(errorCountEl.textContent, '30', 'cumulative error count must show 30');
    assert.ok(latestMessageEl.textContent.includes('Simulated failure 60'), 'latest message must show latest log content');
  });
});

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
        lastHeartbeatAt: '2025-07-05T11:00:00.000Z',
        lastBackupAt: '',
      },
      {
        deviceId: 'healthy-device',
        hostname: 'Healthy',
        ipAddress: '10.0.0.1',
        status: 'online',
        snapshotCount: 2,
        lastHeartbeatAt: '2025-07-05T11:00:00.000Z',
        lastBackupAt: '2025-07-05T10:00:00.000Z',
      },
      {
        deviceId: 'future-device',
        hostname: 'FutureBackup',
        ipAddress: '10.0.0.3',
        status: 'online',
        snapshotCount: 1,
        lastHeartbeatAt: '2025-07-05T11:00:00.000Z',
        lastBackupAt: '2999-01-01T00:00:00.000Z',
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
    assert.strictEqual(doc.querySelector('[data-testid="device-health-attention-count"]').textContent, '2');
    assert.strictEqual(doc.querySelector('[data-testid="device-health-offline-count"]').textContent, '0');
    assert.strictEqual(doc.querySelector('[data-testid="device-health-unknown-count"]').textContent, '0');

    const items = doc._created.filter((el) => el._attrs?.['data-testid'] === 'device-health-item');
    assert.strictEqual(items.length, 3);
    assert.strictEqual(items[0].dataset.healthStatus, 'attention');
    assert.strictEqual(items[0].querySelector('[data-testid="device-health-reason"]').textContent, '缺少有效备份');
    assert.strictEqual(items[1].dataset.healthStatus, 'attention');
    assert.strictEqual(items[1].querySelector('[data-testid="device-health-name"]').textContent, 'FutureBackup');
    assert.strictEqual(items[1].querySelector('[data-testid="device-health-reason"]').textContent, '缺少有效备份');
    assert.strictEqual(items[2].dataset.healthStatus, 'healthy');
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
      lastHeartbeatAt: '2025-07-05T11:00:00.000Z',
      lastBackupAt: '2025-07-05T10:00:00.000Z',
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
          lastBackupAt: '2025-07-05T10:00:00.000Z',
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

describe('V0.22 Backup Version Consistency Panel unit tests', () => {
  it('initConsole() renders version consistency summary and groups after devices load', async () => {
    const doc = buildMockDoc();
    const devices = [
      { deviceId: 'mac-a', hostname: 'Mac A', status: 'online', snapshotCount: 3 },
      { deviceId: 'mac-b', hostname: 'Mac B', status: 'online', snapshotCount: 2 },
    ];
    const snapshotsByDevice = {
      'mac-a': [
        {
          snapshotId: 'a-docs-new',
          jobName: 'documents',
          sourcePath: '/Users/ah/Documents',
          createdAt: '2026-07-05T10:00:00.000Z',
          fileCount: 10,
        },
        {
          snapshotId: 'a-config',
          jobName: 'configs',
          sourcePath: '/Users/ah/.config',
          createdAt: '2026-07-05T08:00:00.000Z',
          fileCount: 4,
        },
        {
          snapshotId: 'a-photos',
          jobName: 'photos',
          sourcePath: '/Users/ah/Pictures',
          createdAt: '2026-07-05T07:00:00.000Z',
          fileCount: 20,
        },
      ],
      'mac-b': [
        {
          snapshotId: 'b-docs-stale',
          jobName: 'documents',
          sourcePath: '/Users/ah/Documents',
          createdAt: '2026-07-05T09:00:00.000Z',
          fileCount: 9,
        },
        {
          snapshotId: 'b-config',
          jobName: 'configs',
          sourcePath: '/Users/ah/.config',
          createdAt: '2026-07-05T08:00:00.000Z',
          fileCount: 4,
        },
      ],
    };
    const mockFetch = async (url) => {
      if (url === '/api/devices') {
        return { ok: true, status: 200, json: async () => devices };
      }
      const match = String(url).match(/^\/api\/devices\/([^/]+)\/snapshots$/);
      if (match) {
        return { ok: true, status: 200, json: async () => snapshotsByDevice[decodeURIComponent(match[1])] || [] };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 40));

    assert.strictEqual(doc.querySelector('[data-testid="version-consistency-synced-count"]').textContent, '1');
    assert.strictEqual(doc.querySelector('[data-testid="version-consistency-drifted-count"]').textContent, '1');
    assert.strictEqual(doc.querySelector('[data-testid="version-consistency-single-count"]').textContent, '1');
    assert.strictEqual(doc.querySelector('[data-testid="version-consistency-total-count"]').textContent, '3');

    const groups = doc._created.filter((el) => el._attrs?.['data-testid'] === 'version-consistency-item');
    assert.strictEqual(groups.length, 3);
    assert.strictEqual(groups[0].dataset.versionStatus, 'drifted');
    assert.strictEqual(groups[0].querySelector('[data-testid="version-consistency-name"]').textContent, 'documents');
    assert.strictEqual(groups[0].querySelector('[data-testid="version-consistency-status"]').textContent, '版本不一致');
    assert.match(groups[0].querySelector('[data-testid="version-consistency-reason"]').textContent, /2 台设备/);
    assert.strictEqual(groups[1].dataset.versionStatus, 'single-device');
    assert.strictEqual(groups[2].dataset.versionStatus, 'synced');

    const summary0 = groups[0].querySelector('[data-testid="version-consistency-staleness-summary"]');
    assert.ok(summary0, 'Group 0 must have a staleness summary element');
    assert.match(summary0.textContent, /最新/);
    assert.match(summary0.textContent, /非最新/);
    assert.match(summary0.textContent, /单设备/);
    assert.match(summary0.textContent, /最大时间差/);

    const coverageSummary = doc.querySelector('[data-testid="version-consistency-coverage-summary"]');
    assert.ok(coverageSummary);
    assert.match(coverageSummary.textContent, /基于 2 台可观测设备检测/);
    assert.match(coverageSummary.textContent, /排除加载失败: 0 台/);
    assert.match(coverageSummary.textContent, /完全覆盖任务数: 2/);
    assert.match(coverageSummary.textContent, /覆盖缺口任务数: 1/);

    const covGap0 = groups[0].querySelector('[data-testid="version-consistency-coverage-gap"]');
    assert.ok(covGap0);
    assert.strictEqual(covGap0.textContent, '覆盖 2 / 2 · 覆盖率 100%');

    const covGap1 = groups[1].querySelector('[data-testid="version-consistency-coverage-gap"]');
    assert.ok(covGap1);
    assert.strictEqual(covGap1.textContent, '覆盖 1 / 2 · 覆盖率 50% · 缺 Mac B');
  });

  it('fetchBackupVersionConsistency excludes devices that failed to load from coverage calculation', async () => {
    const doc = buildMockDoc();
    const devices = [
      { deviceId: 'mac-a', hostname: 'Mac A', status: 'online', snapshotCount: 1 },
      { deviceId: 'mac-b', hostname: 'Mac B', status: 'online', snapshotCount: 1 },
      { deviceId: 'mac-failed', hostname: 'Mac Failed', status: 'online', snapshotCount: 1 },
    ];
    const mockFetch = async (url) => {
      if (url === '/api/devices') {
        return { ok: true, status: 200, json: async () => devices };
      }
      const match = String(url).match(/^\/api\/devices\/([^/]+)\/snapshots$/);
      if (match) {
        const id = decodeURIComponent(match[1]);
        if (id === 'mac-failed') {
          return { ok: false, status: 500 };
        }
        return {
          ok: true,
          status: 200,
          json: async () => [
            { snapshotId: id + '-snap', jobName: 'docs', sourcePath: '/docs', createdAt: '2026-07-05T10:00:00.000Z', fileCount: 10 }
          ]
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 40));

    const coverageSummary = doc.querySelector('[data-testid="version-consistency-coverage-summary"]');
    assert.ok(coverageSummary);
    assert.match(coverageSummary.textContent, /基于 2 台可观测设备检测/);
    assert.match(coverageSummary.textContent, /排除加载失败: 1 台/);
  });

  it('renders version consistency text as textContent without innerHTML injection', async () => {
    const doc = buildMockDoc();
    const devices = [{ deviceId: 'mac-x', hostname: '<b>Mac</b>', status: 'online', snapshotCount: 1 }];
    const mockFetch = async (url) => {
      if (url === '/api/devices') {
        return { ok: true, status: 200, json: async () => devices };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ([{
          snapshotId: 'x-1',
          jobName: '<script>alert(1)</script>',
          sourcePath: '/tmp/<unsafe>',
          createdAt: '2026-07-05T08:00:00.000Z',
          fileCount: 1,
        }]),
      };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 40));

    const item = doc._created.find((el) => el._attrs?.['data-testid'] === 'version-consistency-item');
    assert.ok(item, 'version-consistency-item must be rendered');
    assert.strictEqual(item.innerHTML || '', '');
    assert.strictEqual(item.querySelector('[data-testid="version-consistency-name"]').textContent, '<script>alert(1)</script>');
    assert.strictEqual(item.querySelector('[data-testid="version-consistency-source"]').textContent, '/tmp/<unsafe>');
  });

  it('clicking a version consistency device row loads that snapshot manifest and restore dry-run', async () => {
    const doc = buildMockDoc();
    doc.getElementById('restore-dry-run-target').value = '/tmp/linke';
    const calls = [];
    const devices = [
      { deviceId: 'mac-a', hostname: 'Mac A', status: 'online', snapshotCount: 1 },
      { deviceId: 'mac-b', hostname: 'Mac B', status: 'online', snapshotCount: 1 },
    ];
    const snapshotsByDevice = {
      'mac-a': [{
        snapshotId: 'a-docs-new',
        jobName: 'documents',
        sourcePath: '/Users/ah/Documents',
        createdAt: '2026-07-05T10:00:00.000Z',
        fileCount: 10,
      }],
      'mac-b': [{
        snapshotId: 'b-docs-stale',
        jobName: 'documents',
        sourcePath: '/Users/ah/Documents',
        createdAt: '2026-07-05T09:00:00.000Z',
        fileCount: 9,
      }],
    };
    const mockFetch = async (url) => {
      calls.push(url);
      if (url === '/api/devices') {
        return { ok: true, status: 200, json: async () => devices };
      }
      if (String(url).includes('/manifest')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            snapshotId: 'b-docs-stale',
            sourcePath: '/Users/ah/Documents',
            createdAt: '2026-07-05T09:00:00.000Z',
            files: ['doc.txt'],
          }),
        };
      }
      if (String(url).includes('/restore-dry-run')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ summary: { wouldCreateCount: 1, wouldOverwriteCount: 0 }, files: [] }),
        };
      }
      if (String(url).includes('/retention-dry-run')) {
        return { ok: true, status: 200, json: async () => ({ keepCount: 1, wouldDeleteCount: 0, snapshots: [] }) };
      }
      const snapshotMatch = String(url).match(/^\/api\/devices\/([^/]+)\/snapshots$/);
      if (snapshotMatch) {
        return {
          ok: true,
          status: 200,
          json: async () => snapshotsByDevice[decodeURIComponent(snapshotMatch[1])] || [],
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 40));

    const versionDevices = doc._created.filter((el) => el._attrs?.['data-testid'] === 'version-consistency-device');
    const macBRow = versionDevices.find((el) => el.textContent.includes('Mac B'));
    assert.ok(macBRow, 'Mac B version row must be rendered');
    assert.strictEqual(macBRow.dataset.deviceId, 'mac-b');
    assert.strictEqual(macBRow.dataset.snapshotId, 'b-docs-stale');
    assert.strictEqual(macBRow.dataset.versionState, 'stale');
    assert.ok(macBRow._listeners.click, 'version device row must be clickable');

    macBRow._listeners.click();
    await new Promise((r) => setTimeout(r, 40));

    assert.ok(calls.includes('/api/devices/mac-b/snapshots'), 'must refresh clicked device snapshots');
    assert.ok(calls.some((url) => String(url).includes('/api/devices/mac-b/retention-dry-run')), 'must refresh retention dry-run');
    assert.ok(calls.includes('/api/devices/mac-b/snapshots/b-docs-stale/manifest'), 'must load selected snapshot manifest');
    assert.ok(
      calls.includes('/api/devices/mac-b/snapshots/b-docs-stale/restore-dry-run?targetPath=%2Ftmp%2Flinke'),
      'must load selected snapshot restore dry-run',
    );
    assert.strictEqual(doc.querySelector('[data-testid="device-detail-device-id"]').textContent, 'mac-b');
    assert.strictEqual(doc.querySelector('[data-testid="manifest-snapshot-id"]').textContent, 'b-docs-stale');
    assert.strictEqual(doc.querySelector('[data-testid="restore-dry-run-create-count"]').textContent, '1');
  });

  it('filters version consistency groups by status and search without refetching snapshots', async () => {
    const doc = buildMockDoc();
    const calls = [];
    const devices = [
      { deviceId: 'mac-a', hostname: 'Mac A', ipAddress: '10.0.0.1', status: 'online', snapshotCount: 3 },
      { deviceId: 'mac-b', hostname: 'Mac B', ipAddress: '10.0.0.2', status: 'online', snapshotCount: 2 },
    ];
    const snapshotsByDevice = {
      'mac-a': [
        {
          snapshotId: 'a-docs-new',
          jobName: 'documents',
          sourcePath: '/Users/ah/Documents',
          createdAt: '2026-07-05T10:00:00.000Z',
          fileCount: 10,
        },
        {
          snapshotId: 'a-config',
          jobName: 'configs',
          sourcePath: '/Users/ah/.config',
          createdAt: '2026-07-05T08:00:00.000Z',
          fileCount: 4,
        },
        {
          snapshotId: 'a-photos',
          jobName: 'photos',
          sourcePath: '/Users/ah/Pictures',
          createdAt: '2026-07-05T07:00:00.000Z',
          fileCount: 20,
        },
      ],
      'mac-b': [
        {
          snapshotId: 'b-docs-stale',
          jobName: 'documents',
          sourcePath: '/Users/ah/Documents',
          createdAt: '2026-07-05T09:00:00.000Z',
          fileCount: 9,
        },
        {
          snapshotId: 'b-config',
          jobName: 'configs',
          sourcePath: '/Users/ah/.config',
          createdAt: '2026-07-05T08:00:00.000Z',
          fileCount: 4,
        },
      ],
    };
    const mockFetch = async (url) => {
      calls.push(url);
      if (url === '/api/devices') {
        return { ok: true, status: 200, json: async () => devices };
      }
      const match = String(url).match(/^\/api\/devices\/([^/]+)\/snapshots$/);
      if (match) {
        return { ok: true, status: 200, json: async () => snapshotsByDevice[decodeURIComponent(match[1])] || [] };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 40));

    const list = doc.getElementById('version-consistency-list');
    const search = doc.getElementById('version-consistency-search');
    const statusFilter = doc.getElementById('version-consistency-status-filter');
    const sortSelect = doc.getElementById('version-consistency-sort');
    const initialCallCount = calls.length;

    assert.strictEqual(list.children.length, 3);
    assert.ok(search._listeners.input, 'search input must have input listener');
    assert.ok(statusFilter._listeners.change, 'status filter must have change listener');
    assert.ok(sortSelect._listeners.change, 'sort select must have change listener');

    sortSelect.value = 'name';
    sortSelect._listeners.change();

    assert.strictEqual(list.children.length, 3);
    assert.ok(list.children[0].textContent.includes('configs'));
    assert.ok(list.children[1].textContent.includes('documents'));
    assert.ok(list.children[2].textContent.includes('photos'));
    assert.strictEqual(calls.length, initialCallCount, 'sorting must not refetch snapshots');

    sortSelect.value = 'risk';
    sortSelect._listeners.change();

    search.value = '10.0.0.2';
    search._listeners.input();

    assert.strictEqual(list.children.length, 2);
    assert.strictEqual(doc.querySelector('[data-testid="version-consistency-filter-count"]').textContent, '2 / 3');
    assert.ok(list.children[0].textContent.includes('documents'));
    assert.ok(list.children[1].textContent.includes('configs'));
    assert.strictEqual(calls.length, initialCallCount, 'filtering must not refetch snapshots');

    statusFilter.value = 'drifted';
    statusFilter._listeners.change();

    assert.strictEqual(list.children.length, 1);
    assert.ok(list.children[0].textContent.includes('documents'));
    assert.strictEqual(list.children[0].dataset.versionStatus, 'drifted');
    assert.strictEqual(doc.querySelector('[data-testid="version-consistency-filter-count"]').textContent, '1 / 3');
    assert.strictEqual(calls.length, initialCallCount, 'status filtering must not refetch snapshots');

    search.value = 'not-found';
    search._listeners.input();

    assert.strictEqual(list.children.length, 1);
    assert.strictEqual(list.children[0].className, 'placeholder');
    assert.strictEqual(list.children[0].textContent, '无匹配版本一致性任务');
    assert.strictEqual(doc.querySelector('[data-testid="version-consistency-filter-count"]').textContent, '0 / 3');

    // 重置状态与搜索后验证覆盖筛选
    statusFilter.value = 'all';
    statusFilter._listeners.change();
    search.value = '';
    search._listeners.input();

    const coverageFilter = doc.getElementById('version-consistency-coverage-filter');
    assert.ok(coverageFilter._listeners.change, 'coverage filter must have change listener');

    coverageFilter.value = 'gap';
    coverageFilter._listeners.change();

    assert.strictEqual(list.children.length, 1);
    assert.ok(list.children[0].textContent.includes('photos'));
    assert.strictEqual(doc.querySelector('[data-testid="version-consistency-filter-count"]').textContent, '1 / 3');
    assert.strictEqual(calls.length, initialCallCount, 'coverage filtering must not refetch snapshots');

    coverageFilter.value = 'full';
    coverageFilter._listeners.change();

    assert.strictEqual(list.children.length, 2);
    const textOfChildren = Array.from(list.children).map(c => c.textContent);
    assert.ok(textOfChildren.some(t => t.includes('documents')));
    assert.ok(textOfChildren.some(t => t.includes('configs')));
    assert.strictEqual(doc.querySelector('[data-testid="version-consistency-filter-count"]').textContent, '2 / 3');
    assert.strictEqual(calls.length, initialCallCount, 'coverage filtering must not refetch snapshots');

    coverageFilter.value = 'unobservable';
    coverageFilter._listeners.change();

    assert.strictEqual(list.children.length, 1);
    assert.strictEqual(list.children[0].className, 'placeholder');
    assert.strictEqual(list.children[0].textContent, '无匹配版本一致性任务');
    assert.strictEqual(doc.querySelector('[data-testid="version-consistency-filter-count"]').textContent, '0 / 3');
    assert.strictEqual(calls.length, initialCallCount, 'coverage filtering must not refetch snapshots');
  });

  it('DOM test selecting sort coverage-gap reorders already loaded groups and does not refetch', async () => {
    const doc = buildMockDoc();
    const calls = [];
    const devices = [
      { deviceId: 'mac-a', hostname: 'Mac A', ipAddress: '10.0.0.1', status: 'online', snapshotCount: 3 },
      { deviceId: 'mac-b', hostname: 'Mac B', ipAddress: '10.0.0.2', status: 'online', snapshotCount: 2 },
    ];
    const snapshotsByDevice = {
      'mac-a': [
        {
          snapshotId: 'a-docs-new',
          jobName: 'documents',
          sourcePath: '/Users/ah/Documents',
          createdAt: '2026-07-05T10:00:00.000Z',
          fileCount: 10,
        },
        {
          snapshotId: 'a-config',
          jobName: 'configs',
          sourcePath: '/Users/ah/.config',
          createdAt: '2026-07-05T08:00:00.000Z',
          fileCount: 4,
        },
        {
          snapshotId: 'a-photos',
          jobName: 'photos',
          sourcePath: '/Users/ah/Pictures',
          createdAt: '2026-07-05T07:00:00.000Z',
          fileCount: 20,
        },
      ],
      'mac-b': [
        {
          snapshotId: 'b-docs-stale',
          jobName: 'documents',
          sourcePath: '/Users/ah/Documents',
          createdAt: '2026-07-05T09:00:00.000Z',
          fileCount: 9,
        },
        {
          snapshotId: 'b-config',
          jobName: 'configs',
          sourcePath: '/Users/ah/.config',
          createdAt: '2026-07-05T08:00:00.000Z',
          fileCount: 4,
        },
      ],
    };
    const mockFetch = async (url) => {
      calls.push(url);
      if (url === '/api/devices') {
        return { ok: true, status: 200, json: async () => devices };
      }
      const match = String(url).match(/^\/api\/devices\/([^/]+)\/snapshots$/);
      if (match) {
        return { ok: true, status: 200, json: async () => snapshotsByDevice[decodeURIComponent(match[1])] || [] };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 40));

    const list = doc.getElementById('version-consistency-list');
    const sortSelect = doc.getElementById('version-consistency-sort');
    const initialCallCount = calls.length;

    assert.strictEqual(list.children.length, 3);

    sortSelect.value = 'coverage-gap';
    sortSelect._listeners.change();

    assert.strictEqual(list.children.length, 3);
    assert.ok(list.children[0].textContent.includes('photos'), 'photos (missing = 1) must be first');
    assert.ok(list.children[1].textContent.includes('documents'), 'documents (missing = 0, drifted) must be second');
    assert.ok(list.children[2].textContent.includes('configs'), 'configs (missing = 0, synced) must be third');
    assert.strictEqual(calls.length, initialCallCount, 'sorting must not refetch snapshots');
  });

  it('V0.31 DOM test: coverage row shows coverage ratio percentage, handles expectedDeviceCount <= 0 by showing fallback, and handles expectedDeviceCount > 0 by not showing fallback', async () => {
    const doc = buildMockDoc();
    const devices = [
      { deviceId: 'mac-a', hostname: 'Mac A', status: 'online', snapshotCount: 1 },
      { deviceId: 'mac-b', hostname: 'Mac B', status: 'online', snapshotCount: 1 },
      { deviceId: 'mac-c', hostname: 'Mac C', status: 'online', snapshotCount: 1 },
    ];
    const snapshotsByDevice = {
      'mac-a': [
        {
          snapshotId: 'a-job1',
          jobName: 'job1-coverage-67',
          sourcePath: '/Users/ah/job1',
          createdAt: '2026-07-05T10:00:00.000Z',
          fileCount: 10,
        },
      ],
      'mac-b': [
        {
          snapshotId: 'b-job1',
          jobName: 'job1-coverage-67',
          sourcePath: '/Users/ah/job1',
          createdAt: '2026-07-05T10:00:00.000Z',
          fileCount: 10,
        },
      ],
      'mac-c': [],
    };

    const mockFetch = async (url) => {
      if (url === '/api/devices') {
        return { ok: true, status: 200, json: async () => devices };
      }
      const match = String(url).match(/^\/api\/devices\/([^/]+)\/snapshots$/);
      if (match) {
        return { ok: true, status: 200, json: async () => snapshotsByDevice[decodeURIComponent(match[1])] || [] };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 40));

    const groups = doc._created.filter((el) => el._attrs?.['data-testid'] === 'version-consistency-item');
    const jobGroup = groups.find((g) => g.querySelector('[data-testid="version-consistency-name"]').textContent.includes('job1-coverage-67'));
    assert.ok(jobGroup, 'job1-coverage-67 group must be rendered');

    const covGap = jobGroup.querySelector('[data-testid="version-consistency-coverage-gap"]');
    assert.ok(covGap, 'coverage gap element must be rendered');

    // 1. coverage row must show 覆盖率 67% for coveredDeviceCount 2 / expectedDeviceCount 3
    assert.match(covGap.textContent, /覆盖率 67%/, 'coverage ratio text must contain "覆盖率 67%"');
    // 2. coverage row must not contain "无可观测设备" when expectedDeviceCount > 0
    assert.ok(!covGap.textContent.includes('无可观测设备'), 'group with expectedDeviceCount > 0 must not contain "无可观测设备"');

    // 3. a rendered group with expectedDeviceCount 0 must contain "无可观测设备" and must still not contain "覆盖率"
    const docExcl = buildMockDoc();
    let callCount = 0;
    const mockFetchExcl = async (url) => {
      if (url === '/api/devices') {
        return { ok: true, status: 200, json: async () => [
          { deviceId: 'mac-z', hostname: 'Mac Z' },
          { deviceId: 'mac-z', hostname: 'Mac Z' },
        ] };
      }
      if (url === '/api/devices/mac-z/snapshots') {
        callCount++;
        if (callCount === 1) {
          return { ok: false, status: 500 };
        } else {
          return { ok: true, status: 200, json: async () => [
            { snapshotId: 'z1', jobName: 'job-zero-expected', sourcePath: '/path-z', createdAt: '2026-07-05T10:00:00.000Z' }
          ] };
        }
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(docExcl, mockFetchExcl, () => 0);
    await new Promise((r) => setTimeout(r, 40));

    const groupsExcl = docExcl._created.filter((el) => el._attrs?.['data-testid'] === 'version-consistency-item');
    const zeroGroup = groupsExcl.find((g) => g.querySelector('[data-testid="version-consistency-name"]').textContent.includes('job-zero-expected'));
    assert.ok(zeroGroup, 'job-zero-expected group must be rendered');

    const zeroCovGap = zeroGroup.querySelector('[data-testid="version-consistency-coverage-gap"]');
    assert.ok(zeroCovGap, 'zero coverage gap element must be rendered');
    assert.ok(zeroCovGap.textContent.includes('无可观测设备'), 'group with expectedDeviceCount 0 must contain "无可观测设备"');
    assert.ok(!zeroCovGap.textContent.includes('覆盖率'), 'group with expectedDeviceCount 0 must not contain "覆盖率"');
  });
});

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
      {
        hostname: '',
        ipAddress: '',
        status: 'sleeping',
        snapshotCount: 0,
        lastHeartbeatAt: 'invalid',
        lastBackupAt: 'invalid',
      },
    ], now);

    assert.deepStrictEqual(result.summary, {
      healthy: 1,
      attention: 1,
      offline: 1,
      unknown: 2,
      total: 5,
    });

    assert.deepStrictEqual(result.items.map((item) => item.healthStatus), [
      'attention',
      'offline',
      'unknown',
      'unknown',
      'healthy',
    ]);
    assert.strictEqual(result.items[0].healthLabel, '需关注');
    assert.strictEqual(result.items[0].healthReason, '缺少有效备份');
    assert.strictEqual(result.items[2].hostname, 'unknown');
    assert.strictEqual(result.items[2].ipAddress, 'unknown');
    assert.strictEqual(result.items[2].snapshotCount, 0);
    assert.strictEqual(result.items[3].hostname, 'unknown-device');
    assert.strictEqual(result.items[3].ipAddress, 'unknown');
    assert.strictEqual(result.items[3].snapshotCount, 0);
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

describe('V0.22 backup version consistency pure functions', () => {
  it('groups latest snapshots across devices and classifies synced, drifted, and single-device groups', () => {
    const result = buildBackupVersionConsistency(
      [
        { deviceId: 'mac-a', hostname: 'Mac A' },
        { deviceId: 'mac-b', hostname: 'Mac B' },
      ],
      {
        'mac-a': [
          {
            snapshotId: 'a-docs-new',
            jobName: 'documents',
            sourcePath: '/Users/ah/Documents',
            createdAt: '2026-07-05T10:00:00.000Z',
            fileCount: 10,
          },
          {
            snapshotId: 'a-docs-old',
            jobName: 'documents',
            sourcePath: '/Users/ah/Documents',
            createdAt: '2026-07-05T08:00:00.000Z',
            fileCount: 8,
          },
          {
            snapshotId: 'a-config',
            jobName: 'configs',
            sourcePath: '/Users/ah/.config',
            createdAt: '2026-07-05T07:00:00.000Z',
            fileCount: 5,
          },
          {
            snapshotId: 'a-photos',
            jobName: 'photos',
            sourcePath: '/Users/ah/Pictures',
            createdAt: '2026-07-05T06:00:00.000Z',
            fileCount: 20,
          },
        ],
        'mac-b': [
          {
            snapshotId: 'b-docs',
            jobName: 'documents',
            sourcePath: '/Users/ah/Documents',
            createdAt: '2026-07-05T09:00:00.000Z',
            fileCount: 9,
          },
          {
            snapshotId: 'b-config',
            jobName: 'configs',
            sourcePath: '/Users/ah/.config',
            createdAt: '2026-07-05T07:00:00.000Z',
            fileCount: 5,
          },
        ],
      },
    );

    assert.deepStrictEqual(result.summary, {
      synced: 1,
      drifted: 1,
      singleDevice: 1,
      total: 3,
      coverage: {
        coverageDeviceCount: 2,
        coverageExcludedDeviceCount: 0,
        coverageGapCount: 1,
        fullyCoveredCount: 2,
      }
    });
    assert.strictEqual(result.groups[0].status, 'drifted');
    assert.strictEqual(result.groups[0].jobName, 'documents');
    assert.strictEqual(result.groups[0].devices[0].deviceId, 'mac-a');
    assert.strictEqual(result.groups[0].devices[0].versionState, 'latest');
    assert.strictEqual(result.groups[0].devices[1].versionState, 'stale');

    // V0.25 fields
    assert.strictEqual(result.groups[0].latestCount, 1);
    assert.strictEqual(result.groups[0].staleCount, 1);
    assert.strictEqual(result.groups[0].singleCount, 0);
    assert.strictEqual(result.groups[0].maxTimeDriftMs, 60 * 60 * 1000);
    assert.deepStrictEqual(result.groups[0].staleDeviceNames, ['Mac B']);

    assert.strictEqual(result.groups[1].status, 'single-device');
    assert.strictEqual(result.groups[1].singleCount, 1);

    assert.strictEqual(result.groups[2].status, 'synced');
    assert.strictEqual(result.groups[2].staleCount, 0);
    assert.strictEqual(result.groups[2].maxTimeDriftMs, null);
  });

  describe('V0.27 version coverage gap summary pure functions', () => {
    it('builds coverage gap summary and group coverage fields correctly', () => {
      const devices = [
        { deviceId: 'mac-a', hostname: 'Mac A' },
        { deviceId: 'mac-b', hostname: 'Mac B' },
        { deviceId: 'mac-c', hostname: 'Mac C' },
      ];
      const snapshotsByDevice = {
        'mac-a': [
          { snapshotId: 'a1', jobName: 'docs', sourcePath: '/docs', createdAt: '2026-07-05T10:00:00.000Z', fileCount: 10 },
          { snapshotId: 'a2', jobName: 'photos', sourcePath: '/photos', createdAt: '2026-07-05T10:00:00.000Z', fileCount: 20 },
        ],
        'mac-b': [
          { snapshotId: 'b1', jobName: 'docs', sourcePath: '/docs', createdAt: '2026-07-05T10:00:00.000Z', fileCount: 10 },
        ],
      };

      const result = buildBackupVersionConsistency(devices, snapshotsByDevice, {
        excludedCoverageDeviceIds: ['mac-c']
      });

      assert.strictEqual(result.summary.coverage.coverageDeviceCount, 2);
      assert.strictEqual(result.summary.coverage.coverageExcludedDeviceCount, 1);
      assert.strictEqual(result.summary.coverage.coverageGapCount, 1);
      assert.strictEqual(result.summary.coverage.fullyCoveredCount, 1);

      const docsGroup = result.groups.find(g => g.jobName === 'docs');
      assert.ok(docsGroup);
      assert.strictEqual(docsGroup.expectedDeviceCount, 2);
      assert.strictEqual(docsGroup.coveredDeviceCount, 2);
      assert.strictEqual(docsGroup.missingDeviceCount, 0);
      assert.deepStrictEqual(docsGroup.missingDeviceNames, []);

      const photosGroup = result.groups.find(g => g.jobName === 'photos');
      assert.ok(photosGroup);
      assert.strictEqual(photosGroup.expectedDeviceCount, 2);
      assert.strictEqual(photosGroup.coveredDeviceCount, 1);
      assert.strictEqual(photosGroup.missingDeviceCount, 1);
      assert.deepStrictEqual(photosGroup.missingDeviceNames, ['Mac B']);
    });

    it('does not count fully covered when expectedDeviceCount is 0', () => {
      const devices = [
        { deviceId: 'mac-a', hostname: 'Mac A' },
      ];
      const snapshotsByDevice = {
        'mac-a': [
          { snapshotId: 'a1', jobName: 'docs', sourcePath: '/docs', createdAt: '2026-07-05T10:00:00.000Z', fileCount: 10 },
        ],
      };

      const result = buildBackupVersionConsistency(devices, snapshotsByDevice, {
        excludedCoverageDeviceIds: ['mac-a']
      });

      assert.strictEqual(result.summary.coverage.coverageDeviceCount, 0);
      assert.strictEqual(result.summary.coverage.coverageExcludedDeviceCount, 1);
      assert.strictEqual(result.summary.coverage.coverageGapCount, 0);
      assert.strictEqual(result.summary.coverage.fullyCoveredCount, 0);

      const docsGroup = result.groups.find(g => g.jobName === 'docs');
      assert.ok(docsGroup);
      assert.strictEqual(docsGroup.expectedDeviceCount, 0);
      assert.strictEqual(docsGroup.coveredDeviceCount, 0);
      assert.strictEqual(docsGroup.missingDeviceCount, 0);
    });
  });

  it('correctly handles staleDeviceNames formatting when there are more than 3 stale devices', () => {
    const result = buildBackupVersionConsistency(
      [
        { deviceId: 'mac-a', hostname: 'Mac A' },
        { deviceId: 'mac-b', hostname: 'Mac B' },
        { deviceId: 'mac-c', hostname: 'Mac C' },
        { deviceId: 'mac-d', hostname: 'Mac D' },
        { deviceId: 'mac-e', hostname: 'Mac E' },
      ],
      {
        'mac-a': [{ snapshotId: 'a', jobName: 'docs', sourcePath: '/docs', createdAt: '2026-07-05T10:00:00.000Z', fileCount: 10 }],
        'mac-b': [{ snapshotId: 'b', jobName: 'docs', sourcePath: '/docs', createdAt: '2026-07-05T09:00:00.000Z', fileCount: 9 }],
        'mac-c': [{ snapshotId: 'c', jobName: 'docs', sourcePath: '/docs', createdAt: '2026-07-05T09:00:00.000Z', fileCount: 9 }],
        'mac-d': [{ snapshotId: 'd', jobName: 'docs', sourcePath: '/docs', createdAt: '2026-07-05T09:00:00.000Z', fileCount: 9 }],
        'mac-e': [{ snapshotId: 'e', jobName: 'docs', sourcePath: '/docs', createdAt: '2026-07-05T09:00:00.000Z', fileCount: 9 }],
      }
    );
    assert.strictEqual(result.groups[0].latestCount, 1);
    assert.strictEqual(result.groups[0].staleCount, 4);
    assert.deepStrictEqual(result.groups[0].staleDeviceNames, ['Mac B', 'Mac C', 'Mac D', 'Mac E']);
  });

  it('filters and sorts version consistency groups without mutating the source order', () => {
    const groups = [
      {
        jobName: 'zeta',
        sourcePath: '/zeta',
        status: 'synced',
        latestCreatedAt: '2026-07-05T10:00:00.000Z',
        staleCount: 0,
        maxTimeDriftMs: null,
        devices: [],
      },
      {
        jobName: 'alpha',
        sourcePath: '/alpha',
        status: 'drifted',
        latestCreatedAt: '2026-07-05T09:00:00.000Z',
        staleCount: 1,
        maxTimeDriftMs: 1000,
        devices: [],
      },
      {
        jobName: 'beta',
        sourcePath: '/beta',
        status: 'drifted',
        latestCreatedAt: '2026-07-05T11:00:00.000Z',
        staleCount: 3,
        maxTimeDriftMs: 5000,
        devices: [],
      },
    ];
    const consistency = { groups };

    assert.deepStrictEqual(
      filterVersionConsistencyGroups(consistency, { sort: 'risk' }).map((group) => group.jobName),
      ['zeta', 'alpha', 'beta'],
    );
    assert.deepStrictEqual(
      filterVersionConsistencyGroups(consistency, { sort: 'name' }).map((group) => group.jobName),
      ['alpha', 'beta', 'zeta'],
    );
    assert.deepStrictEqual(
      filterVersionConsistencyGroups(consistency, { sort: 'max-drift' }).map((group) => group.jobName),
      ['beta', 'alpha', 'zeta'],
    );
    assert.deepStrictEqual(
      filterVersionConsistencyGroups(consistency, { sort: 'stale-count' }).map((group) => group.jobName),
      ['beta', 'alpha', 'zeta'],
    );
    assert.deepStrictEqual(
      filterVersionConsistencyGroups(consistency, { sort: 'latest' }).map((group) => group.jobName),
      ['beta', 'zeta', 'alpha'],
    );
    assert.deepStrictEqual(
      filterVersionConsistencyGroups(consistency, { sort: 'unknown' }).map((group) => group.jobName),
      ['zeta', 'alpha', 'beta'],
    );
    assert.deepStrictEqual(groups.map((group) => group.jobName), ['zeta', 'alpha', 'beta']);
  });

  it('filterVersionConsistencyGroups supports coverage filters (all, gap, full, unobservable)', () => {
    const groups = [
      {
        jobName: 'gap-job',
        expectedDeviceCount: 3,
        missingDeviceCount: 1,
        status: 'drifted',
        devices: []
      },
      {
        jobName: 'full-job',
        expectedDeviceCount: 2,
        missingDeviceCount: 0,
        status: 'synced',
        devices: []
      },
      {
        jobName: 'no-expected-job',
        expectedDeviceCount: 0,
        missingDeviceCount: 0,
        status: 'single-device',
        devices: []
      },
      {
        jobName: 'negative-expected-job',
        expectedDeviceCount: -1,
        missingDeviceCount: 0,
        status: 'single-device',
        devices: []
      },
      {
        jobName: 'no-expected-gap-job',
        expectedDeviceCount: 0,
        missingDeviceCount: 1,
        status: 'drifted',
        devices: []
      }
    ];
    const consistency = { groups };

    const resAll = filterVersionConsistencyGroups(consistency, { coverage: 'all' });
    assert.deepStrictEqual(resAll.map(g => g.jobName), ['gap-job', 'full-job', 'no-expected-job', 'negative-expected-job', 'no-expected-gap-job']);

    const resGap = filterVersionConsistencyGroups(consistency, { coverage: 'gap' });
    assert.deepStrictEqual(resGap.map(g => g.jobName), ['gap-job']);

    const resFull = filterVersionConsistencyGroups(consistency, { coverage: 'full' });
    assert.deepStrictEqual(resFull.map(g => g.jobName), ['full-job']);

    const resUnobservable = filterVersionConsistencyGroups(consistency, { coverage: 'unobservable' });
    assert.deepStrictEqual(resUnobservable.map(g => g.jobName), ['no-expected-job', 'negative-expected-job', 'no-expected-gap-job']);
  });

  it('coverage filter composes with status/search/sort and does not mutate source order', () => {
    const groups = [
      {
        jobName: 'zeta-gap',
        sourcePath: '/zeta',
        expectedDeviceCount: 2,
        missingDeviceCount: 1,
        status: 'drifted',
        latestCreatedAt: '2026-07-05T10:00:00.000Z',
        staleCount: 0,
        maxTimeDriftMs: null,
        devices: [],
      },
      {
        jobName: 'alpha-full',
        sourcePath: '/alpha',
        expectedDeviceCount: 2,
        missingDeviceCount: 0,
        status: 'drifted',
        latestCreatedAt: '2026-07-05T09:00:00.000Z',
        staleCount: 1,
        maxTimeDriftMs: 1000,
        devices: [],
      },
      {
        jobName: 'beta-gap',
        sourcePath: '/beta',
        expectedDeviceCount: 2,
        missingDeviceCount: 2,
        status: 'drifted',
        latestCreatedAt: '2026-07-05T11:00:00.000Z',
        staleCount: 3,
        maxTimeDriftMs: 5000,
        devices: [],
      },
    ];
    const consistency = { groups };

    const res = filterVersionConsistencyGroups(consistency, {
      status: 'drifted',
      query: 'gap',
      coverage: 'gap',
      sort: 'name'
    });
    assert.deepStrictEqual(res.map(g => g.jobName), ['beta-gap', 'zeta-gap']);

    assert.deepStrictEqual(groups.map((group) => group.jobName), ['zeta-gap', 'alpha-full', 'beta-gap']);
  });

  it('coverage filter unobservable composes with status/search/sort and does not mutate source order', () => {
    const groups = [
      {
        jobName: 'zeta-unobservable',
        sourcePath: '/zeta',
        expectedDeviceCount: 0,
        missingDeviceCount: 0,
        status: 'drifted',
        latestCreatedAt: '2026-07-05T10:00:00.000Z',
        staleCount: 0,
        maxTimeDriftMs: null,
        devices: [],
      },
      {
        jobName: 'alpha-full',
        sourcePath: '/alpha',
        expectedDeviceCount: 2,
        missingDeviceCount: 0,
        status: 'drifted',
        latestCreatedAt: '2026-07-05T09:00:00.000Z',
        staleCount: 1,
        maxTimeDriftMs: 1000,
        devices: [],
      },
      {
        jobName: 'beta-unobservable',
        sourcePath: '/beta',
        expectedDeviceCount: -1,
        missingDeviceCount: 0,
        status: 'drifted',
        latestCreatedAt: '2026-07-05T11:00:00.000Z',
        staleCount: 3,
        maxTimeDriftMs: 5000,
        devices: [],
      },
    ];
    const consistency = { groups };

    const res = filterVersionConsistencyGroups(consistency, {
      status: 'drifted',
      query: 'unobservable',
      coverage: 'unobservable',
      sort: 'name'
    });
    assert.deepStrictEqual(res.map(g => g.jobName), ['beta-unobservable', 'zeta-unobservable']);

    assert.deepStrictEqual(groups.map((group) => group.jobName), ['zeta-unobservable', 'alpha-full', 'beta-unobservable']);
  });

  it('pure filterVersionConsistencyGroups sort coverage-gap orders by missing count, missing ratio tie-break, expectedDeviceCount tie-break, and existing risk fallback', () => {
    const groups = [
      {
        jobName: 'job-B',
        expectedDeviceCount: 2,
        missingDeviceCount: 2,
        status: 'synced',
        latestCreatedAt: '2026-07-05T10:00:00.000Z',
      },
      {
        jobName: 'job-A',
        expectedDeviceCount: 3,
        missingDeviceCount: 3,
        status: 'synced',
        latestCreatedAt: '2026-07-05T10:00:00.000Z',
      },
      {
        jobName: 'job-D',
        expectedDeviceCount: 4,
        missingDeviceCount: 1,
        status: 'synced',
        latestCreatedAt: '2026-07-05T10:00:00.000Z',
      },
      {
        jobName: 'job-C',
        expectedDeviceCount: 2,
        missingDeviceCount: 1,
        status: 'synced',
        latestCreatedAt: '2026-07-05T10:00:00.000Z',
      },
      {
        jobName: 'job-H',
        expectedDeviceCount: 2,
        missingDeviceCount: 0,
        status: 'synced',
        latestCreatedAt: '2026-07-05T10:00:00.000Z',
      },
      {
        jobName: 'job-G',
        expectedDeviceCount: 5,
        missingDeviceCount: 0,
        status: 'synced',
        latestCreatedAt: '2026-07-05T10:00:00.000Z',
      },
      {
        jobName: 'job-K',
        expectedDeviceCount: 0,
        missingDeviceCount: 0,
        status: 'synced',
        latestCreatedAt: '2026-07-05T10:00:00.000Z',
      },
      {
        jobName: 'job-J',
        expectedDeviceCount: 0,
        missingDeviceCount: 0,
        status: 'drifted',
        latestCreatedAt: '2026-07-05T10:00:00.000Z',
      },
      {
        jobName: 'job-M',
        expectedDeviceCount: 0,
        missingDeviceCount: 0,
        status: 'synced',
        latestCreatedAt: '2026-07-05T09:00:00.000Z',
      },
      {
        jobName: 'job-L',
        expectedDeviceCount: 0,
        missingDeviceCount: 0,
        status: 'synced',
        latestCreatedAt: '2026-07-05T11:00:00.000Z',
      },
      {
        jobName: 'beta',
        expectedDeviceCount: 0,
        missingDeviceCount: 0,
        status: 'synced',
        latestCreatedAt: '2026-07-05T10:00:00.000Z',
      },
      {
        jobName: 'alpha',
        expectedDeviceCount: 0,
        missingDeviceCount: 0,
        status: 'synced',
        latestCreatedAt: '2026-07-05T10:00:00.000Z',
      },
    ];
    const consistency = { groups };
    const res = filterVersionConsistencyGroups(consistency, { sort: 'coverage-gap' });
    const expected = [
      'job-A',
      'job-B',
      'job-C',
      'job-D',
      'job-G',
      'job-H',
      'job-J',
      'job-L',
      'alpha',
      'beta',
      'job-K',
      'job-M',
    ];
    assert.deepStrictEqual(res.map(g => g.jobName), expected);
  });

  it('pure test composes coverage-gap with coverage gap filter, status, and query without mutating source order', () => {
    const groups = [
      {
        jobName: 'zeta-gap',
        sourcePath: '/zeta',
        expectedDeviceCount: 2,
        missingDeviceCount: 1,
        status: 'drifted',
        latestCreatedAt: '2026-07-05T10:00:00.000Z',
        staleCount: 0,
        maxTimeDriftMs: null,
        devices: [],
      },
      {
        jobName: 'alpha-full',
        sourcePath: '/alpha',
        expectedDeviceCount: 2,
        missingDeviceCount: 0,
        status: 'drifted',
        latestCreatedAt: '2026-07-05T09:00:00.000Z',
        staleCount: 1,
        maxTimeDriftMs: 1000,
        devices: [],
      },
      {
        jobName: 'beta-gap',
        sourcePath: '/beta',
        expectedDeviceCount: 4,
        missingDeviceCount: 3,
        status: 'drifted',
        latestCreatedAt: '2026-07-05T11:00:00.000Z',
        staleCount: 3,
        maxTimeDriftMs: 5000,
        devices: [],
      },
      {
        jobName: 'gamma-gap',
        sourcePath: '/gamma',
        expectedDeviceCount: 2,
        missingDeviceCount: 1,
        status: 'synced',
        latestCreatedAt: '2026-07-05T10:00:00.000Z',
        staleCount: 0,
        maxTimeDriftMs: null,
        devices: [],
      },
      {
        jobName: 'delta-gap-other',
        sourcePath: '/delta',
        expectedDeviceCount: 2,
        missingDeviceCount: 2,
        status: 'drifted',
        latestCreatedAt: '2026-07-05T10:00:00.000Z',
        staleCount: 0,
        maxTimeDriftMs: null,
        devices: [],
      },
    ];
    const originalOrder = groups.map(g => g.jobName);
    const consistency = { groups };

    const res = filterVersionConsistencyGroups(consistency, {
      status: 'drifted',
      query: 'gap',
      coverage: 'gap',
      sort: 'coverage-gap',
    });

    // 命中筛选后按缺失设备数降序排序
    assert.deepStrictEqual(res.map(g => g.jobName), ['beta-gap', 'delta-gap-other', 'zeta-gap']);
    assert.deepStrictEqual(groups.map(g => g.jobName), originalOrder, 'must not mutate source order');
  });

  it('returns empty summary for non-array devices and non-object snapshots', () => {
    const result = buildBackupVersionConsistency(null, null);
    assert.deepStrictEqual(result.summary, {
      synced: 0,
      drifted: 0,
      singleDevice: 0,
      total: 0,
      coverage: {
        coverageDeviceCount: 0,
        coverageExcludedDeviceCount: 0,
        coverageGapCount: 0,
        fullyCoveredCount: 0,
      }
    });
    assert.deepStrictEqual(result.groups, []);
  });
});

describe('V0.33 device management state pure functions', () => {
  it('covers online + real IP => 在线可见', () => {
    assert.strictEqual(getDeviceManagementState({ status: 'online', ipAddress: '192.168.1.100' }), '在线可见');
    assert.strictEqual(getDeviceManagementState({ status: 'online', ipAddress: '10.0.0.1' }), '在线可见');
  });

  it('covers online + missing/empty/null/unknown IP => 在线缺 IP', () => {
    assert.strictEqual(getDeviceManagementState({ status: 'online', ipAddress: '' }), '在线缺 IP');
    assert.strictEqual(getDeviceManagementState({ status: 'online', ipAddress: null }), '在线缺 IP');
    assert.strictEqual(getDeviceManagementState({ status: 'online', ipAddress: undefined }), '在线缺 IP');
    assert.strictEqual(getDeviceManagementState({ status: 'online', ipAddress: 'unknown' }), '在线缺 IP');
    assert.strictEqual(getDeviceManagementState({ status: 'online', ipAddress: '   ' }), '在线缺 IP');
    assert.strictEqual(getDeviceManagementState({ status: 'online', ipAddress: ' UNKNOWN ' }), '在线缺 IP');
  });

  it('covers offline => 离线保留', () => {
    assert.strictEqual(getDeviceManagementState({ status: 'offline', ipAddress: '192.168.1.100' }), '离线保留');
    assert.strictEqual(getDeviceManagementState({ status: 'offline', ipAddress: '' }), '离线保留');
    assert.strictEqual(getDeviceManagementState({ status: 'offline' }), '离线保留');
  });

  it('covers unknown/missing status/null device => 未知待确认', () => {
    assert.strictEqual(getDeviceManagementState({ status: 'unknown', ipAddress: '1.2.3.4' }), '未知待确认');
    assert.strictEqual(getDeviceManagementState({ status: '', ipAddress: '1.2.3.4' }), '未知待确认');
    assert.strictEqual(getDeviceManagementState({ status: null }), '未知待确认');
    assert.strictEqual(getDeviceManagementState({}), '未知待确认');
    assert.strictEqual(getDeviceManagementState(null), '未知待确认');
  });
});

describe('V0.34 device management state key pure functions', () => {
  it('covers online + valid IP => visible', () => {
    assert.strictEqual(getDeviceManagementStateKey({ status: 'online', ipAddress: '192.168.1.100' }), 'visible');
    assert.strictEqual(getDeviceManagementStateKey({ status: 'online', ipAddress: '10.0.0.1' }), 'visible');
  });

  it('covers online + null/empty/whitespace/unknown/UNKNOWN => missing-ip', () => {
    assert.strictEqual(getDeviceManagementStateKey({ status: 'online', ipAddress: '' }), 'missing-ip');
    assert.strictEqual(getDeviceManagementStateKey({ status: 'online', ipAddress: null }), 'missing-ip');
    assert.strictEqual(getDeviceManagementStateKey({ status: 'online', ipAddress: undefined }), 'missing-ip');
    assert.strictEqual(getDeviceManagementStateKey({ status: 'online', ipAddress: 'unknown' }), 'missing-ip');
    assert.strictEqual(getDeviceManagementStateKey({ status: 'online', ipAddress: '   ' }), 'missing-ip');
    assert.strictEqual(getDeviceManagementStateKey({ status: 'online', ipAddress: ' UNKNOWN ' }), 'missing-ip');
  });

  it('covers offline => offline-retained', () => {
    assert.strictEqual(getDeviceManagementStateKey({ status: 'offline', ipAddress: '192.168.1.100' }), 'offline-retained');
    assert.strictEqual(getDeviceManagementStateKey({ status: 'offline', ipAddress: '' }), 'offline-retained');
    assert.strictEqual(getDeviceManagementStateKey({ status: 'offline' }), 'offline-retained');
  });

  it('covers unknown/missing/null device => unknown', () => {
    assert.strictEqual(getDeviceManagementStateKey({ status: 'unknown', ipAddress: '1.2.3.4' }), 'unknown');
    assert.strictEqual(getDeviceManagementStateKey({ status: '', ipAddress: '1.2.3.4' }), 'unknown');
    assert.strictEqual(getDeviceManagementStateKey({ status: null }), 'unknown');
    assert.strictEqual(getDeviceManagementStateKey({}), 'unknown');
    assert.strictEqual(getDeviceManagementStateKey(null), 'unknown');
  });
});

describe('V0.35 device management summary pure functions', () => {
  it('returns all zeros for empty/non-array input', () => {
    const emptySummary = buildDeviceManagementSummary(null);
    assert.deepStrictEqual(emptySummary, {
      all: 0,
      visible: 0,
      missingIp: 0,
      offlineRetained: 0,
      unknown: 0
    });
    const emptySummary2 = buildDeviceManagementSummary([]);
    assert.deepStrictEqual(emptySummary2, {
      all: 0,
      visible: 0,
      missingIp: 0,
      offlineRetained: 0,
      unknown: 0
    });
  });

  it('returns correct counts for mixed devices without mutating input', () => {
    const devices = [
      { status: 'online', ipAddress: '192.168.1.1' }, // visible
      { status: 'online', ipAddress: '  UNKNOWN  ' }, // missing-ip (whitespace/UNKNOWN IP)
      { status: 'online', ipAddress: '' }, // missing-ip
      { status: 'offline', ipAddress: '10.0.0.1' }, // offline-retained
      { status: 'unknown', ipAddress: '1.1.1.1' }, // unknown
      { status: 'other', ipAddress: null } // unknown
    ];
    const copy = JSON.parse(JSON.stringify(devices));
    const summary = buildDeviceManagementSummary(devices);
    assert.deepStrictEqual(summary, {
      all: 6,
      visible: 1,
      missingIp: 2,
      offlineRetained: 1,
      unknown: 2
    });
    assert.deepStrictEqual(devices, copy, 'should not mutate input');
  });
});

describe('V0.37 device management summary scoped counts pure functions', () => {
  it('applies query and status controls while ignoring management filter', () => {
    const devices = [
      { deviceId: 'mac-1', hostname: 'Aaron-Mac', status: 'online', ipAddress: '10.0.0.20' },
      { deviceId: 'mac-2', hostname: 'Beta-Mac', status: 'online', ipAddress: '' },
      { deviceId: 'ipad-3', hostname: 'Design-iPad', status: 'offline', ipAddress: '10.0.0.5' },
      { deviceId: 'phone-4', hostname: 'TestPhone', status: '', ipAddress: '192.168.31.9' },
    ];
    const copy = JSON.parse(JSON.stringify(devices));
    const summary = buildDeviceManagementSummaryScope(devices, {
      query: 'mac',
      status: 'online',
      management: 'visible',
    });
    assert.deepStrictEqual(summary, {
      all: 2,
      visible: 1,
      missingIp: 1,
      offlineRetained: 0,
      unknown: 0
    });
    assert.deepStrictEqual(devices, copy, 'should not mutate input devices');
  });

  it('returns all zeros when query/status scope has no devices', () => {
    assert.deepStrictEqual(buildDeviceManagementSummaryScope([
      { hostname: 'Aaron-Mac', status: 'online', ipAddress: '10.0.0.20' },
    ], { query: 'ipad', status: 'offline', management: 'all' }), {
      all: 0,
      visible: 0,
      missingIp: 0,
      offlineRetained: 0,
      unknown: 0
    });
  });
});

describe('V0.38 device management hint pure functions', () => {
  it('explains visible devices without mutating input', () => {
    const device = { status: 'online', ipAddress: '192.168.1.100' };
    const copy = { ...device };
    assert.strictEqual(getDeviceManagementHint(device), '在线且 IP 可用，可纳入统一管理');
    assert.deepStrictEqual(device, copy, 'should not mutate input');
  });

  it('explains missing IP, offline retained, and unknown devices', () => {
    assert.strictEqual(getDeviceManagementHint({ status: 'online', ipAddress: '' }), '设备在线但缺少可用 IP，需补充 IP 信息');
    assert.strictEqual(getDeviceManagementHint({ status: 'offline', ipAddress: '192.168.1.100' }), '设备离线，保留历史记录和备份上下文');
    assert.strictEqual(getDeviceManagementHint({ status: 'unknown', ipAddress: '192.168.1.100' }), '状态未知，需确认设备心跳');
    assert.strictEqual(getDeviceManagementHint(null), '状态未知，需确认设备心跳');
  });
});

describe('V0.39 device empty filter context pure functions', () => {
  it('formats default controls as all labels', () => {
    assert.strictEqual(
      buildDeviceEmptyFilterContext({}),
      '搜索: 全部 · 状态: 全部 · 管理态: 全部'
    );
  });

  it('formats query, status, and management labels', () => {
    assert.strictEqual(
      buildDeviceEmptyFilterContext({ query: 'Beta', status: 'online', management: 'visible' }),
      '搜索: Beta · 状态: 在线 · 管理态: 在线可见'
    );
  });
});

describe('V0.41 device filter reset state pure functions', () => {
  it('returns false for default controls and whitespace-only query', () => {
    assert.strictEqual(isDeviceFilterResetActive({}), false);
    assert.strictEqual(isDeviceFilterResetActive({
      query: '   ',
      status: 'all',
      management: 'all',
      sort: 'name',
    }), false);
  });

  it('returns true when any control differs from its default', () => {
    assert.strictEqual(isDeviceFilterResetActive({ query: 'Beta', status: 'all', management: 'all', sort: 'name' }), true);
    assert.strictEqual(isDeviceFilterResetActive({ query: '', status: 'online', management: 'all', sort: 'name' }), true);
    assert.strictEqual(isDeviceFilterResetActive({ query: '', status: 'all', management: 'visible', sort: 'name' }), true);
    assert.strictEqual(isDeviceFilterResetActive({ query: '', status: 'all', management: 'all', sort: 'snapshots' }), true);
  });
});

describe('V0.42 device active filter summary pure functions', () => {
  it('buildDeviceActiveFilterSummary returns 默认筛选 for default controls', () => {
    assert.strictEqual(buildDeviceActiveFilterSummary({}), '默认筛选');
    assert.strictEqual(buildDeviceActiveFilterSummary({ query: '   ', status: 'all', management: 'all', sort: 'name' }), '默认筛选');
  });

  it('buildDeviceActiveFilterSummary returns 当前筛选 summary with query/status/management/sort labels for active controls', () => {
    assert.strictEqual(
      buildDeviceActiveFilterSummary({ query: 'Beta', status: 'all', management: 'all', sort: 'name' }),
      '当前筛选: 搜索: Beta · 状态: 全部 · 管理态: 全部 · 排序: 名称'
    );
    assert.strictEqual(
      buildDeviceActiveFilterSummary({ query: '', status: 'online', management: 'visible', sort: 'snapshots' }),
      '当前筛选: 搜索: 全部 · 状态: 在线 · 管理态: 在线可见 · 排序: 快照数'
    );
  });

  it('DEVICE_FILTER_SORT_LABELS has correct sort keys mapped to Chinese', () => {
    assert.deepStrictEqual(DEVICE_FILTER_SORT_LABELS, {
      name: '名称',
      ip: 'IP',
      heartbeat: '最后心跳',
      snapshots: '快照数',
    });
  });
});

describe('V0.42 DOM test: device active filter summary rendering and reset behavior', () => {
  it('updates summary text when filters change and resets to default without refetching', async () => {
    const doc = buildMockDoc();
    const localDevices = [
      { deviceId: 'mac-1', hostname: 'Aaron-Mac', status: 'online', ipAddress: '10.0.0.20', snapshotCount: 2, lastHeartbeatAt: '2026-07-04T10:00:00Z' },
      { deviceId: 'mac-2', hostname: 'Beta-Mac', status: 'online', ipAddress: '', snapshotCount: 0, lastHeartbeatAt: '2026-07-04T10:00:00Z' },
    ];

    let fetchCount = 0;
    const mockFetch = async (url) => {
      if (url === '/api/devices') fetchCount++;
      return { ok: true, status: 200, json: async () => (url.includes('/snapshots') ? [] : localDevices) };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(fetchCount, 1, 'initial fetch should happen');

    const searchInput = doc.getElementById('device-search');
    const statusFilter = doc.getElementById('device-status-filter');
    const managementFilter = doc.getElementById('device-management-filter');
    const sortSelect = doc.getElementById('device-sort');
    const resetButton = doc.getElementById('device-filter-reset');
    const summaryEl = doc.querySelector('[data-testid="device-active-filter-summary"]') || doc.getElementById('device-active-filter-summary');

    assert.ok(summaryEl, 'device-active-filter-summary element must exist');
    assert.strictEqual(summaryEl.textContent, '默认筛选', 'initial summary should be 默认筛选');

    // 1. Manually set filters to non-default values
    searchInput.value = 'Beta';
    if (searchInput._listeners.input) searchInput._listeners.input();
    await new Promise((r) => setTimeout(r, 20));

    // Summary should update
    assert.strictEqual(summaryEl.textContent, '当前筛选: 搜索: Beta · 状态: 全部 · 管理态: 全部 · 排序: 名称');

    // Change status and sort
    statusFilter.value = 'online';
    if (statusFilter._listeners.change) statusFilter._listeners.change();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(summaryEl.textContent, '当前筛选: 搜索: Beta · 状态: 在线 · 管理态: 全部 · 排序: 名称');

    managementFilter.value = 'visible';
    if (managementFilter._listeners.change) managementFilter._listeners.change();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(summaryEl.textContent, '当前筛选: 搜索: Beta · 状态: 在线 · 管理态: 在线可见 · 排序: 名称');

    sortSelect.value = 'snapshots';
    if (sortSelect._listeners.change) sortSelect._listeners.change();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(summaryEl.textContent, '当前筛选: 搜索: Beta · 状态: 在线 · 管理态: 在线可见 · 排序: 快照数');

    // 2. Click the reset button
    if (resetButton._listeners.click) resetButton._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    // 3. Verify summary is reset to default
    assert.strictEqual(summaryEl.textContent, '默认筛选', 'summary should be reset to default');

    // 6. Verify fetch count did not increase
    assert.strictEqual(fetchCount, 1, 'should not have refetched /api/devices');
  });
});

describe('V0.43 device active filter summary state pure functions', () => {
  it('buildDeviceActiveFilterSummaryState returns correct state object', () => {
    // Default controls
    assert.deepStrictEqual(buildDeviceActiveFilterSummaryState({}), {
      text: '默认筛选',
      active: false,
    });

    assert.deepStrictEqual(buildDeviceActiveFilterSummaryState({ query: '', status: 'all', management: 'all', sort: 'name' }), {
      text: '默认筛选',
      active: false,
    });

    // Active controls
    const activeControls = { query: 'Beta', status: 'online', management: 'visible', sort: 'snapshots' };
    assert.deepStrictEqual(buildDeviceActiveFilterSummaryState(activeControls), {
      text: '当前筛选: 搜索: Beta · 状态: 在线 · 管理态: 在线可见 · 排序: 快照数',
      active: true,
    });

    // Verify composition
    assert.strictEqual(
      buildDeviceActiveFilterSummaryState(activeControls).text,
      buildDeviceActiveFilterSummary(activeControls)
    );
  });
});

// HTML static state contract moved inside Web Console / API contract

describe('V0.43 DOM state transition test', () => {
  it('updates summary text and data-active state when filters change, and resets correctly', async () => {
    const doc = buildMockDoc();
    const localDevices = [
      { deviceId: 'mac-1', hostname: 'Aaron-Mac', status: 'online', ipAddress: '10.0.0.20', snapshotCount: 2, lastHeartbeatAt: '2026-07-04T10:00:00Z' },
      { deviceId: 'mac-2', hostname: 'Beta-Mac', status: 'online', ipAddress: '', snapshotCount: 0, lastHeartbeatAt: '2026-07-04T10:00:00Z' },
    ];

    let fetchCount = 0;
    const mockFetch = async (url) => {
      if (url === '/api/devices') fetchCount++;
      return { ok: true, status: 200, json: async () => (url.includes('/snapshots') ? [] : localDevices) };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(fetchCount, 1, 'initial fetch should happen');

    const searchInput = doc.getElementById('device-search');
    const statusFilter = doc.getElementById('device-status-filter');
    const managementFilter = doc.getElementById('device-management-filter');
    const sortSelect = doc.getElementById('device-sort');
    const resetButton = doc.getElementById('device-filter-reset');
    const summaryEl = doc.querySelector('[data-testid="device-active-filter-summary"]') || doc.getElementById('device-active-filter-summary');

    assert.ok(summaryEl, 'device-active-filter-summary element must exist');
    assert.strictEqual(summaryEl.textContent, '默认筛选', 'initial summary should be 默认筛选');
    assert.strictEqual(summaryEl.getAttribute('data-active'), 'false', 'initial data-active should be false');

    // 1. Set filter to non-default
    searchInput.value = 'Beta';
    if (searchInput._listeners.input) searchInput._listeners.input();
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(summaryEl.textContent, '当前筛选: 搜索: Beta · 状态: 全部 · 管理态: 全部 · 排序: 名称');
    assert.strictEqual(summaryEl.getAttribute('data-active'), 'true', 'data-active should become true when filter is active');

    // Change status, management, sort
    statusFilter.value = 'online';
    if (statusFilter._listeners.change) statusFilter._listeners.change();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(summaryEl.getAttribute('data-active'), 'true');

    managementFilter.value = 'visible';
    if (managementFilter._listeners.change) managementFilter._listeners.change();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(summaryEl.getAttribute('data-active'), 'true');

    sortSelect.value = 'snapshots';
    if (sortSelect._listeners.change) sortSelect._listeners.change();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(summaryEl.getAttribute('data-active'), 'true');
    assert.strictEqual(summaryEl.textContent, '当前筛选: 搜索: Beta · 状态: 在线 · 管理态: 在线可见 · 排序: 快照数');

    // 2. Click the reset button
    if (resetButton._listeners.click) resetButton._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    // 3. Verify summary is reset to default and data-active is false
    assert.strictEqual(summaryEl.textContent, '默认筛选', 'summary should be reset to default');
    assert.strictEqual(summaryEl.getAttribute('data-active'), 'false', 'data-active should be false after reset');

    // 4. Verify fetch count did not increase
    assert.strictEqual(fetchCount, 1, 'should not have refetched /api/devices');
  });
});

describe('V0.45 device filter count state pure functions', () => {
  it('buildDeviceFilterCountState returns correct text and filtered state', () => {
    assert.deepStrictEqual(buildDeviceFilterCountState(3, 3), {
      text: '3 / 3',
      filtered: false,
      visible: 3,
      total: 3,
    });
    assert.deepStrictEqual(buildDeviceFilterCountState(1, 3), {
      text: '1 / 3',
      filtered: true,
      visible: 1,
      total: 3,
    });
    assert.deepStrictEqual(buildDeviceFilterCountState(0, 0), {
      text: '0 / 0',
      filtered: false,
      visible: 0,
      total: 0,
    });
    // Test normalization of non-finite values
    assert.deepStrictEqual(buildDeviceFilterCountState(NaN, 3), {
      text: '0 / 3',
      filtered: true,
      visible: 0,
      total: 3,
    });
    assert.deepStrictEqual(buildDeviceFilterCountState(3, Infinity), {
      text: '3 / 0',
      filtered: false,
      visible: 3,
      total: 0,
    });
    assert.deepStrictEqual(buildDeviceFilterCountState(undefined, null), {
      text: '0 / 0',
      filtered: false,
      visible: 0,
      total: 0,
    });
    assert.deepStrictEqual(buildDeviceFilterCountState("foo", "bar"), {
      text: '0 / 0',
      filtered: false,
      visible: 0,
      total: 0,
    });
  });
});

describe('V0.45 DOM test: device filter count rendering and reset behavior', () => {
  it('updates device-filter-count text and data-filtered attribute when filters change, and resets correctly', async () => {
    const doc = buildMockDoc();
    const localDevices = [
      { deviceId: 'mac-1', hostname: 'Aaron-Mac', status: 'online', ipAddress: '10.0.0.20', snapshotCount: 2, lastHeartbeatAt: '2026-07-04T10:00:00Z' },
      { deviceId: 'mac-2', hostname: 'Beta-Mac', status: 'online', ipAddress: '', snapshotCount: 0, lastHeartbeatAt: '2026-07-04T10:00:00Z' },
    ];

    let fetchCount = 0;
    const mockFetch = async (url) => {
      if (url === '/api/devices') fetchCount++;
      return { ok: true, status: 200, json: async () => (url.includes('/snapshots') ? [] : localDevices) };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(fetchCount, 1, 'initial fetch should happen');

    const searchInput = doc.getElementById('device-search');
    const statusFilter = doc.getElementById('device-status-filter');
    const managementFilter = doc.getElementById('device-management-filter');
    const resetButton = doc.getElementById('device-filter-reset');
    const countEl = doc.querySelector('[data-testid="device-filter-count"]') || doc.getElementById('device-filter-count');

    assert.ok(countEl, 'device-filter-count element must exist');
    assert.strictEqual(countEl.textContent, '2 / 2');
    assert.strictEqual(countEl.getAttribute('data-filtered'), 'false');
    assert.strictEqual(countEl.getAttribute('data-visible-count'), '2');
    assert.strictEqual(countEl.getAttribute('data-total-count'), '2');

    // 1. Set filter to narrow results
    searchInput.value = 'Beta';
    if (searchInput._listeners.input) searchInput._listeners.input();
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(countEl.textContent, '1 / 2');
    assert.strictEqual(countEl.getAttribute('data-filtered'), 'true');
    assert.strictEqual(countEl.getAttribute('data-visible-count'), '1');
    assert.strictEqual(countEl.getAttribute('data-total-count'), '2');

    // 2. Click the reset button
    if (resetButton._listeners.click) resetButton._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    // 3. Verify count and data-filtered are reset
    assert.strictEqual(countEl.textContent, '2 / 2');
    assert.strictEqual(countEl.getAttribute('data-filtered'), 'false');
    assert.strictEqual(countEl.getAttribute('data-visible-count'), '2');
    assert.strictEqual(countEl.getAttribute('data-total-count'), '2');

    // 4. Status filter also narrows the count state.
    statusFilter.value = 'unknown';
    if (statusFilter._listeners.change) statusFilter._listeners.change();
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(countEl.textContent, '0 / 2');
    assert.strictEqual(countEl.getAttribute('data-filtered'), 'true');
    assert.strictEqual(countEl.getAttribute('data-visible-count'), '0');
    assert.strictEqual(countEl.getAttribute('data-total-count'), '2');

    if (resetButton._listeners.click) resetButton._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(countEl.textContent, '2 / 2');
    assert.strictEqual(countEl.getAttribute('data-filtered'), 'false');
    assert.strictEqual(countEl.getAttribute('data-visible-count'), '2');
    assert.strictEqual(countEl.getAttribute('data-total-count'), '2');

    // 5. Management filter also narrows the count state.
    managementFilter.value = 'missing-ip';
    if (managementFilter._listeners.change) managementFilter._listeners.change();
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(countEl.textContent, '1 / 2');
    assert.strictEqual(countEl.getAttribute('data-filtered'), 'true');
    assert.strictEqual(countEl.getAttribute('data-visible-count'), '1');
    assert.strictEqual(countEl.getAttribute('data-total-count'), '2');

    if (resetButton._listeners.click) resetButton._listeners.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(countEl.textContent, '2 / 2');
    assert.strictEqual(countEl.getAttribute('data-filtered'), 'false');
    assert.strictEqual(countEl.getAttribute('data-visible-count'), '2');
    assert.strictEqual(countEl.getAttribute('data-total-count'), '2');

    // 4. Verify fetch count did not increase
    assert.strictEqual(fetchCount, 1, 'should not have refetched /api/devices');
  });
});

describe('Release health pure functions', () => {
  it('buildReleaseHealthViewModel formats ok status and masks/omits absolute dataDir', () => {
    const rawData = {
      version: LINKE_RELEASE_VERSION,
      checks: {
        http: 'ok',
        dataDirReadable: 'ok',
      },
      dataDir: '/private/tmp/linke-secret-path',
      timestamp: '2026-07-05T12:00:00Z',
      message: 'OK',
    };
    const result = buildReleaseHealthViewModel(rawData);
    assert.strictEqual(result.statusKey, 'ok');
    assert.strictEqual(result.statusText, '正常');
    assert.strictEqual(result.versionText, LINKE_RELEASE_VERSION);
    assert.strictEqual(result.dataDirText, '可读');
    assert.strictEqual(result.timestampText, '2026-07-05T12:00:00Z');
    assert.strictEqual(result.messageText, 'GET /api/health 成功');

    const str = JSON.stringify(result);
    assert.ok(!str.includes('private/tmp/linke-secret-path'), 'should not disclose absolute dataDir path');
  });

  it('buildReleaseHealthViewModel formats degraded status', () => {
    const rawData = {
      version: LINKE_RELEASE_VERSION,
      checks: {
        http: 'ok',
        dataDirReadable: 'unavailable',
      },
      dataDir: '/private/tmp/linke-secret-path',
      timestamp: '2026-07-05T12:00:00Z',
      message: 'Degraded storage',
    };
    const result = buildReleaseHealthViewModel(rawData);
    assert.strictEqual(result.statusKey, 'degraded');
    assert.strictEqual(result.statusText, '降级');
    assert.strictEqual(result.versionText, LINKE_RELEASE_VERSION);
    assert.strictEqual(result.dataDirText, '不可用');
    assert.strictEqual(result.timestampText, '2026-07-05T12:00:00Z');
    assert.ok(result.messageText.includes('降级') || result.messageText.includes('checks'));

    const str = JSON.stringify(result);
    assert.ok(!str.includes('private/tmp/linke-secret-path'));
  });

  it('buildReleaseHealthViewModel treats failed checks as degraded even when payload status is ok', () => {
    const result = buildReleaseHealthViewModel({
      status: 'ok',
      checks: {
        http: 'ok',
        dataDirReadable: 'unavailable',
      },
      timestamp: '2026-07-05T12:00:00Z',
    });

    assert.strictEqual(result.statusKey, 'degraded');
    assert.strictEqual(result.statusText, '降级');
    assert.strictEqual(result.versionText, '—');
    assert.strictEqual(result.dataDirText, '不可用');
    assert.ok(result.messageText.includes('降级') || result.messageText.includes('checks'));
  });

  it('buildReleaseHealthViewModel formats error status', () => {
    const result = buildReleaseHealthViewModel(null, 'HTTP 500');
    assert.strictEqual(result.statusKey, 'error');
    assert.strictEqual(result.statusText, '检查失败');
    assert.strictEqual(result.versionText, '—');
    assert.strictEqual(result.dataDirText, '—');
    assert.strictEqual(result.timestampText, '—');
    assert.ok(result.messageText.includes('HTTP 500'));
  });

  it('buildReleaseHealthViewModel handles unknown or invalid inputs', () => {
    const resultNull = buildReleaseHealthViewModel(null);
    assert.strictEqual(resultNull.statusKey, 'unknown');
    assert.strictEqual(resultNull.statusText, '未检查');
    assert.strictEqual(resultNull.versionText, '—');
    assert.strictEqual(resultNull.dataDirText, '—');
    assert.strictEqual(resultNull.timestampText, '—');
    assert.ok(resultNull.messageText.includes('点击刷新状态'));

    const resultEmpty = buildReleaseHealthViewModel({});
    assert.strictEqual(resultEmpty.statusKey, 'unknown');
    assert.strictEqual(resultEmpty.statusText, '未检查');
    assert.strictEqual(resultEmpty.versionText, '—');
    assert.strictEqual(resultEmpty.dataDirText, '—');
    assert.strictEqual(resultEmpty.timestampText, '—');
    assert.ok(resultEmpty.messageText.includes('点击刷新状态'));

    const resultBad = buildReleaseHealthViewModel({ status: 'something-else' });
    assert.strictEqual(resultBad.statusKey, 'unknown');
    assert.strictEqual(resultBad.statusText, '未检查');
    assert.strictEqual(resultBad.versionText, '—');
    assert.strictEqual(resultBad.dataDirText, '—');
    assert.strictEqual(resultBad.timestampText, '—');
    assert.ok(resultBad.messageText.includes('点击刷新状态'));
  });
});

describe('DOM test: release health panel interactions', () => {
  it('does not request /api/health on initialization', async () => {
    const doc = buildMockDoc();
    let healthFetchCount = 0;
    const mockFetch = async (url) => {
      if (url.includes('/api/health')) healthFetchCount++;
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(healthFetchCount, 0, 'should not call /api/health on init');
  });

  it('requests /api/health only once and renders ok when release-health-refresh button is clicked', async () => {
    const doc = buildMockDoc();
    let healthFetchCount = 0;
    const mockFetch = async (url) => {
      if (url.includes('/api/health')) {
        healthFetchCount++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            version: LINKE_RELEASE_VERSION,
            checks: {
              http: 'ok',
              dataDirReadable: 'ok',
            },
            dataDir: '/private/tmp/linke-secret-path',
            timestamp: '2026-07-05T12:00:00Z',
            message: 'All systems green',
          }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    const refreshBtn = doc.querySelector('[data-testid="release-health-refresh"]') || doc.getElementById('release-health-refresh');
    const panel = doc.querySelector('[data-testid="release-health-panel"]') || doc.getElementById('release-health-panel');
    const statusEl = doc.querySelector('[data-testid="release-health-status"]') || doc.getElementById('release-health-status');
    const versionEl = doc.querySelector('[data-testid="release-health-version"]') || doc.getElementById('release-health-version');
    const dataDirEl = doc.querySelector('[data-testid="release-health-data-dir"]') || doc.getElementById('release-health-data-dir');
    const timestampEl = doc.querySelector('[data-testid="release-health-timestamp"]') || doc.getElementById('release-health-timestamp');
    const messageEl = doc.querySelector('[data-testid="release-health-message"]') || doc.getElementById('release-health-message');

    assert.ok(refreshBtn, 'refresh button must exist');
    assert.ok(panel, 'release health panel must exist');

    if (refreshBtn._listeners.click) {
      await refreshBtn._listeners.click();
    }
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(healthFetchCount, 1, 'should request /api/health exactly once');

    assert.strictEqual(panel._attrs['data-status'], 'ok');
    assert.strictEqual(statusEl.textContent, '正常');
    assert.strictEqual(versionEl.textContent, LINKE_RELEASE_VERSION);
    assert.strictEqual(dataDirEl.textContent, '可读');
    assert.strictEqual(timestampEl.textContent, '2026-07-05T12:00:00Z');
    assert.ok(messageEl.textContent.includes('成功'));
  });

  it('renders error on non-2xx response', async () => {
    const doc = buildMockDoc();
    const mockFetch = async (url) => {
      if (url.includes('/api/health')) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ status: 'error', message: 'HTTP 500 错误' }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    const refreshBtn = doc.querySelector('[data-testid="release-health-refresh"]') || doc.getElementById('release-health-refresh');
    const panel = doc.querySelector('[data-testid="release-health-panel"]') || doc.getElementById('release-health-panel');
    const statusEl = doc.querySelector('[data-testid="release-health-status"]') || doc.getElementById('release-health-status');
    const messageEl = doc.querySelector('[data-testid="release-health-message"]') || doc.getElementById('release-health-message');

    if (refreshBtn._listeners.click) {
      await refreshBtn._listeners.click();
    }
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(panel._attrs['data-status'], 'error');
    assert.strictEqual(statusEl.textContent, '检查失败');
    assert.ok(messageEl.textContent.includes('错误'));
  });

  it('renders error when 200 but json() throws Invalid JSON', async () => {
    const doc = buildMockDoc();
    const mockFetch = async (url) => {
      if (url.includes('/api/health')) {
        return {
          ok: true,
          status: 200,
          json: async () => { throw new Error('Invalid JSON 错误'); },
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    const refreshBtn = doc.querySelector('[data-testid="release-health-refresh"]') || doc.getElementById('release-health-refresh');
    const panel = doc.querySelector('[data-testid="release-health-panel"]') || doc.getElementById('release-health-panel');
    const statusEl = doc.querySelector('[data-testid="release-health-status"]') || doc.getElementById('release-health-status');
    const messageEl = doc.querySelector('[data-testid="release-health-message"]') || doc.getElementById('release-health-message');

    if (refreshBtn._listeners.click) {
      await refreshBtn._listeners.click();
    }
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(panel._attrs['data-status'], 'error');
    assert.strictEqual(statusEl.textContent, '检查失败');
    assert.ok(messageEl.textContent.includes('错误'));
  });

  it('disables button during request and restores afterwards, and degraded response renders degraded status', async () => {
    const doc = buildMockDoc();
    let resolveRequest;
    const requestPromise = new Promise((resolve) => {
      resolveRequest = resolve;
    });

    const mockFetch = async (url) => {
      if (url.includes('/api/health')) {
        await requestPromise;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            version: LINKE_RELEASE_VERSION,
            checks: {
              http: 'ok',
              dataDirReadable: 'unavailable',
            },
            dataDir: '/private/tmp/linke-secret-path',
            timestamp: '2026-07-05T12:00:00Z',
            message: 'Degraded mode',
          }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    const refreshBtn = doc.querySelector('[data-testid="release-health-refresh"]') || doc.getElementById('release-health-refresh');
    const panel = doc.querySelector('[data-testid="release-health-panel"]') || doc.getElementById('release-health-panel');
    const statusEl = doc.querySelector('[data-testid="release-health-status"]') || doc.getElementById('release-health-status');

    let clickPromise;
    if (refreshBtn._listeners.click) {
      clickPromise = refreshBtn._listeners.click();
    }

    await new Promise((r) => setTimeout(r, 10));

    const isDisabled = refreshBtn.disabled === true || refreshBtn.getAttribute('disabled') === 'true' || refreshBtn.getAttribute('disabled') === true;
    assert.strictEqual(isDisabled, true, 'button.disabled must be true during request');

    const ariaDisabledDuring = refreshBtn.getAttribute('aria-disabled');
    assert.ok(ariaDisabledDuring === 'true' || ariaDisabledDuring === true, 'aria-disabled must be true during request');

    resolveRequest();
    if (clickPromise) {
      await clickPromise;
    }
    await new Promise((r) => setTimeout(r, 30));

    const isDisabledAfter = refreshBtn.disabled === true || refreshBtn.getAttribute('disabled') === 'true' || refreshBtn.getAttribute('disabled') === true;
    assert.strictEqual(isDisabledAfter, false, 'button.disabled must be false after request');

    const ariaDisabledAfter = refreshBtn.getAttribute('aria-disabled');
    assert.ok(ariaDisabledAfter === 'false' || ariaDisabledAfter === false || ariaDisabledAfter === null || ariaDisabledAfter === undefined, 'aria-disabled must be false or removed after request');

    assert.strictEqual(panel._attrs['data-status'], 'degraded');
  });
});

describe('Release readiness pure functions', () => {
  it('buildReleaseReadinessViewModel formats ready status', async () => {
    const app = await import('../src/web/app.js');
    const buildReleaseReadinessViewModel = app.buildReleaseReadinessViewModel;
    if (!buildReleaseReadinessViewModel) {
      throw new Error('buildReleaseReadinessViewModel is not defined in src/web/app.js');
    }

    const rawData = {
      ready: true,
      service: 'linke',
      expectedVersion: LINKE_RELEASE_VERSION,
      actualVersion: LINKE_RELEASE_VERSION,
      status: 'ok',
      checkedAt: '2026-07-06T12:00:00Z',
      checks: [
        { id: 'health.status', ok: true, expected: 'ok', actual: 'ok' },
        { id: 'release.version', ok: true, expected: LINKE_RELEASE_VERSION, actual: LINKE_RELEASE_VERSION }
      ]
    };
    const result = buildReleaseReadinessViewModel(rawData);
    assert.strictEqual(result.statusKey, 'ready');
    assert.strictEqual(result.statusText, '已就绪');
    assert.strictEqual(result.expectedVersionText, LINKE_RELEASE_VERSION);
    assert.strictEqual(result.actualVersionText, LINKE_RELEASE_VERSION);
    assert.strictEqual(result.failedCountText, '0');
    assert.strictEqual(result.timestampText, '2026-07-06T12:00:00Z');
    assert.ok(result.messageText.includes('就绪'));
  });

  it('buildReleaseReadinessViewModel formats not-ready status with failed count', async () => {
    const app = await import('../src/web/app.js');
    const buildReleaseReadinessViewModel = app.buildReleaseReadinessViewModel;
    if (!buildReleaseReadinessViewModel) {
      throw new Error('buildReleaseReadinessViewModel is not defined in src/web/app.js');
    }

    const rawData = {
      ready: false,
      service: 'linke',
      expectedVersion: LINKE_RELEASE_VERSION,
      actualVersion: 'V0.0',
      status: 'degraded',
      checkedAt: '2026-07-06T12:00:00Z',
      checks: [
        { id: 'health.status', ok: false, expected: 'ok', actual: 'degraded' },
        { id: 'release.version', ok: false, expected: LINKE_RELEASE_VERSION, actual: 'V0.0' }
      ]
    };
    const result = buildReleaseReadinessViewModel(rawData);
    assert.strictEqual(result.statusKey, 'not-ready');
    assert.strictEqual(result.statusText, '未就绪');
    assert.strictEqual(result.expectedVersionText, LINKE_RELEASE_VERSION);
    assert.strictEqual(result.actualVersionText, 'V0.0');
    assert.strictEqual(result.failedCountText, '2');
    assert.strictEqual(result.timestampText, '2026-07-06T12:00:00Z');
  });

  it('buildReleaseReadinessViewModel formats error status', async () => {
    const app = await import('../src/web/app.js');
    const buildReleaseReadinessViewModel = app.buildReleaseReadinessViewModel;
    if (!buildReleaseReadinessViewModel) {
      throw new Error('buildReleaseReadinessViewModel is not defined in src/web/app.js');
    }

    const result = buildReleaseReadinessViewModel(null, 'HTTP 500');
    assert.strictEqual(result.statusKey, 'error');
    assert.strictEqual(result.statusText, '检查失败');
    assert.strictEqual(result.expectedVersionText, '—');
    assert.strictEqual(result.actualVersionText, '—');
    assert.strictEqual(result.failedCountText, '—');
    assert.strictEqual(result.timestampText, '—');
    assert.ok(result.messageText.includes('HTTP 500'));
  });

  it('buildReleaseReadinessViewModel handles unknown or invalid inputs', async () => {
    const app = await import('../src/web/app.js');
    const buildReleaseReadinessViewModel = app.buildReleaseReadinessViewModel;
    if (!buildReleaseReadinessViewModel) {
      throw new Error('buildReleaseReadinessViewModel is not defined in src/web/app.js');
    }

    const resultNull = buildReleaseReadinessViewModel(null);
    assert.strictEqual(resultNull.statusKey, 'unknown');
    assert.strictEqual(resultNull.statusText, '未检查');
    assert.strictEqual(resultNull.expectedVersionText, '—');
    assert.strictEqual(resultNull.actualVersionText, '—');
    assert.strictEqual(resultNull.failedCountText, '—');
    assert.strictEqual(resultNull.timestampText, '—');
  });
});

describe('Gold readiness pure functions', () => {
  it('buildGoldReadinessViewModel handles unknown input', () => {
    const result = buildGoldReadinessViewModel(null);

    assert.strictEqual(result.statusKey, 'unknown');
    assert.strictEqual(result.statusText, '未检查');
    assert.strictEqual(result.readyCountText, '—');
    assert.strictEqual(result.partialCountText, '—');
    assert.strictEqual(result.blockedCountText, '—');
    assert.strictEqual(result.totalCountText, '—');
    assert.strictEqual(result.generatedAtText, '—');
    assert.deepStrictEqual(result.items, []);
    assert.ok(result.messageText.includes('/api/gold-readiness'));
  });

  it('buildGoldReadinessViewModel formats ready status', () => {
    const result = buildGoldReadinessViewModel({
      status: 'ready',
      version: LINKE_RELEASE_VERSION,
      generatedAt: '2026-07-06T12:00:00Z',
      summary: { ready: 9, partial: 0, blocked: 0, total: 9 },
      items: [
        {
          id: 'release-readiness',
          area: 'release',
          label: '发布就绪检查',
          status: 'ready',
          evidence: ['GET /api/release-readiness'],
          nextStep: '保持覆盖',
        },
      ],
    });

    assert.strictEqual(result.statusKey, 'ready');
    assert.strictEqual(result.statusText, '已就绪');
    assert.strictEqual(result.readyCountText, '9');
    assert.strictEqual(result.partialCountText, '0');
    assert.strictEqual(result.blockedCountText, '0');
    assert.strictEqual(result.totalCountText, '9');
    assert.strictEqual(result.generatedAtText, '2026-07-06T12:00:00Z');
    assert.strictEqual(result.items[0].id, 'release-readiness');
    assert.strictEqual(result.items[0].statusText, '已就绪');
  });

  it('buildGoldReadinessViewModel formats partial status', () => {
    const result = buildGoldReadinessViewModel({
      status: 'partial',
      generatedAt: '2026-07-06T12:00:00Z',
      summary: { ready: 7, partial: 2, blocked: 0, total: 9 },
      items: [],
    });

    assert.strictEqual(result.statusKey, 'partial');
    assert.strictEqual(result.statusText, '部分就绪');
    assert.strictEqual(result.readyCountText, '7');
    assert.strictEqual(result.partialCountText, '2');
    assert.strictEqual(result.blockedCountText, '0');
    assert.strictEqual(result.totalCountText, '9');
    assert.ok(result.messageText.includes('部分'));
  });

  it('buildGoldReadinessViewModel formats blocked status and item evidence', () => {
    const result = buildGoldReadinessViewModel({
      status: 'blocked',
      generatedAt: '2026-07-06T12:00:00Z',
      summary: { ready: 4, partial: 2, blocked: 3, total: 9 },
      items: [
        {
          id: 'security-auth',
          area: 'security',
          label: '认证与授权',
          status: 'blocked',
          evidence: ['README', 'test/readme.test.js'],
          nextStep: '实现认证与授权',
        },
      ],
    });

    assert.strictEqual(result.statusKey, 'blocked');
    assert.strictEqual(result.statusText, '阻塞');
    assert.strictEqual(result.readyCountText, '4');
    assert.strictEqual(result.partialCountText, '2');
    assert.strictEqual(result.blockedCountText, '3');
    assert.strictEqual(result.totalCountText, '9');
    assert.strictEqual(result.items[0].statusText, '阻塞');
    assert.ok(result.items[0].evidenceText.includes('test/readme.test.js'));
    assert.ok(result.messageText.includes('阻塞'));
  });

  it('buildGoldReadinessViewModel formats error status', () => {
    const result = buildGoldReadinessViewModel(null, 'HTTP 500');

    assert.strictEqual(result.statusKey, 'error');
    assert.strictEqual(result.statusText, '检查失败');
    assert.strictEqual(result.readyCountText, '—');
    assert.strictEqual(result.partialCountText, '—');
    assert.strictEqual(result.blockedCountText, '—');
    assert.strictEqual(result.totalCountText, '—');
    assert.strictEqual(result.generatedAtText, '—');
    assert.deepStrictEqual(result.items, []);
    assert.ok(result.messageText.includes('HTTP 500'));
  });
});

describe('DOM test: release readiness panel interactions', () => {
  it('does not request /api/release-readiness on initialization', async () => {
    const doc = buildMockDoc();
    let readinessFetchCount = 0;
    const mockFetch = async (url) => {
      if (url.includes('/api/release-readiness')) readinessFetchCount++;
      return { ok: true, status: 200, json: async () => ({}) };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(readinessFetchCount, 0, 'should not call /api/release-readiness on init');
  });

  it('requests /api/release-readiness only once and renders ready status when refresh button is clicked', async () => {
    const doc = buildMockDoc();
    let readinessFetchCount = 0;
    const mockFetch = async (url) => {
      if (url.includes('/api/release-readiness')) {
        readinessFetchCount++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ready: true,
            service: 'linke',
            expectedVersion: LINKE_RELEASE_VERSION,
            actualVersion: LINKE_RELEASE_VERSION,
            status: 'ok',
            checkedAt: '2026-07-06T12:00:00Z',
            checks: [
              { id: 'health.status', ok: true, expected: 'ok', actual: 'ok' },
              { id: 'release.version', ok: true, expected: LINKE_RELEASE_VERSION, actual: LINKE_RELEASE_VERSION }
            ]
          }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    const refreshBtn = doc.querySelector('[data-testid="release-readiness-refresh"]') || doc.getElementById('release-readiness-refresh');
    const panel = doc.querySelector('[data-testid="release-readiness-panel"]') || doc.getElementById('release-readiness-panel');
    const statusEl = doc.querySelector('[data-testid="release-readiness-status"]') || doc.getElementById('release-readiness-status');
    const expectedEl = doc.querySelector('[data-testid="release-readiness-expected-version"]') || doc.getElementById('release-readiness-expected-version');
    const actualEl = doc.querySelector('[data-testid="release-readiness-actual-version"]') || doc.getElementById('release-readiness-actual-version');
    const failedEl = doc.querySelector('[data-testid="release-readiness-failed-count"]') || doc.getElementById('release-readiness-failed-count');
    const messageEl = doc.querySelector('[data-testid="release-readiness-message"]') || doc.getElementById('release-readiness-message');

    assert.ok(refreshBtn, 'refresh button must exist');
    assert.ok(panel, 'release readiness panel must exist');

    if (refreshBtn._listeners.click) {
      await refreshBtn._listeners.click();
    }
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(readinessFetchCount, 1, 'should request /api/release-readiness exactly once');
    assert.strictEqual(panel._attrs['data-status'] || panel.dataset.status, 'ready');
    assert.strictEqual(statusEl.textContent, '已就绪');
    assert.strictEqual(expectedEl.textContent, LINKE_RELEASE_VERSION);
    assert.strictEqual(actualEl.textContent, LINKE_RELEASE_VERSION);
    assert.strictEqual(failedEl.textContent, '0');
    assert.ok(messageEl.textContent.includes('就绪'));
  });

  it('renders not-ready status and fails when release-readiness returns false for ready', async () => {
    const doc = buildMockDoc();
    const mockFetch = async (url) => {
      if (url.includes('/api/release-readiness')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ready: false,
            service: 'linke',
            expectedVersion: LINKE_RELEASE_VERSION,
            actualVersion: 'V0.0',
            status: 'degraded',
            checkedAt: '2026-07-06T12:00:00Z',
            checks: [
              { id: 'health.status', ok: false, expected: 'ok', actual: 'degraded' },
              { id: 'release.version', ok: false, expected: LINKE_RELEASE_VERSION, actual: 'V0.0' }
            ]
          }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    const refreshBtn = doc.querySelector('[data-testid="release-readiness-refresh"]');
    const panel = doc.querySelector('[data-testid="release-readiness-panel"]');
    const statusEl = doc.querySelector('[data-testid="release-readiness-status"]');
    const failedEl = doc.querySelector('[data-testid="release-readiness-failed-count"]');

    if (refreshBtn._listeners.click) {
      await refreshBtn._listeners.click();
    }
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(panel._attrs['data-status'] || panel.dataset.status, 'not-ready');
    assert.strictEqual(statusEl.textContent, '未就绪');
    assert.strictEqual(failedEl.textContent, '2');
  });

  it('renders error on non-2xx response from release-readiness', async () => {
    const doc = buildMockDoc();
    const mockFetch = async (url) => {
      if (url.includes('/api/release-readiness')) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ status: 'error', message: 'HTTP 500' }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    const refreshBtn = doc.querySelector('[data-testid="release-readiness-refresh"]');
    const panel = doc.querySelector('[data-testid="release-readiness-panel"]');
    const statusEl = doc.querySelector('[data-testid="release-readiness-status"]');
    const messageEl = doc.querySelector('[data-testid="release-readiness-message"]');

    if (refreshBtn._listeners.click) {
      await refreshBtn._listeners.click();
    }
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(panel._attrs['data-status'] || panel.dataset.status, 'error');
    assert.strictEqual(statusEl.textContent, '检查失败');
    assert.ok(messageEl.textContent.includes('失败') || messageEl.textContent.includes('500'));
  });

  it('disables release-readiness refresh button during active request and restores afterwards', async () => {
    const doc = buildMockDoc();
    let resolveRequest;
    const requestPromise = new Promise((resolve) => {
      resolveRequest = resolve;
    });

    const mockFetch = async (url) => {
      if (url.includes('/api/release-readiness')) {
        await requestPromise;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ready: true,
            service: 'linke',
            expectedVersion: LINKE_RELEASE_VERSION,
            actualVersion: LINKE_RELEASE_VERSION,
            status: 'ok',
            checkedAt: '2026-07-06T12:00:00Z',
            checks: []
          }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    const refreshBtn = doc.querySelector('[data-testid="release-readiness-refresh"]');
    let clickPromise;
    if (refreshBtn._listeners.click) {
      clickPromise = refreshBtn._listeners.click();
    }

    await new Promise((r) => setTimeout(r, 10));

    const isDisabled = refreshBtn.disabled === true || refreshBtn.getAttribute('disabled') === 'true' || refreshBtn.getAttribute('disabled') === true;
    assert.strictEqual(isDisabled, true, 'button.disabled must be true during request');

    const ariaDisabledDuring = refreshBtn.getAttribute('aria-disabled');
    assert.ok(ariaDisabledDuring === 'true' || ariaDisabledDuring === true, 'aria-disabled must be true during request');

    resolveRequest();
    if (clickPromise) {
      await clickPromise;
    }
    await new Promise((r) => setTimeout(r, 30));

    const isDisabledAfter = refreshBtn.disabled === false || refreshBtn.getAttribute('disabled') === 'false' || refreshBtn.getAttribute('disabled') === false || refreshBtn.getAttribute('disabled') === null;
    assert.strictEqual(isDisabledAfter, true, 'button.disabled must be false after request');
  });

  it('does not start a second release-readiness request while one is in flight', async () => {
    const doc = buildMockDoc();
    let readinessFetchCount = 0;
    let resolveRequest;
    const requestPromise = new Promise((resolve) => {
      resolveRequest = resolve;
    });

    const mockFetch = async (url) => {
      if (url.includes('/api/release-readiness')) {
        readinessFetchCount++;
        await requestPromise;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ready: true,
            service: 'linke',
            expectedVersion: LINKE_RELEASE_VERSION,
            actualVersion: LINKE_RELEASE_VERSION,
            status: 'ok',
            checkedAt: '2026-07-06T12:00:00Z',
            checks: []
          }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    const refreshBtn = doc.querySelector('[data-testid="release-readiness-refresh"]');
    const firstClick = refreshBtn._listeners.click();
    await new Promise((r) => setTimeout(r, 10));
    const secondClick = refreshBtn._listeners.click();
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(readinessFetchCount, 1, 'in-flight guard must block duplicate release-readiness fetches');

    resolveRequest();
    await firstClick;
    await secondClick;
  });
});

describe('DOM test: gold readiness panel interactions', () => {
  it('does not request /api/gold-readiness on initialization', async () => {
    const doc = buildMockDoc();
    let goldFetchCount = 0;
    const mockFetch = async (url) => {
      if (url.includes('/api/gold-readiness')) goldFetchCount++;
      return { ok: true, status: 200, json: async () => ({}) };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(goldFetchCount, 0, 'should not call /api/gold-readiness on init');
  });

  it('requests /api/gold-readiness only once and renders blocked status when refresh button is clicked', async () => {
    const doc = buildMockDoc();
    let goldFetchCount = 0;
    const mockFetch = async (url) => {
      if (url.includes('/api/gold-readiness')) {
        goldFetchCount++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'blocked',
            version: LINKE_RELEASE_VERSION,
            generatedAt: '2026-07-06T12:00:00Z',
            summary: { ready: 4, partial: 2, blocked: 3, total: 9 },
            items: [
              {
                id: 'security-auth',
                area: 'security',
                label: '认证与授权',
                status: 'blocked',
                evidence: ['README', 'test/readme.test.js'],
                nextStep: '实现认证与授权',
              },
            ],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    const refreshBtn = doc.querySelector('[data-testid="gold-readiness-refresh"]');
    const panel = doc.querySelector('[data-testid="gold-readiness-panel"]');
    const statusEl = doc.querySelector('[data-testid="gold-readiness-status"]');
    const readyEl = doc.querySelector('[data-testid="gold-readiness-ready-count"]');
    const partialEl = doc.querySelector('[data-testid="gold-readiness-partial-count"]');
    const blockedEl = doc.querySelector('[data-testid="gold-readiness-blocked-count"]');
    const totalEl = doc.querySelector('[data-testid="gold-readiness-total-count"]');
    const messageEl = doc.querySelector('[data-testid="gold-readiness-message"]');

    assert.ok(refreshBtn, 'gold readiness refresh button must exist');
    assert.ok(panel, 'gold readiness panel must exist');

    if (refreshBtn._listeners.click) {
      await refreshBtn._listeners.click();
    }
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(goldFetchCount, 1, 'should request /api/gold-readiness exactly once');
    assert.strictEqual(panel._attrs['data-status'] || panel.dataset.status, 'blocked');
    assert.strictEqual(statusEl.textContent, '阻塞');
    assert.strictEqual(readyEl.textContent, '4');
    assert.strictEqual(partialEl.textContent, '2');
    assert.strictEqual(blockedEl.textContent, '3');
    assert.strictEqual(totalEl.textContent, '9');
    assert.ok(messageEl.textContent.includes('阻塞'));
  });

  it('renders blocked gold readiness item rows with evidence and next step', async () => {
    const doc = buildMockDoc();
    const mockFetch = async (url) => {
      if (url.includes('/api/gold-readiness')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'blocked',
            version: LINKE_RELEASE_VERSION,
            generatedAt: '2026-07-06T12:00:00Z',
            summary: { ready: 4, partial: 2, blocked: 3, total: 9 },
            items: [
              {
                id: 'real-nas-remote-backup',
                area: 'nas',
                label: '真实 NAS 远程备份',
                status: 'blocked',
                evidence: ['test/nas-dry-run.test.js'],
                nextStep: '实现真实 NAS 连接与远程备份',
              },
            ],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    const refreshBtn = doc.querySelector('[data-testid="gold-readiness-refresh"]');
    const listEl = doc.querySelector('[data-testid="gold-readiness-list"]');
    await refreshBtn._listeners.click();
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(listEl.children.length, 1);
    assert.strictEqual(listEl.children[0]._attrs['data-testid'], 'gold-readiness-item');
    assert.strictEqual(listEl.children[0]._attrs['data-status'], 'blocked');
    assert.ok(listEl.children[0].textContent.includes('real-nas-remote-backup'));
    assert.ok(listEl.children[0].textContent.includes('test/nas-dry-run.test.js'));
    assert.ok(listEl.children[0].textContent.includes('真实 NAS'));
  });

  it('does not start a second gold-readiness request while one is in flight', async () => {
    const doc = buildMockDoc();
    let goldFetchCount = 0;
    let resolveRequest;
    const requestPromise = new Promise((resolve) => {
      resolveRequest = resolve;
    });

    const mockFetch = async (url) => {
      if (url.includes('/api/gold-readiness')) {
        goldFetchCount++;
        await requestPromise;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'blocked',
            version: LINKE_RELEASE_VERSION,
            generatedAt: '2026-07-06T12:00:00Z',
            summary: { ready: 4, partial: 2, blocked: 3, total: 9 },
            items: [],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    const refreshBtn = doc.querySelector('[data-testid="gold-readiness-refresh"]');
    const firstClick = refreshBtn._listeners.click();
    await new Promise((r) => setTimeout(r, 10));
    const secondClick = refreshBtn._listeners.click();
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(goldFetchCount, 1, 'in-flight guard must block duplicate gold-readiness fetches');

    resolveRequest();
    await firstClick;
    await secondClick;
  });

  it('renders error on non-2xx response from gold-readiness', async () => {
    const doc = buildMockDoc();
    const mockFetch = async (url) => {
      if (url.includes('/api/gold-readiness')) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: 'HTTP 500' }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    const refreshBtn = doc.querySelector('[data-testid="gold-readiness-refresh"]');
    const panel = doc.querySelector('[data-testid="gold-readiness-panel"]');
    const statusEl = doc.querySelector('[data-testid="gold-readiness-status"]');
    const messageEl = doc.querySelector('[data-testid="gold-readiness-message"]');

    await refreshBtn._listeners.click();
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(panel._attrs['data-status'] || panel.dataset.status, 'error');
    assert.strictEqual(statusEl.textContent, '检查失败');
    assert.ok(messageEl.textContent.includes('失败') || messageEl.textContent.includes('500'));
  });
});

// ── V0.54 DOM test: API token UX interactions ─────────────────────
describe('DOM test: API token UX interactions', () => {
  it('entering token and clicking apply causes later /api/health fetch to include Authorization: Bearer <token>', async () => {
    const doc = buildMockDoc();
    let lastHeaders = null;
    const mockFetch = async (url, options) => {
      if (url.includes('/api/health')) {
        lastHeaders = options?.headers;
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 20));

    const tokenInput = doc.getElementById('api-token-input');
    const applyBtn = doc.getElementById('api-token-apply');
    const refreshBtn = doc.getElementById('release-health-refresh');

    tokenInput.value = 'secret-token-123';
    if (applyBtn._listeners.click) {
      await applyBtn._listeners.click();
    }
    await new Promise((r) => setTimeout(r, 20));

    if (refreshBtn._listeners.click) {
      await refreshBtn._listeners.click();
    }
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(lastHeaders, 'headers should be passed to fetch');
    assert.strictEqual(lastHeaders['Authorization'], 'Bearer secret-token-123');
  });

  it('no token means /api/health fetch has no Authorization header', async () => {
    const doc = buildMockDoc();
    let lastHeaders = null;
    const mockFetch = async (url, options) => {
      if (url.includes('/api/health')) {
        lastHeaders = options?.headers;
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 20));

    const refreshBtn = doc.getElementById('release-health-refresh');
    if (refreshBtn._listeners.click) {
      await refreshBtn._listeners.click();
    }
    await new Promise((r) => setTimeout(r, 20));

    if (lastHeaders) {
      assert.ok(!lastHeaders['Authorization'], 'should not have Authorization header');
    }
  });

  it('clicking clear removes token and later /api/health fetch has no Authorization header', async () => {
    const doc = buildMockDoc();
    let lastHeaders = null;
    const mockFetch = async (url, options) => {
      if (url.includes('/api/health')) {
        lastHeaders = options?.headers;
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 20));

    const tokenInput = doc.getElementById('api-token-input');
    const applyBtn = doc.getElementById('api-token-apply');
    const clearBtn = doc.getElementById('api-token-clear');
    const refreshBtn = doc.getElementById('release-health-refresh');

    tokenInput.value = 'secret-token-123';
    if (applyBtn._listeners.click) {
      await applyBtn._listeners.click();
    }
    await new Promise((r) => setTimeout(r, 20));

    if (clearBtn._listeners.click) {
      await clearBtn._listeners.click();
    }
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(tokenInput.value, '');

    if (refreshBtn._listeners.click) {
      await refreshBtn._listeners.click();
    }
    await new Promise((r) => setTimeout(r, 20));

    if (lastHeaders) {
      assert.ok(!lastHeaders['Authorization'], 'should not have Authorization header after clearing');
    }
  });

  it('a 401 response clears token and status says authentication failed', async () => {
    const doc = buildMockDoc();
    let lastHeaders = null;
    let fetchCount = 0;
    const mockFetch = async (url, options) => {
      if (url.includes('/api/health')) {
        fetchCount++;
        lastHeaders = options?.headers;
        if (fetchCount === 1) {
          return { ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 20));

    const tokenInput = doc.getElementById('api-token-input');
    const applyBtn = doc.getElementById('api-token-apply');
    const refreshBtn = doc.getElementById('release-health-refresh');
    const statusEl = doc.getElementById('api-token-status');

    tokenInput.value = 'secret-token-123';
    if (applyBtn._listeners.click) {
      await applyBtn._listeners.click();
    }
    await new Promise((r) => setTimeout(r, 20));

    if (refreshBtn._listeners.click) {
      await refreshBtn._listeners.click();
    }
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(tokenInput.value, '', 'token value should be cleared on 401');
    assert.ok(
      statusEl.textContent.toLowerCase().includes('failed') ||
      statusEl.textContent.includes('失败') ||
      statusEl.textContent.includes('未授权'),
      'status should indicate authentication failed'
    );

    lastHeaders = null;
    if (refreshBtn._listeners.click) {
      await refreshBtn._listeners.click();
    }
    await new Promise((r) => setTimeout(r, 20));

    if (lastHeaders) {
      assert.ok(!lastHeaders['Authorization'], 'later fetch should not contain Authorization header');
    }
  });

  it('token is not written to localStorage/sessionStorage/cookie if those APIs are present in the mock doc/window', async () => {
    const doc = buildMockDoc();
    const mockFetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

    const originalLocalStorage = globalThis.localStorage;
    const originalSessionStorage = globalThis.sessionStorage;
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;

    let localStorageWritten = false;
    let sessionStorageWritten = false;
    let cookieWritten = false;

    try {
      globalThis.localStorage = {
        setItem(key, value) {
          localStorageWritten = true;
        },
        getItem(key) { return null; },
        removeItem(key) {}
      };

      globalThis.sessionStorage = {
        setItem(key, value) {
          sessionStorageWritten = true;
        },
        getItem(key) { return null; },
        removeItem(key) {}
      };

      globalThis.window = {
        localStorage: globalThis.localStorage,
        sessionStorage: globalThis.sessionStorage,
      };

      globalThis.document = doc;

      Object.defineProperty(doc, 'cookie', {
        get() { return ''; },
        set(val) {
          cookieWritten = true;
        },
        configurable: true
      });

      initConsole(doc, mockFetch, () => 0);
      await new Promise((r) => setTimeout(r, 20));

      const tokenInput = doc.getElementById('api-token-input');
      const applyBtn = doc.getElementById('api-token-apply');

      tokenInput.value = 'secret-token-123';
      if (applyBtn._listeners.click) {
        await applyBtn._listeners.click();
      }
      await new Promise((r) => setTimeout(r, 20));

      assert.strictEqual(localStorageWritten, false, 'should not write to localStorage');
      assert.strictEqual(sessionStorageWritten, false, 'should not write to sessionStorage');
      assert.strictEqual(cookieWritten, false, 'should not write to cookie');
    } finally {
      if (originalLocalStorage === undefined) {
        delete globalThis.localStorage;
      } else {
        globalThis.localStorage = originalLocalStorage;
      }

      if (originalSessionStorage === undefined) {
        delete globalThis.sessionStorage;
      } else {
        globalThis.sessionStorage = originalSessionStorage;
      }

      if (originalWindow === undefined) {
        delete globalThis.window;
      } else {
        globalThis.window = originalWindow;
      }

      if (originalDocument === undefined) {
        delete globalThis.document;
      } else {
        globalThis.document = originalDocument;
      }
    }
  });
});

describe('Hardening status pure functions', () => {
  it('buildHardeningStatusViewModel is exported and handles unknown input', async () => {
    const app = await import('../src/web/app.js');
    const buildHardeningStatusViewModel = app.buildHardeningStatusViewModel;
    if (!buildHardeningStatusViewModel) {
      throw new Error('buildHardeningStatusViewModel is not defined in src/web/app.js');
    }

    const result = buildHardeningStatusViewModel(null);
    assert.strictEqual(result.statusKey, 'unknown');
    assert.strictEqual(result.statusText, '未检查');
    assert.strictEqual(result.authText, '—');
    assert.strictEqual(result.scopedTokensText, '—');
    assert.strictEqual(result.rateLimitText, '—');
    assert.strictEqual(result.auditRetentionText, '—');
    assert.strictEqual(result.restoreRootText, '—');
    assert.strictEqual(result.requestLimitText, '—');
    assert.strictEqual(result.writeRoutesText, '—');
    assert.ok(result.messageText.includes('/api/hardening-status'));
  });

  it('buildHardeningStatusViewModel formats error status', async () => {
    const app = await import('../src/web/app.js');
    const buildHardeningStatusViewModel = app.buildHardeningStatusViewModel;
    if (!buildHardeningStatusViewModel) {
      throw new Error('buildHardeningStatusViewModel is not defined in src/web/app.js');
    }

    const result = buildHardeningStatusViewModel(null, 'HTTP 500');
    assert.strictEqual(result.statusKey, 'error');
    assert.strictEqual(result.statusText, '检查失败');
    assert.strictEqual(result.authText, '—');
    assert.strictEqual(result.scopedTokensText, '—');
    assert.strictEqual(result.rateLimitText, '—');
    assert.strictEqual(result.auditRetentionText, '—');
    assert.strictEqual(result.restoreRootText, '—');
    assert.strictEqual(result.requestLimitText, '—');
    assert.strictEqual(result.writeRoutesText, '—');
    assert.ok(result.messageText.includes('HTTP 500'));

    const sensitiveResult = buildHardeningStatusViewModel(null, 'Bearer token abc123 rejected');
    assert.strictEqual(sensitiveResult.statusKey, 'error');
    assert.ok(sensitiveResult.messageText.includes('[redacted]'), 'credential-like error text must be redacted');
    assert.ok(!sensitiveResult.messageText.toLowerCase().includes('token'), 'credential-like error text must not be displayed');
  });

  it('buildHardeningStatusViewModel formats partial status with whitelisted fields', async () => {
    const app = await import('../src/web/app.js');
    const buildHardeningStatusViewModel = app.buildHardeningStatusViewModel;
    if (!buildHardeningStatusViewModel) {
      throw new Error('buildHardeningStatusViewModel is not defined in src/web/app.js');
    }

    const payload = {
      status: 'partial',
      service: 'linke',
      version: LINKE_RELEASE_VERSION,
      hardening: {
        authConfigured: true,
        scopedTokensConfigured: false,
        rateLimitConfigured: true,
        auditRetentionConfigured: false,
        restoreRootConfigured: true,
        requestBodyLimitBytes: 1048576,
        writeRoutes: [
          'POST /api/heartbeat',
          'POST /api/backups',
          'POST /api/restore'
        ]
      },
      safety: {
        tokenValuesReturned: false,
        restoreRootValueReturned: false,
        auditPathReturned: false,
        environmentValuesReturned: false,
        successAuditEvent: false
      }
    };

    const result = buildHardeningStatusViewModel(payload);
    assert.strictEqual(result.statusKey, 'partial');
    assert.strictEqual(result.statusText, '部分就绪');
    assert.strictEqual(result.authText, '已配置');
    assert.strictEqual(result.scopedTokensText, '未配置');
    assert.strictEqual(result.rateLimitText, '已配置');
    assert.strictEqual(result.auditRetentionText, '未配置');
    assert.strictEqual(result.restoreRootText, '已配置');
    assert.strictEqual(result.requestLimitText, '1048576');
    assert.strictEqual(result.writeRoutesText, '3');
  });
});

describe('Supervisor status pure functions', () => {
  it('buildSupervisorStatusViewModel is exported and handles unknown input', async () => {
    const app = await import('../src/web/app.js');
    const buildSupervisorStatusViewModel = app.buildSupervisorStatusViewModel;
    if (!buildSupervisorStatusViewModel) {
      throw new Error('buildSupervisorStatusViewModel is not defined in src/web/app.js');
    }

    const result = buildSupervisorStatusViewModel(null);
    assert.strictEqual(result.statusKey, 'unknown');
    assert.strictEqual(result.statusText, '未检查');
    assert.strictEqual(result.stateText, '—');
    assert.strictEqual(result.installedText, '—');
    assert.strictEqual(result.managedText, '—');
    assert.strictEqual(result.launchdText, '—');
    assert.strictEqual(result.watchdogText, '—');
    assert.strictEqual(result.monitoringText, '—');
    assert.strictEqual(result.recoveryText, '—');
    assert.strictEqual(result.safetyText, '—');
    assert.ok(result.messageText.includes('/api/supervisor-status'));
  });

  it('buildSupervisorStatusViewModel formats error status with redaction', async () => {
    const app = await import('../src/web/app.js');
    const buildSupervisorStatusViewModel = app.buildSupervisorStatusViewModel;
    if (!buildSupervisorStatusViewModel) {
      throw new Error('buildSupervisorStatusViewModel is not defined in src/web/app.js');
    }

    const result = buildSupervisorStatusViewModel(null, 'HTTP 500');
    assert.strictEqual(result.statusKey, 'error');
    assert.strictEqual(result.statusText, '检查失败');
    assert.strictEqual(result.stateText, '—');
    assert.ok(result.messageText.includes('HTTP 500'));

    const sensitiveResult = buildSupervisorStatusViewModel(null, 'Bearer token failed at /Users/ah/private/supervisor');
    assert.strictEqual(sensitiveResult.statusKey, 'error');
    assert.ok(sensitiveResult.messageText.includes('[redacted]'), 'credential-like or path-like error text must be redacted');
    assert.doesNotMatch(sensitiveResult.messageText, /Bearer|token|\/Users\/ah\/private/);
  });

  it('buildSupervisorStatusViewModel formats partial status with whitelisted fields', async () => {
    const app = await import('../src/web/app.js');
    const buildSupervisorStatusViewModel = app.buildSupervisorStatusViewModel;
    if (!buildSupervisorStatusViewModel) {
      throw new Error('buildSupervisorStatusViewModel is not defined in src/web/app.js');
    }

    const payload = {
      status: 'partial',
      service: 'linke',
      version: LINKE_RELEASE_VERSION,
      supervisor: {
        installed: false,
        managed: false,
        launchdConfigured: false,
        watchdogConfigured: false,
        monitoringConfigured: false,
        recoveryConfigured: false,
        state: 'not_configured',
        rawPath: '/Users/ah/private/supervisor',
      },
      safety: {
        launchctlCalled: false,
        processListRead: false,
        supervisorInstalled: false,
        metadataWritten: false,
        nasConnected: false,
        backupTriggered: false,
        restoreTriggered: false,
        remoteCommandExecuted: false,
        Authorization: 'Bearer leaked-token',
      }
    };

    const result = buildSupervisorStatusViewModel(payload);
    assert.strictEqual(result.statusKey, 'partial');
    assert.strictEqual(result.statusText, '部分就绪');
    assert.strictEqual(result.stateText, 'not_configured');
    assert.strictEqual(result.installedText, '未配置');
    assert.strictEqual(result.managedText, '未配置');
    assert.strictEqual(result.launchdText, '未配置');
    assert.strictEqual(result.watchdogText, '未配置');
    assert.strictEqual(result.monitoringText, '未配置');
    assert.strictEqual(result.recoveryText, '未配置');
    assert.match(result.safetyText, /launchctl:false/);
    assert.match(result.safetyText, /process:false/);
    assert.match(result.safetyText, /metadata:false/);
    assert.match(result.safetyText, /NAS:false/);
    assert.match(result.safetyText, /backup:false/);
    assert.match(result.safetyText, /restore:false/);
    assert.match(result.safetyText, /remote:false/);

    const text = JSON.stringify(result);
    assert.doesNotMatch(text, /Bearer|leaked-token|private\/supervisor|rawPath|Authorization/);
  });
});

describe('buildSupervisorInstallDryRunViewModel', () => {
  it('returns unknown state for missing payload', () => {
    const result = buildSupervisorInstallDryRunViewModel(null);

    assert.strictEqual(result.statusKey, 'unknown');
    assert.strictEqual(result.statusText, '未检查');
    assert.strictEqual(result.installStateText, '—');
    assert.strictEqual(result.approvalStateText, '—');
    assert.strictEqual(result.rollbackStateText, '—');
    assert.deepStrictEqual(result.rollbackUninstallActions, []);
    assert.deepStrictEqual(result.rollbackUninstallSafetyLines, []);
    assert.match(result.messageText, /supervisor install dry-run/i);
  });

  it('returns sanitized blocked display fields for a full dry-run plan', () => {
    const result = buildSupervisorInstallDryRunViewModel({
      status: 'partial',
      command: 'supervisor-install-dry-run',
      supervisor: {
        state: 'not_configured',
        wouldInstall: false,
        wouldStart: false,
        program: 'node src/agent.js run-once --config /Users/ah/secret-config.json',
      },
      readinessSummary: {
        state: 'blocked',
        blockers: ['real-install-not-implemented'],
      },
      installCommandPreview: {
        state: 'blocked',
        actions: [
          {
            id: 'write-launch-agent-plist',
            command: 'launchctl bootstrap gui/501 /Users/ah/Library/LaunchAgents/com.linke.agent.plist',
            wouldRun: false,
            wouldWrite: false,
          },
        ],
      },
      installPreflight: {
        state: 'blocked',
        checks: [
          { id: 'launchd-install', status: 'blocked', blockerCode: 'launchd-install-blocked' },
        ],
      },
      installApprovalManifest: {
        state: 'blocked',
        approval: { approved: false },
        rollback: { available: false },
        controls: [
          { id: 'explicit-operator-approval', status: 'blocked', blockerCode: 'operator-approval-required' },
        ],
      },
      rollbackUninstallPlan: {
        state: 'blocked',
        rollback: {
          available: false,
          evidence: 'restore previous plist from /Users/ah/Library/LaunchAgents/com.linke.agent.plist',
        },
        uninstall: {
          available: false,
          evidence: 'run launchctl unload and rm secret plist',
        },
        recovery: {
          available: false,
          evidence: 'start recovery supervisor on hostname secret-host pid 42',
        },
        actions: [
          {
            id: 'capture-current-state',
            kind: 'rollback',
            status: 'blocked',
            command: 'launchctl print gui/501/com.linke.agent',
            evidence: 'read /Users/ah/private-state.json',
            wouldRun: false,
            wouldWrite: false,
            blockerCode: 'rollback-state-capture-missing',
          },
          {
            id: 'unload-launch-agent',
            kind: 'uninstall',
            status: 'blocked',
            command: 'launchctl bootout gui/501 /Users/ah/Library/LaunchAgents/com.linke.agent.plist',
            evidence: 'operator Aaron timestamp 2026-07-07T00:00:00Z',
            wouldRun: false,
            wouldWrite: false,
            blockerCode: 'launchd-unload-blocked',
          },
        ],
        safety: {
          dryRun: true,
          planOnly: true,
          rollbackExecuted: false,
          uninstallExecuted: false,
          recoverySupervisorStarted: false,
          launchctlCalled: false,
          processListRead: false,
          filesystemWritten: false,
          metadataWritten: false,
          supervisorInstalled: false,
          supervisorStarted: false,
          launchdFileWritten: false,
          launchdFileRemoved: false,
          previousPlistRestored: false,
          nasConnected: false,
          backupTriggered: false,
          restoreTriggered: false,
          remoteCommandExecuted: false,
          sensitiveValuesReturned: false,
        },
      },
      safety: {
        launchctlCalled: false,
        processListRead: false,
        launchdFileWritten: false,
        metadataWritten: false,
        nasConnected: false,
        backupTriggered: false,
        restoreTriggered: false,
        remoteCommandExecuted: false,
      },
      configSummary: {
        deviceId: 'secret-device',
      },
    });
    const text = JSON.stringify(result);

    assert.strictEqual(result.statusKey, 'partial');
    assert.strictEqual(result.statusText, '部分就绪');
    assert.strictEqual(result.installStateText, 'not_configured / wouldInstall:false / wouldStart:false');
    assert.strictEqual(result.approvalStateText, 'approved:false');
    assert.strictEqual(result.rollbackStateText, 'rollback:false / uninstall:false / recovery:false');
    assert.deepStrictEqual(result.readinessBlockers, ['real-install-not-implemented']);
    assert.deepStrictEqual(result.commandActions, ['write-launch-agent-plist · wouldRun:false · wouldWrite:false']);
    assert.deepStrictEqual(result.preflightChecks, ['launchd-install · blocked · launchd-install-blocked']);
    assert.deepStrictEqual(result.approvalControls, ['explicit-operator-approval · blocked · operator-approval-required']);
    assert.deepStrictEqual(result.rollbackUninstallActions, [
      'capture-current-state · rollback · blocked · wouldRun:false · wouldWrite:false · rollback-state-capture-missing',
      'unload-launch-agent · uninstall · blocked · wouldRun:false · wouldWrite:false · launchd-unload-blocked',
    ]);
    assert.ok(result.rollbackUninstallSafetyLines.includes('dryRun:true'));
    assert.ok(result.rollbackUninstallSafetyLines.includes('planOnly:true'));
    assert.ok(result.rollbackUninstallSafetyLines.includes('rollbackExecuted:false'));
    assert.ok(result.rollbackUninstallSafetyLines.includes('uninstallExecuted:false'));
    assert.ok(result.rollbackUninstallSafetyLines.includes('recoverySupervisorStarted:false'));
    assert.ok(result.rollbackUninstallSafetyLines.includes('launchctlCalled:false'));
    assert.ok(result.rollbackUninstallSafetyLines.includes('processListRead:false'));
    assert.ok(result.rollbackUninstallSafetyLines.includes('filesystemWritten:false'));
    assert.ok(result.rollbackUninstallSafetyLines.includes('metadataWritten:false'));
    assert.ok(result.rollbackUninstallSafetyLines.includes('supervisorInstalled:false'));
    assert.ok(result.rollbackUninstallSafetyLines.includes('supervisorStarted:false'));
    assert.ok(result.rollbackUninstallSafetyLines.includes('launchdFileWritten:false'));
    assert.ok(result.rollbackUninstallSafetyLines.includes('launchdFileRemoved:false'));
    assert.ok(result.rollbackUninstallSafetyLines.includes('previousPlistRestored:false'));
    assert.ok(result.rollbackUninstallSafetyLines.includes('sensitiveValuesReturned:false'));
    assert.ok(result.safetyLines.includes('launchctlCalled:false'));
    assert.ok(!text.includes('/Users/ah/secret-config.json'), 'view model must not expose config path');
    assert.ok(!text.includes('launchctl bootstrap'), 'view model must not expose runnable command');
    assert.ok(!text.includes('secret-device'), 'view model must not expose arbitrary config summary strings');
    assert.ok(!text.includes('restore previous plist'), 'view model must not expose lifecycle evidence');
    assert.ok(!text.includes('launchctl bootout'), 'view model must not expose runnable rollback command');
    assert.ok(!text.includes('secret-host'), 'view model must not expose hostnames');
    assert.ok(!text.includes('pid 42'), 'view model must not expose process identifiers');
    assert.ok(!text.includes('2026-07-07T00:00:00Z'), 'view model must not expose timestamps');
  });

  it('returns sanitized error state', () => {
    const result = buildSupervisorInstallDryRunViewModel(null, 'serverUrl secret-value is invalid');

    assert.strictEqual(result.statusKey, 'error');
    assert.strictEqual(result.statusText, '检查失败');
    assert.deepStrictEqual(result.rollbackUninstallActions, []);
    assert.deepStrictEqual(result.rollbackUninstallSafetyLines, []);
    assert.ok(!result.messageText.includes('secret-value'), 'error message must be sanitized');
  });
});

describe('buildSupervisorLifecycleApprovalPersistencePreviewViewModel', () => {
  it('returns unknown state for missing payload', () => {
    const result = buildSupervisorLifecycleApprovalPersistencePreviewViewModel(null);

    assert.strictEqual(result.statusKey, 'unknown');
    assert.strictEqual(result.statusText, '未检查');
    assert.strictEqual(result.approvalValidText, '—');
    assert.strictEqual(result.persistenceText, '—');
    assert.deepStrictEqual(result.blockers, []);
    assert.deepStrictEqual(result.requiredFields, []);
    assert.deepStrictEqual(result.validationLines, []);
    assert.deepStrictEqual(result.safetyLines, []);
    assert.match(result.messageText, /approval persistence preview/i);
  });

  it('returns sanitized blocked display fields for approval persistence preview', () => {
    const result = buildSupervisorLifecycleApprovalPersistencePreviewViewModel({
      command: 'supervisor-lifecycle-approval-persistence-preview',
      operation: 'install',
      state: 'blocked',
      approvalValid: true,
      blockers: ['approval-persistence-store-missing'],
      persistence: {
        previewOnly: true,
        wouldPersist: false,
        recordSchemaVersion: 1,
        requiredRecordFields: [
          'schemaVersion',
          'operation',
          'configHash',
          'planHash',
          'approvedAt',
          'expiresAt',
          'approvedBy',
          'reason',
          'acknowledgements',
        ],
        validation: {
          approvalValid: true,
          acknowledgementCount: 1,
          windowWithinLimit: true,
          operationMatchesPlan: true,
          configHashMatchesPlan: true,
          planHashMatchesPlan: true,
          approvedBy: 'operator@example.invalid',
          configHash: 'sha256:secret',
        },
      },
      safety: {
        dryRun: true,
        hostMutation: false,
        launchctlCalled: false,
        filesystemWritten: false,
        metadataWritten: false,
        rollbackAnchorWritten: false,
        auditEventWritten: false,
        approvalPersisted: false,
        sensitiveValuesReturned: false,
      },
      approvedBy: 'operator@example.invalid',
      reason: 'secret reason',
      configHash: 'sha256:secret',
      sourcePath: '/Users/ah/Documents',
    });
    const text = JSON.stringify(result);

    assert.strictEqual(result.statusKey, 'blocked');
    assert.strictEqual(result.statusText, '阻塞');
    assert.strictEqual(result.approvalValidText, 'true');
    assert.strictEqual(result.persistenceText, 'previewOnly:true / wouldPersist:false');
    assert.deepStrictEqual(result.blockers, ['approval-persistence-store-missing']);
    assert.ok(result.requiredFields.includes('approvedBy'));
    assert.ok(result.validationLines.includes('approvalValid:true'));
    assert.ok(result.validationLines.includes('acknowledgementCount:1'));
    assert.ok(result.validationLines.includes('windowWithinLimit:true'));
    assert.ok(result.safetyLines.includes('approvalPersisted:false'));
    assert.ok(result.safetyLines.includes('filesystemWritten:false'));
    assert.ok(!text.includes('operator@example'), 'must not expose approval identity values');
    assert.ok(!text.includes('secret reason'), 'must not expose approval reasons');
    assert.ok(!text.includes('sha256:secret'), 'must not expose hashes');
    assert.ok(!text.includes('/Users/ah/Documents'), 'must not expose paths');
  });

  it('returns sanitized error state', () => {
    const result = buildSupervisorLifecycleApprovalPersistencePreviewViewModel(null, 'approval token secret-value invalid');

    assert.strictEqual(result.statusKey, 'error');
    assert.strictEqual(result.statusText, '检查失败');
    assert.deepStrictEqual(result.blockers, []);
    assert.ok(!result.messageText.includes('secret-value'), 'error message must be sanitized');
  });
});

describe('buildSupervisorLifecycleApprovalPersistViewModel', () => {
  it('returns sanitized persisted record display fields for approval persist response', () => {
    const result = buildSupervisorLifecycleApprovalPersistViewModel({
      command: 'supervisor-lifecycle-approval-record',
      operation: 'install',
      state: 'persisted',
      approvalValid: true,
      blockersResolved: ['approval-persistence-store-missing'],
      validation: {
        approvalValid: true,
        acknowledgementCount: 1,
        windowWithinLimit: true,
        operationMatchesPlan: true,
        configHashMatchesPlan: true,
        planHashMatchesPlan: true,
        approvedBy: 'operator@example.invalid',
        configHash: 'sha256:secret',
      },
      safety: {
        approvalPersisted: true,
        filesystemWritten: true,
        hostMutation: false,
        launchctlCalled: false,
        lifecycleApplied: false,
        sensitiveValuesReturned: false,
      },
      approvedBy: 'operator@example.invalid',
      reason: 'secret reason',
      configHash: 'sha256:secret',
      sourcePath: '/Users/ah/Documents',
    }, 201);
    const text = JSON.stringify(result);

    assert.strictEqual(result.statusKey, 'ready');
    assert.strictEqual(result.statusText, '已记录');
    assert.strictEqual(result.approvalValidText, 'true');
    assert.strictEqual(result.persistenceText, 'approvalRecord:persisted / lifecycleApply:false');
    assert.deepStrictEqual(result.blockers, ['approval-persistence-store-missing']);
    assert.deepStrictEqual(result.requiredFields, []);
    assert.ok(result.validationLines.includes('acknowledgementCount:1'));
    assert.ok(result.safetyLines.includes('approvalPersisted:true'));
    assert.ok(result.safetyLines.includes('lifecycleApplied:false'));
    assert.match(result.messageText, /Persisted approval record for install/);
    assert.match(result.messageText, /not lifecycle apply/i);
    assert.ok(!text.includes('operator@example'), 'must not expose approval identity values');
    assert.ok(!text.includes('secret reason'), 'must not expose approval reasons');
    assert.ok(!text.includes('sha256:secret'), 'must not expose hashes');
    assert.ok(!text.includes('/Users/ah/Documents'), 'must not expose paths');
  });

  it('renders blocked previews and sanitized error state for persist responses', () => {
    const blocked = buildSupervisorLifecycleApprovalPersistViewModel({
      command: 'supervisor-lifecycle-approval-persistence-preview',
      operation: 'rollback',
      state: 'blocked',
      approvalValid: false,
      blockers: ['approval-operation-mismatch'],
      persistence: {
        previewOnly: true,
        wouldPersist: false,
        requiredRecordFields: ['approvedBy'],
        validation: { approvalValid: false, acknowledgementCount: 1 },
      },
      safety: { approvalPersisted: false, lifecycleApplied: false },
    }, 409);

    assert.strictEqual(blocked.statusKey, 'blocked');
    assert.deepStrictEqual(blocked.blockers, ['approval-operation-mismatch']);
    assert.strictEqual(blocked.persistenceText, 'previewOnly:true / wouldPersist:false');

    const failed = buildSupervisorLifecycleApprovalPersistViewModel(null, 500, 'Bearer token secret-value failed at /Users/ah/private');
    assert.strictEqual(failed.statusKey, 'error');
    assert.ok(!failed.messageText.includes('secret-value'), 'error message must be sanitized');
    assert.ok(!failed.messageText.includes('/Users/ah/private'), 'error path must be sanitized');
  });
});

describe('DOM test: hardening status panel interactions', () => {
  it('does not request /api/hardening-status on initialization', async () => {
    const doc = buildMockDoc();
    let hardeningFetchCount = 0;
    const mockFetch = async (url) => {
      if (url.includes('/api/hardening-status')) hardeningFetchCount++;
      return { ok: true, status: 200, json: async () => ({}) };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(hardeningFetchCount, 0, 'should not call /api/hardening-status on init');
  });

  it('requests /api/hardening-status only once and renders partial status and whitelisted fields when refresh button is clicked', async () => {
    const doc = buildMockDoc();
    let hardeningFetchCount = 0;
    const mockFetch = async (url) => {
      if (url.includes('/api/hardening-status')) {
        hardeningFetchCount++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'partial',
            service: 'linke',
            version: LINKE_RELEASE_VERSION,
            hardening: {
              authConfigured: true,
              scopedTokensConfigured: true,
              rateLimitConfigured: true,
              auditRetentionConfigured: true,
              restoreRootConfigured: true,
              requestBodyLimitBytes: 1048576,
              writeRoutes: [
                'POST /api/heartbeat',
                'POST /api/backups',
                'POST /api/restore'
              ]
            },
            safety: {
              tokenValuesReturned: false,
              restoreRootValueReturned: false,
              restoreRootPath: '/Users/ah/secret-path',
              auditPathReturned: false,
              environmentValuesReturned: false,
              successAuditEvent: false
            }
          }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    const refreshBtn = doc.querySelector('[data-testid="hardening-status-refresh"]');
    const panel = doc.querySelector('[data-testid="hardening-status-panel"]');
    const authEl = doc.querySelector('[data-testid="hardening-status-auth"]');
    const scopedEl = doc.querySelector('[data-testid="hardening-status-scoped-tokens"]');
    const rateLimitEl = doc.querySelector('[data-testid="hardening-status-rate-limit"]');
    const auditEl = doc.querySelector('[data-testid="hardening-status-audit-retention"]');
    const restoreEl = doc.querySelector('[data-testid="hardening-status-restore-root"]');
    const limitEl = doc.querySelector('[data-testid="hardening-status-request-limit"]');
    const routesEl = doc.querySelector('[data-testid="hardening-status-write-routes"]');

    assert.ok(refreshBtn, 'refresh button must exist');
    assert.ok(panel, 'hardening status panel must exist');

    if (refreshBtn._listeners.click) {
      await refreshBtn._listeners.click();
    }
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(hardeningFetchCount, 1, 'should request /api/hardening-status exactly once');
    assert.strictEqual(panel._attrs['data-status'] || panel.dataset.status, 'partial');
    assert.match(authEl.textContent, /已配置|已启用|true/);
    assert.match(scopedEl.textContent, /已配置|已启用|true/);
    assert.match(rateLimitEl.textContent, /已配置|已启用|true/);
    assert.match(auditEl.textContent, /已配置|已启用|true/);
    assert.match(restoreEl.textContent, /已配置|已启用|true/);
    assert.ok(limitEl.textContent.includes('1048576'));
    assert.ok(routesEl.textContent.includes('3'));

    const panelHtml = panel.innerHTML || '';
    assert.ok(!panelHtml.includes('/Users/ah/secret-path'), 'should redact or omit path-like secret material');
  });

  it('renders error on non-2xx response from hardening-status', async () => {
    const doc = buildMockDoc();
    const mockFetch = async (url) => {
      if (url.includes('/api/hardening-status')) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: '/Users/ah/private/restore-root failed' }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    const refreshBtn = doc.querySelector('[data-testid="hardening-status-refresh"]');
    const panel = doc.querySelector('[data-testid="hardening-status-panel"]');
    const messageEl = doc.querySelector('[data-testid="hardening-status-message"]');
    const eventLogEl = doc.getElementById('event-log');

    if (refreshBtn._listeners.click) {
      await refreshBtn._listeners.click();
    }
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(panel._attrs['data-status'] || panel.dataset.status, 'error');
    assert.ok(messageEl.textContent.includes('失败') || messageEl.textContent.includes('500'));
    assert.ok(messageEl.textContent.includes('[redacted]'), 'panel error message must redact path-like material');
    assert.ok(!messageEl.textContent.includes('/Users/ah/private/restore-root'), 'panel must not display raw path-like error material');
    assert.ok(!eventLogEl.textContent.includes('/Users/ah/private/restore-root'), 'event log must not display raw path-like error material');
  });

  it('disables hardening-status refresh button during active request and restores afterwards', async () => {
    const doc = buildMockDoc();
    let resolveRequest;
    const requestPromise = new Promise((resolve) => {
      resolveRequest = resolve;
    });

    const mockFetch = async (url) => {
      if (url.includes('/api/hardening-status')) {
        await requestPromise;
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'partial' }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    const refreshBtn = doc.querySelector('[data-testid="hardening-status-refresh"]');
    let clickPromise;
    if (refreshBtn._listeners.click) {
      clickPromise = refreshBtn._listeners.click();
    }

    await new Promise((r) => setTimeout(r, 10));

    const isDisabled = refreshBtn.disabled === true || refreshBtn.getAttribute('disabled') === 'true' || refreshBtn.getAttribute('disabled') === true;
    assert.strictEqual(isDisabled, true, 'button.disabled must be true during request');

    resolveRequest();
    if (clickPromise) {
      await clickPromise;
    }
    await new Promise((r) => setTimeout(r, 30));

    const isDisabledAfter = refreshBtn.disabled === false || refreshBtn.getAttribute('disabled') === 'false' || refreshBtn.getAttribute('disabled') === false || refreshBtn.getAttribute('disabled') === null;
    assert.strictEqual(isDisabledAfter, true, 'button.disabled must be false after request');
  });

  it('does not start a second hardening-status request while one is in flight', async () => {
    const doc = buildMockDoc();
    let hardeningFetchCount = 0;
    let resolveRequest;
    const requestPromise = new Promise((resolve) => {
      resolveRequest = resolve;
    });

    const mockFetch = async (url) => {
      if (url.includes('/api/hardening-status')) {
        hardeningFetchCount++;
        await requestPromise;
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'partial' }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    const refreshBtn = doc.querySelector('[data-testid="hardening-status-refresh"]');
    const firstClick = refreshBtn._listeners.click();
    await new Promise((r) => setTimeout(r, 10));
    const secondClick = refreshBtn._listeners.click();
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(hardeningFetchCount, 1, 'in-flight guard must block duplicate hardening-status fetches');

    resolveRequest();
    await firstClick;
    await secondClick;
  });
});

describe('DOM test: supervisor-status panel interactions', () => {
  it('does not request /api/supervisor-status on initialization', async () => {
    const doc = buildMockDoc();
    let supervisorFetchCount = 0;
    const mockFetch = async (url) => {
      if (url.includes('/api/supervisor-status')) supervisorFetchCount++;
      return { ok: true, status: 200, json: async () => ({}) };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(supervisorFetchCount, 0, 'should not call /api/supervisor-status on init');
  });

  it('requests /api/supervisor-status only once and renders partial status and whitelisted fields when refresh button is clicked', async () => {
    const doc = buildMockDoc();
    let supervisorFetchCount = 0;
    const mockFetch = async (url) => {
      if (url.includes('/api/supervisor-status')) {
        supervisorFetchCount++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'partial',
            service: 'linke',
            version: LINKE_RELEASE_VERSION,
            supervisor: {
              installed: false,
              managed: false,
              launchdConfigured: false,
              watchdogConfigured: false,
              monitoringConfigured: false,
              recoveryConfigured: false,
              state: 'not_configured',
              rawPath: '/Users/ah/private/supervisor',
            },
            safety: {
              launchctlCalled: false,
              processListRead: false,
              supervisorInstalled: false,
              metadataWritten: false,
              nasConnected: false,
              backupTriggered: false,
              restoreTriggered: false,
              remoteCommandExecuted: false,
              Authorization: 'Bearer leaked-token',
            }
          }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    const refreshBtn = doc.querySelector('[data-testid="supervisor-status-refresh"]');
    const panel = doc.querySelector('[data-testid="supervisor-status-panel"]');
    const stateEl = doc.querySelector('[data-testid="supervisor-status-state"]');
    const installedEl = doc.querySelector('[data-testid="supervisor-status-installed"]');
    const managedEl = doc.querySelector('[data-testid="supervisor-status-managed"]');
    const launchdEl = doc.querySelector('[data-testid="supervisor-status-launchd"]');
    const safetyEl = doc.querySelector('[data-testid="supervisor-status-safety"]');
    const messageEl = doc.querySelector('[data-testid="supervisor-status-message"]');

    assert.ok(refreshBtn, 'supervisor-status refresh button must exist');
    assert.ok(panel, 'supervisor-status panel must exist');

    if (refreshBtn._listeners.click) {
      await refreshBtn._listeners.click();
    }
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(supervisorFetchCount, 1, 'should request /api/supervisor-status exactly once');
    assert.strictEqual(panel._attrs['data-status'] || panel.dataset.status, 'partial');
    assert.strictEqual(stateEl.textContent, 'not_configured');
    assert.match(installedEl.textContent, /未配置|false/);
    assert.match(managedEl.textContent, /未配置|false/);
    assert.match(launchdEl.textContent, /未配置|false/);
    assert.match(safetyEl.textContent, /launchctl:false/);
    assert.match(safetyEl.textContent, /metadata:false/);
    assert.match(safetyEl.textContent, /remote:false/);
    assert.ok(messageEl.textContent.includes('成功'));

    const panelText = panel.textContent || '';
    assert.doesNotMatch(panelText + safetyEl.textContent, /Bearer|leaked-token|private\/supervisor|\/Users\/ah/);
  });

  it('renders redacted error on non-2xx response from supervisor-status', async () => {
    const doc = buildMockDoc();
    const mockFetch = async (url) => {
      if (url.includes('/api/supervisor-status')) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: 'Bearer token failed at /Users/ah/private/supervisor' }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    const refreshBtn = doc.querySelector('[data-testid="supervisor-status-refresh"]');
    const panel = doc.querySelector('[data-testid="supervisor-status-panel"]');
    const messageEl = doc.querySelector('[data-testid="supervisor-status-message"]');
    const eventLogEl = doc.getElementById('event-log');

    if (refreshBtn._listeners.click) {
      await refreshBtn._listeners.click();
    }
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(panel._attrs['data-status'] || panel.dataset.status, 'error');
    assert.ok(messageEl.textContent.includes('[redacted]'));
    assert.doesNotMatch(messageEl.textContent, /Bearer|token|\/Users\/ah\/private/);
    assert.doesNotMatch(eventLogEl.textContent, /Bearer|token|\/Users\/ah\/private/);
  });

  it('does not start a second supervisor-status request while one is in flight', async () => {
    const doc = buildMockDoc();
    let supervisorFetchCount = 0;
    let resolveRequest;
    const requestPromise = new Promise((resolve) => {
      resolveRequest = resolve;
    });

    const mockFetch = async (url) => {
      if (url.includes('/api/supervisor-status')) {
        supervisorFetchCount++;
        await requestPromise;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'partial',
            supervisor: {
              installed: false,
              managed: false,
              launchdConfigured: false,
              watchdogConfigured: false,
              monitoringConfigured: false,
              recoveryConfigured: false,
              state: 'not_configured',
            },
            safety: {
              launchctlCalled: false,
              processListRead: false,
              supervisorInstalled: false,
              metadataWritten: false,
              nasConnected: false,
              backupTriggered: false,
              restoreTriggered: false,
              remoteCommandExecuted: false,
            }
          }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    const refreshBtn = doc.querySelector('[data-testid="supervisor-status-refresh"]');
    const firstClick = refreshBtn._listeners.click();
    await new Promise((r) => setTimeout(r, 10));
    const secondClick = refreshBtn._listeners.click();
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(supervisorFetchCount, 1, 'in-flight guard must block duplicate supervisor-status fetches');

    resolveRequest();
    await firstClick;
    await secondClick;
  });
});

describe('Audit log Web view model', () => {
  it('buildAuditLogViewModel handles unknown input', () => {
    const result = buildAuditLogViewModel(null);

    assert.strictEqual(result.statusKey, 'unknown');
    assert.strictEqual(result.statusText, '未检查');
    assert.strictEqual(result.eventCountText, '—');
    assert.strictEqual(result.latestTypeText, '—');
    assert.strictEqual(result.latestDeviceText, '—');
    assert.deepStrictEqual(result.events, []);
    assert.ok(result.messageText.includes('/api/audit-log'));
  });

  it('buildAuditLogViewModel formats empty audit payload', () => {
    const result = buildAuditLogViewModel({ events: [] });

    assert.strictEqual(result.statusKey, 'empty');
    assert.strictEqual(result.statusText, '无事件');
    assert.strictEqual(result.eventCountText, '0');
    assert.strictEqual(result.latestTypeText, '—');
    assert.strictEqual(result.latestDeviceText, '—');
    assert.deepStrictEqual(result.events, []);
    assert.ok(result.messageText.includes('无审计事件'));
  });

  it('buildAuditLogViewModel formats allowed fields and drops sensitive payload fields', () => {
    const result = buildAuditLogViewModel({
      events: [
        {
          id: 'evt-1',
          createdAt: '2026-07-06T12:00:00.000Z',
          type: 'api.heartbeat.success',
          method: 'POST',
          path: '/api/heartbeat',
          outcome: 'success',
          requestId: 'req-1',
          deviceId: 'audit-device',
          statusCode: 200,
          Authorization: 'Bearer leaked-token',
          sourcePath: '/private/tmp/source-secret',
          targetPath: '/private/tmp/target-secret',
          password: 'password-secret',
          token: 'token-secret',
        },
      ],
    });

    assert.strictEqual(result.statusKey, 'ready');
    assert.strictEqual(result.statusText, '已加载');
    assert.strictEqual(result.eventCountText, '1');
    assert.strictEqual(result.latestTypeText, 'api.heartbeat.success');
    assert.strictEqual(result.latestDeviceText, 'audit-device');
    assert.strictEqual(result.events[0].type, 'api.heartbeat.success');
    assert.ok(result.events[0].summaryText.includes('api.heartbeat.success'));
    assert.ok(result.events[0].summaryText.includes('audit-device'));

    const text = JSON.stringify(result);
    assert.doesNotMatch(text, /Bearer|leaked-token|source-secret|target-secret|password-secret|token-secret/);
  });

  it('buildAuditLogViewModel redacts sensitive error text', () => {
    const result = buildAuditLogViewModel(null, 'Bearer token failed at /Users/ah/private/audit');

    assert.strictEqual(result.statusKey, 'error');
    assert.strictEqual(result.statusText, '加载失败');
    assert.ok(result.messageText.includes('[redacted]'));
    assert.doesNotMatch(result.messageText, /Bearer|token|\/Users\/ah\/private/);
  });
});

describe('DOM test: audit-log panel interactions', () => {
  it('does not request /api/audit-log on initialization', async () => {
    const doc = buildMockDoc();
    let auditFetchCount = 0;
    const mockFetch = async (url) => {
      if (url.includes('/api/audit-log')) auditFetchCount++;
      return { ok: true, status: 200, json: async () => ({}) };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(auditFetchCount, 0, 'should not call /api/audit-log on init');
  });

  it('requests /api/audit-log only once and renders sanitized events when refresh button is clicked', async () => {
    const doc = buildMockDoc();
    let auditFetchCount = 0;
    const mockFetch = async (url) => {
      if (url.includes('/api/audit-log')) {
        auditFetchCount++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            events: [
              {
                id: 'evt-1',
                createdAt: '2026-07-06T12:00:00.000Z',
                type: 'api.heartbeat.success',
                method: 'POST',
                path: '/api/heartbeat',
                outcome: 'success',
                requestId: 'req-1',
                deviceId: 'audit-web-device',
                statusCode: 200,
                Authorization: 'Bearer leaked-token',
                sourcePath: '/private/tmp/source-secret',
              },
            ],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    const refreshBtn = doc.querySelector('[data-testid="audit-log-refresh"]');
    const panel = doc.querySelector('[data-testid="audit-log-panel"]');
    const countEl = doc.querySelector('[data-testid="audit-log-count"]');
    const latestTypeEl = doc.querySelector('[data-testid="audit-log-latest-type"]');
    const latestDeviceEl = doc.querySelector('[data-testid="audit-log-latest-device"]');
    const listEl = doc.querySelector('[data-testid="audit-log-list"]');
    const messageEl = doc.querySelector('[data-testid="audit-log-message"]');

    assert.ok(refreshBtn, 'audit-log refresh button must exist');
    assert.ok(panel, 'audit-log panel must exist');

    if (refreshBtn._listeners.click) {
      await refreshBtn._listeners.click();
    }
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(auditFetchCount, 1, 'should request /api/audit-log exactly once');
    assert.strictEqual(panel._attrs['data-status'] || panel.dataset.status, 'ready');
    assert.strictEqual(countEl.textContent, '1');
    assert.strictEqual(latestTypeEl.textContent, 'api.heartbeat.success');
    assert.strictEqual(latestDeviceEl.textContent, 'audit-web-device');
    assert.ok(listEl.textContent.includes('api.heartbeat.success'));
    assert.ok(messageEl.textContent.includes('成功'));
    assert.doesNotMatch(panel.textContent + listEl.textContent, /Bearer|leaked-token|source-secret|private\/tmp/);
  });

  it('renders redacted error on non-2xx response from audit-log', async () => {
    const doc = buildMockDoc();
    const mockFetch = async (url) => {
      if (url.includes('/api/audit-log')) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: 'Bearer token failed at /Users/ah/private/audit' }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    const refreshBtn = doc.querySelector('[data-testid="audit-log-refresh"]');
    const panel = doc.querySelector('[data-testid="audit-log-panel"]');
    const messageEl = doc.querySelector('[data-testid="audit-log-message"]');
    const eventLogEl = doc.getElementById('event-log');

    if (refreshBtn._listeners.click) {
      await refreshBtn._listeners.click();
    }
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(panel._attrs['data-status'] || panel.dataset.status, 'error');
    assert.ok(messageEl.textContent.includes('[redacted]'));
    assert.doesNotMatch(messageEl.textContent, /Bearer|token|\/Users\/ah\/private/);
    assert.doesNotMatch(eventLogEl.textContent, /Bearer|token|\/Users\/ah\/private/);
  });

  it('does not start a second audit-log request while one is in flight', async () => {
    const doc = buildMockDoc();
    let auditFetchCount = 0;
    let resolveRequest;
    const requestPromise = new Promise((resolve) => {
      resolveRequest = resolve;
    });

    const mockFetch = async (url) => {
      if (url.includes('/api/audit-log')) {
        auditFetchCount++;
        await requestPromise;
        return {
          ok: true,
          status: 200,
          json: async () => ({ events: [] }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, mockFetch, () => 0);
    await new Promise((r) => setTimeout(r, 30));

    const refreshBtn = doc.querySelector('[data-testid="audit-log-refresh"]');
    const firstClick = refreshBtn._listeners.click();
    await new Promise((r) => setTimeout(r, 10));
    const secondClick = refreshBtn._listeners.click();
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(auditFetchCount, 1, 'in-flight guard must block duplicate audit-log fetches');

    resolveRequest();
    await firstClick;
    await secondClick;
  });
});

describe('DOM test: supervisor-install-dry-run panel interactions', () => {
  it('does not request /api/supervisor-install-dry-run on initialization', async () => {
    let fetchCount = 0;
    const doc = buildMockDoc();
    const fetchImpl = async (url) => {
      if (String(url).includes('/api/supervisor-install-dry-run')) fetchCount++;
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, fetchImpl, () => {});

    assert.strictEqual(fetchCount, 0, 'should not call /api/supervisor-install-dry-run on init');
  });

  it('validates empty and invalid JSON locally without calling the API', async () => {
    const calls = [];
    const doc = buildMockDoc();
    initConsole(
      doc,
      async (url) => {
        calls.push(url);
        return { ok: true, status: 200, json: async () => [] };
      },
      () => {},
    );

    doc.getElementById('supervisor-install-dry-run-config').value = '   ';
    doc.getElementById('supervisor-install-dry-run-run')._listeners.click();
    assert.ok(!calls.some((url) => String(url).includes('/api/supervisor-install-dry-run')));
    assert.match(doc.getElementById('supervisor-install-dry-run-result').textContent, /不能为空/);

    doc.getElementById('supervisor-install-dry-run-config').value = '{ invalid json';
    doc.getElementById('supervisor-install-dry-run-run')._listeners.click();
    assert.ok(!calls.some((url) => String(url).includes('/api/supervisor-install-dry-run')));
    assert.match(doc.getElementById('supervisor-install-dry-run-result').textContent, /JSON 格式错误/);
  });

  it('requests supervisor install dry-run once and renders sanitized blocked plan fields', async () => {
    const calls = [];
    const doc = buildMockDoc();
    initConsole(
      doc,
      async (url, options) => {
        calls.push({ url, options });
        if (String(url).includes('/api/supervisor-install-dry-run')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              status: 'partial',
              command: 'supervisor-install-dry-run',
              supervisor: { state: 'not_configured', wouldInstall: false, wouldStart: false },
              readinessSummary: { state: 'blocked', blockers: ['real-install-not-implemented'] },
              installCommandPreview: {
                state: 'blocked',
                actions: [{ id: 'write-launch-agent-plist', command: 'launchctl bootstrap secret', wouldRun: false, wouldWrite: false }],
              },
              installPreflight: {
                state: 'blocked',
                checks: [{ id: 'operator-approval', status: 'blocked', blockerCode: 'operator-approval-required' }],
              },
              installApprovalManifest: {
                state: 'blocked',
                approval: { approved: false },
                rollback: { available: false },
                controls: [{ id: 'explicit-operator-approval', status: 'blocked', blockerCode: 'operator-approval-required' }],
              },
              rollbackUninstallPlan: {
                state: 'blocked',
                rollback: { available: false, evidence: 'restore /Users/ah/Library/LaunchAgents/com.linke.agent.plist' },
                uninstall: { available: false, evidence: 'launchctl bootout secret' },
                recovery: { available: false, evidence: 'recovery hostname secret-host pid 42' },
                actions: [
                  {
                    id: 'capture-current-state',
                    kind: 'rollback',
                    status: 'blocked',
                    command: 'launchctl print secret',
                    evidence: 'private /Users/ah/state.json',
                    wouldRun: false,
                    wouldWrite: false,
                    blockerCode: 'rollback-state-capture-missing',
                  },
                  {
                    id: 'unload-launch-agent',
                    kind: 'uninstall',
                    status: 'blocked',
                    command: 'launchctl bootout secret',
                    evidence: 'operator Aaron timestamp',
                    wouldRun: false,
                    wouldWrite: false,
                    blockerCode: 'launchd-unload-blocked',
                  },
                ],
                safety: {
                  dryRun: true,
                  planOnly: true,
                  rollbackExecuted: false,
                  uninstallExecuted: false,
                  recoverySupervisorStarted: false,
                  launchctlCalled: false,
                  processListRead: false,
                  filesystemWritten: false,
                  metadataWritten: false,
                  supervisorInstalled: false,
                  supervisorStarted: false,
                  launchdFileWritten: false,
                  launchdFileRemoved: false,
                  previousPlistRestored: false,
                  nasConnected: false,
                  backupTriggered: false,
                  restoreTriggered: false,
                  remoteCommandExecuted: false,
                  sensitiveValuesReturned: false,
                },
              },
              safety: {
                launchctlCalled: false,
                processListRead: false,
                launchdFileWritten: false,
                metadataWritten: false,
                nasConnected: false,
                backupTriggered: false,
                restoreTriggered: false,
                remoteCommandExecuted: false,
              },
            }),
          };
        }
        return { ok: true, status: 200, json: async () => [] };
      },
      () => {},
    );

    doc.getElementById('supervisor-install-dry-run-config').value = JSON.stringify({
      serverUrl: 'http://secret.localhost:3000',
      deviceId: 'web-supervisor-dry-run',
      backupJobs: [{ name: 'documents', sourcePath: '/tmp/linke-documents' }],
      nasTargets: [{ name: 'synology-web', provider: 'synology', endpoint: 'http://192.168.1.100:5000', shareName: 'backup', remotePath: '/volume1/backup', credentialRef: 'nas-ref' }],
    });
    doc.getElementById('supervisor-install-dry-run-run')._listeners.click();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const apiCall = calls.find((call) => String(call.url).includes('/api/supervisor-install-dry-run'));
    assert.ok(apiCall, 'must call supervisor install dry-run API');
    assert.strictEqual(apiCall.options.method, 'POST');
    assert.strictEqual(doc.getElementById('supervisor-install-dry-run-status').textContent, '部分就绪');
    assert.strictEqual(doc.getElementById('supervisor-install-dry-run-install-state').textContent, 'not_configured / wouldInstall:false / wouldStart:false');
    assert.strictEqual(doc.getElementById('supervisor-install-dry-run-approval-state').textContent, 'approved:false');
    assert.strictEqual(doc.getElementById('supervisor-install-dry-run-rollback-state').textContent, 'rollback:false / uninstall:false / recovery:false');

    const resultText = doc.getElementById('supervisor-install-dry-run-result').textContent;
    assert.match(resultText, /real-install-not-implemented/);
    assert.match(resultText, /write-launch-agent-plist/);
    assert.match(resultText, /wouldRun:false/);
    assert.match(resultText, /operator-approval-required/);
    assert.match(resultText, /Rollback \/ uninstall plan/);
    assert.match(resultText, /capture-current-state/);
    assert.match(resultText, /unload-launch-agent/);
    assert.match(resultText, /wouldWrite:false/);
    assert.match(resultText, /rollback-state-capture-missing/);
    assert.match(resultText, /rollbackExecuted:false/);
    assert.match(resultText, /uninstallExecuted:false/);
    assert.match(resultText, /recoverySupervisorStarted:false/);
    assert.match(resultText, /previousPlistRestored:false/);
    assert.match(resultText, /launchctlCalled:false/);
    assert.ok(!resultText.includes('secret.localhost'), 'must not render serverUrl');
    assert.ok(!resultText.includes('/tmp/linke-documents'), 'must not render sourcePath');
    assert.ok(!resultText.includes('192.168.1.100'), 'must not render NAS endpoint');
    assert.ok(!resultText.includes('nas-ref'), 'must not render credentialRef');
    assert.ok(!resultText.includes('launchctl bootstrap secret'), 'must not render runnable command');
    assert.ok(!resultText.includes('launchctl bootout secret'), 'must not render runnable rollback command');
    assert.ok(!resultText.includes('private /Users/ah/state.json'), 'must not render lifecycle evidence paths');
    assert.ok(!resultText.includes('secret-host'), 'must not render hostnames from lifecycle evidence');
    assert.ok(!resultText.includes('operator Aaron timestamp'), 'must not render approval identity or timestamp evidence');
  });

  it('does not start a second supervisor install dry-run request while one is in flight', async () => {
    let fetchCount = 0;
    let resolveRequest;
    const doc = buildMockDoc();
    initConsole(
      doc,
      async (url) => {
        if (String(url).includes('/api/supervisor-install-dry-run')) {
          fetchCount++;
          await new Promise((resolve) => { resolveRequest = resolve; });
          return {
            ok: true,
            status: 200,
            json: async () => ({
              status: 'partial',
              supervisor: { state: 'not_configured', wouldInstall: false, wouldStart: false },
              readinessSummary: { state: 'blocked', blockers: [] },
              installCommandPreview: { state: 'blocked', actions: [] },
              installPreflight: { state: 'blocked', checks: [] },
              installApprovalManifest: { state: 'blocked', approval: { approved: false }, rollback: { available: false }, controls: [] },
              safety: {},
            }),
          };
        }
        return { ok: true, status: 200, json: async () => [] };
      },
      () => {},
    );

    doc.getElementById('supervisor-install-dry-run-config').value = JSON.stringify({
      serverUrl: 'http://localhost:3000',
      deviceId: 'web-supervisor-dry-run',
      backupJobs: [{ name: 'documents', sourcePath: '/tmp/source' }],
    });
    const runBtn = doc.getElementById('supervisor-install-dry-run-run');
    runBtn._listeners.click();
    runBtn._listeners.click();
    assert.strictEqual(fetchCount, 1, 'in-flight guard must block duplicate requests');

    resolveRequest();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  it('renders sanitized error on non-2xx supervisor install dry-run response', async () => {
    const doc = buildMockDoc();
    initConsole(
      doc,
      async (url) => {
        if (String(url).includes('/api/supervisor-install-dry-run')) {
          return { ok: false, status: 400, json: async () => ({ error: 'serverUrl secret-value invalid' }) };
        }
        return { ok: true, status: 200, json: async () => [] };
      },
      () => {},
    );

    doc.getElementById('supervisor-install-dry-run-config').value = JSON.stringify({
      serverUrl: 'http://localhost:3000',
      deviceId: 'web-supervisor-dry-run',
      backupJobs: [{ name: 'documents', sourcePath: '/tmp/source' }],
    });
    doc.getElementById('supervisor-install-dry-run-run')._listeners.click();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const text = doc.getElementById('supervisor-install-dry-run-result').textContent;
    assert.match(text, /检查失败|加载失败|失败/);
    assert.ok(!text.includes('secret-value'), 'must redact secret-like error detail');
  });
});

describe('DOM test: supervisor lifecycle approval persistence preview panel interactions', () => {
  it('does not request /api/supervisor-lifecycle-approval-persistence-preview on initialization', async () => {
    let fetchCount = 0;
    const doc = buildMockDoc();
    const fetchImpl = async (url) => {
      if (String(url).includes('/api/supervisor-lifecycle-approval-persistence-preview')) fetchCount++;
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, fetchImpl, () => {});

    assert.strictEqual(fetchCount, 0, 'should not call approval persistence preview API on init');
  });

  it('does not request /api/supervisor-lifecycle-approval-persist on initialization', async () => {
    let fetchCount = 0;
    const doc = buildMockDoc();
    const fetchImpl = async (url) => {
      if (String(url) === '/api/supervisor-lifecycle-approval-persist') fetchCount++;
      return { ok: true, status: 200, json: async () => [] };
    };

    initConsole(doc, fetchImpl, () => {});

    assert.strictEqual(fetchCount, 0, 'should not call approval persist API on init');
  });

  it('validates empty and invalid config or approval JSON locally without calling the API', async () => {
    const calls = [];
    const doc = buildMockDoc();
    initConsole(
      doc,
      async (url) => {
        calls.push(url);
        return { ok: true, status: 200, json: async () => [] };
      },
      () => {},
    );

    doc.getElementById('supervisor-lifecycle-approval-preview-config').value = '   ';
    doc.getElementById('supervisor-lifecycle-approval-preview-run')._listeners.click();
    assert.ok(!calls.some((url) => String(url).includes('/api/supervisor-lifecycle-approval-persistence-preview')));
    assert.match(doc.getElementById('supervisor-lifecycle-approval-preview-result').textContent, /配置 JSON 不能为空/);

    doc.getElementById('supervisor-lifecycle-approval-preview-config').value = '{ invalid json';
    doc.getElementById('supervisor-lifecycle-approval-preview-run')._listeners.click();
    assert.ok(!calls.some((url) => String(url).includes('/api/supervisor-lifecycle-approval-persistence-preview')));
    assert.match(doc.getElementById('supervisor-lifecycle-approval-preview-result').textContent, /配置 JSON 格式错误/);

    doc.getElementById('supervisor-lifecycle-approval-preview-config').value = JSON.stringify({
      serverUrl: 'http://localhost:3000',
      deviceId: 'web-lifecycle-approval-preview',
      backupJobs: [{ name: 'documents', sourcePath: '/tmp/source' }],
    });
    doc.getElementById('supervisor-lifecycle-approval-preview-approval').value = '{ invalid approval';
    doc.getElementById('supervisor-lifecycle-approval-preview-run')._listeners.click();
    assert.ok(!calls.some((url) => String(url).includes('/api/supervisor-lifecycle-approval-persistence-preview')));
    assert.match(doc.getElementById('supervisor-lifecycle-approval-preview-result').textContent, /批准 JSON 格式错误/);
  });

  it('requests approval persistence preview once and renders sanitized blocked preview fields', async () => {
    const calls = [];
    const doc = buildMockDoc();
    initConsole(
      doc,
      async (url, options) => {
        calls.push({ url, options });
        if (String(url).includes('/api/supervisor-lifecycle-approval-persistence-preview')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              command: 'supervisor-lifecycle-approval-persistence-preview',
              operation: 'install',
              state: 'blocked',
              approvalValid: true,
              blockers: ['approval-persistence-store-missing'],
              persistence: {
                previewOnly: true,
                wouldPersist: false,
                recordSchemaVersion: 1,
                requiredRecordFields: ['schemaVersion', 'approvedBy', 'configHash', 'planHash'],
                validation: {
                  approvalValid: true,
                  acknowledgementCount: 1,
                  windowWithinLimit: true,
                  operationMatchesPlan: true,
                  configHashMatchesPlan: true,
                  planHashMatchesPlan: true,
                  approvedBy: 'operator@example.invalid',
                  configHash: 'sha256:secret',
                },
              },
              safety: {
                dryRun: true,
                hostMutation: false,
                filesystemWritten: false,
                metadataWritten: false,
                auditEventWritten: false,
                approvalPersisted: false,
                sensitiveValuesReturned: false,
              },
              approvedBy: 'operator@example.invalid',
              reason: 'secret reason',
              sourcePath: '/Users/ah/Documents',
            }),
          };
        }
        return { ok: true, status: 200, json: async () => [] };
      },
      () => {},
    );

    doc.getElementById('supervisor-lifecycle-approval-preview-operation').value = 'install';
    doc.getElementById('supervisor-lifecycle-approval-preview-config').value = JSON.stringify({
      serverUrl: 'http://secret.localhost:3000',
      deviceId: 'web-lifecycle-approval-preview',
      backupJobs: [{ name: 'documents', sourcePath: '/tmp/linke-documents' }],
    });
    doc.getElementById('supervisor-lifecycle-approval-preview-approval').value = JSON.stringify({
      approvedBy: 'operator@example.invalid',
      reason: 'secret reason',
      acknowledgements: ['do not leak'],
    });
    doc.getElementById('supervisor-lifecycle-approval-preview-run')._listeners.click();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const apiCall = calls.find((call) => String(call.url).includes('/api/supervisor-lifecycle-approval-persistence-preview'));
    assert.ok(apiCall, 'must call approval persistence preview API');
    assert.strictEqual(apiCall.options.method, 'POST');
    const requestBody = JSON.parse(apiCall.options.body);
    assert.strictEqual(requestBody.operation, 'install');
    assert.strictEqual(requestBody.config.deviceId, 'web-lifecycle-approval-preview');
    assert.strictEqual(requestBody.approval.approvedBy, 'operator@example.invalid');
    assert.strictEqual(doc.getElementById('supervisor-lifecycle-approval-preview-status').textContent, '阻塞');
    assert.strictEqual(doc.getElementById('supervisor-lifecycle-approval-preview-valid').textContent, 'true');
    assert.strictEqual(doc.getElementById('supervisor-lifecycle-approval-preview-persist').textContent, 'previewOnly:true / wouldPersist:false');

    const resultText = doc.getElementById('supervisor-lifecycle-approval-preview-result').textContent;
    assert.match(resultText, /approval-persistence-store-missing/);
    assert.match(resultText, /acknowledgementCount:1/);
    assert.match(resultText, /approvalPersisted:false/);
    assert.match(resultText, /filesystemWritten:false/);
    assert.ok(!resultText.includes('operator@example'), 'must not render approval identity value');
    assert.ok(!resultText.includes('secret reason'), 'must not render approval reason');
    assert.ok(!resultText.includes('sha256:secret'), 'must not render hash values');
    assert.ok(!resultText.includes('/Users/ah/Documents'), 'must not render paths');
    assert.ok(!resultText.includes('secret.localhost'), 'must not render config serverUrl');
    assert.ok(!resultText.includes('/tmp/linke-documents'), 'must not render config sourcePath');
  });

  it('does not start a second approval persistence preview request while one is in flight', async () => {
    let fetchCount = 0;
    let resolveRequest;
    const doc = buildMockDoc();
    initConsole(
      doc,
      async (url) => {
        if (String(url).includes('/api/supervisor-lifecycle-approval-persistence-preview')) {
          fetchCount++;
          await new Promise((resolve) => { resolveRequest = resolve; });
          return {
            ok: true,
            status: 200,
            json: async () => ({
              state: 'blocked',
              approvalValid: false,
              blockers: ['approval-missing-required-fields'],
              persistence: { previewOnly: true, wouldPersist: false, requiredRecordFields: [], validation: {} },
              safety: { approvalPersisted: false },
            }),
          };
        }
        return { ok: true, status: 200, json: async () => [] };
      },
      () => {},
    );

    doc.getElementById('supervisor-lifecycle-approval-preview-config').value = JSON.stringify({
      serverUrl: 'http://localhost:3000',
      deviceId: 'web-lifecycle-approval-preview',
      backupJobs: [{ name: 'documents', sourcePath: '/tmp/source' }],
    });
    const runBtn = doc.getElementById('supervisor-lifecycle-approval-preview-run');
    runBtn._listeners.click();
    runBtn._listeners.click();
    assert.strictEqual(fetchCount, 1, 'in-flight guard must block duplicate requests');

    resolveRequest();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  it('renders sanitized error on non-2xx approval persistence preview response', async () => {
    const doc = buildMockDoc();
    initConsole(
      doc,
      async (url) => {
        if (String(url).includes('/api/supervisor-lifecycle-approval-persistence-preview')) {
          return { ok: false, status: 400, json: async () => ({ error: 'approval token secret-value invalid' }) };
        }
        return { ok: true, status: 200, json: async () => [] };
      },
      () => {},
    );

    doc.getElementById('supervisor-lifecycle-approval-preview-config').value = JSON.stringify({
      serverUrl: 'http://localhost:3000',
      deviceId: 'web-lifecycle-approval-preview',
      backupJobs: [{ name: 'documents', sourcePath: '/tmp/source' }],
    });
    doc.getElementById('supervisor-lifecycle-approval-preview-run')._listeners.click();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const text = doc.getElementById('supervisor-lifecycle-approval-preview-result').textContent;
    assert.match(text, /检查失败|加载失败|失败/);
    assert.ok(!text.includes('secret-value'), 'must redact secret-like error detail');
  });

  it('requires approval JSON before manually persisting an approval record', async () => {
    const calls = [];
    const doc = buildMockDoc();
    initConsole(
      doc,
      async (url) => {
        calls.push(url);
        return { ok: true, status: 200, json: async () => [] };
      },
      () => {},
    );

    doc.getElementById('supervisor-lifecycle-approval-preview-config').value = JSON.stringify({
      serverUrl: 'http://localhost:3000',
      deviceId: 'web-lifecycle-approval-persist',
      backupJobs: [{ name: 'documents', sourcePath: '/tmp/source' }],
    });
    doc.getElementById('supervisor-lifecycle-approval-preview-approval').value = '';
    doc.getElementById('supervisor-lifecycle-approval-persist-button')._listeners.click();

    assert.ok(!calls.some((url) => String(url) === '/api/supervisor-lifecycle-approval-persist'));
    assert.match(doc.getElementById('supervisor-lifecycle-approval-preview-result').textContent, /批准 JSON 不能为空/);
  });

  it('manually persists approval record once and renders sanitized 201 response', async () => {
    const calls = [];
    const doc = buildMockDoc();
    initConsole(
      doc,
      async (url, options) => {
        calls.push({ url, options });
        if (String(url) === '/api/supervisor-lifecycle-approval-persist') {
          return {
            ok: true,
            status: 201,
            json: async () => ({
              command: 'supervisor-lifecycle-approval-record',
              operation: 'install',
              state: 'persisted',
              approvalValid: true,
              blockersResolved: ['approval-persistence-store-missing'],
              validation: {
                approvalValid: true,
                acknowledgementCount: 1,
                windowWithinLimit: true,
                operationMatchesPlan: true,
                configHashMatchesPlan: true,
                planHashMatchesPlan: true,
                approvedBy: 'operator@example.invalid',
                configHash: 'sha256:secret',
              },
              safety: {
                approvalPersisted: true,
                filesystemWritten: true,
                hostMutation: false,
                launchctlCalled: false,
                lifecycleApplied: false,
                sensitiveValuesReturned: false,
              },
              approvedBy: 'operator@example.invalid',
              reason: 'secret reason',
              sourcePath: '/Users/ah/Documents',
            }),
          };
        }
        return { ok: true, status: 200, json: async () => [] };
      },
      () => {},
    );

    doc.getElementById('supervisor-lifecycle-approval-preview-operation').value = 'install';
    doc.getElementById('supervisor-lifecycle-approval-preview-config').value = JSON.stringify({
      serverUrl: 'http://secret.localhost:3000',
      deviceId: 'web-lifecycle-approval-persist',
      backupJobs: [{ name: 'documents', sourcePath: '/tmp/linke-documents' }],
    });
    doc.getElementById('supervisor-lifecycle-approval-preview-approval').value = JSON.stringify({
      approvedBy: 'operator@example.invalid',
      reason: 'secret reason',
      acknowledgements: ['do not leak'],
    });
    doc.getElementById('supervisor-lifecycle-approval-persist-button')._listeners.click();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const apiCall = calls.find((call) => String(call.url) === '/api/supervisor-lifecycle-approval-persist');
    assert.ok(apiCall, 'must call approval persist API');
    assert.strictEqual(apiCall.options.method, 'POST');
    const requestBody = JSON.parse(apiCall.options.body);
    assert.strictEqual(requestBody.operation, 'install');
    assert.strictEqual(requestBody.config.deviceId, 'web-lifecycle-approval-persist');
    assert.strictEqual(requestBody.approval.approvedBy, 'operator@example.invalid');
    assert.strictEqual(doc.getElementById('supervisor-lifecycle-approval-preview-status').textContent, '已记录');
    assert.strictEqual(doc.getElementById('supervisor-lifecycle-approval-preview-valid').textContent, 'true');
    assert.strictEqual(doc.getElementById('supervisor-lifecycle-approval-preview-persist').textContent, 'approvalRecord:persisted / lifecycleApply:false');

    const resultText = doc.getElementById('supervisor-lifecycle-approval-preview-result').textContent;
    assert.match(resultText, /Persisted approval record for install/);
    assert.match(resultText, /not lifecycle apply/i);
    assert.match(resultText, /approvalPersisted:true/);
    assert.match(resultText, /lifecycleApplied:false/);
    assert.ok(!resultText.includes('operator@example'), 'must not render approval identity value');
    assert.ok(!resultText.includes('secret reason'), 'must not render approval reason');
    assert.ok(!resultText.includes('sha256:secret'), 'must not render hash values');
    assert.ok(!resultText.includes('/Users/ah/Documents'), 'must not render paths');
    assert.ok(!resultText.includes('secret.localhost'), 'must not render config serverUrl');
    assert.ok(!resultText.includes('/tmp/linke-documents'), 'must not render config sourcePath');
  });

  it('does not start a second approval persist request while one is in flight', async () => {
    let fetchCount = 0;
    let resolveRequest;
    const doc = buildMockDoc();
    initConsole(
      doc,
      async (url) => {
        if (String(url) === '/api/supervisor-lifecycle-approval-persist') {
          fetchCount++;
          await new Promise((resolve) => { resolveRequest = resolve; });
          return {
            ok: true,
            status: 201,
            json: async () => ({
              command: 'supervisor-lifecycle-approval-record',
              operation: 'install',
              state: 'persisted',
              approvalValid: true,
              blockersResolved: ['approval-persistence-store-missing'],
              validation: {},
              safety: { approvalPersisted: true, lifecycleApplied: false },
            }),
          };
        }
        return { ok: true, status: 200, json: async () => [] };
      },
      () => {},
    );

    doc.getElementById('supervisor-lifecycle-approval-preview-config').value = JSON.stringify({
      serverUrl: 'http://localhost:3000',
      deviceId: 'web-lifecycle-approval-persist',
      backupJobs: [{ name: 'documents', sourcePath: '/tmp/source' }],
    });
    doc.getElementById('supervisor-lifecycle-approval-preview-approval').value = JSON.stringify({ approved: true });
    const persistBtn = doc.getElementById('supervisor-lifecycle-approval-persist-button');
    persistBtn._listeners.click();
    persistBtn._listeners.click();
    assert.strictEqual(fetchCount, 1, 'in-flight guard must block duplicate persist requests');

    resolveRequest();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  it('renders 409 approval persist blockers without treating them as thrown errors', async () => {
    const doc = buildMockDoc();
    initConsole(
      doc,
      async (url) => {
        if (String(url) === '/api/supervisor-lifecycle-approval-persist') {
          return {
            ok: false,
            status: 409,
            json: async () => ({
              command: 'supervisor-lifecycle-approval-persistence-preview',
              operation: 'rollback',
              state: 'blocked',
              approvalValid: false,
              blockers: ['approval-operation-mismatch'],
              persistence: {
                previewOnly: true,
                wouldPersist: false,
                requiredRecordFields: ['approvedBy'],
                validation: { approvalValid: false, acknowledgementCount: 1 },
              },
              safety: { approvalPersisted: false, lifecycleApplied: false },
            }),
          };
        }
        return { ok: true, status: 200, json: async () => [] };
      },
      () => {},
    );

    doc.getElementById('supervisor-lifecycle-approval-preview-operation').value = 'rollback';
    doc.getElementById('supervisor-lifecycle-approval-preview-config').value = JSON.stringify({
      serverUrl: 'http://localhost:3000',
      deviceId: 'web-lifecycle-approval-persist',
      backupJobs: [{ name: 'documents', sourcePath: '/tmp/source' }],
    });
    doc.getElementById('supervisor-lifecycle-approval-preview-approval').value = JSON.stringify({ approved: true });
    doc.getElementById('supervisor-lifecycle-approval-persist-button')._listeners.click();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const resultText = doc.getElementById('supervisor-lifecycle-approval-preview-result').textContent;
    assert.strictEqual(doc.getElementById('supervisor-lifecycle-approval-preview-status').textContent, '阻塞');
    assert.match(resultText, /approval-operation-mismatch/);
    assert.match(resultText, /previewOnly:true|approvalValid:false/);
  });

  it('renders sanitized error on non-409 approval persist failure', async () => {
    const doc = buildMockDoc();
    initConsole(
      doc,
      async (url) => {
        if (String(url) === '/api/supervisor-lifecycle-approval-persist') {
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: 'Bearer token secret-value failed at /Users/ah/private/approval' }),
          };
        }
        return { ok: true, status: 200, json: async () => [] };
      },
      () => {},
    );

    doc.getElementById('supervisor-lifecycle-approval-preview-config').value = JSON.stringify({
      serverUrl: 'http://localhost:3000',
      deviceId: 'web-lifecycle-approval-persist',
      backupJobs: [{ name: 'documents', sourcePath: '/tmp/source' }],
    });
    doc.getElementById('supervisor-lifecycle-approval-preview-approval').value = JSON.stringify({ approved: true });
    doc.getElementById('supervisor-lifecycle-approval-persist-button')._listeners.click();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const text = doc.getElementById('supervisor-lifecycle-approval-preview-result').textContent;
    assert.match(text, /检查失败|失败/);
    assert.ok(!text.includes('secret-value'), 'must redact secret-like error detail');
    assert.ok(!text.includes('/Users/ah/private'), 'must redact local path detail');
  });
});
