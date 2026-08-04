import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import {
  LAUNCHAGENT_LIFECYCLE,
  LaunchAgentLifecycleError,
} from './contracts.js';
import {
  MANAGEMENT_AUTH_KEYCHAIN_SCOPES_ENV,
  MANAGEMENT_AUTH_SOURCE_ENV,
  parseManagementAuthEnv,
} from '../management-auth-keychain.js';

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SHELL_METACHAR_PATTERN = /[;&|`$<>()[\]{}*?!~'"\\\0\r\n]/;
const RUNTIME_ARTIFACTS = Object.freeze({
  node: Object.freeze({ pathId: 'host-node-executable', relativePath: null }),
  controller: Object.freeze({
    pathId: 'src/controller-runtime.js',
    relativePath: 'src/controller-runtime.js',
  }),
  agent: Object.freeze({ pathId: 'src/agent.js', relativePath: 'src/agent.js' }),
  config: Object.freeze({ pathId: 'config/linke.json', relativePath: 'config/linke.json' }),
});
const ALLOWED_ENVIRONMENT_KEYS = Object.freeze([
  'DATA_DIR',
  'PORT',
  'LINKE_AGENT_HOST',
  'LINKE_AGENT_PORT',
  'LINKE_RESTORE_ROOT',
  'LINKE_RATE_LIMIT_PER_MINUTE',
  'LINKE_AUDIT_MAX_EVENTS',
  MANAGEMENT_AUTH_SOURCE_ENV,
  MANAGEMENT_AUTH_KEYCHAIN_SCOPES_ENV,
]);

function invalid() {
  throw new LaunchAgentLifecycleError();
}

function normalizeFailure(error) {
  if (error instanceof LaunchAgentLifecycleError) throw error;
  invalid();
}

function deepFreeze(value) {
  if (
    value === null
    || typeof value !== 'object'
    || ArrayBuffer.isView(value)
    || Object.isFrozen(value)
  ) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) deepFreeze(descriptor.value);
  }
  return Object.freeze(value);
}

function readExactObject(value, expectedKeys) {
  if (value === null || typeof value !== 'object') invalid();
  if (Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expectedKeys.length || ownKeys.some((key) => typeof key !== 'string')) {
    invalid();
  }
  const expected = new Set(expectedKeys);
  const fields = Object.create(null);
  for (const key of ownKeys) {
    if (!expected.has(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    fields[key] = descriptor.value;
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(fields, key)) invalid();
  }
  return fields;
}

function requireString(value) {
  if (typeof value !== 'string' || value.length === 0) invalid();
  return value;
}

function requireLiteral(value, expected) {
  if (value !== expected) invalid();
  return value;
}

function requireCommit(value) {
  if (typeof value !== 'string' || !COMMIT_PATTERN.test(value)) invalid();
  return value;
}

function requireSha256(value) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) invalid();
  return value;
}

function requireSafeAbsolutePath(value) {
  if (
    typeof value !== 'string'
    || !isAbsolute(value)
    || value.includes('\0')
    || SHELL_METACHAR_PATTERN.test(value)
  ) {
    invalid();
  }
  return value;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertInsideRoot(root, path) {
  const pathFromRoot = relative(root, path);
  if (pathFromRoot === '' || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`)) {
    invalid();
  }
}

async function inspectRegularFile(path, expectedCanonicalPath) {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) invalid();
  const canonicalPath = await realpath(path);
  if (canonicalPath !== expectedCanonicalPath) invalid();
  const bytes = await readFile(canonicalPath);
  return { absolutePath: canonicalPath, sha256: sha256(bytes) };
}

