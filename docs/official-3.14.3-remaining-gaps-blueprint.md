# ZCode 官方 3.14.3 相对开源版剩余功能差距蓝图

> 分析基线：官方 3.14.3 解包产物 `/tmp/official-3.14.3/src/out/`（host/main/preload/renderer/scheduler）+ 官方 Electron 资源 `/opt/ZCode/resources/`（glm/ 为 CLI 运行时与内置插件）+ 官方 CLI 运行时 `/opt/ZCode/resources/glm/zcode.cjs`；
> 开源版仓库 `/home/lingxi/.zcode/workspace/default/ZCode`（monorepo，版本已对齐 3.14.3）。
> 标识符总清单 `/tmp/truly-new.txt`（2046 行）已逐组归类；**bot 平台（Feishu/Telegram/Weixin/Webhook/elicitation/bot remote workspace/streaming card 等，约占清单 40%）由另一 agent 负责，本文不覆盖**。
> 定级：A=纯客户端可直接实现；B=依赖官方服务端（开源版无后端）；C=仅 macOS/Windows（Linux 无意义）；D=开源版已有等价物/已同步。

---

## 总览

| 组 | 内容 | 项数 |
|---|---|---|
| A | 营销触达基础设施（marketing touch + 素材库 + 内容包缓存 + CloudContent 本地源 + hero 沙箱 + Rewards WebView 框架）、Output Style 管理服务、CDN 国内双源 fallback、restore-legacy-sessions 等内容型插件包回填、captcha 网络诊断、gemini/opencode 兼容小项 | 7 |
| B | Web Remote Control（手机/网页远控，含 AcknowledgedRelay 中继协议）、营销 campaign 内容运营、验证码业务配置 | 3 |
| C | CUA 运行时真实现（Helper 安装校验链、permission broker 注入、AX 原生桥、PiP、dev broker） | 1（含 5 子项） |
| D | plan approval、memory、thought level、权限 Always allow/deny 记忆、settings-sync、host-capability/server-info、billing/captcha 头、build-meta、ACP 迁移等 | 12 |

**最有价值且可立即移植的前 3 项**：① Output Style 管理服务（A，2 人日，CLI 侧已就绪）；② CDN 国内双源 fallback（A，0.5 人日）；③ Marketing Touch 基础设施（A，无服务端时静默降级，约 8-12 人日）。

---

## A 组：纯客户端，开源版可直接实现

### A1. Output Style（输出风格）管理服务 —— 约 2 人日 ⭐推荐

**语义还原**（host/index.js）：
- 内置风格表：`lke=[{id:"default",name:"Default",...},{id:"explanatory",name:"Explanatory",description:"Claude explains its implementation choices and codebase patterns"},{id:"learning",name:"Learning",description:"Claude pauses and asks you to write small pieces of code for hands-on practice"}]`
- 服务 `createOutputStyleService` 暴露 7 个方法：`listStyles / addStyle / updateStyle / deleteStyle / getUserStylesDirectory / setActiveStyle / getActiveStyle`；自定义风格存 `join(HOME, ".claude", "output-styles")/*.md`，`parseMarkdownStyle` 用 `^name:\s*(.+)$`/`^description:\s*(.+)$` 正则取元数据，缺省名 "Custom Style"。
- `setActiveStyle` 把 `{outputStyle: styleId}` 合并写入 `join(HOME, ".claude", "settings.json")`（Claude Code 配置兼容，`getUserClaudeSettingsPath`）。
- RPC 服务通道 `OutputStyle: "output-style"`（shared channels 枚举，开源版缺）。
- CLI 侧消费：`"outputStyle"in e&&(this.config.outputStyle=e.outputStyle,this.activeTurn||v4(this))` —— 运行时把风格 prompt 注入 system（与 customSystemPrompt 互斥）。**开源版 CLI 已完整支持**（`packages/shared/src/…`、`apps/zcode-cli/packages/core/src/runtime/types.ts:234`、`agent-runtime.ts:342`、`helpers/runtime-reminders.ts:211`），缺的只是桌面端管理面。

**开源版落点**：
- `packages/shared/src/channels.ts`（ServiceChannels 增 `OutputStyle: "output-style"` + 方法类型）
- `packages/services/src/output-style/`（新目录：outputStyle.ts + outputStyleService.ts，仿 `packages/services/src/memory/`）
- `packages/services/src/node.ts`、`packages/desktop/src/host/index.ts`（注册）
- `packages/ui/src/SettingsPage.tsx`（设置页新 section 或 appearance 内嵌）

**实施步骤**：① shared 加通道与方法 zod schema；② services 实现 7 方法（读 ~/.claude/output-styles、写 settings.json，逻辑照上文还原）；③ host 注册；④ UI 加风格选择器（列表 + 启用态），新建任务时把 active 风格 prompt 塞进 runtime config.outputStyle（host 任务创建路径读取一次）。

**关键代码草案**（services 层核心，约可覆盖 80% 逻辑）：

