// [OmniCode] 模式二 R2 单测：智能调度器（spec: docs/omnicode/multi-account-sessions.md
// §6/§10-R2）。覆盖：
// - pickAccount 挑选：剩余槽最多者优先；平局按 candidates（注册表）序稳定；全部无槽 →
//   null（排队/报错由调用方决定）；空候选 → null。
// - 上限解析：limits 命中 > pickOptions.defaultLimit > 构造 defaultLimit > 默认 3；
//   非法上限（0/负/NaN）按 0 槽跳过。
// - per-账号并发计数：registerStart/releaseFinish（sessionId→accountId 登记，会话结束
//   释放）；同 sessionId 重复登记 = 换账号（旧计数回收）；未登记释放 no-op。
// - 429/bizCode 3101/3103 退避降权：recordBackoff TTL 内跳过、过期自然恢复、重复登记
//   延长、非正 TTL no-op。
// - 有界登记表：FIFO 淘汰最旧绑定并同步回收其并发计数（防"只登记不释放"泄漏）。
// 注：全部用例纯内存，时钟经 now 注入（无真实等待）。
import { describe, expect, it } from "vitest";
import {
  createOmnicodeAccountScheduler,
  OMNICODE_ACCOUNT_DEFAULT_CONCURRENCY_LIMIT,
  resolveOmnicodeAccountLimit,
} from "../src/omnicode/accountScheduler.js";

describe("模式二 R2：resolveOmnicodeAccountLimit（纯函数）", () => {
  it("limits 命中优先于 pickOptions.defaultLimit", () => {
    expect(resolveOmnicodeAccountLimit("a", { a: 5 }, 2, 3)).toBe(5);
  });
  it("limits 未命中回落 pickOptions.defaultLimit", () => {
    expect(resolveOmnicodeAccountLimit("b", { a: 5 }, 2, 3)).toBe(2);
  });
  it("两者都缺回落调度器默认（OMNICODE_ACCOUNT_DEFAULT_CONCURRENCY_LIMIT=3）", () => {
    expect(OMNICODE_ACCOUNT_DEFAULT_CONCURRENCY_LIMIT).toBe(3);
    expect(resolveOmnicodeAccountLimit("b", undefined, undefined, 3)).toBe(3);
  });
  it("非法上限（NaN/Infinity）视为未配置，不产生 0/无限槽", () => {
    expect(resolveOmnicodeAccountLimit("a", { a: Number.NaN }, undefined, 3)).toBe(3);
    expect(resolveOmnicodeAccountLimit("a", { a: Number.POSITIVE_INFINITY }, undefined, 3)).toBe(3);
  });
});

describe("模式二 R2：调度器挑选（剩余槽最多者优先 + 平局稳定）", () => {
  it("剩余槽最多者优先：acct-b 零运行（剩 3）胜过 acct-a 一运行（剩 2）", () => {
    const scheduler = createOmnicodeAccountScheduler({ now: () => 0 });
    scheduler.registerStart({ sessionId: "s1", accountId: "acct-a" });
    // acct-a: 1 running；acct-b: 0 running → b 剩余 3 > a 剩余 2 → b。
    expect(scheduler.pickAccount(["acct-a", "acct-b"], { defaultLimit: 3 })).toBe("acct-b");
  });

  it("平局按 candidates 序稳定（注册表序）", () => {
    const scheduler = createOmnicodeAccountScheduler({ now: () => 0 });
    // 两个账号都 0 running，剩余槽相同 → 先出现的账号胜出。
    expect(scheduler.pickAccount(["acct-a", "acct-b"], { defaultLimit: 3 })).toBe("acct-a");
    expect(scheduler.pickAccount(["acct-b", "acct-a"], { defaultLimit: 3 })).toBe("acct-b");
  });

  it("满槽账号跳过：全部满槽 → null（调用方决定排队/报错）", () => {
    const scheduler = createOmnicodeAccountScheduler({ now: () => 0 });
    scheduler.registerStart({ sessionId: "s1", accountId: "acct-a" });
    scheduler.registerStart({ sessionId: "s2", accountId: "acct-a" });
    scheduler.registerStart({ sessionId: "s3", accountId: "acct-a" });
    expect(scheduler.pickAccount(["acct-a"], { limits: { "acct-a": 3 } })).toBeNull();
  });

  it("混合：满槽账号被跳过，剩余槽账号可用", () => {
    const scheduler = createOmnicodeAccountScheduler({ now: () => 0 });
    scheduler.registerStart({ sessionId: "s1", accountId: "acct-full" });
    scheduler.registerStart({ sessionId: "s2", accountId: "acct-full" });
    expect(
      scheduler.pickAccount(["acct-full", "acct-free"], { limits: { "acct-full": 2 } }),
    ).toBe("acct-free");
  });

  it("空候选 / 空白候选 → null", () => {
    const scheduler = createOmnicodeAccountScheduler({ now: () => 0 });
    expect(scheduler.pickAccount([])).toBeNull();
    expect(scheduler.pickAccount(["  ", ""])).toBeNull();
  });

  it("上限 0/负数的账号无槽 → null；NaN 上限视为未配置（回落默认 3）", () => {
    const scheduler = createOmnicodeAccountScheduler({ now: () => 0 });
    expect(
      scheduler.pickAccount(["acct-zero", "acct-neg"], {
        limits: { "acct-zero": 0, "acct-neg": -1 },
        defaultLimit: 3,
      }),
    ).toBeNull();
    // NaN 上限 = 未配置 → 回落 defaultLimit（与 resolveOmnicodeAccountLimit 语义一致）。
    expect(
      scheduler.pickAccount(["acct-nan"], { limits: { "acct-nan": Number.NaN }, defaultLimit: 3 }),
    ).toBe("acct-nan");
  });

  it("未配置账号用 defaultLimit（缺省 3）；limits 覆盖单账号", () => {
    const scheduler = createOmnicodeAccountScheduler({ now: () => 0 });
    expect(scheduler.pickAccount(["acct-x"])).toBe("acct-x");
    expect(scheduler.pickAccount(["acct-x"], { limits: { "acct-x": 1 } })).toBe("acct-x");
    scheduler.registerStart({ sessionId: "s1", accountId: "acct-x" });
    // limits {acct-x:1} → 1/1 满槽；defaultLimit 3 不适用（limits 命中优先）。
    expect(scheduler.pickAccount(["acct-x"], { limits: { "acct-x": 1 } })).toBeNull();
    // 不带 limits → 默认 3 → 1/3 仍有槽。
    expect(scheduler.pickAccount(["acct-x"])).toBe("acct-x");
  });
});

