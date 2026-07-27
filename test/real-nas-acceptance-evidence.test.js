/**
 * C0 RED contract for pure real-NAS acceptance evidence validation.
 * Production module is intentionally absent at RED.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REAL_NAS_ACCEPTANCE_EVIDENCE_INVALID,
  validateRealNasAcceptanceEvidence,
} from '../src/real-nas-acceptance-evidence.js';

const FIXED_CODE = 'real-nas-acceptance-evidence-invalid';
const FIXED_NAME = 'RealNasAcceptanceEvidenceError';
const HEX40 = 'a'.repeat(40);
const HEX64 = 'b'.repeat(64);
const HEX40_UPPER = 'A'.repeat(40);
const HEX64_UPPER = 'B'.repeat(64);
const HEX39 = 'a'.repeat(39);
const HEX41 = 'a'.repeat(41);
const HEX63 = 'b'.repeat(63);
const HEX65 = 'b'.repeat(65);
const HEX40_NON = 'g'.repeat(40);
const HEX64_NON = 'g'.repeat(64);
const UNSAFE_INT = Number.MAX_SAFE_INTEGER + 1;

/** Canonical valid fixture for V1.44 real-NAS acceptance evidence. */
function validEvidence() {
  return {
    schemaVersion: 1,
    kind: 'linke-real-nas-acceptance',
    acceptanceId: 'NAS-REAL-V144-20260727-01',
    runtimeVersion: 'V1.44',
    runtimeSourceCommit: HEX40,
    acceptedAt: '2026-07-27T04:00:00.000Z',
    environment: 'non-production',
    provider: 'synology',
    mountType: 'smbfs',
    copy: {
      state: 'replicated',
      fileCount: 2,
      totalBytes: 9,
      verifiedFileCount: 2,
      manifestSha256: HEX64,
      completedMarkerValid: true,
      lockResidualCount: 0,
      stagingResidualCount: 0,
    },
    recovery: {
      scenario: 'staging-ready-process-termination',
      terminationSignal: 'SIGKILL',
      staleLockValidated: true,
      stagedFileCount: 2,
      stagedVerifiedFileCount: 2,
      state: 'recovered',
      finalPublished: false,
      postFinalExists: false,
      lockResidualCount: 0,
      stagingResidualCount: 0,
      residualFileCount: 0,
      firstPublishedSnapshotPreserved: true,
    },
    audit: {
      status: 'healthy',
      dualWriteState: 'idle',
      relationship: 'equal',
      recoveryRequired: false,
    },
  };
}

/** Recursive freeze for local fixtures only. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(value[key]);
  }
  return Object.freeze(value);
}

function setPath(base, path, next) {
  const out = structuredClone(base);
  const parts = path.split('.');
  let cursor = out;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cursor = cursor[parts[i]];
  }
  cursor[parts[parts.length - 1]] = next;
  return out;
}

function deletePath(base, path) {
  const out = structuredClone(base);
  const parts = path.split('.');
  let cursor = out;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cursor = cursor[parts[i]];
  }
  delete cursor[parts[parts.length - 1]];
  return out;
}

function withExtraKey(base, objectPath, key, value) {
  const out = structuredClone(base);
  const target =
    objectPath === ''
      ? out
      : objectPath.split('.').reduce((acc, part) => acc[part], out);
  target[key] = value;
  return out;
}

/**
 * Assert fixed public error contract; leakTokens must not appear in observable error text.
 */
