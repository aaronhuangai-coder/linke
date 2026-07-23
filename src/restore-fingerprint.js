/**
 * G0c C3 — endpoint structure/content fingerprint helpers (design §7.9).
 * No HTTP / staging / state. Fail-closed LinkeError(RESTORE_INTEGRITY_FAILED);
 * public surface never leaks path / token / errno / stack.
 */

import { createHash as defaultCreateHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as defaultFs from 'node:fs/promises';
import { join } from 'node:path';
import { ERROR_CODES, LinkeError } from './error-codes.js';

const HEX64_RE = /^[a-f0-9]{64}$/;

/**
 * @returns {never}
 */
function failIntegrity() {
  throw new LinkeError(ERROR_CODES.RESTORE_INTEGRITY_FAILED);
}

/**
 * Map any unexpected error to integrity-failed; rethrow our own.
 * @param {unknown} error
 * @returns {never}
 */
function mapError(error) {
  if (
    error instanceof LinkeError &&
    error.code === ERROR_CODES.RESTORE_INTEGRITY_FAILED
  ) {
    throw error;
  }
  failIntegrity();
}

/**
 * UTF-8 byte order compare for relative paths (deterministic, locale-free).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareUtf8Path(a, b) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i += 1) {
    if (ba[i] !== bb[i]) return ba[i] - bb[i];
  }
  return ba.length - bb.length;
}

/**
 * Read own data property without invoking getters (fail-closed on accessors).
 * @param {object} obj
 * @param {string} key
 * @returns {{ present: false } | { present: true, value: unknown }}
 */
function readOwnDataProp(obj, key) {
  let desc;
  try {
    desc = Object.getOwnPropertyDescriptor(obj, key);
  } catch {
    failIntegrity();
  }
  if (desc === undefined) return { present: false };
  if (typeof desc.get === 'function' || typeof desc.set === 'function') {
    failIntegrity();
  }
  if (!Object.prototype.hasOwnProperty.call(desc, 'value')) {
    failIntegrity();
  }
  return { present: true, value: desc.value };
}

/**
 * Resolve injectable deps without executing hostile getters.
 * @param {unknown} options
 * @returns {{ fsOps: typeof defaultFs, createHashFn: typeof defaultCreateHash }}
 */
function resolveDeps(options) {
  /** @type {typeof defaultFs} */
  let fsOps = defaultFs;
  /** @type {typeof defaultCreateHash} */
  let createHashFn = defaultCreateHash;

  if (options === undefined || options === null) {
    return { fsOps, createHashFn };
  }
  if (typeof options !== 'object') failIntegrity();

  const fsSlot = readOwnDataProp(/** @type {object} */ (options), 'fsOps');
  if (fsSlot.present) {
    if (fsSlot.value == null || typeof fsSlot.value !== 'object') failIntegrity();
    fsOps = /** @type {typeof defaultFs} */ (fsSlot.value);
  }

  const hashSlot = readOwnDataProp(/** @type {object} */ (options), 'createHash');
  if (hashSlot.present) {
    if (typeof hashSlot.value !== 'function') failIntegrity();
    createHashFn = /** @type {typeof defaultCreateHash} */ (hashSlot.value);
  }

  return { fsOps, createHashFn };
}

/**
 * @param {unknown} st
 * @returns {asserts st is import('node:fs').Stats}
 */
function assertStatShape(st) {
  if (st == null || typeof st !== 'object') failIntegrity();
  const s = /** @type {{ isSymbolicLink?: unknown, isFile?: unknown, isDirectory?: unknown, size?: unknown }} */ (
    st
  );
  if (typeof s.isSymbolicLink !== 'function') failIntegrity();
  if (typeof s.isFile !== 'function') failIntegrity();
  if (typeof s.isDirectory !== 'function') failIntegrity();
}

/**
 * @param {unknown} digest
 * @returns {string}
 */
function assertHex64(digest) {
  if (typeof digest !== 'string' || !HEX64_RE.test(digest)) failIntegrity();
  return digest;
}

/**
 * @param {unknown} createHashFn
 * @returns {import('node:crypto').Hash}
 */
function beginSha256(createHashFn) {
  if (typeof createHashFn !== 'function') failIntegrity();
  let hash;
  try {
    hash = createHashFn('sha256');
  } catch {
    failIntegrity();
  }
  if (
    hash == null ||
    typeof hash !== 'object' ||
    typeof /** @type {{ update?: unknown }} */ (hash).update !== 'function' ||
    typeof /** @type {{ digest?: unknown }} */ (hash).digest !== 'function'
  ) {
    failIntegrity();
  }
  return /** @type {import('node:crypto').Hash} */ (hash);
}

/**
 * @param {import('node:crypto').Hash} hash
 * @returns {string}
 */
function finalizeSha256(hash) {
  let digest;
  try {
    digest = hash.digest('hex');
  } catch {
    failIntegrity();
  }
  return assertHex64(digest);
}

/**
 * No-follow recursive walk. Only regular files and directories.
 * @param {string} rootDir
 * @param {typeof defaultFs} fsOps
 * @returns {Promise<{
 *   files: Array<{ relativePath: string, size: number, absPath: string }>,
 *   dirs: Array<{ relativePath: string }>,
 * }>}
 */
async function walkTree(rootDir, fsOps) {
  if (typeof rootDir !== 'string' || rootDir.length === 0) failIntegrity();
  if (fsOps == null || typeof fsOps !== 'object') failIntegrity();
  if (typeof fsOps.lstat !== 'function' || typeof fsOps.readdir !== 'function') {
    failIntegrity();
  }

  /** @type {Array<{ relativePath: string, size: number, absPath: string }>} */
  const files = [];
  /** @type {Array<{ relativePath: string }>} */
  const dirs = [];

  let rootStat;
  try {
    rootStat = await fsOps.lstat(rootDir);
  } catch (error) {
    mapError(error);
  }
  assertStatShape(rootStat);
  if (rootStat.isSymbolicLink()) failIntegrity();
  if (!rootStat.isDirectory()) failIntegrity();

  /**
   * @param {string} absDir
   * @param {string} relDir
   */
  async function visitDir(absDir, relDir) {
    let names;
    try {
      names = await fsOps.readdir(absDir);
    } catch (error) {
      mapError(error);
    }
    if (!Array.isArray(names)) failIntegrity();

    for (let i = 0; i < names.length; i += 1) {
      const name = names[i];
      if (typeof name !== 'string' || name.length === 0) failIntegrity();
      if (name === '.' || name === '..') failIntegrity();
      if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
        failIntegrity();
      }

      const absPath = join(absDir, name);
      const relativePath = relDir === '' ? name : `${relDir}/${name}`;

      let st;
      try {
        st = await fsOps.lstat(absPath);
      } catch (error) {
        mapError(error);
      }
      assertStatShape(st);

      if (st.isSymbolicLink()) failIntegrity();

      if (st.isFile()) {
        const size = st.size;
        if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
          failIntegrity();
        }
        files.push({ relativePath, size, absPath });
      } else if (st.isDirectory()) {
        dirs.push({ relativePath });
        await visitDir(absPath, relativePath);
      } else {
        // FIFO, socket, device, etc.
        failIntegrity();
      }
    }
  }

  await visitDir(rootDir, '');
  return { files, dirs };
}

