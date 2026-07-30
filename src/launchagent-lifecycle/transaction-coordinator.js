import { createHash } from 'node:crypto';
import {
  LAUNCHAGENT_LIFECYCLE,
  LAUNCHAGENT_LIFECYCLE_CODES,
  LaunchAgentLifecycleError,
  validateLaunchAgentAnchor,
  validateLaunchAgentJournal,
  validateLaunchAgentManifest,
  validateLaunchAgentReceipt,
  validateLaunchAgentTransactionCloseout,
} from './contracts.js';

const DEPENDENCY_METHODS = Object.freeze({
  metadataStore: Object.freeze([
    'readJournalHeads', 'readJournal', 'appendJournal',
    'writeCandidate', 'readCandidate',
    'writeAnchor', 'readAnchor',
    'acquireTransactionLock', 'verifyTransactionLock', 'releaseTransactionLock',
    'acquireManualInterventionLock', 'verifyManualInterventionLock',
    'publishReceipt', 'readReceipt',
  ]),
  hostInspector: Object.freeze(['inspect', 'read', 'launchctlHostFacts']),
  profileRenderer: Object.freeze(['render', 'revalidate']),
  plistValidator: Object.freeze(['validate']),
  atomicPublisher: Object.freeze(['publishAbsent', 'replaceIfMatch', 'removeIfMatch']),
  launchctlRunner: Object.freeze(['run']),
  healthChecker: Object.freeze(['check']),
  clock: Object.freeze(['now', 'newId']),
});

const TERMINAL_STATES = new Set(['committed', 'recovered', 'no-change', 'blocked']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ROOT_LAUNCH_AGENTS = LAUNCHAGENT_LIFECYCLE.rootIds.launchAgents;
const ROOT_METADATA = LAUNCHAGENT_LIFECYCLE.rootIds.metadata;
const FILENAMES = LAUNCHAGENT_LIFECYCLE.filenames;
const LABELS = LAUNCHAGENT_LIFECYCLE.labels;

function invalid() {
  throw new LaunchAgentLifecycleError(LAUNCHAGENT_LIFECYCLE_CODES.INVALID);
}

function coded(code) {
  throw new LaunchAgentLifecycleError(code);
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value) || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}

function readExactObject(value, expectedKeys) {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    invalid();
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expectedKeys.length || ownKeys.some((key) => typeof key !== 'string')) {
    invalid();
  }
  const expected = new Set(expectedKeys);
  const result = Object.create(null);
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !expected.has(key)
      || !descriptor
      || !descriptor.enumerable
      || !Object.hasOwn(descriptor, 'value')
    ) {
      invalid();
    }
    result[key] = descriptor.value;
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(result, key)) invalid();
  }
  return result;
}

function requireUuid(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) invalid();
  return value;
}

function requireSha256(value) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) invalid();
  return value;
}

function requireCommit(value) {
  if (typeof value !== 'string' || !COMMIT_PATTERN.test(value)) invalid();
  return value;
}

function validateDependencies(value) {
  try {
    const dependencyKeys = Object.keys(DEPENDENCY_METHODS);
    const fields = readExactObject(value, dependencyKeys);
    const snapshot = {};
    for (const key of dependencyKeys) {
      const dependency = fields[key];
      if (
        dependency === null
        || typeof dependency !== 'object'
        || Object.getPrototypeOf(dependency) !== Object.prototype
      ) {
        invalid();
      }
      const expectedMethods = DEPENDENCY_METHODS[key];
      const ownKeys = Reflect.ownKeys(dependency);
      if (
        ownKeys.length !== expectedMethods.length
        || ownKeys.some((method) => typeof method !== 'string' || !expectedMethods.includes(method))
      ) {
        invalid();
      }
      const methods = {};
      for (const method of expectedMethods) {
        const descriptor = Object.getOwnPropertyDescriptor(dependency, method);
        if (
          !descriptor
          || !descriptor.enumerable
          || !Object.hasOwn(descriptor, 'value')
          || typeof descriptor.value !== 'function'
        ) {
          invalid();
        }
        methods[method] = descriptor.value;
      }
      snapshot[key] = Object.freeze(methods);
    }
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof LaunchAgentLifecycleError) throw error;
    invalid();
  }
}

function validateOperationInput(value) {
  const fields = readExactObject(value, [
    'sourceCommit', 'scheduleSeconds', 'controllerEnvironment',
  ]);
  const sourceCommit = requireCommit(fields.sourceCommit);
  if (
    !Number.isSafeInteger(fields.scheduleSeconds)
    || fields.scheduleSeconds < LAUNCHAGENT_LIFECYCLE.scheduleSeconds.min
    || fields.scheduleSeconds > LAUNCHAGENT_LIFECYCLE.scheduleSeconds.max
  ) {
    invalid();
  }
  if (
    fields.controllerEnvironment === null
    || typeof fields.controllerEnvironment !== 'object'
    || Object.getPrototypeOf(fields.controllerEnvironment) !== Object.prototype
  ) {
    invalid();
  }
  const environment = readExactObject(
    fields.controllerEnvironment,
    Object.keys(fields.controllerEnvironment),
  );
  for (const key of Object.keys(environment)) {
    if (typeof environment[key] !== 'string') invalid();
  }
  return deepFreeze({
    sourceCommit,
    scheduleSeconds: fields.scheduleSeconds,
    controllerEnvironment: { ...environment },
  });
}

function validateStopInput(value) {
  const fields = readExactObject(value, ['sourceCommit']);
  return deepFreeze({ sourceCommit: requireCommit(fields.sourceCommit) });
}

function validateRollbackInput(value) {
  const fields = readExactObject(value, ['sourceCommit', 'targetAnchorId']);
  return deepFreeze({
    sourceCommit: requireCommit(fields.sourceCommit),
    targetAnchorId: requireUuid(fields.targetAnchorId),
  });
}

