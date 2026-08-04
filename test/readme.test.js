import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LINKE_RELEASE_VERSION } from '../src/version.js';

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

function assertReadmeDoesNotContain(pattern, label) {
  const re = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;
  assert.ok(!re.test(readme), `README must NOT mention: ${label}`);
}

/**
 * Extract the unique current-version badge blockquote from README.
 * Start line must match `> **当前版本：${LINKE_RELEASE_VERSION}**`; collect consecutive `>` lines only;
 * stop at the first non-`>` line. Missing or duplicate starts assert-fail.
 */
function extractCurrentBadgeBlockquote(markdown) {
  const lines = String(markdown).split('\n');
  const startMarker = `> **当前版本：${LINKE_RELEASE_VERSION}**`;
  const starts = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith(startMarker)) {
      starts.push(i);
    }
  }
  assert.strictEqual(
    starts.length,
    1,
    `expected exactly one current badge blockquote starting with ${JSON.stringify(startMarker)}, found ${starts.length}`,
  );
  const collected = [];
  for (let i = starts[0]; i < lines.length; i += 1) {
    if (!lines[i].startsWith('>')) break;
    collected.push(lines[i]);
  }
  assert.ok(collected.length > 0, 'current badge blockquote must collect at least one `>` line');
  return collected.join('\n');
}

/** Exact current V1.46 user-level LaunchAgent lifecycle code-stage closure PASS signature. */
const V146_SIGNATURE =
  'V1.46 user-level LaunchAgent lifecycle code-stage closure PASS';

/** Exact historical V1.45 signature — retained NAS dry-run configuration readiness; must not be erased. */
const V145_SIGNATURE =
  'V1.45 NAS dry-run configuration-readiness PASS';

/** Exact historical V1.44 signature — retained real NAS acceptance receipt; must not be erased. */
const V144_SIGNATURE =
  'V1.44 real NAS acceptance PASS';

/** Exact historical V1.43 signature — retained rotation foundation. */
const V143_SIGNATURE =
  'V1.43 explicit crash-recoverable audit integrity rotation foundation';

/** Exact historical V1.42 signature. */
const V142_SIGNATURE =
  'V1.42 G0c endpoint-pull restore with crash-recoverable rollback anchor implementation';

/** Exact historical V1.41 signature. */
const V141_SIGNATURE =
  'V1.41 G0b resumable manifest v2 snapshot upload implementation';

/** Exact historical V1.40 signature. */
const V140_SIGNATURE =
  'V1.40 local multi-process audit integrity write exclusive lock implementation';

/**
 * Exact V1.40 release/close failure ops-boundary atoms (honesty surface).
 * Required on current badge / V1.40 version-table row / concurrency surface.
 */
const RELEASE_CLOSE_FAIL_CLOSES = 'release/close failure fail-closes';
const TASK_MUTATION_MAY_ALREADY_APPLIED = 'task mutation may already be applied';
const CALLER_RETRY_NO_IDEMPOTENT_EXACTLY_ONCE =
  'caller retry has no idempotent/exactly-once guarantee';
const NO_DETERMINISTIC_IN_BAND_FD_RECLAIM =
  'no deterministic in-band fd reclaim before process exit';

/** Absolute overclaims forbidden on V1.40 current README surface only. */
const FORBIDDEN_ABSOLUTE_V140_PHRASES = Object.freeze([
  'stuck lock',
  'restart required',
  'fd always remains open',
  'automatic recovery',
]);

/** Exact historical V1.39 signature — retained write-admission base. */
const V139_SIGNATURE =
  'V1.39 safety-critical audit write-admission fail-closed implementation';

/** Exact historical V1.38 signature. */
const V138_SIGNATURE =
  'V1.38 read-only audit integrity run-once monitor/alert implementation';

/** Exact post-outcome still-best-effort honesty phrase. */
const POST_OUTCOME_STILL_BEST_EFFORT =
  'post-outcome recordAudit / appendNasReplicationAudit still best-effort';

/** Stale all-paths best-effort element. */
const STALE_ALL_PATHS_BEST_EFFORT =
  'server recordAudit / agent appendNasReplicationAudit best-effort catch';

/** Stale standalone current multi-process denials — delivered by V1.40. */
const STALE_CURRENT_MULTI_PROCESS_DENY = 'not multi-process exclusive lock';
const STALE_SINGLE_PROCESS_QUEUE_ONLY = 'single-process queue only';
const STALE_MULTI_PROCESS_YET = 'not multi-process exclusive lock yet';

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

  it('mentions V0.5', () => {
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

  it('mentions V0.16 (device list controls)', () => {
    assertReadmeContains(/V0\.16/, 'V0.16');
  });

  it('mentions V0.17 (backup jobs overview)', () => {
    assertReadmeContains(/V0\.17/, 'V0.17');
  });

  it('mentions V0.18 (backup job detail timeline)', () => {
    assertReadmeContains(/V0\.18/, 'V0.18');
  });

  it('mentions V0.19 (backup job timeline snapshot linking)', () => {
    assertReadmeContains(/V0\.19/, 'V0.19');
  });

  it('mentions V0.20 (event log panel enhancement)', () => {
    assertReadmeContains(/V0\.20/, 'V0.20');
  });

  it('mentions V0.21 (device backup health panel)', () => {
    assertReadmeContains(/V0\.21/, 'V0.21');
  });

  it('mentions V0.22 (backup version consistency panel)', () => {
    assertReadmeContains(/V0\.22/, 'V0.22');
  });

  it('mentions V0.23 (version consistency snapshot linking)', () => {
    assertReadmeContains(/V0\.23/, 'V0.23');
  });

  it('mentions V0.24 (version consistency controls)', () => {
    assertReadmeContains(/V0\.24/, 'V0.24');
  });

  it('mentions V0.25 (version consistency non-latest summary)', () => {
    assertReadmeContains(/V0\.25/, 'V0.25');
  });

  it('mentions V0.26 (version consistency sort controls)', () => {
    assertReadmeContains(/V0\.26/, 'V0.26');
  });

  it('mentions V0.27 (version coverage gap summary lite)', () => {
    assertReadmeContains(/V0\.27/, 'V0.27');
  });

  it('mentions V0.28 (version consistency coverage filter)', () => {
    assertReadmeContains(/V0\.28/, 'V0.28');
  });

  it('mentions V0.29 (version consistency coverage gap sort)', () => {
    assertReadmeContains(/V0\.29/, 'V0.29');
  });

  it('mentions V0.30 (version coverage ratio display)', () => {
    assertReadmeContains(/V0\.30/, 'V0.30');
  });

  it('mentions V0.31 (version unobservable coverage fallback)', () => {
    assertReadmeContains(/V0\.31/, 'V0.31');
  });

  it('mentions V0.32 (version unobservable coverage filter)', () => {
    assertReadmeContains(/V0\.32/, 'V0.32');
  });

  it('mentions V0.33 (device/IP management state view)', () => {
    assertReadmeContains(/V0\.33/, 'V0.33');
  });

  it('mentions V0.34 (management-state filter and count)', () => {
    assertReadmeContains(/V0\.34/, 'V0.34');
  });

  it('mentions V0.35 (read-only management-state bucket summary and quick switching)', () => {
    assertReadmeContains(/V0\.35/, 'V0.35');
  });

  it('mentions V0.36 (accessible active management-state summary controls)', () => {
    assertReadmeContains(/V0\.36/, 'V0.36');
  });

  it('mentions V0.37 (management-state summary scoped counts)', () => {
    assertReadmeContains(/V0\.37/, 'V0.37');
  });

  it('mentions V0.38 (management-state decision hints)', () => {
    assertReadmeContains(/V0\.38/, 'V0.38');
  });

  it('mentions V0.39 (device empty filter context)', () => {
    assertReadmeContains(/V0\.39/, 'V0.39');
  });

  it('mentions V0.40 (device filter reset button)', () => {
    assertReadmeContains(/V0\.40/, 'V0.40');
  });

  it('mentions V0.41 (device filter reset state)', () => {
    assertReadmeContains(/V0\.41/, 'V0.41');
  });

  it('mentions V0.42 (device active filter summary)', () => {
    assertReadmeContains(/V0\.42/, 'V0.42');
  });

  it('mentions V0.43 (device active filter summary state)', () => {
    assertReadmeContains(/V0\.43/, 'V0.43');
  });

  it('mentions V0.44 (device filter count state)', () => {
    assertReadmeContains(/V0\.44/, 'V0.44');
  });

  it('mentions V0.45 (device filter count metrics)', () => {
    assertReadmeContains(/V0\.45/, 'V0.45');
  });

  it('mentions V0.46 (release health endpoint)', () => {
    assertReadmeContains(/V0\.46/, 'V0.46');
  });

  it('mentions V0.47 (release health CLI)', () => {
    assertReadmeContains(/V0\.47/, 'V0.47');
  });

  it('mentions V0.48 (release health Web panel)', () => {
    assertReadmeContains(/V0\.48/, 'V0.48');
  });

  it('mentions V0.49 (release version consistency guard)', () => {
    assertReadmeContains(/V0\.49/, 'V0.49');
  });

  it('mentions V0.50 (release readiness CLI)', () => {
    assertReadmeContains(/V0\.50/, 'V0.50');
  });

  it('mentions V0.51 (release readiness Web panel)', () => {
    assertReadmeContains(/V0\.51/, 'V0.51');
  });

  it('mentions V0.52 (Gold readiness scorecard docs)', () => {
    assertReadmeContains(/V0\.52/, 'V0.52');
  });

  it('mentions V0.53 (optional bearer token auth skeleton)', () => {
    assertReadmeContains(/V0\.53/, 'V0.53');
  });

  it('mentions V0.54 (Web Console in-memory API token UX)', () => {
    assertReadmeContains(/V0\.54/, 'V0.54');
  });

  it('mentions V0.55 (server hardening body limit and sanitized 500 errors)', () => {
    assertReadmeContains(/V0\.55/, 'V0.55');
  });

  it('mentions V0.56 (restore target guard)', () => {
    assertReadmeContains(/V0\.56/, 'V0.56');
  });

  it('mentions V0.57 (restore destination symlink defense)', () => {
    assertReadmeContains(/V0\.57/, 'V0.57');
  });

  it('mentions V0.58 (audit log foundation)', () => {
    assertReadmeContains(/V0\.58/, 'V0.58');
  });

  it('mentions V0.59 (API rate-limit foundation)', () => {
    assertReadmeContains(/V0\.59/, 'V0.59');
  });

  it('mentions V0.60 (audit retention foundation)', () => {
    assertReadmeContains(/V0\.60/, 'V0.60');
  });

  it('mentions V0.61 (API read/write token foundation)', () => {
    assertReadmeContains(/V0\.61/, 'V0.61');
  });

  it('mentions V0.62 (auth status readiness API)', () => {
    assertReadmeContains(/V0\.62/, 'V0.62');
  });

  it('mentions V0.63 (shared write-route registry)', () => {
    assertReadmeContains(/V0\.63/, 'V0.63');
  });

  it('mentions V0.64 (NAS credential reference gate)', () => {
    assertReadmeContains(/V0\.64/, 'V0.64');
  });

  it('mentions V0.65 (Web NAS execution gate display)', () => {
    assertReadmeContains(/V0\.65/, 'V0.65');
  });

  it('mentions V0.66 (NAS credential denylist hardening)', () => {
    assertReadmeContains(/V0\.66/, 'V0.66');
  });

  it('mentions V0.67 (NAS execution readiness summary)', () => {
    assertReadmeContains(/V0\.67/, 'V0.67');
  });

  it('mentions LINKE_RELEASE_VERSION', () => {
    const escapedVersion = LINKE_RELEASE_VERSION.replace(/\./g, '\\.');
    assertReadmeContains(new RegExp(escapedVersion), LINKE_RELEASE_VERSION);
  });
});


// ── V0.33 documentation ────────────────────────────────────────────

describe('README — V0.33 device/IP management state view', () => {
  it('mentions V0.33', () => {
    assert.match(readme, /V0\.33/);
  });

  it('version table has V0.33 row', () => {
    assert.match(readme, /\| V0\.33 \|[^|]*(统一管理态|device-management-state)/i);
  });

  it('version table keeps V0.22 through V0.32 as historical milestones', () => {
    assert.match(readme, /\| V0\.22 \| 备份版本一致性 \|/);
    assert.match(readme, /\| V0\.23 \| 版本一致性 snapshot 联动 \|/);
    assert.match(readme, /\| V0\.24 \| 版本一致性筛选与搜索 \|/);
    assert.match(readme, /\| V0\.25 \| 版本一致性非最新摘要 \|/);
    assert.match(readme, /\| V0\.26 \| 版本一致性排序控制 \|/);
    assert.match(readme, /\| V0\.27 \| 覆盖缺口摘要 Lite \|/);
    assert.match(readme, /\| V0\.28 \| 版本一致性覆盖筛选 \|/);
    assert.match(readme, /\| V0\.29 \| 版本一致性覆盖缺口排序 \|/);
    assert.match(readme, /\| V0\.30 \| 版本一致性覆盖率显示 \|/);
    assert.match(readme, /\| V0\.31 \| 版本一致性无可观测设备回退 \|/);
    assert.match(readme, /\| V0\.32 \| 无可观测设备筛选 \|/);
  });

  it('documents device/IP management state feature docs for 统一管理态', () => {
    assert.match(readme, /统一管理态/);
    assert.match(readme, /在线可见|在线缺 IP|离线保留|未知待确认/);
  });

  it('asserts safety docs for device/IP management state', () => {
    assert.match(readme, /统一管理态.*安全(保证|边界)|安全(保证|边界).*统一管理态/);
    assert.match(readme, /只读/);
    assert.match(readme, /不新增 API/);
    assert.match(readme, /不写入(任何)?元数据|不写入(any)?metadata/);
    assert.match(readme, /不触发备份|不进行备份/);
    assert.match(readme, /不执行(任何)?远程命令|不执行远程命令/);
    assert.match(readme, /不连接 NAS|不建立真实 NAS 连接/);
    assert.match(readme, /不进行(任何)?修改|无批量操作|无修复操作/);
  });

  it('documents testing coverage includes device/IP management state', () => {
    assert.match(readme, /测试覆盖：.*统一管理态/);
  });

  it('asserts README contains a V0.33 统一管理态 feature bullet', () => {
    assert.match(readme, /-\s+\*\*统一管理态\*\*/i);
  });

  it('asserts Web Console combined feature list includes 统一管理态', () => {
    assert.match(readme, /Web Console\*\* — 管理界面：.*统一管理态/);
  });

  it('asserts testing coverage sentence includes 统一管理态', () => {
    assert.match(readme, /测试覆盖：.*统一管理态/);
  });
});


// ── V0.34 documentation ────────────────────────────────────────────

describe('README — V0.34 management-state filter and count', () => {
  it('mentions V0.34', () => {
    assert.match(readme, /V0\.34/);
  });

  it('version table has V0.34 row', () => {
    assert.match(readme, /\| V0\.34 \|[^|]*(管理态筛选|device-management-filter)/i);
  });

  it('documents management-state filter feature docs for 管理态筛选', () => {
    assert.match(readme, /管理态筛选/);
    assert.match(readme, /visible|missing-ip|offline-retained|unknown/);
  });

  it('asserts safety docs for management-state filter', () => {
    assert.match(readme, /管理态筛选.*安全(保证|边界)|安全(保证|边界).*管理态筛选/);
    assert.match(readme, /只读/);
    assert.match(readme, /不新增 API/);
    assert.match(readme, /不写入(任何)?元数据|不写入(any)?metadata/);
    assert.match(readme, /不执行(任何)?远程命令|不执行远程命令/);
    assert.match(readme, /不连接 NAS|不建立真实 NAS 连接/);
    assert.match(readme, /不进行(任何)?修改|无批量操作|无修复操作/);
  });

  it('documents testing coverage includes management-state filter', () => {
    assert.match(readme, /测试覆盖：.*管理态筛选/);
  });
});

// ── V0.35 documentation ────────────────────────────────────────────

describe('README — V0.35 management-state bucket summary and quick switching', () => {
  it('mentions V0.35', () => {
    assert.match(readme, /V0\.35/);
  });

  it('version table has V0.35 historical row', () => {
    assert.match(readme, /\| V0\.35 \|[^|]*(管理态分桶统计|device-management-summary)/i);
  });

  it('version table keeps V0.34 as historical milestone', () => {
    assert.match(readme, /\| V0\.34 \|[^|]*(管理态筛选|device-management-filter)/i);
  });

  it('documents device-management-summary feature docs for 管理态分桶统计', () => {
    assert.match(readme, /管理态分桶统计/);
    assert.match(readme, /all|visible|missing-ip|offline-retained|unknown/);
  });

  it('asserts safety docs for device-management-summary', () => {
    assert.match(readme, /管理态分桶统计.*安全(保证|边界)|安全(保证|边界).*管理态分桶统计/);
    assert.match(readme, /只读/);
    assert.match(readme, /不新增 API/);
    assert.match(readme, /不写入(任何)?元数据|不写入(any)?metadata/);
    assert.match(readme, /不执行(任何)?远程命令|不执行远程命令/);
    assert.match(readme, /不连接 NAS|不建立真实 NAS 连接/);
    assert.match(readme, /不进行(任何)?修改|无批量操作|无修复操作/);
  });

  it('documents testing coverage includes device-management-summary', () => {
    assert.match(readme, /测试覆盖：.*管理态分桶统计/);
  });
});

// ── V0.36 documentation ────────────────────────────────────────────

describe('README — V0.36 accessible active management-state summary controls', () => {
  it('mentions V0.36', () => {
    assert.match(readme, /V0\.36/);
  });

  it('version table has V0.36 historical row', () => {
    assert.match(readme, /\| V0\.36 \|[^|]*(active|aria|可访问|高亮|选中态)/i);
  });

  it('version table keeps V0.35 as historical milestone', () => {
    assert.match(readme, /\| V0\.35 \|[^|]*(管理态分桶统计|device-management-summary)/i);
  });

  it('documents active and accessible summary controls', () => {
    assert.match(readme, /管理态分桶.*(按钮|button)/i);
    assert.match(readme, /aria-pressed|data-active|选中态|高亮/);
    assert.match(readme, /device-management-filter/);
  });

  it('asserts safety docs for active summary controls', () => {
    assert.match(readme, /管理态分桶.*(选中态|高亮|可访问).*安全(保证|边界)|安全(保证|边界).*(选中态|高亮|可访问)/);
    assert.match(readme, /只读/);
    assert.match(readme, /不新增 API/);
    assert.match(readme, /不写入(任何)?元数据|不写入(any)?metadata/);
    assert.match(readme, /不执行(任何)?远程命令|不执行远程命令/);
    assert.match(readme, /不连接 NAS|不建立真实 NAS 连接/);
    assert.match(readme, /不持久化筛选状态|刷新后不保留|不保存筛选状态/);
  });

  it('documents testing coverage includes active summary controls', () => {
    assert.match(readme, /测试覆盖：.*管理态分桶选中态/);
  });
});

// ── V0.37 documentation ────────────────────────────────────────────

describe('README — V0.37 management-state summary scoped counts', () => {
  it('mentions V0.37', () => {
    assert.match(readme, /V0\.37/);
  });

  it('version table has V0.37 historical row', () => {
    assert.match(readme, /\| V0\.37 \|[^|]*(作用域|搜索|状态|scoped)/i);
  });

  it('version table keeps V0.36 as historical milestone', () => {
    assert.match(readme, /\| V0\.36 \|[^|]*(active|aria|可访问|高亮|选中态)/i);
  });

  it('documents scoped summary count behavior', () => {
    assert.match(readme, /搜索.*状态.*管理态分桶|管理态分桶.*搜索.*状态/);
    assert.match(readme, /忽略当前管理态筛选|不受当前管理态筛选影响|management filter/i);
    assert.match(readme, /不重新请求.*\/api\/devices|不触发.*\/api\/devices|no.*\/api\/devices.*refetch/i);
  });

  it('asserts safety docs for scoped summary counts', () => {
    assert.match(readme, /管理态分桶作用域.*安全(保证|边界)|安全(保证|边界).*管理态分桶作用域/);
    assert.match(readme, /只读/);
    assert.match(readme, /不新增 API/);
    assert.match(readme, /不写入(任何)?元数据|不写入(any)?metadata/);
    assert.match(readme, /不执行(任何)?远程命令|不执行远程命令/);
    assert.match(readme, /不连接 NAS|不建立真实 NAS 连接/);
  });

  it('documents testing coverage includes scoped summary counts', () => {
    assert.match(readme, /测试覆盖：.*管理态分桶作用域/);
  });
});

// ── V0.38 documentation ────────────────────────────────────────────

describe('README — V0.38 management-state decision hints', () => {
  it('mentions V0.38', () => {
    assert.match(readme, /V0\.38/);
  });

  it('version table has V0.38 historical row', () => {
    assert.match(readme, /\| V0\.38 \|[^|]*(管理态提示|判定提示|处理提示|hint)/i);
  });

  it('version table keeps V0.37 as historical milestone', () => {
    assert.match(readme, /\| V0\.37 \|[^|]*(作用域|搜索|状态|scoped)/i);
  });

  it('documents management-state hint behavior', () => {
    assert.match(readme, /管理态.*(判定提示|处理提示|hint)|device-management-hint/i);
    assert.match(readme, /在线且 IP 可用|缺少可用 IP|设备离线|状态未知/);
    assert.match(readme, /device-management-hint/);
    assert.match(readme, /device-detail-management-hint/);
  });

  it('asserts safety docs for management-state hints', () => {
    assert.match(readme, /管理态.*(判定提示|处理提示).*安全(保证|边界)|安全(保证|边界).*管理态.*(判定提示|处理提示)/);
    assert.match(readme, /只读/);
    assert.match(readme, /不新增 API/);
    assert.match(readme, /不写入(任何)?元数据|不写入(any)?metadata/);
    assert.match(readme, /不执行(任何)?远程命令|不执行远程命令/);
    assert.match(readme, /不连接 NAS|不建立真实 NAS 连接/);
    assert.match(readme, /不触发备份|不进行备份/);
  });

  it('documents testing coverage includes management-state hints', () => {
    assert.match(readme, /测试覆盖：.*管理态判定提示/);
  });
});

// ── V0.39 documentation ────────────────────────────────────────────

describe('README — V0.39 device empty filter context', () => {
  it('version table has V0.39 row', () => {
    assert.match(readme, /\| V0\.39 \|[^|]*(空态|筛选上下文|empty|filter context)/i);
  });

  it('version table keeps V0.38 as historical milestone', () => {
    assert.match(readme, /\| V0\.38 \|[^|]*(管理态提示|判定提示|处理提示|hint)/i);
  });

  it('documents empty device list filter context behavior', () => {
    assert.match(readme, /设备列表.*(空态|无匹配设备).*筛选上下文|筛选上下文.*无匹配设备/);
    assert.match(readme, /device-empty-state/);
    assert.match(readme, /device-empty-filter-context/);
    assert.match(readme, /无匹配设备/);
    assert.match(readme, /搜索/);
    assert.match(readme, /状态/);
    assert.match(readme, /管理态/);
  });

  it('asserts safety docs for empty device list filter context', () => {
    assert.match(readme, /设备列表.*(空态|筛选上下文).*安全(保证|边界)|安全(保证|边界).*设备列表.*(空态|筛选上下文)/);
    assert.match(readme, /只读/);
    assert.match(readme, /不新增 API/);
    assert.match(readme, /不重新请求 `?\/api\/devices`?/);
    assert.match(readme, /不写入(任何)?元数据|不写入(any)?metadata/);
    assert.match(readme, /不执行(任何)?远程命令|不执行远程命令/);
    assert.match(readme, /不连接 NAS|不建立真实 NAS 连接/);
  });

  it('documents testing coverage includes empty device list filter context', () => {
    assert.match(readme, /测试覆盖：.*设备列表空态筛选上下文/);
  });
});

// ── V0.40 documentation ────────────────────────────────────────────

describe('README — V0.40 device filter reset button', () => {
  it('version table has V0.40 historical row', () => {
    assert.match(readme, /\| V0\.40 \|[^|]*(重置|reset)/i);
  });

  it('version table keeps V0.39 as historical milestone', () => {
    assert.match(readme, /\| V0\.39 \|[^|]*(空态|筛选上下文|empty|filter context)/i);
  });

  it('documents device filter reset button behavior', () => {
    assert.match(readme, /设备.*(重置|reset)/);
    assert.match(readme, /device-filter-reset/);
    assert.match(readme, /重置/);
  });

  it('asserts README contains a V0.40 device filter reset feature bullet', () => {
    assert.match(readme, /-\s+\*\*设备筛选重置\*\*/i);
  });

  it('asserts Web Console combined feature list includes device filter reset', () => {
    assert.match(readme, /Web Console\*\* — 管理界面：.*设备筛选重置/);
  });

  it('asserts safety docs for device filter reset button', () => {
    assert.match(readme, /重置.*安全(保证|边界)|安全(保证|边界).*重置/);
    assert.match(readme, /只读/);
    assert.match(readme, /不新增 API/);
    assert.match(readme, /不重新请求 `?\/api\/devices`?/);
    assert.match(readme, /不写入(任何)?元数据|不写入(any)?metadata/);
    assert.match(readme, /不执行(任何)?远程命令|不执行远程命令/);
    assert.match(readme, /不连接 NAS|不建立真实 NAS 连接/);
  });

  it('documents testing coverage includes device filter reset button', () => {
    assert.match(readme, /测试覆盖：.*设备筛选重置/);
  });
});

