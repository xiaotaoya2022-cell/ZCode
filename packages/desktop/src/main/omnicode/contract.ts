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
// [OmniCode] 模式二 R2（spec: docs/omnicode/multi-account-sessions.md §5）：附加账号目录
// 枚举 + 解密代理（管理器唯一解密权威；实例侧桥取请求入口）。
export { requestOmnicodeAccountMaterialFromManager } from "./instanceBridgeClient.js";
export type { OmnicodeAccountMaterialFetchReply } from "./instanceBridgeClient.js";
export {
  deriveOmnicodeBridgeAccountId,
  listOmnicodeBridgeAccounts,
  resolveOmnicodeBridgeAccountMaterial,
  resolveOmnicodeBridgeAccountSourceProfileId,
} from "./accountDirectory.js";
export type {
  OmnicodeBridgeAccountEntry,
  OmnicodeBridgeAccountMaterialResult,
} from "./accountDirectory.js";
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
// [OmniCode] 丙1 远程聚合 R3（spec: docs/omnicode/remote-aggregation.md §4/§5/§8-R3）：
// 跨实例桥转发——管理器侧目录/转投装配面（仅 desktopProfileIpc 的 managerHooks 消费；
// index.ts 的接线面与实例侧执行器直接模块导入，不经 contract 面）。
export {
  handleOmnicodeRemoteWorkspaceInstanceConnected,
  handleOmnicodeRemoteWorkspaceInstanceDisconnected,
  handleOmnicodeRemoteWorkspaceListUplink,
  setupOmnicodeRemoteForwardHost,
} from "./remoteForwardHost.js";
