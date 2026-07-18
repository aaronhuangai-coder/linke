/**
 * Unique pure source-of-truth for supervisor lifecycle operation → ordered action IDs.
 * Pure module: imports neither lifecycle nor capability-audit-sink (no ESM cycle).
 * Action ID authority lives only here; lifecycle only attaches description/status/would*.
 */

/** @type {Readonly<Record<string, ReadonlyArray<string>>>} */
export const SUPERVISOR_LIFECYCLE_OPERATION_ACTION_IDS = Object.freeze({
  install: Object.freeze([
    'render-launch-agent-plist',
    'write-launch-agent-plist',
    'load-launch-agent',
  ]),
  uninstall: Object.freeze([
    'unload-launch-agent',
    'remove-launch-agent-plist',
    'remove-supervisor-metadata',
  ]),
  rollback: Object.freeze([
    'capture-current-state',
    'restore-previous-plist',
    'restart-previous-supervisor',
  ]),
  recover: Object.freeze([
    'start-recovery-supervisor',
  ]),
});

/**
 * Exact string membership check for allowlisted lifecycle operations.
 * Fail-closed: non-string / unknown values return false (no coercion / case fold / trim).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSupervisorLifecycleOperation(value) {
  return typeof value === 'string'
    && Object.hasOwn(SUPERVISOR_LIFECYCLE_OPERATION_ACTION_IDS, value);
}

/**
 * Return a fresh mutable-safe copy of ordered action IDs for a lifecycle operation.
 * Valid operation → shallow-copied array; invalid/non-string → empty array.
 * Caller mutation of the returned array must not pollute the SoT map.
 * @param {unknown} operation
 * @returns {string[]}
 */
export function listSupervisorLifecycleActionIds(operation) {
  if (!isSupervisorLifecycleOperation(operation)) return [];
  return [...SUPERVISOR_LIFECYCLE_OPERATION_ACTION_IDS[operation]];
}

/**
 * Strict boolean exact pairing of operation + actionId against the pure SoT map.
 * Fail-closed for unknown/cross-op/non-string inputs (no substring / case / coercion).
 * @param {unknown} operation
 * @param {unknown} actionId
 * @returns {boolean}
 */
export function isSupervisorLifecycleActionForOperation(operation, actionId) {
  if (!isSupervisorLifecycleOperation(operation) || typeof actionId !== 'string') {
    return false;
  }
  return SUPERVISOR_LIFECYCLE_OPERATION_ACTION_IDS[operation].includes(actionId);
}
