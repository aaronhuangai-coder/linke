# Linke V0.68

轻量级备份与恢复代理，带 Web 管理控制台。

> **当前版本：V0.68** — 单机 localhost 原型阶段，具备 NAS CLI readiness-summary 摘要输出、NAS 执行就绪性摘要、目标就绪状态与 blocker codes 网页控制台只读展示、credentialRefConfigured sanitized dry-run 输出与网页展示、不泄露 credentialRef 原值、15 个 credential-like 字段精确拒绝与执行门禁网页展示、credentialRef 非密钥引用基础、固定 executionGate 远程执行阻塞、可选 Bearer token API 认证骨架、read/write token 授权基础、共享写入路由注册表、GET `/api/auth-status` 认证状态只读接口、Web Console 内存态 token UX、请求体上限、500 错误脱敏、可选恢复目标 root guard、恢复目标 symlink 写入防护、本地 audit log foundation、可选 API rate-limit foundation 与可选 audit retention foundation，但尚未具备真实 NAS 传输、完整生产级鉴权、分布式限流或生产级审计。

## 版本演进

| 版本 | 里程碑 | 主要内容 |
|------|--------|----------|
| V0.1 | 初始原型 | 设备心跳、快照备份/恢复、Web Console、原子写入、路径安全 |
| V0.2 | Agent CLI | `run-once` 命令：从配置文件批量执行备份，含心跳前置 |
| V0.3 | launchd 集成 | `launchd-dry-run` 命令：生成 launchd plist，不安装、不调用 launchctl |
| V0.4 | NAS dry-run | `nas-dry-run` 命令：验证 NAS 配置并输出计划，不连接 NAS、不写远端 |
| V0.5 | 文档补齐 | 文档与操作手册补齐 |
| V0.6 | Retention dry-run | `retention-dry-run`：快照保留策略 dry-run，只读不删 |
| V0.7 | Web retention panel | Web Console 新增保留计划面板，可视化查看 retention dry-run 结果 |
| V0.8 | Manifest detail | Web Console 新增只读快照清单详情面板，可查看 snapshot manifest 文件列表 |
| V0.9 | 快照差异 dry-run | `diff-dry-run`：按 manifest 文件路径比较两个快照，输出 added / removed / unchanged |
| V0.10 | 恢复预检 dry-run | `restore-dry-run`：预览恢复到目标目录的 would-create / would-overwrite，不复制、不覆盖、不写入 |
| V0.11 | 备份预检 dry-run | `backup-preflight-dry-run`：预览 sourcePath + excludePatterns 的 included / excluded，不创建快照、不复制、不写入 |
| V0.12 | Web backup preflight panel | Web Console 新增备份预检 dry-run 面板，可输入 sourcePath / excludePatterns 并查看 included / excluded |
| V0.13 | Web NAS dry-run panel | Web Console 新增 NAS dry-run 面板，可粘贴 nasTargets 配置并查看 wouldConnect:false / wouldWrite:false 的计划 |
| V0.14 | NAS app adapter dry-run | 为 Synology / Ugreen 目标生成应用嵌套调用计划，不调用 NAS app、不连接、不写入 |
| V0.15 | 设备详情面板 | Web Console 新增只读设备详情面板，展示 deviceId / hostname / ipAddress / status / lastHeartbeatAt / lastBackupAt / snapshotCount |
| V0.16 | 设备列表控制 | Web Console 设备面板新增搜索、状态过滤、排序和计数工具栏，纯前端只读派生视图 |
| V0.17 | 备份任务概览 | Web Console 新增只读备份任务概览面板，从现有 snapshot 元数据按 jobName/sourcePath 聚合任务视图 |
| V0.18 | 备份任务详情时间线 | Web Console 新增只读备份任务详情时间线，从既有 snapshot 元数据展示单个任务的历史版本 |
| V0.19 | 备份任务时间线 snapshot 联动 | Web Console 备份任务时间线 snapshot 联动，可点击任务历史版本并复用快照清单详情与恢复预检 dry-run |
| V0.20 | 事件日志面板增强 | Web Console 事件日志面板增强，展示前端内存态结构化事件、累计计数、最近事件和 50 条可见上限 |
| V0.21 | 设备备份健康 | Web Console 新增设备备份健康面板，基于现有设备状态、快照数和最后备份时间生成只读健康分类 |
| V0.22 | 备份版本一致性 | Web Console 新增备份版本一致性面板，从现有 snapshot 元数据比较跨设备任务最新版本 |
| V0.23 | 版本一致性 snapshot 联动 | Web Console 版本一致性 snapshot 联动，可点击设备版本行并复用快照清单详情与恢复预检 dry-run |
| V0.24 | 版本一致性筛选与搜索 | Web Console 版本一致性筛选与搜索，可按状态和任务 / 路径 / 设备 / IP 搜索任务组 |
| V0.25 | 版本一致性非最新摘要 | Web Console 版本一致性非最新摘要，在一致性面板中增加只读摘要 |
| V0.26 | 版本一致性排序控制 | Web Console 版本一致性排序控制，可按风险、最大时间差、非最新设备数、最近备份和任务名重排任务组 |
| V0.27 | 覆盖缺口摘要 Lite | 覆盖缺口摘要 Lite，在版本一致性面板增加只读覆盖缺口统计与各任务组覆盖情况 |
| V0.28 | 版本一致性覆盖筛选 | 在版本一致性面板增加只读覆盖筛选下拉框，按 all/gap/full 过滤任务组 |
| V0.29 | 版本一致性覆盖缺口排序 | 在版本一致性面板增加只读覆盖缺口排序选项，按缺失设备数、缺失率、预期设备数进行级联排序 |
| V0.30 | 版本一致性覆盖率显示 | 在各任务组覆盖行展示整数覆盖率百分比，分母为 0 时不显示覆盖率 |
| V0.31 | 版本一致性无可观测设备回退 | 当任务组 expectedDeviceCount <= 0 时展示无可观测设备并不包含覆盖率，> 0 时不展示无可观测设备 |
| V0.32 | 无可观测设备筛选 | 版本一致性无可观测设备筛选，在覆盖筛选下拉框增加 unobservable 选项 |
| V0.33 | 统一管理态 | 统一管理态：设备/IP 统一管理状态只读展示 |
| V0.34 | 管理态筛选 | 管理状态筛选与计数支持 |
| V0.35 | 管理态分桶统计 | 管理状态分桶统计与快速切换 |
| V0.36 | 管理态分桶选中态 | 分桶按钮 active 高亮与 aria-pressed 可访问状态 |
| V0.37 | 管理态分桶作用域 | 管理态分桶作用域：分桶计数按搜索和状态筛选联动 |
| V0.38 | 管理态判定提示 | 管理态判定提示：设备列表与详情展示只读处理提示 |
| V0.39 | 设备列表空态筛选上下文 | 设备列表空态筛选上下文：无匹配设备时展示当前搜索、状态和管理态筛选 |
| V0.40 | 设备筛选重置 | 设备筛选重置：一键清除搜索、状态、管理态和排序，不重新加载数据 |
| V0.41 | 设备筛选重置状态 | 无筛选时禁用重置按钮，有筛选时启用并暴露可访问状态 |
| V0.42 | 设备筛选摘要 | 设备筛选摘要：无筛选时展示默认筛选，有筛选时展示包含各筛选状态的当前筛选摘要 |
| V0.43 | 设备筛选摘要状态 | 设备筛选摘要增加只读 data-active 状态与 aria-atomic 可访问性支持 |
| V0.44 | 设备筛选计数状态 | 设备筛选计数状态：设备筛选计数增加只读 data-filtered 属性以指示列表是否被过滤收窄 |
| V0.45 | 历史版本 | 设备筛选计数指标：设备筛选计数增加只读 data-visible-count 与 data-total-count 属性以展示可见数与总数 |
| V0.46 | 历史版本 | 发布健康检查：提供 release health 接口 GET /api/health，输出只读系统状态 |
| V0.47 | 历史版本 | 发布健康检查 CLI：提供 agent CLI health 命令获取只读健康状态，不影响元数据或 NAS，安全隔离 |
| V0.48 | 历史版本 | 发布健康检查面板：Web Console 增加发布健康检查面板，通过 GET /api/health 手动刷新只读状态，不自动轮询 |
| V0.49 | 历史版本 | 发布版本一致性守卫：以 `src/version.js` 作为当前发布版本单一来源，并用测试校验 README、`/api/health` 和 Agent health 输出一致 |
| V0.50 | 历史版本 | 发布就绪检查 CLI：`release-readiness` 基于 `/api/health` 输出 sanitized readiness report，并用退出码 0/2/1 区分 ready、not ready 和请求错误 |
| V0.51 | 历史版本 | 发布就绪网页控制台：新增 GET `/api/release-readiness` 与 `release-health-panel` 内的 release readiness panel，手动检查发布就绪状态 |
| V0.52 | 历史版本 | Gold readiness Web panel：新增 GET `/api/gold-readiness` 与 `gold-readiness-panel`，展示 Gold readiness scorecard docs、capability/blocker 评分卡和 Gold blockers |
| V0.53 | 历史版本 | Optional Bearer token auth skeleton：`LINKE_AUTH_TOKEN` / `LINKE_TOKEN` 启用 API Bearer token 检查，Agent CLI 支持 `--token <token>` |
| V0.54 | 历史版本 | Web Console in-memory API token UX：浏览器可输入/清除 API token，内存态发送 `Authorization: Bearer <token>`，不写 localStorage、sessionStorage、cookie 或 metadata |
| V0.55 | 历史版本 | Server request/error hardening：JSON 请求体上限 1 MiB，超限返回 413 `Request body too large`；未知 500 仅返回 `Internal Server Error`，不回显内部错误细节 |
| V0.56 | 历史版本 | Restore target guard：配置 `LINKE_RESTORE_ROOT` 后，`/api/restore` 与 `restore-dry-run` 的 targetPath 只能位于恢复 root 内，并拒绝 symlink 逃逸 |
| V0.57 | 历史版本 | Restore destination symlink defense：配置 `LINKE_RESTORE_ROOT` 后，真实 restore 写入会拒绝目标文件 symlink 与中间目录 symlink，并使用 `O_NOFOLLOW` 避免覆盖 root 外文件 |
| V0.58 | 历史版本 | Audit log foundation：新增本地 `dataDir/audit/events.jsonl` JSONL 审计基础与 GET `/api/audit-log` 只读查询，记录 auth.denied、backup/restore/heartbeat 结果且不保存 token、sourcePath、targetPath 或 NAS endpoint |
| V0.59 | 历史版本 | API rate-limit foundation：通过 `LINKE_RATE_LIMIT_PER_MINUTE` 可选启用 `/api/*` 单进程内存限流，超过返回 429 `Rate limit exceeded` 并记录 `api.rate_limited` |
| V0.60 | 历史版本 | Audit retention foundation：通过 `LINKE_AUDIT_MAX_EVENTS` 可选保留 `events.jsonl` 最新 N 条审计事件，默认关闭，不声明生产级审计 |
| V0.61 | 历史版本 | API read/write token foundation：通过 `LINKE_READ_TOKEN` / `LINKE_WRITE_TOKEN` 可选区分读/写 API 授权，读 token 写入返回 403 `Forbidden` 并记录 `auth.forbidden` |
| V0.62 | 历史版本 | auth-status readiness API：新增只读 GET `/api/auth-status` 与 `buildAuthStatusResponse`，返回 `configuredScopes` / `writeRoutes`，不返回 token 值 |
| V0.63 | 历史版本 | Shared write-route registry：新增 `API_WRITE_ROUTES`、`formatApiRoute` 与 `isApiWriteRoute`，让 auth gate 与 auth-status `writeRoutes` 使用同一来源 |
| V0.64 | 历史版本 | NAS credential reference gate：新增 `credentialRef` 非密钥 slug 校验、`credentialRefConfigured` sanitized dry-run 输出与固定 `executionGate`，真实 NAS 传输仍 blocked |
| V0.65 | 历史版本 | Web NAS execution gate display：Web Console 支持展示 NAS 凭证配置状态与 executionGate 远程执行阻塞，不启用真实 NAS 传输，Gold 依旧 blocked |
| V0.66 | 历史版本 | NAS credential denylist hardening：`FORBIDDEN_NAS_CREDENTIAL_FIELDS` 扩展为 15 个 credential-like 精确键名，继续拒绝凭证字段且 Gold 依旧 blocked |
| V0.67 | 历史版本 | NAS execution readiness summary：新增 top-level `readinessSummary` 与 per-target `executionReadiness`，提供 target 阻碍卡点代码与就绪状态只读展示，不启用真实 NAS 传输，不泄露凭证原值且 Gold 依旧 blocked |
| V0.68 | 当前版本 | NAS CLI readiness summary：新增 `--readiness-summary` 命令行布尔参数，支持仅输出 `readinessSummary` 摘要，不泄露 target endpoint/paths 或凭证，Gold 依旧 blocked |


## 特性

