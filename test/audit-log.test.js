import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendAuditEvent, readAuditEvents, sanitizeAuditEvent } from '../src/audit-log.js';
import { createServer } from '../src/server.js';

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function getJSON(base, path, token) {
  return fetch(`${base}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

async function postJSON(base, path, token, body) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function createAuditServer(options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'linke-audit-'));
  const restoreRoot = options.restoreRoot || null;
  const server = createServer({
    dataDir,
    authToken: options.authToken,
    restoreRoot,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    dataDir,
    restoreRoot,
    server,
    base: `http://127.0.0.1:${server.address().port}`,
  };
}

async function cleanupAuditServer(fixture) {
  if (!fixture) return;
  await closeServer(fixture.server);
  await rm(fixture.dataDir, { recursive: true, force: true });
  if (fixture.restoreRoot) {
    await rm(fixture.restoreRoot, { recursive: true, force: true });
  }
}

describe('audit log module', () => {
  it('sanitizes events with an exact allowlist and drops sensitive fields', () => {
    const event = sanitizeAuditEvent(
      {
        type: 'api.backup.created',
        method: 'POST',
        path: '/api/backups',
        statusCode: 201,
        outcome: 'success',
        requestId: 'req-allowlist',
        deviceId: 'device-1',
        snapshotId: 'snapshot-1',
        fileCount: 2,
        message: 'created',
        Authorization: 'Bearer leaked',
        sourcePath: '/private/tmp/source-secret',
        targetPath: '/private/tmp/target-secret',
        endpoint: 'http://admin:secret@nas.local',
        token: 'token-secret',
        password: 'password-secret',
        apiKey: 'api-key-secret',
      },
      new Date('2026-07-06T12:00:00.000Z'),
    );

    assert.deepEqual(Object.keys(event).sort(), [
      'createdAt',
      'deviceId',
      'fileCount',
      'id',
      'message',
      'method',
      'outcome',
      'path',
      'requestId',
      'snapshotId',
      'statusCode',
      'type',
    ].sort());
    assert.equal(event.createdAt, '2026-07-06T12:00:00.000Z');
    assert.match(event.id, /^[a-f0-9-]{36}$/i);
    assert.doesNotMatch(JSON.stringify(event), /Bearer|private\/tmp|admin:secret|token-secret|password-secret|api-key-secret/);
  });

  it('returns newest audit events first and clamps the limit', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-audit-module-'));
    try {
      assert.deepEqual(await readAuditEvents(dataDir), []);
      await appendAuditEvent(dataDir, {
        type: 'api.heartbeat.success',
        method: 'POST',
        path: '/api/heartbeat',
        statusCode: 200,
        outcome: 'success',
        requestId: 'req-1',
        deviceId: 'device-1',
        createdAt: '2026-07-06T12:00:00.000Z',
      });
      await appendAuditEvent(dataDir, {
        type: 'api.backup.created',
        method: 'POST',
        path: '/api/backups',
        statusCode: 201,
        outcome: 'success',
        requestId: 'req-2',
        deviceId: 'device-1',
        snapshotId: 'snapshot-2',
        fileCount: 1,
        createdAt: '2026-07-06T12:01:00.000Z',
      });

      const events = await readAuditEvents(dataDir, { limit: 1 });
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'api.backup.created');
      assert.equal(events[0].requestId, 'req-2');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('preserves concurrent append lines for small audit events', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-audit-concurrent-'));
    try {
      await Promise.all(Array.from({ length: 10 }, (_, index) => appendAuditEvent(dataDir, {
        type: 'api.heartbeat.success',
        method: 'POST',
        path: '/api/heartbeat',
        statusCode: 200,
        outcome: 'success',
        requestId: `req-${index}`,
        deviceId: `device-${index}`,
      })));

      const events = await readAuditEvents(dataDir, { limit: 20 });
      assert.equal(events.length, 10);
      assert.equal(new Set(events.map((event) => event.requestId)).size, 10);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('audit log API', () => {
  it('records auth.denied when bearer auth is configured and a request is rejected', async () => {
    const fixture = await createAuditServer({ authToken: 'audit-token' });
    try {
      const denied = await postJSON(fixture.base, '/api/heartbeat', '', { deviceId: 'blocked-device' });
      assert.equal(denied.status, 401);

      const res = await getJSON(fixture.base, '/api/audit-log', 'audit-token');
      assert.equal(res.status, 200);
      const body = await res.json();

      assert.equal(body.events.length, 1);
      assert.equal(body.events[0].type, 'auth.denied');
      assert.equal(body.events[0].method, 'POST');
      assert.equal(body.events[0].path, '/api/heartbeat');
      assert.equal(body.events[0].statusCode, 401);
      assert.equal(body.events[0].outcome, 'denied');
      assert.match(body.events[0].requestId, /^[a-f0-9-]{36}$/i);
    } finally {
      await cleanupAuditServer(fixture);
    }
  });

  it('does not create auth.denied events when bearer auth is disabled', async () => {
    const fixture = await createAuditServer();
    try {
      const res = await getJSON(fixture.base, '/api/devices');
      assert.equal(res.status, 200);

      const audit = await getJSON(fixture.base, '/api/audit-log');
      assert.equal(audit.status, 200);
      const body = await audit.json();
      assert.equal(body.events.some((event) => event.type === 'auth.denied'), false);
    } finally {
      await cleanupAuditServer(fixture);
    }
  });

  it('records backup success without storing sourcePath or bearer token', async () => {
    const fixture = await createAuditServer({ authToken: 'audit-token' });
    try {
      const sourceDir = join(fixture.dataDir, 'source');
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, 'important.txt'), 'audit backup content');

      const backup = await postJSON(fixture.base, '/api/backups', 'audit-token', {
        deviceId: 'audit-device',
        sourcePath: sourceDir,
      });
      assert.equal(backup.status, 201);

      const audit = await getJSON(fixture.base, '/api/audit-log?limit=10', 'audit-token');
      assert.equal(audit.status, 200);
      const body = await audit.json();
      const event = body.events.find((entry) => entry.type === 'api.backup.created');

      assert.ok(event);
      assert.equal(event.statusCode, 201);
      assert.equal(event.deviceId, 'audit-device');
      assert.equal(event.fileCount, 1);
      assert.doesNotMatch(JSON.stringify(event), /sourcePath|audit-token|important\.txt|source/);
    } finally {
      await cleanupAuditServer(fixture);
    }
  });

  it('records restore success and restore failure without storing targetPath', async () => {
    const restoreRoot = await mkdtemp(join(tmpdir(), 'linke-audit-restore-root-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'linke-audit-outside-'));
    const fixture = await createAuditServer({ authToken: 'audit-token', restoreRoot });
    try {
      const sourceDir = join(fixture.dataDir, 'restore-source');
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, 'important.txt'), 'audit restore content');

      const backup = await postJSON(fixture.base, '/api/backups', 'audit-token', {
        deviceId: 'audit-restore-device',
        sourcePath: sourceDir,
      });
      assert.equal(backup.status, 201);
      const snapshot = await backup.json();

      const restore = await postJSON(fixture.base, '/api/restore', 'audit-token', {
        deviceId: 'audit-restore-device',
        snapshotId: snapshot.snapshotId,
        targetPath: 'allowed-target',
      });
      assert.equal(restore.status, 200);

      await mkdir(join(restoreRoot, 'blocked-target'), { recursive: true });
      await symlink(outsideRoot, join(restoreRoot, 'blocked-target', 'important.txt'), 'file');
      const blockedRestore = await postJSON(fixture.base, '/api/restore', 'audit-token', {
        deviceId: 'audit-restore-device',
        snapshotId: snapshot.snapshotId,
        targetPath: 'blocked-target',
      });
      assert.equal(blockedRestore.status, 400);
      assert.equal(await pathExists(join(outsideRoot, 'important.txt')), false);

      const audit = await getJSON(fixture.base, '/api/audit-log?limit=10', 'audit-token');
      assert.equal(audit.status, 200);
      const body = await audit.json();
      const success = body.events.find((entry) => entry.type === 'api.restore.completed');
      const failure = body.events.find((entry) => entry.type === 'api.restore.failure');

      assert.ok(success);
      assert.equal(success.statusCode, 200);
      assert.equal(success.deviceId, 'audit-restore-device');
      assert.equal(success.snapshotId, snapshot.snapshotId);
      assert.ok(failure);
      assert.equal(failure.statusCode, 400);
      assert.equal(failure.outcome, 'failure');
      assert.doesNotMatch(JSON.stringify(body.events), /targetPath|allowed-target|blocked-target|outside/);
    } finally {
      await cleanupAuditServer(fixture);
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
