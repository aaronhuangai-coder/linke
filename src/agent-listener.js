import { createServer as createHttpsServer } from 'node:https';
import { ERROR_CODES, LinkeError } from './error-codes.js';

/** Maximum accepted JSON request body size for Agent routes (bytes). */
export const MAX_AGENT_JSON_BODY_BYTES = 64 * 1024;

const REGISTERED_CODES = new Set(Object.values(ERROR_CODES));

/**
 * Clamp to a valid HTTP status so writeHead never throws on forged values.
 * @param {unknown} statusCode
 * @param {number} [fallback=500]
 * @returns {number}
 */
function safeHttpStatus(statusCode, fallback = 500) {
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    return fallback;
  }
  return statusCode;
}

/**
 * Normalize error statuses to a safe HTTP 4xx/5xx only.
 * @param {unknown} statusCode
 * @returns {number}
 */
function normalizeErrorStatus(statusCode) {
  if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) {
    return 500;
  }
  return statusCode;
}

/**
 * Emit a single JSON response with fixed cache and length headers.
 * @param {import('node:http').ServerResponse} res
 * @param {number} statusCode
 * @param {object} body
 * @param {Record<string, string>} [extraHeaders]
 */
function sendJson(res, statusCode, body, extraHeaders = {}) {
  if (res.headersSent || res.writableEnded) return;
  const status = safeHttpStatus(statusCode, 500);
  const serialized = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(serialized),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(serialized);
}

/**
 * Release request flow-control without awaiting end; swallow late stream errors.
 * @param {import('node:http').IncomingMessage} req
 */
function releaseRequestStream(req) {
  try {
    req.on('error', () => {});
    if (!req.readableEnded && !req.destroyed) {
      req.resume();
    }
  } catch {
    // ignore — client may already have aborted
  }
}

/**
 * Safe Retry-After header from a finite, non-negative retryAfterMs only.
 * @param {unknown} decision
 * @returns {Record<string, string>}
 */
function rateLimitHeaders(decision) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return {};
  const ms = /** @type {{ retryAfterMs?: unknown }} */ (decision).retryAfterMs;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return {};
  return { 'retry-after': String(Math.ceil(ms / 1000)) };
}

/**
 * True for Promise or thenable values (async rate-limit decisions are rejected).
 * @param {unknown} value
 * @returns {boolean}
 */
function isThenable(value) {
  return value != null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof /** @type {{ then?: unknown }} */ (value).then === 'function';
}

/**
 * Strict fail-closed evaluation of rateLimit.check().
 * Only plain objects with allowed === true continue; allowed === false → 429;
 * any other shape/thenable/throw → dependency fault.
 * @param {{ check: Function }} rateLimit
 * @param {string} clientKey
 * @returns {{ kind: 'allow' } | { kind: 'limit', decision: object } | { kind: 'error' }}
 */
function evaluateRateLimit(rateLimit, clientKey) {
  let decision;
  try {
    decision = rateLimit.check(clientKey);
  } catch {
    return { kind: 'error' };
  }
  if (isThenable(decision)) return { kind: 'error' };
  if (decision === null || typeof decision !== 'object' || Array.isArray(decision)) {
    return { kind: 'error' };
  }
  if (decision.allowed === true) return { kind: 'allow' };
  if (decision.allowed === false) return { kind: 'limit', decision };
  return { kind: 'error' };
}

/**
 * Count Authorization header occurrences in rawHeaders (case-insensitive).
 * Node may keep only the first in req.headers.authorization.
 * @param {import('node:http').IncomingMessage} req
 * @returns {number}
 */
function countAuthorizationHeaders(req) {
  const raw = req.rawHeaders;
  if (!Array.isArray(raw)) return 0;
  let count = 0;
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i];
    if (typeof name === 'string' && name.toLowerCase() === 'authorization') {
      count += 1;
    }
  }
  return count;
}

/**
 * Extract a single Bearer device token; rejects missing/duplicate/malformed headers.
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
function bearerToken(req) {
  // Must be exactly one Authorization line in the wire headers.
  if (countAuthorizationHeaders(req) !== 1) {
    throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
  }
  const header = req.headers.authorization;
  if (typeof header !== 'string') {
    throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
  }
  if (
    header.includes(',')
    || header.includes('\n')
    || header.includes('\r')
    || header.includes('\0')
  ) {
    throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
  }
  if (!header.startsWith('Bearer ')) {
    throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
  }
  const token = header.slice('Bearer '.length);
  if (token.length === 0 || /\s/.test(token)) {
    throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
  }
  return token;
}

/**
 * Read and parse a JSON object body with a hard 64 KiB byte bound.
 * Crosses the limit → immediate reject; does not wait for stream end / final chunk.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
function readAgentBody(req) {
  return new Promise((resolve, reject) => {
    const declared = req.headers['content-length'];
    if (typeof declared === 'string' && declared.length > 0 && !declared.includes(',')) {
      const length = Number(declared);
      if (Number.isFinite(length) && length > MAX_AGENT_JSON_BODY_BYTES) {
        releaseRequestStream(req);
        reject(new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 413 }));
        return;
      }
    }

    const chunks = [];
    let total = 0;
    let settled = false;

    const detach = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      detach();
      // Background discard of any remaining bytes; never await end.
      releaseRequestStream(req);
      reject(error);
    };

    const succeed = (value) => {
      if (settled) return;
      settled = true;
      detach();
      resolve(value);
    };

    const onData = (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > MAX_AGENT_JSON_BODY_BYTES) {
        fail(new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 413 }));
        return;
      }
      chunks.push(buf);
    };

    const onEnd = () => {
      if (settled) return;
      const raw = Buffer.concat(chunks);
      chunks.length = 0;
      if (raw.length === 0) {
        fail(new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        fail(new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }));
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail(new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }));
        return;
      }
      succeed(parsed);
    };

    const onError = () => {
      fail(new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 }));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/**
 * Normalize optional heartbeat hostname; default "unknown".
 * @param {unknown} value
 * @returns {string}
 */
