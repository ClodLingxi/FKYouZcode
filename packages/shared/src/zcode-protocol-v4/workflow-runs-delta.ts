/* eslint-disable max-lines -- workflow run 增量协议的 schema 与 diff/apply/降级编码三段
   必须同居一份：它们是同一条语义（diff 产出 ↔ apply 归约 ↔ 旧客户端折叠）的三个面，
   拆开会重蹈「两处各写一份就是两个时钟」的覆辙。 */
// ============================================================
// workflowRuns 的按 run 增量协议（官方 3.14.3 对齐）
// ============================================================
// 3.14.3 起，conversation delta 日志里的 workflow 运行态可以走两条编码：
//   - 旧编码（始终可用）：`state.updated { workflowRuns }` 键级整体替换；
//   - 新编码（客户端 hello 声明 `capabilities.workflowRunDeltas` 后）：
//     `workflowRun.updated` / `workflowRun.removed` 按 runId 发增量——run 的
//     非集合字段走 partial patch（`run`），集合字段走 identity diff
//     （removedActors/removedNodes 删除 + actors/nodes 按 (siteId, ordinal) upsert），
//     可空集合键（reports/pendingQuestions/artifacts/concurrency…）走 `cleared` 显式清空。
// delta 日志统一存新编码；旧客户端在订阅编码边界由
// encodeConversationDeltasForLegacy 整体降级回 state.updated（见文件尾）。
// 本模块同时承载协议 schema 与 diff/apply 两侧纯函数，TUI/web 镜像共用。
import { z } from "zod";

import type { ConversationDelta } from "./delta.js";
import {
  WORKFLOW_RUNS_LIMITS,
  workflowRunActorSchema,
  workflowRunNodeSchema,
  workflowRunSchema,
  workflowRunsStateSchema,
  type WorkflowRunActor,
  type WorkflowRunNode,
  type WorkflowRunState,
  type WorkflowRunsState,
} from "./workflow-runs.js";

// ── schema ──

/** actor/node 的身份键：`(siteId, ordinal)`，与 journal 的去重键同族。 */
export const workflowRunIdentitySchema = workflowRunActorSchema.pick({
  siteId: true,
  ordinal: true,
});
export type WorkflowRunIdentity = z.infer<typeof workflowRunIdentitySchema>;

/** run 除 actors/nodes 集合以外的全部键（partial patch 与 cleared 的取值域）。 */
export const workflowRunBookkeepingSchema = workflowRunSchema.omit({
  actors: true,
  nodes: true,
});
export type WorkflowRunBookkeeping = z.infer<typeof workflowRunBookkeepingSchema>;

export const workflowRunDeltaPatchSchema = workflowRunBookkeepingSchema.partial();
export type WorkflowRunDeltaPatch = z.infer<typeof workflowRunDeltaPatchSchema>;

/** `cleared` 的取值域 = 非集合键全体；消费端按「键从 run 上消失」解释。 */
export const clearableWorkflowRunKeySchema = workflowRunBookkeepingSchema.keyof();
export type ClearableWorkflowRunKey = z.infer<typeof clearableWorkflowRunKeySchema>;
const CLEARABLE_WORKFLOW_RUN_KEY_COUNT = clearableWorkflowRunKeySchema.options.length;

export const workflowRunUpdatedOpSchema = z.object({
  op: z.literal("workflowRun.updated"),
  runId: workflowRunSchema.shape.runId,
  revision: workflowRunsStateSchema.shape.revision,
  /** 非「cleared」非集合字段的 patch；只携带发生变化的键。 */
  run: workflowRunDeltaPatchSchema.optional(),
  cleared: z
    .array(clearableWorkflowRunKeySchema)
    .max(CLEARABLE_WORKFLOW_RUN_KEY_COUNT)
    .optional(),
  removedActors: z
    .array(workflowRunIdentitySchema)
    .max(WORKFLOW_RUNS_LIMITS.maxActors)
    .optional(),
  removedNodes: z
    .array(workflowRunIdentitySchema)
    .max(WORKFLOW_RUNS_LIMITS.maxNodes)
    .optional(),
  actors: z.array(workflowRunActorSchema).max(WORKFLOW_RUNS_LIMITS.maxActors).optional(),
  nodes: z.array(workflowRunNodeSchema).max(WORKFLOW_RUNS_LIMITS.maxNodes).optional(),
});
export type WorkflowRunUpdatedOp = z.infer<typeof workflowRunUpdatedOpSchema>;

