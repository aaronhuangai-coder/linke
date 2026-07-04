import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { createServer } from '../src/server.js';
import { buildRestoreDryRunPlan } from '../src/restore-dry-run.js';
import { safeDevicePath } from '../src/storage.js';

const exec = promisify(execFile);

function postJSON(port, path, body) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function fileSha256(filePath) {
  return sha256(await readFile(filePath));
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function listRelativeFiles(dir, base = dir) {
  const result = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...await listRelativeFiles(full, base));
    } else {
      result.push(full.slice(base.length + 1));
    }
  }
  return result.sort();
}

async function createRestoreDryRunFixture(deviceId = 'restore-dry-run-device') {
  const dataDir = await mkdtemp(join(tmpdir(), 'linke-restore-dry-run-'));
  const server = createServer({ dataDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const sourceDir = join(dataDir, 'source');
  await mkdir(join(sourceDir, 'nested'), { recursive: true });
  await writeFile(join(sourceDir, 'alpha.txt'), 'snapshot alpha');
  await writeFile(join(sourceDir, 'nested', 'beta.txt'), 'snapshot beta');

  const backupRes = await postJSON(port, '/api/backups', { deviceId, sourcePath: sourceDir });
  assert.strictEqual(backupRes.status, 201);
  const snapshot = await backupRes.json();

  const targetDir = join(dataDir, 'target');
  await mkdir(targetDir, { recursive: true });
  await writeFile(join(targetDir, 'alpha.txt'), 'existing target alpha');

  const { deviceDir } = safeDevicePath(dataDir, deviceId);

  return {
    dataDir,
    server,
    port,
    deviceId,
    snapshotId: snapshot.snapshotId,
    targetDir,
    manifestPath: join(deviceDir, 'snapshots', snapshot.snapshotId, 'manifest.json'),
  };
}

async function cleanupFixture(fixture) {
  if (!fixture) return;
  await closeServer(fixture.server);
  await rm(fixture.dataDir, { recursive: true, force: true });
}

// ── Pure function ──────────────────────────────────────────────────

describe('buildRestoreDryRunPlan — pure function', () => {
  const deviceId = 'restore-plan-device';
  const manifest = {
    snapshotId: '11111111-1111-1111-1111-111111111111',
    deviceId,
    files: ['alpha.txt', 'nested/beta.txt'],
  };

  it('returns read-only dry-run structure with create and overwrite actions', () => {
    const plan = buildRestoreDryRunPlan(deviceId, manifest, '/tmp/restore-target', new Set(['alpha.txt']));

    assert.strictEqual(plan.mode, 'dry-run');
    assert.strictEqual(plan.wouldWrite, false);
    assert.strictEqual(plan.deviceId, deviceId);
    assert.strictEqual(plan.snapshotId, manifest.snapshotId);
    assert.strictEqual(plan.targetPath, '/tmp/restore-target');
    assert.deepStrictEqual(plan.summary, {
      totalFiles: 2,
      wouldCreateCount: 1,
      wouldOverwriteCount: 1,
    });
    assert.deepStrictEqual(plan.files, [
      {
        sourceRelativePath: 'alpha.txt',
        targetPath: '/tmp/restore-target/alpha.txt',
        action: 'would-overwrite',
      },
      {
        sourceRelativePath: 'nested/beta.txt',
        targetPath: '/tmp/restore-target/nested/beta.txt',
        action: 'would-create',
      },
    ]);
  });

  it('treats missing manifest.files as an empty file list', () => {
    const plan = buildRestoreDryRunPlan(deviceId, { snapshotId: manifest.snapshotId }, '/tmp/restore-target');
    assert.strictEqual(plan.summary.totalFiles, 0);
    assert.strictEqual(plan.summary.wouldCreateCount, 0);
    assert.strictEqual(plan.summary.wouldOverwriteCount, 0);
    assert.deepStrictEqual(plan.files, []);
  });
});

// ── API ────────────────────────────────────────────────────────────

describe('restore-dry-run API', () => {
  it('returns a restore dry-run plan without mutating manifest or target files', async () => {
    const fixture = await createRestoreDryRunFixture();
    try {
      const manifestHashBefore = await fileSha256(fixture.manifestPath);
      const targetFilesBefore = await listRelativeFiles(fixture.targetDir);
      const targetAlphaBefore = await fileSha256(join(fixture.targetDir, 'alpha.txt'));

      const res = await fetch(
        `http://127.0.0.1:${fixture.port}/api/devices/${fixture.deviceId}/snapshots/${fixture.snapshotId}/restore-dry-run?targetPath=${encodeURIComponent(fixture.targetDir)}`,
      );
      assert.strictEqual(res.status, 200);
      const plan = await res.json();

      assert.strictEqual(plan.mode, 'dry-run');
      assert.strictEqual(plan.wouldWrite, false);
      assert.strictEqual(plan.deviceId, fixture.deviceId);
      assert.strictEqual(plan.snapshotId, fixture.snapshotId);
      assert.strictEqual(plan.summary.totalFiles, 2);
      assert.strictEqual(plan.summary.wouldOverwriteCount, 1);
      assert.strictEqual(plan.summary.wouldCreateCount, 1);
      assert.ok(plan.files.some((file) => file.sourceRelativePath === 'alpha.txt' && file.action === 'would-overwrite'));
      assert.ok(plan.files.some((file) => file.sourceRelativePath === 'nested/beta.txt' && file.action === 'would-create'));

      assert.strictEqual(await fileSha256(fixture.manifestPath), manifestHashBefore, 'manifest must stay unchanged');
      assert.deepStrictEqual(await listRelativeFiles(fixture.targetDir), targetFilesBefore, 'target file list must stay unchanged');
      assert.strictEqual(await fileSha256(join(fixture.targetDir, 'alpha.txt')), targetAlphaBefore, 'target file content must stay unchanged');
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('returns 400 when targetPath is missing', async () => {
    const fixture = await createRestoreDryRunFixture();
    try {
      const res = await fetch(
        `http://127.0.0.1:${fixture.port}/api/devices/${fixture.deviceId}/snapshots/${fixture.snapshotId}/restore-dry-run`,
      );
      assert.strictEqual(res.status, 400);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('rejects snapshotId path traversal', async () => {
    const fixture = await createRestoreDryRunFixture();
    try {
      const res = await fetch(
        `http://127.0.0.1:${fixture.port}/api/devices/${fixture.deviceId}/snapshots/${encodeURIComponent('../../manifest')}/restore-dry-run?targetPath=${encodeURIComponent(fixture.targetDir)}`,
      );
      assert.strictEqual(res.status, 400);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('returns 404 when the snapshot manifest is missing', async () => {
    const fixture = await createRestoreDryRunFixture();
    try {
      const res = await fetch(
        `http://127.0.0.1:${fixture.port}/api/devices/${fixture.deviceId}/snapshots/00000000-0000-0000-0000-000000000000/restore-dry-run?targetPath=${encodeURIComponent(fixture.targetDir)}`,
      );
      assert.strictEqual(res.status, 404);
    } finally {
      await cleanupFixture(fixture);
    }
  });
});

// ── CLI ────────────────────────────────────────────────────────────

describe('restore-dry-run CLI', () => {
  it('CLI outputs valid JSON with dry-run plan', async () => {
    const fixture = await createRestoreDryRunFixture('restore-cli-device');
    try {
      const agentPath = join(import.meta.dirname, '..', 'src', 'agent.js');

      const { stdout } = await exec('node', [
        agentPath,
        'restore-dry-run',
        '--server',
        `http://127.0.0.1:${fixture.port}`,
        '--device',
        fixture.deviceId,
        '--snapshot',
        fixture.snapshotId,
        '--target',
        fixture.targetDir,
      ]);

      const plan = JSON.parse(stdout);
      assert.strictEqual(plan.mode, 'dry-run');
      assert.strictEqual(plan.wouldWrite, false);
      assert.strictEqual(plan.deviceId, fixture.deviceId);
      assert.strictEqual(plan.snapshotId, fixture.snapshotId);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('CLI errors when --target is missing', async () => {
    const fixture = await createRestoreDryRunFixture('restore-cli-device');
    try {
      const agentPath = join(import.meta.dirname, '..', 'src', 'agent.js');
      await assert.rejects(
        () => exec('node', [
          agentPath,
          'restore-dry-run',
          '--server',
          `http://127.0.0.1:${fixture.port}`,
          '--device',
          fixture.deviceId,
          '--snapshot',
          fixture.snapshotId,
        ]),
        (err) => {
          assert.notStrictEqual(err.code, 0);
          assert.match(err.stderr, /target/i);
          return true;
        },
      );
    } finally {
      await cleanupFixture(fixture);
    }
  });
});
