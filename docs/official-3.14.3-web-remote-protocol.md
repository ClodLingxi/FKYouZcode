# ZCode 3.14.3 Web Remote Control（手机远控）协议规格

> 逆向自官方 3.14.3 解包产物（`/tmp/official-3.14.3/src/out/`，main=`index.js`/`chunk-GJUBRD53.js`/`chunk-C6VCYWB4.js`/`chunk-BMP2VTTL.js`，host=`index.js`/`chunk-EBZ6RJTQ.js`）与官方 CLI 运行时 `/opt/ZCode/resources/glm/zcode.cjs`（内含同一份共享协议库，含 HMAC 测试向量，已本地复算验证）。
> 标注 **[未还原]** 的条目表示压缩代码中无法确证，其余内容均有代码依据。

---

## 1. 拓扑与角色

```
手机/Web 客户端 (浏览器 App)
   │  WSS + JSON 消息（注册/认证/配对心跳/data 信封）
   ▼
Relay 服务器（官方托管）
   │       ▲
   │       └─ 同一 WS、同一认证体系，按 device_sid 配对转发 data
   ▼
桌面 main 进程 WebRemoteControlDeviceTransport（role="device"）
   │  rpc-frame 可靠传输在此终结（main ↔ 手机端到端）
   │  MessagePort 原始字节 + 流控（MessageChannelMain）
   ▼
每窗口桌面 host 子进程（host/index.js，CLI gateway）
      ChannelServer：真正执行 RPC（zcode-task / file / terminal / ...）
```

- **Relay 为官方托管**。端点由 ZCode endpoint origin 推导（`buildZCodeEndpointUrls`）：
  - production origin：`https://zcode.z.ai` → relay `wss://zcode.z.ai/ws`
  - 国内/test origin：`https://zcode.chatglm.site` → relay `wss://zcode.chatglm.site/ws`
  - `resolveWebRemoteControlRelayWsUrl`：endpointOrigin 为 chatglm 时硬编码 `wss://zcode.chatglm.site/ws`，否则 `wss://zcode.z.ai/ws`（**自定义 origin 会落到 zcode.z.ai，自托管必须用 env 覆盖**，见 §7）。
  - Web 客户端 URL（QR 的 baseUrl）：`<origin>/remote/v4`（桌面 appVersion ≥ **3.4.0** 时 v4，否则 `/remote/v3`，`isWebRemoteControlV4AppVersion`）。另有 `${origin}/web-remote/callback`（webRemoteCallbackUrl）。
- **职责划分**：
  - 手机端：QR 解析 → 以 QR 中 `sid/hash` 向 relay 认证配对 → 发起 JSON 控制面（bootstrap、workspace-bridge-open 等）→ 通过 rpc-frame 承载与 host 之间的二进制 RPC 字节（端到端，relay 不解析）。
  - Relay：认证（HMAC 挑战）、按 device_sid 配对、转发 `{type:"data"}` 信封、配对状态仲裁（踢旧连接 KICKED）、心跳 ack 回显、错误注入。它**不参与** rpc-frame 的 seq/ack。
  - 桌面 main：设备注册/认证、配对状态机、JSON 控制面处理（bootstrap/workspace 列表/platform 请求/bridge 生命周期）、rpc-frame 编解码与可靠传输（AcknowledgedRelayProtocol）、与 host 的 MessagePort 桥接、状态推送给 renderer。
  - Host 子进程：收到 `attach-service-port` 后在该 port 上挂 ChannelServer，执行真正的 RPC（与桌面 renderer 用的同一套服务）。
- **相邻子系统（易混淆）**：`/api/server-info`、`/api/rpc-host-capability`、`/ws`、`/ws/host`（`resolveServerRemoteEndpoints`，可带 `?token=`）属于 **Server Remote**（自托管 server 型远程工作区）子系统，不是 Web Remote 的 relay 端点；Web Remote 的 bridge `kind:"remote"` 可把这类远程会话桥给手机。请求头常量 `x-zcode-rpc-host-capability` 也属于该子系统（取值 schema **[未还原]**）。

---

## 2. 配对流程

