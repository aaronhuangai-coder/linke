/**
 * G0b auto / real-LAN endpoint runner.
 * Import has zero side effects; main only when invoked as direct entry.
 * Auto: reads fixed 0600 AUTO_BUNDLE_FILE from dedicated runDir; production pinned client.
 * Direct argv: [node, script, 'auto', scenario] with exact AUTO gate.
 * Real: exact REAL gate; without hardware → BLOCKED (never PASS).
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  requestPinnedBinary,
  abortUploadSession,
} from '../../src/device-client.js';
import { projectCanonicalUploadManifest } from '../../src/upload-manifest.js';
import { ERROR_CODES, LinkeError } from '../../src/error-codes.js';
import { DEVICE_PROTOCOL_VERSION } from '../../src/device-protocol.js';
import {
  AUTO_SCENARIOS,
  AUTO_BUNDLE_FILE,
  assertRealGate,
  assertAutoGate,
  assertAutoScenario,
  assertDedicatedRunDirectory,
  readPrivateJson,
  resolveAllowlistedPath,
  serializeSanitizedResult,
  sanitizedFailure,
  sanitizedBlocked,
  validateAutoEndpointBundle,
} from './g0b-real-common.js';

export const ENDPOINT_SCENARIOS = AUTO_SCENARIOS;

const T0 = '2026-07-22T12:00:00.000Z';
const ZERO_SHA =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/**
 * @returns {LinkeError}
 */
function requestInvalidError() {
  return new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
}

/**
 * @param {{ path: string, content: string | Buffer }[]} files
 * @param {{ deviceId: string, snapshotId: string }} ids
 */
function makeManifest(files, ids) {
  const entries = files.map((f) => {
    const content = typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : f.content;
    return {
      path: f.path,
      size: content.length,
      sha256: content.length === 0
        ? ZERO_SHA
        : createHash('sha256').update(content).digest('hex'),
      content,
    };
  });
  const totalBytes = entries.reduce((s, e) => s + e.size, 0);
  const input = {
    schemaVersion: 2,
    snapshotId: ids.snapshotId,
    deviceId: ids.deviceId,
    createdAt: T0,
    files: entries.map((e) => e.path),
    integrity: {
      algorithm: 'sha256',
      totalBytes,
      entries: entries.map((e) => ({ path: e.path, size: e.size, sha256: e.sha256 })),
    },
  };
  const projected = projectCanonicalUploadManifest(input, {
    authenticatedDeviceId: ids.deviceId,
  });
  return { ...projected, entries };
}

/**
 * @param {string} root
 * @param {{ path: string, content: string | Buffer }[]} files
 */
async function writeFiles(root, files) {
  await mkdir(root, { recursive: true });
  for (const f of files) {
    const abs = join(root, f.path);
    await mkdir(join(abs, '..'), { recursive: true });
    const content = typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : f.content;
    await writeFile(abs, content);
  }
}

/**
 * @param {object} opts
 */
async function putChunk(opts) {
  const {
    agentUrl,
    tlsFingerprint,
    deviceId,
    token,
    uploadId,
    snapshotId,
    manifestDigest,
    fileIndex,
    chunkIndex,
    offset,
    chunkBody,
    sha256Override,
  } = opts;
  const size = chunkBody.length;
  const sha256 = typeof sha256Override === 'string'
    ? sha256Override
    : createHash('sha256').update(chunkBody).digest('hex');
  return requestPinnedBinary({
    agentUrl,
    path: `/agent/upload/sessions/${encodeURIComponent(uploadId)}/chunks`,
    tlsFingerprint,
    method: 'POST',
    token,
    deviceId,
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    body: chunkBody,
    bodyMode: 'buffer',
    contentType: 'application/octet-stream',
    extraHeaders: {
      'x-linke-upload-id': uploadId,
      'x-linke-snapshot-id': snapshotId,
      'x-linke-manifest-digest': manifestDigest,
      'x-linke-file-index': String(fileIndex),
      'x-linke-chunk-index': String(chunkIndex),
      'x-linke-chunk-offset': String(offset),
      'x-linke-chunk-size': String(size),
      'x-linke-chunk-sha256': sha256,
    },
    timeoutMs: 30_000,
  });
}

