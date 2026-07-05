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
  it('title and badge claim V0.50 as current', () => {
    assert.match(readme, /^# Linke V0\.50/m);
    assert.match(readme, /当前版本：V0\.50/);
  });

  it('version table has V0.50 row with 当前版本 milestone', () => {
    assert.match(readme, /\| V0\.50 \| 当前版本 \|[^|]*(发布就绪|release readiness)/i);
  });

  it('documents the release-readiness command and exit-code semantics', () => {
    assert.match(readme, /agent\.js release-readiness/);
    assert.match(readme, /--expected-version/);
    assert.match(readme, /ready:false|ready.*false/);
    assert.match(readme, /退出码\s*2|exit code\s*2/i);
    assert.match(readme, /退出码\s*1|exit code\s*1/i);
  });

  it('asserts safety docs for release-readiness CLI', () => {
    assert.match(readme, /只读/);
    assert.match(readme, /GET\s+\/api\/health/);
    assert.match(readme, /不写入(任何)?元数据|不写入(any)?metadata/);
    assert.match(readme, /不建立真实 NAS 连接|不连接 NAS/);
    assert.match(readme, /不执行(任何)?远程命令|不执行远程命令/);
    assert.match(readme, /不回显原始 health|不输出原始 health|sanitized/i);
  });

  it('documents testing coverage includes release readiness CLI', () => {
    assert.match(readme, /测试覆盖：.*发布就绪检查 CLI|测试覆盖：.*release readiness CLI/i);
  });
});