### 2.1 桌面启动（renderer → main IPC）
- `zcode:start-web-remote-control`（invoke，参数 `{workspacePath, workspaceIdentity?, remoteSessionId?, initialTaskId?, theme?}`）：
  1. `authorizeStart(windowId, ctx)`：签发一次性 token = `randomUUID()`，**TTL 30s**，绑定 windowId+workspaceKey+remoteSessionId（防 renderer 竞态/重放）。
  2. 加载持久化认证：`deviceSid` ← settings `webRemoteControlExternalRelayDevice.deviceSid`；`passHash` ← 凭据服务 key **`web-remote-control:external-relay:pass_hash`**。两者缺一 → 全部清空重注册。
  3. 无持久化时新建：`password = base64url(randomBytes(24))`；`passHash = base64(SHA-256(password))`（password 本身不落盘，也不需要）。
  4. WS 连接 relay：`<relayWsUrl>?mid=<deviceMid>`，header **`X-Device-ID: <deviceMid>`**，启用 permessage-deflate。
  5. 等 QR-ready（**30s 超时**：`waiting_terminal`/`paired` 且拿到认证）后生成 QR URL 返回：
     `{status, sessionId:deviceSid, windowControlSessionId:deviceSid, qrUrl, connectUrl, workspacePath, workspaceIdentity, remoteSessionId, initialTaskId}`。

### 2.2 Relay 注册/认证（main↔relay JSON 消息，均为 UTF-8 JSON，≤1MB）
| 方向 | 消息 |
|---|---|
| C→S | `{type:"device_register_init", device_mid, pass_hash, meta:{platform, version:appVersion, name:<os.hostname()>}, client_ts}` |
| S→C | `{type:"device_register_ack", device_sid}`（server 分配，持久化 deviceSid+passHash） |
| C→S | `{type:"auth_init", role:"device", device_sid, meta, client_ts}` |
| S→C | `{type:"auth_challenge", nonce}` |
| C→S | `{type:"auth_response", device_sid, proof, client_ts}` |
| S→C | `{type:"auth_ack"|"pair_status_ack", pair_status:"waiting"|"matched"}` |
| C→S | 心跳 `{type:"pair_status_query", device_sid, client_ts}`（默认 **10s** ± min(2000, 20%) 均匀抖动） |
| S→C | `{type:"error", code, message}`，code ∈ `KICKED` / `AUTH_FAILED` / `INTERNAL` / `WRONG_PARAM` |
| 双向 | `{type:"data", payload, client_ts?, server_ts?}`（业务/帧负载信封） |

### 2.3 HMAC proof（字节级，已用官方测试向量验证）
```
passHash 存储/传输形态：base64( SHA-256( base64url(randomBytes(24)) ) )   // 44 字节 ASCII 字符串
proof = base64url( HMAC-SHA256( key = <passHash ASCII 字节>,
                                msg = <nonce> "|" <role> "|" <deviceSid> ) )
```
- 分隔符为字面 `|`（单竖线，无长度前缀），role 对桌面为 `"device"`（共享库测试向量另有 `"terminal"`；手机端 role 字符串 **[未还原]**，结构对称）。
- 官方向量（zcode.cjs）：`passHash="dGVzdF9oYXNo", nonce="nonce-1", role="device", deviceSid="device-1"` → `proof="XK0m7u-26VS88uk7ISAX5Z_9pjzq8jqyP77N-HkCsPE"`（本地 HMAC-SHA256/base64url 复算一致）。
- 失败处理：持久化认证遇 `AUTH_FAILED` → 清 deviceSid、用同一 passHash 重新 `device_register_init` 一次；再次失败 → 终态 error。`KICKED` → 关闭并重连（新连接踢旧连接）。`INTERNAL` → 可恢复错误；配对后 `WRONG_PARAM` → 上报错误。

### 2.4 QR 内容（`buildWebRemoteControlExternalQrUrl`）
```
<remoteUrl>?sid=<deviceSid>&hash=<passHash>&t=<Date.now()>
          [&mid=<deviceMid>][&name=<deviceName>][&app_version=<桌面版本>]
```
- **`hash` 参数就是 passHash 本身**（base64(SHA-256(password))），即 QR 是 bearer 凭据；手机端以 `sid+hash` 走同一套挑战应答完成配对。
- `t` = 桌面生成时毫秒时间戳；手机端解析函数 `parseWebRemoteControlExternalQrParams` 还接受 `theme`（`light|dark|zai-light|zai-dark|system`），桌面端构造时不写 theme。
- `name` = `os.hostname()`；`mid` = deviceMid（`crypto.randomUUID()`，持久化于 `<configDir>/telemetry-state.json` 的 `deviceMid` 字段）。
- 桌面 renderer 在对话框中以 `QRCode.toDataURL(qrUrl,{margin:1,width:320})` 展示，1s 轮询 `zcode:get-web-remote-control-status`。
- 「刷新二维码/重置配对」= 停止 + 清除持久化认证（reason `leaked-qr`）+ 重新注册（轮换 password/passHash）。

---

## 3. AcknowledgedRelay 可靠传输（rpc-frame）

### 3.1 信封与帧格式（均为 JSON 文本，strict zod 校验）
外层 relay data 信封：`{type:"data", payload:<frame|app载荷>, client_ts?:int≥0, server_ts?:int≥0}`。

