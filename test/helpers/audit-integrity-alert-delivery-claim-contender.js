/**
 * Bounded real-process contender for audit integrity alert delivery claims.
 *
 * Stdout protocol (exactly one token per line; stderr must stay empty):
 *   PREPARED <compact-json>   — optional; emitted before claim when a START path is given
 *   READY <compact-json>
 *   RESULT <compact-json>
 *   DONE
 *
 * Modes (argv after node helper):
 *   contend  <dataDir> <endpoint> <nowIso> [startSignalPath]
 *     One claim attempt → RESULT → DONE. Used for single-shot or barrier races.
 *   claim-hold <dataDir> <endpoint> <nowIso> [startSignalPath]
 *     Claim; on claimed emit READY then hang until SIGTERM/SIGKILL (parent records
 *     PID and may SIGKILL). On busy/error emit RESULT then DONE.
 *     When startSignalPath is present: emit PREPARED first (no claim yet), poll until
 *     the path exists, then claim. Two claim-hold children sharing one START path
 *     prove true same-start mutual exclusion (one READY + one busy RESULT).
 *   reclaim  <dataDir> <endpoint> <nowIso>
 *     Fresh-process reclaim after owner kill → RESULT → DONE.
 *
 * Never prints dataDir, claim raw owner/output digests, or stack traces on stdout/stderr.
 * Production modules are loaded dynamically; missing implementation exits 2 with RESULT only.
 */

delete process.env.FORCE_COLOR;
delete process.env.NO_COLOR;

import { writeSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const PRODUCTION_MODULE_URL = new URL(
  '../../src/audit-integrity-alert-delivery-claim.js',
  import.meta.url,
);

const START_WAIT_MS = 25_000;
const START_POLL_MS = 15;

/** @type {boolean} */
let settled = false;

/**
 * @param {number} fd
 * @param {string} line
 */
function writeLine(fd, line) {
  writeSync(fd, `${line}\n`);
}

/**
 * @param {string} kind
 * @param {object} payload
 */
function emit(kind, payload) {
  writeLine(1, `${kind} ${JSON.stringify(payload)}`);
}

function emitDone() {
  if (settled) return;
  settled = true;
  writeLine(1, 'DONE');
}

/**
 * @param {string} status
 * @param {object} [extra]
 */
function emitResult(status, extra = {}) {
  emit('RESULT', {
    status,
    pid: process.pid,
    ...extra,
  });
}

function failClosedExit(code = 1) {
  try {
    if (!settled) {
      emitResult('error');
      emitDone();
    }
  } catch {
    // ignore
  }
  process.exit(code);
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isAbsRoot(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('\0')
    && isAbsolute(value)
    && resolve(value) === value;
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isCanonicalHttpsEndpoint(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:'
      && u.href === value
      && u.username === ''
      && u.password === ''
      && u.search === ''
      && u.hash === '';
  } catch {
    return false;
  }
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isMsUtc(value) {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

/**
 * Absolute path for parent-created START barrier file (must not be dataDir itself).
 * @param {unknown} value
 * @returns {value is string}
 */
function isStartSignalPath(value) {
  return isAbsRoot(value);
}

/**
 * @returns {Promise<{
 *   claimAuditIntegrityAlertDelivery: Function,
 * } | null>}
 */
async function loadClaimApi() {
  try {
    const mod = await import(PRODUCTION_MODULE_URL.href);
    if (typeof mod.claimAuditIntegrityAlertDelivery !== 'function') return null;
    return {
      claimAuditIntegrityAlertDelivery: mod.claimAuditIntegrityAlertDelivery,
    };
  } catch (error) {
    const code = error && typeof error === 'object'
      ? /** @type {{ code?: string }} */ (error).code
      : undefined;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
}

/**
 * Project a public claim receipt into a path-free RESULT payload.
 * @param {unknown} receipt
 */
function projectReceipt(receipt) {
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { status: 'error' };
  }
  const r = /** @type {Record<string, unknown>} */ (receipt);
  const status = r.status;
  if (status === 'claimed') {
    return {
      status: 'claimed',
      claimId: typeof r.claimId === 'string' ? r.claimId : null,
      streamId: typeof r.streamId === 'string' ? r.streamId : null,
      sequence: typeof r.sequence === 'number' ? r.sequence : null,
      expiresAt: typeof r.expiresAt === 'string' ? r.expiresAt : null,
    };
  }
  if (status === 'busy') {
    return {
      status: 'busy',
      claimId: r.claimId === null ? null : 'leaked',
      streamId: typeof r.streamId === 'string' ? r.streamId : null,
      sequence: typeof r.sequence === 'number' ? r.sequence : null,
      expiresAt: typeof r.expiresAt === 'string' ? r.expiresAt : null,
    };
  }
  if (status === 'empty') {
    return { status: 'empty' };
  }
  return { status: 'error' };
}

/**
 * Parent-controlled START barrier: emit PREPARED (no claim yet), then poll for path.
 * @param {string | null} startSignalPath
 */
async function awaitStartBarrier(startSignalPath) {
  if (startSignalPath === null) return;
  emit('PREPARED', { pid: process.pid });
  const deadline = Date.now() + START_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      await access(startSignalPath);
      return;
    } catch {
      await delay(START_POLL_MS);
    }
  }
  failClosedExit(1);
}

/**
 * @param {'contend' | 'claim-hold' | 'reclaim'} mode
 * @param {string} dataDir
 * @param {string} endpoint
 * @param {string} now
 * @param {string | null} startSignalPath
 */
async function runMode(mode, dataDir, endpoint, now, startSignalPath) {
  const api = await loadClaimApi();
  if (api === null) {
    emitResult('implementation-missing');
    emitDone();
    process.exit(2);
    return;
  }

  // Barrier before any claim attempt so parent can start two contenders from the same origin.
  await awaitStartBarrier(startSignalPath);

  let receipt;
  try {
    receipt = await api.claimAuditIntegrityAlertDelivery(dataDir, endpoint, now);
  } catch {
    emitResult('unavailable');
    emitDone();
    process.exit(0);
    return;
  }

  const projected = projectReceipt(receipt);

  if (mode === 'claim-hold' && projected.status === 'claimed') {
    emit('READY', {
      status: 'claimed',
      pid: process.pid,
      claimId: projected.claimId,
      streamId: projected.streamId,
      sequence: projected.sequence,
      expiresAt: projected.expiresAt,
    });
    // Hang until parent SIGKILL / SIGTERM. Keep event loop alive.
    setInterval(() => {}, 1 << 30);
    return;
  }

  emitResult(projected.status, {
    claimId: projected.claimId ?? null,
    streamId: projected.streamId ?? null,
    sequence: projected.sequence ?? null,
    expiresAt: projected.expiresAt ?? null,
  });
  emitDone();
  process.exit(0);
}

async function main() {
  const [mode, dataDir, endpoint, now, maybeStart, ...rest] = process.argv.slice(2);
  if (rest.length !== 0) failClosedExit(1);
  if (mode !== 'contend' && mode !== 'claim-hold' && mode !== 'reclaim') {
    failClosedExit(1);
  }
  if (!isAbsRoot(dataDir) || !isCanonicalHttpsEndpoint(endpoint) || !isMsUtc(now)) {
    failClosedExit(1);
  }
  /** @type {string | null} */
  let startSignalPath = null;
  if (maybeStart !== undefined) {
    // reclaim never takes a START path (fresh post-kill claim is sequential).
    if (mode === 'reclaim') failClosedExit(1);
    if (!isStartSignalPath(maybeStart)) failClosedExit(1);
    startSignalPath = maybeStart;
  }
  await runMode(mode, dataDir, endpoint, now, startSignalPath);
}

main().catch(() => {
  failClosedExit(1);
});
