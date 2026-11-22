// [OmniCode] 模式二 R3/R4 服务侧单测（spec: docs/omnicode/multi-account-sessions.md §6/§7）：
// - 会话绑定决策纯函数（显式 > 智能 > 手动；门控关恒 no-bind；无候选 no-bind 回主账号）；
// - 目录元数据 Host→main 提供者：应答关联/逐条 schema 校验/TTL 缓存/失败不缓存/超时安全网；
// - 调度器接线决策（开=自动挑剩余槽最多 / 关=手动不挑）端到端纯路径。
import { describe, expect, it, vi } from "vitest";
import {
  createOmnicodeAccountDirectoryRemoteProvider,
  type OmnicodeAccountDirectoryTransport,
} from "../src/omnicode/accountDirectoryRemote.js";
import {
  createOmnicodeAccountScheduler,
  OMNICODE_ACCOUNT_DEFAULT_CONCURRENCY_LIMIT,
} from "../src/omnicode/accountScheduler.js";
import { shouldBindOmnicodeSessionAccount } from "../src/omnicode/sessionAccountBinding.js";

const synthetic = (part: string) => `omnicode-r3-test-fixture:${part}`;
const validEntry = {
  accountId: "acct-p0r3test01",
  sourceProfileId: "p0r3test01",
  family: "zai" as const,
  displayName: "工作号",
};
const validEntry2 = {
  accountId: "acct-p0r3test02",
  sourceProfileId: "p0r3test02",
  family: "bigmodel" as const,
  displayName: "生活号",
};

describe("模式二 R3/R4 会话绑定决策 shouldBindOmnicodeSessionAccount", () => {
  it("门控关恒 no-bind（官方路径逐字不变）", () => {
    const decision = shouldBindOmnicodeSessionAccount({
      gateActive: false,
      explicitAccountId: "acct-p0r3test01",
      smartEnabled: true,
      candidates: ["acct-p0r3test01"],
      pickAccount: (candidates) => candidates[0] ?? null,
    });
    expect(decision).toEqual({ accountId: null, reason: "gate-off" });
  });

  it("显式账号优先（R3 选择器透传意图）", () => {
    const decision = shouldBindOmnicodeSessionAccount({
      gateActive: true,
      explicitAccountId: "acct-p0r3test02",
      smartEnabled: true,
      candidates: ["acct-p0r3test01"],
      pickAccount: () => "acct-p0r3test01",
    });
    expect(decision).toEqual({ accountId: "acct-p0r3test02", reason: "explicit" });
  });

  it("R4 开=自动挑（pickAccount 返回剩余槽最多者）；关=手动不挑", () => {
    const scheduler = createOmnicodeAccountScheduler();
    // acct-01 占满默认上限 → 剩余槽最多者是 acct-02。
    scheduler.registerStart({ sessionId: "s1", accountId: "acct-p0r3test01" });
    scheduler.registerStart({ sessionId: "s2", accountId: "acct-p0r3test01" });
    scheduler.registerStart({ sessionId: "s3", accountId: "acct-p0r3test01" });
    const candidates = ["acct-p0r3test01", "acct-p0r3test02"];
    const smartOn = shouldBindOmnicodeSessionAccount({
      gateActive: true,
      explicitAccountId: null,
      smartEnabled: true,
      candidates,
      pickAccount: (list) => scheduler.pickAccount(list),
    });
    expect(smartOn).toEqual({ accountId: "acct-p0r3test02", reason: "smart" });
    const smartOff = shouldBindOmnicodeSessionAccount({
      gateActive: true,
      explicitAccountId: null,
      smartEnabled: false,
      candidates,
      pickAccount: (list) => scheduler.pickAccount(list),
    });
    expect(smartOff).toEqual({ accountId: null, reason: "manual" });
  });

  it("智能开但无可用槽 / 无调度器 → 不绑定（回落主账号）", () => {
    const scheduler = createOmnicodeAccountScheduler();
    for (let i = 0; i < OMNICODE_ACCOUNT_DEFAULT_CONCURRENCY_LIMIT; i += 1) {
      scheduler.registerStart({ sessionId: `s${i}`, accountId: "acct-p0r3test01" });
    }
    expect(
      shouldBindOmnicodeSessionAccount({
        gateActive: true,
        explicitAccountId: null,
        smartEnabled: true,
        candidates: ["acct-p0r3test01"],
        pickAccount: (list) => scheduler.pickAccount(list),
      }),
    ).toEqual({ accountId: null, reason: "no-candidate" });
    expect(
      shouldBindOmnicodeSessionAccount({
        gateActive: true,
        explicitAccountId: null,
        smartEnabled: true,
        candidates: ["acct-p0r3test01"],
        pickAccount: null,
      }),
    ).toEqual({ accountId: null, reason: "manual" });
  });

  it("空白显式账号视为未显式（trim 防线）", () => {
    expect(
      shouldBindOmnicodeSessionAccount({
        gateActive: true,
        explicitAccountId: "   ",
        smartEnabled: false,
        candidates: [],
        pickAccount: null,
      }),
    ).toEqual({ accountId: null, reason: "manual" });
  });
});

