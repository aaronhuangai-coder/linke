import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const README_PATH = resolve(import.meta.dirname, '..', 'README.md');

let readme;

before(async () => {
  readme = await readFile(README_PATH, 'utf-8');
});

// ── Helper ──────────────────────────────────────────────────────────

function assertReadmeContains(pattern, label) {
  const re = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;
  assert.ok(re.test(readme), `README must mention: ${label}`);
}

// ── Version coverage: V0.1 – V0.5 ──────────────────────────────────

describe('README — version coverage', () => {
  it('mentions V0.1 (initial prototype)', () => {
    assertReadmeContains(/V0\.1/, 'V0.1');
  });

  it('mentions V0.2 (agent CLI / run-once)', () => {
    assertReadmeContains(/V0\.2/, 'V0.2');
  });

  it('mentions V0.3 (launchd-dry-run)', () => {
    assertReadmeContains(/V0\.3/, 'V0.3');
  });

  it('mentions V0.4 (NAS dry-run)', () => {
    assertReadmeContains(/V0\.4/, 'V0.4');
  });

  it('mentions V0.5 (current version)', () => {
    assertReadmeContains(/V0\.5/, 'V0.5');
  });

  it('mentions V0.6 (retention-dry-run)', () => {
    assertReadmeContains(/V0\.6/, 'V0.6');
  });

  it('mentions V0.7 (Web Console retention panel)', () => {
    assertReadmeContains(/V0\.7/, 'V0.7');
  });

  it('mentions V0.8 (read-only snapshot manifest detail)', () => {
    assertReadmeContains(/V0\.8/, 'V0.8');
  });

  it('mentions V0.9 (snapshot diff dry-run)', () => {
    assertReadmeContains(/V0\.9/, 'V0.9');
  });

  it('mentions V0.10 (restore dry-run)', () => {
    assertReadmeContains(/V0\.10/, 'V0.10');
  });

  it('mentions V0.11 (backup preflight dry-run)', () => {
    assertReadmeContains(/V0\.11/, 'V0.11');
  });

  it('mentions V0.12 (Web backup preflight panel)', () => {
    assertReadmeContains(/V0\.12/, 'V0.12');
  });

  it('mentions V0.13 (Web NAS dry-run panel)', () => {
    assertReadmeContains(/V0\.13/, 'V0.13');
  });

  it('mentions V0.14 (NAS app adapter dry-run)', () => {
    assertReadmeContains(/V0\.14/, 'V0.14');
  });

  it('mentions V0.15 (device detail panel)', () => {
    assertReadmeContains(/V0\.15/, 'V0.15');
  });
});

// ── Agent CLI commands ──────────────────────────────────────────────

describe('README — Agent CLI commands', () => {
  it('documents run-once command', () => {
    assertReadmeContains(/run-once/, 'run-once command');
  });

  it('documents launchd-dry-run command', () => {
    assertReadmeContains(/launchd-dry-run/, 'launchd-dry-run command');
  });

  it('documents nas-dry-run command', () => {
    assertReadmeContains(/nas-dry-run/, 'nas-dry-run command');
  });

  it('documents retention-dry-run command', () => {
    assertReadmeContains(/retention-dry-run/, 'retention-dry-run command');
  });

  it('documents restore-dry-run command', () => {
    assertReadmeContains(/restore-dry-run/, 'restore-dry-run command');
  });

  it('documents backup-preflight-dry-run command', () => {
    assertReadmeContains(/backup-preflight-dry-run/, 'backup-preflight-dry-run command');
  });

  it('mentions Agent CLI section', () => {
    assertReadmeContains(/agent\s*cli/i, 'Agent CLI section');
  });
});

// ── NAS providers ───────────────────────────────────────────────────

describe('README — NAS providers', () => {
  it('mentions synology as a supported provider', () => {
    assertReadmeContains(/synology/i, 'synology provider');
  });

  it('mentions ugreen as a supported provider', () => {
    assertReadmeContains(/ugreen/i, 'ugreen provider');
  });
});

// ── Web Console ─────────────────────────────────────────────────────

