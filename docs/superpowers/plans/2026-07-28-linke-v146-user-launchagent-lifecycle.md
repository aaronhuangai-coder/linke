# Linke V1.46 User LaunchAgent Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Every implementation task follows test-first RED → minimal GREEN → focused regression → independent review → Codex verification. The Codex host remains PM/orchestrator/verifier; implementation uses the configured pm-dcw workers, not collaboration subagents.
>
> **For fresh plan reviewers:** Review this document only; do not implement or edit. Return `verdict`, `P0`, `P1`, `P2`, `planReady`, and exact section/line evidence. Any conflict with the frozen constraints, untestable step, invalid RED, unsafe real-host path, schema/type mismatch, or Gold overclaim is a finding.

**Goal:** Deliver a V1.46 implementation candidate for a crash-recoverable, current-user, dual-LaunchAgent lifecycle covering install, managed upgrade, stop, rollback, uninstall, and recover while keeping all real `launchctl` execution and real `~/Library/LaunchAgents` mutation fail-closed.

**Architecture:** New focused modules under `src/launchagent-lifecycle/` separate closed schemas, profile rendering/runtime binding, durable metadata, host boundaries, transaction coordination, and the two-stage acceptance gate. The coordinator can run only with injected test adapters during this code stage. The production atomic publisher remains an explicit `conditional-mutation-unsupported` sentinel, the production launchctl runner is not constructible from the safe public entry, and no existing Agent/API/Web execution surface is widened.

**Tech Stack:** Node.js ESM, built-in `node:test` / `node:assert` / `node:crypto` / `node:fs/promises` / `node:child_process`, macOS `/usr/bin/plutil` for plist lint, no new npm dependency.

## Global Constraints

1. Authoritative design: `docs/superpowers/specs/2026-07-28-linke-v146-user-launchagent-lifecycle-design.md` at commit `f0577be2eac9282b131dde52854a6f10a12a2cea`, SHA-256 `75cdb0f0ec093e516ded9abce7df7ef02a919c8bc17d51e56c16126f25c050d0`.
2. Implementation baseline: local HEAD and upstream both `f0577be2eac9282b131dde52854a6f10a12a2cea`. Recheck before each task; do not rely on this recorded snapshot if Git has moved.
3. Never read, hash, modify, stage, or commit the existing untracked `package-lock.json`. `package.json` stays at package version `0.1.0` and receives no dependency or script change.
4. Never read `.env*`, `secrets/`, `credentials/`, SSH/cloud/auth/identity directories, API keys, tokens, or passwords. No credential belongs in plist, argv, journal, anchor, receipt, test output, or documentation.
5. Code-stage tests use fresh temporary roots and fake/disabled launchctl only. They must not read or write the real user `~/Library/LaunchAgents`, call `/bin/launchctl`, install a LaunchAgent, alter launchd, deploy, send mail, connect to NAS, or mutate production state.
6. Preserve `src/agent.js:692-768` legacy single-scheduler `generateLaunchdPlist` / `writeLaunchdDryRun` section and its project-root-only write gate. Preserve `supervisor-install-dry-run` with every `would*` and launchctl/filesystem safety flag false.
7. Do not modify `src/supervisor-lifecycle.js`; V1.46 uses new focused modules and must not flip its five global execution facts.
8. Fixed V1.46 labels are `com.linke.controller` and `com.linke.scheduler`; fixed filenames are the matching labels plus `.plist`. No caller-selected label or filename reaches host adapters.
9. V1.46 schedule bounds are frozen at integer `60..86400` seconds. This applies only to the new lifecycle renderer; it does not silently change the legacy dry-run validator.
10. Runtime binding is to one canonical immutable installation root and exactly three artifacts: host Node executable, `src/controller-runtime.js`, and `src/agent.js`. Bind before render; revalidate after render, before manifest publication, before every bootstrap, and before commit.
11. LaunchAgents and active-manifest mutation can occur only through `publishAbsent`, `replaceIfMatch`, and `removeIfMatch`. No coordinator or metadata-store method may expose raw `rename`, `unlink`, general write paths, or caller-selected basenames.
12. Node alone does not satisfy the design's race-safe compare-and-mutate contract for an existing path. Therefore the production real atomic publisher in this candidate must fail closed with `conditional-mutation-unsupported`; test publishers prove coordinator contracts only and are not real-host evidence.
13. The production/default launchctl surface is hard-disabled. Safe library exports cannot construct a real runner. No Agent/API/Web CLI route is added in this plan.
13a. Fixed-argv `execFile`-style `/usr/bin/plutil -lint` against a temp-root candidate is allowed and required. Shell execution, command strings, concatenated argv, caller-selected executables/subcommands, and any real `/bin/launchctl` spawn are forbidden; launchctl tests use synthetic fixtures and a subprocess spy.
14. `launchctl print` raw output is parsed in memory, projected to closed fields, hashed as `jobIdentitySha256`, then discarded. It may not enter a journal, anchor, receipt, log, fixture snapshot, or thrown message.
15. Any nonterminal journal, MIR journal, or mir-lock is a blocker even when the ordinary lock is absent. Normal operations never overwrite it or reinterpret it as first install.
16. Terminal journal and receipt are written and revalidated before conditionally releasing the transaction lock. MIR handoff is journal → durable mir-lock → verify mir-lock → conditionally release transaction lock.
17. Code-stage release truth remains `automation-installation=partial`, `security-auth=partial`, `production-hardening=partial`, Gold `6 ready / 3 partial / 0 blocked / total 9`, not Gold, not GA.
18. The following remain literal false invariants: `realCapabilityImplementationsReady`, `realRunnerWiringReady`, `runnerWiringContractReady`, `executeCapabilityAuthorized`, `executionEligible`.
19. A syntax/import/fixture failure is not a valid RED. A timeout, empty helper result, schema failure, safety filter, unexpected tracked diff, missing allowed-file diff, or conflicting review is HOLD.
20. `git commit` and `git push` are separate human gates. Each suggested commit step stops and asks for explicit approval; no task pushes automatically.
21. For a brand-new target module, RED tests first assert file existence with `existsSync(fileURLToPath(new URL(...)))` and stop before dynamic import. The intended RED is that exact missing-feature assertion; `ERR_MODULE_NOT_FOUND`, syntax errors, and unrelated import errors are invalid.
22. The current-uid account resolver derives two canonical roots in memory: `<directory-service-home>/Library/LaunchAgents` and `<directory-service-home>/Library/Application Support/Linke/launchagent-lifecycle`. The active manifest target is fixed to metadata root ID plus basename `active-manifest.json`; even though it is under the metadata parent, it is changed only through the atomic publisher, never a generic metadata write.
23. This candidate performs no automatic anchor, receipt, journal, or confirmation cleanup. Last-green and rollback lineage remain durable; retention/garbage collection needs a later design.
24. After a target module exists, a valid behavior RED must fail on an explicit target-behavior assertion or an explicitly asserted missing target export. A raw `TypeError`, harness exception, syntax/import/fixture failure, or unrelated missing export is invalid.
25. The canonical immutable runtime root and writable mode-0700 metadata root are always distinct roots with distinct root IDs. “Immutable” applies to Node/controller/agent runtime artifacts, never to journal/lock/receipt storage.
26. `transaction-journal.json` is append-only JSON Lines, keyed by transaction ID and sequence, not a replaceable single record. Every entry has exact schema, previous-entry hash, entry hash, operation, state, UTC, and closed state payload. The latest entry per transaction defines that transaction state; any latest nonterminal entry, MIR entry, or mir-lock blocks every ordinary operation. A post-lock attempt that discovers a foreign nonterminal appends its own terminal blocked entry/receipt referencing the foreign entry hash and never alters the foreign chain.
27. Lock owner records PID, random nonce, and explicit availability/value fields for boot-session and process-start identity. Operator-invoked orphan recovery requires both identity values to be available and equal current observations; unavailable values/facts fail closed as still occupied. PID reuse or unavailable liveness facts may cause an availability block but never authorize takeover. MIR/manual-repair remains the only override.

## PM-DCW Role Map

| Role | Worker | Effort | Boundary |
| --- | --- | --- | --- |
| hostController / orchestrator / verifier | Codex | native | Grounds the repo, validates RED/GREEN, reviews every hunk, runs tests, and owns factual verdicts |
| implementer | fresh isolated Kimi Code CLI | maximum available | Receives exact test/production allowlists; no network, secrets, deployment, real launchctl, or unrelated edits |
| statistics | Qwen CLI | supported default | Counts files/tests/diff and checks stated invariants; does not decide correctness |
| adversary / closure reviewer | fresh Kimi DashScope | `reasoning_effort=max` | Read-only adversarial review using supplied diff/test evidence; cannot claim local access |

