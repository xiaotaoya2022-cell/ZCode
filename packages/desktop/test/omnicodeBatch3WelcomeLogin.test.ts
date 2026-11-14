// [OmniCode] 批次3 R1-P2-4：resolveVisibleLoginProviders 纯函数单测（flavor 过滤分支 +
// 稳定优先级排序 + 显式 flavor 覆盖默认值）。该函数自 WelcomeScreen 抽离至
// packages/ui/src/loginVisibleProviders.ts（纯函数、零 @/ 依赖）；desktop 工程测试按既有
// 先例相对导入 ui 源码（参照 omnicodeReviewWorkspaceLock.test.ts 导入 ui/src/store/tabStore.js）。
import { describe, expect, it } from "vitest";
import { type OAuthProviderMeta, ZCODE_PRODUCT_FLAVOR } from "@zcode/shared";
import { resolveVisibleLoginProviders } from "../../ui/src/loginVisibleProviders.js";

function makeProvider(id: string, order = 0): OAuthProviderMeta {
  return { id, displayName: id, enabled: true, order };
}

describe("resolveVisibleLoginProviders", () => {
  it("omnicode flavor：过滤 zai_cn，且保持 zai→bigmodel→其余的稳定优先级排序", () => {
    const providers = [
      makeProvider("bigmodel", 0),
      makeProvider("zai_cn", 0),
      makeProvider("custom-b", 2),
      makeProvider("zai", 0),
      makeProvider("custom-a", 1),
    ];

    const visible = resolveVisibleLoginProviders(providers, { flavor: "omnicode" });

    expect(visible.map((provider) => provider.id)).toEqual([
      "zai",
      "bigmodel",
      "custom-a",
      "custom-b",
    ]);
  });

  it("官方 flavor（production / preview）：三按钮原样保留，不做过滤", () => {
    const providers = [
      makeProvider("zai_cn", 0),
      makeProvider("bigmodel", 0),
      makeProvider("zai", 0),
    ];

    for (const flavor of ["production", "preview"] as const) {
      const visible = resolveVisibleLoginProviders(providers, { flavor });
      expect(visible.map((provider) => provider.id)).toEqual(["zai", "bigmodel", "zai_cn"]);
    }
  });

  it("显式 options.flavor 覆盖编译期默认值（两种方向都验证）", () => {
    const providers = [makeProvider("zai_cn", 0), makeProvider("zai", 0)];

    if (ZCODE_PRODUCT_FLAVOR === "omnicode") {
      // 测试环境默认 omnicode 时：显式官方 flavor 必须能保留 zai_cn。
      expect(resolveVisibleLoginProviders(providers, { flavor: "production" }).map((p) => p.id)).toEqual([
        "zai",
        "zai_cn",
      ]);
    } else {
      // 测试环境默认官方 flavor 时：显式 omnicode 必须能过滤 zai_cn。
      expect(resolveVisibleLoginProviders(providers, { flavor: "omnicode" }).map((p) => p.id)).toEqual([
        "zai",
      ]);
    }
  });

  it("非内置 provider 按 10 + order 排序；空列表返回空数组", () => {
    const providers = [
      makeProvider("custom-late", 9),
      makeProvider("custom-early", 0),
      makeProvider("bigmodel", 0),
      makeProvider("zai", 0),
    ];

    expect(resolveVisibleLoginProviders(providers, { flavor: "production" }).map((p) => p.id)).toEqual([
      "zai",
      "bigmodel",
      "custom-early",
      "custom-late",
    ]);
    expect(resolveVisibleLoginProviders([], { flavor: "omnicode" })).toEqual([]);
  });

  it("不修改入参（返回新数组）", () => {
    const providers = [makeProvider("zai_cn", 0), makeProvider("zai", 0)];
    resolveVisibleLoginProviders(providers, { flavor: "omnicode" });
    expect(providers.map((provider) => provider.id)).toEqual(["zai_cn", "zai"]);
  });
});