function assertInvalidEvidenceError(fn, { leakTokens = [] } = {}) {
  let thrown;
  assert.throws(
    () => {
      fn();
    },
    (error) => {
      thrown = error;
      assert.equal(error.name, FIXED_NAME);
      assert.equal(error.code, FIXED_CODE);
      assert.equal(error.message, FIXED_CODE);
      assert.equal(error.code, REAL_NAS_ACCEPTANCE_EVIDENCE_INVALID);
      assert.equal(error.message, REAL_NAS_ACCEPTANCE_EVIDENCE_INVALID);
      return true;
    },
  );

  let serialized = '';
  try {
    serialized = JSON.stringify(thrown);
  } catch {
    serialized = '';
  }
  let named = '';
  try {
    named = JSON.stringify(thrown, Object.getOwnPropertyNames(thrown));
  } catch {
    named = '';
  }

  const observable = [
    thrown?.name,
    thrown?.code,
    thrown?.message,
    String(thrown),
    thrown?.stack ?? '',
    serialized,
    named,
  ].join('\0');

  for (const token of leakTokens) {
    if (token === '' || token == null) continue;
    assert.equal(
      observable.includes(String(token)),
      false,
      'error must not echo malicious sentinel',
    );
  }
}

describe('real-nas-acceptance-evidence public constants', () => {
  it('REAL_NAS_ACCEPTANCE_EVIDENCE_INVALID equals fixed public code', () => {
    assert.equal(REAL_NAS_ACCEPTANCE_EVIDENCE_INVALID, FIXED_CODE);
    assert.equal(REAL_NAS_ACCEPTANCE_EVIDENCE_INVALID, 'real-nas-acceptance-evidence-invalid');
  });
});

describe('validateRealNasAcceptanceEvidence positive contract', () => {
  it('returns true for the canonical fixture', () => {
    assert.equal(validateRealNasAcceptanceEvidence(validEvidence()), true);
  });

  it('does not mutate input; frozen fixture remains deep-equal to a canonical clone', () => {
    const input = deepFreeze(validEvidence());
    const before = structuredClone(validEvidence());
    assert.equal(validateRealNasAcceptanceEvidence(input), true);
    assert.deepEqual(structuredClone(input), before);
    assert.deepEqual(input, before);
  });

  it('accepts copy.totalBytes === 0 when other invariants remain valid', () => {
    const input = setPath(validEvidence(), 'copy.totalBytes', 0);
    assert.equal(validateRealNasAcceptanceEvidence(input), true);
  });
});