- **设备心跳** — 注册设备并跟踪在线状态
- **设备列表控制** — Web Console 设备面板支持按名称 / Device ID / IP 搜索、按状态过滤（全部 / 在线 / 离线 / 未知）、按名称 / IP / 最后心跳 / 快照数排序，并实时显示可见 / 总数计数
- **设备备份健康** — Web Console 基于现有 `/api/devices` 数据生成前端只读健康分类，展示健康、需关注、离线和未知设备数量
- **备份版本一致性** — Web Console 只读读取现有设备快照，按 jobName / sourcePath 比较跨设备任务的最新版本是否一致
- **版本一致性 snapshot 联动** — Web Console 可从版本一致性面板点击设备版本行，并复用现有快照清单详情与恢复预检 dry-run 查看具体 snapshot
- **版本一致性筛选与搜索** — Web Console 可在版本一致性面板按全部 / 版本不一致 / 单设备 / 一致过滤，并按 jobName / sourcePath / deviceId / hostname / IP 搜索任务组，显示可见 / 总数计数
- **版本一致性非最新摘要** — Web Console 在备份版本一致性面板的每个任务组中增加只读摘要，展示最新和非最新设备数、单设备判定及最大时间差
- **版本一致性排序控制** — Web Console 可在版本一致性面板中按风险优先、最大时间差、非最新设备数、最近备份和任务名重排任务组，排序只作用于已加载的浏览器内存数据
- **覆盖缺口摘要 Lite** — Web Console 在版本一致性面板中增加只读覆盖缺口统计，展示可观测设备、加载失败排除设备、覆盖缺口任务数及完全覆盖任务数，并在各任务组行中显示具体覆盖比例及缺失设备
- **版本一致性覆盖筛选** — Web Console 支持在版本一致性面板按全部（all）/ 有覆盖缺口（gap） / 完全覆盖（full）过滤任务组，内存过滤联动不触发 snapshot 重新请求
- **版本一致性覆盖缺口排序** — Web Console 支持在版本一致性面板按覆盖缺口相关的指标在浏览器内存中对已加载的任务组进行级联降序排序
- **版本一致性覆盖率显示** — Web Console 在版本一致性面板的每个任务组覆盖行显示整数覆盖率百分比，分母为 0 时不显示覆盖率，避免 NaN 或误导性百分比
- **版本一致性无可观测设备回退** — Web Console 当版本一致性任务组 expectedDeviceCount <= 0 时在覆盖行展示无可观测设备且不显示覆盖率，expectedDeviceCount > 0 时不展示无可观测设备
- **版本一致性无可观测设备筛选** — Web Console 在版本一致性覆盖筛选中增加无可观测设备（unobservable）选项，仅显示 expectedDeviceCount <= 0 的任务组
- **备份任务概览** — Web Console 只读备份任务概览面板，从现有 snapshot 元数据按 jobName / sourcePath 聚合，展示任务数、快照总数、最近备份时间和每个任务的详情
- **备份任务详情时间线** — Web Console 可从备份任务概览中选择一个任务，只读查看该任务的历史快照时间线、源路径、快照数量和最近备份时间
- **备份任务时间线 snapshot 联动** — Web Console 可从备份任务详情时间线中选择单个历史 snapshot，并复用快照清单详情与恢复预检 dry-run 面板查看版本内容和恢复影响预览
- **设备详情** — Web Console 可只读查看设备的 deviceId、hostname、IP 地址、状态、最后心跳、最后备份和快照数
- **统一管理态** — Web Console 统一管理态支持基于设备状态和 IP 地址进行只读分类展示（在线可见 / 在线缺 IP / 离线保留 / 未知待确认），无任何写入、控制或修改操作
- **管理态筛选** — Web Console 管理态筛选支持在设备面板通过下拉框筛选不同管理状态（`visible`、`missing-ip`、`offline-retained`、`unknown`），并支持与已有状态和搜索词的 AND 复合检索，实时显示可见/总数计数
- **管理态分桶统计** — Web Console 设备面板展示 `all` / `visible` / `missing-ip` / `offline-retained` / `unknown` 分桶计数，并支持点击分桶快速切换现有管理态筛选
- **管理态分桶选中态** — Web Console 管理态分桶控件使用按钮语义，基于 `device-management-filter` 同步 active 高亮、`aria-pressed` 与 `data-active` 状态
- **管理态分桶作用域** — Web Console 管理态分桶计数会随搜索词和状态筛选同步变化，但忽略当前管理态筛选，便于在同一搜索 / 状态范围内快速切换管理态
- **管理态判定提示** — Web Console 在设备列表和设备详情中展示 `device-management-hint` / `device-detail-management-hint` 只读提示，解释在线可见、缺少可用 IP、离线保留和状态未知的判定原因
- **设备列表空态筛选上下文** — Web Console 在设备列表筛选后无匹配设备时展示 `device-empty-state` / `device-empty-filter-context`，显示当前搜索、状态和管理态筛选
- **设备筛选重置** — Web Console 设备控制条提供 `device-filter-reset` 只读按钮，一键恢复搜索、状态、管理态和排序默认值，并复用本地已加载数据重渲染
- **设备筛选重置状态** — Web Console 在搜索、状态、管理态或排序偏离默认值时启用 `device-filter-reset`，默认状态下禁用并同步 `disabled` / `aria-disabled` / `data-active`
- **设备筛选摘要** — Web Console 在设备筛选控件下方展示 `device-active-filter-summary` 只读摘要，默认显示“默认筛选”，有筛选时显示当前搜索、状态、管理态和排序
- **设备筛选摘要状态** — Web Console 设备筛选摘要（`device-active-filter-summary`）增加只读 `data-active` 状态（由 CSS 样式钩子使用）与 `aria-atomic="true"` 可访问性支持
- **设备筛选计数状态** — Web Console 设备筛选计数（`device-filter-count`）增加只读 `data-filtered` 属性以指示列表是否被过滤收窄
- **设备筛选计数指标** — Web Console 设备筛选计数（`device-filter-count`）增加只读 `data-visible-count` 与 `data-total-count` 属性，暴露当前可见数与总数
- **事件日志面板增强** — Web Console 事件日志面板增强，展示前端内存态结构化事件、累计计数、最近事件和 50 条可见上限
- **快照备份** — 将本地文件备份到仓库，支持并发隔离
- **快照恢复** — 从快照精确恢复文件（sha256 校验）
- **Web Console** — 管理界面：设备列表 / 设备详情 / 快照列表 / 快照清单详情 / 恢复预检 / 备份预检 / NAS 预检 / 快照差异预览 / 事件日志面板增强 / 保留计划面板 / 备份任务概览 / 备份任务详情时间线 / 备份任务时间线 snapshot 联动 / 设备备份健康 / 备份版本一致性 / 版本一致性 snapshot 联动 / 版本一致性筛选与搜索 / 版本一致性非最新摘要 / 版本一致性排序控制 / 覆盖缺口摘要 / 版本一致性覆盖筛选 / 版本一致性覆盖缺口排序 / 版本一致性覆盖率显示 / 版本一致性无可观测设备回退 / 版本一致性无可观测设备筛选 / 统一管理态 / 管理态筛选 / 管理态分桶统计 / 管理态分桶选中态 / 管理态分桶作用域 / 管理态判定提示 / 设备列表空态筛选上下文 / 设备筛选重置 / 设备筛选重置状态 / 设备筛选摘要 / 设备筛选摘要状态 / 设备筛选计数状态 / 设备筛选计数指标 / API token 内存态输入
- **原子写入** — 元数据写入使用 tmp + rename，保证一致性
- **路径安全** — deviceId slug 化，防止 path traversal
- **保留计划预览** — Web Console 与 CLI 均可查看 retention dry-run 结果，不执行删除
- **快照清单详情** — Web Console 可只读查看 snapshot manifest 的源路径、创建时间和文件清单
- **快照差异预览** — Web Console 可按 manifest 文件路径比较两个快照的 added / removed / unchanged
- **恢复预检** — API、CLI 与 Web Console 可预览 restore-dry-run 计划，显示 would-create / would-overwrite，不执行复制或覆盖
- **备份预检** — API、CLI 与 Web Console 可预览 backup-preflight-dry-run 计划，显示 included / excluded，不创建快照、不复制文件、不写 metadata
- **NAS dry-run** — API、CLI 与 Web Console 可验证 Synology / Ugreen 目标配置并输出计划；V0.68 支持 `nas-dry-run --readiness-summary` 命令行布尔参数，支持仅输出 `readinessSummary` 摘要，不泄露 target endpoint/paths 或凭证；V0.67 引入 `readinessSummary` 与 per-target `executionReadiness` 执行就绪性摘要、固定 blocker codes、`credentialRef` 非密钥引用基础、15 个 credential-like 字段精确拒绝、`credentialRefConfigured` 网页展示与 `executionGate` 门禁展示，不连接 NAS、不写远端、不保存凭证、不回显引用原值
- **NAS app adapter dry-run** — 为 Synology / Ugreen 目标生成 `adapterPlan`，显示 `wouldInvokeApp:false`，不调用 NAS app、不连接、不写远端
- **发布版本一致性守卫** — `src/version.js` 提供当前发布版本单一来源，测试会校验 README、`/api/health`、Agent health 输出和 Web Console 版本示例保持一致
- **发布就绪检查 CLI** — `agent.js release-readiness` 对 `/api/health` 执行一次只读检查，输出 sanitized readiness report，`ready:false` 时退出码 2，请求错误时退出码 1
- **发布就绪网页控制台** — Web Console 在 `release-health-panel` 内提供发布就绪检查区块，手动 GET `/api/release-readiness` 并展示 ready、版本与失败检查项
- **Gold readiness scorecard** — Web Console 提供 `gold-readiness-panel`，手动 GET `/api/gold-readiness` 展示静态 code-owned capability/blocker scorecard；V0.68 将 `nas-dry-run` (含 CLI readiness summary 摘要)、`security-auth` 与 `production-hardening` 标为 partial，`real-nas-remote-backup` 仍为 Gold blocker
- **可选 Bearer token API 认证骨架** — 服务端可通过 `LINKE_AUTH_TOKEN` 或 `LINKE_TOKEN` 为 `/api/*` 请求启用 `Authorization: Bearer <token>` 检查，Agent CLI 支持 `--token <token>`；这仍是 partial auth，不是完整生产级 authorization
- **API read/write token foundation** — 服务端可通过 `LINKE_READ_TOKEN` / `LINKE_WRITE_TOKEN` 区分只读 API 与写入 API；读 token 访问写入 API 返回 403 `Forbidden` 并记录 `auth.forbidden`，旧 `LINKE_AUTH_TOKEN` / `LINKE_TOKEN` 仍作为 full-access 兼容 token
- **Auth status readiness API** — GET `/api/auth-status` 返回 sanitized 认证状态（`enabled`、`configuredScopes`、`writeRoutes`），由 `buildAuthStatusResponse` 生成；启用 auth 时仍受 Bearer gate 保护，不返回 token 值、token prefix、Authorization header 或 env 原值，不写入 metadata
- **Shared write-route registry** — `API_WRITE_ROUTES` 是当前写入 API 的同一来源；`isApiWriteRoute` 供 Bearer auth gate 判断 read token 是否越权，`formatApiRoute` 供 GET `/api/auth-status` 输出 `writeRoutes`，避免写入路由授权与状态报告漂移
- **Web Console 内存态 API Token UX** — 页面顶部提供 API Token 输入、应用、清除与状态提示；token 只保存在当前页面内存中，刷新后需重新输入，不写 localStorage、sessionStorage、cookie 或 metadata；401 会清空 token 并提示认证失败
- **服务端请求/错误硬化** — JSON 请求体上限为 1 MiB，超限返回 413 `Request body too large` 且不写入 metadata；未知 500 响应统一为 `Internal Server Error`，不暴露 snapshotId、路径或内部错误消息；带 `statusCode` 的有意 4xx 仍保留具体业务错误
- **恢复目标 root guard** — 设置 `LINKE_RESTORE_ROOT` 后，`/api/restore` 和 `restore-dry-run` 的 targetPath 只能解析到该 root 内；相对路径按 root 内路径处理，绝对路径必须位于 root 内，symlink 逃逸返回 400 且不执行恢复或目标树读取
- **恢复目标 symlink 写入防护** — 设置 `LINKE_RESTORE_ROOT` 后，真实 restore 写入会逐级检查目标目录，拒绝目标文件 symlink 与中间目录 symlink，并通过 `O_NOFOLLOW` 打开目标文件，避免覆盖恢复 root 外文件
- **本地审计日志基础** — 服务端将 auth.denied、heartbeat、backup、restore 的关键结果追加到 `dataDir/audit/events.jsonl`，并提供 GET `/api/audit-log` 查看最新事件；事件使用 allowlist，不记录 `Authorization`、Bearer token、`sourcePath`、`targetPath`、NAS endpoint 或请求体
- **API rate-limit foundation** — 服务端可通过 `LINKE_RATE_LIMIT_PER_MINUTE` 为 `/api/*` 启用单进程内存 fixed-window 限流，超过返回 429 `Rate limit exceeded`，记录 `api.rate_limited`，非 `/api` 路由不受限
- **Audit retention foundation** — 服务端可通过 `LINKE_AUDIT_MAX_EVENTS` 为本地 `dataDir/audit/events.jsonl` 启用最新 N 条事件保留；默认关闭，仅做单进程本地事件数保留，不是 production-grade audit

## 快速开始

```bash
# 启动服务器（默认监听 127.0.0.1:3000，数据目录 ./data）
node src/server.js

# 指定端口和数据目录
PORT=8080 DATA_DIR=/tmp/linke-data node src/server.js

# 启用可选 API Bearer token 认证骨架（示例 token 仅用于本地测试）
LINKE_AUTH_TOKEN=dev-test-token node src/server.js

# 启用可选 API read/write token foundation（示例 token 仅用于本地测试）
LINKE_READ_TOKEN=dev-read-token LINKE_WRITE_TOKEN=dev-write-token node src/server.js

# 启用可选 API rate-limit foundation（示例：每分钟 60 个 /api/* 请求）
LINKE_RATE_LIMIT_PER_MINUTE=60 node src/server.js

# 启用可选 audit retention foundation（示例：保留最新 500 条审计事件）
LINKE_AUDIT_MAX_EVENTS=500 node src/server.js

# 局域网测试（受控环境，显式开放监听地址）
HOST=0.0.0.0 PORT=3000 node src/server.js
```

