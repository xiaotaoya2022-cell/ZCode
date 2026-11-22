// [OmniCode] 丙1 远程聚合 R4 单测（spec: docs/omnicode/remote-aggregation.md §6/§7/§8-R4）：
// - 跨账号开关过滤分支（开=跨账号条目在/关=剔除；门控关恒空）：globalPrefs 键体系
//   omnicodeRemoteCrossAccount（布尔，缺省关）→ remoteForwardHost 目录视图 deps 接线 →
//   R1 aggregateOmnicodeWorkspaceLists includeCrossAccount 参数（目录/聚合代码零改动）。
// - 开关键链路：shared 消毒（布尔值域）+ 管理器侧车持久化（omnicode-global-prefs.json，
//   schema strip 不收该键——theme 同款裁定）+ applyGlobalPrefs 下行（实例读取端缓存）+
//   上行落地 + spawn 注入排除（不进实例 setting.json）。
// - failover（宿主退出，自动转移为二期）：宿主登记 → 断连对账 → onAggregateHostExit
//   提示链 + remoteHostAnnounce(epoch+1) 广播剩余实例；epoch 单调；门控关零行为；
//   未登记宿主不误报。实例侧接收：epoch 单调去重 + 本地目录视图缓存失效（探针重置）。
// - accountFamily：账号族键解析（customerNumber 优先/email 回退/null=未知）+ 跨账号
//   名单判定（未知身份保守归类同账号——保持 R3 缺省聚合行为不变）。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// electron 仅在桥广播路径使用（BrowserWindow.getAllWindows）——mock 掉使 main 侧
// 模块可在 node 测试进程导入执行（omnicodeBatch4GlobalPrefs.test.ts 同款约定）。
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import {
  filterOmnicodeGlobalPrefsFromPatch,
  sanitizeOmnicodeGlobalPrefsPayload,
} from "@zcode/shared";
import { createOmnicodeRemoteAggregateHost } from "../src/main/omnicode/remoteAggregateHost.js";
import {
  broadcastOmnicodeRemoteHostAnnounce,
  getOmnicodeRemoteWorkspaceDirectoryView,
  handleOmnicodeRemoteAggregateInstanceDisconnected,
  handleOmnicodeRemoteWorkspaceListUplink,
  noteOmnicodeRemoteAggregateHostInstance,
  resetOmnicodeRemoteForwardHostForTest,
  setupOmnicodeRemoteForwardHost,
  type OmnicodeRemoteForwardHostDeps,
} from "../src/main/omnicode/remoteForwardHost.js";
import {
  handleOmnicodeRemoteHostAnnounce,
  handleOmnicodeRemoteWorkspaceListRequest,
  notifyOmnicodeRemoteWorkspaceSnapshotChanged,
  resetOmnicodeRemoteHostAnnounceForTest,
  setOmnicodeRemoteWorkspaceSnapshotProvider,
} from "../src/main/omnicode/remoteForwardInstance.js";
import {
  getOmnicodeRemoteCrossAccountPref,
  handleOmnicodeGlobalPrefsApplyCommand,
  handleOmnicodeGlobalPrefsReportFromInstance,
  initOmnicodeGlobalPrefsCoordinator,
  mergeOmnicodeGlobalPrefsIntoSettingsFile,
  readOmnicodeGlobalPrefsSidecarRemoteCrossAccount,
  resetOmnicodeGlobalPrefsCoordinatorForTest,
  resetOmnicodeRemoteCrossAccountPrefForTest,
  seedOmnicodeRemoteCrossAccountPrefFromSidecar,
  setOmnicodeRemoteCrossAccountPref,
} from "../src/main/omnicode/globalPrefs.js";
import {
  listOmnicodeCrossAccountProfileIds,
  resetOmnicodeAccountFamilyForTest,
  resolveOmnicodeAccountFamilyKey,
  setOmnicodeAccountFamilyKeysForTest,
} from "../src/main/omnicode/accountFamily.js";
import { OMNICODE_GLOBAL_PREFS_SIDECAR_FILE } from "../src/main/omnicode/globalPrefs.js";

const HOST_INSTANCE = "phosthost1";
const INSTANCE_A = "paaaaaaaa";
const INSTANCE_B = "pbbbbbbbb";

