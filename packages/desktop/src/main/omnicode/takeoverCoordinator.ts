// [OmniCode] D12 请求接管流——管理器侧协调器（spec: docs/omnicode/profile-runtime.md
// §批次3 D12）。职责：接收观察者实例的桥上行 takeoverRequest → 查锁定持有者 →
// 转投持有者实例 → 回执（takeoverReply）转投回观察者（takeoverResult）。
//
// 边界（全部由七态机 transitionOmnicodeTakeover 收口，本模块只做装配与 IO）：
// - 持有者未连桥 / 断连 → holder-offline 立即回观察者；
// - 并发（同持有者在途请求未决）→ busy 回观察者，状态机槽不变（一次处理一个）；
// - 观察者取消（自发关 tab / 观察者断连）→ cancelled 槽，持有者回执到达时静默丢弃；
// - 回执死线 45s（> 持有者 30s 决策 + 优雅关闭/锁释放窗口）→ timeout；
// - 锁已不存在（持有者已释放）→ 直接 accepted（观察者重开即拿锁，等价闭环）。
// 请求方身份绑定认证：requesterProfileId 一律取桥握手已验的连接身份参数，
// 载荷自报值与自报名不参与授权（显示名以 Profile 注册表解析为准）。
// 锁读取经 deps 注入（desktopProfileIpc 装配 @zcode/services/node 的
// readWorkspaceLockOwner）——本模块不直接依赖 services 包，桥命令直发由桥服务导出。
import {
  OMNICODE_TAKEOVER_MANAGER_REPLY_DEADLINE_MS,
  omnicodeTakeoverCancelMessageSchema,
  omnicodeTakeoverReplyMessageSchema,
  omnicodeTakeoverRequestMessageSchema,
  transitionOmnicodeTakeover,
  type OmnicodeTakeoverForwardCommand,
  type OmnicodeTakeoverMachineState,
  type OmnicodeTakeoverOutcome,
  type OmnicodeTakeoverPendingRequest,
  type OmnicodeTakeoverResultCommand,
} from "@zcode/shared";

/** 锁占用方视图（与 services WorkspaceLockOwner 同形子集；经 deps 注入解耦）。 */
export interface OmnicodeTakeoverLockOwnerView {
  profileId: string;
  displayName?: string;
}

export interface OmnicodeTakeoverManagerDeps {
  /** 当前锁占用方查询（workspaceLocks 直读，同步 IO；null = 无主锁）。 */
  readLockOwner: (workspacePath: string) => OmnicodeTakeoverLockOwnerView | undefined;
  /** 桥连接集合（持有者在线判定）。 */
  getConnectedProfileIds: () => string[];
  /** 桥下行（返回 false = 连接已断）。 */
  sendCommand: (
    profileId: string,
    command: OmnicodeTakeoverForwardCommand | OmnicodeTakeoverResultCommand,
  ) => boolean;
  /** 请求方显示名解析（Profile 注册表为准，防伪造；返回 null 回退载荷自报名/profileId）。 */
  resolveProfileDisplayName: (profileId: string) => Promise<string | null>;
  log?: (message: string, error?: unknown) => void;
}

interface CoordinatorInternals {
  deps: OmnicodeTakeoverManagerDeps;
  /** 按持有者逐实例的状态机槽（七态机：一次处理一个）。 */
  machineByHolder: Map<string, OmnicodeTakeoverMachineState>;
  /** 回执死线计时器（按持有者；终态收到回执或死线时清理）。 */
  deadlineByHolder: Map<string, NodeJS.Timeout>;
}

let internals: CoordinatorInternals | null = null;

/** 终态清理（requested/cancelled 之外的槽在回执后即刻释放）。 */
function settleSlot(holderProfileId: string, state: OmnicodeTakeoverMachineState): void {
  if (!internals) return;
  internals.machineByHolder.set(holderProfileId, state);
  if (state.status !== "requested" && state.status !== "cancelled") {
    clearDeadline(holderProfileId);
    internals.machineByHolder.delete(holderProfileId);
  }
}

/** 通知观察者（下行 takeoverResult；观察者断连时 send 失败静默——回执无处可去）。
 * request 由调用方在状态迁移**前**取出传入——终态（accepted/denied/timeout）不再携带
 * request 事实，迁移后再读 state.request 会得到 undefined 而漏发回执。 */
function notifyRequester(
  request: OmnicodeTakeoverPendingRequest,
  outcome: OmnicodeTakeoverOutcome,
  reason: string | undefined,
  log: (message: string, error?: unknown) => void,
): void {
  const coordinator = internals;
  if (!coordinator || outcome === "cancelled") return;
  const sent = coordinator.deps.sendCommand(request.requesterProfileId, {
    type: "takeoverResult",
    requestId: request.requestId,
    workspacePath: request.workspacePath,
    outcome,
    ...(reason ? { reason } : {}),
    // 持有者显示名（denied/timeout/close-failed toast 插值「{holderName} 已拒绝/未响应」；
    // accepted 走观察者自动重开链不插值，busy/holder-offline 无持有者语义）。
    ...(outcome === "denied" || outcome === "timeout" || outcome === "close-failed"
      ? { holderName: request.holderName ?? request.holderProfileId }
      : {}),
  });
  if (!sent) {
    log(`[omnicode] 接管回执投递失败（观察者未连接）：${request.requesterProfileId}`);
  }
}

