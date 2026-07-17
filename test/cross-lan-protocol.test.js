import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  CONTROL_PLANE_MESSAGE_SCHEMAS,
  DENYLIST_ENTRY_SCHEMA,
  hasExactControlPlaneMessageFields,
  hasExactDenylistEntryFields,
} from '../src/cross-lan-protocol.js';
// Namespace import so missing T1.3/T1.4/T1.7 named exports do not break T1.2 load-time.
import * as protocol from '../src/cross-lan-protocol.js';
import { ERROR_CODES } from '../src/error-codes.js';

/**
 * Closed-set pin of all 13 control-plane message schemas (T1.2).
 * Exact field names and fixed values are frozen by PM design.
 */
const EXPECTED_CONTROL_PLANE_MESSAGE_SCHEMAS = {
  'noise-msg1-payload': {
    requiredFields: [
      'deviceId',
      'enrollmentEpoch',
      'ed25519IdentityPub',
      'identityBindingSig',
      'clientNonce',
      'clientTimeUtc',
    ],
    optionalFields: [],
    fixedValues: {},
  },
  'noise-msg2-payload': {
    requiredFields: [
      'controllerId',
      'enrollmentEpoch',
      'serverNonce',
      'serverTimeUtc',
      'keyConfirmServer',
    ],
    optionalFields: ['rekeyGeneration'],
    fixedValues: { rekeyGeneration: 0 },
  },
  'key-confirm-client': {
    requiredFields: ['keyConfirmClient'],
    optionalFields: [],
    fixedValues: {},
  },
  'session-terminate': {
    requiredFields: ['reason'],
    optionalFields: [],
    fixedValues: { reason: 'revoked' },
  },
  'revoke-epoch': {
    requiredFields: ['deviceId', 'enrollmentEpoch', 'revokeGeneration'],
    optionalFields: [],
    fixedValues: {},
  },
  'denylist-update': {
    requiredFields: ['denylistVersion', 'entries'],
    optionalFields: [],
    fixedValues: {},
  },
  'denylist-ack': {
    requiredFields: ['denylistVersion'],
    optionalFields: [],
    fixedValues: {},
  },
  'relay-pin-set-update': {
    requiredFields: [
      'relayId',
      'oldSpkiPins',
      'newSpkiPins',
      'notBefore',
      'graceUntil',
      'updateId',
      'trustEpoch',
      'signature',
    ],
    optionalFields: [],
    fixedValues: {},
  },
  'relay-pin-set-ack': {
    requiredFields: ['updateId'],
    optionalFields: [],
    fixedValues: {},
  },
  'controller-noise-key-update': {
    requiredFields: [
      'oldNoiseStaticPub',
      'newNoiseStaticPub',
      'notBefore',
      'graceUntil',
      'trustEpoch',
      'updateId',
      'signature',
    ],
    optionalFields: [],
    fixedValues: {},
  },
  'controller-noise-key-ack': {
    requiredFields: ['updateId'],
    optionalFields: [],
    fixedValues: {},
  },
  'keepalive-ping': {
    requiredFields: [],
    optionalFields: [],
    fixedValues: {},
  },
  'keepalive-pong': {
    requiredFields: [],
    optionalFields: [],
    fixedValues: {},
  },
};

const EXPECTED_DENYLIST_ENTRY_SCHEMA = {
  identifierFields: ['tunnelId', 'deviceRoutingHandle'],
  generationFields: ['epoch', 'revokeGeneration'],
};

/** Fixed sentinel only — never put real secrets in fixtures. */
const SENTINEL_SECRET = 'SENTINEL_NOT_A_REAL_SECRET_VALUE';

/**
 * Minimal valid payloads per type (field presence only; values are dummies).
 * Values are NOT cryptographic material — schema is field-shape only.
 */
const MINIMAL_VALID_PAYLOADS = {
  'noise-msg1-payload': {
    deviceId: 'dev-1',
    enrollmentEpoch: 1,
    ed25519IdentityPub: 'pub',
    identityBindingSig: 'sig',
    clientNonce: 'nonce',
    clientTimeUtc: '2026-07-17T00:00:00.000Z',
  },
  'noise-msg2-payload': {
    controllerId: 'ctl-1',
    enrollmentEpoch: 1,
    serverNonce: 'nonce',
    serverTimeUtc: '2026-07-17T00:00:00.000Z',
    keyConfirmServer: 'mac',
  },
  'key-confirm-client': {
    keyConfirmClient: 'mac',
  },
  'session-terminate': {
    reason: 'revoked',
  },
  'revoke-epoch': {
    deviceId: 'dev-1',
    enrollmentEpoch: 1,
    revokeGeneration: 1,
  },
  'denylist-update': {
    denylistVersion: 1,
    entries: [{ tunnelId: 't1', epoch: 1 }],
  },
  'denylist-ack': {
    denylistVersion: 1,
  },
  'relay-pin-set-update': {
    relayId: 'relay-1',
    oldSpkiPins: [],
    newSpkiPins: [],
    notBefore: '2026-07-17T00:00:00.000Z',
    graceUntil: '2026-07-17T01:00:00.000Z',
    updateId: 'u1',
    trustEpoch: 1,
    signature: 'sig',
  },
  'relay-pin-set-ack': {
    updateId: 'u1',
  },
  'controller-noise-key-update': {
    oldNoiseStaticPub: 'old',
    newNoiseStaticPub: 'new',
    notBefore: '2026-07-17T00:00:00.000Z',
    graceUntil: '2026-07-17T01:00:00.000Z',
    trustEpoch: 1,
    updateId: 'u1',
    signature: 'sig',
  },
  'controller-noise-key-ack': {
    updateId: 'u1',
  },
  'keepalive-ping': {},
  'keepalive-pong': {},
};

class ExampleClass {
  constructor() {
    this.x = 1;
  }
}

