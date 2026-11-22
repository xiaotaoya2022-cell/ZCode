// [OmniCode] 丙1 远程聚合 R2 单测（spec: docs/omnicode/remote-aggregation.md §3/§5/§8-R2）：
// - 门控判定 isOmnicodeRemoteAggregateHostEnabled：flavor=omnicode ∧ 开关 env 双条件，
//   官方 flavor / 未设开关恒 false（官方行为零影响的门控基点）。
// - 聚合装配 listAggregatedWorkspaces：self=呈现窗口 → 其余窗口 id 升序、组内保序、
//   aggregatedKey 前缀口径（self / String(windowId)）、同键保留首个、官方附加字段
//   （connectionState/lastConnectionError）passthrough 原样保留。
// - 反查路由 resolveRoute / resolveTargetWindowId：aggregatedKey 精确优先、原始 key
//   （identity||path）次之；self 前缀回呈现窗口；未命中 undefined（回官方路径）。
// - manager 注入层（门控开/关对照）：bootstrap/workspace-list 聚合呈现、跨窗口
//   bridge-open 反查路由（attachment 挂目标窗口、ready 帧经本窗口 transport 回程）、
//   路由失败回结构化 workspace-bridge-error、窗口快照同步聚合广播、reconnect 反查。
//   仿 desktop 注入风格：fake deps + 注入 transport/attachment 捕获，无真实 relay。
import { describe, expect, it, vi } from "vitest";
import {
  webRemoteControlPlatformMethodSchema,
  type WebRemoteControlWorkspaceTarget,
} from "@zcode/shared";
import {
  ZCODE_OMNICODE_REMOTE_AGGREGATE_ENV,
  createOmnicodeRemoteAggregateHost,
  isOmnicodeRemoteAggregateHostEnabled,
  type OmnicodeRemoteAggregateHost,
} from "../src/main/omnicode/remoteAggregateHost.js";
import {
  createWebRemoteControlManager,
  type WebRemoteControlManagerDependencies,
} from "../src/main/webRemoteControlManager.js";

const workspace = (
  overrides: Partial<WebRemoteControlWorkspaceTarget> = {},
): WebRemoteControlWorkspaceTarget => ({
  workspacePath: "F:\\w",
  label: "w",
  kind: "local",
  ...overrides,
});

describe("丙1 R2 聚合宿主门控 isOmnicodeRemoteAggregateHostEnabled", () => {
  it("官方 flavor 恒 false；omnicode flavor 需显式开关 env=1（默认关）", () => {
    expect(isOmnicodeRemoteAggregateHostEnabled("zcode", {})).toBe(false);
    expect(isOmnicodeRemoteAggregateHostEnabled("production", {})).toBe(false);
    expect(isOmnicodeRemoteAggregateHostEnabled("omnicode", {})).toBe(false);
    expect(isOmnicodeRemoteAggregateHostEnabled("omnicode", { [ZCODE_OMNICODE_REMOTE_AGGREGATE_ENV]: "0" })).toBe(false);
    expect(isOmnicodeRemoteAggregateHostEnabled("omnicode", { [ZCODE_OMNICODE_REMOTE_AGGREGATE_ENV]: "1" })).toBe(true);
  });

  it("createOmnicodeRemoteAggregateHost().isEnabled()：测试环境（非 omnicode flavor）默认关", () => {
    expect(createOmnicodeRemoteAggregateHost().isEnabled()).toBe(false);
  });
});

