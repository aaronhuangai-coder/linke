# NAS CLI Readiness Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Linke V0.68 with `nas-dry-run --readiness-summary`, a dry-run-only CLI mode that prints only the NAS readiness summary.

**Architecture:** Reuse `runNasDryRunFromConfig()` and `buildNasDryRunPlan()` exactly as V0.67 does. Add a boolean CLI flag in `src/agent.js` that chooses between printing the full plan and printing `plan.readinessSummary`.

**Tech Stack:** Node.js ESM, `node:test`, existing Linke CLI and NAS dry-run modules.

## Global Constraints

- Do not add real NAS network calls, ping/probe, SMB/WebDAV/SSH/rsync/HTTP execution, or NAS app invocation.
- Do not read environment variables, secret managers, `.env`, credential stores, SSH keys, or cloud credential directories.
- Do not write local metadata, config files, remote NAS files, or audit events for this command.
- Do not echo raw `credentialRef` values in CLI stdout, README examples, docs, tests, or Gold readiness evidence.
- Keep `executionGate.remoteExecutionAllowed:false` and Gold `real-nas-remote-backup` blocked.
- `--readiness-summary` is a boolean flag and must reject a supplied value.
- Missing `plan.readinessSummary` must fail closed with `readinessSummary missing from dry-run plan` rather than printing empty stdout.

---

## File Structure

- Modify `src/agent.js`: document and implement `--readiness-summary` for `nas-dry-run`.
- Create `test/agent-nas-dry-run.test.js`: CLI contract tests for full output compatibility, summary output, no raw reference leak, and invalid flag value.
- Modify `src/version.js`: bump `LINKE_RELEASE_VERSION` to `V0.68`.
- Modify `src/gold-readiness.js`: mention V0.68 CLI readiness summary evidence while preserving partial/blocked statuses.
- Modify `src/web/index.html`: update the Gold safety note version text only; no Web behavior change.
- Modify `README.md`: update current version, version table, CLI docs, NAS docs, Gold docs, and test coverage.
- Modify `test/version.test.js`, `test/readme.test.js`, `test/gold-readiness.test.js`: align release/version/docs evidence.

## Task 1: Failing CLI Tests

**Files:**
- Create: `test/agent-nas-dry-run.test.js`

**Interfaces:**
- Consumes: `src/agent.js` CLI command `nas-dry-run`.
- Produces: failing tests for `--readiness-summary`.

- [x] **Step 1: Create CLI test file**