```typescript
// packages/services/src/output-style/outputStyle.ts
import { mkdir, readFile, readdir, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const BUILT_IN = [
  { id: "default", name: "Default", description: "Claude completes coding tasks efficiently and provides concise responses", content: "" },
  { id: "explanatory", name: "Explanatory", description: "Claude explains its implementation choices and codebase patterns", content: "" },
  { id: "learning", name: "Learning", description: "Claude pauses and asks you to write small pieces of code for hands-on practice", content: "" },
] as const;

const userHome = () => process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
export const getUserStylesDirectory = () => join(userHome(), ".claude", "output-styles");
const claudeSettingsPath = () => join(userHome(), ".claude", "settings.json");

function parseMarkdownStyle(content: string, file: string) {
  const name = content.match(/^name:\s*(.+)$/m)?.[1]?.trim()
    || file.replace(/\.md$/, "") || "Custom Style";
  const description = content.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
  return { name, description };
}

async function readClaudeSettings(): Promise<Record<string, unknown>> {
  try { return JSON.parse(await readFile(claudeSettingsPath(), "utf-8")); }
  catch { return {}; }
}

export function createOutputStyleService() {
  const getActiveStyle = async () => ({
    styleId: (await readClaudeSettings()).outputStyle as string | undefined ?? null,
  });
  const setActiveStyle = async (input: { styleId: string | null }) => {
    await mkdir(join(userHome(), ".claude"), { recursive: true });
    const next = { ...(await readClaudeSettings()), outputStyle: input.styleId };
    await writeFile(claudeSettingsPath(), JSON.stringify(next, null, 2), "utf-8");
  };
  const listStyles = async () => {
    const { styleId } = await getActiveStyle();
    const active = styleId ?? "default";
    const custom: Array<Record<string, unknown>> = [];
    try {
      for (const entry of await readdir(getUserStylesDirectory(), { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const filePath = join(getUserStylesDirectory(), entry.name);
        const content = await readFile(filePath, "utf-8");
        const { name, description } = parseMarkdownStyle(content, entry.name);
        const id = `custom-${entry.name.replace(/\.md$/, "")}`;
        custom.push({ id, name, description, content, isBuiltIn: false, enabled: id === active, filePath });
      }
    } catch { /* 目录不存在时仅返回内置 */ }
    custom.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return { styles: [...BUILT_IN.map(s => ({ ...s, enabled: s.id === active })), ...custom] };
  };
  const writeStyleFile = (name: string, description: string, content: string) =>
    `${name}\n${description}\n\n${content}`.replace(/^\n/, ""); // 落盘格式：name:/description: 头 + 正文
  const addStyle = async (input: { config: { name: string; description: string; content: string } }) => {
    const { config } = input;
    await mkdir(getUserStylesDirectory(), { recursive: true });
    const file = `${config.name.toLowerCase().replace(/\s+/g, "-")}.md`;
    await writeFile(join(getUserStylesDirectory(), file),
      `name: ${config.name}\ndescription: ${config.description}\n\n${config.content}`, "utf-8");
  };
  const updateStyle = async (input: { id: string; config: { name: string; description: string; content: string } }) => {
    const base = input.id.startsWith("custom-") ? input.id.slice(7) : input.id;
    await writeFile(join(getUserStylesDirectory(), `${base}.md`),
      `name: ${input.config.name}\ndescription: ${input.config.description}\n\n${input.config.content}`, "utf-8");
  };
  const deleteStyle = async (input: { id: string }) => {
    const base = input.id.startsWith("custom-") ? input.id.slice(7) : input.id;
    await unlink(join(getUserStylesDirectory(), `${base}.md`)).catch(() => {});
  };
  return { listStyles, addStyle, updateStyle, deleteStyle, getUserStylesDirectory: async () => ({ path: getUserStylesDirectory() }), setActiveStyle, getActiveStyle };
}
```

**风险**：settings.json 与 Claude Code 共享文件，写入需保留用户其余字段（草案已合并写）；`outputStyle` 对 CLI 运行时的下发点（host 建任务时读取）需在实现时对齐官方投影字段。

---

### A2. 远程资产/更新 CDN 国内双源 fallback —— 0.5 人日 ⭐推荐

**语义还原**（main/index.js）：
```js
Ms={domestic:"https://cdn.codegeex.cn/zcode/electron/releases",
    overseas:"https://cdn.zcode-ai.com/zcode/electron/releases"},
QE="http://studio.zcode-ai.com:12345/ssh-remote-assets";
function oT(e){let t=e.timeZone??tT();return eT(e.locale)&&rT(t,e.now)} // shouldPreferDomesticRemoteCdn
// isChineseLocale: locale 以 "zh" 开头；isUtcPlusEightTimeZone: timeZoneOffset===480
// oT 为 true → [domestic, overseas]，否则 [overseas, domestic]；env==="test" → QE 测试源
```
另有 `https://cdn-zcode.z.ai/zcode/electron/releases` 作为第三源出现在 host 侧 N 列表。开源版 `packages/desktop/src/main/remoteCdn.ts` 只返回单一 `cdn-zcode.z.ai` 源，无地域排序、无 fallback 链。

