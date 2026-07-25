# Linke V1.43 Audit Integrity Secure Rotation Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `V1.43 explicit crash-recoverable audit integrity rotation foundation`：仅显式触发、独立 rotation WAL、只增不减 archive bundle、journal v1→v2 跨代绑定、commit point 后确定性前滚、ordinary append 与 run-once monitor fail-closed gate。

**Architecture:** `src/audit-integrity-rotation-state.js` 只负责 canonical state/manifest 与安全读写；`src/audit-integrity-rotation.js` 在现有 same-root queue/lease/`lockf` 内编排 preflight、archive commit、cutover 与 explicit recovery；journal 模块保留 v1 语义并增加 homogeneous v2 builder/parser；dual-write 只增加 rotation gate 与无写 idle validator；monitor 先验证 rotation，再复用现有只读 dual-write inspector；Agent 只提供两个本地显式 CLI。

**Tech Stack:** Node.js ESM、`node:test`、`node:assert/strict`、`node:crypto` SHA-256、现有 `safe-data-files`、现有 queue/lease/`/usr/bin/lockf`。不增加 npm 依赖，不修改 lockfile。

**Design SoT:** `docs/superpowers/specs/2026-07-24-audit-integrity-secure-rotation-foundation-design.md`

## Global Constraints

- 唯一允许的完成签名：`V1.43 explicit crash-recoverable audit integrity rotation foundation`。
- 仍是 T6d.3 partial、production-hardening partial；Gold 保持 blocked `4/4/1/9`；不是 M6d Exit / Gold / GA / V2。
- 只允许显式库 API / Agent CLI；禁止自动阈值、timer、scheduler、HTTP/Web route、远程通知。
- archive product policy 是 append-only；不宣称 WORM、外部真实性、HMAC、签名或断电级持久化。
- manifest commit 前旧 live journal + old idle 是锚点；manifest commit 后只前滚，禁止删除或覆盖 archive。
- rotation WAL 优先于 dual-write WAL；两个 WAL 不得同时处于 nonterminal prepared 状态。
- 普通 append 不得自动恢复 rotation；monitor 永远只读。
- 所有 path/error/receipt 对外输出固定且脱敏；不返回绝对路径、errno、stack、raw event 或凭证。
- 不读取、修改、暂存或提交未跟踪的 `package-lock.json`。
- 每个代码 boundary 由 Grok 实现；GLM 做独立抗辩；Qwen 只读统计；Kimi 仅在全量实证后做 fresh closure review；Codex 复跑测试并作最终事实裁决。
- 每次 `git commit` / `git push` 都是独立人工门；未获得当次明确确认不得执行。

---

## Baseline and Allowed Files

当前设计提交与代码父提交：

```text
design HEAD = 7663df46905fb38313db1c617e357c7beae79993
V1.42 code base = 5051b0e5184f9da23ba6a101ba6869f985532dbd
branch = linke-v0.12-web-panel
remote = origin/linke-v0.12-web-panel
```

实现 allowlist：

```text
src/error-codes.js
src/audit-integrity-journal.js
src/audit-integrity-rotation-state.js
src/audit-integrity-rotation.js
src/audit-integrity-dual-write.js
src/audit-integrity-monitor.js
src/agent.js
src/version.js
src/gold-readiness.js
test/audit-integrity-journal.test.js
test/audit-integrity-rotation-state.test.js
test/audit-integrity-rotation-manifest.test.js
test/audit-integrity-rotation.test.js
test/audit-integrity-rotation-recovery.test.js
test/audit-integrity-rotation-multiprocess.test.js
test/helpers/audit-integrity-rotation-child.js
test/audit-integrity-rotation-gates.test.js
test/audit-integrity-monitor.test.js
test/agent-audit-integrity-rotation.test.js
test/audit-integrity-rotation-scans.test.js
test/audit-integrity-rotation-real-fs.test.js
test/error-codes.test.js
test/audit-integrity-dual-write-scans.test.js
test/version.test.js
test/gold-readiness.test.js
README.md
docs/superpowers/plans/2026-07-24-audit-integrity-secure-rotation-foundation.md
.superpowers/sdd/progress.md (operational ledger only; never stage or commit)
```

任何 allowlist 外改动立即 HOLD。每个 boundary 开始与结束运行：

```bash
git status --short --branch
git diff --name-only 5051b0e5184f9da23ba6a101ba6869f985532dbd
git diff --check
```

预期：只出现上述 allowlist；`.superpowers/sdd/progress.md` 是本轮 SDD 运行账本，因仓库未预置 ignore 而保持未跟踪且永不暂存/提交；`package-lock.json` 只允许继续显示为未跟踪，任何 worker 都不得打开它。

---

## Fixed Public and Internal Contracts

### Rotation state module

```js
export const AUDIT_INTEGRITY_ROTATION_STATE_RELATIVE_PATH =
  'audit/integrity-rotation-state.json';
export const AUDIT_INTEGRITY_ROTATION_STATE_MAX_BYTES = 131072;
export const AUDIT_INTEGRITY_ARCHIVE_MANIFEST_MAX_BYTES = 16384;

export class AuditIntegrityRotationError extends Error {}
export function parseAuditIntegrityRotationStateText(raw) {}
export function parseAuditIntegrityArchiveManifestText(raw) {}
export function buildAuditIntegrityArchiveManifest(fields) {}
export async function loadAuditIntegrityRotationStateUnlocked(resolvedRoot, lease) {}
export async function publishAuditIntegrityRotationStateUnlocked(resolvedRoot, lease, state) {}
export async function assertAuditIntegrityRotationAllowsAppendUnlocked(
  resolvedRoot,
  lease,
) {}
```

