// [OmniCode] 工作区互斥锁：跨实例单写者保护（spec: docs/omnicode/profile-runtime.md §工作区互斥锁）。
// 事故依据（2026-11-10 实测）：同一工作区被两个实例同时打开 → 会话文件（工作区目录内的
// sess_*.zcode-session）投影不同步 + 并发追加撕裂。会话文件是单写者资源，锁按工作区路径划分。
//
// 锁文件：`${sharedRoot}/workspace-locks/<hash>.json`，hash = 工作区规范化路径的 sha256 前 16 位。
// 获取：fs "wx" 旗标（CREATE_NEW 原子语义）——"先读后写"不出现在流程里（spec §并发与竞态）。
// 自愈：heartbeatAt 超 LOCK_STALE_MS 或 pid 不存活 → 无主锁，读取时懒清理。
// 同实例（profileId 相同）的多个窗口不互斥：由单进程官方运行时自行串行（spec §决策 D3）。
import { existsSync, mkdirSync, readdirSync, closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  /**
   * [OmniCode] B2 评审修复（C5）：持有者实例显示名（spawn 时已知，锁获取时写入）。
   * 老锁文件无此字段 → 消费方回退 profileId 展示（兼容）。
   */
  displayName?: string;
}

export interface WorkspaceLockOwner {
  profileId: string;
  pid: number;
  workspacePath: string;
  /** 持有者实例显示名；老锁文件缺省为 undefined（UI 回退 profileId）。 */
  displayName?: string;
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

/** 锁文件 displayName 字段的防御归一（trim + 限长，非法/空值丢弃为 undefined）。 */
function normalizeLockDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 120) return undefined;
  return trimmed;
}

function toLockOwner(entry: WorkspaceLockEntry): WorkspaceLockOwner {
  return {
    profileId: entry.profileId,
    pid: entry.pid,
    workspacePath: entry.workspacePath,
    ...(normalizeLockDisplayName(entry.displayName)
      ? { displayName: normalizeLockDisplayName(entry.displayName) }
      : {}),
  };
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
  return toLockOwner(entry);
}

/**
 * [OmniCode] 锁下沉结构化错误码：打开被其他实例占用的工作区时沿 RPC 抛出。
 * RPC 层对 Error 的 `code`/`data` 字段做 passthrough（packages/rpc/src/channelServer.ts），
 * renderer 可按码识别并以 owner 信息提示；message 自身也是用户可读文案。
 */
export const WORKSPACE_LOCKED_BY_OTHER_ERROR_CODE = "omnicode.workspace-locked-by-other" as const;

export interface WorkspaceLockedByOtherErrorData {
  workspacePath: string;
  profileId: string;
  pid: number;
  /** 持有者实例显示名（C5：锁提示显示实例名；老锁缺省 → UI 回退 profileId）。 */
  displayName?: string;
}

/**
 * [OmniCode] B2-2 打开守卫判定（纯函数，spec: docs/omnicode/profile-runtime.md §批次2 D8；
 * D11 修订：renderer 冲突处置改自动观察者——守卫本身不变，reject 仍是 omnicode 打开流
 * 的唯一守卫态，observer 态由 renderer 侧 resolveOmnicodeLockConflictOpenAction 自主决策）：
 * 输入某工作区的锁占用事实 + 本实例身份 + 是否请求观察者打开，输出打开决策——
 * - 无锁 / 自持（同 profileId，含同实例多窗口）→ open：正常打开，锁仍由协调器按打开集合对账获取；
 * - 被他实例持有 → reject：拒绝可写打开（saveProject 守卫抛结构化错误冒泡，UI 按冲突处置走观察者）；
 * - 被他实例持有且 observerRequested → observer：只读观察者打开（不获取锁、不进锁集合）。
 */
export type WorkspaceOpenGuardDecision =
  | { kind: "open" }
  | { kind: "reject"; owner: WorkspaceLockOwner }
  | { kind: "observer"; owner: WorkspaceLockOwner };

