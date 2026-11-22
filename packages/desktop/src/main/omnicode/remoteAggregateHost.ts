// [OmniCode] 丙1 远程聚合 R2——宿主侧聚合接线（spec: docs/omnicode/remote-aggregation.md
// §3/§5/§8-R2）。职责边界（manager 只在 omnicodeAggregateHost.isEnabled() 为真时进入
// 本模块提供的聚合分支，官方 flavor / 开关关闭时全部走官方单窗口路径逐字不变）：
// - 门控判定：ZCODE_PRODUCT_FLAVOR === "omnicode"（编译期常量，由调用方传入保持纯函数
//   可测，isOmnicodeManagerProcess 同款）∧ per-instance 开关
//   ZCODE_OMNICODE_REMOTE_AGGREGATE === "1"（默认关；R4 再接 omnicodeGlobalPrefs 设置面）。
// - 聚合 workspace-list 装配：复用 R1 aggregateOmnicodeWorkspaceLists（spec §5 合并顺序
//   宿主自身 → 其余来源；M2 范围无跨账号来源，includeCrossAccount 恒 false）。profileId
//   口径：呈现窗口 = OMNICODE_REMOTE_SELF_PROFILE_ID（"self"），其余窗口 = String(windowId)
//   （spec §5 宿主自身条目 profileId="self"；其余窗口以窗口 id 为来源标识）。窗口按 id
//   升序合并保证确定性；组内保持窗口快照原序；aggregatedKey 同键保留首个。
// - bridge-open/reconnect 反查路由：aggregatedKey 精确匹配优先，其次官方原始 key
//   （workspaceIdentity || workspacePath，与 resolveWebRemoteControlWorkspaceKey 同口径）。
//   手机页按官方字段计算 workspaceKey（M1-R4 验证官方页面忽略未知附加字段），原始 key
//   命中是主路径；aggregatedKey 命中是手机页未来升级后的直通路径。
// - 纯快照驱动：全部函数以 manager 的 availableWorkspacesByWindowId（Map entries 形状）
//   为唯一事实来源，无自有状态无缓存——manager 快照变化即时生效，无对账面。
// R3（跨实例桥转发）：可选目录视图注入（remoteForwardHost 装配面）——聚合列表并入
//   在线实例快照（R1 remote 参数接线，spec §5 合并顺序：宿主自身 → 同账号 → 跨账号）；
//   反查路由对跨实例来源返回 sourceKind="instance"（windowId 缺省），由 manager R3
//   门控走转投路径（官方路径不得以本窗口挂载跨实例条目）。目录缺席/门控关 = M2 行为逐字不变。
import {
  OMNICODE_REMOTE_SELF_PROFILE_ID,
  ZCODE_PRODUCT_FLAVOR,
  aggregateOmnicodeWorkspaceLists,
  omnicodeRemoteWorkspaceEntrySchema,
  resolveOmnicodeRemoteWorkspaceKey,
  type OmnicodeAggregatedWorkspaceEntry,
  type OmnicodeRemoteWorkspaceEntry,
  type OmnicodeRemoteWorkspaceListSource,
  type WebRemoteControlWorkspaceTarget,
} from "@zcode/shared";

/**
 * 跨实例 workspace 目录视图（R3 唯一类型定义处：本模块消费、remoteForwardHost 提供实现，
 * 经 getOmnicodeRemoteWorkspaceDirectoryView 注入；目录装配在管理器进程 desktopProfileIpc）。
 */
export interface OmnicodeRemoteWorkspaceDirectoryView {
  /** 当前在线实例的 workspace 快照（按 profileId 升序——确定性合并序，同键保留首个）。 */
  listRemoteSources(): OmnicodeRemoteWorkspaceListSource[];
  /** 跨账号聚合开关（spec §7 默认关；R4 接 omnicodeGlobalPrefs 设置面）。 */
  isCrossAccountAggregationEnabled(): boolean;
  /** 跨账号 profileId 名单（名单外 remote 来源一律按同账号处理；R4 接账号族快照）。 */
  listCrossAccountProfileIds(): string[];
}

