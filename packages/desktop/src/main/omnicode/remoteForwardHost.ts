// [OmniCode] 丙1 远程聚合 R3——跨实例桥转发（管理器侧，spec: docs/omnicode/remote-aggregation.md
// §3/§4/§5/§8-R3）。职责边界（聚合宿主 = 管理器进程：webRemoteControlManager 所在的
// console 主进程同时持有 instanceBridgeServer，跨实例目录与转投经同一桥直调，无 loopback）：
// - workspace-list 跨实例目录：向各在线实例桥发 remoteWorkspaceListRequest；实例执行器
//   （remoteForwardInstance.ts）回 Result / 快照变化上行 Report；离线（disconnected）摘除。
//   全部事件驱动零轮询（spec §7）：查询只在实例连接时点发起，刷新靠实例上行推送。
// - bridge-open 转投（v1 最小闭环）：手机对跨实例工作区发起 bridge-open → 管理器按目录
//   归属实例转发既有 openWorkspace 桥命令（实例走自身正常打开流程，尊重工作区锁——
//   批次2 B2-1 T4 同链）；手机侧 bridge 以结构化 workspace-bridge-error 收口（rpc-frame
//   跨实例双向转发为 R3.5，接口见 shared omnicodeRemoteForward.ts 守门常量）。
// - 跨账号开关接口（spec §7 默认关）：readCrossAccountAggregation / listCrossAccountProfileIds
//   缺省恒 false/恒空（全部在线实例按同账号聚合）；R4 接 omnicodeGlobalPrefs 设置面
//   与实例账号族快照时替换注入即可，目录/聚合代码零改动。
// [OmniCode] 丙1 R4 增量（spec: docs/omnicode/remote-aggregation.md §6/§7/§8-R4）：
// - 跨账号开关接线面落地：readCrossAccountAggregation ← globalPrefs 开关缓存
//   （omnicodeRemoteCrossAccount，侧车持久化 + applyGlobalPrefs 下发，缺省关）；
//   listCrossAccountProfileIds ← accountFamily 账号族快照（未知身份保守归类同账号，
//   保持 R3 缺省聚合行为不变）。
// - failover 提示链（宿主退出，自动转移为二期）：宿主登记（noteOmnicodeRemoteAggregate
//   HostInstance，无选举事实时生产装配不指派——不误报）→ onInstanceDisconnected 对账
//   → deps.onAggregateHostExit（管理器 toast）+ remoteHostAnnounce(epoch+1) 广播剩余
//   实例刷新目录视图；门控关零提示零广播（spec §7）。
//
// 红线（实现即约束）：
// - 门控 = isOmnicodeRemoteAggregateHostEnabled（flavor=omnicode ∧ per-instance env 开关，
//   R2 同款）；开关关闭零查询零缓存零转发（send/query/ingest 全部先过门控）。
// - 身份绑定：来源 profileId 一律取桥握手真身（desktopProfileIpc 钩子首参），载荷自报值
//   不参与授权判定；实例显示名由管理器按 Profile 注册表解析（takeoverCoordinator 同款，防伪造）。
// - 不复用被聚合实例凭据发 relay：本模块只经桥收发命令/快照，实例侧零 relay 连接。
// - 无新增常驻轮询：无 timer 无 interval；查询超时以惰性收口（下次事件时点扫表），
//   迟到 Result 仍刷新缓存（缓存即最新事实，无需 pending 路由——forwardId 路由表留给 R3.5）。
import { randomUUID } from "node:crypto";
import {
  OMNICODE_REMOTE_FORWARD_RPC_FRAME_MAX_BYTES,
  omnicodeRemoteHostAnnounceMessageSchema,
  omnicodeRemoteWorkspaceListRequestCommandSchema,
  type OmnicodeRemoteWorkspaceEntry,
  type OmnicodeRemoteWorkspaceListRequestCommand,
  type OmnicodeRemoteWorkspaceListSource,
  type OmnicodeRemoteWorkspaceListUplinkMessage,
  ZCODE_PRODUCT_FLAVOR,
} from "@zcode/shared";
import {
  isOmnicodeRemoteAggregateHostEnabled,
  type OmnicodeRemoteWorkspaceDirectoryView,
} from "./remoteAggregateHost.js";

