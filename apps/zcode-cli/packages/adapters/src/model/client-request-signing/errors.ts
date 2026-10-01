/**
 * Client Request Signing V4 错误类型。
 *
 * 失败语义（逆向官方行为，SPEC.md §6）：
 * - failOpenEligible：握手超时/网络/协议/服务端/业务码/解密失败 —— 上层降级为无签名裸发；
 * - fail-closed：invalid-config（非 HTTPS baseURL / apiKey 无分隔符 / 缺 X-Session-Id）、
 *   业务签名与 PoW 的密码学错误、disposed —— 直接抛出，中断本次请求。
 */

export type ClientRequestSigningV4ErrorKind =
  | "invalid-config"
  | "handshake-timeout"
  | "handshake-network"
  | "handshake-protocol"
  | "handshake-server"
  | "handshake-business"
  | "cryptography"
  | "disposed";

export interface ClientRequestSigningV4ErrorOptions {
  readonly businessCode?: number | string;
  readonly failOpenEligible: boolean;
  readonly httpStatus?: number;
  readonly kind: ClientRequestSigningV4ErrorKind;
  readonly reason?: string;
}

export class ClientRequestSigningV4Error extends Error {
  readonly kind: ClientRequestSigningV4ErrorKind;
  readonly failOpenEligible: boolean;
  readonly reason?: string;
  readonly httpStatus?: number;
  readonly businessCode?: number | string;

  constructor(message: string, options: ClientRequestSigningV4ErrorOptions) {
    super(message);
    this.name = "ClientRequestSigningV4Error";
    this.kind = options.kind;
    this.failOpenEligible = options.failOpenEligible;
    this.reason = options.reason;
    this.httpStatus = options.httpStatus;
    this.businessCode = options.businessCode;
  }
}

export function isClientRequestSigningV4Error(
  error: unknown,
): error is ClientRequestSigningV4Error {
  return error instanceof ClientRequestSigningV4Error;
}
