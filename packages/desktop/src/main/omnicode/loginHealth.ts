// [OmniCode] 批次2.5 X2：登录态健康度（管理器直读，spec: docs/omnicode/console-extras.md §X2）。
//
// 数据路径决策（方案 a 管理器直读）：管理器与实例同源代码，直接 import 底层解密件——
// 读 profile 数据根（dataBaseDirOverride ?? profileDir）下 .zcode/v2/credentials.json
//（明文 JSON，值为密文）与 .zcode/v2/credential-secret，经 createSystemCredentialCipher
//（env 注入 ZCODE_CREDENTIAL_SECRET）解密 oauth:<provider>:expires_at。env 注入时
// getKey 走 source="env" 短路（systemCredentialCipher.ts getManagedSecret 先于 keyring
// 路径）——不触发 OS keyring、不触发文件锁、零写入；不走 oauthCredentialRepo /
// credentialService 的任何高层读写 API（规避迁移/写入副作用，任务红线）。
// 兼容：enc:v2:env: 与 legacy enc:v1: 均可解；收养根的 enc:v2:os: 旧密文 source 不匹配
// → 解密抛错 → 未知态（如实降级，spec 已知限制 3）。
// 任何读失败 = unknown 静默（不告警、不阻塞列表）。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createSystemCredentialCipher } from "@zcode/shared/credential-security";
import {
  BIGMODEL_PROVIDER_ID,
  ZAI_CN_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  type OmnicodeLoginHealthInfo,
} from "@zcode/shared";
import {
  getOmnicodeProfileDir,
  getOmnicodeProfileRecord,
  type OmnicodeProfileSummary,
} from "./profileRuntime.js";

/** 已知 OAuth provider（与 oauthCredentialRepo KNOWN_OAUTH_PROVIDER_IDS 对齐）。 */
export const OMNICODE_LOGIN_HEALTH_PROVIDERS = [
  ZAI_PROVIDER_ID,
  ZAI_CN_PROVIDER_ID,
  BIGMODEL_PROVIDER_ID,
] as const;

const CREDENTIALS_FILE_NAME = "credentials.json";
const CREDENTIAL_SECRET_FILE_NAME = "credential-secret";
const ACTIVE_PROVIDER_KEY = "oauth:active_provider";

function expiresAtKey(provider: string): string {
  return `oauth:${provider}:expires_at`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** 即将到期阈值（剩余 ≤7 天，边界=7 天整属 expiring）。 */
export const OMNICODE_LOGIN_EXPIRING_THRESHOLD_DAYS = 7;

/**
 * 分级决策（纯函数，单测登记 engineering-test-files.json）：
 * active provider 的有效 expiresAt 优先；active 缺失/非法时取全部已知 provider 有效值的
 * 最大值；全无 → unknown。expired：now ≥ expiresAt；expiring：剩余 ≤7 天（ceil 天数）。
 */
export function resolveOmnicodeLoginHealth(
  input: {
    expiresAtByProvider: Readonly<Record<string, number>>;
    activeProvider?: string;
  },
  now: number,
): OmnicodeLoginHealthInfo {
  const valid = Object.entries(input.expiresAtByProvider).filter(
    ([, expiresAt]) => Number.isFinite(expiresAt) && expiresAt > 0,
  );
  if (valid.length === 0) return { status: "unknown" };
  let chosen: { provider: string; expiresAt: number } | undefined;
  if (input.activeProvider && input.activeProvider in input.expiresAtByProvider) {
    const activeExpiresAt = input.expiresAtByProvider[input.activeProvider];
    if (activeExpiresAt !== undefined && Number.isFinite(activeExpiresAt) && activeExpiresAt > 0) {
      chosen = { provider: input.activeProvider, expiresAt: activeExpiresAt };
    }
  }
  if (!chosen) {
    for (const [provider, expiresAt] of valid) {
      if (!chosen || expiresAt > chosen.expiresAt) chosen = { provider, expiresAt };
    }
  }
  if (!chosen) return { status: "unknown" };
  const remainingMs = chosen.expiresAt - now;
  const daysRemaining = Math.ceil(remainingMs / DAY_MS);
  if (remainingMs <= 0) {
    return { status: "expired", daysRemaining: 0, expiresAt: chosen.expiresAt };
  }
  if (daysRemaining <= OMNICODE_LOGIN_EXPIRING_THRESHOLD_DAYS) {
    return { status: "expiring", daysRemaining, expiresAt: chosen.expiresAt };
  }
  return { status: "healthy", daysRemaining, expiresAt: chosen.expiresAt };
}

/** 解密单个快照值；任何失败返回 undefined（调用方按未知态静默）。 */
async function decryptSnapshotValue(
  cipher: ReturnType<typeof createSystemCredentialCipher>,
  raw: string | undefined,
): Promise<string | undefined> {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    return await cipher.decrypt(raw);
  } catch {
    return undefined;
  }
}

