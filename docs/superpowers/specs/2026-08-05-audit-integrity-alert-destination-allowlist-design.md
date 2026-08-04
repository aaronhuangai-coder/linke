# Linke V1.46 Audit-Integrity Alert Destination Allowlist 与 Public-DNS Pin 设计

日期：2026-08-05
状态：设计冻结，待 TDD 实现
基线：`7caef476e6ade83849b6ef1cd7dddd02957b9c00`

## 1. 目标

在现有 bounded HTTPS transport 与 durable claim/one-shot coordinator 之间增加两层互补门：

1. claim 之前的 exact destination allowlist；
2. 每次 transport attempt 内的 public-DNS closed-set 校验与 lookup pin。

本批关闭“任意 HTTPS URL 可被未来 untrusted wiring 用于 SSRF”的基础风险，同时保持：

- endpoint deny 时零 claim、零 DNS、零 request；
- DNS/TLS/timeout 等不确定结果保留 durable claim；
- bounded final non-2xx 仍 release；
- accepted 2xx 仍 complete；
- at-least-once，不宣称 exactly-once。

## 2. 非目标

本批不实现或宣称：

- policy 文件持久化、签名、hot reload 或环境变量装配；
- API/Web/Agent 外部 endpoint 配置；
- automatic retry、backoff、dead-letter 或 managed scheduler；
- SPKI/certificate pinning、mTLS、enterprise proxy；
- real production webhook acceptance；
- remote notification delivery ready；
- production monitoring ready；
- end-to-end production audit delivery；
- production-hardening ready；
- Gold/GA。

## 3. 设计选择

### 3.1 采用 B：exact allowlist 与 DNS pin 同批

不采用只做 allowlist 的 A：hostname 仍可能解析到特殊地址，不能形成完整 SSRF 基座。

不采用 SPKI/mTLS 的 C：证书轮换、密钥生命周期与真实 endpoint acceptance 超出本批。

### 3.2 GLM 抗辩后的修订

采纳：

- missing/null/empty policy 必须 deny-all；
- policy authorize 必须在 claim 之前且同步、纯函数；
- `agent:false`，每次 attempt 不复用连接；
- 显式 `autoSelectFamily:true`，custom lookup 必须取得并校验全部地址；
- 任一 DNS answer 非 public → 整次 attempt fail closed，不使用其余 public subset；
- total deadline 覆盖 request 构造、DNS、connect、TLS、request 与 response；
- DNS 独立 4 秒子截止，为 connect/TLS/response 留出预算；
- IPv4/IPv6 使用保守 closed-set；
- 只向 Node 返回全部已验证 public 地址，由 Node family auto-selection 做连接 fallback；
- TLS hostname/SNI 保持原 allowlisted hostname，IP 只在 custom lookup 返回值中出现。

不采纳：

- 新增 public error 三态：当前安全语义由 durable claim 是否 release 决定；本批继续只暴露固定 `audit-delivery-unavailable`，避免新错误面与信息泄漏。
- 强制 response closed JSON schema：transport 不解析也不保留 response body；常见 webhook 的 2xx body 不应成为协议耦合。本批维持 status-only accepted/rejected 与 4096-byte streaming bound。
- idempotency key 绑定 endpoint：现有 key 标识同一 stream occurrence；跨 endpoint 的服务端幂等域彼此独立，改变 key 反而可能破坏同一 occurrence 的稳定性。
- SPKI/mTLS：保留为后续可选 hardening。
- 使用 `AbortSignal.timeout` 替换现有计时器：现有 total timer 在 `https.request` 前启动并在到期时 destroy request；新增 lookup 子计时器即可覆盖 DNS hang，并保持现有可注入 fake-timer TDD。

## 4. 模块与接口

### 4.1 `src/audit-integrity-alert-destination-policy.js`

导出：

```js
createAuditIntegrityAlertDestinationPolicy(rawPolicy)
```

返回 deep-frozen capability：

```js
{
  schemaVersion: 1,
  status: 'deny-all' | 'configured',
  endpointCount: number,
  authorize(endpoint): string
}
```

契约：

