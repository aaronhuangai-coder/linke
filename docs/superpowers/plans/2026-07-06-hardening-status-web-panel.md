# Hardening Status Web Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Linke V0.72 Web Console hardening-status panel that manually displays sanitized `GET /api/hardening-status` output.

**Architecture:** Reuse the existing `GET /api/hardening-status` endpoint and Web Console `apiFetch()` token flow. Add one pure view-model builder, one manual refresh panel, and focused DOM/source/docs tests. Do not add backend behavior or claim production hardening is complete.

**Tech Stack:** Node.js ESM, `node --test`, vanilla HTML/CSS/JS Web Console.

## Global Constraints

- Current V0.72 scope is Web visibility only: no real NAS connection, no remote command, no backup, no restore, no metadata write.
- `GET /api/hardening-status` remains read-only and must not expose token values, token prefixes, restore root paths, audit paths, environment variable values, or Authorization headers.
- Web Console must not request `/api/hardening-status` on initialization and must not auto-poll it.
- Authenticated deployments use the existing in-memory API Token UX and `apiFetch()` Bearer handling.
- Gold readiness remains blocked; `production-hardening` remains partial.
- Version source remains `src/version.js`; README, tests, and Gold readiness evidence must match `LINKE_RELEASE_VERSION`.
- The Web view-model must be field-whitelisted: render only known boolean/numeric/count fields and ignore unknown payload fields. Do not render arbitrary strings from the response except fixed PM-owned UI copy and sanitized error messages through `textContent`.
- Keep the new hardening-status safety note local to its own panel; do not further inflate the already long Gold readiness HTML safety note beyond the minimum version reference needed by existing tests.
- Commit/push is included because the user has explicitly granted standing approval for this Linke loop. This does not change the general repository rule for unrelated work.

---

### Task 1: Web Hardening Status Tests

**Files:**
- Modify: `test/web-console.test.js`

**Interfaces:**
- Consumes: existing `initConsole()`, `buildMockDoc()`, `LINKE_RELEASE_VERSION`.
- Produces: failing tests for `buildHardeningStatusViewModel()`, HTML hooks, CSS selectors, manual refresh behavior, no startup request, in-flight guard, and non-2xx error rendering.

- [ ] **Step 1: Write failing source contract tests**

Add tests asserting HTML contains:

```text
data-testid="hardening-status-panel"
data-testid="hardening-status-refresh"
data-testid="hardening-status-auth"
data-testid="hardening-status-scoped-tokens"
data-testid="hardening-status-rate-limit"
data-testid="hardening-status-audit-retention"
data-testid="hardening-status-restore-root"
data-testid="hardening-status-request-limit"
data-testid="hardening-status-write-routes"
data-testid="hardening-status-message"
data-testid="hardening-status-safety-note"
```

Add source assertions that `src/web/app.js` references `/api/hardening-status`, `hardening-status-refresh`, and `buildHardeningStatusViewModel`, and `src/web/styles.css` contains `hardening-status-panel[data-status="partial"]` and `hardening-status-panel[data-status="error"]`.

- [ ] **Step 2: Write failing pure-function tests**

Add tests for:

```js
buildHardeningStatusViewModel(null).statusKey === 'unknown'
buildHardeningStatusViewModel(null, 'HTTP 401').statusKey === 'error'
buildHardeningStatusViewModel(payload).statusKey === 'partial'
```

Use payload fields from `buildHardeningStatusResponse()`: `authConfigured`, `scopedTokensConfigured`, `rateLimitConfigured`, `auditRetentionConfigured`, `restoreRootConfigured`, `requestBodyLimitBytes`, `writeRoutes`, and `safety`.

- [ ] **Step 3: Write failing DOM interaction tests**

Add tests proving:

```text
initConsole() does not fetch /api/hardening-status
clicking hardening-status-refresh fetches /api/hardening-status once
rendered text includes configured/not-configured booleans and write route count
returned path-like secret material is redacted instead of displayed
non-2xx response renders data-status="error"
second click while request is in flight does not issue another request
```

- [ ] **Step 4: Verify RED**

Run:

```bash
node --test test/web-console.test.js
```

Expected: FAIL because the panel, view-model function, and wiring do not exist yet.

### Task 2: Web Panel Implementation

**Files:**
- Modify: `src/web/index.html`
- Modify: `src/web/app.js`
- Modify: `src/web/styles.css`

**Interfaces:**
- Consumes: `apiFetch('/api/hardening-status')`, existing `formatReadinessDisplayValue()`, existing refresh button and render patterns.
- Produces: `buildHardeningStatusViewModel(payload, errorMessage = '')` export and manual Web panel rendering.

