import { createHash, timingSafeEqual } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { DEVICE_PROTOCOL_VERSION } from './device-protocol.js';
import { ERROR_CODES, LinkeError, assertRegisteredErrorCode } from './error-codes.js';

/** Maximum accepted JSON response body size for pinned client requests (bytes). */
export const MAX_PINNED_JSON_RESPONSE_BYTES = 64 * 1024;

/** Maximum allowed request timeout for pinned client requests (ms). */
export const MAX_PINNED_REQUEST_TIMEOUT_MS = 300_000;

/**
 * Normalize a certificate SHA-256 fingerprint to lowercase 64 hex.
 * Accepts optional colon separators and mixed case.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeFingerprint(value) {
  const normalized = String(value || '').replaceAll(':', '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH, { statusCode: 400 });
  }
  return normalized;
}

/**
 * Safely serialize a request body to JSON string.
 * Any stringify failure maps to a fixed registered error without leaking structure.
 * @param {unknown} body
 * @returns {string}
 */
function serializeRequestBody(body) {
  let serialized;
  try {
    serialized = JSON.stringify(body);
  } catch {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID);
  }
  if (typeof serialized !== 'string') {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID);
  }
  return serialized;
}

/**
 * Validate timeoutMs as a positive finite integer within the hard upper bound.
 * Must run before any request/socket is created.
 * @param {unknown} timeoutMs
 * @returns {number}
 */
function normalizeTimeoutMs(timeoutMs) {
  if (!Number.isInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > MAX_PINNED_REQUEST_TIMEOUT_MS) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID);
  }
  return timeoutMs;
}

/**
 * True only for explicit HTTP success status codes 200–299.
 * @param {unknown} statusCode
 * @returns {boolean}
 */
function isSuccessStatus(statusCode) {
  return Number.isInteger(statusCode) && statusCode >= 200 && statusCode <= 299;
}

/**
 * Parse and validate a safe HTTPS Agent URL.
 * Rejects credentials, query, hash, non-HTTPS, and unparseable input without echoing it.
 * @param {unknown} agentUrl
 * @returns {URL}
 */
function parseAgentUrl(agentUrl) {
  let url;
  try {
    url = new URL(String(agentUrl ?? ''));
  } catch {
    throw new LinkeError(ERROR_CODES.DEVICE_TLS_BIND_INVALID, { statusCode: 400 });
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new LinkeError(ERROR_CODES.DEVICE_TLS_BIND_INVALID, { statusCode: 400 });
  }
  if (!url.hostname) {
    throw new LinkeError(ERROR_CODES.DEVICE_TLS_BIND_INVALID, { statusCode: 400 });
  }
  return url;
}

/**
 * Map non-success HTTP status to a LinkeError using only registered codes
 * and safe 400–599 status values.
 * @param {number} statusCode
 * @param {unknown} response
 * @returns {LinkeError}
 */
function errorFromHttpResponse(statusCode, response) {
  if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) {
    return new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID);
  }
  let publicCode = ERROR_CODES.DEVICE_REQUEST_INVALID;
  if (response && typeof response === 'object' && 'error' in response) {
    try {
      publicCode = assertRegisteredErrorCode(
        /** @type {{ error?: unknown }} */ (response).error,
      );
    } catch {
      publicCode = ERROR_CODES.DEVICE_REQUEST_INVALID;
    }
  }
  return new LinkeError(publicCode, { statusCode });
}

/**
 * Fail-closed public client error that never echoes raw system text.
 * @returns {LinkeError}
 */
function requestInvalidError() {
  return new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID);
}

/**
 * True for plain JSON objects only (not null, arrays, or scalars).
 * Must run before reading any response field.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainResponseObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Ensure credentialStore exposes the required methods before Keychain/network use.
 * @param {unknown} credentialStore
 * @param {string[]} methodNames
 */
function assertCredentialStore(credentialStore, methodNames) {
  if (!credentialStore || typeof credentialStore !== 'object') {
    throw requestInvalidError();
  }
  for (const name of methodNames) {
    if (typeof /** @type {Record<string, unknown>} */ (credentialStore)[name] !== 'function') {
      throw requestInvalidError();
    }
  }
}

/**
 * Keychain-backed endpoint token store; item names contain no host or token material.
 * Account/item id is `device-token.` + SHA-256(agentUrl + NUL + deviceId) hex prefix (32).
 */
export class DeviceCredentialStore {
  /**
   * @param {{ keychain: { get: Function, set: Function, delete?: Function } }} options
   */
  constructor({ keychain }) {
    if (!keychain) throw new Error('keychain is required');
    this.keychain = keychain;
  }

  /**
   * Derive the Keychain item id for an endpoint token.
   * @param {string} agentUrl
   * @param {string} deviceId
   * @returns {string}
   */
  itemId(agentUrl, deviceId) {
    const id = createHash('sha256')
      .update(`${agentUrl}\0${deviceId}`)
      .digest('hex')
      .slice(0, 32);
    return `device-token.${id}`;
  }