describe('control-plane message schemas (T1.2)', () => {
  it('pins the exact closed-set of 13 message schemas', () => {
    assert.strictEqual(Object.keys(EXPECTED_CONTROL_PLANE_MESSAGE_SCHEMAS).length, 13);
    assert.strictEqual(Object.keys(CONTROL_PLANE_MESSAGE_SCHEMAS).length, 13);
    assert.deepStrictEqual(CONTROL_PLANE_MESSAGE_SCHEMAS, EXPECTED_CONTROL_PLANE_MESSAGE_SCHEMAS);
  });

  it('deep-freezes CONTROL_PLANE_MESSAGE_SCHEMAS and every descriptor field', () => {
    assert.ok(Object.isFrozen(CONTROL_PLANE_MESSAGE_SCHEMAS));
    for (const type of Object.keys(CONTROL_PLANE_MESSAGE_SCHEMAS)) {
      const d = CONTROL_PLANE_MESSAGE_SCHEMAS[type];
      assert.ok(Object.isFrozen(d), `descriptor frozen: ${type}`);
      assert.ok(Object.isFrozen(d.requiredFields), `requiredFields frozen: ${type}`);
      assert.ok(Object.isFrozen(d.optionalFields), `optionalFields frozen: ${type}`);
      assert.ok(Object.isFrozen(d.fixedValues), `fixedValues frozen: ${type}`);
    }
  });

  it('deep-freezes DENYLIST_ENTRY_SCHEMA and both field arrays', () => {
    assert.deepStrictEqual(DENYLIST_ENTRY_SCHEMA, EXPECTED_DENYLIST_ENTRY_SCHEMA);
    assert.ok(Object.isFrozen(DENYLIST_ENTRY_SCHEMA));
    assert.ok(Object.isFrozen(DENYLIST_ENTRY_SCHEMA.identifierFields));
    assert.ok(Object.isFrozen(DENYLIST_ENTRY_SCHEMA.generationFields));
  });

  it('accepts minimal valid payloads for all 13 types', () => {
    for (const type of Object.keys(EXPECTED_CONTROL_PLANE_MESSAGE_SCHEMAS)) {
      const payload = MINIMAL_VALID_PAYLOADS[type];
      assert.strictEqual(
        hasExactControlPlaneMessageFields(type, payload),
        true,
        `minimal valid for ${type}`,
      );
    }
  });

  it('accepts Object.create(null) plain records with exact fields', () => {
    const payload = Object.assign(Object.create(null), {
      keyConfirmClient: 'mac',
    });
    assert.strictEqual(hasExactControlPlaneMessageFields('key-confirm-client', payload), true);
  });

  it('noise-msg2-payload optional rekeyGeneration: missing or 0 true; 1/"0"/-0 false', () => {
    const base = { ...MINIMAL_VALID_PAYLOADS['noise-msg2-payload'] };
    assert.strictEqual(hasExactControlPlaneMessageFields('noise-msg2-payload', base), true);
    assert.strictEqual(
      hasExactControlPlaneMessageFields('noise-msg2-payload', { ...base, rekeyGeneration: 0 }),
      true,
    );
    assert.strictEqual(
      hasExactControlPlaneMessageFields('noise-msg2-payload', { ...base, rekeyGeneration: 1 }),
      false,
    );
    assert.strictEqual(
      hasExactControlPlaneMessageFields('noise-msg2-payload', { ...base, rekeyGeneration: '0' }),
      false,
    );
    assert.strictEqual(
      hasExactControlPlaneMessageFields('noise-msg2-payload', { ...base, rekeyGeneration: -0 }),
      false,
    );
  });

  it('session-terminate only accepts fixed reason revoked', () => {
    assert.strictEqual(
      hasExactControlPlaneMessageFields('session-terminate', { reason: 'revoked' }),
      true,
    );
    assert.strictEqual(
      hasExactControlPlaneMessageFields('session-terminate', { reason: 'timeout' }),
      false,
    );
    assert.strictEqual(
      hasExactControlPlaneMessageFields('session-terminate', { reason: 'REVOKED' }),
      false,
    );
    assert.strictEqual(
      hasExactControlPlaneMessageFields('session-terminate', {}),
      false,
    );
  });

  it('keepalive types accept exact empty payload and reject invented pingId', () => {
    assert.strictEqual(hasExactControlPlaneMessageFields('keepalive-ping', {}), true);
    assert.strictEqual(hasExactControlPlaneMessageFields('keepalive-pong', {}), true);
    assert.strictEqual(
      hasExactControlPlaneMessageFields('keepalive-ping', { pingId: 1 }),
      false,
    );
    assert.strictEqual(
      hasExactControlPlaneMessageFields('keepalive-pong', { pingId: 1 }),
      false,
    );
  });

  it('rejects unknown type, null, array, Date, Buffer, class instance', () => {
    assert.strictEqual(hasExactControlPlaneMessageFields('no-such-type', {}), false);
    // Object.prototype names must not resolve via inherited lookup (own-key only).
    assert.strictEqual(hasExactControlPlaneMessageFields('toString', {}), false);
    assert.strictEqual(hasExactControlPlaneMessageFields('constructor', {}), false);
    assert.strictEqual(hasExactControlPlaneMessageFields('__proto__', {}), false);
    assert.strictEqual(hasExactControlPlaneMessageFields('hasOwnProperty', {}), false);
    assert.doesNotThrow(() => {
      hasExactControlPlaneMessageFields('toString', {});
      hasExactControlPlaneMessageFields('constructor', {});
      hasExactControlPlaneMessageFields('__proto__', {});
      hasExactControlPlaneMessageFields('hasOwnProperty', {});
    });
    assert.strictEqual(hasExactControlPlaneMessageFields('denylist-ack', null), false);
    assert.strictEqual(hasExactControlPlaneMessageFields('denylist-ack', []), false);
    assert.strictEqual(hasExactControlPlaneMessageFields('denylist-ack', new Date()), false);
    assert.strictEqual(hasExactControlPlaneMessageFields('denylist-ack', Buffer.from('x')), false);
    assert.strictEqual(hasExactControlPlaneMessageFields('denylist-ack', new ExampleClass()), false);
  });

  it('rejects missing required, extra unknown, symbol, non-enumerable, accessor', () => {
    assert.strictEqual(hasExactControlPlaneMessageFields('denylist-ack', {}), false);

    assert.strictEqual(
      hasExactControlPlaneMessageFields('denylist-ack', {
        denylistVersion: 1,
        extra: true,
      }),
      false,
    );

    const withSymbol = { denylistVersion: 1 };
    Object.defineProperty(withSymbol, Symbol('s'), { value: 1, enumerable: true });
    assert.strictEqual(hasExactControlPlaneMessageFields('denylist-ack', withSymbol), false);

    const nonEnum = {};
    Object.defineProperty(nonEnum, 'denylistVersion', {
      value: 1,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    assert.strictEqual(hasExactControlPlaneMessageFields('denylist-ack', nonEnum), false);

    const accessor = {};
    Object.defineProperty(accessor, 'denylistVersion', {
      get() {
        return 1;
      },
      enumerable: true,
      configurable: true,
    });
    assert.strictEqual(hasExactControlPlaneMessageFields('denylist-ack', accessor), false);
  });

  it('returns false for throwing Proxy without throwing', () => {
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error(SENTINEL_SECRET);
        },
        get() {
          throw new Error(SENTINEL_SECRET);
        },
        getOwnPropertyDescriptor() {
          throw new Error(SENTINEL_SECRET);
        },
        getPrototypeOf() {
          throw new Error(SENTINEL_SECRET);
        },
      },
    );
    assert.strictEqual(hasExactControlPlaneMessageFields('denylist-ack', proxy), false);
    assert.strictEqual(hasExactDenylistEntryFields(proxy), false);
  });

  it('returns boolean false for invalid extra keys without throwing', () => {
    const bad = {
      denylistVersion: 1,
      [SENTINEL_SECRET]: SENTINEL_SECRET,
    };
    let result;
    assert.doesNotThrow(() => {
      result = hasExactControlPlaneMessageFields('denylist-ack', bad);
    });
    assert.strictEqual(result, false);
    assert.strictEqual(typeof result, 'boolean');
  });

  it('accepts all four legal denylist entry field combinations', () => {
    assert.strictEqual(hasExactDenylistEntryFields({ tunnelId: 't', epoch: 1 }), true);
    assert.strictEqual(
      hasExactDenylistEntryFields({ tunnelId: 't', revokeGeneration: 1 }),
      true,
    );
    assert.strictEqual(
      hasExactDenylistEntryFields({ deviceRoutingHandle: 'h', epoch: 1 }),
      true,
    );
    assert.strictEqual(
      hasExactDenylistEntryFields({ deviceRoutingHandle: 'h', revokeGeneration: 1 }),
      true,
    );
    // null-prototype plain record with a legal pair is accepted.
    const nullProtoEntry = Object.assign(Object.create(null), {
      tunnelId: 't',
      epoch: 1,
    });
    assert.strictEqual(hasExactDenylistEntryFields(nullProtoEntry), true);
  });

  it('rejects illegal denylist entry shapes', () => {
    assert.strictEqual(hasExactDenylistEntryFields(null), false);
    assert.strictEqual(hasExactDenylistEntryFields([]), false);
    assert.strictEqual(hasExactDenylistEntryFields(new Date()), false);
    assert.strictEqual(hasExactDenylistEntryFields({ tunnelId: 't' }), false);
    assert.strictEqual(
      hasExactDenylistEntryFields({ tunnelId: 't', epoch: 1, revokeGeneration: 2 }),
      false,
    );
    assert.strictEqual(
      hasExactDenylistEntryFields({ tunnelId: 't', deviceRoutingHandle: 'h' }),
      false,
    );
    assert.strictEqual(
      hasExactDenylistEntryFields({ epoch: 1, revokeGeneration: 2 }),
      false,
    );
    assert.strictEqual(
      hasExactDenylistEntryFields({ tunnelId: 't', epoch: 1, extra: true }),
      false,
    );
    assert.strictEqual(hasExactDenylistEntryFields({ foo: 1, bar: 2 }), false);
    assert.strictEqual(hasExactDenylistEntryFields(new ExampleClass()), false);
  });

  it('denylist-update requires entries array of exact entries; empty array ok', () => {
    assert.strictEqual(
      hasExactControlPlaneMessageFields('denylist-update', {
        denylistVersion: 1,
        entries: [],
      }),
      true,
    );
    assert.strictEqual(
      hasExactControlPlaneMessageFields('denylist-update', {
        denylistVersion: 1,
        entries: [{ tunnelId: 't', epoch: 1 }],
      }),
      true,
    );
    assert.strictEqual(
      hasExactControlPlaneMessageFields('denylist-update', {
        denylistVersion: 1,
        entries: 'not-array',
      }),
      false,
    );
    assert.strictEqual(
      hasExactControlPlaneMessageFields('denylist-update', {
        denylistVersion: 1,
        entries: [{ tunnelId: 't', epoch: 1, extra: true }],
      }),
      false,
    );
    assert.strictEqual(
      hasExactControlPlaneMessageFields('denylist-update', {
        denylistVersion: 1,
        entries: [{ tunnelId: 't', epoch: 1 }, { bad: true }],
      }),
      false,
    );
  });
});

/**
 * Closed-set pin of cross-LAN session state transitions (T1.3).
 * Exact table only — not generated from production values.
 * key-confirmed / rekey-confirmed are runtime-synthesized internal events
 * after auth/MAC verification; raw wire message types do not advance state.
 */
