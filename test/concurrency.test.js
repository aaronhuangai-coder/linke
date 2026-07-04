import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../src/server.js';

function postJSON(port, path, body) {
  return fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Concurrency test: two devices POST /api/backups simultaneously.
 * Uses a counter-based barrier at afterCopy to guarantee both requests
 * have overlapping lifecycles (both have created dirs + copied files,
 * but neither has written manifests yet).
 * Repeated 3 times to prove consistent namespace isolation.
 */
describe('Concurrent backups — namespace isolation', () => {
  let dataDir;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'linke-conc-'));
  });

  after(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  for (let round = 1; round <= 3; round++) {
    it(`round ${round}: overlapping backup requests stay isolated`, async () => {
      // ── Counter-based barrier: waits for BOTH backups at afterCopy ──
      let arrived = 0;
      let releaseBarrier;
      const bothArrived = new Promise((r) => { releaseBarrier = r; });

      const hooks = {
        afterCopy: async () => {
          arrived++;
          if (arrived >= 2) {
            releaseBarrier();   // both have copied files, neither done yet
          } else {
            // First arrival: wait until both are in, then continue
            await bothArrived;
          }
        },
      };

      const server = createServer({ dataDir, backupHooks: hooks });
      await new Promise((r) => server.listen(0, r));
      const port = server.address().port;

      // Prepare source dirs with distinct content
      const src1 = join(dataDir, `_r${round}_src1`);
      const src2 = join(dataDir, `_r${round}_src2`);
      await mkdir(src1, { recursive: true });
      await mkdir(src2, { recursive: true });
      await writeFile(join(src1, 'data.txt'), `device1-round${round}`);
      await writeFile(join(src2, 'data.txt'), `device2-round${round}`);

      // Launch two backups concurrently
      const p1 = postJSON(port, '/api/backups', {
        deviceId: `dev1-r${round}`, sourcePath: src1,
      });
      const p2 = postJSON(port, '/api/backups', {
        deviceId: `dev2-r${round}`, sourcePath: src2,
      });

      // Wait until BOTH backups have copied files (overlapping lifecycle proven)
      await bothArrived;

      // ── Verify namespace isolation while both are still in-flight ──
      const devicesDir = join(dataDir, 'repo', 'devices');
      const dirs = await readdir(devicesDir);
      assert.ok(dirs.includes(`dev1-r${round}`), 'dev1 dir must exist');
      assert.ok(dirs.includes(`dev2-r${round}`), 'dev2 dir must exist');

      // dev1's files must NOT contain dev2's data and vice versa
      const dev1Snaps = await readdir(join(devicesDir, `dev1-r${round}`, 'snapshots'));
      const dev2Snaps = await readdir(join(devicesDir, `dev2-r${round}`, 'snapshots'));
      assert.strictEqual(dev1Snaps.length, 1, 'dev1 should have exactly 1 snapshot');
      assert.strictEqual(dev2Snaps.length, 1, 'dev2 should have exactly 1 snapshot');

      const dev1Files = await readdir(
        join(devicesDir, `dev1-r${round}`, 'snapshots', dev1Snaps[0], 'files'),
      );
      const dev2Files = await readdir(
        join(devicesDir, `dev2-r${round}`, 'snapshots', dev2Snaps[0], 'files'),
      );
      assert.deepStrictEqual(dev1Files, ['data.txt']);
      assert.deepStrictEqual(dev2Files, ['data.txt']);

      // Both are released, wait for completion
      const [r1, r2] = await Promise.all([p1, p2]);
      assert.strictEqual(r1.status, 201, 'backup1 should succeed');
      assert.strictEqual(r2.status, 201, 'backup2 should succeed');

      const snap1 = await r1.json();
      const snap2 = await r2.json();

      assert.ok(snap1.snapshotId);
      assert.ok(snap2.snapshotId);
      assert.notStrictEqual(snap1.snapshotId, snap2.snapshotId);

      await new Promise((r) => server.close(r));
    });
  }
});
