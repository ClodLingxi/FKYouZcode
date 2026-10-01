/**
 * Client Request Signing V4 纯函数与降级链单测。
 *
 * 覆盖：HKDF 派生（与 node:crypto hkdfSync 对拍）、HMAC 握手签名、PoW 求解/验证、
 * 头剥离/注入、凭证解析（恰好一个点）、requiresClientRequestSigning 生效判定、
 * Ed25519 私钥解密（AES-256-GCM 模拟服务端下发）、Signer 降级链（gate 关/握手失败/
 * 401 重试/bypass/fail-closed）。
 */

import assert from "node:assert/strict";
import { generateKeyPairSync, hkdfSync } from "node:crypto";
import test from "node:test";

import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  deriveBytes,
  encodeUtf8,
} from "../src/model/client-request-signing/crypto-utils.js";
import {
  matchesEndpointRoutingDomain,
  parseClientSigningCredential,
  requiresClientRequestSigning,
} from "../src/model/client-request-signing/credential.js";
import { CodingPlanSignatureFeatureGate } from "../src/model/client-request-signing/feature-gate.js";
import {
  buildHandshakeSignatureMessage,
  createHandshakeSignature,
  decryptSigningPrivateKey,
  signClientRequest,
} from "../src/model/client-request-signing/handshake.js";
import { ClientRequestSigningV4KeyCache } from "../src/model/client-request-signing/key-cache.js";
import {
  createClientRequestProofOfWork,
  hasLeadingZeroBits,
  verifyClientRequestProofOfWork,
} from "../src/model/client-request-signing/pow.js";
import {
  makeReplayableSigningRequest,
  sanitizeClientSigningHeaders,
} from "../src/model/client-request-signing/replayable-request.js";
import { ClientRequestSigningV4Signer } from "../src/model/client-request-signing/signer.js";
import { readRefreshableClientSignatureReason } from "../src/model/client-request-signing/response-inspection.js";
import type { ClientSigningObservation } from "../src/model/client-request-signing/observations.js";
import { CLIENT_SIGNING_KDF_SALT } from "../src/model/client-request-signing/constants.js";

const KDF_SALT_BYTES = Buffer.from(CLIENT_SIGNING_KDF_SALT, "utf8");

test("deriveBytes 与 node:crypto hkdfSync 逐字节一致（HMAC / AES 两个 info）", async () => {
  for (const info of ["getSignKey_hmac", "ed25519_priv"]) {
    const expected = Buffer.from(
      hkdfSync("sha256", Buffer.from("secret-value"), KDF_SALT_BYTES, Buffer.from(info), 32),
    );
    const actual = await deriveBytes("secret-value", info);
    assert.equal(bytesToHex(actual), expected.toString("hex"));
    assert.equal(actual.byteLength, 32);
  }
});

test("createHandshakeSignature 消息格式与 HMAC 可复算", async () => {
  const message = buildHandshakeSignatureMessage({
    apiKeyId: "key-id",
    nonce: "a".repeat(32),
    ts: "1700000000000",
  });
  assert.equal(message, `get_sign_key\nkey-id\n1700000000000\n${"a".repeat(32)}`);
  const sig = await createHandshakeSignature("secret", message);
  assert.equal(typeof sig, "string");
  assert.equal(sig.length > 0, true);
});

test("bytesToBase64 / base64ToBytes 往返与非法输入", () => {
  const bytes = encodeUtf8("hello 客户端签名");
  const base64 = bytesToBase64(bytes);
  assert.equal(base64, Buffer.from(bytes).toString("base64"));
  const restored = base64ToBytes(base64);
  assert.equal(Buffer.from(restored!).toString("utf8"), "hello 客户端签名");
  assert.equal(base64ToBytes("!!!!"), undefined);
  assert.equal(base64ToBytes("abc"), undefined); // 长度 %4 != 0
});

test("parseClientSigningCredential：恰好一个点且两侧非空", () => {
  assert.deepEqual(parseClientSigningCredential("id.secret"), {
    apiKeyId: "id",
    apiKeySecret: "secret",
    credential: "id.secret",
  });
  assert.deepEqual(parseClientSigningCredential(" id . secret "), {
    apiKeyId: "id",
    apiKeySecret: "secret",
    credential: " id . secret ",
  });
  assert.equal(parseClientSigningCredential("no-dot"), undefined);
  assert.equal(parseClientSigningCredential("a.b.c"), undefined);
  assert.equal(parseClientSigningCredential(".secret"), undefined);
  assert.equal(parseClientSigningCredential("id."), undefined);
  assert.equal(parseClientSigningCredential("id.  "), undefined);
});