- `undefined`、`null` → deny-all capability；
- exact valid `{schemaVersion:1,endpoints:[]}` → deny-all；
- 1..16 个合法 endpoint → configured；
- malformed/hostile policy → 固定 `audit-delivery-unavailable`；
- `authorize` exact string membership；成功只返回内部 canonical endpoint primitive，失败抛固定错误；
- capability 不保存 caller array/object 引用；
- policy 与 authorize 均不读 env/IO/network/DNS/timer/credentials；
- 不导出 allowlist 内容，也不在 receipt/error 中回显 endpoint。

raw policy exact key order：

```text
schemaVersion
endpoints
```

拒绝：

- extra/missing/reordered/symbol/non-enumerable/accessor keys；
- Proxy、class instance、Array subclass、URL/String wrapper、Buffer、Uint8Array；
- duplicate endpoint；
- 超过 16 项；
- 非字符串项。

### 4.2 endpoint canonical contract

每个 allowlisted endpoint 必须：

- 1..2048 UTF-8 bytes；
- exact `https:`；
- 无 username/password/query/fragment；
- 无显式 port；仅默认 443；
- input 必须与 `new URL(input).href` bit-identical；
- hostname 必须 lowercase ASCII DNS，2..253 chars，至少两个 labels；
- label 1..63 chars，只允许 `[a-z0-9-]`，不得 `-` 开头/结尾；
- 最后 label 为 2..63 个 ASCII 字母；
- 拒绝 wildcard、IP literal、trailing dot、underscore、non-ASCII、`xn--` label；
- 拒绝 reserved/private suffix：`.localhost`、`.local`、`.internal`、`.corp`、`.home`、`.lan`、`.test`、`.example`、`.invalid`；
- pathname 1..1024 chars，以 `/` 开头；
- pathname 只允许 `[A-Za-z0-9._~!$&'()*+,;=:@/-]`；
- 拒绝 `%`、backslash、`//`、`/./`、`/../`、尾部 `/.` 或 `/..`。

这是刻意保守的 production destination subset，不是通用 URL parser。

### 4.3 `src/audit-integrity-alert-delivery-authorized-once.js`

导出：

```js
createAuthorizedAuditIntegrityAlertDeliveryOnce(policy)
createAuthorizedAuditIntegrityAlertDeliveryOnceForTesting(deps)
```

生产 factory：

- 编译 policy；
- 绑定现有 `deliverAuditIntegrityAlertOnce`；
- 返回 `(dataDir, endpoint, now) => Promise<receipt>`；
- 调用顺序严格为 `authorize(endpoint) → deliverOnce(dataDir, authorizedEndpoint, now)`。

test factory exact deps：

```text
authorizeDestination
deliverOnce
```

deny 或 authorize throw：

- 不调用 `deliverOnce`；
- 因而零 claim、零 DNS、零 request、零 complete/release；
- 只抛固定错误。

该 factory 是可执行 policy gate，但本批不把它挂到 Agent/API/Web/scheduler。低层 `deliverAuditIntegrityAlertOnce` 仍是 trusted internal primitive；未来外部装配必须只暴露 authorized factory。

## 5. Public-DNS lookup pin

### 5.1 transport dependency

`audit-integrity-alert-https-transport.js` 的 test deps 扩为 exact order：

```text
request
lookupAll
setTimer
clearTimer
```

production `lookupAll` 仅包装：

```js
dns.lookup(hostname, { all: true, verbatim: true }, callback)
```

禁止 `dns.resolve*`、proxy、env、custom CA、credentials。

### 5.2 custom lookup behavior

每次 request options 必须包括：

```js
{
  agent: false,
  autoSelectFamily: true,
  autoSelectFamilyAttemptTimeout: 250,
  lookup,
  rejectUnauthorized: true,
  checkServerIdentity: tls.checkServerIdentity,
  ca: tls.rootCertificates,
  minVersion: 'TLSv1.2'
}
```

lookup：

1. 只接受原 descriptor URL 的 hostname；
2. Node 传入的 options 必须有 `all:true`；
3. 启动 4000ms DNS sub-deadline；
4. 调用 `lookupAll` 一次；
5. exact 校验 1..16 个 `{address,family}`；
6. 所有地址均通过 public predicate 才 callback；
7. callback 返回全部 validated 地址；
8. error、timeout、empty、malformed、duplicate、mixed public/special 均 callback fixed internal error；
9. callback 单次 settle；late DNS callback 无效；
10. public error 不含 hostname、IP、resolver error、path、body、headers。