describe('shape and closed objects', () => {
  const missingKeyCases = [
    'schemaVersion',
    'kind',
    'acceptanceId',
    'runtimeVersion',
    'runtimeSourceCommit',
    'acceptedAt',
    'environment',
    'provider',
    'mountType',
    'copy',
    'recovery',
    'audit',
    'copy.state',
    'copy.fileCount',
    'copy.totalBytes',
    'copy.verifiedFileCount',
    'copy.manifestSha256',
    'copy.completedMarkerValid',
    'copy.lockResidualCount',
    'copy.stagingResidualCount',
    'recovery.scenario',
    'recovery.terminationSignal',
    'recovery.staleLockValidated',
    'recovery.stagedFileCount',
    'recovery.stagedVerifiedFileCount',
    'recovery.state',
    'recovery.finalPublished',
    'recovery.postFinalExists',
    'recovery.lockResidualCount',
    'recovery.stagingResidualCount',
    'recovery.residualFileCount',
    'recovery.firstPublishedSnapshotPreserved',
    'audit.status',
    'audit.dualWriteState',
    'audit.relationship',
    'audit.recoveryRequired',
  ];

  it('rejects every required-key omission at top and nested objects', () => {
    for (const path of missingKeyCases) {
      assertInvalidEvidenceError(
        () => validateRealNasAcceptanceEvidence(deletePath(validEvidence(), path)),
      );
    }
  });

  const extraKeyCases = [
    { objectPath: '', key: 'extraTop', value: true },
    { objectPath: 'copy', key: 'extraCopy', value: 1 },
    { objectPath: 'recovery', key: 'extraRecovery', value: 'x' },
    { objectPath: 'audit', key: 'extraAudit', value: false },
  ];

  it('rejects one extra key on top, copy, recovery, and audit', () => {
    for (const c of extraKeyCases) {
      assertInvalidEvidenceError(
        () =>
          validateRealNasAcceptanceEvidence(
            withExtraKey(validEvidence(), c.objectPath, c.key, c.value),
          ),
        { leakTokens: [c.key] },
      );
    }
  });

  const nonObjectCases = [
    () => null,
    () => [],
    () => 'not-object',
    () => 1,
    () => true,
    () => undefined,
    () => setPath(validEvidence(), 'copy', null),
    () => setPath(validEvidence(), 'copy', []),
    () => setPath(validEvidence(), 'copy', 'nope'),
    () => setPath(validEvidence(), 'recovery', null),
    () => setPath(validEvidence(), 'recovery', [1]),
    () => setPath(validEvidence(), 'recovery', 0),
    () => setPath(validEvidence(), 'audit', null),
    () => setPath(validEvidence(), 'audit', []),
    () => setPath(validEvidence(), 'audit', false),
  ];

  it('rejects array, null, and non-object at top and each nested object slot', () => {
    for (const build of nonObjectCases) {
      assertInvalidEvidenceError(() => validateRealNasAcceptanceEvidence(build()));
    }
  });

  it('rejects top-level and nested accessors; getters are never invoked', () => {
    const targets = [
      {
        label: 'top',
        attach: (base, descriptor) => {
          Object.defineProperty(base, 'schemaVersion', descriptor);
        },
      },
      {
        label: 'copy',
        attach: (base, descriptor) => {
          Object.defineProperty(base.copy, 'fileCount', descriptor);
        },
      },
      {
        label: 'recovery',
        attach: (base, descriptor) => {
          Object.defineProperty(base.recovery, 'stagedFileCount', descriptor);
        },
      },
      {
        label: 'audit',
        attach: (base, descriptor) => {
          Object.defineProperty(base.audit, 'status', descriptor);
        },
      },
    ];

    for (const target of targets) {
      const base = validEvidence();
      let calls = 0;
      const SENTINEL = `GETTER_SENTINEL_${target.label}_NEVER`;
      target.attach(base, {
        enumerable: true,
        configurable: true,
        get() {
          calls += 1;
          return SENTINEL;
        },
      });
      assertInvalidEvidenceError(
        () => validateRealNasAcceptanceEvidence(base),
        { leakTokens: [SENTINEL] },
      );
      assert.equal(calls, 0, `${target.label} getter must not be called`);
    }
  });
});

