/**
 * omnicode-workspace-governance 对外契约：调用方只能从这里导入。
 * 职责：跨实例工作区互斥锁 + 全实例共享工作区注册表 + Host 侧锁协调器装配。
 * spec: docs/omnicode/profile-runtime.md（工作区共享 / 互斥锁 / 并发与竞态 / 决策记录）。
 */
export {
  acquireWorkspaceLock,
  getOmnicodeSharedRoot,
  getWorkspaceLockHash,
  heartbeatWorkspaceLock,
  listWorkspaceLockDecorations,
  listWorkspaceLocks,
  readWorkspaceLockOwner,
  releaseWorkspaceLock,
} from "./workspaceLocks.js";
export type {
  AcquireWorkspaceLockResult,
  WorkspaceLockDecoration,
  WorkspaceLockEntry,
  WorkspaceLockOwner,
} from "./workspaceLocks.js";
export {
  diffMissingSharedWorkspaces,
  listSharedWorkspaces,
  normalizeWorkspacePath,
  upsertSharedWorkspaces,
} from "./sharedWorkspaces.js";
export type { SharedWorkspaceEntry } from "./sharedWorkspaces.js";
export { attachWorkspaceLockCoordinator } from "./workspaceLockCoordinator.js";
export type {
  WorkspaceLockCoordinator,
  WorkspaceLockCoordinatorOptions,
} from "./workspaceLockCoordinator.js";
