// [OmniCode] 批次3 锁冲突处置改造——自动观察者（D11，2026-11-15 用户拍板）。
// spec: docs/omnicode/profile-runtime.md §批次2 B2-2（D11 修订）。
// 语义：锁冲突不再弹窗拦截（对话框退役），acquire 判负按序决策——
// ① 已有观察者 tab 仅激活（不重复 toast）②首次判负补一次完整打开流（锁主退出竞态自愈：
//   重试成功=Normal 打开）③其余直接观察者打开 + 非模态 toast（去重窗口内不重复）。
// 打开编排（addTab/startDraft/toast/retry）在 useRootWorkspaceActions 装配；决策与去重
// 为纯函数（packages/ui/src/root/omnicodeLockConflictOpen.ts），tab 机制经 tabStore 实测。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OMNICODE_OBSERVER_TOAST_DEDUPE_WINDOW_MS,
  observerToastDedupeKey,
  resolveOmnicodeLockConflictOpenAction,
  shouldSuppressRepeatedObserverToast,
} from "../../ui/src/root/omnicodeLockConflictOpen.js";
import {
  createTabStore,
  findWorkspaceObserverHolder,
  isWorkspaceTabObserver,
} from "../../ui/src/store/tabStore.js";
import { collectOpenLocalWorkspacePaths } from "../../ui/src/hooks/useTabPersistence.js";
import { resolveWorkspaceOpenGuardDecision } from "../../services/src/omnicode/workspaceLocks.js";

const SELF = "pself00001";
const OTHER = "pother0001";
const WORKSPACE = "C:\\ws\\auto-observer-demo";
const HOLDER = { holderProfileId: OTHER, holderDisplayName: "工作号 A" };

let observerHolderLookup: () => ReturnType<typeof findWorkspaceObserverHolder> = () => null;
// 模拟 handleSelectProject catch 分支：判负 → 决策 → 装配动作（与 hook 装配一一对应）
function simulateLockConflictOpen(options?: {
  isLockRaceRetry?: boolean;
  suppressRaceRetry?: boolean;
}): { kind: string; toastCount: number } {
  let toastCount = 0;
  const store = storeRef;
  const action = resolveOmnicodeLockConflictOpenAction({
    existingObserverHolder: findWorkspaceObserverHolder(store.getState(), WORKSPACE),
    isRaceRetry: options?.isLockRaceRetry === true,
    suppressRaceRetry: options?.suppressRaceRetry === true,
  });
  if (action.kind === "activate-existing-observer") {
    store.getState().activateTabByPath(WORKSPACE);
    return { kind: action.kind, toastCount };
  }
  if (action.kind === "retry-acquire") {
    return { kind: action.kind, toastCount };
  }
  // open-observer：addTab（merge 幂等）→ 状态更新 → toast 去重（与 hook 同口径）
  store.getState().addTab(WORKSPACE, { omnicodeObserver: HOLDER });
  observerHolderLookup = () => findWorkspaceObserverHolder(store.getState(), WORKSPACE);
  const dedupeKey = observerToastDedupeKey(WORKSPACE);
  const now = nowRef;
  if (
    !shouldSuppressRepeatedObserverToast(toastShownAt.get(dedupeKey), now) &&
    observerHolderLookup() !== null
  ) {
    toastShownAt.set(dedupeKey, now);
    toastCount += 1;
  }
  return { kind: action.kind, toastCount };
}

// 模拟"重试成功"= 完整打开流成功分支的升级链路（clear → addTab，B2 评审修复 P1-1）
function simulateNormalOpenAfterRetry(): void {
  storeRef.getState().clearOmnicodeObserver(WORKSPACE);
  storeRef.getState().addTab(WORKSPACE);
}

let storeRef: ReturnType<typeof createTabStore>;
let nowRef: number;
const toastShownAt = new Map<string, number>();

beforeEach(() => {
  storeRef = createTabStore();
  nowRef = 1_000_000;
  observerHolderLookup = () => findWorkspaceObserverHolder(storeRef.getState(), WORKSPACE);
  toastShownAt.clear();
});

afterEach(() => {
  observerHolderLookup = () => null;
  storeRef = undefined as unknown as ReturnType<typeof createTabStore>;
  nowRef = 0;
  toastShownAt.clear();
});

describe("omnicode D11: 锁冲突自动观察者——打开决策（纯函数）", () => {
  it("首次判负 → 补一次竞态重试（retry-acquire）；WSL UNC 不重试直接观察者", () => {
    expect(
      resolveOmnicodeLockConflictOpenAction({
        existingObserverHolder: null,
        isRaceRetry: false,
      }),
    ).toEqual({ kind: "retry-acquire" });
    expect(
      resolveOmnicodeLockConflictOpenAction({
        existingObserverHolder: null,
        isRaceRetry: false,
        suppressRaceRetry: true,
      }),
    ).toEqual({ kind: "open-observer" });
  });

  it("竞态重试仍判负 → 直接观察者打开（不递归重试）", () => {
    expect(
      resolveOmnicodeLockConflictOpenAction({
        existingObserverHolder: null,
        isRaceRetry: true,
      }),
    ).toEqual({ kind: "open-observer" });
  });

  it("已有观察者 tab → 仅激活既有 tab（边界①，重试标记不再参与判定）", () => {
    expect(
      resolveOmnicodeLockConflictOpenAction({
        existingObserverHolder: HOLDER,
        isRaceRetry: false,
      }),
    ).toEqual({ kind: "activate-existing-observer" });
    expect(
      resolveOmnicodeLockConflictOpenAction({
        existingObserverHolder: HOLDER,
        isRaceRetry: true,
      }),
    ).toEqual({ kind: "activate-existing-observer" });
  });
});

