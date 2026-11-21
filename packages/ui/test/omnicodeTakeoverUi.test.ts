// [OmniCode] D12 请求接管流 renderer 侧单测（spec: docs/omnicode/profile-runtime.md §批次3 D12）：
// - 纯判定（ui/root/omnicodeTakeover.ts）：观察者回执呈现七码、关 tab 取消判定（远程
//   tab 不参与匹配/路径归一）、持有者优雅关闭目标 tab 判定、锁释放判定；
// - 观察者在途登记表（omnicodeTakeoverRegistry.ts）：pending 生命周期、requestId 回填、
//   重复发起拦截、处理器缺席 no-op、hasOmnicodeTakeoverRequestHandler 门控。
import { describe, expect, it, vi } from "vitest";
import {
  isWorkspaceLockReleased,
  resolveOmnicodeTakeoverObserverAction,
  resolveTakeoverWorkspaceTabToClose,
  shouldCancelTakeoverForClosedTab,
  type TakeoverLockDecorationView,
} from "@/root/omnicodeTakeover.js";
import {
  getOmnicodeTakeoverPendingRequestId,
  hasOmnicodeTakeoverRequestHandler,
  isOmnicodeTakeoverPending,
  markOmnicodeTakeoverPending,
  requestOmnicodeWorkspaceTakeover,
  settleOmnicodeTakeoverPending,
  setOmnicodeTakeoverRequestHandler,
} from "@/root/omnicodeTakeoverRegistry.js";
import type { WindowTabState } from "@/store/tabStore.js";

function workspaceTab(overrides: Partial<WindowTabState> = {}): WindowTabState {
  return {
    id: "tab-1",
    kind: "workspace",
    workspacePath: "F:\\work\\demo",
    ...overrides,
  } as WindowTabState;
}

describe("D12 观察者回执呈现 resolveOmnicodeTakeoverObserverAction", () => {
  it("accepted → reopen；cancelled → none", () => {
    expect(resolveOmnicodeTakeoverObserverAction({ outcome: "accepted" })).toEqual({ kind: "reopen" });
    expect(resolveOmnicodeTakeoverObserverAction({ outcome: "cancelled" })).toEqual({ kind: "none" });
  });

  it("denied/timeout 带 holderName 插值；busy/holder-offline/close-failed 文案键与变体", () => {
    expect(resolveOmnicodeTakeoverObserverAction({ outcome: "denied", holderName: "持有者" })).toEqual({
      kind: "toast",
      messageId: "omnicode.takeover.deniedToast",
      values: { name: "持有者" },
      variant: "warning",
    });
    expect(resolveOmnicodeTakeoverObserverAction({ outcome: "timeout", holderName: "持有者" })).toMatchObject({
      messageId: "omnicode.takeover.timeoutToast",
      variant: "warning",
    });
    expect(resolveOmnicodeTakeoverObserverAction({ outcome: "busy" })).toMatchObject({
      messageId: "omnicode.takeover.busyToast",
      variant: "info",
    });
    expect(resolveOmnicodeTakeoverObserverAction({ outcome: "holder-offline" })).toMatchObject({
      messageId: "omnicode.takeover.holderOfflineToast",
      variant: "warning",
    });
    expect(resolveOmnicodeTakeoverObserverAction({ outcome: "close-failed" })).toMatchObject({
      messageId: "omnicode.takeover.closeFailedToast",
      variant: "warning",
    });
    // 无 holderName 时不带插值（回退由事件载荷/调用方兜底）
    expect(resolveOmnicodeTakeoverObserverAction({ outcome: "denied" }).values).toBeUndefined();
  });
});

describe("D12 关 tab 取消判定 shouldCancelTakeoverForClosedTab", () => {
  const path = "F:\\work\\demo";

  it("本地工作区 tab 存在 → 不取消；已关 → 取消", () => {
    expect(
      shouldCancelTakeoverForClosedTab({ pendingWorkspacePath: path, tabs: [workspaceTab()] }),
    ).toBe(false);
    expect(shouldCancelTakeoverForClosedTab({ pendingWorkspacePath: path, tabs: [] })).toBe(true);
  });

  it("远程 tab（workspaceIdentity/remoteSessionId）不属于本地锁域：不匹配不阻止取消", () => {
    expect(
      shouldCancelTakeoverForClosedTab({
        pendingWorkspacePath: path,
        tabs: [workspaceTab({ workspaceIdentity: "remote-1" } as Partial<WindowTabState>)],
      }),
    ).toBe(true);
    expect(
      shouldCancelTakeoverForClosedTab({
        pendingWorkspacePath: path,
        tabs: [workspaceTab({ remoteSessionId: "rs-1" } as Partial<WindowTabState>)],
      }),
    ).toBe(true);
  });

  it("路径归一：尾分隔符与大小写不阻止匹配（与锁 hash 同口径）", () => {
    expect(
      shouldCancelTakeoverForClosedTab({
        pendingWorkspacePath: "f:\\work\\demo\\",
        tabs: [workspaceTab({ workspacePath: "F:\\WORK\\Demo" })],
      }),
    ).toBe(false);
  });
});

