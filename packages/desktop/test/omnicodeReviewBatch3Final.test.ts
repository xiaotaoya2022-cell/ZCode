// [OmniCode] 批次3 终审修复单测（评审: F:\OmniCode\docs\batch3\research\review-batch3-final.md）：
// - P1-1 dockedByProfileId 持久化：merge 白名单归一 + 落盘→读档往返 + 三条 console-ui
//   写路径（UiStateSet/预览开关/claimHistory）不清空覆盖表回归；
// - P1-2 embedLayout 下发矩形四边内缩数学（含退化矩形与"内缩后仍 ≥160×96"契约）；
// - P2-① ClaimRun 响应携带 total（HUD 总数不再依赖 started 事件时序）；
// - P2-③ 看板快照 main 侧邮箱脱敏（raw 邮箱不进载荷）；
// - P2-④ 单卡刷新 main 侧 in-flight 去重（并发 force 复用同一拉取，不破坏逐账号串行）；
// 写法参照 omnicodeBatch3DashboardUi.test.ts / omnicodeBatch3AccountData.test.ts
// （profileRuntime mock + 真 fs/cipher + 假 fetch）。
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSystemCredentialCipher } from "@zcode/shared/credential-security";
import {
  OMNICODE_EMBED_MIN_HEIGHT,
  OMNICODE_EMBED_MIN_WIDTH,
} from "@zcode/shared";
import {
  DEFAULT_OMNICODE_CONSOLE_UI_STATE,
  loadOmnicodeConsoleUiStateMigrating,
  mergeOmnicodeConsoleUiState,
  normalizeOmnicodeDockOverrides,
  writeOmnicodeConsoleUiState,
} from "../src/main/omnicode/consoleUiState.js";
import {
  clampOmnicodeScreenRectToEmbedMinimum,
  insetOmnicodeEmbedRectForResizeHandles,
  OMNICODE_EMBED_RESIZE_HANDLE_INSET_PX,
} from "../src/main/omnicode/embedLayoutMath.js";
import {
  assembleOmnicodeAccountDashboardEntry,
  getOmnicodeAccountDashboardSnapshot,
  resetOmnicodeAccountDashboardCacheForTest,
  type OmnicodeBalanceAttempt,
} from "../src/main/omnicode/accountDashboard.js";
import {
  persistOmnicodeClaimHistory,
  resetOmnicodeClaimRunnerForTest,
  startOmnicodeAccountClaimRun,
} from "../src/main/omnicode/claimRunner.js";
import { createSettingsPageConfig } from "@/settings/settingsPageConfig.js";

// ─── mocks：profileRuntime（列表/记录/数据根注入；getOmnicodeConsoleDataBaseDir 保留
// 真实 env 语义供 console-ui.json 落盘到测试临时目录）───────────────────────────────
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
const VALID_PID_A = "paaaaaaaaaaaaaaaaaaaa";
const VALID_PID_B = "pbbbbbbbbbbbbbbbbbbbb";