export const workflowRunRemovedOpSchema = z.object({
  op: z.literal("workflowRun.removed"),
  runId: workflowRunSchema.shape.runId,
  revision: workflowRunsStateSchema.shape.revision,
});
export type WorkflowRunRemovedOp = z.infer<typeof workflowRunRemovedOpSchema>;

export const workflowRunDeltaOpSchema = z.discriminatedUnion("op", [
  workflowRunUpdatedOpSchema,
  workflowRunRemovedOpSchema,
]);
export type WorkflowRunDeltaOp = z.infer<typeof workflowRunDeltaOpSchema>;

export function isWorkflowRunDeltaOp(delta: ConversationDelta): delta is WorkflowRunDeltaOp {
  return delta.op === "workflowRun.updated" || delta.op === "workflowRun.removed";
}

// ── 深比较（值语义；undefined 键视为缺席，不参与相等） ──

function workflowValueEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => workflowValueEquals(entry, right[index]));
  }
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  let leftCount = 0;
  for (const key of Object.keys(leftRecord)) {
    const value = leftRecord[key];
    if (value === undefined) continue;
    leftCount += 1;
    if (!workflowValueEquals(value, rightRecord[key])) return false;
  }
  let rightCount = 0;
  for (const key of Object.keys(rightRecord)) {
    if (rightRecord[key] !== undefined) rightCount += 1;
  }
  return leftCount === rightCount;
}

// ── diff（发布端）：旧 run 状态 → 新 run 状态的单条 op ──

const DIFFABLE_RUN_KEYS = Object.keys(workflowRunSchema.shape).filter(
  (key) => key !== "actors" && key !== "nodes",
) as Array<keyof WorkflowRunBookkeeping>;

/** 恰好携带全部 schema 必填键的 run patch（可独立长成一条完整 run）。 */
function hasAllRequiredRunKeys(patch: WorkflowRunDeltaPatch | undefined): boolean {
  if (patch === undefined || typeof patch !== "object") return false;
  for (const key of DIFFABLE_RUN_KEYS) {
    const isOptional = workflowRunBookkeepingSchema.shape[key].isOptional();
    if (!isOptional && patch[key] === undefined) return false;
  }
  return true;
}

interface IdentityListDiff<T> {
  removed: WorkflowRunIdentity[];
  changed: T[];
}

function workflowRunIdentityKey(entry: { siteId: string; ordinal: number }): string {
  return `${entry.siteId}:${entry.ordinal}`;
}

/**
 * actors/nodes 共用的 identity-list diff。
 * - `undefined`：无变化（含同引用短路）；
 * - `null`：出现乱序/非前缀化插入，无法安全表达——调用方必须整键回退 state.updated。
 */
function diffIdentityList<T extends WorkflowRunIdentity & object>(
  previous: readonly T[],
  next: readonly T[],
): IdentityListDiff<T> | undefined | null {
  if (previous === next) return undefined;
  if (previous.length <= next.length) {
    const changed: T[] = [];
    let prefixAligned = true;
    for (let index = 0; index < next.length && prefixAligned; index += 1) {
      const entry = next[index]!;
      const before = previous[index];
      if (before === undefined) {
        changed.push(entry);
        continue;
      }
      if (before === entry) continue;
      if (before.siteId !== entry.siteId || before.ordinal !== entry.ordinal) {
        prefixAligned = false;
        break;
      }
      if (!workflowValueEquals(before, entry)) changed.push(entry);
    }
    if (prefixAligned) {
      return changed.length > 0 ? { removed: [], changed } : undefined;
    }
  }
  return diffIdentityListByKeyset(previous, next);
}

