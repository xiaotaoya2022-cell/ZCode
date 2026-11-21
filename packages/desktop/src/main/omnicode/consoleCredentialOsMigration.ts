// [OmniCode] omni.5 真机修复（F2-5，bug1 根因之二）：console 根 os→env 一次性凭据迁移。
//
// 磁盘事实（真机调研 docs/batch3/research/omni5-bugs-research.md §一）：管理器 console
// 根 credentials.json 全部 8 个值为 enc:v2:os:（OS keyring 旧密文，写入于凭据密钥固化
// 批次之前），credential-source 钉 "os"；而 keyring 条目按凭据文件路径哈希寻址——
// 数据根落点调整（console/v2 → console/.zcode/v2）后条目失配，host 报
// CREDENTIAL_SECURE_STORAGE_UNAVAILABLE，oauth 全 FAIL（bug1 根因）。
//
// 处置策略（任务拍板，"解密失败先备份绝不静默清空"哲学）：
// 1. 迁移尝试：main 侧用同一构造（AsyncEntry(SYSTEM_CREDENTIAL_KEYRING_SERVICE,
//    digest(resolve(credentialsPath)).toString("hex"))）探测 OS keyring——若条目实际
//    存在且密钥能解开全部 os: 密文（keyring 可用、只是此前"密钥来源钉扎"让 host 走
//    不通），则用固化 env 密钥重加密为 enc:v2:env:（reWrapOsCredentialValuesWithEnvKey
//    纯函数，任一值解不开即整体失败不改写），原子写回 + 备份原文件 + 移除 credential-source
//    钉扎标记（解除 os 钉扎后 cipher 由 managed secret 固定走 env；marker 文件任何非 os
//    内容都会让 keyring 路径直接 unavailable，因此"改写为 env 标记"的正确落点是移除）。
// 2. keyring 探测失败 / 条目缺失 / 密文解不开：os: 密文不可恢复（不静默清空）——
//    按 backupCorruptFile 既有约定留内容寻址备份（.corrupt-<hash>.bak，0600 排他），
//    并把状态写入管理器可见的标记文件（credential-os-migration.json），供管理器 UI
//    给出明确重登引导；live 文件里的 os: 值保持原样（host 侧解密失败由既有恢复机制
//    处置，登录新写入因 env 密钥已透传（desktopRuntimeEnv buildHostProcessEnv）落在
//    enc:v2:env:，重登一次后永久稳定）。
//
// 运行时机：管理器 main 启动一次性 fire-and-forget（先于 host 大规模凭据读取即可）。
// 并发说明（终审 P2 如实修订）：withFileLock 是迁移自身的文件锁，锁内做双检重读防"读旧
// 值写回"；但 host/实例侧 credentialService 的 writeAll/readAll **并不持同一把锁**，
// 二者并无真正互斥。实际风险窗口不可达：bug1 态下 host 对 os: 值解密失败→save/readAll
// 在写之前就失败；迁移成功后 os: 值已不存在，"锁内旧值覆盖新写"的窗口随之关闭。
// 官方 flavor 恒不调用（零改动）。
import { readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  reWrapOsCredentialValuesWithEnvKey,
  readSystemCredentialKeyringEntry,
} from "@zcode/shared/credential-security";
import { atomicWritePrivateTextFile, backupCorruptFile, withFileLock } from "@zcode/shared/node";

/** 管理器 UI 可读的迁移状态标记文件（不含任何密钥/明文）。 */
const MIGRATION_MARKER_FILE = "credential-os-migration.json";
export const OMNICODE_MIGRATION_MARKER_FILE = MIGRATION_MARKER_FILE;
/** credential-source 钉扎标记（systemCredentialCipher 同名常量）。 */
const CREDENTIAL_SOURCE_FILE = "credential-source";
const OS_CIPHERTEXT_PREFIX = "enc:v2:os:";

