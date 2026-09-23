// ============================================================
// Web Remote Control —— 配对凭据的 Node 实现（electron main / 服务端专用）。
// 浏览器端（手机 Web 客户端）不得 import 本模块：node:crypto 进不了浏览器
// bundle；Web 端用 WebCrypto 自行实现同一 proof 算法（对齐官方测试向量）。
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { WebRemotePairingSecret } from "./protocol.js";

export function createPairingSecret(
  randomSource: (size: number) => Buffer = randomBytes,
): WebRemotePairingSecret {
  const password = randomSource(24).toString("base64url");
  return { password, passHash: createHash("sha256").update(password, "utf8").digest("base64") };
}

/**
 * 挑战应答：proof = base64url(HMAC-SHA256(key=passHash ASCII, msg=`${nonce}|${role}|${deviceSid}`))。
 * 官方向量：passHash="dGVzdF9oYXNo", nonce="nonce-1", role="device", deviceSid="device-1"
 *   → proof="XK0m7u-26VS88uk7ISAX5Z_9pjzq8jqyP77N-HkCsPE"。
 */
export function computeRelayAuthProof(params: {
  passHash: string;
  nonce: string;
  role: string;
  deviceSid: string;
}): string {
  return createHmac("sha256", params.passHash)
    .update(`${params.nonce}|${params.role}|${params.deviceSid}`, "utf8")
    .digest("base64url");
}
