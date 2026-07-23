/**
 * G0c auto / real-LAN endpoint runner.
 * Import has zero side effects; main only when invoked as direct entry.
 * Auto: production runEndpointRestore + requestPinnedBinary / requestPinnedDownload.
 * Direct argv: [node, script, 'auto', scenario, 'device-a'|'device-b'] with exact AUTO gate.
 * Real: exact REAL gate; without hardware → BLOCKED (never PASS).
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  requestPinnedBinary,
  requestPinnedDownload,
} from '../../src/device-client.js';
import { runEndpointRestore } from '../../src/restore-endpoint-engine.js';
import { createEndpointRestoreStateStore } from '../../src/restore-endpoint-state.js';
import {
  publishFromStagingVerified,
  rollbackPublished,
  recoverFromCrash,
  recoverCancelledLocal,
} from '../../src/restore-publish.js';
import { ERROR_CODES, LinkeError } from '../../src/error-codes.js';
import { DEVICE_PROTOCOL_VERSION } from '../../src/device-protocol.js';
import {
  AUTO_SCENARIOS,
  AUTO_BUNDLE_FILE,
  BACKPRESSURE_RELEASE_REQUEST_FILE,
  BACKPRESSURE_RELEASE_ACK_FILE,
  DISCONNECT_MID_MARKER_FILE,
  assertRealGate,
  assertAutoGate,
  assertAutoScenario,
  assertDedicatedRunDirectory,
  atomicWritePrivateJson,
  readPrivateJson,
  resolveAllowlistedPath,
  serializeSanitizedResult,
  sanitizedFailure,
  sanitizedBlocked,
  validateAutoEndpointBundle,
  SCHEMA_VERSION,
  PURPOSE,
} from './g0c-auto-common.js';

export const ENDPOINT_SCENARIOS = AUTO_SCENARIOS;

const ALPHA_CONTENT = 'g0c-alpha-payload';
const BETA_CONTENT = 'g0c-beta-nested';
const ALPHA_SHA = createHash('sha256').update(ALPHA_CONTENT, 'utf8').digest('hex');
const BETA_SHA = createHash('sha256').update(BETA_CONTENT, 'utf8').digest('hex');

/**
 * @returns {LinkeError}
 */
function requestInvalidError() {
  return new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
}

/**
 * @param {object} opts
 */
async function productionRequestJson(opts) {
  const method = String(opts.method || 'POST').toUpperCase();
  return requestPinnedBinary({
    agentUrl: opts.agentUrl,
    path: opts.path,
    tlsFingerprint: opts.tlsFingerprint,
    method,
    token: opts.token,
    deviceId: opts.deviceId,
    protocolVersion: opts.protocolVersion ?? DEVICE_PROTOCOL_VERSION,
    body: opts.body,
    bodyMode: opts.bodyMode ?? (method === 'GET' ? 'none' : 'json'),
    timeoutMs: opts.timeoutMs ?? 15_000,
    signal: opts.signal,
  });
}

/**
 * @param {object} opts
 */
async function productionDownload(opts) {
  return requestPinnedDownload({
    agentUrl: opts.agentUrl,
    path: opts.path,
    tlsFingerprint: opts.tlsFingerprint,
    token: opts.token,
    deviceId: opts.deviceId,
    protocolVersion: opts.protocolVersion ?? DEVICE_PROTOCOL_VERSION,
    expectedLength: opts.expectedLength,
    expectedSha256: opts.expectedSha256,
    onChunk: opts.onChunk,
    timeoutMs: opts.timeoutMs ?? 120_000,
    idleTimeoutMs: opts.idleTimeoutMs ?? 15_000,
    signal: opts.signal,
  });
}

/**
 * @param {string} path
 * @param {number} ms
 */
async function waitForPath(path, ms) {
  const deadline = Date.now() + ms;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await accessPath(path);
      return;
    } catch {
      if (Date.now() > deadline) throw requestInvalidError();
      await new Promise((r) => setTimeout(r, 40));
    }
  }
}