`parse*` 必须验证 plain object、exact key order、own enumerable data property、无 extra/symbol/accessor/Proxy、canonical raw identity、值域与跨字段关系；返回 deep-frozen plain data。`load*` exact missing 返回 `null`；oversize/safe I/O 映射 rotation IO；publish 超 128 KiB 映射 rotation bounds。

WAL 只允许保存 bounded parameters/fingerprints：`rotationEvent` 保存 strict event、exact `eventLineUtf8` 与 payload digest；`journal.previous/next` 和 `events.sealed/post` 只保存 count/length/SHA-256/head 等指纹。WAL 禁止保存 old/new journal raw、sealed events raw、events post raw 或 manifest raw。

Rotation event exact 值冻结为：

```js
const rotationEvent = Object.freeze({
  id: rotationId,
  createdAt,
  type: 'audit-integrity-rotation',
  outcome: 'committed',
  operation: 'generation-transition',
  message: 'audit integrity generation rotation committed',
});
```

`rotationId === rotationEvent.id`；`createdAt === rotationEvent.createdAt`；两者分别通过 UUID-like 与 strict ISO 校验。该 event 表达 manifest commit 后的 transition，不声称整个 CLI 已完成。

### Journal module additions

```js
export const AUDIT_INTEGRITY_JOURNAL_V2_OPEN_MAX_LINE_BYTES = 477;

export function verifyAuditIntegrityJournalText(raw) {}
export function buildAuditIntegrityV2GenerationImage(options) {}
```

`verifyAuditIntegrityJournalText` 是现有 `verifyRawJournal` 的 internal-exported replacement：v1 结果保持兼容，并增加 `schemaVersion` 与仅 v2 open 才有的 frozen `generationBinding`。`buildAuditIntegrityV2GenerationImage` 一次生成 open seq0 + rotation event-link seq1，并返回 frozen `{rawText, schemaVersion, generationId, recordCount, headDigest, eventPayloadDigest, rawByteLength, rawSha256, generationBinding}`。

### Dual-write module addition

```js
export async function validateAuditIntegrityDualWriteIdleUnlocked(
  resolvedRoot,
  lease,
) {}
```

该函数只接受 active same-root lease；state 必须已存在且为 idle；只调用既有 `validateIdleCursorAgainstStoresUnlocked`；禁止 bootstrap、recover、publish 或任何文件写入。

### Rotation coordinator and monitor

```js
export async function rotateAuditIntegrityGeneration(dataDir, options) {}
export async function recoverAuditIntegrityRotation(dataDir) {}
export async function inspectAuditIntegrityRotationReadOnly(dataDir) {}
```

Public rotate options exact keys 为 `expectedGenerationId, expectedHeadDigest`。成功 receipt exact keys/order：

```js
[
  'state',
  'rotationId',
  'previousGenerationId',
  'generationId',
  'archiveRelativePath',
  'archiveManifestDigest',
  'previousRecordCount',
  'newRecordCount',
  'relationship',
]
```

`state` 仅为 `rotated` / `already-completed`。monitor 新 condition code 为 `rotation-recovery-required`，其语义固定为 alert、`recoveryRequired:true`、`nextAction:'run-explicit-recovery'`、`relationship:null`；invalid/conflict 用 `integrity-alert`，I/O 用 `io-alert`。

---

## Exact 64-Test Ledger

以下编号是新增 `it(...)` 的闭集；实现中可以调整文件内排序，不得合并导致少于 64：

| IDs | Count | File | Exact coverage |
| --- | ---: | --- | --- |
| S1–S7 | 7 | `test/audit-integrity-rotation-state.test.js` | canonical prepared；5 statuses round-trip；key order/extra/symbol；Proxy/accessor；ID/digest/ISO；nested fingerprints；128 KiB/error mapping |
| J1–J6 | 6 | `test/audit-integrity-journal.test.js` | v1 vector unchanged；v2 open exact/digest/477；v2 event domain；v1+v2 reject；v2+v1 reject；v1 archive→v2 live binding |
| A1–A7 | 7 | `test/audit-integrity-rotation-manifest.test.js` | canonical manifest/digest；schema rejection；exclusive exact idempotency；journal mismatch；events absent snapshot；manifest-last commit；occupied leaf fail-closed |
| P1–P7 | 7 | `test/audit-integrity-rotation.test.js` | hostile options no write；nonterminal gate；dual state gate；expected mismatch；bounds pre-prepared；stale WAL vs manifest；ordered success/receipt |
| R1–R9 | 9 | `test/audit-integrity-rotation-recovery.test.js` | CP0–CP6；completed not self-proving；second recover idempotent |
| C1–C6 | 6 | `test/audit-integrity-rotation-multiprocess.test.js` | same-process rotate/append；rotate/rotate；recover/append；real-process rotate/append；real-process rotate/rotate；lock unavailable |
| G1–G7 | 7 | `test/audit-integrity-rotation-gates.test.js` + monitor test | missing allow；nonterminal append block；invalid/io block；completed match allow；completed mismatch block；monitor nonterminal read-only；completed+retention latest bundle |
| L1–L5 | 5 | `test/agent-audit-integrity-rotation.test.js` | rotate success；recover success；strict argv；typed exit 2；program exit 1/path-free stderr |
| Q1–Q4 | 4 | `test/audit-integrity-rotation-scans.test.js` | no auto/HTTP/Web/delete；import graph；error/receipt leak guards + 94 codes；V1.43 honesty surface |
| F1–F6 | 6 | `test/audit-integrity-rotation-real-fs.test.js` | byte/mode；EEXIST；real crash CP3；real crash CP4；real crash CP5/CP6；post-recovery append/archive permanence |
| **Total** | **64** | | |

---

## Task 0: Freeze Baseline and Build Effective-RED Harness