function diffIdentityListByKeyset<T extends WorkflowRunIdentity & object>(
  previous: readonly T[],
  next: readonly T[],
): IdentityListDiff<T> | undefined | null {
  const nextKeys = new Set(next.map(workflowRunIdentityKey));
  const removed: WorkflowRunIdentity[] = [];
  const kept: T[] = [];
  for (const entry of previous) {
    if (nextKeys.has(workflowRunIdentityKey(entry))) {
      kept.push(entry);
    } else {
      removed.push({ siteId: entry.siteId, ordinal: entry.ordinal });
    }
  }
  if (kept.length > next.length) return null;
  const changed: T[] = [];
  for (let index = 0; index < next.length; index += 1) {
    const entry = next[index]!;
    const before = kept[index];
    if (before === undefined) {
      changed.push(entry);
      continue;
    }
    if (before.siteId !== entry.siteId || before.ordinal !== entry.ordinal) return null;
    if (before !== entry && !workflowValueEquals(before, entry)) changed.push(entry);
  }
  if (removed.length === 0 && changed.length === 0) return undefined;
  return { removed, changed };
}

/**
 * 单个 run 的增量：`undefined` = 无变化；`null` = 集合 diff 不可表达，调用方整键回退。
 */
function diffWorkflowRun(
  previous: WorkflowRunState | undefined,
  next: WorkflowRunState,
  revision: number,
): ConversationDelta | undefined | null {
  const runPatch: Record<string, unknown> = {};
  const cleared: ClearableWorkflowRunKey[] = [];
  if (previous === undefined) {
    for (const key of DIFFABLE_RUN_KEYS) {
      const value = next[key];
      if (value !== undefined) runPatch[key] = value;
    }
    return {
      op: "workflowRun.updated",
      runId: next.runId,
      revision,
      run: runPatch as WorkflowRunDeltaPatch,
      ...(next.actors.length > 0 ? { actors: [...next.actors] } : {}),
      ...(next.nodes.length > 0 ? { nodes: [...next.nodes] } : {}),
    };
  }
  for (const key of DIFFABLE_RUN_KEYS) {
    const before = previous[key];
    const after = next[key];
    if (before === after) continue;
    if (after === undefined) {
      cleared.push(key as ClearableWorkflowRunKey);
      continue;
    }
    if (before !== undefined && workflowValueEquals(before, after)) continue;
    runPatch[key] = after;
  }
  const actorDiff = diffIdentityList<WorkflowRunActor>(previous.actors, next.actors);
  const nodeDiff = diffIdentityList<WorkflowRunNode>(previous.nodes, next.nodes);
  if (actorDiff === null || nodeDiff === null) return null;
  const hasRunPatch = Object.keys(runPatch).length > 0;
  if (!hasRunPatch && cleared.length === 0 && actorDiff === undefined && nodeDiff === undefined) {
    return undefined;
  }
  return {
    op: "workflowRun.updated",
    runId: next.runId,
    revision,
    ...(hasRunPatch ? { run: runPatch as WorkflowRunDeltaPatch } : {}),
    ...(cleared.length > 0 ? { cleared } : {}),
    ...(actorDiff !== undefined && actorDiff.removed.length > 0
      ? { removedActors: actorDiff.removed }
      : {}),
    ...(nodeDiff !== undefined && nodeDiff.removed.length > 0
      ? { removedNodes: nodeDiff.removed }
      : {}),
    ...(actorDiff !== undefined && actorDiff.changed.length > 0
      ? { actors: actorDiff.changed }
      : {}),
    ...(nodeDiff !== undefined && nodeDiff.changed.length > 0 ? { nodes: nodeDiff.changed } : {}),
  };
}

/**
 * 工作流运行态的逐 run diff（发布端入口）。
 * 任一 run 出现不可表达的集合变化 → 整体回退单条 state.updated；
 * 全无 diff 但 revision 抬升（如上限淘汰不可见）→ 同样回退，保证订阅端 revision 推进。
 */
