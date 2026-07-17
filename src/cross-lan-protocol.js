/**
 * Linke V2 control-plane protocol scaffold (T1.2–T1.3 / M1).
 *
 * T1.2: field-level + nested field-shape only (control-plane message schemas).
 * T1.3: pure session-state transition table + reducer (no side effects).
 *
 * NOT a security, crypto, wire-encoding, or semantic validator.
 * Does not verify nonces, MACs/signatures, times, uint64 ranges,
 * binary encodings, trust state, or AEAD.
 * Does not open network sockets, timers, or persistence.
 *
 * T1.0 Noise library selection gate remains BLOCKED.
 * This module does not claim Noise / E2EE / cross-LAN / M1 readiness.
 *
 * Keepalive types are Noise AEAD application-layer messages with empty
 * payloads — not RFC6455 WebSocket ping/pong (transport timing is T1.9/M3).
 *
 * `signature` fields (relay-pin-set-update, controller-noise-key-update)
 * are controller Ed25519 signatures over canonical TBS in later tasks;
 * this module only checks field presence/shape.
 *
 * `keyConfirmClient` is the frozen camelCase mirror of spec `keyConfirmServer`
 * (design §6.7.2.5 client confirm transport message payload field name).
 */

/**
 * @param {string[]} requiredFields
 * @param {string[]} [optionalFields]
 * @param {Record<string, unknown>} [fixedValues]
 */
function freezeDescriptor(requiredFields, optionalFields = [], fixedValues = {}) {
  return Object.freeze({
    requiredFields: Object.freeze(requiredFields.slice()),
    optionalFields: Object.freeze(optionalFields.slice()),
    fixedValues: Object.freeze({ ...fixedValues }),
  });
}

/**
 * Frozen closed-set of control-plane message schemas.
 * Message type identity is Object.keys(this object) only — no second registry.
 * @type {Readonly<Record<string, {
 *   requiredFields: ReadonlyArray<string>,
 *   optionalFields: ReadonlyArray<string>,
 *   fixedValues: Readonly<Record<string, unknown>>,
 * }>>}
 */
export const CONTROL_PLANE_MESSAGE_SCHEMAS = Object.freeze({
  'noise-msg1-payload': freezeDescriptor([
    'deviceId',
    'enrollmentEpoch',
    'ed25519IdentityPub',
    'identityBindingSig',
    'clientNonce',
    'clientTimeUtc',
  ]),
  'noise-msg2-payload': freezeDescriptor(
    ['controllerId', 'enrollmentEpoch', 'serverNonce', 'serverTimeUtc', 'keyConfirmServer'],
    ['rekeyGeneration'],
    { rekeyGeneration: 0 },
  ),
  'key-confirm-client': freezeDescriptor(['keyConfirmClient']),
  'session-terminate': freezeDescriptor(['reason'], [], { reason: 'revoked' }),
  'revoke-epoch': freezeDescriptor(['deviceId', 'enrollmentEpoch', 'revokeGeneration']),
  'denylist-update': freezeDescriptor(['denylistVersion', 'entries']),
  'denylist-ack': freezeDescriptor(['denylistVersion']),
  'relay-pin-set-update': freezeDescriptor([
    'relayId',
    'oldSpkiPins',
    'newSpkiPins',
    'notBefore',
    'graceUntil',
    'updateId',
    'trustEpoch',
    'signature',
  ]),
  'relay-pin-set-ack': freezeDescriptor(['updateId']),
  'controller-noise-key-update': freezeDescriptor([
    'oldNoiseStaticPub',
    'newNoiseStaticPub',
    'notBefore',
    'graceUntil',
    'trustEpoch',
    'updateId',
    'signature',
  ]),
  'controller-noise-key-ack': freezeDescriptor(['updateId']),
  'keepalive-ping': freezeDescriptor([]),
  'keepalive-pong': freezeDescriptor([]),
});

/**
 * Nested L1 denylist entry field groups (shape only).
 * @type {Readonly<{
 *   identifierFields: ReadonlyArray<string>,
 *   generationFields: ReadonlyArray<string>,
 * }>}
 */
