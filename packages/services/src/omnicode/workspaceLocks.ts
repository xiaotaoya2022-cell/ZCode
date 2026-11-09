// [OmniCode] 工作区互斥锁：跨实例单写者保护（spec: docs/omnicode/profile-runtime.md §工作区互斥锁）。
// 事故依据（2026-11-10 实测）：同一工作区被两个实例同时打开 → 会话文件（工作区目录内的
// sess_*.zcode-session）投影不同步 + 并发追加撕裂。会话文件是单写者资源，锁按工作区路径划分。
//
// 锁文件：`${sharedRoot}/workspace-locks/<hash>.json`，hash = 工作区规范化路径的 sha256 前 16 位。
// 获取：fs "wx" 旗标（CREATE_NEW 原子语义）——"先读后写"不出现在流程里（spec §并发与竞态）。
// 自愈：heartbeatAt 超 LOCK_STALE_MS 或 pid 不存活 → 无主锁，读取时懒清理。
// 同实例（profileId 相同）的多个窗口不互斥：由单进程官方运行时自行串行（spec §决策 D3）。
import { existsSync, mkdirSync, readdirSync, closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import process from "node:process";

export interface WorkspaceLockEntry {
  workspacePath: string;
  profileId: string;
  pid: number;
  acquiredAt: string;
  heartbeatAt: number;
}

export interface WorkspaceLockOwner {
  profileId: string;
  pid: number;
  workspacePath: string;
}

const LOCKS_DIRNAME = "workspace-locks";
const LOCK_STALE_MS = 30_000;
const LOCK_HASH_LENGTH = 16;

export function getOmnicodeSharedRoot(): string {
  const override = process.env.OMNICODE_SHARED_ROOT?.trim();
  return override ? override : join(homedir(), ".omnicode", "shared");
}

export function getWorkspaceLockHash(workspacePath: string): string {
  // Windows 路径大小写不敏感：规范化 + 小写后哈希，保证同一工作区各实例算出同一把锁
  return createHash("sha256")
    .update(resolve(workspacePath).replace(/[\\/]+$/, "").toLowerCase())
    .digest("hex")
    .slice(0, LOCK_HASH_LENGTH);
}

function getLocksDir(): string {
  return resolve(join(getOmnicodeSharedRoot(), LOCKS_DIRNAME));
}

/** 路径围栏：锁文件名 = 合法 hex hash + ".json"，解析后必须落在 locks 目录内。 */
function getLockFilePath(lockHash: string): string {
  if (!/^[0-9a-f]{16}$/u.test(lockHash)) {
    throw new Error("[omnicode] 非法锁 hash");
  }
  const locksDir = getLocksDir();
  const lockPath = resolve(join(locksDir, lockHash + ".json"));
  if (!lockPath.startsWith(locksDir + sep)) {
    throw new Error("[omnicode] 锁路径越界");
  }
  return lockPath;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockEntry(lockPath: string): WorkspaceLockEntry | undefined {
  try {
    if (!existsSync(lockPath)) return undefined;
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as WorkspaceLockEntry;
    if (!parsed || typeof parsed.profileId !== "string" || typeof parsed.pid !== "number") {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function isLockStale(entry: WorkspaceLockEntry, now: number): boolean {
  if (now - entry.heartbeatAt > LOCK_STALE_MS) return true;
  return !isPidAlive(entry.pid);
}

/** 读锁（含无主锁懒清理）：stale 锁在读取时直接删除并视为未占用。 */
export function readWorkspaceLockOwner(workspacePath: string): WorkspaceLockOwner | undefined {
  const lockPath = getLockFilePath(getWorkspaceLockHash(workspacePath));
  const entry = readLockEntry(lockPath);
  if (!entry) return undefined;
  if (isLockStale(entry, Date.now())) {
    rmSync(lockPath, { force: true });
    return undefined;
  }
  return { profileId: entry.profileId, pid: entry.pid, workspacePath: entry.workspacePath };
}

export interface AcquireWorkspaceLockResult {
  ok: boolean;
  owner?: WorkspaceLockOwner;
}

/**
 * 原子获取工作区锁：`wx`（CREATE_NEW）保证并发下只有一个写者成功，
 * 判负方从返回值拿到占用方信息用于灰显（spec §并发与竞态）。
 */
export function acquireWorkspaceLock(
  workspacePath: string,
  profileId: string,
  pid: number,
): AcquireWorkspaceLockResult {
  const lockHash = getWorkspaceLockHash(workspacePath);
  const lockPath = getLockFilePath(lockHash);
  mkdirSync(getLocksDir(), { recursive: true });
  // 无主锁懒清理后立即尝试原子创建；清理与创建之间的竞争由 wx 原子性兜底
  const existing = readLockEntry(lockPath);
  if (existing && !isLockStale(existing, Date.now())) {
    return { ok: false, owner: { profileId: existing.profileId, pid: existing.pid, workspacePath: existing.workspacePath } };
  }
  if (existing) {
    rmSync(lockPath, { force: true });
  }
  const now = Date.now();
  const entry: WorkspaceLockEntry = {
    workspacePath: resolve(workspacePath),
    profileId,
    pid,
    acquiredAt: new Date(now).toISOString(),
    heartbeatAt: now,
  };
  try {
    const fd = openSync(lockPath, "wx");
    try {
      writeFileSync(fd, JSON.stringify(entry), "utf8");
    } finally {
      closeSync(fd);
    }
    return { ok: true };
  } catch {
    const owner = readLockEntry(lockPath);
    return {
      ok: false,
      owner: owner ? { profileId: owner.profileId, pid: owner.pid, workspacePath: owner.workspacePath } : undefined,
    };
  }
}

/** 心跳：仅当锁归属当前实例时续期。返回是否仍持有。 */
export function heartbeatWorkspaceLock(workspacePath: string, profileId: string, pid: number): boolean {
  const lockPath = getLockFilePath(getWorkspaceLockHash(workspacePath));
  const entry = readLockEntry(lockPath);
  if (!entry || entry.profileId !== profileId || entry.pid !== pid) return false;
  const updated: WorkspaceLockEntry = { ...entry, heartbeatAt: Date.now() };
  writeFileSync(lockPath, JSON.stringify(updated), "utf8");
  return true;
}

/** 释放：仅当锁归属当前实例时删除。 */
export function releaseWorkspaceLock(workspacePath: string, profileId: string, pid: number): void {
  const lockPath = getLockFilePath(getWorkspaceLockHash(workspacePath));
  const entry = readLockEntry(lockPath);
  if (!entry || entry.profileId !== profileId || entry.pid !== pid) return;
  rmSync(lockPath, { force: true });
}

/** 全量锁状态（供工作区列表装饰灰显）：key = 锁 hash。 */
export function listWorkspaceLocks(): Map<string, WorkspaceLockOwner> {
  const result = new Map<string, WorkspaceLockOwner>();
  const locksDir = getLocksDir();
  if (!existsSync(locksDir)) return result;
  const now = Date.now();
  for (const fileName of readdirSync(locksDir)) {
    if (!fileName.endsWith(".json")) continue;
    const lockHash = fileName.slice(0, -".json".length);
    if (!/^[0-9a-f]{16}$/u.test(lockHash)) continue;
    const lockPath = getLockFilePath(lockHash);
    const entry = readLockEntry(lockPath);
    if (!entry) continue;
    if (isLockStale(entry, now)) {
      rmSync(lockPath, { force: true });
      continue;
    }
    result.set(lockHash, { profileId: entry.profileId, pid: entry.pid, workspacePath: entry.workspacePath });
  }
  return result;
}