**Files:** no product edits.

- [ ] Confirm branch, HEAD, upstream and dirty files without reading `package-lock.json`.
- [ ] Record current release/error/test baselines.
- [ ] Confirm no existing rotation runtime exports.
- [ ] Create an isolated temporary worktree at `5051b0e...` only when the first complete set of new tests exists; copy/apply only test/helper diffs there.
- [ ] Effective RED is valid only when tests parse and fail because a required V1.43 export/behavior is absent. Missing fixture, bad path, syntax/import typo or timeout is not valid RED.

Commands:

```bash
git status --short --branch
git rev-parse HEAD HEAD^ origin/linke-v0.12-web-panel
node --input-type=module -e "import { LINKE_RELEASE_VERSION } from './src/version.js'; import { ERROR_CODES } from './src/error-codes.js'; console.log(LINKE_RELEASE_VERSION, Object.keys(ERROR_CODES).length)"
rg -n "rotateAuditIntegrityGeneration|integrity-rotation-state|audit-integrity-rotate" src test README.md --glob '!package-lock.json'
node --test test/audit-integrity-journal.test.js test/audit-integrity-dual-write.test.js test/audit-integrity-dual-write-state.test.js test/audit-integrity-cross-store.test.js test/audit-integrity-monitor.test.js test/audit-integrity-process-lock.test.js test/audit-integrity-multiprocess-lock.test.js test/agent-audit-integrity-monitor.test.js
```

Expected: `V1.42 88`；八个 selected files 静态 `it/test` 声明数为 437，当前 Node runtime 实测为 436/436 passing；runtime rotation search has no implementation。新增 64 项以 ledger ID 和静态声明双重计数，不把既有动态注册差异误报成回归。

No commit.

---

## Task 1: Journal v2 Homogeneous Generation Contract — J1–J6

**Files:**

- Modify: `src/audit-integrity-journal.js`
- Modify: `test/audit-integrity-journal.test.js`

- [ ] Add six named tests before implementation:
  - J1 `v1 canonical vectors and public receipts remain byte-for-byte unchanged`.
  - J2 `v2 generation-open has exact ten keys, 477 bytes, and independent digest`.
  - J3 `v2 event-link uses the v2 domain and verifies as a homogeneous generation`.
  - J4 `v1 open followed by v2 event-link is audit-chain-broken`.
  - J5 `v2 open followed by v1 event-link is audit-chain-broken`.
  - J6 `v1 archived head binds a separately built v2 live generation image`.
- [ ] Run J1–J6 and confirm behavior RED, not syntax RED.
- [ ] Split constants and canonical serializers for v1 open, v2 open and shared 7-key event records.
- [ ] Preserve v1 domains and exact public v1 receipts.
- [ ] Add v2 builder and verifier; enforce line-specific 374/477 limits and full-file 1,572,864/4097 limits.

Independent test vector:

```js
const DOMAIN_V2_OPEN =
  'linke.audit-integrity-journal.v2.generation-open\u0000';
const DOMAIN_V2_EVENT =
  'linke.audit-integrity-journal.v2.event-link\u0000';

function independentV2OpenDigest(v) {
  return createHash('sha256').update(
    DOMAIN_V2_OPEN
      + v.generationId + '\u0000'
      + v.previousGenerationId + '\u0000'
      + v.previousHeadDigest + '\u0000'
      + v.archiveManifestDigest + '\u0000'
      + '0\u0000null\u0000null',
  ).digest('hex');
}

it('J2 v2 generation-open has exact ten keys, 477 bytes, and independent digest', () => {
  const built = buildAuditIntegrityV2GenerationImage(FIXED_V2_OPTIONS);
  const [openLine] = built.rawText.trimEnd().split('\n');
  const open = JSON.parse(openLine);
  assert.deepEqual(Object.keys(open), [
    'schemaVersion', 'recordKind', 'generationId', 'previousGenerationId',
    'previousHeadDigest', 'archiveManifestDigest', 'sequence',
    'previousLinkDigest', 'payloadDigest', 'linkDigest',
  ]);
  assert.equal(open.schemaVersion, 2);
  assert.equal(open.sequence, 0);
  assert.equal(open.previousLinkDigest, null);
  assert.equal(open.payloadDigest, null);
  assert.equal(open.linkDigest, independentV2OpenDigest(open));
  assert.equal(Buffer.byteLength(openLine, 'utf8'), 477);
});
```

Implementation digest branch:

```js
function eventLinkDigest(schemaVersion, parts) {
  const domain = schemaVersion === 1
    ? 'linke.audit-integrity-journal.v1.event-link\u0000'
    : 'linke.audit-integrity-journal.v2.event-link\u0000';
  return sha256Hex(
    domain
      + parts.generationId + '\u0000'
      + String(parts.sequence) + '\u0000'
      + parts.previousLinkDigest + '\u0000'
      + parts.payloadDigest,
  );
}
```

- [ ] Run:

```bash
node --test test/audit-integrity-journal.test.js
node --test test/audit-integrity-journal-scans.test.js
```

Expected: all pass; old v1 fixtures remain unchanged; J1–J6 add exactly 6 tests.

Commit boundary C1, only after user confirmation: `feat: add audit journal generation v2`.

---

## Task 2: Rotation Errors, WAL and Manifest Schemas — S1–S7, A1–A2

**Files:**

- Create: `src/audit-integrity-rotation-state.js`
- Create: `test/audit-integrity-rotation-state.test.js`
- Create: `test/audit-integrity-rotation-manifest.test.js`
- Modify: `src/error-codes.js`
- Modify: `test/error-codes.test.js`
- Modify: `test/audit-integrity-dual-write-scans.test.js`