describe('README — Web Console', () => {
  it('mentions Web Console', () => {
    assertReadmeContains(/web\s*console/i, 'Web Console');
  });

  it('documents the Web Console retention dry-run panel', () => {
    assertReadmeContains(
      /Web Console[\s\S]*retention|retention[\s\S]*Web Console|保留计划[\s\S]*面板|版本保留[\s\S]*面板/i,
      'Web Console retention dry-run panel',
    );
  });

  it('documents the Web Console snapshot manifest detail panel', () => {
    assertReadmeContains(
      /快照清单[\s\S]*详情|manifest[\s\S]*详情|文件清单[\s\S]*面板|snapshot[\s\S]*manifest/i,
      'Web Console snapshot manifest detail panel',
    );
  });

  it('documents the Web Console snapshot diff dry-run panel', () => {
    assertReadmeContains(
      /快照差异[\s\S]*dry-run|diff-dry-run|差异预览[\s\S]*面板|added[\s\S]*removed[\s\S]*unchanged/i,
      'Web Console snapshot diff dry-run panel',
    );
  });

  it('documents the Web Console restore dry-run panel', () => {
    assertReadmeContains(
      /恢复[\s\S]*dry-run|restore-dry-run|恢复预检[\s\S]*面板|would-create[\s\S]*would-overwrite/i,
      'Web Console restore dry-run panel',
    );
  });

  it('documents the Web Console backup preflight dry-run hint', () => {
    assertReadmeContains(
      /备份预检[\s\S]*dry-run|backup-preflight-dry-run|sourcePath[\s\S]*excludePatterns/i,
      'Web Console backup preflight dry-run hint',
    );
  });

  it('documents the Web Console backup preflight dry-run panel', () => {
    assertReadmeContains(
      /Web Console[\s\S]*备份预检[\s\S]*面板|backup-preflight-dry-run[\s\S]*Web Console[\s\S]*included[\s\S]*excluded|sourcePath[\s\S]*excludePatterns[\s\S]*面板/i,
      'Web Console backup preflight dry-run panel',
    );
  });

  it('documents the Web Console NAS dry-run panel', () => {
    assertReadmeContains(
      /Web Console[\s\S]*NAS[\s\S]*dry-run[\s\S]*面板|POST \/api\/nas-dry-run[\s\S]*wouldConnect[\s\S]*wouldWrite|nasTargets[\s\S]*Web Console[\s\S]*不连接/i,
      'Web Console NAS dry-run panel',
    );
  });

  it('documents NAS app adapter dry-run', () => {
    assertReadmeContains(
      /appAdapter[\s\S]*adapterPlan[\s\S]*wouldInvokeApp:false|NAS app adapter[\s\S]*dry-run[\s\S]*不调用/i,
      'NAS app adapter dry-run docs',
    );
  });

  it('documents the Web Console device detail panel', () => {
    assertReadmeContains(
      /设备详情[\s\S]*hostname[\s\S]*ipAddress[\s\S]*lastHeartbeatAt|device detail[\s\S]*hostname[\s\S]*ipAddress[\s\S]*snapshotCount/i,
      'Web Console device detail panel',
    );
  });
});

// ── Default binding: localhost / 127.0.0.1 ──────────────────────────

describe('README — default binding', () => {
  it('states default host is 127.0.0.1 or localhost', () => {
    assertReadmeContains(/127\.0\.0\.1|localhost/, 'default localhost/127.0.0.1');
  });
});

// ── Security boundaries ─────────────────────────────────────────────

describe('README — security boundaries', () => {
  it('has a security boundary / safety section', () => {
    assertReadmeContains(/安全|security/i, 'security boundary section');
  });

  it('states there is NO authentication / no auth', () => {
    assertReadmeContains(/无认证|没有认证|no\s*auth|without\s*auth|未.*认证|不.*鉴权/i, 'no authentication');
  });

  it('states nas-dry-run does NOT connect to NAS', () => {
    assertReadmeContains(
      /nas.*不.*连接|nas.*不.*网络|dry.?run.*不.*连接|不会.*连接.*nas|no.*network|does\s*not.*connect/i,
      'nas-dry-run does not connect to NAS',
    );
  });

  it('states nas-dry-run does NOT write to remote', () => {
    assertReadmeContains(
      /nas.*不.*写|dry.?run.*不.*写|不会.*写.*远|no.*write|does\s*not.*write/i,
      'nas-dry-run does not write to remote',
    );
  });

  it('states credential fields are rejected / not allowed', () => {
    assertReadmeContains(
      /拒绝.*凭证|不允许.*凭证|禁止.*凭证|credential.*reject|reject.*credential|forbidden|不允许.*credential|不含.*凭证/i,
      'credential fields rejected',
    );
  });

  it('states launchd-dry-run does NOT call launchctl', () => {
    assertReadmeContains(
      /不.*launchctl|launchctl.*不|不调用.*launchctl|does\s*not.*launchctl|no.*launchctl/i,
      'launchd-dry-run does not call launchctl',
    );
  });

  it('states launchd-dry-run does NOT install / auto-start', () => {
    assertReadmeContains(
      /不.*安装|不会.*安装|does\s*not.*install|no.*install|不.*自动/i,
      'launchd-dry-run does not install',
    );
  });

  it('states retention-dry-run does NOT delete snapshots', () => {
    assertReadmeContains(
      /retention.*不.*删除|不会删除.*快照|no.*delete|does\s*not.*delete|不.*删除.*快照/i,
      'retention-dry-run does not delete snapshots',
    );
  });

  it('states no auto-cleanup / no real deletion is promised', () => {
    assertReadmeContains(
      /不承诺.*自动清理|不.*自动清理|no.*auto.*clean|不.*真实删除|未.*实现.*删除/i,
      'no auto-cleanup promised',
    );
  });

  it('states restore-dry-run does NOT copy or overwrite files', () => {
    assertReadmeContains(
      /restore.*dry.?run.*不.*复制|restore.*dry.?run.*不.*覆盖|恢复.*dry.?run.*不.*复制|恢复.*dry.?run.*不.*覆盖|不会.*复制.*文件|不会.*覆盖.*文件/i,
      'restore-dry-run does not copy or overwrite files',
    );
  });

  it('states restore-dry-run does NOT write to the target directory', () => {
    assertReadmeContains(
      /restore.*dry.?run.*不.*写|恢复.*dry.?run.*不.*写|不写入.*目标|不会.*写入.*目标|does\s*not.*write/i,
      'restore-dry-run does not write to target directory',
    );
  });

  it('states backup-preflight-dry-run does NOT create snapshots', () => {
    assertReadmeContains(
      /backup-preflight.*不.*创建.*快照|备份预检.*不.*创建.*快照|不创建.*snapshot|does\s*not.*create.*snapshot/i,
      'backup-preflight-dry-run does not create snapshots',
    );
  });

  it('states backup-preflight-dry-run does NOT copy files or write metadata', () => {
    assertReadmeContains(
      /backup-preflight.*不.*复制|backup-preflight.*不.*写|备份预检.*不.*复制|备份预检.*不.*写|不写入.*metadata|不修改.*metadata/i,
      'backup-preflight-dry-run does not copy files or write metadata',
    );
  });
});