> **默认只监听 127.0.0.1**，不暴露到局域网/公网。如需局域网测试可设置 `HOST=0.0.0.0`，仅限受控测试环境使用；若同时未配置任何 token，GET `/api/auth-status` 会公开显示 `enabled:false`，因此开放监听时应配置 `LINKE_AUTH_TOKEN`、`LINKE_TOKEN`、`LINKE_READ_TOKEN` 或 `LINKE_WRITE_TOKEN`。

> 设置 `LINKE_AUTH_TOKEN`、兼容变量 `LINKE_TOKEN`、`LINKE_READ_TOKEN` 或 `LINKE_WRITE_TOKEN` 后，服务端会要求所有 `/api/*` 请求带 `Authorization: Bearer <token>`；未带或错误 token 会返回 `401 Unauthorized`。`LINKE_READ_TOKEN` 只能访问只读 API，访问 `POST /api/heartbeat`、`POST /api/backups` 或 `POST /api/restore` 会返回 `403 Forbidden` 并记录 `auth.forbidden`；`LINKE_WRITE_TOKEN` 可访问读写 API。GET `/api/auth-status` 也是只读 API，返回 `configuredScopes` 与 `writeRoutes` 等 sanitized 认证状态，不返回 token 值。Web Console 顶部的 API Token 控件可在当前页面内存中应用或清除 token，并随后的 `/api/*` 请求发送 Bearer header；它不会把 token 写入 localStorage、sessionStorage、cookie 或 metadata，刷新页面后需重新输入。

## Agent CLI

```bash
# 发送心跳
node src/agent.js heartbeat --server http://localhost:3000 --device my-pc --hostname MyPC --ip 192.168.1.10

# 备份文件
node src/agent.js backup --server http://localhost:3000 --device my-pc --source ./important-doc.txt

# 备份预检 dry-run（不创建快照、不复制文件、不写 metadata）
node src/agent.js backup-preflight-dry-run --server http://localhost:3000 --source ./important-docs --exclude "*.tmp" --exclude node_modules

# 查看快照列表
node src/agent.js snapshots --server http://localhost:3000 --device my-pc

# 恢复快照
node src/agent.js restore --server http://localhost:3000 --device my-pc --snapshot <snapshotId> --target ./restored/

# 恢复预检 dry-run（不复制、不覆盖、不写入目标目录）
node src/agent.js restore-dry-run --server http://localhost:3000 --device my-pc --snapshot <snapshotId> --target ./restored/

# 查看设备状态
node src/agent.js status --server http://localhost:3000 --device my-pc

# run-once：从配置文件批量执行备份
node src/agent.js run-once --config linke.config.json

# launchd-dry-run：生成 launchd plist（不安装、不调用 launchctl）
node src/agent.js launchd-dry-run --config linke.config.json
node src/agent.js launchd-dry-run --config linke.config.json --output ./scratch/my-agent.plist

# nas-dry-run：查看 NAS 备份计划（不连接 NAS、不写远端）
node src/agent.js nas-dry-run --config linke.config.json
node src/agent.js nas-dry-run --config linke.config.json --readiness-summary

# retention-dry-run：查看快照保留计划（不删除、只读）
node src/agent.js retention-dry-run --server http://localhost:3000 --device my-pc
node src/agent.js retention-dry-run --server http://localhost:3000 --device my-pc --keep-last 5

# health：发布健康检查 CLI（只读，无需 --device，不写入元数据，不连接 NAS，不执行远程命令）
node src/agent.js health --server http://localhost:3000
node src/agent.js health --server http://localhost:3000 --token dev-test-token

# release-readiness：发布就绪检查 CLI（只读 GET /api/health，输出 sanitized JSON）
node src/agent.js release-readiness --server http://localhost:3000
node src/agent.js release-readiness --server http://localhost:3000 --expected-version V0.57
node src/agent.js release-readiness --server http://localhost:3000 --expected-version V0.57 --token dev-test-token
```

### run-once

从 JSON 配置文件加载 `backupJobs`，先发送心跳，再逐一执行备份。

```json
{
  "serverUrl": "http://127.0.0.1:3000",
  "deviceId": "my-macbook",
  "backupJobs": [
    { "name": "docs", "sourcePath": "/Users/me/Documents" }
  ],
  "excludePatterns": ["*.tmp", "node_modules"]
}
```

### launchd-dry-run

生成 macOS launchd plist XML，用于定时执行 `run-once`。

- **不会调用 `launchctl`**，不会自动安装到 `~/Library/LaunchAgents/`
- **不会自动启动**任何系统服务
- 输出路径被限制在项目目录内，拒绝 `../` 逃逸
- 用户需手动 `cp` plist 到 `~/Library/LaunchAgents/` 并 `launchctl load` 才能生效

### nas-dry-run

验证 NAS 目标配置并输出 dry-run 计划。

- **不会连接 NAS**（不发起任何网络请求）
- **不会写入远端**（不传输任何文件）
- **不会保存或允许凭证字段**（`username`、`password`、`token`、`apiKey`、`secret`、`accessKey`、`refreshToken`、`privateKey`、`clientSecret`、`connectionString`、`accessToken`、`idToken`、`secretKey`、`sshKey`、`passphrase` 共 15 个精确键名均被拒绝）
- **拒绝 endpoint 中包含 userinfo**（如 `http://user:pass@host`）
- 支持的 NAS provider：`synology`、`ugreen`
- **就绪性摘要命令行模式**：支持添加 `--readiness-summary` 参数。启用时仅输出 top-level `readinessSummary`，不输出 `targets` 详细列表或 `jobs` 列表，从而避免泄漏目标端点、共享名、任务名称、源路径等敏感信息，并且绝不泄露 `credentialRef` 引用原值。

```json
{
  "nasTargets": [
    {
      "name": "home-synology",
      "provider": "synology",
      "endpoint": "http://192.168.1.100:5000",
      "shareName": "backup",
      "remotePath": "/volume1/backup",
      "enabled": true
    }
  ]
}
```

### retention-dry-run

查看快照保留策略的 dry-run 计划，按 `createdAt` 降序排序，保留最新 N 个快照（默认 keepLast=3）。

- **不会删除任何快照**，只输出计划
- **不会写入任何文件**，纯只读操作
- **不承诺自动清理**：当前版本不实现真实删除/自动清理功能
- 排序字段：`createdAt`（降序，最新优先）
- 相同 `createdAt` 时保持稳定顺序（按原始数组顺序）
- `keepLast` 必须是正整数，拒绝 0、负数、小数、非数字

### backup-preflight-dry-run

V0.11 增加备份预检 dry-run。给定 `sourcePath` 和可选 `excludePatterns` 后，Linke 会只读扫描源目录，输出：

- `included`：会进入备份的相对路径列表
- `excluded`：被排除规则命中的相对路径和 `matchedPattern`
- `summary.totalFiles`、`summary.includedCount`、`summary.excludedCount`

backup-preflight-dry-run **不会创建快照、不会复制文件、不会写入 metadata、不会修改仓库元数据**。它只做本机只读扫描，不解决生产级 `sourcePath` 沙箱问题。

### Web Console 备份预检 dry-run

V0.12 在 Web Console 中增加备份预检 dry-run 面板。输入 `sourcePath` 和可选 `excludePatterns` 后，控制台会调用 `backup-preflight-dry-run` 并显示：

- 总文件数、拟包含数量、拟排除数量
- `included`：会进入备份的相对路径列表
- `excluded`：被排除的相对路径和 `matchedPattern`

该面板只做备份预检，**没有真实备份执行按钮**，不会创建快照、不会复制文件、不会写入 metadata。当前版本仍不提供生产级 `sourcePath` 沙箱。

### Web Console NAS dry-run

V0.13 在 Web Console 中增加 NAS dry-run 面板。粘贴包含 `deviceId`、`nasTargets` 和可选 `backupJobs` 的配置 JSON 后，控制台会调用 `POST /api/nas-dry-run` 并显示：

- NAS 目标数量和关联任务数量
- 每个目标的 provider、name、endpoint、shareName、remotePath 和 enabled 状态
- `wouldConnect:false` 与 `wouldWrite:false` 的 dry-run 安全结果

该面板只做配置验证和计划预览，不连接 NAS、不发起 NAS 网络请求、不传输文件、不写入远端、不保存配置。配置示例不包含密码、token 或 API key；带 credential 字段或 URL userinfo 的目标会被拒绝。

### NAS app adapter dry-run

V0.14 在 NAS dry-run 中增加应用适配器计划。`nasTargets[]` 可声明可选 `appAdapter`：

```json
{
  "appAdapter": {
    "appId": "synology-backup",
    "operation": "backup-plan"
  }
}
```

支持的 appId：

- `synology-backup`
- `synology-files`
- `ugreen-backup`
- `ugreen-files`

dry-run 输出会在对应 target 上增加 `adapterPlan`，包含 `wouldInvokeApp:false`、`wouldConnect:false`、`wouldWrite:false` 和计划步骤。该功能只生成应用嵌套调用预览，不调用 NAS app、不发起认证、不 ping/probe、不连接 NAS、不写入远端、不保存配置。`appAdapter` 内出现 credential 字段会被拒绝，provider 与 appId 不匹配也会被拒绝。

### NAS credential reference gate

V0.64 为 `nasTargets[]` 增加可选 `credentialRef` 非密钥引用基础，用于后续真实 NAS 凭证解析前的命名约定。当前版本只校验引用名，不解析、不读取、不连接、不写入。

- **slug 规则**：`ALLOWED_NAS_CREDENTIAL_REF_PATTERN` 为 `^[a-z][a-z0-9-]{1,30}$`，由 `validateNasCredentialRef` 执行校验。
- **非密钥引用**：`credentialRef` 只是引用名，不是用户名、密码、token、API key 或 secret；`username`、`password`、`token`、`apiKey`、`secret`、`accessKey`、`refreshToken`、`privateKey`、`clientSecret`、`connectionString`、`accessToken`、`idToken`、`secretKey`、`sshKey`、`passphrase` 共 15 个字段仍会被拒绝。
- **denylist 理由**：`connectionString` 常嵌入用户名、密码或 token 等 credential material；`secretKey` 与 `secret` 是两个不同的 exact-key 字段，因此二者都必须显式拒绝。
- **不读取环境变量**：V0.64 不读取 env、不访问 secret manager、不解析 credential store，也不会发起 NAS 认证。
- **sanitized 输出**：`nas-dry-run` 输出只包含 `credentialRefConfigured:true/false`，不回显 `credentialRef` 原值。
- **执行 gate**：`buildNasDryRunPlan()` 顶层返回 `executionGate.remoteExecutionAllowed:false` 与 `blockingReason:"real NAS transport not implemented"`；输入配置无法覆盖该 gate。
- **Gold 边界**：`nas-dry-run` 仍为 partial，`real-nas-remote-backup` 仍为 blocked。该 gate 不代表真实 NAS 远程备份、生产级凭证管理或生产发布条件。

### Web NAS execution gate display

V0.65 在 Web Console 的 NAS dry-run 预检面板中展示 NAS 凭证配置状态与 executionGate 远程执行门禁。该功能仅用于界面展示与只读校验，不启用真实 NAS 传输，不发起任何网络连接或写入。

- **执行门禁展示**：当 NAS dry-run 预检响应中包含 `executionGate` 时，结果面板前置渲染一行门禁状态，显示 `远程执行：已阻止` 以及 API 返回的阻止原因（如 `real NAS transport not implemented`），并提示 `当前仍为 dry-run 预检计划`。
- **凭证配置状态**：遍历各个 NAS 目标，依据 `credentialRefConfigured` 字段只读展示 `凭证引用：已配置` 或 `凭证引用：未配置`。
- **执行就绪性摘要**：V0.67 在 dry-run plan 顶层增加 `readinessSummary`，并在每个 target 增加 `executionReadiness`，只输出固定 blocker codes：`target-disabled`、`credential-ref-missing`、`remote-execution-blocked`。V0.67 中 `ready` 状态不可达，因为 `remoteExecutionAllowed` 固定为 `false`；该字段即使未来出现，也只代表 dry-run 配置完备性，不代表生产发布批准、Gold 发布批准或允许远程执行。
- **安全不泄露**：页面不会渲染或回显任何 raw `credentialRef` 值。所有的 DOM 渲染均使用 `textContent` 保护。
- **Gold 边界**：`nas-dry-run` 仍为 partial，`real-nas-remote-backup` 仍为 blocked。不代表真实 NAS 传输已就绪，也不代表生产安全审计完成。


### Web Console 设备详情面板

V0.15 在 Web Console 中增加只读设备详情面板。点击设备列表中的任意设备后，面板会复用现有 `/api/devices` 数据显示：

- `deviceId`
- `hostname`
- `ipAddress`
- `status`
- `lastHeartbeatAt`
- `lastBackupAt`
- `snapshotCount`

该面板只做统一管理视图展示，不新增设备详情 API、不写入设备元数据、不提供编辑、删除、远程命令、ping/probe 或 NAS 操作按钮。缺失字段会显示稳定 fallback，例如 `unknown`、`无心跳`、`无备份` 或 `0`。

### Web Console 多设备列表控制

V0.16 在 Web Console 设备面板中增加紧凑工具栏，支持：

- 按名称 / Device ID / IP 搜索设备
- 按状态过滤：全部 / 在线 / 离线 / 未知
- 按名称、IP、最后心跳、快照数排序
- 实时显示可见设备数 / 总数计数

该功能仅前端只读派生视图，不新增写接口、不触发备份、不连接 NAS、不新增 API 路由。筛选状态不持久化，刷新页面后重置。如果筛选结果隐藏了已选设备，设备详情面板不会清空，只有当 `/api/devices` 中不再包含该设备时才清空详情。

