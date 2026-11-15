// [OmniCode] 批次4 全局偏好层单测（spec: docs/omnicode/global-preferences.md）：
// - shared 纯函数：白名单过滤（敏感键零触碰锁定）/ 值域校验 / 环形抑制判定 / locale 键映射
// - 协调器：身份路由（manager 下行 / instance 上行 / official no-op）/ 环形抑制 / 去重
//   （同值不重播 + A→B→A 漏播回归）/ spawn 注入合并（实例自有键保留 + system 映射）
// - 桥协议端到端：实例 reportGlobalPrefs 帧 → 桥服务消毒 → 管理器钩子收到白名单载荷
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// electron 仅在桥广播路径使用（BrowserWindow.getAllWindows）——mock 掉使 main 侧
// 模块可在 node 测试进程导入执行（与 omnicodeReviewBridge.test.ts 同款约定）。
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import {
  buildOmnicodeLocaleSyncFields,
  filterOmnicodeGlobalPrefsFromPatch,
  isOmnicodeGlobalPrefsEchoSelf,
  isEmptyOmnicodeGlobalPrefsPayload,
  isOmnicodeShortcutBindingsValue,
  sanitizeOmnicodeGlobalPrefsPayload,
} from "@zcode/shared";
import {
  getOmnicodeGlobalPrefsIdentity,
  handleOmnicodeGlobalPrefsApplyCommand,
  handleOmnicodeGlobalPrefsReportFromInstance,
  injectOmnicodeGlobalPrefsForSpawn,
  initOmnicodeGlobalPrefsCoordinator,
  mergeOmnicodeGlobalPrefsIntoSettingsFile,
  normalizeOmnicodeGlobalPrefsForDispatch,
  noteOmnicodeAppSettingsPatchForGlobalPrefs,
  noteOmnicodeRendererStateBroadcastForGlobalPrefs,
  readOmnicodeGlobalPrefsSidecarTheme,
  resetOmnicodeGlobalPrefsCoordinatorForTest,
} from "../src/main/omnicode/globalPrefs.js";
import {
  ensureOmnicodeInstanceBridgeServerStarted,
  setOmnicodeInstanceBridgeManagerHooks,
} from "../src/main/omnicode/instanceBridgeServer.js";

const SELF_PROFILE_ID = "pglobalprefs1";
const OTHER_PROFILE_ID = "potherinst1";

const BINDINGS: Record<string, string[]> = { "workspace.toggleSidebar": ["Ctrl+B"] };

interface CoordinatorHarnessOptions {
  identity: "manager" | "instance" | "official";
  profileId?: string;
}

interface CapturedApply {
  profileId: string;
  prefs: Record<string, unknown>;
  sourceInstanceId: string;
}

function createCoordinatorHarness(options: CoordinatorHarnessOptions) {
  const updateCalls: Record<string, unknown>[] = [];
  const injectCalls: { channel: string; payload: unknown }[] = [];
  const applies: CapturedApply[] = [];
  const reports: { prefs: unknown; sourceInstanceId: string }[] = [];
  let shortcutRefreshed = 0;
  let connected: string[] = [];
  const harness = {
    updateCalls,
    injectCalls,
    applies,
    reports,
    getShortcutRefreshed: () => shortcutRefreshed,
    setConnected: (ids: string[]) => {
      connected = ids;
    },
    deps: {
      identity: options.identity,
      getOwnProfileId: () => options.profileId ?? "",
      getSettings: async () => ({ locale: "en-US" as const, localePreference: "en-US" as const }),
      updateSettings: async (patch: Record<string, unknown>) => {
        updateCalls.push(patch);
      },
      injectStateBroadcast: (channel: string, payload: unknown) => {
        injectCalls.push({ channel, payload });
        return true;
      },
      sendApplyToInstance: (profileId: string, command: { prefs: unknown; sourceInstanceId: string }) => {
        applies.push({
          profileId,
          prefs: command.prefs as Record<string, unknown>,
          sourceInstanceId: command.sourceInstanceId,
        });
        return true;
      },
      getConnectedInstanceProfileIds: () => connected,
      sendReportToManager: (message: { prefs: unknown; sourceInstanceId: string }) => {
        reports.push({ prefs: message.prefs, sourceInstanceId: message.sourceInstanceId });
        return true;
      },
      refreshShortcutApplication: () => {
        shortcutRefreshed += 1;
      },
      resolveCurrentApplicationLocale: () => "en-US" as const,
      logger: { info: () => undefined, warn: () => undefined },
    },
  };
  return harness;
}

