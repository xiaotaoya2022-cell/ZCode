// [OmniCode] 工作区锁协调器（Host 侧装配）：
// - 把"工作区激活/切换"（settingService.update 含 lastActiveWorkspace）翻译成
//   锁的获取/换锁/释放（spec §工作区互斥锁）；
// - 每 10s 对持有中的工作区续心跳（窗口/Host 退出后锁靠 pid 存活检查自愈）；
// - 项目库变更时把本地项目根回流全实例共享工作区注册表（spec §工作区共享，D2 双向）；
// - 装配时把共享表缺失项 saveProject 进本实例项目库（新实例开箱自带全部工作区）。
//
// 互斥语义（spec §决策 D3）：锁按工作区路径划分；同 profileId（含同实例多窗口）不互斥，
// 保持官方单实例语义——同实例内并发由官方运行时自行串行。
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
  /** 锁持有者 pid = Host 进程 pid：窗口关闭 → Host 退出 → 锁靠存活检查自愈 */
  pid: number;
  log?: (message: string, error?: unknown) => void;
}

export interface WorkspaceLockCoordinator {
  /** 项目库变更后调用：把本地项目根回流共享注册表 */
  syncSharedWorkspaces(): Promise<void>;
  dispose(): void;
}

export function attachWorkspaceLockCoordinator(
  options: WorkspaceLockCoordinatorOptions,
): WorkspaceLockCoordinator {
  const { settingService, projectService, readLocalProjectPaths, profileId, pid } = options;
  const log = (message: string, error?: unknown): void => {
    if (error) console.warn(message, error);
    else console.warn(message);
  };
  let heldWorkspacePath: string | undefined;
  let disposed = false;

  function switchLock(nextPath: string | undefined): void {
    if (disposed) return;
    const previous = heldWorkspacePath;
    const nextNormalized = nextPath ? normalizeWorkspacePath(nextPath) : undefined;
    if (previous && nextNormalized !== normalizeWorkspacePath(previous)) {
      try {
        releaseWorkspaceLock(previous, profileId, pid);
      } catch (error) {
        log("[omnicode] 释放工作区锁失败:", error);
      }
    }
    if (!nextPath) {
      heldWorkspacePath = undefined;
      return;
    }
    const result = acquireWorkspaceLock(nextPath, profileId, pid);
    if (result.ok || result.owner?.profileId === profileId) {
      // 拿到锁，或锁被同实例另一窗口持有（官方单实例语义，视为可用）
      heldWorkspacePath = nextPath;
    } else {
      // 被其他实例持有：不阻断官方打开流程（正常路径下 UI 已灰显不可达），仅告警
      log(
        `[omnicode] 工作区锁被占用: ${result.owner?.workspacePath ?? nextPath}（实例 ${result.owner?.profileId ?? "unknown"}）`,
      );
      heldWorkspacePath = nextPath;
    }
  }

  const unsubscribe = settingService.onDidUpdate((event) => {
    if (!event.keys.includes("lastActiveWorkspace")) return;
    void settingService
      .get()
      .then((settings) => {
        const entry = settings.lastActiveWorkspace;
        switchLock(entry && entry.kind === "local" ? entry.workspacePath : undefined);
      })
      .catch(() => undefined);
  });

  const heartbeatTimer = setInterval(() => {
    if (disposed || !heldWorkspacePath) return;
    try {
      heartbeatWorkspaceLock(heldWorkspacePath, profileId, pid);
    } catch (error) {
      log("[omnicode] 工作区锁心跳失败:", error);
    }
  }, HEARTBEAT_INTERVAL_MS);
  // 不阻塞 Host 退出
  heartbeatTimer.unref?.();

  // 初始锁：装配时的 lastActiveWorkspace
  void settingService
    .get()
    .then((settings) => {
      const entry = settings.lastActiveWorkspace;
      if (entry && entry.kind === "local") switchLock(entry.workspacePath);
    })
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
      if (heldWorkspacePath) {
        try {
          releaseWorkspaceLock(heldWorkspacePath, profileId, pid);
        } catch {
          // 进程退出路径：锁也会随 pid 存活检查自愈
        }
      }
      heldWorkspacePath = undefined;
    },
  };
}
