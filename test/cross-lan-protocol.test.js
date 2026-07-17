import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  CONTROL_PLANE_MESSAGE_SCHEMAS,
  DENYLIST_ENTRY_SCHEMA,
  hasExactControlPlaneMessageFields,
  hasExactDenylistEntryFields,
} from '../src/cross-lan-protocol.js';
// Namespace import so missing T1.3/T1.4/T1.7 named exports do not break T1.2 load-time.
import * as protocol from '../src/cross-lan-protocol.js';
import { ERROR_CODES } from '../src/error-codes.js';

/** Promisified execFile for isolated Node subprocess checks (T1.8). */
const execFileAsync = promisify(execFile);

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
 * - T1.5 downgrade matrix also underpins T1.11 trust-boundary traceability.
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

  // T1.11: canonical behavior anchor only — does not prove the relay did not
  // participate in endpoint↔controller KE/KDF at runtime.
  it('T1.11: full canonical wss/TLS1.3/443/mutualAuth; independentE2ee false→false, true→true', () => {
    const fn = protocol.isAllowedCrossLanProtocolProfile;
    const canonical = {
      noiseSuite: 'Noise_IK_25519_ChaChaPoly_SHA256',
      mutualAuthenticationRequired: true,
      independentE2eeRequired: false,
      relayTransport: 'wss',
      tlsVersion: '1.3',
      tcpPort: 443,
    };
    assert.strictEqual(fn(canonical), false);
    assert.strictEqual(fn({ ...canonical, independentE2eeRequired: true }), true);
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

/**
 * T1.8 — cross-LAN session construction must not call lifecycle execute/authorize paths.
 *
 * Current evidence scope (M1 scaffold only; honest bounds):
 * - Declared constant contract: `CROSS_LAN_SESSION_CONSTRUCTION_BOUNDARY` (all false, frozen).
 * - Semantic static import graph of `src/cross-lan-protocol.js` (SourceTextModule).
 * - Namespace export surface isolation (no lifecycle function names re-exported).
 *
 * This does **not** prove future M2/M3 session-builder zero runtime calls.
 * T1.0 Noise library selection remains BLOCKED; no real session builder exists.
 * When a builder appears, DI / call-count sentinels must cover happy + failure paths.
 * Do not invent a fake builder or a no-DI throwing sentinel here.
 */
describe('cross-LAN session construction lifecycle isolation (T1.8)', () => {
  const EXPECTED_CONSTRUCTION_BOUNDARY = Object.freeze({
    executeSupervisorLifecycleApplyAllowed: false,
    evaluateSupervisorLifecycleGuardedRunnerExecutionPolicyAllowed: false,
    buildSupervisorLifecycleGuardedRunnerExecutionGateAllowed: false,
    authorizeSupervisorLifecycleGuardedRunnerCapabilityModeAllowed: false,
  });

  const LIFECYCLE_FUNCTION_NAMES = Object.freeze([
    'executeSupervisorLifecycleApply',
    'evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy',
    'buildSupervisorLifecycleGuardedRunnerExecutionGate',
    'authorizeSupervisorLifecycleGuardedRunnerCapabilityMode',
  ]);

  /**
   * RED until production exports the frozen all-false construction boundary.
   * Missing export is the sole intentional RED under current M1 scaffold.
   */
  it('exports frozen CROSS_LAN_SESSION_CONSTRUCTION_BOUNDARY with exact four all-false flags', () => {
    const boundary = protocol.CROSS_LAN_SESSION_CONSTRUCTION_BOUNDARY;
    assert.notStrictEqual(
      boundary,
      undefined,
      'protocol.CROSS_LAN_SESSION_CONSTRUCTION_BOUNDARY must be exported (T1.8 RED if missing)',
    );
    assert.deepStrictEqual(boundary, EXPECTED_CONSTRUCTION_BOUNDARY);
    assert.strictEqual(Object.keys(boundary).length, 4);
    assert.ok(Object.isFrozen(boundary), 'boundary object must be frozen');

    for (const key of Object.keys(EXPECTED_CONSTRUCTION_BOUNDARY)) {
      assert.strictEqual(boundary[key], false, `${key} must be strict false`);
    }

    // ESM is strict mode: frozen assignment throws (do not rely on silent/sloppy mutation).
    for (const key of Object.keys(EXPECTED_CONSTRUCTION_BOUNDARY)) {
      assert.throws(() => {
        boundary[key] = true;
      }, TypeError);
      assert.strictEqual(boundary[key], false, `${key} must remain false after failed assign`);
    }
    assert.ok(Object.isFrozen(boundary), 'boundary must remain frozen after assign attempts');
    assert.deepStrictEqual(boundary, EXPECTED_CONSTRUCTION_BOUNDARY);
  });

  /**
   * GREEN baseline: real syntax/static import graph via isolated SourceTextModule.
   * Proves only that the protocol module's static import graph is exactly
   * `./error-codes.js` (evaluation) and has no direct dynamic load / child_process
   * surface in source text. Not a future runtime zero-call proof.
   */
  it('static import graph is only evaluation of ./error-codes.js (SourceTextModule baseline)', async () => {
    const sourceUrl = new URL('../src/cross-lan-protocol.js', import.meta.url);
    const sourcePathHref = sourceUrl.href;

    // Parent-side source text negative surface (read-only; never print body).
    const sourceText = await readFile(sourceUrl, 'utf8');
    assert.ok(!sourceText.includes('import('), 'source must not contain direct dynamic import(');
    assert.ok(!sourceText.includes('require('), 'source must not contain require(');
    assert.ok(!sourceText.includes('eval('), 'source must not contain eval(');
    assert.ok(!sourceText.includes('new Function'), 'source must not contain new Function');
    assert.ok(
      !sourceText.includes('node:child_process'),
      'source must not reference node:child_process',
    );

    // Isolated Node: real moduleRequest parse via vm.SourceTextModule (not regex).
    const childScript = [
      "import vm from 'node:vm';",
      "import { readFile } from 'node:fs/promises';",
      'const source = await readFile(new URL(process.argv[1]), "utf8");',
      'const mod = new vm.SourceTextModule(source);',
      'const moduleRequests = mod.moduleRequests.map((r) => ({',
      '  specifier: r.specifier,',
      '  phase: r.phase,',
      '}));',
      'process.stdout.write(JSON.stringify(moduleRequests));',
    ].join('\n');

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        '--no-warnings',
        '--experimental-vm-modules',
        '--input-type=module',
        '-e',
        childScript,
        sourcePathHref,
      ],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );

    assert.strictEqual(stderr, '', 'isolated import-graph child stderr must be empty');
    const parsed = JSON.parse(stdout);
    assert.deepStrictEqual(parsed, [{ specifier: './error-codes.js', phase: 'evaluation' }]);
  });

  /**
   * GREEN baseline: namespace export isolation + residual pure FSM smoke.
   * Confirms lifecycle function originals are not re-exported from protocol, and
   * idle → handshaking still works. Does **not** prove future builder zero-call.
   */
  it('namespace excludes lifecycle execute/authorize names; pure FSM idle→handshaking still works', () => {
    const exportNames = Object.keys(protocol);

    for (const name of LIFECYCLE_FUNCTION_NAMES) {
      assert.ok(
        !exportNames.includes(name),
        `protocol namespace must not export lifecycle function ${name}`,
      );
    }

    const forbiddenTopLevel = /^(execute|authorize|evaluateSupervisorLifecycle|buildSupervisorLifecycleGuardedRunnerExecutionGate)/;
    for (const name of exportNames) {
      assert.ok(
        !forbiddenTopLevel.test(name),
        `protocol top-level export must not match lifecycle isolation pattern: ${name}`,
      );
    }

    // Residual pure FSM contract still holds (scaffold smoke only).
    assert.strictEqual(
      protocol.getNextCrossLanSessionState('idle', 'start-handshake'),
      'handshaking',
    );
  });
});

