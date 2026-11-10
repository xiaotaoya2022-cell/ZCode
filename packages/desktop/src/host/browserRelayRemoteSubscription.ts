import { type ChannelClient, type IChannel, type IDisposable } from "@zcode/rpc";
import {
  BROWSER_RELAY_LISTEN_EVENT,
  BROWSER_RELAY_PING_COMMAND,
  BROWSER_RELAY_RESPOND_COMMAND,
  OMNICODE_BROWSER_RELAY_CHANNEL,
  isBrowserRelayRequest,
  type BrowserRelayResponse,
} from "@zcode/shared";
import type { BrowserControlMainBridge } from "./browserControlMainBridge.js";

// [OmniCode] M4b Browser Relay：桌面 Host 侧的远程 workspace relay 订阅桥。
// 设计依据：《ZCode 原生魔改版架构与实现方案报告》§5.1、docs/omnicode/profile-runtime.md、
// ZakiCode docs/specs/remote-server-event-compat.md。
//
// 行为：
// 1. 连接建立后先做一次 browserRelayPing 门控探测——官方/上游 server 没有该频道，
//    未知频道按既有语义 1s 超时返回 PromiseError；fork server 立即应答。
//    门控关闭时 log warn + 跳过订阅（relay 降级为不可用），绝不向远端发送未知事件订阅。
// 2. 门控通过后订阅 onDynamicBrowserRelayRequest，把 list/execute 请求路由进
//    browserControlMainBridge（host→main BrowserExecuteRequest 桥，30s 预算语义照旧），
//    结果经 browserRelayRespond 回传远端。
// 3. 任何一步失败都只影响本次 relay 能力：不抛出、不断连、不阻塞连接建立流程。
//
// 限制（v0 记录）：stdio 直连路径可用 RemoteConnection.browserRelayAvailable（部署侧
// node -e bundle 文本探测）作为门控依据；经 Source Server 复用的 WS 连接无法在桌面端
// 直接做远端 bundle 文本探测，门控退化为对「Source Server 自身频道」的 ping 探测——
// 它反映的是 Source Server bundle 的 fork 能力，目标 SSH server 的能力传递属后续里程碑。

const PING_TIMEOUT_MS = 5_000;

export interface BrowserRelayHostLogger {
  info?(message: string, metadata?: unknown): void;
  warn(message: string, metadata?: unknown): void;
  error(message: string, metadata?: unknown): void;
}

export interface BrowserRelaySubscriptionDeps {
  client: ChannelClient;
  browserBridge: Pick<BrowserControlMainBridge, "list" | "execute">;
  logger: BrowserRelayHostLogger;
  /** stdio 直连路径的部署侧探测结论；未提供时以 ping 探测为准。 */
  deployProbeSaysForkBundle?: boolean;
}

/**
 * 对一条远程 workspace 连接做门控探测并订阅 relay 事件。
 * 返回订阅句柄（连接关闭时 dispose）；门控关闭时返回的句柄 dispose 为空操作。
 */
export function subscribeOmniCodeBrowserRelay(
  deps: BrowserRelaySubscriptionDeps,
): IDisposable {
  const { client, browserBridge, logger } = deps;
  let disposed = false;
  let eventDisposable: IDisposable | undefined;

  const channel: IChannel = client.getChannel<IChannel>(OMNICODE_BROWSER_RELAY_CHANNEL);

  const respond = (response: BrowserRelayResponse): void => {
    void channel
      .call(BROWSER_RELAY_RESPOND_COMMAND, response)
      .then((ack) => {
        if (
          typeof ack === "object" &&
          ack !== null &&
          (ack as { ok?: unknown }).ok === false
        ) {
          logger.warn("[omnicode-browser-relay] respond not settled by remote", {
            relayId: response.relayId,
          });
        }
      })
      .catch((error: unknown) => {
        logger.error("[omnicode-browser-relay] respond failed", {
          relayId: response.relayId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  void (async () => {
    let gatedOn = false;
    try {
      const ping = (await Promise.race([
        channel.call(BROWSER_RELAY_PING_COMMAND),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), PING_TIMEOUT_MS)),
      ])) as { ok?: unknown; marker?: unknown } | undefined;
      gatedOn =
        typeof ping === "object" &&
        ping !== null &&
        ping.ok === true &&
        ping.marker === OMNICODE_BROWSER_RELAY_CHANNEL;
    } catch (error) {
      gatedOn = false;
      logger.info?.(
        `[omnicode-browser-relay] gate probe rejected (official or unreachable remote): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (deps.deployProbeSaysForkBundle === false && gatedOn) {
      // 部署侧 bundle 文本探测与 ping 结论冲突时以文本探测为准（更接近 bundle 事实源）。
      gatedOn = false;
    }
    if (disposed) {
      return;
    }
    if (!gatedOn) {
      logger.warn(
        "[omnicode-browser-relay] remote bundle lacks fork marker, skip onDynamicBrowserRelayRequest subscription (relay unavailable)",
      );
      return;
    }
    try {
      eventDisposable = channel.listen(BROWSER_RELAY_LISTEN_EVENT)((raw: unknown) => {
        if (!isBrowserRelayRequest(raw)) {
          logger.warn("[omnicode-browser-relay] dropped malformed relay request");
          return;
        }
        if (raw.action === "list") {
          void browserBridge
            .list()
            .then((result) =>
              respond({ relayId: raw.relayId, action: "list", ok: true, result }),
            )
            .catch((error: unknown) =>
              respond({
                relayId: raw.relayId,
                action: "list",
                ok: false,
                result: [],
                error: {
                  message: error instanceof Error ? error.message : String(error),
                },
              }),
            );
          return;
        }
        // execute 载荷与 BrowserControlMainBridge.execute 入参结构一致（shared 契约保证），
        // 直接透传，预算（30s）与超时/cancel 语义完全由既有桥承担。
        void browserBridge
          .execute(raw.payload)
          .then((result) =>
            respond({ relayId: raw.relayId, action: "execute", ok: result.ok, result }),
          )
          .catch((error: unknown) =>
            respond({
              relayId: raw.relayId,
              action: "execute",
              ok: false,
              result: {
                ok: false,
                error: {
                  code: "execution_error",
                  message: error instanceof Error ? error.message : String(error),
                  sideEffect: "none",
                },
                elapsedMs: 0,
              },
            }),
          );
      });
      logger.info?.("[omnicode-browser-relay] relay subscription active for remote workspace");
    } catch (error) {
      // fork server 已注册该事件时不会走到这里；防御：订阅失败不得影响连接存活。
      logger.error("[omnicode-browser-relay] subscribe failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return {
    dispose() {
      disposed = true;
      eventDisposable?.dispose();
      eventDisposable = undefined;
    },
  };
}
