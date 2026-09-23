// ============================================================
// Web Remote Control —— relay 层协议（官方 3.14.3 对齐）
// ============================================================
// 拓扑：手机 Web 客户端 ↔ relay（认证 + 按 device_sid 配对 + data 信封透传）
//       ↔ 桌面 main（role="device"）↔ MessagePort ↔ host ChannelServer。
// rpc-frame 可靠传输（rpcFramePipe.ts）是手机↔main 端到端的；relay 不解析不排序。
// 本模块只放 schema 与纯函数（QR/常量/信封 schema），浏览器与 Node 通用。
// 依赖 node:crypto 的配对凭据生成与 HMAC proof 在 pairingCryptoNode.ts（Node 专用）；
// Web 端用 WebCrypto 实现同一算法，回归口径见 WEB_REMOTE_AUTH_TEST_VECTOR。
import { z } from "zod";

// ── 常量（官方 3.14.3 值） ──

/** 单条 WS 消息（JSON 文本）双向硬上限。 */
export const WEB_REMOTE_MAX_PHYSICAL_FRAME_BYTES = 1024 * 1024;
/** 单条逻辑消息上限。 */
export const WEB_REMOTE_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
/** 单条消息最大分片数。 */
export const WEB_REMOTE_MAX_FRAGMENTS = 64;
/** 分片组装超时。 */
export const WEB_REMOTE_ASSEMBLY_TIMEOUT_MS = 30_000;
/** 未确认出站字节重放缓冲上限。 */
export const WEB_REMOTE_REPLAY_BUFFER_MAX_BYTES = 8 * 1024 * 1024;
/** 最旧未确认批次宽限。 */
export const WEB_REMOTE_REPLAY_GRACE_MS = 45_000;
/** 未确认字节高/低水位（saturated / drained）。 */
export const WEB_REMOTE_SATURATED_BYTES = 1024 * 1024;
export const WEB_REMOTE_DRAINED_BYTES = 256 * 1024;
/** pair_status_query 间隔与 ack 看门狗。 */
export const WEB_REMOTE_HEARTBEAT_INTERVAL_MS = 10_000;
export const WEB_REMOTE_HEARTBEAT_JITTER_MS = 2_000;
export const WEB_REMOTE_HEARTBEAT_ACK_TIMEOUT_MS = 30_000;

/** relay 关闭码（官方语义）。 */
export const WEB_REMOTE_CLOSE_CODES = {
  /** 认证失败（proof 不符）。 */
  authFailed: 4004,
  /** 心跳/ack 看门狗超时。 */
  heartbeatTimeout: 4009,
  /** 配对被新设备接管（KICKED）。 */
  kicked: 4010,
  /** device_sid 未知。 */
  unknownDevice: 4011,
  /** 注册参数非法。 */
  invalidRegistration: 4012,
  /** 服务端正在关闭/维护。 */
  serverShutdown: 4013,
} as const;

/** rpc-frame 传输故障码（terminal = 触发后必须重建 bridge）。 */
export const WEB_REMOTE_RPC_FRAME_FAULTS = {
  invalidBase64: { terminal: false },
  invalidMetadata: { terminal: false },
  envelopeTooLarge: { terminal: true },
  messageTooLarge: { terminal: true },
  fragmentLimitExceeded: { terminal: true },
  fragmentIndexOutOfRange: { terminal: true },
  duplicateFragment: { terminal: true },
  assemblyTimeout: { terminal: true },
  checksumMismatch: { terminal: true },
  messageSeqGap: { terminal: true },
  replayedMessage: { terminal: false },
  identityMismatch: { terminal: false },
  replayBufferExceeded: { terminal: true },
  replayGraceExceeded: { terminal: true },
  ackGraceExceeded: { terminal: true },
} as const;
export type WebRemoteRpcFrameFault = keyof typeof WEB_REMOTE_RPC_FRAME_FAULTS;

export function isTerminalRpcFrameFault(fault: WebRemoteRpcFrameFault): boolean {
  return WEB_REMOTE_RPC_FRAME_FAULTS[fault].terminal;
}

// ── 配对凭据（password 不落盘；只存 passHash 与 device_sid） ──

export interface WebRemotePairingSecret {
  /** base64url(randomBytes(24)) —— 只进 QR/挑战面，不落盘。 */
  password: string;
  /** base64(SHA-256(password)) —— 44 字节 ASCII，QR hash 参数与 HMAC key。 */
  passHash: string;
}