/**
 * T1.9 pure capacity / keepalive / data-resume policy contracts only.
 *
 * Honesty / scope (PM final adjudication for M1 T1.9):
 * - Pure frozen constants + pure configuration resolvers + pure liveness
 *   classification / timeout decision only.
 * - Does NOT implement timers, sockets, random/jitter scheduling, sleep,
 *   persistence, token buckets, queue runtime, reconnect loops, or any
 *   production session wiring.
 * - T1.0 Noise library selection gate remains BLOCKED. These tests do not
 *   claim Noise / E2EE / cross-LAN / M1 / session-runtime readiness.
 * - `configurationAccepted: false` means the configured value was rejected;
 *   a future caller MUST report/reject bad config before using the fallback.
 * - For keepalive timeout: only `inputAccepted:true && shouldDisconnect:true`
 *   may map to SESSION_KEEPALIVE_TIMEOUT in a future runtime. Invalid input
 *   conservatively disconnects but must NOT be disguised as that error code.
 * - Transparent Proxy residual risk is not required to return reject; pure
 *   ECMAScript cannot reliably detect transparent Proxies.
 *
 * Expected numeric pins below are independent literals — never derived from
 * the production policy exports (single-source production, dual-source test).
 */
describe('cross-LAN capacity / keepalive / data-resume policy (T1.9)', () => {
  // --- Independent expected pins (literals only; not read from production) ---

  const EXPECTED_CAPACITY_POLICY = Object.freeze({
    controlQueue: Object.freeze({
      defaultMessageCountPerDevice: 256,
      hardCeilingMessageCountPerDevice: 1024,
      defaultTotalBytesPerDevice: 1_048_576,
      hardCeilingTotalBytesPerDevice: 4_194_304,
      maximumMessageBytes: 65_536,
      overflowErrorCode: ERROR_CODES.CONTROL_QUEUE_OVERFLOW,
    }),
    dataPlaneInflight: Object.freeze({
      defaultBytesPerDevice: 67_108_864,
      hardCeilingBytesPerDevice: 268_435_456,
    }),
    queueSeparation: Object.freeze({
      priorityOrder: Object.freeze([
        'P0 revoke/security',
        'P1 session-control',
        'P2 status',
        'P3 bulk-data-signal',
      ]),
      p0PersistentRingDefaultMessageCount: 64,
      controlAndDataShareOfflineQueue: false,
      backupChunksAllowedInControlQueue: false,
      p0SharesBulkQueue: false,
    }),
    perDeviceRate: Object.freeze({
      defaultMessagesPerSecond: 30,
      hardCeilingMessagesPerSecond: 60,
      defaultBurstMessages: 60,
      hardCeilingBurstMessages: 120,
      errorCode: ERROR_CODES.DEVICE_RATE_LIMITED,
    }),
    perDeviceSessions: Object.freeze({
      defaultConcurrentSessions: 2,
      defaultActiveSessions: 1,
      defaultDrainingSessions: 1,
      hardCeilingConcurrentSessions: 4,
      errorCode: ERROR_CODES.DEVICE_SESSION_LIMIT,
    }),
    perDeviceConnections: Object.freeze({
      defaultConcurrentConnectionsIncludingHandshake: 4,
      hardCeilingConcurrentConnectionsIncludingHandshake: 8,
    }),
    relayInboundConnections: Object.freeze({
      defaultPerController: 512,
      hardCeilingPerController: 2048,
    }),
    reconnectBackoff: Object.freeze({
      initialDelayMs: 1000,
      multiplier: 2,
      maximumDelayMs: 60_000,
      jitterFraction: 0.2,
      busyLoopAllowed: false,
      errorCode: ERROR_CODES.RELAY_CONNECT_FAILED,
    }),
    enrollmentHandshakeRate: Object.freeze({
      defaultAttemptsPerMinutePerSourceFingerprint: 10,
      hardCeilingAttemptsPerMinutePerSourceFingerprint: 30,
      errorCode: ERROR_CODES.ENROLLMENT_RATE_LIMITED,
    }),
  });

  const EXPECTED_KEEPALIVE_POLICY = Object.freeze({
    defaultSeconds: 30,
    minSeconds: 5,
    maxSeconds: 120,
    timeoutMultiplier: 3,
    livenessRefreshBySource: Object.freeze({
      'application-pong': true,
      'authenticated-control-traffic': true,
      'authenticated-data-traffic': true,
      'websocket-ping': false,
      'websocket-pong': false,
    }),
    timeoutErrorCode: ERROR_CODES.SESSION_KEEPALIVE_TIMEOUT,
  });

  const EXPECTED_DATA_RESUME_POLICY = Object.freeze({
    defaultAutomaticAttempts: 5,
    minConfigurableAutomaticAttempts: 3,
    maxConfigurableAutomaticAttempts: 10,
    hardCeilingAutomaticAttempts: 10,
    explicitResumeRequiredAfterExhaustion: true,
    silentRestartAllowed: false,
    unboundedRetryAllowed: false,
    errorCode: ERROR_CODES.DATA_RESUME_EXHAUSTED,
  });

  const EXPECTED_KEEPALIVE_DEFAULT_DECISION = Object.freeze({
    configurationAccepted: true,
    usedDefault: true,
    negotiatedKeepaliveInterval: 30,
  });

  const EXPECTED_KEEPALIVE_INVALID_DECISION = Object.freeze({
    configurationAccepted: false,
    usedDefault: true,
    negotiatedKeepaliveInterval: 30,
  });

  const EXPECTED_DATA_RESUME_DEFAULT_DECISION = Object.freeze({
    configurationAccepted: true,
    usedDefault: true,
    automaticResumeAttempts: 5,
  });

  const EXPECTED_DATA_RESUME_INVALID_DECISION = Object.freeze({
    configurationAccepted: false,
    usedDefault: true,
    automaticResumeAttempts: 5,
  });

  const EXPECTED_TIMEOUT_INVALID_DECISION = Object.freeze({
    inputAccepted: false,
    shouldDisconnect: true,
    timeoutAfterMs: null,
  });

  /**
   * Recursively assert Object.isFrozen on plain objects and arrays.
   * @param {unknown} value
   * @param {string} path
   */
  function assertDeepFrozen(value, path = 'root') {
    if (value === null || typeof value !== 'object') return;
    assert.ok(Object.isFrozen(value), `must be frozen: ${path}`);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        assertDeepFrozen(value[i], `${path}[${i}]`);
      }
      return;
    }
    for (const key of Object.keys(value)) {
      assertDeepFrozen(value[key], `${path}.${key}`);
    }
  }

  /**
   * Strict-mode mutation of every own data property (and nested) must throw.
   * @param {object} root
   * @param {string} path
   */
  function assertStrictModeMutationFails(root, path = 'root') {
    if (root === null || typeof root !== 'object') return;
    if (Array.isArray(root)) {
      assert.throws(() => {
        root.push('mutate');
      }, TypeError, `array push must throw: ${path}`);
      assert.throws(() => {
        root[0] = typeof root[0] === 'string' ? `${root[0]}-mut` : 999;
      }, TypeError, `array index assign must throw: ${path}`);
      for (let i = 0; i < root.length; i += 1) {
        assertStrictModeMutationFails(root[i], `${path}[${i}]`);
      }
      return;
    }
    for (const key of Object.keys(root)) {
      const current = root[key];
      assert.throws(() => {
        root[key] = typeof current === 'boolean' ? !current : 999_999;
      }, TypeError, `property assign must throw: ${path}.${key}`);
      assertStrictModeMutationFails(current, `${path}.${key}`);
    }
  }

  /**
   * @param {{ configurationAccepted: boolean, usedDefault: boolean, negotiatedKeepaliveInterval?: number, automaticResumeAttempts?: number }} decision
   * @param {Readonly<object>} expected
   */
  function assertExactFrozenConfigDecision(decision, expected) {
    assert.deepStrictEqual(decision, expected);
    assert.ok(Object.isFrozen(decision), 'config decision must be frozen');
    if (decision.configurationAccepted === false) {
      assert.strictEqual(decision.usedDefault, true);
    }
    assert.notDeepStrictEqual(
      {
        configurationAccepted: decision.configurationAccepted,
        usedDefault: decision.usedDefault,
      },
      { configurationAccepted: false, usedDefault: false },
    );
  }

  /**
   * @param {{ inputAccepted: boolean, shouldDisconnect: boolean, timeoutAfterMs: number | null }} decision
   * @param {Readonly<object>} expected
   */
  function assertExactFrozenTimeoutDecision(decision, expected) {
    assert.deepStrictEqual(decision, expected);
    assert.ok(Object.isFrozen(decision), 'timeout decision must be frozen');
  }

  /**
   * Fresh exact valid timeout input.
   * @param {{ negotiatedKeepaliveInterval?: number, elapsedSinceAuthenticatedLivenessMs?: number }} [overrides]
   */
  function createValidTimeoutInput(overrides = {}) {
    return {
      negotiatedKeepaliveInterval: 30,
      elapsedSinceAuthenticatedLivenessMs: 0,
      ...overrides,
    };
  }

  it('pins CROSS_LAN_CAPACITY_POLICY exact §4.4 values, error codes, deep freeze, strict mutation fails', () => {
    const policy = protocol.CROSS_LAN_CAPACITY_POLICY;
    assert.notStrictEqual(
      policy,
      undefined,
      'protocol.CROSS_LAN_CAPACITY_POLICY must be exported (T1.9 RED if missing)',
    );
    assert.deepStrictEqual(policy, EXPECTED_CAPACITY_POLICY);

    // Error codes must be the registry values (not copied strings).
    assert.strictEqual(
      policy.controlQueue.overflowErrorCode,
      ERROR_CODES.CONTROL_QUEUE_OVERFLOW,
    );
    assert.strictEqual(policy.perDeviceRate.errorCode, ERROR_CODES.DEVICE_RATE_LIMITED);
    assert.strictEqual(policy.perDeviceSessions.errorCode, ERROR_CODES.DEVICE_SESSION_LIMIT);
    assert.strictEqual(policy.reconnectBackoff.errorCode, ERROR_CODES.RELAY_CONNECT_FAILED);
    assert.strictEqual(
      policy.enrollmentHandshakeRate.errorCode,
      ERROR_CODES.ENROLLMENT_RATE_LIMITED,
    );

    // Full §4.4 numeric + negative queue-separation invariants.
    assert.strictEqual(policy.controlQueue.defaultMessageCountPerDevice, 256);
    assert.strictEqual(policy.controlQueue.hardCeilingMessageCountPerDevice, 1024);
    assert.strictEqual(policy.controlQueue.defaultTotalBytesPerDevice, 1_048_576);
    assert.strictEqual(policy.controlQueue.hardCeilingTotalBytesPerDevice, 4_194_304);
    assert.strictEqual(policy.controlQueue.maximumMessageBytes, 65_536);
    assert.strictEqual(policy.dataPlaneInflight.defaultBytesPerDevice, 67_108_864);
    assert.strictEqual(policy.dataPlaneInflight.hardCeilingBytesPerDevice, 268_435_456);
    assert.deepStrictEqual(policy.queueSeparation.priorityOrder, [
      'P0 revoke/security',
      'P1 session-control',
      'P2 status',
      'P3 bulk-data-signal',
    ]);
    assert.strictEqual(policy.queueSeparation.p0PersistentRingDefaultMessageCount, 64);
    assert.strictEqual(policy.queueSeparation.controlAndDataShareOfflineQueue, false);
    assert.strictEqual(policy.queueSeparation.backupChunksAllowedInControlQueue, false);
    assert.strictEqual(policy.queueSeparation.p0SharesBulkQueue, false);
    assert.strictEqual(policy.perDeviceRate.defaultMessagesPerSecond, 30);
    assert.strictEqual(policy.perDeviceRate.hardCeilingMessagesPerSecond, 60);
    assert.strictEqual(policy.perDeviceRate.defaultBurstMessages, 60);
    assert.strictEqual(policy.perDeviceRate.hardCeilingBurstMessages, 120);
    assert.strictEqual(policy.perDeviceSessions.defaultConcurrentSessions, 2);
    assert.strictEqual(policy.perDeviceSessions.defaultActiveSessions, 1);
    assert.strictEqual(policy.perDeviceSessions.defaultDrainingSessions, 1);
    assert.strictEqual(policy.perDeviceSessions.hardCeilingConcurrentSessions, 4);
    assert.strictEqual(
      policy.perDeviceConnections.defaultConcurrentConnectionsIncludingHandshake,
      4,
    );
    assert.strictEqual(
      policy.perDeviceConnections.hardCeilingConcurrentConnectionsIncludingHandshake,
      8,
    );
    assert.strictEqual(policy.relayInboundConnections.defaultPerController, 512);
    assert.strictEqual(policy.relayInboundConnections.hardCeilingPerController, 2048);
    assert.strictEqual(policy.reconnectBackoff.initialDelayMs, 1000);
    assert.strictEqual(policy.reconnectBackoff.multiplier, 2);
    assert.strictEqual(policy.reconnectBackoff.maximumDelayMs, 60_000);
    assert.strictEqual(policy.reconnectBackoff.jitterFraction, 0.2);
    assert.strictEqual(policy.reconnectBackoff.busyLoopAllowed, false);
    assert.strictEqual(
      policy.enrollmentHandshakeRate.defaultAttemptsPerMinutePerSourceFingerprint,
      10,
    );
    assert.strictEqual(
      policy.enrollmentHandshakeRate.hardCeilingAttemptsPerMinutePerSourceFingerprint,
      30,
    );

    assertDeepFrozen(policy);
    assertStrictModeMutationFails(policy);
    assert.deepStrictEqual(policy, EXPECTED_CAPACITY_POLICY);
  });

  it('pins CROSS_LAN_KEEPALIVE_POLICY exact §6.12 values, single liveness map, freeze, strict mutation fails', () => {
    const policy = protocol.CROSS_LAN_KEEPALIVE_POLICY;
    assert.notStrictEqual(
      policy,
      undefined,
      'protocol.CROSS_LAN_KEEPALIVE_POLICY must be exported (T1.9 RED if missing)',
    );
    assert.deepStrictEqual(policy, EXPECTED_KEEPALIVE_POLICY);
    assert.strictEqual(policy.timeoutErrorCode, ERROR_CODES.SESSION_KEEPALIVE_TIMEOUT);
    assert.strictEqual(policy.defaultSeconds, 30);
    assert.strictEqual(policy.minSeconds, 5);
    assert.strictEqual(policy.maxSeconds, 120);
    assert.strictEqual(policy.timeoutMultiplier, 3);

    // Single source: five closed-set liveness keys only.
    assert.deepStrictEqual(Object.keys(policy.livenessRefreshBySource).sort(), [
      'application-pong',
      'authenticated-control-traffic',
      'authenticated-data-traffic',
      'websocket-ping',
      'websocket-pong',
    ].sort());
    assert.strictEqual(policy.livenessRefreshBySource['application-pong'], true);
    assert.strictEqual(policy.livenessRefreshBySource['authenticated-control-traffic'], true);
    assert.strictEqual(policy.livenessRefreshBySource['authenticated-data-traffic'], true);
    assert.strictEqual(policy.livenessRefreshBySource['websocket-ping'], false);
    assert.strictEqual(policy.livenessRefreshBySource['websocket-pong'], false);

    assertDeepFrozen(policy);
    assertStrictModeMutationFails(policy);
    assert.deepStrictEqual(policy, EXPECTED_KEEPALIVE_POLICY);
  });

  it('pins CROSS_LAN_DATA_RESUME_POLICY exact §6.10 values, freeze, strict mutation fails', () => {
    const policy = protocol.CROSS_LAN_DATA_RESUME_POLICY;
    assert.notStrictEqual(
      policy,
      undefined,
      'protocol.CROSS_LAN_DATA_RESUME_POLICY must be exported (T1.9 RED if missing)',
    );
    assert.deepStrictEqual(policy, EXPECTED_DATA_RESUME_POLICY);
    assert.strictEqual(policy.errorCode, ERROR_CODES.DATA_RESUME_EXHAUSTED);
    assert.strictEqual(policy.defaultAutomaticAttempts, 5);
    assert.strictEqual(policy.minConfigurableAutomaticAttempts, 3);
    assert.strictEqual(policy.maxConfigurableAutomaticAttempts, 10);
    assert.strictEqual(policy.hardCeilingAutomaticAttempts, 10);
    // Same numeric value, distinct semantics: configurable max vs absolute hard ceiling.
    assert.strictEqual(
      policy.maxConfigurableAutomaticAttempts,
      policy.hardCeilingAutomaticAttempts,
    );
    assert.strictEqual(policy.explicitResumeRequiredAfterExhaustion, true);
    assert.strictEqual(policy.silentRestartAllowed, false);
    assert.strictEqual(policy.unboundedRetryAllowed, false);

    assertDeepFrozen(policy);
    assertStrictModeMutationFails(policy);
    assert.deepStrictEqual(policy, EXPECTED_DATA_RESUME_POLICY);
  });

  it('resolveCrossLanKeepaliveConfiguration accepted triad + invalid fallback; fresh frozen; never throws', () => {
    const resolve = protocol.resolveCrossLanKeepaliveConfiguration;
    assert.strictEqual(typeof resolve, 'function');

    const firstUndefined = resolve(undefined);
    const secondUndefined = resolve(undefined);
    assertExactFrozenConfigDecision(firstUndefined, EXPECTED_KEEPALIVE_DEFAULT_DECISION);
    assertExactFrozenConfigDecision(secondUndefined, EXPECTED_KEEPALIVE_DEFAULT_DECISION);
    assert.notStrictEqual(firstUndefined, secondUndefined);

    assertExactFrozenConfigDecision(
      resolve(5),
      Object.freeze({
        configurationAccepted: true,
        usedDefault: false,
        negotiatedKeepaliveInterval: 5,
      }),
    );
    assertExactFrozenConfigDecision(
      resolve(120),
      Object.freeze({
        configurationAccepted: true,
        usedDefault: false,
        negotiatedKeepaliveInterval: 120,
      }),
    );
    assertExactFrozenConfigDecision(
      resolve(30),
      Object.freeze({
        configurationAccepted: true,
        usedDefault: false,
        negotiatedKeepaliveInterval: 30,
      }),
    );

    const throwingNumberProxy = new Proxy(new Number(30), {
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
    const { proxy: revokedProxy, revoke } = Proxy.revocable({ valueOf: () => 30 }, {});
    revoke();

    const invalidInputs = [
      4,
      121,
      4.5,
      30.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      30n,
      '30',
      null,
      true,
      Symbol('30'),
      { value: 30 },
      [30],
      new Number(30),
      throwingNumberProxy,
      revokedProxy,
    ];

    for (const bad of invalidInputs) {
      let decision;
      assert.doesNotThrow(() => {
        decision = resolve(bad);
      }, 'keepalive resolve must not throw');
      assertExactFrozenConfigDecision(decision, EXPECTED_KEEPALIVE_INVALID_DECISION);
    }
  });

  it('resolveCrossLanDataResumeConfiguration accepted triad + invalid fallback; fresh frozen; never throws', () => {
    const resolve = protocol.resolveCrossLanDataResumeConfiguration;
    assert.strictEqual(typeof resolve, 'function');

    const firstUndefined = resolve(undefined);
    const secondUndefined = resolve(undefined);
    assertExactFrozenConfigDecision(firstUndefined, EXPECTED_DATA_RESUME_DEFAULT_DECISION);
    assertExactFrozenConfigDecision(secondUndefined, EXPECTED_DATA_RESUME_DEFAULT_DECISION);
    assert.notStrictEqual(firstUndefined, secondUndefined);

    assertExactFrozenConfigDecision(
      resolve(3),
      Object.freeze({
        configurationAccepted: true,
        usedDefault: false,
        automaticResumeAttempts: 3,
      }),
    );
    assertExactFrozenConfigDecision(
      resolve(10),
      Object.freeze({
        configurationAccepted: true,
        usedDefault: false,
        automaticResumeAttempts: 10,
      }),
    );
    assertExactFrozenConfigDecision(
      resolve(5),
      Object.freeze({
        configurationAccepted: true,
        usedDefault: false,
        automaticResumeAttempts: 5,
      }),
    );

    const throwingNumberProxy = new Proxy(new Number(5), {
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
    const { proxy: revokedProxy, revoke } = Proxy.revocable({ valueOf: () => 5 }, {});
    revoke();

    const invalidInputs = [
      2,
      11,
      2.5,
      5.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      5n,
      '5',
      null,
      true,
      Symbol('5'),
      { value: 5 },
      [5],
      new Number(5),
      throwingNumberProxy,
      revokedProxy,
    ];

    for (const bad of invalidInputs) {
      let decision;
      assert.doesNotThrow(() => {
        decision = resolve(bad);
      }, 'data-resume resolve must not throw');
      assertExactFrozenConfigDecision(decision, EXPECTED_DATA_RESUME_INVALID_DECISION);
    }
  });

  it('doesCrossLanLivenessSignalRefreshTimer closed-set map only; WS ping/pong never refresh; never throws', () => {
    const fn = protocol.doesCrossLanLivenessSignalRefreshTimer;
    assert.strictEqual(typeof fn, 'function');

    const policy = protocol.CROSS_LAN_KEEPALIVE_POLICY;
    const closedSet = [
      'application-pong',
      'authenticated-control-traffic',
      'authenticated-data-traffic',
      'websocket-ping',
      'websocket-pong',
    ];

    // Each closed-set value must match the single policy map exactly.
    for (const signal of closedSet) {
      assert.strictEqual(
        fn(signal),
        policy.livenessRefreshBySource[signal],
        `liveness map must be single source for ${signal}`,
      );
    }

    // WS transport helpers must never refresh the security timer.
    assert.strictEqual(fn('websocket-ping'), false);
    assert.strictEqual(fn('websocket-pong'), false);

    // Authentic application-layer signals refresh.
    assert.strictEqual(fn('application-pong'), true);
    assert.strictEqual(fn('authenticated-control-traffic'), true);
    assert.strictEqual(fn('authenticated-data-traffic'), true);

    const nonRefreshing = [
      'unknown',
      '',
      'Application-Pong',
      'APPLICATION-PONG',
      'application_pong',
      ' application-pong',
      'application-pong ',
      'ws-ping',
      'ping',
      'pong',
      undefined,
      null,
      0,
      1,
      true,
      false,
      Symbol('application-pong'),
      { type: 'application-pong' },
      ['application-pong'],
    ];

    for (const bad of nonRefreshing) {
      let result;
      assert.doesNotThrow(() => {
        result = fn(bad);
      });
      assert.strictEqual(result, false, `must not refresh for ${String(bad)}`);
    }
  });

  it('evaluateCrossLanKeepaliveTimeout boundaries at 30/5/120; uses timeoutMultiplier; no Date.now', (t) => {
    const fn = protocol.evaluateCrossLanKeepaliveTimeout;
    assert.strictEqual(typeof fn, 'function');

    // 30s → timeoutAfterMs = 90_000; 89_999/90_000 false; 90_001 true.
    assertExactFrozenTimeoutDecision(
      fn(createValidTimeoutInput({
        negotiatedKeepaliveInterval: 30,
        elapsedSinceAuthenticatedLivenessMs: 89_999,
      })),
      Object.freeze({
        inputAccepted: true,
        shouldDisconnect: false,
        timeoutAfterMs: 90_000,
      }),
    );
    assertExactFrozenTimeoutDecision(
      fn(createValidTimeoutInput({
        negotiatedKeepaliveInterval: 30,
        elapsedSinceAuthenticatedLivenessMs: 90_000,
      })),
      Object.freeze({
        inputAccepted: true,
        shouldDisconnect: false,
        timeoutAfterMs: 90_000,
      }),
    );
    assertExactFrozenTimeoutDecision(
      fn(createValidTimeoutInput({
        negotiatedKeepaliveInterval: 30,
        elapsedSinceAuthenticatedLivenessMs: 90_001,
      })),
      Object.freeze({
        inputAccepted: true,
        shouldDisconnect: true,
        timeoutAfterMs: 90_000,
      }),
    );

    // 5s → 15_000 false; 15_001 true.
    assertExactFrozenTimeoutDecision(
      fn(createValidTimeoutInput({
        negotiatedKeepaliveInterval: 5,
        elapsedSinceAuthenticatedLivenessMs: 15_000,
      })),
      Object.freeze({
        inputAccepted: true,
        shouldDisconnect: false,
        timeoutAfterMs: 15_000,
      }),
    );
    assertExactFrozenTimeoutDecision(
      fn(createValidTimeoutInput({
        negotiatedKeepaliveInterval: 5,
        elapsedSinceAuthenticatedLivenessMs: 15_001,
      })),
      Object.freeze({
        inputAccepted: true,
        shouldDisconnect: true,
        timeoutAfterMs: 15_000,
      }),
    );

    // 120s → 360_000 false; 360_001 true.
    assertExactFrozenTimeoutDecision(
      fn(createValidTimeoutInput({
        negotiatedKeepaliveInterval: 120,
        elapsedSinceAuthenticatedLivenessMs: 360_000,
      })),
      Object.freeze({
        inputAccepted: true,
        shouldDisconnect: false,
        timeoutAfterMs: 360_000,
      }),
    );
    assertExactFrozenTimeoutDecision(
      fn(createValidTimeoutInput({
        negotiatedKeepaliveInterval: 120,
        elapsedSinceAuthenticatedLivenessMs: 360_001,
      })),
      Object.freeze({
        inputAccepted: true,
        shouldDisconnect: true,
        timeoutAfterMs: 360_000,
      }),
    );

    // elapsed 0 is always not timed out.
    assertExactFrozenTimeoutDecision(
      fn(createValidTimeoutInput({
        negotiatedKeepaliveInterval: 30,
        elapsedSinceAuthenticatedLivenessMs: 0,
      })),
      Object.freeze({
        inputAccepted: true,
        shouldDisconnect: false,
        timeoutAfterMs: 90_000,
      }),
    );

    // timeoutAfterMs must come from policy.timeoutMultiplier (3), not a second hard-coded 3.
    assert.strictEqual(protocol.CROSS_LAN_KEEPALIVE_POLICY.timeoutMultiplier, 3);
    const mid = fn(createValidTimeoutInput({
      negotiatedKeepaliveInterval: 10,
      elapsedSinceAuthenticatedLivenessMs: 0,
    }));
    assert.strictEqual(
      mid.timeoutAfterMs,
      10 * protocol.CROSS_LAN_KEEPALIVE_POLICY.timeoutMultiplier * 1000,
    );

    // Fresh frozen references each call.
    const a = fn(createValidTimeoutInput());
    const b = fn(createValidTimeoutInput());
    assert.notStrictEqual(a, b);
    assert.ok(Object.isFrozen(a));
    assert.ok(Object.isFrozen(b));

    // null-prototype exact valid record accepted.
    assertExactFrozenTimeoutDecision(
      fn(Object.assign(Object.create(null), createValidTimeoutInput({
        negotiatedKeepaliveInterval: 30,
        elapsedSinceAuthenticatedLivenessMs: 90_001,
      }))),
      Object.freeze({
        inputAccepted: true,
        shouldDisconnect: true,
        timeoutAfterMs: 90_000,
      }),
    );

    // Prove no Date.now read.
    t.mock.method(Date, 'now', () => {
      throw new Error(SENTINEL_SECRET);
    });
    let validWhileMocked;
    assert.doesNotThrow(() => {
      validWhileMocked = fn(createValidTimeoutInput({
        negotiatedKeepaliveInterval: 30,
        elapsedSinceAuthenticatedLivenessMs: 90_001,
      }));
    });
    assertExactFrozenTimeoutDecision(
      validWhileMocked,
      Object.freeze({
        inputAccepted: true,
        shouldDisconnect: true,
        timeoutAfterMs: 90_000,
      }),
    );
  });

  it('evaluateCrossLanKeepaliveTimeout rejects invalid exact-record inputs conservatively; never throws', () => {
    const fn = protocol.evaluateCrossLanKeepaliveTimeout;

    // Missing each required field.
    for (const key of ['negotiatedKeepaliveInterval', 'elapsedSinceAuthenticatedLivenessMs']) {
      const missing = createValidTimeoutInput();
      delete missing[key];
      let decision;
      assert.doesNotThrow(() => {
        decision = fn(missing);
      });
      assertExactFrozenTimeoutDecision(decision, EXPECTED_TIMEOUT_INVALID_DECISION);
    }

    // Extra own enumerable key.
    assertExactFrozenTimeoutDecision(
      fn({ ...createValidTimeoutInput(), extra: true }),
      EXPECTED_TIMEOUT_INVALID_DECISION,
    );

    // Symbol own key.
    const withSymbol = createValidTimeoutInput();
    Object.defineProperty(withSymbol, Symbol('s'), { value: 1, enumerable: true });
    assertExactFrozenTimeoutDecision(fn(withSymbol), EXPECTED_TIMEOUT_INVALID_DECISION);

    // Non-enumerable required field.
    const nonEnumRequired = createValidTimeoutInput();
    Object.defineProperty(nonEnumRequired, 'elapsedSinceAuthenticatedLivenessMs', {
      value: 0,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    assertExactFrozenTimeoutDecision(fn(nonEnumRequired), EXPECTED_TIMEOUT_INVALID_DECISION);

    // Non-enumerable extra key.
    const nonEnumExtra = createValidTimeoutInput();
    Object.defineProperty(nonEnumExtra, 'hidden', {
      value: true,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    assertExactFrozenTimeoutDecision(fn(nonEnumExtra), EXPECTED_TIMEOUT_INVALID_DECISION);

    // Accessor returning a correct value must still fail.
    const accessor = createValidTimeoutInput();
    Object.defineProperty(accessor, 'negotiatedKeepaliveInterval', {
      get() {
        return 30;
      },
      enumerable: true,
      configurable: true,
    });
    assertExactFrozenTimeoutDecision(fn(accessor), EXPECTED_TIMEOUT_INVALID_DECISION);

    // Non-plain / non-ordinary inputs.
    const nonPlain = [
      null,
      undefined,
      true,
      false,
      0,
      30,
      'timeout',
      [],
      new Date(),
      new Map(),
      new Set(),
      new ExampleClass(),
      () => {},
    ];
    for (const bad of nonPlain) {
      let decision;
      assert.doesNotThrow(() => {
        decision = fn(bad);
      });
      assertExactFrozenTimeoutDecision(decision, EXPECTED_TIMEOUT_INVALID_DECISION);
    }

    // Type drift / out-of-range on fields.
    const typeDrifts = [
      { negotiatedKeepaliveInterval: 4, elapsedSinceAuthenticatedLivenessMs: 0 },
      { negotiatedKeepaliveInterval: 121, elapsedSinceAuthenticatedLivenessMs: 0 },
      { negotiatedKeepaliveInterval: 30.5, elapsedSinceAuthenticatedLivenessMs: 0 },
      { negotiatedKeepaliveInterval: '30', elapsedSinceAuthenticatedLivenessMs: 0 },
      { negotiatedKeepaliveInterval: 30n, elapsedSinceAuthenticatedLivenessMs: 0 },
      { negotiatedKeepaliveInterval: Number.NaN, elapsedSinceAuthenticatedLivenessMs: 0 },
      {
        negotiatedKeepaliveInterval: Number.POSITIVE_INFINITY,
        elapsedSinceAuthenticatedLivenessMs: 0,
      },
      {
        negotiatedKeepaliveInterval: Number.NEGATIVE_INFINITY,
        elapsedSinceAuthenticatedLivenessMs: 0,
      },
      { negotiatedKeepaliveInterval: 30, elapsedSinceAuthenticatedLivenessMs: -1 },
      { negotiatedKeepaliveInterval: 30, elapsedSinceAuthenticatedLivenessMs: 1.5 },
      { negotiatedKeepaliveInterval: 30, elapsedSinceAuthenticatedLivenessMs: '0' },
      { negotiatedKeepaliveInterval: 30, elapsedSinceAuthenticatedLivenessMs: 0n },
      { negotiatedKeepaliveInterval: 30, elapsedSinceAuthenticatedLivenessMs: Number.NaN },
      {
        negotiatedKeepaliveInterval: 30,
        elapsedSinceAuthenticatedLivenessMs: Number.POSITIVE_INFINITY,
      },
      {
        negotiatedKeepaliveInterval: 30,
        elapsedSinceAuthenticatedLivenessMs: Number.NEGATIVE_INFINITY,
      },
    ];
    for (const bad of typeDrifts) {
      let decision;
      assert.doesNotThrow(() => {
        decision = fn(bad);
      });
      assertExactFrozenTimeoutDecision(decision, EXPECTED_TIMEOUT_INVALID_DECISION);
    }

    // Throwing Proxy + revoked Proxy → invalid disconnect without throw.
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
    const base = createValidTimeoutInput();
    const { proxy: revokedProxy, revoke } = Proxy.revocable(base, {});
    revoke();

    assert.doesNotThrow(() => {
      assertExactFrozenTimeoutDecision(fn(throwingProxy), EXPECTED_TIMEOUT_INVALID_DECISION);
      assertExactFrozenTimeoutDecision(fn(revokedProxy), EXPECTED_TIMEOUT_INVALID_DECISION);
    });
    // Transparent Proxy residual risk is not required to reject.
  });
});

/**
 * T1.10 pure Noise suite / prologue / domain-separation constants + pure
 * protocol_name / prologue byte encoders only.
 *
 * Honesty / scope (PM final adjudication for M1 T1.10):
 * - Freezes the unique suite/protocol_name, prologue policy fields, and the
 *   seven domain labels from Gold §6.7.2.3; encodes exact ASCII / wire bytes.
 * - Does NOT implement Noise handshake, hash, HKDF, ChaCha, X25519, token
 *   sequences (T1.12), or relay KE participation contracts (T1.11).
 * - T1.0 Noise library selection gate remains BLOCKED. These tests do not
 *   claim Noise / E2EE / cross-LAN / M1 crypto readiness.
 * - Independent hex pins below are dual-source literals — never derived from
 *   the production encoders under test.
 */
describe('cross-LAN Noise suite / prologue / domain labels (T1.10)', () => {
  /** Independent pin: Noise protocol_name ASCII hex (dual-source, not from production). */
  const EXPECTED_PROTOCOL_NAME_HEX =
    '4e6f6973655f494b5f32353531395f436861436861506f6c795f534841323536';
  /** Independent pin: prologue prefix ASCII hex (dual-source, not from production). */
  const EXPECTED_PROLOGUE_PREFIX_HEX =
    '6c696e6b652d76322f63726f73732d6c616e2f6e6f6973652d696b2f7631';

  const EXPECTED_PROTOCOL_NAME = 'Noise_IK_25519_ChaChaPoly_SHA256';
  const EXPECTED_PROLOGUE_POLICY = Object.freeze({
    prefixAscii: 'linke-v2/cross-lan/noise-ik/v1',
    protocolVersionByteLength: 2,
    protocolVersionByteOrder: 'BE',
    suiteId: 1,
    suiteIdByteLength: 1,
  });
  const EXPECTED_DOMAIN_LABELS = Object.freeze({
    handshake: 'linke-v2/e2ee/handshake',
    trafficControllerToDevice: 'linke-v2/e2ee/traffic-c2d',
    trafficDeviceToController: 'linke-v2/e2ee/traffic-d2c',
    rekey: 'linke-v2/e2ee/rekey',
    keyConfirm: 'linke-v2/e2ee/key-confirm',
    dataChunkMac: 'linke-v2/data/chunk-mac',
    relayCapability: 'linke-v2/relay-cap',
  });

  /** Small test-only hex helper — never uses production encoders for expected. */
  function bytesToHex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  it('exports exact frozen suite / prologue policy / seven unique ASCII domain labels', () => {
    assert.strictEqual(protocol.CROSS_LAN_NOISE_PROTOCOL_NAME, EXPECTED_PROTOCOL_NAME);

    assert.deepStrictEqual(
      protocol.CROSS_LAN_NOISE_PROLOGUE_POLICY,
      EXPECTED_PROLOGUE_POLICY,
    );
    assert.strictEqual(Object.isFrozen(protocol.CROSS_LAN_NOISE_PROLOGUE_POLICY), true);

    assert.deepStrictEqual(
      protocol.CROSS_LAN_DOMAIN_SEPARATION_LABELS,
      EXPECTED_DOMAIN_LABELS,
    );
    assert.strictEqual(Object.isFrozen(protocol.CROSS_LAN_DOMAIN_SEPARATION_LABELS), true);

    const labels = protocol.CROSS_LAN_DOMAIN_SEPARATION_LABELS;
    const keys = Object.keys(labels);
    assert.strictEqual(keys.length, 7);
    const values = Object.values(labels);
    assert.strictEqual(values.length, 7);
    assert.strictEqual(new Set(values).size, 7);
    for (const value of values) {
      assert.strictEqual(typeof value, 'string');
      assert.match(value, /^[\x00-\x7f]+$/);
    }
  });

  it('encodeCrossLanNoiseProtocolNameBytes returns fresh exact ASCII Uint8Array', () => {
    const encode = protocol.encodeCrossLanNoiseProtocolNameBytes;
    assert.strictEqual(typeof encode, 'function');

    const a = encode();
    const b = encode();
    assert.ok(a instanceof Uint8Array);
    assert.strictEqual(bytesToHex(a), EXPECTED_PROTOCOL_NAME_HEX);
    assert.notStrictEqual(a, b);
    assert.strictEqual(bytesToHex(b), EXPECTED_PROTOCOL_NAME_HEX);

    a[0] = 0x00;
    assert.strictEqual(bytesToHex(encode()), EXPECTED_PROTOCOL_NAME_HEX);
    assert.strictEqual(protocol.CROSS_LAN_NOISE_PROTOCOL_NAME, EXPECTED_PROTOCOL_NAME);
  });

  it('encodeCrossLanNoisePrologueBytes exact wire hex for uint16 BE + suiteId 0x01', () => {
    const encode = protocol.encodeCrossLanNoisePrologueBytes;
    assert.strictEqual(typeof encode, 'function');

    assert.strictEqual(
      bytesToHex(encode(0)),
      `${EXPECTED_PROLOGUE_PREFIX_HEX}000001`,
    );
    assert.strictEqual(
      bytesToHex(encode(1)),
      `${EXPECTED_PROLOGUE_PREFIX_HEX}000101`,
    );
    assert.strictEqual(
      bytesToHex(encode(0x1234)),
      `${EXPECTED_PROLOGUE_PREFIX_HEX}123401`,
    );
    assert.strictEqual(
      bytesToHex(encode(65535)),
      `${EXPECTED_PROLOGUE_PREFIX_HEX}ffff01`,
    );
  });

  it('encodeCrossLanNoisePrologueBytes rejects invalid protocolVersion without throw', () => {
    const encode = protocol.encodeCrossLanNoisePrologueBytes;
    const throwingProxy = new Proxy(
      {},
      {
        get() {
          throw new Error(SENTINEL_SECRET);
        },
        valueOf() {
          throw new Error(SENTINEL_SECRET);
        },
        toString() {
          throw new Error(SENTINEL_SECRET);
        },
      },
    );
    const { proxy: revokedProxy, revoke } = Proxy.revocable({ valueOf: () => 1 }, {});
    revoke();

    const invalids = [
      -1,
      65536,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      0n,
      1n,
      '0',
      '1',
      null,
      undefined,
      [],
      {},
      Symbol('v'),
      throwingProxy,
      revokedProxy,
    ];
    for (const bad of invalids) {
      let result;
      assert.doesNotThrow(() => {
        result = encode(bad);
      });
      assert.strictEqual(result, null);
    }
    // Transparent Proxy residual risk is not required to reject.
  });

  it('encodeCrossLanNoisePrologueBytes returns mutable fresh arrays with isolation', () => {
    const encode = protocol.encodeCrossLanNoisePrologueBytes;
    const a = encode(0x1234);
    const b = encode(0x1234);
    assert.ok(a instanceof Uint8Array);
    assert.notStrictEqual(a, b);
    assert.strictEqual(Object.isFrozen(a), false);

    a[0] = 0x00;
    assert.strictEqual(bytesToHex(encode(0x1234)), `${EXPECTED_PROLOGUE_PREFIX_HEX}123401`);
    assert.strictEqual(
      protocol.CROSS_LAN_NOISE_PROLOGUE_POLICY.prefixAscii,
      EXPECTED_PROLOGUE_POLICY.prefixAscii,
    );
    assert.strictEqual(protocol.CROSS_LAN_NOISE_PROLOGUE_POLICY.suiteId, 1);
  });

  it('T1.5 profile allowlist still requires full record; noiseSuite uses exported name', () => {
    const fn = protocol.isAllowedCrossLanProtocolProfile;
    assert.strictEqual(typeof fn, 'function');

    // Must not pass the suite string alone as a profile.
    assert.strictEqual(fn(protocol.CROSS_LAN_NOISE_PROTOCOL_NAME), false);
    assert.strictEqual(fn(EXPECTED_PROTOCOL_NAME), false);

    const valid = {
      noiseSuite: protocol.CROSS_LAN_NOISE_PROTOCOL_NAME,
      mutualAuthenticationRequired: true,
      independentE2eeRequired: true,
      relayTransport: 'wss',
      tlsVersion: '1.3',
      tcpPort: 443,
    };
    assert.strictEqual(fn(valid), true);

    assert.strictEqual(
      fn({ ...valid, noiseSuite: 'Noise_XX_25519_ChaChaPoly_SHA256' }),
      false,
    );
    assert.strictEqual(
      fn({ ...valid, noiseSuite: 'noise_ik_25519_chachapoly_sha256' }),
      false,
    );
    assert.strictEqual(
      fn({ ...valid, noiseSuite: 'NOISE_IK_25519_CHACHAPOLY_SHA256' }),
      false,
    );
  });
});

/**
 * T1.12a non-crypto Noise IK token-sequence scaffold only.
 *
 * Honesty / scope (highest priority status boundary):
 * - [status] T1.0 Noise library gate = BLOCKED (not M1 crypto PASS)
 * - [scope] T1.12a non-crypto token scaffold only; T1.12 fixed vectors
 *   NOT READY / NOT COMPLETE
 * - Does NOT load fixtures, verify ciphertext / handshake hash, bind a Noise
 *   library, or run DH/AEAD/hash/handshake. No independent authoritative
 *   expected handshake hash is present in the current gate evidence
 *   (public cacophony does not provide one); full 6-message fixture vs
 *   selected implementation waits for gate reopen + user path decision.
 * - matcher true only means two token rows match the frozen indexed
 *   content/order table — not Noise, library compatibility, E2EE, or a real
 *   handshake. Scaffold rejects disorder; does not claim real Noise
 *   implementations reject or that T1.12 is complete.
 */
describe('cross-LAN Noise IK token sequence (T1.12a non-crypto scaffold)', () => {
  /** Independent dual-source pin — never derived from production under test. */
  const EXPECTED_NOISE_IK_TOKEN_SEQUENCE = Object.freeze({
    msg1: Object.freeze(['e', 'es', 's', 'ss']),
    msg2: Object.freeze(['e', 'ee', 'se']),
  });

  /** Fresh exact canonical input — independent per call so tests never share state. */
  function createCanonicalTokenSequenceInput() {
    return {
      msg1: ['e', 'es', 's', 'ss'],
      msg2: ['e', 'ee', 'se'],
    };
  }

  it('exports exact frozen CROSS_LAN_NOISE_IK_TOKEN_SEQUENCE pin (deep frozen; strict mutation throws)', () => {
    const seq = protocol.CROSS_LAN_NOISE_IK_TOKEN_SEQUENCE;
    assert.notStrictEqual(
      seq,
      undefined,
      'protocol.CROSS_LAN_NOISE_IK_TOKEN_SEQUENCE must be exported (T1.12a RED if missing)',
    );
    assert.deepStrictEqual(seq, EXPECTED_NOISE_IK_TOKEN_SEQUENCE);
    assert.strictEqual(Object.keys(seq).length, 2);
    assert.ok(Object.isFrozen(seq), 'top-level token sequence must be frozen');
    assert.ok(Object.isFrozen(seq.msg1), 'msg1 array must be frozen');
    assert.ok(Object.isFrozen(seq.msg2), 'msg2 array must be frozen');
    assert.deepStrictEqual(seq.msg1, ['e', 'es', 's', 'ss']);
    assert.deepStrictEqual(seq.msg2, ['e', 'ee', 'se']);
    assert.strictEqual(seq.msg1.length, 4);
    assert.strictEqual(seq.msg2.length, 3);

    // ESM is strict mode: frozen assignment throws (do not rely on silent/sloppy mutation).
    assert.throws(() => {
      seq.msg1 = ['x'];
    }, TypeError);
    assert.throws(() => {
      seq.msg2 = ['x'];
    }, TypeError);
    assert.throws(() => {
      seq.msg1[0] = 'x';
    }, TypeError);
    assert.throws(() => {
      seq.msg2[0] = 'x';
    }, TypeError);
    assert.throws(() => {
      seq.msg1.push('x');
    }, TypeError);
    assert.throws(() => {
      seq.msg2.push('x');
    }, TypeError);
    assert.deepStrictEqual(seq, EXPECTED_NOISE_IK_TOKEN_SEQUENCE);
    assert.ok(Object.isFrozen(seq));
    assert.ok(Object.isFrozen(seq.msg1));
    assert.ok(Object.isFrozen(seq.msg2));
  });

  it('matchesCrossLanNoiseIkTokenSequence accepts canonical ordinary / null-proto / frozen inputs', () => {
    const fn = protocol.matchesCrossLanNoiseIkTokenSequence;
    assert.strictEqual(
      typeof fn,
      'function',
      'matchesCrossLanNoiseIkTokenSequence must be exported (T1.12a RED if missing)',
    );

    assert.strictEqual(fn(createCanonicalTokenSequenceInput()), true);

    const frozen = Object.freeze({
      msg1: Object.freeze(['e', 'es', 's', 'ss']),
      msg2: Object.freeze(['e', 'ee', 'se']),
    });
    assert.strictEqual(fn(frozen), true);

    const nullProto = Object.assign(Object.create(null), {
      msg1: ['e', 'es', 's', 'ss'],
      msg2: ['e', 'ee', 'se'],
    });
    assert.strictEqual(fn(nullProto), true);

    // Frozen constant itself is a valid match source.
    assert.strictEqual(fn(protocol.CROSS_LAN_NOISE_IK_TOKEN_SEQUENCE), true);
  });

  it('scaffold rejects disorder: reorder / missing / insert-custom / swap rows', () => {
    const fn = protocol.matchesCrossLanNoiseIkTokenSequence;

    // msg1 typical disorder (not "handshake rejects").
    assert.strictEqual(
      fn({ msg1: ['es', 'e', 's', 'ss'], msg2: ['e', 'ee', 'se'] }),
      false,
    );
    assert.strictEqual(
      fn({ msg1: ['e', 's', 'es', 'ss'], msg2: ['e', 'ee', 'se'] }),
      false,
    );
    assert.strictEqual(
      fn({ msg1: ['ss', 's', 'es', 'e'], msg2: ['e', 'ee', 'se'] }),
      false,
    );
    assert.strictEqual(
      fn({ msg1: ['e', 'es', 'ss', 's'], msg2: ['e', 'ee', 'se'] }),
      false,
    );

    // msg2 typical disorder.
    assert.strictEqual(
      fn({ msg1: ['e', 'es', 's', 'ss'], msg2: ['ee', 'e', 'se'] }),
      false,
    );
    assert.strictEqual(
      fn({ msg1: ['e', 'es', 's', 'ss'], msg2: ['e', 'se', 'ee'] }),
      false,
    );
    assert.strictEqual(
      fn({ msg1: ['e', 'es', 's', 'ss'], msg2: ['se', 'ee', 'e'] }),
      false,
    );

    // Missing tokens (shorter rows).
    assert.strictEqual(
      fn({ msg1: ['e', 'es', 's'], msg2: ['e', 'ee', 'se'] }),
      false,
    );
    assert.strictEqual(
      fn({ msg1: ['e', 'es', 's', 'ss'], msg2: ['e', 'ee'] }),
      false,
    );
    assert.strictEqual(fn({ msg1: [], msg2: ['e', 'ee', 'se'] }), false);
    assert.strictEqual(fn({ msg1: ['e', 'es', 's', 'ss'], msg2: [] }), false);

    // Insert / custom tokens.
    assert.strictEqual(
      fn({ msg1: ['e', 'es', 's', 'ss', 'psk'], msg2: ['e', 'ee', 'se'] }),
      false,
    );
    assert.strictEqual(
      fn({ msg1: ['e', 'es', 's', 'ss'], msg2: ['e', 'ee', 'se', 'ss'] }),
      false,
    );
    assert.strictEqual(
      fn({ msg1: ['e', 'es', 's', 'xx'], msg2: ['e', 'ee', 'se'] }),
      false,
    );
    assert.strictEqual(
      fn({ msg1: ['e', 'es', 's', 'ss'], msg2: ['e', 'ee', 'xx'] }),
      false,
    );
    assert.strictEqual(
      fn({ msg1: ['E', 'es', 's', 'ss'], msg2: ['e', 'ee', 'se'] }),
      false,
    );

    // Swap msg1/msg2 rows.
    assert.strictEqual(
      fn({ msg1: ['e', 'ee', 'se'], msg2: ['e', 'es', 's', 'ss'] }),
      false,
    );
  });

  it('rejects malformed top records and rows (shape / sparse / extra enumerable)', () => {
    const fn = protocol.matchesCrossLanNoiseIkTokenSequence;
    const base = createCanonicalTokenSequenceInput();

    // Top-level missing / extra / wrong type.
    assert.strictEqual(fn(null), false);
    assert.strictEqual(fn(undefined), false);
    assert.strictEqual(fn([]), false);
    assert.strictEqual(fn('msg1'), false);
    assert.strictEqual(fn(42), false);
    assert.strictEqual(fn({ msg1: base.msg1 }), false);
    assert.strictEqual(fn({ msg2: base.msg2 }), false);
    assert.strictEqual(fn({ ...base, extra: true }), false);
    assert.strictEqual(fn({ msg1: base.msg1, msg2: base.msg2, msg3: [] }), false);

    // Symbol own key.
    const withSymbol = { ...base };
    withSymbol[Symbol('x')] = true;
    assert.strictEqual(fn(withSymbol), false);

    // Non-enumerable own data property.
    const nonEnum = { ...base };
    Object.defineProperty(nonEnum, 'msg1', {
      value: base.msg1,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    assert.strictEqual(fn(nonEnum), false);

    // Accessor top-level property.
    const withAccessor = {};
    Object.defineProperty(withAccessor, 'msg1', {
      get() {
        return base.msg1;
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(withAccessor, 'msg2', {
      value: base.msg2,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    assert.strictEqual(fn(withAccessor), false);

    // Non-plain top records.
    assert.strictEqual(fn(Object.create({ msg1: base.msg1, msg2: base.msg2 })), false);
    assert.strictEqual(fn(new Date()), false);
    assert.strictEqual(fn(new Map()), false);

    // Row not array / wrong types.
    assert.strictEqual(fn({ msg1: 'e,es,s,ss', msg2: base.msg2 }), false);
    assert.strictEqual(fn({ msg1: base.msg1, msg2: 'e,ee,se' }), false);
    assert.strictEqual(fn({ msg1: { 0: 'e', 1: 'es', 2: 's', 3: 'ss', length: 4 }, msg2: base.msg2 }), false);
    assert.strictEqual(
      fn({ msg1: ['e', 'es', 's', new String('ss')], msg2: base.msg2 }),
      false,
    );
    assert.strictEqual(
      fn({ msg1: base.msg1, msg2: ['e', 'ee', 0] }),
      false,
    );

    // Sparse rows (Object.keys length < expected length).
    const sparseMsg1 = [];
    sparseMsg1[0] = 'e';
    sparseMsg1[1] = 'es';
    sparseMsg1[3] = 'ss';
    sparseMsg1.length = 4;
    assert.strictEqual(fn({ msg1: sparseMsg1, msg2: base.msg2 }), false);

    const sparseMsg2 = [];
    sparseMsg2[0] = 'e';
    sparseMsg2[2] = 'se';
    sparseMsg2.length = 3;
    assert.strictEqual(fn({ msg1: base.msg1, msg2: sparseMsg2 }), false);

    // Extra enumerable string own property on row (Object.keys length check).
    const extraPropMsg1 = ['e', 'es', 's', 'ss'];
    extraPropMsg1.meta = 'x';
    assert.strictEqual(fn({ msg1: extraPropMsg1, msg2: base.msg2 }), false);
    const extraPropMsg2 = ['e', 'ee', 'se'];
    extraPropMsg2.note = 'y';
    assert.strictEqual(fn({ msg1: base.msg1, msg2: extraPropMsg2 }), false);
  });

  it('returns false without throwing for throwing / revoked top and row Proxies', () => {
    const fn = protocol.matchesCrossLanNoiseIkTokenSequence;
    const base = createCanonicalTokenSequenceInput();

    const throwingTop = new Proxy(
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

    const throwingRow = new Proxy(
      ['e', 'es', 's', 'ss'],
      {
        get() {
          throw new Error(SENTINEL_SECRET);
        },
        ownKeys() {
          throw new Error(SENTINEL_SECRET);
        },
        getOwnPropertyDescriptor() {
          throw new Error(SENTINEL_SECRET);
        },
      },
    );

    const { proxy: revokedTop, revoke: revokeTop } = Proxy.revocable(base, {});
    revokeTop();
    const { proxy: revokedRow, revoke: revokeRow } = Proxy.revocable(
      ['e', 'es', 's', 'ss'],
      {},
    );
    revokeRow();

    assert.doesNotThrow(() => {
      assert.strictEqual(fn(throwingTop), false);
      assert.strictEqual(fn(revokedTop), false);
      assert.strictEqual(fn({ msg1: throwingRow, msg2: base.msg2 }), false);
      assert.strictEqual(fn({ msg1: base.msg1, msg2: revokedRow }), false);
    });
    // Transparent Proxy residual risk is not required to reject.
  });
});
