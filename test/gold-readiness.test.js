import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildGoldReadinessReport } from '../src/gold-readiness.js';
import { LINKE_RELEASE_VERSION } from '../src/version.js';

function evidenceText(item) {
  assert.ok(item, 'item should exist');
  assert.ok(Array.isArray(item.evidence), `item ${item.id || '(unknown)'} evidence should be an array`);
  assert.ok(item.evidence.length > 0, `item ${item.id} evidence array should not be empty`);
  for (const s of item.evidence) {
    assert.strictEqual(typeof s, 'string', `item ${item.id} evidence element should be a string`);
    assert.ok(s.length > 0, `item ${item.id} evidence element should not be empty`);
  }
  return item.evidence.join(' ');
}

/** Exact negative boundary phrase for production-hardening honesty. */
const NOT_PRODUCTION_HARDENING_READY = 'not production-hardening ready';
const PRODUCTION_HARDENING_READY = 'production-hardening ready';

/**
 * Pure helper: every phrase-bearing clause that mentions production-hardening ready
 * must also contain the negative "not production-hardening ready" (case-insensitive).
 * Split on `;` / fullwidth `；` / Chinese period `。` / English comma `,` /
 * Chinese comma `，` / English period only when followed by whitespace (`\.(?=\s)`,
 * so version tokens like `T6d.3` stay intact) / emdash `—` / endash `–` / `--`.
 * Each clause is lowercased before comparing the two phrase constants.
 * Returns true when no un-negated positive claim exists.
 */
function productionHardeningReadyClausesAreNegated(text) {
  const positive = PRODUCTION_HARDENING_READY.toLowerCase();
  const negative = NOT_PRODUCTION_HARDENING_READY.toLowerCase();
  const clauses = String(text)
    .split(/[;；。,，—–]|--|\.(?=\s)/)
    .map((c) => c.trim())
    .filter(Boolean);
  for (const clause of clauses) {
    const lower = clause.toLowerCase();
    if (lower.includes(positive) && !lower.includes(negative)) {
      return false;
    }
  }
  return true;
}

/**
 * Assert evidence array elements that mention production-hardening ready each
 * contain the exact negative phrase (element-level, not joined-text regex).
 */
function assertEvidenceProductionHardeningReadyNegated(evidence, label = 'evidence') {
  assert.ok(Array.isArray(evidence), `${label} must be an array`);
  for (const element of evidence) {
    if (String(element).includes(PRODUCTION_HARDENING_READY)) {
      assert.ok(
        String(element).includes(NOT_PRODUCTION_HARDENING_READY),
        `${label} element mentioning "${PRODUCTION_HARDENING_READY}" must include exact "${NOT_PRODUCTION_HARDENING_READY}": ${JSON.stringify(element)}`,
      );
    }
  }
}

/**
 * Assert nextStep / free text: every clause (same split as
 * productionHardeningReadyClausesAreNegated) that bears the phrase must include
 * the negative (case-insensitive match).
 */
function assertTextProductionHardeningReadyNegated(text, label = 'text') {
  assert.ok(
    productionHardeningReadyClausesAreNegated(text),
    `${label} has a clause claiming "${PRODUCTION_HARDENING_READY}" without exact "${NOT_PRODUCTION_HARDENING_READY}"`,
  );
}

/** Exact Gold short phrase required on production-hardening surface. */
const GOLD_REMAINS_BLOCKED_4419 = 'Gold remains blocked 4/4/1/9';

/** Ambiguous slash aggregate forbidden on V1.40 current-state surface. */
const STALE_SLASH_AGGREGATE =
  'no journal rotation / managed scheduler / remote notification delivery';

/** Exact historical V1.42 signature — retained G0c base. */
const V142_SIGNATURE =
  'V1.42 G0c endpoint-pull restore with crash-recoverable rollback anchor implementation';

/** Exact V1.43 signature ceiling. */
const V143_SIGNATURE =
  'V1.43 explicit crash-recoverable audit integrity rotation foundation';

/** Exact historical V1.41 signature. */
const V141_SIGNATURE =
  'V1.41 G0b resumable manifest v2 snapshot upload implementation';

/** Exact historical V1.40 signature. */
const V140_SIGNATURE =
  'V1.40 local multi-process audit integrity write exclusive lock implementation';

/**
 * Exact V1.40 release/close failure ops-boundary atoms (honesty surface).
 * Required on production-hardening evidence + nextStep current prefix.
 * Conditional / non-absolute: do NOT claim stuck lock / restart required /
 * fd always remains open / automatic recovery.
 */
const RELEASE_CLOSE_FAIL_CLOSES = 'release/close failure fail-closes';
const TASK_MUTATION_MAY_ALREADY_APPLIED = 'task mutation may already be applied';
const CALLER_RETRY_NO_IDEMPOTENT_EXACTLY_ONCE =
  'caller retry has no idempotent/exactly-once guarantee';
const NO_DETERMINISTIC_IN_BAND_FD_RECLAIM =
  'no deterministic in-band fd reclaim before process exit';

/** Absolute overclaims forbidden on V1.40 current production-hardening surface. */
const FORBIDDEN_ABSOLUTE_V140_PHRASES = Object.freeze([
  'stuck lock',
  'restart required',
  'fd always remains open',
  'automatic recovery',
]);

/** Exact historical V1.39 signature — retained write-admission base. */
const V139_SIGNATURE =
  'V1.39 safety-critical audit write-admission fail-closed implementation';

/** Exact historical V1.38 signature — retained base. */
const V138_SIGNATURE =
  'V1.38 read-only audit integrity run-once monitor/alert implementation';

/** Exact post-outcome still-best-effort honesty phrase. */
const POST_OUTCOME_STILL_BEST_EFFORT =
  'post-outcome recordAudit / appendNasReplicationAudit still best-effort';

/**
 * Exact V1.39 write-admission failure boundary atom (historical retained fact).
 * Binds required write-admission failure + audit-delivery-unavailable + HTTP 503 / CLI exit 1
 * in one evidence element — must not be satisfied by V1.38 nextStep historical
 * "exit 1 argv or program error".
 */
const WRITE_ADMISSION_FAILURE_BOUNDARY =
  'required write-admission audit failure: audit-delivery-unavailable (HTTP 503 / CLI exit 1)';

/**
 * Exact V1.38 historical nextStep monitor exit-1 phrase (must match production nextStep text).
 * Must not appear in the V1.40 current nextStep segment or substitute for write-admission boundary.
 */
const V138_MONITOR_EXIT_1 = 'exit 1 argv or program error';

/** Stale all-paths best-effort element — must not remain as current production evidence. */
const STALE_ALL_PATHS_BEST_EFFORT =
  'server recordAudit / agent appendNasReplicationAudit best-effort catch';

/**
 * Stale standalone current multi-process denials — delivered by V1.40.
 * Forbidden as exact evidence elements / current prefix / remaining-work list.
 * Historical V1.37/V1.39 prose may still mention them as past fact.
 */
const STALE_CURRENT_MULTI_PROCESS_DENY = 'not multi-process exclusive lock';
const STALE_SINGLE_PROCESS_QUEUE_ONLY = 'single-process queue only';
const STALE_MULTI_PROCESS_YET = 'not multi-process exclusive lock yet';

/**
 * Frozen Gold item id/status snapshot.
 * V1.46 promotes only the current release/version surface and
 * automation-installation evidence prefix; status counts remain unchanged while
 * the V1.45 NAS dry-run configuration-readiness PASS rotation stays retained.
 * partial → ready; all other item statuses unchanged (V1.44 C1 committed
 * real-NAS acceptance PASS previously rotated real-nas-remote-backup
 * blocked → ready).
 */
const GOLD_ITEM_STATUS_SNAPSHOT = Object.freeze([
  { id: 'release-readiness', status: 'ready' },
  { id: 'local-backup-restore', status: 'ready' },
  { id: 'fleet-device-management', status: 'ready' },
  { id: 'version-consistency', status: 'ready' },
  { id: 'nas-dry-run', status: 'ready' },
  { id: 'automation-installation', status: 'partial' },
  { id: 'security-auth', status: 'partial' },
  { id: 'real-nas-remote-backup', status: 'ready' },
  { id: 'production-hardening', status: 'partial' },
]);

const V146_AUTOMATION_EVIDENCE = Object.freeze([
  'V1.46 user-level LaunchAgent lifecycle code-stage closure',
  'src/launchagent-lifecycle/acceptance-gate.js',
  'src/launchagent-lifecycle/process-identity.js',
  'test/launchagent-lifecycle-acceptance-gate.test.js',
  'test/launchagent-lifecycle-manual-repair-recovery.test.js',
  'test/launchagent-lifecycle-recovery.test.js',
  'manual repair attestation pure closeout',
  'frozen compensation/crash windows',
  'real Node owner SIGKILL/recovery child',
  'no real launchctl',
  'no clean-Mac lifecycle evidence',
  'not installation complete',
  'code-stage only',
  'conditional fake host adapters',
]);

/**
 * V1.46 security-auth evidence tail: exact ordered suffix of the item's
 * evidence array documenting the management auth Keychain startup source
 * plus controlled rotation/restart code paths, while keeping the item
 * partial (real macOS Keychain/launchctl/HTTP acceptance not verified).
 */
const V146_SECURITY_AUTH_EVIDENCE_TAIL = Object.freeze([
  'V1.46 management auth Keychain startup source code path',
  'src/keychain-store.js default service com.linke.gold',
  'src/management-auth-keychain.js',
  'src/controller-runtime.js managementAuthKeychainScopes startup load',
  'test/management-auth-keychain.test.js',
  'test/controller-runtime.test.js V1.46 management auth Keychain source',
  'LINKE_MANAGEMENT_AUTH_SOURCE=keychain',
  'LINKE_MANAGEMENT_AUTH_KEYCHAIN_SCOPES',
  'loaded once at controller startup; no hot reload',
  'behavioral tests use an injected in-memory fake Keychain; production Keychain path exists; real macOS Keychain provisioning/acceptance not verified',
  'no claim of complete secret management or automatic token rotation',
  'V1.46 full/read/write/admin management auth controlled rotation and explicit restart code path',
  'src/management-auth-rotation.js',
  'src/management-auth-rotation-process-lock.js',
  'src/management-auth-rotate-command.js',
  'src/management-auth-controller-restart.js',
  'test/management-auth-rotation.test.js',
  'test/management-auth-rotation-process-lock.test.js',
  'test/management-auth-rotate-command.test.js',
  'test/management-auth-controller-restart.test.js',
  'test/agent-management-auth-rotate.test.js',
  'explicit --restart-controller with canonical --controller-port',
  'required restart attempt audit before Keychain staging and launchctl',
  'one-time in-process genuine staging receipt authority',
  'fixed loopback /api/auth-status proof of keychain startup snapshot and previous-token overlap',
  'behavioral tests use fake Keychain and injected launchctl/http effects; real macOS Keychain, launchctl action, and host HTTP acceptance not verified',
  'do not claim complete secret management; do not claim automatic token rotation; do not claim security-auth ready; do not claim Gold ready',
  'src/keychain-store.js SECURITY_COMMAND_TIMEOUT_MS=10000',
  'test/keychain-store.test.js hard timeout and late callback cancellation',
  'Keychain security child timeout fails closed, kills the child, and destroys stdio',
  'fake timer code-stage evidence only; real locked-Keychain and headless bootstrap acceptance not verified',
  'launchd SoftResourceLimits.Core:0 and HardResourceLimits.Core:0 code-stage mitigation',
  'src/launchagent-lifecycle/profiles.js controller and scheduler core dump limits',
  'src/agent.js launchd-dry-run core dump limits',
  'test/launchagent-lifecycle-profiles.test.js and test/launchd-dry-run.test.js',
  'code-stage plist evidence only; real installed-process limit acceptance and token-memory exposure review remain incomplete',
  'management-auth rotation stdin mutable Buffer wiping code-stage mitigation',
  'successful, invalid, and oversized stdin paths wipe source, chunk, and concat buffers before Keychain construction',
  'test/management-auth-rotate-command.test.js mutable stdin byte wiping',
  'JavaScript token strings and Keychain command strings remain non-zeroizable; token-memory exposure review remains incomplete',
  'Keychain security runner raw stdout mutable Buffer wiping code-stage mitigation',
  'successful, stream-error, and oversized stdout paths wipe source, chunk, and concat buffers',
  'test/keychain-store.test.js raw stdout byte wiping',
  'decoded Keychain secret strings remain non-zeroizable; token-memory exposure review remains incomplete',
  'Keychain security runner stdin mutable Buffer wiping code-stage mitigation',
  'command strings are encoded into runner-owned buffers and wiped on finish, close, failure, timeout, and synchronous end throw',
  'test/keychain-store.test.js runner-owned stdin buffer wiping',
  'source JavaScript command strings remain non-zeroizable; token-memory exposure review remains incomplete',
  'Keychain envelope, decode, and equality mutable Buffer wiping code-stage mitigation',
  'encode, envelope-to-hex, decode, equal, and length-mismatch paths wipe transient buffers',
  'test/keychain-store.test.js transient envelope and comparison buffer wiping',
  'envelope, base64url, hex, and decoded secret strings remain non-zeroizable; token-memory exposure review remains incomplete',
]);

/**
 * Exact clause-local direct negations the V1.46 security-auth nextStep must
 * carry. The audit honesty scanners split text into clauses on
 * `;` / `,` / `.`-followed-by-space boundaries and require every clause that
 * mentions a controlled phrase to carry its own local negative context, so
 * each phrase gets its own `do not claim ...` clause instead of one
 * comma-joined list whose later clauses would scan as bare positives.
 */
const V146_SECURITY_AUTH_NEXTSTEP_NEGATIONS = Object.freeze([
  'do not claim complete secret management',
  'do not claim automatic token rotation',
  'do not claim security-auth ready',
  'do not claim Gold ready',
]);

/**
 * Phrases that must never appear as bare positives in security-auth
 * nextStep once the direct negation clause above is removed (lowercase).
 */
const V146_SECURITY_AUTH_OVERCLAIM_PHRASES = Object.freeze([
  'complete secret management',
  'automatic token rotation',
  'security-auth ready',
  'gold ready',
]);

/**
 * Current production-hardening prefix: text before first V1.39/V1.38/V1.37 historical marker.
 * Used to reject stale multi-process denials that are only valid as historical fact.
 */
function productionHardeningCurrentPrefix(text) {
  // Current segment ends before first pre-V1.40 historical base marker.
  // V1.43 lead-in + V1.42/V1.41/V1.40 historical bases remain in the current honesty prefix.
  return String(text).split(/V1\.39 historical|V1\.38 historical|V1\.37 historical/)[0];
}

/**
 * Element-level helper: every evidence element that contains positivePhrase
 * must itself contain a *direct* `not <phrase>` or `no <phrase>`
 * (case-insensitive). Arbitrary `not`/`no` elsewhere in the element, or in
 * a sibling element, does NOT count. Joined-text shelter is impossible.
 */
function evidenceElementsDirectlyNegatePhrase(evidence, positivePhrase) {
  assert.ok(Array.isArray(evidence), 'evidence must be an array');
  const positive = positivePhrase.toLowerCase();
  for (const element of evidence) {
    const lower = String(element).toLowerCase();
    if (!lower.includes(positive)) continue;
    const hasDirect =
      lower.includes(`not ${positive}`) || lower.includes(`no ${positive}`);
    if (!hasDirect) return false;
  }
  return true;
}

/**
 * Clause-local direct negation for free text (nextStep / README).
 * Requires `not <phrase>` or `no <phrase>` in the same clause — arbitrary
 * elsewhere `not`/`no` is not a shield.
 */
function clauseLocalDirectBarePositiveNegated(text, positivePhrase) {
  const positive = positivePhrase.toLowerCase();
  const clauses = String(text)
    .split(/[;；。,，—–]|--|\.(?=\s)/)
    .map((c) => c.trim())
    .filter(Boolean);
  for (const clause of clauses) {
    const lower = clause.toLowerCase();
    if (!lower.includes(positive)) continue;
    const hasDirect =
      lower.includes(`not ${positive}`) || lower.includes(`no ${positive}`);
    if (!hasDirect) return false;
  }
  return true;
}

function assertGuardedRunnerExecutionPreviewEvidence(evidence) {
  assert.ok(evidence.includes('buildSupervisorLifecycleGuardedRunnerExecutionPreview'));
  assert.ok(evidence.includes('test/supervisor-lifecycle-guarded-runner-execution-preview.test.js'));
  assert.ok(evidence.includes('src/agent.js supervisor-lifecycle-guarded-runner-execution-preview'));
  assert.ok(evidence.includes('test/agent-supervisor-lifecycle-guarded-runner-execution-preview.test.js'));
  assert.ok(evidence.includes('POST /api/supervisor-lifecycle-guarded-runner-execution-preview'));
  assert.ok(evidence.includes('test/supervisor-lifecycle-guarded-runner-execution-preview-api.test.js'));
  assert.ok(evidence.includes('supervisor-lifecycle-guarded-runner-execution-preview-button'));
  assert.ok(evidence.includes('src/web/app.js buildSupervisorLifecycleGuardedRunnerExecutionPreviewViewModel'));
  assert.ok(evidence.includes('test/web-console.test.js supervisor lifecycle guarded runner execution preview'));
  assert.ok(evidence.includes('--fail-on-blocked'));
  assert.ok(evidence.includes('executionReady:false'));
  assert.ok(evidence.includes('executorReady:false'));
  assert.ok(evidence.includes('wouldExecute:false'));
  assert.ok(evidence.includes('wouldRun:false'));
  assert.ok(evidence.includes('wouldWrite:false'));
  assert.ok(evidence.includes('guarded-runner-execution-preview-only'));
  assert.ok(evidence.includes('real-guarded-runner-execution-wiring-missing'));
}

