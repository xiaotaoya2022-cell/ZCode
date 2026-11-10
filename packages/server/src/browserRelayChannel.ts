import { Emitter, type Event } from "@zcode/rpc";
import type { IServerChannel } from "@zcode/rpc";
import {
  BROWSER_RELAY_LISTEN_EVENT,
  BROWSER_RELAY_PING_COMMAND,
  BROWSER_RELAY_RESPOND_COMMAND,
  OMNICODE_BROWSER_RELAY_CHANNEL,
  type BrowserRelayRequest,
  type BrowserRelayResponse,
} from "@zcode/shared";

// [OmniCode] M4b Browser Relay：远端 server 侧的 fork-only 频道实现。
// 设计依据：《ZCode 原生魔改版架构与实现方案报告》§5.1、docs/omnicode/profile-runtime.md。
//
// 职责边界（v0）：
// - 作为 fork bundle 的能力事实源：频道名 `omnicode-browser-relay` 同时是
//   FORK_SERVER_BUNDLE_MARKERS 的文本 marker，部署探测据此判定远端是否 fork bundle。
// - `fireRelayRequest` 由后续里程碑的 agent browser-use 集成调用（v0 无调用方）：推送
//   onDynamicBrowserRelayRequest 并等待桌面端 browserRelayRespond 按 relayId 结算。
// - browserRelayPing 供桌面端连接后门控探测（官方 server 无此频道 → 未知频道超时，
//   桌面端跳过订阅）。
// 未注册的事件/命令一律抛错（"Event not found"/"Command not found"），由 rpc 层
// onEventListen 守卫与 Promise 错误路径各自收口。

/** relay 响应等待窗：桌面端 browser 桥预算 30s，留结果回传与归一化的余量。 */
const RELAY_RESPONSE_TIMEOUT_MS = 45_000;

export interface OmniCodeBrowserRelayServerChannel extends IServerChannel<string> {
  /** 推送 relay 请求并等待桌面端回传；超时或 dispose 时按失败收口。 */
  fireRelayRequest(request: BrowserRelayRequest): Promise<BrowserRelayResponse>;
  dispose(): void;
}

interface PendingRelay {
  request: BrowserRelayRequest;
  resolve: (response: BrowserRelayResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

function failureResponseFor(request: BrowserRelayRequest, message: string): BrowserRelayResponse {
  const error = { code: "backend_unavailable" as const, message };
  if (request.action === "list") {
    return { relayId: request.relayId, action: "list", ok: false, result: [], error };
  }
  return {
    relayId: request.relayId,
    action: "execute",
    ok: false,
    result: { ok: false, error: { ...error, sideEffect: "uncertain" }, elapsedMs: 0 },
  };
}

export function createOmniCodeBrowserRelayChannel(): OmniCodeBrowserRelayServerChannel {
  const onRequest = new Emitter<BrowserRelayRequest>();
  const pendingResponses = new Map<string, PendingRelay>();

  const settleResponse = (response: BrowserRelayResponse): boolean => {
    const pending = pendingResponses.get(response.relayId);
    if (!pending) {
      return false;
    }
    clearTimeout(pending.timer);
    pendingResponses.delete(response.relayId);
    pending.resolve(response);
    return true;
  };

  const channel: OmniCodeBrowserRelayServerChannel = {
    fireRelayRequest(request) {
      if (pendingResponses.has(request.relayId)) {
        return Promise.reject(
          new Error(`duplicate browser relay id: ${request.relayId}`),
        );
      }
      return new Promise<BrowserRelayResponse>((resolve) => {
        const pending: PendingRelay = {
          request,
          resolve,
          timer: setTimeout(() => {
            pendingResponses.delete(request.relayId);
            resolve(
              failureResponseFor(
                request,
                `browser relay response timed out after ${RELAY_RESPONSE_TIMEOUT_MS}ms`,
              ),
            );
          }, RELAY_RESPONSE_TIMEOUT_MS),
        };
        pendingResponses.set(request.relayId, pending);
        onRequest.fire(request);
      });
    },

    async call<T>(ctx: string, command: string, arg: unknown): Promise<T> {
      switch (command) {
        case BROWSER_RELAY_PING_COMMAND:
          return { ok: true, marker: OMNICODE_BROWSER_RELAY_CHANNEL } as T;
        case BROWSER_RELAY_RESPOND_COMMAND: {
          const response = arg as BrowserRelayResponse | undefined;
          if (
            typeof response !== "object" ||
            response === null ||
            typeof (response as { relayId?: unknown }).relayId !== "string"
          ) {
            return { ok: false } as T;
          }
          const settled = settleResponse(response);
          if (!settled) {
            // 迟到/无主响应（fireRelayRequest 尚未发出该 relayId）：确认收到但不结算，
            // 不能谎报成功，桌面端据此可以判别回传是否真正被消费。
            console.error(
              `[omnicode-browser-relay] respond without pending relay: relayId=${response.relayId}`,
            );
            return { ok: false } as T;
          }
          return { ok: true } as T;
        }
        default:
          throw new Error(`Command not found: ${command}`);
      }
    },

    listen<T>(ctx: string, event: string): Event<T> {
      if (event !== BROWSER_RELAY_LISTEN_EVENT) {
        throw new Error(`Event not found: ${event}`);
      }
      return onRequest.event as Event<T>;
    },

    dispose() {
      for (const pending of pendingResponses.values()) {
        clearTimeout(pending.timer);
        pending.resolve(
          failureResponseFor(
            pending.request,
            "browser relay channel disposed before response arrived",
          ),
        );
      }
      pendingResponses.clear();
      onRequest.dispose();
    },
  };

  return channel;
}
