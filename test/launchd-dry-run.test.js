import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateLaunchdPlist, writeLaunchdDryRun } from '../src/agent.js';

describe('Launchd dry-run', () => {
  const baseConfig = {
    deviceId: 'test-device',
    launchdLabel: 'com.linke.agent.test-device',
    scheduleSeconds: 3600,
  };

  // ── Plist content ───────────────────────────────────────────

  it('generates plist containing Label, ProgramArguments, run-once, --config, StartInterval', () => {
    const plist = generateLaunchdPlist(baseConfig, '/tmp/test-config.json');

    assert.ok(plist.includes('<key>Label</key>'));
    assert.ok(plist.includes('com.linke.agent.test-device'));
    assert.ok(plist.includes('<key>ProgramArguments</key>'));
    assert.ok(plist.includes('run-once'));
    assert.ok(plist.includes('--config'));
    assert.ok(plist.includes('<key>StartInterval</key>'));
    assert.ok(plist.includes('3600'));
  });

  it('includes the resolved config path in ProgramArguments', () => {
    const plist = generateLaunchdPlist(baseConfig, '/Users/ah/linke/my-config.json');
    assert.ok(plist.includes('/Users/ah/linke/my-config.json'));
  });

  it('uses the correct scheduleSeconds value', () => {
    const plist = generateLaunchdPlist(
      { ...baseConfig, scheduleSeconds: 7200 },
      '/tmp/c.json',
    );
    assert.ok(plist.includes('7200'));
  });

  it('disables core dumps with matching soft and hard launchd resource limits', () => {
    const plist = generateLaunchdPlist(baseConfig, '/tmp/c.json');

    assert.match(
      plist,
      /<key>SoftResourceLimits<\/key>\s*<dict>\s*<key>Core<\/key>\s*<integer>0<\/integer>\s*<\/dict>/,
    );
    assert.match(
      plist,
      /<key>HardResourceLimits<\/key>\s*<dict>\s*<key>Core<\/key>\s*<integer>0<\/integer>\s*<\/dict>/,
    );
  });

  it('plist is valid XML-ish structure', () => {
    const plist = generateLaunchdPlist(baseConfig, '/tmp/c.json');
    assert.ok(plist.startsWith('<?xml'));
    assert.ok(plist.includes('<!DOCTYPE plist'));
    assert.ok(plist.includes('<plist version="1.0">'));
    assert.ok(plist.includes('</plist>'));
  });

  // ── Output path safety ──────────────────────────────────────

  it('rejects output path outside project directory (/etc)', async () => {
    await assert.rejects(
      () => writeLaunchdDryRun('/tmp/nonexistent.json', '/etc/evil.plist'),
      /project directory/i,
    );
  });

  it('rejects ~/Library/LaunchAgents path', async () => {
    await assert.rejects(
      () =>
        writeLaunchdDryRun(
          '/tmp/nonexistent.json',
          '/Users/ah/Library/LaunchAgents/com.linke.plist',
        ),
      /project directory/i,
    );
  });

  it('rejects path with ../ escape attempt', async () => {
    await assert.rejects(
      () =>
        writeLaunchdDryRun(
          '/tmp/nonexistent.json',
          '/Users/ah/linke/../../etc/evil.plist',
        ),
      /project directory/i,
    );
  });
});
