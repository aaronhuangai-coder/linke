import { ERROR_CODES } from './error-codes.js';

/**
 * Linke V2 control-plane protocol scaffold (T1.2–T1.14 / T1.16 / M1).
 *
 * T1.2: field-level + nested field-shape only (control-plane message schemas).
 * T1.3: pure session-state transition table + reducer (no side effects).
 * T1.4: pure strictly-forward sequence predicate (no window / no state).
 * T1.5: pure protocol profile allowlist (exact six-field shape + values only).
 * T1.6: pure deviceId algebraic consistency (three caller-supplied strings only).
 * T1.7: pure clock-skew policy + configuration resolver + window predicate.
 * T1.8: declarative session-construction boundary (lifecycle execute/authorize hard-false only).
 * T1.9: pure capacity / keepalive / data-resume policy constants + pure
 *       configuration resolvers + pure liveness classification / timeout
 *       decision only (no timers, sockets, random/jitter, sleep, persistence,
 *       or runtime wiring).
 * T1.10: pure Noise suite / protocol_name / prologue policy / domain-label
 *        constants + pure protocol_name / prologue byte encoders only
 *        (no Noise handshake, hash, HKDF, ChaCha, or X25519; does not include
 *        Noise IK token-sequence contract — T1.12a provides that scaffold).
 * T1.12a: non-crypto Noise IK token-sequence scaffold only (frozen msg1/msg2
 *         token order table + pure sequence matcher). T1.12 fixed vectors
 *         remain NOT READY / NOT COMPLETE.
 * T1.13: enrollment secret lifecycle / delivery / clipboard contracts live in
 *        the independent enrollment module (`cross-lan-enrollment-contract`),
 *        not in this file.
 * T1.14: pure counter reservation / receive-window / trustEpoch contract only
 *        (BigInt uint64 semantic constants + pure decision/predicate; no
 *        dataDir, fsync, reservation execution, session, ack, signature /
 *        authority verification, or wire encoding).
 * T1.16: pure relay pin-set update message semantic contract + fail-closed
 *        preserve-old-pin predicate (A21/A22 contract-level only). Reuses
 *        T1.2 frozen requiredFields and T1.14 trustEpoch reject predicate.
 *        Caller claims (E2EE / signature / time window / old-set match /
 *        persistence) are **not** runtime proof. Does **not** perform real
 *        signature verification, E2EE verification, wall-clock / Date.parse,
 *        current-old-set lookup, persistence, ack emission, grace expiry, or
 *        TLS/pin I/O. Does **not** implement `revokeOldImmediately` (exact
 *        matcher rejects it). A21/A22 runtime remains not-ready.
 *
 * NOT a security, crypto, wire-encoding, or full semantic validator.
 * Does not verify nonces, MACs/signatures, times, binary encodings, trust
 * state, or AEAD.
 * Old control-plane shape validators do **not** verify uint64 ranges; only
 * T1.14's new pure APIs validate their input BigInt uint64 semantics, and
 * they are still **not** wire validators.
 * Does not open network sockets, timers, or persistence.
 *
 * T1.0 Noise library selection gate remains BLOCKED (not M1 crypto PASS).
 * This module does not claim Noise / E2EE / cross-LAN / M1 readiness.
 * T1.12a does not load fixtures, verify ciphertext/handshake hash, bind a
 * Noise library, or execute DH/AEAD/hash/handshake.
 * T1.14 does not claim A18 / counter persistence / authority verification /
 * M1 crypto readiness.
 * T1.16 does not claim A21/A22 runtime readiness or pin-set apply/ack side
 * effects.
 *
 * Keepalive types are Noise AEAD application-layer messages with empty
 * payloads — not RFC6455 WebSocket ping/pong (transport timing is M3).
 *
 * `signature` fields (relay-pin-set-update, controller-noise-key-update)
 * are controller Ed25519 signatures over canonical TBS in later tasks;
 * T1.2 only checks field presence/shape; T1.16 checks nonempty string shape
 * for `signature` but still does **not** verify Ed25519.
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

/**
 * Pure strictly-forward sequence primitive (T1.4).
 *
 * The name means only: given a pre-computed nonce-match flag and two bigint
 * counters, is `sequence` strictly greater than `highestAcceptedSequence`?
 * It is **not** a complete replay guard, freshness check, security oracle,
 * receive-window enforcer, or high-watermark mutator.
 *
 * Honesty / composition contract:
 * - `sessionNonceMatched` must be produced by a future runtime **secure nonce
 *   byte comparison**. This function never compares nonce bytes.
 * - T1.0 Noise library selection remains BLOCKED; do not wire this predicate
 *   to live network accept paths until that gate is unblocked and a real
 *   session runtime owns verification + state.
 * - After a true result, the caller still must update the accepted
 *   high-watermark in order / atomically; this function never mutates state.
 * - T1.14 adds receive-window upper bound, uint64 max, and reservation
 *   contracts as separate pure APIs; that layer still does not admit
 *   `sequence <= highestAcceptedSequence`. This primitive already rejects
 *   non-forward sequences and must stay that way.
 * - Wall-clock / skew is owned by an independent clock layer; this predicate
 *   never reads time fields (including `clientTimeUtc`).
 *
 * Implementation constraints: fail-closed try/catch; plain-record gate only;
 * direct property reads of the three named fields only — no enumeration of
 * `input`, no BigInt coercion, no window/uint64/persistence/error codes.
 *
 * @param {unknown} input
 * @returns {boolean}
 */
export function isStrictlyForwardSequence(input) {
  try {
    if (!isPlainRecord(input)) return false;

    // Direct named reads only — do not enumerate, do not touch clientTimeUtc.
    const sessionNonceMatched = input.sessionNonceMatched;
    const highestAcceptedSequence = input.highestAcceptedSequence;
    const sequence = input.sequence;

    if (sessionNonceMatched !== true) return false;
    if (typeof highestAcceptedSequence !== 'bigint') return false;
    if (typeof sequence !== 'bigint') return false;
    if (highestAcceptedSequence < 0n) return false;
    if (sequence < 0n) return false;

    return sequence > highestAcceptedSequence;
  } catch {
    return false;
  }
}

/**
 * Unique Noise suite / protocol_name ASCII text (T1.10 / §6.7.2.3).
 *
 * Single production source for both the Gold suite name and the Noise
 * `protocol_name` string mixed into the handshake hash. Not a crypto
 * implementation and not proof of Noise readiness (T1.0 remains BLOCKED).
 *
 * @type {string}
 */
export const CROSS_LAN_NOISE_PROTOCOL_NAME = 'Noise_IK_25519_ChaChaPoly_SHA256';

/**
 * Frozen Noise prologue construction policy (T1.10 / §6.7.2.3).
 *
 * Wire shape: `prefixAscii` UTF-8/ASCII bytes || protocolVersion (uint16 BE)
 * || suiteId byte(s). Spec explicitly freezes the prefix, uint16 BE version,
 * and suiteId=1, but does **not** state suiteId width; T1.10 locks suiteId to
 * a single byte `0x01` so the exact-byte encoder contract is complete. A future
 * spec revision that changes width/value must update this frozen contract
 * explicitly — silent drift is forbidden.
 *
 * Does **not** define or guess a current protocolVersion. Pure encoders accept
 * the full uint16 range including 0.
 *
 * @type {Readonly<{
 *   prefixAscii: string,
 *   protocolVersionByteLength: number,
 *   protocolVersionByteOrder: string,
 *   suiteId: number,
 *   suiteIdByteLength: number,
 * }>}
 */
export const CROSS_LAN_NOISE_PROLOGUE_POLICY = Object.freeze({
  prefixAscii: 'linke-v2/cross-lan/noise-ik/v1',
  protocolVersionByteLength: 2,
  protocolVersionByteOrder: 'BE',
  suiteId: 1,
  suiteIdByteLength: 1,
});

/**
 * Frozen application domain-separation labels (T1.10 / §6.7.2.3).
 *
 * Exactly seven JS keys mapped 1:1 to the seven Gold ASCII labels used when
 * deriving business keys after Noise/HKDF export. Keys are local names only —
 * they add no extra protocol semantics. No domain-bytes encoder is provided.
 *
 * @type {Readonly<{
 *   handshake: string,
 *   trafficControllerToDevice: string,
 *   trafficDeviceToController: string,
 *   rekey: string,
 *   keyConfirm: string,
 *   dataChunkMac: string,
 *   relayCapability: string,
 * }>}
 */
export const CROSS_LAN_DOMAIN_SEPARATION_LABELS = Object.freeze({
  handshake: 'linke-v2/e2ee/handshake',
  trafficControllerToDevice: 'linke-v2/e2ee/traffic-c2d',
  trafficDeviceToController: 'linke-v2/e2ee/traffic-d2c',
  rekey: 'linke-v2/e2ee/rekey',
  keyConfirm: 'linke-v2/e2ee/key-confirm',
  dataChunkMac: 'linke-v2/data/chunk-mac',
  relayCapability: 'linke-v2/relay-cap',
});

/**
 * Encode the unique Noise protocol_name as fresh ASCII bytes (T1.10).
 *
 * Returns a new `Uint8Array` owned by the caller each call. The typed array is
 * mutable; “frozen bytes” means the wire byte contract is locked by the string
 * constant + dual-source tests, not that the returned memory is immutable
 * (Node throws on `Object.freeze` of non-empty TypedArrays).
 *
 * Pure encoder only — no Noise handshake, hash, or library wiring.
 * T1.0 remains BLOCKED.
 *
 * @returns {Uint8Array}
 */
export function encodeCrossLanNoiseProtocolNameBytes() {
  return new TextEncoder().encode(CROSS_LAN_NOISE_PROTOCOL_NAME);
}

