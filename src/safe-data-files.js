import { constants } from 'node:fs';
import {
  lstat as defaultLstat,
  mkdir as defaultMkdir,
  open as defaultOpen,
  rename as defaultRename,
  unlink as defaultUnlink,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readdir as defaultReaddir } from 'node:fs/promises';

/** Registered path-free error code for safe data-file operations. */
export const SAFE_DATA_FILE_ERROR = 'safe-data-file-error';

/**
 * Default upper bound for safe text reads (bytes).
 * Intentionally capped at 16 MiB for registry/audit/TLS text; do not raise as an
 * unbounded in-memory substitute. Backup binary payloads use a separate copy bound.
 */
export const DEFAULT_MAX_READ_BYTES = 16 * 1024 * 1024;

/** Upper bound for a single root-relative binary hash/read used by snapshot integrity. */
export const DEFAULT_MAX_HASH_BYTES = 512 * 1024 * 1024;

/**
 * Path-free fail-closed error for dataDir-relative I/O.
 * Never embeds path, content, or underlying system messages.
 */
export class SafeDataFileError extends Error {
  constructor() {
    super(SAFE_DATA_FILE_ERROR);
    this.name = 'SafeDataFileError';
    this.code = SAFE_DATA_FILE_ERROR;
  }
}

function fail() {
  throw new SafeDataFileError();
}

/**
 * @typedef {{
 *   lstat?: typeof defaultLstat,
 *   mkdir?: typeof defaultMkdir,
 *   open?: typeof defaultOpen,
 *   rename?: typeof defaultRename,
 *   unlink?: typeof defaultUnlink,
 *   readdir?: typeof defaultReaddir,
 * }} SafeDataFileDeps
 */

/**
 * @param {SafeDataFileDeps} [deps]
 */
function resolveDeps(deps = {}) {
  return {
    lstat: deps.lstat || defaultLstat,
    mkdir: deps.mkdir || defaultMkdir,
    open: deps.open || defaultOpen,
    rename: deps.rename || defaultRename,
    unlink: deps.unlink || defaultUnlink,
    readdir: deps.readdir || defaultReaddir,
  };
}

/**
 * Validate and normalize a root-relative data path.
 * Rejects absolute, empty, `.`, `..`, NUL, and any segment traversal.
 * @param {unknown} relativePath
 * @returns {string}
 */
export function normalizeRelativeDataPath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) fail();
  if (relativePath.includes('\0')) fail();
  if (isAbsolute(relativePath)) fail();
  if (relativePath === '.' || relativePath === '..') fail();
  // Disallow Windows separators and mixed forms that normalize away intent.
  if (relativePath.includes('\\')) fail();
  if (relativePath.startsWith('/') || relativePath.startsWith('./') || relativePath.startsWith('../')) {
    fail();
  }
  if (relativePath.endsWith('/') || relativePath.includes('//')) fail();

  const segments = relativePath.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') fail();
    if (segment.includes('\0')) fail();
  }

  // Reject any normalize-style collapse without allowing path.normalize side effects.
  if (segments.join('/') !== relativePath) fail();
  return relativePath;
}

/**
 * Assert dataDir root is a non-symlink directory.
 * Only inspects the final path component via lstat, so already-created macOS tmp
 * roots under `/var/folders/...` (where `/var` is a system alias) are accepted.
 * @param {unknown} root
 * @param {SafeDataFileDeps} [deps]
 * @returns {Promise<string>} resolved absolute root
 */
export async function assertSafeDataRoot(root, deps = {}) {
  if (typeof root !== 'string' || root.length === 0) fail();
  if (root.includes('\0')) fail();
  const { lstat } = resolveDeps(deps);
  const resolvedRoot = resolve(root);
  let st;
  try {
    st = await lstat(resolvedRoot);
  } catch {
    fail();
  }
  if (st.isSymbolicLink() || !st.isDirectory()) fail();
  return resolvedRoot;
}

