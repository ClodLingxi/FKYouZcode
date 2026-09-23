// Web Remote Control 配对凭据持久化：只存 deviceMid/deviceSid/passHash（password 不落盘）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    writeFileSync(join(userDataDir, "web-remote-control.json"), JSON.stringify(pairing, null, 2), "utf8");
  } catch {
    // 持久化失败不阻断远控：重启后重新配对即可。
  }
}