- [ ] Add six exact public codes after existing audit-integrity process-lock code:

```js
AUDIT_INTEGRITY_ROTATION_STATE_INVALID:
  'audit-integrity-rotation-state-invalid',
AUDIT_INTEGRITY_ROTATION_IO_ERROR:
  'audit-integrity-rotation-io-error',
AUDIT_INTEGRITY_ROTATION_PRECONDITION_FAILED:
  'audit-integrity-rotation-precondition-failed',
AUDIT_INTEGRITY_ROTATION_RECOVERY_REQUIRED:
  'audit-integrity-rotation-recovery-required',
AUDIT_INTEGRITY_ROTATION_CONFLICT:
  'audit-integrity-rotation-conflict',
AUDIT_INTEGRITY_ROTATION_BOUNDS_EXCEEDED:
  'audit-integrity-rotation-bounds-exceeded',
```

- [ ] Update both exact registry assertions from 88 to 94; preserve string-only/kebab/unique assertions.
- [ ] Add S1–S7 and A1–A2 before implementation. Tests must verify raw canonical identity, not only parsed values.
- [ ] Implement hostile-object-safe descriptor reading and exact nested key order.
- [ ] Keep rotation-state free of imports from coordinator, audit-log, agent and monitor.

Canonical status transition gate:

```js
const ROTATION_STATUS = new Set([
  'prepared',
  'archive-committed',
  'journal-published',
  'events-published',
  'completed',
]);

const ROTATION_TOP_KEYS = Object.freeze([
  'schemaVersion', 'status', 'rotationId', 'createdAt',
  'previousGenerationId', 'previousHeadDigest', 'nextGenerationId',
  'archiveRelativePath', 'archiveManifestDigest', 'rotationEvent',
  'journal', 'events',
]);

const ALLOWED_TRANSITIONS = Object.freeze({
  prepared: 'archive-committed',
  'archive-committed': 'journal-published',
  'journal-published': 'events-published',
  'events-published': 'completed',
});
```

Path-free error:

```js
export class AuditIntegrityRotationError extends Error {
  constructor(code) {
    const registered = assertRegisteredErrorCode(code);
    super(registered);
    this.name = 'AuditIntegrityRotationError';
    this.code = registered;
  }
}
```

Manifest canonical serialization:

```js
function serializeCanonicalManifest(v) {
  return JSON.stringify({
    schemaVersion: v.schemaVersion,
    recordKind: v.recordKind,
    rotationId: v.rotationId,
    createdAt: v.createdAt,
    previousGenerationId: v.previousGenerationId,
    previousJournalSchemaVersion: v.previousJournalSchemaVersion,
    previousHeadDigest: v.previousHeadDigest,
    journal: v.journal,
    events: v.events,
    nextGenerationId: v.nextGenerationId,
    rotationEventId: v.rotationEventId,
    rotationEventPayloadDigest: v.rotationEventPayloadDigest,
  });
}
```

- [ ] Run:

```bash
node --test test/error-codes.test.js test/audit-integrity-rotation-state.test.js test/audit-integrity-rotation-manifest.test.js test/audit-integrity-dual-write-scans.test.js
```

Expected: ERROR_CODES exact 94; S1–S7 and A1–A2 pass; manifest raw has no trailing newline and is ≤16 KiB.

Commit boundary C2, only after user confirmation: `feat: add audit rotation state contracts`.

---

## Task 3: Read-Only Idle Validation and Archive Commit — A3–A7, P1–P5

**Files:**

- Create: `src/audit-integrity-rotation.js`
- Modify: `src/audit-integrity-dual-write.js`
- Modify: `test/audit-integrity-rotation-manifest.test.js`
- Create: `test/audit-integrity-rotation.test.js`

- [ ] Export `validateAuditIntegrityDualWriteIdleUnlocked`; prove a missing/prepared state never bootstraps or recovers.
- [ ] Add A3–A7 and P1–P5 before implementation.
- [ ] Snapshot rotate options synchronously through own data descriptors；reject Proxy/accessor/extra string keys/unknown symbol keys before root resolution or I/O。唯一可接受的 symbol 是模块导出的 test-only crash Symbol，且不进入 canonical state 或 receipt。
- [ ] Under one shared lease: rotation-state gate → exact idle validator → expected generation/head → old journal/events snapshots → all bounds → prepared WAL.
- [ ] Build archive path only from verified previous generation.
- [ ] Exclusive-create journal, events, then manifest; every `created:false` requires exact bounded read + length + SHA-256 match.
- [ ] Do not publish `archive-committed` until actual manifest and all three archive leaves verify.

No-bootstrap validator:

```js
export async function validateAuditIntegrityDualWriteIdleUnlocked(resolvedRoot, lease) {
  assertAuditIntegrityWriteLease(resolvedRoot, lease);
  const state = await loadDualWriteStateUnlocked(resolvedRoot, lease);
  if (state === null || state.status !== 'idle') {
    throwDualWriteError(ERROR_CODES.AUDIT_INTEGRITY_DUAL_WRITE_STATE_INVALID);
  }
  return validateIdleCursorAgainstStoresUnlocked(resolvedRoot, lease, state);
}
```

Exact archive helper:

```js
async function createOrVerifyArchiveText(resolvedRoot, relativePath, raw, fp) {
  const created = await safeCreateExclusiveText(
    resolvedRoot,
    relativePath,
    raw,
    { mode: 0o600 },
  );
  if (!created.created) {
    let actual;
    try {
      actual = await safeReadText(resolvedRoot, relativePath, {
        maxBytes: fp.rawByteLength + 1,
      });
    } catch {
      throwRotation(ERROR_CODES.AUDIT_INTEGRITY_ROTATION_CONFLICT);
    }
    if (
      Buffer.byteLength(actual, 'utf8') !== fp.rawByteLength
      || sha256Hex(actual) !== fp.rawSha256
    ) {
      throwRotation(ERROR_CODES.AUDIT_INTEGRITY_ROTATION_CONFLICT);
    }
  }
}
```

