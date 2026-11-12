// [OmniCode] Profile 多实例的 window.zcode 委托（desktop-only 可选方法）。
// 与 desktopBrowserPlatformBridge 同一模式：desktopPlatform.ts 展开合入，
// IPlatformService 上这些方法为可选，缺席（Web/旧 preload）即无入口。
import type {
  OmnicodeInstanceEventPayload,
  OmnicodeProfileCloneInput,
  OmnicodeProfileCreateInput,
  OmnicodeProfileIdInput,
  OmnicodeProfileSummaryInfo,
} from "@zcode/shared";

function requireBridge<T>(result: Promise<T> | undefined): Promise<T> {
  if (!result) {
    return Promise.reject(new Error("omnicode.profile-bridge-unavailable"));
  }
  return result;
}

export const desktopOmnicodePlatformBridge = {
  listOmnicodeProfiles: (): Promise<{ profiles: OmnicodeProfileSummaryInfo[] }> =>
    window.zcode.listOmnicodeProfiles?.() ?? Promise.resolve({ profiles: [] }),
  createOmnicodeProfile: (
    payload: OmnicodeProfileCreateInput,
  ): Promise<{ profile: OmnicodeProfileSummaryInfo }> =>
    requireBridge(window.zcode.createOmnicodeProfile?.(payload)),
  removeOmnicodeProfile: (payload: OmnicodeProfileIdInput): Promise<{ ok: boolean }> =>
    requireBridge(window.zcode.removeOmnicodeProfile?.(payload)),
  cloneOmnicodeProfile: (
    payload: OmnicodeProfileCloneInput,
  ): Promise<{ profile: OmnicodeProfileSummaryInfo }> =>
    requireBridge(window.zcode.cloneOmnicodeProfile?.(payload)),
  launchOmnicodeProfile: (payload: OmnicodeProfileIdInput): Promise<{ pid: number }> =>
    requireBridge(window.zcode.launchOmnicodeProfile?.(payload)),
  stopOmnicodeProfile: (payload: OmnicodeProfileIdInput): Promise<{ ok: boolean }> =>
    requireBridge(window.zcode.stopOmnicodeProfile?.(payload)),
  focusOmnicodeProfile: (payload: OmnicodeProfileIdInput): Promise<{ ok: boolean }> =>
    requireBridge(window.zcode.focusOmnicodeProfile?.(payload)),
  // [OmniCode] M2 v1 平铺编排/还原（spec: docs/omnicode/profile-runtime.md §实时视窗）
  arrangeOmnicodeInstances: (): Promise<{ delivered: string[] }> =>
    requireBridge(window.zcode.arrangeOmnicodeInstances?.()),
  restoreOmnicodeInstances: (): Promise<{ delivered: string[] }> =>
    requireBridge(window.zcode.restoreOmnicodeInstances?.()),
  // [OmniCode] 批次2 B2-1（T5）：旧控制台收养（检测/执行；handler 仅管理器注册——
  // 实例 preload 不暴露这两个方法，兜底返回"不可收养"）。
  checkOmnicodeConsoleAdoption: (): Promise<{ available: boolean }> =>
    window.zcode.checkOmnicodeConsoleAdoption?.() ?? Promise.resolve({ available: false }),
  adoptOmnicodeConsole: (
    payload: { name: string },
  ): Promise<{ profile: OmnicodeProfileSummaryInfo }> =>
    requireBridge(window.zcode.adoptOmnicodeConsole?.(payload)),
  // [OmniCode] 失败态恢复入口：手动粘贴完整 OAuth 回调 URL（spec: docs/omnicode/instance-login-browser.md）。
  // 与 printPageToPdf 同模式：底层桥缺席（旧 preload）时保持 undefined——
  // IPlatformService 上为可选方法，UI 侧据此隐藏“高级恢复”入口，而非提交时报错。
  submitOmnicodeCallback: window.zcode.submitOmnicodeCallback
    ? (payload: { url: string }): Promise<{ ok: boolean; accepted: boolean }> =>
        requireBridge(window.zcode.submitOmnicodeCallback?.(payload))
    : undefined,
  onOmnicodeInstanceEvent: (
    handler: (payload: OmnicodeInstanceEventPayload) => void,
  ): (() => void) =>
    window.zcode.onOmnicodeInstanceEvent?.(handler) ?? (() => {}),
};
