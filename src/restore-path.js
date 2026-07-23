/**
 * Pure strict relative path validators for G0c restore (design §§7.6–7.7).
 * No I/O, no path resolution, no logging. Fail-closed LinkeError only.
 */

import { ERROR_CODES, LinkeError } from './error-codes.js';

const MAX_PATH_UTF8_BYTES = 1024;

/**
 * @returns {never}
 */
function failPathInvalid() {
  throw new LinkeError(ERROR_CODES.RESTORE_PATH_INVALID);
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function hasDisallowedControls(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    // C0 (0x00-0x1F), DEL (0x7F), C1 (0x80-0x9F)
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/**
 * Shared pure validator for restore relativeTarget and snapshot-root file paths.
 * Returns the original string unchanged (no normalize/collapse).
 * @param {unknown} input
 * @returns {string}
 */
function assertStrictRelativePath(input) {
  if (typeof input !== 'string') failPathInvalid();
  if (input.length === 0) failPathInvalid();
  if (input.includes('\\')) failPathInvalid();
  if (input.startsWith('/')) failPathInvalid();
  if (hasDisallowedControls(input)) failPathInvalid();
  if (Buffer.byteLength(input, 'utf8') > MAX_PATH_UTF8_BYTES) failPathInvalid();
  if (input.includes('//') || input.endsWith('/')) failPathInvalid();

  const segments = input.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') failPathInvalid();
    if (hasDisallowedControls(segment)) failPathInvalid();
  }
  // Strict: split/join must not alter semantics (rejects unnormalized inputs).
  if (segments.join('/') !== input) failPathInvalid();
  return input;
}

/**
 * Strict relativeTarget path (restoreRoot-relative directory target).
 * @param {unknown} input
 * @returns {string}
 */
export function assertStrictRelativeTarget(input) {
  return assertStrictRelativePath(input);
}

/**
 * Snapshot-root-relative file path (manifest files[].path style).
 * @param {unknown} input
 * @returns {string}
 */
export function assertSnapshotRootRelativeFilePath(input) {
  return assertStrictRelativePath(input);
}