/** 官方测试向量；回归口径，勿改。proof = base64url(HMAC-SHA256(key=passHash, msg=nonce|role|deviceSid))。 */
export const WEB_REMOTE_AUTH_TEST_VECTOR = {
  passHash: "dGVzdF9oYXNo",
  nonce: "nonce-1",
  role: "device",
  deviceSid: "device-1",
  proof: "XK0m7u-26VS88uk7ISAX5Z_9pjzq8jqyP77N-HkCsPE",
} as const;

// ── QR ──

export interface PairingQrParams {
  remoteUrl: string;
  deviceSid: string;
  passHash: string;
  deviceMid: string;
  deviceName: string;
  appVersion: string;
  now?: Date;
}

/**
 * 桌面侧生成配对二维码：`<remoteUrl>?sid&hash&t&mid&name&app_version`。
 * hash = passHash 本身（bearer 凭据；泄露走 resetPairing 轮换）。
 */
export function buildPairingQrUrl(params: PairingQrParams): string {
  const base = params.remoteUrl.replace(/\/+$/, "");
  const url = new URL(base);
  url.searchParams.set("sid", params.deviceSid);
  url.searchParams.set("hash", params.passHash);
  url.searchParams.set("t", String((params.now ?? new Date()).getTime()));
  url.searchParams.set("mid", params.deviceMid);
  url.searchParams.set("name", params.deviceName);
  url.searchParams.set("app_version", params.appVersion);
  return url.toString();
}

export const pairingQrSchema = z.object({
  sid: z.string().min(1).max(128),
  hash: z.string().min(1).max(128),
  t: z.number().int().nonnegative(),
  mid: z.string().min(1).max(128),
  name: z.string().max(128),
  app_version: z.string().min(1).max(64),
});

/** 手机端解析 QR（同构校验）。 */
export function parsePairingQrUrl(rawUrl: string): z.infer<typeof pairingQrSchema> | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const parsed = pairingQrSchema.safeParse({
    sid: url.searchParams.get("sid") ?? "",
    hash: url.searchParams.get("hash") ?? "",
    t: Number(url.searchParams.get("t") ?? -1),
    mid: url.searchParams.get("mid") ?? "",
    name: url.searchParams.get("name") ?? "",
    app_version: url.searchParams.get("app_version") ?? "",
  });
  if (!parsed.success) return null;
  if (!/^\/(remote|cn|en)/.test(url.pathname) && url.pathname !== "/" && url.pathname !== "") {
    // 非配对路径的 URL 不当 QR 处理（防误扫普通链接当作凭据）。
    return null;
  }
  return parsed.data;
}

// ── relay JSON 消息（main↔relay / web↔relay 同构） ──

const metaSchema = z
  .object({
    platform: z.string().max(64).optional(),
    version: z.string().max(64).optional(),
    name: z.string().max(128).optional(),
  })
  .strict();

export const relayDeviceRegisterInitSchema = z.object({
  type: z.literal("device_register_init"),
  device_mid: z.string().min(1).max(128),
  pass_hash: z.string().min(1).max(128),
  meta: metaSchema.optional(),
  client_ts: z.number().int().nonnegative().optional(),
});

export const relayDeviceRegisterAckSchema = z.object({
  type: z.literal("device_register_ack"),
  device_sid: z.string().min(1).max(128),
  server_ts: z.number().int().nonnegative().optional(),
});

export const relayAuthInitSchema = z.object({
  type: z.literal("auth_init"),
  role: z.enum(["device", "remote"]),
  device_sid: z.string().min(1).max(128),
  meta: metaSchema.optional(),
  client_ts: z.number().int().nonnegative().optional(),
});

export const relayAuthChallengeSchema = z.object({
  type: z.literal("auth_challenge"),
  nonce: z.string().min(1).max(256),
  server_ts: z.number().int().nonnegative().optional(),
});

export const relayAuthResponseSchema = z.object({
  type: z.literal("auth_response"),
  device_sid: z.string().min(1).max(128),
  proof: z.string().min(1).max(128),
  client_ts: z.number().int().nonnegative().optional(),
});

export const relayAuthOkSchema = z.object({
  type: z.literal("auth_ok"),
  server_ts: z.number().int().nonnegative().optional(),
});

