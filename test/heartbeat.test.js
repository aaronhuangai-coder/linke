import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
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