物理帧 `rpc-frame`：
```json
{ "zcode_type":"rpc-frame",
  "bridgeSessionId":"<1..256 chars, [A-Za-z0-9._~-]>",
  "bridgeGeneration":0,            // 可选, int≥0（bridge 重开代数）
  "recoveryId":"<同上字符集>",      // 可选
  "seq":1,                          // 物理帧序号, 1..2^53-1, 跨消息连续
  "messageSeq":1,                   // 逻辑消息序号, 1..2^53-1
  "fragmentIndex":0, "fragmentCount":1,   // 0..63 / 1..64
  "messageBytes":123,               // 整条消息字节数, 1..16MB
  "checksum":{"algorithm":"crc32","value":"1a2b3c4d"},
  "dataBase64":"<canonical base64, 4..1MB 字符>" }
```
ACK 帧：`{zcode_type:"rpc-frame-ack", bridgeSessionId, bridgeGeneration?, recoveryId?, ackMessageSeq}`（ack 语义：**序号 ≤ ackMessageSeq 的所有消息全部确认**，累积确认）。

校验和：标准 CRC-32（反射多项式 0xEDB88320，初值/异或 0xFFFFFFFF），对**整条重组后的消息字节**计算，输出 8 位小写 hex。base64 必须规范编码（重编码一致才有效）。

### 3.2 常量
| 常量 | 值 | 含义 |
|---|---|---|
| `maxPhysicalFrameBytes` | **1MB**（1024*1024） | 单条 WS 消息（含信封的 JSON 文本）硬上限，双向 |
| `maxMessageBytes` | **16MB** | 单条逻辑消息上限 |
| `maxFragments` | **64** | 单条消息最大分片 |
| `assemblyTimeoutMs` | **30s** | 分片组装超时（`remote.rpcFrame.assemblyTimeout`） |
| `replayBufferMaxBytes` | **8MB** | 未确认出站字节重放缓冲上限 |
| `replayBufferGraceMs` | **45s** | 最旧未确认批次/pending-ack 的宽限 |
| 高/低水位 | **1MB / 256KB** | 未确认字节 >1MB → saturated；回落 ≤256KB → drained |
| heartbeatIntervalMs / jitter | 10s / min(2000, 20%) | 配对心跳 |
| heartbeatAckTimeoutMs | 30s | 心跳无 ack → 重连 |
| reconnectDelayMs / jitter | 1s / ≤2s | 断线重连 |
| 起始 token TTL / QR-ready 超时 | 30s / 30s | |
| 手机断连宽限 | 3s | mobileConnected=false 前 |
| 出站 app 载荷缓冲 | 50 条 / 5s | 超限丢弃 |
| 连接恢复超时（客户端库） | 120s / 5s | connection-recovery-timeout |

### 3.3 发送端语义（AcknowledgedRelayProtocol）
- 每条消息 = 一个批次（帧数组 + 外层字节总和），追加进批次队列；`reserveMessage` 时若 `unackedBytes + 批次字节 > 8MB` → 降级 `replayBufferExceeded`。
- 发送顺序：**先冲 pending-ack**（收到对端数据要回 ack），再发下一帧；帧按 `seq` 连续编号，跨消息不重置。
- 收到 ack：`releaseThrough(ackMessageSeq)` 释放 ≤N 的批次、扣减 unacked 字节；ack 超过最高已完整发送序号 → `futureAck` 降级。
- 饱和流控：`onSaturated`/`onDrained` → main 向 host port 发 `{"__zcodeRpcControl":"connection-flow-v1","state":"saturated"|"drained"}`（host 再转发给 agent 连接 `setTransportFlowState`）。
- 45s 宽限：最旧未确认批次（`replayGraceExceeded`）或 pending-ack（`ackGraceExceeded`）超时 → 降级。
- **重连重放**：重新配对（`onSendReady`）时 `resetReplay()` 并从每条未确认消息的第 0 帧起重发全部未确认字节（≤8MB/45s 内有效，接收端靠指纹去重）。
- 入队/度量失败：`encodingFailed`、`outerMeterFailed`、`sendFailed`、`emptyMessage`、`messageTooLarge`、`fragmentLimitExceeded`、`envelopeTooLarge`、`sequenceOverflow`、`internalEnvelopeError`。