### Web Console 备份任务概览

V0.17 在 Web Console 中增加只读备份任务概览面板。选中设备后，控制台复用现有 `/api/devices/:deviceId/snapshots` 响应，从 snapshot 元数据推导备份任务：

- 优先按 `jobName` 聚合
- 缺失 `jobName` 时按 `sourcePath` 聚合
- 展示任务数、快照总数、最近备份时间
- 每个任务展示任务名、源路径、快照数、最近备份时间和最近文件数

该面板只读展示历史快照中可确认存在的任务，不新增 API 路由、不写入 metadata、不触发备份、不创建快照、不连接 NAS、不调用 NAS app、不执行远程传输。尚未执行过、没有历史 snapshot 的配置任务不会出现在 V0.17 概览中。

### Web Console 备份任务详情时间线

V0.18 在 Web Console 中增加只读备份任务详情时间线。选中设备后，先在"备份任务概览"中选择一个从历史 snapshot 推导出的任务，控制台会继续复用现有 `/api/devices/:deviceId/snapshots` 响应展示该任务的历史版本：

- 任务名称
- 源路径
- 快照数量
- 最近备份时间
- 每个历史快照的 snapshot ID、创建时间、文件数量和 sourcePath

该面板是只读派生视图，不新增 API 路由、不写入 metadata、不触发备份、不执行恢复、不创建快照、不删除快照、不连接 NAS、不调用 NAS app、不执行远程传输。时间线行在 V0.18 中不联动 manifest detail 或 restore dry-run。尚未执行过、没有历史 snapshot 的配置任务不会出现在详情时间线中。

### Web Console 备份任务时间线 snapshot 联动

V0.19 在 V0.18 的备份任务详情时间线上增加只读 snapshot 联动。选中设备并选择一个备份任务后，可以点击该任务时间线中的某个历史 snapshot。控制台会复用现有快照清单详情和恢复预检 dry-run 面板：

- 快照清单详情显示该 snapshot 的 manifest、sourcePath、createdAt 和文件列表
- 恢复预检 dry-run 使用当前目标目录输入，显示 would-create / would-overwrite 预览
- 时间线行会显示选中态，帮助确认当前查看的历史版本

该联动只读取既有 snapshot、manifest 和 restore-dry-run 结果，不新增 API 路由、不写入 metadata、不执行恢复、不复制文件、不覆盖文件、不创建目录、不删除快照、不连接 NAS、不调用 NAS app、不执行远程传输。点击备份任务本身不会自动选择 snapshot；只有点击具体时间线行才会加载 manifest detail 和 restore dry-run。

### Web Console 事件日志面板增强

V0.20 在 Web Console 中增强事件日志面板。展示前端内存态结构化事件、累计计数、最近事件和 50 条可见上限。

- 事件日志为前端内存态，纯只读显示。
- 刷新页面后事件日志会重置。
- 界面最多展示最近的 50 条可见事件。
- 累计计数为页面生命周期计数器。
- 不新增 API，不写入任何元数据，不会进行备份、恢复、删除、NAS 连接、NAS 应用适配或远程文件传输。

### Web Console 设备备份健康

V0.21 在 Web Console 中新增设备备份健康面板。控制台复用现有 `/api/devices` 响应，在前端生成只读健康分类：

- `健康`：设备在线，快照数大于 0，且最后备份时间有效且不晚于当前时间
- `需关注`：设备在线，但缺少有效备份记录，例如快照数为 0、缺少最后备份时间或最后备份时间无效
- `离线`：设备状态为 offline
- `未知`：设备状态缺失或不是 online / offline

面板会展示健康、需关注、离线和未知数量，并列出每台设备的 hostname、Device ID、IP 地址、状态、快照数、最后心跳、最后备份和健康原因。点击健康项会复用现有设备选择流程，加载设备详情、快照、保留计划和备份任务视图。

该面板是前端只读派生视图，不新增 API、不写入 metadata、不触发备份、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。健康结果刷新页面后会重新从 `/api/devices` 派生，不会被持久化保存。

### Web Console 备份版本一致性

V0.22 在 Web Console 中新增备份版本一致性面板。控制台复用现有 `/api/devices` 与 `/api/devices/:deviceId/snapshots` 响应，在前端按备份任务聚合跨设备最新版本：

- 分组规则：优先按 `jobName` 分组；没有 `jobName` 时按 `sourcePath` 分组
- `一致`：多台设备都有该任务快照，且最新版本一致，即最新快照的创建时间与文件数一致
- `版本不一致`：多台设备都有该任务快照，但最新版本不同，即最新快照时间或文件数不同
- `单设备`：只有一台设备存在该任务快照，当前无法做跨设备一致性比较

面板会展示一致、版本不一致、单设备和任务组总数，并列出每个任务组的 jobName、sourcePath、最新备份时间、快照数量、设备版本状态和原因。该视图用于发现“哪些任务可能需要人工检查”，不做自动同步、不解决冲突、不判断文件内容 hash 是否完全一致。

该面板是前端只读派生视图，不新增 API、不写入 metadata、不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。尚未执行过、没有历史 snapshot 的配置任务不会出现在 V0.22 一致性面板中。

### Web Console 版本一致性 snapshot 联动

V0.23 在 V0.22 的备份版本一致性面板上增加只读 drill-down。点击任一任务组下的设备版本行后，控制台会切换到该设备上下文，并复用现有面板加载对应最新 snapshot：

- 设备详情：切换到被点击的设备
- 快照列表：刷新该设备的现有 snapshots
- 保留计划：刷新该设备的 retention dry-run
- 快照清单详情：读取该 snapshot manifest
- 恢复预检：读取该 snapshot 的 restore-dry-run

该联动只用于从“版本不一致”快速查看具体 snapshot 内容和恢复影响预览。它不是同步能力，不会自动判断正确版本，不解决冲突，不执行文件复制或覆盖。

该功能仍是前端只读联动，不新增 API、不写入 metadata、不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。

### Web Console 版本一致性筛选与搜索

V0.24 在 V0.22/V0.23 的备份版本一致性面板上增加只读筛选与搜索工具栏。控制台仍先读取现有 `/api/devices` 与 `/api/devices/:deviceId/snapshots` 响应，生成全量一致性结果，然后只在浏览器内存中重新过滤和渲染任务组，不重新请求 API，不保存筛选状态。

支持的状态筛选：

- `全部`
- `版本不一致`
- `单设备`
- `一致`

支持的搜索字段：

- `jobName`
- `sourcePath`
- `deviceId`
- `hostname`
- `IP`

面板会显示可见 / 总数计数。汇总数字仍代表全量任务组的一致、版本不一致、单设备和任务组总数；筛选只影响下方列表的可见范围。

该功能只是前端只读派生视图控制，不新增 API、不写入 metadata、不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。

### Web Console 版本一致性非最新摘要

V0.25 在备份版本一致性面板的每个任务组中增加只读非最新摘要行。最新设备数量、非最新设备数量、单设备任务判定以及最大时间差都会被计算并直接呈现在界面上。

#### 版本一致性非最新摘要安全保证

- **不新增 API**：不增加任何后端 API 接口，只复用现有 API 响应。
- **不写入任何元数据**：纯前端内存计算只读派生视图，不修改/不写入 metadata 且不保存状态。
- **不触发备份**：不触发备份。
- **不执行同步**：不执行同步。
- **不执行恢复**：不执行恢复。
- **不删除快照**：不删除快照。
- **不连接 NAS**：不连接 NAS。
- **不调用 NAS app**：不调用 NAS app。
- **不执行远程传输**：不执行远程传输。

### Web Console 版本一致性排序控制

V0.26 在备份版本一致性面板的筛选与搜索工具栏中增加只读排序控制。排序只对已经加载到浏览器内存中的任务组生效，不重新请求 API，不保存排序状态。

支持的排序方式：

- `风险优先`：保持默认风险顺序，版本不一致优先，其次单设备和一致任务组。
- `最大时间差`：最大 `maxTimeDriftMs` 优先，便于优先查看跨设备版本差异最大的任务。
- `非最新设备数`：非最新设备数最多的任务优先。
- `最近备份`：最近 `latestCreatedAt` 优先。
- `任务名`：按 `jobName` 字母顺序排列，同名时按 `sourcePath` 排列。

该功能只是前端只读派生视图控制，不新增 API、不写入 metadata、不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。

### Web Console 版本一致性覆盖筛选

V0.28 在备份版本一致性面板的筛选与搜索工具栏中增加只读覆盖筛选。支持在浏览器内存中按以下选项过滤任务组，且整个过程不重新请求 API，不新增 API：

- `all`：全部任务组（默认值）。
- `gap`：有覆盖缺口的任务组，即存在至少一个可观测设备未上传该任务组的快照（`missingDeviceCount > 0`）。
- `full`：完全覆盖的任务组，即所有可观测设备均已上传快照且至少有一个预期设备（`expectedDeviceCount > 0` 且 `missingDeviceCount === 0`）。

该功能仅用于前端内存视图过滤，整个过程无需向后端发送任何写请求，亦不连接 NAS，不影响顶部的全量汇总计数。

### Web Console 版本一致性覆盖缺口排序

V0.29 在备份版本一致性面板的排序工具栏中增加只读覆盖缺口排序选项。在选择该选项时，通过如下降序级联排序链在前端内存中重新排序已加载的任务组：

1. **缺失设备数（missingDeviceCount）降序**：缺失设备越多的任务组优先展示。
2. **缺失率（missingDeviceCount / expectedDeviceCount）降序**：比例越高越优先（若预期设备数 <= 0，缺失率视为 0）。
3. **预期设备数（expectedDeviceCount）降序**：预期设备数越多越优先。
4. **现有风险排序器（compareVersionConsistencyRisk）兜底**：用于对上述项完全相同的任务组进行兜底，按既有风险优先顺序比较状态、时间戳、任务名和路径。

该功能仅用于前端只读派生视图重排，不重新请求 API，不新增 API，不修改任何元数据。

### Web Console 版本一致性覆盖率显示

V0.30 在备份版本一致性面板的各任务组覆盖行中增加只读覆盖率显示。覆盖率只基于已加载到浏览器内存中的 `coveredDeviceCount` 与 `expectedDeviceCount` 计算：

- 当 `expectedDeviceCount > 0` 时，界面显示整数百分比，例如 `覆盖 2 / 3 · 覆盖率 67% · 缺 Mac C`。
- 百分比使用 `Math.round((coveredDeviceCount / expectedDeviceCount) * 100)` 计算。
- 当 `expectedDeviceCount <= 0` 时不显示 `覆盖率` 字样，避免出现 `NaN%`、`0%` 或 `100%` 这类误导性展示。

该功能仅用于前端只读派生视图展示，不重新请求 API，不新增 API，不修改任何元数据。

### Web Console 版本一致性无可观测设备回退

V0.31 在备份版本一致性面板的各任务组覆盖行中增加只读的无可观测设备回退显示。

- 当 `expectedDeviceCount <= 0` 时，在覆盖行中追加 ` · 无可观测设备` 回退提示，且绝对不包含 `覆盖率` 字样。
- 当 `expectedDeviceCount > 0` 时，覆盖行中绝对不包含 `无可观测设备` 字样，并保持 V0.30 的覆盖率百分比展示规则。

该功能仅用于前端内存视图渲染，不重新请求 API，不新增 API，不修改任何元数据。

### Web Console 版本一致性无可观测设备筛选

V0.32 在备份版本一致性面板的覆盖筛选下拉框中增加 `unobservable`（无可观测设备）选项。覆盖筛选的语义为：

- `all`：显示全部任务组。
- `gap`：仅显示 `expectedDeviceCount > 0` 且 `missingDeviceCount > 0` 的任务组。
- `full`：仅显示 `expectedDeviceCount > 0` 且 `missingDeviceCount === 0` 的任务组。
- `unobservable`：仅显示 `expectedDeviceCount <= 0` 的任务组。

该功能只在浏览器内存中重排可见任务组，不重新请求 API，不新增 API，不写入任何元数据。

### Web Console 统一管理态

V0.33 在 Web Console 中新增只读的 "统一管理态" (Unified Management State)。该状态基于设备状态和 IP 地址进行前端只读分类展示：
- 在线可见：在线（online）且 IP 地址为有效 IP。
- 在线缺 IP：在线（online）但 IP 地址为 `null`/`undefined`、空字符串、纯空白字符或 `'unknown'`/`' UNKNOWN '`（不区分大小写及首尾空格）。
- 离线保留：离线（offline）。
- 未知待确认：其它未知状态、缺少状态或设备对象为空。

统一管理态安全边界：
- 属于纯前端只读视图，不新增 API。
- 不写入元数据 (不写入任何元数据，不写入 metadata)。
- 不触发备份 (不进行备份)。
- 不执行远程命令 (不执行任何远程命令)。
- 不连接 NAS (不建立真实 NAS 连接)。
- 不进行修改 (无批量操作，无修复操作)。

### Web Console 管理态筛选

V0.34 在 Web Console 设备面板中增加了 "管理态筛选" 功能。管理员可以在设备列表中通过下拉选择框按管理状态分类过滤设备：
- `all`：显示所有管理状态（默认）。
- `visible`：显示在线可见的设备。
- `missing-ip`：显示在线缺 IP 的设备。
- `offline-retained`：显示离线保留的设备。
- `unknown`：显示未知待确认的设备。

该筛选采用 **AND 复合语义** 与现有的搜索输入和设备状态过滤器相结合，重绘和计数更新均在浏览器本地内存中进行，不触发对后端 `/api/devices` 的重新获取。