function clearDeadline(holderProfileId: string): void {
  const timer = internals?.deadlineByHolder.get(holderProfileId);
  if (timer) {
    clearTimeout(timer);
    internals?.deadlineByHolder.delete(holderProfileId);
  }
}

function armDeadline(holderProfileId: string): void {
  clearDeadline(holderProfileId);
  const coordinator = internals;
  if (!coordinator) return;
  const log = coordinator.deps.log ?? (() => {});
  const timer = setTimeout(() => {
    if (!internals || internals !== coordinator) return;
    const state = coordinator.machineByHolder.get(holderProfileId);
    if (!state) return;
    // 迁移前取 request（deadline 只对 requested 态产生回执，request 必在）
    const request = state.request;
    const transition = transitionOmnicodeTakeover(state, { type: "deadline" });
    settleSlot(holderProfileId, transition.state);
    if (transition.replyOutcome && request) {
      notifyRequester(request, transition.replyOutcome, transition.replyReason, log);
    }
  }, OMNICODE_TAKEOVER_MANAGER_REPLY_DEADLINE_MS);
  timer.unref?.();
  coordinator.deadlineByHolder.set(holderProfileId, timer);
}

/**
 * 桥上行 takeoverRequest（观察者 → 管理器）。senderProfileId = 桥握手已验的连接身份
 * （requesterProfileId 绑定真身，防伪造）。异步：显示名解析不阻塞桥消息循环的返回。
 */
export async function handleOmnicodeTakeoverRequestFromInstance(
  senderProfileId: string,
  message: unknown,
): Promise<void> {
  const coordinator = internals;
  if (!coordinator) return;
  const log = coordinator.deps.log ?? (() => {});
  const parsed = omnicodeTakeoverRequestMessageSchema.safeParse(message);
  if (!parsed.success) {
    log("[omnicode] 接管请求载荷非法，已丢弃");
    return;
  }
  const workspacePath = parsed.data.workspacePath;
  const reply = (
    outcome: Exclude<OmnicodeTakeoverOutcome, "cancelled">,
    reason?: string,
  ): void => {
    // cancelled 语义不会出现在立即回执里（观察者自发取消不回执自己），此处全码直发。
    coordinator.deps.sendCommand(senderProfileId, {
      type: "takeoverResult",
      requestId: parsed.data.requestId,
      workspacePath,
      outcome,
      ...(reason ? { reason } : {}),
    });
  };

  // 锁事实：无主锁（持有者已释放）→ 直接 accepted（观察者重开即拿锁，等价闭环）；
  // 请求方自持（同实例）→ 不可能出现在观察者流，防御性丢弃。
  let lockOwner: OmnicodeTakeoverLockOwnerView | undefined;
  try {
    lockOwner = coordinator.deps.readLockOwner(workspacePath);
  } catch (error) {
    log("[omnicode] 接管请求锁读取失败，按离线收口", error);
    reply("holder-offline");
    return;
  }
  if (!lockOwner) {
    reply("accepted");
    return;
  }
  if (lockOwner.profileId === senderProfileId) {
    log(`[omnicode] 接管请求方 ${senderProfileId} 与锁持有者相同，丢弃`);
    return;
  }
  const holderProfileId = lockOwner.profileId;
  const holderName = lockOwner.displayName?.trim() || holderProfileId;

  // 在线判定先于并发判定：离线请求不该占槽。
  if (!coordinator.deps.getConnectedProfileIds().includes(holderProfileId)) {
    reply("holder-offline");
    return;
  }

  // 请求方显示名：注册表为准（防伪造），回退载荷自报名，再回退 profileId。
  let registryName: string | null = null;
  try {
    registryName = await coordinator.deps.resolveProfileDisplayName(senderProfileId);
  } catch (error) {
    log("[omnicode] 接管请求显示名解析失败，回退载荷值", error);
  }
  const requesterName = registryName ?? parsed.data.requesterName?.trim() ?? senderProfileId;

  const current = coordinator.machineByHolder.get(holderProfileId) ?? { status: "idle" };
  const transition = transitionOmnicodeTakeover(current, {
    type: "request",
    request: {
      requestId: parsed.data.requestId,
      workspacePath,
      requesterProfileId: senderProfileId,
      requesterName,
      holderProfileId,
      holderName,
    },
  });
  if (transition.replyOutcome === "busy") {
    // 并发（busy）：同持有者已有在途请求，后来者不占槽。
    reply(transition.replyOutcome);
    if (transition.state.status !== current.status) {
      settleSlot(holderProfileId, transition.state);
    }
    return;
  }
  settleSlot(holderProfileId, transition.state);
  armDeadline(holderProfileId);
  const forwarded = coordinator.deps.sendCommand(holderProfileId, {
    type: "takeoverRequest",
    requestId: parsed.data.requestId,
    workspacePath,
    requesterProfileId: senderProfileId,
    requesterName,
  });
  if (!forwarded) {
    // 转发失败（在线检查与发送之间的断连窗口）：离线收口。
    const offline = transitionOmnicodeTakeover(transition.state, { type: "holder-disconnected" });
    settleSlot(holderProfileId, offline.state);
    if (offline.replyOutcome === "holder-offline") {
      reply(offline.replyOutcome);
    }
    return;
  }
  log(`[omnicode] 接管请求已转投持有者：${workspacePath}（${requesterName} → ${holderName}）`);
}