describe("丙1 R2 聚合装配 listAggregatedWorkspaces", () => {
  const host = createOmnicodeRemoteAggregateHost();
  const snapshots = new Map<number, WebRemoteControlWorkspaceTarget[]>([
    [3, [workspace({ workspacePath: "F:\\w3a" }), workspace({ workspacePath: "F:\\w3b" })]],
    [1, [workspace({ workspacePath: "F:\\w1a" })]],
    [2, [workspace({ workspacePath: "F:\\w2a", workspaceIdentity: "ssh-2" })]],
  ]);

  it("self=呈现窗口组在前，其余窗口按 id 升序；aggregatedKey 口径 self:/窗口id:", () => {
    const aggregated = host.listAggregatedWorkspaces(snapshots, 1);
    expect(aggregated.map((item) => item.aggregatedKey)).toEqual([
      "self:F:\\w1a",
      "2:ssh-2",
      "3:F:\\w3a",
      "3:F:\\w3b",
    ]);
    expect(aggregated[0]).toMatchObject({ sourceProfileId: "self", workspacePath: "F:\\w1a" });
    expect(aggregated[1]).toMatchObject({ sourceProfileId: "2", workspaceIdentity: "ssh-2" });
  });

  it("组内保持窗口快照原序；呈现窗口缺快照时 self 组为空不报错（其余窗口仍以窗口 id 前缀出现）", () => {
    const aggregated = host.listAggregatedWorkspaces(snapshots, 2);
    expect(aggregated.map((item) => item.aggregatedKey)).toEqual([
      "self:ssh-2",
      "1:F:\\w1a",
      "3:F:\\w3a",
      "3:F:\\w3b",
    ]);
    const missingPresenter = host.listAggregatedWorkspaces(
      new Map([[9, [workspace({ workspacePath: "F:\\x" })]]]),
      1,
    );
    expect(missingPresenter).toHaveLength(1);
    expect(missingPresenter[0]).toMatchObject({
      aggregatedKey: "9:F:\\x",
      sourceProfileId: "9",
    });
  });

  it("官方附加字段（connectionState/lastConnectionError）passthrough 原样保留；同键保留首个", () => {
    const aggregated = host.listAggregatedWorkspaces(
      new Map([
        [
          1,
          [
            workspace({ workspacePath: "F:\\a", connectionState: "disconnected", lastConnectionError: "boom" }),
            workspace({ workspacePath: "F:\\a", label: "dup" }),
          ],
        ],
      ]),
      1,
    );
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0]).toMatchObject({
      aggregatedKey: "self:F:\\a",
      connectionState: "disconnected",
      lastConnectionError: "boom",
      label: "w",
    });
  });
});

describe("丙1 R2 反查路由 resolveRoute / resolveTargetWindowId", () => {
  const host = createOmnicodeRemoteAggregateHost();
  const snapshots = new Map<number, WebRemoteControlWorkspaceTarget[]>([
    [1, [workspace({ workspacePath: "F:\\w1" })]],
    [2, [workspace({ workspacePath: "F:\\w2", workspaceIdentity: "ssh-2" })]],
  ]);

  it("aggregatedKey 精确命中：self 前缀回呈现窗口；窗口 id 前缀回该窗口", () => {
    expect(host.resolveRoute(snapshots, 1, "self:F:\\w1")).toMatchObject({ windowId: 1 });
    expect(host.resolveRoute(snapshots, 1, "2:ssh-2")?.windowId).toBe(2);
  });

  it("原始 key（identity||path）命中：同聚合列表口径，self 条目回呈现窗口", () => {
    expect(host.resolveRoute(snapshots, 1, "F:\\w1")).toMatchObject({ windowId: 1 });
    // workspaceIdentity 去空白优先（与 resolveWebRemoteControlWorkspaceKey 同口径）：
    // 该条目的 key 是 ssh-2，路径不是 key（手机页按官方 key 回显）
    expect(host.resolveRoute(snapshots, 1, "ssh-2")?.windowId).toBe(2);
    expect(host.resolveRoute(snapshots, 1, "F:\\w2")).toBeUndefined();
  });

  it("未命中返回 undefined（调用方回官方路径）；resolveTargetWindowId 按目标反查", () => {
    expect(host.resolveRoute(snapshots, 1, "F:\\missing")).toBeUndefined();
    expect(
      host.resolveTargetWindowId(snapshots, 1, { workspacePath: "F:\\w2", workspaceIdentity: "ssh-2" }),
    ).toBe(2);
    expect(host.resolveTargetWindowId(snapshots, 1, { workspacePath: "F:\\none" })).toBeUndefined();
    expect(host.resolveTargetWindowId(snapshots, 1, { workspacePath: "F:\\w1" })).toBe(1);
  });
});