/** 聚合宿主 per-instance 开关环境变量（默认未设=关闭；R4 接管理器设置面）。 */
export const ZCODE_OMNICODE_REMOTE_AGGREGATE_ENV = "ZCODE_OMNICODE_REMOTE_AGGREGATE";

/**
 * 聚合宿主门控（omnicodeAuth.isOmnicodeManagerProcess 同款形态）：omnicode flavor 是
 * 编译期常量（官方构建恒为 false——官方行为零影响的门控基点），per-instance 开关默认关。
 */
export function isOmnicodeRemoteAggregateHostEnabled(
  flavor: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return flavor === "omnicode" && env[ZCODE_OMNICODE_REMOTE_AGGREGATE_ENV] === "1";
}

/** 官方条目 → R1 聚合条目（passthrough 保留 connectionState/lastConnectionError 等官方附加字段）。 */
function toOmnicodeRemoteWorkspaceEntries(
  entries: readonly WebRemoteControlWorkspaceTarget[],
): OmnicodeRemoteWorkspaceEntry[] {
  const parsed: OmnicodeRemoteWorkspaceEntry[] = [];
  for (const entry of entries) {
    const result = omnicodeRemoteWorkspaceEntrySchema.safeParse(entry);
    // 快照异常条目（如缺 label）剔除而非中断聚合——官方条目在 IPC 边界已过
    // webRemoteControlWorkspaceTargetsSchema 校验，此处只作防御性兜底。
    if (result.success) parsed.push(result.data);
  }
  return parsed;
}

type OmnicodeAggregateWindowSnapshotEntry = readonly [
  number,
  readonly WebRemoteControlWorkspaceTarget[],
];

/** 路由命中结果：聚合条目（官方字段 + 附加区）+ 来源类别（+ 本地目标窗口 id）。 */
export interface OmnicodeAggregateRouteResolution {
  entry: OmnicodeAggregatedWorkspaceEntry;
  /** 本地目标窗口（self=呈现窗口 / 窗口 id 来源）；跨实例来源为 undefined。 */
  windowId?: number;
  /** window = 宿主本地窗口（M2 跨窗口/本窗口路由）；instance = 跨实例（R3 转投路径）。 */
  sourceKind: "window" | "instance";
}

export interface OmnicodeRemoteAggregateHost {
  isEnabled(): boolean;
  /**
   * 聚合 workspace 列表（spec §5）：呈现窗口 self 组 → 其余窗口（windowId 升序）remote 组，
   * 组内保持窗口快照原序，aggregatedKey 同键保留首个。条目为官方字段原样 + 聚合附加区
   * （aggregatedKey/sourceProfileId），手机页忽略未知字段（M1-R4 渲染容错）。
   */
  listAggregatedWorkspaces(
    snapshots: Iterable<OmnicodeAggregateWindowSnapshotEntry>,
    presenterWindowId: number,
  ): OmnicodeAggregatedWorkspaceEntry[];
  /**
   * bridge-open/reconnect 的 workspaceKey 反查（R1 路由表/映射语义的 M2 形态 + R3 跨实例）：
   * aggregatedKey 精确匹配优先，其次官方原始 key；命中返回条目与来源类别——
   * sourceKind="window" 携带目标窗口（self 前缀 → 呈现窗口，窗口 id 前缀 → 该窗口）；
   * sourceKind="instance" 为跨实例来源（windowId 缺省，调用方走 R3 转投路径）；
   * 未命中返回 undefined（调用方回退官方路径，官方查找失败回结构化 bridge-error，不瘫）。
   */
  resolveRoute(
    snapshots: Iterable<OmnicodeAggregateWindowSnapshotEntry>,
    presenterWindowId: number,
    workspaceKey: string,
  ): OmnicodeAggregateRouteResolution | undefined;
  /**
   * 已解析目标（官方 target 查找结果）反查归属窗口——bridge attachment 路由使用。
   * 与 resolveRoute 同一聚合列表口径（原始 key 匹配），保证列表呈现与路由一致。
   */
  resolveTargetWindowId(
    snapshots: Iterable<OmnicodeAggregateWindowSnapshotEntry>,
    presenterWindowId: number,
    target: Pick<WebRemoteControlWorkspaceTarget, "workspacePath" | "workspaceIdentity">,
  ): number | undefined;
}

