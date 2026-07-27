# V1.44 Real-NAS Acceptance Report

- Acceptance ID: NAS-REAL-V144-20260727-01
- Runtime: V1.44 (source commit 903b10abbad5e7ba7d701561150a389c0317d518)
- Accepted at: 2026-07-27T07:55:19.485Z
- Environment: non-production
- Verdict: PASS for the covered acceptance scenarios; overall partial at 5/4/0/9 — four partial items remain, so this is not Gold.

## Copy

- State: replicated.
- Replicated 2 files, 9 bytes in total; 2 files verified against the manifest digest.
- Completed marker valid.
- Residuals: 0 lock residuals, 0 staging residuals.

## Recovery

- Scenario: staging-ready-process-termination, terminated via SIGKILL.
- Stale lock validated; 2 staged files present and 2 verified.
- State: recovered.
- Final publication did not occur; no post-final artifact exists.
- Residuals: 0 lock residuals, 0 staging residuals, 0 residual files.

## Preservation

- The first published snapshot was preserved intact throughout recovery.

## Audit

- Status: healthy.
- Dual-write state: idle.
- Store relationship: equal.
- Recovery required: no.

## Conclusion

The V1.44 real-NAS acceptance run is a PASS for its covered scope. Readiness remains
overall partial at 5/4/0/9; four partial items remain and the build is not Gold.
