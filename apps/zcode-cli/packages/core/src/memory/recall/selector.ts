// Project Memory 语义召回：selector 层（状态、manifest 缓存、LLM 选择、过滤）。
// 行为依据：官方闭源 bundle 的模块 JEo/myt/dyt（见 /tmp/spec-memory-selector.md §3.1–§3.4）；
// manifest 扫描复用本仓库 recall/manifest.ts（与闭源逐字一致），此处只补会话级缓存与选择链路。

import type {
  FileSystemPort,
  JsonSchema,
  Model,
  ModelInputMessage,
  ModelRequest,
} from "@zcode/contracts";

import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { modelMessageContentToText } from "@zcode/contracts";
import { auxiliaryModelOptions } from "../../model/auxiliary-model-options.js";
import { findEditableReadFileState } from "../../tool/read-file-state.js";
import type { ReadFileStateMap } from "../../tool/types.js";
import { formatMemoryManifest, scanMemoryManifest } from "./manifest.js";
import type { MemoryManifestEntry } from "./types.js";

/** 会话级注入预算：60KB 字符封顶（闭源常量 mTa=61440）。 */
const RECALL_CONTENT_BUDGET = 61_440;

/** 单次注入的文件数上限（闭源 filterMemorySelections 的 slice(0,5)）。 */
const MAX_RECALLED_FILES_PER_TURN = 5;

// Selector system prompt（闭源 aTa，逐字保留；末尾一个换行）。
const MEMORY_SELECTOR_SYSTEM_PROMPT = `You are selecting memories that will be useful to Claude Code as it processes a user's query. The first message lists the available memory files with their filenames and descriptions; subsequent messages each contain one user query.

Return a list of filenames for the memories that will clearly be useful to Claude Code as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- Be especially conservative with user-profile and project-overview memories ([user], [project]). These describe the user's ongoing focus, not what every question is about. A profile saying "works on DB performance" is NOT relevant to a question that merely contains the word "performance" unless the question is actually about that DB work. Match on what the question IS ABOUT, not on surface keyword overlap with who the user is.
- Do not re-select memories you already returned for an earlier query in this conversation.
`;

// Selector 输出 JSON Schema（闭源 cTa）。selected_knowledge_ids 为知识库预留，当前管线不消费。
const MEMORY_SELECTOR_RESPONSE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    selected_memories: { type: "array", items: { type: "string" } },
    selected_knowledge_ids: { type: "array", items: { type: "string" } },
  },
  required: ["selected_memories"],
  additionalProperties: false,
};

export interface MemorySelectorMessage extends ModelInputMessage {
  role: "user" | "assistant";
}

/**
 * 会话级召回状态（闭源 createMemoryRecallState 的形状）。
 * manifest 与 selectorMessages 延迟填充：首次扫描后缓存，跨 turn 复用，
 * compact/resume 时随 resetProjectMemoryRecall 整体丢弃。
 */
export interface MemoryRecallState {
  /** 已注入主对话的累计字符数；达到预算后 canStartMemoryRecall 关闭新预取。 */
  recalledContentCharacters: number;
  /** 已召回过的文件路径集合（文件级去重）。 */
  recalledPaths: Set<string>;
  manifest?: MemoryManifestEntry[];
  selectorMessages?: MemorySelectorMessage[];
}

export interface MemorySelectorResult {
  selectedMemories: string[];
  selectedKnowledgeIds: string[];
}

export function createMemoryRecallState(): MemoryRecallState {
  return { recalledContentCharacters: 0, recalledPaths: new Set() };
}

export function canStartMemoryRecall(state: MemoryRecallState): boolean {
  // 会话级预算封顶：注入是累计的，预算耗尽后整个会话不再起 selector。
  return state.recalledContentCharacters < RECALL_CONTENT_BUDGET;
}

export function recordRecalledMemories(
  state: MemoryRecallState,
  memories: readonly { content: string; filePath: string }[],
): void {
  for (const memory of memories) {
    state.recalledPaths.add(memory.filePath);
    state.recalledContentCharacters += memory.content.length;
  }
}

