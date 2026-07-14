import { spawn } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  X509Certificate,
} from 'node:crypto';
import { isIP } from 'node:net';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { ERROR_CODES, LinkeError } from './error-codes.js';
import {
  ensureSafeDataRoot,
  safeAtomicWriteText,
  safeReadText,
} from './safe-data-files.js';

const TLS_KEY_ITEM = 'controller-tls-private-key';
const CERT_FILE = 'controller-cert.pem';
const OPENSSL_BIN = '/usr/bin/openssl';
const LOCAL_DNS = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.local$/;

function incompleteError() {
  return new LinkeError(ERROR_CODES.DEVICE_TLS_IDENTITY_INCOMPLETE);
}

function bindInvalidError() {
  return new LinkeError(ERROR_CODES.DEVICE_TLS_BIND_INVALID, { statusCode: 400 });
}

/** RFC1918 + IPv4 link-local (169.254/16). */
function isPrivateIpv4(host) {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 169 && parts[1] === 254);
}

/** IPv6 ULA (fc00::/7) and link-local (fe80::/10). */
function isPrivateIpv6(host) {
  const normalized = host.toLowerCase();
  return normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb');
}

/**
 * Expand IPv6 to a fixed 8-group lowercase form for SAN comparison.
 * @param {string} address
 * @returns {string}
 */
function expandIpv6(address) {
  const bare = address.toLowerCase().split('%')[0].replace(/^\[|\]$/g, '');
  const halves = bare.split('::');
  let groups;
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const fill = 8 - left.length - right.length;
    groups = [...left, ...Array(Math.max(fill, 0)).fill('0'), ...right];
  } else {
    groups = bare.split(':');
  }
  if (groups.length !== 8) return bare;
  return groups.map((g) => g.padStart(4, '0')).join(':');
}

/**
 * Normalize a SAN entry for equality checks (Node uses "IP Address:…").
 * @param {string} entry
 * @returns {string}
 */
function normalizeSanEntry(entry) {
  if (typeof entry !== 'string') return '';
  let value;
  if (entry.startsWith('IP Address:')) value = entry.slice('IP Address:'.length);
  else if (entry.startsWith('IP:')) value = entry.slice(3);
  else return entry;
  const family = isIP(value);
  if (family === 6) return `IP:${expandIpv6(value)}`;
  if (family === 4) return `IP:${value}`;
  return `IP:${value}`;
}

/**
 * Validate an explicit private Agent listener bind and return its SAN.
 * Allows RFC1918 IPv4, 169.254/16, IPv6 ULA/link-local, and *.local DNS only.
 * @param {string} host
 * @param {number} [port=3443]
 * @returns {{ host: string, port: number, san: string }}
 */
export function validateAgentBind(host, port = 3443) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw bindInvalidError();
  }
  if (typeof host !== 'string' || host.length === 0) {
    throw bindInvalidError();
  }
  const family = isIP(host);
  const privateIp = family === 4 ? isPrivateIpv4(host) : family === 6 ? isPrivateIpv6(host) : false;
  const privateDns = family === 0 && LOCAL_DNS.test(host);
  if (!privateIp && !privateDns) {
    throw bindInvalidError();
  }
  return {
    host,
    port,
    san: family ? `IP:${host}` : `DNS:${host}`,
  };
}

/**
 * Generate an in-memory P-256 EC private key and its SPKI digest.
 * @returns {{ keyPem: string, publicKeyDigest: string }}
 */
export function generateControllerPrivateKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return {
    keyPem: typeof keyPem === 'string' ? keyPem : keyPem.toString('utf8'),
    publicKeyDigest: createHash('sha256').update(spki).digest('hex'),
  };
}

/**
 * Build a self-signed certificate; private key is passed only through fd 3.
 * Never places key material in argv, files, stderr, or error text.
 * @param {{ keyPem: string, san: string, spawnImpl?: typeof spawn }} options
 * @returns {Promise<string>}
 */
export function createOpenSslCertificate({ keyPem, san, spawnImpl = spawn }) {
  if (typeof keyPem !== 'string' || keyPem.length === 0) {
    return Promise.reject(incompleteError());
  }
  if (typeof san !== 'string' || san.length === 0) {
    return Promise.reject(incompleteError());
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const failClosed = () => settle(() => reject(incompleteError()));

    const args = [
      'req', '-new', '-x509', '-sha256', '-days', '825', '-batch',
      '-subj', '/CN=Linke Controller',
      '-addext', `subjectAltName=${san}`,
      '-key', '/dev/fd/3',
    ];

    let child;
    try {
      child = spawnImpl(OPENSSL_BIN, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    } catch {
      failClosed();
      return;
    }

    const stdout = [];
    const outStream = child.stdout;
    const errStream = child.stderr;
    const keyStream = child.stdio && child.stdio[3];

    if (!outStream || !errStream || !keyStream) {
      failClosed();
      return;
    }

    outStream.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    errStream.resume();
    // Permanent listeners: repeated stream errors stay fail-closed and settle once.
    child.on('error', failClosed);
    outStream.on('error', failClosed);
    errStream.on('error', failClosed);
    keyStream.on('error', failClosed);

    // Defer successful close so same-turn fd3/stream errors after close win.
    child.once('close', (exitCode) => {
      const code = Number.isInteger(exitCode) ? exitCode : 1;
      if (code !== 0) {
        failClosed();
        return;
      }
      const certPem = Buffer.concat(stdout).toString('utf8');
      queueMicrotask(() => settle(() => {
        if (!certPem.includes('BEGIN CERTIFICATE')) {
          reject(incompleteError());
          return;
        }
        resolve(certPem);
      }));
    });

    try {
      keyStream.end(keyPem);
    } catch {
      failClosed();
    }
  });
}

