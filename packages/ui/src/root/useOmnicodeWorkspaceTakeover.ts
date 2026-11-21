/* D12 接管流的 Root 级编排集中点：观察者（请求/回执/取消/重开）与持有者（确认/优雅关闭/锁释放等待）共用同一 hook，拆分会割裂身份判定。 */
import { useEffect, useLayoutEffect, useRef } from "react";
import {
  OMNICODE_TAKEOVER_HOLDER_DECISION_TIMEOUT_MS,
  OMNICODE_TAKEOVER_LOCK_RELEASE_POLL_MS,
  OMNICODE_TAKEOVER_LOCK_RELEASE_WAIT_MS,
  ZCODE_PRODUCT_FLAVOR,
  type IPlatformService,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import type { TabStore } from "@/store/tabStore.js";
import { type WindowTabState } from "@/store/tabStore.js";
import {
  isWorkspaceLockReleased,
  resolveTakeoverWorkspaceTabToClose,
  resolveOmnicodeTakeoverObserverAction,
  shouldCancelTakeoverForClosedTab,
  type TakeoverLockDecorationView,
} from "@/root/omnicodeTakeover.js";
import {
  getOmnicodeTakeoverPendingRequestId,
  getOmnicodeTakeoverPendingSnapshot,
  markOmnicodeTakeoverPending,
  setOmnicodeTakeoverRequestHandler,
  settleOmnicodeTakeoverPending,
} from "@/root/omnicodeTakeoverRegistry.js";

/**
 * [OmniCode] D12 请求接管流（锁体系闭环，spec: docs/omnicode/profile-runtime.md §批次3
 * D12）——Root 级编排 hook，仅 omnicode 实例进程激活（官方 flavor / 管理器全部 no-op）。
 *
 * 观察者侧：装配横幅按钮处理器 → 桥上行请求；订阅回执事件（toast / accepted 自动以
 * 可写身份重开——复用 B2-2 P1-1「锁释放后 Normal 打开」链路，handleSelectProject 成功
 * 分支自带 clearOmnicodeObserver）；tab 集合变化时对"在途请求的工作区已关 tab"上报取消
 * （事件驱动，无轮询）。
 *
 * 持有者侧：订阅确认请求事件 → 应用内确认对话框（与 logout/WSL 确认同款风格，
 * 30s 超时=默认拒绝，经 AbortSignal 关闭对话框）→ 同意后走既有 tabStore.closeTab
 * （user-close 原点 = 草稿/会话自动持久化 + openLocalWorkspaces 写回 → Host 协调器
 * 释放锁）→ 有界等待锁实际释放 → 回执 accepted / close-failed（不触碰锁原语）。
 */
export function useOmnicodeWorkspaceTakeover({
  intl,
  platform,
  services,
  tabStoreApi,
  handleSelectProject,
  tabs,
}: {
  intl: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["intl"];
  platform: IPlatformService;
  services: IServiceAccessor;
  tabStoreApi: TabStore;
  handleSelectProject: (
    path: string,
    activateOtherWindow?: boolean,
    options?: { isLockRaceRetry?: boolean },
  ) => Promise<void>;
  tabs: WindowTabState[];
}): void {
  const requestConfirmation = useConfirmDialog();
  // 与 Root 的管理器判定同口径：官方 flavor 恒 false（全部 effect 不装配，零改动铁律）。
  const isOmnicodeInstance =
    ZCODE_PRODUCT_FLAVOR === "omnicode" && (platform.omnicodeInstanceId ?? null) !== null;
  const intlRef = useRef(intl);
  useLayoutEffect(() => {
    intlRef.current = intl;
  });
  // 重开链读取最近已提交实现（与 useRootWorkspaceActions 的 selectProjectRef 同模式——
  // Root 每轮重挂动作函数，闭包引用不能冻结）。
  const reopenRef = useRef(handleSelectProject);
  useLayoutEffect(() => {
    reopenRef.current = handleSelectProject;
  });
  const tabStoreApiRef = useRef(tabStoreApi);
  useLayoutEffect(() => {
    tabStoreApiRef.current = tabStoreApi;
  });

  // ── 观察者侧：装配横幅「请求接管」按钮处理器 ──
  useEffect(() => {
    if (!isOmnicodeInstance || !platform.requestOmnicodeWorkspaceTakeover) {
      return;
    }
    setOmnicodeTakeoverRequestHandler(({ workspacePath }) => {
      void (async () => {
        try {
          const result = await platform.requestOmnicodeWorkspaceTakeover?.({ workspacePath });
          if (!result?.ok) {
            // 发送失败（桥未连接/路径非法）：清槽 + 提示（未发出，无回执事件可依）。
            settleOmnicodeTakeoverPending(workspacePath);
            toast(intlRef.current.formatMessage({ id: "omnicode.takeover.requestFailed" }), {
              variant: "warning",
            });
            return;
          }
          if (result.requestId) {
            markOmnicodeTakeoverPending(workspacePath, result.requestId);
          }
        } catch (error) {
          settleOmnicodeTakeoverPending(workspacePath);
          logger.warn("[OmniCode] 接管请求发送异常", error);
          toast(intlRef.current.formatMessage({ id: "omnicode.takeover.requestFailed" }), {
            variant: "warning",
          });
        }
      })();
    });
    return () => {
      setOmnicodeTakeoverRequestHandler(null);
    };
  }, [isOmnicodeInstance, platform]);

  // ── 观察者侧：回执事件订阅（toast / accepted 自动重开） ──
  useEffect(() => {
    if (!isOmnicodeInstance || !platform.onOmnicodeTakeoverEvent) {
      return;
    }
    return platform.onOmnicodeTakeoverEvent((payload) => {
      const action = resolveOmnicodeTakeoverObserverAction({
        outcome: payload.outcome,
        holderName: payload.holderName,
      });
      settleOmnicodeTakeoverPending(payload.workspacePath);
      if (action.kind === "reopen") {
        toast(intlRef.current.formatMessage({ id: "omnicode.takeover.acceptedToast" }), {
          variant: "info",
        });
        // 复用 B2-2 P1-1 链路：saveProject 守卫放行（锁已释放）→ 成功分支
        // clearOmnicodeObserver + addTab + startDraft = 可写打开。
        void reopenRef.current(payload.workspacePath).catch((error) => {
          logger.warn("[OmniCode] 接管成功后自动重开失败", error);
          toast(
            intlRef.current.formatMessage({ id: "omnicode.takeover.reopenFailed" }, { path: payload.workspacePath }),
            { variant: "warning" },
          );
        });
        return;
      }
      if (action.kind === "toast") {
        toast(
          intlRef.current.formatMessage(
            { id: action.messageId },
            action.values ? { ...action.values } : undefined,
          ),
          { variant: action.variant },
        );
      }
    });
  }, [isOmnicodeInstance, platform]);

  // ── 观察者侧：取消上报（在途请求的工作区 tab 已关 → cancel，事件驱动非轮询） ──
  useEffect(() => {
    if (!isOmnicodeInstance || !platform.cancelOmnicodeWorkspaceTakeover) {
      return;
    }
    // 横幅登记表按路径维护；用快照遍历（Registry 无 React 订阅需求——这里由 tabs 驱动）。
    for (const pendingPath of getOmnicodeTakeoverPendingSnapshot()) {
      if (!shouldCancelForTabs(tabs, pendingPath)) {
        continue;
      }
      const requestId = getOmnicodeTakeoverPendingRequestId(pendingPath);
      settleOmnicodeTakeoverPending(pendingPath);
      if (requestId) {
        platform.cancelOmnicodeWorkspaceTakeover({ requestId });
      }
    }
  }, [isOmnicodeInstance, platform, tabs]);

  // ── 持有者侧：确认请求订阅（应用内对话框 + 30s 超时默认拒绝 + 优雅关闭 + 回执） ──
  useEffect(() => {
    if (
      !isOmnicodeInstance ||
      !platform.onOmnicodeTakeoverConfirm ||
      !platform.decideOmnicodeWorkspaceTakeover
    ) {
      return;
    }
    let disposed = false;
    const decide = (input: Parameters<
      NonNullable<IPlatformService["decideOmnicodeWorkspaceTakeover"]>
    >[0]) => {
      if (disposed) return;
      platform.decideOmnicodeWorkspaceTakeover?.(input);
    };
    const disposeConfirm = platform.onOmnicodeTakeoverConfirm((payload) => {
      if (disposed) return;
      void (async () => {
        // 30s 超时 = 默认拒绝（D12 语义）：AbortController 超时关断对话框（dismiss），
        // 计时器直接上报 timeout；用户先点按钮则清计时器，不再触发。
        let timedOut = false;
        const controller = new AbortController();
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          decide({ requestId: payload.requestId, decision: "denied", reason: "timeout" });
        }, OMNICODE_TAKEOVER_HOLDER_DECISION_TIMEOUT_MS);
        timer.unref?.();
        let confirmed: boolean;
        try {
          confirmed = await requestConfirmation({
            title: intlRef.current.formatMessage({ id: "omnicode.takeover.confirmTitle" }),
            description: intlRef.current.formatMessage(
              { id: "omnicode.takeover.confirmDescription" },
              { name: payload.requesterName, path: payload.workspacePath },
            ),
            confirmLabel: intlRef.current.formatMessage({ id: "omnicode.takeover.confirmAccept" }),
            cancelLabel: intlRef.current.formatMessage({ id: "omnicode.takeover.confirmDeny" }),
          });
        } finally {
          clearTimeout(timer);
        }
        if (disposed || timedOut) return; // 超时已上报；迟到的用户点击按请求方已不等待丢弃
        if (!confirmed) {
          decide({ requestId: payload.requestId, decision: "denied", reason: "user" });
          return;
        }
        // 同意：优雅关闭工作区（既有 tab 关闭链，非强杀）。找不到 tab = 无需关闭，
        // 仍进入锁释放等待（锁可能由同实例其他窗口语义覆盖或已释放）。
        const tabToClose = resolveTakeoverWorkspaceTabToClose(
          tabStoreApiRef.current.getState(),
          payload.workspacePath,
        );
        if (tabToClose) {
          try {
            tabStoreApiRef.current.getState().closeTab(tabToClose.tabId, "user-close");
          } catch (error) {
            logger.warn("[OmniCode] 接管同意后关闭工作区 tab 失败", error);
            decide({
              requestId: payload.requestId,
              decision: "denied",
              reason: "close-failed",
            });
            return;
          }
        }
        // 有界等待锁实际释放（openLocalWorkspaces 300ms debounce + 协调器对账；
        // 一次性等待非常驻轮询，红线合规）。等待失败 = 关闭失败（保存冲突/IO 异常）。
        const released = await waitForWorkspaceLockRelease(services, payload.workspacePath);
        if (released) {
          decide({ requestId: payload.requestId, decision: "accepted" });
          return;
        }
        logger.warn("[OmniCode] 接管同意后锁未在窗口内释放", { path: payload.workspacePath });
        decide({ requestId: payload.requestId, decision: "denied", reason: "close-failed" });
      })().catch((error) => {
        logger.warn("[OmniCode] 持有者接管确认编排异常", error);
        decide({ requestId: payload.requestId, decision: "denied", reason: "close-failed" });
      });
    });
    return () => {
      disposed = true;
      disposeConfirm();
    };
  }, [isOmnicodeInstance, platform, requestConfirmation, services]);
}

