// [OmniCode] 丙1 远程聚合 R1 骨架单测（spec: docs/omnicode/remote-aggregation.md §4–§5）：
// - 桥协议 schema（remoteForward / remoteForwardResult / remoteHostAnnounce）：strict
//   拒绝多余键、forwardId 形态白名单、kind 枚举、error 摘要 200 上限、epoch 非负整数、
//   hostProfileId 形态；
// - workspace-list 聚合（aggregateOmnicodeWorkspaceLists）：去重（同 profileId+key
//   保留首个）、三组顺序（宿主自身 → 同账号 → 跨账号）组内保序、跨账号开关剔除、
//   workspaceKey 口径（identity 去空白优先）、空输入；
// - forwardId 路由表（createOmnicodeForwardRouteTable）：register 首个生效、take 取走
//   即删（重复 take → null 幂等去重）、expire 死线收口、自定义 TTL。
// 纯 shared 层断言：全部输入时刻注入，无假时钟无 IO。
import { describe, expect, it } from "vitest";
import {
  OMNICODE_REMOTE_FORWARD_ID_MAX_LEN,
  OMNICODE_REMOTE_FORWARD_PENDING_TTL_MS,
  OMNICODE_REMOTE_SELF_PROFILE_ID,
  aggregateOmnicodeWorkspaceLists,
  createOmnicodeForwardRouteTable,
  omnicodeRemoteForwardMessageSchema,
  omnicodeRemoteForwardResultMessageSchema,
  omnicodeRemoteHostAnnounceMessageSchema,
  omnicodeRemoteWorkspaceEntrySchema,
  resolveOmnicodeRemoteWorkspaceKey,
  type OmnicodeRemoteWorkspaceEntry,
  type OmnicodeRemoteWorkspaceListSource,
} from "@zcode/shared";