  /**
   * Read the stored device token for agentUrl + deviceId.
   * @param {string} agentUrl
   * @param {string} deviceId
   * @returns {Promise<string>}
   */
  getToken(agentUrl, deviceId) {
    return this.keychain.get(this.itemId(agentUrl, deviceId));
  }

  /**
   * Upsert the device token for agentUrl + deviceId.
   * @param {string} agentUrl
   * @param {string} deviceId
   * @param {string} token
   * @returns {Promise<void>}
   */
  setToken(agentUrl, deviceId, token) {
    return this.keychain.set(this.itemId(agentUrl, deviceId), token);
  }
}

/**
 * POST JSON only after the peer certificate exactly matches the approved SHA-256 pin.
 * `rejectUnauthorized: false` is paired with mandatory certificate pinning; the request
 * body is never written until the pin succeeds on `secureConnect`.
 * @param {{
 *   agentUrl: string,
 *   path: string,
 *   tlsFingerprint: string,
 *   body: unknown,
 *   token?: string,
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<unknown>}
 */
export function requestPinnedJson({
  agentUrl,
  path,
  tlsFingerprint,
  body,
  token,
  timeoutMs = 10_000,
}) {
  // Validate URL, fingerprint, body, and timeout before opening any socket.
  const url = parseAgentUrl(agentUrl);
  const expected = Buffer.from(normalizeFingerprint(tlsFingerprint), 'hex');
  const serialized = serializeRequestBody(body);
  const safeTimeoutMs = normalizeTimeoutMs(timeoutMs);
  return new Promise((resolve, reject) => {
    let pinned = false;
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const failClosed = (error) => {
      settle(() => reject(error instanceof LinkeError ? error : requestInvalidError()));
    };

    let req;
    try {
      req = httpsRequest({
        protocol: 'https:',
        hostname: url.hostname,
        port: url.port || 443,
        path,
        method: 'POST',
        agent: false,
        rejectUnauthorized: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(serialized),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      }, (res) => {
        const chunks = [];
        let totalBytes = 0;
        let oversized = false;
        res.on('data', (chunk) => {
          if (oversized) return;
          const buffer = Buffer.from(chunk);
          totalBytes += buffer.length;
          if (totalBytes > MAX_PINNED_JSON_RESPONSE_BYTES) {
            oversized = true;
            chunks.length = 0;
            res.destroy();
            failClosed(requestInvalidError());
            return;
          }
          chunks.push(buffer);
        });
        res.on('end', () => {
          if (oversized) return;
          if (!pinned) {
            failClosed(new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH));
            return;
          }
          let response;
          try {
            response = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            failClosed(requestInvalidError());
            return;
          }
          if (!isSuccessStatus(res.statusCode)) {
            failClosed(errorFromHttpResponse(res.statusCode, response));
            return;
          }
          settle(() => resolve(response));
        });
        res.on('error', () => failClosed(requestInvalidError()));
      });
    } catch {
      failClosed(requestInvalidError());
      return;
    }

    // Install error listener before setTimeout/socket so any subsequent emit is handled.
    req.once('error', (error) => failClosed(error));
    try {
      req.setTimeout(safeTimeoutMs, () => {
        req.destroy(requestInvalidError());
      });
      req.once('socket', (socket) => {
        socket.once('secureConnect', () => {
          try {
            const raw = socket.getPeerCertificate(true)?.raw;
            const actual = raw ? createHash('sha256').update(raw).digest() : Buffer.alloc(0);
            if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
              req.destroy(new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH));
              return;
            }
            pinned = true;
            req.end(serialized);
          } catch {
            req.destroy(new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH));
          }
        });
      });
    } catch {
      try {
        req.destroy(requestInvalidError());
      } catch {
        // ignore destroy failures; failClosed still settles the promise
      }
      failClosed(requestInvalidError());
    }
  });
}

/**
 * Enroll a device over a certificate-pinned Agent URL.
 * Writes the returned token to Keychain only after full response validation.
 * The return value never includes enrollment codes or device tokens.
 * @param {{
 *   agentUrl: string,
 *   tlsFingerprint: string,
 *   deviceId: string,
 *   enrollmentCode: string,
 *   credentialStore: { setToken: Function },
 * }} options
 * @returns {Promise<{ deviceId: string, enrolled: true, protocolVersion: number }>}
 */
export async function enrollDevice({
  agentUrl,
  tlsFingerprint,
  deviceId,
  enrollmentCode,
  credentialStore,
}) {
  assertCredentialStore(credentialStore, ['setToken']);
  const response = await requestPinnedJson({
    agentUrl,
    path: '/agent/enroll',
    tlsFingerprint,
    body: {
      deviceId,
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      enrollmentCode,
    },
  });
  if (!isPlainResponseObject(response)
    || response.deviceId !== deviceId
    || response.protocolVersion !== DEVICE_PROTOCOL_VERSION
    || typeof response.deviceToken !== 'string'
    || response.deviceToken.length < 32) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID);
  }
  await credentialStore.setToken(agentUrl, deviceId, response.deviceToken);
  return {
    deviceId,
    enrolled: true,
    protocolVersion: /** @type {number} */ (response.protocolVersion),
  };
}

