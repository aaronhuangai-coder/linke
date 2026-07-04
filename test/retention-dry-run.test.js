import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createServer } from '../src/server.js';
import { buildRetentionDryRunPlan } from '../src/retention.js';

// ── Helper: sha256 of a file ────────────────────────────────────────

async function fileSha256(filePath) {
  const content = await readFile(filePath, 'utf-8');
  return createHash('sha256').update(content).digest('hex');
}

// ── Pure function: buildRetentionDryRunPlan ─────────────────────────

describe('buildRetentionDryRunPlan — pure function', () => {
  const deviceId = 'test-device';

  const snapshots = [
    { snapshotId: 's1', createdAt: '2025-01-01T00:00:00.000Z', sourcePath: '/a', fileCount: 3 },
    { snapshotId: 's2', createdAt: '2025-02-01T00:00:00.000Z', sourcePath: '/b', fileCount: 5 },
    { snapshotId: 's3', createdAt: '2025-03-01T00:00:00.000Z', sourcePath: '/c', fileCount: 2 },
    { snapshotId: 's4', createdAt: '2025-04-01T00:00:00.000Z', sourcePath: '/d', fileCount: 7 },
    { snapshotId: 's5', createdAt: '2025-05-01T00:00:00.000Z', sourcePath: '/e', fileCount: 1 },
  ];

  it('returns mode=dry-run with correct structure', () => {
    const plan = buildRetentionDryRunPlan(deviceId, snapshots);
    assert.strictEqual(plan.mode, 'dry-run');
    assert.strictEqual(plan.deviceId, deviceId);
    assert.strictEqual(plan.wouldWrite, false);
    assert.ok(plan.policy);
    assert.strictEqual(plan.policy.type, 'keep-last');
    assert.strictEqual(plan.policy.sortBy, 'createdAt desc');
    assert.ok(Array.isArray(plan.snapshots));
  });

  it('defaults keepLast=3, keeps 3 newest, marks rest as would-delete', () => {
    const plan = buildRetentionDryRunPlan(deviceId, snapshots);
    assert.strictEqual(plan.policy.keepLast, 3);
    assert.strictEqual(plan.totalSnapshots, 5);
    assert.strictEqual(plan.keepCount, 3);
    assert.strictEqual(plan.wouldDeleteCount, 2);

    const kept = plan.snapshots.filter((s) => s.action === 'keep');
    const deleted = plan.snapshots.filter((s) => s.action === 'would-delete');
    assert.strictEqual(kept.length, 3);
    assert.strictEqual(deleted.length, 2);

    // Kept should be the 3 newest: s5, s4, s3
    assert.strictEqual(kept[0].snapshotId, 's5');
    assert.strictEqual(kept[1].snapshotId, 's4');
    assert.strictEqual(kept[2].snapshotId, 's3');

    // Deleted should be the 2 oldest: s2, s1
    assert.strictEqual(deleted[0].snapshotId, 's2');
    assert.strictEqual(deleted[1].snapshotId, 's1');
  });

  it('each snapshot has action and reason fields', () => {
    const plan = buildRetentionDryRunPlan(deviceId, snapshots);
    for (const s of plan.snapshots) {
      assert.ok(['keep', 'would-delete'].includes(s.action), `action must be keep or would-delete: ${s.snapshotId}`);
      assert.ok(['within-keep-last', 'older-than-keep-last'].includes(s.reason), `reason must be valid: ${s.snapshotId}`);
    }
    // Kept ones have reason=within-keep-last
    const kept = plan.snapshots.filter((s) => s.action === 'keep');
    for (const s of kept) {
      assert.strictEqual(s.reason, 'within-keep-last');
    }
    // Deleted ones have reason=older-than-keep-last
    const deleted = plan.snapshots.filter((s) => s.action === 'would-delete');
    for (const s of deleted) {
      assert.strictEqual(s.reason, 'older-than-keep-last');
    }
  });

  it('preserves snapshot metadata (snapshotId, createdAt, jobName, sourcePath, fileCount)', () => {
    const snaps = [
      { snapshotId: 'x1', createdAt: '2025-06-01T00:00:00.000Z', jobName: 'daily', sourcePath: '/src', fileCount: 10 },
    ];
    const plan = buildRetentionDryRunPlan(deviceId, snaps);
    const s = plan.snapshots[0];
    assert.strictEqual(s.snapshotId, 'x1');
    assert.strictEqual(s.createdAt, '2025-06-01T00:00:00.000Z');
    assert.strictEqual(s.jobName, 'daily');
    assert.strictEqual(s.sourcePath, '/src');
    assert.strictEqual(s.fileCount, 10);
  });

  it('sorts by createdAt descending (newest first)', () => {
    const plan = buildRetentionDryRunPlan(deviceId, snapshots);
    const dates = plan.snapshots.map((s) => s.createdAt);
    for (let i = 1; i < dates.length; i++) {
      assert.ok(dates[i] <= dates[i - 1], `must be descending: ${dates[i - 1]} >= ${dates[i]}`);
    }
  });

  it('stable order for same createdAt (preserves original order)', () => {
    const sameTime = [
      { snapshotId: 'a', createdAt: '2025-01-01T00:00:00.000Z' },
      { snapshotId: 'b', createdAt: '2025-01-01T00:00:00.000Z' },
      { snapshotId: 'c', createdAt: '2025-01-01T00:00:00.000Z' },
      { snapshotId: 'd', createdAt: '2025-01-01T00:00:00.000Z' },
    ];
    const plan = buildRetentionDryRunPlan(deviceId, sameTime, { keepLast: 2 });
    // a, b should be kept (first in original order), c, d would-delete
    const kept = plan.snapshots.filter((s) => s.action === 'keep').map((s) => s.snapshotId);
    assert.deepStrictEqual(kept, ['a', 'b']);
    const deleted = plan.snapshots.filter((s) => s.action === 'would-delete').map((s) => s.snapshotId);
    assert.deepStrictEqual(deleted, ['c', 'd']);
  });

  it('all keep when totalSnapshots <= keepLast', () => {
    const few = [
      { snapshotId: 's1', createdAt: '2025-01-01T00:00:00.000Z' },
      { snapshotId: 's2', createdAt: '2025-02-01T00:00:00.000Z' },
    ];
    const plan = buildRetentionDryRunPlan(deviceId, few, { keepLast: 5 });
    assert.strictEqual(plan.totalSnapshots, 2);
    assert.strictEqual(plan.keepCount, 2);
    assert.strictEqual(plan.wouldDeleteCount, 0);
    for (const s of plan.snapshots) {
      assert.strictEqual(s.action, 'keep');
      assert.strictEqual(s.reason, 'within-keep-last');
    }
  });

  it('all keep when totalSnapshots === keepLast', () => {
    const exact = [
      { snapshotId: 's1', createdAt: '2025-01-01T00:00:00.000Z' },
      { snapshotId: 's2', createdAt: '2025-02-01T00:00:00.000Z' },
      { snapshotId: 's3', createdAt: '2025-03-01T00:00:00.000Z' },
    ];
    const plan = buildRetentionDryRunPlan(deviceId, exact, { keepLast: 3 });
    assert.strictEqual(plan.keepCount, 3);
    assert.strictEqual(plan.wouldDeleteCount, 0);
  });

  it('empty snapshots returns all zeros', () => {
    const plan = buildRetentionDryRunPlan(deviceId, []);
    assert.strictEqual(plan.totalSnapshots, 0);
    assert.strictEqual(plan.keepCount, 0);
    assert.strictEqual(plan.wouldDeleteCount, 0);
    assert.strictEqual(plan.snapshots.length, 0);
  });

  it('respects custom keepLast option', () => {
    const plan = buildRetentionDryRunPlan(deviceId, snapshots, { keepLast: 1 });
    assert.strictEqual(plan.policy.keepLast, 1);
    assert.strictEqual(plan.keepCount, 1);
    assert.strictEqual(plan.wouldDeleteCount, 4);
    assert.strictEqual(plan.snapshots[0].action, 'keep');
    assert.strictEqual(plan.snapshots[0].snapshotId, 's5');
  });

  // ── Invalid keepLast ──────────────────────────────────────────

  it('rejects keepLast=0', () => {
    assert.throws(
      () => buildRetentionDryRunPlan(deviceId, snapshots, { keepLast: 0 }),
      /keepLast|positive/i,
    );
  });

  it('rejects negative keepLast', () => {
    assert.throws(
      () => buildRetentionDryRunPlan(deviceId, snapshots, { keepLast: -1 }),
      /keepLast|positive/i,
    );
  });

  it('rejects decimal keepLast', () => {
    assert.throws(
      () => buildRetentionDryRunPlan(deviceId, snapshots, { keepLast: 1.5 }),
      /keepLast|integer|positive/i,
    );
  });

  it('rejects non-number keepLast (string)', () => {
    assert.throws(
      () => buildRetentionDryRunPlan(deviceId, snapshots, { keepLast: 'abc' }),
      /keepLast|positive|integer/i,
    );
  });

  it('rejects non-number keepLast (null)', () => {
    assert.throws(
      () => buildRetentionDryRunPlan(deviceId, snapshots, { keepLast: null }),
      /keepLast|positive|integer/i,
    );
  });

  it('rejects NaN keepLast', () => {
    assert.throws(
      () => buildRetentionDryRunPlan(deviceId, snapshots, { keepLast: NaN }),
      /keepLast|positive|integer/i,
    );
  });
});

