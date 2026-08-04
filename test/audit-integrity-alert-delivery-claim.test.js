/**
 * Task 3 RED — persistent audit integrity alert delivery claim coordinator.
 * Authority:
 *   docs/superpowers/specs/2026-08-04-audit-integrity-alert-delivery-claim-design.md
 *   docs/superpowers/plans/2026-08-04-audit-integrity-alert-delivery-claim-plan.md (Task 3)
 *
 * Production (absent on old HEAD):
 *   src/audit-integrity-alert-delivery-claim.js
 *
 * Old-HEAD RED is exactly one behavior-specific failure:
 *   test name + assert message = `delivery claim implementation missing`
 * Full matrix registers only after TTL export + three functions exist.
 * Narrow under-lease stream read export, if missing after coordinator lands,
 * forms a clear `stream read implementation missing` (no import noise; not a
 * second old-HEAD failure while the coordinator module is still absent).
 *
 * Real temp roots, real write queue / process lock, real claim-state / outbox /
 * stream / request APIs. No production-module mocks. No network / secrets.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { buildAuditIntegrityAlertDeliveryRequest } from '../src/audit-integrity-alert-delivery.js';
import {
  AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_RELATIVE_PATH,
  loadAuditIntegrityAlertDeliveryClaimState,
  publishAuditIntegrityAlertDeliveryClaimState,
} from '../src/audit-integrity-alert-delivery-claim-state.js';
import { AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH } from '../src/audit-integrity-alert-delivery-stream.js';
import {
  acknowledgeAuditIntegrityAlertOutboxHeadUnderLease,
  AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH,
  readAuditIntegrityAlertOutbox,
} from '../src/audit-integrity-alert-outbox.js';
import {
  acquireAuditIntegrityProcessLock,
  releaseAuditIntegrityProcessLock,
} from '../src/audit-integrity-process-lock.js';
import { enqueueAuditIntegrityWriteTask } from '../src/audit-integrity-write-queue.js';
import { createLaunchAgentProcessIdentityReader } from '../src/launchagent-lifecycle/process-identity.js';
import { assertSafeDataRoot } from '../src/safe-data-files.js';

const PRODUCTION_MODULE_URL = new URL(
  '../src/audit-integrity-alert-delivery-claim.js',
  import.meta.url,
);
const PRODUCTION_MODULE_PATH = fileURLToPath(PRODUCTION_MODULE_URL);
const CONTENDER_PATH = fileURLToPath(
  new URL('./helpers/audit-integrity-alert-delivery-claim-contender.js', import.meta.url),
);
const STREAM_MODULE_URL = new URL(
  '../src/audit-integrity-alert-delivery-stream.js',
  import.meta.url,
);

const MISSING_MSG = 'delivery claim implementation missing';
const STREAM_READ_MISSING_MSG = 'stream read implementation missing';
const CODE_UNAVAILABLE = 'audit-delivery-unavailable';
const TTL_MS = 120_000;

const CANONICAL_ENDPOINT = 'https://alerts.example.invalid/hooks/audit-integrity';
const FIXED_CHECKED_AT = '2026-08-04T12:00:00.000Z';
const FIXED_NOW = '2026-08-04T12:00:00.000Z';
const FIXED_STREAM_ID = 'b2222222-c222-4222-9222-f22222222222';
const OTHER_STREAM_ID = 'c3333333-d333-4333-a333-033333333333';
const CLAIM_ID_A = 'a1111111-b111-4111-8111-e11111111111';
const CLAIM_ID_B = 'd4444444-e444-4444-8444-f44444444444';

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MS_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const CLAIM_RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'claimId',
  'streamId',
  'sequence',
  'expiresAt',
  'request',
]);
const COMPLETE_RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'completed',
  'streamId',
  'sequence',
  'pendingCount',
]);
const RELEASE_RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'status',
  'released',
  'streamId',
  'sequence',
]);
const CAPABILITY_KEYS = Object.freeze(['claimId', 'streamId', 'sequence']);
const REQUEST_KEYS = Object.freeze(['schemaVersion', 'url', 'method', 'headers', 'body']);

const CANONICAL_IDLE_CLAIM_BYTES =
  '{"schemaVersion":1,"status":"idle","claimId":null,"streamId":null,"sequence":null,"ownerPid":null,"bootSessionIdentity":null,"processStartIdentity":null,"claimedAt":null,"expiresAt":null}\n';

/** @type {null | {
 *   AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_TTL_MS: number,
 *   claimAuditIntegrityAlertDelivery: Function,
 *   completeAuditIntegrityAlertDelivery: Function,
 *   releaseAuditIntegrityAlertDelivery: Function,
 * }} */
let claimApi = null;
let implementationMissing = true;

try {
  const mod = await import(PRODUCTION_MODULE_URL.href);
  if (
    typeof mod.claimAuditIntegrityAlertDelivery === 'function'
    && typeof mod.completeAuditIntegrityAlertDelivery === 'function'
    && typeof mod.releaseAuditIntegrityAlertDelivery === 'function'
    && typeof mod.AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_TTL_MS === 'number'
  ) {
    claimApi = {
      AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_TTL_MS:
        mod.AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_TTL_MS,
      claimAuditIntegrityAlertDelivery: mod.claimAuditIntegrityAlertDelivery,
      completeAuditIntegrityAlertDelivery: mod.completeAuditIntegrityAlertDelivery,
      releaseAuditIntegrityAlertDelivery: mod.releaseAuditIntegrityAlertDelivery,
    };
    implementationMissing = false;
  }
} catch (error) {
  const code = error && typeof error === 'object'
    ? /** @type {{ code?: string }} */ (error).code
    : undefined;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
    implementationMissing = true;
    claimApi = null;
  } else {
    throw error;
  }
}

/**
 * Exact narrow under-lease stream re-read surface (design: ensure outside queue,
 * re-read under active same-root lease). Named export only:
 *   readAuditIntegrityAlertDeliveryStreamUnderLease(resolvedRoot, lease)
 * Missing after coordinator exists → STREAM_READ_MISSING_MSG; never static import noise.
 * @type {null | Function}
 */
let streamReadApi = null;
try {
  const streamMod = await import(STREAM_MODULE_URL.href);
  if (typeof streamMod.readAuditIntegrityAlertDeliveryStreamUnderLease === 'function') {
    streamReadApi = streamMod.readAuditIntegrityAlertDeliveryStreamUnderLease;
  }
} catch {
  streamReadApi = null;
}

function requireApi() {
  if (implementationMissing || claimApi === null) {
    assert.fail(MISSING_MSG);
  }
  return /** @type {NonNullable<typeof claimApi>} */ (claimApi);
}

/**
 * Require the public under-lease stream-read export after the coordinator lands.
 * Forms a clear STREAM_READ_MISSING_MSG (no import noise). Only called from the
 * full matrix branch so old HEAD still has exactly one missing-coordinator failure.
 */
function requireStreamReadApi() {
  if (streamReadApi === null) {
    assert.fail(STREAM_READ_MISSING_MSG);
  }
  return streamReadApi;
}

/**
 * Capture FileHandle.prototype write path via a temporary open (repo test pattern).
 * Used only for scoped idle-claim write fault injection; always restored in finally.
 * @returns {Promise<{
 *   proto: object,
 *   originalWriteFile: Function,
 *   originalWrite: Function,
 * }>}
 */