async function bindRuntime(value) {
  const fields = readExactObject(value, [
    'installationRoot',
    'nodeExecutable',
    'sourceCommit',
    'configPath',
  ]);
  const requestedRoot = requireSafeAbsolutePath(fields.installationRoot);
  const requestedNode = requireSafeAbsolutePath(fields.nodeExecutable);
  const requestedConfig = requireSafeAbsolutePath(fields.configPath);
  const sourceCommit = requireCommit(fields.sourceCommit);

  const installationRoot = await realpath(requestedRoot);
  requireSafeAbsolutePath(installationRoot);
  const rootStats = await lstat(installationRoot);
  if (!rootStats.isDirectory()) invalid();

  const expectedController = join(
    installationRoot,
    RUNTIME_ARTIFACTS.controller.relativePath,
  );
  const expectedAgent = join(installationRoot, RUNTIME_ARTIFACTS.agent.relativePath);
  const expectedConfig = join(installationRoot, RUNTIME_ARTIFACTS.config.relativePath);
  for (const path of [expectedController, expectedAgent, expectedConfig]) {
    assertInsideRoot(installationRoot, path);
  }

  const canonicalConfig = await realpath(requestedConfig);
  if (canonicalConfig !== expectedConfig) invalid();

  const expectedNode = await realpath(process.execPath);
  const canonicalRequestedNode = await realpath(requestedNode);
  if (canonicalRequestedNode !== expectedNode) invalid();

  const [node, controller, agent, config] = await Promise.all([
    inspectRegularFile(expectedNode, expectedNode),
    inspectRegularFile(expectedController, expectedController),
    inspectRegularFile(expectedAgent, expectedAgent),
    inspectRegularFile(expectedConfig, expectedConfig),
  ]);

  const runtimeArtifacts = {
    node: { pathId: RUNTIME_ARTIFACTS.node.pathId, ...node },
    controller: { pathId: RUNTIME_ARTIFACTS.controller.pathId, ...controller },
    agent: { pathId: RUNTIME_ARTIFACTS.agent.pathId, ...agent },
    config: { pathId: RUNTIME_ARTIFACTS.config.pathId, ...config },
  };
  const publicRuntimeArtifacts = Object.fromEntries(
    Object.entries(runtimeArtifacts).map(([role, artifact]) => [
      role,
      { pathId: artifact.pathId, sha256: artifact.sha256 },
    ]),
  );
  return deepFreeze({
    installationRoot,
    sourceCommit,
    runtimeArtifacts,
    publicProjection: {
      sourceCommit,
      runtimeArtifacts: publicRuntimeArtifacts,
    },
  });
}

/**
 * 将当前 Node、固定 controller/agent/config 文件绑定为不可变运行时身份。
 *
 * @param {unknown} value 闭合的安装根、Node、commit 与 config 输入。
 * @returns {Promise<object>} 含内部绝对路径和脱敏公开投影的深冻结绑定。
 */
export async function bindLaunchAgentRuntime(value) {
  try {
    return await bindRuntime(value);
  } catch (error) {
    normalizeFailure(error);
  }
}

function validateInternalArtifact(value, role) {
  const fields = readExactObject(value, ['pathId', 'absolutePath', 'sha256']);
  return {
    pathId: requireLiteral(fields.pathId, RUNTIME_ARTIFACTS[role].pathId),
    absolutePath: requireSafeAbsolutePath(fields.absolutePath),
    sha256: requireSha256(fields.sha256),
  };
}

function validatePublicArtifact(value, role, internal) {
  const fields = readExactObject(value, ['pathId', 'sha256']);
  const projection = {
    pathId: requireLiteral(fields.pathId, RUNTIME_ARTIFACTS[role].pathId),
    sha256: requireSha256(fields.sha256),
  };
  if (projection.pathId !== internal.pathId || projection.sha256 !== internal.sha256) invalid();
  return projection;
}

