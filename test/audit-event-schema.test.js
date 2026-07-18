import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectStrictCanonicalSanitizedEvent,
  sanitizeAuditEvent,
  stringifyStrictCanonicalSanitizedEvent,
} from '../src/audit-event-schema.js';

const FIXED_NOW = new Date('2026-07-06T12:00:00.000Z');
const FIXED_ID = '11111111-1111-1111-1111-111111111111';
const FIXED_CREATED_AT = '2026-07-06T12:00:00.000Z';

/** Byte-stable canary input: fixed id/createdAt/now + sensitive fields that must drop. */
const FIXED_RAW_EVENT = {
  id: FIXED_ID,
  createdAt: FIXED_CREATED_AT,
  type: 'api.backup.created',
  method: 'POST',
  path: '/api/backups',
  statusCode: 201,
  outcome: 'success',
  requestId: 'req-allowlist',
  deviceId: 'device-1',
  snapshotId: 'snapshot-1',
  fileCount: 2,
  message: 'created',
  targetName: 'primary-nas',
  attemptId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  errorCode: 'smb-execution-blocked',
  totalBytes: 12,
  verifiedFileCount: 2,
  retryCount: 0,
  wouldWrite: false,
  executionRequired: true,
  Authorization: 'Bearer leaked',
  sourcePath: '/private/tmp/source-secret',
  targetPath: '/private/tmp/target-secret',
  endpoint: 'http://admin:secret@nas.local',
  token: 'token-secret',
  password: 'password-secret',
  apiKey: 'api-key-secret',
  ownerToken: 'owner-token-secret',
  mountPath: '/Volumes/secret-mount',
};

const FIXED_SANITIZED = {
  id: FIXED_ID,
  createdAt: FIXED_CREATED_AT,
  type: 'api.backup.created',
  method: 'POST',
  path: '/api/backups',
  outcome: 'success',
  requestId: 'req-allowlist',
  deviceId: 'device-1',
  snapshotId: 'snapshot-1',
  message: 'created',
  targetName: 'primary-nas',
  attemptId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  errorCode: 'smb-execution-blocked',
  statusCode: 201,
  fileCount: 2,
  totalBytes: 12,
  verifiedFileCount: 2,
  retryCount: 0,
  wouldWrite: false,
  executionRequired: true,
};

const FIXED_JSON =
  '{"id":"11111111-1111-1111-1111-111111111111","createdAt":"2026-07-06T12:00:00.000Z","type":"api.backup.created","method":"POST","path":"/api/backups","outcome":"success","requestId":"req-allowlist","deviceId":"device-1","snapshotId":"snapshot-1","message":"created","targetName":"primary-nas","attemptId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","errorCode":"smb-execution-blocked","statusCode":201,"fileCount":2,"totalBytes":12,"verifiedFileCount":2,"retryCount":0,"wouldWrite":false,"executionRequired":true}';

