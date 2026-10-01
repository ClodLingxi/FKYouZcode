import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePersistedTaskMode,
  normalizeZCodeAutomationPersistMode,
  zcodeTaskModeSchema,
} from "../src/zcode-task-mode-schema.js";
import { workspaceTaskListInvalidatedEventSchema } from "../src/task-realtime-core.js";

// canonical 任务模式（10 值）：闭源 zcodeTaskModeSchema 同款集合。
// 旧 6 值是子集，存量数据必须直通；新增 4 值（default/acceptEdits/dontAsk/bypassPermissions）
// 是 provider 档位 canonical id（导入/迁移/自动化入口），schema 拒绝集合外任意串。
const CANONICAL_MODES = [
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
] as const;

test("zcodeTaskModeSchema accepts all 10 canonical modes", () => {
  for (const mode of CANONICAL_MODES) {
    assert.equal(zcodeTaskModeSchema.safeParse(mode).success, true, mode);
  }
});

test("zcodeTaskModeSchema rejects non-canonical values", () => {
  for (const invalid of ["read-only", "full-access", "agent", "full-auto", "", "yoloo", null]) {
    assert.equal(zcodeTaskModeSchema.safeParse(invalid).success, false, String(invalid));
  }
});

test("realtime task meta mode accepts canonical 10 values", () => {
  // workspace_task_list_invalidated 事件内嵌 taskMeta（含 mode），是手机 replayable
  // 校验的外部入口；canonical 档位必须全部放行，否则导入/迁移任务会拒收。
  const baseEvent = {
    eventId: "event-1",
    workspacePath: "/tmp/example",
    workspaceKey: "/tmp/example",
    traceId: "trace-1",
    createdAt: 0,
    type: "workspace_task_list_invalidated",
    reason: "task_meta_changed",
  };
  const baseMeta = {
    taskId: "task-1",
    traceId: "trace-1",
    title: "t",
    workspacePath: "/tmp/example",
    createdAt: 0,
    updatedAt: 0,
    mode: "build",
  };
  for (const mode of CANONICAL_MODES) {
    const parsed = workspaceTaskListInvalidatedEventSchema.safeParse({
      ...baseEvent,
      taskMeta: { ...baseMeta, mode },
    });
    assert.equal(parsed.success, true, mode);
  }
  assert.equal(
    workspaceTaskListInvalidatedEventSchema.safeParse({
      ...baseEvent,
      taskMeta: { ...baseMeta, mode: "read-only" },
    }).success,
    false,
  );
});

test("normalizePersistedTaskMode passes canonical values through", () => {
  for (const mode of CANONICAL_MODES) {
    assert.equal(normalizePersistedTaskMode(mode), mode);
  }
});

test("normalizePersistedTaskMode folds provider tier aliases", () => {
  // 别名集合依据闭源 normalizePersistedSessionMode（canonical 直通先于别名分支）：
  // read-only→plan；auto-edit/auto_edit/accept-edits/accept_edits→acceptEdits；
  // full-auto→yolo；full-access/agent-full-access→bypassPermissions。
  // 注意 "autoEdit" 本身是 canonical 值，走直通而非别名分支（闭源同名 case 不可达）。
  assert.equal(normalizePersistedTaskMode("read-only"), "plan");
  assert.equal(normalizePersistedTaskMode("read_only"), "plan");
  assert.equal(normalizePersistedTaskMode("auto-edit"), "acceptEdits");
  assert.equal(normalizePersistedTaskMode("auto_edit"), "acceptEdits");
  assert.equal(normalizePersistedTaskMode("autoEdit"), "autoEdit");
  assert.equal(normalizePersistedTaskMode("accept-edits"), "acceptEdits");
  assert.equal(normalizePersistedTaskMode("accept_edits"), "acceptEdits");
  assert.equal(normalizePersistedTaskMode("full-auto"), "yolo");
  assert.equal(normalizePersistedTaskMode("full_auto"), "yolo");
  assert.equal(normalizePersistedTaskMode("full-access"), "bypassPermissions");
  assert.equal(normalizePersistedTaskMode("full_access"), "bypassPermissions");
  assert.equal(normalizePersistedTaskMode("agent-full-access"), "bypassPermissions");
  assert.equal(normalizePersistedTaskMode("agent_full_access"), "bypassPermissions");
});

test("normalizePersistedTaskMode returns undefined for unknown / empty / nullish", () => {
  // "agent" 在闭源仅 codex provider 归一为 default；本仓库 glm 单后端按未知处理。
  assert.equal(normalizePersistedTaskMode("agent"), undefined);
  assert.equal(normalizePersistedTaskMode("unknown-mode"), undefined);
  assert.equal(normalizePersistedTaskMode(""), undefined);
  assert.equal(normalizePersistedTaskMode("   "), undefined);
  assert.equal(normalizePersistedTaskMode(null), undefined);
  assert.equal(normalizePersistedTaskMode(undefined), undefined);
});

test("normalizePersistedTaskMode trims surrounding whitespace", () => {
  assert.equal(normalizePersistedTaskMode("  yolo  "), "yolo");
  assert.equal(normalizePersistedTaskMode(" full-access "), "bypassPermissions");
});

test("normalizeZCodeAutomationPersistMode compresses canonical to 4 tiers", () => {
  // uYa 归一化：dontAsk|bypassPermissions→yolo；default|auto|acceptEdits|autoEdit→build。
  assert.equal(normalizeZCodeAutomationPersistMode("plan"), "plan");
  assert.equal(normalizeZCodeAutomationPersistMode("edit"), "edit");
  assert.equal(normalizeZCodeAutomationPersistMode("yolo"), "yolo");
  assert.equal(normalizeZCodeAutomationPersistMode("build"), "build");
  assert.equal(normalizeZCodeAutomationPersistMode("dontAsk"), "yolo");
  assert.equal(normalizeZCodeAutomationPersistMode("bypassPermissions"), "yolo");
  assert.equal(normalizeZCodeAutomationPersistMode("default"), "build");
  assert.equal(normalizeZCodeAutomationPersistMode("auto"), "build");
  assert.equal(normalizeZCodeAutomationPersistMode("acceptEdits"), "build");
  assert.equal(normalizeZCodeAutomationPersistMode("autoEdit"), "build");
});

test("normalizeZCodeAutomationPersistMode keeps unset semantics", () => {
  assert.equal(normalizeZCodeAutomationPersistMode(undefined), undefined);
  assert.equal(normalizeZCodeAutomationPersistMode(null), undefined);
});
