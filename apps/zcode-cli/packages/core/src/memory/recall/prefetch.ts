// Project Memory 语义召回：turn 生命周期（预取 start / 消费 consume / 释放 dispose / 重置 reset）。
// 行为依据：官方闭源 bundle 的模块 wve 与常量 UG（见 /tmp/spec-memory-selector.md §3.5、§5.11）：
// - turn 启动后、首次模型请求前后台预取（不阻塞首答）；
// - 仅当 turn 内发生真实工具结果批次后的下一次模型请求边界消费注入（一次性）；
// - turn finally 释放；compact 完成与 resume/rewind 时整体重置。
// 注意：官方构建把 retrieval branch 编译期固定为 "default-index"（UG=ZKs(!1)）；
// 本仓库保留同一函数与默认值，经 ZCODE_MEMORY_SEMANTIC_RECALL 环境变量切换（见下方常量）。

import { createMessageId, type Model, type TraceContext } from "@zcode/contracts";

import {
  systemReminderAttachmentEntry,
  type RuntimeAttachmentEntry,
} from "../../agent/message-history.js";
import {
  createReadFileStateKey,
  normalizeReadFileStateMtimeMs,
} from "../../tool/read-file-state.js";
import type { ReadFileStateMap } from "../../tool/types.js";
import type { AgentRuntimeInternal } from "../../runtime/internal.js";
import { withModelInvocationContext } from "../../runtime/methods/runtime-model.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "../../runtime/methods/model-runtime-headers.js";
import {
  formatRelevantMemoryAttachment,
  readRecalledMemories,
  type RecalledMemory,
} from "./attachment.js";
import type { MemoryManifestEntry } from "./types.js";
import {
  canStartMemoryRecall,
  createMemoryRecallState,
  filterMemorySelections,
  findLatestMemoryRecallQuery,
  getMemoryRecallManifest,
  hasRecalledEveryManifestEntry,
  isMemoryRecallQueryEligible,
  recordRecalledMemories,
  runMemorySelector,
} from "./selector.js";

export type ProjectMemoryRetrievalBranch = "default-index" | "semantic-recall";

/**
 * 检索分支解析（闭源 ZKs）：enabled 时走语义召回，否则走 MEMORY.md 索引全文进 system prompt。
 * 官方构建以编译期常量 false 调用，恒为 "default-index"。
 */
export function resolveProjectMemoryRetrievalBranch(
  enabled: boolean,
): ProjectMemoryRetrievalBranch {
  return enabled ? "semantic-recall" : "default-index";
}

/**
 * 本仓库的分支常量：默认与官方构建一致（default-index，不启用语义召回）。
 * 开关沿用 CLI 既有 process.env.UPPER_SNAKE 读取模式（如 ZCODE_MAX_TOOL_CONCURRENCY），
 * 取 "1"/"true" 时切到 semantic-recall；模块加载期求值一次，等价官方的编译期常量语义。
 */
export const PROJECT_MEMORY_RETRIEVAL_BRANCH: ProjectMemoryRetrievalBranch =
  resolveProjectMemoryRetrievalBranch(
    process.env.ZCODE_MEMORY_SEMANTIC_RECALL === "1" ||
      process.env.ZCODE_MEMORY_SEMANTIC_RECALL === "true",
  );

/** 一条预取产物：manifest 项 + 已读取截断的内容。 */
export interface PrefetchedMemory {
  entry: MemoryManifestEntry;
  memory: RecalledMemory;
}

/**
 * turn 级预取句柄（挂在 runtime.memoryRecallPrefetch 上，一 turn 至多一个）。
 * settled/consumed 构成一次性消费状态机：settled 后第一个请求边界消费，consumed 防二次注入。
 */
export interface MemoryRecallPrefetch {
  abortController: AbortController;
  consumed: boolean;
  detachTurnAbort: () => void;
  memories: PrefetchedMemory[];
  settled: boolean;
}

/**
 * turn 启动处的预取入口。全部守卫（闭源 XEo）：分支开启、无在途预取、memoryRoot/文件端口在场、
 * 模型支持 JSON Schema 输出、会话预算未耗尽、query 合法、manifest 未全召回。
 * 预取完全异步：失败静默收敛为空结果，绝不影响主 turn。
 */