// ── API: GET /api/devices/:deviceId/retention-dry-run ───────────────

describe('retention-dry-run API', () => {
  let server, dataDir, port;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'linke-retention-'));
    server = createServer({ dataDir });
    await new Promise((r) => server.listen(0, r));
    port = server.address().port;

    // Seed a device with snapshots via heartbeat + direct snapshots.json write
    await fetch(`http://localhost:${port}/api/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'ret-device', hostname: 'RetHost' }),
    });

    const deviceDir = join(dataDir, 'repo', 'devices', 'ret-device');
    const snapshotsPath = join(deviceDir, 'snapshots.json');
    const snaps = [
      { snapshotId: 'snap-1', createdAt: '2025-01-01T00:00:00.000Z', sourcePath: '/a', fileCount: 2 },
      { snapshotId: 'snap-2', createdAt: '2025-02-01T00:00:00.000Z', sourcePath: '/b', fileCount: 3 },
      { snapshotId: 'snap-3', createdAt: '2025-03-01T00:00:00.000Z', sourcePath: '/c', fileCount: 4 },
      { snapshotId: 'snap-4', createdAt: '2025-04-01T00:00:00.000Z', sourcePath: '/d', fileCount: 5 },
    ];
    await writeFile(snapshotsPath, JSON.stringify(snaps, null, 2), 'utf-8');
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    await rm(dataDir, { recursive: true, force: true });
  });

  it('returns 404 for non-existent device', async () => {
    const res = await fetch(`http://localhost:${port}/api/devices/no-such-device/retention-dry-run`);
    assert.strictEqual(res.status, 404);
  });

  it('returns 400 for invalid keepLast (0)', async () => {
    const res = await fetch(`http://localhost:${port}/api/devices/ret-device/retention-dry-run?keepLast=0`);
    assert.strictEqual(res.status, 400);
  });

  it('returns 400 for invalid keepLast (negative)', async () => {
    const res = await fetch(`http://localhost:${port}/api/devices/ret-device/retention-dry-run?keepLast=-1`);
    assert.strictEqual(res.status, 400);
  });

  it('returns 400 for invalid keepLast (non-numeric)', async () => {
    const res = await fetch(`http://localhost:${port}/api/devices/ret-device/retention-dry-run?keepLast=abc`);
    assert.strictEqual(res.status, 400);
  });

  it('returns 400 for decimal keepLast', async () => {
    const res = await fetch(`http://localhost:${port}/api/devices/ret-device/retention-dry-run?keepLast=1.5`);
    assert.strictEqual(res.status, 400);
  });

  it('returns dry-run plan with default keepLast=3', async () => {
    const res = await fetch(`http://localhost:${port}/api/devices/ret-device/retention-dry-run`);
    assert.strictEqual(res.status, 200);
    const plan = await res.json();
    assert.strictEqual(plan.mode, 'dry-run');
    assert.strictEqual(plan.deviceId, 'ret-device');
    assert.strictEqual(plan.wouldWrite, false);
    assert.strictEqual(plan.policy.keepLast, 3);
    assert.strictEqual(plan.totalSnapshots, 4);
    assert.strictEqual(plan.keepCount, 3);
    assert.strictEqual(plan.wouldDeleteCount, 1);
  });

  it('respects keepLast query parameter', async () => {
    const res = await fetch(`http://localhost:${port}/api/devices/ret-device/retention-dry-run?keepLast=1`);
    assert.strictEqual(res.status, 200);
    const plan = await res.json();
    assert.strictEqual(plan.policy.keepLast, 1);
    assert.strictEqual(plan.keepCount, 1);
    assert.strictEqual(plan.wouldDeleteCount, 3);
  });

  it('does NOT modify snapshots.json (sha256 unchanged before/after)', async () => {
    const deviceDir = join(dataDir, 'repo', 'devices', 'ret-device');
    const snapshotsPath = join(deviceDir, 'snapshots.json');
    const hashBefore = await fileSha256(snapshotsPath);

    await fetch(`http://localhost:${port}/api/devices/ret-device/retention-dry-run`);
    await fetch(`http://localhost:${port}/api/devices/ret-device/retention-dry-run?keepLast=1`);
    await fetch(`http://localhost:${port}/api/devices/ret-device/retention-dry-run?keepLast=10`);

    const hashAfter = await fileSha256(snapshotsPath);
    assert.strictEqual(hashAfter, hashBefore, 'snapshots.json must not be modified by dry-run');
  });
});

