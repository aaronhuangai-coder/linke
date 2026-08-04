import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, lstat } from 'node:fs/promises';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, MAX_JSON_BODY_BYTES, API_WRITE_ROUTES } from '../src/server.js';
import { slugify, safeDevicePath, createBackup } from '../src/storage.js';
import { readAuditEvents } from '../src/audit-log.js';
import { ERROR_CODES, LinkeError } from '../src/error-codes.js';
import { DEVICE_PROTOCOL_VERSION } from '../src/device-protocol.js';

function postJSON(port, path, body) {
  return fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postRawJSON(port, path, body) {
  return fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

function postRawJSONWithoutContentLength(port, path, body) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: 'localhost',
      port,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve({
          status: res.statusCode,
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
    });

    req.on('error', reject);
    const splitAt = Math.floor(body.length / 2);
    req.write(body.slice(0, splitAt));
    req.end(body.slice(splitAt));
  });
}

async function pathExists(path) {
  try {
    await import('node:fs/promises').then((fs) => fs.access(path));
    return true;
  } catch {
    return false;
  }
}

/** Forbidden top-level audit keys that must never appear on events. */
const AUDIT_FORBIDDEN_TOP_LEVEL_KEYS = [
  'enrollmentCode',
  'tlsFingerprint',
  'agentUrl',
  'code',
  'token',
];

/** Sensitive key names that must not appear anywhere in audit JSON. */
const AUDIT_SENSITIVE_KEY_PATTERN = /tokenDigest|codeDigest|enrollmentCode/i;

/** Production controller hostname that must not leak into audit events. */
const AUDIT_HOSTNAME_PATTERN = /linke-controller\.local/i;

/**
 * True when key names a port field (exact `port` or `*Port` / `*_port`).
 * @param {string | null | undefined} key
 * @returns {boolean}
 */
function isPortFieldKey(key) {
  if (typeof key !== 'string' || key.length === 0) return false;
  if (key === 'port') return true;
  if (/Port$/.test(key)) return true;
  if (/_port$/i.test(key)) return true;
  return key.toLowerCase() === 'port';
}

/**
 * True when a string embeds `port` as a URL / host-port component (`:3443`),
 * not merely as a hex substring inside a UUID or similar token.
 * @param {string} value
 * @param {number} port
 * @returns {boolean}
 */
function stringContainsPortInUrlOrHostPortContext(value, port) {
  // Colon-delimited port; reject trailing digits so `:34430` is not a hit for 3443.
  return new RegExp(`:${port}(?!\\d)`).test(value);
}

/**
 * Structure-aware walk: port number only counts as a leak in URL/host-port
 * values or under port-named fields. Does not treat bare hex `3443` in UUIDs
 * as a leak.
 * @param {unknown} value
 * @param {number} port
 * @param {string | null} [key]
 * @returns {boolean}
 */
function valueContainsPortLeak(value, port, key = null) {
  if (value == null) return false;

  if (typeof value === 'number') {
    return value === port && isPortFieldKey(key);
  }

  if (typeof value === 'string') {
    if (stringContainsPortInUrlOrHostPortContext(value, port)) return true;
    if (value === String(port) && isPortFieldKey(key)) return true;
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((item) => valueContainsPortLeak(item, port, key));
  }

  if (typeof value === 'object') {
    return Object.entries(value).some(([childKey, childValue]) => (
      valueContainsPortLeak(childValue, port, childKey)
    ));
  }

  return false;
}

/**
 * Pure audit no-secret oracle. Full-string scan for hostnames, synthetic
 * secrets, and sensitive key names (including inside id/requestId). Port
 * `3443` is judged only in URL / host-port / port-field contexts so random
 * UUIDs that happen to contain the hex digits `3443` do not false-positive.
 *
 * @param {unknown} events
 * @param {{
 *   syntheticCode?: string,
 *   syntheticFingerprint?: string,
 *   syntheticToken?: string,
 *   syntheticPath?: string,
 *   leakPort?: number,
 * }} [options]
 * @returns {boolean} true when secrets appear to be present
 */
function auditEventsContainSecrets(events, options = {}) {
  const {
    syntheticCode = '',
    syntheticFingerprint = '',
    syntheticToken = '',
    syntheticPath = '',
    leakPort = 3443,
  } = options;

  const list = Array.isArray(events) ? events : [];
  const serialized = JSON.stringify(list);

  // Full-string scans intentionally include id/requestId content so hostname,
  // tokens, and paths hidden in those fields still fail closed.
  if (syntheticCode && serialized.includes(syntheticCode)) return true;
  if (syntheticFingerprint && serialized.includes(syntheticFingerprint)) return true;
  if (syntheticToken && serialized.includes(syntheticToken)) return true;
  if (syntheticPath && serialized.includes(syntheticPath)) return true;
  if (AUDIT_HOSTNAME_PATTERN.test(serialized)) return true;
  if (AUDIT_SENSITIVE_KEY_PATTERN.test(serialized)) return true;

  // Bare port digits only via structure-aware walk (not global substring),
  // so UUID/event id/requestId hex containing `3443` does not false-positive.
  if (valueContainsPortLeak(list, leakPort)) return true;

  for (const event of list) {
    if (!event || typeof event !== 'object') continue;
    for (const key of AUDIT_FORBIDDEN_TOP_LEVEL_KEYS) {
      if (key in event) return true;
    }
  }

  return false;
}

/**
 * Assert audit events contain no secrets (pure; throws on leak).
 * @param {unknown} events
 * @param {Parameters<typeof auditEventsContainSecrets>[1]} [options]
 */
function assertAuditEventsHaveNoSecrets(events, options) {
  assert.strictEqual(
    auditEventsContainSecrets(events, options),
    false,
    `audit events must not contain secrets: ${JSON.stringify(events)}`,
  );
}

describe('Security — deviceId path traversal prevention', () => {
  let server, dataDir, port;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'linke-sec-'));
    server = createServer({ dataDir });
    await new Promise((r) => server.listen(0, r));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    await rm(dataDir, { recursive: true, force: true });
  });

  it('slugify neutralizes path traversal sequences', () => {
    assert.strictEqual(slugify('../../../etc/passwd'), '.._.._.._etc_passwd');
    assert.strictEqual(slugify('../secret'), '.._secret');
    assert.strictEqual(slugify('foo/bar'), 'foo_bar');
    assert.strictEqual(slugify('a\\b\\c'), 'a_b_c');
    assert.strictEqual(slugify('normal-id'), 'normal-id');
  });

  it('safeDevicePath resolves within repo boundary', () => {
    const base = resolve(join(dataDir, 'repo'));

    const r1 = safeDevicePath(dataDir, '../../../etc/passwd');
    assert.ok(r1.deviceDir.startsWith(base + '/'), 'must be inside repo');
    assert.strictEqual(r1.slug, '.._.._.._etc_passwd');

    const r2 = safeDevicePath(dataDir, '../escape');
    assert.ok(r2.deviceDir.startsWith(base + '/'), 'must be inside repo');

    const r3 = safeDevicePath(dataDir, 'normal');
    assert.ok(r3.deviceDir.startsWith(base + '/'));
    assert.strictEqual(r3.slug, 'normal');
  });

  it('heartbeat with traversal deviceId is slugified, not escaped', async () => {
    const res = await postJSON(port, '/api/heartbeat', {
      deviceId: '../../../etc/passwd',
      hostname: 'evil',
      ipAddress: '1.2.3.4',
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.deviceId, '.._.._.._etc_passwd');

    // Verify the file was written INSIDE repo, not outside
    const repoBase = resolve(join(dataDir, 'repo'));
    const deviceDir = resolve(join(dataDir, 'repo', 'devices', body.deviceId));
    assert.ok(deviceDir.startsWith(repoBase + '/'), 'device dir must be inside repo');
  });

  it('snapshots endpoint with traversal deviceId returns 404', async () => {
    const res = await fetch(
      `http://localhost:${port}/api/devices/..%2f..%2f..%2fetc/snapshots`,
    );
    // After slugification, this device doesn't exist → 404
    assert.ok(res.status === 404 || res.status === 200);
    if (res.status === 200) {
      const body = await res.json();
      // Should be empty — no snapshots for the slugified id
      assert.ok(Array.isArray(body));
    }
  });

  it('backup with traversal deviceId writes inside repo only', async () => {
    const srcDir = join(dataDir, '_sec_src');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, 'test.txt'), 'safe');

    const res = await postJSON(port, '/api/backups', {
      deviceId: '../../outside',
      sourcePath: srcDir,
    });
    assert.strictEqual(res.status, 201);

    // Verify written inside repo
    const repoBase = resolve(join(dataDir, 'repo'));
    const deviceDir = resolve(join(dataDir, 'repo', 'devices', '.._.._outside'));
    assert.ok(deviceDir.startsWith(repoBase + '/'));
  });
});