describe('fixed literals and formats', () => {
  const literalCases = [
    { path: 'schemaVersion', value: 0 },
    { path: 'schemaVersion', value: 2 },
    { path: 'schemaVersion', value: '1' },
    { path: 'schemaVersion', value: 1.5 },
    { path: 'kind', value: 'linke-real-nas' },
    { path: 'kind', value: 'LINKE-REAL-NAS-ACCEPTANCE' },
    { path: 'kind', value: '' },
    { path: 'kind', value: 1 },
    { path: 'acceptanceId', value: '' },
    { path: 'acceptanceId', value: 'NAS-REAL' },
    { path: 'acceptanceId', value: 'nas-real-v144-20260727-01' },
    { path: 'acceptanceId', value: 42 },
    { path: 'runtimeVersion', value: 'V1.43' },
    { path: 'runtimeVersion', value: 'v1.44' },
    { path: 'runtimeVersion', value: '1.44' },
    { path: 'runtimeVersion', value: '' },
    { path: 'environment', value: 'production' },
    { path: 'environment', value: 'non_production' },
    { path: 'environment', value: 'staging' },
    { path: 'provider', value: 'qnap' },
    { path: 'provider', value: 'Synology' },
    { path: 'provider', value: '' },
    { path: 'mountType', value: 'nfs' },
    { path: 'mountType', value: 'SMBFS' },
    { path: 'mountType', value: 'cifs' },
  ];

  it('rejects wrong fixed literals and bad acceptanceId formats', () => {
    // No leakTokens here: short literal values like '1' can appear in stack line numbers.
    // Sentinel non-echo is covered by stringInjectionCases / extra-key / getter tests.
    for (const c of literalCases) {
      assertInvalidEvidenceError(
        () => validateRealNasAcceptanceEvidence(setPath(validEvidence(), c.path, c.value)),
      );
    }
  });

  const commitCases = [HEX39, HEX41, HEX40_NON, HEX40_UPPER, '', 1];

  it('accepts only 40 lowercase hex for runtimeSourceCommit', () => {
    for (const value of commitCases) {
      const leak = typeof value === 'string' && value ? [value] : [];
      assertInvalidEvidenceError(
        () =>
          validateRealNasAcceptanceEvidence(
            setPath(validEvidence(), 'runtimeSourceCommit', value),
          ),
        { leakTokens: leak },
      );
    }
  });

  const acceptedAtCases = [
    'not-a-date',
    '2026-07-27T04:00:00Z',
    '2026-07-27T04:00:00.000+00:00',
    '2026-07-27 04:00:00.000Z',
    '2026-07-27T04:00:00.000z',
    '2026-07-27T04:00:00.00Z',
    '',
    0,
  ];

  it('accepts only canonical UTC millisecond ISO for acceptedAt', () => {
    for (const value of acceptedAtCases) {
      const leak = typeof value === 'string' && value ? [value] : [];
      assertInvalidEvidenceError(
        () => validateRealNasAcceptanceEvidence(setPath(validEvidence(), 'acceptedAt', value)),
        { leakTokens: leak },
      );
    }
  });

  const manifestCases = [HEX63, HEX65, HEX64_NON, HEX64_UPPER, '', 0];

  it('accepts only 64 lowercase hex for copy.manifestSha256', () => {
    for (const value of manifestCases) {
      const leak = typeof value === 'string' && value ? [value] : [];
      assertInvalidEvidenceError(
        () =>
          validateRealNasAcceptanceEvidence(
            setPath(validEvidence(), 'copy.manifestSha256', value),
          ),
        { leakTokens: leak },
      );
    }
  });

  it('rejects 64-hex on any existing string field except copy.manifestSha256', () => {
    const paths = [
      'kind',
      'acceptanceId',
      'runtimeVersion',
      'acceptedAt',
      'environment',
      'provider',
      'mountType',
      'copy.state',
      'recovery.scenario',
      'recovery.terminationSignal',
      'recovery.state',
      'audit.status',
      'audit.dualWriteState',
      'audit.relationship',
    ];
    for (const path of paths) {
      assertInvalidEvidenceError(
        () => validateRealNasAcceptanceEvidence(setPath(validEvidence(), path, HEX64)),
        { leakTokens: [HEX64] },
      );
    }
  });

  it('rejects 40-hex on any existing string field except runtimeSourceCommit', () => {
    const paths = [
      'kind',
      'acceptanceId',
      'runtimeVersion',
      'acceptedAt',
      'environment',
      'provider',
      'mountType',
      'copy.state',
      'copy.manifestSha256',
      'recovery.scenario',
      'recovery.terminationSignal',
      'recovery.state',
      'audit.status',
      'audit.dualWriteState',
      'audit.relationship',
    ];
    for (const path of paths) {
      assertInvalidEvidenceError(
        () => validateRealNasAcceptanceEvidence(setPath(validEvidence(), path, HEX40)),
        { leakTokens: [HEX40] },
      );
    }
  });
});

