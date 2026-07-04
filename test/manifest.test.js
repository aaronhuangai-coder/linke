import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createBackup, safeDevicePath, readJSON } from '../src/storage.js';
import { createServer } from '../src/server.js';

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

describe('Manifest — nested directory relative paths', () => {
  let dataDir;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'linke-manifest-'));
  });

  after(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('manifest.files records full relative path for nested files (e.g. sub/a.txt)', async () => {
    // 1. Create source directory with nested structure: source/sub/a.txt
    const sourceDir = join(dataDir, 'source');
    const subDir = join(sourceDir, 'sub');
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, 'a.txt'), 'nested-content');
    // Also add a top-level file for comparison
    await writeFile(join(sourceDir, 'root.txt'), 'root-content');

    // 2. Run backup
    const result = await createBackup(dataDir, {
      deviceId: 'manifest-test',
      sourcePath: sourceDir,
    });
    assert.ok(result.snapshotId, 'should return a snapshotId');

    // 3. Read manifest.json
    const { deviceDir } = safeDevicePath(dataDir, 'manifest-test');
    const snapshotDir = join(deviceDir, 'snapshots', result.snapshotId);
    const manifest = await readJSON(join(snapshotDir, 'manifest.json'));

    assert.ok(manifest, 'manifest.json should exist');
    assert.ok(Array.isArray(manifest.files), 'manifest.files should be an array');

    // 4. Assert manifest contains 'sub/a.txt' (not just 'a.txt')
    assert.ok(
      manifest.files.includes('sub/a.txt'),
      `manifest.files should include 'sub/a.txt', got: ${JSON.stringify(manifest.files)}`,
    );

    // Also verify root-level file is recorded correctly
    assert.ok(
      manifest.files.includes('root.txt'),
      `manifest.files should include 'root.txt', got: ${JSON.stringify(manifest.files)}`,
    );

    // Ensure 'a.txt' alone (without sub/ prefix) is NOT in the list
    assert.ok(
      !manifest.files.includes('a.txt'),
      `manifest.files should NOT include bare 'a.txt' — path must include subdirectory`,
    );
  });

  it('manifest.files records deeply nested paths correctly (a/b/c.txt)', async () => {
    const sourceDir = join(dataDir, 'source-deep');
    const deepDir = join(sourceDir, 'a', 'b');
    await mkdir(deepDir, { recursive: true });
    await writeFile(join(deepDir, 'c.txt'), 'deep-content');

    const result = await createBackup(dataDir, {
      deviceId: 'manifest-deep',
      sourcePath: sourceDir,
    });

    const { deviceDir } = safeDevicePath(dataDir, 'manifest-deep');
    const snapshotDir = join(deviceDir, 'snapshots', result.snapshotId);
    const manifest = await readJSON(join(snapshotDir, 'manifest.json'));

    assert.ok(
      manifest.files.includes('a/b/c.txt'),
      `manifest.files should include 'a/b/c.txt', got: ${JSON.stringify(manifest.files)}`,
    );
  });
});

describe('Manifest API — read-only snapshot detail', () => {
  let server, dataDir, port, snapshot, manifestPath, manifestHashBefore;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'linke-manifest-api-'));
    server = createServer({ dataDir });
    await new Promise((r) => server.listen(0, r));
    port = server.address().port;

    const sourceDir = join(dataDir, 'api-source');
    await mkdir(join(sourceDir, 'sub'), { recursive: true });
    await writeFile(join(sourceDir, 'root.txt'), 'root-content');
    await writeFile(join(sourceDir, 'sub', 'nested.txt'), 'nested-content');

    const res = await postJSON(port, '/api/backups', {
      deviceId: 'manifest-api',
      sourcePath: sourceDir,
      hostname: 'ManifestHost',
      ipAddress: '10.0.0.8',
    });
    assert.strictEqual(res.status, 201);
    snapshot = await res.json();

    const { deviceDir } = safeDevicePath(dataDir, 'manifest-api');
    manifestPath = join(deviceDir, 'snapshots', snapshot.snapshotId, 'manifest.json');
    manifestHashBefore = sha256(await readFile(manifestPath));
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    await rm(dataDir, { recursive: true, force: true });
  });

  it('GET /api/devices/:deviceId/snapshots/:snapshotId/manifest returns manifest JSON', async () => {
    const res = await fetch(
      `http://localhost:${port}/api/devices/manifest-api/snapshots/${snapshot.snapshotId}/manifest`,
    );
    assert.strictEqual(res.status, 200);

    const manifest = await res.json();
    assert.strictEqual(manifest.snapshotId, snapshot.snapshotId);
    assert.strictEqual(manifest.deviceId, 'manifest-api');
    assert.strictEqual(manifest.hostname, 'ManifestHost');
    assert.strictEqual(manifest.ipAddress, '10.0.0.8');
    assert.ok(manifest.sourcePath.endsWith('api-source'));
    assert.ok(Array.isArray(manifest.files));
    assert.ok(manifest.files.includes('root.txt'));
    assert.ok(manifest.files.includes('sub/nested.txt'));
  });

  it('manifest API does not modify manifest.json', async () => {
    await fetch(
      `http://localhost:${port}/api/devices/manifest-api/snapshots/${snapshot.snapshotId}/manifest`,
    );
    const manifestHashAfter = sha256(await readFile(manifestPath));
    assert.strictEqual(manifestHashAfter, manifestHashBefore);
  });

  it('returns 404 for a missing snapshot manifest', async () => {
    const res = await fetch(
      `http://localhost:${port}/api/devices/manifest-api/snapshots/00000000-0000-0000-0000-000000000000/manifest`,
    );
    assert.strictEqual(res.status, 404);
  });

  it('rejects snapshotId path traversal', async () => {
    const res = await fetch(
      `http://localhost:${port}/api/devices/manifest-api/snapshots/%2e%2e%2fmanifest/manifest`,
    );
    assert.strictEqual(res.status, 400);
  });
});
