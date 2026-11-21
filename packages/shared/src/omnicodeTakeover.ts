// [OmniCode] D12 请求接管流（锁体系闭环，2026-11-21 用户批准；spec:
// docs/omnicode/profile-runtime.md §批次3 D12）：
// 观察者实例（只读打开被占用工作区，D11 自动观察者态）→ 琥珀横幅「请求接管」→
// 桥上行 takeoverRequest → 管理器转投持有者实例 → 持有者 30s 语义确认（超时=默认
// 拒绝）→ 同意则走既有 tab 关闭链优雅释放工作区锁 → 回执 ack → 管理器通知观察者 →
// 观察者复用 B2-2 P1-1 链路（锁释放后 Normal 打开）以可写身份自动重开。
//
// 红线（实现即约束）：
// - 锁核心语义零改动：本模块只是新增协商层，不触碰 workspaceLocks 的获取/心跳/释放
//   原语；持有者"释放锁"的唯一途径仍是既有 tab 关闭链（openLocalWorkspaces 集合
//   写回 → 协调器对账释放），无强制解锁路径。
// - 官方 flavor 零改动：全部消息只在 omnicode 实例桥链上流转；官方进程既无桥也无
//   观察者态，消费方缺席即天然禁用。
// - 不新增常驻轮询：回执走既有桥事件推送；唯一等待是持有者关闭 tab 后对锁释放的
//   有界一次性确认（LOCK_RELEASE_WAIT 上限），非常驻。
// - 请求方身份绑定认证：requesterProfileId 一律取桥握手已验的连接身份
//   （connectionsByProfileId），载荷自报值不参与授权判定（防伪造）。
import { z } from "zod";

/**
 * 接管回执结果码（观察者侧 toast / 自动重开决策的唯一事实源）。
 * - accepted：持有者同意且已优雅关闭工作区（锁已释放），观察者自动重开；
 * - denied：持有者拒绝；
 * - timeout：持有者 30s 未响应（默认拒绝）；
 * - busy：持有者正在处理其他接管请求（并发后来者）；
 * - holder-offline：持有者未连桥/已断开；
 * - close-failed：持有者同意但关闭失败（保存冲突等），等同拒绝并携带原因；
 * - cancelled：观察者自发取消（仅状态机内部态，不下发——请求方自己发起的取消无需回执）。
 */
export const OMNICODE_TAKEOVER_OUTCOMES = [
  "accepted",
  "denied",
  "timeout",
  "busy",
  "holder-offline",
  "close-failed",
  "cancelled",
] as const;
export type OmnicodeTakeoverOutcome = (typeof OMNICODE_TAKEOVER_OUTCOMES)[number];

export const omnicodeTakeoverOutcomeSchema = z.enum(OMNICODE_TAKEOVER_OUTCOMES);

/** 持有者确认超时：30s 无决定 = 默认拒绝（D12 语义）。 */
export const OMNICODE_TAKEOVER_HOLDER_DECISION_TIMEOUT_MS = 30_000;
/**
 * 管理器回执死线：覆盖 持有者 30s 决策窗口 + 优雅关闭/锁释放（≤3s）+ 回环两跳开销，
 * 余量兜底"持有者渲染层死亡/桥静默断开未触发 disconnected"的极端态。
 */
export const OMNICODE_TAKEOVER_MANAGER_REPLY_DEADLINE_MS = 45_000;
/** 持有者关闭 tab 后等待锁实际释放的窗口（集合写回 300ms debounce + 协调器对账 + 余量）。 */
export const OMNICODE_TAKEOVER_LOCK_RELEASE_WAIT_MS = 3_000;
/** 锁释放确认轮询步长（有界一次性等待内部步进，非常驻）。 */
export const OMNICODE_TAKEOVER_LOCK_RELEASE_POLL_MS = 250;

const requestIdSchema = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9._:-]+$/u, "requestId 形态非法");
const workspacePathSchema = z.string().min(1).max(1024);
const profileIdSchema = z.string().regex(/^p[0-9a-z]{8,20}$/u);
const displayNameSchema = z.string().min(1).max(120);

// ─── 桥上行（实例 → 管理器）───

