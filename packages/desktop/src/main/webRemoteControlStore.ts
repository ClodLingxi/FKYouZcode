// Web Remote Control 配对凭据持久化：只存 deviceMid/deviceSid/passHash（password 不落盘）。
// passHash 等价 bearer 凭据，落盘权限收紧到 0600（官方走 safeStorage，自建版以此兜底）。
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PairingStore {
  deviceMid: string;
  deviceSid: string | null;
  passHash: string;
}

export function loadPairingStore(userDataDir: string): PairingStore | null {
  try {
    const path = join(userDataDir, "web-remote-control.json");
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PairingStore>;
    if (typeof raw.deviceMid !== "string" || typeof raw.passHash !== "string") return null;
    return {
      deviceMid: raw.deviceMid,
      deviceSid: typeof raw.deviceSid === "string" ? raw.deviceSid : null,
      passHash: raw.passHash,
    };
  } catch {
    return null;
  }
}

export function savePairingStore(userDataDir: string, pairing: PairingStore): void {
  try {
    mkdirSync(userDataDir, { recursive: true });
    const path = join(userDataDir, "web-remote-control.json");
    writeFileSync(path, JSON.stringify(pairing, null, 2), { encoding: "utf8", mode: 0o600 });
    // mode 只在创建时生效；旧版本落盘的文件在此一并收紧。
    chmodSync(path, 0o600);
  } catch {
    // 持久化失败不阻断远控：重启后重新配对即可。
  }
}