const EXPECTED_CROSS_LAN_SESSION_TRANSITIONS = {
  idle: {
    'start-handshake': 'handshaking',
    close: 'closed',
  },
  handshaking: {
    'key-confirmed': 'established',
    fail: 'failed',
    close: 'closed',
  },
  established: {
    'start-rekey': 'rekeying',
    fail: 'failed',
    close: 'closed',
  },
  rekeying: {
    'rekey-confirmed': 'established',
    fail: 'failed',
    close: 'closed',
  },
  failed: {
    close: 'closed',
  },
  closed: {},
};

describe('cross-LAN session state machine (T1.3)', () => {
  it('pins the exact closed-set of 6 session states and transitions', () => {
    assert.strictEqual(Object.keys(EXPECTED_CROSS_LAN_SESSION_TRANSITIONS).length, 6);
    assert.strictEqual(Object.keys(protocol.CROSS_LAN_SESSION_TRANSITIONS).length, 6);
    assert.deepStrictEqual(
      protocol.CROSS_LAN_SESSION_TRANSITIONS,
      EXPECTED_CROSS_LAN_SESSION_TRANSITIONS,
    );
  });

  it('deep-freezes CROSS_LAN_SESSION_TRANSITIONS and every state row', () => {
    assert.ok(Object.isFrozen(protocol.CROSS_LAN_SESSION_TRANSITIONS));
    for (const state of Object.keys(protocol.CROSS_LAN_SESSION_TRANSITIONS)) {
      assert.ok(
        Object.isFrozen(protocol.CROSS_LAN_SESSION_TRANSITIONS[state]),
        `state row frozen: ${state}`,
      );
    }
  });

  it('happy path: idle → handshaking → established → rekeying → established → closed', () => {
    const next = protocol.getNextCrossLanSessionState;
    assert.strictEqual(next('idle', 'start-handshake'), 'handshaking');
    assert.strictEqual(next('handshaking', 'key-confirmed'), 'established');
    assert.strictEqual(next('established', 'start-rekey'), 'rekeying');
    assert.strictEqual(next('rekeying', 'rekey-confirmed'), 'established');
    assert.strictEqual(next('established', 'close'), 'closed');
  });

  it('only verified confirmation advances; raw message events return null', () => {
    const next = protocol.getNextCrossLanSessionState;
    // Raw control-plane wire types must not advance the session FSM.
    assert.strictEqual(next('handshaking', 'key-confirm-client'), null);
    assert.strictEqual(next('handshaking', 'msg2-received'), null);
    assert.strictEqual(next('handshaking', 'handshake-complete'), null);
    assert.strictEqual(next('handshaking', 'noise-msg2-payload'), null);
    // Cross-state confirmation events are invalid.
    assert.strictEqual(next('handshaking', 'rekey-confirmed'), null);
    assert.strictEqual(next('rekeying', 'key-confirmed'), null);
    assert.strictEqual(next('established', 'key-confirmed'), null);
    assert.strictEqual(next('established', 'rekey-confirmed'), null);
    assert.strictEqual(next('idle', 'key-confirmed'), null);
    assert.strictEqual(next('idle', 'rekey-confirmed'), null);
  });

  it('fail paths, failed only close, and closed is terminal', () => {
    const next = protocol.getNextCrossLanSessionState;
    assert.strictEqual(next('handshaking', 'fail'), 'failed');
    assert.strictEqual(next('established', 'fail'), 'failed');
    assert.strictEqual(next('rekeying', 'fail'), 'failed');
    // failed may only close.
    assert.strictEqual(next('failed', 'close'), 'closed');
    assert.strictEqual(next('failed', 'fail'), null);
    assert.strictEqual(next('failed', 'start-handshake'), null);
    assert.strictEqual(next('failed', 'key-confirmed'), null);
    assert.strictEqual(next('failed', 'start-rekey'), null);
    assert.strictEqual(next('failed', 'rekey-confirmed'), null);
    // closed is terminal — no transitions.
    assert.strictEqual(next('closed', 'close'), null);
    assert.strictEqual(next('closed', 'fail'), null);
    assert.strictEqual(next('closed', 'start-handshake'), null);
    assert.strictEqual(next('closed', 'key-confirmed'), null);
    assert.strictEqual(next('closed', 'start-rekey'), null);
    assert.strictEqual(next('closed', 'rekey-confirmed'), null);
  });

  it('invalid state/event/non-string/Object.prototype names return null without throwing', () => {
    const next = protocol.getNextCrossLanSessionState;
    assert.doesNotThrow(() => {
      assert.strictEqual(next('no-such-state', 'close'), null);
      assert.strictEqual(next('idle', 'no-such-event'), null);
      assert.strictEqual(next(null, 'close'), null);
      assert.strictEqual(next('idle', null), null);
      assert.strictEqual(next(undefined, 'close'), null);
      assert.strictEqual(next('idle', undefined), null);
      assert.strictEqual(next(1, 'close'), null);
      assert.strictEqual(next('idle', 1), null);
      assert.strictEqual(next({}, 'close'), null);
      assert.strictEqual(next('idle', {}), null);
      assert.strictEqual(next('toString', 'close'), null);
      assert.strictEqual(next('constructor', 'close'), null);
      assert.strictEqual(next('__proto__', 'close'), null);
      assert.strictEqual(next('hasOwnProperty', 'close'), null);
      assert.strictEqual(next('idle', 'toString'), null);
      assert.strictEqual(next('idle', 'constructor'), null);
      assert.strictEqual(next('idle', '__proto__'), null);
      assert.strictEqual(next('idle', 'hasOwnProperty'), null);
    });
  });

  it('all targets are table own states; established entries are only the two verified confirms', () => {
    const table = protocol.CROSS_LAN_SESSION_TRANSITIONS;
    const ownStates = Object.keys(table);
    assert.deepStrictEqual(ownStates.sort(), [
      'closed',
      'established',
      'failed',
      'handshaking',
      'idle',
      'rekeying',
    ].sort());

    /** @type {Array<[string, string, string]>} */
    const edgesIntoEstablished = [];
    for (const state of ownStates) {
      const row = table[state];
      for (const event of Object.keys(row)) {
        const target = row[event];
        assert.ok(
          Object.hasOwn(table, target),
          `target ${target} from ${state}/${event} must be an own table state`,
        );
        if (target === 'established') {
          edgesIntoEstablished.push([state, event, target]);
        }
      }
    }
    assert.deepStrictEqual(edgesIntoEstablished, [
      ['handshaking', 'key-confirmed', 'established'],
      ['rekeying', 'rekey-confirmed', 'established'],
    ]);
  });
});

/**
 * T1.4 pure predicate pin: protocol.isStrictlyForwardSequence(input).
 *
 * Honesty contract (not a complete replay guard):
 * - This is ONLY a pure forward-sequence predicate over a pre-computed
 *   `sessionNonceMatched` flag plus two non-negative bigint counters.
 * - `sessionNonceMatched` MUST be produced by a future runtime secure nonce
 *   byte compare; T1.4 does NOT compare nonce bytes itself.
 * - T1.14 will add receive-window upper bound, uint64 max, and reservation;
 *   this predicate must NOT admit sequence <= highestAcceptedSequence.
 * - No time reads, no state mutation, no persistence, no error codes.
 * - T1.0 Noise library selection gate remains BLOCKED; these tests do not
 *   claim Noise / E2EE / cross-LAN / M1 readiness.
 *
 * GREEN truth (future): true only when input is a plain record,
 * sessionNonceMatched === true, highestAcceptedSequence and sequence are
 * non-negative bigint, and sequence > highestAcceptedSequence; otherwise
 * false without throwing.
 */