describe('integer and relational invariants', () => {
  const countPaths = [
    'copy.fileCount',
    'copy.totalBytes',
    'copy.verifiedFileCount',
    'copy.lockResidualCount',
    'copy.stagingResidualCount',
    'recovery.stagedFileCount',
    'recovery.stagedVerifiedFileCount',
    'recovery.lockResidualCount',
    'recovery.stagingResidualCount',
    'recovery.residualFileCount',
  ];

  it('rejects negatives, decimals, and unsafe integers on all count fields', () => {
    for (const path of countPaths) {
      for (const value of [-1, -0.1, 1.5, UNSAFE_INT, Number.NaN, Number.POSITIVE_INFINITY]) {
        assertInvalidEvidenceError(
          () => validateRealNasAcceptanceEvidence(setPath(validEvidence(), path, value)),
        );
      }
    }
  });

  it('requires copy.fileCount > 0 and verifiedFileCount === fileCount', () => {
    assertInvalidEvidenceError(
      () => validateRealNasAcceptanceEvidence(setPath(validEvidence(), 'copy.fileCount', 0)),
    );
    assertInvalidEvidenceError(() =>
      validateRealNasAcceptanceEvidence(
        setPath(setPath(validEvidence(), 'copy.fileCount', 0), 'copy.verifiedFileCount', 0),
      ),
    );
    assertInvalidEvidenceError(
      () =>
        validateRealNasAcceptanceEvidence(setPath(validEvidence(), 'copy.verifiedFileCount', 1)),
    );
    assertInvalidEvidenceError(
      () =>
        validateRealNasAcceptanceEvidence(setPath(validEvidence(), 'copy.verifiedFileCount', 3)),
    );
  });

  it('requires recovery.stagedFileCount > 0 and stagedVerifiedFileCount === stagedFileCount', () => {
    assertInvalidEvidenceError(
      () =>
        validateRealNasAcceptanceEvidence(setPath(validEvidence(), 'recovery.stagedFileCount', 0)),
    );
    assertInvalidEvidenceError(() =>
      validateRealNasAcceptanceEvidence(
        setPath(
          setPath(validEvidence(), 'recovery.stagedFileCount', 0),
          'recovery.stagedVerifiedFileCount',
          0,
        ),
      ),
    );
    assertInvalidEvidenceError(
      () =>
        validateRealNasAcceptanceEvidence(
          setPath(validEvidence(), 'recovery.stagedVerifiedFileCount', 1),
        ),
    );
    assertInvalidEvidenceError(
      () =>
        validateRealNasAcceptanceEvidence(
          setPath(validEvidence(), 'recovery.stagedVerifiedFileCount', 9),
        ),
    );
  });

  it('rejects invalid totalBytes while keeping 0 as a separate valid case', () => {
    for (const value of [-1, 0.5, UNSAFE_INT, '0', null]) {
      assertInvalidEvidenceError(
        () => validateRealNasAcceptanceEvidence(setPath(validEvidence(), 'copy.totalBytes', value)),
      );
    }
  });
});

describe('copy / recovery / audit gates', () => {
  const gateCases = [
    { path: 'copy.state', value: 'pending' },
    { path: 'copy.state', value: 'failed' },
    { path: 'copy.state', value: 'REPLICATED' },
    { path: 'copy.completedMarkerValid', value: false },
    { path: 'copy.completedMarkerValid', value: 1 },
    { path: 'copy.completedMarkerValid', value: 'true' },
    { path: 'copy.lockResidualCount', value: 1 },
    { path: 'copy.stagingResidualCount', value: 1 },
    { path: 'recovery.scenario', value: 'mid-copy-crash' },
    { path: 'recovery.scenario', value: 'staging-ready' },
    { path: 'recovery.terminationSignal', value: 'SIGTERM' },
    { path: 'recovery.terminationSignal', value: 'sigkill' },
    { path: 'recovery.staleLockValidated', value: false },
    { path: 'recovery.staleLockValidated', value: 1 },
    { path: 'recovery.state', value: 'pending' },
    { path: 'recovery.state', value: 'RECOVERED' },
    { path: 'recovery.finalPublished', value: true },
    { path: 'recovery.finalPublished', value: 0 },
    { path: 'recovery.postFinalExists', value: true },
    { path: 'recovery.postFinalExists', value: 1 },
    { path: 'recovery.lockResidualCount', value: 1 },
    { path: 'recovery.stagingResidualCount', value: 2 },
    { path: 'recovery.residualFileCount', value: 3 },
    { path: 'recovery.firstPublishedSnapshotPreserved', value: false },
    { path: 'recovery.firstPublishedSnapshotPreserved', value: 'true' },
    { path: 'audit.status', value: 'degraded' },
    { path: 'audit.status', value: 'HEALTHY' },
    { path: 'audit.dualWriteState', value: 'writing' },
    { path: 'audit.dualWriteState', value: 'IDLE' },
    { path: 'audit.relationship', value: 'ahead' },
    { path: 'audit.relationship', value: 'EQUAL' },
    { path: 'audit.recoveryRequired', value: true },
    { path: 'audit.recoveryRequired', value: 0 },
  ];

  it('enforces copy, recovery, and audit gate literals and zero residuals', () => {
    for (const c of gateCases) {
      const leak =
        typeof c.value === 'string' && c.value.length > 0 ? [c.value] : [];
      assertInvalidEvidenceError(
        () => validateRealNasAcceptanceEvidence(setPath(validEvidence(), c.path, c.value)),
        { leakTokens: leak },
      );
    }
  });
});