describe("omnicode batch4 global prefs: shared whitelist pure functions", () => {
  it("filterOmnicodeGlobalPrefsFromPatch：白名单键保留，白名单外敏感键一律丢弃", () => {
    const filtered = filterOmnicodeGlobalPrefsFromPatch({
      locale: "zh-CN",
      localePreference: "zh-CN",
      shortcutBindings: BINDINGS,
      theme: "zai-dark",
      // 敏感/实例键（红线：到不了同步载荷）
      providerFamilyDomain: "team",
      providerFamilyConnectionSelections: { personal: { kind: "team-coding-plan" } },
      webRemoteControlRelayV2Device: { deviceId: "d" },
      dataBaseDir: "C:/leak",
      recentProjects: ["C:/leak"],
      lastWorkspaceSession: [{ kind: "local", workspacePath: "C:/leak" }],
      sourceServers: [{ id: "s" }],
      connectionProfiles: [{ id: "c" }],
      httpProxy: "http://leak",
    });
    expect(filtered).toEqual({
      locale: "zh-CN",
      localePreference: "zh-CN",
      shortcutBindings: BINDINGS,
      theme: "zai-dark",
    });
  });

  it("filterOmnicodeGlobalPrefsFromPatch：值域不合法的键丢弃（含原型链污染形态）", () => {
    expect(
      filterOmnicodeGlobalPrefsFromPatch({
        locale: "xx-XX",
        localePreference: 42,
        shortcutBindings: { cmd: "not-array" },
        theme: "purple",
      }),
    ).toEqual({});
    const polluted: Record<string, unknown> = {};
    Object.assign(polluted, JSON.parse('{"__proto__":{"polluted":true},"locale":"zh-CN"}'));
    const result = filterOmnicodeGlobalPrefsFromPatch(polluted);
    expect(result.locale).toBe("zh-CN");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("sanitizeOmnicodeGlobalPrefsPayload：非对象输入收敛为空载荷", () => {
    expect(sanitizeOmnicodeGlobalPrefsPayload(null)).toEqual({});
    expect(sanitizeOmnicodeGlobalPrefsPayload([1, 2])).toEqual({});
    expect(sanitizeOmnicodeGlobalPrefsPayload("locale=zh-CN")).toEqual({});
    expect(isEmptyOmnicodeGlobalPrefsPayload({})).toBe(true);
  });

  it("isOmnicodeShortcutBindingsValue / isOmnicodeGlobalPrefsEchoSelf：形状与环形抑制判定", () => {
    expect(isOmnicodeShortcutBindingsValue(BINDINGS)).toBe(true);
    expect(isOmnicodeShortcutBindingsValue({ "": ["Ctrl"] })).toBe(false);
    expect(isOmnicodeShortcutBindingsValue({ cmd: [1] })).toBe(false);
    expect(isOmnicodeGlobalPrefsEchoSelf(SELF_PROFILE_ID, SELF_PROFILE_ID)).toBe(true);
    expect(isOmnicodeGlobalPrefsEchoSelf("manager", SELF_PROFILE_ID)).toBe(false);
    expect(isOmnicodeGlobalPrefsEchoSelf("", SELF_PROFILE_ID)).toBe(false);
  });

  it("buildOmnicodeLocaleSyncFields：system 只带偏好；具体语言带 locale+偏好；缺偏好带 locale 保底", () => {
    expect(buildOmnicodeLocaleSyncFields("zh-CN", "system")).toEqual({ localePreference: "system" });
    expect(buildOmnicodeLocaleSyncFields("zh-CN", "zh-CN")).toEqual({
      locale: "zh-CN",
      localePreference: "zh-CN",
    });
    expect(buildOmnicodeLocaleSyncFields("ja-JP", undefined)).toEqual({ locale: "ja-JP" });
    expect(buildOmnicodeLocaleSyncFields(undefined, undefined)).toEqual({});
  });

  it("normalizeOmnicodeGlobalPrefsForDispatch：system 剥离 locale，具体语言原样", () => {
    expect(normalizeOmnicodeGlobalPrefsForDispatch({ locale: "zh-CN", localePreference: "system" })).toEqual({
      localePreference: "system",
    });
    expect(normalizeOmnicodeGlobalPrefsForDispatch({ locale: "zh-CN", localePreference: "zh-CN" })).toEqual({
      locale: "zh-CN",
      localePreference: "zh-CN",
    });
  });
});

describe("omnicode batch4 global prefs: coordinator routing & ring suppression", () => {
  beforeEach(() => {
    resetOmnicodeGlobalPrefsCoordinatorForTest();
  });

  afterEach(() => {
    resetOmnicodeGlobalPrefsCoordinatorForTest();
    setOmnicodeInstanceBridgeManagerHooks(null);
  });

  it("official 身份 no-op：观察点/桥命令全部直通返回", async () => {
    const harness = createCoordinatorHarness({ identity: "official" });
    initOmnicodeGlobalPrefsCoordinator(harness.deps);
    expect(getOmnicodeGlobalPrefsIdentity()).toBe("official");
    noteOmnicodeRendererStateBroadcastForGlobalPrefs("state:theme", "zai-dark");
    noteOmnicodeAppSettingsPatchForGlobalPrefs({ shortcutBindings: BINDINGS });
    expect(await handleOmnicodeGlobalPrefsApplyCommand({ locale: "zh-CN" }, "manager")).toMatchObject({
      status: "noop",
    });
    expect(harness.applies).toEqual([]);
    expect(harness.reports).toEqual([]);
  });

  it("manager 身份：state:* 广播观察 → 下行 applyGlobalPrefs（sourceInstanceId=manager）", () => {
    const harness = createCoordinatorHarness({ identity: "manager" });
    initOmnicodeGlobalPrefsCoordinator(harness.deps);
    harness.setConnected([SELF_PROFILE_ID, OTHER_PROFILE_ID]);
    noteOmnicodeRendererStateBroadcastForGlobalPrefs("state:theme", "zai-dark");
    noteOmnicodeRendererStateBroadcastForGlobalPrefs("state:locale", {
      preference: "zh-CN",
      resolvedLocale: "zh-CN",
    });
    noteOmnicodeRendererStateBroadcastForGlobalPrefs("state:uiFontSizePx", 14);
    // 每次变更按「已回连实例集合」逐实例投递（2 实例 × 2 次变更 = 4 条）
    expect(harness.applies.map((entry) => entry.prefs)).toEqual([
      { theme: "zai-dark" },
      { theme: "zai-dark" },
      { locale: "zh-CN", localePreference: "zh-CN" },
      { locale: "zh-CN", localePreference: "zh-CN" },
    ]);
    expect(harness.applies.every((entry) => entry.sourceInstanceId === "manager")).toBe(true);
    expect(harness.applies.map((entry) => entry.profileId).sort()).toEqual([
      SELF_PROFILE_ID,
      SELF_PROFILE_ID,
      OTHER_PROFILE_ID,
      OTHER_PROFILE_ID,
    ]);
    // system 偏好不携带源进程解析结果
    noteOmnicodeRendererStateBroadcastForGlobalPrefs("state:locale", {
      preference: "system",
      resolvedLocale: "zh-CN",
    });
    expect(harness.applies.at(-1)?.prefs).toEqual({ localePreference: "system" });
  });

  it("manager 身份：SyncAppSettings patch 观察 → 白名单过滤后下行", () => {
    const harness = createCoordinatorHarness({ identity: "manager" });
    initOmnicodeGlobalPrefsCoordinator(harness.deps);
    harness.setConnected([SELF_PROFILE_ID]);
    noteOmnicodeAppSettingsPatchForGlobalPrefs({
      shortcutBindings: BINDINGS,
      closeToTrayOnWindows: true,
      dataBaseDir: "C:/leak",
    });
    expect(harness.applies).toHaveLength(1);
    expect(harness.applies[0]?.prefs).toEqual({ shortcutBindings: BINDINGS });
    noteOmnicodeAppSettingsPatchForGlobalPrefs({ closeToTrayOnWindows: true });
    expect(harness.applies).toHaveLength(1);
  });

  it("instance 身份：观察点 → 上行 reportGlobalPrefs（sourceInstanceId=自身 profileId）", () => {
    const harness = createCoordinatorHarness({ identity: "instance", profileId: SELF_PROFILE_ID });
    initOmnicodeGlobalPrefsCoordinator(harness.deps);
    noteOmnicodeRendererStateBroadcastForGlobalPrefs("state:theme", "zai-light");
    noteOmnicodeAppSettingsPatchForGlobalPrefs({ shortcutBindings: BINDINGS });
    expect(harness.reports.map((entry) => entry.prefs)).toEqual([
      { theme: "zai-light" },
      { shortcutBindings: BINDINGS },
    ]);
    expect(harness.reports.every((entry) => entry.sourceInstanceId === SELF_PROFILE_ID)).toBe(true);
  });

  it("instance 收到 applyGlobalPrefs：回声忽略（环形抑制）+ manager 源正常应用", async () => {
    const harness = createCoordinatorHarness({ identity: "instance", profileId: SELF_PROFILE_ID });
    initOmnicodeGlobalPrefsCoordinator(harness.deps);
    const echo = await handleOmnicodeGlobalPrefsApplyCommand(
      { theme: "zai-dark" },
      SELF_PROFILE_ID,
    );
    expect(echo).toMatchObject({ status: "echo-ignored" });
    expect(harness.updateCalls).toEqual([]);
    const applied = await handleOmnicodeGlobalPrefsApplyCommand(
      {
        locale: "zh-CN",
        localePreference: "zh-CN",
        shortcutBindings: BINDINGS,
        theme: "zai-light",
      },
      "manager",
    );
    expect(applied).toMatchObject({
      status: "applied",
      appliedKeys: ["localePreference", "locale", "shortcutBindings"],
    });
    expect(applied.appliedKeys).not.toContain("theme");
    // setting.json 键经 updateSettings（含 theme 以外的白名单键）；theme 走注入
    expect(harness.updateCalls).toEqual([
      { locale: "zh-CN", localePreference: "zh-CN" },
      { shortcutBindings: BINDINGS },
    ]);
    expect(harness.injectCalls).toEqual([
      { channel: "state:theme", payload: "zai-light" },
      { channel: "state:locale", payload: { preference: "zh-CN", resolvedLocale: "zh-CN" } },
    ]);
    expect(harness.getShortcutRefreshed()).toBe(1);
  });

  it("instance apply：system 偏好落盘剥离 locale，注入 resolvedLocale 用本进程解析", async () => {
    const harness = createCoordinatorHarness({ identity: "instance", profileId: SELF_PROFILE_ID });
    initOmnicodeGlobalPrefsCoordinator(harness.deps);
    await handleOmnicodeGlobalPrefsApplyCommand(
      { locale: "zh-CN", localePreference: "system" },
      "manager",
    );
    expect(harness.updateCalls).toEqual([{ localePreference: "system" }]);
    expect(harness.injectCalls).toEqual([
      { channel: "state:locale", payload: { preference: "system", resolvedLocale: "en-US" } },
    ]);
  });

  it("instance apply：载荷含敏感键时只应用白名单键（红线锁定）", async () => {
    const harness = createCoordinatorHarness({ identity: "instance", profileId: SELF_PROFILE_ID });
    initOmnicodeGlobalPrefsCoordinator(harness.deps);
    await handleOmnicodeGlobalPrefsApplyCommand(
      {
        locale: "zh-CN",
        dataBaseDir: "C:/leak",
        providerFamilyConnectionSelections: { personal: { kind: "team-coding-plan" } },
        webRemoteControlRelayV2Device: { deviceId: "d" },
      },
      "manager",
    );
    expect(harness.updateCalls).toEqual([{ locale: "zh-CN" }]);
  });

  it("去重：同值不重播；A→B→A 序列不漏播（过期去重键回归）", async () => {
    const harness = createCoordinatorHarness({ identity: "manager" });
    initOmnicodeGlobalPrefsCoordinator(harness.deps);
    harness.setConnected([SELF_PROFILE_ID]);
    noteOmnicodeAppSettingsPatchForGlobalPrefs({ shortcutBindings: BINDINGS });
    noteOmnicodeAppSettingsPatchForGlobalPrefs({ shortcutBindings: BINDINGS });
    expect(harness.applies).toHaveLength(1);
    noteOmnicodeRendererStateBroadcastForGlobalPrefs("state:theme", "zai-dark");
    noteOmnicodeRendererStateBroadcastForGlobalPrefs("state:theme", "zai-light");
    noteOmnicodeRendererStateBroadcastForGlobalPrefs("state:theme", "zai-dark");
    expect(harness.applies.map((entry) => entry.prefs)).toEqual([
      { shortcutBindings: BINDINGS },
      { theme: "zai-dark" },
      { theme: "zai-light" },
      { theme: "zai-dark" },
    ]);
  });

  it("manager 收上行：写全局层（setting.json 键 + theme 侧车）+ 热应用 + 带源 id 下行", async () => {
    const sidecarRoot = mkdtempSync(join(tmpdir(), "omnicode-prefs-"));
    const previousDataBaseDir = process.env.ZCODE_DATA_BASE_DIR;
    process.env.ZCODE_DATA_BASE_DIR = sidecarRoot;
    try {
      const harness = createCoordinatorHarness({ identity: "manager" });
      initOmnicodeGlobalPrefsCoordinator(harness.deps);
      harness.setConnected([SELF_PROFILE_ID, OTHER_PROFILE_ID]);
      const result = await handleOmnicodeGlobalPrefsReportFromInstance(
        {
          locale: "ja-JP",
          localePreference: "ja-JP",
          shortcutBindings: BINDINGS,
          theme: "zai-dark",
          dataBaseDir: "C:/leak",
        },
        SELF_PROFILE_ID,
      );
      expect(result).toMatchObject({
        status: "applied",
        appliedKeys: ["localePreference", "locale", "shortcutBindings", "theme"],
      });
      expect(harness.updateCalls).toEqual([
        { localePreference: "ja-JP", locale: "ja-JP" },
        { shortcutBindings: BINDINGS },
      ]);
      expect(await readOmnicodeGlobalPrefsSidecarTheme()).toBe("zai-dark");
      expect(harness.injectCalls).toEqual([
        { channel: "state:theme", payload: "zai-dark" },
        { channel: "state:locale", payload: { preference: "ja-JP", resolvedLocale: "ja-JP" } },
      ]);
      expect(harness.getShortcutRefreshed()).toBe(1);
      // 下行广播带源实例 id（环形抑制由源实例裁决）
      expect(harness.applies).toHaveLength(2);
      expect(harness.applies.every((entry) => entry.sourceInstanceId === SELF_PROFILE_ID)).toBe(true);
      expect(harness.applies.every((entry) => entry.prefs.dataBaseDir === undefined)).toBe(true);
    } finally {
      if (previousDataBaseDir === undefined) delete process.env.ZCODE_DATA_BASE_DIR;
      else process.env.ZCODE_DATA_BASE_DIR = previousDataBaseDir;
      rmSync(sidecarRoot, { recursive: true, force: true });
      resetOmnicodeGlobalPrefsCoordinatorForTest();
    }
  });

  it("manager 收上行：system 偏好只落 localePreference；空/全非法载荷 noop", async () => {
    const harness = createCoordinatorHarness({ identity: "manager" });
    initOmnicodeGlobalPrefsCoordinator(harness.deps);
    harness.setConnected([]);
    await handleOmnicodeGlobalPrefsReportFromInstance(
      { locale: "zh-CN", localePreference: "system", dataBaseDir: "C:/leak" },
      SELF_PROFILE_ID,
    );
    expect(harness.updateCalls).toEqual([{ localePreference: "system" }]);
    const noop = await handleOmnicodeGlobalPrefsReportFromInstance(
      { dataBaseDir: "C:/leak", recentProjects: ["C:/leak"] },
      SELF_PROFILE_ID,
    );
    expect(noop).toMatchObject({ status: "noop" });
  });
});

describe("omnicode batch4 global prefs: spawn injection merge", () => {
  beforeEach(() => {
    resetOmnicodeGlobalPrefsCoordinatorForTest();
  });

  afterEach(() => {
    resetOmnicodeGlobalPrefsCoordinatorForTest();
  });

  it("merge：白名单键覆盖、实例自有键保留、theme 不写 setting.json、system 只写偏好", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnicode-prefs-"));
    try {
      const settingsFile = join(dir, "setting.json");
      const harness = createCoordinatorHarness({ identity: "manager" });
      initOmnicodeGlobalPrefsCoordinator(harness.deps);
      // 快照 = getSettings 返回值（localePreference=具体语言）
      await injectOmnicodeGlobalPrefsForSpawn(settingsFile);
      let merged = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
      expect(merged).toEqual({ locale: "en-US", localePreference: "en-US" });
      // 既有内容保留 + 二次注入覆盖
      await mergeOmnicodeGlobalPrefsIntoSettingsFile(settingsFile, {
        locale: "zh-CN",
        localePreference: "zh-CN",
        shortcutBindings: BINDINGS,
        theme: "zai-dark",
        keepMine: undefined,
      });
      merged = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
      expect(merged).toEqual({
        locale: "zh-CN",
        localePreference: "zh-CN",
        shortcutBindings: BINDINGS,
      });
      expect(merged.theme).toBeUndefined();
      // system 偏好只写 localePreference
      await mergeOmnicodeGlobalPrefsIntoSettingsFile(settingsFile, { localePreference: "system" });
      merged = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
      expect(merged.localePreference).toBe("system");
      expect(merged.locale).toBeUndefined();
      expect(merged.shortcutBindings).toEqual(BINDINGS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merge：快照无白名单键时不触碰文件；实例文件不可解析时不覆盖", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnicode-prefs-"));
    try {
      const settingsFile = join(dir, "setting.json");
      expect(await mergeOmnicodeGlobalPrefsIntoSettingsFile(settingsFile, { theme: "zai-dark" })).toEqual([]);
      expect(
        await mergeOmnicodeGlobalPrefsIntoSettingsFile(settingsFile, {
          locale: "zh-CN",
          localePreference: "zh-CN",
        }),
      ).toEqual(["localePreference", "locale"]);
      const corruptFile = join(dir, "corrupt.json");
      await mergeOmnicodeGlobalPrefsIntoSettingsFile(corruptFile, {});
      const { writeFileSync } = await import("node:fs");
      writeFileSync(corruptFile, ":wq", "utf8");
      expect(
        await mergeOmnicodeGlobalPrefsIntoSettingsFile(corruptFile, {
          locale: "zh-CN",
          localePreference: "zh-CN",
        }),
      ).toEqual([]);
      expect(readFileSync(corruptFile, "utf8")).toBe(":wq");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("injectOmnicodeGlobalPrefsForSpawn：非 manager 身份 no-op；坏快照读失败跳过", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnicode-prefs-"));
    try {
      const settingsFile = join(dir, "setting.json");
      const instanceHarness = createCoordinatorHarness({
        identity: "instance",
        profileId: SELF_PROFILE_ID,
      });
      initOmnicodeGlobalPrefsCoordinator(instanceHarness.deps);
      await injectOmnicodeGlobalPrefsForSpawn(settingsFile);
      expect(() => readFileSync(settingsFile, "utf8")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("omnicode batch4 global prefs: bridge protocol (reportGlobalPrefs frame)", () => {
  const SENTITIVE_FRAME = {
    type: "reportGlobalPrefs",
    prefs: {
      locale: "zh-CN",
      localePreference: "zh-CN",
      dataBaseDir: "C:/leak",
      providerFamilyDomain: "team",
      recentProjects: ["C:/leak"],
    },
    sourceInstanceId: SELF_PROFILE_ID,
  };

  it("实例帧 → 桥服务消毒 → 管理器钩子收到白名单载荷（敏感键到不了钩子）", async () => {
    const { default: WebSocket } = await import("ws");
    resetOmnicodeGlobalPrefsCoordinatorForTest();
    const harness = createCoordinatorHarness({ identity: "manager" });
    initOmnicodeGlobalPrefsCoordinator(harness.deps);
    harness.setConnected([]);
    const received: { profileId: string; prefs: Record<string, unknown>; sourceInstanceId: string }[] = [];
    setOmnicodeInstanceBridgeManagerHooks({
      onOmnicodeGlobalPrefsReport: (profileId, prefs, sourceInstanceId) => {
        received.push({ profileId, prefs: prefs as Record<string, unknown>, sourceInstanceId });
      },
    });
    const bridge = await ensureOmnicodeInstanceBridgeServerStarted();
    const ws = await new Promise<import("ws").WebSocket>((resolve, reject) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${bridge.port}/?token=${bridge.token}&profileId=${SELF_PROFILE_ID}`,
      );
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });
    try {
      ws.send(JSON.stringify(SENTITIVE_FRAME));
      for (let i = 0; i < 50 && received.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(received).toHaveLength(1);
      expect(received[0]?.profileId).toBe(SELF_PROFILE_ID);
      expect(received[0]?.sourceInstanceId).toBe(SELF_PROFILE_ID);
      expect(received[0]?.prefs).toEqual({ locale: "zh-CN", localePreference: "zh-CN" });
      // 协调器落地路径同样只见白名单键（dataBaseDir/providerFamily* 不进 updateSettings）
      const reportResult = await handleOmnicodeGlobalPrefsReportFromInstance(
        SENTITIVE_FRAME.prefs,
        SENTITIVE_FRAME.sourceInstanceId,
      );
      expect(reportResult.status).toBe("applied");
      expect(harness.updateCalls).toEqual([{ localePreference: "zh-CN", locale: "zh-CN" }]);
    } finally {
      ws.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });
});