describe('strictly-forward sequence predicate (T1.4)', () => {
  it('returns true for matched nonce and bigint strictly-forward sequences (incl. > MAX_SAFE_INTEGER)', () => {
    const fn = protocol.isStrictlyForwardSequence;
    // Small counters.
    assert.strictEqual(
      fn({
        sessionNonceMatched: true,
        highestAcceptedSequence: 0n,
        sequence: 1n,
      }),
      true,
    );
    assert.strictEqual(
      fn({
        sessionNonceMatched: true,
        highestAcceptedSequence: 5n,
        sequence: 6n,
      }),
      true,
    );
    // Prove bigint path (not Number): values above Number.MAX_SAFE_INTEGER.
    const aboveSafe = BigInt(Number.MAX_SAFE_INTEGER) + 10n;
    assert.strictEqual(
      fn({
        sessionNonceMatched: true,
        highestAcceptedSequence: aboveSafe,
        sequence: aboveSafe + 1n,
      }),
      true,
    );
    assert.strictEqual(
      fn({
        sessionNonceMatched: true,
        highestAcceptedSequence: 9007199254740991n, // Number.MAX_SAFE_INTEGER
        sequence: 9007199254740993n, // +2, not representable exactly as Number steps from MAX_SAFE
      }),
      true,
    );
    // null-prototype plain record is still a plain record.
    const nullProto = Object.assign(Object.create(null), {
      sessionNonceMatched: true,
      highestAcceptedSequence: 100n,
      sequence: 101n,
    });
    assert.strictEqual(fn(nullProto), true);
  });

  it('returns false for duplicate/equal and lower (non-forward) sequences', () => {
    const fn = protocol.isStrictlyForwardSequence;
    // Equal / duplicate: sequence === highestAcceptedSequence.
    assert.strictEqual(
      fn({
        sessionNonceMatched: true,
        highestAcceptedSequence: 7n,
        sequence: 7n,
      }),
      false,
    );
    assert.strictEqual(
      fn({
        sessionNonceMatched: true,
        highestAcceptedSequence: 0n,
        sequence: 0n,
      }),
      false,
    );
    // Lower: sequence < highestAcceptedSequence.
    assert.strictEqual(
      fn({
        sessionNonceMatched: true,
        highestAcceptedSequence: 10n,
        sequence: 9n,
      }),
      false,
    );
    assert.strictEqual(
      fn({
        sessionNonceMatched: true,
        highestAcceptedSequence: 9007199254740993n,
        sequence: 9007199254740991n,
      }),
      false,
    );
  });

  it('returns false when sessionNonceMatched is not true even if sequence is forward', () => {
    const fn = protocol.isStrictlyForwardSequence;
    const forward = {
      highestAcceptedSequence: 1n,
      sequence: 2n,
    };
    // Explicit false.
    assert.strictEqual(fn({ ...forward, sessionNonceMatched: false }), false);
    // Missing / undefined.
    assert.strictEqual(fn({ ...forward }), false);
    assert.strictEqual(fn({ ...forward, sessionNonceMatched: undefined }), false);
    // Truthy-but-not-true must not pass (strict === true).
    assert.strictEqual(fn({ ...forward, sessionNonceMatched: 1 }), false);
    assert.strictEqual(fn({ ...forward, sessionNonceMatched: 'true' }), false);
  });

  it('does not read clientTimeUtc: extreme times and throwing getter do not affect pure forward check', () => {
    const fn = protocol.isStrictlyForwardSequence;
    // Extremely old clientTimeUtc + valid forward still true (time is irrelevant).
    assert.strictEqual(
      fn({
        sessionNonceMatched: true,
        highestAcceptedSequence: 0n,
        sequence: 1n,
        clientTimeUtc: 0,
      }),
      true,
    );
    // Extremely new time does not rescue duplicate or nonce mismatch.
    assert.strictEqual(
      fn({
        sessionNonceMatched: true,
        highestAcceptedSequence: 5n,
        sequence: 5n,
        clientTimeUtc: Number.MAX_SAFE_INTEGER,
      }),
      false,
    );
    assert.strictEqual(
      fn({
        sessionNonceMatched: false,
        highestAcceptedSequence: 5n,
        sequence: 6n,
        clientTimeUtc: '9999-12-31T23:59:59.999Z',
      }),
      false,
    );
    // Stronger proof: getter throws if read — call must not throw and must return true.
    const withThrowingTime = {
      sessionNonceMatched: true,
      highestAcceptedSequence: 2n,
      sequence: 3n,
    };
    Object.defineProperty(withThrowingTime, 'clientTimeUtc', {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error(SENTINEL_SECRET);
      },
    });
    let result;
    assert.doesNotThrow(() => {
      result = fn(withThrowingTime);
    });
    assert.strictEqual(result, true);
  });

  it('returns false without throwing for Number/string/negative bigint/null/array/Date/class/throwing Proxy', () => {
    const fn = protocol.isStrictlyForwardSequence;
    const throwingProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error(SENTINEL_SECRET);
        },
        get() {
          throw new Error(SENTINEL_SECRET);
        },
        getOwnPropertyDescriptor() {
          throw new Error(SENTINEL_SECRET);
        },
        getPrototypeOf() {
          throw new Error(SENTINEL_SECRET);
        },
      },
    );

    assert.doesNotThrow(() => {
      // Non-plain / non-record inputs.
      assert.strictEqual(fn(null), false);
      assert.strictEqual(fn([]), false);
      assert.strictEqual(fn(new Date()), false);
      assert.strictEqual(fn(new ExampleClass()), false);
      assert.strictEqual(fn(throwingProxy), false);
      // Number/string counters (must be non-negative bigint).
      assert.strictEqual(
        fn({
          sessionNonceMatched: true,
          highestAcceptedSequence: 0,
          sequence: 1,
        }),
        false,
      );
      assert.strictEqual(
        fn({
          sessionNonceMatched: true,
          highestAcceptedSequence: '0',
          sequence: '1',
        }),
        false,
      );
      assert.strictEqual(
        fn({
          sessionNonceMatched: true,
          highestAcceptedSequence: 0n,
          sequence: 1,
        }),
        false,
      );
      assert.strictEqual(
        fn({
          sessionNonceMatched: true,
          highestAcceptedSequence: 0,
          sequence: 1n,
        }),
        false,
      );
      // Negative bigint counters.
      assert.strictEqual(
        fn({
          sessionNonceMatched: true,
          highestAcceptedSequence: -1n,
          sequence: 0n,
        }),
        false,
      );
      assert.strictEqual(
        fn({
          sessionNonceMatched: true,
          highestAcceptedSequence: 0n,
          sequence: -1n,
        }),
        false,
      );
      assert.strictEqual(
        fn({
          sessionNonceMatched: true,
          highestAcceptedSequence: -5n,
          sequence: -1n,
        }),
        false,
      );
    });
  });
});

/**
 * T1.5 pure profile allowlist: protocol.isAllowedCrossLanProtocolProfile(input).
 *
 * Honesty contract (profile shape only — not runtime/crypto readiness):
 * - T1.0 Noise library selection remains BLOCKED; this predicate only pins
 *   the single allowed cross-LAN protocol profile record shape + values.
 * - Does NOT claim Noise runtime, E2EE crypto, TLS, WSS, or connection ready.
 * - Valid input: ordinary object (prototype Object.prototype or null), own
 *   keys exactly the six string fields below, each an enumerable data
 *   property; reject symbol / non-enumerable / accessor / missing / extra /
 *   type drift. Any throw trap or revoked Proxy → false without throwing.
 * - No cipher / authMode / e2eeLayer fields (those are extras → false).
 *
 * Unique true profile (literals hardcoded here, not from production constants):
 *   noiseSuite: 'Noise_IK_25519_ChaChaPoly_SHA256'
 *   mutualAuthenticationRequired: true
 *   independentE2eeRequired: true
 *   relayTransport: 'wss'
 *   tlsVersion: '1.3'
 *   tcpPort: 443
 */