// ─── manager 注入层（门控开/关对照；fake deps + transport/attachment 捕获） ───

interface ManagerHarness {
  sent: Array<{ zcode_type: string } & Record<string, unknown>>;
  attached: Array<{ windowId: number; workspacePath: string }>;
  reconnectWorkspace: ReturnType<typeof vi.fn>;
  transportOptions: {
    onPayload: (payload: unknown) => void;
    onStateChange: (state: string) => void;
  } | null;
}

function createManagerHarness(
  omnicodeAggregateHost?: OmnicodeRemoteAggregateHost,
): { manager: ReturnType<typeof createWebRemoteControlManager>; harness: ManagerHarness } {
  const harness: ManagerHarness = {
    sent: [],
    attached: [],
    reconnectWorkspace: vi.fn(async () => {}),
    transportOptions: null,
  };
  // wrapElectronPort 直接调用原始 MessagePortMain API（on/off/postMessage/start/close）
  const fakePort = {
    on: () => {},
    off: () => {},
    postMessage: () => {},
    start: () => {},
    close: () => {},
  };
  const dependencies: WebRemoteControlManagerDependencies = {
    relayWsUrl: "wss://relay.example",
    mobileRemoteControlUrl: "https://mobile.example",
    deviceMid: "mid-test",
    deviceName: "test-host",
    appVersion: "1.0.0",
    getLogin: async () => ({ userId: "user-1", jwt: "jwt-test" }),
    deviceStorage: {
      load: async () => undefined,
      save: async () => {},
      clearLegacy: async () => {},
    },
    startupRestoreStorageProvider: {
      load: async () => undefined,
      save: async () => {},
      clear: async () => {},
    },
    featureGate: { isEnabled: () => true, assertEnabled: () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    platformHandlers: Object.fromEntries(
      webRemoteControlPlatformMethodSchema.options.map((method) => [method, async () => ({})]),
    ) as WebRemoteControlManagerDependencies["platformHandlers"],
    reconnectWorkspace: harness.reconnectWorkspace,
    attachWorkspaceHost: async (windowId, context) => {
      harness.attached.push({ windowId, workspacePath: context.workspacePath });
      return {
        entryId: `desktop-host:${windowId}`,
        attachmentId: `att-${harness.attached.length}`,
        process: {} as never,
        port: fakePort as never,
      };
    },
    setTerminalOwner: () => {},
    releaseWorkspaceHostAttachment: () => {},
    disposeWorkspaceHostAttachmentsForWindow: () => {},
    disposeWorkspaceHostAttachmentsForRemoteSession: () => {},
    createDeviceTransport: (options) => {
      harness.transportOptions = options as unknown as ManagerHarness["transportOptions"];
      return {
        start: () => {
          harness.transportOptions?.onStateChange("waiting_terminal");
        },
        sendPayload: () => false,
        sendPayloadResult: (payload) => {
          harness.sent.push(payload as { zcode_type: string } & Record<string, unknown>);
          return { kind: "sent", bytes: 16 };
        },
        measurePayloadBytes: () => 16,
        dispose: () => {},
      };
    },
    ...(omnicodeAggregateHost ? { omnicodeAggregateHost } : {}),
  };
  return { manager: createWebRemoteControlManager(dependencies), harness };
}

// 测试环境 flavor 非 omnicode（ZCODE_PRODUCT_FLAVOR 为编译期常量 fallback），
// manager 注入用例显式开启门控（模块函数本体仍用真实实现，只替换门控判定）。
const gatedHost: OmnicodeRemoteAggregateHost = {
  ...createOmnicodeRemoteAggregateHost(),
  isEnabled: () => true,
};

async function startPresenter(
  manager: ReturnType<typeof createWebRemoteControlManager>,
  windowId = 1,
): Promise<void> {
  await manager.start(windowId, { workspacePath: "F:\\w1" });
}

describe("丙1 R2 manager 注入：门控开聚合呈现", () => {
  it("bootstrap-request 返回聚合列表：本窗口 self 条目 + 其他窗口条目（官方字段原样+附加区）", async () => {
    const { manager, harness } = createManagerHarness(gatedHost);
    await startPresenter(manager);
    manager.syncAvailableWorkspaces(1, [workspace({ workspacePath: "F:\\w1" })]);
    manager.syncAvailableWorkspaces(
      2,
      [workspace({ workspacePath: "F:\\w2", workspaceIdentity: "ssh-2" })],
    );
    harness.transportOptions?.onPayload({ zcode_type: "bootstrap-request", requestId: "req-1" });

    const response = harness.sent[harness.sent.length - 1];
    expect(response).toMatchObject({ zcode_type: "bootstrap-response", requestId: "req-1" });
    const workspaces = (
      response.result as { workspaces: WebRemoteControlWorkspaceTarget[] }
    ).workspaces;
    expect(workspaces).toHaveLength(2);
    // 官方字段原样（手机页渲染语义不变）+ 聚合附加区（官方页面忽略未知字段）
    expect(workspaces[0]).toMatchObject({ workspacePath: "F:\\w1", kind: "local", label: "w" });
    expect(workspaces[1]).toMatchObject({
      workspacePath: "F:\\w2",
      workspaceIdentity: "ssh-2",
      label: "w",
      kind: "local",
    });
    expect(workspaces[1]).toHaveProperty("aggregatedKey", "2:ssh-2");
    expect(workspaces[1]).toHaveProperty("sourceProfileId", "2");
  });

  it("workspace-list-request 聚合响应；窗口快照变化触发 workspace-list-updated 聚合广播（签名去重）", async () => {
    const { manager, harness } = createManagerHarness(gatedHost);
    await startPresenter(manager);
    manager.syncAvailableWorkspaces(1, [workspace({ workspacePath: "F:\\w1" })]);
    harness.transportOptions?.onPayload({
      zcode_type: "workspace-list-request",
      requestId: "req-2",
    });
    const listResponse = harness.sent[harness.sent.length - 1];
    expect(listResponse).toMatchObject({ zcode_type: "workspace-list-response" });
    expect((listResponse.result as { workspaces: unknown[] }).workspaces).toHaveLength(1);

    const updatedBefore = harness.sent.filter((p) => p.zcode_type === "workspace-list-updated");
    manager.syncAvailableWorkspaces(2, [workspace({ workspacePath: "F:\\w2" })]);
    const updatedAfter = harness.sent.filter((p) => p.zcode_type === "workspace-list-updated");
    // 窗口 2 快照同步 → 活动聚合 runtime 收到 workspace-list-updated（含窗口 2 条目）
    expect(updatedAfter.length).toBe(updatedBefore.length + 1);
    const broadcast = updatedAfter[updatedAfter.length - 1];
    expect((broadcast.result as { workspaces: Array<Record<string, unknown>> }).workspaces).toEqual(
      [
        expect.objectContaining({ aggregatedKey: "self:F:\\w1" }),
        expect.objectContaining({ aggregatedKey: "2:F:\\w2" }),
      ],
    );

    // 同一快照重复同步：签名去重，不产生新推送
    manager.syncAvailableWorkspaces(2, [workspace({ workspacePath: "F:\\w2" })]);
    expect(harness.sent.filter((p) => p.zcode_type === "workspace-list-updated")).toHaveLength(
      updatedAfter.length,
    );
  });

  it("窗口 dispose：被聚合条目从聚合列表摘除并推送（spec §6 对账语义 M2 形态）", async () => {
    const { manager, harness } = createManagerHarness(gatedHost);
    await startPresenter(manager);
    manager.syncAvailableWorkspaces(1, [workspace({ workspacePath: "F:\\w1" })]);
    manager.syncAvailableWorkspaces(2, [workspace({ workspacePath: "F:\\w2" })]);
    const before = harness.sent.filter((p) => p.zcode_type === "workspace-list-updated").length;
    await manager.disposeWindow(2);
    const after = harness.sent.filter((p) => p.zcode_type === "workspace-list-updated");
    expect(after.length).toBe(before + 1);
    const disposal = after[after.length - 1];
    expect((disposal.result as { workspaces: Array<Record<string, unknown>> }).workspaces).toEqual([
      expect.objectContaining({ aggregatedKey: "self:F:\\w1" }),
    ]);
  });
});

describe("丙1 R2 manager 注入：bridge-open 跨窗口路由", () => {
  const openBridge = (harness: ManagerHarness, workspaceKey: string): void => {
    harness.transportOptions?.onPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-open",
      bridgeSessionId: "bs-1",
      workspaceKey,
    });
  };

  it("其他窗口条目：attachment 挂目标窗口 runtime；ready 帧经本窗口 transport 回程", async () => {
    const { manager, harness } = createManagerHarness(gatedHost);
    await startPresenter(manager);
    manager.syncAvailableWorkspaces(1, [workspace({ workspacePath: "F:\\w1" })]);
    manager.syncAvailableWorkspaces(2, [workspace({ workspacePath: "F:\\w2" })]);
    openBridge(harness, "F:\\w2");

    await vi.waitFor(() => {
      expect(harness.sent.some((p) => p.zcode_type === "workspace-bridge-ready")).toBe(true);
    });
    // 路由命中窗口 2：attachment 以窗口 2 的 windowId 挂载（rpc-frame 由宿主 transport 透传）
    expect(harness.attached).toEqual([
      { windowId: 2, workspacePath: "F:\\w2" },
    ]);
    const ready = harness.sent.find((p) => p.zcode_type === "workspace-bridge-ready");
    expect(ready).toMatchObject({ requestId: "req-open", bridgeSessionId: "bs-1" });
    expect((ready as { bridge: { workspaceKey?: string } }).bridge.workspaceKey).toBe("F:\\w2");
  });

  it("本窗口条目（self 前缀/原始 key）：官方路径等价（attachment 挂本窗口）", async () => {
    const { manager, harness } = createManagerHarness(gatedHost);
    await startPresenter(manager);
    manager.syncAvailableWorkspaces(1, [workspace({ workspacePath: "F:\\w1" })]);
    openBridge(harness, "F:\\w1");

    await vi.waitFor(() => {
      expect(harness.sent.some((p) => p.zcode_type === "workspace-bridge-ready")).toBe(true);
    });
    expect(harness.attached).toEqual([{ windowId: 1, workspacePath: "F:\\w1" }]);
  });

  it("未知键路由失败：回结构化 workspace-bridge-error（不瘫；reason=官方查找失败口径）", async () => {
    const { manager, harness } = createManagerHarness(gatedHost);
    await startPresenter(manager);
    manager.syncAvailableWorkspaces(1, [workspace({ workspacePath: "F:\\w1" })]);
    manager.syncAvailableWorkspaces(2, [workspace({ workspacePath: "F:\\w2" })]);
    openBridge(harness, "F:\\missing");

    await vi.waitFor(() => {
      expect(harness.sent.some((p) => p.zcode_type === "workspace-bridge-error")).toBe(true);
    });
    expect(harness.attached).toEqual([]);
    const error = harness.sent.find((p) => p.zcode_type === "workspace-bridge-error");
    expect(error).toMatchObject({
      requestId: "req-open",
      bridgeSessionId: "bs-1",
      reason: "unexpected-error",
    });
  });

  it("workspace-reconnect-request 反查目标窗口执行；本窗口条目走官方窗口", async () => {
    const { manager, harness } = createManagerHarness(gatedHost);
    await startPresenter(manager);
    manager.syncAvailableWorkspaces(1, [workspace({ workspacePath: "F:\\w1" })]);
    manager.syncAvailableWorkspaces(2, [workspace({ workspacePath: "F:\\w2" })]);
    harness.transportOptions?.onPayload({
      zcode_type: "workspace-reconnect-request",
      requestId: "req-rc",
      workspaceKey: "F:\\w2",
    });
    await vi.waitFor(() => expect(harness.reconnectWorkspace).toHaveBeenCalled());
    expect(harness.reconnectWorkspace.mock.calls[0]).toEqual([2, "F:\\w2"]);

    harness.transportOptions?.onPayload({
      zcode_type: "workspace-reconnect-request",
      requestId: "req-rc2",
      workspaceKey: "F:\\w1",
    });
    await vi.waitFor(() => expect(harness.reconnectWorkspace).toHaveBeenCalledTimes(2));
    expect(harness.reconnectWorkspace.mock.calls[1]).toEqual([1, "F:\\w1"]);
  });
});

