import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  CONTROL_PLANE_MESSAGE_SCHEMAS,
  DENYLIST_ENTRY_SCHEMA,
  hasExactControlPlaneMessageFields,
  hasExactDenylistEntryFields,
} from '../src/cross-lan-protocol.js';
// Namespace import so missing T1.3 named exports do not break T1.2 load-time.
import * as protocol from '../src/cross-lan-protocol.js';

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
