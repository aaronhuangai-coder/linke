# Audit-Integrity Alert Destination Allowlist 与 Public-DNS Pin 实施计划

> 执行方式：pm-dcw；Codex 主控，Grok 4.5 strict 实现，GLM 抗辩，Kimi K3 闭环验收。

**目标：** 在 claim 前加入 exact destination allowlist，并在每次 HTTPS attempt 内完成全量 public-DNS 校验与 lookup pin；保持现有 at-least-once claim 语义与 Gold 诚实边界。

**设计：** [2026-08-05-audit-integrity-alert-destination-allowlist-design.md](../specs/2026-08-05-audit-integrity-alert-destination-allowlist-design.md)

**基线：** `b48edf5`

## 全局约束

- 只使用行为特定 TDD：先冻结 test hash，证明 old-head 只因目标能力缺失而 RED。
- 所有 DNS/request tests 使用 fake dependency；禁止真实 DNS、真实 socket、真实 endpoint。
- 不读取或输出 env/key/token/credential。
- 不修改 Agent/API/Web/LaunchAgent/deploy。
- 不引入 npm dependency，不暂存 `package-lock.json`。
- 每个 Task 独立 commit/push/upstream equality。
- fresh reviewer 输出缺 schema、空输出、429/timeout 时 HOLD 并只替换 reviewer。
- Gold 保持 partial 6/3/0/9；本计划不发布 Gold。

---

## Task 1：Exact destination policy

**新增：**

- `src/audit-integrity-alert-destination-policy.js`
- `test/audit-integrity-alert-destination-policy.test.js`

### 1.1 RED

先只创建测试，覆盖：

- exports：`createAuditIntegrityAlertDestinationPolicy`；
- missing/null/exact empty policy → deny-all capability；
- 1 与 16 endpoints → configured；17 拒绝；
- duplicate 拒绝；
- exact schema/key order；
- endpoint URL/host/port/path closed matrix；
- reserved/private suffix、IP literal、punycode/non-ASCII；
- Proxy/accessor/symbol/non-enumerable/class/Array subclass/String wrapper/URL/Buffer/Uint8Array；
- caller mutation 不改变 capability；
- exact membership；
- deny 固定 `audit-delivery-unavailable`；
- endpoint/policy 不出现在 public error/receipt；
- source import closed set。

运行：

```bash
node --check test/audit-integrity-alert-destination-policy.test.js
node --test test/audit-integrity-alert-destination-policy.test.js
```

old-head 必须精确为 implementation missing 的单一失败；不能是 import/fixture/syntax 噪声。

### 1.2 GREEN

实现最小 production module：

- strict plain data validation；
- raw policy defensive copy；
- deep-frozen exact capability；
- canonical endpoint predicate；
- deny-all default；
- no env/IO/network/DNS/timer/credentials。

验证：

```bash
node --check src/audit-integrity-alert-destination-policy.js
node --test test/audit-integrity-alert-destination-policy.test.js
git diff --check
```

### 1.3 Review / commit

Kimi full-file closure 必须 P0/P1 none、CLOSURE_READY YES。

```bash
git add src/audit-integrity-alert-destination-policy.js test/audit-integrity-alert-destination-policy.test.js
git diff --cached --check
git diff --cached --name-only
git commit -m "feat: add audit alert destination allowlist"
git push
```

---

## Task 2：Authorize-before-claim one-shot gate

**新增：**

- `src/audit-integrity-alert-delivery-authorized-once.js`
- `test/audit-integrity-alert-delivery-authorized-once.test.js`

### 2.1 RED

测试 exact APIs：

```js
createAuthorizedAuditIntegrityAlertDeliveryOnce(policy)
createAuthorizedAuditIntegrityAlertDeliveryOnceForTesting(deps)
```

覆盖：

- test deps exact order `authorizeDestination, deliverOnce`；
- authorize deny/throw → zero deliverOnce；
- authorized primitive 才传入 deliverOnce；
- `dataDir, endpoint, now` primitive/identity 顺序不漂移；
- missing/null/empty production policy deny-all；
- configured production factory 绑定真实 policy + real one-shot；
- hostile dependency/output；
- error fixed、无 endpoint/dataDir/claim/body/header/token/path；
- source import only policy/one-shot/error-codes/util；
- source no DNS/request/timer/fs/env/Agent/API/Web/scheduler。

old-head RED 必须是单一 implementation missing。

### 2.2 GREEN

实现：

