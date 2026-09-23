# ZCode 官方 3.14.3 Bot 平台逆向分析与开源版移植蓝图

> 分析对象：官方 ZCode 3.14.3（`/tmp/official-3.14.3/src/out/`，压缩 JS）
> 目标：将 Telegram / 微信(iLink) / 飞书·Lark / Webhook 机器人平台移植进开源版
> 开源版仓库：`/home/lingxi/.zcode/workspace/default/ZCode`（本文所有落点路径均相对该仓库根）
> 佐证材料（可复跑）：`/tmp/bot-analysis/`（host bundle 美化版 `host-full.pretty.js`、bot 主区段 `bot-main.js`、协议 chunk `chunk-NK.pretty.js`、schema chunk `chunk-B7.pretty.js`）

---

## 1. 代码分布结论（逆向定位）

| 官方文件 | 内容 | 说明 |
|---|---|---|
| `out/host/index.js`（1.5MB，美化后 75691 行） | **Bot 平台全部运行时**：行 32557–41881 连续区段（Feishu 注册、provider、channel runtime、BotsService）+ 66938 附近 `createBotRemoteWorkspaceService` + 70289 `watchCronRunBotDelivery` | 全部代码集中在 host 进程 |
| `out/host/chunk-B7L5SK4K.js`（美化 33985 行） | bot-config / bot-state 的 zod schema（24045–24150 行附近）：provider 枚举、bot 配置、运行态、elicitation 结构 | 与 UI 共享的类型层 |
| `out/host/chunk-NKOHJ4QI.js` | SQLite automations 表新增列 `bot_delivery_target TEXT`（含 migration 列表 `["automations","bot_delivery_target","TEXT"]`）与 `getBotDeliveryTarget()` | cron 集成的存储面 |
| `out/renderer/assets/styles-DEELZGp2.js`（6MB 主 UI chunk） | `BotsDialog`（机器人管理对话框）、WebRemoteControl 面板的 "使用 Bot Channel" 区块 | UI 入口 |
| `out/renderer/assets/IntlProvider-BMWo3Clv.js` | `bots.*`、`bots.runtime.*`、`bots.replyGranularity.*`、`webRemoteControl.botChannel.*` 中英 i18n（约 120 条） | UI 信息结构 |
| `out/renderer/assets/icon-{telegram,weixin,wecom,discord,dingding}@2x-*.png`、`feishu-*.png` | 渠道图标 | 钉钉/企微/Discord 仅有图标 |
| `out/main`、`out/scheduler`、CLI 运行时 `zcode.cjs` | **无 bot 运行时代码**。zcode.cjs 仅含 `botDeliveryTarget` 作为 sendText/automation 协议字段的透传 schema（`{provider: enum(feishu|lark|weixin), botId, providerUserId, chatType}`） | bot 平台是桌面 host 独有子系统 |
| `package.json` | 新增运行时依赖 `@larksuiteoapi/node-sdk@1.61.1`（Feishu WSClient） | 唯一新增第三方依赖 |

关键事实：**Discord、企业微信在 provider 枚举里存在但实现为 `null`**（`testBot` 返回 "…is reserved for a future version."）；钉钉连枚举都没有、仅有图标。官方 3.14.3 实际交付的渠道是 **Telegram、微信(iLink)、飞书/Lark、Webhook** 四个。

---

## 2. 架构（文字图）

```
┌────────────────────────── Electron Renderer ──────────────────────────┐
│  BotsDialog（设置/机器人管理）      WebRemoteControl 面板（移动端入口）   │
│  通过 ServiceChannels.Bots = "bots" 频道的 typed RPC client 调用        │
└───────────────▲───────────────────────────────────────────────────────┘
                │ JSON-RPC（service channel 代理）
┌───────────────┴────────────────── Electron Host 进程 ─────────────────┐
│                        BotsService（单例，内存编排层）                  │
│  ┌────────────┐ ┌──────────────────────┐ ┌──────────────────────────┐ │
│  │ BotsRepo   │ │ ChannelRuntime×N/bot │ │ Inbound 消息管线          │ │
│  │ bot-config │ │ reconcile(config变化) │ │ parseBotCommand →        │ │
│  │ .v3.json   │ │ acquireRuntimeLock   │ │ withAuthorizedContext →  │ │
│  │ bot-state  │ │ 启停 polling/WS      │ │ handle{Bind,Help,Status, │ │
│  │ .v3.json   │ │ statusSink 运行状态  │ │ New,Model,Mode,...,      │ │
│  └────────────┘ └──────────────────────┘ │ Message}                 │ │
│  ┌─────────────────────── Provider 适配层（4 个实现）───────────────┐  │ │
│  │ telegramBotProvider │ weixinBotProvider │ feishuBotProvider     │  │ │
│  │ webhookBotProvider  │ (discord/wecom = null 预留)               │  │ │
│  │ 统一接口: test/resolveName/syncCommands/send/sendTyping/         │  │ │
│  │          acknowledgeCallback/downloadAttachment/parseCallback    │  │ │
│  └──────────────────────────────────────────────────────────────────┘  │ │
│                              会话桥接                                   │ │
│   draft 态: createTask(v4Create) ─→ task 态: resumeTask                │ │
│   sendPrompt({taskId, traceId:bot-{nonce}, content, attachments,       │ │
│               botDeliveryTarget, modelSelection})                      │ │
│   onDynamicTaskEvent({workspacePath,taskId,deliveryKind:               │ │
│        "bot-channel-continuous"}) ─→ 按 replyMode 投影回复块 ─→ send   │ │
│   权限请求/elicitations → 内联按钮选择（zc: 回调 or 序号文本）           │ │
│   远程 workspace: BotRemoteWorkspaceService（向 main 请求 runtime port）│ │
└───────────────────────────────────────────────────────────────────────┘
        │ locks: {configDir}/bots-runtime-locks/{kind}/{sha256}.lock（目录原子 rename + lease 10s/超时30s）
        │ 凭据: credentialService：bot:{botId}:credential / bot:{botId}:webhook-secret
        ▼
外部渠道 API（全部是渠道官方端点，无 ZCode 服务端参与）：
  api.telegram.org（Bot API long-polling，offset 25s 长轮询）
  open.feishu.cn / open.larksuite.com（@larksuiteoapi/node-sdk WSClient 长连接 + REST im/v1）
  accounts.feishu.cn / accounts.larksuite.com（/oauth/v1/app/registration 设备码注册飞书应用）
  ilinkai.weixin.qq.com/ilink/bot（微信 iLink Bot API：QR 登录 + getupdates 90s 长轮询）
  用户自建 Webhook URL（POST JSON，x-zcode-bot-secret 头）
```

