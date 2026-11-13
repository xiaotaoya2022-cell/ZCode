// [OmniCode] 批次2.5 X1-X4 单测：性能采样决策与降级状态机（perfMonitor）/ renderer 侧
// 环形缓冲与 spark 路径（perfSpark）/ 登录态健康度分级与凭据快照读取（loginHealth）/
// 托盘菜单模型与去抖重建（trayMenu）。spec: docs/omnicode/console-extras.md。
// 写法参照 omnicodeBatch2ConsoleViewport.test.ts（纯函数）与 omnicodeReviewBridge.test.ts
// （electron/本地模块 mock）。
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MenuItemConstructorOptions } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformChannels, type OmnicodePerfEventPayload } from "@zcode/shared";
import {
  createLegacyCredentialCipher,
  createSystemCredentialCipher,
} from "@zcode/shared/credential-security";

// ─── mocks：让依赖 electron / 子进程 / 托盘的 main 侧模块可在 node 测试进程导入执行 ───

interface FakeWindow {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: unknown): void };
}

const electronState = vi.hoisted(() => ({ windows: [] as unknown[] }));
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => electronState.windows } }));

const managerState = vi.hoisted(() => ({
  running: [] as { profileId: string; pid: number; startedAt: string }[],
  listener: null as null | (() => void),
}));
vi.mock("../src/main/omnicode/instanceManager.js", () => ({
  listOmnicodeRunningInstances: () => managerState.running.map((entry) => ({ ...entry })),
  subscribeOmnicodeRunningStateChanges: (listener: () => void) => {
    managerState.listener = listener;
    return () => {
      if (managerState.listener === listener) managerState.listener = null;
    };
  },
  launchAllOmnicodeProfiles: async () => ({ launched: 0, failed: 0 }),
  stopAllOmnicodeInstances: async () => ({ stopped: 0, failed: 0 }),
}));

const reconcileState = vi.hoisted(() => ({
  memoryByPid: undefined as Map<number, number> | undefined,
  spawnCalls: 0,
}));
vi.mock("../src/main/omnicode/instanceReconcile.js", () => ({
  readOmnicodeProcessMemoryMBs: async () => {
    reconcileState.spawnCalls += 1;
    return reconcileState.memoryByPid;
  },
}));

const trayState = vi.hoisted(() => ({ rebuilds: 0 }));
vi.mock("../src/main/desktopTray.js", () => ({
  updateWindowsDesktopTrayMenu: () => {
    trayState.rebuilds += 1;
  },
}));

const bridgeState = vi.hoisted(() => ({
  broadcasts: [] as { profileId: string; type: string }[],
  commands: [] as { profileId: string; command: unknown }[],
}));
vi.mock("../src/main/omnicode/instanceBridgeServer.js", () => ({
  broadcastOmnicodeInstanceEvent: (payload: { profileId: string; type: string }) => {
    bridgeState.broadcasts.push(payload);
  },
  sendOmnicodeInstanceCommand: (profileId: string, command: unknown) => {
    bridgeState.commands.push({ profileId, command });
  },
}));

const profileState = vi.hoisted(() => ({
  profiles: [] as { id: string; name: string }[],
  records: {} as Record<string, { dataBaseDirOverride?: string } | undefined>,
  dirs: {} as Record<string, string>,
}));
vi.mock("../src/main/omnicode/profileRuntime.js", () => ({
  listOmnicodeProfiles: async () => profileState.profiles,
  getOmnicodeProfileRecord: async (id: string) => profileState.records[id],
  getOmnicodeProfileDir: (id: string) => profileState.dirs[id] ?? `/virtual/omnicode/${id}`,
}));

