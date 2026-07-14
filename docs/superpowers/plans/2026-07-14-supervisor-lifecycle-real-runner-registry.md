# V1.25 Supervisor Lifecycle Real Runner Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace V1.18 disabled runner registry catalog with a code-owned pure fail-closed registry resolver/readiness contract; mark `runner-registry` required contract ready; keep production execution and Gold blocked.

**Architecture:** Add `resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, operation)` as the only registry resolve path. Convert readiness to fixed ready evidence (`codeOwnedRegistryResolverReady:true`, keep `realRunnerImplementationsReady:false`). Gate calls resolver only with production-derived sanitized `actionCandidates` + allowlisted `operation`, attaches sanitized `registryDecision` (field `codeOwnedResolverWired:true`), derives local `runnerRegistryReady` into policy. Wiring → `readyCount:2` / `blockedCount:4`. Four downstream contracts remain blocked → policy denies; side-effect flags stay false. Web uses **strict canonical fail-closed assembly** (not unconditional ready). JS Proxy defense is best-effort.

**Tech Stack:** Node.js ESM, `node:test`, existing Web Console view model helpers, README/Gold static scorecard tests.

**Spec:** `docs/superpowers/specs/2026-07-14-supervisor-lifecycle-real-runner-registry-design.md`

**Recovery anchor:** `1d7f9a2`

## Global Constraints

- Current release version becomes `V1.25`.
- Do not add endpoint, CLI command, Web button, or request body field.
- Do not modify `src/agent.js`, `src/server.js`, or `package.json`.
- Do not accept request/CLI `registryDecision` / `registryContext` / `runnerRegistryReady` overrides.
- Do not call host shell / process-control / process list / filesystem / metadata / audit / approval writes / NAS / backup / restore / remote / network.
- Do not schedule, dispatch, or invoke runners; do not return functions/commands/paths/hosts/tokens/hashes/raw errors.
- Production path: `policyDecision` always denied; `executionEligible:false`; Gold `blocked`.
- G0a real two-Mac PASS statements stay unchanged.
- Malicious fixtures use **opaque synthetic strings only** (`UNSAFE_SECRET_MATERIAL`, `OPAQUE_UNSAFE_FIELD`).
- Sensitive scans report **category hit counts only**.
- Do **not** change V1.24 `areSupervisorLifecycleGuardedRunnerActionCandidatesReady` maxAttempts contract (still accepts `1..3` **or** `'[redacted]'`).
- Blocker vocabulary **excludes** `runner-registry-operation-mismatch` and `runner-registry-action-extra`.
- This planning phase must not modify `src/`, `test/`, `README.md`, `package*`, or version files; implementation phase follows this plan.
- Do **not** create `actual-changes.txt`. Do **not** use `git reset --hard` as a routine recovery step in this plan.

---

### Task 1: Pure Resolver + Ready Registry Readiness Contract

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

**Interfaces:**
- `resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, operation): object`
- `buildSupervisorLifecycleGuardedRunnerRegistryReadiness(): object` (ready)
- `runnerWiringContract.requiredContracts[1].status:'ready'`
- gate later wires `registryDecision` + `gates.runnerRegistryReady`
- wiring `readyCount:2` / `blockedCount:4`

- [ ] **Step 1: Write the failing pure tests (RED)**

Update imports:

```js
import {
  // existing...
  resolveSupervisorLifecycleGuardedRunnerRegistry,
  buildSupervisorLifecycleGuardedRunnerRegistryReadiness,
  areSupervisorLifecycleGuardedRunnerActionCandidatesReady,
} from '../src/supervisor-lifecycle.js';
```

Fixtures:

```js
const EXPECTED_WIRING_CONTRACTS = Object.freeze([
  ['execution-policy', null, 'ready', 'execution-policy-ready'],
  ['runner-registry', null, 'ready', 'runner-registry-ready'],
  ['host-mutation-adapter', 'host-mutation-adapter-missing', 'blocked', 'host-mutation-adapter-missing'],
  ['rollback-anchor', 'rollback-anchor-missing', 'blocked', 'rollback-anchor-missing'],
  ['attempt-audit', 'attempt-audit-missing', 'blocked', 'attempt-audit-missing'],
  ['operator-recovery', 'operator-recovery-missing', 'blocked', 'operator-recovery-missing'],
]);

const EXPECTED_RUNNER_REGISTRY_ENTRIES = Object.freeze([
  {
    registryKind: 'code-owned-runner-registry',
    runnerKind: 'guarded-runner-stub',
    state: 'ready',
    codeOwnedResolverWired: true,
    realHostRunnerReady: false,
    realImplementationReady: false,
    supportsHostMutation: false,
    wouldExecute: false,
    wouldRun: false,
    wouldWrite: false,
    blockerCode: null,
    evidenceCode: 'runner-registry-ready',
  },
]);

const CODE_OWNED_REGISTRY_MAPPINGS = Object.freeze({
  'render-launch-agent-plist': 'render-plist-impl',
  'write-launch-agent-plist': 'write-plist-impl',
  'load-launch-agent': 'load-agent-impl',
  'unload-launch-agent': 'unload-agent-impl',
  'remove-launch-agent-plist': 'remove-plist-impl',
  'remove-supervisor-metadata': 'remove-metadata-impl',
  'capture-current-state': 'capture-state-impl',
  'restore-previous-plist': 'restore-plist-impl',
  'restart-previous-supervisor': 'restart-supervisor-impl',
  'start-recovery-supervisor': 'recovery-supervisor-impl',
});

const OPERATION_EXPECTED_ACTION_IDS = Object.freeze({
  install: Object.freeze([
    'render-launch-agent-plist',
    'write-launch-agent-plist',
    'load-launch-agent',
  ]),
  uninstall: Object.freeze([
    'unload-launch-agent',
    'remove-launch-agent-plist',
    'remove-supervisor-metadata',
  ]),
  rollback: Object.freeze([
    'capture-current-state',
    'restore-previous-plist',
    'restart-previous-supervisor',
  ]),
  recover: Object.freeze(['start-recovery-supervisor']),
});
```

Helpers:

```js
function validRegistryCandidate(actionId, maxAttempts = 1) {
  return {
    actionId,
    implementationId: CODE_OWNED_REGISTRY_MAPPINGS[actionId],
    runnerKind: 'guarded-runner-stub',
    mode: 'guarded-host-action',
    status: 'blocked',
    wouldExecute: false,
    wouldRun: false,
    wouldWrite: false,
    maxAttempts,
  };
}

function validRegistryCandidatesFor(operation) {
  return OPERATION_EXPECTED_ACTION_IDS[operation].map((id) => validRegistryCandidate(id, 1));
}

/**
 * assertUnresolvedExact：第三参 operation **必传**，禁止默认 `'unknown'`。
 * - typeof operation === 'string' 且 decision.operation === operation（严格全等）
 * - 合法 install/uninstall/rollback/recover 输入上的 **任意** unresolved：第三参传对应合法 operation（回显）
 * - **仅** invalid operation（R17）传 expected output `'unknown'`
 * - 禁止“所有 unresolved operation 都是 unknown”
 */
function assertUnresolvedExact(decision, primaryBlocker, operation) {
  assert.strictEqual(typeof operation, 'string');
  assert.strictEqual(typeof primaryBlocker, 'string');
  assert.strictEqual(decision.command, 'supervisor-lifecycle-guarded-runner-registry');
  assert.strictEqual(decision.operation, operation);
  assert.strictEqual(decision.state, 'unresolved');
  assert.strictEqual(decision.registryReady, false);
  assert.strictEqual(decision.codeOwnedResolverWired, true);
  assert.strictEqual(decision.realHostRunnerReady, false);
  assert.strictEqual(decision.supportsHostMutation, false);
  assert.strictEqual(decision.wouldExecute, false);
  assert.strictEqual(decision.wouldRun, false);
  assert.strictEqual(decision.wouldWrite, false);
  assert.strictEqual(decision.sensitiveValuesReturned, false);
  assert.strictEqual(decision.resolvedCount, 0);
  assert.strictEqual(decision.unresolvedCount, 0);
  assert.deepStrictEqual(decision.mappings, []);
  assert.deepStrictEqual(decision.blockers, [primaryBlocker]);
  assert.strictEqual(decision.primaryBlocker, primaryBlocker);
  assert.deepStrictEqual(decision.nextBlockers, [primaryBlocker]);
  assert.deepStrictEqual(decision.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  assert.ok(!Object.values(decision).some((v) => typeof v === 'function'));
}

/**
 * assertResolved：与 design §1.5 mappings 行 schema 全字段一致。
 * - 第二参 operation 决定 expected action 序
 * - 第三参 inputCandidates 为 resolve 前的 plain candidates 快照（用于 maxAttempts exact 比对）
 * - mapping row **不含** codeOwnedResolverWired（该字段仅 decision / readiness entry 级）
 */
function assertResolved(decision, operation, inputCandidates) {
  const expected = OPERATION_EXPECTED_ACTION_IDS[operation];
  assert.ok(Array.isArray(inputCandidates));
  assert.strictEqual(inputCandidates.length, expected.length);
  // 按 expected action 序建立 input maxAttempts 查找表（可执行，非注释占位）
  const maxAttemptsByActionId = new Map(
    inputCandidates.map((c) => [c.actionId, c.maxAttempts]),
  );
  for (const actionId of expected) {
    const maxAttempts = maxAttemptsByActionId.get(actionId);
    assert.strictEqual(typeof maxAttempts, 'number');
    assert.ok(Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 3);
  }

  assert.strictEqual(decision.command, 'supervisor-lifecycle-guarded-runner-registry');
  assert.strictEqual(decision.operation, operation);
  assert.strictEqual(decision.state, 'resolved');
  assert.strictEqual(decision.registryReady, true);
  assert.strictEqual(decision.codeOwnedResolverWired, true);
  assert.strictEqual(decision.realHostRunnerReady, false);
  assert.strictEqual(decision.supportsHostMutation, false);
  assert.strictEqual(decision.wouldExecute, false);
  assert.strictEqual(decision.wouldRun, false);
  assert.strictEqual(decision.wouldWrite, false);
  assert.strictEqual(decision.sensitiveValuesReturned, false);
  assert.strictEqual(decision.resolvedCount, expected.length);
  assert.strictEqual(decision.unresolvedCount, 0);
  assert.strictEqual(decision.mappings.length, expected.length);
  assert.deepStrictEqual(decision.blockers, []);
  assert.strictEqual(decision.primaryBlocker, null);
  assert.deepStrictEqual(decision.nextBlockers, []);
  assert.deepStrictEqual(decision.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  for (let i = 0; i < expected.length; i++) {
    const actionId = expected[i];
    const row = decision.mappings[i];
    const expectedMaxAttempts = maxAttemptsByActionId.get(actionId);
    assert.strictEqual(row.actionId, actionId);
    assert.strictEqual(row.implementationId, CODE_OWNED_REGISTRY_MAPPINGS[actionId]);
    assert.strictEqual(row.runnerKind, 'guarded-runner-stub');
    assert.strictEqual(row.mode, 'guarded-host-action');
    // maxAttempts：对应 input snapshot 的 exact 整数，且范围 1..3
    assert.strictEqual(row.maxAttempts, expectedMaxAttempts);
    assert.strictEqual(typeof row.maxAttempts, 'number');
    assert.ok(Number.isInteger(row.maxAttempts) && row.maxAttempts >= 1 && row.maxAttempts <= 3);
    assert.strictEqual(row.mappingReady, true);
    assert.strictEqual(row.realHostRunnerReady, false);
    assert.strictEqual(row.supportsHostMutation, false);
    assert.strictEqual(row.wouldExecute, false);
    assert.strictEqual(row.wouldRun, false);
    assert.strictEqual(row.wouldWrite, false);
    assert.strictEqual(row.blockerCode, null);
    assert.strictEqual(row.evidenceCode, 'runner-registry-mapping-ready');
    // row schema 不含 codeOwnedResolverWired — 不得出现在 mapping 行上
    assert.strictEqual(Object.hasOwn(row, 'codeOwnedResolverWired'), false);
  }
}
```

