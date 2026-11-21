import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("语言包白名单按各平台的文件名书写，macOS 不会把 lproj 全部删掉", async () => {
  vi.stubEnv("ZCODE_TARGET_OS", "darwin");
  const { default: config } = await import("../electron-builder.config.js");

  // Windows/Linux：locales/<name>.pak；与 UI locales（en-US/zh-CN/ja-JP/ko-KR/ru-RU）对齐。
  expect(config.electronLanguages).toEqual(["en-US", "zh-CN", "ja-JP", "ko-KR", "ru-RU"]);
  // macOS：Electron Framework.framework/Resources/<name>.lproj（同名集合的 lproj 拼写）
  expect(config.mac?.electronLanguages).toEqual(["en", "zh_CN", "ja", "ko", "ru"]);
});