/**
 * Structure fingerprint from sorted path/type/size metadata only.
 *
 * @param {string} rootDir
 * @param {{ fsOps?: typeof defaultFs, createHash?: typeof defaultCreateHash }} [options]
 * @returns {Promise<string>} 64-char lowercase hex
 */
export async function computeStructureFingerprint(rootDir, options = {}) {
  try {
    const { fsOps, createHashFn } = resolveDeps(options);
    const { files, dirs } = await walkTree(rootDir, fsOps);

    /** @type {Array<Record<string, string | number>>} */
    const records = [];
    for (let i = 0; i < dirs.length; i += 1) {
      // Fixed key order: relativePath, type
      records.push({ relativePath: dirs[i].relativePath, type: 'dir' });
    }
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i];
      // Fixed key order: relativePath, size, type
      records.push({
        relativePath: f.relativePath,
        size: f.size,
        type: 'file',
      });
    }
    records.sort((a, b) =>
      compareUtf8Path(/** @type {string} */ (a.relativePath), /** @type {string} */ (b.relativePath)),
    );

    const payload = JSON.stringify(records);
    const hash = beginSha256(createHashFn);
    try {
      hash.update(payload, 'utf8');
    } catch {
      failIntegrity();
    }
    return finalizeSha256(hash);
  } catch (error) {
    mapError(error);
  }
}

/**
 * Content digest over sorted regular files: path · NUL · sizeBE64 · bytes.
 * Empty tree → SHA-256 of empty input.
 *
 * @param {string} rootDir
 * @param {{ fsOps?: typeof defaultFs, createHash?: typeof defaultCreateHash }} [options]
 * @returns {Promise<string>} 64-char lowercase hex
 */
export async function computeContentSha256(rootDir, options = {}) {
  try {
    const { fsOps, createHashFn } = resolveDeps(options);
    if (typeof fsOps.open !== 'function') failIntegrity();

    const { files } = await walkTree(rootDir, fsOps);
    const sorted = files.slice().sort((a, b) => compareUtf8Path(a.relativePath, b.relativePath));

    const hash = beginSha256(createHashFn);

    for (let i = 0; i < sorted.length; i += 1) {
      const f = sorted[i];
      try {
        hash.update(Buffer.from(f.relativePath, 'utf8'));
        hash.update(Buffer.from([0]));
        const sizeBuf = Buffer.alloc(8);
        sizeBuf.writeBigUInt64BE(BigInt(f.size), 0);
        hash.update(sizeBuf);
      } catch {
        failIntegrity();
      }

      let handle;
      try {
        handle = await fsOps.open(
          f.absPath,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        mapError(error);
      }

      try {
        let data;
        try {
          data = await handle.readFile();
        } catch (error) {
          mapError(error);
        }
        if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) {
          failIntegrity();
        }
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (buf.length !== f.size) failIntegrity();
        try {
          hash.update(buf);
        } catch {
          failIntegrity();
        }
      } finally {
        try {
          await handle.close();
        } catch {
          // close errors still fail closed after body
        }
      }
    }

    return finalizeSha256(hash);
  } catch (error) {
    mapError(error);
  }
}