#### Exact test matrix — pure resolver（每个失败类 **单一 exact** primaryBlocker）

**分类不变量（与 design §1.2 / §1.6 一致）：**

- **candidates-invalid 仅限**：非 array、empty、容器/元素 shape/exact-key/accessor/trap/type-confusion、**snapshot 后 actionId 非非空 string**（含 `''`、number）
- **集合偏差**：非 empty、元素 schema 过、且每项 actionId 已是非空 string 后，固定 **duplicate → unknown → missing**
- **`|A| !== |E|` 本身绝不能**直接变 `candidates-invalid`（R6 `|A|<|E|` → missing；R23 `|A|>|E|` 外来 id → unknown；R24 `|A|>|E|` 重复 id → duplicate）
- **pure 长度两侧必测**：`len < |E|`（R6）与 `len > |E|`（R23/R24）；长度不等式永不直接 `candidates-invalid`
- **resolved 成功**才要求集合/长度 exact match（R1–R4、R20）

| ID | Case | Input（可构造） | Expected primaryBlocker / state | `assertUnresolvedExact` 第三参 / `decision.operation` |
| --- | --- | --- | --- | --- |
| R1 | install happy | `validRegistryCandidatesFor('install')` | resolved；mappings 3；would* false；`codeOwnedResolverWired:true`；每行 `supportsHostMutation:false` + `maxAttempts` exact from input | n/a（`assertResolved`；`operation:'install'`） |
| R2 | uninstall happy | valid uninstall | resolved；mappings 3 | n/a（`assertResolved`；`operation:'uninstall'`） |
| R3 | rollback happy | valid rollback | resolved；mappings 3 | n/a（`assertResolved`；`operation:'rollback'`） |
| R4 | recover happy | valid recover | resolved；mappings 1；would* false | n/a（`assertResolved`；`operation:'recover'`） |
| R5 | unknown action | install 集中把 `load-launch-agent` 换成 `start-recovery-supervisor`（仍 3 行、无重复、合法 shape） | unresolved + **`runner-registry-action-unknown`**；`resolvedCount:0` `unresolvedCount:0` `mappings:[]` | **必传 `'install'`**（合法 operation 回显；**不是** `'unknown'`） |
| R6 | missing action | install 去掉 `load-launch-agent`（2 行 ⊆ E，合法 shape，`|A|=2≠3`） | unresolved + **`runner-registry-action-missing`**（**不是** candidates-invalid） | **必传 `'install'`** |
| R7 | duplicate action | install 两行同 `render-launch-agent-plist`（可补齐其余字段为合法 shape） | unresolved + **`runner-registry-action-duplicate`** | **必传 `'install'`** |
| R8 | non-catalog implementationId | install 合法 slug `other-plist-impl`（过 pattern，不在 catalog） | unresolved + **`runner-registry-implementation-mismatch`**（pure；**不能**替代 gate G8） | **必传 `'install'`** |
| R9 | wrong runnerKind | install 首行 `runnerKind:'other-stub'` | unresolved + **`runner-registry-runner-kind-mismatch`** | **必传 `'install'`** |
| R10 | wrong mode | install 首行 `mode:'unguarded'` | unresolved + **`runner-registry-mode-mismatch`** | **必传 `'install'`** |
| R11 | maxAttempts out of range | install；`0` / `4` / `1.5` / `'1'` 各一条 table 行 | unresolved + **`runner-registry-max-attempts-invalid`** | **必传 `'install'`**（每行） |
| R12 | maxAttempts redacted | install 首行 `maxAttempts:'[redacted]'` | unresolved + **`runner-registry-max-attempts-invalid`**；且 **同一 candidates** 上 `areSupervisorLifecycleGuardedRunnerActionCandidatesReady(...)===true`（分层 pure；**不能**替代 gate G9） | **必传 `'install'`** |
| R13 | accessor own props | install；data getters on candidate keys | unresolved + **`runner-registry-candidates-invalid`** | **必传 `'install'`** |
| R14 | trap throw | install；Proxy `getOwnPropertyDescriptor` throws `UNSAFE_SECRET_MATERIAL` | unresolved + **`runner-registry-candidates-invalid`**；`JSON.stringify(decision)` 不含 secret | **必传 `'install'`** |
| R15 | type-confusion | `operation:'install'` + candidates = null / non-array / string / number / plain object | unresolved + **`runner-registry-candidates-invalid`** | **必传 `'install'`**（operation 合法；candidates 非法） |
| R16 | sensitive-like unknown keys | install 首行 extra `OPAQUE_UNSAFE_FIELD` | unresolved + **`runner-registry-candidates-invalid`**；不回显 secret | **必传 `'install'`** |
| R17 | invalid operation | `operation:'apply-all'` + 任意 candidates（可用 valid install） | unresolved + **`runner-registry-operation-invalid`** | **仅此行传 `'unknown'`**（schema 唯一 unknown） |
| R18 | side-effect flags | install；两 case 分测：`wouldRun:true`；`status:'ready'` | 各自 unresolved + **`runner-registry-side-effect-flag-invalid`** | **必传 `'install'`**（两 case） |
| R19 | input/output immutability | mutate input after resolve；mutate decision then re-resolve | 已返回 decision 不受污染；后续调用不受 output 污染；若走 unresolved 路径须显式第三参 | 走 resolved 时用 `assertResolved`；走 unresolved 时 **必传**对应合法 operation 或 R17 的 `'unknown'`（**不得**省略） |
| R20 | install fixture maxAttempts | candidates matching gate fixture maxAttempts 2/1/3 + exact install impl IDs | resolved；mapping `maxAttempts` 分别为 2/1/3 exact | n/a（`assertResolved`；`operation:'install'`） |
| R21 | array Proxy container | `operation:'install'` + `new Proxy([...valid install], { get(t,p,r){ if(p==='length'||typeof p==='string'&&/^\d+$/.test(p)) throw new Error(UNSAFE_SECRET_MATERIAL); return Reflect.get(t,p,r);} })` | unresolved + **`runner-registry-candidates-invalid`**；无 secret 泄漏（**不**断言 Array.isArray 拒绝 Proxy） | **必传 `'install'`** |
| R22 | non-nonempty-string actionId | **table**：每行 **独立 fresh** `validRegistryCandidatesFor('install')`；case A 首行 `actionId:''`；case B 首行 `actionId:1`（number）；其余字段合法 shape | 各自 unresolved + **`runner-registry-candidates-invalid`**（primary；**先于** duplicate/unknown/missing；**不是** action-unknown） | **必传 `'install'`**（两 case；**不是** `'unknown'`） |
| R23 | `|A|>|E|` unknown | **独立 fresh** `validRegistryCandidatesFor('install')`，再 `push(validRegistryCandidate('start-recovery-supervisor', 1))`；总长 4、无重复、含 install expected set 外 action | unresolved + **唯一 primary `runner-registry-action-unknown`**（**不是** candidates-invalid；长度不等式本身不进 invalid） | **必传 `'install'`** |
| R24 | `|A|>|E|` duplicate | **独立 fresh** `validRegistryCandidatesFor('install')`，再 `push(validRegistryCandidate('render-launch-agent-plist', 1))`；总长 4、有重复（`render-launch-agent-plist` 出现 ≥2） | unresolved + **唯一 primary `runner-registry-action-duplicate`**（**不是** candidates-invalid；长度不等式本身不进 invalid） | **必传 `'install'`** |

**禁止**在断言里写 “X 或 Y”。**禁止**引用 `runner-registry-operation-mismatch` / `runner-registry-action-extra`。
**禁止**省略 `assertUnresolvedExact` 第三参；**禁止** helper 默认 `operation = 'unknown'`；**禁止**把合法 operation 输入的 unresolved 期望写成 `decision.operation === 'unknown'`。

Suite sketch（**每个** `assertUnresolvedExact` 必须显式第三参；全文不得省略）：