---

## 3. 数据模型（还原出的 zod schema）

### 3.1 `bot-config.v3.json`（app 配置目录，JSON 降级链 v1→v2→v3 自动迁移）

```ts
{
  version: 3,
  bots: [{
    id: string(min1), name: string,
    provider: z.enum(["telegram", "webhook", "feishu", "lark", "weixin", "discord", "wecom"]),
    enabled: boolean,
    credentialRef?: string,          // credentialService key: bot:{id}:credential
    webhookSecretRef?: string,       // credentialService key: bot:{id}:webhook-secret
    webhookUrl?: string(url), webhookAuthHeaderName?: string,  // 默认 x-zcode-bot-secret
    feishuAppId?: string, providerUserId?: string, displayName?: string,
    allowedWorkspaces: string[],     // "*" = 全部
    allowedCommands: {               // 命令白名单
      status: boolean; new: boolean; workspace: boolean; model: boolean;
      mode?: boolean; thoughtLevel: boolean; sandboxMode?: boolean;
      approvalPolicy?: boolean; cli?: boolean; reply: boolean;
    },
    currentOptions: {                // draft 默认项
      modelSelection?: {providerId, modelId, options?},
      mode?: string; sandboxMode?: string; approvalPolicy?: string;
      cli?: z.enum(["codex","claude","opencode","gemini","glm"]),
    },
    replyMode: z.enum(["assistant_changes","assistant_toolcalls_changes",
                       "summary_changes","streaming_card"]),
  }]
}
```
约束：`replyMode=streaming_card` 仅 feishu/lark 支持（`getSupportedBotReplyGranularities`）；`validateBotConfig` 强制"同一个启用的 bot 不能占用同一个 providerUserId"（错误串 "An enabled bot with this provider user already exists."）+ "Enabled polling bots cannot share the same credential"（同 token 不能两个轮询 bot）。

### 3.2 `bot-state.v3.json`（运行态，per bot）

```ts
{ version: 3,
  bots: Record<botId, {
    botId, workspacePath, workspaceIdentity?, workspaceId?,
    mode: "draft" | "task",
    activeTaskId: string | null,
    draftOptions?: { provider, modelSelection?, mode? },
    pendingPermissionOptions?: [{ requestId, optionId, command: "approve"|"deny",
                                  label, response, handledAt? }],
    pendingElicitation?: { taskId, requestId, runId, origin?, actorKey?,
                           currentQuestionIndex, questions, answers,
                           renderContext?: {kind:"plan_approval", plan}, ... },
    telegramOffset?: number,        // getUpdates 游标（断电续传）
    weixinGetUpdatesBuf?: string,   // iLink getupdates 游标
    weixinActivatedAt?: number,
    updatedAt: number }> }
```

### 3.3 `BotDeliveryTarget`（协议共享，CLI zcode.cjs 亦含此 schema 透传）

```ts
{ provider: z.enum(["feishu","lark","weixin"]),
  botId: string, providerUserId: string, chatType: z.enum(["private","group"]) }
```
存储在 SQLite `automations.bot_delivery_target TEXT`（JSON 序列化）。

---

## 4. 各渠道接入方式还原

### 4.1 Telegram（createTelegramBotProvider + createTelegramChannelRuntime）
- **接入**：Bot API 直连 long-polling。`getUpdates({offset, timeout:25})`，40s 周期；offset 持久化在 bot-state。
- **发消息**：`sendMessage`（parse_mode Markdown，失败降级纯文本；3900 字符分段）；inline keyboard 选项 `callback_data` 编码 `zc:permission:N` / `zc:e:{token}:N` / `zc:cmd:/model provider N` / `zc:cancel`（64 字节内）；`answerCallbackQuery` 应答 toast + `editMessageReplyMarkup` 清空按钮；typing 用 `sendChatAction{action:"typing"}`。
- **命令菜单**：`setMyCommands`/`deleteMyCommands` 随 enabled 切换同步。
- **附件**：`getFile` → `https://api.telegram.org/file/bot{token}/{path}`，30s 超时；photo 取最大分辨率。
- **绑定**：一个 bot 配置绑一个 `providerUserId`（/bind 码），`findAuthorizedBot` 按 provider+providerUserId 匹配。