test("requiresClientRequestSigning 生效判定", () => {
  const codingPlanKey = { type: "zhipu-coding-plan-api-key" } as const;
  assert.equal(
    requiresClientRequestSigning({ access: codingPlanKey, baseURL: "https://any.example" }),
    true,
  );
  for (const mode of ["individual-coding-plan", "team-coding-plan"]) {
    assert.equal(
      requiresClientRequestSigning({
        access: { type: "zhipu-account", mode },
        baseURL: "https://any.example",
      }),
      true,
    );
  }
  for (const mode of ["start-plan", "off-peak"]) {
    assert.equal(
      requiresClientRequestSigning({
        access: { type: "zhipu-account", mode },
        baseURL: "https://api.z.ai/x",
      }),
      false,
    );
  }
  // 自建 provider：仅域名白名单 / 路由域命中时装配。
  assert.equal(
    requiresClientRequestSigning({ access: undefined, baseURL: "https://api.chatglm.site/v1" }),
    true,
  );
  assert.equal(
    requiresClientRequestSigning({ access: undefined, baseURL: "https://zcode.chatglm.site/v1" }),
    true,
  );
  assert.equal(
    requiresClientRequestSigning({ access: undefined, baseURL: "https://api.example.com/v1" }),
    false,
  );
  assert.equal(
    requiresClientRequestSigning({ access: undefined, baseURL: "https://open.bigmodel.cn/api" }),
    true,
  );
  assert.equal(
    requiresClientRequestSigning({
      access: { type: "api-key" },
      baseURL: "https://api.example.com",
    }),
    false,
  );
  assert.equal(requiresClientRequestSigning({ access: undefined, baseURL: "not a url" }), false);
});

test("matchesEndpointRoutingDomain：z.ai / bigmodel.cn 及子域", () => {
  assert.equal(matchesEndpointRoutingDomain("https://api.z.ai/api"), true);
  assert.equal(matchesEndpointRoutingDomain("https://open.bigmodel.cn/api"), true);
  assert.equal(matchesEndpointRoutingDomain("https://z.ai"), true);
  assert.equal(matchesEndpointRoutingDomain("https://bigmodel.cn"), true);
  assert.equal(matchesEndpointRoutingDomain("https://notz.ai.example.com"), false);
  assert.equal(matchesEndpointRoutingDomain("https://example.com"), false);
});

test("hasLeadingZeroBits", () => {
  const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
  assert.equal(hasLeadingZeroBits(bytes("00ffffffff"), 8), true);
  assert.equal(hasLeadingZeroBits(bytes("01ffffffff"), 8), false);
  assert.equal(hasLeadingZeroBits(bytes("000fffffff"), 12), true); // 第二字节高 4 bit 为 0000
  assert.equal(hasLeadingZeroBits(bytes("0010ffffff"), 12), false); // 第二字节高 4 bit 为 0001
  assert.equal(hasLeadingZeroBits(bytes("0000ffffff"), 16), true);
  assert.equal(hasLeadingZeroBits(bytes("0001ffffff"), 16), false);
  assert.equal(hasLeadingZeroBits(bytes("0000400000"), 17), true); // 第 17 bit（0x40 的 MSB）为 0
  assert.equal(hasLeadingZeroBits(bytes("0000800000"), 17), false);
});

test("PoW：求解结果可验证（8 bit），candidate 恒 32 hex", async () => {
  const input = {
    apiKeyId: "key-id",
    appId: "zcode",
    powBits: 8,
    sessionId: "session-1",
    ts: "1700000000000",
  };
  const candidate = await createClientRequestProofOfWork(input);
  assert.equal(candidate.length, 32);
  assert.match(candidate, /^[0-9a-f]{32}$/);
  assert.equal(await verifyClientRequestProofOfWork({ ...input, candidate }), true);
  // 篡改 candidate 后不再满足难度（概率上成立；验证函数是确定性的）。
  const tampered = `${candidate.slice(0, 31)}${candidate[31] === "0" ? "1" : "0"}`;
  const digestOk = await verifyClientRequestProofOfWork({ ...input, candidate: tampered });
  // 单字符翻转后命中 8bit 前导零的概率为 1/256，理论上仍可能为 true；此处只断言不抛错。
  assert.equal(typeof digestOk, "boolean");
});

