// 自托管 Web Remote Control relay。
//
// 职责（官方 3.14.3 对齐的最小行为清单）：
//   ① WS /ws，单条消息 ≤1MB；
//   ② device_register_init → 分配 device_sid → device_register_ack；
//   ③ HMAC-SHA256 挑战应答（device / remote 双端同构；proof = base64url(HMAC(passHash, nonce|role|deviceSid))）；
//   ④ 配对互斥：同 device_sid 新连接上线 → 踢旧连接（close 4010 + {type:"kicked"}）；
//   ⑤ pair_status_query → pair_status_ack（paired = 对端当前在线）；
//   ⑥ {type:"data"} 信封原样透传（不解析 payload、不排序、不缓存）；
//   ⑦ 关闭码 4004/4010/4011/4012/4013（4009 心跳超时由端侧看门狗触发，relay 不产生）；
//   ⑧ 不实现 rpc-frame 层（那是 手机↔桌面 端到端的，本进程只透传）。
//   ⑨ 顺带托管手机客户端静态页（../web-remote-client/dist），扫码即用。
//   ⑩ 暴露面防护：设备条目容量上限 + 空闲回收 + auth_init 按 IP 限速 + proof 常量时间比较。
//
// 运行：PORT=8787 node server.mjs   （无状态，重启后 device_sid 失效，桌面侧重配对即可）
// 自建：先在 apps/web-remote-client 跑 `node build.mjs` 生成 dist/。
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 8787);
// 默认只绑回环：relay 总是置于 TLS 反代或 ssh 反向隧道之后（它们都连 127.0.0.1），
// 裸暴露到局域网/公网没有意义。需要直连监听时显式 HOST=0.0.0.0 覆盖。
const HOST = process.env.HOST?.trim() || "127.0.0.1";
const MAX_MESSAGE_BYTES = 1024 * 1024;

// ── 暴露面防护（自建 relay 默认随反代暴露）：无鉴权注册的容量上限、空闲条目回收、
// auth_init 按 IP 限速（官方有注册速率限制；没有这层，任何触达 relay 的客户端都能
// 无界制造 device_sid、或拿 QR 里可见的 sid 反复 pre-auth 踢掉真实连接）。 ──
const MAX_DEVICES = Number(process.env.WEB_REMOTE_MAX_DEVICES ?? 4096);
const DEVICE_IDLE_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const AUTH_INIT_WINDOW_MS = 60 * 1000;
const AUTH_INIT_MAX_PER_WINDOW = Number(process.env.WEB_REMOTE_AUTH_INIT_RATE ?? 120);

const CLOSE = {
  AUTH_FAILED: 4004,
  KICKED: 4010,
  UNKNOWN_DEVICE: 4011,
  INVALID_REGISTRATION: 4012,
  SERVER_SHUTDOWN: 4013,
};

// ── 静态托管手机客户端（./client-dist 或 apps/web-remote-client/dist） ──

const CLIENT_DIST =
  process.env.WEB_REMOTE_CLIENT_DIST?.trim() ||
  join(dirname(fileURLToPath(import.meta.url)), "..", "web-remote-client", "dist");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function serveStatic(pathname, res) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = normalize(join(CLIENT_DIST, relative));
  // 前缀必须带分隔符：否则名为 `dist*` 的兄弟目录也在 startsWith 范围内。
  if (!file.startsWith(CLIENT_DIST + sep) || !existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found (build the client: cd apps/web-remote-client && node build.mjs)");
    return;
  }
  const body = readFileSync(file);
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-cache",
  });
  res.end(body);
}

/** device_sid → { passHash, device: socket|null, remote: socket|null, lastActiveAt }（进程内，无持久化）。 */
const devices = new Map();

function touchEntry(entry) {
  entry.lastActiveAt = Date.now();
}

function sweepIdleDevices() {
  const now = Date.now();
  for (const [sid, entry] of devices) {
    if (entry.device || entry.remote) continue;
    if (now - (entry.lastActiveAt ?? 0) > DEVICE_IDLE_MS) devices.delete(sid);
  }
}
setInterval(sweepIdleDevices, SWEEP_INTERVAL_MS).unref();

