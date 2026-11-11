// [OmniCode] 控制台主视图（批次2a，方案 A：控制台归位）：OmniCode 主窗口永远呈现
// 实例管理中枢——不管主实例登录与否。控制台自身不是可干活的 ZCode 实例（方案 A
// 拍板），登录入口移除（各 Profile 实例在自己的窗口内登录，spec §方案 A）。
// 复用 ProfileMultiInstanceSection 全套能力（列表/实时缩略图/启动=重启/停止/克隆/
// 删除/平铺编排/还原）；工作区打开入口在控制台被 Root 层忽略（后续批次路由到实例）。
import { ProfileMultiInstanceSection } from "@/settings/ProfileMultiInstanceSection.js";
import { DesktopOverlayWindowControls } from "@/DesktopOverlayWindowControls.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function ConsoleHome() {
  const { intl } = useZCodeIntl();
  return (
    <main className="relative flex h-full min-h-dvh flex-col items-center overflow-y-auto overflow-x-hidden bg-background px-4 py-6 text-foreground sm:px-6">
      {/* 原生拖拽命中不受 pointer-events/z-index 约束；拖拽层必须避开窗控，且先于 no-drag 区声明。 */}
      <div className="pointer-events-none absolute left-0 top-0 right-0 z-10 flex h-12 items-center [app-region:drag] platform-windows-desktop:right-[134px] platform-linux-desktop:right-[134px]" />
      <DesktopOverlayWindowControls />

      <section className="relative z-10 mt-10 w-full max-w-4xl flex flex-col gap-4 rounded-2xl border border-popover-border bg-background p-6 shadow-md sm:p-10">
        <div className="flex flex-col gap-1">
          <h1 className="text-ui-xl text-foreground">
            {intl.formatMessage({ id: "console.homeTitle" })}
          </h1>
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "console.homeSubtitle" })}
          </p>
        </div>
        <ProfileMultiInstanceSection />
      </section>
    </main>
  );
}
