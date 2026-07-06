# Linke V0.57 Restore Destination Symlink Defense Design

## Objective

When `LINKE_RESTORE_ROOT` is configured, real restore writes must not follow symlinks inside the destination tree and overwrite files outside the restore root.

## Behavior

- Without `LINKE_RESTORE_ROOT`, restore keeps the existing localhost prototype behavior.
- With `LINKE_RESTORE_ROOT`, restore target path validation from V0.56 still applies.
- Destination parent directories are created one level at a time and checked with `lstat()` and `realpath()`.
- Existing destination file symlinks are rejected.
- Existing destination parent directory symlinks are rejected.
- Destination files are opened with `O_NOFOLLOW`.
- Symlink-related restore rejection returns `400` with `Restore target path is not allowed`.

## Accepted Adversarial Findings

- `O_NOFOLLOW` only protects the final path component, so each parent directory must be checked.
- `mkdir(..., { recursive: true })` is not used in restore-root safe mode because it can follow symlinks.
- The default no-restoreRoot path remains compatible and intentionally less strict.

## Non-Goals

- No real NAS remote backup execution.
- No full TOCTOU elimination under hostile local write races.
- No production-ready or Gold-ready claim.
