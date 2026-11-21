// [OmniCode] 控制台主视图（批次2a 方案 A：控制台归位；批次2 B2-3 网格化重做）：
// OmniCode 主窗口永远呈现实例管理中枢——工具行（新建/内嵌-桌面模式切换/平铺/实时预览
// 开关）+ 实例卡片网格（真实宽高比 letterbox 预览、双击放大、内嵌 owned-window 跟随）
// + 旧控制台收养横幅 + 底栏（spec: docs/omnicode/profile-runtime.md §批次2 D9）。
// 控制台自身不是可干活的 ZCode 实例（方案 A 拍板）；工作与登录都在实例窗口内完成。
// [OmniCode] 批次3 UI 批次：头部加「账号看板」二视图切换（网格↔看板，视图态存内存——
// 管理器主语义=实例网格，看板是瞬时检视面，重启回落网格无需存储迁移）+ 账号看板视图
// （演示稿 01）+ 赛博鸡蛋左下浮层（演示稿 02，常驻于两视图之上，无蛋日不渲染）。
import { useEffect, useState } from "react";
import { Download, Globe, LayoutGrid, Settings, Users } from "lucide-react";
import { LOCALE_NATIVE_NAMES, SUPPORTED_LOCALES, type Locale } from "@zcode/shared";
import type { OmnicodeConsoleCredentialOsState } from "@zcode/shared";
import { TID_CONSOLE_SETTINGS_BUTTON, TID_LOCALE_TOGGLE } from "@zcode/shared/test-ids";
import { AccountDashboardView } from "@/console/AccountDashboard.js";
import { ConsoleInstanceGrid } from "@/console/ConsoleInstanceGrid.js";
import { EggClaimOverlay } from "@/console/EggClaimOverlay.js";
import { DesktopOverlayWindowControls } from "@/DesktopOverlayWindowControls.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { useOmnicodeConsoleAdoption } from "@/settings/ProfileMultiInstanceSection.js";

/** ConsoleHome 二视图（网格=实例管理中枢主视图；dashboard=账号看板检视视图）。 */
type ConsoleHomeView = "grid" | "dashboard";

export function ConsoleHome() {
  const { intl } = useZCodeIntl();
  // 视图态存内存（取舍见文件头注释）：切换钮触发 setState，重启回落网格。
  const [view, setView] = useState<ConsoleHomeView>("grid");
  return (
    <main className="relative flex h-full min-h-dvh flex-col overflow-hidden bg-background px-4 py-4 text-foreground sm:px-6">
      {/* 原生拖拽命中不受 pointer-events/z-index 约束；拖拽层必须避开窗控，且先于 no-drag 区声明。 */}
      <div className="pointer-events-none absolute left-0 top-0 right-0 z-10 flex h-12 items-center [app-region:drag] platform-windows-desktop:right-[134px] platform-linux-desktop:right-[134px]" />
      <DesktopOverlayWindowControls />

      <div className="relative z-10 mt-8 flex min-h-0 flex-1 flex-col gap-4">
        <div className="flex shrink-0 items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="text-ui-xl text-foreground">
              {intl.formatMessage({
                id: view === "dashboard" ? "console.dashboardTitle" : "console.homeTitle",
              })}
            </h1>
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({
                id: view === "dashboard" ? "console.dashboardSubtitle" : "console.homeSubtitle",
              })}
            </p>
          </div>
          {/* [OmniCode] 批次3 T1：管理器首屏此前没有任何语言/设置入口（语言切换只在设置页
              footer，而管理器永远不进设置页），用户观感"管理器不支持语言选择"。这里加最小
              的语言下拉；[app-region:no-drag] 保证按钮不被顶部拖拽层吃掉点击。 */}
          <div className="flex shrink-0 items-center gap-1 pt-1 [app-region:no-drag]">
            {/* [OmniCode] 批次3 UI 批次：网格↔看板二视图切换（图标钮 + 本地态） */}
            <ConsoleHomeViewToggle view={view} onChange={setView} />
            <ConsoleHomeLocaleSwitcher />
            {/* [OmniCode] 设置入口：打开窗口唯一的设置 tab；Root 侧早返回门禁对设置 tab
                放行，渲染进既有「无 workspace + settings tab」全屏设置页（候选 B）。 */}
            <ConsoleHomeSettingsButton />
          </div>
        </div>
        {/* [OmniCode] omni.5 真机修复（F2-5）：console 根 os: 旧密文不可恢复时的明确重登
            引导（非静默——此前该状态只体现在 oauth 全 FAIL，用户看不到任何提示）。 */}
        <ConsoleCredentialOsBanner />
        {view === "dashboard" ? <AccountDashboardView /> : null}
        {view === "grid" ? (
          <>
            <AdoptionBanner />
            <ConsoleInstanceGrid />
          </>
        ) : null}
      </div>
      {/* 赛博鸡蛋左下浮层（常驻：网格/看板两视图都可见；无蛋日整个不渲染） */}
      <EggClaimOverlay />
    </main>
  );
}

/**
 * [OmniCode] omni.5 真机修复（F2-5b）：console 根 os: 旧密文不可恢复状态的重登引导横幅
 * （unrecoverable 标记存在才渲染；迁移成功/无标记不渲染）。明确引导而非静默——
 * 此前该状态只体现为 oauth 全 FAIL，用户在管理器里看不到任何提示（bug1 观感）。
 */
