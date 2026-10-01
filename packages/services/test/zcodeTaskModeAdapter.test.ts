import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { toZCodeMode } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";
import { AutomationRepo } from "../src/session/automationRepo.js";
import type { ZCodeTaskMode } from "@zcode/shared";

// host 适配层 canonical → 运行时坍缩矩阵（闭源 toZCodeMode 同款）。
// 运行时判定层不扩容：新增 4 个 canonical 档全部坍缩进 yolo/build。
test("toZCodeMode maps canonical 10 modes onto runtime 5 modes", () => {
  assert.equal(toZCodeMode("plan"), "plan");
  assert.equal(toZCodeMode("edit"), "edit");
  assert.equal(toZCodeMode("yolo"), "yolo");
  // Claude 风格全自动 canonical id 在 glm 运行时等价原生 yolo。
  assert.equal(toZCodeMode("bypassPermissions"), "yolo");
  assert.equal(toZCodeMode("dontAsk"), "yolo");
  assert.equal(toZCodeMode("auto"), "auto");
  // provider 档位 id 在顶层会话安全降级到 build（glm 不提供这些档位）。
  assert.equal(toZCodeMode("build"), "build");
  assert.equal(toZCodeMode("default"), "build");
  assert.equal(toZCodeMode("acceptEdits"), "build");
  assert.equal(toZCodeMode("autoEdit"), "build");
});

test("toZCodeMode returns undefined for unset or unknown values", () => {
  // 调用点统一以 ?? "build" 兜底；映射层不猜档位。
  assert.equal(toZCodeMode(undefined), undefined);
  // setConfigOption 等入口经 as ZCodeTaskMode 透传运行时串，未知值必须落 undefined。
  assert.equal(toZCodeMode("read-only" as ZCodeTaskMode), undefined);
  assert.equal(toZCodeMode("full-access" as ZCodeTaskMode), undefined);
});

test("automation repo persists canonical modes compressed to 4 tiers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-automation-mode-"));
  const repo = new AutomationRepo(join(dir, "tasks-index.sqlite"));
  try {
    const created = await repo.create(
      {
        title: "canonical mode example",
        cronExpr: "*/20 * * * *",
        prompt: "example prompt",
        // canonical dontAsk 接受，落库压成 yolo。
        mode: "dontAsk",
        workspacePath: dir,
        recurring: true,
      },
      { nextRunAt: Date.now() },
    );
    assert.equal(created.mode, "yolo");

    const updated = await repo.update(
      created.automationId,
      {
        // canonical default 接受，落库压成 build。
        mode: "default",
        title: "canonical mode example",
      },
      { nextRunAt: Date.now() },
    );
    assert.equal(updated?.mode, "build");

    // null 显式清空（回落 workspace 默认），不是归一化输入。
    const cleared = await repo.update(
      created.automationId,
      { mode: null, title: "canonical mode example" },
      { nextRunAt: Date.now() },
    );
    assert.equal(cleared?.mode, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("automation repo still persists native 4 tiers unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-automation-native-"));
  const repo = new AutomationRepo(join(dir, "tasks-index.sqlite"));
  try {
    for (const mode of ["build", "edit", "plan", "yolo"] as const) {
      const created = await repo.create(
        {
          title: `native ${mode}`,
          cronExpr: "0 * * * *",
          prompt: "example prompt",
          mode,
          workspacePath: dir,
          recurring: true,
        },
        { nextRunAt: Date.now() },
      );
      assert.equal(created.mode, mode);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
