import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ZCODE_PRODUCT_FLAVOR } from "@zcode/shared";
import { setDataBaseDir } from "@zcode/services/node";

export function resolveBootstrapSettingsFile(homePath: string = homedir()): string {
  return join(homePath, ".zcode", "v2", "setting.json");
}

export function extractBootstrapDataBaseDir(rawValue: unknown): string | null {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const dataBaseDir = (rawValue as { dataBaseDir?: unknown }).dataBaseDir;
  if (typeof dataBaseDir !== "string") {
    return null;
  }

  const trimmed = dataBaseDir.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBootstrapDataBaseDirFromDisk(
  settingsFile: string = resolveBootstrapSettingsFile(),
): string | null {
  if (!existsSync(settingsFile)) {
    return null;
  }

  try {
    const raw = readFileSync(settingsFile, "utf-8");
    return extractBootstrapDataBaseDir(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function applyEarlyDataBaseDirBootstrap(): string | null {
  // [OmniCode] omnicode flavor 主实例：数据根默认 ~/.omnicode/console，与官方 ZCode 的
  // ~/.zcode 彻底分库（凭据/会话库/工作区默认目录各自独立）。官方版没有 OmniCode 的
  // 工作区互斥锁，若两边共用 ~/.zcode 的同一个会话 SQLite，跨品牌并发会重演 kept 链
  // 撕裂事故（spec §工作区互斥锁的事故依据）——分库是唯一彻底解。
  // 优先级：Profile 实例（profileBootstrap 已注入 ZCODE_DATA_BASE_DIR）与用户显式 env
  // 不动；官方 setting.json 的 dataBaseDir 不跟随——跟随即重新共享官方数据根。
  if (ZCODE_PRODUCT_FLAVOR === "omnicode" && !process.env.ZCODE_DATA_BASE_DIR) {
    const omnicodeDataBaseDir = join(homedir(), ".omnicode", "console");
    setDataBaseDir(omnicodeDataBaseDir);
    // 主进程内 paths 由 setDataBaseDir 即刻生效；再写 env 让 host/agent 子进程经
    // buildHostProcessEnv 的 dataBaseDir !== homedir() 分支继承同一数据根。
    process.env.ZCODE_DATA_BASE_DIR = omnicodeDataBaseDir;
    return omnicodeDataBaseDir;
  }
  const dataBaseDir = readBootstrapDataBaseDirFromDisk();
  if (dataBaseDir) {
    // 启动早期就把 dataBaseDir 注入进来，避免 logger / crashReporter 先按默认 HOME 建目录，
    // 导致后续再切换到自定义目录时，日志和 crash dump 落在两套路径里。
    setDataBaseDir(dataBaseDir);
  }
  return dataBaseDir;
}