If one helper fails, replace only that role and keep the phase HOLD until a usable result exists.

## Current Grounding

- Branch: `linke-v0.12-web-panel`, tracking `origin/linke-v0.12-web-panel`.
- Current public release: `V1.45` in `src/version.js:1`.
- Current Gold snapshot: six ready, three partial, zero blocked; `automation-installation` is partial at `src/gold-readiness.js:92`.
- Legacy launchd dry-run renderer: `src/agent.js:692-768`; it writes only inside the project root.
- Controller standalone entry: `src/controller-runtime.js:594-674`; it is the fixed controller artifact.
- Scheduler entry: `src/agent.js:1431-1437`; it remains `run-once --config <absolute path>`.
- Existing version/Gold honesty tests: `test/version.test.js`, `test/gold-readiness.test.js`, `test/agent-gold-readiness.test.js`, `test/readme.test.js`, and `test/g0c-auto-harness.test.js`.

## File and Responsibility Map

| Action | Path | Responsibility |
| --- | --- | --- |
| Create | `src/launchagent-lifecycle/contracts.js` | Closed constants, local error codes, manifest/anchor/journal/receipt validators, sanitized projections |
| Create | `src/launchagent-lifecycle/profiles.js` | Runtime binder, strict controller/scheduler descriptors, canonical plist rendering/hash |
| Create | `src/launchagent-lifecycle/metadata-store.js` | Mode 0700/0600 metadata root, candidates, anchors, journals, locks, receipts, consumed confirmations |
| Create | `src/launchagent-lifecycle/host-adapter.js` | Read-only inspection, DS account resolution, fixed plutil/launchctl validation/parser, health checks, disabled real host adapters |
| Create | `src/launchagent-lifecycle/transaction-coordinator.js` | First install, managed upgrade, stop, rollback, uninstall, recover, compensation, MIR |
| Create | `src/launchagent-lifecycle/acceptance-gate.js` | Prepare request, confirmation binding/consumption protocol, module-private capability brand, code-stage deny |
| Create | `src/launchagent-lifecycle/index.js` | Pure validators/render/prepare plus explicitly disabled production facade; no metadata writer, host inspector, injectable coordinator, runner, publisher, parser, or capability constructor |
| Create | `test/helpers/launchagent-lifecycle-harness.js` | Deterministic fake inspector/publisher/launchctl/health/clock and trace capture |
| Create | `test/helpers/launchagent-lock-contender.js` | Independent child used only for metadata-lock contention |
| Create | `test/launchagent-lifecycle-contracts.test.js` | Closed schemas and hostile input |
| Create | `test/launchagent-lifecycle-profiles.test.js` | Dual profile, runtime binding, XML/plutil, hash/path constraints |
| Create | `test/launchagent-lifecycle-metadata.test.js` | Real temp-root modes, durability, no-clobber, fixed layout |
| Create | `test/launchagent-lifecycle-host-adapter.test.js` | Read-only roots, launchctl parser/argv, hard-disable, CAS sentinel |
| Create | `test/launchagent-lifecycle-transactions.test.js` | Install/upgrade/stop/no-change/compensation traces |
| Create | `test/launchagent-lifecycle-recovery.test.js` | Rollback/uninstall/crash recover/MIR truth tables |
| Create | `test/launchagent-lifecycle-concurrency.test.js` | Two-process lock, nonterminal journal, orphan recovery rules |
| Create | `test/launchagent-lifecycle-acceptance-gate.test.js` | Prepare/confirmation/replay/private-brand/execute gating |
| Create | `test/launchagent-lifecycle-integration.test.js` | Internal fake-adapter candidate flow plus safe-default denial and legacy compatibility |
| Modify | `src/gold-readiness.js` | Add V1.46 candidate evidence while status stays partial |
| Modify | `src/version.js` | `V1.45` → `V1.46` only after candidate verification |
| Modify | `README.md` | Current V1.46 candidate row; retain V1.45 as history and not-Gold honesty |
| Modify | `test/version.test.js` | V1.46 current signature and V1.45 history |
| Modify | `test/gold-readiness.test.js` | Frozen `6/3/0/9`, automation partial, evidence and five false flags |
| Modify | `test/agent-gold-readiness.test.js` | Agent/API public report counts and non-Gold state |
| Modify | `test/readme.test.js` | V1.46 candidate wording and forbidden overclaims |
| Modify | `test/g0c-auto-harness.test.js` | Current-version honesty only; all five execution flags stay false |

**Explicitly do not modify:** `src/agent.js`, `src/controller-runtime.js`, `src/supervisor-lifecycle.js`, `src/server.js`, `src/web/**`, `src/error-codes.js`, `package.json`, `package-lock.json`, or any real acceptance report.

## Frozen Public Contracts

`contracts.js` owns this local, non-HTTP protocol, including exact schemas for manifests, tagged anchors, journal entries, operation receipts, acceptance/manual-repair prepare requests, confirmation records, durable consumed-confirmation records, and sanitized private-capability projections. It does not enlarge `ERROR_CODES`:

```js
export const LAUNCHAGENT_LIFECYCLE = Object.freeze({
  schemaVersion: 1,
  scope: 'user-launch-agent',
  labels: Object.freeze({
    controller: 'com.linke.controller',
    scheduler: 'com.linke.scheduler',
  }),
  filenames: Object.freeze({
    controller: 'com.linke.controller.plist',
    scheduler: 'com.linke.scheduler.plist',
    manifest: 'active-manifest.json',
  }),
  rootIds: Object.freeze({
    launchAgents: 'current-user-launch-agents',
    metadata: 'linke-launchagent-lifecycle-metadata',
  }),
  scheduleSeconds: Object.freeze({ min: 60, max: 86400 }),
});

export const LAUNCHAGENT_LIFECYCLE_CODES = Object.freeze({
  INVALID: 'launchagent-lifecycle-invalid',
  OWNERSHIP_MISMATCH: 'ownership-mismatch',
  LABEL_IN_USE: 'label-in-use',
  CONDITIONAL_MUTATION_UNSUPPORTED: 'conditional-mutation-unsupported',
  CONDITIONAL_MUTATION_MISMATCH: 'conditional-mutation-mismatch',
  TRANSACTION_IN_PROGRESS: 'transaction-in-progress',
  RECOVERY_REQUIRED: 'recovery-required',
  MANUAL_INTERVENTION_REQUIRED: 'manual-intervention-required',
  CONTROLLER_NOT_READY: 'controller-not-ready',
  SCHEDULER_LOAD_FAILED: 'scheduler-load-failed',
  ROLLBACK_RUNTIME_MISMATCH: 'rollback-runtime-mismatch',
  UNINSTALL_UNLOAD_INCOMPLETE: 'uninstall-unload-incomplete',
  ACCOUNT_RESOLUTION_UNAVAILABLE: 'account-resolution-unavailable',
  LAUNCHCTL_DISABLED: 'launchctl-disabled',
  ACCEPTANCE_GATE_DENIED: 'acceptance-gate-denied',
  CONFIRMATION_CONSUMED: 'confirmation-consumed',
});
```

The manifest validator accepts exactly this shape and nothing else:

```js
{
  schemaVersion: 1,
  installationId: '018f0f95-3d3a-7f01-8c6a-2a6f98765432',
  scope: 'user-launch-agent',
  sourceCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  runtimeArtifacts: {
    node: { pathId: 'host-node-executable', sha256: 'b'.repeat(64) },
    controller: { pathId: 'src/controller-runtime.js', sha256: 'c'.repeat(64) },
    agent: { pathId: 'src/agent.js', sha256: 'd'.repeat(64) },
  },
  transactionId: '018f0f95-3d3a-7f01-8c6a-2a6f98765433',
  controller: {
    label: 'com.linke.controller',
    filename: 'com.linke.controller.plist',
    plistSha256: 'e'.repeat(64),
  },
  scheduler: {
    label: 'com.linke.scheduler',
    filename: 'com.linke.scheduler.plist',
    plistSha256: 'f'.repeat(64),
  },
  activeAnchorId: '018f0f95-3d3a-7f01-8c6a-2a6f98765434',
  installedAt: '2026-07-28T00:00:00.000Z',
}
```

Core factory contracts and production boundaries are:

| Export | Input | Output / boundary |
| --- | --- | --- |
| `bindLaunchAgentRuntime` | closed installation root, host Node executable, source commit, fixed config path | immutable internal binding plus sanitized pathId/hash projection |
| `renderLaunchAgentProfiles` | validated runtime binding, closed controller environment, schedule | exact controller/scheduler descriptors, plist bytes, and hashes |
| `validateLaunchAgentManifest` | unknown input | deeply frozen exact manifest or fixed local error |
| `validateLaunchAgentAnchor` | unknown input | exact tagged anchor or fixed local error |
| `validateLaunchAgentJournal` | unknown input | operation-specific journal or fixed local error |
| `validateLaunchAgentReceipt` | unknown input | closed sanitized receipt or fixed local error |
| `validateLaunchAgentAcceptanceRequest` | unknown input | exact false-flag prepare request or fixed local error |
| `validateLaunchAgentConfirmationRecord` | unknown input | exact acceptance/manual-repair confirmation binding or fixed local error |
| `validateLaunchAgentConsumedConfirmation` | unknown input | exact durable consumed record or fixed local error |
| `validateLaunchAgentCapabilityProjection` | unknown input | sanitized exact capability projection; never the private brand |
| `createLaunchAgentMetadataStore` | one temp/code-owned metadata root | production/internal named metadata methods only; no LaunchAgents writer |
| `createLaunchAgentMetadataStoreForTest` | metadata root plus explicit fs/durability trace dependencies | internal test-only ordering seam; not re-exported by safe `index.js` |
| `createDisabledLaunchctlRunner` | no input | runner whose every invocation fails with `launchctl-disabled` |
| `createUnsupportedProductionAtomicPublisher` | no input | fixed `conditional-mutation-unsupported`; never falls back |
| `createDarwinAccountResolver` | no caller dependencies | read-only current-uid Directory Service resolution |
| `createPlistValidator` | no caller dependencies | fixed `/usr/bin/plutil -lint` argument-array validation with sanitized result |
| `parseLaunchctlPrint` | raw in-memory text plus expected identity | sanitized fields and `jobIdentitySha256`; raw discarded |
| `createLaunchAgentLifecycleCoordinator` | exact narrow dependency object | internal transaction-module export for tests/acceptance composition; not re-exported by safe `index.js` |
| `prepareLaunchAgentAcceptanceRequest` | validated uid/root/source/runtime identity | closed non-mutating request |
| `consumeAndAuthorizeNonProductionConfirmation` | prepared request, confirmation, current facts, metadata store | internal private capability only after durable no-clobber consumption; absent from safe `index.js` |
| `prepareLaunchAgentManualRepairRequest` | MIR transaction/lock/anchor/repair-declaration hashes | closed non-mutating request for a separate human gate |
| `consumeAndAuthorizeManualRepair` | prepared manual-repair request, one-time confirmation, current MIR facts, metadata store | internal private authorization brand bound to the exact MIR identity; absent from safe `index.js` |
| `createDisabledLaunchAgentLifecycleFacade` | no caller dependencies | safe-index facade that fails closed before account resolution, confirmation mint, launchctl, or host mutation |

Actual source must use complete JSDoc, closed input validation, and fixed sanitized errors; this table is not a source-code scaffold.

Every host conditional mutation uses closed address/identity vocabularies; no absolute parent is persisted. An absent target is addressed without pretending that its future inode/device already exists:

```js
{
  rootId: 'current-user-launch-agents',
  basename: 'com.linke.controller.plist',
  type: 'regular-file',
  ownerUid: 501,
}
```

A proven existing target identity extends that exact address with:

```js
{
  rootId: 'current-user-launch-agents',
  basename: 'com.linke.controller.plist',
  type: 'regular-file',
  ownerUid: 501,
  device: 'opaque-device-id',
  inode: 'opaque-inode-id',
  sha256: 'a'.repeat(64),
}
```

`publishAbsent` takes a fixed absent-target address plus an opaque candidate reference and must return a re-inspected full post identity. `replaceIfMatch` takes the exact expected full identity, target address, and candidate reference, then returns a full post identity whose device/inode transition is checked. `removeIfMatch` takes only the exact expected full identity. The production sentinel rejects all three before mutation.

## Dependency Graph

```text
Task 1 contracts + runtime binder + profiles
  -> Task 2 metadata store + locks + anchors + receipts
  -> Task 3 host inspection + launchctl parser + disabled production adapters
  -> Task 4 install + managed-upgrade + stop transaction core
  -> Task 5 rollback + uninstall + recover + compensation + MIR + concurrency
  -> Task 6 prepare/confirmation/capability boundary + safe exports
  -> Task 7 integration + V1.46 version/Gold/README honesty
  -> Task 8 full verification + statistics + fresh closure review
```

## Execution Protocol for Every Production-Changing Task

1. Codex records branch, HEAD/upstream, scoped status, and hashes of every task-protected tracked file.
2. Fresh Kimi Code CLI receives only test files and test helpers for the RED stage.
3. Codex checks the exact diff and runs the specified RED command. Only a failure caused by missing target behavior is valid.
4. Fresh isolated Kimi Code CLI receives the verified RED output plus only the minimum production-file allowlist.
5. Codex reviews every hunk, runs GREEN and relevant regressions, validates source scans, and checks protected hashes.
6. Qwen reports deterministic counts/boundaries. Fresh Kimi DashScope performs read-only adversarial closure from supplied diff/test evidence.
7. P0/P1, unexplained test failure, or contradictory evidence leaves the task HOLD.
8. When accepted, Codex may stage only the task's exact paths, runs `git diff --cached --check`, then stops for explicit commit approval. Push is never included in commit approval.

## Rollback Anchors

| Anchor | Use |
| --- | --- |
| Git `f0577be2eac9282b131dde52854a6f10a12a2cea` | Design-only implementation baseline; revert individual approved task commits rather than resetting the worktree |
| Manifest + activeAnchorId | Current managed installation identity; never inferred from label alone |
| Tagged controller/scheduler/manifest anchor entries | Byte-exact pre-state or explicit absence |
| Recorded loaded booleans | Restore explicit stopped state without accidentally starting it |
| Frozen compensation plan | Recover only the current reverse action after a crash; never nest compensation |
| Durable MIR journal + mir-lock | Prevent ordinary operations from guessing through an unprovable state |

---

### Task 1: Closed Contracts, Runtime Binder, and Dual Profiles

**Files:**

- Create: `test/launchagent-lifecycle-contracts.test.js`
- Create: `test/launchagent-lifecycle-profiles.test.js`
- Create after valid RED: `src/launchagent-lifecycle/contracts.js`
- Create after valid RED: `src/launchagent-lifecycle/profiles.js`

**Interfaces:** `validateLaunchAgentManifest`, `validateLaunchAgentAnchor`, `validateLaunchAgentJournal`, `validateLaunchAgentReceipt`, `bindLaunchAgentRuntime`, `renderLaunchAgentProfiles`.

- [ ] **Step 1: Freeze Task 1 boundaries**

Run:

```bash
git status --short --branch
git rev-parse HEAD
git rev-parse @{upstream}
git hash-object src/agent.js src/controller-runtime.js src/supervisor-lifecycle.js src/version.js src/gold-readiness.js
```

Expected: HEAD/upstream equal the current approved baseline or a later explicitly approved plan-only commit. Before this plan is committed, the only expected untracked files are this plan and unrelated `package-lock.json`; after a plan-only commit, only `package-lock.json` remains. Do not run `git hash-object` on that file.

- [ ] **Step 2: Write contract RED tests**

Add table-driven tests asserting:

- the exact manifest above passes and is deeply frozen/projected;
- unknown keys, accessors, symbols, arrays, wrong schema/scope, uppercase or short commit/hash, invalid UTC, wrong fixed label/filename, absolute path, argv, `EnvironmentVariables`, credential-like field, and command-like text fail only with `launchagent-lifecycle-invalid`; throwing Proxy traps or a Proxy shape that deviates from exact own data fields also fail closed, without claiming universal Proxy detection;
- anchor role and manifest entries are exact tagged unions: `{ priorState:'absent' }` or `{ priorState:'bytes', bytesBase64, sha256, identity }`;
- receipts allow only schema/operation/state/sourceCommit/IDs/UTC/fixed roles/hashes/booleans/counts/closed outcomes and reject free text/raw path/stdout/stderr/argv/env.
- acceptance/manual-repair prepare requests, confirmation records, durable consumed records, and capability projections each accept exact keys/types only; prepare false flags are literal false, and no serialized schema contains the module-private brand.

