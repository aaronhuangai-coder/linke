import { mkdir, appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function isPersistablePreview(preview) {
  if (!preview || typeof preview !== 'object') return false;
  if (preview.command !== 'supervisor-lifecycle-approval-persistence-preview') return false;
  if (preview.approvalValid !== true) return false;
  if (!preview.persistence || typeof preview.persistence !== 'object') return false;
  if (preview.persistence.previewOnly !== true) return false;
  if (preview.persistence.wouldPersist !== false) return false;
  if (!Array.isArray(preview.blockers) || preview.blockers.length !== 1 || preview.blockers[0] !== 'approval-persistence-store-missing') {
    return false;
  }
  return true;
}

export function buildSupervisorLifecycleApprovalRecord(preview, approval, options = {}) {
  if (!isPersistablePreview(preview)) {
    throw new Error('approval preview is not persistable');
  }

  const id = options.id || randomUUID();
  const createdAt = (options && options.now) ? options.now.toISOString() : new Date().toISOString();
  const operation = preview.operation || 'unknown';

  const validation = {
    approvalValid: preview.persistence?.validation?.approvalValid ?? false,
    acknowledgementCount: preview.persistence?.validation?.acknowledgementCount ?? 0,
    windowWithinLimit: preview.persistence?.validation?.windowWithinLimit ?? false,
    operationMatchesPlan: preview.persistence?.validation?.operationMatchesPlan ?? false,
    configHashMatchesPlan: preview.persistence?.validation?.configHashMatchesPlan ?? false,
    planHashMatchesPlan: preview.persistence?.validation?.planHashMatchesPlan ?? false,
  };

  return {
    command: 'supervisor-lifecycle-approval-record',
    schemaVersion: 1,
    id,
    createdAt,
    operation,
    state: 'persistable',
    approvalValid: preview.approvalValid ?? false,
    blockersResolved: ['approval-persistence-store-missing'],
    validation,
    safety: {
      approvalPersisted: false,
      filesystemWritten: false,
      hostMutation: false,
      launchctlCalled: false,
      lifecycleApplied: false,
      sensitiveValuesReturned: false,
    },
  };
}

export async function appendSupervisorLifecycleApprovalRecord(dataDir, preview, approval, options = {}) {
  const record = buildSupervisorLifecycleApprovalRecord(preview, approval, options);

  const persistedRecord = {
    ...record,
    state: 'persisted',
    safety: {
      ...record.safety,
      approvalPersisted: true,
      filesystemWritten: true,
    },
  };

  const dirPath = join(dataDir, 'approvals');
  await mkdir(dirPath, { recursive: true });

  const filePath = join(dirPath, 'supervisor-lifecycle-approvals.jsonl');
  await appendFile(filePath, JSON.stringify(persistedRecord) + '\n', 'utf-8');

  return persistedRecord;
}

export async function readSupervisorLifecycleApprovalRecords(dataDir, options = {}) {
  const filePath = join(dataDir, 'approvals', 'supervisor-lifecycle-approvals.jsonl');
  try {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const records = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        records.push(JSON.parse(line));
      } catch (err) {
        // ignore corrupt lines
      }
    }
    return records;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}