**开源版落点**：`packages/desktop/src/main/remoteCdn.ts`（唯一改动点），调用方 `desktopRuntimeEnv.ts` 不变。

**关键代码草案**：

```typescript
const DOMESTIC = "https://cdn.codegeex.cn/zcode/electron/releases";
const OVERSEAS = "https://cdn.zcode-ai.com/zcode/electron/releases";
// 原 DEFAULT_CDN_BASE_URL = "https://cdn-zcode.z.ai" 保留为第三优先/构建期注入源

function isChineseLocale(locale?: string): boolean {
  return locale?.trim().toLowerCase().startsWith("zh") ?? false;
}
function isUtcPlusEight(timeZone?: string, now = new Date()): boolean {
  if (!timeZone?.trim()) return false;
  const offset = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(now).find(p => p.type === "timeZoneName")?.value ?? "";
  return offset === "GMT+08:00";
}
export function shouldPreferDomesticRemoteCdn(o: { locale?: string; timeZone?: string; now?: Date }): boolean {
  return isChineseLocale(o.locale) && isUtcPlusEight(o.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, o.now);
}
// resolveRemoteCdnBaseUrls: override 优先；test env 用测试源；否则按地域排序输出 [首选, 备选]
```

**风险**：极低；cdn.codegeex.cn 需在发布管线确认可用性（开源 CI 也可以只保留顺序而不启用国内源，用 env 开关控制）。

---

### A3. Marketing Touch 营销触达基础设施（含 Rewards WebView 框架）—— 8-12 人日 ⭐推荐（无服务端内容时静默降级）

**语义还原**：
- **host 触达服务**（host/index.js `createMarketingTouchService`）：
  `GET /api/v1/marketing/touch?seq=N`，头：`X-Device-Mid`(uuid)、`X-Client-Language`(zh-CN|en-US)、`X-ZCode-App-Version`、可选 Bearer；`scope` 为 uuid，token 变化即重建，前后不一致抛 `marketing_identity_changed`。回报 `POST /api/v1/marketing/touch/action`，body `{campaign_id, action_type:"confirm"|"cancel"}`，响应 `{code:0}`。响应解析（chunk-B7L5SK4K `parseMarketingTouchResponse`）→ `{serverTime, language, deliveries[], rejectedCount}`，deliveries 按 `resource_position`（banner/popup）去重，上限 32。
- **素材登记表**（`createMarketingAssetRegistry`）：sha256 白名单（每 src 最多 8 个、LRU 512 src）：`t.get(l.src)?.has(l.sha256)===!0`；下载强制 `redirect:"error", credentials:"omit"`，30s 超时，大小上限 image 8MB / video 16MB（`marketing_asset_size`），sha256 校验（`marketing_asset_integrity`），魔数判定 PNG/JPEG/WEBP/MP4（`marketing_asset_type`），data-URL 缓存总量 48MB LRU。
- **内容包缓存**（`createContentBundleCache`）：落盘 `~/.zcode/cache/content-bundles/<hash>`，下载→解包→entry 校验（`bundle_entry_missing`/`bundle_duplicate_path`/`bundle_active_cache_corrupt`），lease/release 语义；校验失败整包重下。
- **CloudContent 本地源**（host/chunk-EBZ6RJTQ + index.js）：`http://127.0.0.1:<临时端口>` 起本地 HTTP，把已发布媒体（`readPublishedMedia`）与内容包（`prepare` 返回 `{leaseId,url}`）安全地供给 renderer；CSP：`default-src 'none'; script-src 'self' 'unsafe-inline'; ... sandbox allow-scripts`，响应头 `Cross-Origin-Resource-Policy: cross-origin`。禁用/释放错误码：`cloud_content_disabled/disposed/source/address`。
- **交互式 hero**：deliveries 可携带 `{type:"interactive_bundle", runtime:"zcode-hero-sandbox-v1", bundle, viewport:{aspectRatio:"4:3"}, data(≤64KB), events(≤16), fallback(image)}`（renderer/src-BkoFK6Bn.js zod schema），主进程 chunk-GJUBRD53 同构。
- **Rewards WebView**（main/index.js + preload/rewardsWebview.cjs 692KB）：`isTrustedRewardsUrl` 只放行 `https://zcode.z.ai | https://zcode.chatglm.site`（dev: localhost:3000，e2e: http 127.0.0.1）且 `/^\/(cn|en)\/rewards\/?$/` 且 `embedded=app`；命中则 webview 挂 `rewardsWebview.cjs` preload（非打包时附 `--zcode-rewards-dev`），`contextIsolation+sandbox+nodeIntegrationInSubFrames`。桥接状态以 `persist:zcode-rewards` 为键：`{theme:"zai-light"|"zai-dark", locale, auth:{status:"ready"|"anonymous", provider:"zai"|"bigmodel", revision}}`。
- **deep-link 动作**（renderer/src-BkoFK6Bn.js）：营销卡可触发 `close | open_url | claim_zcode_plan{plan_id} | navigate{page: upgrade|rewards|settings(sections...)|plugin_marketplace} | copy_text`。
- 开关：纯客户端无灰度门；无服务端/无 campaign 时 query 空 deliveries 即静默。