```js
describe('resolveSupervisorLifecycleGuardedRunnerRegistry', () => {
  it('R1–R4: resolves all four operations against code-owned mappings', () => {
    for (const operation of ['install', 'uninstall', 'rollback', 'recover']) {
      const candidates = validRegistryCandidatesFor(operation);
      assertResolved(
        resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, operation),
        operation,
        candidates,
      );
    }
  });

  it('R5: unknown actionId is runner-registry-action-unknown (not candidates-invalid)', () => {
    const candidates = validRegistryCandidatesFor('install');
    candidates[2] = validRegistryCandidate('start-recovery-supervisor', 1);
    assertUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
      'runner-registry-action-unknown',
      'install', // 合法 operation 回显；禁止默认/省略第三参
    );
  });

  it('R6: length < |E| with subset actionIds is missing (not candidates-invalid)', () => {
    const candidates = validRegistryCandidatesFor('install').slice(0, 2);
    assert.strictEqual(candidates.length, 2);
    assertUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
      'runner-registry-action-missing',
      'install',
    );
  });

  it('R7: duplicate actionId is runner-registry-action-duplicate', () => {
    const candidates = validRegistryCandidatesFor('install');
    candidates[1] = validRegistryCandidate('render-launch-agent-plist', 1);
    assertUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
      'runner-registry-action-duplicate',
      'install',
    );
  });

  it('R8: legal-format non-catalog implementationId is unresolved', () => {
    const candidates = validRegistryCandidatesFor('install');
    candidates[0] = { ...candidates[0], implementationId: 'other-plist-impl' };
    assertUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
      'runner-registry-implementation-mismatch',
      'install',
    );
  });

  it('R9: wrong runnerKind is runner-kind-mismatch', () => {
    const candidates = validRegistryCandidatesFor('install');
    candidates[0] = { ...candidates[0], runnerKind: 'other-stub' };
    assertUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
      'runner-registry-runner-kind-mismatch',
      'install',
    );
  });

  it('R10: wrong mode is mode-mismatch', () => {
    const candidates = validRegistryCandidatesFor('install');
    candidates[0] = { ...candidates[0], mode: 'unguarded' };
    assertUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
      'runner-registry-mode-mismatch',
      'install',
    );
  });

  for (const maxAttempts of [0, 4, 1.5, '1']) {
    it(`R11: maxAttempts=${String(maxAttempts)} is max-attempts-invalid`, () => {
      const candidates = validRegistryCandidatesFor('install');
      candidates[0] = { ...candidates[0], maxAttempts };
      assertUnresolvedExact(
        resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
        'runner-registry-max-attempts-invalid',
        'install',
      );
    });
  }

  it('R12: layered fail-closed — helper accepts [redacted], resolver rejects', () => {
    const candidates = validRegistryCandidatesFor('install');
    candidates[0] = { ...candidates[0], maxAttempts: '[redacted]' };
    assert.strictEqual(
      areSupervisorLifecycleGuardedRunnerActionCandidatesReady(candidates, 'install'),
      true,
    );
    assertUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
      'runner-registry-max-attempts-invalid',
      'install',
    );
  });

  it('R13: accessor own props is candidates-invalid', () => {
    const base = validRegistryCandidate('render-launch-agent-plist', 1);
    const poisoned = {};
    for (const key of Object.keys(base)) {
      Object.defineProperty(poisoned, key, {
        enumerable: true,
        configurable: true,
        get() {
          return base[key];
        },
      });
    }
    const candidates = [poisoned, ...validRegistryCandidatesFor('install').slice(1)];
    assertUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
      'runner-registry-candidates-invalid',
      'install',
    );
  });

  it('R14: trap throw is candidates-invalid without secret leak', () => {
    const base = validRegistryCandidate('render-launch-agent-plist', 1);
    const trapped = new Proxy(base, {
      getOwnPropertyDescriptor() {
        throw new Error(UNSAFE_SECRET_MATERIAL);
      },
    });
    const candidates = [trapped, ...validRegistryCandidatesFor('install').slice(1)];
    const decision = resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install');
    assertUnresolvedExact(decision, 'runner-registry-candidates-invalid', 'install');
    assert.doesNotMatch(JSON.stringify(decision), new RegExp(UNSAFE_SECRET_MATERIAL, 'i'));
  });

  for (const candidates of [null, 'not-array', 42, { length: 1 }]) {
    it(`R15: type-confusion ${String(candidates)} is candidates-invalid`, () => {
      assertUnresolvedExact(
        resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
        'runner-registry-candidates-invalid',
        'install', // operation 合法；candidates 非法 → 仍回显 install
      );
    });
  }

  it('R16: sensitive-like unknown keys is candidates-invalid without leak', () => {
    const candidates = validRegistryCandidatesFor('install');
    candidates[0] = { ...candidates[0], OPAQUE_UNSAFE_FIELD: UNSAFE_SECRET_MATERIAL };
    const decision = resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install');
    assertUnresolvedExact(decision, 'runner-registry-candidates-invalid', 'install');
    assert.doesNotMatch(JSON.stringify(decision), new RegExp(UNSAFE_SECRET_MATERIAL, 'i'));
  });

  it('R17: invalid operation is operation-invalid with decision.operation unknown', () => {
    const candidates = validRegistryCandidatesFor('install');
    assertUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'apply-all'),
      'runner-registry-operation-invalid',
      'unknown', // 唯一允许 expected operation 'unknown' 的调用点
    );
  });

  it('R18a: wouldRun true is side-effect-flag-invalid', () => {
    const candidates = validRegistryCandidatesFor('install');
    candidates[0] = { ...candidates[0], wouldRun: true };
    assertUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
      'runner-registry-side-effect-flag-invalid',
      'install',
    );
  });

  it('R18b: status ready is side-effect-flag-invalid', () => {
    const candidates = validRegistryCandidatesFor('install');
    candidates[0] = { ...candidates[0], status: 'ready' };
    assertUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
      'runner-registry-side-effect-flag-invalid',
      'install',
    );
  });

  it('R19: input/output immutability — returned decision and subsequent resolve are isolated', () => {
    const candidates = validRegistryCandidatesFor('install');
    const first = resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install');
    assertResolved(first, 'install', candidates);
    candidates[0] = { ...candidates[0], actionId: 'start-recovery-supervisor' };
    first.operation = 'unknown'; // 污染已返回 decision 不得影响后续
    const second = resolveSupervisorLifecycleGuardedRunnerRegistry(
      validRegistryCandidatesFor('install'),
      'install',
    );
    assertResolved(second, 'install', validRegistryCandidatesFor('install'));
    // 若后续测 unresolved 路径，第三参仍必须显式（例：assertUnresolvedExact(..., 'install')）
    const third = resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install');
    assertUnresolvedExact(third, 'runner-registry-action-unknown', 'install');
  });

  it('R20: install fixture implementationIds and maxAttempts 2/1/3 remain compatible', () => {
    const candidates = [
      validRegistryCandidate('render-launch-agent-plist', 2),
      validRegistryCandidate('write-launch-agent-plist', 1),
      validRegistryCandidate('load-launch-agent', 3),
    ];
    assertResolved(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
      'install',
      candidates,
    );
  });

  it('R21: array Proxy container trap is candidates-invalid without secret leak', () => {
    const raw = validRegistryCandidatesFor('install');
    const candidates = new Proxy([...raw], {
      get(t, p, r) {
        if (p === 'length' || (typeof p === 'string' && /^\d+$/.test(p))) {
          throw new Error(UNSAFE_SECRET_MATERIAL);
        }
        return Reflect.get(t, p, r);
      },
    });
    const decision = resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install');
    assertUnresolvedExact(decision, 'runner-registry-candidates-invalid', 'install');
    assert.doesNotMatch(JSON.stringify(decision), new RegExp(UNSAFE_SECRET_MATERIAL, 'i'));
  });

  // R22：每 case 独立 fresh candidates，避免 table 首行 mutation 污染下一行
  for (const { label, actionId } of [
    { label: 'empty-string', actionId: '' },
    { label: 'number', actionId: 1 },
  ]) {
    it(`R22: ${label} actionId is candidates-invalid before set checks`, () => {
      const candidates = validRegistryCandidatesFor('install'); // fresh per case
      candidates[0] = { ...candidates[0], actionId };
      assertUnresolvedExact(
        resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
        'runner-registry-candidates-invalid',
        'install', // 合法 operation 回显；禁止 'unknown'
      );
    });
  }

  // R23：|A|>|E| 外来 id → unknown；独立 fresh，禁止污染共享数组；不得 candidates-invalid
  it('R23: length > |E| with foreign actionId is unknown (not candidates-invalid)', () => {
    const candidates = validRegistryCandidatesFor('install'); // fresh local array
    candidates.push(validRegistryCandidate('start-recovery-supervisor', 1));
    assert.strictEqual(candidates.length, 4);
    assertUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
      'runner-registry-action-unknown',
      'install', // 合法 operation 回显；禁止 'unknown' / 禁止 candidates-invalid
    );
  });

  // R24：|A|>|E| 重复 install id → duplicate；独立 fresh；不得 candidates-invalid
  it('R24: length > |E| with duplicate install actionId is duplicate (not candidates-invalid)', () => {
    const candidates = validRegistryCandidatesFor('install'); // fresh local array
    candidates.push(validRegistryCandidate('render-launch-agent-plist', 1));
    assert.strictEqual(candidates.length, 4);
    assertUnresolvedExact(
      resolveSupervisorLifecycleGuardedRunnerRegistry(candidates, 'install'),
      'runner-registry-action-duplicate',
      'install', // 合法 operation 回显；禁止 'unknown' / 禁止 candidates-invalid
    );
  });
});
```

#### Exact test matrix — readiness (RED)

```js
describe('buildSupervisorLifecycleGuardedRunnerRegistryReadiness', () => {
  it('returns fixed ready code-owned registry readiness evidence', () => {
    const readiness = buildSupervisorLifecycleGuardedRunnerRegistryReadiness();
    assert.strictEqual(readiness.command, 'supervisor-lifecycle-guarded-runner-registry-readiness');
    assert.strictEqual(readiness.state, 'ready');
    assert.strictEqual(readiness.runnerRegistryDefined, true);
    assert.strictEqual(readiness.runnerRegistryReady, true);
    assert.strictEqual(readiness.codeOwnedRegistryResolverReady, true);
    assert.strictEqual(readiness.realRunnerImplementationsReady, false);
    assert.strictEqual(readiness.readyCount, 1);
    assert.strictEqual(readiness.blockedCount, 0);
    assert.deepStrictEqual(readiness.blockers, []);
    assert.deepStrictEqual(readiness.nextBlockers, []);
    assert.deepStrictEqual(readiness.registryEntries, EXPECTED_RUNNER_REGISTRY_ENTRIES);
    assert.deepStrictEqual(readiness.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
    assert.doesNotMatch(
      JSON.stringify(readiness),
      /runner-registry-real-implementation-missing|runner-registry-missing/i,
    );
  });

  it('ignores all runtime-looking inputs and never leaks malicious registry material', () => {
    const baseline = buildSupervisorLifecycleGuardedRunnerRegistryReadiness();
    const maliciousInput = {
      runnerRegistryReady: false,
      realRunnerImplementationsReady: true,
      registryEntries: [
        {
          runnerKind: UNSAFE_SECRET_MATERIAL,
          wouldExecute: true,
          wouldRun: true,
          wouldWrite: true,
        },
      ],
      OPAQUE_UNSAFE_FIELD: UNSAFE_SECRET_MATERIAL,
    };
    assert.deepStrictEqual(
      buildSupervisorLifecycleGuardedRunnerRegistryReadiness(maliciousInput),
      baseline,
    );
    assert.deepStrictEqual(buildSupervisorLifecycleGuardedRunnerRegistryReadiness(null), baseline);
    assert.doesNotMatch(JSON.stringify(baseline), new RegExp(UNSAFE_SECRET_MATERIAL, 'i'));
  });
});
```

#### Wiring contract — 迁移现有 `assertWiringContract` helper 本体（RED；禁止只改 fixture）

