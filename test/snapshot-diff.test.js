import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { buildSnapshotDiffDryRunPlan } from '../src/snapshot-diff.js';
import { createServer } from '../src/server.js';
import { safeDevicePath } from '../src/storage.js';

function postJSON(port, path, body) {
  return fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

describe('buildSnapshotDiffDryRunPlan', () => {
  it('compares manifest file paths without reading file content', () => {
    const fromManifest = {
      snapshotId: 'from-1',
      files: ['a.txt', 'shared.txt', 'nested/old.txt'],
    };
    const toManifest = {
      snapshotId: 'to-1',
      files: ['shared.txt', 'nested/new.txt', 'z.txt'],
    };

    const plan = buildSnapshotDiffDryRunPlan('device-1', fromManifest, toManifest);

    assert.strictEqual(plan.mode, 'dry-run');
    assert.strictEqual(plan.deviceId, 'device-1');
    assert.strictEqual(plan.fromSnapshotId, 'from-1');
    assert.strictEqual(plan.toSnapshotId, 'to-1');
    assert.strictEqual(plan.wouldWrite, false);
    assert.deepStrictEqual(plan.added, ['nested/new.txt', 'z.txt']);
    assert.deepStrictEqual(plan.removed, ['a.txt', 'nested/old.txt']);
    assert.deepStrictEqual(plan.unchanged, ['shared.txt']);
    assert.deepStrictEqual(plan.summary, {
      addedCount: 2,
      removedCount: 2,
      unchangedCount: 1,
      comparedBy: 'manifest.files',
    });
  });

  it('deduplicates duplicate manifest paths and sorts output', () => {
    const plan = buildSnapshotDiffDryRunPlan(
      'device-1',
      { snapshotId: 'from-1', files: ['b.txt', 'a.txt', 'a.txt'] },
      { snapshotId: 'to-1', files: ['c.txt', 'b.txt', 'c.txt'] },
    );

    assert.deepStrictEqual(plan.added, ['c.txt']);
    assert.deepStrictEqual(plan.removed, ['a.txt']);
    assert.deepStrictEqual(plan.unchanged, ['b.txt']);
  });
});

describe('snapshot diff dry-run API', () => {
  let server, dataDir, port, firstSnapshot, secondSnapshot, firstManifestPath, secondManifestPath;
  let firstHashBefore, secondHashBefore;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'linke-snapshot-diff-'));
    server = createServer({ dataDir });
    await new Promise((r) => server.listen(0, r));
    port = server.address().port;

    const firstSource = join(dataDir, 'source-first');
    await mkdir(firstSource, { recursive: true });
    await writeFile(join(firstSource, 'old.txt'), 'old');
    await writeFile(join(firstSource, 'shared.txt'), 'first-shared');

    const firstRes = await postJSON(port, '/api/backups', {
      deviceId: 'diff-device',
      sourcePath: firstSource,
    });
    assert.strictEqual(firstRes.status, 201);
    firstSnapshot = await firstRes.json();

    const secondSource = join(dataDir, 'source-second');
    await mkdir(secondSource, { recursive: true });
    await writeFile(join(secondSource, 'shared.txt'), 'second-shared');
    await writeFile(join(secondSource, 'new.txt'), 'new');

    const secondRes = await postJSON(port, '/api/backups', {
      deviceId: 'diff-device',
      sourcePath: secondSource,
    });
    assert.strictEqual(secondRes.status, 201);
    secondSnapshot = await secondRes.json();

    const { deviceDir } = safeDevicePath(dataDir, 'diff-device');
    firstManifestPath = join(deviceDir, 'snapshots', firstSnapshot.snapshotId, 'manifest.json');
    secondManifestPath = join(deviceDir, 'snapshots', secondSnapshot.snapshotId, 'manifest.json');
    firstHashBefore = sha256(await readFile(firstManifestPath));
    secondHashBefore = sha256(await readFile(secondManifestPath));
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    await rm(dataDir, { recursive: true, force: true });
  });

  it('GET /api/devices/:deviceId/snapshots/diff-dry-run returns added/removed/unchanged', async () => {
    const res = await fetch(
      `http://localhost:${port}/api/devices/diff-device/snapshots/diff-dry-run?from=${firstSnapshot.snapshotId}&to=${secondSnapshot.snapshotId}`,
    );
    assert.strictEqual(res.status, 200);
    const plan = await res.json();

    assert.strictEqual(plan.mode, 'dry-run');
    assert.strictEqual(plan.deviceId, 'diff-device');
    assert.strictEqual(plan.fromSnapshotId, firstSnapshot.snapshotId);
    assert.strictEqual(plan.toSnapshotId, secondSnapshot.snapshotId);
    assert.strictEqual(plan.wouldWrite, false);
    assert.deepStrictEqual(plan.added, ['new.txt']);
    assert.deepStrictEqual(plan.removed, ['old.txt']);
    assert.deepStrictEqual(plan.unchanged, ['shared.txt']);
  });

  it('snapshot diff dry-run API does not modify either manifest', async () => {
    await fetch(
      `http://localhost:${port}/api/devices/diff-device/snapshots/diff-dry-run?from=${firstSnapshot.snapshotId}&to=${secondSnapshot.snapshotId}`,
    );

    assert.strictEqual(sha256(await readFile(firstManifestPath)), firstHashBefore);
    assert.strictEqual(sha256(await readFile(secondManifestPath)), secondHashBefore);
  });

  it('returns 400 when from or to is missing', async () => {
    const res = await fetch(
      `http://localhost:${port}/api/devices/diff-device/snapshots/diff-dry-run?from=${firstSnapshot.snapshotId}`,
    );
    assert.strictEqual(res.status, 400);
  });

  it('rejects snapshotId path traversal', async () => {
    const res = await fetch(
      `http://localhost:${port}/api/devices/diff-device/snapshots/diff-dry-run?from=%2e%2e%2fmanifest&to=${secondSnapshot.snapshotId}`,
    );
    assert.strictEqual(res.status, 400);
  });

  it('returns 404 when one snapshot manifest is missing', async () => {
    const res = await fetch(
      `http://localhost:${port}/api/devices/diff-device/snapshots/diff-dry-run?from=00000000-0000-0000-0000-000000000000&to=${secondSnapshot.snapshotId}`,
    );
    assert.strictEqual(res.status, 404);
  });
}
);
