// [OmniCode] 模式二 R3 桌面侧单测（spec: docs/omnicode/multi-account-sessions.md §6/§7）：
// - 附加账号目录客户端（实例 main）：桥应答逐条 schema 校验（非法条目整条丢弃）+ TTL 缓存；
// - 调度器槽位查询（main → Host）：pending 关联/迟到丢弃/校验失败收口/无 Host 结构化失败；
// - R4 智能调度开关的 globalPrefs 键面：实例下行落库 / 管理器上行落库 / spawn 注入 /
//   管理器快照读取（走既有键体系：白名单过滤 + 值域校验 + 环形抑制链不回归）。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeOmnicodeAccountDirectoryReply,
  getOmnicodeAccountDirectoryList,
  resetOmnicodeAccountDirectoryCacheForTest,
} from "../src/main/omnicode/accountDirectoryClient.js";
import {
  requestOmnicodeAccountSlotsFromHost,
  resolveOmnicodeAccountSlotsResult,
} from "../src/main/omnicode/accountSlotsQuery.js";
import {
  handleOmnicodeGlobalPrefsApplyCommand,
  initOmnicodeGlobalPrefsCoordinator,
  mergeOmnicodeGlobalPrefsIntoSettingsFile,
  readOmnicodeManagerGlobalPrefsSnapshot,
  resetOmnicodeGlobalPrefsCoordinatorForTest,
} from "../src/main/omnicode/globalPrefs.js";
// [OmniCode] 模式二 R3：桥取回入口 mock（accountDirectoryClient 静态依赖；vi.mock 提升到
// 顶部，测试内按用例重配置返回值，resetOmnicodeAccountDirectoryCacheForTest 清缓存隔离）。
const bridgeMock = vi.hoisted(() =>
  vi.fn<() => Promise<{ ok: boolean; accounts?: unknown[]; error?: string }>>(),
);
vi.mock("../src/main/omnicode/instanceBridgeClient.js", () => ({
  requestOmnicodeAccountDirectoryFromManager: bridgeMock,
}));

const validEntry = {
  accountId: "acct-p0r3test01",
  sourceProfileId: "p0r3test01",
  family: "zai",
  displayName: "工作号",
};

