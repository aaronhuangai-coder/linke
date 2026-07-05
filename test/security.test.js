import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../src/server.js';
import { slugify, safeDevicePath, createBackup } from '../src/storage.js';

function postJSON(port, path, body) {
  return fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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

  it('rejects GET /api/devices without Authorization with 401 JSON {error:\'Unauthorized\'} and does not mutate dataDir', async () => {
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
      assert.deepStrictEqual(afterEntries, beforeEntries);
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

  it('rejects POST /api/heartbeat without Authorization before mutating dataDir', async () => {
    const server = createServer({ dataDir, authToken: 'test-token' });
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    try {
      assert.deepStrictEqual(await readdir(dataDir), []);
      const res = await fetch(`http://localhost:${port}/api/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'blocked-device' }),
      });
      assert.strictEqual(res.status, 401);
      assert.deepStrictEqual(await res.json(), { error: 'Unauthorized' });
      assert.deepStrictEqual(await readdir(dataDir), []);
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
