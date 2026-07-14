/**
 * G0a real two-Mac acceptance harness — common secret-safe primitives.
 * Import has zero side effects; real Keychain/network only after exact gate.
 */

import {
  open,
  lstat,
  rename,
  unlink,
  chmod,
  mkdir,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ERROR_CODES, LinkeError, assertRegisteredErrorCode } from '../../src/error-codes.js';
import { isPrivateAgentHost } from '../../src/controller-runtime.js';

export const REAL_GATE_ENV = 'LINKE_REAL_G0A_ACCEPTANCE';
export const REAL_GATE_VALUE = 'enabled';
export const SCHEMA_VERSION = 1;
export const CONTROLLER_CONFIG_FILE = 'controller-config.json';
export const RUN_MARKER_FILE = '.linke-g0a-real-run.json';
export const CONTROLLER_STATE_FILE = 'controller-state.json';
export const ENDPOINT_STATE_FILE = 'endpoint-state.json';
export const INITIAL_BUNDLE_FILE = 'bundle-initial.json';
export const REENROLLMENT_BUNDLE_FILE = 'bundle-reenrollment.json';
export const CONTROLLER_TLS_KEY_ITEM = 'controller-tls-private-key';
export const CONTROLLER_CERT_RELATIVE_PATH = 'tls/controller-cert.pem';

export const RECEIPT_FILES = Object.freeze({
  'pre-revoke': 'receipt-pre-revoke.json',
  'post-revoke': 'receipt-post-revoke.json',
  'post-restart': 'receipt-post-restart.json',
  'post-fingerprint-change': 'receipt-post-fingerprint-change.json',
  reenroll: 'receipt-reenroll.json',
});

export const CONTROLLER_STATES = Object.freeze([
  'initialized', 'controller-ready', 'preparing-bundle', 'bundle-prepared',
  'endpoint-pre-revoke-passed', 'revoking-current', 'current-revoked',
  'endpoint-post-revoke-passed', 'restarting-controller', 'controller-restarted',
  'restart-passed', 'replacing-fingerprint', 'identity-deleted', 'identity-regenerated',
  'fingerprint-replaced', 'preparing-reenrollment', 'reenrollment-bundle-prepared',
  'fingerprint-mismatch-passed', 'reenrollment-passed', 'cleaning', 'cleaned',
]);

export const ENDPOINT_STATES = Object.freeze([
  'initialized', 'pre-revoke-running', 'pre-revoke-passed',
  'post-revoke-running', 'post-revoke-passed',
  'post-restart-running', 'post-restart-passed',
  'post-fingerprint-change-running', 'post-fingerprint-change-passed',
  'reenroll-running', 'reenroll-passed', 'cleaning', 'cleaned',
]);

export const IDEMPOTENT_CONTROLLER_COMMANDS = Object.freeze({
  'bundle-prepared:prepare': true,
  'endpoint-pre-revoke-passed:ack-pre-revoke': true,
  'current-revoked:revoke-current': true,
  'endpoint-post-revoke-passed:ack-post-revoke': true,
  'controller-restarted:restart': true,
  'restart-passed:ack-post-restart': true,
  'fingerprint-replaced:replace-identity-confirmed': true,
  'reenrollment-bundle-prepared:prepare-reenrollment': true,
  'fingerprint-mismatch-passed:ack-post-fingerprint-change': true,
  'reenrollment-passed:ack-reenroll': true,
  'cleaned:stop': true,
});

export const IDEMPOTENT_ENDPOINT_PHASES = Object.freeze({
  'pre-revoke-passed:pre-revoke': true,
  'post-revoke-passed:post-revoke': true,
  'post-restart-passed:post-restart': true,
  'post-fingerprint-change-passed:post-fingerprint-change': true,
  'reenroll-passed:reenroll': true,
  'cleaned:cleanup': true,
});