describe('protocol downgrade profile allowlist (T1.5)', () => {
  /** Fresh exact valid profile — independent per call so tests never share state. */
  function createValidProfile() {
    return {
      noiseSuite: 'Noise_IK_25519_ChaChaPoly_SHA256',
      mutualAuthenticationRequired: true,
      independentE2eeRequired: true,
      relayTransport: 'wss',
      tlsVersion: '1.3',
      tcpPort: 443,
    };
  }

  it('accepts exact ordinary, frozen, and null-prototype profiles; export is a function', () => {
    const fn = protocol.isAllowedCrossLanProtocolProfile;
    assert.strictEqual(typeof fn, 'function');

    assert.strictEqual(fn(createValidProfile()), true);

    const frozen = Object.freeze(createValidProfile());
    assert.strictEqual(fn(frozen), true);

    const nullProto = Object.assign(Object.create(null), createValidProfile());
    assert.strictEqual(fn(nullProto), true);
  });

  it('rejects downgrade paths: suite/auth/e2ee/transport/tls/port variants', () => {
    const fn = protocol.isAllowedCrossLanProtocolProfile;

    // Null / alternate Noise suite and whitespace/case drift.
    assert.strictEqual(fn({ ...createValidProfile(), noiseSuite: null }), false);
    assert.strictEqual(
      fn({ ...createValidProfile(), noiseSuite: 'Noise_XX_25519_ChaChaPoly_SHA256' }),
      false,
    );
    assert.strictEqual(
      fn({ ...createValidProfile(), noiseSuite: ' Noise_IK_25519_ChaChaPoly_SHA256' }),
      false,
    );
    assert.strictEqual(
      fn({ ...createValidProfile(), noiseSuite: 'Noise_IK_25519_ChaChaPoly_SHA256 ' }),
      false,
    );
    assert.strictEqual(
      fn({ ...createValidProfile(), noiseSuite: 'noise_ik_25519_chachapoly_sha256' }),
      false,
    );
    assert.strictEqual(
      fn({ ...createValidProfile(), noiseSuite: 'NOISE_IK_25519_CHACHAPOLY_SHA256' }),
      false,
    );

    // Auth optional and TLS-only (independent E2EE off).
    assert.strictEqual(
      fn({ ...createValidProfile(), mutualAuthenticationRequired: false }),
      false,
    );
    assert.strictEqual(
      fn({ ...createValidProfile(), independentE2eeRequired: false }),
      false,
    );

    // Transport downgrades / case drift.
    assert.strictEqual(fn({ ...createValidProfile(), relayTransport: 'raw' }), false);
    assert.strictEqual(fn({ ...createValidProfile(), relayTransport: 'tls' }), false);
    assert.strictEqual(fn({ ...createValidProfile(), relayTransport: 'ws' }), false);
    assert.strictEqual(fn({ ...createValidProfile(), relayTransport: 'https' }), false);
    assert.strictEqual(fn({ ...createValidProfile(), relayTransport: 'WSS' }), false);

    // TLS version drift.
    assert.strictEqual(fn({ ...createValidProfile(), tlsVersion: '1.2' }), false);
    assert.strictEqual(fn({ ...createValidProfile(), tlsVersion: 1.3 }), false);

    // Port type/value drift.
    assert.strictEqual(fn({ ...createValidProfile(), tcpPort: 8443 }), false);
    assert.strictEqual(fn({ ...createValidProfile(), tcpPort: '443' }), false);
    assert.strictEqual(fn({ ...createValidProfile(), tcpPort: 443n }), false);
  });

  it('rejects missing any of the six fields and known extra keys', () => {
    const fn = protocol.isAllowedCrossLanProtocolProfile;
    const keys = [
      'noiseSuite',
      'mutualAuthenticationRequired',
      'independentE2eeRequired',
      'relayTransport',
      'tlsVersion',
      'tcpPort',
    ];

    for (const key of keys) {
      const missing = createValidProfile();
      delete missing[key];
      assert.strictEqual(fn(missing), false, `missing field: ${key}`);
    }

    const extras = [
      'cipher',
      'authMode',
      'e2eeLayer',
      'spkiPin',
      'sni',
      'fallback',
      'allowInsecure',
    ];
    for (const extra of extras) {
      assert.strictEqual(
        fn({ ...createValidProfile(), [extra]: true }),
        false,
        `extra field: ${extra}`,
      );
    }
  });

  it('rejects non-strict records: symbol, non-enumerable, accessor, non-plain, type drift', () => {
    const fn = protocol.isAllowedCrossLanProtocolProfile;

    // Symbol own key (even with all six string fields present).
    const withSymbol = createValidProfile();
    Object.defineProperty(withSymbol, Symbol('s'), { value: 1, enumerable: true });
    assert.strictEqual(fn(withSymbol), false);

    // Non-enumerable required field.
    const nonEnumField = createValidProfile();
    Object.defineProperty(nonEnumField, 'tcpPort', {
      value: 443,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    assert.strictEqual(fn(nonEnumField), false);

    // Non-enumerable extra key.
    const nonEnumExtra = createValidProfile();
    Object.defineProperty(nonEnumExtra, 'hidden', {
      value: true,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    assert.strictEqual(fn(nonEnumExtra), false);

    // Accessor that returns the correct value must still fail.
    const accessor = createValidProfile();
    Object.defineProperty(accessor, 'noiseSuite', {
      get() {
        return 'Noise_IK_25519_ChaChaPoly_SHA256';
      },
      enumerable: true,
      configurable: true,
    });
    assert.strictEqual(fn(accessor), false);

    // Non-plain / non-ordinary inputs.
    assert.strictEqual(fn([]), false);
    assert.strictEqual(fn(new Map()), false);
    assert.strictEqual(fn(new Set()), false);
    assert.strictEqual(fn(new Date()), false);
    assert.strictEqual(fn(() => {}), false);
    assert.strictEqual(fn(ExampleClass), false);
    assert.strictEqual(fn(new ExampleClass()), false);
    assert.strictEqual(fn(null), false);
    assert.strictEqual(fn(undefined), false);
    assert.strictEqual(fn(true), false);
    assert.strictEqual(fn(false), false);
    assert.strictEqual(fn(0), false);
    assert.strictEqual(fn(443), false);
    assert.strictEqual(fn('wss'), false);
    assert.strictEqual(fn(Object(true)), false);
    assert.strictEqual(fn(Object(443)), false);
    assert.strictEqual(fn(new String('wss')), false);

    // Boolean type drift (truthy but not true).
    assert.strictEqual(
      fn({ ...createValidProfile(), mutualAuthenticationRequired: 1 }),
      false,
    );
    assert.strictEqual(
      fn({ ...createValidProfile(), mutualAuthenticationRequired: 'true' }),
      false,
    );
    assert.strictEqual(
      fn({ ...createValidProfile(), independentE2eeRequired: 1 }),
      false,
    );
    assert.strictEqual(
      fn({ ...createValidProfile(), independentE2eeRequired: 'true' }),
      false,
    );
  });

  it('returns false without throwing for throwing Proxy and revoked Proxy', () => {
    const fn = protocol.isAllowedCrossLanProtocolProfile;

    const throwingProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error(SENTINEL_SECRET);
        },
        get() {
          throw new Error(SENTINEL_SECRET);
        },
        getOwnPropertyDescriptor() {
          throw new Error(SENTINEL_SECRET);
        },
        getPrototypeOf() {
          throw new Error(SENTINEL_SECRET);
        },
      },
    );

    const base = createValidProfile();
    const { proxy: revokedProxy, revoke } = Proxy.revocable(base, {});
    revoke();

    assert.doesNotThrow(() => {
      assert.strictEqual(fn(throwingProxy), false);
      assert.strictEqual(fn(revokedProxy), false);
    });
  });
});

/**
 * T1.6 pure deviceId algebraic consistency: protocol.hasConsistentCrossLanDeviceIds(input).
 *
 * Honesty contract (algebra only — not identity/auth/runtime proof):
 * - T1.0 Noise library selection remains BLOCKED; this predicate only compares
 *   three caller-supplied strings for exact code-unit equality.
 * - Does NOT verify provenance: if a caller copies the same unverified payload
 *   thrice, the result is true but is never a security proof.
 * - Call only after the message is decrypted and messageDeviceId has been
 *   extracted from transcript/AAD/payload; do not call in early handshake
 *   stages that lack messageDeviceId.
 * - Does NOT check enrollmentEpoch / revokeGeneration / trustEpoch, resource
 *   ACL/permissions, or Noise/token/AAD material; not wired to production paths.
 * - resourceDeviceId is intentionally absent; full cross-device resource
 *   authorization remains M3/A15 follow-on.
 * - Transparent Proxy is residual ES risk and is not required to return false.
 *
 * Unique true input: plain record (Object.prototype or null), own enumerable
 * data fields exactly authenticatedDeviceId / sessionDeviceId / messageDeviceId,
 * each a primitive non-empty string, all three exact-equal (no trim/normalize/
 * case-fold/coerce). Otherwise false without throwing.
 */
describe('cross-LAN deviceId consistency contract (T1.6)', () => {
  /** Fresh exact valid triple — independent per call so tests never share state. */
  function createValidDeviceIdRecord() {
    return {
      authenticatedDeviceId: 'device-A',
      sessionDeviceId: 'device-A',
      messageDeviceId: 'device-A',
    };
  }

  it('export is function; ordinary, frozen, null-proto exact records true; no trim/normalize', () => {
    const fn = protocol.hasConsistentCrossLanDeviceIds;
    assert.strictEqual(typeof fn, 'function');

    assert.strictEqual(fn(createValidDeviceIdRecord()), true);

    const frozen = Object.freeze(createValidDeviceIdRecord());
    assert.strictEqual(fn(frozen), true);

    const nullProto = Object.assign(Object.create(null), createValidDeviceIdRecord());
    assert.strictEqual(fn(nullProto), true);

    // Identical non-empty Unicode + surrounding spaces: exact equality only; no trim/normalize.
    const spacedUnicode = '  device-\u03b1  ';
    assert.strictEqual(
      fn({
        authenticatedDeviceId: spacedUnicode,
        sessionDeviceId: spacedUnicode,
        messageDeviceId: spacedUnicode,
      }),
      true,
    );
  });

  it('rejects A15 dual-fixture mismatches and case/space/Unicode drifts', () => {
    const fn = protocol.hasConsistentCrossLanDeviceIds;

    // Dual-fixture A15: each single field swapped to device-B → false.
    assert.strictEqual(
      fn({
        authenticatedDeviceId: 'device-B',
        sessionDeviceId: 'device-A',
        messageDeviceId: 'device-A',
      }),
      false,
    );
    assert.strictEqual(
      fn({
        authenticatedDeviceId: 'device-A',
        sessionDeviceId: 'device-B',
        messageDeviceId: 'device-A',
      }),
      false,
    );
    assert.strictEqual(
      fn({
        authenticatedDeviceId: 'device-A',
        sessionDeviceId: 'device-A',
        messageDeviceId: 'device-B',
      }),
      false,
    );

    // Case drift (no case-fold).
    assert.strictEqual(
      fn({
        authenticatedDeviceId: 'device-A',
        sessionDeviceId: 'device-A',
        messageDeviceId: 'Device-A',
      }),
      false,
    );
    assert.strictEqual(
      fn({
        authenticatedDeviceId: 'device-A',
        sessionDeviceId: 'DEVICE-A',
        messageDeviceId: 'device-A',
      }),
      false,
    );

    // Trailing / surrounding space drift (no trim).
    assert.strictEqual(
      fn({
        authenticatedDeviceId: 'device-A',
        sessionDeviceId: 'device-A',
        messageDeviceId: 'device-A ',
      }),
      false,
    );
    assert.strictEqual(
      fn({
        authenticatedDeviceId: ' device-A',
        sessionDeviceId: 'device-A',
        messageDeviceId: 'device-A',
      }),
      false,
    );

    // Unicode composed vs decomposed (no NFC/NFD normalize).
    const composed = 'device-\u00e9'; // e acute precomposed
    const decomposed = 'device-e\u0301'; // e + combining acute
    assert.strictEqual(
      fn({
        authenticatedDeviceId: composed,
        sessionDeviceId: composed,
        messageDeviceId: decomposed,
      }),
      false,
    );
    assert.strictEqual(
      fn({
        authenticatedDeviceId: decomposed,
        sessionDeviceId: composed,
        messageDeviceId: composed,
      }),
      false,
    );
  });

  it('rejects empty strings and type drift on any of the three fields', () => {
    const fn = protocol.hasConsistentCrossLanDeviceIds;

    // Any single field empty string.
    for (const key of ['authenticatedDeviceId', 'sessionDeviceId', 'messageDeviceId']) {
      const emptyOne = createValidDeviceIdRecord();
      emptyOne[key] = '';
      assert.strictEqual(fn(emptyOne), false, `empty string field: ${key}`);
    }

    // All three empty still false (not "consistent empties").
    assert.strictEqual(
      fn({
        authenticatedDeviceId: '',
        sessionDeviceId: '',
        messageDeviceId: '',
      }),
      false,
    );

    // Type drift per field: undefined/null/number/boolean/String object/array/object.
    const drifts = [
      undefined,
      null,
      0,
      1,
      true,
      false,
      new String('device-A'),
      ['device-A'],
      { id: 'device-A' },
    ];
    for (const key of ['authenticatedDeviceId', 'sessionDeviceId', 'messageDeviceId']) {
      for (const bad of drifts) {
        const rec = createValidDeviceIdRecord();
        rec[key] = bad;
        assert.strictEqual(
          fn(rec),
          false,
          `type drift on ${key}: ${Object.prototype.toString.call(bad)}`,
        );
      }
    }
  });

  it('rejects non-exact records: missing, extra, symbol, non-enumerable, accessor, non-plain', () => {
    const fn = protocol.hasConsistentCrossLanDeviceIds;

    // Missing each required field.
    for (const key of ['authenticatedDeviceId', 'sessionDeviceId', 'messageDeviceId']) {
      const missing = createValidDeviceIdRecord();
      delete missing[key];
      assert.strictEqual(fn(missing), false, `missing field: ${key}`);
    }

    // Extra own enumerable key.
    assert.strictEqual(
      fn({ ...createValidDeviceIdRecord(), resourceDeviceId: 'device-A' }),
      false,
    );
    assert.strictEqual(fn({ ...createValidDeviceIdRecord(), extra: true }), false);

    // Symbol own key (even with all three string fields present).
    const withSymbol = createValidDeviceIdRecord();
    Object.defineProperty(withSymbol, Symbol('s'), { value: 1, enumerable: true });
    assert.strictEqual(fn(withSymbol), false);

    // Required field non-enumerable.
    const nonEnumField = createValidDeviceIdRecord();
    Object.defineProperty(nonEnumField, 'messageDeviceId', {
      value: 'device-A',
      enumerable: false,
      configurable: true,
      writable: true,
    });
    assert.strictEqual(fn(nonEnumField), false);

    // Non-enumerable extra key.
    const nonEnumExtra = createValidDeviceIdRecord();
    Object.defineProperty(nonEnumExtra, 'hidden', {
      value: true,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    assert.strictEqual(fn(nonEnumExtra), false);

    // Accessor returning the correct value must still fail.
    const accessor = createValidDeviceIdRecord();
    Object.defineProperty(accessor, 'authenticatedDeviceId', {
      get() {
        return 'device-A';
      },
      enumerable: true,
      configurable: true,
    });
    assert.strictEqual(fn(accessor), false);

    // Non-plain / non-ordinary inputs.
    assert.strictEqual(fn([]), false);
    assert.strictEqual(fn(new Map()), false);
    assert.strictEqual(fn(new Set()), false);
    assert.strictEqual(fn(new Date()), false);
    assert.strictEqual(fn(() => {}), false);
    assert.strictEqual(fn(ExampleClass), false);
    assert.strictEqual(fn(new ExampleClass()), false);
    assert.strictEqual(fn(null), false);
    assert.strictEqual(fn(undefined), false);
    assert.strictEqual(fn(true), false);
    assert.strictEqual(fn(false), false);
    assert.strictEqual(fn(0), false);
    assert.strictEqual(fn(1), false);
    assert.strictEqual(fn('device-A'), false);
    assert.strictEqual(fn(Object(true)), false);
    assert.strictEqual(fn(new String('device-A')), false);
  });

  it('returns false without throwing for throwing Proxy and revoked Proxy', () => {
    const fn = protocol.hasConsistentCrossLanDeviceIds;

    const throwingProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error(SENTINEL_SECRET);
        },
        get() {
          throw new Error(SENTINEL_SECRET);
        },
        getOwnPropertyDescriptor() {
          throw new Error(SENTINEL_SECRET);
        },
        getPrototypeOf() {
          throw new Error(SENTINEL_SECRET);
        },
      },
    );

    const base = createValidDeviceIdRecord();
    const { proxy: revokedProxy, revoke } = Proxy.revocable(base, {});
    revoke();

    assert.doesNotThrow(() => {
      assert.strictEqual(fn(throwingProxy), false);
      assert.strictEqual(fn(revokedProxy), false);
    });
  });
});

