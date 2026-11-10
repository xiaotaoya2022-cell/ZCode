import type {
  BrowserBackendDescriptor,
  BrowserClientMode,
  BrowserCommand,
  BrowserCommandResult,
} from "./browser-use/index.js";

// [OmniCode] M4b/M4c Browser Relay（fork-only 事件契约）。
// 设计依据：《ZCode 原生魔改版架构与实现方案报告》§5.1 与
// ZakiCode docs/specs/remote-server-event-compat.md。
//
// 机制：远程 workspace（SSH/VM/Docker/Source Server）里的 Agent 执行浏览器命令时找不到浏览器
// 后端（远端 server 的 zcodeAgentService 无本地 browserControlExecutor），M4c 起由
// zcodeAgentService 的 relay 降级路由把请求经 server 侧 `fireRelayRequest` 通过
// `onDynamicBrowserRelayRequest` 事件路由回桌面端可见的浏览器 pane 执行（复用 host→main 的
// BrowserExecuteRequest 桥，30s 预算语义照旧），结果经同频道 browserRelayRespond 命令回传。
// 本地 workspace 的 browserControlExecutor 直连路径完全不参与 relay，行为零变化。
//
// 形状沿用现有类型：execute 载荷与 desktop/src/host/browserControlMainBridge.ts 的
// BrowserControlMainBridge.execute 入参逐字段一致（结构化赋值可编译校验，漂移即编译失败）；
// list/execute 结果分别为 BrowserBackendDescriptor[] 与 BrowserCommandResult，不发明新形状。
//
// 能力门控：`omnicode-browser-relay` 频道名同时充当远端 server bundle 的 fork marker
// （FORK_SERVER_BUNDLE_MARKERS 文本探测命中才订阅）；官方/上游 server 没有该频道，fork 客户端
// 即使误订阅也由 rpc 层 onEventListen 守卫静默收口，不会崩掉远端进程。server 进程侧以频道
// listen 订阅计数为能力事实源：无订阅方时 fireRelayRequest 快速失败（保持现状的
// backend_unavailable 语义），多订阅方（≥2 桌面同连一 server）同样快速失败——v0 无会话归属
// 路由，广播会造成多桌面重复执行同一命令。

/** fork-only RPC 频道名；字符串同时作为远端 server bundle 的 fork marker。 */
export const OMNICODE_BROWSER_RELAY_CHANNEL = "omnicode-browser-relay";

/** 服务端 → 桌面端推送 relay 请求的事件名。 */
export const BROWSER_RELAY_LISTEN_EVENT = "onDynamicBrowserRelayRequest";

/** 桌面端 → 服务端回传结果的命令名。 */
export const BROWSER_RELAY_RESPOND_COMMAND = "browserRelayRespond";

/** 桌面端 → 服务端的存活/能力 ping 命令（连接后门控探测用）。 */
export const BROWSER_RELAY_PING_COMMAND = "browserRelayPing";

/**
 * 远端 server bundle 的 fork marker 集合。部署探测（node -e 文本探测，参照
 * REQUIRED_SERVER_BUNDLE_MARKERS 的写法）命中全部 marker 才视为 fork bundle；
 * 只用于能力门控，不参与 deploy 决策——CDN 下载的官方 bundle 永远不含 fork marker，
 * 参与决策会造成每次连接都触发永不收敛的重新部署。
 */
export const FORK_SERVER_BUNDLE_MARKERS: readonly string[] = [OMNICODE_BROWSER_RELAY_CHANNEL];

export type BrowserRelayAction = "list" | "execute";

/**
 * execute 动作的载荷：与 BrowserControlMainBridge.execute 的入参保持结构一致
 * （sessionId/command 必填，其余可选字段与官方桥一致）。
 */
export type BrowserRelayExecutePayload = {
  requestId?: string;
  browserId?: string;
  browserGeneration?: number;
  controlScopeId?: string;
  sessionId: string;
  turnId?: string;
  workspaceKey?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  clientMode?: BrowserClientMode;
  sessionContext?: "live" | "cached";
  command: BrowserCommand;
};

/** 服务端推送的 relay 请求。 */
export type BrowserRelayRequest =
  | { relayId: string; action: "list" }
  | { relayId: string; action: "execute"; payload: BrowserRelayExecutePayload };

/** 桌面端回传的 relay 结果（最小契约 { ok, result? }，按 action 区分结果类型）。 */
export type BrowserRelayResponse =
  | {
      relayId: string;
      action: "list";
      ok: boolean;
      result: BrowserBackendDescriptor[];
      error?: { code?: string; message: string };
    }
  | {
      relayId: string;
      action: "execute";
      ok: boolean;
      result: BrowserCommandResult;
      error?: { code?: string; message: string };
    };

/** browserRelayPing 的响应。 */
export type BrowserRelayPingResponse = { ok: true; marker: typeof OMNICODE_BROWSER_RELAY_CHANNEL };

/** browserRelayRespond 的确认响应。 */
export type BrowserRelayRespondAck = { ok: boolean };

/** 对事件载荷做最小结构校验（桌面端订阅侧防脏数据）。 */
export function isBrowserRelayRequest(value: unknown): value is BrowserRelayRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.relayId !== "string" || candidate.relayId.length === 0) {
    return false;
  }
  if (candidate.action === "list") {
    return true;
  }
  if (candidate.action === "execute") {
    const payload = candidate.payload;
    return (
      typeof payload === "object" &&
      payload !== null &&
      typeof (payload as Record<string, unknown>).command === "object" &&
      (payload as Record<string, unknown>).command !== null
    );
  }
  return false;
}
