import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  TlsIdentityStore,
  validateAgentBind,
  fingerprintCertificate,
  inspectControllerCertificate,
  inspectControllerPrivateKey,
  generateControllerPrivateKey,
  createOpenSslCertificate,
} from '../src/tls-identity-store.js';

/**
 * In-memory Keychain adapter for unit tests. Never touches macOS Keychain.
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
 * Fake spawn for createOpenSslCertificate runner tests.
 * stdio[3] is the private-key pipe; never invokes /usr/bin/openssl.
 */
function createFakeOpenSslSpawn(scenario = {}) {
  const calls = [];
  const spawnImpl = (binary, args, options) => {
    const call = { binary, args, options, fd3Chunks: [] };
    calls.push(call);
    const child = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    stderr.resume = () => {
      stderr.resumed = true;
    };
    const fd3 = new EventEmitter();
    fd3.end = (chunk) => {
      if (chunk !== undefined) call.fd3Chunks.push(chunk);
      queueMicrotask(() => {
        if (scenario.spawnError) {
          child.emit('error', scenario.spawnError);
          return;
        }
        if (scenario.fd3Error) {
          fd3.emit('error', scenario.fd3Error);
          return;
        }
        if (scenario.stdoutError) {
          stdout.emit('error', scenario.stdoutError);
          return;
        }
        if (scenario.stderrError) {
          stderr.emit('error', scenario.stderrError);
          return;
        }
        if (scenario.stdoutData !== undefined) {
          stdout.emit('data', Buffer.from(scenario.stdoutData));
        }
        if (scenario.stderrData !== undefined) {
          stderr.emit('data', Buffer.from(scenario.stderrData));
        }
        child.emit('close', scenario.closeCode === undefined ? 0 : scenario.closeCode);
      });
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdio = [null, stdout, stderr, fd3];
    return child;
  };
  return { spawnImpl, calls };
}

describe('validateAgentBind', () => {
  it('accepts private LAN IPv4, ULA IPv6 and .local DNS only', () => {
    assert.deepStrictEqual(validateAgentBind('192.168.10.4', 3443), {
      host: '192.168.10.4', port: 3443, san: 'IP:192.168.10.4',
    });
    assert.strictEqual(validateAgentBind('10.1.2.3', 3443).san, 'IP:10.1.2.3');
    assert.strictEqual(validateAgentBind('172.16.0.1', 3443).san, 'IP:172.16.0.1');
    assert.strictEqual(validateAgentBind('172.31.255.255', 3443).san, 'IP:172.31.255.255');
    assert.strictEqual(validateAgentBind('169.254.1.1', 3443).san, 'IP:169.254.1.1');
    assert.strictEqual(validateAgentBind('linke-controller.local', 4443).san, 'DNS:linke-controller.local');
    assert.strictEqual(validateAgentBind('a.b.local', 3443).san, 'DNS:a.b.local');
    assert.strictEqual(validateAgentBind('fd00::10', 3443).san, 'IP:fd00::10');
    assert.ok(validateAgentBind('fe80::1', 3443).san.startsWith('IP:'));
    assert.ok(validateAgentBind('fc00::1', 3443).san.startsWith('IP:'));
  });

  it('rejects wildcard, loopback, public hosts and invalid ports', () => {
    for (const host of [
      '0.0.0.0',
      '127.0.0.1',
      '::1',
      'localhost',
      '8.8.8.8',
      '1.1.1.1',
      'public.example.com',
      'example.com',
      'not local',
      '',
      '172.15.0.1',
      '172.32.0.1',
      '169.255.0.1',
    ]) {
      assert.throws(
        () => validateAgentBind(host, 3443),
        (error) => error.code === 'device-tls-bind-invalid',
      );
    }
    for (const port of [0, -1, 65536, 1.5, '3443', null, undefined]) {
      if (port === undefined) {
        // default port is valid when host is private
        assert.doesNotThrow(() => validateAgentBind('192.168.1.1'));
        continue;
      }
      assert.throws(
        () => validateAgentBind('192.168.1.1', port),
        (error) => error.code === 'device-tls-bind-invalid',
      );
    }
    assert.deepStrictEqual(validateAgentBind('192.168.1.1', 1).port, 1);
    assert.deepStrictEqual(validateAgentBind('192.168.1.1', 65535).port, 65535);
  });
});

describe('TLS identity store', () => {
  it('creates a matched identity once and reloads it without regeneration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-tls-identity-'));
    const keychain = memoryKeychain();
    let generated = 0;
    const inspectCertificate = () => ({
      fingerprint: 'a'.repeat(64), sanEntries: ['IP:192.168.10.4'], publicKeyDigest: 'matched',
    });
    const store = new TlsIdentityStore({
      dataDir: root,
      keychain,
      generatePrivateKey: () => ({ keyPem: 'PRIVATE', publicKeyDigest: 'matched' }),
      certificateFactory: async ({ keyPem, san }) => {
        generated += 1;
        assert.strictEqual(keyPem, 'PRIVATE');
        assert.strictEqual(san, 'IP:192.168.10.4');
        return 'CERTIFICATE';
      },
      inspectCertificate,
      inspectPrivateKey: () => 'matched',
    });
    try {
      const first = await store.ensure({ host: '192.168.10.4', port: 3443 });
      const second = await store.ensure({ host: '192.168.10.4', port: 3443 });
      assert.strictEqual(first.fingerprint, 'a'.repeat(64));
      assert.strictEqual(second.keyPem, 'PRIVATE');
      assert.strictEqual(generated, 1);
      const certOnDisk = await readFile(join(root, 'controller-cert.pem'), 'utf8');
      assert.strictEqual(certOnDisk, 'CERTIFICATE');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when only certificate or only Keychain key exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-tls-incomplete-'));
    try {
      await writeFile(join(root, 'controller-cert.pem'), 'CERTIFICATE');
      const storeOnlyCert = new TlsIdentityStore({
        dataDir: root,
        keychain: memoryKeychain(),
        inspectCertificate: () => ({ fingerprint: 'b'.repeat(64), sanEntries: [], publicKeyDigest: 'x' }),
      });
      await assert.rejects(
        storeOnlyCert.ensure({ host: '192.168.10.4', port: 3443 }),
        (error) => error.code === 'device-tls-identity-incomplete',
      );

      const rootKey = await mkdtemp(join(tmpdir(), 'linke-tls-key-only-'));
      try {
        const keychain = memoryKeychain(new Map([['controller-tls-private-key', 'PRIVATE']]));
        const storeOnlyKey = new TlsIdentityStore({
          dataDir: rootKey,
          keychain,
          inspectCertificate: () => ({ fingerprint: 'b'.repeat(64), sanEntries: [], publicKeyDigest: 'x' }),
        });
        await assert.rejects(
          storeOnlyKey.ensure({ host: '192.168.10.4', port: 3443 }),
          (error) => error.code === 'device-tls-identity-incomplete',
        );
        assert.strictEqual(await keychain.get('controller-tls-private-key'), 'PRIVATE');
      } finally {
        await rm(rootKey, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects SAN, public-key or approved-fingerprint changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-tls-mismatch-'));
    try {
      await writeFile(join(root, 'controller-cert.pem'), 'CERTIFICATE');
      const keychain = memoryKeychain(new Map([['controller-tls-private-key', 'PRIVATE']]));
      const store = new TlsIdentityStore({
        dataDir: root,
        keychain,
        generatePrivateKey: () => ({ keyPem: 'PRIVATE', publicKeyDigest: 'matched' }),
        inspectPrivateKey: () => 'matched',
        inspectCertificate: () => ({
          fingerprint: 'c'.repeat(64), sanEntries: ['IP:192.168.10.9'], publicKeyDigest: 'different',
        }),
      });
      await assert.rejects(
        store.ensure({ host: '192.168.10.4', port: 3443 }),
        (error) => ['device-tls-san-mismatch', 'device-tls-identity-incomplete'].includes(error.code),
      );

      const storeFp = new TlsIdentityStore({
        dataDir: root,
        keychain,
        inspectPrivateKey: () => 'matched',
        inspectCertificate: () => ({
          fingerprint: 'c'.repeat(64), sanEntries: ['IP:192.168.10.4'], publicKeyDigest: 'matched',
        }),
      });
      await assert.rejects(
        storeFp.ensure({ host: '192.168.10.4', port: 3443, approvedFingerprint: 'd'.repeat(64) }),
        (error) => error.code === 'device-tls-fingerprint-mismatch' && error.statusCode === 409,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rolls back Keychain key when certificate write fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-tls-rollback-'));
    const map = new Map();
    const keychain = memoryKeychain(map);
    // Make dataDir unwritable after mkdir so writeFile fails post keychain.set.
    await chmod(root, 0o500);
    const store = new TlsIdentityStore({
      dataDir: root,
      keychain,
      generatePrivateKey: () => ({ keyPem: 'PRIVATE-ROLLBACK', publicKeyDigest: 'matched' }),
      certificateFactory: async () => 'CERTIFICATE',
      inspectCertificate: () => ({
        fingerprint: 'e'.repeat(64), sanEntries: ['IP:192.168.10.4'], publicKeyDigest: 'matched',
      }),
      inspectPrivateKey: () => 'matched',
    });
    try {
      await assert.rejects(
        store.ensure({ host: '192.168.10.4', port: 3443 }),
        (error) => error.code === 'device-tls-identity-incomplete',
      );
      assert.strictEqual(map.has('controller-tls-private-key'), false);
    } finally {
      await chmod(root, 0o700).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never silently regenerates an existing mismatched pair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-tls-no-regen-'));
    let generated = 0;
    try {
      await writeFile(join(root, 'controller-cert.pem'), 'OLD-CERT');
      const keychain = memoryKeychain(new Map([['controller-tls-private-key', 'OLD-KEY']]));
      const store = new TlsIdentityStore({
        dataDir: root,
        keychain,
        generatePrivateKey: () => {
          generated += 1;
          return { keyPem: 'NEW-KEY', publicKeyDigest: 'new' };
        },
        certificateFactory: async () => {
          generated += 1;
          return 'NEW-CERT';
        },
        inspectPrivateKey: () => 'old',
        inspectCertificate: () => ({
          fingerprint: 'f'.repeat(64), sanEntries: ['IP:192.168.10.4'], publicKeyDigest: 'other',
        }),
      });
      await assert.rejects(
        store.ensure({ host: '192.168.10.4', port: 3443 }),
        (error) => error.code === 'device-tls-identity-incomplete',
      );
      assert.strictEqual(generated, 0);
      assert.strictEqual(await keychain.get('controller-tls-private-key'), 'OLD-KEY');
      assert.strictEqual(await readFile(join(root, 'controller-cert.pem'), 'utf8'), 'OLD-CERT');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serializes concurrent ensure so only one identity is generated and results match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-tls-concurrent-'));
    const map = new Map();
    let generated = 0;
    let factoryInFlight = 0;
    let maxFactoryInFlight = 0;
    const store = new TlsIdentityStore({
      dataDir: root,
      keychain: memoryKeychain(map),
      generatePrivateKey: () => {
        generated += 1;
        return { keyPem: `PRIVATE-${generated}`, publicKeyDigest: 'matched' };
      },
      certificateFactory: async ({ keyPem }) => {
        factoryInFlight += 1;
        maxFactoryInFlight = Math.max(maxFactoryInFlight, factoryInFlight);
        await new Promise((resolve) => setTimeout(resolve, 40));
        factoryInFlight -= 1;
        assert.strictEqual(keyPem, 'PRIVATE-1');
        return 'CERTIFICATE';
      },
      inspectCertificate: () => ({
        fingerprint: 'a'.repeat(64), sanEntries: ['IP:192.168.10.4'], publicKeyDigest: 'matched',
      }),
      inspectPrivateKey: () => 'matched',
    });
    try {
      const [first, second] = await Promise.all([
        store.ensure({ host: '192.168.10.4', port: 3443 }),
        store.ensure({ host: '192.168.10.4', port: 3443 }),
      ]);
      assert.strictEqual(generated, 1);
      assert.strictEqual(maxFactoryInFlight, 1);
      assert.strictEqual(first.keyPem, 'PRIVATE-1');
      assert.strictEqual(second.keyPem, first.keyPem);
      assert.strictEqual(second.certPem, first.certPem);
      assert.strictEqual(second.fingerprint, first.fingerprint);
      assert.strictEqual(map.get('controller-tls-private-key'), 'PRIVATE-1');
      assert.strictEqual(await readFile(join(root, 'controller-cert.pem'), 'utf8'), 'CERTIFICATE');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not persist Keychain key or cert when newly generated material fails validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-tls-prepersist-'));
    try {
      // SAN mismatch before any write
      const mapSan = new Map();
      const storeSan = new TlsIdentityStore({
        dataDir: root,
        keychain: memoryKeychain(mapSan),
        generatePrivateKey: () => ({ keyPem: 'PRIVATE-SAN', publicKeyDigest: 'matched' }),
        certificateFactory: async () => 'CERT-BAD-SAN',
        inspectCertificate: () => ({
          fingerprint: 'a'.repeat(64), sanEntries: ['IP:10.0.0.9'], publicKeyDigest: 'matched',
        }),
        inspectPrivateKey: () => 'matched',
      });
      await assert.rejects(
        storeSan.ensure({ host: '192.168.10.4', port: 3443 }),
        (error) => error.code === 'device-tls-san-mismatch',
      );
      assert.strictEqual(mapSan.has('controller-tls-private-key'), false);
      await assert.rejects(
        () => readFile(join(root, 'controller-cert.pem')),
        (error) => error.code === 'ENOENT',
      );

      // SPKI mismatch before any write
      const mapSpki = new Map();
      const storeSpki = new TlsIdentityStore({
        dataDir: root,
        keychain: memoryKeychain(mapSpki),
        generatePrivateKey: () => ({ keyPem: 'PRIVATE-SPKI', publicKeyDigest: 'matched' }),
        certificateFactory: async () => 'CERT-BAD-SPKI',
        inspectCertificate: () => ({
          fingerprint: 'b'.repeat(64), sanEntries: ['IP:192.168.10.4'], publicKeyDigest: 'other',
        }),
        inspectPrivateKey: () => 'matched',
      });
      await assert.rejects(
        storeSpki.ensure({ host: '192.168.10.4', port: 3443 }),
        (error) => error.code === 'device-tls-identity-incomplete',
      );
      assert.strictEqual(mapSpki.has('controller-tls-private-key'), false);

      // Approved fingerprint mismatch before any write
      const mapFp = new Map();
      const storeFp = new TlsIdentityStore({
        dataDir: root,
        keychain: memoryKeychain(mapFp),
        generatePrivateKey: () => ({ keyPem: 'PRIVATE-FP', publicKeyDigest: 'matched' }),
        certificateFactory: async () => 'CERT-BAD-FP',
        inspectCertificate: () => ({
          fingerprint: 'c'.repeat(64), sanEntries: ['IP:192.168.10.4'], publicKeyDigest: 'matched',
        }),
        inspectPrivateKey: () => 'matched',
      });
      await assert.rejects(
        storeFp.ensure({
          host: '192.168.10.4',
          port: 3443,
          approvedFingerprint: 'd'.repeat(64),
        }),
        (error) => error.code === 'device-tls-fingerprint-mismatch',
      );
      assert.strictEqual(mapFp.has('controller-tls-private-key'), false);
      const names = await readdir(root);
      assert.ok(!names.includes('controller-cert.pem'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the ensure queue usable after a failed generation attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-tls-queue-recover-'));
    const map = new Map();
    let attempt = 0;
    const store = new TlsIdentityStore({
      dataDir: root,
      keychain: memoryKeychain(map),
      generatePrivateKey: () => ({ keyPem: 'PRIVATE-OK', publicKeyDigest: 'matched' }),
      certificateFactory: async () => {
        attempt += 1;
        if (attempt === 1) return 'CERT-BAD';
        return 'CERTIFICATE';
      },
      inspectCertificate: (certPem) => {
        if (certPem === 'CERT-BAD') {
          return {
            fingerprint: 'a'.repeat(64), sanEntries: ['IP:10.0.0.1'], publicKeyDigest: 'matched',
          };
        }
        return {
          fingerprint: 'b'.repeat(64), sanEntries: ['IP:192.168.10.4'], publicKeyDigest: 'matched',
        };
      },
      inspectPrivateKey: () => 'matched',
    });
    try {
      await assert.rejects(
        store.ensure({ host: '192.168.10.4', port: 3443 }),
        (error) => error.code === 'device-tls-san-mismatch',
      );
      assert.strictEqual(map.has('controller-tls-private-key'), false);

      const ok = await store.ensure({ host: '192.168.10.4', port: 3443 });
      assert.strictEqual(ok.keyPem, 'PRIVATE-OK');
      assert.strictEqual(ok.fingerprint, 'b'.repeat(64));
      assert.strictEqual(map.get('controller-tls-private-key'), 'PRIVATE-OK');
      assert.strictEqual(await readFile(join(root, 'controller-cert.pem'), 'utf8'), 'CERTIFICATE');
      assert.strictEqual(attempt, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects tls directory/temp/final cert symlinks without writing outside or keeping incomplete key', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'linke-tls-symlink-out-'));
    try {
      // dataDir itself is a symlink directory → fail before Keychain set.
      const parent = await mkdtemp(join(tmpdir(), 'linke-tls-dir-parent-'));
      try {
        await symlink(outside, join(parent, 'tls'), 'dir');
        const map = new Map();
        const store = new TlsIdentityStore({
          dataDir: join(parent, 'tls'),
          keychain: memoryKeychain(map),
          generatePrivateKey: () => ({ keyPem: 'PRIVATE-DIR', publicKeyDigest: 'matched' }),
          certificateFactory: async () => 'CERTIFICATE',
          inspectCertificate: () => ({
            fingerprint: 'a'.repeat(64), sanEntries: ['IP:192.168.10.4'], publicKeyDigest: 'matched',
          }),
          inspectPrivateKey: () => 'matched',
        });
        await assert.rejects(
          store.ensure({ host: '192.168.10.4', port: 3443 }),
          (error) => {
            const text = `${error?.message || ''}\n${error?.stack || ''}`;
            assert.equal(error.code, 'device-tls-identity-incomplete');
            assert.equal(text.includes(outside), false);
            return true;
          },
        );
        assert.strictEqual(map.has('controller-tls-private-key'), false);
        assert.equal((await readdir(outside)).includes('controller-cert.pem'), false);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }

      // Final cert path is a file symlink → reject and leave outside unchanged.
      const rootFinal = await mkdtemp(join(tmpdir(), 'linke-tls-final-symlink-'));
      try {
        const outsideCert = join(outside, 'controller-cert.pem');
        await writeFile(outsideCert, 'OUTSIDE-CERT');
        await symlink(outsideCert, join(rootFinal, 'controller-cert.pem'), 'file');
        const map = new Map();
        const store = new TlsIdentityStore({
          dataDir: rootFinal,
          keychain: memoryKeychain(map),
          generatePrivateKey: () => ({ keyPem: 'PRIVATE-FINAL', publicKeyDigest: 'matched' }),
          certificateFactory: async () => 'CERTIFICATE',
          inspectCertificate: () => ({
            fingerprint: 'b'.repeat(64), sanEntries: ['IP:192.168.10.4'], publicKeyDigest: 'matched',
          }),
          inspectPrivateKey: () => 'matched',
        });
        await assert.rejects(
          store.ensure({ host: '192.168.10.4', port: 3443 }),
          (error) => error.code === 'device-tls-identity-incomplete',
        );
        // Half-pair is incomplete: either no key, or key rolled back after write fail.
        assert.strictEqual(map.has('controller-tls-private-key'), false);
        assert.strictEqual(await readFile(outsideCert, 'utf8'), 'OUTSIDE-CERT');
        assert.equal((await lstat(join(rootFinal, 'controller-cert.pem'))).isSymbolicLink(), true);
      } finally {
        await rm(rootFinal, { recursive: true, force: true });
      }

      // Temp cert path is a symlink → reject without following.
      const rootTemp = await mkdtemp(join(tmpdir(), 'linke-tls-temp-symlink-'));
      try {
        const outsideTemp = join(outside, 'cert-temp');
        await writeFile(outsideTemp, 'OUTSIDE-TEMP-CERT');
        // Plant many possible temp names? Production uses randomUUID. Instead plant
        // final-safe dir and rely on fixed inject if available; without inject we plant
        // a pre-existing sibling symlink and verify final/temp path safety via final case.
        // Also cover read path when only cert exists as symlink (half state incomplete).
        await symlink(outsideTemp, join(rootTemp, 'controller-cert.pem'), 'file');
        const map = new Map([['controller-tls-private-key', 'PRIVATE-EXISTING']]);
        const store = new TlsIdentityStore({
          dataDir: rootTemp,
          keychain: memoryKeychain(map),
          generatePrivateKey: () => ({ keyPem: 'PRIVATE-TEMP', publicKeyDigest: 'matched' }),
          certificateFactory: async () => 'CERTIFICATE',
          inspectCertificate: () => ({
            fingerprint: 'c'.repeat(64), sanEntries: ['IP:192.168.10.4'], publicKeyDigest: 'matched',
          }),
          inspectPrivateKey: () => 'matched',
        });
        await assert.rejects(
          store.ensure({ host: '192.168.10.4', port: 3443 }),
          (error) => error.code === 'device-tls-identity-incomplete',
        );
        assert.strictEqual(await readFile(outsideTemp, 'utf8'), 'OUTSIDE-TEMP-CERT');
      } finally {
        await rm(rootTemp, { recursive: true, force: true });
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects first-create TLS dataDir when ancestor is a symlink without Keychain side effects', async () => {
    const base = await mkdtemp(join(tmpdir(), 'linke-tls-anc-'));
    const outside = await mkdtemp(join(tmpdir(), 'linke-tls-anc-out-'));
    try {
      const link = join(base, 'evil');
      await symlink(outside, link, 'dir');
      const dataDir = join(link, 'tls-root');
      const map = new Map();
      const store = new TlsIdentityStore({
        dataDir,
        keychain: memoryKeychain(map),
        generatePrivateKey: () => ({ keyPem: 'PRIVATE-ANC', publicKeyDigest: 'matched' }),
        certificateFactory: async () => 'CERTIFICATE',
        inspectCertificate: () => ({
          fingerprint: 'd'.repeat(64), sanEntries: ['IP:192.168.10.4'], publicKeyDigest: 'matched',
        }),
        inspectPrivateKey: () => 'matched',
      });
      await assert.rejects(
        store.ensure({ host: '192.168.10.4', port: 3443 }),
        (error) => {
          const text = `${error?.message || ''}\n${error?.stack || ''}`;
          assert.equal(error.code, 'device-tls-identity-incomplete');
          assert.equal(text.includes(outside), false);
          assert.equal(text.includes(dataDir), false);
          return true;
        },
      );
      assert.strictEqual(map.has('controller-tls-private-key'), false);
      const outsideEntries = await readdir(outside);
      assert.equal(outsideEntries.includes('tls-root'), false);
      assert.equal(outsideEntries.includes('controller-cert.pem'), false);
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('creates missing TLS dataDir under a real ancestor before Keychain set', async () => {
    const base = await mkdtemp(join(tmpdir(), 'linke-tls-create-'));
    try {
      const dataDir = join(base, 'nested', 'tls');
      const map = new Map();
      const store = new TlsIdentityStore({
        dataDir,
        keychain: memoryKeychain(map),
        generatePrivateKey: () => ({ keyPem: 'PRIVATE-CREATE', publicKeyDigest: 'matched' }),
        certificateFactory: async () => 'CERTIFICATE',
        inspectCertificate: () => ({
          fingerprint: 'e'.repeat(64), sanEntries: ['IP:192.168.10.4'], publicKeyDigest: 'matched',
        }),
        inspectPrivateKey: () => 'matched',
      });
      const identity = await store.ensure({ host: '192.168.10.4', port: 3443 });
      assert.strictEqual(identity.keyPem, 'PRIVATE-CREATE');
      assert.strictEqual(map.get('controller-tls-private-key'), 'PRIVATE-CREATE');
      const rootStat = await lstat(dataDir);
      assert.equal(rootStat.isDirectory(), true);
      assert.equal(rootStat.isSymbolicLink(), false);
      const certStat = await lstat(join(dataDir, 'controller-cert.pem'));
      assert.equal(certStat.isFile(), true);
      assert.equal(certStat.mode & 0o777, 0o600);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('validates cert path safety before any Keychain set during create', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'linke-tls-prekey-out-'));
    const parent = await mkdtemp(join(tmpdir(), 'linke-tls-prekey-parent-'));
    try {
      await symlink(outside, join(parent, 'tls'), 'dir');
      const order = [];
      const map = new Map();
      const store = new TlsIdentityStore({
        dataDir: join(parent, 'tls'),
        keychain: {
          async get(id) {
            order.push(`get:${id}`);
            if (!map.has(id)) {
              const error = new Error('keychain-item-missing');
              error.code = 'keychain-item-missing';
              throw error;
            }
            return map.get(id);
          },
          async set(id, value) {
            order.push(`set:${id}`);
            map.set(id, value);
          },
          async delete(id) {
            order.push(`delete:${id}`);
            return map.delete(id);
          },
        },
        generatePrivateKey: () => {
          order.push('generate');
          return { keyPem: 'PRIVATE-PRE', publicKeyDigest: 'matched' };
        },
        certificateFactory: async () => {
          order.push('cert');
          return 'CERTIFICATE';
        },
        inspectCertificate: () => ({
          fingerprint: 'd'.repeat(64), sanEntries: ['IP:192.168.10.4'], publicKeyDigest: 'matched',
        }),
        inspectPrivateKey: () => 'matched',
      });
      await assert.rejects(
        store.ensure({ host: '192.168.10.4', port: 3443 }),
        (error) => error.code === 'device-tls-identity-incomplete',
      );
      assert.equal(order.includes('set:controller-tls-private-key'), false);
      assert.strictEqual(map.has('controller-tls-private-key'), false);
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('createOpenSslCertificate runner', () => {
  it('locks binary to /usr/bin/openssl, uses /dev/fd/3, never keyout or argv secret', async () => {
    const keyPem = '-----BEGIN PRIVATE KEY-----\nPROBE\n-----END PRIVATE KEY-----\n';
    const { spawnImpl, calls } = createFakeOpenSslSpawn({
      closeCode: 0,
      stdoutData: '-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----\n',
      stderrData: 'stderr-must-not-leak',
    });
    const cert = await createOpenSslCertificate({
      keyPem,
      san: 'IP:192.168.10.4',
      spawnImpl,
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].binary, '/usr/bin/openssl');
    assert.deepStrictEqual(calls[0].options, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    assert.ok(calls[0].args.includes('/dev/fd/3'));
    assert.ok(calls[0].args.includes('-key'));
    assert.ok(!calls[0].args.some((a) => String(a).toLowerCase().includes('keyout')));
    assert.ok(!calls[0].args.includes(keyPem));
    assert.ok(!calls[0].args.join(' ').includes('PRIVATE KEY'));
    assert.ok(!calls[0].args.join(' ').includes('PROBE'));
    assert.deepStrictEqual(calls[0].fd3Chunks, [keyPem]);
    assert.ok(cert.includes('BEGIN CERTIFICATE'));
    assert.ok(!cert.includes('PRIVATE'));
    assert.ok(!cert.includes('stderr-must-not-leak'));
  });

  it('maps sync spawn throw and stream errors to incomplete without leaking key material', async () => {
    const probe = '-----BEGIN PRIVATE KEY-----\nSECRET-LEAK-PROBE\n-----END PRIVATE KEY-----\n';
    const spawnThrow = () => {
      throw new Error(`spawn EACCES containing ${probe}`);
    };
    await assert.rejects(
      createOpenSslCertificate({ keyPem: probe, san: 'IP:192.168.10.4', spawnImpl: spawnThrow }),
      (error) => {
        const text = `${error}\n${error.message}\n${error.stack || ''}`;
        return error.code === 'device-tls-identity-incomplete'
          && !text.includes('EACCES')
          && !text.includes('SECRET-LEAK-PROBE')
          && !text.includes('PRIVATE KEY');
      },
    );

    const streamError = new Error(`read EIO containing ${probe}`);
    streamError.code = 'EIO';
    const { spawnImpl } = createFakeOpenSslSpawn({ stdoutError: streamError });
    await assert.rejects(
      createOpenSslCertificate({ keyPem: probe, san: 'IP:192.168.10.4', spawnImpl }),
      (error) => {
        const text = `${error}\n${error.message}\n${error.stack || ''}`;
        return error.code === 'device-tls-identity-incomplete'
          && !text.includes('EIO')
          && !text.includes('SECRET-LEAK-PROBE');
      },
    );
  });

  it('settles once on double stream errors without uncaught', async () => {
    const probe = 'DOUBLE-SETTLE-KEY-MATERIAL';
    const stray = [];
    const onUncaught = (err) => { stray.push(err); };
    const onUnhandled = (reason) => { stray.push(reason); };
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUnhandled);
    try {
      const spawnImpl = () => {
        const child = new EventEmitter();
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        stderr.resume = () => {};
        const fd3 = new EventEmitter();
        fd3.end = () => {
          queueMicrotask(() => {
            const first = new Error(`write EPIPE first ${probe}`);
            first.code = 'EPIPE';
            const second = new Error(`write EPIPE second ${probe}`);
            second.code = 'EPIPE';
            fd3.emit('error', first);
            fd3.emit('error', second);
          });
        };
        child.stdout = stdout;
        child.stderr = stderr;
        child.stdio = [null, stdout, stderr, fd3];
        return child;
      };
      await assert.rejects(
        createOpenSslCertificate({ keyPem: probe, san: 'IP:10.0.0.1', spawnImpl }),
        (error) => error.code === 'device-tls-identity-incomplete' && !String(error.stack || '').includes(probe),
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(stray.length, 0);
    } finally {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('prefers same-turn fd3 error after close as incomplete', async () => {
    const probe = 'CLOSE-THEN-ERROR-KEY';
    const spawnImpl = () => {
      const child = new EventEmitter();
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      stderr.resume = () => {};
      const fd3 = new EventEmitter();
      fd3.end = () => {
        child.emit('close', 0);
        const err = new Error(`write EPIPE ${probe}`);
        err.code = 'EPIPE';
        fd3.emit('error', err);
      };
      child.stdout = stdout;
      child.stderr = stderr;
      child.stdio = [null, stdout, stderr, fd3];
      return child;
    };
    await assert.rejects(
      createOpenSslCertificate({ keyPem: probe, san: 'IP:10.0.0.1', spawnImpl }),
      (error) => {
        const text = `${error}\n${error.message}\n${error.stack || ''}`;
        return error.code === 'device-tls-identity-incomplete' && !text.includes(probe);
      },
    );
  });
});

describe('OpenSSL real certificate path', () => {
  it('OpenSSL fd3 creates matching SAN, 64-char fingerprint and SPKI without private-key files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'linke-tls-openssl-'));
    try {
      const generated = generateControllerPrivateKey();
      assert.ok(generated.keyPem.includes('BEGIN PRIVATE KEY') || generated.keyPem.includes('BEGIN EC PRIVATE KEY'));
      assert.match(generated.publicKeyDigest, /^[0-9a-f]{64}$/);

      const certPem = await createOpenSslCertificate({
        keyPem: generated.keyPem,
        san: 'IP:192.168.10.4',
      });
      assert.ok(certPem.includes('BEGIN CERTIFICATE'));
      assert.ok(!certPem.includes('PRIVATE KEY'));
      assert.ok(!certPem.includes(generated.keyPem));

      const inspected = inspectControllerCertificate(certPem);
      assert.ok(inspected.sanEntries.includes('IP:192.168.10.4'));
      assert.match(inspected.fingerprint, /^[0-9a-f]{64}$/);
      assert.strictEqual(inspected.fingerprint.length, 64);
      assert.strictEqual(inspected.publicKeyDigest, generated.publicKeyDigest);
      assert.strictEqual(inspectControllerPrivateKey(generated.keyPem), generated.publicKeyDigest);
      assert.strictEqual(fingerprintCertificate(certPem), inspected.fingerprint);

      const map = new Map();
      const store = new TlsIdentityStore({
        dataDir: root,
        keychain: memoryKeychain(map),
      });
      const identity = await store.ensure({ host: '192.168.10.4', port: 3443 });
      assert.strictEqual(identity.host, '192.168.10.4');
      assert.strictEqual(identity.port, 3443);
      assert.match(identity.fingerprint, /^[0-9a-f]{64}$/);
      assert.ok(identity.certPem.includes('BEGIN CERTIFICATE'));
      assert.ok(identity.keyPem.includes('PRIVATE'));
      assert.ok(!identity.certPem.includes('PRIVATE KEY'));

      const reloaded = await store.ensure({ host: '192.168.10.4', port: 3443 });
      assert.strictEqual(reloaded.fingerprint, identity.fingerprint);
      assert.strictEqual(reloaded.keyPem, identity.keyPem);

      // No private-key files in project tmp data dir.
      const names = await readdir(root);
      assert.deepStrictEqual(names, ['controller-cert.pem']);
      const onDisk = await readFile(join(root, 'controller-cert.pem'), 'utf8');
      assert.ok(!onDisk.includes('PRIVATE KEY'));
      assert.ok(!onDisk.includes('BEGIN EC PRIVATE KEY'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
