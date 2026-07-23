/**
 * G0c auto / real-LAN controller runner.
 * Import has zero side effects; main only when invoked as direct entry.
 * Auto: production TLS agent + restore stack on loopback; private 0600 bundle.
 * Real: exact hardware gate; no fake PASS / no report without hardware.
 * Auto harness complete ≠ real-LAN complete.
 */

import { createHash, X509Certificate } from 'node:crypto';
import { access, mkdir, writeFile, chmod as fsChmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  generateControllerPrivateKey,
  createOpenSslCertificate,
} from '../../src/tls-identity-store.js';
import { DeviceRegistry } from '../../src/device-registry.js';
import { createAgentListener } from '../../src/agent-listener.js';
import { createUploadLocks } from '../../src/upload-locks.js';
import { createRestoreService } from '../../src/restore-service.js';
import { createRestoreTaskStore } from '../../src/restore-task-store.js';
import { createRestoreSnapshotReader } from '../../src/restore-snapshot-reader.js';
import { createRestoreChunkReader } from '../../src/restore-chunk-reader.js';
import { projectCanonicalUploadManifest } from '../../src/upload-manifest.js';
import { getSnapshotManifest, safeDevicePath } from '../../src/storage.js';
import { createFixedWindowRateLimiter } from '../../src/rate-limit.js';
import { ERROR_CODES, LinkeError } from '../../src/error-codes.js';
import { DEVICE_PROTOCOL_VERSION } from '../../src/device-protocol.js';
import {
  assertRealGate,
  assertAutoGate,
  assertAutoScenario,
  assertDedicatedRunDirectory,
  atomicWritePrivateJson,
  serializeSanitizedResult,
  sanitizedFailure,
  sanitizedBlocked,
  validateAutoEndpointBundle,
  AUTO_BUNDLE_FILE,
  READY_MARKER_FILE,
  STOP_MARKER_FILE,
  RUN_MARKER_FILE,
  BACKPRESSURE_RELEASE_REQUEST_FILE,
  BACKPRESSURE_RELEASE_ACK_FILE,
  PURPOSE,
  SCHEMA_VERSION,
} from './g0c-auto-common.js';

const T0 = '2026-07-23T12:00:00.000Z';
const DEVICE_A = 'device-g0c-alpha';
const DEVICE_B = 'device-g0c-beta';
const SNAP_A = '550e8400-e29b-41d4-a716-4466554400a1';
const SNAP_B = '550e8400-e29b-41d4-a716-4466554400b1';
const ZERO_SHA =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/**
 * @returns {LinkeError}
 */
function requestInvalidError() {
  return new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
}

/**
 * Plant a remote-upload final snapshot under dataDir for restore stack.
 * @param {{
 *   dataDir: string,
 *   deviceId: string,
 *   snapshotId: string,
 *   files: { path: string, content: string | Buffer }[],
 * }} opts
 */
async function plantSnapshot(opts) {
  const { dataDir, deviceId, snapshotId, files } = opts;
  const { deviceRel } = safeDevicePath(dataDir, deviceId);
  const base = join(dataDir, deviceRel, 'snapshots', snapshotId);
  await mkdir(join(base, 'files'), { recursive: true });

  /** @type {{ path: string, size: number, sha256: string }[]} */
  const entries = [];
  let totalBytes = 0;
  for (const f of files) {
    const content = typeof f.content === 'string' ? Buffer.from(f.content, 'utf8') : f.content;
    const abs = join(base, 'files', f.path);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content);
    const sha256 = content.length === 0
      ? ZERO_SHA
      : createHash('sha256').update(content).digest('hex');
    entries.push({ path: f.path, size: content.length, sha256 });
    totalBytes += content.length;
  }
  const sorted = [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')),
  );
  const manifestInput = {
    schemaVersion: 2,
    snapshotId,
    deviceId,
    createdAt: T0,
    files: sorted.map((e) => e.path),
    integrity: {
      algorithm: 'sha256',
      totalBytes,
      entries: sorted,
    },
  };
  const { manifest: canonical, manifestDigest } = projectCanonicalUploadManifest(
    manifestInput,
    { authenticatedDeviceId: deviceId },
  );
  await writeFile(join(base, 'manifest.json'), JSON.stringify(canonical), 'utf8');
  await writeFile(
    join(base, 'COMPLETED.json'),
    JSON.stringify({
      schemaVersion: 1,
      origin: 'remote-upload',
      snapshotId,
      manifestDigest,
      committedAt: T0,
      uploadId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000099',
      deviceId,
    }, null, 2),
    'utf8',
  );
  const indexPath = join(dataDir, deviceRel, 'snapshots.json');
  let list = [];
  try {
    const { readFile } = await import('node:fs/promises');
    list = JSON.parse(await readFile(indexPath, 'utf8'));
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) list = [];
  list = list.filter((e) => e && e.snapshotId !== snapshotId);
  list.push({
    snapshotId,
    origin: 'remote-upload',
    manifestDigest,
    committedAt: T0,
  });
  await mkdir(join(dataDir, deviceRel), { recursive: true });
  await writeFile(indexPath, JSON.stringify(list, null, 2), 'utf8');
  return { manifestDigest, totalBytes, entries: sorted };
}

