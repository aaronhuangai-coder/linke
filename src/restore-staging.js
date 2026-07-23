/**
 * G0c C3 — restore staging helpers (design §§6.3–6.4, 10.4, 12.5).
 * No HTTP / publish / state. Fail-closed LinkeError only.
 * Public surface never leaks path / errno / token; Error.stack left intact.
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { types as utilTypes } from 'node:util';
import { ERROR_CODES, LinkeError } from './error-codes.js';
import {
  assertSnapshotRootRelativeFilePath,
  assertStrictRelativeTarget,
} from './restore-path.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const MI_64 = 64 * 1024 * 1024;

const PREFLIGHT_KEYS = Object.freeze([
  'restoreRoot',
  'relativeTarget',
  'taskId',
]);
const MATERIALIZE_KEYS = Object.freeze([
  'stagingRoot',
  'filePath',
  'chunkIndex',
  'chunkSize',
  'bytes',
  'expectedSha256',
]);
const VERIFY_KEYS = Object.freeze(['stagingRoot', 'files']);
const CAPACITY_KEYS = Object.freeze([
  'remainingStagingBytes',
  'totalBytes',
  'freeBytes',
]);
const FILE_ENTRY_KEYS = Object.freeze(['path', 'size', 'sha256']);
const SIBLING_KEYS = Object.freeze([
  'stagingName',
  'anchorName',
  'quarantineName',
]);
const PREFLIGHT_RESULT_KEYS = Object.freeze([
  'targetPathAbs',
  'parentPathAbs',
  'stagingPathAbs',
  'anchorPathAbs',
  'quarantinePathAbs',
  'originalTargetExisted',
  'parentDev',
  'targetDev',
]);

/**
 * @returns {never}
 */
function failTaskInvalid() {
  throw new LinkeError(ERROR_CODES.RESTORE_TASK_INVALID);
}

/**
 * @returns {never}
 */
function failPathInvalid() {
  throw new LinkeError(ERROR_CODES.RESTORE_PATH_INVALID);
}

/**
 * @returns {never}
 */
function failIntegrity() {
  throw new LinkeError(ERROR_CODES.RESTORE_INTEGRITY_FAILED);
}

/**
 * @returns {never}
 */
function failCapacity() {
  throw new LinkeError(ERROR_CODES.RESTORE_CAPACITY_INSUFFICIENT);
}

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isPlainRecord(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  try {
    if (utilTypes.isProxy(value)) return false;
  } catch {
    return false;
  }
  let proto;
  try {
    proto = Object.getPrototypeOf(value);
  } catch {
    return false;
  }
  return proto === Object.prototype || proto === null;
}

/**
 * Exact own enumerable string data properties only (no symbols/getters/setters).
 * Never executes getters. Fail-closed on Proxy/class instances/unknown keys.
 *
 * @param {unknown} value
 * @param {ReadonlyArray<string>} exactKeys
 * @returns {Record<string, unknown> | null}
 */
function readExactOwnDataFields(value, exactKeys) {
  try {
    if (!isPlainRecord(value)) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== exactKeys.length) return null;
    /** @type {Record<string, unknown>} */
    const out = Object.create(null);
    for (const key of ownKeys) {
      if (typeof key !== 'string') return null;
      if (!exactKeys.includes(key)) return null;
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc || desc.enumerable !== true) return null;
      if (desc.get !== undefined || desc.set !== undefined) return null;
      if (!Object.prototype.hasOwnProperty.call(desc, 'value')) return null;
      out[key] = desc.value;
    }
    for (const key of exactKeys) {
      if (!Object.prototype.hasOwnProperty.call(out, key)) return null;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertTaskId(value) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) failTaskInvalid();
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function assertSha256Lower(value) {
  if (typeof value !== 'string' || !SHA256_HEX_RE.test(value)) failIntegrity();
  return value;
}

/**
 * Safe integer ≥ 0.
 * @param {unknown} value
 * @returns {number}
 */
function assertSafeNonNegInt(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    failTaskInvalid();
  }
  return value;
}

/**
 * Safe integer ≥ 0 (integrity error surface).
 * @param {unknown} value
 * @returns {number}
 */
function assertSafeNonNegIntIntegrity(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    failIntegrity();
  }
  return value;
}

/**
 * Safe integer > 0 (integrity error surface).
 * @param {unknown} value
 * @returns {number}
 */
function assertSafePosIntIntegrity(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    failIntegrity();
  }
  return value;
}