// ── V0.41 documentation ────────────────────────────────────────────

describe('README — V0.41 device filter reset state', () => {
  it('mentions V0.41', () => {
    assert.match(readme, /V0\.41/);
  });

  it('version table has V0.41 historical row', () => {
    assert.match(readme, /\| V0\.41 \|[^|]*(禁用|启用|状态|state)/i);
  });

  it('version table keeps V0.40 as historical milestone', () => {
    assert.match(readme, /\| V0\.40 \|[^|]*(重置|reset)/i);
  });

  it('documents reset state behavior and accessibility attributes', () => {
    assert.match(readme, /设备筛选重置.*(状态|禁用|启用)|重置按钮.*(状态|禁用|启用)/);
    assert.match(readme, /disabled/);
    assert.match(readme, /aria-disabled/);
    assert.match(readme, /data-active/);
  });

  it('asserts safety docs for reset state', () => {
    assert.match(readme, /重置.*状态.*安全(保证|边界)|安全(保证|边界).*重置.*状态/);
    assert.match(readme, /只读/);
    assert.match(readme, /不新增 API/);
    assert.match(readme, /不重新请求 `?\/api\/devices`?/);
    assert.match(readme, /不写入(任何)?元数据|不写入(any)?metadata/);
    assert.match(readme, /不执行(任何)?远程命令|不执行远程命令/);
    assert.match(readme, /不连接 NAS|不建立真实 NAS 连接/);
  });

  it('documents testing coverage includes reset state', () => {
    assert.match(readme, /测试覆盖：.*设备筛选重置状态/);
  });
});

describe('README — V0.42 device active filter summary', () => {
  it('version table keeps V0.41 and V0.42 as historical milestones', () => {
    assert.match(readme, /\| V0\.41 \|[^|]*(禁用|启用|状态|state)/i);
    assert.match(readme, /\| V0\.42 \|[^|]*(设备筛选摘要|active-filter-summary|device-active-filter-summary)/i);
  });

  it('documents active filter summary behavior and accessibility attributes', () => {
    assert.match(readme, /设备筛选摘要|active-filter-summary|device-active-filter-summary/);
    assert.match(readme, /默认筛选/);
    assert.match(readme, /当前筛选/);
    assert.match(readme, /aria-live/);
    assert.match(readme, /role="status"/);
  });

  it('asserts README contains a V0.42 active filter summary feature bullet', () => {
    assert.match(readme, /- \*\*设备筛选摘要\*\*.*device-active-filter-summary/);
  });

  it('asserts Web Console combined feature list includes active filter summary', () => {
    assert.match(readme, /Web Console.*设备筛选摘要/);
  });

  it('asserts safety docs for active filter summary', () => {
    assert.match(readme, /筛选摘要.*安全(保证|边界)|安全(保证|边界).*筛选摘要/);
    assert.match(readme, /只读/);
    assert.match(readme, /不新增 API/);
    assert.match(readme, /不重新请求 `?\/api\/devices`?/);
    assert.match(readme, /不写入(任何)?元数据|不写入(any)?metadata/);
    assert.match(readme, /不执行(任何)?远程命令|不执行远程命令/);
    assert.match(readme, /不连接 NAS|不建立真实 NAS 连接/);
  });

  it('documents testing coverage includes active filter summary', () => {
    assert.match(readme, /测试覆盖：.*设备筛选摘要/);
  });
});

describe('README — V0.43 device active filter summary state', () => {
  it('version table keeps V0.43 as a historical milestone', () => {
    assert.match(readme, /\| V0\.43 \|[^|]*(设备筛选摘要状态|device-active-filter-summary-state|device-active-filter-summary)/i);
  });

  it('documents active filter summary state behavior and accessibility attributes', () => {
    assert.match(readme, /设备筛选摘要状态|device-active-filter-summary/);
    assert.match(readme, /data-active/);
    assert.match(readme, /aria-atomic/);
  });

  it('asserts safety docs for active filter summary state', () => {
    assert.match(readme, /设备筛选摘要状态.*安全(保证|边界)|安全(保证|边界).*设备筛选摘要状态/);
    assert.match(readme, /只读/);
    assert.match(readme, /不新增 API/);
    assert.match(readme, /不重新请求 `?\/api\/devices`?/);
    assert.match(readme, /不写入(任何)?元数据|不写入(any)?metadata/);
    assert.match(readme, /不执行(任何)?远程命令|不执行远程命令/);
    assert.match(readme, /不连接 NAS|不建立真实 NAS 连接/);
  });

  it('documents testing coverage includes active filter summary state', () => {
    assert.match(readme, /测试覆盖：.*设备筛选摘要状态/);
  });
});

describe('README — V0.44 device filter count state', () => {
  it('version table has V0.44 historical row', () => {
    assert.match(readme, /\| V0\.44 \| (历史版本|设备筛选计数状态|[^|]*) \|[^|]*(设备筛选计数状态|device-filter-count-state|device-filter-count)/i);
  });

  it('documents device filter count state behavior and attributes', () => {
    assert.match(readme, /设备筛选计数状态|device-filter-count/);
    assert.match(readme, /data-filtered/);
  });

  it('asserts safety docs for device filter count state', () => {
    assert.match(readme, /设备筛选计数状态.*安全(保证|边界)|安全(保证|边界).*设备筛选计数状态/);
    assert.match(readme, /只读/);
    assert.match(readme, /不新增 API/);
    assert.match(readme, /不重新请求 `?\/api\/devices`?/);
    assert.match(readme, /不写入(任何)?元数据|不写入(any)?metadata/);
    assert.match(readme, /不执行(任何)?远程命令|不执行远程命令/);
    assert.match(readme, /不连接 NAS|不建立真实 NAS 连接/);
  });

  it('documents testing coverage includes device filter count state', () => {
    assert.match(readme, /测试覆盖：.*设备筛选计数状态/);
  });
});

