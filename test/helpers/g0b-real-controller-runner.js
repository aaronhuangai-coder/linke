/**
 * G0b auto / real-LAN controller runner.
 * Import has zero side effects; main only when invoked as direct entry.
 * Auto: production TLS agent + upload stack on loopback; private 0600 bundle for endpoint child.
 * Real: exact hardware gate; no fake PASS / no report without hardware.
 */

import { X509Certificate } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  generateControllerPrivateKey,
  createOpenSslCertificate,
} from '../../src/tls-identity-store.js';
import { DeviceRegistry } from '../../src/device-registry.js';
import { createAgentListener } from '../../src/agent-listener.js';
import { createUploadSessionStore } from '../../src/upload-session-store.js';
import { createUploadLocks } from '../../src/upload-locks.js';
import { createUploadService } from '../../src/upload-service.js';
import {
  parseChunkHeaders,
  ingestChunkBody,
  commitChunk,
} from '../../src/upload-chunk-ingest.js';
import {
  preflightCapacity,
  verifyAndCommitSession,
} from '../../src/upload-commit.js';
import { createFixedWindowRateLimiter } from '../../src/rate-limit.js';
import { ERROR_CODES, LinkeError } from '../../src/error-codes.js';
import { DEVICE_PROTOCOL_VERSION } from '../../src/device-protocol.js';
import {
  assertRealGate,
  assertDedicatedRunDirectory,
  atomicWritePrivateJson,
  serializeSanitizedResult,
  sanitizedFailure,
  sanitizedBlocked,
  validateAutoEndpointBundle,
  AUTO_BUNDLE_FILE,
  PURPOSE,
  SCHEMA_VERSION,
} from './g0b-real-common.js';

const T0 = '2026-07-22T12:00:00.000Z';
const DEVICE_A = 'device-g0b-alpha';
const DEVICE_B = 'device-g0b-beta';

/**
 * @returns {LinkeError}
 */
function requestInvalidError() {
  return new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
}

function mockStatfsPlenty() {
  return async () => ({
    type: 0,
    bsize: 4096,
    blocks: 1e12,
    bfree: 1e12,
    bavail: 1e12,
    files: 0,
    ffree: 0,
  });
}

/**
 * Create auto production G0b upload controller (loopback TLS + production service).
 * Does not require real-LAN hardware gate. Not real-LAN evidence.
 *
 * @param {{
 *   dataDir: string,
 *   now?: () => Date,
 * }} options
 */