/**
 * Encode Noise prologue bytes for a caller-supplied protocolVersion (T1.10).
 *
 * Accepts only a primitive Number safe integer in 0..65535 inclusive; any
 * other input returns `null` (never coerce, never throw). Version is written
 * as uint16 big-endian. Suite id is the single locked byte `0x01` from
 * `CROSS_LAN_NOISE_PROLOGUE_POLICY` (see policy JSDoc for the width honesty
 * note). Version 0 is legal — the spec freezes uint16 encoding and does not
 * forbid 0. Does not guess a current protocolVersion.
 *
 * Returns a fresh caller-owned mutable `Uint8Array` on success. “Frozen bytes”
 * is the wire contract locked by policy + tests, not returned-memory immutability.
 *
 * Pure encoder only — no Noise handshake/hash/HKDF. T1.0 remains BLOCKED.
 *
 * @param {unknown} protocolVersion
 * @returns {Uint8Array | null}
 */
export function encodeCrossLanNoisePrologueBytes(protocolVersion) {
  try {
    if (typeof protocolVersion !== 'number') return null;
    if (!Number.isSafeInteger(protocolVersion)) return null;
    if (protocolVersion < 0 || protocolVersion > 65535) return null;

    const prefix = new TextEncoder().encode(
      CROSS_LAN_NOISE_PROLOGUE_POLICY.prefixAscii,
    );
    const out = new Uint8Array(prefix.length + 2 + 1);
    out.set(prefix, 0);
    out[prefix.length] = (protocolVersion >>> 8) & 0xff;
    out[prefix.length + 1] = protocolVersion & 0xff;
    out[prefix.length + 2] = CROSS_LAN_NOISE_PROLOGUE_POLICY.suiteId & 0xff;
    return out;
  } catch {
    return null;
  }
}

/**
 * T1.5 pure profile allowlist only: is the input exactly the single allowed
 * cross-LAN protocol profile record (shape + values)?
 *
 * Profile requirements / self-declared requirements — not runtime proof:
 * - `mutualAuthenticationRequired` and `independentE2eeRequired` are profile
 *   boolean requirements (self-declared), not proof that mutual auth or
 *   independent E2EE actually ran.
 * - Relay is a transport-only opaque forwarder. It MUST NOT participate in
 *   endpoint↔controller E2E KE/KDF, contribute/mix/store E2E secrets, or
 *   reuse/export relay TLS session keys as payload E2EE. Relay TLS
 *   (`relayTransport` / `tlsVersion` / `tcpPort` / WSS / TLS 1.3) protects
 *   each hop only and never satisfies `independentE2eeRequired`; the
 *   endpoint↔controller Noise layer remains required. T1.0 is currently
 *   BLOCKED.
 * - This predicate checks only an exact self-declared profile. A `true`
 *   result does not prove the relay/runtime obeys those boundaries or that
 *   Noise/E2EE ran.
 *
 * This function does **not** prove WSS framing, TLS/socket/443 liveness,
 * SPKI pin, Noise IK handshake, mutual authentication, key confirmation,
 * or protocol_name / prologue / domain binding.
 *
 * T1.0 Noise library selection gate remains BLOCKED. Do not wire this
 * predicate to production connection accept paths, and do not claim
 * Noise / E2EE / cross-LAN / M1 readiness from a true result.
 *
 * Pure ECMAScript cannot reliably detect transparent Proxies. Throwing and
 * revoked Proxies fail closed (return false, never throw). Transparent
 * Proxies remain a residual risk: future callers past a trust boundary must
 * still canonicalize/freeze profile data and must not keep using mutable
 * original input after a true result.
 *
 * Suite / protocol_name is the single exported constant
 * `CROSS_LAN_NOISE_PROTOCOL_NAME` (T1.10). Prologue / domain labels live on
 * their own T1.10 exports; this predicate still only checks the six-field
 * profile record and does not bind prologue or domain bytes.
 *
 * Implementation: ordinary object (prototype Object.prototype or null);
 * own keys exactly six string enumerable data properties; exact value match
 * via Object.is / strict equality only — no JSON.stringify, coercion, regex,
 * or normalization. Fail-closed try/catch.
 *
 * @param {unknown} input
 * @returns {boolean}
 */
