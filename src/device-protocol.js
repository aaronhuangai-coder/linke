import { ERROR_CODES, LinkeError } from './error-codes.js';

/** Current device protocol version. */
export const DEVICE_PROTOCOL_VERSION = 2;

/** Minimum accepted device protocol version (current N-1). */
export const MIN_DEVICE_PROTOCOL_VERSION = DEVICE_PROTOCOL_VERSION - 1;

/**
 * Accept the current and N-1 integer protocol versions; reject every other value.
 * @param {unknown} version
 * @returns {number}
 */
export function assertSupportedDeviceProtocol(version) {
  if (!Number.isInteger(version)
    || version < MIN_DEVICE_PROTOCOL_VERSION
    || version > DEVICE_PROTOCOL_VERSION) {
    throw new LinkeError(ERROR_CODES.DEVICE_PROTOCOL_UNSUPPORTED, { statusCode: 426 });
  }
  return version;
}
