// [OmniCode] 批次2 B2-3：控制台实例网格主体（spec: docs/omnicode/profile-runtime.md §批次2 D9）。
// 工具行（新建/内嵌-桌面模式切换/平铺/实时预览开关）+ 自适应卡片网格 + 单视图放大 +
// 底栏。内嵌模式上报卡片画面区矩形（embedLayout 跟随）；视口可见性经 IntersectionObserver
// 驱动预览订阅；数据与操作来自 useOmnicodeConsoleInstances（与设置页分区共享）。
import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, LayoutGrid, Plus, RefreshCw, Undo2 } from "lucide-react";
import type { OmnicodeConsoleUiState } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { cn } from "@/components/lib/utils.js";
import { useOmnicodeConsoleInstances } from "@/console/useOmnicodeConsoleInstances.js";
import {
  ConsoleInstanceCard,
  CreateInstanceDialog,
} from "@/console/ConsoleInstanceCard.js";
import { ConsolePerfPanel } from "@/console/ConsolePerfPanel.js";

/** renderer 侧 embed 上报节流（main 侧 move/resize 再兜一层同规格，spec D9）。 */
const EMBED_REPORT_THROTTLE_MS = 60;

/** 卡片画面区元素注册表（embed 上报按 profileId 取 rect；卡片卸载即移除）。 */
function useScreenElementRegistry() {
  const elementsRef = useRef(new Map<string, HTMLElement>());
  const registerScreen = useCallback((profileId: string, element: HTMLElement | null) => {
    if (element) {
      elementsRef.current.set(profileId, element);
    } else {
      elementsRef.current.delete(profileId);
    }
  }, []);
  return { elementsRef, registerScreen };
}

/**
 * 控制台实例网格主体（工具行 + 网格 + 底栏 + 新建实例弹窗）。
 * 由 ConsoleHome 渲染；模式/预览状态经 OmnicodeConsoleUiState IPC 持久化（console-ui.json）。
 */