Bounds-before-write test:

```js
it('P5 rejects event line/count/16MiB bounds before prepared exists', async () => {
  await withHealthyRoot(async (root) => {
    const before = await snapshotRotationStores(root);
    await assert.rejects(
      rotateAuditIntegrityGeneration(root, EXPECTED),
      hasCode(ERROR_CODES.AUDIT_INTEGRITY_ROTATION_BOUNDS_EXCEEDED),
    );
    assert.deepEqual(await snapshotRotationStores(root), before);
  }, { eventsAtLimit: true });
});
```

- [ ] Run:

```bash
node --test test/audit-integrity-rotation-manifest.test.js test/audit-integrity-rotation.test.js test/audit-integrity-dual-write.test.js test/audit-integrity-dual-write-state.test.js
```

Expected: A1–A7 pass; P1–P5 pass; existing dual-write tests pass; no archive or WAL appears on any preflight refusal.

Commit boundary C3, only after user confirmation: `feat: add audit rotation archive commit protocol`.

---

## Task 4: Atomic Cutover, Phase Recovery and Idempotency — P6–P7, R1–R9

**Files:**

- Modify: `src/audit-integrity-rotation.js`
- Modify: `src/audit-integrity-rotation-state.js`
- Modify: `test/audit-integrity-rotation.test.js`
- Create: `test/audit-integrity-rotation-recovery.test.js`

- [ ] Add P6–P7 and R1–R9 before the production recovery branches.
- [ ] Export `AUDIT_INTEGRITY_ROTATION_TEST_CRASH_HOOK = Symbol(...)` solely for tests, matching the existing dual-write crash-injection pattern. Public string options cannot name it；the parser accepts this exact Symbol and rejects every other symbol.
- [ ] Define CP0–CP6 exactly: after prepared, archive journal, archive events, manifest, new journal, events post, new idle.
- [ ] Rebuild new v2 journal only through journal module; rebuild events post only as sealed exact bytes + exact rotation event line.
- [ ] Classify live journal/events/idle as `pre | post | other` from exact fingerprints.
- [ ] Treat verified manifest existence as the authority even when WAL remains `prepared`.
- [ ] Before commit point only continue building exact archive; after commit point only roll forward.
- [ ] Publish phases only forward; a store may be ahead of WAL, so verify actual bytes before advancing.
- [ ] Recompute completed receipt from files; never trust `status:'completed'` alone.

Classifier:

```js
function classifyFingerprint(actual, pre, post) {
  if (fingerprintEqual(actual, pre)) return 'pre';
  if (fingerprintEqual(actual, post)) return 'post';
  return 'other';
}

function requirePreOrPost(actual, pre, post) {
  const state = classifyFingerprint(actual, pre, post);
  if (state === 'other') {
    throwRotation(ERROR_CODES.AUDIT_INTEGRITY_ROTATION_CONFLICT);
  }
  return state;
}
```

Phase order:

```text
prepared
  -> archive journal exact
  -> archive events exact
  -> manifest exact (commit point)
  -> archive-committed
  -> atomic new journal + exact reopen
  -> journal-published
  -> atomic events post + exact reopen
  -> events-published
  -> publish new ordinary idle + validate
  -> completed
  -> read-only monitor healthy
```

Completed-not-proof canary:

```js
it('R8 completed status is not self-proving when live or archive bytes diverge', async () => {
  await withCompletedRotation(async ({ root, state }) => {
    await writeFile(journalAbs(root), 'foreign\n', { mode: 0o600 });
    await assert.rejects(
      recoverAuditIntegrityRotation(root),
      hasCode(ERROR_CODES.AUDIT_INTEGRITY_ROTATION_CONFLICT),
    );
    assert.equal(state.status, 'completed');
  });
});
```

- [ ] Run:

```bash
node --test test/audit-integrity-rotation.test.js test/audit-integrity-rotation-recovery.test.js test/audit-integrity-journal.test.js test/audit-integrity-cross-store.test.js
```

Expected: P1–P7 and R1–R9 pass; CP0–CP2 keep old live anchor; CP3–CP6 converge forward; second recovery returns `already-completed`.

Commit boundary C4, only after user confirmation: `feat: add audit rotation cutover and recovery`.

---

## Task 5: Concurrency and Real Process Lock — C1–C6

**Files:**

- Create: `test/helpers/audit-integrity-rotation-child.js`
- Create: `test/audit-integrity-rotation-multiprocess.test.js`
- Modify: `src/audit-integrity-rotation.js` only if tests reveal a real queue/lease wiring defect.

- [ ] Child helper accepts a fixed operation allowlist over argv, never shell strings, environment secrets or arbitrary module paths.
- [ ] Emit fixed IPC/stdout milestones `READY`, `CRASH_POINT:<CPn>`, `DONE`; never emit dataDir or state content.
- [ ] Add C1–C6; at least C4/C5 use independent Node processes and the real `/usr/bin/lockf` path.
- [ ] Assert loser semantics by typed code/result, archive count, generation chain and exactly-once rotation event—not by wall-clock ordering alone.
- [ ] For lock unavailable, assert zero prepared/archive/live changes.

Child invocation pattern:

```js
const child = spawn(process.execPath, [
  CHILD_FIXTURE,
  'rotate',
  '--data-dir', root,
  '--expected-generation-id', expectedGenerationId,
  '--expected-head-digest', expectedHeadDigest,
], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { PATH: process.env.PATH ?? '' },
});
```

