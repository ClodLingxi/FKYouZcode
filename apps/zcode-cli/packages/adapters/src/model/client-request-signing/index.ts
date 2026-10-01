/**
 * Client Request Signing V4 —— 模型请求客户端签名 / PoW（逆向规格见同目录 SPEC.md）。
 *
 * 仅被 `model-execution.ts` 装配引用；行为常量必须与官方网关逐字节一致。
 */

export {
  CLIENT_SIGNING_APP_ID,
  CLIENT_SIGNING_CONFIG_PATH,
  CLIENT_SIGNING_DEFAULT_CLIENT_VERSION,
  CLIENT_SIGNING_DOMAIN_WHITELIST,
  CLIENT_SIGNING_HANDSHAKE_PATH,
  CLIENT_SIGNING_KDF_INFO_AES,
  CLIENT_SIGNING_KDF_INFO_HMAC,
  CLIENT_SIGNING_KDF_SALT,
  CLIENT_SIGNING_POW_BITS,
  CLIENT_SIGNING_STRIPPED_HEADERS,
} from "./constants.js";
export {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  deriveBytes,
  encodeUtf8,
  randomHex,
  sha256,
} from "./crypto-utils.js";
export {
  matchesEndpointRoutingDomain,
  parseClientSigningCredential,
  requiresClientRequestSigning,
  type ClientSigningAccessLike,
  type ClientSigningCredential,
} from "./credential.js";
export {
  ClientRequestSigningV4Error,
  isClientRequestSigningV4Error,
  type ClientRequestSigningV4ErrorKind,
} from "./errors.js";
export { CodingPlanSignatureFeatureGate } from "./feature-gate.js";
export {
  buildHandshakeSignatureMessage,
  createHandshakeSignature,
  decryptSigningPrivateKey,
  signClientRequest,
} from "./handshake.js";
export { ClientRequestSigningV4KeyCache } from "./key-cache.js";
export {
  AiSdkClientRequestSigningState,
  ClientRequestSigningV4Manager,
  type AiSdkClientRequestSigningStateOptions,
  type ClientRequestSigningV4ManagerCreateFetchInput,
} from "./manager.js";
export type {
  ClientSigningObservation,
  ClientSigningObservationContext,
  ClientSigningObserver,
} from "./observations.js";
export {
  createClientRequestProofOfWork,
  hasLeadingZeroBits,
  verifyClientRequestProofOfWork,
} from "./pow.js";
export {
  buildSigningRequestInit,
  makeReplayableSigningRequest,
  sanitizeClientSigningHeaders,
} from "./replayable-request.js";
export { readRefreshableClientSignatureReason } from "./response-inspection.js";
export {
  ClientRequestSigningV4Signer,
  type ClientRequestSigningV4SignerOptions,
} from "./signer.js";
