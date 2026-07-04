import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBackup, safeDevicePath, readJSON } from '../src/storage.js';

describe('Backup with excludePatterns', () => {
  let dataDir, sourceDir;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'linke-exclude-'));
    sourceDir = join(dataDir, 'source');
    await mkdir(sourceDir, { recursive: true });

    // keep.txt  — should always be kept
    await writeFile(join(sourceDir, 'keep.txt'), 'keep-me');
    // skip.tmp  — matches *.tmp
    await writeFile(join(sourceDir, 'skip.tmp'), 'skip-me');
    // secret.txt — exact name match
    await writeFile(join(sourceDir, 'secret.txt'), 'secret');
    // node_modules/pkg.js — directory name match
    const nmDir = join(sourceDir, 'node_modules');
    await mkdir(nmDir, { recursive: true });
    await writeFile(join(nmDir, 'pkg.js'), 'pkg-content');
  });

  after(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('excludes files matching patterns — manifest only contains keep.txt', async () => {
    const result = await createBackup(dataDir, {
      deviceId: 'exclude-test',
      sourcePath: sourceDir,
      excludePatterns: ['*.tmp', 'secret.txt', 'node_modules'],
    });

    assert.ok(result.snapshotId);

    const { deviceDir } = safeDevicePath(dataDir, 'exclude-test');
    const manifest = await readJSON(
      join(deviceDir, 'snapshots', result.snapshotId, 'manifest.json'),
    );

    assert.ok(manifest.files.includes('keep.txt'), 'must include keep.txt');
    assert.ok(!manifest.files.includes('skip.tmp'), 'must exclude skip.tmp');
    assert.ok(!manifest.files.includes('secret.txt'), 'must exclude secret.txt');
    assert.ok(
      !manifest.files.some((f) => f.includes('node_modules')),
      'must exclude node_modules/',
    );
    assert.strictEqual(manifest.files.length, 1, 'only keep.txt should remain');
  });

  it('without excludePatterns all files are included', async () => {
    const result = await createBackup(dataDir, {
      deviceId: 'exclude-all',
      sourcePath: sourceDir,
    });

    const { deviceDir } = safeDevicePath(dataDir, 'exclude-all');
    const manifest = await readJSON(
      join(deviceDir, 'snapshots', result.snapshotId, 'manifest.json'),
    );

    assert.ok(manifest.files.includes('keep.txt'));
    assert.ok(manifest.files.includes('skip.tmp'));
    assert.ok(manifest.files.includes('secret.txt'));
    assert.ok(manifest.files.some((f) => f.includes('node_modules')));
  });

  it('empty excludePatterns behaves like no exclusion', async () => {
    const result = await createBackup(dataDir, {
      deviceId: 'exclude-empty',
      sourcePath: sourceDir,
      excludePatterns: [],
    });

    const { deviceDir } = safeDevicePath(dataDir, 'exclude-empty');
    const manifest = await readJSON(
      join(deviceDir, 'snapshots', result.snapshotId, 'manifest.json'),
    );

    assert.ok(manifest.files.length >= 4, 'all files should be present');
  });
});