The fixture must use `execFile`/`spawn` with `shell:false`; production code remains unaware of fixture crash controls except the exact module-issued test Symbol imported by the fixture.

- [ ] Run:

```bash
node --test test/audit-integrity-rotation-multiprocess.test.js
node --test test/audit-integrity-process-lock.test.js test/audit-integrity-process-lock-queue.test.js test/audit-integrity-multiprocess-lock.test.js
```

Expected: C1–C6 pass; all prior lock tests pass; no two same-root mutation tasks overlap.

Commit boundary C5, only after user confirmation: `test: prove audit rotation process safety`.

---

## Task 6: Ordinary Append and Monitor Gates — G1–G7

**Files:**

- Modify: `src/audit-integrity-dual-write.js`
- Modify: `src/audit-integrity-monitor.js`
- Create: `test/audit-integrity-rotation-gates.test.js`
- Modify: `test/audit-integrity-monitor.test.js`

- [ ] Add G1–G7 before wiring.
- [ ] In `appendAuditEventWithIntegrityDualWrite`, after acquiring the existing lease and before loading/interpreting dual-write state, call the rotation-state read gate.
- [ ] Missing rotation WAL allows existing behavior; nonterminal throws recovery-required; invalid/io preserve typed rotation errors.
- [ ] Completed allows append only when its next generation matches the actual idle/current journal binding.
- [ ] Monitor first performs read-only rotation inspection; it never calls rotate/recover/publish.
- [ ] Nonterminal reports `rotation-recovery-required`; completed deep-verifies only current + directly referenced latest archive, then runs existing dual-write inspector.
- [ ] After later legitimate retention removes the rotation event from events, accept the existing `events-suffix-of-journal` relationship; journal must still contain exactly one rotation event.

Append gate location:

```js
return enqueueAuditIntegrityWriteTask(resolvedRoot, async (lease) => {
  const completedRotation =
    await assertAuditIntegrityRotationAllowsAppendUnlocked(resolvedRoot, lease);
  const idle = await ensureAuditIntegrityDualWriteIdleUnlocked(resolvedRoot, lease);
  if (
    completedRotation !== null
    && idle.generationId !== completedRotation.nextGenerationId
  ) {
    throw new AuditIntegrityRotationError(
      ERROR_CODES.AUDIT_INTEGRITY_ROTATION_CONFLICT,
    );
  }
  return commitDualWriteUnlocked(resolvedRoot, lease, idle, ctx);
});
```

Monitor semantic branch:

```js
if (rotation.kind === 'recovery-required') {
  return freezeReport({
    schemaVersion: 1,
    status: 'alert',
    code: 'rotation-recovery-required',
    checkedAt,
    dualWriteState: rotation.dualWriteState,
    relationship: null,
    recoveryRequired: true,
    alertRequired: true,
    nextAction: 'run-explicit-recovery',
    reasonCode: ERROR_CODES.AUDIT_INTEGRITY_ROTATION_RECOVERY_REQUIRED,
  });
}
```

- [ ] Snapshot every monitored file before/after G6/G7 and assert byte equality.
- [ ] Run:

```bash
node --test test/audit-integrity-rotation-gates.test.js test/audit-integrity-monitor.test.js test/audit-integrity-monitor-scans.test.js
node --test test/audit-integrity-dual-write.test.js test/audit-integrity-cross-store.test.js
```

Expected: G1–G7 pass; monitor remains read-only; ordinary append never auto-recovers.

Commit boundary C6, only after user confirmation: `feat: gate audit writes and monitor rotation`.

---

## Task 7: Explicit Agent CLI — L1–L5

**Files:**

- Modify: `src/agent.js`
- Create: `test/agent-audit-integrity-rotation.test.js`

- [ ] Add exact commands to usage without adding HTTP/Web surface.
- [ ] Parse each command with a local strict argv validator; reject duplicates, missing values, extra flags, `--token`, symbols and invalid 32/64 hex.
- [ ] Rotate command snapshots exact expected args; recover command accepts only `--data-dir`.
- [ ] Print only compact JSON receipt + newline on success.
- [ ] Exit 2 for registered rotation/integrity/process-lock refusal; exit 1 for argv or unclassified program error; fixed stderr must not interpolate paths/errors.
- [ ] Add L1–L5 using real `node src/agent.js` subprocesses.

Dispatch shape:

```js
case 'audit-integrity-rotate': {
  const parsed = parseAuditIntegrityRotateArgs(argv.slice(1));
  const receipt = await rotateAuditIntegrityGeneration(parsed.dataDir, {
    expectedGenerationId: parsed.expectedGenerationId,
    expectedHeadDigest: parsed.expectedHeadDigest,
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  return;
}
case 'audit-integrity-rotation-recover': {
  const parsed = parseAuditIntegrityRotationRecoverArgs(argv.slice(1));
  const receipt = await recoverAuditIntegrityRotation(parsed.dataDir);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  return;
}
```

Fixed stderr:

```text
Error: audit-integrity-rotate arguments are invalid
Error: audit-integrity-rotate refused
Error: audit-integrity-rotate failed
Error: audit-integrity-rotation-recover arguments are invalid
Error: audit-integrity-rotation-recover refused
Error: audit-integrity-rotation-recover failed
```

- [ ] Run:

```bash
node --test test/agent-audit-integrity-rotation.test.js test/agent-audit-integrity-monitor.test.js
```

Expected: L1–L5 pass; existing monitor CLI tests pass; stdout/stderr contain no dataDir or raw error.

Commit boundary C7, only after user confirmation: `feat: expose explicit audit rotation CLI`.

---

## Task 8: Real Filesystem and Crash Acceptance — F1–F6

**Files:**