async function captureFileHandleWritePath() {
  const probeRoot = await mkdtemp(join(tmpdir(), 'linke-delivery-claim-fh-'));
  try {
    const probePath = join(probeRoot, 'probe');
    const fh = await open(probePath, constants.O_CREAT | constants.O_RDWR, 0o600);
    try {
      const proto = Object.getPrototypeOf(fh);
      const originalWriteFile = proto.writeFile;
      const originalWrite = proto.write;
      assert.equal(typeof originalWriteFile, 'function');
      assert.equal(typeof originalWrite, 'function');
      return { proto, originalWriteFile, originalWrite };
    } finally {
      await fh.close();
    }
  } finally {
    await rm(probeRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Normalize FileHandle write / writeFile first-arg into utf8 text when possible.
 * @param {unknown} data
 * @returns {string | null}
 */
function payloadTextOrNull(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof Uint8Array) return Buffer.from(data).toString('utf8');
  return null;
}

async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(join(tmpdir(), `linke-delivery-claim-${prefix}-`));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function withLease(root, fn) {
  const resolvedRoot = await assertSafeDataRoot(root);
  return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => fn(resolvedRoot, lease));
}

function claimAbs(root) {
  return join(root, AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_RELATIVE_PATH);
}
function outboxAbs(root) {
  return join(root, AUDIT_INTEGRITY_ALERT_OUTBOX_RELATIVE_PATH);
}
function streamAbs(root) {
  return join(root, AUDIT_INTEGRITY_ALERT_DELIVERY_STREAM_RELATIVE_PATH);
}

function headEntry(sequence = 1, overrides = {}) {
  return {
    sequence,
    checkedAt: FIXED_CHECKED_AT,
    code: 'uninitialized',
    recoveryRequired: false,
    nextAction: 'initialize-via-production-write',
    reasonCode: null,
    ...overrides,
  };
}

function canonicalOutbox(nextSequence, entries) {
  return `${JSON.stringify({ schemaVersion: 1, nextSequence, entries })}\n`;
}

function canonicalStream(streamId) {
  return `${JSON.stringify({ schemaVersion: 1, streamId })}\n`;
}

async function writeOutbox(root, nextSequence, entries) {
  const abs = outboxAbs(root);
  await mkdir(dirname(abs), { recursive: true });
  const raw = canonicalOutbox(nextSequence, entries);
  await writeFile(abs, raw, { encoding: 'utf8', mode: 0o600 });
  return raw;
}

async function writeStream(root, streamId) {
  const abs = streamAbs(root);
  await mkdir(dirname(abs), { recursive: true });
  const raw = canonicalStream(streamId);
  await writeFile(abs, raw, { encoding: 'utf8', mode: 0o600 });
  return raw;
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function snapshotTree(root) {
  return {
    claim: await readOptional(claimAbs(root)),
    outbox: await readOptional(outboxAbs(root)),
    stream: await readOptional(streamAbs(root)),
  };
}

function assertDeeplyFrozen(value, path = 'root') {
  if (value === null || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value), `expected frozen at ${path}`);
  for (const key of Object.keys(value)) {
    assertDeeplyFrozen(/** @type {Record<string, unknown>} */ (value)[key], `${path}.${key}`);
  }
}

function assertExactKeys(obj, expected) {
  assert.deepEqual(Object.keys(obj), [...expected]);
}

/**
 * All public-boundary failures use path-free audit-delivery-unavailable.
 * @param {unknown} error
 * @param {string[]} [leakTokens]
 */
function assertUnavailable(error, leakTokens = []) {
  assert.equal(error && /** @type {{ name?: string }} */ (error).name, 'LinkeError');
  assert.equal(error && /** @type {{ code?: string }} */ (error).code, CODE_UNAVAILABLE);
  assert.equal(error && /** @type {{ message?: string }} */ (error).message, CODE_UNAVAILABLE);
  assert.equal(/** @type {{ cause?: unknown }} */ (error).cause, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(error, 'cause'));

  const publicParts = [
    /** @type {{ name: string }} */ (error).name,
    /** @type {{ code: string }} */ (error).code,
    /** @type {{ message: string }} */ (error).message,
    ...Object.keys(/** @type {object} */ (error))
      .filter((key) => key !== 'stack')
      .map((key) => String(/** @type {Record<string, unknown>} */ (error)[key])),
  ].join('\0');

  for (const token of [
    'ENOENT',
    'EACCES',
    'EPERM',
    'ELOOP',
    'errno',
    '/var/',
    '/private/',
    '/tmp/',
    'Users/',
    'SECRET',
    'integrity-alert-delivery-claim',
    'integrity-alert-outbox',
    CANONICAL_ENDPOINT,
    ...leakTokens,
  ]) {
    if (!token || token.length < 2) continue;
    assert.equal(publicParts.includes(token), false, `must not leak ${token}`);
  }
  return true;
}

function addMs(iso, ms) {
  return new Date(Date.parse(iso) + ms).toISOString();
}

/**
 * @returns {Promise<{
 *   ownerPid: number,
 *   bootSessionIdentity: { available: true, value: string },
 *   processStartIdentity: { available: true, value: string },
 * }>}
 */
async function realSelfIdentity() {
  const reader = createLaunchAgentProcessIdentityReader();
  const current = await reader.current();
  assert.equal(current.bootSessionIdentity.available, true);
  assert.equal(current.processStartIdentity.available, true);
  assert.equal(typeof current.bootSessionIdentity.value, 'string');
  assert.equal(typeof current.processStartIdentity.value, 'string');
  assert.equal(current.bootSessionIdentity.value.includes('/'), false);
  assert.equal(current.processStartIdentity.value.includes('/'), false);
  return {
    ownerPid: process.pid,
    bootSessionIdentity: {
      available: true,
      value: current.bootSessionIdentity.value,
    },
    processStartIdentity: {
      available: true,
      value: current.processStartIdentity.value,
    },
  };
}

function buildClaimedObject({
  claimId = CLAIM_ID_A,
  streamId = FIXED_STREAM_ID,
  sequence = 1,
  ownerPid,
  bootSessionIdentity,
  processStartIdentity,
  claimedAt = FIXED_NOW,
  expiresAt = addMs(FIXED_NOW, TTL_MS),
} = {}) {
  return {
    schemaVersion: 1,
    status: 'claimed',
    claimId,
    streamId,
    sequence,
    ownerPid,
    bootSessionIdentity,
    processStartIdentity,
    claimedAt,
    expiresAt,
  };
}

async function publishClaim(root, state) {
  return withLease(root, async (resolvedRoot, lease) => {
    return publishAuditIntegrityAlertDeliveryClaimState(resolvedRoot, lease, state);
  });
}

async function loadClaim(root) {
  return withLease(root, async (resolvedRoot, lease) => {
    return loadAuditIntegrityAlertDeliveryClaimState(resolvedRoot, lease);
  });
}

function capabilityOf(receiptOrState) {
  return {
    claimId: receiptOrState.claimId,
    streamId: receiptOrState.streamId,
    sequence: receiptOrState.sequence,
  };
}

function assertEmptyReceipt(receipt) {
  assertExactKeys(receipt, CLAIM_RECEIPT_KEYS);
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    status: 'empty',
    claimId: null,
    streamId: null,
    sequence: null,
    expiresAt: null,
    request: null,
  });
  assertDeeplyFrozen(receipt);
}

function assertBusyReceipt(receipt, { streamId, sequence, expiresAt }) {
  assertExactKeys(receipt, CLAIM_RECEIPT_KEYS);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.status, 'busy');
  assert.equal(receipt.claimId, null);
  assert.equal(receipt.streamId, streamId);
  assert.equal(receipt.sequence, sequence);
  assert.equal(receipt.expiresAt, expiresAt);
  assert.equal(receipt.request, null);
  assertDeeplyFrozen(receipt);
}

function assertClaimedReceipt(receipt, { streamId, sequence, expiresAt, endpoint, entry }) {
  assertExactKeys(receipt, CLAIM_RECEIPT_KEYS);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.status, 'claimed');
  assert.match(receipt.claimId, UUID_V4_RE);
  assert.equal(receipt.streamId, streamId);
  assert.equal(receipt.sequence, sequence);
  assert.equal(receipt.expiresAt, expiresAt);
  assertExactKeys(receipt.request, REQUEST_KEYS);
  const expected = buildAuditIntegrityAlertDeliveryRequest(endpoint, streamId, entry);
  assert.deepEqual(receipt.request, expected);
  assertDeeplyFrozen(receipt);
}

function assertCompletedReceipt(receipt, { status, streamId, sequence, pendingCount }) {
  assertExactKeys(receipt, COMPLETE_RECEIPT_KEYS);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.status, status);
  assert.equal(receipt.completed, true);
  assert.equal(receipt.streamId, streamId);
  assert.equal(receipt.sequence, sequence);
  assert.equal(receipt.pendingCount, pendingCount);
  assert.equal(Object.hasOwn(receipt, 'claimId'), false);
  assertDeeplyFrozen(receipt);
}

function assertReleasedReceipt(receipt, { streamId, sequence }) {
  assertExactKeys(receipt, RELEASE_RECEIPT_KEYS);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.status, 'released');
  assert.equal(receipt.released, true);
  assert.equal(receipt.streamId, streamId);
  assert.equal(receipt.sequence, sequence);
  assert.equal(Object.hasOwn(receipt, 'claimId'), false);
  assertDeeplyFrozen(receipt);
}

async function seedQueuedHead(root, {
  sequence = 1,
  nextSequence = sequence + 1,
  streamId = FIXED_STREAM_ID,
  entries,
} = {}) {
  const list = entries ?? [headEntry(sequence)];
  const outboxRaw = await writeOutbox(root, nextSequence, list);
  const streamRaw = await writeStream(root, streamId);
  return { outboxRaw, streamRaw, head: list[0], streamId };
}

/**
 * Contender lifecycle: bounded PREPARED/READY/RESULT/DONE, stderr empty, kill only recorded PIDs.
 * Optional startSignalPath enables parent START barrier (true same-origin multi-process race).
 * @param {string} mode
 * @param {string} dataDir
 * @param {string} endpoint
 * @param {string} now
 * @param {{ timeoutMs?: number, startSignalPath?: string | null }} [options]
 */
