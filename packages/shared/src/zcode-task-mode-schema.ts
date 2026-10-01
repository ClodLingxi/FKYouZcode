import { z } from "zod";
import type { ZCodeTaskMode } from "./zcode-task-types-core.js";

// 该 schema 同时被 validation 聚合入口和 legacy protocol 使用，必须放在无反向依赖的叶子模块。
// 根因：protocol 从 validation 导入它，而 validation 又导入 protocol 的资源采样 schema，
// ESM/Jiti 在 clean Docker 中会先读到尚未初始化的 binding，导致 `.optional()` 启动即崩溃。
//
// canonical 任务模式（10 值），与 zcode-task-types-core.ts 的 ZCodeTaskMode 同值。
// 依据闭源 zcode.cjs zcodeTaskModeSchema（10 值 zod enum）：
// yolo 是 glm 原生全自动档；bypassPermissions/dontAsk 是 Claude 风格 canonical id（导入/迁移用）；
// default/acceptEdits/autoEdit 是 provider 档位 id（codex/gemini/claude），glm 顶层会话
// 经 host 适配层坍缩到 build/yolo。旧 6 值数据（yolo/plan/edit/auto/autoEdit/build）直通。
export const zcodeTaskModeSchema = z.enum([
  "default",
  "yolo",
  "plan",
  "edit",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "autoEdit",
  "build",
]);

/**
 * 持久化/导入边界的外来模式串 → canonical 归一化（闭源 normalizePersistedSessionMode 等价）。
 * canonical 直通；provider 配置档位别名折叠；未知值返回 undefined（调用方按未设置处理，不猜档位）。
 * 别名依据闭源 host：read-only→plan；auto-edit/auto_edit/accept-edits/accept_edits→acceptEdits；
 * full-auto/full_auto→yolo；full-access/agent-full-access→bypassPermissions。
 * （闭源别名分支里的 "autoEdit" case 不可达：canonical 直通先于别名，autoEdit 本身是 canonical 值。）
 * "agent" 在闭源仅 codex provider 归一为 default，本仓库 glm 单后端，返回 undefined。
 */
export function normalizePersistedTaskMode(
  value: string | null | undefined,
): ZCodeTaskMode | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (zcodeTaskModeSchema.safeParse(trimmed).success) {
    return trimmed as ZCodeTaskMode;
  }
  switch (trimmed) {
    case "read-only":
    case "read_only":
      return "plan";
    case "auto-edit":
    case "auto_edit":
    case "autoEdit":
    case "accept-edits":
    case "accept_edits":
      return "acceptEdits";
    case "full-auto":
    case "full_auto":
      return "yolo";
    case "full-access":
    case "full_access":
    case "agent-full-access":
    case "agent_full_access":
      return "bypassPermissions";
    default:
      return undefined;
  }
}

/**
 * automation 持久化归一化：canonical 10 值接受、落库前压成 4 值
 * （闭源 uYa：dontAsk|bypassPermissions→yolo；default|auto|acceptEdits|autoEdit→build；
 * plan|edit|yolo|build 直通；undefined 保持未设置）。
 * 写边界唯一：automationRepo.create/update（Repo 是绕过 RPC 时的最终持久化边界）。
 */
export function normalizeZCodeAutomationPersistMode(
  mode: ZCodeTaskMode | null | undefined,
): ZCodeTaskMode | undefined {
  if (mode === null || mode === undefined) return undefined;
  switch (mode) {
    case "plan":
    case "edit":
    case "yolo":
    case "build":
      return mode;
    case "dontAsk":
    case "bypassPermissions":
      return "yolo";
    case "default":
    case "auto":
    case "acceptEdits":
    case "autoEdit":
      return "build";
  }
}
