// ============================================================
// rpc-frame 入站端（官方 3.14.3 对齐）：严格顺序、指纹去重、分片组装、CRC 校验、累积 ack。
import { MiniEmitter } from "./emitter.js";
import { webRemoteBase64ToBytes, webRemoteBytesToBase64 } from "./base64.js";
import {
  WEB_REMOTE_ASSEMBLY_TIMEOUT_MS,
  WEB_REMOTE_MAX_PHYSICAL_FRAME_BYTES,
  type WebRemoteRpcFrameFault,
} from "./protocol.js";
import {
  crc32Hex,
  rpcFrameEnvelopeSchema,
  type RpcFrameAck,
  type RpcFrameEnvelope,
  type RpcFrameIdentity,
} from "./rpcFrameCodec.js";

/**
 * 入站端：feed(payload) → 重组完成的消息；自动产出累积 ack 帧（经 onWire）。
 * 严格顺序：messageSeq 必须等于 lastDelivered+1；重复整消息按指纹去重后补 ack（幂等）。
 */
interface ReassemblyState {
  messageSeq: number;
  fragmentCount: number;
  messageBytes: number;
  checksum: string;
  parts: Map<number, Uint8Array>;
  firstFragmentAt: number;
}

/** 双端同构的帧指纹（去重键）：seq/messageSeq/fragmentIndex/长度。 */
function frameFingerprint(frame: RpcFrameEnvelope): string {
  return `${frame.messageSeq}:${frame.fragmentIndex}:${frame.dataBase64.length}`;
}
export class RpcFrameReceiver {
  private readonly emitter = new MiniEmitter();
  private lastDeliveredMessageSeq = -1;
  private reassembly: ReassemblyState | null = null;
  private readonly seenMessageFingerprints = new Map<number, string>();
  private flowState: "saturated" | "drained" = "drained";

  constructor(
    private readonly identity: RpcFrameIdentity,
    private readonly now: () => number = Date.now,
  ) {
    this.emitter.on("error", () => {});
  }

  onMessage(listener: (message: { messageSeq: number; bytes: Uint8Array }) => void): () => void {
    this.emitter.on("message", listener);
    return () => this.emitter.off("message", listener);
  }

  /** 接收端也发 ack；重放场景下对已交付消息补发累积 ack 即幂等。 */
  onWire(listener: (payload: RpcFrameAck) => void): () => void {
    this.emitter.on("wire", listener);
    return () => this.emitter.off("wire", listener);
  }

  onFault(listener: (fault: WebRemoteRpcFrameFault, detail: string) => void): () => void {
    this.emitter.on("fault", listener);
    return () => this.emitter.off("fault", listener);
  }

  get flowControlState(): "saturated" | "drained" {
    return this.flowState;
  }

  /** 上抛对端流控（来自 rpcControlEnvelope）。 */
  applyPeerFlowState(state: "saturated" | "drained"): void {
    if (this.flowState !== state) {
      this.flowState = state;
      this.emitter.emit("peerFlow", state);
    }
  }

  onPeerFlowState(listener: (state: "saturated" | "drained") => void): () => void {
    this.emitter.on("peerFlow", listener);
    return () => this.emitter.off("peerFlow", listener);
  }