// ─── P1-1：dockedByProfileId 归一（纯函数）──────────────────────────────────────
describe("omnicode review batch3 final: dockedByProfileId merge (P1-1, pure)", () => {
  it("merge 显式携带 dockedByProfileId：合法记录整体替换进状态", () => {
    expect(
      mergeOmnicodeConsoleUiState(DEFAULT_OMNICODE_CONSOLE_UI_STATE, {
        dockedByProfileId: { [VALID_PID_A]: false, [VALID_PID_B]: true },
      }),
    ).toEqual({
      dockDefault: true,
      dockedByProfileId: { [VALID_PID_A]: false, [VALID_PID_B]: true },
      previewEnabled: true,
    });
    // undefined = 不变（与 claimHistory 同语义）
    expect(
      mergeOmnicodeConsoleUiState(
        { ...DEFAULT_OMNICODE_CONSOLE_UI_STATE, dockedByProfileId: { [VALID_PID_A]: false } },
        { previewEnabled: false },
      ),
    ).toEqual({
      dockDefault: true,
      dockedByProfileId: { [VALID_PID_A]: false },
      previewEnabled: false,
    });
  });

  it("merge 逐键校验：非 profileId 形态键/非布尔值丢弃归一；空对象=清空覆盖表", () => {
    const merged = mergeOmnicodeConsoleUiState(
      { ...DEFAULT_OMNICODE_CONSOLE_UI_STATE, dockedByProfileId: { [VALID_PID_A]: false } },
      {
        dockedByProfileId: {
          [VALID_PID_B]: true, // 合法键
          "not-a-pid": false, // 非 profileId 形态 → 丢弃
          short: true, // 过短 → 丢弃
          [VALID_PID_A]: 1 as never, // 非布尔值 → 丢弃
        },
      },
    );
    expect(merged.dockedByProfileId).toEqual({ [VALID_PID_B]: true });
    // 空对象 = 清空覆盖表（全部跟随 dockDefault）
    const cleared = mergeOmnicodeConsoleUiState(
      { ...DEFAULT_OMNICODE_CONSOLE_UI_STATE, dockedByProfileId: { [VALID_PID_A]: false } },
      { dockedByProfileId: {} },
    );
    expect(cleared.dockedByProfileId).toEqual({});
  });

  it("normalizeOmnicodeDockOverrides：非 Record 形态（数组/原始值）归一为空表", () => {
    expect(normalizeOmnicodeDockOverrides([["p1111111111", true]])).toEqual({});
    expect(normalizeOmnicodeDockOverrides(null)).toEqual({});
    expect(normalizeOmnicodeDockOverrides("junk")).toEqual({});
    expect(normalizeOmnicodeDockOverrides(42)).toEqual({});
    expect(normalizeOmnicodeDockOverrides({ [VALID_PID_A]: true })).toEqual({ [VALID_PID_A]: true });
  });

  it("dockAll 仍清空覆盖表（P1-1 修复不改变批量语义）", () => {
    expect(
      mergeOmnicodeConsoleUiState(
        { dockDefault: true, dockedByProfileId: { [VALID_PID_A]: false }, previewEnabled: true },
        { dockAll: false },
      ).dockedByProfileId,
    ).toEqual({});
  });
});