**开源版落点**：
- `packages/shared/src/channels.ts`（ServiceChannels 增 `CloudContent`、`MarketingTouch`）
- `packages/services/src/marketing/`（touch service、asset registry、content-bundle cache、cloud content origin）
- `packages/desktop/src/main/`（rewards webview preload 装配 + IPC：`zcode:start/stop-web-remote…` 不涉及；此处是 `webview` attach 逻辑）
- `packages/desktop/src/preload/rewardsWebview.ts`（新）
- `packages/ui/src/`（Banner/Popup 组件 + hero sandbox 容器 + rewards 页面导航项）
- i18n、遥测事件 `marketing_asset_*`

**实施步骤**：① shared 契约 + zod schema（deliveries/asset/bundle）；② host touch service（含 scope/identity）；③ asset registry（sha256 白名单 + 大小/魔数校验）；④ content-bundle 缓存 + CloudContent 本地 HTTP 源（复用 yauzl）；⑤ renderer Banner/Popup + deep-link 动作映射（`claim_zcode_plan` 已有手动领取链路可复用）；⑥ rewards webview + preload 桥；⑦ 遥测。可拆两期：先 ①-⑤（banner/popup 图片素材），再 ⑥（rewards）与交互包。

**风险**：本地 HTTP 源是安全敏感面（必须绑定 127.0.0.1、临时端口、CSP、lease 生命周期）；`interactive_bundle`（HTML 沙箱）如暂不需要可先不实现 runtime，仅保留 schema 与 fallback image。

---

### A4. 内容型官方插件包回填（restore-legacy-sessions / documents / pdf / presentations / spreadsheets / plugin-creator / skill-creator / zcode-guide / image-search）—— 1-2 人日（内容拷贝）+ 3-8 人日/个（android/ios 逆向重写）

**语义还原**（现状对比）：
- 官方运行时 `/opt/ZCode/resources/glm/packages/` 有 15 个包；开源版 `packages/desktop/bundled-agents/linux-x64/glm/packages/` 只 stage 了 `browser-use-plugin` 与 `node-repl-host`。
- 开源版 `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts` 的 `OFFICIAL_PLUGIN_DEFINITIONS` **已定义全部官方插件**（android-emulator 0.1.0、browser-use 0.5.1、documents/pdf/presentations/spreadsheets 0.1.7、image-search 0.1.1、ios-simulator 0.1.0、restore-legacy-sessions 0.1.0、plugin-creator 0.1.1、skill-creator 0.1.0、zcode-guide 0.2.0、computer-use 0.6.3、node-repl-host 0.6.0），`requiredSeedPaths` 与官方包内容一一对应——但 `apps/zcode-cli/packages/` 下相应源码目录已被剥离（只剩 browser-use-plugin、node-repl-host、superpowers-plugin 空壳）。seed 时 rootCandidates 找不到目录 → 插件静默缺失。
- 官方包性质：documents/pdf/presentations/spreadsheets-plugin = `agents/visual-judge.md` + `skills/<skill>/`（SKILL.md+scripts，696K/1.2M/96K/380K，纯内容）；restore-legacy-sessions 88K（commands+skills，纯内容）；plugin-creator 84K、skill-creator 36K、zcode-guide 112K（纯内容）；image-search 24K（仅 `.mcp.json`，认证由官方 MCP adapter 注入）；android-emulator 1.6M、ios-simulator 1.5M（含 `dist/mcp/server.js` 编译产物 + hooks/templates，**需 TS 源码重写**）；zcode-cua-plugin 20M（node_modules 大头 + docs/scripts/skills，随 C 组）。
- 构建机制：`packages/desktop/scripts/prepare-agent-node-bundle.mjs` 的 `officialPluginPackages` 只声明 browser-use 与 node-repl-host 两个有源码包；`stageOfficialPlugins()` 把它们拷入 `bundled-agents/<platform>/glm/packages/`。运行时 `bootstrap/src/app/bundled-plugins.ts` 负责从 `glm/packages/*` 或 SEA 资产 seed 到用户插件缓存并写官方 marketplace。
- 开源版 bundled-skills 与官方一致（都只有 dynamic-workflows）。

**开源版落点**：`apps/zcode-cli/packages/<name>-plugin/`（回填源码包，含 `.zcode-plugin/plugin.json`），随后 `prepare-agent-node-bundle.mjs` 的 `officialPluginPackages` 增加对应条目（纯内容型 `requiresRuntime` 省略）。

