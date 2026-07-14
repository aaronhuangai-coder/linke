/**
 * G0a real acceptance Controller runner — loopback management + intent journal.
 * Import has zero side effects; main/signal only when explicitly invoked as direct entry.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { unlink, rmdir, lstat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { KeychainStore } from '../../src/keychain-store.js';
import { startController } from '../../src/controller-runtime.js';
import { ERROR_CODES, LinkeError, assertRegisteredErrorCode } from '../../src/error-codes.js';
import { DEVICE_PROTOCOL_VERSION } from '../../src/device-protocol.js';
import {
  assertRealGate,
  assertDedicatedRunDirectory,
  assertSafeCleanupTarget,
  assertTestControllerKeychainService,
  assertTestEndpointKeychainService,
  assertHttpsAgentUrl,
  assertControllerRuntimePaths,
  resolveAllowlistedPath,
  atomicWritePrivateJson,
  readPrivateJson,
  readOptionalPrivateJson,
  validateControllerConfig,
  validateControllerState,
  validateBundle,
  validateReceipt,
  transitionControllerState,
  isIdempotentControllerCommand,
  serializeSanitizedResult,
  sanitizedFailure,
  CONTROLLER_CONFIG_FILE,
  CONTROLLER_STATE_FILE,
  CONTROLLER_TLS_KEY_ITEM,
  CONTROLLER_CERT_RELATIVE_PATH,
  INITIAL_BUNDLE_FILE,
  REENROLLMENT_BUNDLE_FILE,
  RECEIPT_FILES,
  SCHEMA_VERSION,
} from './g0a-real-common.js';

const PURPOSE = 'linke-g0a-real-acceptance';
const MAX_RESPONSE_BYTES = 64 * 1024;
const MANAGEMENT_TIMEOUT_MS = 10_000;
const ALLOWED_MANAGEMENT_PATHS = new Set([
  '/api/device-enrollment-codes',
  '/api/device-revoke',
  '/api/agent-listener-status',
]);
/** Unsafe intents: cleanup-only after crash; never auto-replay business work. */
const CLEANUP_ONLY_START_PHASES = new Set([
  'preparing-bundle',
  'revoking-current',
  'preparing-reenrollment',
]);
const REPLACEMENT_RESUME_PHASES = new Set([
  'replacing-fingerprint',
  'identity-deleted',
  'identity-regenerated',
]);
/** After these durable intents, unprovable errors map to BLOCKED (never PASS). */
const INTENT_BLOCKED_PHASES = new Set([
  'preparing-bundle',
  'revoking-current',
  'restarting-controller',
  'replacing-fingerprint',
  'identity-deleted',
  'identity-regenerated',
  'preparing-reenrollment',
  'cleaning',
]);
const ENROLLMENT_RESPONSE_KEYS = Object.freeze([
  'deviceId',
  'enrollmentCode',
  'expiresAt',
  'agentUrl',
  'tlsFingerprint',
  'protocolVersion',
]);
const LOWER_HEX64_RE = /^[0-9a-f]{64}$/;
const ACK_COMMANDS = Object.freeze({
  'ack-pre-revoke': { phase: 'pre-revoke', command: 'ack-pre-revoke' },
  'ack-post-revoke': { phase: 'post-revoke', command: 'ack-post-revoke' },
  'ack-post-restart': { phase: 'post-restart', command: 'ack-post-restart' },
  'ack-post-fingerprint-change': {
    phase: 'post-fingerprint-change',
    command: 'ack-post-fingerprint-change',
  },
  'ack-reenroll': { phase: 'reenroll', command: 'ack-reenroll' },
});

/**
 * @returns {LinkeError}
 */
function requestInvalidError() {
  return new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
}

/**
 * @param {string} role
 * @param {string} phase
 * @param {unknown} error
 * @param {() => Date} now
 */
function blockedResult(role, phase, error, now) {
  const base = sanitizedFailure(role, phase, error, now);
  return { ...base, status: 'BLOCKED' };
}

/**
 * True when host is loopback for management HTTP.
 * @param {string} host
 * @returns {boolean}
 */
function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/**
 * Canonical UTC ISO-8601 timestamp only.
 * @param {unknown} value
 * @returns {string}
 */
function assertCanonicalExpiresAt(value) {
  if (typeof value !== 'string' || value.length === 0) throw requestInvalidError();
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) throw requestInvalidError();
  return value;
}

/**
 * Canonical expiresAt that is strictly in the future relative to now.
 * @param {unknown} value
 * @param {Date} now
 * @returns {string}
 */
function assertCanonicalFutureExpiresAt(value, now) {
  const iso = assertCanonicalExpiresAt(value);
  if (Date.parse(iso) <= now.getTime()) throw requestInvalidError();
  return iso;
}

/**
 * Exact-key enrollment management body (production 201 shape only).
 * @param {unknown} body
 * @param {string} expectedDeviceId
 * @param {Date} now
 * @returns {{
 *   deviceId: string,
 *   enrollmentCode: string,
 *   expiresAt: string,
 *   agentUrl: string,
 *   tlsFingerprint: string,
 *   protocolVersion: number,
 * }}
 */
