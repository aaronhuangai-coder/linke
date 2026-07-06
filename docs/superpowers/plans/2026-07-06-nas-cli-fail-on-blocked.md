# NAS CLI Fail-On-Blocked Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Linke V0.69 with `nas-dry-run --fail-on-blocked`, a dry-run-only CLI automation gate that returns exit code `2` when NAS readiness is blocked.

**Architecture:** Reuse the V0.68 `runNasDryRunFromConfig()` and `readinessSummary` flow in `src/agent.js`. Add one boolean flag validation branch and one post-output exit-code branch without changing the NAS dry-run plan shape or enabling any external NAS behavior.

**Tech Stack:** Node.js ESM, `node:test`, existing Linke CLI and NAS dry-run modules.

## Global Constraints

- Do not add real NAS network calls, ping/probe, SMB/WebDAV/SSH/rsync/HTTP execution, or NAS app invocation.
- Do not read environment variables, secret managers, `.env`, credential stores, SSH keys, or cloud credential directories.
- Do not write local metadata, config files, audit events, remote NAS files, or any production data for this command.
- Do not echo raw `credentialRef` values in CLI stdout, README examples, docs, tests, or Gold readiness evidence.
- Keep `executionGate.remoteExecutionAllowed:false` and Gold `real-nas-remote-backup` blocked.
- `--fail-on-blocked` is a boolean flag and must reject a supplied value.
- Exit code `2` means a completed dry-run readiness check is blocked; it is not a command error.
- No-flag `nas-dry-run --config <file>` behavior remains V0.68-compatible and does not add a new unconditional `readinessSummary` failure path.

---

## File Structure

- Modify `src/agent.js`: document and implement `--fail-on-blocked` for `nas-dry-run`.
- Modify `test/agent-nas-dry-run.test.js`: CLI contract tests for exit `2`, summary/full stdout, and value rejection.
- Modify `src/version.js`: bump `LINKE_RELEASE_VERSION` to `V0.69`.
- Modify `src/gold-readiness.js`: mention V0.69 CLI fail-on-blocked evidence while preserving partial/blocked statuses.
- Modify `src/web/index.html`: update Gold safety note version text only; no Web behavior change.
- Modify `README.md`: update current version, version table, CLI docs, NAS docs, Gold docs, and test coverage.
- Modify `test/version.test.js`, `test/readme.test.js`, `test/gold-readiness.test.js`: align release/version/docs evidence.

## Task 1: Failing CLI Tests

**Files:**
- Modify: `test/agent-nas-dry-run.test.js`

**Interfaces:**
- Consumes: `src/agent.js` CLI command `nas-dry-run`.
- Produces: failing tests for `--fail-on-blocked`.

- [x] **Step 1: Add blocked exit tests**

Add these tests inside `describe('Agent nas-dry-run CLI', ...)` after the existing `--readiness-summary` test. The existing default full-plan test must continue to assert exit `0` and `plan.readinessSummary` presence, which covers the V0.69 compatibility precondition for the no-flag path.

```js
  it('exits 2 after printing the full plan when --fail-on-blocked sees blocked readiness', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'linke-agent-nas-fail-blocked-'));

    try {
      const configPath = await writeNasConfig(rootDir);
      const err = await rejectAgent(['nas-dry-run', '--config', configPath, '--fail-on-blocked'], 2);
      const plan = JSON.parse(err.stdout);

      assert.strictEqual(err.stderr, '');
      assert.strictEqual(plan.mode, 'dry-run');
      assert.strictEqual(plan.wouldConnect, false);
      assert.strictEqual(plan.wouldWrite, false);
      assert.strictEqual(plan.readinessSummary.state, 'blocked');
      assert.strictEqual(plan.readinessSummary.remoteExecutionBlocked, true);
      assert.ok(Array.isArray(plan.targets), 'full plan must still include targets');
      assert.ok(!err.stdout.includes('home-backup'), 'full plan must not echo raw credentialRef');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('exits 2 with summary-only JSON when --readiness-summary and --fail-on-blocked are combined', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'linke-agent-nas-summary-fail-blocked-'));

    try {
      const configPath = await writeNasConfig(rootDir);
      const err = await rejectAgent([
        'nas-dry-run',
        '--config',
        configPath,
        '--readiness-summary',
        '--fail-on-blocked',
      ], 2);
      const summary = JSON.parse(err.stdout);

      assert.strictEqual(err.stderr, '');
      assert.strictEqual(summary.mode, 'dry-run');
      assert.strictEqual(summary.state, 'blocked');
      assert.strictEqual(summary.remoteExecutionBlocked, true);
      assert.ok(!Object.hasOwn(summary, 'targets'), 'summary output must not include targets');
      assert.ok(!Object.hasOwn(summary, 'jobs'), 'summary output must not include jobs');
      assert.ok(!err.stdout.includes('home-backup'), 'summary must not echo raw credentialRef');
      assert.ok(!err.stdout.includes('192.168.50.10'), 'summary must not echo endpoint');
      assert.ok(!err.stdout.includes('/volume1/linke'), 'summary must not echo remotePath');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
```

