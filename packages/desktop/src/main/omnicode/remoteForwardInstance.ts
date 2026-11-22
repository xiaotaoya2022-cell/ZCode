// [OmniCode] 丙1 远程聚合 R3——跨实例桥转发（被聚合实例侧执行器，spec:
// docs/omnicode/remote-aggregation.md §4/§5/§8-R3）。角色边界（spec §3）：
// 被聚合实例**不注册 relay、不复用任何凭据发 relay**——它只在既有实例桥链上做两件事：
// 1. 应答管理器的目录查询（remoteWorkspaceListRequest → remoteWorkspaceListResult）：
//    回自身全部窗口的可用工作区快照（webRemoteControlManager 的
//    availableWorkspacesByWindowId 只读探针，见 manager listWindowWorkspaceSnapshots）。
// 2. 快照变化上行报告（remoteWorkspaceListReport，事件驱动零轮询——实例 renderer 同步
//    工作区时经 index.ts 调 notifyOmnicodeRemoteWorkspaceSnapshotChanged 推送）。
// 红线（实现即约束）：
// - 回包字节守门：超官方 relay 物理帧上限（1MiB）→ 结构化 error 拒绝（entries 置空），
//   不分片（spec §4 v1 语义）；管理器收到 error 结果保留既有缓存（不空覆盖）。
// - 实例身份门控：快照探针仅在 omnicode 实例身份进程装配（index.ts isOmnicodeProfileInstanceEnv）；
//   探针缺席时全部请求静默丢弃（管理器查询死线惰性收口，不瘫）。
// - 载荷白名单：快照条目逐条过 omnicodeRemoteWorkspaceEntrySchema（防御性兜底，异常条目
//   剔除不中断）；条目数封顶 OMNICODE_REMOTE_WORKSPACE_LIST_MAX_ENTRIES（超出的条目丢弃，
//   宁少不假——与管理器侧 schema 上限同源）。
// - 无状态无重试：Result/Report 发送失败（桥未连/断连中）直接放弃，由下一事件收敛；
//   无常驻轮询无 timer。
// [OmniCode] 丙1 R4 增量：本地目录视图缓存（快照 memo——Result 应答复用，Report 现读
// 刷新，remoteHostAnnounce 宿主变更广播到达即失效）+ remoteHostAnnounce 接收（epoch
// 单调去重 + 视图失效，spec §6 failover 提示的实例侧收口；宿主自动转移为二期不做）。
import {
  OMNICODE_REMOTE_WORKSPACE_LIST_MAX_ENTRIES,
  isOmnicodeRemoteForwardPayloadWithinLimit,
  omnicodeRemoteHostAnnounceMessageSchema,
  omnicodeRemoteWorkspaceEntrySchema,
  omnicodeRemoteWorkspaceListRequestCommandSchema,
  type OmnicodeRemoteWorkspaceEntry,
} from "@zcode/shared";

/** 实例侧快照探针（index.ts 装配：manager listWindowWorkspaceSnapshots；缺席 = 执行器禁用）。 */
export type OmnicodeRemoteWorkspaceSnapshotProvider = () => Array<
  readonly [number, readonly unknown[]]
>;

/** 桥上行发送函数（instanceBridgeClient 注入 sendOmnicodeInstanceBridgeUplink 同款签名）。 */
export type OmnicodeRemoteWorkspaceUplinkSend = (message: unknown) => boolean;

let snapshotProvider: OmnicodeRemoteWorkspaceSnapshotProvider | null = null;

/**
 * [OmniCode] 丙1 远程聚合 R4：本地目录视图缓存（快照 memo）。Report/Result 构建时以
 * 探针现读刷新（快照变化事件总是先经 syncWebRemoteControlWorkspaces → notify 上行，
 * memo 不会滞后于 manager 快照事实）；remoteWorkspaceListRequest 应答复用 memo，
 * 避免 Result 应答对同值快照的重复换算。宿主变更广播（remoteHostAnnounce，R4 failover）
 * 到达即整表失效——下一次查询/报告重建（spec §6 视图失效语义，无轮询）。
 */
let snapshotMemo: OmnicodeRemoteWorkspaceEntry[] | null = null;

function readSnapshotMemo(): OmnicodeRemoteWorkspaceEntry[] {
  if (snapshotMemo === null) {
    snapshotMemo = toOmnicodeRemoteDirectoryEntries(
      (snapshotProvider?.() ?? []).map(([, windowEntries]) => windowEntries),
    );
  }
  return snapshotMemo;
}

/** 快照探针/目录缓存失效（R4：announce 到达 / 测试复位）。下一次读取重建。 */
export function invalidateOmnicodeRemoteWorkspaceSnapshotMemo(): void {
  snapshotMemo = null;
}

/** 装配快照探针（仅 omnicode 实例身份进程调用；null 复位）。 */
export function setOmnicodeRemoteWorkspaceSnapshotProvider(
  provider: OmnicodeRemoteWorkspaceSnapshotProvider | null,
): void {
  snapshotProvider = provider;
  invalidateOmnicodeRemoteWorkspaceSnapshotMemo();
}

/**
 * 快照 → 目录条目（纯函数）：逐条 schema 兜底过滤 + 条目数封顶；空列表合法
 * （实例未开任何工作区时上报空快照，管理器侧空来源不进聚合列表）。
 */