// ── CLI: retention-dry-run command ──────────────────────────────────

describe('retention-dry-run CLI', () => {
  let server, dataDir, port;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'linke-ret-cli-'));
    server = createServer({ dataDir });
    await new Promise((r) => server.listen(0, r));
    port = server.address().port;

    // Seed device + snapshots
    await fetch(`http://localhost:${port}/api/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'cli-device' }),
    });

    const deviceDir = join(dataDir, 'repo', 'devices', 'cli-device');
    await mkdir(join(deviceDir, 'snapshots'), { recursive: true });
    const snapshotsPath = join(deviceDir, 'snapshots.json');
    const snaps = [
      { snapshotId: 'c1', createdAt: '2025-01-01T00:00:00.000Z', sourcePath: '/x', fileCount: 1 },
      { snapshotId: 'c2', createdAt: '2025-02-01T00:00:00.000Z', sourcePath: '/y', fileCount: 2 },
      { snapshotId: 'c3', createdAt: '2025-03-01T00:00:00.000Z', sourcePath: '/z', fileCount: 3 },
    ];
    await writeFile(snapshotsPath, JSON.stringify(snaps, null, 2), 'utf-8');
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    await rm(dataDir, { recursive: true, force: true });
  });

  it('CLI outputs valid JSON with dry-run plan', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);

    const agentPath = join(import.meta.dirname, '..', 'src', 'agent.js');
    const { stdout } = await exec('node', [
      agentPath, 'retention-dry-run',
      '--server', `http://localhost:${port}`,
      '--device', 'cli-device',
      '--keep-last', '2',
    ]);

    const plan = JSON.parse(stdout);
    assert.strictEqual(plan.mode, 'dry-run');
    assert.strictEqual(plan.deviceId, 'cli-device');
    assert.strictEqual(plan.policy.keepLast, 2);
    assert.strictEqual(plan.totalSnapshots, 3);
    assert.strictEqual(plan.keepCount, 2);
    assert.strictEqual(plan.wouldDeleteCount, 1);
    assert.strictEqual(plan.wouldWrite, false);
  });

  it('CLI errors when --device is missing', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);

    const agentPath = join(import.meta.dirname, '..', 'src', 'agent.js');
    await assert.rejects(
      () => exec('node', [
        agentPath, 'retention-dry-run',
        '--server', `http://localhost:${port}`,
        '--keep-last', '3',
      ]),
      /device/i,
    );
  });

  it('CLI errors when --keep-last has no value (parsed as boolean true)', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);

    const agentPath = join(import.meta.dirname, '..', 'src', 'agent.js');
    await assert.rejects(
      () => exec('node', [
        agentPath, 'retention-dry-run',
        '--server', `http://localhost:${port}`,
        '--device', 'cli-device',
        '--keep-last',
      ]),
      (err) => {
        // Must exit non-zero (exec rejects on non-zero exit)
        assert.ok(err.code !== 0, 'exit code must be non-zero');
        // stderr must mention keep-last or positive integer
        const stderrLower = (err.stderr || '').toLowerCase();
        assert.ok(
          stderrLower.includes('keep-last') || stderrLower.includes('positive integer'),
          `stderr must mention keep-last or positive integer, got: ${err.stderr}`,
        );
        return true;
      },
    );
  });

  it('CLI errors when --keep-last value is not a number', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);

    const agentPath = join(import.meta.dirname, '..', 'src', 'agent.js');
    await assert.rejects(
      () => exec('node', [
        agentPath, 'retention-dry-run',
        '--server', `http://localhost:${port}`,
        '--device', 'cli-device',
        '--keep-last', 'abc',
      ]),
      (err) => {
        assert.ok(err.code !== 0, 'exit code must be non-zero');
        const stderrLower = (err.stderr || '').toLowerCase();
        assert.ok(
          stderrLower.includes('keep-last') || stderrLower.includes('positive integer'),
          `stderr must mention keep-last or positive integer, got: ${err.stderr}`,
        );
        return true;
      },
    );
  });

  it('CLI errors when --keep-last value is zero', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);

    const agentPath = join(import.meta.dirname, '..', 'src', 'agent.js');
    await assert.rejects(
      () => exec('node', [
        agentPath, 'retention-dry-run',
        '--server', `http://localhost:${port}`,
        '--device', 'cli-device',
        '--keep-last', '0',
      ]),
      (err) => {
        assert.ok(err.code !== 0, 'exit code must be non-zero');
        const stderrLower = (err.stderr || '').toLowerCase();
        assert.ok(
          stderrLower.includes('keep-last') || stderrLower.includes('positive integer'),
          `stderr must mention keep-last or positive integer, got: ${err.stderr}`,
        );
        return true;
      },
    );
  });

  it('CLI errors when --keep-last value is negative', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);

    const agentPath = join(import.meta.dirname, '..', 'src', 'agent.js');
    await assert.rejects(
      () => exec('node', [
        agentPath, 'retention-dry-run',
        '--server', `http://localhost:${port}`,
        '--device', 'cli-device',
        '--keep-last', '-5',
      ]),
      (err) => {
        assert.ok(err.code !== 0, 'exit code must be non-zero');
        const stderrLower = (err.stderr || '').toLowerCase();
        assert.ok(
          stderrLower.includes('keep-last') || stderrLower.includes('positive integer'),
          `stderr must mention keep-last or positive integer, got: ${err.stderr}`,
        );
        return true;
      },
    );
  });

  it('CLI errors when --keep-last value is decimal', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);

    const agentPath = join(import.meta.dirname, '..', 'src', 'agent.js');
    await assert.rejects(
      () => exec('node', [
        agentPath, 'retention-dry-run',
        '--server', `http://localhost:${port}`,
        '--device', 'cli-device',
        '--keep-last', '1.5',
      ]),
      (err) => {
        assert.ok(err.code !== 0, 'exit code must be non-zero');
        const stderrLower = (err.stderr || '').toLowerCase();
        assert.ok(
          stderrLower.includes('keep-last') || stderrLower.includes('positive integer'),
          `stderr must mention keep-last or positive integer, got: ${err.stderr}`,
        );
        return true;
      },
    );
  });
});