const ENDPOINT_TRANSITIONS = Object.freeze({
  'initialized:begin-pre-revoke': 'pre-revoke-running',
  'pre-revoke-running:complete-pre-revoke': 'pre-revoke-passed',
  'pre-revoke-passed:begin-post-revoke': 'post-revoke-running',
  'post-revoke-running:complete-post-revoke': 'post-revoke-passed',
  'post-revoke-passed:begin-post-restart': 'post-restart-running',
  'post-restart-running:complete-post-restart': 'post-restart-passed',
  'post-restart-passed:begin-post-fingerprint-change': 'post-fingerprint-change-running',
  'post-fingerprint-change-running:complete-post-fingerprint-change': 'post-fingerprint-change-passed',
  'post-fingerprint-change-passed:begin-reenroll': 'reenroll-running',
  'reenroll-running:complete-reenroll': 'reenroll-passed',
  'cleaning:cleanup-complete': 'cleaned',
});

const TRANSITIONS = Object.freeze({
  'initialized:start': 'controller-ready',
  'controller-ready:prepare': 'preparing-bundle',
  'preparing-bundle:prepare-complete': 'bundle-prepared',
  'bundle-prepared:ack-pre-revoke': 'endpoint-pre-revoke-passed',
  'endpoint-pre-revoke-passed:revoke-current': 'revoking-current',
  'revoking-current:revoke-complete': 'current-revoked',
  'current-revoked:ack-post-revoke': 'endpoint-post-revoke-passed',
  'endpoint-post-revoke-passed:restart': 'restarting-controller',
  'restarting-controller:restart-complete': 'controller-restarted',
  'controller-restarted:ack-post-restart': 'restart-passed',
  'restart-passed:replace-identity-confirmed': 'replacing-fingerprint',
  'replacing-fingerprint:identity-delete-complete': 'identity-deleted',
  'identity-deleted:identity-regenerate-complete': 'identity-regenerated',
  'identity-regenerated:replacement-complete': 'fingerprint-replaced',
  'fingerprint-replaced:prepare-reenrollment': 'preparing-reenrollment',
  'preparing-reenrollment:prepare-reenrollment-complete': 'reenrollment-bundle-prepared',
  'reenrollment-bundle-prepared:ack-post-fingerprint-change': 'fingerprint-mismatch-passed',
  'fingerprint-mismatch-passed:ack-reenroll': 'reenrollment-passed',
  'cleaning:cleanup-complete': 'cleaned',
});

const MAX_PRIVATE_JSON_BYTES = 64 * 1024;
const SANITIZED_RESULT_KEYS = Object.freeze([
  'role', 'phase', 'status', 'code', 'count', 'flag', 'at', 'promptHandled',
]);
const SANITIZED_STATUSES = new Set(['PASS', 'FAIL', 'BLOCKED']);
const ALLOWED_SANITIZED_KEYS = new Set(SANITIZED_RESULT_KEYS);
const SENSITIVE_KEY_RE = /^(.*token.*|.*fingerprint.*|.*enrollment.*|.*keychain.*|.*private.*|.*secret.*|.*password.*|.*pem.*|.*cert.*|.*bearer.*|auth)$/i;
const SENSITIVE_VALUE_RE = /token|fingerprint|enrollment|keychain|private|secret|password/i;
const HEX64_RE = /^[0-9a-f]{64}$/i;
const PEM_RE = /-----BEGIN[ A-Z]*PRIVATE KEY-----|-----BEGIN CERTIFICATE-----/;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const PURPOSE = 'linke-g0a-real-acceptance';
/** Test-only Keychain service prefixes (trailing dot required; non-empty safe suffix). */
export const TEST_CONTROLLER_KEYCHAIN_SERVICE_PREFIX = 'com.linke.test.controller.';
export const TEST_ENDPOINT_KEYCHAIN_SERVICE_PREFIX = 'com.linke.test.endpoint.';
/** Matches production KeychainStore service id constraints. */
const KEYCHAIN_SAFE_SERVICE_RE = /^[a-z][a-z0-9.-]{1,63}$/;

