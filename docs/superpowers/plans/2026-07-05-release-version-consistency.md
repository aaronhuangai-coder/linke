# Release Version Consistency Implementation Plan

> Required flow: RED test first, AGY implementation, Qwen adversarial review, ZAI auxiliary verification, PM final verification.

## Goal

Implement Linke V0.49 release-version consistency guard so README, `/api/health`, Agent CLI health, and Web Console release-health expectations use one release version source.

## Constraints

- Do not add server routes.
- Do not change backup, restore, NAS, delete, remote command, or metadata-write behavior.
- Do not read or write `.env`, credentials, SSH/cloud auth, or token-bearing files.
- Keep changes small and focused on version consistency.

## Task 1: RED Tests

- [ ] Add `test/version.test.js`.
- [ ] Import `LINKE_RELEASE_VERSION` from `src/version.js`; initial RED should fail because the module does not exist.
- [ ] Assert README title `# Linke ${LINKE_RELEASE_VERSION}`.
- [ ] Assert README badge `当前版本：${LINKE_RELEASE_VERSION}`.
- [ ] Assert README version table marks `${LINKE_RELEASE_VERSION}` as `当前版本`.
- [ ] Assert `buildHealthResponse({ dataDirReadable:true }).version === LINKE_RELEASE_VERSION`.
- [ ] Add an Agent CLI health integration assertion using `LINKE_RELEASE_VERSION` against the existing local temp-server path in `test/agent-health.test.js`. This verifies that `agent.js health` faithfully prints the server health payload; `agent.js` must not introduce a second version constant.

Expected RED:

```text
Cannot find module '../src/version.js'
```

## Task 2: GREEN Implementation

- [ ] Add `src/version.js`:

```js
export const LINKE_RELEASE_VERSION = 'V0.49';
```

- [ ] Update `src/server.js` to import `LINKE_RELEASE_VERSION`.
- [ ] Update README title, badge, version table, and release-health docs to V0.49 current with V0.48 historical.
- [ ] Update affected tests to use `LINKE_RELEASE_VERSION` instead of hard-coded current release strings.
- [ ] Update Web Console release-health mock payloads and expected version text to use `LINKE_RELEASE_VERSION`.
- [ ] Keep Web Console runtime behavior unchanged.
- [ ] Leave `package.json.version` unchanged; npm semver is independent from Linke milestone labels.
- [ ] Fix stale README test descriptions that call older milestones "current version" when they are only historical coverage mentions.

## Task 3: Verification

- [ ] `node --test test/version.test.js test/health.test.js test/agent-health.test.js test/web-console.test.js test/readme.test.js`
- [ ] `npm test`
- [ ] `git diff --check`
- [ ] Qwen adversarial review for version-drift coverage and unintended behavior changes.
- [ ] ZAI closed-loop verification with strict PASS/FAIL schema.
- [ ] Commit and push.
