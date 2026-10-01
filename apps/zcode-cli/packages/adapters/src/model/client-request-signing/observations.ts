/**
 * Client Request Signing V4 observation 载荷（逆向官方 `AiSdkModelExecution.observeClientSigning`
 * 的回调签名，SPEC.md §7）：observation + 归因上下文（providerId / x-request-id / x-session-id）。
 */

export type ClientSigningObservation =
  | { readonly kind: "signed_sent" }
  | { readonly kind: "unsigned_sent"; readonly reason: string }
  | {
      readonly kind: "handshake_failed";
      readonly businessCode?: number | string;
      readonly errorKind: string;
      readonly httpStatus?: number;
      readonly reason?: string;
    }
  | { readonly kind: "verify_rejected"; readonly reason: string; readonly signedAttempt: number }
  | { readonly kind: "bypass_entered" }
  | { readonly kind: "request_failed_closed"; readonly errorKind: string };

export interface ClientSigningObservationContext {
  readonly providerId: string;
  readonly requestId?: string;
  readonly sessionId?: string;
}

export type ClientSigningObserver = (
  observation: ClientSigningObservation,
  context: ClientSigningObservationContext,
) => void;
