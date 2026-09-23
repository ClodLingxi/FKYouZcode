// ============================================================
// rpc-frame 出站端（官方 3.14.3 对齐）：分片、CRC、重放缓冲、累积 ack、流控水位。
import { MiniEmitter } from "./emitter.js";
import { webRemoteBytesToBase64 } from "./base64.js";
import {
  WEB_REMOTE_MAX_FRAGMENTS,
  WEB_REMOTE_MAX_MESSAGE_BYTES,
  WEB_REMOTE_REPLAY_BUFFER_MAX_BYTES,
  WEB_REMOTE_REPLAY_GRACE_MS,
  WEB_REMOTE_SATURATED_BYTES,
  WEB_REMOTE_DRAINED_BYTES,
  type WebRemoteRpcFrameFault,
} from "./protocol.js";
import {
  PER_FRAGMENT_BINARY_PAYLOAD_BYTES,
  crc32Hex,
  type RpcFrameAck,
  type RpcFrameEnvelope,
  type RpcFrameIdentity,
} from "./rpcFrameCodec.js";

/**
 * 出站端：send(bytes) → 帧批次（含重放缓冲 / 累积 ack / 流控水位）。
 * onWire 收到的每个元素都是一条可直发 relay 的 payload（放在 data 信封 payload 位）。
 */
interface PendingBatch {
  messageSeq: number;
  frames: RpcFrameEnvelope[];
  bytes: number;
  queuedAt: number;
}

export class RpcFrameSender {
  private readonly emitter = new MiniEmitter();
  private messageSeq = 0;
  private unackedBytes = 0;
  private saturated = false;
  private pendingByMessageSeq = new Map<number, PendingBatch>();
  private fifo: number[] = [];
  private wireOutstanding = new Map<number, PendingBatch>();
  private flowState: "saturated" | "drained" = "drained";

  constructor(
    private readonly identity: RpcFrameIdentity,
    private readonly now: () => number = Date.now,
  ) {
    this.emitter.on("error", () => {});
  }

  /** 帧就绪回调（payload 直接作为 relay data 信封的 payload 发送）。 */
  onWire(listener: (payload: RpcFrameEnvelope | RpcFrameAck) => void): () => void {
    this.emitter.on("wire", listener);
    return () => this.emitter.off("wire", listener);
  }

  /** 流控边沿（saturated 应上抛为 host 连接 pause；drained 恢复）。 */
  onFlowState(listener: (state: "saturated" | "drained") => void): () => void {
    this.emitter.on("flow", listener);
    return () => this.emitter.off("flow", listener);
  }

  onFault(listener: (fault: WebRemoteRpcFrameFault, messageSeq: number) => void): () => void {
    this.emitter.on("fault", listener);
    return () => this.emitter.off("fault", listener);
  }

  get unacknowledgedBytes(): number {
    return this.unackedBytes;
  }

  get flowControlState(): "saturated" | "drained" {
    return this.flowState;
  }