Use hostile getters that throw and assert the validator returns the fixed code without invoking the getter.

- [ ] **Step 3: Write profile and runtime-binding RED tests**

Create one temporary immutable installation tree with copies named exactly:

```text
src/controller-runtime.js
src/agent.js
config/linke.json
```

Bind Node separately to the actual test runtime `process.execPath`; it is the fixed host runtime artifact and is not copied beneath the installation root.

Assert the controller descriptor has exact `ProgramArguments=[node, controller]`, `RunAtLoad=true`, `KeepAlive=true`, and no `StartInterval`. Assert the scheduler has exact `ProgramArguments=[node, agent, 'run-once', '--config', config]`, `StartInterval=3600`, `RunAtLoad=false`, and no true `KeepAlive`.

Also assert:

- schedule 59 and 86401 fail; 60 and 86400 pass;
- labels and filenames are fixed and caller overrides fail;
- shell metacharacters, relative executable/script paths, another installation root, symlink artifacts, non-regular files, mismatched `pathId`, and post-bind hash drift fail before render/bootstrap;
- rendered XML escapes string content; controller plist `EnvironmentVariables` contains only the closed non-secret allowlist, while scheduler has none; neither plist contains credentials or any non-allowlisted environment entry;
- the manifest artifact hashes and plist hashes equal independently calculated SHA-256 values;
- absolute paths exist only in internal descriptor/plist bytes and are absent from the sanitized public projection.
- a scheduler exit code 0 is classified as a normal interval completion, never a controller crash or a KeepAlive restart signal.

- [ ] **Step 4: Run Task 1 RED**

Run:

```bash
node --test test/launchagent-lifecycle-contracts.test.js test/launchagent-lifecycle-profiles.test.js
```

Expected: FAIL on the two explicit module-existence assertions because the target modules do not exist. The tests must not attempt dynamic import after a failed existence assertion; `ERR_MODULE_NOT_FOUND`, syntax errors, and fixture failures invalidate RED.

- [ ] **Step 5: Implement closed validators and local codes**

Implement exact-own-enumerable-data-property readers, plain-object/accessor/symbol rejection, fail-closed handling for throwing Proxy traps or non-exact Proxy shapes, fixed regexes, deep-freeze, closed enums, and a `LaunchAgentLifecycleError` whose public `name`, `code`, and `message` do not contain input values.

Do not add lifecycle codes to `src/error-codes.js`.

- [ ] **Step 6: Implement the runtime binder**

The binder must:

1. canonicalize the installation root;
2. resolve only the three fixed path IDs plus the scheduler config path;
3. realpath `process.execPath` and verify the resolved host executable is a regular file; reject symlinks/non-regular files/root escape for controller, agent, and config artifacts inside the installation root;
4. hash the exact bytes;
5. bind the 40-character source commit;
6. return an immutable internal binding with a sanitized projection that contains only path IDs and hashes.

- [ ] **Step 7: Implement deterministic dual-profile rendering**

Use a local XML escaper and canonical element order. The renderer accepts a validated runtime binding, schedule, and a closed non-secret controller environment allowlist. The allowlist may contain only `DATA_DIR`, `PORT`, `LINKE_AGENT_HOST`, `LINKE_AGENT_PORT`, `LINKE_RESTORE_ROOT`, `LINKE_RATE_LIMIT_PER_MINUTE`, and `LINKE_AUDIT_MAX_EVENTS`; token/auth/fingerprint variables are rejected.

The profile output must include exact plist bytes and SHA-256 internally, but the public projection excludes absolute paths and environment values.

- [ ] **Step 8: Run GREEN and real plist lint**

Run:

```bash
node --test test/launchagent-lifecycle-contracts.test.js test/launchagent-lifecycle-profiles.test.js
node --test test/launchd-dry-run.test.js test/agent-run-once.test.js test/controller-runtime.test.js
```

The profile test writes both rendered plists only to its temp root and invokes `/usr/bin/plutil -lint` with an argument array. Expected: all pass; no repository file is written by the test.

- [ ] **Step 9: Review and commit gate**

Run the execution protocol. Suggested commit: `feat: add V1.46 LaunchAgent profile contracts`. Stop for explicit commit approval; do not push.

---

### Task 2: Durable Metadata, Anchors, Locks, and Receipts

**Files:**

- Create: `test/launchagent-lifecycle-metadata.test.js`
- Create after valid RED: `src/launchagent-lifecycle/metadata-store.js`
- Modify after valid RED: `src/launchagent-lifecycle/contracts.js`

**Interface:** `createLaunchAgentMetadataStore({ metadataRoot })` with named operations only.

- [ ] **Step 1: Freeze Task 2 boundaries**

Record scoped status and hashes for Task 1 source/tests plus protected legacy files. Expected: no unapproved tracked diff.

- [ ] **Step 2: Write metadata layout and mode RED tests**

The test creates a new temp root and asserts `initialize()` creates a mode `0700` metadata root. Every candidate, anchor, journal, lock, receipt, and confirmation record must be a no-follow regular file mode `0600`.

Freeze these relative layouts:

```text
candidates/<transactionId>/controller.plist
candidates/<transactionId>/scheduler.plist
candidates/<transactionId>/active-manifest.json
anchors/<anchorId>.json
receipts/<transactionId>.json
confirmations/<nonProductionConfirmationId>.json
transaction-journal.json
transaction.lock
manual-intervention.lock
```

Dynamic IDs must pass the same opaque-ID validator. No absolute path may be returned by public methods.

`manual-intervention-required` is a transaction state in the single append-only `transaction-journal.json`, not a second MIR journal file. `manual-intervention.lock` is its separate durable lock identity.

- [ ] **Step 3: Write durability and no-clobber RED tests**

Use `createLaunchAgentMetadataStoreForTest` with an explicit fs wrapper and durability-event sink. Assert:

- candidate write is file fsync followed by directory fsync before returning an opaque candidate reference;
- lock acquisition is create-exclusive/no-clobber and two concurrent acquisitions yield exactly one owner;
- consumed confirmation is no-clobber, durable, verified, and replay returns `confirmation-consumed`;
- journal state advances only from its exact expected prior state/identity and cannot skip or move backward;
- every journal append increments that transaction's sequence, binds the prior entry hash, and preserves other transactions; corrupt/truncated/hash-broken lines fail closed without truncation or repair;
- post-lock discovery of a foreign nonterminal entry appends a separate terminal blocked attempt referencing the foreign entry hash, writes its receipt, releases only the current attempt's lock, and leaves the foreign chain byte-identical for recover;
- terminal journal stores a receipt hash before receipt publication; receipt re-read/hash verification occurs before lock release;
- a different lock identity cannot release or overwrite the lock;
- MIR lock has a separate identity and cannot be released through ordinary lock methods;
- symlink, directory, mode drift, root swap, oversized JSON, corrupt JSON, and unknown schema fail closed without chmod repair.

- [ ] **Step 4: Write narrow API boundary RED tests**

Assert the store has no generic methods named `writeFile`, `rename`, `unlink`, `remove`, `replace`, or `publishPath`. Assert passing a LaunchAgents basename or an absolute path to every ID/role field fails before filesystem mutation.

- [ ] **Step 5: Run Task 2 RED**

Run:

```bash
node --test test/launchagent-lifecycle-metadata.test.js
```

Expected: FAIL on the explicit `metadata-store.js` existence assertion. `ERR_MODULE_NOT_FOUND`, import/syntax failures, or unrelated fixture errors invalidate RED.

- [ ] **Step 6: Implement the fixed metadata store**

Use `node:fs/promises` with exclusive/no-follow opens where supported, explicit `chmod` only for newly created owned files, file `sync()`, and parent-directory sync. Re-open and verify type/owner/mode/identity after every durable publication.

The store may create/stage candidates and metadata only. It must not resolve the LaunchAgents root or publish/remove an active plist/manifest. The production/internal factory accepts no fs or trace injection; the separately named test factory is imported directly only by tests and is absent from `index.js`.

- [ ] **Step 7: Implement tagged anchors and sanitized receipts**

Persist byte-exact internal plist snapshots as base64 only inside mode-0600 anchors. Receipt projection must omit anchor bytes, local paths, full argv, environment values, and raw errors. Validate every write before and after persistence.

- [ ] **Step 8: Run GREEN and related safe-file regressions**

Run:

```bash
node --test test/launchagent-lifecycle-contracts.test.js test/launchagent-lifecycle-metadata.test.js
node --test test/safe-data-files.test.js test/audit-integrity-process-lock.test.js test/restore-task-store.test.js
```