### Web Console 管理态筛选安全边界

V0.34 管理态筛选属于前端只读视图，具备以下安全保证：
- 只读，不新增 API。
- 不写入元数据，不写入任何元数据。
- 不执行远程命令，不执行任何远程命令。
- 不连接 NAS，不建立真实 NAS 连接。
- 不进行修改，无批量操作，无修复操作。

### Web Console 管理态分桶统计

V0.35 在 Web Console 设备面板中增加了 "管理态分桶统计" 功能。系统自动根据当前设备列表计算出各管理状态的设备数量，并在控制台上方的分桶计数面板中展示：
- `all`：全部。
- `visible`：在线可见。
- `missing-ip`：在线缺 IP。
- `offline-retained`：离线保留。
- `unknown`：未知待确认。

管理员可以点击任意分桶，快速将底部的管理态过滤器切换到对应的状态并实时刷新列表与计数。该操作仅影响前端本地内存视图，不进行后端 API 重新获取。

### Web Console 管理态分桶统计安全边界

管理态分桶统计属于只读视图派生逻辑，具备以下安全保证：
- 只读，不新增 API。
- 不写入任何元数据。
- 不执行远程命令，不执行任何远程命令。
- 不连接 NAS，不建立真实 NAS 连接。
- 不进行修改，无批量操作，无修复操作。

### Web Console 管理态分桶选中态

V0.36 将管理态分桶控件升级为可访问的按钮控件。分桶按钮继续复用现有 `device-management-filter` 作为唯一状态源，点击按钮或手动切换下拉框时，都会同步更新：
- active 高亮状态。
- `aria-pressed` 状态。
- `data-active` 状态。
- 设备列表和 `device-filter-count` 的本地筛选结果。

该功能只同步浏览器内存中的选中态，不持久化筛选状态，刷新页面后不保留当前筛选。

### Web Console 管理态分桶选中态安全边界

管理态分桶选中态属于前端只读交互增强，具备以下安全保证：
- 只读，不新增 API。
- 不写入任何元数据。
- 不执行远程命令。
- 不连接 NAS。
- 不保存筛选状态，不持久化筛选状态。

### Web Console 管理态分桶作用域

V0.37 将管理态分桶计数的作用域调整为当前搜索词和状态筛选后的设备集合。分桶计数会响应：
- `device-search` 搜索词。
- `device-status-filter` 状态筛选。

分桶计数会忽略当前管理态筛选（`device-management-filter`），因此点击 `visible`、`missing-ip`、`offline-retained` 或 `unknown` 分桶时，分桶数字保持在同一个搜索 / 状态范围内，只有设备列表和 `device-filter-count` 随管理态筛选变化。

该逻辑只在浏览器内存中对已加载的 `/api/devices` 数据做派生计算，不重新请求 `/api/devices`，不新增后端接口。

### Web Console 管理态分桶作用域安全边界

管理态分桶作用域属于前端只读派生视图，具备以下安全保证：
- 只读，不新增 API。
- 不重新请求 `/api/devices`。
- 不写入任何元数据。
- 不执行远程命令。
- 不连接 NAS。

### Web Console 管理态判定提示

V0.38 在设备列表和设备详情中增加只读的管理态判定提示。控制台继续使用 V0.33 的统一管理态分类，并通过以下 DOM hook 展示解释文本：

- `device-management-hint`：设备列表中的管理态处理提示。
- `device-detail-management-hint`：选中设备详情中的管理态处理提示。

提示映射如下：

- 在线且 IP 可用：可纳入统一管理。
- 设备在线但缺少可用 IP：需补充 IP 信息。
- 设备离线：保留历史记录和备份上下文。
- 状态未知：需确认设备心跳。

### Web Console 管理态判定提示安全边界

管理态判定提示属于前端只读解释文本，具备以下安全保证：
- 只读，不新增 API。
- 不重新请求 `/api/devices`。
- 不写入任何元数据。
- 不触发备份。
- 不执行远程命令。
- 不连接 NAS。

### Web Console 设备列表空态筛选上下文

V0.39 在设备列表筛选后无匹配设备时展示当前筛选上下文。设备列表仍显示 `无匹配设备`，并通过以下 DOM hook 展示辅助上下文：

- `device-empty-state`：设备列表空态行。
- `device-empty-filter-context`：空态中的筛选上下文文本。

上下文包含当前控件值：

- 搜索：空值显示 `全部`，否则显示当前搜索词。
- 状态：显示 `全部`、`在线`、`离线` 或 `未知`。
- 管理态：显示 `全部`、`在线可见`、`在线缺 IP`、`离线保留` 或 `未知待确认`。

该上下文只用于解释为什么当前设备列表为空，不改变筛选逻辑，不包含排序项，也不触发新的设备加载。

### Web Console 设备列表空态筛选上下文安全边界

设备列表空态筛选上下文属于前端只读派生文本，具备以下安全保证：
- 只读，不新增 API。
- 不重新请求 `/api/devices`。
- 不写入任何元数据。
- 不执行远程命令。
- 不连接 NAS。

### Web Console 设备筛选重置

V0.40 在设备 controls 区域新增“重置筛选”按钮 (`device-filter-reset`)。点击该按钮执行以下操作：
- 清空搜索输入框 (`device-search`)。
- 设置状态过滤 (`device-status-filter`) 为 `all` (全部)。
- 设置管理态过滤 (`device-management-filter`) 为 `all` (所有管理状态)。
- 设置排序方式 (`device-sort`) 为 `name` (名称)。
- 触发重新渲染本地已加载的设备列表、设备计数、管理态分桶高亮状态，并刷新空态筛选上下文。

该操作不重新加载或请求数据，不改动任何 API，不改变备份状态，不连接 NAS。

### Web Console 设备筛选重置安全边界

设备筛选重置功能完全在浏览器内存中实现，具备以下安全保证：
- 只读，不新增 API，不重新请求 `/api/devices`。
- 不写入任何元数据或配置。
- 不执行远程命令或启动备份。
- 不连接 NAS 或备份目标。

### Web Console 设备筛选重置状态

V0.41 为 `device-filter-reset` 增加可访问状态同步。默认情况下，搜索为空、状态为 `all`、管理态为 `all`、排序为 `name`，重置按钮处于禁用状态：

- `disabled`
- `aria-disabled="true"`
- `data-active="false"`

当任一控件偏离默认值时，重置按钮启用，并同步为：

- `aria-disabled="false"`
- `data-active="true"`

点击“重置筛选”恢复默认值后，按钮重新禁用。状态同步跟随现有 `renderFilteredDevices()` 本地渲染路径，不新增事件流或网络请求。

### Web Console 设备筛选重置状态安全边界

设备筛选重置状态属于前端只读 UI 状态，具备以下安全保证：
- 只读，不新增 API。
- 不重新请求 `/api/devices`。
- 不写入任何元数据。
- 不执行远程命令。
- 不连接 NAS。

### Web Console 设备筛选摘要

V0.42 为设备列表控件增加只读设备筛选摘要面板（`device-active-filter-summary`）。

- 当所有筛选条件为默认值时，显示 `默认筛选`；
- 当任一条件偏离默认值（例如输入了搜索关键字、选择了非 all 状态、非 all 管理态或非 name 排序）时，展示包含各筛选状态的当前筛选摘要：`当前筛选: 搜索: {query} · 状态: {status} · 管理态: {management} · 排序: {sort}`。
- 该摘要元素在 HTML 中支持 `role="status"` 和 `aria-live="polite"` 属性，以满足无障碍阅读要求。

### Web Console 设备筛选摘要安全边界

设备筛选摘要为纯前端只读派生视图，具备以下安全保证：
- 只读，不新增 API。
- 不重新请求 `/api/devices`。
- 不写入任何元数据。
- 不执行远程命令。
- 不连接 NAS。

### Web Console 设备筛选计数状态

V0.44 为设备列表的设备筛选计数（`device-filter-count`）增加只读 `data-filtered` 属性。

- 当设备列表的可见数小于总数（即筛选结果被过滤/收窄）时，计数的 `data-filtered` 属性更新为 `true`。
- 当未进行任何过滤（可见数等于总数，且总数大于0）或列表为空（总数为0）时，`data-filtered` 属性更新为 `false`。
- 本版本不为该组件增加 `aria-live` 或任何第二个活动区域，避免引起重复播报。

### Web Console 设备筛选计数状态安全边界

设备筛选计数状态为纯前端只读派生视图，具备以下安全保证：
- 只读，不新增 API。
- 不重新请求 `/api/devices`。
- 不写入任何元数据。
- 不执行远程命令。
- 不连接 NAS。

### Web Console 设备筛选计数指标

V0.45 为设备列表的设备筛选计数（`device-filter-count`）增加只读 `data-visible-count` 与 `data-total-count` 属性。

- 当设备列表的可见数和总数更新时，计数的 `data-visible-count` 和 `data-total-count` 属性将同步更新为对应数值。
- 本版本不为该组件增加 `aria-live`，且不改变可见的文本格式，避免引起不必要的干扰。

### Web Console 设备筛选计数指标安全边界

设备筛选计数指标为纯前端只读派生视图，具备以下安全保证：
- 只读，不新增 API。
- 不重新请求 `/api/devices`。
- 不写入任何元数据。
- 不连接 NAS。
- 不执行远程命令。

### 可选 Bearer token API 认证骨架与 Web Token UX

V0.53 增加可选 Bearer token auth skeleton。V0.54 在 Web Console 中补齐内存态 API Token UX，让浏览器请求也能在受控本地测试中带上 Bearer header。它的目标是防止未带 token 的 Agent CLI / 自动化请求直接访问 `/api/*`，为后续完整鉴权打基础。

- **启用方式**：设置 `LINKE_AUTH_TOKEN`，或兼容使用 `LINKE_TOKEN`。
- **请求格式**：所有 `/api/*` 请求必须带 `Authorization: Bearer <token>`；缺失、格式错误或 token 不匹配会返回 `401 Unauthorized`。
- **Agent CLI**：多数需要访问 Linke Server 的命令可用 `--token <token>` 发送 Bearer header，例如 `health`、`release-readiness`、`heartbeat`、`backup`、`restore-dry-run`、`retention-dry-run`。
- **Web Console**：页面顶部提供 API Token 输入、应用、清除与状态提示；token 仅保存在当前页面内存中，刷新后需重新输入。
- **浏览器持久化边界**：Web Console 不会把 token 写入 `localStorage`、`sessionStorage`、`cookie` 或 metadata；收到 401 后会清空内存 token 并提示认证失败。
- **默认兼容**：未设置 token 时，仍保持 V0.x localhost 原型的无 token 本地行为。
- **Gold 边界**：这是 partial auth，不是完整生产级 authorization；还缺少角色权限、token 轮换、secret management、分布式 rate limiting、生产级审计和生产安全评审。

### API read/write token foundation

V0.61 增加可选 API read/write token foundation，用于把只读 API 访问和写入 API 访问做基础分离，但仍不声明完整生产级鉴权。

- **full-access 兼容 token**：`LINKE_AUTH_TOKEN` / `LINKE_TOKEN` 仍作为 full-access token，保持旧 Agent CLI `--token` 用法兼容。
- **read token**：`LINKE_READ_TOKEN` 只能访问只读 API；当前写入 API 为 `POST /api/heartbeat`、`POST /api/backups` 和 `POST /api/restore`。
- **write token**：`LINKE_WRITE_TOKEN` 可访问只读 API 和写入 API。
- **越权语义**：有效 read token 访问写入 API 返回 `403 Forbidden`，并通过 best-effort audit log 记录 `auth.forbidden`。
- **拒绝语义**：缺失、格式错误或未知 token 仍返回 `401 Unauthorized`，并记录 `auth.denied`。
- **重叠 token**：如果 `LINKE_READ_TOKEN` 与 `LINKE_WRITE_TOKEN` 使用相同值，按最宽权限处理，该值可写。
- **审计边界**：审计事件不记录 Authorization header、Bearer token、token prefix、请求体、`sourcePath`、`targetPath`、NAS endpoint 或 credential-like 字段。
- **Gold 边界**：这仍只是 `security-auth` 的 partial evidence；还缺少用户、角色权限、token rotation、secret management、生产级审计、分布式 rate limiting 和生产安全评审。

### Auth status readiness API

V0.62 增加只读 GET `/api/auth-status`，用于让受控本地操作者确认当前服务是否启用了 auth scope，而不暴露任何 token material。响应由 `buildAuthStatusResponse` 构造。

- **只读接口**：GET `/api/auth-status` 不写入 metadata、设备数据、快照数据或审计成功事件；POST/PUT/PATCH/DELETE 返回 404。
- **响应字段**：返回 `status`、`service`、`version`、`auth.enabled`、`auth.configuredScopes`、`auth.writeRoutes` 与 `safety`。
- **configuredScopes**：只返回 `full` / `read` / `write` 是否配置的布尔值，不返回 env 名称对应的实际 token 值。
- **writeRoutes**：列出当前被视为写入 API 的路由：`POST /api/heartbeat`、`POST /api/backups`、`POST /api/restore`。
- **tokenValuesReturned**：`safety.tokenValuesReturned` 固定为 `false`；响应不返回 Authorization header、Bearer token、token prefix、`LINKE_AUTH_TOKEN`、`LINKE_TOKEN`、`LINKE_READ_TOKEN` 或 `LINKE_WRITE_TOKEN` 的值。
- **认证边界**：启用任一 token 后，GET `/api/auth-status` 仍复用 `/api/*` Bearer gate；read token 可读取该状态，未知或缺失 token 返回 `401 Unauthorized` 并记录 `auth.denied`。
- **Gold 边界**：auth-status 仍只是 `security-auth` 的 partial evidence；它不实现用户、角色权限、token rotation、secret management、生产级鉴权、生产级审计或 distributed rate limiting，Gold 发布仍 blocked。