### 4.2 微信 iLink（createWeixinBotProvider + createWeixinChannelRuntime）
- **接入**：微信 iLink Bot 开放平台 `https://ilinkai.weixin.qq.com/ilink/bot/*`。鉴权头 `AuthorizationType: ilink_bot_token` + `Authorization: Bearer {bot_token}` + 随机 `X-WECHAT-UIN`。
- **注册**：QR 登录流程：GET `/get_bot_qrcode?bot_type=3`（返回 qrcode + img，120s 有效）→ 轮询 GET `/get_qrcode_status?qrcode=…`（3s 间隔；状态 pending/scanned/success/expired）→ 成功返回 `bot_token` + `ilink_bot_id`。
- **收信**：POST `/getupdates {get_updates_buf}` 90s 长轮询，游标 `get_updates_buf` 持久化；消息体 `{msg:{item_list:[{type:1,text_item:{text}}|{image_item|file_item…}]}}`，兼容字段极宽（from_user_id/from/user/wxid…）。
- **发信**：POST `/sendmessage {msg:{from_user_id, to_user_id, client_id:uuid, message_type:2, message_state:2, context_token?, item_list:[{type:1,text_item:{text}}]}}`，换行统一 `\r\n`；回复要带 `context_token`（入站消息携带）。
- **typing**：`/getconfig {ilink_user_id, context_token}` 取 `typing_ticket` → `/sendtyping {typing_ticket, status:1}`。
- **附件**：下载 URL + 消息携带 `aes_key`，AES-128-ECB（`aes-128-ecb`，key 32hex 或 16B base64）解密 CDN 媒体。
- **特殊逻辑**：weixin 不做 /bind 预绑定——`findAuthorizedBot` 对 weixin 仅按 botId 匹配；首次任何用户发消息触发 `handleWeixinFirstActivation` 欢迎语；群聊按 room/chat 字段判定。`resolveAutomationBotDeliveryTarget` 对 weixin 用 chatId 或 userId。

### 4.3 飞书 / Lark（createFeishuBotProvider + createFeishuChannelRuntime）
- **接入**：`@larksuiteoapi/node-sdk` 的 `WSClient`（**WebSocket 长连接，无需公网 webhook**）。`EventDispatcher` 注册 `im.message.receive_v1`（收信）、`card.action.trigger`（卡片按钮回调，同步返回新卡）、`im.message.reaction.created_v1`（空实现）。Domain 按 provider 分 `Domain.Feishu`（open.feishu.cn）/`Domain.Lark`（open.larksuite.com）。
- **注册**：`https://accounts.feishu.cn/oauth/v1/app/registration` 设备码流程（action=init→begin→poll）：支持 client_secret 时创建飞书自建应用并直接返回 `client_id/client_secret`（返回 `verification_uri_complete` 供扫码）。Lark 账号在 poll 时可能切换 pollDomain 到 lark。
- **REST 发送**：`tenant_access_token`（app_id+app_secret，内存缓存 90min）；发送交互卡 POST `/open-apis/im/v1/messages?receive_id_type=chat_id|open_id`（msg_type interactive，Card JSON 2.0）；流式更新 PATCH `/open-apis/im/v1/messages/{message_id}`；撤回 DELETE 同路径；typing 是消息表情回应 add/delete `/reactions/{type}`（🫡式 typing 反应，`getFeishuTypingReactionKey` 记录 map）。
- **回复模式**：仅 feishu/lark 支持 `streaming_card`（流式卡片：create → 多次 patch → sealed 状态；工具调用渲染为折叠面板 `buildFeishuStreamingToolPanel`；卡片分片 3500 字符/1900 文本）；`card.action.trigger` 是同步回调——host 处理后直接返回 `{card:{type:"raw",data}}` 更新卡片。
- **锁粒度**：`{provider}-websocket` 锁按 feishuAppId 去重（同 app 只允许一个 host 连接）。
- **App ID 校验**：正则 `Jce`（`cu.xxxxx` 形态）。

### 4.4 Webhook（createWebhookBotProvider）
- **出站**：POST 用户配置的 `webhookUrl`，头 `[webhookAuthHeaderName || x-zcode-bot-secret]: {webhookSecret}`；body `{type:"zcode.bot.message"|"zcode.bot.elicitation_request", botId, provider, userId, text, selection?, elicitation?, sentAt}`。
- **入站**：`parseCallback({botId, text, userId, displayName?, chatType?, chatId?, messageId?, attachments?, elicitationResponse?})`，附件支持 providerFileId/downloadUrl/dataBase64/localPath 五种载体。
- testBot 仅在有 webhookUrl 时发 `zcode.bot.test` 探活。

### 4.5 Discord / WeCom / 钉钉
- 枚举/图标/i18n 已就位，实现为 `null`（"reserved for a future version"）。**移植时可直接跳过，不影响完整性。**

---

## 5. 会话桥接与消息流（核心数据流）

```
入站: transport(polling/WS/webhook POST)
  → provider.parseCallback(payload) → InboundMessage{botId, text, attachments?, actor{providerUserId, chatType, chatId, providerMessageId, providerContextToken?}}
  → 去重(buildInboundDeliveryKey + pruneRecentInboundDeliveryDedupe) → enqueueInboundProcessing（串行队列）
  → startTyping / addFeishuTypingReaction
  → parseBotCommand("/…" 分词 + 别名) ；非命令 → message
  → handleInboundMessage switch:
      bind      → 校验绑定码(内存 Map, 大写, TTL 默认 15min) → 写 bot.providerUserId → 回帮助
      help/status/new/workspace/model/mode/thought/reply/stop/reconnect/…
      approve/deny      → taskService.respondPermission(taskId, requestId, optionId, response)
      elicitation.*     → AskUserQuestion 答案写回（多问题逐步推进）
      message           → handleMessage:
          withAuthorizedContext: enabled? private chat? bound? 命令白名单? allowedWorkspaces?
          draft 态: modelSelectionService 解析有效模型 → zcodeTaskService.createTask({workspacePath, provider, modelSelection, v4Create:true})
                    → state.mode=task, activeTaskId
          task 态:  resumeTask → 校验会话模型可用
          → sendPromptInBackground: taskService.sendPrompt({taskId, traceId:`bot-${nonce}`,
             content, attachments, botDeliveryTarget, modelSelection})
          → watchTaskStream: onDynamicTaskEvent({workspacePath, taskId,
             deliveryKind:"bot-channel-continuous"}) 订阅
回流: stream 事件 → 提取 assistant 文本 / 工具调用进度 / 变更摘要(changeSummary)
  → 按 replyMode 投影 createAssistantReplyBlocks:
      assistant_changes            正文+变更
      assistant_toolcalls_changes  正文+工具行+变更
      summary_changes              仅最新正文+变更（cron 通知默认）
      streaming_card               飞书流式卡片（create/patch）
  → provider.send(outbound{providerUserId, text, selection?, elicitation?})
权限请求: task stream 的 permission 事件 → sortBotPermissionOptions(allowOnce/allowAlways/rejectOnce/rejectAlways/custom)
  → buildSelectionReplyMarkup(按钮) 或 buildSelectionText(序号) → state.pendingPermissionOptions 记账
elicitations: zcode.bot.elicitation_request 事件 → normalizeBotElicitationQuestions(多问题/多选/自定义答案/计划审批 plan_approval 特化)
  → 飞书渲染为表单卡片（buildFeishuElicitationForm，完成后 submit），其余渠道为按钮+序号
cron: automations.bot_delivery_target → host cron 派发处 watchCronRunBotDelivery({automationId, taskId,…})
  → botsService.watchAutomationRun: 重放状态上下文(mode:task) → watchTaskStream(summary_changes) → 完成后推送 run 摘要
远程: workspaceIdentity 非空时经 BotRemoteWorkspaceService：
  main 进程 MessagePort 请求 BotRemoteWorkspaceConnectionStatusRequest / ReconnectRequest / RuntimePortRequest
  → 拿到 MessagePort 后组装远端 zcodeTaskService/modelSelectionService（复用 offpeak 同款装配）；发送
  前置检查 requiresRemoteWorkspaceRuntime（model/workspace/reply 之外的命令才需要远端在线）
```

