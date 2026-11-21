// [OmniCode] 实例元数据批次：网格排序交互拆分（spec: docs/omnicode/profile-runtime.md
// §实例元数据）——从 ConsoleInstanceGrid 拆出以守住文件行数上限（source-size-policy），
// 逻辑与文案集中一处：拖拽换位 hook（custom 模式专属）+ 排序模式下拉。
// 数据/持久化链仍在 useOmnicodeConsoleInstances（sortMode/customOrder/applyCustomOrder）；
// 本文件只做交互编排。与既有交互的冲突裁决（任务红线）：
// - 停靠态画面区被真窗口覆盖 → 拖拽只认卡片 header（data-omnicode-drag-handle），画面区
//   不参与；header 上的按钮/输入由 closest("button, input, textarea, [role=menuitem]") 排除。
// - 桌面态点击 = 聚焦真窗口：位移 ≤ CARD_DRAG_THRESHOLD_PX = 普通 click（照常冒泡聚焦/
//   双击放大；长按不动不启动拖拽，点击语义优先）；> 阈值进入拖拽，dragJustCommitted
//   时间戳吞掉 pointerup 后紧随的 click（卡片 handleCardClick 250ms 窗口内直接返回），
//   不产生误聚焦/误换位后误聚焦。
// - resize 手柄在画面区四边（非 header），beginResize 自行 stopPropagation，与拖拽
//   启动判定互不影响。
// 落点语义（shared moveOmnicodeInstanceInCustomOrder）：指针位于目标卡上半区 = 插入其前
//（before）、下半区 = 插入其后（after）；拖拽中卡片保持原位、目标卡以 primary 上/下边线提示。
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownUp } from "lucide-react";
import type { OmnicodeInstanceSortMode } from "@zcode/shared";
import { OMNICODE_INSTANCE_SORT_MODES } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 拖拽启动阈值（CSS px）：与聚焦/双击放大的点击语义分界（见文件头裁决注释）。 */
const CARD_DRAG_THRESHOLD_PX = 6;

export interface OmnicodeCardDragState {
  dragId: string;
  targetId: string;
  position: "before" | "after";
}

/**
 * 卡片拖拽换位 hook（custom 排序模式专属）：网格容器挂 pointerdown 候选登记，window
 * 挂 move/up 生命周期（候选期阈值判定、激活期实时落点计算）。提交以最后一次 move 的
 * 落点为准；无落点（指针出网格）= 取消换位。提交经 ref 快照转发（commitRef），effect
 * 依赖最小化（不因排序数组变化重挂 listener）。
 * [OmniCode] omni.5 真机修复（F4-10）：额外暴露 dragActive/dragActiveId——拖拽激活但
 * 暂无合法落点时（指针在卡片间隙/网格外）被拖卡的抬升态仍可见，网格容器据
 * dragActive && !dragState 呈现"非合法落点"禁用态（cursor-not-allowed）。
 * @param cardElementsRef 卡片元素注册表（profileId → DOM；与网格 IntersectionObserver
 *   共用同一注册表，落点矩形按真实布局计算）。
 * @param commit 拖拽提交回调（hook 内不做顺序计算/持久化，归调用方 + shared 纯函数）。
 */