function spawnContender(mode, dataDir, endpoint, now, {
  timeoutMs = 20_000,
  startSignalPath = null,
} = {}) {
  const args = [CONTENDER_PATH, mode, dataDir, endpoint, now];
  if (startSignalPath !== null && startSignalPath !== undefined) {
    args.push(startSignalPath);
  }
  const child = spawn(
    process.execPath,
    args,
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
        TMPDIR: process.env.TMPDIR || tmpdir(),
      },
    },
  );

  const recordedPid = child.pid;
  assert.equal(typeof recordedPid, 'number');

  /** @type {string[]} */
  const stdoutLines = [];
  /** @type {Buffer[]} */
  const stderrChunks = [];
  let stdoutBuf = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line.length > 0) stdoutLines.push(line);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  /** @type {{ code: number | null, signal: string | null } | null} */
  let exitInfo = null;
  const exitPromise = new Promise((resolveExit) => {
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal };
      resolveExit(exitInfo);
    });
  });

  const deadline = Date.now() + timeoutMs;
  const killRecorded = async (signal = 'SIGKILL') => {
    if (recordedPid === undefined) return;
    try {
      process.kill(recordedPid, signal);
    } catch {
      // already gone
    }
  };

  const cleanup = async () => {
    if (exitInfo === null) {
      await killRecorded('SIGKILL');
      await Promise.race([exitPromise, delay(3000)]);
    }
  };

  /**
   * @param {string} line
   * @param {string} kind
   */
  const matchKind = (line, kind) => line.startsWith(`${kind} `) || line === kind;

  /**
   * @param {string} kind
   * @param {string} found
   */
  const parseLine = (kind, found) => {
    if (found === kind) return { kind, payload: null, raw: found };
    const json = found.slice(kind.length + 1);
    return { kind, payload: JSON.parse(json), raw: found };
  };

  /**
   * @param {'PREPARED' | 'READY' | 'RESULT' | 'DONE'} kind
   * @param {number} [waitMs]
   */
  const waitLine = async (kind, waitMs = timeoutMs) => {
    const start = Date.now();
    while (Date.now() - start < waitMs) {
      const found = stdoutLines.find((line) => matchKind(line, kind));
      if (found !== undefined) {
        return parseLine(kind, found);
      }
      if (exitInfo !== null && kind !== 'DONE') {
        throw new Error(`contender exited before ${kind}: code=${exitInfo.code} signal=${exitInfo.signal}`);
      }
      await delay(20);
    }
    throw new Error(`timeout waiting for ${kind}`);
  };

  /**
   * Wait until any of the given kinds appears (true concurrent race outcomes).
   * @param {Array<'PREPARED' | 'READY' | 'RESULT' | 'DONE'>} kinds
   * @param {number} [waitMs]
   */
  const waitAnyLine = async (kinds, waitMs = timeoutMs) => {
    const start = Date.now();
    while (Date.now() - start < waitMs) {
      for (const kind of kinds) {
        const found = stdoutLines.find((line) => matchKind(line, kind));
        if (found !== undefined) {
          return parseLine(kind, found);
        }
      }
      if (exitInfo !== null) {
        throw new Error(
          `contender exited before ${kinds.join('|')}: code=${exitInfo.code} signal=${exitInfo.signal}`,
        );
      }
      await delay(20);
    }
    throw new Error(`timeout waiting for any of ${kinds.join('|')}`);
  };

  return {
    child,
    pid: recordedPid,
    stdoutLines,
    stderrChunks,
    exitPromise,
    waitLine,
    waitAnyLine,
    killRecorded,
    cleanup,
    getExitInfo() {
      return exitInfo;
    },
    getStderrText() {
      return Buffer.concat(stderrChunks).toString('utf8');
    },
    get remainingMs() {
      return Math.max(0, deadline - Date.now());
    },
  };
}

// ─── Suite ───────────────────────────────────────────────────────────────