/** 惰性收口的目录查询在途死线（本地桥回环两跳 + 实例快照读取，10s 足量；超期即失效）。 */
export const OMNICODE_REMOTE_WORKSPACE_LIST_QUERY_TTL_MS = 10_000;

/** 被聚合实例 workspace-list 回包字节上限（= 官方 relay 物理帧上限；超限结构化拒绝不分片）。 */
export const OMNICODE_REMOTE_WORKSPACE_LIST_RESULT_MAX_BYTES = OMNICODE_REMOTE_FORWARD_RPC_FRAME_MAX_BYTES;

// 目录视图类型唯一定义处 = remoteAggregateHost.ts（OmnicodeRemoteWorkspaceDirectoryView，
// 聚合宿主的消费契约）；本模块提供其实现与注入面。

/** 手机侧跨实例 bridge-open 的转投请求（manager R3 门控分支构造）。 */
export interface OmnicodeRemoteForwardOpenRequest {
  /** 归属实例（桥握手真身；self/窗口 id 形态一律拒绝转投）。 */
  sourceProfileId: string;
  workspacePath: string;
  workspaceKey: string;
  bridgeSessionId: string;
}

export interface OmnicodeRemoteForwardOpenResult {
  /** true = openWorkspace 转投命令已投递归属实例；false 携带结构化摘要（不含手机载荷）。 */
  forwarded: boolean;
  error?: string;
}

/** 管理器消费的跨实例转发面（webRemoteControlManager 依赖注入；缺省/门控关 = 官方路径逐字不变）。 */
export interface OmnicodeRemoteForwardHost {
  /** 与聚合宿主同一门控（flavor ∧ env）；官方 flavor 恒 false。 */
  isEnabled(): boolean;
  /** bridge-open 转投（v1）：命令归属实例本地打开工作区；实例离线/非本地条目返回不投递。 */
  openWorkspaceOnInstance(request: OmnicodeRemoteForwardOpenRequest): OmnicodeRemoteForwardOpenResult;
}

export interface OmnicodeRemoteForwardHostDeps {
  /**
   * 桥命令发送（管理器进程装配 sendOmnicodeInstanceCommand；单测注入 fake）。
   * false = 实例未回连。命令域 = 目录查询 + openWorkspace 转投（既有桥命令复用）+
   * remoteHostAnnounce 广播（R4 failover，spec §6）。
   */
  sendCommand: (
    profileId: string,
    command:
      | OmnicodeRemoteWorkspaceListRequestCommand
      | { type: "openWorkspace"; path: string }
      | { type: "remoteHostAnnounce"; hostProfileId: string; epoch: number },
  ) => boolean;
  /** 当前已回连实例（管理器进程装配 getOmnicodeConnectedInstanceProfileIds；单测注入）。 */
  getConnectedProfileIds: () => string[];
  /** 实例显示名解析（Profile 注册表，防伪造名；缺省不解名——附加区仅缺 displayName）。 */
  resolveProfileDisplayName?: (profileId: string) => Promise<string | null>;
  /** 门控覆盖（单测注入；缺省 = isOmnicodeRemoteAggregateHostEnabled(编译期 flavor)）。 */
  isAggregateEnabled?: () => boolean;
  /** 跨账号聚合开关读取（R4 接设置面；缺省恒 false = spec §7 默认关）。 */
  readCrossAccountAggregation?: () => boolean;
  /** 跨账号 profileId 名单读取（R4 接账号族快照；缺省恒空 = 全部按同账号处理）。 */
  listCrossAccountProfileIds?: () => string[];
  /**
   * [OmniCode] 丙1 R4 failover：聚合宿主退出通知（desktopProfileIpc 装配 → 管理器
   * renderer toast 提示 + remoteHostAnnounce 广播链的宿主侧第一拍）。缺省 = 仅记日志。
   */
  onAggregateHostExit?: (profileId: string) => void;
  /** 目录查询在途死线（单测注入；缺省 10s，惰性收口非常驻轮询）。 */
  queryTtlMs?: number;
  /** 时刻源（单测注入；缺省 Date.now）。 */
  nowMs?: () => number;
  /** 目录变化通知（index.ts 装配：manager.omnicodeOnRemoteWorkspacesChanged）。 */
  onWorkspacesChanged?: () => void;
}

