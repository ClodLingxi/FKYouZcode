/**
 * 401 验签拒绝判定（逆向官方 `readRefreshableClientSignatureReason`，bundle 偏移 842540，
 * SPEC.md §3.5）：HTTP 401 时读 [msg, reason, data.reason, error.reason, error.message]，
 * 命中 VERIFY_SIGNATURE_INVALID / VERIFY_APIKEY_EXPIRED 即返回该 reason ——
 * 两者都触发「重新握手 + 重试一次」路径。
 */

import { CLIENT_SIGNING_REFRESH_REASONS } from "./constants.js";

export async function readRefreshableClientSignatureReason(
  response: Response,
): Promise<string | undefined> {
  if (response.status !== 401) return undefined;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return undefined;
  }
  const record = asRecord(body);
  if (!record) return undefined;
  const errorRecord = asRecord(record.error);
  const candidates = [
    record.msg,
    record.reason,
    asRecord(record.data)?.reason,
    errorRecord?.reason,
    errorRecord?.message,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && CLIENT_SIGNING_REFRESH_REASONS.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
