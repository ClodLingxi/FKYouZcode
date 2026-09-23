// 手机端连接层：relay WS（JSON 控制面 + data 信封）→ rpc-frame 可靠传输 →
// ChannelClient 所需的 IMessagePassingProtocol。与桌面设备端完全对称：
// 桥身份（bridgeSessionId）由手机端铸造，经 workspace-bridge-open 下发给设备端采纳。
import {
  Emitter,
  RpcFrameReceiver,
  RpcFrameSender,
  VSBuffer,
  WEB_REMOTE_CLOSE_CODES,
  WEB_REMOTE_HEARTBEAT_ACK_TIMEOUT_MS,
  WEB_REMOTE_HEARTBEAT_INTERVAL_MS,
  WEB_REMOTE_HEARTBEAT_JITTER_MS,
  relayDataEnvelopeSchema,
  relayPairStatusAckSchema,
  relayServerMessageSchema,
  rpcControlEnvelopeSchema,
  rpcFrameAckSchema,
  rpcFrameEnvelopeSchema,
  type IMessagePassingProtocol,
  type RemoteControlRequest,
  type RemoteControlResponse,
} from "./deps.js";
import { webCryptoRelayAuthProof } from "./proto.js";

export interface PairingCredentials {
  deviceSid: string;
  passHash: string;
  deviceName: string;
}

export type ConnectionState = "connecting" | "authenticating" | "ready" | "closed";

export class RelaySession {
  private socket: WebSocket | null = null;
  private state: ConnectionState = "connecting";
  private heartbeatTimer: number | null = null;
  private heartbeatAckedAt = 0;
  private readonly sender: RpcFrameSender;
  private readonly receiver: RpcFrameReceiver;
  private readonly onState = new Emitter<ConnectionState>();
  private pendingRequests = new Map<string, (response: RemoteControlResponse) => void>();

  readonly onStateChange = this.onState.event;

  private readonly protocolEmitter = new Emitter<VSBuffer>();

  /** ChannelClient 挂载的传输端（rpc-frame 重组字节 ↔ VSBuffer）。 */
  readonly protocol: IMessagePassingProtocol = {
    send: (buffer: VSBuffer) => {
      const result = this.sender.send(buffer.buffer);
      if (!result.ok) throw new Error(`rpc-frame outbound dropped: ${result.fault}`);
    },
    onMessage: this.protocolEmitter.event,
  };

  constructor(
    private readonly url: string,
    private readonly credentials: PairingCredentials,
    /** 手机端铸造的共享桥身份：workspace-bridge-open 与 rpc-frame 信封共用。 */
    private readonly bridgeSessionId: string,
  ) {
    this.sender = new RpcFrameSender({ bridgeSessionId, bridgeGeneration: 1 });
    this.receiver = new RpcFrameReceiver({ bridgeSessionId, bridgeGeneration: 1 });
    this.sender.onWire((payload) => this.sendData(payload));
    this.receiver.onWire((ack) => this.sendData(ack));
    this.receiver.onMessage(({ bytes }) => this.protocolEmitter.fire(VSBuffer.wrap(bytes)));
    this.receiver.onFault((fault, detail) => console.warn("[relay] receiver fault", fault, detail));
    this.sender.onFault((fault, messageSeq) =>
      console.warn("[relay] sender fault", fault, messageSeq),
    );
  }

