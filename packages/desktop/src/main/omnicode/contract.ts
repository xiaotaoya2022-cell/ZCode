/**
 * omnicode-profile-runtime 对外契约：调用方只能从这里导入（profileBootstrap 例外——
 * 它是 main 的最早副作用导入，已独立列在 architecture-policy.yaml publicEntrypoints）。
 * 职责：Profile 注册表 + 实例编排 + 身份引导。
 * spec: docs/omnicode/profile-runtime.md。
 */
export {
  assertValidProfileId,
  clearProfileLaunched,
  cloneOmnicodeProfile,
  createOmnicodeProfile,
  deriveOmnicodeProfileSeqBackfill,
  getOmnicodeConsoleDataBaseDir,
  getOmnicodeProfileDir,
  getOmnicodeProfileRecord,
  getOmnicodeProfileRoot,
  hasOmnicodeConsoleCredentials,
  isOmnicodeDataBaseDirAdopted,
  listOmnicodeProfiles,
  nextOmnicodeAdoptionProfileName,
  recordProfileLaunched,
  removeOmnicodeProfile,
  renameOmnicodeProfile,
  resolveOmnicodeConsoleAdoptionAvailable,
  resolveOmnicodeWorkspaceOpenRoute,
  adoptOmnicodeConsoleAsProfile,
} from "./profileRuntime.js";
export type {
  OmnicodeProfileRecord,
  OmnicodeProfileSummary,
  OmnicodeWorkspaceOpenRoute,
} from "./profileRuntime.js";
export {
  buildOmnicodeInstanceRelaunchArgs,
  isOmnicodeProfileRunning,
  listOmnicodeRunningInstances,
  launchOmnicodeProfile,
  reconcileOmnicodeRunningInstances,
  routeOmnicodeWorkspaceOpenFromManager,
  sendOmnicodeOpenWorkspace,
  sendOmnicodeInstanceRename,
  stopOmnicodeProfile,
  arrangeOmnicodeInstances,
  restoreOmnicodeInstances,
} from "./instanceManager.js";
export type { OmnicodeRunningInstance, OmnicodeWorkspaceRouteDeps } from "./instanceManager.js";
export { scanOmnicodeInstanceProcesses, readOmnicodeProcessMemoryMBs } from "./instanceReconcile.js";
export {
  ensureOmnicodeInstanceBridgeServerStarted,
  getOmnicodeConnectedInstanceProfileIds,
  getOmnicodeInstanceBridgeInfo,
  sendOmnicodeInstanceCommand,
  setOmnicodeInstanceThumbnailSubscription,
} from "./instanceBridgeServer.js";
export type {
  OmnicodeInstanceBridgeCommand,
  OmnicodeInstanceBridgeListeners,
} from "./instanceBridgeServer.js";
export {
  reportOmnicodeGlobalPrefsToManager,
  startOmnicodeInstanceBridgeClient,
} from "./instanceBridgeClient.js";
// [OmniCode] 批次4 单点下沉（spec: docs/omnicode/omnicode-shared-services.md §G3）：
// 管理器共享资产缓存 + 实例侧桥取请求（assetFetch 桥命令链的两侧入口）。
export {
  createOmnicodeSharedAssetsCache,
  resolveOmnicodeAssetsCacheRoot,
  sniffOmnicodeSharedAssetMime,
} from "./sharedAssetsCache.js";
export type { OmnicodeSharedAssetsCacheDeps } from "./sharedAssetsCache.js";
export { requestOmnicodeSharedAssetFromManager } from "./instanceBridgeClient.js";
export type { OmnicodeSharedAssetFetchReply } from "./instanceBridgeClient.js";
export {
  bindOmnicodeGlobalPrefsSourceInstanceId,
  getOmnicodeGlobalPrefsIdentity,
  handleOmnicodeGlobalPrefsReportFromInstance,
  initOmnicodeGlobalPrefsCoordinator,
  injectOmnicodeGlobalPrefsForSpawn,
  noteOmnicodeAppSettingsPatchForGlobalPrefs,
  noteOmnicodeRendererStateBroadcastForGlobalPrefs,
  pushOmnicodeGlobalPrefsSnapshotToInstance,
} from "./globalPrefs.js";
export type {
  OmnicodeGlobalPrefsCoordinatorDeps,
  OmnicodeGlobalPrefsIdentity,
} from "./globalPrefs.js";
export {
  backupAllOmnicodeCredentials,
  backupCredentialFile,
  startOmnicodeCredentialBackupScheduler,
  startOmnicodeInstanceSelfCredentialBackupScheduler,
} from "./credentialBackups.js";
export { openOmnicodeInstanceAuthWindow } from "./instanceAuthWindow.js";
export type {
  OmnicodeInstanceAuthWindowLogger,
  OpenOmnicodeInstanceAuthWindowInput,
} from "./instanceAuthWindow.js";