describe("模式二 R2：并发计数（registerStart/releaseFinish）", () => {
  it("登记累加、释放递减、释放到 0 清空", () => {
    const scheduler = createOmnicodeAccountScheduler({ now: () => 0 });
    scheduler.registerStart({ sessionId: "s1", accountId: "acct-a" });
    scheduler.registerStart({ sessionId: "s2", accountId: "acct-a" });
    expect(scheduler.runningCountOf("acct-a")).toBe(2);
    expect(scheduler.boundSessionCount()).toBe(2);
    scheduler.releaseFinish("s1");
    expect(scheduler.runningCountOf("acct-a")).toBe(1);
    scheduler.releaseFinish("s2");
    expect(scheduler.runningCountOf("acct-a")).toBe(0);
    expect(scheduler.boundSessionCount()).toBe(0);
  });

  it("未登记 sessionId 释放 no-op；空白键 no-op", () => {
    const scheduler = createOmnicodeAccountScheduler({ now: () => 0 });
    scheduler.releaseFinish("ghost");
    scheduler.registerStart({ sessionId: "", accountId: "acct-a" });
    scheduler.registerStart({ sessionId: "s1", accountId: "  " });
    expect(scheduler.boundSessionCount()).toBe(0);
    expect(scheduler.runningCountOf("acct-a")).toBe(0);
  });

  it("同 sessionId 重复登记 = 换账号（旧计数回收，不重复计数）", () => {
    const scheduler = createOmnicodeAccountScheduler({ now: () => 0 });
    scheduler.registerStart({ sessionId: "s1", accountId: "acct-a" });
    scheduler.registerStart({ sessionId: "s1", accountId: "acct-b" });
    expect(scheduler.runningCountOf("acct-a")).toBe(0);
    expect(scheduler.runningCountOf("acct-b")).toBe(1);
    expect(scheduler.boundSessionCount()).toBe(1);
  });

  it("同一账号同 sessionId 重复登记净零（不重复计数）", () => {
    const scheduler = createOmnicodeAccountScheduler({ now: () => 0 });
    scheduler.registerStart({ sessionId: "s1", accountId: "acct-a" });
    scheduler.registerStart({ sessionId: "s1", accountId: "acct-a" });
    expect(scheduler.runningCountOf("acct-a")).toBe(1);
  });

  it("释放后槽位归还 → pickAccount 恢复可用", () => {
    const scheduler = createOmnicodeAccountScheduler({ now: () => 0 });
    scheduler.registerStart({ sessionId: "s1", accountId: "acct-a" });
    scheduler.registerStart({ sessionId: "s2", accountId: "acct-a" });
    expect(scheduler.pickAccount(["acct-a"], { limits: { "acct-a": 2 } })).toBeNull();
    scheduler.releaseFinish("s2");
    expect(scheduler.pickAccount(["acct-a"], { limits: { "acct-a": 2 } })).toBe("acct-a");
  });
});