export const DENYLIST_ENTRY_SCHEMA = Object.freeze({
  identifierFields: Object.freeze(['tunnelId', 'deviceRoutingHandle']),
  generationFields: Object.freeze(['epoch', 'revokeGeneration']),
});

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isPlainRecord(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Reject symbols, non-enumerable own keys, and accessor properties.
 * @param {object} record
 * @returns {string[] | null} string own keys, or null if invalid
 */
function getExactOwnStringDataKeys(record) {
  const ownKeys = Reflect.ownKeys(record);
  /** @type {string[]} */
  const stringKeys = [];
  for (const key of ownKeys) {
    if (typeof key === 'symbol') return null;
    const desc = Object.getOwnPropertyDescriptor(record, key);
    if (!desc || desc.enumerable !== true) return null;
    if (desc.get !== undefined || desc.set !== undefined) return null;
    stringKeys.push(key);
  }
  return stringKeys;
}

/**
 * Nested denylist entry: exactly one identifier field + one generation field.
 * Does not validate value types or wire encoding.
 * @param {unknown} entry
 * @returns {boolean}
 */
export function hasExactDenylistEntryFields(entry) {
  try {
    if (!isPlainRecord(entry)) return false;
    const keys = getExactOwnStringDataKeys(entry);
    if (keys === null || keys.length !== 2) return false;

    const keySet = new Set(keys);
    let idCount = 0;
    for (const f of DENYLIST_ENTRY_SCHEMA.identifierFields) {
      if (keySet.has(f)) idCount += 1;
    }
    let genCount = 0;
    for (const f of DENYLIST_ENTRY_SCHEMA.generationFields) {
      if (keySet.has(f)) genCount += 1;
    }
    return idCount === 1 && genCount === 1;
  } catch {
    return false;
  }
}

/**
 * Field-shape exactness for a control-plane message payload.
 * Returns boolean only; never throws; never echoes input.
 * NOT a security/crypto/wire/semantic validator.
 * @param {string} messageType
 * @param {unknown} payload
 * @returns {boolean}
 */
export function hasExactControlPlaneMessageFields(messageType, payload) {
  try {
    if (typeof messageType !== 'string') return false;
    // Own-key only: reject Object.prototype names (toString/constructor/__proto__/…).
    // Do not use truthy schema lookup — inherited names must never fail-open.
    if (!Object.hasOwn(CONTROL_PLANE_MESSAGE_SCHEMAS, messageType)) return false;
    const schema = CONTROL_PLANE_MESSAGE_SCHEMAS[messageType];
    if (!isPlainRecord(payload)) return false;

    const ownKeys = getExactOwnStringDataKeys(payload);
    if (ownKeys === null) return false;

    /** @type {Set<string>} */
    const allowed = new Set([
      ...schema.requiredFields,
      ...schema.optionalFields,
      ...Object.keys(schema.fixedValues),
    ]);

    for (const key of ownKeys) {
      if (!allowed.has(key)) return false;
    }

    for (const req of schema.requiredFields) {
      if (!ownKeys.includes(req)) return false;
    }

    for (const [fixedKey, fixedValue] of Object.entries(schema.fixedValues)) {
      if (ownKeys.includes(fixedKey)) {
        if (!Object.is(payload[fixedKey], fixedValue)) return false;
      }
    }

    if (messageType === 'denylist-update') {
      const entries = payload.entries;
      if (!Array.isArray(entries)) return false;
      for (const item of entries) {
        if (!hasExactDenylistEntryFields(item)) return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Frozen closed-set of cross-LAN session state transitions (T1.3).
 *
 * Events `key-confirmed` / `rekey-confirmed` are runtime-synthesized only
 * after verified auth/MAC — not raw control-plane message type names.
 *
 * `fail` → `failed` does not destroy keys, write audit, or close sockets
 * here; future session runtime owns those side effects and eventual close.
 *
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
export const CROSS_LAN_SESSION_TRANSITIONS = Object.freeze({
  idle: Object.freeze({ 'start-handshake': 'handshaking', close: 'closed' }),
  handshaking: Object.freeze({ 'key-confirmed': 'established', fail: 'failed', close: 'closed' }),
  established: Object.freeze({ 'start-rekey': 'rekeying', fail: 'failed', close: 'closed' }),
  rekeying: Object.freeze({ 'rekey-confirmed': 'established', fail: 'failed', close: 'closed' }),
  failed: Object.freeze({ close: 'closed' }),
  closed: Object.freeze({}),
});

/**
 * Pure session-state reducer: look up the next state for (currentState, event).
 *
 * Returns the frozen target state string on a legal edge; otherwise `null`.
 * Callers must treat `null` as "no transition" — never as success.
 * Never throws; never echoes inputs; no mutable session object; no side effects.
 *
 * Event synthesis rules (T1.3 does **not** implement verification):
 * - `key-confirmed` may be emitted only by future session runtime after
 *   **both** server and client key confirmation / MAC checks succeed.
 * - `rekey-confirmed` may be emitted only after an authenticated rekey
 *   completes successfully.
 * - Raw control-plane message types (e.g. `key-confirm-client`,
 *   `noise-msg2-payload`, `msg2-received`, `handshake-complete`) must
 *   **never** be passed as events to advance this table.
 *
 * Side effects for `fail` → `failed` (key wipe, audit, eventual close) and
 * transport close are owned by future runtime — not this reducer.
 *
 * @param {unknown} currentState
 * @param {unknown} event
 * @returns {string | null}
 */
export function getNextCrossLanSessionState(currentState, event) {
  try {
    if (typeof currentState !== 'string' || typeof event !== 'string') return null;
    // Own-key only: reject Object.prototype names via inherited lookup.
    if (!Object.hasOwn(CROSS_LAN_SESSION_TRANSITIONS, currentState)) return null;
    const row = CROSS_LAN_SESSION_TRANSITIONS[currentState];
    if (!Object.hasOwn(row, event)) return null;
    return row[event];
  } catch {
    return null;
  }
}