export interface ConsoleOsCredentialMigrationOutcome {
  /**
   * migrated：keyring 密钥可用，全部 os: 值已重加密为 env:（钉扎已解除）。
   * unrecoverable：keyring 不可用/条目失配/密文解不开——os: 密文不可恢复，已备份并标记，
   * 管理器 UI 据此给重登引导。not-applicable：无 os: 值（已是 env: / 空根 / 文件缺失）。
   */
  status: "migrated" | "unrecoverable" | "not-applicable";
  /** 迁移/备份到的文件路径（unrecoverable 时为 .corrupt-<hash>.bak 证据路径）。 */
  backupPath?: string;
  migratedCount?: number;
  /** 探测判定的失败原因（unrecoverable 时填，供日志与 UI 引导措辞；backup-failed=解密
   * 已成功但备份失败，放弃写回——终审 P2 修复：不再误标 decrypt-failed）。 */
  reason?: "keyring-unavailable" | "keyring-entry-missing" | "decrypt-failed" | "backup-failed";
}

function readOsKeyFingerprints(record: Record<string, string>): Set<string> {
  const fingerprints = new Set<string>();
  for (const value of Object.values(record)) {
    if (!value.startsWith(OS_CIPHERTEXT_PREFIX)) continue;
    const fingerprint = value.slice(OS_CIPHERTEXT_PREFIX.length).split(":")[0];
    if (fingerprint && /^[a-f0-9]{24}$/.test(fingerprint)) fingerprints.add(fingerprint);
  }
  return fingerprints;
}

/**
 * console 根 os→env 一次性迁移（管理器 main 专用）。
 * @param dataRoot console 数据根（~/.omnicode/console）
 * @param envSecret 固化 env 密钥（ensureOmnicodeCredentialSecret 产物；空串=迁移跳过）
 */
export async function runConsoleRootOsCredentialMigration(
  dataRoot: string,
  envSecret: string,
): Promise<ConsoleOsCredentialMigrationOutcome> {
  const credentialsPath = join(dataRoot, ".zcode", "v2", "credentials.json");
  let raw: string;
  try {
    raw = await readFile(credentialsPath, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return { status: "not-applicable" };
    }
    // 非缺失的读取错误：不动文件（损坏 JSON 由既有 inspectStore/recoverStore 机制处置）。
    return { status: "not-applicable" };
  }
  let record: Record<string, string>;
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: "not-applicable" };
    }
    record = parsed as Record<string, string>;
  } catch {
    return { status: "not-applicable" };
  }
  const osPrints = readOsKeyFingerprints(record);
  if (osPrints.size === 0) return { status: "not-applicable" };
  if (!envSecret) {
    // 密钥固化失败（ensureOmnicodeCredentialSecret fail-open）：env 迁移无目标密钥，
    // 保持原样并标记不可恢复（host 已拿不到 env 密钥，重登引导兜底）。
    return markUnrecoverable(credentialsPath, "keyring-unavailable", "env-secret-missing");
  }

  // 迁移持迁移自己的凭据文件锁（锁内双检重读防"读旧值写回"）。如实说明（终审 P2）：
  // host/实例侧 writeAll/readAll 不持这把锁，二者并无真正互斥——实际风险窗口不可达：
  // bug1 态 host 对 os: 值解密失败（save/readAll 在写之前失败），迁移成功后 os: 值
  // 已不存在；keyring 锁序同 cipher：文件锁内探测。
  return withFileLock(credentialsPath, async () => {
    // 双检：锁内重读（host 可能已并发写入 env: 值）。
    let lockedRaw: string;
    try {
      lockedRaw = await readFile(credentialsPath, "utf8");
      const lockedParsed: unknown = JSON.parse(lockedRaw || "{}");
      if (!lockedParsed || typeof lockedParsed !== "object" || Array.isArray(lockedParsed)) {
        return { status: "not-applicable" };
      }
      record = lockedParsed as Record<string, string>;
    } catch {
      return { status: "not-applicable" };
    }
    const lockedPrints = readOsKeyFingerprints(record);
    if (lockedPrints.size === 0) return { status: "not-applicable" };

    // ── 探测 OS keyring（与 systemCredentialCipher.systemKeyStore 同构造，共享实现） ──
    let encoded: string | null = null;
    try {
      encoded = await readSystemCredentialKeyringEntry(credentialsPath);
    } catch {
      // 系统库不可达（服务缺失/D-Bus 不通/锁定拒绝）：os: 密文按不可恢复处置。
      return markUnrecoverable(credentialsPath, "keyring-unavailable");
    }
    if (!encoded) {
      // 条目缺失（数据根落点调整后路径哈希失配——真机实际状态）：密钥已物理丢失。
      return markUnrecoverable(credentialsPath, "keyring-entry-missing");
    }

    // 锁内重加密 + 原子写回（reWrap 任一值解不开返回 null → 整体失败不改写）。
    const migrated = reWrapOsCredentialValuesWithEnvKey(
      record,
      encoded,
      createHash("sha256").update(envSecret).digest(),
    );
    if (!migrated) {
      return markUnrecoverable(credentialsPath, "decrypt-failed");
    }
    // 先备份原文件（内容寻址 0600 排他），再原子写回；备份失败则放弃写回（证据优先），
    // 并按不可恢复处置补写 marker——此时 reWrap 已成功（解密未失败），reason 不能误标
    // decrypt-failed（终审 P2：原实现误标且不写 marker，UI 无重登引导）。
    let backupPath: string;
    try {
      backupPath = await backupCorruptFile(credentialsPath);
    } catch {
      return await markUnrecoverable(credentialsPath, "backup-failed");
    }
    await atomicWritePrivateTextFile(credentialsPath, `${JSON.stringify(migrated, null, 2)}\n`);
    // 解除 os 钉扎：删除 credential-source（cipher 契约里任何非 os 标记都会让 keyring
    // 路径 unavailable；managed secret 存在时 getKey 本就走 env 短路，标记已无意义）。
    await rm(join(dataRoot, ".zcode", "v2", CREDENTIAL_SOURCE_FILE), { force: true }).catch(
      () => undefined,
    );
    await rm(join(dataRoot, ".zcode", "v2", MIGRATION_MARKER_FILE), { force: true }).catch(
      () => undefined,
    );
    const migratedCount = Object.values(migrated).filter((value) =>
      value.startsWith("enc:v2:env:"),
    ).length;
    return { status: "migrated", backupPath, migratedCount };
  });
}