- [ ] **Step 1: Add HTML panel**

Add a top-level `section` near Gold readiness:

```html
<section id="hardening-status-panel" class="panel hardening-status-panel" data-testid="hardening-status-panel" data-status="unknown">
  <header class="panel-title-row">
    <h2>硬化状态</h2>
    <button id="hardening-status-refresh" data-testid="hardening-status-refresh" type="button" class="release-health-refresh" aria-disabled="false">检查硬化</button>
  </header>
  <dl class="hardening-status-grid">...</dl>
  <p id="hardening-status-message" class="hardening-status-message" data-testid="hardening-status-message">点击检查硬化获取 /api/hardening-status</p>
  <p class="hardening-status-safety-note" data-testid="hardening-status-safety-note">...</p>
</section>
```

- [ ] **Step 2: Add view-model builder**

Export `buildHardeningStatusViewModel(payload, errorMessage = '')`. It returns:

```js
{
  statusKey,
  statusText,
  authText,
  scopedTokensText,
  rateLimitText,
  auditRetentionText,
  restoreRootText,
  requestLimitText,
  writeRoutesText,
  messageText,
}
```

Use only whitelisted boolean and numeric summaries. Ignore unknown payload fields. Do not render any arbitrary response string values besides numeric request limits, known route-count summaries, and sanitized error messages through `textContent`.

- [ ] **Step 3: Wire manual refresh**

Inside `initConsole()`:

```js
let hardeningStatusInFlight = false;
renderHardeningStatus(buildHardeningStatusViewModel(null));
hardeningStatusRefreshButton.addEventListener('click', fetchHardeningStatus);
```

`fetchHardeningStatus()` must use `apiFetch('/api/hardening-status')`, existing token behavior, non-2xx JSON error parsing, busy button state, and no startup fetch.

- [ ] **Step 4: Add CSS selectors**

Add compact panel styles for `unknown`, `partial`, and `error` statuses. Reuse existing visual language from release and Gold readiness panels.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
node --test test/web-console.test.js
```

Expected: PASS.

### Task 3: Version, Docs, Gold Evidence

**Files:**
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `README.md`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**
- Consumes: `LINKE_RELEASE_VERSION`, existing README version table, existing Gold readiness item ids.
- Produces: V0.72 current version, docs for hardening-status Web panel, and tests that reject production-ready overclaim.

- [ ] **Step 1: Add failing docs/version tests**

Update tests to expect:

```text
LINKE_RELEASE_VERSION === 'V0.72'
README title and badge use V0.72
V0.71 is historical and V0.72 is current
README mentions hardening-status Web panel and no startup request/no polling/no NAS/no metadata writes
Gold production-hardening evidence includes hardening-status Web panel tests or src/web/app.js builder
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/version.test.js test/readme.test.js test/gold-readiness.test.js
```

Expected: FAIL because docs/version are still V0.71.

- [ ] **Step 3: Update docs and readiness evidence**

Set `src/version.js` to V0.72, mark README V0.72 current, move V0.71 historical, add a hardening-status Web panel section, and update `production-hardening` evidence while keeping status `partial`. Keep the Gold readiness HTML safety note concise by referencing V0.72 without restating every hardening detail.

- [ ] **Step 4: Verify docs GREEN**

Run:

```bash
node --test test/version.test.js test/readme.test.js test/gold-readiness.test.js
```

Expected: PASS.

### Task 4: Final Verification

**Files:**
- No production files beyond Tasks 1-3.

**Interfaces:**
- Consumes: all changed files and existing test suite.
- Produces: final PM evidence for commit.

- [ ] **Step 1: Run targeted tests**

```bash
node --test test/web-console.test.js test/version.test.js test/readme.test.js test/gold-readiness.test.js test/health.test.js test/agent-hardening-status.test.js
```

- [ ] **Step 2: Run full suite**

```bash
npm test
```

- [ ] **Step 3: Run diff hygiene**

```bash
git diff --check
```

- [ ] **Step 4: Run overclaim scan**

```bash
rg "生产可用|production ready|真实 NAS 备份已实现|real NAS backup is implemented" README.md src test docs
```

Expected: no overclaim matches except tests that explicitly reject them.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-07-06-hardening-status-web-panel.md src/web/index.html src/web/app.js src/web/styles.css src/version.js src/gold-readiness.js README.md test/web-console.test.js test/version.test.js test/readme.test.js test/gold-readiness.test.js
git commit -m "feat: add hardening status web panel"
git push
```