/**
 * Mid-transfer disconnect (transport class); no secret echo.
 * @param {object} opts
 * @returns {Promise<void>}
 */
function putChunkDisconnect(opts) {
  const {
    agentUrl,
    tlsFingerprint,
    deviceId,
    token,
    uploadId,
    snapshotId,
    manifestDigest,
    fileIndex,
    chunkIndex,
    offset,
    chunkBody,
  } = opts;
  const url = new URL(agentUrl);
  const expected = Buffer.from(String(tlsFingerprint).replaceAll(':', '').toLowerCase(), 'hex');
  const size = chunkBody.length;
  const sha256 = createHash('sha256').update(chunkBody).digest('hex');
  return new Promise((resolvePromise) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    };
    const req = httpsRequest({
      protocol: 'https:',
      hostname: url.hostname,
      port: url.port || 443,
      path: `/agent/upload/sessions/${encodeURIComponent(uploadId)}/chunks`,
      method: 'POST',
      agent: false,
      rejectUnauthorized: false,
      headers: {
        authorization: `Bearer ${token}`,
        'x-linke-device-id': deviceId,
        'x-linke-protocol-version': String(DEVICE_PROTOCOL_VERSION),
        'content-type': 'application/octet-stream',
        'content-length': String(size),
        'x-linke-upload-id': uploadId,
        'x-linke-snapshot-id': snapshotId,
        'x-linke-manifest-digest': manifestDigest,
        'x-linke-file-index': String(fileIndex),
        'x-linke-chunk-index': String(chunkIndex),
        'x-linke-chunk-offset': String(offset),
        'x-linke-chunk-size': String(size),
        'x-linke-chunk-sha256': sha256,
      },
    }, () => done());
    req.on('error', () => done());
    req.on('socket', (socket) => {
      socket.once('secureConnect', () => {
        try {
          const raw = socket.getPeerCertificate(true)?.raw;
          const actual = raw ? createHash('sha256').update(raw).digest() : Buffer.alloc(0);
          if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
            req.destroy();
            done();
            return;
          }
          req.write(chunkBody.subarray(0, Math.min(1, chunkBody.length)));
          req.destroy();
          done();
        } catch {
          try { req.destroy(); } catch { /* ignore */ }
          done();
        }
      });
    });
    req.setTimeout(5_000, () => {
      try { req.destroy(); } catch { /* ignore */ }
      done();
    });
  });
}

/**
 * @param {{ deviceId: string, token: string }} device
 * @param {string} agentUrl
 * @param {string} tlsFingerprint
 * @param {string} uploadId
 */
async function bestEffortAbort(device, agentUrl, tlsFingerprint, uploadId) {
  try {
    await abortUploadSession({
      agentUrl,
      tlsFingerprint,
      deviceId: device.deviceId,
      uploadId,
      credentialStore: {
        async getToken() {
          return device.token;
        },
      },
    });
  } catch {
    // best-effort isolation cleanup
  }
}

/**
 * @param {ReturnType<typeof validateAutoEndpointBundle>} bundle
 * @param {string} runDir
 * @param {() => Date} now
 */
