# Gold Readiness Scorecard Implementation Plan

> Required flow: RED test first, AGY implementation, Qwen adversarial review, ZAI auxiliary verification, PM final verification.

## Goal

Implement Linke V0.52 Gold readiness scorecard as a read-only API and Web Console panel.

## Constraints

- Do not claim production readiness.
- Do not add auth, real NAS connection, remote transfer, daemon install, backup execution changes, restore changes, or metadata writes.
- Keep all scorecard item data static and code-owned for V0.52.
- Treat `generatedAt` as request-time metadata only; it is not proof of live NAS/auth/production checks.
- Keep `/api/release-readiness` and `/api/gold-readiness` distinct: release readiness is a runtime/version gate, while Gold readiness is a capability/blocker scorecard.
- Do not request `/api/gold-readiness` on Web Console initialization.
- Do not auto-poll `/api/gold-readiness`.
- Do not read or write `.env`, credentials, SSH/cloud auth, or token-bearing files.
- Use TDD.

## Static Scorecard Maintenance

- Update the scorecard whenever a version changes shipped capability, readiness status, README/API claims, or the Gold blocker set.
- Every item must carry concrete evidence strings: test file paths, endpoint names, CLI names, or README assertions.
- Tests must reject vague evidence and version/doc drift.
- For V0.52 the item list is deterministic; only `generatedAt` changes per request.

## Task 1: RED Tests

- [ ] Add `test/gold-readiness.test.js` for `buildGoldReadinessReport()` summary, item schema, status rollup, version, request-time timestamp, deterministic items, and concrete evidence strings.
- [ ] Assert required item IDs and evidence paths:
  - `release-readiness`: `test/release-readiness.test.js`, `test/agent-release-readiness.test.js`, `test/health.test.js`, `GET /api/health`, `GET /api/release-readiness`.
  - `local-backup-restore`: `test/restore.test.js`, `test/restore-dry-run.test.js`, `test/manifest.test.js`, `test/concurrency.test.js`, `test/security.test.js`.
  - `fleet-device-management`: `test/heartbeat.test.js`, `test/web-console.test.js`, and copy that limits the claim to read-only snapshot/heartbeat-state display.
  - `version-consistency`: `test/web-console.test.js` backup version consistency coverage.
  - `nas-dry-run`: `test/nas-dry-run.test.js`, `test/config.test.js`, and copy that denies real NAS connection.
  - `automation-installation`: `test/agent-run-once.test.js`, `test/launchd-dry-run.test.js`, and copy that denies installer/managed daemon.
  - `security-auth`: README/`test/readme.test.js` evidence that auth remains blocked.
  - `real-nas-remote-backup`: README plus `test/nas-dry-run.test.js` dry-run evidence.
  - `production-hardening`: README/`test/readme.test.js` evidence that production readiness is not claimed.
- [ ] Add `test/health.test.js` endpoint coverage for `GET /api/gold-readiness`, no dataDir mutation, and non-GET 404.
- [ ] Add Web Console HTML/source contract tests for `gold-readiness-panel`, button, status, counts, list, message, and safety note hooks.
- [ ] Add pure view model tests for unknown, ready, partial, blocked, and error states.
- [ ] Add DOM tests: no init request, manual refresh once, duplicate click blocked in-flight, blocked item render, and error render.
- [ ] Add README/version tests for V0.52 current version, API docs, Web panel docs, Gold blockers, release-readiness versus gold-readiness distinction, scorecard maintenance rule, and no production/NAS/auth overclaim.
- [ ] Run target tests and confirm RED failures.

## Task 2: GREEN Implementation

- [ ] Create `src/gold-readiness.js` with `buildGoldReadinessReport({ now } = {})`.
- [ ] Update `src/version.js` to `V0.52`.
- [ ] Add `GET /api/gold-readiness` to `src/server.js`; non-GET methods must remain 404.
- [ ] Add top-level `gold-readiness-panel` to `src/web/index.html`.
- [ ] Add `buildGoldReadinessViewModel()` and manual refresh wiring in `src/web/app.js`.
- [ ] Add `gold-readiness` styles in `src/web/styles.css`.
- [ ] Update README to V0.52 current with API, panel, safety, and blocker docs.

## Task 3: Verification

- [ ] `git diff --check`
- [ ] Target tests for helper, endpoint, Web Console, README, and version.
- [ ] `npm test`
- [ ] Real HTTP smoke:

```bash
curl -s http://127.0.0.1:<port>/api/gold-readiness
```

- [ ] Qwen implementation review.
- [ ] ZAI auxiliary verification with strict English PASS/FAIL schema.
- [ ] Commit and push.

## Execution Record

- PM selected this feature after V0.51 because Gold release needs a visible, tested capability/blocker scorecard before more feature expansion.
- Qwen design review returned `DONE_WITH_CONCERNS` with no blockers. PM accepted the concerns and tightened the spec/plan around concrete evidence paths, fleet-management wording, release-readiness versus Gold-readiness distinction, and static scorecard maintenance.
