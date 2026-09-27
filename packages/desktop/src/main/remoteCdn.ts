import { ZCODE_VERSION, type ZCodeEnv } from "@zcode/shared";

declare const __ZCODE_CDN_BASE_URL__: string | undefined;

// 官方 3.14.3 对齐：远程资产 CDN 走「地域排序 + fallback 链」。
// zh locale 且 UTC+8 → 国内源优先，否则海外源优先；cdn-zcode.z.ai 恒为末位第三源；
// test 环境官方切 studio 测试源。构建期注入（ZCODE_CDN_BASE_URL / __ZCODE_CDN_BASE_URL__）
// 仍最高优先，保持既有自建 CDN 行为不变。
const DOMESTIC_CDN_BASE_URL = "https://cdn.codegeex.cn";
const OVERSEAS_CDN_BASE_URL = "https://cdn.zcode-ai.com";
const DEFAULT_CDN_BASE_URL = "https://cdn-zcode.z.ai";
const STUDIO_TEST_CDN_URL = "http://studio.zcode-ai.com:12345/ssh-remote-assets";

const RELEASES_PATH_PREFIX = "/zcode/electron/releases";

export interface ResolveRemoteCdnOptions {
  env?: ZCodeEnv;
  locale?: string;
  timeZone?: string;
  overrideBaseUrl?: string;
  version?: string;
  now?: Date;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("CDN URL must use http or https");
  return value.replace(/\/+$/, "");
}

function isChineseLocale(locale?: string): boolean {
  return locale?.trim().toLowerCase().startsWith("zh") ?? false;
}

function isUtcPlusEightTimeZone(timeZone?: string, now: Date = new Date()): boolean {
  const zone = timeZone?.trim();
  if (!zone) return false;
  try {
    const offset = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(now)
      .find((part) => part.type === "timeZoneName")?.value;
    return offset === "GMT+08:00";
  } catch {
    return false;
  }
}

/** zh locale 且系统时区为 UTC+8 才视为国内（官方 shouldPreferDomesticRemoteCdn）。 */
export function shouldPreferDomesticRemoteCdn(
  options: Pick<ResolveRemoteCdnOptions, "locale" | "timeZone" | "now"> = {},
): boolean {
  const timeZone =
    options.timeZone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  return isChineseLocale(options.locale) && isUtcPlusEightTimeZone(timeZone, options.now);
}

/** 地域排序的 releases 源（不含构建期覆盖）；首位优先，其余为 fallback 链。 */
function resolveGeoOrderedBaseUrls(options: ResolveRemoteCdnOptions): string[] {
  if (options.env === "test") return [normalizeBaseUrl(STUDIO_TEST_CDN_URL)];
  const preferred = shouldPreferDomesticRemoteCdn(options)
    ? DOMESTIC_CDN_BASE_URL
    : OVERSEAS_CDN_BASE_URL;
  const fallback = preferred === DOMESTIC_CDN_BASE_URL ? OVERSEAS_CDN_BASE_URL : DOMESTIC_CDN_BASE_URL;
  return [preferred, fallback, DEFAULT_CDN_BASE_URL].map(normalizeBaseUrl);
}

export function resolveRemoteCdnBaseUrls(options: ResolveRemoteCdnOptions = {}): string[] {
  const override = options.overrideBaseUrl?.trim();
  if (override) return [normalizeBaseUrl(override)];
  const configuredBaseUrl =
    process.env.ZCODE_CDN_BASE_URL?.trim() ||
    (typeof __ZCODE_CDN_BASE_URL__ === "undefined" ? "" : __ZCODE_CDN_BASE_URL__) ||
    "";
  const chain = resolveGeoOrderedBaseUrls(options);
  const configured = configuredBaseUrl ? normalizeBaseUrl(configuredBaseUrl) : undefined;
  const ordered = configured ? [configured, ...chain.filter((base) => base !== configured)] : chain;
  const version = options.version ?? ZCODE_VERSION;
  return ordered.map((base) =>
    // 官方 test 源（studio ssh-remote-assets）路径语义不同：直接 `${base}/${version}`，
    // 不加 releases 前缀（zcode.cjs `ig`：env==="test" 时返回 `${QE}/${o}`）。
    // 拼上 prefix 会得到官方服务端不存在的路径，必然 404。
    base === STUDIO_TEST_CDN_URL ? `${base}/${version}` : `${base}${RELEASES_PATH_PREFIX}/${version}`,
  );
}
