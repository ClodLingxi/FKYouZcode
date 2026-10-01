/**
 * 握手请求执行（逆向官方 `performHandshake`，bundle 偏移 854300-855600，SPEC.md §3.1）。
 *
 * POST {业务 baseURL origin}/api/paas/c1f3a7e2/v2/client：
 * - Authorization = 完整 credential（"id.secret"），body = {apiKey, nonce, sig, ts}；
 * - sig = base64(HMAC-SHA256(HKDF(secret,"getSignKey_hmac"), "get_sign_key\n{id}\n{ts}\n{nonce}"))；
 * - 超时 10s（自带 AbortController），redirect: "manual"。
 * 响应语义：非 200 / JSON 非法 / 缺 privateCipher → handshake-protocol；code===500 →
 * handshake-server；code!==200 → handshake-business（reason 须匹配 HANDSHAKE_[A-Z_]+）；
 * 解密失败 → cryptography。以上均为 failOpenEligible，由 Signer 降级为裸发。
 */

import { CLIENT_SIGNING_HANDSHAKE_TIMEOUT_MS, CLIENT_SIGNING_NONCE_BYTES } from "./constants.js";
import { randomHex } from "./crypto-utils.js";
import type { ClientSigningCredential } from "./credential.js";
import { ClientRequestSigningV4Error } from "./errors.js";
import {
  buildHandshakeSignatureMessage,
  createHandshakeSignature,
  decryptSigningPrivateKey,
} from "./handshake.js";
import { CLIENT_SIGNING_HANDSHAKE_REASON_PATTERN } from "./constants.js";

export interface SigningHandshakeOptions {
  readonly credential: ClientSigningCredential;
  readonly handshakeUrl: string;
  readonly now: () => number;
  readonly transport: typeof globalThis.fetch;
}

export async function performSigningHandshake(
  options: SigningHandshakeOptions,
): Promise<CryptoKey> {
  const ts = String(options.now());
  const nonce = randomHex(CLIENT_SIGNING_NONCE_BYTES);
  const message = buildHandshakeSignatureMessage({
    apiKeyId: options.credential.apiKeyId,
    nonce,
    ts,
  });
  const sig = await createHandshakeSignature(options.credential.apiKeySecret, message);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_SIGNING_HANDSHAKE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await options.transport(options.handshakeUrl, {
      body: JSON.stringify({ apiKey: options.credential.credential, nonce, sig, ts }),
      headers: {
        Authorization: options.credential.credential,
        "Content-Type": "application/json",
      },
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
    });
    return await readHandshakeResponse(response, options.credential);
  } catch (error) {
    if (error instanceof ClientRequestSigningV4Error) throw error;
    throw new ClientRequestSigningV4Error("Signing handshake request failed", {
      failOpenEligible: true,
      kind: isAbortError(error) ? "handshake-timeout" : "handshake-network",
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readHandshakeResponse(
  response: Response,
  credential: ClientSigningCredential,
): Promise<CryptoKey> {
  if (response.status !== 200) {
    throw new ClientRequestSigningV4Error("Signing handshake HTTP status not 200", {
      failOpenEligible: true,
      httpStatus: response.status,
      kind: "handshake-protocol",
    });
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ClientRequestSigningV4Error("Signing handshake response is not JSON", {
      failOpenEligible: true,
      kind: "handshake-protocol",
    });
  }
  const record = asRecord(body);
  const rawCode = record?.code;
  const code = typeof rawCode === "number" || typeof rawCode === "string" ? rawCode : undefined;
  if (code === 500) {
    throw new ClientRequestSigningV4Error("Signing handshake server failure", {
      failOpenEligible: true,
      kind: "handshake-server",
    });
  }
  if (code !== 200) {
    const msg = typeof record?.msg === "string" ? record.msg : undefined;
    throw new ClientRequestSigningV4Error("Signing handshake business failure", {
      businessCode: code,
      failOpenEligible: true,
      kind: "handshake-business",
      reason: msg && CLIENT_SIGNING_HANDSHAKE_REASON_PATTERN.test(msg) ? msg : undefined,
    });
  }
  const privateCipher = asRecord(record?.data)?.privateCipher;
  if (typeof privateCipher !== "string" || privateCipher.length === 0) {
    throw new ClientRequestSigningV4Error("Signing handshake response missing privateCipher", {
      failOpenEligible: true,
      kind: "handshake-protocol",
    });
  }
  try {
    return await decryptSigningPrivateKey(
      credential.apiKeyId,
      credential.apiKeySecret,
      privateCipher,
    );
  } catch {
    // 解密失败按官方语义计入 fail-open（密文损坏/密钥轮转等场景不应断流）。
    throw new ClientRequestSigningV4Error("Signing private cipher decryption failed", {
      failOpenEligible: true,
      kind: "cryptography",
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