export function startProjectMemoryRecallPrefetch(
  runtime: AgentRuntimeInternal,
  input: {
    model: Model;
    traceContext: TraceContext;
    turnAbortSignal: AbortSignal;
  },
  branch: ProjectMemoryRetrievalBranch,
): void {
  if (branch !== "semantic-recall") return;
  if (runtime.memoryRecallPrefetch || !runtime.memoryRoot || !runtime.fileSystemPort) return;
  if (!input.model.properties.supportsJsonSchemaOutput) return;
  if (!canStartMemoryRecall(runtime.memoryRecallState)) return;
  const query = findLatestMemoryRecallQuery(runtime.messageHistory.borrowReadOnlyRuntimeEntries());
  if (typeof query !== "string" || !isMemoryRecallQueryEligible(query)) return;
  const state = runtime.memoryRecallState;
  if (hasRecalledEveryManifestEntry(state)) return;

  const abortController = new AbortController();
  const prefetch: MemoryRecallPrefetch = {
    abortController,
    consumed: false,
    detachTurnAbort: forwardTurnAbort(input.turnAbortSignal, abortController),
    memories: [],
    settled: false,
  };
  runtime.memoryRecallPrefetch = prefetch;
  // 快照读状态：预取期间主对话的 Read/召回变化不回溯影响本轮过滤判定（闭源 XEo 同样 copy）。
  const readFileStateSnapshot = new Map(runtime.readFileState);
  const recalledPathsSnapshot = new Set(state.recalledPaths);
  prefetchProjectMemories(runtime, {
    abortSignal: abortController.signal,
    causation: runtime.agentTelemetry.captureCausation(),
    model: input.model,
    query,
    readFileStateSnapshot,
    recalledPathsSnapshot,
    rootDir: runtime.memoryRoot,
    state,
    traceContext: input.traceContext,
  })
    .then((memories) => {
      prefetch.memories = memories;
    })
    .catch(() => {
      prefetch.memories = [];
    })
    .finally(() => {
      prefetch.settled = true;
      prefetch.detachTurnAbort();
    });
}

/**
 * 模型请求循环边界上的消费入口（前置条件：真实工具结果批次已完成）。
 * settled 且未消费时用 live 状态再过滤（主对话可能已 Read 过预取选中的文件），
 * 然后写 readFileState、追加 messageHistory、按持久化路径落 transcript、登记预算。
 * 返回注入的 attachment entry（或 undefined），由调用方并入本次请求 entries（闭源 QEo）。
 */
export async function consumeSettledProjectMemoryRecall(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
  branch: ProjectMemoryRetrievalBranch,
): Promise<RuntimeAttachmentEntry | undefined> {
  if (branch !== "semantic-recall") return;
  const prefetch = runtime.memoryRecallPrefetch;
  if (!prefetch || !prefetch.settled || prefetch.consumed) return;
  // 一次性消费标志先置位：即使过滤后为空也不再重试，保证每 turn 至多注入一批。
  prefetch.consumed = true;
  const state = runtime.memoryRecallState;
  const selected = filterMemorySelections({
    manifest: state.manifest ?? prefetch.memories.map(({ entry }) => entry),
    readFileState: runtime.readFileState,
    recalledPaths: state.recalledPaths,
    selectedFilenames: prefetch.memories.map(({ entry }) => entry.filename),
  });
  const memories = matchPrefetchedMemories(prefetch.memories, selected);
  if (memories.length === 0) return;

  // 注入的 memory 反向写 readFileState（key 与 Read 工具一致：offset 缺省、limit 仅截断时有），
  // 使后续 Read/Edit 边界与 provider 已见内容一致，避免模型重复读取同一文件。
  const readAt = new Date();
  for (const memory of memories) {
    runtime.readFileState.set(createReadFileStateKey(memory.filePath, undefined, memory.limit), {
      content: memory.content,
      isPartialView: false,
      ...(memory.limit !== undefined ? { limit: memory.limit } : {}),
      mtimeMs: normalizeReadFileStateMtimeMs(memory.mtimeMs),
      offset: undefined,
      path: memory.filePath,
      readAt,
      ...(memory.revisionId ? { revisionId: memory.revisionId } : {}),
      ...(memory.sizeBytes !== undefined ? { sizeBytes: memory.sizeBytes } : {}),
    });
  }

  const body = formatRelevantMemoryAttachment(memories);
  const entry = systemReminderAttachmentEntry("relevant_memory", body);
  runtime.messageHistory.addEntries([entry]);
  // 闭源的 addEntries 本身会写 transcript；开源 MessageHistory 仅内存态，
  // 持久化走与 todo_reminder 相同的 synthetic notice 落盘路径（provider-visible、UI 不显示正文）。
  await runtime.persistSyntheticUserNoticeForSession({
    messageID: createMessageId(),
    metadata: { runtimeMessage: { source: "relevant_memory" } },
    sessionId: runtime.sessionId,
    source: "relevant_memory",
    text: body,
    traceContext,
  });
  recordRecalledMemories(state, memories);
  return entry;
}

/** turn finally：中止未完成的预取并释放句柄（闭源 Dxn）。 */
export function disposeProjectMemoryRecallPrefetch(runtime: AgentRuntimeInternal): void {
  const prefetch = runtime.memoryRecallPrefetch;
  if (!prefetch) return;
  runtime.memoryRecallPrefetch = undefined;
  prefetch.detachTurnAbort();
  prefetch.abortController.abort();
}

/**
 * compact 完成（伴随 readFileState.clear()）与 session resume/rewind 时整体重置：
 * 丢弃 manifest 缓存、selector 对话链与召回登记（闭源 hyt）。
 */
