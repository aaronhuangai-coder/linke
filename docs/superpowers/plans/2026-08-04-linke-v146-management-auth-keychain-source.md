# Linke V1.46 管理鉴权 Keychain 来源实施计划

> 依据 `2026-08-04-linke-v146-management-auth-keychain-source-design.md`。implementer 为 fresh Grok 4.5 high；GLM-5.2 负责只读抗辩；Qwen 只统计；fresh Grok 复审；Kimi K3 闭环；Codex 独立验证与裁决。

## 1. 安全边界

- 只在隔离候选树中实施，候选树不得包含 `.git`、`.env`、credentials、SSH、真实 Keychain 内容或 `package-lock.json`。
- 不运行真实 Keychain gated test，不调用 `/usr/bin/security`，不执行部署、LaunchAgent、邮件、NAS 或生产写入。
- 只允许修改：
  - `src/management-auth-keychain.js`
  - `src/controller-runtime.js`
  - `test/management-auth-keychain.test.js`
  - `test/controller-runtime.test.js`
  - `README.md`
  - `test/readme.test.js`
- 禁止修改 `src/keychain-store.js`、`src/server.js`、`src/gold-readiness.js`、版本文件和依赖文件。
- 任何 timeout、429、空输出、无 diff、越界 diff、schema 缺失或角色自称本地事实均为 HOLD，只替换失败角色。

## 2. 回滚锚点与隔离

1. 记录当前 HEAD、branch、tracked status 和 allowlist 文件 SHA-256。
2. 在 `.superpowers/linke-management-auth-keychain/rollback/pre-integration/` 保存只读基线清单和目标文件副本/缺失标记；该目录不纳入提交。
3. 从当前 HEAD 导出不含 `.git` 的 reference tree 与 candidate tree；排除既有未跟踪文件及 `package-lock.json`。
4. 验证候选与 reference 初始 tracked 内容一致，且没有 symlink/sensitive 文件。

## 3. RED：测试先行

Grok 首先只修改两个测试文件：

- `test/management-auth-keychain.test.js`
- `test/controller-runtime.test.js`

RED 必须覆盖 design §9 的核心行为：

1. selector/scopes 严格解析与七项 env 混用拒绝。
2. 固定 item mapping、声明顺序、未声明零读取。
3. previous/current presence 配对。
4. missing/unavailable/empty fail closed。
5. `startController` 在 filesystem/TLS/listen 之前读取，并复用注入 keychain。
6. real controller HTTP scope 行为与 Agent/status/log 零泄漏。

Codex 将 tests-only candidate 复制到 detached old-HEAD 参考树，并运行精确 focused command。有效 RED 只能因生产能力缺失而失败；import、syntax、fixture、临时路径或测试自身错误必须先修复。

## 4. GREEN：最小生产实现

Grok 仅实现 frozen contract：

1. 新增 `src/management-auth-keychain.js` 的固定映射、纯解析/验证和 fake-friendly loader。
2. `parseControllerEnv()` 接入 selector/scopes，legacy precedence 不变。
3. `startController()` 在纯校验后、任何 filesystem/TLS/listen 前复用 `resolvedKeychain` 读取令牌。
4. management factory 使用 resolved tokens；Agent/status/log 保持无 token own-property/value。
5. 不改 KeychainStore、server 规范化、error-code registry 或 Gold readiness。

Grok 必须自跑：

```bash
node --test test/management-auth-keychain.test.js test/controller-runtime.test.js
```

并报告 changed files、测试计数、已知 P2 与 `RESULT: DONE|BLOCKED`。

## 5. README 与契约测试

在核心 GREEN 后补：

- README 的 `npm start` 配置示例与固定 item 映射。
- 明确 Keychain 与 token env 不能混用、启动快照非原子、更新后需受控重启。
- 明确自动测试只用 fake Keychain，未访问真实凭据，Gold/security-auth 仍 partial。
- `test/readme.test.js` 仅断言上述可验证边界，不增加 Gold ready 文案。

## 6. Codex 独立验证

Codex 将候选结果做 allowlist/hash/敏感名/symlink 检查，再复制精确目标文件回主 worktree。按顺序执行：

```bash
node --test test/management-auth-keychain.test.js test/controller-runtime.test.js test/readme.test.js
npm test
git diff --check
git status --short
git diff --stat
```

同时人工核验：

- selector/scopes 在 Keychain 构造/读取前纯验证。
- management 读取在 dataDir/TLS/listener 前。
- 同一 keychain 实例复用。
- 无 env fallback、无真实 `security` 调用、无 token 日志/status/Agent 泄漏。
- 未修改 `src/keychain-store.js`、`src/server.js`、`src/gold-readiness.js`。

## 7. 多模型闭环

1. Qwen 只统计 exact diff：文件数、增删行、测试数、allowlist、Gold 文案变化；不批准代码。
2. fresh Grok 只读审查 exact diff + focused/full 输出，固定输出 `VERDICT`、P0/P1/P2、`PROCEED`。
3. Kimi K3 helper 汇总 GLM 裁决、old-HEAD RED、GREEN/full、Qwen、fresh Grok 和 Git evidence，固定输出 `VERDICT`、`CLOSURE_READY`、Gold 边界。
4. P0/P1、测试失败、missing schema 或模型无结论均 HOLD；由原 implementer 在同一候选上下文修复后重新完成 Codex 验证与 fresh review。

## 8. 提交边界

仅当以下全部满足才 commit/push：

- old-HEAD 行为 RED 有效。
- focused/full 测试全部通过。
- `git diff --check` 通过且 tracked diff 精确命中 allowlist。
- fresh Grok 无 P0/P1 且 `PROCEED: YES`。
- Kimi schema 完整且 `CLOSURE_READY: YES`。
- Codex 确认 Gold 仍 partial、无真实 Keychain/部署证据被虚构。

建议提交信息：

```text
feat: load management auth from Keychain
```

push 后重新确认 HEAD 与远端一致，然后继续刷新 `security-auth` 下一个实际缺口；不创建 PR、不 merge、不部署。
