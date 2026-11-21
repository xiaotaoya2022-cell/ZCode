// macOS Electron locale whitelist and packaged-app guard.
//
// electron-builder matches electronLanguages against locale basenames. On macOS
// those are Electron Framework's *.lproj directories (en, zh_CN), not the
// Windows/Linux locales/*.pak names (en-US, zh-CN). A mismatch silently strips
// every lproj and Chromium's built-in strings (video controls menu) disappear.
import { existsSync } from "node:fs";
import { join } from "node:path";

// 打包瘦身轮（2026-11-21）：与 Windows/Linux 的 electronLanguages（en-US/zh-CN/ja-JP/
// ko-KR/ru-RU）及 UI locales 对齐。ja/ko/ru 用户的 Chromium 内建 UI 此前只会回落英文。
// 名字写错时 assertPackagedMacElectronLocales 会在打包阶段硬失败（不会静默删光语言包）。
export const MAC_ELECTRON_LANGUAGES = ["en", "zh_CN", "ja", "ko", "ru"];

export function resolveMacElectronFrameworkResourcesDir(appPath) {
  return join(appPath, "Contents", "Frameworks", "Electron Framework.framework", "Resources");
}

export function findMissingMacElectronLocales(
  frameworkResourcesDir,
  languages = MAC_ELECTRON_LANGUAGES,
) {
  return languages.filter(
    (language) => !existsSync(join(frameworkResourcesDir, `${language}.lproj`)),
  );
}