Expected: all pass; all filesystem mutations remain under test temp roots.

- [ ] **Step 9: Review and commit gate**

Suggested commit: `feat: add V1.46 lifecycle metadata store`. Stop for explicit commit approval; do not push.

---

### Task 3: Host Inspection, Account Resolution, and Fail-Closed Runner Boundaries

**Files:**

- Create: `test/launchagent-lifecycle-host-adapter.test.js`
- Create after valid RED: `src/launchagent-lifecycle/host-adapter.js`
- Modify after valid RED: `src/launchagent-lifecycle/contracts.js`

**Interfaces:** read-only host inspector, Directory Service account resolver, fixed plutil validator, launchctl request validator/parser, health checker, hard-disabled runner, unsupported production atomic publisher.

- [ ] **Step 1: Freeze Task 3 boundaries**

Record status and hashes of Task 1–2 sources plus `src/agent.js`, `src/controller-runtime.js`, and `src/supervisor-lifecycle.js`.

- [ ] **Step 2: Write read-only inspection/account RED tests**

Assert the host inspector can only canonicalize/lstat/read/hash a fixed root ID plus fixed basename. It exposes no write handle. Test symlink parents, type/uid/mode drift, root swap, prefix collision, and an attempted unknown root ID.

Test the separately exported pure Directory Service parser with fixed fixtures binding `UniqueID` to an absolute `NFSHomeDirectory`. Only this pure parser test accepts process-like `HOME` and os-homedir fixture values; the no-dependency production resolver does not. Set both fixtures to a different value and assert they are ignored. Missing, duplicate, malformed, mismatched-uid, or non-Darwin facts return only `account-resolution-unavailable`.

- [ ] **Step 3: Write launchctl request/parser RED tests**

Freeze the only valid argv arrays:

```js
['bootstrap', 'gui/501', '/resolved/LaunchAgents/com.linke.controller.plist']
['bootout', 'gui/501/com.linke.controller']
['kickstart', '-k', 'gui/501/com.linke.controller']
['print', 'gui/501/com.linke.controller']
```

Repeat for the scheduler label where applicable. Reject command strings, shell syntax, extra args, wrong uid/domain/label, nested plist path, filename mismatch, relative path, or unknown operation.

Assert each validated request carries a fixed per-operation timeout chosen by code, never caller input. Map timeout, permission denial, nonzero exit, malformed print output, and unknown result to closed outcome enums without raw stderr/stdout.

Feed a fully synthetic `launchctl print` fixture to `parseLaunchctlPrint`; its fake uid/path must not be copied from any real machine. Assert the result contains only `loaded`, optional `pid`, fixed state enum, and a 64-character `jobIdentitySha256`. Assert serialized output does not contain the raw path, argv, fixture text, username, stdout, or stderr. The fixture is parser input only; the ban on fixture snapshots applies to persisting real-run raw output or parsed raw output as evidence.

Place unique canary tokens in the synthetic path, argv, stdout, and stderr. Run the full inspect/parser/projection pipeline, then scan every temp metadata file, returned projection, receipt, journal entry, log sink, and thrown error; none may contain any canary.

- [ ] **Step 4: Write hard-disable and health RED tests**

Assert:

- `createDisabledLaunchctlRunner().run()` returns only `launchctl-disabled` and records zero subprocess calls;
- `createUnsupportedProductionAtomicPublisher()` fails construction or every mutation with `conditional-mutation-unsupported`, with zero ordinary rename/unlink calls;
- `createPlistValidator()` accepts only a fixed candidate reference resolved by its composition root, executes `/usr/bin/plutil` with `['-lint', resolvedCandidatePath]`, caps timeout/output, and returns no path or raw output;
- the health checker accepts loopback only, extracts status/boolean/count only, enforces an absolute 30-second ceiling, and discards response body/errors;
- importing the module performs no DS, filesystem, HTTP, or launchctl action.

- [ ] **Step 5: Run Task 3 RED**

Run:

```bash
node --test test/launchagent-lifecycle-host-adapter.test.js
```

Expected: FAIL on the explicit host-adapter existence assertion, with no dynamic-import or syntax error.

- [ ] **Step 6: Implement read-only adapters and parsers**

Use fixed executable constants `/usr/bin/dscl`, `/usr/bin/plutil`, and `/bin/launchctl`; allowed account/plutil calls use `execFile`-style literal argument arrays and fixed timeouts. The production account resolver accepts no caller dependency injection. Keep pure parsers separately testable. No callable real launchctl spawn path exists in this candidate.

Do not implement a callable real launchctl runner. The safe hard-disabled runner and pure request validation are sufficient for this code stage.

- [ ] **Step 7: Implement the production CAS sentinel**

Document in code that ordinary Node rename/unlink cannot meet the approved platform-level expected-identity atomicity. Return the fixed unsupported code before any candidate publication, launchctl call, or host mutation. Test source and behavior against fallback attempts.

- [ ] **Step 8: Run GREEN and static safety scans**

Run:

```bash
node --test test/launchagent-lifecycle-host-adapter.test.js test/launchagent-lifecycle-profiles.test.js
rg -n "exec\(|spawn\(|shell:[[:space:]]*true|eval\(|rename\(|unlink\(" src/launchagent-lifecycle
```

Expected: tests pass. Any scan match must be adjudicated. Same-directory atomic rename inside the private metadata root is allowed for journal/receipt durability, but the method is never exposed; coordinator/production publisher must contain no ordinary LaunchAgents or active-manifest rename/unlink fallback and no shell execution.

- [ ] **Step 9: Review and commit gate**

Suggested commit: `feat: add fail-closed V1.46 host adapters`. Stop for explicit commit approval; do not push.

---

### Task 4: First Install, Managed Upgrade, Stop, and Bounded Compensation

**Files:**

- Create: `test/helpers/launchagent-lifecycle-harness.js`
- Create: `test/launchagent-lifecycle-transactions.test.js`
- Create after valid RED: `src/launchagent-lifecycle/transaction-coordinator.js`
- Modify after valid RED: `src/launchagent-lifecycle/contracts.js`

**Interface:** `createLaunchAgentLifecycleCoordinator(dependencies)` where every dependency is an already constructed narrow adapter; the factory rejects unknown/missing methods.

- [ ] **Step 1: Freeze Task 4 boundaries**

Record status and protected hashes. Confirm the production publisher and launchctl runner still fail closed.

- [ ] **Step 2: Build a deterministic test harness**

The test helper owns only in-memory/temp-root fakes and records this closed simple-event vocabulary:

```js
[
  'inspect', 'lock-acquire', 'journal', 'anchor',
  'publish-controller', 'publish-scheduler', 'publish-manifest',
  'inspect-job-controller', 'inspect-job-scheduler',
  'verify-job-controller', 'verify-job-scheduler',
  'bootout-scheduler', 'bootout-controller',
  'bootstrap-controller', 'health-controller', 'bootstrap-scheduler',
  'verify-scheduler-outcome',
  'remove-scheduler', 'remove-controller', 'remove-manifest',
  'mir-lock-publish', 'mir-lock-verify',
  'mir-transaction-lock-release', 'mir-lock-release',
  'receipt', 'lock-release',
]
```

Compensation checkpoints use one structured trace event with exact keys and closed enums:

```js
{
  kind: 'compensation',
  action: 'restore-controller',
  phase: 'intent',
}
```

Allowed actions are `remove-controller`, `remove-scheduler`, `remove-manifest`, `restore-controller`, `restore-scheduler`, `restore-manifest`, `stop-controller`, `stop-scheduler`, `load-controller`, and `load-scheduler`; phase is only `intent` or `completed`. The harness must reject every unrecognized simple or structured event instead of silently succeeding. It never imports or invokes a production runner.

- [ ] **Step 3: Write first-install RED tests**

Assert exact operation order:

```text
pre-lock journal check
lock acquire
post-lock journal/ownership/runtime/label check
prepared journal
anchor(absent, absent, absent; loaded=false,false)
controller publish intent -> publish -> completed
scheduler publish intent -> publish -> completed
manifest publish intent -> publish -> completed
controller load intent -> bootstrap -> identity verify -> completed
controller health ready
scheduler load intent -> bootstrap -> identity verify -> scheduled-outcome check -> completed
post-state verify
terminal committed journal with receipt hash
receipt publish and verify
conditional lock release
```

If either fixed label is loaded or unknown before first install, assert terminal `blocked`, outcome `label-in-use`, zero LaunchAgents mutation, zero bootout, and receipt-before-unlock.