function validateBinding(value) {
  const fields = readExactObject(value, [
    'installationRoot',
    'sourceCommit',
    'runtimeArtifacts',
    'publicProjection',
  ]);
  const installationRoot = requireSafeAbsolutePath(fields.installationRoot);
  const sourceCommit = requireCommit(fields.sourceCommit);
  const artifactFields = readExactObject(fields.runtimeArtifacts, [
    'node',
    'controller',
    'agent',
    'config',
  ]);
  const runtimeArtifacts = {};
  for (const role of Object.keys(RUNTIME_ARTIFACTS)) {
    runtimeArtifacts[role] = validateInternalArtifact(artifactFields[role], role);
  }

  const publicFields = readExactObject(fields.publicProjection, [
    'sourceCommit',
    'runtimeArtifacts',
  ]);
  requireLiteral(publicFields.sourceCommit, sourceCommit);
  const publicArtifactFields = readExactObject(publicFields.runtimeArtifacts, [
    'node',
    'controller',
    'agent',
    'config',
  ]);
  const publicRuntimeArtifacts = {};
  for (const role of Object.keys(RUNTIME_ARTIFACTS)) {
    publicRuntimeArtifacts[role] = validatePublicArtifact(
      publicArtifactFields[role],
      role,
      runtimeArtifacts[role],
    );
  }

  const expectedPaths = {
    controller: join(installationRoot, RUNTIME_ARTIFACTS.controller.relativePath),
    agent: join(installationRoot, RUNTIME_ARTIFACTS.agent.relativePath),
    config: join(installationRoot, RUNTIME_ARTIFACTS.config.relativePath),
  };
  for (const role of ['controller', 'agent', 'config']) {
    assertInsideRoot(installationRoot, expectedPaths[role]);
    if (runtimeArtifacts[role].absolutePath !== expectedPaths[role]) invalid();
  }

  return {
    installationRoot,
    sourceCommit,
    runtimeArtifacts,
    publicProjection: { sourceCommit, runtimeArtifacts: publicRuntimeArtifacts },
  };
}

function validateControllerEnvironment(value) {
  if (value === null || typeof value !== 'object') invalid();
  if (Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) invalid();
  const allowed = new Set(ALLOWED_ENVIRONMENT_KEYS);
  const fields = Object.create(null);
  for (const key of ownKeys) {
    if (!allowed.has(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    if (typeof descriptor.value !== 'string') invalid();
    fields[key] = descriptor.value;
  }

  let managementAuth;
  try {
    managementAuth = parseManagementAuthEnv(fields);
  } catch {
    invalid();
  }
  if (
    managementAuth.mode === 'keychain'
    && fields[MANAGEMENT_AUTH_KEYCHAIN_SCOPES_ENV] !== managementAuth.scopes.join(',')
  ) {
    invalid();
  }

  const projection = {};
  for (const key of ALLOWED_ENVIRONMENT_KEYS) {
    if (Object.hasOwn(fields, key)) projection[key] = fields[key];
  }
  return projection;
}

async function revalidateLiveBinding(binding) {
  const canonicalRoot = await realpath(binding.installationRoot);
  if (canonicalRoot !== binding.installationRoot) invalid();
  const rootStats = await lstat(canonicalRoot);
  if (!rootStats.isDirectory()) invalid();

  for (const role of Object.keys(RUNTIME_ARTIFACTS)) {
    const artifact = binding.runtimeArtifacts[role];
    const inspected = await inspectRegularFile(artifact.absolutePath, artifact.absolutePath);
    if (inspected.sha256 !== artifact.sha256) invalid();
  }
  const currentNode = await realpath(process.execPath);
  if (currentNode !== binding.runtimeArtifacts.node.absolutePath) invalid();
}

function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function renderPlistValue(value, depth) {
  const indent = '  '.repeat(depth);
  if (typeof value === 'string') return `${indent}<string>${escapeXml(value)}</string>`;
  if (typeof value === 'boolean') return `${indent}<${value ? 'true' : 'false'}/>`;
  if (Number.isSafeInteger(value)) return `${indent}<integer>${value}</integer>`;
  if (Array.isArray(value)) {
    const items = value.map((item) => renderPlistValue(item, depth + 1)).join('\n');
    return `${indent}<array>\n${items}\n${indent}</array>`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, nested]) => [
      `${'  '.repeat(depth + 1)}<key>${escapeXml(key)}</key>`,
      renderPlistValue(nested, depth + 1),
    ].join('\n')).join('\n');
    return `${indent}<dict>\n${entries}\n${indent}</dict>`;
  }
  invalid();
}

function renderPlist(descriptor) {
  const body = renderPlistValue(descriptor, 1);
  return Buffer.from([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    body,
    '</plist>',
    '',
  ].join('\n'), 'utf8');
}