### 3.4 接收端语义（WebRemoteControlRpcTransportAssembler，严格顺序）
- 身份（bridgeSessionId/bridgeGeneration/recoveryId）不一致 → `identityMismatch`（非终局 fault，直接忽略该帧）；终局故障后仍收帧 → 按 terminalReason 报 fault。
- 物理序号必须等于期望值：落后 → 重复（同指纹回 ack）/`conflictingDuplicate`；超前 → `physicalGap`。序号耗尽（MAX_SAFE_INTEGER 特判）→ `physicalSequenceExhausted`。
- `messageSeq` 必须等于期望 → 否则 `messageGap`；分片进度必须连续 → `fragmentGap`；同一消息内 `fragmentCount/messageBytes/checksum` 必须一致 → `metadataMismatch` / `checksumMismatch`；累计字节不得超 `messageBytes` → `lengthMismatch`。
- 同 seq 指纹（对帧头+CRC(数据) 的 JSON 数组）相同 → `duplicate`（补 ack）；不同 → `conflictingDuplicate`（终局）。
- 组装完成时 CRC 不符 → `checksumMismatch`；30s 未齐 → `assemblyTimeout`。
- 非法 base64 → `invalidBase64`；zod 校验失败 → `invalidMetadata`；`messageBytes/fragmentCount/信封尺寸` 超限 → `messageTooLarge`/`fragmentLimitExceeded`/`envelopeTooLarge`。
- 交付：完整消息字节 → 交给上层（main: `VSBuffer.wrap(bytes)` 后进 RPC 层），排队回 ack（ack 优先于新数据发出）。

### 3.5 降级（degraded）为终局
任一 terminal fault → 协议废弃（清队列/定时器），main 向手机发
`{zcode_type:"bridge-degraded", bridgeSessionId, bridgeGeneration?, recoveryId?, reason:"rpc-transport-fault", ...}`；
手机端可凭 `recoveryId`/`bridgeGeneration` 发 `workspace-bridge-open` 重建。app 层 `bridge-degraded.reason` 枚举：`rpc-transport-fault | rpc-frame-gap | buffer-overflow | buffer-timeout`。

### 3.6 故障码全表（remote.rpcFrame.*，共 36 个）
| 故障码 | 触发点 | terminal |
|---|---|---|
| ackGraceExceeded | 发出的某消息 45s 内未获 ack | ✔ |
| replayGraceExceeded | 队列中最旧未确认批次 45s 未释放 | ✔ |
| replayBufferExceeded | 未确认字节将超 8MB | ✔ |
| assemblyTimeout | 分片 30s 未齐 | ✔ |
| futureAck | ack 序号 > 最高已完整发送 | ✔ |
| sendFailed | 底层 WS 发送抛异常 | ✔ |
| encodingFailed | 帧编码异常 | ✔ |
| outerMeterFailed | 批次字节度量异常 | ✔ |
| emptyMessage | 编码 0 字节消息 | ✔(编码侧) |
| messageTooLarge | 消息 >16MB | ✔ |
| fragmentLimitExceeded | 需要分片 >64 或声明 >64 | ✔ |
| envelopeTooLarge | 组不出 ≤1MB 的帧 / 收到超限 | ✔ |
| sequenceOverflow | 物理序号超 MAX_SAFE_INTEGER | ✔(编码侧) |
| internalEnvelopeError | 编码后自检失败 | ✔(编码侧) |
| manuallyDegraded | 外部手动标记（如入口层超限） | ✔ |
| deliveryFailed | 上抛重组消息时异常 | ✔ |
| invalidPhysicalSeq / invalidMessageSeq / invalidIdentity / invalidTimeout / invalidPhysicalLimit / invalidMessageLimit / invalidFragmentLimit | 构造参数非法 | ✔(编码/构造侧) |
| invalidPayload | acceptPayload 非候选对象 | ✔ |
| invalidBase64 | base64 非规范/解码为空 | ✔ |
| invalidMetadata | zod 帧校验失败 | ✔ |
| identityMismatch | 桥身份不匹配 | ✘（丢帧） |
| conflictingDuplicate | 同 seq 指纹冲突 | ✔ |
| physicalGap | 物理序号跳变 | ✔ |
| messageGap | 消息序号跳变 | ✔ |
| fragmentGap | 分片序不连续 | ✔ |
| metadataMismatch | 同消息帧头不一致 | ✔ |
| checksumMismatch | CRC 校验失败 | ✔ |
| lengthMismatch | 累计字节 ≠ messageBytes | ✔ |
| physicalSequenceExhausted / messageSequenceExhausted | 序号空间耗尽 | ✔ |

（另有客户端库内部使用的 `invalidJson` / `invalidEnvelope` 变体，见 zcode.cjs。）

---

## 4. RPC 面

