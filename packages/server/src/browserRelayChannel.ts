import { randomUUID } from "node:crypto";
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
import type { BrowserAmbientContextExecutor } from "@zcode/services";

// [OmniCode] M4b Browser Relay：远端 server 侧的 fork-only 频道实现。
// 设计依据：《ZCode 原生魔改版架构与实现方案报告》§5.1、docs/omnicode/profile-runtime.md。
//
// 职责边界（v0）：
// - 作为 fork bundle 的能力事实源：频道名 `omnicode-browser-relay` 同时是
//   FORK_SERVER_BUNDLE_MARKERS 的文本 marker，部署探测据此判定远端是否 fork bundle。
// - `fireRelayRequest`（M4c 起有调用方）：远端 agent 的 browser 反向请求
//   （interaction/browserList、interaction/browserExecute）在无本地 browserControlExecutor 时，
//   由 zcodeAgentService 的 relay 降级路由经 createBrowserRelayAgentExecutor 调用：推送
//   onDynamicBrowserRelayRequest 并等待桌面端 browserRelayRespond 按 relayId 结算。
// - 订阅跟踪：每个订阅方（ChannelServer 的 EventListen 调用 listen()）持独立 Emitter，
//   退订/断连时句柄 dispose 即移除。hasRelaySubscriber() 据此把"对端桌面是否有 relay 能力"
//   暴露给 agent 侧 browser 后端解析（zcodeAgentService），未订阅时短路，绝不让命令挂满 45s
//   超时。fireRelayRequest 定向发给唯一订阅方；多订阅方（≥2 个桌面窗口同连一个 server）时
//   快速失败：v0 无会话归属路由，广播会让多个桌面同时执行同一命令（双开 tab/双导航），
//   宁可显式报错。
// - browserRelayPing 供桌面端连接后门控探测（官方 server 无此频道 → 未知频道超时，
//   桌面端跳过订阅）。
// 未注册的事件/命令一律抛错（"Event not found"/"Command not found"），由 rpc 层
// onEventListen 守卫与 Promise 错误路径各自收口。

/** relay 响应等待窗：桌面端 browser 桥预算 30s，留结果回传与归一化的余量。 */
const RELAY_RESPONSE_TIMEOUT_MS = 45_000;

export interface OmniCodeBrowserRelayServerChannel extends IServerChannel<string> {
  /** 推送 relay 请求并等待桌面端回传；超时或 dispose 时按失败收口。 */
  fireRelayRequest(request: BrowserRelayRequest): Promise<BrowserRelayResponse>;
  /** 对端桌面当前是否存在 onDynamicBrowserRelayRequest 订阅（browser 后端解析的门控事实）。 */
  hasRelaySubscriber(): boolean;
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
  const pendingResponses = new Map<string, PendingRelay>();
  // 每个订阅方一个独立 Emitter：ChannelServer.onEventListen 每次订阅都会调用 listen()，
  // 客户端退订（EventDispose）或连接关闭（ChannelServer.dispose → activeRequests 全量
  // dispose）时句柄被释放、订阅方被移除。集合为空说明对端桌面不再有 relay 能力；
  // 独立 Emitter 让 fireRelayRequest 定向发给唯一订阅方，避免在途请求期间新订阅方
  // 介入造成的重复投递（多订阅方本身在 fire 前就被门控拒绝）。
  const subscribers = new Set<{ emitter: Emitter<BrowserRelayRequest> }>();

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
      // 无订阅方或多订阅方都按能力不可用快速失败（而非广播后挂满 45s）：前者是官方/未连接
      // 桌面，后者会让多个桌面同时执行同一浏览器命令（v0 无会话归属路由，宁可不执行）。
      if (subscribers.size === 0) {
        return Promise.resolve(
          failureResponseFor(request, "desktop browser relay subscriber is not connected"),
        );
      }
      if (subscribers.size > 1) {
        return Promise.resolve(
          failureResponseFor(
            request,
            `ambiguous desktop browser relay subscribers (${subscribers.size} connected desktops)`,
          ),
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
        subscribers.values().next().value?.emitter.fire(request);
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
      // 订阅登记：退订/断连时句柄 dispose 移除订阅方，让 hasRelaySubscriber 反映真实对端。
      const subscriber = { emitter: new Emitter<BrowserRelayRequest>() };
      subscribers.add(subscriber);
      const counted = ((listener: (e: T) => void) => {
        const disposable = subscriber.emitter.event((request) => listener(request as T));
        return {
          dispose() {
            disposable.dispose();
            if (subscribers.delete(subscriber)) {
              subscriber.emitter.dispose();
            }
          },
        };
      }) as Event<T>;
      return counted;
    },

    hasRelaySubscriber() {
      return subscribers.size > 0;
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
      for (const subscriber of subscribers) {
        subscriber.emitter.dispose();
      }
      subscribers.clear();
    },
  };

  return channel;
}

/**
 * 把 relay 频道适配成 agent 侧 browser 后端解析所需的 executor 形状
 * （BrowserAmbientContextExecutor + hasRelaySubscriber 门控），由 server bundle 的
 * entry（entry-stdio/entry-http）在创建 services 前装配注入。
 *
 * 结果形状与本地 browserControlExecutor 完全一致：list 透传 BrowserBackendDescriptor[]，
 * execute 透传 BrowserCommandResult（relay 响应的 result 字段就是桌面桥的返回值）。
 * list 失败（ok=false）时抛错 —— zcodeAgentService 的 list 路径会 respondError 透出
 * 桌面侧真实错误，而不是静默返回空列表让 agent 误判"没有浏览器后端"。
 */
export function createBrowserRelayAgentExecutor(
  channel: OmniCodeBrowserRelayServerChannel,
): BrowserAmbientContextExecutor & { hasRelaySubscriber(): boolean } {
  return {
    hasRelaySubscriber: () => channel.hasRelaySubscriber(),
    async list() {
      const response = await channel.fireRelayRequest({
        relayId: randomUUID(),
        action: "list",
      });
      if (!response.ok || response.action !== "list") {
        throw new Error(response.error?.message ?? "browser relay list failed");
      }
      return response.result;
    },
    async execute(input) {
      const response = await channel.fireRelayRequest({
        relayId: randomUUID(),
        action: "execute",
        payload: input,
      });
      if (response.action !== "execute") {
        throw new Error("browser relay response action mismatch");
      }
      // 失败响应的 result 本身就是 ok:false 的 BrowserCommandResult（含 error/sideEffect），
      // 原样透传即可，agent 拿到与本地一致的结果形状。
      return response.result;
    },
  };
}
