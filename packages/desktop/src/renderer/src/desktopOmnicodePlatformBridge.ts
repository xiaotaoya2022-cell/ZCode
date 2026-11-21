// [OmniCode] Profile 多实例的 window.zcode 委托（desktop-only 可选方法）。
// 与 desktopBrowserPlatformBridge 同一模式：desktopPlatform.ts 展开合入，
// IPlatformService 上这些方法为可选，缺席（Web/旧 preload）即无入口。
import type {
  OmnicodeAccountClaimEventPayload,
  OmnicodeAccountClaimRunRequest,
  OmnicodeAccountClaimRunResult,
  OmnicodeAccountDashboardSnapshot,
  OmnicodeAccountDetectRequest,
  OmnicodeAccountDetectResult,
  OmnicodeAccountSnapshotRequest,
  OmnicodeConsoleEmbedLayoutInput,
  OmnicodeConsolePreviewStateInput,
  OmnicodeConsoleUiState,
  OmnicodeConsoleUiStatePatch,
  OmnicodeInstanceEventPayload,
  OmnicodePerfEventPayload,
  OmnicodePerfPanelStateInput,
  OmnicodeProfileCloneInput,
  OmnicodeProfileCreateInput,
  OmnicodeProfileIdInput,
  OmnicodeProfileRenameInput,
  OmnicodeProfileSummaryInfo,
  OmnicodeConsoleCredentialOsState,
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
  // [OmniCode] 实例元数据批次：重命名（omni.5 真机验收修复——实例元数据批次落地时
  // preload/IPC/contract 三层齐全但此处桥漏装配，UI `platform.renameOmnicodeProfile!`
  // 触发 "not a function" TypeError；与 clone 同模式补齐映射）。
  renameOmnicodeProfile: (
    payload: OmnicodeProfileRenameInput,
  ): Promise<{ profile: OmnicodeProfileSummaryInfo }> =>
    requireBridge(window.zcode.renameOmnicodeProfile?.(payload)),
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
  // [OmniCode] 批次2 B2-3：控制台网格/内嵌/预览（spec §批次2 D9；缺席=官方 flavor
  // 或旧 preload——ConsoleHome 不渲染于官方 flavor，缺席面无消费方）。
  getOmnicodeConsoleUiState: (): Promise<OmnicodeConsoleUiState> =>
    window.zcode.getOmnicodeConsoleUiState?.() ??
    // [OmniCode] 批次3 停靠重构：缺省=全部停靠（旧全局 mode 字段已退役）
    Promise.resolve({ dockDefault: true, dockedByProfileId: {}, previewEnabled: true }),
  setOmnicodeConsoleUiState: (
    payload: OmnicodeConsoleUiStatePatch,
  ): Promise<OmnicodeConsoleUiState> =>
    requireBridge(window.zcode.setOmnicodeConsoleUiState?.(payload)),
  sendOmnicodeEmbedLayout: (
    payload: OmnicodeConsoleEmbedLayoutInput,
  ): Promise<{ ok: boolean; scale: number | null }> =>
    window.zcode.sendOmnicodeEmbedLayout?.(payload) ?? Promise.resolve({ ok: false, scale: null }),
  setOmnicodePreviewState: (
    payload: OmnicodeConsolePreviewStateInput,
  ): Promise<{ ok: boolean }> =>
    window.zcode.setOmnicodePreviewState?.(payload) ?? Promise.resolve({ ok: false }),
  revealOmnicodeProfileDataDir: (payload: OmnicodeProfileIdInput): Promise<{ ok: boolean }> =>
    window.zcode.revealOmnicodeProfileDataDir?.(payload) ?? Promise.resolve({ ok: false }),
  // [OmniCode] 批次2.5 X1：性能面板（spec: docs/omnicode/console-extras.md §X1；缺席=
  // 官方 flavor 或旧 preload——性能入口不渲染）
  setOmnicodePerfPanelState: (payload: OmnicodePerfPanelStateInput): Promise<{ ok: boolean }> =>
    window.zcode.setOmnicodePerfPanelState?.(payload) ?? Promise.resolve({ ok: false }),
  onOmnicodePerfEvent: (handler: (payload: OmnicodePerfEventPayload) => void): (() => void) =>
    window.zcode.onOmnicodePerfEvent?.(handler) ?? (() => {}),
  // [OmniCode] 批次3：登录态看板 / 赛博鸡蛋（数据层，spec:
  // F:\OmniCode\docs\batch3\BATCH3-DESIGN-DISCUSSION.md §2/§3；缺席=官方 flavor 或旧
  // preload——看板入口不渲染，调用面拒绝而非静默空数据）。
  getOmnicodeAccountSnapshot: (
    payload: OmnicodeAccountSnapshotRequest,
  ): Promise<OmnicodeAccountDashboardSnapshot> =>
    requireBridge(window.zcode.getOmnicodeAccountSnapshot?.(payload)),
  runOmnicodeAccountClaim: (
    payload: OmnicodeAccountClaimRunRequest,
  ): Promise<OmnicodeAccountClaimRunResult> =>
    requireBridge(window.zcode.runOmnicodeAccountClaim?.(payload)),
  onOmnicodeAccountClaimEvent: (
    handler: (payload: OmnicodeAccountClaimEventPayload) => void,
  ): (() => void) =>
    window.zcode.onOmnicodeAccountClaimEvent?.(handler) ?? (() => {}),
  // [OmniCode] 批次3 UI 批次：赛博鸡蛋检测（逐账号 preview，main 侧汇聚）
  getOmnicodeAccountDetect: (
    payload: OmnicodeAccountDetectRequest,
  ): Promise<OmnicodeAccountDetectResult> =>
    requireBridge(window.zcode.getOmnicodeAccountDetect?.(payload)),
  // [OmniCode] omni.5 真机修复（F2-5）：console 根 os: 旧密文迁移状态（无标记=null）
  getOmnicodeConsoleCredentialOsState: (): Promise<OmnicodeConsoleCredentialOsState | null> =>
    window.zcode.getOmnicodeConsoleCredentialOsState?.() ?? Promise.resolve(null),
};
