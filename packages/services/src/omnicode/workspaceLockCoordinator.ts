// [OmniCode] 工作区锁协调器（Host 侧装配）：
// - 锁粒度集合化：本实例当前打开的全部本地工作区都持锁（不再只跟 lastActiveWorkspace
//   单活动 tab 走）。事实源 = settingService 新字段 `openLocalWorkspaces: string[]`
//   （renderer 的 persisting 窗口在 tab 集合变化时全量重写，见 useTabPersistence）；
//   协调器按"新集合 vs 已持锁集合"对账 diff：新增获取、消失释放（spec §工作区互斥锁）。
// - 每 10s 心跳覆盖集合内全部锁；获取判负（被其他实例占用）的工作区不阻断打开流程
//   （saveProject 锁下沉强制点兜底），转入竞争集合在心跳期重试——对方实例退出后自动接管；
// - 实例关闭/进程退出时清理自己持有的全部锁（30s 心跳超时 + pid 存活检查自愈兜底保留）；
// - 项目库变更时把本地项目根回流全实例共享工作区注册表（spec §工作区共享，D2 双向）；
// - 装配时把共享表缺失项 saveProject 进本实例项目库（新实例开箱自带全部工作区）。
//   该内部合并调用走原始 projectService（绕过 node.ts 的打开锁守卫）：登记进项目库
//   不是"打开工作区"，被占用的工作区也必须能进共享池开箱。
//
// 互斥语义（spec §决策 D3）：锁按工作区路径划分；同 profileId（含同实例多窗口）不互斥，
// 保持官方单实例语义——同实例内并发由官方运行时自行串行。
import type { AppSettings } from "@zcode/shared";
import type { ObservableSettingService } from "../setting/observableSettingService.js";
import {
  acquireWorkspaceLock,
  heartbeatWorkspaceLock,
  releaseWorkspaceLock,
} from "./workspaceLocks.js";
import { diffMissingSharedWorkspaces, normalizeWorkspacePath, upsertSharedWorkspaces } from "./sharedWorkspaces.js";

const HEARTBEAT_INTERVAL_MS = 10_000;

export interface WorkspaceLockCoordinatorOptions {
  settingService: ObservableSettingService;
  projectService: {
    saveProject: (input: { roots: string[]; reuseExistingRoot?: boolean }) => Promise<unknown>;
  };
  /** 本实例项目库中的本地项目根（与投影派生同源：projects.filter(!deleted).flatMap(roots)） */
  readLocalProjectPaths: () => Promise<string[]>;
  /** 当前实例身份（实例进程由 profileBootstrap 注入 OMNICODE_PROFILE_ID；默认实例为 "default"） */
  profileId: string;
  /**
   * [OmniCode] B2 评审修复（C5）：持有者实例显示名（profileBootstrap 注入
   * OMNICODE_PROFILE_NAME，与锁身份同源）——写入锁文件，锁提示展示实例名而非 profileId。
   * 缺省时锁文件不含该字段，消费方回退 profileId（老链路兼容）。
   */
  displayName?: string;
  /** 锁持有者 pid = Host 进程 pid：窗口/Host 退出 → 锁靠存活检查自愈 */
  pid: number;
  log?: (message: string, error?: unknown) => void;
}

export interface WorkspaceLockCoordinator {
  /** 项目库变更后调用：把本地项目根回流共享注册表 */
  syncSharedWorkspaces(): Promise<void>;
  dispose(): void;
}

/**
 * 打开集合读取：优先 `openLocalWorkspaces` 集合字段；旧 renderer 未写该字段时
 * 退回 `lastActiveWorkspace` 单活动工作区，保持既有锁行为（向后兼容）。
 */
function readOpenLocalWorkspacePaths(settings: AppSettings): string[] {
  const openSet = settings.openLocalWorkspaces;
  if (openSet) return [...openSet];
  const entry = settings.lastActiveWorkspace;
  return entry && entry.kind === "local" ? [entry.workspacePath] : [];
}