- [ ] **Step 4: Write managed-upgrade and no-change RED tests**

Assert a managed upgrade stops scheduler before controller, records exact loaded booleans, publishes only changed roles, then loads controller → health → scheduler. A role with identical bytes writes a role-noop checkpoint. All artifacts identical returns terminal `no-change` with host mutation count zero.

Assert replacement requires the expected pre identity and a changed device/inode identity as well as candidate hash. Mismatch becomes terminal `blocked` before unlock.

- [ ] **Step 5: Write explicit-stop RED tests**

Stop probes both jobs, bootouts only jobs proven owned by current manifest/runtime binding, stops scheduler first, preserves all files/manifest, writes a terminal receipt, and records loaded false/false. Repeated stop uses stop-noop checkpoints and no launchctl mutation.

- [ ] **Step 6: Write bounded-compensation RED tests**

Inject failure after each publish/load stage. Assert entering compensation freezes one reverse plan, writes `compensating`, then each reverse action uses `compensate-<action>-intent/completed`. There is no nested compensation plan.

For controller health failure and scheduler load failure, restore byte-exact plists/manifest and the original loaded booleans. For a pre-state with both jobs stopped, compensation must not start either job.

- [ ] **Step 7: Run Task 4 RED**

Run:

```bash
node --test test/launchagent-lifecycle-transactions.test.js
```

Expected: FAIL on the explicit coordinator existence assertion, with no dynamic-import or syntax error.

- [ ] **Step 8: Implement transaction acquisition and journal state machine**

Implement the pre-lock and post-lock journal checks, lock identity verification around every metadata/host mutation, explicit intents/completions/noops, and terminal receipt ordering. All post-lock zero-host-mutation blockers write terminal `blocked` plus receipt before unlock.

- [ ] **Step 9: Implement first-install, managed-upgrade, and stop**

Use fixed per-operation state transition tables. Revalidate runtime binding before manifest publish, each bootstrap, and commit. Use parsed job identity to decide whether compensation may bootout a just-loaded job; uncertain or foreign identity transitions to MIR instead of booting it out.

- [ ] **Step 10: Run GREEN and focused regressions**

Run:

```bash
node --test test/launchagent-lifecycle-contracts.test.js test/launchagent-lifecycle-profiles.test.js test/launchagent-lifecycle-metadata.test.js test/launchagent-lifecycle-host-adapter.test.js test/launchagent-lifecycle-transactions.test.js
node --test test/supervisor-lifecycle.test.js test/supervisor-lifecycle-executor.test.js test/agent-supervisor-lifecycle-apply.test.js
```

Expected: all pass; protected legacy files remain unchanged.

- [ ] **Step 11: Review and commit gate**

Suggested commit: `feat: add V1.46 lifecycle transaction coordinator`. Stop for explicit commit approval; do not push.

---

### Task 5: Rollback, Uninstall, Recover, MIR, and Concurrency

**Files:**

- Create: `test/helpers/launchagent-lock-contender.js`
- Create: `test/launchagent-lifecycle-recovery.test.js`
- Create: `test/launchagent-lifecycle-concurrency.test.js`
- Modify: `test/helpers/launchagent-lifecycle-harness.js`
- Modify after valid RED: `src/launchagent-lifecycle/transaction-coordinator.js`
- Modify after valid RED: `src/launchagent-lifecycle/contracts.js`

- [ ] **Step 1: Freeze Task 5 boundaries**

Record status/hashes and the Task 4 GREEN output. No new public runtime surface is allowed.

- [ ] **Step 2: Write rollback RED tests**

Cover:

- exact current manifest hash/absence equals anchor rollback-from identity;
- activeAnchorId points to the selected target;
- controller/scheduler/manifest tagged bytes or absence restore byte-exactly;
- old recorded loaded booleans are replayed exactly;
- applied anchor cannot be replayed because lineage no longer matches;
- rollback-to-absent leaves both files and manifest absent;
- rollback runtime artifact missing/hash drift causes zero bootstrap and outcome `rollback-runtime-mismatch`;
- runtime mismatch first restores the rollback-attempt compensation anchor, then read-only revalidates both job identity hashes, runtime binding, plist/manifest hashes, and recorded loaded booleans against that anchor; compensation failure or close-out mismatch enters MIR, and only verified equality may close as recovered.

- [ ] **Step 3: Write uninstall RED tests**

Assert scheduler bootout precedes controller bootout. Before any file remove, both labels must be proven unloaded. A failed/unknown bootout returns `uninstall-unload-incomplete`, performs zero file mutation, and restores original loaded booleans through compensation.

Remove only files and active manifest whose expected identity matches. One missing/drifted plist must not cause deletion of the other. Foreign labels are never booted out.

- [ ] **Step 4: Write crash-recovery truth-table RED tests**

For every business intent and every compensation intent, simulate:

1. crash after intent before mutation;
2. crash after mutation before completed checkpoint.

Recover accepts only the exact legal pre or post identity, completes the same frozen reverse plan, and converges to either verified pre-state (`recovered`) or complete post-state (`committed`). Mixed identity, unknown state, conditional mismatch, or failed verification enters MIR.

Add the terminal-publication crash window: when the terminal journal entry embeds the closed deterministic receipt projection/hash but the receipt file is absent, recover performs zero host mutation, republishes that exact receipt no-clobber, revalidates it, then conditionally releases the lock. If a receipt file exists but is invalid or its hash differs, enter MIR without overwrite.

Include the two required windows:

```text
controller + scheduler + manifest published; controller not loaded
controller loaded and identity-proven; scheduler not loaded
```

- [ ] **Step 5: Write MIR handoff RED tests**

Inject crash at each boundary:

```text
MIR journal fsynced
mir-lock published
mir-lock identity verified
transaction lock conditionally released
```

Assert mir-lock always wins when both locks exist. Ordinary install/upgrade/stop/rollback/uninstall and ordinary recover return the existing MIR with host mutation count zero even if the transaction lock is absent.

Only `recoverAfterManualRepair` with a separately validated authorization identity may attempt takeover. Before any takeover, ordinary recovery must prove mir-lock and MIR journal are absent; if either exists it performs zero host mutation and routes only to manual repair. The coordinator accepts only a module-private brand minted by `acceptance-gate.js`; caller JSON such as `approved:true` is never sufficient. Its sanitized projection has exactly:

```js
{
  schemaVersion: 1,
  kind: 'launchagent-manual-repair',
  manualRepairRequestId: '018f0f95-3d3a-7f01-8c6a-2a6f98765450',
  mirTransactionId: '018f0f95-3d3a-7f01-8c6a-2a6f98765451',
  mirLockIdentitySha256: 'a'.repeat(64),
  anchorId: '018f0f95-3d3a-7f01-8c6a-2a6f98765452',
  repairDeclarationSha256: 'b'.repeat(64),
  authorizedAt: '2026-07-28T00:00:00.000Z',
}
```

Minting requires a separately prepared request and one-time `manualRepairConfirmationId` consumed durably before brand creation, bound to all fields above. Takeover must conditionally acquire a fresh recovery lock, read-only diff current host facts against the MIR entry/anchor, and either perform pure verification or resume only actions already present in the original frozen compensation plan; it cannot introduce a new action/plan. Persist the operator-attestation projection in metadata before takeover. If repaired state cannot be proven or any action deviates, MIR and mir-lock remain. A valid terminal journal/receipt must be written and verified before mir-lock release.

- [ ] **Step 6: Write crash-restart and job-identity recovery RED tests**

Simulate a controller process crash followed by launchd KeepAlive replacement. Read-only observation must prove the fixed controller label is loaded with a new PID, matching `jobIdentitySha256`, and healthy; it records a closed `crash-restarted` observation with host mutation count zero. A scheduler exit 0 remains normal completion. An explicit stop remains both jobs unloaded and must not be reclassified as crash restart or trigger a health/start call.

After bootstrap but before load-completed journal, allow compensation bootout only when `jobIdentitySha256` equals the candidate/runtime binding. Missing/ambiguous/mismatched print projection enters MIR and records no raw print output.

- [ ] **Step 7: Write independent-process lock RED tests**

Use two Node child processes and one fresh temp metadata root. Assert exactly one exclusive owner, the loser returns `transaction-in-progress`, and journal writer identity never changes. Orphan takeover is only an operator-invoked recovery operation, never an automatic liveness action. Test it only after owner death plus matching PID/nonce/available boot-session and process-start lock identity, matching journal/anchor identity, proven absence of mir-lock/MIR entry, conditional lock removal, and fresh recovery lock acquisition. PID reuse or unavailable identity/liveness facts remain blocked.

