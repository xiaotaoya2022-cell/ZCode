// [OmniCode] 批次3 UI 批次单测：账号看板 / 赛博鸡蛋 UI 模型 + 检测/自动领取编排。
// 覆盖（spec: F:\OmniCode\docs\batch3\BATCH3-DESIGN-DISCUSSION.md §2/§3）：
// - 检测状态汇聚（aggregateOmnicodeClaimDetection）+ 邮箱脱敏/展示名归一；
// - detectOmnicodeClaimableAccounts（profileRuntime mock + 真 fs + 假 preview）；
// - 自动领取轮询决策（resolveOmnicodeAutoClaimAction）+ 单 tick 编排（注入 deps）；
// - 门票叠模型（buildOmnicodeTicketStackLayout/resolveOmnicodeTicketSlotIndex）；
// - 结算汇总（summarizeOmnicodeClaimSettlement）+ 自动领取历史徽章汇总
//   (summarizeOmnicodeAutoSettlementFromHistory)；
// - 看板汇总条健康分档计数（resolveOmnicodeLoginHealthCounts）。
// 写法参照 omnicodeBatch3AccountData.test.ts（profileRuntime mock + 真 fs/cipher）。
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSystemCredentialCipher } from "@zcode/shared/credential-security";
import { maskOmnicodeAccountEmail } from "@zcode/shared";
import {
  aggregateOmnicodeClaimDetection,
  detectOmnicodeClaimableAccounts,
  resolveOmnicodeDetectionDisplayName,
} from "../src/main/omnicode/accountDetection.js";
import {
  OMNICODE_CLAIM_AUTO_POLL_INTERVAL_MS,
  resolveOmnicodeAutoClaimAction,
  runOmnicodeClaimAutoPollTick,
  type OmnicodeClaimAutoPollDeps,
} from "../src/main/omnicode/claimAutoPoll.js";
import {
  buildOmnicodeTicketStackLayout,
  OMNICODE_TICKET_STACK_VISIBLE_SLOTS,
  resolveOmnicodeTicketSlotIndex,
  summarizeOmnicodeAutoSettlementFromHistory,
  summarizeOmnicodeClaimSettlement,
  type OmnicodeClaimTicketOutcome,
} from "@/console/eggClaimModel.js";
import { resolveOmnicodeLoginHealthCounts } from "@/console/accountDashboardModel.js";
import type {
  OmnicodeAccountDetectionEntry,
  OmnicodeClaimHistoryEntry,
} from "@zcode/shared";

// ─── mocks：profileRuntime（同 omnicodeBatch3AccountData.test.ts 模式）────────────
const profileState = vi.hoisted(() => ({
  profiles: [] as { id: string; name: string; createdAt: string }[],
  records: {} as Record<string, { dataBaseDirOverride?: string } | undefined>,
}));
vi.mock("../src/main/omnicode/profileRuntime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/main/omnicode/profileRuntime.js")>();
  return {
    ...actual,
    listOmnicodeProfiles: async () => profileState.profiles.map((entry) => ({ ...entry })),
    getOmnicodeProfileRecord: async (profileId: string) => profileState.records[profileId],
  };
});

const SECRET = "test-secret-0123456789abcdef-0123456789abcdef";

function entryOf(partial: Partial<OmnicodeAccountDetectionEntry> & { profileId: string; profileName: string }): OmnicodeAccountDetectionEntry {
  return partial as OmnicodeAccountDetectionEntry;
}

