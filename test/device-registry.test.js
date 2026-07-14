import { describe, it } from 'node:test';
import assert from 'node:assert';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DeviceRegistry } from '../src/device-registry.js';

function isRegisteredLinkeError(error, code, statusCode) {
  return error
    && error.name === 'LinkeError'
    && error.code === code
    && error.message === code
    && (statusCode === undefined || error.statusCode === statusCode)
    && error.code !== null
    && !String(error.stack || '').includes('TypeError')
    && !String(error.message || '').includes('Cannot destructure');
}

async function withRegistry(prefix, fn, options = {}) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    const registry = new DeviceRegistry({ dataDir: root, ...options });
    await fn(registry, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('DeviceRegistry', () => {
  it('persists only digests and atomically consumes one enrollment once', async () => {
    let now = new Date('2026-07-13T00:00:00.000Z');
    await withRegistry('linke-device-registry-', async (registry, root) => {
      const issued = await registry.issueEnrollment({ deviceId: 'mac-alpha' });
      assert.match(issued.code, /^[A-Za-z0-9_-]{43}$/);
      assert.strictEqual(issued.expiresAt, '2026-07-13T00:10:00.000Z');
      const enrolled = await registry.consumeEnrollment({
        deviceId: 'mac-alpha', code: issued.code, protocolVersion: 2,
      });
      assert.match(enrolled.token, /^[A-Za-z0-9_-]{43}$/);
      await assert.rejects(
        registry.consumeEnrollment({ deviceId: 'mac-alpha', code: issued.code, protocolVersion: 2 }),
        (error) => error.code === 'device-enrollment-invalid',
      );
      const raw = await readFile(join(root, 'device-registry-v1.json'), 'utf8');
      assert.ok(!raw.includes(issued.code));
      assert.ok(!raw.includes(enrolled.token));
      assert.match(raw, /"codeDigest":"[a-f0-9]{64}"/);
      assert.match(raw, /"tokenDigest":"[a-f0-9]{64}"/);
      assert.ok(!/"code"\s*:/.test(raw));
      assert.ok(!/"token"\s*:/.test(raw));
    }, { now: () => now });
  });

  it('rejects expired enrollment and concurrent double consumption', async () => {
    let now = new Date('2026-07-13T00:00:00.000Z');
    await withRegistry('linke-device-expiry-', async (registry) => {
      const expired = await registry.issueEnrollment({ deviceId: 'mac-expired' });
      now = new Date('2026-07-13T00:10:00.001Z');
      await assert.rejects(
        registry.consumeEnrollment({ deviceId: 'mac-expired', code: expired.code, protocolVersion: 2 }),
        (error) => error.code === 'device-enrollment-invalid',
      );

      now = new Date('2026-07-13T00:20:00.000Z');
      const concurrent = await registry.issueEnrollment({ deviceId: 'mac-race' });
      const results = await Promise.allSettled([
        registry.consumeEnrollment({ deviceId: 'mac-race', code: concurrent.code, protocolVersion: 2 }),
        registry.consumeEnrollment({ deviceId: 'mac-race', code: concurrent.code, protocolVersion: 2 }),
      ]);
      assert.strictEqual(results.filter((result) => result.status === 'fulfilled').length, 1);
      assert.strictEqual(results.filter((result) => result.status === 'rejected').length, 1);
      assert.strictEqual(
        results.find((result) => result.status === 'rejected').reason.code,
        'device-enrollment-invalid',
      );
    }, { now: () => now });
  });

  it('keeps enrollment valid exactly at expiresAt boundary', async () => {
    let now = new Date('2026-07-13T00:00:00.000Z');
    await withRegistry('linke-device-boundary-', async (registry) => {
      const issued = await registry.issueEnrollment({ deviceId: 'mac-boundary' });
      now = new Date('2026-07-13T00:10:00.000Z');
      const enrolled = await registry.consumeEnrollment({
        deviceId: 'mac-boundary', code: issued.code, protocolVersion: 2,
      });
      assert.strictEqual(enrolled.deviceId, 'mac-boundary');
    }, { now: () => now });
  });

  it('binds token scope, rotates atomically and revokes immediately', async () => {
    await withRegistry('linke-device-auth-', async (registry) => {
      const issued = await registry.issueEnrollment({ deviceId: 'mac-alpha' });
      const enrolled = await registry.consumeEnrollment({
        deviceId: 'mac-alpha', code: issued.code, protocolVersion: 2,
      });
      assert.strictEqual((await registry.authenticate({
        deviceId: 'mac-alpha', token: enrolled.token, protocolVersion: 2,
      })).deviceId, 'mac-alpha');
      await assert.rejects(
        registry.authenticate({ deviceId: 'mac-beta', token: enrolled.token, protocolVersion: 2 }),
        (error) => error.code === 'device-scope-mismatch' && error.statusCode === 403,
      );
      await assert.rejects(
        registry.authenticate({ deviceId: 'mac-alpha', token: 'x'.repeat(43), protocolVersion: 2 }),
        (error) => error.code === 'device-token-invalid' && error.statusCode === 401,
      );
      const pending = await registry.beginTokenRotation({
        deviceId: 'mac-alpha', token: enrolled.token, protocolVersion: 2,
      });
      assert.strictEqual((await registry.authenticate({
        deviceId: 'mac-alpha', token: enrolled.token, protocolVersion: 2,
      })).deviceId, 'mac-alpha');
      // pending token is confirm-only before confirm
      await assert.rejects(
        registry.authenticate({ deviceId: 'mac-alpha', token: pending.token, protocolVersion: 2 }),
        (error) => error.code === 'device-token-invalid',
      );
      await registry.confirmTokenRotation({
        deviceId: 'mac-alpha', token: pending.token, protocolVersion: 2,
      });
      await assert.rejects(
        registry.authenticate({ deviceId: 'mac-alpha', token: enrolled.token, protocolVersion: 2 }),
        (error) => error.code === 'device-token-invalid',
      );
      assert.strictEqual((await registry.authenticate({
        deviceId: 'mac-alpha', token: pending.token, protocolVersion: 2,
      })).deviceId, 'mac-alpha');
      await registry.revokeDevice('mac-alpha');
      await assert.rejects(
        registry.authenticate({ deviceId: 'mac-alpha', token: pending.token, protocolVersion: 2 }),
        (error) => error.code === 'device-revoked' && error.statusCode === 403,
      );
      await assert.rejects(
        registry.revokeDevice('mac-missing'),
        (error) => error.code === 'device-not-found' && error.statusCode === 404,
      );
    });
  });

  it('expires pending rotation tokens at the 10-minute boundary', async () => {
    let now = new Date('2026-07-13T00:00:00.000Z');
    await withRegistry('linke-device-pending-ttl-', async (registry) => {
      const issued = await registry.issueEnrollment({ deviceId: 'mac-rotate' });
      const enrolled = await registry.consumeEnrollment({
        deviceId: 'mac-rotate', code: issued.code, protocolVersion: 2,
      });
      const pending = await registry.beginTokenRotation({
        deviceId: 'mac-rotate', token: enrolled.token, protocolVersion: 2,
      });
      assert.strictEqual(pending.expiresAt, '2026-07-13T00:10:00.000Z');
      now = new Date('2026-07-13T00:10:00.000Z');
      await registry.confirmTokenRotation({
        deviceId: 'mac-rotate', token: pending.token, protocolVersion: 2,
      });

      const issued2 = await registry.issueEnrollment({ deviceId: 'mac-rotate-late' });
      const enrolled2 = await registry.consumeEnrollment({
        deviceId: 'mac-rotate-late', code: issued2.code, protocolVersion: 2,
      });
      now = new Date('2026-07-13T00:20:00.000Z');
      const pending2 = await registry.beginTokenRotation({
        deviceId: 'mac-rotate-late', token: enrolled2.token, protocolVersion: 2,
      });
      now = new Date('2026-07-13T00:30:00.001Z');
      await assert.rejects(
        registry.confirmTokenRotation({
          deviceId: 'mac-rotate-late', token: pending2.token, protocolVersion: 2,
        }),
        (error) => error.code === 'device-token-invalid',
      );
      assert.strictEqual((await registry.authenticate({
        deviceId: 'mac-rotate-late', token: enrolled2.token, protocolVersion: 2,
      })).deviceId, 'mac-rotate-late');
    }, { now: () => now });
  });

  it('requires explicit acceptance before a controller fingerprint change', async () => {
    await withRegistry('linke-controller-fingerprint-', async (registry) => {
      await registry.verifyControllerFingerprint('a'.repeat(64));
      const issued = await registry.issueEnrollment({ deviceId: 'mac-alpha' });
      const enrolled = await registry.consumeEnrollment({
        deviceId: 'mac-alpha', code: issued.code, protocolVersion: 2,
      });
      const issuedBeta = await registry.issueEnrollment({ deviceId: 'mac-beta' });
      const enrolledBeta = await registry.consumeEnrollment({
        deviceId: 'mac-beta', code: issuedBeta.code, protocolVersion: 1,
      });
      await assert.rejects(
        registry.verifyControllerFingerprint('b'.repeat(64)),
        (error) => error.code === 'device-tls-fingerprint-mismatch',
      );
      await registry.acceptControllerFingerprint('b'.repeat(64));
      const status = await registry.getStatus();
      assert.deepStrictEqual(status, { active: 0, revoked: 0, suspended: 2 });
      await assert.rejects(
        registry.authenticate({ deviceId: 'mac-alpha', token: enrolled.token, protocolVersion: 2 }),
        (error) => error.code === 'device-token-invalid',
      );
      await assert.rejects(
        registry.authenticate({ deviceId: 'mac-beta', token: enrolledBeta.token, protocolVersion: 1 }),
        (error) => error.code === 'device-token-invalid',
      );
      // re-enrollment restores active under the accepted fingerprint
      const reissue = await registry.issueEnrollment({ deviceId: 'mac-alpha' });
      const reenrolled = await registry.consumeEnrollment({
        deviceId: 'mac-alpha', code: reissue.code, protocolVersion: 2,
      });
      assert.strictEqual((await registry.authenticate({
        deviceId: 'mac-alpha', token: reenrolled.token, protocolVersion: 2,
      })).deviceId, 'mac-alpha');
      assert.deepStrictEqual(await registry.getStatus(), { active: 1, revoked: 0, suspended: 1 });
    });
  });

  it('rejects unsupported protocol and device protocol binding mismatches', async () => {
    await withRegistry('linke-device-protocol-', async (registry) => {
      const issued = await registry.issueEnrollment({ deviceId: 'mac-proto' });
      await assert.rejects(
        registry.consumeEnrollment({ deviceId: 'mac-proto', code: issued.code, protocolVersion: 3 }),
        (error) => error.code === 'device-protocol-unsupported' && error.statusCode === 426,
      );
      const enrolled = await registry.consumeEnrollment({
        deviceId: 'mac-proto', code: issued.code, protocolVersion: 2,
      });
      await assert.rejects(
        registry.authenticate({ deviceId: 'mac-proto', token: enrolled.token, protocolVersion: 1 }),
        (error) => error.code === 'device-protocol-unsupported' && error.statusCode === 426,
      );
      await assert.rejects(
        registry.beginTokenRotation({ deviceId: 'mac-proto', token: enrolled.token, protocolVersion: 1 }),
        (error) => error.code === 'device-protocol-unsupported' && error.statusCode === 426,
      );
      assert.strictEqual((await registry.authenticate({
        deviceId: 'mac-proto', token: enrolled.token, protocolVersion: 2,
      })).deviceId, 'mac-proto');
    });
  });

  it('rejects invalid device ids without leaking input details', async () => {
    await withRegistry('linke-device-id-', async (registry) => {
      for (const deviceId of ['', 'Mac-Alpha', 'bad_id', 'a'.repeat(64), '../etc']) {
        await assert.rejects(
          registry.issueEnrollment({ deviceId }),
          (error) => (
            error.code === 'device-scope-mismatch'
            && error.statusCode === 400
            && error.message === 'device-scope-mismatch'
            && !String(error.stack || '').includes('../etc')
          ),
        );
      }
    });
  });

  it('continues the mutation queue after a rejected operation', async () => {
    await withRegistry('linke-device-queue-', async (registry) => {
      await assert.rejects(
        registry.revokeDevice('never-enrolled'),
        (error) => error.code === 'device-not-found',
      );
      const issued = await registry.issueEnrollment({ deviceId: 'mac-queue' });
      const enrolled = await registry.consumeEnrollment({
        deviceId: 'mac-queue', code: issued.code, protocolVersion: 2,
      });
      assert.strictEqual((await registry.authenticate({
        deviceId: 'mac-queue', token: enrolled.token, protocolVersion: 2,
      })).deviceId, 'mac-queue');
    });
  });

  it('fails closed on corrupt registry state without treating it as empty', async () => {
    await withRegistry('linke-device-corrupt-', async (registry, root) => {
      const path = join(root, 'device-registry-v1.json');
      await writeFile(path, '{not-json');
      await assert.rejects(
        registry.getStatus(),
        (error) => (
          error.code === 'device-internal-error'
          && error.message === 'device-internal-error'
          && !error.message.includes(root)
          && !error.message.includes('JSON')
        ),
      );
      await writeFile(path, JSON.stringify({
        schemaVersion: 99, controllerTlsFingerprint: null, enrollments: [], devices: [],
      }));
      await assert.rejects(
        registry.issueEnrollment({ deviceId: 'mac-corrupt' }),
        (error) => error.code === 'device-internal-error',
      );
      await writeFile(path, JSON.stringify({
        schemaVersion: 1,
        controllerTlsFingerprint: null,
        enrollments: [],
        devices: [{
          deviceId: 'mac-bad',
          tokenDigest: 'not-a-digest',
          protocolVersion: 2,
          status: 'active',
          enrolledAt: '2026-07-13T00:00:00.000Z',
          rotatedAt: null,
          revokedAt: null,
          pendingTokenDigest: null,
          pendingTokenExpiresAt: null,
        }],
      }));
      await assert.rejects(
        registry.authenticate({
          deviceId: 'mac-bad', token: 'a'.repeat(43), protocolVersion: 2,
        }),
        (error) => (
          error.code === 'device-internal-error'
          && error.name === 'LinkeError'
        ),
      );
      // corrupt state is not silently replaced by empty enrollments
      await assert.rejects(
        registry.issueEnrollment({ deviceId: 'mac-after-corrupt' }),
        (error) => error.code === 'device-internal-error',
      );
    });
  });

  it('waits for queued mutations before reads observe new status', async () => {
    await withRegistry('linke-device-read-queue-', async (registry) => {
      const issued = await registry.issueEnrollment({ deviceId: 'mac-read' });
      const enrolled = await registry.consumeEnrollment({
        deviceId: 'mac-read', code: issued.code, protocolVersion: 2,
      });
      const revokePromise = registry.revokeDevice('mac-read');
      const authPromise = registry.authenticate({
        deviceId: 'mac-read', token: enrolled.token, protocolVersion: 2,
      });
      await revokePromise;
      await assert.rejects(authPromise, (error) => error.code === 'device-revoked');
    });
  });

  it('rejects unsafe injected now/randomToken without leaking internals', async () => {
    await withRegistry('linke-device-inject-', async (registry) => {
      await assert.rejects(
        registry.issueEnrollment({ deviceId: 'mac-inject' }),
        (error) => isRegisteredLinkeError(error, 'device-internal-error'),
      );
    }, { now: () => 'not-a-date' });

    await withRegistry('linke-device-inject-token-', async (registry) => {
      await assert.rejects(
        registry.issueEnrollment({ deviceId: 'mac-inject' }),
        (error) => isRegisteredLinkeError(error, 'device-internal-error'),
      );
    }, {
      now: () => new Date('2026-07-13T00:00:00.000Z'),
      randomToken: () => 'short',
    });
  });

  it('fails closed on unknown schema keys and never rewrites plaintext markers', async () => {
    await withRegistry('linke-device-unknown-keys-', async (registry, root) => {
      const path = join(root, 'device-registry-v1.json');
      const marker = 'synthetic-marker';
      await writeFile(path, `${JSON.stringify({
        schemaVersion: 1,
        controllerTlsFingerprint: null,
        enrollments: [],
        devices: [],
        token: marker,
      })}\n`);
      await assert.rejects(
        registry.issueEnrollment({ deviceId: 'mac-unknown-root' }),
        (error) => isRegisteredLinkeError(error, 'device-internal-error'),
      );
      const afterRoot = await readFile(path, 'utf8');
      assert.ok(afterRoot.includes(marker));
      assert.ok(afterRoot.includes('"token"'));
      // mutation must not succeed or strip/rewrite the corrupt file as empty/valid
      assert.ok(!afterRoot.includes('mac-unknown-root'));

      await writeFile(path, `${JSON.stringify({
        schemaVersion: 1,
        controllerTlsFingerprint: null,
        enrollments: [{
          deviceId: 'mac-enroll',
          codeDigest: 'a'.repeat(64),
          issuedAt: '2026-07-13T00:00:00.000Z',
          expiresAt: '2026-07-13T00:10:00.000Z',
          usedAt: null,
          code: marker,
        }],
        devices: [],
      })}\n`);
      await assert.rejects(
        registry.getStatus(),
        (error) => isRegisteredLinkeError(error, 'device-internal-error'),
      );

      await writeFile(path, `${JSON.stringify({
        schemaVersion: 1,
        controllerTlsFingerprint: null,
        enrollments: [],
        devices: [{
          deviceId: 'mac-device',
          tokenDigest: 'b'.repeat(64),
          protocolVersion: 2,
          status: 'active',
          enrolledAt: '2026-07-13T00:00:00.000Z',
          rotatedAt: null,
          revokedAt: null,
          pendingTokenDigest: null,
          pendingTokenExpiresAt: null,
          token: marker,
        }],
      })}\n`);
      await assert.rejects(
        registry.authenticate({
          deviceId: 'mac-device', token: 'c'.repeat(43), protocolVersion: 2,
        }),
        (error) => isRegisteredLinkeError(error, 'device-internal-error'),
      );
      await assert.rejects(
        registry.issueEnrollment({ deviceId: 'mac-after-device-marker' }),
        (error) => isRegisteredLinkeError(error, 'device-internal-error'),
      );
      const afterDevice = await readFile(path, 'utf8');
      assert.ok(afterDevice.includes(marker));
      assert.ok(!afterDevice.includes('mac-after-device-marker'));
    });
  });

  it('rejects unpaired pending fields, duplicate deviceIds and status/time mismatch', async () => {
    await withRegistry('linke-device-schema-self-', async (registry, root) => {
      const path = join(root, 'device-registry-v1.json');
      const baseDevice = {
        deviceId: 'mac-self',
        tokenDigest: 'd'.repeat(64),
        protocolVersion: 2,
        status: 'active',
        enrolledAt: '2026-07-13T00:00:00.000Z',
        rotatedAt: null,
        revokedAt: null,
        pendingTokenDigest: 'e'.repeat(64),
        pendingTokenExpiresAt: null,
      };
      await writeFile(path, `${JSON.stringify({
        schemaVersion: 1,
        controllerTlsFingerprint: null,
        enrollments: [],
        devices: [baseDevice],
      })}\n`);
      await assert.rejects(
        registry.getStatus(),
        (error) => isRegisteredLinkeError(error, 'device-internal-error'),
      );

      await writeFile(path, `${JSON.stringify({
        schemaVersion: 1,
        controllerTlsFingerprint: null,
        enrollments: [],
        devices: [
          { ...baseDevice, pendingTokenDigest: null, pendingTokenExpiresAt: null },
          { ...baseDevice, pendingTokenDigest: null, pendingTokenExpiresAt: null },
        ],
      })}\n`);
      await assert.rejects(
        registry.getStatus(),
        (error) => isRegisteredLinkeError(error, 'device-internal-error'),
      );

      await writeFile(path, `${JSON.stringify({
        schemaVersion: 1,
        controllerTlsFingerprint: null,
        enrollments: [],
        devices: [{
          ...baseDevice,
          pendingTokenDigest: null,
          pendingTokenExpiresAt: null,
          status: 'revoked',
          revokedAt: null,
        }],
      })}\n`);
      await assert.rejects(
        registry.getStatus(),
        (error) => isRegisteredLinkeError(error, 'device-internal-error'),
      );
    });
  });

  it('publishes registry files as mode 0600 even when a 0644 .new already exists', async () => {
    await withRegistry('linke-device-mode-', async (registry, root) => {
      const tempPath = join(root, 'device-registry-v1.json.new');
      const statePath = join(root, 'device-registry-v1.json');
      await writeFile(tempPath, 'stale-temp\n', { mode: 0o644 });
      assert.strictEqual((await stat(tempPath)).mode & 0o777, 0o644);
      await registry.issueEnrollment({ deviceId: 'mac-mode' });
      const published = await stat(statePath);
      assert.strictEqual(published.mode & 0o777, 0o600);
      const raw = await readFile(statePath, 'utf8');
      assert.ok(!raw.includes('stale-temp'));
    });
  });

  it('maps null requests and throwing providers to registered LinkeError only', async () => {
    await withRegistry('linke-device-null-api-', async (registry) => {
      await assert.rejects(
        registry.issueEnrollment(null),
        (error) => isRegisteredLinkeError(error, 'device-scope-mismatch', 400),
      );
      await assert.rejects(
        registry.issueEnrollment(undefined),
        (error) => isRegisteredLinkeError(error, 'device-scope-mismatch', 400),
      );
      await assert.rejects(
        registry.consumeEnrollment(null),
        (error) => isRegisteredLinkeError(error, 'device-scope-mismatch', 400),
      );
      await assert.rejects(
        registry.authenticate(null),
        (error) => isRegisteredLinkeError(error, 'device-scope-mismatch', 400),
      );
      await assert.rejects(
        registry.authenticate(undefined),
        (error) => isRegisteredLinkeError(error, 'device-scope-mismatch', 400),
      );
      await assert.rejects(
        registry.beginTokenRotation(null),
        (error) => isRegisteredLinkeError(error, 'device-scope-mismatch', 400),
      );
      await assert.rejects(
        registry.confirmTokenRotation(null),
        (error) => isRegisteredLinkeError(error, 'device-scope-mismatch', 400),
      );
      await assert.rejects(
        registry.revokeDevice(null),
        (error) => isRegisteredLinkeError(error, 'device-scope-mismatch', 400),
      );
      await assert.rejects(
        registry.authenticate({ deviceId: 'mac-x', token: null, protocolVersion: 2 }),
        (error) => isRegisteredLinkeError(error, 'device-token-invalid', 401),
      );
      await assert.rejects(
        registry.consumeEnrollment({ deviceId: 'mac-x', code: null, protocolVersion: 2 }),
        (error) => isRegisteredLinkeError(error, 'device-enrollment-invalid', 401),
      );
      await assert.rejects(
        registry.consumeEnrollment({ deviceId: 'mac-x', code: 'x'.repeat(43), protocolVersion: null }),
        (error) => isRegisteredLinkeError(error, 'device-protocol-unsupported', 426),
      );
    });

    await withRegistry('linke-device-throwing-now-', async (registry) => {
      await assert.rejects(
        registry.authenticate({ deviceId: 'mac-x', token: 'y'.repeat(43), protocolVersion: 2 }),
        (error) => (
          isRegisteredLinkeError(error, 'device-internal-error')
          && !error.message.includes('injected-now-boom')
        ),
      );
      await assert.rejects(
        registry.issueEnrollment({ deviceId: 'mac-x' }),
        (error) => (
          isRegisteredLinkeError(error, 'device-internal-error')
          && !error.message.includes('injected-now-boom')
        ),
      );
    }, {
      now: () => {
        throw new Error('injected-now-boom');
      },
    });

    await withRegistry('linke-device-throwing-token-', async (registry) => {
      await assert.rejects(
        registry.issueEnrollment({ deviceId: 'mac-x' }),
        (error) => (
          isRegisteredLinkeError(error, 'device-internal-error')
          && !error.message.includes('injected-token-boom')
        ),
      );
    }, {
      now: () => new Date('2026-07-13T00:00:00.000Z'),
      randomToken: () => {
        throw new Error('injected-token-boom');
      },
    });
  });

  it('rejects registry .new and final symlinks without writing outside or leaking paths', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'linke-registry-outside-'));
    try {
      await withRegistry('linke-registry-temp-symlink-', async (registry, root) => {
        const outsideTemp = join(outside, 'registry-new-target');
        await writeFile(outsideTemp, 'OUTSIDE-REGISTRY-NEW');
        await symlink(outsideTemp, join(root, 'device-registry-v1.json.new'), 'file');
        await assert.rejects(
          registry.issueEnrollment({ deviceId: 'mac-symlink-new' }),
          (error) => (
            isRegisteredLinkeError(error, 'device-internal-error')
            && !String(error.message || '').includes(outside)
            && !String(error.stack || '').includes('OUTSIDE-REGISTRY-NEW')
            && !String(error.message || '').includes(root)
          ),
        );
        assert.strictEqual(await readFile(outsideTemp, 'utf8'), 'OUTSIDE-REGISTRY-NEW');
        assert.ok((await lstat(join(root, 'device-registry-v1.json.new'))).isSymbolicLink());
      });

      await withRegistry('linke-registry-final-symlink-', async (registry, root) => {
        const outsideFinal = join(outside, 'registry-final-target');
        await writeFile(outsideFinal, 'OUTSIDE-REGISTRY-FINAL');
        await symlink(outsideFinal, join(root, 'device-registry-v1.json'), 'file');
        await assert.rejects(
          registry.issueEnrollment({ deviceId: 'mac-symlink-final' }),
          (error) => (
            isRegisteredLinkeError(error, 'device-internal-error')
            && !String(error.message || '').includes(outside)
            && !String(error.stack || '').includes('OUTSIDE-REGISTRY-FINAL')
          ),
        );
        assert.strictEqual(await readFile(outsideFinal, 'utf8'), 'OUTSIDE-REGISTRY-FINAL');
        assert.ok((await lstat(join(root, 'device-registry-v1.json'))).isSymbolicLink());
        const outsideNames = await readdir(outside);
        assert.deepStrictEqual(outsideNames.sort(), ['registry-final-target', 'registry-new-target'].sort());
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects reading registry final symlink as durable state', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'linke-registry-read-out-'));
    try {
      await withRegistry('linke-registry-read-symlink-', async (registry, root) => {
        const outsideFinal = join(outside, 'leaked-state.json');
        await writeFile(outsideFinal, JSON.stringify({
          schemaVersion: 1,
          controllerTlsFingerprint: null,
          enrollments: [],
          devices: [],
        }));
        await symlink(outsideFinal, join(root, 'device-registry-v1.json'), 'file');
        await assert.rejects(
          registry.getStatus(),
          (error) => (
            isRegisteredLinkeError(error, 'device-internal-error')
            && !String(error.message || '').includes(outside)
            && !String(error.message || '').includes('leaked-state')
          ),
        );
        assert.strictEqual(
          (await readFile(outsideFinal, 'utf8')).includes('schemaVersion'),
          true,
        );
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects first-create dataDir when an ancestor is a symlink and creates nothing outside', async () => {
    const base = await mkdtemp(join(tmpdir(), 'linke-registry-anc-'));
    const outside = await mkdtemp(join(tmpdir(), 'linke-registry-anc-out-'));
    try {
      const link = join(base, 'evil');
      await symlink(outside, link, 'dir');
      const dataDir = join(link, 'registry-root');
      const registry = new DeviceRegistry({ dataDir });
      await assert.rejects(
        registry.issueEnrollment({ deviceId: 'mac-anc' }),
        (error) => (
          isRegisteredLinkeError(error, 'device-internal-error')
          && !String(error.message || '').includes(outside)
          && !String(error.message || '').includes(dataDir)
        ),
      );
      const outsideEntries = await readdir(outside);
      assert.strictEqual(outsideEntries.includes('registry-root'), false);
      assert.strictEqual(outsideEntries.includes('device-registry-v1.json'), false);
      assert.strictEqual(outsideEntries.includes('device-registry-v1.json.new'), false);
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('creates missing nested dataDir under a real ancestor on first write', async () => {
    const base = await mkdtemp(join(tmpdir(), 'linke-registry-create-'));
    try {
      const dataDir = join(base, 'nested', 'data');
      const registry = new DeviceRegistry({ dataDir });
      const issued = await registry.issueEnrollment({ deviceId: 'mac-create' });
      assert.match(issued.code, /^[A-Za-z0-9_-]{43}$/);
      const st = await lstat(dataDir);
      assert.strictEqual(st.isDirectory(), true);
      assert.strictEqual(st.isSymbolicLink(), false);
      const published = await lstat(join(dataDir, 'device-registry-v1.json'));
      assert.strictEqual(published.isFile(), true);
      assert.strictEqual(published.mode & 0o777, 0o600);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