/** manifest 全部召回后短路：不再起 selector（闭源 hasRecalledEveryManifestEntry）。 */
export function hasRecalledEveryManifestEntry(state: MemoryRecallState): boolean {
  const manifest = state.manifest;
  return (
    manifest !== undefined &&
    manifest.length > 0 &&
    manifest.every((entry) => state.recalledPaths.has(entry.filePath))
  );
}

/** 会话级 manifest 缓存（闭源 getMemoryRecallManifest）：首次扫描后同时冻结 selector 首条消息。 */
export async function getMemoryRecallManifest(input: {
  fileSystem: FileSystemPort;
  rootDir: string;
  signal?: AbortSignal;
  state: MemoryRecallState;
}): Promise<MemoryManifestEntry[]> {
  const cached = input.state.manifest;
  if (cached && cached.length > 0) return cached;
  const manifest = await scanMemoryManifest({
    fileSystem: input.fileSystem,
    rootDir: input.rootDir,
    signal: input.signal,
  });
  if (input.signal?.aborted) return [];
  if (manifest.length > 0) {
    input.state.manifest = manifest;
    input.state.selectorMessages = [createManifestMessage(manifest)];
  }
  return manifest;
}

function createManifestMessage(manifest: readonly MemoryManifestEntry[]): MemorySelectorMessage {
  return {
    role: "user",
    content: `Available memories:\n${formatMemoryManifest(manifest)}`,
    cacheControl: { type: "ephemeral" },
  };
}

/**
 * 自尾向前找最近一条可作为召回 query 的真实用户输入。
 * 跳过 attachment、非 user role、tool 结果消息、非 real_user 的合成输入，
 * 以及无 metadata 但以 <system-reminder> 开头的 user 消息（闭源 findLatestMemoryRecallQuery）。
 */
export function findLatestMemoryRecallQuery(
  entries: readonly RuntimeMessageEntry[],
): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.kind === "attachment") continue;
    const message = entry.message;
    if (message.role !== "user") continue;
    if (message.toolCallId !== undefined || message.toolName !== undefined) continue;
    if (entry.metadata) {
      if (entry.metadata.source !== "real_user") continue;
    } else if (
      modelMessageContentToText(message.content).trimStart().startsWith("<system-reminder>")
    ) {
      continue;
    }
    return modelMessageContentToText(message.content);
  }
  return undefined;
}

/** trim 后仍含空白（≥2 词）才值得召回；单词 query 直接跳过（闭源 isMemoryRecallQueryEligible）。 */
export function isMemoryRecallQueryEligible(query: string | undefined): boolean {
  return query !== undefined && /\s/u.test(query.trim());
}

/**
 * Selector 请求 = system prompt + 历史 selector 对话链 + 本轮 query。
 * 对话链让模型看到「之前选过什么」，配合 prompt 中的软约束实现跨轮去重（闭源 buildMemorySelectorRequest）。
 */
export function buildMemorySelectorRequest(input: {
  query: string;
  state: MemoryRecallState;
}): ModelRequest {
  return {
    messages: [
      {
        role: "system",
        content: MEMORY_SELECTOR_SYSTEM_PROMPT,
        cacheControl: { type: "ephemeral" },
      },
      ...selectorConversation(input.state),
      {
        role: "user",
        content: `Select memories relevant to:\n${input.query}`,
        cacheControl: { type: "ephemeral" },
      },
    ],
    responseJsonSchema: MEMORY_SELECTOR_RESPONSE_SCHEMA,
  };
}

/** 已有历史链则复用；否则用当前 manifest 现构造首条 Available memories 消息（闭源 selectorConversation）。 */
function selectorConversation(state: MemoryRecallState): MemorySelectorMessage[] {
  if (state.selectorMessages) return state.selectorMessages;
  const manifest = state.manifest ?? [];
  return [
    {
      role: "user",
      content: `Available memories:\n${formatMemoryManifest(manifest)}`,
      cacheControl: { type: "ephemeral" },
    },
  ];
}

