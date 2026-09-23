// Web Remote Control 设备端（main 进程，官方 3.14.3 对齐）。
//
// 拓扑：手机 Web 客户端 ↔ relay ↔ 本服务（role="device"）↔ MessagePort ↔ host ChannelServer。
// - 配对：password=base64url(24B)，passHash=SHA-256(password) 持久化；QR 即 bearer 凭据。
// - relay：每次连接 device_register_init 轮换 device_sid → auth 挑战应答 → pair_status 心跳。
// - rpc-frame：shared 的 RpcFrameSender/Receiver 承载可靠传输；本服务只把重组后的
//   字节原样写入 host MessagePort（协议与 renderer↔host 完全一致，含流控 sideband）。
// - relay 端点用 env 覆盖以支持自建：ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL / ZCODE_WEB_REMOTE_CONTROL_URL。
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { MessageChannelMain, type MessagePortMain } from "electron";
import { HostMessageTypes } from "@zcode/shared";
import {
  RpcFrameReceiver,
  RpcFrameSender,
  WEB_REMOTE_HEARTBEAT_ACK_TIMEOUT_MS,
  WEB_REMOTE_HEARTBEAT_INTERVAL_MS,
  WEB_REMOTE_HEARTBEAT_JITTER_MS,
  computeRelayAuthProof,
  createPairingSecret,
  buildPairingQrUrl,
  relayClientMessageSchema,
  relayServerMessageSchema,
  rpcControlEnvelopeSchema,
  rpcFrameAckSchema,
  rpcFrameEnvelopeSchema,
  type RelayServerMessage,
} from "@zcode/shared";
import { MessagePortProtocol } from "@zcode/rpc";
import { wrapElectronPort } from "../host/electronPort.js";
import { loadPairingStore, savePairingStore, type PairingStore } from "./webRemoteControlStore.js";

const DEFAULT_REMOTE_URL = "https://zcode.z.ai/remote/v4";
const DEFAULT_RELAY_WS_URL = "wss://zcode.z.ai/ws";

export interface WebRemoteControlServiceOptions {
  /** 持久化目录（app.getPath("userData")）。 */
  userDataDir: string;
  appVersion: string;
  /** 取当前（首个）窗口的 host 子进程；未启动时为 null。 */
  resolveHostChild: () => { postMessage(message: unknown, transfer?: unknown[]): void } | null;
  log: (message: string, error?: unknown) => void;
  /** Electron WebSocket 全局（main 进程）。 */
  createWebSocket: (url: string) => WebSocketLike;
}

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: unknown): void;
}

export type WebRemoteControlState =
  | "disabled"
  | "pairing"
  | "connecting"
  | "ready"
  | "reconnecting";

interface PairingStore {
  deviceMid: string;
  deviceSid: string | null;
  passHash: string;
}

const HOST_FLOW_TO_PHONE: Record<string, "saturated" | "drained"> = {
  saturated: "saturated",
  drained: "drained",
};

export class WebRemoteControlService {
  private state: WebRemoteControlState = "disabled";
  private socket: WebSocketLike | null = null;
  private pairing: PairingStore | null = null;
  private lastQr: string | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatAckedAt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private bridgeSessionId = randomUUID();
  private bridgeGeneration = 0;
  private sender: RpcFrameSender | null = null;
  private receiver: RpcFrameReceiver | null = null;
  private hostPort: MessagePortMain | null = null;
  private hostProtocol: MessagePortProtocol | null = null;
  private disposers: Array<() => void> = [];

  constructor(private readonly options: WebRemoteControlServiceOptions) {
    this.pairing = loadPairingStore(options.userDataDir);
  }

  getState(): WebRemoteControlState {
    return this.state;
  }

  /** 当前配对二维码（未配对/未 ready 时为 null）。 */
  getQrUrl(): string | null {
    return this.lastQr;
  }

  /** 开启远控：无凭据则生成，连 relay 注册并轮换 device_sid。 */
  start(): void {
    if (this.state === "ready" || this.state === "connecting" || this.state === "pairing") return;
    if (!this.pairing) {
      const secret = createPairingSecret();
      this.pairing = {
        deviceMid: randomUUID(),
        deviceSid: null,
        passHash: secret.passHash,
      };
      savePairingStore(this.options.userDataDir, this.pairing);
    }
    this.state = "pairing";
    this.openRelayConnection();
  }

  stop(): void {
    this.teardownBridge();
    this.closeSocket();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.state = "disabled";
  }

  /** 重置配对：轮换 passHash（QR 即凭据，泄露后的唯一处置）。 */
  resetPairing(): void {
    const wasEnabled = this.state !== "disabled";
    this.stop();
    const secret = createPairingSecret();
    this.pairing = { deviceMid: randomUUID(), deviceSid: null, passHash: secret.passHash };
    savePairingStore(this.options.userDataDir, this.pairing);
    this.lastQr = null;
    if (wasEnabled) this.start();
  }