describe("模式二 R2：429/bizCode 3101/3103 退避降权", () => {
  it("TTL 内 pickAccount 跳过退避中的账号", () => {
    let clock = 1_000;
    const scheduler = createOmnicodeAccountScheduler({ now: () => clock });
    scheduler.registerStart({ sessionId: "s1", accountId: "acct-a" });
    scheduler.recordBackoff("acct-a", 30_000);
    expect(scheduler.isBackedOff("acct-a")).toBe(true);
    expect(scheduler.pickAccount(["acct-a", "acct-b"], { defaultLimit: 3 })).toBe("acct-b");
    // 只有退避账号 → null。
    expect(scheduler.pickAccount(["acct-a"], { defaultLimit: 3 })).toBeNull();
    clock += 29_999;
    expect(scheduler.pickAccount(["acct-a"], { defaultLimit: 3 })).toBeNull();
  });

  it("TTL 过期自然恢复（惰性清理，无定时器）", () => {
    let clock = 1_000;
    const scheduler = createOmnicodeAccountScheduler({ now: () => clock });
    scheduler.recordBackoff("acct-a", 30_000);
    clock += 30_000;
    expect(scheduler.isBackedOff("acct-a")).toBe(false);
    expect(scheduler.pickAccount(["acct-a"], { defaultLimit: 3 })).toBe("acct-a");
  });

  it("TTL 边界：until > now 退避中；until == now 已恢复", () => {
    let clock = 0;
    const scheduler = createOmnicodeAccountScheduler({ now: () => clock });
    scheduler.recordBackoff("acct-a", 10_000);
    clock = 9_999;
    expect(scheduler.isBackedOff("acct-a")).toBe(true);
    clock = 10_000;
    expect(scheduler.isBackedOff("acct-a")).toBe(false);
  });

  it("重复 recordBackoff 延长降权窗口；非正/非法 TTL no-op", () => {
    let clock = 0;
    const scheduler = createOmnicodeAccountScheduler({ now: () => clock });
    scheduler.recordBackoff("acct-a", 10_000);
    clock = 9_000;
    scheduler.recordBackoff("acct-a", 10_000);
    clock = 15_000;
    expect(scheduler.isBackedOff("acct-a")).toBe(true); // 新窗口到 19000。
    clock = 18_999;
    expect(scheduler.isBackedOff("acct-a")).toBe(true);
    clock = 19_000;
    expect(scheduler.isBackedOff("acct-a")).toBe(false);
    // 非法 TTL 不改变现状。
    scheduler.recordBackoff("acct-a", 0);
    scheduler.recordBackoff("acct-a", -5);
    scheduler.recordBackoff("acct-a", Number.NaN);
    expect(scheduler.isBackedOff("acct-a")).toBe(false);
    // 空白账号 no-op。
    scheduler.recordBackoff("  ", 10_000);
    expect(scheduler.isBackedOff("acct-a")).toBe(false);
  });

  it("退避中的账号即使剩余槽最多也被跳过（降权优先于槽位）", () => {
    let clock = 0;
    const scheduler = createOmnicodeAccountScheduler({ now: () => clock });
    scheduler.recordBackoff("acct-rich", 60_000);
    scheduler.registerStart({ sessionId: "s1", accountId: "acct-busy" });
    expect(scheduler.pickAccount(["acct-rich", "acct-busy"], { defaultLimit: 3 })).toBe(
      "acct-busy",
    );
  });
});

describe("模式二 R2：有界登记表（FIFO 淘汰 + 计数回收）", () => {
  it("超过容量淘汰最旧绑定并回收其并发计数", () => {
    // 直接消费内部容量常量语义：注册 1024 个会话后再注册一个，最旧被淘汰。
    const scheduler = createOmnicodeAccountScheduler({ now: () => 0, defaultLimit: 2000 });
    const total = 1025;
    for (let index = 0; index < total; index += 1) {
      scheduler.registerStart({ sessionId: `s${index}`, accountId: "acct-a" });
    }
    // 最旧 s0 已被淘汰：并发计数 1024（acct-a 只承载剩余绑定）。
    expect(scheduler.boundSessionCount()).toBe(1024);
    expect(scheduler.runningCountOf("acct-a")).toBe(1024);
    // 上限 1024 → 全满 → pickAccount null。
    expect(scheduler.pickAccount(["acct-a"], { limits: { "acct-a": 1024 } })).toBeNull();
    // 淘汰的 s0 释放 no-op（绑定已不在）。
    scheduler.releaseFinish("s0");
    expect(scheduler.runningCountOf("acct-a")).toBe(1024);
    // 现存绑定释放正常回收。
    scheduler.releaseFinish("s1");
    expect(scheduler.runningCountOf("acct-a")).toBe(1023);
  });
});
