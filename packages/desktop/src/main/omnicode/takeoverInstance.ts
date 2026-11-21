// [OmniCode] D12 请求接管流——实例侧（spec: docs/omnicode/profile-runtime.md §批次3 D12）。
// 两个角色共用本模块（同一实例进程可能是观察者或持有者，或先后扮演）：
// - 观察者：renderer invoke OmnicodeTakeoverRequest → 桥上行 takeoverRequest；
//   桥下行 takeoverResult → renderer OmnicodeTakeoverEvent（toast / 自动重开）。
// - 持有者：桥下行 takeoverRequest → renderer OmnicodeTakeoverConfirm（应用内确认
//   对话框，30s 超时=默认拒绝）→ renderer OmnicodeTakeoverDecide → 桥上行 takeoverReply。
//   管理器死线 45s 兜底渲染层死亡（超时自报 denied+timeout 与死线结果一致收敛）。
// 红线：本模块不触碰锁原语——"优雅关闭工作区"完全由持有者 renderer 走既有 tab 关闭链
// （tabStore.closeTab → openLocalWorkspaces 写回 → Host 协调器释放锁）。
import { randomUUID } from "node:crypto";
import { ipcMain, BrowserWindow } from "electron";
import {
  OMNICODE_TAKEOVER_HOLDER_DECISION_TIMEOUT_MS,
  omnicodeTakeoverForwardCommandSchema,
  omnicodeTakeoverResultCommandSchema,
  type OmnicodeTakeoverSubmitResult,
} from "@zcode/shared";
import { PlatformChannels } from "@zcode/shared";
import process from "node:process";

/** 桥上行发送函数（由 index.ts 注入实例桥客户端的动态 socket 封装；false=未连接）。 */
export type OmnicodeTakeoverUplinkSend = (message: unknown) => boolean;

/** 持有者在途确认请求（requestId → 决策死线计时器）。 */
const holderPending = new Map<string, NodeJS.Timeout>();

function getInstanceWindowWebContents(): Electron.WebContents | null {
  // 实例是单主窗口应用（primaryWindowCoordinator 单飞）。审计 R1 P2-4：兜底跳过
  // data: 协议的辅助窗（如 About 自绘窗口）——主窗口销毁后它可能短暂存活且无接管
  // 监听，确认事件发给它只会被 45s 兜底死线误收口为 timeout。
  const win = BrowserWindow.getAllWindows().find(
    (candidate) =>
      !candidate.isDestroyed() &&
      !candidate.webContents.isDestroyed() &&
      !candidate.webContents.getURL().startsWith("data:"),
  );
  return win ? win.webContents : null;
}

/**
 * 桥下行 takeoverRequest / takeoverResult（instanceBridgeClient.applyCommand 委托）。
 * 窗口未就绪时持有者确认请求丢弃 → 管理器 45s 死线按 timeout 收口（渲染层未就绪 =
 * 未响应，与 D12"30s 超时默认拒绝"语义一致）。
 */
export function handleOmnicodeTakeoverDownlink(command: unknown, sendUplink: OmnicodeTakeoverUplinkSend): void {
  if (!command || typeof command !== "object") return;
  const forward = omnicodeTakeoverForwardCommandSchema.safeParse(command);
  if (forward.success) {
    const webContents = getInstanceWindowWebContents();
    if (!webContents) return;
    // 重复 requestId（桥重连重放防御）：已有在途确认则忽略新请求。
    if (holderPending.has(forward.data.requestId)) return;
    webContents.send(PlatformChannels.OmnicodeTakeoverConfirm, {
      requestId: forward.data.requestId,
      workspacePath: forward.data.workspacePath,
      requesterProfileId: forward.data.requesterProfileId,
      requesterName: forward.data.requesterName,
    });
    // 渲染层死亡兜底死线：45s（> renderer 30s 决策窗口）内未收到 decide → 默认拒绝。
    const timer = setTimeout(() => {
      holderPending.delete(forward.data.requestId);
      sendUplink({
        type: "takeoverReply",
        requestId: forward.data.requestId,
        outcome: "timeout",
      });
    }, OMNICODE_TAKEOVER_HOLDER_DECISION_TIMEOUT_MS + 15_000);
    timer.unref?.();
    holderPending.set(forward.data.requestId, timer);
    return;
  }
  const result = omnicodeTakeoverResultCommandSchema.safeParse(command);
  if (result.success) {
    const webContents = getInstanceWindowWebContents();
    if (!webContents) return;
    webContents.send(PlatformChannels.OmnicodeTakeoverEvent, {
      requestId: result.data.requestId,
      workspacePath: result.data.workspacePath,
      outcome: result.data.outcome,
      ...(result.data.reason ? { reason: result.data.reason } : {}),
      ...(result.data.holderName ? { holderName: result.data.holderName } : {}),
    });
  }
}

