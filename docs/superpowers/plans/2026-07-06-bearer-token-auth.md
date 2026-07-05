# V0.53 Optional Bearer Token Auth Skeleton Plan

## Guardrails

- Use TDD: auth tests must fail before production implementation.
- Do not read `.env`, credentials, SSH keys, cloud credentials, or token-bearing files.
- Use fake token strings only in tests and examples.
- Do not claim full production auth, production readiness, or real NAS remote backup.

## Tasks

1. Add RED tests for `createServer({ authToken })`:
   - missing token returns `401`;
   - wrong token returns `401`;
   - correct Bearer token returns `200`;
   - default no-token mode remains compatible.
2. Add CLI RED coverage for `agent.js health --token`.
3. Implement server-side API auth gate before route dispatch.
4. Implement Agent CLI `--token` header forwarding.
5. Update version, README, Web safety note, and Gold readiness scorecard:
   - current version `V0.53`;
   - `security-auth` becomes `partial`;
   - `real-nas-remote-backup` and `production-hardening` remain `blocked`.
6. Address Qwen review findings:
   - protect exact `/api`;
   - add POST auth rejection coverage;
   - add `/api/health` auth rejection coverage;
   - fail fast on whitespace-only authToken;
   - use `crypto.timingSafeEqual`.
7. Verify:
   - targeted V0.53 test set;
   - full `npm test`;
   - HTTP smoke for no token, wrong token, and correct token.
8. Run Qwen adversarial re-review and ZAI auxiliary final verification.

## Evidence

- RED failures observed:
  - missing/wrong auth returned `200` before implementation;
  - exact `/api` returned `404` before final hardening;
  - whitespace-only token did not fail fast before final hardening.
- Targeted tests: `node --test test/security.test.js test/agent-health.test.js test/gold-readiness.test.js test/version.test.js test/readme.test.js test/health.test.js test/web-console.test.js` passed with 542 tests.
- Full tests: `npm test` passed with 702 tests.
- HTTP smoke:
  - no token `GET /api/health` => `401`;
  - wrong token `GET /api/health` => `401`;
  - correct token `GET /api/gold-readiness` => `200`, version `V0.53`, Gold status `blocked`, summary `{ ready: 4, partial: 3, blocked: 2, total: 9 }`.
