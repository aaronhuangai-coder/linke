/**
 * Pure canonical manifest v2 projection for G0b resumable snapshot upload.
 * No I/O. Controller-authoritative digest. Fail-closed LinkeError only.
 */

import { createHash } from 'node:crypto';
import { ERROR_CODES, LinkeError } from './error-codes.js';

/** @type {Readonly<{
 *   MAX_FILE_COUNT: number,
 *   MAX_PATH_UTF8_BYTES: number,
 *   MAX_FILE_SIZE_BYTES: number,
 *   MAX_MANIFEST_JSON_UTF8_BYTES: number,
 *   MAX_HOSTNAME_UTF8_BYTES: number,
 *   MAX_SOURCE_PATH_UTF8_BYTES: number,
 * }>} */
export const UPLOAD_MANIFEST_LIMITS = Object.freeze({
  MAX_FILE_COUNT: 100_000,
  MAX_PATH_UTF8_BYTES: 1024,
  MAX_FILE_SIZE_BYTES: 512 * 1024 ** 3,
  MAX_MANIFEST_JSON_UTF8_BYTES: 8 * 1024 * 1024,
  MAX_HOSTNAME_UTF8_BYTES: 255,
  MAX_SOURCE_PATH_UTF8_BYTES: 4096,
});

const SNAPSHOT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
/** Drive-like absolute forms (`C:/x`, `c:`, `C:foo`) — not platform-resolved. */
const DRIVE_LIKE_RE = /^[A-Za-z]:/;
/**
 * Strict repeatable ISO-UTC: `YYYY-MM-DDTHH:mm:ssZ` or `YYYY-MM-DDTHH:mm:ss.sssZ`
 * (4-digit year, exactly 3 fractional digits when present, Z only).
 */
const STRICT_ISO_UTC_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;

const TOP_REQUIRED = Object.freeze([
  'schemaVersion',
  'snapshotId',
  'deviceId',
  'createdAt',
  'files',
  'integrity',
]);
const TOP_OPTIONAL = Object.freeze(['hostname', 'sourcePath']);
const TOP_ALLOWED = new Set([...TOP_REQUIRED, ...TOP_OPTIONAL]);
const INTEGRITY_KEYS = Object.freeze(['algorithm', 'totalBytes', 'entries']);
const ENTRY_KEYS = Object.freeze(['path', 'size', 'sha256']);
const OPTIONS_ALLOWED = new Set(['authenticatedDeviceId', 'claimedManifestDigest']);

/** Exact-key max ownKeys bounds (early stop before descriptor loop). */
const MAX_TOP_KEYS = 8;
const MAX_INTEGRITY_KEYS = 3;
const MAX_ENTRY_KEYS = 3;
const MAX_OPTIONS_KEYS = 2;

/**
 * @returns {never}
 */
