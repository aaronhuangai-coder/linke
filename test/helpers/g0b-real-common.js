/**
 * G0b real-LAN / auto acceptance — common secret-safe primitives.
 * Import has zero side effects. Real Keychain/network only after exact gates.
 * Auto production-boundary uses 0600 private bundle files (never secret-bearing env).
 */

import {
  open,
  lstat,
  rename,
  unlink,
  chmod,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ERROR_CODES, LinkeError, assertRegisteredErrorCode } from '../../src/error-codes.js';
import { isPrivateAgentHost } from '../../src/controller-runtime.js';

/** Exact real-LAN hardware gate (C8 locked). Default CI must leave unset. */
export const REAL_GATE_ENV = 'LINKE_REAL_G0B_UPLOAD_ACCEPTANCE';
export const REAL_GATE_VALUE = 'enabled';

/** Exact auto production-boundary gate (loopback only; not real-LAN evidence). */
export const AUTO_GATE_ENV = 'LINKE_G0B_AUTO_ACCEPTANCE';
export const AUTO_GATE_VALUE = 'enabled';

export const SCHEMA_VERSION = 1;
export const PURPOSE = 'linke-g0b-real-acceptance';
export const RUN_MARKER_FILE = '.linke-g0b-real-run.json';
export const AUTO_BUNDLE_FILE = 'auto-endpoint-bundle.json';
export const CONTROLLER_CONFIG_FILE = 'controller-config.json';

export const REAL_REPORT_RELATIVE_PATH =
  'docs/superpowers/reports/2026-07-22-g0b-real-lan-upload-acceptance.md';
export const REAL_LAN_REPORT_RELATIVE = REAL_REPORT_RELATIVE_PATH;

/** Fixed auto harness scenarios (production boundary via child_process endpoint). */
export const AUTO_SCENARIOS = Object.freeze([
  'disconnect-resume',
  'corrupt-chunk',
  'manifest-conflict',
  'cross-device-deny',
]);

const MAX_PRIVATE_JSON_BYTES = 64 * 1024;
export const SANITIZED_RESULT_KEYS = Object.freeze([
  'role', 'phase', 'status', 'code', 'count', 'flag', 'at', 'promptHandled',
]);
const SANITIZED_STATUSES = new Set(['PASS', 'FAIL', 'BLOCKED']);
const ALLOWED_SANITIZED_KEYS = new Set(SANITIZED_RESULT_KEYS);
const SENSITIVE_KEY_RE =
  /^(.*token.*|.*fingerprint.*|.*enrollment.*|.*keychain.*|.*private.*|.*secret.*|.*password.*|.*pem.*|.*cert.*|.*bearer.*|auth)$/i;
const SENSITIVE_VALUE_RE = /token|fingerprint|enrollment|keychain|private|secret|password/i;
const HEX64_RE = /^[0-9a-f]{64}$/i;
const PEM_RE = /-----BEGIN[ A-Z]*PRIVATE KEY-----|-----BEGIN CERTIFICATE-----/;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;

/**
 * @returns {LinkeError}
 */
function requestInvalidError() {
  return new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} value
 * @param {readonly string[]} allowed
 */
function assertExactKeys(value, allowed) {
  const keys = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (keys.length !== expected.length) throw requestInvalidError();
  for (let i = 0; i < expected.length; i += 1) {
    if (keys[i] !== expected[i]) throw requestInvalidError();
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertNonEmptyString(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw requestInvalidError();
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertIsoTimestamp(value) {
  const text = assertNonEmptyString(value);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== text) {
    throw requestInvalidError();
  }
  return text;
}

/**
 * Exact real-LAN gate: LINKE_REAL_G0B_UPLOAD_ACCEPTANCE === 'enabled'.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {true}
 */
export function assertRealGate(env = process.env) {
  if (env?.[REAL_GATE_ENV] !== REAL_GATE_VALUE) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
  }
  return true;
}

/**
 * Exact auto gate: LINKE_G0B_AUTO_ACCEPTANCE === 'enabled'.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {true}
 */
export function assertAutoGate(env = process.env) {
  if (env?.[AUTO_GATE_ENV] !== AUTO_GATE_VALUE) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
  }
  return true;
}

/**
 * @param {unknown} scenario
 * @returns {boolean}
 */
export function isAutoScenario(scenario) {
  return typeof scenario === 'string' && AUTO_SCENARIOS.includes(/** @type {any} */ (scenario));
}

/**
 * @param {unknown} scenario
 * @returns {string}
 */
export function assertAutoScenario(scenario) {
  if (!isAutoScenario(scenario)) throw requestInvalidError();
  return /** @type {string} */ (scenario);
}

