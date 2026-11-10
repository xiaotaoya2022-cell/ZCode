import { VSBuffer } from "./buffer.js";
import { type IDisposable, CancellationTokenSource, toDisposable } from "./foundation.js";
import { BufferReader, BufferWriter, deserialize, serialize } from "./serialization.js";
import type { IMessagePassingProtocol } from "./protocol.js";
import {
  type IChannelServer,
  type IRawResponse,
  type IServerChannel,
  RequestType,
  ResponseType,
} from "./channels.shared.js";

export class ChannelServer<TContext = string> implements IChannelServer<TContext>, IDisposable {
  private channels = new Map<string, IServerChannel<TContext>>();
  private activeRequests = new Map<number, IDisposable>();
  private pendingRequests = new Map<
    string,
    { request: any; timer: ReturnType<typeof setTimeout> }[]
  >();
  private protocolListener: IDisposable | null;

  constructor(
    private protocol: IMessagePassingProtocol,
    private ctx: TContext,
    private timeoutDelay = 1000,
    private deferInit = false,
  ) {
    this.protocolListener = this.protocol.onMessage((msg) => this.onRawMessage(msg));
    if (!this.deferInit) {
      this.sendResponse({ type: ResponseType.Initialize });
    }
  }

  ready(): void {
    this.sendResponse({ type: ResponseType.Initialize });
  }

  registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
    this.channels.set(channelName, channel);
    setTimeout(() => this.flushPendingRequests(channelName), 0);
  }

  private sendResponse(response: IRawResponse): void {
    switch (response.type) {
      case ResponseType.Initialize:
        this.send([response.type]);
        return;
      case ResponseType.PromiseSuccess:
      case ResponseType.PromiseError:
      case ResponseType.EventFire:
      case ResponseType.EventError:
      case ResponseType.PromiseErrorObj:
        this.send([response.type, response.id], response.data);
        return;
    }
  }

  private send(header: any, body: any = undefined): void {
    const writer = new BufferWriter();
    serialize(writer, header);
    serialize(writer, body);
    try {
      this.protocol.send(writer.buffer);
    } catch {
      /* noop */
    }
  }

  private onRawMessage(message: VSBuffer): void {
    // 修复原因：同一 protocol 上还有反向 ChannelClient，对方发来的响应也会到这里；原来先解码消息体
    // 再判断类型，每条响应都被完整解码两次。修法：先读消息头，只解码属于本端的请求体。
    const reader = new BufferReader(message);
    const header = deserialize(reader);
    const type = header[0] as RequestType;

    switch (type) {
      case RequestType.Promise:
        this.onPromise({
          type,
          id: header[1],
          channelName: header[2],
          name: header[3],
          arg: deserialize(reader),
        });
        return;
      case RequestType.EventListen:
        this.onEventListen({
          type,
          id: header[1],
          channelName: header[2],
          name: header[3],
          arg: deserialize(reader),
        });
        return;
      case RequestType.PromiseCancel:
      case RequestType.EventDispose:
        this.disposeActiveRequest(header[1]);
        return;
    }
  }

  private onPromise(request: {
    type: RequestType.Promise;
    id: number;
    channelName: string;
    name: string;
    arg: any;
  }): void {
    const channel = this.channels.get(request.channelName);
    if (!channel) {
      this.collectPendingRequest(request);
      return;
    }

    const cts = new CancellationTokenSource();
    let promise: Promise<any>;

    try {
      promise = channel.call(this.ctx, request.name, request.arg, cts.token);
    } catch (error) {
      promise = Promise.reject(error);
    }

    const disposable = toDisposable(() => cts.cancel());
    this.activeRequests.set(request.id, disposable);

    promise
      .then(
        (data) => {
          this.sendResponse({
            id: request.id,
            data,
            type: ResponseType.PromiseSuccess,
          });
        },
        (error) => {
          if (error instanceof Error) {
            const rpcErrorPayload: {
              message: string;
              name: string;
              stack: string[] | undefined;
              code?: unknown;
              kind?: unknown;
              status?: unknown;
              retryAfterMs?: unknown;
              data?: unknown;
              detail?: unknown;
              details?: unknown;
              taskId?: unknown;
              traceId?: unknown;
              retryable?: unknown;
              profileId?: unknown;
            } = {
              message: error.message,
              name: error.name,
              stack: error.stack ? error.stack.split("\n") : undefined,
            };
            const errorRecord = error as Error & Record<string, unknown>;
            const passthroughKeys = [
              "code",
              "kind",
              "status",
              "retryAfterMs",
              "data",
              "detail",
              "details",
              "taskId",
              "traceId",
              "retryable",
              // Bug 原因：Host 的远程等待点（需要安装/升级、补凭据）用 profileId 指明实际操作线路；
              // 旧白名单丢掉它，侧栏项目只能把不含凭据的目标交给向导，确认安装后报“SSH 认证失败”。
              "profileId",
            ] as const;
            for (const key of passthroughKeys) {
              const value = errorRecord[key];
              if (value !== undefined) {
                rpcErrorPayload[key] = value;
              }
            }
            this.sendResponse({
              id: request.id,
              data: rpcErrorPayload,
              type: ResponseType.PromiseError,
            });
            return;
          }

          this.sendResponse({
            id: request.id,
            data: error,
            type: ResponseType.PromiseErrorObj,
          });
        },
      )
      .finally(() => {
        disposable.dispose();
        this.activeRequests.delete(request.id);
      });
  }

  private onEventListen(request: {
    type: RequestType.EventListen;
    id: number;
    channelName: string;
    name: string;
    arg: any;
  }): void {
    const channel = this.channels.get(request.channelName);
    if (!channel) {
      this.collectPendingRequest(request);
      return;
    }

    try {
      const disposable = channel.listen(
        this.ctx,
        request.name,
        request.arg,
      )((data) => {
        this.sendResponse({
          id: request.id,
          data,
          type: ResponseType.EventFire,
        });
      });
      this.activeRequests.set(request.id, disposable);
    } catch (error) {
      // [OmniCode] fork 客户端订阅未知事件（如 onDynamicBrowserRelayRequest 碰上官方 server）时，
      // channel.listen 会抛 "Event not found" 等错误。守卫要求：catch + 带上下文日志 + 静默，
      // 不回任何 wire 响应帧、不进 activeRequests、连接保持存活。设计依据：
      // ZakiCode docs/specs/remote-server-event-compat.md 与《ZCode 原生魔改版架构与实现方案报告》§5.1。
      // 静默（而非回 EventError 帧）的原因：Event 请求 id 与 Promise 请求 id 共用同一计数命名空间，
      // 客户端事件处理器可能对同 id 的任意响应帧类型不设防，错误帧可能被误读成事件数据；
      // 且静默与本文件 collectPendingRequest 对未知 channel 事件订阅的既有语义一致（记日志、不应答）。
      // 客户端侧的失效订阅与官方上游一致：等待 EventDispose 由监听器退订收口，不会泄漏连接。
      console.error(
        `[rpc] event listen failed (connection stays alive): channel=${request.channelName} event=${request.name}`,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private disposeActiveRequest(id: number): void {
    const disposable = this.activeRequests.get(id);
    if (!disposable) {
      return;
    }
    disposable.dispose();
    this.activeRequests.delete(id);
  }

  private collectPendingRequest(request: any): void {
    const pendingRequests = this.pendingRequests.get(request.channelName) ?? [];
    if (pendingRequests.length === 0) {
      this.pendingRequests.set(request.channelName, pendingRequests);
    }

    const timer = setTimeout(() => {
      console.error(`Unknown channel: ${request.channelName}`);
      if (request.type !== RequestType.Promise) {
        return;
      }

      this.sendResponse({
        id: request.id,
        data: {
          name: "Unknown channel",
          message: `Channel name '${request.channelName}' timed out after ${this.timeoutDelay}ms`,
          stack: undefined,
        },
        type: ResponseType.PromiseError,
      });
    }, this.timeoutDelay);

    pendingRequests.push({ request, timer });
  }

  private flushPendingRequests(channelName: string): void {
    const requests = this.pendingRequests.get(channelName);
    if (!requests) {
      return;
    }

    for (const { request, timer } of requests) {
      clearTimeout(timer);
      switch (request.type) {
        case RequestType.Promise:
          this.onPromise(request);
          break;
        case RequestType.EventListen:
          this.onEventListen(request);
          break;
      }
    }
    this.pendingRequests.delete(channelName);
  }

  dispose(): void {
    this.protocolListener?.dispose();
    this.protocolListener = null;
    for (const disposable of this.activeRequests.values()) {
      disposable.dispose();
    }
    this.activeRequests.clear();
  }
}
