# Linke V1.45 NAS Dry-Run Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The Codex host remains orchestrator/verifier; implementation is delegated to the configured pm-dcw workers rather than collaboration subagents.

**Goal:** Promote `nas-dry-run` from a permanently blocked V1 contract to a V2 configuration-readiness gate aligned with the implemented mounted SMB adapter, without authorizing execution or touching NAS/mount paths.

**Architecture:** `src/nas.js` becomes the single source of the V2 dry-run schema and configuration-only readiness calculation. Existing Agent and API surfaces continue to pass through the plan; Web rendering distinguishes adapter availability, configuration readiness, pending runtime verification, and execution authorization. Version/Gold documentation advances to V1.45 only after behavior, zero-connect process evidence, and the committed V1.44 real-NAS receipt form a conjunctive evidence set.

**Tech Stack:** Node.js ESM, `node:test`, `node:assert`, Agent CLI child processes, local HTTP/TCP sentinel, existing vanilla DOM test harness, static Gold scorecard.

## Global Constraints

- Design source: `docs/superpowers/specs/2026-07-28-v145-nas-dry-run-readiness-design.md` at commit `28cdf8a`.
- Last-green runtime anchor before implementation: `eea7c9d0b2a2aac2597e4a42fc0339e19c357b42`; design-only HEAD is `28cdf8a`.
- `nas-dry-run` must always return `wouldConnect:false`, `wouldWrite:false`, and `executionGate.executionAuthorized:false`.
- Configuration-ready never means mount verified or execution authorized.
- Real execution remains exclusively under `nas-snapshot-replicate --execute` plus `LINKE_NAS_SMB_EXECUTION=enabled`.
- No real NAS write, mount inspection, deployment, launchd, cron, email, credential read/write, or production mutation is authorized.
- Never read, hash, modify, stage, or commit the existing untracked `package-lock.json`.
- Never read `.env`, `secrets/`, `credentials/`, SSH, cloud-auth, `~/.grok`, or identity files.
- `package.json` remains version `0.1.0`; public release version changes only in `src/version.js` and documented current surfaces.
- Commit and push are separate human gates. Every task stops before commit until the user explicitly approves that exact staged set; no task pushes.
- Grok is native CLI only: `grok-4.5`, `--reasoning-effort high`, `--permission-mode dontAsk`, exact `Edit(file)` allows, four denies, `--no-subagents --no-memory --disable-web-search`.
- GLM/Kimi helpers are read-only and cannot claim local file/test access. Reviewer and closure reviewer use independent fresh Kimi sessions.
- Qwen statistics use `effort=N/A:no-supported-control` and do not decide release truth.
- Any invalid RED, unexpected tracked diff, worker schema error, timeout without a conclusion, safety filter, or missing evidence is HOLD—not approval.

## File and Responsibility Map

- `src/nas.js`: V2 schema constants, per-target configuration readiness, summary aggregation, sanitized plan projection.
- `test/nas-dry-run.test.js`: pure readiness matrix, schema compatibility, redaction, and no-mount prerequisite contract.
- `test/agent-nas-dry-run.test.js`: real Agent subprocess exit codes, summary projection, sanitization, zero endpoint connection.
- `src/web/app.js`: fail-closed V2 and legacy rendering; never infers authorization from readiness.
- `test/web-console.test.js`: API passthrough and DOM wording/contracts.
- `src/gold-readiness.js`: static `nas-dry-run=ready` evidence only after Tasks 1–3 pass.
- `src/version.js`: public V1.45 version constant.
- `test/gold-readiness.test.js`: frozen nine-item status snapshot and evidence-domain assertions.
- `test/agent-gold-readiness.test.js`: Agent/API summary count `6/3/0/9`.
- `test/version.test.js`: current V1.45 surface plus historical V1.44 receipt preservation.
- `test/readme.test.js`: current V1.45 claims and non-Gold honesty.
- `README.md`: current badge/table/docs; historical V1.44 facts remain intact.

## Execution Protocol

For every production-changing task:

1. Codex records `git status --short`, HEAD/upstream, and hashes of protected tracked files.
2. Grok first receives only the task's test-file `Edit(...)` allow.
3. Codex verifies the test-only diff and runs the exact RED command.
4. RED is valid only when it fails on the intended missing V1.45 behavior.
5. Grok receives a fresh implementation call with the verified RED output and only the minimum production-file allow.
6. Codex reviews every hunk, runs GREEN and relevant regressions, and checks protected hashes.
7. A task is staged only after all gates pass; Codex then asks for commit approval.

