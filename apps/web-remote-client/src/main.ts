// 手机 Web 客户端入口：配对 → 控制面（bootstrap/bridge-open）→ v4 会话订阅与交互。
import { parsePairingQrUrl, type ConversationSnapshot, type ConversationTopicFrame } from "./deps.js";
import {
  AgentClient,
  ConversationProjection,
  createCommandEnvelope,
  type SessionInfoLike,
  type WorkspaceTarget,
} from "./agent.js";
import { RelaySession } from "./connection.js";
import { uuidv7 } from "./proto.js";
import { ChannelClient } from "./deps.js";

// ── 极简 DOM 辅助 ──

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) node.append(child);
  return node;
}

const app = document.getElementById("app")!;

function render(message: string): void {
  app.replaceChildren(
    el("div", { class: "center" }, [el("div", { class: "status" }, [message])]),
  );
}

function showError(message: string): void {
  app.replaceChildren(
    el("div", { class: "center" }, [el("div", { class: "error" }, [message])]),
  );
}

// ── 启动 ──

interface Pairing {
  sid: string;
  hash: string;
  name: string;
}

function resolvePairing(): Pairing | null {
  // 优先 URL query（扫官方 QR 直接落到本页）；其次手输粘贴。
  const fromLocation = parsePairingQrUrl(window.location.href);
  if (fromLocation) {
    return { sid: fromLocation.sid, hash: fromLocation.hash, name: fromLocation.name };
  }
  const stored = sessionStorage.getItem("zcode-remote-pairing");
  if (stored) {
    try {
      return JSON.parse(stored) as Pairing;
    } catch {
      return null;
    }
  }
  return null;
}

function manualPairingScreen(): void {
  app.replaceChildren(
    el("div", { class: "pair" }, [
      el("h1", {}, ["ZCode 远控"]),
      el("p", { class: "hint" }, ["扫描桌面端二维码自动配对；或把二维码链接粘贴到下面："]),
      el("textarea", { id: "qr", rows: "3", placeholder: "https://…/?sid=…&hash=…&t=…" }),
      el("button", { id: "go" }, ["连接"]),
    ]),
  );
  (document.getElementById("go") as HTMLButtonElement).addEventListener("click", () => {
    const raw = (document.getElementById("qr") as HTMLTextAreaElement).value.trim();
    const parsed = parsePairingQrUrl(raw);
    if (!parsed) {
      alert("二维码链接格式不正确");
      return;
    }
    sessionStorage.setItem(
      "zcode-remote-pairing",
      JSON.stringify({ sid: parsed.sid, hash: parsed.hash, name: parsed.name }),
    );
    // 把 QR 参数提升为本页 query，后续 reload 直接复用。
    const url = new URL(window.location.href);
    for (const key of ["sid", "hash", "t", "mid", "name", "app_version"]) {
      const value = new URL(raw).searchParams.get(key);
      if (value) url.searchParams.set(key, value);
    }
    history.replaceState(null, "", url.toString());
    boot();
  });
}