/**
 * 装配时的保守初始锁：只取 `lastActiveWorkspace` 单活动工作区（与集合化之前的旧行为一致）。
 * 不整集合取持久化 `openLocalWorkspaces`——它可能是上一窗口生命周期的残留快照，而
 * restoreSession=false 的窗口（如更新状态窗）永远不会有 renderer 写回来纠正，保守取值
 * 把陈旧锁暴露面限制在与旧行为完全相同的范围。全集锁由 renderer 首次写回后经集合对账补齐。
 * 旧 renderer（不带集合字段）的 lastActiveWorkspace 变更也退回同一单活动语义。
 */
function readLegacyActiveWorkspaceLockPaths(settings: AppSettings): string[] {
  const entry = settings.lastActiveWorkspace;
  return entry && entry.kind === "local" ? [entry.workspacePath] : [];
}

export function attachWorkspaceLockCoordinator(
  options: WorkspaceLockCoordinatorOptions,
): WorkspaceLockCoordinator {
  const { settingService, projectService, readLocalProjectPaths, profileId, displayName, pid } = options;
  const log = (message: string, error?: unknown): void => {
    if (error) console.warn(message, error);
    else console.warn(message);
  };
  /** 本实例当前持有的锁（规范化工作区路径）。 */
  const heldLockPaths = new Set<string>();
  /** 打开集合内但被其他实例占用的路径：心跳期重试获取，对方退出（锁自愈）后自动接管。 */
  const contendedLockPaths = new Set<string>();
  let disposed = false;

  function acquireHeldOrContended(path: string): void {
    let result: ReturnType<typeof acquireWorkspaceLock>;
    try {
      result = acquireWorkspaceLock(path, profileId, pid, displayName);
    } catch (error) {
      log("[omnicode] 获取工作区锁失败:", error);
      return;
    }
    if (result.ok || result.owner?.profileId === profileId) {
      // 拿到锁，或锁被同实例另一窗口持有（官方单实例语义，视为可用）
      contendedLockPaths.delete(path);
      heldLockPaths.add(path);
      return;
    }
    // 被其他实例持有：不阻断（saveProject 锁下沉强制点兜底拒绝），仅标记竞争 + 告警；
    // 灰显由 readTree 装饰（ownedBySelf=false）呈现，心跳期重试直至对方释放或本集合移除。
    if (!contendedLockPaths.has(path)) {
      log(
        `[omnicode] 工作区锁被占用: ${result.owner?.workspacePath ?? path}（实例 ${
          result.owner?.displayName ?? result.owner?.profileId ?? "unknown"
        }）`,
      );
    }
    contendedLockPaths.add(path);
  }

  /** 集合对账：新集合 vs 已持锁集合 → 释放消失项、获取新增项（幂等，可重复调用）。 */
  function reconcileOpenWorkspaces(openPaths: readonly string[]): void {
    if (disposed) return;
    const nextSet = new Set(
      openPaths
        .map((path) => normalizeWorkspacePath(path))
        .filter((path) => path.length > 0),
    );
    // 先收集 diff 再统一变更集合，避免遍历中增删
    const staleHeldPaths: string[] = [];
    for (const path of heldLockPaths) {
      if (!nextSet.has(path)) staleHeldPaths.push(path);
    }
    for (const path of staleHeldPaths) {
      heldLockPaths.delete(path);
      try {
        releaseWorkspaceLock(path, profileId, pid);
      } catch (error) {
        log("[omnicode] 释放工作区锁失败:", error);
      }
    }
    for (const path of contendedLockPaths) {
      if (!nextSet.has(path)) contendedLockPaths.delete(path);
    }
    const toAcquirePaths: string[] = [];
    for (const path of nextSet) {
      if (!heldLockPaths.has(path)) toAcquirePaths.push(path);
    }
    for (const path of toAcquirePaths) acquireHeldOrContended(path);
  }

  const unsubscribe = settingService.onDidUpdate((event) => {
    if (event.keys.includes("openLocalWorkspaces")) {
      // 集合对账：persisting 窗口每次持久化 patch 都带本实例打开的本地工作区全集
      void settingService
        .get()
        .then((settings) => reconcileOpenWorkspaces(readOpenLocalWorkspacePaths(settings)))
        .catch(() => undefined);
      return;
    }
    if (event.keys.includes("lastActiveWorkspace")) {
      // 旧 renderer 兼容：只写单活动工作区（无集合字段）时退回旧"换锁"语义，
      // 对账会释放集合外旧锁并获取新活动工作区，行为与集合化之前一致
      void settingService
        .get()
        .then((settings) => reconcileOpenWorkspaces(readLegacyActiveWorkspaceLockPaths(settings)))
        .catch(() => undefined);
    }
  });

  const heartbeatTimer = setInterval(() => {
    if (disposed) return;
    const lostHeldPaths: string[] = [];
    for (const path of heldLockPaths) {
      try {
        if (!heartbeatWorkspaceLock(path, profileId, pid)) {
          // 锁文件丢失或被改写（如被其他实例原子接管）：转入竞争集合，下一拍重取
          lostHeldPaths.push(path);
        }
      } catch (error) {
        log("[omnicode] 工作区锁心跳失败:", error);
      }
    }
    for (const path of lostHeldPaths) {
      heldLockPaths.delete(path);
      contendedLockPaths.add(path);
    }
    const retryContendedPaths: string[] = [];
    for (const path of contendedLockPaths) retryContendedPaths.push(path);
    for (const path of retryContendedPaths) acquireHeldOrContended(path);
  }, HEARTBEAT_INTERVAL_MS);
  // 不阻塞 Host 退出
  heartbeatTimer.unref?.();

  // 初始锁：装配时的单活动工作区（保守，见 readLegacyActiveWorkspaceLockPaths；
  // 收窄重启后持久化锁的启动竞态窗口）。全集锁等待 renderer 首次写回 openLocalWorkspaces。
  void settingService
    .get()
    .then((settings) => reconcileOpenWorkspaces(readLegacyActiveWorkspaceLockPaths(settings)))
    .catch(() => undefined);

  // 初始合并：共享表 → 本实例项目库（新实例开箱自带全部工作区，spec §工作区共享）
  void (async () => {
    try {
      const localPaths = await readLocalProjectPaths();
      const missing = diffMissingSharedWorkspaces(localPaths);
      if (missing.length === 0) return;
      for (const entry of missing) {
        await projectService.saveProject({ roots: [entry.path], reuseExistingRoot: true });
      }
      log(`[omnicode] 已从共享工作区表合并 ${missing.length} 个项目`);
    } catch (error) {
      log("[omnicode] 共享工作区合并失败:", error);
    }
  })();

  return {
    async syncSharedWorkspaces(): Promise<void> {
      if (disposed) return;
      try {
        const localPaths = await readLocalProjectPaths();
        if (localPaths.length > 0) upsertSharedWorkspaces(localPaths, profileId);
      } catch (error) {
        log("[omnicode] 共享工作区回流失败:", error);
      }
    },
    dispose(): void {
      disposed = true;
      unsubscribe();
      clearInterval(heartbeatTimer);
      // 清理本实例持有的全部锁；个别失败由 pid 存活检查自愈兜底
      const staleHeldPaths: string[] = [];
      for (const path of heldLockPaths) staleHeldPaths.push(path);
      for (const path of staleHeldPaths) {
        try {
          releaseWorkspaceLock(path, profileId, pid);
        } catch {
          // 进程退出路径：锁也会随 pid 存活检查自愈
        }
      }
      heldLockPaths.clear();
      contendedLockPaths.clear();
    },
  };
}
