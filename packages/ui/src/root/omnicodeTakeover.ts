/**
 * [OmniCode] D12 请求接管流——renderer 侧纯判定（spec:
 * docs/omnicode/profile-runtime.md §批次3 D12）。
 * 本模块只放纯函数，不触 React/服务：观察者编排（toast/重开/取消）与持有者编排
 * （确认对话框/优雅关闭/锁释放等待）由 useOmnicodeWorkspaceTakeover 装配，
 * 桌面单测直接覆盖本模块。
 */
import type { OmnicodeTakeoverOutcome } from "@zcode/shared";
import { isWorkspaceTab, type TabStoreState, type WindowTabState } from "@/store/tabStore.js";

/** 观察者侧接管结果呈现决策（纯函数）。 */
export type OmnicodeTakeoverObserverAction =
  /** accepted：toast 提示后复用 P1-1 链路以可写身份自动重开（handleSelectProject）。 */
  | { kind: "reopen" }
  | { kind: "toast"; messageId: string; values?: Record<string, string>; variant: "info" | "warning" }
  /** cancelled：请求方自发取消，无呈现。 */
  | { kind: "none" };

/**
 * 观察者侧回执呈现（纯函数）：
 * - accepted → reopen（锁已由持有者优雅释放，重开即拿锁转可写）；
 * - denied/timeout → 「{name} 已拒绝/未响应」（name=持有者显示名，缺省回退 profileId 由
 *   事件载荷兜底——管理器下行 takeoverResult 携带 holderName）；
 * - busy → 「持有者正被其他请求占用」（并发后来者）；
 * - holder-offline → 「持有者不在线」（离线/断连）；
 * - close-failed → 持有者同意但关闭失败（保存冲突），等同拒绝；
 * - cancelled → 无呈现（请求方自发取消）。
 */
export function resolveOmnicodeTakeoverObserverAction(input: {
  outcome: OmnicodeTakeoverOutcome;
  /** 持有者显示名（事件载荷 holderName；缺省由调用方回退 profileId）。 */
  holderName?: string;
}): OmnicodeTakeoverObserverAction {
  switch (input.outcome) {
    case "accepted":
      return { kind: "reopen" };
    case "denied":
      return {
        kind: "toast",
        messageId: "omnicode.takeover.deniedToast",
        ...(input.holderName ? { values: { name: input.holderName } } : {}),
        variant: "warning",
      };
    case "timeout":
      return {
        kind: "toast",
        messageId: "omnicode.takeover.timeoutToast",
        ...(input.holderName ? { values: { name: input.holderName } } : {}),
        variant: "warning",
      };
    case "busy":
      return { kind: "toast", messageId: "omnicode.takeover.busyToast", variant: "info" };
    case "holder-offline":
      return { kind: "toast", messageId: "omnicode.takeover.holderOfflineToast", variant: "warning" };
    case "close-failed":
      return { kind: "toast", messageId: "omnicode.takeover.closeFailedToast", variant: "warning" };
    case "cancelled":
      return { kind: "none" };
    default:
      return { kind: "none" };
  }
}

/** 路径归一口径（与 observerToastDedupeKey/锁 hash 同语义：去尾分隔符 + 小写）。 */
function normalizeTakeoverWorkspacePath(workspacePath: string): string {
  return workspacePath.replace(/[\\/]+$/, "").toLowerCase();
}

/**
 * 观察者取消判定（纯函数）：在途接管请求的工作区 tab 已不存在（观察者关掉了它）→
 * 取消。远程 tab（workspaceIdentity/remoteSessionId）不属于本地锁域，不参与匹配。
 */
export function shouldCancelTakeoverForClosedTab(input: {
  pendingWorkspacePath: string;
  tabs: readonly WindowTabState[];
}): boolean {
  const normalized = normalizeTakeoverWorkspacePath(input.pendingWorkspacePath);
  return !input.tabs.some(
    (tab) =>
      isWorkspaceTab(tab) &&
      !tab.workspaceIdentity &&
      !tab.remoteSessionId &&
      !tab.remoteTarget &&
      normalizeTakeoverWorkspacePath(tab.workspacePath) === normalized,
  );
}

/**
 * 持有者优雅关闭编排决策（纯函数）：确认同意后找到该工作区的本地 tab，走既有
 * tabStore.closeTab（user-close 原点 = 与用户手点关闭完全同链：草稿/会话自动持久化、
 * openLocalWorkspaces 集合写回 → Host 协调器释放锁）。找不到 tab = 无需关闭（锁可能
 * 已被同实例其他窗口语义覆盖），仍进入锁释放等待。
 */
export function resolveTakeoverWorkspaceTabToClose(
  state: Pick<TabStoreState, "tabs">,
  workspacePath: string,
): { tabId: string } | null {
  const normalized = normalizeTakeoverWorkspacePath(workspacePath);
  const tab = state.tabs.find(
    (candidate) =>
      isWorkspaceTab(candidate) &&
      !candidate.workspaceIdentity &&
      !candidate.remoteSessionId &&
      !candidate.remoteTarget &&
      normalizeTakeoverWorkspacePath(candidate.workspacePath) === normalized,
  );
  return tab ? { tabId: tab.id } : null;
}

/** 锁装饰条目最小视图（与 readTree omnicodeWorkspaceLocks 同形子集）。 */
export interface TakeoverLockDecorationView {
  workspacePath: string;
  profileId: string;
  ownedBySelf: boolean;
  displayName?: string;
}

/**
 * 锁释放判定（纯函数）：锁装饰中已无该工作区条目 = 释放完成（持有者关 tab 后
 * openLocalWorkspaces 写回 → 协调器删除锁文件）。第三方在窗口期抢锁的场景不在此判定
 * ——重开链的 saveProject 守卫会按锁事实重新裁决（回到观察者），与手动重开同语义。
 */
export function isWorkspaceLockReleased(
  locks: readonly TakeoverLockDecorationView[] | undefined,
  workspacePath: string,
): boolean {
  if (!locks) return true;
  const normalized = normalizeTakeoverWorkspacePath(workspacePath);
  return !locks.some(
    (lock) => normalizeTakeoverWorkspacePath(lock.workspacePath) === normalized,
  );
}
