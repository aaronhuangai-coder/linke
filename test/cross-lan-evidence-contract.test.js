/**
 * Honesty scope (Gold ADR §7.2.1 / §7.2.2): T1.15 M1 pure contract only.
 * Covers schema / retention / budget constants, shape validator,
 * M5 real gate pure decision, artifact degraded classifier,
 * degraded impact resolver, report byte budget formula.
 * T1.0 Noise library gate = BLOCKED (not M1 crypto PASS).
 * T1.15 M1 contract coverage = COMPLETE (contract task only).
 * Real M5/M6/M7 harness, Gold evidence I/O, filename matcher,
 * retention date arithmetic, secret scanning = NOT IMPLEMENTED.
 * Pure contract only — does NOT prove real evidence / Gold readiness.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ERROR_CODES } from '../src/error-codes.js';
import * as evidence from '../src/cross-lan-evidence-contract.js';

const SCHEMA_ID = 'cross-lan-evidence/v1';
const FRAMING = 'wss-tls1.3-tcp443';

const TOP_FIELDS = Object.freeze([
  'schemaVersion',
  'sourceCommit',
  'commandId',
  'startedAtUtc',
  'finishedAtUtc',
  'topology',
  'relayForced',
  'relayType',
  'relayDeployment',
  'reachabilityResult',
  'framing',
  'proxyResult',
  'firewallResult',
  'env',
  'cells',
  'faultInjection',
  'overall',
]);

const EXPECTED_PROXY_CODES = Object.freeze([
  ERROR_CODES.PROXY_AUTH_FAILED,
  ERROR_CODES.PROXY_CONNECT_FAILED,
  ERROR_CODES.PROXY_UNSUPPORTED_AUTH,
  ERROR_CODES.PROXY_PAC_UNSUPPORTED,
  ERROR_CODES.PROXY_CHAIN_UNSUPPORTED,
  ERROR_CODES.RELAY_TLS_PIN_MISMATCH,
  ERROR_CODES.PROXY_TLS_INTERCEPTED,
]);

const EXPECTED_ARTIFACT_CODES = Object.freeze([
  ERROR_CODES.EVIDENCE_ARTIFACT_MISSING,
  ERROR_CODES.EVIDENCE_ARTIFACT_DIGEST_MISMATCH,
]);

const COMMIT_SHORT = 'deadbeef';
const COMMIT_64 =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

/**
 * @param {Record<string, unknown>} [overrides]
 */
function minEvidence(overrides = {}) {
  const commit =
    typeof overrides.sourceCommit === 'string'
      ? overrides.sourceCommit
      : COMMIT_SHORT;
  const base = {
    schemaVersion: SCHEMA_ID,
    sourceCommit: commit,
    commandId: 'run-1',
    startedAtUtc: 'not-an-iso-timestamp',
    finishedAtUtc: 'also-not-iso',
    topology: {
      sideA: { natType: 'unknown', role: 'endpoint' },
      sideB: { natType: 'full-cone', role: 'controller' },
      independentNatDomains: true,
    },
    relayForced: true,
    relayType: 'operator-managed-test',
    relayDeployment: {
      kind: 'operator-managed-test',
      publicListener: true,
    },
    reachabilityResult: { status: 'pass' },
    framing: FRAMING,
    proxyResult: { status: 'pass' },
    firewallResult: { status: 'not-applicable' },
    env: {
      osA: 'macOS-15.x',
      osB: 'linux-6.x',
      nodeVersion: 'v22.0.0',
      appCommit: commit,
    },
    cells: [
      { id: 'A1', status: 'PASS', errorCode: null },
      { id: 'A2', status: 'PASS', errorCode: null },
    ],
    faultInjection: {},
    overall: 'any-nonempty-string-ok',
  };
  return { ...base, ...overrides };
}

/**
 * @param {unknown} evidenceDoc
 * @param {string} [expectedSourceCommit]
 */
function shapeInput(evidenceDoc, expectedSourceCommit = COMMIT_SHORT) {
  return { evidence: evidenceDoc, expectedSourceCommit };
}

/**
 * @param {unknown} evidenceDoc
 * @param {string[]} [requiredCellIds]
 * @param {string} [expectedSourceCommit]
 */
function gateInput(
  evidenceDoc,
  requiredCellIds = ['A1', 'A2'],
  expectedSourceCommit = COMMIT_SHORT,
) {
  return {
    evidence: evidenceDoc,
    expectedSourceCommit,
    requiredCellIds,
  };
}