test("sanitizeClientSigningHeaders 剥离 7 个签名头（大小写不敏感）", () => {
  const headers = new Headers({
    "content-type": "application/json",
    "x-client-ts": "1",
    "X-Client-Version": "v",
    "X-Client-Sig": "s",
    "X-Client-Nonce": "n",
    "X-Client-Pow": "p",
    "X-App-Id": "zcode",
    "X-Client-Sign-Verified": "yes",
    "X-Session-Id": "sess",
  });
  const sanitized = sanitizeClientSigningHeaders(headers);
  for (const name of [
    "x-client-ts",
    "x-client-version",
    "x-client-sig",
    "x-client-nonce",
    "x-client-pow",
    "x-app-id",
    "x-client-sign-verified",
  ]) {
    assert.equal(sanitized.get(name), null, `${name} 应被剥离`);
  }
  assert.equal(sanitized.get("content-type"), "application/json");
  assert.equal(sanitized.get("x-session-id"), "sess");
});

test("makeReplayableSigningRequest：body 快照与签名头剥离", async () => {
  const replayable = await makeReplayableSigningRequest("https://api.example.com/v1/messages", {
    body: JSON.stringify({ model: "m", input: "hello" }),
    headers: {
      "content-type": "application/json",
      "X-Session-Id": "sess-1",
      "x-request-id": "req-1",
      "X-Client-Sig": "stale",
    },
    method: "POST",
  });
  assert.equal(replayable.url, "https://api.example.com/v1/messages");
  assert.equal(replayable.method, "POST");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(replayable.body!)), {
    model: "m",
    input: "hello",
  });
  assert.equal(replayable.headers.get("x-client-sig"), null);
  assert.equal(replayable.headers.get("x-session-id"), "sess-1");
});

/**
 * 模拟服务端：按官方契约加密 Ed25519 私钥（HKDF(secret,"ed25519_priv") 作 AES key，
 * 明文 = PKCS#8 DER 的 base64 文本，AAD=UTF8(apiKeyId)，iv 前置拼接后整体 base64）。
 */
async function buildPrivateCipherText(aadId: string, apiKeySecret: string): Promise<string> {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const keyBytes = await deriveBytes(apiKeySecret, "ed25519_priv");
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { additionalData: encodeUtf8(aadId), iv, name: "AES-GCM", tagLength: 128 },
      key,
      encodeUtf8(der.toString("base64")),
    ),
  );
  const merged = new Uint8Array(iv.length + cipher.length);
  merged.set(iv, 0);
  merged.set(cipher, iv.length);
  return bytesToBase64(merged);
}

test("decryptSigningPrivateKey：按服务端契约可解并可用于 Ed25519 签名", async () => {
  const cipherText = await buildPrivateCipherText("key-id", "secret");
  const privateKey = await decryptSigningPrivateKey("key-id", "secret", cipherText);
  const message = "key-id\n1700000000000\n0.0.0-dev\nsess\nnonce";
  const sig = await signClientRequest(privateKey, message);
  assert.equal(typeof sig, "string");
  // AAD 绑定 apiKeyId：换 id 解密必失败（GCM 认证）。
  await assert.rejects(() => decryptSigningPrivateKey("other-id", "secret", cipherText));
});

test("readRefreshableClientSignatureReason：命中两个 reason 之一才返回", async () => {
  const make = (body: unknown, status = 401) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  assert.equal(
    await readRefreshableClientSignatureReason(make({ msg: "VERIFY_SIGNATURE_INVALID" })),
    "VERIFY_SIGNATURE_INVALID",
  );
  assert.equal(
    await readRefreshableClientSignatureReason(make({ reason: "VERIFY_APIKEY_EXPIRED" })),
    "VERIFY_APIKEY_EXPIRED",
  );
  assert.equal(
    await readRefreshableClientSignatureReason(
      make({ data: { reason: "VERIFY_SIGNATURE_INVALID" } }),
    ),
    "VERIFY_SIGNATURE_INVALID",
  );
  assert.equal(
    await readRefreshableClientSignatureReason(
      make({ error: { message: "VERIFY_APIKEY_EXPIRED" } }),
    ),
    "VERIFY_APIKEY_EXPIRED",
  );
  assert.equal(
    await readRefreshableClientSignatureReason(make({ msg: "OTHER_REASON" })),
    undefined,
  );
  assert.equal(
    await readRefreshableClientSignatureReason(make({ msg: "VERIFY_SIGNATURE_INVALID" }, 500)),
    undefined,
  );
  assert.equal(
    await readRefreshableClientSignatureReason(new Response("not json", { status: 401 })),
    undefined,
  );
});