describe("丙1 桥协议 schema", () => {
  it("remoteForward：合法载荷（含/缺可选 payload）通过；kind 枚举非法拒绝", () => {
    expect(
      omnicodeRemoteForwardMessageSchema.safeParse({
        type: "remoteForward",
        forwardId: "rf-abc.123_xyz:y",
        kind: "workspace-list",
        payload: { result: { workspaces: [] } },
      }).success,
    ).toBe(true);
    expect(
      omnicodeRemoteForwardMessageSchema.safeParse({
        type: "remoteForward",
        forwardId: "rf-abc.123_xyz:y",
        kind: "rpc-frame",
      }).success,
    ).toBe(true);
    expect(
      omnicodeRemoteForwardMessageSchema.safeParse({
        type: "remoteForward",
        forwardId: "rf-abc.123_xyz:y",
        kind: "not-a-kind",
      }).success,
    ).toBe(false);
  });

  it("remoteForward：forwardId 形态白名单（短/超长/非法字符拒绝）+ 多余键 strict 拒绝", () => {
    expect(
      omnicodeRemoteForwardMessageSchema.safeParse({
        type: "remoteForward",
        forwardId: "短",
        kind: "workspace-list",
      }).success,
    ).toBe(false);
    expect(
      omnicodeRemoteForwardMessageSchema.safeParse({
        type: "remoteForward",
        forwardId: "rf-" + "x".repeat(OMNICODE_REMOTE_FORWARD_ID_MAX_LEN),
        kind: "workspace-list",
      }).success,
    ).toBe(false);
    expect(
      omnicodeRemoteForwardMessageSchema.safeParse({
        type: "remoteForward",
        forwardId: "../evil/id",
        kind: "workspace-list",
      }).success,
    ).toBe(false);
    // spec §4 target:"host" 为管理器路由层事实——载荷自报 target 必须 strict 拒绝（防伪造路由）
    expect(
      omnicodeRemoteForwardMessageSchema.safeParse({
        type: "remoteForward",
        forwardId: "rf-abc.123_xyz:y",
        kind: "workspace-list",
        target: "host",
      }).success,
    ).toBe(false);
  });

  it("remoteForwardResult：ok 必填；error 摘要 200 上限；多余键 strict 拒绝", () => {
    expect(
      omnicodeRemoteForwardResultMessageSchema.safeParse({
        type: "remoteForwardResult",
        forwardId: "rf-abc.123_xyz:y",
        ok: true,
        payload: { anything: "opaque" },
      }).success,
    ).toBe(true);
    expect(
      omnicodeRemoteForwardResultMessageSchema.safeParse({
        type: "remoteForwardResult",
        forwardId: "rf-abc.123_xyz:y",
        ok: false,
        error: "x".repeat(200),
      }).success,
    ).toBe(true);
    expect(
      omnicodeRemoteForwardResultMessageSchema.safeParse({
        type: "remoteForwardResult",
        forwardId: "rf-abc.123_xyz:y",
        ok: false,
        error: "x".repeat(201),
      }).success,
    ).toBe(false);
    expect(
      omnicodeRemoteForwardResultMessageSchema.safeParse({
        type: "remoteForwardResult",
        forwardId: "rf-abc.123_xyz:y",
        ok: false,
        // rpc-frame 红线：摘要之外不得回显载荷原文（非字符串形状直接拒绝）
        originalPayload: { frame: "1MiB" },
      }).success,
    ).toBe(false);
  });

  it("remoteHostAnnounce：epoch 非负整数；hostProfileId 形态白名单；多余键拒绝", () => {
    expect(
      omnicodeRemoteHostAnnounceMessageSchema.safeParse({
        type: "remoteHostAnnounce",
        hostProfileId: "paaaaaaaa",
        epoch: 3,
      }).success,
    ).toBe(true);
    for (const badEpoch of [-1, 1.5, Number.NaN]) {
      expect(
        omnicodeRemoteHostAnnounceMessageSchema.safeParse({
          type: "remoteHostAnnounce",
          hostProfileId: "paaaaaaaa",
          epoch: badEpoch,
        }).success,
      ).toBe(false);
    }
    expect(
      omnicodeRemoteHostAnnounceMessageSchema.safeParse({
        type: "remoteHostAnnounce",
        hostProfileId: "../evil",
        epoch: 0,
      }).success,
    ).toBe(false);
    expect(
      omnicodeRemoteHostAnnounceMessageSchema.safeParse({
        type: "remoteHostAnnounce",
        hostProfileId: "paaaaaaaa",
        epoch: 0,
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe("丙1 workspace-list 聚合 aggregateOmnicodeWorkspaceLists", () => {
  const entry = (overrides: Partial<OmnicodeRemoteWorkspaceEntry> = {}): OmnicodeRemoteWorkspaceEntry =>
    omnicodeRemoteWorkspaceEntrySchema.parse({
      workspacePath: "F:\\work\\demo",
      label: "demo",
      kind: "local",
      ...overrides,
    });

  const remote = (overrides: Partial<OmnicodeRemoteWorkspaceListSource> = {}): OmnicodeRemoteWorkspaceListSource => ({
    profileId: "paaaaaaaa",
    displayName: "实例A",
    entries: [entry({ workspacePath: "F:\\work\\a" })],
    ...overrides,
  });

  it("空输入 → 空聚合", () => {
    expect(aggregateOmnicodeWorkspaceLists({ self: [], remote: [], includeCrossAccount: false })).toEqual([]);
  });

  it("宿主自身条目 sourceProfileId=self；remote 条目带 profileId/显示名", () => {
    const aggregated = aggregateOmnicodeWorkspaceLists({
      self: [entry({ workspacePath: "F:\\work\\host" })],
      remote: [remote()],
      includeCrossAccount: false,
    });
    expect(aggregated).toHaveLength(2);
    expect(aggregated[0]).toMatchObject({
      aggregatedKey: `${OMNICODE_REMOTE_SELF_PROFILE_ID}:F:\\work\\host`,
      sourceProfileId: OMNICODE_REMOTE_SELF_PROFILE_ID,
      workspacePath: "F:\\work\\host",
    });
    expect("sourceDisplayName" in aggregated[0]).toBe(false);
    expect(aggregated[1]).toMatchObject({
      aggregatedKey: "paaaaaaaa:F:\\work\\a",
      sourceProfileId: "paaaaaaaa",
      sourceDisplayName: "实例A",
      workspacePath: "F:\\work\\a",
    });
  });

  it("去重：同 profileId+key 保留首个（重复条目不覆盖）；官方附加字段 passthrough 保留", () => {
    const aggregated = aggregateOmnicodeWorkspaceLists({
      self: [],
      remote: [
        remote({
          profileId: "paaaaaaaa",
          entries: [
            entry({ workspacePath: "F:\\work\\demo", workspaceIdentity: "ws-1", customExtra: { keep: true } }),
            // 同键重复（identity 同为 ws-1）：后到丢弃
            entry({ workspacePath: "F:\\work\\demo", workspaceIdentity: "ws-1" }),
            // 无 identity → key=path，与前两条不同键：保留
            entry({ workspacePath: "F:\\work\\demo" }),
          ],
        }),
      ],
      includeCrossAccount: false,
    });
    expect(aggregated).toHaveLength(2);
    expect(aggregated[0].workspacePath).toBe("F:\\work\\demo");
    expect(aggregated[0].aggregatedKey).toBe("paaaaaaaa:ws-1");
    expect(aggregated[0].customExtra).toEqual({ keep: true });
    expect(aggregated[1].aggregatedKey).toBe("paaaaaaaa:F:\\work\\demo");
  });

  it("workspaceKey 口径：workspaceIdentity 去空白优先；缺失回退 workspacePath；同 profileId 下两键去重合并", () => {
    expect(resolveOmnicodeRemoteWorkspaceKey({ workspacePath: "F:\\p", workspaceIdentity: "  ws-9  " })).toBe("ws-9");
    expect(resolveOmnicodeRemoteWorkspaceKey({ workspacePath: "F:\\p" })).toBe("F:\\p");
    const aggregated = aggregateOmnicodeWorkspaceLists({
      self: [entry({ workspacePath: "F:\\work\\demo", workspaceIdentity: "ws-shared" })],
      remote: [remote({ entries: [entry({ workspacePath: "F:\\work\\elsewhere", workspaceIdentity: "ws-shared" })] })],
      includeCrossAccount: false,
    });
    // 键含 profileId：宿主(self)与实例同 identity 不同键，不去重（R1 语义）
    expect(aggregated.map((item) => item.aggregatedKey)).toEqual([
      `${OMNICODE_REMOTE_SELF_PROFILE_ID}:ws-shared`,
      "paaaaaaaa:ws-shared",
    ]);
  });

  it("排序分组：宿主自身 → 同账号 → 跨账号（显式开启后），组内保持原序", () => {
    const aggregated = aggregateOmnicodeWorkspaceLists({
      self: [entry({ workspacePath: "F:\\h1" }), entry({ workspacePath: "F:\\h2" })],
      remote: [
        remote({
          profileId: "psameaccount",
          displayName: "同账号",
          entries: [entry({ workspacePath: "F:\\s1" }), entry({ workspacePath: "F:\\s2" })],
        }),
        remote({
          profileId: "pcrossacco",
          displayName: "跨账号",
          entries: [entry({ workspacePath: "F:\\c1" }), entry({ workspacePath: "F:\\c2" })],
        }),
      ],
      includeCrossAccount: true,
      crossAccountProfileIds: ["pcrossacco"],
    });
    expect(aggregated.map((item) => item.aggregatedKey)).toEqual([
      "self:F:\\h1",
      "self:F:\\h2",
      "psameaccount:F:\\s1",
      "psameaccount:F:\\s2",
      "pcrossacco:F:\\c1",
      "pcrossacco:F:\\c2",
    ]);
    expect(aggregated[4]).toMatchObject({ sourceCrossAccount: true, sourceDisplayName: "跨账号" });
  });

  it("跨账号开关：includeCrossAccount=false 剔除跨账号组；true 且无名单时按同账号处理", () => {
    const sources = [
      remote({ profileId: "psameaccount", entries: [entry({ workspacePath: "F:\\s" })] }),
      remote({ profileId: "pcrossacco", entries: [entry({ workspacePath: "F:\\c" })] }),
    ];
    const closed = aggregateOmnicodeWorkspaceLists({
      self: [],
      remote: sources,
      includeCrossAccount: false,
      crossAccountProfileIds: ["pcrossacco"],
    });
    expect(closed.map((item) => item.aggregatedKey)).toEqual(["psameaccount:F:\\s"]);

    const open = aggregateOmnicodeWorkspaceLists({
      self: [],
      remote: sources,
      includeCrossAccount: true,
      crossAccountProfileIds: ["pcrossacco"],
    });
    expect(open.map((item) => item.aggregatedKey)).toEqual(["psameaccount:F:\\s", "pcrossacco:F:\\c"]);

    const noList = aggregateOmnicodeWorkspaceLists({
      self: [],
      remote: sources,
      includeCrossAccount: true,
    });
    expect(noList.map((item) => item.aggregatedKey)).toEqual(["psameaccount:F:\\s", "pcrossacco:F:\\c"]);
    expect(noList.every((item) => item.sourceCrossAccount !== true)).toBe(true);
  });
});

describe("丙1 forwardId 路由表 createOmnicodeForwardRouteTable", () => {
  const pending = (forwardId: string, registeredAt = 1000) => ({
    forwardId,
    sourceProfileId: "paaaaaaaa",
    kind: "rpc-frame" as const,
    registeredAt,
  });

  it("register → take（取走即删）→ 重复 take 返回 null（幂等去重）", () => {
    const table = createOmnicodeForwardRouteTable();
    expect(table.register(pending("rf-abc.123_xyz:y"))).toBe(true);
    expect(table.size()).toBe(1);
    expect(table.take("rf-abc.123_xyz:y")).toMatchObject({ forwardId: "rf-abc.123_xyz:y", kind: "rpc-frame" });
    expect(table.size()).toBe(0);
    expect(table.take("rf-abc.123_xyz:y")).toBeNull();
  });

  it("重复 register：首个生效返回 false（不覆盖既有占位）", () => {
    const table = createOmnicodeForwardRouteTable();
    expect(table.register(pending("rf-abc.123_xyz:y"))).toBe(true);
    expect(table.register(pending("rf-abc.123_xyz:y", 2000))).toBe(false);
    expect(table.take("rf-abc.123_xyz:y")?.registeredAt).toBe(1000);
  });

  it("expire：TTL 内保留；超死线清除并返回被清清单；take 走的条目不再出现在 expire", () => {
    const table = createOmnicodeForwardRouteTable();
    table.register(pending("rf-taken", 0));
    table.register(pending("rf-expired", 0));
    table.register(pending("rf-fresh", 40_000));
    table.take("rf-taken");

    // 默认 TTL 45s：46s 时刻 rf-expired（登记于 0）已超死线；rf-fresh（登记于 40s）仍在窗口内
    const swept = table.expire(46_000);
    expect(swept.map((item) => item.forwardId)).toEqual(["rf-expired"]);
    expect(table.size()).toBe(1);
    expect(table.take("rf-fresh")).toMatchObject({ forwardId: "rf-fresh" });
    expect(table.expire(OMNICODE_REMOTE_FORWARD_PENDING_TTL_MS + 1)).toEqual([]);
  });

  it("自定义 ttlMs：窗口边界内保留、恰超死线清除", () => {
    const table = createOmnicodeForwardRouteTable({ ttlMs: 500 });
    table.register(pending("rf-edge", 1000));
    expect(table.expire(1500)).toEqual([]);
    expect(table.expire(1501).map((item) => item.forwardId)).toEqual(["rf-edge"]);
    expect(table.size()).toBe(0);
  });
});