/**
 * 从单个数据根读取登录态健康度（测试可注入 now）。文件缺失/JSON 损坏/密钥缺失/
 * 解密失败全部 → unknown（静默；spec §分级语义"任何读失败=未知态静默"）。
 */
export async function readOmnicodeLoginHealthFromDataRoot(
  dataRoot: string,
  now: number = Date.now(),
): Promise<OmnicodeLoginHealthInfo> {
  const credentialsPath = join(dataRoot, ".zcode", "v2", CREDENTIALS_FILE_NAME);
  let secret: string;
  let snapshot: Record<string, unknown>;
  try {
    secret = (await readFile(join(dataRoot, ".zcode", "v2", CREDENTIAL_SECRET_FILE_NAME), "utf8")).trim();
    if (secret.length < 32 || secret.length > 4096) return { status: "unknown" };
    const raw = await readFile(credentialsPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { status: "unknown" };
    snapshot = parsed as Record<string, unknown>;
  } catch {
    return { status: "unknown" };
  }
  // env 注入密钥：cipher 的 key 解析走 env 短路（不触 keyring / 文件锁 / 写入）
  const cipher = createSystemCredentialCipher({
    filePath: credentialsPath,
    env: { ZCODE_CREDENTIAL_SECRET: secret },
  });
  const expiresAtByProvider: Record<string, number> = {};
  for (const provider of OMNICODE_LOGIN_HEALTH_PROVIDERS) {
    const plain = await decryptSnapshotValue(cipher, snapshot[expiresAtKey(provider)] as string | undefined);
    if (plain === undefined) continue;
    const expiresAt = Number.parseInt(plain, 10);
    if (Number.isFinite(expiresAt) && expiresAt > 0) expiresAtByProvider[provider] = expiresAt;
  }
  const activeProvider = await decryptSnapshotValue(cipher, snapshot[ACTIVE_PROVIDER_KEY] as string | undefined);
  return resolveOmnicodeLoginHealth({ expiresAtByProvider, activeProvider }, now);
}

/**
 * 批量读取（Profile 列表 IPC 数据源）：逐 profile 解析数据根
 *（dataBaseDirOverride ?? profileDir，与 instanceManager.doLaunch 同规则）；
 * 记录读取失败 → unknown。永不 reject（列表不被登录态读取拖垮）。
 */
export async function readOmnicodeLoginHealths(
  profiles: readonly OmnicodeProfileSummary[],
): Promise<Map<string, OmnicodeLoginHealthInfo>> {
  const results = new Map<string, OmnicodeLoginHealthInfo>();
  await Promise.all(
    profiles.map(async (profile) => {
      try {
        const record = await getOmnicodeProfileRecord(profile.id).catch(() => undefined);
        const dataRoot = record?.dataBaseDirOverride?.trim() || getOmnicodeProfileDir(profile.id);
        results.set(profile.id, await readOmnicodeLoginHealthFromDataRoot(dataRoot));
      } catch {
        results.set(profile.id, { status: "unknown" });
      }
    }),
  );
  return results;
}
