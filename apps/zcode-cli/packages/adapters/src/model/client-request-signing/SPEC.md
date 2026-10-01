# Client Request Signing V4 — 模型请求客户端签名 / PoW 规格

> 移植自官方闭源 ZCode（Agent 运行时 `zcode.cjs`，内部代号 Client Request Signing V4）。
> 本文件是行为规格与验收依据；实现位于同目录，仅被 `model-execution.ts` 引用。

## 1. 机制与目标

对发往 Z.ai / BigModel 网关的模型请求注入客户端签名（Ed25519）与工作量证明（PoW），
供服务端把请求识别为可信 ZCode 客户端（对抗 WAF 安全验证误拦）。整体 fail-open：
任何握手 / 网关故障都降级为无签名裸发，只有本地配置错误才 fail-closed。

时序（每请求）：

```
请求发起 (provider fetch)
  → origin ≠ businessOrigin ?          → 裸发 ("origin_mismatch")
  → bypassSigning ?                    → 裸发 ("bypass")
  → Feature Gate GET /api/v1/agent/configs
      关闭 / 请求失败                  → 裸发 ("feature_gate_disabled")
      gate 内部异常                    → 裸发 ("feature_gate_unavailable")
  → ensurePrivateKey（apiKey×origin 缓存；并发合并 handshakePromise）
      握手失败（fail-open）            → 裸发 ("handshake_failed")
      invalid-config 等（fail-closed） → 抛 ClientRequestSigningV4Error
  → sendSigned：PoW(8bit) + Ed25519 签名 + 注入 7 头
  → 401 且 reason ∈ {VERIFY_SIGNATURE_INVALID, VERIFY_APIKEY_EXPIRED} ?
      否 → 返回响应
      是 → invalidate → 重新握手 → sendSigned(attempt=2)
           仍 401 → bypassSigning = true（本 Signer 代际永久）→ 裸发 ("verify_refresh_exhausted")
```

## 2. 常量（必须与网关逐字节一致，任何偏差＝静默 401→bypass）

| 常量                       | 值                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 握手路径                   | `/api/paas/c1f3a7e2/v2/client`（挂在业务 baseURL origin 上）                                                         |
| 握手 action                | `get_sign_key`（HMAC 消息首行）                                                                                      |
| Gate 路径                  | `/api/v1/agent/configs`（挂在 ZCode 平台 origin 上）                                                                 |
| Gate 缓存 TTL / 超时       | 3600000 ms / 15000 ms                                                                                                |
| 握手超时                   | 10000 ms                                                                                                             |
| nonce                      | 16 字节随机 → 32 hex                                                                                                 |
| PoW 难度 / 前缀 / 计数上限 | 8 bit / 12 字节随机（24 hex）/ 4294967295（8 hex 位）                                                                |
| App-Id                     | `zcode`（`X-App-Id` 头 + PoW 输入）                                                                                  |
| HKDF salt                  | UTF8(`WD_CLIENT_SIGN_KDF_SALT`)，HKDF-SHA-256，输出 32B                                                              |
| HKDF info（HMAC key）      | `getSignKey_hmac`                                                                                                    |
| HKDF info（AES key）       | `ed25519_priv`                                                                                                       |
| 业务签名消息               | `"{apiKeyId}\n{ts}\n{clientVersion}\n{sessionId}\n{nonce}"`                                                          |
| 握手签名消息               | `"get_sign_key\n{apiKeyId}\n{ts}\n{nonce}"`                                                                          |
| PoW seed 输入              | `"{apiKeyId}\n{appId}\n{sessionId}\n{ts}"`；seed=SHA-256 摘要前 16 字节 hex（32 字符）                               |
| PoW candidate              | `prefix(24 hex) + counter.toString(16).padStart(8,"0")`；解 = SHA-256(`"{seed}\n{candidate}"`) 前 8 bit 全零         |
| 401 刷新 reason            | `VERIFY_SIGNATURE_INVALID` / `VERIFY_APIKEY_EXPIRED`（读 msg / reason / data.reason / error.reason / error.message） |
| 发送前剥离头               | `X-Client-Ts, X-Client-Version, X-Client-Sig, X-Client-Nonce, X-Client-Pow, X-App-Id, X-Client-Sign-Verified`        |

注入头（7 个）：`X-Client-Ts`（毫秒）、`X-Client-Version`、`X-Client-Sig`（base64 Ed25519）、
`X-Client-Nonce`（32 hex）、`X-App-Id: zcode`、`X-Client-Pow`（32 hex）、`X-Session-Id`（原样重设）。
`X-Client-Version` 取请求 headers 的 `X-ZCode-App-Version`（大小写不敏感），缺省取进程版本，再缺省 `0.0.0-dev`。

