# Linke V0.27 版本覆盖缺口摘要 Lite 面板执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Web Console “备份版本一致性”面板下方新增“版本覆盖缺口摘要 Lite”，展示各任务组的可观测覆盖情况（覆盖设备数、可观测覆盖设备数、缺失设备数及缺失设备列表），并支持排除加载失败的设备。

**Architecture:** 扩展纯函数 `buildBackupVersionConsistency(devices, snapshotsByDevice, options = {})` 计算覆盖数据。在 DOM 中渲染汇总行和任务缺口元素，通过捕获加载失败异常排除相应设备，确保全流程无后端改动。

**Tech Stack:** Node.js built-in test runner, plain browser DOM/ESM, vanilla CSS.

## Global Constraints

- 当前版本更新为 V0.27。
- 遵循 TDD 规范，仅修改允许范围内的文件。
- 不新增后端 API，不写入 metadata，不执行实际备份、同步、恢复、淘汰或远程 NAS 连接。
- 使用中性口径“可观测覆盖设备”替代“期望覆盖设备”。
- 在 expectedDeviceCount 为 0 时，不在 coverage.fullyCoveredCount 中累计该任务组。
- 新增注释需使用中文或删除，避免新增英文注释。

---

### Task 1: RED Tests

**Files:**
- Modify: `test/web-console.test.js`

**Interfaces:**
- Consumes: `buildBackupVersionConsistency(devices, snapshotsByDevice, options)`
- Produces: failing assertions for V0.27 coverage gap fields and DOM elements

- [ ] **Step 1: 增加纯函数覆盖率测试断言**
  在测试中增加对 `buildBackupVersionConsistency` 返回的 `coverage` 统计及单个任务组 `expectedDeviceCount`、`coveredDeviceCount`、`missingDeviceCount` 和 `missingDeviceNames` 的校验。针对 `expectedDeviceCount` 为 0 的情况增加完全覆盖计数不累加的断言。
- [ ] **Step 2: 增加 HTML/DOM 测试断言**
  增加测试对 `data-testid="version-consistency-coverage-summary"` 和 `data-testid="version-consistency-coverage-gap"` 渲染的断言，确保能够正常加载并显示。
- [ ] **Step 3: 运行并确认 RED**
  执行 `node --test test/web-console.test.js`，验证新增测试用例呈 RED（失败）状态。

### Task 2: Implementation

**Files:**
- Modify: `src/web/app.js`
- Modify: `src/web/styles.css`

**Interfaces:**
- Produces: `summary.coverage` object, `missingDeviceNames`, `.version-consistency-coverage-summary`, `.version-consistency-coverage-gap` styles

- [ ] **Step 1: 升级 buildBackupVersionConsistency 数据计算**
  在 `buildBackupVersionConsistency` 中引入 `options.excludedCoverageDeviceIds`，过滤 `expectedDevices`。对每个任务组统计可观测覆盖设备数与缺失设备名，当 `expectedDeviceCount > 0 && missingDeviceCount === 0` 时计入 `fullyCoveredCount`。
- [ ] **Step 2: 更新 DOM 渲染与加载错误捕获**
  在 `initConsole` 相关的 `setVersionConsistencyCounts` 与 `renderVersionConsistencyRows` 中，格式化并设置覆盖汇总文案（使用中性文案：“按当前可观测设备口径存在缺失，包含单设备任务组”），以及各任务组缺失状态。在 `fetchBackupVersionConsistency` 加载设备快照失败时，将该设备 ID 排除。
- [ ] **Step 3: 引入轻量级 CSS 样式**
  在 `styles.css` 中增加 `.version-consistency-coverage-summary` 和 `.version-consistency-coverage-gap` 的轻量级样式，风格与 staleness-summary 类似但保持简洁、不高调。
- [ ] **Step 4: 运行并确认 GREEN**
  执行 `node --test test/web-console.test.js`，验证全部测试用例呈 GREEN（通过）状态。

### Task 3: README And Plan Documentation

**Files:**
- Modify: `README.md`
- Modify: `test/readme.test.js`
- Modify: `docs/superpowers/specs/2026-07-05-version-coverage-gap-summary-design.md`
- Modify: `docs/superpowers/plans/2026-07-05-version-coverage-gap-summary.md`

**Interfaces:**
- Produces: V0.27 README version history, feature description, safety boundary, and test coverage documentation

- [ ] **Step 1: 更新 README 测试**
  在 `test/readme.test.js` 中更新当前版本、版本表、特性列表、安全保证、覆盖缺口摘要说明和测试覆盖断言。
- [ ] **Step 2: 更新 README 正文**
  将 README 当前版本更新为 V0.27，新增“覆盖缺口摘要 Lite”功能说明，明确 single-device 与 coverage gap 有重叠，并声明只读、安全边界和不新增 API。
- [ ] **Step 3: 更新设计与执行计划文档**
  在 `docs/superpowers/specs/2026-07-05-version-coverage-gap-summary-design.md` 与本计划中记录可观测覆盖设备口径、加载失败排除和最终验证命令。
- [ ] **Step 4: 验证 README 测试**
  执行 `node --test test/readme.test.js`，确认 README 文档测试通过。

## Final Verification

```bash
node --test test/web-console.test.js test/readme.test.js
node --test --test-reporter=dot test/*.test.js
git diff --check
```
