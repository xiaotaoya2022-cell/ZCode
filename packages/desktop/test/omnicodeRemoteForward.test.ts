// [OmniCode] 丙1 远程聚合 R3 单测（spec: docs/omnicode/remote-aggregation.md §4/§5/§8-R3）：
// - shared 目录协议 schema（remoteWorkspaceListRequest/Result/Report + union）：strict
//   拒绝多余键、requestId 形态、entries 上限 200、error 摘要 120；载荷守门
//   isOmnicodeRemoteForwardPayloadWithinLimit（1MiB 官方 relay 物理帧上限，超限拒绝不分片）。
// - 被聚合实例执行器（remoteForwardInstance）：快照探针装配/缺席静默、条目 schema 兜底
//   过滤 + 200 封顶、目录查询应答（回包超限 → 结构化 error 拒绝）、快照变化报告（超限不发）。
// - 管理器转发核心（remoteForwardHost）：门控关零查询零缓存零转投；Result/Report 缓存
//   （迟到应答仍刷新）、离线摘除 + 通知、显示名解析防伪造、bridge-open 转投（真身校验/
//   离线不投递）、目录视图跨账号接口（默认关/空名单）。
// - 聚合宿主目录接入（remoteAggregateHost）：跨实例条目并入聚合列表（窗口在前实例在后）、
//   resolveRoute sourceKind=instance（windowId 缺省）、离线摘除即时反映。
// - manager 注入层（门控开/关对照）：聚合列表含实例条目（附加区字段）、bridge-open 跨实例
//   转投（openWorkspace 投递 + 结构化 workspace-bridge-error、attachment 零挂载）、reconnect
//   结构化拒绝、门控关零转发（forward 不触达）、目录变化 → workspace-list-updated 重推。
//   仿 R2 manager 注入风格：fake deps + 注入 transport/attachment/forward 捕获，无真实 relay。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OMNICODE_REMOTE_FORWARD_RPC_FRAME_MAX_BYTES,
  omnicodeRemoteWorkspaceListReportMessageSchema,
  omnicodeRemoteWorkspaceListRequestCommandSchema,
  omnicodeRemoteWorkspaceListResultMessageSchema,
  omnicodeRemoteWorkspaceListUplinkSchema,
  isOmnicodeRemoteForwardPayloadWithinLimit,
  webRemoteControlPlatformMethodSchema,
  type WebRemoteControlWorkspaceTarget,
} from "@zcode/shared";
import {
  createOmnicodeRemoteAggregateHost,
  type OmnicodeRemoteAggregateHost,
} from "../src/main/omnicode/remoteAggregateHost.js";
import {
  OMNICODE_REMOTE_WORKSPACE_LIST_RESULT_MAX_BYTES,
  OMNICODE_REMOTE_WORKSPACE_LIST_QUERY_TTL_MS,
  getOmnicodeRemoteForwardHost,
  getOmnicodeRemoteWorkspaceDirectoryView,
  handleOmnicodeRemoteWorkspaceInstanceConnected,
  handleOmnicodeRemoteWorkspaceInstanceDisconnected,
  handleOmnicodeRemoteWorkspaceListUplink,
  resetOmnicodeRemoteForwardHostForTest,
  setupOmnicodeRemoteForwardHost,
  type OmnicodeRemoteForwardHost,
  type OmnicodeRemoteForwardHostDeps,
} from "../src/main/omnicode/remoteForwardHost.js";
import {
  handleOmnicodeRemoteWorkspaceListRequest,
  notifyOmnicodeRemoteWorkspaceSnapshotChanged,
  resolveOmnicodeRemoteWorkspaceListReply,
  setOmnicodeRemoteWorkspaceSnapshotProvider,
  toOmnicodeRemoteDirectoryEntries,
} from "../src/main/omnicode/remoteForwardInstance.js";
import {
  createWebRemoteControlManager,
  type WebRemoteControlManagerDependencies,
} from "../src/main/webRemoteControlManager.js";

const INSTANCE_A = "paaaaaaaa";
const INSTANCE_B = "pbbbbbbbb";

const instanceEntry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  workspacePath: "F:\\inst-a",
  label: "inst-a",
  kind: "local",
  ...overrides,
});

// ─── shared 目录协议 schema + 载荷守门 ───

