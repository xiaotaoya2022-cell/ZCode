// [OmniCode] 控制台主视图（批次2a 方案 A：控制台归位；批次2 B2-3 网格化重做）：
// OmniCode 主窗口永远呈现实例管理中枢——工具行（新建/内嵌-桌面模式切换/平铺/实时预览
// 开关）+ 实例卡片网格（真实宽高比 letterbox 预览、双击放大、内嵌 owned-window 跟随）
// + 旧控制台收养横幅 + 底栏（spec: docs/omnicode/profile-runtime.md §批次2 D9）。
// 控制台自身不是可干活的 ZCode 实例（方案 A 拍板）；工作与登录都在实例窗口内完成。
import { Download } from "lucide-react";
import { ConsoleInstanceGrid } from "@/console/ConsoleInstanceGrid.js";
import { DesktopOverlayWindowControls } from "@/DesktopOverlayWindowControls.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOmnicodeConsoleAdoption } from "@/settings/ProfileMultiInstanceSection.js";

export function ConsoleHome() {
  const { intl } = useZCodeIntl();
  return (
    <main className="relative flex h-full min-h-dvh flex-col overflow-hidden bg-background px-4 py-4 text-foreground sm:px-6">
      {/* 原生拖拽命中不受 pointer-events/z-index 约束；拖拽层必须避开窗控，且先于 no-drag 区声明。 */}
      <div className="pointer-events-none absolute left-0 top-0 right-0 z-10 flex h-12 items-center [app-region:drag] platform-windows-desktop:right-[134px] platform-linux-desktop:right-[134px]" />
      <DesktopOverlayWindowControls />

      <div className="relative z-10 mt-8 flex min-h-0 flex-1 flex-col gap-4">
        <div className="flex shrink-0 flex-col gap-1">
          <h1 className="text-ui-xl text-foreground">
            {intl.formatMessage({ id: "console.homeTitle" })}
          </h1>
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "console.homeSubtitle" })}
          </p>
        </div>
        <AdoptionBanner />
        <ConsoleInstanceGrid />
      </div>
    </main>
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