const instanceEntry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  workspacePath: "F:\\inst-a",
  label: "inst-a",
  kind: "local",
  ...overrides,
});

/** 装配即目录查询（R3 语义）会在 sentCommands 前段出现——断言只看 announce 命令。 */
function announceCommands(
  deps: ForwardDepsState,
): { profileId: string; command: Record<string, unknown> }[] {
  return deps.sentCommands.filter((item) => item.command.type === "remoteHostAnnounce");
}

interface ForwardDepsState {
  sentCommands: { profileId: string; command: Record<string, unknown> }[];
  hostExitNotified: string[];
}

function createForwardDeps(
  overrides: Partial<OmnicodeRemoteForwardHostDeps> = {},
): OmnicodeRemoteForwardHostDeps & ForwardDepsState {
  const state: { sentCommands: ForwardDepsState["sentCommands"]; hostExit: string[] } = {
    sentCommands: [],
    hostExit: [],
  };
  const deps = {
    get sentCommands() {
      return state.sentCommands;
    },
    get hostExitNotified() {
      return state.hostExit;
    },
    sendCommand: (profileId: string, command: unknown) => {
      state.sentCommands.push({ profileId, command: command as Record<string, unknown> });
      return true;
    },
    getConnectedProfileIds: () => [INSTANCE_A, INSTANCE_B],
    onAggregateHostExit: (profileId: string) => {
      state.hostExit.push(profileId);
    },
    onWorkspacesChanged: () => undefined,
    nowMs: () => 1_000_000,
    // 测试环境 flavor 非 omnicode（编译期常量）→ 缺省门控恒 false；用例显式开启门控。
    isAggregateEnabled: () => true,
    ...overrides,
  };
  return deps as OmnicodeRemoteForwardHostDeps & ForwardDepsState;
}

afterEach(() => {
  resetOmnicodeRemoteForwardHostForTest();
  resetOmnicodeGlobalPrefsCoordinatorForTest();
  resetOmnicodeRemoteCrossAccountPrefForTest();
  resetOmnicodeAccountFamilyForTest();
  resetOmnicodeRemoteHostAnnounceForTest();
  setOmnicodeRemoteWorkspaceSnapshotProvider(null);
  vi.restoreAllMocks();
});

// ─── 跨账号开关过滤分支（目录视图 deps → R1 聚合参数） ───

