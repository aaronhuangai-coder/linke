import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

function normalizeFiles(files) {
  if (!Array.isArray(files)) return [];
  return Array.from(new Set(files.map((file) => String(file)))).sort();
}

function isInside(base, candidate) {
  return candidate === base || candidate.startsWith(base + '/');
}

function buildTargetFilePath(targetPath, sourceRelativePath) {
  const base = resolve(targetPath);
  const full = resolve(base, sourceRelativePath);
  if (!isInside(base, full)) {
    throw new Error(`Invalid manifest file path: ${sourceRelativePath}`);
  }
  return full;
}

/**
 * Build a read-only restore preview plan from a snapshot manifest.
 * This function performs no filesystem I/O and never writes.
 */
export function buildRestoreDryRunPlan(deviceId, manifest, targetPath, existingTargetPaths = new Set()) {
  const files = normalizeFiles(manifest?.files);
  const existing = existingTargetPaths instanceof Set
    ? existingTargetPaths
    : new Set(existingTargetPaths || []);

  const plannedFiles = files.map((sourceRelativePath) => {
    const action = existing.has(sourceRelativePath) ? 'would-overwrite' : 'would-create';
    return {
      sourceRelativePath,
      targetPath: buildTargetFilePath(targetPath, sourceRelativePath),
      action,
    };
  });

  const wouldCreateCount = plannedFiles.filter((file) => file.action === 'would-create').length;
  const wouldOverwriteCount = plannedFiles.filter((file) => file.action === 'would-overwrite').length;

  return {
    mode: 'dry-run',
    wouldWrite: false,
    deviceId,
    snapshotId: manifest?.snapshotId || null,
    targetPath,
    summary: {
      totalFiles: plannedFiles.length,
      wouldCreateCount,
      wouldOverwriteCount,
    },
    files: plannedFiles,
  };
}

async function collectRelativeFiles(dir, base = dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const result = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...await collectRelativeFiles(full, base));
    } else {
      result.push(full.slice(base.length + 1));
    }
  }
  return result;
}

/**
 * Read the target directory tree and return existing relative file paths.
 * This helper is read-only and treats a missing target directory as empty.
 */
export async function collectExistingTargetPaths(targetPath) {
  return new Set(await collectRelativeFiles(resolve(targetPath)));
}