/**
 * Map any failure to a fixed registered error without raw cause/message.
 * @returns {LinkeError}
 */
function requestInvalidError() {
  return new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
}

/**
 * True for plain objects only.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Exact-key allowlist check; rejects unknown keys without echo.
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
 * Non-empty string without path/NUL characters used in identifiers.
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
 * Strict test-only Controller Keychain service:
 * `com.linke.test.controller.` + non-empty Keychain-safe suffix.
 * @param {unknown} service
 * @returns {string}
 */
export function assertTestControllerKeychainService(service) {
  if (typeof service !== 'string' || service.length === 0) throw requestInvalidError();
  if (!service.startsWith(TEST_CONTROLLER_KEYCHAIN_SERVICE_PREFIX)) throw requestInvalidError();
  const suffix = service.slice(TEST_CONTROLLER_KEYCHAIN_SERVICE_PREFIX.length);
  if (suffix.length === 0) throw requestInvalidError();
  if (suffix.startsWith('.') || suffix.endsWith('.') || suffix.includes('..')) {
    throw requestInvalidError();
  }
  if (!KEYCHAIN_SAFE_SERVICE_RE.test(service)) throw requestInvalidError();
  return service;
}

/**
 * Strict test-only Endpoint Keychain service:
 * `com.linke.test.endpoint.` + non-empty Keychain-safe suffix.
 * @param {unknown} service
 * @returns {string}
 */
export function assertTestEndpointKeychainService(service) {
  if (typeof service !== 'string' || service.length === 0) throw requestInvalidError();
  if (!service.startsWith(TEST_ENDPOINT_KEYCHAIN_SERVICE_PREFIX)) throw requestInvalidError();
  const suffix = service.slice(TEST_ENDPOINT_KEYCHAIN_SERVICE_PREFIX.length);
  if (suffix.length === 0) throw requestInvalidError();
  if (suffix.startsWith('.') || suffix.endsWith('.') || suffix.includes('..')) {
    throw requestInvalidError();
  }
  if (!KEYCHAIN_SAFE_SERVICE_RE.test(service)) throw requestInvalidError();
  return service;
}

/**
 * HTTPS Agent URL rules equivalent to production parseAgentUrl:
 * parseable HTTPS, non-empty hostname, no userinfo/query/hash.
 * Harness maps all faults to DEVICE_REQUEST_INVALID (no raw echo).
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
 * ISO-8601 UTC timestamp string.
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
 * Exact real acceptance gate: LINKE_REAL_G0A_ACCEPTANCE === 'enabled'.
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
 * Transition Controller state; stop is the only escape edge into cleaning.
 * @param {string} state
 * @param {string} command
 * @returns {string}
 */
export function transitionControllerState(state, command) {
  if (command === 'stop' && CONTROLLER_STATES.includes(state) && state !== 'cleaned') {
    return 'cleaning';
  }
  const next = TRANSITIONS[`${state}:${command}`];
  if (!next) throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 409 });
  return next;
}

/**
 * Transition Endpoint state; cleanup is the only escape edge into cleaning.
 * @param {string} state
 * @param {string} command
 * @returns {string}
 */
export function transitionEndpointState(state, command) {
  if (command === 'cleanup' && ENDPOINT_STATES.includes(state) && state !== 'cleaned') {
    return 'cleaning';
  }
  const next = ENDPOINT_TRANSITIONS[`${state}:${command}`];
  if (!next) throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 409 });
  return next;
}

/**
 * Fixed idempotent Controller command table lookup.
 * @param {string} state
 * @param {string} command
 * @returns {boolean}
 */
export function isIdempotentControllerCommand(state, command) {
  return IDEMPOTENT_CONTROLLER_COMMANDS[`${state}:${command}`] === true;
}

/**
 * Fixed idempotent Endpoint phase table lookup.
 * @param {string} state
 * @param {string} phase
 * @returns {boolean}
 */
