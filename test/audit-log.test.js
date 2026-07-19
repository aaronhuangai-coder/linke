import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  appendAuditEvent,
  normalizeAuditRetention,
  parseAuditRetentionMaxEvents,
  readAuditEvents,
  sanitizeAuditEvent,
} from '../src/audit-log.js';
import {
  computeAuditIntegrityEventPayloadDigest,
  stringifyStrictCanonicalSanitizedEvent,
} from '../src/audit-event-schema.js';
import { ERROR_CODES } from '../src/error-codes.js';
import { createServer } from '../src/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

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
    auditRetention: options.auditRetention,
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
        targetName: 'primary-nas',
        attemptId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        errorCode: 'smb-execution-blocked',
        totalBytes: 12,
        verifiedFileCount: 2,
        retryCount: 0,
        wouldWrite: false,
        executionRequired: true,
        Authorization: 'Bearer leaked',
        sourcePath: '/private/tmp/source-secret',
        targetPath: '/private/tmp/target-secret',
        endpoint: 'http://admin:secret@nas.local',
        token: 'token-secret',
        password: 'password-secret',
        apiKey: 'api-key-secret',
        ownerToken: 'owner-token-secret',
        mountPath: '/Volumes/secret-mount',
      },
      new Date('2026-07-06T12:00:00.000Z'),
    );

    assert.deepEqual(Object.keys(event).sort(), [
      'attemptId',
      'createdAt',
      'deviceId',
      'errorCode',
      'executionRequired',
      'fileCount',
      'id',
      'message',
      'method',
      'outcome',
      'path',
      'requestId',
      'retryCount',
      'snapshotId',
      'statusCode',
      'targetName',
      'totalBytes',
      'type',
      'verifiedFileCount',
      'wouldWrite',
    ].sort());
    assert.equal(event.createdAt, '2026-07-06T12:00:00.000Z');
    assert.match(event.id, /^[a-f0-9-]{36}$/i);
    assert.equal(event.targetName, 'primary-nas');
    assert.equal(event.attemptId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    assert.equal(event.errorCode, 'smb-execution-blocked');
    assert.equal(event.totalBytes, 12);
    assert.equal(event.verifiedFileCount, 2);
    assert.equal(event.retryCount, 0);
    assert.equal(event.wouldWrite, false);
    assert.equal(event.executionRequired, true);
    assert.doesNotMatch(JSON.stringify(event), /Bearer|private\/tmp|admin:secret|token-secret|password-secret|api-key-secret|owner-token|secret-mount/);
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

      // Default limit 50 / max clamp 100; bad lines ignored.
      await writeFile(
        join(dataDir, 'audit', 'events.jsonl'),
        `${await readFile(join(dataDir, 'audit', 'events.jsonl'), 'utf8')}not-json-line\n{"type":"ok","id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","createdAt":"2026-07-06T12:02:00.000Z"}\n`,
      );
      // After dual-write, events may be strict-only; rewrite controlled fixture for read path.
      await writeFile(
        join(dataDir, 'audit', 'events.jsonl'),
        [
          '{"type":"a","id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","createdAt":"2026-07-06T12:00:00.000Z"}',
          'not-json-line',
          '{"type":"b","id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","createdAt":"2026-07-06T12:01:00.000Z"}',
          '{"type":"c","id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","createdAt":"2026-07-06T12:02:00.000Z"}',
          '',
        ].join('\n') + '\n',
      );
      const defaulted = await readAuditEvents(dataDir);
      assert.equal(defaulted.length, 3);
      assert.deepEqual(defaulted.map((e) => e.type), ['c', 'b', 'a']);
      const clamped = await readAuditEvents(dataDir, { limit: 1000 });
      assert.equal(clamped.length, 3);
      const limited = await readAuditEvents(dataDir, { limit: 2 });
      assert.deepEqual(limited.map((e) => e.type), ['c', 'b']);
      assert.deepEqual(await readAuditEvents(dataDir, { limit: 0 }), defaulted);
      assert.deepEqual(await readAuditEvents(dataDir, { limit: -1 }), defaulted);
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

  it('parses audit retention configuration values', () => {
    assert.equal(parseAuditRetentionMaxEvents(undefined), null);
    assert.equal(parseAuditRetentionMaxEvents(null), null);
    assert.equal(parseAuditRetentionMaxEvents(''), null);
    assert.equal(parseAuditRetentionMaxEvents('0'), null);
    assert.deepEqual(parseAuditRetentionMaxEvents('3'), { maxEvents: 3 });

    assert.equal(normalizeAuditRetention(undefined), null);
    assert.equal(normalizeAuditRetention(null), null);
    assert.equal(normalizeAuditRetention(false), null);
    assert.equal(normalizeAuditRetention({ maxEvents: 0 }), null);
    assert.deepEqual(normalizeAuditRetention({ maxEvents: 2 }), { maxEvents: 2 });

    for (const value of ['-1', '1.5', 'abc']) {
      assert.throws(
        () => parseAuditRetentionMaxEvents(value),
        /LINKE_AUDIT_MAX_EVENTS must be a non-negative integer/,
      );
    }
  });

  it('keeps default append behavior unbounded when retention is disabled', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-audit-retention-disabled-'));
    try {
      for (let index = 0; index < 4; index++) {
        await appendAuditEvent(dataDir, {
          type: 'api.heartbeat.success',
          method: 'POST',
          path: '/api/heartbeat',
          statusCode: 200,
          outcome: 'success',
          requestId: `req-disabled-${index}`,
        });
      }

      const raw = await readFile(join(dataDir, 'audit', 'events.jsonl'), 'utf-8');
      assert.equal(raw.trim().split('\n').length, 4);
      assert.equal((await readAuditEvents(dataDir, { limit: 10 })).length, 4);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('retains only the newest audit events and keeps read order newest first', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-audit-retention-'));
    try {
      for (let index = 0; index < 5; index++) {
        await appendAuditEvent(dataDir, {
          type: 'api.heartbeat.success',
          method: 'POST',
          path: '/api/heartbeat',
          statusCode: 200,
          outcome: 'success',
          requestId: `req-retained-${index}`,
          createdAt: `2026-07-06T12:0${index}:00.000Z`,
        }, { retention: { maxEvents: 3 } });
      }

      const raw = await readFile(join(dataDir, 'audit', 'events.jsonl'), 'utf-8');
      const lines = raw.trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(lines.map((event) => event.requestId), [
        'req-retained-2',
        'req-retained-3',
        'req-retained-4',
      ]);

      const events = await readAuditEvents(dataDir, { limit: 10 });
      assert.deepEqual(events.map((event) => event.requestId), [
        'req-retained-4',
        'req-retained-3',
        'req-retained-2',
      ]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent retained appends without exceeding maxEvents', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-audit-retention-concurrent-'));
    try {
      await Promise.all(Array.from({ length: 10 }, (_, index) => appendAuditEvent(dataDir, {
        type: 'api.heartbeat.success',
        method: 'POST',
        path: '/api/heartbeat',
        statusCode: 200,
        outcome: 'success',
        requestId: `req-concurrent-retained-${index}`,
      }, { retention: { maxEvents: 4 } })));

      const events = await readAuditEvents(dataDir, { limit: 10 });
      assert.equal(events.length, 4);
      assert.equal(new Set(events.map((event) => event.requestId)).size, 4);
      for (const event of events) {
        assert.match(event.requestId, /^req-concurrent-retained-/);
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects audit directory and events final symlinks without mutating outside', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'linke-audit-symlink-out-'));
    try {
      const dataDir = await mkdtemp(join(tmpdir(), 'linke-audit-dir-symlink-'));
      try {
        await symlink(outside, join(dataDir, 'audit'), 'dir');
        await assert.rejects(
          () => appendAuditEvent(dataDir, {
            type: 'api.heartbeat.success',
            method: 'POST',
            path: '/api/heartbeat',
            statusCode: 200,
            outcome: 'success',
            requestId: 'req-audit-dir-symlink',
          }),
          (error) => {
            const text = `${error?.message || ''}\n${error?.stack || ''}`;
            assert.equal(text.includes(outside), false);
            assert.equal(text.includes(dataDir), false);
            assert.equal(text.includes('req-audit-dir-symlink'), false);
            return true;
          },
        );
        assert.equal((await readdir(outside)).includes('events.jsonl'), false);
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }

      const dataDirFile = await mkdtemp(join(tmpdir(), 'linke-audit-file-symlink-'));
      try {
        await mkdir(join(dataDirFile, 'audit'));
        const outsideEvents = join(outside, 'events.jsonl');
        await writeFile(outsideEvents, 'OUTSIDE-AUDIT\n');
        await symlink(outsideEvents, join(dataDirFile, 'audit', 'events.jsonl'), 'file');
        await assert.rejects(
          () => appendAuditEvent(dataDirFile, {
            type: 'api.heartbeat.success',
            method: 'POST',
            path: '/api/heartbeat',
            statusCode: 200,
            outcome: 'success',
            requestId: 'req-audit-file-symlink',
          }),
          (error) => {
            const text = `${error?.message || ''}\n${error?.stack || ''}`;
            assert.equal(text.includes(outside), false);
            assert.equal(text.includes('OUTSIDE-AUDIT'), false);
            return true;
          },
        );
        assert.equal(await readFile(outsideEvents, 'utf8'), 'OUTSIDE-AUDIT\n');
        await assert.rejects(
          () => readAuditEvents(dataDirFile),
          (error) => {
            const text = `${error?.message || ''}\n${error?.stack || ''}`;
            assert.equal(text.includes(outside), false);
            return true;
          },
        );
      } finally {
        await rm(dataDirFile, { recursive: true, force: true });
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects atomic-final-image retention over events symlink without mutating outside', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'linke-audit-compact-out-'));
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-audit-compact-symlink-'));
    try {
      await mkdir(join(dataDir, 'audit'));
      const outsideEvents = join(outside, 'events-compact.jsonl');
      await writeFile(outsideEvents, 'OUTSIDE-COMPACT\n');
      // Seed real dual-write stores, then swap events final leaf to symlink (atomic final-image path).
      for (let index = 0; index < 3; index++) {
        await appendAuditEvent(dataDir, {
          type: 'api.heartbeat.success',
          method: 'POST',
          path: '/api/heartbeat',
          statusCode: 200,
          outcome: 'success',
          requestId: `req-seed-${index}`,
        }, { retention: { maxEvents: 10 } });
      }
      await rm(join(dataDir, 'audit', 'events.jsonl'));
      await symlink(outsideEvents, join(dataDir, 'audit', 'events.jsonl'), 'file');
      let rejected = null;
      try {
        await appendAuditEvent(dataDir, {
          type: 'api.heartbeat.success',
          method: 'POST',
          path: '/api/heartbeat',
          statusCode: 200,
          outcome: 'success',
          requestId: 'req-compact-symlink',
        }, { retention: { maxEvents: 2 } });
      } catch (error) {
        rejected = error;
      }
      assert.ok(rejected, 'append over final symlink must reject');
      // Dual-write maps Safe leaf failures to typed dual-write IO (or raw SafeDataFileError).
      assert.equal(rejected.message, rejected.code);
      assert.ok(
        rejected.code === 'safe-data-file-error'
          || rejected.code === 'audit-integrity-dual-write-io-error'
          || rejected.code === 'audit-integrity-dual-write-cursor-mismatch'
          || rejected.code === 'audit-integrity-cross-store-io-error',
        `unexpected error code: ${rejected.code}`,
      );
      const text = `${rejected?.message || ''}\n${rejected?.stack || ''}`;
      assert.equal(text.includes('OUTSIDE-COMPACT'), false);
      assert.equal(text.includes(outside), false);
      assert.equal(text.includes(dataDir), false);
      assert.equal(await readFile(outsideEvents, 'utf8'), 'OUTSIDE-COMPACT\n');
      assert.equal((await lstat(join(dataDir, 'audit', 'events.jsonl'))).isSymbolicLink(), true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('writes audit events as mode 0600 regular files', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-audit-mode-'));
    try {
      await appendAuditEvent(dataDir, {
        type: 'api.heartbeat.success',
        method: 'POST',
        path: '/api/heartbeat',
        statusCode: 200,
        outcome: 'success',
        requestId: 'req-mode',
      });
      const st = await lstat(join(dataDir, 'audit', 'events.jsonl'));
      assert.equal(st.isSymbolicLink(), false);
      assert.equal(st.isFile(), true);
      assert.equal(st.mode & 0o777, 0o600);
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

  it('applies audit retention to server-generated audit events', async () => {
    const fixture = await createAuditServer({
      authToken: 'audit-token',
      auditRetention: { maxEvents: 2 },
    });
    try {
      for (let index = 0; index < 3; index++) {
        const res = await postJSON(fixture.base, '/api/heartbeat', 'audit-token', {
          deviceId: `retained-server-device-${index}`,
        });
        assert.equal(res.status, 200);
      }

      const audit = await getJSON(fixture.base, '/api/audit-log?limit=10', 'audit-token');
      assert.equal(audit.status, 200);
      const body = await audit.json();
      assert.deepEqual(body.events.map((event) => event.deviceId), [
        'retained-server-device-2',
        'retained-server-device-1',
      ]);
      assert.doesNotMatch(JSON.stringify(body.events), /audit-token|Authorization|Bearer/);
    } finally {
      await cleanupAuditServer(fixture);
    }
  });

  it('treats server auditRetention maxEvents 0 as disabled', async () => {
    const fixture = await createAuditServer({
      authToken: 'audit-token',
      auditRetention: { maxEvents: 0 },
    });
    try {
      for (let index = 0; index < 3; index++) {
        const res = await postJSON(fixture.base, '/api/heartbeat', 'audit-token', {
          deviceId: `unbounded-server-device-${index}`,
        });
        assert.equal(res.status, 200);
      }

      const audit = await getJSON(fixture.base, '/api/audit-log?limit=10', 'audit-token');
      assert.equal(audit.status, 200);
      const body = await audit.json();
      assert.equal(body.events.length, 3);
      assert.deepEqual(body.events.map((event) => event.deviceId), [
        'unbounded-server-device-2',
        'unbounded-server-device-1',
        'unbounded-server-device-0',
      ]);
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

// ── V1.37 C5: production appendAuditEvent exact-one dual-write wiring ──────

const C5_GENERATION_ID = '0123456789abcdef0123456789abcdef';
const C5_DOMAIN_OPEN = 'linke.audit-integrity-journal.v1.generation-open\u0000';
const C5_DOMAIN_EVENT = 'linke.audit-integrity-journal.v1.event-link\u0000';
const C5_EXTENDED_DATE = '+275760-09-13T00:00:00.000Z';
const C5_STR_FIELDS = Object.freeze([
  'type', 'method', 'path', 'outcome', 'requestId', 'deviceId', 'snapshotId',
  'operation', 'message', 'targetName', 'attemptId', 'errorCode',
]);

/**
 * Strip block/line comments so static exact-one scans cannot be fooled by comment text.
 * Full AST is C6; this is a C5 honesty floor for source matches.
 */
function c5StripJsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

function c5EventsAbs(root) {
  return join(root, 'audit', 'events.jsonl');
}
function c5JournalAbs(root) {
  return join(root, 'audit', 'integrity-journal.jsonl');
}
function c5StateAbs(root) {
  return join(root, 'audit', 'integrity-dual-write-state.json');
}

function c5Sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function c5EventLine(event) {
  return `${stringifyStrictCanonicalSanitizedEvent(event)}\n`;
}

/** Schema max-line canary (NUL fill + extended date + ±MAX ints) — independent of production. */
function c5BuildMaxEvent(fill) {
  const o = {
    id: fill,
    createdAt: C5_EXTENDED_DATE,
    statusCode: -Number.MAX_VALUE,
    fileCount: Number.MAX_VALUE,
    totalBytes: Number.MAX_VALUE,
    verifiedFileCount: Number.MAX_VALUE,
    retryCount: Number.MAX_VALUE,
    wouldWrite: true,
    executionRequired: true,
  };
  for (const k of C5_STR_FIELDS) o[k] = fill;
  return o;
}

function c5BaseEvent(suffix = '1') {
  return {
    id: `11111111-1111-4111-8111-${String(suffix).padStart(12, '0')}`,
    createdAt: '2026-07-19T00:00:00.000Z',
    type: 'api.c5',
    method: 'POST',
    path: '/api/c5',
    outcome: 'success',
    requestId: `req-c5-${suffix}`,
  };
}

async function c5WithTemp(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `linke-c5-${prefix}-`));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function c5ReadState(root) {
  const raw = await readFile(c5StateAbs(root), 'utf8');
  return JSON.parse(raw);
}

async function c5PathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function c5AssertPathFreeError(error, rootHint) {
  assert.equal(error.message, error.code);
  if (rootHint) {
    assert.equal(String(error.message).includes(rootHint), false);
    assert.equal(String(error.stack || '').includes(rootHint), false);
  }
  assert.equal(String(error.message).includes('/tmp/'), false);
  assert.equal(String(error.message).includes('Users/'), false);
  assert.equal(String(error.message).includes('events.jsonl'), false);
  return true;
}

/**
 * Independent 4096-line journal fixture (open + 4095 event-links) with matching events.
 * Does NOT import production journal link helpers; rebuilds digests for fixture only.
 */
async function c5WriteJournal4096Fixture(root) {
  const gen = C5_GENERATION_ID;
  const openLink = createHash('sha256')
    .update(C5_DOMAIN_OPEN + gen + '\u0000' + '0' + '\u0000' + 'null' + '\u0000' + 'null')
    .digest('hex');
  const lines = [
    JSON.stringify({
      schemaVersion: 1,
      recordKind: 'generation-open',
      generationId: gen,
      sequence: 0,
      previousLinkDigest: null,
      payloadDigest: null,
      linkDigest: openLink,
    }),
  ];
  const eventLines = [];
  let prev = openLink;
  for (let i = 1; i <= 4095; i += 1) {
    const ev = {
      id: `aaaaaaaa-bbbb-4ccc-8ddd-${String(i).padStart(12, '0')}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(),
      type: 'api.bulk',
      outcome: 'success',
      message: `b${i}`,
    };
    const lineBody = stringifyStrictCanonicalSanitizedEvent(ev);
    const dig = computeAuditIntegrityEventPayloadDigest(ev);
    const link = createHash('sha256')
      .update(C5_DOMAIN_EVENT + gen + '\u0000' + String(i) + '\u0000' + prev + '\u0000' + dig)
      .digest('hex');
    lines.push(JSON.stringify({
      schemaVersion: 1,
      recordKind: 'event-link',
      generationId: gen,
      sequence: i,
      previousLinkDigest: prev,
      payloadDigest: dig,
      linkDigest: link,
    }));
    eventLines.push(`${lineBody}\n`);
    prev = link;
  }
  assert.equal(lines.length, 4096);
  await mkdir(join(root, 'audit'), { recursive: true });
  await writeFile(c5JournalAbs(root), `${lines.join('\n')}\n`, { mode: 0o600 });
  await writeFile(c5EventsAbs(root), eventLines.join(''), { mode: 0o600 });
}

describe('C5 production appendAuditEvent exact-one dual-write wiring', () => {
  it('C5-01 cold append: events+journal+state exist, cross-store equal, state idle', async () => {
    await c5WithTemp('cold', async (root) => {
      const out = await appendAuditEvent(root, c5BaseEvent('01'));
      assert.equal(out.type, 'api.c5');
      assert.equal(await c5PathExists(c5EventsAbs(root)), true);
      assert.equal(await c5PathExists(c5JournalAbs(root)), true);
      assert.equal(await c5PathExists(c5StateAbs(root)), true);

      const state = await c5ReadState(root);
      assert.equal(state.status, 'idle');
      assert.equal(state.journal.recordCount, 2);
      assert.equal(state.events.strictRecordCount, 1);
      assert.equal(state.events.present, true);

      const eventsRaw = await readFile(c5EventsAbs(root));
      const journalRaw = await readFile(c5JournalAbs(root));
      assert.equal(state.events.sha256, c5Sha256(eventsRaw));
      assert.equal(state.events.byteLength, eventsRaw.length);
      assert.equal(state.journal.rawSha256, c5Sha256(journalRaw));
      assert.equal(state.journal.rawByteLength, journalRaw.length);

      const { verifyAuditIntegrityAgainstEventStore } = await import('../src/audit-integrity-cross-store.js');
      const cross = await verifyAuditIntegrityAgainstEventStore(root);
      assert.equal(cross.state, 'verified');
      assert.equal(cross.relationship, 'equal');
    });
  });

  it('C5-02 return sanitized matches sanitizeAuditEvent; id/createdAt stable under double sanitize', async () => {
    await c5WithTemp('ret', async (root) => {
      const input = {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        createdAt: '2026-07-19T12:34:56.000Z',
        type: 'api.c5-stable',
        method: 'GET',
        path: '/stable',
        outcome: 'success',
        Authorization: 'Bearer leaked',
        token: 'secret-token',
      };
      const expected = sanitizeAuditEvent(input);
      const out = await appendAuditEvent(root, input);
      assert.equal(out.id, expected.id);
      assert.equal(out.createdAt, expected.createdAt);
      assert.equal(out.type, expected.type);
      assert.equal(out.method, expected.method);
      assert.equal(out.path, expected.path);
      assert.equal(out.outcome, expected.outcome);
      assert.equal(Object.hasOwn(out, 'Authorization'), false);
      assert.equal(Object.hasOwn(out, 'token'), false);
      // Second sanitize of returned object must not invent new id/createdAt.
      const again = sanitizeAuditEvent(out);
      assert.equal(again.id, out.id);
      assert.equal(again.createdAt, out.createdAt);
      const disk = JSON.parse((await readFile(c5EventsAbs(root), 'utf8')).trim().split('\n').pop());
      assert.equal(disk.id, out.id);
      assert.equal(disk.createdAt, out.createdAt);
    });
  });

  it('C5-03 retention disabled multi-append does not compact; journal grows 1+N', async () => {
    await c5WithTemp('ret-off', async (root) => {
      const N = 5;
      for (let i = 0; i < N; i += 1) {
        await appendAuditEvent(root, {
          ...c5BaseEvent(String(i)),
          requestId: `req-off-${i}`,
        });
      }
      const raw = await readFile(c5EventsAbs(root), 'utf8');
      const lines = raw.trim().split('\n');
      assert.equal(lines.length, N);
      const state = await c5ReadState(root);
      assert.equal(state.status, 'idle');
      assert.equal(state.events.strictRecordCount, N);
      assert.equal(state.journal.recordCount, 1 + N);
      assert.equal((await readAuditEvents(root, { limit: 10 })).length, N);
    });
  });

  it('C5-04 maxEvents=3: events suffix 3, journal grows 1+N, state fingerprints match final image', async () => {
    await c5WithTemp('ret-3', async (root) => {
      const N = 5;
      for (let i = 0; i < N; i += 1) {
        await appendAuditEvent(root, {
          type: 'api.heartbeat.success',
          method: 'POST',
          path: '/api/heartbeat',
          statusCode: 200,
          outcome: 'success',
          requestId: `req-retained-${i}`,
          createdAt: `2026-07-06T12:0${i}:00.000Z`,
          id: `cccccccc-cccc-4ccc-8ccc-${String(i).padStart(12, '0')}`,
        }, { retention: { maxEvents: 3 } });
      }
      const raw = await readFile(c5EventsAbs(root), 'utf8');
      const lines = raw.trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(lines.length, 3);
      assert.deepEqual(lines.map((e) => e.requestId), [
        'req-retained-2',
        'req-retained-3',
        'req-retained-4',
      ]);
      const state = await c5ReadState(root);
      assert.equal(state.status, 'idle');
      assert.equal(state.events.strictRecordCount, 3);
      assert.equal(state.journal.recordCount, 1 + N);
      const eventsBuf = await readFile(c5EventsAbs(root));
      const journalBuf = await readFile(c5JournalAbs(root));
      assert.equal(state.events.sha256, c5Sha256(eventsBuf));
      assert.equal(state.events.byteLength, eventsBuf.length);
      assert.equal(state.journal.rawSha256, c5Sha256(journalBuf));
      assert.equal(state.journal.rawByteLength, journalBuf.length);
    });
  });

  it('C5-05 retention concurrent serialize: events ≤ maxEvents and unique', async () => {
    await c5WithTemp('ret-conc', async (root) => {
      await Promise.all(Array.from({ length: 12 }, (_, index) => appendAuditEvent(root, {
        type: 'api.heartbeat.success',
        method: 'POST',
        path: '/api/heartbeat',
        statusCode: 200,
        outcome: 'success',
        requestId: `req-concurrent-retained-${index}`,
        id: `dddddddd-dddd-4ddd-8ddd-${String(index).padStart(12, '0')}`,
        createdAt: `2026-07-19T00:00:${String(index).padStart(2, '0')}.000Z`,
      }, { retention: { maxEvents: 4 } })));

      const rawLines = (await readFile(c5EventsAbs(root), 'utf8')).trim().split('\n');
      assert.equal(rawLines.length, 4);
      const events = await readAuditEvents(root, { limit: 10 });
      assert.equal(events.length, 4);
      assert.equal(new Set(events.map((e) => e.requestId)).size, 4);
      const state = await c5ReadState(root);
      assert.equal(state.events.strictRecordCount, 4);
      assert.equal(state.journal.recordCount, 1 + 12);
    });
  });

  it('C5-06 same-root 50 concurrent via production appendAuditEvent; journal/events/state consistent', async () => {
    await c5WithTemp('conc50', async (root) => {
      const N = 50;
      const inputs = Array.from({ length: N }, (_, i) => ({
        id: `aaaaaaaa-bbbb-4ccc-8ddd-${String(i).padStart(12, '0')}`,
        createdAt: `2026-07-19T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
        type: 'api.conc',
        outcome: 'success',
        message: `n${i}`,
      }));
      await Promise.all(inputs.map((ev) => appendAuditEvent(root, ev)));

      const lines = (await readFile(c5EventsAbs(root), 'utf8')).split('\n').filter(Boolean);
      assert.equal(lines.length, N);
      const state = await c5ReadState(root);
      assert.equal(state.status, 'idle');
      assert.equal(state.events.strictRecordCount, N);
      assert.equal(state.journal.recordCount, 1 + N);
      assert.equal(state.events.sha256, c5Sha256(await readFile(c5EventsAbs(root))));
      assert.equal(state.journal.rawSha256, c5Sha256(await readFile(c5JournalAbs(root))));

      const { inspectAuditIntegrityJournalFile } = await import('../src/audit-integrity-journal.js');
      const snap = await inspectAuditIntegrityJournalFile(root);
      assert.equal(snap.payloadDigests.length, N);
      for (let i = 0; i < N; i += 1) {
        const dig = computeAuditIntegrityEventPayloadDigest(JSON.parse(lines[i]));
        assert.equal(dig, snap.payloadDigests[i]);
      }
      const { verifyAuditIntegrityAgainstEventStore } = await import('../src/audit-integrity-cross-store.js');
      const cross = await verifyAuditIntegrityAgainstEventStore(root);
      assert.equal(cross.state, 'verified');
      assert.equal(cross.relationship, 'equal');
    });
  });

  it('C5-07 legacy events (no journal/state) + new append → partial journal-suffix-of-events; idle; not equal', async () => {
    await c5WithTemp('legacy', async (root) => {
      const legacy = {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        createdAt: '2026-07-18T00:00:00.000Z',
        type: 'api.legacy',
        outcome: 'success',
      };
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(c5EventsAbs(root), c5EventLine(legacy), { mode: 0o600 });

      const neu = {
        id: '11111111-1111-4111-8111-111111111111',
        createdAt: '2026-07-19T00:00:00.000Z',
        type: 'api.new',
        outcome: 'success',
      };
      await appendAuditEvent(root, neu);

      const lines = (await readFile(c5EventsAbs(root), 'utf8')).split('\n').filter(Boolean);
      assert.equal(lines.length, 2);
      assert.equal(JSON.parse(lines[0]).type, 'api.legacy');
      assert.equal(JSON.parse(lines[1]).type, 'api.new');

      const state = await c5ReadState(root);
      assert.equal(state.status, 'idle');

      const { verifyAuditIntegrityAgainstEventStore } = await import('../src/audit-integrity-cross-store.js');
      const cross = await verifyAuditIntegrityAgainstEventStore(root);
      assert.equal(cross.state, 'partial');
      assert.equal(cross.relationship, 'journal-suffix-of-events');
      assert.notEqual(cross.relationship, 'equal');
    });
  });

  it('C5-08 readAuditEvents limit/clamp/bad-line ignore preserved (covered above + empty)', async () => {
    await c5WithTemp('read-empty', async (root) => {
      assert.deepEqual(await readAuditEvents(root), []);
      assert.deepEqual(await readAuditEvents(root, { limit: 10 }), []);
    });
  });

  it('C5-09 static exact-one dual-write import + runtime three-file call-chain proof', async () => {
    const src = await readFile(join(REPO_ROOT, 'src/audit-log.js'), 'utf8');
    const code = c5StripJsComments(src);
    const importMatches = code.match(/from\s+['"]\.\/audit-integrity-dual-write\.js['"]/g) || [];
    assert.equal(importMatches.length, 1, 'exact-one static import of dual-write coordinator');
    assert.ok(code.includes('appendAuditEventWithIntegrityDualWrite'));
    const callMatches = code.match(/appendAuditEventWithIntegrityDualWrite\s*\(/g) || [];
    assert.equal(callMatches.length, 1, 'exact-one call site');

    await c5WithTemp('chain', async (root) => {
      await appendAuditEvent(root, c5BaseEvent('chain'));
      // Runtime proof: coordinator path materializes all three integrity stores.
      assert.equal(await c5PathExists(c5EventsAbs(root)), true);
      assert.equal(await c5PathExists(c5JournalAbs(root)), true);
      assert.equal(await c5PathExists(c5StateAbs(root)), true);
      const state = await c5ReadState(root);
      assert.equal(state.status, 'idle');
      const { verifyAuditIntegrityAgainstEventStore } = await import('../src/audit-integrity-cross-store.js');
      const cross = await verifyAuditIntegrityAgainstEventStore(root);
      assert.equal(cross.state, 'verified');
      assert.equal(cross.relationship, 'equal');
    });
  });

  it('C5-10 audit-log does not import journal/cross-store/write-queue/unlocked; server/agent no new direct imports', async () => {
    const auditLog = await readFile(join(REPO_ROOT, 'src/audit-log.js'), 'utf8');
    for (const banned of [
      'audit-integrity-journal',
      'audit-integrity-cross-store',
      'audit-integrity-write-queue',
      'audit-integrity-dual-write-state',
      'Unlocked',
      'safeAppendText',
      'safeAtomicWriteText',
      'safeAtomicWriteBytes',
    ]) {
      assert.equal(auditLog.includes(banned), false, `audit-log must not contain ${banned}`);
    }

    for (const rel of ['src/server.js', 'src/agent.js']) {
      const full = await readFile(join(REPO_ROOT, rel), 'utf8');
      assert.equal(full.includes('audit-integrity-dual-write'), false, `${rel}: no dual-write`);
      assert.equal(full.includes('audit-integrity-journal'), false, `${rel}: no journal`);
      assert.equal(full.includes('audit-integrity-cross-store'), false, `${rel}: no cross-store`);
      assert.equal(full.includes('audit-integrity-write-queue'), false, `${rel}: no write-queue`);
      assert.ok(full.includes("from './audit-log.js'") || full.includes('from "./audit-log.js"'));
    }
  });

  it('C5-11 failures surface typed dual-write/Safe errors (not swallowed); cursor drift', async () => {
    await c5WithTemp('fail', async (root) => {
      await appendAuditEvent(root, c5BaseEvent('fail1'));
      const jBefore = await readFile(c5JournalAbs(root));
      const sBefore = await readFile(c5StateAbs(root));
      // Mutate events away from idle cursor → exact cursor-mismatch (not multi-code allowlist).
      await writeFile(c5EventsAbs(root), `${c5EventLine(c5BaseEvent('tamper'))}${c5EventLine(c5BaseEvent('extra'))}`, {
        mode: 0o600,
      });
      await assert.rejects(
        () => appendAuditEvent(root, c5BaseEvent('fail2')),
        (error) => {
          assert.equal(error.code, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH);
          assert.equal(error.message, error.code);
          c5AssertPathFreeError(error, root);
          return true;
        },
      );
      assert.deepEqual(await readFile(c5JournalAbs(root)), jBefore);
      assert.deepEqual(await readFile(c5StateAbs(root)), sBefore);
    });
  });

  it('C5-12 normalizeAuditRetention contract preserved', () => {
    assert.equal(normalizeAuditRetention(undefined), null);
    assert.equal(normalizeAuditRetention(null), null);
    assert.equal(normalizeAuditRetention(false), null);
    assert.equal(normalizeAuditRetention({ maxEvents: 0 }), null);
    assert.deepEqual(normalizeAuditRetention({ maxEvents: 2 }), { maxEvents: 2 });
    assert.throws(() => normalizeAuditRetention('x'), /auditRetention must be an object/);
    assert.throws(() => normalizeAuditRetention([]), /auditRetention must be an object/);
    assert.throws(() => normalizeAuditRetention({ maxEvents: -1 }), /non-negative integer/);
    assert.throws(() => normalizeAuditRetention({ maxEvents: 1.5 }), /non-negative integer/);
  });

  it('C5-13 parseAuditRetentionMaxEvents contract preserved', () => {
    assert.equal(parseAuditRetentionMaxEvents(undefined), null);
    assert.equal(parseAuditRetentionMaxEvents(null), null);
    assert.equal(parseAuditRetentionMaxEvents(''), null);
    assert.equal(parseAuditRetentionMaxEvents('0'), null);
    assert.deepEqual(parseAuditRetentionMaxEvents('3'), { maxEvents: 3 });
    for (const value of ['-1', '1.5', 'abc']) {
      assert.throws(
        () => parseAuditRetentionMaxEvents(value),
        /LINKE_AUDIT_MAX_EVENTS must be a non-negative integer/,
      );
    }
  });

  it('C5-14 root/audit/events symlink and dir squatting fail-closed; outside bytes unchanged; path/body-free', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'linke-c5-squat-out-'));
    try {
      // dataDir itself as symlink root
      const realRoot = await mkdtemp(join(tmpdir(), 'linke-c5-squat-real-'));
      const linkRoot = join(outside, 'data-link');
      await symlink(realRoot, linkRoot, 'dir');
      await assert.rejects(
        () => appendAuditEvent(linkRoot, c5BaseEvent('symroot')),
        (error) => {
          c5AssertPathFreeError(error, outside);
          assert.equal(String(error.stack || '').includes('req-c5'), false);
          return true;
        },
      );
      await rm(realRoot, { recursive: true, force: true });

      // audit/ as symlink
      const dataDir = await mkdtemp(join(tmpdir(), 'linke-c5-audit-sym-'));
      try {
        await symlink(outside, join(dataDir, 'audit'), 'dir');
        await assert.rejects(
          () => appendAuditEvent(dataDir, c5BaseEvent('auditsym')),
          (error) => {
            c5AssertPathFreeError(error, outside);
            return true;
          },
        );
        assert.equal((await readdir(outside)).includes('events.jsonl'), false);
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }

      // events.jsonl as directory squat
      const squat = await mkdtemp(join(tmpdir(), 'linke-c5-dir-squat-'));
      try {
        await mkdir(join(squat, 'audit', 'events.jsonl'), { recursive: true });
        await assert.rejects(
          () => appendAuditEvent(squat, c5BaseEvent('dirsquat')),
          (error) => {
            c5AssertPathFreeError(error, squat);
            return true;
          },
        );
      } finally {
        await rm(squat, { recursive: true, force: true });
      }

      // events leaf symlink
      const leaf = await mkdtemp(join(tmpdir(), 'linke-c5-leaf-sym-'));
      try {
        await mkdir(join(leaf, 'audit'));
        const outsideEvents = join(outside, 'events-leaf.jsonl');
        await writeFile(outsideEvents, 'OUTSIDE-LEAF\n');
        await symlink(outsideEvents, join(leaf, 'audit', 'events.jsonl'), 'file');
        await assert.rejects(
          () => appendAuditEvent(leaf, c5BaseEvent('leafsym')),
          (error) => {
            const text = `${error?.message || ''}\n${error?.stack || ''}`;
            assert.equal(text.includes('OUTSIDE-LEAF'), false);
            assert.equal(text.includes(outside), false);
            return true;
          },
        );
        assert.equal(await readFile(outsideEvents, 'utf8'), 'OUTSIDE-LEAF\n');
      } finally {
        await rm(leaf, { recursive: true, force: true });
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('C5-15 retention enabled: idle events/journal fingerprints exact-match final disk images', async () => {
    await c5WithTemp('fp', async (root) => {
      for (let i = 0; i < 4; i += 1) {
        await appendAuditEvent(root, {
          ...c5BaseEvent(String(10 + i)),
          requestId: `fp-${i}`,
          createdAt: `2026-07-19T01:00:0${i}.000Z`,
        }, { retention: { maxEvents: 2 } });
      }
      const state = await c5ReadState(root);
      assert.equal(state.status, 'idle');
      assert.equal(state.events.strictRecordCount, 2);
      const eBuf = await readFile(c5EventsAbs(root));
      const jBuf = await readFile(c5JournalAbs(root));
      assert.equal(state.events.sha256, c5Sha256(eBuf));
      assert.equal(state.events.byteLength, eBuf.length);
      assert.equal(state.journal.rawSha256, c5Sha256(jBuf));
      assert.equal(state.journal.rawByteLength, jBuf.length);
      assert.equal(eBuf.toString('utf8').trim().split('\n').length, 2);
    });
  });

  it('C5-16 real 4096 journal fixture via production append → 4097; next bounds; stores frozen', async () => {
    await c5WithTemp('j4096', async (root) => {
      await c5WriteJournal4096Fixture(root);
      // Fixture: journal4096 + matching events; state exact ENOENT.
      // First production append must bootstrap idle itself (no explicit recover import/call).
      assert.equal(await c5PathExists(c5StateAbs(root)), false);
      assert.equal(await c5PathExists(c5JournalAbs(root)), true);
      assert.equal(await c5PathExists(c5EventsAbs(root)), true);

      await appendAuditEvent(root, {
        id: '11111111-1111-4111-8111-111111111111',
        createdAt: '2026-07-19T00:00:00.000Z',
        type: 'api.test',
        method: 'POST',
        path: '/api/test',
        outcome: 'success',
      });
      const { inspectAuditIntegrityJournalFile } = await import('../src/audit-integrity-journal.js');
      assert.equal((await inspectAuditIntegrityJournalFile(root)).recordCount, 4097);
      const jBytes = await readFile(c5JournalAbs(root));
      const eBytes = await readFile(c5EventsAbs(root));
      const sBytes = await readFile(c5StateAbs(root));
      const idleAfterFirst = await c5ReadState(root);
      assert.equal(idleAfterFirst.status, 'idle');
      assert.equal(idleAfterFirst.journal.recordCount, 4097);

      await assert.rejects(
        () => appendAuditEvent(root, {
          id: '22222222-2222-4222-8222-222222222222',
          createdAt: '2026-07-19T00:00:01.000Z',
          type: 'api.test',
          method: 'GET',
          path: '/api/other',
          outcome: 'success',
        }),
        (e) => {
          assert.equal(e.code, ERROR_CODES.AUDIT_INTEGRITY_BOUNDS_EXCEEDED);
          c5AssertPathFreeError(e, root);
          return true;
        },
      );
      assert.deepEqual(await readFile(c5JournalAbs(root)), jBytes);
      assert.deepEqual(await readFile(c5EventsAbs(root)), eBytes);
      assert.deepEqual(await readFile(c5StateAbs(root)), sBytes);
      assert.equal((await c5ReadState(root)).status, 'idle');
      assert.equal((await c5ReadState(root)).journal.recordCount, 4097);
    });
  });

  it('C5-17 does not write capability-proof path/files', async () => {
    await c5WithTemp('cap', async (root) => {
      await appendAuditEvent(root, c5BaseEvent('cap'));
      const auditEntries = await readdir(join(root, 'audit'));
      assert.equal(auditEntries.includes('capability-proof-attempts.jsonl'), false);
      assert.equal(await c5PathExists(join(root, 'audit', 'capability-proof-attempts.jsonl')), false);
      for (const name of auditEntries) {
        assert.equal(name.includes('capability-proof'), false, name);
      }
    });
  });

  it('C5-18 existing security coverage retained (mode 0600 + symlink suite still green via above)', async () => {
    await c5WithTemp('mode', async (root) => {
      await appendAuditEvent(root, c5BaseEvent('mode'));
      const st = await lstat(c5EventsAbs(root));
      assert.equal(st.isSymbolicLink(), false);
      assert.equal(st.isFile(), true);
      assert.equal(st.mode & 0o777, 0o600);
      const jst = await lstat(c5JournalAbs(root));
      assert.equal(jst.isFile(), true);
      assert.equal(jst.mode & 0o777, 0o600);
    });
  });

  it('C5-19 static: no auditFileQueues / safeAppendText write path / retention-null fast-path; cold runtime', async () => {
    const src = await readFile(join(REPO_ROOT, 'src/audit-log.js'), 'utf8');
    assert.equal(src.includes('auditFileQueues'), false);
    assert.equal(src.includes('auditQueueKey'), false);
    assert.equal(src.includes('withAuditFileQueue'), false);
    assert.equal(src.includes('compactAuditFile'), false);
    assert.equal(src.includes('safeAppendText'), false);
    assert.equal(src.includes('safeAtomicWriteText'), false);
    assert.equal(src.includes('!retention && !'), false);
    assert.equal(src.includes('if (!retention'), false);

    await c5WithTemp('static-rt', async (root) => {
      await appendAuditEvent(root, c5BaseEvent('static'));
      // Cold append still creates dual-write triple — not a single-file fast path.
      assert.equal(await c5PathExists(c5EventsAbs(root)), true);
      assert.equal(await c5PathExists(c5JournalAbs(root)), true);
      assert.equal(await c5PathExists(c5StateAbs(root)), true);
      assert.equal((await c5ReadState(root)).status, 'idle');
    });
  });

  it('C5-20 first cold append uses shared queue/coordinator (three files + idle + cross-store)', async () => {
    await c5WithTemp('coldq', async (root) => {
      assert.equal(await c5PathExists(join(root, 'audit')), false);
      await appendAuditEvent(root, c5BaseEvent('coldq'));
      assert.equal(await c5PathExists(c5EventsAbs(root)), true);
      assert.equal(await c5PathExists(c5JournalAbs(root)), true);
      assert.equal(await c5PathExists(c5StateAbs(root)), true);
      const state = await c5ReadState(root);
      assert.equal(state.status, 'idle');
      assert.equal(state.journal.recordCount, 2);
      assert.equal(state.events.strictRecordCount, 1);
      const { verifyAuditIntegrityAgainstEventStore } = await import('../src/audit-integrity-cross-store.js');
      const cross = await verifyAuditIntegrityAgainstEventStore(root);
      assert.equal(cross.state, 'verified');
      assert.equal(cross.relationship, 'equal');
    });
  });

  it('C5-21 legal ~500-byte strict line via appendAuditEvent succeeds and consistent', async () => {
    await c5WithTemp('b500', async (root) => {
      const fill = 'm'.repeat(40);
      const ev = {
        id: '77777777-7777-4777-8777-777777777777',
        createdAt: '2026-07-19T00:00:00.000Z',
        type: 'api.big',
        method: fill,
        path: `/${fill}`,
        outcome: 'success',
        message: fill,
        targetName: fill,
        attemptId: fill,
        errorCode: fill,
        requestId: fill,
        deviceId: fill,
        snapshotId: fill,
        operation: fill,
      };
      const line = c5EventLine(ev);
      const lineBytes = Buffer.byteLength(line, 'utf8');
      assert.ok(lineBytes >= 500, `expected ≥500, got ${lineBytes}`);
      assert.ok(lineBytes <= 16050, `expected ≤16050, got ${lineBytes}`);
      await appendAuditEvent(root, ev);
      const onDisk = await readFile(c5EventsAbs(root), 'utf8');
      assert.equal(onDisk, line);
      assert.equal(Buffer.byteLength(onDisk, 'utf8'), lineBytes);
      const state = await c5ReadState(root);
      assert.equal(state.status, 'idle');
      const { verifyAuditIntegrityAgainstEventStore } = await import('../src/audit-integrity-cross-store.js');
      assert.equal((await verifyAuditIntegrityAgainstEventStore(root)).relationship, 'equal');
    });
  });

  it('C5-22 max legal body 16050 via public append; on-disk 16051 hostile baselines (no legal public >16050)', async () => {
    // Honesty: sanitize clamps strings to 200; schema max canary strict body is exactly 16050.
    // No legal public appendAuditEvent input can produce body 16051. 16051 is on-disk hostile baseline only.
    // No Buffer.byteLength monkeypatch — that is not a public-input path.
    const nul = '\u0000'.repeat(200);
    const maxEv = c5BuildMaxEvent(nul);
    const body = stringifyStrictCanonicalSanitizedEvent(maxEv);
    assert.equal(Buffer.byteLength(body, 'utf8'), 16050, 'independent construction: max legal body === 16050');
    const overBody = `${body}x`;
    assert.equal(Buffer.byteLength(overBody, 'utf8'), 16051, 'hostile overBody is body+x (on-disk only)');

    // (1) Max legal body via production append: disk body 16050, idle, cross equal.
    await c5WithTemp('16050', async (root) => {
      await appendAuditEvent(root, maxEv);
      const onDisk = await readFile(c5EventsAbs(root), 'utf8');
      const diskBody = onDisk.endsWith('\n') ? onDisk.slice(0, -1) : onDisk;
      assert.equal(Buffer.byteLength(diskBody, 'utf8'), 16050);
      assert.equal(diskBody, body);
      assert.equal((await c5ReadState(root)).status, 'idle');
      const { verifyAuditIntegrityAgainstEventStore } = await import('../src/audit-integrity-cross-store.js');
      assert.equal((await verifyAuditIntegrityAgainstEventStore(root)).relationship, 'equal');
    });

    // (2) Uninitialized root: pre-seed on-disk hostile 16051 events only; bootstrap cross-store bounds.
    // journal/state not created; events exact bytes frozen. Reachable 16051 cross-store bounds layer.
    await c5WithTemp('16051-empty', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(c5EventsAbs(root), `${overBody}\n`, { mode: 0o600 });
      const eBefore = await readFile(c5EventsAbs(root));
      assert.equal(Buffer.byteLength(overBody, 'utf8'), 16051);
      await assert.rejects(
        () => appendAuditEvent(root, c5BaseEvent('over')),
        (e) => {
          assert.equal(e.code, ERROR_CODES.AUDIT_INTEGRITY_CROSS_STORE_BOUNDS_EXCEEDED);
          c5AssertPathFreeError(e, root);
          return true;
        },
      );
      assert.equal(await c5PathExists(c5JournalAbs(root)), false);
      assert.equal(await c5PathExists(c5StateAbs(root)), false);
      assert.deepEqual(await readFile(c5EventsAbs(root)), eBefore);
    });

    // (3) Healthy idle root: external tamper events → 16051; next production append is
    // idle-cursor fail-closed (CURSOR_MISMATCH), not a false claim of cross-store bounds.
    await c5WithTemp('16051-idle', async (root) => {
      await appendAuditEvent(root, c5BaseEvent('idle-base'));
      const jBytes = await readFile(c5JournalAbs(root));
      const sBytes = await readFile(c5StateAbs(root));
      assert.equal((await c5ReadState(root)).status, 'idle');
      await writeFile(c5EventsAbs(root), `${overBody}\n`, { mode: 0o600 });
      const eHostile = await readFile(c5EventsAbs(root));
      assert.equal(Buffer.byteLength(overBody, 'utf8'), 16051);
      await assert.rejects(
        () => appendAuditEvent(root, c5BaseEvent('idle-over')),
        (e) => {
          assert.equal(e.code, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_CURSOR_MISMATCH);
          c5AssertPathFreeError(e, root);
          return true;
        },
      );
      assert.deepEqual(await readFile(c5JournalAbs(root)), jBytes);
      assert.deepEqual(await readFile(c5StateAbs(root)), sBytes);
      assert.deepEqual(await readFile(c5EventsAbs(root)), eHostile);
      assert.equal((await c5ReadState(root)).status, 'idle');
    });
  });

  it('C5-23 hostile options getter/TOCTOU: retention snapshotted once; DUAL_WRITE_TEST_* not forwarded', async () => {
    await c5WithTemp('hostile-opt', async (root) => {
      const { DUAL_WRITE_TEST_CRASH_HOOK } = await import('../src/audit-integrity-dual-write.js');

      // Within a single call: retention getter must be read only once (call-time snapshot).
      let retentionReads = 0;
      await appendAuditEvent(root, c5BaseEvent('h0'), {
        get retention() {
          retentionReads += 1;
          if (retentionReads > 1) {
            throw new Error('retention getter re-entered after production snapshot');
          }
          return { maxEvents: 2 };
        },
        [DUAL_WRITE_TEST_CRASH_HOOK]: 'after-prepared',
        crashHook: 'after-prepared',
        extra: { evil: true },
      });
      assert.equal(retentionReads, 1);
      assert.equal((await c5ReadState(root)).status, 'idle', 'Symbol crash hook must not be forwarded');

      // maxEvents accessor TOCTOU: normalize reads once; second value would be invalid.
      let maxReads = 0;
      await appendAuditEvent(root, c5BaseEvent('h1'), {
        retention: {
          get maxEvents() {
            maxReads += 1;
            return maxReads === 1 ? 2 : -1;
          },
        },
        [DUAL_WRITE_TEST_CRASH_HOOK]: 'after-prepared',
      });
      assert.equal(maxReads, 1);

      // Plain retention + crash Symbol across multi-append: retention applies; no prepared left.
      for (let i = 0; i < 3; i += 1) {
        await appendAuditEvent(root, c5BaseEvent(`h${i + 2}`), {
          retention: { maxEvents: 2 },
          [DUAL_WRITE_TEST_CRASH_HOOK]: 'after-prepared',
        });
      }
      const lines = (await readFile(c5EventsAbs(root), 'utf8')).trim().split('\n');
      assert.equal(lines.length, 2);
      assert.equal((await c5ReadState(root)).status, 'idle');
      assert.equal((await c5ReadState(root)).events.strictRecordCount, 2);
    });
  });

  it('C5-24 production wrapper calls coordinator exactly once; no nested enqueue error on concurrent', async () => {
    const src = await readFile(join(REPO_ROOT, 'src/audit-log.js'), 'utf8');
    const code = c5StripJsComments(src);
    assert.equal((code.match(/appendAuditEventWithIntegrityDualWrite\s*\(/g) || []).length, 1);
    // Nested enqueue would throw if wrapper re-entered coordinator under same lease.
    await c5WithTemp('once', async (root) => {
      await Promise.all([
        appendAuditEvent(root, c5BaseEvent('o1')),
        appendAuditEvent(root, c5BaseEvent('o2')),
        appendAuditEvent(root, c5BaseEvent('o3')),
      ]);
      assert.equal((await readFile(c5EventsAbs(root), 'utf8')).trim().split('\n').length, 3);
      assert.equal((await c5PathExists(c5EventsAbs(root))), true);
      assert.equal(await c5PathExists(c5JournalAbs(root)), true);
      assert.equal(await c5PathExists(c5StateAbs(root)), true);
      assert.equal((await c5ReadState(root)).status, 'idle');
    });
  });

  it('C5-25 direct journal gate still blocks after state exists (audit-log wiring does not bypass)', async () => {
    await c5WithTemp('gate', async (root) => {
      await appendAuditEvent(root, c5BaseEvent('gate'));
      assert.equal(await c5PathExists(c5StateAbs(root)), true);
      const {
        appendAuditIntegrityEvent,
        initializeAuditIntegrityJournal,
      } = await import('../src/audit-integrity-journal.js');
      await assert.rejects(
        () => appendAuditIntegrityEvent(root, {
          generationId: C5_GENERATION_ID,
          event: c5BaseEvent('direct'),
        }),
        (e) => {
          assert.equal(e.code, ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_DIRECT_MUTATION_BLOCKED);
          c5AssertPathFreeError(e, root);
          return true;
        },
      );
      await assert.rejects(
        () => initializeAuditIntegrityJournal(root, { generationId: C5_GENERATION_ID }),
        (e) => {
          assert.ok(
            e.code === ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_DIRECT_MUTATION_BLOCKED
              || e.code === ERROR_CODES.AUDIT_INTEGRITY_ALREADY_INITIALIZED,
          );
          return true;
        },
      );
    });
  });

  it('C5-26 sanitize-first priority: event getter before retention; legal retention once; options null TypeError', async () => {
    // Hostile: both event and retention getters throw → sanitize error first; retention unread.
    let retentionReads = 0;
    let eventReads = 0;
    await assert.rejects(
      () => appendAuditEvent(
        '/tmp/linke-c5-priority-never-used',
        {
          get id() {
            eventReads += 1;
            throw new Error('event-getter-boom');
          },
        },
        {
          get retention() {
            retentionReads += 1;
            throw new Error('retention-getter-boom');
          },
        },
      ),
      (error) => {
        assert.equal(error.message, 'event-getter-boom');
        return true;
      },
    );
    assert.equal(eventReads, 1);
    assert.equal(retentionReads, 0);

    // Legal event: retention getter read exactly once.
    await c5WithTemp('priority', async (root) => {
      retentionReads = 0;
      await appendAuditEvent(root, c5BaseEvent('pri'), {
        get retention() {
          retentionReads += 1;
          return { maxEvents: 10 };
        },
      });
      assert.equal(retentionReads, 1);
      assert.equal((await c5ReadState(root)).status, 'idle');

      // Default {} / undefined keep working; explicit null preserves prior TypeError contract.
      await appendAuditEvent(root, c5BaseEvent('def-undef'), undefined);
      await appendAuditEvent(root, c5BaseEvent('def-obj'), {});
      await assert.rejects(
        () => appendAuditEvent(root, c5BaseEvent('def-null'), null),
        (error) => error instanceof TypeError,
      );
    });
  });
});