**文件：** `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

**必须改 helper 本体**（现约 L446–490 `function assertWiringContract(contract)`），**不得**只改 `EXPECTED_WIRING_CONTRACTS` fixture 而留下 helper 内 `readyCount:1` / `blockedCount:5` / `slice(1)` 全 blocked / `runner-registry` blocked。

**历史（V1.18/V1.24，非当前 V1.25 pure/gate 期望）：** `readyCount:1` / `blockedCount:5`；`requiredContracts.slice(1)` 全 blocked；`runner-registry` 为 blocked + `runner-registry-missing`。对照可保留于注释，但 **不得**写成当前断言。

**helper 现有全部调用点（改本体后自动覆盖；禁止只改个别 it）：**

| 约行 | 调用点 | 说明 |
| --- | --- | --- |
| L776 | `assertWiringContract(contract)` | pure `buildSupervisorLifecycleGuardedRunnerWiringContract` |
| L834 | `assertWiringContract(result.runnerWiringContract)` | gate ready + `executeRequested:false` |
| L884 | `assertWiringContract(result.runnerWiringContract)` | gate `executeRequested:true` |
| L913 | `assertWiringContract(result.runnerWiringContract)` | production deny / policy path |
| 本 plan 后续 gate 示例 | `assertWiringContract(...)` | 同 helper；body 迁移即覆盖 |

**可执行迁移骨架（替换 helper 本体；保留原有 command/state/safety/下游 readiness deepEqual 结构）：**

```js
function assertWiringContract(contract) {
  assert.strictEqual(contract.command, 'supervisor-lifecycle-guarded-runner-wiring-contract');
  assert.strictEqual(contract.state, 'blocked');
  assert.strictEqual(contract.realRunnerWiringReady, false);
  // V1.25 aggregate：2 ready / 4 blocked（历史 1/5 已废止）
  assert.strictEqual(contract.readyCount, 2);
  assert.strictEqual(contract.blockedCount, 4);
  assert.deepStrictEqual(contract.nextBlockers, ['real-guarded-runner-execution-wiring-missing']);
  assert.ok(contract.blockers.includes('real-guarded-runner-execution-wiring-missing'));
  assert.deepStrictEqual(contract.safety, EXPECTED_EXECUTION_PREVIEW_SAFETY);
  assert.strictEqual(contract.requiredContracts.length, 6);
  // requiredContracts map exact EXPECTED_WIRING_CONTRACTS（含 runner-registry ready 行）
  assert.deepStrictEqual(
    contract.requiredContracts.map((entry) => [
      entry.id,
      entry.blockerCode,
      entry.status,
      entry.evidenceCode,
    ]),
    EXPECTED_WIRING_CONTRACTS,
  );

  // contract[0] execution-policy ready（保留）
  const policyContract = contract.requiredContracts[0];
  assert.strictEqual(policyContract.id, 'execution-policy');
  assert.strictEqual(policyContract.status, 'ready');
  assert.strictEqual(policyContract.blockerCode, null);
  assert.strictEqual(policyContract.evidenceCode, 'execution-policy-ready');

  // contract[1] runner-registry → V1.25 ready/null/runner-registry-ready
  // （历史：blocked + runner-registry-missing — 非当前期望）
  const registryContract = contract.requiredContracts[1];
  assert.strictEqual(registryContract.id, 'runner-registry');
  assert.strictEqual(registryContract.status, 'ready');
  assert.strictEqual(registryContract.blockerCode, null);
  assert.strictEqual(registryContract.evidenceCode, 'runner-registry-ready');

  // 后四：仅 slice(2) blocked + requiredForExecution + nonempty blocker
  // 绝不得 slice(1)（那会把已 ready 的 runner-registry 误扫成 blocked）
  assert.ok(contract.requiredContracts.slice(2).every((entry) =>
    entry.status === 'blocked' &&
      entry.requiredForExecution === true &&
      typeof entry.blockerCode === 'string' &&
      entry.blockerCode.length > 0));

  assert.deepStrictEqual(
    contract.executionPolicyReadiness,
    buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness(),
  );

  // registry readiness：deepEqual ready builder（优先）——自动带 exact ready schema
  assert.deepStrictEqual(
    contract.runnerRegistryReadiness,
    buildSupervisorLifecycleGuardedRunnerRegistryReadiness(),
  );
  // 与 ready builder 等价的 exact 字段（实现时可 deepEqual-only，但字段语义必须成立）：
  assert.strictEqual(contract.runnerRegistryReadiness.state, 'ready');
  assert.strictEqual(contract.runnerRegistryReadiness.runnerRegistryReady, true);
  assert.strictEqual(contract.runnerRegistryReadiness.codeOwnedRegistryResolverReady, true);
  assert.strictEqual(contract.runnerRegistryReadiness.realRunnerImplementationsReady, false);

  assert.deepStrictEqual(
    contract.hostMutationAdapterReadiness,
    buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness(),
  );
  assert.deepStrictEqual(
    contract.rollbackAnchorReadiness,
    buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness(),
  );
  assert.deepStrictEqual(
    contract.attemptAuditReadiness,
    buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness(),
  );
  assert.deepStrictEqual(
    contract.operatorRecoveryReadiness,
    buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness(),
  );
}
```

**同步：** `EXPECTED_WIRING_CONTRACTS[1]` 必须为 `['runner-registry', null, 'ready', 'runner-registry-ready']`（见 Task 1 Fixtures）。fixture + helper 本体 **两者都改**；只改其一 = 未完成。

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

Expected: **RED**（fixture/helper 已写 V1.25 期望，实现未就绪）。

- [ ] **Step 2: Implement pure resolver + readiness + wiring (GREEN)**

In `src/supervisor-lifecycle.js`:

1. Constants: `RUNNER_REGISTRY_READY_EVIDENCE`、`RUNNER_REGISTRY_MAPPING_READY_EVIDENCE`、`CODE_OWNED_RUNNER_REGISTRY_KIND`、`RUNNER_REGISTRY_BLOCKER_CODES`（spec §1.6，**无** mismatch/extra 删除项）、`CODE_OWNED_ACTION_IMPLEMENTATION_MAP`
2. Ready registry entry（`codeOwnedResolverWired:true`）
3. `GUARDED_RUNNER_WIRING_CONTRACTS[1]` → ready + null blockerCode
4. wiring aggregate `readyCount:2` / `blockedCount:4`
5. 容器 best-effort 快照 + 元素 exact-key snapshot（spec §1.4）
6. Export resolver + JSDoc
7. Rewrite readiness（spec §2.2）
8. Internal `sanitizeRegistryDecision`
9. **Do not** return functions/commands/paths/hosts/tokens/hashes/raw errors
10. **Do not** set `realRunnerImplementationsReady:true` or any would* true
11. **Do not** change V1.24 `areSupervisorLifecycleGuardedRunnerActionCandidatesReady` maxAttempts rules
12. **decision.operation**：allowlisted 输入在 resolved/unresolved 均回显；**仅** operation-invalid 输出 `'unknown'`（与 assertUnresolvedExact 第三参矩阵一致）

In `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`（与 Step 1 RED 配套，不得跳过）：

1. `EXPECTED_WIRING_CONTRACTS` fixture 已含 runner-registry ready 行
2. **`assertWiringContract` helper 本体**已按上方可执行骨架迁移（readyCount 2 / blockedCount 4 / map exact / contract[1] ready / **slice(2)** / readiness ready schema）
3. 全部既有调用点（L776/L834/L884/L913）靠 helper 本体自动覆盖，**禁止**只改个别 it 内联断言

- [ ] **Step 3: Re-run pure tests**

```bash
node --check src/supervisor-lifecycle.js
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

Expected: pure + readiness + wiring **GREEN**；gate integration 可能仍 RED until Task 2.

---

### Task 2: Execution Gate Production Wiring

**Files:**
- Modify: `src/supervisor-lifecycle.js`
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`

- [ ] **Step 1: Write failing gate tests (RED)**

| ID | Case | Assert（exact） |
| --- | --- | --- |
| G1 | ready install + `executeRequested:true` | `gates.runnerRegistryReady===true`；`registryDecision.state==='resolved'`；`registryDecision.registryReady===true`；`codeOwnedResolverWired===true`；`registryDecision`/candidate/readiness entry would* false（**无** gate 顶层 wouldRun/wouldWrite） |
| G2 | policy still denied | `policyDecision.state==='denied'`；blockers 含后四 not-ready；**不含** `runner-registry-not-ready`；`primaryBlocker==='host-mutation-adapter-not-ready'` |
| G3 | executionEligible false | gate 顶层 `executionEligible:false`、`wouldExecute:false`；`executorReady`/`realRunnerWiringReady` false；`policyDecision.wouldRun/wouldWrite:false` |
| G4 | empty candidates path | empty sanitized candidates → `gates.runnerRegistryReady===false`；`registryDecision.state==='unresolved'`；`primaryBlocker==='runner-registry-candidates-invalid'`（empty array）；policy 含 **`runner-registry-not-ready`** |
| G5 | ignore forged options | `options.registryDecision` / `options.runnerRegistryReady` / `options.registryContext` 忽略；仍由本地 resolver 决定 |
| G6 | actionCandidatesReady + registryReady | production ready path 两者均可 true，policy 仍 deny |
| G7 | pure consistency | gate 输出 `registryDecision` 与对 `gate.actionCandidates` 直接调 pure resolver 的 state/registryReady/mappings ids 一致 |
| G8 | **non-catalog implementationId production gate** | `getReadyInputs()` + 浅拷贝 `executionPreview` + map `actionPreviews` 仅首项 `implementationId:'other-plist-impl'`（**不**污染共享 fixture；**禁止**未定义 helper）：`actionCandidatesReady===true`；`registryDecision` unresolved + **`runner-registry-implementation-mismatch`**；`gates.runnerRegistryReady===false`；policy 含 **`runner-registry-not-ready`**；`result.executionEligible:false`、`result.wouldExecute:false`；`policyDecision.wouldRun/wouldWrite:false`；`registryDecision.wouldExecute/wouldRun/wouldWrite:false`；`actionCandidates` 每项 would* false；readiness entry would* false（**禁止** `result.wouldRun`/`result.wouldWrite`） |
| G9 | **redacted maxAttempts layered gate** | `getReadyInputs()` + 浅拷贝 preview + 首项 `maxAttempts:99` → 现有 `sanitizeExecutionPreviewMaxAttempts` 产出 `'[redacted]'`（**production gate 必测**；pure R12 **不能**替代）：helper structural true；`registryDecision` unresolved + **`runner-registry-max-attempts-invalid`**；`gates.runnerRegistryReady===false`；policy 含 **`runner-registry-not-ready`**；gate 顶层 `executionEligible/wouldExecute:false`；policy/registry/candidate would* false |

#### `assertAlwaysBlockedGate` 动态语义（**禁止**恒 `runnerRegistryReady:false` / 恒 `true`）

现有 helper（`test/supervisor-lifecycle-guarded-runner-execution-gate.test.js` ≈L403–444）硬编码：

```js
assert.strictEqual(result.gates.runnerRegistryReady, false);
```

V1.25 **不可**直接改成恒 `true`（empty / non-catalog / redacted / not-verified 路径仍为 false）。

**改造（二选一，实现时固定一种并全仓一致）：**

```js
// 方案 A（推荐）：显式参数，默认 false 保兼容失败路径
function assertAlwaysBlockedGate(result, { runnerRegistryReady = false } = {}) {
  // ... existing always-false side-effect / wiring aggregate asserts 保留：
  // gate 顶层：executionEligible / wouldExecute（**无** result.wouldRun / result.wouldWrite）
  // policyDecision.wouldRun / policyDecision.wouldWrite 仍恒 false
  // realRunnerWiringReady / runnerWiringContractReady / hostMutation* / rollback* /
  // attempt* / operator* 仍恒 false
  assert.strictEqual(result.gates.runnerRegistryReady, runnerRegistryReady);
  // 删除旧的硬编码 false；不得在 helper 内再断言恒 true
}

// 方案 B：从 helper 完全移除 runnerRegistryReady 断言，由各 test 显式 assert.strictEqual
```

**仍可由通用 helper 恒 false 的字段（按真实 schema locus）：**
gate 顶层 `executionEligible`、`wouldExecute`；`realRunnerWiringReady`、`runnerWiringContractReady`、后四 gates；`policyDecision.authorized` / `wouldAuthorizeExecution` / **`policyDecision.wouldRun` / `policyDecision.wouldWrite`**；safety 全套。
**禁止**在 helper 中断言不存在的 `result.wouldRun` / `result.wouldWrite`。

**`runnerRegistryReady` 期望矩阵（迁移必须）：**

| 场景 | `gates.runnerRegistryReady` | 说明 |
| --- | --- | --- |
| ready install + `executeRequested:true`（G1） | **true** | production-derived candidates resolve |
| ready install + `executeRequested:false` | **true** | execute 请求与 registry resolve 解耦；仍 resolve |
| empty candidates（G4） | **false** | |
| non-catalog implementationId（G8） | **false** | |
| redacted maxAttempts（G9） | **false** | |
| execution-preview not-verified / empty actionCandidates | **false** | |
| invalid manifest / runner-not-ready / preview mismatch / redaction path | **false** | candidates 不全/不合法 |

**必须迁移的现有 helper 调用点 / fixture / deepEqual（文件：`test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`）：**

| 位置（约） | 现状 | V1.25 动作 |
| --- | --- | --- |
| L403–415 `assertAlwaysBlockedGate` 本体 | 硬编码 `runnerRegistryReady:false` | 参数化或移除该断言 |
| L812–833 ready + `executeRequested:false` | `assertAlwaysBlockedGate` + `deepStrictEqual(gates, {… runnerRegistryReady:false })` | helper 传 `{ runnerRegistryReady: true }`；deepEqual 改 **true** |
| L872–881 ready + `executeRequested:true` | helper 后再 `assert.strictEqual(..., false)` | helper 传 true；删除/改写恒 false 再断言 true 的矛盾写法 |
| L892–914 production deny 测 | helper + policy 含 `runner-registry-not-ready` + primary 同码 | ready path：helper true；policy **不含** `runner-registry-not-ready`；primary=`host-mutation-adapter-not-ready` |
| L951 / L963 / L976 / L987 / L993 | invalid/mismatch 路径 `assertAlwaysBlockedGate` | 保持 default false |
| L1006 not-verified | helper + empty candidates | 保持 false |
| L1034 redaction | helper + redacted candidates | 保持 false；可叠加 G9 显式 false |
| API/CLI 共用 helper（`assertBlockedExecutionGate` / `assertBlockedGate`） | **（历史 V1.18/V1.24）** helper 本体硬编码 `gates.runnerRegistryReady:false`、`readyCount:1`/`blockedCount:5`、`slice(1)` 全 blocked、readiness blocked + `real-implementation-missing` entry | **禁止**单点 “L172/L192 false→true”。见 **Task 3**：helper 本体固定 wiring 2/4 + readiness ready + **必传** `{ runnerRegistryReady }` boolean；**全调用点参数化矩阵**（valid candidates → true；missing binding/empty → false）；`registryDecision` / `policyDecision.primaryBlocker` **不进**共用 helper |

**禁止：** 先调用恒 false 的 `assertAlwaysBlockedGate(result)` 再 `assert.strictEqual(result.gates.runnerRegistryReady, true)`。

Example:

```js
it('production ready inputs resolve registry but still deny via remaining wiring facts', () => {
  const result = buildGate(getReadyInputs(), { executeRequested: true });
  // 显式传 true；不得先用恒 false helper
  assertAlwaysBlockedGate(result, { runnerRegistryReady: true });
  assert.strictEqual(result.gates.runnerRegistryReady, true);
  assert.strictEqual(result.gates.executionPolicyReady, true);
  assert.strictEqual(result.gates.actionCandidatesReady, true);
  assert.strictEqual(result.registryDecision.state, 'resolved');
  assert.strictEqual(result.registryDecision.registryReady, true);
  assert.strictEqual(result.registryDecision.codeOwnedResolverWired, true);
  assert.strictEqual(result.registryDecision.realHostRunnerReady, false);
  assert.strictEqual(result.registryDecision.wouldExecute, false);
  assert.strictEqual(result.registryDecision.wouldRun, false);
  assert.strictEqual(result.registryDecision.wouldWrite, false);
  assert.strictEqual(result.policyDecision.state, 'denied');
  assert.strictEqual(result.policyDecision.primaryBlocker, 'host-mutation-adapter-not-ready');
  assert.strictEqual(result.policyDecision.wouldRun, false);
  assert.strictEqual(result.policyDecision.wouldWrite, false);
  for (const code of [
    'host-mutation-adapter-not-ready',
    'rollback-anchor-not-ready',
    'attempt-audit-not-ready',
    'operator-recovery-not-ready',
  ]) {
    assert.ok(result.policyDecision.blockers.includes(code));
  }
  assert.ok(!result.policyDecision.blockers.includes('runner-registry-not-ready'));
  // gate 顶层仅 executionEligible / wouldExecute（禁止 result.wouldRun / result.wouldWrite）
  assert.strictEqual(result.executionEligible, false);
  assert.strictEqual(result.wouldExecute, false);
  for (const c of result.actionCandidates) {
    assert.strictEqual(c.wouldExecute, false);
    assert.strictEqual(c.wouldRun, false);
    assert.strictEqual(c.wouldWrite, false);
  }
  assertWiringContract(result.runnerWiringContract);
  assert.strictEqual(result.runnerWiringContract.readyCount, 2);
  assert.strictEqual(result.runnerWiringContract.blockedCount, 4);
});

