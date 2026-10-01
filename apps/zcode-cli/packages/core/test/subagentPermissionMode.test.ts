import assert from "node:assert/strict";
import test from "node:test";
import { resolveSubagentPermissionMode } from "../src/runtime/methods/subagent.js";
import { parseAgentProfileFromMarkdown } from "../src/subagent/profile.js";

// 子代理 permissionMode（6 值 canonical）→ 运行时模式映射（闭源 Txa 同款）。
// 与顶层会话的关键差异：acceptEdits→edit（自动接受编辑），而非顶层的 acceptEdits→build。
const PARENT_MODE = "build";

test("resolveSubagentPermissionMode folds canonical 6-value set", () => {
  assert.equal(resolveSubagentPermissionMode(PARENT_MODE, "bypassPermissions", false), "yolo");
  assert.equal(resolveSubagentPermissionMode(PARENT_MODE, "dontAsk", false), "yolo");
  assert.equal(resolveSubagentPermissionMode(PARENT_MODE, "acceptEdits", false), "edit");
  assert.equal(resolveSubagentPermissionMode(PARENT_MODE, "auto", false), "auto");
  assert.equal(resolveSubagentPermissionMode(PARENT_MODE, "plan", false), "plan");
});

test("resolveSubagentPermissionMode default follows the undefined path", () => {
  // default 与 undefined 同路径：内置 Explore 代理默认 yolo，其余继承父模式。
  assert.equal(resolveSubagentPermissionMode(PARENT_MODE, "default", true), "yolo");
  assert.equal(resolveSubagentPermissionMode(PARENT_MODE, undefined, true), "yolo");
  assert.equal(resolveSubagentPermissionMode(PARENT_MODE, "default", false), PARENT_MODE);
  assert.equal(resolveSubagentPermissionMode(PARENT_MODE, undefined, false), PARENT_MODE);
  // 父模式为 plan 时（getPlanEnabled 分支）default 子代理同样继承。
  assert.equal(resolveSubagentPermissionMode("plan", "default", false), "plan");
});

test("subagent frontmatter accepts the 6-value permissionMode set", () => {
  const valid = ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"];
  for (const mode of valid) {
    const { profile, diagnostic } = parseAgentProfileFromMarkdown({
      content: `---\nname: example-agent\ndescription: example\npermissionMode: ${mode}\n---\nbody`,
      source: "user",
    });
    assert.equal(diagnostic, undefined, mode);
    assert.equal(profile?.permissionMode, mode);
  }
});

test("subagent frontmatter rejects non-canonical permissionMode", () => {
  for (const invalid of ["read-only", "full-access", "build", "yolo", "autoEdit"]) {
    const { profile } = parseAgentProfileFromMarkdown({
      content: `---\nname: example-agent\ndescription: example\npermissionMode: ${invalid}\n---\nbody`,
      source: "user",
    });
    // 非法值按未声明处理（permissionMode 不落 profile），不产生解析错误。
    assert.equal(profile?.permissionMode, undefined, invalid);
  }
});

test("project-sourced subagent markdown cannot carry permissionMode", () => {
  // 项目级 subagent markdown 属于仓库输入，不能通过 frontmatter 把 child runtime
  // 提升到更高权限；permissionMode 只接受用户级或受信插件配置。
  const { profile } = parseAgentProfileFromMarkdown({
    content:
      "---\nname: example-agent\ndescription: example\npermissionMode: bypassPermissions\n---\nbody",
    source: "project",
  });
  assert.equal(profile?.permissionMode, undefined);
});
