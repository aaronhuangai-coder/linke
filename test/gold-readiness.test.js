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
  assert.ok(evidence.includes('buildSupervisorLifecycleGuardedRunnerRegistryReadiness'));
  assert.ok(evidence.includes('runnerRegistryReadiness.state:blocked'));
  assert.ok(evidence.includes('runnerRegistryReady:false'));
  assert.ok(evidence.includes('runner-registry-real-implementation-missing'));
  assert.ok(evidence.includes('buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness'));
  assert.ok(evidence.includes('hostMutationAdapterReadiness.state:blocked'));
  assert.ok(evidence.includes('hostMutationAdapterReady:false'));
  assert.ok(evidence.includes('host-mutation-adapter-real-implementation-missing'));
}

describe('Gold Readiness Report', () => {
  it('expects LINKE_RELEASE_VERSION to be V1.19', () => {
    assert.strictEqual(LINKE_RELEASE_VERSION, 'V1.19');
  });

  it('expects report.version to be V1.19', () => {
    const report = buildGoldReadinessReport({ now: new Date("2026-07-07T12:00:00.000Z") });
    assert.strictEqual(report.version, 'V1.19');
  });

  it('expects status blocked and correct summary count', () => {
    const report = buildGoldReadinessReport({ now: new Date("2026-07-06T12:00:00.000Z") });
    assert.strictEqual(report.status, 'blocked');
    assert.deepStrictEqual(report.summary, { ready: 4, partial: 4, blocked: 1, total: 9 });
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

  it('verifies security-auth and production-hardening are partial while real-nas-remote-backup remains blocked', () => {
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
    assert.ok(hardeningItem.nextStep.includes('preflight'));
    assert.ok(hardeningItem.nextStep.includes('approval'));
    assert.ok(hardeningItem.nextStep.includes('rollback'));
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
    assert.strictEqual(nasItem.status, 'blocked');
  });

  it('rejects vague evidence strings like implemented, works, done, available', () => {
    const report = buildGoldReadinessReport({ now: new Date("2026-07-06T12:00:00.000Z") });
    const vagueWords = ['implemented', 'works', 'done', 'available'];
    for (const item of report.items) {
      const evidence = evidenceText(item).toLowerCase().replaceAll('available:false', '');
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
