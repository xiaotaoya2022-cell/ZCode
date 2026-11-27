import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import {
  HostMessageTypes,
  HostResponseTypes,
  broadcastMessageSchema,
  formatZodError,
  hostResponseMessageSchema,
} from "@zcode/shared";
import type { BroadcastMessage } from "@zcode/services";
import { logger } from "./logger.js";

// [OmniCode] 2026-11-27：宿主响应 schema 漂移诊断。旧管理器 × 新宿主运行时混布时
// 必然出现 unknown 类型（真机日志实证：每次启动重复刷屏且不含收到的类型，无法一眼
// 对账）。按「receivedType + 首条 zod 路径」限流——同形态漂移每个进程只告警一次。
const invalidHostResponseWarned = new Set<string>();

/** 宿主响应校验失败的限流告警（BroadcastHub 与 taskRealtimeBus 共用）。 */
export function logInvalidHostResponseOnce(
  message: unknown,
  error: Parameters<typeof formatZodError>[0],
): void {
  const receivedType =
    message !== null && typeof message === "object" && typeof (message as { type?: unknown }).type === "string"
      ? (message as { type: string }).type
      : "<non-object>";
  const firstIssue = error.issues[0];
  const key = `${receivedType}|${firstIssue ? String(firstIssue.path.join(".")) : "?"}`;
  if (invalidHostResponseWarned.has(key)) return;
  invalidHostResponseWarned.add(key);
  logger.warn(
    "[BroadcastHub] invalid host response message receivedType=",
    receivedType,
    formatZodError(error),
  );
}

/**
 * BroadcastHub —— main 进程中的广播中转站
 *
 * 管理所有活跃的 host process，当某个 host 发来广播消息时，
 * 转发给所有其他 host process。
 *
 * 广播路径：
 *   Renderer A → (RPC) → Host A → (parentPort) → Main(BroadcastHub)
 *     → (postMessage) → Host B → (RPC event) → Renderer B
 *     → (postMessage) → Host C → (RPC event) → Renderer C
 */
const MAX_BROADCAST_CLAIMS = 1_024;
const BROADCAST_CLAIM_RESERVATION_TTL_MS = 5_000;
const BROADCAST_CLAIM_RETRY_MS = 250;
let claimTokenSequence = 0;

/**
 * [OmniCode] 批次4 全局偏好层：main 侧注入广播时的来源窗口哨兵 id（不存在 -1 号窗口，
 * 接收端不会把它当本地回声忽略，也不会与真实 windowId 撞号）。
 */
export const OMNICODE_MAIN_SOURCE_WINDOW_ID = -1;

type BroadcastClaimRecord = {
  token: string;
  ownerWindowId: number;
  status: "reserved" | "committed";
  expiresAt: number | null;
};

function createClaimToken(windowId: number, requestId: string): string {
  claimTokenSequence += 1;
  return `${windowId}:${requestId}:${claimTokenSequence}`;
}

export class BroadcastHub {
  onMobilePushRun: ((payload: unknown) => void) | undefined;
  onMobilePushEvent: ((payload: unknown) => void) | undefined;
  /**
   * [OmniCode] 批次4 全局偏好层：renderer 发起的 state:* 广播观察回调（relay 内登记）。
   * main 侧 omnicode 协调器据此观察管理器/实例窗口的语言/主题/快捷键变更并做跨实例
   * 同步。未注册（官方 flavor 与未装配进程）时 relay 行为逐字节不变；注入路径
   * （relayFromOmnicodeMain）不经过 relay，观察点看不到自己的注入，无回环。
   */
  onOmnicodeRendererStateBroadcast: ((channel: string, payload: unknown) => void) | undefined;
  private processes = new Map<number, ElectronUtilityProcess>();
  /** 通用 opaque reservation/claim；不保存 Coding Plan 等业务状态。 */
  private readonly claims = new Map<string, BroadcastClaimRecord>();

  /** 内存诊断计数器；只读 size。 */
  collectMemoryDiagnostics(): Record<string, number> {
    return { claims: this.claims.size, processes: this.processes.size };
  }

  /** 注册 host process 并监听其广播消息 */
  register(windowId: number, child: ElectronUtilityProcess): void {
    this.processes.set(windowId, child);

    child.on("message", (msg: unknown) => {
      const result = hostResponseMessageSchema.safeParse(msg);
      if (!result.success) {
        logInvalidHostResponseOnce(msg, result.error);
        return;
      }
      if (result.data.type === HostResponseTypes.Broadcast) {
        this.relay(windowId, result.data.message);
        return;
      }
      if (result.data.type === HostResponseTypes.BroadcastClaimRequest) {
        this.handleClaim(windowId, child, result.data.requestId, result.data.key);
        return;
      }
      if (result.data.type === HostResponseTypes.BroadcastClaimCommit) {
        this.handleClaimCommit(windowId, result.data.key, result.data.claimToken);
        return;
      }
      if (result.data.type === HostResponseTypes.BroadcastClaimRelease) {
        this.handleClaimRelease(windowId, result.data.key, result.data.claimToken);
      }
    });
  }

  /** 注销 host process（窗口关闭时调用） */
  unregister(windowId: number): void {
    this.processes.delete(windowId);
    // 窗口在 reservation 返回前关闭时无法主动 release；只回收该窗口未 commit
    // 的占用，已 commit claim 继续保留，避免后来打开的窗口重播同一次完成提示。
    for (const [key, claim] of this.claims) {
      if (claim.ownerWindowId === windowId && claim.status === "reserved") {
        this.claims.delete(key);
      }
    }
  }