function failManifestInvalid() {
  throw new LinkeError(ERROR_CODES.UPLOAD_MANIFEST_INVALID, {
    statusCode: 400,
    retryable: false,
  });
}

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isPlainRecord(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Exact own enumerable string data properties only (no symbols/getters/setters).
 * Reflect.ownKeys once; immediately reject ownKeys.length > maxKeys before any
 * getOwnPropertyDescriptor / O(n) copy loop (DoS early stop).
 *
 * @param {unknown} value
 * @param {number} maxKeys
 * @returns {Record<string, unknown> | null}
 */
function readOwnStringDataFields(value, maxKeys) {
  try {
    if (!isPlainRecord(value)) return null;
    if (typeof maxKeys !== 'number' || !Number.isSafeInteger(maxKeys) || maxKeys < 0) {
      return null;
    }
    const ownKeys = Reflect.ownKeys(value);
    // Early key-count bound — before descriptor inspection / value copy.
    if (ownKeys.length > maxKeys) return null;
    /** @type {Record<string, unknown>} */
    const out = Object.create(null);
    for (const key of ownKeys) {
      if (typeof key === 'symbol') return null;
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc || desc.enumerable !== true) return null;
      if (desc.get !== undefined || desc.set !== undefined) return null;
      out[key] = desc.value;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Dense array via own data descriptors only; never invokes index getters.
 * Early-bound: after reading a safe integer length, reject length > maxLength
 * before Reflect.ownKeys and before any O(length) allocation/loop (DoS guard).
 *
 * @param {unknown} value
 * @param {number} maxLength
 * @returns {unknown[] | null}
 */
function readDenseArrayDescriptorValues(value, maxLength) {
  try {
    if (!Array.isArray(value)) return null;
    if (typeof maxLength !== 'number' || !Number.isSafeInteger(maxLength) || maxLength < 0) {
      return null;
    }
    const lengthDesc = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDesc || lengthDesc.get !== undefined || lengthDesc.set !== undefined) {
      return null;
    }
    const length = lengthDesc.value;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
      return null;
    }
    // Early bound — before ownKeys / expected-keys construction / index loops.
    if (length > maxLength) return null;

    const keys = Reflect.ownKeys(value);
    /** @type {string[]} */
    const expected = [];
    for (let i = 0; i < length; i += 1) expected.push(String(i));
    expected.push('length');
    if (keys.length !== expected.length) return null;
    for (let i = 0; i < expected.length; i += 1) {
      if (keys[i] !== expected[i]) return null;
    }
    /** @type {unknown[]} */
    const out = [];
    for (let i = 0; i < length; i += 1) {
      const desc = Object.getOwnPropertyDescriptor(value, String(i));
      if (!desc || desc.enumerable !== true) return null;
      if (desc.get !== undefined || desc.set !== undefined) return null;
      out.push(desc.value);
    }
    return out;
  } catch {
    return null;
  }
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
 * Reject unpaired UTF-16 surrogates so Buffer UTF-8 encoding cannot replace
 * distinct paths with U+FFFD and collapse order/digest.
 * @param {string} value
 * @returns {boolean}
 */
function hasUnpairedSurrogate(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      // high surrogate must be followed by a low surrogate
      if (i + 1 >= value.length) return true;
      const low = value.charCodeAt(i + 1);
      if (low < 0xdc00 || low > 0xdfff) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // lone low surrogate
      return true;
    }
  }
  return false;
}

/**
 * Safe relative manifest path: non-empty, no absolute/drive-like/backslash/NUL/controls,
 * no empty/dot/dotdot segments, no unpaired surrogates, UTF-8 bytes ≤ 1024.
 * Returns original string (no platform resolve/normalize).
 * @param {unknown} path
 * @returns {string}
 */
