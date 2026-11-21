// [OmniCode] D12 任务 B：About 窗口品牌化单测（spec: docs/omnicode/profile-runtime.md
// §omni.5 真机验收修复轮 F4 延伸 + 批次3 D12 任务 B）。
// - resolveAboutBrandForFlavor：omnicode → OmniCode 应用名 + omnicode 门洞标；
//   官方 flavor（production/preview）→ 官方 "ZCode Desktop App" + Z 标（逐字零改动）。
// - formatAboutCopyright / createSystemAboutPanelOptions：omnicode 版权行署名 OmniCode；
//   官方 flavor 版权行与官方完全一致。
// - createCustomAboutDialogHtml：logoVariant=omnicode 渲染门洞标 path + 白砖壳类；
//   缺省（官方）渲染官方 Z 标且 HTML 无 omnicode 类名。
import { describe, expect, it } from "vitest";
import {
  createAboutSnapshot,
  createSystemAboutPanelOptions,
  formatAboutCopyright,
  resolveAboutBrandForFlavor,
} from "../src/main/about.js";
import { createCustomAboutDialogHtml } from "../src/main/aboutWindow.js";

const SNAPSHOT = createAboutSnapshot({
  appVersion: "3.18.2-omni.1",
  buildMetadata: null,
  runtimeVersions: { electron: "44.7.0", chrome: "144.0.0", node: "24.0.0", v8: "13.0.0" },
  osInfo: {
    type: "Windows_NT",
    platform: "win32",
    release: "10.0.26300",
    version: "10.0.26300",
    arch: "x64",
    hostname: "test-host",
  },
});

describe("About 品牌门控 resolveAboutBrandForFlavor", () => {
  it("omnicode → OmniCode Desktop App + omnicode 标", () => {
    expect(resolveAboutBrandForFlavor("omnicode")).toEqual({
      applicationName: "OmniCode Desktop App",
      logoVariant: "omnicode",
    });
  });

  it("官方 flavor（production/preview/未知）→ ZCode Desktop App + Z 标", () => {
    expect(resolveAboutBrandForFlavor("production")).toEqual({
      applicationName: "ZCode Desktop App",
      logoVariant: "zcode",
    });
    expect(resolveAboutBrandForFlavor("preview")).toEqual({
      applicationName: "ZCode Desktop App",
      logoVariant: "zcode",
    });
    expect(resolveAboutBrandForFlavor("whatever")).toEqual({
      applicationName: "ZCode Desktop App",
      logoVariant: "zcode",
    });
  });
});

describe("About 版权行 formatAboutCopyright", () => {
  it("omnicode：中英双署名 OmniCode", () => {
    expect(formatAboutCopyright(2026, "zh-CN", "omnicode")).toBe("版权所有 © 2026 OmniCode。");
    expect(formatAboutCopyright(2026, "en-US", "omnicode")).toBe("Copyright © 2026 OmniCode.");
  });

  it("官方 flavor：与官方逐字一致（零改动铁律）", () => {
    expect(formatAboutCopyright(2026, "zh-CN", "production")).toBe("版权所有 © 2026 ZCode。");
    expect(formatAboutCopyright(2026, "en-US", "preview")).toBe("Copyright © 2026 ZCode.");
    // About 非中英 locale 回退英文（官方既有语义 + OmniCode 署名）
    expect(formatAboutCopyright(2026, "ja-JP", "omnicode")).toBe("Copyright © 2026 OmniCode.");
  });
});

describe("About 系统面板选项 createSystemAboutPanelOptions", () => {
  it("omnicode：应用名/版权 OmniCode，版本行结构不变", () => {
    const options = createSystemAboutPanelOptions(SNAPSHOT, 2026, "zh-CN", "omnicode");
    expect(options.applicationName).toBe("OmniCode Desktop App");
    expect(options.copyright).toBe("版权所有 © 2026 OmniCode。");
    expect(options.applicationVersion).toBe(`版本 ${SNAPSHOT.appVersion}`);
  });

  it("官方 flavor：applicationName 保持官方常量", () => {
    const options = createSystemAboutPanelOptions(SNAPSHOT, 2026, "zh-CN", "production");
    expect(options.applicationName).toBe("ZCode Desktop App");
    expect(options.copyright).toBe("版权所有 © 2026 ZCode。");
  });
});

describe("About 自绘窗口 createCustomAboutDialogHtml", () => {
  const baseInput = {
    applicationName: "OmniCode Desktop App",
    appVersion: "3.18.2-omni.1",
    copyright: "Copyright © 2026 OmniCode.",
    optimizationLine: "",
    versionLabel: "version",
    okButtonLabel: "OK",
  };

  it("logoVariant=omnicode：门洞标 path + 白砖壳类名 + 标题/版权入 HTML", () => {
    const html = createCustomAboutDialogHtml({ ...baseInput, logoVariant: "omnicode" });
    expect(html).toContain("app-icon--omnicode");
    // 门洞剪影 path（与 OmniCodeStartupLogo 同源 d 属性开头）
    expect(html).toContain("M 278 746 L 278 466");
    expect(html).not.toContain("M134.4 0.130152");
    expect(html).toContain("OmniCode Desktop App");
    expect(html).toContain("Copyright © 2026 OmniCode.");
  });

  it("缺省 logoVariant（官方）：Z 标 path、无 omnicode 壳类名", () => {
    const html = createCustomAboutDialogHtml({
      applicationName: "ZCode Desktop App",
      appVersion: "3.18.2",
      copyright: "Copyright © 2026 ZCode.",
      optimizationLine: "",
      versionLabel: "version",
      okButtonLabel: "OK",
    });
    expect(html).toContain("M134.4 0.130152");
    expect(html).not.toContain("app-icon--omnicode");
    expect(html).not.toContain("M 278 746 L 278 466");
  });
});