import {
  applyOmnicodePerfPanelState,
  PERF_DEGRADE_FAILURE_THRESHOLD,
  PERF_SAMPLE_INTERVAL_MS,
  resolveOmnicodePerfTickAction,
  shutdownOmnicodePerfSampler,
} from "../src/main/omnicode/perfMonitor.js";
import {
  buildOmnicodeTrayMenuSection,
  buildOmnicodeTraySectionModel,
  setupOmnicodeConsoleTray,
} from "../src/main/omnicode/trayMenu.js";
import {
  OMNICODE_LOGIN_EXPIRING_THRESHOLD_DAYS,
  readOmnicodeLoginHealthFromDataRoot,
  readOmnicodeLoginHealths,
  resolveOmnicodeLoginHealth,
} from "../src/main/omnicode/loginHealth.js";
import {
  buildOmnicodeSparklinePoints,
  formatOmnicodeMemoryMB,
  OMNICODE_PERF_SERIES_CAPACITY,
  pushOmnicodePerfSample,
} from "../../ui/src/console/perfSpark.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// ═══ X1：perfMonitor（采样决策 + 降级状态机） ═══

function createFakeWindow(): FakeWindow & { sent: { channel: string; payload: unknown }[] } {
  const sent: { channel: string; payload: unknown }[] = [];
  return {
    sent,
    isDestroyed: () => false,
    webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
  };
}

function resetPerfMocks(options: {
  windows: ReturnType<typeof createFakeWindow>[];
  running: { profileId: string; pid: number }[];
  memoryByPid?: Map<number, number>;
}): void {
  electronState.windows = options.windows;
  managerState.running = options.running.map((entry) => ({
    ...entry,
    startedAt: "2026-01-01T00:00:00.000Z",
  }));
  reconcileState.memoryByPid = options.memoryByPid;
  reconcileState.spawnCalls = 0;
}

function perfEvents(win: ReturnType<typeof createFakeWindow>): OmnicodePerfEventPayload[] {
  return win.sent
    .filter((entry) => entry.channel === PlatformChannels.OmnicodePerfEvent)
    .map((entry) => entry.payload as OmnicodePerfEventPayload);
}

describe("omnicode batch2.5 X1: perfMonitor tick decision (pure)", () => {
  it("resolveOmnicodePerfTickAction：五分支全锁（stop/degrade-platform/degrade-probe/empty/sample）", () => {
    // 面板关：无论其余输入一律 stop（优先级最高）
    expect(
      resolveOmnicodePerfTickAction({ enabled: false, platform: "win32", runningCount: 3, consecutiveFailures: 9 }),
    ).toBe("stop");
    // 非 win32：即刻平台降级（先于失败阈值判定）
    expect(
      resolveOmnicodePerfTickAction({ enabled: true, platform: "linux", runningCount: 3, consecutiveFailures: 0 }),
    ).toBe("degrade-platform");
    expect(
      resolveOmnicodePerfTickAction({ enabled: true, platform: "darwin", runningCount: 1, consecutiveFailures: 5 }),
    ).toBe("degrade-platform");
    // 连续失败达阈值：probe 降级
    expect(
      resolveOmnicodePerfTickAction({
        enabled: true,
        platform: "win32",
        runningCount: 2,
        consecutiveFailures: PERF_DEGRADE_FAILURE_THRESHOLD,
      }),
    ).toBe("degrade-probe");
    // 阈值-1：仍继续采样（失败计 1 次不降级）
    expect(
      resolveOmnicodePerfTickAction({
        enabled: true,
        platform: "win32",
        runningCount: 2,
        consecutiveFailures: PERF_DEGRADE_FAILURE_THRESHOLD - 1,
      }),
    ).toBe("sample");
    // 零运行实例：广播空 samples（empty），不 spawn
    expect(
      resolveOmnicodePerfTickAction({ enabled: true, platform: "win32", runningCount: 0, consecutiveFailures: 0 }),
    ).toBe("empty");
    // 常态：采样
    expect(
      resolveOmnicodePerfTickAction({ enabled: true, platform: "win32", runningCount: 1, consecutiveFailures: 0 }),
    ).toBe("sample");
  });

  it("阈值常量与 spec 一致：5s 采样、2 次失败降级", () => {
    expect(PERF_SAMPLE_INTERVAL_MS).toBe(5_000);
    expect(PERF_DEGRADE_FAILURE_THRESHOLD).toBe(2);
  });
});

