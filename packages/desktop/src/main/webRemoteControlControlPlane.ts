// ============================================================
// Web Remote Control —— 手机控制面（bootstrap / workspace 列表 / bridge open）。
// 与 rpc-frame 同走 relay data 信封，靠 type 字段判别；MVP 为本地 workspace 单桥，
// 桥在 auth_ok 后由服务统一挂好，这里只做清单应答与 bridge-open 校验。
import { remoteControlRequestSchema, workspaceKeyOf, type RemoteControlRequest, type RemoteControlResponse } from "@zcode/shared";

export interface WebRemoteControlPlaneDeps {
  appVersion: string;
  resolveWorkspaces: () => Array<{ workspacePath: string; workspaceIdentity?: string }>;
  /** 经 relay 下行（包成 data 信封由调用方负责）。 */
  send: (message: unknown) => void;
  /** 以手机端铸造的桥身份挂好 host RPC 桥与 rpc-frame 收发端。 */
  ensureBridge: (bridgeSessionId: string) => void;
}

/**
 * 尝试按控制面请求处理一个 data 信封 payload。
 * 命中控制面返回 true（已应答）；否则返回 false，交还 rpc-frame 管线。
 */
export function tryHandleControlPayload(payload: unknown, deps: WebRemoteControlPlaneDeps): boolean {
  const parsed = remoteControlRequestSchema.safeParse(payload);
  if (!parsed.success) return false;
  handleControlRequest(parsed.data, deps);
  return true;
}

function handleControlRequest(request: RemoteControlRequest, deps: WebRemoteControlPlaneDeps): void {
  const resolved = deps.resolveWorkspaces();
  const workspaces = resolved.map((workspace) => ({
    workspace_path: workspace.workspacePath,
    ...(workspace.workspaceIdentity ? { workspace_identity: workspace.workspaceIdentity } : {}),
    kind: "local" as const,
  }));
  switch (request.type) {
    case "bootstrap-request":
    case "workspace-list-request": {
      const [activeWorkspace] = resolved;
      deps.send({
        type: request.type === "bootstrap-request" ? "bootstrap-response" : "workspace-list-response",
        request_id: request.request_id,
        success: true,
        desktop_app_version: deps.appVersion,
        workspaces,
        ...(activeWorkspace ? { active_workspace_key: workspaceKeyOf(activeWorkspace) } : {}),
      });
      return;
    }
    case "workspace-bridge-open": {
      const known = resolved.some((workspace) => workspaceKeyOf(workspace) === request.workspace_key);
      if (!known) {
        deps.send({
          type: "workspace-bridge-error",
          request_id: request.request_id,
          success: false,
          workspace_key: request.workspace_key,
          reason: "workspace-closed",
          error: `unknown workspace_key: ${request.workspace_key}`,
        });
        return;
      }
      deps.ensureBridge(request.bridge_session_id);
      deps.send({
        type: "workspace-bridge-ready",
        request_id: request.request_id,
        success: true,
        workspace_key: request.workspace_key,
        bridge: { kind: "local" },
      });
      return;
    }
  }
}
