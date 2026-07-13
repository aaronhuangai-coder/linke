import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../src/server.js';
import { startController } from '../src/controller-runtime.js';
import { DEVICE_PROTOCOL_VERSION } from '../src/device-protocol.js';
import { requestPinnedJson } from '../src/device-client.js';

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
    const { readFile } = await import('node:fs/promises');
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
