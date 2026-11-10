// [OmniCode] M4c Browser Relay：实现已迁入 @zcode/services（src/zcode-agent/browserRelayServerChannel.ts）。
// 迁移原因：远端 workspace 的 server 有两个形态——stdio bundle（本包 entry-stdio/entry-http）
// 与 zcode-server-cli 的 Source Server Core；依赖边界禁止 zcode-server-cli 反向依赖
// @zcode/server，两个形态必须共享同一频道事实源，故实现落 services、本文件保留 re-export
// 以稳住既有 server 侧导入与 architecture-policy 的既有登记路径。
export {
  createBrowserRelayAgentExecutor,
  createOmniCodeBrowserRelayChannel,
  type OmniCodeBrowserRelayServerChannel,
} from "@zcode/services";
