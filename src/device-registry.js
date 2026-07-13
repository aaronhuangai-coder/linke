import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ERROR_CODES, LinkeError } from './error-codes.js';
import { assertSupportedDeviceProtocol } from './device-protocol.js';

const ENROLLMENT_TTL_MS = 10 * 60 * 1000;
const USED_ENROLLMENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEVICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEVICE_STATUSES = new Set(['active', 'revoked', 'suspended']);

const ROOT_KEYS = Object.freeze([
  'schemaVersion',
  'controllerTlsFingerprint',
  'enrollments',
  'devices',
]);
const ENROLLMENT_KEYS = Object.freeze([
  'deviceId',
  'codeDigest',
  'issuedAt',
  'expiresAt',
  'usedAt',
]);
const DEVICE_KEYS = Object.freeze([
  'deviceId',
  'tokenDigest',
  'protocolVersion',
  'status',
  'enrolledAt',
  'rotatedAt',
  'revokedAt',
  'pendingTokenDigest',
  'pendingTokenExpiresAt',
]);

function internalError() {
  return new LinkeError(ERROR_CODES.DEVICE_INTERNAL_ERROR);
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Constant-time digest compare; illegal persisted digests never throw.
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
function digestsMatch(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (!DIGEST_PATTERN.test(left) || !DIGEST_PATTERN.test(right)) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
}

function assertDeviceId(deviceId) {
  if (typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId)) {
    throw new LinkeError(ERROR_CODES.DEVICE_SCOPE_MISMATCH, { statusCode: 400 });
  }
  return deviceId;
}

/** Normalize public request shapes so null never throws at destructuring. */
function normalizeRequest(request) {
  if (request == null || typeof request !== 'object' || Array.isArray(request)) return {};
  return request;
}

function hasExactKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== allowed.length) return false;
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return false;
  }
  return true;
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isNullableIso(value) {
  return value === null || isIsoTimestamp(value);
}

function isValidEnrollment(item) {
  if (!hasExactKeys(item, ENROLLMENT_KEYS)) return false;
  return typeof item.deviceId === 'string'
    && DEVICE_ID_PATTERN.test(item.deviceId)
    && typeof item.codeDigest === 'string'
    && DIGEST_PATTERN.test(item.codeDigest)
    && isIsoTimestamp(item.issuedAt)
    && isIsoTimestamp(item.expiresAt)
    && isNullableIso(item.usedAt);
}

function isValidDevice(item) {
  if (!hasExactKeys(item, DEVICE_KEYS)) return false;
  if (typeof item.deviceId !== 'string' || !DEVICE_ID_PATTERN.test(item.deviceId)) return false;
  if (typeof item.tokenDigest !== 'string' || !DIGEST_PATTERN.test(item.tokenDigest)) return false;
  if (!Number.isInteger(item.protocolVersion)
    || (item.protocolVersion !== 1 && item.protocolVersion !== 2)) {
    return false;
  }
  if (!DEVICE_STATUSES.has(item.status)) return false;
  if (!isIsoTimestamp(item.enrolledAt)) return false;
  if (!isNullableIso(item.rotatedAt) || !isNullableIso(item.revokedAt)) return false;

  const hasPendingDigest = item.pendingTokenDigest !== null;
  const hasPendingExpiry = item.pendingTokenExpiresAt !== null;
  if (hasPendingDigest !== hasPendingExpiry) return false;
  if (hasPendingDigest) {
    if (typeof item.pendingTokenDigest !== 'string'
      || !DIGEST_PATTERN.test(item.pendingTokenDigest)
      || !isIsoTimestamp(item.pendingTokenExpiresAt)) {
      return false;
    }
  }
  // pending rotation only meaningful while active
  if (item.status !== 'active' && hasPendingDigest) return false;
  if (item.status === 'revoked') {
    if (!isIsoTimestamp(item.revokedAt)) return false;
  } else if (item.revokedAt !== null) {
    return false;
  }
  return true;
}

function emptyState() {
  return {
    schemaVersion: 1,
    controllerTlsFingerprint: null,
    enrollments: [],
    devices: [],
  };
}

