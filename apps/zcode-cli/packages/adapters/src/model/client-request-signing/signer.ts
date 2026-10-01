/**
 * Client Request Signing V4 Signer（逆向官方 `ClientRequestSigningV4Signer.request`，
 * bundle 偏移 852300-855600，SPEC.md §1/§3）。
 *
 * 降级链（严格 fail-open）：
 * - origin 不匹配 / 已 bypass / gate 关闭或不可用 / 握手失败 → 裸发（剥离签名头）；
 * - 401 且 reason ∈ {VERIFY_SIGNATURE_INVALID, VERIFY_APIKEY_EXPIRED} → invalidate 后
 *   重新握手重试一次；再被拒 → bypassSigning=true（本 Signer 代际内永久）→ 裸发；
 * - 仅 invalid-config（非 HTTPS / 凭证无分隔符 / 缺 X-Session-Id）、PoW 与业务签名
 *   的密码学错误、disposed 为 fail-closed（抛 ClientRequestSigningV4Error）。
 */

import {
  CLIENT_SIGNING_APP_ID,
  CLIENT_SIGNING_DEFAULT_CLIENT_VERSION,
  CLIENT_SIGNING_HANDSHAKE_PATH,
  CLIENT_SIGNING_NONCE_BYTES,
  CLIENT_SIGNING_POW_BITS,
  CLIENT_SIGNING_SESSION_HEADER,
  CLIENT_SIGNING_VERSION_HEADER,
} from "./constants.js";
import { randomHex } from "./crypto-utils.js";
import { parseClientSigningCredential, type ClientSigningCredential } from "./credential.js";
import { ClientRequestSigningV4Error } from "./errors.js";
import type { CodingPlanSignatureFeatureGate } from "./feature-gate.js";
import { performSigningHandshake } from "./handshake-request.js";
import { signClientRequest } from "./handshake.js";
import type {
  ClientRequestSigningV4KeyCache,
  ClientRequestSigningV4KeyState,
} from "./key-cache.js";
import type {
  ClientSigningObservation,
  ClientSigningObservationContext,
  ClientSigningObserver,
} from "./observations.js";
import { createClientRequestProofOfWork } from "./pow.js";
import {
  buildSigningRequestInit,
  makeReplayableSigningRequest,
  sanitizeClientSigningHeaders,
  type ReplayableSigningRequest,
} from "./replayable-request.js";
import { readRefreshableClientSignatureReason } from "./response-inspection.js";

type SigningFetch = typeof globalThis.fetch;

export interface ClientRequestSigningV4SignerOptions {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly clientVersion?: string;
  readonly gate: CodingPlanSignatureFeatureGate;
  readonly keyCache: ClientRequestSigningV4KeyCache;
  readonly observe: ClientSigningObserver;
  readonly now?: () => number;
  readonly providerId: string;
  readonly transport: SigningFetch;
}

export class ClientRequestSigningV4Signer {
  readonly providerId: string;
  readonly apiKey: string;
  readonly baseURL: string;
  readonly clientVersion: string;
  private readonly gate: CodingPlanSignatureFeatureGate;
  private readonly keyCache: ClientRequestSigningV4KeyCache;
  private readonly observeFn: ClientSigningObserver;
  private readonly now: () => number;
  private readonly transport: SigningFetch;
  private readonly keyState: ClientRequestSigningV4KeyState;
  private bypassSigning = false;
  private disposed = false;
  private activeRequestCount = 0;

  constructor(options: ClientRequestSigningV4SignerOptions) {
    this.providerId = options.providerId;
    this.apiKey = options.apiKey;
    this.baseURL = options.baseURL;
    this.clientVersion = options.clientVersion ?? CLIENT_SIGNING_DEFAULT_CLIENT_VERSION;
    this.gate = options.gate;
    this.keyCache = options.keyCache;
    this.observeFn = options.observe;
    this.now = options.now ?? Date.now;
    this.transport = options.transport;
    this.keyState = this.keyCache.get(options.apiKey, this.businessOrigin);
  }

  /** 握手端点挂在业务 baseURL origin 上；origin 同时是防跨域重写的校验基准。 */
  get businessOrigin(): string {
    return new URL(this.baseURL).origin;
  }

  get handshakeUrl(): string {
    return new URL(CLIENT_SIGNING_HANDSHAKE_PATH, this.businessOrigin).toString();
  }

  beginRequest(): void {
    this.activeRequestCount += 1;
  }

  endRequest(): void {
    this.activeRequestCount = Math.max(0, this.activeRequestCount - 1);
  }

