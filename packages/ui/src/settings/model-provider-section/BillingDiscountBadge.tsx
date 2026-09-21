import type {
  CodingPlanBillingDiscountConfig,
  CodingPlanBillingDiscountCopy,
} from "@zcode/shared";
import { InfoIcon, SparklesIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { cn } from "@/components/lib/utils.js";

// 150% 配额活动徽章：文案来自 client/configs 的 codingPlanBillingDiscount（按 locale 下发）。
// 活动折扣本身在服务端计费侧按账号生效；徽章只负责展示，读取失败静默隐藏。
const BILLING_DISCOUNT_CACHE_TTL_MS = 60 * 60 * 1000;
let billingDiscountCache: {
  config: CodingPlanBillingDiscountConfig | null;
  expiresAt: number;
} | null = null;
let billingDiscountRequest: Promise<CodingPlanBillingDiscountConfig | null> | null = null;

function normalizeCopyValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveCopy(
  config: CodingPlanBillingDiscountConfig | null,
  locale: string,
): CodingPlanBillingDiscountCopy {
  const raw = config?.[locale] ?? config?.["zh-CN"] ?? config?.["en-US"];
  if (!raw || typeof raw !== "object") return {};
  return {
    badgeBody: normalizeCopyValue(raw.badgeBody),
    cardTitle: normalizeCopyValue(raw.cardTitle),
    cardBody: normalizeCopyValue(raw.cardBody),
    infoTitle: normalizeCopyValue(raw.infoTitle),
    infoBody: normalizeCopyValue(raw.infoBody),
  };
}

async function loadBillingDiscount(
  service: NonNullable<
    ReturnType<typeof useOptionalServices>
  >["codingPlanSubscriptionService"],
): Promise<CodingPlanBillingDiscountConfig | null> {
  if (billingDiscountCache && billingDiscountCache.expiresAt > Date.now()) {
    return billingDiscountCache.config;
  }
  if (!billingDiscountRequest) {
    billingDiscountRequest = service
      .getBillingDiscount()
      .catch((error) => {
        logger.warn("[BillingDiscountBadge] 活动文案读取失败", {
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        return null;
      })
      .finally(() => {
        billingDiscountRequest = null;
      });
  }
  const config = await billingDiscountRequest;
  billingDiscountCache = { config, expiresAt: Date.now() + BILLING_DISCOUNT_CACHE_TTL_MS };
  return config;
}

export function useBillingDiscount(enabled = true) {
  const services = useOptionalServices();
  const service = services?.codingPlanSubscriptionService;
  const [config, setConfig] = useState<CodingPlanBillingDiscountConfig | null>(
    () => billingDiscountCache?.config ?? null,
  );

  useEffect(() => {
    if (!enabled || !service || typeof service.getBillingDiscount !== "function") return;
    let cancelled = false;
    loadBillingDiscount(service)
      .then((result) => {
        if (!cancelled) setConfig(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled, service]);

  const refresh = useCallback(async () => {
    if (!service || typeof service.getBillingDiscount !== "function") return;
    billingDiscountCache = null;
    const result = await loadBillingDiscount(service);
    setConfig(result);
  }, [service]);

  return { config, refresh };
}

export function BillingDiscountBadge({ className }: { className?: string }) {
  const { locale } = useZCodeIntl();
  const { config } = useBillingDiscount();
  const copy = resolveCopy(config, locale);
  if (!copy.badgeBody) return null;

  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      <Popover>
        <PopoverTrigger asChild>
          <span
            role="button"
            tabIndex={0}
            className="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-ui-xs leading-none text-white button-gradient dark:bg-[#484A58]"
          >
            <SparklesIcon className="size-3" />
            {copy.badgeBody}
            {copy.infoTitle || copy.infoBody ? (
              <InfoIcon className="size-3 shrink-0 text-white/90" />
            ) : null}
          </span>
        </PopoverTrigger>
        {copy.infoTitle || copy.infoBody ? (
          <PopoverContent className="max-h-[min(82vh,640px)] max-w-lg gap-2 overflow-hidden p-3">
            {copy.infoTitle ? (
              <div className="text-ui-base font-semibold text-foreground">{copy.infoTitle}</div>
            ) : null}
            {copy.infoBody ? (
              <div className="whitespace-pre-line break-words text-ui-sm text-foreground-subtle">
                {copy.infoBody}
              </div>
            ) : null}
          </PopoverContent>
        ) : null}
      </Popover>
    </span>
  );
}
