# V1.14 Supervisor Lifecycle Guarded Runner Execution Gate CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Agent CLI command that composes persisted approval readiness, manifest readiness, guarded runner readiness, execution preview, and V1.13 execution gate into a sanitized blocked JSON report.

**Architecture:** Extend `src/agent.js` only for the CLI surface and reuse existing supervisor lifecycle pure functions. The command reads local input files and approval records but performs no writes, host mutation, API/Web changes, launchctl calls, process reads, NAS calls, backup/restore actions, or remote commands.

**Tech Stack:** Node.js ESM, `node:test`, existing Linke supervisor lifecycle helpers.

## Global Constraints

- Current milestone after implementation must be `V1.14`.
- Gold readiness must remain `blocked`.
- New command name must be exactly `supervisor-lifecycle-guarded-runner-execution-gate`.
- Required args are `--config`, `--operation`, `--data-dir`, `--manifest`, and `--runner-binding`.
- Optional boolean args are `--execute-requested` and `--fail-on-blocked`; neither accepts a value.
- Reject `--apply`, `--approval`, and `--output`.
- The command must not call `executeSupervisorLifecycleApply`, launchctl, shell, process listing, NAS, backup, restore, remote command, metadata writes, audit writes, or approval writes.
- Error output must not leak paths, approval identity/reason, sourcePath, serverUrl, token, secret, Authorization, hashes, raw manifest JSON, raw runner binding JSON, or Node internal filesystem/parser errors.
- `--fail-on-blocked` must print JSON first, then exit 2 when the gate state is blocked.

---

### Task 1: Agent CLI Gate Command

**Files:**
- Modify: `src/agent.js`
- Test: `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js`

**Interfaces:**
- Consumes:
  - `buildSupervisorLifecycleApplyPlan(config, options)`
  - `buildSupervisorLifecycleApplyReadiness(plan, approvalRecords)`
  - `validateSupervisorLifecycleExecutorManifest(plan, manifest)`
  - `buildSupervisorLifecycleGuardedRunnerReadiness(manifestReadiness, runnerBinding)`
  - `buildSupervisorLifecycleGuardedRunnerExecutionPreview(plan, guardedRunnerReadiness)`
  - `buildSupervisorLifecycleGuardedRunnerExecutionGate(plan, applyReadiness, manifestReadiness, guardedRunnerReadiness, executionPreview, options)`
  - `readSupervisorLifecycleApprovalRecords(dataDir)`
- Produces:
  - CLI command `supervisor-lifecycle-guarded-runner-execution-gate`
  - Sanitized JSON output matching the V1.13 pure gate object

- [ ] **Step 1: Add RED CLI tests**

Create `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js` by adapting helper patterns from `test/agent-supervisor-lifecycle-apply-readiness.test.js` and `test/agent-supervisor-lifecycle-guarded-runner-execution-preview.test.js`.

Required test cases:

1. Valid config + persisted approval record + manifest + runner binding, without `--execute-requested`:
   - output command is `supervisor-lifecycle-guarded-runner-execution-gate`
   - `state:'blocked'`
   - `executionEligible:false`
   - `wouldExecute:false`
   - blockers include `execute-request-missing`
   - blockers include `real-guarded-runner-execution-wiring-missing`
   - `actionCandidates.length === 3`
   - every candidate has `wouldExecute:false`, `wouldRun:false`, `wouldWrite:false`
   - `safety.readOnly === true`
   - `safety.lifecycleApplied === false`
   - no `store/approvals` writes beyond the approval record created by the existing persist command used as fixture setup
   - stdout does not leak config path, data dir, manifest path, runner binding path, approval path, source path, `localhost`, `Documents`, approval identity/reason, token, secret, or `/Users/ah`

2. Same inputs with `--execute-requested`:
   - blockers do not include `execute-request-missing`
   - blockers remain exactly or effectively blocked by `real-guarded-runner-execution-wiring-missing`
   - `gates.executeRequested === true`
   - still no execution flags turn true

3. `--fail-on-blocked`:
   - exits 2
   - prints parseable JSON to stdout before exiting

4. Unsupported args:
   - `--apply`
   - `--approval <path>`
   - `--output <path>`
   - `--execute-requested yes`
   - `--fail-on-blocked yes`
   All return exit 1 with sanitized errors.

5. Error sanitization:
   - invalid config JSON or config schema
   - invalid approval store path
   - invalid manifest JSON
   - invalid runner binding JSON
   Each returns the fixed error message from the spec and no raw path or secret.

6. Help output:
   - mentions command name
   - mentions `--data-dir <path>`
   - mentions `--manifest <path>`
   - mentions `--runner-binding <path>`
   - mentions `--execute-requested`
   - mentions `--fail-on-blocked`

Run:

```bash
node --test --test-reporter=spec test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

Expected before implementation: FAIL because the command is unknown.

- [ ] **Step 2: Import the gate builder**

In `src/agent.js`, add `buildSupervisorLifecycleGuardedRunnerExecutionGate` to the existing supervisor lifecycle import list.

- [ ] **Step 3: Add sanitized error constants**

Near the existing guarded runner execution preview constants, add:

```js
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_GATE_CONFIG_ERROR = 'supervisor-lifecycle-guarded-runner-execution-gate failed; verify --config points to a readable valid Linke config';
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_GATE_MANIFEST_ERROR = 'supervisor-lifecycle-guarded-runner-execution-gate failed; verify --manifest points to a readable valid executor manifest JSON';
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_GATE_BINDING_ERROR = 'supervisor-lifecycle-guarded-runner-execution-gate failed; verify --runner-binding points to a readable valid guarded runner binding JSON';
const SUPERVISOR_LIFECYCLE_GUARDED_RUNNER_EXECUTION_GATE_VALIDATION_ERROR = 'supervisor-lifecycle-guarded-runner-execution-gate failed; execution gate validation did not complete';
```

- [ ] **Step 4: Update help text**

Add the command to both CLI comments and `printUsage()` command list.

Extend option descriptions:

- `--config` includes the new command.
- `--operation` includes the new command.
- `--manifest` includes the new command.
- `--runner-binding` includes the new command.
- `--data-dir` includes the new command.
- Add `--execute-requested  Record explicit execution intent for the guarded runner execution gate without executing`.

- [ ] **Step 5: Implement the command**

Add a `case 'supervisor-lifecycle-guarded-runner-execution-gate':` next to execution preview.

Validation:

```js
if (!args.config) throw new Error('--config is required');
if (args.config === true) throw new Error('--config requires a path value');
if (!args.operation) throw new Error('--operation is required');
if (args.operation === true) throw new Error('--operation requires a value');
const validOperations = new Set(['install', 'uninstall', 'rollback', 'recover']);
if (!validOperations.has(args.operation)) throw new Error('operation must be one of: install, uninstall, rollback, recover');
if (!args['data-dir']) throw new Error('--data-dir is required');
if (args['data-dir'] === true) throw new Error('--data-dir requires a path value');
if (!args.manifest) throw new Error('--manifest is required');
if (args.manifest === true) throw new Error('--manifest requires a path value');
if (!args['runner-binding']) throw new Error('--runner-binding is required');
if (args['runner-binding'] === true) throw new Error('--runner-binding requires a path value');
if (args.apply !== undefined) throw new Error('--apply is not supported');
if (args.approval !== undefined) throw new Error('--approval is not supported');
if (args.output !== undefined) throw new Error('--output is not supported');
if (args['execute-requested'] !== undefined && args['execute-requested'] !== true) throw new Error('--execute-requested does not accept a value');
if (args['fail-on-blocked'] !== undefined && args['fail-on-blocked'] !== true) throw new Error('--fail-on-blocked does not accept a value');
```

Then read inputs with fixed error wrappers and build the report through the data flow defined in the spec. Print JSON and set `process.exitCode = 2` only after printing when `args['fail-on-blocked'] === true && gate.state === 'blocked'`.

- [ ] **Step 6: Run focused CLI test**

Run:

```bash
node --test --test-reporter=spec test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

Expected: PASS.

### Task 2: Version, Gold, README, and Regression Tests

**Files:**
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `README.md`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js`

**Interfaces:**
- Consumes: V1.14 CLI command and test evidence from Task 1.
- Produces: Current release docs and Gold readiness evidence synced to `LINKE_RELEASE_VERSION === 'V1.14'`.

- [ ] **Step 1: Update version constant and tests**

Set:

```js
export const LINKE_RELEASE_VERSION = 'V1.14';
```

Update `test/version.test.js` and `test/gold-readiness.test.js` expectations from `V1.13` to `V1.14`.

- [ ] **Step 2: Update Gold readiness evidence**

In `src/gold-readiness.js`, add V1.14 evidence to the automation/installation item and any existing partial-hardening item that tracks this evidence:

- `src/agent.js supervisor-lifecycle-guarded-runner-execution-gate`
- `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js`
- `--data-dir <path>`
- `--execute-requested`
- `--fail-on-blocked`
- `executionEligible:false`
- `execute-request-missing`
- `realRunnerWiringReady:false`
- `real-guarded-runner-execution-wiring-missing`

Update `nextStep` text so V1.14 is described as read-only Agent CLI composition evidence, while V1.13 remains pure gate evidence. Keep Gold blocked and keep wording that real guarded lifecycle apply execution wiring is missing.

- [ ] **Step 3: Update README**

Update:

- Title to `# Linke V1.14`.
- Current badge to `**当前版本：V1.14**`.
- Intro paragraph to describe the new read-only CLI gate command and its no-execution boundary.
- Version table:
  - new V1.14 current row
  - V1.13 becomes historical
- Gold readiness sections:
  - V1.14 Agent CLI gate evidence
  - V1.13 pure gate evidence remains historical
  - V1.12/V1.11/V1.10/V1.09 evidence remains historical
  - Gold remains blocked.

- [ ] **Step 4: Update README and Gold tests**

Add/adjust assertions in:

- `test/readme.test.js`
- `test/gold-readiness.test.js`

They must require V1.14 evidence and ensure V1.13 is no longer current.

- [ ] **Step 5: Run focused docs/version tests**

Run:

```bash
node --test --test-reporter=spec test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

Expected: PASS.

### Task 3: Final Verification and Review Handoff

**Files:**
- No additional code files expected.

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: verified branch candidate for Qwen review, DeepSeek closure, commit, and push.

- [ ] **Step 1: Static checks**

Run:

```bash
node --check src/agent.js
git diff --check
```

Expected: both exit 0.

- [ ] **Step 2: Focused tests**

Run:

```bash
node --test --test-reporter=spec test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js
node --test --test-reporter=spec test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

Expected: all tests pass.

- [ ] **Step 3: Full suite**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Review and closure**

Run Qwen as read-only reviewer over the V1.14 diff with a strict final schema. Run DeepSeek as final closure verifier with strict JSON. Codex PM must independently verify command outputs, diff, and safety claims before commit.

- [ ] **Step 5: Commit and push**

Commit message:

```bash
git commit -m "feat: add guarded runner execution gate cli"
```

Push `linke-v0.12-web-panel` to origin and verify local HEAD equals remote HEAD.