function parseEnrollmentManagementBody(body, expectedDeviceId, now) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw requestInvalidError();
  const record = /** @type {Record<string, unknown>} */ (body);
  const keys = Object.keys(record).sort();
  const expected = [...ENROLLMENT_RESPONSE_KEYS].sort();
  if (keys.length !== expected.length) throw requestInvalidError();
  for (let i = 0; i < expected.length; i += 1) {
    if (keys[i] !== expected[i]) throw requestInvalidError();
  }
  if (record.deviceId !== expectedDeviceId) throw requestInvalidError();
  if (typeof record.enrollmentCode !== 'string' || record.enrollmentCode.length < 32) {
    throw requestInvalidError();
  }
  const agentUrl = assertHttpsAgentUrl(record.agentUrl);
  if (typeof record.tlsFingerprint !== 'string' || !LOWER_HEX64_RE.test(record.tlsFingerprint)) {
    throw requestInvalidError();
  }
  if (record.protocolVersion !== DEVICE_PROTOCOL_VERSION) throw requestInvalidError();
  const expiresAt = assertCanonicalFutureExpiresAt(record.expiresAt, now);
  return {
    deviceId: expectedDeviceId,
    enrollmentCode: record.enrollmentCode,
    expiresAt,
    agentUrl,
    tlsFingerprint: record.tlsFingerprint,
    protocolVersion: DEVICE_PROTOCOL_VERSION,
  };
}

/**
 * Map unprovable post-intent failures to sanitized BLOCKED.
 * @param {string} command
 * @param {string | undefined} phase
 * @param {unknown} error
 * @param {() => Date} now
 */
function intentAwareFailure(command, phase, error, now) {
  if (phase && INTENT_BLOCKED_PHASES.has(phase)) {
    return blockedResult('controller', command, error, now);
  }
  return sanitizedFailure('controller', command, error, now);
}

/**
 * Loopback management JSON request with memory-only Bearer token.
 * @param {{
 *   host: string,
 *   port: number,
 *   path: string,
 *   method?: string,
 *   token: string,
 *   body?: unknown,
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<{ statusCode: number, body: unknown }>}
 */