/**
 * 观察者发起接管。requesterProfileId 由管理器按桥连接身份绑定注入（载荷自报值忽略）；
 * requesterName 仅作旧管理器兜底，正常路径由管理器从 Profile 注册表解析（防伪造名）。
 */
export const omnicodeTakeoverRequestMessageSchema = z
  .object({
    type: z.literal("takeoverRequest"),
    requestId: requestIdSchema,
    workspacePath: workspacePathSchema,
    requesterName: displayNameSchema.optional(),
  })
  .strict();

/** 持有者回执。accepted = 已优雅关闭工作区并释放锁；denied 可带原因（close-failed 等）。 */
export const omnicodeTakeoverReplyMessageSchema = z
  .object({
    type: z.literal("takeoverReply"),
    requestId: requestIdSchema,
    outcome: z.enum(["accepted", "denied", "timeout", "close-failed"]),
    reason: z.string().max(120).optional(),
  })
  .strict();

/** 观察者取消（观察者 tab 已关/实例断连）：管理器标记 cancelled，持有者回执到达时静默丢弃。 */
export const omnicodeTakeoverCancelMessageSchema = z
  .object({
    type: z.literal("takeoverCancel"),
    requestId: requestIdSchema,
  })
  .strict();

export type OmnicodeTakeoverRequestMessage = z.infer<typeof omnicodeTakeoverRequestMessageSchema>;
export type OmnicodeTakeoverReplyMessage = z.infer<typeof omnicodeTakeoverReplyMessageSchema>;
export type OmnicodeTakeoverCancelMessage = z.infer<typeof omnicodeTakeoverCancelMessageSchema>;

// ─── 桥下行（管理器 → 实例）───

/** 转投持有者：载荷已经管理器归一（requesterProfileId=桥连接真身，name=注册表名）。 */
export const omnicodeTakeoverForwardCommandSchema = z
  .object({
    type: z.literal("takeoverRequest"),
    requestId: requestIdSchema,
    workspacePath: workspacePathSchema,
    requesterProfileId: profileIdSchema,
    requesterName: displayNameSchema,
  })
  .strict();

/** 通知观察者（cancelled 不下发——取消是请求方自发行为）。 */
export const omnicodeTakeoverResultCommandSchema = z
  .object({
    type: z.literal("takeoverResult"),
    requestId: requestIdSchema,
    /** 工作区路径（观察者按路径结算 pending 槽与自动重开）。 */
    workspacePath: workspacePathSchema,
    outcome: z.enum(["accepted", "denied", "timeout", "busy", "holder-offline", "close-failed"]),
    reason: z.string().max(120).optional(),
    /** 持有者显示名（转发时锁占用方快照；观察者 toast 插值用）。 */
    holderName: displayNameSchema.optional(),
  })
  .strict();

export type OmnicodeTakeoverForwardCommand = z.infer<typeof omnicodeTakeoverForwardCommandSchema>;
export type OmnicodeTakeoverResultCommand = z.infer<typeof omnicodeTakeoverResultCommandSchema>;

// ─── 接管状态机（纯函数，七态：idle/requested/accepted/denied/timeout/holder-offline/
//     cancelled；"并发 busy"是 requested 态上的重复请求事件，产生 busy 回执但不变更
//     状态——后来者不占槽，持有者一次只处理一个）───

/** 一次接管请求的挂起事实（requested/cancelled 态携带）。 */
export interface OmnicodeTakeoverPendingRequest {
  requestId: string;
  workspacePath: string;
  requesterProfileId: string;
  requesterName: string;
  holderProfileId: string;
  /** 持有者显示名（管理器转发时锁占用方快照；denied/timeout toast 插值用）。 */
  holderName?: string;
}

/** 七态机状态（管理器侧按持有者逐实例维护；cancelled 槽保留至持有者回执或死线）。 */
export type OmnicodeTakeoverMachineStatus =
  | "idle"
  | "requested"
  | "accepted"
  | "denied"
  | "timeout"
  | "holder-offline"
  | "cancelled";

export interface OmnicodeTakeoverMachineState {
  status: OmnicodeTakeoverMachineStatus;
  /** requested/cancelled 态携带的挂起请求事实。 */
  request?: OmnicodeTakeoverPendingRequest;
  /** 终态附加原因（denied 态的 close-failed 等，原样透传观察者）。 */
  reason?: string;
}