  /** 把一条逻辑消息切成帧批次并上线；超过重放缓冲预算时拒绝（不产生任何帧）。 */
  send(bytes: Uint8Array): { ok: true } | { ok: false; fault: WebRemoteRpcFrameFault } {
    if (bytes.length < 1 || bytes.length > WEB_REMOTE_MAX_MESSAGE_BYTES) {
      return { ok: false, fault: "messageTooLarge" };
    }
    if (this.unackedBytes + bytes.length > WEB_REMOTE_REPLAY_BUFFER_MAX_BYTES) {
      return { ok: false, fault: "replayBufferExceeded" };
    }
    const messageSeq = this.messageSeq;
    this.messageSeq += 1;
    const perFragmentPayload = PER_FRAGMENT_BINARY_PAYLOAD_BYTES;
    const fragmentCount = Math.max(1, Math.ceil(bytes.length / perFragmentPayload));
    if (fragmentCount > WEB_REMOTE_MAX_FRAGMENTS) {
      return { ok: false, fault: "fragmentLimitExceeded" };
    }
    const checksum = crc32Hex(bytes);
    const frames: RpcFrameEnvelope[] = [];
    for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex += 1) {
      const start = fragmentIndex * perFragmentPayload;
      const slice = bytes.subarray(start, Math.min(start + perFragmentPayload, bytes.length));
      const frame: RpcFrameEnvelope = {
        zcode_type: "rpc-frame",
        bridgeSessionId: this.identity.bridgeSessionId,
        ...(this.identity.bridgeGeneration === undefined
          ? {}
          : { bridgeGeneration: this.identity.bridgeGeneration }),
        ...(this.identity.recoveryId === undefined ? {} : { recoveryId: this.identity.recoveryId }),
        seq: fragmentIndex,
        messageSeq,
        fragmentIndex,
        fragmentCount,
        messageBytes: bytes.length,
        checksum: { algorithm: "crc32", value: checksum },
        dataBase64: webRemoteBytesToBase64(slice),
      };
      frames.push(frame);
    }
    const batch: PendingBatch = {
      messageSeq,
      frames,
      bytes: bytes.length,
      queuedAt: this.now(),
    };
    this.pendingByMessageSeq.set(messageSeq, batch);
    this.fifo.push(messageSeq);
    this.unackedBytes += batch.bytes;
    this.emitFlowIfChanged();
    for (const frame of frames) this.emitter.emit("wire", frame);
    this.wireOutstanding.set(messageSeq, batch);
    return { ok: true };
  }

  /** 对端累积确认：释放 ≤ ackMessageSeq 的批次与水位。 */
  acknowledge(ackMessageSeq: number): void {
    for (const messageSeq of this.fifo.slice()) {
      if (messageSeq > ackMessageSeq) break;
      const batch = this.pendingByMessageSeq.get(messageSeq);
      if (!batch) continue;
      this.pendingByMessageSeq.delete(messageSeq);
      this.wireOutstanding.delete(messageSeq);
      this.fifo.shift();
      this.unackedBytes = Math.max(0, this.unackedBytes - batch.bytes);
    }
    this.emitFlowIfChanged();
  }

  /** 重连（同 bridge 身份）时从未确认批次第 0 帧起重放。 */
  replayUnacknowledged(): void {
    for (const messageSeq of this.fifo) {
      const batch = this.pendingByMessageSeq.get(messageSeq);
      if (!batch) continue;
      for (const frame of batch.frames) this.emitter.emit("wire", frame);
    }
  }

  /** 新 bridge 会话：清空重放缓冲与水位（身份由调用方更新）。 */
  resetReplay(): void {
    this.pendingByMessageSeq.clear();
    this.wireOutstanding.clear();
    this.fifo.length = 0;
    this.unackedBytes = 0;
    this.emitFlowIfChanged();
  }

  /** 周期巡检：最旧未确认批次超过宽限 → terminal fault。返回 fault（如有）。 */
  sweepGrace(nowMs: number = this.now()): WebRemoteRpcFrameFault | null {
    const oldest = this.fifo[0];
    if (oldest !== undefined) {
      const batch = this.pendingByMessageSeq.get(oldest);
      if (batch && nowMs - batch.queuedAt > WEB_REMOTE_REPLAY_GRACE_MS) {
        this.emitter.emit("fault", "replayGraceExceeded", oldest);
        return "replayGraceExceeded";
      }
    }
    return null;
  }

  private emitFlowIfChanged(): void {
    const next: "saturated" | "drained" =
      this.unackedBytes > WEB_REMOTE_SATURATED_BYTES
        ? "saturated"
        : this.unackedBytes <= WEB_REMOTE_DRAINED_BYTES
          ? "drained"
          : this.flowState;
    if (next !== this.flowState) {
      this.flowState = next;
      this.emitter.emit("flow", next);
    }
  }
}

