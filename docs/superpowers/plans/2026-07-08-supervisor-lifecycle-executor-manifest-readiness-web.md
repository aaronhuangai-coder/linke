# Linke V1.04 Supervisor Lifecycle Executor Manifest Readiness Web

## 目标

在现有 Web Console supervisor lifecycle approval preview panel 中增加一个手动 executor manifest readiness 预检入口，复用 V1.03 的只读 API，不引入真实 lifecycle 执行。

## Role Map

- PM: Codex
- Implementer: AGY 候选实现超时退出但留下 diff，PM 复核后接手修补
- Adversary: Qwen
- Closure verifier: DeepSeek 辅助验收，最终事实裁决仍由 Codex PM 基于本地命令输出完成

## 范围

- 增加 `supervisor-lifecycle-executor-manifest-readiness-manifest` textarea。
- 增加 `supervisor-lifecycle-executor-manifest-readiness-button`。
- 手动 POST `/api/supervisor-lifecycle-executor-manifest-readiness`。
- 请求体只包含 inline `operation`、`config` 与 `manifest`。
- 增加 `buildSupervisorLifecycleExecutorManifestReadinessViewModel`，展示 `manifestReady`、`executorReady:false`、`manifestBlockers`、`nextBlockers`、action manifests 的 `wouldRun:false` / `wouldWrite:false` 与 safety flags。
- 同步 README、版本号、Gold readiness 证据与测试。

## 非目标

- 不读取本地 manifest path、config path、approval path 或 dataDir。
- 不提交 approval JSON，不读取 approval store。
- 不执行 lifecycle apply，不调用 launchctl。
- 不写 metadata、LaunchAgents、audit 或 approval storage。
- 不连接 NAS、不触发备份/恢复、不执行远程命令。

## 验收目标

- 控制台初始化不请求 manifest readiness API。
- 空/非法 config JSON 和 manifest JSON 在前端本地拦截。
- 手动按钮只发送 inline config/manifest，不发送 approval JSON。
- Web 渲染 `manifestReady:false`、`executorReady:false`、`guarded-executor-runner-missing`、manifest blockers、action manifest `wouldRun:false` / `wouldWrite:false` 与 safety flags。
- 路径、URL、token、hash 与 command-like 文本不回显。
- in-flight 状态阻止重复请求。

## Gold 边界

V1.04 只是只读 manifest readiness Web/API 前置层。真实 installer、launchd install/start、watchdog、monitoring、runner binding、rollback、uninstall、recovery supervisor、real NAS remote backup、production auth、secret management 与生产级审计仍未实现，Gold 仍 blocked。
