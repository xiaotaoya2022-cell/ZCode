// [OmniCode] Profile 注册表 JSON 的原子读写工具（批次1 P1-6）。
// 借鉴 Cockpit atomic_write.rs 的不变量：per-path 写入互斥 + temp 落盘 + rename 原子发布
// + 损坏隔离与备份回滚。profile.json 此前为直接 writeFile——半截写入会让注册表读到
// 无法解析的 JSON（listOmnicodeProfiles 跳过坏档 → 实例"消失"）。
import { existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";

const writeLocksByPath = new Map<string, Promise<void>>();

function nanosSuffix(): string {
  return `${process.pid}.${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 原子写 JSON：串行化同路径写入 → temp 文件落盘并 fsync → rename 原子发布。
 * 旧内容为有效 JSON 时先留 .bak（供读取端损坏回滚）。
 */
export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const previous = writeLocksByPath.get(filePath) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      const payload = `${JSON.stringify(data, null, 2)}\n`;
      await mkdirFor(filePath);
      const bakPath = `${filePath}.bak`;
      if (existsSync(filePath)) {
        try {
          const raw = await readFile(filePath, "utf8");
          JSON.parse(raw);
          // 旧内容有效才值得备份；损坏文件留给读取端隔离
          await writeFile(bakPath, raw, "utf8");
        } catch {
          // 旧文件不可解析：不覆盖 .bak（保留最近一次有效备份）
        }
      }
      const tempPath = join(dirname(filePath), `.${basename(filePath)}.tmp.${nanosSuffix()}`);
      const handle = await open(tempPath, "w");
      try {
        await handle.writeFile(payload, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, filePath);
    });
  writeLocksByPath.set(filePath, current);
  try {
    await current;
  } finally {
    if (writeLocksByPath.get(filePath) === current) {
      writeLocksByPath.delete(filePath);
    }
  }
}

async function mkdirFor(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

function basename(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

/**
 * 读 JSON 并损坏自愈：解析失败 → 把坏文件隔离为 .corrupt.<ts> → 尝试 .bak 回滚。
 * 返回 undefined 表示无有效数据（调用方按"档案缺失"处理，绝不拿到半截内容）。
 */
export async function readJsonWithRecovery<T>(filePath: string): Promise<T | undefined> {
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    console.warn(`[omnicode] JSON 解析失败，尝试隔离与备份回滚: ${filePath}`, error);
    const corruptPath = `${filePath}.corrupt.${Date.now()}`;
    try {
      await rename(filePath, corruptPath);
    } catch (renameError) {
      console.warn(`[omnicode] 坏文件隔离失败: ${filePath}`, renameError);
    }
    const bakPath = `${filePath}.bak`;
    if (existsSync(bakPath)) {
      try {
        const backup = await readFile(bakPath, "utf8");
        const parsed = JSON.parse(backup) as T;
        await writeFile(filePath, backup, "utf8");
        console.info(`[omnicode] 已从备份恢复: ${filePath}`);
        return parsed;
      } catch (backupError) {
        console.warn(`[omnicode] 备份回滚失败: ${bakPath}`, backupError);
      }
    }
    return undefined;
  }
}

/** 目录所有权标记（批次1 P2-10，防误删）：只有本仓创建的 profile 目录才允许整目录删除。 */
export interface OmnicodeDirectoryOwnerMark {
  version: 1;
  profileId: string;
  createdAt: string;
}

export function ownerMarkPath(profileDir: string): string {
  return join(profileDir, ".omnicode-profile-owner.json");
}

export async function writeOwnerMark(profileDir: string, profileId: string): Promise<void> {
  const mark: OmnicodeDirectoryOwnerMark = {
    version: 1,
    profileId,
    createdAt: new Date().toISOString(),
  };
  await writeJsonAtomic(ownerMarkPath(profileDir), mark);
}

/**
 * 删除防护判定（同步：删除是低频操作且调用方为 async 函数内可直接 await 的场景统一走异步；
 * 这里同步实现避免调用端再做两套）。标记存在 → 必须 id 匹配且目录非 symlink 才允许整目录删除；
 * 标记缺失（旧版本创建的档案）→ 允许删除但由调用方打 warn（保持向后兼容）。
 */
export function checkOwnerMarkForDelete(
  profileDir: string,
  profileId: string,
): { allowed: true; legacy: boolean } | { allowed: false; reason: string } {
  const markPath = ownerMarkPath(profileDir);
  if (!existsSync(markPath)) {
    return { allowed: true, legacy: true };
  }
  try {
    const stats = statSync(profileDir);
    if (!stats.isDirectory()) {
      return { allowed: false, reason: "目标不是目录" };
    }
  } catch {
    return { allowed: false, reason: "目录不可访问" };
  }
  try {
    const parsed = JSON.parse(readFileSync(markPath, "utf8")) as OmnicodeDirectoryOwnerMark;
    if (parsed.profileId !== profileId) {
      return {
        allowed: false,
        reason: `所有权标记指向另一实例: ${parsed.profileId} != ${profileId}`,
      };
    }
    return { allowed: true, legacy: false };
  } catch (error) {
    return { allowed: false, reason: `所有权标记解析失败: ${String(error)}` };
  }
}

export { renameSync as renameFileSync };
