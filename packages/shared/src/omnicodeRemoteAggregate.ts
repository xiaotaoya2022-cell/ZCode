// [OmniCode] 丙1 远程聚合纯函数层（spec: docs/omnicode/remote-aggregation.md
// §5 workspace-list 聚合语义 + §4 forwardId 幂等去重；R1 骨架，零 UI 零接线）：
// - workspace-list 聚合：宿主自身 → 同账号实例 → 跨账号实例（显式开启后）三组
//   顺序合并，组内保持原序；aggregatedKey = profileId + ":" + workspaceKey
//   （workspaceKey = workspaceIdentity || workspacePath，与官方
//   resolveWebRemoteControlWorkspaceKey 同口径）；同键保留首个（先到优先）。
// - forwardId 路由表：register/take/expire 纯内存 Map（take 即删——转发结果迟到
//   重复天然丢弃的幂等去重语义；expire 只在结果/断连对账事件时点调用，非常驻轮询）。
//
// 红线（实现即约束）：
// - 纯函数零 IO：不取 Date.now、不读文件、不发网络——时刻一律由调用方注入，
//   vitest 无假时钟即可精确断言（R2 接线时宿主时钟由 main 层传入）。
// - 附加元数据全部落新增字段（aggregatedKey/sourceProfileId/...），官方
//   workspace-list 条目字段名零复用零改义——手机页忽略未知字段（spec §5）。
// - 跨账号聚合默认关闭（spec §7）：includeCrossAccount=false 时跨账号条目整组
//   剔除，开关判定只看调用方传入的 crossAccountProfileIds 名单。
import { z } from "zod";
import type { OmnicodeRemoteForwardKind } from "./omnicodeRemoteForward.js";

// ─── workspace-list 条目形状（官方 web-remote-control.ts
//     WebRemoteControlWorkspaceTarget 的字段子集 + passthrough 附加字段）───

/**
 * 官方 workspace-list 条目（WebRemoteControlWorkspaceTarget）子集：聚合去重只依赖
 * workspacePath/workspaceIdentity，展示依赖 label/kind；remoteSessionId 与一切
 * 附加字段经 passthrough 原样透传（宿主不改写官方条目语义）。
 */
export const omnicodeRemoteWorkspaceEntrySchema = z
  .object({
    workspacePath: z.string().min(1),
    workspaceIdentity: z.string().min(1).optional(),
    remoteSessionId: z.string().min(1).optional(),
    label: z.string().min(1),
    kind: z.enum(["local", "remote"]),
  })
  .passthrough();
export type OmnicodeRemoteWorkspaceEntry = z.infer<typeof omnicodeRemoteWorkspaceEntrySchema>;

/** 宿主自身条目的来源 profileId 占位（spec §5：宿主自身条目 profileId="self"）。 */
export const OMNICODE_REMOTE_SELF_PROFILE_ID = "self";

/** workspaceKey 口径：workspaceIdentity（去空白）优先，缺失回退 workspacePath。 */
export function resolveOmnicodeRemoteWorkspaceKey(
  entry: Pick<OmnicodeRemoteWorkspaceEntry, "workspacePath" | "workspaceIdentity">,
): string {
  return entry.workspaceIdentity?.trim() || entry.workspacePath;
}

/** 聚合条目 = 官方条目字段（passthrough 附加字段原样保留）+ 来源元数据（spec §5 附加区）。 */
export interface OmnicodeAggregatedWorkspaceEntry extends OmnicodeRemoteWorkspaceEntry {
  /** 聚合条目键 profileId:workspaceKey（宿主自身来源为 self:workspaceKey）。 */
  aggregatedKey: string;
  /** 来源 profileId（宿主自身 = "self"；被聚合实例 = 桥握手真身）。 */
  sourceProfileId: string;
  /** 来源实例显示名（宿主自身缺省——宿主无需自报名）。 */
  sourceDisplayName?: string;
  /** 跨账号实例条目标记（includeCrossAccount=true 时方可能出现）。 */
  sourceCrossAccount?: boolean;
}

/** 一个被聚合来源（实例）的 workspace-list 快照。 */
export interface OmnicodeRemoteWorkspaceListSource {
  profileId: string;
  displayName?: string;
  entries: OmnicodeRemoteWorkspaceEntry[];
}

export interface AggregateOmnicodeWorkspaceListsInput {
  /** 宿主自身各窗口 workspace（官方 runtime 直连，M2）。 */
  self: OmnicodeRemoteWorkspaceEntry[];
  /** 被聚合实例快照（桥 remoteForward kind=workspace-list 回传，R2/R3 接线）。 */
  remote: OmnicodeRemoteWorkspaceListSource[];
  /** 跨账号聚合开关（spec §7：默认关闭）。 */
  includeCrossAccount: boolean;
  /** 跨账号 profileId 名单（名单外的 remote 来源一律按同账号处理）。 */
  crossAccountProfileIds?: string[];
}