/**
 * Send an authenticated device heartbeat using the Keychain-stored token.
 * Missing or empty tokens fail closed before any network write.
 * @param {{
 *   agentUrl: string,
 *   tlsFingerprint: string,
 *   deviceId: string,
 *   hostname?: string,
 *   credentialStore: { getToken: Function },
 * }} options
 * @returns {Promise<{ deviceId: string, accepted: true }>}
 */
export async function heartbeatDevice({
  agentUrl,
  tlsFingerprint,
  deviceId,
  hostname,
  credentialStore,
}) {
  assertCredentialStore(credentialStore, ['getToken']);
  const token = await credentialStore.getToken(agentUrl, deviceId);
  if (typeof token !== 'string' || token.length === 0) {
    throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
  }
  const response = await requestPinnedJson({
    agentUrl,
    path: '/agent/heartbeat',
    tlsFingerprint,
    token,
    body: {
      deviceId,
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      hostname,
    },
  });
  if (!isPlainResponseObject(response)
    || response.deviceId !== deviceId
    || response.accepted !== true) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID);
  }
  return { deviceId, accepted: true };
}

/**
 * Strictly validate a token-rotation confirm response shape.
 * @param {unknown} confirmed
 * @param {string} deviceId
 */
function assertRotationConfirmed(confirmed, deviceId) {
  if (!isPlainResponseObject(confirmed)
    || confirmed.deviceId !== deviceId
    || confirmed.rotated !== true) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID);
  }
}

/**
 * Confirm rotation using a candidate token (pending or just-issued pending).
 * @param {{
 *   agentUrl: string,
 *   tlsFingerprint: string,
 *   deviceId: string,
 *   token: string,
 * }} options
 * @returns {Promise<{ deviceId: string, rotated: true }>}
 */
async function confirmDeviceTokenRotation({
  agentUrl,
  tlsFingerprint,
  deviceId,
  token,
}) {
  const confirmed = await requestPinnedJson({
    agentUrl,
    path: '/agent/token/rotate/confirm',
    tlsFingerprint,
    token,
    body: {
      deviceId,
      protocolVersion: DEVICE_PROTOCOL_VERSION,
    },
  });
  assertRotationConfirmed(confirmed, deviceId);
  return { deviceId, rotated: true };
}

/**
 * Rotate a device token: begin with current token, store pending, confirm with pending.
 * Begin failure keeps the old token; Keychain write failure never confirms;
 * confirm failure retains the pending token for the server retry window.
 * If begin returns device-token-invalid, treat the Keychain token as a possible
 * prior pending and retry confirm once (recovery path).
 * @param {{
 *   agentUrl: string,
 *   tlsFingerprint: string,
 *   deviceId: string,
 *   credentialStore: { getToken: Function, setToken: Function },
 * }} options
 * @returns {Promise<{ deviceId: string, rotated: true }>}
 */
export async function rotateDeviceToken({
  agentUrl,
  tlsFingerprint,
  deviceId,
  credentialStore,
}) {
  assertCredentialStore(credentialStore, ['getToken', 'setToken']);
  const currentToken = await credentialStore.getToken(agentUrl, deviceId);
  if (typeof currentToken !== 'string' || currentToken.length === 0) {
    throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
  }

  let pending;
  try {
    pending = await requestPinnedJson({
      agentUrl,
      path: '/agent/token/rotate',
      tlsFingerprint,
      token: currentToken,
      body: {
        deviceId,
        protocolVersion: DEVICE_PROTOCOL_VERSION,
      },
    });
  } catch (error) {
    // Begin only accepts the current/old token. If Keychain still holds a prior
    // pending token after a failed confirm, begin returns device-token-invalid —
    // recover by confirming with that same Keychain token inside the retry window.
    if (error instanceof LinkeError && error.code === ERROR_CODES.DEVICE_TOKEN_INVALID) {
      return confirmDeviceTokenRotation({
        agentUrl,
        tlsFingerprint,
        deviceId,
        token: currentToken,
      });
    }
    throw error;
  }

  if (!isPlainResponseObject(pending)
    || pending.deviceId !== deviceId
    || typeof pending.deviceToken !== 'string'
    || pending.deviceToken.length < 32) {
    throw new LinkeError(ERROR_CODES.DEVICE_REQUEST_INVALID);
  }
  await credentialStore.setToken(agentUrl, deviceId, pending.deviceToken);
  return confirmDeviceTokenRotation({
    agentUrl,
    tlsFingerprint,
    deviceId,
    token: /** @type {string} */ (pending.deviceToken),
  });
}