// ─── P1-1：落盘→读档往返 + 写路径回归（真 fs，ZCODE_DATA_BASE_DIR 指向临时目录）──
describe("omnicode review batch3 final: console-ui round-trip (P1-1, fs)", () => {
  let consoleRoot: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    consoleRoot = await mkdtemp(join(tmpdir(), "omnicode-console-ui-"));
    originalDataDir = process.env.ZCODE_DATA_BASE_DIR;
    process.env.ZCODE_DATA_BASE_DIR = consoleRoot;
    resetOmnicodeClaimRunnerForTest();
  });
  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.ZCODE_DATA_BASE_DIR;
    else process.env.ZCODE_DATA_BASE_DIR = originalDataDir;
    resetOmnicodeClaimRunnerForTest();
    await rm(consoleRoot, { recursive: true, force: true });
  });

  it("往返：写 dockInstance 覆盖 → loadOmnicodeConsoleUiStateMigrating 读回覆盖保留", async () => {
    // 模拟 UiStateSet(dockInstance) 的完整写路径：读 → merge → 写
    const current = await loadOmnicodeConsoleUiStateMigrating();
    const merged = mergeOmnicodeConsoleUiState(current.state, {
      dockInstance: { profileId: VALID_PID_A, docked: false },
    });
    await writeOmnicodeConsoleUiState(merged);
    // 读档（进程重启语义）：覆盖表存活，被拖出实例不再跑回停靠
    const reloaded = await loadOmnicodeConsoleUiStateMigrating();
    expect(reloaded.state.dockedByProfileId).toEqual({ [VALID_PID_A]: false });
    expect(reloaded.migratedFromLegacyMode).toBe(false);
  });

  it("回归：UiStateSet(previewEnabled)/claimHistory 落盘均不清空覆盖表", async () => {
    // 预置覆盖表落盘
    await writeOmnicodeConsoleUiState({
      ...DEFAULT_OMNICODE_CONSOLE_UI_STATE,
      dockedByProfileId: { [VALID_PID_A]: false, [VALID_PID_B]: true },
    });
    // 写路径 1：UiStateSet(previewEnabled)（desktopProfileIpc 预览开关路径）
    const afterPreview = mergeOmnicodeConsoleUiState(
      await loadOmnicodeConsoleUiStateMigrating().then((r) => r.state),
      { previewEnabled: false },
    );
    await writeOmnicodeConsoleUiState(afterPreview);
    expect((await loadOmnicodeConsoleUiStateMigrating()).state.dockedByProfileId).toEqual({
      [VALID_PID_A]: false,
      [VALID_PID_B]: true,
    });
    // 写路径 2：claimHistory 领取落盘（claimRunner.persistOmnicodeClaimHistory——读→追加→写）
    await persistOmnicodeClaimHistory([
      { at: 1, profileId: VALID_PID_A, planId: "egg", outcome: "success", mode: "auto", grantedUnits: 1 },
    ]);
    const persisted = JSON.parse(
      await readFile(join(consoleRoot, "console-ui.json"), "utf8"),
    ) as { dockedByProfileId?: Record<string, boolean>; claimHistory?: unknown[] };
    expect(persisted.dockedByProfileId).toEqual({ [VALID_PID_A]: false, [VALID_PID_B]: true });
    expect(persisted.claimHistory).toHaveLength(1);
  });

  it("损坏档防御：磁盘覆盖表携带非法键/非布尔值 → 读档归一剔除", async () => {
    await writeFile(
      join(consoleRoot, "console-ui.json"),
      JSON.stringify({
        dockDefault: true,
        dockedByProfileId: {
          [VALID_PID_A]: false, // 合法
          "bad-key": true, // 非 profileId 形态 → 剔除
          [VALID_PID_B]: "yes", // 非布尔 → 剔除
        },
        previewEnabled: true,
      }),
      "utf8",
    );
    const reloaded = await loadOmnicodeConsoleUiStateMigrating();
    expect(reloaded.state.dockedByProfileId).toEqual({ [VALID_PID_A]: false });
  });
});

// ─── P1-2：embedLayout 下发矩形四边内缩（纯函数）───────────────────────────────
describe("omnicode review batch3 final: embed inset math (P1-2, pure)", () => {
  it("四边各内缩 6px（x/y +6，w/h -12）；自定义 inset 同理", () => {
    expect(insetOmnicodeEmbedRectForResizeHandles({ x: 100, y: 200, width: 640, height: 400 })).toEqual({
      x: 106,
      y: 206,
      width: 628,
      height: 388,
    });
    expect(insetOmnicodeEmbedRectForResizeHandles({ x: 0, y: 0, width: 200, height: 120 }, 10)).toEqual({
      x: 10,
      y: 10,
      width: 180,
      height: 100,
    });
    expect(OMNICODE_EMBED_RESIZE_HANDLE_INSET_PX).toBe(6);
  });

  it("退化矩形（w/h ≤ 2×inset）原样返回；非有限值透传", () => {
    // 12×12（=2×inset）内缩后为 0 尺寸 → 原样
    expect(insetOmnicodeEmbedRectForResizeHandles({ x: 0, y: 0, width: 12, height: 12 })).toEqual({
      x: 0,
      y: 0,
      width: 12,
      height: 12,
    });
    expect(insetOmnicodeEmbedRectForResizeHandles({ x: 0, y: 0, width: 10, height: 400 })).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 400,
    });
    const nonFinite = { x: Number.NaN, y: 0, width: 640, height: 400 };
    expect(insetOmnicodeEmbedRectForResizeHandles(nonFinite)).toBe(nonFinite);
  });

  it("契约：下限矩形内缩后再钳制仍 ≥160×96（实例侧独立校验逻辑不变、必过）", () => {
    // 卡片画面区恰为内嵌最低规格时：内缩 12px 会低于下限 → 再钳制回 160×96
    const minRect = clampOmnicodeScreenRectToEmbedMinimum({ x: 50, y: 60, width: 160, height: 96 });
    const inset = insetOmnicodeEmbedRectForResizeHandles(minRect);
    const finalRect = clampOmnicodeScreenRectToEmbedMinimum(inset);
    expect(finalRect.width).toBeGreaterThanOrEqual(OMNICODE_EMBED_MIN_WIDTH);
    expect(finalRect.height).toBeGreaterThanOrEqual(OMNICODE_EMBED_MIN_HEIGHT);
    // 正常尺寸（640×400）内缩后仍高于下限，钳制原样透传
    const normal = clampOmnicodeScreenRectToEmbedMinimum(insetOmnicodeEmbedRectForResizeHandles({ x: 0, y: 0, width: 640, height: 400 }));
    expect(normal).toEqual({ x: 6, y: 6, width: 628, height: 388 });
  });
});