describe("丙1 R4 跨账号开关：目录视图过滤分支", () => {
  it("开关开 + 跨账号名单：跨账号条目在（sourceCrossAccount 徽标）；同账号条目不受影响", () => {
    const deps = createForwardDeps({
      readCrossAccountAggregation: () => true,
      listCrossAccountProfileIds: () => [INSTANCE_B],
    });
    setupOmnicodeRemoteForwardHost(deps);
    handleOmnicodeRemoteWorkspaceListUplink(INSTANCE_A, {
      type: "remoteWorkspaceListReport",
      entries: [instanceEntry({ workspacePath: "F:\\same", label: "same" }) as never],
    });
    handleOmnicodeRemoteWorkspaceListUplink(INSTANCE_B, {
      type: "remoteWorkspaceListReport",
      entries: [instanceEntry({ workspacePath: "F:\\cross", label: "cross" }) as never],
    });

    const host = createOmnicodeRemoteAggregateHost({ directory: getOmnicodeRemoteWorkspaceDirectoryView() });
    const aggregated = host.listAggregatedWorkspaces([[1, []]], 1);
    const crossEntry = aggregated.find((entry) => entry.workspacePath === "F:\\cross");
    expect(crossEntry).toBeDefined();
    expect(crossEntry?.sourceProfileId).toBe(INSTANCE_B);
    expect(crossEntry?.sourceCrossAccount).toBe(true);
    expect(aggregated.find((entry) => entry.workspacePath === "F:\\same")).toBeDefined();
    // 合并序（spec §5）：宿主自身 → 同账号（A 先）→ 跨账号（B 最后）。
    expect(aggregated.map((entry) => entry.workspacePath)).toEqual(["F:\\same", "F:\\cross"]);
  });

  it("开关关（缺省）：跨账号条目剔除，同账号条目保留（spec §7 默认关 = 仅同账号聚合）", () => {
    const deps = createForwardDeps({
      readCrossAccountAggregation: () => false,
      listCrossAccountProfileIds: () => [INSTANCE_B],
    });
    setupOmnicodeRemoteForwardHost(deps);
    handleOmnicodeRemoteWorkspaceListUplink(INSTANCE_A, {
      type: "remoteWorkspaceListReport",
      entries: [instanceEntry({ workspacePath: "F:\\same", label: "same" }) as never],
    });
    handleOmnicodeRemoteWorkspaceListUplink(INSTANCE_B, {
      type: "remoteWorkspaceListReport",
      entries: [instanceEntry({ workspacePath: "F:\\cross", label: "cross" }) as never],
    });

    const host = createOmnicodeRemoteAggregateHost({ directory: getOmnicodeRemoteWorkspaceDirectoryView() });
    const aggregated = host.listAggregatedWorkspaces([[1, []]], 1);
    expect(aggregated.map((entry) => entry.workspacePath)).toEqual(["F:\\same"]);
    expect(aggregated.some((entry) => entry.sourceCrossAccount === true)).toBe(false);
  });

  it("名单缺省恒空 + 开关缺省恒 false（R3 缺省行为逐字不变：全部按同账号聚合）", () => {
    const deps = createForwardDeps();
    setupOmnicodeRemoteForwardHost(deps);
    const view = getOmnicodeRemoteWorkspaceDirectoryView();
    expect(view.isCrossAccountAggregationEnabled()).toBe(false);
    expect(view.listCrossAccountProfileIds()).toEqual([]);
  });

  it("门控关：目录视图恒空恒关（开关开也零条目，spec §7 开关语义）", () => {
    const deps = createForwardDeps({
      isAggregateEnabled: () => false,
      readCrossAccountAggregation: () => true,
      listCrossAccountProfileIds: () => [INSTANCE_B],
    });
    setupOmnicodeRemoteForwardHost(deps);
    handleOmnicodeRemoteWorkspaceListUplink(INSTANCE_B, {
      type: "remoteWorkspaceListReport",
      entries: [instanceEntry() as never],
    });
    const view = getOmnicodeRemoteWorkspaceDirectoryView();
    expect(view.listRemoteSources()).toEqual([]);
    expect(view.isCrossAccountAggregationEnabled()).toBe(false);
    expect(view.listCrossAccountProfileIds()).toEqual([]);
  });
});

// ─── 开关键链路（shared 消毒 + 侧车 + 下行/上行 + spawn 排除） ───