**绑定模型**：Telegram/Feishu/Webhook = 1 bot ↔ 1 providerUserId（/bind 码在 UI 生成：`createBindCode({botId, ttlMs, allowedWorkspaces})` → 渲染 `/bind <CODE>` 复制到剪贴板）。Weixin = 任意加 bot 好友的用户即用。

**命令面（聊天内）**：`/帮助 /绑定 /状态 /新建(或 /clear) /项目 /模型 /模式 /思考 /回复 /取消(0) /停止 /重连` + 权限按钮 approve/deny + elicitation 表单。en-US 对应 /help /bind /status /new /project /model /mode /think /reply /stop /reconnect。

---

## 6. 运行时锁与状态机

- **锁路径**：`{appConfigDir}/bots-runtime-locks/{telegram-polling|weixin-polling|feishu-websocket|lark-websocket}/{sha256(key)}.lock`；key = token（telegram/weixin）或 `feishuAppId`。
- **算法**：创建 `{lock}.{nonce}.pending/`（owner.json: {pid, botId, nonce, createdAt} + 空 lease 文件）→ `rename()` 到目标路径（原子）；冲突时读 owner：pid 存活且 lease(<30s) 未过期则放弃（返回 null → 状态 messageId `telegramLongPollingHandledElsewhere`），否则清理重试（最多 2 次）。持锁期间每 10s touch lease。
- **作用**：多开 ZCode 窗口 / host 重启竞态下，同一 token 只有一个轮询者；同一飞书 app 只有一个 WS 连接。
- **运行状态**（statusSink + UI 轮询 `getStatus()` 每 2s）：idle/polling/running/error（telegram）、polling…（weixin）、connecting/running/reconnecting/stopped（feishu）、disabled；error 带 messageId（i18n key）与 offset。

---

## 7. RPC 命令面（BotsService，channel "bots"）

官方通过 service-channel 代理（与开源 `createServiceDescriptor` 同机制，官方 `ServiceName.Bots = "bots"`）暴露。完整方法：

```ts
interface IBotsService {
  getStatus(): Promise<{botsCount, enabledBotsCount, contextsCount,
                        botRuntime: Array<{botId, provider, status, message?, messageId?, offset?}>}>;
  getConfig(): Promise<BotsConfig>;
  saveConfig(config): Promise<BotsConfig>;
  listBots(): Promise<BotConfig[]>;
  saveBot(params: {bot: BotConfig; credentialValue?: string; webhookSecretValue?: string}):
    Promise<BotConfig>;            // 写凭据进 credentialService；resolveName 拉取 bot 显示名（telegram getMe / feishu app，重试 0/800/1800ms）
  removeBotSecret(botId): Promise<BotConfig>;   // 清凭据+绑定，保留配置
  deleteBot(botId): Promise<void>;
  testBot(botId): Promise<{ok, message, name?, provider}>;
  createBindCode(params: {botId, ttlMs?, allowedWorkspaces?}): Promise<{code, expiresAt}>;
  getBotStates(): Promise<BotState[]>; resetBotState(botId): Promise<void>;
  listWorkspaceRefs(): Promise<WorkspaceRef[]>;
  getUserConfigOptions(...): /* 模型/模式选项（模型选择器复用） */;
  beginFeishuRegistration(domain?): Promise<{deviceCode, qrUrl, interval, expiresAt, domain, pollDomain}>;
  pollFeishuRegistration(s): Promise<{status:"pending"|"success"|"access_denied"|"expired"|"error", appId?, appSecret?, appName?, openId?, ...}>;
  beginWeixinRegistration(): Promise<{qrCode, qrUrl, interval:3, expiresAt}>;
  pollWeixinRegistration(s): Promise<{status, botToken?, botId?}>;
  watchAutomationRun(params: {target: BotDeliveryTarget, taskId, workspacePath, workspaceIdentity?}): Promise<void>;
  handleInboundMessage(m): Promise<OutboundReply[]>;
  handleProviderCallback / handleProviderCallbackResponse(飞书同步卡): Promise<{replies, elicitation?}>;
  disposeAll()/disposeAllAndWait();
}
```

renderer `BotsDialog` 轮询 `getStatus()`（2s）渲染每 bot 运行状态行。

---