describe("omnicode batch2.5 X1: perfMonitor sampler state machine", () => {
  beforeEach(() => {
    shutdownOmnicodePerfSampler();
  });
  afterEach(() => {
    shutdownOmnicodePerfSampler();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("采样链路：enable 立即采一轮 → 5s 周期 → pid 消失跳过不编造 → disable 停采", async () => {
    vi.useFakeTimers();
    const win = createFakeWindow();
    resetPerfMocks({
      windows: [win],
      running: [
        { profileId: "pa111111111", pid: 111 },
        { profileId: "pb111111222", pid: 222 },
      ],
      memoryByPid: new Map([
        [111, 250.5],
        [222, 300],
      ]),
    });
    applyOmnicodePerfPanelState(true);
    await vi.advanceTimersByTimeAsync(0); // enable 立即采一轮
    let events = perfEvents(win);
    expect(events).toHaveLength(1);
    const first = events[0];
    expect(first.type).toBe("sample");
    if (first.type === "sample") {
      expect(first.samples).toEqual([
        { profileId: "pa111111111", memoryMB: 250.5 },
        { profileId: "pb111111222", memoryMB: 300 },
      ]);
    }

    // 第二轮：pb 的 pid 在查询窗口内退出 → 本轮只广播 pa（不编造部分值）
    reconcileState.memoryByPid = new Map([[111, 251]]);
    await vi.advanceTimersByTimeAsync(PERF_SAMPLE_INTERVAL_MS);
    events = perfEvents(win);
    expect(events).toHaveLength(2);
    const second = events[1];
    expect(second.type).toBe("sample");
    if (second.type === "sample") {
      expect(second.samples).toEqual([{ profileId: "pa111111111", memoryMB: 251 }]);
    }

    // 关面板：停采（此后 4 个周期无新事件、无新 spawn）
    applyOmnicodePerfPanelState(false);
    await vi.advanceTimersByTimeAsync(PERF_SAMPLE_INTERVAL_MS * 4);
    expect(perfEvents(win)).toHaveLength(2);
    expect(reconcileState.spawnCalls).toBe(2);
  });

  it("零运行实例：广播空 samples 且不 spawn tasklist", async () => {
    vi.useFakeTimers();
    const win = createFakeWindow();
    resetPerfMocks({ windows: [win], running: [] });
    applyOmnicodePerfPanelState(true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PERF_SAMPLE_INTERVAL_MS);
    const events = perfEvents(win);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.type).toBe("sample");
      if (event.type === "sample") expect(event.samples).toEqual([]);
    }
    expect(reconcileState.spawnCalls).toBe(0);
  });

  it("probe 降级：连续 2 次失败 → unavailable(probe) 停采；重新 enable 重置失败计数", async () => {
    vi.useFakeTimers();
    const win = createFakeWindow();
    resetPerfMocks({
      windows: [win],
      running: [{ profileId: "pa111111111", pid: 111 }],
      memoryByPid: undefined, // tasklist 查询失败
    });
    applyOmnicodePerfPanelState(true);
    await vi.advanceTimersByTimeAsync(0); // 第 1 次失败：计数 1，继续调度
    expect(perfEvents(win)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(PERF_SAMPLE_INTERVAL_MS); // 第 2 次失败 → 降级
    const degraded = perfEvents(win);
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toEqual({ type: "unavailable", reason: "probe" });
    // 停采：不再有事件、不再 spawn
    const spawnAtDegrade = reconcileState.spawnCalls;
    await vi.advanceTimersByTimeAsync(PERF_SAMPLE_INTERVAL_MS * 3);
    expect(perfEvents(win)).toHaveLength(1);
    expect(reconcileState.spawnCalls).toBe(spawnAtDegrade);
    // 重新 enable：重置失败计数并立即采一轮（降级后的显式重试出口）
    reconcileState.memoryByPid = new Map([[111, 260]]);
    applyOmnicodePerfPanelState(true);
    await vi.advanceTimersByTimeAsync(0);
    const recovered = perfEvents(win);
    expect(recovered).toHaveLength(2);
    expect(recovered[1].type).toBe("sample");
  });

  it("platform 降级：非 win32 即刻 unavailable(platform)，不 spawn", async () => {
    vi.useFakeTimers();
    // process.platform 为非函数数据属性（configurable），vi.spyOn 不适用——defineProperty 直换
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const win = createFakeWindow();
      resetPerfMocks({
        windows: [win],
        running: [{ profileId: "pa111111111", pid: 111 }],
        memoryByPid: new Map([[111, 200]]),
      });
      applyOmnicodePerfPanelState(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(perfEvents(win)).toEqual([{ type: "unavailable", reason: "platform" }]);
      expect(reconcileState.spawnCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(PERF_SAMPLE_INTERVAL_MS * 2);
      expect(perfEvents(win)).toHaveLength(1);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });
});

// ═══ X1：perfSpark（renderer 侧环形缓冲 + spark 路径，纯函数） ═══

describe("omnicode batch2.5 X1: perfSpark ring buffer + sparkline", () => {
  it("pushOmnicodePerfSample：容量满丢最旧点（环形语义）；非法输入丢弃不变长", () => {
    const capacity = 4;
    let series = pushOmnicodePerfSample([], 0, 10, capacity);
    series = pushOmnicodePerfSample(series, 1, 20, capacity);
    series = pushOmnicodePerfSample(series, 2, 30, capacity);
    series = pushOmnicodePerfSample(series, 3, 40, capacity);
    expect(series.map((point) => point.memoryMB)).toEqual([10, 20, 30, 40]);
    // 第 5 个点：丢最旧（10），保留最近 4 个
    series = pushOmnicodePerfSample(series, 4, 50, capacity);
    expect(series.map((point) => point.memoryMB)).toEqual([20, 30, 40, 50]);
    expect(series.map((point) => point.at)).toEqual([1, 2, 3, 4]);
    // 非法值（NaN/负内存/NaN 时刻/capacity<=0）→ 返回等值拷贝（不追加）
    for (const bad of [
      [Number.NaN, 10] as const,
      [5, -1] as const,
      [Number.NaN, Number.NaN] as const,
    ]) {
      const rejected = pushOmnicodePerfSample(series, bad[0], bad[1], capacity);
      expect(rejected).toEqual(series);
      expect(rejected).not.toBe(series); // 不可变：返回新数组
    }
    expect(pushOmnicodePerfSample(series, 5, 60, 0)).toEqual(series);
    // 默认容量 = 60（spec：60 点 × 5s ≈ 近 5 分钟）
    expect(OMNICODE_PERF_SERIES_CAPACITY).toBe(60);
    let filled: ReturnType<typeof pushOmnicodePerfSample> = [];
    for (let i = 0; i < OMNICODE_PERF_SERIES_CAPACITY + 3; i += 1) {
      filled = pushOmnicodePerfSample(filled, i, i);
    }
    expect(filled).toHaveLength(OMNICODE_PERF_SERIES_CAPACITY);
    expect(filled[0]).toEqual({ at: 3, memoryMB: 3 });
  });

  it("buildOmnicodeSparklinePoints：空/单点/退化尺寸返回空串；坐标归一化与平线中位", () => {
    expect(buildOmnicodeSparklinePoints([], 96, 24)).toBe("");
    expect(buildOmnicodeSparklinePoints([42], 96, 24)).toBe("");
    expect(buildOmnicodeSparklinePoints([1, 2], 4, 24)).toBe(""); // width ≤ 2*padding
    expect(buildOmnicodeSparklinePoints([1, 2], 96, 4)).toBe(""); // height ≤ 2*padding
    // 精确坐标：values [0,10,20]、12×12、padding 2 → x=2,6,10；y=10,6,2（升序上扬）
    expect(buildOmnicodeSparklinePoints([0, 10, 20], 12, 12, 2)).toBe("2,10 6,6 10,2");
    // 全相等：画中线（不贴边）
    expect(buildOmnicodeSparklinePoints([7, 7, 7], 12, 12, 2)).toBe("2,6 6,6 10,6");
    // 降序：首点最高（y 最小）
    const descending = buildOmnicodeSparklinePoints([20, 10, 0], 12, 12, 2);
    expect(descending).toBe("2,2 6,6 10,10");
  });

  it("formatOmnicodeMemoryMB：非法→—；MB 取整；≥1024 显示 GB 一位小数", () => {
    expect(formatOmnicodeMemoryMB(Number.NaN)).toBe("—");
    expect(formatOmnicodeMemoryMB(-1)).toBe("—");
    expect(formatOmnicodeMemoryMB(500.4)).toBe("500 MB");
    expect(formatOmnicodeMemoryMB(500.6)).toBe("501 MB");
    expect(formatOmnicodeMemoryMB(1023)).toBe("1023 MB");
    expect(formatOmnicodeMemoryMB(1024)).toBe("1.0 GB");
    expect(formatOmnicodeMemoryMB(1536)).toBe("1.5 GB");
  });
});

// ═══ X2：loginHealth（分级纯函数 + 凭据快照读取） ═══

describe("omnicode batch2.5 X2: resolveOmnicodeLoginHealth (pure)", () => {
  const NOW = 1_700_000_000_000;

  it("全无有效 expiresAt → unknown", () => {
    expect(resolveOmnicodeLoginHealth({ expiresAtByProvider: {} }, NOW)).toEqual({ status: "unknown" });
    expect(
      resolveOmnicodeLoginHealth({ expiresAtByProvider: { zai: 0, zai_cn: Number.NaN, bigmodel: -5 } }, NOW),
    ).toEqual({ status: "unknown" });
  });

  it("active provider 优先（即使比其他 provider 更早过期）", () => {
    const result = resolveOmnicodeLoginHealth(
      { expiresAtByProvider: { zai: NOW + 10 * DAY_MS, zai_cn: NOW + 90 * DAY_MS }, activeProvider: "zai" },
      NOW,
    );
    expect(result).toEqual({ status: "healthy", daysRemaining: 10, expiresAt: NOW + 10 * DAY_MS });
  });

  it("active 缺失/非法 → 取全部有效值的最大值兜底", () => {
    const maxFallback = resolveOmnicodeLoginHealth(
      { expiresAtByProvider: { zai: NOW + 10 * DAY_MS, zai_cn: NOW + 90 * DAY_MS }, activeProvider: "nonexistent" },
      NOW,
    );
    expect(maxFallback).toEqual({ status: "healthy", daysRemaining: 90, expiresAt: NOW + 90 * DAY_MS });
    const activeInvalid = resolveOmnicodeLoginHealth(
      { expiresAtByProvider: { zai: 0, zai_cn: NOW + 30 * DAY_MS }, activeProvider: "zai" },
      NOW,
    );
    expect(activeInvalid).toEqual({ status: "healthy", daysRemaining: 30, expiresAt: NOW + 30 * DAY_MS });
  });

  it("expired 边界：now ≥ expiresAt（含恰好相等）", () => {
    expect(resolveOmnicodeLoginHealth({ expiresAtByProvider: { zai: NOW } }, NOW)).toEqual({
      status: "expired",
      daysRemaining: 0,
      expiresAt: NOW,
    });
    expect(resolveOmnicodeLoginHealth({ expiresAtByProvider: { zai: NOW - DAY_MS } }, NOW)).toEqual({
      status: "expired",
      daysRemaining: 0,
      expiresAt: NOW - DAY_MS,
    });
  });

  it("expiring 边界：剩余恰 7 天整属 expiring；7 天 +1ms 即 healthy（ceil 天数）", () => {
    expect(OMNICODE_LOGIN_EXPIRING_THRESHOLD_DAYS).toBe(7);
    const exactly7 = resolveOmnicodeLoginHealth(
      { expiresAtByProvider: { zai: NOW + 7 * DAY_MS } },
      NOW,
    );
    expect(exactly7.status).toBe("expiring");
    expect(exactly7).toEqual({ status: "expiring", daysRemaining: 7, expiresAt: NOW + 7 * DAY_MS });
    // 6.5 天 → ceil 7 → expiring
    expect(
      resolveOmnicodeLoginHealth({ expiresAtByProvider: { zai: NOW + 6.5 * DAY_MS } }, NOW).status,
    ).toBe("expiring");
    // 7 天 + 1ms → ceil 8 → healthy
    const healthy8 = resolveOmnicodeLoginHealth(
      { expiresAtByProvider: { zai: NOW + 7 * DAY_MS + 1 } },
      NOW,
    );
    expect(healthy8.status).toBe("healthy");
    expect(healthy8.daysRemaining).toBe(8);
    // 30 天整 → healthy 30
    expect(
      resolveOmnicodeLoginHealth({ expiresAtByProvider: { zai: NOW + 30 * DAY_MS } }, NOW).daysRemaining,
    ).toBe(30);
  });
});

describe("omnicode batch2.5 X2: readOmnicodeLoginHealthFromDataRoot (fs + cipher)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "omnicode-login-health-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const SECRET = "test-secret-0123456789abcdef-0123456789abcdef";

  async function writeSnapshot(
    entries: Record<string, string>,
    options?: { secret?: string; secretFile?: string; rawCredentials?: string },
  ): Promise<string> {
    const v2Dir = join(root, ".zcode", "v2");
    await mkdir(v2Dir, { recursive: true });
    await writeFile(
      join(v2Dir, "credential-secret"),
      options?.secretFile ?? options?.secret ?? SECRET,
      "utf8",
    );
    await writeFile(
      join(v2Dir, "credentials.json"),
      options?.rawCredentials ?? JSON.stringify(entries),
      "utf8",
    );
    return join(v2Dir, "credentials.json");
  }

  async function encrypt(filePath: string, secret: string, plain: string): Promise<string> {
    const cipher = createSystemCredentialCipher({
      filePath,
      env: { ZCODE_CREDENTIAL_SECRET: secret },
    });
    return cipher.encrypt(plain);
  }

  it("数据根缺失 / 密钥文件过短 / JSON 损坏 → 全部 unknown 静默", async () => {
    await expect(readOmnicodeLoginHealthFromDataRoot(join(root, "nope"))).resolves.toEqual({
      status: "unknown",
    });
    await writeSnapshot({}, { secretFile: "short" });
    await expect(readOmnicodeLoginHealthFromDataRoot(root)).resolves.toEqual({ status: "unknown" });
    await writeSnapshot({}, { rawCredentials: "{corrupt json" });
    await expect(readOmnicodeLoginHealthFromDataRoot(root)).resolves.toEqual({ status: "unknown" });
  });

  it("env 密文 happy path：active=zai 且剩 30 天 → healthy", async () => {
    const NOW = Date.now();
    const credentialsPath = join(root, ".zcode", "v2", "credentials.json");
    await writeSnapshot({
      "oauth:zai:expires_at": await encrypt(credentialsPath, SECRET, String(NOW + 30 * DAY_MS)),
      "oauth:active_provider": await encrypt(credentialsPath, SECRET, "zai"),
    });
    await expect(readOmnicodeLoginHealthFromDataRoot(root, NOW)).resolves.toEqual({
      status: "healthy",
      daysRemaining: 30,
      expiresAt: NOW + 30 * DAY_MS,
    });
  });

  it("legacy enc:v1 密文兼容：剩 3 天 → expiring", async () => {
    const NOW = Date.now();
    const legacyCipher = createLegacyCredentialCipher({ ZCODE_CREDENTIAL_SECRET: SECRET });
    await writeSnapshot({
      "oauth:zai_cn:expires_at": legacyCipher.encrypt(String(NOW + 3 * DAY_MS)),
    });
    await expect(readOmnicodeLoginHealthFromDataRoot(root, NOW)).resolves.toMatchObject({
      status: "expiring",
      daysRemaining: 3,
    });
  });

  it("密钥不匹配（模拟收养根 enc:v2:os: 旧密文，spec 已知限制 3）→ unknown", async () => {
    const NOW = Date.now();
    const credentialsPath = join(root, ".zcode", "v2", "credentials.json");
    const otherSecret = "other-secret-0123456789abcdef-0123456789";
    await writeSnapshot(
      {
        "oauth:zai:expires_at": await encrypt(credentialsPath, otherSecret, String(NOW + 30 * DAY_MS)),
      },
      { secret: SECRET }, // 落盘密钥与加密密钥不同 → 解密失败
    );
    await expect(readOmnicodeLoginHealthFromDataRoot(root, NOW)).resolves.toEqual({ status: "unknown" });
  });

  it("readOmnicodeLoginHealths：逐 profile 解析数据根（override 优先），失败项 unknown 不拖垮整体", async () => {
    const NOW = Date.now();
    const healthyRoot = join(root, "p1-data");
    const credentialsPath = join(healthyRoot, ".zcode", "v2", "credentials.json");
    await mkdir(join(healthyRoot, ".zcode", "v2"), { recursive: true });
    await writeFile(join(healthyRoot, ".zcode", "v2", "credential-secret"), SECRET, "utf8");
    await writeFile(
      join(healthyRoot, ".zcode", "v2", "credentials.json"),
      JSON.stringify({
        "oauth:zai:expires_at": await encrypt(credentialsPath, SECRET, String(NOW + 20 * DAY_MS)),
        "oauth:active_provider": await encrypt(credentialsPath, SECRET, "zai"),
      }),
      "utf8",
    );
    profileState.records = { p111111111: { dataBaseDirOverride: healthyRoot } };
    profileState.dirs = { p222222222: join(root, "missing-root") };
    const results = await readOmnicodeLoginHealths([
      { id: "p111111111", name: "A", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "p222222222", name: "B", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(results.get("p111111111")).toEqual({
      status: "healthy",
      daysRemaining: 20,
      expiresAt: NOW + 20 * DAY_MS,
    });
    expect(results.get("p222222222")).toEqual({ status: "unknown" });
  });
});

// ═══ X3：trayMenu（菜单模型纯函数 + 去抖重建装配） ═══
// 注意：trayMenu 为模块级单例（wired/名称缓存），本 describe 内按序执行：
// 先锁「未装配返回空」，再 setup，再验证去抖与菜单项行为。

describe("omnicode batch2.5 X3: trayMenu model (pure)", () => {
  it("buildOmnicodeTraySectionModel：实例项 label / 启停全部可用性与双语", () => {
    const empty = buildOmnicodeTraySectionModel({ instances: [], profileCount: 3, isZh: true });
    expect(empty.instanceItems).toEqual([]);
    expect(empty.launchAllLabel).toBe("启动全部");
    expect(empty.launchAllEnabled).toBe(true); // 有停止实例（3-0）
    expect(empty.stopAllLabel).toBe("停止全部");
    expect(empty.stopAllEnabled).toBe(false); // 无运行实例
    const running = buildOmnicodeTraySectionModel({
      instances: [
        { profileId: "pa111111111", name: "账号A" },
        { profileId: "pb111111222", name: "账号B" },
      ],
      profileCount: 2,
      isZh: false,
    });
    expect(running.instanceItems).toEqual([
      { profileId: "pa111111111", label: "● 账号A" },
      { profileId: "pb111111222", label: "● 账号B" },
    ]);
    expect(running.launchAllLabel).toBe("Launch all");
    expect(running.launchAllEnabled).toBe(false); // 全部在跑
    expect(running.stopAllLabel).toBe("Stop all");
    expect(running.stopAllEnabled).toBe(true);
    // 部分运行：两个方向都可用
    const partial = buildOmnicodeTraySectionModel({
      instances: [{ profileId: "pa111111111", name: "A" }],
      profileCount: 2,
      isZh: true,
    });
    expect(partial.launchAllEnabled).toBe(true);
    expect(partial.stopAllEnabled).toBe(true);
  });
});

describe("omnicode batch2.5 X3: trayMenu wiring + debounce", () => {
  beforeEach(() => {
    trayState.rebuilds = 0;
    bridgeState.broadcasts = [];
    bridgeState.commands = [];
  });

  it("未装配（wired=false）时菜单区为空数组——官方 flavor 零影响", () => {
    // 本测试先于 setup 执行（模块单例状态；见 describe 注释）
    expect(buildOmnicodeTrayMenuSection()).toEqual([]);
    expect(trayState.rebuilds).toBe(0);
  });

  it("setup：刷新名称缓存后重建一次；幂等（二次 setup 不重复订阅）", async () => {
    vi.useFakeTimers();
    try {
      profileState.profiles = [
        { id: "pa111111111", name: "账号A" },
        { id: "pb111111222", name: "账号B" },
      ];
      managerState.running = [
        { profileId: "pa111111111", pid: 111, startedAt: "2026-01-01T00:00:00.000Z" },
      ];
      setupOmnicodeConsoleTray({ showConsoleWindow: () => {}, isZh: () => true });
      setupOmnicodeConsoleTray({ showConsoleWindow: () => {}, isZh: () => true }); // 幂等
      await vi.advanceTimersByTimeAsync(0); // 初始 refreshNameCache 完成 → 重建 1 次
      expect(trayState.rebuilds).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("去抖重建：状态风暴 3 连发只重建 1 次（500ms 窗口）", async () => {
    vi.useFakeTimers();
    try {
      const listener = managerState.listener;
      expect(listener).toBeTypeOf("function");
      listener?.();
      listener?.();
      listener?.();
      await vi.advanceTimersByTimeAsync(499);
      expect(trayState.rebuilds).toBe(0); // 窗口内不重建
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0); // 名称缓存异步刷新完成
      expect(trayState.rebuilds).toBe(1); // 3 连发合并为 1 次重建
      // 窗口过后新事件重新进入下一轮去抖
      listener?.();
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(0);
      expect(trayState.rebuilds).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("buildOmnicodeTrayMenuSection：实例项+启停全部+分隔符；点击实例项走聚焦链路", () => {
    const items: MenuItemConstructorOptions[] = buildOmnicodeTrayMenuSection();
    // 结构：[实例项, separator, 启动全部, 停止全部, separator]
    expect(items).toHaveLength(5);
    expect(items[0]).toMatchObject({ label: "● 账号A" });
    expect(items[1]).toEqual({ type: "separator" });
    expect(items[2]).toMatchObject({ label: "启动全部", enabled: true }); // 2 profile 1 running
    expect(items[3]).toMatchObject({ label: "停止全部", enabled: true });
    expect(items[4]).toEqual({ type: "separator" });
    // 点击实例项 = 广播 focusRequested + 桥 focus 命令（spec §X3 聚焦链路）
    items[0].click?.(undefined as never, undefined as never, undefined as never);
    expect(bridgeState.broadcasts).toEqual([{ profileId: "pa111111111", type: "focusRequested" }]);
    expect(bridgeState.commands).toEqual([{ profileId: "pa111111111", command: { type: "focus" } }]);
  });
});