it('ready install + executeRequested:false still resolves registryReady true', () => {
  const result = buildGate(getReadyInputs(), { executeRequested: false });
  assertAlwaysBlockedGate(result, { runnerRegistryReady: true });
  assert.ok(result.blockers.includes('execute-request-missing'));
  assert.strictEqual(result.gates.runnerRegistryReady, true);
  assert.strictEqual(result.gates.executeRequested, false);
  assert.strictEqual(result.registryDecision.state, 'resolved');
  // deepStrictEqual gates 时 runnerRegistryReady 必须为 true（迁移 L817–833）
});

// G8：production 构造必须可运行；禁止 getReadyInputsWithImplementationId 等未定义 helper
// 禁止原地污染 getReadyInputs() 返回的共享 fixture 引用
it('G8: non-catalog implementationId keeps registry not ready and fail-closed', () => {
  const base = getReadyInputs();
  const inputs = {
    ...base,
    executionPreview: {
      ...base.executionPreview,
      actionPreviews: base.executionPreview.actionPreviews.map((entry, index) =>
        index === 0
          ? { ...entry, implementationId: 'other-plist-impl' }
          : { ...entry },
      ),
    },
  };
  const result = buildGate(inputs, { executeRequested: true });
  assertAlwaysBlockedGate(result, { runnerRegistryReady: false });
  assert.strictEqual(result.gates.actionCandidatesReady, true);
  assert.strictEqual(result.registryDecision.state, 'unresolved');
  assert.strictEqual(
    result.registryDecision.primaryBlocker,
    'runner-registry-implementation-mismatch',
  );
  assert.strictEqual(result.gates.runnerRegistryReady, false);
  assert.ok(result.policyDecision.blockers.includes('runner-registry-not-ready'));
  // gate 顶层
  assert.strictEqual(result.executionEligible, false);
  assert.strictEqual(result.wouldExecute, false);
  // policy / registry / candidates locus（禁止 result.wouldRun / result.wouldWrite）
  assert.strictEqual(result.policyDecision.wouldRun, false);
  assert.strictEqual(result.policyDecision.wouldWrite, false);
  assert.strictEqual(result.registryDecision.wouldExecute, false);
  assert.strictEqual(result.registryDecision.wouldRun, false);
  assert.strictEqual(result.registryDecision.wouldWrite, false);
  for (const c of result.actionCandidates) {
    assert.strictEqual(c.wouldExecute, false);
    assert.strictEqual(c.wouldRun, false);
    assert.strictEqual(c.wouldWrite, false);
  }
  const readiness = result.runnerWiringContract.runnerRegistryReadiness;
  // readiness 固定 ready evidence 仍可 true；gate fact 已 false
  assert.strictEqual(readiness.state, 'ready');
  assert.strictEqual(readiness.runnerRegistryReady, true);
  assert.strictEqual(readiness.codeOwnedRegistryResolverReady, true);
  assert.strictEqual(readiness.realRunnerImplementationsReady, false);
  for (const entry of readiness.registryEntries) {
    assert.strictEqual(entry.wouldExecute, false);
    assert.strictEqual(entry.wouldRun, false);
    assert.strictEqual(entry.wouldWrite, false);
  }
});

// G9：必须走 production gate；不得“或纯单测”逃逸；pure R12 仍保留但不能替代本测
// maxAttempts:99 → 现有 sanitizeExecutionPreviewMaxAttempts 产出 '[redacted]'
it('G9: redacted maxAttempts layered production gate fail-closed', () => {
  const base = getReadyInputs();
  const inputs = {
    ...base,
    executionPreview: {
      ...base.executionPreview,
      actionPreviews: base.executionPreview.actionPreviews.map((entry, index) =>
        index === 0
          ? { ...entry, maxAttempts: 99 }
          : { ...entry },
      ),
    },
  };
  const result = buildGate(inputs, { executeRequested: true });
  assertAlwaysBlockedGate(result, { runnerRegistryReady: false });
  // helper structural true（V1.24 契约接受 [redacted]）
  assert.strictEqual(result.gates.actionCandidatesReady, true);
  assert.strictEqual(
    areSupervisorLifecycleGuardedRunnerActionCandidatesReady(result.actionCandidates, 'install'),
    true,
  );
  assert.strictEqual(result.actionCandidates[0].maxAttempts, '[redacted]');
  // resolver max-attempts-invalid
  assert.strictEqual(result.registryDecision.state, 'unresolved');
  assert.strictEqual(
    result.registryDecision.primaryBlocker,
    'runner-registry-max-attempts-invalid',
  );
  // runnerRegistryReady false + policy runner-registry-not-ready
  assert.strictEqual(result.gates.runnerRegistryReady, false);
  assert.ok(result.policyDecision.blockers.includes('runner-registry-not-ready'));
  assert.strictEqual(result.executionEligible, false);
  assert.strictEqual(result.wouldExecute, false);
  assert.strictEqual(result.policyDecision.wouldRun, false);
  assert.strictEqual(result.policyDecision.wouldWrite, false);
  assert.strictEqual(result.registryDecision.wouldExecute, false);
  assert.strictEqual(result.registryDecision.wouldRun, false);
  assert.strictEqual(result.registryDecision.wouldWrite, false);
  for (const c of result.actionCandidates) {
    assert.strictEqual(c.wouldExecute, false);
    assert.strictEqual(c.wouldRun, false);
    assert.strictEqual(c.wouldWrite, false);
  }
  const readiness = result.runnerWiringContract.runnerRegistryReadiness;
  assert.strictEqual(readiness.state, 'ready');
  assert.strictEqual(readiness.runnerRegistryReady, true);
  assert.strictEqual(readiness.realRunnerImplementationsReady, false);
  for (const entry of readiness.registryEntries) {
    assert.strictEqual(entry.wouldExecute, false);
    assert.strictEqual(entry.wouldRun, false);
    assert.strictEqual(entry.wouldWrite, false);
  }
});
```

- [ ] **Step 2: Wire gate (GREEN)**

```js
const registryDecision = sanitizeRegistryDecision(
  resolveSupervisorLifecycleGuardedRunnerRegistry(actionCandidates, operation),
);

const runnerRegistryReadiness = runnerWiringContract.runnerRegistryReadiness;
const runnerRegistryReady =
  runnerRegistryReadiness?.runnerRegistryReady === true &&
  runnerRegistryReadiness?.codeOwnedRegistryResolverReady === true &&
  runnerRegistryReadiness?.state === 'ready' &&
  runnerRegistryReadiness?.realRunnerImplementationsReady === false &&
  registryDecision?.registryReady === true &&
  registryDecision?.state === 'resolved' &&
  registryDecision?.codeOwnedResolverWired === true &&
  registryDecision?.realHostRunnerReady === false &&
  registryDecision?.wouldExecute === false &&
  registryDecision?.wouldRun === false &&
  registryDecision?.wouldWrite === false;

// policyContext.runnerRegistryReady = runnerRegistryReady === true
// return { ..., registryDecision, gates: { ..., runnerRegistryReady } }
```

- [ ] **Step 3: Re-run gate tests**

```bash
node --test --test-reporter=spec test/supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

Expected: **GREEN** pure + gate.

---

### Task 3: API / CLI Passthrough（共用 helper 参数化 + 全调用点矩阵）

**Files:**
- Modify: `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js`（改造 **`assertBlockedExecutionGate`**）
- Modify: `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js`（改造 **`assertBlockedGate`**）
- Do **not** modify `src/server.js` / `src/agent.js`

**冲突（本 Task 要消解）：**

| 层 | 语义 | 能否放进共用 helper |
| --- | --- | --- |
| wiring aggregate | **固定** `readyCount:2` / `blockedCount:4`；`requiredContracts[1]` ready；`slice(2)` 后四 blocked | **是** — 所有 200/成功 JSON 路径一致 |
| readiness builder | **固定** `state:'ready'`、`runnerRegistryReady:true`、`codeOwnedRegistryResolverReady:true`、`realRunnerImplementationsReady:false`、ready entry exact | **是** — readiness ≠ gate fact |
| `gates.runnerRegistryReady` | **动态** — valid catalog candidates → true；missing binding / empty candidates → false | **是，但必须参数化** — 不得恒 false/恒 true |
| `registryDecision.state` / `registryReady` | 随 candidates 成败变化 | **否** — 专属 `it` |
| `policyDecision.primaryBlocker` | ready+execute+approval → `host-mutation-adapter-not-ready`；no-approval / no-execute 等各异 | **否** — 专属 `it` |

**历史（V1.18/V1.24，不得再当 V1.25 当前预期）：** helper 硬编码 `gates.runnerRegistryReady:false`、`readyCount:1`/`blockedCount:5`、`requiredContracts.slice(1)` 全 blocked、readiness `state:'blocked'` + `registryEntries` deepEqual disabled/`runner-registry-real-implementation-missing`。

#### Gate fact 规则（与 design §4 / Task 2 一致）

- **true**：valid install manifest + valid runnerBinding（catalog match + numeric maxAttempts），candidates 可构造且 resolver resolved — **不论** `executeRequested` true/false、approval ready/not ready。
- **false（本仓库 API/CLI 实测已有或本版明确覆盖）**：missing `runnerBinding`（API：empty candidates）；invalid binding/manifest 走 **400/exit1** 固定错误（**不**经共用 blocked helper）。pure/gate 的 empty / not-verified / non-catalog / redacted 失败路径由 Task 2 G4/G8/G9 覆盖，**不**要求 API/CLI 重复造 production 构造（除非后续新增专用 it）。

