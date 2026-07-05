# Release Version Consistency Design

## Goal

Linke V0.49 prevents release-version drift by making the current release version a single source of truth in code and by adding tests that cross-check README documentation, `/api/health`, Agent CLI health output, and Web Console release-health examples.

## Problem

V0.48 Qwen review found that README had advanced to `V0.48` while `/api/health.version` still returned `V0.46`. That happened because the release version was hard-coded in `src/server.js` and separate tests asserted hard-coded old values.

## Scope

- Add `src/version.js` with `LINKE_RELEASE_VERSION`.
- Import `LINKE_RELEASE_VERSION` in `src/server.js`.
- Update README to V0.49 current.
- Update health and Web Console tests to import or reference the shared version constant where practical.
- Add a focused release-version consistency test that checks:
  - README title and current-version badge match `LINKE_RELEASE_VERSION`.
  - README version table marks `LINKE_RELEASE_VERSION` as current.
  - `buildHealthResponse().version` matches `LINKE_RELEASE_VERSION`.
  - Agent `health` output matches `LINKE_RELEASE_VERSION` through the existing local temp-server integration path. The Agent CLI remains a transport client and does not own a separate version constant.

## Non-Goals

- No new server routes.
- No package publishing, installer, auto-update, or release automation.
- No runtime README parsing.
- No coupling to `package.json.version`; npm package semver remains independent from Linke milestone labels such as `V0.49`.
- No NAS, backup, restore, delete, remote command, or metadata-write behavior.

## Acceptance

- Current version becomes `V0.49`.
- `/api/health` returns `version:"V0.49"`.
- Agent `health` prints `version:"V0.49"`.
- README title, badge, and version table are V0.49 current, with V0.48 historical.
- Tests fail if README current version and code current version diverge.
- Web Console release-health test payloads and assertions use `LINKE_RELEASE_VERSION` instead of hard-coded current release strings.
- `npm test` and `git diff --check` pass.