export async function requestManagementJson({
  host,
  port,
  path,
  method = 'POST',
  token,
  body,
  timeoutMs = MANAGEMENT_TIMEOUT_MS,
}) {
  if (!isLoopbackHost(host)) throw requestInvalidError();
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw requestInvalidError();
  if (!ALLOWED_MANAGEMENT_PATHS.has(path)) throw requestInvalidError();
  if (typeof token !== 'string' || token.length < 32) throw requestInvalidError();
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MANAGEMENT_TIMEOUT_MS) {
    throw requestInvalidError();
  }

  let payload = '';
  if (body !== undefined) {
    try {
      payload = JSON.stringify(body);
    } catch {
      throw requestInvalidError();
    }
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      reject(requestInvalidError());
    };
    const req = httpRequest(
      {
        host,
        port,
        path,
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            res.destroy();
            fail();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          let parsed = null;
          const raw = Buffer.concat(chunks).toString('utf8');
          if (raw.length > 0) {
            try {
              parsed = JSON.parse(raw);
            } catch {
              reject(requestInvalidError());
              return;
            }
          }
          const statusCode = res.statusCode ?? 0;
          if (statusCode < 200 || statusCode > 299) {
            let code = ERROR_CODES.DEVICE_REQUEST_INVALID;
            if (parsed && typeof parsed === 'object' && 'error' in parsed) {
              try {
                code = assertRegisteredErrorCode(
                  /** @type {{ error?: unknown }} */ (parsed).error,
                );
              } catch {
                code = ERROR_CODES.DEVICE_REQUEST_INVALID;
              }
            }
            reject(new LinkeError(code, {
              statusCode: statusCode >= 400 && statusCode <= 599 ? statusCode : 400,
            }));
            return;
          }
          resolve({ statusCode, body: parsed });
        });
        res.on('error', fail);
      },
    );
    req.on('error', fail);
    req.on('timeout', () => {
      req.destroy();
      fail();
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Build default initial controller state (non-secret fields only).
 * @param {{
 *   runId: string,
 *   controllerKeychainService: string,
 *   endpointKeychainService: string,
 *   currentDeviceId: string,
 *   nMinusOneDeviceId: string,
 *   nMinusTwoDeviceId: string,
 * }} ids
 */
function buildInitialState(ids) {
  return {
    schemaVersion: SCHEMA_VERSION,
    purpose: PURPOSE,
    runId: ids.runId,
    phase: 'initialized',
    controllerKeychainService: ids.controllerKeychainService,
    endpointKeychainService: ids.endpointKeychainService,
    dataDirectoryName: 'controller-data',
    cleanupFiles: [
      'bundle-initial.json', 'bundle-reenrollment.json',
      'receipt-pre-revoke.json', 'receipt-post-revoke.json',
      'receipt-post-restart.json', 'receipt-post-fingerprint-change.json',
      'receipt-reenroll.json',
      'controller-data/device-registry-v1.json',
      'controller-data/device-registry-v1.json.new',
      'controller-data/tls/controller-cert.pem',
      'controller-data/audit/events.jsonl',
      'controller-data/repo/devices/device-current/device.json',
      'controller-data/repo/devices/device-n-1/device.json',
    ],
    cleanupDirectories: [
      'controller-data/repo/devices/device-current',
      'controller-data/repo/devices/device-n-1',
      'controller-data/repo/devices',
      'controller-data/repo',
      'controller-data/audit',
      'controller-data/tls',
      'controller-data',
    ],
    currentDeviceId: ids.currentDeviceId,
    nMinusOneDeviceId: ids.nMinusOneDeviceId,
    nMinusTwoDeviceId: ids.nMinusTwoDeviceId,
  };
}

/**
 * Create Controller harness (no Keychain/network/signal at construct time).
 * @param {object} [options]
 * @returns {Promise<{
 *   start(): Promise<object>,
 *   execute(command: string): Promise<object>,
 *   close(): Promise<void>,
 *   getState(): object,
 * }>}
 */
export async function createControllerHarness({
  env = process.env,
  runDir = process.cwd(),
  now = () => new Date(),
  randomUuid = randomUUID,
  randomBytesImpl = randomBytes,
  keychainFactory = (service) => new KeychainStore({ service }),
  startControllerImpl = startController,
  managementRequest = requestManagementJson,
  readConfig,
  readState,
  writeState,
  writeBundle,
  readReceipt,
  deleteReceipt,
  deleteFile,
  certExists,
} = {}) {
  assertRealGate(env);
  await assertDedicatedRunDirectory(runDir);

  /** @type {string | undefined} management token — memory only, never on object */
  let managementToken;
  /** @type {object | null} */
  let runtime = null;
  /** @type {Record<string, unknown> | null} */
  let state = null;
  /** @type {{ agentHost: string, agentPort: number, managementPort: number } | null} */
  let config = null;
  /** @type {{ get: Function, set: Function, delete: Function } | null} */
  let keychain = null;
  /** When true, only stop is allowed (unsafe intent recovery). */
  let cleanupOnly = false;

  const at = () => now().toISOString();

  async function loadConfig() {
    if (typeof readConfig === 'function') {
      const raw = await readConfig();
      const normalized = raw && typeof raw === 'object' && !('schemaVersion' in raw)
        ? { schemaVersion: SCHEMA_VERSION, ...raw }
        : raw;
      return validateControllerConfig(normalized);
    }
    const raw = await readPrivateJson(
      join(runDir, CONTROLLER_CONFIG_FILE),
      (value) => validateControllerConfig(value),
    );
    return /** @type {{ agentHost: string, agentPort: number, managementPort: number }} */ (raw);
  }

  async function loadState() {
    if (typeof readState === 'function') {
      const value = await readState();
      if (value == null) return null;
      return validateControllerState(value, { runDir });
    }
    // Only ENOENT → null; corrupt/mode/schema/symlink → throw (fail-closed).
    return /** @type {Record<string, unknown> | null} */ (await readOptionalPrivateJson(
      join(runDir, CONTROLLER_STATE_FILE),
      (value) => validateControllerState(value, { runDir }),
    ));
  }

  async function persistState(next) {
    const validated = validateControllerState(next, { runDir });
    const snapshot = structuredClone(validated);
    if (typeof writeState === 'function') {
      await writeState(structuredClone(snapshot));
    } else {
      await atomicWritePrivateJson(join(runDir, CONTROLLER_STATE_FILE), snapshot);
    }
    // Memory reflects durable state only after a successful write.
    state = snapshot;
  }

  async function persistBundle(fileName, value) {
    if (typeof writeBundle === 'function') {
      await writeBundle(fileName, value);
      return;
    }
    await atomicWritePrivateJson(join(runDir, fileName), value);
  }

  async function loadReceipt(phaseName) {
    if (typeof readReceipt === 'function') {
      return readReceipt(phaseName);
    }
    const file = RECEIPT_FILES[phaseName];
    if (!file) throw requestInvalidError();
    return readPrivateJson(join(runDir, file), (value) => value);
  }

  async function removeReceipt(phaseName) {
    if (typeof deleteReceipt === 'function') {
      await deleteReceipt(phaseName);
      return;
    }
    const file = RECEIPT_FILES[phaseName];
    if (!file) throw requestInvalidError();
    try {
      if (typeof deleteFile === 'function') await deleteFile(file);
      else await unlink(join(runDir, file));
    } catch (error) {
      if (error && /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return;
      throw requestInvalidError();
    }
  }

  function requireState() {
    if (!state) throw requestInvalidError();
    return state;
  }

  function managementPort() {
    if (!runtime?.managementServer) throw requestInvalidError();
    const addr = runtime.managementServer.address();
    if (!addr || typeof addr === 'string') throw requestInvalidError();
    return addr.port;
  }

  /**
   * Relative cert path under runDir (allowlisted); never absolute/escaped.
   * @returns {string}
   */
  function certRelativePath() {
    const current = requireState();
    const dataDirName = /** @type {string} */ (current.dataDirectoryName);
    resolveAllowlistedPath(runDir, dataDirName);
    const rel = `${dataDirName}/${CONTROLLER_CERT_RELATIVE_PATH}`;
    resolveAllowlistedPath(runDir, rel);
    return rel;
  }

  /**
   * Runtime path preflight before any keychainFactory / startController / Keychain ops.
   * @returns {Promise<{ dataDirName: string, certRel: string, dataDir: string }>}
   */
  async function preflightRuntimePaths() {
    const current = requireState();
    assertTestControllerKeychainService(current.controllerKeychainService);
    assertTestEndpointKeychainService(current.endpointKeychainService);
    return assertControllerRuntimePaths(
      runDir,
      /** @type {string} */ (current.dataDirectoryName),
    );
  }

  /**
   * Presence-only cert probe. Injected certExists never bypasses path safety.
   * @returns {Promise<boolean>}
   */
  async function probeCertPresent() {
    const certRel = certRelativePath();
    // Symlink ancestor / type mismatch → throw before any Keychain delete.
    await assertSafeCleanupTarget(runDir, certRel, 'file');
    if (typeof certExists === 'function') {
      return Boolean(await certExists());
    }
    const abs = resolveAllowlistedPath(runDir, certRel);
    try {
      const st = await lstat(abs);
      return st.isFile() && !st.isSymbolicLink();
    } catch (error) {
      if (error && /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return false;
      throw requestInvalidError();
    }
  }

  /**
   * Presence-only probe for paired TLS identity (never returns secret material).
   * @returns {Promise<{ keyPresent: boolean, certPresent: boolean }>}
   */
  async function probeIdentityPair() {
    if (!keychain) throw requestInvalidError();
    let keyPresent = false;
    try {
      await keychain.get(CONTROLLER_TLS_KEY_ITEM);
      keyPresent = true;
    } catch (error) {
      if (error instanceof LinkeError && error.code === ERROR_CODES.KEYCHAIN_UNAVAILABLE) {
        throw error;
      }
      if (error instanceof LinkeError && error.code === ERROR_CODES.KEYCHAIN_ITEM_MISSING) {
        keyPresent = false;
      } else if (error instanceof LinkeError) {
        throw error;
      } else {
        throw requestInvalidError();
      }
    }
    const certPresent = await probeCertPresent();
    return { keyPresent, certPresent };
  }

  async function startRuntime(acceptTlsFingerprintChange = false) {
    if (!config || !keychain || !managementToken || !state) throw requestInvalidError();
    // Defense-in-depth: re-validate full cert ancestor chain before startController.
    const { dataDir } = await preflightRuntimePaths();
    runtime = await startControllerImpl({
      dataDir,
      managementHost: '127.0.0.1',
      managementPort: config.managementPort,
      agentHost: config.agentHost,
      agentPort: config.agentPort,
      authToken: managementToken,
      keychain,
      acceptTlsFingerprintChange,
    });
    return runtime;
  }

  async function closeRuntime() {
    if (runtime && typeof runtime.close === 'function') {
      await runtime.close();
    }
    runtime = null;
  }

  function ensureTokenAndKeychain() {
    const current = requireState();
    const service = assertTestControllerKeychainService(current.controllerKeychainService);
    assertTestEndpointKeychainService(current.endpointKeychainService);
    keychain = keychainFactory(service);
    if (!managementToken) {
      managementToken = randomBytesImpl(32).toString('base64url');
    }
  }

  /**
   * Delete paired identity only when both key and cert are present.
   * Preflight service + cert path before any Keychain get/delete or file delete.
   * both missing → already deleted; half-state / unavailable → BLOCKED.
   */
  async function deleteIdentityPairOrResume() {
    const current = requireState();
    // Path safety first: never delete Keychain if cert path is unsafe.
    const { certRel } = await preflightRuntimePaths();

    const { keyPresent, certPresent } = await probeIdentityPair();
    if (!keyPresent && !certPresent) return;
    if (keyPresent !== certPresent) {
      throw new LinkeError(ERROR_CODES.DEVICE_TLS_IDENTITY_INCOMPLETE);
    }
    if (!keychain) throw requestInvalidError();
    let deleted;
    try {
      deleted = await keychain.delete(CONTROLLER_TLS_KEY_ITEM);
    } catch (error) {
      if (error instanceof LinkeError && error.code === ERROR_CODES.KEYCHAIN_UNAVAILABLE) {
        throw error;
      }
      throw new LinkeError(ERROR_CODES.DEVICE_TLS_IDENTITY_INCOMPLETE);
    }
    // Expected present: delete false is not success.
    if (deleted === false) {
      throw new LinkeError(ERROR_CODES.DEVICE_TLS_IDENTITY_INCOMPLETE);
    }
    // Re-assert path immediately before file delete (defense in depth).
    await assertSafeCleanupTarget(runDir, certRel, 'file');
    try {
      if (typeof deleteFile === 'function') await deleteFile(certRel);
      else await unlink(resolveAllowlistedPath(runDir, certRel));
    } catch (error) {
      if (!(error && /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT')) {
        throw new LinkeError(ERROR_CODES.DEVICE_TLS_IDENTITY_INCOMPLETE);
      }
    }
  }

  /**
   * Observe no-accept fingerprint mismatch after identity regeneration.
   */
  async function observeNoAcceptMismatch() {
    let mismatchSeen = false;
    try {
      await startRuntime(false);
    } catch (error) {
      if (error instanceof LinkeError
        && error.code === ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH) {
        mismatchSeen = true;
      } else {
        throw error instanceof LinkeError ? error : requestInvalidError();
      }
    }
    if (!mismatchSeen) throw requestInvalidError();
    await closeRuntime();
  }

  /**
   * Complete accept path when still mismatch; skip if already accepted.
   */
  async function completeAcceptIfNeeded() {
    try {
      await startRuntime(false);
      // Already matching ⇒ accept completed before crash.
      return;
    } catch (error) {
      if (!(error instanceof LinkeError
        && error.code === ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH)) {
        throw error instanceof LinkeError ? error : requestInvalidError();
      }
    }
    await closeRuntime();
    await startRuntime(true);
  }

  /**
   * Resume or finish identity replacement from a durable substate.
   * @param {string} fromPhase
   */
  async function resumeReplacement(fromPhase) {
    // Preflight service + full cert ancestor path before factory/get/delete.
    await preflightRuntimePaths();
    ensureTokenAndKeychain();
    await closeRuntime();
    let phase = fromPhase;

    if (phase === 'replacing-fingerprint') {
      await deleteIdentityPairOrResume();
      phase = transitionControllerState(phase, 'identity-delete-complete');
      await persistState({ ...requireState(), phase });
    }

    if (phase === 'identity-deleted') {
      await observeNoAcceptMismatch();
      phase = transitionControllerState(phase, 'identity-regenerate-complete');
      await persistState({ ...requireState(), phase });
    }

    if (phase === 'identity-regenerated') {
      await completeAcceptIfNeeded();
      phase = transitionControllerState(phase, 'replacement-complete');
      await persistState({ ...requireState(), phase });
    }

    return {
      role: 'controller',
      phase: 'replace-identity-confirmed',
      status: 'PASS',
      at: at(),
    };
  }

  /**
   * Start or resume controller with explicit recovery branches.
   * @returns {Promise<object>}
   */
  async function start() {
    config = await loadConfig();
    const existing = await loadState();

    if (!existing) {
      const initial = buildInitialState({
        runId: randomUuid(),
        controllerKeychainService: `com.linke.test.controller.${randomUuid()}`,
        endpointKeychainService: `com.linke.test.endpoint.${randomUuid()}`,
        currentDeviceId: 'device-current',
        nMinusOneDeviceId: 'device-n-1',
        nMinusTwoDeviceId: 'device-n-2',
      });
      await persistState(initial);
      // Path preflight before factory / startController (missing dataDir/tls allowed).
      await preflightRuntimePaths();
      ensureTokenAndKeychain();
      await startRuntime(false);
      const next = {
        ...requireState(),
        phase: transitionControllerState('initialized', 'start'),
      };
      await persistState(next);
      return {
        role: 'controller',
        phase: 'start',
        status: 'PASS',
        at: at(),
      };
    }

    state = structuredClone(existing);
    const phase = /** @type {string} */ (existing.phase);

    if (phase === 'cleaned') {
      // Idempotent PASS — never start listener after full cleanup.
      return {
        role: 'controller',
        phase: 'start',
        status: 'PASS',
        flag: true,
        at: at(),
      };
    }

    if (CLEANUP_ONLY_START_PHASES.has(phase)) {
      cleanupOnly = true;
      return blockedResult(
        'controller',
        'start',
        new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 409 }),
        now,
      );
    }

    if (phase === 'cleaning') {
      cleanupOnly = true;
      return {
        role: 'controller',
        phase: 'start',
        status: 'PASS',
        at: at(),
      };
    }

    if (phase === 'restarting-controller') {
      try {
        await preflightRuntimePaths();
        ensureTokenAndKeychain();
        await startRuntime(false);
        await persistState({
          ...requireState(),
          phase: transitionControllerState('restarting-controller', 'restart-complete'),
        });
        return {
          role: 'controller',
          phase: 'start',
          status: 'PASS',
          at: at(),
        };
      } catch (error) {
        const err = error instanceof LinkeError ? error : requestInvalidError();
        return blockedResult('controller', 'start', err, now);
      }
    }

    if (REPLACEMENT_RESUME_PHASES.has(phase)) {
      try {
        return await resumeReplacement(phase);
      } catch (error) {
        const err = error instanceof LinkeError ? error : requestInvalidError();
        return blockedResult('controller', 'start', err, now);
      }
    }

    await preflightRuntimePaths();
    ensureTokenAndKeychain();
    await startRuntime(false);

    if (phase === 'initialized') {
      await persistState({
        ...requireState(),
        phase: transitionControllerState('initialized', 'start'),
      });
    }
    return {
      role: 'controller',
      phase: 'start',
      status: 'PASS',
      at: at(),
    };
  }

  async function issueEnrollmentCode(deviceId) {
    if (!managementToken) throw requestInvalidError();
    const response = await managementRequest({
      host: '127.0.0.1',
      port: managementPort(),
      path: '/api/device-enrollment-codes',
      method: 'POST',
      token: managementToken,
      body: { deviceId },
    });
    if (response.statusCode !== 201 || !response.body || typeof response.body !== 'object') {
      throw requestInvalidError();
    }
    return parseEnrollmentManagementBody(response.body, deviceId, now());
  }

  async function executePrepare() {
    const current = requireState();
    const intentPhase = transitionControllerState(/** @type {string} */ (current.phase), 'prepare');
    await persistState({ ...current, phase: intentPhase });

    try {
      const codes = [];
      for (const deviceId of [
        current.currentDeviceId,
        current.nMinusOneDeviceId,
        current.nMinusTwoDeviceId,
      ]) {
        codes.push(await issueEnrollmentCode(/** @type {string} */ (deviceId)));
      }

      const first = codes[0];
      for (const code of codes) {
        if (code.agentUrl !== first.agentUrl
          || code.tlsFingerprint !== first.tlsFingerprint
          || code.protocolVersion !== first.protocolVersion) {
          throw requestInvalidError();
        }
      }
      const createdAt = at();
      const expiryMs = codes.map((c) => Date.parse(c.expiresAt));
      const earliest = Math.min(...expiryMs);
      const expiresAt = new Date(earliest).toISOString();
      const candidate = {
        schemaVersion: SCHEMA_VERSION,
        kind: 'initial',
        runId: current.runId,
        agentUrl: first.agentUrl,
        tlsFingerprint: first.tlsFingerprint,
        current: {
          deviceId: current.currentDeviceId,
          enrollmentCode: codes[0].enrollmentCode,
        },
        nMinusOne: {
          deviceId: current.nMinusOneDeviceId,
          enrollmentCode: codes[1].enrollmentCode,
        },
        nMinusTwo: {
          deviceId: current.nMinusTwoDeviceId,
          enrollmentCode: codes[2].enrollmentCode,
        },
        endpointKeychainService: current.endpointKeychainService,
        createdAt,
        expiresAt,
      };
      const validated = validateBundle(candidate, {
        runId: /** @type {string} */ (current.runId),
        now: now(),
      });
      await persistBundle(INITIAL_BUNDLE_FILE, validated);
      const nextPhase = transitionControllerState(intentPhase, 'prepare-complete');
      await persistState({ ...requireState(), phase: nextPhase });
      return {
        role: 'controller',
        phase: 'prepare',
        status: 'PASS',
        count: 3,
        at: at(),
      };
    } catch (error) {
      // Intent already journaled; validation/write/complete uncertainty → BLOCKED.
      const err = error instanceof LinkeError ? error : requestInvalidError();
      return blockedResult('controller', 'prepare', err, now);
    }
  }

  async function executeAck(command) {
    const meta = ACK_COMMANDS[command];
    if (!meta) throw requestInvalidError();
    const current = requireState();
    const receiptRaw = await loadReceipt(meta.phase);
    validateReceipt(receiptRaw, {
      runId: /** @type {string} */ (current.runId),
      phase: meta.phase,
      requirePass: true,
    });
    const nextPhase = transitionControllerState(
      /** @type {string} */ (current.phase),
      meta.command,
    );
    await persistState({ ...current, phase: nextPhase });
    await removeReceipt(meta.phase);
    return {
      role: 'controller',
      phase: command,
      status: 'PASS',
      at: at(),
    };
  }

  async function executeRevoke() {
    const current = requireState();
    const intentPhase = transitionControllerState(
      /** @type {string} */ (current.phase),
      'revoke-current',
    );
    await persistState({ ...current, phase: intentPhase });
    if (!managementToken) {
      return blockedResult('controller', 'revoke-current', requestInvalidError(), now);
    }
    try {
      const response = await managementRequest({
        host: '127.0.0.1',
        port: managementPort(),
        path: '/api/device-revoke',
        method: 'POST',
        token: managementToken,
        body: { deviceId: current.currentDeviceId },
      });
      if (response.statusCode !== 200 || !response.body || typeof response.body !== 'object') {
        return blockedResult('controller', 'revoke-current', requestInvalidError(), now);
      }
      const body = /** @type {Record<string, unknown>} */ (response.body);
      if (body.deviceId !== current.currentDeviceId || body.revoked !== true) {
        return blockedResult('controller', 'revoke-current', requestInvalidError(), now);
      }
    } catch (error) {
      const err = error instanceof LinkeError ? error : requestInvalidError();
      return blockedResult('controller', 'revoke-current', err, now);
    }
    const nextPhase = transitionControllerState(intentPhase, 'revoke-complete');
    await persistState({ ...requireState(), phase: nextPhase });
    return {
      role: 'controller',
      phase: 'revoke-current',
      status: 'PASS',
      at: at(),
    };
  }

  async function executeRestart() {
    const current = requireState();
    const intentPhase = transitionControllerState(
      /** @type {string} */ (current.phase),
      'restart',
    );
    await persistState({ ...current, phase: intentPhase });
    try {
      // Preflight before any runtime rewrite (reuses existing factory when present).
      await preflightRuntimePaths();
      await closeRuntime();
      await startRuntime(false);
      const nextPhase = transitionControllerState(intentPhase, 'restart-complete');
      await persistState({ ...requireState(), phase: nextPhase });
      return {
        role: 'controller',
        phase: 'restart',
        status: 'PASS',
        at: at(),
      };
    } catch (error) {
      const err = error instanceof LinkeError ? error : requestInvalidError();
      return blockedResult('controller', 'restart', err, now);
    }
  }

  async function executeReplaceIdentity() {
    const current = requireState();
    const intentPhase = transitionControllerState(
      /** @type {string} */ (current.phase),
      'replace-identity-confirmed',
    );
    await persistState({ ...current, phase: intentPhase });
    try {
      return await resumeReplacement(intentPhase);
    } catch (error) {
      if (error instanceof LinkeError
        && (error.code === ERROR_CODES.DEVICE_TLS_IDENTITY_INCOMPLETE
          || error.code === ERROR_CODES.KEYCHAIN_UNAVAILABLE)) {
        return blockedResult('controller', 'replace-identity-confirmed', error, now);
      }
      throw error instanceof LinkeError ? error : requestInvalidError();
    }
  }

  async function executePrepareReenrollment() {
    const current = requireState();
    const intentPhase = transitionControllerState(
      /** @type {string} */ (current.phase),
      'prepare-reenrollment',
    );
    await persistState({ ...current, phase: intentPhase });
    try {
      const body = await issueEnrollmentCode(/** @type {string} */ (current.currentDeviceId));
      const createdAt = at();
      const candidate = {
        schemaVersion: SCHEMA_VERSION,
        kind: 'reenrollment',
        runId: current.runId,
        agentUrl: body.agentUrl,
        tlsFingerprint: body.tlsFingerprint,
        current: {
          deviceId: current.currentDeviceId,
          enrollmentCode: body.enrollmentCode,
        },
        endpointKeychainService: current.endpointKeychainService,
        createdAt,
        expiresAt: body.expiresAt,
      };
      const validated = validateBundle(candidate, {
        runId: /** @type {string} */ (current.runId),
        now: now(),
      });
      await persistBundle(REENROLLMENT_BUNDLE_FILE, validated);
      const nextPhase = transitionControllerState(intentPhase, 'prepare-reenrollment-complete');
      await persistState({ ...requireState(), phase: nextPhase });
      return {
        role: 'controller',
        phase: 'prepare-reenrollment',
        status: 'PASS',
        count: 1,
        at: at(),
      };
    } catch (error) {
      const err = error instanceof LinkeError ? error : requestInvalidError();
      return blockedResult('controller', 'prepare-reenrollment', err, now);
    }
  }

  async function executeStop() {
    const current = requireState();
    const intentPhase = transitionControllerState(/** @type {string} */ (current.phase), 'stop');
    await persistState({ ...current, phase: intentPhase });
    try {
      await closeRuntime();

      // Defense-in-depth: refuse production-like services before any Keychain/file delete.
      const service = assertTestControllerKeychainService(current.controllerKeychainService);
      assertTestEndpointKeychainService(current.endpointKeychainService);

      // Prefer keychain from state when start was cleanup-only (no prior factory call).
      if (!keychain) {
        keychain = keychainFactory(service);
      }
      if (keychain) {
        try {
          await keychain.delete(CONTROLLER_TLS_KEY_ITEM);
          // false = missing = idempotent OK; throw (incl. unavailable) is not PASS.
        } catch (error) {
          if (error instanceof LinkeError) {
            return blockedResult('controller', 'stop', error, now);
          }
          return blockedResult('controller', 'stop', requestInvalidError(), now);
        }
      }
      const files = Array.isArray(current.cleanupFiles) ? current.cleanupFiles : [];
      for (const rel of files) {
        await assertSafeCleanupTarget(runDir, /** @type {string} */ (rel), 'file');
        try {
          if (typeof deleteFile === 'function') await deleteFile(rel);
          else await unlink(resolveAllowlistedPath(runDir, /** @type {string} */ (rel)));
        } catch (error) {
          if (error && /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') continue;
          return blockedResult('controller', 'stop', requestInvalidError(), now);
        }
      }
      const dirs = Array.isArray(current.cleanupDirectories) ? current.cleanupDirectories : [];
      for (const rel of dirs) {
        await assertSafeCleanupTarget(runDir, /** @type {string} */ (rel), 'directory');
        try {
          await rmdir(resolveAllowlistedPath(runDir, /** @type {string} */ (rel)));
        } catch (error) {
          if (error && /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') continue;
          return blockedResult('controller', 'stop', requestInvalidError(), now);
        }
      }
      const nextPhase = transitionControllerState(intentPhase, 'cleanup-complete');
      await persistState({ ...requireState(), phase: nextPhase });
      cleanupOnly = false;
      return {
        role: 'controller',
        phase: 'stop',
        status: 'PASS',
        at: at(),
      };
    } catch (error) {
      const err = error instanceof LinkeError ? error : requestInvalidError();
      return blockedResult('controller', 'stop', err, now);
    }
  }

  /**
   * Execute a fixed stdin command with intent journaling and idempotency.
   * @param {string} command
   * @returns {Promise<object>}
   */
  async function execute(command) {
    try {
      if (typeof command !== 'string' || command.length === 0) throw requestInvalidError();
      if (cleanupOnly && command !== 'stop') {
        return blockedResult('controller', command, requestInvalidError(), now);
      }
      const current = requireState();
      if (isIdempotentControllerCommand(/** @type {string} */ (current.phase), command)) {
        if (command.startsWith('ack-')) {
          const meta = ACK_COMMANDS[command];
          if (meta) {
            try { await removeReceipt(meta.phase); } catch { /* ENOENT ok */ }
          }
        }
        return {
          role: 'controller',
          phase: command,
          status: 'PASS',
          flag: true,
          at: at(),
        };
      }

      switch (command) {
        case 'prepare':
          return await executePrepare();
        case 'ack-pre-revoke':
        case 'ack-post-revoke':
        case 'ack-post-restart':
        case 'ack-post-fingerprint-change':
        case 'ack-reenroll':
          return await executeAck(command);
        case 'revoke-current':
          return await executeRevoke();
        case 'restart':
          return await executeRestart();
        case 'replace-identity-confirmed':
          return await executeReplaceIdentity();
        case 'prepare-reenrollment':
          return await executePrepareReenrollment();
        case 'stop':
          return await executeStop();
        default:
          throw requestInvalidError();
      }
    } catch (error) {
      const phase = state && typeof state.phase === 'string' ? state.phase : undefined;
      const err = error instanceof LinkeError ? error : requestInvalidError();
      if (error instanceof LinkeError
        && (error.code === ERROR_CODES.DEVICE_TLS_IDENTITY_INCOMPLETE
          || error.code === ERROR_CODES.KEYCHAIN_UNAVAILABLE)) {
        return blockedResult('controller', command, err, now);
      }
      return intentAwareFailure(command, phase, err, now);
    }
  }

  return {
    start,
    execute,
    close: closeRuntime,
    getState: () => (state ? structuredClone(state) : null),
  };
}

/**
 * stdin main loop: one fixed command per line, one sanitized JSON line out.
 * @param {object} [options]
 */
export async function runControllerHarnessMain(options = {}) {
  const output = options.stdout ?? process.stdout;
  const writeResult = (result) => {
    try {
      output.write(serializeSanitizedResult(result));
    } catch {
      output.write(serializeSanitizedResult(sanitizedFailure(
        'controller',
        'main',
        new LinkeError(ERROR_CODES.DEVICE_INTERNAL_ERROR),
        options.now ?? (() => new Date()),
      )));
    }
  };

  try {
    assertRealGate(options.env ?? process.env);
  } catch (error) {
    writeResult(sanitizedFailure(
      'controller',
      'main',
      error,
      options.now ?? (() => new Date()),
    ));
    return;
  }

  let harness;
  try {
    harness = await createControllerHarness(options);
  } catch (error) {
    writeResult(sanitizedFailure(
      'controller',
      'main',
      error,
      options.now ?? (() => new Date()),
    ));
    return;
  }

  const input = options.stdin ?? process.stdin;
  const rl = createInterface({ input, crlfDelay: Infinity });
  // Buffer lines immediately so short synthetic stdin is not lost during await start().
  /** @type {string[]} */
  const pendingCommands = [];
  /** @type {((value: string | null) => void) | null} */
  let waitForCommand = null;
  let inputClosed = false;
  const onLine = (line) => {
    const command = String(line || '').trim();
    if (!command) return;
    if (waitForCommand) {
      const resolve = waitForCommand;
      waitForCommand = null;
      resolve(command);
      return;
    }
    pendingCommands.push(command);
  };
  const onClose = () => {
    inputClosed = true;
    if (waitForCommand) {
      const resolve = waitForCommand;
      waitForCommand = null;
      resolve(null);
    }
  };
  rl.on('line', onLine);
  rl.on('close', onClose);

  /**
   * @returns {Promise<string | null>}
   */
  function nextCommand() {
    if (pendingCommands.length > 0) {
      return Promise.resolve(/** @type {string} */ (pendingCommands.shift()));
    }
    if (inputClosed) return Promise.resolve(null);
    return new Promise((resolve) => {
      waitForCommand = resolve;
    });
  }

  try {
    const started = await harness.start();
    // Always emit one sanitized readiness/result line for start (PASS or BLOCKED).
    if (started) writeResult(started);
    for (;;) {
      const command = await nextCommand();
      if (command == null) break;
      const result = await harness.execute(command);
      writeResult(result);
      if (command === 'stop' && result.status === 'PASS') break;
    }
  } catch (error) {
    writeResult(sanitizedFailure('controller', 'main', error, options.now ?? (() => new Date())));
  } finally {
    rl.off('line', onLine);
    rl.off('close', onClose);
    rl.close();
    await harness.close();
  }
}

// Direct node entry only; import remains zero side-effects.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runControllerHarnessMain().catch(() => {
    try {
      process.stdout.write(serializeSanitizedResult(sanitizedFailure(
        'controller',
        'main',
        new LinkeError(ERROR_CODES.DEVICE_INTERNAL_ERROR),
      )));
    } catch {
      // last-resort: no raw errors
    }
  });
}