#### 语义调用矩阵 — API（`assertBlockedExecutionGate(body, { runnerRegistryReady })`）

仓库现状：`assertBlockedExecutionGate` 仅用于 **HTTP 200 + gate JSON** 路径（400 错误路径不走 helper）。

| # | 现有 `it`（语义） | candidates / catalog | executeRequested | approval | 调用 |
| --- | --- | --- | --- | --- | --- |
| A1 | valid inline metadata without creating approval storage | valid manifest+binding → 可 resolve | false（默认） | 无 | `assertBlockedExecutionGate(body, { runnerRegistryReady: true })` |
| A2 | honors persisted approval + executeRequested，仍 blocked | valid → resolve | true | ready | `assertBlockedExecutionGate(body, { runnerRegistryReady: true })` |
| A3 | ignores forged policyContext/policyDecision | valid → resolve | true | ready | `assertBlockedExecutionGate(body, { runnerRegistryReady: true })` |
| A4 | allows read token（read-only endpoint） | valid → resolve | false | 无 | `assertBlockedExecutionGate(body, { runnerRegistryReady: true })` |
| A5 | missing runnerBinding → no action candidates | missing binding → empty/unresolved | false | 无 | `assertBlockedExecutionGate(body, { runnerRegistryReady: false })` |
| A6 | ignores submitted approval/dataDir/apply/… | valid → resolve | false | 提交的 approval **忽略**（gate 仍 not-ready） | `assertBlockedExecutionGate(body, { runnerRegistryReady: true })` |

**不得**漏传 `{ runnerRegistryReady }`；**不得**依赖默认 false 掩盖漏传。

#### 语义调用矩阵 — CLI（`assertBlockedGate(report, { runnerRegistryReady })`）

仓库现状：三条成功 JSON 路径均使用 valid manifest+binding；invalid config/manifest/binding 走 exit 1，**不**经 helper。

| # | 现有 `it`（语义） | candidates / catalog | executeRequested | approval | 调用 |
| --- | --- | --- | --- | --- | --- |
| C1 | prints sanitized blocked gate for valid inputs | valid → resolve | false | ready（persisted） | `assertBlockedGate(report, { runnerRegistryReady: true })` |
| C2 | accepts `--execute-requested` as intent only | valid → resolve | true | ready | `assertBlockedGate(report, { runnerRegistryReady: true })` |
| C3 | `--fail-on-blocked` exits 2 + parseable blocked JSON | valid → resolve | false | ready | `assertBlockedGate(report, { runnerRegistryReady: true })` |

CLI 当前无 “missing runnerBinding 仍打印 gate JSON” 的 helper 路径；保持 exit 1 错误语义，**不要**为凑矩阵伪造不存在的调用点。

#### 专属 `it` 断言（**禁止**放进共用 helper）

| 场景 | 专属断言（在对应 `it` 内，helper 之后） |
| --- | --- |
| A2 / C2：ready + execute + approval | `registryDecision.state==='resolved'`、`registryDecision.registryReady===true`、`codeOwnedResolverWired===true`、decision would* false；`policyDecision.primaryBlocker==='host-mutation-adapter-not-ready'`；policy blockers **不含** `runner-registry-not-ready`；含后四 `*-not-ready` |
| A1 / A6：no approval | `blockers` 含 `approval-record-gate-not-ready`；`gates.approvalRecordReady===false`（primary **不**由 helper 固定） |
| A1 / C1 / C3：no execute | `blockers` 含 `execute-request-missing` 或 `gates.executeRequested===false`（与现测一致） |
| A5：missing runnerBinding | `gates.runnerBindingsReady===false`；`actionCandidates.length===0`；`gates.runnerRegistryReady===false`（已由 helper 参数表达）；policy 可含 `runner-registry-not-ready`（专属，非 helper） |
| A3：forged override | 仍 denied / not eligible；secret 不泄漏（现有） |
| C3 | exit code 2（现有 `runAgentExpectExit`） |

- [ ] **Step 1: 改造两个共用 helper 本体 + fixture（RED 期望对齐 V1.25）**

两文件各定义（与 Task 1 `EXPECTED_RUNNER_REGISTRY_ENTRIES` **exact 同形**，可本地复制；禁止继续 deepEqual disabled/`real-implementation-missing` entry）：

```js
// API + CLI 测试文件均可本地复用（与 Task 1 fixture exact 对齐）
const EXPECTED_RUNNER_REGISTRY_ENTRIES = Object.freeze([
  {
    registryKind: 'code-owned-runner-registry',
    runnerKind: 'guarded-runner-stub',
    state: 'ready',
    codeOwnedResolverWired: true,
    realHostRunnerReady: false,
    realImplementationReady: false,
    supportsHostMutation: false,
    wouldExecute: false,
    wouldRun: false,
    wouldWrite: false,
    blockerCode: null,
    evidenceCode: 'runner-registry-ready',
  },
]);
```

##### API helper skeleton（`body` = `postJSON` 解析体）

**必传**严格 boolean：无默认值；漏传 → `typeof` 断言失败。

```js
/**
 * 共用 blocked-gate 不变量。gates.runnerRegistryReady 随场景变化，必须显式传入。
 * 不得在此断言 registryDecision.state/registryReady 或 policyDecision.primaryBlocker。
 */
function assertBlockedExecutionGate(body, { runnerRegistryReady }) {
  assert.strictEqual(typeof runnerRegistryReady, 'boolean');

  assert.strictEqual(body.command, 'supervisor-lifecycle-guarded-runner-execution-gate');
  assert.strictEqual(body.operation, 'install');
  assert.strictEqual(body.state, 'blocked');
  assert.strictEqual(body.executionGateState, 'blocked');
  assert.strictEqual(body.executionEligible, false);
  assert.strictEqual(body.executorReady, false);
  assert.strictEqual(body.wouldExecute, false);
  // 禁止 body.wouldRun / body.wouldWrite（gate 顶层无此字段）

  assert.strictEqual(body.gates.executionPolicyReady, true);
  assert.strictEqual(body.gates.realRunnerWiringReady, false);
  assert.strictEqual(body.gates.runnerWiringContractReady, false);
  assert.strictEqual(body.gates.runnerRegistryReady, runnerRegistryReady); // 动态
  assert.strictEqual(body.gates.hostMutationAdapterReady, false);
  assert.strictEqual(body.gates.rollbackAnchorReady, false);
  assert.strictEqual(body.gates.attemptAuditReady, false);
  assert.strictEqual(body.gates.operatorRecoveryReady, false);
  assert.strictEqual(body.realRunnerWiringReady, false);

  assert.deepStrictEqual(body.nextBlockers, ['real-guarded-runner-execution-wiring-missing']);
  assert.ok(body.blockers.includes('real-guarded-runner-execution-wiring-missing'));

  assert.strictEqual(body.runnerWiringContract.command, 'supervisor-lifecycle-guarded-runner-wiring-contract');
  assert.strictEqual(body.runnerWiringContract.state, 'blocked');
  assert.strictEqual(body.runnerWiringContract.realRunnerWiringReady, false);
  assert.strictEqual(body.runnerWiringContract.readyCount, 2);
  assert.strictEqual(body.runnerWiringContract.blockedCount, 4);
  assert.deepStrictEqual(body.runnerWiringContract.nextBlockers, ['real-guarded-runner-execution-wiring-missing']);

  // execution-policy contract[0] 仍 ready（既有）
  assert.strictEqual(body.runnerWiringContract.requiredContracts[0].status, 'ready');
  assert.strictEqual(body.runnerWiringContract.requiredContracts[0].blockerCode, null);
  assert.strictEqual(body.runnerWiringContract.requiredContracts[0].evidenceCode, 'execution-policy-ready');

  // runner-registry contract[1] → V1.25 ready（历史 slice(1) 全 blocked 已废止）
  assert.strictEqual(body.runnerWiringContract.requiredContracts[1].id, 'runner-registry');
  assert.strictEqual(body.runnerWiringContract.requiredContracts[1].status, 'ready');
  assert.strictEqual(body.runnerWiringContract.requiredContracts[1].blockerCode, null);
  assert.strictEqual(body.runnerWiringContract.requiredContracts[1].evidenceCode, 'runner-registry-ready');
  assert.strictEqual(body.runnerWiringContract.requiredContracts[1].requiredForExecution, true);

  // 后四：slice(2) — 不得 slice(1)
  assert.ok(body.runnerWiringContract.requiredContracts.slice(2).every((entry) =>
    entry.status === 'blocked' && entry.requiredForExecution === true));

  assert.deepStrictEqual(
    body.runnerWiringContract.requiredContracts.map((entry) => entry.id),
    ['execution-policy', 'runner-registry', 'host-mutation-adapter', 'rollback-anchor', 'attempt-audit', 'operator-recovery'],
  );

  // readiness 固定 ready evidence（≠ gates.runnerRegistryReady）
  const readiness = body.runnerWiringContract.runnerRegistryReadiness;
  assert.strictEqual(readiness.command, 'supervisor-lifecycle-guarded-runner-registry-readiness');
  assert.strictEqual(readiness.state, 'ready');
  assert.strictEqual(readiness.runnerRegistryDefined, true);
  assert.strictEqual(readiness.runnerRegistryReady, true);
  assert.strictEqual(readiness.codeOwnedRegistryResolverReady, true);
  assert.strictEqual(readiness.realRunnerImplementationsReady, false);
  assert.deepStrictEqual(readiness.registryEntries, EXPECTED_RUNNER_REGISTRY_ENTRIES);
  // 删除：state:'blocked' / nextBlockers real-implementation-missing / disabled entry deepEqual

  // policy 仍 denied + would* false；primaryBlocker / registryDecision 不在此断言
  assert.strictEqual(body.policyDecision.state, 'denied');
  assert.strictEqual(body.policyDecision.authorized, false);
  assert.strictEqual(body.policyDecision.wouldAuthorizeExecution, false);
  assert.strictEqual(body.policyDecision.wouldRun, false);
  assert.strictEqual(body.policyDecision.wouldWrite, false);

  // 后四 readiness 仍 blocked（保留既有 would* false 断言）
  assert.strictEqual(body.runnerWiringContract.hostMutationAdapterReadiness.state, 'blocked');
  assert.strictEqual(body.runnerWiringContract.rollbackAnchorReadiness.state, 'blocked');
  assert.strictEqual(body.runnerWiringContract.attemptAuditReadiness.state, 'blocked');
  assert.strictEqual(body.runnerWiringContract.operatorRecoveryReadiness.state, 'blocked');

  assert.strictEqual(body.safety.readOnly, true);
  assert.strictEqual(body.safety.lifecycleApplied, false);
  assert.strictEqual(body.safety.filesystemWritten, false);
  assert.strictEqual(body.safety.auditEventWritten, false);
  assert.strictEqual(body.safety.metadataWritten, false);
}
```

##### CLI helper skeleton（`report` = `JSON.parse(stdout)`）

与 API **同规则**；变量名为 `report`；CLI 既有 `actionCandidates.length===3` / `safety.dryRun` 等 **仅在本文件全部 helper 调用点仍成立时** 保留（当前 C1–C3 均为 valid binding）。若未来增加 empty-candidates CLI 路径，须把 candidates 长度断言移出 helper。