function journalEntrySha256(entry) {
  return sha256Hex(Buffer.from(JSON.stringify({
    schemaVersion: entry.schemaVersion,
    transactionId: entry.transactionId,
    sequence: entry.sequence,
    previousEntrySha256: entry.previousEntrySha256,
    operation: entry.operation,
    state: entry.state,
    at: entry.at,
    payload: entry.payload,
  }), 'utf8'));
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function addressFor(role) {
  return {
    rootId: role === 'manifest' ? ROOT_METADATA : ROOT_LAUNCH_AGENTS,
    basename: FILENAMES[role],
  };
}

function isPresentIdentity(value) {
  return value !== null
    && typeof value === 'object'
    && Object.hasOwn(value, 'device')
    && Object.hasOwn(value, 'inode')
    && Object.hasOwn(value, 'sha256');
}

function projectFullIdentity(value, role, ownerUid) {
  const fields = readExactObject(value, [
    'rootId', 'basename', 'type', 'ownerUid', 'device', 'inode', 'sha256',
  ]);
  const address = addressFor(role);
  if (
    fields.rootId !== address.rootId
    || fields.basename !== address.basename
    || fields.type !== 'regular-file'
    || fields.ownerUid !== ownerUid
    || typeof fields.device !== 'string'
    || fields.device.length === 0
    || typeof fields.inode !== 'string'
    || fields.inode.length === 0
  ) {
    invalid();
  }
  requireSha256(fields.sha256);
  return deepFreeze({
    rootId: fields.rootId,
    basename: fields.basename,
    type: fields.type,
    ownerUid: fields.ownerUid,
    device: fields.device,
    inode: fields.inode,
    sha256: fields.sha256,
  });
}

function projectPublisherIdentity(value, role, ownerUid) {
  return projectFullIdentity(value, role, ownerUid);
}

function projectAbsentIdentity(value, role, ownerUid) {
  const fields = readExactObject(value, ['rootId', 'basename', 'type', 'ownerUid']);
  const address = addressFor(role);
  if (
    fields.rootId !== address.rootId
    || fields.basename !== address.basename
    || fields.type !== 'regular-file'
    || fields.ownerUid !== ownerUid
  ) {
    invalid();
  }
  return fields;
}

function candidateForPlist(candidateRef) {
  return {
    kind: 'launchagent-candidate',
    transactionId: candidateRef.transactionId,
    role: candidateRef.role,
    sha256: candidateRef.sha256,
  };
}

class FlowFailure extends Error {
  constructor(outcome, { forceManualIntervention = false } = {}) {
    super(outcome);
    this.outcome = outcome;
    this.forceManualIntervention = forceManualIntervention;
  }
}

/**
 * 创建 V1.46 用户级 LaunchAgent 事务协调器。
 * 所有宿主动作均经精确注入的窄适配器执行；本模块不直接访问文件系统或 launchctl。
 */
export function createLaunchAgentLifecycleCoordinator(dependencies) {
  const deps = validateDependencies(dependencies);

  async function readAndValidateHeads() {
    const snapshot = await deps.metadataStore.readJournalHeads();
    const fields = readExactObject(snapshot, ['kind', 'journalSha256', 'heads']);
    if (fields.kind !== 'journal-heads') invalid();
    requireSha256(fields.journalSha256);
    if (!Array.isArray(fields.heads)) invalid();

    let priorTransactionId = null;
    for (const rawHead of fields.heads) {
      const head = validateLaunchAgentJournal(rawHead);
      if (priorTransactionId !== null && priorTransactionId >= head.transactionId) invalid();
      priorTransactionId = head.transactionId;
      if (!TERMINAL_STATES.has(head.state)) {
        return { snapshot, blocker: head };
      }
      try {
        const receipt = validateLaunchAgentReceipt(
          await deps.metadataStore.readReceipt(head.transactionId),
        );
        const receiptSha256 = sha256Hex(Buffer.from(JSON.stringify(receipt), 'utf8'));
        if (
          receipt.transactionId !== head.transactionId
          || receipt.operation !== head.operation
          || receipt.state !== head.state
          || receipt.hostMutationCount !== head.payload.hostMutationCount
          || receiptSha256 !== head.payload.receiptSha256
        ) {
          return { snapshot, blocker: head };
        }
      } catch {
        return { snapshot, blocker: head };
      }
    }
    return { snapshot, blocker: null };
  }

  function createLockRecord(transactionId, ownerNonce) {
    return {
      schemaVersion: 1,
      transactionId,
      ownerPid: process.pid,
      ownerNonce,
      bootSessionIdentity: { available: false, value: null },
      processStartIdentity: { available: false, value: null },
    };
  }

  function receiptRoles(controller, scheduler) {
    return {
      controller: {
        label: LABELS.controller,
        outcome: controller.outcome,
        changed: controller.changed,
      },
      scheduler: {
        label: LABELS.scheduler,
        outcome: scheduler.outcome,
        changed: scheduler.changed,
      },
    };
  }

  async function beginTransaction(operation, sourceCommit, rendered) {
    const pre = await readAndValidateHeads();
    if (pre.blocker !== null) coded(LAUNCHAGENT_LIFECYCLE_CODES.RECOVERY_REQUIRED);

    const transactionId = requireUuid(deps.clock.newId());
    const ownerNonce = requireUuid(deps.clock.newId());
    const lockRef = await deps.metadataStore.acquireTransactionLock(
      createLockRecord(transactionId, ownerNonce),
    );
    const verified = await deps.metadataStore.verifyTransactionLock(lockRef);
    if (verified !== true) invalid();

    const post = await readAndValidateHeads();
    const snapshotChanged = !sameValue(pre.snapshot, post.snapshot);
    const context = {
      operation,
      sourceCommit,
      rendered,
      transactionId,
      lockRef,
      lastEntry: null,
      mutationCount: 0,
      anchorId: null,
      anchor: null,
      facts: null,
      identities: { controller: null, scheduler: null, manifest: null },
      candidateRefs: { controller: null, scheduler: null, manifest: null },
      restorationCandidateTransactionId: null,
      possiblePublisherMutations: new Set(),
      published: new Set(),
      stopped: new Set(),
      loadedNew: { controller: false, scheduler: false },
    };

    if (post.blocker !== null || snapshotChanged) {
      await appendJournal(context, 'prepared');
      const blocker = post.blocker
        ?? post.snapshot.heads.find((head) => (
          !pre.snapshot.heads.some((prior) => sameValue(prior, head))
        ))
        ?? pre.snapshot.heads[0]
        ?? null;
      context.anchorId = requireUuid(deps.clock.newId());
      return {
        context,
        terminal: await closeWithReceipt(context, {
          state: 'blocked',
          outcome: 'recovery-required',
          success: false,
          blockedByEntrySha256: blocker?.entrySha256 ?? null,
          roles: receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        }),
      };
    }

    await appendJournal(context, 'prepared');
    return { context, terminal: null };
  }

  async function appendJournal(context, state, extraPayload = {}) {
    const sequence = context.lastEntry === null ? 0 : context.lastEntry.sequence + 1;
    const payload = { hostMutationCount: context.mutationCount, ...extraPayload };
    const entry = {
      schemaVersion: 1,
      transactionId: context.transactionId,
      sequence,
      previousEntrySha256: context.lastEntry?.entrySha256 ?? null,
      entrySha256: '0'.repeat(64),
      operation: context.operation,
      state,
      at: deps.clock.now(),
      payload,
    };
    entry.entrySha256 = journalEntrySha256(entry);
    const projection = validateLaunchAgentJournal(entry);
    await deps.metadataStore.appendJournal({
      entry: projection,
      expectedPrior: context.lastEntry === null
        ? null
        : {
          transactionId: context.transactionId,
          sequence: context.lastEntry.sequence,
          entrySha256: context.lastEntry.entrySha256,
        },
      writerLockRef: context.lockRef,
    });
    context.lastEntry = projection;
    return projection;
  }

  async function closeWithReceipt(context, options) {
    if (context.anchorId === null) context.anchorId = requireUuid(deps.clock.newId());
    const receipt = validateLaunchAgentReceipt({
      schemaVersion: 1,
      operation: context.operation,
      state: options.state,
      success: options.success,
      sourceCommit: context.sourceCommit,
      transactionId: context.transactionId,
      anchorId: context.anchorId,
      completedAt: deps.clock.now(),
      roles: options.roles,
      hostMutationCount: context.mutationCount,
      outcome: options.outcome,
    });
    const receiptSha256 = sha256Hex(Buffer.from(JSON.stringify(receipt), 'utf8'));
    const terminalPayload = { receiptSha256 };
    if (options.state === 'blocked') {
      terminalPayload.blockedByEntrySha256 = options.blockedByEntrySha256 ?? null;
    }
    await appendJournal(context, options.state, terminalPayload);
    await deps.metadataStore.publishReceipt({ receipt, lockRef: context.lockRef });
    const entries = await deps.metadataStore.readJournal({
      transactionId: context.transactionId,
    });
    const persisted = validateLaunchAgentReceipt(
      await deps.metadataStore.readReceipt(context.transactionId),
    );
    const closeout = validateLaunchAgentTransactionCloseout({ entries, receipt: persisted });
    if (!sameValue(receipt, closeout.receipt)) invalid();
    await deps.metadataStore.releaseTransactionLock(context.lockRef);
    return closeout.receipt;
  }

  async function enterManualIntervention(context, roles) {
    await appendJournal(context, 'manual-intervention-required');
    const manualNonce = requireUuid(deps.clock.newId());
    const mirLockRef = await deps.metadataStore.acquireManualInterventionLock(
      createLockRecord(context.transactionId, manualNonce),
    );
    const verified = await deps.metadataStore.verifyManualInterventionLock(mirLockRef);
    if (verified !== true) invalid();
    await deps.metadataStore.releaseTransactionLock(context.lockRef, {
      manualInterventionLockRef: mirLockRef,
    });
    return validateLaunchAgentReceipt({
      schemaVersion: 1,
      operation: context.operation,
      state: 'manual-intervention-required',
      success: false,
      sourceCommit: context.sourceCommit,
      transactionId: context.transactionId,
      anchorId: context.anchorId,
      completedAt: deps.clock.now(),
      roles,
      hostMutationCount: context.mutationCount,
      outcome: 'manual-intervention-required',
    });
  }

  async function launchctlFacts() {
    const facts = await deps.hostInspector.launchctlHostFacts();
    const fields = readExactObject(facts, [
      'uid', 'rootId', 'basenames', 'resolvedPaths',
    ]);
    if (!Number.isSafeInteger(fields.uid) || fields.uid < 0) invalid();
    if (fields.rootId !== ROOT_LAUNCH_AGENTS) invalid();
    const basenames = readExactObject(fields.basenames, ['controller', 'scheduler']);
    const resolvedPaths = readExactObject(fields.resolvedPaths, ['controller', 'scheduler']);
    if (basenames.controller !== FILENAMES.controller || basenames.scheduler !== FILENAMES.scheduler) {
      invalid();
    }
    if (typeof resolvedPaths.controller !== 'string' || typeof resolvedPaths.scheduler !== 'string') {
      invalid();
    }
    return { uid: fields.uid, rootId: fields.rootId, basenames, resolvedPaths };
  }

  function launchctlRequest(facts, operation, role) {
    const domain = `gui/${facts.uid}`;
    const service = `${domain}/${LABELS[role]}`;
    let argv;
    if (operation === 'print') argv = ['print', service];
    else if (operation === 'bootstrap') argv = ['bootstrap', domain, facts.resolvedPaths[role]];
    else if (operation === 'bootout') argv = ['bootout', service];
    else invalid();
    return {
      operation,
      uid: facts.uid,
      rootId: facts.rootId,
      basename: facts.basenames[role],
      resolvedPath: facts.resolvedPaths[role],
      argv,
    };
  }

  async function probeJob(facts, role) {
    const result = await deps.launchctlRunner.run(launchctlRequest(facts, 'print', role));
    if (
      result === null
      || typeof result !== 'object'
      || (result.outcome !== 'ok' && result.outcome !== 'unknown-result')
    ) {
      invalid();
    }
    return result;
  }

  async function inspectCurrentState() {
    const inspected = {
      controller: await deps.hostInspector.inspect(addressFor('controller')),
      scheduler: await deps.hostInspector.inspect(addressFor('scheduler')),
      manifest: await deps.hostInspector.inspect(addressFor('manifest')),
    };
    const present = {
      controller: isPresentIdentity(inspected.controller),
      scheduler: isPresentIdentity(inspected.scheduler),
      manifest: isPresentIdentity(inspected.manifest),
    };
    const facts = await launchctlFacts();
    const identities = { controller: null, scheduler: null, manifest: null };
    for (const role of ['controller', 'scheduler', 'manifest']) {
      if (present[role]) {
        identities[role] = projectFullIdentity(inspected[role], role, facts.uid);
      }
    }
    const bytes = { controller: null, scheduler: null, manifest: null };
    for (const role of ['controller', 'scheduler', 'manifest']) {
      if (present[role]) bytes[role] = Buffer.from(await deps.hostInspector.read(identities[role]));
    }
    const jobs = {
      controller: await probeJob(facts, 'controller'),
      scheduler: await probeJob(facts, 'scheduler'),
    };
    return { identities, present, bytes, facts, jobs };
  }

  function parseManagedInstallation(snapshot, sourceCommit = null) {
    if (!snapshot.present.controller || !snapshot.present.scheduler || !snapshot.present.manifest) {
      return null;
    }
    let manifest;
    try {
      manifest = validateLaunchAgentManifest(
        JSON.parse(snapshot.bytes.manifest.toString('utf8')),
      );
    } catch {
      return null;
    }
    if (sourceCommit !== null && manifest.sourceCommit !== sourceCommit) return null;
    if (
      manifest.controller.plistSha256 !== snapshot.identities.controller.sha256
      || manifest.scheduler.plistSha256 !== snapshot.identities.scheduler.sha256
    ) {
      return null;
    }
    if (
      snapshot.identities.controller.ownerUid !== snapshot.facts.uid
      || snapshot.identities.scheduler.ownerUid !== snapshot.facts.uid
      || snapshot.identities.manifest.ownerUid !== snapshot.facts.uid
    ) {
      return null;
    }
    for (const role of ['controller', 'scheduler']) {
      const job = snapshot.jobs[role];
      if (job.outcome !== 'ok') return null;
      if (job.loaded && job.jobIdentitySha256 !== snapshot.identities[role].sha256) return null;
      if (!job.loaded && job.jobIdentitySha256 !== null) return null;
    }
    return manifest;
  }

  async function validateActiveAnchor(manifest) {
    try {
      const anchor = validateLaunchAgentAnchor(
        await deps.metadataStore.readAnchor(manifest.activeAnchorId),
      );
      if (
        anchor.anchorId !== manifest.activeAnchorId
        || anchor.transactionId !== manifest.transactionId
        || anchor.sourceCommit !== manifest.sourceCommit
      ) {
        invalid();
      }
      return anchor;
    } catch {
      return null;
    }
  }

  function anchorBytes(anchor, role) {
    const entry = anchor[role];
    if (entry.priorState !== 'bytes') return null;
    const bytes = Buffer.from(entry.bytesBase64, 'base64');
    if (sha256Hex(bytes) !== entry.sha256) invalid();
    return bytes;
  }

  function validateRollbackTarget(target, snapshot, manifest, targetAnchorId) {
    if (
      target.anchorId !== targetAnchorId
      || manifest.activeAnchorId !== targetAnchorId
      || target.rollbackFromManifestSha256 !== snapshot.identities.manifest.sha256
    ) {
      return null;
    }
    if (target.manifest.priorState === 'absent') {
      if (
        target.restoreManifestSha256 !== null
        || target.parentAnchorId !== null
        || target.controller.priorState !== 'absent'
        || target.scheduler.priorState !== 'absent'
        || target.loaded.controller
        || target.loaded.scheduler
      ) {
        return null;
      }
      return { manifest: null, bytes: null };
    }
    if (
      target.controller.priorState !== 'bytes'
      || target.scheduler.priorState !== 'bytes'
      || target.restoreManifestSha256 !== target.manifest.sha256
      || target.parentAnchorId === null
    ) {
      return null;
    }
    try {
      const bytes = anchorBytes(target, 'manifest');
      const restored = validateLaunchAgentManifest(JSON.parse(bytes.toString('utf8')));
      if (
        restored.activeAnchorId !== target.parentAnchorId
        || restored.controller.plistSha256 !== target.controller.sha256
        || restored.scheduler.plistSha256 !== target.scheduler.sha256
      ) {
        return null;
      }
      return { manifest: restored, bytes };
    } catch {
      return null;
    }
  }

  function anchorEntry(snapshot, role) {
    return {
      priorState: 'bytes',
      bytesBase64: snapshot.bytes[role].toString('base64'),
      sha256: snapshot.identities[role].sha256,
      identity: { ...snapshot.identities[role] },
    };
  }

  async function writeAnchor(
    context,
    snapshot,
    purpose,
    sourceCommit,
    parentAnchorId,
    rollbackFromManifestSha256 = undefined,
  ) {
    const present = purpose !== 'first-install';
    if (context.anchor !== null) invalid();
    if (context.anchorId === null) context.anchorId = requireUuid(deps.clock.newId());
    const rollbackFrom = rollbackFromManifestSha256 === undefined
      ? (present ? snapshot.identities.manifest.sha256 : null)
      : rollbackFromManifestSha256;
    const anchor = validateLaunchAgentAnchor({
      schemaVersion: 1,
      anchorId: context.anchorId,
      parentAnchorId,
      transactionId: context.transactionId,
      sourceCommit,
      purpose,
      rollbackFromManifestSha256: rollbackFrom,
      restoreManifestSha256: present ? snapshot.identities.manifest.sha256 : null,
      controller: present ? anchorEntry(snapshot, 'controller') : { priorState: 'absent' },
      scheduler: present ? anchorEntry(snapshot, 'scheduler') : { priorState: 'absent' },
      manifest: present ? anchorEntry(snapshot, 'manifest') : { priorState: 'absent' },
      loaded: present
        ? {
          controller: snapshot.jobs.controller.loaded,
          scheduler: snapshot.jobs.scheduler.loaded,
        }
        : { controller: false, scheduler: false },
      createdAt: deps.clock.now(),
    });
    const ref = await deps.metadataStore.writeAnchor(anchor);
    if (
      ref === null
      || typeof ref !== 'object'
      || ref.kind !== 'anchor'
      || ref.anchorId !== context.anchorId
      || !SHA256_PATTERN.test(ref.sha256)
    ) {
      invalid();
    }
    context.anchor = anchor;
    await appendJournal(context, 'anchored');
    return anchor;
  }

  function makeManifest(context, rendered, activeAnchorId, existingManifest = null) {
    return validateLaunchAgentManifest({
      schemaVersion: 1,
      installationId: existingManifest?.installationId ?? requireUuid(deps.clock.newId()),
      scope: LAUNCHAGENT_LIFECYCLE.scope,
      sourceCommit: context.sourceCommit,
      runtimeArtifacts: rendered.manifestRuntimeArtifacts,
      transactionId: context.transactionId,
      controller: {
        label: rendered.controller.label,
        filename: rendered.controller.filename,
        plistSha256: rendered.controller.plistSha256,
      },
      scheduler: {
        label: rendered.scheduler.label,
        filename: rendered.scheduler.filename,
        plistSha256: rendered.scheduler.plistSha256,
      },
      activeAnchorId,
      installedAt: deps.clock.now(),
    });
  }

  function projectCandidateRef(value, transactionId, role, sha256) {
    const fields = readExactObject(value, [
      'kind', 'transactionId', 'role', 'sha256',
    ]);
    if (
      fields.kind !== 'candidate'
      || fields.transactionId !== transactionId
      || fields.role !== role
      || fields.sha256 !== sha256
    ) {
      invalid();
    }
    requireUuid(fields.transactionId);
    requireSha256(fields.sha256);
    return deepFreeze({
      kind: 'candidate',
      transactionId: fields.transactionId,
      role: fields.role,
      sha256: fields.sha256,
    });
  }

  async function stageCandidates(context, bytesByRole) {
    for (const role of ['controller', 'scheduler', 'manifest']) {
      const candidateRef = await deps.metadataStore.writeCandidate({
        transactionId: context.transactionId,
        role,
        bytes: bytesByRole[role],
      });
      context.candidateRefs[role] = projectCandidateRef(
        candidateRef,
        context.transactionId,
        role,
        sha256Hex(bytesByRole[role]),
      );
    }

    for (const role of ['controller', 'scheduler']) {
      const bytes = await deps.metadataStore.readCandidate(context.candidateRefs[role]);
      if (!Buffer.isBuffer(bytes) || sha256Hex(bytes) !== context.candidateRefs[role].sha256) {
        invalid();
      }
      const lint = await deps.plistValidator.validate(candidateForPlist(context.candidateRefs[role]));
      if (lint === null || typeof lint !== 'object' || lint.valid !== true) {
        throw new FlowFailure('conditional-mutation-mismatch');
      }
    }
  }

  async function stageRollbackCandidates(context, target) {
    for (const role of ['controller', 'scheduler', 'manifest']) {
      const entry = target[role];
      if (entry.priorState !== 'bytes') continue;
      if (context.identities[role]?.sha256 === entry.sha256) continue;
      const bytes = anchorBytes(target, role);
      const candidateRef = await deps.metadataStore.writeCandidate({
        transactionId: context.transactionId,
        role,
        bytes,
      });
      context.candidateRefs[role] = projectCandidateRef(
        candidateRef,
        context.transactionId,
        role,
        entry.sha256,
      );
      const persisted = await deps.metadataStore.readCandidate(context.candidateRefs[role]);
      if (!Buffer.isBuffer(persisted) || Buffer.compare(persisted, bytes) !== 0) invalid();
      if (role !== 'manifest') {
        const lint = await deps.plistValidator.validate(
          candidateForPlist(context.candidateRefs[role]),
        );
        if (lint?.valid !== true) throw new FlowFailure('conditional-mutation-mismatch');
      }
    }
  }

  async function replaceCandidate(input, expected) {
    return deps.atomicPublisher.replaceIfMatch({ ...input, expected });
  }

  async function publishCandidate(context, role, expected = null) {
    await appendJournal(context, `${role}-publish-intent`, { role });
    const input = {
      ...addressFor(role),
      candidateRef: context.candidateRefs[role],
    };
    const result = expected === null
      ? await deps.atomicPublisher.publishAbsent(input)
      : await replaceCandidate(input, expected);
    if (result === null || typeof result !== 'object' || result.outcome !== 'ok') {
      throw new FlowFailure('conditional-mutation-mismatch');
    }
    context.possiblePublisherMutations.add(role);
    let inspected;
    let actualCandidatePublished = false;
    try {
      inspected = projectFullIdentity(
        await deps.hostInspector.inspect(addressFor(role)),
        role,
        context.facts.uid,
      );
      actualCandidatePublished = inspected.sha256 === context.candidateRefs[role].sha256
        && (
          expected === null
          || inspected.device !== expected.device
          || inspected.inode !== expected.inode
        );
      if (actualCandidatePublished) {
        context.mutationCount += 1;
        context.possiblePublisherMutations.delete(role);
        context.identities[role] = inspected;
        context.published.add(role);
      }
      const observedUnchanged = expected !== null && sameValue(inspected, expected);
      if (!actualCandidatePublished && !observedUnchanged) {
        if (context.possiblePublisherMutations.delete(role)) context.mutationCount += 1;
        throw new FlowFailure('conditional-mutation-mismatch', {
          forceManualIntervention: true,
        });
      }
      if (observedUnchanged) context.possiblePublisherMutations.delete(role);
      const claimed = projectPublisherIdentity(result.identity, role, context.facts.uid);
      if (
        !actualCandidatePublished
        || !sameValue(claimed, inspected)
      ) {
        throw new FlowFailure('conditional-mutation-mismatch', {
          forceManualIntervention: actualCandidatePublished,
        });
      }
    } catch (error) {
      if (error instanceof FlowFailure) throw error;
      if (context.possiblePublisherMutations.delete(role)) context.mutationCount += 1;
      throw new FlowFailure('conditional-mutation-mismatch', {
        forceManualIntervention: true,
      });
    }
    await appendJournal(context, `${role}-published`, { role });
  }

  async function removeManagedIdentity(context, role) {
    const expected = context.identities[role];
    if (expected === null) invalid();
    await appendJournal(context, `${role}-remove-intent`, { role });
    const result = await deps.atomicPublisher.removeIfMatch({
      ...addressFor(role),
      expected,
    });
    if (result?.outcome !== 'ok') {
      throw new FlowFailure('conditional-mutation-mismatch');
    }
    context.mutationCount += 1;
    context.possiblePublisherMutations.add(role);
    try {
      projectAbsentIdentity(
        await deps.hostInspector.inspect(addressFor(role)),
        role,
        context.facts.uid,
      );
    } catch {
      throw new FlowFailure('conditional-mutation-mismatch', {
        forceManualIntervention: true,
      });
    }
    context.possiblePublisherMutations.delete(role);
    context.identities[role] = null;
    context.published.add(role);
    await appendJournal(context, `${role}-removed`, { role });
  }

  async function bootout(context, facts, role) {
    await appendJournal(context, `${role}-stop-intent`, { role });
    const result = await deps.launchctlRunner.run(launchctlRequest(facts, 'bootout', role));
    context.mutationCount += 1;
    if (result === null || typeof result !== 'object' || result.outcome !== 'ok') {
      const observed = await probeJob(facts, role);
      if (observed.outcome !== 'ok') {
        throw new FlowFailure('conditional-mutation-mismatch', {
          forceManualIntervention: true,
        });
      }
      if (observed.loaded === false) context.stopped.add(role);
      else if (
        observed.loaded !== true
        || observed.jobIdentitySha256 !== context.identities[role]?.sha256
      ) {
        throw new FlowFailure('conditional-mutation-mismatch', {
          forceManualIntervention: true,
        });
      }
      throw new FlowFailure('conditional-mutation-mismatch');
    }
    const observed = await probeJob(facts, role);
    if (observed.outcome !== 'ok') {
      throw new FlowFailure('conditional-mutation-mismatch', {
        forceManualIntervention: true,
      });
    }
    if (observed.loaded !== false) {
      throw new FlowFailure('conditional-mutation-mismatch');
    }
    context.stopped.add(role);
    await appendJournal(context, `${role}-stopped`, { role });
  }

  async function recoverIncompleteUnload(context, snapshot, outcome) {
    for (const role of ['controller', 'scheduler']) {
      const observed = await probeJob(snapshot.facts, role);
      if (observed.outcome !== 'ok') {
        return enterManualIntervention(
          context,
          receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        );
      }
      if (observed.loaded === false && observed.jobIdentitySha256 === null) {
        if (snapshot.jobs[role].loaded) context.stopped.add(role);
        continue;
      }
      if (
        observed.loaded !== true
        || !snapshot.jobs[role].loaded
        || observed.jobIdentitySha256 !== snapshot.identities[role].sha256
      ) {
        return enterManualIntervention(
          context,
          receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        );
      }
      context.stopped.delete(role);
    }
    return compensate(context, snapshot, outcome, 'upgrade');
  }

  async function unloadOwnedJobs(context, snapshot, incompleteOutcome) {
    for (const role of ['scheduler', 'controller']) {
      const fresh = await probeJob(snapshot.facts, role);
      const expectedLoaded = snapshot.jobs[role].loaded;
      if (
        fresh.outcome !== 'ok'
        || fresh.loaded !== expectedLoaded
        || (expectedLoaded && fresh.jobIdentitySha256 !== snapshot.identities[role].sha256)
        || (!expectedLoaded && fresh.jobIdentitySha256 !== null)
      ) {
        return closeWithReceipt(context, {
          state: 'blocked', outcome: 'ownership-mismatch', success: false,
          blockedByEntrySha256: null,
          roles: receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        });
      }
      if (!expectedLoaded) {
        await appendJournal(context, 'role-stop-noop', { role });
        continue;
      }
      try {
        await bootout(context, snapshot.facts, role);
      } catch (error) {
        if (!(error instanceof FlowFailure)) throw error;
        return recoverIncompleteUnload(context, snapshot, incompleteOutcome);
      }
    }
    for (const role of ['scheduler', 'controller']) {
      const observed = await probeJob(snapshot.facts, role);
      if (
        observed.outcome !== 'ok'
        || observed.loaded !== false
        || observed.jobIdentitySha256 !== null
      ) {
        return recoverIncompleteUnload(context, snapshot, incompleteOutcome);
      }
    }
    return null;
  }

  function controllerPort(input) {
    const raw = input.controllerEnvironment.PORT;
    if (typeof raw === 'string' && /^\d+$/.test(raw)) {
      const parsed = Number(raw);
      if (Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 65535) return parsed;
    }
    return 8899;
  }

  function controllerPortFromPlistBytes(value) {
    if (!Buffer.isBuffer(value)) invalid();
    const text = value.toString('utf8');
    let rawPort;
    try {
      const descriptor = JSON.parse(text);
      if (
        descriptor === null
        || typeof descriptor !== 'object'
        || Array.isArray(descriptor)
        || Object.getPrototypeOf(descriptor) !== Object.prototype
      ) {
        invalid();
      }
      const label = descriptor.Label ?? descriptor.label;
      if (label !== LABELS.controller) invalid();
      const environment = descriptor.EnvironmentVariables ?? descriptor.controllerEnvironment;
      if (
        environment === null
        || typeof environment !== 'object'
        || Array.isArray(environment)
        || Object.getPrototypeOf(environment) !== Object.prototype
      ) {
        invalid();
      }
      rawPort = environment.PORT;
    } catch (error) {
      if (error instanceof LaunchAgentLifecycleError) throw error;
      const labelMatches = [...text.matchAll(
        /<key>Label<\/key>\s*<string>([^<]*)<\/string>/g,
      )];
      if (labelMatches.length !== 1 || labelMatches[0][1] !== LABELS.controller) invalid();
      const portMatches = [...text.matchAll(
        /<key>PORT<\/key>\s*<string>([^<]*)<\/string>/g,
      )];
      if (portMatches.length > 1) invalid();
      rawPort = portMatches[0]?.[1];
    }
    if (rawPort === undefined) return 8899;
    if (typeof rawPort !== 'string' || !/^\d+$/.test(rawPort)) invalid();
    const parsed = Number(rawPort);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) invalid();
    return parsed;
  }

  async function revalidateRuntime(reason) {
    try {
      const result = await deps.profileRenderer.revalidate(reason);
      if (result === null || typeof result !== 'object' || result.ok !== true) {
        throw new FlowFailure('rollback-runtime-mismatch');
      }
      return result;
    } catch (error) {
      if (error instanceof FlowFailure) throw error;
      if (
        error instanceof LaunchAgentLifecycleError
        && error.code === LAUNCHAGENT_LIFECYCLE_CODES.ROLLBACK_RUNTIME_MISMATCH
      ) {
        throw new FlowFailure('rollback-runtime-mismatch');
      }
      throw new FlowFailure('rollback-runtime-mismatch');
    }
  }

  async function bootstrapController(context, facts, input, expectedSha256) {
    await appendJournal(context, 'controller-load-intent', { role: 'controller' });
    await revalidateRuntime('before-bootstrap-controller');
    const result = await deps.launchctlRunner.run(
      launchctlRequest(facts, 'bootstrap', 'controller'),
    );
    context.mutationCount += 1;
    if (result === null || typeof result !== 'object' || result.outcome !== 'ok') {
      const observed = await probeJob(facts, 'controller');
      if (observed.outcome !== 'ok') {
        throw new FlowFailure('controller-not-ready', { forceManualIntervention: true });
      }
      if (
        observed.loaded === true
        && observed.jobIdentitySha256 === expectedSha256
      ) {
        context.loadedNew.controller = true;
      } else if (observed.loaded !== false) {
        throw new FlowFailure('controller-not-ready', { forceManualIntervention: true });
      }
      throw new FlowFailure('controller-not-ready');
    }
    const observed = await probeJob(facts, 'controller');
    if (
      observed.outcome !== 'ok'
      || observed.loaded !== true
      || observed.jobIdentitySha256 !== expectedSha256
    ) {
      throw new FlowFailure('controller-not-ready', { forceManualIntervention: true });
    }
    context.loadedNew.controller = true;
    await appendJournal(context, 'controller-loaded');
    const health = await deps.healthChecker.check({ port: controllerPort(input) });
    if (
      health === null
      || typeof health !== 'object'
      || health.statusCode !== 200
      || health.ready !== true
    ) {
      throw new FlowFailure('controller-not-ready');
    }
    await appendJournal(context, 'controller-ready');
  }

  async function bootstrapScheduler(context, facts, expectedSha256) {
    await appendJournal(context, 'scheduler-load-intent', { role: 'scheduler' });
    await revalidateRuntime('before-bootstrap-scheduler');
    const result = await deps.launchctlRunner.run(
      launchctlRequest(facts, 'bootstrap', 'scheduler'),
    );
    context.mutationCount += 1;
    if (result === null || typeof result !== 'object' || result.outcome !== 'ok') {
      const observed = await probeJob(facts, 'scheduler');
      if (observed.outcome !== 'ok') {
        throw new FlowFailure('scheduler-load-failed', { forceManualIntervention: true });
      }
      if (
        observed.loaded === true
        && observed.jobIdentitySha256 === expectedSha256
      ) {
        context.loadedNew.scheduler = true;
      } else if (observed.loaded !== false) {
        throw new FlowFailure('scheduler-load-failed', { forceManualIntervention: true });
      }
      throw new FlowFailure('scheduler-load-failed');
    }
    const observed = await probeJob(facts, 'scheduler');
    if (
      observed.outcome !== 'ok'
      || observed.loaded !== true
      || observed.jobIdentitySha256 !== expectedSha256
    ) {
      throw new FlowFailure('scheduler-load-failed', { forceManualIntervention: true });
    }
    context.loadedNew.scheduler = true;
    const scheduled = await probeJob(facts, 'scheduler');
    if (scheduled.outcome !== 'ok' || scheduled.scheduledOutcome !== 'ok') {
      if (scheduled.outcome !== 'ok') {
        throw new FlowFailure('scheduler-load-failed', { forceManualIntervention: true });
      }
      throw new FlowFailure('scheduler-load-failed');
    }
    await appendJournal(context, 'scheduler-loaded');
  }

  async function verifyLoadedPostState(context, facts) {
    for (const role of ['controller', 'scheduler']) {
      const observed = await probeJob(facts, role);
      if (
        observed.outcome !== 'ok'
        || observed.loaded !== true
        || observed.jobIdentitySha256 !== context.identities[role].sha256
      ) {
        throw new FlowFailure(role === 'controller' ? 'controller-not-ready' : 'scheduler-load-failed');
      }
    }
  }

  async function verifyCommittedFiles(context) {
    try {
      const current = {};
      for (const role of ['controller', 'scheduler', 'manifest']) {
        current[role] = projectFullIdentity(
          await deps.hostInspector.inspect(addressFor(role)),
          role,
          context.facts.uid,
        );
        if (!sameValue(current[role], context.identities[role])) {
          throw new FlowFailure('conditional-mutation-mismatch');
        }
      }
      const manifest = validateLaunchAgentManifest(JSON.parse(
        Buffer.from(await deps.hostInspector.read(current.manifest)).toString('utf8'),
      ));
      if (
        manifest.transactionId !== context.transactionId
        || manifest.sourceCommit !== context.sourceCommit
        || manifest.activeAnchorId !== context.anchorId
        || manifest.controller.plistSha256 !== current.controller.sha256
        || manifest.scheduler.plistSha256 !== current.scheduler.sha256
        || !sameValue(manifest.runtimeArtifacts, context.rendered.manifestRuntimeArtifacts)
      ) {
        throw new FlowFailure('conditional-mutation-mismatch');
      }
      const anchor = await validateActiveAnchor(manifest);
      if (anchor === null) throw new FlowFailure('ownership-mismatch');
    } catch (error) {
      if (error instanceof FlowFailure) throw error;
      throw new FlowFailure('conditional-mutation-mismatch');
    }
  }

  async function applyRollbackFiles(context, target) {
    for (const role of ['controller', 'scheduler', 'manifest']) {
      const entry = target[role];
      if (entry.priorState === 'absent') {
        await removeManagedIdentity(context, role);
        continue;
      }
      if (context.identities[role]?.sha256 === entry.sha256) {
        if (role === 'manifest') invalid();
        const currentBytes = await deps.hostInspector.read(context.identities[role]);
        if (Buffer.compare(Buffer.from(currentBytes), anchorBytes(target, role)) !== 0) invalid();
        await appendJournal(context, 'role-noop', { role });
        continue;
      }
      await publishCandidate(context, role, context.identities[role]);
    }
  }

  async function replayRollbackLoadedState(context, target, targetControllerPort) {
    for (const role of ['controller', 'scheduler']) {
      if (!target.loaded[role]) {
        const observed = await probeJob(context.facts, role);
        if (
          observed.outcome !== 'ok'
          || observed.loaded !== false
          || observed.jobIdentitySha256 !== null
        ) {
          throw new FlowFailure('conditional-mutation-mismatch');
        }
        await appendJournal(context, 'role-load-noop', { role });
        continue;
      }
      if (role === 'controller') {
        await bootstrapController(
          context,
          context.facts,
          { controllerEnvironment: { PORT: String(targetControllerPort) } },
          context.identities.controller.sha256,
        );
      } else {
        await bootstrapScheduler(
          context,
          context.facts,
          context.identities.scheduler.sha256,
        );
      }
    }
  }

  async function verifyRollbackTarget(
    context,
    target,
    targetProjection,
    targetControllerPort,
  ) {
    await revalidateRuntime('before-commit');
    const persistedTarget = validateLaunchAgentAnchor(
      await deps.metadataStore.readAnchor(target.anchorId),
    );
    if (!sameValue(persistedTarget, target)) invalid();

    const currentBytes = { controller: null, scheduler: null, manifest: null };
    for (const role of ['controller', 'scheduler', 'manifest']) {
      const inspected = await deps.hostInspector.inspect(addressFor(role));
      if (target[role].priorState === 'absent') {
        projectAbsentIdentity(inspected, role, context.facts.uid);
        if (context.identities[role] !== null) invalid();
        continue;
      }
      const identity = projectFullIdentity(inspected, role, context.facts.uid);
      const bytes = Buffer.from(await deps.hostInspector.read(identity));
      if (
        identity.sha256 !== target[role].sha256
        || Buffer.compare(bytes, anchorBytes(target, role)) !== 0
        || !sameValue(identity, context.identities[role])
      ) {
        throw new FlowFailure('conditional-mutation-mismatch');
      }
      currentBytes[role] = bytes;
    }

    if (targetProjection.manifest !== null) {
      const restored = validateLaunchAgentManifest(
        JSON.parse(currentBytes.manifest.toString('utf8')),
      );
      if (!sameValue(restored, targetProjection.manifest)) invalid();
      const parent = await validateActiveAnchor(restored);
      if (parent === null || parent.anchorId !== target.parentAnchorId) {
        throw new FlowFailure('ownership-mismatch');
      }
    }

    for (const role of ['controller', 'scheduler']) {
      const observed = await probeJob(context.facts, role);
      const expectedLoaded = target.loaded[role];
      if (
        observed.outcome !== 'ok'
        || observed.loaded !== expectedLoaded
        || (
          expectedLoaded
            ? observed.jobIdentitySha256 !== context.identities[role]?.sha256
            : observed.jobIdentitySha256 !== null
        )
      ) {
        throw new FlowFailure('conditional-mutation-mismatch');
      }
    }
    if (target.loaded.controller) {
      const health = await deps.healthChecker.check({ port: targetControllerPort });
      if (health?.statusCode !== 200 || health?.ready !== true) {
        throw new FlowFailure('controller-not-ready');
      }
    }
  }

  async function verifyUninstalled(context) {
    for (const role of ['controller', 'scheduler', 'manifest']) {
      projectAbsentIdentity(
        await deps.hostInspector.inspect(addressFor(role)),
        role,
        context.facts.uid,
      );
      if (context.identities[role] !== null) invalid();
    }
    for (const role of ['controller', 'scheduler']) {
      const observed = await probeJob(context.facts, role);
      if (
        observed.outcome !== 'ok'
        || observed.loaded !== false
        || observed.jobIdentitySha256 !== null
      ) {
        throw new FlowFailure('conditional-mutation-mismatch');
      }
    }
  }

  async function completeInstall(context, input, snapshot) {
    context.anchorId = requireUuid(deps.clock.newId());
    const manifest = makeManifest(context, context.rendered, context.anchorId);
    const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    await writeAnchor(
      context,
      snapshot,
      'first-install',
      context.sourceCommit,
      null,
      sha256Hex(manifestBytes),
    );
    const candidateBytes = {
      controller: Buffer.from(context.rendered.controller.plistBytes),
      scheduler: Buffer.from(context.rendered.scheduler.plistBytes),
      manifest: manifestBytes,
    };
    try {
      await stageCandidates(context, candidateBytes);
    } catch (error) {
      if (!(error instanceof FlowFailure)) throw error;
      return closeWithReceipt(context, {
        state: 'blocked', outcome: error.outcome, success: false,
        blockedByEntrySha256: null,
        roles: receiptRoles(
          { outcome: 'unchanged', changed: false },
          { outcome: 'unchanged', changed: false },
        ),
      });
    }

    try {
      await publishCandidate(context, 'controller');
      await publishCandidate(context, 'scheduler');
      await revalidateRuntime('before-manifest-publish');
      await publishCandidate(context, 'manifest');
      await bootstrapController(
        context,
        snapshot.facts,
        input,
        context.candidateRefs.controller.sha256,
      );
      await bootstrapScheduler(
        context,
        snapshot.facts,
        context.candidateRefs.scheduler.sha256,
      );
      await verifyLoadedPostState(context, snapshot.facts);
      await revalidateRuntime('before-commit');
      await verifyCommittedFiles(context);
      return await closeWithReceipt(context, {
        state: 'committed', outcome: 'completed', success: true,
        roles: receiptRoles(
          { outcome: 'created', changed: true },
          { outcome: 'created', changed: true },
        ),
      });
    } catch (error) {
      if (!(error instanceof FlowFailure)) throw error;
      if (error.forceManualIntervention) {
        return enterManualIntervention(
          context,
          receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        );
      }
      if (context.mutationCount === 0) {
        return closeWithReceipt(context, {
          state: 'blocked', outcome: error.outcome, success: false,
          blockedByEntrySha256: null,
          roles: receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        });
      }
      return compensate(context, snapshot, error.outcome, 'install');
    }
  }

  async function stageRestorationCandidate(context, snapshot, role) {
    try {
      if (context.restorationCandidateTransactionId === null) {
        const namespace = requireUuid(deps.clock.newId());
        if (namespace === context.transactionId) {
          throw new FlowFailure('manual-intervention-required', {
            forceManualIntervention: true,
          });
        }
        context.restorationCandidateTransactionId = namespace;
      }
      const bytes = snapshot.bytes[role];
      const expectedSha256 = sha256Hex(bytes);
      const ref = projectCandidateRef(
        await deps.metadataStore.writeCandidate({
          // 正向 candidate 不可覆盖；补偿使用严格独立的持久化命名空间。
          transactionId: context.restorationCandidateTransactionId,
          role,
          bytes,
        }),
        context.restorationCandidateTransactionId,
        role,
        expectedSha256,
      );
      const persisted = await deps.metadataStore.readCandidate(ref);
      if (!Buffer.isBuffer(persisted) || sha256Hex(persisted) !== expectedSha256) {
        throw new FlowFailure('manual-intervention-required', {
          forceManualIntervention: true,
        });
      }
      context.candidateRefs[role] = ref;
      return ref;
    } catch (error) {
      if (error instanceof FlowFailure) throw error;
      throw new FlowFailure('manual-intervention-required', {
        forceManualIntervention: true,
      });
    }
  }

  async function removePublishedIdentity(context, role) {
    const input = { ...addressFor(role), expected: context.identities[role] };
    const result = await deps.atomicPublisher.removeIfMatch(input);
    if (result?.outcome !== 'ok') {
      throw new FlowFailure('manual-intervention-required', {
        forceManualIntervention: true,
      });
    }
    context.possiblePublisherMutations.add(role);
    context.mutationCount += 1;
    try {
      projectAbsentIdentity(
        await deps.hostInspector.inspect(addressFor(role)),
        role,
        context.facts.uid,
      );
    } catch {
      throw new FlowFailure('manual-intervention-required', {
        forceManualIntervention: true,
      });
    }
    context.possiblePublisherMutations.delete(role);
  }

  async function publishRestorationCandidate(context, role, candidateRef) {
    const expected = context.identities[role];
    const input = { ...addressFor(role), candidateRef };
    const result = expected === null
      ? await deps.atomicPublisher.publishAbsent(input)
      : await replaceCandidate(input, expected);
    if (result === null || typeof result !== 'object' || result.outcome !== 'ok') {
      throw new FlowFailure('manual-intervention-required', {
        forceManualIntervention: true,
      });
    }
    context.possiblePublisherMutations.add(role);
    context.mutationCount += 1;
    let inspected;
    try {
      const claimed = projectPublisherIdentity(result.identity, role, context.facts.uid);
      inspected = projectFullIdentity(
        await deps.hostInspector.inspect(addressFor(role)),
        role,
        context.facts.uid,
      );
      if (
        claimed.sha256 !== candidateRef.sha256
        || inspected.sha256 !== candidateRef.sha256
        || !sameValue(claimed, inspected)
        || (
          expected !== null
          && inspected.device === expected.device
          && inspected.inode === expected.inode
        )
      ) {
        throw new FlowFailure('manual-intervention-required', {
          forceManualIntervention: true,
        });
      }
    } catch (error) {
      if (error instanceof FlowFailure) throw error;
      throw new FlowFailure('manual-intervention-required', {
        forceManualIntervention: true,
      });
    }
    context.possiblePublisherMutations.delete(role);
    context.identities[role] = inspected;
  }

  function reverseFileState(identity) {
    if (identity === null) return { state: 'absent' };
    return {
      state: 'present',
      identity: { ...identity },
      sha256: identity.sha256,
    };
  }

  function reverseJobState(loaded, identity) {
    return loaded
      ? { state: 'loaded', identitySha256: identity.sha256 }
      : { state: 'stopped', identitySha256: null };
  }

  function reverseExpected(identity, loaded = false) {
    return {
      file: reverseFileState(identity),
      job: reverseJobState(loaded, identity),
    };
  }

  function candidateEvidence(context, role, identity) {
    const candidateRef = context.candidateRefs[role];
    if (
      candidateRef === null
      || candidateRef.role !== role
      || candidateRef.sha256 !== identity?.sha256
    ) {
      throw new FlowFailure('manual-intervention-required', {
        forceManualIntervention: true,
      });
    }
    return {
      kind: 'candidate',
      transactionId: candidateRef.transactionId,
      role,
      sha256: candidateRef.sha256,
    };
  }

  function anchorEvidence(context, snapshot, role) {
    const identity = snapshot.identities[role];
    if (identity === null) {
      throw new FlowFailure('manual-intervention-required', {
        forceManualIntervention: true,
      });
    }
    return {
      kind: 'anchor',
      anchorId: context.anchorId,
      role,
      sha256: identity.sha256,
      loaded: role === 'manifest' ? false : context.anchor.loaded[role],
    };
  }

  function makeReverseStep(context, snapshot, action, index) {
    const role = action.slice(action.indexOf('-') + 1);
    const currentIdentity = context.identities[role];
    const priorIdentity = snapshot.identities[role];
    if (action.startsWith('stop-')) {
      if (currentIdentity === null) invalid();
      return {
        index,
        action,
        role,
        expectedPre: reverseExpected(currentIdentity, true),
        expectedPost: reverseExpected(currentIdentity, false),
        evidence: candidateEvidence(context, role, currentIdentity),
      };
    }
    if (action.startsWith('remove-')) {
      if (currentIdentity === null) invalid();
      return {
        index,
        action,
        role,
        expectedPre: reverseExpected(currentIdentity, false),
        expectedPost: reverseExpected(null, false),
        evidence: candidateEvidence(context, role, currentIdentity),
      };
    }
    if (action.startsWith('restore-')) {
      if (priorIdentity === null) invalid();
      return {
        index,
        action,
        role,
        expectedPre: reverseExpected(currentIdentity, false),
        expectedPost: reverseExpected(priorIdentity, false),
        evidence: anchorEvidence(context, snapshot, role),
      };
    }
    if (action.startsWith('load-')) {
      if (priorIdentity === null) invalid();
      return {
        index,
        action,
        role,
        expectedPre: reverseExpected(priorIdentity, false),
        expectedPost: reverseExpected(priorIdentity, true),
        evidence: anchorEvidence(context, snapshot, role),
      };
    }
    invalid();
  }

  function buildReversePlan(context, snapshot, mode) {
    const actions = [];
    if (context.loadedNew.scheduler) actions.push('stop-scheduler');
    if (context.loadedNew.controller) actions.push('stop-controller');
    if (mode === 'install') {
      for (const role of ['manifest', 'scheduler', 'controller']) {
        if (context.published.has(role)) actions.push(`remove-${role}`);
      }
    } else {
      for (const role of ['manifest', 'scheduler', 'controller']) {
        if (context.published.has(role)) actions.push(`restore-${role}`);
      }
      if (context.anchor.loaded.controller && context.stopped.has('controller')) {
        actions.push('load-controller');
      }
      if (context.anchor.loaded.scheduler && context.stopped.has('scheduler')) {
        actions.push('load-scheduler');
      }
    }
    return actions.map((action, index) => makeReverseStep(
      context,
      snapshot,
      action,
      index,
    ));
  }

  async function verifyRecoveryTarget(context, snapshot) {
    await revalidateRuntime('compensate-before-close');
    const persistedAnchor = validateLaunchAgentAnchor(
      await deps.metadataStore.readAnchor(context.anchorId),
    );
    if (!sameValue(persistedAnchor, context.anchor)) {
      throw new FlowFailure('manual-intervention-required', {
        forceManualIntervention: true,
      });
    }

    const current = { controller: null, scheduler: null, manifest: null };
    const currentBytes = { controller: null, scheduler: null, manifest: null };
    for (const role of ['controller', 'scheduler', 'manifest']) {
      const inspected = await deps.hostInspector.inspect(addressFor(role));
      if (!snapshot.present[role]) {
        projectAbsentIdentity(inspected, role, context.facts.uid);
        if (context.identities[role] !== null) invalid();
        continue;
      }
      current[role] = projectFullIdentity(inspected, role, context.facts.uid);
      currentBytes[role] = Buffer.from(await deps.hostInspector.read(current[role]));
      if (
        current[role].sha256 !== snapshot.identities[role].sha256
        || Buffer.compare(currentBytes[role], snapshot.bytes[role]) !== 0
        || !sameValue(current[role], context.identities[role])
      ) {
        throw new FlowFailure('manual-intervention-required', {
          forceManualIntervention: true,
        });
      }
    }

    if (snapshot.present.manifest) {
      const manifest = validateLaunchAgentManifest(
        JSON.parse(currentBytes.manifest.toString('utf8')),
      );
      if (
        current.controller === null
        || current.scheduler === null
        || manifest.controller.plistSha256 !== current.controller.sha256
        || manifest.scheduler.plistSha256 !== current.scheduler.sha256
      ) {
        throw new FlowFailure('manual-intervention-required', {
          forceManualIntervention: true,
        });
      }
      const activeAnchor = await validateActiveAnchor(manifest);
      if (activeAnchor === null) {
        throw new FlowFailure('manual-intervention-required', {
          forceManualIntervention: true,
        });
      }
    }

    for (const role of ['controller', 'scheduler']) {
      const observed = await probeJob(snapshot.facts, role);
      const expectedLoaded = snapshot.jobs[role].loaded;
      if (
        observed.outcome !== 'ok'
        || observed.loaded !== expectedLoaded
        || (
          expectedLoaded
            ? observed.jobIdentitySha256 !== current[role]?.sha256
            : observed.jobIdentitySha256 !== null
        )
      ) {
        throw new FlowFailure('manual-intervention-required', {
          forceManualIntervention: true,
        });
      }
    }
    if (snapshot.jobs.controller.loaded) {
      const health = await deps.healthChecker.check({
        port: controllerPortFromPlistBytes(snapshot.bytes.controller),
      });
      if (health?.statusCode !== 200 || health?.ready !== true) {
        throw new FlowFailure('manual-intervention-required', {
          forceManualIntervention: true,
        });
      }
    }
  }

  function expectedCompensationUnion(context, snapshot, reversePlan, planIndex, role) {
    const currentStep = reversePlan[planIndex];
    if (currentStep?.role === role) {
      if (currentStep.action.startsWith('load-')) {
        return {
          file: reverseFileState(context.identities[role]),
          job: currentStep.expectedPre.job,
        };
      }
      return currentStep.expectedPre;
    }
    const loaded = role === 'manifest'
      ? false
      : (
        context.loadedNew[role]
        || (!context.stopped.has(role) && snapshot.jobs[role].loaded)
      );
    return reverseExpected(context.identities[role], loaded);
  }

  async function verifyCompensationEvidence(context, reversePlan) {
    for (const step of reversePlan) {
      const { evidence, role } = step;
      if (evidence.kind === 'candidate') {
        const bytes = await deps.metadataStore.readCandidate({ ...evidence });
        if (!Buffer.isBuffer(bytes) || sha256Hex(bytes) !== evidence.sha256) {
          throw new FlowFailure('manual-intervention-required', {
            forceManualIntervention: true,
          });
        }
        continue;
      }
      const anchorEntry = context.anchor?.[role];
      if (
        evidence.anchorId !== context.anchorId
        || anchorEntry?.priorState !== 'bytes'
        || anchorEntry.sha256 !== evidence.sha256
        || (role !== 'manifest' && context.anchor.loaded[role] !== evidence.loaded)
        || (role === 'manifest' && evidence.loaded !== false)
      ) {
        throw new FlowFailure('manual-intervention-required', {
          forceManualIntervention: true,
        });
      }
    }
  }

  async function verifyCompensationPrecondition(
    context,
    snapshot,
    facts,
    reversePlan,
    planIndex,
  ) {
    await revalidateRuntime('compensate-before-close');
    const persistedAnchor = validateLaunchAgentAnchor(
      await deps.metadataStore.readAnchor(context.anchorId),
    );
    if (!sameValue(persistedAnchor, context.anchor)) {
      throw new FlowFailure('manual-intervention-required', {
        forceManualIntervention: true,
      });
    }
    await verifyCompensationEvidence(context, reversePlan);

    for (const role of ['controller', 'scheduler', 'manifest']) {
      const expected = expectedCompensationUnion(
        context,
        snapshot,
        reversePlan,
        planIndex,
        role,
      );
      const inspected = await deps.hostInspector.inspect(addressFor(role));
      if (expected.file.state === 'absent') {
        projectAbsentIdentity(inspected, role, facts.uid);
      } else {
        const identity = projectFullIdentity(inspected, role, facts.uid);
        const bytes = await deps.hostInspector.read(identity);
        if (
          !sameValue(identity, expected.file.identity)
          || identity.sha256 !== expected.file.sha256
          || !Buffer.isBuffer(bytes)
          || sha256Hex(bytes) !== expected.file.sha256
        ) {
          throw new FlowFailure('manual-intervention-required', {
            forceManualIntervention: true,
          });
        }
      }
      if (role === 'manifest') continue;
      const observed = await probeJob(facts, role);
      const expectedLoaded = expected.job.state === 'loaded';
      if (
        observed.outcome !== 'ok'
        || observed.loaded !== expectedLoaded
        || observed.jobIdentitySha256 !== expected.job.identitySha256
      ) {
        throw new FlowFailure('manual-intervention-required', {
          forceManualIntervention: true,
        });
      }
    }
  }

  async function compensationAction(
    context,
    snapshot,
    facts,
    step,
    reversePlanSha256,
    reversePlan,
    input,
  ) {
    const { action } = step;
    await appendJournal(context, `compensate-${action}-intent`, {
      action,
      planIndex: step.index,
      reversePlanSha256,
    });
    await verifyCompensationPrecondition(
      context,
      snapshot,
      facts,
      reversePlan,
      step.index,
    );
    let result;
    if (action === 'stop-controller' || action === 'stop-scheduler') {
      const role = action.slice('stop-'.length);
      result = await deps.launchctlRunner.run(launchctlRequest(facts, 'bootout', role));
      context.mutationCount += 1;
      if (result?.outcome !== 'ok') throw new FlowFailure('manual-intervention-required');
      const observed = await probeJob(facts, role);
      if (observed.outcome !== 'ok' || observed.loaded !== false) {
        throw new FlowFailure('manual-intervention-required');
      }
      context.loadedNew[role] = false;
    } else if (action.startsWith('remove-')) {
      const role = action.slice('remove-'.length);
      await removePublishedIdentity(context, role);
      context.identities[role] = null;
    } else if (action.startsWith('restore-')) {
      const role = action.slice('restore-'.length);
      const ref = await stageRestorationCandidate(context, snapshot, role);
      await publishRestorationCandidate(context, role, ref);
    } else if (action === 'load-controller') {
      await revalidateRuntime('compensate-before-bootstrap-controller');
      result = await deps.launchctlRunner.run(launchctlRequest(facts, 'bootstrap', 'controller'));
      context.mutationCount += 1;
      if (result?.outcome !== 'ok') throw new FlowFailure('manual-intervention-required');
      const observed = await probeJob(facts, 'controller');
      if (
        observed.outcome !== 'ok'
        || observed.loaded !== true
        || observed.jobIdentitySha256 !== context.identities.controller.sha256
      ) {
        throw new FlowFailure('manual-intervention-required');
      }
      const health = await deps.healthChecker.check({ port: controllerPort(input) });
      if (health?.statusCode !== 200 || health?.ready !== true) {
        throw new FlowFailure('manual-intervention-required');
      }
      context.loadedNew.controller = true;
      context.stopped.delete('controller');
    } else if (action === 'load-scheduler') {
      await revalidateRuntime('compensate-before-bootstrap-scheduler');
      result = await deps.launchctlRunner.run(launchctlRequest(facts, 'bootstrap', 'scheduler'));
      context.mutationCount += 1;
      if (result?.outcome !== 'ok') throw new FlowFailure('manual-intervention-required');
      const observed = await probeJob(facts, 'scheduler');
      if (
        observed.outcome !== 'ok'
        || observed.loaded !== true
        || observed.jobIdentitySha256 !== context.identities.scheduler.sha256
      ) {
        throw new FlowFailure('manual-intervention-required');
      }
      context.loadedNew.scheduler = true;
      context.stopped.delete('scheduler');
    } else {
      invalid();
    }
    await appendJournal(context, `compensate-${action}-completed`, { action });
  }

  async function compensate(context, snapshot, outcome, mode) {
    try {
      const reversePlan = buildReversePlan(context, snapshot, mode);
      const reversePlanSha256 = sha256Hex(Buffer.from(JSON.stringify(reversePlan), 'utf8'));
      const recoveryInput = {
        controllerEnvironment: snapshot.present.controller
          ? { PORT: String(controllerPortFromPlistBytes(snapshot.bytes.controller)) }
          : {},
      };
      const compensating = await appendJournal(context, 'compensating', {
        reversePlan,
        reversePlanSha256,
      });
      for (const step of compensating.payload.reversePlan) {
        await compensationAction(
          context,
          snapshot,
          snapshot.facts,
          step,
          compensating.payload.reversePlanSha256,
          compensating.payload.reversePlan,
          recoveryInput,
        );
      }
      await verifyRecoveryTarget(context, snapshot);
    } catch {
      return enterManualIntervention(
        context,
        receiptRoles(
          { outcome: 'unchanged', changed: false },
          { outcome: 'unchanged', changed: false },
        ),
      );
    }
    return closeWithReceipt(context, {
      state: 'recovered', outcome, success: false,
      roles: receiptRoles(
        { outcome: mode === 'install' ? 'removed' : 'restored', changed: true },
        { outcome: mode === 'install' ? 'removed' : 'restored', changed: true },
      ),
    });
  }

  function desiredMatchesManifest(rendered, manifest, sourceCommit) {
    return manifest.sourceCommit === sourceCommit
      && sameValue(manifest.runtimeArtifacts, rendered.manifestRuntimeArtifacts)
      && manifest.controller.plistSha256 === rendered.controller.plistSha256
      && manifest.scheduler.plistSha256 === rendered.scheduler.plistSha256;
  }

  async function completeUpgrade(context, input, snapshot, manifest) {
    const controllerChanged = snapshot.identities.controller.sha256
      !== context.rendered.controller.plistSha256;
    const schedulerChanged = snapshot.identities.scheduler.sha256
      !== context.rendered.scheduler.plistSha256;
    const runtimeChanged = !sameValue(
      manifest.runtimeArtifacts,
      context.rendered.manifestRuntimeArtifacts,
    );
    const sourceCommitChanged = manifest.sourceCommit !== context.sourceCommit;
    const anySemanticChange = !desiredMatchesManifest(
      context.rendered,
      manifest,
      context.sourceCommit,
    );
    if (!anySemanticChange) {
      context.anchorId = manifest.activeAnchorId;
      return closeWithReceipt(context, {
        state: 'no-change', outcome: 'no-change', success: true,
        roles: receiptRoles(
          { outcome: 'unchanged', changed: false },
          { outcome: 'unchanged', changed: false },
        ),
      });
    }

    context.anchorId = requireUuid(deps.clock.newId());
    const nextManifest = makeManifest(context, context.rendered, context.anchorId, manifest);
    const nextManifestBytes = Buffer.from(JSON.stringify(nextManifest), 'utf8');
    await writeAnchor(
      context,
      snapshot,
      'managed-upgrade',
      context.sourceCommit,
      manifest.activeAnchorId,
      sha256Hex(nextManifestBytes),
    );
    const candidateBytes = {
      controller: Buffer.from(context.rendered.controller.plistBytes),
      scheduler: Buffer.from(context.rendered.scheduler.plistBytes),
      manifest: nextManifestBytes,
    };
    try {
      await stageCandidates(context, candidateBytes);
    } catch (error) {
      if (!(error instanceof FlowFailure)) throw error;
      return closeWithReceipt(context, {
        state: 'blocked', outcome: error.outcome, success: false,
        blockedByEntrySha256: null,
        roles: receiptRoles(
          { outcome: 'unchanged', changed: false },
          { outcome: 'unchanged', changed: false },
        ),
      });
    }

    const manifestOnly = sourceCommitChanged
      && !controllerChanged
      && !schedulerChanged
      && !runtimeChanged;
    try {
      if (manifestOnly) {
        await appendJournal(context, 'role-noop', { role: 'controller' });
        await appendJournal(context, 'role-noop', { role: 'scheduler' });
      } else {
        for (const role of ['scheduler', 'controller']) {
          if (snapshot.jobs[role].loaded) await bootout(context, snapshot.facts, role);
          else {
            const fresh = await probeJob(snapshot.facts, role);
            if (fresh.outcome !== 'ok' || fresh.loaded !== false) {
              throw new FlowFailure('ownership-mismatch');
            }
            await appendJournal(context, 'role-stop-noop', { role });
          }
        }
        if (controllerChanged) {
          await publishCandidate(context, 'controller', snapshot.identities.controller);
        } else {
          await appendJournal(context, 'role-noop', { role: 'controller' });
          context.identities.controller = snapshot.identities.controller;
        }
        if (schedulerChanged) {
          await publishCandidate(context, 'scheduler', snapshot.identities.scheduler);
        } else {
          await appendJournal(context, 'role-noop', { role: 'scheduler' });
          context.identities.scheduler = snapshot.identities.scheduler;
        }
      }

      await revalidateRuntime('before-manifest-publish');
      await publishCandidate(context, 'manifest', snapshot.identities.manifest);

      if (!manifestOnly) {
        await bootstrapController(
          context,
          snapshot.facts,
          input,
          context.identities.controller.sha256,
        );
        await bootstrapScheduler(context, snapshot.facts, context.identities.scheduler.sha256);
        await verifyLoadedPostState(context, snapshot.facts);
      }
      await revalidateRuntime('before-commit');
      await verifyCommittedFiles(context);
      return await closeWithReceipt(context, {
        state: 'committed', outcome: 'completed', success: true,
        roles: receiptRoles(
          {
            outcome: controllerChanged || runtimeChanged ? 'updated' : 'unchanged',
            changed: controllerChanged || runtimeChanged,
          },
          {
            outcome: schedulerChanged || runtimeChanged ? 'updated' : 'unchanged',
            changed: schedulerChanged || runtimeChanged,
          },
        ),
      });
    } catch (error) {
      if (!(error instanceof FlowFailure)) throw error;
      if (error.forceManualIntervention) {
        return enterManualIntervention(
          context,
          receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        );
      }
      if (context.mutationCount === 0) {
        return closeWithReceipt(context, {
          state: 'blocked', outcome: error.outcome, success: false,
          blockedByEntrySha256: null,
          roles: receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        });
      }
      return compensate(context, snapshot, error.outcome, 'upgrade');
    }
  }

  async function runInstallOrUpgrade(operation, input) {
    const normalized = validateOperationInput(input);
    const rendered = await deps.profileRenderer.render(normalized);
    const begun = await beginTransaction(operation, normalized.sourceCommit, rendered);
    if (begun.terminal !== null) return begun.terminal;
    const { context } = begun;
    const snapshot = await inspectCurrentState();
    context.facts = snapshot.facts;
    context.identities = { ...snapshot.identities };
    try {
      await revalidateRuntime('after-prepared-inspection');
    } catch (error) {
      if (!(error instanceof FlowFailure)) throw error;
      context.anchorId = requireUuid(deps.clock.newId());
      return closeWithReceipt(context, {
        state: 'blocked', outcome: error.outcome, success: false,
        blockedByEntrySha256: null,
        roles: receiptRoles(
          { outcome: 'unchanged', changed: false },
          { outcome: 'unchanged', changed: false },
        ),
      });
    }

    const allAbsent = !snapshot.present.controller
      && !snapshot.present.scheduler
      && !snapshot.present.manifest;
    if (allAbsent && operation === 'install') {
      if (
        snapshot.jobs.controller.outcome !== 'ok'
        || snapshot.jobs.scheduler.outcome !== 'ok'
        || snapshot.jobs.controller.loaded
        || snapshot.jobs.scheduler.loaded
      ) {
        context.anchorId = requireUuid(deps.clock.newId());
        return closeWithReceipt(context, {
          state: 'blocked', outcome: 'label-in-use', success: false,
          blockedByEntrySha256: null,
          roles: receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        });
      }
      return completeInstall(context, normalized, snapshot);
    }

    const manifest = parseManagedInstallation(snapshot);
    const activeAnchor = manifest === null ? null : await validateActiveAnchor(manifest);
    if (manifest === null || activeAnchor === null) {
      context.anchorId = requireUuid(deps.clock.newId());
      return closeWithReceipt(context, {
        state: 'blocked', outcome: 'ownership-mismatch', success: false,
        blockedByEntrySha256: null,
        roles: receiptRoles(
          { outcome: 'unchanged', changed: false },
          { outcome: 'unchanged', changed: false },
        ),
      });
    }
    return completeUpgrade(context, normalized, snapshot, manifest);
  }

  async function runStop(input) {
    const normalized = validateStopInput(input);
    const begun = await beginTransaction('stop', normalized.sourceCommit, null);
    if (begun.terminal !== null) return begun.terminal;
    const { context } = begun;
    const snapshot = await inspectCurrentState();
    context.facts = snapshot.facts;
    context.identities = { ...snapshot.identities };
    const manifest = parseManagedInstallation(snapshot, normalized.sourceCommit);
    const activeAnchor = manifest === null ? null : await validateActiveAnchor(manifest);
    if (manifest === null || activeAnchor === null) {
      context.anchorId = requireUuid(deps.clock.newId());
      return closeWithReceipt(context, {
        state: 'blocked', outcome: 'ownership-mismatch', success: false,
        blockedByEntrySha256: null,
        roles: receiptRoles(
          { outcome: 'unchanged', changed: false },
          { outcome: 'unchanged', changed: false },
        ),
      });
    }
    await writeAnchor(
      context,
      snapshot,
      'stop',
      normalized.sourceCommit,
      manifest.activeAnchorId,
    );

    for (const role of ['scheduler', 'controller']) {
      const fresh = await probeJob(snapshot.facts, role);
      const expectedLoaded = snapshot.jobs[role].loaded;
      const freshMatches = fresh.outcome === 'ok'
        && fresh.loaded === expectedLoaded
        && (
          !expectedLoaded
          || fresh.jobIdentitySha256 === context.identities[role].sha256
        );
      if (!freshMatches) {
        return closeWithReceipt(context, {
          state: 'blocked', outcome: 'ownership-mismatch', success: false,
          blockedByEntrySha256: null,
          roles: receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        });
      }
      if (!snapshot.jobs[role].loaded) {
        await appendJournal(context, 'role-stop-noop', { role });
        continue;
      }
      try {
        await bootout(context, snapshot.facts, role);
      } catch (error) {
        if (!(error instanceof FlowFailure)) throw error;
        if (context.stopped.size > 0) {
          return compensate(context, snapshot, 'stop-incomplete', 'upgrade');
        }
        try {
          await verifyRecoveryTarget(context, snapshot);
        } catch {
          return enterManualIntervention(
            context,
            receiptRoles(
              { outcome: 'unchanged', changed: false },
              { outcome: 'unchanged', changed: false },
            ),
          );
        }
        return closeWithReceipt(context, {
          state: 'recovered', outcome: 'stop-incomplete', success: false,
          roles: receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        });
      }
    }
    for (const role of ['controller', 'scheduler']) {
      const observed = await probeJob(snapshot.facts, role);
      if (
        observed.outcome !== 'ok'
        || observed.loaded !== false
        || observed.jobIdentitySha256 !== null
      ) {
        return enterManualIntervention(
          context,
          receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        );
      }
    }
    return closeWithReceipt(context, {
      state: 'committed', outcome: 'completed', success: true,
      roles: receiptRoles(
        {
          outcome: snapshot.jobs.controller.loaded ? 'unloaded' : 'unchanged',
          changed: snapshot.jobs.controller.loaded,
        },
        {
          outcome: snapshot.jobs.scheduler.loaded ? 'unloaded' : 'unchanged',
          changed: snapshot.jobs.scheduler.loaded,
        },
      ),
    });
  }

  async function runRollback(input) {
    const normalized = validateRollbackInput(input);
    const begun = await beginTransaction('rollback', normalized.sourceCommit, null);
    if (begun.terminal !== null) return begun.terminal;
    const { context } = begun;
    const snapshot = await inspectCurrentState();
    context.facts = snapshot.facts;
    context.identities = { ...snapshot.identities };
    const manifest = parseManagedInstallation(snapshot, normalized.sourceCommit);
    const target = manifest === null ? null : await validateActiveAnchor(manifest);
    const targetProjection = target === null
      ? null
      : validateRollbackTarget(
          target,
          snapshot,
          manifest,
          normalized.targetAnchorId,
        );
    if (manifest === null || target === null || targetProjection === null) {
      context.anchorId = requireUuid(deps.clock.newId());
      return closeWithReceipt(context, {
        state: 'blocked', outcome: 'ownership-mismatch', success: false,
        blockedByEntrySha256: null,
        roles: receiptRoles(
          { outcome: 'unchanged', changed: false },
          { outcome: 'unchanged', changed: false },
        ),
      });
    }
    const targetControllerPort = target.controller.priorState === 'bytes'
      ? controllerPortFromPlistBytes(anchorBytes(target, 'controller'))
      : null;
    try {
      await revalidateRuntime('after-prepared-inspection');
    } catch (error) {
      if (!(error instanceof FlowFailure)) throw error;
      context.anchorId = requireUuid(deps.clock.newId());
      return closeWithReceipt(context, {
        state: 'blocked', outcome: error.outcome, success: false,
        blockedByEntrySha256: null,
        roles: receiptRoles(
          { outcome: 'unchanged', changed: false },
          { outcome: 'unchanged', changed: false },
        ),
      });
    }

    await writeAnchor(
      context,
      snapshot,
      'rollback-compensation',
      normalized.sourceCommit,
      target.anchorId,
    );
    if (
      targetProjection.manifest !== null
      && !sameValue(targetProjection.manifest.runtimeArtifacts, manifest.runtimeArtifacts)
    ) {
      try {
        await verifyRecoveryTarget(context, snapshot);
      } catch {
        return enterManualIntervention(
          context,
          receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        );
      }
      return closeWithReceipt(context, {
        state: 'recovered', outcome: 'rollback-runtime-mismatch', success: false,
        roles: receiptRoles(
          { outcome: 'unchanged', changed: false },
          { outcome: 'unchanged', changed: false },
        ),
      });
    }

    try {
      await stageRollbackCandidates(context, target);
      const unloadResult = await unloadOwnedJobs(
        context,
        snapshot,
        'rollback-unload-incomplete',
      );
      if (unloadResult !== null) return unloadResult;
      await applyRollbackFiles(context, target);
      if (targetProjection.manifest !== null) {
        await revalidateRuntime('before-bootstrap-controller');
        await replayRollbackLoadedState(context, target, targetControllerPort);
      }
      await verifyRollbackTarget(
        context,
        target,
        targetProjection,
        targetControllerPort,
      );
      return await closeWithReceipt(context, {
        state: 'committed', outcome: 'completed', success: true,
        roles: receiptRoles(
          {
            outcome: target.controller.priorState === 'absent' ? 'removed' : 'restored',
            changed: true,
          },
          {
            outcome: target.scheduler.priorState === 'absent' ? 'removed' : 'restored',
            changed: true,
          },
        ),
      });
    } catch (error) {
      if (!(error instanceof FlowFailure)) throw error;
      if (context.mutationCount === 0) {
        return closeWithReceipt(context, {
          state: 'blocked', outcome: error.outcome, success: false,
          blockedByEntrySha256: null,
          roles: receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        });
      }
      return compensate(context, snapshot, error.outcome, 'upgrade');
    }
  }

  async function runUninstall(input) {
    const normalized = validateStopInput(input);
    const begun = await beginTransaction('uninstall', normalized.sourceCommit, null);
    if (begun.terminal !== null) return begun.terminal;
    const { context } = begun;
    const snapshot = await inspectCurrentState();
    context.facts = snapshot.facts;
    context.identities = { ...snapshot.identities };
    const manifest = parseManagedInstallation(snapshot, normalized.sourceCommit);
    const activeAnchor = manifest === null ? null : await validateActiveAnchor(manifest);
    if (manifest === null || activeAnchor === null) {
      context.anchorId = requireUuid(deps.clock.newId());
      return closeWithReceipt(context, {
        state: 'blocked', outcome: 'ownership-mismatch', success: false,
        blockedByEntrySha256: null,
        roles: receiptRoles(
          { outcome: 'unchanged', changed: false },
          { outcome: 'unchanged', changed: false },
        ),
      });
    }
    await writeAnchor(
      context,
      snapshot,
      'uninstall-compensation',
      normalized.sourceCommit,
      manifest.activeAnchorId,
    );

    try {
      const unloadResult = await unloadOwnedJobs(
        context,
        snapshot,
        'uninstall-unload-incomplete',
      );
      if (unloadResult !== null) return unloadResult;
      await removeManagedIdentity(context, 'scheduler');
      await removeManagedIdentity(context, 'controller');
      await removeManagedIdentity(context, 'manifest');
      await verifyUninstalled(context);
      return await closeWithReceipt(context, {
        state: 'committed', outcome: 'completed', success: true,
        roles: receiptRoles(
          { outcome: 'removed', changed: true },
          { outcome: 'removed', changed: true },
        ),
      });
    } catch (error) {
      if (!(error instanceof FlowFailure)) throw error;
      if (context.mutationCount === 0) {
        return closeWithReceipt(context, {
          state: 'blocked', outcome: error.outcome, success: false,
          blockedByEntrySha256: null,
          roles: receiptRoles(
            { outcome: 'unchanged', changed: false },
            { outcome: 'unchanged', changed: false },
          ),
        });
      }
      return compensate(context, snapshot, error.outcome, 'upgrade');
    }
  }

  return Object.freeze({
    async install(input) {
      return runInstallOrUpgrade('install', input);
    },

    async managedUpgrade(input) {
      return runInstallOrUpgrade('managed-upgrade', input);
    },

    async stop(input) {
      return runStop(input);
    },

    async rollback(input) {
      return runRollback(input);
    },

    async uninstall(input) {
      return runUninstall(input);
    },
  });
}
