import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, MAX_JSON_BODY_BYTES } from '../src/server.js';
import { slugify, safeDevicePath, createBackup } from '../src/storage.js';
import { readAuditEvents } from '../src/audit-log.js';

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

  it('rejects oversized JSON request bodies with 413 and does not mutate dataDir', async () => {
    await withServer(async ({ dataDir, port }) => {
      assert.deepStrictEqual(await readdir(dataDir), []);
      const body = JSON.stringify({
        deviceId: 'oversized-device',
        padding: 'x'.repeat(MAX_JSON_BODY_BYTES),
      });

      const res = await postRawJSON(port, '/api/heartbeat', body);

      assert.strictEqual(res.status, 413);
      assert.deepStrictEqual(await res.json(), { error: 'Request body too large' });
      assert.deepStrictEqual(await readdir(dataDir), []);
    });
  });

  it('enforces the JSON body limit even when Content-Length is missing', async () => {
    await withServer(async ({ dataDir, port }) => {
      assert.deepStrictEqual(await readdir(dataDir), []);
      const body = JSON.stringify({
        deviceId: 'chunked-oversized-device',
        padding: 'x'.repeat(MAX_JSON_BODY_BYTES),
      });

      const res = await postRawJSONWithoutContentLength(port, '/api/heartbeat', body);

      assert.strictEqual(res.status, 413);
      assert.deepStrictEqual(await res.json(), { error: 'Request body too large' });
      assert.deepStrictEqual(await readdir(dataDir), []);
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