/**
 * HTTPS Agent URL: parseable HTTPS, non-empty hostname, no userinfo/query/hash.
 * @param {unknown} agentUrl
 * @returns {string}
 */
export function assertHttpsAgentUrl(agentUrl) {
  if (typeof agentUrl !== 'string' || agentUrl.length === 0) throw requestInvalidError();
  let url;
  try {
    url = new URL(agentUrl);
  } catch {
    throw requestInvalidError();
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw requestInvalidError();
  }
  if (!url.hostname) throw requestInvalidError();
  return agentUrl;
}

/**
 * @param {string} runDir
 * @param {string} relativePath
 * @returns {string}
 */
export function resolveAllowlistedPath(runDir, relativePath) {
  if (typeof runDir !== 'string' || runDir.length === 0) throw requestInvalidError();
  if (typeof relativePath !== 'string' || relativePath.length === 0) throw requestInvalidError();
  if (relativePath.includes('\0')) throw requestInvalidError();
  if (relativePath.startsWith('/') || relativePath.startsWith('\\')) throw requestInvalidError();
  if (/^[a-zA-Z]:[\\/]/.test(relativePath) || relativePath.startsWith('\\\\')) {
    throw requestInvalidError();
  }
  const segments = relativePath.split(/[/\\]/);
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw requestInvalidError();
    }
  }
  const root = resolve(runDir);
  const resolved = resolve(root, relativePath);
  const rel = relative(root, resolved);
  if (rel.startsWith('..') || rel === '' || resolve(root, rel) !== resolved) {
    throw requestInvalidError();
  }
  if (!resolved.startsWith(root + sep) && resolved !== root) {
    throw requestInvalidError();
  }
  return resolved;
}

/**
 * @param {string} path
 * @param {(value: unknown) => unknown} validator
 * @param {{ openImpl?: typeof open, lstatImpl?: typeof lstat }} [deps]
 * @returns {Promise<unknown>}
 */