/**
 * T1.7 pure clock-skew policy + configuration resolver + window predicate.
 *
 * Honesty contract (auxiliary time gate only — not replay/auth readiness):
 * - Explicit time inputs only: does NOT read Date.now / clientTimeUtc.
 * - Does NOT verify provenance / AAD / signatures; does NOT calibrate clocks.
 * - Time window is an auxiliary gate; nonce/seq remain the primary anti-replay
 *   defense (compose with isStrictlyForwardSequence in callers — no production
 *   combinator is exported here).
 * - T1.0 Noise library selection remains BLOCKED; these tests do not wire
 *   production handshake or claim Noise / E2EE / cross-LAN readiness.
 * - When configurationAccepted is false, a future caller MUST report/reject
 *   the bad config before falling back to the default; usedDefault alone must
 *   not be treated as silent acceptance. T1.7 only freezes that responsibility.
 *
 * Frozen production API:
 * - CROSS_LAN_CLOCK_SKEW_POLICY: { defaultSeconds, minSeconds, maxSeconds, errorCode }
 * - resolveCrossLanClockSkewConfiguration(configuredSeconds) → frozen decision
 * - isWithinCrossLanClockSkew(input) → true/false, never throws
 *
 * Expected numeric pins below are independent literals — never derived from
 * the policy export (single-source production, dual-source test verification).
 */