/**
 * Multiply two non-negative safe ints with overflow → null.
 * @param {number} a
 * @param {number} b
 * @returns {number | null}
 */
function safeMul(a, b) {
  if (a === 0 || b === 0) return 0;
  if (a > Number.MAX_SAFE_INTEGER / b) return null;
  const product = a * b;
  if (!Number.isSafeInteger(product)) return null;
  return product;
}

/**
 * Add two non-negative safe ints with overflow → null.
 * @param {number} a
 * @param {number} b
 * @returns {number | null}
 */
function safeAdd(a, b) {
  if (a > Number.MAX_SAFE_INTEGER - b) return null;
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) return null;
  return sum;
}

/**
 * @param {Buffer} bytes
 * @returns {string}
 */
function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Assert absolute existing non-symlink directory.
 * @param {unknown} root
 * @returns {Promise<string>}
 */
async function assertExistingSafeDir(root) {
  if (typeof root !== 'string' || root.length === 0) return /** @type {never} */ (failPathInvalid());
  if (root.includes('\0')) failPathInvalid();
  if (!isAbsolute(root)) failPathInvalid();
  const resolvedRoot = resolve(root);
  let st;
  try {
    st = await lstat(resolvedRoot);
  } catch {
    failPathInvalid();
  }
  if (st.isSymbolicLink() || !st.isDirectory()) failPathInvalid();
  return resolvedRoot;
}

/**
 * Integrity-surface staging root check.
 * @param {unknown} root
 * @returns {Promise<string>}
 */
async function assertStagingRoot(root) {
  if (typeof root !== 'string' || root.length === 0) failIntegrity();
  if (root.includes('\0')) failIntegrity();
  if (!isAbsolute(root)) failIntegrity();
  const resolvedRoot = resolve(root);
  let st;
  try {
    st = await lstat(resolvedRoot);
  } catch {
    failIntegrity();
  }
  if (st.isSymbolicLink() || !st.isDirectory()) failIntegrity();
  return resolvedRoot;
}

/**
 * Ensure path stays strictly under root (or equals root).
 * @param {string} rootAbs
 * @param {string} candidateAbs
 * @returns {boolean}
 */
function isUnderRoot(rootAbs, candidateAbs) {
  if (candidateAbs === rootAbs) return true;
  return candidateAbs.startsWith(rootAbs + sep);
}

/**
 * Map C1 path errors to integrity for materialize/verify surfaces.
 * @param {() => string} fn
 * @returns {string}
 */
function mapPathToIntegrity(fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof LinkeError) failIntegrity();
    failIntegrity();
  }
}

/**
 * Derive frozen sibling directory basenames from taskId.
 * @param {unknown} taskId
 * @returns {{ stagingName: string, anchorName: string, quarantineName: string }}
 */
export function deriveSiblingNames(taskId) {
  const id = assertTaskId(taskId);
  const names = {
    stagingName: `.${id}.linke-restore-staging`,
    anchorName: `.${id}.linke-restore-anchor`,
    quarantineName: `.${id}.linke-restore-quarantine`,
  };
  // Freeze exact shape (key order matches design; tests sort keys).
  Object.freeze(names);
  for (const key of SIBLING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(names, key)) failTaskInvalid();
  }
  return names;
}

/**
 * Read-only preflight for restore target placement.
 * Returns in-process abs paths only — never persists them.
 *
 * @param {unknown} input
 * @returns {Promise<{
 *   targetPathAbs: string,
 *   parentPathAbs: string,
 *   stagingPathAbs: string,
 *   anchorPathAbs: string,
 *   quarantinePathAbs: string,
 *   originalTargetExisted: boolean,
 *   parentDev: number,
 *   targetDev: number | null,
 * }>}
 */