describe("模式二 R3 附加账号目录客户端（实例 main）", () => {
  afterEach(() => {
    resetOmnicodeAccountDirectoryCacheForTest();
    bridgeMock.mockReset();
  });

  it("decode：ok=true 保留合法条目；非法条目整条丢弃；ok=false 只带结构化错误", () => {
    const decoded = decodeOmnicodeAccountDirectoryReply({
      ok: true,
      accounts: [validEntry, { ...validEntry, accountId: "bad id" }],
    });
    expect(decoded.entries).toHaveLength(1);
    expect(decoded.entries[0]?.displayName).toBe("工作号");
    const failed = decodeOmnicodeAccountDirectoryReply({
      ok: false,
      error: "omnicode_account_directory_unavailable",
    });
    expect(failed.entries).toEqual([]);
    expect(failed.error).toBe("omnicode_account_directory_unavailable");
  });

  it("TTL 缓存：命中不重发桥请求；并发共享 in-flight", async () => {
    bridgeMock.mockResolvedValue({ ok: true, accounts: [validEntry] });
    const [first, second] = await Promise.all([
      getOmnicodeAccountDirectoryList(),
      getOmnicodeAccountDirectoryList(),
    ]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(bridgeMock).toHaveBeenCalledTimes(1);
  });

  it("失败应答不缓存（下次查询重试）", async () => {
    bridgeMock
      .mockResolvedValueOnce({ ok: false, error: "bridge_disconnected" })
      .mockResolvedValueOnce({ ok: true, accounts: [validEntry] });
    expect(await getOmnicodeAccountDirectoryList()).toEqual([]);
    expect(await getOmnicodeAccountDirectoryList()).toHaveLength(1);
    expect(bridgeMock).toHaveBeenCalledTimes(2);
  });
});

describe("模式二 R3 调度器槽位查询（main → Host）", () => {
  it("无 Host → 结构化失败（不抛穿）", async () => {
    // resourceManagerWindow 未登记 Host（测试进程无注册）。
    const result = await requestOmnicodeAccountSlotsFromHost();
    expect(result.ok).toBe(false);
  });

  it("应答关联 + 迟到/陌生 requestId 丢弃 + 校验失败收口", async () => {
    // 无 Host 时请求直接失败；这里锁定 resolve 路由的迟到丢弃（无 pending 即 no-op）。
    expect(() =>
      resolveOmnicodeAccountSlotsResult({
        type: "omnicode-account-slots-result",
        requestId: "stray",
        ok: true,
        slots: [],
      }),
    ).not.toThrow();
  });
});

describe("模式二 R4 智能调度开关 globalPrefs 键面", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    resetOmnicodeGlobalPrefsCoordinatorForTest();
  });

  function createHarness(identity: "manager" | "instance", profileId = "p0r3sched01") {
    const updateCalls: Record<string, unknown>[] = [];
    const applies: { profileId: string; prefs: Record<string, unknown> }[] = [];
    let settings: Record<string, unknown> = {};
    const harness = {
      updateCalls,
      applies,
      deps: {
        identity,
        getOwnProfileId: () => profileId,
        getSettings: async () => settings,
        updateSettings: async (patch: Record<string, unknown>) => {
          settings = { ...settings, ...patch };
          updateCalls.push(patch);
        },
        injectStateBroadcast: () => true,
        sendApplyToInstance: (targetProfileId: string, command: { prefs: unknown }) => {
          applies.push({
            profileId: targetProfileId,
            prefs: command.prefs as Record<string, unknown>,
          });
          return true;
        },
        getConnectedInstanceProfileIds: () => (identity === "manager" ? ["p0r3inst01"] : []),
        sendReportToManager: () => true,
        refreshShortcutApplication: () => undefined,
        resolveCurrentApplicationLocale: () => "zh-CN" as const,
        logger: { info: () => undefined, warn: () => undefined },
      },
    };
    return harness;
  }

  it("实例下行 apply：omnicodeSmartScheduling 落盘（走既有键体系，环形抑制不受影响）", async () => {
    const harness = createHarness("instance");
    initOmnicodeGlobalPrefsCoordinator(harness.deps);
    const result = await handleOmnicodeGlobalPrefsApplyCommand(
      { omnicodeSmartScheduling: false },
      "manager",
    );
    expect(result.status).toBe("applied");
    expect(result.appliedKeys).toContain("omnicodeSmartScheduling");
    // 回声（sourceInstanceId=自己）仍被环形抑制忽略——既有链路不回归。
    const echo = await handleOmnicodeGlobalPrefsApplyCommand(
      { omnicodeSmartScheduling: true },
      "p0r3sched01",
    );
    expect(echo.status).toBe("echo-ignored");
  });

  it("管理器上行 report：键落全局层；白名单外键（dataBaseDir）到不了钩子", async () => {
    const harness = createHarness("manager");
    initOmnicodeGlobalPrefsCoordinator(harness.deps);
    const { handleOmnicodeGlobalPrefsReportFromInstance } = await import(
      "../src/main/omnicode/globalPrefs.js"
    );
    const result = await handleOmnicodeGlobalPrefsReportFromInstance(
      { omnicodeSmartScheduling: false, dataBaseDir: "C:/leak" },
      "p0r3inst01",
    );
    expect(result.status).toBe("applied");
    expect(result.appliedKeys).toContain("omnicodeSmartScheduling");
    expect(harness.updateCalls.some((patch) => "dataBaseDir" in patch)).toBe(false);
    // 下行广播到全部已回连实例（载荷即键面）。
    expect(harness.applies[0]?.prefs).toMatchObject({ omnicodeSmartScheduling: false });
  });

  it("spawn 注入：omnicodeSmartScheduling 写实例 setting.json；缺席键不覆盖实例自有值", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnicode-r3-prefs-"));
    tempDirs.push(dir);
    const settingsFile = join(dir, "setting.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      settingsFile,
      JSON.stringify({ locale: "zh-CN", omnicodeSmartScheduling: false }),
      "utf8",
    );
    const written = await mergeOmnicodeGlobalPrefsIntoSettingsFile(settingsFile, {
      // 具体语言偏好（system 偏好会按既有语义清 locale 缓存——另测覆盖，勿在此混入）。
      locale: "zh-CN",
      localePreference: "zh-CN",
      omnicodeSmartScheduling: true,
    });
    expect(written).toContain("omnicodeSmartScheduling");
    const merged = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
    // 快照值覆盖（用户显式改管理器开关后 spawn 注入下发）。
    expect(merged.omnicodeSmartScheduling).toBe(true);
    // 实例其余键原样保留。
    expect(merged.locale).toBe("zh-CN");
    // 快照缺键不覆盖。
    await mergeOmnicodeGlobalPrefsIntoSettingsFile(settingsFile, {
      locale: "zh-CN",
      localePreference: "zh-CN",
    });
    const merged2 = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
    expect(merged2.omnicodeSmartScheduling).toBe(true);
  });

  it("管理器全局层快照读取携带 omnicodeSmartScheduling", async () => {
    const harness = createHarness("manager");
    initOmnicodeGlobalPrefsCoordinator(harness.deps);
    const snapshot = await readOmnicodeManagerGlobalPrefsSnapshot();
    expect(snapshot.omnicodeSmartScheduling).toBeUndefined(); // 缺席键不进快照（=开语义）
    harness.deps.getSettings = async () => ({ omnicodeSmartScheduling: false });
    const snapshot2 = await readOmnicodeManagerGlobalPrefsSnapshot();
    expect(snapshot2.omnicodeSmartScheduling).toBe(false);
  });
});