// ── Testing ─────────────────────────────────────────────────────────

describe('README — testing', () => {
  it('documents npm test command', () => {
    assertReadmeContains(/npm\s+test/, 'npm test');
  });
});

// ── V0.5 accurate description ──────────────────────────────────────

describe('README — V0.5 description accuracy', () => {
  /** Extract the V0.5 row from the version table and any nearby paragraph text */
  function getV05Context() {
    const lines = readme.split('\n');
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      if (/V0\.5/.test(lines[i])) {
        // grab the line itself plus one line above/below for context
        hits.push(lines.slice(Math.max(0, i - 1), i + 2).join('\n'));
      }
    }
    return hits.join('\n');
  }

  it('V0.5 must be described as documentation / README / 操作手册', () => {
    const ctx = getV05Context();
    assert.ok(
      /文档|操作手册|README/i.test(ctx),
      `V0.5 context must mention 文档 / 操作手册 / README, got:\n${ctx}`,
    );
  });

  it('V0.5 must NOT be described as 安全加固', () => {
    const ctx = getV05Context();
    assert.ok(
      !/安全加固/.test(ctx),
      `V0.5 context must NOT contain "安全加固", got:\n${ctx}`,
    );
  });
});

// ── Must NOT over-promise ───────────────────────────────────────────

describe('README — no over-promises', () => {
  it('does NOT claim real NAS connection capability', () => {
    // Should not contain phrases like "connects to NAS" in a present-tense capability sense
    // but "dry-run" + "NAS" is fine
    const lines = readme.split('\n');
    for (const line of lines) {
      const lower = line.toLowerCase();
      // Skip lines that clearly describe dry-run
      if (lower.includes('dry-run') || lower.includes('dry run') || lower.includes('不会') || lower.includes('不连接')) continue;
      // Flag lines that claim real NAS connection
      assert.ok(
        !/连接.*NAS|connect.*to.*NAS|访问.*NAS.*设备/i.test(line) || lower.includes('dry'),
        `README should not claim real NAS connection: "${line.trim()}"`,
      );
    }
  });

  it('does NOT claim production-ready status', () => {
    assert.ok(
      !/生产.*可用|production.?ready|生产环境.*使用/i.test(readme),
      'README should not claim production-ready',
    );
  });

  it('does NOT claim bidirectional sync', () => {
    assert.ok(
      !/双向.*同步|bidirectional.*sync|two.?way.*sync/i.test(readme),
      'README should not claim bidirectional sync',
    );
  });

  it('does NOT claim conflict resolution', () => {
    assert.ok(
      !/冲突.*解决|conflict.*resolv/i.test(readme),
      'README should not claim conflict resolution',
    );
  });

  it('does NOT claim background daemon / always-running', () => {
    // launchd-dry-run generates plist but doesn't auto-install
    assert.ok(
      !/后台常驻|自动.*后台|background.*daemon|always.?running|常驻.*运行/i.test(readme),
      'README should not claim background daemon',
    );
  });
});
