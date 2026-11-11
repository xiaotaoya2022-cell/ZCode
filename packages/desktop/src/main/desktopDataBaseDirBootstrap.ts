import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ZCODE_PRODUCT_FLAVOR } from "@zcode/shared";
import { setDataBaseDir } from "@zcode/services/node";
import { ensureOmnicodeCredentialSecret } from "./omnicode/credentialSecret.js";

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
    // [OmniCode] 主实例 HOME_DIR 同步注入（批次2a 补盲）：ZCODE_DESKTOP_HOME_DIR 是
    // settingService.resolveUserHomeDir 的首选输入——不注入则主实例的 setting.json
    // 仍落在真实 ~/.zcode/v2/，与官方产品共享（lastActiveWorkspace 互踩 + 双进程
    // 写同一文件竞争）。Profile 实例由 profileBootstrap 注入同一变量（五件套），
    // 主实例在此补齐，两条路径语义一致。app.setPath("home") 消费同一 env（desktop
    // RuntimeEnv.runtimeHomePath），主实例 home 概念指向 console 数据根为预期行为。
    process.env.ZCODE_DESKTOP_HOME_DIR = omnicodeDataBaseDir;
    // [OmniCode] 凭据密钥固化（环境隔离根治方案，Cockpit ZCODE_CREDENTIAL_SECRET
    // 不变量移植）：数据根内固化 credential-secret 文件并注入 env → 官方加密器
    // 直接采用 env 密钥（source="env"），完全绕过 OS keyring——与官方产品的
    // keyring entry 物理隔离，互踩通道消除。早期导入时机保证先于一切凭据读取。
    const credentialSecret = ensureOmnicodeCredentialSecret(omnicodeDataBaseDir);
    if (credentialSecret) {
      process.env.ZCODE_CREDENTIAL_SECRET = credentialSecret;
    }
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