export function useOmnicodeCardDragSort(input: {
  sortMode: OmnicodeInstanceSortMode;
  cardElementsRef: { current: Map<string, HTMLElement> };
  commit: (dragId: string, targetId: string, position: "before" | "after") => void;
}) {
  const { sortMode, cardElementsRef } = input;
  const [dragState, setDragState] = useState<OmnicodeCardDragState | null>(null);
  const [dragActiveId, setDragActiveId] = useState<string | null>(null);
  const dragCandidateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    dragId: string;
  } | null>(null);
  const dragActiveRef = useRef(false);
  const dragLastTargetRef = useRef<OmnicodeCardDragState | null>(null);
  const dragCommitAtRef = useRef(0);

  const resolveDropTarget = useCallback(
    (clientX: number, clientY: number, dragId: string): OmnicodeCardDragState | null => {
      for (const [profileId, element] of cardElementsRef.current) {
        if (profileId === dragId) continue;
        const rect = element.getBoundingClientRect();
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          clientX < rect.left ||
          clientX > rect.right ||
          clientY < rect.top ||
          clientY > rect.bottom
        ) {
          continue;
        }
        return {
          dragId,
          targetId: profileId,
          position: clientY < rect.top + rect.height / 2 ? "before" : "after",
        };
      }
      return null;
    },
    [cardElementsRef],
  );

  /** 网格容器 pointerdown：登记拖拽候选（仅 custom 模式 + header 手柄 + 非按钮区）。 */
  const handleGridPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (sortMode !== "custom" || event.button !== 0) return;
      const target = event.target as HTMLElement;
      if (!target.closest("[data-omnicode-drag-handle]")) return;
      if (target.closest("button, input, textarea, [role='menuitem']")) return;
      const handle = target.closest("[data-omnicode-drag-handle]");
      const dragId = handle?.getAttribute("data-omnicode-drag-handle") ?? "";
      if (!dragId) return;
      dragCandidateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        dragId,
      };
    },
    [sortMode],
  );

  const commitRef = useRef(input.commit);
  commitRef.current = input.commit;
  useEffect(() => {
    const onMove = (moveEvent: PointerEvent) => {
      const candidate = dragCandidateRef.current;
      if (!candidate || moveEvent.pointerId !== candidate.pointerId) return;
      if (!dragActiveRef.current) {
        const distance = Math.hypot(
          moveEvent.clientX - candidate.startX,
          moveEvent.clientY - candidate.startY,
        );
        if (distance <= CARD_DRAG_THRESHOLD_PX) return;
        dragActiveRef.current = true;
        setDragActiveId(candidate.dragId);
        moveEvent.preventDefault();
      }
      moveEvent.preventDefault();
      const drop = resolveDropTarget(moveEvent.clientX, moveEvent.clientY, candidate.dragId);
      dragLastTargetRef.current = drop;
      setDragState(drop);
    };
    const onUp = () => {
      const candidate = dragCandidateRef.current;
      dragCandidateRef.current = null;
      if (!dragActiveRef.current) return;
      dragActiveRef.current = false;
      setDragActiveId(null);
      // 提交以最后一次 move 的落点为准；无落点（指针出网格）= 取消换位。
      const drop = dragLastTargetRef.current;
      dragLastTargetRef.current = null;
      setDragState(null);
      if (candidate && drop && drop.dragId === candidate.dragId) {
        commitRef.current(drop.dragId, drop.targetId, drop.position);
        // 吞掉紧随的 click（卡片 handleCardClick 读 dragJustCommitted）
        dragCommitAtRef.current = Date.now();
      }
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    // [OmniCode] omni.5（F4-10）：pointercancel（触控/系统打断）同样终止拖拽视觉态，
    // 否则被拖卡抬升态可能滞留（原逻辑只漏 ref，不漏 UI——现在视觉态也挂激活标志）。
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [resolveDropTarget]);

  return { dragState, dragActiveId, handleGridPointerDown, dragCommitAtRef };
}

/**
 * 排序模式下拉（网格工具行）：seq（默认）/ name / custom 三模式，持久化 console-ui.json
 *（写入经 setSortMode → OmnicodeConsoleUiStateSet）；切到 custom 时提示拖拽入口，
 * 其余模式拖拽手柄不渲染（禁用）。
 */
export function ConsoleSortModeDropdown(props: {
  sortMode: OmnicodeInstanceSortMode;
  disabled: boolean;
  onChange: (mode: OmnicodeInstanceSortMode) => void;
}) {
  const { intl } = useZCodeIntl();
  const { sortMode, disabled, onChange } = props;
  const modeLabel = (mode: OmnicodeInstanceSortMode): string =>
    intl.formatMessage({
      id:
        mode === "name"
          ? "console.sortModeName"
          : mode === "custom"
            ? "console.sortModeCustom"
            : "console.sortModeSeq",
    });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          title={intl.formatMessage({ id: "console.sortLabel" })}
        >
          <ArrowDownUp className="size-3.5" />
          {modeLabel(sortMode)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={sortMode}
          onValueChange={(value) => {
            const mode = value as OmnicodeInstanceSortMode;
            onChange(mode);
            if (mode === "custom") {
              toast(intl.formatMessage({ id: "console.sortCustomHint" }), { variant: "default" });
            }
          }}
        >
          {OMNICODE_INSTANCE_SORT_MODES.map((mode) => (
            <DropdownMenuRadioItem key={mode} value={mode}>
              {modeLabel(mode)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
