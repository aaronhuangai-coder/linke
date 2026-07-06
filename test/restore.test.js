import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { access, mkdtemp, realpath, rm, symlink, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createServer } from '../src/server.js';

function postJSON(port, path, body) {
  return fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function createRestoreFixture(options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'linke-rest-'));
  const restoreRoot = options.restoreRoot || null;
  const server = createServer({ dataDir, restoreRoot });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const sourceDir = join(dataDir, 'source');
  await mkdir(sourceDir, { recursive: true });
  const sourceFile = join(sourceDir, 'important.txt');
  await writeFile(sourceFile, options.content || 'restore-root-guard-content');

  const backupRes = await postJSON(port, '/api/backups', {
    deviceId: 'restore-root-guard',
    sourcePath: sourceFile,
  });
  assert.strictEqual(backupRes.status, 201);
  const snapshot = await backupRes.json();

  return {
    dataDir,
    restoreRoot,
    server,
    port,
    snapshotId: snapshot.snapshotId,
    content: options.content || 'restore-root-guard-content',
  };
}

async function cleanupRestoreFixture(fixture) {
  if (!fixture) return;
  await new Promise((r) => fixture.server.close(r));
  await rm(fixture.dataDir, { recursive: true, force: true });
  if (fixture.restoreRoot) {
    await rm(fixture.restoreRoot, { recursive: true, force: true });
  }
}

/**
 * Restore truth: backup a file, delete the original source,
 * then restore from snapshot and verify byte-exact match via sha256.
 */
describe('Restore truth — source deleted after backup', () => {
  let server, dataDir, port;
  const ORIGINAL_CONTENT = 'critical-data-restore-truth-test-' + Date.now();

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'linke-rest-'));
    server = createServer({ dataDir });
    await new Promise((r) => server.listen(0, r));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    await rm(dataDir, { recursive: true, force: true });
  });

  it('restored file matches original exactly (sha256)', async () => {
    // 1. Create source file
    const sourceDir = join(dataDir, 'source');
    await mkdir(sourceDir, { recursive: true });
    const sourceFile = join(sourceDir, 'important.txt');
    await writeFile(sourceFile, ORIGINAL_CONTENT);
    const originalHash = sha256(Buffer.from(ORIGINAL_CONTENT));

    // 2. Backup
    const backupRes = await postJSON(port, '/api/backups', {
      deviceId: 'restore-test',
      sourcePath: sourceFile,
    });
    assert.strictEqual(backupRes.status, 201);
    const snapshot = await backupRes.json();

    // 3. Delete original source (and entire source dir)
    await rm(sourceDir, { recursive: true, force: true });

    // 4. Restore to a different target
    const targetDir = join(dataDir, 'restored');
    const restoreRes = await postJSON(port, '/api/restore', {
      deviceId: 'restore-test',
      snapshotId: snapshot.snapshotId,
      targetPath: targetDir,
    });
    assert.strictEqual(restoreRes.status, 200);
    const result = await restoreRes.json();
    assert.strictEqual(result.restored, true);

    // 5. Verify restored file matches original byte-for-byte
    const restoredFile = join(targetDir, 'important.txt');
    const restoredContent = await readFile(restoredFile, 'utf-8');
    const restoredHash = sha256(Buffer.from(restoredContent));

    assert.strictEqual(restoredContent, ORIGINAL_CONTENT, 'content must match exactly');
    assert.strictEqual(restoredHash, originalHash, 'sha256 must match');
  });

  it('restore fails for non-existent snapshot', async () => {
    const targetDir = join(dataDir, 'restore-fail');
    const res = await postJSON(port, '/api/restore', {
      deviceId: 'restore-test',
      snapshotId: '00000000-0000-0000-0000-000000000000',
      targetPath: targetDir,
    });
    assert.strictEqual(res.status, 500);
  });
});

describe('Restore target guard — optional restoreRoot', () => {
  it('keeps existing unrestricted restore behavior when restoreRoot is not configured', async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), 'linke-restore-legacy-target-'));
    const fixture = await createRestoreFixture();
    try {
      const legacyTarget = join(outsideRoot, 'legacy-allowed');
      const restoreRes = await postJSON(fixture.port, '/api/restore', {
        deviceId: 'restore-root-guard',
        snapshotId: fixture.snapshotId,
        targetPath: legacyTarget,
      });

      assert.strictEqual(restoreRes.status, 200);
      assert.strictEqual(await readFile(join(legacyTarget, 'important.txt'), 'utf-8'), fixture.content);
    } finally {
      await cleanupRestoreFixture(fixture);
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('allows relative restore targets inside restoreRoot when configured', async () => {
    const restoreRoot = await mkdtemp(join(tmpdir(), 'linke-restore-root-'));
    const fixture = await createRestoreFixture({ restoreRoot });
    try {
      const restoreRes = await postJSON(fixture.port, '/api/restore', {
        deviceId: 'restore-root-guard',
        snapshotId: fixture.snapshotId,
        targetPath: 'allowed-relative',
      });

      assert.strictEqual(restoreRes.status, 200);
      const result = await restoreRes.json();
      const expectedTarget = join(await realpath(restoreRoot), 'allowed-relative');
      assert.strictEqual(result.targetPath, expectedTarget);
      assert.strictEqual(await readFile(join(expectedTarget, 'important.txt'), 'utf-8'), fixture.content);
    } finally {
      await cleanupRestoreFixture(fixture);
    }
  });

  it('rejects absolute restore targets outside restoreRoot without writing files', async () => {
    const restoreRoot = await mkdtemp(join(tmpdir(), 'linke-restore-root-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'linke-restore-outside-'));
    const fixture = await createRestoreFixture({ restoreRoot });
    try {
      const blockedTarget = join(outsideRoot, 'blocked');
      const restoreRes = await postJSON(fixture.port, '/api/restore', {
        deviceId: 'restore-root-guard',
        snapshotId: fixture.snapshotId,
        targetPath: blockedTarget,
      });

      assert.strictEqual(restoreRes.status, 400);
      assert.deepStrictEqual(await restoreRes.json(), {
        error: 'targetPath is outside the allowed restore root',
      });
      assert.strictEqual(await pathExists(join(blockedTarget, 'important.txt')), false);
    } finally {
      await cleanupRestoreFixture(fixture);
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('rejects restore targets that escape restoreRoot through a symlink ancestor', async () => {
    const restoreRoot = await mkdtemp(join(tmpdir(), 'linke-restore-root-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'linke-restore-outside-'));
    const fixture = await createRestoreFixture({ restoreRoot });
    try {
      await symlink(outsideRoot, join(restoreRoot, 'linked-outside'), 'dir');
      const restoreRes = await postJSON(fixture.port, '/api/restore', {
        deviceId: 'restore-root-guard',
        snapshotId: fixture.snapshotId,
        targetPath: 'linked-outside/blocked',
      });

      assert.strictEqual(restoreRes.status, 400);
      assert.deepStrictEqual(await restoreRes.json(), {
        error: 'targetPath is outside the allowed restore root',
      });
      assert.strictEqual(await pathExists(join(outsideRoot, 'blocked', 'important.txt')), false);
    } finally {
      await cleanupRestoreFixture(fixture);
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