/**
 * @param {string} path
 */
async function accessPath(path) {
  const { access } = await import('node:fs/promises');
  await access(path);
}

/**
 * Production HTTPS GET task for controller status oracle.
 * @param {object} bundle
 * @param {{ deviceId: string, token: string }} device
 * @param {string} taskId
 */
async function getTaskHttps(bundle, device, taskId) {
  return productionRequestJson({
    agentUrl: bundle.agentUrl,
    path: `/agent/restore/tasks/${taskId}`,
    tlsFingerprint: bundle.tlsFingerprint,
    method: 'GET',
    token: device.token,
    deviceId: device.deviceId,
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    bodyMode: 'none',
    timeoutMs: 15_000,
  });
}

/**
 * @param {ReturnType<typeof validateAutoEndpointBundle>} bundle
 * @param {string} runDir
 * @param {'device-a' | 'device-b'} role
 * @param {() => Date} now
 * @param {string} scenario
 */
async function runRoleScenario(bundle, runDir, role, now, scenario) {
  const device = role === 'device-b' ? bundle.deviceB : bundle.deviceA;
  const epRel = role === 'device-b'
    ? bundle.endpointDataDirRelativeB
    : bundle.endpointDataDirRelativeA;
  const restoreRoot = resolveAllowlistedPath(runDir, bundle.restoreRootRelative);
  const endpointDataDir = resolveAllowlistedPath(runDir, epRel);
  await mkdir(restoreRoot, { recursive: true });
  await mkdir(join(restoreRoot, 'apps'), { recursive: true });
  await mkdir(endpointDataDir, { recursive: true });

  const stateStore = createEndpointRestoreStateStore({
    endpointDataDir,
    now,
  });

  const publishBase = {
    publishFromStagingVerified,
    rollbackPublished,
    recoverFromCrash,
    recoverCancelledLocal,
  };

  // Peer-only for device-b on non-cross-device scenarios (topology PID only).
  if (role === 'device-b' && scenario !== 'cross-device-deny') {
    return {
      role: 'endpoint',
      phase: scenario,
      status: 'PASS',
      promptHandled: 'peer-ok',
      at: now().toISOString(),
    };
  }

  if (scenario === 'cross-device-deny') {
    if (role === 'device-a') {
      await new Promise((r) => setTimeout(r, 200));
      const bTaskMarker = join(runDir, '.g0c-b-task-id');
      let taskId = null;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          const raw = await readFile(bTaskMarker, 'utf8');
          const parsed = JSON.parse(raw);
          if (typeof parsed.taskId === 'string') {
            taskId = parsed.taskId;
            break;
          }
        } catch {
          // wait
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      if (typeof taskId !== 'string') throw requestInvalidError();

      let denied = false;
      try {
        await getTaskHttps(bundle, device, taskId);
      } catch (error) {
        if (error instanceof LinkeError && error.code === ERROR_CODES.RESTORE_TASK_NOT_FOUND) {
          denied = true;
        } else {
          throw error instanceof LinkeError ? error : requestInvalidError();
        }
      }
      if (!denied) throw requestInvalidError();

      // A must not materialize B payload under restore root.
      const bPayload = join(restoreRoot, 'apps', 'target-b', 'owner-b.txt');
      await assert.rejectsPathMissing(bPayload);

      return {
        role: 'endpoint',
        phase: scenario,
        status: 'PASS',
        code: ERROR_CODES.RESTORE_TASK_NOT_FOUND,
        flag: true,
        at: now().toISOString(),
      };
    }

    // device-b owner
    const claimed = await productionRequestJson({
      agentUrl: bundle.agentUrl,
      path: '/agent/restore/tasks/claim',
      tlsFingerprint: bundle.tlsFingerprint,
      method: 'POST',
      token: device.token,
      deviceId: device.deviceId,
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      body: {},
      bodyMode: 'json',
      timeoutMs: 15_000,
    });
    const taskId = claimed?.task?.taskId;
    if (typeof taskId !== 'string') throw requestInvalidError();
    await writeFile(
      join(runDir, '.g0c-b-task-id'),
      `${JSON.stringify({ taskId })}\n`,
      { mode: 0o600 },
    );
    await new Promise((r) => setTimeout(r, 1500));
    const st = await getTaskHttps(bundle, device, taskId);
    if (st.status !== 'active' && st.status !== 'pending') {
      // claimed active expected
      if (st.taskId !== taskId) throw requestInvalidError();
    }
    return {
      role: 'endpoint',
      phase: scenario,
      status: 'PASS',
      promptHandled: 'owner-ok',
      at: now().toISOString(),
    };
  }

  if (scenario === 'global-backpressure') {
    const claimed = await productionRequestJson({
      agentUrl: bundle.agentUrl,
      path: '/agent/restore/tasks/claim',
      tlsFingerprint: bundle.tlsFingerprint,
      method: 'POST',
      token: device.token,
      deviceId: device.deviceId,
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      body: {},
      bodyMode: 'json',
      timeoutMs: 15_000,
    });
    const taskId = claimed?.task?.taskId;
    if (typeof taskId !== 'string') throw requestInvalidError();

    let firstBlocked = false;
    /** @type {number} */
    let retryAfter = 0;
    try {
      await productionDownload({
        agentUrl: bundle.agentUrl,
        path: `/agent/restore/tasks/${taskId}/files/0/chunks/0`,
        tlsFingerprint: bundle.tlsFingerprint,
        token: device.token,
        deviceId: device.deviceId,
        protocolVersion: DEVICE_PROTOCOL_VERSION,
        expectedLength: 1,
        onChunk: async () => {},
        timeoutMs: 15_000,
      });
    } catch (error) {
      if (
        error instanceof LinkeError
        && error.code === ERROR_CODES.RESTORE_BACKPRESSURE
        && error.statusCode === 429
      ) {
        firstBlocked = true;
        const ra = /** @type {{ retryAfterSec?: number }} */ (error).retryAfterSec;
        retryAfter = Number.isInteger(ra) ? /** @type {number} */ (ra) : 1;
      } else {
        throw error instanceof LinkeError ? error : requestInvalidError();
      }
    }
    if (!firstBlocked) throw requestInvalidError();
    if (retryAfter < 1 || retryAfter > 30) throw requestInvalidError();

    // Request controller to release production slot, then second GET must succeed.
    await writeFile(
      join(runDir, BACKPRESSURE_RELEASE_REQUEST_FILE),
      'release\n',
      { mode: 0o600 },
    );
    await waitForPath(join(runDir, BACKPRESSURE_RELEASE_ACK_FILE), 30_000);

    const parts = [];
    const second = await productionDownload({
      agentUrl: bundle.agentUrl,
      path: `/agent/restore/tasks/${taskId}/files/0/chunks/0`,
      tlsFingerprint: bundle.tlsFingerprint,
      token: device.token,
      deviceId: device.deviceId,
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      expectedLength: Buffer.byteLength(ALPHA_CONTENT),
      expectedSha256: ALPHA_SHA,
      onChunk: async (buf) => {
        parts.push(Buffer.from(buf));
      },
      timeoutMs: 30_000,
    });
    const body = Buffer.concat(parts);
    if (body.toString('utf8') !== ALPHA_CONTENT) throw requestInvalidError();
    if (second.sha256 !== ALPHA_SHA) throw requestInvalidError();
    if (second.bytesReceived !== body.length) throw requestInvalidError();

    return {
      role: 'endpoint',
      phase: scenario,
      status: 'PASS',
      code: ERROR_CODES.RESTORE_BACKPRESSURE,
      flag: true,
      count: retryAfter,
      promptHandled: 'backpressure-then-ok',
      at: now().toISOString(),
    };
  }

  // disconnect-recovery: child restart protocol via mid marker under endpointDataDir.
  if (scenario === 'disconnect-recovery') {
    const midPath = join(endpointDataDir, DISCONNECT_MID_MARKER_FILE);
    let isResume = false;
    try {
      await lstat(midPath);
      isResume = true;
    } catch {
      isResume = false;
    }

    /** @type {number} */
    let claimCount = 0;
    const countingRequestJson = async (opts) => {
      if (
        String(opts.path) === '/agent/restore/tasks/claim'
        && String(opts.method || 'POST').toUpperCase() === 'POST'
      ) {
        claimCount += 1;
      }
      return productionRequestJson(opts);
    };

    if (!isResume) {
      let downloadCount = 0;
      const downloadOnce = async (opts) => {
        downloadCount += 1;
        if (downloadCount > 1) {
          throw new LinkeError(ERROR_CODES.RESTORE_INTERRUPTED, {
            statusCode: null,
            retryable: true,
          });
        }
        return productionDownload(opts);
      };
      try {
        await runEndpointRestore({
          agentUrl: bundle.agentUrl,
          tlsFingerprint: bundle.tlsFingerprint,
          token: device.token,
          deviceId: device.deviceId,
          protocolVersion: DEVICE_PROTOCOL_VERSION,
          restoreRoot,
          endpointDataDir,
          retryBudget: 1,
          stateStore,
          publish: publishBase,
          requestJson: countingRequestJson,
          download: downloadOnce,
          now,
        });
        throw requestInvalidError(); // must not complete first pass
      } catch (error) {
        // retryBudget:1 + RESTORE_INTERRUPTED injection → production terminal is
        // RESTORE_RESUME_EXHAUSTED only (not the intermediate RESTORE_INTERRUPTED).
        if (
          !(error instanceof LinkeError)
          || error.code !== ERROR_CODES.RESTORE_RESUME_EXHAUSTED
        ) {
          throw error instanceof LinkeError ? error : requestInvalidError();
        }
      }

      // First interrupted child must claim exactly once (no duplicate claim).
      if (claimCount !== 1) throw requestInvalidError();

      // Discover local nonterminal STATE (receiving + durable bytes > 0).
      const taskDirs = await readdir(join(endpointDataDir, 'restore-tasks')).catch(() => []);
      let found = false;
      let durableBytes = 0;
      let phaseFound = '';
      for (const name of taskDirs) {
        try {
          const st = await stateStore.readState(name);
          if (st && typeof st.phase === 'string') {
            phaseFound = st.phase;
            durableBytes = Number(st.receivedBytes) || 0;
            if (st.phase === 'receiving' && durableBytes > 0) {
              found = true;
              await atomicWritePrivateJson(midPath, {
                schemaVersion: SCHEMA_VERSION,
                purpose: PURPOSE,
                phase: st.phase,
                receivedBytes: durableBytes,
                taskId: st.taskId,
              });
              break;
            }
          }
        } catch {
          // try next
        }
      }
      if (!found) {
        // Alternative layout: state store may use taskId paths — scan via openOrCreate discovery
        throw new LinkeError(ERROR_CODES.RESTORE_STATE_INVALID);
      }

      return {
        role: 'endpoint',
        phase: scenario,
        status: 'PASS',
        promptHandled: 'durable-interrupted',
        count: claimCount,
        flag: true,
        at: now().toISOString(),
      };
    }

    // Resume child: 0 claim, completed.
    claimCount = 0;
    const result = await runEndpointRestore({
      agentUrl: bundle.agentUrl,
      tlsFingerprint: bundle.tlsFingerprint,
      token: device.token,
      deviceId: device.deviceId,
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      restoreRoot,
      endpointDataDir,
      retryBudget: 8,
      stateStore,
      publish: publishBase,
      requestJson: countingRequestJson,
      download: productionDownload,
      now,
    });
    if (result.outcome !== 'completed') throw requestInvalidError();
    if (claimCount !== 0) throw requestInvalidError();

    // Target bytes oracle
    const alpha = await readFile(join(restoreRoot, 'apps', 'target-a', 'alpha.txt'));
    const beta = await readFile(join(restoreRoot, 'apps', 'target-a', 'nested', 'beta.txt'));
    if (alpha.toString('utf8') !== ALPHA_CONTENT) throw requestInvalidError();
    if (beta.toString('utf8') !== BETA_CONTENT) throw requestInvalidError();

    return {
      role: 'endpoint',
      phase: scenario,
      status: 'PASS',
      promptHandled: 'completed',
      count: 0,
      at: now().toISOString(),
    };
  }

  // rollback: force post-publish verify failure (production rollback path).
  /** @type {typeof publishBase} */
  let publish = publishBase;
  if (scenario === 'rollback') {
    publish = {
      ...publishBase,
      publishFromStagingVerified: async (ctx) => publishFromStagingVerified({
        ...ctx,
        verifyTargetTree: async () => {
          throw new LinkeError(ERROR_CODES.RESTORE_INTEGRITY_FAILED, {
            statusCode: 422,
            retryable: false,
          });
        },
      }),
      recoverFromCrash: async (ctx) => recoverFromCrash({
        ...ctx,
        verifyTargetTree: async () => {
          throw new LinkeError(ERROR_CODES.RESTORE_INTEGRITY_FAILED, {
            statusCode: 422,
            retryable: false,
          });
        },
      }),
    };
    const targetDir = join(restoreRoot, 'apps', 'target-a');
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, 'old.txt'), 'pre-existing-target-content');
  }

  /** @type {string | null} */
  let claimedTaskId = null;
  /** Last production receipt POST body (wire does not echo full receipt on GET). */
  /** @type {Record<string, unknown> | null} */
  let lastReceiptBody = null;
  /** @type {Record<string, unknown> | null} */
  let lastReceiptAck = null;
  /** Last production cleanup POST body. */
  /** @type {Record<string, unknown> | null} */
  let lastCleanupBody = null;
  /** @type {Record<string, unknown> | null} */
  let lastCleanupAck = null;

  const trackingRequestJson = async (opts) => {
    const path = String(opts.path || '');
    const method = String(opts.method || 'POST').toUpperCase();
    const body = opts.body && typeof opts.body === 'object' && !Array.isArray(opts.body)
      ? /** @type {Record<string, unknown>} */ (opts.body)
      : null;
    const res = await productionRequestJson(opts);
    if (
      path === '/agent/restore/tasks/claim'
      && res && typeof res === 'object'
      && res.task
      && typeof res.task.taskId === 'string'
    ) {
      claimedTaskId = res.task.taskId;
    }
    if (method === 'POST' && /\/agent\/restore\/tasks\/[^/]+\/receipts$/.test(path)) {
      lastReceiptBody = body;
      lastReceiptAck = res && typeof res === 'object' && !Array.isArray(res)
        ? /** @type {Record<string, unknown>} */ (res)
        : null;
    }
    if (method === 'POST' && /\/agent\/restore\/tasks\/[^/]+\/cleanup$/.test(path)) {
      lastCleanupBody = body;
      lastCleanupAck = res && typeof res === 'object' && !Array.isArray(res)
        ? /** @type {Record<string, unknown>} */ (res)
        : null;
    }
    return res;
  };

  const result = await runEndpointRestore({
    agentUrl: bundle.agentUrl,
    tlsFingerprint: bundle.tlsFingerprint,
    token: device.token,
    deviceId: device.deviceId,
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    restoreRoot,
    endpointDataDir,
    retryBudget: 8,
    stateStore,
    publish,
    requestJson: trackingRequestJson,
    download: productionDownload,
    now,
  });

  /**
   * Production wire omits receipt/cleanupReceipt on GET task (RESTORE_TASK_KEYS).
   * Prove them via: GET status fields + production POST bodies/ACKs + durable tombstone.
   * @param {string} taskId
   * @param {{
   *   getStatus: string,
   *   cleanupAuthorized: boolean,
   *   receiptOutcome: string | null,
   *   cleanupOutcome: string,
   *   receiptIdMode: 'aligned' | 'null',
   * }} expect
   */
  async function assertTerminalTaskOracle(taskId, expect) {
    const task = await getTaskHttps(bundle, device, taskId);
    // Exact terminal status — intermediate states (e.g. completed before cleaned) rejected.
    if (task.status !== expect.getStatus) throw requestInvalidError();
    if (task.cleanupAuthorized !== expect.cleanupAuthorized) throw requestInvalidError();

    const tomb = await stateStore.readTombstone(taskId);
    const durableReceipt = tomb?.receipt ?? null;
    const durableCleanup = tomb?.cleanupReceipt ?? null;

    if (expect.receiptOutcome === null) {
      // pre-anchor-cancel: no business receipt on durable STATE or wire POST.
      if (durableReceipt !== null) throw requestInvalidError();
      if (lastReceiptBody !== null) throw requestInvalidError();
      if (lastCleanupBody?.outcome !== expect.cleanupOutcome) throw requestInvalidError();
      if (lastCleanupBody?.receiptId !== null) throw requestInvalidError();
      if (durableCleanup?.outcome !== expect.cleanupOutcome) throw requestInvalidError();
      if (durableCleanup?.receiptId !== null) throw requestInvalidError();
      if (!lastCleanupAck || lastCleanupAck.ok !== true) throw requestInvalidError();
      if (lastCleanupAck.status !== expect.getStatus) throw requestInvalidError();
      return { task, durableReceipt, durableCleanup };
    }

    // completed / rolled-back business path
    if (!lastReceiptBody || lastReceiptBody.outcome !== expect.receiptOutcome) {
      throw requestInvalidError();
    }
    if (typeof lastReceiptBody.receiptId !== 'string') throw requestInvalidError();
    if (!lastReceiptAck || lastReceiptAck.ok !== true) throw requestInvalidError();
    if (lastReceiptAck.cleanupAuthorized !== true) throw requestInvalidError();
    if (lastReceiptAck.receiptId !== lastReceiptBody.receiptId) throw requestInvalidError();
    // Receipt POST ACK is two-phase protocol evidence: must be completed/rolled-back.
    // Direct cleaned on receipt ACK is a forbidden state (cleanup owns cleaned).
    if (lastReceiptAck.status !== expect.receiptOutcome) {
      throw requestInvalidError();
    }

    if (!lastCleanupBody || lastCleanupBody.outcome !== expect.cleanupOutcome) {
      throw requestInvalidError();
    }
    if (lastCleanupBody.receiptId !== lastReceiptBody.receiptId) throw requestInvalidError();
    if (!lastCleanupAck || lastCleanupAck.ok !== true) throw requestInvalidError();
    if (lastCleanupAck.status !== 'cleaned') throw requestInvalidError();

    if (!durableReceipt || durableReceipt.outcome !== expect.receiptOutcome) {
      throw requestInvalidError();
    }
    if (durableReceipt.receiptId !== lastReceiptBody.receiptId) throw requestInvalidError();
    if (!durableCleanup || durableCleanup.outcome !== expect.cleanupOutcome) {
      throw requestInvalidError();
    }
    if (durableCleanup.receiptId !== durableReceipt.receiptId) throw requestInvalidError();

    if (expect.receiptIdMode === 'aligned') {
      if (durableCleanup.receiptId !== lastReceiptBody.receiptId) throw requestInvalidError();
    }

    return { task, durableReceipt, durableCleanup };
  }

  if (scenario === 'completed') {
    if (result.outcome !== 'completed') throw requestInvalidError();
    const alpha = await readFile(join(restoreRoot, 'apps', 'target-a', 'alpha.txt'));
    const beta = await readFile(join(restoreRoot, 'apps', 'target-a', 'nested', 'beta.txt'));
    if (alpha.toString('utf8') !== ALPHA_CONTENT) throw requestInvalidError();
    if (beta.toString('utf8') !== BETA_CONTENT) throw requestInvalidError();
    if (createHash('sha256').update(alpha).digest('hex') !== ALPHA_SHA) {
      throw requestInvalidError();
    }
    if (createHash('sha256').update(beta).digest('hex') !== BETA_SHA) {
      throw requestInvalidError();
    }
    if (typeof claimedTaskId !== 'string') throw requestInvalidError();
    await assertTerminalTaskOracle(claimedTaskId, {
      getStatus: 'cleaned',
      cleanupAuthorized: true,
      receiptOutcome: 'completed',
      cleanupOutcome: 'completed',
      receiptIdMode: 'aligned',
    });
    return {
      role: 'endpoint',
      phase: scenario,
      status: 'PASS',
      promptHandled: 'completed',
      flag: true,
      at: now().toISOString(),
    };
  }

  if (scenario === 'rollback') {
    if (result.outcome !== 'rolled-back') throw requestInvalidError();
    // Old target must be restored via rollback anchor — exact content oracle.
    const old = await readFile(join(restoreRoot, 'apps', 'target-a', 'old.txt'), 'utf8');
    if (old !== 'pre-existing-target-content') throw requestInvalidError();
    // New payload must be absent after rollback (exact negative oracle).
    await assert.rejectsPathMissing(join(restoreRoot, 'apps', 'target-a', 'alpha.txt'));
    await assert.rejectsPathMissing(
      join(restoreRoot, 'apps', 'target-a', 'nested', 'beta.txt'),
    );
    if (typeof claimedTaskId !== 'string') throw requestInvalidError();
    await assertTerminalTaskOracle(claimedTaskId, {
      getStatus: 'cleaned',
      cleanupAuthorized: true,
      receiptOutcome: 'rolled-back',
      cleanupOutcome: 'rolled-back',
      receiptIdMode: 'aligned',
    });
    return {
      role: 'endpoint',
      phase: scenario,
      status: 'PASS',
      promptHandled: 'rolled-back',
      flag: true,
      at: now().toISOString(),
    };
  }

  if (scenario === 'pre-anchor-cancel') {
    if (result.outcome !== 'cancelled') throw requestInvalidError();
    // New payload must not materialize under target tree.
    await assert.rejectsPathMissing(join(restoreRoot, 'apps', 'target-a', 'alpha.txt'));
    await assert.rejectsPathMissing(
      join(restoreRoot, 'apps', 'target-a', 'nested', 'beta.txt'),
    );
    if (typeof claimedTaskId !== 'string') throw requestInvalidError();
    await assertTerminalTaskOracle(claimedTaskId, {
      getStatus: 'cancelled',
      cleanupAuthorized: false,
      receiptOutcome: null,
      cleanupOutcome: 'cancelled',
      receiptIdMode: 'null',
    });
    return {
      role: 'endpoint',
      phase: scenario,
      status: 'PASS',
      promptHandled: 'cancelled-local',
      flag: true,
      at: now().toISOString(),
    };
  }

  throw requestInvalidError();
}

// Tiny assert helper (no node:assert import side-effects in runner path).
const assert = {
  async rejectsPathMissing(path) {
    try {
      await lstat(path);
      throw requestInvalidError();
    } catch (error) {
      if (error instanceof LinkeError) throw error;
      if (/** @type {{ code?: string }} */ (error).code !== 'ENOENT') throw error;
    }
  },
};

/**
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
   * @param {'device-a' | 'device-b'} [role]
   */
  async function runScenario(scenario, role = 'device-a') {
    const phase = assertAutoScenario(scenario);
    try {
      const bundle = await loadBundle();
      return await runRoleScenario(bundle, runDir, role, now, phase);
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

  const args = argv.slice(2);

  if (args[0] === 'auto') {
    if (args.length !== 3) {
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
      const role = args[2];
      if (role !== 'device-a' && role !== 'device-b') {
        throw requestInvalidError();
      }
      const harness = await createAutoEndpointHarness({
        runDir,
        now,
        env,
        requireAutoGate: true,
      });
      const result = await harness.runScenario(scenario, role);
      writeResult(result);
      return result.status === 'PASS' ? 0 : 1;
    } catch (error) {
      writeResult(sanitizedFailure('endpoint', 'main', error, now));
      return 1;
    }
  }

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