export function assertSafeManifestPath(path) {
  if (typeof path !== 'string' || path.length === 0) failManifestInvalid();
  if (path.includes('\0') || path.includes('\\')) failManifestInvalid();
  if (hasDisallowedControls(path)) failManifestInvalid();
  if (hasUnpairedSurrogate(path)) failManifestInvalid();
  if (path.startsWith('/')) failManifestInvalid();
  if (DRIVE_LIKE_RE.test(path)) failManifestInvalid();
  // Reject absolute-looking forms without platform resolve.
  if (path === '.' || path === '..') failManifestInvalid();
  if (path.startsWith('./') || path.startsWith('../')) failManifestInvalid();
  if (path.endsWith('/') || path.includes('//')) failManifestInvalid();
  if (Buffer.byteLength(path, 'utf8') > UPLOAD_MANIFEST_LIMITS.MAX_PATH_UTF8_BYTES) {
    failManifestInvalid();
  }
  const segments = path.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') failManifestInvalid();
    if (segment.includes('\0') || hasDisallowedControls(segment)) failManifestInvalid();
    if (hasUnpairedSurrogate(segment)) failManifestInvalid();
  }
  if (segments.join('/') !== path) failManifestInvalid();
  return path;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertNonEmptySafeString(value) {
  if (typeof value !== 'string' || value.length === 0) failManifestInvalid();
  if (value.includes('\0') || hasDisallowedControls(value)) failManifestInvalid();
  if (hasUnpairedSurrogate(value)) failManifestInvalid();
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertSnapshotId(value) {
  if (typeof value !== 'string' || value.length === 0) failManifestInvalid();
  if (hasUnpairedSurrogate(value)) failManifestInvalid();
  const lower = value.toLowerCase();
  if (!SNAPSHOT_ID_RE.test(lower)) failManifestInvalid();
  return lower;
}

/**
 * Lock createdAt to repeatable canonical ISO UTC.
 * Accepts only strict `…ssZ` or `…ss.sssZ`; then Date.parse + toISOString must equal
 * the input itself or the input with only `.000` inserted. Illegal calendars that roll
 * under Date (e.g. Feb 30) fail the equality check. All Date/toISOString failures map
 * to LinkeError (never leak native RangeError).
 *
 * @param {unknown} value
 * @returns {string}
 */
function assertCanonicalCreatedAt(value) {
  if (typeof value !== 'string' || value.length === 0) failManifestInvalid();
  if (!STRICT_ISO_UTC_RE.test(value)) failManifestInvalid();
  // Expected canonical always has exactly 3 fractional digits.
  const expectedCanonical = value.includes('.')
    ? value
    : value.replace(/Z$/, '.000Z');
  try {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) failManifestInvalid();
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) failManifestInvalid();
    const canonical = date.toISOString();
    if (canonical !== expectedCanonical) failManifestInvalid();
    return canonical;
  } catch {
    failManifestInvalid();
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertHostname(value) {
  if (typeof value !== 'string' || value.length === 0) failManifestInvalid();
  if (hasDisallowedControls(value)) failManifestInvalid();
  if (hasUnpairedSurrogate(value)) failManifestInvalid();
  if (Buffer.byteLength(value, 'utf8') > UPLOAD_MANIFEST_LIMITS.MAX_HOSTNAME_UTF8_BYTES) {
    failManifestInvalid();
  }
  return value;
}

/**
 * Opaque sourcePath only — never resolve/open/stat/normalize via fs.
 * Optional means omitted or non-empty string; empty string is invalid.
 * @param {unknown} value
 * @returns {string}
 */
function assertSourcePath(value) {
  if (typeof value !== 'string' || value.length === 0) failManifestInvalid();
  if (hasUnpairedSurrogate(value)) failManifestInvalid();
  if (Buffer.byteLength(value, 'utf8') > UPLOAD_MANIFEST_LIMITS.MAX_SOURCE_PATH_UTF8_BYTES) {
    failManifestInvalid();
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertSha256Hex(value) {
  if (typeof value !== 'string' || !SHA256_HEX_RE.test(value)) failManifestInvalid();
  return value;
}

/**
 * @param {unknown} value
 * @param {{ min?: number, max?: number }} [bounds]
 * @returns {number}
 */
function assertSafeIntegerInRange(value, bounds = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) failManifestInvalid();
  if (bounds.min !== undefined && value < bounds.min) failManifestInvalid();
  if (bounds.max !== undefined && value > bounds.max) failManifestInvalid();
  return value;
}

/**
 * @param {unknown} entryRaw
 * @returns {{ path: string, size: number, sha256: string }}
 */
function projectEntry(entryRaw) {
  const fields = readOwnStringDataFields(entryRaw, MAX_ENTRY_KEYS);
  if (!fields) failManifestInvalid();
  const keys = Object.keys(fields);
  if (keys.length !== ENTRY_KEYS.length) failManifestInvalid();
  for (const key of ENTRY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) failManifestInvalid();
  }
  for (const key of keys) {
    if (!ENTRY_KEYS.includes(key)) failManifestInvalid();
  }
  const path = assertSafeManifestPath(fields.path);
  const size = assertSafeIntegerInRange(fields.size, {
    min: 0,
    max: UPLOAD_MANIFEST_LIMITS.MAX_FILE_SIZE_BYTES,
  });
  const sha256 = assertSha256Hex(fields.sha256);
  return { path, size, sha256 };
}

/**
 * Definite UTF-8 byte length of a value as it appears in JSON.stringify output.
 * Used only for non-overestimating lower-bound budgets (never a coarse upper bound).
 * @param {unknown} value
 * @returns {number}
 */
function jsonUtf8Bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Accumulate a definite canonical-byte lower bound; fail-close when already > 8MiB.
 * Only adds bytes that MUST appear in the final JSON (never overestimates).
 * @param {{ bytes: number }} budget
 * @param {number} add
 */
function addDefiniteCanonicalBudget(budget, add) {
  if (typeof add !== 'number' || !Number.isSafeInteger(add) || add < 0) {
    failManifestInvalid();
  }
  const next = budget.bytes + add;
  if (!Number.isSafeInteger(next)) failManifestInvalid();
  budget.bytes = next;
  if (budget.bytes > UPLOAD_MANIFEST_LIMITS.MAX_MANIFEST_JSON_UTF8_BYTES) {
    failManifestInvalid();
  }
}

/**
 * Sort path strings by precomputed UTF-8 buffers (one Buffer per path; comparator
 * only Buffer.compare — no per-comparison Buffer.from).
 * @param {string[]} paths
 * @returns {string[]}
 */
function sortPathsByUtf8Cached(paths) {
  /** @type {{ path: string, utf8: Buffer }[]} */
  const decorated = new Array(paths.length);
  for (let i = 0; i < paths.length; i += 1) {
    const path = paths[i];
    decorated[i] = { path, utf8: Buffer.from(path, 'utf8') };
  }
  decorated.sort((a, b) => Buffer.compare(a.utf8, b.utf8));
  /** @type {string[]} */
  const out = new Array(decorated.length);
  for (let i = 0; i < decorated.length; i += 1) {
    out[i] = decorated[i].path;
  }
  return out;
}

/**
 * Sort entries by path UTF-8 with one Buffer per path; strip cache from output.
 * @param {{ path: string, size: number, sha256: string }[]} entries
 * @returns {{ path: string, size: number, sha256: string }[]}
 */
function sortEntriesByUtf8Cached(entries) {
  /** @type {{ path: string, size: number, sha256: string, utf8: Buffer }[]} */
  const decorated = new Array(entries.length);
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    decorated[i] = {
      path: e.path,
      size: e.size,
      sha256: e.sha256,
      utf8: Buffer.from(e.path, 'utf8'),
    };
  }
  decorated.sort((a, b) => Buffer.compare(a.utf8, b.utf8));
  /** @type {{ path: string, size: number, sha256: string }[]} */
  const out = new Array(decorated.length);
  for (let i = 0; i < decorated.length; i += 1) {
    const e = decorated[i];
    out[i] = { path: e.path, size: e.size, sha256: e.sha256 };
  }
  return out;
}

