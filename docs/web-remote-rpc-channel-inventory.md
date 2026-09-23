# Web Remote Control · RPC 通道与参数清单（官方 3.14.3 对齐）

> 手机端（经 `workspace-bridge-open` 打开的 MessagePort 桥）与桌面 host 之间使用与
> renderer↔host 完全相同的 ChannelServer RPC。本文记录自建客户端实际用到的调用面，
> 以及全部可用通道清单，供后续扩展逐项补齐。
>
> 状态标记：✅ = 手机客户端（apps/web-remote-client）已实现；🧩 = 可用、尚未接入手机端。

## 1. 通道全集（host 按 clientMode/scope 暴露）

`file, media-preview, system, terminal, git, git-checkpoint, setting, credential,
cua-permission, cua-pip-session, broadcast, zcode-task, window-controller,
zcode-agent, zcode-session, conversation-share, file-watcher, oauth,
provider-settings, model-selection, provider-provisioning-target, usage-stats,
coding-plan-subscription, client-config, client-scenes, skills, skill-sync,
mcp-sync, plugin-sync, plugins, plugin-management, subagents, commands, hooks,
memory, settings-sync, feedback, prompt-attachment-transfer, off-peak-task,
onboarding-record`

（官方构建另有 `cloud-content, marketing-touch, output-style, bots`，开源版暂缺。）

## 2. zcode-agent 频道 · v4 会话面（手机端核心）

### 2.1 连接握手

| 方法 | 参数 | 返回 | 状态 |
| --- | --- | --- | --- |
| `helloConversationV4` | — | `HelloMessage`（含 `clientMode`、`capabilities`） | ✅ |
| `initializeConversationV4` | `ClientHello {kind:"clientHello", protocolVersion, clientId, clientKind:"web", appVersion, capabilities:{workflowRunDeltas:true}}` | void | ✅ |

### 2.2 订阅与历史

| 方法 | 参数 | 返回 | 状态 |
| --- | --- | --- | --- |
| `subscribeConversationV4` | `{workspacePath, workspaceIdentity?, sessionId, base?:{logEpoch,seq}, visibility?:"foreground"\|"background"}` | `{ack:{subscriptionId, mode:"snapshot"\|"resume", logEpoch, openTiming?}}` | ✅ |
| `unsubscribeConversationV4` | `{workspacePath, subscriptionId}` | void | ✅ |
| `resyncConversationV4` | `{workspacePath, subscriptionId, base:{logEpoch,seq}\|null, forceSnapshot?}` | `V4ConversationResyncResult` | 🧩 |
| `conversationRowsRangeV4` | `{workspacePath, sessionId, beforeRowId?, limit(1..200)}` | `V4ConversationRowsRangeResult` | 🧩 |
| `onDynamicConversationFrame`（事件） | `{workspacePath, workspaceIdentity?}` | `ConversationTopicWireCandidate` 流（complete/fragment，经 TopicWireFrameAssembler 还原为 `ConversationTopicFrame`） | ✅ |

### 2.3 会话与查询

| 方法 | 参数 | 返回 | 状态 |
| --- | --- | --- | --- |
| `listSessions` | `{workspacePath, limit?, includeArchived?}` | `ZCodeSessionInfo[] {sessionId,title,status,updatedAt,...}` | ✅ |
| `createSession` | `{workspacePath, sessionId?, mode?, model?, ...}` | `ZCodeSessionStateSnapshot` | ✅（最小参数） |
| `queryConversationCommandsV4` | `{workspacePath, commands:[{sessionId,commandId}], clock?}` | `CommandsQueryResult` | 🧩 |

### 2.4 命令（sendConversationCommandV4）

参数统一为 `{workspacePath, workspaceIdentity?, envelope: CommandEnvelope}`；
`CommandEnvelope = {commandId(uuidv7), clientId, sessionId, type, payload, issuedAt, baseRevision?, baseLogEpoch?}`。

