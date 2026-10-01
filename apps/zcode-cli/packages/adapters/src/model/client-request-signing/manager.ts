/**
 * Client Request Signing V4 Manager 与 App 级状态（逆向官方 `ClientRequestSigningV4Manager`
 * / `AiSdkClientRequestSigningState`，SPEC.md §5）。
 *
 * - Manager：按 providerId 缓存 Signer；apiKey / baseURL / clientVersion / transport
 *   任一变化即 dispose 重建；引用计数延迟 dispose（请求进行中不销毁）。
 * - State：App 装配期创建一份（bootstrap 传入），持有 keyCache 与按
 *   `apiKey × scopeKey(configUrl + 排序 headers + network)` 去重的 gate 实例，
 *   gate 的 transport 复用 provider proxy fetch（含代理与 CA 证书配置）。
 */

import type { Logger } from "@zcode/contracts";
import { CodingPlanSignatureFeatureGate } from "./feature-gate.js";
import { ClientRequestSigningV4KeyCache } from "./key-cache.js";
import type { ClientSigningObserver } from "./observations.js";
import { ClientRequestSigningV4Signer } from "./signer.js";

type SigningFetch = typeof globalThis.fetch;

export interface AiSdkClientRequestSigningStateOptions {
  readonly configUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly logger?: Logger;
  readonly network?: { caCertFile?: string; httpProxy?: string; noProxy?: string };
  /** gate 与握手的出口（provider proxy fetch）；不同 network 配置应使用不同 state。 */
  readonly proxyTransport: SigningFetch;
}

export class AiSdkClientRequestSigningState {
  readonly keyCache = new ClientRequestSigningV4KeyCache();
  readonly #gates = new Map<string, CodingPlanSignatureFeatureGate>();
  readonly #options: AiSdkClientRequestSigningStateOptions;
  readonly #scopeKey: string;

  constructor(options: AiSdkClientRequestSigningStateOptions) {
    this.#options = options;
    this.#scopeKey = buildGateScopeKey(options);
  }

  resolveGate(apiKey: string): CodingPlanSignatureFeatureGate {
    const key = `${apiKey}\u0000${this.#scopeKey}`;
    const existing = this.#gates.get(key);
    if (existing) return existing;
    const gate = new CodingPlanSignatureFeatureGate({
      apiKey,
      configUrl: this.#options.configUrl,
      ...(this.#options.headers ? { headers: this.#options.headers } : {}),
      ...(this.#options.logger ? { logger: this.#options.logger } : {}),
      transport: this.#options.proxyTransport,
    });
    this.#gates.set(key, gate);
    return gate;
  }

  dispose(): void {
    for (const gate of this.#gates.values()) gate.dispose();
    this.#gates.clear();
    this.keyCache.dispose();
  }
}

function buildGateScopeKey(options: AiSdkClientRequestSigningStateOptions): string {
  const headers: Record<string, string> = {};
  for (const name of Object.keys(options.headers ?? {}).sort()) {
    headers[name] = (options.headers ?? {})[name];
  }
  return JSON.stringify({
    configUrl: options.configUrl,
    headers,
    network: {
      caCertFile: options.network?.caCertFile,
      httpProxy: options.network?.httpProxy,
      noProxy: options.network?.noProxy,
    },
  });
}

export interface ClientRequestSigningV4ManagerCreateFetchInput {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly clientVersion?: string;
  readonly gate: CodingPlanSignatureFeatureGate;
  readonly keyCache: ClientRequestSigningV4KeyCache;
  readonly observe: ClientSigningObserver;
  readonly providerId: string;
  readonly transport: SigningFetch;
}

interface CachedSigner {
  readonly fetch: SigningFetch;
  readonly identity: string;
  readonly signer: ClientRequestSigningV4Signer;
}

export class ClientRequestSigningV4Manager {
  readonly #keyCacheRef: ClientRequestSigningV4KeyCache;
  #cachedByProviderId = new Map<string, CachedSigner>();

  constructor(keyCache: ClientRequestSigningV4KeyCache) {
    this.#keyCacheRef = keyCache;
  }

  createFetch(input: ClientRequestSigningV4ManagerCreateFetchInput): SigningFetch {
    const identity = buildSignerIdentity(input);
    const current = this.#cachedByProviderId.get(input.providerId);
    if (current && current.identity === identity) {
      return current.fetch;
    }
    if (current) {
      this.disposeSigner(current.signer);
    }
    const signer = new ClientRequestSigningV4Signer({
      apiKey: input.apiKey,
      baseURL: input.baseURL,
      ...(input.clientVersion ? { clientVersion: input.clientVersion } : {}),
      gate: input.gate,
      keyCache: this.#keyCacheRef,
      observe: input.observe,
      providerId: input.providerId,
      transport: input.transport,
    });
    const fetch: SigningFetch = (requestInput, init) => signer.request(requestInput, init);
    this.#cachedByProviderId.set(input.providerId, { fetch, identity, signer });
    return fetch;
  }

  dispose(providerId?: string): void {
    if (providerId === undefined) {
      for (const cached of this.#cachedByProviderId.values()) {
        this.disposeSigner(cached.signer);
      }
      this.#cachedByProviderId.clear();
      return;
    }
    const cached = this.#cachedByProviderId.get(providerId);
    if (cached) {
      this.disposeSigner(cached.signer);
      this.#cachedByProviderId.delete(providerId);
    }
  }

  /**
   * dispose 只作废 Signer 身份（新请求改走新 Signer）并 epoch++ 作废共享 keyState；
   * 已 beginRequest 的在飞请求不受影响（assertUsable 与 beginRequest 之间无 yield 点），
   * 其握手结果会因 epoch 变化被放弃，不会写回缓存。
   */
  private disposeSigner(signer: ClientRequestSigningV4Signer): void {
    signer.dispose();
  }
}

function buildSignerIdentity(input: ClientRequestSigningV4ManagerCreateFetchInput): string {
  return JSON.stringify([
    input.apiKey,
    input.baseURL,
    input.clientVersion ?? "",
    input.transport,
    input.gate,
  ]);
}
