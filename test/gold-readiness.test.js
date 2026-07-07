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

describe('Gold Readiness Report', () => {
  it('expects LINKE_RELEASE_VERSION to be V0.92', () => {
    assert.strictEqual(LINKE_RELEASE_VERSION, 'V0.92');
  });

  it('expects report.version to be V0.92', () => {
    const report = buildGoldReadinessReport({ now: new Date("2026-07-07T12:00:00.000Z") });
    assert.strictEqual(report.version, 'V0.92');
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
    assert.ok(automationItem.nextStep.includes('V0.92'));
    assert.ok(automationItem.nextStep.includes('V0.91'));
    assert.ok(automationItem.nextStep.includes('V0.90'));
    assert.ok(automationItem.nextStep.includes('V0.89'));
    assert.ok(automationItem.nextStep.includes('rollbackUninstallPlan'));
    assert.ok(automationItem.nextStep.includes('Web Console'));
    assert.ok(automationItem.nextStep.includes('approval'));
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
    assert.ok(hardeningItem.nextStep.includes('preflight'));
    assert.ok(hardeningItem.nextStep.includes('approval'));
    assert.ok(hardeningItem.nextStep.includes('rollback'));
    assert.ok(hardeningItem.nextStep.includes('V0.92'));
    assert.ok(hardeningItem.nextStep.includes('V0.91'));
    assert.ok(hardeningItem.nextStep.includes('V0.90'));
    assert.ok(hardeningItem.nextStep.includes('V0.89'));
    assert.ok(hardeningItem.nextStep.includes('rollbackUninstallPlan'));
    assert.ok(hardeningItem.nextStep.includes('Web dry-run panel'));
    assert.ok(hardeningItem.nextStep.includes('uninstall'));
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