export async function preflightTarget(input) {
  const fields = readExactOwnDataFields(input, PREFLIGHT_KEYS);
  if (fields === null) failPathInvalid();

  const restoreRootRaw = fields.restoreRoot;
  const relativeTargetRaw = fields.relativeTarget;
  const taskIdRaw = fields.taskId;

  // taskId must be valid UUID; preflight surface is sole PATH_INVALID.
  if (typeof taskIdRaw !== 'string' || !UUID_RE.test(taskIdRaw)) failPathInvalid();
  const taskId = taskIdRaw;

  let relativeTarget;
  try {
    relativeTarget = assertStrictRelativeTarget(relativeTargetRaw);
  } catch (error) {
    if (error instanceof LinkeError) failPathInvalid();
    failPathInvalid();
  }

  const resolvedRoot = await assertExistingSafeDir(restoreRootRaw);

  const segments = relativeTarget.split('/');
  const leaf = segments[segments.length - 1];
  const parentSegments = segments.slice(0, -1);

  // Walk root + all ancestors of target (parent chain); no symlink, must be dirs.
  let current = resolvedRoot;
  for (const segment of parentSegments) {
    current = join(current, segment);
    if (!isUnderRoot(resolvedRoot, current)) failPathInvalid();
    let st;
    try {
      st = await lstat(current);
    } catch {
      failPathInvalid();
    }
    if (st.isSymbolicLink() || !st.isDirectory()) failPathInvalid();
  }

  const parentPathAbs = current;
  let parentStat;
  try {
    parentStat = await lstat(parentPathAbs);
  } catch {
    failPathInvalid();
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) failPathInvalid();
  const parentDev = parentStat.dev;

  const targetPathAbs = join(parentPathAbs, leaf);
  if (!isUnderRoot(resolvedRoot, targetPathAbs)) failPathInvalid();
  // Lexical escape guard via resolve as well.
  const resolvedTarget = resolve(targetPathAbs);
  if (!isUnderRoot(resolvedRoot, resolvedTarget)) failPathInvalid();
  if (resolvedTarget !== targetPathAbs && resolve(join(resolvedRoot, relativeTarget)) !== resolvedTarget) {
    // Keep strict: resolved form must match join under root.
    const expected = resolve(join(resolvedRoot, relativeTarget));
    if (expected !== resolvedTarget || !isUnderRoot(resolvedRoot, expected)) failPathInvalid();
  }

  /** @type {boolean} */
  let originalTargetExisted = false;
  /** @type {number | null} */
  let targetDev = null;

  try {
    const targetStat = await lstat(targetPathAbs);
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) failPathInvalid();
    if (targetStat.dev !== parentDev) failPathInvalid();
    originalTargetExisted = true;
    targetDev = targetStat.dev;
  } catch (error) {
    if (error instanceof LinkeError) throw error;
    // ENOENT → absent target; any other I/O → path invalid.
    if (!error || /** @type {{ code?: string }} */ (error).code !== 'ENOENT') {
      failPathInvalid();
    }
    originalTargetExisted = false;
    targetDev = null;
  }

  // Future siblings are derived only — never stat'd / created.
  const names = deriveSiblingNames(taskId);
  const stagingPathAbs = join(parentPathAbs, names.stagingName);
  const anchorPathAbs = join(parentPathAbs, names.anchorName);
  const quarantinePathAbs = join(parentPathAbs, names.quarantineName);

  const result = {
    targetPathAbs: resolve(targetPathAbs),
    parentPathAbs: resolve(parentPathAbs),
    stagingPathAbs: resolve(stagingPathAbs),
    anchorPathAbs: resolve(anchorPathAbs),
    quarantinePathAbs: resolve(quarantinePathAbs),
    originalTargetExisted,
    parentDev,
    targetDev,
  };
  Object.freeze(result);
  // Ensure exact key set (tests sort keys).
  const keys = Object.keys(result);
  if (keys.length !== PREFLIGHT_RESULT_KEYS.length) failPathInvalid();
  return result;
}

/**
 * Ensure no-follow directory chain under stagingRoot with mode 0700.
 * @param {string} stagingRoot
 * @param {string[]} dirSegments
 * @returns {Promise<string>} absolute parent directory for the file
 */
async function ensureStagingDirs(stagingRoot, dirSegments) {
  let current = stagingRoot;
  for (const segment of dirSegments) {
    current = join(current, segment);
    if (!isUnderRoot(stagingRoot, current)) failIntegrity();
    let st;
    try {
      st = await lstat(current);
    } catch (error) {
      if (!error || /** @type {{ code?: string }} */ (error).code !== 'ENOENT') {
        failIntegrity();
      }
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (
          !mkdirError
          || /** @type {{ code?: string }} */ (mkdirError).code !== 'EEXIST'
        ) {
          failIntegrity();
        }
      }
      try {
        st = await lstat(current);
      } catch {
        failIntegrity();
      }
    }
    if (st.isSymbolicLink() || !st.isDirectory()) failIntegrity();
  }
  return current;
}

/**
 * Materialize one chunk into the staging tree (no-follow, fsynced).
 *
 * @param {unknown} input
 * @returns {Promise<void>}
 */