export function isIdempotentEndpointPhase(state, phase) {
  return IDEMPOTENT_ENDPOINT_PHASES[`${state}:${phase}`] === true;
}

/**
 * Resolve a relative path strictly inside runDir.
 * Rejects absolute, empty, NUL, empty/`.`/`..` segments, and out-of-root resolves.
 * @param {string} runDir
 * @param {string} relativePath
 * @returns {string}
 */
export function resolveAllowlistedPath(runDir, relativePath) {
  if (typeof runDir !== 'string' || runDir.length === 0) throw requestInvalidError();
  if (typeof relativePath !== 'string' || relativePath.length === 0) throw requestInvalidError();
  if (relativePath.includes('\0')) throw requestInvalidError();
  if (relativePath.startsWith('/') || relativePath.startsWith('\\')) throw requestInvalidError();
  // Windows drive / UNC style absolute
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
  // Ensure path stays under root even with trailing separators
  if (!resolved.startsWith(root + sep) && resolved !== root) {
    throw requestInvalidError();
  }
  return resolved;
}

/**
 * Walk runDir ancestors and target; reject symlink and type mismatch.
 * @param {string} runDir
 * @param {string} relativePath
 * @param {'file' | 'directory'} expectedType
 * @param {{ lstatImpl?: typeof lstat }} [deps]
 * @returns {Promise<string>}
 */
export async function assertSafeCleanupTarget(
  runDir,
  relativePath,
  expectedType,
  { lstatImpl = lstat } = {},
) {
  if (expectedType !== 'file' && expectedType !== 'directory') throw requestInvalidError();
  const target = resolveAllowlistedPath(runDir, relativePath);
  const root = resolve(runDir);
  const segments = relativePath.split(/[/\\]/).filter(Boolean);
  let current = root;
  for (let i = 0; i < segments.length; i += 1) {
    current = join(current, segments[i]);
    const isFinal = i === segments.length - 1;
    let st;
    try {
      st = await lstatImpl(current);
    } catch (error) {
      if (error && /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
        // Missing target or not-yet-created trailing segments are idempotent-safe.
        if (isFinal) return target;
        return target;
      }
      throw requestInvalidError();
    }
    if (st.isSymbolicLink()) throw requestInvalidError();
    if (isFinal) {
      if (expectedType === 'file' && !st.isFile()) throw requestInvalidError();
      if (expectedType === 'directory' && !st.isDirectory()) throw requestInvalidError();
    } else if (!st.isDirectory()) {
      throw requestInvalidError();
    }
  }
  return target;
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
  const marker = await readPrivateJsonImpl(markerPath, (value) => {
    if (!isPlainObject(value)) throw requestInvalidError();
    assertExactKeys(value, ['schemaVersion', 'purpose']);
    if (value.schemaVersion !== SCHEMA_VERSION) throw requestInvalidError();
    if (value.purpose !== PURPOSE) throw requestInvalidError();
    return value;
  });
  void marker;
  return true;
}

/**
 * Atomically write private JSON as a regular 0600 file (O_NOFOLLOW temp).
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
  const tempName = `.g0a-${randomBytesImpl(16).toString('hex')}.new`;
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
    // Prefer open FileHandle.chmod to avoid path-based TOCTOU after write.
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
 * Read private JSON: lstat + O_NOFOLLOW open + fstat mode/type + 64 KiB bound.
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
 * Optional private JSON: only ENOENT maps to null; every other fault is fail-closed.
 * @param {string} path
 * @param {(value: unknown) => unknown} validator
 * @param {{ openImpl?: typeof open, lstatImpl?: typeof lstat, readPrivateJsonImpl?: typeof readPrivateJson }} [deps]
 * @returns {Promise<unknown | null>}
 */