describe('cross-lan evidence contract (T1.15 M1 pure contract)', () => {
  it('1) CROSS_LAN_EVIDENCE_SCHEMA: exact 26 keys, deep freeze, 17 top fields, derived real types, error sets', () => {
    const s = evidence.CROSS_LAN_EVIDENCE_SCHEMA;
    assert.strictEqual(typeof s, 'object');
    assert.ok(s !== null);
    assert.strictEqual(Object.keys(s).length, 26);
    assert.ok(Object.isFrozen(s));

    assert.strictEqual(s.identifier, SCHEMA_ID);
    assert.deepStrictEqual([...s.requiredTopLevelFields], [...TOP_FIELDS]);
    assert.strictEqual(s.requiredTopLevelFields.length, 17);
    assert.ok(Object.isFrozen(s.requiredTopLevelFields));

    assert.deepStrictEqual([...s.natTypes], [
      'full-cone',
      'address-restricted',
      'port-restricted',
      'symmetric',
      'unknown',
      'unknown-documented',
    ]);
    assert.ok(Object.isFrozen(s.natTypes));
    assert.deepStrictEqual([...s.roles], ['endpoint', 'controller']);
    assert.ok(Object.isFrozen(s.roles));
    assert.deepStrictEqual([...s.relayTypes], [
      'mock',
      'operator-managed-test',
      'user-managed',
    ]);
    assert.ok(Object.isFrozen(s.relayTypes));

    assert.deepStrictEqual(
      [...s.m5RealRelayTypes],
      s.relayTypes.filter((t) => t !== 'mock'),
    );
    assert.deepStrictEqual([...s.m5RealRelayTypes], [
      'operator-managed-test',
      'user-managed',
    ]);
    assert.ok(Object.isFrozen(s.m5RealRelayTypes));

    assert.deepStrictEqual([...s.relayDeploymentKinds], [
      'operator-managed-test',
      'user-managed',
    ]);
    assert.ok(Object.isFrozen(s.relayDeploymentKinds));
    assert.deepStrictEqual([...s.reachabilityStatuses], ['pass', 'fail']);
    assert.ok(Object.isFrozen(s.reachabilityStatuses));
    assert.deepStrictEqual([...s.diagnosticStatuses], [
      'pass',
      'fail',
      'not-applicable',
    ]);
    assert.ok(Object.isFrozen(s.diagnosticStatuses));
    assert.deepStrictEqual([...s.cellStatuses], [
      'PASS',
      'FAIL',
      'BLOCKED',
      'SKIP',
      'EVIDENCE-DEGRADED',
    ]);
    assert.ok(Object.isFrozen(s.cellStatuses));

    assert.deepStrictEqual([...s.proxyErrorCodes], [...EXPECTED_PROXY_CODES]);
    assert.strictEqual(s.proxyErrorCodes.length, 7);
    assert.ok(Object.isFrozen(s.proxyErrorCodes));
    assert.deepStrictEqual([...s.artifactErrorCodes], [
      ...EXPECTED_ARTIFACT_CODES,
    ]);
    assert.strictEqual(s.artifactErrorCodes.length, 2);
    assert.ok(Object.isFrozen(s.artifactErrorCodes));

    const proxySet = new Set(s.proxyErrorCodes);
    for (const code of s.artifactErrorCodes) {
      assert.strictEqual(
        proxySet.has(code),
        false,
        'proxy and artifact error sets must be disjoint',
      );
    }

    assert.strictEqual(s.productionFraming, FRAMING);
    assert.deepStrictEqual([...s.topologyRequiredFields], [
      'sideA',
      'sideB',
      'independentNatDomains',
    ]);
    assert.ok(Object.isFrozen(s.topologyRequiredFields));
    assert.deepStrictEqual([...s.topologySideRequiredFields], [
      'natType',
      'role',
    ]);
    assert.ok(Object.isFrozen(s.topologySideRequiredFields));
    assert.deepStrictEqual([...s.relayDeploymentRequiredFields], [
      'kind',
      'publicListener',
    ]);
    assert.ok(Object.isFrozen(s.relayDeploymentRequiredFields));
    assert.deepStrictEqual([...s.reachabilityRequiredFields], ['status']);
    assert.ok(Object.isFrozen(s.reachabilityRequiredFields));
    assert.deepStrictEqual([...s.diagnosticResultRequiredFields], ['status']);
    assert.ok(Object.isFrozen(s.diagnosticResultRequiredFields));
    assert.deepStrictEqual([...s.envRequiredFields], [
      'osA',
      'osB',
      'nodeVersion',
      'appCommit',
    ]);
    assert.ok(Object.isFrozen(s.envRequiredFields));
    assert.deepStrictEqual([...s.cellRequiredFields], [
      'id',
      'status',
      'errorCode',
    ]);
    assert.ok(Object.isFrozen(s.cellRequiredFields));

    assert.strictEqual(
      s.faultInjectionSchemaStatus,
      'open-enum-shape-not-wire-frozen',
    );
    assert.strictEqual(s.overallEnumStatus, 'not-enumerated-by-spec');
    assert.strictEqual(
      s.nestedFieldsPolicy,
      'required-minimum-extra-string-data-fields-allowed',
    );
    assert.strictEqual(
      s.sourceCommitFormatPolicy,
      'nonempty-string-equality-only-no-hash-algorithm-frozen',
    );
    assert.strictEqual(
      s.timestampFormatPolicy,
      'nonempty-string-no-regex-in-m1',
    );
    assert.strictEqual(s.implementationStage, 'T1.15-M1-contract-only');
  });

  it('2) retention exact 18 / budget exact 9 deep freeze and values', () => {
    const r = evidence.CROSS_LAN_EVIDENCE_RETENTION_POLICY;
    assert.strictEqual(Object.keys(r).length, 18);
    assert.ok(Object.isFrozen(r));
    assert.strictEqual(r.noOverwrite, true);
    assert.strictEqual(r.newArtifactPerRun, true);
    assert.strictEqual(
      r.filenameTemplate,
      'YYYY-MM-DD-<sourceCommitPrefix>-<evidence-kind>.<ext>',
    );
    assert.strictEqual(r.repoReportAndDigestNeverOverwrite, true);
    assert.strictEqual(r.repoHistoryImmutable, true);
    assert.strictEqual(r.forcePushCleanupAllowed, false);
    assert.strictEqual(r.worktreeMinimumRetentionMonths, 36);
    assert.strictEqual(r.nextMajorGoldAdditionalRetentionMonths, 12);
    assert.strictEqual(
      r.retentionDeadlineRule,
      'max-of-36months-or-next-major-gold-plus-12-take-later',
    );
    assert.strictEqual(r.externalMinimumRetentionMonths, 36);
    assert.strictEqual(r.externalArtifactDigestRequired, true);
    assert.strictEqual(r.externalArtifactHandlePolicy, 'non-secret');
    assert.strictEqual(r.m7PriorEvidencePolicy, 'append-only-no-delete');
    assert.strictEqual(r.purgeApprovalRequired, true);
    assert.strictEqual(
      r.purgeAuditEvent,
      'evidence-retention-purge-approved',
    );
    assert.strictEqual(r.dateArithmeticImplemented, false);
    assert.strictEqual(r.filenameMatcherImplemented, false);
    assert.strictEqual(
      r.implementationStage,
      'T1.15-M1-policy-frozen-no-arithmetic',
    );

    const b = evidence.CROSS_LAN_EVIDENCE_REPORT_BUDGET_POLICY;
    assert.strictEqual(Object.keys(b).length, 9);
    assert.ok(Object.isFrozen(b));
    assert.strictEqual(b.baseBytes, 32768);
    assert.strictEqual(b.perCellBytes, 4096);
    assert.strictEqual(b.perSchemaObjectBytes, 8192);
    assert.strictEqual(b.hardCeilingBytes, 524288);
    assert.strictEqual(b.minimumSchemaObjectCount, 8);
    assert.deepStrictEqual([...b.minimumSchemaObjectFields], [
      'topology',
      'proxyResult',
      'firewallResult',
      'relayDeployment',
      'reachabilityResult',
      'env',
      'faultInjection',
      'overall',
    ]);
    assert.ok(Object.isFrozen(b.minimumSchemaObjectFields));
    assert.strictEqual(b.scope, 'repo-redacted-summary-only');
    assert.strictEqual(b.fieldDeletionToShrinkForbidden, true);
    assert.strictEqual(
      b.implementationStage,
      'T1.15-M1-budget-formula-only',
    );
  });

  it('3) minimum valid shape + extras + short/64hex commit + arbitrary timestamp/overall/fault; null-proto/frozen', () => {
    const match = evidence.matchesCrossLanEvidenceShape;
    assert.strictEqual(typeof match, 'function');

    assert.strictEqual(match(shapeInput(minEvidence())), true);

    const withExtras = minEvidence({
      extraTop: 'allowed',
      topology: {
        sideA: { natType: 'symmetric', role: 'endpoint', note: 'side-extra' },
        sideB: { natType: 'port-restricted', role: 'controller' },
        independentNatDomains: false,
        regionBucket: 'east',
      },
      relayDeployment: {
        kind: 'user-managed',
        publicListener: false,
        notesBucket: 'notes-ok',
      },
      reachabilityResult: {
        status: 'fail',
        tcp443: false,
        wss: true,
        dnsBucket: 'dns',
        tlsBucket: 'tls',
        pinBucket: 'pin',
        errorCode: null,
      },
      relayType: 'mock',
      relayForced: false,
      proxyResult: {
        status: 'fail',
        errorCode: ERROR_CODES.PROXY_AUTH_FAILED,
        detailBucket: 'x',
      },
      firewallResult: { status: 'fail', errorCode: 'any-string-ok' },
      cells: [
        {
          id: 'A1',
          status: 'PASS',
          errorCode: null,
          noteBucket: 'cell-extra',
        },
        {
          id: 'A9',
          status: 'EVIDENCE-DEGRADED',
          errorCode: ERROR_CODES.EVIDENCE_ARTIFACT_MISSING,
        },
        {
          id: 'A10',
          status: 'FAIL',
          errorCode: ERROR_CODES.RELAY_CONNECT_FAILED,
        },
        { id: 'A11', status: 'BLOCKED', errorCode: null },
        { id: 'A12', status: 'SKIP', errorCode: 'skipped' },
      ],
      faultInjection: {
        disconnectCount: 2,
        proxyEnabled: true,
        arbitraryOpen: { nested: 'not-recursed' },
      },
      overall: 'not-an-enum-value',
      env: {
        osA: 'a',
        osB: 'b',
        nodeVersion: 'n',
        appCommit: COMMIT_SHORT,
        envExtra: 'ok',
      },
    });
    assert.strictEqual(match(shapeInput(withExtras)), true);

    const hex64 = minEvidence({
      sourceCommit: COMMIT_64,
      env: {
        osA: 'a',
        osB: 'b',
        nodeVersion: 'n',
        appCommit: COMMIT_64,
      },
    });
    assert.strictEqual(match(shapeInput(hex64, COMMIT_64)), true);

    const nullProto = Object.assign(Object.create(null), minEvidence());
    assert.strictEqual(match(shapeInput(nullProto)), true);

    const frozen = Object.freeze(minEvidence());
    assert.strictEqual(match(shapeInput(frozen)), true);

    // empty cells allowed by shape (M5 gate is separate)
    assert.strictEqual(
      match(shapeInput(minEvidence({ cells: [] }))),
      true,
    );
  });

  it('4) shape invalid: missing top fields, commit mismatch, enum/type, cell semantics, sparse/symbol/nonenum/accessor/proxy/revoked', () => {
    const match = evidence.matchesCrossLanEvidenceShape;
    assert.doesNotThrow(() => match(null));
    assert.strictEqual(match(null), false);
    assert.strictEqual(match(undefined), false);
    assert.strictEqual(match({}), false);
    assert.strictEqual(match(shapeInput(null)), false);
    assert.strictEqual(match(shapeInput(minEvidence(), '')), false);
    assert.strictEqual(match(shapeInput(minEvidence(), 1)), false);

    for (const field of TOP_FIELDS) {
      const doc = minEvidence();
      delete doc[field];
      assert.strictEqual(
        match(shapeInput(doc)),
        false,
        `missing top field must fail: ${field}`,
      );
    }

    assert.strictEqual(
      match(shapeInput(minEvidence(), 'other-commit')),
      false,
    );
    assert.strictEqual(
      match(
        shapeInput(
          minEvidence({
            env: {
              osA: 'a',
              osB: 'b',
              nodeVersion: 'n',
              appCommit: 'different',
            },
          }),
        ),
      ),
      false,
    );
    assert.strictEqual(
      match(shapeInput(minEvidence({ schemaVersion: 'other/v1' }))),
      false,
    );
    assert.strictEqual(
      match(shapeInput(minEvidence({ framing: 'ws-insecure' }))),
      false,
    );
    assert.strictEqual(
      match(shapeInput(minEvidence({ relayType: 'saas-public' }))),
      false,
    );
    assert.strictEqual(
      match(shapeInput(minEvidence({ relayForced: 'true' }))),
      false,
    );
    assert.strictEqual(
      match(shapeInput(minEvidence({ commandId: '' }))),
      false,
    );
    assert.strictEqual(
      match(shapeInput(minEvidence({ startedAtUtc: '' }))),
      false,
    );
    assert.strictEqual(
      match(shapeInput(minEvidence({ finishedAtUtc: 1 }))),
      false,
    );
    assert.strictEqual(
      match(shapeInput(minEvidence({ overall: '' }))),
      false,
    );

    assert.strictEqual(
      match(
        shapeInput(
          minEvidence({
            topology: {
              sideA: { natType: 'cone', role: 'endpoint' },
              sideB: { natType: 'full-cone', role: 'controller' },
              independentNatDomains: true,
            },
          }),
        ),
      ),
      false,
    );
    assert.strictEqual(
      match(
        shapeInput(
          minEvidence({
            topology: {
              sideA: { natType: 'full-cone', role: 'client' },
              sideB: { natType: 'full-cone', role: 'controller' },
              independentNatDomains: true,
            },
          }),
        ),
      ),
      false,
    );
    assert.strictEqual(
      match(
        shapeInput(
          minEvidence({
            topology: {
              sideA: { natType: 'full-cone', role: 'endpoint' },
              sideB: { natType: 'full-cone', role: 'controller' },
              independentNatDomains: 'yes',
            },
          }),
        ),
      ),
      false,
    );

    assert.strictEqual(
      match(
        shapeInput(
          minEvidence({
            relayDeployment: {
              kind: 'mock',
              publicListener: true,
            },
          }),
        ),
      ),
      false,
    );
    assert.strictEqual(
      match(
        shapeInput(
          minEvidence({
            relayDeployment: {
              kind: 'operator-managed-test',
              publicListener: true,
              notesBucket: '',
            },
          }),
        ),
      ),
      false,
    );

    assert.strictEqual(
      match(
        shapeInput(
          minEvidence({
            reachabilityResult: { status: 'ok' },
          }),
        ),
      ),
      false,
    );
    assert.strictEqual(
      match(
        shapeInput(
          minEvidence({
            reachabilityResult: {
              status: 'pass',
              tcp443: 'yes',
            },
          }),
        ),
      ),
      false,
    );
    assert.strictEqual(
      match(
        shapeInput(
          minEvidence({
            reachabilityResult: {
              status: 'pass',
              dnsBucket: '',
            },
          }),
        ),
      ),
      false,
    );

    assert.strictEqual(
      match(
        shapeInput(
          minEvidence({
            proxyResult: {
              status: 'fail',
              errorCode: 'not-in-proxy-allowlist',
            },
          }),
        ),
      ),
      false,
    );
    assert.strictEqual(
      match(
        shapeInput(
          minEvidence({
            proxyResult: { status: 'maybe' },
          }),
        ),
      ),
      false,
    );

    // cell semantics
    assert.strictEqual(
      match(
        shapeInput(
          minEvidence({
            cells: [{ id: 'A1', status: 'PASS', errorCode: 'x' }],
          }),
        ),
      ),
      false,
    );
    assert.strictEqual(
      match(
        shapeInput(
          minEvidence({
            cells: [
              {
                id: 'A1',
                status: 'EVIDENCE-DEGRADED',
                errorCode: ERROR_CODES.PROXY_AUTH_FAILED,
              },
            ],
          }),
        ),
      ),
      false,
    );
    assert.strictEqual(
      match(
        shapeInput(
          minEvidence({
            cells: [
              { id: 'A1', status: 'PASS', errorCode: null },
              { id: 'A1', status: 'FAIL', errorCode: null },
            ],
          }),
        ),
      ),
      false,
    );
    assert.strictEqual(
      match(
        shapeInput(
          minEvidence({
            cells: [{ id: '', status: 'PASS', errorCode: null }],
          }),
        ),
      ),
      false,
    );
    assert.strictEqual(
      match(
        shapeInput(
          minEvidence({
            cells: [{ id: 'A1', status: 'pass', errorCode: null }],
          }),
        ),
      ),
      false,
    );

    // sparse cells
    const sparse = [];
    sparse[1] = { id: 'A1', status: 'PASS', errorCode: null };
    assert.strictEqual(
      match(shapeInput(minEvidence({ cells: sparse }))),
      false,
    );

    // symbol / non-enumerable / accessor on top-level
    const withSymbol = minEvidence();
    Object.defineProperty(withSymbol, Symbol('x'), {
      value: 1,
      enumerable: true,
    });
    assert.strictEqual(match(shapeInput(withSymbol)), false);

    const withNonEnum = minEvidence();
    Object.defineProperty(withNonEnum, 'hidden', {
      value: 1,
      enumerable: false,
    });
    assert.strictEqual(match(shapeInput(withNonEnum)), false);

    const withAccessor = minEvidence();
    Object.defineProperty(withAccessor, 'extraAcc', {
      get() {
        return 'x';
      },
      enumerable: true,
    });
    assert.strictEqual(match(shapeInput(withAccessor)), false);

    // nested symbol / accessor on cell
    const cellSym = { id: 'A1', status: 'PASS', errorCode: null };
    Object.defineProperty(cellSym, Symbol('s'), {
      value: 1,
      enumerable: true,
    });
    assert.strictEqual(
      match(shapeInput(minEvidence({ cells: [cellSym] }))),
      false,
    );

    const cellAcc = { id: 'A1', status: 'PASS', errorCode: null };
    Object.defineProperty(cellAcc, 'note', {
      get() {
        return 'n';
      },
      enumerable: true,
    });
    assert.strictEqual(
      match(shapeInput(minEvidence({ cells: [cellAcc] }))),
      false,
    );

    // Proxy throw / revoked
    const proxyThrow = new Proxy(minEvidence(), {
      get() {
        throw new Error('trap');
      },
      ownKeys() {
        throw new Error('trap');
      },
    });
    assert.strictEqual(match(shapeInput(proxyThrow)), false);

    const target = minEvidence();
    const { proxy, revoke } = Proxy.revocable(target, {});
    revoke();
    assert.strictEqual(match(shapeInput(proxy)), false);

    // faultInjection must be plain record (not array)
    assert.strictEqual(
      match(shapeInput(minEvidence({ faultInjection: [] }))),
      false,
    );

    // symbol on faultInjection
    const fi = {};
    Object.defineProperty(fi, Symbol('k'), { value: 1, enumerable: true });
    assert.strictEqual(
      match(shapeInput(minEvidence({ faultInjection: fi }))),
      false,
    );
  });

  it('5) M5 real gate: full true; mock/mismatch/flags/roles/reach/framing/empty/missing/fail false; proxy-firewall fail ok; A2-ext degraded ok; overall ignored', () => {
    const gate = evidence.doesCrossLanEvidenceSatisfyM5RealGate;
    assert.strictEqual(typeof gate, 'function');

    const good = minEvidence();
    assert.strictEqual(gate(gateInput(good)), true);

    // mock relayType false
    assert.strictEqual(
      gate(gateInput(minEvidence({ relayType: 'mock' }))),
      false,
    );

    // relayType !== deployment.kind
    assert.strictEqual(
      gate(
        gateInput(
          minEvidence({
            relayType: 'operator-managed-test',
            relayDeployment: {
              kind: 'user-managed',
              publicListener: true,
            },
          }),
        ),
      ),
      false,
    );

    // publicListener false
    assert.strictEqual(
      gate(
        gateInput(
          minEvidence({
            relayDeployment: {
              kind: 'operator-managed-test',
              publicListener: false,
            },
          }),
        ),
      ),
      false,
    );

    // flags
    assert.strictEqual(
      gate(gateInput(minEvidence({ relayForced: false }))),
      false,
    );
    assert.strictEqual(
      gate(
        gateInput(
          minEvidence({
            topology: {
              sideA: { natType: 'unknown', role: 'endpoint' },
              sideB: { natType: 'full-cone', role: 'controller' },
              independentNatDomains: false,
            },
          }),
        ),
      ),
      false,
    );

    // roles not endpoint+controller each once
    assert.strictEqual(
      gate(
        gateInput(
          minEvidence({
            topology: {
              sideA: { natType: 'unknown', role: 'endpoint' },
              sideB: { natType: 'full-cone', role: 'endpoint' },
              independentNatDomains: true,
            },
          }),
        ),
      ),
      false,
    );
    assert.strictEqual(
      gate(
        gateInput(
          minEvidence({
            topology: {
              sideA: { natType: 'unknown', role: 'controller' },
              sideB: { natType: 'full-cone', role: 'controller' },
              independentNatDomains: true,
            },
          }),
        ),
      ),
      false,
    );

    // reachability fail
    assert.strictEqual(
      gate(
        gateInput(
          minEvidence({
            reachabilityResult: { status: 'fail' },
          }),
        ),
      ),
      false,
    );

    // framing wrong already fails shape; shape-first
    assert.strictEqual(
      gate(gateInput(minEvidence({ framing: 'loopback' }))),
      false,
    );

    // empty cells
    assert.strictEqual(
      gate(gateInput(minEvidence({ cells: [] }), ['A1'])),
      false,
    );

    // missing required cell id
    assert.strictEqual(
      gate(
        gateInput(
          minEvidence({
            cells: [{ id: 'A1', status: 'PASS', errorCode: null }],
          }),
          ['A1', 'A2'],
        ),
      ),
      false,
    );

    // required FAIL / BLOCKED / SKIP / DEGRADED
    for (const status of ['FAIL', 'BLOCKED', 'SKIP']) {
      assert.strictEqual(
        gate(
          gateInput(
            minEvidence({
              cells: [
                { id: 'A1', status: 'PASS', errorCode: null },
                {
                  id: 'A2',
                  status,
                  errorCode: status === 'FAIL' ? 'x' : null,
                },
              ],
            }),
          ),
        ),
        false,
        `required ${status} must block`,
      );
    }
    assert.strictEqual(
      gate(
        gateInput(
          minEvidence({
            cells: [
              { id: 'A1', status: 'PASS', errorCode: null },
              {
                id: 'A2',
                status: 'EVIDENCE-DEGRADED',
                errorCode: ERROR_CODES.EVIDENCE_ARTIFACT_MISSING,
              },
            ],
          }),
        ),
      ),
      false,
    );

    // proxy/firewall fail still true
    assert.strictEqual(
      gate(
        gateInput(
          minEvidence({
            proxyResult: {
              status: 'fail',
              errorCode: ERROR_CODES.PROXY_CONNECT_FAILED,
            },
            firewallResult: {
              status: 'fail',
              errorCode: 'fw-x',
            },
          }),
        ),
      ),
      true,
    );

    // optional A2-ext DEGRADED does not block
    assert.strictEqual(
      gate(
        gateInput(
          minEvidence({
            cells: [
              { id: 'A1', status: 'PASS', errorCode: null },
              { id: 'A2', status: 'PASS', errorCode: null },
              {
                id: 'A2-ext',
                status: 'EVIDENCE-DEGRADED',
                errorCode: ERROR_CODES.EVIDENCE_ARTIFACT_DIGEST_MISMATCH,
              },
            ],
          }),
          ['A1', 'A2'],
        ),
      ),
      true,
    );

    // overall arbitrary does not affect gate
    assert.strictEqual(
      gate(gateInput(minEvidence({ overall: 'FAIL-everything' }))),
      true,
    );
    assert.strictEqual(
      gate(gateInput(minEvidence({ overall: 'blocked' }))),
      true,
    );

    // requiredCellIds invalid
    assert.strictEqual(gate(gateInput(good, [])), false);
    assert.strictEqual(gate(gateInput(good, ['A1', 'A1'])), false);
    assert.strictEqual(gate(gateInput(good, [''])), false);
    assert.strictEqual(gate(gateInput(good, [1])), false);
    const sparseIds = [];
    sparseIds[1] = 'A1';
    assert.strictEqual(gate(gateInput(good, sparseIds)), false);

    // duplicate required cell id in evidence (two A1)
    assert.strictEqual(
      gate(
        gateInput(
          minEvidence({
            cells: [
              { id: 'A1', status: 'PASS', errorCode: null },
              { id: 'A1', status: 'PASS', errorCode: null },
              { id: 'A2', status: 'PASS', errorCode: null },
            ],
          }),
        ),
      ),
      false,
    );

    // user-managed real path true
    assert.strictEqual(
      gate(
        gateInput(
          minEvidence({
            relayType: 'user-managed',
            relayDeployment: {
              kind: 'user-managed',
              publicListener: true,
            },
          }),
        ),
      ),
      true,
    );
  });

  it('6) artifact truth table + frozen + invalid', () => {
    const classify = evidence.classifyCrossLanExternalArtifactState;
    assert.strictEqual(typeof classify, 'function');

    const ok = classify({
      artifactState: 'available',
      digestState: 'match',
    });
    assert.deepStrictEqual(ok, {
      ok: true,
      cellStatus: null,
      errorCode: null,
    });
    assert.ok(Object.isFrozen(ok));

    for (const digestState of ['match', 'mismatch', 'unverifiable']) {
      const missing = classify({
        artifactState: 'missing',
        digestState,
      });
      assert.deepStrictEqual(missing, {
        ok: true,
        cellStatus: 'EVIDENCE-DEGRADED',
        errorCode: ERROR_CODES.EVIDENCE_ARTIFACT_MISSING,
      });
      assert.ok(Object.isFrozen(missing));
    }

    for (const digestState of ['mismatch', 'unverifiable']) {
      const degraded = classify({
        artifactState: 'available',
        digestState,
      });
      assert.deepStrictEqual(degraded, {
        ok: true,
        cellStatus: 'EVIDENCE-DEGRADED',
        errorCode: ERROR_CODES.EVIDENCE_ARTIFACT_DIGEST_MISMATCH,
      });
      assert.ok(Object.isFrozen(degraded));
    }

    const invalids = [
      null,
      undefined,
      {},
      { artifactState: 'available' },
      { digestState: 'match' },
      { artifactState: 'gone', digestState: 'match' },
      { artifactState: 'available', digestState: 'ok' },
      { artifactState: 'available', digestState: 'match', extra: 1 },
      { artifactState: 1, digestState: 'match' },
    ];
    for (const input of invalids) {
      const out = classify(input);
      assert.deepStrictEqual(out, {
        ok: false,
        cellStatus: null,
        errorCode: null,
      });
      assert.ok(Object.isFrozen(out));
      // never invents wire status strings beyond EVIDENCE-DEGRADED/null
      assert.notStrictEqual(out.cellStatus, 'INVALID');
      assert.notStrictEqual(out.cellStatus, 'FAIL');
    }
  });

  it('7) degraded impact truth table + invalid blocked', () => {
    const resolve = evidence.resolveCrossLanEvidenceDegradedImpact;
    assert.strictEqual(typeof resolve, 'function');

    assert.strictEqual(
      resolve({
        cellStatus: 'FAIL',
        isGoldRequired: false,
        hasAlternativeRealEvidence: false,
      }),
      'ready-unaffected',
    );
    assert.strictEqual(
      resolve({
        cellStatus: 'PASS',
        isGoldRequired: true,
        hasAlternativeRealEvidence: false,
      }),
      'ready-unaffected',
    );
    assert.strictEqual(
      resolve({
        cellStatus: 'EVIDENCE-DEGRADED',
        isGoldRequired: true,
        hasAlternativeRealEvidence: true,
      }),
      'partial',
    );
    assert.strictEqual(
      resolve({
        cellStatus: 'EVIDENCE-DEGRADED',
        isGoldRequired: true,
        hasAlternativeRealEvidence: false,
      }),
      'blocked',
    );
    for (const cellStatus of ['FAIL', 'BLOCKED', 'SKIP']) {
      assert.strictEqual(
        resolve({
          cellStatus,
          isGoldRequired: true,
          hasAlternativeRealEvidence: true,
        }),
        'blocked',
      );
    }

    const invalids = [
      null,
      undefined,
      {},
      {
        cellStatus: 'PASS',
        isGoldRequired: true,
      },
      {
        cellStatus: 'maybe',
        isGoldRequired: true,
        hasAlternativeRealEvidence: false,
      },
      {
        cellStatus: 'PASS',
        isGoldRequired: 'yes',
        hasAlternativeRealEvidence: false,
      },
      {
        cellStatus: 'PASS',
        isGoldRequired: true,
        hasAlternativeRealEvidence: 'no',
      },
      {
        cellStatus: 'PASS',
        isGoldRequired: true,
        hasAlternativeRealEvidence: false,
        extra: 1,
      },
    ];
    for (const input of invalids) {
      assert.strictEqual(resolve(input), 'blocked');
    }
  });

  it('8) budget boundaries / overflow / null invalid', () => {
    const calc = evidence.calculateCrossLanEvidenceMaxRepoReportBytes;
    assert.strictEqual(typeof calc, 'function');

    assert.strictEqual(calc({ cellCount: 0, schemaObjectCount: 8 }), 98304);
    assert.strictEqual(calc({ cellCount: 10, schemaObjectCount: 8 }), 139264);
    // effective objects = max(count, 8)
    assert.strictEqual(calc({ cellCount: 0, schemaObjectCount: 0 }), 98304);
    assert.strictEqual(calc({ cellCount: 0, schemaObjectCount: 3 }), 98304);
    assert.strictEqual(
      calc({ cellCount: 1, schemaObjectCount: 9 }),
      32768 + 4096 + 8192 * 9,
    );

    // overflow-safe shortcuts → hard ceiling
    assert.strictEqual(
      calc({ cellCount: 128, schemaObjectCount: 8 }),
      524288,
    );
    assert.strictEqual(
      calc({ cellCount: 0, schemaObjectCount: 64 }),
      524288,
    );
    assert.strictEqual(
      calc({ cellCount: Number.MAX_SAFE_INTEGER, schemaObjectCount: 8 }),
      524288,
    );

    // below shortcut thresholds still min with ceiling
    assert.strictEqual(
      calc({ cellCount: 127, schemaObjectCount: 63 }),
      524288,
    );

    // never NaN / Infinity
    const samples = [
      { cellCount: 0, schemaObjectCount: 8 },
      { cellCount: 10, schemaObjectCount: 8 },
      { cellCount: 127, schemaObjectCount: 8 },
      { cellCount: 128, schemaObjectCount: 8 },
      { cellCount: 0, schemaObjectCount: 64 },
    ];
    for (const input of samples) {
      const n = calc(input);
      assert.strictEqual(Number.isFinite(n), true);
      assert.strictEqual(Number.isNaN(n), false);
      assert.notStrictEqual(n, Infinity);
    }

    // invalid → null
    assert.strictEqual(calc(null), null);
    assert.strictEqual(calc(undefined), null);
    assert.strictEqual(calc({}), null);
    assert.strictEqual(calc({ cellCount: -1, schemaObjectCount: 8 }), null);
    assert.strictEqual(calc({ cellCount: 0, schemaObjectCount: -1 }), null);
    assert.strictEqual(calc({ cellCount: 1.5, schemaObjectCount: 8 }), null);
    assert.strictEqual(calc({ cellCount: 0, schemaObjectCount: 1.2 }), null);
    assert.strictEqual(
      calc({ cellCount: Number.NaN, schemaObjectCount: 8 }),
      null,
    );
    assert.strictEqual(
      calc({ cellCount: Infinity, schemaObjectCount: 8 }),
      null,
    );
    assert.strictEqual(
      calc({ cellCount: '0', schemaObjectCount: 8 }),
      null,
    );
    assert.strictEqual(
      calc({
        cellCount: 0,
        schemaObjectCount: 8,
        extra: 1,
      }),
      null,
    );
  });

  it('8b) M5 adversarial: get-vs-descriptor splits cannot false-PASS; gate follows descriptor snapshot only', () => {
    const gate = evidence.doesCrossLanEvidenceSatisfyM5RealGate;
    const match = evidence.matchesCrossLanEvidenceShape;

    /**
     * Own enumerable data fields: get trap returns `get` values while
     * getOwnPropertyDescriptor reports independent `desc` values.
     * Keys not listed fall through to the target.
     *
     * @param {object} target
     * @param {Record<string, { desc: unknown, get: unknown }>} splits
     */
    function splitGetVsDescriptor(target, splits) {
      return new Proxy(target, {
        get(t, prop, receiver) {
          if (typeof prop === 'string' && Object.hasOwn(splits, prop)) {
            return splits[prop].get;
          }
          return Reflect.get(t, prop, receiver);
        },
        getOwnPropertyDescriptor(t, prop) {
          if (typeof prop === 'string' && Object.hasOwn(splits, prop)) {
            return {
              value: splits[prop].desc,
              writable: true,
              enumerable: true,
              configurable: true,
            };
          }
          return Reflect.getOwnPropertyDescriptor(t, prop);
        },
      });
    }

    /**
     * Dense array Proxy: index descriptors report `descValues` while
     * ordinary index get returns `getValues`. Length descriptor follows
     * descValues; get('length') follows getValues (adversarial mismatch).
     *
     * @param {unknown[]} descValues
     * @param {unknown[]} getValues
     */
    function splitDenseArrayGetVsDescriptor(descValues, getValues) {
      const target = getValues.slice();
      return new Proxy(target, {
        get(t, prop, receiver) {
          if (prop === 'length') return getValues.length;
          if (typeof prop === 'string' && /^[0-9]+$/.test(prop)) {
            const i = Number(prop);
            if (i >= 0 && i < getValues.length) return getValues[i];
          }
          return Reflect.get(t, prop, receiver);
        },
        getOwnPropertyDescriptor(t, prop) {
          if (prop === 'length') {
            return {
              value: descValues.length,
              writable: true,
              enumerable: false,
              configurable: false,
            };
          }
          if (typeof prop === 'string' && /^[0-9]+$/.test(prop)) {
            const i = Number(prop);
            if (i >= 0 && i < descValues.length) {
              return {
                value: descValues[i],
                writable: true,
                enumerable: true,
                configurable: true,
              };
            }
          }
          return Reflect.getOwnPropertyDescriptor(t, prop);
        },
        ownKeys() {
          /** @type {(string|symbol)[]} */
          const keys = [];
          for (let i = 0; i < descValues.length; i += 1) {
            keys.push(String(i));
          }
          keys.push('length');
          return keys;
        },
      });
    }

    // --- top-level relayType: descriptor mock (shape-ok) vs get real ---
    {
      const doc = splitGetVsDescriptor(minEvidence(), {
        relayType: {
          desc: 'mock',
          get: 'operator-managed-test',
        },
      });
      assert.strictEqual(
        match(shapeInput(doc)),
        true,
        'descriptor mock remains shape-valid',
      );
      assert.strictEqual(
        gate(gateInput(doc)),
        false,
        'relayType get-vs-descriptor must not false-PASS M5',
      );
    }

    // --- top-level relayForced: descriptor false vs get true ---
    {
      const doc = splitGetVsDescriptor(minEvidence(), {
        relayForced: { desc: false, get: true },
      });
      assert.strictEqual(match(shapeInput(doc)), true);
      assert.strictEqual(
        gate(gateInput(doc)),
        false,
        'relayForced get-vs-descriptor must not false-PASS M5',
      );
    }

    // --- topology.independentNatDomains: descriptor false vs get true ---
    {
      const topology = splitGetVsDescriptor(
        {
          sideA: { natType: 'unknown', role: 'endpoint' },
          sideB: { natType: 'full-cone', role: 'controller' },
          independentNatDomains: true,
        },
        { independentNatDomains: { desc: false, get: true } },
      );
      const doc = minEvidence({ topology });
      assert.strictEqual(match(shapeInput(doc)), true);
      assert.strictEqual(
        gate(gateInput(doc)),
        false,
        'independentNatDomains get-vs-descriptor must not false-PASS M5',
      );
    }

    // --- relayDeployment.publicListener: descriptor false vs get true ---
    {
      const deployment = splitGetVsDescriptor(
        {
          kind: 'operator-managed-test',
          publicListener: true,
        },
        { publicListener: { desc: false, get: true } },
      );
      const doc = minEvidence({ relayDeployment: deployment });
      assert.strictEqual(match(shapeInput(doc)), true);
      assert.strictEqual(
        gate(gateInput(doc)),
        false,
        'publicListener get-vs-descriptor must not false-PASS M5',
      );
    }

    // --- reachabilityResult.status: descriptor fail vs get pass ---
    {
      const reachability = splitGetVsDescriptor(
        { status: 'pass' },
        { status: { desc: 'fail', get: 'pass' } },
      );
      const doc = minEvidence({ reachabilityResult: reachability });
      assert.strictEqual(match(shapeInput(doc)), true);
      assert.strictEqual(
        gate(gateInput(doc)),
        false,
        'reachability status get-vs-descriptor must not false-PASS M5',
      );
    }

    // --- required cells[].status: descriptor FAIL vs get PASS ---
    {
      const cellA2 = splitGetVsDescriptor(
        { id: 'A2', status: 'PASS', errorCode: null },
        {
          status: { desc: 'FAIL', get: 'PASS' },
          errorCode: { desc: 'forced-fail', get: null },
        },
      );
      const doc = minEvidence({
        cells: [{ id: 'A1', status: 'PASS', errorCode: null }, cellA2],
      });
      assert.strictEqual(
        match(shapeInput(doc)),
        true,
        'descriptor FAIL+errorCode remains shape-valid',
      );
      assert.strictEqual(
        gate(gateInput(doc)),
        false,
        'cells[].status get-vs-descriptor must not false-PASS M5',
      );
    }

    // --- requiredCellIds: descriptor missing ids vs get present ids ---
    {
      const good = minEvidence();
      const requiredCellIds = splitDenseArrayGetVsDescriptor(
        ['MISSING-1', 'MISSING-2'],
        ['A1', 'A2'],
      );
      assert.strictEqual(
        gate(gateInput(good, /** @type {string[]} */ (requiredCellIds))),
        false,
        'requiredCellIds get-vs-descriptor must not false-PASS M5',
      );
    }

    // --- inconsistent / throwing Proxy introspection stays total false ---
    {
      let flips = 0;
      const flipTarget = minEvidence();
      const flipProxy = new Proxy(flipTarget, {
        getOwnPropertyDescriptor(t, prop) {
          if (prop === 'relayForced') {
            flips += 1;
            // alternate across repeated introspection within a call
            return {
              value: flips % 2 === 1,
              writable: true,
              enumerable: true,
              configurable: true,
            };
          }
          return Reflect.getOwnPropertyDescriptor(t, prop);
        },
      });
      assert.doesNotThrow(() => gate(gateInput(flipProxy)));
      // must not throw; if a single-pass snapshot is used, result is boolean
      assert.strictEqual(typeof gate(gateInput(flipProxy)), 'boolean');

      const throwDesc = new Proxy(minEvidence(), {
        getOwnPropertyDescriptor() {
          throw new Error('desc-trap');
        },
      });
      assert.doesNotThrow(() => gate(gateInput(throwDesc)));
      assert.strictEqual(gate(gateInput(throwDesc)), false);

      const throwOwnKeys = new Proxy(minEvidence(), {
        ownKeys() {
          throw new Error('ownKeys-trap');
        },
      });
      assert.doesNotThrow(() => gate(gateInput(throwOwnKeys)));
      assert.strictEqual(gate(gateInput(throwOwnKeys)), false);
    }
  });

  it('9) honesty: no filename matcher / date arithmetic exports; T1.0/M5 runtime still blocked/not ready; no I/O', () => {
    assert.strictEqual(
      Object.hasOwn(evidence, 'matchesCrossLanEvidenceFilename'),
      false,
    );
    assert.strictEqual(
      Object.hasOwn(evidence, 'calculateCrossLanEvidenceRetentionDeadline'),
      false,
    );
    assert.strictEqual(
      evidence.matchesCrossLanEvidenceFilename,
      undefined,
    );
    assert.strictEqual(
      evidence.calculateCrossLanEvidenceRetentionDeadline,
      undefined,
    );

    assert.strictEqual(
      evidence.CROSS_LAN_EVIDENCE_RETENTION_POLICY.dateArithmeticImplemented,
      false,
    );
    assert.strictEqual(
      evidence.CROSS_LAN_EVIDENCE_RETENTION_POLICY.filenameMatcherImplemented,
      false,
    );
    assert.strictEqual(
      evidence.CROSS_LAN_EVIDENCE_SCHEMA.implementationStage,
      'T1.15-M1-contract-only',
    );

    // T1.0 Noise gate remains BLOCKED — this module must not claim crypto PASS
    assert.notStrictEqual(
      evidence.CROSS_LAN_EVIDENCE_SCHEMA.implementationStage,
      'T1.0-noise-ready',
    );
    assert.notStrictEqual(
      evidence.CROSS_LAN_EVIDENCE_SCHEMA.implementationStage,
      'M5-real-harness-ready',
    );

    // Pure decision API only: no evidence file I/O helpers exported
    for (const name of [
      'readCrossLanEvidence',
      'writeCrossLanEvidence',
      'deleteCrossLanEvidence',
      'scanCrossLanEvidenceSecrets',
      'loadGoldEvidence',
    ]) {
      assert.strictEqual(Object.hasOwn(evidence, name), false, name);
    }
  });
});