```text
authorize(endpoint)
  -> authorized canonical primitive
  -> deliverOnce(dataDir, authorized, now)
```

deny 不得构造 claim 或触发低层 deliver。

验证：

```bash
node --test test/audit-integrity-alert-delivery-authorized-once.test.js test/audit-integrity-alert-destination-policy.test.js test/audit-integrity-alert-delivery-once.test.js
git diff --check
```

### 2.3 Review / commit

```bash
git add src/audit-integrity-alert-delivery-authorized-once.js test/audit-integrity-alert-delivery-authorized-once.test.js
git commit -m "feat: gate audit alert delivery by destination policy"
git push
```

---

## Task 3：Public address classifier

**新增：**

- `src/audit-integrity-alert-public-address.js`
- `test/audit-integrity-alert-public-address.test.js`

### 3.1 RED

导出：

```js
isPublicAuditIntegrityAlertAddress(address, family)
```

返回 strict boolean，不抛、不回显。

测试：

- primitive IPv4/IPv6 public positives；
- IPv4 deny CIDR 每个 prefix：前一地址、首地址、末地址、后一地址；
- IPv6 only `2000::/3`；
- `2001::/23`、`2001:db8::/32`、`2002::/16`、`3fff::/20` 边界；
- IPv4-mapped、NAT64、Teredo、6to4、ULA/link-local/site-local/multicast；
- whitespace、CIDR、zone id、hostname、leading-zero IPv4；
- family mismatch、family string、Proxy/String wrapper；
- source no DNS/network/IO/env。

old-head RED 必须只因 module missing。

### 3.2 GREEN

实现：

- `net.isIP` exact family gate；
- IPv4 unsigned integer + prefix table；
- IPv6 exact parser to 8 hextets/128-bit；禁止 IPv4 tail与scope；
- conservative allow/deny；
- no external dependency。

验证：

```bash
node --test test/audit-integrity-alert-public-address.test.js
git diff --check
```

### 3.3 Review / commit

```bash
git add src/audit-integrity-alert-public-address.js test/audit-integrity-alert-public-address.test.js
git commit -m "feat: classify public audit alert destinations"
git push
```

---

## Task 4：Bounded transport DNS pin

**修改：**

- `src/audit-integrity-alert-https-transport.js`
- `test/audit-integrity-alert-https-transport.test.js`

### 4.1 冻结现有基线

先记录当前 test SHA-256，运行现有 29/29（或当前精确总数）GREEN，确保旧契约基线。

### 4.2 RED additions

先只修改 test：

- 新 constants：DNS timeout 4000、request body bound 8192、max DNS answers 16；
- test deps exact order 增加 `lookupAll`；
- production source only `node:dns` added；
- descriptor validation/body 8192/8193 在 timer/DNS/request 前；
- request options：
  - `agent:false`
  - `autoSelectFamily:true`
  - `autoSelectFamilyAttemptTimeout:250`
  - custom `lookup`
  - existing TLS exact options；
- fake request 必须主动调用 `options.lookup(hostname,{all:true},cb)` 才继续 response；
- DNS called exactly once；
- empty/error/hang/malformed/duplicate/17/mixed special fail fixed；
- all-public dual stack 返回全部 validated addresses；
- lookup options 非 `all:true` fail；
- DNS subdeadline 3999/4000 fake timers；
- total 9999/10000 仍覆盖；
- late lookup callback single-settle；
- original URL hostname 保持，不替换为 IP；
- no hostname/IP/resolver error leak；
- existing status 199/200/299/300、response 4096/4097、302 no-follow、uncertain matrix不退化。

在未改 production 时，失败必须只来自 lookup/public-address/body-bound 新行为。

### 4.3 GREEN

实现：

- import `node:dns` + public predicate；
- exact `lookupAll` production wrapper；
- lookup single-settle + DNS sub-timer；
- all-answer validation；
- explicit auto family；
- 保持 total timer 和 transport settle architecture；
- 不缓存，不真实 probe。

验证：

```bash
node --test test/audit-integrity-alert-https-transport.test.js test/audit-integrity-alert-public-address.test.js
node --test test/audit-integrity-alert-delivery-once.test.js test/audit-integrity-alert-delivery-claim.test.js test/audit-integrity-alert-outbox.test.js
git diff --check
```

### 4.4 Review / commit

```bash
git add src/audit-integrity-alert-https-transport.js test/audit-integrity-alert-https-transport.test.js
git commit -m "feat: pin audit alert transport to public DNS"
git push
```