interface OmnicodeRemoteForwardCore {
  isEnabled(): boolean;
  queryInstance(profileId: string): boolean;
  queryAllConnectedInstances(): void;
  handleUplink(profileId: string, message: OmnicodeRemoteWorkspaceListUplinkMessage | null): void;
  handleInstanceConnected(profileId: string): void;
  handleInstanceDisconnected(profileId: string): void;
  getDirectoryView(): OmnicodeRemoteWorkspaceDirectoryView;
  openWorkspaceOnInstance(request: OmnicodeRemoteForwardOpenRequest): OmnicodeRemoteForwardOpenResult;
  noteAggregateHostInstance(profileId: string | null): void;
  handleAggregateHostDisconnected(profileId: string): boolean;
  broadcastHostAnnounce(hostProfileId: string | null): number;
}

const INSTANCE_PROFILE_ID_PATTERN = /^p[0-9a-z]{8,20}$/u;

function toDirectoryEntries(entries: readonly OmnicodeRemoteWorkspaceEntry[]): OmnicodeRemoteWorkspaceEntry[] {
  // 上行载荷已在桥服务侧按 shared schema 校验；此处仅复制引用（目录条目只读消费）。
  return [...entries];
}

function createOmnicodeRemoteForwardCore(deps: OmnicodeRemoteForwardHostDeps): OmnicodeRemoteForwardCore {
  const ttlMs = deps.queryTtlMs ?? OMNICODE_REMOTE_WORKSPACE_LIST_QUERY_TTL_MS;
  const now = deps.nowMs ?? Date.now;
  const isEnabled = deps.isAggregateEnabled ?? (() => isOmnicodeRemoteAggregateHostEnabled(ZCODE_PRODUCT_FLAVOR));

  /** profileId → 最近一次快照（Result 应答与 Report 推送同源覆盖——缓存即最新事实）。 */
  const entriesByProfileId = new Map<string, OmnicodeRemoteWorkspaceEntry[]>();
  const displayNamesByProfileId = new Map<string, string>();
  /** 在途查询（profileId → 登记时刻）。惰性收口：TTL 过期只在下一次事件时点清扫。 */
  const pendingQueries = new Map<string, number>();
  let namesResolving = false;

  // ─── R4 failover 状态（spec: docs/omnicode/remote-aggregation.md §6）───
  // 聚合宿主登记（桥真身 profileId；null = R3 拓扑缺省"宿主 = 管理器进程本进程"，
  // 不再单独指派实例——宿主选举/自动转移为 spec 二期，本阶段登记面仅显式 API +
  // 单测覆盖，避免无选举事实时的误报 toast）。epoch 单调递增（remoteHostAnnounce
  // 广播序，实例按 epoch 判新旧广播——R1 schema 注释语义）。
  let designatedHostProfileId: string | null = null;
  let announceEpoch = 0;

  const notifyChanged = (): void => {
    // 双通道：deps.onWorkspacesChanged（单测注入）+ 模块通知器（index.ts 装配的管理器
    // omnicodeOnRemoteWorkspacesChanged）。通知是旁路能力（重推聚合列表），异常不影响目录。
    for (const notify of [deps.onWorkspacesChanged, workspacesChangedNotifier]) {
      try {
        notify?.();
      } catch {
        // 旁路失败吞掉（聚合重推失败不影响目录状态与手机端既有列表）。
      }
    }
  };

  /** 惰性收口：TTL 过期的在途查询出队（只在 Result/Report/连接/断连事件时点调用）。 */
  function sweepExpiredQueries(): void {
    const nowValue = now();
    for (const [profileId, registeredAt] of pendingQueries) {
      if (nowValue - registeredAt > ttlMs) {
        pendingQueries.delete(profileId);
      }
    }
  }

  async function refreshDisplayName(profileId: string): Promise<void> {
    if (!deps.resolveProfileDisplayName || displayNamesByProfileId.has(profileId)) return;
    if (namesResolving) return; // 解析中到来的事件等下一轮触发（显示名非关键路径，不排队）
    namesResolving = true;
    try {
      const name = await deps.resolveProfileDisplayName(profileId);
      if (name && entriesByProfileId.has(profileId)) {
        displayNamesByProfileId.set(profileId, name);
        notifyChanged();
      }
    } finally {
      namesResolving = false;
    }
  }

  function ingestEntries(profileId: string, entries: OmnicodeRemoteWorkspaceEntry[]): void {
    entriesByProfileId.set(profileId, toDirectoryEntries(entries));
    pendingQueries.delete(profileId);
    notifyChanged();
    void refreshDisplayName(profileId);
  }

  const core: OmnicodeRemoteForwardCore = {
    isEnabled,
    queryInstance(profileId) {
      // 门控关闭零查询（spec §7 开关语义：聚合目录只在校准开启后工作）。
      if (!isEnabled()) return false;
      sweepExpiredQueries();
      if (pendingQueries.has(profileId)) return false; // 在途查询去重（迟到应答仍刷新缓存）
      const parsed = omnicodeRemoteWorkspaceListRequestCommandSchema.safeParse({
        type: "remoteWorkspaceListRequest",
        requestId: `rw-${randomUUID()}`,
      });
      if (!parsed.success) return false;
      const sent = deps.sendCommand(profileId, parsed.data);
      if (sent) pendingQueries.set(profileId, now());
      return sent;
    },
    queryAllConnectedInstances() {
      if (!isEnabled()) return;
      for (const profileId of deps.getConnectedProfileIds()) {
        core.queryInstance(profileId);
      }
    },
    handleUplink(profileId, message) {
      // 门控关闭零缓存（实例上行直接丢弃——开关关闭的宿主对跨实例快照零消费）。
      if (!isEnabled() || !message) return;
      sweepExpiredQueries();
      if (message.type === "remoteWorkspaceListResult") {
        // Result 即使 requestId 未命中在途表也接受（迟到应答仍是最新事实——缓存即真相）；
        // 实例侧结构化拒绝（超限等）不覆盖既有缓存（保留上一份可用快照）。
        if (message.error !== undefined && message.entries.length === 0) return;
        ingestEntries(profileId, message.entries);
        return;
      }
      ingestEntries(profileId, message.entries);
    },
    handleInstanceConnected(profileId) {
      if (!isEnabled()) return;
      // 连接即查询（spec §5 目录来源收敛：实例上行 Report 与管理器查询双保险，
      // 覆盖实例桥先连、实例 renderer 慢就绪的时序差）。
      core.queryInstance(profileId);
    },
    handleInstanceDisconnected(profileId) {
      // spec §6：被聚合实例退出 → 条目从聚合列表摘除（在途 bridge 关闭语义由 R3.5
      // 承接——v1 跨实例条目在宿主侧无在途 bridge，摘除即收口）。
      const removed =
        entriesByProfileId.delete(profileId) ||
        displayNamesByProfileId.delete(profileId) ||
        pendingQueries.delete(profileId);
      if (removed) notifyChanged();
    },
    getDirectoryView() {
      return {
        listRemoteSources() {
          if (!isEnabled()) return [];
          const sources: OmnicodeRemoteWorkspaceListSource[] = [];
          for (const profileId of [...entriesByProfileId.keys()].sort()) {
            const entries = entriesByProfileId.get(profileId);
            if (!entries || entries.length === 0) continue;
            const displayName = displayNamesByProfileId.get(profileId);
            sources.push({
              profileId,
              ...(displayName !== undefined ? { displayName } : {}),
              entries,
            });
          }
          return sources;
        },
        isCrossAccountAggregationEnabled() {
          return isEnabled() && (deps.readCrossAccountAggregation?.() ?? false);
        },
        listCrossAccountProfileIds() {
          return isEnabled() ? (deps.listCrossAccountProfileIds?.() ?? []) : [];
        },
      };
    },
    openWorkspaceOnInstance(request) {
      if (!isEnabled()) {
        return { forwarded: false, error: "aggregate_disabled" };
      }
      // 归属实例必须是桥真身形态（self/窗口 id 形态一律拒绝——防伪造路由面）。
      if (!INSTANCE_PROFILE_ID_PATTERN.test(request.sourceProfileId)) {
        return { forwarded: false, error: "invalid_source_profile_id" };
      }
      // 转投命令 = 既有 openWorkspace 桥命令（批次2 B2-1 T4 同链：实例走自身正常打开
      // 流程，saveProject 锁守卫尊重工作区锁）。实例离线/投递失败返回不投递（不重试——
      // 手机侧已按结构化 error 收口，重试会放大无效 bridge-open）。
      const sent = deps.sendCommand(request.sourceProfileId, {
        type: "openWorkspace",
        path: request.workspacePath,
      });
      return sent ? { forwarded: true } : { forwarded: false, error: "instance_offline" };
    },
    noteAggregateHostInstance(profileId) {
      // 宿主登记（R4 failover 事实源；null = 注销/回退管理器本进程宿主形态）。
      designatedHostProfileId =
        profileId && INSTANCE_PROFILE_ID_PATTERN.test(profileId) ? profileId : null;
    },
    handleAggregateHostDisconnected(profileId) {
      // spec §6：宿主退出 → 管理器提示 + remoteHostAnnounce(epoch+1) 广播各实例刷新
      // 目录视图；不做宿主自动转移（二期）。双保险门控：聚合门控关时零提示零广播
      // （spec §7 开关语义），登记缺席（null）不误报——R3 拓扑缺省宿主 = 管理器进程。
      if (!isEnabled() || designatedHostProfileId !== profileId) return false;
      designatedHostProfileId = null;
      try {
        deps.onAggregateHostExit?.(profileId);
      } catch {
        // 通知旁路失败吞掉（announce 广播不受影响——目录对账照常收敛）。
      }
      // 宿主退出广播：hostProfileId 携带退出宿主真身（实例只消费 epoch 做视图失效）。
      core.broadcastHostAnnounce(profileId);
      return true;
    },
    broadcastHostAnnounce(hostProfileId) {
      // 宿主变更广播（epoch+1）经既有桥命令面下发全部已回连实例：载荷按 R1 schema
      // 校验后投递；hostProfileId 缺席/形态非法时仅递增 epoch 不投递（R1 schema 的
      // hostProfileId 白名单是桥真身形态——无宿主事实不伪造广播面）。fire-and-forget
      // 不重试（实例断连场景由断连摘除对账收敛）。门控关零递增零投递（零行为）。
      if (!isEnabled()) return announceEpoch;
      announceEpoch += 1;
      const parsed = omnicodeRemoteHostAnnounceMessageSchema.safeParse({
        type: "remoteHostAnnounce",
        hostProfileId,
        epoch: announceEpoch,
      });
      if (!parsed.success) return announceEpoch;
      for (const profileId of deps.getConnectedProfileIds()) {
        deps.sendCommand(profileId, parsed.data);
      }
      return announceEpoch;
    },
  };
  return core;
}

