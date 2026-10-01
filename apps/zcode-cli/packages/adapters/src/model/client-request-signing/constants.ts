/**
 * Client Request Signing V4 协议常量。
 *
 * 全部值必须与官方网关逐字节一致（逆向自官方闭源 bundle，偏移见 SPEC.md）：
 * 任何一处偏差的后果不是报错，而是服务端持续 401 验签拒绝 → 两轮后客户端静默
 * bypass 裸发，签名机制表现为“静默失效”，只能靠遥测发现。
 */

/** 握手端点路径，挂在业务 baseURL 的 origin 上。 */
export const CLIENT_SIGNING_HANDSHAKE_PATH = "/api/paas/c1f3a7e2/v2/client";

/** 握手 HMAC 消息首行的 action 名。 */
export const CLIENT_SIGNING_HANDSHAKE_ACTION = "get_sign_key";

/** Feature gate 端点路径，挂在 ZCode 平台 origin 上。 */
export const CLIENT_SIGNING_CONFIG_PATH = "/api/v1/agent/configs";

/** Gate 结果缓存 TTL（1 小时）。 */
export const CLIENT_SIGNING_GATE_CACHE_TTL_MS = 3_600_000;

/** Gate 请求超时。 */
export const CLIENT_SIGNING_GATE_TIMEOUT_MS = 15_000;

/** 握手请求超时。 */
export const CLIENT_SIGNING_HANDSHAKE_TIMEOUT_MS = 10_000;

/** 随机 nonce 字节数（16 字节 → 32 hex 字符）。 */
export const CLIENT_SIGNING_NONCE_BYTES = 16;

/** PoW 难度：SHA-256 摘要的前导零 bit 数。客户端硬编码 8。 */
export const CLIENT_SIGNING_POW_BITS = 8;

/** PoW 随机前缀字节数（12 字节 → 24 hex 字符）。 */
export const CLIENT_SIGNING_POW_PREFIX_BYTES = 12;

/** PoW 计数上限（32 bit，counter 恒格式化为 8 位 hex）。 */
export const CLIENT_SIGNING_POW_MAX_COUNTER = 4_294_967_295;

/** X-App-Id 头的值，同时是 PoW seed 输入的 appId。 */
export const CLIENT_SIGNING_APP_ID = "zcode";

/** HKDF salt（UTF-8），派生握手 HMAC key 与解密 AES key 共用。 */
export const CLIENT_SIGNING_KDF_SALT = "WD_CLIENT_SIGN_KDF_SALT";

/** HKDF info：握手 HMAC key。 */
export const CLIENT_SIGNING_KDF_INFO_HMAC = "getSignKey_hmac";

/** HKDF info：privateCipher 的 AES-256-GCM key。 */
export const CLIENT_SIGNING_KDF_INFO_AES = "ed25519_priv";

/** HKDF 输出长度（bit）。 */
export const CLIENT_SIGNING_KDF_LENGTH_BITS = 256;

/** AES-GCM IV 长度（字节），取 privateCipher 前 12 字节。 */
export const CLIENT_SIGNING_CIPHER_IV_BYTES = 12;

/** AES-GCM tag 长度（bit）。 */
export const CLIENT_SIGNING_CIPHER_TAG_BITS = 128;

/** 触发「重新握手 + 重试一次」的 401 reason 集合。 */
export const CLIENT_SIGNING_REFRESH_REASONS: ReadonlySet<string> = new Set([
  "VERIFY_SIGNATURE_INVALID",
  "VERIFY_APIKEY_EXPIRED",
]);

/**
 * 每次发送前从请求 headers 删除的头（含服务端回包标记 X-Client-Sign-Verified），
 * 防止伪造或陈旧验证标记随重试回放。
 */
export const CLIENT_SIGNING_STRIPPED_HEADERS: readonly string[] = [
  "X-Client-Ts",
  "X-Client-Version",
  "X-Client-Sig",
  "X-Client-Nonce",
  "X-Client-Pow",
  "X-App-Id",
  "X-Client-Sign-Verified",
];

/** 签名输入依赖的会话头（Headers 大小写不敏感）。 */
export const CLIENT_SIGNING_SESSION_HEADER = "X-Session-Id";

/** clientVersion 的请求头来源（大小写不敏感）。 */
export const CLIENT_SIGNING_VERSION_HEADER = "X-ZCode-App-Version";

/** 缺省 clientVersion（与官方 bundle 的 `__ZCODE_VERSION__ ?? "0.0.0-dev"` 对应）。 */
export const CLIENT_SIGNING_DEFAULT_CLIENT_VERSION = "0.0.0-dev";

/** 握手业务错误 reason 须匹配的格式（防把任意 msg 当业务码）。 */
export const CLIENT_SIGNING_HANDSHAKE_REASON_PATTERN = /^HANDSHAKE_[A-Z_]+$/u;

/** 签名生效的域名白名单（z.ai / bigmodel.cn 路由域另由路由表判定）。 */
export const CLIENT_SIGNING_DOMAIN_WHITELIST: ReadonlySet<string> = new Set([
  "api.chatglm.site",
  "zcode.chatglm.site",
]);

/** 签名生效的 endpoint 路由域后缀（z.ai / bigmodel.cn 及其子域）。 */
export const CLIENT_SIGNING_ROUTING_DOMAIN_SUFFIXES: readonly string[] = ["z.ai", "bigmodel.cn"];