describe('cross-LAN clock skew policy contract (T1.7)', () => {
  /** Independent expected pins — must not be read from policy export. */
  const EXPECTED_DEFAULT_SECONDS = 120;
  const EXPECTED_MIN_SECONDS = 30;
  const EXPECTED_MAX_SECONDS = 600;
  const EXPECTED_ERROR_CODE = ERROR_CODES.DEVICE_CLOCK_SKEW;

  const EXPECTED_POLICY = {
    defaultSeconds: EXPECTED_DEFAULT_SECONDS,
    minSeconds: EXPECTED_MIN_SECONDS,
    maxSeconds: EXPECTED_MAX_SECONDS,
    errorCode: EXPECTED_ERROR_CODE,
  };

  const EXPECTED_DEFAULT_DECISION = Object.freeze({
    configurationAccepted: true,
    usedDefault: true,
    allowedSkewSeconds: EXPECTED_DEFAULT_SECONDS,
  });

  const EXPECTED_INVALID_DECISION = Object.freeze({
    configurationAccepted: false,
    usedDefault: true,
    allowedSkewSeconds: EXPECTED_DEFAULT_SECONDS,
  });

  /**
   * Fresh exact valid skew input — independent per call so tests never share state.
   * @param {{ endpointTimeUtcMs?: number, controllerTimeUtcMs?: number, allowedSkewSeconds?: number }} [overrides]
   */
  function createValidSkewInput(overrides = {}) {
    return {
      endpointTimeUtcMs: 1_700_000_000_000,
      controllerTimeUtcMs: 1_700_000_000_000,
      allowedSkewSeconds: EXPECTED_DEFAULT_SECONDS,
      ...overrides,
    };
  }

  /**
   * @param {{ configurationAccepted: boolean, usedDefault: boolean, allowedSkewSeconds: number }} decision
   * @param {{ configurationAccepted: boolean, usedDefault: boolean, allowedSkewSeconds: number }} expected
   */
  function assertExactFrozenDecision(decision, expected) {
    assert.deepStrictEqual(decision, expected);
    assert.ok(Object.isFrozen(decision), 'decision must be frozen');
    // Legal-state invariant: accepted implies usedDefault only when falling back is not the path
    // for accepted configs that pin an explicit value (usedDefault false). Rejected configs must
    // always usedDefault true with the default seconds. Unreachable (false, false) never appears.
    if (decision.configurationAccepted === false) {
      assert.strictEqual(decision.usedDefault, true);
      assert.strictEqual(decision.allowedSkewSeconds, EXPECTED_DEFAULT_SECONDS);
    }
    assert.notDeepStrictEqual(
      { configurationAccepted: decision.configurationAccepted, usedDefault: decision.usedDefault },
      { configurationAccepted: false, usedDefault: false },
    );
  }

  it('pins CROSS_LAN_CLOCK_SKEW_POLICY exact four fields, frozen, single-source errorCode', () => {
    const policy = protocol.CROSS_LAN_CLOCK_SKEW_POLICY;
    assert.notStrictEqual(policy, undefined, 'export must exist');
    assert.deepStrictEqual(policy, EXPECTED_POLICY);
    assert.ok(Object.isFrozen(policy));
    assert.strictEqual(policy.errorCode, ERROR_CODES.DEVICE_CLOCK_SKEW);
    assert.strictEqual(policy.errorCode, EXPECTED_ERROR_CODE);
    assert.strictEqual(Object.keys(policy).length, 4);
  });

  it('resolveCrossLanClockSkewConfiguration accepted triad: undefined / explicit 120 / bounds / mid', () => {
    const resolve = protocol.resolveCrossLanClockSkewConfiguration;
    assert.strictEqual(typeof resolve, 'function');

    // undefined → accepted default; each call returns a fresh frozen object.
    const firstUndefinedDecision = resolve(undefined);
    const secondUndefinedDecision = resolve(undefined);
    assertExactFrozenDecision(firstUndefinedDecision, EXPECTED_DEFAULT_DECISION);
    assertExactFrozenDecision(secondUndefinedDecision, EXPECTED_DEFAULT_DECISION);
    assert.notStrictEqual(firstUndefinedDecision, secondUndefinedDecision);

    // Explicit 120 must be accepted with usedDefault=false (not treated as "default path").
    assertExactFrozenDecision(
      resolve(120),
      Object.freeze({
        configurationAccepted: true,
        usedDefault: false,
        allowedSkewSeconds: 120,
      }),
    );

    // Inclusive bounds 30 and 600, plus a mid value 60.
    assertExactFrozenDecision(
      resolve(30),
      Object.freeze({
        configurationAccepted: true,
        usedDefault: false,
        allowedSkewSeconds: 30,
      }),
    );
    assertExactFrozenDecision(
      resolve(600),
      Object.freeze({
        configurationAccepted: true,
        usedDefault: false,
        allowedSkewSeconds: 600,
      }),
    );
    assertExactFrozenDecision(
      resolve(60),
      Object.freeze({
        configurationAccepted: true,
        usedDefault: false,
        allowedSkewSeconds: 60,
      }),
    );
  });

  it('resolveCrossLanClockSkewConfiguration invalid inputs fall back frozen {false,true,120}', () => {
    const resolve = protocol.resolveCrossLanClockSkewConfiguration;
    assert.strictEqual(typeof resolve, 'function');

    const throwingNumberProxy = new Proxy(new Number(120), {
      get() {
        throw new Error(SENTINEL_SECRET);
      },
      getOwnPropertyDescriptor() {
        throw new Error(SENTINEL_SECRET);
      },
      ownKeys() {
        throw new Error(SENTINEL_SECRET);
      },
      getPrototypeOf() {
        throw new Error(SENTINEL_SECRET);
      },
    });

    const invalidInputs = [
      29,
      601,
      30.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      '120',
      120n,
      null,
      true,
      Symbol('120'),
      { value: 120 },
      [120],
      new Number(120),
      throwingNumberProxy,
    ];

    for (const bad of invalidInputs) {
      let decision;
      assert.doesNotThrow(() => {
        decision = resolve(bad);
      }, 'must not throw for invalid configuredSeconds input');
      assertExactFrozenDecision(decision, EXPECTED_INVALID_DECISION);
    }

    // Unreachable (false, false) never appears across the invalid matrix.
    for (const bad of invalidInputs) {
      const decision = resolve(bad);
      assert.notStrictEqual(
        decision.configurationAccepted === false && decision.usedDefault === false,
        true,
        'unreachable (configurationAccepted:false, usedDefault:false) must never appear',
      );
    }
  });

  it('isWithinCrossLanClockSkew numeric boundaries at default/min/max and epoch extremes', () => {
    const fn = protocol.isWithinCrossLanClockSkew;
    assert.strictEqual(typeof fn, 'function');

    const baseMs = 1_700_000_000_000;

    // Zero difference with default allowed.
    assert.strictEqual(
      fn(
        createValidSkewInput({
          endpointTimeUtcMs: baseMs,
          controllerTimeUtcMs: baseMs,
          allowedSkewSeconds: 120,
        }),
      ),
      true,
    );

    // Default 120s window: ±119999 / ±120000 true; ±120001 / ±121000 false.
    for (const delta of [119_999, 120_000, -119_999, -120_000]) {
      assert.strictEqual(
        fn(
          createValidSkewInput({
            endpointTimeUtcMs: baseMs + delta,
            controllerTimeUtcMs: baseMs,
            allowedSkewSeconds: 120,
          }),
        ),
        true,
        `default window should accept delta=${delta}`,
      );
    }
    for (const delta of [120_001, 121_000, -120_001, -121_000]) {
      assert.strictEqual(
        fn(
          createValidSkewInput({
            endpointTimeUtcMs: baseMs + delta,
            controllerTimeUtcMs: baseMs,
            allowedSkewSeconds: 120,
          }),
        ),
        false,
        `default window should reject delta=${delta}`,
      );
    }

    // Min 30s: ±29999 / ±30000 true; ±30001 false.
    for (const delta of [29_999, 30_000, -29_999, -30_000]) {
      assert.strictEqual(
        fn(
          createValidSkewInput({
            endpointTimeUtcMs: baseMs + delta,
            controllerTimeUtcMs: baseMs,
            allowedSkewSeconds: 30,
          }),
        ),
        true,
        `min window should accept delta=${delta}`,
      );
    }
    for (const delta of [30_001, -30_001]) {
      assert.strictEqual(
        fn(
          createValidSkewInput({
            endpointTimeUtcMs: baseMs + delta,
            controllerTimeUtcMs: baseMs,
            allowedSkewSeconds: 30,
          }),
        ),
        false,
        `min window should reject delta=${delta}`,
      );
    }

    // Max 600s: ±599999 / ±600000 true; ±600001 false.
    for (const delta of [599_999, 600_000, -599_999, -600_000]) {
      assert.strictEqual(
        fn(
          createValidSkewInput({
            endpointTimeUtcMs: baseMs + delta,
            controllerTimeUtcMs: baseMs,
            allowedSkewSeconds: 600,
          }),
        ),
        true,
        `max window should accept delta=${delta}`,
      );
    }
    for (const delta of [600_001, -600_001]) {
      assert.strictEqual(
        fn(
          createValidSkewInput({
            endpointTimeUtcMs: baseMs + delta,
            controllerTimeUtcMs: baseMs,
            allowedSkewSeconds: 600,
          }),
        ),
        false,
        `max window should reject delta=${delta}`,
      );
    }

    // Negative epoch values are allowed (no extra rejection); window still applies.
    assert.strictEqual(
      fn(
        createValidSkewInput({
          endpointTimeUtcMs: -10_000,
          controllerTimeUtcMs: -40_000,
          allowedSkewSeconds: 30,
        }),
      ),
      true,
    );
    assert.strictEqual(
      fn(
        createValidSkewInput({
          endpointTimeUtcMs: -10_000,
          controllerTimeUtcMs: -40_001,
          allowedSkewSeconds: 30,
        }),
      ),
      false,
    );

    // MAX_SAFE_INTEGER same → true; MAX_SAFE vs MIN_SAFE → false (out of any allowed window).
    assert.strictEqual(
      fn(
        createValidSkewInput({
          endpointTimeUtcMs: Number.MAX_SAFE_INTEGER,
          controllerTimeUtcMs: Number.MAX_SAFE_INTEGER,
          allowedSkewSeconds: 30,
        }),
      ),
      true,
    );
    assert.strictEqual(
      fn(
        createValidSkewInput({
          endpointTimeUtcMs: Number.MAX_SAFE_INTEGER,
          controllerTimeUtcMs: Number.MIN_SAFE_INTEGER,
          allowedSkewSeconds: 600,
        }),
      ),
      false,
    );

    // null-prototype exact valid record must still accept.
    assert.strictEqual(
      fn(Object.assign(Object.create(null), createValidSkewInput())),
      true,
    );
  });

  it('isWithinCrossLanClockSkew exact-record/type/no-throw; does not read Date.now', (t) => {
    const fn = protocol.isWithinCrossLanClockSkew;
    assert.strictEqual(typeof fn, 'function');

    // Missing each required field.
    for (const key of ['endpointTimeUtcMs', 'controllerTimeUtcMs', 'allowedSkewSeconds']) {
      const missing = createValidSkewInput();
      delete missing[key];
      assert.strictEqual(fn(missing), false, `missing field: ${key}`);
    }

    // Extra own enumerable key — including throwing getter clientTimeUtc:
    // must reject for extra without reading the getter (no throw).
    const extraClientTime = createValidSkewInput();
    Object.defineProperty(extraClientTime, 'clientTimeUtc', {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error(SENTINEL_SECRET);
      },
    });
    let extraResult;
    assert.doesNotThrow(() => {
      extraResult = fn(extraClientTime);
    });
    assert.strictEqual(extraResult, false);
    assert.strictEqual(fn({ ...createValidSkewInput(), extra: true }), false);

    // Symbol own key.
    const withSymbol = createValidSkewInput();
    Object.defineProperty(withSymbol, Symbol('s'), { value: 1, enumerable: true });
    assert.strictEqual(fn(withSymbol), false);

    // Non-enumerable required field.
    const nonEnumRequired = createValidSkewInput();
    Object.defineProperty(nonEnumRequired, 'allowedSkewSeconds', {
      value: 120,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    assert.strictEqual(fn(nonEnumRequired), false);

    // Non-enumerable extra key.
    const nonEnumExtra = createValidSkewInput();
    Object.defineProperty(nonEnumExtra, 'hidden', {
      value: true,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    assert.strictEqual(fn(nonEnumExtra), false);

    // Accessor returning a correct value must still fail (data fields only).
    const accessor = createValidSkewInput();
    Object.defineProperty(accessor, 'endpointTimeUtcMs', {
      get() {
        return 1_700_000_000_000;
      },
      enumerable: true,
      configurable: true,
    });
    assert.strictEqual(fn(accessor), false);

    // Non-plain / non-ordinary / primitive inputs.
    assert.strictEqual(fn(new ExampleClass()), false);
    assert.strictEqual(fn([]), false);
    assert.strictEqual(fn(new Date()), false);
    assert.strictEqual(fn(null), false);
    assert.strictEqual(fn(undefined), false);
    assert.strictEqual(fn(true), false);
    assert.strictEqual(fn(0), false);
    assert.strictEqual(fn('skew'), false);

    // Time field type/safety drift.
    assert.strictEqual(
      fn(createValidSkewInput({ endpointTimeUtcMs: '1700000000000' })),
      false,
    );
    assert.strictEqual(fn(createValidSkewInput({ endpointTimeUtcMs: 1_700_000_000_000n })), false);
    assert.strictEqual(
      fn(createValidSkewInput({ endpointTimeUtcMs: Number.MAX_SAFE_INTEGER + 1 })),
      false,
    );
    assert.strictEqual(fn(createValidSkewInput({ controllerTimeUtcMs: Number.NaN })), false);
    assert.strictEqual(
      fn(createValidSkewInput({ controllerTimeUtcMs: Number.POSITIVE_INFINITY })),
      false,
    );
    assert.strictEqual(
      fn(createValidSkewInput({ controllerTimeUtcMs: Number.NEGATIVE_INFINITY })),
      false,
    );

    // allowedSkewSeconds out of range / type drift.
    assert.strictEqual(fn(createValidSkewInput({ allowedSkewSeconds: 29 })), false);
    assert.strictEqual(fn(createValidSkewInput({ allowedSkewSeconds: 601 })), false);
    assert.strictEqual(fn(createValidSkewInput({ allowedSkewSeconds: 30.5 })), false);
    assert.strictEqual(fn(createValidSkewInput({ allowedSkewSeconds: '120' })), false);

    // Throwing Proxy + revoked Proxy → false without throwing.
    const throwingProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error(SENTINEL_SECRET);
        },
        get() {
          throw new Error(SENTINEL_SECRET);
        },
        getOwnPropertyDescriptor() {
          throw new Error(SENTINEL_SECRET);
        },
        getPrototypeOf() {
          throw new Error(SENTINEL_SECRET);
        },
      },
    );
    const base = createValidSkewInput();
    const { proxy: revokedProxy, revoke } = Proxy.revocable(base, {});
    revoke();
    assert.doesNotThrow(() => {
      assert.strictEqual(fn(throwingProxy), false);
      assert.strictEqual(fn(revokedProxy), false);
    });

    // Prove no Date.now read: mock throws if touched; valid call must still return true.
    t.mock.method(Date, 'now', () => {
      throw new Error(SENTINEL_SECRET);
    });
    let validWhileMocked;
    assert.doesNotThrow(() => {
      validWhileMocked = fn(createValidSkewInput());
    });
    assert.strictEqual(validWhileMocked, true);
    // Transparent Proxy residual risk is not required to return false.
  });

  it('replay independence truth table: only clock-inside AND seq-forward passes', () => {
    const clockFn = protocol.isWithinCrossLanClockSkew;
    const seqFn = protocol.isStrictlyForwardSequence;
    assert.strictEqual(typeof clockFn, 'function');
    assert.strictEqual(typeof seqFn, 'function');

    const baseMs = 1_700_000_000_000;

    // Clock inside default 120s window.
    const clockInside = createValidSkewInput({
      endpointTimeUtcMs: baseMs + 60_000,
      controllerTimeUtcMs: baseMs,
      allowedSkewSeconds: 120,
    });
    // Clock outside default 120s window.
    const clockOutside = createValidSkewInput({
      endpointTimeUtcMs: baseMs + 121_000,
      controllerTimeUtcMs: baseMs,
      allowedSkewSeconds: 120,
    });

    const seqForward = {
      sessionNonceMatched: true,
      highestAcceptedSequence: 0n,
      sequence: 1n,
    };
    const seqDuplicate = {
      sessionNonceMatched: true,
      highestAcceptedSequence: 5n,
      sequence: 5n,
    };

    const clockTrue = clockFn(clockInside);
    const clockFalse = clockFn(clockOutside);
    const seqTrue = seqFn(seqForward);
    const seqFalse = seqFn(seqDuplicate);

    assert.strictEqual(clockTrue, true);
    assert.strictEqual(clockFalse, false);
    assert.strictEqual(seqTrue, true);
    assert.strictEqual(seqFalse, false);

    // Four-cell truth table (test composition only — no production combinator).
    assert.strictEqual(clockTrue && seqTrue, true, 'inside + forward must pass');
    assert.strictEqual(clockFalse && seqTrue, false, 'outside + forward must fail');
    assert.strictEqual(clockTrue && seqFalse, false, 'inside + duplicate must fail');
    assert.strictEqual(clockFalse && seqFalse, false, 'outside + duplicate must fail');
  });
});