function normalizeHostname(value) {
  if (value === undefined) return 'unknown';
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 255
    || /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID, { statusCode: 400 });
  }
  return value;
}

/**
 * Map thrown values to a public registered error code + safe status.
 * Never echoes raw exception text.
 * @param {unknown} error
 * @returns {{ code: string, statusCode: number }}
 */
function publicFailure(error) {
  if (error instanceof LinkeError && REGISTERED_CODES.has(error.code)) {
    return {
      code: error.code,
      statusCode: normalizeErrorStatus(error.statusCode),
    };
  }
  return {
    code: ERROR_CODES.DEVICE_INTERNAL_ERROR,
    statusCode: 500,
  };
}

/**
 * Create the TLS-only device listener; no Web or management routes are mounted.
 * @param {{
 *   identity?: { keyPem?: string, certPem?: string },
 *   registry?: {
 *     consumeEnrollment: Function,
 *     authenticate: Function,
 *     beginTokenRotation: Function,
 *     confirmTokenRotation: Function,
 *   },
 *   onHeartbeat?: (event: {
 *     deviceId: string,
 *     hostname: string,
 *     remoteAddress: string,
 *   }) => Promise<void> | void,
 *   rateLimit?: { check: (clientKey: string) => { allowed: boolean, retryAfterMs?: number } },
 * }} [options]
 * @returns {import('node:https').Server}
 */
export function createAgentListener({
  identity,
  registry,
  onHeartbeat = async () => {},
  rateLimit,
} = {}) {
  if (!identity?.keyPem || !identity?.certPem || !registry) {
    throw new Error('identity and registry are required');
  }

  const server = createHttpsServer({
    key: identity.keyPem,
    cert: identity.certPem,
    minVersion: 'TLSv1.2',
  }, (req, res) => {
    handleAgentRequest(req, res, { registry, onHeartbeat, rateLimit }).catch(() => {
      try {
        sendJson(res, 500, { error: ERROR_CODES.DEVICE_INTERNAL_ERROR });
      } catch {
        // last-resort: avoid unhandled rejection if response is already closed
      }
    });
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  return server;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{
 *   registry: object,
 *   onHeartbeat: Function,
 *   rateLimit?: { check: Function },
 * }} deps
 */
async function handleAgentRequest(req, res, { registry, onHeartbeat, rateLimit }) {
  try {
    if (rateLimit) {
      const verdict = evaluateRateLimit(rateLimit, req.socket.remoteAddress || 'unknown');
      if (verdict.kind === 'error') {
        releaseRequestStream(req);
        return sendJson(res, 500, { error: ERROR_CODES.DEVICE_INTERNAL_ERROR });
      }
      if (verdict.kind === 'limit') {
        releaseRequestStream(req);
        return sendJson(
          res,
          429,
          { error: ERROR_CODES.DEVICE_RATE_LIMITED },
          rateLimitHeaders(verdict.decision),
        );
      }
      // kind === 'allow' only
    }

    const method = req.method;
    const url = req.url;

    if (method === 'POST' && url === '/agent/enroll') {
      const body = await readAgentBody(req);
      const result = await registry.consumeEnrollment({
        deviceId: body.deviceId,
        code: body.enrollmentCode,
        protocolVersion: body.protocolVersion,
      });
      return sendJson(res, 201, {
        deviceId: result.deviceId,
        deviceToken: result.token,
        protocolVersion: result.protocolVersion,
      });
    }

    if (method === 'POST' && url === '/agent/heartbeat') {
      // Auth shape (including duplicate Authorization) before body work.
      const token = bearerToken(req);
      const body = await readAgentBody(req);
      const device = await registry.authenticate({
        deviceId: body.deviceId,
        token,
        protocolVersion: body.protocolVersion,
      });
      await onHeartbeat({
        deviceId: device.deviceId,
        hostname: normalizeHostname(body.hostname),
        remoteAddress: req.socket.remoteAddress || 'unknown',
      });
      return sendJson(res, 200, { deviceId: device.deviceId, accepted: true });
    }

    if (method === 'POST' && url === '/agent/token/rotate') {
      const token = bearerToken(req);
      const body = await readAgentBody(req);
      const result = await registry.beginTokenRotation({
        deviceId: body.deviceId,
        token,
        protocolVersion: body.protocolVersion,
      });
      return sendJson(res, 200, {
        deviceId: result.deviceId,
        deviceToken: result.token,
      });
    }

    if (method === 'POST' && url === '/agent/token/rotate/confirm') {
      const token = bearerToken(req);
      const body = await readAgentBody(req);
      const result = await registry.confirmTokenRotation({
        deviceId: body.deviceId,
        token,
        protocolVersion: body.protocolVersion,
      });
      return sendJson(res, 200, {
        deviceId: result.deviceId,
        rotated: result.rotated,
      });
    }

    // Fixed route table only: never await body drain on unknown routes.
    releaseRequestStream(req);
    return sendJson(res, 404, { error: ERROR_CODES.DEVICE_ROUTE_NOT_FOUND });
  } catch (error) {
    // Auth/body failures may leave an unread stream; release without awaiting end.
    releaseRequestStream(req);
    const failure = publicFailure(error);
    return sendJson(res, failure.statusCode, { error: failure.code });
  }
}
