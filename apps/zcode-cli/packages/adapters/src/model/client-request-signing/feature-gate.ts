/**
 * Coding Plan 签名灰度门（逆向官方 `CodingPlanSignatureFeatureGate`，bundle 偏移 844995-845100，
 * SPEC.md §4）。
 *
 * GET {ZCode 平台 origin}/api/v1/agent/configs（来源头 + x-api-key），读
 * `data.codingPlanSignature.enable`。关键语义：**gate 请求失败 = enabled:false = 裸发**，
 * 绝不 fail-closed；cacheable 结果缓存 1 小时，并发请求合并为一个在飞请求，
 * 调用方 abort 只影响等待方，不影响刷新本身。
 */

import type { Logger } from "@zcode/contracts";
import { CLIENT_SIGNING_GATE_CACHE_TTL_MS, CLIENT_SIGNING_GATE_TIMEOUT_MS } from "./constants.js";

type SigningFetch = typeof globalThis.fetch;

export interface CodingPlanSignatureFeatureGateOptions {
  readonly apiKey: string;
  readonly configUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly logger?: Logger;
  readonly now?: () => number;
  readonly transport: SigningFetch;
}

interface GateSnapshot {
  readonly enabled: boolean;
  readonly expiresAt: number;
}

type GateOutcome =
  | { readonly cacheable: true; readonly enabled: boolean }
  | {
      readonly cacheable: false;
      readonly enabled: false;
      readonly failure: "business_code" | "http_status" | "timeout" | "network" | "malformed";
    };

export class CodingPlanSignatureFeatureGate {
  readonly #apiKey: string;
  readonly #configUrl: string;
  readonly #headers: Record<string, string>;
  readonly #logger?: Logger;
  readonly #now: () => number;
  readonly #transport: SigningFetch;
  #snapshot?: GateSnapshot;
  #pending?: Promise<GateOutcome>;

  constructor(options: CodingPlanSignatureFeatureGateOptions) {
    this.#apiKey = options.apiKey;
    this.#configUrl = options.configUrl;
    this.#headers = { ...options.headers };
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
    this.#transport = options.transport;
  }

  /**
   * gate 开启与否。预期的失败（网络/超时/HTTP/解析/业务码）都收敛为 false（裸发），
   * 只有实现自身 bug 才会抛出，由 Signer 兜底为 "feature_gate_unavailable" 裸发。
   */
  async isEnabled(): Promise<boolean> {
    const snapshot = this.#snapshot;
    if (snapshot && snapshot.expiresAt > this.#now()) {
      return snapshot.enabled;
    }
    if (!this.#pending) {
      this.#pending = this.#fetchOutcome().finally(() => {
        this.#pending = undefined;
      });
    }
    const outcome = await this.#pending;
    if (outcome.cacheable) {
      this.#snapshot = {
        enabled: outcome.enabled,
        expiresAt: this.#now() + CLIENT_SIGNING_GATE_CACHE_TTL_MS,
      };
    }
    return outcome.enabled;
  }

  dispose(): void {
    this.#snapshot = undefined;
  }

  async #fetchOutcome(): Promise<GateOutcome> {
    // 超时由 gate 自己的 AbortController 承担；调用方 abort 不传入，防外部取消打断共享刷新。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLIENT_SIGNING_GATE_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await this.#transport(this.#configUrl, {
        headers: { ...this.#headers, "x-api-key": this.#apiKey },
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });
      if (!response.ok) {
        return this.#record(
          { cacheable: false, enabled: false, failure: "http_status" },
          response.status,
        );
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return this.#record(
          { cacheable: false, enabled: false, failure: "malformed" },
          response.status,
        );
      }
      const record = asRecord(body);
      // 与官方解析一致：code≠0 → business_code；缺 codingPlanSignature 键 = 灰度未覆盖 = 关。
      if (record?.code !== 0) {
        return this.#record(
          { cacheable: false, enabled: false, failure: "business_code" },
          response.status,
        );
      }
      const data = asRecord(record.data);
      if (!data || !Object.prototype.hasOwnProperty.call(data, "codingPlanSignature")) {
        return this.#record({ cacheable: true, enabled: false }, response.status);
      }
      const signature = asRecord(data.codingPlanSignature);
      return this.#record(
        { cacheable: true, enabled: signature?.enable === true },
        response.status,
      );
    } catch (error) {
      const failure = isAbortError(error) ? "timeout" : "network";
      return this.#record({ cacheable: false, enabled: false, failure }, undefined);
    } finally {
      clearTimeout(timer);
    }
  }

  #record<T extends GateOutcome>(outcome: T, httpStatus: number | undefined): T {
    // gate 结果单独成日志（info/warn），只在真实刷新时输出，缓存命中不重复打印。
    const context: Record<string, unknown> = { enabled: outcome.enabled };
    if (!outcome.cacheable && outcome.failure !== undefined) {
      context.failure = outcome.failure;
    }
    if (httpStatus !== undefined) {
      context.httpStatus = httpStatus;
    }
    if (outcome.cacheable) {
      this.#logger?.info("model.client_signing.feature_gate", context);
    } else {
      this.#logger?.warn("model.client_signing.feature_gate", context);
    }
    return outcome;
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