export async function readOptionalPrivateJson(
  path,
  validator,
  { openImpl = open, lstatImpl = lstat, readPrivateJsonImpl = readPrivateJson } = {},
) {
  if (typeof path !== 'string' || path.length === 0) throw requestInvalidError();
  if (typeof validator !== 'function') throw requestInvalidError();
  try {
    await lstatImpl(path);
  } catch (error) {
    if (error && /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      return null;
    }
    throw requestInvalidError();
  }
  return readPrivateJsonImpl(path, validator, { openImpl, lstatImpl });
}

/**
 * Exact private-IP fixed-port controller config (no token/secret fields).
 * @param {unknown} value
 * @returns {{
 *   schemaVersion: number,
 *   agentHost: string,
 *   agentPort: number,
 *   managementPort: number,
 * }}
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
 * Validate enrollment device entry that still carries a one-time code.
 * @param {unknown} value
 * @returns {{ deviceId: string, enrollmentCode: string }}
 */
function validateDeviceEnrollmentEntry(value) {
  if (!isPlainObject(value)) throw requestInvalidError();
  assertExactKeys(value, ['deviceId', 'enrollmentCode']);
  const deviceId = assertNonEmptyString(value.deviceId);
  if (typeof value.enrollmentCode !== 'string' || value.enrollmentCode.length < 32) {
    throw requestInvalidError();
  }
  return { deviceId, enrollmentCode: value.enrollmentCode };
}

/**
 * Validate device id-only entry for initial-consumed continuation bundles.
 * @param {unknown} value
 * @returns {{ deviceId: string }}
 */
function validateDeviceIdOnlyEntry(value) {
  if (!isPlainObject(value)) throw requestInvalidError();
  assertExactKeys(value, ['deviceId']);
  return { deviceId: assertNonEmptyString(value.deviceId) };
}

/**
 * Validate initial, initial-consumed, or reenrollment bundle; rejects unknown keys.
 * initial/reenrollment require canonical unexpired expiresAt; initial-consumed has no code TTL.
 * @param {unknown} value
 * @param {{ runId: string, now?: Date }} options
 * @returns {Record<string, unknown>}
 */
export function validateBundle(value, { runId, now = new Date() } = {}) {
  if (!isPlainObject(value)) throw requestInvalidError();
  const expectedRunId = assertNonEmptyString(runId);
  if (value.kind === 'initial') {
    assertExactKeys(value, [
      'schemaVersion', 'kind', 'runId', 'agentUrl', 'tlsFingerprint',
      'current', 'nMinusOne', 'nMinusTwo', 'endpointKeychainService',
      'createdAt', 'expiresAt',
    ]);
  } else if (value.kind === 'initial-consumed') {
    assertExactKeys(value, [
      'schemaVersion', 'kind', 'runId', 'agentUrl', 'tlsFingerprint',
      'current', 'nMinusOne', 'nMinusTwo', 'endpointKeychainService',
      'createdAt', 'consumedAt',
    ]);
  } else if (value.kind === 'reenrollment') {
    assertExactKeys(value, [
      'schemaVersion', 'kind', 'runId', 'agentUrl', 'tlsFingerprint',
      'current', 'endpointKeychainService', 'createdAt', 'expiresAt',
    ]);
  } else {
    throw requestInvalidError();
  }
  if (value.schemaVersion !== SCHEMA_VERSION) throw requestInvalidError();
  if (value.runId !== expectedRunId) throw requestInvalidError();
  const agentUrl = assertHttpsAgentUrl(value.agentUrl);
  const tlsFingerprint = assertNonEmptyString(value.tlsFingerprint);
  if (!HEX64_RE.test(tlsFingerprint)) throw requestInvalidError();
  const endpointKeychainService = assertTestEndpointKeychainService(value.endpointKeychainService);
  const createdAt = assertIsoTimestamp(value.createdAt);

  if (value.kind === 'initial-consumed') {
    const consumedAt = assertIsoTimestamp(value.consumedAt);
    return {
      schemaVersion: SCHEMA_VERSION,
      kind: 'initial-consumed',
      runId: expectedRunId,
      agentUrl,
      tlsFingerprint,
      current: validateDeviceIdOnlyEntry(value.current),
      nMinusOne: validateDeviceIdOnlyEntry(value.nMinusOne),
      nMinusTwo: validateDeviceIdOnlyEntry(value.nMinusTwo),
      endpointKeychainService,
      createdAt,
      consumedAt,
    };
  }

  const expiresAt = assertIsoTimestamp(value.expiresAt);
  if (Date.parse(expiresAt) <= now.getTime()) throw requestInvalidError();
  const current = validateDeviceEnrollmentEntry(value.current);
  /** @type {Record<string, unknown>} */
  const result = {
    schemaVersion: SCHEMA_VERSION,
    kind: value.kind,
    runId: expectedRunId,
    agentUrl,
    tlsFingerprint,
    current,
    endpointKeychainService,
    createdAt,
    expiresAt,
  };
  if (value.kind === 'initial') {
    result.nMinusOne = validateDeviceEnrollmentEntry(value.nMinusOne);
    result.nMinusTwo = validateDeviceEnrollmentEntry(value.nMinusTwo);
  }
  return result;
}