async function renderProfiles(value) {
  const fields = readExactObject(value, [
    'binding',
    'scheduleSeconds',
    'controllerEnvironment',
  ]);
  const binding = validateBinding(fields.binding);
  if (
    !Number.isSafeInteger(fields.scheduleSeconds)
    || fields.scheduleSeconds < LAUNCHAGENT_LIFECYCLE.scheduleSeconds.min
    || fields.scheduleSeconds > LAUNCHAGENT_LIFECYCLE.scheduleSeconds.max
  ) {
    invalid();
  }
  const scheduleSeconds = fields.scheduleSeconds;
  const controllerEnvironment = validateControllerEnvironment(fields.controllerEnvironment);
  await revalidateLiveBinding(binding);

  const controllerDescriptor = {
    Label: LAUNCHAGENT_LIFECYCLE.labels.controller,
    ProgramArguments: [
      binding.runtimeArtifacts.node.absolutePath,
      binding.runtimeArtifacts.controller.absolutePath,
    ],
    RunAtLoad: true,
    KeepAlive: true,
    SoftResourceLimits: { Core: 0 },
    HardResourceLimits: { Core: 0 },
    EnvironmentVariables: controllerEnvironment,
  };
  const schedulerDescriptor = {
    Label: LAUNCHAGENT_LIFECYCLE.labels.scheduler,
    ProgramArguments: [
      binding.runtimeArtifacts.node.absolutePath,
      binding.runtimeArtifacts.agent.absolutePath,
      'run-once',
      '--config',
      binding.runtimeArtifacts.config.absolutePath,
    ],
    StartInterval: scheduleSeconds,
    RunAtLoad: false,
    SoftResourceLimits: { Core: 0 },
    HardResourceLimits: { Core: 0 },
  };
  const controllerBytes = renderPlist(controllerDescriptor);
  const schedulerBytes = renderPlist(schedulerDescriptor);
  const controllerSha256 = sha256(controllerBytes);
  const schedulerSha256 = sha256(schedulerBytes);
  const intervalExitPolicy = deepFreeze({
    exitCode0: 'normal-interval-completion',
    restartOnExit0: false,
    controllerCrash: false,
  });
  const manifestRuntimeArtifacts = deepFreeze(structuredClone(
    binding.publicProjection.runtimeArtifacts,
  ));
  const publicProjection = deepFreeze({
    sourceCommit: binding.sourceCommit,
    scheduleSeconds,
    runtimeArtifacts: structuredClone(manifestRuntimeArtifacts),
    controller: {
      label: LAUNCHAGENT_LIFECYCLE.labels.controller,
      filename: LAUNCHAGENT_LIFECYCLE.filenames.controller,
      plistSha256: controllerSha256,
    },
    scheduler: {
      label: LAUNCHAGENT_LIFECYCLE.labels.scheduler,
      filename: LAUNCHAGENT_LIFECYCLE.filenames.scheduler,
      plistSha256: schedulerSha256,
      intervalExitPolicy: structuredClone(intervalExitPolicy),
    },
  });

  return deepFreeze({
    controller: {
      label: LAUNCHAGENT_LIFECYCLE.labels.controller,
      filename: LAUNCHAGENT_LIFECYCLE.filenames.controller,
      descriptor: controllerDescriptor,
      plistBytes: controllerBytes,
      plistSha256: controllerSha256,
    },
    scheduler: {
      label: LAUNCHAGENT_LIFECYCLE.labels.scheduler,
      filename: LAUNCHAGENT_LIFECYCLE.filenames.scheduler,
      descriptor: schedulerDescriptor,
      plistBytes: schedulerBytes,
      plistSha256: schedulerSha256,
      intervalExitPolicy,
    },
    manifestRuntimeArtifacts,
    publicProjection,
  });
}

/**
 * 复核实时运行时绑定并渲染确定性的 controller/scheduler plist。
 *
 * @param {unknown} value 闭合的绑定、调度周期与 controller 环境变量。
 * @returns {Promise<object>} 内部描述符、plist 字节、哈希及脱敏公开投影。
 */
export async function renderLaunchAgentProfiles(value) {
  try {
    return await renderProfiles(value);
  } catch (error) {
    normalizeFailure(error);
  }
}