export const relayPairStatusQuerySchema = z.object({
  type: z.literal("pair_status_query"),
  device_sid: z.string().min(1).max(128),
  client_ts: z.number().int().nonnegative().optional(),
});

export const relayPairStatusAckSchema = z.object({
  type: z.literal("pair_status_ack"),
  paired: z.boolean(),
  server_ts: z.number().int().nonnegative().optional(),
});

/** 业务/帧负载信封：relay 原样透传 payload，不解析。 */
export const relayDataEnvelopeSchema = z.object({
  type: z.literal("data"),
  payload: z.unknown(),
  client_ts: z.number().int().nonnegative().optional(),
  server_ts: z.number().int().nonnegative().optional(),
});

export const relayKickedSchema = z.object({
  type: z.literal("kicked"),
  reason: z.string().max(128).optional(),
});

export const relayClientMessageSchema = z.discriminatedUnion("type", [
  relayDeviceRegisterInitSchema,
  relayAuthInitSchema,
  relayAuthResponseSchema,
  relayPairStatusQuerySchema,
  relayDataEnvelopeSchema,
]);

export const relayServerMessageSchema = z.discriminatedUnion("type", [
  relayDeviceRegisterAckSchema,
  relayAuthChallengeSchema,
  relayAuthOkSchema,
  relayPairStatusAckSchema,
  relayDataEnvelopeSchema,
  relayKickedSchema,
]);

export type RelayClientMessage = z.infer<typeof relayClientMessageSchema>;
export type RelayServerMessage = z.infer<typeof relayServerMessageSchema>;

// ── 设备控制面（官方 3.14.3 对齐，手机 ↔ desktop main，走 data 信封内 JSON） ──
// bootstrap：配对成功后手机拉取桌面 workspace 列表；workspace-bridge-open 打开
// 指定 workspace 的 RPC 桥。MVP：本地 workspace 单桥，桥在 auth_ok 后已挂好。

const requestIdSchema = z.string().min(1).max(128);

export const remoteControlRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("bootstrap-request"),
    request_id: requestIdSchema,
    client_ts: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("workspace-list-request"),
    request_id: requestIdSchema,
    client_ts: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal("workspace-bridge-open"),
    request_id: requestIdSchema,
    workspace_key: z.string().min(1).max(512),
    /** 手机端铸造的共享桥身份：设备端 rpc-frame 收发端必须采纳同一 id（官方语义）。 */
    bridge_session_id: z.string().min(1).max(128),
    client_ts: z.number().int().nonnegative().optional(),
  }),
]);
export type RemoteControlRequest = z.infer<typeof remoteControlRequestSchema>;

export interface RemoteWorkspaceDescriptor {
  workspacePath: string;
  workspaceIdentity?: string;
  label?: string;
  kind: "local" | "remote";
}

export const remoteWorkspaceDescriptorSchema = z.object({
  workspace_path: z.string().min(1).max(4096),
  workspace_identity: z.string().min(1).max(256).optional(),
  label: z.string().max(256).optional(),
  kind: z.enum(["local", "remote"]),
});

const controlResponseBase = {
  request_id: requestIdSchema,
  success: z.boolean(),
  error: z.string().max(512).optional(),
  desktop_app_version: z.string().max(64).optional(),
};

export const remoteControlResponseSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("bootstrap-response"),
    ...controlResponseBase,
    workspaces: z.array(remoteWorkspaceDescriptorSchema).optional(),
    active_workspace_key: z.string().max(512).optional(),
  }),
  z.object({
    type: z.literal("workspace-list-response"),
    ...controlResponseBase,
    workspaces: z.array(remoteWorkspaceDescriptorSchema).optional(),
    active_workspace_key: z.string().max(512).optional(),
  }),
  z.object({
    type: z.literal("workspace-bridge-ready"),
    ...controlResponseBase,
    workspace_key: z.string().max(512).optional(),
    bridge: z.object({ kind: z.literal("local") }),
  }),
  z.object({
    type: z.literal("workspace-bridge-error"),
    ...controlResponseBase,
    workspace_key: z.string().max(512).optional(),
    reason: z.string().max(128).optional(),
  }),
]);
export type RemoteControlResponse = z.infer<typeof remoteControlResponseSchema>;

export function workspaceKeyOf(workspace: { workspacePath: string; workspaceIdentity?: string }): string {
  return workspace.workspaceIdentity?.trim() || workspace.workspacePath;
}