export function toOmnicodeRemoteDirectoryEntries(
  snapshots: ReadonlyArray<readonly unknown[]>,
): OmnicodeRemoteWorkspaceEntry[] {
  const parsed: OmnicodeRemoteWorkspaceEntry[] = [];
  for (const windowEntries of snapshots) {
    for (const entry of windowEntries) {
      if (parsed.length >= OMNICODE_REMOTE_WORKSPACE_LIST_MAX_ENTRIES) return parsed;
      const result = omnicodeRemoteWorkspaceEntrySchema.safeParse(entry);
      if (result.success) parsed.push(result.data);
    }
  }
  return parsed;
}

/**
 * 目录回包决策（纯函数）：serialized 字节量超官方 relay 物理帧上限 → 结构化拒绝
 * （entries 置空 + error 摘要，不分片——spec §4 v1 语义）。与目录 Result 的
 * remoteWorkspaceListResultMessageSchema error 字段（max 120）同源。
 */
export function resolveOmnicodeRemoteWorkspaceListReply(
  entries: OmnicodeRemoteWorkspaceEntry[],
  payloadBytes: number,
): { entries: OmnicodeRemoteWorkspaceEntry[]; error?: string } {
  if (isOmnicodeRemoteForwardPayloadWithinLimit(payloadBytes)) {
    return { entries };
  }
  return { entries: [], error: "workspace_list_too_large" };
}

/**
 * 桥下行 remoteWorkspaceListRequest（instanceBridgeClient.applyCommand 委托）：
 * 快照探针缺席/桥未连/回包超限（结构化 error 回包）均不瘫——管理器侧以缓存与
 * 死线收口（迟到应答仍刷新缓存）。条目读本地目录视图缓存（R4 memo——探针现读
 * 在 Report/失效时点完成）。
 */
export function handleOmnicodeRemoteWorkspaceListRequest(
  command: unknown,
  sendUplink: OmnicodeRemoteWorkspaceUplinkSend,
): void {
  const parsed = omnicodeRemoteWorkspaceListRequestCommandSchema.safeParse(command);
  if (!parsed.success || !snapshotProvider) return;
  const entries = readSnapshotMemo();
  const serialized = JSON.stringify({
    type: "remoteWorkspaceListResult",
    requestId: parsed.data.requestId,
    entries,
  });
  const reply = resolveOmnicodeRemoteWorkspaceListReply(
    entries,
    Buffer.byteLength(serialized, "utf8"),
  );
  sendUplink({
    type: "remoteWorkspaceListResult",
    requestId: parsed.data.requestId,
    entries: reply.entries,
    ...(reply.error !== undefined ? { error: reply.error } : {}),
  });
}

/**
 * 快照变化上行报告（index.ts syncWebRemoteControlWorkspaces 时点调用，事件驱动零轮询）。
 * 探针缺席/桥未连/快照为空序列化超限（Report 无 error 位——直接不发，下一事件收敛）均
 * 静默放弃；返回 false 便于调用方记日志（无重试）。报告前以探针现读刷新本地目录视图
 * 缓存（memo 的唯一刷新面——快照事实永远先经本函数落到实例侧目录缓存）。
 */
export function notifyOmnicodeRemoteWorkspaceSnapshotChanged(
  sendUplink: OmnicodeRemoteWorkspaceUplinkSend,
): boolean {
  if (!snapshotProvider) return false;
  const entries = toOmnicodeRemoteDirectoryEntries(
    snapshotProvider().map(([, windowEntries]) => windowEntries),
  );
  snapshotMemo = entries;
  const serialized = JSON.stringify({ type: "remoteWorkspaceListReport", entries });
  if (!isOmnicodeRemoteForwardPayloadWithinLimit(Buffer.byteLength(serialized, "utf8"))) {
    return false;
  }
  return sendUplink({ type: "remoteWorkspaceListReport", entries });
}

// ─── R4 failover：remoteHostAnnounce 实例侧接收（spec: docs/omnicode/
//     remote-aggregation.md §6——宿主变更广播；本阶段不做宿主自动转移，接收面只做
//     epoch 去重 + 本地目录视图失效）───

/** 实例侧已接收的最大 announce epoch（首次广播初始化；旧值/同值忽略——shared schema 约定）。 */
let lastAnnounceEpoch: number | null = null;

/**
 * 桥下行 remoteHostAnnounce（instanceBridgeClient.applyCommand 委托）：shared schema
 * 校验（载荷形态/hostProfileId 白名单）→ epoch 单调性裁决（旧值/同值忽略，R1 schema
 * 注释语义）→ 本地目录视图缓存失效（快照探针重置——下一次查询/报告重建，无轮询）。
 * 返回 true = 该广播被接受（测试断言面；管理器查询死线与下一次 Report 兜底收敛）。
 */
export function handleOmnicodeRemoteHostAnnounce(message: unknown): boolean {
  const parsed = omnicodeRemoteHostAnnounceMessageSchema.safeParse(message);
  if (!parsed.success) return false;
  if (lastAnnounceEpoch !== null && parsed.data.epoch <= lastAnnounceEpoch) {
    return false; // 旧值/同值广播忽略（实例按 epoch 判新旧——shared schema 注释语义）
  }
  lastAnnounceEpoch = parsed.data.epoch;
  invalidateOmnicodeRemoteWorkspaceSnapshotMemo();
  return true;
}

/** 测试复位：epoch 状态清零（跨用例隔离；生产进程只收不重置）。 */
export function resetOmnicodeRemoteHostAnnounceForTest(): void {
  lastAnnounceEpoch = null;
  invalidateOmnicodeRemoteWorkspaceSnapshotMemo();
}