describe('audit integrity alert delivery claim (Task 3 RED)', () => {
  // Old-HEAD: exactly one dedicated RED. Full matrix only when exports exist.
  if (implementationMissing || claimApi === null) {
    it('delivery claim implementation missing', () => {
      assert.fail(MISSING_MSG);
    });
    return;
  }

  it('exports TTL 120000 and three coordinator functions', () => {
    // Break: wrong TTL or missing export breaks every expiry boundary and consumers.
    const api = requireApi();
    assert.equal(api.AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_TTL_MS, TTL_MS);
    assert.equal(typeof api.claimAuditIntegrityAlertDelivery, 'function');
    assert.equal(typeof api.completeAuditIntegrityAlertDelivery, 'function');
    assert.equal(typeof api.releaseAuditIntegrityAlertDelivery, 'function');
  });

  it('1 empty outbox → exact empty receipt; creates neither stream nor claim leaf', async () => {
    // Break: ensure-stream-on-empty or writing idle claim would create durable side effects.
    const api = requireApi();
    await withTempRoot('empty', async (root) => {
      const receipt = await api.claimAuditIntegrityAlertDelivery(
        root,
        CANONICAL_ENDPOINT,
        FIXED_NOW,
      );
      assertEmptyReceipt(receipt);
      await assert.rejects(() => access(streamAbs(root)), { code: 'ENOENT' });
      await assert.rejects(() => access(claimAbs(root)), { code: 'ENOENT' });
      await assert.rejects(() => access(outboxAbs(root)), { code: 'ENOENT' });
    });
  });

  it('1b non-empty outbox + missing stream + missing claim → ensure mode0600 stable stream and claimed', async () => {
    // Break: accepting only pre-written stream (no ensure) leaves stream leaf absent or fails claim
    // while a correct coordinator must create one stable canonical stream identity on non-empty FIFO.
    const api = requireApi();
    await withTempRoot('ensure-stream', async (root) => {
      const entry = headEntry(7);
      await writeOutbox(root, 8, [entry]);
      await assert.rejects(() => access(streamAbs(root)), { code: 'ENOENT' });
      await assert.rejects(() => access(claimAbs(root)), { code: 'ENOENT' });

      const receipt = await api.claimAuditIntegrityAlertDelivery(
        root,
        CANONICAL_ENDPOINT,
        FIXED_NOW,
      );
      assert.equal(receipt.status, 'claimed');
      assert.match(receipt.streamId, UUID_V4_RE);
      assert.equal(receipt.sequence, 7);
      assert.equal(receipt.expiresAt, addMs(FIXED_NOW, TTL_MS));
      assertExactKeys(receipt.request, REQUEST_KEYS);
      const expectedRequest = buildAuditIntegrityAlertDeliveryRequest(
        CANONICAL_ENDPOINT,
        receipt.streamId,
        entry,
      );
      assert.deepEqual(receipt.request, expectedRequest);
      assertDeeplyFrozen(receipt);

      const st = await lstat(streamAbs(root));
      assert.equal(st.isFile(), true);
      assert.equal(st.isSymbolicLink(), false);
      assert.equal(st.mode & 0o777, 0o600);
      const streamRaw = await readFile(streamAbs(root), 'utf8');
      assert.equal(streamRaw, canonicalStream(receipt.streamId));

      const loaded = await loadClaim(root);
      assert.equal(loaded.status, 'claimed');
      assert.equal(loaded.streamId, receipt.streamId);
      assert.equal(loaded.claimId, receipt.claimId);
      assert.equal(loaded.sequence, 7);

      // Second claim while live owner → busy with same streamId (stable identity, no rewrite).
      const busy = await api.claimAuditIntegrityAlertDelivery(
        root,
        CANONICAL_ENDPOINT,
        addMs(FIXED_NOW, 1),
      );
      assertBusyReceipt(busy, {
        streamId: receipt.streamId,
        sequence: 7,
        expiresAt: receipt.expiresAt,
      });
      assert.equal(await readFile(streamAbs(root), 'utf8'), streamRaw);
    });
  });

  it('1c under-lease stream read: exact frozen {schemaVersion,streamId}; bad leases unavailable', async () => {
    // Break: missing/public-without-lease stream read or accepting forged/expired leases would
    // let workers re-read stream without write admission or hide stream-read absence as import noise.
    const readStream = requireStreamReadApi();
    await withTempRoot('stream-read-ok', async (root) => {
      await writeStream(root, FIXED_STREAM_ID);
      await withLease(root, async (resolvedRoot, lease) => {
        const state = await readStream(resolvedRoot, lease);
        assert.deepEqual(Object.keys(state), ['schemaVersion', 'streamId']);
        assert.deepEqual(state, { schemaVersion: 1, streamId: FIXED_STREAM_ID });
        assertDeeplyFrozen(state);
      });
    });

    await withTempRoot('stream-read-missing-leaf', async (root) => {
      await withLease(root, async (resolvedRoot, lease) => {
        // Missing leaf must not invent a streamId: null or fixed unavailable both OK.
        let saw = null;
        try {
          saw = await readStream(resolvedRoot, lease);
        } catch (error) {
          assertUnavailable(error, [root]);
          return;
        }
        assert.equal(saw, null);
      });
    });

    await withTempRoot('stream-read-corrupt', async (root) => {
      await mkdir(join(root, 'audit'), { recursive: true });
      await writeFile(streamAbs(root), '{"schemaVersion":1}\n', { mode: 0o600 });
      await withLease(root, async (resolvedRoot, lease) => {
        await assert.rejects(
          () => readStream(resolvedRoot, lease),
          (error) => assertUnavailable(error, [root]),
        );
      });
    });

    // missing / forged lease (no active queue context)
    await withTempRoot('stream-read-forged-lease', async (root) => {
      await writeStream(root, FIXED_STREAM_ID);
      const resolvedRoot = await assertSafeDataRoot(root);
      const forged = Object.freeze({});
      for (const lease of [null, undefined, forged, Object.freeze({ forged: true })]) {
        await assert.rejects(
          () => readStream(resolvedRoot, lease),
          (error) => assertUnavailable(error, [root, 'forged']),
        );
      }
    });

    // wrong-root lease: active lease for B used against A
    await withTempRoot('stream-read-wrong-root-a', async (rootA) => {
      await withTempRoot('stream-read-wrong-root-b', async (rootB) => {
        await writeStream(rootA, FIXED_STREAM_ID);
        await writeStream(rootB, OTHER_STREAM_ID);
        await withLease(rootB, async (_resolvedB, leaseB) => {
          const resolvedA = await assertSafeDataRoot(rootA);
          await assert.rejects(
            () => readStream(resolvedA, leaseB),
            (error) => assertUnavailable(error, [rootA, rootB]),
          );
        });
      });
    });

    // expired lease: capture lease identity then use after task settles
    await withTempRoot('stream-read-expired-lease', async (root) => {
      await writeStream(root, FIXED_STREAM_ID);
      const resolvedRoot = await assertSafeDataRoot(root);
      /** @type {object | null} */
      let expiredLease = null;
      await withLease(root, async (_rr, lease) => {
        expiredLease = lease;
      });
      assert.notEqual(expiredLease, null);
      await assert.rejects(
        () => readStream(resolvedRoot, expiredLease),
        (error) => assertUnavailable(error, [root]),
      );
    });
  });

  it('2 first claim: pure request then exact claimed bytes mode 0600; identity from real process', async () => {
    // Break: writing claim before request, wrong TTL, non-real owner identity, or non-canonical bytes.
    const api = requireApi();
    await withTempRoot('first-claim', async (root) => {
      const self = await realSelfIdentity();
      const entry = headEntry(3);
      await seedQueuedHead(root, { sequence: 3, nextSequence: 4, entries: [entry] });
      const before = await snapshotTree(root);

      const receipt = await api.claimAuditIntegrityAlertDelivery(
        root,
        CANONICAL_ENDPOINT,
        FIXED_NOW,
      );
      assertClaimedReceipt(receipt, {
        streamId: FIXED_STREAM_ID,
        sequence: 3,
        expiresAt: addMs(FIXED_NOW, TTL_MS),
        endpoint: CANONICAL_ENDPOINT,
        entry,
      });

      const st = await lstat(claimAbs(root));
      assert.equal(st.isFile(), true);
      assert.equal(st.isSymbolicLink(), false);
      assert.equal(st.mode & 0o777, 0o600);

      const loaded = await loadClaim(root);
      assert.equal(loaded.status, 'claimed');
      assert.equal(loaded.claimId, receipt.claimId);
      assert.equal(loaded.streamId, FIXED_STREAM_ID);
      assert.equal(loaded.sequence, 3);
      assert.equal(loaded.ownerPid, self.ownerPid);
      assert.equal(loaded.bootSessionIdentity.value, self.bootSessionIdentity.value);
      assert.equal(loaded.processStartIdentity.value, self.processStartIdentity.value);
      assert.equal(loaded.claimedAt, FIXED_NOW);
      assert.equal(loaded.expiresAt, addMs(FIXED_NOW, TTL_MS));
      assert.match(loaded.claimId, UUID_V4_RE);

      // Outbox/stream bytes unchanged by claim publish.
      assert.equal(await readFile(outboxAbs(root), 'utf8'), before.outbox);
      assert.equal(await readFile(streamAbs(root), 'utf8'), before.stream);

      // Exact canonical claim bytes (order + single trailing newline).
      const claimRaw = await readFile(claimAbs(root), 'utf8');
      assert.equal(claimRaw, `${JSON.stringify({
        schemaVersion: 1,
        status: 'claimed',
        claimId: loaded.claimId,
        streamId: loaded.streamId,
        sequence: loaded.sequence,
        ownerPid: loaded.ownerPid,
        bootSessionIdentity: {
          available: true,
          value: loaded.bootSessionIdentity.value,
        },
        processStartIdentity: {
          available: true,
          value: loaded.processStartIdentity.value,
        },
        claimedAt: loaded.claimedAt,
        expiresAt: loaded.expiresAt,
      })}\n`);
    });
  });

  it('3 live owner time matrix: expiresAt-1 busy; expiresAt/+1 replace; clock rollback busy; no claimId leak', async () => {
    // Break: treating wall expiry as soft, leaking claimId on busy, or mutating on busy.
    const api = requireApi();
    await withTempRoot('live-time', async (root) => {
      const self = await realSelfIdentity();
      const entry = headEntry(1);
      await seedQueuedHead(root, { sequence: 1, entries: [entry] });
      const claimedAt = FIXED_NOW;
      const expiresAt = addMs(claimedAt, TTL_MS);
      const first = await api.claimAuditIntegrityAlertDelivery(
        root,
        CANONICAL_ENDPOINT,
        claimedAt,
      );
      assert.equal(first.status, 'claimed');
      const claimBytes = await readFile(claimAbs(root));
      const outboxBytes = await readFile(outboxAbs(root));

      const busyCases = [
        { name: 'expiresAt-1', now: addMs(expiresAt, -1) },
        { name: 'clock-rollback', now: addMs(claimedAt, -1) },
      ];
      for (const { name, now } of busyCases) {
        const busy = await api.claimAuditIntegrityAlertDelivery(
          root,
          CANONICAL_ENDPOINT,
          now,
        );
        assertBusyReceipt(busy, {
          streamId: FIXED_STREAM_ID,
          sequence: 1,
          expiresAt,
        });
        assert.equal(busy.claimId, null, `${name} must not leak claimId`);
        assert.deepEqual(await readFile(claimAbs(root)), claimBytes, `${name} claim bytes`);
        assert.deepEqual(await readFile(outboxAbs(root)), outboxBytes, `${name} outbox bytes`);
      }

      for (const { name, now } of [
        { name: 'at-expiry', now: expiresAt },
        { name: 'after-expiry', now: addMs(expiresAt, 1) },
      ]) {
        // Re-seed live claim as self for each replace boundary.
        await publishClaim(root, buildClaimedObject({
          claimId: CLAIM_ID_A,
          sequence: 1,
          ownerPid: self.ownerPid,
          bootSessionIdentity: self.bootSessionIdentity,
          processStartIdentity: self.processStartIdentity,
          claimedAt,
          expiresAt,
        }));
        const replaced = await api.claimAuditIntegrityAlertDelivery(
          root,
          CANONICAL_ENDPOINT,
          now,
        );
        assert.equal(replaced.status, 'claimed', name);
        assert.notEqual(replaced.claimId, CLAIM_ID_A, name);
        assert.equal(replaced.expiresAt, addMs(now, TTL_MS), name);
        const loaded = await loadClaim(root);
        assert.equal(loaded.claimId, replaced.claimId);
        assert.equal(loaded.ownerPid, self.ownerPid);
      }
    });
  });

  it('4 dead / pid-reused / boot-mismatch replace immediately; unavailable fails closed (locked kill EPERM)', async () => {
    // Break: waiting for wall expiry on dead/reused/reboot, or reclaiming when observe is unavailable.
    const api = requireApi();
    const self = await realSelfIdentity();
    const claimedAt = FIXED_NOW;
    const expiresAt = addMs(claimedAt, TTL_MS);
    // Far-future wall window so only liveness can authorize replace.
    const farExpires = '2099-01-01T00:02:00.000Z';
    const farClaimed = '2099-01-01T00:00:00.000Z';

    // dead: real child owner, SIGKILL, then parent reclaims before wall expiry.
    await withTempRoot('owner-dead', async (root) => {
      await seedQueuedHead(root, { sequence: 1 });
      const holder = spawnContender(
        'claim-hold',
        root,
        CANONICAL_ENDPOINT,
        farClaimed,
        { timeoutMs: 25_000 },
      );
      try {
        const ready = await holder.waitLine('READY', 15_000);
        assert.equal(ready.payload.status, 'claimed');
        assert.equal(ready.payload.pid, holder.pid);
        const claimBeforeKill = await readFile(claimAbs(root), 'utf8');
        assert.equal(JSON.parse(claimBeforeKill).ownerPid, holder.pid);

        await holder.killRecorded('SIGKILL');
        await holder.exitPromise;

        const reclaimNow = '2099-01-01T00:00:01.000Z'; // still before farExpires
        assert.equal(Date.parse(reclaimNow) < Date.parse(farExpires), true);
        const reclaimed = await api.claimAuditIntegrityAlertDelivery(
          root,
          CANONICAL_ENDPOINT,
          reclaimNow,
        );
        assert.equal(reclaimed.status, 'claimed');
        assert.notEqual(reclaimed.claimId, ready.payload.claimId);
        const loaded = await loadClaim(root);
        assert.equal(loaded.ownerPid, process.pid);
        assert.equal(loaded.claimId, reclaimed.claimId);
      } finally {
        await holder.cleanup();
        assert.equal(holder.getStderrText(), '');
      }
    });

    // pid-reused: live self PID with foreign processStartIdentity.
    await withTempRoot('pid-reused', async (root) => {
      await seedQueuedHead(root, { sequence: 1 });
      await publishClaim(root, buildClaimedObject({
        claimId: CLAIM_ID_A,
        ownerPid: self.ownerPid,
        bootSessionIdentity: self.bootSessionIdentity,
        processStartIdentity: {
          available: true,
          value: 'process-start-sha256-ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        },
        claimedAt: farClaimed,
        expiresAt: farExpires,
      }));
      const beforeOutbox = await readFile(outboxAbs(root));
      const receipt = await api.claimAuditIntegrityAlertDelivery(
        root,
        CANONICAL_ENDPOINT,
        '2099-01-01T00:00:01.000Z',
      );
      assert.equal(receipt.status, 'claimed');
      assert.notEqual(receipt.claimId, CLAIM_ID_A);
      assert.deepEqual(await readFile(outboxAbs(root)), beforeOutbox);
    });

    // boot-session-mismatch: foreign boot digest with live PID.
    await withTempRoot('boot-mismatch', async (root) => {
      await seedQueuedHead(root, { sequence: 1 });
      await publishClaim(root, buildClaimedObject({
        claimId: CLAIM_ID_A,
        ownerPid: self.ownerPid,
        bootSessionIdentity: {
          available: true,
          value: 'boot-sha256-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        },
        processStartIdentity: self.processStartIdentity,
        claimedAt: farClaimed,
        expiresAt: farExpires,
      }));
      const receipt = await api.claimAuditIntegrityAlertDelivery(
        root,
        CANONICAL_ENDPOINT,
        '2099-01-01T00:00:01.000Z',
      );
      assert.equal(receipt.status, 'claimed');
      assert.notEqual(receipt.claimId, CLAIM_ID_A);
    });

    // unavailable: locked test-only process.kill EPERM for signal 0 on fixture ownerPid only.
    // Does not mock production modules; restores process.kill in finally.
    await withTempRoot('observe-unavailable', async (root) => {
      await seedQueuedHead(root, { sequence: 1 });
      await publishClaim(root, buildClaimedObject({
        claimId: CLAIM_ID_A,
        ownerPid: self.ownerPid,
        bootSessionIdentity: self.bootSessionIdentity,
        processStartIdentity: self.processStartIdentity,
        claimedAt,
        expiresAt,
      }));
      const before = await snapshotTree(root);
      const realKill = process.kill;
      process.kill = function killUnavailable(pid, signal) {
        if (pid === self.ownerPid && (signal === 0 || signal === 'SIG0')) {
          const err = new Error('not permitted');
          /** @type {NodeJS.ErrnoException} */ (err).code = 'EPERM';
          throw err;
        }
        return realKill.call(process, pid, signal);
      };
      try {
        await assert.rejects(
          () => api.claimAuditIntegrityAlertDelivery(root, CANONICAL_ENDPOINT, claimedAt),
          (error) => assertUnavailable(error, [root, String(self.ownerPid), CLAIM_ID_A]),
        );
        assert.deepEqual(await snapshotTree(root), before);
      } finally {
        process.kill = realKill;
      }
    });
  });

  it('5 complete exact head: lease-guarded ack then idle; release only claim→idle', async () => {
    // Break: wrong write order, removing >1 head, echoing claimId, or release mutating outbox.
    const api = requireApi();

    await withTempRoot('complete-head', async (root) => {
      const e1 = headEntry(5);
      const e2 = headEntry(6);
      await seedQueuedHead(root, {
        sequence: 5,
        nextSequence: 7,
        entries: [e1, e2],
      });
      const claimed = await api.claimAuditIntegrityAlertDelivery(
        root,
        CANONICAL_ENDPOINT,
        FIXED_NOW,
      );
      assert.equal(claimed.status, 'claimed');
      const cap = capabilityOf(claimed);
      assertExactKeys(cap, CAPABILITY_KEYS);

      const completed = await api.completeAuditIntegrityAlertDelivery(root, cap);
      assertCompletedReceipt(completed, {
        status: 'completed',
        streamId: FIXED_STREAM_ID,
        sequence: 5,
        pendingCount: 1,
      });

      const outbox = await readAuditIntegrityAlertOutbox(root);
      assert.deepEqual(outbox.entries.map((e) => e.sequence), [6]);
      assert.equal(outbox.nextSequence, 7);
      const claimState = await loadClaim(root);
      assert.equal(claimState.status, 'idle');
      assert.equal(await readFile(claimAbs(root), 'utf8'), CANONICAL_IDLE_CLAIM_BYTES);
    });

    await withTempRoot('release-only', async (root) => {
      const entry = headEntry(2);
      const { outboxRaw } = await seedQueuedHead(root, { sequence: 2, entries: [entry] });
      const claimed = await api.claimAuditIntegrityAlertDelivery(
        root,
        CANONICAL_ENDPOINT,
        FIXED_NOW,
      );
      const released = await api.releaseAuditIntegrityAlertDelivery(
        root,
        capabilityOf(claimed),
      );
      assertReleasedReceipt(released, {
        streamId: FIXED_STREAM_ID,
        sequence: 2,
      });
      assert.equal(await readFile(outboxAbs(root), 'utf8'), outboxRaw);
      assert.equal(await readFile(claimAbs(root), 'utf8'), CANONICAL_IDLE_CLAIM_BYTES);
    });
  });

  it('6 stale fencing: after B replaces A, A complete/release fail; B/outbox bytes unchanged', async () => {
    // Break: accepting stale capability would let a late worker fence-bypass the successor.
    const api = requireApi();
    await withTempRoot('stale-fence', async (root) => {
      const self = await realSelfIdentity();
      await seedQueuedHead(root, { sequence: 1 });
      const claimedAt = FIXED_NOW;
      const expiresAt = addMs(claimedAt, TTL_MS);
      await publishClaim(root, buildClaimedObject({
        claimId: CLAIM_ID_A,
        ownerPid: self.ownerPid,
        bootSessionIdentity: self.bootSessionIdentity,
        processStartIdentity: self.processStartIdentity,
        claimedAt,
        expiresAt,
      }));
      const staleCap = {
        claimId: CLAIM_ID_A,
        streamId: FIXED_STREAM_ID,
        sequence: 1,
      };

      const successor = await api.claimAuditIntegrityAlertDelivery(
        root,
        CANONICAL_ENDPOINT,
        expiresAt,
      );
      assert.equal(successor.status, 'claimed');
      assert.notEqual(successor.claimId, CLAIM_ID_A);
      const afterB = await snapshotTree(root);

      await assert.rejects(
        () => api.completeAuditIntegrityAlertDelivery(root, staleCap),
        (error) => assertUnavailable(error, [CLAIM_ID_A, root]),
      );
      assert.deepEqual(await snapshotTree(root), afterB);

      await assert.rejects(
        () => api.releaseAuditIntegrityAlertDelivery(root, staleCap),
        (error) => assertUnavailable(error, [CLAIM_ID_A, root]),
      );
      assert.deepEqual(await snapshotTree(root), afterB);

      // Successor capability still works for release.
      const released = await api.releaseAuditIntegrityAlertDelivery(
        root,
        capabilityOf(successor),
      );
      assert.equal(released.status, 'released');
    });
  });

  it('7 post-ack residual (manual): already-completed clears idle only; preserves successor', async () => {
    // Break: residual complete that deletes successor head, or leaves claimed after already-completed.
    // Manual residual is second evidence for recovery classification only (not first complete write order).
    const api = requireApi();
    await withTempRoot('post-ack-residual', async (root) => {
      const self = await realSelfIdentity();
      const e1 = headEntry(10);
      const e2 = headEntry(11);
      await seedQueuedHead(root, {
        sequence: 10,
        nextSequence: 12,
        entries: [e1, e2],
      });

      // Simulate successful head ack with claim still claimed for sequence 10.
      await withLease(root, async (resolvedRoot, lease) => {
        const ack = await acknowledgeAuditIntegrityAlertOutboxHeadUnderLease(
          resolvedRoot,
          lease,
          10,
        );
        assert.equal(ack.acknowledged, true);
        await publishAuditIntegrityAlertDeliveryClaimState(
          resolvedRoot,
          lease,
          buildClaimedObject({
            claimId: CLAIM_ID_A,
            sequence: 10,
            ownerPid: self.ownerPid,
            bootSessionIdentity: self.bootSessionIdentity,
            processStartIdentity: self.processStartIdentity,
            claimedAt: FIXED_NOW,
            expiresAt: addMs(FIXED_NOW, TTL_MS),
          }),
        );
      });

      const outboxBefore = await readFile(outboxAbs(root), 'utf8');
      const outboxState = await readAuditIntegrityAlertOutbox(root);
      assert.deepEqual(outboxState.entries.map((e) => e.sequence), [11]);

      const residual = await api.completeAuditIntegrityAlertDelivery(root, {
        claimId: CLAIM_ID_A,
        streamId: FIXED_STREAM_ID,
        sequence: 10,
      });
      assertCompletedReceipt(residual, {
        status: 'already-completed',
        streamId: FIXED_STREAM_ID,
        sequence: 10,
        pendingCount: 1,
      });
      assert.equal(await readFile(outboxAbs(root), 'utf8'), outboxBefore);
      assert.equal(await readFile(claimAbs(root), 'utf8'), CANONICAL_IDLE_CLAIM_BYTES);

      // Empty outbox residual: claim.sequence < nextSequence with no entries.
      await withLease(root, async (resolvedRoot, lease) => {
        await acknowledgeAuditIntegrityAlertOutboxHeadUnderLease(resolvedRoot, lease, 11);
        await publishAuditIntegrityAlertDeliveryClaimState(
          resolvedRoot,
          lease,
          buildClaimedObject({
            claimId: CLAIM_ID_B,
            sequence: 11,
            ownerPid: self.ownerPid,
            bootSessionIdentity: self.bootSessionIdentity,
            processStartIdentity: self.processStartIdentity,
            claimedAt: FIXED_NOW,
            expiresAt: addMs(FIXED_NOW, TTL_MS),
          }),
        );
      });
      const emptyResidual = await api.completeAuditIntegrityAlertDelivery(root, {
        claimId: CLAIM_ID_B,
        streamId: FIXED_STREAM_ID,
        sequence: 11,
      });
      assertCompletedReceipt(emptyResidual, {
        status: 'already-completed',
        streamId: FIXED_STREAM_ID,
        sequence: 11,
        pendingCount: 0,
      });
      const emptyOutbox = await readAuditIntegrityAlertOutbox(root);
      assert.equal(emptyOutbox.entries.length, 0);
      assert.equal(emptyOutbox.nextSequence, 12);
      assert.equal(await readFile(claimAbs(root), 'utf8'), CANONICAL_IDLE_CLAIM_BYTES);
    });
  });

  it('7b real complete crash: idle-claim FileHandle write fault after outbox ack; second complete already-completed', async () => {
    // Break: reversed write order (idle before outbox) or swallowing idle-write failure would either
    // lose head A without residual evidence, or leave no recoverable post-ack residual for retry.
    // Scoped monkeypatch of real FileHandle write path only when payload === canonical idle claim
    // bytes; outbox JSON never matches so lease-guarded head publish must succeed first.
    // No production hooks; no coordinator/claim-state/outbox mocks; capability shape unchanged.
    const api = requireApi();
    await withTempRoot('real-crash-complete', async (root) => {
      const self = await realSelfIdentity();
      const eA = headEntry(20);
      const eB = headEntry(21);
      await seedQueuedHead(root, {
        sequence: 20,
        nextSequence: 22,
        entries: [eA, eB],
      });
      const claimedState = buildClaimedObject({
        claimId: CLAIM_ID_A,
        sequence: 20,
        ownerPid: self.ownerPid,
        bootSessionIdentity: self.bootSessionIdentity,
        processStartIdentity: self.processStartIdentity,
        claimedAt: FIXED_NOW,
        expiresAt: addMs(FIXED_NOW, TTL_MS),
      });
      await publishClaim(root, claimedState);
      const claimRawBefore = await readFile(claimAbs(root), 'utf8');
      assert.equal(JSON.parse(claimRawBefore).claimId, CLAIM_ID_A);
      assert.equal(JSON.parse(claimRawBefore).sequence, 20);

      const capA = {
        claimId: CLAIM_ID_A,
        streamId: FIXED_STREAM_ID,
        sequence: 20,
      };

      const captured = await captureFileHandleWritePath();
      const { proto, originalWriteFile, originalWrite } = captured;
      const faultError = new Error('test-only idle claim write fault');
      /** @type {NodeJS.ErrnoException} */ (faultError).code = 'TEST_IDLE_CLAIM_WRITE_FAULT';
      let idleFaultHits = 0;

      proto.writeFile = async function patchedWriteFile(data, options) {
        const text = payloadTextOrNull(data);
        if (text === CANONICAL_IDLE_CLAIM_BYTES) {
          idleFaultHits += 1;
          throw faultError;
        }
        return originalWriteFile.apply(this, arguments);
      };
      proto.write = function patchedWrite(data, ...rest) {
        const text = payloadTextOrNull(data);
        if (text === CANONICAL_IDLE_CLAIM_BYTES) {
          idleFaultHits += 1;
          throw faultError;
        }
        return originalWrite.apply(this, [data, ...rest]);
      };

      try {
        await assert.rejects(
          () => api.completeAuditIntegrityAlertDelivery(root, capA),
          (error) => assertUnavailable(error, [
            root,
            CLAIM_ID_A,
            'TEST_IDLE_CLAIM_WRITE_FAULT',
            'test-only idle claim write fault',
          ]),
        );
        assert.ok(idleFaultHits >= 1, 'idle claim write path must have been faulted');

        // Real residual evidence: head advanced to B, claim still exact A, bytes/nextSequence legal.
        const outboxAfterFault = await readAuditIntegrityAlertOutbox(root);
        assert.deepEqual(outboxAfterFault.entries.map((e) => e.sequence), [21]);
        assert.equal(outboxAfterFault.nextSequence, 22);
        assert.deepEqual(outboxAfterFault.entries[0], eB);
        const outboxRaw = await readFile(outboxAbs(root), 'utf8');
        assert.equal(outboxRaw, canonicalOutbox(22, [eB]));

        const claimAfterFault = await loadClaim(root);
        assert.equal(claimAfterFault.status, 'claimed');
        assert.equal(claimAfterFault.claimId, CLAIM_ID_A);
        assert.equal(claimAfterFault.streamId, FIXED_STREAM_ID);
        assert.equal(claimAfterFault.sequence, 20);
        assert.equal(await readFile(claimAbs(root), 'utf8'), claimRawBefore);
        assert.equal(await readFile(streamAbs(root), 'utf8'), canonicalStream(FIXED_STREAM_ID));
      } finally {
        // Unconditional restore — no fd/global pollution across the suite.
        proto.writeFile = originalWriteFile;
        proto.write = originalWrite;
      }

      // Second real complete(capA) recovers residual: already-completed, claim→idle, B preserved.
      const second = await api.completeAuditIntegrityAlertDelivery(root, capA);
      assertCompletedReceipt(second, {
        status: 'already-completed',
        streamId: FIXED_STREAM_ID,
        sequence: 20,
        pendingCount: 1,
      });
      assert.equal(await readFile(claimAbs(root), 'utf8'), CANONICAL_IDLE_CLAIM_BYTES);
      const outboxFinal = await readAuditIntegrityAlertOutbox(root);
      assert.deepEqual(outboxFinal.entries.map((e) => e.sequence), [21]);
      assert.equal(outboxFinal.nextSequence, 22);
      assert.equal(await readFile(outboxAbs(root), 'utf8'), canonicalOutbox(22, [eB]));
      assert.equal(await readFile(streamAbs(root), 'utf8'), canonicalStream(FIXED_STREAM_ID));
    });
  });

  it('8 impossible relation fail closed: claim.sequence>head or empty nextSequence<=claim.sequence', async () => {
    // Break: guessing through ambiguous sequence relations would corrupt FIFO.
    const api = requireApi();
    const self = await realSelfIdentity();

    await withTempRoot('seq-gt-head', async (root) => {
      await seedQueuedHead(root, { sequence: 1, nextSequence: 2, entries: [headEntry(1)] });
      await publishClaim(root, buildClaimedObject({
        claimId: CLAIM_ID_A,
        sequence: 9,
        ownerPid: self.ownerPid,
        bootSessionIdentity: self.bootSessionIdentity,
        processStartIdentity: self.processStartIdentity,
      }));
      const before = await snapshotTree(root);
      await assert.rejects(
        () => api.completeAuditIntegrityAlertDelivery(root, {
          claimId: CLAIM_ID_A,
          streamId: FIXED_STREAM_ID,
          sequence: 9,
        }),
        (error) => assertUnavailable(error, [root, CLAIM_ID_A]),
      );
      await assert.rejects(
        () => api.claimAuditIntegrityAlertDelivery(root, CANONICAL_ENDPOINT, FIXED_NOW),
        (error) => assertUnavailable(error, [root]),
      );
      assert.deepEqual(await snapshotTree(root), before);
    });

    await withTempRoot('empty-next-le', async (root) => {
      // Empty outbox, nextSequence=5, claim.sequence=5 → nextSequence <= claim.sequence impossible.
      await writeOutbox(root, 5, []);
      await writeStream(root, FIXED_STREAM_ID);
      await publishClaim(root, buildClaimedObject({
        claimId: CLAIM_ID_A,
        sequence: 5,
        ownerPid: self.ownerPid,
        bootSessionIdentity: self.bootSessionIdentity,
        processStartIdentity: self.processStartIdentity,
      }));
      const before = await snapshotTree(root);
      await assert.rejects(
        () => api.completeAuditIntegrityAlertDelivery(root, {
          claimId: CLAIM_ID_A,
          streamId: FIXED_STREAM_ID,
          sequence: 5,
        }),
        (error) => assertUnavailable(error, [root]),
      );
      assert.deepEqual(await snapshotTree(root), before);
    });
  });

  it('9 fail-closed matrix: stream drift/missing/corrupt, corrupt claim/outbox, hostile capability, nested enqueue', async () => {
    // Break: any loose parse or partial mutation under hostile inputs.
    const api = requireApi();
    const self = await realSelfIdentity();

    /** @type {Array<{ name: string, run: (root: string) => Promise<void> }>} */
    const cases = [
      {
        name: 'stream-drift-on-complete',
        run: async (root) => {
          await seedQueuedHead(root, { sequence: 1, streamId: FIXED_STREAM_ID });
          const claimed = await api.claimAuditIntegrityAlertDelivery(
            root,
            CANONICAL_ENDPOINT,
            FIXED_NOW,
          );
          await writeStream(root, OTHER_STREAM_ID);
          const before = await snapshotTree(root);
          await assert.rejects(
            () => api.completeAuditIntegrityAlertDelivery(root, capabilityOf(claimed)),
            (error) => assertUnavailable(error, [root, OTHER_STREAM_ID]),
          );
          assert.deepEqual(await snapshotTree(root), before);
        },
      },
      {
        name: 'stream-missing-after-ensure',
        run: async (root) => {
          await seedQueuedHead(root, { sequence: 1 });
          await rm(streamAbs(root));
          const before = await snapshotTree(root);
          // claim will try ensure/re-read; if stream is recreated by ensure that is OK only when
          // missing is recoverable. Design: missing-after-ensure under lease fails closed when
          // ensure already observed identity that then disappears. Here leaf is absent before claim:
          // ensure may recreate — so instead: claim succeeds first, then delete stream mid-flight via
          // residual: claimed with stream file removed before second claim.
          const claimed = await api.claimAuditIntegrityAlertDelivery(
            root,
            CANONICAL_ENDPOINT,
            FIXED_NOW,
          );
          assert.equal(claimed.status, 'claimed');
          await rm(streamAbs(root));
          const mid = await snapshotTree(root);
          await assert.rejects(
            () => api.claimAuditIntegrityAlertDelivery(
              root,
              CANONICAL_ENDPOINT,
              addMs(FIXED_NOW, 1),
            ),
            (error) => assertUnavailable(error, [root]),
          );
          // Ensure may recreate stream; claim bytes must not silently swap to a new owner
          // without going through replace rules. Accept fail-closed with claim unchanged or
          // stream recreated-only without claim mutation.
          const after = await snapshotTree(root);
          assert.equal(after.claim, mid.claim);
          assert.equal(after.outbox, mid.outbox);
          void before;
        },
      },
      {
        name: 'corrupt-stream',
        run: async (root) => {
          await writeOutbox(root, 2, [headEntry(1)]);
          await mkdir(join(root, 'audit'), { recursive: true });
          const bad = '{"schemaVersion":1,"streamId":"not-a-uuid"}\n';
          await writeFile(streamAbs(root), bad, { mode: 0o600 });
          const before = await snapshotTree(root);
          await assert.rejects(
            () => api.claimAuditIntegrityAlertDelivery(root, CANONICAL_ENDPOINT, FIXED_NOW),
            (error) => assertUnavailable(error, [root, bad.slice(0, 20)]),
          );
          assert.deepEqual(await snapshotTree(root), before);
        },
      },
      {
        name: 'corrupt-claim',
        run: async (root) => {
          await seedQueuedHead(root, { sequence: 1 });
          await mkdir(join(root, 'audit'), { recursive: true });
          const bad = '{not-json\n';
          await writeFile(claimAbs(root), bad, { mode: 0o600 });
          const before = await snapshotTree(root);
          await assert.rejects(
            () => api.claimAuditIntegrityAlertDelivery(root, CANONICAL_ENDPOINT, FIXED_NOW),
            (error) => assertUnavailable(error, [root]),
          );
          assert.deepEqual(await snapshotTree(root), before);
        },
      },
      {
        name: 'corrupt-outbox',
        run: async (root) => {
          await writeStream(root, FIXED_STREAM_ID);
          await mkdir(join(root, 'audit'), { recursive: true });
          const bad = '{"schemaVersion":1}\n';
          await writeFile(outboxAbs(root), bad, { mode: 0o600 });
          const before = await snapshotTree(root);
          await assert.rejects(
            () => api.claimAuditIntegrityAlertDelivery(root, CANONICAL_ENDPOINT, FIXED_NOW),
            (error) => assertUnavailable(error, [root]),
          );
          assert.deepEqual(await snapshotTree(root), before);
        },
      },
      {
        name: 'symlink-claim-leaf',
        run: async (root) => {
          await seedQueuedHead(root, { sequence: 1 });
          await mkdir(join(root, 'audit'), { recursive: true });
          const target = join(root, 'elsewhere.json');
          await writeFile(target, CANONICAL_IDLE_CLAIM_BYTES, { mode: 0o600 });
          await symlink(target, claimAbs(root));
          const before = await snapshotTree(root);
          await assert.rejects(
            () => api.claimAuditIntegrityAlertDelivery(root, CANONICAL_ENDPOINT, FIXED_NOW),
            (error) => assertUnavailable(error, [root, target]),
          );
          assert.deepEqual(await snapshotTree(root), before);
        },
      },
      {
        name: 'hostile-capability-matrix',
        run: async (root) => {
          await seedQueuedHead(root, { sequence: 1 });
          const claimed = await api.claimAuditIntegrityAlertDelivery(
            root,
            CANONICAL_ENDPOINT,
            FIXED_NOW,
          );
          const before = await snapshotTree(root);
          const good = capabilityOf(claimed);
          const hostiles = [
            { ...good, extra: true },
            { streamId: good.streamId, sequence: good.sequence, claimId: good.claimId }, // reordered
            { claimId: good.claimId, streamId: good.streamId }, // missing sequence
            { claimId: good.claimId, streamId: good.streamId, sequence: good.sequence, ownerPid: 1 },
            Object.defineProperty({ ...good }, 'claimId', {
              get() { throw new Error('accessor'); },
              enumerable: true,
            }),
            new Proxy({ ...good }, {
              get() { throw new Error('proxy'); },
            }),
            null,
            'claim',
            42,
            { claimId: 'not-uuid', streamId: good.streamId, sequence: good.sequence },
            { claimId: good.claimId, streamId: OTHER_STREAM_ID, sequence: good.sequence },
            { claimId: good.claimId, streamId: good.streamId, sequence: good.sequence + 1 },
          ];
          // Fix reordered case: build with different key insertion order.
          hostiles[1] = {
            streamId: good.streamId,
            sequence: good.sequence,
            claimId: good.claimId,
          };

          for (const cap of hostiles) {
            await assert.rejects(
              () => api.completeAuditIntegrityAlertDelivery(root, cap),
              (error) => assertUnavailable(error, [root, CLAIM_ID_A]),
            );
            await assert.rejects(
              () => api.releaseAuditIntegrityAlertDelivery(root, cap),
              (error) => assertUnavailable(error, [root]),
            );
            assert.deepEqual(await snapshotTree(root), before);
          }
        },
      },
      {
        name: 'nested-enqueue',
        run: async (root) => {
          await seedQueuedHead(root, { sequence: 1 });
          const before = await snapshotTree(root);
          await withLease(root, async () => {
            await assert.rejects(
              () => api.claimAuditIntegrityAlertDelivery(root, CANONICAL_ENDPOINT, FIXED_NOW),
              (error) => {
                // Nested enqueue may surface as delivery-unavailable or safe-data fail-closed;
                // design collapses delivery surface to audit-delivery-unavailable.
                assertUnavailable(error, [root]);
                return true;
              },
            );
          });
          assert.deepEqual(await snapshotTree(root), before);
        },
      },
      {
        name: 'invalid-now-and-endpoint',
        run: async (root) => {
          await seedQueuedHead(root, { sequence: 1 });
          const before = await snapshotTree(root);
          for (const now of [null, '', '2026-08-04T12:00:00Z', 'not-a-date', 123]) {
            await assert.rejects(
              () => api.claimAuditIntegrityAlertDelivery(root, CANONICAL_ENDPOINT, now),
              (error) => assertUnavailable(error, [root, String(now)]),
            );
          }
          for (const endpoint of [
            'http://alerts.example.invalid/hooks/audit-integrity',
            'https://user:pass@alerts.example.invalid/hooks',
            '',
            null,
          ]) {
            await assert.rejects(
              () => api.claimAuditIntegrityAlertDelivery(root, endpoint, FIXED_NOW),
              (error) => assertUnavailable(error, [root, String(endpoint ?? '')]),
            );
          }
          assert.deepEqual(await snapshotTree(root), before);
        },
      },
    ];

    for (const { name, run } of cases) {
      await withTempRoot(name, async (root) => {
        await run(root);
      });
    }

    // Self-identity residual used above — keep reference live for typecheck silence.
    void self;
  });

  it('10 no Date.now/network/timer/scheduler/Agent-API-Web wiring; import closed set is design consumers only', async () => {
    // Break: introducing clock/network/agent surfaces would violate pure coordinator boundary.
    // Prefer behavioral absence: claim uses explicit now; no HTTP. Source check is closed-set, not a fragile line-count detector.
    const api = requireApi();
    await withTempRoot('no-clock', async (root) => {
      await seedQueuedHead(root, { sequence: 1 });
      const receipt = await api.claimAuditIntegrityAlertDelivery(
        root,
        CANONICAL_ENDPOINT,
        FIXED_NOW,
      );
      assert.equal(receipt.expiresAt, addMs(FIXED_NOW, TTL_MS));
      // Explicit now, not wall clock: far-past now still claims when idle.
      await api.releaseAuditIntegrityAlertDelivery(root, capabilityOf(receipt));
      const past = await api.claimAuditIntegrityAlertDelivery(
        root,
        CANONICAL_ENDPOINT,
        '2000-01-01T00:00:00.000Z',
      );
      assert.equal(past.status, 'claimed');
      assert.equal(past.expiresAt, '2000-01-01T00:02:00.000Z');
    });

    const source = await readFile(PRODUCTION_MODULE_PATH, 'utf8');
    for (const needle of [
      'claimAuditIntegrityAlertDelivery',
      'completeAuditIntegrityAlertDelivery',
      'releaseAuditIntegrityAlertDelivery',
      'AUDIT_INTEGRITY_ALERT_DELIVERY_CLAIM_TTL_MS',
      'enqueueAuditIntegrityWriteTask',
      'buildAuditIntegrityAlertDeliveryRequest',
      'createLaunchAgentProcessIdentityReader',
    ]) {
      assert.equal(source.includes(needle), true, `expected surface: ${needle}`);
    }
    for (const forbidden of [
      'Date.now',
      'fetch(',
      'setTimeout(',
      'setInterval(',
      'setImmediate(',
      'node:http',
      'node:https',
      'node:net',
      'node:tls',
      'node:dns',
      "from './agent.js'",
      "from './server.js'",
      "from './web/",
      'prepareAuditIntegrityAlertDelivery',
      'runAuditIntegrityMonitor',
      'child_process',
      'process.env',
    ]) {
      assert.equal(source.includes(forbidden), false, `forbidden: ${forbidden}`);
    }
    // Wall clock only via explicit `now` argument — Date.parse/new Date(iso) for canonical ISO OK.
  });

  it('11 real multi-process same-start race: one claimed holder + one busy; SIGKILL winner; fresh reclaim', async () => {
    // Break: sequential start (wait A READY then spawn B) only proves late busy, not exclusive
    // mutual exclusion from a shared origin. Fixing A as winner would also hide non-deterministic races.
    const api = requireApi();
    await withTempRoot('multiprocess', async (root) => {
      await seedQueuedHead(root, { sequence: 1 });
      const farNow = '2099-06-01T00:00:00.000Z';
      const farExpiresFloor = addMs(farNow, TTL_MS);
      const startSignalPath = join(root, '.claim-race-start');

      // Two fresh children: both PREPARED (no claim yet) before parent fires the same START.
      const a = spawnContender('claim-hold', root, CANONICAL_ENDPOINT, farNow, {
        timeoutMs: 40_000,
        startSignalPath,
      });
      const b = spawnContender('claim-hold', root, CANONICAL_ENDPOINT, farNow, {
        timeoutMs: 40_000,
        startSignalPath,
      });

      /** @type {null | ReturnType<typeof spawnContender>} */
      let winner = null;
      /** @type {null | ReturnType<typeof spawnContender>} */
      let loser = null;
      /** @type {string | null} */
      let winnerClaimId = null;

      try {
        const [prepA, prepB] = await Promise.all([
          a.waitLine('PREPARED', 15_000),
          b.waitLine('PREPARED', 15_000),
        ]);
        assert.equal(prepA.payload.pid, a.pid);
        assert.equal(prepB.payload.pid, b.pid);
        // Neither child has claimed yet: claim leaf must still be absent (no sequential pre-claim).
        await assert.rejects(() => access(claimAbs(root)), { code: 'ENOENT' });
        assert.equal(a.stdoutLines.some((l) => l.startsWith('READY ') || l.startsWith('RESULT ')), false);
        assert.equal(b.stdoutLines.some((l) => l.startsWith('READY ') || l.startsWith('RESULT ')), false);

        // Same START signal for both — concurrent claim from shared origin.
        await writeFile(startSignalPath, 'START\n', { encoding: 'utf8', mode: 0o600 });

        const [outA, outB] = await Promise.all([
          a.waitAnyLine(['READY', 'RESULT'], 25_000),
          b.waitAnyLine(['READY', 'RESULT'], 25_000),
        ]);

        /** @type {Array<{ contender: ReturnType<typeof spawnContender>, line: Awaited<ReturnType<ReturnType<typeof spawnContender>['waitAnyLine']>> }>} */
        const outcomes = [
          { contender: a, line: outA },
          { contender: b, line: outB },
        ];
        const readyOutcomes = outcomes.filter((o) => o.line.kind === 'READY');
        const busyOutcomes = outcomes.filter(
          (o) => o.line.kind === 'RESULT' && o.line.payload && o.line.payload.status === 'busy',
        );
        assert.equal(readyOutcomes.length, 1, 'exactly one READY claimed holder');
        assert.equal(busyOutcomes.length, 1, 'exactly one busy RESULT');
        // Winner must not be fixed to A — record real winner PID/claimId.
        winner = readyOutcomes[0].contender;
        loser = busyOutcomes[0].contender;
        assert.equal(readyOutcomes[0].line.payload.status, 'claimed');
        assert.equal(readyOutcomes[0].line.payload.pid, winner.pid);
        winnerClaimId = readyOutcomes[0].line.payload.claimId;
        assert.equal(typeof winnerClaimId, 'string');
        assert.match(/** @type {string} */ (winnerClaimId), UUID_V4_RE);
        assert.equal(busyOutcomes[0].line.payload.claimId, null);
        assert.equal(busyOutcomes[0].line.payload.streamId, FIXED_STREAM_ID);
        assert.equal(busyOutcomes[0].line.payload.sequence, 1);

        await loser.waitLine('DONE', 5_000);
        await loser.exitPromise;
        assert.equal(loser.getStderrText(), '');

        const claimHolder = await loadClaim(root);
        assert.equal(claimHolder.status, 'claimed');
        assert.equal(claimHolder.claimId, winnerClaimId);
        assert.equal(claimHolder.ownerPid, winner.pid);
        assert.equal(Date.parse(claimHolder.expiresAt) >= Date.parse(farExpiresFloor), true);

        // Parent SIGKILL only the recorded winner PID; confirm signal.
        await winner.killRecorded('SIGKILL');
        const winnerExit = await winner.exitPromise;
        assert.equal(winnerExit.signal, 'SIGKILL');
        assert.equal(winner.getStderrText(), '');

        // Fresh reclaimer before persisted expiresAt — new claimed with different claimId/PID.
        const reclaimNow = '2099-06-01T00:00:01.000Z';
        assert.equal(Date.parse(reclaimNow) < Date.parse(claimHolder.expiresAt), true);
        const reclaimer = spawnContender(
          'reclaim',
          root,
          CANONICAL_ENDPOINT,
          reclaimNow,
          { timeoutMs: 20_000 },
        );
        try {
          const resultR = await reclaimer.waitLine('RESULT', 15_000);
          assert.equal(resultR.payload.status, 'claimed');
          assert.notEqual(resultR.payload.claimId, winnerClaimId);
          assert.equal(resultR.payload.sequence, 1);
          assert.notEqual(resultR.payload.pid, winner.pid);
          await reclaimer.waitLine('DONE', 5_000);
          await reclaimer.exitPromise;
          assert.equal(reclaimer.getStderrText(), '');

          const loaded = await loadClaim(root);
          assert.equal(loaded.status, 'claimed');
          assert.equal(loaded.claimId, resultR.payload.claimId);
          assert.notEqual(loaded.ownerPid, winner.pid);
          assert.notEqual(loaded.claimId, winnerClaimId);
        } finally {
          await reclaimer.cleanup();
        }

        const released = await api.releaseAuditIntegrityAlertDelivery(root, {
          claimId: (await loadClaim(root)).claimId,
          streamId: FIXED_STREAM_ID,
          sequence: 1,
        });
        assert.equal(released.status, 'released');
      } finally {
        await a.cleanup();
        await b.cleanup();
        assert.equal(a.getStderrText(), '');
        assert.equal(b.getStderrText(), '');
        // No leftover live children after cleanup.
        for (const c of [a, b]) {
          const info = c.getExitInfo();
          assert.notEqual(info, null, `contender pid=${c.pid} must have exited`);
        }
      }
    });
  });

  it('12 five-second process-lock timeout remains fail closed as delivery-unavailable', async () => {
    // Break: swallowing lock timeout or leaking process-lock paths/codes.
    const api = requireApi();
    await withTempRoot('lock-timeout', async (root) => {
      await seedQueuedHead(root, { sequence: 1 });
      const resolvedRoot = await assertSafeDataRoot(root);
      const handle = await acquireAuditIntegrityProcessLock(resolvedRoot);
      try {
        const started = Date.now();
        await assert.rejects(
          () => api.claimAuditIntegrityAlertDelivery(root, CANONICAL_ENDPOINT, FIXED_NOW),
          (error) => {
            assertUnavailable(error, [
              root,
              'lockf',
              'integrity-write.lock',
              'audit-integrity-process-lock-unavailable',
            ]);
            return true;
          },
        );
        const elapsed = Date.now() - started;
        assert.ok(elapsed >= 4_000, `expected ~5s wait, got ${elapsed}ms`);
        assert.ok(elapsed <= 15_000, `timeout too long: ${elapsed}ms`);
        // No claim published under timeout.
        const claim = await readOptional(claimAbs(root));
        assert.equal(claim === null || claim === CANONICAL_IDLE_CLAIM_BYTES, true);
      } finally {
        await releaseAuditIntegrityProcessLock(handle);
      }
    });
  });
});