**实施步骤**（以 restore-legacy-sessions 为例）：① 从官方运行时包拷贝 `commands/ skills/ README.md package.json .zcode-plugin/`；② 对照 `requiredSeedPaths`（如 zcode-guide 钉了 `commands/workflow.md` 与 dynamic-workflows 三件）校验齐全；③ `prepare-agent-node-bundle.mjs` 注册；④ 端到端跑一次 seed 校验缓存目录结构。
**风险**：**许可证**——官方运行时里这些 skills/agents 正文在开源仓库被剥离，说明上游有意未开源；内容级回填仅适用于自用，再分发需法务确认。image-search 依赖官方 adapter 认证注入，脱离官方后端可能不可用（降级 B）。android/ios 模拟器插件的 `dist/mcp/server.js` 为编译产物，等价做法是依据 `skills/`+`templates/` 里的工具说明重写 MCP server（3-8 人日/个）。

---

### A5. 阿里云验证码网络诊断 —— 1 人日

**语义还原**（main/index.js `installCaptchaNetworkDiagnostics`）：对 `*.device.saf.aliyuncs.com`（device_api）、`*.captcha-(pro-)?open*.aliyuncs.com`（init_api/sdk_log）、`static-captcha*`（image）、`o/g/x.alicdn.com/captcha-frontend/`（sdk_script/dynamic_css/dynamic_js/device_script）分类，webRequest `onBeforeRequest/onCompleted/onErrorOccurred` 打 `[captcha-network] resource.start/completed/failed` 日志（带 elapsedMs、statusCode、net::ERR_*，5 分钟 LRU、上限 128）。
**开源版落点**：`packages/desktop/src/main/` 新文件（webRequest 诊断与现有 networkTelemetryAggregator 并列）。
**风险**：无（纯日志）；开源版已含 claim 的 `X-Aliyun-Captcha-Verify-Param/Region` 头与 `captcha-retry` reason（`bigmodelCodingPlanSubscriptionProvider.ts`），此项只是可观测性补齐。

---

### A6. settings-sync：gemini 原生配置 extra files —— 0.5 人日

**语义还原**（host/chunk-NKOHJ4QI）：`gemini:{nativeConfigDir:".gemini",nativeConfigFileName:"settings.json",nativeConfigExtraFiles:["oauth_creds.json","google_accounts.json"]}`，与 claude（`.claude/settings.json`）、opencode（`.config/opencode/opencode.json`）、codex（`.codex/config.toml`）并列，用于跨 agent provider/skills 同步时的原生配置识别与迁移。
**开源版落点**：`packages/shared/src/zcode-agent-runtime.ts`（有 `nativeConfigDir`，缺 `nativeConfigExtraFiles` 字段）+ `packages/services/src/settings-sync/`。
**风险**：低；需核对开源版 settings-sync 对 gemini 目录的读写范围。

---

### A7. opencode provider key/model id 导出工具 —— 0.5 人日（需先核对用途）

**语义还原**（官方 CLI zcode.cjs）：`toAsciiSlug`（非字母数字转 `-`）+ FNV-1a `hash8` → `toOpencodeProviderKey(providerId) = "<slug>-<hash8>"`、`toOpencodeModelId(providerId, model) = key + "/" + model`；与 `zcodeSessionSettingsToZCodeConfigOptions`（build/edit/plan/yolo 模式、model、thought_level 选择面）同区域。开源版 settings-sync 已支持 openCode 目标，但未找到该 key 生成算法（`2166136261` FNV 常量不存在），若官方 opencode 导出格式依赖此 key，则开源版导出的 opencode 配置与官方产物不互通。
**开源版落点**：`packages/services/src/settings-sync/`（opencode 导出路径）或 `apps/zcode-cli/packages/adapters/`。
**风险**：低；实现时先用官方算例对拍 hash8。

---

## B 组：依赖官方服务端（实现了也没有官方后端，标注服务端契约）

### B1. Web Remote Control（手机/网页远控）全链路 —— 10-25 人日 + 自建 relay 服务端

**语义还原**（main/index.js + main/chunk-C6VCYWB4.js 16.5KB + chunk-GJUBRD53.js 协议层 + host/chunk-B7L5SK4K.js 契约）：
- **接入**：桌面作为"外接设备"连 `wss://zcode.z.ai/ws`（备用 `wss://zcode.chatglm.site/ws`，协议版本常量 `"3.4.0"`），查询串带 `mid=<deviceMid>`，头 `X-Device-ID`，开 permessage-deflate。
- **注册/认证**（HMAC 挑战应答）：
  ```js
  send({type:"device_register_init",device_mid,pass_hash,meta,client_ts}) → device_register_ack{device_sid} → 持久化
  case"auth_challenge": send({type:"auth_response",device_sid,
    proof:calculateProof(passHash,nonce,"device",deviceSid), client_ts})  // HMAC-SHA256(passHash, `${nonce}|device|${deviceSid}`) base64url
  auth_ack/pair_status_ack → applyPairStatus(pair_status)
  ```
  凭据存储键 `web-remote-control:external-relay:pass_hash`（`createWebRemoteControlRelayAuthStorageProvider`，支持 rotate）。