Task 2 is the bounded evidence-only exception: it adds real-process contract tests after Task 1's valid RED/GREEN, expects no production edit, and stops rather than manufacturing a second RED.

The baseline focused suite is currently green: `911 pass / 0 fail` from:

```bash
node --test test/nas-dry-run.test.js test/agent-nas-dry-run.test.js test/web-console.test.js test/gold-readiness.test.js test/agent-gold-readiness.test.js test/version.test.js test/readme.test.js
```

---

### Task 1: V2 Core Configuration Readiness

**Files:**

- Modify: `test/nas-dry-run.test.js:479-840`
- Modify after valid RED: `src/nas.js:13-27,149-270`

**Interfaces:**

- Consumes: validated target shape returned by `validateNasTarget(target)`.
- Produces: `getTargetExecutionReadiness(target) -> { schemaVersion, state, basis, blockers, runtimeVerificationPerformed, runtimeVerificationRequired }`.
- Produces: `buildReadinessSummary(targets) -> V2 configuration-only summary`.
- Produces: `buildNasDryRunPlan(config) -> schemaVersion:2 sanitized plan`.
- Preserves: exported legacy blocker constants and JSON compatibility fields, but removes them from active V2 blocker output.

- [ ] **Step 1: Freeze Task 1 boundaries**

Run:

```bash
git status --short --untracked-files=all -- . ':(exclude)package-lock.json'
git hash-object src/nas.js test/nas-dry-run.test.js src/agent.js src/smb-snapshot-replication.js src/config.js
```

Expected: the explicitly excluded repository scope has no tracked or untracked diff. The already known unrelated `package-lock.json` remains outside the command scope. Record only the listed tracked-file hashes.

- [ ] **Step 2: Add failing V2 schema and safety tests**

In `test/nas-dry-run.test.js`, replace the old permanent-block assumptions with exact assertions equivalent to:

```js
const plan = buildNasDryRunPlan({
  deviceId: 'v145-ready',
  nasTargets: [{
    name: 'ready-synology',
    provider: 'synology',
    endpoint: 'https://nas.example.invalid',
    shareName: 'backup',
    remotePath: '/provider-owned/path',
    enabled: true,
    mountedShare: {
      enabled: true,
      mountPath: '/path/that/does/not/exist',
      relativeRoot: 'linke/v145',
    },
  }],
  backupJobs: [],
});

assert.strictEqual(plan.schemaVersion, 2);
assert.deepStrictEqual(plan.executionGate, {
  schemaVersion: 2,
  adapterAvailable: true,
  executionAuthorized: false,
  remoteExecutionAllowed: false,
  blockingReason: 'dry-run does not authorize execution',
  requiredGates: [
    { type: 'cli-flag', name: '--execute' },
    { type: 'env-var', name: 'LINKE_NAS_SMB_EXECUTION' },
  ],
});
assert.strictEqual(plan.wouldConnect, false);
assert.strictEqual(plan.wouldWrite, false);
assert.deepStrictEqual(plan.targets[0].executionReadiness, {
  schemaVersion: 2,
  state: 'ready',
  basis: 'configuration-only',
  blockers: [],
  runtimeVerificationPerformed: false,
  runtimeVerificationRequired: true,
});
```

Add separate tests with exact expected states:

- ready mountedShare with no `credentialRef` -> ready;
- ready mountedShare with a `credentialRef` -> ready and raw ref absent;
- disabled target -> blockers exactly `['target-disabled']`; do not add mount blockers for a disabled target;
- enabled target without mountedShare -> `['mounted-share-missing']`;
- enabled credentialRef-only legacy target -> `['mounted-share-missing']`;
- enabled target with `mountedShare.enabled:false` -> `['mounted-share-disabled']`;
- empty targets -> summary blockers exactly `['no-targets-configured']`;
- mixed ready/missing/disabled targets in that order -> blockers exactly `['mounted-share-missing', 'target-disabled']` in stable first-seen order, with no credential/remote blocker;
- input attempts to override `executionGate` cannot change any gate value;
- serialized plan excludes mountPath, relativeRoot, raw credentialRef, and gate values other than the two bare names.

For every ready and blocked case, explicitly assert target and summary `blockers` arrays do not contain the exact kebab-case identifiers `remote-execution-blocked` or `credential-ref-missing`; the camelCase compatibility fields and counts remain. For every blocked target, assert both `runtimeVerificationPerformed:false` and `runtimeVerificationRequired:false`.

- [ ] **Step 3: Add failing V2 summary count tests**

Use three targets: one ready mountedShare, one enabled legacy target, one disabled target. Assert:

```js
assert.deepStrictEqual(plan.readinessSummary, {
  schemaVersion: 2,
  mode: 'dry-run',
  scope: 'configuration-only',
  state: 'blocked',
  totalTargets: 3,
  enabledTargets: 2,
  disabledTargets: 1,
  credentialRefConfiguredTargets: 1,
  enabledCredentialRefMissingTargets: 1,
  mountedShareConfiguredTargets: 1,
  mountedShareEnabledTargets: 1,
  configurationReadyTargets: 1,
  runtimeVerificationPendingTargets: 1,
  blockedTargets: 2,
  executionAuthorized: false,
  remoteExecutionBlocked: true,
  blockers: ['mounted-share-missing', 'target-disabled'],
});
```

The target array order in this fixture must be ready, legacy-missing, disabled so the expected blocker order is deterministic.

- [ ] **Step 4: Run Task 1 RED**

Run:

```bash
node --test test/nas-dry-run.test.js
```

Expected: FAIL because current output lacks `schemaVersion:2`/new gate fields, still emits `remote-execution-blocked`, and does not use mountedShare readiness. Syntax/import/fixture failures invalidate the RED.

- [ ] **Step 5: Implement immutable V2 constants and blockers**

In `src/nas.js`, define the exact active blocker set while retaining legacy exports:

```js
const NAS_DRY_RUN_SCHEMA_VERSION = 2;

const NAS_REQUIRED_EXECUTION_GATES = Object.freeze([
  Object.freeze({ type: 'cli-flag', name: '--execute' }),
  Object.freeze({ type: 'env-var', name: 'LINKE_NAS_SMB_EXECUTION' }),
]);

const NAS_EXECUTION_GATE = Object.freeze({
  schemaVersion: NAS_DRY_RUN_SCHEMA_VERSION,
  adapterAvailable: true,
  executionAuthorized: false,
  remoteExecutionAllowed: false,
  blockingReason: 'dry-run does not authorize execution',
  requiredGates: NAS_REQUIRED_EXECUTION_GATES,
});

export const NAS_EXECUTION_READINESS_BLOCKERS = Object.freeze({
  NO_TARGETS_CONFIGURED: 'no-targets-configured',
  TARGET_DISABLED: 'target-disabled',
  MOUNTED_SHARE_MISSING: 'mounted-share-missing',
  MOUNTED_SHARE_DISABLED: 'mounted-share-disabled',
  CREDENTIAL_REF_MISSING: 'credential-ref-missing',
  REMOTE_EXECUTION_BLOCKED: 'remote-execution-blocked',
});
```

The last two entries are compatibility constants only and must never be pushed into a V2 readiness array.

- [ ] **Step 6: Implement per-target readiness**

Replace the global-gate calculation with this exact branch order:

```js
export function getTargetExecutionReadiness(target) {
  let blocker = null;
  if (!target.enabled) {
    blocker = NAS_EXECUTION_READINESS_BLOCKERS.TARGET_DISABLED;
  } else if (!target.mountedShare) {
    blocker = NAS_EXECUTION_READINESS_BLOCKERS.MOUNTED_SHARE_MISSING;
  } else if (!target.mountedShare.enabled) {
    blocker = NAS_EXECUTION_READINESS_BLOCKERS.MOUNTED_SHARE_DISABLED;
  }

  const blockers = blocker ? [blocker] : [];
  const ready = blockers.length === 0;
  return {
    schemaVersion: NAS_DRY_RUN_SCHEMA_VERSION,
    state: ready ? 'ready' : 'blocked',
    basis: 'configuration-only',
    blockers,
    runtimeVerificationPerformed: false,
    runtimeVerificationRequired: ready,
  };
}
```

- [ ] **Step 7: Implement V2 summary aggregation**

Update `buildReadinessSummary(targets)` to:

- retain existing credential count fields as informational compatibility fields;
- add mountedShare/configuration/runtime counts;
- add `no-targets-configured` only when `targets.length === 0`;
- aggregate target blockers in first-seen order through `Set`;
- set state from `blockedTargets > 0 || totalTargets === 0`;
- always return `executionAuthorized:false` and `remoteExecutionBlocked:true`.

Return fields in the exact order shown in Step 3 so JSON/key-order tests remain stable.

- [ ] **Step 8: Project the V2 plan without path leakage**

In `buildNasDryRunPlan(config)`:

```js
const executionReadiness = getTargetExecutionReadiness(t);
```

Add `schemaVersion: NAS_DRY_RUN_SCHEMA_VERSION` to the top level, keep the existing boolean-only mountedShare projection, call `buildReadinessSummary(targets)`, and clone `requiredGates` so callers cannot mutate module constants:

```js
executionGate: {
  ...NAS_EXECUTION_GATE,
  requiredGates: NAS_EXECUTION_GATE.requiredGates.map((gate) => ({ ...gate })),
},
```

Do not import `smb-snapshot-replication.js`, `fs`, `net`, or an SMB inspector into `src/nas.js`.

- [ ] **Step 9: Run Task 1 GREEN and direct regressions**

Run:

```bash
node --test test/nas-dry-run.test.js test/config.test.js test/smb-snapshot-replication.test.js
git diff --check -- src/nas.js test/nas-dry-run.test.js
```

Expected: all pass; no diff outside the two Task 1 files.

- [ ] **Step 10: Review and stop at Task 1 commit gate**

Run:

```bash
git diff --numstat -- src/nas.js test/nas-dry-run.test.js
git diff -- src/nas.js test/nas-dry-run.test.js
git status --short --untracked-files=all -- . ':(exclude)package-lock.json'
```

Expected: only Task 1 files are tracked changes in the explicitly excluded scope. The known unrelated `package-lock.json` remains untouched outside that scope. Proposed commit after explicit approval:

```bash
git add src/nas.js test/nas-dry-run.test.js
git commit -m "feat: align NAS dry-run configuration readiness"
```

---

### Task 2: Agent CLI Zero-Connect and Exit-Code Contract

**Files:**

- Modify: `test/agent-nas-dry-run.test.js:1-233`
- Production files: none expected

**Interfaces:**

- Consumes: V2 plan from Task 1 and unchanged `src/agent.js` state-driven exit logic.
- Produces: real subprocess evidence for exit `0/1/2`, summary-only output, no endpoint connection, and no mounted-path prerequisite.

Pre-TDD source confirmation: current `src/agent.js` passes the complete plan through, selects `plan.readinessSummary` only for `--readiness-summary`, and sets exit `2` only when `--fail-on-blocked` sees `readinessSummary.state === 'blocked'`. Keep it out of scope unless the real-process test disproves that contract.

- [ ] **Step 1: Add a ready-config fixture and TCP sentinel helpers**

Add `createServer` from `node:net`, plus deterministic helpers:

```js
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}
```

Add `writeReadyNasConfig(rootDir, endpoint)` containing one enabled Synology target, no credentialRef, mountedShare enabled, `mountPath: join(rootDir, 'missing-mounted-share')`, and `relativeRoot:'linke/v145'`.

- [ ] **Step 2: Add ready/zero-connect CLI contract tests**

Start a TCP sentinel whose connection handler increments `connectionCount` and destroys the socket. Bind the ready configuration endpoint to that exact sentinel before invoking the Agent:

```js
const port = await listen(sentinel);
const endpoint = `http://127.0.0.1:${port}`;
const configPath = await writeReadyNasConfig(rootDir, endpoint);
```

Run:

```js
const { stdout, stderr } = await runAgent([
  'nas-dry-run', '--config', configPath, '--fail-on-blocked',
]);
const plan = JSON.parse(stdout);
assert.strictEqual(stderr, '');
assert.strictEqual(plan.readinessSummary.state, 'ready');
assert.strictEqual(plan.executionGate.executionAuthorized, false);
assert.strictEqual(plan.wouldConnect, false);
assert.strictEqual(plan.wouldWrite, false);
assert.strictEqual(connectionCount, 0);
```

Add the summary-only variant and assert its exact V2 keys. Keep the existing mixed/disabled fixture to prove exit `2`. Add invalid provider, relative `mountPath`, and unsupported `mountedShare` key cases; each must exit `1`, emit empty stdout, and produce sanitized stderr.

Across ready, blocked, and invalid CLI cases, assert stdout and stderr omit the missing mount path, `relativeRoot`, raw `credentialRef`, `agentPath`, the literal fake gate value `do-not-leak-gate-value`, and the keys `mountPath`, `relativeRoot`, and `credentialRef`.

- [ ] **Step 3: Run the Task 2 contract verification**

Run:

```bash
node --test test/agent-nas-dry-run.test.js
```

Expected: PASS against Task 1. This is explicitly a post-RED Gold-evidence/regression task with no production change, so a second production RED is N/A; Task 1 already established the valid behavior RED before `src/nas.js` changed. Stop immediately on any assertion failure and treat it as either a Task 1 implementation defect or an unexpected `src/agent.js` scope expansion; update the design before editing `src/agent.js`.

- [ ] **Step 4: Verify no artifacts and no connection**

Assert temporary root contents are unchanged except the input config, `connectionCount === 0`, and the missing mount directory was not created. Run:

```bash
node --test test/agent-nas-dry-run.test.js test/nas-dry-run.test.js
git diff --check -- test/agent-nas-dry-run.test.js
```

- [ ] **Step 5: Review and stop at Task 2 commit gate**

Proposed commit after explicit approval:

```bash
git add test/agent-nas-dry-run.test.js
git commit -m "test: verify NAS dry-run zero-connect CLI gate"
```

---

### Task 3: Web/API Configuration-Readiness Rendering

**Files:**

- Modify: `test/web-console.test.js:605-665,3500-3624`
- Modify after valid RED: `src/web/app.js:4618-4753`
- Production server/API files: none expected

**Interfaces:**

- Consumes: unchanged `POST /api/nas-dry-run` pass-through and V2 plan from Task 1.
- Produces: fail-closed DOM text that separates adapter availability, configuration readiness, pending runtime mount verification, and execution authorization.

Pre-TDD source confirmation: current `src/server.js` calls `buildNasDryRunPlan(body)` and sends the returned plan unchanged. Keep server/API production files out of scope unless the passthrough test disproves that contract.

- [ ] **Step 1: Update API passthrough assertions to V2**

Give the enabled API test target a valid enabled mountedShare. Keep the second target disabled. Assert:

```js
assert.strictEqual(body.schemaVersion, 2);
assert.strictEqual(body.executionGate.adapterAvailable, true);
assert.strictEqual(body.executionGate.executionAuthorized, false);
assert.strictEqual(body.executionGate.remoteExecutionAllowed, false);
assert.strictEqual(body.targets[0].executionReadiness.state, 'ready');
assert.deepStrictEqual(body.targets[0].executionReadiness.blockers, []);
assert.strictEqual(body.targets[1].executionReadiness.state, 'blocked');
assert.deepStrictEqual(body.targets[1].executionReadiness.blockers, ['target-disabled']);
assert.strictEqual(body.readinessSummary.configurationReadyTargets, 1);
assert.strictEqual(body.readinessSummary.runtimeVerificationPendingTargets, 1);
assert.strictEqual(body.readinessSummary.blockedTargets, 1);
assert.deepStrictEqual(body.readinessSummary.blockers, ['target-disabled']);
```

Also assert serialized API output omits the two mountedShare paths.

- [ ] **Step 2: Add failing V2 DOM and legacy fail-closed tests**

Build a V2 mock response with three targets in this order: ready mountedShare, enabled legacy-missing, disabled. Expected summary blockers are `mounted-share-missing, target-disabled`.

Assert rendered text contains:

```text
mounted SMB adapter：已实现
dry-run 执行授权：未授权
NAS 配置就绪性摘要
配置就绪状态: ready
运行时挂载检查：将在真实执行前完成
配置就绪状态: blocked
卡点: mounted-share-missing
卡点: target-disabled
```

Assert it does not contain raw credentialRef, mountPath, relativeRoot, or “真实 NAS transport 未实现”.

Add a legacy-schema response with only `remoteExecutionAllowed:false` and the old blockingReason. Assert the UI still renders execution as “未授权”; missing `executionAuthorized` must never produce “已授权”.

- [ ] **Step 3: Run Task 3 RED**

Run:

```bash
node --test --test-name-pattern="NAS dry-run|nas-dry-run|NAS execution readiness" test/web-console.test.js
```

Expected: FAIL because current renderer says “远程执行：已阻止”, “NAS 执行就绪性摘要”, and lacks V2/pending wording.

- [ ] **Step 4: Implement fail-closed V2 gate rendering**

In `renderNasDryRunPlan(plan)`, derive booleans only by exact equality:

```js
const gate = plan.executionGate && typeof plan.executionGate === 'object'
  ? plan.executionGate
  : {};
