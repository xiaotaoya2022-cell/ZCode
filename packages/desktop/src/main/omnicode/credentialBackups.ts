// [OmniCode] Profile 凭据自动备份（用户拍板轻量补强）：控制台侧定期把各实例/主实例的
// credentials.json 备到各自 profile 内带时间戳副本，升级/迁移出问题时一键回滚而不是
// 重新登录。设计约束：
// - 只拷贝，不解读、不解密、不改原文件（凭据文件本身是 AES-GCM 密文，副本同目录同权限）；
// - 内容与最近一份相同则跳过（省 IO，且保留历史多样性——只在内容变化时产生新副本）；
// - 每 profile 保留最近 5 份，超出按时间戳名清理（时间戳名可字典序排序）；
// - 一切失败 best-effort：备份永不阻断启动/主流程。
// 覆盖面：全部 Profile 实例 + 主实例（控制台）数据根的 credentials.json。
import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { getOmnicodeProfileDir, getOmnicodeProfileRoot } from "./profileRuntime.js";

const BACKUP_DIR_NAME = "credential-backups";
const KEEP_PER_TARGET = 5;
const SCHEDULER_INTERVAL_MS = 60 * 60 * 1000; // 每小时

function backupDirFor(credentialPath: string): string {
  return join(credentialPath, "..", BACKUP_DIR_NAME);
}

function timestampName(): string {
  // 文件名安全且字典序 = 时间序（本地时间足够，备份仅在本机回滚使用）。
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** 保留最近 KEEP_PER_TARGET 份；按文件名（时间戳）排序，超出的删除。失败 best-effort。 */
async function pruneOldBackups(backupDir: string): Promise<void> {
  try {
    const entries = (await readdir(backupDir))
      .filter((name) => name.startsWith("credentials-") && name.endsWith(".json"))
      .sort();
    const stale = entries.slice(0, Math.max(0, entries.length - KEEP_PER_TARGET));
    for (const name of stale) {
      await rm(join(backupDir, name), { force: true });
    }
  } catch (error) {
    console.warn("[omnicode] 凭据备份清理失败:", error);
  }
}

/**
 * 备份单个凭据文件到其同级 credential-backups/ 目录。
 * 返回 "backed-up" | "unchanged" | "absent"；抛错视为该目标失败（调用方聚合）。
 */
export async function backupCredentialFile(
  credentialPath: string,
): Promise<"backed-up" | "unchanged" | "absent"> {
  if (!existsSync(credentialPath)) return "absent";
  const current = await readFile(credentialPath);
  // 空文件/空白内容不备份（避免用空文件覆盖历史好备份）
  if (current.length === 0) return "absent";
  const backupDir = backupDirFor(credentialPath);
  await mkdir(backupDir, { recursive: true });
  const previousEntries = (await readdir(backupDir))
    .filter((name) => name.startsWith("credentials-") && name.endsWith(".json"))
    .sort();
  const latest = previousEntries.at(-1);
  if (latest) {
    const previous = await readFile(join(backupDir, latest)).catch(() => null);
    if (previous && previous.equals(current)) {
      // 内容未变化：不产生新副本（保留策略里的旧份继续代表这段稳定期）
      return "unchanged";
    }
  }
  const target = join(backupDir, `credentials-${timestampName()}.json`);
  await copyFile(credentialPath, target);
  await pruneOldBackups(backupDir);
  return "backed-up";
}

function consoleCredentialPath(): string {
  // 主实例（控制台）数据根：desktopDataBaseDirBootstrap 固化 ~/.omnicode/console；
  // 若官方 setting.json/legacy 路径生效则以实际 dataBaseDir 为准（读 env 由 services 层统一）。
  const base = process.env.ZCODE_DATA_BASE_DIR?.trim() || join(homedir(), ".omnicode", "console");
  return join(base, ".zcode", "v2", "credentials.json");
}

export interface OmnicodeCredentialBackupSummary {
  backedUp: string[];
  unchanged: string[];
  absent: string[];
  failed: string[];
}

/** 扫全部 Profile 实例 + 主实例数据根，逐个备份。永不抛错（聚合失败名单）。 */
export async function backupAllOmnicodeCredentials(): Promise<OmnicodeCredentialBackupSummary> {
  const summary: OmnicodeCredentialBackupSummary = {
    backedUp: [],
    unchanged: [],
    absent: [],
    failed: [],
  };
  const targets: Array<{ label: string; credentialPath: string }> = [];
  const root = getOmnicodeProfileRoot();
  if (existsSync(root)) {
    const { readdirSync } = await import("node:fs");
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      targets.push({
        label: entry.name,
        credentialPath: join(getOmnicodeProfileDir(entry.name), ".zcode", "v2", "credentials.json"),
      });
    }
  }
  targets.push({ label: "console", credentialPath: consoleCredentialPath() });

  for (const target of targets) {
    try {
      const result = await backupCredentialFile(target.credentialPath);
      if (result === "backed-up") {
        summary.backedUp.push(target.label);
      } else if (result === "unchanged") {
        summary.unchanged.push(target.label);
      } else {
        summary.absent.push(target.label);
      }
    } catch (error) {
      console.warn(`[omnicode] 凭据备份失败 ${target.label}:`, error);
      summary.failed.push(target.label);
    }
  }
  return summary;
}

let schedulerStarted = false;

/** 控制台装配时调用：立即备份一次 + 每小时一轮；timer unref 不阻碍退出。幂等。 */
export function startOmnicodeCredentialBackupScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const run = (): void => {
    void backupAllOmnicodeCredentials().then((summary) => {
      if (summary.backedUp.length > 0 || summary.failed.length > 0) {
        console.info(
          `[omnicode] 凭据备份完成: backedUp=${summary.backedUp.join(",") || "-"} failed=${summary.failed.join(",") || "-"}`,
        );
      }
    });
  };
  run();
  const timer = setInterval(run, SCHEDULER_INTERVAL_MS);
  timer.unref?.();
}

// ─── [OmniCode] 批次2 B2-1（T2）：实例进程自身的凭据备份调度 ───

let instanceSelfSchedulerStarted = false;

/**
 * 实例进程启动路径装配（index.ts whenReady，仅 Profile 实例身份调用）：只备份实例
 * 自己数据根的 credentials.json（收养实例随 override 根走）。管理器的全量调度器
 * （backupAllOmnicodeCredentials）覆盖全部 profile 目录，但管理器关闭后实例独立
 * 存活（批次2 关闭语义），实例侧必须自带兜底调度，不因 T3 门控丢失。
 * 与管理器侧调度器互不冲突：同一文件内容未变化时不产生新副本（unchanged 短路）。
 * 幂等；timer unref 不阻碍退出。
 */
export function startOmnicodeInstanceSelfCredentialBackupScheduler(): void {
  if (instanceSelfSchedulerStarted) return;
  const dataBaseDir = process.env.ZCODE_DATA_BASE_DIR?.trim();
  if (!dataBaseDir) return; // 实例身份必有该 env（profileBootstrap 五件套）；缺失即不装配
  instanceSelfSchedulerStarted = true;
  const credentialPath = join(dataBaseDir, ".zcode", "v2", "credentials.json");
  const run = (): void => {
    void backupCredentialFile(credentialPath).catch(() => undefined);
  };
  run();
  const timer = setInterval(run, SCHEDULER_INTERVAL_MS);
  timer.unref?.();
}