/** sourceProfileId → 窗口 id（self → 呈现窗口；窗口 id 形态白名单外返回 undefined）。 */
function resolveRouteWindowIdFromSource(
  sourceProfileId: string,
  presenterWindowId: number,
): number | undefined {
  if (sourceProfileId === OMNICODE_REMOTE_SELF_PROFILE_ID) return presenterWindowId;
  return /^\d+$/u.test(sourceProfileId) ? Number(sourceProfileId) : undefined;
}

function listAggregatedWorkspaces(
  snapshots: Iterable<OmnicodeAggregateWindowSnapshotEntry>,
  presenterWindowId: number,
  directory?: OmnicodeRemoteWorkspaceDirectoryView,
): OmnicodeAggregatedWorkspaceEntry[] {
  const ordered = [...snapshots].sort(([left], [right]) => left - right);
  const presenterEntries = ordered.find(([windowId]) => windowId === presenterWindowId)?.[1] ?? [];
  // R3：remote 组 = 宿主其余窗口（M2 序在前）→ 在线实例快照（目录 profileId 升序）。
  // aggregateOmnicodeWorkspaceLists 的合并序保持 spec §5：宿主自身 → 同账号 → 跨账号。
  const remoteSources: OmnicodeRemoteWorkspaceListSource[] = [
    ...ordered
      .filter(([windowId]) => windowId !== presenterWindowId)
      .map(([windowId, entries]) => ({
        profileId: String(windowId),
        entries: toOmnicodeRemoteWorkspaceEntries(entries),
      })),
    ...(directory?.listRemoteSources() ?? []),
  ];
  return aggregateOmnicodeWorkspaceLists({
    self: toOmnicodeRemoteWorkspaceEntries(presenterEntries),
    remote: remoteSources,
    includeCrossAccount: directory?.isCrossAccountAggregationEnabled() ?? false,
    crossAccountProfileIds: directory?.listCrossAccountProfileIds() ?? [],
  });
}

export function createOmnicodeRemoteAggregateHost(
  options: { directory?: OmnicodeRemoteWorkspaceDirectoryView } = {},
): OmnicodeRemoteAggregateHost {
  const directory = options.directory;
  const list = (
    snapshots: Iterable<OmnicodeAggregateWindowSnapshotEntry>,
    presenterWindowId: number,
  ): OmnicodeAggregatedWorkspaceEntry[] =>
    listAggregatedWorkspaces(snapshots, presenterWindowId, directory);

  return {
    isEnabled: () => isOmnicodeRemoteAggregateHostEnabled(ZCODE_PRODUCT_FLAVOR),
    listAggregatedWorkspaces: list,
    resolveRoute(snapshots, presenterWindowId, workspaceKey) {
      const aggregated = list(snapshots, presenterWindowId);
      const entry =
        aggregated.find((item) => item.aggregatedKey === workspaceKey) ??
        aggregated.find((item) => resolveOmnicodeRemoteWorkspaceKey(item) === workspaceKey);
      if (!entry) return undefined;
      const windowId = resolveRouteWindowIdFromSource(entry.sourceProfileId, presenterWindowId);
      // R3：跨实例来源（profileId=实例桥真身，非 self/窗口 id）无本地窗口——sourceKind
      // =instance，调用方（manager R3 门控）走转投路径；官方路径不得以本窗口挂载该条目。
      return windowId === undefined
        ? { entry, sourceKind: "instance" }
        : { entry, windowId, sourceKind: "window" };
    },
    resolveTargetWindowId(snapshots, presenterWindowId, target) {
      const aggregated = list(snapshots, presenterWindowId);
      const entry = aggregated.find(
        (item) => resolveOmnicodeRemoteWorkspaceKey(item) === resolveOmnicodeRemoteWorkspaceKey(target),
      );
      if (!entry) return undefined;
      return resolveRouteWindowIdFromSource(entry.sourceProfileId, presenterWindowId);
    },
  };
}
