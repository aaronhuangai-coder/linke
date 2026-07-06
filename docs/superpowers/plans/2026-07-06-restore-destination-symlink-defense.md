# Linke V0.57 Restore Destination Symlink Defense Plan

## Scope

Add restore destination symlink defenses when `LINKE_RESTORE_ROOT` is enabled.

## TDD Tasks

1. RED: Add a test where an existing destination file symlink points outside restoreRoot and must not be overwritten.
2. RED: Add a test where an existing destination parent directory symlink points outside restoreRoot and must not receive nested restored files.
3. GREEN: Add `RestoreTargetError` with `statusCode = 400`.
4. GREEN: Add safe restore-root directory creation with per-level `lstat()` and `realpath()` checks.
5. GREEN: Use `O_NOFOLLOW` for destination file writes in restore-root safe mode.
6. Docs: Update version, README, Web Gold safety note, and Gold readiness evidence.

## Verification

- `node --test test/restore.test.js`
- `node --test test/version.test.js test/health.test.js test/gold-readiness.test.js test/readme.test.js test/restore.test.js test/restore-dry-run.test.js`
- Full `npm test`
- `git diff --check`
- HTTP smoke with `LINKE_RESTORE_ROOT` configured

## Remaining Risks

- This reduces symlink overwrite risk but does not claim complete production hardening.
- Hostile local TOCTOU races remain future work.
- Gold remains blocked by real NAS remote backup and production operations gaps.
