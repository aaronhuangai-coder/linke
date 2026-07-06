import { LINKE_RELEASE_VERSION } from './version.js';

const GOLD_READINESS_ITEMS = [
  {
    id: 'release-readiness',
    area: 'release',
    label: 'Release readiness gate',
    status: 'ready',
    evidence: [
      'test/release-readiness.test.js',
      'test/agent-release-readiness.test.js',
      'test/agent-gold-readiness.test.js',
      'test/health.test.js',
      'GET /api/health',
      'GET /api/release-readiness',
      'GET /api/gold-readiness',
      'src/agent.js gold-readiness --fail-on-blocked',
    ],
    nextStep: 'Keep runtime release checks, Gold blocker automation, and version guard coverage aligned.',
  },
  {
    id: 'local-backup-restore',
    area: 'backup',
    label: 'Local backup and restore prototype',
    status: 'ready',
    evidence: [
      'test/restore.test.js',
      'test/restore-dry-run.test.js',
      'test/manifest.test.js',
      'test/concurrency.test.js',
      'test/security.test.js',
    ],
    nextStep: 'Keep local snapshot, manifest, restore, concurrency, and path-safety tests green.',
  },
  {
    id: 'fleet-device-management',
    area: 'fleet',
    label: 'Read-only snapshot and heartbeat-state fleet display',
    status: 'ready',
    evidence: [
      'test/heartbeat.test.js',
      'test/web-console.test.js',
    ],
    nextStep: 'Keep this limited to read-only snapshot and heartbeat-state display until active control is designed.',
  },
  {
    id: 'version-consistency',
    area: 'versions',
    label: 'Cross-device backup version consistency view',
    status: 'ready',
    evidence: [
      'test/web-console.test.js',
    ],
    nextStep: 'Keep backup version consistency, coverage gap, filter, and sort panels covered by Web Console tests.',
  },
  {
    id: 'nas-dry-run',
    area: 'nas',
    label: 'NAS provider dry-run and app adapter plan',
    status: 'partial',
    evidence: [
      'test/nas-dry-run.test.js',
      'test/agent-nas-dry-run.test.js',
      'src/agent.js nas-dry-run --readiness-summary',
      'src/agent.js nas-dry-run --fail-on-blocked',
      'test/config.test.js',
      'src/config.js validateNasCredentialRef',
      'src/config.js ALLOWED_NAS_CREDENTIAL_REF_PATTERN',
      'credentialRefConfigured',
      'executionGate',
      'src/web/app.js executionGate and credentialRefConfigured rendering',
      'test/web-console.test.js executionGate DOM tests',
      'src/config.js FORBIDDEN_NAS_CREDENTIAL_FIELDS 15 exact keys',
      'readinessSummary',
      'executionReadiness',
      'src/web/app.js readinessSummary and executionReadiness rendering',
      'test/web-console.test.js readinessSummary DOM tests',
    ],
    nextStep: 'No real NAS connection is made in V0.69; credentialRef is only a non-secret reference foundation, FORBIDDEN_NAS_CREDENTIAL_FIELDS rejects 15 exact keys, executionGate keeps real NAS transport blocked, and readinessSummary counts target blockers while --fail-on-blocked gates automation.',
  },
  {
    id: 'automation-installation',
    area: 'automation',
    label: 'Agent run-once and launchd dry-run',
    status: 'partial',
    evidence: [
      'test/agent-run-once.test.js',
      'test/launchd-dry-run.test.js',
      'test/agent-supervisor-install-dry-run.test.js',
      'src/agent.js supervisor-install-dry-run',
      'src/agent.js buildSupervisorInstallDryRunPlan',
      'src/agent.js buildSupervisorInstallReadinessSummary',
      'src/agent.js buildSupervisorInstallCommandPreview',
      'src/agent.js supervisor-install-dry-run --readiness-summary',
      'src/agent.js supervisor-install-dry-run --fail-on-blocked',
      'readinessSummary.state:blocked',
      'installCommandPreview.state:blocked',
      'installCommandPreview.actions:wouldRun:false',
      'src/agent.js buildSupervisorInstallPreflight',
      'installPreflight.state:blocked',
      'installPreflight.checks:requiredForInstall:true',
      'src/agent.js buildSupervisorInstallApprovalManifest',
      'installApprovalManifest.state:blocked',
      'installApprovalManifest.approval.approved:false',
      'installApprovalManifest.rollback.available:false',
      'GET /api/supervisor-status',
      'src/server.js buildSupervisorStatusResponse',
      'src/agent.js supervisor-status',
      'src/web/app.js buildSupervisorStatusViewModel',
      'src/web/index.html supervisor-status-panel',
      'test/web-console.test.js supervisor-status panel',
      'test/agent-supervisor-status.test.js',
      'test/health.test.js supervisor-status',
      'supervisor.state:not_configured',
      'supervisorInstalled:false',
    ],
    nextStep: 'V0.83 adds a dry-run approval and rollback manifest on top of the V0.82 preflight gate, while supervisor install remains blocked and not_configured; add real installer, launchd install/start, watchdog, monitoring, approval persistence, rollback, uninstall, recovery supervisor, secret management, and managed daemon lifecycle only after production boundaries are designed.',
  },
  {
    id: 'security-auth',
    area: 'security',
    label: 'Optional API bearer token authentication skeleton',
    status: 'partial',
    evidence: [
      'src/server.js authToken API gate',
      'src/server.js read/write token scope gate',
      'src/server.js API_WRITE_ROUTES',
      'src/server.js isApiWriteRoute',
      'src/server.js formatApiRoute',
      'src/server.js buildAuthStatusResponse',
      'GET /api/auth-status',
      'src/agent.js auth-status',
      'src/agent.js --token option',
      'src/web/app.js in-memory API token header',
      'Authorization: Bearer header',
      'LINKE_READ_TOKEN',
      'LINKE_WRITE_TOKEN',
      'configuredScopes',
      'writeRoutes',
      'tokenValuesReturned:false',
      '403 Forbidden',
      'auth.forbidden',
      'test/security.test.js',
      'test/health.test.js',
      'test/agent-health.test.js',
      'test/agent-auth-status.test.js',
      'test/web-console.test.js',
    ],
    nextStep: 'Add role-based authorization, token rotation, secret management, production-grade audit, distributed rate limiting, and production security review before any Gold release claim.',
  },
  {
    id: 'real-nas-remote-backup',
    area: 'nas',
    label: 'Real NAS remote backup execution',
    status: 'blocked',
    evidence: [
      'README NAS safety boundary',
      'test/nas-dry-run.test.js',
    ],
    nextStep: 'Implement real NAS connection, transfer, and remote backup execution in a separate guarded release.',
  },
  {
    id: 'production-hardening',
    area: 'operations',
    label: 'Production hardening and supervisor',
    status: 'partial',
    evidence: [
      'src/server.js MAX_JSON_BODY_BYTES',
      'src/server.js LINKE_RESTORE_ROOT',
      'src/server.js resolveRestoreTargetPath',
      'src/storage.js RestoreTargetError',
      'src/storage.js O_NOFOLLOW',
      'src/audit-log.js',
      'src/rate-limit.js',
      'GET /api/audit-log',
      'test/agent-audit-log.test.js',
      'src/agent.js audit-log',
      'src/web/app.js buildAuditLogViewModel',
      'test/web-console.test.js audit-log panel',
      'GET /api/hardening-status',
      'src/server.js buildHardeningStatusResponse',
      'test/agent-hardening-status.test.js',
      'src/agent.js hardening-status',
      'GET /api/supervisor-status',
      'src/server.js buildSupervisorStatusResponse',
      'test/agent-supervisor-status.test.js',
      'src/agent.js supervisor-status',
      'test/agent-supervisor-install-dry-run.test.js',
      'src/agent.js supervisor-install-dry-run',
      'src/agent.js buildSupervisorInstallDryRunPlan',
      'src/agent.js buildSupervisorInstallReadinessSummary',
      'src/agent.js buildSupervisorInstallCommandPreview',
      'src/agent.js supervisor-install-dry-run --readiness-summary',
      'src/agent.js supervisor-install-dry-run --fail-on-blocked',
      'readinessSummary.state:blocked',
      'installCommandPreview.state:blocked',
      'installCommandPreview.actions:wouldRun:false',
      'src/agent.js buildSupervisorInstallPreflight',
      'installPreflight.state:blocked',
      'installPreflight.checks:requiredForInstall:true',
      'src/agent.js buildSupervisorInstallApprovalManifest',
      'installApprovalManifest.state:blocked',
      'installApprovalManifest.approval.approved:false',
      'installApprovalManifest.rollback.available:false',
      'supervisor.state:not_configured',
      'supervisorInstalled:false',
      'src/web/app.js buildSupervisorStatusViewModel',
      'src/web/index.html supervisor-status-panel',
      'test/web-console.test.js supervisor-status panel',
      'src/web/app.js buildHardeningStatusViewModel',
      'test/web-console.test.js hardening-status panel',
      'LINKE_AUDIT_MAX_EVENTS',
      'Audit retention newest events',
      'LINKE_RATE_LIMIT_PER_MINUTE',
      '413 Request body too large',
      '429 Rate limit exceeded',
      'Internal Server Error',
      'test/audit-log.test.js',
      'test/rate-limit.test.js',
      'README production safety boundary',
      'test/security.test.js',
      'test/restore.test.js',
      'test/restore-dry-run.test.js',
      'test/readme.test.js',
    ],
    nextStep: 'Recent releases add read-only Agent/Web visibility, supervisor-status not_configured reporting, supervisor install dry-run planning, supervisor install readiness gating, non-runnable install command preview, blocked install preflight checks, and a dry-run approval/rollback manifest; still add deployment hardening, audit rotation, tamper-proof audit storage, distributed rate limiting, secret management, monitoring, approval persistence, rollback, uninstall, and recovery supervisor.',
  },
];