/**
 * Validate phase receipt; optional count/flag/code; requirePass enforces PASS.
 * @param {unknown} value
 * @param {{ runId: string, phase: string, requirePass?: boolean }} options
 * @returns {Record<string, unknown>}
 */
export function validateReceipt(value, { runId, phase, requirePass = false } = {}) {
  if (!isPlainObject(value)) throw requestInvalidError();
  const keys = Object.keys(value);
  const allowed = new Set(['schemaVersion', 'runId', 'phase', 'status', 'count', 'flag', 'code', 'at']);
  for (const key of keys) {
    if (!allowed.has(key)) throw requestInvalidError();
  }
  for (const required of ['schemaVersion', 'runId', 'phase', 'status', 'at']) {
    if (!(required in value)) throw requestInvalidError();
  }
  if (value.schemaVersion !== SCHEMA_VERSION) throw requestInvalidError();
  if (value.runId !== assertNonEmptyString(runId)) throw requestInvalidError();
  if (value.phase !== assertNonEmptyString(phase)) throw requestInvalidError();
  if (!SANITIZED_STATUSES.has(/** @type {string} */ (value.status))) throw requestInvalidError();
  if (requirePass && value.status !== 'PASS') throw requestInvalidError();
  const at = assertIsoTimestamp(value.at);
  /** @type {Record<string, unknown>} */
  const result = {
    schemaVersion: SCHEMA_VERSION,
    runId: value.runId,
    phase: value.phase,
    status: value.status,
    at,
  };
  if ('count' in value) {
    if (!Number.isInteger(value.count) || value.count < 0 || !Number.isFinite(value.count)) {
      throw requestInvalidError();
    }
    result.count = value.count;
  }
  if ('flag' in value) {
    if (typeof value.flag !== 'boolean') throw requestInvalidError();
    result.flag = value.flag;
  }
  if ('code' in value) {
    try {
      result.code = assertRegisteredErrorCode(/** @type {string} */ (value.code));
    } catch {
      throw requestInvalidError();
    }
  }
  return result;
}

/**
 * Shared state field validation with runDir-bound cleanup allowlist.
 * @param {unknown} value
 * @param {{
 *   runDir: string,
 *   states: readonly string[],
 *   extraRequired: string[],
 * }} options
 * @returns {Record<string, unknown>}
 */