- Create: `test/audit-integrity-rotation-real-fs.test.js`
- Modify: `test/helpers/audit-integrity-rotation-child.js`
- Modify product files only for a reproduced implementation defect.

- [ ] F1 checks archived journal/events byte-for-byte, manifest canonical bytes, regular-file type and exact `0o600` mode.
- [ ] F2 creates real regular/symlink/directory EEXIST occupants; exact regular content is idempotent, all other occupants conflict without overwrite/follow/delete.
- [ ] F3 terminates a child immediately after CP3 manifest commit; fresh process recovers forward.
- [ ] F4 terminates after CP4 new journal; fresh process preserves journal and publishes events/state.
- [ ] F5 terminates after CP5 and CP6 in table-driven subcases; fresh process converges and a second recover is idempotent.
- [ ] F6 performs a normal production append after recovery, verifies cross-store/monitor healthy, then confirms archived bytes and inode-visible content did not change.

Real crash test pattern:

```js
await waitForLine(child.stdout, 'CRASH_POINT:CP3');
child.kill('SIGKILL');
const exit = await waitForExit(child);
assert.equal(exit.signal, 'SIGKILL');

const recovered = await runFreshRecovery(root);
assert.equal(recovered.code, 0);
assert.equal(JSON.parse(recovered.stdout).state, 'rotated');

const again = await runFreshRecovery(root);
assert.equal(JSON.parse(again.stdout).state, 'already-completed');
```

- [ ] Run:

```bash
node --test test/audit-integrity-rotation-real-fs.test.js
node --test test/audit-integrity-rotation-multiprocess.test.js
```

Expected: F1–F6 pass on macOS with real `/usr/bin/lockf`; skipped platform evidence is not accepted as V1.43 completion on the release host.

Commit boundary C8, only after user confirmation: `test: prove audit rotation real filesystem recovery`.

---

## Task 9: Security Scans, Version and Honest Release Surface — Q1–Q4

**Files:**

- Create: `test/audit-integrity-rotation-scans.test.js`
- Modify: `src/version.js`
- Modify: `src/gold-readiness.js`
- Modify: `test/version.test.js`
- Modify: `test/gold-readiness.test.js`
- Modify: `README.md`

- [ ] Add Q1: scan source/agent/server/web for no timer/scheduler/auto-threshold/HTTP route/button/archive deletion.
- [ ] Add Q2: enforce import direction; rotation-state cannot import coordinator/audit-log/agent/monitor; server/web cannot import rotation; append gate appears before dual-state interpretation.
- [ ] Add Q3: exact six error values, registry 94, receipt/error path-free, no cause/stack/raw event/absolute path fields.
- [ ] Add Q4: exact V1.43 signature and negative boundaries on current README/gold-readiness surface.
- [ ] Only after Tasks 1–8 are green, change `LINKE_RELEASE_VERSION` to `V1.43`.
- [ ] Promote V1.42 row to historical, add V1.43 current row, retain G0c real-LAN evidence absent and Gold `4/4/1/9`.
- [ ] Replace stale current phrase `no journal rotation yet` with precise boundaries: explicit rotation delivered; no automatic rotation/scheduler/remote notification; archive append-only policy is not WORM/authenticity.
- [ ] Update production-hardening evidence/nextStep without changing any Gold item status.

Version constants:

```js
export const LINKE_RELEASE_VERSION = 'V1.43';

const V143_SIGNATURE =
  'V1.43 explicit crash-recoverable audit integrity rotation foundation';
```

Scan canary:

```js
it('Q1 exposes no automatic, HTTP, Web, scheduler, or archive deletion path', async () => {
  const sources = await readAllowedSources();
  assert.doesNotMatch(sources.agent, /setInterval|setTimeout|schedule|threshold/i);
  assert.doesNotMatch(sources.server, /audit-integrity-(?:rotate|rotation-recover)/);
  assert.doesNotMatch(sources.web, /audit-integrity-(?:rotate|rotation-recover)/);
  assert.doesNotMatch(sources.rotation, /unlink|rm\(|rmdir|archive.*delete/i);
});
```

- [ ] Run:

```bash
node --test test/audit-integrity-rotation-scans.test.js test/error-codes.test.js test/audit-integrity-dual-write-scans.test.js
node --test test/version.test.js test/gold-readiness.test.js test/agent-gold-readiness.test.js test/cross-lan-denylist-version-contract.test.js
```

Expected: Q1–Q4 pass; version exactly V1.43; Gold item snapshot unchanged; exact error count 94.

Commit boundary C9, only after user confirmation: `chore: mark V1.43 audit rotation milestone`.

---

## Task 10: Full Verification, Independent Reviews and Release Hold

**Files:** no planned product edits; any review fix gets a narrow task-specific commit after user approval.

### 10.1 Effective RED proof

- [ ] From isolated `5051b0e...`, apply only the 64 new tests/helpers and required test-import edits.
- [ ] Run new suites; record failures caused by absent rotation APIs/behavior.
- [ ] Delete the temporary worktree through the approved worktree workflow; do not disturb main tree.

### 10.2 Focused and inherited audit suites