---

## Task 5：Authorized delivery integration

**修改：**

- `test/audit-integrity-alert-delivery-authorized-once.test.js`

如 production integration 需要最小修正，唯一允许额外修改：

- `src/audit-integrity-alert-delivery-authorized-once.js`

### 5.1 RED/GREEN integration

使用真实：

- destination policy；
- authorized one-shot；
- claim coordinator；
- updated HTTPS transport factory。

仅 fake：

- `lookupAll`；
- `request`；
- timers/time/process identity fault points。

覆盖：

1. policy deny → zero outbox claim state、zero DNS/request；
2. allow + empty/busy → zero DNS/request；
3. allow + public DNS + 2xx → exact FIFO complete；
4. allow + public DNS + bounded non-2xx → release/head unchanged；
5. allow + mixed/private DNS → durable claim remains；
6. DNS timeout → durable claim remains；
7. accepted then complete failure → never release；
8. concurrent authorized calls → one claim/one request，另一 busy；
9. public errors无 endpoint/IP/dataDir/body/token/path；
10. 无真实 DNS/socket。

验证：

```bash
node --test test/audit-integrity-alert-delivery-authorized-once.test.js test/audit-integrity-alert-delivery-once.test.js test/audit-integrity-alert-https-transport.test.js test/audit-integrity-alert-destination-policy.test.js test/audit-integrity-alert-public-address.test.js
git diff --check
```

### 5.2 Review / commit

```bash
git add test/audit-integrity-alert-delivery-authorized-once.test.js
git add src/audit-integrity-alert-delivery-authorized-once.js
git diff --cached --name-only
git commit -m "test: prove authorized audit alert delivery flow"
git push
```

只在 source 实际修改时 stage source；cached name list 必须与实际 diff 一致。

---

## Task 6：README / Gold honesty

**修改：**

- `README.md`
- `src/gold-readiness.js`
- `test/readme.test.js`
- `test/gold-readiness.test.js`

### 6.1 Documentation RED

要求 current evidence 新增：

```text
exact audit-integrity alert destination allowlist
src/audit-integrity-alert-destination-policy.js
test/audit-integrity-alert-destination-policy.test.js
authorize-before-claim delivery gate
src/audit-integrity-alert-delivery-authorized-once.js
public-DNS closed-set validation and per-attempt lookup pin
src/audit-integrity-alert-public-address.js
all DNS answers must be public
mixed public/special answers fail closed and preserve the durable claim
4-second DNS sub-deadline within the 10-second total deadline
agent:false and explicit autoSelectFamily:true
```

继续要求直接 negatives：

```text
no external endpoint configuration wiring
no automatic retry
no dead-letter handling
not managed scheduler
not real remote notification delivery
not production monitoring ready
not end-to-end production audit delivery
not production-hardening ready
not Gold
```

status/summary 固定 partial 与 6/3/0/9。

old-head RED 必须只有新 documentation honesty assertions。

### 6.2 GREEN / full suite

```bash
node --test test/readme.test.js test/gold-readiness.test.js
node --test test/audit-integrity-alert-destination-policy.test.js test/audit-integrity-alert-delivery-authorized-once.test.js test/audit-integrity-alert-public-address.test.js test/audit-integrity-alert-https-transport.test.js test/audit-integrity-alert-delivery-once.test.js
npm test
git diff --check
```

full suite 必须 zero failure；仅允许仓库既有 environment-gated skips。隔离路径若再次触发 `/private` 既有假失败，必须在 `/Users/...` 源路径复验 full suite。

### 6.3 Closure / commit

Kimi 输入 exact four-file diff、全部实现 commit hashes、RED/GREEN/full-suite totals 与 Gold boundary。

```bash
git add README.md src/gold-readiness.js test/readme.test.js test/gold-readiness.test.js
git diff --cached --check
git diff --cached --name-only
git commit -m "docs: document audit alert destination policy"
git push
git rev-parse HEAD
git rev-parse @{u}
```

两 revision 必须相等。

---

## Task 7：批次关闭与下一步

确认：

- Task 1..6 commits 均已 push；
- source worktree 仅保留用户既有 untracked files；
- `package-lock.json` 未 stage；
- 无真实 DNS/network evidence 被误写成 remote-delivery PASS；
- Gold 仍 partial 6/3/0/9。

下一批只进入 durable retry/backoff/dead-letter design；先做 GLM adversarial review，再写 spec/plan，不在本批顺带实现 scheduler。
