# V0.54 Web Console In-Memory API Token UX Plan

## Tasks

1. Add failing Web Console tests for API token controls and memory-only behavior.
2. Implement header token controls in `src/web/index.html` and styling in `src/web/styles.css`.
3. Route Web Console API calls through an `apiFetch` wrapper that conditionally adds `Authorization`.
4. Clear token state on `401` while preserving the non-2xx response for callers.
5. Update version, README, and Gold readiness evidence to V0.54.
6. Add helper tests for non-API URL isolation and POST header preservation.
7. Run targeted tests, adversarial review, full test suite, and final verifier.

## Validation Commands

```bash
node --test test/version.test.js test/health.test.js test/gold-readiness.test.js test/readme.test.js test/web-console.test.js
npm test
```

## Remaining Gold Blockers

- Real NAS remote backup execution.
- Production hardening, including role-based authorization, token rotation, audit logs, rate limiting, secret management, monitoring, and recovery supervisor.