凭证：`apiKey = "{apiKeyId}.{apiKeySecret}"`，恰好一个 `.`、两侧 trim 非空，否则 invalid-config（fail-closed）。
Ed25519 PKCS#8 私钥由服务端下发 `privateCipher = base64(iv[12] ‖ AES-256-GCM(HKDF(secret,"ed25519_priv"), pkcs8Text, aad=UTF8(apiKeyId)))`；
客户端解密后仅驻留内存，不落盘。

## 3. 生效判定（requiresClientRequestSigning）

```
access.type === "zhipu-account" && mode ∈ {start-plan, off-peak} → false
access.type === "zhipu-coding-plan-api-key"                      → true
access.type === "zhipu-account" && mode ∈ {individual-coding-plan, team-coding-plan} → true
baseURL hostname 命中 z.ai / bigmodel.cn 路由域                   → true
否则 hostname ∈ {api.chatglm.site, zcode.chatglm.site}            → true/false
```

即 Coding Plan API Key 与个人/团队 Coding Plan 账号强制装配；Start Plan / off-peak 不装配；
自建 provider 仅域名白名单命中时装配。

## 4. Feature Gate（GET /api/v1/agent/configs）

- headers = 来源头（与模型请求同款 buildCliZCodeSourceHeaders）+ `x-api-key: apiKey`；`redirect:"manual"`，超时 15s。
- 响应 `{code:0, data:{codingPlanSignature:{enable}}}`：
  `code≠0` → 不缓存、enabled=false（failure=business_code）；无 `codingPlanSignature` 键 → 缓存、enabled=false；
  `enable===true` → 缓存、enabled=true。HTTP 非 ok / 超时 / 网络 / JSON 非法 → 不缓存、enabled=false。
- **gate 失败＝裸发**，绝不 fail-closed。缓存 TTL 1h，并发合并为一个请求。
- Gate 实例按 `apiKey × scopeKey` 去重（scopeKey = configUrl + 排序后 headers + network 配置），
  由 App 级 `AiSdkClientRequestSigningState` 持有；gate 的 transport 复用 provider proxy fetch。

## 5. 状态所有者

- `AiSdkClientRequestSigningState`（App 装配期创建一份，bootstrap 传入）：持有 keyCache 与 gate 实例表。
- `ClientRequestSigningV4KeyCache`：`Map<apiKey, Map<origin, keyState>>`；keyState `{epoch, privateKey?, handshakePromise?}`。
  invalidate/dispose 时 `epoch++`，握手中检测 epoch 变化即放弃结果。
- `ClientRequestSigningV4Manager`：按 providerId 缓存 Signer；`apiKey/baseURL/clientVersion/transport`
  任一变化即 dispose 重建；`activeRequestCount` 引用计数延迟 dispose。
- `ClientRequestSigningV4Signer.bypassSigning`：Signer 代际内一次性熔断（两轮 401 验签拒绝后永久裸发）。

## 6. 降级语义（fail-open 优先）

| 场景                                                                                                       | 行为                                          |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| gate 关闭 / gate 请求失败                                                                                  | 裸发                                          |
| origin 不匹配 / 已 bypass                                                                                  | 裸发                                          |
| 握手失败（超时/网络/协议/服务端/业务码/解密）                                                              | 裸发                                          |
| 401 验签拒绝 × 2                                                                                           | bypass + 裸发                                 |
| invalid-config（非 HTTPS baseURL / apiKey 无分隔符 / 缺 X-Session-Id）、PoW 与业务签名密码学错误、disposed | 抛 ClientRequestSigningV4Error（fail-closed） |

服务端未开启灰度（`codingPlanSignature.enable !== true`）时全链路等价于移植前行为：
gate 每小时一次 GET（带 15s 超时、失败即裸发），业务请求零改动。

## 7. 遥测

observation（signed_sent / unsigned_sent / handshake_failed / verify_rejected / bypass_entered /
request_failed_closed）→ ① logger（debug/info/warn）② 可选 observeClientSigning 回调 →
model_attempt span：`zcode.model_attempt.client_signing = signed|unsigned|failed`、
`..._unsigned_reason`、`..._error_kind`，事件 `client_signing_handshake_failed`、
`client_signing_verify_rejected`、`client_signing_bypass_entered`。按 x-request-id 关联（FIFO 64）。

## 8. 验收场景

1. 纯函数：HKDF 派生、HMAC 握手签名串、PoW 求解/验证、头剥离/注入、凭证解析（恰好一个点）——单测覆盖。
2. gate 关闭：请求原样发送（无签名头），与移植前字节等价。
3. 握手成功：注入 7 头，PoW 满足 8 前导零 bit。
4. 401 VERIFY\_\*：重握手重试一次；再失败进入 bypass 后续裸发。
5. 握手 HTTP/网络失败：裸发，不抛错。
6. apiKey 无分隔符且 gate 开启：抛 ClientRequestSigningV4Error。

单测运行（node:test + tsx，与仓库 packages/services/test 同构；覆盖上述 1-6 全部场景）：

```bash
cd apps/zcode-cli/packages/adapters && \
  ../../node_modules/.bin/tsx --test test/client-request-signing.test.ts
```