export async function readPrivateJson(
  path,
  validator,
  { openImpl = open, lstatImpl = lstat } = {},
) {
  if (typeof path !== 'string' || path.length === 0) throw requestInvalidError();
  if (typeof validator !== 'function') throw requestInvalidError();
  let st;
  try {
    st = await lstatImpl(path);
  } catch {
    throw requestInvalidError();
  }
  if (st.isSymbolicLink() || !st.isFile()) throw requestInvalidError();
  if ((st.mode & 0o777) !== 0o600) throw requestInvalidError();

  let handle;
  try {
    handle = await openImpl(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const fdStat = await handle.stat();
    if (fdStat.isSymbolicLink() || !fdStat.isFile()) throw requestInvalidError();
    if ((fdStat.mode & 0o777) !== 0o600) throw requestInvalidError();
    if (fdStat.size > MAX_PRIVATE_JSON_BYTES) throw requestInvalidError();
    const buf = Buffer.alloc(Number(fdStat.size));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    if (bytesRead !== buf.length) throw requestInvalidError();
    await handle.close();
    handle = undefined;
    let parsed;
    try {
      parsed = JSON.parse(buf.toString('utf8'));
    } catch {
      throw requestInvalidError();
    }
    return validator(parsed);
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
    if (error instanceof LinkeError) throw error;
    throw requestInvalidError();
  }
}

/**
 * @param {string} path
 * @param {unknown} value
 * @param {{
 *   openImpl?: typeof open,
 *   renameImpl?: typeof rename,
 *   unlinkImpl?: typeof unlink,
 *   chmodImpl?: typeof chmod,
 *   randomBytesImpl?: typeof randomBytes,
 * }} [deps]
 * @returns {Promise<void>}
 */
export async function atomicWritePrivateJson(
  path,
  value,
  {
    openImpl = open,
    renameImpl = rename,
    unlinkImpl = unlink,
    chmodImpl = chmod,
    randomBytesImpl = randomBytes,
  } = {},
) {
  if (typeof path !== 'string' || path.length === 0) throw requestInvalidError();
  let serialized;
  try {
    serialized = `${JSON.stringify(value)}\n`;
  } catch {
    throw requestInvalidError();
  }
  if (Buffer.byteLength(serialized) > MAX_PRIVATE_JSON_BYTES) throw requestInvalidError();

  const dir = dirname(path);
  const tempName = `.g0b-${randomBytesImpl(16).toString('hex')}.new`;
  const tempPath = join(dir, tempName);
  let handle;
  try {
    handle = await openImpl(
      tempPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(serialized, { encoding: 'utf8' });
    await handle.sync();
    if (typeof handle.chmod === 'function') {
      await handle.chmod(0o600);
    } else if (typeof chmodImpl === 'function') {
      await chmodImpl(tempPath, 0o600);
    }
    await handle.close();
    handle = undefined;
    await renameImpl(tempPath, path);
    const parent = await openImpl(dir, constants.O_RDONLY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } catch {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
    try { await unlinkImpl(tempPath); } catch { /* only temp */ }
    throw requestInvalidError();
  }
}

/**
 * Validate dedicated run directory marker (0600 regular file, fixed purpose).
 * @param {string} runDir
 * @param {{ readPrivateJsonImpl?: typeof readPrivateJson, lstatImpl?: typeof lstat }} [deps]
 * @returns {Promise<true>}
 */
export async function assertDedicatedRunDirectory(
  runDir,
  { readPrivateJsonImpl = readPrivateJson, lstatImpl = lstat } = {},
) {
  if (typeof runDir !== 'string' || runDir.length === 0) throw requestInvalidError();
  let rootStat;
  try {
    rootStat = await lstatImpl(runDir);
  } catch {
    throw requestInvalidError();
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw requestInvalidError();
  const markerPath = join(runDir, RUN_MARKER_FILE);
  await readPrivateJsonImpl(markerPath, (value) => {
    if (!isPlainObject(value)) throw requestInvalidError();
    assertExactKeys(value, ['schemaVersion', 'purpose']);
    if (value.schemaVersion !== SCHEMA_VERSION) throw requestInvalidError();
    if (value.purpose !== PURPOSE) throw requestInvalidError();
    return value;
  });
  return true;
}

/**
 * Exact private-IP fixed-port controller config (real-LAN only; no token fields).
 * @param {unknown} value
 */
export function validateControllerConfig(value) {
  if (!isPlainObject(value)) throw requestInvalidError();
  assertExactKeys(value, ['schemaVersion', 'agentHost', 'agentPort', 'managementPort']);
  if (value.schemaVersion !== SCHEMA_VERSION) throw requestInvalidError();
  if (typeof value.agentHost !== 'string' || !isPrivateAgentHost(value.agentHost)) {
    throw requestInvalidError();
  }
  if (!Number.isInteger(value.agentPort) || value.agentPort < 1 || value.agentPort > 65535) {
    throw requestInvalidError();
  }
  if (!Number.isInteger(value.managementPort)
    || value.managementPort < 0
    || value.managementPort > 65535) {
    throw requestInvalidError();
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    agentHost: value.agentHost,
    agentPort: value.agentPort,
    managementPort: value.managementPort,
  };
}

/**
 * @param {unknown} value
 * @returns {{ deviceId: string, token: string }}
 */
function validateDeviceCredential(value) {
  if (!isPlainObject(value)) throw requestInvalidError();
  assertExactKeys(value, ['deviceId', 'token']);
  const deviceId = assertNonEmptyString(value.deviceId);
  if (typeof value.token !== 'string' || value.token.length < 32) throw requestInvalidError();
  return { deviceId, token: value.token };
}

/**
 * Auto endpoint bundle (private 0600 under runDir; never stdout).
 * Loopback HTTPS only — auto harness is not real-LAN evidence.
 * @param {unknown} value
 */
export function validateAutoEndpointBundle(value) {
  if (!isPlainObject(value)) throw requestInvalidError();
  assertExactKeys(value, [
    'schemaVersion',
    'purpose',
    'kind',
    'agentUrl',
    'tlsFingerprint',
    'deviceA',
    'deviceB',
    'snapshotRootRelative',
  ]);
  if (value.schemaVersion !== SCHEMA_VERSION) throw requestInvalidError();
  if (value.purpose !== PURPOSE) throw requestInvalidError();
  if (value.kind !== 'auto-endpoint') throw requestInvalidError();
  const agentUrl = assertHttpsAgentUrl(value.agentUrl);
  let url;
  try {
    url = new URL(agentUrl);
  } catch {
    throw requestInvalidError();
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '::1') {
    throw requestInvalidError();
  }
  const tlsFingerprint = assertNonEmptyString(value.tlsFingerprint);
  if (!HEX64_RE.test(tlsFingerprint) || tlsFingerprint !== tlsFingerprint.toLowerCase()) {
    throw requestInvalidError();
  }
  const deviceA = validateDeviceCredential(value.deviceA);
  const deviceB = validateDeviceCredential(value.deviceB);
  if (deviceA.deviceId === deviceB.deviceId) throw requestInvalidError();
  const snapshotRootRelative = assertNonEmptyString(value.snapshotRootRelative);
  if (snapshotRootRelative.includes('/') || snapshotRootRelative.includes('\\')) {
    throw requestInvalidError();
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    purpose: PURPOSE,
    kind: 'auto-endpoint',
    agentUrl,
    tlsFingerprint,
    deviceA,
    deviceB,
    snapshotRootRelative,
  };
}

/**
 * @param {unknown} value
 * @param {string} [keyHint]
 */
export function assertNoSensitiveData(value, keyHint = '') {
  if (keyHint && !ALLOWED_SANITIZED_KEYS.has(keyHint) && SENSITIVE_KEY_RE.test(keyHint)) {
    throw requestInvalidError();
  }
  if (value === null || value === undefined) return;
  if (typeof value === 'number' || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (keyHint === 'code') {
      try {
        assertRegisteredErrorCode(value);
        return;
      } catch {
        throw requestInvalidError();
      }
    }
    if (keyHint === 'phase' || keyHint === 'role' || keyHint === 'status'
      || keyHint === 'promptHandled') {
      if (value.includes('/') || value.includes('\\')) throw requestInvalidError();
      if (URL_RE.test(value) || IPV4_RE.test(value)) throw requestInvalidError();
      if (HEX64_RE.test(value)) throw requestInvalidError();
      if (PEM_RE.test(value)) throw requestInvalidError();
      return;
    }
    if (value.includes('/') || value.includes('\\')) throw requestInvalidError();
    if (URL_RE.test(value) || IPV4_RE.test(value)) throw requestInvalidError();
    if (HEX64_RE.test(value)) throw requestInvalidError();
    if (PEM_RE.test(value)) throw requestInvalidError();
    if (SENSITIVE_VALUE_RE.test(value)) throw requestInvalidError();
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoSensitiveData(item);
    return;
  }
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      assertNoSensitiveData(v, k);
    }
    return;
  }
  throw requestInvalidError();
}

/**
 * @param {unknown} result
 * @returns {Record<string, unknown>}
 */
export function validateSanitizedResult(result) {
  if (!isPlainObject(result)) throw requestInvalidError();
  for (const key of Object.keys(result)) {
    if (!SANITIZED_RESULT_KEYS.includes(/** @type {any} */ (key))) {
      throw requestInvalidError();
    }
  }
  if (typeof result.role !== 'string' || result.role.length === 0) throw requestInvalidError();
  if (typeof result.phase !== 'string' || result.phase.length === 0) throw requestInvalidError();
  if (!SANITIZED_STATUSES.has(/** @type {string} */ (result.status))) throw requestInvalidError();
  if (typeof result.at !== 'string') throw requestInvalidError();
  assertIsoTimestamp(result.at);

  /** @type {Record<string, unknown>} */
  const out = {
    role: result.role,
    phase: result.phase,
    status: result.status,
    at: result.at,
  };
  if ('code' in result) {
    try {
      out.code = assertRegisteredErrorCode(/** @type {string} */ (result.code));
    } catch {
      throw requestInvalidError();
    }
  }
  if ('count' in result) {
    if (!Number.isInteger(result.count) || !Number.isFinite(result.count) || result.count < 0) {
      throw requestInvalidError();
    }
    out.count = result.count;
  }
  if ('flag' in result) {
    if (typeof result.flag !== 'boolean') throw requestInvalidError();
    out.flag = result.flag;
  }
  if ('promptHandled' in result) {
    if (typeof result.promptHandled !== 'string') throw requestInvalidError();
    out.promptHandled = result.promptHandled;
  }
  assertNoSensitiveData(out);
  return out;
}

/**
 * @param {unknown} result
 * @returns {string}
 */
export function serializeSanitizedResult(result) {
  const out = validateSanitizedResult(result);
  return `${JSON.stringify(out)}\n`;
}

/**
 * @param {string} role
 * @param {string} phase
 * @param {unknown} error
 * @param {() => Date} [now]
 */
export function sanitizedFailure(role, phase, error, now = () => new Date()) {
  let code = ERROR_CODES.DEVICE_INTERNAL_ERROR;
  if (error instanceof LinkeError) {
    try {
      code = assertRegisteredErrorCode(error.code);
    } catch {
      code = ERROR_CODES.DEVICE_INTERNAL_ERROR;
    }
  }
  const result = {
    role,
    phase,
    status: /** @type {const} */ ('FAIL'),
    code,
    at: now().toISOString(),
  };
  assertNoSensitiveData(result);
  return result;
}

/**
 * @param {string} role
 * @param {string} phase
 * @param {unknown} error
 * @param {() => Date} [now]
 */
export function sanitizedBlocked(role, phase, error, now = () => new Date()) {
  const base = sanitizedFailure(role, phase, error, now);
  return { ...base, status: /** @type {const} */ ('BLOCKED') };
}