- **配对**：QR URL `buildWebRemoteControlExternalQrUrl`：`<mobileBaseUrl>?sid=<deviceSid>&hash=<passHash>&t=<ts>&mid&name&app_version`；`resetPairing` 场景标记 `leaked-qr`。心跳 `pair_status_query` 每 10s±20% 抖动 + ack 看门狗；状态机事件 `state-transition/socket-close/socket-error/recover-start/recover-scheduled/pair-status/failure`（mobile-diagnostic 遥测 schema）。
- **AcknowledgedRelay 可靠传输**（`AcknowledgedRelayProtocol/Deadline/BatchQueue`）：消息 `zcode_type:"rpc-frame"|"rpc-frame-ack"`，默认 `saturationHighWaterMarkBytes=1MB / lowWaterMark=256KB / replayBufferMaxBytes=8MB / replayBufferGraceMs=45s`，帧身份 `{bridgeSessionId, bridgeGeneration, recoveryId}`；故障码全集 `remote.rpcFrame.*`（ackGraceExceeded/replayGraceExceeded/checksumMismatch/fragmentGap/envelopeTooLarge/messageSequenceExhausted/…30 项），degrade 后 `bridge-degraded`。
- **承载能力**：`workspace-bridge-open/ready/error`、`workspace-list-request/response/updated`、`workspace-reconnect-request/response`、`platform-request/response`（method 白名单）、`mobile-view-state-update`（viewState+deviceInfo）、任务流同步；桌面侧 IPC：`zcode:start/stop-web-remote-control、zcode:get-web-remote-control-status、zcode:sync-web-remote-control-tasks/workspaces、zcode:web-remote-control-reconnect-workspace、zcode:reset-web-remote-control-pairing、zcode:web-remote-control-status-changed`；renderer 设置页配对 UI、`isWebRemoteControlV4AppVersion` 版本门控、featureGate `"Web remote control is disabled in this build"`（构建期常量）。
- 服务端契约（若自建）：relay 需实现 device_register/challenge/pair_status 路由与设备↔web 会话桥接；web 端（zcode.z.ai 移动版）不在开源范围。

**开源版落点**：`packages/shared/src/`（relay 消息 schema）、`packages/desktop/src/main/webRemoteControl*.ts`、`packages/desktop/src/preload/index.ts`（IPC）、`packages/ui/src/settings/`（配对面板）。
**实施步骤**：① relay 传输+认证层（ws + HMAC + 心跳）；② AcknowledgedRelay 帧/重放/水位（照 chunk-C6VCYWB4 逐函数还原，该文件仅 16.5KB 压缩、结构清晰）；③ workspace bridge 与任务/工作区同步（复用现有 host services RPC 投影）；④ renderer 配对 UI。**建议仅协议层移植（①②可独立成库并对接自建 relay/内网网关）**。
**风险**：官方 relay 不开放，完整用户体验不可复现；workspace bridge 暴露面大，安全设计（配对有效期、`leaked-qr` 吊销）需复刻。

### B2. Marketing 内容运营（campaign 下发 / rewards 网页本体）
A3 的服务端半边：`/api/v1/marketing/touch(/action)` 的 campaign 定向、素材 CDN 与 sha256 清单、`zcode.z.ai/(cn|en)/rewards` 网页。开源侧契约已在 A3 固化；无运营内容时功能静默。

### B3. 阿里云验证码/设备指纹业务配置
`getCaptchaConfig()`（client-configs 的 `configs.captcha`）驱动 renderer 验证码弹窗（AliyunCaptcha SDK + `X-Aliyun-Captcha-Verify-Param/Region`）。开源版已含 claim+headers；缺的配置面依赖官方 client-config 下发。落点：`packages/services/src/coding-plan-subscription/` 增 `getCaptchaConfig` 透传。0.5 人日（A/B 临界，标 B 因无配置即无 UI）。

---

## C 组：仅 macOS/Windows（Linux 无意义）

### C1. CUA（Computer Use）运行时真实现 —— 官方未开源核心，40+ 人日，且 Linux 无等价物

开源版 `packages/zcode-cua` 是**有意 fail-closed 的 API 兼容占位**（README："every runtime surface reports unavailable and fails closed"），占位实现覆盖全部导出面（`createCuaHelperInstaller`、`defaultCuaHelperVerifierDependencies`、`cuaBrokerRefreshMarkerPath` 等全部 reject/返回 false），桌面侧 `desktopCuaHelperInstaller.ts`、`cuaPermissionDragPanel.ts`、`cuaPipFocusRouter.ts`、`services/cua-permission-broker/*`（cuaPermissionService、cuaPipSession、cuaAgentAdmissionGate、windowsCuaDevHelperHost）等外壳**已齐**。官方在此之上多出的真实现（host/index.js + main 证据）：