describe("丙1 R4 跨账号开关：omnicodeGlobalPrefs 键链路", () => {
  const BINDINGS = { "workspace.toggleSidebar": ["Ctrl+B"] };

  it("shared 消毒：布尔键保留；非布尔/白名单外敏感键一律丢弃", () => {
    expect(sanitizeOmnicodeGlobalPrefsPayload({ omnicodeRemoteCrossAccount: true })).toEqual({
      omnicodeRemoteCrossAccount: true,
    });
    expect(sanitizeOmnicodeGlobalPrefsPayload({ omnicodeRemoteCrossAccount: "yes" })).toEqual({});
    expect(
      sanitizeOmnicodeGlobalPrefsPayload({ omnicodeRemoteCrossAccount: true, dataBaseDir: "C:/leak" }),
    ).toEqual({ omnicodeRemoteCrossAccount: true });
    const filtered = filterOmnicodeGlobalPrefsFromPatch({
      omnicodeRemoteCrossAccount: false,
      providerFamilyDomain: "team",
      webRemoteControlRelayV2Device: { deviceId: "d" },
      __proto__: { polluted: true },
    });
    expect(filtered).toEqual({ omnicodeRemoteCrossAccount: false });
  });

  it("管理器 setter：缓存即时生效 + 侧车落盘 + 下行广播携带该键", async () => {
    const sidecarRoot = mkdtempSync(join(tmpdir(), "omnicode-r4-"));
    process.env.ZCODE_DATA_BASE_DIR = sidecarRoot;
    try {
      const applies: { profileId: string; prefs: Record<string, unknown> }[] = [];
      initOmnicodeGlobalPrefsCoordinator({
        identity: "manager",
        getOwnProfileId: () => "",
        getSettings: async () => ({}),
        updateSettings: async () => undefined,
        injectStateBroadcast: () => true,
        sendApplyToInstance: (profileId, command) => {
          applies.push({ profileId, prefs: command.prefs as Record<string, unknown> });
          return true;
        },
        getConnectedInstanceProfileIds: () => [INSTANCE_A],
        sendReportToManager: () => true,
        refreshShortcutApplication: () => undefined,
        resolveCurrentApplicationLocale: () => "en-US",
        logger: { info: () => undefined, warn: () => undefined },
      });

      expect(getOmnicodeRemoteCrossAccountPref()).toBe(false);
      await setOmnicodeRemoteCrossAccountPref(true);
      expect(getOmnicodeRemoteCrossAccountPref()).toBe(true);
      const sidecarPath = join(sidecarRoot, OMNICODE_GLOBAL_PREFS_SIDECAR_FILE);
      expect(existsSync(sidecarPath)).toBe(true);
      expect(JSON.parse(readFileSync(sidecarPath, "utf8"))).toMatchObject({
        version: 1,
        omnicodeRemoteCrossAccount: true,
      });
      expect(applies).toEqual([
        { profileId: INSTANCE_A, prefs: { omnicodeRemoteCrossAccount: true } },
      ]);

      // 装配即 seed 侧车（新协调器实例从持久层收敛缓存值）
      resetOmnicodeGlobalPrefsCoordinatorForTest();
      resetOmnicodeRemoteCrossAccountPrefForTest();
      expect(getOmnicodeRemoteCrossAccountPref()).toBe(false);
      await seedOmnicodeRemoteCrossAccountPrefFromSidecar();
      expect(getOmnicodeRemoteCrossAccountPref()).toBe(true);
      expect(await readOmnicodeGlobalPrefsSidecarRemoteCrossAccount()).toBe(true);
    } finally {
      rmSync(sidecarRoot, { recursive: true, force: true });
      delete process.env.ZCODE_DATA_BASE_DIR;
    }
  });

  it("实例下行 applyGlobalPrefs：键进内存缓存（实例读取端经既有下发链到达）", async () => {
    const updates: Record<string, unknown>[] = [];
    initOmnicodeGlobalPrefsCoordinator({
      identity: "instance",
      getOwnProfileId: () => INSTANCE_A,
      getSettings: async () => ({}),
      updateSettings: async (patch) => {
        updates.push(patch);
      },
      injectStateBroadcast: () => true,
      sendApplyToInstance: () => true,
      getConnectedInstanceProfileIds: () => [],
      sendReportToManager: () => true,
      refreshShortcutApplication: () => undefined,
      resolveCurrentApplicationLocale: () => "en-US",
      logger: { info: () => undefined, warn: () => undefined },
    });
    const result = await handleOmnicodeGlobalPrefsApplyCommand(
      { omnicodeRemoteCrossAccount: true, shortcutBindings: BINDINGS },
      "manager",
    );
    expect(result.status).toBe("applied");
    // 开关不进 setting.json（schema strip 红线），热应用 = 内存缓存更新
    expect(updates).toEqual([{ shortcutBindings: BINDINGS }]);
    expect(result.appliedKeys).toEqual(["shortcutBindings"]);
    expect(getOmnicodeRemoteCrossAccountPref()).toBe(true);
  });

  it("管理器上行 reportGlobalPrefs：开关落侧车 + 下行广播携带该键", async () => {
    const sidecarRoot = mkdtempSync(join(tmpdir(), "omnicode-r4-"));
    process.env.ZCODE_DATA_BASE_DIR = sidecarRoot;
    try {
      const applies: { profileId: string; prefs: Record<string, unknown>; sourceInstanceId: string }[] = [];
      initOmnicodeGlobalPrefsCoordinator({
        identity: "manager",
        getOwnProfileId: () => "",
        getSettings: async () => ({}),
        updateSettings: async () => undefined,
        injectStateBroadcast: () => true,
        sendApplyToInstance: (profileId, command) => {
          applies.push({
            profileId,
            prefs: command.prefs as Record<string, unknown>,
            sourceInstanceId: command.sourceInstanceId,
          });
          return true;
        },
        getConnectedInstanceProfileIds: () => [INSTANCE_A, INSTANCE_B],
        sendReportToManager: () => true,
        refreshShortcutApplication: () => undefined,
        resolveCurrentApplicationLocale: () => "en-US",
        logger: { info: () => undefined, warn: () => undefined },
      });
      const result = await handleOmnicodeGlobalPrefsReportFromInstance(
        { omnicodeRemoteCrossAccount: true },
        INSTANCE_A,
      );
      expect(result.status).toBe("applied");
      expect(result.appliedKeys).toEqual(["omnicodeRemoteCrossAccount"]);
      expect(getOmnicodeRemoteCrossAccountPref()).toBe(true);
      // 下行广播带源实例 id（环形抑制在源实例侧裁决）
      expect(applies).toEqual([
        {
          profileId: INSTANCE_A,
          prefs: { omnicodeRemoteCrossAccount: true },
          sourceInstanceId: INSTANCE_A,
        },
        {
          profileId: INSTANCE_B,
          prefs: { omnicodeRemoteCrossAccount: true },
          sourceInstanceId: INSTANCE_A,
        },
      ]);
      expect(JSON.parse(readFileSync(join(sidecarRoot, OMNICODE_GLOBAL_PREFS_SIDECAR_FILE), "utf8"))).toMatchObject({
        omnicodeRemoteCrossAccount: true,
      });
    } finally {
      rmSync(sidecarRoot, { recursive: true, force: true });
      delete process.env.ZCODE_DATA_BASE_DIR;
    }
  });

  it("spawn 注入排除：开关不进实例 setting.json（schema strip 红线——实例经连接快照收敛）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnicode-r4-"));
    const settingsFile = join(dir, "setting.json");
    try {
      writeFileSync(settingsFile, JSON.stringify({ locale: "zh-CN", customKey: "keep" }), "utf8");
      const written = await mergeOmnicodeGlobalPrefsIntoSettingsFile(settingsFile, {
        locale: "en-US",
        localePreference: "en-US",
        omnicodeRemoteCrossAccount: true,
      });
      expect(written).toEqual(["localePreference", "locale"]);
      const persisted = JSON.parse(readFileSync(settingsFile, "utf8"));
      expect(persisted).toEqual({ locale: "en-US", localePreference: "en-US", customKey: "keep" });
      expect(Object.prototype.hasOwnProperty.call(persisted, "omnicodeRemoteCrossAccount")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── accountFamily：账号族键解析 + 跨账号名单 ───

describe("丙1 R4 accountFamily：账号族快照", () => {
  it("键解析：customerNumber 优先，email 回退，双缺=未知", () => {
    expect(resolveOmnicodeAccountFamilyKey({ identity: { customerNumber: "CN-1", email: "a@b.c" } })).toBe("CN-1");
    expect(resolveOmnicodeAccountFamilyKey({ identity: { email: " a@b.c " } })).toBe("a@b.c");
    expect(resolveOmnicodeAccountFamilyKey({ identity: {} })).toBeNull();
    expect(resolveOmnicodeAccountFamilyKey({})).toBeNull();
  });

  it("名单判定：双方键齐备且不同 → 跨账号；任一侧未知 → 同账号（保守，R3 缺省行为不变）", () => {
    setOmnicodeAccountFamilyKeysForTest({
      ownKey: "CN-1",
      byProfileId: { [INSTANCE_A]: "CN-1", [INSTANCE_B]: "CN-2", "punknownx1": null },
    });
    expect(listOmnicodeCrossAccountProfileIds()).toEqual([INSTANCE_B]);

    // 管理器自身键未知 → 全部同账号（名单空）
    setOmnicodeAccountFamilyKeysForTest({ ownKey: null });
    expect(listOmnicodeCrossAccountProfileIds()).toEqual([]);

    // 实例身份未知（凭据读失败/未登录）→ 同账号保守归类
    setOmnicodeAccountFamilyKeysForTest({ ownKey: "CN-1" });
    expect(listOmnicodeCrossAccountProfileIds()).toEqual([INSTANCE_B]);
    setOmnicodeAccountFamilyKeysForTest({ byProfileId: { [INSTANCE_B]: null } });
    expect(listOmnicodeCrossAccountProfileIds()).toEqual([]);
  });
});

// ─── failover：宿主退出提示链 + remoteHostAnnounce 广播 + 实例侧视图失效 ───

describe("丙1 R4 failover：宿主退出（自动转移为二期）", () => {
  it("登记宿主退出：onAggregateHostExit 提示链触发 + announce(epoch=1) 广播剩余实例；宿主注销", () => {
    const deps = createForwardDeps();
    setupOmnicodeRemoteForwardHost(deps);
    noteOmnicodeRemoteAggregateHostInstance(HOST_INSTANCE);

    expect(handleOmnicodeRemoteAggregateInstanceDisconnected(HOST_INSTANCE)).toBe(true);
    expect(deps.hostExitNotified).toEqual([HOST_INSTANCE]);
    // 广播到达剩余已回连实例（epoch 单调起点 1；hostProfileId = 退出宿主真身）
    expect(announceCommands(deps)).toEqual([
      { profileId: INSTANCE_A, command: { type: "remoteHostAnnounce", hostProfileId: HOST_INSTANCE, epoch: 1 } },
      { profileId: INSTANCE_B, command: { type: "remoteHostAnnounce", hostProfileId: HOST_INSTANCE, epoch: 1 } },
    ]);
    // 宿主已注销：同一实例的普通断连不再触发
    expect(handleOmnicodeRemoteAggregateInstanceDisconnected(HOST_INSTANCE)).toBe(false);
    expect(announceCommands(deps)).toHaveLength(2);
  });

  it("epoch 单调递增：第二任宿主退出 → epoch=2（实例按 epoch 判新旧广播）", () => {
    const deps = createForwardDeps();
    setupOmnicodeRemoteForwardHost(deps);
    noteOmnicodeRemoteAggregateHostInstance(HOST_INSTANCE);
    expect(handleOmnicodeRemoteAggregateInstanceDisconnected(HOST_INSTANCE)).toBe(true);

    const HOST_2 = "phosthost2";
    noteOmnicodeRemoteAggregateHostInstance(HOST_2);
    expect(handleOmnicodeRemoteAggregateInstanceDisconnected(HOST_2)).toBe(true);
    expect(deps.sentCommands.filter((item) => item.command.epoch === 2)).toHaveLength(2);
    expect(announceCommands(deps).at(-1)?.command).toMatchObject({
      type: "remoteHostAnnounce",
      hostProfileId: HOST_2,
      epoch: 2,
    });
  });

  it("门控关：零提示零广播（spec §7 开关语义）", () => {
    const deps = createForwardDeps({ isAggregateEnabled: () => false });
    setupOmnicodeRemoteForwardHost(deps);
    noteOmnicodeRemoteAggregateHostInstance(HOST_INSTANCE);
    expect(handleOmnicodeRemoteAggregateInstanceDisconnected(HOST_INSTANCE)).toBe(false);
    expect(deps.hostExitNotified).toEqual([]);
    expect(deps.sentCommands).toEqual([]);
  });

  it("未登记宿主（R3 拓扑缺省宿主=管理器进程）：实例断连不误报", () => {
    const deps = createForwardDeps();
    setupOmnicodeRemoteForwardHost(deps);
    expect(handleOmnicodeRemoteAggregateInstanceDisconnected(INSTANCE_A)).toBe(false);
    expect(deps.hostExitNotified).toEqual([]);
    expect(announceCommands(deps)).toEqual([]);
  });

  it("broadcast 直发面：hostProfileId 形态非法 → 仅递增 epoch 不投递（不伪造广播面）", () => {
    const deps = createForwardDeps();
    setupOmnicodeRemoteForwardHost(deps);
    expect(broadcastOmnicodeRemoteHostAnnounce("self")).toBe(1);
    expect(announceCommands(deps)).toEqual([]);
    expect(broadcastOmnicodeRemoteHostAnnounce(HOST_INSTANCE)).toBe(2);
    expect(announceCommands(deps)).toEqual([
      { profileId: INSTANCE_A, command: { type: "remoteHostAnnounce", hostProfileId: HOST_INSTANCE, epoch: 2 } },
      { profileId: INSTANCE_B, command: { type: "remoteHostAnnounce", hostProfileId: HOST_INSTANCE, epoch: 2 } },
    ]);
    // 门控关：零递增零投递
    const gatedDeps = createForwardDeps({ isAggregateEnabled: () => false });
    setupOmnicodeRemoteForwardHost(gatedDeps);
    expect(broadcastOmnicodeRemoteHostAnnounce(HOST_INSTANCE)).toBe(0);
    expect(gatedDeps.sentCommands).toEqual([]);
  });

  it("实例侧接收：首广播接受 + 目录视图缓存失效；旧值/同值忽略；非法载荷忽略", () => {
    // memo 语义证明：探针内容变化但未经 Report 刷新时，announce 到达前 Result 应答
    // 用旧缓存；announce 到达后（视图失效）下一次应答即新快照（spec §6 视图失效）。
    let snapshotVersion = 1;
    setOmnicodeRemoteWorkspaceSnapshotProvider(() => [
      [1, [{ workspacePath: `F:\\w-v${snapshotVersion}`, label: `w-v${snapshotVersion}`, kind: "local" }]],
    ]);
    const uplink: { entries: { workspacePath: string }[] }[] = [];
    const send = (message: unknown) => {
      uplink.push(message as { entries: { workspacePath: string }[] });
      return true;
    };
    handleOmnicodeRemoteWorkspaceListRequest(
      { type: "remoteWorkspaceListRequest", requestId: "rw-00000000-0000-0000-0000-000000000001" },
      send,
    );
    expect(uplink[0]?.entries.map((entry) => entry.workspacePath)).toEqual(["F:\\w-v1"]);

    // 探针事实已变（未 Report）；announce 前 Result 仍用旧缓存，announce 后即新快照
    snapshotVersion = 2;
    expect(handleOmnicodeRemoteHostAnnounce({ type: "remoteHostAnnounce", hostProfileId: HOST_INSTANCE, epoch: 1 })).toBe(true);
    handleOmnicodeRemoteWorkspaceListRequest(
      { type: "remoteWorkspaceListRequest", requestId: "rw-00000000-0000-0000-0000-000000000002" },
      send,
    );
    expect(uplink[1]?.entries.map((entry) => entry.workspacePath)).toEqual(["F:\\w-v2"]);

    // 旧值/同值忽略（实例按 epoch 判新旧——R1 schema 注释语义）
    expect(handleOmnicodeRemoteHostAnnounce({ type: "remoteHostAnnounce", hostProfileId: HOST_INSTANCE, epoch: 1 })).toBe(false);
    expect(handleOmnicodeRemoteHostAnnounce({ type: "remoteHostAnnounce", hostProfileId: HOST_INSTANCE, epoch: 0 })).toBe(false);
    // 非法载荷（schema strict）忽略
    expect(handleOmnicodeRemoteHostAnnounce({ type: "remoteHostAnnounce", hostProfileId: "self", epoch: 5 })).toBe(false);
    expect(handleOmnicodeRemoteHostAnnounce({ type: "remoteHostAnnounce", hostProfileId: HOST_INSTANCE, epoch: 1.5 })).toBe(false);
    // 新 epoch 仍可推进
    expect(handleOmnicodeRemoteHostAnnounce({ type: "remoteHostAnnounce", hostProfileId: HOST_INSTANCE, epoch: 5 })).toBe(true);
  });

  it("实例侧 Report 现读刷新缓存：快照变化事件后 Result 无需 announce 即收敛", () => {
    let snapshotVersion = 1;
    setOmnicodeRemoteWorkspaceSnapshotProvider(() => [
      [1, [{ workspacePath: `F:\\w-v${snapshotVersion}`, label: `w-v${snapshotVersion}`, kind: "local" }]],
    ]);
    const uplink: { type: string }[] = [];
    const send = (message: unknown) => {
      uplink.push(message as { type: string });
      return true;
    };
    expect(notifyOmnicodeRemoteWorkspaceSnapshotChanged(send)).toBe(true);
    // 快照变化 → 下一拍 Report（syncWebRemoteControlWorkspaces 既有链）现读刷新缓存
    snapshotVersion = 2;
    expect(notifyOmnicodeRemoteWorkspaceSnapshotChanged(send)).toBe(true);
    handleOmnicodeRemoteWorkspaceListRequest(
      { type: "remoteWorkspaceListRequest", requestId: "rw-00000000-0000-0000-0000-000000000003" },
      send,
    );
    const result = uplink.at(-1) as { type: string; entries: { workspacePath: string }[] };
    expect(result.type).toBe("remoteWorkspaceListResult");
    expect(result.entries.map((entry) => entry.workspacePath)).toEqual(["F:\\w-v2"]);
  });
});
