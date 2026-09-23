// 仓库源码直连：客户端只依赖同构模块（无 node:* 依赖），esbuild 构建期内联。
// shared 的浏览器入口见 packages/shared/src/web-remote-control/browser.ts。
export * from "../../../packages/shared/src/web-remote-control/browser.js";
export * from "../../../packages/shared/src/zcode-protocol-v4/index.js";
export {
  ChannelClient,
  VSBuffer,
  Emitter,
  Event,
  type IMessagePassingProtocol,
  type MessagePortFlowState,
} from "../../../packages/rpc/src/index.js";