/**
 * 单次 selector 调用。manifest 空或全已召回时直接返回空；
 * 成功后把本轮 query + assistant 原文追加进对话链（多轮选择上下文）。
 * 任何异常吞掉返回空——召回失败绝不能影响主 turn（闭源 runMemorySelector）。
 */
export async function runMemorySelector(input: {
  abortSignal?: AbortSignal;
  model: Model;
  query: string;
  state: MemoryRecallState;
}): Promise<MemorySelectorResult> {
  try {
    const manifest = input.state.manifest;
    if (!manifest || manifest.length === 0) return emptySelectorResult();
    if (manifest.every((entry) => input.state.recalledPaths.has(entry.filePath))) {
      return emptySelectorResult();
    }
    const request = buildMemorySelectorRequest({ query: input.query, state: input.state });
    request.abortSignal = input.abortSignal;
    // 复用现有 auxiliaryModelOptions：最低 reasoning 档 + min(5000, max) 输出预算。
    request.options = { ...request.options, ...auxiliaryModelOptions(input.model) };
    const result = await input.model.generateText(request);
    if (input.abortSignal?.aborted) return emptySelectorResult();
    const parsed = parseSelectorResponse(result.text);
    if (!parsed) return emptySelectorResult();
    const conversation = selectorConversation(input.state);
    input.state.selectorMessages = [
      ...conversation,
      { role: "user", content: `Select memories relevant to:\n${input.query}` },
      { role: "assistant", content: result.text },
    ];
    return parsed;
  } catch {
    return emptySelectorResult();
  }
}

/**
 * 白名单过滤：filename ∩ manifest → 排除主对话已 Read 过的文件 → 排除已召回路径 → 截前 5 个。
 * readFileState 命中即跳过是防重复上下文：主对话读过的文件不再以 reminder 形式二次注入
 * （闭源 filterMemorySelections，readFileState 查询用 findEditableReadFileState 的同 path 语义）。
 */
export function filterMemorySelections(input: {
  manifest: readonly MemoryManifestEntry[];
  readFileState: ReadFileStateMap;
  recalledPaths: ReadonlySet<string>;
  selectedFilenames: readonly string[];
}): MemoryManifestEntry[] {
  const manifestByFilename = new Map(input.manifest.map((entry) => [entry.filename, entry]));
  return input.selectedFilenames
    .map((filename) => manifestByFilename.get(filename))
    .filter((entry): entry is MemoryManifestEntry => entry !== undefined)
    .filter((entry) => !findEditableReadFileState(input.readFileState, entry.filePath))
    .filter((entry) => !input.recalledPaths.has(entry.filePath))
    .slice(0, MAX_RECALLED_FILES_PER_TURN);
}

/**
 * 严格解析 selector 输出：JSON.parse 后必须是对象、键 ⊆ {selected_memories, selected_knowledge_ids}、
 * 两个数组的元素均为 string。任何不符整体判失败（回退空结果），不猜测修复（闭源 parseSelectorResponse）。
 */
export function parseSelectorResponse(text: string): MemorySelectorResult | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;
  for (const key of Object.keys(parsed)) {
    if (key !== "selected_memories" && key !== "selected_knowledge_ids") return undefined;
  }
  const selectedMemories = parsed.selected_memories;
  if (!isStringArray(selectedMemories)) return undefined;
  const selectedKnowledgeIds = parsed.selected_knowledge_ids;
  if (selectedKnowledgeIds !== undefined && !isStringArray(selectedKnowledgeIds)) {
    return undefined;
  }
  return {
    selectedMemories: [...selectedMemories],
    selectedKnowledgeIds: selectedKnowledgeIds ? [...selectedKnowledgeIds] : [],
  };
}

export function emptySelectorResult(): MemorySelectorResult {
  return { selectedKnowledgeIds: [], selectedMemories: [] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
