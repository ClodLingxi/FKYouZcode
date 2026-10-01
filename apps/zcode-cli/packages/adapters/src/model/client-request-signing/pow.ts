/**
 * PoW（工作量证明）：difficulty 8 bit，SHA-256。
 *
 * 逆向行为（官方 bundle 偏移 847990-848060，SPEC.md §2）：
 *   seedInput = "{apiKeyId}\n{appId}\n{sessionId}\n{ts}"           // appId = "zcode"
 *   seed      = bytesToHex(SHA-256(seedInput)).slice(0, 32)        // 摘要前 16 字节的 hex
 *   prefix    = randomHex(12)                                       // 24 hex 字符
 *   candidate = prefix + counter.toString(16).padStart(8, "0")      // 恒 24+8=32 hex
 *   解 = SHA-256("{seed}\n{candidate}") 摘要前 8 bit 全零
 *
 * 循环逐次 await digest（与官方一致，便于 AbortSignal 生效），8 bit 平均约 256 次。
 */

import { CLIENT_SIGNING_POW_MAX_COUNTER } from "./constants.js";
import { encodeUtf8, randomHex, sha256 } from "./crypto-utils.js";

export interface ClientRequestProofOfWorkInput {
  readonly apiKeyId: string;
  readonly appId: string;
  readonly powBits: number;
  readonly sessionId: string;
  readonly signal?: AbortSignal;
  readonly ts: string;
}

export function hasLeadingZeroBits(bytes: Uint8Array, bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  const remainderBits = bits % 8;
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  if (remainderBits === 0) return true;
  const mask = (0xff << (8 - remainderBits)) & 0xff;
  return (bytes[fullBytes] & mask) === 0;
}

/** PoW seed：SHA-256 摘要前 16 字节的小写 hex（32 字符）。 */
export async function computeProofOfWorkSeed(input: {
  apiKeyId: string;
  appId: string;
  sessionId: string;
  ts: string;
}): Promise<string> {
  const digest = await sha256(`${input.apiKeyId}\n${input.appId}\n${input.sessionId}\n${input.ts}`);
  return digestToHexSeed(digest);
}

export function digestToHexSeed(digest: Uint8Array): string {
  let hex = "";
  for (let index = 0; index < 16; index += 1) {
    hex += digest[index].toString(16).padStart(2, "0");
  }
  return hex;
}

export async function createClientRequestProofOfWork(
  input: ClientRequestProofOfWorkInput,
): Promise<string> {
  if (!Number.isInteger(input.powBits) || input.powBits < 0 || input.powBits > 32) {
    throw new Error("powBits must be an integer within [0, 32]");
  }
  const seed = await computeProofOfWorkSeed(input);
  const prefix = randomHex(12);
  const seedInputBytesView = encodeUtf8(`${seed}\n`);
  for (let counter = 0; counter <= CLIENT_SIGNING_POW_MAX_COUNTER; counter += 1) {
    input.signal?.throwIfAborted();
    const candidate = `${prefix}${counter.toString(16).padStart(8, "0")}`;
    const digest = await sha256FromParts(seedInputBytesView, encodeUtf8(candidate));
    if (hasLeadingZeroBits(digest, input.powBits)) {
      return candidate;
    }
  }
  throw new Error("Unable to solve client request proof of work");
}

/** 复用 seed 行的字节视图，把 "{seed}\n{candidate}" 拼接压缩为一次 encode。 */
async function sha256FromParts(seedLine: Uint8Array, candidate: Uint8Array): Promise<Uint8Array> {
  const merged = new Uint8Array(seedLine.length + candidate.length);
  merged.set(seedLine, 0);
  merged.set(candidate, seedLine.length);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", merged));
}

/** 供测试与服务端契约对拍：验证 candidate 是否满足难度。 */
export async function verifyClientRequestProofOfWork(input: {
  apiKeyId: string;
  appId: string;
  candidate: string;
  powBits: number;
  sessionId: string;
  ts: string;
}): Promise<boolean> {
  const seed = await computeProofOfWorkSeed(input);
  const digest = await sha256(`${seed}\n${input.candidate}`);
  return hasLeadingZeroBits(digest, input.powBits);
}
