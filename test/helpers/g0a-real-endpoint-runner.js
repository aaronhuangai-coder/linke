/**
 * G0a real acceptance Endpoint runner — production client boundary phases.
 * Import has zero side effects; main only when explicitly invoked as direct entry.
 */

import { join, resolve } from 'node:path';
import { unlink, rmdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { KeychainStore } from '../../src/keychain-store.js';
import {
  DeviceCredentialStore,
  enrollDevice,
  heartbeatDevice,
  rotateDeviceToken,
  requestPinnedJson,
} from '../../src/device-client.js';
import { ERROR_CODES, LinkeError } from '../../src/error-codes.js';
import {
  DEVICE_PROTOCOL_VERSION,
  MIN_DEVICE_PROTOCOL_VERSION,
} from '../../src/device-protocol.js';
import {
  assertRealGate,
  assertDedicatedRunDirectory,
  assertSafeCleanupTarget,
  assertTestEndpointKeychainService,
  resolveAllowlistedPath,
  atomicWritePrivateJson,
  readPrivateJson,
  readOptionalPrivateJson,
  validateBundle,
  validateEndpointState,
  transitionEndpointState,
  isIdempotentEndpointPhase,
  serializeSanitizedResult,
  sanitizedFailure,
  INITIAL_BUNDLE_FILE,
  REENROLLMENT_BUNDLE_FILE,
  ENDPOINT_STATE_FILE,
  RECEIPT_FILES,
  SCHEMA_VERSION,
} from './g0a-real-common.js';

const PURPOSE = 'linke-g0a-real-acceptance';

const RUNNING_ENDPOINT_PHASES = new Set([
  'pre-revoke-running',
  'post-revoke-running',
  'post-restart-running',
  'post-fingerprint-change-running',
  'reenroll-running',
]);

/** After running/cleaning intents, unprovable errors map to BLOCKED. */
const INTENT_BLOCKED_ENDPOINT_PHASES = new Set([
  ...RUNNING_ENDPOINT_PHASES,
  'cleaning',
]);

const FIXED_PHASES = new Set([
  'pre-revoke',
  'post-revoke',
  'post-restart',
  'post-fingerprint-change',
  'reenroll',
  'cleanup',
]);

/**
 * @returns {LinkeError}
 */
function requestInvalidError() {
  return new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
}

/**
 * @param {string} phase
 * @param {unknown} error
 * @param {() => Date} now
 */
function blockedResult(phase, error, now) {
  const base = sanitizedFailure('endpoint', phase, error, now);
  return { ...base, status: 'BLOCKED' };
}

/**
 * @param {string} phase
 * @param {string | undefined} durablePhase
 * @param {unknown} error
 * @param {() => Date} now
 */
function intentAwareEndpointFailure(phase, durablePhase, error, now) {
  if (durablePhase && INTENT_BLOCKED_ENDPOINT_PHASES.has(durablePhase)) {
    return blockedResult(phase, error, now);
  }
  return sanitizedFailure('endpoint', phase, error, now);
}

/**
 * Create Endpoint harness (no Keychain/network at construct time).
 * @param {object} [options]
 * @returns {Promise<{
 *   runPhase(phase: string): Promise<object>,
 *   getState(): object,
 * }>}
 */
export async function createEndpointHarness({
  env = process.env,
  runDir = process.cwd(),
  now = () => new Date(),
  keychainFactory = (service) => new KeychainStore({ service }),
  credentialStoreFactory = (keychain) => new DeviceCredentialStore({ keychain }),
  enroll = enrollDevice,
  heartbeat = heartbeatDevice,
  rotate = rotateDeviceToken,
  pinnedRequest = requestPinnedJson,
  readBundle,
  readState,
  writeState,
  writeBundle,
  writeReceipt,
  deleteFile,
} = {}) {
  assertRealGate(env);
  await assertDedicatedRunDirectory(runDir);

  /** @type {Record<string, unknown> | null} */
  let state = null;

  const at = () => now().toISOString();

  async function loadState() {
    if (typeof readState === 'function') {
      const value = await readState();
      if (value == null) return null;
      return validateEndpointState(value, { runDir });
    }
    return /** @type {Record<string, unknown> | null} */ (await readOptionalPrivateJson(
      join(runDir, ENDPOINT_STATE_FILE),
      (value) => validateEndpointState(value, { runDir }),
    ));
  }

  async function persistState(next) {
    const validated = validateEndpointState(next, { runDir });
    const snapshot = structuredClone(validated);
    if (typeof writeState === 'function') {
      await writeState(structuredClone(snapshot));
    } else {
      await atomicWritePrivateJson(join(runDir, ENDPOINT_STATE_FILE), snapshot);
    }
    // Memory reflects durable state only after a successful write.
    state = snapshot;
  }

  /**
   * Load and validate bundle. After state exists, bind validation to state.runId
   * and require endpointKeychainService exact equality before any intent/factory/network.
   * @param {'initial' | 'reenrollment' | 'initial-consumed'} kind
   */
  async function loadBundle(kind) {
    let raw;
    if (typeof readBundle === 'function') {
      raw = await readBundle(kind === 'initial-consumed' ? 'initial' : kind);
    } else {
      const file = kind === 'reenrollment' ? REENROLLMENT_BUNDLE_FILE : INITIAL_BUNDLE_FILE;
      raw = await readPrivateJson(join(runDir, file), (value) => value);
    }
    if (!raw || typeof raw !== 'object') throw requestInvalidError();
    const record = /** @type {Record<string, unknown>} */ (raw);
    if (kind === 'initial-consumed' && record.kind !== 'initial-consumed') {
      throw requestInvalidError();
    }
    if (kind === 'initial' && record.kind !== 'initial') {
      throw requestInvalidError();
    }
    if (kind === 'reenrollment' && record.kind !== 'reenrollment') {
      throw requestInvalidError();
    }
    // First bootstrap may use bundle.runId; once state exists, always bind to it.
    const runId = state
      ? /** @type {string} */ (state.runId)
      : /** @type {string} */ (record.runId ?? '');
    const validated = validateBundle(record, { runId, now: now() });
    // Post-init: bundle service must match journaled state service (bundle only for equality).
    if (state) {
      const stateService = assertTestEndpointKeychainService(state.endpointKeychainService);
      const bundleService = assertTestEndpointKeychainService(validated.endpointKeychainService);
      if (bundleService !== stateService) throw requestInvalidError();
    }
    return validated;
  }

  async function persistBundle(kind, value) {
    const file = kind === 'reenrollment' ? REENROLLMENT_BUNDLE_FILE : INITIAL_BUNDLE_FILE;
    if (typeof writeBundle === 'function') {
      await writeBundle(kind === 'initial-consumed' ? 'initial' : kind, value);
      return;
    }
    await atomicWritePrivateJson(join(runDir, file), value);
  }

  async function persistReceipt(phase, receipt) {
    if (typeof writeReceipt === 'function') {
      await writeReceipt(phase, receipt);
      return;
    }
    const file = RECEIPT_FILES[phase];
    if (!file) throw requestInvalidError();
    await atomicWritePrivateJson(join(runDir, file), receipt);
  }

  function passResult(phase, extra = {}) {
    return {
      role: 'endpoint',
      phase,
      status: 'PASS',
      at: at(),
      ...extra,
    };
  }

  async function ensureInitializedFromBundle() {
    const existing = await loadState();
    if (existing) {
      state = structuredClone(existing);
      return state;
    }

    const bundle = await loadBundle('initial');
    // Bundle validation already enforces service prefix; reassert before factory.
    const endpointService = assertTestEndpointKeychainService(bundle.endpointKeychainService);
    const keychain = keychainFactory(endpointService);
    const credentialStore = credentialStoreFactory(keychain);
    const currentId = /** @type {{ deviceId: string }} */ (bundle.current).deviceId;
    const n1Id = /** @type {{ deviceId: string }} */ (bundle.nMinusOne).deviceId;
    const agentUrl = /** @type {string} */ (bundle.agentUrl);
    const credentialItemIds = [
      credentialStore.itemId(agentUrl, currentId),
      credentialStore.itemId(agentUrl, n1Id),
    ];
    // Persist exact item ids before any Keychain/network side effects.
    // Do not put endpoint-state.json on cleanupFiles — journal survives until cleaned write.
    await persistState({
      schemaVersion: SCHEMA_VERSION,
      purpose: PURPOSE,
      runId: bundle.runId,
      phase: 'initialized',
      endpointKeychainService: endpointService,
      credentialItemIds,
      cleanupFiles: [
        'bundle-initial.json',
        'bundle-reenrollment.json',
        'receipt-pre-revoke.json',
        'receipt-post-revoke.json',
        'receipt-post-restart.json',
        'receipt-post-fingerprint-change.json',
        'receipt-reenroll.json',
      ],
      cleanupDirectories: [],
    });
    return requireState();
  }

  function requireState() {
    if (!state) throw requestInvalidError();
    return state;
  }

  /**
   * Create Keychain/credential stores from journaled state only — never trust bundle service.
   * @returns {{ keychain: unknown, credentialStore: unknown }}
   */
  function createStores() {
    const current = requireState();
    const safeService = assertTestEndpointKeychainService(current.endpointKeychainService);
    const keychain = keychainFactory(safeService);
    const credentialStore = credentialStoreFactory(keychain);
    return { keychain, credentialStore };
  }

  /**
   * pre-revoke: enroll, 2x heartbeat, oldToken local, rotate, old reject, new hb, N-1, N-2.
   */
  async function runPreRevoke() {
    await ensureInitializedFromBundle();
    const current = requireState();
    if (RUNNING_ENDPOINT_PHASES.has(/** @type {string} */ (current.phase))) {
      return blockedResult('pre-revoke', requestInvalidError(), now);
    }
    // Validate required bundle before journaling running intent (no TOCTOU re-read).
    const bundle = await loadBundle('initial');
    const intent = transitionEndpointState(/** @type {string} */ (current.phase), 'begin-pre-revoke');
    await persistState({ ...current, phase: intent });

    const agentUrl = /** @type {string} */ (bundle.agentUrl);
    const tlsFingerprint = /** @type {string} */ (bundle.tlsFingerprint);
    const currentEntry = /** @type {{ deviceId: string, enrollmentCode: string }} */ (bundle.current);
    const n1Entry = /** @type {{ deviceId: string, enrollmentCode: string }} */ (bundle.nMinusOne);
    const n2Entry = /** @type {{ deviceId: string, enrollmentCode: string }} */ (bundle.nMinusTwo);
    const { credentialStore } = createStores();

    await enroll({
      agentUrl,
      tlsFingerprint,
      deviceId: currentEntry.deviceId,
      enrollmentCode: currentEntry.enrollmentCode,
      credentialStore,
    });
    await heartbeat({
      agentUrl, tlsFingerprint, deviceId: currentEntry.deviceId, credentialStore,
    });
    await heartbeat({
      agentUrl, tlsFingerprint, deviceId: currentEntry.deviceId, credentialStore,
    });

    // Keep prior credential only in this local binding (not persisted fields).
    const oldToken = await credentialStore.getToken(agentUrl, currentEntry.deviceId);
    if (typeof oldToken !== 'string' || oldToken.length === 0) {
      throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
    }

    try {
      await rotate({
        agentUrl, tlsFingerprint, deviceId: currentEntry.deviceId, credentialStore,
      });
    } catch (error) {
      // Pending-expired / invalid recovery: single FAIL, no second begin.
      return sanitizedFailure('endpoint', 'pre-revoke', error, now);
    }

    let oldRejected = false;
    try {
      await pinnedRequest({
        agentUrl,
        path: '/agent/heartbeat',
        tlsFingerprint,
        token: oldToken,
        body: {
          deviceId: currentEntry.deviceId,
          protocolVersion: DEVICE_PROTOCOL_VERSION,
        },
      });
    } catch (error) {
      if (error instanceof LinkeError
        && error.code === ERROR_CODES.DEVICE_TOKEN_INVALID
        && error.statusCode === 401) {
        oldRejected = true;
      } else {
        throw error instanceof LinkeError ? error : requestInvalidError();
      }
    }
    if (!oldRejected) {
      return {
        role: 'endpoint',
        phase: 'pre-revoke',
        status: 'FAIL',
        code: ERROR_CODES.DEVICE_TOKEN_INVALID,
        at: at(),
      };
    }

    await heartbeat({
      agentUrl, tlsFingerprint, deviceId: currentEntry.deviceId, credentialStore,
    });

    // N-1 enroll with MIN_DEVICE_PROTOCOL_VERSION — token must be ≥32 chars.
    const n1Response = await pinnedRequest({
      agentUrl,
      path: '/agent/enroll',
      tlsFingerprint,
      body: {
        deviceId: n1Entry.deviceId,
        protocolVersion: MIN_DEVICE_PROTOCOL_VERSION,
        enrollmentCode: n1Entry.enrollmentCode,
      },
    });
    if (!n1Response || typeof n1Response !== 'object') throw requestInvalidError();
    const n1Body = /** @type {Record<string, unknown>} */ (n1Response);
    if (n1Body.deviceId !== n1Entry.deviceId
      || n1Body.protocolVersion !== MIN_DEVICE_PROTOCOL_VERSION
      || typeof n1Body.deviceToken !== 'string'
      || n1Body.deviceToken.length < 32) {
      throw requestInvalidError();
    }
    await credentialStore.setToken(
      agentUrl,
      n1Entry.deviceId,
      /** @type {string} */ (n1Body.deviceToken),
    );
    const n1Token = await credentialStore.getToken(agentUrl, n1Entry.deviceId);
    const n1Hb = await pinnedRequest({
      agentUrl,
      path: '/agent/heartbeat',
      tlsFingerprint,
      token: n1Token,
      body: {
        deviceId: n1Entry.deviceId,
        protocolVersion: MIN_DEVICE_PROTOCOL_VERSION,
      },
    });
    if (!n1Hb || typeof n1Hb !== 'object'
      || /** @type {Record<string, unknown>} */ (n1Hb).deviceId !== n1Entry.deviceId
      || /** @type {Record<string, unknown>} */ (n1Hb).accepted !== true) {
      throw requestInvalidError();
    }

    // N-2 must be strict 426 / device-protocol-unsupported
    let n2Rejected = false;
    try {
      await pinnedRequest({
        agentUrl,
        path: '/agent/enroll',
        tlsFingerprint,
        body: {
          deviceId: n2Entry.deviceId,
          protocolVersion: MIN_DEVICE_PROTOCOL_VERSION - 1,
          enrollmentCode: n2Entry.enrollmentCode,
        },
      });
    } catch (error) {
      if (error instanceof LinkeError
        && error.code === ERROR_CODES.DEVICE_PROTOCOL_UNSUPPORTED
        && error.statusCode === 426) {
        n2Rejected = true;
      } else {
        throw error instanceof LinkeError ? error : requestInvalidError();
      }
    }
    if (!n2Rejected) {
      return {
        role: 'endpoint',
        phase: 'pre-revoke',
        status: 'FAIL',
        code: ERROR_CODES.DEVICE_PROTOCOL_UNSUPPORTED,
        at: at(),
      };
    }

    // Convert to initial-consumed: no codes, no expiresAt, not subject to code TTL.
    const consumed = {
      schemaVersion: SCHEMA_VERSION,
      kind: 'initial-consumed',
      runId: bundle.runId,
      agentUrl,
      tlsFingerprint,
      current: { deviceId: currentEntry.deviceId },
      nMinusOne: { deviceId: n1Entry.deviceId },
      nMinusTwo: { deviceId: n2Entry.deviceId },
      endpointKeychainService: requireState().endpointKeychainService,
      createdAt: bundle.createdAt,
      consumedAt: at(),
    };
    await persistBundle('initial-consumed', consumed);

    const done = transitionEndpointState(intent, 'complete-pre-revoke');
    await persistState({ ...requireState(), phase: done });
    const receipt = {
      schemaVersion: SCHEMA_VERSION,
      runId: requireState().runId,
      phase: 'pre-revoke',
      status: 'PASS',
      count: 1,
      at: at(),
    };
    await persistReceipt('pre-revoke', receipt);
    return passResult('pre-revoke', { count: 1 });
  }

  async function runPostRevoke() {
    const current = requireState();
    const bundle = await loadBundle('initial-consumed');
    const intent = transitionEndpointState(
      /** @type {string} */ (current.phase),
      'begin-post-revoke',
    );
    await persistState({ ...current, phase: intent });
    const { credentialStore } = createStores();
    const deviceId = /** @type {{ deviceId: string }} */ (bundle.current).deviceId;
    let revoked = false;
    try {
      await heartbeat({
        agentUrl: /** @type {string} */ (bundle.agentUrl),
        tlsFingerprint: /** @type {string} */ (bundle.tlsFingerprint),
        deviceId,
        credentialStore,
      });
    } catch (error) {
      if (error instanceof LinkeError
        && error.code === ERROR_CODES.DEVICE_REVOKED
        && error.statusCode === 403) {
        revoked = true;
      } else {
        throw error instanceof LinkeError ? error : requestInvalidError();
      }
    }
    if (!revoked) {
      return {
        role: 'endpoint',
        phase: 'post-revoke',
        status: 'FAIL',
        code: ERROR_CODES.DEVICE_REVOKED,
        at: at(),
      };
    }
    const done = transitionEndpointState(intent, 'complete-post-revoke');
    await persistState({ ...requireState(), phase: done });
    const receipt = {
      schemaVersion: SCHEMA_VERSION,
      runId: requireState().runId,
      phase: 'post-revoke',
      status: 'PASS',
      at: at(),
    };
    await persistReceipt('post-revoke', receipt);
    return passResult('post-revoke');
  }

  async function runPostRestart() {
    const current = requireState();
    const bundle = await loadBundle('initial-consumed');
    const intent = transitionEndpointState(
      /** @type {string} */ (current.phase),
      'begin-post-restart',
    );
    await persistState({ ...current, phase: intent });
    const agentUrl = /** @type {string} */ (bundle.agentUrl);
    const tlsFingerprint = /** @type {string} */ (bundle.tlsFingerprint);
    const n1Id = /** @type {{ deviceId: string }} */ (bundle.nMinusOne).deviceId;
    const { credentialStore } = createStores();
    const token = await credentialStore.getToken(agentUrl, n1Id);
    const hb = await pinnedRequest({
      agentUrl,
      path: '/agent/heartbeat',
      tlsFingerprint,
      token,
      body: {
        deviceId: n1Id,
        protocolVersion: MIN_DEVICE_PROTOCOL_VERSION,
      },
    });
    if (!hb || typeof hb !== 'object'
      || /** @type {Record<string, unknown>} */ (hb).deviceId !== n1Id
      || /** @type {Record<string, unknown>} */ (hb).accepted !== true) {
      throw requestInvalidError();
    }
    const done = transitionEndpointState(intent, 'complete-post-restart');
    await persistState({ ...requireState(), phase: done });
    const receipt = {
      schemaVersion: SCHEMA_VERSION,
      runId: requireState().runId,
      phase: 'post-restart',
      status: 'PASS',
      at: at(),
    };
    await persistReceipt('post-restart', receipt);
    return passResult('post-restart');
  }

  async function runPostFingerprintChange() {
    const current = requireState();
    const bundle = await loadBundle('initial-consumed');
    const intent = transitionEndpointState(
      /** @type {string} */ (current.phase),
      'begin-post-fingerprint-change',
    );
    await persistState({ ...current, phase: intent });
    const agentUrl = /** @type {string} */ (bundle.agentUrl);
    const tlsFingerprint = /** @type {string} */ (bundle.tlsFingerprint);
    const deviceId = /** @type {{ deviceId: string }} */ (bundle.current).deviceId;
    const { credentialStore } = createStores();
    const token = await credentialStore.getToken(agentUrl, deviceId);
    let mismatch = false;
    try {
      await pinnedRequest({
        agentUrl,
        path: '/agent/heartbeat',
        tlsFingerprint,
        token,
        body: {
          deviceId,
          protocolVersion: DEVICE_PROTOCOL_VERSION,
        },
      });
    } catch (error) {
      if (error instanceof LinkeError
        && error.code === ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH) {
        mismatch = true;
      } else {
        throw error instanceof LinkeError ? error : requestInvalidError();
      }
    }
    if (!mismatch) {
      return {
        role: 'endpoint',
        phase: 'post-fingerprint-change',
        status: 'FAIL',
        code: ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH,
        at: at(),
      };
    }
    const done = transitionEndpointState(intent, 'complete-post-fingerprint-change');
    await persistState({ ...requireState(), phase: done });
    const receipt = {
      schemaVersion: SCHEMA_VERSION,
      runId: requireState().runId,
      phase: 'post-fingerprint-change',
      status: 'PASS',
      at: at(),
    };
    await persistReceipt('post-fingerprint-change', receipt);
    return passResult('post-fingerprint-change');
  }

  async function runReenroll() {
    const current = requireState();
    const bundle = await loadBundle('reenrollment');
    const intent = transitionEndpointState(
      /** @type {string} */ (current.phase),
      'begin-reenroll',
    );
    await persistState({ ...current, phase: intent });
    const agentUrl = /** @type {string} */ (bundle.agentUrl);
    const tlsFingerprint = /** @type {string} */ (bundle.tlsFingerprint);
    const entry = /** @type {{ deviceId: string, enrollmentCode: string }} */ (bundle.current);
    const { credentialStore } = createStores();
    await enroll({
      agentUrl,
      tlsFingerprint,
      deviceId: entry.deviceId,
      enrollmentCode: entry.enrollmentCode,
      credentialStore,
    });
    await heartbeat({
      agentUrl, tlsFingerprint, deviceId: entry.deviceId, credentialStore,
    });
    const done = transitionEndpointState(intent, 'complete-reenroll');
    await persistState({ ...requireState(), phase: done });
    const receipt = {
      schemaVersion: SCHEMA_VERSION,
      runId: requireState().runId,
      phase: 'reenroll',
      status: 'PASS',
      at: at(),
    };
    await persistReceipt('reenroll', receipt);
    return passResult('reenroll');
  }

  async function runCleanup() {
    const current = requireState();
    const intent = transitionEndpointState(/** @type {string} */ (current.phase), 'cleanup');
    await persistState({ ...current, phase: intent });
    // Defense-in-depth: refuse non-test services before any Keychain/file delete.
    const service = assertTestEndpointKeychainService(current.endpointKeychainService);
    const keychain = keychainFactory(service);
    const ids = Array.isArray(current.credentialItemIds) ? current.credentialItemIds : [];
    for (const itemId of ids) {
      if (typeof itemId !== 'string' || !itemId.startsWith('device-token.')) {
        throw requestInvalidError();
      }
      try {
        await keychain.delete(itemId);
        // false = missing = idempotent OK
      } catch (error) {
        // Never swallow keychain-unavailable or other throws.
        if (error instanceof LinkeError) {
          return blockedResult('cleanup', error, now);
        }
        return blockedResult('cleanup', requestInvalidError(), now);
      }
    }
    const files = Array.isArray(current.cleanupFiles) ? current.cleanupFiles : [];
    for (const rel of files) {
      // State journal must not be on allowlist / must not be unlinked mid-cleanup.
      if (rel === ENDPOINT_STATE_FILE) {
        return blockedResult('cleanup', requestInvalidError(), now);
      }
      await assertSafeCleanupTarget(runDir, /** @type {string} */ (rel), 'file');
      try {
        if (typeof deleteFile === 'function') await deleteFile(rel);
        else await unlink(resolveAllowlistedPath(runDir, /** @type {string} */ (rel)));
      } catch (error) {
        if (error && /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') continue;
        return blockedResult('cleanup', requestInvalidError(), now);
      }
    }
    const dirs = Array.isArray(current.cleanupDirectories) ? current.cleanupDirectories : [];
    for (const rel of dirs) {
      await assertSafeCleanupTarget(runDir, /** @type {string} */ (rel), 'directory');
      try {
        await rmdir(resolveAllowlistedPath(runDir, /** @type {string} */ (rel)));
      } catch (error) {
        if (error && /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') continue;
        return blockedResult('cleanup', requestInvalidError(), now);
      }
    }
    const done = transitionEndpointState(intent, 'cleanup-complete');
    await persistState({ ...requireState(), phase: done });
    return passResult('cleanup');
  }

  /**
   * Run a fixed Endpoint phase.
   * @param {string} phase
   * @returns {Promise<object>}
   */
  async function runPhase(phase) {
    try {
      if (typeof phase !== 'string' || phase.length === 0) throw requestInvalidError();
      if (!FIXED_PHASES.has(phase)) throw requestInvalidError();

      // Load existing state when present.
      if (!state) {
        const existing = await loadState();
        if (existing) state = structuredClone(existing);
      }

      // Running intent crash: only cleanup is allowed; never replay business phases.
      if (state && RUNNING_ENDPOINT_PHASES.has(/** @type {string} */ (state.phase))) {
        if (phase !== 'cleanup') {
          return blockedResult(phase, requestInvalidError(), now);
        }
      }
      if (state && state.phase === 'cleaning' && phase !== 'cleanup') {
        return blockedResult(phase, requestInvalidError(), now);
      }

      if (state && isIdempotentEndpointPhase(/** @type {string} */ (state.phase), phase)) {
        const receipt = {
          schemaVersion: SCHEMA_VERSION,
          runId: state.runId,
          phase,
          status: 'PASS',
          flag: true,
          at: at(),
        };
        await persistReceipt(phase, receipt);
        return passResult(phase, { flag: true });
      }

      if (phase === 'pre-revoke') return await runPreRevoke();
      if (!state) {
        const existing = await loadState();
        if (!existing) throw requestInvalidError();
        state = structuredClone(existing);
      }
      switch (phase) {
        case 'post-revoke':
          return await runPostRevoke();
        case 'post-restart':
          return await runPostRestart();
        case 'post-fingerprint-change':
          return await runPostFingerprintChange();
        case 'reenroll':
          return await runReenroll();
        case 'cleanup':
          return await runCleanup();
        default:
          throw requestInvalidError();
      }
    } catch (error) {
      // Failures never write PASS receipts (persistReceipt only on success paths).
      const durablePhase = state && typeof state.phase === 'string' ? state.phase : undefined;
      const err = error instanceof LinkeError ? error : requestInvalidError();
      return intentAwareEndpointFailure(phase, durablePhase, err, now);
    }
  }

  return {
    runPhase,
    getState: () => (state ? structuredClone(state) : null),
  };
}

/**
 * Endpoint main: exactly one fixed phase positional argument.
 * @param {object} [options]
 */
export async function runEndpointHarnessMain(options = {}) {
  const output = options.stdout ?? process.stdout;
  const writeResult = (result) => {
    try {
      output.write(serializeSanitizedResult(result));
    } catch {
      output.write(serializeSanitizedResult(sanitizedFailure(
        'endpoint',
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
      'endpoint',
      'main',
      error,
      options.now ?? (() => new Date()),
    ));
    return;
  }

  const argv = Array.isArray(options.argv) ? options.argv : process.argv;
  // argv: [node, script, phase] — reject missing or extra args.
  if (argv.length !== 3 || typeof argv[2] !== 'string' || argv[2].length === 0) {
    writeResult(sanitizedFailure(
      'endpoint',
      'main',
      new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }),
      options.now ?? (() => new Date()),
    ));
    return;
  }
  const phase = argv[2];
  if (!FIXED_PHASES.has(phase)) {
    writeResult(sanitizedFailure(
      'endpoint',
      'main',
      new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }),
      options.now ?? (() => new Date()),
    ));
    return;
  }

  try {
    const harness = await createEndpointHarness(options);
    const result = await harness.runPhase(phase);
    writeResult(result);
  } catch (error) {
    writeResult(sanitizedFailure(
      'endpoint',
      'main',
      error,
      options.now ?? (() => new Date()),
    ));
  }
}

// Direct node entry only; import remains zero side-effects.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runEndpointHarnessMain().catch(() => {
    try {
      process.stdout.write(serializeSanitizedResult(sanitizedFailure(
        'endpoint',
        'main',
        new LinkeError(ERROR_CODES.DEVICE_INTERNAL_ERROR),
      )));
    } catch {
      // last-resort: no raw errors
    }
  });
}