describe("丙1 R2 manager 注入：门控关=官方单窗口路径逐字不变", () => {
  it("不注入聚合宿主：bootstrap 仅返回本窗口条目；其他窗口条目不出现在列表", async () => {
    const { manager, harness } = createManagerHarness();
    await startPresenter(manager);
    manager.syncAvailableWorkspaces(1, [workspace({ workspacePath: "F:\\w1" })]);
    manager.syncAvailableWorkspaces(2, [workspace({ workspacePath: "F:\\w2" })]);
    harness.transportOptions?.onPayload({ zcode_type: "bootstrap-request", requestId: "req-3" });

    const response = harness.sent[harness.sent.length - 1];
    expect(response).toMatchObject({ zcode_type: "bootstrap-response", requestId: "req-3" });
    const workspaces = (
      response.result as { workspaces: WebRemoteControlWorkspaceTarget[] }
    ).workspaces;
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toEqual({ workspacePath: "F:\\w1", label: "w", kind: "local" });
    expect(workspaces[0]).not.toHaveProperty("aggregatedKey");
  });

  it("不注入聚合宿主：跨窗口键 bridge-open 按官方路径失败回结构化 error", async () => {
    const { manager, harness } = createManagerHarness();
    await startPresenter(manager);
    manager.syncAvailableWorkspaces(1, [workspace({ workspacePath: "F:\\w1" })]);
    manager.syncAvailableWorkspaces(2, [workspace({ workspacePath: "F:\\w2" })]);
    harness.transportOptions?.onPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-4",
      bridgeSessionId: "bs-2",
      workspaceKey: "F:\\w2",
    });
    await vi.waitFor(() => {
      expect(harness.sent.some((p) => p.zcode_type === "workspace-bridge-error")).toBe(true);
    });
    expect(harness.attached).toEqual([]);
  });

  it("注入但门控关（isEnabled=false）：与不注入等价（聚合分支不进入）", async () => {
    const disabledHost: OmnicodeRemoteAggregateHost = {
      ...createOmnicodeRemoteAggregateHost(),
      isEnabled: () => false,
    };
    const { manager, harness } = createManagerHarness(disabledHost);
    await startPresenter(manager);
    manager.syncAvailableWorkspaces(1, [workspace({ workspacePath: "F:\\w1" })]);
    manager.syncAvailableWorkspaces(2, [workspace({ workspacePath: "F:\\w2" })]);
    harness.transportOptions?.onPayload({ zcode_type: "bootstrap-request", requestId: "req-5" });
    const workspaces = (
      harness.sent[harness.sent.length - 1].result as { workspaces: WebRemoteControlWorkspaceTarget[] }
    ).workspaces;
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).not.toHaveProperty("aggregatedKey");
  });
});