// ─── 检测状态汇聚（纯函数）────────────────────────────────────────────────────
describe("omnicode batch3 ui: aggregateOmnicodeClaimDetection (pure)", () => {
  it("按桶计数 + 可领额度求和（部分账号缺 grantedUnits 不编造 0）", () => {
    const summary = aggregateOmnicodeClaimDetection([
      entryOf({ profileId: "a", profileName: "A", displayName: "A", state: "claimable", grantedUnits: 200 }),
      entryOf({ profileId: "b", profileName: "B", displayName: "B", state: "claimable" }),
      entryOf({ profileId: "c", profileName: "C", displayName: "C", state: "no_claim" }),
      entryOf({ profileId: "d", profileName: "D", displayName: "D", state: "skipped_no_device_mid" }),
      entryOf({ profileId: "e", profileName: "E", displayName: "E", state: "missing_jwt" }),
      entryOf({ profileId: "f", profileName: "F", displayName: "F", state: "failed" }),
      entryOf({ profileId: "g", profileName: "G", displayName: "G", state: "unknown" }),
    ]);
    expect(summary).toEqual({
      total: 7,
      claimable: 2,
      noClaim: 1,
      skipped: 2,
      failed: 1,
      unknown: 1,
      estimatedGrantedUnits: 200,
    });
  });

  it("全无可领：estimatedGrantedUnits 缺省（不出现 0 合计）", () => {
    const summary = aggregateOmnicodeClaimDetection([
      entryOf({ profileId: "a", profileName: "A", displayName: "A", state: "no_claim" }),
    ]);
    expect(summary).toEqual({
      total: 1,
      claimable: 0,
      noClaim: 1,
      skipped: 0,
      failed: 0,
      unknown: 0,
    });
    expect("estimatedGrantedUnits" in summary).toBe(false);
  });

  it("空列表：全 0 且无 estimatedGrantedUnits", () => {
    expect(aggregateOmnicodeClaimDetection([])).toEqual({
      total: 0,
      claimable: 0,
      noClaim: 0,
      skipped: 0,
      failed: 0,
      unknown: 0,
    });
  });
});

// ─── 邮箱脱敏 / 展示名归一（纯函数）────────────────────────────────────────────
describe("omnicode batch3 ui: maskOmnicodeAccountEmail / displayName (pure)", () => {
  it("本地部分保留前 3 字符 + *** + 域（对齐演示稿 xia***@z.ai）", () => {
    expect(maskOmnicodeAccountEmail("xiaotaoyao@z.ai")).toBe("xia***@z.ai");
    expect(maskOmnicodeAccountEmail("29999910@qq.com")).toBe("299***@qq.com");
  });
  it("本地部分不足 3 字符全保留；无 @ 的畸形输入原样返回", () => {
    expect(maskOmnicodeAccountEmail("ab@c.d")).toBe("ab***@c.d");
    expect(maskOmnicodeAccountEmail("no-at-sign")).toBe("no-at-sign");
    expect(maskOmnicodeAccountEmail("@domain-only")).toBe("@domain-only");
  });
  it("空/非字符串返回 undefined（UI 显示 ——）", () => {
    expect(maskOmnicodeAccountEmail(undefined)).toBeUndefined();
    expect(maskOmnicodeAccountEmail("")).toBeUndefined();
    expect(maskOmnicodeAccountEmail(42)).toBeUndefined();
  });
  it("展示名：displayName 优先 → profileName → profileId", () => {
    expect(resolveOmnicodeDetectionDisplayName({ displayName: "阿伟", profileName: "实例 1", profileId: "p1" })).toBe("阿伟");
    expect(resolveOmnicodeDetectionDisplayName({ profileName: "实例 1", profileId: "p1" })).toBe("实例 1");
    expect(resolveOmnicodeDetectionDisplayName({ profileName: "  ", profileId: "p1" })).toBe("p1");
  });
});