export async function createAutoControllerHarness({
  dataDir,
  now = () => new Date(T0),
} = {}) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw requestInvalidError();

  const { keyPem } = generateControllerPrivateKey();
  const certPem = await createOpenSslCertificate({
    keyPem,
    san: 'IP:127.0.0.1',
  });
  const certificate = new X509Certificate(certPem);
  const fingerprint = certificate.fingerprint256.replaceAll(':', '').toLowerCase();
  const identity = { keyPem, certPem, fingerprint };

  const registry = new DeviceRegistry({ dataDir });
  const store = createUploadSessionStore({ dataDir, now });
  const locks = createUploadLocks({ maxGlobalTransfers: 4 });
  const uploadService = createUploadService({
    dataDir,
    store,
    locks,
    ingest: { parseChunkHeaders, ingestChunkBody, commitChunk },
    commit: {
      preflightCapacity: (dir, totalBytes, options = {}) =>
        preflightCapacity(dir, totalBytes, {
          ...options,
          deps: { ...(options.deps || {}), statfs: options.deps?.statfs ?? mockStatfsPlenty() },
        }),
      verifyAndCommitSession,
    },
    now,
  });

  const server = createAgentListener({
    identity,
    registry,
    onHeartbeat: async () => {},
    rateLimit: createFixedWindowRateLimiter({ maxRequests: 60, windowMs: 60_000 }),
    uploadRateLimit: createFixedWindowRateLimiter({ maxRequests: 1200, windowMs: 60_000 }),
    uploadService,
  });

  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string' || !Number.isInteger(addr.port)) {
    throw requestInvalidError();
  }
  const agentUrl = `https://127.0.0.1:${addr.port}`;

  /**
   * @param {string} deviceId
   */
  async function enroll(deviceId) {
    const issued = await registry.issueEnrollment({ deviceId });
    const result = await registry.consumeEnrollment({
      deviceId,
      code: issued.code,
      protocolVersion: DEVICE_PROTOCOL_VERSION,
    });
    if (typeof result.token !== 'string' || result.token.length < 32) {
      throw requestInvalidError();
    }
    return { deviceId, token: result.token };
  }

  const deviceA = await enroll(DEVICE_A);
  const deviceB = await enroll(DEVICE_B);

  /**
   * Write 0600 auto endpoint bundle under dedicated runDir (private; never stdout).
   * @param {string} runDir
   * @param {{ snapshotRootRelative?: string }} [opts]
   */
  async function writeAutoBundle(runDir, { snapshotRootRelative = 'snapshot-root' } = {}) {
    await assertDedicatedRunDirectory(runDir);
    const candidate = {
      schemaVersion: SCHEMA_VERSION,
      purpose: PURPOSE,
      kind: 'auto-endpoint',
      agentUrl,
      tlsFingerprint: fingerprint,
      deviceA: { deviceId: deviceA.deviceId, token: deviceA.token },
      deviceB: { deviceId: deviceB.deviceId, token: deviceB.token },
      snapshotRootRelative,
    };
    const bundle = validateAutoEndpointBundle(candidate);
    await atomicWritePrivateJson(join(runDir, AUTO_BUNDLE_FILE), bundle);
    return bundle;
  }

  async function close() {
    await new Promise((resolveClose, rejectClose) => {
      server.close((err) => (err ? rejectClose(err) : resolveClose()));
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
    });
  }

  return {
    role: 'controller',
    mode: 'auto',
    writeAutoBundle,
    close,
  };
}

/**
 * Real-LAN controller harness — exact hardware gate + dedicated runDir required.
 * Without operator second Mac/VM this surface is BLOCKED (never fake PASS).
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   runDir?: string,
 * }} [options]
 */
export async function createRealControllerHarness({
  env = process.env,
  runDir = process.cwd(),
} = {}) {
  assertRealGate(env);
  await assertDedicatedRunDirectory(runDir);
  return {
    role: 'controller',
    mode: 'real',
    async start() {
      return sanitizedBlocked(
        'controller',
        'start',
        new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }),
      );
    },
    async close() {},
  };
}

/**
 * Direct main: gate missing → one sanitized FAIL line, no side effects.
 * Real gate open without hardware → BLOCKED (never PASS report).
 *
 * @param {object} [options]
 */
export async function runControllerHarnessMain(options = {}) {
  const output = options.stdout ?? process.stdout;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const writeResult = (result) => {
    try {
      output.write(serializeSanitizedResult(result));
    } catch {
      output.write(serializeSanitizedResult(sanitizedFailure(
        'controller',
        'main',
        new LinkeError(ERROR_CODES.DEVICE_INTERNAL_ERROR),
        now,
      )));
    }
  };

  try {
    assertRealGate(env);
  } catch (error) {
    writeResult(sanitizedFailure('controller', 'main', error, now));
    return 1;
  }

  // Gate present but no dual-Mac hardware ops in this tree → BLOCKED.
  writeResult(sanitizedBlocked(
    'controller',
    'main',
    new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }),
    now,
  ));
  return 1;
}

// Direct node entry only; import remains zero side-effects.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runControllerHarnessMain().then((code) => {
    if (typeof code === 'number' && code !== 0) process.exitCode = code;
  }).catch(() => {
    try {
      process.stdout.write(serializeSanitizedResult(sanitizedFailure(
        'controller',
        'main',
        new LinkeError(ERROR_CODES.DEVICE_INTERNAL_ERROR),
      )));
    } catch {
      // last-resort
    }
    process.exitCode = 1;
  });
}