/** tabs 快照下的取消判定（omnicodeTakeover 纯函数的 hook 侧适配）。 */
function shouldCancelForTabs(tabs: WindowTabState[], pendingWorkspacePath: string): boolean {
  return shouldCancelTakeoverForClosedTab({ pendingWorkspacePath, tabs });
}

/**
 * 有界等待锁实际释放：readTree 的 omnicodeWorkspaceLocks 装饰轮询（LOCK_RELEASE_WAIT
 * 上限 / POLL 步长）。查询失败按"未释放"继续等（不提前判败——保存冲突场景 Host 自身
 * 会重试），窗口耗尽仍未释放 → 调用方回执 close-failed。
 */
async function waitForWorkspaceLockRelease(
  services: IServiceAccessor,
  workspacePath: string,
): Promise<boolean> {
  const deadline = Date.now() + OMNICODE_TAKEOVER_LOCK_RELEASE_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const tree = await services.projectService?.readTree();
      const locks = (tree?.omnicodeWorkspaceLocks ?? []) as TakeoverLockDecorationView[];
      if (isWorkspaceLockReleased(locks, workspacePath)) {
        return true;
      }
    } catch (error) {
      logger.warn("[OmniCode] 接管锁释放等待查询失败（继续等待）", error);
    }
    await new Promise((resolve) => setTimeout(resolve, OMNICODE_TAKEOVER_LOCK_RELEASE_POLL_MS));
  }
  return false;
}