// ─── detectOmnicodeClaimableAccounts（profileRuntime mock + 真 fs/cipher）──────
describe("omnicode batch3 ui: detectOmnicodeClaimableAccounts", () => {
  let roots: string[] = [];

  beforeEach(() => {
    profileState.profiles = [];
    profileState.records = {};
  });
  afterEach(async () => {
    for (const root of roots) {
      await rm(root, { recursive: true, force: true });
    }
    roots = [];
  });

  async function makeProfile(id: string, name: string, options: { withMid: boolean; withIdentity?: boolean }) {
    const root = await mkdtemp(join(tmpdir(), `omnicode-detect-${id}-`));
    roots.push(root);
    const v2Dir = join(root, ".zcode", "v2");
    await mkdir(v2Dir, { recursive: true });
    await writeFile(join(v2Dir, "credential-secret"), SECRET, "utf8");
    const credentialsPath = join(v2Dir, "credentials.json");
    const cipher = createSystemCredentialCipher({
      filePath: credentialsPath,
      env: { ZCODE_CREDENTIAL_SECRET: SECRET },
    });
    const snapshot: Record<string, string> = {
      "oauth:active_provider": await cipher.encrypt("zai"),
      zcodejwttoken: await cipher.encrypt("jwt-detect"),
    };
    if (options.withIdentity) {
      snapshot["oauth:zai:user_info"] = await cipher.encrypt(
        JSON.stringify({ displayName: "蛋友", email: "eggfriend@example.com" }),
      );
    }
    await writeFile(credentialsPath, JSON.stringify(snapshot), "utf8");
    if (options.withMid) {
      await writeFile(
        join(v2Dir, "telemetry-state.json"),
        JSON.stringify({ deviceMid: "123e4567-e89b-12d3-a456-426614174000" }),
        "utf8",
      );
    }
    profileState.profiles.push({ id, name, createdAt: "t" });
    profileState.records[id] = { dataBaseDirOverride: root };
    return root;
  }

  function makeFakeFetch(routes: { urlPart: string; body: unknown }[]): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = input.toString();
      const route = routes.find((entry) => url.includes(entry.urlPart));
      if (!route) return new Response("{}", { status: 200 });
      return new Response(JSON.stringify(route.body), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("可领/无蛋/缺设备号/缺 JWT 按账号汇聚（邮箱脱敏出载荷）", async () => {
    await makeProfile("pa", "可领号", { withMid: true, withIdentity: true });
    await makeProfile("pb", "无蛋号", { withMid: true });
    await makeProfile("pc", "无中号", { withMid: false });
    await makeProfile("pd", "无凭据", { withMid: true });
    // pd：有 telemetry 设备号但没有 zcodejwttoken —— 需要单独构造
    const pdRecord = profileState.records["pd"];
    const pdRoot = pdRecord?.dataBaseDirOverride;
    if (pdRoot) {
      await writeFile(
        join(pdRoot, ".zcode", "v2", "credentials.json"),
        JSON.stringify({ "oauth:active_provider": "" }),
        "utf8",
      );
    }
    profileState.profiles = [
      { id: "pa", name: "可领号", createdAt: "t" },
      { id: "pb", name: "无蛋号", createdAt: "t" },
      { id: "pc", name: "无中号", createdAt: "t" },
      { id: "pd", name: "无凭据", createdAt: "t" },
    ];
    // 有状态 fetch：第一次 preview（可领号）返回蛋计划，之后（无蛋号）返回空 plans
    let previewCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/billing/preview")) {
        previewCalls += 1;
        return new Response(
          JSON.stringify(
            previewCalls === 1
              ? { code: 0, data: { plans: [{ plan_id: "egg-1", name: "赛博蛋", priority: 10, entitlements: [{ grant_units: "200" }] }] } }
              : { code: 0, data: { plans: [] } },
          ),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await detectOmnicodeClaimableAccounts({ fetchImpl, now: () => 1700000000000 });
    expect(result.detectedAt).toBe(1700000000000);
    // skipped 桶 = 资格类跳过合计（pc 缺设备号 + pd 缺 JWT），missing_jwt 同桶计数
    expect(result.summary).toMatchObject({ total: 4, claimable: 1, noClaim: 1, skipped: 2, failed: 0, unknown: 0 });
    const claimable = result.accounts.find((account) => account.profileId === "pa");
    expect(claimable).toMatchObject({
      state: "claimable",
      planId: "egg-1",
      planName: "赛博蛋",
      grantedUnits: 200,
      displayName: "蛋友",
      maskedEmail: "egg***@example.com",
    });
    expect(result.accounts.find((account) => account.profileId === "pb")).toMatchObject({ state: "no_claim" });
    expect(result.accounts.find((account) => account.profileId === "pc")).toMatchObject({
      state: "skipped_no_device_mid",
      reasonKey: "omnicode.claim.failure.no_device_mid",
    });
    expect(result.accounts.find((account) => account.profileId === "pd")).toMatchObject({
      state: "missing_jwt",
      reasonKey: "omnicode.claim.failure.no_jwt",
    });
    // 红线：检测结果载荷不含任何 token/设备号
    expect(JSON.stringify(result)).not.toContain("jwt-detect");
    expect(JSON.stringify(result)).not.toContain("123e4567");
  });

  it("preview 失败归 failed + 传输原因键（不抛穿、不影响其余账号）", async () => {
    await makeProfile("pf", "坏网络", { withMid: true });
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const result = await detectOmnicodeClaimableAccounts({ fetchImpl: failing });
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]).toMatchObject({ state: "failed", reasonKey: "omnicode.claim.failure.network" });
    expect(result.summary).toMatchObject({ total: 1, failed: 1, claimable: 0 });
  });
});