export function ConsoleInstanceGrid() {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const {
    profiles,
    loading,
    busy,
    frames,
    focusRequest,
    refresh,
    runningCount,
    handleLaunch,
    handleStop,
    handleClone,
    handleFocus,
    handleRevealDataDir,
    handleArrange,
    handleRemove,
  } = useOmnicodeConsoleInstances();
  // [OmniCode] B2 评审修复（P2-11②）：底栏内存合计（设计 §4.1 承诺）。数据源 = Profile
  // 列表携带的实例内存占用（main 侧 tasklist 聚合，Windows）；任一运行实例内存不可得
  // 时不显示（不编造部分和）。
  const totalMemoryMB = (() => {
    const running = profiles.filter((profile) => profile.running);
    if (running.length === 0 || running.some((profile) => profile.memoryMB === undefined)) {
      return null;
    }
    return running.reduce((sum, profile) => sum + (profile.memoryMB ?? 0), 0);
  })();

  // ─── UI 状态（内嵌/桌面模式 + 实时预览总开关，持久化于 main 的 console-ui.json） ───
  const [uiState, setUiState] = useState<OmnicodeConsoleUiState>({
    mode: "embedded",
    previewEnabled: true,
  });
  useEffect(() => {
    void platform
      .getOmnicodeConsoleUiState?.()
      .then((state) => {
        if (state) setUiState(state);
      })
      .catch(() => {
        /* 旧 preload / 读取失败：保持默认（embedded + 预览开） */
      });
  }, [platform]);

  const handleModeChange = useCallback(
    (mode: OmnicodeConsoleUiState["mode"]) => {
      if (busy || uiState.mode === mode) return;
      void (async () => {
        try {
          // main 侧先完成 owned 编排/解除（进桌面需等待解除完成）再返回
          const next = await platform.setOmnicodeConsoleUiState?.({ mode });
          setUiState(next ?? { ...uiState, mode });
          toast(
            intl.formatMessage({
              id: mode === "embedded" ? "console.modeToastEmbedded" : "console.modeToastDesktop",
            }),
            { variant: "success" },
          );
        } catch (error) {
          toast(intl.formatMessage({ id: "settings.omnicodeProfiles.actionFailed" }), {
            variant: "warning",
          });
          logger.warn("[omnicode] 控制台模式切换失败", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    },
    [busy, intl, platform, uiState],
  );

  const handlePreviewToggle = useCallback(
    (previewEnabled: boolean) => {
      setUiState((previous) => ({ ...previous, previewEnabled }));
      void platform.setOmnicodeConsoleUiState?.({ previewEnabled }).catch(() => {
        /* 持久化失败不阻断本地开关（下一拍 renderer 上报会再对齐） */
      });
    },
    [platform],
  );

  // ─── [OmniCode] 批次2.5 X1：性能面板（右侧抽屉；开关记忆于 console-ui.json 的
  // perfPanelOpen；开=上报 PerfState enabled 让 main 启动周期采样，关=停采；
  // unavailable（非 Windows / tasklist 连续失败）= 入口整体隐藏，spec:
  // docs/omnicode/console-extras.md §X1） ───
  const [perfUnavailable, setPerfUnavailable] = useState(false);
  const perfPanelOpen = uiState.perfPanelOpen === true;
  useEffect(() => {
    // 初始态与开关变化都上报（面板打开后 main 才开始采样；关闭即停）
    void platform.setOmnicodePerfPanelState?.({ enabled: perfPanelOpen }).catch(() => {
      /* 旧 preload / 瞬时失败：面板无数据但不阻断 */
    });
  }, [platform, perfPanelOpen]);

  const handlePerfToggle = useCallback(
    (open: boolean) => {
      if (open && perfUnavailable) {
        toast(intl.formatMessage({ id: "console.perfUnavailable" }), { variant: "default" });
        return;
      }
      setUiState((previous) => ({ ...previous, perfPanelOpen: open }));
      void platform.setOmnicodeConsoleUiState?.({ perfPanelOpen: open }).catch(() => {
        /* 持久化失败不阻断本地开关（下次切换会再对齐） */
      });
    },
    [intl, perfUnavailable, platform],
  );

  const handlePerfUnavailable = useCallback(() => {
    setPerfUnavailable(true);
    // 仅本地关闭面板并停采；持久化值保持原样——下次应用启动（perfPanelOpen=true）
    // 会重新走一次 enable 全流程，给降级后的自动重试留出口（spec §降级语义）。
    setUiState((previous) => (previous.perfPanelOpen ? { ...previous, perfPanelOpen: false } : previous));
  }, []);

  // ─── 单视图放大（双击运行卡片 = 放大；ESC / 返回钮 = 回网格） ───
  const [enlargedId, setEnlargedId] = useState<string | null>(null);
  useEffect(() => {
    if (!enlargedId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEnlargedId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enlargedId]);
  // 放大目标被删除/出列时退出单视图
  useEffect(() => {
    if (enlargedId && !profiles.some((profile) => profile.id === enlargedId)) {
      setEnlargedId(null);
    }
  }, [enlargedId, profiles]);

  const toggleEnlarge = useCallback(
    (profileId: string, running: boolean) => {
      if (!running) {
        toast(intl.formatMessage({ id: "console.stoppedNoZoom" }), { variant: "default" });
        return;
      }
      setEnlargedId((previous) => (previous === profileId ? null : profileId));
    },
    [intl],
  );

  // ─── 内嵌跟随：卡片画面区矩形上报（60ms 节流；仅内嵌模式） ───
  const gridRef = useRef<HTMLDivElement | null>(null);
  const { elementsRef, registerScreen } = useScreenElementRegistry();
  const reportTimerRef = useRef<number | null>(null);
  const reportPendingRef = useRef(false);

  const collectAndReportEmbedLayout = useCallback(() => {
    // [OmniCode] B2 评审修复（P2-9 勘误记录）：视口分母必须用整窗 CSS 视口
    //（window.innerWidth/innerHeight）而非网格容器 clientWidth——main 侧换算
    // scale = getContentBounds(DIP) / viewport(CSS px) = zoomFactor，卡片 rect
    //（getBoundingClientRect）与 innerWidth 同处窗口视口坐标系；网格容器不含
    // 工具行/边距，作分母会放大比例导致实例窗口整体错位。容器自身滚动条不影响：
    // 卡片坐标天然落在滚动条左侧，分母是全局比例与内容位置无关。
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const runningIds = new Set(profiles.filter((profile) => profile.running).map((p) => p.id));
    const rects: { profileId: string; x: number; y: number; width: number; height: number }[] = [];
    for (const [profileId, element] of elementsRef.current) {
      if (!runningIds.has(profileId)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      rects.push({ profileId, x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    }
    void platform
      .sendOmnicodeEmbedLayout?.({ viewportWidth, viewportHeight, rects })
      .catch(() => {
        /* 上报失败等下一拍（拖动中高频，静默容忍） */
      });
  }, [elementsRef, platform, profiles]);

  const scheduleEmbedReport = useCallback(() => {
    if (reportTimerRef.current !== null) return;
    reportTimerRef.current = window.setTimeout(
      () => {
        reportTimerRef.current = null;
        if (reportPendingRef.current) {
          reportPendingRef.current = false;
          scheduleEmbedReport();
        }
        collectAndReportEmbedLayout();
      },
      EMBED_REPORT_THROTTLE_MS,
    );
  }, [collectAndReportEmbedLayout]);

  // 触发源：网格/卡片尺寸变化（ResizeObserver 观察容器 + 各卡片画面区——卡片高度随
  // 帧首现的真实宽高比变化，容器本身滚动区高度不变观察不到）+ 滚动/窗口缩放 +
  // 卡片增删/放大切换/模式切换。deps 刻意不含 frames（1.4fps 高频重建观察者是浪费，
  // 帧驱动的尺寸变化由观察到的卡片元素自身尺寸变化捕获）。
  useEffect(() => {
    if (uiState.mode !== "embedded") return;
    scheduleEmbedReport();
    const container = gridRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      reportPendingRef.current = true;
      scheduleEmbedReport();
    });
    observer.observe(container);
    for (const element of elementsRef.current.values()) observer.observe(element);
    const onScroll = () => {
      reportPendingRef.current = true;
      scheduleEmbedReport();
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      observer.disconnect();
      container.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [elementsRef, scheduleEmbedReport, uiState.mode, profiles, enlargedId]);

  // ─── 视口可见性 → 预览订阅（IntersectionObserver；总开关关 = 全部退订停最后一帧） ───
  const visibleIdsRef = useRef<Set<string>>(new Set());
  const cardElementsRef = useRef(new Map<string, HTMLElement>());
  const registerCard = useCallback((profileId: string, element: HTMLElement | null) => {
    if (element) {
      cardElementsRef.current.set(profileId, element);
    } else {
      cardElementsRef.current.delete(profileId);
    }
  }, []);

  const publishPreviewState = useCallback(
    (visibleProfileIds: readonly string[]) => {
      void platform
        .setOmnicodePreviewState?.({
          previewEnabled: uiState.previewEnabled,
          visibleProfileIds: [...visibleProfileIds],
        })
        .catch(() => {
          /* 旧 preload / 瞬时失败：下一拍可见性变化时再上报 */
        });
    },
    [platform, uiState.previewEnabled],
  );

  useEffect(() => {
    const container = gridRef.current;
    if (!container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const profileId = (entry.target as HTMLElement).dataset.omnicodeProfileId;
          if (!profileId) continue;
          const wasVisible = visibleIdsRef.current.has(profileId);
          if (entry.isIntersecting && !wasVisible) {
            visibleIdsRef.current.add(profileId);
            changed = true;
          } else if (!entry.isIntersecting && wasVisible) {
            visibleIdsRef.current.delete(profileId);
            changed = true;
          }
        }
        if (changed) {
          publishPreviewState([...visibleIdsRef.current]);
        }
      },
      { root: container, threshold: 0.05 },
    );
    for (const element of cardElementsRef.current.values()) observer.observe(element);
    // 卡片挂载/卸载（profiles 变化、单视图切换）时对齐观察集合并重发一次
    const visibleNow = [...cardElementsRef.current.keys()].filter((profileId) => {
      const element = cardElementsRef.current.get(profileId);
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      return (
        rect.bottom > containerRect.top && rect.top < containerRect.bottom && rect.height > 0
      );
    });
    visibleIdsRef.current = new Set(visibleNow);
    publishPreviewState(visibleNow);
    return () => observer.disconnect();
    // enlargedId 进 deps：单视图切换时其余卡片卸载，可见集需重算（避免给已隐藏实例保留订阅）
  }, [profiles, publishPreviewState, enlargedId]);

  // 预览总开关变化即时重发（main 侧按 总开关∧可见 对账订阅）
  useEffect(() => {
    publishPreviewState([...visibleIdsRef.current]);
  }, [publishPreviewState]);

  // ─── 新建实例弹窗（创建即启动，对齐演示稿「启动实例」语义） ───
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [creating, setCreating] = useState(false);

  const handleCreateAndLaunch = useCallback(() => {
    const name = newName.trim();
    if (!name) {
      toast(intl.formatMessage({ id: "settings.omnicodeProfiles.nameRequired" }), {
        variant: "warning",
      });
      return;
    }
    void (async () => {
      setCreating(true);
      try {
        const result = await platform.createOmnicodeProfile!({
          name,
          notes: newNotes.trim() || undefined,
        });
        await platform.launchOmnicodeProfile!({ id: result.profile.id });
        toast(intl.formatMessage({ id: "console.toastCreatedAndLaunched" }), {
          variant: "success",
        });
        setCreateOpen(false);
        setNewName("");
        setNewNotes("");
      } catch (error) {
        toast(
          `${intl.formatMessage({ id: "settings.omnicodeProfiles.actionFailed" })}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { variant: "warning" },
        );
      } finally {
        setCreating(false);
      }
    })();
  }, [intl, newName, newNotes, platform]);

  // ─── [OmniCode] 批次2.5 X3：托盘聚焦请求 → 滚动定位对应卡片 + 短暂高亮
  //（main 广播 focusRequested；目标在其他实例的单视图时先退回网格让卡片回 DOM，spec §X3） ───
  const [focusHighlightId, setFocusHighlightId] = useState<string | null>(null);
  useEffect(() => {
    if (!focusRequest) return;
    const { profileId } = focusRequest;
    setEnlargedId((current) => (current && current !== profileId ? null : current));
    // 等一拍让（可能的）单视图退出先渲染，再滚动定位
    const raf = window.requestAnimationFrame(() => {
      const element = cardElementsRef.current.get(profileId);
      element?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    setFocusHighlightId(profileId);
    const timer = window.setTimeout(() => {
      setFocusHighlightId((current) => (current === profileId ? null : current));
    }, 1600);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [focusRequest]);

  const cardActionProps = {
    busy,
    mode: uiState.mode,
    previewEnabled: uiState.previewEnabled,
    onLaunch: handleLaunch,
    onStop: handleStop,
    onClone: handleClone,
    onRemove: handleRemove,
    onRevealDataDir: handleRevealDataDir,
    onFocus: handleFocus,
    onToggleEnlarge: (profile: { id: string; running: boolean }) =>
      toggleEnlarge(profile.id, profile.running),
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* 工具行：新建 | 内嵌/桌面模式切换 | 平铺/还原（桌面模式专属）| 实时预览开关 */}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setCreateOpen(true)} disabled={busy}>
          <Plus className="size-3.5" />
          {intl.formatMessage({ id: "console.toolbarNewInstance" })}
        </Button>
        <div className="flex items-center rounded-md border border-border p-0.5">
          {(["embedded", "desktop"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => handleModeChange(mode)}
              disabled={busy}
              className={cn(
                "rounded-sm px-3 py-1 text-ui-sm transition-colors",
                uiState.mode === mode
                  ? "bg-primary text-primary-foreground"
                  : "text-foreground-subtle hover:text-foreground",
              )}
            >
              {intl.formatMessage({
                id: mode === "embedded" ? "console.modeEmbedded" : "console.modeDesktop",
              })}
            </button>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => handleArrange("settings.omnicodeProfiles.toastArranged")}
          disabled={busy || uiState.mode !== "desktop" || runningCount === 0}
          title={
            uiState.mode === "embedded"
              ? intl.formatMessage({ id: "console.arrangeTileDisabledTitle" })
              : intl.formatMessage({ id: "settings.omnicodeProfiles.arrange" })
          }
        >
          <LayoutGrid className="size-3.5" />
          {intl.formatMessage({ id: "settings.omnicodeProfiles.arrange" })}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => handleArrange("settings.omnicodeProfiles.toastRestored")}
          disabled={busy || uiState.mode !== "desktop" || runningCount === 0}
          title={intl.formatMessage({ id: "settings.omnicodeProfiles.restore" })}
        >
          <Undo2 className="size-3.5" />
          {intl.formatMessage({ id: "settings.omnicodeProfiles.restore" })}
        </Button>
        <label className="flex items-center gap-2 text-ui-sm text-foreground-subtle">
          <Switch
            checked={uiState.previewEnabled}
            onCheckedChange={handlePreviewToggle}
            disabled={busy}
          />
          {intl.formatMessage({ id: "console.previewLabel" })}
        </label>
        {!perfUnavailable ? (
          <Button
            variant={perfPanelOpen ? "default" : "outline"}
            size="sm"
            onClick={() => handlePerfToggle(!perfPanelOpen)}
            disabled={busy}
            title={intl.formatMessage({ id: "console.perfToggleTitle" })}
          >
            <Activity className="size-3.5" />
            {intl.formatMessage({ id: "console.perfToggleLabel" })}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto"
          onClick={() => void refresh()}
          disabled={busy}
          aria-label="refresh"
        >
          <RefreshCw className="size-4" />
        </Button>
      </div>

      {/* 网格 / 单视图 + 性能抽屉（X1：右侧浮层，覆盖网格区不重排布局） */}
      <div className="relative min-h-0 flex-1">
        {perfPanelOpen && !perfUnavailable ? (
          <ConsolePerfPanel
            profiles={profiles}
            onClose={() => handlePerfToggle(false)}
            onUnavailable={handlePerfUnavailable}
          />
        ) : null}
        {enlargedId ? (
          <Button
            size="sm"
            className="absolute left-0 top-0 z-20"
            onClick={() => setEnlargedId(null)}
          >
            <Undo2 className="size-3.5" />
            {intl.formatMessage({ id: "console.backToGrid" })}
          </Button>
        ) : null}
        {loading ? (
          <p className="text-ui-sm text-foreground-subtlest">
            {intl.formatMessage({ id: "settings.omnicodeProfiles.loading" })}
          </p>
        ) : profiles.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <h2 className="text-ui-lg text-foreground">
              {intl.formatMessage({ id: "console.emptyTitle" })}
            </h2>
            <p className="max-w-md text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "console.emptyBody" })}
            </p>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-3.5" />
              {intl.formatMessage({ id: "console.emptyCreate" })}
            </Button>
          </div>
        ) : (
          <div
            ref={gridRef}
            className={cn(
              "grid min-h-0 h-full gap-3 overflow-y-auto",
              enlargedId
                ? "grid-cols-1 grid-rows-1 pt-11"
                : "auto-rows-min grid-cols-[repeat(auto-fill,minmax(280px,1fr))] pb-1",
            )}
          >
            {profiles
              .filter((profile) => !enlargedId || profile.id === enlargedId)
              .map((profile) => (
                <ConsoleInstanceCard
                  key={profile.id}
                  profile={profile}
                  frame={frames.get(profile.id)}
                  enlarged={enlargedId === profile.id}
                  focusHighlighted={focusHighlightId === profile.id}
                  registerScreen={registerScreen}
                  registerCard={registerCard}
                  {...cardActionProps}
                />
              ))}
            {!enlargedId ? (
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="flex aspect-[16/10] min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-foreground-subtlest transition-colors hover:border-foreground-subtle hover:text-foreground-subtle"
              >
                <Plus className="size-6" />
                <span className="text-ui-sm">
                  {intl.formatMessage({ id: "console.toolbarNewInstance" })}
                </span>
              </button>
            ) : null}
          </div>
        )}
      </div>

      {/* 底栏（B2 评审修复 P2-11②：补设计 §4.1 承诺的内存合计） */}
      <div className="flex items-center gap-4 border-t border-border pt-2 text-ui-xs text-foreground-subtlest">
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              "inline-block size-1.5 rounded-full",
              runningCount > 0 ? "bg-emerald-500" : "bg-foreground-subtlest",
            )}
          />
          {intl.formatMessage(
            { id: "console.statusRunning" },
            { running: String(runningCount), total: String(profiles.length) },
          )}
        </span>
        {totalMemoryMB !== null ? (
          <span className="shrink-0">
            {intl.formatMessage(
              { id: "console.statusMemory" },
              { memory: String(totalMemoryMB) },
            )}
          </span>
        ) : null}
        <span className="min-w-0 truncate">
          {intl.formatMessage({
            id: uiState.mode === "embedded" ? "console.gridHintEmbedded" : "console.gridHintDesktop",
          })}
        </span>
      </div>

      {/* 新建实例弹窗 */}
      {createOpen ? (
        <CreateInstanceDialog
          newName={newName}
          newNotes={newNotes}
          creating={creating}
          onNameChange={setNewName}
          onNotesChange={setNewNotes}
          onCancel={() => setCreateOpen(false)}
          onSubmit={handleCreateAndLaunch}
        />
      ) : null}
    </div>
  );
}
