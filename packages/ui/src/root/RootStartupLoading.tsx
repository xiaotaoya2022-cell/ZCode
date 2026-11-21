import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";

interface RootStartupLoadingProps {
  label: string;
  children?: ReactNode;
  busy?: boolean;
}

export function RootStartupLoading({ label, children, busy = true }: RootStartupLoadingProps) {
  return (
    <div
      // Web 端全局 html/body/#root 为 Electron 透明背景让路，React 接管后会替换 HTML 启动壳。
      // 这里必须由阻塞态自身承接主题背景，否则远控链接会在 Root 恢复期间继续露出浏览器白底。
      className="flex h-full min-h-dvh flex-col items-center justify-center gap-6 bg-background text-foreground"
      role="status"
      aria-busy={busy}
      aria-label={label}
      data-testid="root-startup-loading"
    >
      {/* [OmniCode] omni.5 真机修复（F4-11）：品牌门控徽标（omnicode 域=管理器+实例 →
          OmniCode；官方 flavor → 官方 ZCode 徽标零改动）。 */}
      <BrandLogoBadge />
      {children}
    </div>
  );
}

/** 初始化与引导共用品牌图标，保持底色、描边、圆角和标志比例一致。 */
export function ZCodeStartupLogoBadge({
  animated = true,
  size = "default",
}: {
  animated?: boolean;
  size?: "default" | "titlebar";
}) {
  return (
    <div
      data-desktop-logo-badge={size === "titlebar" ? "true" : undefined}
      className={cn(
        "relative flex items-center justify-center bg-[linear-gradient(180deg,#000000_0%,#151718_100%)] text-[#ffffff] before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:border before:border-[rgba(255,255,255,0.1)] before:content-['']",
        size === "titlebar"
          ? "size-5 rounded shadow-sm/20 before:border-white/20"
          : "size-24 rounded-3xl shadow-xl/20",
      )}
    >
      {/* Button 会给 SVG 默认尺寸；紧凑 Logo 显式恢复自动高度，保持标志原始比例。 */}
      <ZCodeStartupLogo
        className={size === "titlebar" ? "size-auto w-3.25" : "h-auto w-14"}
        animated={animated}
      />
    </div>
  );
}

export function ZCodeStartupLogo({
  className,
  animated = true,
}: {
  className?: string;
  animated?: boolean;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="118"
      height="100"
      fill="none"
      viewBox="0 0 256 218"
      className={cn("shrink-0 text-current", className)}
      aria-hidden="true"
      focusable="false"
    >
      {animated ? (
        <animate
          attributeName="opacity"
          begin="3s"
          dur="1.8s"
          repeatCount="indefinite"
          values="1;0.4;1"
        />
      ) : null}
      <path
        fill="currentColor"
        d="M134.4 0.130152L116.48 25.6022C113.665 29.5699 109.054 32.0019 104.064 32.0019H6.3999V0C6.3999 0.130149 134.4 0.130152 134.4 0.130152Z"
      />
      <path fill="currentColor" d="M256 0.130127L102.401 217.732H0L153.599 0.130127H256Z" />
      <path
        fill="currentColor"
        d="M121.601 217.732L139.65 192.134C142.465 188.166 147.076 185.734 152.067 185.734H249.604V217.736H121.601V217.732Z"
      />
    </svg>
  );
}

// ─── [OmniCode] omni.5 真机修复（F4-11）：OmniCode 品牌徽标 + 实例/管理器门控选择器 ───
// 矢量原源 scripts/omnicode/assets/omnicode_concept_01.svg（白圆角方砖 + 黑色门洞剪影，
// render-logo.py 的几何转录同源）。徽标=白砖承载黑色剪影，与官方 Z 徽标（深色壳+白 Z）
// 呈镜像观感；描边保证浅色标题栏下的白砖可辨识。

/**
 * OmniCode 门洞剪影（仅黑色剪影，不含白砖——白砖由徽标容器承载）。
 * viewBox 取剪影包围盒（x 278..746 / y 270..746），fill=currentColor 便于容器配色。
 */
export function OmniCodeStartupLogo({
  className,
  animated = true,
}: {
  className?: string;
  animated?: boolean;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="468"
      height="476"
      fill="none"
      viewBox="278 270 468 476"
      className={cn("shrink-0 text-current", className)}
      aria-hidden="true"
      focusable="false"
    >
      {animated ? (
        <animate
          attributeName="opacity"
          begin="3s"
          dur="1.8s"
          repeatCount="indefinite"
          values="1;0.4;1"
        />
      ) : null}
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M 278 746 L 278 466 Q 278 386 348 352 L 512 270 L 676 352 Q 746 386 746 466 L 746 746 L 590 746 L 590 466 Q 590 430 554 430 L 470 430 Q 434 430 434 466 L 434 746 Z"
      />
    </svg>
  );
}

/** OmniCode 徽标（白圆角方砖 + 黑色剪影；尺寸节奏与 ZCodeStartupLogoBadge 一致）。 */
export function OmniCodeStartupLogoBadge({
  animated = true,
  size = "default",
}: {
  animated?: boolean;
  size?: "default" | "titlebar";
}) {
  return (
    <div
      data-desktop-logo-badge={size === "titlebar" ? "true" : undefined}
      className={cn(
        "relative flex items-center justify-center bg-[#ffffff] text-[#080808] before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:border before:border-black/10 before:content-['']",
        size === "titlebar"
          ? "size-5 rounded shadow-sm/20"
          : "size-24 rounded-3xl shadow-xl/20",
      )}
    >
      <OmniCodeStartupLogo
        className={size === "titlebar" ? "size-auto w-3.5" : "h-auto w-13"}
        animated={animated}
      />
    </div>
  );
}

/**
 * 品牌门控（F4-11）：omnicode 域窗口（管理器 + Profile 实例）渲染 OmniCode 徽标；
 * 独立运行的官方 flavor 保持 ZCode 徽标零改动。判据=loadWindow 注入的 omnicodeBrand
 * query（main 侧按 flavor==="omnicode" ∨ OMNICODE_PROFILE_ID 注入，与
 * isOmnicodeProfileInstanceEnv 同语义族；实例 renderer 可能不带 flavor 字段但带实例
 * env——query 参数由 main 统一计算，renderer 不自行判 flavor 字符串）。
 */
export function resolveOmnicodeBrandFromLocation(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("omnicodeBrand") === "1";
  } catch {
    return false;
  }
}

/** 品牌门控徽标：omnicode 域 → OmniCode 徽标；官方 → 官方 ZCode 徽标（逐行原语义）。 */
export function BrandLogoBadge({
  animated = true,
  size = "default",
}: {
  animated?: boolean;
  size?: "default" | "titlebar";
}) {
  if (resolveOmnicodeBrandFromLocation()) {
    return <OmniCodeStartupLogoBadge animated={animated} size={size} />;
  }
  return <ZCodeStartupLogoBadge animated={animated} size={size} />;
}
