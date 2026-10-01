/**
 * Client Request Signing V4 私钥缓存（逆向官方 `ClientRequestSigningV4KeyCache`，SPEC.md §5）。
 *
 * 两级 Map：apiKey → handshakeUrl origin → keyState。keyState 的 epoch 用于作废旧 key：
 * invalidate / dispose 时 +1；握手中检测到 epoch 变化即放弃结果，不写入缓存。
 * 私钥只驻留内存，进程退出即销毁。
 */

export interface ClientRequestSigningV4KeyState {
  epoch: number;
  privateKey?: CryptoKey;
  handshakePromise?: Promise<CryptoKey>;
}

export class ClientRequestSigningV4KeyCache {
  readonly #states = new Map<string, Map<string, ClientRequestSigningV4KeyState>>();

  get(apiKey: string, origin: string): ClientRequestSigningV4KeyState {
    const byOrigin = this.#states.get(apiKey) ?? new Map<string, ClientRequestSigningV4KeyState>();
    const state = byOrigin.get(origin) ?? { epoch: 0 };
    byOrigin.set(origin, state);
    this.#states.set(apiKey, byOrigin);
    return state;
  }

  /** 作废旧 key：epoch++，清 privateKey / handshakePromise；握手中调用即令其结果被放弃。 */
  invalidate(apiKey: string, origin: string): void {
    const state = this.#states.get(apiKey)?.get(origin);
    if (!state) return;
    state.epoch += 1;
    state.privateKey = undefined;
    state.handshakePromise = undefined;
  }

  dispose(): void {
    for (const byOrigin of this.#states.values()) {
      for (const state of byOrigin.values()) {
        state.epoch += 1;
        state.privateKey = undefined;
        state.handshakePromise = undefined;
      }
    }
    this.#states.clear();
  }
}
