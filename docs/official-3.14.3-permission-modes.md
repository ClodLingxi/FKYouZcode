# 权限模式扩展（canonical 任务模式三层结构）规格

> 移植自官方闭源 3.14.3 逆向规格（`/tmp/spec-permission-modes.md`）。
> 逆向数据源只读：`/opt/ZCode/resources/glm/zcode.cjs`、桌面 bundle 3143。

## 0. 三层结构（不变式）

权限模式是三层结构，**运行时判定层不扩容**：

1. **运行时判定层（zcode-cli PermissionService）不变**：`executionPermissionModeSchema`
   仍是 `build / edit / yolo / auto(reserved)`，`switchCollaborationMode` 命令面仍是
   `["build","edit","plan","yolo"]`。`permission/service.ts` 与闭源逐分支等价，禁止改动。
2. **canonical 任务模式层（本仓库 `@zcode/shared`）**：任务元数据 / automation / off-peak /
   导入迁移共用 10 值枚举 `ZCodeTaskMode`，服务多后端（claude/codex/gemini/opencode/glm）
   的持久化与迁移语义。
3. **host 适配层（services adapter `toZCodeMode`）**：canonical 在进入运行时会话前坍缩成
   5 值 `ZCodeSessionMode`；未知值由调用点兜底 `?? "build"`。

## 1. 状态所有者与接口

| 状态                                      | 唯一所有者                                                                                                                        | 接口                                                         |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| canonical 10 值枚举与校验                 | `packages/shared/src/zcode-task-mode-schema.ts`（`zcodeTaskModeSchema`）                                                          | zod enum；类型 `ZCodeTaskMode`（`zcode-task-types-core.ts`） |
| 持久化别名归一化（导入/迁移边界）         | `packages/shared/src/zcode-task-mode-schema.ts`（`normalizePersistedTaskMode`）                                                   | 纯函数：原始串 → canonical 或 undefined                      |
| automation 持久化归一化（uYa 等价）       | `packages/shared/src/zcode-task-mode-schema.ts`（`normalizeZCodeAutomationPersistMode`）；写边界在 `automationRepo.create/update` | 纯函数：canonical → 4 值                                     |
| canonical → 运行时坍缩                    | `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`（`toZCodeMode`）                                                   | canonical → `ZCodeSessionMode`                               |
| 子代理 frontmatter permissionMode（6 值） | `apps/zcode-cli/packages/core/src/subagent/profile.ts`（`AgentPermissionMode`）                                                   | frontmatter 解析 + `resolveSubagentPermissionMode` 映射      |
| glm UI 模式选择器数据（4 档）             | `packages/shared/src/zcode-agent-model-state.ts`（`ZCODE_AGENT_MODE_OPTIONS`）                                                    | build/edit/plan/yolo + name/description（闭源 zKt 同值）     |

## 2. canonical → 运行时映射（`toZCodeMode`）

| canonical                                | 运行时 | 依据（闭源 host Ou @450229）          |
| ---------------------------------------- | ------ | ------------------------------------- |
| plan                                     | plan   | 直通                                  |
| edit                                     | edit   | 直通                                  |
| yolo                                     | yolo   | 直通                                  |
| bypassPermissions / dontAsk              | yolo   | Claude 风格全自动坍缩到 glm 原生 yolo |
| auto                                     | auto   | 保留位（运行时 deny 一切）            |
| build / default / acceptEdits / autoEdit | build  | glm 顶层会话不提供这些档位，安全降级  |

`fromZCodeMode` 恒等（运行时 5 值都在 canonical 集内）。

**子代理差异**（`resolveSubagentPermissionMode`，闭源 Txa @12917368）：
`acceptEdits → edit`（自动接受编辑，与顶层 acceptEdits→build 不同）；
`bypassPermissions|dontAsk → yolo`；`auto → auto`；`plan → plan`；
`default|undefined → (builtInExplore ? yolo : 父模式)`。
frontmatter 合法集（6 值）：`{acceptEdits, auto, bypassPermissions, default, dontAsk, plan}`。
项目级 subagent markdown 仍不允许携带 permissionMode（仓库输入不可信，维持现有安全边界）。

## 3. 别名归一化（`normalizePersistedTaskMode`）

canonical 直通（含 `autoEdit`——它本身是 canonical 值，闭源别名分支中的同名 case 不可达）；
别名（闭源 A$ @618400）：
`read-only|read_only → plan`；`auto-edit|auto_edit|accept-edits|accept_edits → acceptEdits`；
`full-auto|full_auto → yolo`；`full-access|full_access|agent-full-access|agent_full_access → bypassPermissions`；
`agent → default` 仅 codex provider（本仓库 glm 单后端，返回 undefined）。
未知值 → undefined（调用方按未设置处理，不猜档位）。

## 4. automation 归一化（`normalizeZCodeAutomationPersistMode`，闭源 uYa @14452256）

创建/更新接受 canonical 10 值，落库前压成 4 值：
`dontAsk|bypassPermissions → yolo`；`default|auto|acceptEdits|autoEdit → build`；
`plan|edit|yolo|build` 直通；undefined 保持未设置。
写边界唯一：`automationRepo.create/update`（Repo 是绕过 RPC 时的最终持久化边界）。

## 5. 交付面（不变的呈现）

- glm 模式选择器仅 4 档（build/edit/plan/yolo），非法/保留值回落 build
  （`normalizeAvailableZCodeMode`）。
- automation/off-peak 表单维持 4 值选项；off-peak 离开 yolo 的一次性 fullAccessHint toast 已存在。
- 权限弹窗建议项重映射（"full access"→`chat.permission.fullAccess`、glm
  "always allow in this project"→`chat.permission.allowForProject`）已在 `PermissionDialog.tsx` 存在。
- i18n：子代理 permissionMode 6 档标签、`mode.label/description.glm.default`。

## 6. 验收场景

1. canonical 10 值全部通过 `zcodeTaskModeSchema`；旧 6 值数据直通；非法值拒绝。
2. `toZCodeMode`：10 值 → 5 值坍缩矩阵逐值断言；未知 → undefined（调用点 ?? build）。
3. 子代理：6 值 frontmatter 解析合法；`acceptEdits → edit`；`bypassPermissions|dontAsk → yolo`；
   `default` 与 undefined 同路径（Explore → yolo，其余继承父模式）；项目级 markdown 携带 permissionMode 被丢弃。
4. 别名：`read-only→plan`、`full-access→bypassPermissions` 等；未知 → undefined。
5. automation：`create/update` 落库值域恒为 4 值（dontAsk→yolo、default→build 等）。
6. realtime task meta `mode` 接受 canonical 10 值（手机 replayable 校验不拒收新档位）。