```js
function assertBlockedGate(report, { runnerRegistryReady }) {
  assert.strictEqual(typeof runnerRegistryReady, 'boolean');

  assert.strictEqual(report.command, 'supervisor-lifecycle-guarded-runner-execution-gate');
  assert.strictEqual(report.operation, 'install');
  assert.strictEqual(report.state, 'blocked');
  assert.strictEqual(report.executionGateState, 'blocked');
  assert.strictEqual(report.executionEligible, false);
  assert.strictEqual(report.executorReady, false);
  assert.strictEqual(report.wouldExecute, false);

  assert.strictEqual(report.gates.executionPolicyReady, true);
  assert.strictEqual(report.gates.realRunnerWiringReady, false);
  assert.strictEqual(report.gates.runnerWiringContractReady, false);
  assert.strictEqual(report.gates.runnerRegistryReady, runnerRegistryReady);
  assert.strictEqual(report.gates.hostMutationAdapterReady, false);
  assert.strictEqual(report.gates.rollbackAnchorReady, false);
  assert.strictEqual(report.gates.attemptAuditReady, false);
  assert.strictEqual(report.gates.operatorRecoveryReady, false);
  assert.strictEqual(report.realRunnerWiringReady, false);

  assert.deepStrictEqual(report.nextBlockers, ['real-guarded-runner-execution-wiring-missing']);
  assert.ok(report.blockers.includes('real-guarded-runner-execution-wiring-missing'));

  assert.strictEqual(report.runnerWiringContract.readyCount, 2);
  assert.strictEqual(report.runnerWiringContract.blockedCount, 4);
  assert.strictEqual(report.runnerWiringContract.requiredContracts[1].id, 'runner-registry');
  assert.strictEqual(report.runnerWiringContract.requiredContracts[1].status, 'ready');
  assert.strictEqual(report.runnerWiringContract.requiredContracts[1].blockerCode, null);
  assert.strictEqual(report.runnerWiringContract.requiredContracts[1].evidenceCode, 'runner-registry-ready');
  assert.ok(report.runnerWiringContract.requiredContracts.slice(2).every((entry) =>
    entry.status === 'blocked' && entry.requiredForExecution === true));

  const readiness = report.runnerWiringContract.runnerRegistryReadiness;
  assert.strictEqual(readiness.state, 'ready');
  assert.strictEqual(readiness.runnerRegistryReady, true);
  assert.strictEqual(readiness.codeOwnedRegistryResolverReady, true);
  assert.strictEqual(readiness.realRunnerImplementationsReady, false);
  assert.deepStrictEqual(readiness.registryEntries, EXPECTED_RUNNER_REGISTRY_ENTRIES);

  assert.strictEqual(report.policyDecision.state, 'denied');
  assert.strictEqual(report.policyDecision.authorized, false);
  assert.strictEqual(report.policyDecision.wouldAuthorizeExecution, false);
  assert.strictEqual(report.policyDecision.wouldRun, false);
  assert.strictEqual(report.policyDecision.wouldWrite, false);
  // 不得 assert report.registryDecision.state / report.policyDecision.primaryBlocker

  // CLI 当前全部 helper 调用点仍为 valid 3 candidates（C1–C3）
  assert.strictEqual(report.actionCandidates.length, 3);
  assert.ok(report.actionCandidates.every((entry) =>
    entry.status === 'blocked' &&
      entry.wouldExecute === false &&
      entry.wouldRun === false &&
      entry.wouldWrite === false));

  assert.strictEqual(report.safety.readOnly, true);
  assert.strictEqual(report.safety.dryRun, true);
  assert.strictEqual(report.safety.lifecycleApplied, false);
  // ...保留既有 launchctlCalled/processListRead 等 safety false 断言
}
```

- [ ] **Step 2: 按矩阵改写全部 helper 调用点 + 专属 it 断言**

API 示例：

```js
// A1 — valid，无 approval，无 execute → gate fact true
assertBlockedExecutionGate(body, { runnerRegistryReady: true });
assert.ok(body.blockers.includes('approval-record-gate-not-ready'));
assert.ok(body.blockers.includes('execute-request-missing'));
// 不得在此要求 primaryBlocker === host-mutation-adapter-not-ready

// A2 — ready + execute + approval → gate fact true；decision/primary 仅此 it
assertBlockedExecutionGate(body, { runnerRegistryReady: true });
assert.strictEqual(body.registryDecision.state, 'resolved');
assert.strictEqual(body.registryDecision.registryReady, true);
assert.strictEqual(body.registryDecision.codeOwnedResolverWired, true);
assert.strictEqual(body.registryDecision.wouldExecute, false);
assert.strictEqual(body.registryDecision.wouldRun, false);
assert.strictEqual(body.registryDecision.wouldWrite, false);
assert.strictEqual(body.policyDecision.primaryBlocker, 'host-mutation-adapter-not-ready');
assert.ok(!body.policyDecision.blockers.includes('runner-registry-not-ready'));
for (const code of [
  'host-mutation-adapter-not-ready',
  'rollback-anchor-not-ready',
  'attempt-audit-not-ready',
  'operator-recovery-not-ready',
]) {
  assert.ok(body.policyDecision.blockers.includes(code));
}

// A5 — missing runnerBinding → gate fact false
assertBlockedExecutionGate(body, { runnerRegistryReady: false });
assert.strictEqual(body.gates.runnerBindingsReady, false);
assert.strictEqual(body.actionCandidates.length, 0);
```

CLI 示例：

```js
// C1 / C3
assertBlockedGate(report, { runnerRegistryReady: true });
assert.ok(report.blockers.includes('execute-request-missing')); // C1/C3 语义

// C2
assertBlockedGate(report, { runnerRegistryReady: true });
assert.ok(!report.blockers.includes('execute-request-missing'));
assert.strictEqual(report.registryDecision.state, 'resolved');
assert.strictEqual(report.registryDecision.registryReady, true);
assert.strictEqual(report.policyDecision.primaryBlocker, 'host-mutation-adapter-not-ready');
```

**禁止：**
- 单点 “L172/L192：`false`→`true`” 当作完整迁移
- helper 内 `runnerRegistryReady = false` 默认掩盖漏传
- helper 固定 `registryDecision` resolved/unresolved 或 `primaryBlocker`
- 继续 `readyCount:1` / `blockedCount:5` / `slice(1)` 全 blocked / readiness blocked / real-implementation-missing entry 作为 **当前** V1.25 期望

- [ ] **Step 3: Run API/CLI tests**

```bash
node --test --test-reporter=spec \
  test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js \
  test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js
```

Expected: **GREEN** without server/agent source changes。A1–A6 / C1–C3 矩阵列全；helper 参数无默认漏传。

---

### Task 4: Web Strict Canonical Fail-Closed Assembly

**Files:**
- Modify: `src/web/app.js`
- Modify: `test/web-console.test.js`

- [ ] **Step 1: Write failing Web tests (RED)**

**共享单一 canonical predicate（design §5.2；wiring / registry / validation 同源）：**

```js
function isCanonicalRunnerRegistryReady({ C, R, G, D }) {
  return (
    C?.status === 'ready' &&
    C?.blockerCode === null &&
    C?.evidenceCode === 'runner-registry-ready' &&
    C?.requiredForExecution === true &&
    R?.state === 'ready' &&
    R?.runnerRegistryReady === true &&
    R?.codeOwnedRegistryResolverReady === true &&
    R?.realRunnerImplementationsReady === false &&
    G === true &&
    D?.state === 'resolved' &&
    D?.registryReady === true &&
    D?.codeOwnedResolverWired === true &&
    D?.realHostRunnerReady === false &&
    D?.wouldExecute === false &&
    D?.wouldRun === false &&
    D?.wouldWrite === false
  );
}
// wiring line ready ⇔ registry line ready ⇔ validation runnerRegistryReady:true
// ⇔ isCanonicalRunnerRegistryReady(...) === true
// 否则 wiring 固定 blocked+runner-registry-missing；registry 固定 blocked+runner-registry-not-ready；
// validation runnerRegistryReady:false
```

Canonical registry ready line（exact）:

```text
runnerRegistry:code-owned-runner-registry:state:ready:codeOwnedResolverWired:true:realHostRunnerReady:false:wouldExecute:false:blocker:none
```

Canonical registry blocked line（exact）:

```text
runnerRegistry:code-owned-runner-registry:state:blocked:codeOwnedResolverWired:true:realHostRunnerReady:false:wouldExecute:false:blocker:runner-registry-not-ready
```

Canonical wiring ready / blocked（exact）:

```text
wiringContract:runner-registry:status:ready:requiredForExecution:true:blocker:none
wiringContract:runner-registry:status:blocked:requiredForExecution:true:blocker:runner-registry-missing
```

| ID | Case | Assert |
| --- | --- | --- |
| W1 | full canonical ready payload（C∧R∧G∧D 全真） | wiring ready 行 + registry ready 行 + `runnerRegistryReady:true` |
| W2 | registry ready line | 含上表 **ready** 行（必须含 `realHostRunnerReady:false` 与 `wouldExecute:false`） |
| W3 | validationLines ready | `runnerRegistryReady:true` **当且仅当** canonical true；仍有 `executionEligible:false` 与后四 false |
| W4 | malicious / contradictory payload | C blocked / R false / G true 矛盾 / secret 注入 → wiring **blocked** + registry **blocked** + validation false；**无** ready 行；**不**泄漏 secret；后四仍 canonical blocked |
| W5 | missing registryDecision | 缺 `D` → canonical false；wiring blocked；registry blocked；`runnerRegistryReady:false` |
| W6 | four remaining contracts | 始终 blocked canonical lines；payload 标 ready 无效 |
| W7 | policyDecision | 仍强制 denied；primaryBlocker allowlisted |
| W8 | error/unknown | `runnerRegistryReady:false`；无信任型 ready/authorized 泄漏 |
| W9 | distinguishable lines | `candidate:` / `wiringContract:` / `runnerRegistry:` / `executionPolicy:` / `policyDecision:` 可区分 |
| W10 | ready line never implies execute | ready 行 **必须** match `/realHostRunnerReady:false/` 与 `/wouldExecute:false/` |
| W11 | C/R/G 表面 ready、D resolved 但 `D.wouldRun=true`（side-effect 漂移） | wiring blocked + `runner-registry-missing`；registry blocked + `runner-registry-not-ready`；validation `runnerRegistryReady:false`；后四 blocked；敏感/恶意值不回显；全文无任何 runner-registry/runnerRegistry ready 行 |

W4 malicious fixture（opaque only；C 故意 blocked 以测矛盾）：

```js
{
  gates: {
    runnerRegistryReady: true,
    hostMutationAdapterReady: false,
    rollbackAnchorReady: false,
    attemptAuditReady: false,
    operatorRecoveryReady: false,
    executionEligible: false,
  },
  runnerWiringContract: {
    requiredContracts: [
      {
        id: 'execution-policy',
        status: 'ready',
        blockerCode: null,
        evidenceCode: 'execution-policy-ready',
        requiredForExecution: true,
      },
      {
        id: 'runner-registry',
        status: 'blocked',
        blockerCode: 'runner-registry-missing',
        evidenceCode: 'x',
        requiredForExecution: true,
      },
      {
        id: 'host-mutation-adapter',
        status: 'ready',
        blockerCode: null,
        evidenceCode: 'fake',
        requiredForExecution: true,
      },
      // ...rollback/attempt/operator similarly try ready — must render blocked
    ],
    runnerRegistryReadiness: {
      state: 'ready',
      runnerRegistryReady: false,
      codeOwnedRegistryResolverReady: true,
      realRunnerImplementationsReady: false,
      registryEntries: [
        {
          runnerKind: UNSAFE_SECRET_MATERIAL,
          wouldExecute: true,
          wouldRun: true,
          OPAQUE_UNSAFE_FIELD: UNSAFE_SECRET_MATERIAL,
        },
      ],
    },
  },
  registryDecision: {
    state: 'resolved',
    registryReady: true,
    codeOwnedResolverWired: true,
    realHostRunnerReady: false,
    wouldExecute: false,
    wouldRun: true,
    wouldWrite: false,
  },
  policyDecision: {
    state: 'authorized',
    authorized: true,
    wouldAuthorizeExecution: true,
    wouldRun: true,
  },
}
```

