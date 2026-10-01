// Project Memory 语义召回：召回内容读取与注入正文格式化。
// 行为依据：官方闭源 bundle 的模块 KEo（见 /tmp/spec-memory-selector.md §3.3）：
// 每个被选中的 memory 文件并发读取，截断到 200 行 / 4096 UTF-8 字节（不撕裂半行），
// 注入正文按文件年龄加免责头，截断时提示用 Read 工具看全文。

import { Buffer } from "node:buffer";

import type { FileSystemPort } from "@zcode/contracts";

import type { MemoryManifestEntry } from "./types.js";

/** 单文件召回的行数上限（闭源 dTa 的 readTextFileRange(0,200)）。 */
const RECALL_LINE_LIMIT = 200;

/** 单文件召回的 UTF-8 字节上限（闭源 pTa 的 4096，按完整行累计）。 */
const RECALL_BYTE_LIMIT = 4096;

const DAY_MS = 86_400_000;

/** 注入正文首条 memory 的固定前言（闭源 Rxn 中仅 index===0 时拼接）。 */
const RELEVANT_MEMORY_PREAMBLE =
  "Retrieved for possible relevance — use only if it actually applies to what the user asked.";

const TRUNCATION_NOTICE_PREFIX =
  "> This memory file was truncated (4096 byte limit | first 200 lines). Use the Read tool to view the complete file at: ";

export interface RecalledMemory {
  content: string;
  filePath: string;
  header: string;
  /** 保留的行数；仅截断时存在，用于写 readFileState 与 Read 工具边界一致。 */
  limit?: number;
  mtimeMs: number;
  revisionId?: string;
  sizeBytes?: number;
}

/** 并发读取被选中的 memory 文件；单个失败只影响该文件（Promise.allSettled，闭源 Pxn）。 */
export async function readRecalledMemories(input: {
  entries: readonly MemoryManifestEntry[];
  fileSystem: FileSystemPort;
  nowMs: number;
  signal?: AbortSignal;
}): Promise<RecalledMemory[]> {
  const settled = await Promise.allSettled(
    input.entries.map((entry) =>
      readRecalledMemory({
        entry,
        fileSystem: input.fileSystem,
        nowMs: input.nowMs,
        signal: input.signal,
      }),
    ),
  );
  return settled
    .filter(
      (result): result is PromiseFulfilledResult<RecalledMemory> => result.status === "fulfilled",
    )
    .map((result) => result.value);
}

async function readRecalledMemory(input: {
  entry: MemoryManifestEntry;
  fileSystem: FileSystemPort;
  nowMs: number;
  signal?: AbortSignal;
}): Promise<RecalledMemory> {
  const filePath = input.entry.filePath;
  // 先按行数上限请求范围读，再按字节上限裁完整行；两层上限独立生效。
  const read = await input.fileSystem.readTextFileRange(
    { path: filePath, offsetLine: 0, limitLines: RECALL_LINE_LIMIT },
    { signal: input.signal },
  );
  // port 层已归一为 LF；此处仍防御 BOM/CRLF，保证行拆分与字节计量稳定（闭源 dTa 同样去 BOM/CRLF）。
  const normalized = read.content.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
  const lines = normalized.split("\n");
  const byteLimited = limitCompleteLinesByBytes(lines, RECALL_BYTE_LIMIT);
  const truncated = byteLimited.truncated || read.totalLines > RECALL_LINE_LIMIT;
  const content = truncated
    ? `${byteLimited.lines.join("\n")}\n${TRUNCATION_NOTICE_PREFIX}${filePath}`
    : normalized;
  return {
    content,
    filePath,
    header: memoryHeader(filePath, read.revision?.mtimeMs ?? 0, input.nowMs),
    ...(truncated ? { limit: byteLimited.lines.length } : {}),
    mtimeMs: read.revision?.mtimeMs ?? 0,
    ...(read.revision?.id ? { revisionId: read.revision.id } : {}),
    ...(read.sizeBytes !== undefined ? { sizeBytes: read.sizeBytes } : {}),
  };
}

/**
 * 按完整行累计 UTF-8 字节（行间分隔符计 1 字节），超上限即停，保证不撕裂半行。
 * 返回 truncated=true 表示存在因字节上限被丢弃的行（闭源 pTa）。
 */
export function limitCompleteLinesByBytes(
  lines: readonly string[],
  byteLimit = RECALL_BYTE_LIMIT,
): { lines: string[]; truncated: boolean } {
  const kept: string[] = [];
  let totalBytes = 0;
  for (const line of lines) {
    // 首行无分隔符；之后每行前有 1 个换行字节。
    const cost = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0);
    if (totalBytes + cost > byteLimit) {
      return { lines: kept, truncated: true };
    }
    kept.push(line);
    totalBytes += cost;
  }
  return { lines: kept, truncated: false };
}

/**
 * 按文件年龄生成头部：≤1 天直接给路径；≥2 天先声明「记忆是时点观测、非实时状态」，
 * 提醒模型先核对当前代码再当事实引用（闭源 fTa）。
 */
export function memoryHeader(filePath: string, mtimeMs: number, nowMs: number): string {
  const ageDays = Math.max(0, Math.floor((nowMs - mtimeMs) / DAY_MS));
  if (ageDays <= 1) {
    return `Memory: ${filePath}:`;
  }
  return [
    `This memory is ${ageDays} days old. Memories are point-in-time observations, not live state — claims about code behavior or file:line citations may be outdated. Verify against current code before asserting as fact.`,
    "",
    `Memory: ${filePath}:`,
  ].join("\n");
}

/** N 条 memory 以空行连接；仅第一条带前言（闭源 Rxn）。 */
export function formatRelevantMemoryAttachment(memories: readonly RecalledMemory[]): string {
  return memories
    .map((memory, index) => {
      const preamble = index === 0 ? `${RELEVANT_MEMORY_PREAMBLE}\n\n` : "";
      return `${preamble}${memory.header}\n\n${memory.content}`;
    })
    .join("\n\n");
}