describe("模式二 R3 目录元数据 Host→main 提供者", () => {
  interface StubTransportOptions {
    reply?: (request: unknown) => unknown;
  }
  function stubTransport(options: StubOptions = {}): {
    transport: OmnicodeAccountDirectoryTransport;
    sent: unknown[];
  } {
    const sent: unknown[] = [];
    const listeners: Array<(e: { data: unknown }) => void> = [];
    const transport: OmnicodeAccountDirectoryTransport = {
      postMessage(message) {
        sent.push(message);
        const reply = options.reply;
        if (reply) {
          const { requestId } = message as { requestId: string };
          Promise.resolve().then(() => {
            for (const listener of listeners) listener({ data: reply(requestId) });
          });
        }
      },
      on(_event, listener) {
        listeners.push(listener);
      },
    };
    return { transport, sent };
  }
  type StubOptions = { reply?: (requestId: string) => unknown };

  it("应答关联 + 逐条 schema 校验（非法条目整条丢弃）", async () => {
    const { transport } = stubTransport({
      reply: (requestId) => ({
        type: "omnicode-account-directory-list-result",
        requestId,
        ok: true,
        accounts: [validEntry, { ...validEntry2, accountId: "../escape" }],
      }),
    });
    const provider = createOmnicodeAccountDirectoryRemoteProvider({ transport });
    const entries = await provider.list();
    expect(entries.map((entry) => entry.accountId)).toEqual([validEntry.accountId]);
  });

  it("TTL 缓存：命中不重发；失败不缓存（下次重试）", async () => {
    {
      let now = 1_000;
      let shouldFail = false;
      const { transport, sent } = stubTransport({
        reply: (requestId) =>
          shouldFail
            ? { type: "omnicode-account-directory-list-result", requestId, ok: false, error: "x" }
            : {
                type: "omnicode-account-directory-list-result",
                requestId,
                ok: true,
                accounts: [validEntry, validEntry2],
              },
      });
      const provider = createOmnicodeAccountDirectoryRemoteProvider({
        transport,
        now: () => now,
      });
      const first = await provider.list();
      expect(first.length).toBe(2);
      const sentCountAfterFirst = sent.length;
      const second = await provider.list();
      expect(second.length).toBe(2);
      expect(sent.length).toBe(sentCountAfterFirst); // TTL 命中不重发
      // TTL 过期 → 重发。
      now += 61_000;
      const third = await provider.list();
      expect(third.length).toBe(2);
      expect(sent.length).toBe(sentCountAfterFirst + 1);
      // 失败应答：空列表 + 不缓存（下次查询重试）。
      now += 61_000;
      shouldFail = true;
      const failed = await provider.list();
      expect(failed).toEqual([]);
      const retried = await provider.list();
      expect(retried).toEqual([]);
      expect(sent.length).toBe(sentCountAfterFirst + 3); // 失败未缓存，重试重发
    }
  });

  it("transport 缺席（官方/远端装配）→ 恒空列表", async () => {
    const provider = createOmnicodeAccountDirectoryRemoteProvider({ transport: null });
    expect(await provider.list()).toEqual([]);
  });

  it("超时安全网（无应答）→ 空列表", async () => {
    vi.useFakeTimers();
    try {
      const { transport } = stubTransport({});
      const provider = createOmnicodeAccountDirectoryRemoteProvider({
        transport,
        requestTimeoutMs: 2_000,
      });
      const promise = provider.list();
      vi.advanceTimersByTime(3_000);
      expect(await promise).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
