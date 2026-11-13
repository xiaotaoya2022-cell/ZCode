// [OmniCode] 批次2 B2-3：控制台实例卡片 + 新建实例弹窗（spec: docs/omnicode/profile-runtime.md §批次2 D9）。
// 卡片结构对照演示稿：顶条（28-32px 管理器自绘控制钮区，内嵌模式下实例窗口贴下方画面区）+
// 画面区（letterbox 预览 / 停止占位 / 桌面模式模糊遮罩 / 预览关角标）+ 底部备注。
import { useEffect, useState } from "react";
import {
  Copy,
  FolderOpen,
  Maximize2,
  Monitor,
  MoreHorizontal,
  Play,
  Square,
  Trash2,
} from "lucide-react";
import type {
  OmnicodeConsoleUiState,
  OmnicodeLoginHealthInfo,
  OmnicodeProfileSummaryInfo,
} from "@zcode/shared";
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
  mode: OmnicodeConsoleUiState["mode"];
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
} & ConsoleInstanceCardActions) {
  const { intl } = useZCodeIntl();
  const {
    profile,
    frame,
    enlarged,
    focusHighlighted,
    registerScreen,
    registerCard,
    busy,
    mode,
    previewEnabled,
    onLaunch,
    onStop,
    onClone,
    onRemove,
    onRevealDataDir,
    onFocus,
    onToggleEnlarge,
  } = props;
  const { id, name, running, notes, pid } = profile;
  const frameAspectRatio =
    frame?.width && frame?.height && frame.width > 0 && frame.height > 0
      ? `${frame.width} / ${frame.height}`
      : String(DEFAULT_FRAME_ASPECT_RATIO);
  // [OmniCode] B2 评审修复（P2-7 内嵌尺寸反馈环）：内嵌下"帧尺寸→卡片画面区高（aspect）
  // →embedLayout 矩形→实例窗口 setBounds→下一帧尺寸"形成反馈环（微抖）。进入内嵌后
  // 冻结首次收到的帧比例（embedLayout 生效前的自然基线，反馈环无起点）；桌面模式恢复
  // 动态（真窗口不贴卡片，无环）。
  const [embeddedAspectRatio, setEmbeddedAspectRatio] = useState<string | null>(null);
  useEffect(() => {
    if (mode !== "embedded") {
      setEmbeddedAspectRatio(null); // 桌面态恢复动态比例
      return;
    }
    if (embeddedAspectRatio === null && frame?.width && frame?.height && frame.width > 0 && frame.height > 0) {
      setEmbeddedAspectRatio(`${frame.width} / ${frame.height}`);
    }
  }, [mode, frame, embeddedAspectRatio]);
  const aspectRatio = mode === "embedded" ? (embeddedAspectRatio ?? String(DEFAULT_FRAME_ASPECT_RATIO)) : frameAspectRatio;

  const handleCardClick = () => {
    // 桌面模式：点击卡片 = 聚焦真窗口（内嵌模式的画面区被真窗口覆盖，点击到不了这里）
    if (mode === "desktop" && running) onFocus(profile);
  };

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
        mode === "desktop" && running && "cursor-pointer",
        focusHighlighted && "border-primary ring-1 ring-primary",
        enlarged && "h-full",
      )}
    >
      {/* 顶条（28-32px：内嵌模式下管理器自绘控制钮区，实例窗口贴下方画面区） */}
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2">
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
              {running ? (
                <DropdownMenuItem onClick={() => onFocus(profile)}>
                  <Monitor className="size-3.5" />
                  {intl.formatMessage({ id: "settings.omnicodeProfiles.focus" })}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onClick={() => onClone(profile)}>
                <Copy className="size-3.5" />
                {intl.formatMessage({ id: "console.menuClone" })}
              </DropdownMenuItem>
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

      {/* 画面区：letterbox 预览（内嵌模式被真窗口覆盖）/ 停止占位 / 桌面模式模糊遮罩 */}
      <div
        ref={(element) => registerScreen(id, element)}
        style={enlarged ? undefined : { aspectRatio }}
        className={cn(
          "relative min-h-0 w-full overflow-hidden bg-black/90",
          enlarged ? "flex-1" : "",
        )}
      >
        {running && frame ? (
          <img
            src={`data:image/jpeg;base64,${frame.frame}`}
            alt=""
            draggable={false}
            className={cn(
              "absolute inset-0 size-full object-contain",
              !previewEnabled && "grayscale-[0.95] brightness-[0.45]",
            )}
          />
        ) : running ? (
          <div className="absolute inset-0 flex items-center justify-center text-ui-xs text-foreground-subtlest">
            {intl.formatMessage({ id: "console.waitingFrame" })}
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <Button
              variant="outline"
              size="icon"
              className="size-12 rounded-full"
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
        )}

        {/* 桌面模式：模糊遮罩 + 不可交互（遮罩 pointer-events:none，点击穿透到卡片聚焦） */}
        {mode === "desktop" && running ? (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/40 backdrop-blur-md">
            <Monitor className="size-4 text-foreground-subtle" />
            <span className="text-ui-sm font-medium text-foreground">
              {intl.formatMessage({ id: "console.desktopOverlayTitle" })}
            </span>
            <span className="text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "console.desktopOverlayHint" })}
            </span>
          </div>
        ) : null}

        {/* 预览总开关关闭：角标（卡片停留最后一帧灰暗化） */}
        {!previewEnabled && running ? (
          <span className="absolute right-2 top-2 rounded bg-black/80 px-1.5 py-0.5 text-ui-xs text-amber-500">
            {intl.formatMessage({ id: "console.previewOffBadge" })}
          </span>
        ) : null}
      </div>

      {/* 底部：备注 / 登录态徽标（批次2.5 X2）/ 运行态 */}
      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-2 py-1 text-ui-xs text-foreground-subtlest">
        <span className="min-w-0 truncate">{notes || ""}</span>
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
    </section>
  );
}

/**
 * [OmniCode] 批次2.5 X2：登录态健康度徽标（spec: docs/omnicode/console-extras.md §X2）。
 * 语义色：healthy=绿（停止实例但登录健康=黄——"仅剩登录态"，X4 状态色统一）、
 * expiring=黄、expired=红、unknown=灰；title 提示精确剩余时间（天+小时）。
 */
function LoginHealthBadge(props: {
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