W11 exact fixture（C/R/G 表面 ready，仅 D.wouldRun 漂移）：

```js
{
  gates: {
    runnerRegistryReady: true,
    hostMutationAdapterReady: false,
    rollbackAnchorReady: false,
    attemptAuditReady: false,
    operatorRecoveryReady: false,
    executionEligible: false,
  },
  runnerWiringContract: {
    requiredContracts: [
      {
        id: 'execution-policy',
        status: 'ready',
        blockerCode: null,
        evidenceCode: 'execution-policy-ready',
        requiredForExecution: true,
      },
      {
        id: 'runner-registry',
        status: 'ready',
        blockerCode: null,
        evidenceCode: 'runner-registry-ready',
        requiredForExecution: true,
      },
      // 后四 payload 即使标 ready 也必须渲染 blocked
    ],
    runnerRegistryReadiness: {
      state: 'ready',
      runnerRegistryReady: true,
      codeOwnedRegistryResolverReady: true,
      realRunnerImplementationsReady: false,
    },
  },
  registryDecision: {
    state: 'resolved',
    registryReady: true,
    codeOwnedResolverWired: true,
    realHostRunnerReady: false,
    wouldExecute: false,
    wouldRun: true, // side-effect flag 漂移 → canonical false
    wouldWrite: false,
  },
}
```

W11 Assert（exact，禁止 “X 或 Y”）：

- rendered text **不含** `wiringContract:runner-registry:status:ready`
- rendered text **不含** `runnerRegistry:code-owned-runner-registry:state:ready`
- **含** `wiringContract:runner-registry:status:blocked:requiredForExecution:true:blocker:runner-registry-missing`
- **含** `runnerRegistry:code-owned-runner-registry:state:blocked:...:blocker:runner-registry-not-ready`
- validationLines：`runnerRegistryReady:false`
- 后四仍 missing blocked
- policyDecision still denied
- 无 `UNSAFE_SECRET_MATERIAL` / 恶意 would* 原文回显

- [ ] **Step 2: Implement Web assembly (GREEN)**

In `src/web/app.js`:

1. 实现 **单一** `isCanonicalRunnerRegistryReady`（或等价内部 helper）；**删除**任何“与 execution-policy 同模式仅看 contract 字段”“至少 wiring line 用 contract 字段”的放宽路径。
2. Remove `runner-registry` from `WIRING_CONTRACT_CANONICAL_MISSING_BLOCKERS`。
3. wiring line：`canonical===true` → ready 行；否则 **固定** blocked + `runner-registry-missing`（不回显 payload blocker）。
4. `buildSupervisorLifecycleGuardedRunnerRegistryLines`：**同一** `canonical` boolean；ready/blocked 两行 exact；**永不**从 payload 抄 wouldExecute/state/blocker 原文。
5. `validationLines.runnerRegistryReady`：**同一** `canonical` boolean（**禁止**仅 `gates.runnerRegistryReady===true`）。
6. 不新增 buttons/endpoints/request fields。
7. policyDecision 仍 forced denied。

- [ ] **Step 3: Run Web tests**

```bash
node --check src/web/app.js
node --test --test-reporter=spec test/web-console.test.js
```

Expected: **GREEN**.

---

### Task 5: Version / README / Gold / No-Side-Effect Assertions

**Files:**
- Modify: `src/version.js`
- Modify: `README.md`
- Modify: `src/gold-readiness.js`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `test/readme.test.js`
- Optionally extend gate test for source no-side-effect scans

- [ ] **Step 1: RED version/readme/gold expectations**

- `LINKE_RELEASE_VERSION === 'V1.25'`
- README title / current version / version table row for V1.25
- Gold evidence includes：`resolveSupervisorLifecycleGuardedRunnerRegistry`、`runnerRegistryReadiness.state:ready`、`runnerRegistryReady:true`、`codeOwnedRegistryResolverReady:true`、`codeOwnedResolverWired`、`realRunnerImplementationsReady:false`、`runner-registry-ready`、`registryDecision`、`executionEligible:false`
- Gold evidence **does not** list `runner-registry-real-implementation-missing` / `runner-registry-missing` as current gap
- nextStep mentions host-mutation-adapter
- G0a PASS wording unchanged
- Gold status remains `blocked`

No-side-effect（gate test 或既有 pattern）：

- registry 相关函数不引入 `child_process` / launchctl / net / `fs.write` / exec
- decision JSON 不含 command/path/token shapes
- 变更文件 ⊆ 允许列表（见 Task 6）

- [ ] **Step 2: GREEN version/docs updates**

- `src/version.js` → `V1.25`
- README：当前版本段落、版本表、安全边界、测试覆盖同步 V1.25
- `src/gold-readiness.js` evidence + nextStep
- 测试期望同步

- [ ] **Step 3: Run version/gold/readme tests**

```bash
node --test --test-reporter=spec \
  test/version.test.js test/gold-readiness.test.js test/readme.test.js
```

---

### Task 6: Full Verification + 无写入 Scope 核对

- [ ] **Step 1: Focused + full**

```bash
node --check src/supervisor-lifecycle.js
node --check src/web/app.js
git diff --check
node --test --test-reporter=spec \
  test/supervisor-lifecycle-guarded-runner-execution-gate.test.js \
  test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js \
  test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js \
  test/web-console.test.js
node --test --test-reporter=spec \
  test/version.test.js test/gold-readiness.test.js test/readme.test.js
npm test
```

- [ ] **Step 2: 无写入 anchor / allowlist 核对（禁止 actual-changes.txt；禁止 hard reset 步骤）**

```bash
# 1) 恢复锚点是当前 HEAD 祖先
git merge-base --is-ancestor 1d7f9a2 HEAD && echo anchor-ok

# 2) 列出相对锚点的变更文件，人工 ⊆ 允许列表
git diff --name-only 1d7f9a2 --
git status --short

# 3) 禁止文件必须无 diff
git diff --name-only 1d7f9a2 -- src/agent.js src/server.js package.json
# 期望：无输出
```

若允许列表外文件出现：停止；仅回退越界文件或（有 rg 证据时）更新设计允许列表。**不要** `git reset --hard`。

- [ ] **Step 3: Confirm invariants**

| Check | Expected |
| --- | --- |
| version | V1.25 |
| export resolve... | present, pure |
| readiness | ready + `codeOwnedRegistryResolverReady:true` + `realRunnerImplementationsReady:false` |
| decision field | `codeOwnedResolverWired:true` |
| wiring | 2 / 4 |
| production runnerRegistryReady | true on ready install |
| G8/G9 fail-closed | registry not ready + `runner-registry-not-ready` |
| production policy | denied, primary host-mutation-adapter-not-ready |
| side effects | false |
| agent/server/package | unmodified |
| Gold / G0a | blocked / PASS |
| blocker vocabulary | no operation-mismatch / action-extra |

---

## TDD Order Summary

1. **RED** pure R1–R24 + readiness + wiring（含 R5/R6/R23/R24 集合类 ≠ candidates-invalid：R6 `len<|E|` → missing；R23 `len>|E|` 外来 id → unknown；R24 `len>|E|` 重复 id → duplicate；长度不等式本身永不 candidates-invalid；R22 `''`/number actionId → candidates-invalid；assertResolved 全字段；`assertUnresolvedExact` 第三参必传；**迁移 `assertWiringContract` 本体** 2/4 + slice(2) + readiness ready，覆盖全部调用点）
2. **GREEN** resolver/readiness/wiring in `supervisor-lifecycle.js`
3. **RED** gate G1–G9（G8/G9 必须 production 可运行构造；pure R8/R12 不可替代）+ 迁移 `assertAlwaysBlockedGate` 参数化（ready true / empty·redacted·non-catalog false）
4. **GREEN** gate integrate resolver + local boolean
5. **RED→GREEN** API/CLI：改造 `assertBlockedExecutionGate` / `assertBlockedGate` 必传 `{ runnerRegistryReady }` + 全调用点矩阵（valid→true / missing binding→false）；decision/primary 仅专属 it（不改 agent/server 源码）
6. **RED** Web W1–W11 共享单一 canonical predicate
7. **GREEN** Web assembly（wiring/registry/validation 同源 boolean）
8. **RED→GREEN** version/README/Gold
9. **Verify** focused + `npm test` + 无写入 merge-base/diff 允许列表

---

## Scope File List（rg 实证；实现阶段仅这些）

### Allowed

- `src/supervisor-lifecycle.js`
- `src/web/app.js`
- `test/supervisor-lifecycle-guarded-runner-execution-gate.test.js`
- `test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js`
- `test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js`
- `test/web-console.test.js`
- `src/version.js`
- `README.md`
- `src/gold-readiness.js`
- `test/version.test.js`
- `test/gold-readiness.test.js`
- `test/readme.test.js`

### Forbidden

- `src/agent.js`
- `src/server.js`
- `package.json` / lockfiles
- new endpoints / CLI commands / Web buttons / request body fields
- host mutation / runner dispatch / network / fs write paths

全量 `npm test` 为兜底；间接失败时不得猜测扩 scope。

---

## Non-Goals

- 后四 wiring 真实实现
- launchctl / shell / process list / fs / NAS / network
- `executionEligible` 或 Gold ready
- `realRunnerImplementationsReady:true`
- 修改 V1.24 actionCandidates helper 契约
- 真实 recovery supervisor 执行
- 不可达 blocker 词汇（operation-mismatch / action-extra）

---

## Completion Criteria

1. Pure matrix R1–R24 全绿；失败类单一 exact blocker；`|A|≠|E|` 不进 candidates-invalid；pure 必覆盖两侧长度：R6 `len<|E|` → missing；R23 `len>|E|` 外来 id → unknown；R24 `len>|E|` 重复 id → duplicate（三者锁定分类，均不得 candidates-invalid）；R5 unknown / R6 missing 单一一致；R22 `''`/number → candidates-invalid 先于集合类；`assertUnresolvedExact` 第三参必传（合法 operation 回显；**仅 R17** expected `'unknown'`）
2. Readiness ready + `realRunnerImplementationsReady:false` + `codeOwnedRegistryResolverReady:true`
3. Decision / entry 使用 `codeOwnedResolverWired`；mapping 行全字段含 `supportsHostMutation:false` + input snapshot exact `maxAttempts`（1..3）
4. Wiring 2/4；runner-registry ready null-safe；**`assertWiringContract` helper 本体**（非仅 fixture）断言 readyCount 2 / blockedCount 4 / map exact EXPECTED / contract[1] ready / **slice(2)** 后四 blocked / readiness ready schema；全部既有调用点由 body 迁移覆盖
5. Gate 本地 boolean + sanitized `registryDecision`；G8/G9 **production** fail-closed（pure R8/R12 不可替代）；`assertAlwaysBlockedGate` 不再硬编码恒 false/true
6. Policy 仍 deny；各 locus 副作用 false；gate 顶层仅断言 `executionEligible`/`wouldExecute`（**禁止** `result.wouldRun`/`result.wouldWrite`）
7. API/CLI/Web 通过；API/CLI 共用 helper 固定 wiring 2/4 + readiness ready + 参数化 gate fact（**非**恒 true/false；**非**固定 primary/decision）；Web 共享单一 C∧R∧G∧D predicate；W11 side-effect 漂移双行 blocked；ready 行含 realHostRunnerReady:false + wouldExecute:false
8. Version V1.25；Gold blocked；G0a PASS
9. `npm test` green；`git diff --check` clean；merge-base 祖先 + name-only ⊆ 允许列表
10. agent/server/package 未修改

Do **not** commit or push unless the user explicitly requests it after review.
