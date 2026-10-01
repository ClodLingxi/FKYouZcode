/**
 * 握手密码学：HMAC 握手签名与 Ed25519 私钥解密。
 *
 * 逆向行为（官方 bundle 偏移 845100/845130，SPEC.md §2 与 §3.1）：
 * - 握手签名：key = HKDF(apiKeySecret, "getSignKey_hmac")，
 *   sig = base64(HMAC-SHA256(key, UTF8("get_sign_key\n{apiKeyId}\n{ts}\n{nonce}")))；
 * - 私钥解密：key = HKDF(apiKeySecret, "ed25519_priv") 作 AES-256-GCM key，
 *   raw = base64ToBytes(privateCipher)，iv = raw[0:12]，密文+tag = raw[12:]，
 *   AAD = UTF8(apiKeyId)，tagLength 128；明文按 UTF-8 解码为 PEM 文本后重新取字节，
 *   importKey("pkcs8", …, "Ed25519", extractable=false, ["sign"])。
 * 私钥不在客户端生成、不落盘，仅驻留内存；敏感中间缓冲用后清零。
 */

import {
  CLIENT_SIGNING_CIPHER_IV_BYTES,
  CLIENT_SIGNING_CIPHER_TAG_BITS,
  CLIENT_SIGNING_HANDSHAKE_ACTION,
  CLIENT_SIGNING_KDF_INFO_AES,
  CLIENT_SIGNING_KDF_INFO_HMAC,
} from "./constants.js";
import {
  base64ToBytes,
  bytesToBase64,
  decodeUtf8,
  deriveBytes,
  encodeUtf8,
} from "./crypto-utils.js";

export function buildHandshakeSignatureMessage(input: {
  apiKeyId: string;
  nonce: string;
  ts: string;
}): string {
  return `${CLIENT_SIGNING_HANDSHAKE_ACTION}\n${input.apiKeyId}\n${input.ts}\n${input.nonce}`;
}

export async function createHandshakeSignature(
  apiKeySecret: string,
  message: string,
): Promise<string> {
  const keyBytes = await deriveBytes(apiKeySecret, CLIENT_SIGNING_KDF_INFO_HMAC);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encodeUtf8(message));
  keyBytes.fill(0);
  return bytesToBase64(new Uint8Array(signature));
}

export async function decryptSigningPrivateKey(
  apiKeyId: string,
  apiKeySecret: string,
  privateCipher: string,
): Promise<CryptoKey> {
  const keyBytes = await deriveBytes(apiKeySecret, CLIENT_SIGNING_KDF_INFO_AES);
  try {
    const raw = base64ToBytes(privateCipher);
    if (!raw) {
      throw new Error("privateCipher is not valid base64");
    }
    // GCM tag(16B) 至少存在且仍有密文字节；与官方阈值 12+16 逐字节一致。
    if (raw.byteLength <= CLIENT_SIGNING_CIPHER_IV_BYTES + CLIENT_SIGNING_CIPHER_TAG_BITS / 8) {
      throw new Error("privateCipher is too short");
    }
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt(
      {
        additionalData: encodeUtf8(apiKeyId),
        iv: raw.slice(0, CLIENT_SIGNING_CIPHER_IV_BYTES),
        name: "AES-GCM",
        tagLength: CLIENT_SIGNING_CIPHER_TAG_BITS,
      },
      key,
      raw.slice(CLIENT_SIGNING_CIPHER_IV_BYTES),
    );
    const plainBytes = new Uint8Array(plain);
    try {
      // 明文是 PKCS#8 DER 的 base64 文本（官方 eur=base64ToBytes(TextDecoder.decode(plain))，
      // 服务端契约 pkcs8Ed25519Base64Text），不是带头的 PEM，也不是文本的 UTF-8 字节。
      const der = base64ToBytes(decodeUtf8(plainBytes));
      if (!der) {
        throw new Error("decrypted signing key plaintext is not base64");
      }
      return await crypto.subtle.importKey("pkcs8", der, "Ed25519", false, ["sign"]);
    } finally {
      plainBytes.fill(0);
    }
  } finally {
    keyBytes.fill(0);
  }
}

export async function signClientRequest(privateKey: CryptoKey, message: string): Promise<string> {
  const signature = await crypto.subtle.sign("Ed25519", privateKey, encodeUtf8(message));
  return bytesToBase64(new Uint8Array(signature));
}