function assertGuardedRunnerExecutionGateEvidence(evidence) {
  assert.ok(evidence.includes('buildSupervisorLifecycleGuardedRunnerExecutionGate'));
  assert.ok(evidence.includes('test/supervisor-lifecycle-guarded-runner-execution-gate.test.js'));
  assert.ok(evidence.includes('src/agent.js supervisor-lifecycle-guarded-runner-execution-gate'));
  assert.ok(evidence.includes('test/agent-supervisor-lifecycle-guarded-runner-execution-gate.test.js'));
  assert.ok(evidence.includes('POST /api/supervisor-lifecycle-guarded-runner-execution-gate'));
  assert.ok(evidence.includes('test/supervisor-lifecycle-guarded-runner-execution-gate-api.test.js'));
  assert.ok(evidence.includes('supervisor-lifecycle-guarded-runner-execution-gate-button'));
  assert.ok(evidence.includes('src/web/app.js buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel'));
  assert.ok(evidence.includes('test/web-console.test.js supervisor lifecycle guarded runner execution gate'));
  assert.ok(evidence.includes('read token'));
  assert.ok(evidence.includes('API_WRITE_ROUTES exclusion'));
  assert.ok(evidence.includes('supervisor-lifecycle-guarded-runner-execution-gate'));
  assert.ok(evidence.includes('--data-dir <path>'));
  assert.ok(evidence.includes('--execute-requested'));
  assert.ok(evidence.includes('executeRequested:true'));
  assert.ok(evidence.includes('--fail-on-blocked'));
  assert.ok(evidence.includes('executionEligible:false'));
  assert.ok(evidence.includes('wouldExecute:false'));
  assert.ok(evidence.includes('execute-request-missing'));
  assert.ok(evidence.includes('realRunnerWiringReady:false'));
  assert.ok(evidence.includes('buildSupervisorLifecycleGuardedRunnerWiringContract'));
  assert.ok(evidence.includes('runnerWiringContract.state:blocked'));
  assert.ok(evidence.includes('runnerWiringContract.requiredContracts'));
  assert.ok(evidence.includes('runnerWiringContractReady:false'));
  assert.ok(evidence.includes('buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness'));
  assert.ok(evidence.includes('evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy'));
  assert.ok(evidence.includes('executionPolicyReadiness.state:ready'));
  assert.ok(evidence.includes('executionPolicyReady:true'));
  assert.ok(evidence.includes('fail-closed-execution-policy'));
  assert.ok(evidence.includes('policyDecision'));
  assert.ok(evidence.includes('executionEligible:false'));
  assert.ok(!evidence.includes('execution-policy-real-implementation-missing'));
  assert.ok(evidence.includes('buildSupervisorLifecycleGuardedRunnerRegistryReadiness'));
  assert.ok(evidence.includes('resolveSupervisorLifecycleGuardedRunnerRegistry'));
  assert.ok(evidence.includes('runnerRegistryReadiness.state:ready'));
  assert.ok(evidence.includes('runnerRegistryReady:true'));
  assert.ok(evidence.includes('codeOwnedRegistryResolverReady:true'));
  assert.ok(evidence.includes('codeOwnedResolverWired'));
  assert.ok(evidence.includes('runner-registry-ready'));
  assert.ok(evidence.includes('realRunnerImplementationsReady:false'));
  assert.ok(evidence.includes('registryDecision'));
  assert.ok(evidence.includes('resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter'));
  assert.ok(evidence.includes('hostMutationAdapterReadiness.state:ready'));
  assert.ok(evidence.includes('hostMutationAdapterReady:true'));
  assert.ok(evidence.includes('codeOwnedAdapterResolverReady:true'));
  assert.ok(evidence.includes('host-mutation-adapter-ready'));
  assert.ok(evidence.includes('realHostMutationImplementationReady:false'));
  assert.ok(evidence.includes('adapterDecision'));
  assert.ok(evidence.includes('resolveSupervisorLifecycleGuardedRunnerRollbackAnchor'));
  assert.ok(evidence.includes('rollbackAnchorReadiness.state:ready'));
  assert.ok(evidence.includes('rollbackAnchorReady:true'));
  assert.ok(evidence.includes('codeOwnedAnchorResolverReady:true'));
  assert.ok(evidence.includes('codeOwnedResolverWired'));
  assert.ok(evidence.includes('rollback-anchor-ready'));
  assert.ok(evidence.includes('realRollbackAnchorImplementationReady:false'));
  assert.ok(evidence.includes('anchorDecision'));
  assert.ok(evidence.includes('resolveSupervisorLifecycleGuardedRunnerAttemptAudit'));
  assert.ok(evidence.includes('attemptAuditReadiness.state:ready'));
  assert.ok(evidence.includes('attemptAuditReady:true'));
  assert.ok(evidence.includes('codeOwnedAuditResolverReady:true'));
  assert.ok(evidence.includes('attempt-audit-ready'));
  assert.ok(evidence.includes('realAttemptAuditImplementationReady:false'));
  assert.ok(evidence.includes('auditDecision'));
  assert.ok(evidence.includes('readyCount:6'));
  assert.ok(evidence.includes('blockedCount:0'));
  assert.ok(!evidence.includes('rollback-anchor-real-implementation-missing'));
  assert.ok(!evidence.includes('rollbackAnchorReadiness.state:blocked'));
  assert.ok(!evidence.includes('runner-registry-real-implementation-missing'));
  assert.ok(!evidence.includes('runnerRegistryReadiness.state:blocked'));
  assert.ok(evidence.includes('buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness'));
  assert.ok(!evidence.includes('hostMutationAdapterReadiness.state:blocked'));
  assert.ok(!evidence.includes('host-mutation-adapter-real-implementation-missing'));
  assert.ok(evidence.includes('buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness'));
  assert.ok(evidence.includes('buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness'));
  assert.ok(!evidence.includes('attemptAuditReadiness.state:blocked'));
  assert.ok(!evidence.includes('attempt-audit-real-implementation-missing'));
  assert.ok(evidence.includes('buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness'));
  assert.ok(evidence.includes('operatorRecoveryReadiness.state:ready'));
  assert.ok(evidence.includes('operatorRecoveryReady:true'));
  assert.ok(evidence.includes('realOperatorRecoveryImplementationReady:false'));
  assert.ok(evidence.includes('resolveSupervisorLifecycleGuardedRunnerOperatorRecovery'));
  assert.ok(evidence.includes('operator-recovery-ready'));
  assert.ok(evidence.includes('buildSupervisorLifecycleGuardedRunnerRealWiringPlan'));
  assert.ok(evidence.includes('buildSupervisorLifecycleGuardedRunnerRealWiringPlanSeal'));
  assert.ok(evidence.includes('pureWiringOrchestratorPlanReady'));
  assert.ok(evidence.includes('wiringPlan.state:planned'));
  assert.ok(evidence.includes('wiringPlanSeal.state:seal-ready'));
  assert.ok(evidence.includes('mode:plan-only'));
  assert.ok(evidence.includes('real-guarded-runner-execution-wiring-missing'));
}

