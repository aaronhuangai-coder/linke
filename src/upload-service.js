/**
 * G0b C5 — Upload service orchestration (pure domain; no HTTP routes).
 * Wires C1–C4 store/ingest/commit under C5 locks. Production routes remain C6.
 */

import { createHash } from 'node:crypto';
import { ERROR_CODES, LinkeError } from './error-codes.js';
import { SafeDataFileError, safeAtomicWriteBytes, safeHashFileSha256 } from './safe-data-files.js';
import { safeDevicePath } from './storage.js';
import { projectCanonicalUploadManifest } from './upload-manifest.js';
import { UPLOAD_CHUNK_SIZE } from './upload-session-store.js';

const INVALID_SERVICE_OPTIONS = 'invalid createUploadService options';

/**
 * @returns {never}
 */
function failInvalidOptions() {
  throw new Error(INVALID_SERVICE_OPTIONS);
}

/**
 * @returns {never}
 */
function failIo() {
  throw new LinkeError(ERROR_CODES.UPLOAD_IO_ERROR);
}

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isNonNullObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isFunction(value) {
  return typeof value === 'function';
}

/**
 * Re-throw LinkeError; map everything else to path-free upload-io-error.
 * @param {unknown} error
 * @returns {never}
 */
function rethrowSafe(error) {
  if (error instanceof LinkeError) throw error;
  failIo();
}

/**
 * Optional AbortSignal: already-aborted → sanitized public error (no raw AbortError).
 * @param {unknown} signal
 */
function throwIfAborted(signal) {
  if (signal == null) return;
  try {
    if (typeof signal === 'object' && /** @type {{ aborted?: unknown }} */ (signal).aborted === true) {
      failIo();
    }
  } catch (error) {
    if (error instanceof LinkeError) throw error;
    failIo();
  }
}

/**
 * @param {unknown} input
 * @returns {AbortSignal | undefined}
 */
function readOptionalSignal(input) {
  if (input == null || typeof input !== 'object') return undefined;
  try {
    const signal = /** @type {{ signal?: unknown }} */ (input).signal;
    if (signal == null) return undefined;
    if (typeof signal !== 'object') return undefined;
    return /** @type {AbortSignal} */ (signal);
  } catch {
    return undefined;
  }
}

/**
 * Resolve device-relative path without leaking invalid deviceId via storage errors.
 * @param {string} dataDir
 * @param {string} deviceId
 * @returns {{ slug: string, deviceRel: string }}
 */
function resolveDeviceScope(dataDir, deviceId) {
  try {
    const { slug, deviceRel } = safeDevicePath(dataDir, deviceId);
    return { slug, deviceRel };
  } catch {
    failIo();
  }
}

/**
 * Staging relative path under dataDir (fileIndex/chunkIndex only — never client path).
 * @param {string} deviceRel
 * @param {string} uploadId
 * @param {number} fileIndex
 * @param {number} chunkIndex
 */
function stagingChunkRel(deviceRel, uploadId, fileIndex, chunkIndex) {
  return `${deviceRel}/upload-sessions/${uploadId}/.staging/files/${fileIndex}/chunk-${chunkIndex}.part`;
}

/**
 * @param {unknown} bodyResult
 * @returns {Buffer}
 */
function coerceBodyBuffer(bodyResult) {
  if (Buffer.isBuffer(bodyResult)) return bodyResult;
  if (
    bodyResult
    && typeof bodyResult === 'object'
    && Buffer.isBuffer(/** @type {{ body?: unknown }} */ (bodyResult).body)
  ) {
    return /** @type {{ body: Buffer }} */ (bodyResult).body;
  }
  throw new LinkeError(ERROR_CODES.UPLOAD_CHUNK_INVALID);
}

/**
 * Create pure-domain upload service. Does not listen on ports or register routes.
 *
 * @param {{
 *   dataDir: string,
 *   store: {
 *     createSession: Function,
 *     getSession: Function,
 *     abortSession: Function,
 *     advanceBoundary?: Function,
 *   },
 *   locks: {
 *     maxGlobalTransfers: number,
 *     runTransfer: Function,
 *     runDevice: Function,
 *     runSession: Function,
 *     runSnapshot: Function,
 *   },
 *   ingest: {
 *     parseChunkHeaders: Function,
 *     ingestChunkBody: Function,
 *     commitChunk: Function,
 *   },
 *   commit: {
 *     preflightCapacity: Function,
 *     verifyAndCommitSession: Function,
 *   },
 *   now: () => Date,
 * }} options
 * @returns {Readonly<{
 *   create: Function,
 *   status: Function,
 *   putChunk: Function,
 *   finalize: Function,
 *   abort: Function,
 * }>}
 */