/** 桥上行 takeoverReply（持有者 → 管理器）。senderProfileId 必须是该槽的持有者。 */
export function handleOmnicodeTakeoverReplyFromInstance(
  senderProfileId: string,
  message: unknown,
): void {
  const coordinator = internals;
  if (!coordinator) return;
  const log = coordinator.deps.log ?? (() => {});
  const parsed = omnicodeTakeoverReplyMessageSchema.safeParse(message);
  if (!parsed.success) return;
  const state = coordinator.machineByHolder.get(senderProfileId);
  if (!state) return;
  // requestId 不匹配（迟到/串扰）直接丢弃。
  if (state.request && state.request.requestId !== parsed.data.requestId) return;
  // 迁移前取 request（终态不携带 request 事实；cancelled 态迟到回执 replyOutcome=null 不进 notify）
  const request = state.request;
  const transition = transitionOmnicodeTakeover(state, {
    type: "holder-reply",
    outcome: parsed.data.outcome,
    ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
  });
  settleSlot(senderProfileId, transition.state);
  if (transition.replyOutcome && request) {
    notifyRequester(
      request,
      transition.replyOutcome,
      transition.replyReason ?? parsed.data.reason,
      log,
    );
  }
}

/** 桥上行 takeoverCancel（观察者 → 管理器）：观察者关掉待接管工作区 tab。 */
export function handleOmnicodeTakeoverCancelFromInstance(
  senderProfileId: string,
  message: unknown,
): void {
  const coordinator = internals;
  if (!coordinator) return;
  const parsed = omnicodeTakeoverCancelMessageSchema.safeParse(message);
  if (!parsed.success) return;
  for (const [holderProfileId, state] of coordinator.machineByHolder) {
    if (
      state.request &&
      state.request.requesterProfileId === senderProfileId &&
      state.request.requestId === parsed.data.requestId
    ) {
      const transition = transitionOmnicodeTakeover(state, { type: "cancel" });
      settleSlot(holderProfileId, transition.state);
      return;
    }
  }
}

/** 实例断连对账：持有者断开 → holder-offline 回观察者；观察者断开 → 标记取消。 */
export function handleOmnicodeTakeoverInstanceDisconnected(profileId: string): void {
  const coordinator = internals;
  if (!coordinator) return;
  const log = coordinator.deps.log ?? (() => {});
  const state = coordinator.machineByHolder.get(profileId);
  if (state) {
    // 迁移前取 request（holder-offline 回执需要 request 事实定位观察者）
    const request = state.request;
    const transition = transitionOmnicodeTakeover(state, { type: "holder-disconnected" });
    settleSlot(profileId, transition.state);
    if (transition.replyOutcome && request) {
      notifyRequester(request, transition.replyOutcome, transition.replyReason, log);
    }
    return;
  }
  // 该实例不是任何在途请求的持有者：可能是请求方断连 → 标记取消（回执丢弃）。
  for (const [holderProfileId, holderState] of coordinator.machineByHolder) {
    if (holderState.request?.requesterProfileId === profileId && holderState.status === "requested") {
      const transition = transitionOmnicodeTakeover(holderState, { type: "cancel" });
      settleSlot(holderProfileId, transition.state);
    }
  }
}

/** 装配（仅管理器进程调用；重复装配替换 deps，状态清零）。 */
export function setupOmnicodeTakeoverCoordinator(deps: OmnicodeTakeoverManagerDeps): void {
  internals = {
    deps,
    machineByHolder: new Map(),
    deadlineByHolder: new Map(),
  };
}

/** 测试/关停用：清空协调器（幂等）。 */
export function resetOmnicodeTakeoverCoordinatorForTest(): void {
  if (!internals) return;
  for (const timer of internals.deadlineByHolder.values()) {
    clearTimeout(timer);
  }
  internals = null;
}