export type OmnicodeTakeoverMachineEvent =
  | { type: "request"; request: OmnicodeTakeoverPendingRequest }
  /** 并发：requested 态收到第二请求 → 回 busy，状态不变（后来者不占槽）。 */
  | { type: "duplicate-request" }
  /** 持有者回执（close-failed 归入 denied 终态、原因保留）。 */
  | { type: "holder-reply"; outcome: "accepted" | "denied" | "timeout" | "close-failed"; reason?: string }
  /** 持有者桥断开（离线）。 */
  | { type: "holder-disconnected" }
  /** 管理器回执死线到点。 */
  | { type: "deadline" }
  /** 观察者取消（自发关 tab / 观察者实例断连）。 */
  | { type: "cancel" }
  /** 终态/取消态清理回 idle（释放槽位）。 */
  | { type: "reset" };

export interface OmnicodeTakeoverMachineTransition {
  state: OmnicodeTakeoverMachineState;
  /**
   * 应回给请求方的结果码；null = 无需回执（reset / 自发取消 / cancelled 态收到的
   * 迟到回执——回执丢弃语义在这里收口）。
   */
  replyOutcome: OmnicodeTakeoverOutcome | null;
  replyReason?: string;
}

const IDLE_STATE: OmnicodeTakeoverMachineState = { status: "idle" };

/** 七态机唯一迁移函数（纯，无副作用；管理器协调器据此驱动回执与槽位清理）。 */
export function transitionOmnicodeTakeover(
  state: OmnicodeTakeoverMachineState,
  event: OmnicodeTakeoverMachineEvent,
): OmnicodeTakeoverMachineTransition {
  switch (event.type) {
    case "request": {
      if (state.status === "idle") {
        // 受理：无立即回执（最终结果经 takeoverResult 下行事件回推，不新增轮询）。
        return { state: { status: "requested", request: event.request }, replyOutcome: null };
      }
      // 非空闲态收到新请求：requested/cancelled → busy（并发后来者），终态槽在 reset
      // 前的瞬时请求同样 busy（协调器 reset 前不会受理新请求，此为防御分支）。
      return { state, replyOutcome: "busy" };
    }
    case "duplicate-request": {
      if (state.status !== "requested") return { state, replyOutcome: null };
      return { state, replyOutcome: "busy" };
    }
    case "holder-reply": {
      if (state.status !== "requested") {
        // cancelled：持有者回执到达但请求方已不等待 → 静默取消（回执丢弃）；
        // 其余终态收到迟到回执同样丢弃。
        return { state, replyOutcome: null };
      }
      if (event.outcome === "accepted") {
        return { state: { status: "accepted" }, replyOutcome: "accepted" };
      }
      if (event.outcome === "timeout") {
        return { state: { status: "timeout" }, replyOutcome: "timeout" };
      }
      // denied / close-failed：归入 denied 终态，close-failed 原因透传观察者。
      return {
        state: {
          status: "denied",
          ...(event.reason ? { reason: event.reason } : {}),
        },
        replyOutcome: event.outcome === "close-failed" ? "close-failed" : "denied",
        ...(event.reason ? { replyReason: event.reason } : {}),
      };
    }
    case "holder-disconnected": {
      if (state.status !== "requested") {
        return { state: state.status === "cancelled" ? IDLE_STATE : state, replyOutcome: null };
      }
      return { state: { status: "holder-offline" }, replyOutcome: "holder-offline" };
    }
    case "deadline": {
      if (state.status !== "requested") {
        return { state: state.status === "cancelled" ? IDLE_STATE : state, replyOutcome: null };
      }
      return { state: { status: "timeout" }, replyOutcome: "timeout" };
    }
    case "cancel": {
      if (state.status !== "requested") return { state, replyOutcome: null };
      // 自发取消：无回执；槽保留（持有者可能已在确认流程中），回执到达时静默丢弃。
      return { state: { status: "cancelled", request: state.request }, replyOutcome: null };
    }
    case "reset": {
      return { state: IDLE_STATE, replyOutcome: null };
    }
    default:
      return { state, replyOutcome: null };
  }
}