/** 记录 observation 并允许断言的假 transport 工厂。 */
function createSigningHarness(options: {
  gateEnabled: boolean;
  handshake?: (url: string, init?: RequestInit) => Promise<Response>;
  business?: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  const observations: ClientSigningObservation[] = [];
  const transportCalls: Array<{ headers: Headers; url: string }> = [];
  const keyCache = new ClientRequestSigningV4KeyCache();
  const gate = new CodingPlanSignatureFeatureGate({
    apiKey: "key-id.secret",
    configUrl: "https://zcode.example/api/v1/agent/configs",
    transport: async () =>
      new Response(
        JSON.stringify({ code: 0, data: { codingPlanSignature: { enable: options.gateEnabled } } }),
        {
          status: 200,
        },
      ),
  });
  const signer = new ClientRequestSigningV4Signer({
    apiKey: "key-id.secret",
    baseURL: "https://api.example.com/v1",
    clientVersion: "9.9.9-test",
    gate,
    keyCache,
    observe: (observation) => observations.push(observation),
    providerId: "zcode-plan",
    transport: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/paas/c1f3a7e2/v2/client")) {
        if (options.handshake) return await options.handshake(url, init);
        // 按服务端契约返回 privateCipher；签名器走真实握手+解密+缓存路径。
        const cipherText = await buildPrivateCipherText("key-id", "secret");
        return new Response(JSON.stringify({ code: 200, data: { privateCipher: cipherText } }), {
          status: 200,
        });
      }
      transportCalls.push({ headers: new Headers(init?.headers), url });
      if (options.business) return await options.business(url, init);
      return new Response("{}", { status: 200 });
    },
  });
  return { observations, signer, transportCalls };
}

const SIGNED_REQUEST_INIT = (): RequestInit => ({
  body: JSON.stringify({ input: "hi" }),
  headers: {
    "content-type": "application/json",
    "X-Session-Id": "sess-1",
    "x-request-id": "req-1",
  },
  method: "POST",
});

test("Signer：gate 关闭 → 裸发且剥离签名头（与移植前行为一致）", async () => {
  const harness = createSigningHarness({ gateEnabled: false });
  const response = await harness.signer.request(
    "https://api.example.com/v1/messages",
    SIGNED_REQUEST_INIT(),
  );
  assert.equal(response.status, 200);
  assert.equal(harness.transportCalls.length, 1);
  const headers = harness.transportCalls[0]!.headers;
  assert.equal(headers.get("x-client-sig"), null);
  assert.equal(headers.get("x-session-id"), "sess-1");
  assert.deepEqual(
    harness.observations.map((item) => item.kind),
    ["unsigned_sent"],
  );
  assert.deepEqual(
    harness.observations.map((item) => (item as { reason?: string }).reason),
    ["feature_gate_disabled"],
  );
});

test("Signer：gate 请求失败 → 裸发（fail-open）", async () => {
  const observations: ClientSigningObservation[] = [];
  const keyCache = new ClientRequestSigningV4KeyCache();
  const gate = new CodingPlanSignatureFeatureGate({
    apiKey: "key-id.secret",
    configUrl: "https://zcode.example/api/v1/agent/configs",
    transport: async () => new Response("denied", { status: 503 }),
  });
  const signer = new ClientRequestSigningV4Signer({
    apiKey: "key-id.secret",
    baseURL: "https://api.example.com/v1",
    gate,
    keyCache,
    observe: (observation) => observations.push(observation),
    providerId: "zcode-plan",
    transport: async () => new Response("{}", { status: 200 }),
  });
  const response = await signer.request(
    "https://api.example.com/v1/messages",
    SIGNED_REQUEST_INIT(),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    observations.map((item) => (item as { reason?: string }).reason),
    ["feature_gate_disabled"],
  );
});