export function diffWorkflowRunsState(
  previous: WorkflowRunsState | undefined,
  next: WorkflowRunsState,
): ConversationDelta[] {
  const ops: ConversationDelta[] = [];
  const nextIds = new Set(next.runs.map((run) => run.runId));
  for (const run of previous?.runs ?? []) {
    if (nextIds.has(run.runId)) continue;
    ops.push({ op: "workflowRun.removed", runId: run.runId, revision: next.revision });
  }
  const previousByRunId = new Map((previous?.runs ?? []).map((run) => [run.runId, run]));
  for (const run of next.runs) {
    const before = previousByRunId.get(run.runId);
    if (before === run) continue;
    const delta = diffWorkflowRun(before, run, next.revision);
    if (delta === null) return [{ op: "state.updated", patch: { workflowRuns: next } }];
    if (delta !== undefined) ops.push(delta);
  }
  if (
    ops.length === 0 &&
    (previous?.revision ?? -1) !== next.revision
  ) {
    return [{ op: "state.updated", patch: { workflowRuns: next } }];
  }
  return ops;
}

// ── apply（消费端）：把单条 op 归约进本地 workflowRuns 状态 ──

const RUN_SCHEMA_KEYS = new Set(Object.keys(workflowRunSchema.shape));

/** 只保留 schema 已知的键：增量帧可能来自更新版本的 CLI，未知键不上本地状态。 */
function sanitizeWorkflowRun(run: WorkflowRunState): WorkflowRunState {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(run)) {
    if (RUN_SCHEMA_KEYS.has(key) && value !== undefined) sanitized[key] = value;
  }
  return workflowRunSchema.parse(sanitized);
}

function removeIdentityEntries<T extends WorkflowRunIdentity & object>(
  entries: readonly T[],
  removed: readonly WorkflowRunIdentity[] | undefined,
): T[] {
  if (removed === undefined || removed.length === 0) return [...entries];
  const removedKeys = new Set(removed.map(workflowRunIdentityKey));
  const kept = entries.filter((entry) => !removedKeys.has(workflowRunIdentityKey(entry)));
  return kept;
}

function upsertIdentityEntries<T extends WorkflowRunIdentity & object>(
  entries: readonly T[],
  changed: readonly T[],
): T[] {
  const result = [...entries];
  const indexByKey = new Map<string, number>();
  result.forEach((entry, index) => indexByKey.set(workflowRunIdentityKey(entry), index));
  for (const entry of changed) {
    const key = workflowRunIdentityKey(entry);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, result.length);
      result.push(entry);
      continue;
    }
    result[existingIndex] = entry;
  }
  return result;
}

/** `workflowRun.removed` 的归约：runId 不在场时幂等返回原状态。 */
export function applyWorkflowRunRemovedOp(
  state: WorkflowRunsState | undefined,
  op: WorkflowRunRemovedOp,
): WorkflowRunsState {
  const runs = state?.runs ?? [];
  const revision = Math.max(state?.revision ?? 0, op.revision);
  const filtered = runs.filter((run) => run.runId !== op.runId);
  if (filtered.length === runs.length) {
    return state !== undefined && state.revision === revision ? state : { revision, runs };
  }
  return { revision, runs: filtered };
}

/** `workflowRun.updated` 的归约：run 缺席且 patch 不完整时视为噪声，只推进 revision。 */
export function applyWorkflowRunUpdatedOp(
  state: WorkflowRunsState | undefined,
  op: WorkflowRunUpdatedOp,
): WorkflowRunsState {
  const runs = state?.runs ?? [];
  const revision = Math.max(state?.revision ?? 0, op.revision);
  const index = runs.findIndex((run) => run.runId === op.runId);
  if (index < 0) {
    if (!hasAllRequiredRunKeys(op.run)) {
      return state !== undefined && state.revision === revision ? state : { revision, runs };
    }
    const run = sanitizeWorkflowRun({
      ...(op.run as WorkflowRunState),
      actors: op.actors === undefined ? [] : [...op.actors],
      nodes: op.nodes === undefined ? [] : [...op.nodes],
    });
    return { revision, runs: [...runs, run] };
  }
  const before = runs[index]!;
  const merged: Record<string, unknown> = { ...before, ...op.run };
  for (const key of op.cleared ?? []) delete merged[key];
  const actors = removeIdentityEntries(before.actors, op.removedActors);
  const nodes = removeIdentityEntries(before.nodes, op.removedNodes);
  merged.actors =
    op.actors !== undefined && op.actors.length > 0
      ? upsertIdentityEntries(actors, op.actors)
      : actors;
  merged.nodes =
    op.nodes !== undefined && op.nodes.length > 0
      ? upsertIdentityEntries(nodes, op.nodes)
      : nodes;
  const nextRuns = [...runs];
  nextRuns[index] = sanitizeWorkflowRun(merged as WorkflowRunState);
  return { revision, runs: nextRuns };
}