Delete the ordinary lock while preserving every nonterminal journal state and assert all normal operations perform zero host mutation and return `recovery-required`.

- [ ] **Step 8: Run Task 5 RED**

Run:

```bash
node --test test/launchagent-lifecycle-recovery.test.js test/launchagent-lifecycle-concurrency.test.js
```

Expected: FAIL on missing rollback/uninstall/recover/MIR behavior, not harness/import errors.

- [ ] **Step 9: Implement rollback and uninstall**

Reuse the Task 4 operation tables and one compensation engine. Do not add an independent ad hoc rollback writer. Revalidate live runtime before any rollback bootstrap.

- [ ] **Step 10: Implement recovery and MIR**

Recover from journal/anchor/manifest/actual identities only. It may not use timestamps or label existence as ownership. Make MIR handoff and after-manual-repair takeover explicit state transitions with durable identity checks.

- [ ] **Step 11: Run GREEN and all lifecycle tests**

Run:

```bash
node --test test/launchagent-lifecycle-*.test.js
```

Expected: all lifecycle tests pass, including independent child contention; no real launchctl or real LaunchAgents access occurs.

- [ ] **Step 12: Review and commit gate**

Suggested commit: `feat: add V1.46 lifecycle recovery and rollback`. Stop for explicit commit approval; do not push.

---

### Task 6: Two-Stage Acceptance Gate and Safe Exports

**Files:**

- Create: `test/launchagent-lifecycle-acceptance-gate.test.js`
- Create after valid RED: `src/launchagent-lifecycle/acceptance-gate.js`
- Create after valid RED: `src/launchagent-lifecycle/index.js`
- Modify after valid RED: `src/launchagent-lifecycle/contracts.js`
- Modify after valid RED: `src/launchagent-lifecycle/metadata-store.js`

- [ ] **Step 1: Freeze Task 6 boundaries**

Record status/hashes. Confirm there is still no Agent/API/Web lifecycle execute route.

- [ ] **Step 2: Write prepare-request RED tests**

`prepareLaunchAgentAcceptanceRequest` is read-only and returns exactly:

```js
{
  schemaVersion: 1,
  acceptanceId: '018f0f95-3d3a-7f01-8c6a-2a6f98765440',
  uid: 501,
  launchAgentsRootId: 'current-user-launch-agents',
  sourceCommit: 'a'.repeat(40),
  runtimeArtifacts: {
    node: 'b'.repeat(64),
    controller: 'c'.repeat(64),
    agent: 'd'.repeat(64),
  },
  executeAuthorized: false,
  nonProductionConfirmed: false,
  state: 'prepared',
}
```

It must not return the resolved home/root, username, argv, environment, config, or candidate bytes.

- [ ] **Step 3: Write confirmation consumption RED tests**

Require both `executeRequested === true` and a separate `nonProductionConfirmationId`. Bind that ID to acceptanceId, uid, root ID, source commit, and all three runtime hashes.

Assert event order is:

```text
validate prepare identity
validate current host identity
publish consumed-confirmation no-clobber
fsync consumed record and directory
re-read and verify consumed identity
re-derive current host/runtime facts and compare to consumed snapshot
mint module-private capability
```

Observe the two fsync events through `createLaunchAgentMetadataStoreForTest`; the production/internal metadata factory still accepts no injected fs or trace dependency.

The consumed record embeds the validated uid/root/source/runtime fact snapshot. Any change between first validation and the mint-time re-derivation burns the consumed ID and returns `acceptance-gate-denied`; it cannot mint or reuse the ID.

Map denial outcomes exactly: missing execute intent, missing confirmation, identity mismatch, persistence/re-read failure, or fake host dependency → `acceptance-gate-denied`; replay → `confirmation-consumed`; production CAS absence → `conditional-mutation-unsupported`. No failure can mint.

Apply the same consume-before-mint protocol to `prepareLaunchAgentManualRepairRequest` plus a distinct one-time `manualRepairConfirmationId`. Bind it to request ID, MIR transaction ID, mir-lock identity hash, anchor ID, and repair-declaration hash. A non-production confirmation cannot substitute for a manual-repair confirmation, and neither confirmation type can be replayed.

- [ ] **Step 4: Write private-brand and safe-index RED tests**

Assert a caller-created lookalike capability is rejected by object identity. Freeze the exact `index.js` export names:

```text
LAUNCHAGENT_LIFECYCLE
LAUNCHAGENT_LIFECYCLE_CODES
bindLaunchAgentRuntime
renderLaunchAgentProfiles
validateLaunchAgentManifest
validateLaunchAgentAnchor
validateLaunchAgentJournal
validateLaunchAgentReceipt
validateLaunchAgentAcceptanceRequest
validateLaunchAgentConfirmationRecord
validateLaunchAgentConsumedConfirmation
validateLaunchAgentCapabilityProjection
prepareLaunchAgentAcceptanceRequest
prepareLaunchAgentManualRepairRequest
createDisabledLaunchAgentLifecycleFacade
```

It must not export either metadata-store factory, account resolver, plist validator, launchctl parser, host inspector, injectable coordinator, test publisher, brand, runner constructor, mint function, or production execution composition root.

Importing `index.js` must perform zero filesystem/process/network work.

- [ ] **Step 5: Write code-stage denial RED tests**

Assert the no-dependency production composition path reaches `conditional-mutation-unsupported` before account mutation, confirmation mint, launchctl, or LaunchAgents write. This is a required PASS for the candidate, not a missing-test skip.

- [ ] **Step 6: Run Task 6 RED**

Run:

```bash
node --test test/launchagent-lifecycle-acceptance-gate.test.js
```

Expected: FAIL on the explicit acceptance-gate/index existence assertions, with no dynamic-import or syntax error.

- [ ] **Step 7: Implement prepare/confirmation protocol and private capability**

Keep the brand in module scope. The testable protocol may accept narrow fake stores only through an explicitly internal harness function not re-exported by `index.js`. The production entry accepts no dependency injection and remains unable to construct a runner while CAS support is absent.

- [ ] **Step 8: Run GREEN and public-surface scans**

Run:

```bash
node --test test/launchagent-lifecycle-acceptance-gate.test.js test/launchagent-lifecycle-*.test.js
rg -n "launchagent-lifecycle|acceptanceId|nonProductionConfirmationId" src/agent.js src/server.js src/web
```

Expected: lifecycle tests pass; the public-surface scan returns no newly added route/command/UI wiring.

- [ ] **Step 9: Review and commit gate**

Suggested commit: `feat: add V1.46 acceptance gate boundary`. Stop for explicit commit approval; do not push.

---

### Task 7: Integration Candidate, Version, Gold, and README Honesty

**Files:**