function toIsoString(now) {
  const date = now instanceof Date ? now : new Date(now);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function cloneItems() {
  return GOLD_READINESS_ITEMS.map((item) => ({
    ...item,
    evidence: item.evidence.slice(),
  }));
}

function buildSummary(items) {
  const summary = {
    ready: 0,
    partial: 0,
    blocked: 0,
    total: items.length,
  };

  for (const item of items) {
    if (item.status === 'ready') summary.ready += 1;
    else if (item.status === 'partial') summary.partial += 1;
    else if (item.status === 'blocked') summary.blocked += 1;
  }

  return summary;
}

function buildOverallStatus(summary) {
  if (summary.blocked > 0) return 'blocked';
  if (summary.partial > 0) return 'partial';
  return 'ready';
}

/**
 * Build a static, code-owned Gold release capability and blocker scorecard.
 */
export function buildGoldReadinessReport({ now = new Date() } = {}) {
  const items = cloneItems();
  const summary = buildSummary(items);

  return {
    status: buildOverallStatus(summary),
    version: LINKE_RELEASE_VERSION,
    generatedAt: toIsoString(now),
    description: 'Gold readiness is a static, code-owned, manually maintained capability/blocker scorecard distinct from release readiness; Gold can remain blocked even when release readiness is healthy, passing, or ok. generatedAt is the report creation time only, not evidence of live checks.',
    summary,
    items,
  };
}
