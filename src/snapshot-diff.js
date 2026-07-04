function normalizeFiles(files) {
  if (!Array.isArray(files)) return [];
  return Array.from(new Set(files.map((file) => String(file)))).sort();
}

export function buildSnapshotDiffDryRunPlan(deviceId, fromManifest, toManifest) {
  const fromFiles = normalizeFiles(fromManifest?.files);
  const toFiles = normalizeFiles(toManifest?.files);
  const fromSet = new Set(fromFiles);
  const toSet = new Set(toFiles);

  const added = toFiles.filter((file) => !fromSet.has(file));
  const removed = fromFiles.filter((file) => !toSet.has(file));
  const unchanged = toFiles.filter((file) => fromSet.has(file));

  return {
    mode: 'dry-run',
    deviceId,
    fromSnapshotId: fromManifest?.snapshotId || null,
    toSnapshotId: toManifest?.snapshotId || null,
    wouldWrite: false,
    summary: {
      addedCount: added.length,
      removedCount: removed.length,
      unchangedCount: unchanged.length,
      comparedBy: 'manifest.files',
    },
    added,
    removed,
    unchanged,
  };
}