```bash
node --test \
  test/audit-integrity-rotation-state.test.js \
  test/audit-integrity-rotation-manifest.test.js \
  test/audit-integrity-rotation.test.js \
  test/audit-integrity-rotation-recovery.test.js \
  test/audit-integrity-rotation-multiprocess.test.js \
  test/audit-integrity-rotation-gates.test.js \
  test/agent-audit-integrity-rotation.test.js \
  test/audit-integrity-rotation-scans.test.js \
  test/audit-integrity-rotation-real-fs.test.js

node --test \
  test/audit-integrity-journal.test.js \
  test/audit-integrity-journal-scans.test.js \
  test/audit-integrity-dual-write-state.test.js \
  test/audit-integrity-dual-write.test.js \
  test/audit-integrity-dual-write-scans.test.js \
  test/audit-integrity-cross-store.test.js \
  test/audit-integrity-monitor.test.js \
  test/audit-integrity-monitor-scans.test.js \
  test/audit-integrity-process-lock.test.js \
  test/audit-integrity-process-lock-queue.test.js \
  test/audit-integrity-process-lock-scans.test.js \
  test/audit-integrity-multiprocess-lock.test.js \
  test/agent-audit-integrity-monitor.test.js
```

Expected: all focused tests pass；八个既有 selected files 的 436/436 runtime baseline 保持 green；64 个新增 ledger IDs 与新增静态 `it/test` 声明精确一致。若新增测试全部进入相同 selected command，runtime 合计至少 500；分文件运行时也必须逐项实际执行，不能只靠静态计数。

### 10.3 Full repository verification

```bash
npm test
git diff --check
git status --short --branch
git diff --stat 5051b0e5184f9da23ba6a101ba6869f985532dbd
git diff --name-only 5051b0e5184f9da23ba6a101ba6869f985532dbd
```

Expected: full suite exit 0; only allowlisted changes; branch ahead by approved commits; `package-lock.json` remains untouched/untracked.

### 10.4 Review sequence

- [ ] Grok implementation worker provides boundary-local diff summary and exact test outputs; Codex independently reruns them.
- [ ] GLM fresh adversary reviews final branch diff against design/plan, with explicit P0/P1/P2 and `PROCEED YES|NO`; timeout/network is HOLD, never PASS.
- [ ] Qwen counts actual new tests by ledger IDs and reports missing/duplicate IDs; it does not decide correctness.
- [ ] Resolve all P0/P1 and any accepted P2 with new failing tests first; rerun focused/full suites.
- [ ] Kimi fresh closure review receives design, plan, final diff, RED/GREEN/full-suite/real-crash evidence and prior finding dispositions. Kimi timeout/network/error is `SUB_AGENT_REVIEW_HOLD`.
- [ ] Codex verifies Kimi factual claims against local source and test output, then gives final verdict.

### 10.5 Gold and Git gates

- [ ] V1.43 completion can be claimed only when all 64 tests, inherited audit suites, full `npm test`, real-process crash tests, GLM adversary, Kimi closure and Codex verification are green.
- [ ] Even then claim only the exact V1.43 signature; Gold remains blocked `4/4/1/9`.
- [ ] Ask for explicit authorization before each remaining commit and before push.
- [ ] After push authorization and successful push, verify:

```bash
git fetch origin linke-v0.12-web-panel
git rev-parse HEAD origin/linke-v0.12-web-panel
git status --short --branch
```

Expected: local/remote SHA equal; only untouched untracked `package-lock.json` remains; no tag/release/deploy is created by this plan.

---

## Commit Boundaries

| Boundary | Scope | Proposed message | Gate |
| --- | --- | --- | --- |
| C1 | journal v2 + J1–J6 | `feat: add audit journal generation v2` | focused journal green + user confirm |
| C2 | six codes + state/manifest schema | `feat: add audit rotation state contracts` | exact 94 + S/A schema green + user confirm |
| C3 | idle validator + archive/preflight | `feat: add audit rotation archive commit protocol` | A1–A7/P1–P5 green + user confirm |
| C4 | cutover/recovery | `feat: add audit rotation cutover and recovery` | P/R green + user confirm |
| C5 | multiprocess | `test: prove audit rotation process safety` | real lock tests green + user confirm |
| C6 | append/monitor gates | `feat: gate audit writes and monitor rotation` | G1–G7 + regressions green + user confirm |
| C7 | Agent CLI | `feat: expose explicit audit rotation CLI` | L1–L5 + monitor CLI green + user confirm |
| C8 | real FS/crash | `test: prove audit rotation real filesystem recovery` | F1–F6 green + user confirm |
| C9 | scans/version/docs | `chore: mark V1.43 audit rotation milestone` | Q1–Q4 + version/Gold green + user confirm |
| Fix | review-only narrow correction | `fix: harden audit rotation <specific-boundary>` | new RED→GREEN + full regression + user confirm |

Push is one separate final authorization. Tag, GitHub release, deployment and Gold/GA publication are outside this V1.43 plan.

---

## Definition of Done

- [ ] Runtime exposes only explicit rotate/recover API and Agent CLI.
- [ ] Archive bundle is journal + exact events snapshot + canonical manifest, created 0600 with no overwrite/delete path.
- [ ] v2 live journal atomically starts with open + exactly one rotation event-link and binds previous generation/head/manifest digest.
- [ ] Manifest commit point controls recovery direction; all CP0–CP6 converge or fail closed on `other` bytes.
- [ ] Ordinary append is blocked by nonterminal/invalid rotation state and never auto-recovers.
- [ ] Monitor is byte-proven read-only and validates current + latest directly referenced archive.
- [ ] Rotation event is exactly once in journal; at completion exactly once in events; later retention deletion remains a valid existing suffix relationship.
- [ ] Six new error codes are registered; exact total is 94; all new errors/receipts are path-free.
- [ ] Exact 64 new tests exist and pass; effective RED, selected audit regressions, full suite and real macOS crash/lock evidence exist.
- [ ] GLM adversary and Kimi closure produce valid non-timeout verdicts; Qwen count reconciles to 64; Codex independently verifies.
- [ ] `package-lock.json` remains unread, unmodified, unstaged and uncommitted.
- [ ] README/version/gold-readiness carry exact V1.43 signature and keep Gold blocked `4/4/1/9` without overclaim.