export function isAllowedCrossLanProtocolProfile(input) {
  try {
    if (!isPlainRecord(input)) return false;

    const keys = getExactOwnStringDataKeys(input);
    if (keys === null || keys.length !== 6) return false;

    const keySet = new Set(keys);
    if (
      !keySet.has('noiseSuite') ||
      !keySet.has('mutualAuthenticationRequired') ||
      !keySet.has('independentE2eeRequired') ||
      !keySet.has('relayTransport') ||
      !keySet.has('tlsVersion') ||
      !keySet.has('tcpPort')
    ) {
      return false;
    }

    // Unique allowed profile values; suite name from T1.10 single source.
    if (input.noiseSuite !== CROSS_LAN_NOISE_PROTOCOL_NAME) return false;
    if (input.mutualAuthenticationRequired !== true) return false;
    if (input.independentE2eeRequired !== true) return false;
    if (input.relayTransport !== 'wss') return false;
    if (input.tlsVersion !== '1.3') return false;
    if (input.tcpPort !== 443) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * T1.6 pure deviceId algebraic consistency only: are the three caller-supplied
 * deviceId strings exactly equal as primitive non-empty code-unit strings?
 *
 * Proves **only** algebraic equality of the three values the caller provided.
 * It does **not** verify provenance. If a caller copies the same unverified
 * payload into all three fields, this function still returns true — that is
 * never a security proof of identity, authentication, or authorization.
 *
 * Provenance contract (caller's responsibility; this function does not check):
 * - `authenticatedDeviceId` — from a future verified token + enrollment binding
 * - `sessionDeviceId` — from a future session key/context
 * - `messageDeviceId` — extracted only after decryption from transcript/AAD/payload
 *
 * Do **not** call during early handshake stages that lack `messageDeviceId`.
 *
 * This function does **not** check enrollmentEpoch / revokeGeneration /
 * trustEpoch, resource ACL/permissions, or token/Noise/AAD material itself.
 * `resourceDeviceId` is intentionally absent from this API; full A15 resource
 * authorization remains M3 follow-on.
 *
 * T1.0 Noise library selection gate remains BLOCKED. Do not wire this
 * predicate to production accept / authorization / data-visibility paths, and
 * do not claim complete A15 / Noise / E2EE / cross-LAN / M1 / runtime readiness
 * from a true result.
 *
 * Pure ECMAScript cannot reliably detect transparent Proxies. Throwing and
 * revoked Proxies fail closed (return false, never throw). Transparent Proxies
 * remain a residual risk: future callers past a trust boundary must still
 * canonicalize/freeze the three IDs and must not keep trusting mutable
 * original input after a true result.
 *
 * Implementation: ordinary object (prototype Object.prototype or null); own
 * keys exactly three string enumerable data properties named
 * authenticatedDeviceId / sessionDeviceId / messageDeviceId; each value a
 * primitive string with length > 0; all three compared with strict `===` only
 * — no trim, normalize, case-fold, coerce, JSON, or stringify. Fail-closed
 * try/catch.
 *
 * @param {unknown} input
 * @returns {boolean}
 */
export function hasConsistentCrossLanDeviceIds(input) {
  try {
    if (!isPlainRecord(input)) return false;

    const keys = getExactOwnStringDataKeys(input);
    if (keys === null || keys.length !== 3) return false;

    const keySet = new Set(keys);
    if (
      !keySet.has('authenticatedDeviceId') ||
      !keySet.has('sessionDeviceId') ||
      !keySet.has('messageDeviceId')
    ) {
      return false;
    }

    const authenticatedDeviceId = input.authenticatedDeviceId;
    const sessionDeviceId = input.sessionDeviceId;
    const messageDeviceId = input.messageDeviceId;

    if (typeof authenticatedDeviceId !== 'string') return false;
    if (typeof sessionDeviceId !== 'string') return false;
    if (typeof messageDeviceId !== 'string') return false;

    if (authenticatedDeviceId.length === 0) return false;
    if (sessionDeviceId.length === 0) return false;
    if (messageDeviceId.length === 0) return false;

    // Exact code-unit equality only — no trim/normalize/case-fold/coerce.
    return (
      authenticatedDeviceId === sessionDeviceId &&
      sessionDeviceId === messageDeviceId
    );
  } catch {
    return false;
  }
}

/**
 * Frozen cross-LAN clock-skew policy (T1.7).
 *
 * Single production source for default/min/max seconds and the error code
 * used when a future runtime maps a confirmed schema-valid over-window
 * rejection. errorCode is taken from ERROR_CODES — not a copied string.
 *
 * @type {Readonly<{
 *   defaultSeconds: number,
 *   minSeconds: number,
 *   maxSeconds: number,
 *   errorCode: string,
 * }>}
 */
export const CROSS_LAN_CLOCK_SKEW_POLICY = Object.freeze({
  defaultSeconds: 120,
  minSeconds: 30,
  maxSeconds: 600,
  errorCode: ERROR_CODES.DEVICE_CLOCK_SKEW,
});

/**
 * Module-private decision freezer for resolveCrossLanClockSkewConfiguration.
 * Always returns a fresh frozen object; not a second policy/registry export.
 *
 * @param {boolean} configurationAccepted
 * @param {boolean} usedDefault
 * @param {number} allowedSkewSeconds
 * @returns {Readonly<{
 *   configurationAccepted: boolean,
 *   usedDefault: boolean,
 *   allowedSkewSeconds: number,
 * }>}
 */
function freezeClockSkewConfigurationDecision(
  configurationAccepted,
  usedDefault,
  allowedSkewSeconds,
) {
  return Object.freeze({
    configurationAccepted,
    usedDefault,
    allowedSkewSeconds,
  });
}

/**
 * Resolve a caller-supplied clock-skew configuration into a frozen decision.
 *
 * Pure configuration gate only — no runtime reporting, no network, no I/O.
 *
 * Decision semantics:
 * - `undefined` → accepted default path (`usedDefault: true`, 120s).
 * - primitive Number safe integer in [30, 600] inclusive → accepted explicit
 *   value (`usedDefault: false`, that value).
 * - any other input (including objects / Proxies) → rejected fallback
 *   (`configurationAccepted: false`, `usedDefault: true`, 120s). Properties
 *   of objects/Proxies are never read; no coercion.
 *
 * **Honesty boundary:** `configurationAccepted: false` means the configured
 * value was rejected. A future caller **must** report/reject that bad config
 * before using the default; it must not treat `usedDefault: true` alone as
 * silent acceptance. T1.7 freezes that responsibility but does not implement
 * runtime reporting.
 *
 * Never throws. Does not export a second policy or registry.
 *
 * @param {unknown} configuredSeconds
 * @returns {Readonly<{
 *   configurationAccepted: boolean,
 *   usedDefault: boolean,
 *   allowedSkewSeconds: number,
 * }>}
 */
export function resolveCrossLanClockSkewConfiguration(configuredSeconds) {
  try {
    if (configuredSeconds === undefined) {
      return freezeClockSkewConfigurationDecision(
        true,
        true,
        CROSS_LAN_CLOCK_SKEW_POLICY.defaultSeconds,
      );
    }

    // Primitive Number safe integer only — no coercion, no object unboxing.
    if (
      typeof configuredSeconds === 'number' &&
      Number.isSafeInteger(configuredSeconds) &&
      configuredSeconds >= CROSS_LAN_CLOCK_SKEW_POLICY.minSeconds &&
      configuredSeconds <= CROSS_LAN_CLOCK_SKEW_POLICY.maxSeconds
    ) {
      return freezeClockSkewConfigurationDecision(true, false, configuredSeconds);
    }

    return freezeClockSkewConfigurationDecision(
      false,
      true,
      CROSS_LAN_CLOCK_SKEW_POLICY.defaultSeconds,
    );
  } catch {
    return freezeClockSkewConfigurationDecision(
      false,
      true,
      CROSS_LAN_CLOCK_SKEW_POLICY.defaultSeconds,
    );
  }
}

/**
 * Pure clock-skew window predicate (T1.7).
 *
 * Given explicit endpoint/controller UTC ms and an allowed skew in seconds,
 * returns whether the absolute time difference is within the allowed window.
 *
 * `true` means **only**: exact three-field schema + both times are primitive
 * Number safe integers + allowed is a primitive Number safe integer in
 * [30, 600] + abs(endpoint − controller) ≤ allowed × 1000 ms.
 * It does **not** verify timestamp provenance, AAD binding, signatures, or
 * system-clock calibration.
 *
 * `false` mixes schema-invalid inputs and over-window cases. Only a future
 * runtime that has already confirmed schema-valid input and observed an
 * over-window result may map the rejection to
 * `CROSS_LAN_CLOCK_SKEW_POLICY.errorCode`. T1.7 does not invent an invalid
 * input classification or error taxonomy.
 *
 * Nonce / sequence remain the primary anti-replay defense. Future composition
 * must require clock-inside **and** sequence-forward; this module does not
 * export a combinator and does not wire production accept paths.
 *
 * T1.0 Noise library selection remains BLOCKED. Do not claim
 * replay / Noise / E2EE / cross-LAN / M1 / runtime readiness from a true result.
 *
 * Pure ECMAScript cannot reliably detect transparent Proxies. Throwing and
 * revoked Proxies fail closed (return false, never throw). Transparent Proxies
 * remain a residual risk: future trust-boundary callers must still
 * canonicalize/freeze inputs and must not keep trusting mutable originals
 * after a true result.
 *
 * Implementation: ordinary object; own keys exactly the three named string
 * enumerable data properties; values validated as above; absolute difference
 * computed with BigInt after validation. Never reads Date.now / clientTimeUtc;
 * never Date.parse; no logging / network / crypto / sequence calls.
 * Fail-closed try/catch.
 *
 * @param {unknown} input
 * @returns {boolean}
 */
export function isWithinCrossLanClockSkew(input) {
  try {
    if (!isPlainRecord(input)) return false;

    const keys = getExactOwnStringDataKeys(input);
    if (keys === null || keys.length !== 3) return false;

    const keySet = new Set(keys);
    if (
      !keySet.has('endpointTimeUtcMs') ||
      !keySet.has('controllerTimeUtcMs') ||
      !keySet.has('allowedSkewSeconds')
    ) {
      return false;
    }

    const endpointTimeUtcMs = input.endpointTimeUtcMs;
    const controllerTimeUtcMs = input.controllerTimeUtcMs;
    const allowedSkewSeconds = input.allowedSkewSeconds;

    // Primitive Number safe integers only — times may be negative; no coercion.
    if (typeof endpointTimeUtcMs !== 'number' || !Number.isSafeInteger(endpointTimeUtcMs)) {
      return false;
    }
    if (typeof controllerTimeUtcMs !== 'number' || !Number.isSafeInteger(controllerTimeUtcMs)) {
      return false;
    }
    if (typeof allowedSkewSeconds !== 'number' || !Number.isSafeInteger(allowedSkewSeconds)) {
      return false;
    }
    if (
      allowedSkewSeconds < CROSS_LAN_CLOCK_SKEW_POLICY.minSeconds ||
      allowedSkewSeconds > CROSS_LAN_CLOCK_SKEW_POLICY.maxSeconds
    ) {
      return false;
    }

    // BigInt after validation so MAX_SAFE − MIN_SAFE abs stays exact.
    const endpoint = BigInt(endpointTimeUtcMs);
    const controller = BigInt(controllerTimeUtcMs);
    const absDiff = endpoint >= controller ? endpoint - controller : controller - endpoint;
    return absDiff <= BigInt(allowedSkewSeconds) * 1000n;
  } catch {
    return false;
  }
}

/**
 * T1.8 M1 declarative architecture contract only.
 *
 * Four hard-false flags map 1:1 to the current supervisor-lifecycle
 * execute / authorize entry surfaces:
 * - executeSupervisorLifecycleApply
 * - evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy
 * - buildSupervisorLifecycleGuardedRunnerExecutionGate
 * - authorizeSupervisorLifecycleGuardedRunnerCapabilityMode
 *
 * This module does not import or call supervisor-lifecycle. It does not
 * create a session builder, DI hook, executor, authorization decision, or
 * host mutation. No generalized hostMutationAllowed field and no helper
 * functions are added.
 *
 * The constant alone cannot prove future M2/M3 session-builder runtime
 * zero-call. When a builder appears, DI / call-count sentinels must cover
 * happy and failure paths.
 *
 * T1.0 Noise library selection gate remains BLOCKED. No network, crypto, or
 * runtime surface. Does not claim session / A15 / Gold readiness.
 *
 * @type {Readonly<{
 *   executeSupervisorLifecycleApplyAllowed: false,
 *   evaluateSupervisorLifecycleGuardedRunnerExecutionPolicyAllowed: false,
 *   buildSupervisorLifecycleGuardedRunnerExecutionGateAllowed: false,
 *   authorizeSupervisorLifecycleGuardedRunnerCapabilityModeAllowed: false,
 * }>}
 */
export const CROSS_LAN_SESSION_CONSTRUCTION_BOUNDARY = Object.freeze({
  executeSupervisorLifecycleApplyAllowed: false,
  evaluateSupervisorLifecycleGuardedRunnerExecutionPolicyAllowed: false,
  buildSupervisorLifecycleGuardedRunnerExecutionGateAllowed: false,
  authorizeSupervisorLifecycleGuardedRunnerCapabilityModeAllowed: false,
});

/**
 * Deep-freeze a plain object graph (objects + arrays). Module-private helper
 * for T1.9 policy constants — not a public export.
 * @param {object} value
 * @returns {object}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return Object.freeze(value);
  }
  for (const key of Object.keys(value)) {
    deepFreeze(value[key]);
  }
  return Object.freeze(value);
}

/**
 * Frozen cross-LAN capacity and backpressure policy (T1.9 / §4.4).
 *
 * Single production source for control-queue, data-plane inflight, queue
 * separation, per-device rate/session/connection limits, relay inbound
 * connections, reconnect backoff strategy, and enrollment handshake rate.
 * All error codes are taken from ERROR_CODES — not copied strings.
 *
 * **Honesty boundary:** numeric values and negative invariants (e.g. queues
 * must not share offline structures, backup chunks must not enter the control
 * queue, P0 must not share bulk queue, busy-loop forbidden) are a frozen
 * contract that **future runtime** must honor. This constant does **not**
 * prove that queues, token buckets, backoff schedulers, or connection
 * limiters are wired. T1.9 freezes the strategy only.
 *
 * `reconnectBackoff.maximumDelayMs` is the final wall-clock upper bound;
 * future jitter **must not** produce a delay above 60s. T1.9 does **not**
 * implement a jitter algorithm or any backoff calculator (spec has not frozen
 * cap/jitter composition order).
 *
 * T1.0 Noise library selection remains BLOCKED. No timer / socket / random /
 * sleep / persistence / runtime wiring.
 *
 * @type {Readonly<{
 *   controlQueue: Readonly<{
 *     defaultMessageCountPerDevice: number,
 *     hardCeilingMessageCountPerDevice: number,
 *     defaultTotalBytesPerDevice: number,
 *     hardCeilingTotalBytesPerDevice: number,
 *     maximumMessageBytes: number,
 *     overflowErrorCode: string,
 *   }>,
 *   dataPlaneInflight: Readonly<{
 *     defaultBytesPerDevice: number,
 *     hardCeilingBytesPerDevice: number,
 *   }>,
 *   queueSeparation: Readonly<{
 *     priorityOrder: ReadonlyArray<string>,
 *     p0PersistentRingDefaultMessageCount: number,
 *     controlAndDataShareOfflineQueue: false,
 *     backupChunksAllowedInControlQueue: false,
 *     p0SharesBulkQueue: false,
 *   }>,
 *   perDeviceRate: Readonly<{
 *     defaultMessagesPerSecond: number,
 *     hardCeilingMessagesPerSecond: number,
 *     defaultBurstMessages: number,
 *     hardCeilingBurstMessages: number,
 *     errorCode: string,
 *   }>,
 *   perDeviceSessions: Readonly<{
 *     defaultConcurrentSessions: number,
 *     defaultActiveSessions: number,
 *     defaultDrainingSessions: number,
 *     hardCeilingConcurrentSessions: number,
 *     errorCode: string,
 *   }>,
 *   perDeviceConnections: Readonly<{
 *     defaultConcurrentConnectionsIncludingHandshake: number,
 *     hardCeilingConcurrentConnectionsIncludingHandshake: number,
 *   }>,
 *   relayInboundConnections: Readonly<{
 *     defaultPerController: number,
 *     hardCeilingPerController: number,
 *   }>,
 *   reconnectBackoff: Readonly<{
 *     initialDelayMs: number,
 *     multiplier: number,
 *     maximumDelayMs: number,
 *     jitterFraction: number,
 *     busyLoopAllowed: false,
 *     errorCode: string,
 *   }>,
 *   enrollmentHandshakeRate: Readonly<{
 *     defaultAttemptsPerMinutePerSourceFingerprint: number,
 *     hardCeilingAttemptsPerMinutePerSourceFingerprint: number,
 *     errorCode: string,
 *   }>,
 * }>}
 */
export const CROSS_LAN_CAPACITY_POLICY = deepFreeze({
  controlQueue: {
    defaultMessageCountPerDevice: 256,
    hardCeilingMessageCountPerDevice: 1024,
    defaultTotalBytesPerDevice: 1_048_576,
    hardCeilingTotalBytesPerDevice: 4_194_304,
    maximumMessageBytes: 65_536,
    overflowErrorCode: ERROR_CODES.CONTROL_QUEUE_OVERFLOW,
  },
  dataPlaneInflight: {
    defaultBytesPerDevice: 67_108_864,
    hardCeilingBytesPerDevice: 268_435_456,
  },
  queueSeparation: {
    priorityOrder: [
      'P0 revoke/security',
      'P1 session-control',
      'P2 status',
      'P3 bulk-data-signal',
    ],
    p0PersistentRingDefaultMessageCount: 64,
    controlAndDataShareOfflineQueue: false,
    backupChunksAllowedInControlQueue: false,
    p0SharesBulkQueue: false,
  },
  perDeviceRate: {
    defaultMessagesPerSecond: 30,
    hardCeilingMessagesPerSecond: 60,
    defaultBurstMessages: 60,
    hardCeilingBurstMessages: 120,
    errorCode: ERROR_CODES.DEVICE_RATE_LIMITED,
  },
  perDeviceSessions: {
    defaultConcurrentSessions: 2,
    defaultActiveSessions: 1,
    defaultDrainingSessions: 1,
    hardCeilingConcurrentSessions: 4,
    errorCode: ERROR_CODES.DEVICE_SESSION_LIMIT,
  },
  perDeviceConnections: {
    defaultConcurrentConnectionsIncludingHandshake: 4,
    hardCeilingConcurrentConnectionsIncludingHandshake: 8,
  },
  relayInboundConnections: {
    defaultPerController: 512,
    hardCeilingPerController: 2048,
  },
  reconnectBackoff: {
    initialDelayMs: 1000,
    multiplier: 2,
    maximumDelayMs: 60_000,
    jitterFraction: 0.2,
    busyLoopAllowed: false,
    errorCode: ERROR_CODES.RELAY_CONNECT_FAILED,
  },
  enrollmentHandshakeRate: {
    defaultAttemptsPerMinutePerSourceFingerprint: 10,
    hardCeilingAttemptsPerMinutePerSourceFingerprint: 30,
    errorCode: ERROR_CODES.ENROLLMENT_RATE_LIMITED,
  },
});

/**
 * Frozen cross-LAN keepalive / session-liveness policy (T1.9 / §6.12 / A24).
 *
 * Single production source for default/min/max negotiated interval seconds,
 * timeout multiplier, the **only** liveness-refresh closed-set map, and the
 * timeout error code (from ERROR_CODES — not a copied string).
 *
 * Do **not** create a second liveness array/map/boolean registry. Callers
 * must read refresh decisions only through
 * `doesCrossLanLivenessSignalRefreshTimer`, which consults
 * `livenessRefreshBySource` via `Object.hasOwn`.
 *
 * T1.0 Noise library selection remains BLOCKED. This constant does not
 * implement timers, send pings, or wire session disconnect.
 *
 * @type {Readonly<{
 *   defaultSeconds: number,
 *   minSeconds: number,
 *   maxSeconds: number,
 *   timeoutMultiplier: number,
 *   livenessRefreshBySource: Readonly<Record<string, boolean>>,
 *   timeoutErrorCode: string,
 * }>}
 */
export const CROSS_LAN_KEEPALIVE_POLICY = deepFreeze({
  defaultSeconds: 30,
  minSeconds: 5,
  maxSeconds: 120,
  timeoutMultiplier: 3,
  livenessRefreshBySource: {
    'application-pong': true,
    'authenticated-control-traffic': true,
    'authenticated-data-traffic': true,
    'websocket-ping': false,
    'websocket-pong': false,
  },
  timeoutErrorCode: ERROR_CODES.SESSION_KEEPALIVE_TIMEOUT,
});

/**
 * Frozen cross-LAN data-plane automatic resume policy (T1.9 / §6.10).
 *
 * Single production source for default / min / max configurable automatic
 * resume attempts, absolute hard ceiling, exhaustion semantics, and the
 * error code (from ERROR_CODES — not a copied string).
 *
 * **Semantic distinction (even when numeric values currently match):**
 * - `maxConfigurableAutomaticAttempts` is the upper bound of the currently
 *   allowed configuration range.
 * - `hardCeilingAutomaticAttempts` is the absolute implementation ceiling
 *   that must never be exceeded. If a future spec revision lowers the
 *   configurable max, the two fields remain distinguishable.
 *
 * T1.9 does **not** implement checkpoint / resume runtime, chunk ACK, or
 * transfer state machines.
 *
 * @type {Readonly<{
 *   defaultAutomaticAttempts: number,
 *   minConfigurableAutomaticAttempts: number,
 *   maxConfigurableAutomaticAttempts: number,
 *   hardCeilingAutomaticAttempts: number,
 *   explicitResumeRequiredAfterExhaustion: true,
 *   silentRestartAllowed: false,
 *   unboundedRetryAllowed: false,
 *   errorCode: string,
 * }>}
 */
export const CROSS_LAN_DATA_RESUME_POLICY = deepFreeze({
  defaultAutomaticAttempts: 5,
  minConfigurableAutomaticAttempts: 3,
  maxConfigurableAutomaticAttempts: 10,
  hardCeilingAutomaticAttempts: 10,
  explicitResumeRequiredAfterExhaustion: true,
  silentRestartAllowed: false,
  unboundedRetryAllowed: false,
  errorCode: ERROR_CODES.DATA_RESUME_EXHAUSTED,
});

/**
 * Module-private decision freezer for resolveCrossLanKeepaliveConfiguration.
 * Always returns a fresh frozen object; not a second policy/registry export.
 *
 * @param {boolean} configurationAccepted
 * @param {boolean} usedDefault
 * @param {number} negotiatedKeepaliveInterval
 * @returns {Readonly<{
 *   configurationAccepted: boolean,
 *   usedDefault: boolean,
 *   negotiatedKeepaliveInterval: number,
 * }>}
 */
function freezeKeepaliveConfigurationDecision(
  configurationAccepted,
  usedDefault,
  negotiatedKeepaliveInterval,
) {
  return Object.freeze({
    configurationAccepted,
    usedDefault,
    negotiatedKeepaliveInterval,
  });
}

/**
 * Module-private decision freezer for resolveCrossLanDataResumeConfiguration.
 * Always returns a fresh frozen object; not a second policy/registry export.
 *
 * @param {boolean} configurationAccepted
 * @param {boolean} usedDefault
 * @param {number} automaticResumeAttempts
 * @returns {Readonly<{
 *   configurationAccepted: boolean,
 *   usedDefault: boolean,
 *   automaticResumeAttempts: number,
 * }>}
 */
function freezeDataResumeConfigurationDecision(
  configurationAccepted,
  usedDefault,
  automaticResumeAttempts,
) {
  return Object.freeze({
    configurationAccepted,
    usedDefault,
    automaticResumeAttempts,
  });
}

/**
 * Module-private decision freezer for evaluateCrossLanKeepaliveTimeout.
 * Always returns a fresh frozen object; not a second policy/registry export.
 *
 * @param {boolean} inputAccepted
 * @param {boolean} shouldDisconnect
 * @param {number | null} timeoutAfterMs
 * @returns {Readonly<{
 *   inputAccepted: boolean,
 *   shouldDisconnect: boolean,
 *   timeoutAfterMs: number | null,
 * }>}
 */
function freezeKeepaliveTimeoutDecision(inputAccepted, shouldDisconnect, timeoutAfterMs) {
  return Object.freeze({
    inputAccepted,
    shouldDisconnect,
    timeoutAfterMs,
  });
}

/**
 * Resolve a caller-supplied keepalive interval configuration into a frozen decision.
 *
 * Pure configuration gate only — no runtime reporting, no network, no I/O.
 *
 * Decision semantics:
 * - `undefined` → accepted default path (`usedDefault: true`, 30s).
 * - primitive Number safe integer in [5, 120] inclusive → accepted explicit
 *   value (`usedDefault: false`, that value).
 * - any other input (including objects / Proxies) → rejected fallback
 *   (`configurationAccepted: false`, `usedDefault: true`, 30s). Properties
 *   of objects/Proxies are never read; no coercion.
 *
 * **Honesty boundary:** `configurationAccepted: false` means the configured
 * value was rejected. A future caller **must** report/reject that bad config
 * before using the default; it must not treat `usedDefault: true` alone as
 * silent acceptance. T1.9 freezes that responsibility but does not implement
 * runtime reporting. No fallbackReason / error taxonomy is invented here.
 *
 * Never throws. Does not export a second policy or registry.
 *
 * @param {unknown} configuredSeconds
 * @returns {Readonly<{
 *   configurationAccepted: boolean,
 *   usedDefault: boolean,
 *   negotiatedKeepaliveInterval: number,
 * }>}
 */
export function resolveCrossLanKeepaliveConfiguration(configuredSeconds) {
  try {
    if (configuredSeconds === undefined) {
      return freezeKeepaliveConfigurationDecision(
        true,
        true,
        CROSS_LAN_KEEPALIVE_POLICY.defaultSeconds,
      );
    }

    // Primitive Number safe integer only — no coercion, no object unboxing.
    if (
      typeof configuredSeconds === 'number' &&
      Number.isSafeInteger(configuredSeconds) &&
      configuredSeconds >= CROSS_LAN_KEEPALIVE_POLICY.minSeconds &&
      configuredSeconds <= CROSS_LAN_KEEPALIVE_POLICY.maxSeconds
    ) {
      return freezeKeepaliveConfigurationDecision(true, false, configuredSeconds);
    }

    return freezeKeepaliveConfigurationDecision(
      false,
      true,
      CROSS_LAN_KEEPALIVE_POLICY.defaultSeconds,
    );
  } catch {
    return freezeKeepaliveConfigurationDecision(
      false,
      true,
      CROSS_LAN_KEEPALIVE_POLICY.defaultSeconds,
    );
  }
}

/**
 * Resolve a caller-supplied data-resume automatic-attempt configuration into
 * a frozen decision.
 *
 * Pure configuration gate only — no runtime reporting, no network, no I/O.
 *
 * Decision semantics:
 * - `undefined` → accepted default path (`usedDefault: true`, 5 attempts).
 * - primitive Number safe integer in [3, 10] inclusive → accepted explicit
 *   value (`usedDefault: false`, that value).
 * - any other input (including objects / Proxies) → rejected fallback
 *   (`configurationAccepted: false`, `usedDefault: true`, 5). Properties
 *   of objects/Proxies are never read; no coercion.
 *
 * **Honesty boundary:** `configurationAccepted: false` means the configured
 * value was rejected. A future caller **must** report/reject that bad config
 * before using the default; it must not treat `usedDefault: true` alone as
 * silent acceptance. T1.9 freezes that responsibility but does not implement
 * runtime reporting. No fallbackReason / error taxonomy is invented here.
 *
 * Never throws. Does not export a second policy or registry. Does not
 * implement checkpoint / resume runtime.
 *
 * @param {unknown} configuredAttempts
 * @returns {Readonly<{
 *   configurationAccepted: boolean,
 *   usedDefault: boolean,
 *   automaticResumeAttempts: number,
 * }>}
 */
export function resolveCrossLanDataResumeConfiguration(configuredAttempts) {
  try {
    if (configuredAttempts === undefined) {
      return freezeDataResumeConfigurationDecision(
        true,
        true,
        CROSS_LAN_DATA_RESUME_POLICY.defaultAutomaticAttempts,
      );
    }

    // Primitive Number safe integer only — no coercion, no object unboxing.
    if (
      typeof configuredAttempts === 'number' &&
      Number.isSafeInteger(configuredAttempts) &&
      configuredAttempts >= CROSS_LAN_DATA_RESUME_POLICY.minConfigurableAutomaticAttempts &&
      configuredAttempts <= CROSS_LAN_DATA_RESUME_POLICY.maxConfigurableAutomaticAttempts
    ) {
      return freezeDataResumeConfigurationDecision(true, false, configuredAttempts);
    }

    return freezeDataResumeConfigurationDecision(
      false,
      true,
      CROSS_LAN_DATA_RESUME_POLICY.defaultAutomaticAttempts,
    );
  } catch {
    return freezeDataResumeConfigurationDecision(
      false,
      true,
      CROSS_LAN_DATA_RESUME_POLICY.defaultAutomaticAttempts,
    );
  }
}

/**
 * Pure closed-set liveness classification (T1.9 / §6.12).
 *
 * Returns whether the named signal type is allowed to refresh the **security
 * session** liveness timer, by reading the single policy map
 * `CROSS_LAN_KEEPALIVE_POLICY.livenessRefreshBySource` via `Object.hasOwn`.
 *
 * **Precondition (caller responsibility):** the caller has already completed
 * AEAD authentication and semantic classification of the traffic. This
 * function performs **only** a closed-set boolean map lookup. It never
 * authenticates input, never verifies AEAD, and never inspects wire bytes.
 *
 * Accepts only a primitive string. Unknown strings, empty string, case drift,
 * symbols, numbers, objects, and non-strings return `false`. Never throws.
 * RFC6455 WebSocket ping/pong are mapped to `false` and must not refresh
 * the security timer.
 *
 * T1.0 Noise library selection remains BLOCKED. Does not create or refresh
 * any actual timer.
 *
 * @param {unknown} signalType
 * @returns {boolean}
 */
export function doesCrossLanLivenessSignalRefreshTimer(signalType) {
  try {
    if (typeof signalType !== 'string') return false;
    if (!Object.hasOwn(CROSS_LAN_KEEPALIVE_POLICY.livenessRefreshBySource, signalType)) {
      return false;
    }
    return CROSS_LAN_KEEPALIVE_POLICY.livenessRefreshBySource[signalType] === true;
  } catch {
    return false;
  }
}

/**
 * Pure keepalive timeout three-state decision (T1.9 / §6.12).
 *
 * Given an exact ordinary record of negotiated interval (seconds) and elapsed
 * authenticated-liveness time (milliseconds), returns a fresh frozen decision:
 * - legal input → `{ inputAccepted: true, shouldDisconnect, timeoutAfterMs }`
 *   where `timeoutAfterMs = intervalSeconds * timeoutMultiplier * 1000` and
 *   `shouldDisconnect = elapsedMs > timeoutAfterMs` (strict greater-than).
 * - illegal / extra fields / accessor / non-plain / throwing or revoked Proxy
 *   → `{ inputAccepted: false, shouldDisconnect: true, timeoutAfterMs: null }`.
 *
 * **Honesty boundary for future runtime:**
 * - Only `inputAccepted: true && shouldDisconnect: true` may be mapped to
 *   `CROSS_LAN_KEEPALIVE_POLICY.timeoutErrorCode` (`SESSION_KEEPALIVE_TIMEOUT`).
 * - Invalid input conservatively disconnects but **must not** be disguised as
 *   `session-keepalive-timeout`; future independent input/state error handling
 *   owns that path. T1.9 invents no additional error code.
 *
 * Multiplier is always read from `CROSS_LAN_KEEPALIVE_POLICY.timeoutMultiplier`
 * (never a second hard-coded `3`). Never reads `Date.now`, never reads signal
 * types, never refreshes a timer. Never throws.
 *
 * Pure ECMAScript cannot reliably detect transparent Proxies. Throwing and
 * revoked Proxies fail closed (invalid decision, never throw). Transparent
 * Proxies remain a residual risk (same honesty note as T1.6/T1.7): future
 * trust-boundary callers must still canonicalize/freeze inputs.
 *
 * Exact-record gate: ordinary object; own keys exactly the two named string
 * enumerable data properties; values are primitive Number safe integers with
 * `negotiatedKeepaliveInterval` in [5, 120] and
 * `elapsedSinceAuthenticatedLivenessMs >= 0`.
 *
 * @param {unknown} input
 * @returns {Readonly<{
 *   inputAccepted: boolean,
 *   shouldDisconnect: boolean,
 *   timeoutAfterMs: number | null,
 * }>}
 */
export function evaluateCrossLanKeepaliveTimeout(input) {
  try {
    if (!isPlainRecord(input)) {
      return freezeKeepaliveTimeoutDecision(false, true, null);
    }

    const keys = getExactOwnStringDataKeys(input);
    if (keys === null || keys.length !== 2) {
      return freezeKeepaliveTimeoutDecision(false, true, null);
    }

    const keySet = new Set(keys);
    if (
      !keySet.has('negotiatedKeepaliveInterval') ||
      !keySet.has('elapsedSinceAuthenticatedLivenessMs')
    ) {
      return freezeKeepaliveTimeoutDecision(false, true, null);
    }

    const negotiatedKeepaliveInterval = input.negotiatedKeepaliveInterval;
    const elapsedSinceAuthenticatedLivenessMs = input.elapsedSinceAuthenticatedLivenessMs;

    if (
      typeof negotiatedKeepaliveInterval !== 'number' ||
      !Number.isSafeInteger(negotiatedKeepaliveInterval) ||
      negotiatedKeepaliveInterval < CROSS_LAN_KEEPALIVE_POLICY.minSeconds ||
      negotiatedKeepaliveInterval > CROSS_LAN_KEEPALIVE_POLICY.maxSeconds
    ) {
      return freezeKeepaliveTimeoutDecision(false, true, null);
    }

    if (
      typeof elapsedSinceAuthenticatedLivenessMs !== 'number' ||
      !Number.isSafeInteger(elapsedSinceAuthenticatedLivenessMs) ||
      elapsedSinceAuthenticatedLivenessMs < 0
    ) {
      return freezeKeepaliveTimeoutDecision(false, true, null);
    }

    const timeoutAfterMs =
      negotiatedKeepaliveInterval * CROSS_LAN_KEEPALIVE_POLICY.timeoutMultiplier * 1000;
    const shouldDisconnect = elapsedSinceAuthenticatedLivenessMs > timeoutAfterMs;
    return freezeKeepaliveTimeoutDecision(true, shouldDisconnect, timeoutAfterMs);
  } catch {
    return freezeKeepaliveTimeoutDecision(false, true, null);
  }
}

/**
 * Frozen Noise IK handshake token-sequence table (T1.12a non-crypto scaffold).
 *
 * Exact Noise_IK pattern token order:
 * - msg1: e, es, s, ss
 * - msg2: e, ee, se
 *
 * Status / honesty boundary (highest priority):
 * - [status] T1.0 Noise library gate = BLOCKED (not M1 crypto PASS)
 * - [scope] T1.12a non-crypto token scaffold only; T1.12 fixed vectors
 *   NOT READY / NOT COMPLETE
 * - Does **not** load fixtures, verify ciphertext or handshake hash, bind a
 *   Noise library, or execute DH/AEAD/hash/handshake. No independent
 *   authoritative expected handshake hash is present in the current gate
 *   evidence (public cacophony does not provide one). Full 6-message
 *   fixture comparison against a selected implementation waits for gate
 *   reopen + user path decision.
 * - Freezing this table does **not** prove Noise, library compatibility,
 *   E2EE, or an actual handshake.
 *
 * @type {Readonly<{
 *   msg1: ReadonlyArray<string>,
 *   msg2: ReadonlyArray<string>,
 * }>}
 */
export const CROSS_LAN_NOISE_IK_TOKEN_SEQUENCE = Object.freeze({
  msg1: Object.freeze(['e', 'es', 's', 'ss']),
  msg2: Object.freeze(['e', 'ee', 'se']),
});

/**
 * Pure non-crypto scaffold matcher for Noise IK token indexed content/order
 * (T1.12a only).
 *
 * Returns true **only** when `input` is a plain record whose own keys are
 * exactly the two string enumerable data properties `msg1` and `msg2`, each
 * an Array whose indexed primitive-string tokens and length match
 * `CROSS_LAN_NOISE_IK_TOKEN_SEQUENCE` (msg1 length 4, msg2 length 3). Extra
 * enumerable string own properties on a row (including sparse holes) are
 * rejected via `Object.keys(row).length === expected.length`. Non-enumerable
 * / symbol custom metadata is not treated as tokens — this matches indexed
 * token content+order, not a wire parser.
 *
 * Status / honesty boundary (highest priority):
 * - [status] T1.0 Noise library gate = BLOCKED (not M1 crypto PASS)
 * - [scope] T1.12a non-crypto token scaffold only; T1.12 fixed vectors
 *   NOT READY / NOT COMPLETE
 * - Does **not** load fixtures, verify ciphertext or handshake hash, bind a
 *   Noise library, or execute DH/AEAD/hash/handshake. No independent
 *   authoritative expected handshake hash is present in the current gate
 *   evidence (public cacophony does not provide one). Full 6-message
 *   fixture comparison against a selected implementation waits for gate
 *   reopen + user path decision.
 * - A true result only means the two token rows match the frozen indexed
 *   content/order table. It does **not** prove Noise, library compatibility,
 *   E2EE, or an actual handshake. Scaffold rejection of disorder does **not**
 *   claim a real Noise implementation would reject, that fixed vectors pass,
 *   or that T1.12 is complete.
 *
 * Pure ECMAScript cannot reliably detect transparent Proxies. Throwing and
 * revoked Proxies fail closed (return false, never throw). Transparent
 * Proxies remain a residual risk. Accessor index slots that throw fail
 * closed; if they return the correct primitive string they may match by
 * indexed content (array property-descriptor safety is not over-promised).
 *
 * Implementation: fail-closed try/catch around all `Object.keys` /
 * prototype / descriptor / property access; reuses module-private
 * `isPlainRecord` and `getExactOwnStringDataKeys`.
 *
 * @param {unknown} input
 * @returns {boolean}
 */
export function matchesCrossLanNoiseIkTokenSequence(input) {
  try {
    if (!isPlainRecord(input)) return false;

    const keys = getExactOwnStringDataKeys(input);
    if (keys === null || keys.length !== 2) return false;

    const keySet = new Set(keys);
    if (!keySet.has('msg1') || !keySet.has('msg2')) return false;

    return (
      matchesNoiseIkTokenRow(input.msg1, CROSS_LAN_NOISE_IK_TOKEN_SEQUENCE.msg1) &&
      matchesNoiseIkTokenRow(input.msg2, CROSS_LAN_NOISE_IK_TOKEN_SEQUENCE.msg2)
    );
  } catch {
    return false;
  }
}

/**
 * Match one token row: Array, exact length, no extra enumerable string own
 * properties, each index a primitive string strict-equal to expected.
 * @param {unknown} row
 * @param {ReadonlyArray<string>} expected
 * @returns {boolean}
 */
function matchesNoiseIkTokenRow(row, expected) {
  if (!Array.isArray(row)) return false;
  if (row.length !== expected.length) return false;
  // Reject sparse rows and extra enumerable string own properties.
  if (Object.keys(row).length !== expected.length) return false;

  for (let i = 0; i < expected.length; i += 1) {
    const token = row[i];
    if (typeof token !== 'string') return false;
    if (token !== expected[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// T1.14 — pure counter reservation / receive-window / trustEpoch contract
// (BigInt uint64 semantic constants + pure decision/predicate only; no I/O)
// ---------------------------------------------------------------------------

/**
 * Exact plain/null-prototype record reader: only enumerable own string data
 * fields, no symbols, no accessors, no non-enumerable own keys. Single
 * snapshot — `Reflect.ownKeys` once, and each own string key's
 * `Object.getOwnPropertyDescriptor` exactly once; that same descriptor both
 * validates enumerable/data shape and supplies `desc.value` (no second pass,
 * no ordinary get). Rejects class instances, arrays, Date, Proxy throw/revoke
 * (via try/catch), and extra/missing fields vs `expectedKeys`.
 *
 * @param {unknown} value
 * @param {readonly string[]} expectedKeys
 * @returns {Record<string, unknown> | null}
 */
function readExactOwnDataRecord(value, expectedKeys) {
  try {
    if (!isPlainRecord(value)) return null;
    const ownKeys = Reflect.ownKeys(value);
    /** @type {Set<string>} */
    const expected = new Set(expectedKeys);
    /** @type {Record<string, unknown>} */
    const out = Object.create(null);
    let stringKeyCount = 0;
    for (const key of ownKeys) {
      if (typeof key === 'symbol') return null;
      stringKeyCount += 1;
      if (!expected.has(key)) return null;
      // Single descriptor snapshot: validate shape + capture value together.
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc || desc.enumerable !== true) return null;
      if (desc.get !== undefined || desc.set !== undefined) return null;
      out[key] = desc.value;
    }
    if (stringKeyCount !== expectedKeys.length) return null;
    for (const k of expectedKeys) {
      if (!Object.hasOwn(out, k)) return null;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Private uint64 BigInt check — no coercion.
 * @param {unknown} value
 * @returns {value is bigint}
 */
function isUint64BigInt(value) {
  return (
    typeof value === 'bigint' &&
    value >= 0n &&
    value <= CROSS_LAN_COUNTER_RESERVATION_POLICY.uint64Max
  );
}

/**
 * Private positive uint64 BigInt check (≥ 1) — no coercion.
 * @param {unknown} value
 * @returns {value is bigint}
 */
function isPositiveUint64BigInt(value) {
  return (
    typeof value === 'bigint' &&
    value >= 1n &&
    value <= CROSS_LAN_COUNTER_RESERVATION_POLICY.uint64Max
  );
}

/**
 * Private positive safe integer (Number) check — no coercion.
 * @param {unknown} value
 * @returns {value is number}
 */
function isPositiveSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Private nonnegative safe integer (Number) check — no coercion.
 * @param {unknown} value
 * @returns {value is number}
 */
function isNonnegativeSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Frozen counter reservation policy constants (T1.14 / §6.8).
 *
 * Contract-only: no dataDir, fsync execution, reservation I/O, session, or
 * wire encoding. M1 does not execute any fsync; reservation atomic persist
 * before send is required at future runtime; steady-state per-message fsync
 * is not required.
 *
 * @type {Readonly<{
 *   defaultReservationRange: number,
 *   reservationRangeHardCeiling: number,
 *   defaultReceiveWindow: number,
 *   maximumDefaultCrashForwardGap: number,
 *   minimumDefaultForwardHeadroom: number,
 *   counterType: string,
 *   uint64Max: bigint,
 *   requiredRelation: string,
 *   reservationAtomicPersistRequiredBeforeSend: boolean,
 *   steadyStatePerMessageFsyncRequired: boolean,
 *   m1ExecutesAnyFsync: boolean,
 *   rollbackErrorCode: string,
 *   replayErrorCode: string,
 *   implementationStage: string,
 * }>}
 */
export const CROSS_LAN_COUNTER_RESERVATION_POLICY = Object.freeze({
  defaultReservationRange: 32,
  reservationRangeHardCeiling: 256,
  defaultReceiveWindow: 64,
  maximumDefaultCrashForwardGap: 32,
  minimumDefaultForwardHeadroom: 32,
  counterType: 'uint64',
  uint64Max: (1n << 64n) - 1n,
  requiredRelation: 'reservation-range-less-than-receive-window',
  reservationAtomicPersistRequiredBeforeSend: true,
  steadyStatePerMessageFsyncRequired: false,
  m1ExecutesAnyFsync: false,
  rollbackErrorCode: ERROR_CODES.DEVICE_COUNTER_ROLLBACK,
  replayErrorCode: ERROR_CODES.DEVICE_REPLAY_DETECTED,
  implementationStage: 'contract-only-no-counter-io',
});

/**
 * Pure counter configuration validator (T1.14).
 *
 * Exact record `{ reservationRange, receiveWindow }`: both positive safe
 * integers; `reservationRange ≤ 256`; `reservationRange < receiveWindow`.
 * Window has no separate hard ceiling beyond Number safe integer.
 * Never throws; invalid / extra / accessor / Proxy / revoked → false.
 *
 * @param {unknown} input
 * @returns {boolean}
 */
export function isValidCrossLanCounterConfiguration(input) {
  try {
    const rec = readExactOwnDataRecord(input, ['reservationRange', 'receiveWindow']);
    if (rec === null) return false;
    const reservationRange = rec.reservationRange;
    const receiveWindow = rec.receiveWindow;
    if (!isPositiveSafeInteger(reservationRange)) return false;
    if (!isPositiveSafeInteger(receiveWindow)) return false;
    if (reservationRange > CROSS_LAN_COUNTER_RESERVATION_POLICY.reservationRangeHardCeiling) {
      return false;
    }
    return reservationRange < receiveWindow;
  } catch {
    return false;
  }
}

/**
 * Pure crash-forward-gap normality predicate (T1.14 / §6.8.1).
 *
 * Exact record `{ forwardGap, reservationRange, receiveWindow }`.
 * Requires a valid counter configuration and a nonnegative safe-integer
 * `forwardGap`. Returns true iff `forwardGap ≤ reservationRange`.
 *
 * **Honesty:** `false` when `forwardGap > R` means only that the gap is
 * **not** a normal single-crash reservation skip. It does **not** mean
 * rollback, replay, or that `classifyCrossLanReceivedCounter` must reject.
 * Receive classification is a separate five-state pure API and does not
 * take `R` as an input.
 *
 * Never throws.
 *
 * @param {unknown} input
 * @returns {boolean}
 */
export function isNormalCrossLanCrashForwardGap(input) {
  try {
    const rec = readExactOwnDataRecord(input, [
      'forwardGap',
      'reservationRange',
      'receiveWindow',
    ]);
    if (rec === null) return false;
    if (
      !isValidCrossLanCounterConfiguration({
        reservationRange: rec.reservationRange,
        receiveWindow: rec.receiveWindow,
      })
    ) {
      return false;
    }
    if (!isNonnegativeSafeInteger(rec.forwardGap)) return false;
    // reservationRange is a validated positive safe integer after config check.
    return /** @type {number} */ (rec.forwardGap) <= /** @type {number} */ (rec.reservationRange);
  } catch {
    return false;
  }
}

/**
 * Pure persisted counter-state rollback gate (T1.14 / §6.8.1 causes a + c).
 *
 * Exact record:
 * `{ persistedReservedEnd, previouslyConfirmedReservedEnd, authorityVerified }`.
 *
 * Fail-closed: invalid shape/type/Proxy/revoked → true (function name is
 * `shouldReject`; malformed input is not claimed to prove rollback itself).
 * - `authorityVerified !== true` → true (spec cause c; real signature /
 *   authority verification is M3, not M1).
 * - `persistedReservedEnd < previouslyConfirmedReservedEnd` → true (cause a).
 * - equal/greater with authority true → false.
 *
 * No I/O, no counter reset. Never throws.
 *
 * @param {unknown} input
 * @returns {boolean}
 */
export function shouldRejectCrossLanPersistedCounterState(input) {
  try {
    const rec = readExactOwnDataRecord(input, [
      'persistedReservedEnd',
      'previouslyConfirmedReservedEnd',
      'authorityVerified',
    ]);
    if (rec === null) return true;
    if (!isUint64BigInt(rec.persistedReservedEnd)) return true;
    if (!isUint64BigInt(rec.previouslyConfirmedReservedEnd)) return true;
    if (rec.authorityVerified !== true) return true;
    if (rec.persistedReservedEnd < rec.previouslyConfirmedReservedEnd) return true;
    return false;
  } catch {
    return true;
  }
}

/**
 * Pure five-state receive-counter classifier (T1.14 / §6.8.2).
 *
 * Exact record `{ counter, highestAcceptedCounter, receiveWindow }`.
 * Returns only one of:
 *   `accept` | `reject-rollback` | `reject-replay` |
 *   `reject-outside-window` | `reject-invalid`
 *
 * Evaluation order:
 * 1. invalid shape/type; counter/highest not uint64 BigInt; window not a
 *    positive safe integer → `reject-invalid`
 * 2. `counter < highest` → `reject-rollback` (strict lower only)
 * 3. `counter === highest` → `reject-replay`
 * 4. `upper = min(highest + BigInt(window), uint64Max)`;
 *    `counter ≤ upper` → `accept`; else `reject-outside-window`
 *
 * `R` is intentionally **not** an input. A crash forward gap > R that still
 * lands inside the receive window is `accept`, not automatic rollback.
 * When `highest === uint64Max`, only equal (replay) / lower (rollback) /
 * invalid are possible — no legal forward or wrap.
 *
 * Never throws. Does not echo inputs.
 *
 * @param {unknown} input
 * @returns {'accept' | 'reject-rollback' | 'reject-replay' | 'reject-outside-window' | 'reject-invalid'}
 */
export function classifyCrossLanReceivedCounter(input) {
  try {
    const rec = readExactOwnDataRecord(input, [
      'counter',
      'highestAcceptedCounter',
      'receiveWindow',
    ]);
    if (rec === null) return 'reject-invalid';
    if (!isUint64BigInt(rec.counter)) return 'reject-invalid';
    if (!isUint64BigInt(rec.highestAcceptedCounter)) return 'reject-invalid';
    if (!isPositiveSafeInteger(rec.receiveWindow)) return 'reject-invalid';

    const counter = /** @type {bigint} */ (rec.counter);
    const highest = /** @type {bigint} */ (rec.highestAcceptedCounter);
    if (counter < highest) return 'reject-rollback';
    if (counter === highest) return 'reject-replay';

    const uint64Max = CROSS_LAN_COUNTER_RESERVATION_POLICY.uint64Max;
    const rawUpper = highest + BigInt(/** @type {number} */ (rec.receiveWindow));
    const upper = rawUpper < uint64Max ? rawUpper : uint64Max;
    if (counter <= upper) return 'accept';
    return 'reject-outside-window';
  } catch {
    return 'reject-invalid';
  }
}

/**
 * Frozen controller-global `trustEpoch` policy (T1.14 / §6.7.8.1).
 *
 * Orthogonal to `enrollmentEpoch` and `revokeGeneration` (listed, not merged).
 * Increment does **not** require fleet re-enroll. Wrap is not allowed.
 * Persist-before-ack is required at M3 runtime, not implemented in M1.
 *
 * @type {Readonly<{
 *   name: string,
 *   scope: string,
 *   type: string,
 *   bootstrapInitialTrustEpoch: bigint,
 *   uint64Max: bigint,
 *   staleRule: string,
 *   staleErrorCode: string,
 *   persistBeforeAck: string,
 *   orthogonalFields: ReadonlyArray<string>,
 *   fleetReenrollRequiredOnIncrement: boolean,
 *   wrapAllowed: boolean,
 *   implementationStage: string,
 * }>}
 */
export const CROSS_LAN_TRUST_EPOCH_POLICY = Object.freeze({
  name: 'trustEpoch',
  scope: 'controller-global',
  type: 'uint64',
  bootstrapInitialTrustEpoch: 1n,
  uint64Max: (1n << 64n) - 1n,
  staleRule: 'candidate-less-than-or-equal-to-last-accepted-rejected',
  staleErrorCode: ERROR_CODES.STALE_EPOCH_REJECTED,
  persistBeforeAck: 'required-at-m3-runtime-not-m1',
  orthogonalFields: Object.freeze(['enrollmentEpoch', 'revokeGeneration']),
  fleetReenrollRequiredOnIncrement: false,
  wrapAllowed: false,
  implementationStage: 'contract-only-no-epoch-io',
});

/**
 * Pure trustEpoch stale/reject predicate (T1.14 / §6.7.8.1).
 *
 * Exact record `{ trustEpoch, lastAcceptedTrustEpoch }`:
 * - `trustEpoch` must be a **positive** uint64 BigInt (≥ 1)
 * - `lastAcceptedTrustEpoch` must be a **nonnegative** uint64 BigInt
 * - invalid shape/type/Proxy/revoked → true (fail-closed)
 * - candidate ≤ last → true (stale / replay)
 * - candidate > last → false (accept path for future runtime)
 *
 * Extra keys such as `enrollmentEpoch` / `revokeGeneration` are rejected
 * (API orthogonality only — this function does not validate those fields).
 * Never throws. No I/O.
 *
 * @param {unknown} input
 * @returns {boolean}
 */
export function shouldRejectCrossLanTrustEpoch(input) {
  try {
    const rec = readExactOwnDataRecord(input, [
      'trustEpoch',
      'lastAcceptedTrustEpoch',
    ]);
    if (rec === null) return true;
    if (!isPositiveUint64BigInt(rec.trustEpoch)) return true;
    if (!isUint64BigInt(rec.lastAcceptedTrustEpoch)) return true;
    if (rec.trustEpoch <= rec.lastAcceptedTrustEpoch) return true;
    return false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// T1.16 — pure relay pin-set update semantic contract + preserve-old predicate
// (A21/A22 contract-level only; no signature/E2EE/time/persist/ack side effects)
// ---------------------------------------------------------------------------

/** @type {ReadonlyArray<string>} */
const RELAY_PIN_SET_UPDATE_REQUIRED_FIELDS =
  CONTROL_PLANE_MESSAGE_SCHEMAS['relay-pin-set-update'].requiredFields;

/** @type {ReadonlyArray<string>} */
const RELAY_PIN_SET_ACK_REQUIRED_FIELDS =
  CONTROL_PLANE_MESSAGE_SCHEMAS['relay-pin-set-ack'].requiredFields;

/** Nonempty string fields of relay-pin-set-update (excludes pin arrays + epoch). */
const RELAY_PIN_SET_UPDATE_NONEMPTY_STRING_FIELDS = Object.freeze([
  'relayId',
  'notBefore',
  'graceUntil',
  'updateId',
  'signature',
]);

/** Wrapper fields for preserve-old-pin predicate (exact shape). */
const RELAY_PIN_SET_PRESERVE_WRAPPER_FIELDS = Object.freeze([
  'message',
  'lastAcceptedTrustEpoch',
  'authenticatedE2eeEstablished',
  'signatureVerified',
  'timeWindowValidated',
  'oldPinsMatchCurrentSet',
  'persistenceSucceeded',
]);

/** Boolean claim fields that must be strictly `=== true` for apply path. */
const RELAY_PIN_SET_PRESERVE_CLAIM_FIELDS = Object.freeze([
  'authenticatedE2eeEstablished',
  'signatureVerified',
  'timeWindowValidated',
  'oldPinsMatchCurrentSet',
  'persistenceSucceeded',
]);

/**
 * Frozen relay pin-set policy (T1.16 / §4.1.6 A21–A22 contract-level).
 *
 * Declares message types, required field lists (shared with T1.2 frozen
 * arrays), delivery/signature/epoch rules, overlap/emergency policy flags,
 * fail-closed preserve-on-failure, and M1 honesty (no sig/persist/ack).
 * Does **not** execute rotation, verify signatures, parse clocks, or emit ack.
 *
 * @type {Readonly<{
 *   updateMessageType: string,
 *   ackMessageType: string,
 *   requiredUpdateFields: ReadonlyArray<string>,
 *   requiredAckFields: ReadonlyArray<string>,
 *   deliveryChannel: string,
 *   signatureAuthority: string,
 *   trustEpochRule: string,
 *   persistBeforeAckRequired: boolean,
 *   oldAndNewPinsValidDuringInclusiveOverlap: boolean,
 *   oldPinsRemovedAfterGrace: boolean,
 *   emergencyRevokeEncoding: string,
 *   preserveOldPinsOnAnyFailure: boolean,
 *   tofuAllowed: boolean,
 *   skipPinValidationAllowed: boolean,
 *   m1PerformsSignatureVerification: boolean,
 *   m1PerformsPersistence: boolean,
 *   m1EmitsAck: boolean,
 *   a21A22RuntimeStatus: string,
 *   implementationStage: string,
 * }>}
 */
export const CROSS_LAN_RELAY_PIN_SET_POLICY = Object.freeze({
  updateMessageType: 'relay-pin-set-update',
  ackMessageType: 'relay-pin-set-ack',
  requiredUpdateFields: RELAY_PIN_SET_UPDATE_REQUIRED_FIELDS,
  requiredAckFields: RELAY_PIN_SET_ACK_REQUIRED_FIELDS,
  deliveryChannel: 'authenticated-e2ee-established-only',
  signatureAuthority: 'controller-ed25519-canonical-tbs-all-required-fields',
  trustEpochRule: 'positive-uint64-strictly-greater-than-last-accepted',
  persistBeforeAckRequired: true,
  oldAndNewPinsValidDuringInclusiveOverlap: true,
  oldPinsRemovedAfterGrace: true,
  emergencyRevokeEncoding: 'graceUntil-equals-notBefore',
  preserveOldPinsOnAnyFailure: true,
  tofuAllowed: false,
  skipPinValidationAllowed: false,
  m1PerformsSignatureVerification: false,
  m1PerformsPersistence: false,
  m1EmitsAck: false,
  a21A22RuntimeStatus: 'not-ready',
  implementationStage: 'T1.16-M1-contract-only',
});

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Dense array snapshot from own data descriptors only. Own keys must be
 * exactly `0..length-1` + `length` (length from its own data descriptor).
 * Each index must be an enumerable data property. Returns descriptor values
 * or null. Never invokes ordinary index get traps for values.
 *
 * @param {unknown} value
 * @returns {unknown[] | null}
 */
function readDenseArrayDescriptorValues(value) {
  try {
    if (!Array.isArray(value)) return null;
    const lengthDesc = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      !lengthDesc ||
      lengthDesc.get !== undefined ||
      lengthDesc.set !== undefined
    ) {
      return null;
    }
    const length = lengthDesc.value;
    if (
      typeof length !== 'number' ||
      !Number.isInteger(length) ||
      length < 0
    ) {
      return null;
    }
    const keys = Reflect.ownKeys(value);
    /** @type {string[]} */
    const expected = [];
    for (let i = 0; i < length; i += 1) expected.push(String(i));
    expected.push('length');
    if (keys.length !== expected.length) return null;
    for (let i = 0; i < expected.length; i += 1) {
      if (keys[i] !== expected[i]) return null;
    }
    /** @type {unknown[]} */
    const out = [];
    for (let i = 0; i < length; i += 1) {
      const desc = Object.getOwnPropertyDescriptor(value, String(i));
      if (!desc || desc.enumerable !== true) return null;
      if (desc.get !== undefined || desc.set !== undefined) return null;
      out.push(desc.value);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Nonempty dense array of unique nonempty strings via descriptor snapshot.
 *
 * @param {unknown} value
 * @returns {string[] | null}
 */
function readDenseNonemptyUniqueStringArray(value) {
  const items = readDenseArrayDescriptorValues(value);
  if (items === null || items.length === 0) return null;
  /** @type {string[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const item of items) {
    if (!isNonemptyString(item)) return null;
    if (seen.has(item)) return null;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * Validate a descriptor-value snapshot of a relay-pin-set-update record.
 * Consumes only the provided snapshot object (and dense-array snapshots of
 * pin array values already present on the snapshot). Does not re-read the
 * original message via ordinary property get.
 *
 * @param {Record<string, unknown>} rec
 * @returns {boolean}
 */
function isValidRelayPinSetUpdateRecordSnapshot(rec) {
  for (const field of RELAY_PIN_SET_UPDATE_NONEMPTY_STRING_FIELDS) {
    if (!isNonemptyString(rec[field])) return false;
  }
  if (readDenseNonemptyUniqueStringArray(rec.oldSpkiPins) === null) return false;
  if (readDenseNonemptyUniqueStringArray(rec.newSpkiPins) === null) return false;
  if (!isPositiveUint64BigInt(rec.trustEpoch)) return false;
  return true;
}

/**
 * Semantic matcher for raw `relay-pin-set-update` messages (T1.16).
 *
 * Accepts an unknown message (not a caller-supplied snapshot). Requires an
 * exact ordinary / null-prototype record with exactly the T1.2 eight own
 * enumerable string data fields. Values are taken from property descriptors
 * so get traps cannot false-accept. Pin arrays must be nonempty dense Arrays
 * of unique nonempty strings (internal uniqueness only; old/new intersection
 * and identical sets are allowed). `trustEpoch` must be a positive uint64
 * BigInt. String fields are nonempty only — no trim/normalize/regex/Date.parse.
 *
 * Total / no-throw. NOT a signature, time-window, or wire validator.
 *
 * @param {unknown} input
 * @returns {boolean}
 */
export function matchesCrossLanRelayPinSetUpdateContract(input) {
  try {
    const rec = readExactOwnDataRecord(input, RELAY_PIN_SET_UPDATE_REQUIRED_FIELDS);
    if (rec === null) return false;
    return isValidRelayPinSetUpdateRecordSnapshot(rec);
  } catch {
    return false;
  }
}

/**
 * Fail-closed preserve-old-pin predicate after a pin-set update attempt (T1.16).
 *
 * Exact wrapper record with fields:
 *   `message`, `lastAcceptedTrustEpoch`, `authenticatedE2eeEstablished`,
 *   `signatureVerified`, `timeWindowValidated`, `oldPinsMatchCurrentSet`,
 *   `persistenceSucceeded`.
 *
 * Wrapper and nested message/pin arrays are snapshotted once via property
 * descriptors in a single call; decisions consume only that snapshot (no
 * public matcher-then-re-read of the live message; no ordinary
 * `message.field` / `array[i]` decisions). Any invalid shape / type /
 * accessor / symbol / Proxy throw / revoked → `true` (preserve old pins =
 * leave the existing persisted pin set unchanged).
 *
 * Returns `false` only when every gate passes: message is semantically valid,
 * `lastAcceptedTrustEpoch` is a nonnegative uint64 BigInt, candidate epoch is
 * strictly greater via `shouldRejectCrossLanTrustEpoch`, and all five claim
 * flags are strictly `=== true`. `false` only allows the caller to enter
 * subsequent apply/ack runtime (which may include inclusive old/new pin
 * overlap); it does **not** mean immediately delete old pins. Caller claims
 * are not runtime proof; this function never verifies signatures, E2EE,
 * clocks, old-set membership, or persistence, and never emits ack / pins /
 * alerts.
 *
 * @param {unknown} input
 * @returns {boolean}
 */
export function shouldPreserveOldCrossLanRelayPinsAfterUpdateAttempt(input) {
  try {
    const wrapper = readExactOwnDataRecord(
      input,
      RELAY_PIN_SET_PRESERVE_WRAPPER_FIELDS,
    );
    if (wrapper === null) return true;

    // Single message descriptor snapshot for this call — never re-read live.
    const messageSnap = readExactOwnDataRecord(
      wrapper.message,
      RELAY_PIN_SET_UPDATE_REQUIRED_FIELDS,
    );
    if (messageSnap === null) return true;
    if (!isValidRelayPinSetUpdateRecordSnapshot(messageSnap)) return true;

    // Fresh epoch via existing T1.14 predicate on descriptor-snapshotted values.
    if (
      shouldRejectCrossLanTrustEpoch({
        trustEpoch: messageSnap.trustEpoch,
        lastAcceptedTrustEpoch: wrapper.lastAcceptedTrustEpoch,
      })
    ) {
      return true;
    }

    for (const claim of RELAY_PIN_SET_PRESERVE_CLAIM_FIELDS) {
      if (wrapper[claim] !== true) return true;
    }

    return false;
  } catch {
    return true;
  }
}