describe("D12 持有者优雅关闭目标 resolveTakeoverWorkspaceTabToClose", () => {
  it("命中本地 tab → tabId；远程 tab 不匹配；无匹配 → null", () => {
    const state = {
      tabs: [
        workspaceTab({ id: "tab-a", workspacePath: "F:\\work\\demo" }),
        workspaceTab({ id: "tab-b", workspacePath: "F:\\other", workspaceIdentity: "r" } as Partial<WindowTabState>),
      ],
    } as { tabs: WindowTabState[] };
    expect(resolveTakeoverWorkspaceTabToClose(state, "F:\\work\\demo")).toEqual({ tabId: "tab-a" });
    expect(resolveTakeoverWorkspaceTabToClose(state, "F:\\none")).toBeNull();
    expect(resolveTakeoverWorkspaceTabToClose({ tabs: [] }, "F:\\work\\demo")).toBeNull();
  });
});

describe("D12 锁释放判定 isWorkspaceLockReleased", () => {
  const locks: TakeoverLockDecorationView[] = [
    { workspacePath: "F:\\work\\demo", profileId: "pbbbbbbbb", ownedBySelf: false },
    { workspacePath: "F:\\other", profileId: "pcccccccc", ownedBySelf: false },
  ];

  it("条目消失 = 释放；仍在 = 未释放；undefined 视为已释放（树缺装饰不阻塞回执）", () => {
    expect(isWorkspaceLockReleased(locks, "F:\\work\\demo")).toBe(false);
    expect(isWorkspaceLockReleased(locks, "F:\\gone")).toBe(true);
    expect(isWorkspaceLockReleased(undefined, "F:\\work\\demo")).toBe(true);
  });

  it("路径归一同口径（尾分隔符/大小写）", () => {
    expect(isWorkspaceLockReleased(locks, "f:\\work\\demo\\")).toBe(false);
  });
});

describe("D12 观察者在途登记表 omnicodeTakeoverRegistry", () => {
  const pathA = "F:\\takeover\\registry-a";
  const pathB = "F:\\takeover\\registry-b";

  it("pending 生命周期：mark → isPending/requestId；settle 后清空", () => {
    expect(isOmnicodeTakeoverPending(pathA)).toBe(false);
    markOmnicodeTakeoverPending(pathA, "tk-registry-001");
    expect(isOmnicodeTakeoverPending(pathA)).toBe(true);
    expect(getOmnicodeTakeoverPendingRequestId(pathA)).toBe("tk-registry-001");
    settleOmnicodeTakeoverPending(pathA);
    expect(isOmnicodeTakeoverPending(pathA)).toBe(false);
    expect(getOmnicodeTakeoverPendingRequestId(pathA)).toBeNull();
    // 幂等 settle 无副作用
    settleOmnicodeTakeoverPending(pathA);
    expect(isOmnicodeTakeoverPending(pathA)).toBe(false);
  });

  it("路径归一：mark 与查询的尾分隔符/大小写差异不产生第二个槽", () => {
    markOmnicodeTakeoverPending("F:\\TAKEOVER\\registry-b\\", "tk-registry-002");
    expect(isOmnicodeTakeoverPending(pathB)).toBe(true);
    settleOmnicodeTakeoverPending(pathB);
    expect(isOmnicodeTakeoverPending("f:\\takeover\\registry-b")).toBe(false);
  });

  it("重复发起拦截：pending 中 requestOmnicodeWorkspaceTakeover 返回 false 不再调处理器", () => {
    const handler = vi.fn();
    setOmnicodeTakeoverRequestHandler(handler);
    markOmnicodeTakeoverPending(pathA, "tk-registry-003");
    expect(requestOmnicodeWorkspaceTakeover(pathA)).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    // 非 pending 路径正常受理
    expect(requestOmnicodeWorkspaceTakeover(pathB)).toBe(true);
    expect(handler).toHaveBeenCalledWith({ workspacePath: pathB });
    setOmnicodeTakeoverRequestHandler(null);
  });

  it("处理器缺席：hasOmnicodeTakeoverRequestHandler=false 且发起 no-op", () => {
    setOmnicodeTakeoverRequestHandler(null);
    expect(hasOmnicodeTakeoverRequestHandler()).toBe(false);
    expect(requestOmnicodeWorkspaceTakeover(pathA)).toBe(false);
  });
});