const adapterAvailable = gate.adapterAvailable === true;
const executionAuthorized = gate.executionAuthorized === true;
```

Render adapter status as implemented only for exact `true`; render authorization as authorized only for exact `true`. For missing/legacy fields, render “未确认” for adapter and “未授权” for authorization. Do not infer authorization from `readinessSummary.state` or `remoteExecutionAllowed`.

- [ ] **Step 5: Implement configuration summary and target wording**

Change the title to `NAS 配置就绪性摘要`. Add mountedShare/configuration/runtime counts while preserving legacy credential counts. Change target prefix from `执行就绪状态` to `配置就绪状态`. Only when `runtimeVerificationRequired === true` append a separate line with `运行时挂载检查：将在真实执行前完成`.

Do not render `requiredGates` values or mountedShare path fields.

- [ ] **Step 6: Run Task 3 GREEN and API regressions**

Run:

```bash
node --test --test-name-pattern="NAS dry-run|nas-dry-run|NAS execution readiness" test/web-console.test.js
node --test test/web-console.test.js test/nas-dry-run.test.js test/agent-nas-dry-run.test.js
git diff --check -- src/web/app.js test/web-console.test.js
```

Expected: all pass; no `src/server.js` or `src/agent.js` change.

- [ ] **Step 7: Review and stop at Task 3 commit gate**

Proposed commit after explicit approval:

```bash
git add src/web/app.js test/web-console.test.js
git commit -m "feat: render NAS configuration readiness safely"
```

---

### Task 4: V1.45 Version, Gold Evidence, and Honest Documentation

**Files:**

- Modify tests first: `test/gold-readiness.test.js:158-173,337-455,704-725,2055-2117`
- Modify tests first: `test/agent-gold-readiness.test.js:61-146`
- Modify tests first: `test/version.test.js:10-48,110-210`
- Modify tests first: `test/readme.test.js:1959-2075,2280-2355`
- Modify after valid RED: `src/gold-readiness.js:57-80`
- Modify after valid RED: `src/version.js:1`
- Modify after valid RED: `README.md:1-12` and current NAS/Gold documentation sections only

**Interfaces:**

- Consumes: passing Tasks 1–3 and committed V1.44 receipt paths/ID/runtime commit.
- Produces: `LINKE_RELEASE_VERSION === 'V1.45'`, static Gold `6/3/0/9`, `nas-dry-run=ready`, three remaining partial items, and current V1.45 README surface.
- Preserves: V1.44 receipt, acceptance ID, exact source commit, and V1.44 historical row.

- [ ] **Step 0: Freeze the committed V1.44 evidence atoms**

Run and record hashes before any Task 4 edit:

```bash
git hash-object docs/superpowers/reports/2026-07-27-v144-real-nas-acceptance.json
git hash-object docs/superpowers/reports/2026-07-27-v144-real-nas-acceptance.md
git hash-object test/real-nas-acceptance-evidence.test.js
```

Re-run the same commands at Task 4 GREEN and final verification; all three hashes must remain identical.

- [ ] **Step 1: Write version and Gold RED assertions**

Change current expectations to:

```js
assert.strictEqual(LINKE_RELEASE_VERSION, 'V1.45');
assert.deepStrictEqual(report.summary, { ready: 6, partial: 3, blocked: 0, total: 9 });
assert.strictEqual(report.items.find((item) => item.id === 'nas-dry-run').status, 'ready');
assert.strictEqual(report.items.find((item) => item.id === 'automation-installation').status, 'partial');
assert.strictEqual(report.items.find((item) => item.id === 'security-auth').status, 'partial');
assert.strictEqual(report.items.find((item) => item.id === 'production-hardening').status, 'partial');
```

Update both Agent Gold summary assertions to `6/3/0/9` while keeping overall `partial` and exit `0` for zero blocked items.

- [ ] **Step 2: Write conjunctive evidence RED assertions**

For the `nas-dry-run` item, require exact evidence entries for:

```text
schemaVersion:2
adapterAvailable:true
executionAuthorized:false
wouldConnect:false
wouldWrite:false
configuredEndpointSentinelConnections:0
test/nas-dry-run.test.js
test/agent-nas-dry-run.test.js
test/web-console.test.js
docs/superpowers/reports/2026-07-27-v144-real-nas-acceptance.json
docs/superpowers/reports/2026-07-27-v144-real-nas-acceptance.md
NAS-REAL-V144-20260727-01
```

`configuredEndpointSentinelConnections:0` is a static Gold evidence atom backed by the real-process sentinel test and the final repeated drill; `src/gold-readiness.js` does not dynamically import runtime test output.

Require `nextStep` to say configuration-only ready, runtime mount verification remains execution-time, three partial items remain, and not Gold. Do not remove the separate `real-nas-remote-backup` evidence assertions.

- [ ] **Step 3: Write current-surface README/version RED assertions**

Introduce exact current signature:

```js
const V145_SIGNATURE = 'V1.45 NAS dry-run configuration-readiness PASS';
```

Require the README badge and V1.45 current row to exact-include:

```text
V1.45 NAS dry-run configuration-readiness PASS
nas-dry-run ready
real-nas-remote-backup ready
configuration-only ready
runtime mount verification pending
executionAuthorized:false
wouldConnect:false
wouldWrite:false
Gold remains partial 6/3/0/9
three partial items remain
not Gold
```

Require a V1.44 historical row that retains `V1.44 real NAS acceptance PASS`, `NAS-REAL-V144-20260727-01`, both report paths, and `Gold remains partial 5/4/0/9`. Historical V0.x assertions remain historical and must not be globally rewritten.

- [ ] **Step 4: Run Task 4 RED**

Run:

```bash
node --test test/gold-readiness.test.js test/agent-gold-readiness.test.js test/version.test.js test/readme.test.js
```

Expected: FAIL only because current version is V1.44, nas-dry-run is partial, summary is `5/4/0/9`, and current README surface lacks V1.45 phrases.

- [ ] **Step 5: Implement static Gold promotion**

In `src/gold-readiness.js`, change only the `nas-dry-run` item:

```js
status: 'ready',
evidence: [
  'schemaVersion:2',
  'adapterAvailable:true',
  'executionAuthorized:false',
  'wouldConnect:false',
  'wouldWrite:false',
  'configuredEndpointSentinelConnections:0',
  'test/nas-dry-run.test.js',
  'test/agent-nas-dry-run.test.js',
  'test/web-console.test.js',
  'docs/superpowers/reports/2026-07-27-v144-real-nas-acceptance.json',
  'docs/superpowers/reports/2026-07-27-v144-real-nas-acceptance.md',
  'NAS-REAL-V144-20260727-01',
  'src/agent.js nas-dry-run --readiness-summary',
  'src/agent.js nas-dry-run --fail-on-blocked',
  'src/config.js FORBIDDEN_NAS_CREDENTIAL_FIELDS 15 exact keys',
],
```

Retain any existing concrete evidence that current tests still require. Replace the stale V0.69 nextStep with one V1.45 sentence containing the exact boundaries from Step 2.

- [ ] **Step 6: Advance version and current README surface**

Set:

```js
export const LINKE_RELEASE_VERSION = 'V1.45';
```

Update README title, badge, current row, NAS dry-run section, Gold summary, and test-coverage sentence. Insert V1.44 immediately below as historical. Do not alter the committed V1.44 JSON/Markdown receipt or its exact runtime commit.

- [ ] **Step 7: Run Task 4 GREEN and version/Gold regressions**

Run:

```bash
node --test test/gold-readiness.test.js test/agent-gold-readiness.test.js test/version.test.js test/readme.test.js
node --test test/health.test.js test/agent-health.test.js test/web-console.test.js
git diff --check -- src/gold-readiness.js src/version.js README.md test/gold-readiness.test.js test/agent-gold-readiness.test.js test/version.test.js test/readme.test.js
```

Expected: all pass; Gold remains overall partial, not Gold/GA.

- [ ] **Step 8: Review and stop at Task 4 commit gate**

Proposed commit after explicit approval:

```bash
git add src/gold-readiness.js src/version.js README.md test/gold-readiness.test.js test/agent-gold-readiness.test.js test/version.test.js test/readme.test.js
git commit -m "feat: publish V1.45 NAS dry-run readiness"
```

---

### Task 5: Independent Statistics, Review, Closure, and Codex Verification

**Files:**

- Repository changes: none expected
- Temporary evidence prompts: `/private/tmp/pm-dcw-v145-*` only, containing no credentials

**Interfaces:**

- Consumes: complete allowed-file diff, test outputs, Git state, V1.44 receipt metadata, and Gold summary.
- Produces: Qwen statistics, fresh Kimi reviewer verdict, independent fresh Kimi closure verdict, and Codex final evidence-backed decision.

- [ ] **Step 1: Run the full verification stack**

Run:

```bash
node --test test/nas-dry-run.test.js test/agent-nas-dry-run.test.js test/web-console.test.js test/gold-readiness.test.js test/agent-gold-readiness.test.js test/version.test.js test/readme.test.js
npm test
git diff --check
git status --short --untracked-files=all -- . ':(exclude)package-lock.json'
git diff --name-only -- . ':(exclude)package-lock.json'
git rev-parse HEAD
git rev-parse @{upstream}
```

Expected: focused and full suites pass; the explicitly excluded Git scope contains only the intended files. Separately record that `package-lock.json` is known unrelated untracked state; do not remove, clean, read, hash, stage, or otherwise touch it.

- [ ] **Step 2: Re-run the highest-risk fail-safe process drill**

Run the Task 2 real Agent subprocess with a local TCP sentinel and missing mount path. Capture structured evidence:

```text
readinessState: ready
executionAuthorized: false
wouldConnect: false
wouldWrite: false
runtimeVerificationRequired: true
sentinelConnections: 0
mountPathCreated: false
exitCode: 0
```

This is the required runtime-resilience failure-path drill. It must not call `nas-snapshot-replicate` or write to NAS.

- [ ] **Step 3: Run Qwen statistics**

Use a fresh Qwen CLI call with `effort=N/A:no-supported-control`. Supply only sanitized command outputs/diff stats. Require counts for tests, files, lines, Gold items, blockers, remaining partial items, and unexpected files. Qwen must not decide PASS/Gold.

- [ ] **Step 4: Run fresh Kimi reviewer**

Use the Kimi DashScope helper with a new UTF-8 prompt containing the complete spec-relevant diff or a controlled, hashed evidence package; timeout `600–900` seconds. Required output:

```text
角色：reviewer
状态：DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED
交接对象：PM
抗辩：
改动文件：
运行命令：N/A:read-only helper
验证结果：
未验证内容：
风险：
```

Any schema error, missing evidence, safety filter, or contradictory claim is HOLD.

- [ ] **Step 5: Resolve reviewer findings through the original implementer**

For every finding, Codex records `accepted/rejected` with local evidence. Accepted implementation findings return to Grok with the complete finding list and the same exact file boundary. Re-run affected RED/GREEN/regressions. Maximum two repair rounds; identical state signature twice escalates to the user.

- [ ] **Step 6: Run independent fresh Kimi closure review**

Use a new Kimi helper session, not the reviewer session. Required closure schema:

```text
VERDICT: PASS|BLOCKED|NEEDS_CONTEXT
P0:
P1:
P2:
EVIDENCE_CHECKED:
UNVERIFIED_GAPS:
GOLD_IMPACT:
CLOSURE_READY: YES|NO
```

Kimi PASS is advisory only and cannot replace Codex verification.

- [ ] **Step 7: Codex final truth and boundary audit**

Codex independently confirms:

- valid RED was observed before each production change;
- focused GREEN and full `npm test` passed;
- sentinel connections remained zero;
- runtime authorization remained false even when configuration ready;
- V1.44 receipt stayed byte-for-byte unchanged;
- `nas-dry-run=ready`, overall `partial`, summary `6/3/0/9`;
- exactly three partial items remain;
- no Gold/GA/production-ready claim;
- no tracked file outside the approved list changed;
- `package-lock.json` remained untouched and unstaged.

- [ ] **Step 8: Stop at final commit/push gates**

If Tasks 1–4 used separate approved commits, present their hashes and do not squash without approval. If any implementation remains uncommitted, present the exact staged file list and proposed conventional commit. Push requires a new, separate explicit user approval after all commits exist.

## GLM Plan-Adversary Adjudication

Accepted and incorporated:

- bind the ready configuration endpoint to the exact TCP sentinel and prove zero connections;
- add invalid provider, path, and schema CLI cases with exit `1` and sanitized output;
- repeat sensitive-field absence checks at the real CLI boundary;
- classify Task 2 explicitly as post-RED Gold evidence/regression and stop on any failure;
- cross-link `configuredEndpointSentinelConnections:0` into static Gold evidence;
- exclude `package-lock.json` from verification pathspecs while leaving it untouched;
- assert obsolete credential/remote blockers are absent and blocked targets do not require runtime verification.

Rejected with plan-text evidence:

- "executionGate mapping is missing": Task 1 Steps 2, 5, and 8 already specify the exact immutable object, constants, and projection;
- "blocker branches or order are missing": Task 1 Steps 2 and 3 enumerate every branch and stable first-seen ordering;
- "remaining partial items are unnamed": Task 4 Step 1 names `automation-installation`, `security-auth`, and `production-hardening` exactly;
- "Agent exit mapping is unverified": the recorded baseline passed and Task 2 exercises exits `0`, `1`, and `2`; `src/agent.js` remains outside production scope unless those tests disprove the existing mapping.

The final corrected GLM review used the exact V2 `executionGate` contract and returned `VERDICT: APPROVE`, no P0/P1, and `READY_FOR_TDD: YES`. Its advisory P2 items were resolved by clarifying kebab-case blocker identifiers, recording the verified Agent/API passthrough contracts, and explaining the static sentinel evidence atom; no implementation scope changed.

## Completion Definition

The V1.45 slice is complete only when:

- all five tasks pass without HOLD findings;
- actual Agent CLI configuration-ready flow exits `0` and makes zero sentinel connections;
- blocked and invalid flows exit `2` and `1` respectively;
- execution authorization remains false everywhere in dry-run;
- Web/API do not imply runtime mount verification or execution permission;
- V1.44 receipt remains unchanged and is cited as a separate adapter proof domain;
- Gold is exactly `6 ready / 3 partial / 0 blocked / 9 total`, overall `partial`;
- commit and push approvals remain separate, and no push has occurred without approval.
