// rpc-frame 的 base64 编解码（浏览器/Node 同构）。
// btoa/atob 在 Node 16+ 与浏览器全局可用；Node Buffer 版本已在 sender/receiver 中移除，
// 否则手机 Web bundle 会在运行时崩溃。
const CHUNK = 0x8000;

export function webRemoteBytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

export function webRemoteBase64ToBytes(value: string): Uint8Array {
  // atob 对非法字符严格抛错：与官方 canonical base64 校验语义一致。
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
