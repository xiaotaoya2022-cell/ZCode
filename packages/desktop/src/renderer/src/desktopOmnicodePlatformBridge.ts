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
  onOmnicodeInstanceEvent: (
    handler: (payload: OmnicodeInstanceEventPayload) => void,
  ): (() => void) =>
    window.zcode.onOmnicodeInstanceEvent?.(handler) ?? (() => {}),
};
