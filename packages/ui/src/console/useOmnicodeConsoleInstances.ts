// [OmniCode] 批次2 B2-3：控制台实例数据与操作共享 hook（spec: docs/omnicode/profile-runtime.md §批次2 D9）。
// 从 ProfileMultiInstanceSection 提炼：列表/实时帧（letterbox 升级，帧附 {w,h}）/
// 启动=重启/停止/克隆/删除/聚焦/打开数据目录/平铺/还原。控制台网格与设置页分区
// 复用同一数据链（B2-1 useOmnicodeConsoleAdoption 同款共享约定）。
// 平台方法缺席（官方 flavor / 旧 preload）时安全降级为空列表。
// [OmniCode] 实例元数据批次：排序态（sortMode/customOrder，console-ui.json 持久化）+
// sortedProfiles（网格/设置列表共用 shared sortOmnicodeInstances 同一排序事实源）+
// 重命名（客户端重名校验 trim 后同名拒绝 + main 侧白名单校验双保险）。
import { useCallback, useEffect, useMemo, useState } from "react";
import type { OmnicodeProfileSummaryInfo, OmnicodeInstanceSortMode } from "@zcode/shared";
import { sortOmnicodeInstances } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

/** 缩略图帧 + 内容区尺寸（DIP，实例侧 capturePage 同刻读取；缺省回退默认比例）。 */
export interface OmnicodeInstanceFrame {
  frame: string;
  width?: number;
  height?: number;
}

/** [OmniCode] omni.5 真机验收修复：可选桥方法统一存在性检查——桥装配缺失（官方
 * flavor / 旧 preload / 漏装配）时抛可读错误，由 runAction 捕获转 toast，替代此前
 * `platform.method!` 非空断言在 undefined 上触发的裸 TypeError crash。 */
function requireOmnicodeBridgeMethod<TResult>(
  method: ((...args: never[]) => Promise<TResult>) | undefined,
  name: string,
): (...args: unknown[]) => Promise<TResult> {
  if (!method) {
    throw new Error(`omnicode.platform-method-unavailable: ${name}`);
  }
  return method as (...args: unknown[]) => Promise<TResult>;
}

// [OmniCode] 2026-11-28 用户反馈⑤：模块级快照（上次成功列表；null = 从未成功读取）。
// 回管理器先渲染快照再后台刷新——不再白屏"正在读取实例列表"。缓存跨挂载存活，实例
// 增删由 refresh 覆盖（缓存只是首帧投影，不是事实源）。
let lastProfilesSnapshot: OmnicodeProfileSummaryInfo[] | null = null;

