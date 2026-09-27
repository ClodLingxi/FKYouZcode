// Web Remote Control —— host 桥：rpc-frame 收发端 + host MessagePort 的双向搬运。
// 桥身份（bridgeSessionId）由手机端 workspace-bridge-open 铸造、adopt() 采纳；
// 本模块只做字节搬运与流控透传，不感知 relay 连接/认证/配对。
import { randomUUID } from "node:crypto";
import { MessageChannelMain, type MessagePortMain } from "electron";
import { HostMessageTypes, RpcFrameReceiver, RpcFrameSender, rpcControlEnvelopeSchema, rpcFrameAckSchema, rpcFrameEnvelopeSchema } from "@zcode/shared";
import { MessagePortProtocol } from "@zcode/rpc";
import { wrapElectronPort } from "../host/electronPort.js";

/** 手机端 bridge-open 采纳的桥代际；手机端固定用 1，重连即换新 bridgeSessionId。 */
const ADOPTED_BRIDGE_GENERATION = 1;

const HOST_FLOW_TO_PHONE: Record<string, "saturated" | "drained"> = {
  saturated: "saturated",
  drained: "drained",
};

export interface WebRemoteHostBridgeOptions {
  resolveHostChild: () => { postMessage(message: unknown, transfer?: unknown[]): void } | null;
  /** 经 relay 下行（data 信封包装由调用方负责）。 */
  sendToRelay: (payload: unknown) => void;
  log: (message: string, error?: unknown) => void;
}