/**
 * 聚合合并（纯函数）：宿主自身 → 同账号 → 跨账号三组顺序拼接，组内保持原序；
 * aggregatedKey 相同保留首个；includeCrossAccount=false 时跨账号来源整组剔除。
 */
export function aggregateOmnicodeWorkspaceLists(
  input: AggregateOmnicodeWorkspaceListsInput,
): OmnicodeAggregatedWorkspaceEntry[] {
  const crossAccountIds = new Set(input.crossAccountProfileIds ?? []);
  const seenKeys = new Set<string>();
  const aggregated: OmnicodeAggregatedWorkspaceEntry[] = [];

  const appendSource = (
    profileId: string,
    displayName: string | undefined,
    isCrossAccount: boolean,
    entries: OmnicodeRemoteWorkspaceEntry[],
  ): void => {
    for (const entry of entries) {
      const aggregatedKey = `${profileId}:${resolveOmnicodeRemoteWorkspaceKey(entry)}`;
      // 同键保留首个（重复条目不覆盖已登记占位——幂等去重语义）。
      if (seenKeys.has(aggregatedKey)) continue;
      seenKeys.add(aggregatedKey);
      aggregated.push({
        ...entry,
        aggregatedKey,
        sourceProfileId: profileId,
        ...(displayName !== undefined ? { sourceDisplayName: displayName } : {}),
        ...(isCrossAccount ? { sourceCrossAccount: true } : {}),
      });
    }
  };

  // 合并顺序（spec §5）：宿主自身 → 同账号实例 → 跨账号实例（显式开启后）。
  appendSource(OMNICODE_REMOTE_SELF_PROFILE_ID, undefined, false, input.self);
  for (const source of input.remote) {
    if (crossAccountIds.has(source.profileId)) continue;
    appendSource(source.profileId, source.displayName, false, source.entries);
  }
  if (input.includeCrossAccount) {
    for (const source of input.remote) {
      if (!crossAccountIds.has(source.profileId)) continue;
      appendSource(source.profileId, source.displayName, true, source.entries);
    }
  }
  return aggregated;
}

// ─── forwardId 路由表（spec §4：forwardId 幂等去重；纯内存 Map，R2 宿主侧消费）───

/**
 * 转发结果回执死线（与 D12 管理器回执死线同量级——覆盖转发执行 + 回环两跳开销）。
 * 超期 pending 由 expire 收口：同一 forwardId 重试重新受理，不无限占位。
 */
export const OMNICODE_REMOTE_FORWARD_PENDING_TTL_MS = 45_000;

/** 一条在途转发的事实（宿主侧登记；remoteForwardResult 回程按 forwardId 取走即删）。 */
export interface OmnicodeRemoteForwardPending {
  forwardId: string;
  /** 转发发起方（桥握手真身；管理器回 remoteForwardResult 的目标）。 */
  sourceProfileId: string;
  kind: OmnicodeRemoteForwardKind;
  /** 登记时刻（宿主时钟注入；expire 按此刻差收口——纯函数不取 Date.now）。 */
  registeredAt: number;
}

export interface OmnicodeForwardRouteTable {
  /** 登记 pending（首个生效；重复 register 返回 false，不覆盖既有占位）。 */
  register(pending: OmnicodeRemoteForwardPending): boolean;
  /** 取走即删：命中返回 pending 并移除；未命中/已取走返回 null（幂等去重收口）。 */
  take(forwardId: string): OmnicodeRemoteForwardPending | null;
  /**
   * 死线收口：nowMs - registeredAt > ttl 的 pending 全部清除并返回被清清单。
   * 只在转发结果/断连对账事件时点调用，非常驻轮询。
   */
  expire(nowMs: number): OmnicodeRemoteForwardPending[];
  /** 在途数量（测试与管理器聚合状态展示用）。 */
  size(): number;
}

export function createOmnicodeForwardRouteTable(
  options: { ttlMs?: number } = {},
): OmnicodeForwardRouteTable {
  const ttlMs = options.ttlMs ?? OMNICODE_REMOTE_FORWARD_PENDING_TTL_MS;
  const pendingById = new Map<string, OmnicodeRemoteForwardPending>();
  return {
    register(pending) {
      if (pendingById.has(pending.forwardId)) return false;
      pendingById.set(pending.forwardId, pending);
      return true;
    },
    take(forwardId) {
      const pending = pendingById.get(forwardId);
      if (pending === undefined) return null;
      pendingById.delete(forwardId);
      return pending;
    },
    expire(nowMs) {
      const swept: OmnicodeRemoteForwardPending[] = [];
      for (const [forwardId, pending] of pendingById) {
        if (nowMs - pending.registeredAt > ttlMs) {
          pendingById.delete(forwardId);
          swept.push(pending);
        }
      }
      return swept;
    },
    size() {
      return pendingById.size;
    },
  };
}
