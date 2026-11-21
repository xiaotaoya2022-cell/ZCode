// [OmniCode] 批次2 B2-3：控制台实例卡片 + 新建实例弹窗（spec: docs/omnicode/profile-runtime.md §批次2 D9）。
// 卡片结构对照演示稿：顶条（28-32px 管理器自绘控制钮区，内嵌模式下实例窗口贴下方画面区）+
// 画面区（letterbox 预览 / 停止占位 / 拖出监控模糊遮罩 / 预览关角标 / 停靠 resize 手柄）。
// [OmniCode] 批次3 停靠重构（B 套件 a/c）：全局内嵌/桌面模式退役，改为每实例 docked——
// - 停靠（docked=true）：画面区 letterbox 底图隐藏（真窗口精确盖满=看起来就是预览窗口
//   本身，消除双层悬浮感；帧数据仍驱动 aspect 计算，缩略图 capturePage 走实例侧
//   WebContents 与本 img 无关）+ 四边 resize 手柄（卡片权威调高→embedLayout 跟随）；
// - 拖出（docked=false）：恢复底图实时预览 + 模糊监控遮罩 +「收回」钮。
import { useEffect, useRef, useState } from "react";
import {
  Copy,
  FolderOpen,
  Maximize2,
  Monitor,
  MoreHorizontal,
  Pencil,
  Play,
  Square,
  SquareArrowDownLeft,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-react";
import type {
  OmnicodeEmbedResizeEdge,
  OmnicodeLoginHealthInfo,
  OmnicodeProfileSummaryInfo,
} from "@zcode/shared";
import { resolveOmnicodeEmbedResizeHeightCss } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import type { OmnicodeInstanceFrame } from "@/console/useOmnicodeConsoleInstances.js";

/** 帧无尺寸信息时的回退宽高比（旧实例兼容）。 */
export const DEFAULT_FRAME_ASPECT_RATIO = 16 / 10;

/** 卡片动作集合（ConsoleInstanceGrid 传入；操作实现在 useOmnicodeConsoleInstances）。 */
export interface ConsoleInstanceCardActions {
  busy: boolean;
  previewEnabled: boolean;
  onLaunch: (profile: OmnicodeProfileSummaryInfo) => void;
  onStop: (profile: OmnicodeProfileSummaryInfo) => void;
  onClone: (profile: OmnicodeProfileSummaryInfo) => void;
  onRemove: (profile: OmnicodeProfileSummaryInfo) => void;
  onRevealDataDir: (profile: OmnicodeProfileSummaryInfo) => void;
  onFocus: (profile: OmnicodeProfileSummaryInfo) => void;
  onToggleEnlarge: (profile: OmnicodeProfileSummaryInfo) => void;
}

/** 单张实例卡片：画面区元素注册供内嵌 embed 上报（registerScreen）与视口可见性观察（registerCard）。 */
export function ConsoleInstanceCard(props: {
  profile: OmnicodeProfileSummaryInfo;
  frame?: OmnicodeInstanceFrame;
  enlarged: boolean;
  /** [OmniCode] 批次2.5 X3：托盘聚焦请求的短暂高亮（ring）。 */
  focusHighlighted?: boolean;
  registerScreen: (profileId: string, element: HTMLElement | null) => void;
  registerCard: (profileId: string, element: HTMLElement | null) => void;
  /** [OmniCode] 批次3 停靠重构：本实例是否停靠（resolveOmnicodeInstanceDocked 解析结果）。 */
  docked: boolean;
  /** 拖出/收回（卡片钮区 + 监控遮罩收回钮；编排与持久化在 main，grid 乐观更新）。 */
  onDockChange: (docked: boolean) => void;
  /** [OmniCode] 批次3（B 套件 c）：resize 手柄拖拽快路径上报（绕过 60ms 节流）。 */
  reportEmbedLayoutNow?: () => void;
  /** [OmniCode] 批次3（B 套件 c）：CSS→DIP 纵向换算比例（main 随上报响应回传）。 */
  embedScaleRef?: { current: number };
  /** [OmniCode] 实例元数据批次：重命名（卡片「更多」菜单入口；校验/持久化在 hook/main）。 */
  onRename?: (profile: OmnicodeProfileSummaryInfo, newName: string) => void;
  /**
   * [OmniCode] 实例元数据批次：自定义排序拖拽手柄（卡片 header；仅 custom 排序模式启用）。
   * 拖拽判定/落点计算/提交在网格层（pointerdown 冒泡 + data-omnicode-drag-handle 定位）。
   */
  dragHandle?: boolean;
  /** 本卡是否为拖拽中的卡（网格层状态回显：降低透明度让落点指示可读）。 */
  dragging?: boolean;
  /**
   * [OmniCode] 后台降载：实例预览停帧态（实例窗口 hide/最小化 → 停帧广播）。
   * 停帧中卡片画面区左上角标注「已停帧」，区分"暂停预览"与"卡死/黑屏"。
   */
  framePaused?: boolean;
  /** 落点指示线位置（目标卡上/下半区；null=非目标）。 */
  dropIndicator?: "before" | "after" | null;
  /**
   * [OmniCode] 实例元数据批次：拖拽提交时刻（网格层 ref）——拖拽 pointerup 后紧随的
   * click 事件被吞（桌面态点击=聚焦的误触源）；无拖拽时为 0。
   */
  dragJustCommitted?: { current: number };
} & ConsoleInstanceCardActions) {
  const { intl } = useZCodeIntl();
  const {
    profile,
    frame,
    enlarged,
    focusHighlighted,
    registerScreen,
    registerCard,
    docked,
    onDockChange,
    reportEmbedLayoutNow,
    embedScaleRef,
    busy,
    previewEnabled,
    onLaunch,
    onStop,
    onClone,
    onRename,
    onRemove,
    onRevealDataDir,
    onFocus,
    onToggleEnlarge,
    dragHandle,
    dragging,
    dropIndicator,
    dragJustCommitted,
  } = props;
  const { id, name, running, notes, pid, seq } = profile;
  // [OmniCode] 实例元数据批次：卡片「重命名」弹窗本地态（入口在「更多」菜单）。
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  // [OmniCode] 后台降载：实例停帧态（hook frames 同源事件流；true=实例窗口不可见停帧中）。
  const framePaused = props.framePaused === true;
  const frameAspectRatio =
    frame?.width && frame?.height && frame.width > 0 && frame.height > 0
      ? `${frame.width} / ${frame.height}`
      : String(DEFAULT_FRAME_ASPECT_RATIO);
  // [OmniCode] B2 评审修复（P2-7 内嵌尺寸反馈环）：停靠下"帧尺寸→卡片画面区高（aspect）
  // →embedLayout 矩形→实例窗口 setBounds→下一帧尺寸"形成反馈环（微抖）。进入停靠后
  // 冻结首帧比例（embedLayout 生效前的自然基线，反馈环无起点）；拖出恢复动态（真窗口
  // 不贴卡片，无环）。[OmniCode] 批次3（B 套件 c）：resize 手柄拖拽提交时更新冻结值
  // （新比例 = 拖后画面区真实宽高比，窗口跟随卡片保持精确贴合）。
  const [embeddedAspectRatio, setEmbeddedAspectRatio] = useState<string | null>(null);
  useEffect(() => {
    if (!docked) {
      setEmbeddedAspectRatio(null); // 拖出态恢复动态比例
      return;
    }
    if (embeddedAspectRatio === null && frame?.width && frame?.height && frame.width > 0 && frame.height > 0) {
      setEmbeddedAspectRatio(`${frame.width} / ${frame.height}`);
    }
  }, [docked, frame, embeddedAspectRatio]);
  const aspectRatio = docked ? (embeddedAspectRatio ?? String(DEFAULT_FRAME_ASPECT_RATIO)) : frameAspectRatio;

  // [OmniCode] 批次3（B 套件 c）：画面区元素本地引用（resize 手柄改高/提交冻结比例）。
  const screenElementRef = useRef<HTMLDivElement | null>(null);
  const registerScreenElement = (element: HTMLDivElement | null) => {
    screenElementRef.current = element;
    registerScreen(id, element);
  };

  /**
   * resize 手柄拖拽（卡片权威）：pointermove 按 shared 手柄数学改画面区高度
   *（下限 = 96 DIP / scale 换算回 CSS，保证实例侧独立校验必过）+ 快路径上报让窗口
   * 实时跟随；pointerup 时序（批次3 终审修复 P2-⑥）：先在 inline 高度仍在时测量最终
   * 矩形 → 冻结新宽高比 → 上报最终矩形 → 最后清 inline 高度（冻结比例 = 拖后真实
   * 比例，aspect 样式接管后高度与 inline 等值——同帧收敛无回弹；旧顺序"先清高度
   * 再上报"会上报回落到旧 aspect 的矩形，造成 1-2 帧回弹）。手柄可命中依赖 main
   * 侧 embedLayout 四边 6px 内缩（P1-2：窗口只盖内区，四边手柄露出在窗口外沿）。
   * 双击/点击在手柄上被吞（不触发放大/聚焦）。
   */
  const beginResize = (edge: OmnicodeEmbedResizeEdge) => (event: React.PointerEvent<HTMLDivElement>) => {
    const element = screenElementRef.current;
    if (!element || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startRect = element.getBoundingClientRect();
    if (startRect.width <= 0 || startRect.height <= 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const scaleY = embedScaleRef?.current ?? 1;
    const onMove = (moveEvent: PointerEvent) => {
      const nextHeight = resolveOmnicodeEmbedResizeHeightCss({
        edge,
        startHeightCss: startRect.height,
        dxCss: moveEvent.clientX - startX,
        dyCss: moveEvent.clientY - startY,
        scaleY,
      });
      element.style.height = `${Math.round(nextHeight)}px`;
      reportEmbedLayoutNow?.();
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      // P2-⑥ 时序：inline 高度仍在 → 测量最终矩形 → 冻结比例 → 上报 → 再清高度态。
      // 冻结比例等于拖后真实比例，清 inline 高度后 aspect 样式接管的高度与之等值
      //（同帧收敛），上报的矩形不再回落旧 aspect（消除 1-2 帧回弹）。
      const finalRect = element.getBoundingClientRect();
      if (finalRect.width > 0 && finalRect.height > 0) {
        setEmbeddedAspectRatio(`${finalRect.width} / ${finalRect.height}`);
      }
      reportEmbedLayoutNow?.();
      element.style.height = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const handleCardClick = () => {
    // [OmniCode] 实例元数据批次：拖拽提交后紧随的 click 吞掉（250ms 窗口）——桌面态
    // 点击=聚焦，拖拽结束时指针已移动到目标卡上，放行会把「换位」误判成「聚焦目标卡」。
    if (dragJustCommitted && Date.now() - dragJustCommitted.current < 250) return;
    // 拖出态：点击卡片 = 聚焦真窗口。停靠态画面区中心被实例窗口覆盖（main 下发矩形
    // 已四边内缩 6px——仅四边手柄带露出可命中，中心区域点击仍落在实例窗口），
    // 故本处理只在拖出态生效（批次3 终审 P1-2 勘误：旧注释"点击到不了这里"与手柄
    // 放在覆盖区内的矛盾已由内缩方案消除）。
    if (!docked && running) onFocus(profile);
  };

  const resizeHandles = docked && running && !enlarged
    ? (["top", "bottom", "left", "right"] as const).map((edge) => (
        <div
          key={edge}
          onPointerDown={beginResize(edge)}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          title={intl.formatMessage({ id: "console.resizeHandleTitle" })}
          className={cn(
            "absolute z-10 touch-none",
            edge === "top" && "inset-x-0 top-0 h-1.5 cursor-ns-resize",
            edge === "bottom" && "inset-x-0 bottom-0 h-1.5 cursor-ns-resize",
            edge === "left" && "inset-y-0 left-0 w-1.5 cursor-ew-resize",
            edge === "right" && "inset-y-0 right-0 w-1.5 cursor-ew-resize",
          )}
        />
      ))
    : null;

  return (
    <section
      ref={(element) => registerCard(id, element)}
      data-omnicode-profile-id={id}
      onDoubleClick={() => onToggleEnlarge(profile)}
      onClick={handleCardClick}
      className={cn(
        // [OmniCode] 批次2.5 X4：hover 过渡统一（全部模式一致的边框+阴影节奏）
        "group relative flex flex-col overflow-hidden rounded-lg border border-border bg-popover transition-[border-color,box-shadow] duration-200 ease-out",
        running
          ? "hover:border-foreground-subtle/60 hover:shadow-md"
          : "hover:border-border",
        !docked && running && "cursor-pointer",
        focusHighlighted && "border-primary ring-1 ring-primary",
        // [OmniCode] omni.5 真机修复（F4-10）：被拖卡抬升态（抬升阴影 + 轻微放大 +
        // 半透明弱化），替代此前仅 opacity-45 的扁平弱化——拖拽对象在网格中可辨识。
        dragging &&
          "z-10 scale-[1.03] shadow-lg shadow-black/40 ring-1 ring-primary/70 opacity-85",
        // 插入位置占位高亮线：primary 实线边 + 同色细 ring 勾勒目标卡轮廓（比旧 2px
        // 单边线醒目，插入前/后语义不变）。
        dropIndicator === "before" && "border-t-2 border-t-primary ring-1 ring-primary/60",
        dropIndicator === "after" && "border-b-2 border-b-primary ring-1 ring-primary/60",
        enlarged && "h-full",
      )}
    >
      {/* 顶条（28-32px：停靠模式下管理器自绘控制钮区，实例窗口贴下方画面区）。
          [OmniCode] 实例元数据批次：custom 排序模式下的拖拽手柄（grid 层 pointerdown
          冒泡定位；按钮/输入被排除，手柄只认 header 本体）——停靠态画面区被真窗口
          覆盖、桌面态点击=聚焦、resize 手柄在画面区四边，全部与本手柄无冲突。 */}
      <header
        data-omnicode-drag-handle={dragHandle ? id : undefined}
        title={dragHandle ? intl.formatMessage({ id: "console.dragSortTitle" }) : undefined}
        className={cn(
          "flex h-8 shrink-0 items-center gap-2 border-b border-border px-2",
          dragHandle && "cursor-grab select-none active:cursor-grabbing",
        )}
      >
        <span
          className={cn(
            "inline-block size-2 shrink-0 rounded-full",
            running ? "bg-emerald-500" : "bg-foreground-subtlest",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-ui-sm font-medium text-foreground">
          {name}
        </span>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {running ? (
            <>
              {/* [OmniCode] 批次3 停靠重构：停靠实例「拖出」——releaseEmbed 恢复桌面
                  窗口（任务栏项复位），卡片转纯监控态（实时预览+模糊遮罩+收回钮） */}
              {docked ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation();
                    onDockChange(false);
                  }}
                  title={intl.formatMessage({ id: "console.undockTitle" })}
                >
                  <SquareArrowOutUpRight className="size-3.5" />
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleEnlarge(profile);
                }}
                title={intl.formatMessage({ id: "console.zoomInTitle" })}
              >
                <Maximize2 className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation();
                  onStop(profile);
                }}
                title={intl.formatMessage({ id: "settings.omnicodeProfiles.stop" })}
              >
                <Square className="size-3.5" />
              </Button>
            </>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                disabled={busy}
                onClick={(event) => event.stopPropagation()}
                title={intl.formatMessage({ id: "console.moreTitle" })}
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
              <DropdownMenuItem onClick={() => onLaunch(profile)}>
                <Play className="size-3.5" />
                {intl.formatMessage({ id: "settings.omnicodeProfiles.launch" })}
              </DropdownMenuItem>
              {running && !docked ? (
                <DropdownMenuItem onClick={() => onFocus(profile)}>
                  <Monitor className="size-3.5" />
                  {intl.formatMessage({ id: "settings.omnicodeProfiles.focus" })}
                </DropdownMenuItem>
              ) : null}
              {running && docked ? (
                <DropdownMenuItem onClick={() => onDockChange(false)}>
                  <SquareArrowOutUpRight className="size-3.5" />
                  {intl.formatMessage({ id: "console.undockTitle" })}
                </DropdownMenuItem>
              ) : null}
              {running && !docked ? (
                <DropdownMenuItem onClick={() => onDockChange(true)}>
                  <SquareArrowDownLeft className="size-3.5" />
                  {intl.formatMessage({ id: "console.dockTitle" })}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onClick={() => onClone(profile)}>
                <Copy className="size-3.5" />
                {intl.formatMessage({ id: "console.menuClone" })}
              </DropdownMenuItem>
              {/* [OmniCode] 实例元数据批次：卡片管理钮区「重命名」（弹窗校验 + 桥热更新在 main） */}
              {onRename ? (
                <DropdownMenuItem
                  onClick={() => {
                    setRenameDraft(profile.name);
                    setRenameOpen(true);
                  }}
                >
                  <Pencil className="size-3.5" />
                  {intl.formatMessage({ id: "console.menuRename" })}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onClick={() => onRevealDataDir(profile)}>
                <FolderOpen className="size-3.5" />
                {intl.formatMessage({ id: "console.menuRevealDataDir" })}
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={() => onRemove(profile)}>
                <Trash2 className="size-3.5" />
                {intl.formatMessage({ id: "settings.omnicodeProfiles.delete" })}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {/* 画面区：letterbox 预览（停靠时底图隐藏——真窗口精确盖满）/ 停止占位 /
          拖出监控模糊遮罩 / 停靠 resize 手柄 */}
      <div
        ref={registerScreenElement}
        style={enlarged ? undefined : { aspectRatio }}
        className={cn(
          // [OmniCode] omni.5 真机修复（F4-9）：画面区容器自持命名 hover 组（group/screen）
          // ——停止态启动/重启按钮的显示从"画面区中心"提升到"整个黑色画面区容器 hover"。
          "group/screen relative min-h-0 w-full overflow-hidden bg-black/90",
          enlarged ? "flex-1" : "",
        )}
      >
        {/* [OmniCode] 批次3 停靠重构（B 套件 a 隐藏底图）：停靠态不渲染 letterbox 底图
            ——真窗口精确盖满画面区=看起来就是预览窗口本身。帧数据仍供 aspect 冻结与
            letterbox 比例计算；实例侧缩略图 capturePage 走 WebContents（与本 img 渲染
            与否无关），X1 性能面板截图订阅不受影响。 */}
        {running && frame && !docked ? (
          <img
            src={`data:image/jpeg;base64,${frame.frame}`}
            alt=""
            draggable={false}
            className={cn(
              "absolute inset-0 size-full object-contain",
              !previewEnabled && "grayscale-[0.95] brightness-[0.45]",
            )}
          />
        ) : null}
        {running && !frame ? (
          <div className="absolute inset-0 flex items-center justify-center text-ui-xs text-foreground-subtlest">
            {intl.formatMessage({ id: "console.waitingFrame" })}
          </div>
        ) : null}
        {!running ? (
          // [OmniCode] omni.5 真机修复（F4-9）：启动按钮 hover 提升到整个画面区容器
          // （group-hover/screen）；wrapper pointer-events-none + 按钮恢复 auto——
          // 点击只落在按钮本体，画面区其余区域的事件（卡片双击放大等）不受影响。
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 opacity-0 transition-opacity duration-200 group-hover/screen:opacity-100 focus-within:opacity-100">
            <Button
              variant="outline"
              size="icon"
              className="pointer-events-auto size-12 rounded-full"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                onLaunch(profile);
              }}
              title={intl.formatMessage({ id: "settings.omnicodeProfiles.launch" })}
            >
              <Play className="size-5" />
            </Button>
            <p className="text-ui-xs text-foreground-subtlest">
              {intl.formatMessage({ id: "console.stoppedHint" })}
            </p>
          </div>
        ) : null}

        {/* [OmniCode] 批次3 停靠重构：拖出监控态 = 模糊遮罩（底图可见）+「收回」钮
            （遮罩 pointer-events:none，仅按钮可点；点击卡片其余区域聚焦真窗口） */}
        {!docked && running ? (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/40 backdrop-blur-md">
            <Monitor className="size-4 text-foreground-subtle" />
            <span className="text-ui-sm font-medium text-foreground">
              {intl.formatMessage({ id: "console.undockedOverlayTitle" })}
            </span>
            <span className="text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "console.undockedOverlayHint" })}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="pointer-events-auto mt-1"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                onDockChange(true);
              }}
            >
              <SquareArrowDownLeft className="size-3.5" />
              {intl.formatMessage({ id: "console.dockBackLabel" })}
            </Button>
          </div>
        ) : null}

        {/* [OmniCode] 批次3 停靠重构（B 套件 c）：停靠画面区四边 resize 手柄
            （6px 命中区；卡片权威调高→embedLayout 跟随→窗口实时贴合，160×96 下限
            由手柄数学 + main clamp + 实例侧校验三层保证）。批次3 终审修复 P1-2：
            main 下发矩形四边内缩 6px，窗口只盖画面区内区——本手柄带露出在窗口外沿
            可命中（此前窗口精确盖满，手柄 pointerdown 全部落到实例窗口）。 */}
        {resizeHandles}

        {/* 预览总开关关闭：角标（卡片停留最后一帧灰暗化；停靠态底图隐藏但真窗口即预览，
            角标仍提示订阅已停） */}
        {!previewEnabled && running ? (
          <span className="absolute right-2 top-2 rounded bg-black/80 px-1.5 py-0.5 text-ui-xs text-amber-500">
            {intl.formatMessage({ id: "console.previewOffBadge" })}
          </span>
        ) : null}
        {/* [OmniCode] 后台降载：停帧态角标（实例窗口不可见 → 帧生产暂停，卡片冻结在
            最后一帧；左上角标注与右侧「预览已关闭」角标互斥共存、不重叠） */}
        {framePaused && running && previewEnabled ? (
          <span className="absolute left-2 top-2 rounded bg-black/80 px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "console.previewPausedBadge" })}
          </span>
        ) : null}
      </div>

      {/* 底部：备注 / 登录态徽标（批次2.5 X2）/ 运行态。
          [OmniCode] 实例元数据批次：序号角标 "#N"（语言中立、克制的弱文本——seq 是
          默认排序依据，角标让排序结果可解释；无 seq 的旧档不显示）。 */}
      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-2 py-1 text-ui-xs text-foreground-subtlest">
        <span className="min-w-0 truncate">{notes || ""}</span>
        {typeof seq === "number" ? (
          <span className="shrink-0" title={`#${seq}`}>
            #{seq}
          </span>
        ) : null}
        <LoginHealthBadge running={running} loginHealth={profile.loginHealth} />
        <span className="shrink-0">
          {running
            ? intl.formatMessage(
                { id: "settings.omnicodeProfiles.running" },
                { pid: String(pid ?? "") },
              )
            : intl.formatMessage({ id: "settings.omnicodeProfiles.stopped" })}
        </span>
      </footer>
      {/* [OmniCode] 实例元数据批次：重命名弹窗（与新建弹窗同形态；校验在提交回调） */}
      {renameOpen && onRename ? (
        <RenameInstanceDialog
          initialName={renameDraft}
          creating={busy}
          onNameChange={setRenameDraft}
          onCancel={() => setRenameOpen(false)}
          onSubmit={() => {
            if (renameDraft.trim().length === 0) return;
            onRename(profile, renameDraft);
            setRenameOpen(false);
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * [OmniCode] 批次2.5 X2：登录态健康度徽标（spec: docs/omnicode/console-extras.md §X2）。
 * 语义色：healthy=绿（停止实例但登录健康=黄——"仅剩登录态"，X4 状态色统一）、
 * expiring=黄、expired=红、unknown=灰；title 提示精确剩余时间（天+小时）。
 * [OmniCode] 批次3 UI 批次：导出供账号看板卡复用（同一四态口径，不重写）。
 */
export function LoginHealthBadge(props: {
  running: boolean;
  loginHealth?: OmnicodeLoginHealthInfo;
}) {
  const { intl } = useZCodeIntl();
  const { running, loginHealth } = props;
  const status = loginHealth?.status ?? "unknown";
  const tone =
    status === "healthy"
      ? running
        ? "text-emerald-500"
        : "text-amber-500" // 仅剩登录态（实例停止但登录态活着）
      : status === "expiring"
        ? "text-amber-500"
        : status === "expired"
          ? "text-red-500"
          : "text-foreground-subtlest";
  const label =
    status === "healthy" || status === "expiring"
      ? intl.formatMessage(
          { id: status === "healthy" ? "console.loginHealthyDays" : "console.loginExpiringDays" },
          { days: String(loginHealth?.daysRemaining ?? 0) },
        )
      : intl.formatMessage({
          id:
            status === "expired"
              ? "console.loginExpired"
              : // [OmniCode] omni.5 真机验收（bug2）：unknown 细分——凭据文件存在但读不出
                // （os: 旧密文/密钥缺失/解密失败）=「凭据状态未知」，不再伪装成「未登录」；
                // 缺省（无凭据文件/旧数据）保持「未登录」。
                loginHealth?.unknownReason === "unreadable"
                ? "console.loginStatusUnknown"
                : "console.loginUnknown",
        });
  const title =
    status === "healthy" || status === "expiring"
      ? formatLoginRemainingTitle(loginHealth, intl)
      : label;
  return (
    <span
      className={cn("flex shrink-0 items-center gap-1", tone)}
      title={title}
    >
      <span className="inline-block size-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

function formatLoginRemainingTitle(
  loginHealth: OmnicodeLoginHealthInfo | undefined,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
): string {
  const expiresAt = loginHealth?.expiresAt;
  if (expiresAt === undefined) return "";
  const remainingMs = expiresAt - Date.now();
  if (remainingMs <= 0) return intl.formatMessage({ id: "console.loginExpired" });
  const days = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
  const hours = Math.floor((remainingMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  return intl.formatMessage(
    { id: "console.loginRemainingTitle" },
    { days: String(days), hours: String(hours) },
  );
}

/** 新建实例弹窗（创建即启动：createOmnicodeProfile + launchOmnicodeProfile，对齐演示稿语义）。 */
export function CreateInstanceDialog(props: {
  newName: string;
  newNotes: string;
  creating: boolean;
  onNameChange: (value: string) => void;
  onNotesChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { intl } = useZCodeIntl();
  const { newName, newNotes, creating, onNameChange, onNotesChange, onCancel, onSubmit } = props;
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60"
      role="presentation"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-[min(400px,92vw)] rounded-xl border border-popover-border bg-popover p-5 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "console.newInstanceTitle" })}
        </h3>
        <p className="mt-1 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "console.newInstanceBody" })}
        </p>
        <div className="mt-4 flex flex-col gap-2">
          <Input
            autoFocus
            value={newName}
            onChange={(event) => onNameChange(event.target.value)}
            placeholder={intl.formatMessage({ id: "settings.omnicodeProfiles.namePlaceholder" })}
            disabled={creating}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSubmit();
            }}
          />
          <Input
            value={newNotes}
            onChange={(event) => onNotesChange(event.target.value)}
            placeholder={intl.formatMessage({ id: "settings.omnicodeProfiles.notesPlaceholder" })}
            disabled={creating}
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={creating}>
            {intl.formatMessage({ id: "console.dialogCancel" })}
          </Button>
          <Button size="sm" onClick={onSubmit} disabled={creating || newName.trim().length === 0}>
            {intl.formatMessage({ id: "console.createAndLaunch" })}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * [OmniCode] 实例元数据批次：重命名实例弹窗（卡片「更多」菜单与设置分区共用形态）。
 * 重名校验在提交回调（hook 客户端校验 + main 白名单双保险），空名提交钮禁用。
 */
export function RenameInstanceDialog(props: {
  initialName: string;
  creating: boolean;
  onNameChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { intl } = useZCodeIntl();
  const { initialName, creating, onNameChange, onCancel, onSubmit } = props;
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60"
      role="presentation"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-[min(400px,92vw)] rounded-xl border border-popover-border bg-popover p-5 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "console.renameTitle" })}
        </h3>
        <p className="mt-1 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "console.renameBody" })}
        </p>
        <div className="mt-4">
          <Input
            autoFocus
            value={initialName}
            onChange={(event) => onNameChange(event.target.value)}
            placeholder={intl.formatMessage({ id: "settings.omnicodeProfiles.namePlaceholder" })}
            disabled={creating}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSubmit();
              if (event.key === "Escape") onCancel();
            }}
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={creating}>
            {intl.formatMessage({ id: "console.dialogCancel" })}
          </Button>
          <Button size="sm" onClick={onSubmit} disabled={creating || initialName.trim().length === 0}>
            {intl.formatMessage({ id: "console.renameSave" })}
          </Button>
        </div>
      </div>
    </div>
  );
}