// ─── P2-③：看板快照 main 侧邮箱脱敏（纯函数装配）──────────────────────────────
describe("omnicode review batch3 final: dashboard identity email masking (P2-③, pure)", () => {
  const accountData = {
    identity: {
      displayName: "蛋友",
      email: "eggfriend@example.com",
      avatarUrl: "https://a/av.png",
      customerNumber: "CN123",
    },
    session: { hasJwtToken: true, activeProvider: "zai" },
  } as Parameters<typeof assembleOmnicodeAccountDashboardEntry>[0]["accountData"];

  it("装配时邮箱统一脱敏（与检测链同口径）：raw 邮箱不进载荷", () => {
    const entry = assembleOmnicodeAccountDashboardEntry({
      profileId: "pa",
      profileName: "A",
      accountData,
      balanceAttempt: { state: "ok", fetchedAt: 1 } satisfies OmnicodeBalanceAttempt,
    });
    expect(entry.identity?.email).toBe("egg***@example.com");
    // 红线保持：载荷不含 raw 邮箱；其余展示字段原样
    const payload = JSON.stringify(entry);
    expect(payload).not.toContain("eggfriend@example.com");
    expect(payload).toContain("egg***@example.com");
    expect(entry.identity).toMatchObject({
      displayName: "蛋友",
      avatarUrl: "https://a/av.png",
      customerNumber: "CN123",
    });
  });

  it("无邮箱 identity：email 键不出现（不写 undefined）；空 identity 不装配", () => {
    const noEmail = assembleOmnicodeAccountDashboardEntry({
      profileId: "pa",
      profileName: "A",
      accountData: { identity: { displayName: "无名" } } as Parameters<
        typeof assembleOmnicodeAccountDashboardEntry
      >[0]["accountData"],
    });
    expect("email" in (noEmail.identity ?? {})).toBe(false);
    expect(noEmail.identity?.displayName).toBe("无名");
    // identityFallback 兜底路径同样脱敏
    const viaFallback = assembleOmnicodeAccountDashboardEntry({
      profileId: "pa",
      profileName: "A",
      accountData: {} as Parameters<typeof assembleOmnicodeAccountDashboardEntry>[0]["accountData"],
      identityFallback: { email: "fallback@example.com" },
    });
    expect(viaFallback.identity?.email).toBe("fal***@example.com");
    expect(JSON.stringify(viaFallback)).not.toContain("fallback@example.com");
  });
});