### 4.1 JSON 控制面（app payload，`zcode_type`，由 main 处理）
手机 → 桌面：
- `bootstrap-request {requestId}` → 桌面回 `bootstrap-response {requestId, success:true, result:{windowControlSessionId(=deviceSid), desktopAppVersion, workspaces:[{workspacePath, workspaceIdentity?, remoteSessionId?, label, workspacePurpose?, kind:"local"|"remote", connectionState?, lastConnectionError?}], tasks:[{taskId,title,workspacePath,workspaceIdentity?,remoteSessionId?,workspaceLabel,workspaceKind,createdAt,updatedAt,provider?,unreadAt?,displayStatus?(idle|running|completed|error),hasBackgroundWork?,workflowActivity?,pinned?,archived?}], initialViewState?, mobileViewState?}}`。
- `workspace-list-request {requestId}` → `workspace-list-response {result:{workspaces, tasks?, activeWorkspaceKey?, activeTaskId?}}`；桌面侧变更时主动推 `workspace-list-updated {result}`（内容签名去重）。
- `workspace-bridge-open {requestId, bridgeSessionId, bridgeGeneration?, recoveryId?, workspaceKey, taskId?}` → 成功回 `workspace-bridge-ready {..., bridge:{kind:"local"} | {kind:"remote", workspaceIdentity, remoteSessionId, ...}}`（此后进入帧通道）；失败回 `workspace-bridge-error {reason, error}`。
  - `workspaceKey = workspaceIdentity?.trim() || workspacePath`；`kind:"remote"` 必须带 workspaceIdentity+remoteSessionId，否则拒绝。
- `workspace-reconnect-request {requestId, workspaceKey}` → `workspace-reconnect-response {success}`（main 转发给 renderer 执行重连，120s 超时）。
- `mobile-view-state-update {viewState:{activeWorkspaceKey?, activeTaskId?, updatedAt}, deviceInfo?}`（deviceInfo：platform/version/name/userAgent/language(s)/browserPlatform/viewport{w,h,dpr}/screen/timezone/online/updatedAt）。
- `platform-request {requestId, method, args?}`，method 枚举：`isDockerAvailable | listWSLDistros | listDockerContainers | listSSHConfigAliases | loadMcpFromUserDirectory | saveMcpToUserDirectory | migrateLegacyCommonMcp` → `platform-response {success, result|error}`。
- `telemetry-report {event}`、`mobile-diagnostic {event: state-transition|socket-close|socket-error|recover-start|recover-scheduled|pair-status|failure, timestamp, state?, previousState?, pairStatus?:waiting|matched, closeCode?, closeReason?, wasClean?, wasPaired?, failureReason?, failureMessage?, visibilityState?, online?, hiddenDurationMs?}`。

桌面 → 手机：
- `app-error {requestId?, bridgeSessionId?, reason, error}`；`bridge-degraded`（见 §3.5）；`workspace-list-updated`。
- 失败原因枚举（11 个）：`session-not-found | session-expired | session-conflict | workspace-closed | desktop-disconnected | invalid-mobile-connection | desktop-bootstrap-timeout | connection-recovery-timeout | relay-unavailable | unsupported-action | unexpected-error`。
  桌面关闭会话时发送 `{zcode_type:"app-error", reason:"desktop-disconnected", error:"Desktop disconnected this Web remote control session."}` 并拆除桥。host 侧错误映射：`DESKTOP_HOST_MISSING→desktop-disconnected`；`REMOTE_SESSION_MISSING/…WINDOW_MISMATCH→workspace-closed`；`REMOTE_WORKSPACE_IDENTITY_*(MISSING/MISMATCH)→unsupported-action`。

### 4.2 Workspace bridge 与帧内二进制 RPC
bridge ready 后，**rpc-frame 的 dataBase64 拼接出的字节 = main↔host MessagePort 上的原始 RPC 消息**（手机与 host 端到端，main 只做信使）：
- MessagePort 消息两类：`Uint8Array`（RPC 消息）与流控对象 `{"__zcodeRpcControl":"connection-flow-v1","state":"saturated"|"drained"}`。
- RPC 编码（共享二进制序列化，tag+varint）：tag `0`=undefined、`1`=string、`2`=Uint8Array(Buffer)、`3`=VSBuffer、`4`=array、`5`=object(JSON)、`6`=int(varint)；对象内嵌 `Uint8Array` 编码为 `{"__zcode_rpc_nested_uint8array_v1":true,"base64":"..."}`。
- 消息类型（`[...]` 为序列化数组 + 尾随 argsBlob）：
  - C→S：`[100, requestId, channelName, method, args?]`（promise 调用）、`[101, requestId]`（取消）、`[102, requestId, channelName, event, args?]`（订阅事件）、`[103, requestId]`（退订）。
  - S→C：`200` 初始化 ack（连接就绪）、`[201, id, data]` 成功/事件数据、`[202, id, {message,name,stack[]?,code?,kind?,...}]` 错误、`[203, id, data]`、`[204, id, data]`（同样路由给 handler；204 精确语义 **[未还原]**）。