显式 `autoSelectFamily:true` 的原因：Node 18.18+/20+/24 会以 `all:true` 调用 custom lookup，并依次尝试返回的 IPv6/IPv4 地址；不能依赖可被 CLI 改写的全局默认值。

### 5.3 deadline

- total `10_000ms` timer 在 request construction 前启动；
- DNS `4_000ms` 子计时器在 custom lookup 内启动；
- DNS settle 后清除子计时器；
- total timeout destroy request/response 并 fixed reject；
- DNS timeout 通过 lookup callback error 令 request fixed reject；
- underlying OS resolver 若迟到，其 callback 被 single-settle guard 丢弃；
- 不缓存 DNS；每次 attempt 重新解析、重新验证。

## 6. Public address predicate

### 6.1 输入 contract

- family 只能是整数 4 或 6；
- address 必须是 primitive string；
- `net.isIP(address)` 必须与 family 一致；
- zone/scope id、CIDR、hostname、whitespace、leading-zero IPv4、IPv4-mapped IPv6 均拒绝；
- 不做模糊 normalization。

### 6.2 IPv4 conservative deny table

以下前缀全部拒绝：

```text
0.0.0.0/8
10.0.0.0/8
100.64.0.0/10
127.0.0.0/8
169.254.0.0/16
172.16.0.0/12
192.0.0.0/24
192.0.2.0/24
192.31.196.0/24
192.52.193.0/24
192.88.99.0/24
192.168.0.0/16
192.175.48.0/24
198.18.0.0/15
198.51.100.0/24
203.0.113.0/24
224.0.0.0/4
240.0.0.0/4
```

这是 IANA IPv4 special-purpose/multicast/reserved 的保守 superset；即便某个 more-specific special block 标为 globally reachable，也不用于 alert webhook。

### 6.3 IPv6 conservative allow rule

仅接受 `2000::/3`，再拒绝：

```text
2001::/23
2001:db8::/32
2002::/16
3fff::/20
```

因此自动拒绝：

- unspecified/loopback/IPv4-mapped；
- NAT64 `64:ff9b::/96` 与 `64:ff9b:1::/48`；
- discard/dummy；
- Teredo/IETF protocol space；
- 6to4；
- documentation；
- ULA/link-local/site-local/multicast；
- 非当前 global-unicast allocation。

该规则比 IANA 的逐项 globally-reachable 标志更保守，避免 translation/tunnel 前缀将特殊 IPv4 引入连接路径。

### 6.4 registry snapshot

实现与测试基于 2025-10-09 IANA IPv4/IPv6 Special-Purpose Address Registry 快照，并明确把 registry drift 留作后续维护任务；本批不在线拉取 registry。

## 7. Request/body contract

维持现有：

- POST；
- `content-type: application/json`；
- stable idempotency key；
- no redirect；
- UTF-8 content-length；
- response streamed bytes ≤4096；
- bounded final 2xx accepted；
- bounded final non-2xx rejected。

新增 request body bound：

- body UTF-8 bytes 必须 ≤8192；
- 在 timer/DNS/request 前拒绝 oversize；
- 不解析或记录 payload。

不要求 response content-type/schema，不保留 response bytes。

## 8. Claim 与 outcome 时序

```text
policy deny
  -> no claim / no DNS / no request
policy allow
  -> claim
     -> empty/busy: no DNS / no request
     -> claimed
        -> DNS/private/malformed/timeout/TLS/request/response uncertain
           -> preserve claim; no complete/release
        -> bounded non-2xx rejected
           -> release; fixed error
        -> bounded 2xx accepted
           -> complete; delivered receipt
        -> accepted then complete failure
           -> preserve claim; never release
```

## 9. TDD 验收矩阵

### Task 1：destination policy

