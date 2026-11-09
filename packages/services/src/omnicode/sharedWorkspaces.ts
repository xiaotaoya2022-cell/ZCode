// [OmniCode] 全实例共享工作区注册表（spec: docs/omnicode/profile-runtime.md §工作区共享）。
// 文件：`${sharedRoot}/workspaces.json` = { workspaces: [...] }
// 并发（spec §并发与竞态）：读-合并-临时文件-原子替换；写入前重读合并（同路径幂等），
// 极端并发下的丢失由下次项目变更时重新 upsert 收敛（最终一致）。
// D2 双向：Host 项目库变更时把新项目根回流共享表（与投影同源）；实例/控制台启动时
// 由 Host 把共享表缺失项 saveProject 进本实例项目库（见 node.ts 初始化钩子）。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getOmnicodeSharedRoot } from "./workspaceLocks.js";

export interface SharedWorkspaceEntry {
  /** 规范化绝对路径（与锁 hash 同一规范化语义） */
  path: string;
  /** 显示名（目录名） */
  name: string;
  addedAt: string;
  /** 来源：profileId 或 "console" */
  addedBy?: string;
}

interface SharedWorkspacesFile {
  workspaces: SharedWorkspaceEntry[];
}

const WORKSPACES_FILENAME = "workspaces.json";
const TMP_SUFFIX = ".tmp";

export function normalizeWorkspacePath(workspacePath: string): string {
  // 与锁 hash 同一规范化语义：绝对化 + 去尾部斜杠（Windows 侧大小写不敏感由锁端处理）
  return resolve(workspacePath).replace(/[\\/]+$/, "");
}

function getSharedWorkspacesFilePath(): string {
  return join(getOmnicodeSharedRoot(), WORKSPACES_FILENAME);
}

function readSharedWorkspacesFile(): SharedWorkspaceEntry[] {
  const filePath = getSharedWorkspacesFilePath();
  try {
    if (!existsSync(filePath)) return [];
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as SharedWorkspacesFile;
    if (!parsed || !Array.isArray(parsed.workspaces)) return [];
    return parsed.workspaces.filter(
      (entry) => entry && typeof entry.path === "string" && entry.path.length > 0,
    );
  } catch (error) {
    console.warn("[omnicode] 共享工作区表读取失败（按空表处理）:", error);
    return [];
  }
}

function writeSharedWorkspacesFile(entries: SharedWorkspaceEntry[]): void {
  const sharedRoot = getOmnicodeSharedRoot();
  mkdirSync(sharedRoot, { recursive: true });
  const target = join(sharedRoot, WORKSPACES_FILENAME);
  const tmp = join(sharedRoot, WORKSPACES_FILENAME + TMP_SUFFIX);
  writeFileSync(tmp, JSON.stringify({ workspaces: entries }, null, 2), "utf8");
  rmSync(target, { force: true });
  renameSync(tmp, target);
}

/** 合并写入：按规范化路径去重（同路径幂等），新增条目带来源与时间戳。 */
export function upsertSharedWorkspaces(
  paths: readonly string[],
  addedBy: string,
): SharedWorkspaceEntry[] {
  const normalized = paths
    .map((entry) => normalizeWorkspacePath(entry))
    .filter((entry) => entry.length > 0);
  if (normalized.length === 0) return readSharedWorkspacesFile();
  // 写入前重读，收窄并发丢失窗口
  const existing = readSharedWorkspacesFile();
  const byPath = new Map(existing.map((entry) => [entry.path, entry]));
  const now = new Date().toISOString();
  for (const path of normalized) {
    if (byPath.has(path)) continue;
    byPath.set(path, { path, name: basename(path), addedAt: now, addedBy });
  }
  const merged = [...byPath.values()].sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  writeSharedWorkspacesFile(merged);
  return merged;
}

/** 全量共享工作区列表（合入前用于与本地项目库求差集）。 */
export function listSharedWorkspaces(): SharedWorkspaceEntry[] {
  return readSharedWorkspacesFile();
}

/** 求差集：共享表里存在、本地项目库缺失的条目（Host 启动合并的输入）。 */
export function diffMissingSharedWorkspaces(localPaths: readonly string[]): SharedWorkspaceEntry[] {
  const localNormalized = new Set(localPaths.map((entry) => normalizeWorkspacePath(entry)));
  return readSharedWorkspacesFile().filter((entry) => !localNormalized.has(entry.path));
}
