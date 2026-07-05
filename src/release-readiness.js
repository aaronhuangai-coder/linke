import { LINKE_RELEASE_VERSION } from './version.js';

const REQUIRED_HEALTH_FIELDS = ['status', 'service', 'version', 'checks', 'timestamp'];
const ALLOWED_HEALTH_FIELDS = new Set(REQUIRED_HEALTH_FIELDS);
const REQUIRED_CHECK_FIELDS = ['http', 'dataDirReadable'];
const ALLOWED_CHECK_FIELDS = new Set(REQUIRED_CHECK_FIELDS);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeValue(value) {
  if (value === undefined) return null;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'string') return typeof value;
  if (value.includes('/') || value.includes('\\')) return '[redacted]';
  if (value.length > 80) return `${value.slice(0, 77)}...`;
  return value;
}

function collectSchemaIssues(health) {
  if (!isPlainObject(health)) {
    return ['health payload is not an object'];
  }

  const issues = [];
  const topLevelFields = Object.keys(health);
  const unexpectedTopLevelFields = topLevelFields.filter((field) => !ALLOWED_HEALTH_FIELDS.has(field));
  const missingTopLevelFields = REQUIRED_HEALTH_FIELDS.filter((field) => !Object.hasOwn(health, field));

  if (unexpectedTopLevelFields.length > 0) {
    issues.push(`unexpected top-level fields: ${unexpectedTopLevelFields.join(', ')}`);
  }
  if (missingTopLevelFields.length > 0) {
    issues.push(`missing top-level fields: ${missingTopLevelFields.join(', ')}`);
  }

  if (!isPlainObject(health.checks)) {
    issues.push('checks is not an object');
    return issues;
  }

  const checkFields = Object.keys(health.checks);
  const unexpectedCheckFields = checkFields.filter((field) => !ALLOWED_CHECK_FIELDS.has(field));
  const missingCheckFields = REQUIRED_CHECK_FIELDS.filter((field) => !Object.hasOwn(health.checks, field));

  if (unexpectedCheckFields.length > 0) {
    issues.push(`unexpected checks fields: ${unexpectedCheckFields.join(', ')}`);
  }
  if (missingCheckFields.length > 0) {
    issues.push(`missing checks fields: ${missingCheckFields.join(', ')}`);
  }

  return issues;
}

function buildCheck(id, ok, expected, actual) {
  return {
    id,
    ok: Boolean(ok),
    expected,
    actual: sanitizeValue(actual),
  };
}

function toIsoString(now) {
  const date = now instanceof Date ? now : new Date(now);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

/**
 * Build a sanitized, script-friendly release readiness report from `/api/health`.
 */
export function buildReleaseReadinessReport(health, {
  expectedVersion = LINKE_RELEASE_VERSION,
  now = new Date(),
} = {}) {
  const schemaIssues = collectSchemaIssues(health);
  const checks = [
    buildCheck(
      'health.schema',
      schemaIssues.length === 0,
      'top-level fields: status, service, version, checks, timestamp; checks fields: http, dataDirReadable',
      schemaIssues.length === 0 ? 'allowed schema' : schemaIssues.join('; '),
    ),
    buildCheck('health.status', health?.status === 'ok', 'ok', health?.status),
    buildCheck('health.service', health?.service === 'linke', 'linke', health?.service),
    buildCheck('release.version', health?.version === expectedVersion, expectedVersion, health?.version),
    buildCheck('health.checks.http', health?.checks?.http === 'ok', 'ok', health?.checks?.http),
    buildCheck(
      'health.checks.dataDirReadable',
      health?.checks?.dataDirReadable === 'ok',
      'ok',
      health?.checks?.dataDirReadable,
    ),
    buildCheck(
      'health.timestamp',
      Number.isFinite(Date.parse(health?.timestamp)),
      'parseable ISO timestamp',
      health?.timestamp,
    ),
  ];

  return {
    ready: checks.every((check) => check.ok),
    service: sanitizeValue(health?.service) || null,
    expectedVersion,
    actualVersion: sanitizeValue(health?.version),
    status: sanitizeValue(health?.status),
    checkedAt: toIsoString(now),
    checks,
  };
}
