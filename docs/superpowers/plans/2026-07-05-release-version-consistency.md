# Release Version Consistency Implementation Plan

> Required flow: RED test first, AGY implementation, Qwen adversarial review, ZAI auxiliary verification, PM final verification.

## Goal

Implement Linke V0.49 release-version consistency guard so README, `/api/health`, Agent CLI health, and Web Console release-health expectations use one release version source.

## Constraints

- Do not add server routes.
- Do not change backup, restore, NAS, delete, remote command, or metadata-write behavior.
- Do not read or write `.env`, credentials, SSH/cloud auth, or token-bearing files.
- Keep changes small and focused on version consistency.

## Execution Record

- RED tests were added by AGY and confirmed by PM: target suites failed on missing `../src/version.js`.
- GREEN implementation was completed by PM because AGY returned `authentication failed or timed out` twice during GREEN dispatch.
- Qwen adversarial review returned `STATUS: PASS`; only non-blocking reminder was to stage new `src/version.js`.
- ZAI closed-loop verification was attempted twice with strict PASS/FAIL prompts, but both attempts returned `Z.ai API error: Connection error`; no ZAI PASS was accepted.
- PM verification passed:
  - `git diff --check`
  - `node --test test/version.test.js test/agent-health.test.js test/health.test.js test/web-console.test.js test/readme.test.js` (448/448)
  - `npm test` (607/607)
  - Real HTTP smoke on `127.0.0.1:3013`, including `/api/health` returning `version:"V0.49"`.

## Task 1: RED Tests

- [x] Add `test/version.test.js`.
- [x] Import `LINKE_RELEASE_VERSION` from `src/version.js`; initial RED should fail because the module does not exist.
- [x] Assert README title `# Linke ${LINKE_RELEASE_VERSION}`.
- [x] Assert README badge `当前版本：${LINKE_RELEASE_VERSION}`.
- [x] Assert README version table marks `${LINKE_RELEASE_VERSION}` as `当前版本`.
- [x] Assert `buildHealthResponse({ dataDirReadable:true }).version === LINKE_RELEASE_VERSION`.
- [x] Add an Agent CLI health integration assertion using `LINKE_RELEASE_VERSION` against the existing local temp-server path in `test/agent-health.test.js`. This verifies that `agent.js health` faithfully prints the server health payload; `agent.js` must not introduce a second version constant.

Expected RED:

```text
Cannot find module '../src/version.js'
```

## Task 2: GREEN Implementation

- [x] Add `src/version.js`:

```js
export const LINKE_RELEASE_VERSION = 'V0.49';
```

- [x] Update `src/server.js` to import `LINKE_RELEASE_VERSION`.
- [x] Update README title, badge, version table, and release-health docs to V0.49 current with V0.48 historical.
- [x] Update affected tests to use `LINKE_RELEASE_VERSION` instead of hard-coded current release strings.
- [x] Update Web Console release-health mock payloads and expected version text to use `LINKE_RELEASE_VERSION`.
- [x] Keep Web Console runtime behavior unchanged.
- [x] Leave `package.json.version` unchanged; npm semver is independent from Linke milestone labels.
- [x] Fix stale README test descriptions that call older milestones "current version" when they are only historical coverage mentions.

## Task 3: Verification

- [x] `node --test test/version.test.js test/health.test.js test/agent-health.test.js test/web-console.test.js test/readme.test.js`
- [x] `npm test`
- [x] `git diff --check`
- [x] Qwen adversarial review for version-drift coverage and unintended behavior changes.
- [x] ZAI closed-loop verification attempted with strict PASS/FAIL schema; both attempts failed with connection error and were not accepted as PASS evidence.
- [ ] Commit and push.
