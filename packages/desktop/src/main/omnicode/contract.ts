/**
 * omnicode-profile-runtime 对外契约：调用方只能从这里导入（profileBootstrap 例外——
 * 它是 main 的最早副作用导入，已独立列在 architecture-policy.yaml publicEntrypoints）。
 * 职责：Profile 注册表 + 实例编排 + 身份引导。
 * spec: docs/omnicode/profile-runtime.md。
 */
export {
  assertValidProfileId,
  cloneOmnicodeProfile,
  createOmnicodeProfile,
  getOmnicodeProfileDir,
  getOmnicodeProfileRoot,
  listOmnicodeProfiles,
  removeOmnicodeProfile,
} from "./profileRuntime.js";
export type { OmnicodeProfileRecord, OmnicodeProfileSummary } from "./profileRuntime.js";
export {
  cleanupStaleHandoff,
  isOmnicodeProfileRunning,
  listOmnicodeRunningInstances,
  launchOmnicodeProfile,
  stopOmnicodeProfile,
} from "./instanceManager.js";
export type { OmnicodeRunningInstance } from "./instanceManager.js";
export {
  ensureOmnicodeInstanceBridgeServerStarted,
  getOmnicodeInstanceBridgeInfo,
  sendOmnicodeInstanceCommand,
  setOmnicodeInstanceThumbnailSubscription,
} from "./instanceBridgeServer.js";
export type {
  OmnicodeInstanceBridgeCommand,
  OmnicodeInstanceBridgeListeners,
} from "./instanceBridgeServer.js";
export { startOmnicodeInstanceBridgeClient } from "./instanceBridgeClient.js";
export { openOmnicodeInstanceAuthWindow } from "./instanceAuthWindow.js";
export type {
  OmnicodeInstanceAuthWindowLogger,
  OpenOmnicodeInstanceAuthWindowInput,
} from "./instanceAuthWindow.js";