  feed(rawFrame: unknown): void {
    const parsed = rpcFrameEnvelopeSchema.safeParse(rawFrame);
    if (!parsed.success) {
      this.emitter.emit("fault", "invalidMetadata", "schema");
      return;
    }
    const frame = parsed.data;
    if (
      frame.bridgeSessionId !== this.identity.bridgeSessionId ||
      (frame.bridgeGeneration !== undefined &&
        this.identity.bridgeGeneration !== undefined &&
        frame.bridgeGeneration !== this.identity.bridgeGeneration)
    ) {
      // 身份不一致非终局：直接忽略（官方语义）。
      this.emitter.emit("fault", "identityMismatch", frame.bridgeSessionId);
      return;
    }
    if (frame.dataBase64.length * 0.75 > WEB_REMOTE_MAX_PHYSICAL_FRAME_BYTES) {
      this.emitter.emit("fault", "envelopeTooLarge", `seq=${frame.seq}`);
      return;
    }
    if (frame.fragmentIndex >= frame.fragmentCount) {
      this.emitter.emit("fault", "fragmentIndexOutOfRange", `seq=${frame.seq}`);
      return;
    }
    const fingerprint = frameFingerprint(frame);
    if (frame.messageSeq <= this.lastDeliveredMessageSeq) {
      // 重放/重复：已在过去交付 → 补发累积 ack（幂等），不算 fault。
      const seen = this.seenMessageFingerprints.get(frame.messageSeq);
      if (seen === undefined || seen === fingerprint) {
        this.emitAck();
      } else {
        this.emitter.emit("fault", "replayedMessage", `messageSeq=${frame.messageSeq}`);
      }
      return;
    }
    if (
      this.reassembly &&
      (this.reassembly.messageSeq !== frame.messageSeq ||
        this.reassembly.fragmentCount !== frame.fragmentCount ||
        this.reassembly.messageBytes !== frame.messageBytes ||
        this.reassembly.checksum !== frame.checksum.value)
    ) {
      // 新消息未完成旧消息 → 乱序 gap，终局。
      this.emitter.emit(
        "fault",
        "messageSeqGap",
        `have=${this.reassembly.messageSeq} got=${frame.messageSeq}`,
      );
      return;
    }
    if (!this.reassembly) {
      if (frame.fragmentIndex !== 0) {
        this.emitter.emit("fault", "messageSeqGap", `first-frame-index=${frame.fragmentIndex}`);
        return;
      }
      this.reassembly = {
        messageSeq: frame.messageSeq,
        fragmentCount: frame.fragmentCount,
        messageBytes: frame.messageBytes,
        checksum: frame.checksum.value,
        parts: new Map(),
        firstFragmentAt: this.now(),
      };
    }
    if (this.reassembly.parts.has(frame.fragmentIndex)) {
      this.emitter.emit("fault", "duplicateFragment", `index=${frame.fragmentIndex}`);
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = webRemoteBase64ToBytes(frame.dataBase64);
      // canonical base64 校验：重编码必须一致（官方语义）。
      if (webRemoteBytesToBase64(bytes) !== frame.dataBase64) {
        this.emitter.emit("fault", "invalidBase64", `index=${frame.fragmentIndex}`);
        return;
      }
    } catch {
      this.emitter.emit("fault", "invalidBase64", `index=${frame.fragmentIndex}`);
      return;
    }
    this.reassembly.parts.set(frame.fragmentIndex, bytes);
    if (this.reassembly.parts.size < this.reassembly.fragmentCount) {
      if (this.now() - this.reassembly.firstFragmentAt > WEB_REMOTE_ASSEMBLY_TIMEOUT_MS) {
        this.emitter.emit("fault", "assemblyTimeout", `messageSeq=${frame.messageSeq}`);
      }
      return;
    }
    this.completeAssembly();
  }

  /** 周期巡检组装超时。返回 fault（如有）。 */
  sweepAssembly(nowMs: number = this.now()): WebRemoteRpcFrameFault | null {
    const state = this.reassembly;
    if (state && nowMs - state.firstFragmentAt > WEB_REMOTE_ASSEMBLY_TIMEOUT_MS) {
      this.emitter.emit("fault", "assemblyTimeout", `messageSeq=${state.messageSeq}`);
      return "assemblyTimeout";
    }
    return null;
  }

  private completeAssembly(): void {
    const state = this.reassembly;
    if (!state) return;
    const total = Array.from({ length: state.fragmentCount }, (_, index) =>
      state.parts.get(index),
    );
    if (total.some((part) => part === undefined)) return;
    const merged = new Uint8Array(state.messageBytes);
    let offset = 0;
    for (const part of total) {
      merged.set(part!, offset);
      offset += part!.length;
    }
    if (offset !== state.messageBytes) {
      this.emitter.emit("fault", "checksumMismatch", `len=${offset}`);
      this.reassembly = null;
      return;
    }
    if (crc32Hex(merged) !== state.checksum) {
      this.emitter.emit("fault", "checksumMismatch", `messageSeq=${state.messageSeq}`);
      this.reassembly = null;
      return;
    }
    this.reassembly = null;
    this.lastDeliveredMessageSeq = state.messageSeq;
    this.seenMessageFingerprints.set(
      state.messageSeq,
      `${state.messageSeq}:0:${state.parts.get(0)!.length}`,
    );
    // 指纹表只保留最近窗口，防无界增长。
    if (this.seenMessageFingerprints.size > 256) {
      const oldest = this.seenMessageFingerprints.keys().next().value;
      if (oldest !== undefined) this.seenMessageFingerprints.delete(oldest);
    }
    this.emitter.emit("message", { messageSeq: state.messageSeq, bytes: merged });
    this.emitAck();
  }

  private emitAck(): void {
    if (this.lastDeliveredMessageSeq < 0) return;
    const ack: RpcFrameAck = {
      zcode_type: "rpc-frame-ack",
      bridgeSessionId: this.identity.bridgeSessionId,
      ...(this.identity.bridgeGeneration === undefined
        ? {}
        : { bridgeGeneration: this.identity.bridgeGeneration }),
      ...(this.identity.recoveryId === undefined ? {} : { recoveryId: this.identity.recoveryId }),
      ackMessageSeq: this.lastDeliveredMessageSeq,
    };
    this.emitter.emit("wire", ack);
  }
}
