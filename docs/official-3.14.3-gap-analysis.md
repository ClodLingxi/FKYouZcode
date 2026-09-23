# 官方 3.14.3 差距分析（开源版 3.14.1 → 官方 3.14.3）

> 生成于 2026-09-23。方法：提取官方 `/opt/ZCode/resources/app.asar`（3.14.3），
> 与本仓库 3.14.1 源码/构建产物做 bundle 字符串集合与资源清单对比。
>
> **详细移植蓝图（subagent 深度逆向产出）**：
> - [bot 平台（Telegram/微信/飞书/Webhook）](./official-3.14.3-bot-platform-port-blueprint.md)
>   —— 零服务端依赖，四层架构（Repo/Provider/RuntimeLock/Service），最小闭环 3-5 人日
> - [其余全部差距 A/B/C/D 分级清单](./official-3.14.3-remaining-gaps-blueprint.md)
>   —— A 组纯客户端 7 项（Output Style 服务、CDN 双源 fallback 已实现、Marketing Touch 等）、
>   B 组依赖官方服务端 3 项（Web Remote Control/AcknowledgedRelay 等）、
>   C 组 macOS-only（CUA 真实现，不建议移植）、D 组误报/已有 12 项（plan approval 其实已有）

## 结论摘要

- 线上开源仓库（origin/main）无新提交，本次走"分析官方安装版 → 源码同步"路径。
- **renderer 几乎无变化**：归一化（去内容哈希）后资源清单仅新增
  `icon-dingding/discord/telegram/wecom/weixin@2x.png` 与 `lottie_light_canvas`，
  其余数千个资源一一对应。UI 层不需要追。
- 差距集中在 **host（agent runtime）与 main 进程**：
  - host：官方 2.71MB vs 本地 2.32MB（压缩后差 ~400KB），新增 ~1758 个字符串标识。
  - main：新增 ~736 个；preload+scheduler：新增 ~253 个。

## 已同步（本次提交）

1. **手动领取 Coding Plan（preview + claim）** — 还原自官方 host 压缩代码：
   - `GET /api/v1/zcode-plan/billing/preview?app_version&platform`（Bearer JWT 可选）
   - `POST /api/v1/zcode-plan/billing/claim`（Bearer JWT 必需；
     `X-Aliyun-Captcha-Verify-Param` / 可选 `-Region` / `X-ZCode-App-Version` / `X-Platform` 头；
     body `{plan_id}`；响应 code 接受 number/string 双态；`server_time` 秒→毫秒；
     成功判据 `server_time===0` 且 `data.plan` 存在；失败可带 `plan.ends_at` → `failureEndsAt`）
   - 落点：shared 类型（`CodingPlanManualClaim*`）→
     `BigModelCodingPlanSubscriptionProvider.getManualClaimPlanPreviews/claimManualPlan` →
     `ICodingPlanSubscriptionService` 接口与委托。
2. **版本号** 3.14.1 → 3.14.3。
3. **Workflow 运行增量流协议（3.14.3 新增，完整同步）**：
   - 新增 conversation delta ops：`workflowRun.updated`（runId/revision + run partial patch +
     cleared/removedActors/removedNodes/actors/nodes identity diff）与 `workflowRun.removed`；
   - 能力协商：clientHello `capabilities.workflowRunDeltas`（`clientSupportsWorkflowRunDeltas`）、
     host→CLI hello 能力位、订阅参数 `workflowRunDeltas` 全链路透传
     （连接 scope 握手写事实、trusted connection 防伪造、CLI gateway → publisher）；
   - publisher 按订阅编码：增量订阅收 per-run ops；旧订阅在 ingest/resume/snapshot
     三处边界折叠回 `state.updated`（`encodeConversationDeltasForLegacy`）并裁剪
     snapshot workflowRuns（`trimWorkflowRunsForLegacyWire`，活动条目优先保序）；
   - shared 新模块 `workflow-runs-delta.ts`：diff/apply/降级三面同居（round-trip 已验证）。

## 未同步差距（按规模排序，后续迭代方向）

1. **Bot 平台（host，规模最大，~280 标识）**：Telegram（long-polling 锁
   `acquireTelegramPollingLock`）、微信（`acquireWeixinPollingLock`）、飞书
   （WebSocket 锁 + typing reaction）、企业微信、Discord、钉钉 的 bot 运行时
   （`acquireBotRuntimeLock`、"An enabled bot with this provider user already exists." 等）。
   renderer 的新增社交图标即为此 UI 预留。需逆向 host bundle 中 bot runtime 状态机、
   渠道适配器与凭据存储，工程量大。
2. **Relay 协议（host/main）**：`AcknowledgedRelayBatchQueue/Deadline/Protocol` 等中继批处理语义
   （workflow 相关的 relay/delta 部分已于本次同步，剩余为非 workflow 的会话中继）。
3. **CUA helper 安装校验（main，偏 macOS）**：
   `captureCuaHelperBundleAttestation` / `assertCuaHelperBundleAttestationUnchanged` /
   `assertSafeHelperDownloadUrl` / quarantine 清理等 helper bundle 完整性链路；Linux 影响有限。
4. **Marketing touch / 营销素材体系（host）**：
   `/api/v1/marketing/touch(+action)` 上报、营销素材 sha256 allowlist 注册表
   （图片/视频/bundle 下载，类型嗅探 + 48MB LRU）。
5. **Plan approval（main/UI 字符串）**：`planApprovalTitle/Header/Approve...` 审批流文案与逻辑。
6. 其余零散：`/api/rpc-host-capability`、`/api/server-info`、`getOffPeakClientConfig` 扩展、
   agent 权限语义细化（"Always reject the same command/file operation" 等）。

## 方法备忘

复现对比：

```bash
npx @electron/asar extract /opt/ZCode/resources/app.asar /tmp/official
# 字符串集合 diff（main/host/preload/scheduler 分区）：
grep -oE '"[A-Za-z0-9 ./_@:#,-]{8,80}"' out/**/*.js | sort -u | comm -13 local.txt - 
# renderer 资源名归一化：sed -E 's/-[A-Za-z0-9_-]{8}\.(js|css)$//'
```
