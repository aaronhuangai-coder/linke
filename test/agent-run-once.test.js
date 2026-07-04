import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../src/server.js';
import { runOnceFromConfig } from '../src/agent.js';

describe('Agent run-once from config', () => {
  let server, dataDir, port;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'linke-agent-run-'));
    server = createServer({ dataDir });
    await new Promise((r) => server.listen(0, r));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    await rm(dataDir, { recursive: true, force: true });
  });

  it('creates one snapshot per backupJob and records jobName', async () => {
    // Two distinct source dirs
    const src1 = join(dataDir, 'src1');
    const src2 = join(dataDir, 'src2');
    await mkdir(src1, { recursive: true });
    await mkdir(src2, { recursive: true });
    await writeFile(join(src1, 'a.txt'), 'aaa');
    await writeFile(join(src2, 'b.txt'), 'bbb');

    // Write config pointing at our temp server
    const configPath = join(dataDir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        serverUrl: `http://localhost:${port}`,
        deviceId: 'agent-run-once',
        backupJobs: [
          { name: 'job-alpha', sourcePath: src1 },
          { name: 'job-beta', sourcePath: src2 },
        ],
      }),
    );

    const results = await runOnceFromConfig(configPath);

    assert.strictEqual(results.length, 2, 'should produce 2 snapshots');
    assert.strictEqual(results[0].jobName, 'job-alpha');
    assert.strictEqual(results[1].jobName, 'job-beta');
    assert.ok(results[0].snapshotId);
    assert.ok(results[1].snapshotId);
    assert.notStrictEqual(results[0].snapshotId, results[1].snapshotId);
  });

  it('sends heartbeat before backups: device is online with config hostname/ipAddress and snapshotCount = job count', async () => {
    const src = join(dataDir, 'src-hb');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'f.txt'), 'data');

    const configPath = join(dataDir, 'config-hb.json');
    await writeFile(
      configPath,
      JSON.stringify({
        serverUrl: `http://localhost:${port}`,
        deviceId: 'device-hb',
        hostname: 'my-host',
        ipAddress: '10.0.0.99',
        backupJobs: [
          { name: 'j1', sourcePath: src },
          { name: 'j2', sourcePath: src },
          { name: 'j3', sourcePath: src },
        ],
      }),
    );

    await runOnceFromConfig(configPath);

    // Verify device state via /api/devices
    const res = await fetch(`http://localhost:${port}/api/devices`);
    const devices = await res.json();
    const device = devices.find((d) => d.deviceId === 'device-hb');

    assert.ok(device, 'device should exist in /api/devices');
    assert.strictEqual(device.status, 'online', 'status must be online after heartbeat');
    assert.strictEqual(device.hostname, 'my-host', 'hostname must come from config');
    assert.strictEqual(device.ipAddress, '10.0.0.99', 'ipAddress must come from config');
    assert.strictEqual(device.snapshotCount, 3, 'snapshotCount must equal number of backupJobs');
  });

  it('passes excludePatterns through to backup', async () => {
    const src = join(dataDir, 'src-excl');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'keep.txt'), 'keep');
    await writeFile(join(src, 'skip.tmp'), 'skip');

    const configPath = join(dataDir, 'config-excl.json');
    await writeFile(
      configPath,
      JSON.stringify({
        serverUrl: `http://localhost:${port}`,
        deviceId: 'agent-excl',
        backupJobs: [{ name: 'excl-job', sourcePath: src }],
        excludePatterns: ['*.tmp'],
      }),
    );

    const results = await runOnceFromConfig(configPath);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].fileCount, 1, 'only keep.txt should survive');
  });
});
