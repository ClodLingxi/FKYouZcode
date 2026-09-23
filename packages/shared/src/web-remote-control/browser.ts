// ============================================================
// Web Remote Control —— 浏览器端入口（手机 Web 客户端专用）。
// 只包含同构模块：协议常量/信封 schema/QR 解析 + rpc-frame 编解码与收发端。
// node:crypto 的配对 proof 在 pairingCryptoNode.ts，不在此入口；
// Web 端用 WebCrypto 实现同一算法（客户端内 webCryptoRelayAuthProof）。
export * from "./protocol.js";
export * from "./rpcFrameCodec.js";
export * from "./rpcFrameSender.js";
export * from "./rpcFrameReceiver.js";
