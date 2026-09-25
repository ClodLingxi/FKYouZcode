// relay 行为验收（对齐 README 行为清单 + 官方现行前端兼容层）。
// 用法: node protocol-test.mjs <ws-url>
//   例: node protocol-test.mjs ws://127.0.0.1:8787/ws
//       node protocol-test.mjs wss://your-host.example/remote/ws
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const url = process.argv[2] ?? "ws://127.0.0.1:8787/ws";
const passHash = createHash("sha256").update("test-password").digest("hex");
let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox = [];
    const waiters = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString("utf8"));
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
      else inbox.push(msg);
    });
    const closeInfo = { code: null, reason: null };
    ws.on("close", (code, reason) => { closeInfo.code = code; closeInfo.reason = String(reason ?? ""); });
    ws.on("error", () => {});
    ws.once("open", () => {
      resolve({
        ws, closeInfo, inbox,
        send: (m) => ws.send(JSON.stringify(m)),
        wait: (pred, { timeout = 3000, label = "" } = {}) =>
          new Promise((res, rej) => {
            const idx = inbox.findIndex(pred);
            if (idx >= 0) return res(inbox.splice(idx, 1)[0]);
            const t = setTimeout(() => rej(new Error(`timeout waiting: ${label}`)), timeout);
            waiters.push({ pred, resolve: (m) => { clearTimeout(t); res(m); } });
          }),
        waitForClose: async (timeout = 3000) => {
          for (let i = 0; i < timeout / 50 && closeInfo.code === null; i++) await sleep(50);
          return closeInfo;
        },
      });
    });
    ws.once("error", reject);
  });
}
const proofOf = (nonce, role, sid) =>
  createHmac("sha256", passHash).update(`${nonce}|${role}|${sid}`, "utf8").digest("base64url");

const httpBase = new URL(url.replace(/^ws/, "http"));
// 前缀发布（…/<base>/ws）时静态路径相对 <base>/ 解析，而非域名根。
const httpBaseDir = new URL(".", httpBase).href;
const httpGet = async (path) => {
  const resolved = new URL(path.replace(/^\/+/, ""), httpBaseDir);
  const res = await fetch(resolved.href);
  return { status: res.status, contentType: res.headers.get("content-type") ?? "" };
};

console.log(`relay under test: ${url}`);
// 1. 静态页（路径前缀发布时由调用方对 /<base>/ 单测，这里只测根路径托管）
{
  const index = await httpGet("/");
  assert(index.status === 200 && index.contentType.includes("text/html"), "静态 / 返回手机客户端 index.html");
  const appjs = await httpGet("/app.js");
  assert(appjs.status === 200 && appjs.contentType.includes("text/javascript"), "静态 /app.js 200");
  const missing = await httpGet("/nope.txt");
  assert(missing.status === 404, "未知静态路径 404");
}
// 2. 注册 + ack
const device = await connect();
device.send({ type: "device_register_init", device_mid: randomUUID(), pass_hash: passHash });
const ack = await device.wait((m) => m.type === "device_register_ack", { label: "register ack" });
const sid = ack.device_sid;
assert(typeof sid === "string" && sid.length > 10, "device_register_init → ack 带 device_sid");

// 3. remote（自家 3.14.3 客户端方言）挑战应答
const remote = await connect();
remote.send({ type: "auth_init", role: "remote", device_sid: sid });
const challenge = await remote.wait((m) => m.type === "auth_challenge", { label: "challenge" });
remote.send({ type: "auth_response", proof: proofOf(challenge.nonce, "remote", sid) });
await remote.wait((m) => m.type === "auth_ok", { label: "remote auth_ok" });
assert(true, "remote HMAC 挑战应答通过（auth_ok）");

// 4. device 侧 auth + pair_status
device.send({ type: "auth_init", role: "device", device_sid: sid });
const challenge2 = await device.wait((m) => m.type === "auth_challenge", { label: "device challenge" });
device.send({ type: "auth_response", proof: proofOf(challenge2.nonce, "device", sid) });
await device.wait((m) => m.type === "auth_ok", { label: "device auth_ok" });
device.send({ type: "pair_status_query", device_sid: sid });
const status = await device.wait((m) => m.type === "pair_status_ack", { label: "pair status" });
assert(status.paired === true, "pair_status_query → paired=true（对端在线）");

// 5. data 双向透传
const blob1 = { channel: "rpc-frame", n: 1, bytes: randomBytes(16).toString("base64") };
device.send({ type: "data", payload: blob1 });
const got1 = await remote.wait((m) => m.type === "data", { label: "data→remote" });
assert(JSON.stringify(got1.payload) === JSON.stringify(blob1), "data 信封 device→remote 原样透传");
const blob2 = { channel: "rpc-frame-ack", n: 2 };
remote.send({ type: "data", payload: blob2 });
const got2 = await device.wait((m) => m.type === "data", { label: "data→device" });
assert(JSON.stringify(got2.payload) === JSON.stringify(blob2), "data 信封 remote→device 原样透传");

