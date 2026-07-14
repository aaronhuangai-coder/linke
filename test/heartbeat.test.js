import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../src/server.js';
import { startController } from '../src/controller-runtime.js';
import { DEVICE_PROTOCOL_VERSION } from '../src/device-protocol.js';
import { requestPinnedJson } from '../src/device-client.js';
import { createBackup, recordHeartbeat } from '../src/storage.js';

function postJSON(port, path, body) {
  return fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * In-memory Keychain adapter for dual-listener heartbeat. Never touches macOS Keychain.
 * @param {Map<string, string>} [initial]
 */
function memoryKeychain(initial = new Map()) {
  return {
    async get(id) {
      if (!initial.has(id)) {
        const error = new Error('keychain-item-missing');
        error.code = 'keychain-item-missing';
        throw error;
      }
      return initial.get(id);
    },
    async set(id, value) {
      initial.set(id, value);
    },
    async delete(id) {
      return initial.delete(id);
    },
  };
}

/**
 * Remap private Agent binds to loopback for isolated automated tests.
 * @returns {(server: import('node:net').Server, port: number, host: string) => Promise<void>}
 */
function createLoopbackTestListenAdapter() {
  return (server, port, host) => new Promise((resolveListen, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    const listenHost = (host === '127.0.0.1' || host === '::1') ? host : '127.0.0.1';
    server.listen(port, listenHost, () => {
      server.off('error', onError);
      resolveListen();
    });
  });
}

describe('Heartbeat API', () => {
  let server, dataDir, port;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'linke-hb-'));
    server = createServer({ dataDir });
    await new Promise((r) => server.listen(0, r));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    await rm(dataDir, { recursive: true, force: true });
  });

  it('records hostname, IP, and sets status=online', async () => {
    const res = await postJSON(port, '/api/heartbeat', {
      deviceId: 'test-pc',
      hostname: 'TestPC',
      ipAddress: '192.168.1.100',
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.deviceId, 'test-pc');
    assert.strictEqual(body.hostname, 'TestPC');
    assert.strictEqual(body.ipAddress, '192.168.1.100');
    assert.strictEqual(body.status, 'online');
    assert.ok(body.lastHeartbeatAt);
  });

  it('updates on second heartbeat', async () => {
    const res = await postJSON(port, '/api/heartbeat', {
      deviceId: 'test-pc',
      hostname: 'TestPC-Updated',
      ipAddress: '10.0.0.5',
    });
    const body = await res.json();
    assert.strictEqual(body.hostname, 'TestPC-Updated');
    assert.strictEqual(body.ipAddress, '10.0.0.5');
    assert.strictEqual(body.status, 'online');
  });

  it('lists devices after heartbeat', async () => {
    const res = await fetch(`http://localhost:${port}/api/devices`);
    const devices = await res.json();
    assert.ok(Array.isArray(devices));
    const found = devices.find((d) => d.deviceId === 'test-pc');
    assert.ok(found, 'device should appear in list');
    assert.strictEqual(found.hostname, 'TestPC-Updated');
    assert.strictEqual(found.status, 'online');
  });

  it('rejects heartbeat without deviceId', async () => {
    const res = await postJSON(port, '/api/heartbeat', { hostname: 'NoID' });
    assert.strictEqual(res.status, 400);
  });
});

