import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseManagementAuthEnv } from '../src/management-auth-keychain.js';

const profilesUrl = new URL('../src/launchagent-lifecycle/profiles.js', import.meta.url);
const profilesPath = fileURLToPath(profilesUrl);
const profilesExists = existsSync(profilesPath);

test('profiles module exists before profile behavior tests', () => {
  assert.equal(
    profilesExists,
    true,
    'expected src/launchagent-lifecycle/profiles.js to exist before profile behavior tests',
  );
});

if (profilesExists) {
  const { bindLaunchAgentRuntime, renderLaunchAgentProfiles } = await import(profilesUrl);
  const execFileAsync = promisify(execFile);
  const SOURCE_COMMIT = 'a'.repeat(40);
  const CONTROLLER_SOURCE = fileURLToPath(new URL('../src/controller-runtime.js', import.meta.url));
  const AGENT_SOURCE = fileURLToPath(new URL('../src/agent.js', import.meta.url));
  const ALLOWED_ENVIRONMENT_KEYS = [
    'DATA_DIR',
    'PORT',
    'LINKE_AGENT_HOST',
    'LINKE_AGENT_PORT',
    'LINKE_RESTORE_ROOT',
    'LINKE_RATE_LIMIT_PER_MINUTE',
    'LINKE_AUDIT_MAX_EVENTS',
    'LINKE_MANAGEMENT_AUTH_SOURCE',
    'LINKE_MANAGEMENT_AUTH_KEYCHAIN_SCOPES',
  ];

  function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
  }

  async function assertInvalid(run) {
    await assert.rejects(run, {
      code: 'launchagent-lifecycle-invalid',
      message: 'launchagent-lifecycle-invalid',
    });
  }

  async function createFixture(prefix = 'linke-launchagent-profiles-') {
    const root = await mkdtemp(join(tmpdir(), prefix));
    const controllerPath = join(root, 'src', 'controller-runtime.js');
    const agentPath = join(root, 'src', 'agent.js');
    const configPath = join(root, 'config', 'linke.json');
    await mkdir(dirname(controllerPath), { recursive: true });
    await mkdir(dirname(configPath), { recursive: true });
    await copyFile(CONTROLLER_SOURCE, controllerPath);
    await copyFile(AGENT_SOURCE, agentPath);
    await writeFile(configPath, '{"schemaVersion":1}\n', { mode: 0o444 });
    await chmod(controllerPath, 0o444);
    await chmod(agentPath, 0o444);
    return { root, controllerPath, agentPath, configPath };
  }

  async function withFixture(run, prefix) {
    const fixture = await createFixture(prefix);
    try {
      return await run(fixture);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }

  async function bindFixture(fixture, overrides = {}) {
    return bindLaunchAgentRuntime({
      installationRoot: fixture.root,
      nodeExecutable: process.execPath,
      sourceCommit: SOURCE_COMMIT,
      configPath: fixture.configPath,
      ...overrides,
    });
  }

  async function render(binding, overrides = {}) {
    return renderLaunchAgentProfiles({
      binding,
      scheduleSeconds: 3600,
      controllerEnvironment: {},
      ...overrides,
    });
  }

  function assertDeepFrozen(value, location = 'binding') {
    if (value === null || typeof value !== 'object') return;
    assert.equal(Object.isFrozen(value), true, location + ' must be frozen');
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && Object.hasOwn(descriptor, 'value')) {
        assertDeepFrozen(descriptor.value, location + '.' + String(key));
      }
    }
  }

  function collectStringValues(value, strings = []) {
    if (typeof value === 'string') {
      strings.push(value);
      return strings;
    }
    if (value === null || typeof value !== 'object') return strings;
    for (const nested of Object.values(value)) collectStringValues(nested, strings);
    return strings;
  }

  test('runtime binder hashes the canonical fixed runtime artifacts', async () => {
    await withFixture(async (fixture) => {
      const binding = await bindFixture(fixture);
      const canonicalRoot = await realpath(fixture.root);
      const canonicalNode = await realpath(process.execPath);
      const expected = {
        node: {
          pathId: 'host-node-executable',
          absolutePath: canonicalNode,
          sha256: sha256(await readFile(canonicalNode)),
        },
        controller: {
          pathId: 'src/controller-runtime.js',
          absolutePath: await realpath(fixture.controllerPath),
          sha256: sha256(await readFile(fixture.controllerPath)),
        },
        agent: {
          pathId: 'src/agent.js',
          absolutePath: await realpath(fixture.agentPath),
          sha256: sha256(await readFile(fixture.agentPath)),
        },
        config: {
          pathId: 'config/linke.json',
          absolutePath: await realpath(fixture.configPath),
          sha256: sha256(await readFile(fixture.configPath)),
        },
      };

      assert.equal(binding.installationRoot, canonicalRoot);
      assert.equal(binding.sourceCommit, SOURCE_COMMIT);
      assert.deepEqual(binding.runtimeArtifacts, expected);
      assert.deepEqual(binding.publicProjection, {
        sourceCommit: SOURCE_COMMIT,
        runtimeArtifacts: {
          node: { pathId: expected.node.pathId, sha256: expected.node.sha256 },
          controller: {
            pathId: expected.controller.pathId,
            sha256: expected.controller.sha256,
          },
          agent: { pathId: expected.agent.pathId, sha256: expected.agent.sha256 },
          config: { pathId: expected.config.pathId, sha256: expected.config.sha256 },
        },
      });
      assertDeepFrozen(binding);
      for (const value of collectStringValues(binding.publicProjection)) {
        assert.equal(isAbsolute(value), false, 'public binding projection leaked an absolute path');
      }
    });
  });

  test('dual renderer emits fixed controller and scheduler descriptors', async () => {
    await withFixture(async (fixture) => {
      const binding = await bindFixture(fixture);
      const rendered = await render(binding);
      const nodePath = binding.runtimeArtifacts.node.absolutePath;
      const controllerPath = binding.runtimeArtifacts.controller.absolutePath;
      const agentPath = binding.runtimeArtifacts.agent.absolutePath;
      const configPath = binding.runtimeArtifacts.config.absolutePath;

      assert.deepEqual(rendered.controller.descriptor, {
        Label: 'com.linke.controller',
        ProgramArguments: [nodePath, controllerPath],
        RunAtLoad: true,
        KeepAlive: true,
        SoftResourceLimits: { Core: 0 },
        HardResourceLimits: { Core: 0 },
        EnvironmentVariables: {},
      });
      assert.equal(rendered.controller.label, 'com.linke.controller');
      assert.equal(rendered.controller.filename, 'com.linke.controller.plist');
      assert.equal(Object.hasOwn(rendered.controller.descriptor, 'StartInterval'), false);

      assert.deepEqual(rendered.scheduler.descriptor, {
        Label: 'com.linke.scheduler',
        ProgramArguments: [nodePath, agentPath, 'run-once', '--config', configPath],
        StartInterval: 3600,
        RunAtLoad: false,
        SoftResourceLimits: { Core: 0 },
        HardResourceLimits: { Core: 0 },
      });
      assert.equal(rendered.scheduler.label, 'com.linke.scheduler');
      assert.equal(rendered.scheduler.filename, 'com.linke.scheduler.plist');
      assert.equal(Object.hasOwn(rendered.scheduler.descriptor, 'KeepAlive'), false);
      assert.deepEqual(rendered.scheduler.intervalExitPolicy, {
        exitCode0: 'normal-interval-completion',
        restartOnExit0: false,
        controllerCrash: false,
      });
    });
  });

  test('schedule accepts only integer bounds 60 through 86400', async () => {
    await withFixture(async (fixture) => {
      const binding = await bindFixture(fixture);
      assert.equal(
        (await render(binding, { scheduleSeconds: 60 })).scheduler.descriptor.StartInterval,
        60,
      );
      assert.equal(
        (await render(binding, { scheduleSeconds: 86400 })).scheduler.descriptor.StartInterval,
        86400,
      );
      for (const invalid of [59, 86401, 60.5, '3600', null]) {
        await assertInvalid(() => render(binding, { scheduleSeconds: invalid }));
      }
    });
  });

  test('labels and filenames cannot be overridden by callers', async () => {
    await withFixture(async (fixture) => {
      const binding = await bindFixture(fixture);
      const attempts = [
        { label: 'com.example.controller' },
        { labels: { controller: 'com.example.controller' } },
        { filename: 'controller.plist' },
        { filenames: { scheduler: 'scheduler.plist' } },
      ];
      for (const attempt of attempts) {
        await assertInvalid(() => render(binding, attempt));
      }
    });
  });

  test('binder rejects relative paths, root escape, and another installation root', async () => {
    const first = await createFixture();
    const second = await createFixture();
    try {
      await assert.rejects(
        () => bindFixture(first, { installationRoot: 'relative/root' }),
        { code: 'launchagent-lifecycle-invalid', message: 'launchagent-lifecycle-invalid' },
      );
      await assert.rejects(
        () => bindFixture(first, { nodeExecutable: 'relative/node' }),
        { code: 'launchagent-lifecycle-invalid', message: 'launchagent-lifecycle-invalid' },
      );
      await assert.rejects(
        () => bindFixture(first, { configPath: join(first.root, '..', 'outside.json') }),
        { code: 'launchagent-lifecycle-invalid', message: 'launchagent-lifecycle-invalid' },
      );
      await assert.rejects(
        () => bindFixture(first, { configPath: second.configPath }),
        { code: 'launchagent-lifecycle-invalid', message: 'launchagent-lifecycle-invalid' },
      );
    } finally {
      await rm(first.root, { recursive: true, force: true });
      await rm(second.root, { recursive: true, force: true });
    }
  });

  test('binder rejects shell-metacharacter installation roots even when files exist', async () => {
    await withFixture(async (fixture) => {
      await assert.rejects(
        () => bindFixture(fixture),
        { code: 'launchagent-lifecycle-invalid', message: 'launchagent-lifecycle-invalid' },
      );
    }, 'linke;unsafe-');
  });

  test('binder rejects symlink and non-regular runtime artifacts', async () => {
    await withFixture(async (fixture) => {
      await rm(fixture.controllerPath);
      await symlink(CONTROLLER_SOURCE, fixture.controllerPath);
      await assert.rejects(
        () => bindFixture(fixture),
        { code: 'launchagent-lifecycle-invalid', message: 'launchagent-lifecycle-invalid' },
      );
    });

    await withFixture(async (fixture) => {
      await rm(fixture.agentPath);
      await mkdir(fixture.agentPath);
      await assert.rejects(
        () => bindFixture(fixture),
        { code: 'launchagent-lifecycle-invalid', message: 'launchagent-lifecycle-invalid' },
      );
    });

    await withFixture(async (fixture) => {
      await rm(fixture.configPath);
      await symlink(join(fixture.root, 'src', 'agent.js'), fixture.configPath);
      await assert.rejects(
        () => bindFixture(fixture),
        { code: 'launchagent-lifecycle-invalid', message: 'launchagent-lifecycle-invalid' },
      );
    });
  });

  test('renderer rejects pathId tampering and post-bind byte drift', async () => {
    await withFixture(async (fixture) => {
      const binding = await bindFixture(fixture);
      const tampered = structuredClone(binding);
      tampered.runtimeArtifacts.controller.pathId = 'src/agent.js';
      await assertInvalid(() => render(tampered));

      await chmod(fixture.agentPath, 0o644);
      await writeFile(fixture.agentPath, 'drifted-agent-bytes\n');
      await assert.rejects(
        async () => render(binding),
        { code: 'launchagent-lifecycle-invalid', message: 'launchagent-lifecycle-invalid' },
      );
    });
  });

  test('controller environment is closed and XML content is escaped', async () => {
    await withFixture(async (fixture) => {
      const binding = await bindFixture(fixture);
      const special = 'value&<>' + '"' + "'";
      const controllerEnvironment = {
        DATA_DIR: special,
        PORT: '3000',
        LINKE_AGENT_HOST: '127.0.0.1',
        LINKE_AGENT_PORT: '3001',
        LINKE_RESTORE_ROOT: '/private/tmp/linke-restore',
        LINKE_RATE_LIMIT_PER_MINUTE: '60',
        LINKE_AUDIT_MAX_EVENTS: '1000',
        LINKE_MANAGEMENT_AUTH_SOURCE: 'keychain',
        LINKE_MANAGEMENT_AUTH_KEYCHAIN_SCOPES: 'read,previous-read,write,previous-write,admin',
      };
      const rendered = await render(binding, { controllerEnvironment });
      assert.deepEqual(rendered.controller.descriptor.EnvironmentVariables, controllerEnvironment);
      assert.equal(Object.hasOwn(rendered.scheduler.descriptor, 'EnvironmentVariables'), false);

      const controllerXml = rendered.controller.plistBytes.toString('utf8');
      assert.match(controllerXml, /value&amp;&lt;&gt;&quot;&apos;/);
      assert.equal(controllerXml.includes(special), false);
      for (const key of ALLOWED_ENVIRONMENT_KEYS) assert.ok(controllerXml.includes(key));

      const schedulerXml = rendered.scheduler.plistBytes.toString('utf8');
      for (const key of ALLOWED_ENVIRONMENT_KEYS) assert.equal(schedulerXml.includes(key), false);
      assert.doesNotMatch(controllerXml, /token|password|api.?key|secret/i);
      assert.doesNotMatch(schedulerXml, /token|password|api.?key|secret/i);

      const managementAuth = parseManagementAuthEnv(
        rendered.controller.descriptor.EnvironmentVariables,
      );
      assert.deepEqual(managementAuth, {
        mode: 'keychain',
        scopes: ['read', 'previous-read', 'write', 'previous-write', 'admin'],
      });
    });
  });

  test('controller environment 对 Keychain selector/scopes 做成对且规范化的 fail-closed 校验', async () => {
    await withFixture(async (fixture) => {
      const binding = await bindFixture(fixture);
      const invalidEnvironments = [
        { LINKE_MANAGEMENT_AUTH_SOURCE: 'keychain' },
        { LINKE_MANAGEMENT_AUTH_KEYCHAIN_SCOPES: 'read,previous-read' },
        {
          LINKE_MANAGEMENT_AUTH_SOURCE: 'KEYCHAIN',
          LINKE_MANAGEMENT_AUTH_KEYCHAIN_SCOPES: 'read,previous-read',
        },
        {
          LINKE_MANAGEMENT_AUTH_SOURCE: 'keychain',
          LINKE_MANAGEMENT_AUTH_KEYCHAIN_SCOPES: 'previous-read',
        },
        {
          LINKE_MANAGEMENT_AUTH_SOURCE: 'keychain',
          LINKE_MANAGEMENT_AUTH_KEYCHAIN_SCOPES: 'read,read',
        },
        {
          LINKE_MANAGEMENT_AUTH_SOURCE: 'keychain',
          LINKE_MANAGEMENT_AUTH_KEYCHAIN_SCOPES: 'read, previous-read',
        },
        {
          LINKE_MANAGEMENT_AUTH_SOURCE: 'keychain',
          LINKE_MANAGEMENT_AUTH_KEYCHAIN_SCOPES: 'read,unknown',
        },
      ];

      for (const controllerEnvironment of invalidEnvironments) {
        await assertInvalid(() => render(binding, { controllerEnvironment }));
      }
    });
  });

  test('controller environment rejects unknown, secret, accessor, and symbol keys', async () => {
    await withFixture(async (fixture) => {
      const binding = await bindFixture(fixture);
      const invalidKeys = ['TOKEN', 'API_KEY', 'PASSWORD', 'NODE_OPTIONS', 'UNKNOWN'];
      for (const key of invalidKeys) {
        await assertInvalid(() => render(binding, {
          controllerEnvironment: { [key]: 'forbidden' },
        }));
      }

      let reads = 0;
      const accessorEnvironment = {};
      Object.defineProperty(accessorEnvironment, 'DATA_DIR', {
        enumerable: true,
        get() {
          reads += 1;
          throw new Error('getter-must-not-run');
        },
      });
      await assertInvalid(() => render(binding, {
        controllerEnvironment: accessorEnvironment,
      }));
      assert.equal(reads, 0);

      const symbolEnvironment = { PORT: '3000' };
      symbolEnvironment[Symbol('secret')] = 'forbidden';
      await assertInvalid(() => render(binding, { controllerEnvironment: symbolEnvironment }));
    });
  });

  test('plist and artifact hashes match independently calculated SHA-256 values', async () => {
    await withFixture(async (fixture) => {
      const binding = await bindFixture(fixture);
      const rendered = await render(binding);
      assert.equal(
        rendered.controller.plistSha256,
        sha256(rendered.controller.plistBytes),
      );
      assert.equal(
        rendered.scheduler.plistSha256,
        sha256(rendered.scheduler.plistBytes),
      );
      assert.deepEqual(rendered.manifestRuntimeArtifacts, binding.publicProjection.runtimeArtifacts);
    });
  });

  test('public render projection excludes absolute paths and environment values', async () => {
    await withFixture(async (fixture) => {
      const binding = await bindFixture(fixture);
      const marker = 'private-environment-marker';
      const rendered = await render(binding, {
        controllerEnvironment: { DATA_DIR: marker },
      });
      const serialized = JSON.stringify(rendered.publicProjection);
      assert.equal(serialized.includes(marker), false);
      for (const value of collectStringValues(rendered.publicProjection)) {
        assert.equal(isAbsolute(value), false, 'public render projection leaked an absolute path');
      }
    });
  });

  test('rendered controller and scheduler plists pass real plutil lint in a temp root', async () => {
    await withFixture(async (fixture) => {
      const binding = await bindFixture(fixture);
      const rendered = await render(binding);
      const outputRoot = await mkdtemp(join(tmpdir(), 'linke-plutil-lint-'));
      try {
        const controllerPlist = join(outputRoot, 'com.linke.controller.plist');
        const schedulerPlist = join(outputRoot, 'com.linke.scheduler.plist');
        await writeFile(controllerPlist, rendered.controller.plistBytes);
        await writeFile(schedulerPlist, rendered.scheduler.plistBytes);
        const controllerLint = await execFileAsync('/usr/bin/plutil', ['-lint', controllerPlist]);
        const schedulerLint = await execFileAsync('/usr/bin/plutil', ['-lint', schedulerPlist]);
        assert.match(controllerLint.stdout, /OK/);
        assert.match(schedulerLint.stdout, /OK/);
      } finally {
        await rm(outputRoot, { recursive: true, force: true });
      }
    });
  });
}
