# Linke V0.56 Restore Target Guard Design

## Objective

Add an optional restore target guard for production-hardening progress without changing the default localhost prototype behavior.

## Behavior

- When `restoreRoot` / `LINKE_RESTORE_ROOT` is not configured, `/api/restore` and `restore-dry-run` keep the existing targetPath behavior.
- When `restoreRoot` is configured, relative `targetPath` values resolve inside the restore root.
- Absolute `targetPath` values must already be inside the restore root.
- Paths that escape with `..` or through a symlink ancestor return `400` with `targetPath is outside the allowed restore root`.
- `/api/restore` checks the guard before writing files.
- `restore-dry-run` checks the guard before reading the target directory tree.
- Client-facing 400 errors do not include the concrete target path or restore root.

## Qwen Adversarial Findings Accepted

- Use realpath containment, not string-prefix checks only, to catch symlink ancestor escapes.
- Guard dry-run because it reads target directory names.
- Keep only `LINKE_RESTORE_ROOT`; avoid a generic `RESTORE_ROOT` alias.
- Document the relative-path behavior when a restore root is configured.
- Keep Gold readiness blocked and `production-hardening` partial.

## Non-Goals

- No real NAS remote backup execution.
- No role-based authorization or token rotation.
- No per-file destination symlink overwrite defense in V0.56.
- No production-ready or Gold-ready claim.
