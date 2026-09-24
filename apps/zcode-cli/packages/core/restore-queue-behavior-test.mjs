// 崩溃恢复队列行为测试（bugfix：闪退后排队消息全部消失）。
// 旧行为：resume 时把账本 admitted 残留清扫为 discarded(session_resumed)。
// 新行为：按 FIFO 重放 TurnSteerQueued 恢复队列；仅 backgroundNotification/未知
// kind 维持清扫。直接驱动 restorePersistedPendingSteerInputs，以 stub 运行时
// 上下文捕获事件与账本调用（无需 boot 完整 AgentRuntime）。
// 运行：`node_modules/.bin/tsx restore-queue-behavior-test.mjs`（根仓库 node_modules 有 tsx；
// workspace 包 @zcode/contracts 直接导出 .ts 源，纯 node 跑不了，tsx 直接解析）。
import assert from "node:assert/strict";
import { restorePersistedPendingSteerInputs } from "./src/runtime/methods/steering.js";

const TRACE = { traceId: "trace_test", queryId: "q_test" };

function makeRuntime(admittedRows, options = {}) {
  const events = [];
  const settled = [];
  const runtime = {
    sessionId: "sess_test",
    latestAssistantTurnId: options.latestAssistantTurnId,
    logger: { info() {}, warn() {}, debug() {} },
    sessionStore: {
      async listSessionInputs() {
        return admittedRows;
      },
      async settleSessionInput(input) {
        settled.push(input);
      },
    },
    async appendEvent(event) {
      if (options.failEventId && event.payload?.pendingInputId === options.failEventId) {
        throw new Error("append failed (simulated)");
      }
      events.push(event);
    },
  };
  return { runtime, events, settled };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

const row = (over = {}) => ({
  id: "queue_cmd_1",
  sessionID: "sess_test",
  kind: "sendText",
  delivery: "queue",
  payload: { text: "hello" },
  admittedSequence: 0,
  status: "admitted",
  time: { created: 1, updated: 1 },
  ...over,
});

// 1. 普通文本（无 intent）恢复为 TurnSteerQueued，账本不被收口。
{
  const { runtime, events, settled } = makeRuntime([row()]);
  const n = await restorePersistedPendingSteerInputs.call(runtime, TRACE);
  check("文本行恢复且计数=1", () => assert.equal(n, 1));
  check("发出 TurnSteerQueued 事件", () => {
    assert.equal(events.length, 1);
    const p = events[0].payload;
    assert.equal(events[0].type, "turn_steer_queued");
    assert.equal(p.pendingInputId, "queue_cmd_1");
    assert.equal(p.input, "hello");
    assert.equal(p.delivery, "queue");
    assert.equal(p.queueLength, 1);
  });
  check("文本行不写终态（保持 admitted 待 promotion）", () => assert.equal(settled.length, 0));
}

// 2. compact 行带 intent（startNow 残留）：kind 保留、投递归一为 queue、queuePosition 兜底。
{
  const intent = {
    sourceCommandId: "cmd_c1",
    queueItemId: "queue_cmd_c1",
    clientId: "cli",
    kind: "compact",
    admissionSeq: 3,
    admittedAt: 111,
    requestedDelivery: "startNow",
    admittedDelivery: "startNow",
  };
  const { runtime, events } = makeRuntime([
    row({ id: "queue_cmd_c1", kind: "compact", delivery: "startNow", payload: { text: "/compact", intent } }),
  ]);
  await restorePersistedPendingSteerInputs.call(runtime, TRACE);
  const p = events[0].payload;
  check("compact 行恢复 commandKind=compact", () => assert.equal(p.commandKind, "compact"));
  check("startNow 残留投递归一为 queue", () => {
    assert.equal(p.delivery, "queue");
    assert.equal(p.intent.admittedDelivery, "queue");
    assert.equal(p.intent.requestedDelivery, "queue");
    assert.equal(p.intent.kind, "compact");
  });
  check("缺 queuePosition 时按恢复序兜底", () => assert.equal(p.intent.queuePosition, 0));
}

// 3. backgroundNotification 行清扫为 discarded(session_resumed)，不产生事件。
{
  const { runtime, events, settled } = makeRuntime([
    row({ id: "cmd_bg1", kind: "backgroundNotification", payload: { text: "wake" } }),
  ]);
  const n = await restorePersistedPendingSteerInputs.call(runtime, TRACE);
  check("后台通知不计入恢复数", () => assert.equal(n, 0));
  check("后台通知清扫为 discarded/session_resumed", () => {
    assert.deepEqual(settled, [
      { id: "cmd_bg1", sessionID: "sess_test", status: "discarded", reason: "session_resumed" },
    ]);
  });
  check("后台通知不重放队列事件", () => assert.equal(events.length, 0));
}

// 4. guide 行保留 guide 投递；FIFO 顺序与 queueLength 递增保持。
{
  const { runtime, events } = makeRuntime([
    row({ id: "q_a", admittedSequence: 0 }),
    row({ id: "q_b", delivery: "guide", admittedSequence: 1 }),
    row({ id: "q_c", admittedSequence: 2 }),
  ]);
  const n = await restorePersistedPendingSteerInputs.call(runtime, TRACE);
  check("三行全部恢复", () => assert.equal(n, 3));
  check("FIFO 顺序与 queueLength 递增", () => {
    assert.deepEqual(
      events.map((e) => [e.payload.pendingInputId, e.payload.queueLength]),
      [
        ["q_a", 1],
        ["q_b", 2],
        ["q_c", 3],
      ],
    );
  });
  check("guide 投递保留", () => assert.equal(events[1].payload.delivery, "guide"));
}

// 5. 未知 kind 清扫；单条恢复失败不拖垮其余行（失败行保持 admitted 可诊断）。
{
  const { runtime, events, settled } = makeRuntime(
    [
      row({ id: "q_fail", admittedSequence: 0 }),
      row({ id: "q_ok", admittedSequence: 1, payload: { text: "still here" } }),
      row({ id: "q_bad", kind: "mysteryKind", admittedSequence: 2 }),
    ],
    { failEventId: "q_fail" },
  );
  const n = await restorePersistedPendingSteerInputs.call(runtime, TRACE);
  check("失败行不计入、其余恢复", () => assert.equal(n, 1));
  check("只有未知 kind 行被收口，失败行留痕 admitted", () =>
    assert.deepEqual(
      settled.map((s) => s.id),
      ["q_bad"],
    ));
  check("成功恢复的行原文完整", () => {
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.input, "still here");
  });
}

// 6. 坏 intent 形状退化为纯文本恢复（不注入坏形状）。
{
  const { runtime, events } = makeRuntime([
    row({ payload: { text: "x", intent: { kind: "compact" } } }),
  ]);
  const n = await restorePersistedPendingSteerInputs.call(runtime, TRACE);
  check("坏 intent 仍按文本恢复", () => assert.equal(n, 1));
  check("坏 intent 不进事件，kind 用账本行兜底", () => {
    assert.equal(events[0].payload.intent, undefined);
    assert.equal(events[0].payload.commandKind, "sendText");
  });
}

// 7. targetTurnId：优先 latestAssistantTurnId，缺省回退 trace/deferred。
{
  const { runtime, events } = makeRuntime([row()], { latestAssistantTurnId: "turn_9" });
  await restorePersistedPendingSteerInputs.call(runtime, TRACE);
  check("targetTurnId 用最近的 assistant turn", () =>
    assert.equal(events[0].payload.targetTurnId, "turn_9"));
}

console.log(`\n${passed} checks passed`);