/**
 * Ensure a dataDir root exists as a non-symlink directory.
 * Existing roots are accepted via final-component lstat only (macOS `/var` alias safe).
 * Missing roots are created from the nearest existing non-symlink ancestor using
 * non-recursive mkdir + re-lstat per segment — never `mkdir({ recursive: true })`,
 * so a synthetic direct/intermediate ancestor symlink fails closed with no outside
 * directory creation.
 * @param {unknown} root
 * @param {SafeDataFileDeps} [deps]
 * @returns {Promise<string>} resolved absolute root
 */
export async function ensureSafeDataRoot(root, deps = {}) {
  if (typeof root !== 'string' || root.length === 0) fail();
  if (root.includes('\0')) fail();
  const { lstat, mkdir } = resolveDeps(deps);
  const resolvedRoot = resolve(root);

  try {
    const st = await lstat(resolvedRoot);
    if (st.isSymbolicLink() || !st.isDirectory()) fail();
    return resolvedRoot;
  } catch (error) {
    if (error instanceof SafeDataFileError) throw error;
    if (!error || error.code !== 'ENOENT') fail();
  }

  /** @type {string[]} */
  const missingSegments = [];
  let cursor = resolvedRoot;
  for (;;) {
    const parent = dirname(cursor);
    if (parent === cursor) fail();
    const segment = basename(cursor);
    if (!segment || segment === '.' || segment === '..') fail();
    missingSegments.unshift(segment);
    try {
      const parentStat = await lstat(parent);
      if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) fail();
      cursor = parent;
      break;
    } catch (error) {
      if (error instanceof SafeDataFileError) throw error;
      if (!error || error.code !== 'ENOENT') fail();
      cursor = parent;
    }
  }

  for (const segment of missingSegments) {
    cursor = join(cursor, segment);
    try {
      await mkdir(cursor);
    } catch (error) {
      if (!error || error.code !== 'EEXIST') fail();
    }
    let st;
    try {
      st = await lstat(cursor);
    } catch {
      fail();
    }
    if (st.isSymbolicLink() || !st.isDirectory()) fail();
  }

  if (cursor !== resolvedRoot) fail();
  return resolvedRoot;
}

/**
 * Walk an existing root-relative directory without creating components.
 * Each segment must be a non-symlink directory. Missing path rethrows ENOENT.
 * @param {string} root
 * @param {string} relativeDir empty string means root only
 * @param {SafeDataFileDeps} [deps]
 * @returns {Promise<string>} absolute directory path
 */
export async function assertSafeExistingRelativeDir(root, relativeDir = '', deps = {}) {
  const { lstat } = resolveDeps(deps);
  const resolvedRoot = await assertSafeDataRoot(root, deps);
  if (relativeDir === '' || relativeDir === '.') {
    return resolvedRoot;
  }
  const { absolutePath, segments } = resolveUnderRoot(resolvedRoot, relativeDir);
  let current = resolvedRoot;
  for (const segment of segments) {
    current = join(current, segment);
    let st;
    try {
      st = await lstat(current);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        const enoent = new Error('ENOENT');
        enoent.code = 'ENOENT';
        throw enoent;
      }
      fail();
    }
    if (st.isSymbolicLink() || !st.isDirectory()) fail();
  }
  if (current !== absolutePath) fail();
  return absolutePath;
}

/**
 * Resolve a relative path under root without following final component.
 * Lexical only — callers must still walk ancestors with lstat.
 * @param {string} root
 * @param {string} relativePath
 * @returns {{ resolvedRoot: string, absolutePath: string, segments: string[] }}
 */
function resolveUnderRoot(root, relativePath) {
  const normalized = normalizeRelativeDataPath(relativePath);
  const resolvedRoot = resolve(root);
  const absolutePath = resolve(join(resolvedRoot, normalized));
  if (absolutePath !== resolvedRoot && !absolutePath.startsWith(resolvedRoot + sep)) {
    fail();
  }
  return {
    resolvedRoot,
    absolutePath,
    segments: normalized.split('/'),
  };
}

/**
 * Ensure each directory component under root exists as a non-symlink directory.
 * Creates missing components with non-recursive mkdir, then re-lstats.
 * @param {string} root
 * @param {string} relativeDir empty string means root only
 * @param {SafeDataFileDeps} [deps]
 * @returns {Promise<string>} absolute directory path
 */
