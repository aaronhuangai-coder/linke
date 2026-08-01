import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const contractsUrl = new URL('../src/launchagent-lifecycle/contracts.js', import.meta.url);
const contractsPath = fileURLToPath(contractsUrl);
const contractsExists = existsSync(contractsPath);

test('contracts module exists before contract behavior tests', () => {
  assert.equal(
    contractsExists,
    true,
    'expected src/launchagent-lifecycle/contracts.js to exist before contract behavior tests',
  );
});

if (contractsExists) {
  const {
    LAUNCHAGENT_LIFECYCLE,
    LAUNCHAGENT_LIFECYCLE_CODES,
    LaunchAgentLifecycleError,
    validateLaunchAgentManifest,
    validateLaunchAgentAnchor,
    validateLaunchAgentJournal,
    validateLaunchAgentReceipt,
    validateLaunchAgentTransactionCloseout,
    validateLaunchAgentTransactionPrefix,
    validateLaunchAgentAcceptanceRequest,
    validateLaunchAgentConfirmationRecord,
    validateLaunchAgentConsumedConfirmation,
    validateLaunchAgentCapabilityProjection,
  } = await import(contractsUrl);

  const INSTALLATION_ID = '018f0f95-3d3a-7f01-8c6a-2a6f98765432';
  const TRANSACTION_ID = '018f0f95-3d3a-7f01-8c6a-2a6f98765433';
  const ANCHOR_ID = '018f0f95-3d3a-7f01-8c6a-2a6f98765434';
  const ACCEPTANCE_ID = '018f0f95-3d3a-7f01-8c6a-2a6f98765435';
  const CONFIRMATION_ID = '018f0f95-3d3a-7f01-8c6a-2a6f98765436';
  const MANUAL_REPAIR_REQUEST_ID = '018f0f95-3d3a-7f01-8c6a-2a6f98765437';
  const MANUAL_REPAIR_CONFIRMATION_ID = '018f0f95-3d3a-7f01-8c6a-2a6f98765438';
  const SOURCE_COMMIT = 'a'.repeat(40);
  const AT = '2026-07-28T00:00:00.000Z';

  const EXPECTED_LIFECYCLE = {
    schemaVersion: 1,
    scope: 'user-launch-agent',
    labels: {
      controller: 'com.linke.controller',
      scheduler: 'com.linke.scheduler',
    },
    filenames: {
      controller: 'com.linke.controller.plist',
      scheduler: 'com.linke.scheduler.plist',
      manifest: 'active-manifest.json',
    },
    rootIds: {
      launchAgents: 'current-user-launch-agents',
      metadata: 'linke-launchagent-lifecycle-metadata',
    },
    scheduleSeconds: { min: 60, max: 86400 },
  };

  const EXPECTED_CODES = {
    INVALID: 'launchagent-lifecycle-invalid',
    OWNERSHIP_MISMATCH: 'ownership-mismatch',
    LABEL_IN_USE: 'label-in-use',
    CONDITIONAL_MUTATION_UNSUPPORTED: 'conditional-mutation-unsupported',
    CONDITIONAL_MUTATION_MISMATCH: 'conditional-mutation-mismatch',
    TRANSACTION_IN_PROGRESS: 'transaction-in-progress',
    RECOVERY_REQUIRED: 'recovery-required',
    MANUAL_INTERVENTION_REQUIRED: 'manual-intervention-required',
    CONTROLLER_NOT_READY: 'controller-not-ready',
    SCHEDULER_LOAD_FAILED: 'scheduler-load-failed',
    ROLLBACK_RUNTIME_MISMATCH: 'rollback-runtime-mismatch',
    UNINSTALL_UNLOAD_INCOMPLETE: 'uninstall-unload-incomplete',
    ACCOUNT_RESOLUTION_UNAVAILABLE: 'account-resolution-unavailable',
    LAUNCHCTL_DISABLED: 'launchctl-disabled',
    ACCEPTANCE_GATE_DENIED: 'acceptance-gate-denied',
    CONFIRMATION_CONSUMED: 'confirmation-consumed',
  };

  const VALID_MANIFEST = {
    schemaVersion: 1,
    installationId: INSTALLATION_ID,
    scope: 'user-launch-agent',
    sourceCommit: SOURCE_COMMIT,
    runtimeArtifacts: {
      node: { pathId: 'host-node-executable', sha256: 'b'.repeat(64) },
      controller: { pathId: 'src/controller-runtime.js', sha256: 'c'.repeat(64) },
      agent: { pathId: 'src/agent.js', sha256: 'd'.repeat(64) },
    },
    transactionId: TRANSACTION_ID,
    controller: {
      label: 'com.linke.controller',
      filename: 'com.linke.controller.plist',
      plistSha256: 'e'.repeat(64),
    },
    scheduler: {
      label: 'com.linke.scheduler',
      filename: 'com.linke.scheduler.plist',
      plistSha256: 'f'.repeat(64),
    },
    activeAnchorId: ANCHOR_ID,
    installedAt: AT,
  };

  function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
  }

  function bytesEntry(text, identity) {
    const bytes = Buffer.from(text, 'utf8');
    const digest = sha256(bytes);
    return {
      priorState: 'bytes',
      bytesBase64: bytes.toString('base64'),
      sha256: digest,
      identity: { ...identity, sha256: digest },
    };
  }

  const CONTROLLER_IDENTITY = {
    rootId: 'current-user-launch-agents',
    basename: 'com.linke.controller.plist',
    type: 'regular-file',
    ownerUid: 501,
    device: 'device-controller',
    inode: 'inode-controller',
  };
  const SCHEDULER_IDENTITY = {
    rootId: 'current-user-launch-agents',
    basename: 'com.linke.scheduler.plist',
    type: 'regular-file',
    ownerUid: 501,
    device: 'device-scheduler',
    inode: 'inode-scheduler',
  };
  const MANIFEST_IDENTITY = {
    rootId: 'linke-launchagent-lifecycle-metadata',
    basename: 'active-manifest.json',
    type: 'regular-file',
    ownerUid: 501,
    device: 'device-manifest',
    inode: 'inode-manifest',
  };
  const CONTROLLER_ENTRY = bytesEntry('controller-plist-v1', CONTROLLER_IDENTITY);
  const SCHEDULER_ENTRY = bytesEntry('scheduler-plist-v1', SCHEDULER_IDENTITY);
  const MANIFEST_ENTRY = bytesEntry('manifest-v1', MANIFEST_IDENTITY);

  const VALID_ANCHOR = {
    schemaVersion: 1,
    anchorId: ANCHOR_ID,
    parentAnchorId: null,
    transactionId: TRANSACTION_ID,
    sourceCommit: SOURCE_COMMIT,
    purpose: 'managed-upgrade',
    rollbackFromManifestSha256: MANIFEST_ENTRY.sha256,
    restoreManifestSha256: MANIFEST_ENTRY.sha256,
    controller: CONTROLLER_ENTRY,
    scheduler: SCHEDULER_ENTRY,
    manifest: MANIFEST_ENTRY,
    loaded: { controller: true, scheduler: false },
    createdAt: AT,
  };

  const VALID_JOURNAL = {
    schemaVersion: 1,
    transactionId: TRANSACTION_ID,
    sequence: 0,
    previousEntrySha256: null,
    entrySha256: '5'.repeat(64),
    operation: 'install',
    state: 'prepared',
    at: AT,
    payload: { hostMutationCount: 0 },
  };

  const OPERATION_CHECKPOINTS = [
    ['controller-publish-intent', 'controller'],
    ['controller-published', 'controller'],
    ['scheduler-publish-intent', 'scheduler'],
    ['scheduler-published', 'scheduler'],
    ['manifest-publish-intent', 'manifest'],
    ['manifest-published', 'manifest'],
    ['controller-load-intent', 'controller'],
    ['scheduler-load-intent', 'scheduler'],
    ['scheduler-stop-intent', 'scheduler'],
    ['scheduler-stopped', 'scheduler'],
    ['controller-stop-intent', 'controller'],
    ['controller-stopped', 'controller'],
    ['role-noop', 'controller'],
    ['role-noop', 'scheduler'],
    ['role-stop-noop', 'controller'],
    ['role-stop-noop', 'scheduler'],
  ];
  const COMPENSATION_ACTIONS = [
    'remove-controller', 'remove-scheduler', 'remove-manifest',
    'restore-controller', 'restore-scheduler', 'restore-manifest',
    'stop-controller', 'stop-scheduler', 'load-controller', 'load-scheduler',
  ];
  const CONTROLLER_STORED_IDENTITY = {
    ...CONTROLLER_IDENTITY,
    sha256: CONTROLLER_ENTRY.sha256,
  };
  const CONTROLLER_FILE_PRESENT = {
    state: 'present',
    identity: CONTROLLER_STORED_IDENTITY,
    sha256: CONTROLLER_ENTRY.sha256,
  };
  const CONTROLLER_JOB_LOADED = {
    state: 'loaded',
    identitySha256: CONTROLLER_ENTRY.sha256,
  };
  const CONTROLLER_JOB_STOPPED = {
    state: 'stopped',
    identitySha256: null,
  };
  const VALID_REVERSE_PLAN = [
    {
      index: 0,
      action: 'stop-controller',
      role: 'controller',
      expectedPre: {
        file: CONTROLLER_FILE_PRESENT,
        job: CONTROLLER_JOB_LOADED,
      },
      expectedPost: {
        file: CONTROLLER_FILE_PRESENT,
        job: CONTROLLER_JOB_STOPPED,
      },
      evidence: {
        kind: 'candidate',
        transactionId: TRANSACTION_ID,
        role: 'controller',
        sha256: CONTROLLER_ENTRY.sha256,
      },
    },
    {
      index: 1,
      action: 'restore-controller',
      role: 'controller',
      expectedPre: {
        file: CONTROLLER_FILE_PRESENT,
        job: CONTROLLER_JOB_STOPPED,
      },
      expectedPost: {
        file: CONTROLLER_FILE_PRESENT,
        job: CONTROLLER_JOB_STOPPED,
      },
      evidence: {
        kind: 'anchor',
        anchorId: ANCHOR_ID,
        role: 'controller',
        sha256: CONTROLLER_ENTRY.sha256,
        loaded: true,
      },
    },
  ];
  const VALID_REVERSE_PLAN_SHA256 = sha256(
    Buffer.from(JSON.stringify(VALID_REVERSE_PLAN), 'utf8'),
  );

  function checkpointJournal(state, payload, operation = 'managed-upgrade') {
    return {
      ...clone(VALID_JOURNAL),
      operation,
      state,
      payload,
    };
  }

  function journalEntryHash(entry) {
    return createHash('sha256').update(Buffer.from(JSON.stringify({
      schemaVersion: entry.schemaVersion,
      transactionId: entry.transactionId,
      sequence: entry.sequence,
      previousEntrySha256: entry.previousEntrySha256,
      operation: entry.operation,
      state: entry.state,
      at: entry.at,
      payload: entry.payload,
    }), 'utf8')).digest('hex');
  }

  function linkJournalEntries(entries) {
    let prior = null;
    for (const [index, entry] of entries.entries()) {
      entry.sequence = index;
      entry.previousEntrySha256 = prior?.entrySha256 ?? null;
      entry.entrySha256 = journalEntryHash(entry);
      prior = entry;
    }
    return entries;
  }

  function committedCloseout(checkpoints, terminalMutationCount) {
    const receipt = {
      ...clone(VALID_RECEIPT),
      state: 'committed',
      success: true,
      roles: {
        controller: {
          label: 'com.linke.controller',
          outcome: 'created',
          changed: true,
        },
        scheduler: {
          label: 'com.linke.scheduler',
          outcome: 'created',
          changed: true,
        },
      },
      hostMutationCount: terminalMutationCount,
      outcome: 'completed',
    };
    const receiptSha256 = createHash('sha256')
      .update(Buffer.from(JSON.stringify(receipt), 'utf8'))
      .digest('hex');
    const committed = checkpointJournal(
      'committed',
      { hostMutationCount: terminalMutationCount, receiptSha256 },
      'install',
    );
    return {
      entries: linkJournalEntries([...checkpoints, committed]),
      receipt,
    };
  }

  function noChangeCloseout(preparedMutationCount, terminalMutationCount) {
    const receipt = {
      ...clone(VALID_RECEIPT),
      operation: 'managed-upgrade',
      state: 'no-change',
      success: true,
      hostMutationCount: terminalMutationCount,
      outcome: 'no-change',
    };
    const receiptSha256 = createHash('sha256')
      .update(Buffer.from(JSON.stringify(receipt), 'utf8'))
      .digest('hex');
    return {
      entries: linkJournalEntries([
        checkpointJournal(
          'prepared',
          { hostMutationCount: preparedMutationCount },
          'managed-upgrade',
        ),
        checkpointJournal(
          'no-change',
          { hostMutationCount: terminalMutationCount, receiptSha256 },
          'managed-upgrade',
        ),
      ]),
      receipt,
    };
  }

  function closeoutFixture() {
    return committedCloseout([
      checkpointJournal('prepared', { hostMutationCount: 0 }, 'install'),
      checkpointJournal('anchored', { hostMutationCount: 0 }, 'install'),
      checkpointJournal(
        'controller-publish-intent',
        { hostMutationCount: 0, role: 'controller' },
        'install',
      ),
      checkpointJournal(
        'controller-published',
        { hostMutationCount: 1, role: 'controller' },
        'install',
      ),
      checkpointJournal(
        'scheduler-publish-intent',
        { hostMutationCount: 1, role: 'scheduler' },
        'install',
      ),
      checkpointJournal(
        'scheduler-published',
        { hostMutationCount: 2, role: 'scheduler' },
        'install',
      ),
      checkpointJournal(
        'manifest-publish-intent',
        { hostMutationCount: 2, role: 'manifest' },
        'install',
      ),
      checkpointJournal(
        'manifest-published',
        { hostMutationCount: 3, role: 'manifest' },
        'install',
      ),
      checkpointJournal(
        'controller-load-intent',
        { hostMutationCount: 3, role: 'controller' },
        'install',
      ),
      checkpointJournal('controller-loaded', { hostMutationCount: 4 }, 'install'),
      checkpointJournal('controller-ready', { hostMutationCount: 4 }, 'install'),
      checkpointJournal(
        'scheduler-load-intent',
        { hostMutationCount: 4, role: 'scheduler' },
        'install',
      ),
      checkpointJournal('scheduler-loaded', { hostMutationCount: 5 }, 'install'),
    ], 5);
  }

  const VALID_RECEIPT = {
    schemaVersion: 1,
    operation: 'install',
    state: 'blocked',
    success: false,
    sourceCommit: SOURCE_COMMIT,
    transactionId: TRANSACTION_ID,
    anchorId: ANCHOR_ID,
    completedAt: AT,
    roles: {
      controller: {
        label: 'com.linke.controller',
        outcome: 'unchanged',
        changed: false,
      },
      scheduler: {
        label: 'com.linke.scheduler',
        outcome: 'unchanged',
        changed: false,
      },
    },
    hostMutationCount: 0,
    outcome: 'label-in-use',
  };

  const VALID_ACCEPTANCE_REQUEST = {
    schemaVersion: 1,
    kind: 'non-production-acceptance-request',
    acceptanceId: ACCEPTANCE_ID,
    uid: 501,
    launchAgentsRootId: 'current-user-launch-agents',
    launchAgentsRootSha256: '6'.repeat(64),
    sourceCommit: SOURCE_COMMIT,
    runtimeArtifactsSha256: '7'.repeat(64),
    executeRequested: false,
    nonProductionConfirmed: false,
    preparedAt: AT,
  };

  const VALID_CONFIRMATION = {
    schemaVersion: 1,
    kind: 'non-production-confirmation',
    confirmationId: CONFIRMATION_ID,
    acceptanceId: ACCEPTANCE_ID,
    confirmed: true,
    confirmedAt: '2026-07-28T00:01:00.000Z',
  };

  const VALID_MANUAL_REPAIR_REQUEST = {
    schemaVersion: 1,
    kind: 'manual-repair-request',
    manualRepairRequestId: MANUAL_REPAIR_REQUEST_ID,
    transactionId: TRANSACTION_ID,
    mirLockSha256: '8'.repeat(64),
    anchorSha256: '9'.repeat(64),
    repairDeclarationSha256: '0'.repeat(64),
    executeRequested: false,
    manualRepairConfirmed: false,
    preparedAt: AT,
  };

  const VALID_MANUAL_REPAIR_CONFIRMATION = {
    schemaVersion: 1,
    kind: 'manual-repair-confirmation',
    confirmationId: MANUAL_REPAIR_CONFIRMATION_ID,
    manualRepairRequestId: MANUAL_REPAIR_REQUEST_ID,
    confirmed: true,
    confirmedAt: '2026-07-28T00:01:30.000Z',
  };

  const VALID_CONSUMED_CONFIRMATION = {
    schemaVersion: 1,
    confirmationId: CONFIRMATION_ID,
    acceptanceId: ACCEPTANCE_ID,
    sourceCommit: SOURCE_COMMIT,
    runtimeArtifactsSha256: '7'.repeat(64),
    consumedAt: '2026-07-28T00:02:00.000Z',
  };

  const VALID_CAPABILITY_PROJECTION = {
    schemaVersion: 1,
    acceptanceId: ACCEPTANCE_ID,
    confirmationId: CONFIRMATION_ID,
    executeAuthorized: true,
    sourceCommit: SOURCE_COMMIT,
    runtimeArtifactsSha256: '7'.repeat(64),
    issuedAt: '2026-07-28T00:03:00.000Z',
  };

  function clone(value) {
    return structuredClone(value);
  }

  function assertDeepFrozen(value, location = 'projection') {
    if (value === null || typeof value !== 'object') return;
    assert.equal(Object.isFrozen(value), true, location + ' must be frozen');
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && Object.hasOwn(descriptor, 'value')) {
        assertDeepFrozen(descriptor.value, location + '.' + String(key));
      }
    }
  }

  function assertProjection(validate, fixture) {
    const projected = validate(fixture);
    assert.deepEqual(projected, fixture);
    assert.notEqual(projected, fixture);
    assertDeepFrozen(projected);
    return projected;
  }

  function assertInvalid(validate, value) {
    assert.throws(
      () => validate(value),
      (error) => {
        assert.ok(error instanceof LaunchAgentLifecycleError);
        assert.equal(error.name, 'LaunchAgentLifecycleError');
        assert.equal(error.code, 'launchagent-lifecycle-invalid');
        assert.equal(error.message, 'launchagent-lifecycle-invalid');
        return true;
      },
    );
  }

  function withOwnData(fixture, key, value) {
    const candidate = clone(fixture);
    Object.defineProperty(candidate, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
    return candidate;
  }

  function withAccessor(fixture, key, onRead = () => {}) {
    const candidate = clone(fixture);
    Object.defineProperty(candidate, key, {
      configurable: true,
      enumerable: true,
      get() {
        onRead();
        return 'forbidden';
      },
    });
    return candidate;
  }

  function withSymbol(fixture) {
    const candidate = clone(fixture);
    candidate[Symbol('unexpected')] = true;
    return candidate;
  }

  function asArray(fixture) {
    return Object.assign([], clone(fixture));
  }

  function commonClosedSchemaCases(fixture) {
    return [
      ['unknown key', withOwnData(fixture, 'unexpected', true)],
      ['accessor key', withAccessor(fixture, 'unexpectedAccessor')],
      ['symbol key', withSymbol(fixture)],
      ['array shape', asArray(fixture)],
      ['null shape', null],
    ];
  }

  function dangerousFieldCases(fixture) {
    return [
      ['credential token', withOwnData(fixture, 'token', 'forbidden')],
      ['credential password', withOwnData(fixture, 'password', 'forbidden')],
      ['credential apiKey', withOwnData(fixture, 'apiKey', 'forbidden')],
      ['free text', withOwnData(fixture, 'freeText', 'forbidden')],
      ['absolute path', withOwnData(fixture, 'rawPath', '/private/tmp/forbidden')],
      ['stdout', withOwnData(fixture, 'stdout', 'forbidden')],
      ['stderr', withOwnData(fixture, 'stderr', 'forbidden')],
      ['argv', withOwnData(fixture, 'argv', ['forbidden'])],
      ['environment', withOwnData(fixture, 'env', { FORBIDDEN: 'value' })],
      ['command', withOwnData(fixture, 'command', 'forbidden')],
    ];
  }

  async function assertRejectsCases(t, validate, cases) {
    for (const [name, value] of cases) {
      await t.test(name, () => assertInvalid(validate, value));
    }
  }

  test('lifecycle constants expose only the frozen V1.46 vocabulary', () => {
    assert.deepEqual(LAUNCHAGENT_LIFECYCLE, EXPECTED_LIFECYCLE);
    assert.deepEqual(LAUNCHAGENT_LIFECYCLE_CODES, EXPECTED_CODES);
    assertDeepFrozen(LAUNCHAGENT_LIFECYCLE);
    assertDeepFrozen(LAUNCHAGENT_LIFECYCLE_CODES);
  });

  test('manifest validator returns a detached deeply frozen exact projection', () => {
    const input = clone(VALID_MANIFEST);
    const projected = assertProjection(validateLaunchAgentManifest, input);
    assert.notEqual(projected.runtimeArtifacts, input.runtimeArtifacts);
    assert.notEqual(projected.controller, input.controller);
    assert.equal(Object.isFrozen(input), false);
  });

  test('manifest validator rejects non-plain and closed-schema violations', async (t) => {
    class ManifestShape {}
    const classInstance = Object.assign(new ManifestShape(), clone(VALID_MANIFEST));
    const cases = [
      ...commonClosedSchemaCases(VALID_MANIFEST),
      ['undefined shape', undefined],
      ['primitive string', 'manifest'],
      ['primitive number', 1],
      ['date instance', new Date(AT)],
      ['class instance', classInstance],
      ['unknown nested key', (() => {
        const value = clone(VALID_MANIFEST);
        value.runtimeArtifacts.node.unexpected = true;
        return value;
      })()],
      ['non-enumerable own key', (() => {
        const value = clone(VALID_MANIFEST);
        Object.defineProperty(value, 'hidden', { value: true });
        return value;
      })()],
    ];
    await assertRejectsCases(t, validateLaunchAgentManifest, cases);
  });

  test('manifest validator never invokes hostile getters and normalizes proxy failures', () => {
    let reads = 0;
    const hostileGetter = withAccessor(VALID_MANIFEST, 'hostile', () => {
      reads += 1;
      throw new Error('getter-must-not-run');
    });
    assertInvalid(validateLaunchAgentManifest, hostileGetter);
    assert.equal(reads, 0);

    const throwingProxy = new Proxy(clone(VALID_MANIFEST), {
      ownKeys() {
        throw new Error('proxy-trap');
      },
    });
    assertInvalid(validateLaunchAgentManifest, throwingProxy);

    const deceptiveProxy = new Proxy(clone(VALID_MANIFEST), {
      ownKeys(target) {
        return Reflect.ownKeys(target).filter((key) => key !== 'scope');
      },
      getOwnPropertyDescriptor(target, key) {
        if (key === 'scope') return undefined;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    assertInvalid(validateLaunchAgentManifest, deceptiveProxy);
  });

  test('manifest validator rejects malformed fixed identity and integrity fields', async (t) => {
    const mutations = [
      ['schema version', ['schemaVersion'], 2],
      ['scope', ['scope'], 'system-launch-agent'],
      ['uppercase source commit', ['sourceCommit'], 'A'.repeat(40)],
      ['short source commit', ['sourceCommit'], 'a'.repeat(39)],
      ['uppercase artifact hash', ['runtimeArtifacts', 'node', 'sha256'], 'B'.repeat(64)],
      ['short artifact hash', ['runtimeArtifacts', 'controller', 'sha256'], 'c'.repeat(63)],
      ['non-canonical UTC', ['installedAt'], '2026-07-28T00:00:00Z'],
      ['invalid UTC', ['installedAt'], '2026-13-28T00:00:00.000Z'],
      ['controller label', ['controller', 'label'], 'com.linke.other'],
      ['scheduler label', ['scheduler', 'label'], 'com.linke.other'],
      ['controller filename', ['controller', 'filename'], 'controller.plist'],
      ['scheduler filename', ['scheduler', 'filename'], 'scheduler.plist'],
      ['node path id', ['runtimeArtifacts', 'node', 'pathId'], '/usr/bin/node'],
      ['controller path id', ['runtimeArtifacts', 'controller', 'pathId'], 'src/other.js'],
      ['agent path id', ['runtimeArtifacts', 'agent', 'pathId'], 'src/other.js'],
      ['installation id', ['installationId'], 'not-a-uuid'],
    ];
    for (const [name, path, replacement] of mutations) {
      await t.test(name, () => {
        const value = clone(VALID_MANIFEST);
        let target = value;
        for (const segment of path.slice(0, -1)) target = target[segment];
        target[path.at(-1)] = replacement;
        assertInvalid(validateLaunchAgentManifest, value);
      });
    }
    await assertRejectsCases(t, validateLaunchAgentManifest, dangerousFieldCases(VALID_MANIFEST));
    await t.test('EnvironmentVariables', () => {
      const value = clone(VALID_MANIFEST);
      value.controller.EnvironmentVariables = { TOKEN: 'forbidden' };
      assertInvalid(validateLaunchAgentManifest, value);
    });
    await t.test('shell field', () => {
      assertInvalid(validateLaunchAgentManifest, withOwnData(VALID_MANIFEST, 'shell', '/bin/sh'));
    });
  });

  test('anchor validator accepts exact byte and absence tagged unions', () => {
    assertProjection(validateLaunchAgentAnchor, VALID_ANCHOR);
    const withAbsence = clone(VALID_ANCHOR);
    withAbsence.scheduler = { priorState: 'absent' };
    withAbsence.loaded.scheduler = false;
    assertProjection(validateLaunchAgentAnchor, withAbsence);
  });

  test('anchor validator accepts stop purpose but still rejects illegal stop schema', () => {
    const stopAnchor = { ...clone(VALID_ANCHOR), purpose: 'stop' };
    assertProjection(validateLaunchAgentAnchor, stopAnchor);
    assertInvalid(
      validateLaunchAgentAnchor,
      withOwnData(stopAnchor, 'unexpected', true),
    );
  });

  test('anchor validator rejects ambiguous entries and unsafe identity data', async (t) => {
    const cases = [
      ...commonClosedSchemaCases(VALID_ANCHOR),
      ...dangerousFieldCases(VALID_ANCHOR),
      ['invalid anchor UUID', { ...clone(VALID_ANCHOR), anchorId: 'invalid' }],
      ['invalid source hash', { ...clone(VALID_ANCHOR), sourceCommit: 'A'.repeat(40) }],
      ['invalid created UTC', { ...clone(VALID_ANCHOR), createdAt: '2026-07-28T00:00:00Z' }],
      ['mixed absent entry', (() => {
        const value = clone(VALID_ANCHOR);
        value.scheduler = { priorState: 'absent', bytesBase64: 'Zm9v', sha256: '1'.repeat(64) };
        return value;
      })()],
      ['bytes entry without identity', (() => {
        const value = clone(VALID_ANCHOR);
        delete value.controller.identity;
        return value;
      })()],
      ['wrong root id', (() => {
        const value = clone(VALID_ANCHOR);
        value.controller.identity.rootId = 'other-root';
        return value;
      })()],
      ['wrong role basename', (() => {
        const value = clone(VALID_ANCHOR);
        value.controller.identity.basename = 'com.linke.scheduler.plist';
        return value;
      })()],
      ['absolute parent identity', (() => {
        const value = clone(VALID_ANCHOR);
        value.controller.identity.parent = '/Users/example/Library/LaunchAgents';
        return value;
      })()],
      ['non-boolean loaded state', (() => {
        const value = clone(VALID_ANCHOR);
        value.loaded.controller = 'true';
        return value;
      })()],
      ['bytes hash mismatch', (() => {
        const value = clone(VALID_ANCHOR);
        value.controller.sha256 = '9'.repeat(64);
        return value;
      })()],
    ];
    await assertRejectsCases(t, validateLaunchAgentAnchor, cases);
  });

  test('journal validator accepts the closed prepared entry', () => {
    assertProjection(validateLaunchAgentJournal, VALID_JOURNAL);
  });

  test('journal validator accepts exact operation-specific checkpoints', async (t) => {
    for (const [state, role] of OPERATION_CHECKPOINTS) {
      await t.test(`${state}:${role}`, () => {
        const operation = state === 'scheduler-stop-intent' ? 'install' : 'managed-upgrade';
        assertProjection(
          validateLaunchAgentJournal,
          checkpointJournal(state, { hostMutationCount: 0, role }, operation),
        );
      });
    }
  });

  test('journal validator accepts only closed compensation action checkpoints', async (t) => {
    for (const action of COMPENSATION_ACTIONS) {
      for (const phase of ['intent', 'completed']) {
        await t.test(`${action}:${phase}`, () => {
          const payload = phase === 'intent'
            ? {
                hostMutationCount: 0,
                action,
                planIndex: 0,
                reversePlanSha256: VALID_REVERSE_PLAN_SHA256,
              }
            : { hostMutationCount: 0, action };
          assertProjection(
            validateLaunchAgentJournal,
            checkpointJournal(
              `compensate-${action}-${phase}`,
              payload,
            ),
          );
        });
      }
    }
    await t.test('state/action mismatch', () => {
      assertInvalid(
        validateLaunchAgentJournal,
        checkpointJournal(
          'compensate-remove-controller-intent',
          { hostMutationCount: 0, action: 'restore-controller' },
        ),
      );
    });
    await t.test('unknown compensation action', () => {
      assertInvalid(
        validateLaunchAgentJournal,
        checkpointJournal(
          'compensate-run-command-intent',
          { hostMutationCount: 0, action: 'run-command' },
        ),
      );
    });
    await t.test('known action with unknown phase', () => {
      assertInvalid(
        validateLaunchAgentJournal,
        checkpointJournal(
          'compensate-remove-controller-started',
          { hostMutationCount: 0, action: 'remove-controller' },
        ),
      );
    });
  });

  test('final-review journal requires a durable evidence-bound reverse plan before compensation', () => {
    assertProjection(
      validateLaunchAgentJournal,
      checkpointJournal('compensating', {
        hostMutationCount: 4,
        reversePlan: VALID_REVERSE_PLAN,
        reversePlanSha256: VALID_REVERSE_PLAN_SHA256,
      }),
    );
  });

  test('final-review compensation intent is durably bound to its frozen plan action', () => {
    assertProjection(
      validateLaunchAgentJournal,
      checkpointJournal('compensate-stop-controller-intent', {
        hostMutationCount: 4,
        action: 'stop-controller',
        planIndex: 0,
        reversePlanSha256: VALID_REVERSE_PLAN_SHA256,
      }),
    );
  });

  test('final-review durable reverse plan rejects open or recomputed-in-memory shapes', async (t) => {
    const validCompensating = checkpointJournal('compensating', {
      hostMutationCount: 4,
      reversePlan: VALID_REVERSE_PLAN,
      reversePlanSha256: VALID_REVERSE_PLAN_SHA256,
    });
    await assertRejectsCases(t, validateLaunchAgentJournal, [
      ['compensating without durable reverse plan', checkpointJournal(
        'compensating',
        { hostMutationCount: 4 },
      )],
      ['reverse plan digest mismatch', {
        ...clone(validCompensating),
        payload: {
          ...clone(validCompensating.payload),
          reversePlanSha256: '9'.repeat(64),
        },
      }],
      ['reverse plan action order mismatch', (() => {
        const value = clone(validCompensating);
        value.payload.reversePlan.reverse();
        value.payload.reversePlanSha256 = sha256(
          Buffer.from(JSON.stringify(value.payload.reversePlan), 'utf8'),
        );
        return value;
      })()],
      ['reverse plan action without evidence', (() => {
        const value = clone(validCompensating);
        delete value.payload.reversePlan[0].evidence;
        value.payload.reversePlanSha256 = sha256(
          Buffer.from(JSON.stringify(value.payload.reversePlan), 'utf8'),
        );
        return value;
      })()],
      ['reverse plan action/role mismatch', (() => {
        const value = clone(validCompensating);
        value.payload.reversePlan[0].role = 'scheduler';
        value.payload.reversePlanSha256 = sha256(
          Buffer.from(JSON.stringify(value.payload.reversePlan), 'utf8'),
        );
        return value;
      })()],
      ['reverse plan expected state is not closed', (() => {
        const value = clone(validCompensating);
        value.payload.reversePlan[0].expectedPre.file.path = '/forbidden';
        value.payload.reversePlanSha256 = sha256(
          Buffer.from(JSON.stringify(value.payload.reversePlan), 'utf8'),
        );
        return value;
      })()],
      ['candidate evidence role mismatch', (() => {
        const value = clone(validCompensating);
        value.payload.reversePlan[0].evidence.role = 'scheduler';
        value.payload.reversePlanSha256 = sha256(
          Buffer.from(JSON.stringify(value.payload.reversePlan), 'utf8'),
        );
        return value;
      })()],
      ['anchor evidence loaded state is not boolean', (() => {
        const value = clone(validCompensating);
        value.payload.reversePlan[1].evidence.loaded = 'true';
        value.payload.reversePlanSha256 = sha256(
          Buffer.from(JSON.stringify(value.payload.reversePlan), 'utf8'),
        );
        return value;
      })()],
      ['compensation intent without plan binding', checkpointJournal(
        'compensate-stop-controller-intent',
        { hostMutationCount: 4, action: 'stop-controller' },
      )],
    ]);
  });

  test('operation-specific checkpoint role is state-bound and exact', () => {
    assertInvalid(
      validateLaunchAgentJournal,
      checkpointJournal(
        'controller-publish-intent',
        { hostMutationCount: 0, role: 'scheduler' },
      ),
    );
    assertInvalid(
      validateLaunchAgentJournal,
      checkpointJournal(
        'controller-publish-intent',
        { hostMutationCount: 0, role: 'controller', candidatePath: '/tmp/forbidden' },
      ),
    );
  });

  test('transaction closeout validator export is required for immutable operation chains', () => {
    assert.equal(
      typeof validateLaunchAgentTransactionCloseout,
      'function',
      'expected validateLaunchAgentTransactionCloseout to validate full journal/receipt closeout',
    );
  });

  if (typeof validateLaunchAgentTransactionCloseout === 'function') {
    test('transaction closeout accepts one immutable operation chain and aligned receipt', () => {
      assertProjection(validateLaunchAgentTransactionCloseout, closeoutFixture());
    });

    test('transaction closeout rejects a hash-valid mid-chain operation rewrite', () => {
      const fixture = closeoutFixture();
      fixture.entries[1].operation = 'managed-upgrade';
      linkJournalEntries(fixture.entries);
      assertInvalid(validateLaunchAgentTransactionCloseout, fixture);
    });

    test('transaction closeout rejects a hash-valid receipt operation rewrite', () => {
      const fixture = closeoutFixture();
      fixture.receipt.operation = 'managed-upgrade';
      fixture.entries.at(-1).payload.receiptSha256 = createHash('sha256')
        .update(Buffer.from(JSON.stringify(fixture.receipt), 'utf8'))
        .digest('hex');
      linkJournalEntries(fixture.entries);
      assertInvalid(validateLaunchAgentTransactionCloseout, fixture);
    });

    test('final-review transaction closeout validates the exact prior/state transition', () => {
      const fixture = committedCloseout([
        checkpointJournal('prepared', { hostMutationCount: 0 }, 'install'),
        checkpointJournal('controller-loaded', { hostMutationCount: 1 }, 'install'),
      ], 1);
      assertInvalid(validateLaunchAgentTransactionCloseout, fixture);
    });

    test('final-review transaction closeout rejects a decreasing hostMutationCount', () => {
      const fixture = closeoutFixture();
      const schedulerIntent = fixture.entries.find(
        (entry) => entry.state === 'scheduler-publish-intent',
      );
      schedulerIntent.payload.hostMutationCount = 0;
      linkJournalEntries(fixture.entries);
      assertInvalid(validateLaunchAgentTransactionCloseout, fixture);
    });

    test('final-review rejects prepared(9) -> controller-loaded(1) -> committed(0)', () => {
      const fixture = committedCloseout([
        checkpointJournal('prepared', { hostMutationCount: 9 }, 'install'),
        checkpointJournal('controller-loaded', { hostMutationCount: 1 }, 'install'),
      ], 0);
      assertInvalid(validateLaunchAgentTransactionCloseout, fixture);
    });

    test('final-review no-change closeout requires zero mutation on both sides', async (t) => {
      await t.test('prepared(0) -> no-change(0) is valid', () => {
        assertProjection(
          validateLaunchAgentTransactionCloseout,
          noChangeCloseout(0, 0),
        );
      });
      await t.test('prepared(9) -> no-change(9) is rejected', () => {
        assertInvalid(
          validateLaunchAgentTransactionCloseout,
          noChangeCloseout(9, 9),
        );
      });
      await t.test('prepared(0) -> no-change(9) is rejected', () => {
        assertInvalid(
          validateLaunchAgentTransactionCloseout,
          noChangeCloseout(0, 9),
        );
      });
    });
  }

  test('transaction prefix validator export is required for crash recovery chain checks', () => {
    assert.equal(
      typeof validateLaunchAgentTransactionPrefix,
      'function',
      'expected validateLaunchAgentTransactionPrefix to validate journal prefixes without a receipt',
    );
  });

  if (typeof validateLaunchAgentTransactionPrefix === 'function') {
    test('transaction prefix accepts a legal nonterminal prefix without a receipt', () => {
      const entries = linkJournalEntries([
        checkpointJournal('prepared', { hostMutationCount: 0 }, 'install'),
        checkpointJournal('anchored', { hostMutationCount: 0 }, 'install'),
        checkpointJournal(
          'controller-publish-intent',
          { hostMutationCount: 0, role: 'controller' },
          'install',
        ),
      ]);
      const projected = assertProjection(validateLaunchAgentTransactionPrefix, { entries });
      assert.deepEqual(Object.keys(projected), ['entries'], 'prefix projection must be exact single-key');
    });

    test('transaction prefix rejects a schema/hash-valid but transition-invalid chain', () => {
      // anchored -> controller-stop-intent 对 install 语义非法；但每条 entry 的
      // schema 与 canonical hash 全合法（linkJournalEntries 逐条重算）。
      const entries = linkJournalEntries([
        checkpointJournal('prepared', { hostMutationCount: 0 }, 'install'),
        checkpointJournal('anchored', { hostMutationCount: 0 }, 'install'),
        checkpointJournal(
          'controller-stop-intent',
          { hostMutationCount: 0, role: 'controller' },
          'install',
        ),
      ]);
      assertInvalid(validateLaunchAgentTransactionPrefix, { entries });
    });
  }

  test('journal validator rejects broken chain and free-form state', async (t) => {
    const cases = [
      ...commonClosedSchemaCases(VALID_JOURNAL),
      ...dangerousFieldCases(VALID_JOURNAL),
      ['invalid transaction UUID', { ...clone(VALID_JOURNAL), transactionId: 'invalid' }],
      ['invalid entry hash', { ...clone(VALID_JOURNAL), entrySha256: 'G'.repeat(64) }],
      ['invalid UTC', { ...clone(VALID_JOURNAL), at: '2026-07-28T00:00:00Z' }],
      ['negative sequence', { ...clone(VALID_JOURNAL), sequence: -1 }],
      ['fractional sequence', { ...clone(VALID_JOURNAL), sequence: 0.5 }],
      ['sequence zero with previous hash', {
        ...clone(VALID_JOURNAL),
        previousEntrySha256: '4'.repeat(64),
      }],
      ['unknown operation', { ...clone(VALID_JOURNAL), operation: 'execute-command' }],
      ['unknown state', { ...clone(VALID_JOURNAL), state: 'finished' }],
      ['free-form payload', { ...clone(VALID_JOURNAL), payload: { note: 'forbidden' } }],
      ['raw output payload', { ...clone(VALID_JOURNAL), payload: { stdout: 'forbidden' } }],
    ];
    await assertRejectsCases(t, validateLaunchAgentJournal, cases);
  });

  test('receipt validator accepts only closed operation outcomes', () => {
    assertProjection(validateLaunchAgentReceipt, VALID_RECEIPT);
  });

  test('final-review committed receipt requires success=true and outcome=completed', async (t) => {
    const validCommitted = {
      ...clone(VALID_RECEIPT),
      state: 'committed',
      success: true,
      outcome: 'completed',
    };
    await t.test('valid committed mapping', () => {
      assertProjection(validateLaunchAgentReceipt, validCommitted);
    });
    await assertRejectsCases(t, validateLaunchAgentReceipt, [
      ['committed cannot report success=false', {
        ...clone(validCommitted),
        success: false,
      }],
      ['committed cannot report ownership-mismatch', {
        ...clone(validCommitted),
        outcome: 'ownership-mismatch',
      }],
      ['committed false ownership-mismatch contradiction', {
        ...clone(validCommitted),
        success: false,
        outcome: 'ownership-mismatch',
      }],
    ]);
  });

  test('final-review recovered success is exclusive to recover after manual repair', async (t) => {
    const successfulRecovery = {
      ...clone(VALID_RECEIPT),
      operation: 'recover',
      state: 'recovered',
      success: true,
      outcome: 'completed',
    };
    await t.test('recover may report recovered success completed', () => {
      assertProjection(validateLaunchAgentReceipt, successfulRecovery);
    });
    for (const operation of ['install', 'managed-upgrade', 'stop']) {
      await t.test(`${operation} cannot report recovered success completed`, () => {
        assertInvalid(validateLaunchAgentReceipt, {
          ...clone(successfulRecovery),
          operation,
        });
      });
    }
    await t.test('ordinary stop recovered failure remains valid', () => {
      assertProjection(validateLaunchAgentReceipt, {
        ...clone(VALID_RECEIPT),
        operation: 'stop',
        state: 'recovered',
        success: false,
        outcome: 'stop-incomplete',
      });
    });
  });

  test('receipt validator rejects unsafe output and false completion shapes', async (t) => {
    const cases = [
      ...commonClosedSchemaCases(VALID_RECEIPT),
      ...dangerousFieldCases(VALID_RECEIPT),
      ['invalid transaction UUID', { ...clone(VALID_RECEIPT), transactionId: 'invalid' }],
      ['invalid source hash', { ...clone(VALID_RECEIPT), sourceCommit: 'A'.repeat(40) }],
      ['invalid UTC', { ...clone(VALID_RECEIPT), completedAt: '2026-07-28T00:00:00Z' }],
      ['unknown role', (() => {
        const value = clone(VALID_RECEIPT);
        value.roles.worker = value.roles.controller;
        return value;
      })()],
      ['wrong fixed label', (() => {
        const value = clone(VALID_RECEIPT);
        value.roles.controller.label = 'com.linke.other';
        return value;
      })()],
      ['unknown role outcome', (() => {
        const value = clone(VALID_RECEIPT);
        value.roles.scheduler.outcome = 'restarted';
        return value;
      })()],
      ['non-boolean success', { ...clone(VALID_RECEIPT), success: 'false' }],
      ['non-boolean changed', (() => {
        const value = clone(VALID_RECEIPT);
        value.roles.controller.changed = 0;
        return value;
      })()],
      ['negative mutation count', { ...clone(VALID_RECEIPT), hostMutationCount: -1 }],
      ['unknown state', { ...clone(VALID_RECEIPT), state: 'finished' }],
      ['unknown outcome', { ...clone(VALID_RECEIPT), outcome: 'free-form-result' }],
    ];
    await assertRejectsCases(t, validateLaunchAgentReceipt, cases);
  });

  const CONTRACT_VALIDATORS = [
    ['acceptance request', validateLaunchAgentAcceptanceRequest, VALID_ACCEPTANCE_REQUEST],
    ['manual repair request', validateLaunchAgentAcceptanceRequest, VALID_MANUAL_REPAIR_REQUEST],
    ['confirmation record', validateLaunchAgentConfirmationRecord, VALID_CONFIRMATION],
    [
      'manual repair confirmation',
      validateLaunchAgentConfirmationRecord,
      VALID_MANUAL_REPAIR_CONFIRMATION,
    ],
    ['consumed confirmation', validateLaunchAgentConsumedConfirmation, VALID_CONSUMED_CONFIRMATION],
    ['capability projection', validateLaunchAgentCapabilityProjection, VALID_CAPABILITY_PROJECTION],
  ];

  test('acceptance and capability validators return detached frozen projections', async (t) => {
    for (const [name, validate, fixture] of CONTRACT_VALIDATORS) {
      await t.test(name, () => assertProjection(validate, fixture));
    }
  });

  test('acceptance and capability validators enforce closed sanitized schemas', async (t) => {
    for (const [name, validate, fixture] of CONTRACT_VALIDATORS) {
      await t.test(name, async (schemaTest) => {
        await assertRejectsCases(schemaTest, validate, [
          ...commonClosedSchemaCases(fixture),
          ...dangerousFieldCases(fixture),
        ]);
      });
    }
  });

  test('acceptance prepare flags and confirmation grant are literal booleans', async (t) => {
    const acceptanceCases = [
      ['execute requested true', { ...clone(VALID_ACCEPTANCE_REQUEST), executeRequested: true }],
      ['execute requested string', { ...clone(VALID_ACCEPTANCE_REQUEST), executeRequested: 'false' }],
      ['non-production confirmed true', {
        ...clone(VALID_ACCEPTANCE_REQUEST),
        nonProductionConfirmed: true,
      }],
      ['wrong request kind', { ...clone(VALID_ACCEPTANCE_REQUEST), kind: 'acceptance' }],
      ['invalid root hash', {
        ...clone(VALID_ACCEPTANCE_REQUEST),
        launchAgentsRootSha256: 'G'.repeat(64),
      }],
      ['invalid prepared UTC', {
        ...clone(VALID_ACCEPTANCE_REQUEST),
        preparedAt: '2026-07-28T00:00:00Z',
      }],
    ];
    await assertRejectsCases(t, validateLaunchAgentAcceptanceRequest, acceptanceCases);

    const manualRepairCases = [
      ['manual repair execute requested true', {
        ...clone(VALID_MANUAL_REPAIR_REQUEST),
        executeRequested: true,
      }],
      ['manual repair confirmed true', {
        ...clone(VALID_MANUAL_REPAIR_REQUEST),
        manualRepairConfirmed: true,
      }],
      ['invalid MIR lock hash', {
        ...clone(VALID_MANUAL_REPAIR_REQUEST),
        mirLockSha256: 'G'.repeat(64),
      }],
      ['invalid repair declaration hash', {
        ...clone(VALID_MANUAL_REPAIR_REQUEST),
        repairDeclarationSha256: 'G'.repeat(64),
      }],
    ];
    await assertRejectsCases(t, validateLaunchAgentAcceptanceRequest, manualRepairCases);

    const confirmationCases = [
      ['confirmation false', { ...clone(VALID_CONFIRMATION), confirmed: false }],
      ['confirmation string', { ...clone(VALID_CONFIRMATION), confirmed: 'true' }],
      ['wrong confirmation kind', { ...clone(VALID_CONFIRMATION), kind: 'confirmation' }],
      ['invalid confirmation UUID', { ...clone(VALID_CONFIRMATION), confirmationId: 'invalid' }],
      ['invalid confirmation UTC', {
        ...clone(VALID_CONFIRMATION),
        confirmedAt: '2026-07-28T00:01:00Z',
      }],
    ];
    await assertRejectsCases(t, validateLaunchAgentConfirmationRecord, confirmationCases);
    await assertRejectsCases(t, validateLaunchAgentConfirmationRecord, [
      ['manual repair confirmation false', {
        ...clone(VALID_MANUAL_REPAIR_CONFIRMATION),
        confirmed: false,
      }],
      ['manual repair request identity invalid', {
        ...clone(VALID_MANUAL_REPAIR_CONFIRMATION),
        manualRepairRequestId: 'invalid',
      }],
    ]);
  });

  test('consumed confirmation requires distinct valid binding identities', async (t) => {
    await assertRejectsCases(t, validateLaunchAgentConsumedConfirmation, [
      ['invalid confirmation UUID', {
        ...clone(VALID_CONSUMED_CONFIRMATION),
        confirmationId: 'invalid',
      }],
      ['invalid acceptance UUID', {
        ...clone(VALID_CONSUMED_CONFIRMATION),
        acceptanceId: 'invalid',
      }],
      ['same confirmation and acceptance identity', {
        ...clone(VALID_CONSUMED_CONFIRMATION),
        confirmationId: ACCEPTANCE_ID,
      }],
      ['invalid runtime hash', {
        ...clone(VALID_CONSUMED_CONFIRMATION),
        runtimeArtifactsSha256: 'G'.repeat(64),
      }],
      ['invalid consumed UTC', {
        ...clone(VALID_CONSUMED_CONFIRMATION),
        consumedAt: '2026-07-28T00:02:00Z',
      }],
    ]);
  });

  test('capability projection cannot serialize a private authority brand', async (t) => {
    const forbiddenKeys = [
      'brand',
      'privateBrand',
      'capability',
      'token',
      'secret',
      'constructor',
      'prototype',
    ];
    for (const key of forbiddenKeys) {
      await t.test(key, () => {
        assertInvalid(
          validateLaunchAgentCapabilityProjection,
          withOwnData(VALID_CAPABILITY_PROJECTION, key, 'forbidden'),
        );
      });
    }
    await t.test('executeAuthorized must be boolean', () => {
      assertInvalid(validateLaunchAgentCapabilityProjection, {
        ...clone(VALID_CAPABILITY_PROJECTION),
        executeAuthorized: 'true',
      });
    });
  });

  test('accepted public projections contain no secret or raw-host field names', () => {
    const forbidden = /token|password|secret|apiKey|authorization|environment|argv|stdout|stderr|path/i;
    const fixtures = [
      VALID_MANIFEST,
      VALID_ANCHOR,
      VALID_JOURNAL,
      VALID_RECEIPT,
      VALID_ACCEPTANCE_REQUEST,
      VALID_MANUAL_REPAIR_REQUEST,
      VALID_CONFIRMATION,
      VALID_MANUAL_REPAIR_CONFIRMATION,
      VALID_CONSUMED_CONFIRMATION,
      VALID_CAPABILITY_PROJECTION,
    ];

    function scan(value, trail = []) {
      if (value === null || typeof value !== 'object') return;
      for (const [key, nested] of Object.entries(value)) {
        const allowedPathId = key === 'pathId' && trail[0] === 'manifest';
        assert.equal(
          forbidden.test(key) && !allowedPathId,
          false,
          'forbidden public key: ' + [...trail, key].join('.'),
        );
        scan(nested, [...trail, key]);
      }
    }

    fixtures.forEach((fixture, index) => {
      scan(fixture, [index === 0 ? 'manifest' : 'fixture-' + index]);
    });
  });
}