describe('README — V0.45 device filter count metrics', () => {
  it('title no longer claims V0.45 as current', () => {
    assert.doesNotMatch(readme, /^# Linke V0\.45/m);
  });

  it('version badge no longer says 当前版本：V0.45', () => {
    assert.doesNotMatch(readme, /当前版本：V0\.45/);
  });

  it('version table has V0.45 row with 历史版本 milestone', () => {
    assert.match(readme, /\| V0\.45 \| 历史版本 \|[^|]*(设备筛选计数指标|device-filter-count|data-visible-count|data-total-count)/i);
  });

  it('documents device filter count metrics behavior and attributes', () => {
    assert.match(readme, /设备筛选计数指标|device-filter-count/);
    assert.match(readme, /data-visible-count/);
    assert.match(readme, /data-total-count/);
  });

  it('documents device filter count metrics in feature lists', () => {
    assert.match(readme, /- \*\*设备筛选计数指标\*\*.*data-visible-count.*data-total-count/);
    assert.match(readme, /\*\*Web Console\*\*.*设备筛选计数指标/);
  });

  it('asserts safety docs for device filter count metrics', () => {
    assert.match(readme, /设备筛选计数指标.*安全(保证|边界)|安全(保证|边界).*设备筛选计数指标/);
    assert.match(readme, /只读/);
    assert.match(readme, /不新增 API/);
    assert.match(readme, /不重新请求 `?\/api\/devices`?/);
    assert.match(readme, /不写入(任何)?元数据|不写入(any)?metadata/);
    assert.match(readme, /不连接 NAS|不建立真实 NAS 连接/);
    assert.match(readme, /不执行(任何)?远程命令|不执行远程命令/);
  });

  it('documents testing coverage includes device filter count metrics', () => {
    assert.match(readme, /测试覆盖：.*设备筛选计数指标/);
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

  it('documents release-readiness command', () => {
    assertReadmeContains(/release-readiness/, 'release-readiness command');
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

  it('documents the Web Console device list controls', () => {
    assertReadmeContains(
      /设备列表控制[\s\S]*搜索[\s\S]*状态过滤[\s\S]*排序|device list controls[\s\S]*search[\s\S]*filter[\s\S]*sort/i,
      'Web Console device list controls',
    );
  });

  it('documents the Web Console backup jobs overview panel', () => {
    assertReadmeContains(
      /备份任务概览[\s\S]*jobName[\s\S]*sourcePath[\s\S]*快照数|backup jobs overview[\s\S]*jobName[\s\S]*sourcePath[\s\S]*snapshot/i,
      'Web Console backup jobs overview panel',
    );
  });

  it('documents the Web Console backup job detail timeline panel', () => {
    assertReadmeContains(
      /备份任务详情时间线[\s\S]*只读|backup job detail timeline[\s\S]*read.only/i,
      'Web Console backup job detail timeline panel',
    );
  });

  it('documents backup job detail timeline shows snapshot history', () => {
    assertReadmeContains(
      /snapshot ID[\s\S]*创建时间[\s\S]*文件数量|snapshot.*ID[\s\S]*createdAt[\s\S]*file.*count/i,
      'backup job detail timeline snapshot history',
    );
  });
});

// ── Default binding: localhost / 127.0.0.1 ──────────────────────────

describe('README — default binding', () => {
  it('states default host is 127.0.0.1 or localhost', () => {
    assertReadmeContains(/127\.0\.0\.1|localhost/, 'default localhost/127.0.0.1');
  });
});

// ── G0a controller runtime startup boundaries ───────────────────────

describe('README — G0a controller runtime', () => {
  it('documents npm start / node src/controller-runtime.js as the default production entry', () => {
    assertReadmeContains(
      /npm start|node src\/controller-runtime\.js/,
      'default production start via controller-runtime',
    );
    assert.ok(
      /npm start/.test(readme) && /node src\/controller-runtime\.js/.test(readme),
      'README must mention both npm start and node src/controller-runtime.js',
    );
  });

  it('states LINKE_AGENT_HOST is required and only private IP literals are accepted', () => {
    assertReadmeContains(/LINKE_AGENT_HOST/, 'LINKE_AGENT_HOST env var');
    assertReadmeContains(
      /LINKE_AGENT_HOST[\s\S]{0,200}(必填|required)/i,
      'LINKE_AGENT_HOST required',
    );
    assertReadmeContains(
      /私网|RFC1918|ULA|private\s+IP/i,
      'agent host private IP only',
    );
  });

  it('states management remains fixed on loopback', () => {
    assertReadmeContains(
      /管理面[\s\S]{0,120}(loopback|127\.0\.0\.1)|management[\s\S]{0,120}(loopback|127\.0\.0\.1)/i,
      'management fixed loopback',
    );
  });

  it('keeps node src/server.js as the no-enrollment local development entry', () => {
    assertReadmeContains(
      /node src\/server\.js[\s\S]{0,200}(开发|development|enrollment|无设备|不启用设备)/i,
      'server.js local development without enrollment',
    );
  });

  it('states server.js is loopback-only local compat/debug, not production controller management', () => {
    assertReadmeContains(
      /node src\/server\.js[\s\S]{0,280}(loopback|127\.0\.0\.1)/i,
      'server.js remains loopback-only',
    );
    assertReadmeContains(
      /node src\/server\.js[\s\S]{0,320}(不是|not)[\s\S]{0,80}(production controller|生产.*controller|controller management|生产管理)/i,
      'server.js is not production controller management',
    );
    assertReadmeContains(
      /node src\/server\.js[\s\S]{0,240}(不启用|无设备|不会启动)[\s\S]{0,80}enrollment/i,
      'server.js does not enable enrollment',
    );
  });

  it('does not recommend wildcard HOST=0.0.0.0 bind as a development posture', () => {
    // Rejection of wildcard remains documented for production runtime.
    assertReadmeContains(
      /(拒绝|不读取)[\s\S]{0,80}(wildcard|0\.0\.0\.0)|0\.0\.0\.0[\s\S]{0,40}wildcard|wildcard[\s\S]{0,40}(拒绝|reject)/i,
      'documents that production runtime rejects wildcard / 0.0.0.0 binds',
    );
    // README must not teach operators the HOST=0.0.0.0 open-bind command posture.
    assert.doesNotMatch(
      readme,
      /HOST=0\.0\.0\.0/,
      'README must not present HOST=0.0.0.0 as an operator command/posture',
    );
    assert.doesNotMatch(
      readme,
      /(局域网|开发|调试)[\s\S]{0,80}(HOST\s*=\s*0\.0\.0\.0|绑定.*0\.0\.0\.0)|(HOST\s*=\s*0\.0\.0\.0)[\s\S]{0,80}(局域网|开发|调试|受控环境)/,
      'README must not recommend wildcard bind for local/LAN development',
    );
  });

  it('keeps production runtime fixed to loopback management and private Agent bind', () => {
    assertReadmeContains(
      /管理面[\s\S]{0,80}(固定|只绑定)[\s\S]{0,40}(loopback|127\.0\.0\.1)|management[\s\S]{0,80}(loopback|127\.0\.0\.1)/i,
      'production management fixed loopback',
    );
    assertReadmeContains(
      /LINKE_AGENT_HOST[\s\S]{0,200}(私网|RFC1918|ULA|private)/i,
      'production agent requires private IP literal',
    );
    assertReadmeContains(
      /(拒绝|reject)[\s\S]{0,80}(wildcard|0\.0\.0\.0|::)|wildcard[\s\S]{0,40}(拒绝|reject)/i,
      'production rejects agent wildcard binds',
    );
  });

  it('states enrollment and revoke management POSTs require admin-capable tokens', () => {
    assertReadmeContains(
      /LINKE_AUTH_TOKEN|LINKE_WRITE_TOKEN/,
      'admin-capable token env names for enrollment/revoke',
    );
    assertReadmeContains(
      /(enrollment|revoke|设备注册|撤销)[\s\S]{0,220}(LINKE_AUTH_TOKEN|LINKE_WRITE_TOKEN)|(LINKE_AUTH_TOKEN|LINKE_WRITE_TOKEN)[\s\S]{0,220}(enrollment|revoke|设备注册|撤销)/i,
      'enrollment/revoke require LINKE_AUTH_TOKEN or LINKE_WRITE_TOKEN',
    );
    assertReadmeContains(
      /auth-admin-required|503/,
      'unconfigured admin token returns 503 auth-admin-required',
    );
    assertReadmeContains(
      /未配置.*(admin|管理|token|TOKEN).*503|503.*auth-admin-required|auth-admin-required/i,
      'no default open enrollment without admin token',
    );
  });

  it('does not treat automated tests as real Keychain or second-Mac PASS, and keeps Gold blocked', () => {
    assertReadmeContains(
      /自动测试.*(不等于|不是|≠).*真实|automated tests?\s+(are\s+)?not\s+(real|equal)/i,
      'auto tests are not real Keychain/second Mac evidence',
    );
    assertReadmeContains(
      /G0a 真实双 Mac[\s\S]{0,120}PASS|真实双机验收已通过|g0a-real-keychain-lan-acceptance/i,
      'real dual-Mac acceptance has sanitized PASS evidence',
    );
    assertReadmeContains(
      /不得将 G0a 表述为 Gold 发布条件已满足|Gold 依旧 blocked|Gold remains blocked|Gold[^\n]*(BLOCKED|blocked)/i,
      'explicit non-claim of G0a/Gold completion',
    );
    // Existing suite already forbids the literal phrase "Gold ready"; keep that invariant.
    assert.doesNotMatch(readme, /Gold ready|Gold-ready/i);
  });
});

// ── Security boundaries ─────────────────────────────────────────────

describe('README — security boundaries', () => {
  it('has a security boundary / safety section', () => {
    assertReadmeContains(/安全|security/i, 'security boundary section');
  });

  it('states authentication remains partial and not production-grade authorization', () => {
    assertReadmeContains(
      /Bearer|token|LINKE_AUTH_TOKEN|认证.*骨架|partial.*auth|not.*production.*auth/i,
      'partial bearer token authentication',
    );
    assertReadmeContains(
      /不.*完整.*鉴权|不是.*生产级|not.*complete.*authorization|not.*production/i,
      'not production-grade authorization',
    );
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

  it('states backup job detail timeline is read-only and does NOT trigger backup', () => {
    assertReadmeContains(
      /备份任务详情时间线[\s\S]*不触发备份|backup job detail timeline[\s\S]*does not trigger backup/i,
      'backup job detail timeline does not trigger backup',
    );
  });

  it('states backup job detail timeline does NOT execute restore', () => {
    assertReadmeContains(
      /备份任务详情时间线[\s\S]*不执行恢复|backup job detail timeline[\s\S]*does not execute restore/i,
      'backup job detail timeline does not execute restore',
    );
  });

  it('states backup job detail timeline does NOT connect to NAS', () => {
    assertReadmeContains(
      /备份任务详情时间线[\s\S]*不连接.*NAS|backup job detail timeline[\s\S]*does not connect.*NAS/i,
      'backup job detail timeline does not connect to NAS',
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

describe('README — V0.51 release readiness Web panel', () => {
  it('title no longer claims V0.51 as current', () => {
    assert.doesNotMatch(readme, /^# Linke V0\.51/m);
  });

  it('version badge no longer says 当前版本：V0.51', () => {
    assert.doesNotMatch(readme, /当前版本：V0\.51/);
  });

  it('version table has V0.51 row with 历史版本 milestone', () => {
    assert.match(readme, /\| V0\.51 \| 历史版本 \|[^|]*(发布就绪网页控制台|release readiness web panel|release readiness panel)/i);
  });

  it('version table has V0.50 row with 历史版本 milestone', () => {
    assert.match(readme, /\| V0\.50 \| 历史版本 \|[^|]*(发布就绪|release readiness)/i);
  });

  it('documents the release-readiness API endpoint and Web Console readiness panel', () => {
    assert.match(readme, /GET\s+\/api\/release-readiness/);
    assert.match(readme, /release-health-panel/);
  });

  it('asserts safety docs for release-readiness Web Console', () => {
    assert.match(readme, /只读/);
    assert.match(readme, /不写入(任何)?元数据|不写入(any)?metadata/);
    assert.match(readme, /不建立真实 NAS 连接|不连接 NAS/);
    assert.match(readme, /不执行(任何)?远程命令|不执行远程命令/);
    assert.match(readme, /无启动请求|不触发启动请求|无\s*init\s*请求/);
    assert.match(readme, /不自动轮询/);
  });

  it('documents testing coverage includes release readiness Web panel', () => {
    assert.match(readme, /测试覆盖：.*发布就绪网页控制台|测试覆盖：.*release readiness web panel/i);
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

describe('README — V0.46 release health endpoint', () => {
  it('title no longer claims V0.46 as current', () => {
    assert.doesNotMatch(readme, /^# Linke V0\.46/m);
  });

  it('version badge no longer says 当前版本：V0.46', () => {
    assert.doesNotMatch(readme, /当前版本：V0\.46/);
  });

  it('version table has V0.46 row with 历史版本 milestone', () => {
    assert.match(readme, /\| V0\.46 \| 历史版本 \|[^|]*(发布健康检查|release health|\/api\/health)/i);
  });

  it('documents the health endpoint and safety boundary', () => {
    assert.match(readme, /\/api\/health/);
    assert.match(readme, /status.*ok|ok.*status/i);
    assert.match(readme, /degraded|dataDirReadable|unavailable/);
    assert.match(readme, /不写入(任何)?元数据|不写入(any)?metadata/);
    assert.match(readme, /不暴露(本机)?路径|不暴露 DATA_DIR|no path disclosure/i);
    assert.match(readme, /不连接 NAS|不建立真实 NAS 连接/);
    assert.match(readme, /不执行(任何)?远程命令|不执行远程命令/);
  });

  it('documents testing coverage includes release health endpoint', () => {
    assert.match(readme, /测试覆盖：.*发布健康检查/);
  });
});

describe('README — V0.47 release health CLI', () => {
  it('title no longer claims V0.47 as current', () => {
    assert.doesNotMatch(readme, /^# Linke V0\.47/m);
  });

  it('version badge no longer says 当前版本：V0.47', () => {
    assert.doesNotMatch(readme, /当前版本：V0\.47/);
  });

  it('version table has V0.47 row with 历史版本 milestone', () => {
    assert.match(readme, /\| V0\.47 \| 历史版本 \|[^|]*(发布健康检查 CLI|release health CLI|health)/i);
  });

  it('documents the health CLI command and exit-code semantics', () => {
    assert.match(readme, /agent\.js health/);
    assert.match(readme, /--server/);
    assert.match(readme, /degraded|降级/);
    assert.match(readme, /exit|退出码|0/);
  });

  it('asserts safety docs for health CLI', () => {
    assert.match(readme, /只读/);
    assert.match(readme, /不写入(任何)?元数据|不写入(any)?metadata/);
    assert.match(readme, /不建立真实 NAS 连接|不连接 NAS/);
    assert.match(readme, /不执行(任何)?远程命令|不执行远程命令/);
    assert.match(readme, /不需要(设备|--device)/);
  });

  it('documents testing coverage includes release health CLI', () => {
    assert.match(readme, /测试覆盖：.*发布健康检查 CLI/);
  });
});

describe('README — V0.48 release health Web panel', () => {
  it('title no longer claims V0.48 as current', () => {
    assert.doesNotMatch(readme, /^# Linke V0\.48/m);
  });

  it('version badge no longer says 当前版本：V0.48', () => {
    assert.doesNotMatch(readme, /当前版本：V0\.48/);
  });

  it('version table has V0.48 row with 历史版本 milestone', () => {
    assert.match(readme, /\| V0\.48 \| 历史版本 \|[^|]*(发布健康检查面板|release health Web panel)/i);
  });

  it('documents release health Web panel features', () => {
    assert.match(readme, /发布健康检查面板/);
    assert.match(readme, /\/api\/health/);
    assert.match(readme, /手动刷新|刷新状态/);
    assert.match(readme, /不自动(后台)?轮询/);
  });

  it('asserts safety docs for release health Web panel', () => {
    assert.match(readme, /只读/);
    assert.match(readme, /不写入(任何)?元数据|不写入(any)?metadata/);
    assert.match(readme, /不建立真实 NAS 连接|不连接 NAS/);
    assert.match(readme, /不执行(任何)?远程命令|不执行远程命令/);
    assert.match(readme, /不新增接口/);
  });

  it('documents testing coverage includes release health Web panel', () => {
    assert.match(readme, /测试覆盖：.*发布健康检查面板/);
  });
});

describe('README — current release consistency', () => {
  it('title and badge say LINKE_RELEASE_VERSION', () => {
    const escapedVersion = LINKE_RELEASE_VERSION.replace(/\./g, '\\.');
    assert.match(readme, new RegExp(`^# Linke ${escapedVersion}`, 'm'));
    assert.match(readme, new RegExp(`当前版本：${escapedVersion}`));
  });

  it('version table has LINKE_RELEASE_VERSION row with 当前版本 milestone', () => {
    const escapedVersion = LINKE_RELEASE_VERSION.replace(/\./g, '\\.');
    assert.match(readme, new RegExp(`\\| ${escapedVersion} \\| 当前版本 \\|`, 'i'));
  });
});

describe('README — V0.49 release version consistency guard', () => {
  it('title no longer claims V0.49 as current', () => {
    assert.doesNotMatch(readme, /^# Linke V0\.49/m);
  });

  it('version badge no longer says 当前版本：V0.49', () => {
    assert.doesNotMatch(readme, /当前版本：V0\.49/);
  });

  it('version table has V0.49 row with 历史版本 milestone', () => {
    assert.match(readme, /\| V0\.49 \| 历史版本 \|[^|]*(发布版本一致性守卫|release version consistency)/i);
  });
});

describe('README — V0.50 release readiness CLI', () => {
  it('title no longer claims V0.50 as current', () => {
    assert.doesNotMatch(readme, /^# Linke V0\.50/m);
  });

  it('version badge no longer says 当前版本：V0.50', () => {
    assert.doesNotMatch(readme, /当前版本：V0\.50/);
  });

  it('version table has V0.50 row with 历史版本 milestone', () => {
    assert.match(readme, /\| V0\.50 \| 历史版本 \|[^|]*(发布就绪|release readiness)/i);
  });
});

describe('README — V0.53 optional bearer token auth skeleton', () => {
  it('title and badge no longer claim V0.53 as current', () => {
    assert.doesNotMatch(readme, /^# Linke V0\.53/m);
    assert.doesNotMatch(readme, /当前版本：V0\.53/);
  });

  it('version table has V0.53 row with 历史版本 milestone', () => {
    assert.match(readme, /\| V0\.53 \| 历史版本 \|[^|]*(Bearer|token|认证|auth)/i);
  });

  it('version table has V0.54 row with 历史版本 milestone', () => {
    assert.match(readme, /\| V0\.54 \| 历史版本 \|[^|]*(Web Console|API token|内存态|token UX)/i);
  });

  it('version table has V0.52 row with 历史版本 milestone', () => {
    assert.match(readme, /\| V0\.52 \| 历史版本 \|[^|]*(Gold readiness scorecard docs|Gold readiness Web panel|gold-readiness-panel)/i);
  });

  it('version table has V0.51 row with 历史版本 milestone', () => {
    assert.match(readme, /\| V0\.51 \| 历史版本 \|[^|]*(发布就绪网页控制台|release readiness web panel|release readiness panel)/i);
  });

  it('documents optional bearer token server and agent usage', () => {
    assert.match(readme, /LINKE_AUTH_TOKEN/);
    assert.match(readme, /LINKE_TOKEN/);
    assert.match(readme, /Authorization:\s*Bearer/i);
    assert.match(readme, /--token\s+<token>|--token/i);
    assert.match(readme, /401|Unauthorized/);
  });

  it('states bearer token auth remains partial and not production-grade authorization', () => {
    assert.match(readme, /partial|部分|骨架|prototype|原型/i);
    assert.match(readme, /不是.*生产级|not.*production|不.*完整.*鉴权|not.*complete.*authorization/i);
    assert.match(readme, /Web Console|浏览器.*token|token.*浏览器/i);
    assert.match(readme, /内存|memory/i);
    assert.match(readme, /localStorage|sessionStorage|cookie/);
  });
});

describe('README — V0.55 server request/error hardening', () => {
  it('title and badge no longer claim V0.55 as current', () => {
    assert.doesNotMatch(readme, /^# Linke V0\.55/m);
    assert.doesNotMatch(readme, /当前版本：V0\.55/);
  });

  it('version table marks V0.54 and V0.55 historical', () => {
    assert.match(readme, /\| V0\.54 \| 历史版本 \|[^|]*(Web Console|API token|内存态|token UX)/i);
    assert.match(readme, /\| V0\.55 \| 历史版本 \|[^|]*(body|请求体|413|500|Internal Server Error|错误)/i);
  });

  it('documents request body size limit and sanitized unexpected 500 responses', () => {
    assert.match(readme, /1\s*MiB|1048576|请求体.*上限|body.*limit/i);
    assert.match(readme, /413|Request body too large/);
    assert.match(readme, /Internal Server Error/);
    assert.match(readme, /不.*暴露.*内部|不.*回显.*内部|sanitize|sanitized/i);
  });

  it('keeps Gold readiness blocked while production hardening is only partial', () => {
    assert.match(readme, /production-hardening[\s\S]*(partial|部分)|生产.*硬化[\s\S]*(partial|部分)/i);
    assert.match(readme, /real-nas-remote-backup[\s\S]*(blocked|阻塞)|真实 NAS[\s\S]*(blocked|阻塞)/i);
    assert.match(readme, /Gold[\s\S]*(blocked|阻塞)|blocked[\s\S]*Gold/i);
  });
});

describe('README — V0.56 restore target guard', () => {
  it('title and badge no longer claim V0.56 as current', () => {
    assert.doesNotMatch(readme, /^# Linke V0\.56/m);
    assert.doesNotMatch(readme, /当前版本：V0\.56/);
  });

  it('version table marks V0.55 and V0.56 historical', () => {
    assert.match(readme, /\| V0\.55 \| 历史版本 \|[^|]*(请求体|body|413|500|Internal Server Error)/i);
    assert.match(readme, /\| V0\.56 \| 历史版本 \|[^|]*(LINKE_RESTORE_ROOT|restoreRoot|targetPath|symlink|恢复)/i);
  });

  it('documents restoreRoot guard behavior and safe failure', () => {
    assert.match(readme, /LINKE_RESTORE_ROOT/);
    assert.match(readme, /\/api\/restore/);
    assert.match(readme, /restore-dry-run/);
    assert.match(readme, /targetPath/);
    assert.match(readme, /symlink|realpath/i);
    assert.match(readme, /targetPath is outside the allowed restore root/);
    assert.match(readme, /400/);
  });

  it('keeps Gold readiness blocked while production hardening is only partial', () => {
    assert.match(readme, /production-hardening[\s\S]*(partial|部分)|生产.*硬化[\s\S]*(partial|部分)/i);
    assert.match(readme, /real-nas-remote-backup[\s\S]*(blocked|阻塞)|真实 NAS[\s\S]*(blocked|阻塞)/i);
    assert.match(readme, /Gold[\s\S]*(blocked|阻塞)|blocked[\s\S]*Gold/i);
  });
});

describe('README — V0.57 restore destination symlink defense', () => {
  it('title and badge no longer claim V0.57 as current', () => {
    assert.doesNotMatch(readme, /^# Linke V0\.57/m);
    assert.doesNotMatch(readme, /当前版本：V0\.57/);
  });

  it('version table marks V0.56 and V0.57 historical', () => {
    assert.match(readme, /\| V0\.56 \| 历史版本 \|[^|]*(LINKE_RESTORE_ROOT|restoreRoot|targetPath|symlink|恢复)/i);
    assert.match(readme, /\| V0\.57 \| 历史版本 \|[^|]*(O_NOFOLLOW|symlink|Restore|恢复|写入)/i);
  });

  it('documents destination symlink write protection and compatibility boundary', () => {
    assert.match(readme, /O_NOFOLLOW/);
    assert.match(readme, /目标文件.*symlink|symlink.*目标文件/i);
    assert.match(readme, /中间目录.*symlink|symlink.*中间目录/i);
    assert.match(readme, /Restore target path is not allowed/);
    assert.match(readme, /未设置.*LINKE_RESTORE_ROOT|without.*LINKE_RESTORE_ROOT|localhost.*兼容/i);
  });

  it('keeps Gold readiness blocked while production hardening is only partial', () => {
    assert.match(readme, /production-hardening[\s\S]*(partial|部分)|生产.*硬化[\s\S]*(partial|部分)/i);
    assert.match(readme, /real-nas-remote-backup[\s\S]*(blocked|阻塞)|真实 NAS[\s\S]*(blocked|阻塞)/i);
    assert.match(readme, /Gold[\s\S]*(blocked|阻塞)|blocked[\s\S]*Gold/i);
  });
});

describe('README — V0.58 audit log foundation', () => {
  it('title and badge no longer claim V0.58 as current', () => {
    assert.doesNotMatch(readme, /^# Linke V0\.58/m);
    assert.doesNotMatch(readme, /当前版本：V0\.58/);
  });

  it('version table marks V0.57 and V0.58 historical', () => {
    assert.match(readme, /\| V0\.57 \| 历史版本 \|[^|]*(O_NOFOLLOW|symlink|Restore|恢复|写入)/i);
    assert.match(readme, /\| V0\.58 \| 历史版本 \|[^|]*(audit|审计|JSONL|\/api\/audit-log)/i);
  });

  it('documents audit log API, JSONL storage, and sensitive-field exclusion', () => {
    assert.match(readme, /GET\s+\/api\/audit-log/);
    assert.match(readme, /dataDir\/audit\/events\.jsonl|events\.jsonl/);
    assert.match(readme, /auth\.denied/);
    assert.match(readme, /sourcePath|targetPath|Authorization|Bearer|NAS endpoint/i);
    assert.match(readme, /不(记录|保存).*sourcePath|does not store.*sourcePath/i);
  });

  it('documents audit limitations and keeps Gold readiness blocked', () => {
    assert.match(readme, /rotation|轮转|retention|保留/i);
    assert.match(readme, /best-effort|尽力|不阻塞/i);
    assert.match(readme, /production-hardening[\s\S]*(partial|部分)|生产.*硬化[\s\S]*(partial|部分)/i);
    assert.match(readme, /real-nas-remote-backup[\s\S]*(blocked|阻塞)|真实 NAS[\s\S]*(blocked|阻塞)/i);
    assert.match(readme, /Gold[\s\S]*(blocked|阻塞)|blocked[\s\S]*Gold/i);
  });
});

describe('README — V0.59 API rate-limit foundation', () => {
  it('title and badge no longer claim V0.59 as current', () => {
    assert.doesNotMatch(readme, /^# Linke V0\.59/m);
    assert.doesNotMatch(readme, /当前版本：V0\.59/);
  });

  it('version table marks V0.58 and V0.59 historical', () => {
    assert.match(readme, /\| V0\.58 \| 历史版本 \|[^|]*(audit|审计|JSONL|\/api\/audit-log)/i);
    assert.match(readme, /\| V0\.59 \| 历史版本 \|[^|]*(rate-limit|限流|429|LINKE_RATE_LIMIT_PER_MINUTE)/i);
  });

  it('documents optional rate limiting, auth-before ordering, non-API bypass, and audit event', () => {
    assert.match(readme, /LINKE_RATE_LIMIT_PER_MINUTE/);
    assert.match(readme, /429|Rate limit exceeded/);
    assert.match(readme, /auth.*前|before.*auth|认证.*前/i);
    assert.match(readme, /\/api\/\*|\/api\/\*/);
    assert.match(readme, /非.*\/api|non-API/i);
    assert.match(readme, /api\.rate_limited/);
  });

  it('keeps Gold readiness blocked and documents foundation limits', () => {
    assert.match(readme, /in-memory|内存|单进程/i);
    assert.match(readme, /distributed|多实例|Redis|proxy|代理/i);
    assert.match(readme, /production-hardening[\s\S]*(partial|部分)|生产.*硬化[\s\S]*(partial|部分)/i);
    assert.match(readme, /real-nas-remote-backup[\s\S]*(blocked|阻塞)|真实 NAS[\s\S]*(blocked|阻塞)/i);
    assert.match(readme, /Gold[\s\S]*(blocked|阻塞)|blocked[\s\S]*Gold/i);
  });
});

describe('README — V0.60 audit retention foundation', () => {
  it('title and badge no longer claim V0.60 as current', () => {
    assert.doesNotMatch(readme, /^# Linke V0\.60/m);
    assert.doesNotMatch(readme, /当前版本：V0\.60/);
  });

  it('version table marks V0.59 and V0.60 historical', () => {
    assert.match(readme, /\| V0\.59 \| 历史版本 \|[^|]*(rate-limit|限流|429|LINKE_RATE_LIMIT_PER_MINUTE)/i);
    assert.match(readme, /\| V0\.60 \| 历史版本 \|[^|]*(audit.*retention|审计.*保留|LINKE_AUDIT_MAX_EVENTS|最新 N 条)/i);
  });

  it('documents optional audit retention configuration and newest-event semantics', () => {
    assert.match(readme, /LINKE_AUDIT_MAX_EVENTS/);
    assert.match(readme, /latest N|newest N|最新 N 条|最新.*事件/i);
    assert.match(readme, /默认.*关闭|disabled by default|未设置.*禁用/i);
    assert.match(readme, /dataDir\/audit\/events\.jsonl|events\.jsonl/);
    assert.match(readme, /GET\s+\/api\/audit-log/);
  });

  it('keeps Gold readiness blocked and documents retention limits', () => {
    assert.match(readme, /tamper-proof|防篡改|signing|签名|SIEM|external log|外部/i);
    assert.match(readme, /multi-process|多进程|distributed|跨实例/i);
    assert.match(readme, /production-grade audit|生产级审计/i);
    assert.match(readme, /production-hardening[\s\S]*(partial|部分)|生产.*硬化[\s\S]*(partial|部分)/i);
    assert.match(readme, /real-nas-remote-backup[\s\S]*(blocked|阻塞)|真实 NAS[\s\S]*(blocked|阻塞)/i);
    assert.match(readme, /Gold[\s\S]*(blocked|阻塞)|blocked[\s\S]*Gold/i);
  });
});

describe('README — V0.61 API read/write token foundation', () => {
  it('title and badge no longer claim V0.61 as current', () => {
    assert.doesNotMatch(readme, /^# Linke V0\.61/m);
    assert.doesNotMatch(readme, /当前版本：V0\.61/);
  });

  it('version table marks V0.60 and V0.61 historical', () => {
    assert.match(readme, /\| V0\.60 \| 历史版本 \|[^|]*(audit.*retention|审计.*保留|LINKE_AUDIT_MAX_EVENTS|最新 N 条)/i);
    assert.match(readme, /\| V0\.61 \| 历史版本 \|[^|]*(read\/write|读\/写|读写|LINKE_READ_TOKEN|LINKE_WRITE_TOKEN|403|auth\.forbidden)/i);
  });

  it('documents read/write token configuration and scoped behavior', () => {
    assert.match(readme, /LINKE_READ_TOKEN/);
    assert.match(readme, /LINKE_WRITE_TOKEN/);
    assert.match(readme, /read token|读 token|只读 token/i);
    assert.match(readme, /write token|写 token/i);
    assert.match(readme, /403\s+Forbidden|Forbidden/);
    assert.match(readme, /auth\.forbidden/);
    assert.match(readme, /authToken|LINKE_AUTH_TOKEN|LINKE_TOKEN/);
  });

  it('keeps Gold readiness blocked and documents authorization limits', () => {
    assert.match(readme, /security-auth[\s\S]*(partial|部分)|读\/写 token[\s\S]*(partial|部分)/i);
    assert.match(readme, /token rotation|轮换|secret management|密钥管理|production-grade authorization|生产级鉴权/i);
    assert.match(readme, /real-nas-remote-backup[\s\S]*(blocked|阻塞)|真实 NAS[\s\S]*(blocked|阻塞)/i);
    assert.match(readme, /Gold[\s\S]*(blocked|阻塞)|blocked[\s\S]*Gold/i);
  });
});

describe('README — V0.62 auth status readiness API', () => {
  it('title and badge no longer claim V0.62 as current', () => {
    assert.doesNotMatch(readme, /^# Linke V0\.62/m);
    assert.doesNotMatch(readme, /当前版本：V0\.62/);
  });

  it('version table marks V0.61 and V0.62 historical', () => {
    assert.match(readme, /\| V0\.61 \| 历史版本 \|[^|]*(read\/write|读\/写|读写|LINKE_READ_TOKEN|LINKE_WRITE_TOKEN|403|auth\.forbidden)/i);
    assert.match(readme, /\| V0\.62 \| 历史版本 \|[^|]*(auth-status|auth status|认证状态|GET \/api\/auth-status|buildAuthStatusResponse)/i);
  });

  it('documents auth-status API and sanitized response boundary', () => {
    assert.match(readme, /GET\s+\/api\/auth-status/);
    assert.match(readme, /buildAuthStatusResponse|auth status|认证状态/i);
    assert.match(readme, /configuredScopes|writeRoutes|写入路由/i);
    assert.match(readme, /不返回.*token|no.*token|tokenValuesReturned/i);
    assert.match(readme, /不写入.*metadata|只读|read-only/i);
  });

  it('keeps Gold readiness blocked and documents auth-status limits', () => {
    assert.match(readme, /security-auth[\s\S]*(partial|部分)|auth-status[\s\S]*(partial|部分)/i);
    assert.match(readme, /不.*token rotation|token rotation|secret management|生产级鉴权/i);
    assert.match(readme, /Gold[\s\S]*(blocked|阻塞)|blocked[\s\S]*Gold/i);
  });
});

describe('README — V0.63 shared write-route registry', () => {
  it('version table marks V0.63 historical', () => {
    assert.match(readme, /\| V0\.63 \| 历史版本 \|[^|]*(write-route|write route|写入路由|API_WRITE_ROUTES|isApiWriteRoute)/i);
  });

  it('version table marks V0.62 historical and keeps V0.63 shared registry docs', () => {
    assert.match(readme, /\| V0\.62 \| 历史版本 \|[^|]*(auth-status|auth status|认证状态|GET \/api\/auth-status|buildAuthStatusResponse)/i);
    assert.match(readme, /\| V0\.63 \| 历史版本 \|[^|]*(write-route|write route|写入路由|API_WRITE_ROUTES|isApiWriteRoute)/i);
  });

  it('documents shared write-route registry and auth-status alignment', () => {
    assert.match(readme, /API_WRITE_ROUTES/);
    assert.match(readme, /formatApiRoute/);
    assert.match(readme, /isApiWriteRoute/);
    assert.match(readme, /writeRoutes|写入路由/);
    assert.match(readme, /auth-status|GET\s+\/api\/auth-status/i);
    assert.match(readme, /single source|同一来源|共享|registry|注册表/i);
  });

  it('keeps Gold blocked and rejects production authorization overclaims', () => {
    assert.match(readme, /security-auth[\s\S]*(partial|部分)|write-route[\s\S]*(foundation|基础)/i);
    assert.match(readme, /不是完整生产级鉴权|不.*production-grade authorization|not production-grade authorization|token rotation|secret management/i);
    assert.match(readme, /Gold[\s\S]*(blocked|阻塞)|blocked[\s\S]*Gold/i);
  });
});

describe('README — V0.64 NAS credential reference gate', () => {
  it('title and badge no longer claim V0.64 as current', () => {
    assert.doesNotMatch(readme, /^# Linke V0\.64/m);
    assert.doesNotMatch(readme, /当前版本：V0\.64/);
  });

  it('version table marks V0.63 and V0.64 historical', () => {
    assert.match(readme, /\| V0\.63 \| 历史版本 \|[^|]*(write-route|write route|写入路由|API_WRITE_ROUTES|isApiWriteRoute)/i);
    assert.match(readme, /\| V0\.64 \| 历史版本 \|[^|]*(credentialRef|executionGate|NAS.*凭证引用|credential reference)/i);
  });

  it('documents credentialRef as a non-secret slug and never as a credential value', () => {
    assert.match(readme, /credentialRef/);
    assert.match(readme, /ALLOWED_NAS_CREDENTIAL_REF_PATTERN|validateNasCredentialRef|\^\[a-z\]\[a-z0-9-\]\{1,30\}\$/);
    assert.match(readme, /非密钥|non-secret|引用|reference/i);
    assert.match(readme, /不读取.*env|不读取.*环境变量|does not read.*env/i);
    assert.match(readme, /不回显|不返回.*credentialRef|credentialRefConfigured/i);
  });

  it('documents executionGate while keeping real NAS execution blocked', () => {
    assert.match(readme, /executionGate/);
    assert.match(readme, /remoteExecutionAllowed[\s\S]*false/);
    assert.match(readme, /real NAS transport not implemented|真实 NAS.*未实现|真实.*传输.*未实现/i);
    assert.match(readme, /wouldConnect:false|wouldWrite:false|不连接 NAS|不写远端/i);
  });

  it('keeps Gold blocked and rejects real NAS overclaims', () => {
    assert.match(readme, /nas-dry-run[\s\S]*(partial|部分)/i);
    assert.match(readme, /real-nas-remote-backup[\s\S]*(blocked|阻塞)|真实 NAS[\s\S]*(blocked|阻塞)/i);
    assert.match(readme, /Gold[\s\S]*(blocked|阻塞)|blocked[\s\S]*Gold/i);
    assert.ok(!/真实 NAS 远程备份已完成|real NAS remote backup ready|production ready/i.test(readme));
  });
});

describe('README — V0.65 Web NAS execution gate display', () => {
  it('title and badge no longer claim V0.65 as current', () => {
    assert.doesNotMatch(readme, /^# Linke V0\.65/m);
    assert.doesNotMatch(readme, /当前版本：V0\.65/);
  });

  it('version table marks V0.64 and V0.65 historical', () => {
    assert.match(readme, /\| V0\.64 \| 历史版本 \|[^|]*(credentialRef|executionGate|NAS.*凭证引用|credential reference)/i);
    assert.match(readme, /\| V0\.65 \| 历史版本 \|[^|]*(executionGate|credentialRefConfigured|Web.*执行门禁|execution gate display)/i);
  });

  it('documents Web NAS execution gate display and credentialRefConfigured boolean rendering', () => {
    assert.match(readme, /executionGate/);
    assert.match(readme, /credentialRefConfigured/);
    assert.match(readme, /已配置|未配置|true|false/);
    assert.match(readme, /不渲染.*raw credentialRef|never render.*raw credentialRef|不泄露/i);
  });

  it('documents executionGate in Web Console while keeping real NAS execution blocked', () => {
    assert.match(readme, /remoteExecutionAllowed[\s\S]*false/);
    assert.match(readme, /real NAS transport not implemented|真实 NAS.*未实现|真实.*传输.*未实现/i);
    assert.match(readme, /wouldConnect:false|wouldWrite:false|不连接 NAS|不写远端/i);
    assert.match(readme, /当前发布版本号[\s\S]*"V0\.66"/);
  });

  it('keeps Gold blocked and rejects real NAS overclaims for V0.65', () => {
    assert.match(readme, /nas-dry-run[\s\S]*(partial|部分)/i);
    assert.match(readme, /real-nas-remote-backup[\s\S]*(blocked|阻塞)|真实 NAS[\s\S]*(blocked|阻塞)/i);
    assert.match(readme, /Gold[\s\S]*(blocked|阻塞)|blocked[\s\S]*Gold/i);
    assert.ok(!/真实 NAS 远程备份已完成|real NAS remote backup ready|production ready|无安全隐患/i.test(readme));
  });
});

describe('README — V0.67 NAS execution readiness summary', () => {
  it('title and badge no longer claim V0.67 as current', () => {
    assert.doesNotMatch(readme, /^# Linke V0\.67/m);
    assert.doesNotMatch(readme, /当前版本：V0\.67/);
  });

  it('version table marks V0.66 and V0.67 historical', () => {
    assert.match(readme, /\| V0\.66 \| 历史版本 \|[^|]*(denylist|credential-like|凭证字段|FORBIDDEN_NAS_CREDENTIAL_FIELDS)/i);
    assert.match(readme, /\| V0\.67 \| 历史版本 \|[^|]*(readinessSummary|executionReadiness|就绪性摘要|就绪性状态)/i);
  });

  it('documents the complete 15-field NAS credential denylist', () => {
    const fields = [
      'username', 'password', 'token', 'apiKey', 'secret', 'accessKey', 'refreshToken',
      'privateKey', 'clientSecret', 'connectionString', 'accessToken', 'idToken',
      'secretKey', 'sshKey', 'passphrase',
    ];
    for (const field of fields) {
      assert.match(readme, new RegExp(field));
    }
    assert.match(readme, /15\s*个|15-field|15 fields/i);
  });

  it('explains connectionString and secretKey denylist rationale without adding credential resolution claims', () => {
    assert.match(readme, /connectionString[\s\S]*(凭证|credential|用户名|密码|token)/i);
    assert.match(readme, /secretKey[\s\S]*(secret|独立键名|exact-key|精确)/i);
    assert.match(readme, /不读取 env|不访问 secret manager|不解析 credential store/i);
    assert.ok(!/从 env 读取凭证|读取 secret manager|解析 credential store 凭证/i.test(readme));
  });

  it('documents V0.67 readiness summary as dry-run-only with fixed blocker codes', () => {
    assert.match(readme, /readinessSummary/);
    assert.match(readme, /executionReadiness/);
    assert.match(readme, /target-disabled/);
    assert.match(readme, /credential-ref-missing/);
    assert.match(readme, /remote-execution-blocked/);
    assert.match(readme, /ready[\s\S]*(不可达|unreachable)|不可达[\s\S]*ready/i);
    assert.match(readme, /dry-run[\s\S]*(配置完备|configuration completeness|只读|blocked)/i);
  });

  it('keeps Gold blocked and rejects real NAS overclaims for V0.67', () => {
    assert.match(readme, /nas-dry-run[\s\S]*(partial|部分)/i);
    assert.match(readme, /real-nas-remote-backup[\s\S]*(blocked|阻塞)|真实 NAS[\s\S]*(blocked|阻塞)/i);
    assert.ok(!/真实 NAS 远程备份已完成|real NAS remote backup ready|production ready|无安全隐患/i.test(readme));
  });
});

describe('README — V0.69 NAS CLI fail on blocked option', () => {
  it('title no longer claims V0.69 as current', () => {
    assert.doesNotMatch(readme, /^# Linke V0\.69/m);
  });

  it('version badge no longer says 当前版本：V0.69', () => {
    assert.doesNotMatch(readme, /当前版本：V0\.69/);
  });

  it('version table marks V0.69 historical', () => {
    assert.match(readme, /\| V0\.69 \| 历史版本 \|[^|]*(fail-on-blocked|exit code|退出码|自动化门禁)/i);
  });

  it('documents --fail-on-blocked command usage', () => {
    assert.match(readme, /nas-dry-run[\s\S]*--fail-on-blocked[\s\S]*(exit code|退出码|2)/i);
  });

  it('keeps Gold blocked and rejects real NAS overclaims for V0.69', () => {
    const forbiddenOverclaims = [
      ['production', 'ready'].join(' '),
      ['production', 'ready'].join('-'),
      ['Gold', 'ready'].join(' '),
      ['Gold', 'ready'].join('-'),
      ['real NAS remote backup', 'ready'].join(' '),
      '无安全' + '隐患',
    ].join('|');
    assert.doesNotMatch(readme, new RegExp(forbiddenOverclaims, 'i'));
    assert.match(readme, /nas-dry-run[\s\S]*(partial|部分)/i);
    assert.match(readme, /Gold blockers[\s\S]*V0\.69[\s\S]*CLI fail-on-blocked/i);
    assert.match(readme, /NAS、认证和生产硬化仍是 partial[\s\S]*V0\.69[\s\S]*CLI fail-on-blocked/i);
    assert.match(readme, /real-nas-remote-backup[\s\S]*(blocked|阻塞)|真实 NAS[\s\S]*(blocked|阻塞)/i);
    assert.match(readme, /Gold[\s\S]*(blocked|阻塞)|blocked[\s\S]*Gold/i);
  });
});

describe('README — V1.46 LaunchAgent code-stage closure honesty', () => {
  it('title and badge claim V1.46 as current', () => {
    assertReadmeContains(/# Linke V1\.46/, 'README title should mention V1.46');
    assertReadmeContains(/\*\*当前版本：V1\.46\*\*/, 'README badge should mention V1.46');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.45\*\*/, 'README badge must not still claim V1.45 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.45$/m, 'README title must not still claim V1.45 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.44\*\*/, 'README badge must not still claim V1.44 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.44$/m, 'README title must not still claim V1.44 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.43\*\*/, 'README badge must not still claim V1.43 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.43$/m, 'README title must not still claim V1.43 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.42\*\*/, 'README badge must not still claim V1.42 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.42$/m, 'README title must not still claim V1.42 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.41\*\*/, 'README badge must not still claim V1.41 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.41$/m, 'README title must not still claim V1.41 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.40\*\*/, 'README badge must not still claim V1.40 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.40$/m, 'README title must not still claim V1.40 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.39\*\*/, 'README badge must not still claim V1.39 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.39$/m, 'README title must not still claim V1.39 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.38\*\*/, 'README badge must not still claim V1.38 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.38$/m, 'README title must not still claim V1.38 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.37\*\*/, 'README badge must not still claim V1.37 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.37$/m, 'README title must not still claim V1.37 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.36\*\*/, 'README badge must not still claim V1.36 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.36$/m, 'README title must not still claim V1.36 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.35\*\*/, 'README badge must not still claim V1.35 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.35$/m, 'README title must not still claim V1.35 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.34\*\*/, 'README badge must not still claim V1.34 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.34$/m, 'README title must not still claim V1.34 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.33\*\*/, 'README badge must not still claim V1.33 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.33$/m, 'README title must not still claim V1.33 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.32\*\*/, 'README badge must not still claim V1.32 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.32$/m, 'README title must not still claim V1.32 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.31\*\*/, 'README badge must not still claim V1.31 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.31$/m, 'README title must not still claim V1.31 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.30\*\*/, 'README badge must not still claim V1.30 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.30$/m, 'README title must not still claim V1.30 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.29\*\*.*当前版本/m, 'README badge must not still claim V1.29 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.29$/m, 'README title must not still claim V1.29 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.28\*\*.*当前版本/m, 'README badge must not still claim V1.28 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.28$/m, 'README title must not still claim V1.28 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.27\*\*.*当前版本/m, 'README badge must not still claim V1.27 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.27$/m, 'README title must not still claim V1.27 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.26\*\*.*当前版本/m, 'README badge must not still claim V1.26 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.26$/m, 'README title must not still claim V1.26 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.25\*\*.*当前版本/m, 'README badge must not still claim V1.25 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.25$/m, 'README title must not still claim V1.25 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.24\*\*.*当前版本/m, 'README badge must not still claim V1.24 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.24$/m, 'README title must not still claim V1.24 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.23\*\*.*当前版本/m, 'README badge must not still claim V1.23 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.23$/m, 'README title must not still claim V1.23 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.22\*\*.*当前版本/m, 'README badge must not still claim V1.22 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.22$/m, 'README title must not still claim V1.22 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.21\*\*.*当前版本/m, 'README badge must not still claim V1.21 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.21$/m, 'README title must not still claim V1.21 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.20\*\*.*当前版本/m, 'README badge must not still claim V1.20 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.20$/m, 'README title must not still claim V1.20 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.19\*\*.*当前版本/m, 'README badge must not still claim V1.19 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.19$/m, 'README title must not still claim V1.19 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.18\*\*.*当前版本/m, 'README badge must not still claim V1.18 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.18$/m, 'README title must not still claim V1.18 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.17\*\*.*当前版本/m, 'README badge must not still claim V1.17 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.17$/m, 'README title must not still claim V1.17 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.16\*\*.*当前版本/m, 'README badge must not still claim V1.16 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.16$/m, 'README title must not still claim V1.16 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.15\*\*.*当前版本/m, 'README badge must not still claim V1.15 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.15$/m, 'README title must not still claim V1.15 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.14\*\*.*当前版本/m, 'README badge must not still claim V1.14 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.14$/m, 'README title must not still claim V1.14 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.13\*\*.*当前版本/m, 'README badge must not still claim V1.13 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.13$/m, 'README title must not still claim V1.13 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.12\*\*.*当前版本/m, 'README badge must not still claim V1.12 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.12$/m, 'README title must not still claim V1.12 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.11\*\*.*当前版本/m, 'README badge must not still claim V1.11 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.11$/m, 'README title must not still claim V1.11 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.10\*\*.*当前版本/m, 'README badge must not still claim V1.10 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.10$/m, 'README title must not still claim V1.10 as current title');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.09\*\*.*当前版本/m, 'README badge must not still claim V1.09 as current');
    assertReadmeDoesNotContain(/^# Linke V1\.09$/m, 'README title must not still claim V1.09 as current title');
    assertReadmeDoesNotContain(/^# Linke V1\.08/m, 'README title must not still claim V1.08');
    assertReadmeDoesNotContain(/\*\*当前版本：V1\.08\*\*/, 'README badge must not still claim V1.08');
  });

  it('badge mentions V1.46 LaunchAgent code-stage closure PASS signature and honest boundaries', () => {
    // Scope ONLY the unique current badge blockquote — never slice(0,N) which bleeds into the version table
    const badge = extractCurrentBadgeBlockquote(readme);
    // Structural canary: extracted badge must not include version-table current row syntax
    assert.ok(
      !badge.includes(`| ${LINKE_RELEASE_VERSION} | 当前版本 |`),
      `extracted badge must not contain version table row "| ${LINKE_RELEASE_VERSION} | 当前版本 |" (cross-region bleed guard)`,
    );
    assert.ok(
      badge.includes(V146_SIGNATURE),
      'top badge must include exact V1.46 user-level LaunchAgent lifecycle code-stage closure PASS signature',
    );
    assert.ok(
      badge.includes('nas-dry-run ready'),
      'top badge must state nas-dry-run ready',
    );
    assert.ok(
      badge.includes('real-nas-remote-backup ready'),
      'top badge must state real-nas-remote-backup ready',
    );
    assert.ok(
      badge.includes('configuration-only ready'),
      'top badge must state configuration-only ready',
    );
    assert.ok(
      badge.includes('runtime mount verification pending'),
      'top badge must state runtime mount verification pending',
    );
    assert.ok(
      badge.includes('executionAuthorized:false'),
      'top badge must include executionAuthorized:false',
    );
    assert.ok(
      badge.includes('wouldConnect:false'),
      'top badge must include wouldConnect:false',
    );
    assert.ok(
      badge.includes('wouldWrite:false'),
      'top badge must include wouldWrite:false',
    );
    assert.ok(
      badge.includes('not Gold'),
      'top badge must include not Gold',
    );
    assert.ok(
      badge.includes('Gold remains partial 6/3/0/9'),
      'top badge must include Gold remains partial 6/3/0/9',
    );
    for (const phrase of [
      'manual repair attestation pure closeout',
      'frozen compensation/crash windows',
      'real Node owner SIGKILL/recovery child',
      'no real launchctl',
      'no clean-Mac lifecycle evidence',
      'not installation complete',
      'code-stage only',
      'conditional fake host adapters',
    ]) {
      assert.ok(
        badge.includes(phrase),
        `top badge must include V1.46 LaunchAgent boundary phrase: ${phrase}`,
      );
    }
    assert.ok(
      badge.includes('three partial items remain'),
      'top badge must state three partial items remain',
    );
    assert.ok(
      !badge.includes('Gold remains partial 5/4/0/9'),
      'top badge must not keep stale Gold remains partial 5/4/0/9 (V1.44 historical count)',
    );
    assert.ok(
      !badge.includes('four partial items remain'),
      'top badge must not keep stale four partial items remain (V1.44 historical count)',
    );
    assert.ok(
      !/\bGold\/GA\b|Gold ready|GA ready|production-ready/i.test(badge),
      'top badge must not claim Gold/GA/production-ready',
    );
    // V1.43 historical base retained on badge (not current version; foundation facts only)
    assert.ok(
      badge.includes('V1.43 historical base'),
      'top badge must include V1.43 historical base marker',
    );
    assert.ok(
      badge.includes('no automatic rotation'),
      'top badge V1.43 historical base must include no automatic rotation',
    );
    assert.ok(
      badge.includes('not WORM'),
      'top badge V1.43 historical base must include not WORM',
    );
    assert.ok(
      badge.includes('no external authenticity'),
      'top badge V1.43 historical base must include no external authenticity',
    );
    // V1.42 historical G0c base retained with exact signature
    {
      const markerIdx = badge.indexOf('V1.42 historical base');
      const signatureIdx = badge.indexOf(V142_SIGNATURE);
      assert.ok(markerIdx >= 0, 'top badge must include V1.42 historical base marker');
      assert.ok(signatureIdx >= 0, 'top badge must include exact V1.42 G0c signature');
      assert.ok(
        signatureIdx > markerIdx,
        'top badge V1.42 signature must appear after V1.42 historical base marker',
      );
    }
    assert.ok(
      badge.includes('G0c real-LAN evidence absent'),
      'top badge must state G0c real-LAN evidence absent',
    );
    assert.ok(
      /auto harness complete|automatic harness/i.test(badge),
      'top badge must mention auto harness',
    );
    assert.ok(
      !/G0c real-LAN complete/i.test(badge),
      'top badge must not claim G0c real-LAN complete',
    );
    assert.ok(
      /G0c|endpoint-pull|local multi-process|same-dataDir local multi-process/i.test(badge),
      'top badge must claim G0c delivery or retained multi-process lock base',
    );
    assert.ok(
      !badge.includes(STALE_CURRENT_MULTI_PROCESS_DENY),
      'top badge must not keep stale standalone "not multi-process exclusive lock"',
    );
    assert.ok(
      !badge.includes(STALE_SINGLE_PROCESS_QUEUE_ONLY),
      'top badge must not keep stale "single-process queue only"',
    );
    assert.ok(
      !badge.includes(STALE_MULTI_PROCESS_YET),
      'top badge must not keep remaining "not multi-process exclusive lock yet"',
    );
    // V1.40 historical process-lock base retained
    assert.ok(
      badge.includes(V140_SIGNATURE) || badge.includes('V1.40 historical base'),
      'top badge must retain V1.40 historical base',
    );
    // V1.39 historical write-admission base retained
    {
      const markerIdx = badge.indexOf('V1.39 historical base');
      const signatureIdx = badge.indexOf(V139_SIGNATURE);
      assert.ok(markerIdx >= 0, 'top badge must include V1.39 historical base marker');
      assert.ok(signatureIdx >= 0, 'top badge must include exact V1.39 write-admission signature');
      assert.ok(
        signatureIdx > markerIdx,
        'top badge V1.39 signature must appear after V1.39 historical base marker',
      );
    }
    // V1.38 signature may also appear after a historical-base marker
    {
      const markerIdx = badge.indexOf('V1.38 historical base');
      const signatureIdx = badge.indexOf(V138_SIGNATURE);
      if (markerIdx >= 0) {
        assert.ok(signatureIdx > markerIdx, 'top badge V1.38 signature after historical marker when present');
      }
    }
    assert.ok(
      /not managed scheduler|no managed scheduler|not.*scheduler/i.test(badge),
      'top badge no managed scheduler',
    );
    assert.ok(
      /not remote notification|no remote notification|Not remote notification delivery/i.test(badge),
      'top badge no remote notification delivery',
    );
    assert.ok(
      /not production monitoring ready|no production monitoring ready/i.test(badge),
      'top badge not production monitoring ready',
    );
    assert.ok(/T6d\.3 still partial/i.test(badge), 'top badge T6d.3 still partial');
    assert.ok(/not T6d\.3 complete|Not T6d\.3 complete|not.*T6d\.3 complete/i.test(badge), 'top badge not T6d.3 complete');
    assert.ok(/不是 M6d Exit|not M6d Exit|≠ M6d Exit|非 M6d Exit/i.test(badge), 'top badge not M6d Exit');
    assert.ok(/production-hardening 仍 partial|production-hardening remains partial|production-hardening partial/i.test(badge), 'top badge production-hardening partial');
    // Exact independent negative on badge itself (must not rely on version table)
    assert.ok(
      badge.includes('not production-hardening ready'),
      'current badge must include exact "not production-hardening ready"',
    );
    assert.ok(/M1 route open|M1.*open/i.test(badge), 'top badge M1 route open');
    assert.ok(/M2 denied|M2.*denied/i.test(badge), 'top badge M2 denied');
    assert.ok(/realCapabilityImplementationsReady:false/.test(badge), 'top badge global real false');
    assert.ok(/realAttemptAuditImplementationReady:false/.test(badge), 'top badge realAttemptAudit false');
    assert.ok(/executeCapabilityAuthorized:false/.test(badge), 'top badge execute false');
    assert.ok(/realRunnerWiringReady:false/.test(badge), 'top badge real wiring false');
    assert.ok(/runnerWiringContractReady:false/.test(badge), 'top badge runnerWiringContract false');
    assert.ok(/executionEligible:false/.test(badge), 'top badge executionEligible false');
    assert.ok(
      /not end-to-end production audit delivery|no end-to-end production audit delivery/i.test(badge)
        && badge.includes(POST_OUTCOME_STILL_BEST_EFFORT),
      'top badge not e2e production audit delivery with post-outcome still best-effort',
    );
    assert.ok(
      /not state continuity under adversarial state deletion|no state continuity under adversarial state deletion/i.test(badge)
        && /re-bootstrap|rebootstrap|limitation/i.test(badge),
      'top badge not state continuity under adversarial state deletion',
    );
    assert.ok(
      /not authenticity|no authenticity|no external authenticity|no external trusted anchor|no external anchor|HMAC|signature/i.test(badge),
      'top badge not authenticity / external anchor / HMAC / signature',
    );
    assert.ok(
      /not HTTP\/Web monitor|no HTTP\/Web monitor|not HTTP|not Web monitor/i.test(badge),
      'top badge not HTTP/Web monitor',
    );
    assert.ok(/Gold remains partial 6\/3\/0\/9|6 ready[\s\S]*3 partial[\s\S]*0 blocked/i.test(badge), 'badge Gold remains partial 6/3/0/9 honesty');
    assert.doesNotMatch(badge, /(?<!not )\bWORM\b|audit chain integrity complete|Gold ready|M6d Exit complete/i, 'badge must not overclaim M6d/Gold/WORM');
    assert.doesNotMatch(badge, /(?<!not\s)(?<!Not\s)T6d\.3 complete/i, 'badge must not claim T6d.3 complete');
    assert.doesNotMatch(badge, /(?<!not\s)(?<!Not\s)production monitoring ready(?!\s*yet)/i, 'badge must not claim production monitoring ready');
    // Forbidden compound assembled at runtime
    const forbiddenCompound = ['tamper', 'evident'].join('-');
    assert.equal(badge.includes(forbiddenCompound), false, 'top badge must not embed forbidden tamper compound');
    // Helper canary: missing start / duplicate start must assert-fail
    assert.throws(
      () => extractCurrentBadgeBlockquote('no badge here'),
      (err) => err instanceof assert.AssertionError,
      'helper canary: missing badge start must fail',
    );
    const dupMarker = `> **当前版本：${LINKE_RELEASE_VERSION}**`;
    assert.throws(
      () => extractCurrentBadgeBlockquote(`${dupMarker} a\n${dupMarker} b\n`),
      (err) => err instanceof assert.AssertionError,
      'helper canary: duplicate badge start must fail',
    );
  });

  it('documents Concurrency / Audit integrity lockf local multi-process serialization boundaries', () => {
    assert.ok(
      /lockf|\/usr\/bin\/lockf/i.test(readme),
      'README must document lockf',
    );
    assert.ok(
      /local multi-process|same-dataDir|多进程.*序列|序列化/i.test(readme),
      'README must document local multi-process serialization',
    );
    assert.ok(
      /not distributed|no distributed|不是 distributed|非 distributed|跨主机|cross-host|distributed/i.test(readme),
      'README must bound distributed / cross-host',
    );
    assert.ok(
      /network FS|network-FS|网络文件系统|NFS/i.test(readme),
      'README must mention network FS boundary',
    );
    // V1.40 concurrency surface must disclose release/close failure ops boundary
    const concurrencySurfaces = [];
    for (const line of readme.split('\n')) {
      if (
        /Concurrency\s*\/\s*Audit integrity/i.test(line)
        && /V1\.40/i.test(line)
      ) {
        concurrencySurfaces.push(line);
      }
    }
    assert.ok(
      concurrencySurfaces.length >= 1,
      'README must have at least one Concurrency / Audit integrity V1.40 surface line',
    );
    const concurrencyJoined = concurrencySurfaces.join('\n');
    assert.ok(
      concurrencyJoined.includes(RELEASE_CLOSE_FAIL_CLOSES),
      'Concurrency V1.40 surface must include "release/close failure fail-closes"',
    );
    assert.ok(
      concurrencyJoined.includes(TASK_MUTATION_MAY_ALREADY_APPLIED),
      'Concurrency V1.40 surface must include "task mutation may already be applied"',
    );
    assert.ok(
      concurrencyJoined.includes(CALLER_RETRY_NO_IDEMPOTENT_EXACTLY_ONCE),
      'Concurrency V1.40 surface must include "caller retry has no idempotent/exactly-once guarantee"',
    );
    assert.ok(
      concurrencyJoined.includes(NO_DETERMINISTIC_IN_BAND_FD_RECLAIM),
      'Concurrency V1.40 surface must include "no deterministic in-band fd reclaim before process exit"',
    );
    {
      const concLower = concurrencyJoined.toLowerCase();
      for (const phrase of FORBIDDEN_ABSOLUTE_V140_PHRASES) {
        assert.ok(
          !concLower.includes(phrase.toLowerCase()),
          `Concurrency V1.40 surface must not claim absolute "${phrase}"`,
        );
      }
    }
  });

  it('version table marks V1.46 current, V1.45 historical NAS, V1.44 historical real NAS acceptance, V1.43 historical rotation, V1.42 historical G0c, V1.41 historical G0b, V1.40 historical process-lock, V1.39 historical write-admission, V1.38 historical monitor, keeps V1.37/V1.36/V1.35', () => {
    // V1.46 current row — LaunchAgent code-stage closure PASS signature and fixed honesty phrases
    const v146RowMatch = readme.match(/\| V1\.46 \| 当前版本 \|[^|\n]*/);
    assert.ok(v146RowMatch, 'V1.46 current version table row must exist');
    assert.ok(
      v146RowMatch[0].includes(V146_SIGNATURE),
      'V1.46 current table row must include exact V1.46 user-level LaunchAgent lifecycle code-stage closure PASS signature',
    );
    assert.ok(
      v146RowMatch[0].includes('nas-dry-run ready'),
      'V1.46 current table row must state nas-dry-run ready',
    );
    assert.ok(
      v146RowMatch[0].includes('real-nas-remote-backup ready'),
      'V1.46 current table row must state real-nas-remote-backup ready',
    );
    assert.ok(
      v146RowMatch[0].includes('configuration-only ready'),
      'V1.46 current table row must state configuration-only ready',
    );
    assert.ok(
      v146RowMatch[0].includes('runtime mount verification pending'),
      'V1.46 current table row must state runtime mount verification pending',
    );
    assert.ok(
      v146RowMatch[0].includes('executionAuthorized:false'),
      'V1.46 current table row must include executionAuthorized:false',
    );
    assert.ok(
      v146RowMatch[0].includes('wouldConnect:false'),
      'V1.46 current table row must include wouldConnect:false',
    );
    assert.ok(
      v146RowMatch[0].includes('wouldWrite:false'),
      'V1.46 current table row must include wouldWrite:false',
    );
    assert.ok(
      v146RowMatch[0].includes('not Gold'),
      'V1.46 current table row must include not Gold',
    );
    assert.ok(
      v146RowMatch[0].includes('Gold remains partial 6/3/0/9'),
      'V1.46 current table row must include exact Gold remains partial 6/3/0/9',
    );
    assert.ok(
      v146RowMatch[0].includes('three partial items remain'),
      'V1.46 current table row must state three partial items remain',
    );
    assert.ok(
      !v146RowMatch[0].includes('Gold remains partial 5/4/0/9'),
      'V1.46 current table row must not keep stale Gold remains partial 5/4/0/9 (V1.44 historical count)',
    );
    assert.ok(
      !v146RowMatch[0].includes('four partial items remain'),
      'V1.46 current table row must not keep stale four partial items remain (V1.44 historical count)',
    );
    assert.ok(
      !/\bGold\/GA\b|Gold ready|GA ready|production-ready/i.test(v146RowMatch[0]),
      'V1.46 current table row must not claim Gold/GA/production-ready',
    );
    for (const phrase of [
      'no real launchctl',
      'no clean-Mac lifecycle evidence',
      'not installation complete',
      'code-stage only',
      'conditional fake host adapters',
      'real Node owner SIGKILL/recovery child',
    ]) {
      assert.ok(
        v146RowMatch[0].includes(phrase),
        `V1.46 current table row must include LaunchAgent boundary phrase: ${phrase}`,
      );
    }
    assertReadmeContains(
      /\| V1\.46 \| 当前版本 \|[^|]*(V1\.46 user-level LaunchAgent lifecycle code-stage closure PASS)[^|]*(no real launchctl)[^|]*(not installation complete)[^|]*(Gold remains partial 6\/3\/0\/9)/i,
      'V1.46 should be current LaunchAgent code-stage closure milestone',
    );
    const v145RowMatch = readme.match(/\| V1\.45 \| 历史版本 \|[^|\n]*/);
    assert.ok(v145RowMatch, 'V1.45 historical version table row must exist');
    assert.ok(
      v145RowMatch[0].includes(V145_SIGNATURE),
      'V1.45 historical table row must retain exact V1.45 NAS dry-run configuration-readiness PASS signature',
    );
    assert.ok(
      v145RowMatch[0].includes('nas-dry-run ready'),
      'V1.45 historical table row must retain nas-dry-run ready',
    );
    assert.ok(
      v145RowMatch[0].includes('configuration-only ready'),
      'V1.45 historical table row must retain configuration-only ready',
    );
    assert.ok(
      v145RowMatch[0].includes('real-nas-remote-backup ready'),
      'V1.45 historical table row must retain real-nas-remote-backup ready',
    );
    assert.ok(
      v145RowMatch[0].includes('Gold remains partial 6/3/0/9'),
      'V1.45 historical table row must retain Gold remains partial 6/3/0/9',
    );
    assertReadmeDoesNotContain(/\| V1\.45 \| 当前版本 \|/i, 'V1.45 must not remain marked as current');
    // V1.45 historical row must immediately follow the V1.46 current row in the table.
    {
      const tableLines = readme.split('\n');
      const currentIdx = tableLines.findIndex((line) => /\| V1\.46 \| 当前版本 \|/.test(line));
      assert.ok(currentIdx >= 0, 'V1.46 current table row index must exist');
      const nextVersionRow = tableLines
        .slice(currentIdx + 1)
        .find((line) => /^\s*\| V\d/.test(line));
      assert.ok(
        nextVersionRow !== undefined && /\| V1\.45 \| 历史版本 \|/.test(nextVersionRow),
        'V1.45 historical row must immediately follow the V1.46 current row',
      );
    }
    // V1.44 historical row — retain real NAS acceptance receipt facts; must not remain 当前版本.
    const v144RowMatch = readme.match(/\| V1\.44 \| 历史版本 \|[^|\n]*/);
    assert.ok(v144RowMatch, 'V1.44 historical version table row must exist');
    assert.ok(
      v144RowMatch[0].includes(V144_SIGNATURE),
      'V1.44 historical table row must retain exact V1.44 real NAS acceptance PASS signature',
    );
    assert.ok(
      v144RowMatch[0].includes('NAS-REAL-V144-20260727-01'),
      'V1.44 historical table row must retain acceptance ID NAS-REAL-V144-20260727-01',
    );
    assert.ok(
      v144RowMatch[0].includes('docs/superpowers/reports/2026-07-27-v144-real-nas-acceptance.json'),
      'V1.44 historical table row must retain committed JSON acceptance report path',
    );
    assert.ok(
      v144RowMatch[0].includes('docs/superpowers/reports/2026-07-27-v144-real-nas-acceptance.md'),
      'V1.44 historical table row must retain committed Markdown acceptance report path',
    );
    assert.ok(
      v144RowMatch[0].includes('Gold remains partial 5/4/0/9'),
      'V1.44 historical table row must retain Gold remains partial 5/4/0/9',
    );
    assertReadmeDoesNotContain(/\| V1\.44 \| 当前版本 \|/i, 'V1.44 must not remain marked as current');
    // V1.43 historical row — retain rotation foundation facts; must not remain 当前版本
    const v143RowMatch = readme.match(/\| V1\.43 \| 历史版本 \|[^|\n]*/);
    assert.ok(v143RowMatch, 'V1.43 historical version table row must exist');
    assert.ok(
      v143RowMatch[0].includes(V143_SIGNATURE),
      'V1.43 historical table row must include exact V1.43 signature',
    );
    assert.ok(
      v143RowMatch[0].includes('explicit manual rotation delivered'),
      'V1.43 historical table row must state explicit manual rotation delivered',
    );
    assert.ok(
      /no automatic rotation/i.test(v143RowMatch[0]),
      'V1.43 historical table row must deny automatic rotation',
    );
    assert.ok(
      /no automatic scheduling/i.test(v143RowMatch[0]),
      'V1.43 historical table row must deny automatic scheduling',
    );
    assert.ok(
      /not managed scheduler/i.test(v143RowMatch[0]),
      'V1.43 historical table row must deny managed scheduler',
    );
    assert.ok(
      /not remote notification delivery/i.test(v143RowMatch[0]),
      'V1.43 historical table row must deny remote notification delivery',
    );
    assert.ok(
      /append-only/i.test(v143RowMatch[0]),
      'V1.43 historical table row must state archive policy append-only',
    );
    assert.ok(
      /not WORM/i.test(v143RowMatch[0]),
      'V1.43 historical table row must deny WORM',
    );
    assert.ok(
      /no external authenticity/i.test(v143RowMatch[0]),
      'V1.43 historical table row must deny external authenticity',
    );
    assert.ok(
      v143RowMatch[0].includes('not production-hardening ready'),
      'V1.43 historical table row must include not production-hardening ready',
    );
    assert.ok(
      v143RowMatch[0].includes('Gold remains blocked 4/4/1/9'),
      'V1.43 historical table row must include Gold remains blocked 4/4/1/9',
    );
    assert.ok(
      v143RowMatch[0].includes('G0c real-LAN evidence absent'),
      'V1.43 historical table row must include G0c real-LAN evidence absent',
    );
    assert.ok(
      !/no journal rotation/i.test(v143RowMatch[0]),
      'V1.43 historical table row must not keep stale "no journal rotation"',
    );
    assertReadmeDoesNotContain(/\| V1\.43 \| 当前版本 \|/i, 'V1.43 must not remain marked as current');
    assertReadmeContains(
      /\| V1\.43 \| 历史版本 \|[^|]*(explicit crash-recoverable audit integrity rotation foundation)[^|]*(explicit manual rotation delivered|no automatic rotation)/i,
      'V1.43 should be historical audit integrity rotation milestone',
    );
    // V1.42 historical row — retain exact G0c signature and auto-harness/real-LAN facts
    const v142HistMatch = readme.match(/\| V1\.42 \| 历史版本 \|[^|\n]*/);
    assert.ok(v142HistMatch, 'V1.42 historical version table row must exist');
    assert.ok(
      v142HistMatch[0].includes(V142_SIGNATURE),
      'V1.42 historical table row must retain exact V1.42 G0c signature',
    );
    assert.ok(
      /auto harness complete (does not equal|is not) real-LAN complete/i.test(v142HistMatch[0]),
      'V1.42 historical table row must retain auto harness ≠ real-LAN facts',
    );
    assert.ok(
      v142HistMatch[0].includes('G0c real-LAN evidence absent')
        || v142HistMatch[0].includes('real-LAN evidence absent'),
      'V1.42 historical table row must retain G0c real-LAN evidence absent',
    );
    assert.ok(
      /G0c real-LAN remains incomplete/i.test(v142HistMatch[0]),
      'V1.42 historical table row must retain G0c real-LAN remains incomplete',
    );
    assert.ok(
      v142HistMatch[0].includes('no real-LAN PASS report'),
      'V1.42 historical table row must retain no real-LAN PASS report',
    );
    assertReadmeDoesNotContain(/\| V1\.42 \| 当前版本 \|/i, 'V1.42 must not remain marked as current');
    // V1.41 historical row — retain G0b signature
    const v141HistMatch = readme.match(/\| V1\.41 \| 历史版本 \|[^|\n]*/);
    assert.ok(v141HistMatch, 'V1.41 historical version table row must exist');
    assert.ok(
      v141HistMatch[0].includes(V141_SIGNATURE),
      'V1.41 historical table row must retain exact V1.41 G0b signature',
    );
    // V1.40 historical row — retain process-lock signature/facts
    const v140HistMatch = readme.match(/\| V1\.40 \| 历史版本 \|[^|\n]*/);
    assert.ok(v140HistMatch, 'V1.40 historical version table row must exist');
    assert.ok(
      v140HistMatch[0].includes(V140_SIGNATURE),
      'V1.40 historical table row must retain exact V1.40 process-lock signature',
    );
    // V1.39 historical row — retain write-admission signature/facts (must not remain 当前版本)
    const v139RowMatch = readme.match(/\| V1\.39 \| 历史版本 \|[^|\n]*/);
    assert.ok(v139RowMatch, 'V1.39 historical version table row must exist');
    assert.ok(
      v139RowMatch[0].includes(V139_SIGNATURE),
      'V1.39 historical table row must retain exact V1.39 write-admission signature',
    );
    assert.ok(
      /write-admission|pre-side-effect|recordRequiredWriteAdmissionAudit|recordRequiredNasReplicationStartAudit|audit-delivery-unavailable/i.test(v139RowMatch[0]),
      'V1.39 historical table row must retain write-admission facts',
    );
    assertReadmeContains(
      /\| V1\.39 \| 历史版本 \|[^|]*(safety-critical audit write-admission fail-closed|pre-side-effect admission required|recordRequiredWriteAdmissionAudit|recordRequiredNasReplicationStartAudit)[^|]*(post-outcome recordAudit \/ appendNasReplicationAudit still best-effort|not end-to-end production audit delivery|T6d\.3 still partial|not production-hardening ready|Gold remains blocked)/i,
      'V1.39 should be historical write-admission fail-closed milestone',
    );
    // V1.38 historical row — lock monitor facts (must not remain 当前版本)
    const v138RowMatch = readme.match(/\| V1\.38 \| 历史版本 \|[^|\n]*/);
    assert.ok(v138RowMatch, 'V1.38 historical version table row must exist');
    assert.ok(
      v138RowMatch[0].includes(V138_SIGNATURE),
      'V1.38 historical table row must retain exact V1.38 monitor signature',
    );
    assert.ok(
      /T6d\.4 minimum viable run-once path delivered|audit-integrity-monitor|local run-once/i.test(v138RowMatch[0]),
      'V1.38 historical table row must retain T6d.4 / monitor base facts',
    );
    assertReadmeContains(
      /\| V1\.38 \| 历史版本 \|[^|]*(read-only audit integrity run-once monitor\/alert|audit-integrity-monitor|local run-once|exit 0\/2\/1|no write\/repair\/recover)[^|]*(Not T6d\.3 complete|not M6d Exit|not production-hardening ready|not production monitoring ready|T6d\.4)[^|]*(Gold remains blocked|4 ready)/i,
      'V1.38 should be historical read-only audit integrity run-once monitor/alert milestone',
    );
    // V1.37 historical row — lock dual-write coordinator facts (must not remain 当前版本)
    const v137RowMatch = readme.match(/\| V1\.37 \| 历史版本 \|[^|\n]*/);
    assert.ok(v137RowMatch, 'V1.37 historical version table row must exist');
    assert.ok(
      /journal-first|dual-write coordinator|audit-integrity-dual-write|appendAuditEventWithIntegrityDualWrite|recoverAuditIntegrityDualWrite/i.test(v137RowMatch[0]),
      'V1.37 historical table row must retain dual-write coordinator facts',
    );
    assertReadmeContains(
      /\| V1\.37 \| 历史版本 \|[^|]*(journal-first|dual-write coordinator|audit-integrity-dual-write|appendAuditEventWithIntegrityDualWrite|single-slot|single-process)[^|]*(T6d\.3 still partial|T6d\.3 partial only|not T6d\.3 complete|not M6d Exit|not production-hardening ready)[^|]*Gold 依旧 blocked/i,
      'V1.37 should be historical journal-first dual-write coordinator milestone',
    );
    // V1.36 historical row — lock cross-store verifier facts (must not remain 当前版本)
    const v136RowMatch = readme.match(/\| V1\.36 \| 历史版本 \|[^|\n]*/);
    assert.ok(v136RowMatch, 'V1.36 historical version table row must exist');
    assert.ok(
      /cross-store|verifyAuditIntegrityAgainstEventStore|audit-integrity-cross-store|structural consistency verifier/i.test(v136RowMatch[0]),
      'V1.36 historical table row must retain cross-store verifier facts',
    );
    assertReadmeContains(
      /\| V1\.36 \| 历史版本 \|[^|]*(cross-store|verifyAuditIntegrityAgainstEventStore|audit-integrity-cross-store|structural consistency verifier)[^|]*(T6d\.3 still partial|partial foundation only|not dual-write|not M6d Exit|not production)[^|]*Gold 依旧 blocked/i,
      'V1.36 should be historical cross-store structural consistency verifier milestone',
    );
    assertReadmeContains(
      /\| V1\.35 \| 历史版本 \|[^|]*(integrity-journal|unkeyed hash-chain structural consistency|无密钥哈希链结构一致性基座|T6d\.3 partial)[^|]*(not dual-write|not M6d Exit|not production integration|partial foundation only)[^|]*Gold 依旧 blocked/i,
      'V1.35 should remain historical unkeyed journal foundation milestone',
    );
    assertReadmeContains(
      /\| V1\.34 \| 历史版本 \|[^|]*(real audit|RealAudit|capability-proof-attempts|M6d-prep)[^|]*realAuditCapabilityImplementationReady:true[^|]*realCapabilityImplementationsReady:false[^|]*(3\/7|realAttemptAuditImplementationReady:false)[^|]*(executeCapabilityAuthorized:false|realRunnerWiringReady:false|executionEligible:false)[^|]*Gold 依旧 blocked/i,
      'V1.34 should remain historical third real audit M6d-prep milestone',
    );
    assertReadmeContains(/\| V1\.33 \| 历史版本 \|[^|]*real status[^|]*realStatusCapabilityImplementationReady:true[^|]*PROOF ONLY[^|]*capability-real-status-completed[^|]*hard-deny[^|]*realCapabilityImplementationsReady:false[^|]*realRunnerWiringReady:false[^|]*executionEligible:false[^|]*Gold 依旧 blocked/i, 'V1.33 should remain historical second real status milestone');
    assertReadmeContains(/\| V1\.32 \| 历史版本 \|[^|]*real render[^|]*realRenderCapabilityImplementationReady:true[^|]*capability-real-implementation-receipt[^|]*PROOF ONLY[^|]*execute[^|]*hard-deny[^|]*realCapabilityImplementationsReady:false[^|]*realRunnerWiringReady:false[^|]*executionEligible:false[^|]*Gold 依旧 blocked/i, 'V1.32 should remain historical first real render milestone');
    assertReadmeContains(/\| V1\.31 \| 历史版本 \|[^|]*capability injection[^|]*CapabilityInjection[^|]*executeCapabilityAuthorized:false[^|]*realCapabilityImplementationsReady:false[^|]*realRunnerWiringReady:false[^|]*executionEligible:false[^|]*readyCount:6[^|]*blockedCount:0[^|]*real-guarded-runner-execution-wiring-missing[^|]*Gold 依旧 blocked/i, 'V1.31 should become historical capability injection milestone');
    assertReadmeContains(/\| V1\.30 \| 历史版本 \|[^|]*buildSupervisorLifecycleGuardedRunnerRealWiringPlan/i, 'V1.30 should become historical real-wiring orchestrator milestone');
    assertReadmeContains(/\| V1\.29 \| 历史版本 \|[^|]*resolveSupervisorLifecycleGuardedRunnerOperatorRecovery[^|]*operatorRecoveryReadiness\.state:ready[^|]*operatorRecoveryReady:true[^|]*codeOwnedRecoveryResolverReady:true[^|]*realOperatorRecoveryImplementationReady:false[^|]*readyCount:6[^|]*blockedCount:0[^|]*recoveryDecision[^|]*executionEligible:false[^|]*Gold 依旧 blocked/i, 'V1.29 should become historical operator recovery milestone');
    assertReadmeContains(/\| V1\.28 \| 历史版本 \|[^|]*resolveSupervisorLifecycleGuardedRunnerAttemptAudit[^|]*attemptAuditReadiness\.state:ready[^|]*attemptAuditReady:true[^|]*codeOwnedAuditResolverReady:true[^|]*realAttemptAuditImplementationReady:false[^|]*readyCount:5[^|]*blockedCount:1[^|]*auditDecision[^|]*executionEligible:false[^|]*Gold 依旧 blocked/i, 'V1.28 should become historical attempt audit milestone');
    assertReadmeContains(/\| V1\.27 \| 历史版本 \|[^|]*resolveSupervisorLifecycleGuardedRunnerRollbackAnchor[^|]*rollbackAnchorReadiness\.state:ready[^|]*rollbackAnchorReady:true[^|]*codeOwnedAnchorResolverReady:true[^|]*realRollbackAnchorImplementationReady:false[^|]*readyCount:4[^|]*blockedCount:2[^|]*anchorDecision[^|]*executionEligible:false[^|]*Gold 依旧 blocked/i, 'V1.27 should become historical rollback anchor milestone');
    assertReadmeContains(/\| V1\.26 \| 历史版本 \|[^|]*resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter[^|]*hostMutationAdapterReadiness\.state:ready[^|]*hostMutationAdapterReady:true[^|]*codeOwnedAdapterResolverReady:true[^|]*realHostMutationImplementationReady:false[^|]*readyCount:3[^|]*blockedCount:3[^|]*adapterDecision[^|]*executionEligible:false[^|]*Gold 依旧 blocked/i, 'V1.26 should become historical host mutation adapter milestone');
    assertReadmeContains(/\| V1\.25 \| 历史版本 \|[^|]*resolveSupervisorLifecycleGuardedRunnerRegistry[^|]*runnerRegistryReadiness\.state:ready[^|]*runnerRegistryReady:true[^|]*codeOwnedRegistryResolverReady:true[^|]*realRunnerImplementationsReady:false[^|]*readyCount:2[^|]*blockedCount:4[^|]*registryDecision[^|]*executionEligible:false[^|]*Gold 依旧 blocked/i, 'V1.25 should become historical real runner registry milestone');
    assertReadmeContains(/\| V1\.24 \| 历史版本 \|[^|]*evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy[^|]*areSupervisorLifecycleGuardedRunnerActionCandidatesReady[^|]*executionPolicyReadiness\.state:ready[^|]*executionPolicyReady:true[^|]*fail-closed-execution-policy[^|]*policyDecision[^|]*executionEligible:false[^|]*Gold 依旧 blocked/i, 'V1.24 should become historical fail-closed execution policy milestone');
    assertReadmeContains(/\| V1\.23 \| 历史版本 \|[^|]*buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness[^|]*executionPolicyReadiness\.state:blocked[^|]*executionPolicyReady:false[^|]*execution-policy-real-implementation-missing[^|]*Gold 依旧 blocked/i, 'V1.23 should become historical disabled execution policy readiness milestone');
    assertReadmeContains(/\| V1\.22 \| 历史版本 \|[^|]*buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness[^|]*operatorRecoveryReadiness\.state:blocked[^|]*operatorRecoveryReady:false[^|]*operator-recovery-real-implementation-missing[^|]*Gold 依旧 blocked/i, 'V1.22 should become historical disabled operator recovery readiness milestone');
    assertReadmeContains(/\| V1\.21 \| 历史版本 \|[^|]*buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness[^|]*attemptAuditReadiness\.state:blocked[^|]*attemptAuditReady:false[^|]*attempt-audit-real-implementation-missing[^|]*Gold 依旧 blocked/i, 'V1.21 should become historical disabled attempt audit readiness milestone');
    assertReadmeContains(/\| V1\.20 \| 历史版本 \|[^|]*buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness[^|]*rollbackAnchorReadiness\.state:blocked[^|]*rollbackAnchorReady:false[^|]*rollback-anchor-real-implementation-missing[^|]*Gold 依旧 blocked/i, 'V1.20 should become historical disabled rollback anchor readiness milestone');
    assertReadmeContains(/\| V1\.19 \| 历史版本 \|[^|]*buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness[^|]*hostMutationAdapterReadiness\.state:blocked[^|]*hostMutationAdapterReady:false[^|]*host-mutation-adapter-real-implementation-missing[^|]*Gold 依旧 blocked/i, 'V1.19 should become historical disabled host mutation adapter readiness milestone');
    assertReadmeContains(/\| V1\.18 \| 历史版本 \|[^|]*buildSupervisorLifecycleGuardedRunnerRegistryReadiness[^|]*runnerRegistryReadiness\.state:blocked[^|]*runnerRegistryReady:false[^|]*runner-registry-real-implementation-missing[^|]*Gold 依旧 blocked/i, 'V1.18 should become historical disabled runner registry readiness milestone');
    assertReadmeContains(/\| V1\.17 \| 历史版本 \|[^|]*buildSupervisorLifecycleGuardedRunnerWiringContract[^|]*runnerWiringContract[^|]*runnerWiringContractReady:false[^|]*requiredContracts[^|]*real-guarded-runner-execution-wiring-missing/i, 'V1.17 should become historical guarded runner wiring contract milestone');
    assertReadmeContains(/\| V1\.16 \| 历史版本 \|[^|]*supervisor-lifecycle-guarded-runner-execution-gate-button[^|]*buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel[^|]*POST \/api\/supervisor-lifecycle-guarded-runner-execution-gate[^|]*executeRequested:true[^|]*executionEligible:false[^|]*wouldExecute:false[^|]*realRunnerWiringReady:false[^|]*test\/web-console\.test\.js supervisor lifecycle guarded runner execution gate/i, 'V1.16 should become historical guarded runner execution gate Web milestone');
    assertReadmeContains(/\| V1\.15 \| 历史版本 \|[^|]*POST \/api\/supervisor-lifecycle-guarded-runner-execution-gate[^|]*inline[^|]*executeRequested[^|]*server-owned `?dataDir`?[^|]*API_WRITE_ROUTES[^|]*read token[^|]*test\/supervisor-lifecycle-guarded-runner-execution-gate-api\.test\.js[^|]*executionEligible:false[^|]*executeRequested:true[^|]*realRunnerWiringReady:false[^|]*real-guarded-runner-execution-wiring-missing/i, 'V1.15 should become historical guarded runner execution gate API milestone');
    assertReadmeContains(/\| V1\.14 \| 历史版本 \|[^|]*agent\.js supervisor-lifecycle-guarded-runner-execution-gate[^|]*--data-dir <path>[^|]*--execute-requested[^|]*--fail-on-blocked[^|]*test\/agent-supervisor-lifecycle-guarded-runner-execution-gate\.test\.js[^|]*executionEligible:false[^|]*execute-request-missing[^|]*realRunnerWiringReady:false[^|]*real-guarded-runner-execution-wiring-missing/i, 'V1.14 should become historical guarded runner execution gate CLI milestone');
    assertReadmeContains(/\| V1\.13 \| 历史版本 \|[^|]*buildSupervisorLifecycleGuardedRunnerExecutionGate[^|]*test\/supervisor-lifecycle-guarded-runner-execution-gate\.test\.js[^|]*executionEligible:false[^|]*execute-request-missing[^|]*realRunnerWiringReady:false[^|]*real-guarded-runner-execution-wiring-missing/i, 'V1.13 should become historical pure guarded runner execution gate milestone');
    assertReadmeContains(/\| V1\.12 \| 历史版本 \|[^|]*supervisor-lifecycle-guarded-runner-execution-preview-button[^|]*buildSupervisorLifecycleGuardedRunnerExecutionPreviewViewModel[^|]*POST \/api\/supervisor-lifecycle-guarded-runner-execution-preview[^|]*executionReady:false[^|]*wouldExecute:false[^|]*test\/web-console\.test\.js supervisor lifecycle guarded runner execution preview/i, 'V1.12 should become historical guarded runner execution preview Web milestone');
    assertReadmeContains(/\| V1\.11 \| 历史版本 \|[^|]*POST \/api\/supervisor-lifecycle-guarded-runner-execution-preview[^|]*API_WRITE_ROUTES[^|]*read token[^|]*executionReady:false[^|]*wouldExecute:false[^|]*test\/supervisor-lifecycle-guarded-runner-execution-preview-api\.test\.js/i, 'V1.11 should become historical guarded runner execution preview API milestone');
    assertReadmeContains(/\| V1\.10 \| 历史版本 \|[^|]*agent\.js supervisor-lifecycle-guarded-runner-execution-preview[^|]*test\/agent-supervisor-lifecycle-guarded-runner-execution-preview\.test\.js/i, 'V1.10 should become historical CLI milestone');
    assertReadmeContains(/\| V1\.09 \| 历史版本 \|[^|]*supervisor lifecycle guarded runner execution preview[^|]*buildSupervisorLifecycleGuardedRunnerExecutionPreview[^|]*executionReady:false[^|]*executorReady:false[^|]*wouldExecute:false[^|]*wouldRun:false[^|]*wouldWrite:false[^|]*guarded-runner-execution-preview-only[^|]*real-guarded-runner-execution-wiring-missing[^|]*test\/supervisor-lifecycle-guarded-runner-execution-preview\.test\.js/i, 'V1.09 should become historical pure guarded runner execution preview milestone');
    assertReadmeContains(/\| V1\.08 \| 历史版本 \|[^|]*supervisor-lifecycle-guarded-runner-readiness-button[^|]*buildSupervisorLifecycleGuardedRunnerReadinessViewModel[^|]*POST \/api\/supervisor-lifecycle-guarded-runner-readiness[^|]*inline[^|]*runnerBinding[^|]*executorReady:false[^|]*guarded-runner-execution-disabled[^|]*wouldRun:false[^|]*wouldWrite:false[^|]*test\/web-console\.test\.js supervisor lifecycle guarded runner readiness/i, 'V1.08 should become historical supervisor lifecycle guarded runner readiness Web milestone');
    assertReadmeContains(/\| V1\.07 \| 历史版本 \|[^|]*POST \/api\/supervisor-lifecycle-guarded-runner-readiness[^|]*inline[^|]*runnerBinding[^|]*API_WRITE_ROUTES[^|]*read token[^|]*executorReady:false[^|]*guarded-runner-execution-disabled[^|]*wouldRun:false[^|]*wouldWrite:false[^|]*test\/supervisor-lifecycle-guarded-runner-readiness-api\.test\.js/i, 'V1.07 should become historical supervisor lifecycle guarded runner readiness API milestone');
    assertReadmeContains(/\| V1\.06 \| 历史版本 \|[^|]*agent\.js supervisor-lifecycle-guarded-runner-readiness[^|]*--runner-binding <path>[^|]*--fail-on-blocked[^|]*executorReady:false[^|]*guarded-runner-execution-disabled[^|]*wouldRun:false[^|]*wouldWrite:false[^|]*test\/agent-supervisor-lifecycle-guarded-runner-readiness\.test\.js/i, 'V1.06 should become historical supervisor lifecycle guarded runner readiness CLI milestone');
    assertReadmeContains(/\| V1\.05 \| 历史版本 \|[^|]*buildSupervisorLifecycleGuardedRunnerReadiness[^|]*supervisor-lifecycle-guarded-runner-binding[^|]*runnerBindingsReady:true[^|]*executorReady:false[^|]*guarded-runner-execution-disabled[^|]*wouldRun:false[^|]*wouldWrite:false[^|]*test\/supervisor-lifecycle-guarded-runner-readiness\.test\.js/i, 'V1.05 should become historical supervisor lifecycle guarded runner readiness milestone');
    assertReadmeContains(/\| V1\.04 \| 历史版本 \|[^|]*supervisor-lifecycle-executor-manifest-readiness-button[^|]*POST \/api\/supervisor-lifecycle-executor-manifest-readiness[^|]*buildSupervisorLifecycleExecutorManifestReadinessViewModel[^|]*manifestReady[^|]*executorReady:false[^|]*manifestBlockers[^|]*nextBlockers[^|]*wouldRun:false[^|]*wouldWrite:false[^|]*test\/web-console\.test\.js supervisor lifecycle executor manifest readiness/i, 'V1.04 should become historical supervisor lifecycle executor manifest readiness Web Console milestone');
    assertReadmeContains(/\| V1\.03 \| 历史版本 \|[^|]*POST \/api\/supervisor-lifecycle-executor-manifest-readiness[^|]*inline[^|]*API_WRITE_ROUTES[^|]*read token[^|]*executorReady:false[^|]*guarded-executor-runner-missing/i, 'V1.03 should become historical supervisor lifecycle executor manifest readiness API milestone');
    assertReadmeContains(/\| V1\.02 \| 历史版本 \|[^|]*(supervisor lifecycle executor manifest readiness CLI|agent\.js supervisor-lifecycle-executor-manifest-readiness|--manifest <path>|executorManifestReadiness\.state:blocked|executorReady:false|guarded-executor-runner-missing|--fail-on-blocked)/i, 'V1.02 should become historical supervisor lifecycle executor manifest readiness CLI milestone');
    assertReadmeContains(/\| V1\.01 \| 历史版本 \|[^|]*(supervisor lifecycle executor manifest readiness|validateSupervisorLifecycleExecutorManifest|executorManifestReadiness\.state:blocked|executorReady:false|guarded-executor-runner-missing)/i, 'V1.01 should become historical supervisor lifecycle executor manifest readiness milestone');
    assertReadmeContains(/\| V1\.00 \| 历史版本 \|[^|]*(supervisor lifecycle executor readiness Web Console|supervisor-lifecycle-executor-readiness-button|buildSupervisorLifecycleExecutorReadinessViewModel|POST \/api\/supervisor-lifecycle-executor-readiness|executorReady:false)/i, 'V1.00 should become historical supervisor lifecycle executor readiness Web Console milestone');
    assertReadmeContains(/\| V0\.99 \| 历史版本 \|[^|]*(supervisor lifecycle executor readiness API|POST \/api\/supervisor-lifecycle-executor-readiness|read token|API_WRITE_ROUTES|executorReady:false)/i, 'V0.99 should become historical supervisor lifecycle executor readiness API milestone');
    assertReadmeContains(/\| V0\.98 \| 历史版本 \|[^|]*(supervisor-lifecycle-executor-readiness CLI|agent\.js supervisor-lifecycle-executor-readiness|executor-not-implemented-for-action|executorReady:false|--fail-on-blocked)/i, 'V0.98 should become historical supervisor lifecycle executor readiness CLI milestone');
    assertReadmeContains(/\| V0\.97 \| 历史版本 \|[^|]*(supervisor lifecycle apply readiness CLI|agent\.js supervisor-lifecycle-apply-readiness|--data-dir|--fail-on-blocked|sanitized)/i, 'V0.97 should become historical milestone');
    assertReadmeContains(/\| V0\.96 \| 历史版本 \|[^|]*(supervisor lifecycle apply readiness Web\/API|POST \/api\/supervisor-lifecycle-apply-readiness|supervisor-lifecycle-apply-readiness-button|buildSupervisorLifecycleApplyReadiness)/i, 'V0.96 should become historical milestone');
    assertReadmeContains(/\| V0\.95 \| 历史版本 \|[^|]*(supervisor lifecycle approval persist Web\/API|POST \/api\/supervisor-lifecycle-approval-persist|supervisor-lifecycle-approval-persist-button|API_WRITE_ROUTES)/i, 'V0.95 should become historical milestone');
    assertReadmeContains(/\| V0\.94 \| 历史版本 \|[^|]*(supervisor lifecycle approval persist CLI|supervisor-lifecycle-approval-persist|--data-dir|appendSupervisorLifecycleApprovalRecord)/i, 'V0.94 should become historical milestone');
    assertReadmeContains(/\| V0\.93 \| 历史版本 \|[^|]*(supervisor lifecycle approval store foundation|src\/approval-store\.js|appendSupervisorLifecycleApprovalRecord|readSupervisorLifecycleApprovalRecords)/i, 'V0.93 should become historical milestone');
    assertReadmeContains(/\| V0\.92 \| 历史版本 \|[^|]*(supervisor lifecycle approval persistence preview Web\/API|supervisor-lifecycle-approval-preview-panel|POST \/api\/supervisor-lifecycle-approval-persistence-preview)/i, 'V0.92 should become historical milestone');
    assertReadmeContains(/\| V0\.91 \| 历史版本 \|[^|]*(supervisor lifecycle approval persistence preview CLI|supervisor-lifecycle-approval-persistence-preview)/i, 'V0.91 should become historical milestone');
    assertReadmeContains(/\| V0\.90 \| 历史版本 \|[^|]*(supervisor lifecycle approval persistence preview|buildSupervisorLifecycleApprovalPersistencePreview)/i, 'V0.90 should become historical milestone');
    assertReadmeDoesNotContain(/\| V0\.99 \| 当前版本 \|/i, 'V0.99 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.00 \| 当前版本 \|/i, 'V1.00 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.01 \| 当前版本 \|/i, 'V1.01 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.02 \| 当前版本 \|/i, 'V1.02 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.03 \| 当前版本 \|/i, 'V1.03 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.04 \| 当前版本 \|/i, 'V1.04 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.05 \| 当前版本 \|/i, 'V1.05 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.06 \| 当前版本 \|/i, 'V1.06 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.17 \| 当前版本 \|/i, 'V1.17 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.07 \| 当前版本 \|/i, 'V1.07 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.08 \| 当前版本 \|/i, 'V1.08 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.09 \| 当前版本 \|/i, 'V1.09 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.10 \| 当前版本 \|/i, 'V1.10 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.11 \| 当前版本 \|/i, 'V1.11 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.12 \| 当前版本 \|/i, 'V1.12 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.13 \| 当前版本 \|/i, 'V1.13 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.14 \| 当前版本 \|/i, 'V1.14 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.15 \| 当前版本 \|/i, 'V1.15 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.21 \| 当前版本 \|/i, 'V1.21 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.22 \| 当前版本 \|/i, 'V1.22 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.23 \| 当前版本 \|/i, 'V1.23 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.24 \| 当前版本 \|/i, 'V1.24 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.25 \| 当前版本 \|/i, 'V1.25 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.26 \| 当前版本 \|/i, 'V1.26 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.27 \| 当前版本 \|/i, 'V1.27 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.28 \| 当前版本 \|/i, 'V1.28 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.29 \| 当前版本 \|/i, 'V1.29 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.30 \| 当前版本 \|/i, 'V1.30 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.43 \| 当前版本 \|/i, 'V1.43 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.42 \| 当前版本 \|/i, 'V1.42 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.41 \| 当前版本 \|/i, 'V1.41 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.40 \| 当前版本 \|/i, 'V1.40 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.39 \| 当前版本 \|/i, 'V1.39 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.38 \| 当前版本 \|/i, 'V1.38 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.37 \| 当前版本 \|/i, 'V1.37 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.36 \| 当前版本 \|/i, 'V1.36 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.35 \| 当前版本 \|/i, 'V1.35 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.34 \| 当前版本 \|/i, 'V1.34 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.33 \| 当前版本 \|/i, 'V1.33 must not remain marked as current');
    assertReadmeDoesNotContain(/\| V1\.32 \| 当前版本 \|/i, 'V1.32 must not remain marked as current');
  });

  it('documents supervisor-lifecycle-apply as dry-run/blocked without --apply', () => {
    assertReadmeContains(/supervisor-lifecycle-apply/, 'README should document supervisor-lifecycle-apply CLI');
    assertReadmeContains(/--apply/, 'README should document --apply option');
    assertReadmeContains(/dry-run|blocked/i, 'README should mention default command is dry-run/blocked without --apply');
    assertReadmeContains(/recover|恢复|恢复模式/i, 'README should mention recover remains blocked');
    assertReadmeContains(/Web.*(lifecycle|生命周期).*button|Web.*(lifecycle|生命周期).*(按钮|接口)|no.*Web.*button/i, 'README should mention no Web lifecycle button or API endpoint');
  });

  it('documents approval persistence preview CLI and Web/API safety boundaries', () => {
    assertReadmeContains(/supervisor-lifecycle-approval-persistence-preview/, 'README should document approval persistence preview command/endpoint');
    assertReadmeContains(/--approval/, 'README should document optional approval path');
    assertReadmeContains(/--fail-on-blocked/, 'README should document fail-on-blocked support');
    assertReadmeContains(/拒绝 `?--apply`?|rejects `?--apply`?/i, 'README should say preview command rejects --apply');
    assertReadmeContains(/supervisor-lifecycle-approval-preview-panel/, 'README should document Web Console approval preview panel');
    assertReadmeContains(/POST \/api\/supervisor-lifecycle-approval-persistence-preview/, 'README should document approval preview POST endpoint');
    assertReadmeContains(/不新增真实 lifecycle apply endpoint|不新增生命周期 apply 面|no lifecycle apply/i, 'README should say no lifecycle apply surface is added');
    assertReadmeContains(/不读取本地 approval path|no local approval path/i, 'README should say Web/API does not read local approval paths');
  });

  it('documents approval store persistence and redaction boundaries', () => {
    assertReadmeContains(/src\/approval-store\.js/, 'README should document approval store module');
    assertReadmeContains(/appendSupervisorLifecycleApprovalRecord/, 'README should document approval append helper');
    assertReadmeContains(/readSupervisorLifecycleApprovalRecords/, 'README should document approval read helper');
    assertReadmeContains(/supervisor-lifecycle-approvals\.jsonl/, 'README should document local JSONL store');
    assertReadmeContains(/不保存 approvedBy 值|approval reason|acknowledgement 内容|approval timestamps|configHash|planHash|sha256:/i, 'README should document sensitive approval fields are not stored');
  });

  it('documents approval persist CLI and explicit data-dir boundary', () => {
    assertReadmeContains(/supervisor-lifecycle-approval-persist/, 'README should document approval persist CLI command');
    assertReadmeContains(/--data-dir/, 'README should document explicit data-dir requirement');
    assertReadmeContains(/invalid approval[\s\S]*?(退出码|exit)[\s\S]*?2/i, 'README should document invalid approval exit 2');
    assertReadmeContains(/拒绝 `?--apply`?|--apply[\s\S]*(不受支持|not supported|拒绝)/i, 'README should say persist CLI rejects --apply');
    assertReadmeContains(/不执行 lifecycle apply|不接入 `?supervisor-lifecycle-apply`?|not wired to lifecycle apply/i, 'README should say persist CLI does not execute lifecycle apply');
    assertReadmeContains(/不回显 config path|approval path|dataDir path|approval identity|hash 值/i, 'README should document persist CLI redaction boundaries');
  });

  it('documents approval persist Web/API route, write-route auth, statuses, and Web button', () => {
    assertReadmeContains(/POST \/api\/supervisor-lifecycle-approval-persist/, 'README should document approval persist POST endpoint');
    assertReadmeContains(/API_WRITE_ROUTES/, 'README should document write-route registration');
    assertReadmeContains(/supervisor-lifecycle-approval-persist-button/, 'README should document persist Web button hook');
    assertReadmeContains(/\b201\b[\s\S]*(supervisor-lifecycle-approval-record|persisted)/i, 'README should document 201 persisted response');
    assertReadmeContains(/\b409\b[\s\S]*(blocked|supervisor-lifecycle-approval-persistence-preview)/i, 'README should document 409 blocked response');
    assertReadmeContains(/failed to persist approval record/, 'README should document static write failure error');
    assertReadmeContains(/不接受 client.*dataDir|不接受客户端.*dataDir|server-owned `?dataDir`?/i, 'README should document server-owned dataDir boundary');
    assertReadmeContains(/无启动请求|不自动轮询|manual/i, 'README should document manual-only Web action');
  });

  it('documents approval records read API and Web button boundaries', () => {
    assertReadmeContains(/GET \/api\/supervisor-lifecycle-approval-records/, 'README should document approval records GET endpoint');
    assertReadmeContains(/supervisor-lifecycle-approval-records-button/, 'README should document approval records Web button hook');
    assertReadmeContains(/readOnly:true|只读查看|read-only/i, 'README should document read-only records behavior');
    assertReadmeContains(/sensitiveValuesReturned:false|approvedBy|approval identity/i, 'README should document records redaction boundary');
    assertReadmeContains(/不执行 lifecycle apply|不执行生命周期 apply|lifecycleApplied:false/i, 'README should document records view does not apply lifecycle changes');
    assertReadmeContains(/不调用 launchctl|launchctlCalled:false/i, 'README should document records view does not call launchctl');
  });

  it('documents apply readiness API, Web button, read-token behavior, and fail-closed boundaries', () => {
    assertReadmeContains(/buildSupervisorLifecycleApplyReadiness/, 'README should document apply readiness pure function');
    assertReadmeContains(/POST \/api\/supervisor-lifecycle-apply-readiness/, 'README should document apply readiness POST endpoint');
    assertReadmeContains(/supervisor-lifecycle-apply-readiness-button/, 'README should document apply readiness Web button hook');
    assertReadmeContains(/不注册到 `?API_WRITE_ROUTES`?|not registered.*API_WRITE_ROUTES/i, 'README should document readiness is not a write route');
    assertReadmeContains(/read token 可调用|read token.*call/i, 'README should document read token can call readiness');
    assertReadmeContains(/state:"blocked"/, 'README should document top-level readiness state remains blocked');
    assertReadmeContains(/approvalRecordReady:true/, 'README should document ready gate meaning');
    assertReadmeContains(/approvalRecordState:"ready"/, 'README should document approval record gate ready state');
    assertReadmeContains(/nextBlockers:\["executor-implementation-missing"\]/, 'README should document executor remains next blocker');
    assertReadmeContains(/approval-record-missing|approval-record-safety-invalid|approval-record-validation-incomplete/i, 'README should document fail-closed blocker codes');
    assertReadmeContains(/不提交 approval JSON|不读取 approval textarea|does not submit approval/i, 'README should document readiness does not submit approval JSON');
    assertReadmeContains(/readOnly:true|lifecycleApplied:false|launchctlCalled:false/i, 'README should document readiness safety flags');
  });

  it('documents apply readiness CLI command, arguments, fail-on-blocked, and fail-closed boundaries', () => {
    assertReadmeContains(/agent\.js supervisor-lifecycle-apply-readiness/, 'README should document apply readiness CLI command');
    assertReadmeContains(/--config/, 'README should document config option for readiness CLI');
    assertReadmeContains(/--operation/, 'README should document operation option for readiness CLI');
    assertReadmeContains(/--data-dir/, 'README should document data-dir option for readiness CLI');
    assertReadmeContains(/--fail-on-blocked/, 'README should document fail-on-blocked option for readiness CLI');
    assertReadmeContains(/退出码[\s\S]*?2|exit[\s\S]*?2/i, 'README should document exit 2 on blocked');
    assertReadmeContains(/拒绝 `?--apply`?|--apply[\s\S]*(不受支持|not supported|拒绝)/i, 'README should say readiness CLI rejects --apply');
    assertReadmeContains(/拒绝 `?--approval`?|--approval[\s\S]*(不受支持|not supported|拒绝)/i, 'README should say readiness CLI rejects --approval');
  });

  it('documents executor readiness CLI command, action-driven blockers, and fail-closed boundaries', () => {
    assertReadmeContains(/agent\.js supervisor-lifecycle-executor-readiness/, 'README should document executor readiness CLI command');
    assertReadmeContains(/--config/, 'README should document config option for executor readiness CLI');
    assertReadmeContains(/--operation/, 'README should document operation option for executor readiness CLI');
    assertReadmeContains(/--data-dir/, 'README should document data-dir option for executor readiness CLI');
    assertReadmeContains(/--fail-on-blocked/, 'README should document fail-on-blocked option for executor readiness CLI');
    assertReadmeContains(/executor-not-implemented-for-action:<actionId>/, 'README should document action-driven executor blocker format');
    assertReadmeContains(/executorReady:false/, 'README should document executor remains not ready');
    assertReadmeContains(/拒绝 `?--apply`?|--apply[\s\S]*(不受支持|not supported|拒绝)/i, 'README should say executor readiness CLI rejects --apply');
    assertReadmeContains(/拒绝 `?--approval`?|--approval[\s\S]*(不受支持|not supported|拒绝)/i, 'README should say executor readiness CLI rejects --approval');
    assertReadmeContains(/不执行 lifecycle apply|不调用 `?executeSupervisorLifecycleApply`?|不调用 launchctl/i, 'README should document executor readiness does not execute lifecycle apply');
  });

  it('documents executor readiness API route, read-token behavior, and fail-closed boundaries', () => {
    assertReadmeContains(/POST \/api\/supervisor-lifecycle-executor-readiness/, 'README should document executor readiness POST endpoint');
    assertReadmeContains(/不注册到 `?API_WRITE_ROUTES`?|not registered.*API_WRITE_ROUTES/i, 'README should document executor readiness is not a write route');
    assertReadmeContains(/read token 可调用|read token.*call/i, 'README should document read token can call executor readiness');
    assertReadmeContains(/executorReady:false/, 'README should document executor remains not ready through API');
    assertReadmeContains(/executor-not-implemented-for-action:<actionId>/, 'README should document action-driven executor blocker format for API');
    assertReadmeContains(/不提交 approval JSON|不接受 approval JSON|does not submit approval/i, 'README should document executor readiness API does not submit approval JSON');
    assertReadmeContains(/不写 approval store|不创建 approval storage|does not create approval storage/i, 'README should document executor readiness API does not write approval storage');
    assertReadmeContains(/readOnly:true|lifecycleApplied:false|launchctlCalled:false/i, 'README should document executor readiness API safety flags');
  });

  it('documents executor readiness Web Console button and sanitized rendering boundaries', () => {
    assertReadmeContains(/supervisor-lifecycle-executor-readiness-button/, 'README should document executor readiness Web button hook');
    assertReadmeContains(/buildSupervisorLifecycleExecutorReadinessViewModel/, 'README should document executor readiness Web view model');
    assertReadmeContains(/test\/web-console\.test\.js supervisor lifecycle executor readiness/, 'README should document executor readiness Web Console tests');
    assertReadmeContains(/不读取 approval textarea|不提交 approval JSON|manual/i, 'README should document Web executor readiness ignores approval textarea');
    assertReadmeContains(/不显示.*runnable command|不显示.*路径|不显示.*hash|不显示.*token|不显示.*hostname|不显示.*process id/i, 'README should document Web executor readiness redaction boundaries');
  });

  it('documents executor manifest readiness pure function and fail-closed boundaries', () => {
    assertReadmeContains(/validateSupervisorLifecycleExecutorManifest/, 'README should document executor manifest readiness pure function');
    assertReadmeContains(/agent\.js supervisor-lifecycle-executor-manifest-readiness/, 'README should document executor manifest readiness CLI');
    assertReadmeContains(/POST \/api\/supervisor-lifecycle-executor-manifest-readiness/, 'README should document executor manifest readiness API');
    assertReadmeContains(/--manifest <path>/, 'README should document manifest path option');
    assertReadmeContains(/拒绝 `?--apply`?|--apply[\s\S]*(不受支持|not supported|拒绝)/i, 'README should say manifest readiness CLI rejects --apply');
    assertReadmeContains(/拒绝 `?--approval`?|--approval[\s\S]*(不受支持|not supported|拒绝)/i, 'README should say manifest readiness CLI rejects --approval');
    assertReadmeContains(/拒绝 `?--data-dir`?|--data-dir[\s\S]*(不受支持|not supported|拒绝)/i, 'README should say manifest readiness CLI rejects --data-dir');
    assertReadmeContains(/拒绝 `?--output`?|--output[\s\S]*(不受支持|not supported|拒绝)/i, 'README should say manifest readiness CLI rejects --output');
    assertReadmeContains(/supervisor-lifecycle-executor-manifest/, 'README should document executor manifest kind');
    assertReadmeContains(/schemaVersion:1/, 'README should document manifest schema version');
    assertReadmeContains(/mode:"guarded-host-action"/, 'README should document guarded action mode');
    assertReadmeContains(/requiresApprovalRecord.*true|requiresApprovalRecord:true/i, 'README should document approval record requirement');
    assertReadmeContains(/executorManifestReadiness\.state:blocked|state:"blocked"/, 'README should document manifest readiness remains blocked');
    assertReadmeContains(/executorReady:false/, 'README should document executor remains not ready');
    assertReadmeContains(/guarded-executor-runner-missing/, 'README should document missing runner blocker');
    assertReadmeContains(/wouldRun:false[\s\S]*wouldWrite:false|wouldWrite:false[\s\S]*wouldRun:false/i, 'README should document no action run/write semantics');
    assertReadmeContains(/不注册到 `?API_WRITE_ROUTES`?|read token 可调用|read token.*call/i, 'README should document API read-only auth boundary');
    assertReadmeContains(/不接受本地 manifest path|不接受.*config path|不接受.*approval path|不接受.*dataDir/i, 'README should document API local path/dataDir rejection');
    assertReadmeContains(/supervisor-lifecycle-executor-manifest-readiness-button/, 'README should document executor manifest readiness Web button hook');
    assertReadmeContains(/buildSupervisorLifecycleExecutorManifestReadinessViewModel/, 'README should document executor manifest readiness Web view model');
    assertReadmeContains(/test\/web-console\.test\.js supervisor lifecycle executor manifest readiness/, 'README should document executor manifest readiness Web tests');
    assertReadmeContains(/不读取 approval textarea|不提交 approval JSON|不读取 approval store|不执行 lifecycle apply|不调用 launchctl|不写文件/i, 'README should document Web/API execution boundary');
    assertReadmeContains(/test\/supervisor-lifecycle-executor-manifest\.test\.js/, 'README should document executor manifest test coverage');
    assertReadmeContains(/buildSupervisorLifecycleGuardedRunnerReadiness/, 'README should document guarded runner readiness pure function');
    assertReadmeContains(/supervisor-lifecycle-guarded-runner-binding/, 'README should document guarded runner binding kind');
    assertReadmeContains(/agent\.js supervisor-lifecycle-guarded-runner-readiness/, 'README should document guarded runner readiness CLI');
    assertReadmeContains(/POST \/api\/supervisor-lifecycle-guarded-runner-readiness/, 'README should document guarded runner readiness API');
    assertReadmeContains(/supervisor-lifecycle-guarded-runner-readiness-button/, 'README should document guarded runner readiness Web button');
    assertReadmeContains(/buildSupervisorLifecycleGuardedRunnerReadinessViewModel/, 'README should document guarded runner readiness Web view model');
    assertReadmeContains(/inline `operation`、`config`、`manifest` 与 `runnerBinding`|inline `operation`、`config`、`manifest` 与 `runnerBinding`/i, 'README should document guarded runner readiness inline API body');
    assertReadmeContains(/不注册到 `?API_WRITE_ROUTES`?|read token 可调用|read token.*call/i, 'README should document guarded runner API read-only auth boundary');
    assertReadmeContains(/--runner-binding <path>/, 'README should document runner binding path option');
    assertReadmeContains(/runnerBindingsReady:true/, 'README should document runner binding readiness state');
    assertReadmeContains(/guarded-runner-execution-disabled/, 'README should document guarded runner execution disabled blocker');
    assertReadmeContains(/test\/supervisor-lifecycle-guarded-runner-readiness\.test\.js/, 'README should document guarded runner readiness test coverage');
    assertReadmeContains(/test\/agent-supervisor-lifecycle-guarded-runner-readiness\.test\.js/, 'README should document guarded runner readiness CLI test coverage');
    assertReadmeContains(/test\/supervisor-lifecycle-guarded-runner-readiness-api\.test\.js/, 'README should document guarded runner readiness API test coverage');
    assertReadmeContains(/test\/web-console\.test\.js supervisor lifecycle guarded runner readiness/, 'README should document guarded runner readiness Web test coverage');
    assertReadmeContains(/test\/agent-supervisor-lifecycle-executor-manifest-readiness\.test\.js/, 'README should document executor manifest CLI test coverage');
    assertReadmeContains(/test\/supervisor-lifecycle-executor-manifest-readiness-api\.test\.js/, 'README should document executor manifest API test coverage');
    assertReadmeContains(/buildSupervisorLifecycleGuardedRunnerExecutionPreview\(plan, guardedRunnerReadiness\)/, 'README should document guarded runner execution preview pure function signature');
    assertReadmeContains(/test\/supervisor-lifecycle-guarded-runner-execution-preview\.test\.js/, 'README should document guarded runner execution preview test coverage');
    assertReadmeContains(/buildSupervisorLifecycleGuardedRunnerExecutionGate/, 'README should document guarded runner execution gate pure function');
    assertReadmeContains(/test\/supervisor-lifecycle-guarded-runner-execution-gate\.test\.js/, 'README should document guarded runner execution gate test coverage');
    assertReadmeContains(/buildSupervisorLifecycleGuardedRunnerWiringContract/, 'README should document V1.17 wiring contract pure function');
    assertReadmeContains(/buildSupervisorLifecycleGuardedRunnerRegistryReadiness/, 'README should document V1.18 registry readiness pure function');
    assertReadmeContains(/runnerRegistryReadiness\.state:blocked/, 'README should document V1.18 blocked registry readiness');
    assertReadmeContains(/runnerRegistryReady:false/, 'README should document V1.18 registry ready gate flag');
    assertReadmeContains(/runner-registry-real-implementation-missing/, 'README should document V1.18 registry real implementation blocker');
    assertReadmeContains(/runnerRegistry:guarded-runner-stub:state:blocked:realImplementationReady:false:wouldExecute:false:blocker:runner-registry-real-implementation-missing/, 'README should document V1.18 Web registry line format');
    assertReadmeContains(/runnerWiringContract\.state:blocked/, 'README should document V1.17 blocked runnerWiringContract state');
    assertReadmeContains(/runnerWiringContract\.requiredContracts/, 'README should document V1.17 required contracts evidence');
    assertReadmeContains(/runnerWiringContractReady:false/, 'README should document V1.17 contract gate flag');
    assertReadmeContains(/wiringContract:<id>:status:blocked:requiredForExecution:true:blocker:<blockerCode>/, 'README should document V1.17 Web wiring contract line format');
    assertReadmeContains(/supervisor-lifecycle-guarded-runner-execution-gate-button/, 'README should document V1.16 execution gate Web button');
    assertReadmeContains(/buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel/, 'README should document V1.16 execution gate Web view model');
    assertReadmeContains(/test\/web-console\.test\.js supervisor lifecycle guarded runner execution gate/, 'README should document V1.16 execution gate Web test coverage');
    assertReadmeContains(/POST \/api\/supervisor-lifecycle-guarded-runner-execution-gate/, 'README should document V1.15 execution gate API surface used by V1.16 Web');
    assertReadmeContains(/test\/supervisor-lifecycle-guarded-runner-execution-gate-api\.test\.js/, 'README should document V1.15 execution gate API test coverage');
    assertReadmeContains(/read token 可调用|read token.*call/i, 'README should document V1.15 execution gate API read token access');
    assertReadmeContains(/不注册到 `?API_WRITE_ROUTES`?|API_WRITE_ROUTES.*exclusion|not registered.*API_WRITE_ROUTES/i, 'README should document V1.15 execution gate API write-route exclusion');
    assertReadmeContains(/executeRequested[\s\S]*(boolean|布尔|true)/i, 'README should document V1.16 executeRequested intent contract');
    assertReadmeContains(/runnerBindingsReady:false[\s\S]*actionCandidates:\[\]|actionCandidates:\[\][\s\S]*runnerBindingsReady:false/i, 'README should document V1.15 missing runnerBinding blocked gate');
    assertReadmeContains(/agent\.js supervisor-lifecycle-guarded-runner-execution-gate/, 'README should document V1.14 execution gate CLI surface');
    assertReadmeContains(/test\/agent-supervisor-lifecycle-guarded-runner-execution-gate\.test\.js/, 'README should document V1.14 execution gate CLI test coverage');
    assertReadmeContains(/--data-dir <path>[\s\S]*--execute-requested[\s\S]*--fail-on-blocked/i, 'README should document V1.14 execution gate CLI options');
    assertReadmeContains(/executionEligible:false[\s\S]*execute-request-missing[\s\S]*realRunnerWiringReady:false/i, 'README should document execution gate blocked flags');
    assertReadmeContains(/executionReady:false[\s\S]*executorReady:false[\s\S]*wouldExecute:false/i, 'README should document execution preview blocked readiness flags');
    assertReadmeContains(/wouldRun:false[\s\S]*wouldWrite:false|wouldWrite:false[\s\S]*wouldRun:false/i, 'README should document execution preview action preview no-run/no-write semantics');
    assertReadmeContains(/guarded-runner-execution-preview-only/, 'README should document execution preview-only blocker');
    assertReadmeContains(/real-guarded-runner-execution-wiring-missing/, 'README should document real wiring missing next blocker');
    assertReadmeContains(/agent\.js supervisor-lifecycle-guarded-runner-execution-preview/, 'README should document V1.10 CLI surface');
    assertReadmeContains(/POST \/api\/supervisor-lifecycle-guarded-runner-execution-preview/, 'README should document V1.11 API surface');
    assertReadmeContains(/supervisor-lifecycle-guarded-runner-execution-preview-button/, 'README should document V1.12 Web execution preview button');
    assertReadmeContains(/buildSupervisorLifecycleGuardedRunnerExecutionPreviewViewModel/, 'README should document V1.12 Web execution preview view model');
    assertReadmeContains(/test\/web-console\.test\.js supervisor lifecycle guarded runner execution preview/, 'README should document V1.12 Web execution preview tests');
    assertReadmeContains(/actionPreviews[\s\S]*(actionId|implementationId|mode|runnerKind)[\s\S]*wouldExecute:false[\s\S]*wouldRun:false[\s\S]*wouldWrite:false/i, 'README should document V1.12 actionPreviews fail-closed allowlist');
    assertReadmeContains(/不读取 approval textarea|不提交 approval JSON|不读取 approval store/i, 'README should document V1.12 Web ignores approval input and store');
    assertReadmeContains(/不注册到 `?API_WRITE_ROUTES`?|read token 可调用|read token.*call/i, 'README should document execution preview API read-only auth boundary');
    assertReadmeContains(/missing\/invalid\/not-ready manifest[\s\S]*固定 sanitized 错误|missing\/invalid\/not-ready manifest[\s\S]*fixed sanitized/i, 'README should document missing or not-ready manifest sanitized validation boundary');
    assertReadmeContains(/不新增 Web|no Web/i, 'README should document V1.11 adds no Web surface');
    assertReadmeContains(/V1\.10[\s\S]*?(不新增 API|no API)/i, 'README should keep V1.10 no-API wording only as historical CLI boundary');
    assertReadmeContains(/不调用 `?executeSupervisorLifecycleApply`?|does not call `?executeSupervisorLifecycleApply`?/i, 'README should document execution preview does not call lifecycle executor');
    assertReadmeContains(/不调用 launchctl|launchctlCalled:false/i, 'README should document no launchctl call');
    assertReadmeContains(/不写文件|filesystemWritten:false/i, 'README should document no filesystem write');
    assertReadmeContains(/不读取进程列表|processListRead:false/i, 'README should document no process list read');
    assertReadmeContains(/不连接 NAS|nasConnected:false/i, 'README should document no NAS connection');
    assertReadmeContains(/不触发备份|backupTriggered:false/i, 'README should document no backup trigger');
    assertReadmeContains(/不触发恢复|restoreTriggered:false/i, 'README should document no restore trigger');
    assertReadmeContains(/不执行远程命令|remoteCommandExecuted:false/i, 'README should document no remote command');
  });

  it('keeps Gold blocked and rejects lifecycle overclaims for V1.28', () => {
    assertReadmeContains(/Gold (依旧|仍然|remains) blocked/i, 'README should keep Gold blocked');
    assertReadmeContains(/真实 installer|real installer/i, 'README should still call out missing real installer');
    assertReadmeDoesNotContain(/Gold ready|Gold 发布 ready|生产可用 supervisor|production-ready supervisor|production approval workflow|rollback ready|uninstall ready|recovery supervisor ready|real guarded lifecycle apply execution wiring ready|real NAS remote backup ready|managed daemon lifecycle ready/i, 'README must not overclaim Gold or lifecycle readiness');
  });

  it('keeps later Gold readiness sections synced to V1.28 evidence', () => {
    assertReadmeContains(/Agent CLI[\s\S]*?V1\.28[\s\S]*?resolveSupervisorLifecycleGuardedRunnerAttemptAudit[\s\S]*?attemptAuditReadiness\.state:ready[\s\S]*?attemptAuditReady:true[\s\S]*?codeOwnedAuditResolverReady:true[\s\S]*?V1\.27[\s\S]*?resolveSupervisorLifecycleGuardedRunnerRollbackAnchor[\s\S]*?rollbackAnchorReadiness\.state:ready[\s\S]*?rollbackAnchorReady:true[\s\S]*?codeOwnedAnchorResolverReady:true[\s\S]*?V1\.26[\s\S]*?resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter[\s\S]*?hostMutationAdapterReadiness\.state:ready[\s\S]*?hostMutationAdapterReady:true[\s\S]*?codeOwnedAdapterResolverReady:true[\s\S]*?V1\.25[\s\S]*?resolveSupervisorLifecycleGuardedRunnerRegistry[\s\S]*?runnerRegistryReadiness\.state:ready[\s\S]*?runnerRegistryReady:true[\s\S]*?codeOwnedRegistryResolverReady:true[\s\S]*?V1\.24[\s\S]*?evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy[\s\S]*?executionPolicyReadiness\.state:ready[\s\S]*?executionPolicyReady:true[\s\S]*?fail-closed-execution-policy[\s\S]*?policyDecision[\s\S]*?executionEligible:false[\s\S]*?V1\.23[\s\S]*?buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness[\s\S]*?executionPolicyReadiness\.state:blocked[\s\S]*?executionPolicyReady:false[\s\S]*?execution-policy-real-implementation-missing[\s\S]*?V1\.22[\s\S]*?buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness[\s\S]*?operatorRecoveryReadiness\.state:blocked[\s\S]*?operatorRecoveryReady:false[\s\S]*?operator-recovery-real-implementation-missing[\s\S]*?V1\.21[\s\S]*?buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness[\s\S]*?attemptAuditReadiness\.state:blocked[\s\S]*?attemptAuditReady:false[\s\S]*?attempt-audit-real-implementation-missing[\s\S]*?V1\.20[\s\S]*?buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness[\s\S]*?rollbackAnchorReadiness\.state:blocked[\s\S]*?rollbackAnchorReady:false[\s\S]*?rollback-anchor-real-implementation-missing[\s\S]*?V1\.19[\s\S]*?buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness[\s\S]*?hostMutationAdapterReadiness\.state:blocked[\s\S]*?hostMutationAdapterReady:false[\s\S]*?host-mutation-adapter-real-implementation-missing[\s\S]*?V1\.18[\s\S]*?buildSupervisorLifecycleGuardedRunnerRegistryReadiness[\s\S]*?runnerRegistryReadiness\.state:blocked[\s\S]*?runnerRegistryReady:false[\s\S]*?runner-registry-real-implementation-missing[\s\S]*?V1\.17[\s\S]*?buildSupervisorLifecycleGuardedRunnerWiringContract[\s\S]*?runnerWiringContract\.state:blocked[\s\S]*?runnerWiringContract\.requiredContracts[\s\S]*?runnerWiringContractReady:false[\s\S]*?V1\.16[\s\S]*?supervisor-lifecycle-guarded-runner-execution-gate-button[\s\S]*?buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel[\s\S]*?test\/web-console\.test\.js supervisor lifecycle guarded runner execution gate[\s\S]*?V1\.15[\s\S]*?POST \/api\/supervisor-lifecycle-guarded-runner-execution-gate[\s\S]*?test\/supervisor-lifecycle-guarded-runner-execution-gate-api\.test\.js[\s\S]*?read token[\s\S]*?API_WRITE_ROUTES[\s\S]*?V1\.14[\s\S]*?src\/agent\.js supervisor-lifecycle-guarded-runner-execution-gate[\s\S]*?test\/agent-supervisor-lifecycle-guarded-runner-execution-gate\.test\.js[\s\S]*?--data-dir <path>[\s\S]*?--execute-requested[\s\S]*?--fail-on-blocked[\s\S]*?V1\.13[\s\S]*?buildSupervisorLifecycleGuardedRunnerExecutionGate[\s\S]*?supervisor-lifecycle-guarded-runner-execution-gate[\s\S]*?test\/supervisor-lifecycle-guarded-runner-execution-gate\.test\.js[\s\S]*?V1\.12[\s\S]*?supervisor-lifecycle-guarded-runner-execution-preview-button[\s\S]*?buildSupervisorLifecycleGuardedRunnerExecutionPreviewViewModel[\s\S]*?test\/web-console\.test\.js supervisor lifecycle guarded runner execution preview[\s\S]*?V1\.11[\s\S]*?POST \/api\/supervisor-lifecycle-guarded-runner-execution-preview[\s\S]*?test\/supervisor-lifecycle-guarded-runner-execution-preview-api\.test\.js[\s\S]*?V1\.10[\s\S]*?agent\.js supervisor-lifecycle-guarded-runner-execution-preview[\s\S]*?test\/agent-supervisor-lifecycle-guarded-runner-execution-preview\.test\.js[\s\S]*?V1\.09[\s\S]*?buildSupervisorLifecycleGuardedRunnerExecutionPreview[\s\S]*?test\/supervisor-lifecycle-guarded-runner-execution-preview\.test\.js/i, 'README Agent CLI Gold section should mention V1.23 execution policy readiness evidence through V1.09 pure evidence');
    assertReadmeContains(/Agent CLI[\s\S]*?V1\.08[\s\S]*?supervisor-lifecycle-guarded-runner-readiness-button[\s\S]*?buildSupervisorLifecycleGuardedRunnerReadinessViewModel[\s\S]*?test\/web-console\.test\.js supervisor lifecycle guarded runner readiness/i, 'README Agent CLI Gold section should mention V1.08 guarded runner readiness Web evidence');
    assertReadmeContains(/Agent CLI[\s\S]*?V1\.07[\s\S]*?POST \/api\/supervisor-lifecycle-guarded-runner-readiness[\s\S]*?test\/supervisor-lifecycle-guarded-runner-readiness-api\.test\.js/i, 'README Agent CLI Gold section should mention V1.07 guarded runner readiness API evidence');
    assertReadmeContains(/Agent CLI[\s\S]*?V1\.06[\s\S]*?agent\.js supervisor-lifecycle-guarded-runner-readiness --runner-binding <path>[\s\S]*?test\/agent-supervisor-lifecycle-guarded-runner-readiness\.test\.js/i, 'README Agent CLI Gold section should mention V1.06 guarded runner readiness CLI evidence');
    assertReadmeContains(/Agent CLI[\s\S]*?V1\.05[\s\S]*?buildSupervisorLifecycleGuardedRunnerReadiness[\s\S]*?test\/supervisor-lifecycle-guarded-runner-readiness\.test\.js/i, 'README Agent CLI Gold section should retain V1.05 guarded runner readiness evidence');
    assertReadmeContains(/Gold blockers[\s\S]*?V1\.28[\s\S]*?resolveSupervisorLifecycleGuardedRunnerAttemptAudit[\s\S]*?attemptAuditReadiness\.state:ready[\s\S]*?attemptAuditReady:true[\s\S]*?codeOwnedAuditResolverReady:true[\s\S]*?V1\.27[\s\S]*?resolveSupervisorLifecycleGuardedRunnerRollbackAnchor[\s\S]*?rollbackAnchorReadiness\.state:ready[\s\S]*?rollbackAnchorReady:true[\s\S]*?codeOwnedAnchorResolverReady:true[\s\S]*?V1\.26[\s\S]*?resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter[\s\S]*?hostMutationAdapterReadiness\.state:ready[\s\S]*?hostMutationAdapterReady:true[\s\S]*?codeOwnedAdapterResolverReady:true[\s\S]*?V1\.25[\s\S]*?resolveSupervisorLifecycleGuardedRunnerRegistry[\s\S]*?runnerRegistryReadiness\.state:ready[\s\S]*?runnerRegistryReady:true[\s\S]*?codeOwnedRegistryResolverReady:true[\s\S]*?V1\.24[\s\S]*?evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy[\s\S]*?executionPolicyReadiness\.state:ready[\s\S]*?executionPolicyReady:true[\s\S]*?fail-closed-execution-policy[\s\S]*?policyDecision[\s\S]*?executionEligible:false[\s\S]*?V1\.23[\s\S]*?buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness[\s\S]*?executionPolicyReadiness\.state:blocked[\s\S]*?executionPolicyReady:false[\s\S]*?execution-policy-real-implementation-missing[\s\S]*?V1\.22[\s\S]*?buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness[\s\S]*?operatorRecoveryReadiness\.state:blocked[\s\S]*?operatorRecoveryReady:false[\s\S]*?operator-recovery-real-implementation-missing[\s\S]*?V1\.21[\s\S]*?buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness[\s\S]*?attemptAuditReadiness\.state:blocked[\s\S]*?attemptAuditReady:false[\s\S]*?attempt-audit-real-implementation-missing[\s\S]*?V1\.20[\s\S]*?buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness[\s\S]*?rollbackAnchorReadiness\.state:blocked[\s\S]*?rollbackAnchorReady:false[\s\S]*?rollback-anchor-real-implementation-missing[\s\S]*?V1\.19[\s\S]*?buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness[\s\S]*?hostMutationAdapterReadiness\.state:blocked[\s\S]*?hostMutationAdapterReady:false[\s\S]*?host-mutation-adapter-real-implementation-missing[\s\S]*?V1\.18[\s\S]*?buildSupervisorLifecycleGuardedRunnerRegistryReadiness[\s\S]*?runnerRegistryReadiness\.state:blocked[\s\S]*?runnerRegistryReady:false[\s\S]*?runner-registry-real-implementation-missing[\s\S]*?V1\.17[\s\S]*?buildSupervisorLifecycleGuardedRunnerWiringContract[\s\S]*?runnerWiringContract\.state:blocked[\s\S]*?runnerWiringContract\.requiredContracts[\s\S]*?runnerWiringContractReady:false[\s\S]*?realRunnerWiringReady:false[\s\S]*?V1\.16[\s\S]*?supervisor-lifecycle-guarded-runner-execution-gate-button[\s\S]*?buildSupervisorLifecycleGuardedRunnerExecutionGateViewModel[\s\S]*?test\/web-console\.test\.js supervisor lifecycle guarded runner execution gate[\s\S]*?executeRequested:true[\s\S]*?executionEligible:false[\s\S]*?wouldExecute:false[\s\S]*?realRunnerWiringReady:false[\s\S]*?V1\.15[\s\S]*?POST \/api\/supervisor-lifecycle-guarded-runner-execution-gate[\s\S]*?test\/supervisor-lifecycle-guarded-runner-execution-gate-api\.test\.js[\s\S]*?executeRequested:true[\s\S]*?executionEligible:false[\s\S]*?realRunnerWiringReady:false[\s\S]*?V1\.14[\s\S]*?src\/agent\.js supervisor-lifecycle-guarded-runner-execution-gate[\s\S]*?test\/agent-supervisor-lifecycle-guarded-runner-execution-gate\.test\.js[\s\S]*?--data-dir <path>[\s\S]*?--execute-requested[\s\S]*?--fail-on-blocked[\s\S]*?executionEligible:false[\s\S]*?execute-request-missing[\s\S]*?realRunnerWiringReady:false[\s\S]*?V1\.13[\s\S]*?buildSupervisorLifecycleGuardedRunnerExecutionGate[\s\S]*?test\/supervisor-lifecycle-guarded-runner-execution-gate\.test\.js[\s\S]*?V1\.12[\s\S]*?supervisor-lifecycle-guarded-runner-execution-preview-button[\s\S]*?buildSupervisorLifecycleGuardedRunnerExecutionPreviewViewModel[\s\S]*?test\/web-console\.test\.js supervisor lifecycle guarded runner execution preview[\s\S]*?V1\.11[\s\S]*?POST \/api\/supervisor-lifecycle-guarded-runner-execution-preview[\s\S]*?test\/supervisor-lifecycle-guarded-runner-execution-preview-api\.test\.js[\s\S]*?V1\.10[\s\S]*?agent\.js supervisor-lifecycle-guarded-runner-execution-preview[\s\S]*?test\/agent-supervisor-lifecycle-guarded-runner-execution-preview\.test\.js[\s\S]*?V1\.09[\s\S]*?buildSupervisorLifecycleGuardedRunnerExecutionPreview[\s\S]*?guarded-runner-execution-preview-only[\s\S]*?real-guarded-runner-execution-wiring-missing[\s\S]*?test\/supervisor-lifecycle-guarded-runner-execution-preview\.test\.js/i, 'README Gold blockers section should mention V1.23 execution policy readiness and V1.22 operator recovery readiness evidence through V1.09 pure evidence');
    assertReadmeContains(/Gold blockers[\s\S]*?V1\.08[\s\S]*?supervisor-lifecycle-guarded-runner-readiness-button[\s\S]*?buildSupervisorLifecycleGuardedRunnerReadinessViewModel[\s\S]*?test\/web-console\.test\.js supervisor lifecycle guarded runner readiness/i, 'README Gold blockers section should mention V1.08 guarded runner readiness Web evidence');
    assertReadmeContains(/Gold blockers[\s\S]*?V1\.07[\s\S]*?POST \/api\/supervisor-lifecycle-guarded-runner-readiness[\s\S]*?test\/supervisor-lifecycle-guarded-runner-readiness-api\.test\.js/i, 'README Gold blockers section should mention V1.07 guarded runner readiness API evidence');
    assertReadmeContains(/Gold blockers[\s\S]*?V1\.06[\s\S]*?src\/agent\.js supervisor-lifecycle-guarded-runner-readiness[\s\S]*?--runner-binding <path>[\s\S]*?test\/agent-supervisor-lifecycle-guarded-runner-readiness\.test\.js/i, 'README Gold blockers section should mention V1.06 guarded runner readiness CLI evidence');
    assertReadmeContains(/Agent CLI[\s\S]*?V1\.04[\s\S]*?supervisor-lifecycle-executor-manifest-readiness-button[\s\S]*?test\/web-console\.test\.js supervisor lifecycle executor manifest readiness/i, 'README Agent CLI Gold section should retain V1.04 manifest Web evidence');
    assertReadmeContains(/Gold blockers[\s\S]*?V1\.05[\s\S]*?buildSupervisorLifecycleGuardedRunnerReadiness[\s\S]*?guarded-runner-execution-disabled[\s\S]*?test\/supervisor-lifecycle-guarded-runner-readiness\.test\.js/i, 'README Gold blockers section should mention V1.05 guarded runner readiness evidence');
    assertReadmeContains(/Gold blockers[\s\S]*?V1\.04[\s\S]*?supervisor-lifecycle-executor-manifest-readiness-button[\s\S]*?buildSupervisorLifecycleExecutorManifestReadinessViewModel[\s\S]*?test\/web-console\.test\.js supervisor lifecycle executor manifest readiness/i, 'README Gold blockers section should mention V1.04 manifest Web evidence');
    assertReadmeContains(/Gold blockers[\s\S]*?V1\.03[\s\S]*?POST \/api\/supervisor-lifecycle-executor-manifest-readiness[\s\S]*?guarded-executor-runner-missing/i, 'README Gold blockers section should retain V1.03 manifest API evidence');
    assertReadmeContains(/Gold blockers[\s\S]*?V1\.02[\s\S]*?agent\.js supervisor-lifecycle-executor-manifest-readiness[\s\S]*?test\/agent-supervisor-lifecycle-executor-manifest-readiness\.test\.js/i, 'README Gold blockers section should retain V1.02 manifest CLI evidence');
    assertReadmeContains(/Gold blockers[\s\S]*?V1\.01[\s\S]*?validateSupervisorLifecycleExecutorManifest[\s\S]*?test\/supervisor-lifecycle-executor-manifest\.test\.js/i, 'README Gold blockers section should retain V1.01 pure manifest evidence');
    assertReadmeContains(/Gold blockers[\s\S]*?V1\.00[\s\S]*?supervisor-lifecycle-executor-readiness-button[\s\S]*?test\/web-console\.test\.js supervisor lifecycle executor readiness/i, 'README Gold blockers section should retain V1.00 Web evidence');
    assertReadmeContains(/Gold blockers[\s\S]*?V0\.99[\s\S]*?POST \/api\/supervisor-lifecycle-executor-readiness[\s\S]*?test\/supervisor-lifecycle-executor-readiness-api\.test\.js/i, 'README Gold blockers section should mention V0.99 API evidence');
    assertReadmeContains(/Gold blockers[\s\S]*?V0\.98[\s\S]*?agent\.js supervisor-lifecycle-executor-readiness[\s\S]*?test\/agent-supervisor-lifecycle-executor-readiness\.test\.js/i, 'README Gold blockers section should retain V0.98 CLI evidence');
    assertReadmeContains(/Gold blockers[\s\S]*?buildSupervisorLifecycleExecutorReadiness[\s\S]*?test\/supervisor-lifecycle-executor-readiness\.test\.js/i, 'README Gold blockers section should mention V0.98 pure function evidence');
    assertReadmeContains(/NAS、认证和生产硬化仍是 partial[\s\S]*?V1\.27[\s\S]*?resolveSupervisorLifecycleGuardedRunnerRollbackAnchor[\s\S]*?rollbackAnchorReadiness\.state:ready[\s\S]*?rollbackAnchorReady:true[\s\S]*?V1\.26[\s\S]*?resolveSupervisorLifecycleGuardedRunnerHostMutationAdapter[\s\S]*?hostMutationAdapterReadiness\.state:ready[\s\S]*?hostMutationAdapterReady:true[\s\S]*?V1\.25[\s\S]*?resolveSupervisorLifecycleGuardedRunnerRegistry[\s\S]*?runnerRegistryReadiness\.state:ready[\s\S]*?runnerRegistryReady:true[\s\S]*?V1\.24[\s\S]*?evaluateSupervisorLifecycleGuardedRunnerExecutionPolicy[\s\S]*?executionPolicyReady:true[\s\S]*?V1\.23[\s\S]*?buildSupervisorLifecycleGuardedRunnerExecutionPolicyReadiness[\s\S]*?executionPolicyReady:false[\s\S]*?V1\.22[\s\S]*?buildSupervisorLifecycleGuardedRunnerOperatorRecoveryReadiness[\s\S]*?operatorRecoveryReady:false[\s\S]*?V1\.21[\s\S]*?buildSupervisorLifecycleGuardedRunnerAttemptAuditReadiness[\s\S]*?attemptAuditReady:false[\s\S]*?V1\.20[\s\S]*?buildSupervisorLifecycleGuardedRunnerRollbackAnchorReadiness[\s\S]*?rollbackAnchorReady:false[\s\S]*?V1\.19[\s\S]*?buildSupervisorLifecycleGuardedRunnerHostMutationAdapterReadiness[\s\S]*?hostMutationAdapterReady:false[\s\S]*?V1\.18[\s\S]*?buildSupervisorLifecycleGuardedRunnerRegistryReadiness[\s\S]*?runnerRegistryReady:false[\s\S]*?V1\.17[\s\S]*?buildSupervisorLifecycleGuardedRunnerWiringContract[\s\S]*?runnerWiringContractReady:false[\s\S]*?V1\.16[\s\S]*?supervisor-lifecycle-guarded-runner-execution-gate-button[\s\S]*?V1\.15[\s\S]*?POST \/api\/supervisor-lifecycle-guarded-runner-execution-gate[\s\S]*?V1\.14[\s\S]*?src\/agent\.js supervisor-lifecycle-guarded-runner-execution-gate[\s\S]*?V1\.13[\s\S]*?buildSupervisorLifecycleGuardedRunnerExecutionGate[\s\S]*?V1\.12[\s\S]*?supervisor-lifecycle-guarded-runner-execution-preview-button[\s\S]*?V1\.11[\s\S]*?POST \/api\/supervisor-lifecycle-guarded-runner-execution-preview[\s\S]*?V1\.10[\s\S]*?agent\.js supervisor-lifecycle-guarded-runner-execution-preview[\s\S]*?V1\.09[\s\S]*?buildSupervisorLifecycleGuardedRunnerExecutionPreview[\s\S]*?V1\.08[\s\S]*?supervisor-lifecycle-guarded-runner-readiness-button[\s\S]*?V1\.07[\s\S]*?POST \/api\/supervisor-lifecycle-guarded-runner-readiness[\s\S]*?V1\.06[\s\S]*?src\/agent\.js supervisor-lifecycle-guarded-runner-readiness[\s\S]*?V1\.05[\s\S]*?buildSupervisorLifecycleGuardedRunnerReadiness[\s\S]*?V1\.04[\s\S]*?supervisor-lifecycle-executor-manifest-readiness-button[\s\S]*?V1\.03[\s\S]*?POST \/api\/supervisor-lifecycle-executor-manifest-readiness/i, 'README partial hardening section should mention V1.23 execution policy readiness and V1.22 operator recovery readiness evidence through V1.03 API evidence');
  });
});

describe('README — long-lived safety boundaries', () => {
  it('documents installApprovalManifest as full-output only and dry-run-only', () => {
    assertReadmeContains(/installApprovalManifest\.state:"blocked"/, 'README should document blocked approval manifest state');
    assertReadmeContains(/installApprovalManifest\.approval\.approved:false/, 'README should document unapproved operator approval state');
    assertReadmeContains(/installApprovalManifest\.rollback\.available:false/, 'README should document unavailable rollback state');
    assertReadmeContains(/--readiness-summary[^\\n]*(不输出|excludes)[^\\n]*installApprovalManifest/i, 'README should say readiness summary excludes installApprovalManifest');
    assertReadmeContains(/不收集批准|approvalCollected:false|approvalPersisted:false/i, 'README should document no approval collection or persistence');
    assertReadmeContains(/rollbackExecuted:false|uninstallExecuted:false|recoverySupervisorStarted:false/i, 'README should document no rollback, uninstall, or recovery supervisor execution');
  });

  it('documents installPreflight as full-output only and dry-run-only', () => {
    assertReadmeContains(/installPreflight\.state:"blocked"/, 'README should document blocked preflight state');
    assertReadmeContains(/installPreflight\.checks:requiredForInstall:true/, 'README should document required preflight checks');
    assertReadmeContains(/--readiness-summary[^\\n]*(不输出|excludes)[^\\n]*installPreflight/i, 'README should say readiness summary excludes installPreflight');
    assertReadmeContains(/不调用 launchctl|launchctlCalled:false/, 'README should keep launchctl boundary');
    assertReadmeContains(/不写 LaunchAgents|launchdFileWritten:false/, 'README should keep launchd write boundary');
    assertReadmeContains(/不连接 NAS|nasConnected:false/, 'README should keep NAS boundary');
  });

  it('keeps documenting hardening-status API, CLI, and Web panel safety boundaries', () => {
    assertReadmeContains(/agent\.js hardening-status/, 'README should document hardening-status CLI');
    assertReadmeContains(/GET \/api\/hardening-status/, 'README should document hardening-status endpoint');
    assertReadmeContains(/hardening-status-panel|硬化状态面板|Web Console[^\\n]*hardening-status/i, 'README should document hardening-status Web panel');
    assertReadmeContains(/无启动请求|不触发启动请求|no startup/i, 'README should document no startup request');
    assertReadmeContains(/不自动轮询|no polling|no auto/i, 'README should document no auto polling');
    assertReadmeContains(/不写入\s*metadata|不写入\s*元数据|no metadata/i, 'README should document no metadata writes');
    assertReadmeContains(/tokenValuesReturned:false/, 'README should document tokenValuesReturned false');
    assertReadmeContains(/restoreRootValueReturned:false/, 'README should document restoreRootValueReturned false');
    assertReadmeContains(/auditPathReturned:false/, 'README should document auditPathReturned false');
    assertReadmeContains(/Agent hardening-status CLI/, 'README should document Agent hardening-status CLI test coverage');
    assertReadmeContains(/Web hardening-status panel|hardening-status Web panel|硬化状态面板/, 'README should document Web hardening-status test coverage');
  });

  it('documents audit-log Agent CLI safety boundaries', () => {
    assertReadmeContains(/agent\.js audit-log|node src\/agent\.js audit-log/, 'README should document audit-log CLI');
    assertReadmeContains(/GET \/api\/audit-log/, 'README should document audit-log endpoint');
    assertReadmeContains(/--limit/, 'README should document audit-log --limit option');
    assertReadmeContains(/--token/, 'README should document audit-log --token option');
    assertReadmeContains(/sanitized|脱敏|allowlist|不记录/i, 'README should document sanitized audit output');
    assertReadmeContains(/不写入\s*metadata|不写入\s*元数据|no metadata/i, 'README should document no metadata writes');
    assertReadmeContains(/不连接 NAS|no NAS/i, 'README should document no NAS connection');
    assertReadmeContains(/production-grade audit|生产级审计/i, 'README should document production-grade audit boundary');
  });

  it('documents audit-log Web panel safety boundaries', () => {
    assertReadmeContains(/audit-log-panel|审计日志面板|Web Console[^\\n]*audit-log/i, 'README should document audit-log Web panel');
    assertReadmeContains(/GET \/api\/audit-log/, 'README should document audit-log endpoint for Web panel');
    assertReadmeContains(/无启动请求|不触发启动请求|no startup/i, 'README should document no startup request');
    assertReadmeContains(/不自动轮询|no polling|no auto/i, 'README should document no auto polling');
    assertReadmeContains(/不写入\s*metadata|不写入\s*元数据|no metadata/i, 'README should document no metadata writes');
    assertReadmeContains(/不连接 NAS|no NAS/i, 'README should document no NAS connection');
    assertReadmeContains(/不执行.*备份|不执行.*恢复|不执行远程命令|no backup|no restore/i, 'README should document no backup/restore/remote execution');
    assertReadmeContains(/token|Authorization|sourcePath|targetPath|credential-like|sanitized|脱敏|allowlist/i, 'README should document sensitive audit fields are not displayed');
    assertReadmeContains(/buildAuditLogViewModel|Web audit-log panel|审计日志面板/, 'README should document Web audit-log test coverage');
  });

  it('documents Agent gold-readiness CLI safety boundaries', () => {
    assertReadmeContains(/agent\.js gold-readiness|node src\/agent\.js gold-readiness/, 'README should document gold-readiness CLI');
    assertReadmeContains(/GET \/api\/gold-readiness/, 'README should document gold-readiness endpoint');
    assertReadmeContains(/--fail-on-blocked/, 'README should document gold-readiness fail-on-blocked option');
    assertReadmeContains(/--token/, 'README should document gold-readiness token option');
    assertReadmeContains(/只读|read-only/i, 'README should document read-only boundary');
    assertReadmeContains(/不写入\s*metadata|不写入\s*元数据|no metadata/i, 'README should document no metadata writes');
    assertReadmeContains(/不连接 NAS|no NAS/i, 'README should document no NAS connection');
    assertReadmeContains(/不执行.*备份|不执行.*恢复|不执行真实 NAS|no backup|no restore/i, 'README should document no backup/restore/real NAS execution');
    assertReadmeContains(/Agent gold-readiness CLI|Agent gold-readiness fail-on-blocked/, 'README should document Agent gold-readiness test coverage');
  });

  it('keeps historical supervisor install evidence documented while V0.91 is current', () => {
    assertReadmeContains(/Agent CLI[\s\S]*?V0\.83[\s\S]*?installApprovalManifest/i, 'README Agent CLI Gold section should mention V0.83 installApprovalManifest');
    assertReadmeContains(/V0\.84[\s\S]*?POST `?\/api\/supervisor-install-dry-run`?[\s\S]*?buildSupervisorInstallDryRunViewModel/i, 'README should keep V0.84 Web panel evidence as historical context');
    assertReadmeContains(/V0\.85[\s\S]*?rollbackUninstallPlan\.state:"blocked"[\s\S]*?rollbackUninstallPlan\.actions:wouldRun:false/i, 'README should keep V0.85 rollback uninstall dry-run evidence as historical context');
    assertReadmeContains(/V0\.86[\s\S]*?rollbackUninstallPlan Web Console rendering[\s\S]*?buildSupervisorInstallDryRunViewModel rollbackUninstallActions/i, 'README should keep V0.86 Web panel evidence as historical context');
    assertReadmeDoesNotContain(/Gold blockers\*\*：V0\.90 基于/, 'README Gold blockers section should not keep V0.90 as current evidence');
    assertReadmeDoesNotContain(/NAS、认证和生产硬化仍是 partial\*\*：V0\.90 基于/, 'README partial hardening section should not keep V0.90 as current evidence');
  });

  it('documents Agent auth-status CLI safety boundaries', () => {
    assertReadmeContains(/agent\.js auth-status|node src\/agent\.js auth-status/, 'README should document auth-status CLI');
    assertReadmeContains(/GET \/api\/auth-status/, 'README should document auth-status endpoint');
    assertReadmeContains(/--token/, 'README should document auth-status token option');
    assertReadmeContains(/tokenValuesReturned:false|不返回 token|token material/i, 'README should document token material exclusion');
    assertReadmeContains(/不写入\s*metadata|不写入\s*元数据|no metadata/i, 'README should document no metadata writes');
    assertReadmeContains(/不连接 NAS|no NAS/i, 'README should document no NAS connection');
    assertReadmeContains(/Agent auth-status CLI/, 'README should document Agent auth-status test coverage');
  });

  it('documents supervisor-status API and CLI safety boundaries', () => {
    assertReadmeContains(/agent\.js supervisor-status|node src\/agent\.js supervisor-status/, 'README should document supervisor-status CLI');
    assertReadmeContains(/GET \/api\/supervisor-status/, 'README should document supervisor-status endpoint');
    assertReadmeContains(/--token/, 'README should document supervisor-status token option');
    assertReadmeContains(/not_configured|installed:false|managed:false/, 'README should document not_configured supervisor state');
    assertReadmeContains(/launchctlCalled:false|不调用 launchctl/i, 'README should document no launchctl call');
    assertReadmeContains(/processListRead:false|不读取进程/i, 'README should document no process list read');
    assertReadmeContains(/supervisorInstalled:false|不安装/i, 'README should document no supervisor installation');
    assertReadmeContains(/metadataWritten:false|不写入\s*metadata|不写入\s*元数据/i, 'README should document no metadata writes');
    assertReadmeContains(/nasConnected:false|不连接 NAS/i, 'README should document no NAS connection');
    assertReadmeContains(/backupTriggered:false|restoreTriggered:false|remoteCommandExecuted:false|不触发备份|不触发恢复|不执行远程命令/i, 'README should document no backup/restore/remote command');
    assertReadmeContains(/Agent supervisor-status CLI|buildSupervisorStatusResponse|GET \/api\/supervisor-status/, 'README should document supervisor-status test coverage');
  });

  it('documents supervisor-status Web panel safety boundaries', () => {
    assertReadmeContains(/supervisor-status-panel|Supervisor status API\/CLI\/Web|Web Console[^\\n]*supervisor-status/i, 'README should document supervisor-status Web panel');
    assertReadmeContains(/GET \/api\/supervisor-status/, 'README should document supervisor-status endpoint for Web panel');
    assertReadmeContains(/手动 GET|仅在用户点击|manual/i, 'README should document manual refresh');
    assertReadmeContains(/无启动请求|不触发启动请求|no startup/i, 'README should document no startup request');
    assertReadmeContains(/不自动轮询|no polling|no auto/i, 'README should document no auto polling');
    assertReadmeContains(/不调用 launchctl/i, 'README should document no launchctl call');
    assertReadmeContains(/不读取进程列表|processListRead:false/i, 'README should document no process list read');
    assertReadmeContains(/不安装或启动|supervisorInstalled:false/i, 'README should document no supervisor install/start');
    assertReadmeContains(/不写入\s*metadata|metadataWritten:false/i, 'README should document no metadata writes');
    assertReadmeContains(/不连接 NAS|nasConnected:false/i, 'README should document no NAS connection');
    assertReadmeContains(/不触发备份|不触发恢复|不执行远程命令|backupTriggered:false|restoreTriggered:false|remoteCommandExecuted:false/i, 'README should document no backup/restore/remote command');
    assertReadmeContains(/token|Authorization header|路径|环境变量值|buildSupervisorStatusViewModel/i, 'README should document sensitive fields are not displayed and view model coverage exists');
    assertReadmeContains(/Web supervisor-status panel|supervisor-status-panel|buildSupervisorStatusViewModel/, 'README should document supervisor-status Web test coverage');
  });

  it('documents supervisor-install-dry-run CLI safety boundaries', () => {
    assertReadmeContains(/agent\.js supervisor-install-dry-run|node src\/agent\.js supervisor-install-dry-run/, 'README should document supervisor-install-dry-run CLI');
    assertReadmeContains(/--config/, 'README should document supervisor-install-dry-run --config option');
    assertReadmeContains(/--readiness-summary/, 'README should document supervisor-install-dry-run readiness summary option');
    assertReadmeContains(/--fail-on-blocked/, 'README should document supervisor-install-dry-run fail-on-blocked option');
    assertReadmeContains(/readinessSummary|readiness summary|就绪摘要/i, 'README should document supervisor-install-dry-run readiness summary output');
    assertReadmeContains(/installCommandPreview/i, 'README should document supervisor-install-dry-run command preview output');
    assertReadmeContains(/state:"blocked"|state:'blocked'|state.*blocked|blocked.*state/i, 'README should document blocked readiness state');
    assertReadmeContains(/wouldRun:false|wouldWrite:false|non-runnable|不可执行/i, 'README should document non-runnable command preview flags');
    assertReadmeContains(/退出码\s*2|exit code\s*2|exits?\s*2/i, 'README should document fail-on-blocked exit code 2');
    assertReadmeContains(/buildSupervisorInstallDryRunPlan|buildSupervisorInstallReadinessSummary|buildSupervisorInstallCommandPreview|buildSupervisorInstallPreflight|buildSupervisorInstallApprovalManifest|test\/agent-supervisor-install-dry-run\.test\.js/, 'README should document supervisor-install-dry-run test coverage');
    assertReadmeContains(/wouldInstall:false|不安装/i, 'README should document no install');
    assertReadmeContains(/wouldStart:false|不启动/i, 'README should document no start');
    assertReadmeContains(/launchctlCalled:false|不调用 launchctl/i, 'README should document no launchctl call');
    assertReadmeContains(/processListRead:false|不读取进程/i, 'README should document no process list read');
    assertReadmeContains(/launchdFileWritten:false|不写.*LaunchAgents|不写.*plist/i, 'README should document no launchd/plist write');
    assertReadmeContains(/metadataWritten:false|不写入\s*metadata/i, 'README should document no metadata writes');
    assertReadmeContains(/nasConnected:false|不连接 NAS/i, 'README should document no NAS connection');
    assertReadmeContains(/backupTriggered:false|restoreTriggered:false|remoteCommandExecuted:false|不触发备份|不触发恢复|不执行远程命令/i, 'README should document no backup/restore/remote command');
    assertReadmeContains(/config path|sourcePath|serverUrl|NAS endpoint|credentialRef|Authorization|token|不显示|不回显/i, 'README should document sensitive values are not displayed');
    assertReadmeContains(/--output.*not supported|不支持 --output|不会写输出文件/i, 'README should document --output is not supported');
  });

  it('keeps Gold blocked and rejects production hardening overclaims', () => {
    assertReadmeContains(/Gold[^\\n]*(blocked|阻塞|依旧 blocked|仍 blocked)/i, 'README should keep Gold blocked');
    assertReadmeContains(/真实 installer|real installer|真实安装/, 'README should say real installer remains future work');
    assertReadmeContains(/watchdog|monitoring|recovery supervisor|secret management/i, 'README should list remaining hardening gaps');
    assertReadmeDoesNotContain(/Gold ready|production ready|real NAS remote backup ready|daemon installed|launchd installed|always-running|real installer implemented|production-ready supervisor|真实 NAS 备份已实现|生产可用/i, 'README should not claim production readiness');
  });

  it('documents supervisor-install-dry-run Web panel safety boundaries', () => {
    assertReadmeContains(/supervisor-install-dry-run-panel|POST `?\/api\/supervisor-install-dry-run`?|buildSupervisorInstallDryRunViewModel/i, 'README should document supervisor install dry-run Web panel');
    assertReadmeContains(/不调用 launchctl[\s\S]*不读取进程列表[\s\S]*不安装[\s\S]*不启动/i, 'README should preserve supervisor install Web panel safety boundaries');
    assertReadmeContains(/Gold.*blocked|Gold.*未完成/i, 'README should keep Gold blocked for supervisor install Web panel');
  });
});

describe('README — V0.52 Gold readiness scorecard docs', () => {

  it('documents the gold-readiness API endpoint and Web Console gold-readiness panel', () => {
    assert.match(readme, /GET\s+\/api\/gold-readiness/);
    assert.match(readme, /gold-readiness-panel|Gold readiness Web panel/i);
  });

  it('documents Gold blockers', () => {
    assert.match(readme, /security-auth/);
    assert.match(readme, /real-nas-remote-backup/);
    assert.match(readme, /production-hardening/);
  });

  it('asserts release-readiness is distinct from gold-readiness (runtime/version gate vs capability/blocker scorecard)', () => {
    assert.match(readme, /(release-readiness|release readiness).*(gold-readiness|gold readiness)|(gold-readiness|gold readiness).*(release-readiness|release readiness)/i);
    assert.match(readme, /runtime|version gate|运行|版本/i);
    assert.match(readme, /capability|blocker|scorecard|评估|卡点|指标|看板/i);
  });

  it('documents static code-owned scorecard maintenance rule or static item list maintenance', () => {
    assert.match(readme, /static|code-owned|scorecard|maintenance|静态|代码所有|维护/i);
  });

  it('asserts safety docs / disclaimers for Gold readiness', () => {
    // no production readiness claim
    assert.match(readme, /no.*production.*ready|不(承诺|包含).*生产/i);
    // no real NAS connection
    assert.match(readme, /不(建立|连接).*真实.*NAS|no.*real.*NAS/i);
    // authentication remains partial, not a complete Gold authorization claim
    assert.match(readme, /security-auth[\s\S]*(partial|部分)|Bearer[\s\S]*(partial|部分)|不.*完整.*鉴权/i);
  });
});


describe('README — G0a real two-Mac acceptance harness', () => {
  it('documents the exact test-only safety boundary', () => {
    assertReadmeContains(/LINKE_REAL_G0A_ACCEPTANCE=enabled/, 'exact real G0a gate');
    assertReadmeContains(/SSH alias/i, 'preconfigured SSH alias only');
    assertReadmeContains(/0600/, 'private bundle and receipt mode');
    assertReadmeContains(/test-only|测试专用/i, 'test-only harness');
    assertReadmeContains(/Gold[^\n]*(BLOCKED|blocked)/, 'Gold remains blocked despite G0a real PASS');
  });

  it('documents repository-relative direct node entry without secrets', () => {
    assertReadmeContains(
      /node test\/helpers\/g0a-real-controller-runner\.js/,
      'controller direct entry',
    );
    assertReadmeContains(
      /node test\/helpers\/g0a-real-endpoint-runner\.js <phase>/,
      'endpoint direct entry with phase',
    );
    assertReadmeContains(/dedicated run directory/i, 'cwd must be dedicated run directory');
    assertReadmeContains(/额外 argv 固定拒绝|exactly one fixed phase/i, 'extra argv rejection');
    assertReadmeContains(/零副作用|zero side effects/i, 'import has zero side effects');
  });

  it('locks sanitized real dual-Mac PASS evidence without Gold release claim', () => {
    assertReadmeContains(
      /docs\/superpowers\/reports\/2026-07-13-g0a-real-keychain-lan-acceptance\.md/,
      'sanitized real-gate report path',
    );
    assertReadmeContains(/10ffad69e6a3/, 'source commit abstract id');
    assertReadmeContains(/G0A-REAL-20260714-01/, 'abstract commandId only');
    assertReadmeContains(/2026-07-14T07:02:50\.301Z/, 'final real acceptance UTC');
    assertReadmeContains(/promptHandled\s*=\s*true|promptHandled=true/, 'manual Keychain UI handled');
    assertReadmeContains(
      /Controller\/PM[^\n]*Node major `?24`?|Node major `?24`?[^\n]*macOS major `?26`?/,
      'Controller/PM runtime baseline majors',
    );
    assertReadmeContains(/device-token-invalid/, 'rotate old-token rejection code');
    assertReadmeContains(/device-protocol-unsupported/, 'N-2 rejection code');
    assertReadmeContains(/device-revoked/, 'post-revoke rejection code');
    assertReadmeContains(/device-tls-fingerprint-mismatch/, 'old-pin mismatch code');
    assertReadmeContains(/G0a 真实双机验收已通过|真实双 Mac[\s\S]{0,80}PASS/i, 'G0a real dual-Mac PASS');
    assertReadmeContains(
      /Gold[^\n]*(BLOCKED|blocked)|Linke Gold[^\n]*(BLOCKED|blocked)/i,
      'Gold remains blocked for other blockers',
    );
    assertReadmeContains(/不得宣称完整版发布完成/, 'explicit non-claim of full release');
    assert.doesNotMatch(readme, /Gold ready|Gold-ready/i);
  });

  it('does not describe automation as real hardware proof', () => {
    assertReadmeDoesNotContain(/自动测试[^\n]*(真实双 Mac|真实 Keychain)[^\n]*(PASS|通过)/i,
      'automation must not claim real hardware PASS');
  });
});

describe('README — V1.46 management auth Keychain source', () => {
  it('documents the selector contract', () => {
    assertReadmeContains(/LINKE_MANAGEMENT_AUTH_SOURCE/, 'selector env name');
    assertReadmeContains(/精确(小写)?\s*`keychain`/, 'exact lowercase keychain selector');
    assertReadmeContains(/legacy/, 'legacy default when selector undefined');
  });

  it('documents scopes env, parsing rules and allowed set', () => {
    assertReadmeContains(/LINKE_MANAGEMENT_AUTH_KEYCHAIN_SCOPES/, 'scopes env name');
    assertReadmeContains(/逐项 trim/i, 'per-item trim');
    assertReadmeContains(/声明顺序/, 'declared order retained');
    for (const scope of [
      'full',
      'previous-full',
      'read',
      'previous-read',
      'write',
      'previous-write',
      'admin',
      'previous-admin',
    ]) {
      assertReadmeContains(new RegExp(`\`${scope}\``), `allowed scope ${scope}`);
    }
    assertReadmeContains(/至少(声明)?一个 current scope/i, 'at least one current scope');
  });

  it('documents the fixed item mapping under the default service', () => {
    assertReadmeContains(/com\.linke\.gold/, 'default Keychain service');
    for (const item of [
      'management-auth.full',
      'management-auth.full.previous',
      'management-auth.read',
      'management-auth.read.previous',
      'management-auth.write',
      'management-auth.write.previous',
      'management-auth.admin',
      'management-auth.admin.previous',
    ]) {
      assertReadmeContains(new RegExp(item.replace(/\./g, '\\.')), `Keychain item ${item}`);
    }
  });

  it('documents direct-token mixing rejection with no fallback', () => {
    assertReadmeContains(/无 fallback|不回退/i, 'no fallback wording');
    for (const name of [
      'LINKE_AUTH_TOKEN',
      'LINKE_TOKEN',
      'LINKE_PREVIOUS_AUTH_TOKEN',
      'LINKE_READ_TOKEN',
      'LINKE_PREVIOUS_READ_TOKEN',
      'LINKE_WRITE_TOKEN',
      'LINKE_PREVIOUS_WRITE_TOKEN',
      'LINKE_ADMIN_TOKEN',
      'LINKE_PREVIOUS_ADMIN_TOKEN',
    ]) {
      assertReadmeContains(new RegExp(name), `mixing rejection covers ${name}`);
    }
  });

  it('documents startup snapshot and controlled restart', () => {
    assertReadmeContains(/startup snapshot|启动快照/i, 'startup snapshot');
    assertReadmeContains(/受控重启|controlled restart/i, 'controlled restart');
    assertReadmeContains(/hot reload/i, 'no hot reload wording');
  });

  it('documents the bounded headless security runner timeout', () => {
    assertReadmeContains(/10 秒[^\n]*硬(截止|超时)|hard timeout[^\n]*10/i,
      'security runner hard timeout');
    assertReadmeContains(/kill[^\n]*(stdio|标准流)|销毁[^\n]*(stdio|标准流)/i,
      'timeout child and stdio cleanup');
    assertReadmeContains(/keychain-unavailable/, 'fixed timeout failure code');
  });

  it('documents fake Keychain boundary, no real credentials and Gold partial wording', () => {
    assertReadmeContains(/fake Keychain/i, 'fake Keychain only in tests');
    assertReadmeContains(/不使用真实凭据|no real credential/i, 'no real credentials');
    assertReadmeContains(/Gold 仍 partial|Gold remains partial/i, 'Gold remains partial');
    assertReadmeContains(/security-auth/, 'security-auth partial reference');
  });
});