  // ── relay 连接与认证 ──

  private relayWsUrl(): string {
    return (
      process.env.ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL?.trim() || DEFAULT_RELAY_WS_URL
    );
  }

  private remoteUrl(): string {
    return process.env.ZCODE_WEB_REMOTE_CONTROL_URL?.trim() || DEFAULT_REMOTE_URL;
  }

  private openRelayConnection(): void {
    const pairing = this.pairing;
    if (!pairing) return;
    this.closeSocket();
    this.state = this.state === "ready" ? "reconnecting" : this.state;
    this.bridgeGeneration += 1;
    this.bridgeSessionId = randomUUID();
    this.sender = new RpcFrameSender({
      bridgeSessionId: this.bridgeSessionId,
      bridgeGeneration: this.bridgeGeneration,
    });
    this.receiver = new RpcFrameReceiver({
      bridgeSessionId: this.bridgeSessionId,
      bridgeGeneration: this.bridgeGeneration,
    });
    const disposers: Array<() => void> = [];
    this.disposers = disposers;
    disposers.push(
      this.sender.onWire((payload) => this.sendToRelay({ type: "data", payload })),
    );
    disposers.push(
      this.receiver.onWire((ack) => this.sendToRelay({ type: "data", payload: ack })),
    );
    disposers.push(
      this.sender.onFault((fault, messageSeq) =>
        this.options.log(`web-remote sender fault ${fault} messageSeq=${messageSeq}`),
      ),
    );
    disposers.push(
      this.receiver.onFault((fault, detail) =>
        this.options.log(`web-remote receiver fault ${fault} ${detail}`),
      ),
    );
    // 手机端流控 → host（MessagePort sideband）；host 流控 → 手机端。
    disposers.push(
      this.receiver.onPeerFlowState((state) => this.hostProtocol?.sendFlowState(state)),
    );

    const socket = this.options.createWebSocket(this.relayWsUrl());
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (!this.pairing) return;
      this.sendToRelay({
        type: "device_register_init",
        device_mid: this.pairing.deviceMid,
        pass_hash: this.pairing.passHash,
        meta: { platform: process.platform, version: this.options.appVersion },
      });
    });
    socket.addEventListener("message", (event) => this.onRelayMessage(event.data));
    socket.addEventListener("close", (event) => {
      this.options.log(`web-remote relay closed code=${event.code}`);
      this.teardownBridge();
      if (this.state !== "disabled") {
        this.state = "reconnecting";
        this.scheduleReconnect();
      }
    });
    socket.addEventListener("error", (error) => {
      this.options.log("web-remote relay socket error", error);
    });
  }

  private onRelayMessage(raw: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return;
    }
    const message = relayServerMessageSchema.safeParse(parsed);
    if (!message.success) return;
    this.handleRelayMessage(message.data);
  }

  private handleRelayMessage(message: RelayServerMessage): void {
    const pairing = this.pairing;
    if (!pairing) return;
    switch (message.type) {
      case "device_register_ack": {
        pairing.deviceSid = message.device_sid;
        savePairingStore(this.options.userDataDir, pairing);
        this.sendToRelay({
          type: "auth_init",
          role: "device",
          device_sid: message.device_sid,
          meta: { platform: process.platform, version: this.options.appVersion },
        });
        this.state = "connecting";
        return;
      }
      case "auth_challenge": {
        if (!pairing.deviceSid) return;
        this.sendToRelay({
          type: "auth_response",
          device_sid: pairing.deviceSid,
          proof: computeRelayAuthProof({
            passHash: pairing.passHash,
            nonce: message.nonce,
            role: "device",
            deviceSid: pairing.deviceSid,
          }),
        });
        return;
      }
      case "auth_ok": {
        this.state = "ready";
        this.lastQr = buildPairingQrUrl({
          remoteUrl: this.remoteUrl(),
          deviceSid: pairing.deviceSid ?? "",
          passHash: pairing.passHash,
          deviceMid: pairing.deviceMid,
          deviceName: hostnameSafe(),
          appVersion: this.options.appVersion,
        });
        this.attachHostBridgeIfNeeded();
        this.startHeartbeat();
        this.options.log("web-remote relay ready");
        return;
      }
      case "pair_status_ack": {
        this.heartbeatAckedAt = Date.now();
        return;
      }
      case "kicked": {
        this.options.log("web-remote kicked by relay");
        this.teardownBridge();
        this.state = "reconnecting";
        this.scheduleReconnect();
        return;
      }
      case "data": {
        this.handleDataPayload(message.payload);
        return;
      }
    }
  }

  private handleDataPayload(payload: unknown): void {
    if (rpcFrameEnvelopeSchema.safeParse(payload).success) {
      this.receiver?.feed(payload);
      return;
    }
    if (rpcFrameAckSchema.safeParse(payload).success) {
      const ack = rpcFrameAckSchema.parse(payload);
      this.sender?.acknowledge(ack.ackMessageSeq);
      return;
    }
    if (rpcControlEnvelopeSchema.safeParse(payload).success) {
      const control = rpcControlEnvelopeSchema.parse(payload);
      this.receiver?.applyPeerFlowState(control.state);
    }
  }

  private sendToRelay(message: unknown): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return;
    const parsed = relayClientMessageSchema.safeParse(message);
    if (!parsed.success) {
      this.options.log("web-remote outbound relay message rejected by schema");
      return;
    }
    socket.send(JSON.stringify(parsed.data));
  }

  // ── 心跳（pair_status_query，10s±2s 抖动；30s 无 ack 重连） ──

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatAckedAt = Date.now();
    const tick = () => {
      const pairing = this.pairing;
      if (!pairing?.deviceSid || this.state !== "ready") return;
      if (Date.now() - this.heartbeatAckedAt > WEB_REMOTE_HEARTBEAT_ACK_TIMEOUT_MS) {
        this.options.log("web-remote heartbeat watchdog fired; reconnecting");
        this.closeSocket();
        this.state = "reconnecting";
        this.scheduleReconnect();
        return;
      }
      this.sendToRelay({ type: "pair_status_query", device_sid: pairing.deviceSid });
      const jitter = Math.floor(Math.random() * WEB_REMOTE_HEARTBEAT_JITTER_MS);
      this.heartbeatTimer = setTimeout(tick, WEB_REMOTE_HEARTBEAT_INTERVAL_MS + jitter);
    };
    this.heartbeatTimer = setTimeout(tick, WEB_REMOTE_HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.state === "reconnecting") this.openRelayConnection();
    }, 3_000);
  }

  // ── host 桥（AttachServicePort + rpc-frame ↔ MessagePort 双向搬运） ──

  private attachHostBridgeIfNeeded(): void {
    if (this.hostPort && this.hostProtocol) return;
    const child = this.options.resolveHostChild();
    if (!child) {
      this.options.log("web-remote host bridge unavailable: no host process yet");
      return;
    }
    const { port1, port2 } = new MessageChannelMain();
    child.postMessage(
      {
        type: HostMessageTypes.AttachServicePort,
        requestId: randomUUID(),
        attachmentId: randomUUID(),
        // web-remote-replayable：手机链路使用可重放交付档（与官方一致）。
        clientMode: "web-remote-replayable",
        scope: { kind: "local" },
      },
      [port2],
    );
    this.hostPort = port1;
    const protocol = new MessagePortProtocol(wrapElectronPort(port1));
    this.hostProtocol = protocol;
    // host → 手机：MessagePort 原始字节进入可靠传输出站端。
    this.disposers.push(
      protocol.onMessage((buffer) => {
        const result = this.sender?.send(buffer.buffer);
        if (result && !result.ok) {
          this.options.log(`web-remote outbound dropped: ${result.fault}`);
        }
      }),
    );
    // host 侧流控边沿 → 手机（control envelope 透传）。
    this.disposers.push(
      protocol.onFlowState((state) => {
        const mapped = HOST_FLOW_TO_PHONE[state];
        if (mapped) this.sendToRelay({ type: "data", payload: { __zcodeRpcControl: "connection-flow-v1", state: mapped } });
      }),
    );
    // 手机 → host：重组后的字节按 MessagePort 线上格式（裸 Uint8Array）写入。
    this.disposers.push(
      this.receiver?.onMessage(({ bytes }) => {
        // 拷出独立 ArrayBuffer：postMessage 转移/序列化不得共享 rpc-frame 底层缓冲。
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        port1.postMessage(copy);
      }) ?? (() => {}),
    );
    port1.once("close", () => {
      this.hostPort = null;
      this.hostProtocol = null;
    });
  }

  private teardownBridge(): void {
    this.stopHeartbeat();
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.sender = null;
    this.receiver = null;
    try {
      this.hostProtocol?.disconnect();
    } catch (error) {
      this.options.log("web-remote host protocol dispose failed", error);
    }
    this.hostProtocol = null;
    try {
      this.hostPort?.close();
    } catch {
      // 已关闭
    }
    this.hostPort = null;
  }

  private closeSocket(): void {
    this.teardownBridge();
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      socket.close(1000, "client closing");
    } catch {
      // already closed
    }
  }
}

function hostnameSafe(): string {
  try {
    return hostname() || "desktop";
  } catch {
    return "desktop";
  }
}