export function resolveWorkspaceOpenGuardDecision(input: {
  lockOwner: WorkspaceLockOwner | undefined;
  selfProfileId: string;
  observerRequested?: boolean;
}): WorkspaceOpenGuardDecision {
  const { lockOwner, selfProfileId, observerRequested } = input;
  if (!lockOwner || lockOwner.profileId === selfProfileId) return { kind: "open" };
  return observerRequested
    ? { kind: "observer", owner: lockOwner }
    : { kind: "reject", owner: lockOwner };
}

/**
 * 打开工作区前的强制查锁（B2-2：判定走 resolveWorkspaceOpenGuardDecision 单一事实源）。
 * 同 profileId（含同实例其他窗口）幂等放行；被其他实例占用即拒绝。
 */
export function assertWorkspaceNotLockedByOther(workspacePath: string, profileId: string): void {
  const decision = resolveWorkspaceOpenGuardDecision({
    lockOwner: readWorkspaceLockOwner(workspacePath),
    selfProfileId: profileId,
  });
  if (decision.kind !== "reject") return;
  const owner = decision.owner;
  const ownerLabel = owner.displayName ? `${owner.displayName}（${owner.profileId}）` : owner.profileId;
  const error = new Error(
    `该工作区正被另一个实例占用（${ownerLabel}），请先在那个实例里关闭它：${owner.workspacePath}`,
  ) as Error & { code: typeof WORKSPACE_LOCKED_BY_OTHER_ERROR_CODE; data: WorkspaceLockedByOtherErrorData };
  error.name = "WorkspaceLockedByOtherError";
  error.code = WORKSPACE_LOCKED_BY_OTHER_ERROR_CODE;
  error.data = {
    workspacePath: owner.workspacePath,
    profileId: owner.profileId,
    pid: owner.pid,
    ...(owner.displayName ? { displayName: owner.displayName } : {}),
  };
  throw error;
}

export interface AcquireWorkspaceLockResult {
  ok: boolean;
  owner?: WorkspaceLockOwner;
}

/**
 * 原子获取工作区锁：`wx`（CREATE_NEW）保证并发下只有一个写者成功，
 * 判负方从返回值拿到占用方信息用于灰显（spec §并发与竞态）。
 * displayName（可选）= 持有者实例显示名，写进锁文件供锁提示展示实例名（C5）。
 */
export function acquireWorkspaceLock(
  workspacePath: string,
  profileId: string,
  pid: number,
  displayName?: string,
): AcquireWorkspaceLockResult {
  const lockHash = getWorkspaceLockHash(workspacePath);
  const lockPath = getLockFilePath(lockHash);
  mkdirSync(getLocksDir(), { recursive: true });
  // 无主锁懒清理后立即尝试原子创建；清理与创建之间的竞争由 wx 原子性兜底
  const existing = readLockEntry(lockPath);
  if (existing && !isLockStale(existing, Date.now())) {
    return { ok: false, owner: toLockOwner(existing) };
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
    ...(normalizeLockDisplayName(displayName) ? { displayName: normalizeLockDisplayName(displayName) } : {}),
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
      owner: owner ? toLockOwner(owner) : undefined,
    };
  }
}

/**
 * [OmniCode] 终审 P2 修复：锁文件原子重写（与 desktop atomicJson 同内核语义——
 * temp 落盘 + rename 原子发布）。裸 writeFileSync（truncate+write）存在半截写入
 * 窗口，并发读者（readLockEntry/listWorkspaceLocks）会拿到无法解析的 JSON；本批
 * 起心跳每次都重写（displayName 自愈），放大面改由原子写收口。per-lock 单写者
 * （profileId+pid 归属校验）无需 per-path 写锁；temp 名含 pid+纳秒防碰撞，失败
 * 清理不掩盖原始错误（调用方 coordinator 已 try/catch，下拍重试）。
 */