describe('sanitizeAuditEvent byte-stable extraction', () => {
  it('matches the fixed exact JSON canary including field order', () => {
    const out = sanitizeAuditEvent(FIXED_RAW_EVENT, FIXED_NOW);
    assert.deepEqual(out, FIXED_SANITIZED);
    assert.equal(JSON.stringify(out), FIXED_JSON);
    assert.deepEqual(Object.keys(out), Object.keys(FIXED_SANITIZED));
    assert.doesNotMatch(
      JSON.stringify(out),
      /Bearer|private\/tmp|admin:secret|token-secret|password-secret|api-key-secret|owner-token|secret-mount/,
    );
  });

  it('trims strings and clamps to 200 characters', () => {
    const long = `  ${'x'.repeat(250)}  `;
    const out = sanitizeAuditEvent({
      id: FIXED_ID,
      createdAt: FIXED_CREATED_AT,
      type: '  typed  ',
      message: long,
    }, FIXED_NOW);
    assert.equal(out.type, 'typed');
    assert.equal(out.message.length, 200);
    assert.equal(out.message, 'x'.repeat(200));
  });

  it('generates a UUID-shaped id when id is missing or empty after sanitize', () => {
    const missing = sanitizeAuditEvent({ createdAt: FIXED_CREATED_AT, type: 't' }, FIXED_NOW);
    assert.match(missing.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    const blank = sanitizeAuditEvent({ id: '   ', createdAt: FIXED_CREATED_AT, type: 't' }, FIXED_NOW);
    assert.match(blank.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('falls back to now ISO for invalid createdAt', () => {
    const out = sanitizeAuditEvent({
      id: FIXED_ID,
      createdAt: 'not-a-date',
      type: 't',
    }, FIXED_NOW);
    assert.equal(out.createdAt, FIXED_CREATED_AT);
  });

  it('keeps integer statusCode including negatives and drops non-integers', () => {
    assert.equal(
      sanitizeAuditEvent({ id: FIXED_ID, createdAt: FIXED_CREATED_AT, statusCode: -1 }, FIXED_NOW).statusCode,
      -1,
    );
    assert.equal(
      sanitizeAuditEvent({ id: FIXED_ID, createdAt: FIXED_CREATED_AT, statusCode: 201 }, FIXED_NOW).statusCode,
      201,
    );
    assert.equal(
      Object.hasOwn(
        sanitizeAuditEvent({ id: FIXED_ID, createdAt: FIXED_CREATED_AT, statusCode: 1.5 }, FIXED_NOW),
        'statusCode',
      ),
      false,
    );
    assert.equal(
      Object.hasOwn(
        sanitizeAuditEvent({ id: FIXED_ID, createdAt: FIXED_CREATED_AT, statusCode: '201' }, FIXED_NOW),
        'statusCode',
      ),
      false,
    );
  });

  it('applies non-negative integer and boolean field rules', () => {
    const out = sanitizeAuditEvent({
      id: FIXED_ID,
      createdAt: FIXED_CREATED_AT,
      fileCount: 0,
      totalBytes: 3,
      verifiedFileCount: -1,
      retryCount: 1.5,
      wouldWrite: false,
      executionRequired: true,
      wouldWriteStr: 'yes',
    }, FIXED_NOW);
    assert.equal(out.fileCount, 0);
    assert.equal(out.totalBytes, 3);
    assert.equal(Object.hasOwn(out, 'verifiedFileCount'), false);
    assert.equal(Object.hasOwn(out, 'retryCount'), false);
    assert.equal(out.wouldWrite, false);
    assert.equal(out.executionRequired, true);

    const droppedBool = sanitizeAuditEvent({
      id: FIXED_ID,
      createdAt: FIXED_CREATED_AT,
      wouldWrite: 'no',
      executionRequired: 1,
    }, FIXED_NOW);
    assert.equal(Object.hasOwn(droppedBool, 'wouldWrite'), false);
    assert.equal(Object.hasOwn(droppedBool, 'executionRequired'), false);
  });
});

describe('projectStrictCanonicalSanitizedEvent fail-closed', () => {
  it('accepts a post-sanitize plain event and rebuilds fixed field order', () => {
    const projected = projectStrictCanonicalSanitizedEvent(FIXED_SANITIZED);
    assert.deepEqual(projected, FIXED_SANITIZED);
    assert.deepEqual(Object.keys(projected), Object.keys(FIXED_SANITIZED));
    // Projection must not invent ids/times — only accept post-sanitize events.
    assert.equal(projected.id, FIXED_ID);
    assert.equal(projected.createdAt, FIXED_CREATED_AT);
  });

  it('rejects missing id or createdAt without synthesizing defaults', () => {
    assert.throws(() => projectStrictCanonicalSanitizedEvent({
      createdAt: FIXED_CREATED_AT,
      type: 't',
    }));
    assert.throws(() => projectStrictCanonicalSanitizedEvent({
      id: FIXED_ID,
      type: 't',
    }));
    assert.throws(() => projectStrictCanonicalSanitizedEvent({
      id: '',
      createdAt: FIXED_CREATED_AT,
    }));
    assert.throws(() => projectStrictCanonicalSanitizedEvent({
      id: FIXED_ID,
      createdAt: '',
    }));
  });

  it('rejects non-canonical createdAt; accepts Date#toISOString() form only', () => {
    // Canonical form from sanitize / Date#toISOString() remains accepted.
    assert.deepEqual(
      projectStrictCanonicalSanitizedEvent({
        id: FIXED_ID,
        createdAt: FIXED_CREATED_AT,
      }),
      { id: FIXED_ID, createdAt: FIXED_CREATED_AT },
    );
    assert.equal(
      projectStrictCanonicalSanitizedEvent({
        id: FIXED_ID,
        createdAt: '2026-07-06T12:00:00.000Z',
      }).createdAt,
      '2026-07-06T12:00:00.000Z',
    );

    // Extended-year boundary: Date#toISOString() can emit +YYYYYY-… form.
    const extendedYear = '+010000-01-01T00:00:00.000Z';
    assert.equal(new Date(extendedYear).toISOString(), extendedYear);
    assert.equal(
      projectStrictCanonicalSanitizedEvent({
        id: FIXED_ID,
        createdAt: extendedYear,
      }).createdAt,
      extendedYear,
    );

    // Invalid date string (sanitize would invent fallback now).
    assert.throws(() => projectStrictCanonicalSanitizedEvent({
      id: FIXED_ID,
      createdAt: 'not-a-date',
    }));

    // Missing milliseconds — Date parses it but toISOString() rewrites to .000Z.
    assert.throws(() => projectStrictCanonicalSanitizedEvent({
      id: FIXED_ID,
      createdAt: '2026-07-06T12:00:00Z',
    }));

    // Offset form is absolute-time-valid but not Date#toISOString() output.
    assert.throws(() => projectStrictCanonicalSanitizedEvent({
      id: FIXED_ID,
      createdAt: '2026-07-06T20:00:00.000+08:00',
    }));
  });

  it('rejects hostile matrix: proxy, array, symbol, extra, non-enumerable, accessor, function, invalid values', () => {
    assert.throws(() => projectStrictCanonicalSanitizedEvent(null));
    assert.throws(() => projectStrictCanonicalSanitizedEvent(undefined));
    assert.throws(() => projectStrictCanonicalSanitizedEvent('string'));
    assert.throws(() => projectStrictCanonicalSanitizedEvent(42));
    assert.throws(() => projectStrictCanonicalSanitizedEvent([{ id: FIXED_ID, createdAt: FIXED_CREATED_AT }]));
    assert.throws(() => projectStrictCanonicalSanitizedEvent(() => ({ id: FIXED_ID, createdAt: FIXED_CREATED_AT })));

    const proxy = new Proxy({ id: FIXED_ID, createdAt: FIXED_CREATED_AT }, {});
    assert.throws(() => projectStrictCanonicalSanitizedEvent(proxy));

    const withSymbol = { id: FIXED_ID, createdAt: FIXED_CREATED_AT };
    withSymbol[Symbol('secret')] = 'x';
    assert.throws(() => projectStrictCanonicalSanitizedEvent(withSymbol));

    assert.throws(() => projectStrictCanonicalSanitizedEvent({
      id: FIXED_ID,
      createdAt: FIXED_CREATED_AT,
      extraHostile: 'nope',
    }));

    const nonEnum = { id: FIXED_ID, createdAt: FIXED_CREATED_AT };
    Object.defineProperty(nonEnum, 'type', {
      value: 'hidden',
      enumerable: false,
      configurable: true,
      writable: true,
    });
    assert.throws(() => projectStrictCanonicalSanitizedEvent(nonEnum));

    const accessor = {
      id: FIXED_ID,
      createdAt: FIXED_CREATED_AT,
    };
    Object.defineProperty(accessor, 'type', {
      get() { return 'via-getter'; },
      enumerable: true,
      configurable: true,
    });
    assert.throws(() => projectStrictCanonicalSanitizedEvent(accessor));

    assert.throws(() => projectStrictCanonicalSanitizedEvent({
      id: FIXED_ID,
      createdAt: FIXED_CREATED_AT,
      type: () => 'fn',
    }));

    assert.throws(() => projectStrictCanonicalSanitizedEvent({
      id: FIXED_ID,
      createdAt: FIXED_CREATED_AT,
      statusCode: 1.5,
    }));
    assert.throws(() => projectStrictCanonicalSanitizedEvent({
      id: FIXED_ID,
      createdAt: FIXED_CREATED_AT,
      fileCount: -1,
    }));
    assert.throws(() => projectStrictCanonicalSanitizedEvent({
      id: FIXED_ID,
      createdAt: FIXED_CREATED_AT,
      wouldWrite: 'yes',
    }));

    const badProto = Object.create({ polluted: true });
    badProto.id = FIXED_ID;
    badProto.createdAt = FIXED_CREATED_AT;
    assert.throws(() => projectStrictCanonicalSanitizedEvent(badProto));

    // null prototype plain object with only allowed fields is accepted.
    const nullProto = Object.create(null);
    nullProto.id = FIXED_ID;
    nullProto.createdAt = FIXED_CREATED_AT;
    nullProto.type = 'ok';
    assert.deepEqual(projectStrictCanonicalSanitizedEvent(nullProto), {
      id: FIXED_ID,
      createdAt: FIXED_CREATED_AT,
      type: 'ok',
    });
  });
});

describe('stringifyStrictCanonicalSanitizedEvent', () => {
  it('stringifies projected events in fixed order with exact JSON', () => {
    assert.equal(stringifyStrictCanonicalSanitizedEvent(FIXED_SANITIZED), FIXED_JSON);

    const partial = {
      id: FIXED_ID,
      createdAt: FIXED_CREATED_AT,
      type: 'api.heartbeat.success',
      statusCode: 200,
      wouldWrite: false,
    };
    assert.equal(
      stringifyStrictCanonicalSanitizedEvent(partial),
      '{"id":"11111111-1111-1111-1111-111111111111","createdAt":"2026-07-06T12:00:00.000Z","type":"api.heartbeat.success","statusCode":200,"wouldWrite":false}',
    );

    // Round-trip: sanitize then strict stringify is byte-stable for fixed vectors.
    assert.equal(
      stringifyStrictCanonicalSanitizedEvent(sanitizeAuditEvent(FIXED_RAW_EVENT, FIXED_NOW)),
      FIXED_JSON,
    );
  });
});