export function resetProjectMemoryRecall(runtime: AgentRuntimeInternal): void {
  disposeProjectMemoryRecallPrefetch(runtime);
  runtime.memoryRecallState = createMemoryRecallState();
}

/**
 * 后台预取主体（闭源 hTa）：manifest（会话缓存）→ selector → 过滤 → 并发读取，
 * 运行在 detached telemetry span 内。全部已召回时直接空完成；
 * 失败按 abort/内部错误分别收口后原样上抛（由 start 的 catch 吞为空结果）。
 */
async function prefetchProjectMemories(
  runtime: AgentRuntimeInternal,
  input: {
    abortSignal: AbortSignal;
    causation: ReturnType<AgentRuntimeInternal["agentTelemetry"]["captureCausation"]>;
    model: Model;
    query: string;
    readFileStateSnapshot: ReadFileStateMap;
    recalledPathsSnapshot: Set<string>;
    rootDir: string;
    state: AgentRuntimeInternal["memoryRecallState"];
    traceContext: TraceContext;
  },
): Promise<PrefetchedMemory[]> {
  const telemetry = runtime.agentTelemetry.detached({
    causation: input.causation,
    executionKind: "background",
    operation: "project_memory_recall",
    targetKind: "project_memory",
    traceContext: input.traceContext,
    trigger: "turn",
  });
  return telemetry.run(async () => {
    try {
      const fileSystem = runtime.fileSystemPort!;
      const manifest = await getMemoryRecallManifest({
        fileSystem,
        rootDir: input.rootDir,
        signal: input.abortSignal,
        state: input.state,
      });
      if (manifest.every((entry) => input.recalledPathsSnapshot.has(entry.filePath))) {
        telemetry.setResultType("metadata");
        telemetry.finishCompleted();
        return [];
      }
      const selection = await runMemorySelector({
        abortSignal: input.abortSignal,
        model: selectorModel(runtime, input.model, input.traceContext),
        query: input.query,
        state: input.state,
      });
      const entries = filterMemorySelections({
        manifest,
        readFileState: input.readFileStateSnapshot,
        recalledPaths: input.recalledPathsSnapshot,
        selectedFilenames: selection.selectedMemories,
      });
      const memories = await readRecalledMemories({
        entries,
        fileSystem,
        nowMs: runtime.now().getTime(),
        signal: input.abortSignal,
      });
      const entryByPath = new Map(entries.map((entry) => [entry.filePath, entry]));
      telemetry.setResultType("metadata");
      telemetry.finishCompleted();
      return memories.flatMap((memory) => {
        const entry = entryByPath.get(memory.filePath);
        return entry ? [{ entry, memory }] : [];
      });
    } catch (error) {
      if (input.abortSignal.aborted || isAbortError(error)) {
        telemetry.finishCancelled("abort_signal");
      } else {
        telemetry.finishFailed("execute", "internal", error);
      }
      throw error;
    }
  });
}

/**
 * selector 复用当前 turn 的模型实例（非独立小模型），仅叠加调用元数据
 * （闭源 _Ta）：operation=project_memory_recall、sessionType=other、请求前刷新 runtime headers。
 * 与 extraction 的 project_memory_extract 不同，不设 skipTranscript——selector 请求进 model-io transcript。
 */
function selectorModel(
  runtime: AgentRuntimeInternal,
  model: Model,
  traceContext: TraceContext,
): Model {
  return withModelInvocationContext(model, (request) => ({
    metadata: { querySource: "project_memory_recall" },
    modelRequestSessionType: "other",
    modelCall: { operation: "project_memory_recall" },
    refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(runtime, {
      abortSignal: request.abortSignal,
      model,
      traceContext,
    }),
    traceContext,
  }));
}

/**
 * 预取结果按 filename 分组后按过滤清单顺序 shift() 对齐，
 * 保证注入顺序 = 过滤清单顺序而非并发完成顺序（闭源 vTa）。
 */
function matchPrefetchedMemories(
  prefetched: readonly PrefetchedMemory[],
  filtered: readonly MemoryManifestEntry[],
): RecalledMemory[] {
  const byFilename = new Map<string, PrefetchedMemory[]>();
  for (const item of prefetched) {
    const bucket = byFilename.get(item.entry.filename);
    if (bucket) {
      bucket.push(item);
    } else {
      byFilename.set(item.entry.filename, [item]);
    }
  }
  const memories: RecalledMemory[] = [];
  for (const entry of filtered) {
    const bucket = byFilename.get(entry.filename);
    const matched = bucket?.shift();
    if (matched) memories.push(matched.memory);
  }
  return memories;
}

/** turnAbortSignal → 预取 controller 的中止转发；返回 detach（闭源 bTa）。 */
function forwardTurnAbort(turnAbortSignal: AbortSignal, controller: AbortController): () => void {
  const onAbort = () => controller.abort();
  if (turnAbortSignal.aborted) {
    controller.abort();
    return () => {};
  }
  turnAbortSignal.addEventListener("abort", onAbort, { once: true });
  return () => {
    turnAbortSignal.removeEventListener("abort", onAbort);
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
