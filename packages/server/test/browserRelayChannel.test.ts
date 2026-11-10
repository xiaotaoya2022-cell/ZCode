import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_RELAY_LISTEN_EVENT,
  BROWSER_RELAY_PING_COMMAND,
  BROWSER_RELAY_RESPOND_COMMAND,
  OMNICODE_BROWSER_RELAY_CHANNEL,
  type BrowserRelayExecutePayload,
  type BrowserRelayRequest,
  type BrowserRelayResponse,
} from "@zcode/shared";
import {
  createBrowserRelayAgentExecutor,
  createOmniCodeBrowserRelayChannel,
  type OmniCodeBrowserRelayServerChannel,
} from "../src/browserRelayChannel.js";

// [OmniCode] M4c Browser Relay：频道层单测——订阅计数（hasRelaySubscriber）是 agent 侧
// browser 后端解析的门控事实源：无/多订阅方必须快速失败（backend_unavailable，绝不挂满
// 45s 超时），单订阅方按 relayId 定向投递并以 browserRelayRespond 结算。
// M4b 提交记录过「rpc 无既有测试设施，用例补录需另行登记」——本文件即该登记：
// scripts/engineering-test-files.json 显式清单已收录本文件。

const CONTEXT = "test-context";

interface RelaySubscriber {
  /** fireRelayRequest 投递到本订阅方的请求（按投递顺序）。 */
  readonly requests: readonly BrowserRelayRequest[];
  /** 最近一次投递的 relayId（构造 browserRelayRespond 回传用）。 */
  readonly lastRelayId: string | undefined;
  dispose(): void;
}

/** 模拟桌面 Host：订阅 onDynamicBrowserRelayRequest（退订走 dispose，等价 EventDispose）。 */
function subscribeRelay(channel: OmniCodeBrowserRelayServerChannel): RelaySubscriber {
  const requests: BrowserRelayRequest[] = [];
  const event = channel.listen<BrowserRelayRequest>(CONTEXT, BROWSER_RELAY_LISTEN_EVENT);
  const disposable = event((request) => {
    requests.push(request);
  });
  return {
    requests,
    get lastRelayId() {
      return requests.at(-1)?.relayId;
    },
    dispose() {
      disposable.dispose();
    },
  };
}

/** 模拟桌面 Host 回传结果（browserRelayRespond 命令）。 */
function respond(channel: OmniCodeBrowserRelayServerChannel, response: BrowserRelayResponse) {
  return channel.call<{ ok: boolean }>(CONTEXT, BROWSER_RELAY_RESPOND_COMMAND, response);
}

const LIST_EXECUTOR_INPUT = {
  requestId: "req-list",
  sessionId: "s1",
  workspaceKey: "ws",
  workspacePath: "/ws",
  clientMode: "desktop-continuous" as const,
  sessionContext: "live" as const,
};

const EXECUTE_EXECUTOR_INPUT = {
  requestId: "req-exec",
  sessionId: "s1",
  workspaceKey: "ws",
  workspacePath: "/ws",
  clientMode: "desktop-continuous" as const,
  sessionContext: "live" as const,
  command: { method: "list" } as const,
};

