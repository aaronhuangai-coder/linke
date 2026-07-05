# Release Readiness CLI Implementation Plan

> Required flow: RED test first, AGY implementation, Qwen adversarial review, ZAI auxiliary verification, PM final verification.

## Goal

Implement Linke V0.50 `node src/agent.js release-readiness` as a read-only CLI gate over the existing `/api/health` endpoint.

## Constraints

- Do not add server routes.
- Do not change backup, restore, NAS, delete, remote command, or metadata-write behavior.
- Do not change `agent.js health`; it remains raw health output.
- Do not echo raw health payloads from `release-readiness`.
- Do not read or write `.env`, credentials, SSH/cloud auth, or token-bearing files.
- Use TDD: tests must fail before production implementation.

## Task 1: RED Tests

- [ ] Add `test/release-readiness.test.js` for the pure report builder.
- [ ] Add `test/agent-release-readiness.test.js` for real CLI behavior against temporary HTTP servers.
- [ ] Add README tests for V0.50 docs.
- [ ] Update version consistency tests so README and health response expect `LINKE_RELEASE_VERSION`.
- [ ] Run target tests and confirm failure because `src/release-readiness.js`, the CLI command, V0.50 version, and README docs do not exist yet.

Expected RED command:

```bash
node --test test/release-readiness.test.js test/agent-release-readiness.test.js test/readme.test.js test/version.test.js
```

Expected failure shape:

```text
Cannot find module '../src/release-readiness.js'
```

or missing CLI/docs/version assertions before implementation.

## Task 2: GREEN Implementation

- [ ] Create `src/release-readiness.js`.
- [ ] Export `buildReleaseReadinessReport(health, options = {})`.
- [ ] Evaluate fixed health schema, status, service, version, `checks.http`, `checks.dataDirReadable`, and timestamp.
- [ ] Return sanitized JSON fields only: `ready`, `service`, `expectedVersion`, `actualVersion`, `status`, `checkedAt`, and `checks`.
- [ ] Do not include the raw health object or unexpected field values in the report.
- [ ] Import and wire the helper in `src/agent.js`.
- [ ] Add usage docs and command switch branch for `release-readiness`.
- [ ] Support `--expected-version <version>`.
- [ ] Set `process.exitCode = 2` after printing the report when `ready === false`.
- [ ] Update `src/version.js` to `V0.50`.
- [ ] Update README title, badge, version table, feature docs, CLI docs, release readiness docs, safety notes, and testing coverage.

## Task 3: Verification

- [ ] `git diff --check`
- [ ] `node --test test/release-readiness.test.js test/agent-release-readiness.test.js test/version.test.js test/agent-health.test.js test/health.test.js test/readme.test.js`
- [ ] `npm test`
- [ ] Real HTTP smoke:

```bash
node src/agent.js release-readiness --server http://127.0.0.1:<port>
```

- [ ] Qwen adversarial review for readiness semantics, exit codes, schema sanitization, and unintended behavior changes.
- [ ] ZAI auxiliary verification with strict English PASS/FAIL schema; do not accept empty output, tool errors, or missing status as PASS.
- [ ] Commit and push.

## Execution Record

- Qwen design review returned `DONE_WITH_CONCERNS`.
- PM accepted the exit-code, explicit expected-version, and schema-sanitization findings before implementation.
- AGY RED dispatch failed twice with `authentication failed or timed out` and produced no file changes, so PM used the previously authorized fallback path.
- RED was confirmed by PM: target tests failed on missing `src/release-readiness.js`, unknown `release-readiness` command, V0.49 docs/version, and missing V0.50 README coverage.
- GREEN implementation added `src/release-readiness.js`, wired `agent.js release-readiness`, updated `LINKE_RELEASE_VERSION` to `V0.50`, and documented V0.50.
- PM target verification passed:
  - `node --test test/release-readiness.test.js test/agent-release-readiness.test.js test/readme.test.js test/version.test.js` (219/219)
  - `node --test test/release-readiness.test.js test/agent-release-readiness.test.js test/version.test.js test/agent-health.test.js test/health.test.js test/web-console.test.js test/readme.test.js` (470/470 after adding the missing `--expected-version` guard test)
  - `npm test` (629/629)
  - `git diff --check`
- Real HTTP smoke on `127.0.0.1:3014` returned `ready:true` with exit code 0 for `V0.50`, and returned `ready:false` with exit code 2 for `--expected-version V0.0`.
- Qwen implementation review returned `PASS` with no blocking findings. PM accepted its non-blocking missing-test concern and added coverage for `--expected-version` without a value.
- ZAI auxiliary verification returned final structured `Status: PASS` with no blocking findings. Intermediate tool chatter included a file-view tool error, so PM used only the final structured verdict as auxiliary evidence.