1. **Helper 下载/安装校验链**：
   - `assertSafeHelperDownloadUrl`：`refusing to download ZCode Computer Use over unsupported scheme`（仅 http/https）；
   - `defaultDownloadFile`：超时 `ZCODE_CUA_HELPER_DOWNLOAD_TIMEOUT_MS`、上限 `ZCODE_CUA_HELPER_MAX_DOWNLOAD_BYTES`（content-length 预检 + 流式截断）；
   - `assertSafeZipArchiveEntries`：`unzip -Z1` 逐条校验，`refusing to extract ... unsafe zip entry path`（zip-slip）；
   - `captureCuaHelperBundleAttestation`：遍历 .app 全文件 `relativePath:sha256` 拼指纹（含 symlink 出包检测 `out-of-bundle symlink`、条目上限），`assertCuaHelperBundleAttestationUnchanged` 在签名校验前后双比对（TOCTOU），不符报 `ZCode Computer Use changed after signature verification`；
   - 签名链：`/usr/bin/codesign`、`spctl`、`syspolicy_check`，TeamID 常量 `8A5X4JJ39T`，bundle id `dev.zcode.cua-helper`（dev 后缀 `.dev`），install 变体 `stable/preview/dev-desktop/standalone`；`com.apple.quarantine` 清理（`clearHelperQuarantine`/`xattr`）；
   - 并发与活体：`.zcode-cua-helper-install.lock` 安装租约（`acquireMacOSCuaHelperInstallLease`、`assertInstallLeaseDescriptorHeld`、单飞 `ensureCuaHelperInstalledUnderLease`）、`lsof` 找 socket 属主 pid、argv 校验 `pid no longer matches the Helper executable and random socket`（`verifyCuaHelperLiveProcessIdentity`）、broker 启动守卫（`--launcher-pid`、`--broker-launch-cancel-file`、`.launch-cancel`、`--broker-launch-deadline-epoch-ms`）。
2. **Permission broker 注入**（host 侧 glue）：`injectPermissionBrokerAgentMcpServer(s)` 对官方 CUA 插件 MCP server 注入 `--permission-broker-socket <path>` 与 broker identity env（`isAuthorizedOfficialZCodeCuaPluginServer` 校验 pluginAuthority），未接入 broker 的 CUA server 直接剔除（`omitUnbrokeredZCodeCuaAgentMcpServers`）；启动参数族 `--permission-preflight(-result-file)`、`--controller-variant`、`--disable-cps-activation`、`--ghost-cursor-overlay/capture`、`--pip-mode/--pip-live-probe`、`--background-mode`。
3. **AX 原生桥**：`ax_native.node`（闭源 NAPI）+ AX 角色面（textfield/securefield/combobox/slider/TreeItem/TabItem/SplitButton/Window/…）、`element_at_point/press/set_value/perform_action/show_menu/select_text`、`list_applications/list_windows/screen_capture_probe`、PiP 会话 `zcode-cua-pip-session-v2`（`__zcode_pip_no_active_session_v2__`）。
4. **Dev broker 工具链**（本地开发用）：`ZCODE_CUA_DEV_EXPOSE_BROKER`、`ZCODE_CUA_ALLOW_DEV_BROKER`、`ZCODE_CUA_BROKER_ALLOW_ANY_PEER`、`allowAnyPeer`、`--allow-unsigned-launcher-local-dev`、`--allow-external-broker-client-local-dev`、`broker-credentials.json`、`defaultPeerCredentialChecker`、`pruneStaleBrokerSockets`、`unlinkIfOwnedSocket`、`guardAnchorDirectoryForSocket`。
5. **能力开关**：`resolveOfficialCuaPluginEnablement` 读项目 `zcode.json`/`.zcode/config.json`（`discoverZCodeProjectConfigPaths` 向上遍历至 .git）决定插件启停。

**移植判断**：1-4 的实现体在官方为闭源（开源仓库以占位包替换是**有意行为**，涉及代码签名、公证与 Apple TeamID）；Linux 上无 Accessibility/codesign 对应物，移植无产品意义。开源版保持 fail-closed 是正确姿态；如需 Linux 等价自动化，应走独立实现（如本仓库已有的 browser-use/playwright 路线）而不是移植本链。zcode-cua-plugin 的内容件（docs/computer-use.md、scripts/computer-use-client.mjs、skills/computer-use/SKILL.md）可按 A4 方式回填，但运行时仍会 fail-closed。

---

## D 组：开源版已有等价物（此前清单误报/已同步）