/** 桥断连清簿记（在途确认请求的死线随连接复位；管理器侧死线按 timeout 收口）。 */
export function clearOmnicodeTakeoverInstanceState(): void {
  for (const timer of holderPending.values()) {
    clearTimeout(timer);
  }
  holderPending.clear();
}

/** 上行 reply 归一（renderer decide → 桥 reply outcome 码）。 */
function resolveReplyOutcome(
  decision: "accepted" | "denied",
  reason?: "timeout" | "close-failed" | "user",
): "accepted" | "denied" | "timeout" | "close-failed" {
  if (decision === "accepted") return "accepted";
  if (reason === "timeout") return "timeout";
  if (reason === "close-failed") return "close-failed";
  return "denied";
}

/**
 * 实例侧接管 IPC 注册（仅 omnicode 实例身份进程调用；管理器/官方 flavor 不装配，
 * renderer 侧桥方法缺席即天然禁用——官方零改动铁律）。
 */
export function registerOmnicodeTakeoverInstanceIpcHandlers(sendUplink: OmnicodeTakeoverUplinkSend): void {
  // 观察者发起：生成 requestId（形态受 shared requestIdSchema 白名单约束）→ 桥上行。
  // 立即结果只表达"上行是否发出"（未连接=发送失败）；holder-offline/busy 等最终结果
  // 经管理器 takeoverResult 下行事件回推，不新增轮询。
  ipcMain.handle(PlatformChannels.OmnicodeTakeoverRequest, (_event, input: unknown): OmnicodeTakeoverSubmitResult => {
    const workspacePath =
      input && typeof input === "object" && typeof (input as { workspacePath?: unknown }).workspacePath === "string"
        ? (input as { workspacePath: string }).workspacePath.trim()
        : "";
    if (!workspacePath || workspacePath.length > 1024) {
      return { ok: false };
    }
    const requestId = createOmnicodeTakeoverRequestId();
    const sent = sendUplink({
      type: "takeoverRequest",
      requestId,
      workspacePath,
      // 旧管理器兜底名（正常路径管理器以 Profile 注册表名覆盖，防伪造）。
      ...(process.env.OMNICODE_PROFILE_NAME?.trim()
        ? { requesterName: process.env.OMNICODE_PROFILE_NAME.trim().slice(0, 120) }
        : {}),
    });
    return sent ? { ok: true, requestId } : { ok: false };
  });

  // 观察者取消（fire-and-forget）：观察者关掉待接管工作区 tab 时上报。
  ipcMain.on(PlatformChannels.OmnicodeTakeoverCancel, (_event, input: unknown) => {
    const requestId =
      input && typeof input === "object" && typeof (input as { requestId?: unknown }).requestId === "string"
        ? (input as { requestId: string }).requestId
        : "";
    if (!requestId) return;
    sendUplink({ type: "takeoverCancel", requestId });
  });

  // 持有者决定（fire-and-forget）：renderer 30s 超时自报 timeout；同意后关闭失败自报
  // close-failed；决定到达即清死线计时器（迟到 decide 按 requestId 匹配失败静默丢弃）。
  ipcMain.on(PlatformChannels.OmnicodeTakeoverDecide, (_event, input: unknown) => {
    if (!input || typeof input !== "object") return;
    const raw = input as { requestId?: unknown; decision?: unknown; reason?: unknown };
    if (typeof raw.requestId !== "string" || !raw.requestId) return;
    const timer = holderPending.get(raw.requestId);
    if (!timer) return;
    holderPending.delete(raw.requestId);
    clearTimeout(timer);
    if (raw.decision !== "accepted" && raw.decision !== "denied") return;
    const reason =
      raw.reason === "timeout" || raw.reason === "close-failed" || raw.reason === "user"
        ? raw.reason
        : undefined;
    sendUplink({
      type: "takeoverReply",
      requestId: raw.requestId,
      outcome: resolveReplyOutcome(raw.decision, reason),
      ...(reason === "close-failed" ? { reason: "close-failed" } : {}),
    });
  });
}

/** 生成接管请求 id（形态受 shared requestIdSchema 白名单约束：字母数字._:-，8-64 位）。 */
function createOmnicodeTakeoverRequestId(): string {
  return `tk-${randomUUID()}`;
}