// ─── P2-④：单卡刷新 main 侧 in-flight 去重（真 fs + 慢假 fetch）───────────────
describe("omnicode review batch3 final: dashboard snapshot in-flight dedup (P2-④)", () => {
  let roots: string[] = [];
  let consoleRoot: string;

  beforeEach(async () => {
    consoleRoot = await mkdtemp(join(tmpdir(), "omnicode-dash-dedup-"));
    roots = [];
    resetOmnicodeAccountDashboardCacheForTest();
    profileState.profiles = [];
    profileState.records = {};
  });
  afterEach(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
    await rm(consoleRoot, { recursive: true, force: true });
    resetOmnicodeAccountDashboardCacheForTest();
  });

  async function makeGoProfile(id: string, name: string): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), `omnicode-dedup-${id}-`));
    roots.push(root);
    const v2Dir = join(root, ".zcode", "v2");
    await mkdir(v2Dir, { recursive: true });
    await writeFile(join(v2Dir, "credential-secret"), SECRET, "utf8");
    const credentialsPath = join(v2Dir, "credentials.json");
    const cipher = createSystemCredentialCipher({
      filePath: credentialsPath,
      env: { ZCODE_CREDENTIAL_SECRET: SECRET },
    });
    await writeFile(
      credentialsPath,
      JSON.stringify({
        "oauth:active_provider": await cipher.encrypt("zai"),
        zcodejwttoken: await cipher.encrypt("jwt-dedup"),
      }),
      "utf8",
    );
    await writeFile(
      join(v2Dir, "telemetry-state.json"),
      JSON.stringify({ deviceMid: "123e4567-e89b-12d3-a456-426614174000" }),
      "utf8",
    );
    profileState.profiles.push({ id, name, createdAt: "t" });
    profileState.records[id] = { dataBaseDirOverride: root };
  }

  function makeCountingBalanceFetch(counter: { balanceCalls: number }): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/billing/balance")) {
        counter.balanceCalls += 1;
        return new Response(
          JSON.stringify({ code: 0, data: { balances: [{ show_name: "GLM", remaining_units: 10 }] } }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("并发 force（单卡双击交错）→ 同账号 balance 请求只发一次（复用进行中拉取）", async () => {
    await makeGoProfile("pa", "A");
    const counter = { balanceCalls: 0 };
    const fetchImpl = makeCountingBalanceFetch(counter);
    // 双击：两个 force 并发进入（此时无缓存命中，in-flight 检查在首个 await 前同步完成）
    // → 第二次调用直接复用第一次的进行中 Promise → 同账号 balance 只发一次
    const first = getOmnicodeAccountDashboardSnapshot({ force: true, fetchImpl });
    const second = getOmnicodeAccountDashboardSnapshot({ force: true, fetchImpl });
    const [f1, f2] = await Promise.all([first, second]);
    expect(counter.balanceCalls).toBe(1);
    expect(f1.accounts).toHaveLength(1);
    expect(f2.accounts).toHaveLength(1);
    // 拉取结束后 in-flight 清空：下一次 force 重新走完整编排（不被旧 Promise 复用）
    const third = await getOmnicodeAccountDashboardSnapshot({ force: true, fetchImpl });
    expect(counter.balanceCalls).toBe(2);
    expect(third.accounts).toHaveLength(1);
  });

  it("进行中拉取期间 TTL 请求（非 force）同样复用（不破坏逐账号串行口径）", async () => {
    await makeGoProfile("pb", "B");
    const counter = { balanceCalls: 0 };
    const fetchImpl = makeCountingBalanceFetch(counter);
    const inFlight = getOmnicodeAccountDashboardSnapshot({ force: true, fetchImpl });
    // 缓存尚未写入（拉取进行中）→ TTL 请求在 in-flight 检查处复用同一 Promise
    const ttlHit = await getOmnicodeAccountDashboardSnapshot({ fetchImpl });
    expect(ttlHit.fromCache).toBe(false);
    await inFlight;
    expect(counter.balanceCalls).toBe(1);
  });
});

// ─── P2-②：settingsPageConfig omnicode 分区门控（纯函数）──────────────────────
describe("omnicode review batch3 final: settings omnicode section gating (P2-②, pure)", () => {
  const sectionIds = (options: Parameters<typeof createSettingsPageConfig>[0]) =>
    createSettingsPageConfig(options).settingsSections.map((section) => section.id);

  it("官方 desktop flavor（无管理器语境）不出现 omnicodeProfiles/omnicodeAutomation", () => {
    const ids = sectionIds({ isDesktop: true });
    expect(ids).not.toContain("omnicodeProfiles");
    expect(ids).not.toContain("omnicodeAutomation");
    // 官方常规分区不受影响
    expect(ids).toContain("general");
    expect(ids).toContain("appearance");
  });

  it("管理器语境（omnicode flavor ∧ 非实例窗口）保留两个 omnicode 分区", () => {
    const ids = sectionIds({ isDesktop: true, omnicodeManager: true });
    expect(ids).toContain("omnicodeProfiles");
    expect(ids).toContain("omnicodeAutomation");
  });

  it("非桌面环境两个分区同样不可见（既有 desktop-only 门控保持）", () => {
    const ids = sectionIds({ isDesktop: false, omnicodeManager: true });
    expect(ids).not.toContain("omnicodeProfiles");
    expect(ids).not.toContain("omnicodeAutomation");
  });
});

