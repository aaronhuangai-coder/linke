# Linke V0.25 Version Staleness Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only non-latest device summary to the Web Console backup version consistency panel.

**Architecture:** Extend the existing frontend-only `buildBackupVersionConsistency()` derived data. Render one extra summary row per version consistency group. Do not change backend APIs or snapshot metadata.

**Tech Stack:** Node.js built-in test runner, browser ESM, plain DOM, no new dependency.

## Global Constraints

- Current version becomes V0.25.
- Implement with TDD: write failing tests first, verify RED, then write implementation.
- Only modify allowed files listed in the task.
- Do not modify backend core files.
- Do not add API routes.
- Do not write metadata.
- Do not trigger backup, sync, restore, delete, NAS connection, NAS app invocation, or remote transfer.
- Use `textContent` for all dynamic text.

---

### Task 1: RED Tests

**Files:**
- Modify: `test/web-console.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**
- Consumes: `buildBackupVersionConsistency(devices, snapshotsByDevice)`
- Produces: failing assertions for V0.25 staleness summary

- [ ] **Step 1: Add pure function failing tests**

Add assertions to the existing V0.22 pure-function test:

```js
assert.strictEqual(result.groups[0].latestCount, 1);
assert.strictEqual(result.groups[0].staleCount, 1);
assert.strictEqual(result.groups[0].singleCount, 0);
assert.strictEqual(result.groups[0].maxTimeDriftMs, 60 * 60 * 1000);
assert.deepStrictEqual(result.groups[0].staleDeviceNames, ['Mac B']);
assert.strictEqual(result.groups[1].singleCount, 1);
assert.strictEqual(result.groups[2].staleCount, 0);
assert.strictEqual(result.groups[2].maxTimeDriftMs, null);
```

- [ ] **Step 2: Add DOM failing test**

In the V0.22 panel DOM tests, assert that rendered version consistency items include `data-testid="version-consistency-staleness-summary"` and text for `最新`, `非最新`, `单设备`, and `最大时间差`.

- [ ] **Step 3: Add README failing tests**

Update README tests to require V0.25 title, version badge, version table row, feature description, and safety boundary.

- [ ] **Step 4: Verify RED**

Run:

```bash
node --test test/web-console.test.js test/readme.test.js
```

Expected: FAIL because V0.25 fields, DOM hook, and README text do not exist yet.

### Task 2: Implementation

**Files:**
- Modify: `src/web/app.js`
- Modify: `src/web/styles.css`
- Modify: `README.md`

**Interfaces:**
- Produces group fields: `latestCount`, `staleCount`, `singleCount`, `maxTimeDriftMs`, `staleDeviceNames`
- Produces DOM hook: `version-consistency-staleness-summary`

- [ ] **Step 1: Extend group data**

In `buildBackupVersionConsistency()`, after devices receive `versionState`, derive counts and max time drift.

- [ ] **Step 2: Render summary**

In `renderVersionConsistencyRows()`, append one summary span/div using `textContent`. Use wording: `最新 X · 非最新 Y · 单设备 Z · 最大时间差 ... · 非最新设备 ...`.

- [ ] **Step 3: Add styles**

Add compact styling for `.version-consistency-staleness-summary`, grid-column full width, neutral background, wrap text.

- [ ] **Step 4: Update README**

Update current version to V0.25, add V0.25 row, feature bullet, Web Console section, safety guarantee, and test coverage note.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
node --test test/web-console.test.js test/readme.test.js
```

Expected: PASS.

## Final Verification

```bash
node --test --test-reporter=dot test/*.test.js
git diff --check
```

HTTP smoke:

```bash
PORT=3006 HOST=127.0.0.1 DATA_DIR=/tmp/linke-v025-smoke node src/server.js
node --input-type=module -e "const base='http://127.0.0.1:3006'; const html=await (await fetch(base+'/')).text(); const js=await (await fetch(base+'/app.js')).text(); const ok={html:html.includes('version-consistency-panel'), js:js.includes('version-consistency-staleness-summary')&&js.includes('maxTimeDriftMs')}; if(!ok.html||!ok.js){console.error(JSON.stringify(ok)); process.exit(1);} console.log(JSON.stringify(ok));"
```