const authInitWindows = new Map();
function authInitAllowed(ip) {
  const now = Date.now();
  const windowState = authInitWindows.get(ip);
  if (!windowState || now - windowState.startedAt > AUTH_INIT_WINDOW_MS) {
    authInitWindows.set(ip, { startedAt: now, count: 1 });
    return true;
  }
  windowState.count += 1;
  return windowState.count <= AUTH_INIT_MAX_PER_WINDOW;
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function computeProof({ passHash, nonce, role, deviceSid }) {
  return createHmac("sha256", passHash)
    .update(`${nonce}|${role}|${deviceSid}`, "utf8")
    .digest("base64url");
}

function proofMatches(proof, expected) {
  if (typeof proof !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(proof, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(socket, message) {
  if (socket.readyState !== socket.OPEN) return false;
  const text = JSON.stringify(message);
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) return false;
  socket.send(text);
  return true;
}

function sendError(socket, message) {
  send(socket, { type: "error", message, server_ts: Date.now() });
}

function kick(socket, reason, closeCode) {
  if (!socket) return;
  send(socket, { type: "kicked", reason });
  socket.close(closeCode ?? CLOSE.KICKED, reason);
}

function peerOf(entry, role) {
  return role === "device" ? entry.remote : entry.device;
}

function setPeer(entry, role, socket) {
  if (role === "device") entry.device = socket;
  else entry.remote = socket;
}

const httpServer = createServer((req, res) => serveStatic(new URL(req.url ?? "/", "http://x").pathname, res));
const wss = new WebSocketServer({ server: httpServer, path: "/ws", maxPayload: MAX_MESSAGE_BYTES });
httpServer.listen(PORT, HOST, () => {
  console.log(`[web-remote-relay] listening on ${HOST}:${PORT} (ws path /ws; client static: ${CLIENT_DIST})`);
});

wss.on("connection", (socket, req) => {
  // 会话状态：未注册/未认证前只允许注册与认证消息。
  const session = {
    role: null,
    deviceSid: null,
    registered: false,
    authenticated: false,
    ip: req?.socket?.remoteAddress ?? "unknown",
  };

  socket.on("close", () => {
    const entry = session.deviceSid ? devices.get(session.deviceSid) : undefined;
    if (!entry) return;
    if (entry.device === socket) entry.device = null;
    if (entry.remote === socket) entry.remote = null;
  });

  socket.on("message", (raw, isBinary) => {
    if (isBinary) {
      sendError(socket, "binary frames are not accepted; send JSON envelopes");
      return;
    }
    if (raw.length > MAX_MESSAGE_BYTES) {
      socket.close(CLOSE.INVALID_REGISTRATION, "message too large");
      return;
    }
    const message = safeParseJson(raw.toString("utf8"));
    if (!message || typeof message.type !== "string") {
      sendError(socket, "invalid json envelope");
      return;
    }

    // ⑥ data 信封：认证后原样透传到同 device_sid 的对端。
    if (message.type === "data") {
      if (!session.authenticated) {
        socket.close(CLOSE.AUTH_FAILED, "not authenticated");
        return;
      }
      const entry = devices.get(session.deviceSid);
      const peer = entry ? peerOf(entry, session.role) : null;
      if (!peer) {
        sendError(socket, "peer not connected");
        return;
      }
      send(peer, { type: "data", payload: message.payload, server_ts: Date.now() });
      touchEntry(entry);
      return;
    }

    // ② 设备注册：换发 device_sid（每次注册轮换，旧 sid 立即失效）。
    if (message.type === "device_register_init") {
      if (session.registered) {
        sendError(socket, "already registered on this connection");
        return;
      }
      const deviceMid = typeof message.device_mid === "string" ? message.device_mid : "";
      const passHash = typeof message.pass_hash === "string" ? message.pass_hash : "";
      if (!deviceMid || !passHash || passHash.length > 128) {
        socket.close(CLOSE.INVALID_REGISTRATION, "invalid registration");
        return;
      }
      if (devices.size >= MAX_DEVICES) {
        socket.close(CLOSE.INVALID_REGISTRATION, "device capacity reached");
        return;
      }
      const deviceSid = randomUUID();
      const old = devices.get(deviceSid);
      if (old?.device && old.device !== socket) kick(old.device, "re-registered", CLOSE.KICKED);
      devices.set(deviceSid, { passHash, device: socket, remote: null, lastActiveAt: Date.now() });
      session.registered = true;
      session.role = "device";
      session.deviceSid = deviceSid;
      send(socket, { type: "device_register_ack", device_sid: deviceSid, server_ts: Date.now() });
      return;
    }

    // ③/④ 认证（device 注册后走 auth；remote 直接用 QR 的 sid+hash 走同一套挑战应答）。
    // 官方现行手机前端（zcode.z.ai/remote/v4）以 role "terminal" 接入：映射到 remote 槽位，
    // 并保留原始角色以选择应答风格（官方读 auth_ack.pair_status；3.14.3 自家客户端读 auth_ok）。
    if (message.type === "auth_init") {
      // pre-auth 限速：auth_init 在 proof 校验前就会互斥踢掉同槽位旧连接，
      // 不限速时任何知道 sid（QR 明文可见）的客户端都能循环踢线。
      if (!authInitAllowed(session.ip)) {
        socket.close(CLOSE.AUTH_FAILED, "auth_init rate limited");
        return;
      }
      const rawRole = typeof message.role === "string" ? message.role : "";
      const role = rawRole === "remote" || rawRole === "terminal" ? "remote" : "device";
      const deviceSid = typeof message.device_sid === "string" ? message.device_sid : "";
      const entry = devices.get(deviceSid);
      if (!entry) {
        socket.close(CLOSE.UNKNOWN_DEVICE, "unknown device_sid");
        return;
      }
      if (role === "device" && entry.device && entry.device !== socket) {
        kick(entry.device, "superseded", CLOSE.KICKED);
      }
      if (role === "remote" && entry.remote && entry.remote !== socket) {
        kick(entry.remote, "superseded", CLOSE.KICKED);
      }
      session.role = role;
      session.deviceSid = deviceSid;
      socket._authRole = rawRole;
      setPeer(entry, role, socket);
      const nonce = randomBytes(24).toString("base64url");
      socket._authNonce = nonce;
      send(socket, { type: "auth_challenge", nonce, server_ts: Date.now() });
      return;
    }

    if (message.type === "auth_response") {
      const entry = session.deviceSid ? devices.get(session.deviceSid) : undefined;
      const expected = entry
        ? computeProof({
            passHash: entry.passHash,
            nonce: socket._authNonce ?? "",
            // proof 公式含角色原文（`${nonce}|${role}|${sid}`）：必须用客户端使用的原始
            // 角色串（terminal），不能用映射后的槽位名（remote），否则 HMAC 对不上。
            role: socket._authRole || session.role,
            deviceSid: session.deviceSid,
          })
        : null;
      if (!entry || !socket._authNonce || !proofMatches(message.proof, expected)) {
        socket.close(CLOSE.AUTH_FAILED, "auth failed");
        return;
      }
      socket._authNonce = undefined;
      session.authenticated = true;
      touchEntry(entry);
      const peer = peerOf(entry, session.role);
      // 官方现行前端用枚举（matched/waiting）表达对端在线；自家 3.14.3 客户端走 auth_ok。
      const peerOnline = Boolean(peer && peer.readyState === peer.OPEN);
      if (socket._authRole === "terminal") {
        send(socket, {
          type: "auth_ack",
          pair_status: peerOnline ? "matched" : "waiting",
          server_ts: Date.now(),
        });
      } else {
        send(socket, { type: "auth_ok", server_ts: Date.now() });
      }
      return;
    }

    // ⑤ 配对状态查询（桌面心跳）：paired = 对端在线。
    if (message.type === "pair_status_query") {
      if (!session.authenticated) {
        socket.close(CLOSE.AUTH_FAILED, "not authenticated");
        return;
      }
      const entry = devices.get(session.deviceSid);
      const peer = entry ? peerOf(entry, session.role) : null;
      const online = Boolean(peer && peer.readyState === peer.OPEN);
      if (entry) touchEntry(entry);
      send(socket, {
        type: "pair_status_ack",
        paired: online, // 自家 3.14.3 客户端读布尔 paired
        // 官方现行前端读枚举 pair_status（matched=对端在线 / waiting=等待桌面端）
        pair_status: online ? "matched" : "waiting",
        server_ts: Date.now(),
      });
      return;
    }

    sendError(socket, `unsupported message type: ${message.type}`);
  });
});

function shutdown() {
  for (const socket of wss.clients) socket.close(CLOSE.SERVER_SHUTDOWN, "server shutting down");
  wss.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