- **Channel（=host 侧服务名）全集**（host 按 scope/clientMode 暴露）：`file, media-preview, system, terminal, git, git-checkpoint, setting, credential, cua-permission, cua-pip-session, broadcast, zcode-task, window-controller, zcode-agent, zcode-session, conversation-share, file-watcher, oauth, provider-settings, model-selection, provider-provisioning-target, usage-stats, coding-plan-subscription, client-config, client-scenes, cloud-content, marketing-touch, skills, skill-sync, mcp-sync, plugin-sync, plugins, plugin-management, subagents, commands, hooks, memory, output-style, settings-sync, bots, feedback, prompt-attachment-transfer, off-peak-task, onboarding-record`。
  - 每个 channel 的完整 method+参数 schema 过多 **[未还原]**（与桌面 renderer↔main 同一套）。已确证的行为样例：`zcode-task.getTaskSnapshot`（`clientMode:"web-remote-replayable"` 时走 "replayable_snapshot"，补齐 model/thoughtLevel；`includeEmptyPendingElicitations` 特殊为 true）、`zcode-task` 归档任务删除/`setTaskUnread`、`zcode-agent` 以 `connectionId:"host-rpc-*"` + `clientMode` 建立（v4 网关 hello：`deliveryProfile:"replayable"`、capabilities `{nativeDialogs:false, localTerminal:false, binaryFrames:false, compression:"none", workspaceHookReview:true, independentPlanState:true, ...}`）、elicitation 应答在 web-remote-replayable 下写入重放去重存储。
- **clientMode=`"web-remote-replayable"`** 是手机桥的标记，host 据此切换"可重放"交付档（快照补齐、elicitation 重放、恢复策略 `resumeModelPolicy`）；`deliveryKind` 映射：`replayable↔web-remote-replayable`、`continuous↔desktop-continuous`。
- 任务事件/命令相关 wire 形状（共享库，手机桥与 bot 远控共用）：命令 `stop_generation | respond_permission{permissionRequestId,optionId,response} | respond_elicitation{elicitationRequestId, action:accept|decline|cancel, content?} | respond_workspace_hook_review{sessionId,bundleDigest(64hex),reviewFlowId,generation,interactionId,decision,remoteSessionId?} | enqueue_task_command{taskCommand:send_prompt{content,attachments?,automationId?}} | promote_task_command{commandId} | cancel_task_command{commandId}`（后两者 `clientMode:"web-remote-replayable"`）；owner 结果错误码 `NO_ACTIVE_TASK_OWNER | STALE_TASK_OWNER_COMMAND | OWNER_COMMAND_FAILED`；事件 `task_snapshot_invalidated | workspace_task_list_invalidated | task_stream_mirror_batch{batchSeq,fromSeq,toSeq,ops[user_message|stream_event + seq],terminal}`；约束 `runId===traceId`、`workspaceKey` 与 identity 回退规则一致。

---

## 5. main 进程装配

- **管理器** `createWebRemoteControlManager`（main/index.js `Hb`）：按 windowId 维护运行时（transport、currentBridge、pendingOutboundPayloads、mobileViewState…）。依赖注入：`getEndpointUrls`（每次 start 时重取 origin → relay/remote URL）、`authProvider`（Node crypto 实现）、`authStorageProvider`（settings+credentialService）、`startupRestoreStorageProvider`（settings `webRemoteControlLastEnabledContext`，用于窗口恢复自动重启）、`featureGate`（**本构建为 `Gb()` 默认启用**；关闭构建传 `false` → "Web remote control is disabled in this build."）、`platformHandlers`（platform-request 的 7 个实现）、`attachWorkspaceHost/release/dispose`（`createWebRemoteControlSharedHostAttachments`）、`reconnectWorkspace`（经 `zcode:web-remote-control-reconnect-workspace` 请求 renderer 执行，120s 超时）、`onStatusChanged`（→ `zcode:web-remote-control-status-changed` 推送）。
- **IPC**（`registerWebRemoteControlIpcHandlers`）：
  - `zcode:start-web-remote-control` / `zcode:reset-web-remote-control-pairing`（invoke；先 `authorizeStart` 再 `startAuthorized`/`resetPairingAuthorized`，遥测 `web_remote_control_start_result` / `web_remote_control_pair_result`）
  - `zcode:stop-web-remote-control`、`zcode:get-web-remote-control-status`
  - renderer→main：`zcode:sync-web-remote-control-workspaces` / `zcode:sync-web-remote-control-tasks`（更新可用列表并触发 `workspace-list-updated` 推送）；main→renderer 事件：`zcode:web-remote-control-status-changed`、`zcode:web-remote-control-reconnect-workspace`（请求-应答）。
  - 状态形状：`{status: starting|connecting|running|active|error|idle, sessionId, windowControlSessionId, mobileConnected, mobileViewState, mobileDeviceInfo, qrUrl, connectUrl, workspacePath, workspaceIdentity, remoteSessionId, initialTaskId, error?, failure?:{reason,message}}`。