/**
 * Sum entry sizes with overflow fail-close (must stay Number.isSafeInteger).
 * @param {readonly { size: number }[]} entries
 * @returns {number}
 */
function sumEntrySizesSafe(entries) {
  let totalSum = 0;
  for (const entry of entries) {
    const next = totalSum + entry.size;
    if (!Number.isSafeInteger(next)) failManifestInvalid();
    totalSum = next;
  }
  return totalSum;
}

/**
 * Deep-freeze a plain object tree (arrays + plain objects).
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const key of Object.keys(value)) {
      deepFreeze(/** @type {Record<string, unknown>} */ (value)[key]);
    }
  }
  return value;
}

/**
 * Exact-key plain options: authenticatedDeviceId required, claimedManifestDigest optional.
 * Descriptor-only; no getters; no extra/symbol keys; maxKeys=2 early stop.
 * @param {unknown} options
 * @returns {{ authenticatedDeviceId: string, claimedManifestDigest?: unknown }}
 */
function readExactOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    failManifestInvalid();
  }
  const fields = readOwnStringDataFields(options, MAX_OPTIONS_KEYS);
  if (!fields) failManifestInvalid();
  for (const key of Object.keys(fields)) {
    if (!OPTIONS_ALLOWED.has(key)) failManifestInvalid();
  }
  if (!Object.prototype.hasOwnProperty.call(fields, 'authenticatedDeviceId')) {
    failManifestInvalid();
  }
  const authenticatedDeviceId = assertNonEmptySafeString(fields.authenticatedDeviceId);
  /** @type {{ authenticatedDeviceId: string, claimedManifestDigest?: unknown }} */
  const out = { authenticatedDeviceId };
  if (Object.prototype.hasOwnProperty.call(fields, 'claimedManifestDigest')) {
    out.claimedManifestDigest = fields.claimedManifestDigest;
  }
  return out;
}