describe("createOmniCodeBrowserRelayChannel", () => {
  it("browserRelayPing 返回 fork marker（桌面端门控探测依据）", async () => {
    const channel = createOmniCodeBrowserRelayChannel();
    const ping = await channel.call<{ ok: boolean; marker: string }>(
      CONTEXT,
      BROWSER_RELAY_PING_COMMAND,
    );
    expect(ping.ok).toBe(true);
    expect(ping.marker).toBe(OMNICODE_BROWSER_RELAY_CHANNEL);
  });

  it("未知命令与未知事件按既定语义抛错（rpc 守卫各自收口）", async () => {
    const channel = createOmniCodeBrowserRelayChannel();
    await expect(channel.call(CONTEXT, "unknownCommand")).rejects.toThrow(
      "Command not found: unknownCommand",
    );
    expect(() => channel.listen(CONTEXT, "unknownEvent")).toThrow("Event not found: unknownEvent");
  });

  it("无订阅方时 fireRelayRequest 快速失败，不挂满超时", async () => {
    const channel = createOmniCodeBrowserRelayChannel();
    expect(channel.hasRelaySubscriber()).toBe(false);

    const listResponse = await channel.fireRelayRequest({ relayId: "r-none", action: "list" });
    expect(listResponse.ok).toBe(false);
    expect(listResponse.error?.message).toBe("desktop browser relay subscriber is not connected");
    expect(listResponse.result).toEqual([]);

    const executeResponse = await channel.fireRelayRequest({
      relayId: "r-none-exec",
      action: "execute",
      payload: { sessionId: "s1", command: { method: "list" } },
    });
    if (executeResponse.action !== "execute") throw new Error("unexpected list response");
    expect(executeResponse.ok).toBe(false);
    expect(executeResponse.result.ok).toBe(false);
    expect(executeResponse.result.error?.code).toBe("backend_unavailable");
    expect(executeResponse.result.error?.sideEffect).toBe("uncertain");
  });

  it("单订阅方定向投递并以 browserRelayRespond 按 relayId 结算；退订即摘除订阅计数", async () => {
    const channel = createOmniCodeBrowserRelayChannel();
    const subscriber = subscribeRelay(channel);
    expect(channel.hasRelaySubscriber()).toBe(true);

    const pending = channel.fireRelayRequest({ relayId: "r-list", action: "list" });
    expect(subscriber.requests).toEqual([{ relayId: "r-list", action: "list" }]);

    const ack = await respond(channel, { relayId: "r-list", action: "list", ok: true, result: [] });
    expect(ack).toEqual({ ok: true });
    await expect(pending).resolves.toEqual({
      relayId: "r-list",
      action: "list",
      ok: true,
      result: [],
    });

    subscriber.dispose();
    expect(channel.hasRelaySubscriber()).toBe(false);
  });

  it("execute 结果透传桌面桥的 BrowserCommandResult（含 ok:false 失败形状）", async () => {
    const channel = createOmniCodeBrowserRelayChannel();
    const subscriber = subscribeRelay(channel);

    const payload: BrowserRelayExecutePayload = {
      sessionId: "s1",
      controlScopeId: "scope-1",
      command: { method: "openScope" },
    };
    const pending = channel.fireRelayRequest({ relayId: "r-exec", action: "execute", payload });
    expect(subscriber.requests).toEqual([{ relayId: "r-exec", action: "execute", payload }]);

    const desktopResult = {
      ok: false,
      scope: { id: "scope-1", state: "rejected" as const },
      error: {
        code: "backend_unavailable" as const,
        message: "no browser pane",
        sideEffect: "none" as const,
      },
      elapsedMs: 12,
    };
    await respond(channel, {
      relayId: "r-exec",
      action: "execute",
      ok: false,
      result: desktopResult,
    });
    await expect(pending).resolves.toEqual({
      relayId: "r-exec",
      action: "execute",
      ok: false,
      result: desktopResult,
    });
    subscriber.dispose();
  });

  it("多订阅方（≥2 桌面同连一 server）按歧义快速失败且不投递", async () => {
    const channel = createOmniCodeBrowserRelayChannel();
    const first = subscribeRelay(channel);
    const second = subscribeRelay(channel);
    expect(channel.hasRelaySubscriber()).toBe(true);

    const response = await channel.fireRelayRequest({ relayId: "r-amb", action: "list" });
    expect(response.ok).toBe(false);
    expect(response.error?.message).toBe(
      "ambiguous desktop browser relay subscribers (2 connected desktops)",
    );
    expect(first.requests).toEqual([]);
    expect(second.requests).toEqual([]);
    first.dispose();
    second.dispose();
  });

  it("在途请求期间订阅退订：响应无主，按 45s 超时收口不挂起", async () => {
    vi.useFakeTimers();
    try {
      const channel = createOmniCodeBrowserRelayChannel();
      const first = subscribeRelay(channel);
      const pending = channel.fireRelayRequest({ relayId: "r-race", action: "list" });
      expect(first.requests).toHaveLength(1);
      first.dispose();
      expect(channel.hasRelaySubscriber()).toBe(false);

      vi.advanceTimersByTime(45_000);
      const response = await pending;
      expect(response.ok).toBe(false);
      expect(response.error?.message).toBe("browser relay response timed out after 45000ms");
    } finally {
      vi.useRealTimers();
    }
  });

  it("重复 relayId 拒绝、无主响应不谎报成功", async () => {
    const channel = createOmniCodeBrowserRelayChannel();
    subscribeRelay(channel);

    const pending = channel.fireRelayRequest({ relayId: "r-dup", action: "list" });
    await expect(channel.fireRelayRequest({ relayId: "r-dup", action: "list" })).rejects.toThrow(
      "duplicate browser relay id: r-dup",
    );

    const lateAck = await respond(channel, {
      relayId: "r-late",
      action: "list",
      ok: true,
      result: [],
    });
    expect(lateAck).toEqual({ ok: false });

    const ack = await respond(channel, { relayId: "r-dup", action: "list", ok: true, result: [] });
    expect(ack).toEqual({ ok: true });
    await pending;
  });

  it("频道 dispose 时在途请求按失败收口且订阅计数清零", async () => {
    const channel = createOmniCodeBrowserRelayChannel();
    subscribeRelay(channel);
    const pending = channel.fireRelayRequest({ relayId: "r-dispose", action: "list" });

    channel.dispose();
    const response = await pending;
    expect(response.ok).toBe(false);
    expect(response.error?.message).toBe("browser relay channel disposed before response arrived");
    expect(channel.hasRelaySubscriber()).toBe(false);
    const after = await channel.fireRelayRequest({ relayId: "r-after-dispose", action: "list" });
    expect(after.ok).toBe(false);
  });
});

