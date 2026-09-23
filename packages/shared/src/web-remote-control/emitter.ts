// ============================================================
// Web Remote Control —— node:events 的浏览器可用极简替代。
// rpc-frame 收发端只需要 on/off/emit/removeAllListeners；mini 实现保证
// 同一模块在 Electron main（Node）与手机 Web 客户端（浏览器 bundle）都能加载。
/** 万能 listener 形状：never 参数逆变，任何具体签名的 listener 都可赋值。 */
type AnyListener = (...args: never[]) => void;

export class MiniEmitter {
  private readonly listeners = new Map<string, Set<AnyListener>>();

  on(event: string, listener: AnyListener): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  off(event: string, listener: AnyListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      (listener as (...args: unknown[]) => void)(...args);
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}