## 8. 服务端依赖 vs 纯客户端边界（可移植性判定）

| 能力 | 依赖 | 判定 |
|---|---|---|
| Telegram 全功能 | api.telegram.org（渠道官方） | **纯客户端，立即可移植** |
| 飞书/Lark 全功能 | open.feishu.cn / open.larksuite.com + accounts.feishu.cn 应用注册（飞书官方 OAuth 端点，与 ZCode 服务端无关） | **纯客户端，可移植**；需新增 npm 依赖 `@larksuiteoapi/node-sdk@1.61.1`（官方用动态 `import()`，可做成可选依赖） |
| 微信 iLink | ilinkai.weixin.qq.com（微信官方 iLink Bot 平台） | **纯客户端，可移植**（协议为未公开文档的逆向接口，存在微信侧变更风险） |
| Webhook | 用户自建 URL | 纯客户端 |
| 会话桥接/权限/elicitation/cron 通知 | 本地 taskService/modelSelectionService；远程 workspace 用 main 进程 MessagePort | **纯客户端** |
| ZCode 官方服务端（zcode.z.ai 等） | **bot 平台零依赖**——bot 区段内无任何 ZCode 服务器调用（区段内出现的 zcode.z.ai 字符串属于相邻的 OAuth 代码） | 无阻碍 |

结论：**整个 bot 平台没有任何 ZCode 官方服务端依赖，100% 可移植。**

---

## 9. 开源版落点映射

| 官方构件 | 开源版落点（新建/修改） | 先例 |
|---|---|---|
| `ServiceName.Bots="bots"` | `packages/shared/src/channels.ts` → `ServiceChannels` 加 `Bots: "bots"` | `OffPeakTask: "off-peak-task"` |
| bot-config/state zod schema | `packages/shared/src/bot-platform.ts`（新）：`botsConfigSchema`、`botsStateSchema`、`botDeliveryTargetSchema`、`replyMode` 枚举 | `zcode-task-types-core.ts` |
| BotsRepo | `packages/services/src/bots/botsRepo.ts`（新）：读写 `getAppConfigDir()/bot-config.v3.json` + `bot-state.v3.json`，v1/v2 迁移 | `automationRepo.ts`（SQLite）/ settings 读写 |
| 四个 provider | `packages/services/src/bots/providers/{telegram,weixin,feishu,webhook}Provider.ts` | 无先例，独立目录 |
| channel runtimes + reconcile | `packages/services/src/bots/channelRuntimes.ts` | offpeak 派发循环 |
| 运行时锁 | `packages/services/src/bots/runtimeLocks.ts`（照抄目录 rename + lease 算法） | （无现成工具，官方即独立实现） |
| BotsService | `packages/services/src/bots/botsService.ts` + `IBotsService = createServiceDescriptor<IBotsService>(ServiceChannels.Bots)`；`packages/services/src/index.ts` 导出 | `offPeakTask.ts`/`offPeakTaskService.ts` |
| DI 装配 | `packages/services/src/node.ts` `createLocalServices` 内注册单例（依赖 credentialService、zcodeTaskService、modelSelectionService、logger） | OffPeakTaskService IIFE 注册（node.ts:2066 附近） |
| cron 集成 | `packages/services/src/session/automationRepo.ts`：schema 迁移加列 `bot_delivery_target TEXT`（照抄官方 migration 列表法）+ `getBotDeliveryTarget(automationId, workspaceKey)`；`packages/shared/src/zcode-protocol/index.ts` automationCreate/Update params 加 `botDeliveryTarget`；`packages/desktop/src/host/cronRunLifecycle.ts` 或派发处调 `watchCronRunBotDelivery` | 官方 chunk-NKOHJ4QI 同款列 |
| 协议透传（CLI 网关） | `packages/shared/src/zcode-protocol/index.ts` sendText 归因/automation schema 加 `botDeliveryTarget`（CLI 端只透传，无逻辑——官方 zcode.cjs 亦如此）；`packages/bootstrap` 无需改逻辑 | `automationId`/`offPeakTaskId` 现成字段 |
| sendPrompt 桥接 | `packages/services/src/session/zcodeTaskService.ts` sendPrompt params 增加可选 `botDeliveryTarget`（`ZCodeBackgroundTurnAttribution` 旁）；`onDynamicTaskEvent` 直接用现有 `deliveryKind:"continuous"`（官方专有 `"bot-channel-continuous"` 值可不做） | automationId 归因同款 |
| 远程 workspace bot 化（二期） | `packages/desktop/src/host/`（新 `botRemoteWorkspaceService.ts`）+ main 侧 3 个 IPC（RuntimePort/Reconnect/ConnectionStatus） | `remoteWorkspaceServiceCollection.ts` |
| UI：机器人管理 | `packages/ui/src/settings/`（新 `BotsSettingsSection.tsx` 或独立 `BotsDialog.tsx`）+ store（参照 `store/offPeakTaskStore.ts`）+ i18n；入口可先放设置页，二期再挂 RemoteConnection 对话框 | settings 页 + RemoteConnectionDialogContent |
| 依赖 | `packages/desktop/package.json` 加 `@larksuiteoapi/node-sdk`（飞书阶段；动态 import 保持可选） | 官方 package.json |

---

## 10. 分阶段实施计划

### 阶段 0：类型与存储（0.5 人日）
- 新建 `packages/shared/src/bot-platform.ts`：上文 §3 三个 schema + `BotReplyMode`/`BotProvider` 类型 + i18n messageId 枚举。
- `packages/shared/src/channels.ts`：`ServiceChannels.Bots = "bots"`。
- 验证：tsc 通过，无行为变化。