### Shared write-route registry

V0.63 增加 shared write-route registry，用于让 read/write token 授权判断与 GET `/api/auth-status` 的 `writeRoutes` 状态报告使用同一来源，降低未来新增写入 API 时的漂移风险。

- **同一来源**：`API_WRITE_ROUTES` 是当前写入 API 注册表，包含 `POST /api/heartbeat`、`POST /api/backups` 和 `POST /api/restore`。
- **授权判断**：`isApiWriteRoute(method, pathname)` 由 Bearer auth gate 使用；有效 read token 命中注册表中的写入 API 时返回 `403 Forbidden` 并记录 `auth.forbidden`。
- **状态报告**：`formatApiRoute(route)` 由 `buildAuthStatusResponse()` 使用，GET `/api/auth-status` 的 `writeRoutes` 来自 `API_WRITE_ROUTES.map(formatApiRoute)`。
- **不改变语义**：V0.63 不新增写入 API，不改变 read token、write token、full-access token 的授权语义。
- **Gold 边界**：write-route registry 只是 `security-auth` 的 foundation evidence；它不是完整生产级鉴权，不提供用户、角色权限、token rotation、secret management、生产级审计或 distributed rate limiting，Gold 发布仍 blocked。

### 服务端请求/错误硬化

V0.55 增加基础服务端硬化，目标是降低意外大请求和内部错误细节外泄风险。

- **JSON 请求体上限**：服务端读取 JSON body 时按 chunk 累计大小，超过 1 MiB 会立即返回 `413` 和 `{ "error": "Request body too large" }`。
- **不写入保证**：超限请求会在业务处理前失败，不记录 heartbeat，不创建快照，也不写入 metadata。
- **未知 500 脱敏**：未标记 `statusCode` 的非预期异常只向客户端返回 `{ "error": "Internal Server Error" }`，不回显 snapshotId、路径或内部错误消息。
- **有意 4xx 保留**：带 `statusCode` 的有意错误仍保留具体业务消息，例如 `Invalid JSON body`、缺少必填字段、`Unauthorized`、`Not Found` 或 NAS dry-run 校验错误。
- **Gold 边界**：这只让 `production-hardening` 从 blocked 进入 partial；还缺少部署硬化、审计、secret management、监控、supervisor 和恢复演练。

### 恢复目标 root guard

V0.56 增加可选恢复目标 root guard，用于降低真实恢复写入任意服务端路径的风险。

- **启用方式**：设置 `LINKE_RESTORE_ROOT=/absolute/restore/root` 后启动服务端；未设置时保持既有 localhost 原型行为。
- **restore 执行路径**：`POST /api/restore` 的 `targetPath` 若为相对路径，会解析到 `LINKE_RESTORE_ROOT` 内；若为绝对路径，必须位于该 root 内。
- **restore-dry-run 读取路径**：`GET restore-dry-run` 在读取目标目录树前执行同一 guard，root 外路径直接返回 400，不扫描目标树。
- **symlink 防护**：guard 会 realpath 归一化 restore root，并检查 target 最近已存在祖先的 realpath；通过 symlink 逃逸到 root 外会返回 `{ "error": "targetPath is outside the allowed restore root" }`。
- **错误边界**：400 响应不回显 `targetPath` 或 root 具体值，避免暴露服务端目录结构。
- **Gold 边界**：V0.56 只建立恢复 root guard；V0.57 补充真实 restore 写入 symlink 防护后，`production-hardening` 仍只是 partial evidence，还缺少生产级审计、权限模型、secret management、监控和 supervisor。

V0.57 在配置 `LINKE_RESTORE_ROOT` 时继续加固真实 restore 写入路径。

- **目标文件 symlink 防护**：如果目标文件已是 symlink，restore 会返回 `{ "error": "Restore target path is not allowed" }`，不会跟随 symlink 覆盖 root 外文件。
- **中间目录 symlink 防护**：restore 会逐级检查目标父目录，目标目录树中的 symlink 子目录会被拒绝，避免把嵌套文件写到 root 外。
- **O_NOFOLLOW 写入**：安全模式下目标文件通过 `O_NOFOLLOW` 打开；未设置 `LINKE_RESTORE_ROOT` 时仍保持既有 localhost 原型兼容行为。
- **Gold 边界**：这仍只是 `production-hardening` 的 partial evidence；还缺少生产级审计、权限模型、secret management、监控、supervisor 和真实 NAS 远程备份。

### 本地审计日志基础

V0.58 增加本地 audit log foundation，用于记录关键 API 安全和写入结果，推进 `production-hardening` 但不宣称生产级审计。

- **存储位置**：事件追加写入 `dataDir/audit/events.jsonl`，每行一个 JSON 对象。
- **查询接口**：GET `/api/audit-log?limit=50` 返回最新事件数组；该接口复用 `/api/*` 的 Bearer token gate，未配置 token 时沿用 localhost 原型兼容行为。
- **记录事件**：当前记录 `auth.denied`、`auth.forbidden`、`api.heartbeat.success` / `api.heartbeat.failure`、`api.backup.created` / `api.backup.failure`、`api.restore.completed` / `api.restore.failure`。
- **敏感字段排除**：事件 allowlist 不记录 `Authorization`、Bearer token、请求体、`sourcePath`、`targetPath`、NAS endpoint、password、apiKey、secret 或 credential-like 字段。
- **auth 语义**：配置 `LINKE_AUTH_TOKEN`、`LINKE_TOKEN`、`LINKE_READ_TOKEN` 或 `LINKE_WRITE_TOKEN` 后，未知或缺失 token 被拒绝时记录 `auth.denied`；有效 read token 访问写入 API 被拒绝时记录 `auth.forbidden`；未启用 auth 时不会产生 auth.denied / auth.forbidden 事件。
- **写入失败语义**：V0.58 审计写入为 best-effort；写入失败会输出通用 stderr 信息，不包含事件 payload，并且不阻塞原 API 响应。
- **运维边界**：V0.58 本身暂无 rotation / retention / tamper-proof / signing / export；V0.60 提供可选事件数 retention，但长期运行仍需要外部轮转、防篡改、保留策略和监控。
- **Gold 边界**：这仍只是 `production-hardening` 的 partial evidence；还缺少生产级审计、权限模型、secret management、监控、supervisor 和真实 NAS 远程备份。

### API rate-limit foundation

V0.59 增加可选 API rate-limit foundation，用于本地原型的基础滥用防护和回归验证，推进 `production-hardening` 但不宣称生产级限流。

- **启用方式**：设置 `LINKE_RATE_LIMIT_PER_MINUTE=<positive integer>` 后启动服务端；未设置、空值或 `0` 时禁用并保持默认 localhost 原型兼容行为。
- **作用范围**：只作用于 `/api` 和 `/api/*`；非 `/api` 静态页面、Web Console 资源和其他 non-API 路由不被限流。
- **执行顺序**：限流检查在 Bearer auth gate 前执行；当同一请求同时会触发认证失败和限流失败时，服务端返回 429 `Rate limit exceeded`，不暴露 auth state。
- **客户端键**：当前仅使用 `req.socket.remoteAddress`，不读取 `Authorization`、Bearer token、请求体或 NAS 配置。
- **响应语义**：超过限额返回 `429` 和 `{ "error": "Rate limit exceeded" }`。
- **审计事件**：被限流的 API 请求通过 best-effort audit log 记录 `api.rate_limited`，事件只包含 method、path、statusCode、outcome 和 requestId 等 allowlist 字段。
- **实现边界**：当前是 in-memory / 单进程 / fixed-window 限流；没有 distributed shared storage、多实例同步、Redis、proxy / 代理信任策略、`X-Forwarded-For` 策略、滑动窗口、WAF 或生产级 abuse protection。
- **Gold 边界**：这仍只是 `production-hardening` 的 partial evidence；`real-nas-remote-backup` 仍为 blocked，Gold 发布仍 blocked。

### Audit retention foundation

V0.60 增加可选 audit retention foundation，用于把本地 `dataDir/audit/events.jsonl` 限制为最新 N 条审计事件，减少长期运行的无界增长风险。

- **启用方式**：设置 `LINKE_AUDIT_MAX_EVENTS=<positive integer>` 后启动服务端；未设置、空值或 `0` 时禁用并保持默认 localhost 原型兼容行为。
- **保留语义**：每次追加审计事件后，服务端会将 `events.jsonl` 压缩为最新 N 条非空 JSONL 行；GET `/api/audit-log` 仍按最新事件优先返回。
- **默认关闭**：未配置 `LINKE_AUDIT_MAX_EVENTS` 时不裁剪 audit log，保留 V0.58/V0.59 行为。
- **并发边界**：单个 Node.js 进程内，启用 retention 后同一 audit 文件的 append + compact 会串行化；multi-process / 多进程、distributed / 跨实例写入不做协调。
- **敏感字段边界**：retention 只裁剪 JSONL 行，不新增字段；事件仍使用 allowlist，不记录 `Authorization`、Bearer token、请求体、`sourcePath`、`targetPath`、NAS endpoint、password、apiKey、secret 或 credential-like 字段。
- **非目标**：不提供 tamper-proof / 防篡改、signing / 签名、encryption、SIEM、external log shipping、time-based rotation、size-based rotation、压缩归档或 production-grade audit。
- **Gold 边界**：这仍只是 `production-hardening` 的 partial evidence；`real-nas-remote-backup` 仍为 blocked，Gold 发布仍 blocked。

### 发布健康检查

V0.46 实现了发布健康检查端点 `/api/health`。

- 提供只读 GET `/api/health` 接口，用以检查服务运行状况。
- 返回的健康数据包含：`status`（当 `dataDir` 可读时为 `"ok"`，不可读/不可用时为 `"degraded"`）、服务标识 `"linke"`、当前发布版本号（当前为 `"V0.66"`）、检查详情 `checks`（包含 `http` 和 `dataDirReadable`）、以及当前 ISO 时间戳 `timestamp`。
- 如果数据目录 `dataDir` 不可用，`checks.dataDirReadable` 将显示为 `"unavailable"`。

### 发布健康检查安全边界

发布健康检查接口具备以下安全保证：
- **只读端点**：仅响应 GET 请求，不接受 POST、PUT、PATCH 或 DELETE 请求。
- **不写入任何元数据**：该接口完全是只读的，不会对本地、NAS 写入任何 metadata 或其他数据。
- **无路径泄露**：返回值完全匿名，不会暴露本机路径或 `DATA_DIR` 环境变量等任何敏感路径信息（no path disclosure）。
- **不连接 NAS**：该检查仅在本机数据目录进行，不建立任何真实 NAS 连接。
- **不执行远程命令**：该检查不涉及也不执行任何远程命令。
- **认证边界**：若服务端设置 `LINKE_AUTH_TOKEN`、`LINKE_TOKEN`、`LINKE_READ_TOKEN` 或 `LINKE_WRITE_TOKEN`，此端点和其他 `/api/*` 端点一样要求 `Authorization: Bearer <token>`；这仍不是完整生产级 authorization，不包含用户、角色权限、token rotation 或 secret management。

### 发布健康检查 CLI

V0.47 引入了命令行健康检查命令 `agent.js health`。

- **命令示例**：
  ```bash
  node src/agent.js health --server http://localhost:3000
  node src/agent.js health --server http://localhost:3000 --token dev-test-token
  ```
- **说明**：此命令通过 `--server` 指定服务端 URL。它**不需要设备 (--device)** 属性。
- **退出码语义**：
  - 如果服务端健康检查接口响应成功，即使返回 JSON 的 `status` 值为 `"degraded"` (或由于 `dataDir` 异常导致降级)，CLI 仍会以**退出码 0** 退出。
  - 如果服务器不可达、连接失败或请求发生非成功响应，则 CLI 退出码为**非 0**。
  - 判定和处理应由调用方检查返回 JSON 的 `status` / `checks` 字段。

### 发布健康检查 CLI 安全边界

发布健康检查 CLI 具备以下安全保证：
- **只读**：此命令仅执行 GET 查询操作，不做任何状态修改。
- **不写入任何元数据**：不会向本地存储或仓库中写入 any metadata 或其他信息。
- **不连接 NAS**：检查仅在本机和 Linke Server 之间交互，不建立真实 NAS 连接。
- **不执行任何远程命令**：不涉及任何远程或本地的其他命令执行。

### 发布健康检查面板

V0.48 在 Web Console 中新增发布健康检查面板。

- 面板通过手动点击“刷新状态”执行一次只读 GET `/api/health`。
- 面板展示 `status`、版本号、`checks.dataDirReadable` 和响应时间戳。
- 当响应为 `status:"degraded"` 时，面板显示“降级”，但不把降级解释为发布阻断策略；调用者仍需检查 JSON 的 `status` / `checks` 字段。
- 该面板不在启动时请求 `/api/health`，不自动轮询。

### 发布健康检查面板安全边界

发布健康检查面板具备以下安全保证：
- **只读**：仅手动 GET `/api/health`。
- **不写入任何元数据**：不会写入 metadata、设备数据、快照数据或本地配置。
- **不新增接口**：复用既有 `/api/health`，不改变 server route。
- **不连接 NAS**：不建立真实 NAS 连接，不调用 NAS app。
- **不执行远程命令**：不执行任何本地或远程命令。
- **不自动轮询**：V0.48 不做健康检查重试循环。

### 发布版本一致性守卫

V0.49 新增发布版本一致性守卫。