// ─── 模块级单例（takeoverCoordinator 同款装配形态）───

let core: OmnicodeRemoteForwardCore | null = null;

/**
 * 装配跨实例转发核心（仅管理器进程 omnicode flavor 调用——desktopProfileIpc，与
 * omnicodeSharedAssetsCache 同门控位置）。重复装配替换实例（测试复位用 reset）。
 */
export function setupOmnicodeRemoteForwardHost(deps: OmnicodeRemoteForwardHostDeps): void {
  core = createOmnicodeRemoteForwardCore(deps);
  // 装配即对已回连实例做一次目录查询（覆盖"实例先连、装配后至"的启动时序差）。
  core.queryAllConnectedInstances();
}

/** 测试复位（清空单例——跨用例隔离；生产进程只装配一次）。 */
export function resetOmnicodeRemoteForwardHostForTest(): void {
  core = null;
}

/**
 * webRemoteControlManager 依赖注入面（index.ts 装配）。返回**稳定惰性转发面**——
 * manager 依赖在模块加载期装配（先于单例建立），isEnabled/openWorkspaceOnInstance 每次
 * 调用透传当前单例；装配缺席（官方 flavor / 非管理器进程）时恒 disabled 恒不投递，
 * 与"依赖缺席 = 官方路径逐字不变"等价。
 */