- valid empty deny-all；
- valid 1/16 endpoint configured；
- 17、duplicate、malformed、hostile 全拒；
- exact hostname/port/path/query/fragment/credential matrix；
- reserved/private suffix、IP literal、punycode/non-ASCII matrix；
- caller mutation 后 capability 不变；
- authorize exact membership；
- errors/results 不泄漏 endpoint/policy；
- source scan：no env/fs/net/dns/http/https/timer/credentials。

### Task 2：authorized one-shot gate

- missing/null/empty policy deny-all；
- deny/invalid endpoint：零 deliverOnce；
- configured exact endpoint：只把 authorized primitive 传给 deliverOnce；
- hostile deps/policy/endpoint；
- default production factory identity 与 static binding；
- related integration：deny 时零 real claim state；allow 时复用 real one-shot + fake transport。

### Task 3：public address classifier + pinned lookup

- IPv4 每个 deny prefix 的边界前/首/末/后；
- IPv6 allow `2000::/3` 与四个 deny prefix 的边界；
- v4-mapped、zone id、CIDR、hostname、family mismatch；
- DNS empty/error/hang/malformed/duplicate/mixed；
- all-public IPv4、IPv6、dual-stack；
- lookup called once per attempt；
- options `all:true`；
- callback returns all validated addresses；
- no real DNS/network；
- total 10s 与 DNS 4s fake-timer tests；
- `agent:false`、`autoSelectFamily:true`、250ms attempt timeout；
- original URL hostname retained for TLS/SNI；
- no second resolver surface；
- request 8192/8193 bytes；
- existing status/response/deadline matrix regression。

### Task 4：integration 与文档诚实性

- authorize → claim → lookup → request → complete/release order；
- deny zero claim；
- mixed/private DNS preserves claim；
- bounded non-2xx releases；
- 2xx completes；
- README/Gold evidence records exact allowlist + DNS pin；
- direct negatives continue for external config wiring, retry, dead-letter, scheduler, real remote delivery, production monitoring, e2e production, production-hardening ready 与 Gold；
- status remains partial，summary remains 6/3/0/9；
- focused suite + full `npm test`；
- independent closure review。

## 10. 文件边界

预期新增：

- `src/audit-integrity-alert-destination-policy.js`
- `test/audit-integrity-alert-destination-policy.test.js`
- `src/audit-integrity-alert-delivery-authorized-once.js`
- `test/audit-integrity-alert-delivery-authorized-once.test.js`
- `src/audit-integrity-alert-public-address.js`
- `test/audit-integrity-alert-public-address.test.js`

预期修改：

- `src/audit-integrity-alert-https-transport.js`
- `test/audit-integrity-alert-https-transport.test.js`
- `README.md`
- `src/gold-readiness.js`
- `test/readme.test.js`
- `test/gold-readiness.test.js`

禁止顺带修改：

- Agent/API/Web/scheduler wiring；
- retry/dead-letter state；
- credentials/env；
- LaunchAgent；
- package dependencies；
- `package-lock.json`。

## 11. 回滚与恢复锚点

- 每个 Task 独立 commit；
- Task 1/2 是新模块，可原子 revert；
- Task 3 只扩展 transport deps/options，现有 tests 必须 bit-contract 回归；
- 任一 RED 无效、reviewer schema 缺失、429/timeout/no artifact → HOLD，仅替换失败角色；
- 不做真实 endpoint probe；
- 不部署、不安装、不启动 LaunchAgent；
- Gold 仍是必要不充分增量。

## 12. 官方依据

- Node.js v24 `net.Socket.connect`：显式 `autoSelectFamily:true` 时 custom lookup 收到 `all:true`，Node 尝试返回的 IPv6/IPv4 地址。
- Node.js `http.request`：`lookup` 为 custom resolver；`agent:false` 使用一次性默认 Agent。
- IANA IPv4 Special-Purpose Address Space，snapshot 2025-10-09。
- IANA IPv6 Special-Purpose Address Space，snapshot 2025-10-09。

本机 Node v24.14.0 只读 probe 已验证：`https.request(..., {agent:false, autoSelectFamily:true, lookup})` 对 `example.com` 调用 custom lookup 时 options 为 `{hints:1024, all:true}`；probe 在 lookup 内固定报错，未建立网络连接。