- `src/version.js` 导出 `LINKE_RELEASE_VERSION`，作为当前 Linke 里程碑版本的代码单一来源。
- `/api/health` 的 `version` 字段来自 `LINKE_RELEASE_VERSION`。
- Agent CLI `health` 命令保持纯客户端透传，输出 server health payload 中的版本号，不持有第二份版本常量。
- 测试会校验 README 标题、当前版本 badge、版本表当前行、`buildHealthResponse()`、Agent health 输出和 Web Console release-health 测试示例与 `LINKE_RELEASE_VERSION` 一致。
- `package.json` 的 npm semver 与 Linke 里程碑版本相互独立，V0.x 里程碑不自动映射到 npm 包版本。

### 发布就绪检查 CLI

V0.50 新增发布就绪检查命令 `agent.js release-readiness`。

- **命令示例**：
  ```bash
  node src/agent.js release-readiness --server http://localhost:3000
  node src/agent.js release-readiness --server http://localhost:3000 --expected-version V0.57
  node src/agent.js release-readiness --server http://localhost:3000 --expected-version V0.57 --token dev-test-token
  ```
- **说明**：此命令执行一次只读 `GET /api/health`，根据固定 health schema、`status`、`service`、版本号、`checks.http`、`checks.dataDirReadable` 和 `timestamp` 生成 sanitized readiness report。
- **版本期望**：默认使用当前 `LINKE_RELEASE_VERSION`；滚动更新或外部部署检查可通过 `--expected-version` 显式指定期望版本。
- **退出码语义**：
  - `ready:true` 时退出码 0。
  - 服务已响应但 `ready:false` 时退出码 2，例如 `status:"degraded"`、版本不匹配、schema 出现额外字段或关键 check 失败。
  - 服务器不可达、连接失败、非 2xx 响应或请求错误时退出码 1。
- **输出边界**：输出是 sanitized JSON，不回显原始 health payload；如果响应出现 `dataDir` 等额外字段，仅报告字段名，不输出字段值。

### 发布就绪检查 CLI 安全边界

发布就绪检查 CLI 具备以下安全保证：
- **只读**：仅执行一次 GET `/api/health` 查询，不做任何状态修改。
- **不写入任何元数据**：不会向本地存储或仓库中写入 any metadata 或其他信息。
- **不连接 NAS**：检查仅在本机和 Linke Server 之间交互，不建立真实 NAS 连接，不调用 NAS app。
- **不执行任何远程命令**：不涉及任何远程或本地的其他命令执行。
- **不需要设备参数**：不需要 `--device`、`--source`、`--target`、`--snapshot` 或 `--config`。
- **支持可选 token**：当服务端启用 `LINKE_AUTH_TOKEN` / `LINKE_TOKEN` 时，可用 `--token <token>` 发送 `Authorization: Bearer <token>`。
- **不输出原始 health**：readiness report 只包含 sanitized 字段和 check 结果，不回显路径类字段值。

### 发布就绪检查 API 与 Web Console 面板

V0.51 新增只读 GET /api/release-readiness 端点，并在 Web Console 的 `release-health-panel` 内增加发布就绪网页控制台区块。

- **API 说明**：GET /api/release-readiness 复用 `buildHealthResponse()` 与 `buildReleaseReadinessReport()`，返回 sanitized readiness report。
- **面板说明**：Web Console 只在用户点击“检查就绪”时手动请求 GET /api/release-readiness，展示 ready / 未就绪状态、期望版本、实际版本、失败项数量、检查时间和每项 check 结果。
- **无启动请求**：控制台初始化时不请求 `/api/release-readiness`。
- **不自动轮询**：发布就绪网页控制台不会定时轮询或自动重试。

### 发布就绪网页控制台安全边界

发布就绪网页控制台具备以下安全保证：
- **只读**：仅手动 GET `/api/release-readiness`。
- **不写入任何元数据**：不会写入 metadata、设备数据、快照数据或本地配置。
- **不连接 NAS**：不建立真实 NAS 连接，不调用 NAS app。
- **不执行远程命令**：不执行任何本地或远程命令。
- **不触发备份或恢复**：不创建快照、不复制文件、不覆盖文件、不删除快照。

### Gold readiness scorecard API 与 Web Console 面板

V0.52 新增只读 GET /api/gold-readiness 端点，并在 Web Console 增加 `gold-readiness-panel`。

- **API 说明**：GET /api/gold-readiness 返回静态 code-owned、人工维护的 scorecard，包含 `status`、`version`、`generatedAt`、`summary` 与 `items`；`generatedAt` 仅表示报告生成时间，不代表实时检查时间。
- **面板说明**：Gold readiness Web panel 只在用户点击“检查 Gold”时手动请求 GET /api/gold-readiness，展示 ready / partial / blocked / total 计数、每个 capability/blocker 项、证据与下一步。
- **与 release-readiness 的区别**：`release-readiness` 是 runtime/version gate，用于检查当前运行服务、版本和发布就绪信号；`gold-readiness` 是 capability/blocker scorecard，用于评估完整 Gold 软件发布目标。即使 release-readiness healthy / passing / ok，Gold readiness 也可以因为未实现关键能力而保持 blocked。
- **Gold blockers**：V0.67 将 `nas-dry-run` (包含网页执行门禁、凭证引用展示基础、15 个 credential-like 字段精确拒绝、`readinessSummary` 与 per-target `executionReadiness` dry-run 执行就绪性摘要)、`security-auth` 与 `production-hardening` 标为 partial，明确当前只有 NAS `credentialRef` 非密钥引用基础、`validateNasCredentialRef`、`ALLOWED_NAS_CREDENTIAL_REF_PATTERN`、`FORBIDDEN_NAS_CREDENTIAL_FIELDS` 15 个 exact-key denylist、`credentialRefConfigured` sanitized 输出与网页展示、`executionGate` 网页展示与固定 `remoteExecutionAllowed:false`、固定 blocker codes 只读展示、可选 API Bearer token 骨架、`LINKE_READ_TOKEN` / `LINKE_WRITE_TOKEN` 读写 token foundation、`API_WRITE_ROUTES` 共享写入路由注册表、`isApiWriteRoute` 同一来源授权判断、`formatApiRoute` 与 GET `/api/auth-status` 的 `writeRoutes` 状态报告对齐、403 `Forbidden` / `auth.forbidden` 越权拒绝、GET `/api/auth-status` auth-status readiness API、`buildAuthStatusResponse`、`configuredScopes` / `writeRoutes` sanitized 响应、`tokenValuesReturned:false`、Agent CLI token 支持、Web Console 内存态 token UX、1 MiB 请求体上限、未知 500 `Internal Server Error` 脱敏、可选 `LINKE_RESTORE_ROOT` 恢复目标 guard、恢复目标 symlink 写入防护、本地 audit log foundation、可选 API rate-limit foundation 和可选 audit retention foundation；`real-nas-remote-backup` 仍为 blocked。
- **静态维护规则**：scorecard 的 item list 为静态 code-owned、人工维护清单；每次版本新增能力、变更 ready/partial/blocked 状态、修改 README/API claim 或调整 Gold blocker set 时，必须同步维护该静态清单和测试证据。

### Gold readiness 安全边界

Gold readiness scorecard 具备以下安全保证：
- **只读**：仅手动 GET `/api/gold-readiness`。
- **非实时自动检查**：该接口不扫描证据文件、不运行测试、不探测 NAS/auth/生产环境，只返回版本代码维护的 blocker 清单。
- **无启动请求**：控制台初始化时不请求 `/api/gold-readiness`。
- **不自动轮询**：不会定时轮询或自动重试。
- **不写入任何元数据**：不会写入 metadata、设备数据、快照数据或本地配置。
- **不建立真实 NAS 连接**：不会连接 Synology、Ugreen 或其他 NAS，也不会调用 NAS app。
- **不执行备份或恢复**：不创建快照、不复制文件、不覆盖文件、不删除快照、不执行真实 NAS 远程备份。
- **NAS、认证和生产硬化仍是 partial**：V0.67 只包含 NAS `credentialRef` 非密钥引用基础与网页展示、`credentialRefConfigured` sanitized dry-run 输出与网页展示、15 个 credential-like 字段精确拒绝、固定 `executionGate` 远程执行阻塞与网页展示、`readinessSummary` 与 per-target `executionReadiness` dry-run 执行就绪性摘要、固定 blocker codes 只读展示、`/api/*` 的可选 Bearer token 检查、`LINKE_READ_TOKEN` / `LINKE_WRITE_TOKEN` 读写 token foundation、`API_WRITE_ROUTES` 共享写入路由注册表、`isApiWriteRoute` 同一来源授权判断、`formatApiRoute` 与 GET `/api/auth-status` 的 `writeRoutes` 状态报告对齐、403 `Forbidden` / `auth.forbidden` 越权拒绝、GET `/api/auth-status` 认证状态只读接口、`configuredScopes` / `writeRoutes` sanitized 响应、`tokenValuesReturned:false`、Agent CLI `--token`、Web Console 内存态 token UX、1 MiB 请求体上限、未知 500 `Internal Server Error` 脱敏、可选 `LINKE_RESTORE_ROOT` 恢复目标 guard、恢复目标 symlink 写入防护、本地 audit log foundation、可选 API rate-limit foundation 和可选 audit retention foundation；没有真实 NAS transport、用户、角色权限、生产级审计、secret management、token 轮换、distributed rate limiting、监控或 recovery supervisor。
- **不承诺生产级能力**：该面板不包含生产部署、生产级 authorization、生产级审计、secret management、监控或 recovery supervisor；不得将当前版本用于生产场景。

### Web Console 设备筛选摘要状态

V0.43 为设备筛选摘要（`device-active-filter-summary`）增加只读 `data-active` 状态与 `aria-atomic="true"` 可访问性支持。

- 当筛选状态偏离默认值时，摘要的 `data-active` 属性同步更新为 `true`，以供 CSS 样式钩子使用。
- 当筛选状态处于默认值时，`data-active` 属性更新为 `false`。
- 新增 `aria-atomic="true"`，使得辅助技术能将摘要更新作为一个整体进行播报。

### Web Console 设备筛选摘要状态安全边界

设备筛选摘要状态为纯前端只读派生视图，具备以下安全保证：
- 只读，不新增 API。
- 不重新请求 `/api/devices`。
- 不写入任何元数据。
- 不执行远程命令。
- 不连接 NAS。

### Web Console 保留计划面板

V0.7 在 Web Console 中增加只读保留计划面板。选中设备后，控制台会请求该设备的 `retention-dry-run` 计划，并显示：

- `keepLast` 输入：默认 3，仅允许正整数
- 保留数量与拟淘汰数量
- 每个快照的计划动作：`保留` 或 `拟淘汰`

该面板只做 dry-run 可视化预览，**没有应用策略、清理或删除按钮**，不会删除快照、不会写入文件、不会执行自动清理。

### Web Console 快照清单详情

V0.8 在 Web Console 中增加只读快照清单详情面板。选中设备并点击某个快照后，控制台会读取该快照的 `manifest.json`，并显示：

- 快照 ID
- 原始 `sourcePath`
- 创建时间
- 文件数量
- 备份文件相对路径列表

该面板只读展示 snapshot manifest，**没有修改、重新扫描、恢复执行或删除按钮**，不会修改快照、不会写入 manifest、不会删除任何数据。

### Web Console 快照差异 dry-run

V0.9 在 Web Console 中增加快照差异预览面板。选中设备后，如果该设备至少有两个快照，控制台会用 `diff-dry-run` 比较两个快照的 `manifest.files`，并显示：

- `added`：目标快照新增的相对路径
- `removed`：目标快照不再包含的相对路径
- `unchanged`：两个快照共同包含的相对路径

该面板只比较 manifest 文件路径列表，**不读取文件内容、不比较 hash、不写入文件、不执行恢复、不删除数据**。

### restore-dry-run

V0.10 增加恢复预检 dry-run。给定设备、快照和目标目录后，Linke 会读取 snapshot manifest，并只读扫描目标目录中已存在的相对路径，输出：

- `would-create`：目标目录中不存在、恢复时会创建的文件路径
- `would-overwrite`：目标目录中已经存在、恢复时会覆盖的文件路径
- `summary.totalFiles`、`summary.wouldCreateCount`、`summary.wouldOverwriteCount`

restore-dry-run **不会复制文件、不会覆盖文件、不会创建目录、不会写入目标目录**，也不会修改 `manifest.json`、`snapshots.json` 或其他元数据。

### Web Console 恢复预检 dry-run

V0.10 在 Web Console 中增加恢复预检面板。选中设备和快照后，输入目标目录即可查看 restore-dry-run 计划：

- 拟创建数量
- 拟覆盖数量
- 每个 manifest 文件的 `sourceRelativePath`、目标 `targetPath` 和 `action`

该面板只做恢复预检，**没有真实恢复执行按钮**，不会复制文件、不会覆盖文件、不会写入目标目录。

## 安全边界

**Linke V0.x 是 localhost 原型**，设计为单机开发/测试用途，不具备生产级安全隔离：

### 认证仍是部分骨架

- **可选 Bearer token 仅覆盖 `/api/*`**，未设置 token 时仍是 localhost 原型行为
- **可选读写 token 只提供基础 scope gate**，`LINKE_READ_TOKEN` 访问写入 API 返回 403 `Forbidden` 并记录 `auth.forbidden`，`LINKE_WRITE_TOKEN` 可读写
- **不是完整生产级鉴权**，没有用户、角色权限、生产级审计、secret management、token 轮换、distributed rate limiting 或 proxy 信任策略
- **Web Console 仅支持内存态 token 输入/清除**，不持久保存 token，刷新后需重新输入
- **不可直接暴露到网络**（公网或不受信任的局域网）

### API 路径风险