- **与 host 的关系**：远控 RPC **不直接进 CLI gateway 进程的端口**——手机帧在 main 终结/重造，字节经 `MessageChannelMain` 转交 host：`hostProcess.postMessage({type:"attach-service-port", requestId:"shared-host-request-N", attachmentId:"shared-host-attachment-N", clientMode:"web-remote-replayable", scope:{kind:"local"}}, [port])`（remote 会话为 `scope:{kind:"remote",...}`，且必须已具备 workspaceIdentity 隔离标识）。host 侧 `ki.attach` → `exposeServicesOnMessagePort`（ChannelServer，deferInit=false，init 超时 1s）挂载服务并把 port 流控转发给 agent 连接。local scope 在 host 本地服务 ready 前会挂起排队。窗口销毁/远程会话关闭时释放 attachment 并向手机发 `workspace-bridge-error`/`app-error`。
- 其他装配细节：WS 入站 >1MB 直接丢弃并 `onRawTransportFault("remote.rpcFrame.envelopeTooLarge")` → 当前桥 markDegraded；手机断连 3s 宽限后才置 `mobileConnected=false`（状态回到 running）；transport 状态机 `idle→connecting→registering?→authenticating→waiting_terminal→paired→(kicked|error)`，`waiting` 时曾配对过则计 stale（15s 恢复定时器/重连）。

---

## 6. 安全边界

- **`allowAnyPeer` 与 `--allow-external-broker-client-local-dev` 不属于 Web Remote Control**：二者用于 CUA（Computer Use）permission-broker helper 的本地 socket/管道对端校验（`verifySocketPeer`，`ZCODE_CUA_PERMISSION_BROKER_*`，另有一并出现的 `--allow-unsigned-launcher-local-dev`）。Web Remote 的信任模型不依赖它们。
- 密钥/令牌存储：
  - passHash：Electron 凭据服务（safeStorage）key `web-remote-control:external-relay:pass_hash`；deviceSid：settings `webRemoteControlExternalRelayDevice.deviceSid`（部分缺失即整体清空）。
  - 启动恢复上下文：settings `webRemoteControlLastEnabledContext {workspacePath, workspaceIdentity?, initialTaskId}`。
  - deviceMid：`<configDir>/telemetry-state.json`。
  - renderer→main 的 start/reset 采用一次性 UUID token（30s、窗口绑定、用后即焚）。
- **QR 即凭据**：`hash` 就是 passHash，任何扫到/截获 QR 者在轮换前都能配对；缓解是 `resetPairing`（`leaked-qr`）轮换 password→passHash 并换发 deviceSid。relay 侧配对互斥（新客户端把旧连接 KICKED，桌面映射为 `session-conflict` 终态）。
- 挑战应答防重放：每次连接 server 发新 `nonce`；MAC 输入绑定 `role|deviceSid`，输出 base64url。
- RPC 面信任边界：进入 bridge 即等同桌面 renderer 的 RPC 权限（同一 ChannelServer 服务集），靠 `clientMode:"web-remote-replayable"` 做行为降档而非权限削减；remote scope 强制 workspaceIdentity 隔离（缺它即拒绝建桥）。
- 关闭开关：`createWebRemoteControlFeatureGate(false)` 时 start/reset 直接抛错，getStatus 返回 `unsupported-action`。

---

## 7. 自托管可行性结论

**结论：可行，但 relay 服务器与手机 Web 客户端都需要自建。** 桌面侧通过 env 即可指到自建端点：
- `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=wss://your.host/ws`（relay WS，最关键——否则自定义 origin 仍会指向官方 zcode.z.ai）
- `ZCODE_WEB_REMOTE_CONTROL_URL=https://your.host/remote/v4`（QR 指向的 Web 客户端基址）
- 或整体换 origin：settings `zcodeEndpointOrigin` / `ZCODE_BASE_URL` / `ZCODE_ENV=test`（影响 API origin 与 `/remote/v4`、`/web-remote/callback`）。
- 桌面应用本体无需改动：feature gate 默认开启，协议实现完整保留在 main 中；共享协议库（schema/QR 解析/proof/组装器/常量/测试向量）就在 CLI 运行时 zcode.cjs 内，可直接作为移植底稿。

