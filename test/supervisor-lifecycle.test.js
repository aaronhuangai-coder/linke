import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildSupervisorLifecycleApplyPlan,
  hashLifecycleObject,
  resolveSupervisorLifecyclePathBoundary,
  validateSupervisorLifecycleApproval,
} from '../src/supervisor-lifecycle.js';

const NOW = new Date('2026-07-07T05:00:00.000Z');
const APPROVED_AT = '2026-07-07T04:30:00.000Z';
const EXPIRES_AT = '2026-07-07T05:30:00.000Z';
const BASE_CONFIG = Object.freeze({
  serverUrl: 'http://localhost:3000',
  deviceId: 'macbook-alpha',
  backupJobs: [{ name: 'Documents', sourcePath: '/Users/ah/Documents' }],
});
const EXPECTED = Object.freeze({
  operation: 'install',
  configHash: 'sha256:config',
  planHash: 'sha256:plan',
});

function validApproval(overrides = {}) {
  return {
    operation: 'install',
    configHash: 'sha256:config',
    planHash: 'sha256:plan',
    approved: true,
    schemaVersion: 1,
    approvedBy: 'operator@example.invalid',
    reason: 'V0.87 safety-gate test approval',
    acknowledgements: ['no-real-host-mutation-in-v0.87'],
    approvedAt: APPROVED_AT,
    expiresAt: EXPIRES_AT,
    ignoredByExecutor: 'must-not-grant-approval',
    ...overrides,
  };
}