```js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
const agentPath = join(import.meta.dirname, '..', 'src', 'agent.js');

async function runAgent(args) {
  return exec('node', [agentPath, ...args]);
}

async function rejectAgent(args, expectedCode) {
  try {
    await runAgent(args);
  } catch (err) {
    assert.strictEqual(err.code, expectedCode);
    return err;
  }
  assert.fail(`Expected agent command to exit ${expectedCode}`);
}

async function writeNasConfig(rootDir) {
  const configPath = join(rootDir, 'linke.nas.json');
  await writeFile(
    configPath,
    JSON.stringify({
      deviceId: 'agent-nas-summary-device',
      nasTargets: [
        {
          name: 'primary-synology',
          provider: 'synology',
          endpoint: 'http://192.168.50.10:5000',
          shareName: 'backup',
          remotePath: '/volume1/linke',
          enabled: true,
          credentialRef: 'home-backup',
        },
        {
          name: 'disabled-ugreen',
          provider: 'ugreen',
          endpoint: 'https://192.168.50.20',
          shareName: 'archive',
          remotePath: '/shares/archive',
          enabled: false,
        },
      ],
      backupJobs: [
        { name: 'documents', sourcePath: '/Users/example/Documents' },
      ],
    }),
  );
  return configPath;
}

describe('Agent nas-dry-run CLI', () => {
  it('prints the full sanitized NAS dry-run plan by default', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'linke-agent-nas-'));

    try {
      const configPath = await writeNasConfig(rootDir);
      const { stdout } = await runAgent(['nas-dry-run', '--config', configPath]);
      const plan = JSON.parse(stdout);

      assert.strictEqual(plan.mode, 'dry-run');
      assert.strictEqual(plan.wouldConnect, false);
      assert.strictEqual(plan.wouldWrite, false);
      assert.ok(plan.readinessSummary);
      assert.strictEqual(plan.targets.length, 2);
      assert.strictEqual(plan.targets[0].credentialRefConfigured, true);
      assert.ok(!stdout.includes('home-backup'), 'full plan must not echo raw credentialRef');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('prints only readinessSummary when --readiness-summary is set', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'linke-agent-nas-summary-'));

    try {
      const configPath = await writeNasConfig(rootDir);
      const beforeFiles = await readdir(rootDir);
      const { stdout } = await runAgent(['nas-dry-run', '--config', configPath, '--readiness-summary']);
      const summary = JSON.parse(stdout);
      const afterFiles = await readdir(rootDir);

      assert.deepStrictEqual(afterFiles.sort(), beforeFiles.sort());
      assert.strictEqual(summary.mode, 'dry-run');
      assert.strictEqual(summary.state, 'blocked');
      assert.strictEqual(summary.totalTargets, 2);
      assert.strictEqual(summary.enabledTargets, 1);
      assert.strictEqual(summary.disabledTargets, 1);
      assert.strictEqual(summary.credentialRefConfiguredTargets, 1);
      assert.strictEqual(summary.enabledCredentialRefMissingTargets, 0);
      assert.strictEqual(summary.blockedTargets, 2);
      assert.strictEqual(summary.remoteExecutionBlocked, true);
      assert.deepStrictEqual(
        summary.blockers.sort(),
        ['remote-execution-blocked', 'target-disabled'].sort(),
      );

      assert.ok(!Object.hasOwn(summary, 'targets'), 'summary output must not include targets');
      assert.ok(!Object.hasOwn(summary, 'jobs'), 'summary output must not include jobs');
      assert.ok(!stdout.includes('home-backup'), 'summary must not echo raw credentialRef');
      assert.ok(!stdout.includes('192.168.50.10'), 'summary must not echo endpoint');
      assert.ok(!stdout.includes('/volume1/linke'), 'summary must not echo remotePath');
      assert.ok(!stdout.includes('/Users/example/Documents'), 'summary must not echo sourcePath');
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('rejects a value after --readiness-summary', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'linke-agent-nas-summary-value-'));

    try {
      const configPath = await writeNasConfig(rootDir);
      const err = await rejectAgent([
        'nas-dry-run',
        '--config',
        configPath,
        '--readiness-summary',
        'json',
      ], 1);

      assert.match(err.stderr, /--readiness-summary does not accept a value/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
```

- [x] **Step 2: Run RED test**

Run:

```bash
node --test test/agent-nas-dry-run.test.js
```

Expected: FAIL because `nas-dry-run --readiness-summary` still prints the full plan and does not reject flag values.

## Task 2: CLI Implementation And Version Sync

**Files:**
- Modify: `src/agent.js`
- Modify: `src/version.js`

**Interfaces:**
- Consumes: `plan.readinessSummary`.
- Produces: `nas-dry-run --readiness-summary` CLI output.

- [x] **Step 1: Update CLI comments and usage**

In `src/agent.js`, add `--readiness-summary` to the top comment and `printUsage()` options:

```text
--readiness-summary Print only NAS readinessSummary for nas-dry-run
```

- [x] **Step 2: Implement flag handling**

In the `nas-dry-run` case:

```js
case 'nas-dry-run': {
  if (!args.config) throw new Error('--config is required');
  if (args['readiness-summary'] !== undefined && args['readiness-summary'] !== true) {
    throw new Error('--readiness-summary does not accept a value');
  }
  const plan = await runNasDryRunFromConfig(args.config);
  let output = plan;
  if (args['readiness-summary'] === true) {
    if (!plan.readinessSummary) {
      throw new Error('readinessSummary missing from dry-run plan');
    }
    output = plan.readinessSummary;
  }
  console.log(JSON.stringify(output, null, 2));
  break;
}
```

- [x] **Step 3: Bump version**

In `src/version.js`:

```js
export const LINKE_RELEASE_VERSION = 'V0.68';
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
- Consumes: V0.68 CLI behavior from Task 2.
- Produces: release docs and readiness evidence aligned to V0.68.

- [x] **Step 1: Update version tests**

Change the milestone expectation in `test/version.test.js` from `V0.67` to `V0.68`.

- [x] **Step 2: Add README tests**

Add/adjust tests so README asserts:

```js
assert.match(readme, /# Linke V0\.68/);
assert.match(readme, /\*\*当前版本：V0\.68\*\*/);
assert.match(readme, /\| V0\.67 \| 历史版本 \|/);
assert.match(readme, /\| V0\.68 \| 当前版本 \|[^|]*(readiness-summary|readinessSummary|CLI|摘要)/i);
assert.match(readme, /nas-dry-run[\s\S]*--readiness-summary[\s\S]*readinessSummary/i);
const forbiddenOverclaims = [
  ['production', 'ready'].join(' '),
  ['production', 'ready'].join('-'),
  ['Gold', 'ready'].join(' '),
  ['Gold', 'ready'].join('-'),
  ['real NAS remote backup', 'ready'].join(' '),
  '无安全' + '隐患',
].join('|');
assert.doesNotMatch(readme, new RegExp(forbiddenOverclaims, 'i'));
```

- [x] **Step 3: Update README**

Update:

- title and current version badge to V0.68
- version table V0.67 -> historical, V0.68 -> current
- feature summary for NAS dry-run
- CLI usage section with:

```bash
node src/agent.js nas-dry-run --config linke.config.json --readiness-summary
```

- NAS docs explaining the summary mode does not output targets, endpoints, jobs, source paths, or raw `credentialRef`
- Gold blockers text to keep `real-nas-remote-backup` blocked
- testing coverage sentence to include `Agent nas-dry-run CLI readiness summary`

- [x] **Step 4: Update Gold readiness evidence**

In `src/gold-readiness.js`, add evidence strings:

```js
'test/agent-nas-dry-run.test.js',
'src/agent.js nas-dry-run --readiness-summary',
```

Update the NAS next step to mention V0.68 while keeping status `partial`.

- [x] **Step 5: Update Web safety note**

In `src/web/index.html`, update the Gold safety note from V0.67 to V0.68 and mention the CLI readiness summary. Do not add new Web behavior.

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
node --input-type=module -e "import { readFileSync } from 'node:fs'; const files=['README.md','docs/superpowers/specs/2026-07-06-nas-cli-readiness-summary-design.md','docs/superpowers/plans/2026-07-06-nas-cli-readiness-summary.md']; const terms=['production'+' ready','production'+'-ready','Gold'+' ready','Gold'+'-ready','real NAS remote backup'+' ready','无安全'+'隐患']; let failed=false; for (const file of files) { const text=readFileSync(file,'utf8'); for (const term of terms) { if (text.includes(term)) { console.error(file + ': forbidden overclaim phrase'); failed=true; } } } process.exit(failed ? 1 : 0);"
```

Expected: no output.

- [x] **Step 4: Review diff scope**

```bash
git diff --stat
git diff --name-only
```

Expected: only V0.68 CLI/docs/tests/readiness files.

- [x] **Step 5: Commit and push**

```bash
git add README.md src/agent.js src/gold-readiness.js src/version.js src/web/index.html test/agent-nas-dry-run.test.js test/gold-readiness.test.js test/readme.test.js test/version.test.js docs/superpowers/specs/2026-07-06-nas-cli-readiness-summary-design.md docs/superpowers/plans/2026-07-06-nas-cli-readiness-summary.md
git commit -m "feat: add nas readiness summary cli"
git push
```

## Self-Review

- Spec coverage: CLI flag, safety boundaries, docs, tests, version, Gold evidence are mapped to tasks.
- Placeholder scan: no unresolved placeholder markers.
- Type consistency: the plan uses existing `plan.readinessSummary` and no new public NAS API type.
- Boundary check: no task enables NAS network, credential resolution, app invocation, remote write, or Gold promotion.