- `/api/backups` 的 `sourcePath` 是**服务端本机路径**，由调用方直接传入，服务端未做沙箱限制
- `/api/restore` 的 `targetPath` 同样是**服务端本机路径**，恢复操作直接写入该路径

### NAS dry-run 安全保证

- nas-dry-run **不会连接 NAS**，不会发起任何网络请求
- nas-dry-run **不会写入远端**，不会传输任何文件到 NAS 设备
- **拒绝凭证字段**：nasTargets 中不允许出现 `username`、`password`、`token`、`apiKey`、`secret`、`accessKey`、`refreshToken`、`privateKey`、`clientSecret`、`connectionString`、`accessToken`、`idToken`、`secretKey`、`sshKey`、`passphrase` 等 15 个字段
- **拒绝 endpoint userinfo**：endpoint URL 中不允许嵌入 `user:pass@host` 形式的凭证

### launchd dry-run 安全保证

- launchd-dry-run **不会调用 `launchctl`**
- **不会自动安装** plist 到系统目录
- **不会自动启动**任何持久化服务
- 输出路径限制在项目目录内，拒绝路径逃逸

### retention dry-run 安全保证

- retention-dry-run **不会删除任何快照**，不执行任何文件/目录删除操作
- **不会写入任何文件**，不修改 snapshots.json 或其他元数据
- 纯只读操作：读取现有快照列表，输出保留/淘汰计划
- **不承诺自动清理**：当前版本不实现真实删除或自动清理功能

### restore-dry-run 安全保证

- restore-dry-run **不会复制文件**，不会执行真实恢复
- restore-dry-run **不会覆盖文件**，不会改写目标目录中的已有文件
- restore-dry-run **不会写入目标目录**，不会创建目录或写入任何文件
- restore-dry-run **不会修改快照元数据**，不写入 `manifest.json`、`snapshots.json` 或 `device.json`
- 纯只读操作：读取 snapshot manifest，并只读扫描目标目录中已存在的相对路径

### backup-preflight-dry-run 安全保证

- backup-preflight-dry-run **不会创建快照**，不会创建 snapshot 目录
- backup-preflight-dry-run **不会复制文件**，不会把源文件写入仓库
- backup-preflight-dry-run **不会写入 metadata**，不修改 `device.json`、`snapshots.json`、`manifest.json` 或其他仓库元数据
- 纯只读操作：读取 `sourcePath` 的目录项并应用 `excludePatterns`
- 当前版本仍允许调用方传入服务端本机 `sourcePath`，不提供生产级路径沙箱

### 备份任务时间线 snapshot 联动安全保证

- 备份任务时间线 snapshot 联动只调用既有 manifest detail 与 restore-dry-run 读取接口，不执行恢复、不写入 metadata、不连接 NAS。
- 不新增 API 路由、不复制文件、不覆盖文件、不创建目录、不删除快照、不调用 NAS app、不执行远程传输。
- 纯只读操作：复用现有快照清单详情和恢复预检 dry-run 面板展示历史版本内容和恢复影响预览。

### 事件日志面板增强安全保证

- 事件日志面板增强为纯只读展示，数据仅保存在前端内存中，刷新页面即重置。
- 事件日志面板不会保存或写入任何元数据，不触发备份、恢复或删除操作。
- 事件日志最多只在界面展示最近的 50 条记录，累计计数仅作为页面生命周期计数器。
- 该功能不新增任何后端 API 路由。
- 不会建立真实 NAS 连接，不会调用 NAS 应用适配器，不会执行任何远程文件传输。

### 设备备份健康安全保证

- 设备备份健康面板只读取现有 `/api/devices` 响应，在前端生成只读派生视图。
- 不新增 API，不写入任何元数据，不保存健康分类结果。
- 不触发备份、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。
- 未来时间的最后备份会被视为无效备份，避免因时钟漂移误报健康。

### 备份版本一致性安全保证

- 备份版本一致性面板只读取现有 `/api/devices` 与 `/api/devices/:deviceId/snapshots` 响应，在前端生成只读派生视图。
- 不新增 API，不写入任何元数据，不保存一致性分类结果。
- 不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。
- 版本一致性只比较每个任务组最新快照的创建时间和文件数，不读取文件内容，不进行冲突自动处理。

### 版本一致性 snapshot 联动安全保证

- 版本一致性 snapshot 联动只读取现有 `/api/devices/:deviceId/snapshots`、manifest detail、restore-dry-run 和 retention-dry-run 响应。
- 不新增 API，不写入任何元数据，不保存联动状态。
- 不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。
- 点击设备版本行只是切换 Web Console 的只读查看上下文，不会自动选择正确版本或解决冲突。

### 版本一致性筛选与搜索安全保证

- 版本一致性筛选与搜索只读取已加载到浏览器内存中的一致性结果，不重新请求 API，不新增 API。
- 不写入任何元数据，不保存筛选条件，不保存搜索内容。
- 不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。
- 搜索和状态筛选只改变可见任务组列表，不改变一致性分类结果，也不会自动选择正确版本或解决冲突。

### 版本一致性排序控制安全保证

- 版本一致性排序控制只读取已加载到浏览器内存中的一致性结果，不重新请求 API，不新增 API。
- 不写入任何元数据，不保存排序条件。
- 不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。
- 排序只改变可见任务组顺序，不改变一致性分类结果，也不会自动选择正确版本或解决冲突。

### 版本一致性覆盖筛选安全保证

- 版本一致性覆盖筛选只在前端浏览器内存中进行，不重新请求 API，不新增 API。
- 不写入任何元数据，不保存筛选条件。
- 不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。
- 覆盖率筛选只改变可见任务组列表，不改变一致性分类结果，也不会自动选择正确版本或解决冲突。

### 版本一致性覆盖缺口排序安全保证

- 版本一致性覆盖缺口排序只在前端浏览器内存中进行，不重新请求 API，不新增 API。
- 不写入任何元数据，不保存排序条件。
- 不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。
- 排序只改变可见任务组顺序，不改变一致性分类结果，也不会自动选择正确版本或解决冲突。

### 版本一致性覆盖率显示安全保证

- 版本一致性覆盖率显示只在前端浏览器内存中进行，不重新请求 API，不新增 API。
- 不写入任何元数据，不保存覆盖率结果。
- 不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。
- 覆盖率显示只改变任务组覆盖行的文字表达，不改变一致性分类结果、覆盖筛选结果或覆盖缺口排序结果。

### 版本一致性无可观测设备回退安全保证

- 版本一致性无可观测设备回退处理完全在前端浏览器内存中进行，不重新请求 API，不新增 API。
- 不写入任何元数据，不保存回退提示状态。
- 不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。
- 无可观测设备回退展示只改变任务组覆盖行的文字表达，不改变一致性分类结果、覆盖筛选结果或覆盖缺口排序结果。

### 版本一致性无可观测设备筛选安全保证

- 版本一致性无可观测设备筛选只读取已加载到浏览器内存中的一致性结果，不重新请求 API，不新增 API。
- 不写入任何元数据，不保存筛选条件。
- 不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。
- 该筛选只改变可见任务组列表，不改变一致性分类结果，也不会自动选择正确版本或解决冲突。

### 备份版本一致性覆盖缺口摘要安全保证

- 备份版本一致性覆盖缺口摘要为纯只读展示，在前端生成只读派生视图。
- 该功能不重新请求 API，不新增 API。
- 不写入任何元数据，不保存任何一致性或覆盖分类结果。
- 不触发备份、不执行同步、不执行恢复、不删除快照、不连接 NAS、不调用 NAS app、不执行远程文件传输。
- 覆盖缺口摘要只检测可观测设备是否成功上传该任务组的快照，不修改设备配置或快照元数据。

### 备份版本覆盖与缺口统计

版本一致性面板包含覆盖缺口摘要统计。由于单设备任务组（`single-device`）也属于存在设备覆盖缺失的情况，因此覆盖缺口计数与单设备任务组有重叠。两者并不是互斥的问题，UI/README 透明表达了这种重叠，不制造互斥的错觉。若设备快照加载失败，该设备将被自动排除或进行降级提示，不计入覆盖缺口分母，以避免虚高覆盖要求。

### NAS 实现现状

> **重要**：当前 NAS 实现仅为 **dry-run provider 骨架**。它只负责验证配置结构和输出计划，**不会建立真实 NAS 连接**，不会执行真实远程备份。真实 NAS 传输功能尚未实现。

## API

| 方法   | 路径                                        | 说明               |
| ------ | ------------------------------------------- | ------------------ |
| GET    | /                                           | Web Console        |
| GET    | /api/backup-preflight-dry-run              | 备份预检 dry-run   |
| GET    | /api/devices                                | 设备列表           |
| GET    | /api/devices/:deviceId/snapshots            | 设备快照列表       |
| GET    | /api/devices/:deviceId/snapshots/:snapshotId/manifest | 快照 manifest 详情 |
| GET    | /api/devices/:deviceId/snapshots/:snapshotId/restore-dry-run | 恢复预检 dry-run |
| GET    | /api/devices/:deviceId/snapshots/diff-dry-run | 快照差异 dry-run   |
| GET    | /api/devices/:deviceId/retention-dry-run    | 快照保留 dry-run   |
| GET    | /api/health                                 | 发布健康检查       |
| GET    | /api/release-readiness                      | 发布就绪检查       |
| GET    | /api/gold-readiness                         | Gold readiness scorecard |
| GET    | /api/auth-status                            | 认证状态只读检查   |
| GET    | /api/audit-log                              | 本地审计日志只读查询 |
| POST   | /api/heartbeat                              | 记录心跳           |
| POST   | /api/backups                                | 创建备份快照       |
| POST   | /api/nas-dry-run                            | NAS 预检 dry-run   |
| POST   | /api/restore                                | 从快照恢复         |

## 测试

```bash
npm test
```

测试覆盖：心跳、备份/恢复、并发隔离、路径安全、excludePatterns、run-once、launchd-dry-run、nas-dry-run、NAS app adapter dry-run、NAS credentialRef 非密钥引用、`validateNasCredentialRef`、`ALLOWED_NAS_CREDENTIAL_REF_PATTERN`、`FORBIDDEN_NAS_CREDENTIAL_FIELDS` 15 字段 denylist、`credentialRefConfigured`、`executionGate`、`readinessSummary`、per-target `executionReadiness`、固定 NAS blocker codes、Web NAS execution gate display、Web NAS execution readiness summary rendering、Agent nas-dry-run CLI readiness summary、retention-dry-run、restore-dry-run、backup-preflight-dry-run、manifest 详情 API、snapshot diff dry-run API、Web Console 契约、保留计划面板、快照清单详情面板、恢复预检面板、备份预检面板、NAS dry-run 面板、备份预检命令提示与快照差异预览面板、设备详情面板、备份任务概览面板、备份任务详情时间线面板、备份任务时间线 snapshot 联动、事件日志面板增强、设备备份健康面板、备份版本一致性面板、版本一致性 snapshot 联动、版本一致性筛选与搜索、版本一致性非最新摘要、版本一致性排序控制、覆盖缺口摘要、版本一致性覆盖筛选、版本一致性覆盖缺口排序、版本一致性覆盖率显示、版本一致性无可观测设备回退、版本一致性无可观测设备筛选、统一管理态、管理态筛选、管理态分桶统计、管理态分桶选中态、管理态分桶作用域、管理态判定提示、设备列表空态筛选上下文、设备筛选重置、设备筛选重置状态、设备筛选摘要、设备筛选摘要状态、设备筛选计数状态、设备筛选计数指标、发布健康检查、发布健康检查 CLI、发布健康检查面板、发布版本一致性守卫、发布就绪检查 CLI、发布就绪网页控制台、Gold readiness scorecard、GET /api/gold-readiness、gold-readiness-panel、可选 Bearer token API 认证骨架、Agent CLI `--token`、Web Console 内存态 API token UX、API read/write token foundation、`LINKE_READ_TOKEN`、`LINKE_WRITE_TOKEN`、403 `Forbidden`、auth.forbidden、shared write-route registry、`API_WRITE_ROUTES`、`formatApiRoute`、`isApiWriteRoute`、auth status readiness API、GET /api/auth-status、buildAuthStatusResponse、configuredScopes、writeRoutes、tokenValuesReturned:false、请求体上限 413、未知 500 `Internal Server Error` 脱敏、`LINKE_RESTORE_ROOT` 恢复目标 guard、restoreRoot symlink 逃逸拒绝、目标文件 symlink 拒绝、中间目录 symlink 拒绝、`O_NOFOLLOW` restore 写入防护、本地 audit log foundation、GET /api/audit-log、JSONL 事件 allowlist、auth.denied、敏感字段不落盘、API rate-limit foundation、`LINKE_RATE_LIMIT_PER_MINUTE`、429 `Rate limit exceeded`、`api.rate_limited`、audit retention foundation、`LINKE_AUDIT_MAX_EVENTS`、最新 N 条审计事件保留、审计保留并发 append 串行化。

## 技术约束

- Node.js ESM，零外部运行时依赖
- 仅使用 Node 内置模块（node:http, node:fs/promises, node:path, node:crypto, node:os）
- 原子元数据写入（write-to-tmp + rename）
- deviceId slug 化防止路径穿越攻击

## 未实现 / 不在当前范围

以下内容 **尚未实现**，请勿将当前版本用于对应场景：

- ❌ 真实快照删除 / 自动清理（retention-dry-run 仅输出计划，不执行删除）
- ❌ 真实 NAS 连接与远程文件传输
- ❌ 多设备间数据互相同步
- ❌ 文件版本冲突自动处理
- ❌ 完整生产级认证/鉴权（当前仅有 optional Bearer token auth skeleton）
- ❌ 自动启动守护进程（需用户手动配置 launchd）
- ❌ 生产环境部署