describe('Gold Readiness Report', () => {
  it('expects LINKE_RELEASE_VERSION to be V1.46', () => {
    assert.strictEqual(LINKE_RELEASE_VERSION, 'V1.46');
  });

  it('expects report.version to be V1.46', () => {
    const report = buildGoldReadinessReport({ now: new Date("2026-07-07T12:00:00.000Z") });
    assert.strictEqual(report.version, 'V1.46');
  });

  it('expects status partial and correct summary count', () => {
    const report = buildGoldReadinessReport({ now: new Date("2026-07-06T12:00:00.000Z") });
    assert.strictEqual(report.status, 'partial');
    assert.deepStrictEqual(report.summary, { ready: 6, partial: 3, blocked: 0, total: 9 });
    assert.equal(report.items.some((item) => item.id === 'cross-lan-connectivity'), false);
    assert.strictEqual(report.items.find((item) => item.id === 'nas-dry-run').status, 'ready');
    assert.strictEqual(report.items.find((item) => item.id === 'real-nas-remote-backup').status, 'ready');
    assert.strictEqual(report.items.find((item) => item.id === 'automation-installation').status, 'partial');
    assert.strictEqual(report.items.find((item) => item.id === 'security-auth').status, 'partial');
    assert.strictEqual(report.items.find((item) => item.id === 'production-hardening').status, 'partial');
  });

  it('freezes all 9 item id/status bit-for-bit (V1.46 keeps 6/3/0/9 while rotating only current version/evidence surface)', () => {
    const report = buildGoldReadinessReport({ now: new Date("2026-07-06T12:00:00.000Z") });
    const snapshot = report.items.map((item) => ({ id: item.id, status: item.status }));
    assert.deepStrictEqual(snapshot, GOLD_ITEM_STATUS_SNAPSHOT);
    assert.strictEqual(report.items.find((i) => i.id === 'production-hardening').status, 'partial');
  });

  it('verifies generatedAt timestamp is parsed from options.now', () => {
    const now = new Date("2026-07-06T12:00:00.000Z");
    const report = buildGoldReadinessReport({ now });
    assert.strictEqual(report.generatedAt, "2026-07-06T12:00:00.000Z");
  });

  it('verifies report items are deterministic and static when now changes', () => {
    const now1 = new Date("2026-07-06T12:00:00.000Z");
    const report1 = buildGoldReadinessReport({ now: now1 });
    const now2 = new Date("2026-07-06T15:30:00.000Z");
    const report2 = buildGoldReadinessReport({ now: now2 });

    assert.strictEqual(report1.generatedAt, "2026-07-06T12:00:00.000Z");
    assert.strictEqual(report2.generatedAt, "2026-07-06T15:30:00.000Z");

    const { generatedAt: g1, ...rest1 } = report1;
    const { generatedAt: g2, ...rest2 } = report2;
    assert.deepStrictEqual(rest1, rest2);
  });

  it('verifies correct list of item IDs', () => {
    const report = buildGoldReadinessReport({ now: new Date("2026-07-06T12:00:00.000Z") });
    const expectedIds = [
      'release-readiness',
      'local-backup-restore',
      'fleet-device-management',
      'version-consistency',
      'nas-dry-run',
      'automation-installation',
      'security-auth',
      'real-nas-remote-backup',
      'production-hardening'
    ];
    const actualIds = report.items.map(item => item.id);
    assert.deepStrictEqual(actualIds, expectedIds);
  });

  it('verifies concrete evidence strings for release-readiness and local-backup-restore', () => {
    const report = buildGoldReadinessReport({ now: new Date("2026-07-06T12:00:00.000Z") });

    const rrItem = report.items.find(item => item.id === 'release-readiness');
    assert.ok(rrItem, 'release-readiness item should exist');
    const rrEvidence = evidenceText(rrItem);
    assert.ok(rrEvidence.includes('test/release-readiness.test.js'));
    assert.ok(rrEvidence.includes('test/agent-release-readiness.test.js'));
    assert.ok(rrEvidence.includes('test/agent-gold-readiness.test.js'));
    assert.ok(rrEvidence.includes('test/health.test.js'));
    assert.ok(rrEvidence.includes('GET /api/health'));
    assert.ok(rrEvidence.includes('GET /api/release-readiness'));
    assert.ok(rrEvidence.includes('GET /api/gold-readiness'));
    assert.ok(rrEvidence.includes('src/agent.js gold-readiness --fail-on-blocked'));

    const lbrItem = report.items.find(item => item.id === 'local-backup-restore');
    assert.ok(lbrItem, 'local-backup-restore item should exist');
    const lbrEvidence = evidenceText(lbrItem);
    assert.ok(lbrEvidence.includes('test/restore.test.js'));
    assert.ok(lbrEvidence.includes('test/restore-dry-run.test.js'));
    assert.ok(lbrEvidence.includes('test/manifest.test.js'));
    assert.ok(lbrEvidence.includes('test/concurrency.test.js'));
    assert.ok(lbrEvidence.includes('test/security.test.js'));
  });

  it('verifies limits and details on fleet-device-management and nas-dry-run items', () => {
    const report = buildGoldReadinessReport({ now: new Date("2026-07-06T12:00:00.000Z") });

    const fleetItem = report.items.find(item => item.id === 'fleet-device-management');
    assert.ok(fleetItem, 'fleet-device-management item should exist');
    const fleetEvidence = evidenceText(fleetItem);
    assert.ok(fleetEvidence.includes('test/heartbeat.test.js'));
    assert.ok(fleetEvidence.includes('test/web-console.test.js'));

    const fleetCombined = `${fleetItem.label || ''} ${fleetItem.nextStep || ''} ${fleetEvidence}`;
    assert.ok(
      fleetCombined.toLowerCase().includes('read-only snapshot') ||
      fleetCombined.toLowerCase().includes('heartbeat-state')
    );
    assert.ok(!fleetCombined.toLowerCase().includes('real-time discovery'));
    assert.ok(!fleetCombined.toLowerCase().includes('production monitoring'));

    const nasItem = report.items.find(item => item.id === 'nas-dry-run');
    assert.ok(nasItem, 'nas-dry-run item should exist');
    const nasEvidence = evidenceText(nasItem);
    assert.ok(nasEvidence.includes('test/nas-dry-run.test.js'));
    assert.ok(nasEvidence.includes('test/agent-nas-dry-run.test.js'));
    assert.ok(nasEvidence.includes('src/agent.js nas-dry-run --readiness-summary'));
    assert.ok(nasEvidence.includes('src/agent.js nas-dry-run --fail-on-blocked'));
    assert.ok(nasEvidence.includes('test/config.test.js'));
    assert.ok(nasEvidence.includes('validateNasCredentialRef'));
    assert.ok(nasEvidence.includes('ALLOWED_NAS_CREDENTIAL_REF_PATTERN'));
    assert.ok(nasEvidence.includes('credentialRefConfigured'));
    assert.ok(nasEvidence.includes('executionGate'));
    assert.ok(nasEvidence.includes('FORBIDDEN_NAS_CREDENTIAL_FIELDS'));
    assert.ok(nasEvidence.includes('15'));
    assert.ok(nasEvidence.includes('readinessSummary'));
    assert.ok(nasEvidence.includes('executionReadiness'));
    assert.ok(nasEvidence.includes('rendering'));
    assert.ok(nasEvidence.includes('DOM tests'));

    // Retained NAS conjunctive evidence atoms — each must be an exact evidence element.
    for (const atom of [
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
    ]) {
      assert.ok(
        nasItem.evidence.includes(atom),
        `nas-dry-run evidence must exact-include retained conjunctive atom: ${atom}`,
      );
    }

    // V1.46 nextStep: explicitly retains V1.45 configuration-only ready evidence,
    // runtime mount verification remains execution-time/pending, three named partial
    // items remain, overall not Gold; stale V0.69 description must be gone.
    assert.ok(
      nasItem.nextStep.includes('V1.46'),
      'nas-dry-run nextStep must state V1.46 retains V1.45 evidence',
    );
    assert.ok(
      nasItem.nextStep.includes('V1.45'),
      'nas-dry-run nextStep must retain V1.45 evidence reference',
    );
    assert.ok(
      nasItem.nextStep.includes('configuration-only ready'),
      'nas-dry-run nextStep must state configuration-only ready',
    );
    assert.ok(
      nasItem.nextStep.includes('runtime mount verification'),
      'nas-dry-run nextStep must mention runtime mount verification',
    );
    assert.ok(
      /execution-time|pending/.test(nasItem.nextStep),
      'nas-dry-run nextStep must state runtime mount verification remains execution-time/pending',
    );
    assert.ok(
      nasItem.nextStep.includes('three partial items remain'),
      'nas-dry-run nextStep must state three partial items remain',
    );
    assert.ok(
      nasItem.nextStep.includes('automation-installation'),
      'nas-dry-run nextStep must name remaining partial item automation-installation',
    );
    assert.ok(
      nasItem.nextStep.includes('security-auth'),
      'nas-dry-run nextStep must name remaining partial item security-auth',
    );
    assert.ok(
      nasItem.nextStep.includes('production-hardening'),
      'nas-dry-run nextStep must name remaining partial item production-hardening',
    );
    assert.ok(
      nasItem.nextStep.includes('not Gold'),
      'nas-dry-run nextStep must state overall not Gold',
    );
    assert.ok(
      !nasItem.nextStep.includes('V0.69'),
      'nas-dry-run nextStep must not keep the stale V0.69 description',
    );

    const nasCombined = `${nasItem.label || ''} ${nasItem.nextStep || ''} ${nasEvidence}`;
    assert.ok(nasCombined.toLowerCase().includes('real nas connection'));
    assert.ok(
      nasCombined.toLowerCase().includes('deny') ||
      nasCombined.toLowerCase().includes('denies') ||
      nasCombined.toLowerCase().includes('no ') ||
      nasCombined.toLowerCase().includes('not supported')
    );
  });

  it('verifies automation-installation has supervisor-status evidence but remains partial', () => {
    const report = buildGoldReadinessReport({ now: new Date("2026-07-06T12:00:00.000Z") });
    const automationItem = report.items.find(item => item.id === 'automation-installation');
    assert.ok(automationItem, 'automation-installation should exist');
    assert.strictEqual(automationItem.status, 'partial');
    const automationEvidence = evidenceText(automationItem);
    assert.ok(automationEvidence.includes('test/agent-run-once.test.js'));
    assert.ok(automationEvidence.includes('test/launchd-dry-run.test.js'));
    assert.ok(automationEvidence.includes('test/agent-supervisor-install-dry-run.test.js'));
    assert.ok(automationEvidence.includes('src/agent.js supervisor-install-dry-run'));
    assert.ok(automationEvidence.includes('src/agent.js buildSupervisorInstallDryRunPlan'));
    assert.ok(automationEvidence.includes('src/agent.js buildSupervisorInstallReadinessSummary'));
    assert.ok(automationEvidence.includes('src/agent.js buildSupervisorInstallCommandPreview'));
    assert.ok(automationEvidence.includes('src/agent.js supervisor-install-dry-run --readiness-summary'));
    assert.ok(automationEvidence.includes('src/agent.js supervisor-install-dry-run --fail-on-blocked'));
    assert.ok(automationEvidence.includes('readinessSummary.state:blocked'));
    assert.ok(automationEvidence.includes('installCommandPreview.state:blocked'));
    assert.ok(automationEvidence.includes('installCommandPreview.actions:wouldRun:false'));
    assert.ok(automationEvidence.includes('GET /api/supervisor-status'));
    assert.ok(automationEvidence.includes('src/server.js buildSupervisorStatusResponse'));
    assert.ok(automationEvidence.includes('src/agent.js supervisor-status'));
    assert.ok(automationEvidence.includes('src/web/app.js buildSupervisorStatusViewModel'));
    assert.ok(automationEvidence.includes('src/web/index.html supervisor-status-panel'));
    assert.ok(automationEvidence.includes('test/web-console.test.js supervisor-status panel'));
    assert.ok(automationEvidence.includes('test/agent-supervisor-status.test.js'));
    assert.ok(automationEvidence.includes('test/health.test.js supervisor-status'));
    assert.ok(automationEvidence.includes('supervisor.state:not_configured'));
    assert.ok(automationEvidence.includes('supervisorInstalled:false'));
    assert.ok(automationEvidence.includes('src/agent.js buildSupervisorInstallPreflight'));
    assert.ok(automationEvidence.includes('installPreflight.state:blocked'));
    assert.ok(automationEvidence.includes('installPreflight.checks:requiredForInstall:true'));
    assert.ok(automationEvidence.includes('src/agent.js buildSupervisorInstallApprovalManifest'));
    assert.ok(automationEvidence.includes('installApprovalManifest.state:blocked'));
    assert.ok(automationEvidence.includes('installApprovalManifest.approval.approved:false'));
    assert.ok(automationEvidence.includes('installApprovalManifest.rollback.available:false'));
    assert.ok(automationEvidence.includes('POST /api/supervisor-install-dry-run'));
    assert.ok(automationEvidence.includes('Web Console supervisor-install-dry-run-panel'));
    assert.ok(automationEvidence.includes('src/web/app.js buildSupervisorInstallDryRunViewModel'));
    assert.ok(automationEvidence.includes('src/agent.js buildSupervisorRollbackUninstallPlan'));
    assert.ok(automationEvidence.includes('rollbackUninstallPlan.state:blocked'));
    assert.ok(automationEvidence.includes('rollbackUninstallPlan.actions:wouldRun:false'));
    assert.ok(automationEvidence.includes('rollbackUninstallPlan Web Console rendering'));
    assert.ok(automationEvidence.includes('buildSupervisorInstallDryRunViewModel rollbackUninstallActions'));
    assert.ok(automationEvidence.includes('buildSupervisorInstallDryRunViewModel rollbackUninstallSafetyLines'));
    assert.ok(automationEvidence.includes('src/supervisor-lifecycle.js'));
    assert.ok(automationEvidence.includes('test/supervisor-lifecycle.test.js'));
    assert.ok(automationEvidence.includes('src/agent.js supervisor-lifecycle-apply'));
    assert.ok(automationEvidence.includes('test/agent-supervisor-lifecycle-apply.test.js'));
    assert.ok(automationEvidence.includes('supervisorLifecycleApply.state:blocked'));
    assert.ok(automationEvidence.includes('executeSupervisorLifecycleApply'));
    assert.ok(automationEvidence.includes('test/supervisor-lifecycle-executor.test.js'));
    assert.ok(automationEvidence.includes('buildSupervisorLifecycleAuditPreview'));
    assert.ok(automationEvidence.includes('test/supervisor-lifecycle-audit-preview.test.js'));
    assert.ok(automationEvidence.includes('buildSupervisorLifecycleApprovalPersistencePreview'));
    assert.ok(automationEvidence.includes('test/supervisor-lifecycle-approval-persistence-preview.test.js'));
    assert.ok(automationEvidence.includes('src/agent.js supervisor-lifecycle-approval-persistence-preview'));
    assert.ok(automationEvidence.includes('test/agent-supervisor-lifecycle-approval-persistence-preview.test.js'));
    assert.ok(automationEvidence.includes('POST /api/supervisor-lifecycle-approval-persistence-preview'));
    assert.ok(automationEvidence.includes('Web Console supervisor-lifecycle-approval-preview-panel'));
    assert.ok(automationEvidence.includes('src/web/app.js buildSupervisorLifecycleApprovalPersistencePreviewViewModel'));
    assert.ok(automationEvidence.includes('test/web-console.test.js supervisor lifecycle approval persistence preview'));
    assert.ok(automationEvidence.includes('src/approval-store.js'));
    assert.ok(automationEvidence.includes('buildSupervisorLifecycleApprovalRecord'));
    assert.ok(automationEvidence.includes('appendSupervisorLifecycleApprovalRecord'));
    assert.ok(automationEvidence.includes('readSupervisorLifecycleApprovalRecords'));
    assert.ok(automationEvidence.includes('test/approval-store.test.js'));
    assert.ok(automationEvidence.includes('src/agent.js supervisor-lifecycle-approval-persist'));
    assert.ok(automationEvidence.includes('test/agent-supervisor-lifecycle-approval-persist.test.js'));
    assert.ok(automationEvidence.includes('POST /api/supervisor-lifecycle-approval-persist'));
    assert.ok(automationEvidence.includes('GET /api/supervisor-lifecycle-approval-records'));
    assert.ok(automationEvidence.includes('test/supervisor-lifecycle-approval-persist-api.test.js'));
    assert.ok(automationEvidence.includes('supervisor-lifecycle-approval-persist-button'));
    assert.ok(automationEvidence.includes('supervisor-lifecycle-approval-records-button'));
    assert.ok(automationEvidence.includes('test/web-console.test.js supervisor lifecycle approval persist'));
    assert.ok(automationEvidence.includes('buildSupervisorLifecycleApplyReadiness'));
    assert.ok(automationEvidence.includes('test/supervisor-lifecycle-apply-readiness.test.js'));
    assert.ok(automationEvidence.includes('src/agent.js supervisor-lifecycle-apply-readiness'));
    assert.ok(automationEvidence.includes('test/agent-supervisor-lifecycle-apply-readiness.test.js'));
    assert.ok(automationEvidence.includes('POST /api/supervisor-lifecycle-apply-readiness'));
    assert.ok(automationEvidence.includes('test/supervisor-lifecycle-apply-readiness-api.test.js'));
    assert.ok(automationEvidence.includes('src/web/app.js buildSupervisorLifecycleApplyReadinessViewModel'));
    assert.ok(automationEvidence.includes('supervisor-lifecycle-apply-readiness-button'));
    assert.ok(automationEvidence.includes('test/web-console.test.js supervisor lifecycle apply readiness'));
    assert.ok(automationEvidence.includes('buildSupervisorLifecycleExecutorReadiness'));
    assert.ok(automationEvidence.includes('test/supervisor-lifecycle-executor-readiness.test.js'));
    assert.ok(automationEvidence.includes('src/agent.js supervisor-lifecycle-executor-readiness'));
    assert.ok(automationEvidence.includes('test/agent-supervisor-lifecycle-executor-readiness.test.js'));
    assert.ok(automationEvidence.includes('POST /api/supervisor-lifecycle-executor-readiness'));
    assert.ok(automationEvidence.includes('test/supervisor-lifecycle-executor-readiness-api.test.js'));
    assert.ok(automationEvidence.includes('src/web/app.js buildSupervisorLifecycleExecutorReadinessViewModel'));
    assert.ok(automationEvidence.includes('supervisor-lifecycle-executor-readiness-button'));
    assert.ok(automationEvidence.includes('test/web-console.test.js supervisor lifecycle executor readiness'));
    assert.ok(automationEvidence.includes('validateSupervisorLifecycleExecutorManifest'));
    assert.ok(automationEvidence.includes('test/supervisor-lifecycle-executor-manifest.test.js'));
    assert.ok(automationEvidence.includes('src/agent.js supervisor-lifecycle-executor-manifest-readiness'));
    assert.ok(automationEvidence.includes('test/agent-supervisor-lifecycle-executor-manifest-readiness.test.js'));
    assert.ok(automationEvidence.includes('POST /api/supervisor-lifecycle-executor-manifest-readiness'));
    assert.ok(automationEvidence.includes('test/supervisor-lifecycle-executor-manifest-readiness-api.test.js'));
    assert.ok(automationEvidence.includes('executorManifestReadiness.state:blocked'));
    assert.ok(automationEvidence.includes('executorManifestReadiness.executorReady:false'));
    assert.ok(automationEvidence.includes('guarded-executor-runner-missing'));
    assert.ok(automationEvidence.includes('supervisor-lifecycle-executor-manifest-readiness-button'));
    assert.ok(automationEvidence.includes('src/web/app.js buildSupervisorLifecycleExecutorManifestReadinessViewModel'));
    assert.ok(automationEvidence.includes('test/web-console.test.js supervisor lifecycle executor manifest readiness'));
    assert.ok(automationEvidence.includes('buildSupervisorLifecycleGuardedRunnerReadiness'));
    assert.ok(automationEvidence.includes('test/supervisor-lifecycle-guarded-runner-readiness.test.js'));
    assert.ok(automationEvidence.includes('supervisor-lifecycle-guarded-runner-readiness'));
    assert.ok(automationEvidence.includes('guarded-runner-execution-disabled'));
    assert.ok(automationEvidence.includes('src/agent.js supervisor-lifecycle-guarded-runner-readiness'));
    assert.ok(automationEvidence.includes('test/agent-supervisor-lifecycle-guarded-runner-readiness.test.js'));
    assert.ok(automationEvidence.includes('--runner-binding <path>'));
    assert.ok(automationEvidence.includes('POST /api/supervisor-lifecycle-guarded-runner-readiness'));
    assert.ok(automationEvidence.includes('test/supervisor-lifecycle-guarded-runner-readiness-api.test.js'));
    assert.ok(automationEvidence.includes('supervisor-lifecycle-guarded-runner-readiness-button'));
    assert.ok(automationEvidence.includes('src/web/app.js buildSupervisorLifecycleGuardedRunnerReadinessViewModel'));
    assert.ok(automationEvidence.includes('test/web-console.test.js supervisor lifecycle guarded runner readiness'));
    assertGuardedRunnerExecutionPreviewEvidence(automationEvidence);
    assertGuardedRunnerExecutionGateEvidence(automationEvidence);
    assert.deepStrictEqual(
      automationItem.evidence.slice(0, V146_AUTOMATION_EVIDENCE.length),
      [...V146_AUTOMATION_EVIDENCE],
      'automation-installation must prepend exact V1.46 LaunchAgent evidence atoms',
    );
    assert.ok(automationItem.nextStep.includes('V1.46'));
    assert.ok(automationItem.nextStep.includes('Gold remains partial 6/3/0/9'));
    assert.ok(automationItem.nextStep.includes('not installation complete'));
    assert.ok(automationItem.nextStep.includes('no real launchctl'));
    assert.ok(automationItem.nextStep.includes('no clean-Mac lifecycle evidence'));
    assert.ok(automationItem.nextStep.includes('code-stage only'));
    assert.ok(automationItem.nextStep.includes('conditional fake host adapters'));
    assert.ok(automationItem.nextStep.includes('real Node owner SIGKILL/recovery child'));
    assert.ok(automationItem.nextStep.includes('manual repair attestation pure closeout'));
    assert.ok(automationItem.nextStep.includes('frozen compensation/crash windows'));
    assert.ok(automationItem.nextStep.includes('V1.33'));
    assert.ok(automationItem.nextStep.includes('V1.32'));
    assert.ok(automationItem.nextStep.includes('V1.31'));
    assert.ok(automationItem.nextStep.includes('buildSupervisorLifecycleGuardedRunnerCapabilityInjectionReadiness'));
    assert.ok(automationItem.nextStep.includes('resolveSupervisorLifecycleGuardedRunnerCapabilityInjection'));
    assert.ok(automationItem.nextStep.includes('authorizeSupervisorLifecycleGuardedRunnerCapabilityMode'));
    assert.ok(automationItem.nextStep.includes('invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun'));
    assert.ok(automationItem.nextStep.includes('invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof'));
    assert.ok(automationItem.nextStep.includes('invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof'));
    assert.ok(automationItem.nextStep.includes('realRenderCapabilityImplementationReady:true'));
    assert.ok(automationItem.nextStep.includes('realStatusCapabilityImplementationReady:true'));
    assert.ok(automationItem.nextStep.includes('capability-real-status-completed'));
    assert.ok(automationItem.nextStep.includes('pureCapabilityInjectionReady'));
    assert.ok(automationItem.nextStep.includes('dryRunCapabilityRegistryReady'));
    assert.ok(automationItem.nextStep.includes('executeCapabilityAuthorized:false'));
    assert.ok(automationItem.nextStep.includes('realCapabilityImplementationsReady:false'));
    assert.ok(automationItem.nextStep.includes('capability-dry-run-receipt'));
    assert.ok(automationItem.nextStep.includes('capability-execute-denied-receipt'));
    assert.ok(automationItem.nextStep.includes('capability-real-implementation-receipt'));
    assert.ok(automationItem.nextStep.includes('hostSideEffectOccurred:false'));
    assert.ok(automationItem.nextStep.includes('hostObservationOccurred:true'));
    assert.ok(automationItem.nextStep.includes('hostMutationOccurred:false'));
    assert.ok(automationItem.nextStep.includes('single-gate'));
    assert.ok(automationItem.nextStep.includes('NOT wiringPlanSeal'));
    assert.ok(automationItem.nextStep.includes('realRunnerWiringReady:false'));
    assert.ok(automationItem.nextStep.includes('Gold remains blocked'));
    assert.ok(
      automationItem.nextStep.includes('V2.0') &&
        (automationItem.nextStep.includes('cross-LAN') || automationItem.nextStep.includes('跨局域网')),
    );
    assert.ok(automationEvidence.includes('buildSupervisorLifecycleGuardedRunnerCapabilityInjectionReadiness'));
    assert.ok(automationEvidence.includes('resolveSupervisorLifecycleGuardedRunnerCapabilityInjection'));
    assert.ok(automationEvidence.includes('authorizeSupervisorLifecycleGuardedRunnerCapabilityMode'));
    assert.ok(automationEvidence.includes('invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun'));
    assert.ok(automationEvidence.includes('invokeSupervisorLifecycleGuardedRunnerCapabilityRealRenderProof'));
    assert.ok(automationEvidence.includes('invokeSupervisorLifecycleGuardedRunnerCapabilityRealStatusProof'));
    assert.ok(automationEvidence.includes('pureCapabilityInjectionReady'));
    assert.ok(automationEvidence.includes('dryRunCapabilityRegistryReady'));
    assert.ok(automationEvidence.includes('realRenderCapabilityImplementationReady:true'));
    assert.ok(automationEvidence.includes('realStatusCapabilityImplementationReady:true'));
    assert.ok(automationEvidence.includes('capability-real-status-completed'));
    assert.ok(automationEvidence.includes('executeCapabilityAuthorized:false'));
    assert.ok(automationEvidence.includes('realCapabilityImplementationsReady:false'));
    assert.ok(automationEvidence.includes('capability-dry-run-receipt'));
    assert.ok(automationEvidence.includes('capability-execute-denied-receipt'));
    assert.ok(automationEvidence.includes('capability-real-implementation-receipt'));
    assert.ok(automationEvidence.includes('hostSideEffectOccurred:false'));
    assert.ok(automationEvidence.includes('hostObservationOccurred:true'));
    assert.ok(automationEvidence.includes('hostMutationOccurred:false'));
    assert.ok(automationItem.nextStep.includes('V1.30'));
    assert.ok(automationItem.nextStep.includes('buildSupervisorLifecycleGuardedRunnerRealWiringPlan'));
    assert.ok(automationItem.nextStep.includes('buildSupervisorLifecycleGuardedRunnerRealWiringPlanSeal'));
    assert.ok(automationItem.nextStep.includes('pureWiringOrchestratorPlanReady'));
    assert.ok(automationItem.nextStep.includes('wiringPlan.state:planned'));
    assert.ok(automationItem.nextStep.includes('wiringPlanSeal.state:seal-ready'));
    assert.ok(automationItem.nextStep.includes('mode:plan-only'));
    assert.ok(automationItem.nextStep.includes('capability injection'));
    assert.ok(automationItem.nextStep.includes('V1.29'));
    assert.ok(automationItem.nextStep.includes('resolveSupervisorLifecycleGuardedRunnerOperatorRecovery'));
    assert.ok(automationItem.nextStep.includes('real guarded runner'));
    assert.ok(automationItem.nextStep.includes('V1.28'));
    assert.ok(automationItem.nextStep.includes('resolveSupervisorLifecycleGuardedRunnerAttemptAudit'));
    assert.ok(automationItem.nextStep.includes('V1.27'));
    assert.ok(automationItem.nextStep.includes('resolveSupervisorLifecycleGuardedRunnerRollbackAnchor'));
    assert.ok(automationItem.nextStep.includes('attempt-audit'));
    assert.ok(automationItem.nextStep.includes('V1.26'));
    assert.ok(automationItem.nextStep.includes('resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter'));
    assert.ok(automationItem.nextStep.includes('rollback-anchor'));
    assert.ok(automationItem.nextStep.includes('V1.25'));
    assert.ok(automationItem.nextStep.includes('resolveSupervisorLifecycleGuardedRunnerRegistry'));
    assert.ok(automationItem.nextStep.includes('V1.24'));
    assert.ok(automationItem.nextStep.includes('evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy'));
    assert.ok(automationItem.nextStep.includes('runner registry'));
    assert.ok(automationItem.nextStep.includes('V1.22'));
    assert.ok(automationItem.nextStep.includes('V1.21'));
    assert.ok(automationItem.nextStep.includes('V1.20'));
    assert.ok(automationItem.nextStep.includes('V1.19'));
    assert.ok(automationItem.nextStep.includes('V1.18'));
    assert.ok(automationItem.nextStep.includes('V1.17'));
    assert.ok(automationItem.nextStep.includes('V1.16'));
    assert.ok(automationItem.nextStep.includes('V1.15'));
    assert.ok(automationItem.nextStep.includes('V1.14'));
    assert.ok(automationItem.nextStep.includes('V1.13'));
    assert.ok(automationItem.nextStep.includes('V1.12'));
    assert.ok(automationItem.nextStep.includes('V1.11'));
    assert.ok(automationItem.nextStep.includes('V1.10'));
    assert.ok(automationItem.nextStep.includes('V1.09'));
    assert.ok(automationItem.nextStep.includes('V1.08'));
    assert.ok(automationItem.nextStep.includes('V1.07'));
    assert.ok(automationItem.nextStep.includes('V1.06'));
    assert.ok(automationItem.nextStep.includes('V1.05'));
    assert.ok(automationItem.nextStep.includes('V1.04'));
    assert.ok(automationItem.nextStep.includes('V1.03'));
    assert.ok(automationItem.nextStep.includes('V1.02'));
    assert.ok(automationItem.nextStep.includes('V1.01'));
    assert.ok(automationItem.nextStep.includes('V1.00'));
    assert.ok(automationItem.nextStep.includes('V0.99'));
    assert.ok(automationItem.nextStep.includes('V0.98'));
    assert.ok(automationItem.nextStep.includes('V0.97'));
    assert.ok(automationItem.nextStep.includes('V0.96'));
    assert.ok(automationItem.nextStep.includes('V0.95'));
    assert.ok(automationItem.nextStep.includes('V0.94'));
    assert.ok(automationItem.nextStep.includes('V0.93'));
    assert.ok(automationItem.nextStep.includes('V0.92'));
    assert.ok(automationItem.nextStep.includes('V0.91'));
    assert.ok(automationItem.nextStep.includes('V0.90'));
    assert.ok(automationItem.nextStep.includes('V0.89'));
    assert.ok(automationItem.nextStep.includes('rollbackUninstallPlan'));
    assert.ok(automationItem.nextStep.includes('Web Console'));
    assert.ok(automationItem.nextStep.includes('approval'));
    assert.ok(automationItem.nextStep.includes('Gold remains blocked') || automationItem.nextStep.includes('real NAS'));
    assert.ok(automationItem.nextStep.includes('rollback'));
    assert.ok(automationItem.nextStep.includes('preflight'));
    assert.ok(automationItem.nextStep.includes('real installer'));
    assert.match(automationItem.nextStep, /readiness|gate|dry-run|not_configured|installer|launchd|watchdog|monitoring|managed daemon/i);
  });

  it('verifies security-auth and production-hardening are partial while real-nas-remote-backup is ready', () => {
    const report = buildGoldReadinessReport({ now: new Date("2026-07-06T12:00:00.000Z") });
    const securityItem = report.items.find(item => item.id === 'security-auth');
    assert.ok(securityItem, 'security-auth should exist');
    assert.strictEqual(securityItem.status, 'partial');
    const securityEvidence = evidenceText(securityItem);
    assert.ok(securityEvidence.includes('test/security.test.js'));
    assert.ok(securityEvidence.includes('test/agent-health.test.js'));
    assert.ok(securityEvidence.includes('test/web-console.test.js'));
    assert.ok(securityEvidence.includes('src/web/app.js'));
    assert.ok(securityEvidence.includes('Authorization: Bearer'));
    assert.ok(securityEvidence.includes('LINKE_READ_TOKEN'));
    assert.ok(securityEvidence.includes('LINKE_WRITE_TOKEN'));
    assert.ok(securityEvidence.includes('403 Forbidden'));
    assert.ok(securityEvidence.includes('auth.forbidden'));
    assert.ok(securityEvidence.includes('GET /api/auth-status'));
    assert.ok(securityEvidence.includes('src/agent.js auth-status'));
    assert.ok(securityEvidence.includes('buildAuthStatusResponse'));
    assert.ok(securityEvidence.includes('test/agent-auth-status.test.js'));
    assert.ok(securityEvidence.includes('API_WRITE_ROUTES'));
    assert.ok(securityEvidence.includes('isApiWriteRoute'));
    assert.ok(securityEvidence.includes('formatApiRoute'));
    assert.doesNotMatch(securityItem.nextStep, /Web token UX/i);
    assert.match(securityItem.nextStep, /authorization|secret|production/i);

    const hardeningItem = report.items.find(item => item.id === 'production-hardening');
    assert.ok(hardeningItem, 'production-hardening should exist');
    assert.strictEqual(hardeningItem.status, 'partial');
    const hardeningEvidence = evidenceText(hardeningItem);
    assert.ok(hardeningEvidence.includes('MAX_JSON_BODY_BYTES'));
    assert.ok(hardeningEvidence.includes('LINKE_RESTORE_ROOT'));
    assert.ok(hardeningEvidence.includes('resolveRestoreTargetPath'));
    assert.ok(hardeningEvidence.includes('RestoreTargetError'));
    assert.ok(hardeningEvidence.includes('O_NOFOLLOW'));
    assert.ok(hardeningEvidence.includes('src/audit-log.js'));
    assert.ok(hardeningEvidence.includes('GET /api/audit-log'));
    assert.ok(hardeningEvidence.includes('test/agent-audit-log.test.js'));
    assert.ok(hardeningEvidence.includes('src/agent.js audit-log'));
    assert.ok(hardeningEvidence.includes('src/web/app.js buildAuditLogViewModel'));
    assert.ok(hardeningEvidence.includes('test/web-console.test.js audit-log panel'));
    assert.ok(hardeningEvidence.includes('LINKE_AUDIT_MAX_EVENTS'));
    assert.ok(hardeningEvidence.includes('Audit retention newest events'));
    assert.ok(hardeningEvidence.includes('src/rate-limit.js'));
    assert.ok(hardeningEvidence.includes('LINKE_RATE_LIMIT_PER_MINUTE'));
    assert.ok(hardeningEvidence.includes('429 Rate limit exceeded'));
    assert.ok(hardeningEvidence.includes('test/audit-log.test.js'));
    assert.ok(hardeningEvidence.includes('test/rate-limit.test.js'));
    assert.ok(hardeningEvidence.includes('Internal Server Error'));
    assert.ok(hardeningEvidence.includes('test/security.test.js'));
    assert.ok(hardeningEvidence.includes('test/restore.test.js'));
    assert.ok(hardeningEvidence.includes('test/restore-dry-run.test.js'));
    assert.ok(hardeningEvidence.includes('GET /api/hardening-status'));
    assert.ok(hardeningEvidence.includes('src/server.js buildHardeningStatusResponse'));
    assert.ok(hardeningEvidence.includes('test/agent-hardening-status.test.js'));
    assert.ok(hardeningEvidence.includes('src/agent.js hardening-status'));
    assert.ok(hardeningEvidence.includes('GET /api/supervisor-status'));
    assert.ok(hardeningEvidence.includes('src/server.js buildSupervisorStatusResponse'));
    assert.ok(hardeningEvidence.includes('test/agent-supervisor-status.test.js'));
    assert.ok(hardeningEvidence.includes('src/agent.js supervisor-status'));
    assert.ok(hardeningEvidence.includes('test/agent-supervisor-install-dry-run.test.js'));
    assert.ok(hardeningEvidence.includes('src/agent.js supervisor-install-dry-run'));
    assert.ok(hardeningEvidence.includes('src/agent.js buildSupervisorInstallDryRunPlan'));
    assert.ok(hardeningEvidence.includes('src/agent.js buildSupervisorInstallReadinessSummary'));
    assert.ok(hardeningEvidence.includes('src/agent.js buildSupervisorInstallCommandPreview'));
    assert.ok(hardeningEvidence.includes('src/agent.js supervisor-install-dry-run --readiness-summary'));
    assert.ok(hardeningEvidence.includes('src/agent.js supervisor-install-dry-run --fail-on-blocked'));
    assert.ok(hardeningEvidence.includes('readinessSummary.state:blocked'));
    assert.ok(hardeningEvidence.includes('installCommandPreview.state:blocked'));
    assert.ok(hardeningEvidence.includes('installCommandPreview.actions:wouldRun:false'));
    assert.ok(hardeningEvidence.includes('supervisor.state:not_configured'));
    assert.ok(hardeningEvidence.includes('supervisorInstalled:false'));
    assert.ok(hardeningEvidence.includes('src/web/app.js buildSupervisorStatusViewModel'));
    assert.ok(hardeningEvidence.includes('src/web/index.html supervisor-status-panel'));
    assert.ok(hardeningEvidence.includes('test/web-console.test.js supervisor-status panel'));
    assert.ok(hardeningEvidence.includes('src/web/app.js buildHardeningStatusViewModel'));
    assert.ok(hardeningEvidence.includes('test/web-console.test.js hardening-status panel'));
    assert.ok(hardeningEvidence.includes('src/agent.js buildSupervisorInstallPreflight'));
    assert.ok(hardeningEvidence.includes('installPreflight.state:blocked'));
    assert.ok(hardeningEvidence.includes('src/agent.js buildSupervisorInstallApprovalManifest'));
    assert.ok(hardeningEvidence.includes('installApprovalManifest.state:blocked'));
    assert.ok(hardeningEvidence.includes('installApprovalManifest.approval.approved:false'));
    assert.ok(hardeningEvidence.includes('installApprovalManifest.rollback.available:false'));
    assert.ok(hardeningEvidence.includes('POST /api/supervisor-install-dry-run'));
    assert.ok(hardeningEvidence.includes('Web Console supervisor-install-dry-run-panel'));
    assert.ok(hardeningEvidence.includes('src/web/app.js buildSupervisorInstallDryRunViewModel'));
    assert.ok(hardeningEvidence.includes('src/agent.js buildSupervisorRollbackUninstallPlan'));
    assert.ok(hardeningEvidence.includes('rollbackUninstallPlan.state:blocked'));
    assert.ok(hardeningEvidence.includes('rollbackUninstallPlan.actions:wouldRun:false'));
    assert.ok(hardeningEvidence.includes('rollbackUninstallPlan Web Console rendering'));
    assert.ok(hardeningEvidence.includes('buildSupervisorInstallDryRunViewModel rollbackUninstallActions'));
    assert.ok(hardeningEvidence.includes('buildSupervisorInstallDryRunViewModel rollbackUninstallSafetyLines'));
    assert.ok(hardeningEvidence.includes('src/supervisor-lifecycle.js'));
    assert.ok(hardeningEvidence.includes('test/supervisor-lifecycle.test.js'));
    assert.ok(hardeningEvidence.includes('src/agent.js supervisor-lifecycle-apply'));
    assert.ok(hardeningEvidence.includes('test/agent-supervisor-lifecycle-apply.test.js'));
    assert.ok(hardeningEvidence.includes('supervisorLifecycleApply.state:blocked'));
    assert.ok(hardeningEvidence.includes('executeSupervisorLifecycleApply'));
    assert.ok(hardeningEvidence.includes('test/supervisor-lifecycle-executor.test.js'));
    assert.ok(hardeningEvidence.includes('buildSupervisorLifecycleAuditPreview'));
    assert.ok(hardeningEvidence.includes('test/supervisor-lifecycle-audit-preview.test.js'));
    assert.ok(hardeningEvidence.includes('buildSupervisorLifecycleApprovalPersistencePreview'));
    assert.ok(hardeningEvidence.includes('test/supervisor-lifecycle-approval-persistence-preview.test.js'));
    assert.ok(hardeningEvidence.includes('src/agent.js supervisor-lifecycle-approval-persistence-preview'));
    assert.ok(hardeningEvidence.includes('test/agent-supervisor-lifecycle-approval-persistence-preview.test.js'));
    assert.ok(hardeningEvidence.includes('POST /api/supervisor-lifecycle-approval-persistence-preview'));
    assert.ok(hardeningEvidence.includes('Web Console supervisor-lifecycle-approval-preview-panel'));
    assert.ok(hardeningEvidence.includes('src/web/app.js buildSupervisorLifecycleApprovalPersistencePreviewViewModel'));
    assert.ok(hardeningEvidence.includes('test/web-console.test.js supervisor lifecycle approval persistence preview'));
    assert.ok(hardeningEvidence.includes('src/approval-store.js'));
    assert.ok(hardeningEvidence.includes('buildSupervisorLifecycleApprovalRecord'));
    assert.ok(hardeningEvidence.includes('appendSupervisorLifecycleApprovalRecord'));
    assert.ok(hardeningEvidence.includes('readSupervisorLifecycleApprovalRecords'));
    assert.ok(hardeningEvidence.includes('test/approval-store.test.js'));
    assert.ok(hardeningEvidence.includes('src/agent.js supervisor-lifecycle-approval-persist'));
    assert.ok(hardeningEvidence.includes('test/agent-supervisor-lifecycle-approval-persist.test.js'));
    assert.ok(hardeningEvidence.includes('POST /api/supervisor-lifecycle-approval-persist'));
    assert.ok(hardeningEvidence.includes('GET /api/supervisor-lifecycle-approval-records'));
    assert.ok(hardeningEvidence.includes('test/supervisor-lifecycle-approval-persist-api.test.js'));
    assert.ok(hardeningEvidence.includes('supervisor-lifecycle-approval-persist-button'));
    assert.ok(hardeningEvidence.includes('supervisor-lifecycle-approval-records-button'));
    assert.ok(hardeningEvidence.includes('test/web-console.test.js supervisor lifecycle approval persist'));
    assert.ok(hardeningEvidence.includes('buildSupervisorLifecycleApplyReadiness'));
    assert.ok(hardeningEvidence.includes('test/supervisor-lifecycle-apply-readiness.test.js'));
    assert.ok(hardeningEvidence.includes('src/agent.js supervisor-lifecycle-apply-readiness'));
    assert.ok(hardeningEvidence.includes('test/agent-supervisor-lifecycle-apply-readiness.test.js'));
    assert.ok(hardeningEvidence.includes('POST /api/supervisor-lifecycle-apply-readiness'));
    assert.ok(hardeningEvidence.includes('test/supervisor-lifecycle-apply-readiness-api.test.js'));
    assert.ok(hardeningEvidence.includes('src/web/app.js buildSupervisorLifecycleApplyReadinessViewModel'));
    assert.ok(hardeningEvidence.includes('supervisor-lifecycle-apply-readiness-button'));
    assert.ok(hardeningEvidence.includes('test/web-console.test.js supervisor lifecycle apply readiness'));
    assert.ok(hardeningEvidence.includes('validateSupervisorLifecycleExecutorManifest'));
    assert.ok(hardeningEvidence.includes('test/supervisor-lifecycle-executor-manifest.test.js'));
    assert.ok(hardeningEvidence.includes('src/agent.js supervisor-lifecycle-executor-manifest-readiness'));
    assert.ok(hardeningEvidence.includes('test/agent-supervisor-lifecycle-executor-manifest-readiness.test.js'));
    assert.ok(hardeningEvidence.includes('POST /api/supervisor-lifecycle-executor-manifest-readiness'));
    assert.ok(hardeningEvidence.includes('test/supervisor-lifecycle-executor-manifest-readiness-api.test.js'));
    assert.ok(hardeningEvidence.includes('executorManifestReadiness.state:blocked'));
    assert.ok(hardeningEvidence.includes('executorManifestReadiness.executorReady:false'));
    assert.ok(hardeningEvidence.includes('guarded-executor-runner-missing'));
    assert.ok(hardeningEvidence.includes('supervisor-lifecycle-executor-manifest-readiness-button'));
    assert.ok(hardeningEvidence.includes('src/web/app.js buildSupervisorLifecycleExecutorManifestReadinessViewModel'));
    assert.ok(hardeningEvidence.includes('test/web-console.test.js supervisor lifecycle executor manifest readiness'));
    assert.ok(hardeningEvidence.includes('buildSupervisorLifecycleGuardedRunnerReadiness'));
    assert.ok(hardeningEvidence.includes('test/supervisor-lifecycle-guarded-runner-readiness.test.js'));
    assert.ok(hardeningEvidence.includes('supervisor-lifecycle-guarded-runner-readiness'));
    assert.ok(hardeningEvidence.includes('guarded-runner-execution-disabled'));
    assert.ok(hardeningEvidence.includes('src/agent.js supervisor-lifecycle-guarded-runner-readiness'));
    assert.ok(hardeningEvidence.includes('test/agent-supervisor-lifecycle-guarded-runner-readiness.test.js'));
    assert.ok(hardeningEvidence.includes('--runner-binding <path>'));
    assert.ok(hardeningEvidence.includes('POST /api/supervisor-lifecycle-guarded-runner-readiness'));
    assert.ok(hardeningEvidence.includes('test/supervisor-lifecycle-guarded-runner-readiness-api.test.js'));
    assert.ok(hardeningEvidence.includes('supervisor-lifecycle-guarded-runner-readiness-button'));
    assert.ok(hardeningEvidence.includes('src/web/app.js buildSupervisorLifecycleGuardedRunnerReadinessViewModel'));
    assert.ok(hardeningEvidence.includes('test/web-console.test.js supervisor lifecycle guarded runner readiness'));
    assertGuardedRunnerExecutionPreviewEvidence(hardeningEvidence);
    assertGuardedRunnerExecutionGateEvidence(hardeningEvidence);
    // V1.43 honesty: explicit crash-recoverable audit integrity rotation
    // foundation; local/manual evidence only; G0c real-LAN evidence absent;
    // T6d.3 still partial; Gold remains blocked 4/4/1/9.
    assert.ok(
      hardeningEvidence.includes(V143_SIGNATURE),
      'production-hardening evidence must include V1.43 exact signature ceiling',
    );
    assert.ok(
      hardeningItem.evidence.includes(V143_SIGNATURE)
        && hardeningEvidence.indexOf(V143_SIGNATURE) < hardeningEvidence.indexOf(V142_SIGNATURE),
      'production-hardening evidence must place V1.43 signature before V1.42 historical base',
    );
    // V1.43 rotation foundation modules / tests / CLI as honest local manual evidence
    assert.ok(
      hardeningItem.evidence.includes('src/audit-integrity-rotation.js'),
      'production-hardening evidence must exact-include src/audit-integrity-rotation.js',
    );
    assert.ok(
      hardeningItem.evidence.includes('src/audit-integrity-rotation-state.js'),
      'production-hardening evidence must exact-include src/audit-integrity-rotation-state.js',
    );
    assert.ok(
      hardeningEvidence.includes('test/audit-integrity-rotation.test.js'),
      'production-hardening evidence must include test/audit-integrity-rotation.test.js',
    );
    assert.ok(
      hardeningEvidence.includes('test/audit-integrity-rotation-state.test.js'),
      'production-hardening evidence must include test/audit-integrity-rotation-state.test.js',
    );
    assert.ok(
      hardeningEvidence.includes('test/audit-integrity-rotation-scans.test.js'),
      'production-hardening evidence must include test/audit-integrity-rotation-scans.test.js',
    );
    assert.ok(
      hardeningEvidence.includes('test/agent-audit-integrity-rotation.test.js'),
      'production-hardening evidence must include test/agent-audit-integrity-rotation.test.js',
    );
    assert.ok(
      hardeningEvidence.includes('src/agent.js audit-integrity-rotate'),
      'production-hardening evidence must name Agent CLI audit-integrity-rotate',
    );
    assert.ok(
      hardeningEvidence.includes('src/agent.js audit-integrity-rotation-recover'),
      'production-hardening evidence must name Agent CLI audit-integrity-rotation-recover',
    );
    assert.ok(
      /explicit manual rotation/i.test(hardeningEvidence),
      'production-hardening evidence must state explicit manual rotation',
    );
    assert.ok(
      hardeningItem.evidence.some((e) => /not WORM|no WORM/i.test(String(e))),
      'production-hardening evidence must carry a direct WORM denial element',
    );
    assert.ok(
      evidenceElementsDirectlyNegatePhrase(hardeningItem.evidence, 'worm'),
      'production-hardening evidence elements: worm must be directly negated',
    );
    // V1.42 honesty: G0c auto harness delivered; real-LAN evidence absent; T6d.3 still partial
    assert.ok(
      hardeningEvidence.includes(V142_SIGNATURE),
      'production-hardening evidence must retain V1.42 exact signature as historical base',
    );
    assert.ok(
      hardeningItem.evidence.includes(V142_SIGNATURE)
        || hardeningItem.evidence[0] === V142_SIGNATURE
        || hardeningEvidence.indexOf(V142_SIGNATURE) < hardeningEvidence.indexOf(V141_SIGNATURE),
      'production-hardening evidence must place V1.42 signature before V1.41 historical base',
    );
    assert.ok(
      hardeningEvidence.includes('G0c real-LAN evidence absent')
        || hardeningEvidence.includes('real-LAN evidence absent'),
      'production-hardening evidence must state real-LAN evidence absent',
    );
    assert.ok(
      hardeningEvidence.includes(V141_SIGNATURE),
      'production-hardening evidence must retain V1.41 historical signature',
    );
    assert.ok(
      hardeningEvidence.includes(V140_SIGNATURE),
      'production-hardening evidence must retain V1.40 historical signature',
    );
    // V1.40 process-lock locus + tests
    assert.ok(
      hardeningItem.evidence.includes('src/audit-integrity-process-lock.js'),
      'production-hardening evidence must exact-include src/audit-integrity-process-lock.js',
    );
    assert.ok(
      hardeningItem.evidence.includes('src/audit-integrity-write-queue.js'),
      'production-hardening evidence must exact-include src/audit-integrity-write-queue.js',
    );
    assert.ok(
      hardeningEvidence.includes('test/audit-integrity-process-lock.test.js'),
      'production-hardening evidence must include test/audit-integrity-process-lock.test.js',
    );
    assert.ok(
      hardeningEvidence.includes('test/audit-integrity-process-lock-queue.test.js'),
      'production-hardening evidence must include test/audit-integrity-process-lock-queue.test.js',
    );
    assert.ok(
      hardeningEvidence.includes('test/audit-integrity-multiprocess-lock.test.js'),
      'production-hardening evidence must include test/audit-integrity-multiprocess-lock.test.js',
    );
    assert.ok(
      hardeningEvidence.includes('test/audit-integrity-process-lock-scans.test.js'),
      'production-hardening evidence must include test/audit-integrity-process-lock-scans.test.js',
    );
    assert.ok(
      hardeningEvidence.includes('/usr/bin/lockf') || /lockf fd form/i.test(hardeningEvidence),
      'production-hardening evidence must name /usr/bin/lockf fd form',
    );
    assert.ok(
      /exact -s -t 5 3|-s -t 5 3/i.test(hardeningEvidence),
      'production-hardening evidence must name exact -s -t 5 3 semantics',
    );
    assert.ok(
      /same-dataDir local multi-process exclusive serialization|local multi-process exclusive/i.test(hardeningEvidence),
      'production-hardening evidence must claim same-dataDir local multi-process exclusive serialization',
    );
    assert.ok(
      /acquire→lease→task→expire→release|acquire.?lease.?task.?expire.?release/i.test(hardeningEvidence),
      'production-hardening evidence must name queue acquire→lease→task→expire→release',
    );
    assert.ok(
      /SIGKILL/i.test(hardeningEvidence) && /inode/i.test(hardeningEvidence),
      'production-hardening evidence must mention holder/waiter SIGKILL and inode permanence',
    );
    // V1.40 release/close failure ops boundary — exact evidence atoms (RED→GREEN honesty)
    assert.ok(
      hardeningItem.evidence.includes(RELEASE_CLOSE_FAIL_CLOSES),
      'production-hardening evidence must exact-include "release/close failure fail-closes"',
    );
    assert.ok(
      hardeningItem.evidence.includes(TASK_MUTATION_MAY_ALREADY_APPLIED),
      'production-hardening evidence must exact-include "task mutation may already be applied"',
    );
    assert.ok(
      hardeningItem.evidence.includes(CALLER_RETRY_NO_IDEMPOTENT_EXACTLY_ONCE),
      'production-hardening evidence must exact-include "caller retry has no idempotent/exactly-once guarantee"',
    );
    assert.ok(
      hardeningItem.evidence.includes(NO_DETERMINISTIC_IN_BAND_FD_RECLAIM),
      'production-hardening evidence must exact-include "no deterministic in-band fd reclaim before process exit"',
    );
    // Forbid absolute overclaims on V1.40 current evidence surface (not historical segments)
    {
      const currentEvidenceText = hardeningItem.evidence
        .filter((e) => {
          const s = String(e);
          return (
            !s.startsWith('V1.39 ')
            && !s.startsWith('V1.38 ')
            && !s.startsWith('V1.37 ')
            && !s.startsWith('V1.36 ')
            && !s.startsWith('V1.35 ')
            && !s.startsWith('V1.34 ')
          );
        })
        .join(' ')
        .toLowerCase();
      for (const phrase of FORBIDDEN_ABSOLUTE_V140_PHRASES) {
        assert.ok(
          !currentEvidenceText.includes(phrase.toLowerCase()),
          `production-hardening V1.40 current evidence must not claim absolute "${phrase}"`,
        );
      }
    }
    assert.ok(
      /local only/i.test(hardeningEvidence),
      'production-hardening evidence must state local only',
    );
    assert.ok(
      /not distributed|no distributed/i.test(hardeningEvidence),
      'production-hardening evidence must deny distributed',
    );
    assert.ok(
      /not cross-host|no cross-host/i.test(hardeningEvidence),
      'production-hardening evidence must deny cross-host',
    );
    assert.ok(
      /network FS|network-FS/i.test(hardeningEvidence)
        && /not auto-detect|not auto-detected|not auto-reject|not auto-rejected|not delivered/i.test(hardeningEvidence),
      'production-hardening evidence must bound network FS detection/correctness as not delivered',
    );
    // Stale standalone exact elements forbidden (historical prose may still mention past fact)
    assert.ok(
      !hardeningItem.evidence.includes(STALE_CURRENT_MULTI_PROCESS_DENY),
      'production-hardening evidence must not keep standalone exact "not multi-process exclusive lock"',
    );
    assert.ok(
      !hardeningItem.evidence.includes(STALE_SINGLE_PROCESS_QUEUE_ONLY),
      'production-hardening evidence must not keep standalone exact "single-process queue only"',
    );
    assert.ok(
      !hardeningItem.evidence.some((e) => String(e).includes(STALE_MULTI_PROCESS_YET)),
      'production-hardening evidence must not keep remaining "not multi-process exclusive lock yet"',
    );
    // V1.39 historical write-admission base retained
    assert.ok(
      hardeningEvidence.includes(V139_SIGNATURE),
      'production-hardening evidence must retain V1.39 exact write-admission signature',
    );
    assert.ok(
      hardeningEvidence.includes('pre-side-effect admission required'),
      'production-hardening evidence must include pre-side-effect admission required',
    );
    // Exact evidence element only — no joined-text substring fallback
    assert.ok(
      hardeningItem.evidence.includes(POST_OUTCOME_STILL_BEST_EFFORT),
      'production-hardening evidence must exact-include post-outcome still best-effort element',
    );
    // Exact locus elements — no helper-name-only or bare src/server.js OR
    assert.ok(
      hardeningItem.evidence.includes('src/server.js recordRequiredWriteAdmissionAudit'),
      'production-hardening evidence must exact-include src/server.js recordRequiredWriteAdmissionAudit',
    );
    assert.ok(
      hardeningEvidence.includes('test/server-write-admission.test.js'),
      'production-hardening evidence must include test/server-write-admission.test.js',
    );
    assert.ok(
      hardeningEvidence.includes('test/server-write-admission-scans.test.js'),
      'production-hardening evidence must include test/server-write-admission-scans.test.js',
    );
    assert.ok(
      hardeningItem.evidence.includes('src/agent.js recordRequiredNasReplicationStartAudit'),
      'production-hardening evidence must exact-include src/agent.js recordRequiredNasReplicationStartAudit',
    );
    assert.ok(
      hardeningEvidence.includes('test/agent-nas-snapshot-replicate.test.js'),
      'production-hardening evidence must include test/agent-nas-snapshot-replicate.test.js',
    );
    assert.ok(
      hardeningEvidence.includes('audit-delivery-unavailable'),
      'production-hardening evidence must include audit-delivery-unavailable',
    );
    // Exact write-admission failure boundary atom — not bare audit-delivery-unavailable,
    // not joined-text "exit 1" from V1.38 monitor history
    assert.ok(
      hardeningItem.evidence.includes(WRITE_ADMISSION_FAILURE_BOUNDARY),
      'production-hardening evidence must exact-include write-admission HTTP 503 / CLI exit 1 boundary atom',
    );
    // Mutation canary: only V1.38 monitor exit 1 + bare audit-delivery-unavailable must fail exact boundary
    {
      const monitorOnlyEvidence = [
        V138_SIGNATURE,
        V138_MONITOR_EXIT_1,
        'audit-delivery-unavailable',
        POST_OUTCOME_STILL_BEST_EFFORT,
      ];
      const joinedHasExit1 = monitorOnlyEvidence.join(' ').includes('exit 1');
      const exactHasBoundary = monitorOnlyEvidence.includes(WRITE_ADMISSION_FAILURE_BOUNDARY);
      assert.equal(
        joinedHasExit1,
        true,
        'canary: V1.38 monitor-only evidence joined text has exit 1 (would greenwash weak checks)',
      );
      assert.equal(
        exactHasBoundary,
        false,
        'canary: V1.38 monitor exit 1 + bare audit-delivery-unavailable must fail exact write-admission boundary',
      );
      assert.equal(
        [V138_MONITOR_EXIT_1].includes(WRITE_ADMISSION_FAILURE_BOUNDARY),
        false,
        'canary: exact Array.includes must reject V1.38 monitor exit 1 as write-admission boundary',
      );
      assert.equal(
        ['prefix ' + WRITE_ADMISSION_FAILURE_BOUNDARY].includes(WRITE_ADMISSION_FAILURE_BOUNDARY),
        false,
        'canary: prefixed/wrapped boundary must not satisfy exact-element includes',
      );
    }
    // Stale all-paths best-effort: ban as substring of any evidence element (not Array.includes exact-only)
    assert.ok(
      !hardeningItem.evidence.some((e) => String(e).includes(STALE_ALL_PATHS_BEST_EFFORT)),
      'production-hardening evidence must not contain stale all-paths best-effort as any-element substring',
    );
    // Mutation canaries: prove element-substring ban catches variants exact-includes would miss
    assert.equal(
      ['prefix ' + STALE_ALL_PATHS_BEST_EFFORT].some((e) => String(e).includes(STALE_ALL_PATHS_BEST_EFFORT)),
      true,
      'canary: prefixed stale phrase must be caught by element-substring ban',
    );
    assert.equal(
      [STALE_ALL_PATHS_BEST_EFFORT + ' suffix'].includes(STALE_ALL_PATHS_BEST_EFFORT),
      false,
      'canary: Array.includes exact-equal would miss suffixed stale phrase (why substring ban is required)',
    );
    assert.equal(
      ['src/server.js'].includes('src/server.js recordRequiredWriteAdmissionAudit'),
      false,
      'canary: bare src/server.js must not satisfy exact locus element',
    );
    assert.equal(
      ['recordRequiredNasReplicationStartAudit'].includes('src/agent.js recordRequiredNasReplicationStartAudit'),
      false,
      'canary: helper-name-only must not satisfy exact agent locus element',
    );
    assert.equal(
      ['pre ' + POST_OUTCOME_STILL_BEST_EFFORT + ' post'].includes(POST_OUTCOME_STILL_BEST_EFFORT),
      false,
      'canary: joined/wrapped post-outcome text must not satisfy exact-element includes',
    );
    // V1.38 historical monitor base (must remain; T6d.4 delivered)
    assert.ok(
      hardeningEvidence.includes(V138_SIGNATURE),
      'production-hardening evidence must retain V1.38 exact signature',
    );
    assert.ok(
      hardeningEvidence.includes('T6d.4 minimum viable run-once path delivered'),
      'production-hardening evidence must include T6d.4 minimum viable run-once path delivered',
    );
    assert.ok(hardeningEvidence.includes('src/audit-integrity-monitor.js'));
    assert.ok(hardeningEvidence.includes('test/audit-integrity-monitor.test.js'));
    assert.ok(
      hardeningEvidence.includes('src/agent.js audit-integrity-monitor')
        || hardeningEvidence.includes('audit-integrity-monitor --data-dir'),
      'production-hardening evidence must name Agent CLI audit-integrity-monitor',
    );
    assert.ok(hardeningEvidence.includes('test/agent-audit-integrity-monitor.test.js'));
    // Separate local run-once / JSON / exit facts (no weak OR collapse)
    assert.ok(
      hardeningEvidence.includes('local run-once'),
      'production-hardening evidence must include local run-once',
    );
    assert.ok(
      hardeningEvidence.includes('compact JSON stdout'),
      'production-hardening evidence must include compact JSON stdout',
    );
    assert.ok(
      hardeningEvidence.includes('exit 0'),
      'production-hardening evidence must include exit 0',
    );
    assert.ok(
      hardeningEvidence.includes('exit 2'),
      'production-hardening evidence must include exit 2',
    );
    assert.ok(
      hardeningEvidence.includes('exit 1'),
      'production-hardening evidence must include exit 1',
    );
    assert.ok(
      /not remote notification delivery|no remote notification delivery/i.test(hardeningEvidence),
      'production-hardening evidence must deny remote notification delivery',
    );
    assert.ok(
      /not managed scheduler|no managed scheduler/i.test(hardeningEvidence),
      'production-hardening evidence must deny managed scheduler',
    );
    assert.ok(
      /not production monitoring ready|no production monitoring ready/i.test(hardeningEvidence),
      'production-hardening evidence must deny production monitoring ready',
    );
    // Exact Gold short phrase (not only expanded 4 ready / 4 partial form)
    assert.ok(
      hardeningItem.evidence.includes(GOLD_REMAINS_BLOCKED_4419),
      'production-hardening evidence array must exact-include "Gold remains blocked 4/4/1/9"',
    );
    // V1.37 historical dual-write coordinator base (must remain)
    assert.ok(
      hardeningEvidence.includes('V1.37 journal-first crash-recoverable audit dual-write coordinator implementation'),
      'production-hardening evidence must retain V1.37 exact signature',
    );
    assert.ok(hardeningEvidence.includes('src/audit-integrity-dual-write.js'));
    assert.ok(hardeningEvidence.includes('appendAuditEventWithIntegrityDualWrite'));
    assert.ok(hardeningEvidence.includes('recoverAuditIntegrityDualWrite'));
    assert.ok(
      /appendAuditEvent/i.test(hardeningEvidence)
        && /sole|only|唯一|production wiring|production caller/i.test(hardeningEvidence),
      'production-hardening evidence must state production appendAuditEvent dual-write wiring',
    );
    assert.ok(/journal-first/i.test(hardeningEvidence), 'production-hardening evidence must mention journal-first');
    assert.ok(
      /single-slot|single.?slot|WAL|cursor/i.test(hardeningEvidence),
      'production-hardening evidence must mention single-slot durable WAL/cursor',
    );
    assert.ok(/single-process/i.test(hardeningEvidence), 'production-hardening evidence must mention single-process queue');
    assert.ok(/crash.?recover/i.test(hardeningEvidence), 'production-hardening evidence must mention crash recovery');
    assert.ok(hardeningEvidence.includes('audit/events.jsonl'));
    assert.ok(hardeningEvidence.includes('audit/integrity-journal.jsonl'));
    assert.ok(hardeningEvidence.includes('audit/integrity-dual-write-state.json'));
    // V1.36 historical cross-store verifier base (must remain)
    assert.ok(
      hardeningEvidence.includes('V1.36 audit event/journal cross-store structural consistency verifier implementation'),
      'production-hardening evidence must retain V1.36 exact signature',
    );
    assert.ok(hardeningEvidence.includes('src/audit-integrity-cross-store.js'));
    assert.ok(hardeningEvidence.includes('test/audit-integrity-cross-store.test.js'));
    assert.ok(hardeningEvidence.includes('test/audit-integrity-cross-store-scans.test.js'));
    assert.ok(hardeningEvidence.includes('verifyAuditIntegrityAgainstEventStore'));
    assert.ok(
      /read-only|readonly/i.test(hardeningEvidence)
        && /(events.?journal|journal.?events|J.?E|E.?J|cross-store).*(structural|structure)|structural.*(relationship|consistency)/i.test(hardeningEvidence),
      'production-hardening evidence must retain read-only J↔E structural relationship (V1.36 base)',
    );
    assert.ok(
      /retention-aware|retention.?aware|retention suffix/i.test(hardeningEvidence),
      'production-hardening evidence must mention retention-aware structural relationship',
    );
    // V1.35 historical journal foundation base (must remain)
    assert.ok(
      hardeningEvidence.includes('V1.35 unkeyed audit hash-chain structural consistency foundation implementation'),
      'production-hardening evidence must retain V1.35 journal foundation signature',
    );
    assert.ok(hardeningEvidence.includes('src/audit-integrity-journal.js'));
    assert.ok(hardeningEvidence.includes('test/audit-integrity-journal.test.js'));
    assert.ok(hardeningEvidence.includes('test/audit-integrity-journal-scans.test.js'));
    assert.ok(hardeningEvidence.includes('generation-open'));
    assert.ok(hardeningEvidence.includes('event-link'));
    assert.ok(hardeningEvidence.includes('initializeAuditIntegrityJournal'));
    assert.ok(hardeningEvidence.includes('appendAuditIntegrityEvent'));
    assert.ok(hardeningEvidence.includes('verifyAuditIntegrityJournalFile'));
    assert.ok(hardeningEvidence.includes('auditIntegrityJournalQueues'));
    assert.ok(hardeningEvidence.includes('audit-integrity-bounds-exceeded'));
    assert.ok(hardeningEvidence.includes('audit-integrity-io-error'));
    assert.ok(
      hardeningEvidence.includes('T6d.3 still partial') || hardeningEvidence.includes('T6d.3 partial only'),
      'production-hardening evidence must state T6d.3 still partial / partial only',
    );
    assert.ok(
      hardeningEvidence.includes('T6d.3 partial only') || hardeningEvidence.includes('partial only') || hardeningEvidence.includes('partial foundation only'),
      'production-hardening evidence must keep partial-only wording',
    );
    assert.ok(
      /not T6d\.3 complete|not.*T6d\.3 complete/i.test(hardeningEvidence),
      'production-hardening evidence must deny T6d.3 complete',
    );
    // V1.40 delivered multi-process exclusive lock; historical V1.37 may still mention single-process queue
    assert.ok(
      /single-process/i.test(hardeningEvidence),
      'production-hardening evidence must retain V1.37 historical single-process queue wording',
    );
    // V1.43 current-state: local multi-process lock delivered; post-outcome still best-effort;
    // local run-once monitor/alert delivered (V1.38 base); explicit manual rotation
    // delivered (V1.43 base); no automatic rotation; not managed scheduler;
    // not remote notification delivery; not production monitoring ready
    assert.ok(
      /no automatic rotation|not automatic rotation/i.test(hardeningEvidence),
      'production-hardening evidence must deny automatic rotation',
    );
    assert.ok(
      /local run-once monitor|run-once monitor\/alert|monitor\/alert delivered|local run-once/i.test(hardeningEvidence),
      'production-hardening evidence must acknowledge local run-once monitor/alert delivered',
    );
    // Stale absolute "no monitor / alert" current-state wording must not remain as truth
    assert.ok(
      !hardeningItem.evidence.some((e) =>
        /^(no journal rotation \/ monitor \/ alert|no journal rotation\/monitor\/alert yet)$/i.test(String(e).trim()),
      ),
      'production-hardening evidence must not keep stale exact "no journal rotation / monitor / alert" current-state element',
    );
    // Ambiguous slash aggregate forbidden on V1.40 current-state evidence
    assert.ok(
      !hardeningItem.evidence.some((e) => String(e).includes(STALE_SLASH_AGGREGATE)),
      'production-hardening evidence must not keep slash aggregate rotation/scheduler/remote',
    );
    assert.ok(
      hardeningItem.evidence.some((e) => /no automatic rotation|not automatic rotation/i.test(String(e)))
        && hardeningItem.evidence.some((e) => /not managed scheduler|no managed scheduler/i.test(String(e)))
        && hardeningItem.evidence.some((e) => /not remote notification delivery|no remote notification delivery/i.test(String(e))),
      'production-hardening evidence must carry direct negatives for automatic rotation / scheduler / remote',
    );
    assert.ok(
      /not end-to-end production audit delivery|no end-to-end production audit delivery/i.test(hardeningEvidence)
        && hardeningItem.evidence.includes(POST_OUTCOME_STILL_BEST_EFFORT),
      'production-hardening evidence must deny e2e production audit delivery with exact post-outcome still best-effort element',
    );
    assert.ok(
      /not state continuity under adversarial state deletion|no state continuity under adversarial state deletion/i.test(hardeningEvidence)
        && /re-bootstrap|rebootstrap|limitation/i.test(hardeningEvidence),
      'production-hardening evidence must deny state continuity under adversarial state deletion',
    );
    assert.ok(
      /not M6d Exit|no M6d Exit|不是 M6d Exit/i.test(hardeningEvidence),
      'production-hardening evidence must deny M6d Exit',
    );
    // Explicit independent negative evidence element (exact includes lock)
    assert.ok(
      hardeningItem.evidence.includes(NOT_PRODUCTION_HARDENING_READY),
      'production-hardening evidence array must include exact independent "not production-hardening ready"',
    );
    // Phrase-bearing evidence elements must carry the exact negative (no bare !/production-hardening ready/)
    assertEvidenceProductionHardeningReadyNegated(hardeningItem.evidence, 'production-hardening evidence');
    assert.ok(
      /not Gold|no Gold ready|Gold remains blocked|Gold 依旧 blocked/i.test(hardeningEvidence),
      'production-hardening evidence must deny Gold ready',
    );
    assert.ok(
      /no external trusted anchor|not external trusted anchor|no external authenticity|no external trusted anchor\/HMAC|no external trusted anchor \/ HMAC|no authenticity/i.test(hardeningEvidence)
        || hardeningEvidence.includes('no external trusted anchor/HMAC/signature')
        || hardeningEvidence.includes('no external trusted anchor / HMAC / signature')
        || hardeningEvidence.includes('no external authenticity / trusted anchor / HMAC / signature'),
      'production-hardening evidence must deny external trusted anchor/HMAC/signature',
    );
    // V1.34 historical pointer: third real capability audit proof + independent sink (M6d-prep only)
    assert.ok(hardeningEvidence.includes('realAuditCapabilityImplementationReady:true'));
    assert.ok(hardeningEvidence.includes('authorizeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof'));
    assert.ok(hardeningEvidence.includes('invokeSupervisorLifecycleGuardedRunnerCapabilityRealAuditProof'));
    assert.ok(hardeningEvidence.includes('audit/capability-proof-attempts.jsonl'));
    assert.ok(hardeningEvidence.includes('src/capability-audit-sink.js'));
    // Live-success path tokens (valid invoke → independent sink write)
    assert.ok(
      hardeningEvidence.includes('capability-real-audit-persisted'),
      'production-hardening evidence must record live-success outcomeCode capability-real-audit-persisted',
    );
    assert.ok(
      hardeningEvidence.includes('auditPersistOccurred:true'),
      'production-hardening evidence must record live-success auditPersistOccurred:true',
    );
    assert.ok(
      hardeningEvidence.includes('hostSideEffectOccurred:true'),
      'production-hardening evidence must record live-success hostSideEffectOccurred:true',
    );
    assert.ok(
      hardeningEvidence.includes('hostMutationOccurred:true'),
      'production-hardening evidence must record live-success hostMutationOccurred:true',
    );
    // Auth / non-live path remains hostSideEffectOccurred:false (dual-state honesty)
    assert.ok(
      hardeningEvidence.includes('hostSideEffectOccurred:false'),
      'production-hardening evidence must retain hostSideEffectOccurred:false for auth/non-live paths',
    );
    assert.ok(hardeningEvidence.includes('realAttemptAuditImplementationReady:false'));
    assert.ok(hardeningEvidence.includes('realCapabilityImplementationsReady:false'));
    assert.ok(hardeningEvidence.includes('executeCapabilityAuthorized:false'));
    // Execution / real wiring flags remain false (must not flip true)
    assert.ok(hardeningEvidence.includes('realRunnerWiringReady:false'));
    assert.ok(hardeningEvidence.includes('runnerWiringContractReady:false'));
    assert.ok(hardeningEvidence.includes('executionEligible:false'));
    // V1.43 nextStep leads with rotation-foundation honesty + exact signature
    assert.ok(
      hardeningItem.nextStep.startsWith('V1.43'),
      'production-hardening nextStep must lead with V1.43',
    );
    assert.ok(
      hardeningItem.nextStep.includes(V143_SIGNATURE),
      'production-hardening nextStep must include V1.43 exact signature',
    );
    assert.ok(
      /explicit manual rotation/i.test(hardeningItem.nextStep),
      'production-hardening nextStep must state explicit manual rotation',
    );
    assert.ok(
      hardeningItem.nextStep.includes(V142_SIGNATURE),
      'production-hardening nextStep must retain V1.42 exact signature as historical base',
    );
    assert.ok(
      hardeningItem.nextStep.includes(V141_SIGNATURE),
      'production-hardening nextStep must include V1.41 exact signature',
    );
    assert.ok(
      hardeningItem.nextStep.includes(V140_SIGNATURE),
      'production-hardening nextStep must include V1.40 exact signature',
    );
    assert.ok(
      hardeningItem.nextStep.includes('src/audit-integrity-process-lock.js')
        || hardeningItem.nextStep.includes('audit-integrity-process-lock'),
      'production-hardening nextStep must name process-lock module',
    );
    assert.ok(
      hardeningItem.nextStep.includes('src/audit-integrity-write-queue.js')
        || hardeningItem.nextStep.includes('audit-integrity-write-queue'),
      'production-hardening nextStep must name write-queue module',
    );
    assert.ok(
      /lockf|\/usr\/bin\/lockf/i.test(hardeningItem.nextStep),
      'production-hardening nextStep must name lockf',
    );
    assert.ok(
      /same-dataDir local multi-process|local multi-process exclusive/i.test(hardeningItem.nextStep),
      'production-hardening nextStep must claim local multi-process exclusive serialization',
    );
    // V1.40 release/close failure ops boundary on nextStep current prefix
    {
      const nextCurrent = productionHardeningCurrentPrefix(hardeningItem.nextStep);
      assert.ok(
        nextCurrent.includes(RELEASE_CLOSE_FAIL_CLOSES),
        'production-hardening nextStep current prefix must include "release/close failure fail-closes"',
      );
      assert.ok(
        nextCurrent.includes(TASK_MUTATION_MAY_ALREADY_APPLIED),
        'production-hardening nextStep current prefix must include "task mutation may already be applied"',
      );
      assert.ok(
        nextCurrent.includes(CALLER_RETRY_NO_IDEMPOTENT_EXACTLY_ONCE),
        'production-hardening nextStep current prefix must include "caller retry has no idempotent/exactly-once guarantee"',
      );
      assert.ok(
        nextCurrent.includes(NO_DETERMINISTIC_IN_BAND_FD_RECLAIM),
        'production-hardening nextStep current prefix must include "no deterministic in-band fd reclaim before process exit"',
      );
      const nextCurrentLower = nextCurrent.toLowerCase();
      for (const phrase of FORBIDDEN_ABSOLUTE_V140_PHRASES) {
        assert.ok(
          !nextCurrentLower.includes(phrase.toLowerCase()),
          `production-hardening nextStep current prefix must not claim absolute "${phrase}"`,
        );
      }
    }
    assert.ok(
      /not distributed|no distributed/i.test(hardeningItem.nextStep),
      'production-hardening nextStep must deny distributed',
    );
    assert.ok(
      /not cross-host|no cross-host/i.test(hardeningItem.nextStep),
      'production-hardening nextStep must deny cross-host',
    );
    assert.ok(
      hardeningItem.nextStep.includes(POST_OUTCOME_STILL_BEST_EFFORT),
      'production-hardening nextStep must include exact post-outcome still best-effort phrase',
    );
    assert.ok(
      hardeningItem.nextStep.includes('not end-to-end production audit delivery'),
      'production-hardening nextStep must deny end-to-end production audit delivery',
    );
    // V1.43 current nextStep prefix must not keep stale multi-process denials
    {
      const nextCurrent = productionHardeningCurrentPrefix(hardeningItem.nextStep);
      assert.ok(
        nextCurrent.includes(V143_SIGNATURE),
        'production-hardening nextStep current prefix must include V1.43 signature',
      );
      assert.ok(
        nextCurrent.includes(V142_SIGNATURE),
        'production-hardening nextStep current prefix must include V1.42 signature',
      );
      assert.ok(
        nextCurrent.includes(V141_SIGNATURE),
        'production-hardening nextStep current prefix must include V1.41 historical signature',
      );
      assert.ok(
        !nextCurrent.includes(STALE_CURRENT_MULTI_PROCESS_DENY),
        'production-hardening nextStep current prefix must not keep stale "not multi-process exclusive lock"',
      );
      assert.ok(
        !nextCurrent.includes(STALE_SINGLE_PROCESS_QUEUE_ONLY),
        'production-hardening nextStep current prefix must not keep stale "single-process queue only"',
      );
      assert.ok(
        !nextCurrent.includes(V138_MONITOR_EXIT_1),
        'production-hardening nextStep current prefix must not use V1.38 monitor exit 1 as admission boundary',
      );
    }
    assert.ok(
      !hardeningItem.nextStep.includes(STALE_MULTI_PROCESS_YET),
      'production-hardening nextStep remaining list must not keep "not multi-process exclusive lock yet"',
    );
    // V1.39 historical write-admission base retained in nextStep (signature + boundary atom)
    assert.ok(
      hardeningItem.nextStep.includes(V139_SIGNATURE),
      'production-hardening nextStep must retain V1.39 exact write-admission signature',
    );
    assert.ok(
      hardeningItem.nextStep.includes('pre-side-effect admission required')
        || hardeningItem.nextStep.includes('recordRequiredWriteAdmissionAudit'),
      'production-hardening nextStep must retain write-admission facts',
    );
    assert.ok(
      hardeningItem.nextStep.includes(WRITE_ADMISSION_FAILURE_BOUNDARY)
        || /write-admission|audit-delivery-unavailable/i.test(hardeningItem.nextStep),
      'production-hardening nextStep must retain write-admission / audit-delivery-unavailable facts',
    );
    // Mutation canary: V1.38-only exit 1 in later historical text must not satisfy current-segment lock
    {
      const hostileNext =
        `V1.40 adds process lock; audit-delivery-unavailable; V1.39 historical base: write-admission; V1.38 historical base: ${V138_MONITOR_EXIT_1}`;
      const currentSeg = productionHardeningCurrentPrefix(hostileNext);
      assert.equal(
        currentSeg.includes(WRITE_ADMISSION_FAILURE_BOUNDARY),
        false,
        'canary: V1.40 current segment with bare audit-delivery-unavailable must fail exact admission boundary',
      );
      assert.equal(
        hostileNext.includes('exit 1') && !currentSeg.includes(WRITE_ADMISSION_FAILURE_BOUNDARY),
        true,
        'canary: whole-nextStep exit 1 from V1.38 must not greenwash missing current-segment boundary',
      );
    }
    // V1.38 historical monitor base retained in nextStep
    assert.ok(
      hardeningItem.nextStep.includes(V138_SIGNATURE),
      'production-hardening nextStep must retain V1.38 exact signature',
    );
    assert.ok(
      hardeningItem.nextStep.includes('T6d.4 minimum viable run-once path delivered'),
      'production-hardening nextStep must include T6d.4 minimum viable run-once path delivered',
    );
    assert.ok(
      hardeningItem.nextStep.includes('src/audit-integrity-monitor.js')
        || hardeningItem.nextStep.includes('audit-integrity-monitor'),
      'production-hardening nextStep must name monitor module or CLI',
    );
    assert.ok(
      /not remote notification delivery|no remote notification delivery/i.test(hardeningItem.nextStep),
      'production-hardening nextStep must deny remote notification delivery',
    );
    assert.ok(
      /not managed scheduler|no managed scheduler/i.test(hardeningItem.nextStep),
      'production-hardening nextStep must deny managed scheduler',
    );
    assert.ok(
      /not production monitoring ready|no production monitoring ready/i.test(hardeningItem.nextStep),
      'production-hardening nextStep must deny production monitoring ready',
    );
    // V1.37 historical dual-write coordinator pointer (must remain after V1.40 lead-in)
    assert.ok(
      hardeningItem.nextStep.includes('V1.37'),
      'production-hardening nextStep must retain V1.37 historical pointer',
    );
    assert.ok(
      hardeningItem.nextStep.includes('V1.37 journal-first crash-recoverable audit dual-write coordinator implementation'),
      'production-hardening nextStep must retain V1.37 exact signature',
    );
    assert.ok(
      hardeningItem.nextStep.includes('appendAuditEventWithIntegrityDualWrite')
        || hardeningItem.nextStep.includes('src/audit-integrity-dual-write.js'),
      'production-hardening nextStep must name dual-write coordinator API or module',
    );
    assert.ok(
      /journal-first/i.test(hardeningItem.nextStep)
        && /single-slot|single.?slot|WAL|cursor/i.test(hardeningItem.nextStep)
        && /single-process/i.test(hardeningItem.nextStep),
      'production-hardening nextStep must name journal-first + single-slot WAL + single-process (V1.37 historical)',
    );
    assert.ok(
      /T6d\.3 still partial|T6d\.3 partial only/i.test(hardeningItem.nextStep),
      'production-hardening nextStep must state T6d.3 still partial / partial only',
    );
    assert.ok(
      /not T6d\.3 complete|not.*T6d\.3 complete/i.test(hardeningItem.nextStep),
      'production-hardening nextStep must deny T6d.3 complete on same negative clause',
    );
    assert.ok(
      /not M6d Exit|不是 M6d Exit|does not complete M6d Exit/i.test(hardeningItem.nextStep),
      'production-hardening nextStep must deny M6d Exit',
    );
    // Historical V1.37 may still state not multi-process exclusive lock; current prefix must not
    {
      const historicalOnly = hardeningItem.nextStep.slice(
        hardeningItem.nextStep.search(/V1\.37 historical|V1\.37 journal-first/),
      );
      assert.ok(
        historicalOnly.length > 0
          && (/not multi-process exclusive lock|no multi-process exclusive lock|single-process queue only|single-process queue/i.test(historicalOnly)
            || /V1\.37 historical base/i.test(hardeningItem.nextStep)),
        'production-hardening nextStep may retain V1.37 historical multi-process-not-yet / single-process fact',
      );
    }
    assert.ok(
      /no automatic rotation|not automatic rotation/i.test(hardeningItem.nextStep),
      'production-hardening nextStep must deny automatic rotation',
    );
    // V1.43 rotation foundation boundaries on nextStep: retain blockers and
    // state this is not automatic scheduling, not remote delivery, not WORM,
    // not authenticity; archive append-only policy is not WORM/authenticity.
    assert.ok(
      /no automatic scheduling|not automatic scheduling/i.test(hardeningItem.nextStep),
      'production-hardening nextStep must deny automatic scheduling',
    );
    assert.ok(
      /append-only/i.test(hardeningItem.nextStep),
      'production-hardening nextStep must state archive append-only policy',
    );
    assert.ok(
      /not WORM|no WORM/i.test(hardeningItem.nextStep),
      'production-hardening nextStep must deny WORM directly',
    );
    assert.ok(
      clauseLocalDirectBarePositiveNegated(hardeningItem.nextStep, 'worm'),
      'production-hardening nextStep: worm must be direct clause-local negated',
    );
    assert.ok(
      /not authenticity|no authenticity|no external authenticity/i.test(hardeningItem.nextStep),
      'production-hardening nextStep must deny authenticity',
    );
    assert.ok(
      !hardeningItem.nextStep.includes('no journal rotation yet'),
      'production-hardening nextStep must not keep stale "no journal rotation yet" wording',
    );
    // Ambiguous slash aggregate forbidden on nextStep current-state surface
    assert.ok(
      !hardeningItem.nextStep.includes(STALE_SLASH_AGGREGATE),
      'production-hardening nextStep must not keep slash aggregate rotation/scheduler/remote',
    );
    // Exact Gold short phrase on nextStep (expanded form may also remain)
    assert.ok(
      hardeningItem.nextStep.includes(GOLD_REMAINS_BLOCKED_4419),
      'production-hardening nextStep must exact-include "Gold remains blocked 4/4/1/9"',
    );
    // Stale absolute "no monitor / alert yet" remaining-work wording must not claim monitor/alert absent
    assert.ok(
      !/no journal rotation\/monitor\/alert yet|no journal rotation \/ monitor \/ alert yet/i.test(hardeningItem.nextStep)
        || /local run-once monitor|monitor\/alert delivered|T6d\.4 minimum viable/i.test(hardeningItem.nextStep),
      'production-hardening nextStep must not claim monitor/alert still absent without acknowledging local run-once delivery',
    );
    assert.ok(
      /not end-to-end production audit delivery|no end-to-end production audit delivery/i.test(hardeningItem.nextStep)
        && hardeningItem.nextStep.includes(POST_OUTCOME_STILL_BEST_EFFORT),
      'production-hardening nextStep must deny e2e production audit delivery with exact post-outcome still best-effort',
    );
    // nextStep must fully exclude stale all-paths best-effort — no "new phrase present → allow" OR
    assert.ok(
      !hardeningItem.nextStep.includes(STALE_ALL_PATHS_BEST_EFFORT),
      'production-hardening nextStep must not contain stale all-paths best-effort phrase at all',
    );
    // Canary: old OR would greenwash stale+new coexistence; strict ban rejects it
    {
      const hostileNext = `${STALE_ALL_PATHS_BEST_EFFORT}; ${POST_OUTCOME_STILL_BEST_EFFORT}`;
      const oldOrWouldPass =
        !hostileNext.includes(STALE_ALL_PATHS_BEST_EFFORT)
        || hostileNext.includes(POST_OUTCOME_STILL_BEST_EFFORT);
      const strictBanPasses = !hostileNext.includes(STALE_ALL_PATHS_BEST_EFFORT);
      assert.equal(oldOrWouldPass, true, 'canary: old OR would pass hostile nextStep with both phrases');
      assert.equal(strictBanPasses, false, 'canary: strict ban must reject nextStep containing stale phrase');
    }
    assert.ok(
      /not state continuity under adversarial state deletion|no state continuity under adversarial state deletion/i.test(hardeningItem.nextStep)
        && /re-bootstrap|rebootstrap|limitation/i.test(hardeningItem.nextStep),
      'production-hardening nextStep must deny state continuity under adversarial state deletion',
    );
    assert.ok(
      /not authenticity|no authenticity|no external authenticity|no external trusted anchor|HMAC|signature|WORM|immutable/i.test(hardeningItem.nextStep),
      'production-hardening nextStep must deny authenticity / external anchor / HMAC / signature / WORM',
    );
    // Must not claim V1.37 is still "not dual-write" / "no production caller"
    assert.ok(
      !/V1\.37[^.]*not dual-write|V1\.37[^.]*no production dual-write|V1\.37[^.]*no production caller/i.test(hardeningItem.nextStep),
      'production-hardening nextStep must not claim V1.37 is not dual-write / no production caller',
    );
    assert.ok(hardeningItem.nextStep.includes('production-hardening remains partial'));
    // Exact negative inside V1.40 capability-boundary parentheses
    assert.ok(
      hardeningItem.nextStep.includes(NOT_PRODUCTION_HARDENING_READY),
      'production-hardening nextStep must include exact "not production-hardening ready"',
    );
    // Phrase-bearing nextStep clauses must carry the exact negative (no bare !/production-hardening ready/)
    assertTextProductionHardeningReadyNegated(hardeningItem.nextStep, 'production-hardening nextStep');
    // Hostile canaries: pure helper must fail on bare positive, pass on exact negative
    assert.equal(
      productionHardeningReadyClausesAreNegated('production-hardening ready'),
      false,
      'hostile canary: bare positive "production-hardening ready" must fail',
    );
    assert.equal(
      productionHardeningReadyClausesAreNegated(NOT_PRODUCTION_HARDENING_READY),
      true,
      'hostile canary: exact "not production-hardening ready" must pass',
    );
    assert.equal(
      productionHardeningReadyClausesAreNegated('partial only; no claim'),
      true,
      'hostile canary: text without the phrase must pass',
    );
    assert.equal(
      productionHardeningReadyClausesAreNegated('foo; production-hardening ready; bar'),
      false,
      'hostile canary: positive clause among siblings must fail',
    );
    assert.equal(
      productionHardeningReadyClausesAreNegated(`foo; ${NOT_PRODUCTION_HARDENING_READY}; bar`),
      true,
      'hostile canary: negated clause among siblings must pass',
    );
    // Hostile canaries: period / comma split and case-insensitive positive must fail (P2 anti-false-green)
    assert.equal(
      productionHardeningReadyClausesAreNegated('not production-hardening ready. production-hardening ready'),
      false,
      'hostile canary: period-split positive after negative must fail',
    );
    assert.equal(
      productionHardeningReadyClausesAreNegated('not production-hardening ready, production-hardening ready'),
      false,
      'hostile canary: comma-split positive after negative must fail',
    );
    assert.equal(
      productionHardeningReadyClausesAreNegated('not production-hardening ready; Production-hardening ready'),
      false,
      'hostile canary: case-variant positive clause after negative must fail',
    );
    // Early-negative must not mask later positive claim in a later clause
    assert.equal(
      productionHardeningReadyClausesAreNegated('not T6d.3 complete; production-hardening ready'),
      false,
      'hostile early-negative canary: early not-other must not cover later bare production-hardening ready',
    );
    // Positive control: English period after version-like token must not false-split T6d.3
    assert.equal(
      productionHardeningReadyClausesAreNegated('not production-hardening ready. T6d.3 still partial'),
      true,
      'positive control: period+space after negative with T6d.3 must pass (no false split on version dot)',
    );
    // V1.40 hostile honesty canaries: bare remote/scheduler/production-monitoring
    // positives must not be sheltered by earlier Not, arbitrary same-clause not, or joined evidence
    assert.equal(
      clauseLocalDirectBarePositiveNegated('production monitoring ready', 'production monitoring ready'),
      false,
      'hostile canary: bare production monitoring ready must fail',
    );
    assert.equal(
      clauseLocalDirectBarePositiveNegated('remote notification delivery', 'remote notification delivery'),
      false,
      'hostile canary: bare remote notification delivery must fail',
    );
    assert.equal(
      clauseLocalDirectBarePositiveNegated('managed scheduler', 'managed scheduler'),
      false,
      'hostile canary: bare managed scheduler must fail',
    );
    assert.equal(
      clauseLocalDirectBarePositiveNegated('not production monitoring ready', 'production monitoring ready'),
      true,
      'hostile canary: same-clause not production monitoring ready must pass',
    );
    assert.equal(
      clauseLocalDirectBarePositiveNegated('Not remote notification delivery; not managed scheduler', 'remote notification delivery'),
      true,
      'hostile canary: multi-clause all-negated remote notification must pass',
    );
    assert.equal(
      clauseLocalDirectBarePositiveNegated('Not T6d.3 complete; production monitoring ready', 'production monitoring ready'),
      false,
      'hostile canary: early Not-other must not shelter later bare production monitoring ready',
    );
    assert.equal(
      clauseLocalDirectBarePositiveNegated('T6d.3 still partial; remote notification delivery', 'remote notification delivery'),
      false,
      'hostile canary: partial limitation must not shelter bare remote notification delivery',
    );
    assert.equal(
      clauseLocalDirectBarePositiveNegated('not production monitoring ready; managed scheduler', 'managed scheduler'),
      false,
      'hostile canary: early not-other must not shelter later bare managed scheduler',
    );
    // Same-clause arbitrary "not" without direct "not <phrase>" must fail
    assert.equal(
      clauseLocalDirectBarePositiveNegated(
        'not T6d.3 complete but production monitoring ready',
        'production monitoring ready',
      ),
      false,
      'hostile canary: same-clause not-other must not shelter bare production monitoring ready',
    );
    assert.equal(
      clauseLocalDirectBarePositiveNegated(
        'not T6d.3 complete but managed scheduler',
        'managed scheduler',
      ),
      false,
      'hostile canary: same-clause not-other must not shelter bare managed scheduler',
    );
    assert.equal(
      clauseLocalDirectBarePositiveNegated(STALE_SLASH_AGGREGATE, 'managed scheduler'),
      false,
      'hostile canary: slash aggregate must not count as direct no managed scheduler',
    );
    assert.equal(
      clauseLocalDirectBarePositiveNegated(STALE_SLASH_AGGREGATE, 'remote notification delivery'),
      false,
      'hostile canary: slash aggregate must not count as direct no remote notification delivery',
    );

    // Element-level evidence helper: sibling Not must not shelter bare positive element
    assert.equal(
      evidenceElementsDirectlyNegatePhrase(
        ['not T6d.3 complete', 'production monitoring ready'],
        'production monitoring ready',
      ),
      false,
      'hostile canary array: sibling not-other must not shelter bare production monitoring ready',
    );
    assert.equal(
      evidenceElementsDirectlyNegatePhrase(
        ['not production monitoring ready'],
        'production monitoring ready',
      ),
      true,
      'hostile canary array: direct not production monitoring ready must pass',
    );
    assert.equal(
      evidenceElementsDirectlyNegatePhrase(
        ['not T6d.3 complete', 'remote notification delivery'],
        'remote notification delivery',
      ),
      false,
      'hostile canary array: sibling not-other must not shelter bare remote notification delivery',
    );
    assert.equal(
      evidenceElementsDirectlyNegatePhrase(
        ['not remote notification delivery'],
        'remote notification delivery',
      ),
      true,
      'hostile canary array: direct not remote notification delivery must pass',
    );
    assert.equal(
      evidenceElementsDirectlyNegatePhrase(
        ['not T6d.3 complete', 'managed scheduler'],
        'managed scheduler',
      ),
      false,
      'hostile canary array: sibling not-other must not shelter bare managed scheduler',
    );
    assert.equal(
      evidenceElementsDirectlyNegatePhrase(
        ['not managed scheduler'],
        'managed scheduler',
      ),
      true,
      'hostile canary array: direct not managed scheduler must pass',
    );
    // Joined-text false-green: element A "not X" + element B bare positive would pass
    // if helper joined first; element-level must still fail.
    assert.equal(
      evidenceElementsDirectlyNegatePhrase(
        ['not T6d.3 complete', 'production monitoring ready'],
        'production monitoring ready',
      ),
      false,
      'hostile canary: joined-text shelter across evidence elements must fail',
    );
    assert.equal(
      evidenceElementsDirectlyNegatePhrase(
        [STALE_SLASH_AGGREGATE],
        'managed scheduler',
      ),
      false,
      'hostile canary: slash aggregate element must fail direct managed scheduler negation',
    );

    // Live evidence array: each phrase-bearing element must carry direct not/no <phrase>
    assert.ok(
      evidenceElementsDirectlyNegatePhrase(hardeningItem.evidence, 'production monitoring ready'),
      'production-hardening evidence elements: production monitoring ready must be directly negated',
    );
    assert.ok(
      evidenceElementsDirectlyNegatePhrase(hardeningItem.evidence, 'remote notification delivery'),
      'production-hardening evidence elements: remote notification delivery must be directly negated',
    );
    assert.ok(
      evidenceElementsDirectlyNegatePhrase(hardeningItem.evidence, 'managed scheduler'),
      'production-hardening evidence elements: managed scheduler must be directly negated',
    );

    // Live nextStep: direct clause-local not/no <phrase>
    assert.ok(
      clauseLocalDirectBarePositiveNegated(hardeningItem.nextStep, 'production monitoring ready'),
      'production-hardening nextStep: production monitoring ready must be direct clause-local negated',
    );
    assert.ok(
      clauseLocalDirectBarePositiveNegated(hardeningItem.nextStep, 'remote notification delivery'),
      'production-hardening nextStep: remote notification delivery must be direct clause-local negated',
    );
    assert.ok(
      clauseLocalDirectBarePositiveNegated(hardeningItem.nextStep, 'managed scheduler'),
      'production-hardening nextStep: managed scheduler must be direct clause-local negated',
    );
    // Exact short phrase already asserted above; expanded form may also remain
    assert.ok(
      /Gold remains blocked 4 ready \/ 4 partial \/ 1 blocked \/ total 9|4 ready \/ 4 partial \/ 1 blocked \/ total 9/.test(hardeningItem.nextStep)
        || hardeningItem.nextStep.includes(GOLD_REMAINS_BLOCKED_4419),
      'production-hardening nextStep must keep Gold blocked 4/4/1/9 (exact short and/or expanded)',
    );
    assert.ok(
      hardeningItem.nextStep.includes(GOLD_REMAINS_BLOCKED_4419),
      'production-hardening nextStep must exact-include Gold remains blocked 4/4/1/9 (not only expanded)',
    );
    assert.ok(/M1 route open|M1.*open/i.test(hardeningItem.nextStep));
    assert.ok(/M2 denied|M2.*denied/i.test(hardeningItem.nextStep));
    assert.ok(hardeningItem.nextStep.includes('realCapabilityImplementationsReady:false'));
    assert.ok(hardeningItem.nextStep.includes('realAttemptAuditImplementationReady:false'));
    assert.ok(hardeningItem.nextStep.includes('executeCapabilityAuthorized:false'));
    assert.ok(hardeningItem.nextStep.includes('realRunnerWiringReady:false'));
    assert.ok(hardeningItem.nextStep.includes('runnerWiringContractReady:false'));
    assert.ok(hardeningItem.nextStep.includes('executionEligible:false'));
    // Next steps should point at remaining gaps (not imply this milestone is Gold)
    assert.ok(
      /rotation|remote notification|managed scheduler|production monitoring|anchor|authenticity|end-to-end|caller delivery|best-effort|distributed|network FS/i.test(hardeningItem.nextStep),
      'production-hardening nextStep must point at remaining rotation / remote / scheduler / e2e / authenticity / distributed gaps',
    );
    assert.ok(
      !/next remaining work still missing \(not delivered\):[^.]*not multi-process exclusive lock yet/i.test(hardeningItem.nextStep),
      'production-hardening nextStep remaining list must not claim multi-process exclusive lock still missing',
    );
    // V1.36 historical cross-store pointer (must not erase base)
    assert.ok(hardeningItem.nextStep.includes('V1.36'));
    assert.ok(
      hardeningItem.nextStep.includes('V1.36 audit event/journal cross-store structural consistency verifier implementation')
        || hardeningItem.nextStep.includes('verifyAuditIntegrityAgainstEventStore')
        || hardeningItem.nextStep.includes('src/audit-integrity-cross-store.js'),
      'production-hardening nextStep must retain V1.36 cross-store pointer',
    );
    // V1.36 honest cross-store limitations retained as historical base
    assert.ok(
      /retention suffix/i.test(hardeningItem.nextStep)
        && /structure only|structural only|structure-only/i.test(hardeningItem.nextStep)
        && /not deletion authorization|no deletion authorization|does not prove deletion authorization|not.*deletion authorization/i.test(hardeningItem.nextStep),
      'production-hardening nextStep must retain V1.36 retention suffix structure-only limitation',
    );
    assert.ok(
      /paired rewrite|consistent dual-suffix|dual.?suffix/i.test(hardeningItem.nextStep)
        && /may (?:still )?verify|can (?:still )?verify|still (?:may |can )?pass|可能通过/i.test(hardeningItem.nextStep),
      'production-hardening nextStep must retain paired rewrite / consistent dual-suffix may still verify',
    );
    assert.ok(
      /E\s*=\s*J\+J|E=J\+J|journal-suffix|occurrence ambigu/i.test(hardeningItem.nextStep),
      'production-hardening nextStep must retain E=J+J / occurrence ambiguity history',
    );
    // V1.35 historical journal foundation pointer (must not erase base)
    assert.ok(hardeningItem.nextStep.includes('V1.35'));
    assert.ok(
      hardeningItem.nextStep.includes('audit/integrity-journal.jsonl')
        || hardeningItem.nextStep.includes('unkeyed hash-chain structural consistency foundation')
        || hardeningItem.nextStep.includes('无密钥哈希链结构一致性基座'),
      'production-hardening nextStep must retain V1.35 journal foundation pointer',
    );
    // V1.34 historical real-audit pointer (must not jump V1.40 → V1.35 / skip V1.39/V1.38/V1.37/V1.36)
    assert.ok(hardeningItem.nextStep.includes('V1.34'));

    assert.ok(hardeningItem.nextStep.includes('M6d-prep'));
    assert.ok(
      /third real|第三个/.test(hardeningItem.nextStep) ||
        hardeningItem.nextStep.includes('real audit') ||
        hardeningItem.nextStep.includes('real-audit'),
    );
    assert.ok(hardeningItem.nextStep.includes('capability-proof-attempts.jsonl') || hardeningEvidence.includes('audit/capability-proof-attempts.jsonl'));
    // V1.33 historical real-status pointer (must not jump V1.34 → V1.32)
    assert.ok(
      hardeningItem.nextStep.includes('V1.33'),
      'production-hardening nextStep must include V1.33 historical real-status pointer',
    );
    assert.ok(
      /real status|real-status|status observational|observational metadata/i.test(hardeningItem.nextStep),
      'production-hardening nextStep must briefly point at V1.33 real status / status observational history',
    );
    assert.ok(!/M6d Exit complete|M6d Exit 完成|M6d complete|M6d 完成/i.test(hardeningItem.nextStep));
    // WORM may appear only as a direct denial (asserted above); readiness compounds stay banned
    assert.ok(!/tamper-proof (?:ready|complete|enabled)|chain integrity (?:ready|complete)|Gold ready|GA ready|cross-lan-connectivity/i.test(`${hardeningItem.nextStep} ${hardeningEvidence}`));
    // Forbidden positive compound: assemble needle at runtime (plan forbids embedding full literal)
    const forbiddenCompound = ['tamper', 'evident'].join('-');
    assert.ok(
      !hardeningItem.nextStep.includes(forbiddenCompound) && !hardeningEvidence.includes(forbiddenCompound),
      'production-hardening must not contain forbidden tamper compound',
    );
    assert.notEqual(hardeningItem.status, 'ready');
    assert.ok(hardeningItem.nextStep.includes('preflight'));
    assert.ok(hardeningItem.nextStep.includes('approval'));
    assert.ok(hardeningItem.nextStep.includes('rollback'));
    assert.ok(hardeningItem.nextStep.includes('V1.31'));
    assert.ok(hardeningItem.nextStep.includes('buildSupervisorLifecycleGuardedRunnerCapabilityInjectionReadiness'));
    assert.ok(hardeningItem.nextStep.includes('invokeSupervisorLifecycleGuardedRunnerCapabilityDryRun'));
    assert.ok(hardeningItem.nextStep.includes('pureCapabilityInjectionReady'));
    assert.ok(hardeningItem.nextStep.includes('executeCapabilityAuthorized:false'));
    assert.ok(hardeningItem.nextStep.includes('single-gate'));
    assert.ok(hardeningEvidence.includes('buildSupervisorLifecycleGuardedRunnerCapabilityInjectionReadiness'));
    assert.ok(hardeningEvidence.includes('capability-dry-run-receipt'));
    assert.ok(hardeningEvidence.includes('capability-execute-denied-receipt'));
    assert.ok(hardeningEvidence.includes('executeCapabilityAuthorized:false'));
    assert.ok(hardeningItem.nextStep.includes('V1.30'));
    assert.ok(hardeningItem.nextStep.includes('buildSupervisorLifecycleGuardedRunnerRealWiringPlan'));
    assert.ok(hardeningItem.nextStep.includes('capability injection'));
    assert.ok(hardeningItem.nextStep.includes('V1.28'));
    assert.ok(hardeningItem.nextStep.includes('resolveSupervisorLifecycleGuardedRunnerAttemptAudit'));
    assert.ok(hardeningItem.nextStep.includes('operator-recovery'));
    assert.ok(hardeningItem.nextStep.includes('V1.27'));
    assert.ok(hardeningItem.nextStep.includes('resolveSupervisorLifecycleGuardedRunnerRollbackAnchor'));
    assert.ok(hardeningItem.nextStep.includes('attempt-audit'));
    assert.ok(hardeningItem.nextStep.includes('V1.26'));
    assert.ok(hardeningItem.nextStep.includes('resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter'));
    assert.ok(hardeningItem.nextStep.includes('rollback-anchor'));
    assert.ok(hardeningItem.nextStep.includes('V1.25'));
    assert.ok(hardeningItem.nextStep.includes('resolveSupervisorLifecycleGuardedRunnerRegistry'));
    assert.ok(hardeningItem.nextStep.includes('V1.24'));
    assert.ok(hardeningItem.nextStep.includes('evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy'));
    assert.ok(hardeningItem.nextStep.includes('V1.22'));
    assert.ok(hardeningItem.nextStep.includes('V1.21'));
    assert.ok(hardeningItem.nextStep.includes('V1.20'));
    assert.ok(hardeningItem.nextStep.includes('V1.19'));
    assert.ok(hardeningItem.nextStep.includes('V1.18'));
    assert.ok(hardeningItem.nextStep.includes('V1.17'));
    assert.ok(hardeningItem.nextStep.includes('V1.16'));
    assert.ok(hardeningItem.nextStep.includes('V1.13'));
    assert.ok(hardeningItem.nextStep.includes('V1.15'));
    assert.ok(hardeningItem.nextStep.includes('V1.14'));
    assert.ok(hardeningItem.nextStep.includes('V1.12'));
    assert.ok(hardeningItem.nextStep.includes('V1.11'));
    assert.ok(hardeningItem.nextStep.includes('V1.10'));
    assert.ok(hardeningItem.nextStep.includes('V1.09'));
    assert.ok(hardeningItem.nextStep.includes('V1.08'));
    assert.ok(hardeningItem.nextStep.includes('V1.07'));
    assert.ok(hardeningItem.nextStep.includes('V1.06'));
    assert.ok(hardeningItem.nextStep.includes('V1.05'));
    assert.ok(hardeningItem.nextStep.includes('V1.04'));
    assert.ok(hardeningItem.nextStep.includes('V1.03'));
    assert.ok(hardeningItem.nextStep.includes('V1.02'));
    assert.ok(hardeningItem.nextStep.includes('V1.01'));
    assert.ok(hardeningItem.nextStep.includes('V0.97'));
    assert.ok(hardeningItem.nextStep.includes('V0.96'));
    assert.ok(hardeningItem.nextStep.includes('V0.95'));
    assert.ok(hardeningItem.nextStep.includes('V0.94'));
    assert.ok(hardeningItem.nextStep.includes('V0.93'));
    assert.ok(hardeningItem.nextStep.includes('V0.92'));
    assert.ok(hardeningItem.nextStep.includes('V0.91'));
    assert.ok(hardeningItem.nextStep.includes('V0.90'));
    assert.ok(hardeningItem.nextStep.includes('V0.89'));
    assert.ok(hardeningItem.nextStep.includes('rollbackUninstallPlan'));
    assert.ok(hardeningItem.nextStep.includes('Web dry-run panel'));
    assert.ok(hardeningItem.nextStep.includes('uninstall'));
    assert.ok(hardeningItem.nextStep.includes('Gold remains blocked') || hardeningItem.nextStep.includes('real NAS'));
    assert.ok(hardeningItem.nextStep.includes('secret management'));
    assert.ok(hardeningItem.nextStep.includes('monitoring'));
    assert.ok(hardeningItem.nextStep.includes('recovery supervisor'));
    assert.match(hardeningItem.nextStep, /supervisor|monitoring|secret|deployment|rotation|retention|hardening-status/i);

    const nasItem = report.items.find(item => item.id === 'real-nas-remote-backup');
    assert.ok(nasItem, 'real-nas-remote-backup should exist');
    assert.strictEqual(nasItem.status, 'ready');
    // V1.44 C1: committed real-NAS acceptance PASS NAS-REAL-V144-20260727-01 evidence.
    assert.ok(
      nasItem.evidence.includes('docs/superpowers/reports/2026-07-27-v144-real-nas-acceptance.json'),
      'real-nas-remote-backup evidence must exact-include committed JSON acceptance report path',
    );
    assert.ok(
      nasItem.evidence.includes('docs/superpowers/reports/2026-07-27-v144-real-nas-acceptance.md'),
      'real-nas-remote-backup evidence must exact-include committed Markdown acceptance report path',
    );
    assert.ok(
      nasItem.evidence.includes('NAS-REAL-V144-20260727-01'),
      'real-nas-remote-backup evidence must exact-include acceptance ID NAS-REAL-V144-20260727-01',
    );
    assert.ok(
      nasItem.evidence.includes('903b10abbad5e7ba7d701561150a389c0317d518'),
      'real-nas-remote-backup evidence must exact-include runtime commit 903b10abbad5e7ba7d701561150a389c0317d518',
    );
    assert.ok(
      nasItem.evidence.includes('runtimeVersion:V1.44'),
      'real-nas-remote-backup evidence must exact-include runtimeVersion:V1.44',
    );
    assert.ok(
      nasItem.evidence.includes('copy.state:replicated'),
      'real-nas-remote-backup evidence must exact-include copy.state:replicated',
    );
    assert.ok(
      nasItem.evidence.includes('recovery.state:recovered'),
      'real-nas-remote-backup evidence must exact-include recovery.state:recovered',
    );
    assert.ok(
      nasItem.evidence.includes('audit.status:healthy'),
      'real-nas-remote-backup evidence must exact-include audit.status:healthy',
    );
    assert.ok(
      nasItem.evidence.includes('completedMarkerValid:true'),
      'real-nas-remote-backup evidence must exact-include completedMarkerValid:true',
    );
    assert.ok(
      nasItem.evidence.includes('firstPublishedSnapshotPreserved:true'),
      'real-nas-remote-backup evidence must exact-include firstPublishedSnapshotPreserved:true',
    );
  });

  // The two V1.46 security-auth tests below were introduced together and were
  // first observed as behavior RED on the pre-V1.46 HEAD as two independent
  // failures (evidence tail; nextStep honesty). They are kept as separate
  // `it` blocks so each contract half is observed independently; both pass
  // against the current V1.46 production contract.
  it('locks V1.46 security-auth management auth Keychain evidence tail', () => {
    const report = buildGoldReadinessReport({ now: new Date("2026-07-06T12:00:00.000Z") });

    // Regression guards: security-auth stays partial and the report
    // summary counts remain unchanged.
    const securityItem = report.items.find(item => item.id === 'security-auth');
    assert.ok(securityItem, 'security-auth should exist');
    assert.strictEqual(securityItem.status, 'partial');
    assert.deepStrictEqual(report.summary, { ready: 6, partial: 3, blocked: 0, total: 9 });

    // V1.46 contract: the item evidence array must end with the exact
    // ordered V1.46 management auth Keychain evidence atoms.
    assert.ok(Array.isArray(securityItem.evidence), 'security-auth evidence must be an array');
    assert.deepStrictEqual(
      securityItem.evidence.slice(-V146_SECURITY_AUTH_EVIDENCE_TAIL.length),
      [...V146_SECURITY_AUTH_EVIDENCE_TAIL],
      'security-auth evidence tail must be the exact ordered V1.46 management auth Keychain evidence atoms',
    );
  });

  it('locks V1.46 security-auth nextStep honesty contract', () => {
    const report = buildGoldReadinessReport({ now: new Date("2026-07-06T12:00:00.000Z") });
    const securityItem = report.items.find(item => item.id === 'security-auth');
    assert.ok(securityItem, 'security-auth should exist');
    const nextStep = securityItem.nextStep || '';

    // V1.46 contract: nextStep must still name the unfinished work
    // (case-insensitive containment, semantically exact fragments).
    for (const fragment of [
      'code-level partial evidence',
      'real macOS Keychain provisioning/acceptance',
      'controlled-restart rotation real-host acceptance',
      'four-scope production staging/process-lock CLI',
      'identity/user RBAC',
      'headless bootstrap/unlock real-host acceptance',
      'token-memory exposure review',
      'real-host core-dump-limit acceptance',
      'production-grade audit',
      'distributed rate limiting',
      'independent production security review',
    ]) {
      assert.ok(
        nextStep.toLowerCase().includes(fragment.toLowerCase()),
        `security-auth nextStep must name unfinished work: ${fragment}`,
      );
    }

    // V1.46 contract: nextStep must carry each clause-local direct negation
    // verbatim, so the clause-local honesty scanners find a local negative
    // context in every clause that mentions a controlled phrase.
    for (const negation of V146_SECURITY_AUTH_NEXTSTEP_NEGATIONS) {
      assert.ok(
        nextStep.includes(negation),
        `security-auth nextStep must contain the direct do-not-claim clause: ${negation}`,
      );
    }

    // V1.46 contract: phrase-level overclaim guard — once each clause-local
    // direct negation is removed, no bare positive readiness claim may
    // survive in the remainder.
    let stripped = nextStep.toLowerCase();
    for (const negation of V146_SECURITY_AUTH_NEXTSTEP_NEGATIONS) {
      stripped = stripped.split(negation.toLowerCase()).join(' ');
    }
    for (const phrase of V146_SECURITY_AUTH_OVERCLAIM_PHRASES) {
      assert.ok(
        !stripped.includes(phrase),
        `security-auth nextStep must not contain bare positive "${phrase}" outside the direct negation clauses`,
      );
    }
  });

  it('rejects vague evidence strings like implemented, works, done, available', () => {
    const report = buildGoldReadinessReport({ now: new Date("2026-07-06T12:00:00.000Z") });
    const vagueWords = ['implemented', 'works', 'done', 'available'];
    for (const item of report.items) {
      // Strip boolean false tokens, the registered fail-closed error code
      // (audit-delivery-unavailable contains substring "available" but is not a readiness claim),
      // and the V1.45 adapter-available schema fact atom (adapterAvailable:true lowercases to
      // contain "available" but is an exact configuration fact, not a readiness claim).
      const evidence = evidenceText(item)
        .toLowerCase()
        .replaceAll('available:false', '')
        .replaceAll('audit-delivery-unavailable', '')
        .replaceAll('adapteravailable:true', '');
      for (const word of vagueWords) {
        assert.ok(
          !evidence.includes(word),
          `evidence for item "${item.id}" contains vague word "${word}": "${item.evidence}"`
        );
      }
    }
  });

  it('verifies that descriptive text distinguishes Gold from release readiness and explains Gold can remain blocked', () => {
    const report = buildGoldReadinessReport({ now: new Date("2026-07-06T12:00:00.000Z") });
    assert.ok(typeof report.description === 'string' || typeof report.note === 'string');
    const text = report.description || report.note || '';

    assert.match(text, /gold/i);
    assert.match(text, /release readiness/i);
    assert.match(text, /blocked/i);
    assert.match(
      text,
      /(healthy|passing|ok)/i,
      'Explanation must reference release readiness status like healthy/passing/ok'
    );
  });
});