- [x] **Step 2: Add invalid value test**

Add this test near the existing invalid `--readiness-summary` value test:

```js
  it('rejects a value after --fail-on-blocked', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'linke-agent-nas-fail-blocked-value-'));

    try {
      const configPath = await writeNasConfig(rootDir);
      const err = await rejectAgent([
        'nas-dry-run',
        '--config',
        configPath,
        '--fail-on-blocked',
        'true',
      ], 1);

      assert.match(err.stderr, /--fail-on-blocked does not accept a value/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
```

- [x] **Step 3: Run RED test**

Run:

```bash
node --test test/agent-nas-dry-run.test.js
```

Expected: FAIL because `--fail-on-blocked` is not implemented and value rejection does not exist.

## Task 2: CLI Implementation And Version Sync

**Files:**
- Modify: `src/agent.js`
- Modify: `src/version.js`

**Interfaces:**
- Consumes: `plan.readinessSummary.state`.
- Produces: `nas-dry-run --fail-on-blocked` exit behavior.

- [x] **Step 1: Update CLI comments and usage**

In `src/agent.js`, add `--fail-on-blocked` to the top comment and `printUsage()` options:

```text
--fail-on-blocked   Exit 2 when nas-dry-run readinessSummary.state is blocked
```

- [x] **Step 2: Implement flag handling**

In the `nas-dry-run` case, validate both boolean flags and set exit code after printing:

```js
case 'nas-dry-run': {
  if (!args.config) throw new Error('--config is required');
  if (args['readiness-summary'] !== undefined && args['readiness-summary'] !== true) {
    throw new Error('--readiness-summary does not accept a value');
  }
  if (args['fail-on-blocked'] !== undefined && args['fail-on-blocked'] !== true) {
    throw new Error('--fail-on-blocked does not accept a value');
  }
  const plan = await runNasDryRunFromConfig(args.config);
  const needsReadinessSummary = args['readiness-summary'] === true || args['fail-on-blocked'] === true;
  const readinessSummary = plan.readinessSummary;
  if (needsReadinessSummary && !readinessSummary) {
    throw new Error('readinessSummary missing from dry-run plan');
  }
  let output = plan;
  if (args['readiness-summary'] === true) {
    output = readinessSummary;
  }
  console.log(JSON.stringify(output, null, 2));
  if (args['fail-on-blocked'] === true && readinessSummary.state === 'blocked') {
    process.exitCode = 2;
  }
  break;
}
```

- [x] **Step 3: Bump version**

In `src/version.js`:

```js
export const LINKE_RELEASE_VERSION = 'V0.69';
```

- [x] **Step 4: Run GREEN tests**

Run:

```bash
node --test test/agent-nas-dry-run.test.js test/version.test.js
```

Expected: agent NAS tests pass; version test fails until docs/tests are updated.

## Task 3: Docs, Gold Evidence, And Test Alignment

**Files:**
- Modify: `README.md`
- Modify: `src/gold-readiness.js`
- Modify: `src/web/index.html`
- Modify: `test/version.test.js`
- Modify: `test/readme.test.js`
- Modify: `test/gold-readiness.test.js`

**Interfaces:**
- Consumes: V0.69 CLI behavior from Task 2.
- Produces: release docs and readiness evidence aligned to V0.69.

- [x] **Step 1: Update version tests**

Change the milestone expectation in `test/version.test.js` from `V0.68` to `V0.69`.

- [x] **Step 2: Add README tests**

Add/adjust tests so README asserts:

```js
assert.match(readme, /# Linke V0\.69/);
assert.match(readme, /\*\*当前版本：V0\.69\*\*/);
assert.match(readme, /\| V0\.68 \| 历史版本 \|/);
assert.match(readme, /\| V0\.69 \| 当前版本 \|[^|]*(fail-on-blocked|exit code|退出码|自动化门禁)/i);
assert.match(readme, /nas-dry-run[\s\S]*--fail-on-blocked[\s\S]*(exit code|退出码|2)/i);
```

- [x] **Step 3: Update README**

Update:

- title and current version badge to V0.69
- version table V0.68 -> historical, V0.69 -> current
- feature summary for NAS dry-run
- CLI usage section with:

```bash
node src/agent.js nas-dry-run --config linke.config.json --fail-on-blocked
node src/agent.js nas-dry-run --config linke.config.json --readiness-summary --fail-on-blocked
```

- NAS docs explaining exit code `2` means blocked readiness after valid JSON output, not command failure
- Gold blockers text to keep `real-nas-remote-backup` blocked
- testing coverage sentence to include `Agent nas-dry-run CLI fail-on-blocked`

- [x] **Step 4: Update Gold readiness evidence**

In `src/gold-readiness.js`, add evidence string:

```js
'src/agent.js nas-dry-run --fail-on-blocked',
```

Update the NAS next step to mention V0.69 while keeping status `partial`.

- [x] **Step 5: Update Web safety note**

In `src/web/index.html`, update the Gold safety note from V0.68 to V0.69 and mention the CLI fail-on-blocked automation gate. Do not add new Web behavior.

- [x] **Step 6: Run targeted docs/readiness tests**

Run:

```bash
node --test test/agent-nas-dry-run.test.js test/version.test.js test/readme.test.js test/gold-readiness.test.js
```

Expected: PASS.

## Task 4: Final Verification

**Files:**
- No new code edits unless tests expose a defect.

- [x] **Step 1: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

- [x] **Step 2: Check whitespace**

```bash
git diff --check
```

Expected: no output.

- [x] **Step 3: Check safety phrase scan**

```bash
node --input-type=module -e "import { readFileSync } from 'node:fs'; const files=['README.md','docs/superpowers/specs/2026-07-06-nas-cli-fail-on-blocked-design.md','docs/superpowers/plans/2026-07-06-nas-cli-fail-on-blocked.md']; const terms=['production'+' ready','production'+'-ready','Gold'+' ready','Gold'+'-ready','real NAS remote backup'+' ready','无安全'+'隐患']; let failed=false; for (const file of files) { const text=readFileSync(file,'utf8'); for (const term of terms) { if (text.includes(term)) { console.error(file + ': forbidden overclaim phrase'); failed=true; } } } process.exit(failed ? 1 : 0);"
```

Expected: no output.

- [x] **Step 4: Review diff scope**

```bash
git diff --stat
git diff --name-only
```

Expected: only V0.69 CLI/docs/tests/readiness files.

- [ ] **Step 5: Commit and push**

```bash
git add README.md src/agent.js src/gold-readiness.js src/version.js src/web/index.html test/agent-nas-dry-run.test.js test/gold-readiness.test.js test/readme.test.js test/version.test.js docs/superpowers/specs/2026-07-06-nas-cli-fail-on-blocked-design.md docs/superpowers/plans/2026-07-06-nas-cli-fail-on-blocked.md
git commit -m "feat: add nas blocked readiness exit gate"
git push
```

## Self-Review

- Spec coverage: CLI flag, exit codes, stdout/stderr behavior, safety boundaries, docs, tests, version, and Gold evidence are mapped to tasks.
- Placeholder scan: no unresolved placeholder markers.
- Type consistency: the plan uses existing `plan.readinessSummary.state` and no new public NAS API type.
- Boundary check: no task enables NAS network, credential resolution, app invocation, remote write, local metadata write, or Gold promotion.

## PM Verification Evidence

- Targeted verification: `node --test test/agent-nas-dry-run.test.js test/version.test.js test/readme.test.js test/gold-readiness.test.js` -> 317 pass, 0 fail.
- Full verification: `npm test` -> 930 pass, 0 fail.
- Whitespace: `git diff --check` -> no output.
- Safety wording scan: README/spec/plan scan -> no forbidden overclaim phrases.
- Diff scope: limited to V0.69 NAS CLI fail-on-blocked code, tests, release docs, Gold readiness evidence, Web safety note, and this spec/plan.
