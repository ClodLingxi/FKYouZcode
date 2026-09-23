// Web Remote Control 设备端（main 进程，官方 3.14.3 对齐）。
//
// 拓扑：手机 Web 客户端 ↔ relay ↔ 本服务（role="device"）↔ WebRemoteHostBridge ↔ host。
// - 配对：password=base64url(24B)，passHash=SHA-256(password) 持久化；QR 即 bearer 凭据。
// - relay：每次连接 device_register_init 轮换 device_sid → auth 挑战应答 → pair_status 心跳。
// - data 信封：控制面（bootstrap/workspace 列表/bridge open）+ rpc-frame 帧/ack/流控。
//   桥身份（bridgeSessionId）由手机端铸造下发、HostBridge 采纳（官方语义）。
// - relay 端点用 env 覆盖以支持自建：ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL / ZCODE_WEB_REMOTE_CONTROL_URL。
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  WEB_REMOTE_HEARTBEAT_ACK_TIMEOUT_MS,
  WEB_REMOTE_HEARTBEAT_INTERVAL_MS,
  WEB_REMOTE_HEARTBEAT_JITTER_MS,
  buildPairingQrUrl,
  computeRelayAuthProof,
  createPairingSecret,
  relayClientMessageSchema,
  relayServerMessageSchema,
  type RelayServerMessage,
} from "@zcode/shared";
import { tryHandleControlPayload } from "./webRemoteControlControlPlane.js";
import { WebRemoteHostBridge } from "./webRemoteControlHostBridge.js";
import { loadPairingStore, savePairingStore } from "./webRemoteControlStore.js";

const DEFAULT_REMOTE_URL = "https://zcode.z.ai/remote/v4";
const DEFAULT_RELAY_WS_URL = "wss://zcode.z.ai/ws";

export interface WebRemoteControlServiceOptions {
  /** 持久化目录（app.getPath("userData")）。 */
  userDataDir: string;
  appVersion: string;
  /** 取当前（首个）窗口的 host 子进程；未启动时为 null。 */
  resolveHostChild: () => { postMessage(message: unknown, transfer?: unknown[]): void } | null;
  /** 手机控制面 bootstrap/workspace-list 用的打开中 workspace 清单（main 维护）。 */
  resolveWorkspaces: () => Array<{ workspacePath: string; workspaceIdentity?: string }>;
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

export class WebRemoteControlService {
  private state: WebRemoteControlState = "disabled";
  private socket: WebSocketLike | null = null;
  private pairing: PairingStore | null = null;
  private lastQr: string | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatAckedAt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly bridge: WebRemoteHostBridge;

  constructor(private readonly options: WebRemoteControlServiceOptions) {
    this.pairing = loadPairingStore(options.userDataDir);
    this.bridge = new WebRemoteHostBridge({
      resolveHostChild: options.resolveHostChild,
      sendToRelay: (payload) => this.sendToRelay({ type: "data", payload }),
      log: options.log,
    });
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
    this.bridge.teardown();
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
    return process.env.ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL?.trim() || DEFAULT_RELAY_WS_URL;
  }

  private remoteUrl(): string {
    return process.env.ZCODE_WEB_REMOTE_CONTROL_URL?.trim() || DEFAULT_REMOTE_URL;
  }

  private openRelayConnection(): void {
    const pairing = this.pairing;
    if (!pairing) return;
    this.closeSocket();
    this.state = this.state === "ready" ? "reconnecting" : this.state;
    // 桥身份由手机端 workspace-bridge-open 下发，重连后需重新 adopt。

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
      this.bridge.teardown();
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
        this.bridge.teardown();
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
    // 控制面请求优先于 rpc-frame 判别：两者都是 data 信封里的 JSON，靠 type 字段区分。
    if (
      tryHandleControlPayload(payload, {
        appVersion: this.options.appVersion,
        resolveWorkspaces: this.options.resolveWorkspaces,
        send: (message) => this.sendToRelay(message),
        ensureBridge: (bridgeSessionId) => {
          this.bridge.adopt(bridgeSessionId);
          this.bridge.attachIfNeeded();
        },
      })
    ) {
      return;
    }
    this.bridge.handleFramePayload(payload);
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

  private closeSocket(): void {
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