/** 任意 workflowRun delta op 的归约入口。 */
export function applyWorkflowRunDeltaOp(
  state: WorkflowRunsState | undefined,
  op: WorkflowRunDeltaOp,
): WorkflowRunsState {
  return op.op === "workflowRun.updated"
    ? applyWorkflowRunUpdatedOp(state, op)
    : applyWorkflowRunRemovedOp(state, op);
}

// ── 旧客户端降级编码（订阅边界） ──

/**
 * 旧 wire snapshot 的 workflowRuns 裁剪：actors/nodes 触界时优先保留
 * 非 completed / 非 settled 的活动条目，其余置 `truncated: true`。
 * 支持增量的订阅拿全量（增量自带 removed 语义，不能静默裁剪）。
 */
export function trimWorkflowRunsForLegacyWire(state: WorkflowRunsState): WorkflowRunsState {
  let changed = false;
  const runs = state.runs.map((run) => {
    const actors = trimIdentityListToCap(
      run.actors,
      WORKFLOW_RUNS_LIMITS.maxActors,
      (actor) => !workflowValueEquals(actor.status, "completed"),
    );
    const nodes = trimIdentityListToCap(
      run.nodes,
      WORKFLOW_RUNS_LIMITS.maxNodes,
      (node) => !workflowValueEquals(node.phase, "settled"),
    );
    if (actors.unchanged && nodes.unchanged) return run;
    changed = true;
    return workflowRunSchema.parse({
      ...run,
      actors: actors.kept,
      nodes: nodes.kept,
      truncated: true,
    });
  });
  return changed ? { revision: state.revision, runs } : state;
}

function trimIdentityListToCap<T>(
  entries: readonly T[],
  cap: number,
  isActive: (entry: T) => boolean,
): { kept: T[]; unchanged: boolean } {
  if (entries.length <= cap) return { kept: [...entries], unchanged: true };
  const selected = new Set<number>();
  for (let index = 0; index < entries.length && selected.size < cap; index += 1) {
    if (isActive(entries[index]!)) selected.add(index);
  }
  for (let index = 0; index < entries.length && selected.size < cap; index += 1) {
    selected.add(index);
  }
  return {
    kept: entries.filter((_, index) => selected.has(index)),
    unchanged: false,
  };
}

/**
 * 订阅编码边界：不支持 workflowRunDeltas 的订阅把窗口内全部 workflowRun.* op
 * 折叠成一条（放在最后一个 delta 位次的）`state.updated`，携带当前权威 runs；
 * 中间的 per-run op 全部丢弃——旧客户端只需要终态。
 */
export function encodeConversationDeltasForLegacy(
  deltas: readonly ConversationDelta[],
  currentRuns: WorkflowRunsState | undefined,
): ConversationDelta[] {
  let lastDeltaIndex = -1;
  for (let index = deltas.length - 1; index >= 0; index -= 1) {
    if (isWorkflowRunDeltaOp(deltas[index]!)) {
      lastDeltaIndex = index;
      break;
    }
  }
  if (lastDeltaIndex < 0) return [...deltas];
  const replacement: ConversationDelta | null =
    currentRuns === undefined
      ? null
      : { op: "state.updated", patch: { workflowRuns: trimWorkflowRunsForLegacyWire(currentRuns) } };
  const result: ConversationDelta[] = [];
  for (let index = 0; index < deltas.length; index += 1) {
    const delta = deltas[index]!;
    if (!isWorkflowRunDeltaOp(delta)) {
      result.push(delta);
      continue;
    }
    if (index === lastDeltaIndex && replacement !== null) result.push(replacement);
  }
  return result;
}