| 项 | 证据（开源版位置） |
|---|---|
| **plan approval**（特别核实） | host 逻辑+UI 双侧齐备：`packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts:4959,4988`（`pendingExitPlanModeToElicitationEvent`：ExitPlanMode permission → elicitation，`schema:{interaction:"plan_approval",toolName,plan}`，问题文案 "Plan/Approve/Exit plan mode and start implementation."）；UI：`packages/ui/src/ElicitationDialog.tsx:195`（`schema.interaction==="plan_approval"&&schema.toolName==="ExitPlanMode"`）与 PermissionDialog。它是 **host 逻辑**（把 ExitPlanMode 工具权限请求投影成带计划正文的 elicitation 事件），渲染复用现有 elicitation/permission 面板，**不是独立新面板**。truly-new 里的 `planApprovalTitle/Header/Approve` 字符串来自 host 机器人卡片 i18n（“请审阅此实施计划。/实施计划/批准”，bot 平台）与 web-remote 投影（`createAssistantReplyBlocks`），非桌面缺口 |
| memory（loadMemory/saveMemory/clearMemory） | `packages/services/src/memory/`、channels `Memory:"memory"` |
| thought level | `packages/services/src/session/zcodeTaskService.ts` 等多处 |
| 权限 "Always reject the same command/file operation"、"Do not ask again…" | `packages/ui/src/i18n/locales/en-US.ts:5541-5549`、`PermissionDialog.tsx`、`lib/permissionRequest.ts`（host/index.js 中的短文案是 bot 卡片格式化，归 bot 平台） |
| `/api/server-info`、`/api/rpc-host-capability`、`x-zcode-rpc-host-capability`、`connectServerRemote/connectViaProtocol` | `packages/server/src/http.ts:317-318`、`packages/client/src/websocket.ts` |
| 手动领取 Coding Plan（preview/claim、getManualClaimPlanPreviews、billing discount） | `packages/services/src/coding-plan-subscription/` |
| workflowRun.updated/removed 增量流 | `packages/shared/src/zcode-protocol-v4/workflow-runs-delta.ts`、`apply.ts` |
| getOffPeakClientConfig / getDynamicWorkflowClientConfig | `codingPlanSubscriptionService.ts:44-48` |
| captcha 验证头（X-Aliyun-Captcha-*、captcha-retry） | `bigmodelCodingPlanSubscriptionProvider.ts` |
| settings-sync（跨 18 种 agent 同步 skills/providers，含 claudeCode…trae） | `packages/services/src/settings-sync/`、`packages/shared/src/settings-sync.ts`（比官方 12 agent 更全） |
| build-meta（ZCODE_BUILD_COMMIT_ID、buildCommitId=ab4d5e6b 即 truly-new 的 `ab4d5e6b`/`pipeline-293504-*`） | `packages/desktop/scripts/build-metadata.mjs:102` |
| ACP 迁移（acp_session_id/migrateLegacyAcpTaskIds） | `packages/services/test/nonCliAcpRetirement.test.ts`、taskIndexRepo 历史注释 |
| macOS 窗口细节（trafficLightPosition/vibrancy）、workers（storageScanWorker/zcodeDataSizeWorker）、plugin_marketplace 深链页、output-styles 插件 seed 白名单 | `desktopWindowChrome.ts`、`out/main/*`、`packages/ui/src/App.tsx`、bootstrap bundled-plugins |
| 其余 truly-new 噪声 | `89504e470d0a1a0a`（PNG 魔数，营销素材判定）、`16777223:3` 等位图常量、`arm64_32/mipsel`（arch 表）、`/usr/bin/*`（macOS 工具路径表）、`x-tt-logid/iLink-*/X-WECHAT-UIN`（bot 平台头） |

---

## 附：truly-new.txt 未聚类标识符最终归属索引

- **relay/web-remote-control**：AcknowledgedRelay*、rpc-frame*、remote.rpcFrame.*、auth_challenge/auth_ack/device_register*/pair_status*、workspace-bridge*/workspace-reconnect*/workspace-list*、mobile-view-state-update、mobile-diagnostic、bootstrap-request/response、window-host:connection-closed、desktop-disconnected、DESKTOP_HOST_MISSING、leaked-qr、bridge*、recoveryId、X-Device-ID、/ws/host、wss://…、3.4.0、platform-request/response → B1
- **营销**：marketing_*、/api/v1/marketing/touch*、campaign、content-bundles、bundle_*、.bundle.json、zcode-hero-sandbox-v1、interactive_bundle、cloud_content_*、persist:zcode-rewards、rewardsWebview.cjs、--zcode-rewards-dev、zai-dark/zai-light、89504e470d0a1a0a、isTrustedRewardsUrl、claim_zcode_plan（动作面）→ A3/B2
- **CUA**：zcode-cua*、CuaHelper*、captureCuaHelperBundleAttestation、assertSafe*、verify*、quarantine、8A5X4JJ39T、ZCODE_CUA_*、--pip-*、--ghost-cursor-*、--controller-variant、--background-mode、--permission-preflight*、PermissionBroker*、injectPermissionBroker*、broker*、allowAnyPeer、--allow-*-local-dev、ax_native.node、AX 角色/动作、pip_*、controller_*、cpsActivation、holds/leases/guards、/usr/bin 工具表、com.apple.quarantine、CFBundle* → C1
- **bot 平台（另 agent）**：feishu/telegram/weixin/webhook/ilink 全部、elicitation_*、streaming card、bot-config/bot-state、zc:cancel、aes-128-ecb（微信 CDN 媒体解密）、x-tt-logid、X-WECHAT-UIN 等
- **D/噪声**：见上表

*分析过程未修改 /home/lingxi/.zcode/workspace/default/ZCode 仓库任何文件。*