export async function ensureSafeRelativeDir(root, relativeDir = '', deps = {}) {
  const { lstat, mkdir } = resolveDeps(deps);
  const resolvedRoot = await assertSafeDataRoot(root, deps);

  if (relativeDir === '' || relativeDir === '.') {
    return resolvedRoot;
  }

  const { absolutePath, segments } = resolveUnderRoot(resolvedRoot, relativeDir);
  let current = resolvedRoot;
  for (const segment of segments) {
    current = join(current, segment);
    let st;
    try {
      st = await lstat(current);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') fail();
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if (!mkdirError || mkdirError.code !== 'EEXIST') fail();
      }
      try {
        st = await lstat(current);
      } catch {
        fail();
      }
    }
    if (st.isSymbolicLink() || !st.isDirectory()) fail();
  }

  if (current !== absolutePath) fail();
  return absolutePath;
}

/**
 * Walk existing parent directories (no create). Missing parent → ENOENT.
 * @param {string} root
 * @param {string} relativeFilePath
 * @param {SafeDataFileDeps} [deps]
 * @returns {Promise<{ resolvedRoot: string, absolutePath: string, parentAbs: string, fileName: string }>}
 */
async function resolveExistingParentForFile(root, relativeFilePath, deps = {}) {
  const { lstat } = resolveDeps(deps);
  const normalized = normalizeRelativeDataPath(relativeFilePath);
  const segments = normalized.split('/');
  const fileName = segments.pop();
  const resolvedRoot = await assertSafeDataRoot(root, deps);
  let parentAbs = resolvedRoot;
  for (const segment of segments) {
    parentAbs = join(parentAbs, segment);
    let st;
    try {
      st = await lstat(parentAbs);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        const enoent = new Error('ENOENT');
        enoent.code = 'ENOENT';
        throw enoent;
      }
      fail();
    }
    if (st.isSymbolicLink() || !st.isDirectory()) fail();
  }
  const absolutePath = join(parentAbs, fileName);
  if (absolutePath !== resolvedRoot && !absolutePath.startsWith(resolvedRoot + sep)) fail();
  return { resolvedRoot, absolutePath, parentAbs, fileName };
}

/**
 * Ensure parent directory of a relative file path is safe (creates missing parents).
 * @param {string} root
 * @param {string} relativeFilePath
 * @param {SafeDataFileDeps} [deps]
 * @returns {Promise<{ resolvedRoot: string, absolutePath: string, parentAbs: string, fileName: string }>}
 */
async function ensureParentForRelativeFile(root, relativeFilePath, deps = {}) {
  const normalized = normalizeRelativeDataPath(relativeFilePath);
  const segments = normalized.split('/');
  const fileName = segments[segments.length - 1];
  const parentRel = segments.length > 1 ? segments.slice(0, -1).join('/') : '';
  const resolvedRoot = await assertSafeDataRoot(root, deps);
  const parentAbs = parentRel
    ? await ensureSafeRelativeDir(resolvedRoot, parentRel, deps)
    : resolvedRoot;
  const absolutePath = join(parentAbs, fileName);
  if (absolutePath !== resolvedRoot && !absolutePath.startsWith(resolvedRoot + sep)) fail();
  return { resolvedRoot, absolutePath, parentAbs, fileName };
}

/**
 * Open a path with O_NOFOLLOW and require the opened fd to be a regular file.
 * @param {string} absolutePath
 * @param {number} flags
 * @param {number} [mode]
 * @param {SafeDataFileDeps} [deps]
 * @returns {Promise<import('node:fs/promises').FileHandle>}
 */
async function openRegularNoFollow(absolutePath, flags, mode, deps = {}) {
  const { open } = resolveDeps(deps);
  let handle;
  try {
    handle = mode === undefined
      ? await open(absolutePath, flags)
      : await open(absolutePath, flags, mode);
  } catch (error) {
    if (error && error.code === 'ENOENT') throw error;
    fail();
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.isSymbolicLink()) {
      await handle.close().catch(() => {});
      fail();
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    if (error instanceof SafeDataFileError) throw error;
    if (error && error.code === 'ENOENT') throw error;
    fail();
  }
}