describe('Supervisor lifecycle safety gate', () => {
  it('hashLifecycleObject returns stable sha256 hashes for normalized objects', () => {
    const first = hashLifecycleObject({ b: 2, a: { y: [3, 2], z: 1 } });
    const second = hashLifecycleObject({ a: { z: 1, y: [3, 2] }, b: 2 });

    assert.match(first, /^sha256:[a-f0-9]{64}$/);
    assert.strictEqual(first, second);
    assert.notStrictEqual(first, hashLifecycleObject({ b: 3, a: { y: [3, 2], z: 1 } }));
  });

  it('validateSupervisorLifecycleApproval accepts exact matching approval within one hour', () => {
    const result = validateSupervisorLifecycleApproval(validApproval(), { ...EXPECTED, now: NOW });

    assert.deepStrictEqual(result, { valid: true, blockers: [] });
  });

  it('validateSupervisorLifecycleApproval rejects approvals that are not explicitly granted', () => {
    const result = validateSupervisorLifecycleApproval(
      validApproval({ approved: false }),
      { ...EXPECTED, now: NOW },
    );

    assert.deepStrictEqual(result.blockers, ['approval-not-granted']);
  });

  it('validateSupervisorLifecycleApproval rejects unknown fields that try to replace required fields', () => {
    const { approved, ...approvalWithoutGrant } = validApproval({
      ignoredApproved: true,
    });

    const result = validateSupervisorLifecycleApproval(approvalWithoutGrant, { ...EXPECTED, now: NOW });

    assert.strictEqual(approved, true);
    assert.deepStrictEqual(result.blockers, ['approval-missing-required-fields']);
  });

  it('validateSupervisorLifecycleApproval rejects malformed schema and acknowledgement fields', () => {
    assert.deepStrictEqual(
      validateSupervisorLifecycleApproval(
        validApproval({ schemaVersion: 2 }),
        { ...EXPECTED, now: NOW },
      ).blockers,
      ['approval-missing-required-fields'],
    );
    assert.deepStrictEqual(
      validateSupervisorLifecycleApproval(
        validApproval({ acknowledgements: [''] }),
        { ...EXPECTED, now: NOW },
      ).blockers,
      ['approval-missing-required-fields'],
    );
  });

  it('validateSupervisorLifecycleApproval rejects expired or over-wide approval windows', () => {
    assert.deepStrictEqual(
      validateSupervisorLifecycleApproval(validApproval({
        approvedAt: '2026-07-07T03:00:00.000Z',
        expiresAt: '2026-07-07T05:01:00.000Z',
      }), { ...EXPECTED, now: NOW }).blockers,
      ['approval-window-too-wide'],
    );
    assert.deepStrictEqual(
      validateSupervisorLifecycleApproval(validApproval({
        approvedAt: '2026-07-07T03:00:00.000Z',
        expiresAt: '2026-07-07T04:00:00.000Z',
      }), { ...EXPECTED, now: NOW }).blockers,
      ['approval-expired'],
    );
  });

  it('validateSupervisorLifecycleApproval rejects operation, configHash, and planHash mismatches', () => {
    const result = validateSupervisorLifecycleApproval(validApproval({
      operation: 'rollback',
      configHash: 'sha256:other-config',
      planHash: 'sha256:other-plan',
    }), { ...EXPECTED, now: NOW });

    assert.deepStrictEqual(result.blockers, [
      'approval-operation-mismatch',
      'approval-config-hash-mismatch',
      'approval-plan-hash-mismatch',
    ]);
  });

  it('resolveSupervisorLifecyclePathBoundary allows user LaunchAgents, staging root, and metadata root only', () => {
    const options = {
      userLaunchAgentsDir: '/Users/ah/Library/LaunchAgents',
      stagingRoot: '/tmp/linke-supervisor-staging',
      metadataRoot: '/tmp/linke-supervisor-metadata',
    };

    assert.strictEqual(
      resolveSupervisorLifecyclePathBoundary('/Users/ah/Library/LaunchAgents/com.linke.agent.plist', options).allowed,
      true,
    );
    assert.strictEqual(
      resolveSupervisorLifecyclePathBoundary('/tmp/linke-supervisor-staging/com.linke.agent.plist', options).allowed,
      true,
    );
    assert.strictEqual(
      resolveSupervisorLifecyclePathBoundary('/tmp/linke-supervisor-metadata/rollback.json', options).allowed,
      true,
    );
    assert.deepStrictEqual(
      resolveSupervisorLifecyclePathBoundary('/Users/ah/Desktop/com.linke.agent.plist', options),
      { allowed: false, blockerCode: 'path-outside-allowed-roots' },
    );
  });

  it('resolveSupervisorLifecyclePathBoundary rejects traversal and symlink-like unresolved paths', () => {
    const options = { userLaunchAgentsDir: '/Users/ah/Library/LaunchAgents', stagingRoot: '/tmp/staging' };

    assert.deepStrictEqual(
      resolveSupervisorLifecyclePathBoundary('/tmp/staging/../escape.plist', options),
      { allowed: false, blockerCode: 'path-traversal-or-unresolved' },
    );
    assert.deepStrictEqual(
      resolveSupervisorLifecyclePathBoundary('', options),
      { allowed: false, blockerCode: 'path-not-string' },
    );
  });

  it('resolveSupervisorLifecyclePathBoundary rejects missing roots and prefix collisions', () => {
    assert.deepStrictEqual(
      resolveSupervisorLifecyclePathBoundary('/tmp/staging/file.plist'),
      { allowed: false, blockerCode: 'path-outside-allowed-roots' },
    );
    assert.deepStrictEqual(
      resolveSupervisorLifecyclePathBoundary('/tmp/staging-evil/file.plist', { stagingRoot: '/tmp/staging' }),
      { allowed: false, blockerCode: 'path-outside-allowed-roots' },
    );
  });

  it('buildSupervisorLifecycleApplyPlan blocks recover until recovery supervisor design exists', () => {
    const plan = buildSupervisorLifecycleApplyPlan(BASE_CONFIG, { operation: 'recover', now: NOW });

    assert.strictEqual(plan.operation, 'recover');
    assert.strictEqual(plan.state, 'blocked');
    assert.ok(plan.blockers.includes('recovery-supervisor-design-missing'));
    assert.strictEqual(plan.safety.launchctlCalled, false);
    assert.strictEqual(plan.safety.filesystemWritten, false);
  });

  it('buildSupervisorLifecycleApplyPlan defaults to blocked dry-run with no host mutation', () => {
    const plan = buildSupervisorLifecycleApplyPlan(BASE_CONFIG, { operation: 'install', now: NOW });

    assert.strictEqual(plan.mode, 'dry-run-only');
    assert.strictEqual(plan.operation, 'install');
    assert.strictEqual(plan.applyRequested, false);
    assert.strictEqual(plan.state, 'blocked');
    assert.ok(plan.blockers.includes('apply-flag-required'));
    assert.ok(plan.blockers.includes('executor-implementation-missing'));
    assert.match(plan.configHash, /^sha256:[a-f0-9]{64}$/);
    assert.match(plan.planHash, /^sha256:[a-f0-9]{64}$/);
    assert.ok(plan.actions.every((action) => action.wouldRun === false && action.wouldWrite === false));
    assert.deepStrictEqual(plan.safety, {
      dryRun: true,
      hostMutation: false,
      launchctlCalled: false,
      filesystemWritten: false,
      metadataWritten: false,
      rollbackAnchorWritten: false,
      auditEventWritten: false,
      sensitiveValuesReturned: false,
    });
  });

  it('buildSupervisorLifecycleApplyPlan reports env gate and missing approval blockers without mutation', () => {
    const dryRunPlan = buildSupervisorLifecycleApplyPlan(BASE_CONFIG, { operation: 'install', now: NOW });
    const withoutEnvGate = buildSupervisorLifecycleApplyPlan(BASE_CONFIG, {
      operation: 'install',
      apply: true,
      approval: validApproval({
        configHash: dryRunPlan.configHash,
        planHash: dryRunPlan.planHash,
      }),
      now: NOW,
    });
    const withoutApproval = buildSupervisorLifecycleApplyPlan(BASE_CONFIG, {
      operation: 'install',
      apply: true,
      envGateEnabled: true,
      now: NOW,
    });

    assert.ok(withoutEnvGate.blockers.includes('env-gate-disabled'));
    assert.ok(withoutEnvGate.blockers.includes('executor-implementation-missing'));
    assert.strictEqual(withoutEnvGate.safety.hostMutation, false);
    assert.ok(withoutApproval.blockers.includes('approval-missing'));
    assert.ok(withoutApproval.blockers.includes('executor-implementation-missing'));
    assert.strictEqual(withoutApproval.safety.hostMutation, false);
  });

  it('buildSupervisorLifecycleApplyPlan defaults unknown operations to install', () => {
    const plan = buildSupervisorLifecycleApplyPlan(BASE_CONFIG, { operation: 'restart', now: NOW });

    assert.strictEqual(plan.operation, 'install');
    assert.ok(plan.blockers.includes('executor-implementation-missing'));
  });

  it('buildSupervisorLifecycleApplyPlan does not return raw approval metadata', () => {
    const dryRunPlan = buildSupervisorLifecycleApplyPlan(BASE_CONFIG, { operation: 'install', now: NOW });
    const plan = buildSupervisorLifecycleApplyPlan(BASE_CONFIG, {
      operation: 'install',
      apply: true,
      envGateEnabled: true,
      approval: validApproval({
        configHash: dryRunPlan.configHash,
        planHash: dryRunPlan.planHash,
      }),
      now: NOW,
    });
    const serialized = JSON.stringify(plan);

    assert.deepStrictEqual(plan.blockers, ['executor-implementation-missing']);
    assert.ok(plan.blockers.includes('executor-implementation-missing'));
    assert.strictEqual(plan.safety.dryRun, true);
    assert.doesNotMatch(serialized, /operator@example|safety-gate test approval|acknowledgements/);
  });
});