  private pruneExpiredReservations(now = Date.now()): void {
    for (const [key, claim] of this.claims) {
      if (claim.status === "reserved" && claim.expiresAt !== null && claim.expiresAt <= now) {
        this.claims.delete(key);
      }
    }
    while (this.claims.size > MAX_BROADCAST_CLAIMS) {
      const oldest = this.claims.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      this.claims.delete(oldest);
    }
  }

  /**
   * 原子申请 opaque key 的临时 reservation。Main 单线程保证 first-wins；reservation
   * 必须由 winner 在展示边界 commit，否则可按 token release，并受 TTL/host 注销兜底回收。
   */
  private handleClaim(
    windowId: number,
    source: ElectronUtilityProcess,
    requestId: string,
    key: string,
  ): void {
    const now = Date.now();
    this.pruneExpiredReservations(now);
    const existing = this.claims.get(key);
    if (existing?.status === "committed") {
      source.postMessage({
        type: HostMessageTypes.BroadcastClaimResult,
        requestId,
        status: "committed",
      });
      return;
    }
    if (existing) {
      source.postMessage({
        type: HostMessageTypes.BroadcastClaimResult,
        requestId,
        status: "busy",
        retryAfterMs: Math.max(
          0,
          Math.min(BROADCAST_CLAIM_RETRY_MS, (existing.expiresAt ?? now) - now),
        ),
      });
      return;
    }

    const claimToken = createClaimToken(windowId, requestId);
    this.claims.set(key, {
      token: claimToken,
      ownerWindowId: windowId,
      status: "reserved",
      expiresAt: now + BROADCAST_CLAIM_RESERVATION_TTL_MS,
    });
    this.pruneExpiredReservations(now);
    source.postMessage({
      type: HostMessageTypes.BroadcastClaimResult,
      requestId,
      status: "acquired",
      claimToken,
    });
  }

  private handleClaimCommit(windowId: number, key: string, claimToken: string): void {
    this.pruneExpiredReservations();
    const current = this.claims.get(key);
    if (
      current?.status === "reserved" &&
      current.ownerWindowId === windowId &&
      current.token === claimToken
    ) {
      this.claims.set(key, { ...current, status: "committed", expiresAt: null });
    }
  }

  private handleClaimRelease(windowId: number, key: string, claimToken: string): void {
    this.pruneExpiredReservations();
    const current = this.claims.get(key);
    if (
      current?.status === "reserved" &&
      current.ownerWindowId === windowId &&
      current.token === claimToken
    ) {
      this.claims.delete(key);
    }
  }

  /** 将广播消息转发给除发送源以外的所有 host process */
  private relay(sourceWindowId: number, message: BroadcastMessage): void {
    const result = broadcastMessageSchema.safeParse(message);
    if (!result.success) {
      logger.warn("[BroadcastHub] invalid broadcast message:", formatZodError(result.error));
      return;
    }

    // 通知事实只交给 Main 网络适配器，不向其他 Host 回播形成第二次事件。
    if (result.data.channel === "mobile-push:run") {
      this.onMobilePushRun?.(result.data.payload);
      return;
    }
    if (result.data.channel === "mobile-push:event") {
      this.onMobilePushEvent?.(result.data.payload);
      return;
    }
    // [OmniCode] 批次4：renderer 发起的 state:* 广播观察（全局偏好层观察点）。回调缺失
    // 时零行为变化；观察失败不得影响既有转发，故 try 包裹。
    try {
      this.onOmnicodeRendererStateBroadcast?.(result.data.channel, result.data.payload);
    } catch (error) {
      logger.warn("[BroadcastHub] omnicode state broadcast observer failed:", error);
    }
    // 填充来源信息，接收端可用于去重
    const enriched: BroadcastMessage = { ...result.data, sourceWindowId };

    for (const [id, proc] of this.processes) {
      if (id !== sourceWindowId) {
        proc.postMessage({ type: HostMessageTypes.Broadcast, message: enriched });
      }
    }
  }

  /**
   * [OmniCode] 批次4 全局偏好层：main 侧向本进程全部 host 注入一条广播（等价于
   * "某个窗口发起了该广播"，用于全局偏好热应用——实例收到 applyGlobalPrefs 后把
   * state:locale / state:theme 注入自身 hub，renderer 经既有广播机制切换）。
   * 校验失败/无 host 返回 false；不触发观察点（避免注入→观察→上报回环）。
   */
  relayFromOmnicodeMain(channel: string, payload: unknown): boolean {
    const candidate: BroadcastMessage = { channel, payload };
    const result = broadcastMessageSchema.safeParse(candidate);
    if (!result.success) {
      logger.warn("[BroadcastHub] invalid omnicode main broadcast:", formatZodError(result.error));
      return false;
    }
    const enriched: BroadcastMessage = {
      ...result.data,
      sourceWindowId: OMNICODE_MAIN_SOURCE_WINDOW_ID,
    };
    let delivered = false;
    for (const proc of this.processes.values()) {
      proc.postMessage({ type: HostMessageTypes.Broadcast, message: enriched });
      delivered = true;
    }
    return delivered;
  }
}