describe('secret / path / process-output minimization', () => {
  const forbiddenExtraKeys = [
    'credential',
    'credentials',
    'password',
    'token',
    'apiKey',
    'ownerToken',
    'pid',
    'attemptId',
    'stdout',
    'stderr',
    'absolutePath',
    'url',
    'ipAddress',
  ];

  it('rejects forbidden secret/path/process keys as extras on top and nested objects', () => {
    const objectPaths = ['', 'copy', 'recovery', 'audit'];
    for (const objectPath of objectPaths) {
      for (const key of forbiddenExtraKeys) {
        const SENTINEL = `MAL_KEY_${key}_VALUE_9f3c`;
        assertInvalidEvidenceError(
          () =>
            validateRealNasAcceptanceEvidence(
              withExtraKey(validEvidence(), objectPath, key, SENTINEL),
            ),
          { leakTokens: [SENTINEL, key] },
        );
      }
    }
  });

  const stringInjectionCases = [
    {
      path: 'acceptanceId',
      value: '/Users/secret/nas-acceptance',
      leak: ['/Users/secret/nas-acceptance'],
    },
    {
      path: 'acceptanceId',
      value: 'file:///Volumes/Share/secret',
      leak: ['file:///Volumes/Share/secret'],
    },
    {
      path: 'kind',
      value: 'https://evil.example/token=abc',
      leak: ['https://evil.example/token=abc'],
    },
    {
      path: 'provider',
      value: '203.0.113.10',
      leak: ['203.0.113.10'],
    },
    {
      path: 'environment',
      value: '2001:db8::1',
      leak: ['2001:db8::1'],
    },
    {
      path: 'mountType',
      value: '\\\\nas.local\\share',
      leak: ['\\\\nas.local\\share'],
    },
    {
      path: 'mountType',
      value: 'smb://user:pass@nas.local/share',
      leak: ['smb://user:pass@nas.local/share', 'user:pass'],
    },
    {
      path: 'copy.state',
      value: 'token=sk-live-SENTINEL-7a1',
      leak: ['token=sk-live-SENTINEL-7a1', 'sk-live-SENTINEL-7a1'],
    },
    {
      path: 'recovery.scenario',
      value: 'password=hunter2-SENTINEL',
      leak: ['password=hunter2-SENTINEL', 'hunter2-SENTINEL'],
    },
    {
      path: 'audit.status',
      value: 'credential=AKIA_SENTINEL_X',
      leak: ['credential=AKIA_SENTINEL_X', 'AKIA_SENTINEL_X'],
    },
    {
      path: 'runtimeVersion',
      value: 'V1.44;/private/tmp/secret',
      leak: ['/private/tmp/secret'],
    },
  ];

  it('rejects path/url/ip/credential-style values in existing string fields without echoing sentinels', () => {
    for (const c of stringInjectionCases) {
      assertInvalidEvidenceError(
        () => validateRealNasAcceptanceEvidence(setPath(validEvidence(), c.path, c.value)),
        { leakTokens: c.leak },
      );
    }
  });
});