// ─── P2-①：ClaimRun 响应携带 total（main 侧返回形态锁定）──────────────────────
describe("omnicode review batch3 final: claim run result total (P2-①)", () => {
  let consoleRoot: string;
  let originalDataDir: string | undefined;
  let roots: string[] = [];

  beforeEach(async () => {
    consoleRoot = await mkdtemp(join(tmpdir(), "omnicode-claim-total-"));
    originalDataDir = process.env.ZCODE_DATA_BASE_DIR;
    process.env.ZCODE_DATA_BASE_DIR = consoleRoot;
    resetOmnicodeClaimRunnerForTest();
    profileState.profiles = [];
    profileState.records = {};
    roots = [];
  });
  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.ZCODE_DATA_BASE_DIR;
    else process.env.ZCODE_DATA_BASE_DIR = originalDataDir;
    resetOmnicodeClaimRunnerForTest();
    for (const root of roots) await rm(root, { recursive: true, force: true });
    await rm(consoleRoot, { recursive: true, force: true });
  });

  async function makeGoProfile(id: string, options: { withMid: boolean }): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), `omnicode-total-${id}-`));
    roots.push(root);
    const v2Dir = join(root, ".zcode", "v2");
    await mkdir(v2Dir, { recursive: true });
    await writeFile(join(v2Dir, "credential-secret"), SECRET, "utf8");
    const credentialsPath = join(v2Dir, "credentials.json");
    const cipher = createSystemCredentialCipher({
      filePath: credentialsPath,
      env: { ZCODE_CREDENTIAL_SECRET: SECRET },
    });
    await writeFile(
      credentialsPath,
      JSON.stringify({ zcodejwttoken: await cipher.encrypt("jwt-total") }),
      "utf8",
    );
    if (options.withMid) {
      await writeFile(
        join(v2Dir, "telemetry-state.json"),
        JSON.stringify({ deviceMid: "123e4567-e89b-12d3-a456-426614174000" }),
        "utf8",
      );
    }
    profileState.profiles.push({ id, name: id.toUpperCase(), createdAt: "t" });
    profileState.records[id] = { dataBaseDirOverride: root };
  }

  it("ok=true 响应携带 total = jobs + skipped（renderer 直接取值初始化 HUD）", async () => {
    // pa 可领（→job）+ pb 有 JWT 无设备号（→skipped_no_device_mid）：total=2
    await makeGoProfile("pa", { withMid: true });
    await makeGoProfile("pb", { withMid: false });
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/billing/preview")) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: { plans: [{ plan_id: "egg-1", name: "赛博蛋", priority: 10 }] },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/billing/claim")) {
        return new Response(
          JSON.stringify({ code: 0, data: { plan: { plan_id: "egg-1", entitlements: [{ grant_units: 5 }] } } }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const events: string[] = [];
    const started = await startOmnicodeAccountClaimRun({
      mode: "manual",
      broadcast: (payload) => {
        events.push(payload.type);
      },
      fetchImpl,
      sleep: async () => undefined,
      random: () => 0,
    });
    // P2-① 契约：total 在 invoke resolve 时即可得（started 事件广播在 resolve 之前，
    // renderer 此前收不到 manual runId 判定 → runTotal 恒 0；现改为直接取响应 total）
    expect(started.ok).toBe(true);
    expect(started).toMatchObject({ ok: true, total: 2 });
    expect(typeof (started as { runId?: string }).runId).toBe("string");
    // 排空后台 run（事件序列到 done 即回收，避免悬挂 promise 泄漏到下一用例）
    await vi.waitFor(() => expect(events).toContain("done"));
  });
});
