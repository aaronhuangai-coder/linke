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
      'test/health.test.js',
      'GET /api/health',
      'GET /api/release-readiness',
    ],
    nextStep: 'Keep runtime release checks and version guard coverage aligned.',
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
      'test/config.test.js',
    ],
    nextStep: 'No real NAS connection is made in V0.54; implement authenticated NAS connection separately.',
  },
  {
    id: 'automation-installation',
    area: 'automation',
    label: 'Agent run-once and launchd dry-run',
    status: 'partial',
    evidence: [
      'test/agent-run-once.test.js',
      'test/launchd-dry-run.test.js',
    ],
    nextStep: 'Add installer and managed daemon lifecycle only after auth and production boundaries are designed.',
  },
  {
    id: 'security-auth',
    area: 'security',
    label: 'Optional API bearer token authentication skeleton',
    status: 'partial',
    evidence: [
      'src/server.js authToken API gate',
      'src/agent.js --token option',
      'src/web/app.js in-memory API token header',
      'Authorization: Bearer header',
      'test/security.test.js',
      'test/agent-health.test.js',
      'test/web-console.test.js',
    ],
    nextStep: 'Add role-based authorization, token rotation, secret management, audit logs, rate limiting, and production security review before any Gold release claim.',
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
    status: 'blocked',
    evidence: [
      'README production safety boundary',
      'test/readme.test.js',
    ],
    nextStep: 'Add deployment hardening, audit trail, secret management, monitoring, and recovery supervisor.',
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
