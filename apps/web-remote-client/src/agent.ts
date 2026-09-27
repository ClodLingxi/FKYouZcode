// zcode-agent 频道封装 + 会话投影：hello/握手、订阅、命令、快照累积。
// 与桌面 renderer 的 agentConversationTransport 同源语义，只保留手机面需要的子集。
import {
  applyConversationDeltas,
  conversationTopicFrameSchema,
  helloMessageSchema,
  TopicWireFrameAssembler,
  V4_WIRE_PROTOCOL_VERSION,
  type ClientHello,
  type CommandAck,
  type CommandEnvelope,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type HelloMessage,
  type V4ConversationRowsRangeParams,
  type V4ConversationRowsRangeResult,
  type V4ConversationSubscribeResult,
} from "./deps.js";
import { ChannelClient, type Event } from "./deps.js";
import { getClientId, uuidv7 } from "./proto.js";

export const AGENT_CHANNEL = "zcode-agent";

/** 启动期 RPC 的兜底超时：host 假死时给出错误而不是永远挂起（聊天期的命令有各自的告警路径）。 */
const BOOT_CALL_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${label} timeout`)), BOOT_CALL_TIMEOUT_MS);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 会话列表行的手机端最小视图（服务端形状是 strict schema 的超集）。 */
export interface SessionInfoLike {
  sessionId: string;
  title: string;
  status: string;
  updatedAt: number;
}

type AgentChannel = {
  call(command: string, arg?: unknown): Promise<unknown>;
  listen(event: string, arg?: unknown): Event<unknown>;
};

export interface WorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

export class AgentClient {
  private readonly channel: AgentChannel;
  private helloPromise: Promise<HelloMessage> | null = null;

  constructor(client: ChannelClient) {
    this.channel = client.getChannel(AGENT_CHANNEL) as AgentChannel;
  }

  /** hello + clientHello 握手（连接级一次，多订阅共享）。 */
  ensureHandshake(): Promise<HelloMessage> {
    if (this.helloPromise) return this.helloPromise;
    this.helloPromise = (async () => {
      const hello = helloMessageSchema.parse(
        await withTimeout(this.channel.call("helloConversationV4"), "helloConversationV4"),
      );
      const clientHello: ClientHello = {
        kind: "clientHello",
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        clientId: getClientId(),
        clientKind: "web",
        appVersion: "web-remote-client",
        capabilities: { workflowRunDeltas: true },
      };
      await withTimeout(
        this.channel.call("initializeConversationV4", clientHello),
        "initializeConversationV4",
      );
      return hello;
    })();
    this.helloPromise.catch(() => {
      this.helloPromise = null;
    });
    return this.helloPromise;
  }

  subscribe(params: {
    sessionId: string;
    base?: { logEpoch: string; seq: number };
    visibility?: "foreground" | "background";
  } & WorkspaceTarget): Promise<V4ConversationSubscribeResult> {
    return withTimeout(
      this.channel.call("subscribeConversationV4", params),
      "subscribeConversationV4",
    ) as Promise<V4ConversationSubscribeResult>;
  }

  unsubscribe(params: { subscriptionId: string } & WorkspaceTarget): Promise<void> {
    return this.channel.call("unsubscribeConversationV4", params) as Promise<void>;
  }

  resync(params: {
    subscriptionId: string;
    base: { logEpoch: string; seq: number } | null;
    forceSnapshot?: boolean;
  } & WorkspaceTarget): Promise<unknown> {
    return this.channel.call("resyncConversationV4", params);
  }

  rowsRange(
    params: V4ConversationRowsRangeParams & WorkspaceTarget,
  ): Promise<V4ConversationRowsRangeResult> {
    return this.channel.call("conversationRowsRangeV4", params) as Promise<V4ConversationRowsRangeResult>;
  }

  listSessions(
    params: { limit?: number; includeArchived?: boolean } & WorkspaceTarget,
  ): Promise<SessionInfoLike[]> {
    return withTimeout(this.channel.call("listSessions", params), "listSessions") as Promise<
      SessionInfoLike[]
    >;
  }

  createSession(
    params: WorkspaceTarget & { title?: string },
  ): Promise<{ sessionId: string }> {
    return this.channel.call("createSession", params) as Promise<{ sessionId: string }>;
  }

  sendCommand(params: { envelope: CommandEnvelope } & WorkspaceTarget): Promise<CommandAck> {
    return this.channel.call("sendConversationCommandV4", params) as Promise<CommandAck>;
  }

  /** workspace 级下行帧流（v4/conversation/frame），按 topic 自行路由。 */
  onConversationFrame(workspace: WorkspaceTarget, listener: (frame: ConversationTopicFrame) => void): () => void {
    const event = this.channel.listen("onDynamicConversationFrame", workspace);
    const assembler = new TopicWireFrameAssembler<ConversationTopicFrame>(
      conversationTopicFrameSchema,
    );
    const disposable = event((wire: unknown) => {
      for (const assembly of assembler.accept(wire as never)) {
        if (assembly.kind === "complete") listener(assembly.frame);
      }
    });
    return () => disposable.dispose();
  }
}

// ── 命令信封工厂（与 renderer commandFactory 同构） ──

export function createCommandEnvelope<T extends CommandType>(
  sessionId: string | null,
  type: T,
  payload: unknown,
  base?: { baseRevision?: number; baseLogEpoch?: string },
): CommandEnvelope {
  return {
    commandId: uuidv7(),
    clientId: getClientId(),
    sessionId,
    ...(base?.baseRevision !== undefined ? { baseRevision: base.baseRevision } : {}),
    ...(base?.baseLogEpoch ? { baseLogEpoch: base.baseLogEpoch } : {}),
    type,
    payload,
    issuedAt: Date.now(),
  };
}

type CommandType = CommandEnvelope["type"];

// ── 会话投影（快照 + 增量累积） ──

export class ConversationProjection {
  snapshot: ConversationSnapshot | null = null;
  subscriptionId: string | null = null;
  waterMark: { logEpoch: string; seq: number } | null = null;

  accept(frame: ConversationTopicFrame): void {
    if (frame.payload.kind === "snapshot") {
      this.snapshot = frame.payload.snapshot;
    } else if (this.snapshot) {
      this.snapshot = applyConversationDeltas(this.snapshot, frame.payload.deltas);
    }
    this.waterMark = { logEpoch: this.snapshot?.logEpoch ?? "", seq: frame.toSeq };
  }
}