  /** 建连 + auth 挑战应答；resolve 于 auth_ok。 */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      let settled = false;
      socket.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        this.setState("closed");
        reject(new Error("relay connect failed"));
      });
      socket.addEventListener("close", (event) => {
        this.teardown();
        this.setState("closed");
        if (!settled) {
          settled = true;
          reject(new Error(`relay closed before ready code=${event.code}`));
        }
      });
      socket.addEventListener("open", () => {
        this.setState("authenticating");
        this.send({
          type: "auth_init",
          role: "remote",
          device_sid: this.credentials.deviceSid,
          meta: { platform: "web", name: this.credentials.deviceName },
        });
      });
      socket.addEventListener("message", (event) => {
        void this.onMessage(event.data, resolve, reject, () => {
          settled = true;
        });
      });
    });
  }

  private async onMessage(
    raw: unknown,
    authResolve: () => void,
    authReject: (e: Error) => void,
    markSettled: () => void,
  ): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return;
    }
    const message = relayServerMessageSchema.safeParse(parsed);
    if (!message.success) return;
    switch (message.data.type) {
      case "auth_challenge": {
        const proof = await webCryptoRelayAuthProof({
          passHash: this.credentials.passHash,
          nonce: message.data.nonce,
          role: "remote",
          deviceSid: this.credentials.deviceSid,
        });
        this.send({ type: "auth_response", device_sid: this.credentials.deviceSid, proof });
        return;
      }
      case "auth_ok": {
        this.setState("ready");
        this.startHeartbeat();
        markSettled();
        authResolve();
        return;
      }
      case "pair_status_ack": {
        relayPairStatusAckSchema.parse(message.data);
        this.heartbeatAckedAt = Date.now();
        return;
      }
      case "kicked": {
        this.close(WEB_REMOTE_CLOSE_CODES.kicked);
        authReject(new Error("kicked by relay: superseded by another remote"));
        return;
      }
      case "data": {
        const envelope = relayDataEnvelopeSchema.parse(message.data);
        this.onDataPayload(envelope.payload);
        return;
      }
      default:
        return;
    }
  }

  private onDataPayload(payload: unknown): void {
    // 控制面应答（bootstrap/workspace-list/bridge-*：type 以 -response/-ready/-error 结尾）
    // 与 rpc-frame 靠形状判别；先按 request_id 分发，再进帧管线。
    const candidate = payload as { type?: unknown; request_id?: unknown } | null;
    if (
      candidate &&
      typeof candidate === "object" &&
      typeof candidate.type === "string" &&
      (candidate.type.endsWith("-response") ||
        candidate.type.endsWith("-ready") ||
        candidate.type.endsWith("-error")) &&
      typeof candidate.request_id === "string"
    ) {
      const resolver = this.pendingRequests.get(candidate.request_id);
      if (resolver) {
        this.pendingRequests.delete(candidate.request_id);
        resolver(candidate as RemoteControlResponse);
      }
      return;
    }
    if (rpcFrameEnvelopeSchema.safeParse(payload).success) {
      this.receiver.feed(payload);
      return;
    }
    if (rpcFrameAckSchema.safeParse(payload).success) {
      const ack = rpcFrameAckSchema.parse(payload);
      this.sender.acknowledge(ack.ackMessageSeq);
      return;
    }
    if (rpcControlEnvelopeSchema.safeParse(payload).success) {
      const control = rpcControlEnvelopeSchema.parse(payload);
      this.receiver.applyPeerFlowState(control.state);
    }
  }

  // ── 设备控制面（bootstrap / workspace-bridge-open）──

  /** 发送控制面请求并等待设备应答（7s 超时）。 */
  controlRequest(
    request: Extract<
      RemoteControlRequest,
      { type: "bootstrap-request" | "workspace-list-request" | "workspace-bridge-open" }
    >,
  ): Promise<RemoteControlResponse> {
    const timeoutMs = 7_000;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pendingRequests.delete(request.request_id);
        reject(new Error(`control request timeout: ${request.type}`));
      }, timeoutMs);
      this.pendingRequests.set(request.request_id, (response) => {
        window.clearTimeout(timer);
        resolve(response);
      });
      this.send({ ...request, client_ts: Date.now() });
    });
  }

  // ── 内部 ──

  private sendData(payload: unknown): void {
    this.send({ type: "data", payload });
  }

  private send(message: unknown): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.onState.fire(state);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatAckedAt = Date.now();
    const tick = () => {
      if (this.state !== "ready") return;
      if (Date.now() - this.heartbeatAckedAt > WEB_REMOTE_HEARTBEAT_ACK_TIMEOUT_MS) {
        // 心跳看门狗触发：整页重载回到配对页（最简恢复路径）。
        this.close();
        location.reload();
        return;
      }
      this.send({ type: "pair_status_query", device_sid: this.credentials.deviceSid });
      const jitter = Math.floor(Math.random() * WEB_REMOTE_HEARTBEAT_JITTER_MS);
      this.heartbeatTimer = window.setTimeout(tick, WEB_REMOTE_HEARTBEAT_INTERVAL_MS + jitter);
    };
    this.heartbeatTimer = window.setTimeout(tick, WEB_REMOTE_HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) window.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private teardown(): void {
    this.stopHeartbeat();
    this.sender.resetReplay();
  }

  close(code: number = 1000): void {
    this.teardown();
    try {
      this.socket?.close(code, "client closing");
    } catch {
      // already closed
    }
    this.socket = null;
    this.setState("closed");
  }

  get connectionState(): ConnectionState {
    return this.state;
  }
}