/**
 * Inspect certificate SAN, fingerprint and public key without exposing key material.
 * @param {string} certPem
 * @returns {{ fingerprint: string, sanEntries: string[], publicKeyDigest: string }}
 */
export function inspectControllerCertificate(certPem) {
  try {
    const certificate = new X509Certificate(certPem);
    const spki = certificate.publicKey.export({ type: 'spki', format: 'der' });
    const rawEntries = String(certificate.subjectAltName || '').split(', ').filter(Boolean);
    const sanEntries = rawEntries.map((entry) => {
      if (entry.startsWith('IP Address:')) {
        const ip = entry.slice('IP Address:'.length);
        return `IP:${ip}`;
      }
      return entry;
    });
    return {
      fingerprint: certificate.fingerprint256.replaceAll(':', '').toLowerCase(),
      sanEntries,
      publicKeyDigest: createHash('sha256').update(spki).digest('hex'),
    };
  } catch {
    throw incompleteError();
  }
}

/**
 * Return the SHA-256 certificate fingerprint (hex, no colons).
 * @param {string} certPem
 * @returns {string}
 */
export function fingerprintCertificate(certPem) {
  return inspectControllerCertificate(certPem).fingerprint;
}

/**
 * Return the SPKI digest derived from a private key held in memory.
 * @param {string} keyPem
 * @returns {string}
 */
export function inspectControllerPrivateKey(keyPem) {
  try {
    const publicKey = createPublicKey(createPrivateKey(keyPem));
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    return createHash('sha256').update(spki).digest('hex');
  } catch {
    throw incompleteError();
  }
}

/**
 * Validate key/cert pair against bind SAN, SPKI match, and optional approved fingerprint.
 * Used both for in-memory newly generated material (before persist) and existing pairs.
 * @param {{
 *   bind: { host: string, port: number, san: string },
 *   keyPem: string,
 *   certPem: string,
 *   inspectCertificate: Function,
 *   inspectPrivateKey: Function,
 *   approvedFingerprint?: string,
 * }} args
 * @returns {{ fingerprint: string, sanEntries: string[], publicKeyDigest: string }}
 */
function assertMatchedIdentity({
  bind,
  keyPem,
  certPem,
  inspectCertificate,
  inspectPrivateKey,
  approvedFingerprint,
}) {
  let inspected;
  try {
    inspected = inspectCertificate(certPem);
  } catch (error) {
    if (error instanceof LinkeError) throw error;
    throw incompleteError();
  }
  if (!inspected || typeof inspected !== 'object') {
    throw incompleteError();
  }

  const sanEntries = Array.isArray(inspected.sanEntries) ? inspected.sanEntries : [];
  const expectedSan = normalizeSanEntry(bind.san);
  const hasSan = sanEntries.some((entry) => normalizeSanEntry(entry) === expectedSan);
  if (!hasSan) {
    throw new LinkeError(ERROR_CODES.DEVICE_TLS_SAN_MISMATCH);
  }

  let privateDigest;
  try {
    privateDigest = inspectPrivateKey(keyPem);
  } catch (error) {
    if (error instanceof LinkeError) throw error;
    throw incompleteError();
  }
  if (privateDigest !== inspected.publicKeyDigest) {
    throw incompleteError();
  }

  if (approvedFingerprint && approvedFingerprint !== inspected.fingerprint) {
    throw new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH, { statusCode: 409 });
  }

  return inspected;
}

/**
 * Controller TLS identity: P-256 key in Keychain, cert on disk, never private-key files.
 * Creates only when both key and cert are missing; half-state and mismatches fail closed.
 * Concurrent ensure() calls on one instance are serialized via a promise mutex.
 */
export class TlsIdentityStore {
  /** @type {Promise<void>} */
  #mutex = Promise.resolve();

  /**
   * @param {{
   *   dataDir: string,
   *   keychain: { get: Function, set: Function, delete: Function },
   *   generatePrivateKey?: () => { keyPem: string, publicKeyDigest: string },
   *   certificateFactory?: (opts: { keyPem: string, san: string }) => Promise<string>,
   *   inspectCertificate?: (certPem: string) => { fingerprint: string, sanEntries: string[], publicKeyDigest: string },
   *   inspectPrivateKey?: (keyPem: string) => string,
   * }} options
   */
  constructor({
    dataDir,
    keychain,
    generatePrivateKey = generateControllerPrivateKey,
    certificateFactory = createOpenSslCertificate,
    inspectCertificate = inspectControllerCertificate,
    inspectPrivateKey = inspectControllerPrivateKey,
  }) {
    if (!dataDir || !keychain) throw new Error('dataDir and keychain are required');
    this.dataDir = dataDir;
    this.keychain = keychain;
    this.generatePrivateKey = generatePrivateKey;
    this.certificateFactory = certificateFactory;
    this.inspectCertificate = inspectCertificate;
    this.inspectPrivateKey = inspectPrivateKey;
  }