/**
 * Create auto production G0c restore controller (loopback TLS + production service).
 * Does not require real-LAN hardware gate. Not real-LAN evidence.
 *
 * @param {{
 *   dataDir: string,
 *   scenario?: string,
 *   now?: () => Date,
 *   maxGlobalTransfers?: number,
 * }} options
 */
export async function createAutoControllerHarness({
  dataDir,
  scenario = 'completed',
  now = () => new Date(T0),
  maxGlobalTransfers = 4,
} = {}) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) throw requestInvalidError();
  const phase = assertAutoScenario(scenario);

  const { keyPem } = generateControllerPrivateKey();
  const certPem = await createOpenSslCertificate({
    keyPem,
    san: 'IP:127.0.0.1',
  });
  const certificate = new X509Certificate(certPem);
  const fingerprint = certificate.fingerprint256.replaceAll(':', '').toLowerCase();
  const identity = { keyPem, certPem, fingerprint };

  const registry = new DeviceRegistry({ dataDir });

  // Backpressure scenario: tight global live-transfer budget.
  const locks = createUploadLocks({
    maxGlobalTransfers: phase === 'global-backpressure' ? 1 : maxGlobalTransfers,
  });

  const snapshotReader = createRestoreSnapshotReader({
    dataDir,
    getSnapshotManifestFn: getSnapshotManifest,
  });
  const taskStore = createRestoreTaskStore({
    dataDir,
    now,
    storageReader: snapshotReader,
  });
  const chunkReader = createRestoreChunkReader({
    dataDir,
    taskStore,
    snapshotReader,
  });

  // Production restore service — no normal-path wire DI (chunkSize/signal fixed in service).
  const baseRestore = createRestoreService({
    taskStore,
    locks,
    storageReader: chunkReader,
    findActiveUpload: async () => false,
    now,
  });

  // pre-anchor-cancel ONLY: thin cancel trigger after first real progress ACK.
  // All other methods are production baseRestore references (no pickExact / no chunkSize inject).
  let cancelFired = false;
  /** @type {(() => void) | null} */
  let releaseHeldSlot = null;
  /** @type {Promise<void> | null} */
  let heldSlotPromise = null;

  /** @type {ReturnType<typeof createRestoreService>} */
  let restoreService;
  if (phase === 'pre-anchor-cancel') {
    restoreService = Object.freeze({
      acceptCleanup: baseRestore.acceptCleanup,
      acceptReceipt: baseRestore.acceptReceipt,
      cancelTask: baseRestore.cancelTask,
      claim: baseRestore.claim,
      createTask: baseRestore.createTask,
      getChunk: baseRestore.getChunk,
      getStatus: baseRestore.getStatus,
      getTask: baseRestore.getTask,
      hasActiveRestore: baseRestore.hasActiveRestore,
      updateProgress: async (input) => {
        const result = await baseRestore.updateProgress(input);
        if (!cancelFired) {
          cancelFired = true;
          await baseRestore.cancelTask({
            deviceId: /** @type {{ deviceId?: string }} */ (input)?.deviceId,
            taskId: /** @type {{ taskId?: string }} */ (input)?.taskId,
          });
          return { ...result, cancelRequested: true };
        }
        return result;
      },
    });
  } else {
    restoreService = baseRestore;
  }

  const server = createAgentListener({
    identity,
    registry,
    onHeartbeat: async () => {},
    rateLimit: createFixedWindowRateLimiter({ maxRequests: 60, windowMs: 60_000 }),
    uploadRateLimit: createFixedWindowRateLimiter({ maxRequests: 1200, windowMs: 60_000 }),
    restoreRateLimit: createFixedWindowRateLimiter({ maxRequests: 1200, windowMs: 60_000 }),
    restoreService,
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

  // Plant snapshots for both devices.
  const filesA = [
    { path: 'alpha.txt', content: 'g0c-alpha-payload' },
    { path: 'nested/beta.txt', content: 'g0c-beta-nested' },
  ];
  // Slightly larger content for disconnect-recovery multi-file resume.
  if (phase === 'disconnect-recovery') {
    filesA.push({ path: 'gamma.bin', content: Buffer.alloc(64, 0x41) });
  }
  await plantSnapshot({
    dataDir,
    deviceId: DEVICE_A,
    snapshotId: SNAP_A,
    files: filesA,
  });
  await plantSnapshot({
    dataDir,
    deviceId: DEVICE_B,
    snapshotId: SNAP_B,
    files: [{ path: 'owner-b.txt', content: 'g0c-owner-b-only' }],
  });

  // Create restore tasks for scenarios that need them.
  if (phase === 'cross-device-deny') {
    await restoreService.createTask({
      deviceId: DEVICE_B,
      snapshotId: SNAP_B,
      relativeTarget: 'apps/target-b',
    });
  } else if (phase === 'global-backpressure') {
    await restoreService.createTask({
      deviceId: DEVICE_A,
      snapshotId: SNAP_A,
      relativeTarget: 'apps/target-a',
    });
    // Hold the single live-transfer slot so next getChunk is 429 restore-backpressure.
    heldSlotPromise = new Promise((resolveHold) => {
      locks.runTransfer(async () => {
        await new Promise((release) => {
          releaseHeldSlot = () => {
            release();
            resolveHold();
          };
        });
      }).catch(() => {
        resolveHold();
      });
    });
    // Give the slot a tick to acquire.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  } else {
    await restoreService.createTask({
      deviceId: DEVICE_A,
      snapshotId: SNAP_A,
      relativeTarget: 'apps/target-a',
    });
  }

  /**
   * Write 0600 auto endpoint bundle + ready marker under dedicated runDir.
   * @param {string} runDir
   */
  async function writeAutoBundle(runDir) {
    // Ensure run marker if missing (caller may have created dedicated dir).
    try {
      await assertDedicatedRunDirectory(runDir);
    } catch {
      await atomicWritePrivateJson(join(runDir, RUN_MARKER_FILE), {
        schemaVersion: SCHEMA_VERSION,
        purpose: PURPOSE,
      });
      await assertDedicatedRunDirectory(runDir);
    }
    // Endpoint-local dirs under runDir (relative names only).
    for (const name of ['restore-root', 'ep-data-a', 'ep-data-b']) {
      const p = join(runDir, name);
      await mkdir(p, { recursive: true });
      await fsChmod(p, 0o700);
    }
    // Ensure restore parent for relativeTarget apps/target-*
    await mkdir(join(runDir, 'restore-root', 'apps'), { recursive: true });

    const candidate = {
      schemaVersion: SCHEMA_VERSION,
      purpose: PURPOSE,
      kind: 'auto-endpoint',
      scenario: phase,
      agentUrl,
      tlsFingerprint: fingerprint,
      deviceA: { deviceId: deviceA.deviceId, token: deviceA.token },
      deviceB: { deviceId: deviceB.deviceId, token: deviceB.token },
      restoreRootRelative: 'restore-root',
      endpointDataDirRelativeA: 'ep-data-a',
      endpointDataDirRelativeB: 'ep-data-b',
    };
    const bundle = validateAutoEndpointBundle(candidate);
    await atomicWritePrivateJson(join(runDir, AUTO_BUNDLE_FILE), bundle);
    await atomicWritePrivateJson(join(runDir, READY_MARKER_FILE), {
      schemaVersion: SCHEMA_VERSION,
      purpose: PURPOSE,
      ready: true,
      scenario: phase,
    });
    return bundle;
  }

  async function releaseBackpressureSlot() {
    if (typeof releaseHeldSlot === 'function') {
      releaseHeldSlot();
      releaseHeldSlot = null;
    }
    if (heldSlotPromise) {
      await heldSlotPromise.catch(() => {});
      heldSlotPromise = null;
    }
  }

  async function close() {
    await releaseBackpressureSlot();
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
    scenario: phase,
    agentUrl,
    tlsFingerprint: fingerprint,
    deviceA,
    deviceB,
    restoreService,
    locks,
    writeAutoBundle,
    releaseBackpressureSlot,
    close,
  };
}

/**
 * Real-LAN controller harness — exact hardware gate required.
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
 * Direct main:
 * - no gate → one sanitized FAIL line
 * - auto serve <scenario> → start controller, write bundle, wait stop, PASS
 * - real gate open without hardware → BLOCKED
 *
 * @param {object} [options]
 */
export async function runControllerHarnessMain(options = {}) {
  const output = options.stdout ?? process.stdout;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const argv = Array.isArray(options.argv) ? options.argv : process.argv;
  const runDir = options.runDir ?? process.cwd();
  const dataDir = options.dataDir
    ?? env.LINKE_G0C_AUTO_DATA_DIR
    ?? join(runDir, 'controller-data');

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

  const args = argv.slice(2);

  // Auto serve path: [auto, serve, scenario]
  if (args[0] === 'auto') {
    if (args.length !== 3 || args[1] !== 'serve') {
      writeResult(sanitizedFailure(
        'controller',
        'main',
        new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }),
        now,
      ));
      return 1;
    }
    try {
      assertAutoGate(env);
      const scenario = assertAutoScenario(args[2]);
      await mkdir(dataDir, { recursive: true });
      await fsChmod(dataDir, 0o700).catch(() => {});
      await atomicWritePrivateJson(join(runDir, RUN_MARKER_FILE), {
        schemaVersion: SCHEMA_VERSION,
        purpose: PURPOSE,
      });
      const harness = await createAutoControllerHarness({
        dataDir,
        scenario,
        now,
      });
      try {
        await harness.writeAutoBundle(runDir);
        // Serve until stop; honor backpressure release-request before stop (not only on exit).
        const stopPath = join(runDir, STOP_MARKER_FILE);
        const releaseReqPath = join(runDir, BACKPRESSURE_RELEASE_REQUEST_FILE);
        const releaseAckPath = join(runDir, BACKPRESSURE_RELEASE_ACK_FILE);
        const deadline = Date.now() + 120_000;
        let released = false;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (!released && scenario === 'global-backpressure') {
            try {
              await access(releaseReqPath);
              await harness.releaseBackpressureSlot();
              released = true;
              await atomicWritePrivateJson(releaseAckPath, {
                schemaVersion: SCHEMA_VERSION,
                purpose: PURPOSE,
                released: true,
              });
            } catch {
              // no request yet
            }
          }
          try {
            await access(stopPath);
            break;
          } catch {
            if (Date.now() > deadline) {
              throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
            }
            await new Promise((r) => setTimeout(r, 40));
          }
        }
        writeResult({
          role: 'controller',
          phase: scenario,
          status: 'PASS',
          at: now().toISOString(),
        });
        return 0;
      } finally {
        await harness.close().catch(() => {});
      }
    } catch (error) {
      writeResult(sanitizedFailure('controller', 'main', error, now));
      return 1;
    }
  }

  // Real path: require real gate → BLOCKED without hardware
  try {
    assertRealGate(env);
  } catch (error) {
    writeResult(sanitizedFailure('controller', 'main', error, now));
    return 1;
  }

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