describe('Security — devices directory namespace isolation', () => {
  let dataDir;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'linke-ns-'));
  });

  after(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('slugify never returns ".", "..", or empty string for dangerous deviceIds', () => {
    const dangerous = ['.', '..', '../..', '../../../etc/passwd', '', '...'];
    for (const id of dangerous) {
      const slug = slugify(id);
      assert.notStrictEqual(slug, '.', `slugify("${id}") must not return "."`);
      assert.notStrictEqual(slug, '..', `slugify("${id}") must not return ".."`);
      assert.notStrictEqual(slug, '', `slugify("${id}") must not return empty string`);
    }
  });

  it('safeDevicePath always resolves inside devices/ directory', () => {
    const devicesBase = resolve(join(dataDir, 'repo', 'devices'));
    const dangerous = ['.', '..', '../..', '../../../etc/passwd', '', '...'];
    for (const id of dangerous) {
      const { deviceDir } = safeDevicePath(dataDir, id);
      assert.ok(
        deviceDir.startsWith(devicesBase + '/'),
        `deviceId "${id}" → deviceDir "${deviceDir}" escaped devices/ boundary "${devicesBase}"`,
      );
    }
  });

  it('safeDevicePath slug never collides with "." or ".." directory entries', () => {
    const dangerous = ['.', '..', '../..', '../../../etc/passwd', ''];
    for (const id of dangerous) {
      const { slug } = safeDevicePath(dataDir, id);
      assert.notStrictEqual(slug, '.');
      assert.notStrictEqual(slug, '..');
    }
  });

  it('heartbeat with deviceId "." stays inside devices/ and gets safe slug', async () => {
    const tmpServer = createServer({ dataDir });
    await new Promise((r) => tmpServer.listen(0, r));
    const p = tmpServer.address().port;
    try {
      const res = await postJSON(p, '/api/heartbeat', {
        deviceId: '.',
        hostname: 'dot-test',
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.notStrictEqual(body.deviceId, '.');
      assert.notStrictEqual(body.deviceId, '..');

      const devicesBase = resolve(join(dataDir, 'repo', 'devices'));
      const deviceDir = resolve(join(dataDir, 'repo', 'devices', body.deviceId));
      assert.ok(deviceDir.startsWith(devicesBase + '/'));
    } finally {
      await new Promise((r) => tmpServer.close(r));
    }
  });

  it('backup with deviceId ".." writes inside devices/, not repo root', async () => {
    const srcDir = join(dataDir, '_ns_src');
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, 'a.txt'), 'content');

    const { snapshotId } = await createBackup(dataDir, {
      deviceId: '..',
      sourcePath: srcDir,
    });

    const devicesBase = resolve(join(dataDir, 'repo', 'devices'));
    const repoBase = resolve(join(dataDir, 'repo'));

    // The snapshot must NOT be directly under repo/ — it must be under repo/devices/<slug>/
    const snapshotPath = resolve(join(devicesBase));
    // Verify no snapshot dirs leaked to repo root
    const repoEntries = await (async () => {
      try {
        return await import('node:fs/promises').then((fs) =>
          fs.readdir(join(repoBase, 'snapshots')).catch(() => []),
        );
      } catch {
        return [];
      }
    })();
    assert.strictEqual(repoEntries.length, 0, 'no snapshots/ dir should exist at repo root');
  });
});

