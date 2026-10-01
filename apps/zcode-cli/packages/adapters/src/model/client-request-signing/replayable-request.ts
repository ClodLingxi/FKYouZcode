/**
 * 可重放请求构造（逆向官方 `makeReplayableSigningRequest` / `buildSigningRequestInit` /
 * `sanitizeClientSigningHeaders`，bundle 偏移 841887-842060，SPEC.md §3.4）。
 *
 * Request body 是一次性的，而签名 401 重试需要重发同一请求体：先把 body 读成
 * Uint8Array 快照，再用快照重建 init（重试时 body 用 slice() 克隆，防二次消费）。
 */

import { CLIENT_SIGNING_STRIPPED_HEADERS } from "./constants.js";

type SigningFetchInit = RequestInit & { timeoutMs?: number };

export interface ReplayableSigningRequest {
  readonly body?: Uint8Array;
  readonly cache?: RequestCache;
  readonly credentials?: RequestCredentials;
  readonly headers: Headers;
  readonly integrity?: string;
  readonly keepalive?: boolean;
  readonly method: string;
  readonly mode?: RequestMode;
  readonly redirect?: RequestRedirect;
  readonly referrer?: string;
  readonly referrerPolicy?: ReferrerPolicy;
  readonly signal?: AbortSignal | null;
  readonly timeoutMs?: number;
  readonly url: string;
}

/**
 * 每次发送前剥离 7 个签名相关头（含服务端回包标记 X-Client-Sign-Verified），
 * 防伪造 / 防陈旧验证标记随重试回放；剥离后再按需注入新签名头。
 */
export function sanitizeClientSigningHeaders(headers: HeadersInit | undefined): Headers {
  const sanitized = new Headers(headers);
  for (const name of CLIENT_SIGNING_STRIPPED_HEADERS) {
    sanitized.delete(name);
  }
  return sanitized;
}

export async function makeReplayableSigningRequest(
  url: string | URL | RequestInfo,
  init?: SigningFetchInit,
): Promise<ReplayableSigningRequest> {
  const request = new Request(url as RequestInfo, init);
  const method = request.method.toUpperCase();
  const body =
    method === "GET" || method === "HEAD" ? undefined : new Uint8Array(await request.arrayBuffer());
  return {
    ...(body ? { body } : {}),
    cache: request.cache,
    credentials: request.credentials,
    headers: sanitizeClientSigningHeaders(request.headers),
    integrity: request.integrity,
    keepalive: request.keepalive,
    method: request.method,
    mode: request.mode,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    ...(init?.timeoutMs !== undefined ? { timeoutMs: init.timeoutMs } : {}),
    signal: request.signal,
    url: request.url,
  };
}

/** 用新 headers 同构重建 init；body 每次克隆一份（Uint8Array 一次性消费）。 */
export function buildSigningRequestInit(
  replayable: ReplayableSigningRequest,
  headers: Headers,
): SigningFetchInit {
  return {
    ...(replayable.body ? { body: replayable.body.slice() } : {}),
    cache: replayable.cache,
    credentials: replayable.credentials,
    headers,
    integrity: replayable.integrity,
    keepalive: replayable.keepalive,
    method: replayable.method,
    mode: replayable.mode,
    redirect: replayable.redirect,
    referrer: replayable.referrer,
    referrerPolicy: replayable.referrerPolicy,
    signal: replayable.signal ?? undefined,
    ...(replayable.timeoutMs !== undefined ? { timeoutMs: replayable.timeoutMs } : {}),
  };
}