  dispose(): void {
    this.disposed = true;
    // keyState 跨 Signer 共享；identity 代际结束时 epoch++ 作废旧 key，防陈旧私钥复用。
    this.keyCache.invalidate(this.apiKey, this.businessOrigin);
  }

  async request(
    input: Parameters<SigningFetch>[0],
    init?: Parameters<SigningFetch>[1],
  ): Promise<Response> {
    this.beginRequest();
    try {
      return await this.handleRequest(input, init);
    } finally {
      this.endRequest();
    }
  }

  private async handleRequest(
    input: Parameters<SigningFetch>[0],
    init?: Parameters<SigningFetch>[1],
  ): Promise<Response> {
    this.assertUsable();
    const replayable = await makeReplayableSigningRequest(input, init);
    if (this.readOrigin(replayable.url) !== this.businessOrigin) {
      // 网关路由重写发生在更底层 transport；签名器看到的必须是业务 origin。
      return this.sendUnsigned(replayable, "origin_mismatch");
    }
    if (this.bypassSigning) {
      return this.sendUnsigned(replayable, "bypass");
    }

    let enabled: boolean;
    try {
      enabled = await this.gate.isEnabled();
    } catch {
      // gate 只在实现自身异常时抛错；仍然 fail-open 裸发。
      return this.sendUnsigned(replayable, "feature_gate_unavailable");
    }
    if (!enabled) {
      return this.sendUnsigned(replayable, "feature_gate_disabled");
    }
    // 非 https 只在「签名即将进行」时才是 invalid-config（官方在构建握手 URL 处校验）；
    // gate 关闭时必须先裸发，不能因 http baseURL 抛错。
    if (this.businessOrigin.startsWith("http:")) {
      return this.failClosed(
        replayable,
        invalidConfig("signing requires an https business baseURL"),
      );
    }

    const credential = parseClientSigningCredential(this.apiKey);
    if (!credential) {
      return this.failClosed(
        replayable,
        invalidConfig("api key credential must be apiKeyId.apiKeySecret"),
      );
    }

    const firstKey = await this.getKeyOrSendUnsigned(replayable, credential);
    if (firstKey instanceof Response) return firstKey;
    const firstResponse = await this.sendSigned(replayable, credential, firstKey);
    const firstReason = await readRefreshableClientSignatureReason(firstResponse);
    if (!firstReason) return firstResponse;
    this.observe(replayable, { kind: "verify_rejected", reason: firstReason, signedAttempt: 1 });
    this.invalidatePrivateKey();

    const secondKey = await this.getKeyOrSendUnsigned(replayable, credential);
    if (secondKey instanceof Response) return secondKey;
    const secondResponse = await this.sendSigned(replayable, credential, secondKey);
    const secondReason = await readRefreshableClientSignatureReason(secondResponse);
    if (!secondReason) return secondResponse;
    // 两轮 401 验签拒绝：一次性熔断，本 Signer 代际内全部裸发，防 401 死循环。
    this.invalidatePrivateKey();
    this.bypassSigning = true;
    this.observe(replayable, { kind: "bypass_entered" });
    return this.sendUnsigned(replayable, "verify_refresh_exhausted");
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new ClientRequestSigningV4Error("Client request signing signer is disposed", {
        failOpenEligible: false,
        kind: "disposed",
      });
    }
  }

  /** ensurePrivateKey：命中缓存直接用；并发握手合并进 handshakePromise；epoch 变化即放弃结果。 */
  private async getKeyOrSendUnsigned(
    replayable: ReplayableSigningRequest,
    credential: ClientSigningCredential,
  ): Promise<CryptoKey | Response> {
    if (this.keyState.privateKey) {
      return this.keyState.privateKey;
    }
    if (!this.keyState.handshakePromise) {
      const epochAtStart = this.keyState.epoch;
      this.keyState.handshakePromise = performSigningHandshake({
        credential,
        handshakeUrl: this.handshakeUrl,
        now: this.now,
        transport: this.transport,
      })
        .then((privateKey) => {
          if (this.keyState.epoch !== epochAtStart) {
            // 握手期间 key 已被作废（401 invalidate / dispose）：结果不落缓存。
            throw new ClientRequestSigningV4Error("Signing key expired during handshake", {
              failOpenEligible: true,
              kind: "handshake-protocol",
            });
          }
          this.keyState.privateKey = privateKey;
          return privateKey;
        })
        .finally(() => {
          this.keyState.handshakePromise = undefined;
        });
    }
    try {
      return await this.keyState.handshakePromise;
    } catch (error) {
      if (error instanceof ClientRequestSigningV4Error && !error.failOpenEligible) {
        return this.failClosed(replayable, error);
      }
      this.observe(replayable, handshakeFailureObservation(error));
      return this.sendUnsigned(replayable, "handshake_failed");
    }
  }

  private invalidatePrivateKey(): void {
    this.keyCache.invalidate(this.apiKey, this.businessOrigin);
  }

  private async sendSigned(
    replayable: ReplayableSigningRequest,
    credential: ClientSigningCredential,
    privateKey: CryptoKey,
  ): Promise<Response> {
    const headers = sanitizeClientSigningHeaders(replayable.headers);
    const sessionId = replayable.headers.get(CLIENT_SIGNING_SESSION_HEADER)?.trim();
    if (!sessionId) {
      // sessionId 由归因头 x-session-id 提供；缺失说明调用链断裂，属本地配置错误。
      return this.failClosed(
        replayable,
        invalidConfig("signing requires the X-Session-Id attribution header"),
      );
    }
    const ts = String(this.now());
    const nonce = randomHex(CLIENT_SIGNING_NONCE_BYTES);
    try {
      const pow = await createClientRequestProofOfWork({
        apiKeyId: credential.apiKeyId,
        appId: CLIENT_SIGNING_APP_ID,
        powBits: CLIENT_SIGNING_POW_BITS,
        sessionId,
        signal: replayable.signal ?? undefined,
        ts,
      });
      const clientVersion = this.resolveClientVersion(replayable);
      const sig = await signClientRequest(
        privateKey,
        `${credential.apiKeyId}\n${ts}\n${clientVersion}\n${sessionId}\n${nonce}`,
      );
      headers.set("X-Client-Ts", ts);
      headers.set("X-Client-Version", clientVersion);
      headers.set("X-Client-Sig", sig);
      headers.set("X-Client-Nonce", nonce);
      headers.set("X-App-Id", CLIENT_SIGNING_APP_ID);
      headers.set("X-Client-Pow", pow);
      headers.set(CLIENT_SIGNING_SESSION_HEADER, sessionId);
    } catch (error) {
      if (isAbortError(error)) throw error;
      // PoW / 业务签名的密码学错误：本地无法产生合法请求，fail-closed。
      return this.failClosed(
        replayable,
        new ClientRequestSigningV4Error("Client request signing failed", {
          failOpenEligible: false,
          kind: "cryptography",
        }),
      );
    }
    this.observe(replayable, { kind: "signed_sent" });
    return this.transport(replayable.url, buildSigningRequestInit(replayable, headers));
  }

  private sendUnsigned(replayable: ReplayableSigningRequest, reason: string): Promise<Response> {
    this.observe(replayable, { kind: "unsigned_sent", reason });
    // 剥离签名头后原样发送，保证降级请求与未装配签名的行为字节等价。
    return this.transport(
      replayable.url,
      buildSigningRequestInit(replayable, sanitizeClientSigningHeaders(replayable.headers)),
    );
  }

  private resolveClientVersion(replayable: ReplayableSigningRequest): string {
    return replayable.headers.get(CLIENT_SIGNING_VERSION_HEADER)?.trim() || this.clientVersion;
  }

  private failClosed(
    replayable: ReplayableSigningRequest,
    error: ClientRequestSigningV4Error,
  ): never {
    this.observe(replayable, { kind: "request_failed_closed", errorKind: error.kind });
    throw error;
  }

  private observe(
    replayable: ReplayableSigningRequest,
    observation: ClientSigningObservation,
  ): void {
    const requestId = replayable.headers.get("x-request-id")?.trim();
    const sessionId = replayable.headers.get(CLIENT_SIGNING_SESSION_HEADER)?.trim();
    const context: ClientSigningObservationContext = {
      providerId: this.providerId,
      ...(requestId ? { requestId } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
    this.observeFn(observation, context);
  }

  private readOrigin(url: string): string | undefined {
    try {
      return new URL(url).origin;
    } catch {
      return undefined;
    }
  }
}

function handshakeFailureObservation(error: unknown): ClientSigningObservation {
  if (error instanceof ClientRequestSigningV4Error) {
    return {
      kind: "handshake_failed",
      ...(error.businessCode !== undefined ? { businessCode: error.businessCode } : {}),
      errorKind: error.kind,
      ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
      ...(error.reason !== undefined ? { reason: error.reason } : {}),
    };
  }
  return { kind: "handshake_failed", errorKind: "handshake-network" };
}

function invalidConfig(message: string): ClientRequestSigningV4Error {
  return new ClientRequestSigningV4Error(message, {
    failOpenEligible: false,
    kind: "invalid-config",
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
