# Gold Readiness Scorecard Design

## Goal

V0.52 adds a read-only Gold readiness scorecard that tells operators which Linke capabilities are currently usable, which are dry-run/partial, and which are blockers before a full Gold software release.

## Non-Goals

- Do not claim production readiness.
- Do not add authentication, real NAS connection, remote transfer, daemon install, backup execution changes, restore changes, or metadata writes.
- Do not read secrets, `.env`, SSH keys, cloud credentials, or token-bearing files.

## User Value

The project has many prototype features. Gold release needs a stable view of capability readiness and blockers, otherwise the team can keep adding features without knowing whether the release is actually getting closer. The scorecard turns release state into a tested API and Web Console panel.

## Architecture

- Add `src/gold-readiness.js` with a pure `buildGoldReadinessReport()` helper.
- Add `GET /api/gold-readiness` in `src/server.js`; all non-GET methods continue to fall through to 404.
- Add a top-level Web Console panel that manually refreshes `GET /api/gold-readiness`.
- Keep the item list static and code-owned for V0.52. It reflects shipped capabilities and known blockers, not live NAS, auth, or production checks.

## Relationship To Release Readiness

`/api/release-readiness` remains the runtime/version release gate: it checks the current executable surface, version consistency, CLI/API availability, and documented release-safety signals.

`/api/gold-readiness` is a product capability scorecard: it tells the team whether the complete Gold software goal is ready, partial, or blocked. It can report `blocked` even when `/api/release-readiness` is healthy, because Gold still requires authentication, real NAS remote backup, and production hardening.

The Gold scorecard must not be used as proof of production readiness. It is a tested blocker matrix for planning and release governance.

## Report Schema

```js
{
  status: 'blocked',
  version: 'V0.52',
  generatedAt: '2026-07-06T00:00:00.000Z',
  summary: {
    ready: 4,
    partial: 2,
    blocked: 3,
    total: 9
  },
  items: [
    {
      id: 'release-readiness',
      area: 'release',
      label: '发布就绪检查',
      status: 'ready',
      evidence: ['GET /api/health', 'GET /api/release-readiness'],
      nextStep: '保持测试覆盖与版本一致性守卫'
    }
  ]
}
```

Status semantics:

- `ready`: usable within the documented localhost prototype boundary.
- `partial`: implemented as dry-run, preview, or manual-only workflow; not complete Gold capability.
- `blocked`: required for Gold release but not implemented.
- `generatedAt`: request-time timestamp for the report object only. It is not evidence that static scorecard items were live-checked.

Overall `status` is:

- `blocked` if any item is blocked.
- `partial` if no blocked items exist but at least one item is partial.
- `ready` only when every item is ready.

## Initial Scorecard Items

- `release-readiness`: ready; evidence is `test/release-readiness.test.js`, `test/agent-release-readiness.test.js`, `test/health.test.js`, `GET /api/health`, `release-readiness` CLI, and `GET /api/release-readiness`.
- `local-backup-restore`: ready; local snapshot backup/restore works in the current prototype boundary; evidence is `test/restore.test.js`, `test/restore-dry-run.test.js`, `test/manifest.test.js`, `test/concurrency.test.js`, and `test/security.test.js`.
- `fleet-device-management`: ready only as read-only snapshot and heartbeat-state management display; evidence is `test/heartbeat.test.js` and `test/web-console.test.js`. This is not real-time device discovery, production monitoring, or endpoint control.
- `version-consistency`: ready; cross-device version consistency and coverage gaps are visible from existing snapshots; evidence is `test/web-console.test.js` coverage for backup version consistency view models and panel rendering.
- `nas-dry-run`: partial; Synology/Ugreen dry-run and app adapter plans exist; evidence is `test/nas-dry-run.test.js` and `test/config.test.js`; no real NAS connection is made.
- `automation-installation`: partial; `run-once` and `launchd-dry-run` exist; evidence is `test/agent-run-once.test.js` and `test/launchd-dry-run.test.js`; no installer or managed daemon is installed.
- `security-auth`: blocked; Web/API has no authentication or authorization; evidence is README safety documentation and `test/readme.test.js` assertions that auth remains a blocker.
- `real-nas-remote-backup`: blocked; real NAS connection, transfer, and remote backup execution are not implemented; evidence is README safety documentation plus `test/nas-dry-run.test.js` proving NAS behavior remains dry-run.
- `production-hardening`: blocked; no production deployment hardening, audit trail, secret management, or recovery supervisor is implemented; evidence is README safety documentation and `test/readme.test.js` assertions that production readiness is not claimed.

## Scorecard Maintenance Strategy

- Update the static item list whenever a version adds a capability, removes a capability, changes a readiness status, changes README/API claims, or changes the Gold release blocker set.
- PM owns the scorecard content during each version bump. Implementers may update it only under the version plan and tests for that release.
- Every item must include concrete evidence strings: test file paths, endpoint names, CLI names, or README assertions. Vague evidence such as "implemented" or "works" is not sufficient.
- Tests must fail if the scorecard version, README current version, or documented Gold blockers drift from the shipped code.
- Because item readiness is static in V0.52, only `generatedAt` changes per request. Item IDs, labels, statuses, evidence, and next steps must remain deterministic unless the code changes.

## Web Console

Add `gold-readiness-panel` as a top-level panel near the release health area. It includes:

- Manual refresh button.
- Overall status.
- Counts for ready / partial / blocked / total.
- Item list with area, label, status, evidence, and next step.
- Safety note stating it is read-only, no startup request, no polling, no NAS connection, no backup/restore execution, no metadata write, and no production-readiness claim.

The panel must not request `/api/gold-readiness` on initialization. It only requests on button click and uses an in-flight guard.

## Testing

- Pure helper tests for summary counts and overall status.
- Pure helper tests that every item has concrete evidence and no vague evidence strings.
- API tests for `GET /api/gold-readiness`, schema, version, no mutation, and non-GET 404.
- Web Console contract tests for HTML hooks and source references.
- View model tests for ready / partial / blocked / error / unknown states.
- DOM tests for no init request, manual refresh, in-flight guard, blocked render, and error render.
- README/version tests for V0.52 current version, release-readiness versus gold-readiness distinction, static scorecard maintenance, and safety boundaries.

## Verification

- Target tests for helper, endpoint, Web Console, README, and version.
- Full `npm test`.
- `git diff --check`.
- HTTP smoke for `GET /api/gold-readiness`.
- Qwen adversarial review and ZAI auxiliary verification.
