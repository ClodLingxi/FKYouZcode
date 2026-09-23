// 浏览器端原语：base64 / base64url / WebCrypto HMAC proof / uuidv7 / 稳定 clientId。
// 与 Node 侧 pairingCryptoNode.ts 的算法逐字节对齐（回归口径 = WEB_REMOTE_AUTH_TEST_VECTOR）。

const textEncoder = new TextEncoder();

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBase64(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return padded + "=".repeat((4 - (padded.length % 4)) % 4);
}

export function utf8ToBase64Url(text: string): string {
  return bytesToBase64Url(textEncoder.encode(text));
}

export function base64UrlToUtf8(value: string): string {
  return new TextDecoder().decode(base64ToBytes(base64UrlToBase64(value)));
}

/** proof = base64url(HMAC-SHA256(key=passHash, msg=`${nonce}|${role}|${deviceSid}`))，与设备端同构。 */
export async function webCryptoRelayAuthProof(params: {
  passHash: string;
  nonce: string;
  role: string;
  deviceSid: string;
}): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(params.passHash),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(`${params.nonce}|${params.role}|${params.deviceSid}`),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

function byteToHex(byte: number): string {
  return byte.toString(16).padStart(2, "0");
}

/** uuid v7（与 shared/src/uuid.ts 同算法：48-bit 时间戳 + 随机位）。 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const ts = BigInt(now);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = Array.from(bytes, byteToHex).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const CLIENT_ID_STORAGE_KEY = "zcode-web-remote-client-id:v1";

/** 客户端实例稳定 clientId（localStorage 持久化；幂等表跨刷新识别重试）。 */
export function getClientId(): string {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(CLIENT_ID_STORAGE_KEY);
  } catch {
    // 隐私模式无 localStorage
  }
  const clientId = stored ?? `client-${uuidv7()}`;
  if (!stored) {
    try {
      localStorage.setItem(CLIENT_ID_STORAGE_KEY, clientId);
    } catch {
      // 同上
    }
  }
  return clientId;
}