export class WebRemoteHostBridge {
  private sender: RpcFrameSender | null = null;
  private receiver: RpcFrameReceiver | null = null;
  private adoptedBridgeSessionId: string | null = null;
  private framePipeDisposers: Array<() => void> = [];
  private receiverWiredToPort = false;
  private hostPort: MessagePortMain | null = null;
  private hostProtocol: MessagePortProtocol | null = null;
  private portDisposers: Array<() => void> = [];
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: WebRemoteHostBridgeOptions) {}

  /** 手机端 workspace-bridge-open：采纳其铸造的桥身份，建 rpc-frame 收发端。 */
  adopt(bridgeSessionId: string): void {
    if (this.sender && this.receiver && this.adoptedBridgeSessionId === bridgeSessionId) return;
    this.teardownPipe();
    this.adoptedBridgeSessionId = bridgeSessionId;
    this.sender = new RpcFrameSender({
      bridgeSessionId,
      bridgeGeneration: ADOPTED_BRIDGE_GENERATION,
    });
    this.receiver = new RpcFrameReceiver({
      bridgeSessionId,
      bridgeGeneration: ADOPTED_BRIDGE_GENERATION,
    });
    this.framePipeDisposers.push(
      this.sender.onWire((payload) => this.options.sendToRelay(payload)),
    );
    this.framePipeDisposers.push(
      this.receiver.onWire((ack) => this.options.sendToRelay(ack)),
    );
    this.framePipeDisposers.push(
      this.sender.onFault((fault, messageSeq) =>
        this.options.log(`web-remote sender fault ${fault} messageSeq=${messageSeq}`),
      ),
    );
    this.framePipeDisposers.push(
      this.receiver.onFault((fault, detail) =>
        this.options.log(`web-remote receiver fault ${fault} ${detail}`),
      ),
    );
    // 手机端流控 → host（MessagePort sideband）。
    this.framePipeDisposers.push(
      this.receiver.onPeerFlowState((state) => this.hostProtocol?.sendFlowState(state)),
    );
    this.startSweepTimer();
    this.wireReceiverToPort();
  }

  /** 周期巡检出站宽限（replayGraceExceeded）与入站组装超时（assemblyTimeout）。
   *  无巡检时这两类超时只在下一条帧到达时才暴露，ack 丢失会让 8MB 重放缓冲
   *  静默涨满、桥假死。 */
  private startSweepTimer(): void {
    this.stopSweepTimer();
    this.sweepTimer = setInterval(() => {
      const senderFault = this.sender?.sweepGrace();
      if (senderFault) this.options.log(`web-remote sender sweep fault ${senderFault}`);
      const receiverFault = this.receiver?.sweepAssembly();
      if (receiverFault) this.options.log(`web-remote receiver sweep fault ${receiverFault}`);
    }, 5_000);
  }

  private stopSweepTimer(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** host MessagePort 桥（AttachServicePort，web-remote-replayable 可重放档）。 */
  attachIfNeeded(): void {
    if (this.hostPort && this.hostProtocol) return;
    const child = this.options.resolveHostChild();
    if (!child) {
      this.options.log("web-remote host bridge unavailable: no host process yet");
      return;
    }
    const { port1, port2 } = new MessageChannelMain();
    child.postMessage(
      {
        type: HostMessageTypes.AttachServicePort,
        requestId: randomUUID(),
        attachmentId: randomUUID(),
        clientMode: "web-remote-replayable",
        scope: { kind: "local" },
      },
      [port2],
    );
    this.hostPort = port1;
    const protocol = new MessagePortProtocol(wrapElectronPort(port1));
    this.hostProtocol = protocol;
    // host → 手机：MessagePort 原始字节进入可靠传输出站端（桥未采纳时 sender 为空，字节丢弃）。
    // Emitter event 返回 IDisposable（.dispose()），包成裸 dispose 函数再入 disposers。
    const outboundDisposer = protocol.onMessage((buffer) => {
      const result = this.sender?.send(buffer.buffer);
      if (result && !result.ok) {
        this.options.log(`web-remote outbound dropped: ${result.fault}`);
      }
    });
    this.portDisposers.push(() => outboundDisposer.dispose());
    // host 侧流控边沿 → 手机（control envelope 透传）。
    const flowDisposer = protocol.onFlowState((state) => {
      const mapped = HOST_FLOW_TO_PHONE[state];
      if (mapped) this.options.sendToRelay({ __zcodeRpcControl: "connection-flow-v1", state: mapped });
    });
    this.portDisposers.push(() => flowDisposer.dispose());
    this.wireReceiverToPort();
    port1.once("close", () => {
      this.hostPort = null;
      this.hostProtocol = null;
      this.receiverWiredToPort = false;
    });
  }

  /** relay data 信封 → rpc-frame 管线（帧 / ack / 流控）。命中返回 true。 */
  handleFramePayload(payload: unknown): boolean {
    if (rpcFrameEnvelopeSchema.safeParse(payload).success) {
      this.receiver?.feed(payload);
      return true;
    }
    if (rpcFrameAckSchema.safeParse(payload).success) {
      const ack = rpcFrameAckSchema.parse(payload);
      this.sender?.acknowledge(ack.ackMessageSeq);
      return true;
    }
    if (rpcControlEnvelopeSchema.safeParse(payload).success) {
      const control = rpcControlEnvelopeSchema.parse(payload);
      this.receiver?.applyPeerFlowState(control.state);
      return true;
    }
    return false;
  }

  teardown(): void {
    this.stopSweepTimer();
    this.teardownPipe();
    for (const dispose of this.portDisposers) dispose();
    this.portDisposers = [];
    try {
      this.hostProtocol?.disconnect();
    } catch (error) {
      this.options.log("web-remote host protocol dispose failed", error);
    }
    this.hostProtocol = null;
    try {
      this.hostPort?.close();
    } catch {
      // 已关闭
    }
    this.hostPort = null;
  }

  /** 手机 → host：重组后的字节按 MessagePort 线上格式（裸 Uint8Array）写入。 */
  private wireReceiverToPort(): void {
    const port = this.hostPort;
    const receiver = this.receiver;
    if (!port || !receiver || this.receiverWiredToPort) return;
    const receiverDisposer = receiver.onMessage(({ bytes }) => {
      // 拷出独立 ArrayBuffer：postMessage 转移/序列化不得共享 rpc-frame 底层缓冲。
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      try {
        port.postMessage(copy);
      } catch (error) {
        // host 端口已关闭（窗口销毁等）：丢帧即可，等 teardown 统一回收。
        this.options.log("web-remote postMessage to host port failed", error);
      }
    });
    this.framePipeDisposers.push(receiverDisposer);
    this.receiverWiredToPort = true;
  }

  private teardownPipe(): void {
    for (const dispose of this.framePipeDisposers) dispose();
    this.framePipeDisposers = [];
    this.sender = null;
    this.receiver = null;
    this.adoptedBridgeSessionId = null;
    this.receiverWiredToPort = false;
    this.stopSweepTimer();
  }
}