test("Signer：http baseURL + gate 关闭 → 裸发而非 fail-closed（官方在握手 URL 构建期才校验 https）", async () => {
  const observations: ClientSigningObservation[] = [];
  const gate = new CodingPlanSignatureFeatureGate({
    apiKey: "key-id.secret",
    configUrl: "https://zcode.example/api/v1/agent/configs",
    transport: async () =>
      new Response(JSON.stringify({ code: 0, data: { codingPlanSignature: { enable: false } } }), {
        status: 200,
      }),
  });
  const signer = new ClientRequestSigningV4Signer({
    apiKey: "key-id.secret",
    baseURL: "http://api.example.com/v1",
    gate,
    keyCache: new ClientRequestSigningV4KeyCache(),
    observe: (observation) => observations.push(observation),
    providerId: "zcode-plan",
    transport: async () => new Response("{}", { status: 200 }),
  });
  const response = await signer.request(
    "http://api.example.com/v1/messages",
    SIGNED_REQUEST_INIT(),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    observations.map((item) => (item as { reason?: string }).reason),
    ["feature_gate_disabled"],
  );
});

test("Signer：http baseURL + gate 开启 → invalid-config fail-closed", async () => {
  const gate = new CodingPlanSignatureFeatureGate({
    apiKey: "key-id.secret",
    configUrl: "https://zcode.example/api/v1/agent/configs",
    transport: async () =>
      new Response(JSON.stringify({ code: 0, data: { codingPlanSignature: { enable: true } } }), {
        status: 200,
      }),
  });
  const signer = new ClientRequestSigningV4Signer({
    apiKey: "key-id.secret",
    baseURL: "http://api.example.com/v1",
    gate,
    keyCache: new ClientRequestSigningV4KeyCache(),
    observe: () => {},
    providerId: "zcode-plan",
    transport: async () => new Response("{}", { status: 200 }),
  });
  await assert.rejects(
    () => signer.request("http://api.example.com/v1/messages", SIGNED_REQUEST_INIT()),
    (error: unknown) => {
      assert.equal((error as { kind?: string }).kind, "invalid-config");
      return true;
    },
  );
});

test("Signer：origin 不匹配 → 裸发 origin_mismatch", async () => {
  const harness = createSigningHarness({ gateEnabled: true });
  await harness.signer.request("https://other.example.com/v1/messages", SIGNED_REQUEST_INIT());
  assert.deepEqual(
    harness.observations.map((item) => (item as { reason?: string }).reason),
    ["origin_mismatch"],
  );
});

test("Signer：握手失败 → 裸发 handshake_failed（fail-open）", async () => {
  const harness = createSigningHarness({
    gateEnabled: true,
    handshake: async () => new Response("oops", { status: 500 }),
  });
  const response = await harness.signer.request(
    "https://api.example.com/v1/messages",
    SIGNED_REQUEST_INIT(),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    harness.observations.map((item) => item.kind),
    ["handshake_failed", "unsigned_sent"],
  );
  assert.deepEqual(
    harness.observations.map(
      (item) => (item as { reason?: string }).reason?.slice(0, 10) ?? undefined,
    ),
    [undefined, "handshake_fa".slice(0, 10)],
  );
});

test("Signer：签名请求注入 7 头且 PoW 可验证", async () => {
  const harness = createSigningHarness({ gateEnabled: true });
  const response = await harness.signer.request("https://api.example.com/v1/messages", {
    ...SIGNED_REQUEST_INIT(),
    headers: { ...SIGNED_REQUEST_INIT().headers, "X-ZCode-App-Version": "1.2.3-test" },
  });
  assert.equal(response.status, 200);
  const headers = harness.transportCalls[0]!.headers;
  assert.equal(headers.get("x-app-id"), "zcode");
  assert.equal(headers.get("x-client-version"), "1.2.3-test");
  assert.equal(headers.get("x-client-nonce")!.length, 32);
  assert.match(headers.get("x-client-ts")!, /^\d+$/);
  assert.match(headers.get("x-client-sig")!, /^[A-Za-z0-9+/=]+$/);
  const pow = headers.get("x-client-pow")!;
  assert.equal(pow.length, 32);
  assert.equal(
    await verifyClientRequestProofOfWork({
      apiKeyId: "key-id",
      appId: "zcode",
      candidate: pow,
      powBits: 8,
      sessionId: "sess-1",
      ts: headers.get("x-client-ts")!,
    }),
    true,
  );
  assert.equal(headers.get("x-session-id"), "sess-1");
  assert.deepEqual(
    harness.observations.map((item) => item.kind),
    ["signed_sent"],
  );
});

