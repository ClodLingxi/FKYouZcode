// Web Remote Control 的 Renderer IPC 面：状态/开关/重置配对（QR 由设置页渲染）。
import { ipcMain } from "electron";
import { PlatformChannels } from "@zcode/shared";
import type {
  WebRemoteControlService,
  WebRemoteControlState,
} from "./webRemoteControlService.js";

export interface WebRemoteControlStatusPayload {
  state: WebRemoteControlState;
  qrUrl: string | null;
  /** relay 端点是否被 env 覆盖（自建部署提示）。 */
  usingCustomRelay: boolean;
}

export function registerWebRemoteControlIpc(
  service: WebRemoteControlService,
  log: (message: string, error?: unknown) => void,
): void {
  ipcMain.handle(PlatformChannels.WebRemoteGetState, (): WebRemoteControlStatusPayload => {
    return {
      state: service.getState(),
      qrUrl: service.getQrUrl(),
      usingCustomRelay: Boolean(
        process.env.ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL?.trim() ||
          process.env.ZCODE_WEB_REMOTE_CONTROL_URL?.trim(),
      ),
    };
  });
  ipcMain.handle(PlatformChannels.WebRemoteStart, () => {
    service.start();
    return { state: service.getState(), qrUrl: service.getQrUrl() };
  });
  ipcMain.handle(PlatformChannels.WebRemoteStop, () => {
    service.stop();
    return { state: service.getState(), qrUrl: null };
  });
  ipcMain.handle(PlatformChannels.WebRemoteResetPairing, () => {
    service.resetPairing();
    return { state: service.getState(), qrUrl: service.getQrUrl() };
  });
  log("web-remote-control IPC registered");
}