describe('Agent HTTPS enrollment + heartbeat through controller runtime', () => {
  it('stores socket remoteAddress and ignores body-reported IP via pin-before-secret client', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-hb-agent-'));
    const writeToken = 'hb-admin-write-token';
    let runtime;
    try {
      runtime = await startController({
        dataDir,
        managementHost: '127.0.0.1',
        managementPort: 0,
        agentHost: '192.168.10.4',
        agentPort: 0,
        writeToken,
        keychain: memoryKeychain(),
        listenServer: createLoopbackTestListenAdapter(),
      });

      const managementPort = runtime.managementServer.address().port;
      const agentPort = runtime.agentServer.address().port;
      const deviceId = 'mac-heartbeat-ip';
      const tlsFingerprint = runtime.status.tlsFingerprint;
      // Connect to the actual loopback bind with Task 7 pin-before-secret path only.
      const agentUrl = `https://127.0.0.1:${agentPort}`;

      const enrollIssue = await fetch(`http://127.0.0.1:${managementPort}/api/device-enrollment-codes`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${writeToken}`,
        },
        body: JSON.stringify({ deviceId }),
      });
      assert.strictEqual(enrollIssue.status, 201);
      const issued = await enrollIssue.json();
      assert.ok(issued.enrollmentCode);
      assert.match(issued.tlsFingerprint, /^[a-f0-9]{64}$/);
      assert.strictEqual(issued.tlsFingerprint, tlsFingerprint);
      assert.match(issued.agentUrl, /^https:\/\//);

      // Enrollment code is only written after TLS fingerprint pin succeeds.
      const enrolled = await requestPinnedJson({
        agentUrl,
        path: '/agent/enroll',
        tlsFingerprint,
        body: {
          deviceId,
          enrollmentCode: issued.enrollmentCode,
          protocolVersion: DEVICE_PROTOCOL_VERSION,
        },
      });
      assert.ok(enrolled.deviceToken);
      assert.strictEqual(enrolled.deviceId, deviceId);

      const spoofedIp = '203.0.113.50';
      // Device token is only written after the same pin-before-secret gate.
      const heartbeat = await requestPinnedJson({
        agentUrl,
        path: '/agent/heartbeat',
        tlsFingerprint,
        token: enrolled.deviceToken,
        body: {
          deviceId,
          hostname: 'EndpointMac',
          ipAddress: spoofedIp,
          protocolVersion: DEVICE_PROTOCOL_VERSION,
        },
      });
      assert.strictEqual(heartbeat.accepted, true);
      assert.strictEqual(heartbeat.deviceId, deviceId);

      const devicesRes = await fetch(`http://127.0.0.1:${managementPort}/api/devices`, {
        headers: { authorization: `Bearer ${writeToken}` },
      });
      assert.strictEqual(devicesRes.status, 200);
      const devices = await devicesRes.json();
      const found = devices.find((d) => d.deviceId === deviceId);
      assert.ok(found, 'enrolled device should appear in management GET /api/devices');
      assert.strictEqual(found.hostname, 'EndpointMac');
      assert.strictEqual(found.status, 'online');
      assert.notStrictEqual(found.ipAddress, spoofedIp);
      assert.match(found.ipAddress, /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
    } finally {
      if (runtime) await runtime.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('uses Task 7 pin client and does not import node https directly', async () => {
    const source = await readFile(new URL(import.meta.url), 'utf8');
    assert.match(source, /requestPinnedJson/);
    assert.ok(
      !/import\s+https\s+from\s+['"]node:https['"]/.test(source),
      'must not import node:https; pin path lives in device-client only',
    );
    assert.ok(
      !new RegExp(['rejectUnauthorized', '\\s*:\\s*false'].join('')).test(source),
      'must not set TLS trust bypass in this test file',
    );
  });
});

describe('storage dataDir no-follow hardening', () => {
  it('rejects repo/devices/device directory and device.json final symlinks without writing outside', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'linke-repo-out-'));
    try {
      const dataDir = await mkdtemp(join(tmpdir(), 'linke-repo-dir-'));
      try {
        await mkdir(join(dataDir, 'repo'), { recursive: true });
        await symlink(outside, join(dataDir, 'repo', 'devices'), 'dir');
        await assert.rejects(
          () => recordHeartbeat(dataDir, 'mac-repo', 'Host', '10.0.0.1'),
          (error) => {
            const text = `${error?.message || ''}\n${error?.stack || ''}`;
            assert.equal(text.includes(outside), false);
            assert.equal(text.includes(dataDir), false);
            return true;
          },
        );
        assert.equal((await readdir(outside)).includes('mac-repo'), false);
        assert.equal((await readdir(outside)).includes('device.json'), false);
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }

      const dataDirDevice = await mkdtemp(join(tmpdir(), 'linke-device-dir-'));
      try {
        await mkdir(join(dataDirDevice, 'repo', 'devices'), { recursive: true });
        await symlink(outside, join(dataDirDevice, 'repo', 'devices', 'mac-device'), 'dir');
        await assert.rejects(
          () => recordHeartbeat(dataDirDevice, 'mac-device', 'Host', '10.0.0.2'),
          (error) => {
            const text = `${error?.message || ''}\n${error?.stack || ''}`;
            assert.equal(text.includes(outside), false);
            return true;
          },
        );
        assert.equal((await readdir(outside)).includes('device.json'), false);
      } finally {
        await rm(dataDirDevice, { recursive: true, force: true });
      }

      const dataDirFinal = await mkdtemp(join(tmpdir(), 'linke-device-json-'));
      try {
        await mkdir(join(dataDirFinal, 'repo', 'devices', 'mac-final'), { recursive: true });
        const outsideFile = join(outside, 'device.json');
        await writeFile(outsideFile, 'OUTSIDE-DEVICE');
        await symlink(outsideFile, join(dataDirFinal, 'repo', 'devices', 'mac-final', 'device.json'), 'file');
        await assert.rejects(
          () => recordHeartbeat(dataDirFinal, 'mac-final', 'Host', '10.0.0.3'),
          (error) => {
            const text = `${error?.message || ''}\n${error?.stack || ''}`;
            assert.equal(text.includes(outside), false);
            assert.equal(text.includes('OUTSIDE-DEVICE'), false);
            return true;
          },
        );
        assert.equal(await readFile(outsideFile, 'utf8'), 'OUTSIDE-DEVICE');
        assert.equal((await lstat(join(dataDirFinal, 'repo', 'devices', 'mac-final', 'device.json'))).isSymbolicLink(), true);
      } finally {
        await rm(dataDirFinal, { recursive: true, force: true });
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects backup internal destination path symlink without writing outside dataDir', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'linke-backup-out-'));
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-backup-repo-'));
    const source = await mkdtemp(join(tmpdir(), 'linke-backup-src-'));
    try {
      await writeFile(join(source, 'note.txt'), 'payload');
      await mkdir(join(dataDir, 'repo'), { recursive: true });
      await symlink(outside, join(dataDir, 'repo', 'devices'), 'dir');
      await assert.rejects(
        () => createBackup(dataDir, {
          deviceId: 'mac-backup',
          hostname: 'Host',
          ipAddress: '10.0.0.4',
          sourcePath: source,
        }),
        (error) => {
          const text = `${error?.message || ''}\n${error?.stack || ''}`;
          assert.equal(text.includes(outside), false);
          assert.equal(text.includes(source), false);
          return true;
        },
      );
      assert.equal((await readdir(outside)).includes('mac-backup'), false);
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
    }
  });

  it('rejects afterCopy files/ directory symlink swap without publishing manifest', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'linke-backup-files-out-'));
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-backup-files-swap-'));
    const source = await mkdtemp(join(tmpdir(), 'linke-backup-files-src-'));
    try {
      await writeFile(join(source, 'alpha.txt'), 'alpha-payload');
      await writeFile(join(outside, 'planted.txt'), 'OUTSIDE-PLANTED');
      await assert.rejects(
        () => createBackup(dataDir, {
          deviceId: 'mac-files-swap',
          hostname: 'Host',
          ipAddress: '10.0.0.5',
          sourcePath: source,
        }, {
          afterCopy: async (snapshotId) => {
            const filesDir = join(
              dataDir,
              'repo',
              'devices',
              'mac-files-swap',
              'snapshots',
              snapshotId,
              'files',
            );
            await rm(filesDir, { recursive: true, force: true });
            await symlink(outside, filesDir, 'dir');
          },
        }),
        (error) => {
          const text = `${error?.message || ''}\n${error?.stack || ''}\n${error?.code || ''}`;
          assert.equal(text.includes(outside), false);
          assert.equal(text.includes('OUTSIDE-PLANTED'), false);
          assert.equal(text.includes(dataDir), false);
          return true;
        },
      );
      // Manifest must not be published under the snapshot.
      const snapshotsDir = join(dataDir, 'repo', 'devices', 'mac-files-swap', 'snapshots');
      let snapshotIds = [];
      try {
        snapshotIds = await readdir(snapshotsDir);
      } catch {
        snapshotIds = [];
      }
      for (const id of snapshotIds) {
        await assert.rejects(
          () => readFile(join(snapshotsDir, id, 'manifest.json'), 'utf8'),
          (error) => error && error.code === 'ENOENT',
        );
      }
      assert.equal(await readFile(join(outside, 'planted.txt'), 'utf8'), 'OUTSIDE-PLANTED');
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
    }
  });

  it('rejects top-level single-file backup when afterDirSetup plants dest leaf symlink', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'linke-backup-leaf-out-'));
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-backup-leaf-swap-'));
    const sourceFile = join(await mkdtemp(join(tmpdir(), 'linke-backup-leaf-src-')), 'solo.txt');
    try {
      await writeFile(sourceFile, 'solo-payload');
      const outsideFile = join(outside, 'solo.txt');
      await writeFile(outsideFile, 'OUTSIDE-SOLO');
      await assert.rejects(
        () => createBackup(dataDir, {
          deviceId: 'mac-leaf-swap',
          hostname: 'Host',
          ipAddress: '10.0.0.6',
          sourcePath: sourceFile,
        }, {
          afterDirSetup: async (snapshotId) => {
            const destLeaf = join(
              dataDir,
              'repo',
              'devices',
              'mac-leaf-swap',
              'snapshots',
              snapshotId,
              'files',
              'solo.txt',
            );
            await symlink(outsideFile, destLeaf, 'file');
          },
        }),
        (error) => {
          const text = `${error?.message || ''}\n${error?.stack || ''}`;
          assert.equal(text.includes(outside), false);
          assert.equal(text.includes('OUTSIDE-SOLO'), false);
          return true;
        },
      );
      assert.equal(await readFile(outsideFile, 'utf8'), 'OUTSIDE-SOLO');
      const snapshotsDir = join(dataDir, 'repo', 'devices', 'mac-leaf-swap', 'snapshots');
      let snapshotIds = [];
      try {
        snapshotIds = await readdir(snapshotsDir);
      } catch {
        snapshotIds = [];
      }
      for (const id of snapshotIds) {
        await assert.rejects(
          () => readFile(join(snapshotsDir, id, 'manifest.json'), 'utf8'),
          (error) => error && error.code === 'ENOENT',
        );
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
      await rm(sourceFile, { force: true }).catch(() => {});
      await rm(join(sourceFile, '..'), { recursive: true, force: true }).catch(() => {});
    }
  });
});