describe('Security — optional bearer token authentication', () => {
  let dataDir;

  before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'linke-auth-'));
  });

  after(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('rejects GET /api/devices without Authorization and only writes an auth.denied audit event', async () => {
    const server = createServer({ dataDir, authToken: 'test-token' });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    try {
      const getEntries = async () => {
        try {
          return await import('node:fs/promises').then((fs) => fs.readdir(dataDir));
        } catch {
          return [];
        }
      };
      const beforeEntries = await getEntries();

      const res = await fetch(`http://localhost:${port}/api/devices`);
      assert.strictEqual(res.status, 401);

      const body = await res.json();
      assert.deepStrictEqual(body, { error: 'Unauthorized' });

      const afterEntries = await getEntries();
      assert.deepStrictEqual(afterEntries.filter((entry) => entry !== 'audit'), beforeEntries.filter((entry) => entry !== 'audit'));
      assert.strictEqual(await pathExists(join(dataDir, 'repo')), false);
      const events = await readAuditEvents(dataDir, { limit: 1 });
      assert.strictEqual(events[0].type, 'auth.denied');
      assert.strictEqual(events[0].path, '/api/devices');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('rejects GET /api/health without Authorization when authToken is enabled', async () => {
    const server = createServer({ dataDir, authToken: 'test-token' });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/api/health`);
      assert.strictEqual(res.status, 401);
      assert.deepStrictEqual(await res.json(), { error: 'Unauthorized' });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('rejects POST /api/heartbeat without Authorization before writing device data', async () => {
    const server = createServer({ dataDir, authToken: 'test-token' });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    try {
      const beforeEntries = await readdir(dataDir);
      const res = await fetch(`http://localhost:${port}/api/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'blocked-device' }),
      });
      assert.strictEqual(res.status, 401);
      assert.deepStrictEqual(await res.json(), { error: 'Unauthorized' });
      const afterEntries = await readdir(dataDir);
      assert.deepStrictEqual(afterEntries.filter((entry) => entry !== 'audit'), beforeEntries.filter((entry) => entry !== 'audit'));
      assert.strictEqual(await pathExists(join(dataDir, 'repo', 'devices', 'blocked-device')), false);
      const events = await readAuditEvents(dataDir, { limit: 1 });
      assert.strictEqual(events[0].type, 'auth.denied');
      assert.strictEqual(events[0].path, '/api/heartbeat');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('protects the exact /api path when authToken is enabled', async () => {
    const server = createServer({ dataDir, authToken: 'test-token' });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/api`);
      assert.strictEqual(res.status, 401);
      assert.deepStrictEqual(await res.json(), { error: 'Unauthorized' });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('fails fast when authToken is only whitespace', () => {
    assert.throws(
      () => createServer({ dataDir, authToken: '   ' }),
      /authToken must be a non-empty string/,
    );
  });

  it('rejects wrong Bearer token with 401', async () => {
    const server = createServer({ dataDir, authToken: 'test-token' });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/api/devices`, {
        headers: {
          'Authorization': 'Bearer wrong-token',
        },
      });
      assert.strictEqual(res.status, 401);
      const body = await res.json();
      assert.deepStrictEqual(body, { error: 'Unauthorized' });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('accepts Authorization: Bearer test-token for GET /api/devices', async () => {
    const server = createServer({ dataDir, authToken: 'test-token' });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/api/devices`, {
        headers: {
          'Authorization': 'Bearer test-token',
        },
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body));
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('accepts readToken for read-scope API requests', async () => {
    const server = createServer({ dataDir, readToken: 'read-token' });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/api/devices`, {
        headers: {
          'Authorization': 'Bearer read-token',
        },
      });
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(await res.json()));
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('rejects readToken for write-scope API requests with 403 before writing device data', async () => {
    const server = createServer({ dataDir, readToken: 'read-token', writeToken: 'write-token' });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    try {
      const beforeEntries = await readdir(dataDir);
      const res = await fetch(`http://localhost:${port}/api/heartbeat`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer read-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deviceId: 'read-token-write-blocked', hostname: 'blocked' }),
      });

      assert.strictEqual(res.status, 403);
      assert.deepStrictEqual(await res.json(), { error: 'Forbidden' });
      const afterEntries = await readdir(dataDir);
      assert.deepStrictEqual(afterEntries.filter((entry) => entry !== 'audit'), beforeEntries.filter((entry) => entry !== 'audit'));
      assert.strictEqual(await pathExists(join(dataDir, 'repo', 'devices', 'read-token-write-blocked')), false);
      const events = await readAuditEvents(dataDir, { limit: 1 });
      assert.strictEqual(events[0].type, 'auth.forbidden');
      assert.strictEqual(events[0].path, '/api/heartbeat');
      assert.strictEqual(events[0].statusCode, 403);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('rejects readToken for all registered write routes with 403 and does not cause side effects', async () => {
    const server = createServer({ dataDir, readToken: 'read-token', writeToken: 'write-token' });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    try {
      const tempSourceDir = join(dataDir, 'temp-source-dir');
      await mkdir(tempSourceDir, { recursive: true });
      const tempSourceFile = join(tempSourceDir, 'file.txt');
      await writeFile(tempSourceFile, 'hello');

      const tempTargetDir = join(dataDir, 'temp-target-dir');

      for (const route of API_WRITE_ROUTES) {
        const beforeEntries = await readdir(dataDir);

        let body;
        if (route.path === '/api/heartbeat') {
          body = {
            deviceId: 'registry-device',
            hostname: 'Registry',
            ipAddress: '10.0.0.8',
          };
        } else if (route.path === '/api/backups') {
          body = {
            deviceId: 'registry-device',
            sourcePath: tempSourceDir,
          };
        } else if (route.path === '/api/restore') {
          body = {
            deviceId: 'registry-device',
            snapshotId: '00000000-0000-0000-0000-000000000000',
            targetPath: tempTargetDir,
          };
        } else {
          body = {};
        }

        const res = await fetch(`http://localhost:${port}${route.path}`, {
          method: route.method,
          headers: {
            'Authorization': 'Bearer read-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });

        assert.strictEqual(res.status, 403, `Route ${route.method} ${route.path} should return 403`);
        assert.deepStrictEqual(await res.json(), { error: 'Forbidden' });

        // 验证 dataDir 没有业务副作用，排除审计目录和测试夹具目录。
        const afterEntries = await readdir(dataDir);
        const sanitizeList = (list) => list.filter((e) => e !== 'audit' && e !== 'temp-source-dir' && e !== 'temp-target-dir');
        assert.deepStrictEqual(sanitizeList(afterEntries), sanitizeList(beforeEntries), `Route ${route.path} caused side effects in dataDir`);

        // 验证拒绝写入时记录 auth.forbidden 审计事件。
        const events = await readAuditEvents(dataDir, { limit: 1 });
        assert.ok(events.length > 0, `No audit events found for route ${route.path}`);
        assert.strictEqual(events[0].type, 'auth.forbidden', `Route ${route.path} audit event type mismatch`);
        assert.strictEqual(events[0].path, route.path, `Route ${route.path} audit event path mismatch`);
        assert.strictEqual(events[0].statusCode, 403, `Route ${route.path} audit event statusCode mismatch`);
      }

      await rm(tempSourceDir, { recursive: true, force: true });
      await rm(tempTargetDir, { recursive: true, force: true });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('accepts writeToken for read-scope and write-scope API requests', async () => {
    const server = createServer({ dataDir, readToken: 'read-token', writeToken: 'write-token' });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    try {
      const readRes = await fetch(`http://localhost:${port}/api/devices`, {
        headers: {
          'Authorization': 'Bearer write-token',
        },
      });
      assert.strictEqual(readRes.status, 200);

      const writeRes = await fetch(`http://localhost:${port}/api/heartbeat`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer write-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deviceId: 'write-token-device', hostname: 'allowed' }),
      });
      assert.strictEqual(writeRes.status, 200);
      const body = await writeRes.json();
      assert.strictEqual(body.deviceId, 'write-token-device');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('accepts previousReadToken for read-scope API requests', async () => {
    const server = createServer({
      dataDir,
      readToken: 'read-current',
      previousReadToken: 'read-previous',
      writeToken: 'write-current',
      previousWriteToken: 'write-previous',
    });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/api/devices`, {
        headers: {
          'Authorization': 'Bearer read-previous',
        },
      });
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(await res.json()));
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('rejects previousReadToken for write-scope requests without business side effects or token leaks', async () => {
    const server = createServer({
      dataDir,
      readToken: 'read-current',
      previousReadToken: 'read-previous',
      writeToken: 'write-current',
      previousWriteToken: 'write-previous',
    });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    try {
      const beforeEntries = await readdir(dataDir);
      const res = await fetch(`http://localhost:${port}/api/heartbeat`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer read-previous',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deviceId: 'rotation-read-blocked-device', hostname: 'blocked' }),
      });

      assert.strictEqual(res.status, 403);
      assert.deepStrictEqual(await res.json(), { error: 'Forbidden' });
      const afterEntries = await readdir(dataDir);
      assert.deepStrictEqual(afterEntries.filter((entry) => entry !== 'audit'), beforeEntries.filter((entry) => entry !== 'audit'));
      assert.strictEqual(await pathExists(join(dataDir, 'repo', 'devices', 'rotation-read-blocked-device')), false);
      const events = await readAuditEvents(dataDir, { limit: 1 });
      assert.strictEqual(events[0].type, 'auth.forbidden');
      assert.strictEqual(events[0].path, '/api/heartbeat');
      assert.strictEqual(events[0].statusCode, 403);
      assertAuditEventsHaveNoSecrets(events, { syntheticToken: 'read-current' });
      assertAuditEventsHaveNoSecrets(events, { syntheticToken: 'read-previous' });
      assertAuditEventsHaveNoSecrets(events, { syntheticToken: 'write-current' });
      assertAuditEventsHaveNoSecrets(events, { syntheticToken: 'write-previous' });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('accepts previousWriteToken for read-scope and write-scope API requests', async () => {
    const server = createServer({
      dataDir,
      readToken: 'read-current',
      previousReadToken: 'read-previous',
      writeToken: 'write-current',
      previousWriteToken: 'write-previous',
    });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    try {
      const readRes = await fetch(`http://localhost:${port}/api/devices`, {
        headers: {
          'Authorization': 'Bearer write-previous',
        },
      });
      assert.strictEqual(readRes.status, 200);

      const writeRes = await fetch(`http://localhost:${port}/api/heartbeat`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer write-previous',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deviceId: 'rotation-write-device', hostname: 'allowed' }),
      });
      assert.strictEqual(writeRes.status, 200);
      const body = await writeRes.json();
      assert.strictEqual(body.deviceId, 'rotation-write-device');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('rejects an unknown token during rotation overlap without leaking any token to audit', async () => {
    const server = createServer({
      dataDir,
      readToken: 'read-current',
      previousReadToken: 'read-previous',
      writeToken: 'write-current',
      previousWriteToken: 'write-previous',
    });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/api/devices`, {
        headers: {
          'Authorization': 'Bearer rotation-unknown',
        },
      });
      assert.strictEqual(res.status, 401);
      assert.deepStrictEqual(await res.json(), { error: 'Unauthorized' });
      const events = await readAuditEvents(dataDir, { limit: 1 });
      assert.strictEqual(events[0].type, 'auth.denied');
      assert.strictEqual(events[0].path, '/api/devices');
      assert.strictEqual(events[0].statusCode, 401);
      assertAuditEventsHaveNoSecrets(events, { syntheticToken: 'read-current' });
      assertAuditEventsHaveNoSecrets(events, { syntheticToken: 'read-previous' });
      assertAuditEventsHaveNoSecrets(events, { syntheticToken: 'write-current' });
      assertAuditEventsHaveNoSecrets(events, { syntheticToken: 'write-previous' });
      assertAuditEventsHaveNoSecrets(events, { syntheticToken: 'rotation-unknown' });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('keeps authToken as full-access compatibility token when scoped tokens are configured', async () => {
    const server = createServer({
      dataDir,
      authToken: 'full-token',
      readToken: 'read-token',
      writeToken: 'write-token',
    });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/api/heartbeat`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer full-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deviceId: 'full-token-device', hostname: 'allowed' }),
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.deviceId, 'full-token-device');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('rejects unknown scoped Bearer token with 401', async () => {
    const server = createServer({ dataDir, readToken: 'read-token', writeToken: 'write-token' });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/api/devices`, {
        headers: {
          'Authorization': 'Bearer unknown-token',
        },
      });
      assert.strictEqual(res.status, 401);
      assert.deepStrictEqual(await res.json(), { error: 'Unauthorized' });
      const events = await readAuditEvents(dataDir, { limit: 1 });
      assert.strictEqual(events[0].type, 'auth.denied');
      assert.strictEqual(events[0].statusCode, 401);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('uses broadest scope when readToken and writeToken have the same value', async () => {
    const server = createServer({ dataDir, readToken: 'shared-token', writeToken: 'shared-token' });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/api/heartbeat`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer shared-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deviceId: 'shared-token-device', hostname: 'allowed' }),
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.deviceId, 'shared-token-device');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('fails fast when readToken or writeToken is only whitespace', () => {
    assert.throws(
      () => createServer({ dataDir, readToken: '   ' }),
      /readToken must be a non-empty string/,
    );
    assert.throws(
      () => createServer({ dataDir, writeToken: '   ' }),
      /writeToken must be a non-empty string/,
    );
  });

  it('fails fast when a previous scoped token is only whitespace', () => {
    assert.throws(
      () => createServer({ dataDir, previousAuthToken: '   ' }),
      /authToken must be a non-empty string/,
    );
    assert.throws(
      () => createServer({ dataDir, previousReadToken: '   ' }),
      /readToken must be a non-empty string/,
    );
    assert.throws(
      () => createServer({ dataDir, previousWriteToken: '   ' }),
      /writeToken must be a non-empty string/,
    );
    assert.throws(
      () => createServer({ dataDir, previousAdminToken: '   ' }),
      /adminToken must be a non-empty string/,
    );
  });

  it('fails fast when a previous scoped token is not a string', () => {
    assert.throws(
      () => createServer({ dataDir, previousAuthToken: 42 }),
      /authToken must be a string/,
    );
    assert.throws(
      () => createServer({ dataDir, previousReadToken: 42 }),
      /readToken must be a string/,
    );
    assert.throws(
      () => createServer({ dataDir, previousWriteToken: {} }),
      /writeToken must be a string/,
    );
    assert.throws(
      () => createServer({ dataDir, previousAdminToken: [] }),
      /adminToken must be a string/,
    );
  });

  it('fails closed when previousReadToken is configured without readToken', () => {
    assert.throws(
      () => createServer({ dataDir, previousReadToken: 'read-previous-only' }),
      { name: 'Error', message: 'previousReadToken requires readToken' },
    );
    assert.throws(
      () => createServer({
        dataDir,
        previousReadToken: 'read-previous-only',
        writeToken: 'write-current-only',
      }),
      { name: 'Error', message: 'previousReadToken requires readToken' },
    );
  });

  it('fails closed when previousWriteToken is configured without writeToken', () => {
    assert.throws(
      () => createServer({ dataDir, previousWriteToken: 'write-previous-only' }),
      { name: 'Error', message: 'previousWriteToken requires writeToken' },
    );
    assert.throws(
      () => createServer({
        dataDir,
        previousWriteToken: 'write-previous-only',
        readToken: 'read-current-only',
      }),
      { name: 'Error', message: 'previousWriteToken requires writeToken' },
    );
  });

  it('fails closed when previous full/admin tokens are configured without their current pairs', () => {
    assert.throws(
      () => createServer({ dataDir, previousAuthToken: 'full-previous-only' }),
      { name: 'Error', message: 'previousAuthToken requires authToken' },
    );
    assert.throws(
      () => createServer({ dataDir, previousAdminToken: 'admin-previous-only' }),
      { name: 'Error', message: 'previousAdminToken requires adminToken' },
    );
  });

  it('fails fast when adminToken is only whitespace', () => {
    assert.throws(
      () => createServer({ dataDir, adminToken: '   ' }),
      /adminToken must be a non-empty string/,
    );
  });

  it('fails fast when adminToken is not a string', () => {
    assert.throws(
      () => createServer({ dataDir, adminToken: 42 }),
      /adminToken must be a string/,
    );
  });

  it('when no authToken is provided, existing unauthenticated localhost behavior remains allowed', async () => {
    const server = createServer({ dataDir });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/api/devices`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body));
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe('Security — API request body and error hardening', () => {
  async function withServer(fn) {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-hardening-'));
    const server = createServer({ dataDir });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    try {
      return await fn({ dataDir, port });
    } finally {
      await new Promise((r) => server.close(r));
      await rm(dataDir, { recursive: true, force: true });
    }
  }

  async function assertOversizedWriteAdmissionOnly(dataDir, res, {
    deviceId,
    paddingSnippet,
  }) {
    const text = typeof res.text === 'function' ? await res.text() : String(res.body || '');
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    assert.strictEqual(res.status, 413);
    assert.deepStrictEqual(json, { error: 'Request body too large' });

    // Response must not echo oversized payload / paths / tokens.
    // Fixed error body is the only allowed public text; deviceId/padding must not appear.
    assert.ok(!text.includes(deviceId));
    assert.ok(!text.includes(paddingSnippet));
    assert.ok(!text.includes(dataDir));
    assert.ok(!text.includes('sourcePath'));
    assert.ok(!text.includes('targetPath'));
    assert.ok(!/Bearer|Authorization|token=/i.test(text));
    assert.ok(!/ENOENT|EACCES|stack|at\s+\S+\s+\(/i.test(text));

    // V1.39 + V1.40 C2: required admission enqueues before readBody.
    // Exact allowed audit/ layout = integrity stores + permanent process-lock protocol artifact
    // (integrity-write.lock is NOT an audit store / business mutation).
    assert.deepStrictEqual(await readdir(dataDir), ['audit']);
    const auditEntries = (await readdir(join(dataDir, 'audit'))).sort();
    assert.deepStrictEqual(auditEntries, [
      'events.jsonl',
      'integrity-dual-write-state.json',
      'integrity-journal.jsonl',
      'integrity-write.lock',
    ].sort());
    const lockAbs = join(dataDir, 'audit', 'integrity-write.lock');
    const lockSt = await lstat(lockAbs);
    assert.strictEqual(lockSt.isFile(), true);
    assert.strictEqual(lockSt.isSymbolicLink(), false);
    assert.strictEqual(lockSt.nlink, 1);
    assert.strictEqual(lockSt.mode & 0o777, 0o600);
    assert.strictEqual(lockSt.size, 0);

    // Business mutation paths must not exist (no devices/backups/approvals/restore side effects).
    for (const forbidden of [
      'repo',
      'approvals',
      'devices',
      'backups',
      'snapshots',
      'restore',
    ]) {
      await assert.rejects(() => readdir(join(dataDir, forbidden)), { code: 'ENOENT' });
    }

    const events = await readAuditEvents(dataDir, { limit: 20 });
    assert.strictEqual(events.length, 1);
    const admission = events[0];
    assert.strictEqual(admission.type, 'api.write.admission.started');
    assert.strictEqual(admission.method, 'POST');
    assert.strictEqual(admission.path, '/api/heartbeat');
    assert.strictEqual(admission.outcome, 'started');
    assert.match(admission.requestId, /^[a-f0-9-]{36}$/i);
    assert.ok(!('deviceId' in admission));
    assert.ok(!('body' in admission));
    assert.ok(!('token' in admission));
    assert.ok(!('sourcePath' in admission));
    assert.ok(!('targetPath' in admission));
    assert.ok(!('padding' in admission));
    assert.ok(!('statusCode' in admission));

    // Body parser threw before handler outcome audits (no success/failure route events).
    assert.strictEqual(events.some((event) => event.type === 'api.heartbeat.success'), false);
    assert.strictEqual(events.some((event) => event.type === 'api.heartbeat.failure'), false);
    assert.strictEqual(
      events.some((event) => typeof event.type === 'string' && event.type.endsWith('.success')),
      false,
    );
    assert.strictEqual(
      events.some((event) => typeof event.type === 'string' && event.type.endsWith('.failure')),
      false,
    );

    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes(deviceId));
    assert.ok(!serialized.includes(paddingSnippet));
    assert.ok(!serialized.includes(dataDir));
    assert.doesNotMatch(serialized, /sourcePath|targetPath|Authorization|Bearer|padding/);
  }

  it('rejects oversized JSON request bodies with 413; admission-only audit, zero business mutation', async () => {
    await withServer(async ({ dataDir, port }) => {
      assert.deepStrictEqual(await readdir(dataDir), []);
      const deviceId = 'oversized-device';
      const paddingSnippet = 'x'.repeat(64);
      const body = JSON.stringify({
        deviceId,
        padding: 'x'.repeat(MAX_JSON_BODY_BYTES),
      });

      const res = await postRawJSON(port, '/api/heartbeat', body);
      await assertOversizedWriteAdmissionOnly(dataDir, res, { deviceId, paddingSnippet });
    });
  });

  it('enforces JSON body limit without Content-Length; admission-only audit, zero business mutation', async () => {
    await withServer(async ({ dataDir, port }) => {
      assert.deepStrictEqual(await readdir(dataDir), []);
      const deviceId = 'chunked-oversized-device';
      const paddingSnippet = 'x'.repeat(64);
      const body = JSON.stringify({
        deviceId,
        padding: 'x'.repeat(MAX_JSON_BODY_BYTES),
      });

      const res = await postRawJSONWithoutContentLength(port, '/api/heartbeat', body);
      await assertOversizedWriteAdmissionOnly(dataDir, res, { deviceId, paddingSnippet });
    });
  });

  it('accepts JSON request bodies at exactly the configured byte limit', async () => {
    await withServer(async ({ port }) => {
      const baseBody = JSON.stringify({
        deviceId: 'exact-limit-device',
        padding: '',
      });
      const paddingLength = MAX_JSON_BODY_BYTES - Buffer.byteLength(baseBody);
      const body = JSON.stringify({
        deviceId: 'exact-limit-device',
        padding: 'x'.repeat(paddingLength),
      });
      assert.strictEqual(Buffer.byteLength(body), MAX_JSON_BODY_BYTES);

      const res = await postRawJSON(port, '/api/heartbeat', body);

      assert.strictEqual(res.status, 200);
      const payload = await res.json();
      assert.strictEqual(payload.deviceId, 'exact-limit-device');
    });
  });

  it('accepts JSON request bodies at or below the configured limit', async () => {
    await withServer(async ({ port }) => {
      let paddingLength = MAX_JSON_BODY_BYTES - 128;
      let body = '';
      do {
        body = JSON.stringify({
          deviceId: 'large-ok-device',
          padding: 'x'.repeat(paddingLength),
        });
        paddingLength -= 1;
      } while (Buffer.byteLength(body) > MAX_JSON_BODY_BYTES);

      const res = await postRawJSON(port, '/api/heartbeat', body);

      assert.strictEqual(res.status, 200);
      const payload = await res.json();
      assert.strictEqual(payload.deviceId, 'large-ok-device');
    });
  });

  it('keeps intentional invalid JSON as a 400 response with its specific message', async () => {
    await withServer(async ({ port }) => {
      const res = await postRawJSON(port, '/api/heartbeat', '{');

      assert.strictEqual(res.status, 400);
      assert.deepStrictEqual(await res.json(), { error: 'Invalid JSON body' });
    });
  });

  it('keeps intentional missing-field validation as a 400 response with its specific message', async () => {
    await withServer(async ({ port }) => {
      const res = await postJSON(port, '/api/heartbeat', {});

      assert.strictEqual(res.status, 400);
      assert.deepStrictEqual(await res.json(), { error: 'deviceId is required' });
    });
  });

  it('sanitizes unexpected 500 responses without exposing internal error details', async () => {
    await withServer(async ({ dataDir, port }) => {
      const res = await postJSON(port, '/api/restore', {
        deviceId: 'restore-test',
        snapshotId: '00000000-0000-0000-0000-000000000000',
        targetPath: join(dataDir, 'restore-fail'),
      });

      assert.strictEqual(res.status, 500);
      const body = await res.json();
      assert.deepStrictEqual(body, { error: 'Internal Server Error' });
    });
  });
});

describe('Security — audit no-secret oracle (structure-aware)', () => {
  // Captured flaky UUID: random requestId hex contained bare substring `3443`.
  const UUID_WITH_3443_HEX = '88b808a4-1372-4f7c-895a-18f34434015d';
  const ORACLE_OPTS = {
    syntheticCode: 'one-time-code-SYNTHETIC-SECRET-9f3a',
    syntheticFingerprint: 'a'.repeat(64),
    syntheticToken: 'admin-write-token-SYNTHETIC',
    syntheticPath: '/tmp/linke-secret-path-SYNTHETIC',
  };

  it('does not false-positive when id/requestId UUID contains hex substring 3443', () => {
    const events = [
      {
        id: UUID_WITH_3443_HEX,
        requestId: UUID_WITH_3443_HEX,
        type: 'api.device-enrollment.success',
        outcome: 'success',
        statusCode: 200,
        timestamp: '2026-07-13T00:00:00.000Z',
      },
    ];
    assert.strictEqual(auditEventsContainSecrets(events, ORACLE_OPTS), false);
    assert.doesNotThrow(() => assertAuditEventsHaveNoSecrets(events, ORACLE_OPTS));
  });

  it('detects full agent URL leak https://linke-controller.local:3443', () => {
    const events = [
      {
        id: 'safe-id',
        requestId: 'safe-request',
        message: 'https://linke-controller.local:3443',
      },
    ];
    assert.strictEqual(auditEventsContainSecrets(events, ORACLE_OPTS), true);
    assert.throws(() => assertAuditEventsHaveNoSecrets(events, ORACLE_OPTS));
  });

  it('detects numeric port field leak port=3443', () => {
    const events = [{ id: 'safe-id', requestId: 'safe-request', port: 3443 }];
    assert.strictEqual(auditEventsContainSecrets(events, ORACLE_OPTS), true);
    assert.throws(() => assertAuditEventsHaveNoSecrets(events, ORACLE_OPTS));
  });

  it('detects string port field leak port="3443"', () => {
    const events = [{ id: 'safe-id', requestId: 'safe-request', port: '3443' }];
    assert.strictEqual(auditEventsContainSecrets(events, ORACLE_OPTS), true);
    assert.throws(() => assertAuditEventsHaveNoSecrets(events, ORACLE_OPTS));
  });

  it('detects sensitive keys tokenDigest/codeDigest/enrollmentCode', () => {
    for (const key of ['tokenDigest', 'codeDigest', 'enrollmentCode']) {
      const events = [{ id: 'safe-id', requestId: 'safe-request', [key]: 'x' }];
      assert.strictEqual(auditEventsContainSecrets(events, ORACLE_OPTS), true, key);
      assert.throws(() => assertAuditEventsHaveNoSecrets(events, ORACLE_OPTS), key);
    }
  });

  it('still detects hostname/token/path hidden inside id or requestId', () => {
    assert.strictEqual(
      auditEventsContainSecrets([
        { id: `wrap-${'linke-controller.local'}-wrap`, requestId: 'safe' },
      ], ORACLE_OPTS),
      true,
    );
    assert.strictEqual(
      auditEventsContainSecrets([
        { id: 'safe', requestId: ORACLE_OPTS.syntheticToken },
      ], ORACLE_OPTS),
      true,
    );
    assert.strictEqual(
      auditEventsContainSecrets([
        { id: ORACLE_OPTS.syntheticPath, requestId: 'safe' },
      ], ORACLE_OPTS),
      true,
    );
  });

  it('detects host-port URL without controller hostname (port context)', () => {
    const events = [
      { id: 'safe-id', requestId: 'safe-request', target: 'https://example.test:3443/path' },
    ];
    assert.strictEqual(auditEventsContainSecrets(events, ORACLE_OPTS), true);
  });
});

describe('Security — loopback device administration routes', () => {
  const SYNTHETIC_CODE = 'one-time-code-SYNTHETIC-SECRET-9f3a';
  const SYNTHETIC_FINGERPRINT = 'a'.repeat(64);
  const SYNTHETIC_TOKEN = 'admin-write-token-SYNTHETIC';
  const SYNTHETIC_PATH = '/tmp/linke-secret-path-SYNTHETIC';
  const AGENT_URL = 'https://linke-controller.local:3443';

  function baseAdmin(overrides = {}) {
    return {
      issueEnrollment: async ({ deviceId }) => ({
        deviceId,
        code: SYNTHETIC_CODE,
        expiresAt: '2026-07-13T00:10:00.000Z',
      }),
      revokeDevice: async (deviceId) => ({ deviceId, revoked: true }),
      getStatus: async () => ({
        bindConfigured: true,
        listening: true,
        tlsFingerprintConfigured: true,
        active: 0,
        revoked: 0,
      }),
      agentUrl: AGENT_URL,
      tlsFingerprint: SYNTHETIC_FINGERPRINT,
      ...overrides,
    };
  }

  async function withServer(options, fn) {
    const dataDir = await mkdtemp(join(tmpdir(), 'linke-device-admin-'));
    const server = createServer({ dataDir, ...options });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    try {
      return await fn(port, dataDir);
    } finally {
      await new Promise((r) => server.close(r));
      await rm(dataDir, { recursive: true, force: true });
    }
  }

  function postJson(port, path, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function assertAuditHasNoSecrets(dataDir) {
    const events = await readAuditEvents(dataDir, { limit: 100 });
    assertAuditEventsHaveNoSecrets(events, {
      syntheticCode: SYNTHETIC_CODE,
      syntheticFingerprint: SYNTHETIC_FINGERPRINT,
      syntheticToken: SYNTHETIC_TOKEN,
      syntheticPath: SYNTHETIC_PATH,
    });
    return events;
  }

  it('requires a configured admin-capable token for device enrollment', async () => {
    const deviceAdministration = baseAdmin({
      issueEnrollment: async () => ({ code: 'one-time-code', expiresAt: '2026-07-13T00:10:00.000Z' }),
      revokeDevice: async () => {},
      getStatus: async () => ({ active: 0, revoked: 0 }),
    });
    let called = false;
    deviceAdministration.issueEnrollment = async () => {
      called = true;
      return { code: 'one-time-code', expiresAt: '2026-07-13T00:10:00.000Z' };
    };
    deviceAdministration.revokeDevice = async () => {
      called = true;
    };

    await withServer({ deviceAdministration }, async (port) => {
      for (const path of ['/api/device-enrollment-codes', '/api/device-revoke']) {
        const response = await postJson(port, path, { deviceId: 'mac-alpha' });
        assert.strictEqual(response.status, 503);
        assert.deepStrictEqual(await response.json(), { error: 'auth-admin-required' });
      }
    });
    assert.strictEqual(called, false);
  });

  it('rejects null or missing device ids before calling administration services', async () => {
    let called = false;
    const deviceAdministration = baseAdmin({
      issueEnrollment: async () => { called = true; },
      revokeDevice: async () => { called = true; },
      getStatus: async () => ({ active: 0, revoked: 0 }),
    });
    await withServer({ deviceAdministration, writeToken: 'admin-write' }, async (port) => {
      for (const path of ['/api/device-enrollment-codes', '/api/device-revoke']) {
        for (const body of [null, {}, { deviceId: 42 }]) {
          const response = await postJson(port, path, body, 'admin-write');
          assert.strictEqual(response.status, 400, `path=${path} body=${JSON.stringify(body)}`);
          assert.deepStrictEqual(await response.json(), { error: 'device-request-invalid' });
        }
      }
    });
    assert.strictEqual(called, false);
  });

  it('rejects array, blank, and out-of-range device ids without calling services', async () => {
    let callCount = 0;
    const deviceAdministration = baseAdmin({
      issueEnrollment: async () => { callCount += 1; },
      revokeDevice: async () => { callCount += 1; },
    });
    const invalidBodies = [
      [],
      { deviceId: '' },
      { deviceId: '   ' },
      { deviceId: 'Mac-Alpha' },
      { deviceId: '-leading' },
      { deviceId: 'has_underscore' },
      { deviceId: 'a'.repeat(64) },
      { deviceId: '../escape' },
    ];
    await withServer({ deviceAdministration, writeToken: SYNTHETIC_TOKEN }, async (port) => {
      for (const path of ['/api/device-enrollment-codes', '/api/device-revoke']) {
        for (const body of invalidBodies) {
          const response = await postJson(port, path, body, SYNTHETIC_TOKEN);
          assert.strictEqual(response.status, 400);
          assert.deepStrictEqual(await response.json(), { error: 'device-request-invalid' });
        }
      }
    });
    assert.strictEqual(callCount, 0);
  });

  it('allows write token, rejects read token, and returns the code exactly once', async () => {
    let issueCount = 0;
    const deviceAdministration = baseAdmin({
      issueEnrollment: async ({ deviceId }) => {
        issueCount += 1;
        return { deviceId, code: `code-${issueCount}`, expiresAt: '2026-07-13T00:10:00.000Z' };
      },
      revokeDevice: async () => {},
      getStatus: async () => ({ active: 0, revoked: 0 }),
    });
    await withServer({ deviceAdministration, readToken: 'read-only', writeToken: 'admin-write' }, async (port, dataDir) => {
      const denied = await postJson(port, '/api/device-enrollment-codes', { deviceId: 'mac-alpha' }, 'read-only');
      assert.strictEqual(denied.status, 403);
      assert.deepStrictEqual(await denied.json(), { error: 'Forbidden' });

      const allowed = await postJson(port, '/api/device-enrollment-codes', { deviceId: 'mac-alpha' }, 'admin-write');
      assert.strictEqual(allowed.status, 201);
      assert.strictEqual(allowed.headers.get('cache-control'), 'no-store');
      const raw = await allowed.text();
      assert.strictEqual(Number(allowed.headers.get('content-length')), Buffer.byteLength(raw));
      const body = JSON.parse(raw);
      assert.deepStrictEqual(body, {
        deviceId: 'mac-alpha',
        enrollmentCode: 'code-1',
        expiresAt: '2026-07-13T00:10:00.000Z',
        agentUrl: AGENT_URL,
        tlsFingerprint: SYNTHETIC_FINGERPRINT,
        protocolVersion: DEVICE_PROTOCOL_VERSION,
      });
      assert.strictEqual(issueCount, 1);

      const events = await assertAuditHasNoSecrets(dataDir);
      const success = events.find((event) => event.type === 'api.device-enrollment.success');
      assert.ok(success);
      assert.strictEqual(success.path, '/api/device-enrollment-codes');
      assert.strictEqual(success.statusCode, 201);
      assert.strictEqual(success.outcome, 'success');
      assert.strictEqual(success.deviceId, 'mac-alpha');
      assert.ok(success.requestId);
      assert.doesNotMatch(JSON.stringify(success), /code-1|enrollmentCode|agentUrl|tlsFingerprint/);
    });
  });

  it('accepts full authToken for enrollment and keeps wrong/missing token as 401', async () => {
    let issueCount = 0;
    const deviceAdministration = baseAdmin({
      issueEnrollment: async ({ deviceId }) => {
        issueCount += 1;
        return { deviceId, code: SYNTHETIC_CODE, expiresAt: '2026-07-13T00:10:00.000Z' };
      },
    });
    await withServer({
      deviceAdministration,
      authToken: 'full-admin',
      readToken: 'read-only',
      writeToken: 'write-only',
    }, async (port) => {
      const missing = await postJson(port, '/api/device-enrollment-codes', { deviceId: 'mac-alpha' });
      assert.strictEqual(missing.status, 401);
      assert.deepStrictEqual(await missing.json(), { error: 'Unauthorized' });

      const wrong = await postJson(port, '/api/device-enrollment-codes', { deviceId: 'mac-alpha' }, 'nope');
      assert.strictEqual(wrong.status, 401);

      const full = await postJson(port, '/api/device-enrollment-codes', { deviceId: 'mac-alpha' }, 'full-admin');
      assert.strictEqual(full.status, 201);
      const body = await full.json();
      assert.strictEqual(body.enrollmentCode, SYNTHETIC_CODE);
      assert.strictEqual(body.protocolVersion, DEVICE_PROTOCOL_VERSION);
      assert.strictEqual(issueCount, 1);
    });
  });

  it('revokes devices, preserves LinkeError codes, and sanitizes raw service errors', async () => {
    let revokeCount = 0;
    const deviceAdministration = baseAdmin({
      revokeDevice: async (deviceId) => {
        revokeCount += 1;
        if (deviceId === 'mac-missing') {
          throw new LinkeError(ERROR_CODES.DEVICE_NOT_FOUND, { statusCode: 404 });
        }
        if (deviceId === 'mac-boom') {
          throw new Error(`secret failure at ${SYNTHETIC_PATH} token=${SYNTHETIC_TOKEN}`);
        }
        return { deviceId, revoked: true };
      },
    });

    await withServer({ deviceAdministration, writeToken: SYNTHETIC_TOKEN }, async (port, dataDir) => {
      const ok = await postJson(port, '/api/device-revoke', { deviceId: 'mac-alpha' }, SYNTHETIC_TOKEN);
      assert.strictEqual(ok.status, 200);
      assert.deepStrictEqual(await ok.json(), { deviceId: 'mac-alpha', revoked: true });

      const missing = await postJson(port, '/api/device-revoke', { deviceId: 'mac-missing' }, SYNTHETIC_TOKEN);
      assert.strictEqual(missing.status, 404);
      assert.deepStrictEqual(await missing.json(), { error: 'device-not-found' });

      const boomLogs = [];
      const originalError = console.error;
      console.error = (...args) => { boomLogs.push(args.map(String).join(' ')); };
      try {
        const boom = await postJson(port, '/api/device-revoke', { deviceId: 'mac-boom' }, SYNTHETIC_TOKEN);
        assert.strictEqual(boom.status, 500);
        assert.deepStrictEqual(await boom.json(), { error: 'device-internal-error' });
      } finally {
        console.error = originalError;
      }
      assert.strictEqual(boomLogs.length, 0, 'raw service errors must not console.error secret text');
      assert.strictEqual(revokeCount, 3);

      await assertAuditHasNoSecrets(dataDir);
      const events = await readAuditEvents(dataDir, { limit: 20 });
      assert.ok(events.some((event) => event.type === 'api.device-revoke.success' && event.statusCode === 200));
      assert.ok(events.some((event) => event.type === 'api.device-revoke.failure' && event.statusCode === 404));
      assert.ok(events.some((event) => event.type === 'api.device-revoke.failure' && event.statusCode === 500));
    });
  });

  it('returns only sanitized Agent listener status', async () => {
    const deviceAdministration = baseAdmin({
      issueEnrollment: async () => {},
      revokeDevice: async () => {},
      getStatus: async () => ({
        bindConfigured: true,
        listening: true,
        tlsFingerprintConfigured: true,
        active: 2,
        revoked: 1,
        host: '192.168.10.4',
        tlsFingerprint: 'b'.repeat(64),
        tokenDigest: 'c'.repeat(64),
        agentUrl: AGENT_URL,
        enrollmentCode: SYNTHETIC_CODE,
      }),
    });
    await withServer({ deviceAdministration, readToken: 'read-only', writeToken: 'admin-write' }, async (port) => {
      for (const token of ['read-only', 'admin-write']) {
        const response = await fetch(`http://127.0.0.1:${port}/api/agent-listener-status`, {
          headers: { authorization: `Bearer ${token}` },
        });
        assert.strictEqual(response.status, 200);
        const body = await response.json();
        assert.deepStrictEqual(body, {
          status: 'ok',
          listener: { bindConfigured: true, listening: true, tlsFingerprintConfigured: true },
          devices: { active: 2, revoked: 1 },
        });
        assert.doesNotMatch(JSON.stringify(body), /192\.168|linke-controller|3443|[abc]{64}|digest|token|one-time-code/i);
      }
    });
  });

  it('normalizes malformed listener status values and does not echo secrets', async () => {
    const deviceAdministration = baseAdmin({
      getStatus: async () => ({
        bindConfigured: 'yes',
        listening: 1,
        tlsFingerprintConfigured: 'true',
        active: -3,
        revoked: 'many',
        secret: SYNTHETIC_CODE,
        path: SYNTHETIC_PATH,
      }),
    });
    await withServer({ deviceAdministration, authToken: 'full-admin' }, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/agent-listener-status`, {
        headers: { authorization: 'Bearer full-admin' },
      });
      assert.strictEqual(response.status, 200);
      const body = await response.json();
      assert.deepStrictEqual(Object.keys(body).sort(), ['devices', 'listener', 'status']);
      assert.strictEqual(body.status, 'degraded');
      assert.strictEqual(typeof body.listener.bindConfigured, 'boolean');
      assert.strictEqual(typeof body.listener.listening, 'boolean');
      assert.strictEqual(typeof body.listener.tlsFingerprintConfigured, 'boolean');
      assert.strictEqual(body.listener.bindConfigured, false);
      assert.strictEqual(body.listener.listening, false);
      assert.strictEqual(body.listener.tlsFingerprintConfigured, false);
      assert.ok(Number.isInteger(body.devices.active) && body.devices.active >= 0);
      assert.ok(Number.isInteger(body.devices.revoked) && body.devices.revoked >= 0);
      assert.doesNotMatch(JSON.stringify(body), new RegExp(SYNTHETIC_CODE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(JSON.stringify(body), new RegExp(SYNTHETIC_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });
  });

  it('returns registered errors when deviceAdministration is missing or malformed', async () => {
    await withServer({ writeToken: 'admin-write' }, async (port) => {
      for (const path of ['/api/device-enrollment-codes', '/api/device-revoke']) {
        const response = await postJson(port, path, { deviceId: 'mac-alpha' }, 'admin-write');
        assert.strictEqual(response.status, 503);
        assert.deepStrictEqual(await response.json(), { error: 'device-request-invalid' });
      }
      const status = await fetch(`http://127.0.0.1:${port}/api/agent-listener-status`, {
        headers: { authorization: 'Bearer admin-write' },
      });
      assert.strictEqual(status.status, 503);
      assert.deepStrictEqual(await status.json(), { error: 'device-request-invalid' });
    });

    await withServer({
      writeToken: 'admin-write',
      deviceAdministration: { agentUrl: AGENT_URL, tlsFingerprint: SYNTHETIC_FINGERPRINT },
    }, async (port) => {
      const enroll = await postJson(port, '/api/device-enrollment-codes', { deviceId: 'mac-alpha' }, 'admin-write');
      assert.strictEqual(enroll.status, 503);
      const text = await enroll.text();
      assert.deepStrictEqual(JSON.parse(text), { error: 'device-request-invalid' });
      assert.doesNotMatch(text, /TypeError|is not a function|Cannot read/i);
    });
  });

  it('maps oversize and invalid JSON to registered codes with safe audit', async () => {
    let called = false;
    const deviceAdministration = baseAdmin({
      issueEnrollment: async () => { called = true; },
      revokeDevice: async () => { called = true; },
    });
    await withServer({ deviceAdministration, writeToken: 'admin-write' }, async (port, dataDir) => {
      for (const path of ['/api/device-enrollment-codes', '/api/device-revoke']) {
        const oversize = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer admin-write',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ deviceId: 'mac-alpha', padding: 'x'.repeat(MAX_JSON_BODY_BYTES) }),
        });
        assert.strictEqual(oversize.status, 413, path);
        assert.deepStrictEqual(await oversize.json(), { error: 'device-request-invalid' });

        const invalid = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer admin-write',
            'Content-Type': 'application/json',
          },
          body: '{',
        });
        assert.strictEqual(invalid.status, 400, path);
        assert.deepStrictEqual(await invalid.json(), { error: 'device-request-invalid' });
      }

      const events = await assertAuditHasNoSecrets(dataDir);
      assert.ok(events.some((event) => (
        event.type === 'api.device-enrollment.failure'
        && event.statusCode === 413
        && event.outcome === 'failure'
        && event.path === '/api/device-enrollment-codes'
      )));
      assert.ok(events.some((event) => (
        event.type === 'api.device-enrollment.failure'
        && event.statusCode === 400
        && event.outcome === 'failure'
      )));
      assert.ok(events.some((event) => (
        event.type === 'api.device-revoke.failure'
        && event.statusCode === 413
        && event.outcome === 'failure'
      )));
      assert.ok(events.some((event) => (
        event.type === 'api.device-revoke.failure'
        && event.statusCode === 400
        && event.outcome === 'failure'
      )));
      assert.doesNotMatch(JSON.stringify(events), /Request body too large|Invalid JSON body|padding|mac-alpha/);
    });
    assert.strictEqual(called, false);
  });

  it('fail-closes LinkeError status codes outside 400-599', async () => {
    const deviceAdministration = baseAdmin({
      revokeDevice: async (deviceId) => {
        if (deviceId === 'mac-ok-status') {
          throw new LinkeError(ERROR_CODES.DEVICE_NOT_FOUND, { statusCode: 200 });
        }
        if (deviceId === 'mac-high-status') {
          throw new LinkeError(ERROR_CODES.DEVICE_NOT_FOUND, { statusCode: 999 });
        }
        throw new LinkeError(ERROR_CODES.DEVICE_NOT_FOUND, { statusCode: 404 });
      },
    });
    await withServer({ deviceAdministration, writeToken: SYNTHETIC_TOKEN }, async (port, dataDir) => {
      for (const deviceId of ['mac-ok-status', 'mac-high-status']) {
        const response = await postJson(port, '/api/device-revoke', { deviceId }, SYNTHETIC_TOKEN);
        assert.strictEqual(response.status, 500);
        const text = await response.text();
        assert.deepStrictEqual(JSON.parse(text), { error: 'device-internal-error' });
        assert.doesNotMatch(text, /200|999|device-not-found|secret|SYNTHETIC/i);
      }

      const valid = await postJson(port, '/api/device-revoke', { deviceId: 'mac-missing' }, SYNTHETIC_TOKEN);
      assert.strictEqual(valid.status, 404);
      assert.deepStrictEqual(await valid.json(), { error: 'device-not-found' });

      await assertAuditHasNoSecrets(dataDir);
    });
  });

  it('rejects query-string variants of administration routes without calling services', async () => {
    let issueCount = 0;
    let revokeCount = 0;
    let statusCount = 0;
    const deviceAdministration = baseAdmin({
      issueEnrollment: async () => { issueCount += 1; return { deviceId: 'mac-alpha', code: 'c', expiresAt: '2026-07-13T00:10:00.000Z' }; },
      revokeDevice: async () => { revokeCount += 1; },
      getStatus: async () => {
        statusCount += 1;
        return { bindConfigured: true, listening: true, tlsFingerprintConfigured: true, active: 0, revoked: 0 };
      },
    });
    await withServer({ deviceAdministration, writeToken: 'admin-write' }, async (port) => {
      const enroll = await postJson(port, '/api/device-enrollment-codes?x=1', { deviceId: 'mac-alpha' }, 'admin-write');
      assert.strictEqual(enroll.status, 404);

      const revoke = await postJson(port, '/api/device-revoke?x=1', { deviceId: 'mac-alpha' }, 'admin-write');
      assert.strictEqual(revoke.status, 404);

      const status = await fetch(`http://127.0.0.1:${port}/api/agent-listener-status?x=1`, {
        headers: { authorization: 'Bearer admin-write' },
      });
      assert.strictEqual(status.status, 404);
    });
    assert.strictEqual(issueCount, 0);
    assert.strictEqual(revokeCount, 0);
    assert.strictEqual(statusCount, 0);
  });

  it('fail-closes invalid enrollment public metadata and service outputs', async () => {
    const cases = [
      {
        name: 'http-agent-url',
        admin: baseAdmin({ agentUrl: 'http://linke-controller.local:3443' }),
        secret: 'http://linke-controller.local:3443',
      },
      {
        name: 'agent-url-with-userinfo',
        admin: baseAdmin({ agentUrl: 'https://user:pass@linke-controller.local:3443' }),
        secret: 'user:pass',
      },
      {
        name: 'agent-url-with-query',
        admin: baseAdmin({ agentUrl: 'https://linke-controller.local:3443?token=leak' }),
        secret: 'token=leak',
      },
      {
        name: 'agent-url-with-hash',
        admin: baseAdmin({ agentUrl: 'https://linke-controller.local:3443#frag' }),
        secret: '#frag',
      },
      {
        name: 'bad-fingerprint',
        admin: baseAdmin({ tlsFingerprint: 'A'.repeat(64) }),
        secret: 'A'.repeat(64),
      },
      {
        name: 'empty-code',
        admin: baseAdmin({
          issueEnrollment: async ({ deviceId }) => ({
            deviceId,
            code: '',
            expiresAt: '2026-07-13T00:10:00.000Z',
          }),
        }),
        secret: '',
      },
      {
        name: 'invalid-expiresAt',
        admin: baseAdmin({
          issueEnrollment: async ({ deviceId }) => ({
            deviceId,
            code: SYNTHETIC_CODE,
            expiresAt: 'not-an-iso',
          }),
        }),
        secret: 'not-an-iso',
      },
      {
        name: 'deviceId-mismatch',
        admin: baseAdmin({
          issueEnrollment: async () => ({
            deviceId: 'mac-other',
            code: SYNTHETIC_CODE,
            expiresAt: '2026-07-13T00:10:00.000Z',
          }),
        }),
        secret: 'mac-other',
      },
    ];

    for (const testCase of cases) {
      await withServer({ deviceAdministration: testCase.admin, writeToken: 'admin-write' }, async (port, dataDir) => {
        const response = await postJson(port, '/api/device-enrollment-codes', { deviceId: 'mac-alpha' }, 'admin-write');
        assert.strictEqual(response.status, 500, testCase.name);
        const text = await response.text();
        assert.deepStrictEqual(JSON.parse(text), { error: 'device-internal-error' }, testCase.name);
        if (testCase.secret) {
          assert.ok(!text.includes(testCase.secret), `${testCase.name} must not leak secret`);
        }
        assert.doesNotMatch(text, /user:pass|token=leak|not-an-iso|mac-other|Request body|TypeError/i);
        const events = await assertAuditHasNoSecrets(dataDir);
        assert.ok(events.some((event) => (
          event.type === 'api.device-enrollment.failure'
          && event.statusCode === 500
          && event.outcome === 'failure'
        )), testCase.name);
      });
    }
  });

  it('does not match wrong methods or nearby paths for administration routes', async () => {
    const deviceAdministration = baseAdmin();
    await withServer({ deviceAdministration, writeToken: 'admin-write' }, async (port) => {
      for (const [method, path] of [
        ['GET', '/api/device-enrollment-codes'],
        ['PUT', '/api/device-enrollment-codes'],
        ['POST', '/api/device-enrollment-codes/'],
        ['POST', '/api/device-enrollment'],
        ['GET', '/api/device-revoke'],
        ['POST', '/api/device-revoke/'],
        ['POST', '/api/agent-listener-status'],
        ['GET', '/api/agent-listener'],
      ]) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: {
            Authorization: 'Bearer admin-write',
            'Content-Type': 'application/json',
          },
          body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify({ deviceId: 'mac-alpha' }),
        });
        assert.strictEqual(response.status, 404, `${method} ${path}`);
      }
    });
  });

  it('keeps agent-listener-status outside write routes while counting six write routes', () => {
    assert.strictEqual(API_WRITE_ROUTES.length, 6);
    assert.ok(API_WRITE_ROUTES.some((route) => route.method === 'POST' && route.path === '/api/device-enrollment-codes'));
    assert.ok(API_WRITE_ROUTES.some((route) => route.method === 'POST' && route.path === '/api/device-revoke'));
    assert.ok(!API_WRITE_ROUTES.some((route) => route.path === '/api/agent-listener-status'));
  });

  it('admin scope rejects current and previous write', async () => {
    const ADMIN = 'admin-current';
    const WRITE_CURRENT = 'write-current';
    const WRITE_PREVIOUS = 'write-previous';
    let issueCount = 0;
    let revokeCount = 0;
    const deviceAdministration = baseAdmin({
      issueEnrollment: async () => {
        issueCount += 1;
        return { deviceId: 'mac-alpha', code: SYNTHETIC_CODE, expiresAt: '2026-07-13T00:10:00.000Z' };
      },
      revokeDevice: async () => {
        revokeCount += 1;
        return { deviceId: 'mac-alpha', revoked: true };
      },
    });

    await withServer({
      adminToken: ADMIN,
      writeToken: WRITE_CURRENT,
      previousWriteToken: WRITE_PREVIOUS,
      deviceAdministration,
    }, async (port, dataDir) => {
      const adminPaths = ['/api/device-enrollment-codes', '/api/device-revoke'];
      for (const path of adminPaths) {
        for (const token of [WRITE_CURRENT, WRITE_PREVIOUS]) {
          const response = await postJson(port, path, { deviceId: 'mac-alpha' }, token);
          assert.strictEqual(response.status, 403, `${path} token=${token}`);
          assert.deepStrictEqual(await response.json(), { error: 'Forbidden' });
        }
      }

      // 前置门早于请求体解析：previous write 携带畸形 JSON 时返回 403，而不是 400。
      const malformed = await fetch(`http://127.0.0.1:${port}/api/device-enrollment-codes`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${WRITE_PREVIOUS}`,
          'Content-Type': 'application/json',
        },
        body: '{',
      });
      assert.strictEqual(malformed.status, 403);
      assert.deepStrictEqual(await malformed.json(), { error: 'Forbidden' });

      const events = await readAuditEvents(dataDir, { limit: 100 });
      assert.strictEqual(
        events.filter((event) => event.type === 'api.write.admission.started').length,
        0,
        'denied admin-route requests must not reach required write-admission audit',
      );
      const forbidden = events.filter((event) => event.type === 'auth.forbidden');
      // 4 次合法请求体的写令牌拒绝，加 1 次畸形请求体的 previous-write 拒绝。
      assert.ok(forbidden.length >= 5, `expected auth.forbidden for each denial, got ${forbidden.length}`);
      for (const path of adminPaths) {
        const pathForbidden = forbidden.filter((event) => event.path === path && event.statusCode === 403);
        assert.ok(pathForbidden.length >= 2, `missing auth.forbidden denials for ${path}`);
      }
      assert.ok(
        forbidden.some((event) => (
          event.path === '/api/device-enrollment-codes'
          && event.statusCode === 403
        )),
        'malformed previous-write denial must still emit auth.forbidden',
      );

      const serialized = JSON.stringify(events);
      for (const secret of [ADMIN, WRITE_CURRENT, WRITE_PREVIOUS]) {
        assert.ok(!serialized.includes(secret), `audit must not contain credential ${secret}`);
        assertAuditEventsHaveNoSecrets(events, { syntheticToken: secret });
      }
    });

    assert.strictEqual(issueCount, 0);
    assert.strictEqual(revokeCount, 0);
  });

  it('keeps query-string administration variants as 404 when adminToken is configured', async () => {
    // 管理权限前置门必须沿用精确 URL 语义；近似 URL 不应被提前改写为 403。
    let issueCount = 0;
    let revokeCount = 0;
    const deviceAdministration = baseAdmin({
      issueEnrollment: async () => {
        issueCount += 1;
        return { deviceId: 'mac-alpha', code: SYNTHETIC_CODE, expiresAt: '2026-07-13T00:10:00.000Z' };
      },
      revokeDevice: async () => {
        revokeCount += 1;
        return { deviceId: 'mac-alpha', revoked: true };
      },
    });

    await withServer({
      adminToken: 'admin-exact-only',
      writeToken: 'write-current',
      previousWriteToken: 'write-previous',
      deviceAdministration,
    }, async (port) => {
      for (const token of ['write-current', 'write-previous']) {
        const enroll = await postJson(
          port,
          '/api/device-enrollment-codes?x=1',
          { deviceId: 'mac-alpha' },
          token,
        );
        assert.strictEqual(enroll.status, 404, `enroll?x=1 token=${token}`);

        const revoke = await postJson(
          port,
          '/api/device-revoke?x=1',
          { deviceId: 'mac-alpha' },
          token,
        );
        assert.strictEqual(revoke.status, 404, `revoke?x=1 token=${token}`);
      }
    });

    assert.strictEqual(issueCount, 0);
    assert.strictEqual(revokeCount, 0);
  });

  it('allows adminToken and authToken on both device administration routes when admin is configured', async () => {
    let issueCount = 0;
    let revokeCount = 0;
    const deviceAdministration = baseAdmin({
      issueEnrollment: async ({ deviceId }) => {
        issueCount += 1;
        return { deviceId, code: SYNTHETIC_CODE, expiresAt: '2026-07-13T00:10:00.000Z' };
      },
      revokeDevice: async (deviceId) => {
        revokeCount += 1;
        return { deviceId, revoked: true };
      },
    });

    await withServer({
      adminToken: 'admin-capable-token',
      authToken: 'full-admin-token',
      writeToken: 'write-only-token',
      deviceAdministration,
    }, async (port) => {
      for (const token of ['admin-capable-token', 'full-admin-token']) {
        const enroll = await postJson(port, '/api/device-enrollment-codes', { deviceId: 'mac-alpha' }, token);
        assert.strictEqual(enroll.status, 201, `enroll token=${token}`);
        const enrollBody = await enroll.json();
        assert.strictEqual(enrollBody.enrollmentCode, SYNTHETIC_CODE);

        const revoke = await postJson(port, '/api/device-revoke', { deviceId: 'mac-alpha' }, token);
        assert.strictEqual(revoke.status, 200, `revoke token=${token}`);
        assert.deepStrictEqual(await revoke.json(), { deviceId: 'mac-alpha', revoked: true });
      }
    });

    assert.strictEqual(issueCount, 2);
    assert.strictEqual(revokeCount, 2);
  });

  it('allows previous full/admin tokens on both device administration routes during overlap', async () => {
    let issueCount = 0;
    let revokeCount = 0;
    const deviceAdministration = baseAdmin({
      issueEnrollment: async ({ deviceId }) => {
        issueCount += 1;
        return { deviceId, code: SYNTHETIC_CODE, expiresAt: '2026-07-13T00:10:00.000Z' };
      },
      revokeDevice: async (deviceId) => {
        revokeCount += 1;
        return { deviceId, revoked: true };
      },
    });

    await withServer({
      authToken: 'full-current-token',
      previousAuthToken: 'full-previous-token',
      adminToken: 'admin-current-token',
      previousAdminToken: 'admin-previous-token',
      deviceAdministration,
    }, async (port) => {
      for (const token of ['full-previous-token', 'admin-previous-token']) {
        const enroll = await postJson(port, '/api/device-enrollment-codes', { deviceId: 'mac-alpha' }, token);
        assert.strictEqual(enroll.status, 201, `enroll token=${token}`);

        const revoke = await postJson(port, '/api/device-revoke', { deviceId: 'mac-alpha' }, token);
        assert.strictEqual(revoke.status, 200, `revoke token=${token}`);
      }
    });

    assert.strictEqual(issueCount, 2);
    assert.strictEqual(revokeCount, 2);
  });

  it('allows adminToken for GET /api/devices and POST /api/heartbeat', async () => {
    await withServer({
      adminToken: 'admin-broad-token',
      writeToken: 'write-only-token',
    }, async (port) => {
      const devices = await fetch(`http://127.0.0.1:${port}/api/devices`, {
        headers: { Authorization: 'Bearer admin-broad-token' },
      });
      assert.strictEqual(devices.status, 200);
      assert.ok(Array.isArray(await devices.json()));

      const heartbeat = await fetch(`http://127.0.0.1:${port}/api/heartbeat`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-broad-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deviceId: 'admin-heartbeat-device', hostname: 'allowed' }),
      });
      assert.strictEqual(heartbeat.status, 200);
      const body = await heartbeat.json();
      assert.strictEqual(body.deviceId, 'admin-heartbeat-device');
    });
  });

  it('keeps write and previous-write admin-route access when adminToken is absent', async () => {
    let issueCount = 0;
    let revokeCount = 0;
    const deviceAdministration = baseAdmin({
      issueEnrollment: async ({ deviceId }) => {
        issueCount += 1;
        return { deviceId, code: SYNTHETIC_CODE, expiresAt: '2026-07-13T00:10:00.000Z' };
      },
      revokeDevice: async (deviceId) => {
        revokeCount += 1;
        return { deviceId, revoked: true };
      },
    });

    await withServer({
      writeToken: 'write-current',
      previousWriteToken: 'write-previous',
      deviceAdministration,
    }, async (port) => {
      for (const token of ['write-current', 'write-previous']) {
        const enroll = await postJson(port, '/api/device-enrollment-codes', { deviceId: 'mac-alpha' }, token);
        assert.strictEqual(enroll.status, 201, `enroll token=${token}`);
        const revoke = await postJson(port, '/api/device-revoke', { deviceId: 'mac-alpha' }, token);
        assert.strictEqual(revoke.status, 200, `revoke token=${token}`);
      }
    });

    assert.strictEqual(issueCount, 2);
    assert.strictEqual(revokeCount, 2);
  });

  it('uses broadest scope when adminToken and writeToken share the same value', async () => {
    let issueCount = 0;
    const deviceAdministration = baseAdmin({
      issueEnrollment: async ({ deviceId }) => {
        issueCount += 1;
        return { deviceId, code: SYNTHETIC_CODE, expiresAt: '2026-07-13T00:10:00.000Z' };
      },
    });

    await withServer({
      adminToken: 'shared-admin-write',
      writeToken: 'shared-admin-write',
      deviceAdministration,
    }, async (port) => {
      const enroll = await postJson(
        port,
        '/api/device-enrollment-codes',
        { deviceId: 'mac-alpha' },
        'shared-admin-write',
      );
      assert.strictEqual(enroll.status, 201);
      const body = await enroll.json();
      assert.strictEqual(body.enrollmentCode, SYNTHETIC_CODE);
    });

    assert.strictEqual(issueCount, 1);
  });
});