/**
 * Project client input to controller-authoritative canonical upload manifest v2.
 *
 * files[] and integrity.entries[] are projected and UTF-8-byte-sorted independently,
 * then required to match pairwise by path (design §5.2).
 *
 * @param {unknown} input
 * @param {{
 *   authenticatedDeviceId: unknown,
 *   claimedManifestDigest?: unknown,
 * }} [options]
 * @returns {{ manifest: object, manifestDigest: string }}
 */
export function projectCanonicalUploadManifest(input, options = {}) {
  const { authenticatedDeviceId, claimedManifestDigest } = readExactOptions(options);

  const top = readOwnStringDataFields(input, MAX_TOP_KEYS);
  if (!top) failManifestInvalid();

  for (const key of Object.keys(top)) {
    if (!TOP_ALLOWED.has(key)) failManifestInvalid();
  }
  for (const key of TOP_REQUIRED) {
    if (!Object.prototype.hasOwnProperty.call(top, key)) failManifestInvalid();
  }

  if (top.schemaVersion !== 2) failManifestInvalid();
  const snapshotId = assertSnapshotId(top.snapshotId);
  if (typeof top.deviceId !== 'string') failManifestInvalid();
  if (top.deviceId !== authenticatedDeviceId) failManifestInvalid();
  const deviceId = top.deviceId;
  const createdAt = assertCanonicalCreatedAt(top.createdAt);

  let hostname;
  if (Object.prototype.hasOwnProperty.call(top, 'hostname')) {
    hostname = assertHostname(top.hostname);
  }
  let sourcePath;
  if (Object.prototype.hasOwnProperty.call(top, 'sourcePath')) {
    sourcePath = assertSourcePath(top.sourcePath);
  }

  const integrityFields = readOwnStringDataFields(top.integrity, MAX_INTEGRITY_KEYS);
  if (!integrityFields) failManifestInvalid();
  for (const key of Object.keys(integrityFields)) {
    if (!INTEGRITY_KEYS.includes(key)) failManifestInvalid();
  }
  for (const key of INTEGRITY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(integrityFields, key)) failManifestInvalid();
  }
  if (integrityFields.algorithm !== 'sha256') failManifestInvalid();

  const maxFiles = UPLOAD_MANIFEST_LIMITS.MAX_FILE_COUNT;
  const filesRaw = readDenseArrayDescriptorValues(top.files, maxFiles);
  if (!filesRaw) failManifestInvalid();
  const entriesRaw = readDenseArrayDescriptorValues(integrityFields.entries, maxFiles);
  if (!entriesRaw) failManifestInvalid();
  if (filesRaw.length !== entriesRaw.length) failManifestInvalid();

  // Definite lower-bound budget over bytes that must appear in canonical JSON:
  // each path twice (files[] + entries[].path) + entry sha256 + entry size.
  // Never uses length*MAX_PATH (would false-reject many short paths).
  // Checked before UTF-8 sort Buffer cache and before full JSON.stringify.
  /** @type {{ bytes: number }} */
  const definiteBudget = { bytes: 0 };

  // Independent projection of files (path strings only).
  /** @type {string[]} */
  const filesProjected = [];
  for (let i = 0; i < filesRaw.length; i += 1) {
    if (typeof filesRaw[i] !== 'string') failManifestInvalid();
    const filePath = assertSafeManifestPath(filesRaw[i]);
    // files[] JSON string contribution
    addDefiniteCanonicalBudget(definiteBudget, jsonUtf8Bytes(filePath));
    filesProjected.push(filePath);
  }

  // Independent projection of entries.
  /** @type {{ path: string, size: number, sha256: string }[]} */
  const entriesProjected = [];
  for (let i = 0; i < entriesRaw.length; i += 1) {
    const entry = projectEntry(entriesRaw[i]);
    // entries[].path + sha256 + size (definite JSON fragments)
    addDefiniteCanonicalBudget(definiteBudget, jsonUtf8Bytes(entry.path));
    addDefiniteCanonicalBudget(definiteBudget, jsonUtf8Bytes(entry.sha256));
    addDefiniteCanonicalBudget(definiteBudget, jsonUtf8Bytes(entry.size));
    entriesProjected.push(entry);
  }

  // Early reject before any sort-cache Buffer.from when lower bound already exceeds 8MiB.
  if (definiteBudget.bytes > UPLOAD_MANIFEST_LIMITS.MAX_MANIFEST_JSON_UTF8_BYTES) {
    failManifestInvalid();
  }

  const filesSorted = sortPathsByUtf8Cached(filesProjected);
  for (let i = 1; i < filesSorted.length; i += 1) {
    if (filesSorted[i] === filesSorted[i - 1]) failManifestInvalid();
  }

  const entriesSorted = sortEntriesByUtf8Cached(entriesProjected);
  for (let i = 1; i < entriesSorted.length; i += 1) {
    if (entriesSorted[i].path === entriesSorted[i - 1].path) failManifestInvalid();
  }

  // After independent sorts: equal length and exact path pairwise match.
  if (filesSorted.length !== entriesSorted.length) failManifestInvalid();
  for (let i = 0; i < filesSorted.length; i += 1) {
    if (filesSorted[i] !== entriesSorted[i].path) failManifestInvalid();
  }

  const totalSum = sumEntrySizesSafe(entriesSorted);
  const declaredTotal = assertSafeIntegerInRange(integrityFields.totalBytes, {
    min: 0,
  });
  if (declaredTotal !== totalSum) failManifestInvalid();

  // Fixed canonical key insertion order (design §5.2). No sort-cache fields.
  /** @type {Record<string, unknown>} */
  const manifest = {
    schemaVersion: 2,
    snapshotId,
    deviceId,
    createdAt,
  };
  if (hostname !== undefined) manifest.hostname = hostname;
  manifest.files = filesSorted;
  manifest.integrity = {
    algorithm: 'sha256',
    totalBytes: totalSum,
    entries: entriesSorted.map((e) => ({
      path: e.path,
      size: e.size,
      sha256: e.sha256,
    })),
  };
  if (sourcePath !== undefined) manifest.sourcePath = sourcePath;

  const json = JSON.stringify(manifest);
  if (Buffer.byteLength(json, 'utf8') > UPLOAD_MANIFEST_LIMITS.MAX_MANIFEST_JSON_UTF8_BYTES) {
    failManifestInvalid();
  }
  const manifestDigest = createHash('sha256').update(json, 'utf8').digest('hex');

  if (claimedManifestDigest !== undefined) {
    if (typeof claimedManifestDigest !== 'string' || !SHA256_HEX_RE.test(claimedManifestDigest)) {
      failManifestInvalid();
    }
    if (claimedManifestDigest !== manifestDigest) failManifestInvalid();
  }

  deepFreeze(manifest);
  return { manifest, manifestDigest };
}
