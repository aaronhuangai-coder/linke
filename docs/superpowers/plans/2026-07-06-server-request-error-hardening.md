# V0.55 Server Request/Error Hardening Plan

## Tasks

1. Add RED tests for oversized JSON body, near-limit JSON body, intentional 400 preservation, and sanitized 500 responses.
2. Implement `MAX_JSON_BODY_BYTES` and chunk-time request size enforcement in `readBody`.
3. Add `createHttpError(statusCode, message)` for intentional route errors.
4. Update final server catch so 4xx `statusCode` errors preserve their message and unexpected 500 errors return `Internal Server Error`.
5. Update version, README, Web safety note, and Gold readiness summary.
6. Run targeted tests, adversarial review, full test suite, HTTP smoke, final verifier, commit, and push.

## Validation Commands

```bash
node --test test/security.test.js test/version.test.js test/health.test.js test/gold-readiness.test.js test/readme.test.js
npm test
```

## Remaining Gold Blockers

- Real NAS remote backup execution is still blocked.
- Production hardening remains partial until deployment hardening, audit trail, secret management, monitoring, supervisor, and recovery drills exist.