function validateRunState(value, { runDir, states, extraRequired }) {
  if (!isPlainObject(value)) throw requestInvalidError();
  const required = [
    'schemaVersion', 'purpose', 'runId', 'phase',
    'cleanupFiles', 'cleanupDirectories',
    ...extraRequired,
  ];
  for (const key of required) {
    if (!(key in value)) throw requestInvalidError();
  }
  const allowed = new Set(required);
  // Optional device id fields for controller may be present
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)
      && key !== 'currentDeviceId'
      && key !== 'nMinusOneDeviceId'
      && key !== 'nMinusTwoDeviceId'
      && key !== 'controllerKeychainService'
      && key !== 'endpointKeychainService'
      && key !== 'dataDirectoryName'
      && key !== 'credentialItemIds') {
      throw requestInvalidError();
    }
  }
  if (value.schemaVersion !== SCHEMA_VERSION) throw requestInvalidError();
  if (value.purpose !== PURPOSE) throw requestInvalidError();
  assertNonEmptyString(value.runId);
  if (typeof value.phase !== 'string' || !states.includes(value.phase)) {
    throw requestInvalidError();
  }
  if (!Array.isArray(value.cleanupFiles) || !Array.isArray(value.cleanupDirectories)) {
    throw requestInvalidError();
  }
  for (const item of value.cleanupFiles) {
    if (typeof item !== 'string') throw requestInvalidError();
    resolveAllowlistedPath(runDir, item);
  }
  for (const item of value.cleanupDirectories) {
    if (typeof item !== 'string') throw requestInvalidError();
    resolveAllowlistedPath(runDir, item);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * Validate Controller state against dedicated runDir cleanup allowlist.
 * @param {unknown} value
 * @param {{ runDir: string }} options
 * @returns {Record<string, unknown>}
 */
export function validateControllerState(value, { runDir } = {}) {
  if (typeof runDir !== 'string') throw requestInvalidError();
  const state = validateRunState(value, {
    runDir,
    states: CONTROLLER_STATES,
    extraRequired: [
      'controllerKeychainService',
      'endpointKeychainService',
      'dataDirectoryName',
      'currentDeviceId',
      'nMinusOneDeviceId',
      'nMinusTwoDeviceId',
    ],
  });
  assertTestControllerKeychainService(state.controllerKeychainService);
  assertTestEndpointKeychainService(state.endpointKeychainService);
  // dataDirectoryName is a single allowlisted relative segment tree under runDir.
  resolveAllowlistedPath(runDir, /** @type {string} */ (state.dataDirectoryName));
  assertNonEmptyString(state.currentDeviceId);
  assertNonEmptyString(state.nMinusOneDeviceId);
  assertNonEmptyString(state.nMinusTwoDeviceId);
  return state;
}

/**
 * Validate Endpoint state against dedicated runDir cleanup allowlist.
 * @param {unknown} value
 * @param {{ runDir: string }} options
 * @returns {Record<string, unknown>}
 */
export function validateEndpointState(value, { runDir } = {}) {
  if (typeof runDir !== 'string') throw requestInvalidError();
  const state = validateRunState(value, {
    runDir,
    states: ENDPOINT_STATES,
    extraRequired: ['endpointKeychainService', 'credentialItemIds'],
  });
  assertTestEndpointKeychainService(state.endpointKeychainService);
  if (!Array.isArray(state.credentialItemIds)) throw requestInvalidError();
  for (const id of state.credentialItemIds) {
    if (typeof id !== 'string' || !id.startsWith('device-token.')) throw requestInvalidError();
  }
  return state;
}

/**
 * Recursively reject sensitive keys/values in sanitized output candidates.
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
    // Registered error codes under key `code` skip path/hex denylist checks.
    if (keyHint === 'code') {
      try {
        assertRegisteredErrorCode(value);
        return;
      } catch {
        throw requestInvalidError();
      }
    }
    // Control-plane enums may contain words like "reenrollment" / "token" in names.
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
 * Serialize only allowlisted sanitized result fields.
 * @param {unknown} result
 * @returns {string}
 */
export function serializeSanitizedResult(result) {
  if (!isPlainObject(result)) throw requestInvalidError();
  for (const key of Object.keys(result)) {
    if (!SANITIZED_RESULT_KEYS.includes(key)) throw requestInvalidError();
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
  return `${JSON.stringify(out)}\n`;
}

/**
 * Map any error to a sanitized FAIL result without raw message/stack.
 * @param {string} role
 * @param {string} phase
 * @param {unknown} error
 * @param {() => Date} [now]
 * @returns {{
 *   role: string,
 *   phase: string,
 *   status: 'FAIL',
 *   code: string,
 *   at: string,
 * }}
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
  const at = now().toISOString();
  const result = {
    role,
    phase,
    status: /** @type {const} */ ('FAIL'),
    code,
    at,
  };
  assertNoSensitiveData(result);
  return result;
}