export async function materializeChunkToStaging(input) {
  const fields = readExactOwnDataFields(input, MATERIALIZE_KEYS);
  if (fields === null) failIntegrity();

  const stagingRoot = await assertStagingRoot(fields.stagingRoot);

  const filePath = mapPathToIntegrity(() =>
    assertSnapshotRootRelativeFilePath(fields.filePath),
  );

  const chunkIndex = assertSafeNonNegIntIntegrity(fields.chunkIndex);
  const chunkSize = assertSafePosIntIntegrity(fields.chunkSize);

  if (!Buffer.isBuffer(fields.bytes)) failIntegrity();
  const bytes = /** @type {Buffer} */ (fields.bytes);
  if (bytes.length > chunkSize) failIntegrity();

  const expectedSha256 = assertSha256Lower(fields.expectedSha256);
  const actualSha = sha256Hex(bytes);
  if (actualSha !== expectedSha256) failIntegrity();

  const offset = safeMul(chunkIndex, chunkSize);
  if (offset === null) failIntegrity();
  const end = safeAdd(offset, bytes.length);
  if (end === null) failIntegrity();

  const segments = filePath.split('/');
  const fileName = segments[segments.length - 1];
  const dirSegments = segments.slice(0, -1);
  const parentAbs = await ensureStagingDirs(stagingRoot, dirSegments);
  const absolutePath = join(parentAbs, fileName);
  if (!isUnderRoot(stagingRoot, absolutePath)) failIntegrity();

  // Pre-check leaf type (symlink / dir / non-regular) without following.
  let leafExists = false;
  try {
    const leafStat = await lstat(absolutePath);
    leafExists = true;
    if (leafStat.isSymbolicLink() || !leafStat.isFile()) failIntegrity();
  } catch (error) {
    if (error instanceof LinkeError) throw error;
    if (!error || /** @type {{ code?: string }} */ (error).code !== 'ENOENT') {
      failIntegrity();
    }
  }

  /** @type {import('node:fs/promises').FileHandle} */
  let handle;
  try {
    if (leafExists) {
      handle = await open(
        absolutePath,
        constants.O_RDWR | constants.O_NOFOLLOW,
      );
    } else {
      handle = await open(
        absolutePath,
        constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );
    }
  } catch (error) {
    if (error instanceof LinkeError) throw error;
    failIntegrity();
  }

  try {
    const st = await handle.stat();
    if (!st.isFile() || st.isSymbolicLink()) failIntegrity();
    const size = Number(st.size);
    if (!Number.isSafeInteger(size) || size < 0) failIntegrity();

    if (size > offset) {
      const existingLen = Math.min(bytes.length, size - offset);
      if (existingLen > 0) {
        const existing = Buffer.alloc(existingLen);
        const { bytesRead } = await handle.read(existing, 0, existingLen, offset);
        if (bytesRead !== existingLen) failIntegrity();
        if (size >= end) {
          // Full range present — require exact match for idempotency.
          if (existingLen !== bytes.length || !existing.equals(bytes)) {
            failIntegrity();
          }
          // Identical content: done (no rewrite).
          return;
        }
        // Partial prior write at this range: require prefix match then complete.
        if (!bytes.subarray(0, existingLen).equals(existing)) {
          failIntegrity();
        }
      }
    }

    if (bytes.length > 0) {
      const { bytesWritten } = await handle.write(bytes, 0, bytes.length, offset);
      if (bytesWritten !== bytes.length) failIntegrity();
    }

    await handle.sync();
  } catch (error) {
    if (error instanceof LinkeError) throw error;
    failIntegrity();
  } finally {
    try {
      await handle.close();
    } catch {
      // close failure after success path still maps to integrity if not yet thrown
    }
  }
}

/**
 * Dense array check (no holes) of plain objects.
 * @param {unknown} value
 * @returns {unknown[] | null}
 */
function readDenseArray(value) {
  if (!Array.isArray(value)) return null;
  if (utilTypes.isProxy(value)) return null;
  const len = value.length;
  if (!Number.isSafeInteger(len) || len < 0) return null;
  /** @type {unknown[]} */
  const out = [];
  for (let i = 0; i < len; i += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, i)) return null;
    out.push(value[i]);
  }
  return out;
}

/**
 * No-follow recursive list of regular files under stagingRoot.
 * @param {string} stagingRoot
 * @returns {Promise<Map<string, string>>} relativePath → absolutePath
 */