// 6. 未认证 data → 4004
const rogue = await connect();
rogue.send({ type: "data", payload: {} });
const rogueClose = await rogue.waitForClose();
assert(rogueClose.code === 4004, "未认证 data → close 4004");

// 7. 错 proof → 4004
const liar = await connect();
liar.send({ type: "auth_init", role: "remote", device_sid: sid });
await liar.wait((m) => m.type === "auth_challenge", { label: "liar challenge" });
liar.send({ type: "auth_response", proof: "wrong-proof" });
const liarClose = await liar.waitForClose();
assert(liarClose.code === 4004, "错误 proof → close 4004");

// 8. 未知 sid → 4011
const ghost = await connect();
ghost.send({ type: "auth_init", role: "remote", device_sid: randomUUID() });
const ghostClose = await ghost.waitForClose();
assert(ghostClose.code === 4011, "未知 device_sid → close 4011");

// 9. 同角色新连接踢旧连接（4010 + kicked）
const remote2 = await connect();
remote2.send({ type: "auth_init", role: "remote", device_sid: sid });
const ch3 = await remote2.wait((m) => m.type === "auth_challenge", { label: "remote2 challenge" });
remote2.send({ type: "auth_response", proof: proofOf(ch3.nonce, "remote", sid) });
await remote2.wait((m) => m.type === "auth_ok", { label: "remote2 auth_ok" });
const kickedMsg = await remote.wait((m) => m.type === "kicked", { label: "kicked" }).catch(() => null);
const remoteClose = await remote.waitForClose();
assert(Boolean(kickedMsg) && remoteClose.code === 4010, "同 sid 同角色新连接 → 旧连接 kicked + close 4010");

// 10. 接管后 pair_status 恢复
device.send({ type: "pair_status_query", device_sid: sid });
const status2 = await device.wait((m) => m.type === "pair_status_ack", { label: "pair status 2" });
assert(status2.paired === true, "接管后 pair_status 仍正确");

device.ws.close(); remote2.ws.close();
await sleep(200);

// ── 官方现行前端（role terminal）兼容层 ──
console.log("\n[官方前端兼容] role=terminal");
const device3 = await connect();
device3.send({ type: "device_register_init", device_mid: randomUUID(), pass_hash: passHash });
const ack3 = await device3.wait((m) => m.type === "device_register_ack", { label: "register3" });
const sid3 = ack3.device_sid;
device3.send({ type: "auth_init", role: "device", device_sid: sid3 });
const dch = await device3.wait((m) => m.type === "auth_challenge", { label: "device3 challenge" });
device3.send({ type: "auth_response", proof: proofOf(dch.nonce, "device", sid3) });
await device3.wait((m) => m.type === "auth_ok", { label: "device3 auth_ok" });

const terminal = await connect();
terminal.send({
  type: "auth_init",
  role: "terminal",
  device_sid: sid3,
  meta: { platform: "web", version: "web", name: "mobile-browser" },
  client_ts: Date.now(),
});
const tch = await terminal.wait((m) => m.type === "auth_challenge", { label: "terminal challenge" });
// 官方客户端 proof 用原始角色串 terminal：HMAC(passHash, `${nonce}|terminal|${sid}`)
terminal.send({
  type: "auth_response",
  device_sid: sid3,
  proof: createHmac("sha256", passHash).update(`${tch.nonce}|terminal|${sid3}`, "utf8").digest("base64url"),
  client_ts: Date.now(),
});
const tAck = await terminal.wait((m) => m.type === "auth_ack", { label: "terminal auth_ack" });
assert(tAck.pair_status === "matched", "terminal 认证 → auth_ack 且 pair_status=matched");

terminal.send({ type: "pair_status_query", device_sid: sid3 });
const psAck = await terminal.wait((m) => m.type === "pair_status_ack", { label: "terminal pair status" });
assert(psAck.pair_status === "matched" && psAck.paired === true, "pair_status_ack 双字段（枚举 matched + 布尔 paired）");

// terminal 占用 remote 槽位（data 能通到 device），且不能顶掉 device
terminal.send({ type: "data", payload: { probe: "terminal→device" } });
const probeGot = await device3.wait((m) => m.type === "data", { label: "terminal data" });
assert(probeGot.payload?.probe === "terminal→device", "terminal 占 remote 槽位，data 直达 device");

// proof 用错角色串（remote）必须被拒 —— 证明 relay 按原始角色校验。
// 注意：terminalBad 的 auth_init 会按互斥语义踢掉上面的 terminal（同槽位接管），故放在最后。
const terminalBad = await connect();
terminalBad.send({ type: "auth_init", role: "terminal", device_sid: sid3 });
const bch = await terminalBad.wait((m) => m.type === "auth_challenge", { label: "bad challenge" });
terminalBad.send({ type: "auth_response", proof: proofOf(bch.nonce, "remote", sid3) });
const badClose = await terminalBad.waitForClose();
assert(badClose.code === 4004, "terminal 用 remote 角色串算 proof → 4004 拒绝");

device3.ws.close(); terminal.ws.close();
await sleep(200);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