/**
 * Preflight controller runtime paths before keychainFactory / startController / Keychain ops.
 * Lexically binds dataDirectoryName to runDir and walks the full cert ancestor chain
 * (`dataDirectoryName/tls/controller-cert.pem`). Missing dataDir/tls/cert is allowed for
 * first create; any existing symlink or type mismatch fails closed.
 * @param {string} runDir
 * @param {string} dataDirectoryName
 * @param {{ lstatImpl?: typeof lstat }} [deps]
 * @returns {Promise<{ dataDirName: string, certRel: string, dataDir: string }>}
 */
export async function assertControllerRuntimePaths(
  runDir,
  dataDirectoryName,
  {
    lstatImpl = lstat,
    knownDeviceIds = ['device-current', 'device-n-1'],
  } = {},
) {
  if (typeof dataDirectoryName !== 'string' || dataDirectoryName.length === 0) {
    throw requestInvalidError();
  }
  const dataDir = resolveAllowlistedPath(runDir, dataDirectoryName);
  const certRel = `${dataDirectoryName}/${CONTROLLER_CERT_RELATIVE_PATH}`;
  resolveAllowlistedPath(runDir, certRel);
  // Existing dataDir must be a non-symlink directory; missing is first-create safe.
  await assertSafeCleanupTarget(runDir, dataDirectoryName, 'directory', { lstatImpl });
  // Walk full cert ancestors: tls symlink / tls-as-file / cert symlink → fail closed.
  await assertSafeCleanupTarget(runDir, certRel, 'file', { lstatImpl });

  // Defense-in-depth: known registry/audit/repo ancestors before runtime/management.
  // Missing paths are first-create safe; existing symlink/type mismatch fails closed.
  await assertSafeCleanupTarget(runDir, `${dataDirectoryName}/device-registry-v1.json`, 'file', { lstatImpl });
  await assertSafeCleanupTarget(runDir, `${dataDirectoryName}/device-registry-v1.json.new`, 'file', { lstatImpl });
  await assertSafeCleanupTarget(runDir, `${dataDirectoryName}/audit`, 'directory', { lstatImpl });
  await assertSafeCleanupTarget(runDir, `${dataDirectoryName}/audit/events.jsonl`, 'file', { lstatImpl });
  await assertSafeCleanupTarget(runDir, `${dataDirectoryName}/repo`, 'directory', { lstatImpl });
  await assertSafeCleanupTarget(runDir, `${dataDirectoryName}/repo/devices`, 'directory', { lstatImpl });
  const deviceIds = Array.isArray(knownDeviceIds) ? knownDeviceIds : [];
  for (const deviceId of deviceIds) {
    if (typeof deviceId !== 'string' || deviceId.length === 0) throw requestInvalidError();
    await assertSafeCleanupTarget(
      runDir,
      `${dataDirectoryName}/repo/devices/${deviceId}`,
      'directory',
      { lstatImpl },
    );
    await assertSafeCleanupTarget(
      runDir,
      `${dataDirectoryName}/repo/devices/${deviceId}/device.json`,
      'file',
      { lstatImpl },
    );
  }
  return { dataDirName: dataDirectoryName, certRel, dataDir };
}

// Re-export mkdir for cleanup helpers that need directory creation in tests only.
export { mkdir };