async function listStagingFiles(stagingRoot) {
  /** @type {Map<string, string>} */
  const files = new Map();

  /**
   * @param {string} absDir
   * @param {string} relDir
   */
  async function walk(absDir, relDir) {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      failIntegrity();
    }
    for (const entry of entries) {
      const name = entry.name;
      if (name === '.' || name === '..') continue;
      const abs = join(absDir, name);
      const rel = relDir === '' ? name : `${relDir}/${name}`;
      let st;
      try {
        st = await lstat(abs);
      } catch {
        failIntegrity();
      }
      if (st.isSymbolicLink()) failIntegrity();
      if (st.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      if (!st.isFile()) failIntegrity();
      if (files.has(rel)) failIntegrity();
      files.set(rel, abs);
    }
  }

  await walk(stagingRoot, '');
  return files;
}

/**
 * Verify staging tree exactly matches the dense files list.
 *
 * @param {unknown} input
 * @returns {Promise<void>}
 */
export async function verifyStagingTree(input) {
  const fields = readExactOwnDataFields(input, VERIFY_KEYS);
  if (fields === null) failIntegrity();

  const stagingRoot = await assertStagingRoot(fields.stagingRoot);
  const dense = readDenseArray(fields.files);
  if (dense === null) failIntegrity();

  /** @type {Map<string, { size: number, sha256: string }>} */
  const expected = new Map();
  for (const entry of dense) {
    const entryFields = readExactOwnDataFields(entry, FILE_ENTRY_KEYS);
    if (entryFields === null) failIntegrity();
    const path = mapPathToIntegrity(() =>
      assertSnapshotRootRelativeFilePath(entryFields.path),
    );
    const size = assertSafeNonNegIntIntegrity(entryFields.size);
    const sha256 = assertSha256Lower(entryFields.sha256);
    if (expected.has(path)) failIntegrity();
    expected.set(path, { size, sha256 });
  }

  const actual = await listStagingFiles(stagingRoot);

  if (actual.size !== expected.size) failIntegrity();
  for (const rel of expected.keys()) {
    if (!actual.has(rel)) failIntegrity();
  }
  for (const rel of actual.keys()) {
    if (!expected.has(rel)) failIntegrity();
  }

  for (const [rel, abs] of actual) {
    const exp = expected.get(rel);
    if (!exp) failIntegrity();
    let st;
    try {
      st = await lstat(abs);
    } catch {
      failIntegrity();
    }
    if (st.isSymbolicLink() || !st.isFile()) failIntegrity();
    if (!Number.isSafeInteger(st.size) || st.size !== exp.size) failIntegrity();

    let content;
    try {
      // Open no-follow then read; reject type swap races.
      const handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const fst = await handle.stat();
        if (!fst.isFile() || fst.isSymbolicLink()) failIntegrity();
        if (fst.size !== exp.size) failIntegrity();
        content = await handle.readFile();
      } finally {
        await handle.close().catch(() => {});
      }
    } catch (error) {
      if (error instanceof LinkeError) throw error;
      failIntegrity();
    }

    if (!Buffer.isBuffer(content) || content.length !== exp.size) failIntegrity();
    if (sha256Hex(content) !== exp.sha256) failIntegrity();
  }
}

/**
 * Capacity gate: required = remainingStagingBytes + max(64MiB, ceil(totalBytes*0.05)).
 * Synchronous void; freeBytes === null or freeBytes < required → CAPACITY_INSUFFICIENT.
 *
 * @param {unknown} input
 * @returns {void}
 */
export function assertCapacity(input) {
  const fields = readExactOwnDataFields(input, CAPACITY_KEYS);
  if (fields === null) failTaskInvalid();

  const remainingStagingBytes = assertSafeNonNegInt(fields.remainingStagingBytes);
  const totalBytes = assertSafeNonNegInt(fields.totalBytes);

  const freeRaw = fields.freeBytes;
  if (freeRaw !== null) {
    if (typeof freeRaw !== 'number' || !Number.isSafeInteger(freeRaw) || freeRaw < 0) {
      failTaskInvalid();
    }
  }

  // reserve = max(64MiB, ceil(totalBytes * 0.05))
  // Use integer arithmetic to avoid float edge cases where possible.
  const fivePercent = Math.ceil(totalBytes * 0.05);
  if (!Number.isSafeInteger(fivePercent) || fivePercent < 0) failTaskInvalid();
  const reserve = fivePercent > MI_64 ? fivePercent : MI_64;
  if (!Number.isSafeInteger(reserve)) failTaskInvalid();

  const required = safeAdd(remainingStagingBytes, reserve);
  if (required === null) failTaskInvalid();

  if (freeRaw === null) failCapacity();
  const freeBytes = /** @type {number} */ (freeRaw);
  if (freeBytes < required) failCapacity();
}
