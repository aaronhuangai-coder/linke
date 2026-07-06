# Linke V0.56 Restore Target Guard Plan

## Scope

Implement a guarded restore target root for `/api/restore` and `restore-dry-run`.

## TDD Tasks

1. RED: Add restore tests for relative target inside restoreRoot, absolute outside target rejection, and symlink ancestor escape rejection.
2. RED: Add restore-dry-run test proving outside restoreRoot is rejected before target tree scanning.
3. GREEN: Add server helpers for `normalizeRestoreRoot()` and `resolveRestoreTargetPath()`.
4. GREEN: Wire the helper into `/api/restore` before `restoreSnapshot()`.
5. GREEN: Wire the helper into restore-dry-run before `collectExistingTargetPaths()`.
6. Docs: Update README, Web Gold safety note, version, Gold readiness evidence, and version/readiness tests.

## Verification

- `node --test test/restore.test.js test/restore-dry-run.test.js`
- `node --test test/version.test.js test/health.test.js test/gold-readiness.test.js test/readme.test.js test/restore.test.js test/restore-dry-run.test.js`
- Full `npm test`
- `git diff --check`
- HTTP smoke with `LINKE_RESTORE_ROOT` configured

## Remaining Risks

- `restoreRoot` is only a production-hardening slice; Gold remains blocked by real NAS remote backup.
- Per-file destination symlink overwrite defense is still future work.
- Full authorization, audit, rate limiting, secret management, monitoring, and supervisor are still missing.