// ─── 自动领取轮询（决策纯函数 + 单 tick 编排）─────────────────────────────────
describe("omnicode batch3 ui: claim auto poll", () => {
  it("决策：开关关/无蛋/run 在跑 → idle；开+有蛋 → claim", () => {
    expect(resolveOmnicodeAutoClaimAction({ autoClaimEnabled: false, claimableCount: 3, runInFlight: false })).toBe("idle");
    expect(resolveOmnicodeAutoClaimAction({ autoClaimEnabled: true, claimableCount: 0, runInFlight: false })).toBe("idle");
    expect(resolveOmnicodeAutoClaimAction({ autoClaimEnabled: true, claimableCount: 3, runInFlight: true })).toBe("idle");
    expect(resolveOmnicodeAutoClaimAction({ autoClaimEnabled: true, claimableCount: 3, runInFlight: false })).toBe("claim");
  });

  function makeDeps(overrides: Partial<OmnicodeClaimAutoPollDeps>): OmnicodeClaimAutoPollDeps {
    return {
      readAutoClaimEnabled: async () => true,
      detect: async () => ({
        detectedAt: 0,
        summary: { total: 1, claimable: 1, noClaim: 0, skipped: 0, failed: 0, unknown: 0 },
        accounts: [],
      }),
      runClaim: async () => ({ ok: true }),
      ...overrides,
    };
  }

  it("tick：关闭态直接 idle（不触发检测——零网络请求）", async () => {
    const detect = vi.fn(async () => {
      throw new Error("should not detect");
    });
    const runClaim = vi.fn(async () => ({ ok: true }));
    const action = await runOmnicodeClaimAutoPollTick(
      makeDeps({ readAutoClaimEnabled: async () => false, detect, runClaim }),
    );
    expect(action).toBe("idle");
    expect(detect).not.toHaveBeenCalled();
    expect(runClaim).not.toHaveBeenCalled();
  });

  it("tick：开启+有蛋 → 检测后启动自动领取", async () => {
    const runClaim = vi.fn(async () => ({ ok: true }));
    const action = await runOmnicodeClaimAutoPollTick(makeDeps({ runClaim }));
    expect(action).toBe("claim");
    expect(runClaim).toHaveBeenCalledTimes(1);
  });

  it("tick：开启+无蛋 → idle（不启动领取）", async () => {
    const runClaim = vi.fn(async () => ({ ok: true }));
    const action = await runOmnicodeClaimAutoPollTick(
      makeDeps({
        detect: async () => ({
          detectedAt: 0,
          summary: { total: 1, claimable: 0, noClaim: 1, skipped: 0, failed: 0, unknown: 0 },
          accounts: [],
        }),
        runClaim,
      }),
    );
    expect(action).toBe("idle");
    expect(runClaim).not.toHaveBeenCalled();
  });

  it("tick：检测抛错静默归 idle（不抛穿，下一拍自愈）", async () => {
    const action = await runOmnicodeClaimAutoPollTick(
      makeDeps({
        detect: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(action).toBe("idle");
  });

  it("轮询周期常量 = 30min（低频日查询级别）", () => {
    expect(OMNICODE_CLAIM_AUTO_POLL_INTERVAL_MS).toBe(30 * 60 * 1000);
  });
});

// ─── 门票叠模型（纯函数）──────────────────────────────────────────────────────
describe("omnicode batch3 ui: ticket stack layout (pure)", () => {
  it("槽位序号钳制到 [0, 3]（4 个错落位，超出不新开角度）", () => {
    expect(resolveOmnicodeTicketSlotIndex(0)).toBe(0);
    expect(resolveOmnicodeTicketSlotIndex(3)).toBe(3);
    expect(resolveOmnicodeTicketSlotIndex(4)).toBe(OMNICODE_TICKET_STACK_VISIBLE_SLOTS - 1);
    expect(resolveOmnicodeTicketSlotIndex(10)).toBe(3);
    expect(resolveOmnicodeTicketSlotIndex(-1)).toBe(0);
    expect(resolveOmnicodeTicketSlotIndex(1.5)).toBe(0);
  });

  it("布局：N 张票 → N 个槽位 + ×N 角标；0 张 = 空布局（浮层不渲染）", () => {
    expect(buildOmnicodeTicketStackLayout(0)).toEqual({ slotIndexes: [], badgeCount: 0 });
    const layout4 = buildOmnicodeTicketStackLayout(4);
    expect(layout4.badgeCount).toBe(4);
    expect(layout4.slotIndexes).toEqual([0, 1, 2, 3]);
    const layout6 = buildOmnicodeTicketStackLayout(6);
    expect(layout6.badgeCount).toBe(6);
    expect(layout6.slotIndexes).toEqual([0, 1, 2, 3, 3, 3]);
    expect(buildOmnicodeTicketStackLayout(-2)).toEqual({ slotIndexes: [], badgeCount: 0 });
  });
});

// ─── 结算汇总（纯函数）────────────────────────────────────────────────────────
describe("omnicode batch3 ui: claim settlement (pure)", () => {
  const outcomes: OmnicodeClaimTicketOutcome[] = [
    { profileId: "a", outcome: "success", grantedUnits: 200 },
    { profileId: "b", outcome: "success", grantedUnits: 100 },
    { profileId: "c", outcome: "failed", reasonKey: "omnicode.claim.failure.already_claimed" },
    { profileId: "d", outcome: "skipped", reasonKey: "omnicode.claim.failure.no_jwt" },
  ];

  it("成功/失败/跳过计数 + 到账额度合计", () => {
    expect(summarizeOmnicodeClaimSettlement(outcomes)).toEqual({
      succeeded: 2,
      failed: 1,
      skipped: 1,
      grantedTotal: 300,
      aborted: false,
    });
  });

  it("成功条目全缺省 grantedUnits：合计缺省（不编造 0）", () => {
    expect(summarizeOmnicodeClaimSettlement([{ profileId: "a", outcome: "success" }])).toEqual({
      succeeded: 1,
      failed: 0,
      skipped: 0,
      aborted: false,
    });
    expect("grantedTotal" in summarizeOmnicodeClaimSettlement([{ profileId: "a", outcome: "success" }])).toBe(false);
  });

  it("aborted 透传（中断 run 结算态文案区分）", () => {
    expect(summarizeOmnicodeClaimSettlement([], { aborted: true }).aborted).toBe(true);
  });

  it("自动领取徽章：只统计今天 + mode=auto + success", () => {
    const now = new Date("2026-11-15T12:00:00").getTime();
    const today = new Date("2026-11-15T09:30:00").getTime();
    const yesterday = new Date("2026-11-14T09:30:00").getTime();
    const history: OmnicodeClaimHistoryEntry[] = [
      { at: today, profileId: "a", planId: "p1", outcome: "success", mode: "auto", grantedUnits: 200 },
      { at: today, profileId: "b", planId: "p1", outcome: "failed", mode: "auto", reasonKey: "omnicode.claim.failure.already_claimed" },
      { at: today, profileId: "c", planId: "p1", outcome: "success", mode: "manual", grantedUnits: 999 },
      { at: yesterday, profileId: "d", planId: "p1", outcome: "success", mode: "auto", grantedUnits: 500 },
    ];
    const summary = summarizeOmnicodeAutoSettlementFromHistory(history, now);
    expect(summary).toEqual({ succeededCount: 1, grantedTotal: 200 });
  });

  it("自动领取徽章：无今日 auto 成功条目 → null（不渲染徽章）", () => {
    const now = new Date("2026-11-15T12:00:00").getTime();
    expect(summarizeOmnicodeAutoSettlementFromHistory(undefined, now)).toBeNull();
    expect(summarizeOmnicodeAutoSettlementFromHistory([], now)).toBeNull();
    expect(
      summarizeOmnicodeAutoSettlementFromHistory(
        [{ at: now - 1000, profileId: "a", planId: "p", outcome: "failed", mode: "auto" }],
        now,
      ),
    ).toBeNull();
  });
});

// ─── 看板汇总条健康分档计数（纯函数）──────────────────────────────────────────
describe("omnicode batch3 ui: login health counts (pure)", () => {
  it("按 X2 四态分档计数；loginHealth 缺失/损坏归 unknown", () => {
    expect(
      resolveOmnicodeLoginHealthCounts([
        { loginHealth: { status: "healthy", daysRemaining: 30 } },
        { loginHealth: { status: "healthy", daysRemaining: 10 } },
        { loginHealth: { status: "expiring", daysRemaining: 3 } },
        { loginHealth: { status: "expired" } },
        {},
        { loginHealth: undefined },
        { loginHealth: { status: "unknown" } },
      ]),
    ).toEqual({ healthy: 2, expiring: 1, expired: 1, unknown: 3 });
  });

  it("空列表全 0", () => {
    expect(resolveOmnicodeLoginHealthCounts([])).toEqual({
      healthy: 0,
      expiring: 0,
      expired: 0,
      unknown: 0,
    });
  });
});
