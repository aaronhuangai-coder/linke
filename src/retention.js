/**
 * Retention Dry-Run Module
 *
 * Builds a dry-run plan showing which snapshots would be kept vs deleted
 * under a keep-last-N retention policy. Does NOT delete anything.
 */

/**
 * Validate that keepLast is a positive integer.
 * Rejects 0, negative numbers, decimals, NaN, non-numbers.
 * @param {unknown} keepLast
 * @throws {Error} if invalid
 */
function assertPositiveInteger(keepLast) {
  if (typeof keepLast !== 'number' || !Number.isFinite(keepLast)) {
    throw new Error(`keepLast must be a positive integer, got: ${keepLast}`);
  }
  if (!Number.isInteger(keepLast) || keepLast < 1) {
    throw new Error(`keepLast must be a positive integer, got: ${keepLast}`);
  }
}

/**
 * Build a retention dry-run plan for a device's snapshots.
 *
 * Pure function — no I/O, no side effects.
 *
 * @param {string} deviceId — device identifier
 * @param {Array<object>} snapshots — array of snapshot records (must have snapshotId, createdAt)
 * @param {object} [options]
 * @param {number} [options.keepLast=3] — number of newest snapshots to keep (positive integer)
 * @returns {object} dry-run plan
 */
export function buildRetentionDryRunPlan(deviceId, snapshots, options = {}) {
  const keepLast = options.keepLast !== undefined ? options.keepLast : 3;
  assertPositiveInteger(keepLast);

  // Sort by createdAt descending; stable sort preserves original order for ties
  const sorted = [...snapshots].sort((a, b) => {
    const cmp = b.createdAt.localeCompare(a.createdAt);
    return cmp;
  });

  const totalSnapshots = sorted.length;
  const keepCount = Math.min(keepLast, totalSnapshots);
  const wouldDeleteCount = totalSnapshots - keepCount;

  const snapshotPlan = sorted.map((snap, idx) => ({
    snapshotId: snap.snapshotId,
    createdAt: snap.createdAt,
    ...(snap.jobName !== undefined ? { jobName: snap.jobName } : {}),
    ...(snap.sourcePath !== undefined ? { sourcePath: snap.sourcePath } : {}),
    ...(snap.fileCount !== undefined ? { fileCount: snap.fileCount } : {}),
    action: idx < keepCount ? 'keep' : 'would-delete',
    reason: idx < keepCount ? 'within-keep-last' : 'older-than-keep-last',
  }));

  return {
    mode: 'dry-run',
    deviceId,
    policy: {
      type: 'keep-last',
      keepLast,
      sortBy: 'createdAt desc',
    },
    totalSnapshots,
    keepCount,
    wouldDeleteCount,
    wouldWrite: false,
    snapshots: snapshotPlan,
  };
}