/**
 * 不可恢复处置（不静默清空）：先备份原文件（保留 os: 密文证据），再写管理器可见的
 * 状态标记（credential-os-migration.json：时间戳 + 失败原因 + 备份路径，无密钥无明文）。
 * 标记文件本身由后续 UI IPC 读取；写标记失败不影响备份证据的存在。
 */
async function markUnrecoverable(
  credentialsPath: string,
  reason: NonNullable<ConsoleOsCredentialMigrationOutcome["reason"]>,
  extraReason?: string,
): Promise<ConsoleOsCredentialMigrationOutcome> {
  const outcome: ConsoleOsCredentialMigrationOutcome = { status: "unrecoverable", reason };
  let backupPath: string | undefined;
  try {
    backupPath = await backupCorruptFile(credentialsPath);
    outcome.backupPath = backupPath;
  } catch {
    // 备份失败（文件已被并发移走等）：不阻断标记，live 文件原样保留。
  }
  const markerPath = join(resolve(credentialsPath, ".."), MIGRATION_MARKER_FILE);
  const marker = {
    status: "unrecoverable" as const,
    reason: extraReason ?? reason,
    ...(backupPath ? { backupPath } : {}),
    markedAt: new Date().toISOString(),
  };
  await atomicWritePrivateTextFile(
    markerPath,
    `${JSON.stringify(marker, null, 2)}\n`,
  ).catch(() => undefined);
  return outcome;
}

/**
 * 读取迁移标记（管理器 UI IPC 数据源；无标记返回 null）。任何读取/解析异常都视为
 * 无标记——标记只是 UI 引导信号，不影响凭据链本身。
 */
export async function readConsoleRootOsMigrationMarker(
  dataRoot: string,
): Promise<{ status: "unrecoverable"; reason: string; markedAt: string; backedUp: boolean } | null> {
  let raw: string;
  try {
    raw = await readFile(join(dataRoot, ".zcode", "v2", MIGRATION_MARKER_FILE), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed as { status?: unknown }).status !== "unrecoverable"
    ) {
      return null;
    }
    const record = parsed as { reason?: unknown; markedAt?: unknown; backupPath?: unknown };
    return {
      status: "unrecoverable",
      reason: typeof record.reason === "string" ? record.reason : "unknown",
      markedAt: typeof record.markedAt === "string" ? record.markedAt : "",
      backedUp: typeof record.backupPath === "string" && record.backupPath.length > 0,
    };
  } catch {
    return null;
  }
}
