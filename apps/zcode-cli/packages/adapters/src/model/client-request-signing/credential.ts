/**
 * 签名凭证解析与生效判定（逆向官方 `parseClientSigningCredential` / `requiresClientRequestSigning`，
 * bundle 偏移 841842 / 3711941，SPEC.md §2/§3）。
 *
 * 凭证格式：apiKey = "{apiKeyId}.{apiKeySecret}"，恰好一个 "." 且两侧 trim 非空；
 * 不满足时返回 undefined → invalid-config fail-closed（仅在 gate 已开启才会走到该路径）。
 */

import {
  CLIENT_SIGNING_DOMAIN_WHITELIST,
  CLIENT_SIGNING_ROUTING_DOMAIN_SUFFIXES,
} from "./constants.js";

export interface ClientSigningCredential {
  readonly apiKeyId: string;
  readonly apiKeySecret: string;
  readonly credential: string;
}

export function parseClientSigningCredential(apiKey: string): ClientSigningCredential | undefined {
  // 恰好一个 "."；与官方逐字符一致（不 trim 整体，只 trim 两侧分段）。
  if (apiKey.split(".").length !== 2) return undefined;
  const separatorIndex = apiKey.indexOf(".");
  const apiKeyId = apiKey.slice(0, separatorIndex).trim();
  const apiKeySecret = apiKey.slice(separatorIndex + 1).trim();
  if (!apiKeyId || !apiKeySecret) return undefined;
  return { apiKeyId, apiKeySecret, credential: apiKey };
}

/** 开源侧 access 联合类型的最小投影，避免 adapters 反向依赖 provider 内部实现。 */
export type ClientSigningAccessLike =
  | { readonly type: "api-key" }
  | { readonly type: "zhipu-coding-plan-api-key" }
  | {
      readonly type: "zhipu-account";
      readonly mode?: string;
    };

export function requiresClientRequestSigning(input: {
  access: ClientSigningAccessLike | undefined;
  baseURL: string;
}): boolean {
  const access = input.access;
  if (access?.type === "zhipu-account") {
    if (access.mode === "start-plan" || access.mode === "off-peak") {
      return false;
    }
    if (access.mode === "individual-coding-plan" || access.mode === "team-coding-plan") {
      return true;
    }
  }
  if (access?.type === "zhipu-coding-plan-api-key") {
    return true;
  }
  if (matchesEndpointRoutingDomain(input.baseURL)) {
    return true;
  }
  try {
    return CLIENT_SIGNING_DOMAIN_WHITELIST.has(new URL(input.baseURL).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** endpoint routing 域名族（z.ai / bigmodel.cn 及其子域）命中即视为经平台网关。 */
export function matchesEndpointRoutingDomain(baseURL: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(baseURL).hostname.toLowerCase();
  } catch {
    return false;
  }
  return CLIENT_SIGNING_ROUTING_DOMAIN_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}