### 阶段 1：Telegram 最小闭环（见 §11 代码草案，3–5 人日）
- `packages/services/src/bots/botsRepo.ts`
- `packages/services/src/bots/providers/telegramProvider.ts`
- `packages/services/src/bots/runtimeLocks.ts`
- `packages/services/src/bots/channelRuntimes.ts`（先只实现 telegram runtime）
- `packages/services/src/bots/botsService.ts`（方法面裁剪：listBots/saveBot/deleteBot/testBot/createBindCode/getStatus/handleInboundMessage/disposeAll）
- `packages/services/src/node.ts`：装配单例；`packages/services/src/index.ts` 导出。
- `packages/desktop/src/host/index.ts`：host 启动创建（`runStartupBackgroundTasks` 门控随 offpeak 惯例）。
- 桥接：`zcodeTaskService.sendPrompt` 加 `botDeliveryTarget` 可选参数（仅归因，不影响 CLI）+ `onDynamicTaskEvent({deliveryKind:"continuous"})` 订阅投影（先只做 `assistant_changes` + `summary_changes` 两种粒度；权限请求先支持序号文本回复）。
- UI：设置页最小表单（name/token/allowedWorkspaces/绑定码生成 + 运行状态行）。
- 协议：`zcode-protocol` 无需新方法族（走 service channel）；如走 workspace 命令面可后补。

### 阶段 2：飞书/Lark（3–4 人日）
- `providers/feishuProvider.ts`（WSClient 长连接 + REST 发送 + 流式卡片 + 表单 elicitation + typing reaction）；
- `packages/desktop/package.json` 加 `@larksuiteoapi/node-sdk`；
- 注册流程 UI（accounts.feishu.cn 设备码 + QR 轮询）；
- websocket 锁（按 appId）；
- `streaming_card` replyMode。

### 阶段 3：微信 iLink（3–4 人日）
- `providers/weixinProvider.ts`（QR 登录注册 + 90s 长轮询 + context_token 回复 + AES-ECB 附件）；
- weixin 特化授权（免 bind、首次激活欢迎）；
- 状态游标持久化（bot-state `weixinGetUpdatesBuf`）。

### 阶段 4：Webhook + cron 通知（2 人日）
- `providers/webhookProvider.ts`；
- `automationRepo` 加列 + `getBotDeliveryTarget`；automationCreate/Update 协议与 cron 设置 UI 加"完成后 Bot 通知"选择器；
- host cron 派发处接 `watchCronRunBotDelivery`。

### 阶段 5：完整命令面与远程 workspace（2–4 人日）
- `/模型 /模式 /思考 /回复` 草稿选择器（复用 modelSelectionService 视图）、权限按钮 approve/deny 全链路、elicitation 多问题表单（非飞书渠道序号交互）、`/重连`；
- `botRemoteWorkspaceService` + main 侧 3 个 IPC；
- i18n 全量（zh-CN/en-US，可从官方 `IntlProvider-*.js` 提取措辞）。

### 阶段 6（可选）：Discord/WeCom/DingTalk
官方未实现，无参照，需自行开发（每渠道约 3–5 人日）。

**总计**：最小闭环 3–5 人日；对齐官方四渠道全功能约 **13–19 人日**。

---

## 11. 最小闭环：Telegram 单 bot 桥接新会话（代码草案）

### 11.1 `packages/shared/src/bot-platform.ts`（节选）

```ts
import { z } from "zod";

export const botProviderSchema = z.enum([
  "telegram", "webhook", "feishu", "lark", "weixin", "discord", "wecom",
]);
export type BotProvider = z.infer<typeof botProviderSchema>;

export const botDeliveryTargetSchema = z
  .object({
    provider: z.enum(["feishu", "lark", "weixin"]),
    botId: z.string().trim().min(1),
    providerUserId: z.string().trim().min(1),
    chatType: z.enum(["private", "group"]),
  })
  .strict();
export type BotDeliveryTarget = z.infer<typeof botDeliveryTargetSchema>;

export const botReplyModeSchema = z.enum([
  "assistant_changes", "assistant_toolcalls_changes", "summary_changes", "streaming_card",
]);

export const botConfigSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    provider: botProviderSchema,
    enabled: z.boolean(),
    credentialRef: z.string().min(1).optional(),
    providerUserId: z.string().min(1).optional(),
    displayName: z.string().optional(),
    allowedWorkspaces: z.array(z.string().min(1)),
    currentOptions: z.object({}).passthrough(),   // 阶段 5 再收紧
    replyMode: botReplyModeSchema,
  })
  .strict();
export const botsConfigSchema = z
  .object({ version: z.literal(3), bots: z.array(botConfigSchema) }).strict();

export const botStateEntrySchema = z
  .object({
    botId: z.string().min(1),
    workspacePath: z.string().min(1),
    mode: z.enum(["draft", "task"]),
    activeTaskId: z.string().nullable(),
    telegramOffset: z.number().optional(),
    updatedAt: z.number(),
  })
  .strict();
export const botsStateSchema = z
  .object({ version: z.literal(3), bots: z.record(z.string(), botStateEntrySchema) })
  .strict();

export function buildBotCredentialKey(botId: string): string {
  return `bot:${botId}:credential`;
}
```

### 11.2 `packages/services/src/bots/runtimeLocks.ts`