function assertValidState(state) {
  if (!hasExactKeys(state, ROOT_KEYS) || state.schemaVersion !== 1) return false;
  if (!(state.controllerTlsFingerprint === null
    || (typeof state.controllerTlsFingerprint === 'string'
      && FINGERPRINT_PATTERN.test(state.controllerTlsFingerprint)))) {
    return false;
  }
  if (!Array.isArray(state.enrollments) || !Array.isArray(state.devices)) return false;
  if (!state.enrollments.every(isValidEnrollment)) return false;
  if (!state.devices.every(isValidDevice)) return false;
  const deviceIds = state.devices.map((device) => device.deviceId);
  if (new Set(deviceIds).size !== deviceIds.length) return false;
  return true;
}

/**
 * Digest-only device enrollment, authentication, rotation and revocation registry.
 * Persists public fingerprints and SHA-256 digests only — never plaintext codes/tokens.
 */
export class DeviceRegistry {
  /**
   * @param {{
   *   dataDir: string,
   *   now?: () => Date,
   *   randomToken?: () => string,
   * }} options
   */
  constructor({
    dataDir,
    now = () => new Date(),
    randomToken = () => randomBytes(32).toString('base64url'),
  }) {
    if (!dataDir) throw new Error('dataDir is required');
    this.statePath = join(dataDir, 'device-registry-v1.json');
    this.tempPath = join(dataDir, 'device-registry-v1.json.new');
    this.dataDir = dataDir;
    this.now = now;
    this.randomToken = randomToken;
    this.mutation = Promise.resolve();
  }

  /**
   * Capture a single validated clock snapshot for one logical operation.
   * Provider throws are sanitized to device-internal-error.
   * @returns {Date}
   */
  captureNow() {
    try {
      const value = this.now();
      if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw internalError();
      return value;
    } catch (error) {
      if (error instanceof LinkeError) throw error;
      throw internalError();
    }
  }

  /**
   * Capture a validated 256-bit base64url token from the injected generator.
   * Provider throws are sanitized to device-internal-error.
   * @returns {string}
   */
  captureToken() {
    try {
      const token = this.randomToken();
      if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw internalError();
      return token;
    } catch (error) {
      if (error instanceof LinkeError) throw error;
      throw internalError();
    }
  }

  /**
   * Serialize read-modify-write mutations; rejections do not poison the queue.
   * @template T
   * @param {(state: object) => Promise<T> | T} fn
   * @returns {Promise<T>}
   */
  async mutate(fn) {
    const operation = this.mutation.then(async () => {
      try {
        const state = await this.readState();
        const result = await fn(state);
        await this.writeState(state);
        return result;
      } catch (error) {
        if (error instanceof LinkeError) throw error;
        throw internalError();
      }
    });
    this.mutation = operation.catch(() => {});
    return operation;
  }

  /**
   * Wait for queued mutations, then load durable state.
   * @returns {Promise<object>}
   */
  async loadState() {
    await this.mutation;
    return this.readState();
  }

