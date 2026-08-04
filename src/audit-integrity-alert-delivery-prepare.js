/**
 * Snapshot-only prepare composer: outbox head + stream identity + pure HTTPS request.
 * No network I/O, claim, acknowledgement, retry, or scheduling.
 */

import { ERROR_CODES, LinkeError } from './error-codes.js';
import { buildAuditIntegrityAlertDeliveryRequest } from './audit-integrity-alert-delivery.js';
import { ensureAuditIntegrityAlertDeliveryStream } from './audit-integrity-alert-delivery-stream.js';
import { readAuditIntegrityAlertOutbox } from './audit-integrity-alert-outbox.js';

function unavailableError() {
  return new LinkeError(ERROR_CODES.AUDIT_DELIVERY_UNAVAILABLE);
}

/** Exact-key frozen empty prepare receipt. */
function freezeEmptyReceipt() {
  return Object.freeze({
    schemaVersion: 1,
    status: 'empty',
    sequence: null,
    streamId: null,
    request: null,
  });
}

/**
 * Exact-key frozen prepared receipt. Nested request is already deeply frozen.
 * @param {number} sequence
 * @param {string} streamId
 * @param {Readonly<object>} request
 */
function freezePreparedReceipt(sequence, streamId, request) {
  return Object.freeze({
    schemaVersion: 1,
    status: 'prepared',
    sequence,
    streamId,
    request,
  });
}

/**
 * Prepare a local snapshot of the current outbox head for future transport.
 * Empty first-read returns without ensuring stream identity. Nonempty ensures
 * identity, re-reads, and either returns empty (drained) or a pure request for
 * the second-read head. Holds no lock across calls; never claims or acks.
 *
 * @param {unknown} dataDir
 * @param {unknown} endpoint
 * @returns {Promise<Readonly<{
 *   schemaVersion: 1,
 *   status: 'empty' | 'prepared',
 *   sequence: number | null,
 *   streamId: string | null,
 *   request: Readonly<object> | null,
 * }>>}
 */
export async function prepareAuditIntegrityAlertDelivery(dataDir, endpoint) {
  try {
    const first = await readAuditIntegrityAlertOutbox(dataDir);
    if (first.entries.length === 0) {
      return freezeEmptyReceipt();
    }

    const stream = await ensureAuditIntegrityAlertDeliveryStream(dataDir);
    const second = await readAuditIntegrityAlertOutbox(dataDir);
    if (second.entries.length === 0) {
      return freezeEmptyReceipt();
    }

    const head = second.entries[0];
    const request = buildAuditIntegrityAlertDeliveryRequest(
      endpoint,
      stream.streamId,
      head,
    );
    return freezePreparedReceipt(head.sequence, stream.streamId, request);
  } catch {
    throw unavailableError();
  }
}