/**
 * Bounded safe text read under dataDir. Missing file rethrows ENOENT.
 * Final symlink / non-regular → SafeDataFileError.
 * @param {string} root
 * @param {string} relativePath
 * @param {{ maxBytes?: number, deps?: SafeDataFileDeps }} [options]
 * @returns {Promise<string>}
 */
export async function safeReadText(root, relativePath, options = {}) {
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : DEFAULT_MAX_READ_BYTES;
  const deps = options.deps || {};
  const { lstat } = resolveDeps(deps);
  let absolutePath;
  let parentAbs;
  let fileName;
  try {
    ({ absolutePath, parentAbs, fileName } = await resolveExistingParentForFile(
      root,
      relativePath,
      deps,
    ));
  } catch (error) {
    if (error && error.code === 'ENOENT') throw error;
    if (error instanceof SafeDataFileError) throw error;
    fail();
  }
  // Parent already verified; refuse if leaf is symlink/non-file before open when present.
  try {
    const leaf = await lstat(join(parentAbs, fileName));
    if (leaf.isSymbolicLink() || !leaf.isFile()) fail();
  } catch (error) {
    if (error instanceof SafeDataFileError) throw error;
    if (error && error.code === 'ENOENT') {
      // Fall through to open for consistent ENOENT.
    } else {
      fail();
    }
  }

  let handle;
  try {
    handle = await openRegularNoFollow(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
      undefined,
      deps,
    );
    const st = await handle.stat();
    if (!st.isFile() || st.size > maxBytes) fail();
    const size = Number(st.size);
    const buf = Buffer.alloc(size);
    // Loop on legitimate short reads; only a true premature EOF (bytesRead=0) fails.
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(buf, offset, size - offset, offset);
      if (bytesRead === 0) fail();
      offset += bytesRead;
    }
    return buf.toString('utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') throw error;
    if (error instanceof SafeDataFileError) throw error;
    fail();
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * Append text to a root-relative file using O_APPEND|O_CREAT|O_WRONLY|O_NOFOLLOW.
 * Ensures parent dirs safely; forces mode 0600 on the opened fd.
 * @param {string} root
 * @param {string} relativePath
 * @param {string} text
 * @param {{ deps?: SafeDataFileDeps }} [options]
 * @returns {Promise<void>}
 */
export async function safeAppendText(root, relativePath, text, options = {}) {
  if (typeof text !== 'string') fail();
  const deps = options.deps || {};
  const { absolutePath } = await ensureParentForRelativeFile(root, relativePath, deps);

  let handle;
  try {
    handle = await openRegularNoFollow(
      absolutePath,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
      deps,
    );
    if (typeof handle.chmod === 'function') {
      await handle.chmod(0o600);
    }
    await handle.writeFile(text, { encoding: 'utf8' });
    if (typeof handle.sync === 'function') {
      await handle.sync();
    }
  } catch (error) {
    if (error instanceof SafeDataFileError) throw error;
    fail();
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * Re-validate parent directory and existing target leaf before rename publish.
 * @param {string} parentAbs
 * @param {string} targetAbs
 * @param {SafeDataFileDeps} deps
 */
async function revalidateBeforeRename(parentAbs, targetAbs, deps) {
  const { lstat } = resolveDeps(deps);
  let parentStat;
  try {
    parentStat = await lstat(parentAbs);
  } catch {
    fail();
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) fail();

  try {
    const targetStat = await lstat(targetAbs);
    // Refuse to publish over a symlink leaf (fail closed; do not replace silently).
    if (targetStat.isSymbolicLink() || targetStat.isDirectory()) fail();
    if (!targetStat.isFile()) fail();
  } catch (error) {
    if (error instanceof SafeDataFileError) throw error;
    if (!error || error.code !== 'ENOENT') fail();
  }
}

/**
 * Same-directory atomic text publish under dataDir.
 * Temp uses O_EXCL|O_NOFOLLOW unless allowExistingTemp with fixed tempRelativePath
 * (registry stale `.new` compatibility), still requiring nofollow + fd regular-file checks.
 * @param {string} root
 * @param {string} relativePath
 * @param {string} text
 * @param {{
 *   tempRelativePath?: string,
 *   allowExistingTemp?: boolean,
 *   mode?: number,
 *   deps?: SafeDataFileDeps,
 * }} [options]
 * @returns {Promise<void>}
 */
export async function safeAtomicWriteText(root, relativePath, text, options = {}) {
  if (typeof text !== 'string') fail();
  const mode = options.mode === undefined ? 0o600 : options.mode;
  if (!Number.isInteger(mode) || mode < 0) fail();
  const deps = options.deps || {};
  const { open, rename, unlink, lstat } = resolveDeps(deps);

  const { resolvedRoot, absolutePath, parentAbs, fileName } = await ensureParentForRelativeFile(
    root,
    relativePath,
    deps,
  );

  let tempAbs;
  if (typeof options.tempRelativePath === 'string' && options.tempRelativePath.length > 0) {
    const tempRel = normalizeRelativeDataPath(options.tempRelativePath);
    const tempSegments = tempRel.split('/');
    const tempName = tempSegments[tempSegments.length - 1];
    const tempParentRel = tempSegments.length > 1 ? tempSegments.slice(0, -1).join('/') : '';
    const tempParentAbs = tempParentRel
      ? await ensureSafeRelativeDir(resolvedRoot, tempParentRel, deps)
      : resolvedRoot;
    // Atomic publish requires same-directory temp and final.
    if (tempParentAbs !== parentAbs) fail();
    tempAbs = join(parentAbs, tempName);
  } else {
    const tempName = `.tmp-${randomUUID()}-${fileName}`;
    normalizeRelativeDataPath(tempName);
    tempAbs = join(parentAbs, tempName);
  }

  let handle;
  let tempCreated = false;
  try {
    // Preflight existing final target (detect symlink swap before write where possible).
    try {
      const finalStat = await lstat(absolutePath);
      if (finalStat.isSymbolicLink() || finalStat.isDirectory()) fail();
      if (!finalStat.isFile()) fail();
    } catch (error) {
      if (error instanceof SafeDataFileError) throw error;
      if (!error || error.code !== 'ENOENT') fail();
    }

    let openFlags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;
    if (options.allowExistingTemp && options.tempRelativePath) {
      try {
        const tempStat = await lstat(tempAbs);
        if (tempStat.isSymbolicLink() || !tempStat.isFile()) fail();
        openFlags = constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW;
      } catch (error) {
        if (error instanceof SafeDataFileError) throw error;
        if (!error || error.code !== 'ENOENT') fail();
        openFlags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;
      }
    }

    try {
      handle = await open(tempAbs, openFlags, mode);
      tempCreated = true;
    } catch {
      fail();
    }

    const fdStat = await handle.stat();
    if (!fdStat.isFile() || fdStat.isSymbolicLink()) fail();

    await handle.writeFile(text, { encoding: 'utf8' });
    if (typeof handle.sync === 'function') {
      await handle.sync();
    }
    if (typeof handle.chmod === 'function') {
      await handle.chmod(mode);
    }
    await handle.close();
    handle = undefined;

    await revalidateBeforeRename(parentAbs, absolutePath, deps);

    // Temp leaf must still be a regular file (no swap to symlink after close).
    try {
      const tempStat = await lstat(tempAbs);
      if (tempStat.isSymbolicLink() || !tempStat.isFile()) fail();
    } catch {
      fail();
    }

    await rename(tempAbs, absolutePath);
    tempCreated = false;

    // Best-effort parent directory sync to persist the directory entry.
    let parentHandle;
    try {
      parentHandle = await open(parentAbs, constants.O_RDONLY);
      if (typeof parentHandle.sync === 'function') {
        await parentHandle.sync();
      }
    } catch {
      // Parent sync is best-effort on platforms that disallow directory fsync.
    } finally {
      if (parentHandle) await parentHandle.close().catch(() => {});
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (tempCreated) {
      try {
        await unlink(tempAbs);
      } catch {
        // Only the temp path is cleaned; never unlink the final target.
      }
    }
    if (error instanceof SafeDataFileError) throw error;
    fail();
  }
}

/**
 * Copy bytes from an absolute source path into a root-relative destination.
 * Destination parents are created safely; both source and destination opens use
 * O_NOFOLLOW and require a regular-file fstat. Source may be outside dataDir —
 * caller validates backup source semantics before invoking.
 * @param {string} root
 * @param {string} relativeDest
 * @param {string} absoluteSource
 * @param {{ deps?: SafeDataFileDeps }} [options]
 * @returns {Promise<void>}
 */
export async function safeCopyFileFromAbsoluteSource(root, relativeDest, absoluteSource, options = {}) {
  if (typeof absoluteSource !== 'string' || absoluteSource.length === 0 || absoluteSource.includes('\0')) {
    fail();
  }
  const deps = options.deps || {};
  const { open } = resolveDeps(deps);
  const { absolutePath } = await ensureParentForRelativeFile(root, relativeDest, deps);

  let sourceHandle;
  let destHandle;
  try {
    try {
      sourceHandle = await open(absoluteSource, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      fail();
    }
    const sourceStat = await sourceHandle.stat();
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) fail();
    const size = Number(sourceStat.size);
    // Backup payloads can exceed DEFAULT_MAX_READ_BYTES; allow up to 512 MiB per file.
    const maxCopyBytes = 512 * 1024 * 1024;
    if (!Number.isFinite(size) || size < 0 || size > maxCopyBytes) fail();

    try {
      const existing = await resolveDeps(deps).lstat(absolutePath);
      if (existing.isSymbolicLink() || existing.isDirectory()) fail();
    } catch (error) {
      if (error instanceof SafeDataFileError) throw error;
      if (!error || error.code !== 'ENOENT') fail();
    }

    destHandle = await open(
      absolutePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    );
    const destStat = await destHandle.stat();
    if (!destStat.isFile() || destStat.isSymbolicLink()) fail();
    if (typeof destHandle.chmod === 'function') {
      await destHandle.chmod(0o600);
    }

    // Chunked fd copy; tolerate short reads on source, fail only on premature EOF.
    const chunkSize = 1024 * 1024;
    let offset = 0;
    while (offset < size) {
      const toRead = Math.min(chunkSize, size - offset);
      const buf = Buffer.alloc(toRead);
      let filled = 0;
      while (filled < toRead) {
        const { bytesRead } = await sourceHandle.read(buf, filled, toRead - filled, offset + filled);
        if (bytesRead === 0) fail();
        filled += bytesRead;
      }
      await destHandle.write(buf, 0, toRead, offset);
      offset += toRead;
    }
    if (typeof destHandle.sync === 'function') {
      await destHandle.sync();
    }
  } catch (error) {
    if (error instanceof SafeDataFileError) throw error;
    fail();
  } finally {
    await Promise.allSettled([
      sourceHandle?.close(),
      destHandle?.close(),
    ]);
  }
}

/**
 * Collect regular files under a root-relative directory using no-follow walks.
 * Rejects directory/file symlinks and unsupported types. Returns paths relative
 * to `relativeDir` using `/` separators, sorted by UTF-8 byte order.
 * @param {string} root
 * @param {string} relativeDir
 * @param {SafeDataFileDeps} [deps]
 * @returns {Promise<string[]>}
 */
export async function collectSafeRelativeFiles(root, relativeDir, deps = {}) {
  const { lstat, readdir } = resolveDeps(deps);
  await assertSafeExistingRelativeDir(root, relativeDir, deps);
  const resolvedRoot = resolve(root);
  /** @type {string[]} */
  const files = [];

  /**
   * @param {string} currentRel
   */
  async function walk(currentRel) {
    const absDir = currentRel
      ? await assertSafeExistingRelativeDir(resolvedRoot, currentRel, deps)
      : await assertSafeDataRoot(resolvedRoot, deps);
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      fail();
    }
    // Stable visit order.
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(b.name, 'utf8')));
    for (const entry of entries) {
      if (!entry || typeof entry.name !== 'string' || entry.name.length === 0) fail();
      if (entry.name.includes('\0') || entry.name === '.' || entry.name === '..') fail();
      if (entry.name.includes('/') || entry.name.includes('\\')) fail();
      const childRel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
      const childAbs = join(absDir, entry.name);
      let st;
      try {
        st = await lstat(childAbs);
      } catch {
        fail();
      }
      if (st.isSymbolicLink()) fail();
      if (st.isDirectory()) {
        // Dirent may also report isDirectory for some types; re-check via lstat.
        await walk(childRel);
      } else if (st.isFile()) {
        files.push(childRel);
      } else {
        fail();
      }
    }
  }

  const startRel = normalizeRelativeDataPath(relativeDir);
  await walk(startRel);
  // Return paths relative to relativeDir (strip the prefix).
  const prefix = `${startRel}/`;
  const relativeFiles = files.map((full) => {
    if (full === startRel) fail();
    if (!full.startsWith(prefix)) fail();
    return full.slice(prefix.length);
  });
  relativeFiles.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  return relativeFiles;
}

/**
 * SHA-256 hash a root-relative regular file via O_RDONLY|O_NOFOLLOW + fstat.
 * @param {string} root
 * @param {string} relativePath
 * @param {{ maxBytes?: number, deps?: SafeDataFileDeps }} [options]
 * @returns {Promise<{ size: number, sha256: string }>}
 */
export async function safeHashFileSha256(root, relativePath, options = {}) {
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : DEFAULT_MAX_HASH_BYTES;
  const deps = options.deps || {};
  const { absolutePath } = await resolveExistingParentForFile(root, relativePath, deps);
  const { lstat } = resolveDeps(deps);
  try {
    const leaf = await lstat(absolutePath);
    if (leaf.isSymbolicLink() || !leaf.isFile()) fail();
  } catch (error) {
    if (error instanceof SafeDataFileError) throw error;
    fail();
  }

  let handle;
  try {
    handle = await openRegularNoFollow(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
      undefined,
      deps,
    );
    const st = await handle.stat();
    if (!st.isFile() || st.isSymbolicLink()) fail();
    const size = Number(st.size);
    if (!Number.isFinite(size) || size < 0 || size > maxBytes) fail();
    const hash = createHash('sha256');
    const chunkSize = 1024 * 1024;
    let offset = 0;
    while (offset < size) {
      const toRead = Math.min(chunkSize, size - offset);
      const buf = Buffer.alloc(toRead);
      let filled = 0;
      while (filled < toRead) {
        const { bytesRead } = await handle.read(buf, filled, toRead - filled, offset + filled);
        if (bytesRead === 0) fail();
        filled += bytesRead;
      }
      hash.update(buf);
      offset += toRead;
    }
    return { size, sha256: hash.digest('hex') };
  } catch (error) {
    if (error instanceof SafeDataFileError) throw error;
    fail();
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * Open a root-relative regular file for read with O_RDONLY|O_NOFOLLOW + fstat.
 * Caller must close the returned handle.
 * @param {string} root
 * @param {string} relativePath
 * @param {SafeDataFileDeps} [deps]
 * @returns {Promise<{ handle: import('node:fs/promises').FileHandle, size: number, absolutePath: string }>}
 */
export async function openSafeRootRelativeRead(root, relativePath, deps = {}) {
  const { absolutePath } = await resolveExistingParentForFile(root, relativePath, deps);
  const { lstat } = resolveDeps(deps);
  try {
    const leaf = await lstat(absolutePath);
    if (leaf.isSymbolicLink() || !leaf.isFile()) fail();
  } catch (error) {
    if (error instanceof SafeDataFileError) throw error;
    if (error && error.code === 'ENOENT') throw error;
    fail();
  }
  const handle = await openRegularNoFollow(
    absolutePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
    undefined,
    deps,
  );
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.isSymbolicLink()) {
      await handle.close().catch(() => {});
      fail();
    }
    return { handle, size: Number(st.size), absolutePath };
  } catch (error) {
    await handle.close().catch(() => {});
    if (error instanceof SafeDataFileError) throw error;
    fail();
  }
}