describe("丙1 R3 目录协议 schema", () => {
  it("remoteWorkspaceListRequest：合法通过；short/非法 requestId 与多余键 strict 拒绝", () => {
    expect(
      omnicodeRemoteWorkspaceListRequestCommandSchema.safeParse({
        type: "remoteWorkspaceListRequest",
        requestId: "rw-00000000-0000-0000-0000-000000000001",
      }).success,
    ).toBe(true);
    expect(
      omnicodeRemoteWorkspaceListRequestCommandSchema.safeParse({
        type: "remoteWorkspaceListRequest",
        requestId: "短",
      }).success,
    ).toBe(false);
    expect(
      omnicodeRemoteWorkspaceListRequestCommandSchema.safeParse({
        type: "remoteWorkspaceListRequest",
        requestId: "rw-00000000-0000-0000-0000-000000000001",
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("remoteWorkspaceListResult：entries 白名单校验 + 200 上限；error 摘要 120 上限", () => {
    expect(
      omnicodeRemoteWorkspaceListResultMessageSchema.safeParse({
        type: "remoteWorkspaceListResult",
        requestId: "rw-00000000-0000-0000-0000-000000000001",
        entries: [instanceEntry()],
      }).success,
    ).toBe(true);
    expect(
      omnicodeRemoteWorkspaceListResultMessageSchema.safeParse({
        type: "remoteWorkspaceListResult",
        requestId: "rw-00000000-0000-0000-0000-000000000001",
        entries: [instanceEntry({ kind: "not-a-kind" })],
      }).success,
    ).toBe(false);
    expect(
      omnicodeRemoteWorkspaceListResultMessageSchema.safeParse({
        type: "remoteWorkspaceListResult",
        requestId: "rw-00000000-0000-0000-0000-000000000001",
        entries: Array.from({ length: 201 }, () => instanceEntry()),
      }).success,
    ).toBe(false);
    expect(
      omnicodeRemoteWorkspaceListResultMessageSchema.safeParse({
        type: "remoteWorkspaceListResult",
        requestId: "rw-00000000-0000-0000-0000-000000000001",
        entries: [],
        error: "x".repeat(121),
      }).success,
    ).toBe(false);
  });

  it("remoteWorkspaceListReport：无 requestId（上行推送）；union 按二型判别", () => {
    expect(
      omnicodeRemoteWorkspaceListReportMessageSchema.safeParse({
        type: "remoteWorkspaceListReport",
        entries: [],
      }).success,
    ).toBe(true);
    expect(
      omnicodeRemoteWorkspaceListReportMessageSchema.safeParse({
        type: "remoteWorkspaceListReport",
        requestId: "rw-00000000-0000-0000-0000-000000000001",
        entries: [],
      }).success,
    ).toBe(false);
    expect(
      omnicodeRemoteWorkspaceListUplinkSchema.safeParse({ type: "remoteWorkspaceListReport", entries: [] })
        .success,
    ).toBe(true);
    expect(
      omnicodeRemoteWorkspaceListUplinkSchema.safeParse({ type: "remoteWorkspaceListUnknown", entries: [] })
        .success,
    ).toBe(false);
  });

  it("载荷守门：1MiB 上限 = 官方 relay 物理帧上限；0/负数/超限拒绝", () => {
    expect(OMNICODE_REMOTE_FORWARD_RPC_FRAME_MAX_BYTES).toBe(1024 * 1024);
    expect(isOmnicodeRemoteForwardPayloadWithinLimit(1)).toBe(true);
    expect(isOmnicodeRemoteForwardPayloadWithinLimit(OMNICODE_REMOTE_FORWARD_RPC_FRAME_MAX_BYTES)).toBe(true);
    expect(isOmnicodeRemoteForwardPayloadWithinLimit(OMNICODE_REMOTE_FORWARD_RPC_FRAME_MAX_BYTES + 1)).toBe(false);
    expect(isOmnicodeRemoteForwardPayloadWithinLimit(0)).toBe(false);
    expect(isOmnicodeRemoteForwardPayloadWithinLimit(-1)).toBe(false);
    expect(isOmnicodeRemoteForwardPayloadWithinLimit(Number.NaN)).toBe(false);
  });
});

// ─── 被聚合实例执行器 ───

describe("丙1 R3 实例执行器 remoteForwardInstance", () => {
  afterEach(() => setOmnicodeRemoteWorkspaceSnapshotProvider(null));

  it("目录查询：探针装配后应答 entries（多窗口快照展平）；探针缺席静默丢弃", () => {
    setOmnicodeRemoteWorkspaceSnapshotProvider(() => [
      [1, [{ workspacePath: "F:\\w1", label: "w1", kind: "local" }]],
      [2, [{ workspacePath: "F:\\w2", workspaceIdentity: "ssh-2", label: "w2", kind: "local" }]],
    ]);
    const uplink: unknown[] = [];
    handleOmnicodeRemoteWorkspaceListRequest(
      { type: "remoteWorkspaceListRequest", requestId: "rw-00000000-0000-0000-0000-000000000001" },
      (message) => {
        uplink.push(message);
        return true;
      },
    );
    expect(uplink).toHaveLength(1);
    const result = uplink[0] as { type: string; requestId: string; entries: unknown[] };
    expect(result).toMatchObject({
      type: "remoteWorkspaceListResult",
      requestId: "rw-00000000-0000-0000-0000-000000000001",
    });
    expect(result.entries).toEqual([
      { workspacePath: "F:\\w1", label: "w1", kind: "local" },
      { workspacePath: "F:\\w2", workspaceIdentity: "ssh-2", label: "w2", kind: "local" },
    ]);

    setOmnicodeRemoteWorkspaceSnapshotProvider(null);
    uplink.length = 0;
    handleOmnicodeRemoteWorkspaceListRequest(
      { type: "remoteWorkspaceListRequest", requestId: "rw-00000000-0000-0000-0000-000000000002" },
      (message) => {
        uplink.push(message);
        return true;
      },
    );
    expect(uplink).toHaveLength(0);
  });

  it("条目兜底过滤：异常条目剔除不中断；条目数 200 封顶", () => {
    const entries = toOmnicodeRemoteDirectoryEntries([
      [
        { workspacePath: "F:\\ok", label: "ok", kind: "local" },
        { workspacePath: "F:\\bad" }, // 缺 label → 剔除
        { workspacePath: "", label: "empty", kind: "local" }, // 空 path → 剔除
        { workspacePath: "F:\\ok2", label: "ok2", kind: "local" },
      ],
    ]);
    expect(entries.map((entry) => entry.workspacePath)).toEqual(["F:\\ok", "F:\\ok2"]);
    expect(
      toOmnicodeRemoteDirectoryEntries([
        Array.from({ length: 300 }, (_, index) => ({
          workspacePath: `F:\\w${index}`,
          label: `w${index}`,
          kind: "local",
        })),
      ]),
    ).toHaveLength(200);
  });

  it("回包超限：结构化 error 拒绝（entries 置空，不分片——spec §4 v1 语义）", () => {
    const entries = toOmnicodeRemoteDirectoryEntries([
      [{ workspacePath: "F:\\w", label: "w", kind: "local" }],
    ]);
    expect(resolveOmnicodeRemoteWorkspaceListReply(entries, 16)).toEqual({ entries });
    const refused = resolveOmnicodeRemoteWorkspaceListReply(
      entries,
      OMNICODE_REMOTE_WORKSPACE_LIST_RESULT_MAX_BYTES + 1,
    );
    expect(refused.entries).toEqual([]);
    expect(refused.error).toBe("workspace_list_too_large");

    // 执行器端到端：超限快照 → error 回包
    setOmnicodeRemoteWorkspaceSnapshotProvider(() => [
      [1, Array.from({ length: 200 }, (_, index) => ({
        workspacePath: `F:\\very-long-path-${index}-${"x".repeat(8000)}`,
        label: `w${index}`,
        kind: "local",
      }))],
    ]);
    const uplink: unknown[] = [];
    handleOmnicodeRemoteWorkspaceListRequest(
      { type: "remoteWorkspaceListRequest", requestId: "rw-00000000-0000-0000-0000-000000000003" },
      (message) => {
        uplink.push(message);
        return true;
      },
    );
    expect(uplink).toHaveLength(1);
    expect(uplink[0]).toMatchObject({
      type: "remoteWorkspaceListResult",
      requestId: "rw-00000000-0000-0000-0000-000000000003",
      entries: [],
      error: "workspace_list_too_large",
    });
  });

  it("快照变化报告：桥未连（send false）返回 false；超限直接不发；Report 无 error 位", () => {
    setOmnicodeRemoteWorkspaceSnapshotProvider(() => [
      [1, [{ workspacePath: "F:\\w1", label: "w1", kind: "local" }]],
    ]);
    expect(notifyOmnicodeRemoteWorkspaceSnapshotChanged(() => false)).toBe(false);

    const uplink: unknown[] = [];
    expect(
      notifyOmnicodeRemoteWorkspaceSnapshotChanged((message) => {
        uplink.push(message);
        return true;
      }),
    ).toBe(true);
    expect(uplink).toHaveLength(1);
    expect(omnicodeRemoteWorkspaceListReportMessageSchema.safeParse(uplink[0]).success).toBe(true);

    setOmnicodeRemoteWorkspaceSnapshotProvider(() => [
      [1, Array.from({ length: 200 }, (_, index) => ({
        workspacePath: `F:\\very-long-path-${index}-${"x".repeat(8000)}`,
        label: `w${index}`,
        kind: "local",
      }))],
    ]);
    expect(notifyOmnicodeRemoteWorkspaceSnapshotChanged(() => true)).toBe(false);
    expect(notifyOmnicodeRemoteWorkspaceSnapshotChanged(() => false)).toBe(false);
  });
});

// ─── 管理器转发核心（remoteForwardHost）───

describe("丙1 R3 管理器转发核心 remoteForwardHost", () => {
  afterEach(() => resetOmnicodeRemoteForwardHostForTest());

  const createDeps = (
    overrides: Partial<OmnicodeRemoteForwardHostDeps> = {},
  ): OmnicodeRemoteForwardHostDeps & {
    sentCommands: Array<{ profileId: string; command: Record<string, unknown> }>;
    changed: number;
  } => {
    const state = {
      sentCommands: [] as Array<{ profileId: string; command: Record<string, unknown> }>,
      changed: 0,
    };
    return {
      get sentCommands() {
        return state.sentCommands;
      },
      get changed() {
        return state.changed;
      },
      sendCommand: (profileId, command) => {
        state.sentCommands.push({ profileId, command: command as Record<string, unknown> });
        return true;
      },
      getConnectedProfileIds: () => [INSTANCE_A],
      resolveProfileDisplayName: async (profileId) => (profileId === INSTANCE_A ? "实例A" : null),
      onWorkspacesChanged: () => {
        state.changed += 1;
      },
      nowMs: () => 1_000_000,
      // 测试环境 flavor 非 omnicode（编译期常量）→ 缺省门控恒 false；用例显式开启门控。
      isAggregateEnabled: () => true,
      ...overrides,
    };
  };

  it("门控关：零查询零缓存零转投（sendCommand 不触达；上行直接丢弃）", () => {
    const deps = createDeps({ isAggregateEnabled: () => false });
    setupOmnicodeRemoteForwardHost(deps);
    // 装配即查询被门控拦截：零命令
    expect(deps.sentCommands).toHaveLength(0);
    handleOmnicodeRemoteWorkspaceListUplink(INSTANCE_A, {
      type: "remoteWorkspaceListReport",
      entries: [instanceEntry() as never],
    });
    expect(getOmnicodeRemoteWorkspaceDirectoryView().listRemoteSources()).toEqual([]);
    handleOmnicodeRemoteWorkspaceInstanceConnected(INSTANCE_A);
    expect(deps.sentCommands).toHaveLength(0);
  });

  it("装配即查询在线实例；Result 应答缓存 + 显示名解析 + 通知；Report 同源覆盖", async () => {
    const deps = createDeps();
    setupOmnicodeRemoteForwardHost(deps);
    expect(deps.sentCommands).toEqual([
      {
        profileId: INSTANCE_A,
        command: { type: "remoteWorkspaceListRequest", requestId: expect.stringMatching(/^rw-/) },
      },
    ]);

    handleOmnicodeRemoteWorkspaceListUplink(INSTANCE_A, {
      type: "remoteWorkspaceListResult",
      requestId: "rw-00000000-0000-0000-0000-000000000001",
      entries: [instanceEntry() as never],
    });
    const view = getOmnicodeRemoteWorkspaceDirectoryView();
    expect(view.listRemoteSources()).toEqual([
      { profileId: INSTANCE_A, entries: [instanceEntry()] },
    ]);
    expect(deps.changed).toBeGreaterThanOrEqual(1);
    // 显示名异步解析（Profile 注册表）完成后进附加区
    await vi.waitFor(() => {
      expect(view.listRemoteSources()[0].displayName).toBe("实例A");
    });

    // Report 同源覆盖（缓存即最新事实）
    handleOmnicodeRemoteWorkspaceListUplink(INSTANCE_A, {
      type: "remoteWorkspaceListReport",
      entries: [instanceEntry({ workspacePath: "F:\\inst-a2", label: "inst-a2" }) as never],
    });
    expect(view.listRemoteSources()[0].entries[0].workspacePath).toBe("F:\\inst-a2");

    // 校验失败（null）静默丢弃；error 结果不覆盖既有缓存
    handleOmnicodeRemoteWorkspaceListUplink(INSTANCE_A, null);
    handleOmnicodeRemoteWorkspaceListUplink(INSTANCE_A, {
      type: "remoteWorkspaceListResult",
      requestId: "rw-00000000-0000-0000-0000-000000000002",
      entries: [],
      error: "workspace_list_too_large",
    });
    expect(view.listRemoteSources()[0].entries[0].workspacePath).toBe("F:\\inst-a2");
  });

  it("在途查询去重 + TTL 惰性收口：死线后可重新查询（无 timer 无常驻轮询）", () => {
    let nowValue = 1_000_000;
    const deps = createDeps({ nowMs: () => nowValue });
    setupOmnicodeRemoteForwardHost(deps);
    expect(deps.sentCommands).toHaveLength(1);
    handleOmnicodeRemoteWorkspaceInstanceConnected(INSTANCE_A);
    expect(deps.sentCommands).toHaveLength(1); // 在途去重

    nowValue += OMNICODE_REMOTE_WORKSPACE_LIST_QUERY_TTL_MS + 1;
    handleOmnicodeRemoteWorkspaceInstanceConnected(INSTANCE_A);
    expect(deps.sentCommands).toHaveLength(2); // TTL 过期惰性收口后重查
  });

  it("实例离线摘除：缓存清空 + 通知；空摘除不通知", () => {
    const deps = createDeps();
    setupOmnicodeRemoteForwardHost(deps);
    handleOmnicodeRemoteWorkspaceListUplink(INSTANCE_A, {
      type: "remoteWorkspaceListResult",
      requestId: "rw-00000000-0000-0000-0000-000000000003",
      entries: [instanceEntry() as never],
    });
    expect(getOmnicodeRemoteWorkspaceDirectoryView().listRemoteSources()).toHaveLength(1);
    const changedBefore = deps.changed;
    handleOmnicodeRemoteWorkspaceInstanceDisconnected(INSTANCE_A);
    expect(getOmnicodeRemoteWorkspaceDirectoryView().listRemoteSources()).toEqual([]);
    expect(deps.changed).toBe(changedBefore + 1);
    handleOmnicodeRemoteWorkspaceInstanceDisconnected(INSTANCE_A);
    expect(deps.changed).toBe(changedBefore + 1); // 重复摘除幂等
  });

  it("bridge-open 转投：openWorkspace 命令投递归属实例；真身形态校验 + 离线不投递", () => {
    let online = true;
    const deps = createDeps({
      sendCommand: (profileId, command) => {
        deps.sentCommands.push({ profileId, command: command as Record<string, unknown> });
        return online;
      },
    });
    setupOmnicodeRemoteForwardHost(deps);
    const forward: OmnicodeRemoteForwardHost = getOmnicodeRemoteForwardHost();
    expect(forward.isEnabled()).toBe(true);

    // 真身形态 → openWorkspace 投递（既有桥命令复用，尊重工作区锁）
    expect(
      forward.openWorkspaceOnInstance({
        sourceProfileId: INSTANCE_A,
        workspacePath: "F:\\inst-a",
        workspaceKey: "F:\\inst-a",
        bridgeSessionId: "bs-x",
      }),
    ).toEqual({ forwarded: true });
    expect(deps.sentCommands.slice(-1)).toEqual([
      { profileId: INSTANCE_A, command: { type: "openWorkspace", path: "F:\\inst-a" } },
    ]);

    // 非真身形态（self/窗口 id）拒绝转投（防伪造路由面）
    expect(
      forward.openWorkspaceOnInstance({
        sourceProfileId: "self",
        workspacePath: "F:\\x",
        workspaceKey: "F:\\x",
        bridgeSessionId: "bs-x",
      }),
    ).toEqual({ forwarded: false, error: "invalid_source_profile_id" });
    expect(
      forward.openWorkspaceOnInstance({
        sourceProfileId: "2",
        workspacePath: "F:\\x",
        workspaceKey: "F:\\x",
        bridgeSessionId: "bs-x",
      }),
    ).toEqual({ forwarded: false, error: "invalid_source_profile_id" });

    // 实例离线：不投递 + 结构化摘要（不重试——手机侧已结构化收口）
    online = false;
    expect(
      forward.openWorkspaceOnInstance({
        sourceProfileId: INSTANCE_A,
        workspacePath: "F:\\inst-a",
        workspaceKey: "F:\\inst-a",
        bridgeSessionId: "bs-x",
      }),
    ).toEqual({ forwarded: false, error: "instance_offline" });
  });

  it("目录视图跨账号接口：默认关（includeCrossAccount=false）+ 默认空名单（全部按同账号）", () => {
    const deps = createDeps({
      readCrossAccountAggregation: () => true,
      listCrossAccountProfileIds: () => [INSTANCE_B],
    });
    setupOmnicodeRemoteForwardHost(deps);
    const view = getOmnicodeRemoteWorkspaceDirectoryView();
    expect(view.isCrossAccountAggregationEnabled()).toBe(true);
    expect(view.listCrossAccountProfileIds()).toEqual([INSTANCE_B]);

    const defaultDeps = createDeps();
    resetOmnicodeRemoteForwardHostForTest();
    setupOmnicodeRemoteForwardHost(defaultDeps);
    expect(getOmnicodeRemoteWorkspaceDirectoryView().isCrossAccountAggregationEnabled()).toBe(false);
    expect(getOmnicodeRemoteWorkspaceDirectoryView().listCrossAccountProfileIds()).toEqual([]);
  });
});

// ─── 聚合宿主目录接入（remoteAggregateHost）───

const hostWindowEntry = (workspacePath: string): WebRemoteControlWorkspaceTarget => ({
  workspacePath,
  label: workspacePath,
  kind: "local",
});

describe("丙1 R3 聚合宿主目录接入", () => {
  const directoryStub = (entries: Record<string, unknown>[], crossAccountIds: string[] = []) => ({
    listRemoteSources: () => [
      {
        profileId: INSTANCE_A,
        displayName: "实例A",
        entries: entries as never[],
      },
    ],
    isCrossAccountAggregationEnabled: () => false,
    listCrossAccountProfileIds: () => crossAccountIds,
  });

  it("聚合列表：窗口条目在前，实例条目在后（aggregatedKey=profileId:workspaceKey + 附加区）", () => {
    const host = createOmnicodeRemoteAggregateHost({
      directory: directoryStub([instanceEntry(), instanceEntry({ workspacePath: "F:\\inst-a2", label: "inst-a2" })]),
    });
    const snapshots = new Map<number, WebRemoteControlWorkspaceTarget[]>([
      [1, [hostWindowEntry("F:\\w1")]],
    ]);
    const aggregated = host.listAggregatedWorkspaces(snapshots, 1);
    expect(aggregated.map((item) => item.aggregatedKey)).toEqual([
      "self:F:\\w1",
      `${INSTANCE_A}:F:\\inst-a`,
      `${INSTANCE_A}:F:\\inst-a2`,
    ]);
    expect(aggregated[1]).toMatchObject({
      sourceProfileId: INSTANCE_A,
      sourceDisplayName: "实例A",
      kind: "local",
    });
  });

  it("跨实例来源反查：resolveRoute sourceKind=instance（windowId 缺省）；未命中回 undefined", () => {
    const host = createOmnicodeRemoteAggregateHost({
      directory: directoryStub([instanceEntry(), instanceEntry({ workspaceIdentity: "ssh-x" })]),
    });
    const snapshots = new Map<number, WebRemoteControlWorkspaceTarget[]>([
      [1, [hostWindowEntry("F:\\w1")]],
    ]);
    const route = host.resolveRoute(snapshots, 1, "F:\\inst-a");
    expect(route?.sourceKind).toBe("instance");
    expect(route?.windowId).toBeUndefined();
    expect(route?.entry.sourceProfileId).toBe(INSTANCE_A);
    // 原始 key（identity 口径）命中
    expect(host.resolveRoute(snapshots, 1, "ssh-x")?.sourceKind).toBe("instance");
    // 本窗口条目仍 sourceKind=window
    expect(host.resolveRoute(snapshots, 1, "F:\\w1")).toMatchObject({
      windowId: 1,
      sourceKind: "window",
    });
    expect(host.resolveRoute(snapshots, 1, "F:\\missing")).toBeUndefined();
    // 跨实例条目反查归属窗口恒 undefined（不得本地挂载）
    expect(
      host.resolveTargetWindowId(snapshots, 1, { workspacePath: "F:\\inst-a" }),
    ).toBeUndefined();
  });

  it("目录缺席 = M2 行为逐字不变（无实例条目、无 sourceKind 语义差异）", () => {
    const host = createOmnicodeRemoteAggregateHost();
    const snapshots = new Map<number, WebRemoteControlWorkspaceTarget[]>([
      [1, [hostWindowEntry("F:\\w1")]],
    ]);
    expect(host.listAggregatedWorkspaces(snapshots, 1).map((item) => item.aggregatedKey)).toEqual([
      "self:F:\\w1",
    ]);
    expect(host.resolveRoute(snapshots, 1, "F:\\w1")).toMatchObject({
      windowId: 1,
      sourceKind: "window",
    });
  });
});

// ─── manager 注入层（门控开/关对照）───

interface ManagerHarness {
  sent: Array<{ zcode_type: string } & Record<string, unknown>>;
  attached: Array<{ windowId: number; workspacePath: string }>;
  forwardedOpens: Array<{ profileId: string; path: string }>;
  reconnectWorkspace: ReturnType<typeof vi.fn>;
  transportOptions: {
    onPayload: (payload: unknown) => void;
    onStateChange: (state: string) => void;
  } | null;
}

function createManagerHarness(options: {
  aggregateHost: OmnicodeRemoteAggregateHost;
  remoteForward?: OmnicodeRemoteForwardHost;
}): { manager: ReturnType<typeof createWebRemoteControlManager>; harness: ManagerHarness } {
  const harness: ManagerHarness = {
    sent: [],
    attached: [],
    forwardedOpens: [],
    reconnectWorkspace: vi.fn(async () => {}),
    transportOptions: null,
  };
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
    createDeviceTransport: (createOptions) => {
      harness.transportOptions = createOptions as unknown as ManagerHarness["transportOptions"];
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
    omnicodeAggregateHost: options.aggregateHost,
    ...(options.remoteForward ? { omnicodeRemoteForward: options.remoteForward } : {}),
  };
  return { manager: createWebRemoteControlManager(dependencies), harness };
}

const enabledHost = (directory: ReturnType<typeof makeDirectory>): OmnicodeRemoteAggregateHost => ({
  ...createOmnicodeRemoteAggregateHost({ directory }),
  isEnabled: () => true,
});

const makeDirectory = (entries: Record<string, unknown>[]) => ({
  listRemoteSources: () => [{ profileId: INSTANCE_A, displayName: "实例A", entries: entries as never[] }],
  isCrossAccountAggregationEnabled: () => false,
  listCrossAccountProfileIds: () => [] as string[],
});

async function startPresenter(manager: ReturnType<typeof createWebRemoteControlManager>): Promise<void> {
  await manager.start(1, { workspacePath: "F:\\w1" });
}

describe("丙1 R3 manager 注入：跨实例聚合呈现与转投", () => {
  it("bootstrap/workspace-list 含实例条目（官方字段原样 + aggregatedKey/sourceProfileId/sourceDisplayName）", async () => {
    const { manager, harness } = createManagerHarness({
      aggregateHost: enabledHost(makeDirectory([instanceEntry()])),
      remoteForward: { isEnabled: () => true, openWorkspaceOnInstance: () => ({ forwarded: true }) },
    });
    await startPresenter(manager);
    manager.syncAvailableWorkspaces(1, [hostWindowEntry("F:\\w1")]);
    harness.transportOptions?.onPayload({ zcode_type: "bootstrap-request", requestId: "req-r3-1" });

    const response = harness.sent[harness.sent.length - 1];
    const workspaces = (
      response.result as { workspaces: Array<Record<string, unknown>> }
    ).workspaces;
    expect(workspaces.map((workspace) => workspace.aggregatedKey)).toEqual([
      "self:F:\\w1",
      `${INSTANCE_A}:F:\\inst-a`,
    ]);
    expect(workspaces[1]).toMatchObject({
      workspacePath: "F:\\inst-a",
      kind: "local",
      sourceProfileId: INSTANCE_A,
      sourceDisplayName: "实例A",
    });
  });

  it("跨实例 bridge-open：openWorkspace 转投归属实例 + 结构化 workspace-bridge-error（attachment 零挂载）", async () => {
    const { manager, harness } = createManagerHarness({
      aggregateHost: enabledHost(makeDirectory([instanceEntry()])),
      remoteForward: {
        isEnabled: () => true,
        openWorkspaceOnInstance: (request) => {
          harness.forwardedOpens.push({
            profileId: request.sourceProfileId,
            path: request.workspacePath,
          });
          return { forwarded: true };
        },
      },
    });
    await startPresenter(manager);
    manager.syncAvailableWorkspaces(1, [hostWindowEntry("F:\\w1")]);
    harness.transportOptions?.onPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-r3-2",
      bridgeSessionId: "bs-r3",
      workspaceKey: "F:\\inst-a",
    });

    await vi.waitFor(() => {
      expect(harness.sent.some((payload) => payload.zcode_type === "workspace-bridge-error")).toBe(true);
    });
    expect(harness.forwardedOpens).toEqual([{ profileId: INSTANCE_A, path: "F:\\inst-a" }]);
    expect(harness.attached).toEqual([]); // 跨实例条目绝不本地挂载
    const error = harness.sent.find((payload) => payload.zcode_type === "workspace-bridge-error");
    expect(error).toMatchObject({
      requestId: "req-r3-2",
      bridgeSessionId: "bs-r3",
      reason: "unsupported-action",
    });
  });

  it("跨实例条目 reconnect：结构化 success:false（会话归属实例）", async () => {
    const { manager, harness } = createManagerHarness({
      aggregateHost: enabledHost(makeDirectory([instanceEntry()])),
      remoteForward: { isEnabled: () => true, openWorkspaceOnInstance: () => ({ forwarded: true }) },
    });
    await startPresenter(manager);
    manager.syncAvailableWorkspaces(1, [hostWindowEntry("F:\\w1")]);
    harness.transportOptions?.onPayload({
      zcode_type: "workspace-reconnect-request",
      requestId: "req-r3-3",
      workspaceKey: "F:\\inst-a",
    });
    await vi.waitFor(() => {
      const response = harness.sent.find(
        (payload) =>
          payload.zcode_type === "workspace-reconnect-response" && payload.requestId === "req-r3-3",
      );
      expect(response).toMatchObject({ success: false });
    });
    expect(harness.reconnectWorkspace).not.toHaveBeenCalled();
  });

  it("目录变化通知：目录内容变化 → workspace-list-updated 重推；同内容签名去重不重复推送", async () => {
    const directoryState = { entries: [instanceEntry()] as Record<string, unknown>[] };
    const { manager, harness } = createManagerHarness({
      aggregateHost: enabledHost(makeDirectory(directoryState.entries)),
      remoteForward: { isEnabled: () => true, openWorkspaceOnInstance: () => ({ forwarded: true }) },
    });
    await startPresenter(manager);
    manager.syncAvailableWorkspaces(1, [hostWindowEntry("F:\\w1")]);
    const before = harness.sent.filter((payload) => payload.zcode_type === "workspace-list-updated").length;

    // 同内容通知：签名去重，不产生推送
    manager.omnicodeOnRemoteWorkspacesChanged();
    expect(harness.sent.filter((payload) => payload.zcode_type === "workspace-list-updated").length).toBe(before);

    // 目录内容变化（实例快照更新）：聚合列表签名变化 → 重推（原地替换条目——闭包持引用）
    directoryState.entries.length = 0;
    directoryState.entries.push(instanceEntry({ workspacePath: "F:\\inst-a2", label: "inst-a2" }));
    manager.omnicodeOnRemoteWorkspacesChanged();
    const updated = harness.sent.filter((payload) => payload.zcode_type === "workspace-list-updated");
    expect(updated).toHaveLength(before + 1);
    expect(
      (updated[updated.length - 1].result as { workspaces: Array<Record<string, unknown>> }).workspaces,
    ).toEqual([
      expect.objectContaining({ aggregatedKey: "self:F:\\w1" }),
      expect.objectContaining({ aggregatedKey: `${INSTANCE_A}:F:\\inst-a2` }),
    ]);
  });

  it("门控关零转发：官方单窗口路径（无聚合字段）+ 跨实例键 bridge-open 走官方路径失败（forward 不触达）", async () => {
    const forwardProbe = {
      called: false,
      isEnabled: () => true,
      openWorkspaceOnInstance: () => {
        forwardProbe.called = true;
        return { forwarded: true };
      },
    };
    const { manager, harness } = createManagerHarness({
      aggregateHost: { ...createOmnicodeRemoteAggregateHost(), isEnabled: () => false },
      remoteForward: forwardProbe,
    });
    await startPresenter(manager);
    manager.syncAvailableWorkspaces(1, [hostWindowEntry("F:\\w1")]);
    harness.transportOptions?.onPayload({
      zcode_type: "bootstrap-request",
      requestId: "req-r3-4",
    });
    const workspaces = (
      harness.sent[harness.sent.length - 1].result as { workspaces: Array<Record<string, unknown>> }
    ).workspaces;
    // 门控关 = 官方单窗口路径逐字不变（无 aggregatedKey/sourceProfileId 聚合字段）
    expect(workspaces).toEqual([{ workspacePath: "F:\\w1", label: "F:\\w1", kind: "local" }]);

    harness.transportOptions?.onPayload({
      zcode_type: "workspace-bridge-open",
      requestId: "req-r3-5",
      bridgeSessionId: "bs-r3-off",
      workspaceKey: "F:\\inst-a",
    });
    await vi.waitFor(() => {
      expect(harness.sent.some((payload) => payload.zcode_type === "workspace-bridge-error")).toBe(true);
    });
    expect(forwardProbe.called).toBe(false); // 开关关闭零转发
    expect(harness.attached).toEqual([]);
  });
});