| type | payload | 说明 | 状态 |
| --- | --- | --- | --- |
| `sendText` | `{text, attachments?, requestedDelivery?: "startNow"\|"queue"\|"guide", heldQueueDisposition?, ...}` | busy 时缺省走队列 admission | ✅ |
| `compact` | `{}` | 手动上下文压缩；运行中拒绝（compactOperationLock），排队中可无限堆叠 | ✅ |
| `deleteQueueItem` | `{queueItemId}` | CAS：必须带 `baseRevision` | ✅ |
| `sendQueuedNow` | `{queueItemId}` | CAS：立即执行队列项 | 🧩 |
| `editQueueItem` | `{queueItemId, newText}` | CAS | 🧩 |
| `reorderQueueItem` | `{queueItemId, beforeQueueItemId\|null}` | CAS | 🧩 |
| `setAutoDrain` | `{autoDrain}` | CAS | 🧩 |
| `stopGeneration` | `{}` | 停止当前轮 | 🧩 |
| `respondPermission` | `{permissionRequestId, optionId, response?}` | 工具授权应答 | 🧩 |
| `respondElicitation` | `{elicitationRequestId, action:"accept"\|"decline"\|"cancel", content?}` | 交互应答 | 🧩 |
| `setModel` / `setMode` / `setThoughtLevel` | 各自 selection 形状 | 会话级切换 | 🧩 |
| `forkAssistant` / `retryTurn` / `editUserQuery` / `applyFileRewind` | `{target: ConversationRowTarget}` | row-target + CAS | 🧩 |
| `setAssistantFeedback` | `{target, feedback:"like"\|"dislike"\|null}` | CAS | 🧩 |
| `startSavedWorkflow` / `resumeWorkflowRun` / `cancelBackgroundWork` | 见 shared/zcode-protocol-v4/command.ts | workflow 面 | 🧩 |

### 2.5 附件与工作流只读面（全部 🧩）

`attachmentBeginV4 / attachmentChunkV4 / attachmentCommitV4 / attachmentAbortV4 /
attachmentReadV4 / attachmentPreviewSourceV4 / conversationAttachmentReadV4 /
conversationAttachmentStatV4 / conversationPlansV4 / conversationFileChangesV4 /
conversationFileRewindPreviewV4 / conversationWorkflowRunsV4 /
conversationWorkflowRunEventsV4 / conversationWorkflowRunArtifactsV4 /
conversationWorkflowRunArtifactDataV4 / conversationWorkflowRunArtifactReadV4 /
conversationWorkflowRunWorkspaceV4 / conversationWorkflowRunNodeResultV4 /
backgroundBashOutputV4 / subscribeSessionsIndexV4 / onDynamicSessionsIndexFrame`

参数形状逐项见 `packages/services/src/zcode-agent/zcodeAgent.ts` 的接口注释。

## 3. 桥接链路（设备端实现，非 RPC）

```
手机 ──relay data 信封──> 桌面 main
  ├─ {type:"bootstrap-request"| "workspace-list-request", request_id}
  │     ← {type:"bootstrap-response"|"workspace-list-response", workspaces:[{workspace_path, kind, label?}], active_workspace_key}
  ├─ {type:"workspace-bridge-open", request_id, workspace_key, bridge_session_id}
  │     ← {type:"workspace-bridge-ready", bridge:{kind:"local"}}
  │       （main 采纳 bridge_session_id 建 RpcFrameSender/Receiver + AttachServicePort）
  └─ rpc-frame 帧/ack/流控（桥身份 = bridge_session_id；端到端，relay 不解析）
```

失败应答：`workspace-bridge-error {request_id, reason:"workspace-closed", error?}`。

## 4. 手机端未携带面（后续按需补）

- 会话列表实时活性：`subscribeSessionsIndexV4` + `onDynamicSessionsIndexFrame`
- 历史翻页：`conversationRowsRangeV4`（MVP 只渲染快照窗口）
- 授权/交互：`respondPermission` / `respondElicitation`（pendingInteractions 已随快照下发）
- 附件上传/预览、workflow 只读面、sessions-index 抽屉