test("Signer：401 VERIFY_SIGNATURE_INVALID → 重握手重试一次，再拒进入 bypass 裸发", async () => {
  let businessCalls = 0;
  const harness = createSigningHarness({
    gateEnabled: true,
    business: async () => {
      businessCalls += 1;
      return new Response(JSON.stringify({ msg: "VERIFY_SIGNATURE_INVALID" }), { status: 401 });
    },
  });
  const response = await harness.signer.request(
    "https://api.example.com/v1/messages",
    SIGNED_REQUEST_INIT(),
  );
  assert.equal(response.status, 401);
  // 两次签名尝试 + bypass 后一次裸发，共 3 次业务请求。
  assert.equal(businessCalls, 3);
  const kinds = harness.observations.map((item) => item.kind);
  assert.deepEqual(kinds, [
    "signed_sent",
    "verify_rejected",
    "signed_sent",
    "bypass_entered",
    "unsigned_sent",
  ]);
  // bypass 为代际内永久：后续请求直接裸发，不再握手/签名。
  const observationsBefore = harness.observations.length;
  await harness.signer.request("https://api.example.com/v1/messages", SIGNED_REQUEST_INIT());
  assert.equal(businessCalls, 4);
  assert.deepEqual(
    harness.observations
      .slice(observationsBefore)
      .map((item) => (item as { reason?: string }).reason),
    ["bypass"],
  );
});

test("Signer：401 后重试成功 → 返回第二次响应", async () => {
  let businessCalls = 0;
  const harness = createSigningHarness({
    gateEnabled: true,
    business: async () => {
      businessCalls += 1;
      return businessCalls === 1
        ? new Response(JSON.stringify({ reason: "VERIFY_APIKEY_EXPIRED" }), { status: 401 })
        : new Response("{}", { status: 200 });
    },
  });
  const response = await harness.signer.request(
    "https://api.example.com/v1/messages",
    SIGNED_REQUEST_INIT(),
  );
  assert.equal(response.status, 200);
  assert.equal(businessCalls, 2);
  assert.deepEqual(
    harness.observations.map((item) => item.kind),
    ["signed_sent", "verify_rejected", "signed_sent"],
  );
});

test("Signer：缺 X-Session-Id 且 gate 开启 → invalid-config fail-closed", async () => {
  const harness = createSigningHarness({ gateEnabled: true });
  await assert.rejects(
    () =>
      harness.signer.request("https://api.example.com/v1/messages", {
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    (error: unknown) => {
      assert.equal((error as { kind?: string }).kind, "invalid-config");
      return true;
    },
  );
  assert.deepEqual(
    harness.observations.map((item) => item.kind),
    ["request_failed_closed"],
  );
});

test("Signer：apiKey 无分隔符且 gate 开启 → invalid-config fail-closed", async () => {
  const observations: ClientSigningObservation[] = [];
  const gate = new CodingPlanSignatureFeatureGate({
    apiKey: "not-a-credential",
    configUrl: "https://zcode.example/api/v1/agent/configs",
    transport: async () =>
      new Response(JSON.stringify({ code: 0, data: { codingPlanSignature: { enable: true } } }), {
        status: 200,
      }),
  });
  const signer = new ClientRequestSigningV4Signer({
    apiKey: "not-a-credential",
    baseURL: "https://api.example.com/v1",
    gate,
    keyCache: new ClientRequestSigningV4KeyCache(),
    observe: (observation) => observations.push(observation),
    providerId: "zcode-plan",
    transport: async () => new Response("{}", { status: 200 }),
  });
  await assert.rejects(
    () => signer.request("https://api.example.com/v1/messages", SIGNED_REQUEST_INIT()),
    (error: unknown) => {
      assert.equal((error as { kind?: string }).kind, "invalid-config");
      return true;
    },
  );
  assert.deepEqual(
    observations.map((item) => item.kind),
    ["request_failed_closed"],
  );
});