function atomicWriteLockFile(lockPath: string, payload: string): void {
  const tempPath = `${lockPath}.tmp.${process.pid}.${Date.now()}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  try {
    writeFileSync(tempPath, payload, "utf8");
    renameSync(tempPath, lockPath);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // temp 清理失败不掩盖原始错误
    }
    throw error;
  }
}

/** 心跳：仅当锁归属当前实例时续期。返回是否仍持有。 */
export function heartbeatWorkspaceLock(
  workspacePath: string,
  profileId: string,
  pid: number,
  /** [OmniCode] 实例元数据批次：最新持有者显示名（可缺省）——续期时重写进锁文件，改名后 10s 内锁名自愈。 */
  displayName?: string,
): boolean {
  const lockPath = getLockFilePath(getWorkspaceLockHash(workspacePath));
  const entry = readLockEntry(lockPath);
  if (!entry || entry.profileId !== profileId || entry.pid !== pid) return false;
  const freshName = normalizeLockDisplayName(displayName);
  const updated: WorkspaceLockEntry = {
    ...entry,
    heartbeatAt: Date.now(),
    ...(freshName ? { displayName: freshName } : {}),
  };
  atomicWriteLockFile(lockPath, JSON.stringify(updated));
  return true;
}

/**
 * [OmniCode] 实例元数据批次：锁持有者显示名的最新注册表读取（同步小 IO，fail-open）。
 * 改名后运行中实例的 env 快照（OMNICODE_PROFILE_NAME，spawn 时注入）已过期；Host
 * utilityProcess 与实例 desktop main 不共享内存（桥命令到不了锁协调器），故锁获取/
 * 心跳时直接读 profile.json 最新 name——单一事实源，最稳实现（无需桥下发、无时序依赖）。
 * 仅 Profile 实例身份（OMNICODE_PROFILE_ID 过白名单）读档；profileRoot 与
 * desktop profileRuntime 同源（OMNICODE_PROFILE_ROOT 覆盖或 ~/.omnicode/profiles）。
 * 读不到/坏档返回 undefined（调用方回退 spawn 注入的静态 env 值）。
 */
export function readLatestOmnicodeProfileDisplayName(): string | undefined {
  const profileId = process.env.OMNICODE_PROFILE_ID?.trim() ?? "";
  if (!/^p[0-9a-z]{8,20}$/u.test(profileId)) return undefined;
  const override = process.env.OMNICODE_PROFILE_ROOT?.trim();
  const profileRoot = override ? override : join(homedir(), ".omnicode", "profiles");
  try {
    const raw = readFileSync(join(profileRoot, profileId, "profile.json"), "utf8");
    const parsed = JSON.parse(raw) as { id?: unknown; name?: unknown };
    if (parsed.id !== profileId) return undefined;
    if (typeof parsed.name !== "string") return undefined;
    const trimmed = parsed.name.trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
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
    result.set(lockHash, toLockOwner(entry));
  }
  return result;
}

export interface WorkspaceLockDecoration {
  workspacePath: string;
  profileId: string;
  ownedBySelf: boolean;
  /** 持有者实例显示名（C5：锁提示显示实例名；老锁缺省，UI 回退 profileId）。 */
  displayName?: string;
}

/**
 * readTree 装饰用：全量锁的呈现视角。ownedBySelf = 锁被当前实例持有
 * （同实例多窗口不灰显，保持官方单实例语义，spec §工作区互斥锁）。
 */
export function listWorkspaceLockDecorations(): WorkspaceLockDecoration[] {
  const selfProfileId = process.env.OMNICODE_PROFILE_ID?.trim() || "default";
  return [...listWorkspaceLocks().values()].map((owner) => ({
    workspacePath: owner.workspacePath,
    profileId: owner.profileId,
    ownedBySelf: owner.profileId === selfProfileId,
    ...(owner.displayName ? { displayName: owner.displayName } : {}),
  }));
}