async function runDisconnectResume(bundle, runDir, now) {
  const snapRel = bundle.snapshotRootRelative;
  const snapRoot = resolveAllowlistedPath(runDir, snapRel);
  const scenarioRoot = join(snapRoot, 'disconnect-resume');
  const files = [
    { path: 'a.txt', content: 'g0b-disconnect-a' },
    { path: 'b.txt', content: 'g0b-disconnect-b' },
  ];
  const snapId = '550e8400-e29b-41d4-a716-4466554400d1';
  const man = makeManifest(files, { deviceId: bundle.deviceA.deviceId, snapshotId: snapId });
  await writeFiles(scenarioRoot, files);

  const { agentUrl, tlsFingerprint } = bundle;
  const deviceA = bundle.deviceA;

  const created = await requestPinnedBinary({
    agentUrl,
    path: '/agent/upload/sessions',
    tlsFingerprint,
    method: 'POST',
    token: deviceA.token,
    deviceId: deviceA.deviceId,
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    body: { manifest: man.manifest, manifestDigest: man.manifestDigest },
    bodyMode: 'json',
    timeoutMs: 30_000,
  });
  const uploadId = /** @type {{ uploadId?: string }} */ (created).uploadId;
  if (typeof uploadId !== 'string') throw requestInvalidError();

  await putChunk({
    agentUrl,
    tlsFingerprint,
    deviceId: deviceA.deviceId,
    token: deviceA.token,
    uploadId,
    snapshotId: snapId,
    manifestDigest: man.manifestDigest,
    fileIndex: 0,
    chunkIndex: 0,
    offset: 0,
    chunkBody: man.entries[0].content,
  });

  await putChunkDisconnect({
    agentUrl,
    tlsFingerprint,
    deviceId: deviceA.deviceId,
    token: deviceA.token,
    uploadId,
    snapshotId: snapId,
    manifestDigest: man.manifestDigest,
    fileIndex: 1,
    chunkIndex: 0,
    offset: 0,
    chunkBody: man.entries[1].content,
  });

  const status = await requestPinnedBinary({
    agentUrl,
    path: `/agent/upload/sessions/${encodeURIComponent(uploadId)}`,
    tlsFingerprint,
    method: 'GET',
    token: deviceA.token,
    deviceId: deviceA.deviceId,
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    bodyMode: 'none',
    timeoutMs: 15_000,
  });
  if (!status || typeof status !== 'object') throw requestInvalidError();
  if (/** @type {{ uploadId?: string }} */ (status).uploadId !== uploadId) {
    throw requestInvalidError();
  }

  await putChunk({
    agentUrl,
    tlsFingerprint,
    deviceId: deviceA.deviceId,
    token: deviceA.token,
    uploadId,
    snapshotId: snapId,
    manifestDigest: man.manifestDigest,
    fileIndex: 1,
    chunkIndex: 0,
    offset: 0,
    chunkBody: man.entries[1].content,
  });

  const finalized = await requestPinnedBinary({
    agentUrl,
    path: `/agent/upload/sessions/${encodeURIComponent(uploadId)}/finalize`,
    tlsFingerprint,
    method: 'POST',
    token: deviceA.token,
    deviceId: deviceA.deviceId,
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    bodyMode: 'none',
    timeoutMs: 15_000,
  });
  if (!finalized || /** @type {{ status?: string }} */ (finalized).status !== 'committed') {
    throw requestInvalidError();
  }

  try {
    await rm(scenarioRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }

  return {
    role: 'endpoint',
    phase: 'disconnect-resume',
    status: 'PASS',
    at: now().toISOString(),
  };
}

/**
 * @param {ReturnType<typeof validateAutoEndpointBundle>} bundle
 * @param {string} runDir
 * @param {() => Date} now
 */
async function runCorruptChunk(bundle, runDir, now) {
  const snapRoot = resolveAllowlistedPath(runDir, bundle.snapshotRootRelative);
  const scenarioRoot = join(snapRoot, 'corrupt-chunk');
  const files = [{ path: 'c.txt', content: 'g0b-corrupt-expected' }];
  const snapId = '550e8400-e29b-41d4-a716-4466554400c1';
  const man = makeManifest(files, { deviceId: bundle.deviceA.deviceId, snapshotId: snapId });
  await writeFiles(scenarioRoot, files);

  const { agentUrl, tlsFingerprint } = bundle;
  const deviceA = bundle.deviceA;

  const created = await requestPinnedBinary({
    agentUrl,
    path: '/agent/upload/sessions',
    tlsFingerprint,
    method: 'POST',
    token: deviceA.token,
    deviceId: deviceA.deviceId,
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    body: { manifest: man.manifest, manifestDigest: man.manifestDigest },
    bodyMode: 'json',
    timeoutMs: 30_000,
  });
  const uploadId = /** @type {{ uploadId?: string }} */ (created).uploadId;
  if (typeof uploadId !== 'string') throw requestInvalidError();

  // Same length as honest payload so size gate passes; body hash ≠ header claim.
  const honest = man.entries[0].content;
  const corruptBody = Buffer.alloc(honest.length, 0x5a);
  const wrongSha = createHash('sha256').update(honest).digest('hex');

  let rejected = false;
  /** @type {string | undefined} */
  let code;
  try {
    await putChunk({
      agentUrl,
      tlsFingerprint,
      deviceId: deviceA.deviceId,
      token: deviceA.token,
      uploadId,
      snapshotId: snapId,
      manifestDigest: man.manifestDigest,
      fileIndex: 0,
      chunkIndex: 0,
      offset: 0,
      chunkBody: corruptBody,
      sha256Override: wrongSha,
    });
  } catch (error) {
    if (
      error instanceof LinkeError
      && (error.code === ERROR_CODES.UPLOAD_INTEGRITY_FAILED
        || error.code === ERROR_CODES.UPLOAD_CHUNK_INVALID)
    ) {
      rejected = true;
      code = error.code;
    } else {
      throw error instanceof LinkeError ? error : requestInvalidError();
    }
  }
  if (!rejected) throw requestInvalidError();

  await bestEffortAbort(deviceA, agentUrl, tlsFingerprint, uploadId);
  try {
    await rm(scenarioRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }

  return {
    role: 'endpoint',
    phase: 'corrupt-chunk',
    status: 'PASS',
    code: code ?? ERROR_CODES.UPLOAD_INTEGRITY_FAILED,
    flag: true,
    at: now().toISOString(),
  };
}

/**
 * @param {ReturnType<typeof validateAutoEndpointBundle>} bundle
 * @param {string} runDir
 * @param {() => Date} now
 */
async function runManifestConflict(bundle, runDir, now) {
  const snapRoot = resolveAllowlistedPath(runDir, bundle.snapshotRootRelative);
  const scenarioRoot = join(snapRoot, 'manifest-conflict');
  const files1 = [{ path: 'm1.txt', content: 'g0b-manifest-one' }];
  const files2 = [{ path: 'm2.txt', content: 'g0b-manifest-two' }];
  const snap1 = '550e8400-e29b-41d4-a716-4466554400e1';
  const snap2 = '550e8400-e29b-41d4-a716-4466554400e2';
  const man1 = makeManifest(files1, { deviceId: bundle.deviceA.deviceId, snapshotId: snap1 });
  const man2 = makeManifest(files2, { deviceId: bundle.deviceA.deviceId, snapshotId: snap2 });
  await writeFiles(join(scenarioRoot, 'a'), files1);
  await writeFiles(join(scenarioRoot, 'b'), files2);

  const { agentUrl, tlsFingerprint } = bundle;
  const deviceA = bundle.deviceA;

  const created = await requestPinnedBinary({
    agentUrl,
    path: '/agent/upload/sessions',
    tlsFingerprint,
    method: 'POST',
    token: deviceA.token,
    deviceId: deviceA.deviceId,
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    body: { manifest: man1.manifest, manifestDigest: man1.manifestDigest },
    bodyMode: 'json',
    timeoutMs: 30_000,
  });
  const uploadId = /** @type {{ uploadId?: string }} */ (created).uploadId;
  if (typeof uploadId !== 'string') throw requestInvalidError();

  let conflicted = false;
  try {
    await requestPinnedBinary({
      agentUrl,
      path: '/agent/upload/sessions',
      tlsFingerprint,
      method: 'POST',
      token: deviceA.token,
      deviceId: deviceA.deviceId,
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      body: { manifest: man2.manifest, manifestDigest: man2.manifestDigest },
      bodyMode: 'json',
      timeoutMs: 30_000,
    });
  } catch (error) {
    if (error instanceof LinkeError && error.code === ERROR_CODES.UPLOAD_SESSION_CONFLICT) {
      conflicted = true;
    } else {
      throw error instanceof LinkeError ? error : requestInvalidError();
    }
  }
  if (!conflicted) throw requestInvalidError();

  await bestEffortAbort(deviceA, agentUrl, tlsFingerprint, uploadId);
  try {
    await rm(scenarioRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }

  return {
    role: 'endpoint',
    phase: 'manifest-conflict',
    status: 'PASS',
    code: ERROR_CODES.UPLOAD_SESSION_CONFLICT,
    flag: true,
    at: now().toISOString(),
  };
}

/**
 * @param {ReturnType<typeof validateAutoEndpointBundle>} bundle
 * @param {string} runDir
 * @param {() => Date} now
 */
async function runCrossDeviceDeny(bundle, runDir, now) {
  const snapRoot = resolveAllowlistedPath(runDir, bundle.snapshotRootRelative);
  const scenarioRoot = join(snapRoot, 'cross-device-deny');
  // Owner = deviceB so prior deviceA sessions cannot block create.
  const files = [{ path: 'x.txt', content: 'g0b-cross-device' }];
  const snapId = '550e8400-e29b-41d4-a716-4466554400f1';
  const man = makeManifest(files, { deviceId: bundle.deviceB.deviceId, snapshotId: snapId });
  await writeFiles(scenarioRoot, files);

  const { agentUrl, tlsFingerprint } = bundle;
  const deviceA = bundle.deviceA;
  const deviceB = bundle.deviceB;

  const created = await requestPinnedBinary({
    agentUrl,
    path: '/agent/upload/sessions',
    tlsFingerprint,
    method: 'POST',
    token: deviceB.token,
    deviceId: deviceB.deviceId,
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    body: { manifest: man.manifest, manifestDigest: man.manifestDigest },
    bodyMode: 'json',
    timeoutMs: 30_000,
  });
  const uploadId = /** @type {{ uploadId?: string }} */ (created).uploadId;
  if (typeof uploadId !== 'string') throw requestInvalidError();

  let denied = false;
  try {
    await requestPinnedBinary({
      agentUrl,
      path: `/agent/upload/sessions/${encodeURIComponent(uploadId)}`,
      tlsFingerprint,
      method: 'GET',
      token: deviceA.token,
      deviceId: deviceA.deviceId,
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      bodyMode: 'none',
      timeoutMs: 15_000,
    });
  } catch (error) {
    if (error instanceof LinkeError && error.code === ERROR_CODES.UPLOAD_SESSION_NOT_FOUND) {
      denied = true;
    } else {
      throw error instanceof LinkeError ? error : requestInvalidError();
    }
  }
  if (!denied) throw requestInvalidError();

  await bestEffortAbort(deviceB, agentUrl, tlsFingerprint, uploadId);
  try {
    await rm(scenarioRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }

  return {
    role: 'endpoint',
    phase: 'cross-device-deny',
    status: 'PASS',
    code: ERROR_CODES.UPLOAD_SESSION_NOT_FOUND,
    flag: true,
    at: now().toISOString(),
  };
}

/**
 * Create auto endpoint harness (production client against private 0600 bundle).
 * @param {{
 *   runDir?: string,
 *   now?: () => Date,
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   requireAutoGate?: boolean,
 * }} [options]
 */
export async function createAutoEndpointHarness({
  runDir = process.cwd(),
  now = () => new Date(),
  env = process.env,
  requireAutoGate = false,
} = {}) {
  if (requireAutoGate) assertAutoGate(env);
  await assertDedicatedRunDirectory(runDir);

  async function loadBundle() {
    return /** @type {ReturnType<typeof validateAutoEndpointBundle>} */ (
      await readPrivateJson(
        join(runDir, AUTO_BUNDLE_FILE),
        (value) => validateAutoEndpointBundle(value),
      )
    );
  }

  /**
   * @param {string} scenario
   */
  async function runScenario(scenario) {
    const phase = assertAutoScenario(scenario);
    try {
      const bundle = await loadBundle();
      if (phase === 'disconnect-resume') {
        return await runDisconnectResume(bundle, runDir, now);
      }
      if (phase === 'corrupt-chunk') {
        return await runCorruptChunk(bundle, runDir, now);
      }
      if (phase === 'manifest-conflict') {
        return await runManifestConflict(bundle, runDir, now);
      }
      if (phase === 'cross-device-deny') {
        return await runCrossDeviceDeny(bundle, runDir, now);
      }
      throw requestInvalidError();
    } catch (error) {
      return sanitizedFailure('endpoint', phase, error, now);
    }
  }

  return {
    runScenario,
    getAutoScenarios: () => [...AUTO_SCENARIOS],
  };
}

/**
 * Real-LAN endpoint harness — exact hardware gate + dedicated runDir.
 * Without operator second Mac/VM → BLOCKED (never PASS).
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   runDir?: string,
 * }} [options]
 */
export async function createRealEndpointHarness({
  env = process.env,
  runDir = process.cwd(),
} = {}) {
  assertRealGate(env);
  await assertDedicatedRunDirectory(runDir);
  return {
    role: 'endpoint',
    mode: 'real',
    /**
     * @param {string} phase
     */
    async runPhase(phase) {
      if (typeof phase !== 'string' || phase.length === 0) {
        return sanitizedFailure('endpoint', 'main', requestInvalidError());
      }
      return sanitizedBlocked(
        'endpoint',
        phase,
        new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }),
      );
    },
  };
}

/**
 * Endpoint main.
 * - auto <scenario>: requires AUTO gate; cwd must be dedicated runDir with 0600 bundle
 * - real path / bare phase: requires REAL gate → BLOCKED without hardware
 * Gate missing / extra argv → one sanitized FAIL line
 *
 * @param {object} [options]
 */
export async function runEndpointHarnessMain(options = {}) {
  const output = options.stdout ?? process.stdout;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const argv = Array.isArray(options.argv) ? options.argv : process.argv;
  const runDir = options.runDir ?? process.cwd();

  const writeResult = (result) => {
    try {
      output.write(serializeSanitizedResult(result));
    } catch {
      output.write(serializeSanitizedResult(sanitizedFailure(
        'endpoint',
        'main',
        new LinkeError(ERROR_CODES.DEVICE_INTERNAL_ERROR),
        now,
      )));
    }
  };

  // argv: [node, script, ...args]
  const args = argv.slice(2);

  if (args[0] === 'auto') {
    // Strict: exactly [auto, scenario]
    if (args.length !== 2) {
      writeResult(sanitizedFailure(
        'endpoint',
        'main',
        new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }),
        now,
      ));
      return 1;
    }
    try {
      assertAutoGate(env);
      const scenario = assertAutoScenario(args[1]);
      const harness = await createAutoEndpointHarness({
        runDir,
        now,
        env,
        requireAutoGate: true,
      });
      const result = await harness.runScenario(scenario);
      writeResult(result);
      return result.status === 'PASS' ? 0 : 1;
    } catch (error) {
      writeResult(sanitizedFailure('endpoint', 'main', error, now));
      return 1;
    }
  }

  // Real path: optional single phase; requires real gate
  if (args.length > 1) {
    writeResult(sanitizedFailure(
      'endpoint',
      'main',
      new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }),
      now,
    ));
    return 1;
  }

  try {
    assertRealGate(env);
  } catch (error) {
    writeResult(sanitizedFailure(
      'endpoint',
      args.length === 1 && typeof args[0] === 'string' ? args[0] : 'main',
      error,
      now,
    ));
    return 1;
  }

  const phase = args.length === 1 && typeof args[0] === 'string' ? args[0] : 'main';
  writeResult(sanitizedBlocked(
    'endpoint',
    phase,
    new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }),
    now,
  ));
  return 1;
}

// Direct node entry only; import remains zero side-effects.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runEndpointHarnessMain().then((code) => {
    if (typeof code === 'number' && code !== 0) process.exitCode = code;
  }).catch(() => {
    try {
      process.stdout.write(serializeSanitizedResult(sanitizedFailure(
        'endpoint',
        'main',
        new LinkeError(ERROR_CODES.DEVICE_INTERNAL_ERROR),
      )));
    } catch {
      // last-resort
    }
    process.exitCode = 1;
  });
}