```ts
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { getAppConfigDir } from "#src/paths.js";

const LEASE_TOUCH_MS = 10_000;
const LEASE_STALE_MS = 30_000;

interface LockOwner { pid: number; botId: string; nonce: string; createdAt: number; }

function lockPath(kind: string, key: string): string {
  const hash = createHash("sha256").update(key.trim()).digest("hex");
  return join(getAppConfigDir(), "bots-runtime-locks", kind, `${hash}.lock`);
}
function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

/** 目录原子 rename 锁：同机多 host 只有一个能持有；返回 null 表示他处占用。 */
export async function acquireBotRuntimeLock(
  kind: string, key: string, botId: string,
): Promise<{ release(): Promise<void> } | null> {
  const target = lockPath(kind, key);
  const owner: LockOwner = {
    pid: process.pid, botId, nonce: randomBytes(8).toString("hex"), createdAt: Date.now(),
  };
  await mkdir(join(target, ".."), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pending = `${target}.${owner.nonce}.pending`;
    try {
      await mkdir(pending, { recursive: true });
      await writeFile(join(pending, "owner.json"), `${JSON.stringify(owner)}\n`);
      await writeFile(join(pending, `lease-${owner.nonce}`), "");
      await rename(pending, target);          // 原子占位
    } catch (e: any) {
      if (e?.code !== "ENOTEMPTY" && e?.code !== "EEXIST" && e?.code !== "EPERM") throw e;
      // 冲突：检查 stale
      try {
        const raw = JSON.parse(await readFile(join(target, "owner.json"), "utf-8")) as LockOwner;
        const leaseAt = (await import("node:fs/promises")).stat
          .call(null, join(target, `lease-${raw.nonce}`)).then((s) => s.mtimeMs);
        const age = Date.now() - (await leaseAt);
        if (isProcessAlive(raw.pid) && age >= 0 && age < LEASE_STALE_MS) return null;
      } catch { /* 读不到 owner 视为 stale */ }
      await rm(target, { recursive: true, force: true });
      continue;
    } finally {
      await rm(pending, { recursive: true, force: true }).catch(() => {});
    }
    const leaseFile = join(target, `lease-${owner.nonce}`);
    const timer = setInterval(() => {
      const now = new Date();
      utimes(leaseFile, now, now).catch(() => {});
    }, LEASE_TOUCH_MS);
    timer.unref?.();
    return {
      async release() {
        clearInterval(timer);
        try {
          const raw = JSON.parse(await readFile(join(target, "owner.json"), "utf-8")) as LockOwner;
          if (raw.pid === owner.pid && raw.nonce === owner.nonce) {
            await rm(target, { recursive: true, force: true });
          }
        } catch { /* 已被他人清理 */ }
      },
    };
  }
  return null;
}
```

### 11.3 `packages/services/src/bots/providers/telegramProvider.ts`

```ts
import type { BotConfig } from "@zcode/shared";

export interface BotTransportDeps { loadCredential(ref: string): Promise<string | null>; }
export interface OutboundMessage {
  providerUserId: string; text: string;
  selection?: { action: string; options: Array<{ id: string; label: string; description?: string }>;
                cancelLabel?: string; showCancel?: boolean; token?: string };
}
export interface InboundActor {
  provider: BotProvider; botId: string; providerUserId: string;
  displayName?: string; chatType: "private" | "group"; chatId?: string; providerMessageId?: string;
}
export interface InboundMessage { botId: string; text: string; actor: InboundActor; }

const API = "https://api.telegram.org";
const TEXT_CHUNK = 3900;

export function createTelegramBotProvider(deps: BotTransportDeps) {
  const loadToken = async (bot: BotConfig) =>
    bot.credentialRef ? deps.loadCredential(bot.credentialRef) : null;

  const call = async (token: string, method: string, body: unknown) => {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return { ok: res.ok, payload: await res.json().catch(() => null) } as const;
  };

  return {
    async test(bot: BotConfig) {
      const token = await loadToken(bot);
      if (!token?.trim()) return { ok: false, message: "Telegram bot token is missing." };
      const me = await call(token, "getMe", {});
      const name = me.payload?.result?.first_name ?? me.payload?.result?.username;
      return me.ok && me.payload?.ok === true
        ? { ok: true, name, message: "Telegram bot is reachable." }
        : { ok: false, message: me.payload?.description ?? "Telegram getMe failed." };
    },
    async resolveName(bot: BotConfig) {
      const token = await loadToken(bot);
      if (!token) return null;
      const me = await call(token, "getMe", {});
      return me.payload?.result?.first_name ?? me.payload?.result?.username ?? null;
    },
    async send(bot: BotConfig, out: OutboundMessage): Promise<void> {
      const token = await loadToken(bot);
      if (!token) return;
      for (let i = 0; i < out.text.length; i += TEXT_CHUNK) {
        const chunk = out.text.slice(i, i + TEXT_CHUNK);
        await call(token, "sendMessage", { chat_id: out.providerUserId, text: chunk });
      }
    },
    async sendTyping(bot: BotConfig, out: { providerUserId: string }): Promise<void> {
      const token = await loadToken(bot);
      if (token) await call(token, "sendChatAction", { chat_id: out.providerUserId, action: "typing" });
    },
    /** 返回偏移游标；调用方写回 bot-state.telegramOffset */
    async poll(bot: BotConfig, offset: number):
      Promise<{ messages: InboundMessage[]; nextOffset: number } | null> {
      const token = await loadToken(bot);
      if (!token) return null;
      const res = await fetch(`${API}/bot${token}/getUpdates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timeout: 25, offset }),
        signal: AbortSignal.timeout(40_000),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(json?.result)) return null;
      let next = offset;
      const messages: InboundMessage[] = [];
      for (const update of json.result as any[]) {
        next = Math.max(next, update.update_id + 1);
        const msg = update.message;
        if (!msg?.text || !msg?.chat) continue;
        messages.push({
          botId: bot.id,
          text: msg.text,
          actor: {
            provider: "telegram", botId: bot.id,
            providerUserId: String(msg.from?.id ?? ""),
            displayName: msg.from?.username ?? msg.from?.first_name,
            chatType: msg.chat.type === "private" ? "private" : "group",
            chatId: String(msg.chat.id ?? ""),
            providerMessageId: String(msg.message_id ?? ""),
          },
        });
      }
      return { messages, nextOffset: next };
    },
    parseCallback: undefined as never,   // 阶段 5 补按钮回调
  };
}
```

### 11.4 会话桥接（`botsService.ts` 内 handleMessage 核心）

```ts
import type { IZCodeTaskService } from "#src/session/zcodeTaskService.js";
import type { BotDeliveryTarget } from "@zcode/shared";

