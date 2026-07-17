import { ERROR_CODES } from './error-codes.js';

/**
 * Linke V2 control-plane protocol scaffold (T1.2–T1.10 / M1).
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
 *        (no Noise handshake, hash, HKDF, ChaCha, X25519, or token sequence).
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
 * payloads — not RFC6455 WebSocket ping/pong (transport timing is M3).
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
 * - T1.14 will add receive-window upper bound, uint64 max, and reservation.
 *   That layer will not admit `sequence <= highestAcceptedSequence`; this
 *   primitive already rejects non-forward sequences and must stay that way.
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
