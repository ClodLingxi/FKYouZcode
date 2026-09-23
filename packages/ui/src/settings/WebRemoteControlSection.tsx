// 设置页 · Web Remote Control（手机远控）卡片：开启/停止/重置配对 + 配对二维码。
// QR 即 bearer 凭据：渲染成图供手机扫码（自建 relay 时二维码指向自建域名）。
import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import type { WebRemoteControlStatus } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";

const STATE_LABEL_IDS: Record<WebRemoteControlStatus["state"], string> = {
  disabled: "settings.webRemote.state.disabled",
  pairing: "settings.webRemote.state.pairing",
  connecting: "settings.webRemote.state.connecting",
  ready: "settings.webRemote.state.ready",
  reconnecting: "settings.webRemote.state.reconnecting",
};

export function WebRemoteControlSection() {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [status, setStatus] = useState<WebRemoteControlStatus | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const supported = typeof platform.webRemoteGetState === "function";

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    platform
      .webRemoteGetState?.()
      .then((state) => {
        if (!cancelled) setStatus(state);
      })
      .catch(() => {
        if (!cancelled) setStatus({ state: "disabled", qrUrl: null });
      });
    return () => {
      cancelled = true;
    };
  }, [platform, supported]);

  useEffect(() => {
    const qrUrl = status?.qrUrl;
    if (!qrUrl) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(qrUrl, { margin: 1, width: 220 })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [status?.qrUrl]);

  const run = useCallback(
    async (action: () => Promise<WebRemoteControlStatus>) => {
      setBusy(true);
      try {
        setStatus(await action());
      } catch {
        // 状态保持不变；失败详情在 main 进程日志
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  if (!supported) return null;

  const enabled = status !== null && status.state !== "disabled";
  const stateLabel = status
    ? intl.formatMessage({ id: STATE_LABEL_IDS[status.state] ?? status.state })
    : "";

  return (
    <section className="rounded-xl rounded-xl border border-border bg-surface p-5" data-testid="web-remote-control">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.webRemote.title" })}
          </h3>
          <p className="mt-1 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.webRemote.description" })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {enabled ? (
            <button
              type="button"
              className="rounded-lg border border-border px-3 py-1.5 text-ui-sm hover:bg-surface-hover"
              disabled={busy}
              onClick={() => void run(() => platform.webRemoteStop!())}
            >
              {intl.formatMessage({ id: "settings.webRemote.stop" })}
            </button>
          ) : (
            <button
              type="button"
              className="rounded-lg bg-accent px-3 py-1.5 text-ui-sm text-white disabled:opacity-50"
              disabled={busy}
              onClick={() => void run(() => platform.webRemoteStart!())}
            >
              {intl.formatMessage({ id: "settings.webRemote.start" })}
            </button>
          )}
          <button
            type="button"
            className="rounded-lg border border-border px-3 py-1.5 text-ui-sm text-foreground-subtle hover:bg-surface-hover"
            disabled={busy || !enabled}
            title={intl.formatMessage({ id: "settings.webRemote.resetHint" })}
            onClick={() => {
              if (
                window.confirm(intl.formatMessage({ id: "settings.webRemote.resetConfirm" }))
              ) {
                void run(() => platform.webRemoteResetPairing!());
              }
            }}
          >
            {intl.formatMessage({ id: "settings.webRemote.reset" })}
          </button>
        </div>
      </div>

      {status ? (
        <div className="mt-4 flex items-start gap-5">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "settings.webRemote.status" })}: {stateLabel}
            </p>
            {status.qrUrl ? (
              <p className="break-all text-ui-xs text-foreground-subtlest">
                {status.usingCustomRelay
                  ? intl.formatMessage({ id: "settings.webRemote.customRelay" })
                  : null}
              </p>
            ) : null}
          </div>
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt={intl.formatMessage({ id: "settings.webRemote.qrAlt" })}
              className="h-[220px] w-[220px] shrink-0 rounded-lg border border-border bg-white p-1"
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