function ConsoleCredentialOsBanner() {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [state, setState] = useState<OmnicodeConsoleCredentialOsState | null | undefined>(undefined);
  useEffect(() => {
    let disposed = false;
    void platform
      .getOmnicodeConsoleCredentialOsState?.()
      .then((result) => {
        if (!disposed) setState(result ?? null);
      })
      .catch(() => {
        if (!disposed) setState(null);
      });
    return () => {
      disposed = true;
    };
  }, [platform]);
  if (!state) return null;
  return (
    <div className="flex shrink-0 flex-col gap-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-amber-300">
      <b className="text-ui-sm font-bold">
        {intl.formatMessage({ id: "console.credentialOsUnrecoverableTitle" })}
      </b>
      <span className="text-ui-xs opacity-90">
        {intl.formatMessage({ id: "console.credentialOsUnrecoverableBody" })}
        {state.backedUp
          ? ` ${intl.formatMessage({ id: "console.credentialOsUnrecoverableBackedUp" })}`
          : ""}
      </span>
    </div>
  );
}

/**
 * [OmniCode] 批次3 UI 批次：网格↔账号看板二视图切换钮。图标钮循环切换（两态无歧义，
 * 无需下拉）；title/aria 跟随目标视图文案。
 */
function ConsoleHomeViewToggle(props: {
  view: ConsoleHomeView;
  onChange: (view: ConsoleHomeView) => void;
}) {
  const { intl } = useZCodeIntl();
  const { view, onChange } = props;
  const nextView: ConsoleHomeView = view === "grid" ? "dashboard" : "grid";
  const title = intl.formatMessage({
    id: view === "grid" ? "console.viewDashboardTitle" : "console.viewGridTitle",
  });
  return (
    <Button
      variant="ghost"
      size="icon-md"
      aria-label={title}
      title={title}
      data-testid="console-view-toggle"
      onClick={() => onChange(nextView)}
    >
      {view === "grid" ? <Users className="size-4" /> : <LayoutGrid className="size-4" />}
    </Button>
  );
}

/**
 * [OmniCode] 批次3 T1：管理器首屏语言切换下拉。复用 setLocalePreference（IntlProvider 的
 * 持久化 + 跨窗口 broadcast 通道，切换后本窗口文案立即生效、实例窗口跟随广播）。
 * 现成的 LocaleSwitcher 是单字符循环切换按钮（中/En/日…），5 语言可发现性差，不适合
 * 管理器头部；这里按调研授权做轻量下拉，语言项显示各语言本名（不随界面语言翻译）。
 */
function ConsoleHomeLocaleSwitcher() {
  const { intl, locale, setLocalePreference } = useZCodeIntl();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-md"
          data-testid={TID_LOCALE_TOGGLE}
          aria-label={intl.formatMessage({ id: "locale.switchLanguage" })}
          title={intl.formatMessage({ id: "locale.switchLanguage" })}
        >
          <Globe className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {/* 当前生效语言高亮（locale 为解析后的具体语言；"跟随系统"偏好解析出的语言同样高亮） */}
        <DropdownMenuRadioGroup
          value={locale}
          onValueChange={(value) => setLocalePreference(value as Locale)}
        >
          {SUPPORTED_LOCALES.map((item) => (
            <DropdownMenuRadioItem key={item} value={item} lang={item}>
              {LOCALE_NATIVE_NAMES[item]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * [OmniCode] 设置入口（批次3 候选 B）：齿轮钮 → tabStore.openSettingsTab()。
 * 与官方窗口同一条打开语义（tabStore.ts openSettingsTab：已有设置 tab 则激活，否则
 * 新建并激活）；文案复用既有 settings.title（zh「设置」/ en「Settings」）。
 */
function ConsoleHomeSettingsButton() {
  const { intl } = useZCodeIntl();
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  return (
    <Button
      variant="ghost"
      size="icon-md"
      data-testid={TID_CONSOLE_SETTINGS_BUTTON}
      aria-label={intl.formatMessage({ id: "settings.title" })}
      title={intl.formatMessage({ id: "settings.title" })}
      onClick={openSettingsTab}
    >
      <Settings className="size-4" />
    </Button>
  );
}

/**
 * [OmniCode] 批次2 B2-1（T5）旧控制台收养横幅复用（检测/确认/执行链不重写）：
 * available 仅当管理器数据根存在凭据且未被收养（main 侧判定）；收养后新实例
 * 由 ConsoleInstanceGrid 的实例事件订阅自动出现在网格。
 */
function AdoptionBanner() {
  const { intl } = useZCodeIntl();
  const adoption = useOmnicodeConsoleAdoption();
  if (!adoption.available) return null;
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 rounded-md border border-dashed border-border px-3 py-2">
      <span className="min-w-0 text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "console.adoptionTitle" })}
      </span>
      <Button variant="outline" size="sm" onClick={adoption.adopt} disabled={adoption.busy}>
        <Download className="size-3.5" />
        {intl.formatMessage({ id: "console.adoptionAction" })}
      </Button>
    </div>
  );
}