### 自建 relay 服务器的最小行为验收清单
1. **端点**：WS 路径 `/ws`；接受 `?mid=<deviceMid>` 查询参数与 `X-Device-ID` 头（可用于识别设备）；permessage-deflate 可选；单条 WS 消息（JSON 文本）≤1MB，超限应拒绝/断开。
2. **设备注册**：收到 `{type:"device_register_init", device_mid, pass_hash, meta, client_ts}` → 分配全局唯一 `device_sid` → 回 `{type:"device_register_ack", device_sid}`。同一 device_mid 重复注册策略自定（官方用 passHash 轮换区分）。
3. **认证**：收到 `{type:"auth_init", role:"device", device_sid, meta, client_ts}` → 生成一次性 `nonce` 回 `{type:"auth_challenge", nonce}` → 校验 `{type:"auth_response", device_sid, proof}`：
   `base64url(HMAC-SHA256(pass_hash, nonce + "|" + role + "|" + device_sid)) == proof`（用官方测试向量做单元测试）。失败回 `{type:"error", code:"AUTH_FAILED", message}`。
4. **手机端配对**：Web 客户端以 QR 的 `sid`(=device_sid)/`hash`(=pass_hash) 发起同构 auth（role 用手机侧字符串，**[未还原]**，需与自建客户端约定）；配对成功后向双方回 `{type:"auth_ack"|"pair_status_ack", pair_status:"matched"}`；无客户端时 `"waiting"`。同一 sid 新客户端接入必须把旧客户端踢掉（旧连接收 `{type:"error",code:"KICKED"}`；桌面收到 KICKED 会重连并最终以 `session-conflict` 终止）。
5. **心跳**：对 `pair_status_query` 回 `pair_status_ack`（30s 内必须有 ack，否则设备端主动重连）；连接层空闲不主动断（≥30s 容忍）。
6. **数据转发**：把 `{type:"data", payload, client_ts}` 原样转发给配对的对端（可补 `server_ts`）；payload 内容（rpc-frame / app JSON）**不解析不修改不排序**，仅按 TCP 顺序透传；未配对时收到的 data 应丢弃或报 `WRONG_PARAM`。内部错误回 `INTERNAL`。
7. **关闭码**（客户端按此映射失败原因）：`4004 session-not-found`、`4009 session-conflict(被踢)`、`4010 desktop-disconnected`、`4011 session-expired`、`4012 workspace-closed`、`4013 invalid-mobile-connection`。会话 TTL 自定（官方 server 侧 TTL **[未还原]**，QR 的 `t` 参数建议用于过期校验）。
8. **不需要实现**：rpc-frame 的 seq/ack/重放/水位（端到端能力，桌面与手机自行处理 8MB/45s 重放、1MB/256KB 流控）；帧内二进制 RPC。
9. **自建 Web 客户端**需实现：QR 参数解析（`sid/hash/t/mid/name/app_version[/theme]`）、同款 auth、JSON 控制面（§4.1 全部消息）、rpc-frame 编解码 + CRC32 + 组装器/重放缓冲（§3）、以及帧内二进制 RPC 客户端（§4.2 的 100/102 与 201/202 序列化）——工作量大头在此，而非 relay。

### 未还原清单
- 手机端在 relay 认证中使用的 role 字符串及其中继细节（仅桌面 `device` 与共享库 `terminal` 有实证）。
- relay 服务器内部：会话 TTL、`t` 参数校验、注册速率限制、`server_ts` 精确行为。
- `x-zcode-rpc-host-capability` 头的取值 schema（属 Server Remote 子系统）。
- zcode-agent v4 网关 hello 中 `protocolVersion` 常量的字面值。
- 各 channel 的逐方法参数 schema（与桌面 renderer 同源，数量过大，未逐一枚举）。

---

## 实施进度（开源版，2026-09 更新）

- ✅ 自建手机 Web 客户端 `apps/web-remote-client`（esbuild 单文件 SPA；配对 → bootstrap → bridge-open → v4 订阅/发送/队列/压缩）
- ✅ 桌面 main 控制面：`webRemoteControlControlPlane.ts`（bootstrap / workspace-bridge-open 应答，桥身份由手机端铸造、设备端采纳）
- ✅ 桌面 main 桥：`webRemoteControlHostBridge.ts`（rpc-frame ↔ MessagePort，AttachServicePort + web-remote-replayable 档）
- ✅ renderer 设置页 QR 卡：`packages/ui/src/settings/WebRemoteControlSection.tsx`（开始/停止/重置配对 + 二维码）
- ✅ 逐方法参数清单：`docs/web-remote-rpc-channel-inventory.md`
- 端到端冒烟通过：静态托管 / 双端认证 / bootstrap / bridge-open / 双向 2.5MB 帧 / 4010 顶替
