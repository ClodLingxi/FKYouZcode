/**
 * Client Request Signing V4 基础编解码与 KDF 工具。
 *
 * 全部走 WebCrypto（Node ≥ 19 原生 `globalThis.crypto`，仓库 Node 24 满足），
 * 与官方闭源实现的算法路径保持一致，避免 Node crypto 与 WebCrypto 语义漂移。
 * 常量见 constants.ts；拼接串格式见 SPEC.md §2。
 */

import { CLIENT_SIGNING_KDF_LENGTH_BITS, CLIENT_SIGNING_KDF_SALT } from "./constants.js";

const BASE64_ALPHABET_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;

// Node 类型下 TextEncoder.encode 返回 Uint8Array<ArrayBufferLike>，而 WebCrypto 的
// BufferSource 需要 ArrayBuffer 视图；encode 总是分配独立 ArrayBuffer，收窄类型安全。
export function encodeUtf8(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>;
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** 标准 base64（含 padding），与 btoa(逐字节 fromCharCode) 等价。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** 校验长度与字母表后还原 base64；非法输入返回 undefined 由调用方决定错误语义。 */
export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (value.length % 4 !== 0 || !BASE64_ALPHABET_PATTERN.test(value)) {
    return undefined;
  }
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

/** 每字节 2 位小写 hex。 */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
/** nBytes 随机数的 hex 表示（长度为 2×nBytes）。 */
export function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/**
 * HKDF-SHA-256：ikm=UTF8(secret)，salt=UTF8(WD_CLIENT_SIGN_KDF_SALT)，info=UTF8(info)，256 bit。
 * 派生握手 HMAC key（info=getSignKey_hmac）与 privateCipher 解密 AES key（info=ed25519_priv）。
 */
export async function deriveBytes(secret: string, info: string): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", encodeUtf8(secret), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      hash: "SHA-256",
      info: encodeUtf8(info),
      name: "HKDF",
      salt: encodeUtf8(CLIENT_SIGNING_KDF_SALT),
    },
    key,
    CLIENT_SIGNING_KDF_LENGTH_BITS,
  );
  return new Uint8Array(bits);
}

export async function sha256(
  input: string | Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const data = typeof input === "string" ? encodeUtf8(input) : input;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}