export function createUploadService(options) {
  /** @type {string} */
  let dataDir;
  /** @type {any} */
  let store;
  /** @type {any} */
  let locks;
  /** @type {any} */
  let ingest;
  /** @type {any} */
  let commit;
  /** @type {() => Date} */
  let now;

  try {
    if (!isNonNullObject(options)) failInvalidOptions();

    const dir = /** @type {{ dataDir?: unknown }} */ (options).dataDir;
    if (typeof dir !== 'string' || dir.length === 0) failInvalidOptions();
    dataDir = dir;

    const storeRaw = /** @type {{ store?: unknown }} */ (options).store;
    if (!isNonNullObject(storeRaw)) failInvalidOptions();
    if (
      !isFunction(/** @type {{ createSession?: unknown }} */ (storeRaw).createSession)
      || !isFunction(/** @type {{ getSession?: unknown }} */ (storeRaw).getSession)
      || !isFunction(/** @type {{ abortSession?: unknown }} */ (storeRaw).abortSession)
    ) {
      failInvalidOptions();
    }
    store = storeRaw;

    const locksRaw = /** @type {{ locks?: unknown }} */ (options).locks;
    if (!isNonNullObject(locksRaw)) failInvalidOptions();
    if (
      !isFunction(/** @type {{ runTransfer?: unknown }} */ (locksRaw).runTransfer)
      || !isFunction(/** @type {{ runDevice?: unknown }} */ (locksRaw).runDevice)
      || !isFunction(/** @type {{ runSession?: unknown }} */ (locksRaw).runSession)
      || !isFunction(/** @type {{ runSnapshot?: unknown }} */ (locksRaw).runSnapshot)
    ) {
      failInvalidOptions();
    }
    locks = locksRaw;

    const ingestRaw = /** @type {{ ingest?: unknown }} */ (options).ingest;
    if (!isNonNullObject(ingestRaw)) failInvalidOptions();
    if (
      !isFunction(/** @type {{ parseChunkHeaders?: unknown }} */ (ingestRaw).parseChunkHeaders)
      || !isFunction(/** @type {{ ingestChunkBody?: unknown }} */ (ingestRaw).ingestChunkBody)
      || !isFunction(/** @type {{ commitChunk?: unknown }} */ (ingestRaw).commitChunk)
    ) {
      failInvalidOptions();
    }
    ingest = ingestRaw;

    const commitRaw = /** @type {{ commit?: unknown }} */ (options).commit;
    if (!isNonNullObject(commitRaw)) failInvalidOptions();
    if (
      !isFunction(/** @type {{ preflightCapacity?: unknown }} */ (commitRaw).preflightCapacity)
      || !isFunction(
        /** @type {{ verifyAndCommitSession?: unknown }} */ (commitRaw).verifyAndCommitSession,
      )
    ) {
      failInvalidOptions();
    }
    commit = commitRaw;

    const nowRaw = /** @type {{ now?: unknown }} */ (options).now;
    if (!isFunction(nowRaw)) failInvalidOptions();
    now = /** @type {() => Date} */ (nowRaw);
  } catch (error) {
    if (error instanceof Error && error.message === INVALID_SERVICE_OPTIONS) throw error;
    failInvalidOptions();
  }

  /**
   * Create upload session: project → preflightCapacity → createSession.
   * Occupies global transfer + per-device FIFO.
   *
   * @param {{
   *   authenticatedDeviceId: string,
   *   manifest: unknown,
   *   claimedManifestDigest: string,
   *   signal?: AbortSignal,
   * }} input
   */
  async function create(input) {
    const signal = readOptionalSignal(input);
    throwIfAborted(signal);

    const authenticatedDeviceId = input?.authenticatedDeviceId;
    if (typeof authenticatedDeviceId !== 'string' || authenticatedDeviceId.length === 0) {
      throw new LinkeError(ERROR_CODES.UPLOAD_MANIFEST_INVALID);
    }

    throwIfAborted(signal);
    return locks.runTransfer(async () => {
      throwIfAborted(signal);
      return locks.runDevice(authenticatedDeviceId, async () => {
        throwIfAborted(signal);
        let projected;
        try {
          projected = projectCanonicalUploadManifest(input.manifest, {
            authenticatedDeviceId,
            claimedManifestDigest: input.claimedManifestDigest,
          });
        } catch (error) {
          rethrowSafe(error);
        }

        const totalBytes = projected.manifest?.integrity?.totalBytes;
        if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) {
          throw new LinkeError(ERROR_CODES.UPLOAD_MANIFEST_INVALID);
        }

        throwIfAborted(signal);
        try {
          await commit.preflightCapacity(dataDir, totalBytes);
        } catch (error) {
          rethrowSafe(error);
        }

        // After project/preflight, before store.createSession mutation.
        throwIfAborted(signal);
        try {
          return await store.createSession({
            authenticatedDeviceId,
            snapshotId: projected.manifest.snapshotId,
            manifestDigest: projected.manifestDigest,
            canonicalManifest: projected.manifest,
            signal,
          });
        } catch (error) {
          rethrowSafe(error);
        }
      });
    });
  }

  /**
   * Safe session status / resume summary. Does NOT take a global transfer slot.
   *
   * @param {{ authenticatedDeviceId: string, uploadId: string, signal?: AbortSignal }} input
   */
  async function status(input) {
    const signal = readOptionalSignal(input);
    throwIfAborted(signal);
    try {
      // Legacy direct-service contract: only authenticatedDeviceId+uploadId when no signal.
      // Propagate signal key only when a real AbortSignal is present (C6 always passes one).
      return await store.getSession({
        authenticatedDeviceId: input?.authenticatedDeviceId,
        uploadId: input?.uploadId,
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (error) {
      rethrowSafe(error);
    }
  }

  /**
   * Ingest one chunk: global transfer → per-session → parse → body → hash → commitChunk.
   * Staging path uses only validated identity/session indices (never client path).
   *
   * @param {{
   *   authenticatedDeviceId: string,
   *   request: unknown,
   *   stream: unknown,
   *   signal?: AbortSignal,
   * }} input
   */
  async function putChunk(input) {
    const signal = readOptionalSignal(input);
    throwIfAborted(signal);

    const authenticatedDeviceId = input?.authenticatedDeviceId;
    if (typeof authenticatedDeviceId !== 'string' || authenticatedDeviceId.length === 0) {
      throw new LinkeError(ERROR_CODES.UPLOAD_CHUNK_INVALID);
    }

    // Capture request/stream only after global slot is acquired (backpressure must not touch them).
    throwIfAborted(signal);
    return locks.runTransfer(async () => {
      throwIfAborted(signal);
      // Parse after global acquire so full semaphore never reads headers/stream.
      let identity;
      try {
        identity = ingest.parseChunkHeaders(input.request);
      } catch (error) {
        rethrowSafe(error);
      }

      if (
        !identity
        || typeof identity !== 'object'
        || identity.deviceId !== authenticatedDeviceId
      ) {
        throw new LinkeError(ERROR_CODES.UPLOAD_CHUNK_INVALID);
      }

      const uploadId = identity.uploadId;
      if (typeof uploadId !== 'string' || uploadId.length === 0) {
        throw new LinkeError(ERROR_CODES.UPLOAD_CHUNK_INVALID);
      }

      // Reject unsafe indices before session lock / store / body / commit / I/O.
      const fileIndex = identity.fileIndex;
      const chunkIndex = identity.chunkIndex;
      if (
        !Number.isSafeInteger(fileIndex)
        || fileIndex < 0
        || !Number.isSafeInteger(chunkIndex)
        || chunkIndex < 0
      ) {
        throw new LinkeError(ERROR_CODES.UPLOAD_CHUNK_INVALID);
      }

      throwIfAborted(signal);
      return locks.runSession(authenticatedDeviceId, uploadId, async () => {
        throwIfAborted(signal);
        let session;
        try {
          session = await store.getSession({
            authenticatedDeviceId,
            uploadId,
            signal,
          });
        } catch (error) {
          rethrowSafe(error);
        }

        throwIfAborted(signal);
        const expectedSize = identity.size;
        if (
          !Number.isSafeInteger(expectedSize)
          || expectedSize <= 0
          || expectedSize > UPLOAD_CHUNK_SIZE
        ) {
          throw new LinkeError(ERROR_CODES.UPLOAD_CHUNK_INVALID);
        }

        let bodyResult;
        try {
          bodyResult = await ingest.ingestChunkBody(input.stream, {
            maxBytes: expectedSize,
            expectedSize,
            signal,
          });
        } catch (error) {
          rethrowSafe(error);
        }

        throwIfAborted(signal);
        const body = coerceBodyBuffer(bodyResult);
        const bodyHash = createHash('sha256').update(body).digest('hex');

        const { deviceRel } = resolveDeviceScope(dataDir, session.deviceId ?? authenticatedDeviceId);
        const relativeStagingPath = stagingChunkRel(
          deviceRel,
          session.uploadId ?? uploadId,
          identity.fileIndex,
          identity.chunkIndex,
        );

        /**
         * C3 tempPublish: publish-new writes bytes; verify-existing rehashes only.
         * Context is mode-only; path components come from verified session/identity.
         *
         * @param {Readonly<{ mode: 'publish-new' | 'verify-existing' }>} ctx
         */
        async function tempPublish(ctx) {
          throwIfAborted(signal);
          if (!ctx || typeof ctx !== 'object') failIo();
          const mode = ctx.mode;

          if (mode === 'verify-existing') {
            throwIfAborted(signal);
            try {
              const hashed = await safeHashFileSha256(dataDir, relativeStagingPath, {
                maxBytes: UPLOAD_CHUNK_SIZE,
              });
              throwIfAborted(signal);
              if (!hashed || typeof hashed.sha256 !== 'string') failIo();
              return { existingSha256: hashed.sha256 };
            } catch (error) {
              if (error instanceof LinkeError) throw error;
              if (error instanceof SafeDataFileError) failIo();
              failIo();
            }
          }

          if (mode !== 'publish-new') failIo();

          throwIfAborted(signal);
          try {
            await safeAtomicWriteBytes(dataDir, relativeStagingPath, body);
            throwIfAborted(signal);
            // Absent existingSha256 → new publish succeeded (C3 contract).
            return Object.freeze({ ok: true });
          } catch (error) {
            if (error instanceof LinkeError) throw error;
            if (error instanceof SafeDataFileError) failIo();
            failIo();
          }
        }

        throwIfAborted(signal);
        try {
          return await ingest.commitChunk({
            store,
            session,
            identity,
            bodyHash,
            tempPublish,
            signal,
          });
        } catch (error) {
          rethrowSafe(error);
        }
      });
    });
  }

  /**
   * Finalize: global → per-session → per-snapshot → verifyAndCommitSession.
   *
   * @param {{ authenticatedDeviceId: string, uploadId: string, signal?: AbortSignal }} input
   */
  async function finalize(input) {
    const signal = readOptionalSignal(input);
    throwIfAborted(signal);

    const authenticatedDeviceId = input?.authenticatedDeviceId;
    const uploadId = input?.uploadId;
    if (typeof authenticatedDeviceId !== 'string' || authenticatedDeviceId.length === 0) {
      throw new LinkeError(ERROR_CODES.UPLOAD_SESSION_NOT_FOUND);
    }
    if (typeof uploadId !== 'string' || uploadId.length === 0) {
      throw new LinkeError(ERROR_CODES.UPLOAD_SESSION_NOT_FOUND);
    }

    throwIfAborted(signal);
    return locks.runTransfer(async () => {
      throwIfAborted(signal);
      return locks.runSession(authenticatedDeviceId, uploadId, async () => {
        throwIfAborted(signal);
        let session;
        try {
          session = await store.getSession({
            authenticatedDeviceId,
            uploadId,
            signal,
          });
        } catch (error) {
          rethrowSafe(error);
        }

        throwIfAborted(signal);
        const snapshotId = session?.snapshotId;
        if (typeof snapshotId !== 'string' || snapshotId.length === 0) {
          failIo();
        }

        throwIfAborted(signal);
        return locks.runSnapshot(authenticatedDeviceId, snapshotId, async () => {
          throwIfAborted(signal);
          try {
            await commit.verifyAndCommitSession({
              store,
              dataDir,
              deviceId: authenticatedDeviceId,
              uploadId,
              now,
              signal,
            });
            throwIfAborted(signal);
          } catch (error) {
            rethrowSafe(error);
          }
        });
      });
    });
  }

  /**
   * Abort: per-session only (no global transfer slot).
   *
   * @param {{ authenticatedDeviceId: string, uploadId: string, signal?: AbortSignal }} input
   */
  async function abort(input) {
    const signal = readOptionalSignal(input);
    throwIfAborted(signal);

    const authenticatedDeviceId = input?.authenticatedDeviceId;
    const uploadId = input?.uploadId;
    if (typeof authenticatedDeviceId !== 'string' || authenticatedDeviceId.length === 0) {
      throw new LinkeError(ERROR_CODES.UPLOAD_SESSION_NOT_FOUND);
    }
    if (typeof uploadId !== 'string' || uploadId.length === 0) {
      throw new LinkeError(ERROR_CODES.UPLOAD_SESSION_NOT_FOUND);
    }

    throwIfAborted(signal);
    return locks.runSession(authenticatedDeviceId, uploadId, async () => {
      throwIfAborted(signal);
      try {
        return await store.abortSession({
          authenticatedDeviceId,
          uploadId,
          signal,
        });
      } catch (error) {
        rethrowSafe(error);
      }
    });
  }

  return Object.freeze({
    create,
    status,
    putChunk,
    finalize,
    abort,
  });
}
