import { describe, it } from 'node:test';
import assert from 'node:assert';

import { inspectMountedSmb } from '../src/smb-snapshot-replication.js';

const isDarwin = process.platform === 'darwin';
const realGateEnabled = process.env.LINKE_REAL_SMB_INSPECTION === 'enabled';

describe('mounted SMB real inspection integration', () => {
  it('rejects a non-SMB mount on darwin (APFS root)', { skip: !isDarwin }, async () => {
    await assert.rejects(inspectMountedSmb('/'));
  });

  it(
    'inspects a real mounted SMB share only when explicitly gated',
    { skip: !isDarwin || !realGateEnabled },
    async () => {
      const mountPath = process.env.LINKE_REAL_SMB_MOUNT_PATH;
      if (typeof mountPath !== 'string' || !mountPath.startsWith('/Volumes/')) {
        assert.fail('LINKE_REAL_SMB_MOUNT_PATH must be set to a /Volumes/ mount path');
      }

      let inspection;
      try {
        inspection = await inspectMountedSmb(mountPath);
      } catch {
        assert.fail('sanitized real SMB inspection failed');
      }

      assert.strictEqual(inspection.fsType, 'smbfs');
      assert.ok(Number.isSafeInteger(inspection.availableBytes));
      assert.ok(inspection.availableBytes > 0);
    },
  );
});
