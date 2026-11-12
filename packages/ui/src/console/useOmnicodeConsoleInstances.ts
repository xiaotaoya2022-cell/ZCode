// [OmniCode] 批次2 B2-3：控制台实例数据与操作共享 hook（spec: docs/omnicode/profile-runtime.md §批次2 D9）。
// 从 ProfileMultiInstanceSection 提炼：列表/实时帧（letterbox 升级，帧附 {w,h}）/
// 启动=重启/停止/克隆/删除/聚焦/打开数据目录/平铺/还原。控制台网格与设置页分区
// 复用同一数据链（B2-1 useOmnicodeConsoleAdoption 同款共享约定）。
// 平台方法缺席（官方 flavor / 旧 preload）时安全降级为空列表。
import { useCallback, useEffect, useState } from "react";
import type { OmnicodeProfileSummaryInfo } from "@zcode/shared";
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

export function useOmnicodeConsoleInstances() {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const requestConfirmation = useConfirmDialogStore((state) => state.requestConfirmation);
  const [profiles, setProfiles] = useState<OmnicodeProfileSummaryInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await platform.listOmnicodeProfiles?.();
      setProfiles(result?.profiles ?? []);
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
  useEffect(() => {
    const unsubscribe = platform.onOmnicodeInstanceEvent?.((payload) => {
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
        void refresh();
      }
    });
    return unsubscribe ?? (() => {});
  }, [platform, refresh]);

  // [OmniCode] B2 评审修复（P2-8 兜底）：实例停止/删除后清非 running 实例的帧
  //（disconnected 事件之外的停止路径——如管理器重启后的列表重建）。
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
        () => platform.launchOmnicodeProfile!({ id: profile.id }),
        "settings.omnicodeProfiles.toastLaunched",
      );
    },
    [platform, runAction],
  );

  const handleStop = useCallback(
    (profile: OmnicodeProfileSummaryInfo) => {
      if (!profile.running) return;
      void runAction(
        () => platform.stopOmnicodeProfile!({ id: profile.id }),
        "settings.omnicodeProfiles.toastStopped",
      );
    },
    [platform, runAction],
  );

  const handleClone = useCallback(
    (profile: OmnicodeProfileSummaryInfo) => {
      void runAction(
        () => platform.cloneOmnicodeProfile!({ id: profile.id, name: `${profile.name} 2` }),
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
          () => platform.removeOmnicodeProfile!({ id: profile.id }),
          "settings.omnicodeProfiles.toastRemoved",
        );
      })();
    },
    [intl, platform, requestConfirmation, runAction],
  );

  const runningCount = profiles.filter((profile) => profile.running).length;

  return {
    profiles,
    loading,
    busy,
    frames,
    refresh,
    runningCount,
    handleLaunch,
    handleStop,
    handleClone,
    handleFocus,
    handleRevealDataDir,
    handleArrange,
    handleRemove,
  };
}
