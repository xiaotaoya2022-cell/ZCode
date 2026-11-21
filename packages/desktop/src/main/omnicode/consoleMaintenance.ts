// [OmniCode] 新功能批次（2026-11-21 审计会话）：管理器维护面 IPC——工作区锁占用总览 +
// 凭据立即备份/打开备份目录 + 会话库体检/备份。全部只管理器进程装配（desktopProfileIpc
// 调用，实例进程在函数顶部整体 return），官方 flavor 零改动。
// 设计取舍：
// - 锁总览=listWorkspaceLocks 只读快照（过期锁读取时自愈删除，条目恒为活跃持有）；
// - 会话库体检只做 fs.stat（大小/mtime）+ 时间戳副本备份（copyFile）——不引 sqlite 依赖、
//   不打开数据库句柄（活动库 copy 有撕裂窗口，备份仅作"尽力而为快照"，UI 如实标注）；
// - 备份产物落在管理器共享根 session-db-backups/（与凭据备份 credential-backups/ 同款
//   目录约定），保留策略=最新 10 份（超出删除最旧，防无限增长）。
import { ipcMain, shell } from "electron";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PlatformChannels, type OmnicodeSessionDbStatus } from "@zcode/shared";
// 锁占用查询经 deps 注入（desktopProfileIpc 装配 @zcode/services/node 的
// listWorkspaceLocks）——本模块不直接依赖 services 包（与 takeoverCoordinator 同约定：
// omnicode-profile-runtime 模块不声明 services 依赖，桥命令/只读原语走装配注入）。
import { backupAllOmnicodeCredentials } from "./credentialBackups.js";
import { getOmnicodeConsoleDataBaseDir } from "./profileRuntime.js";

/** 会话库体检/备份保留策略。 */
const SESSION_DB_BACKUPS_KEEP = 10;

function resolveGlobalSessionDbPath(): string {
  // OmniCode 不动 HOME（会话正本全局共享的设计决定，见 session-sync-mechanism 调研）。
  return join(homedir(), ".zcode", "cli", "db", "db.sqlite");
}

function resolveSessionDbBackupsDir(): string {
  // 管理器共享根（与锁目录 ~/.omnicode/shared/workspace-locks 同根）。
  return join(homedir(), ".omnicode", "shared", "session-db-backups");
}

/** 打开"哪个实例的"备份目录：console 数据根（管理器自身），与凭据备份调度器同款锚点。 */
function resolveConsoleCredentialBackupsDir(): string {
  return join(getOmnicodeConsoleDataBaseDir(), ".zcode", "v2", "credential-backups");
}

async function readSessionDbStatus(): Promise<OmnicodeSessionDbStatus> {
  const dbPath = resolveGlobalSessionDbPath();
  const checkedAt = Date.now();
  try {
    const info = await stat(dbPath);
    if (!info.isFile()) {
      return { exists: false, sizeBytes: 0, modifiedAt: 0, checkedAt };
    }
    return { exists: true, sizeBytes: info.size, modifiedAt: info.mtimeMs, checkedAt };
  } catch {
    return { exists: false, sizeBytes: 0, modifiedAt: 0, checkedAt };
  }
}

/** 活动库的尽力而为快照（copy 原子性有限，备份用途可接受；UI 如实标注）。 */
async function backupSessionDbNow(): Promise<{ ok: boolean; backupPath: string; error?: string }> {
  const dbPath = resolveGlobalSessionDbPath();
  if (!existsSync(dbPath)) {
    return { ok: false, backupPath: "", error: "session-db-not-found" };
  }
  const backupsDir = resolveSessionDbBackupsDir();
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll("-", "").slice(0, 15);
  const target = join(backupsDir, `db-${stamp}.sqlite`);
  try {
    await mkdir(backupsDir, { recursive: true });
    await copyFile(dbPath, target);
    await pruneSessionDbBackups(backupsDir);
    return { ok: true, backupPath: target };
  } catch (error) {
    return { ok: false, backupPath: "", error: error instanceof Error ? error.message : String(error) };
  }
}

/** 保留最新 N 份（按文件名时间戳排序即按时间），超出删最旧；清理失败不阻塞备份结果。 */
async function pruneSessionDbBackups(backupsDir: string): Promise<void> {
  const entries = await readdir(backupsDir);
  const backups = entries.filter((name) => /^db-\d{8}T\d{6}\.sqlite$/.test(name)).sort();
  const excess = backups.slice(0, Math.max(0, backups.length - SESSION_DB_BACKUPS_KEEP));
  for (const name of excess) {
    await rm(join(backupsDir, name), { force: true });
  }
}

/**
 * 注册管理器维护面 IPC。幂等守卫与 desktopProfileIpc 其他分区一致（重复调用不重复注册）。
 */
let registered = false;
export interface OmnicodeConsoleMaintenanceDeps {
  listWorkspaceLocks: typeof import("@zcode/services/node").listWorkspaceLocks;
}

export function registerDesktopOmnicodeConsoleMaintenanceIpcHandlers(
  deps: OmnicodeConsoleMaintenanceDeps,
): void {
  if (registered) return;
  registered = true;

  // 锁占用总览（只读快照；排序=持有者显示名稳定序，UI 分组渲染）。
  ipcMain.handle(PlatformChannels.OmnicodeWorkspaceLocksList, () => {
    const locks = deps.listWorkspaceLocks();
    return [...locks.values()]
      .map((owner) => ({
        workspacePath: owner.workspacePath,
        profileId: owner.profileId,
        pid: owner.pid,
        ...(owner.displayName ? { displayName: owner.displayName } : {}),
      }))
      .sort(
        (a, b) =>
          (a.displayName ?? a.profileId).localeCompare(b.displayName ?? b.profileId) ||
          a.workspacePath.localeCompare(b.workspacePath),
      );
  });

  // 凭据立即备份（全 profile + console 根；聚合结果，永不抛错）。
  ipcMain.handle(PlatformChannels.OmnicodeCredentialBackupNow, async () => {
    const summary = await backupAllOmnicodeCredentials();
    return {
      ok: summary.failed.length === 0,
      backedUp: summary.backedUp.length + summary.unchanged.length,
      errors: summary.failed.slice(0, 5),
    };
  });

  // 打开 console 数据根的凭据备份目录（不存在时先建空目录再打开，避免 openPath 报错）。
  ipcMain.handle(PlatformChannels.OmnicodeCredentialBackupsOpen, async () => {
    const dir = resolveConsoleCredentialBackupsDir();
    await mkdir(dir, { recursive: true });
    const result = await shell.openPath(dir);
    return { ok: result === "" };
  });

  ipcMain.handle(PlatformChannels.OmnicodeSessionDbStatusGet, () => readSessionDbStatus());
  ipcMain.handle(PlatformChannels.OmnicodeSessionDbBackupNow, () => backupSessionDbNow());
}

/** 测试复位（进程内单测重复装配用）。 */
export function resetConsoleMaintenanceRegistrationForTest(): void {
  registered = false;
}
