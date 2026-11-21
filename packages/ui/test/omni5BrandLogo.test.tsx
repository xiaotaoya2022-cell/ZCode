// [OmniCode] omni.5 真机修复（F4-11）单测：品牌门控徽标（BrandLogoBadge）——
// omnicode 域窗口（loadWindow 注入 omnicodeBrand=1）渲染 OmniCode 白砖黑标；
// 官方 flavor（无注入）渲染官方 ZCode 徽标（逐行原语义）。SSR renderToStaticMarkup
// 断言两类徽标的容器类名互斥（白砖 vs 深色渐变壳）。
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrandLogoBadge, resolveOmnicodeBrandFromLocation } from "@/root/RootStartupLoading.js";

function stubLocation(search: string): void {
  vi.stubGlobal("window", { location: { search } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("omni.5 F4-11: resolveOmnicodeBrandFromLocation", () => {
  it("omnicodeBrand=1 → OmniCode 域；缺省/其他值 → 官方", () => {
    stubLocation("?omnicodeBrand=1");
    expect(resolveOmnicodeBrandFromLocation()).toBe(true);
    stubLocation("?omnicodeBrand=0");
    expect(resolveOmnicodeBrandFromLocation()).toBe(false);
    stubLocation("");
    expect(resolveOmnicodeBrandFromLocation()).toBe(false);
  });

  it("window 缺席（SSR/测试 node 环境）→ 官方（false，不抛错）", () => {
    vi.stubGlobal("window", undefined);
    expect(resolveOmnicodeBrandFromLocation()).toBe(false);
  });
});

describe("omni.5 F4-11: BrandLogoBadge 门控分支", () => {
  it("实例/管理器窗口（omnicodeBrand=1）→ OmniCode 白砖徽标（bg-[#ffffff]）", () => {
    stubLocation("?omnicodeBrand=1");
    const markup = renderToStaticMarkup(<BrandLogoBadge animated={false} />);
    expect(markup).toContain("bg-[#ffffff]");
    expect(markup).toContain("M 278 746");
    expect(markup).not.toContain("linear-gradient(180deg,#000000");
  });

  it("官方 flavor 窗口（无注入）→ 官方 ZCode 深壳徽标零改动", () => {
    stubLocation("");
    const markup = renderToStaticMarkup(<BrandLogoBadge animated={false} />);
    expect(markup).toContain("bg-[linear-gradient(180deg,#000000_0%,#151718_100%)]");
    expect(markup).toContain("M256 0.130127L102.401 217.732");
    expect(markup).not.toContain("bg-[#ffffff]");
  });

  it("titlebar 尺寸在两分支下保持 size-5 节奏", () => {
    stubLocation("?omnicodeBrand=1");
    expect(renderToStaticMarkup(<BrandLogoBadge animated={false} size="titlebar" />)).toContain(
      "size-5",
    );
    stubLocation("");
    expect(renderToStaticMarkup(<BrandLogoBadge animated={false} size="titlebar" />)).toContain(
      "size-5",
    );
  });
});