  /**
   * Load registry state. Missing file → empty; corrupt/invalid → fail closed.
   * @returns {Promise<object>}
   */
  async readState() {
    let raw;
    try {
      raw = await readFile(this.statePath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return emptyState();
      throw internalError();
    }
    try {
      const state = JSON.parse(raw);
      if (!assertValidState(state)) throw internalError();
      return state;
    } catch (error) {
      if (error instanceof LinkeError) throw error;
      throw internalError();
    }
  }

  /**
   * Atomically publish state via same-dir temp file, forced 0600, then rename.
   * @param {object} state
   * @returns {Promise<void>}
   */
  async writeState(state) {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.tempPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    // writeFile mode is ignored for existing files; force 0600 before publish.
    await chmod(this.tempPath, 0o600);
    await rename(this.tempPath, this.statePath);
  }

  /**
   * Authenticate a token against in-memory state (token-first, then deviceId).
   * pendingOnly restricts matches to non-expired pending rotation tokens.
   * @param {object} state
   * @param {unknown} request
   * @param {Date} now
   * @returns {object}
   */
  authenticateState(state, request, now) {
    const { deviceId, token, protocolVersion, pendingOnly = false } = normalizeRequest(request);
    const scopedId = assertDeviceId(deviceId);
    assertSupportedDeviceProtocol(protocolVersion);
    if (typeof token !== 'string' || token.length === 0) {
      throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
    }
    const tokenDigest = digest(token);
    const device = state.devices.find((item) => {
      const currentMatch = !pendingOnly && digestsMatch(item.tokenDigest, tokenDigest);
      const pendingMatch = pendingOnly
        && item.pendingTokenDigest
        && item.pendingTokenExpiresAt
        && new Date(item.pendingTokenExpiresAt) >= now
        && digestsMatch(item.pendingTokenDigest, tokenDigest);
      return currentMatch || pendingMatch;
    });
    if (!device) throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 401 });
    if (device.deviceId !== scopedId) {
      throw new LinkeError(ERROR_CODES.DEVICE_SCOPE_MISMATCH, { statusCode: 403 });
    }
    if (device.protocolVersion !== protocolVersion) {
      throw new LinkeError(ERROR_CODES.DEVICE_PROTOCOL_UNSUPPORTED, { statusCode: 426 });
    }
    if (device.status === 'revoked') {
      throw new LinkeError(ERROR_CODES.DEVICE_REVOKED, { statusCode: 403 });
    }
    if (device.status !== 'active') {
      throw new LinkeError(ERROR_CODES.DEVICE_TOKEN_INVALID, { statusCode: 403 });
    }
    return device;
  }

  /**
   * Issue a single-use enrollment code (plaintext returned once; only digest persisted).
   * @param {unknown} request
   * @returns {Promise<{ deviceId: string, code: string, expiresAt: string }>}
   */
  async issueEnrollment(request) {
    const { deviceId } = normalizeRequest(request);
    const scopedId = assertDeviceId(deviceId);
    return this.mutate(async (state) => {
      const code = this.captureToken();
      const issuedAt = this.captureNow();
      const expiresAt = new Date(issuedAt.getTime() + ENROLLMENT_TTL_MS);
      const retentionCutoff = new Date(issuedAt.getTime() - USED_ENROLLMENT_RETENTION_MS);
      state.enrollments = state.enrollments.filter((item) => (
        !item.usedAt
          ? new Date(item.expiresAt) > issuedAt
          : new Date(item.usedAt) > retentionCutoff
      ));
      state.enrollments.push({
        deviceId: scopedId,
        codeDigest: digest(code),
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        usedAt: null,
      });
      return { deviceId: scopedId, code, expiresAt: expiresAt.toISOString() };
    });
  }

  /**
   * Consume a valid enrollment code and bind a new active device token.
   * @param {unknown} request
   * @returns {Promise<{ deviceId: string, token: string, protocolVersion: number }>}
   */
  async consumeEnrollment(request) {
    const { deviceId, code, protocolVersion } = normalizeRequest(request);
    const scopedId = assertDeviceId(deviceId);
    assertSupportedDeviceProtocol(protocolVersion);
    if (typeof code !== 'string') {
      throw new LinkeError(ERROR_CODES.DEVICE_ENROLLMENT_INVALID, { statusCode: 401 });
    }
    return this.mutate(async (state) => {
      const now = this.captureNow();
      const codeDigest = digest(code);
      const enrollment = state.enrollments.find((item) => (
        item.deviceId === scopedId
        && !item.usedAt
        && digestsMatch(item.codeDigest, codeDigest)
      ));
      if (!enrollment || now > new Date(enrollment.expiresAt)) {
        throw new LinkeError(ERROR_CODES.DEVICE_ENROLLMENT_INVALID, { statusCode: 401 });
      }
      const token = this.captureToken();
      enrollment.usedAt = now.toISOString();
      state.devices = state.devices.filter((device) => device.deviceId !== scopedId);
      state.devices.push({
        deviceId: scopedId,
        tokenDigest: digest(token),
        protocolVersion,
        status: 'active',
        enrolledAt: now.toISOString(),
        rotatedAt: null,
        revokedAt: null,
        pendingTokenDigest: null,
        pendingTokenExpiresAt: null,
      });
      return { deviceId: scopedId, token, protocolVersion };
    });
  }

  /**
   * Authenticate a device token (token-first lookup, then deviceId scope check).
   * @param {unknown} request
   * @returns {Promise<{ deviceId: string, protocolVersion: number }>}
   */
  async authenticate(request) {
    try {
      const state = await this.loadState();
      const now = this.captureNow();
      const device = this.authenticateState(state, request, now);
      return { deviceId: device.deviceId, protocolVersion: device.protocolVersion };
    } catch (error) {
      if (error instanceof LinkeError) throw error;
      throw internalError();
    }
  }

  /**
   * Begin two-phase token rotation; old token remains valid until confirm.
   * @param {unknown} request
   * @returns {Promise<{ deviceId: string, token: string, expiresAt: string }>}
   */
  async beginTokenRotation(request) {
    return this.mutate(async (state) => {
      const now = this.captureNow();
      const device = this.authenticateState(state, request, now);
      const token = this.captureToken();
      const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_MS);
      device.pendingTokenDigest = digest(token);
      device.pendingTokenExpiresAt = expiresAt.toISOString();
      return { deviceId: device.deviceId, token, expiresAt: device.pendingTokenExpiresAt };
    });
  }

  /**
   * Confirm a pending rotation token; old token becomes invalid.
   * @param {unknown} request
   * @returns {Promise<{ deviceId: string, rotated: true }>}
   */
  async confirmTokenRotation(request) {
    return this.mutate(async (state) => {
      const now = this.captureNow();
      const device = this.authenticateState(state, {
        ...normalizeRequest(request),
        pendingOnly: true,
      }, now);
      device.tokenDigest = device.pendingTokenDigest;
      device.pendingTokenDigest = null;
      device.pendingTokenExpiresAt = null;
      device.rotatedAt = now.toISOString();
      return { deviceId: device.deviceId, rotated: true };
    });
  }

  /**
   * Immediately revoke a device and clear any pending rotation.
   * @param {unknown} deviceId
   * @returns {Promise<{ deviceId: string, revoked: true }>}
   */
  async revokeDevice(deviceId) {
    const scopedId = assertDeviceId(deviceId);
    return this.mutate(async (state) => {
      const now = this.captureNow();
      const device = state.devices.find((item) => item.deviceId === scopedId);
      if (!device) throw new LinkeError(ERROR_CODES.DEVICE_NOT_FOUND, { statusCode: 404 });
      device.status = 'revoked';
      device.revokedAt = now.toISOString();
      device.pendingTokenDigest = null;
      device.pendingTokenExpiresAt = null;
      return { deviceId: scopedId, revoked: true };
    });
  }

  /**
   * Count devices by status after waiting for queued mutations.
   * @returns {Promise<{ active: number, revoked: number, suspended: number }>}
   */
  async getStatus() {
    try {
      const state = await this.loadState();
      return {
        active: state.devices.filter((device) => device.status === 'active').length,
        revoked: state.devices.filter((device) => device.status === 'revoked').length,
        suspended: state.devices.filter((device) => device.status === 'suspended').length,
      };
    } catch (error) {
      if (error instanceof LinkeError) throw error;
      throw internalError();
    }
  }

  /**
   * Verify controller TLS fingerprint; first bind is automatic when empty.
   * @param {unknown} fingerprint
   * @returns {Promise<true>}
   */
  async verifyControllerFingerprint(fingerprint) {
    if (typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) {
      throw new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH, { statusCode: 400 });
    }
    try {
      const state = await this.loadState();
      if (state.controllerTlsFingerprint === fingerprint) return true;
      if (state.controllerTlsFingerprint || state.devices.length > 0) {
        throw new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH, { statusCode: 409 });
      }
      await this.mutate(async (freshState) => {
        if ((freshState.controllerTlsFingerprint
          && freshState.controllerTlsFingerprint !== fingerprint)
          || (!freshState.controllerTlsFingerprint && freshState.devices.length > 0)) {
          throw new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH, { statusCode: 409 });
        }
        if (freshState.controllerTlsFingerprint === fingerprint) return true;
        freshState.controllerTlsFingerprint = fingerprint;
        return true;
      });
      return true;
    } catch (error) {
      if (error instanceof LinkeError) throw error;
      throw internalError();
    }
  }

  /**
   * Explicitly accept a new controller fingerprint and suspend all active devices.
   * @param {unknown} fingerprint
   * @returns {Promise<{ accepted: true, suspended: number }>}
   */
  async acceptControllerFingerprint(fingerprint) {
    if (typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) {
      throw new LinkeError(ERROR_CODES.DEVICE_TLS_FINGERPRINT_MISMATCH, { statusCode: 400 });
    }
    return this.mutate(async (state) => {
      state.controllerTlsFingerprint = fingerprint;
      for (const device of state.devices) {
        if (device.status === 'active') {
          device.status = 'suspended';
          device.pendingTokenDigest = null;
          device.pendingTokenExpiresAt = null;
        }
      }
      return {
        accepted: true,
        suspended: state.devices.filter((device) => device.status === 'suspended').length,
      };
    });
  }
}