- Create: `test/launchagent-lifecycle-integration.test.js`
- Modify: `src/gold-readiness.js`
- Modify: `src/version.js`
- Modify: `README.md`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/agent-gold-readiness.test.js`
- Modify: `test/readme.test.js`
- Modify: `test/g0c-auto-harness.test.js`

- [ ] **Step 1: Freeze Task 7 boundaries**

Record status, HEAD/upstream, all lifecycle source hashes, and protected legacy hashes. Confirm every Task 1–6 test is green.

- [ ] **Step 2: Write integration RED tests**

Import the internal transaction module in the integration test and assemble it with temp metadata plus fake inspector/publisher/launchctl/health. Run first install → explicit stop → managed upgrade failure → recovery → rollback → uninstall. Assert closed receipts, final absence, no leaked paths, and exact trace identities.

Separately import the safe-index production-default facade and assert `conditional-mutation-unsupported`, `launchctlCalls=0`, `launchAgentsMutations=0`, and no capability.

- [ ] **Step 3: Write version/Gold honesty RED tests**

Freeze the current signature:

```text
V1.46 current-user dual LaunchAgent lifecycle implementation candidate
```

Assert:

```js
assert.strictEqual(report.version, 'V1.46');
assert.strictEqual(report.readyCount, 6);
assert.strictEqual(report.partialCount, 3);
assert.strictEqual(report.blockedCount, 0);
assert.strictEqual(report.totalCount, 9);
assert.strictEqual(automation.status, 'partial');
```

The automation evidence must mention dual profile contracts, transaction/recovery/MIR tests, fake launchctl only, production CAS unsupported, real clean-Mac receipt absent, and candidate/not-Gold status.

Machine-lock all five false literals in Gold/README/current supervisor evidence. A true value or omitted literal is RED.

- [ ] **Step 4: Write README RED tests**

Require:

- heading and current row `V1.46`;
- exact candidate signature;
- V1.45 moved to a retained historical row;
- `automation-installation partial` and `Gold remains partial 6/3/0/9`;
- no claim of real LaunchAgent install, real launchctl PASS, clean-Mac acceptance, Gold, GA, production hardening, or execution readiness;
- explicit next gate: separately authorized, version-exact non-production clean-Mac lifecycle acceptance after a real conditional mutation adapter exists.

- [ ] **Step 5: Run Task 7 RED**

Run:

```bash
node --test test/launchagent-lifecycle-integration.test.js test/version.test.js test/gold-readiness.test.js test/agent-gold-readiness.test.js test/readme.test.js test/g0c-auto-harness.test.js
```

Expected: lifecycle integration may pass, but version/honesty assertions fail because current public surfaces are still V1.45.

- [ ] **Step 6: Implement safe integration only**

Make the minimum lifecycle changes needed for the fake-adapter end-to-end candidate. Do not modify Agent/controller/server/Web execution surfaces.

- [ ] **Step 7: Update version and Gold evidence**

Set only `LINKE_RELEASE_VERSION` to `V1.46`. Add lifecycle candidate evidence to `automation-installation` while leaving status partial. Preserve all nine item IDs/statuses and the `6/3/0/9` aggregate.

- [ ] **Step 8: Update README current/historical surfaces**

Add one V1.46 current row and demote the existing V1.45 row to history. Preserve prior release history and the committed V1.44 NAS acceptance facts. Use candidate wording throughout.

- [ ] **Step 9: Run GREEN and legacy regressions**

Run:

```bash
node --test test/launchagent-lifecycle-*.test.js test/launchd-dry-run.test.js test/agent-run-once.test.js test/agent-supervisor-install-dry-run.test.js test/controller-runtime.test.js test/version.test.js test/gold-readiness.test.js test/agent-gold-readiness.test.js test/readme.test.js test/g0c-auto-harness.test.js
```

Expected: all pass; legacy dry-run remains non-writing and all five flags remain false.

- [ ] **Step 10: Review and commit gate**

Suggested commit: `feat: publish V1.46 LaunchAgent lifecycle candidate`. Stop for explicit commit approval; do not push.

---

### Task 8: Full Verification and PM Closure

**Files:** no production changes expected. Any test or source repair reopens the owning task and repeats its RED/GREEN/review gate.

- [ ] **Step 1: Verify exact changed-path allowlist**

Run:

```bash
git status --short --branch
git ls-files --others --exclude-standard
git diff --name-only --diff-filter=ACMRTUXB f0577be2eac9282b131dde52854a6f10a12a2cea
git diff --check f0577be2eac9282b131dde52854a6f10a12a2cea
```

Expected: the pinned design-only baseline still exists and is the approved comparison anchor; only the explicit plan/lifecycle/test/version/Gold/README paths differ from it across committed and working-tree changes. The explicit untracked listing contains only the known `package-lock.json`; any other untracked path is HOLD. `package-lock.json` remains excluded from every stage. A clean working tree does not satisfy this check by itself.

- [ ] **Step 2: Run focused lifecycle and legacy suites**

Run:

```bash
node --test test/launchagent-lifecycle-*.test.js
node --test test/launchd-dry-run.test.js test/agent-run-once.test.js test/agent-supervisor-install-dry-run.test.js test/controller-runtime.test.js
node --test test/supervisor-lifecycle*.test.js test/agent-supervisor-lifecycle-apply.test.js
node --test test/version.test.js test/gold-readiness.test.js test/agent-gold-readiness.test.js test/readme.test.js test/g0c-auto-harness.test.js
```

Expected: zero fail. Existing intentional skips/todos may remain only if unrelated and already documented; no lifecycle test may be skipped.

- [ ] **Step 3: Run the complete regression suite**

First prove the protected existing script discovers the new files:

```bash
rg -n '"test": "node --test test/\*\.test\.js"' package.json
```

Expected: exactly the existing globbed test script; every new lifecycle test filename matches `test/*.test.js`, so no package script edit is needed.

Run:

```bash
npm test
```

Expected: zero fail, and output contains every `launchagent-lifecycle-*.test.js` suite with no lifecycle skip. Record the actual pass/fail/skip/todo counts from this run; do not reuse historical counts.

- [ ] **Step 4: Run safety and honesty scans**

Run:

```bash
rg -n "shell:[[:space:]]*true|eval\(|child_process\.exec\(|/System/Library/LaunchDaemons|/Library/LaunchDaemons|sudo" src/launchagent-lifecycle test/launchagent-lifecycle-*.test.js test/helpers/launchagent-lifecycle-harness.js test/helpers/launchagent-lock-contender.js
rg -n "realCapabilityImplementationsReady:true|realRunnerWiringReady:true|runnerWiringContractReady:true|executeCapabilityAuthorized:true|executionEligible:true" src/gold-readiness.js README.md test/gold-readiness.test.js test/g0c-auto-harness.test.js
rg -n "Gold (is |equals )?(complete|ready)|Gold PASS|Gold complete|GA (is |equals )?(complete|ready)|GA PASS|GA complete|clean[- ]Mac lifecycle acceptance PASS|real launchctl acceptance PASS" README.md src/gold-readiness.js
```

Expected: no unadjudicated unsafe call/fallback or positive execution/Gold overclaim. The required honest aggregate `Gold remains partial 6/3/0/9` is not a match. Test negative fixtures may match and must be identified as assertions, not ignored wholesale.

- [ ] **Step 5: Prove safe public boundaries**

Run the import-side-effect, hard-disabled runner, unsupported-CAS, and public-surface tests again. Confirm `src/agent.js`, `src/controller-runtime.js`, `src/server.js`, `src/web/**`, and `src/supervisor-lifecycle.js` hashes equal their Task 1 protected hashes.

- [ ] **Step 6: Self-review design coverage and type consistency**

Create a mechanical checklist mapping every approved design section to at least one implementation test: dual profiles, manifest/anchor schemas, account root, conditional mutations, first install, upgrade, stop, crash, rollback, uninstall, recover, compensation, nonterminal journal, MIR, confirmation consumption, raw-print disposal, receipt sanitization, Gold flags.

Scan changed source/test files for unfinished markers such as `TODO`, `FIXME`, `throw new Error('not implemented')`, empty function bodies, disabled tests, and unbounded `any`-like object pass-through. Any match is repaired in its owning task.

- [ ] **Step 7: Qwen statistics**

Supply exact changed-file list and fresh test output. Require counts for source/test files, test cases, skipped lifecycle tests, unsafe scan matches, Gold status tuple, five false flags, and forbidden-file diff. Qwen reports statistics only.

- [ ] **Step 8: Fresh Kimi closure review**

Supply the approved design, this plan, exact diff, focused/full test outputs, scans, and Qwen counts. Require structured `P0`, `P1`, `P2`, `closureReady`, and evidence references. `P0>0`, `P1>0`, missing evidence, or helper failure is HOLD.

- [ ] **Step 9: Codex PM final verification**

Codex independently verifies Git facts, reruns any disputed command, adjudicates every finding, and confirms:

```text
V1.46 implementation candidate
automation-installation=partial
Gold=6 ready / 3 partial / 0 blocked / total 9
five execution flags=false
real conditional mutation adapter absent
real launchctl calls=0
real clean-Mac lifecycle receipt absent
not Gold / not GA
```

- [ ] **Step 10: Final commit and push gates**

If Task 7 was not committed separately, stage only the approved V1.46 candidate paths and run `git diff --cached --check`; then stop for explicit commit approval. After an approved commit, verify the commit tree and local tests again, then stop for a separate push approval. Do not infer deployment or clean-Mac acceptance from either approval.

## Execution Choice After Plan Approval

- **A — Inline pm-dcw execution (recommended):** continue in this session, one task at a time, using fresh Kimi Code CLI for RED/GREEN, Qwen statistics, fresh Kimi closure, and Codex verification. This preserves the user's current role map and all Git gates.
- **B — Separate executing-plans session:** open a fresh session in this worktree and execute the same task sequence with the recorded checkpoints. This reduces conversational context but requires re-grounding HEAD/upstream and helper availability.

The later real non-production clean-Mac lifecycle acceptance is not part of either choice. It requires a separate design/authorization after a real conditional mutation adapter is implemented and version-exact V1.46 candidate commits are frozen.