  /**
   * Ensure a matched controller TLS identity for the given private bind.
   * Concurrent calls are serialized per instance; a failed call does not poison the queue.
   * @param {{ host: string, port?: number, approvedFingerprint?: string }} [options]
   * @returns {Promise<{ keyPem: string, certPem: string, fingerprint: string, host: string, port: number }>}
   */
  ensure(options = {}) {
    const run = this.#mutex.then(() => this.#ensureIdentity(options));
    // Swallow so a rejected ensure does not poison subsequent waiters.
    this.#mutex = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Internal ensure body (runs under the instance mutex).
   * @param {{ host?: string, port?: number, approvedFingerprint?: string }} [options]
   * @returns {Promise<{ keyPem: string, certPem: string, fingerprint: string, host: string, port: number }>}
   */
  async #ensureIdentity({ host, port = 3443, approvedFingerprint } = {}) {
    const bind = validateAgentBind(host, port);
    // Validate cert directory root before any Keychain side effects.
    await this.#ensureTlsDataDir();

    let keyPem = null;
    let certPem = null;

    try {
      keyPem = await this.keychain.get(TLS_KEY_ITEM);
    } catch (error) {
      if (error.code !== ERROR_CODES.KEYCHAIN_ITEM_MISSING) throw error;
    }

    try {
      certPem = await safeReadText(this.dataDir, CERT_FILE);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        certPem = null;
      } else {
        throw incompleteError();
      }
    }

    if (Boolean(keyPem) !== Boolean(certPem)) {
      throw incompleteError();
    }

    if (!keyPem) {
      return this.#createAndPersistIdentity({ bind, approvedFingerprint });
    }

    // Existing pair: fail closed on mismatch; never silently regenerate.
    const inspected = assertMatchedIdentity({
      bind,
      keyPem,
      certPem,
      inspectCertificate: this.inspectCertificate,
      inspectPrivateKey: this.inspectPrivateKey,
      approvedFingerprint,
    });

    return {
      keyPem,
      certPem,
      fingerprint: inspected.fingerprint,
      host: bind.host,
      port: bind.port,
    };
  }

  /**
   * Ensure TLS dataDir exists as a non-symlink directory before Keychain writes.
   * Uses ensureSafeDataRoot so first-create never follows ancestor symlinks via recursive mkdir.
   * @returns {Promise<void>}
   */
  async #ensureTlsDataDir() {
    try {
      await ensureSafeDataRoot(this.dataDir);
    } catch {
      throw incompleteError();
    }
  }

  /**
   * Generate key/cert in memory, validate fully, then persist atomically.
   * Path safety is checked before Keychain set; write failures delete the new key.
   * Validation failures leave no Keychain key and no controller-cert.pem.
   * @param {{
   *   bind: { host: string, port: number, san: string },
   *   approvedFingerprint?: string,
   * }} args
   */
  async #createAndPersistIdentity({ bind, approvedFingerprint }) {
    const generated = this.generatePrivateKey();
    const generatedCert = await this.certificateFactory({
      keyPem: generated.keyPem,
      san: bind.san,
    });

    // Same SAN / SPKI / fingerprint checks as load path — before any persistence.
    const inspected = assertMatchedIdentity({
      bind,
      keyPem: generated.keyPem,
      certPem: generatedCert,
      inspectCertificate: this.inspectCertificate,
      inspectPrivateKey: this.inspectPrivateKey,
      approvedFingerprint,
    });

    // Re-validate root/cert leaf before Keychain set (final symlink fail-closed).
    await this.#ensureTlsDataDir();
    try {
      await lstat(join(this.dataDir, CERT_FILE));
      // Existing leaf before create is unexpected for the missing-pair path; fail closed.
      throw incompleteError();
    } catch (error) {
      if (error instanceof LinkeError) throw error;
      if (!error || error.code !== 'ENOENT') throw incompleteError();
    }

    await this.keychain.set(TLS_KEY_ITEM, generated.keyPem);
    try {
      await safeAtomicWriteText(this.dataDir, CERT_FILE, generatedCert, {
        mode: 0o600,
        tempRelativePath: `${CERT_FILE}.${randomUUID()}.new`,
      });
    } catch {
      await this.keychain.delete(TLS_KEY_ITEM).catch(() => {});
      throw incompleteError();
    }

    return {
      keyPem: generated.keyPem,
      certPem: generatedCert,
      fingerprint: inspected.fingerprint,
      host: bind.host,
      port: bind.port,
    };
  }
}