export function useOmnicodeConsoleInstances() {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const requestConfirmation = useConfirmDialogStore((state) => state.requestConfirmation);
  const [profiles, setProfiles] = useState<OmnicodeProfileSummaryInfo[]>(
    () => lastProfilesSnapshot ?? [],
  );
  const [loading, setLoading] = useState(() => lastProfilesSnapshot === null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await platform.listOmnicodeProfiles?.();
      const next = result?.profiles ?? [];
      lastProfilesSnapshot = next;
      setProfiles(next);
    } catch (error) {
      logger.warn("[omnicode] 读取 Profile 列表失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  }, [platform]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 实例事件订阅：thumbnail 帧实时更新（1.4fps/实例，M2 视窗管线；B2-3 帧附 {w,h}）
  const [frames, setFrames] = useState<ReadonlyMap<string, OmnicodeInstanceFrame>>(new Map());
  // [OmniCode] 后台降载：实例预览停帧态集合（实例窗口 hide/最小化 → 停帧广播；
  // 恢复帧或断连时清除）。卡片/性能面板据此标注「已停帧」。
  const [pausedProfileIds, setPausedProfileIds] = useState<ReadonlySet<string>>(new Set());
  // [OmniCode] 批次2.5 X3：托盘聚焦请求（main 广播 focusRequested → 网格滚动定位对应
  // 卡片并短暂高亮；nonce 让同一实例的连续两次请求都能触发效果，spec:
  // docs/omnicode/console-extras.md §X3）
  const [focusRequest, setFocusRequest] = useState<{ profileId: string; nonce: number } | null>(null);
  useEffect(() => {
    const unsubscribe = platform.onOmnicodeInstanceEvent?.((payload) => {
      if (payload.type === "focusRequested") {
        setFocusRequest({ profileId: payload.profileId, nonce: Date.now() });
        return;
      }
      if (payload.type === "framePaused") {
        const paused = payload.paused === true;
        setPausedProfileIds((previous) => {
          const has = previous.has(payload.profileId);
          if (paused === has) return previous;
          const next = new Set(previous);
          if (paused) next.add(payload.profileId);
          else next.delete(payload.profileId);
          return next;
        });
        return;
      }
      if (payload.type === "thumbnail" && payload.frame) {
        const profileId = payload.profileId;
        const nextFrame: OmnicodeInstanceFrame = {
          frame: payload.frame,
          ...(payload.width && payload.height ? { width: payload.width, height: payload.height } : {}),
        };
        setFrames((previous) => {
          const next = new Map(previous);
          next.set(profileId, nextFrame);
          return next;
        });
        // 帧到达 = 未停帧（恢复事件丢失时由此兜底清除停帧态）。
        setPausedProfileIds((previous) => {
          if (!previous.has(profileId)) return previous;
          const next = new Set(previous);
          next.delete(profileId);
          return next;
        });
      }
      if (payload.type === "disconnected") {
        // [OmniCode] B2 评审修复（P2-8）：断开实例的最后一帧不再保留——已停止实例
        // 的卡片应显示停止占位（▶启动），残留旧帧会伪装成"还有画面"。
        setFrames((previous) => {
          if (!previous.has(payload.profileId)) return previous;
          const next = new Map(previous);
          next.delete(payload.profileId);
          return next;
        });
        setPausedProfileIds((previous) => {
          if (!previous.has(payload.profileId)) return previous;
          const next = new Set(previous);
          next.delete(payload.profileId);
          return next;
        });
        void refresh();
      }
      // [OmniCode] 丙1 远程聚合 R4 failover（spec: docs/omnicode/remote-aggregation.md
      // §6）：聚合宿主退出提示——D11 openedToast 同款 toast 机制（i18n 五语）。仅管理器
      // 进程窗口可收到该事件（广播源 = 管理器桥服务的 remoteForwardHost failover 对账；
      // 宿主自动转移为二期——本提示只告知跨实例远控暂不可用）。
      if (payload.type === "remoteHostExited") {
        toast(intl.formatMessage({ id: "omnicode.remoteAggregate.hostExitedToast" }), {
          variant: "warning",
        });
      }
    });
    return unsubscribe ?? (() => {});
  }, [platform, refresh, intl]);

  // [OmniCode] B2 评审修复（P2-8 兜底）：实例停止/删除后清非 running 实例的帧
  //（disconnected 事件之外的停止路径——如管理器重启后的列表重建）。停帧态同步清除。
  useEffect(() => {
    setFrames((previous) => {
      if (previous.size === 0) return previous;
      const runningIds = new Set(profiles.filter((profile) => profile.running).map((p) => p.id));
      let changed = false;
      const next = new Map(previous);
      for (const profileId of next.keys()) {
        if (!runningIds.has(profileId)) {
          next.delete(profileId);
          changed = true;
        }
      }
      return changed ? next : previous;
    });
    setPausedProfileIds((previous) => {
      if (previous.size === 0) return previous;
      const runningIds = new Set(profiles.filter((profile) => profile.running).map((p) => p.id));
      let changed = false;
      const next = new Set(previous);
      for (const profileId of next) {
        if (!runningIds.has(profileId)) {
          next.delete(profileId);
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [profiles]);

  const runAction = useCallback(
    async (action: () => Promise<unknown>, successMessageId: string | null) => {
      setBusy(true);
      try {
        await action();
        if (successMessageId) {
          toast(intl.formatMessage({ id: successMessageId }), { variant: "success" });
        }
        await refresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast(
          `${intl.formatMessage({ id: "settings.omnicodeProfiles.actionFailed" })}: ${message}`,
          { variant: "warning" },
        );
        logger.warn("[omnicode] Profile 操作失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setBusy(false);
      }
    },
    [intl, refresh],
  );

  const handleLaunch = useCallback(
    (profile: OmnicodeProfileSummaryInfo) => {
      // 批次1 P1-4「启动=重启」：已运行实例点击启动 = 先三段式优雅停再启动。
      void runAction(
        () => requireOmnicodeBridgeMethod(platform.launchOmnicodeProfile, "launchOmnicodeProfile")({ id: profile.id }),
        "settings.omnicodeProfiles.toastLaunched",
      );
    },
    [platform, runAction],
  );

  const handleStop = useCallback(
    (profile: OmnicodeProfileSummaryInfo) => {
      if (!profile.running) return;
      void runAction(
        () => requireOmnicodeBridgeMethod(platform.stopOmnicodeProfile, "stopOmnicodeProfile")({ id: profile.id }),
        "settings.omnicodeProfiles.toastStopped",
      );
    },
    [platform, runAction],
  );

  const handleClone = useCallback(
    (profile: OmnicodeProfileSummaryInfo) => {
      void runAction(
        () => requireOmnicodeBridgeMethod(platform.cloneOmnicodeProfile, "cloneOmnicodeProfile")({ id: profile.id, name: `${profile.name} 2` }),
        "settings.omnicodeProfiles.toastCloned",
      );
    },
    [platform, runAction],
  );

  const handleFocus = useCallback(
    (profile: OmnicodeProfileSummaryInfo) => {
      if (!profile.running) return;
      void platform.focusOmnicodeProfile?.({ id: profile.id });
    },
    [platform],
  );

  const handleRevealDataDir = useCallback(
    (profile: OmnicodeProfileSummaryInfo) => {
      void platform.revealOmnicodeProfileDataDir?.({ id: profile.id });
    },
    [platform],
  );

  // M2 v1 平铺编排/还原（桌面模式专属动作；delivered=0 通常是实例尚未回连桥，如实提示）
  const handleArrange = useCallback(
    (messageId: "settings.omnicodeProfiles.toastArranged" | "settings.omnicodeProfiles.toastRestored") => {
      void (async () => {
        try {
          const result =
            messageId === "settings.omnicodeProfiles.toastArranged"
              ? await platform.arrangeOmnicodeInstances?.()
              : await platform.restoreOmnicodeInstances?.();
          const count = result?.delivered.length ?? 0;
          if (count === 0) {
            toast(intl.formatMessage({ id: "settings.omnicodeProfiles.toastArrangeNone" }), {
              variant: "warning",
            });
            return;
          }
          toast(intl.formatMessage({ id: messageId }, { count: String(count) }), {
            variant: "success",
          });
        } catch (error) {
          logger.warn("[omnicode] 平铺编排失败", {
            error: error instanceof Error ? error.message : String(error),
          });
          toast(intl.formatMessage({ id: "settings.omnicodeProfiles.actionFailed" }), {
            variant: "warning",
          });
        }
      })();
    },
    [intl, platform],
  );

  const handleRemove = useCallback(
    (profile: OmnicodeProfileSummaryInfo) => {
      void (async () => {
        const confirmed = await requestConfirmation({
          confirmVariant: "destructive",
          title: intl.formatMessage({ id: "settings.omnicodeProfiles.deleteConfirmTitle" }),
          description: intl.formatMessage(
            { id: "settings.omnicodeProfiles.deleteConfirmDescription" },
            { name: profile.name },
          ),
        });
        if (!confirmed) return;
        await runAction(
          () => requireOmnicodeBridgeMethod(platform.removeOmnicodeProfile, "removeOmnicodeProfile")({ id: profile.id }),
          "settings.omnicodeProfiles.toastRemoved",
        );
      })();
    },
    [intl, platform, requestConfirmation, runAction],
  );

  // ─── [OmniCode] 实例元数据批次：重命名（卡片「更多」菜单 + 设置分区行内编辑共用） ───
  // 客户端先校验（trim 非空 + trim 后同名拒绝，不区分大小写）给 i18n 提示；main 侧
  // renameOmnicodeProfile 仍做同样白名单校验兜底（双保险）。改名后 refresh 使 name 经
  // List 数据链直通网格/看板卡/设置列表；托盘重建与运行中实例窗口标题热更新在 main 侧。
  const handleRename = useCallback(
    (profile: OmnicodeProfileSummaryInfo, newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed) {
        toast(intl.formatMessage({ id: "settings.omnicodeProfiles.nameRequired" }), {
          variant: "warning",
        });
        return;
      }
      const duplicate = profiles.some(
        (entry) =>
          entry.id !== profile.id && entry.name.trim().toLowerCase() === trimmed.toLowerCase(),
      );
      if (duplicate) {
        toast(
          intl.formatMessage({ id: "console.renameDuplicate" }, { name: trimmed }),
          { variant: "warning" },
        );
        return;
      }
      void runAction(
        () => requireOmnicodeBridgeMethod(platform.renameOmnicodeProfile, "renameOmnicodeProfile")({ id: profile.id, name: trimmed }),
        "console.toastRenamed",
      );
    },
    [intl, platform, profiles, runAction],
  );

  // ─── [OmniCode] 实例元数据批次：排序态（console-ui.json；三视图共用 shared 排序函数） ───
  const [sortMode, setSortModeState] = useState<OmnicodeInstanceSortMode>("seq");
  const [customOrder, setCustomOrderState] = useState<string[]>([]);
  useEffect(() => {
    void platform
      .getOmnicodeConsoleUiState?.()
      .then((state) => {
        if (!state) return;
        setSortModeState(state.sortMode ?? "seq");
        setCustomOrderState(state.customOrder ?? []);
      })
      .catch(() => {
        /* 旧 preload / 读取失败：保持默认（seq 序） */
      });
  }, [platform]);

  /** 切换排序模式（持久化 console-ui.json；本地乐观更新，落盘值漂移可忽略——单写者）。 */
  const setSortMode = useCallback(
    (mode: OmnicodeInstanceSortMode) => {
      setSortModeState(mode);
      void platform.setOmnicodeConsoleUiState?.({ sortMode: mode }).catch(() => {
        /* 持久化失败不阻断本地切换（下次打开回落已落盘值） */
      });
    },
    [platform],
  );

  /** 提交拖拽产生的自定义顺序（乐观本地更新 + console-ui.json customOrder 全量 patch）。 */
  const applyCustomOrder = useCallback(
    (order: readonly string[]) => {
      setCustomOrderState([...order]);
      void platform.setOmnicodeConsoleUiState?.({ customOrder: [...order] }).catch(() => {
        /* 持久化失败不阻断本地顺序（下次操作会再写） */
      });
    },
    [platform],
  );

  const sortedProfiles = useMemo(
    () => sortOmnicodeInstances(profiles, { mode: sortMode, customOrder }),
    [profiles, sortMode, customOrder],
  );

  const runningCount = profiles.filter((profile) => profile.running).length;

  return {
    profiles,
    sortedProfiles,
    sortMode,
    customOrder,
    setSortMode,
    applyCustomOrder,
    loading,
    busy,
    frames,
    pausedProfileIds,
    focusRequest,
    refresh,
    runningCount,
    handleLaunch,
    handleStop,
    handleClone,
    handleRename,
    handleFocus,
    handleRevealDataDir,
    handleArrange,
    handleRemove,
  };
}