export function getOmnicodeRemoteForwardHost(): OmnicodeRemoteForwardHost {
  const stable: OmnicodeRemoteForwardHost = {
    isEnabled: () => core?.isEnabled() ?? false,
    openWorkspaceOnInstance: (request) =>
      core
        ? core.openWorkspaceOnInstance(request)
        : { forwarded: false, error: "aggregate_disabled" },
  };
  return stable;
}

/**
 * remoteAggregateHost 的目录视图注入面（index.ts 装配）。返回**稳定惰性视图**——
 * 聚合宿主在模块加载期创建（先于 desktopProfileIpc 的单例装配），视图方法每次调用
 * 透传当前单例状态；装配缺席（官方 flavor / 非管理器进程）时恒空列表恒关开关，
 * 与"目录缺席 = R2 M2 行为逐字不变"等价。
 */
export function getOmnicodeRemoteWorkspaceDirectoryView(): OmnicodeRemoteWorkspaceDirectoryView {
  const stable: OmnicodeRemoteWorkspaceDirectoryView = {
    listRemoteSources: () => core?.getDirectoryView().listRemoteSources() ?? [],
    isCrossAccountAggregationEnabled: () =>
      core?.getDirectoryView().isCrossAccountAggregationEnabled() ?? false,
    listCrossAccountProfileIds: () => core?.getDirectoryView().listCrossAccountProfileIds() ?? [],
  };
  return stable;
}

