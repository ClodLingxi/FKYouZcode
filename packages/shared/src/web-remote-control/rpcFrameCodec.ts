// ============================================================
// rpc-frame 线上编解码原语（官方 3.14.3 对齐）：CRC-32、帧/ack schema、身份指纹。
// 可靠传输语义见 rpcFrameSender.ts / rpcFrameReceiver.ts。
import { z } from "zod";
import {
  WEB_REMOTE_MAX_FRAGMENTS,
  WEB_REMOTE_MAX_MESSAGE_BYTES,
  WEB_REMOTE_MAX_PHYSICAL_FRAME_BYTES,
} from "./protocol.js";

// ── CRC-32（反射多项式 0xEDB88320，标准 Ethernet 语义） ──

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function crc32Hex(bytes: Uint8Array): string {
  return crc32(bytes).toString(16).padStart(8, "0");
}

// ── 帧与 ack 的线上 schema ──

const bridgeIdSchema = z.string().min(1).max(256);
const bridgeGenerationSchema = z.number().int().nonnegative();
const checksumSchema = z.object({
  algorithm: z.literal("crc32"),
  value: z.string().regex(/^[0-9a-f]{8}$/),
});

export const rpcFrameEnvelopeSchema = z
  .object({
    zcode_type: z.literal("rpc-frame"),
    bridgeSessionId: bridgeIdSchema,
    bridgeGeneration: bridgeGenerationSchema.optional(),
    recoveryId: bridgeIdSchema.optional(),
    seq: z.number().int().nonnegative(),
    messageSeq: z.number().int().nonnegative(),
    fragmentIndex: z.number().int().min(0).max(WEB_REMOTE_MAX_FRAGMENTS - 1),
    fragmentCount: z.number().int().min(1).max(WEB_REMOTE_MAX_FRAGMENTS),
    messageBytes: z.number().int().min(1).max(WEB_REMOTE_MAX_MESSAGE_BYTES),
    checksum: checksumSchema,
    dataBase64: z.string().min(4),
  })
  .strict();

export const rpcFrameAckSchema = z
  .object({
    zcode_type: z.literal("rpc-frame-ack"),
    bridgeSessionId: bridgeIdSchema,
    bridgeGeneration: bridgeGenerationSchema.optional(),
    recoveryId: bridgeIdSchema.optional(),
    /** 累积确认：序号 ≤ ackMessageSeq 的消息全部确认。 */
    ackMessageSeq: z.number().int().nonnegative(),
  })
  .strict();

export const rpcControlEnvelopeSchema = z.object({
  __zcodeRpcControl: z.literal("connection-flow-v1"),
  state: z.enum(["saturated", "drained"]),
});

export type RpcFrameEnvelope = z.infer<typeof rpcFrameEnvelopeSchema>;
export type RpcFrameAck = z.infer<typeof rpcFrameAckSchema>;

/**
 * 单条 WS 消息的帧开销预算：JSON 键 + 信封 + base64 膨胀（4/3）向上取整的余数。
 * 预算按「解码前的二进制分片大小」约束：base64 后 + 512 字节 JSON 包装必须 ≤1MB。
 */
const FRAME_ENVELOPE_OVERHEAD_BYTES = 1024;

/** 每分片二进制负载上限（保证 base64 + JSON 信封 ≤1MB）。 */
export const PER_FRAGMENT_BINARY_PAYLOAD_BYTES = Math.floor(
  (WEB_REMOTE_MAX_PHYSICAL_FRAME_BYTES - FRAME_ENVELOPE_OVERHEAD_BYTES) / 4,
) * 3;

export interface RpcFrameIdentity {
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
}


