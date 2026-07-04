import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { shouldExclude } from './storage.js';

function normalizeExcludePatterns(excludePatterns) {
  if (!Array.isArray(excludePatterns)) return [];
  return excludePatterns.filter((pattern) => pattern !== true).map((pattern) => String(pattern));
}

function findMatchedPattern(name, excludePatterns) {
  for (const pattern of excludePatterns) {
    if (shouldExclude(name, [pattern])) return pattern;
  }
  return null;
}

async function collectAllFiles(dir, base, matchedPattern) {
  const result = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    const relativePath = full.slice(base.length + 1);
    if (entry.isDirectory()) {
      result.push(...await collectAllFiles(full, base, matchedPattern));
    } else {
      result.push({ sourceRelativePath: relativePath, matchedPattern });
    }
  }
  return result;
}

async function scanDirectory(dir, base, excludePatterns) {
  const included = [];
  const excluded = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const full = join(dir, entry.name);
    const relativePath = full.slice(base.length + 1);
    const matchedPattern = findMatchedPattern(entry.name, excludePatterns);

    if (matchedPattern) {
      if (entry.isDirectory()) {
        excluded.push(...await collectAllFiles(full, base, matchedPattern));
      } else {
        excluded.push({ sourceRelativePath: relativePath, matchedPattern });
      }
      continue;
    }

    if (entry.isDirectory()) {
      const nested = await scanDirectory(full, base, excludePatterns);
      included.push(...nested.included);
      excluded.push(...nested.excluded);
    } else {
      included.push(relativePath);
    }
  }

  return { included, excluded };
}

/**
 * Read-only backup preflight. It scans sourcePath and applies exclude patterns,
 * but never creates snapshots, copies files, or writes metadata.
 */
export async function runBackupPreflightDryRun(sourcePath, excludePatterns = []) {
  const patterns = normalizeExcludePatterns(excludePatterns);
  let sourceStat;
  try {
    sourceStat = await stat(sourcePath);
  } catch {
    throw new Error(`Source path does not exist: ${sourcePath}`);
  }

  let included = [];
  let excluded = [];
  if (sourceStat.isDirectory()) {
    const scanned = await scanDirectory(sourcePath, sourcePath, patterns);
    included = scanned.included;
    excluded = scanned.excluded;
  } else {
    const sourceName = basename(sourcePath);
    const matchedPattern = findMatchedPattern(sourceName, patterns);
    if (matchedPattern) {
      excluded = [{ sourceRelativePath: sourceName, matchedPattern }];
    } else {
      included = [sourceName];
    }
  }

  included.sort();
  excluded.sort((a, b) => a.sourceRelativePath.localeCompare(b.sourceRelativePath));

  return {
    mode: 'dry-run',
    wouldWrite: false,
    sourcePath,
    excludePatterns: patterns,
    summary: {
      totalFiles: included.length + excluded.length,
      includedCount: included.length,
      excludedCount: excluded.length,
    },
    included,
    excluded,
  };
}