// ─── desktopProfileIpc managerHooks 消费面（钩子面照常挂载，单例缺席时全部 no-op——
//     与 D12 takeover 钩子同先例：官方 flavor 无实例上行，死钩子零影响）───

/**
 * 实例 workspace-list 目录上行（Result 应答 / Report 报告）。载荷已由桥服务侧按
 * omnicodeRemoteWorkspaceListUplinkSchema 校验，null = 校验失败（静默丢弃，不瘫）。
 */
export function handleOmnicodeRemoteWorkspaceListUplink(
  profileId: string,
  message: OmnicodeRemoteWorkspaceListUplinkMessage | null,
): void {
  core?.handleUplink(profileId, message);
}

/** 实例回连：即时目录查询（门控开才发出）。 */
export function handleOmnicodeRemoteWorkspaceInstanceConnected(profileId: string): void {
  core?.handleInstanceConnected(profileId);
}

/** 实例断连：快照摘除 + 聚合列表重推（spec §6 对账）。 */
export function handleOmnicodeRemoteWorkspaceInstanceDisconnected(profileId: string): void {
  core?.handleInstanceDisconnected(profileId);
}

// ─── R4 failover 装配面（desktopProfileIpc managerHooks 消费；单例缺席全部 no-op——
//     与 D12 takeover 钩子同先例：官方 flavor 无实例上行，死钩子零影响）───

/**
 * 聚合宿主实例登记（R4 failover 事实源；null = 注销/回退管理器本进程宿主形态）。
 * R3 拓扑缺省宿主 = 管理器进程（目录/转投都直调本进程桥）——生产装配**不做实例宿主
 * 选举**（spec §6 选举/自动转移同为二期），本 API 为选举落地预留 + 单测覆盖面：
 * 未登记时实例断连零误报（宁缺毋滥——假宿主退出 toast 比无 toast 更伤信任）。
 */
export function noteOmnicodeRemoteAggregateHostInstance(profileId: string | null): void {
  core?.noteAggregateHostInstance(profileId);
}

/**
 * 实例断连 → 聚合宿主退出对账（desktopProfileIpc onInstanceDisconnected 挂载，
 * handleOmnicodeTakeoverInstanceDisconnected 同款位置）：门控开 ∧ 断连者 = 登记宿主
 * → ① deps.onAggregateHostExit（管理器 toast 提示链）② remoteHostAnnounce(epoch+1)
 * 广播剩余实例刷新目录视图。返回是否触发（测试断言面）。
 */
export function handleOmnicodeRemoteAggregateInstanceDisconnected(profileId: string): boolean {
  return core?.handleAggregateHostDisconnected(profileId) ?? false;
}

/**
 * 宿主变更广播（epoch+1）直发面（宿主选举落地后的装配入口；当前仅测试消费）。
 * hostProfileId 必须为桥真身形态——无效形态只递增 epoch 不投递（不伪造广播面）。
 */
export function broadcastOmnicodeRemoteHostAnnounce(hostProfileId: string | null): number {
  return core?.broadcastHostAnnounce(hostProfileId) ?? 0;
}

// ─── index.ts 装配面 ───

let workspacesChangedNotifier: (() => void) | null = null;

/**
 * 目录变化通知器（index.ts 在 manager 创建后装配：manager.omnicodeOnRemoteWorkspacesChanged）。
 * 单例缺席（官方 flavor）时永不触发——纯惰性绑定，官方行为零影响。
 */
export function setOmnicodeRemoteForwardHostWorkspacesChangedNotifier(notifier: () => void): void {
  workspacesChangedNotifier = notifier;
}