async function handleUserText(ctx: {
  bot: BotConfig; state: BotStateEntry; text: string;
  taskService: IZCodeTaskService;          // 本地：直接注入；远程：阶段 5 经 port
  modelSelection: ModelSelection | undefined;
}): Promise<void> {
  const { bot, state, taskService } = ctx;
  const traceId = `bot-${randomUUID()}` as TraceId;
  const deliveryTarget: BotDeliveryTarget | undefined = undefined; // telegram 不需要（官方仅飞书/微信 cron 通知用）

  if (state.mode !== "task" || !state.activeTaskId) {
    // draft → 新建 task
    const created = await taskService.createTask({
      workspacePath: state.workspacePath,
      provider: "glm",
      modelSelection: ctx.modelSelection,
      v4Create: true,
    });
    state.mode = "task";
    state.activeTaskId = created.taskId;
    await repo.writeState(stateMap);
    subscribeReplyStream(bot, state, created.taskId);          // 见下
    await taskService.sendPrompt({
      taskId: created.taskId, traceId, content: ctx.text,
      modelSelection: ctx.modelSelection,
    });
    return;
  }
  // task 态 → resume 后续话
  await taskService.resumeTask({ taskId: state.activeTaskId, workspacePath: state.workspacePath });
  subscribeReplyStream(bot, state, state.activeTaskId);
  await taskService.sendPrompt({
    taskId: state.activeTaskId, traceId, content: ctx.text,
    modelSelection: ctx.modelSelection,
  });
}

/** 回复投影：订阅流事件，把 assistant 文本段聚合成一条 Telegram 消息 */
function subscribeReplyStream(bot: BotConfig, state: BotStateEntry, taskId: string): void {
  const disposable = taskService.onDynamicTaskEvent({
    workspacePath: state.workspacePath,
    taskId,
    deliveryKind: "continuous",          // 官方为 "bot-channel-continuous"，开源沿用现有枚举
  })((event: ZCodeStreamEvent) => {
    // 阶段 1 简化：收集 assistant 文本 delta，turn 结束（或按 3900 分段阈值）即 provider.send
    // 阶段 5 换成官方 createAssistantReplyBlocks 的 replyMode 投影 + 权限/elicitation 选择
  });
  streamSubs.set(`${bot.id}:${taskId}`, disposable);
}
```

### 11.5 runtime 循环（`channelRuntimes.ts`，单 bot reconcile）

```ts
async function runTelegramRuntime(bot: BotConfig, signal: AbortSignal): Promise<void> {
  const token = await credentialService.load(bot.credentialRef!) ?? "";
  const lock = await acquireBotRuntimeLock("telegram-polling", token, bot.id);
  if (!lock) { status.set(bot.id, { status: "idle", messageId: "handledElsewhere" }); return; }
  try {
    let offset = (await repo.readState()).bots[bot.id]?.telegramOffset ?? 0;
    status.set(bot.id, { status: "polling" });
    while (!signal.aborted) {
      const batch = await provider.poll(bot, offset);
      if (!batch) { await waitFor(5_000, signal); continue; }
      offset = batch.nextOffset;
      await persistOffset(bot.id, offset);                  // 断电不重放
      for (const message of batch.messages) {
        await enqueueInbound(message);                       // 串行处理，见 botsService
      }
    }
  } finally {
    status.set(bot.id, { status: "stopped" });
    await lock.release();
  }
}
```

### 11.6 UI（阶段 1 最小面）
- `packages/ui/src/settings/BotsSettingsSection.tsx`：列表（name/provider/enabled/状态行）+ 新建表单（token 输入 → testBot → saveBot）+ "生成绑定码"按钮（`createBindCode` → 展示 `/bind <CODE>`）。
- store 照抄 `packages/ui/src/store/offPeakTaskStore.ts` 的 shape：`refresh(service: IBotsService)`。
- 服务获取：`ServiceChannels.Bots` 描述符经现有 ProxyChannel 机制自动获得 typed client。

---

## 12. 风险与注意事项

1. **微信 iLink 为非公开协议**（逆向所得端点），字段兼容层极宽（官方对每种字段写了 fallback），微信侧可能随时变更——建议放最后阶段并做 `summarizeWeixinRawMessage` 式诊断日志。
2. **飞书流式卡片**依赖 Card JSON 2.0 与 `card.action.trigger` 同步回调语义；开源若不能升级 `@larksuiteoapi/node-sdk`（1.61.1），先以纯文本回复 + `assistant_changes` 粒度交付，流式卡片降级为可选。
3. **锁的正确性**：`rename` 在同目录才原子；跨用户/容器场景锁目录不共享（与官方一致，可接受）。
4. **host 生命周期**：bot 轮询/WS 属长连接，需挂入 host 关闭阶段（`hostShutdownPhases`）并 `disposeAllAndWait`；多窗口（同机多 host）依赖运行时锁，UI 状态可能在他窗口（`handledElsewhere` messageId）。
5. **安全**：token 存 credentialService（已加密）；webhook secret 比对、bind 码 TTL、私聊-only 校验、allowedWorkspaces 白名单都必须保留（官方在 `withAuthorizedContext` 集中裁决）。
6. **协议面**：CLI（zcode.cjs）对 `botDeliveryTarget` 只是 schema 透传——开源 CLI 侧（`packages/bootstrap`/`apps/zcode-cli`）需同步 `sendText`/automation schema 增列，否则 CLI 网关会拒包；这是唯一可能触碰 agent 协议的点，语义零变化。
7. **测试**：锁并发（双 acquire 互斥 + stale 抢占）、getUpdates offset 持久化、bind 码过期、`validateBotConfig` 唯一性冲突、cron 通知在 task 完成后的 exactly-once。