describe("omnicode D11: 冲突路径端到端机制（acquire 判负 → 观察者态打开 → 提示）", () => {
  it("冲突自动观察者：观察者 tab 打开、不进锁集合、持有者可读（toast 数据源）", () => {
    const result = simulateLockConflictOpen({ isLockRaceRetry: true });
    expect(result.kind).toBe("open-observer");
    expect(result.toastCount).toBe(1);
    const tab = storeRef.getState().tabs[0];
    expect(tab).toBeDefined();
    expect(isWorkspaceTabObserver(tab!)).toBe(true);
    expect(findWorkspaceObserverHolder(storeRef.getState(), WORKSPACE)).toEqual(HOLDER);
    // 观察者不获取锁（B2-2 既有语义回归）：不进 openLocalWorkspaces 锁集合
    expect(collectOpenLocalWorkspacePaths(storeRef.getState())).toEqual([]);
  });

  it("重复打开不重复提示：观察者态再次打开 → 仅激活既有 tab、tab 不重复、toast 不重复", () => {
    simulateLockConflictOpen({ isLockRaceRetry: true });
    const tabCountBefore = storeRef.getState().tabs.length;
    const tabIdBefore = storeRef.getState().tabs[0]!.id;

    const again = simulateLockConflictOpen({ isLockRaceRetry: true });
    expect(again.kind).toBe("activate-existing-observer");
    expect(again.toastCount).toBe(0);
    // tab 不重复，激活即可达
    expect(storeRef.getState().tabs.length).toBe(tabCountBefore);
    expect(storeRef.getState().tabs[0]!.id).toBe(tabIdBefore);
    expect(storeRef.getState().activeTabId).toBe(tabIdBefore);
    expect(isWorkspaceTabObserver(storeRef.getState().tabs[0]!)).toBe(true);
  });

  it("边界②锁主退出竞态：判负时决策 retry-acquire；重试成功 = Normal 打开（锁集合恢复）", () => {
    // 判负时尚无观察者 tab → 决策 = 补一次完整打开流（锁主刚退出则守卫放行）
    expect(
      resolveOmnicodeLockConflictOpenAction({
        existingObserverHolder: observerHolderLookup(),
        isRaceRetry: false,
      }),
    ).toEqual({ kind: "retry-acquire" });
    // 重试成功（锁已释放）= 正常打开成功分支的升级链路（clear → addTab，P1-1 语义）
    simulateNormalOpenAfterRetry();
    const tab = storeRef.getState().tabs[0];
    expect(tab).toBeDefined();
    expect(isWorkspaceTabObserver(tab!)).toBe(false);
    expect(findWorkspaceObserverHolder(storeRef.getState(), WORKSPACE)).toBeNull();
    // 升级为可写后锁集合采集恢复包含该工作区（Host 协调器据此获取锁）
    expect(collectOpenLocalWorkspacePaths(storeRef.getState())).toEqual([WORKSPACE]);
  });

  it("并发重复打开微任务交错兜底：去重窗口内第二次 open-observer 不再 toast", () => {
    // 两次判负几乎同时到达、各自进入 open-observer（激活判定尚未命中新 tab）
    const first = simulateLockConflictOpen({ isLockRaceRetry: true });
    expect(first.toastCount).toBe(1);
    // 第二次调用在激活判定前交错进入（模拟：直接 open-observer 分支，绕过状态判定）
    storeRef.getState().addTab(WORKSPACE, { omnicodeObserver: HOLDER });
    const now = nowRef;
    expect(
      shouldSuppressRepeatedObserverToast(toastShownAt.get(observerToastDedupeKey(WORKSPACE)), now),
    ).toBe(true);
    // tab 仍只有一个（addTab merge 幂等）
    expect(storeRef.getState().tabs.length).toBe(1);
  });

  it("去重窗口外（如关闭观察者 tab 后重新冲突）允许再次提示", () => {
    simulateLockConflictOpen({ isLockRaceRetry: true });
    const key = observerToastDedupeKey(WORKSPACE);
    expect(shouldSuppressRepeatedObserverToast(toastShownAt.get(key), nowRef)).toBe(true);
    expect(
      shouldSuppressRepeatedObserverToast(
        toastShownAt.get(key),
        nowRef + OMNICODE_OBSERVER_TOAST_DEDUPE_WINDOW_MS,
      ),
    ).toBe(false);
  });

  it("toast 去重键与锁装饰路径归一口径一致（尾分隔符 + 大小写不敏感）", () => {
    expect(observerToastDedupeKey("C:\\WS\\Demo\\")).toBe(observerToastDedupeKey("c:\\ws\\demo"));
    expect(observerToastDedupeKey("/ws/demo/")).toBe("/ws/demo");
  });
});

describe("omnicode D11: 官方分支不受影响（Host 守卫判定语义回归锁定）", () => {
  it("无 observerRequested 的守卫判定保持 reject（官方 flavor / 管理器纯拒绝不变）", () => {
    expect(
      resolveWorkspaceOpenGuardDecision({ lockOwner: { profileId: OTHER }, selfProfileId: SELF }),
    ).toEqual({ kind: "reject", owner: { profileId: OTHER } });
    // 同 profileId（含同实例多窗口）幂等放行
    expect(
      resolveWorkspaceOpenGuardDecision({ lockOwner: { profileId: SELF }, selfProfileId: SELF }),
    ).toEqual({ kind: "open" });
    // observerRequested 仅 omnicode 打开流传入；守卫判定本身不受 D11 影响
    expect(
      resolveWorkspaceOpenGuardDecision({
        lockOwner: { profileId: OTHER },
        selfProfileId: SELF,
        observerRequested: true,
      }),
    ).toEqual({ kind: "observer", owner: { profileId: OTHER } });
  });
});