async function boot(): Promise<void> {
  const pairing = resolvePairing();
  if (!pairing) {
    manualPairingScreen();
    return;
  }
  render("连接 relay…");
  // relay 常经 nginx 路径前缀发布（https://host/<base>/）：页面资源是相对引用，
  // WS 也要落在同一段前缀下（反代剥前缀后 relay 收到的仍是 /ws）。根路径部署时 base 为 "/"。
  const basePath = window.location.pathname.replace(/[^/]*$/, "");
  const wsUrl = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}${basePath}ws`;
  const relay = new RelaySession(
    wsUrl,
    { deviceSid: pairing.sid, passHash: pairing.hash, deviceName: pairing.name },
    uuidv7(),
  );
  try {
    await relay.connect();
  } catch (error) {
    showError(`relay 连接失败：${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  // 启动链路（bootstrap → 建桥 → 握手 → 会话列表）任一环失败都要给用户可见的错误，
  // 不能静默挂死在状态页。
  try {
    render("获取桌面 workspace…");
    const requestId = uuidv7();
    const bootstrap = await relay.controlRequest({
      type: "bootstrap-request",
      request_id: requestId,
    });
    const workspaces = bootstrap.type === "bootstrap-response" ? bootstrap.workspaces : undefined;
    if (!bootstrap.success || !workspaces?.length) {
      showError(`桌面端没有已打开的 workspace：${bootstrap.error ?? "empty"}`);
      return;
    }
    const workspace: WorkspaceTarget = {
      workspacePath: workspaces[0]!.workspace_path,
      ...(workspaces[0]!.workspace_identity
        ? { workspaceIdentity: workspaces[0]!.workspace_identity }
        : {}),
    };
    const workspaceKey = workspace.workspaceIdentity?.trim() || workspace.workspacePath;

    render("打开 RPC 桥…");
    const bridge = await relay.controlRequest({
      type: "workspace-bridge-open",
      request_id: uuidv7(),
      workspace_key: workspaceKey,
      bridge_session_id: `bridge-${uuidv7()}`,
    });
    const bridgeReady = bridge.type === "workspace-bridge-ready";
    if (!bridgeReady || !bridge.success) {
      showError(`建桥失败：${bridge.error ?? ("reason" in bridge ? bridge.reason : undefined) ?? "unknown"}`);
      return;
    }

    // ChannelClient 直接骑在 relay 管线上；Initialize 由 host ChannelServer 主动下发。
    const client = new ChannelClient(relay.protocol);
    const agent = new AgentClient(client);
    await agent.ensureHandshake();

    const sessions = await agent.listSessions({ ...workspace, limit: 50 });
    const latest = pickLatestSession(sessions);
    if (!latest) {
      showError("该 workspace 还没有会话；请在桌面端打开一个会话后再刷新本页。");
      return;
    }
    await enterChat(agent, workspace, latest.sessionId, latest.title);
  } catch (error) {
    showError(`桌面端连接失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function pickLatestSession(sessions: SessionInfoLike[]): SessionInfoLike | null {
  const active = sessions.filter((session) => session.status !== "archived");
  active.sort((a, b) => b.updatedAt - a.updatedAt);
  return active[0] ?? null;
}

async function enterChat(
  agent: AgentClient,
  workspace: WorkspaceTarget,
  sessionId: string,
  sessionTitle: string,
): Promise<void> {
  render("订阅会话…");
  const projection = new ConversationProjection();
  const frames: ConversationTopicFrame[] = [];

  const unsubscribeFrames = agent.onConversationFrame(workspace, (frame) => {
    if (frame.topic !== `conversation/${sessionId}`) return;
    if (projection.subscriptionId && frame.subscriptionId !== projection.subscriptionId) return;
    frames.push(frame);
    projection.accept(frame);
    scheduleRender();
  });

  try {
    const subscribeResult = await agent.subscribe({
      ...workspace,
      sessionId,
      visibility: "foreground",
    });
    projection.subscriptionId = subscribeResult.ack.subscriptionId;
  } catch (error) {
    // 订阅失败时退订页面级帧监听，boot 的统一错误页会接手。
    unsubscribeFrames();
    throw error;
  }

  // ── 聊天 UI ──

  let renderQueued = false;
  function scheduleRender(): void {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderRows();
    });
  }

  const header = el("header", { class: "chat-header" }, [
    el("strong", {}, [sessionTitle || "会话"]),
    el("span", { class: "hint" }, [workspace.workspacePath.split("/").pop() ?? ""]),
  ]);

  const list = el("div", { class: "rows" });
  const queueBar = el("div", { class: "queue" });
  const input = el("textarea", { rows: "2", placeholder: "发消息（busy 时自动入队）…" });
  const send = el("button", { class: "primary" }, ["发送"]);
  const compactButton = el("button", {}, ["压缩"]);
  const newChat = el("button", {}, ["新会话"]);

  async function submit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const envelope = createCommandEnvelope(sessionId, "sendText", { text: trimmed });
    try {
      await agent.sendCommand({ ...workspace, envelope });
      input.value = "";
    } catch (error) {
      alert(`发送失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  send.addEventListener("click", () => void submit(input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit(input.value);
    }
  });
  compactButton.addEventListener("click", () => {
    void agent
      .sendCommand({ ...workspace, envelope: createCommandEnvelope(sessionId, "compact", {}) })
      .catch((error) => alert(`压缩请求失败：${String(error)}`));
  });
  newChat.addEventListener("click", () => {
    void agent
      .createSession({ ...workspace })
      .then((created) => {
        window.location.reload();
        void created;
      })
      .catch((error) => alert(`新会话失败：${String(error)}`));
  });

  const composer = el("footer", { class: "composer" }, [
    queueBar,
    el("div", { class: "input-row" }, [input, send]),
    el("div", { class: "actions" }, [compactButton, newChat]),
  ]);

  app.replaceChildren(el("div", { class: "chat" }, [header, list, composer]));

  function renderRows(): void {
    const snapshot = projection.snapshot;
    header.replaceChildren(
      el("strong", {}, [sessionTitle || "会话"]),
      el("span", { class: "hint" }, [
        workspace.workspacePath.split("/").pop() ?? "",
        statusSuffix(snapshot),
      ]),
    );
    renderQueue(snapshot);
    list.replaceChildren(...rowsToNodes(snapshot));
    list.scrollTop = list.scrollHeight;
  }

  function statusSuffix(snapshot: ConversationSnapshot | null): string {
    if (!snapshot) return "";
    const compacting = snapshot.control.activeWorks.some((work) => work.kind === "compact");
    if (compacting) return " · 压缩中";
    if (snapshot.control.activeWorks.length > 0) return " · 运行中";
    return "";
  }

  function renderQueue(snapshot: ConversationSnapshot | null): void {
    const items = snapshot?.queue.items ?? [];
    queueBar.replaceChildren();
    if (items.length === 0) return;
    queueBar.append(el("span", { class: "hint" }, [`队列 ${items.length}`]));
    for (const item of items) {
      const node = el("span", { class: "queue-item", title: item.text }, [
        item.kind === "compact" ? "/compact" : item.text.slice(0, 40),
      ]);
      const remove = el("button", { class: "mini" }, ["×"]);
      remove.addEventListener("click", () => {
        void agent
          .sendCommand({
            ...workspace,
            envelope: createCommandEnvelope(sessionId, "deleteQueueItem", {
              queueItemId: item.queueItemId,
            }, { baseRevision: snapshot?.revision }),
          })
          .catch((error) => alert(`删除队列项失败：${String(error)}`));
      });
      node.append(remove);
      queueBar.append(node);
    }
  }

  function rowsToNodes(snapshot: ConversationSnapshot | null): Array<Node | string> {
    if (!snapshot) return [el("div", { class: "hint center" }, ["等待快照…"])];
    const nodes: Array<Node | string> = [];
    for (const row of snapshot.rows.window) {
      switch (row.kind) {
        case "userInput":
          nodes.push(el("div", { class: "row user" }, [row.text]));
          break;
        case "assistantText":
          nodes.push(el("div", { class: `row assistant ${row.state}` }, [row.text]));
          break;
        case "reasoning":
          nodes.push(el("details", { class: `row reasoning ${row.state}` }, [
            el("summary", {}, ["思考"]),
            el("div", {}, [row.text]),
          ]));
          break;
        case "toolCall": {
          const title = `${row.toolName} · ${row.status}`;
          nodes.push(el("details", { class: `row tool ${row.status}` }, [
            el("summary", {}, [title]),
            el("pre", {}, [row.inputText || "(no input)"]),
            row.output?.text ? el("pre", {}, [row.output.text]) : "",
          ]));
          break;
        }
        case "subagent":
          nodes.push(el("div", { class: `row subagent ${row.status}` }, [
            `${row.subagentType} · ${row.summaryText || "…"}`,
          ]));
          break;
        default:
          break;
      }
    }
    return nodes;
  }

  renderRows();
}

void boot();