describe("createBrowserRelayAgentExecutor", () => {
  it("hasRelaySubscriber 透传频道订阅计数", () => {
    const channel = createOmniCodeBrowserRelayChannel();
    const executor = createBrowserRelayAgentExecutor(channel);
    expect(executor.hasRelaySubscriber()).toBe(false);
    const subscriber = subscribeRelay(channel);
    expect(executor.hasRelaySubscriber()).toBe(true);
    subscriber.dispose();
    expect(executor.hasRelaySubscriber()).toBe(false);
  });

  it("list：订阅在位时经 relay 取桌面 backend 列表（relayId 精确绑定）", async () => {
    const channel = createOmniCodeBrowserRelayChannel();
    const executor = createBrowserRelayAgentExecutor(channel);
    const subscriber = subscribeRelay(channel);

    const pending = executor.list(LIST_EXECUTOR_INPUT);
    expect(subscriber.lastRelayId).toEqual(expect.any(String));
    const descriptor = { id: "iab-1", generation: 0, type: "iab" as const, name: "IAB", capabilities: {} };
    await respond(channel, {
      relayId: subscriber.lastRelayId!,
      action: "list",
      ok: true,
      result: [descriptor],
    });
    await expect(pending).resolves.toEqual([descriptor]);
    subscriber.dispose();
  });

  it("list：桌面回 ok:false 时抛错（respondError 透出真实错误而非静默空列表）", async () => {
    const channel = createOmniCodeBrowserRelayChannel();
    const executor = createBrowserRelayAgentExecutor(channel);
    const subscriber = subscribeRelay(channel);

    const pending = executor.list(LIST_EXECUTOR_INPUT);
    await respond(channel, {
      relayId: subscriber.lastRelayId!,
      action: "list",
      ok: false,
      result: [],
      error: { message: "desktop bridge exploded" },
    });
    await expect(pending).rejects.toThrow("desktop bridge exploded");
    subscriber.dispose();
  });

  it("execute：透传桌面桥结果（ok:false 原样返回，不二次包装）", async () => {
    const channel = createOmniCodeBrowserRelayChannel();
    const executor = createBrowserRelayAgentExecutor(channel);
    const subscriber = subscribeRelay(channel);

    const pending = executor.execute(EXECUTE_EXECUTOR_INPUT);
    const desktopResult = {
      ok: false,
      error: { code: "timeout" as const, message: "slow" },
      elapsedMs: 3,
    };
    await respond(channel, {
      relayId: subscriber.lastRelayId!,
      action: "execute",
      ok: false,
      result: desktopResult,
    });
    await expect(pending).resolves.toEqual(desktopResult);
    subscriber.dispose();
  });

  it("execute：响应 action 与请求不匹配时显式抛错（防错位结算）", async () => {
    const channel = createOmniCodeBrowserRelayChannel();
    const executor = createBrowserRelayAgentExecutor(channel);
    const subscriber = subscribeRelay(channel);

    const pending = executor.execute(EXECUTE_EXECUTOR_INPUT);
    // 频道按 relayId 结算；executor 必须 own action 一致性检查（错位响应不透传）。
    await respond(channel, {
      relayId: subscriber.lastRelayId!,
      action: "list",
      ok: true,
      result: [],
    });
    await expect(pending).rejects.toThrow("browser relay response action mismatch");
    subscriber.dispose();
  });

  it("无订阅方时 executor.list 抛错、executor.execute 按 ok:false 结果收口（均不挂起）", async () => {
    const channel = createOmniCodeBrowserRelayChannel();
    const executor = createBrowserRelayAgentExecutor(channel);
    await expect(executor.list(LIST_EXECUTOR_INPUT)).rejects.toThrow(
      "desktop browser relay subscriber is not connected",
    );
    // execute 的失败语义与本地桥一致：不抛异常，返回 ok:false 的 BrowserCommandResult。
    await expect(executor.execute(EXECUTE_EXECUTOR_INPUT)).resolves.toEqual({
      ok: false,
      error: {
        code: "backend_unavailable",
        message: "desktop browser relay subscriber is not connected",
        sideEffect: "uncertain",
      },
      elapsedMs: 0,
    });
  });
});
