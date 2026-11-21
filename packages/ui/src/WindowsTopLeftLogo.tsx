import { cn } from "@/components/lib/utils.js";
import { BrandLogoBadge, resolveOmnicodeBrandFromLocation } from "@/root/RootStartupLoading.js";

export function WindowsTopLeftLogo({
  className,
  imageClassName,
}: {
  className?: string;
  imageClassName?: string;
}) {
  return (
    <div
      className={cn(
        // Logo 底座和外部占位统一为 20px，保留原中心点（27px / 29px）。
        "absolute left-1 top-1 mt-px ml-px z-20 flex h-12 items-center px-3 [app-region:drag]",
        className,
      )}
    >
      {/* [OmniCode] omni.5 真机修复（F4-11）：标题栏 logo 品牌门控（omnicode 域窗口 →
          OmniCode 徽标；官方 flavor → ZCode 徽标零改动）。aria-label/testid 语义跟随品牌。 */}
      <span
        role="img"
        aria-label={resolveOmnicodeBrandFromLocation() ? "OmniCode" : "ZCode"}
        data-testid="settings-logo"
        className={cn(
          "pointer-events-none flex size-5 items-center justify-center select-none",
          imageClassName,
        )}
      >
        <BrandLogoBadge size="titlebar" animated={false} />
      </span>
    </div>
  );
}
