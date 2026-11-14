// [OmniCode] 批次3：账号数据读取（登录态看板数据层第 1 层——本地凭据快照）。
// spec: F:\OmniCode\docs\batch3\BATCH3-DESIGN-DISCUSSION.md §2；调研依据
// F:\OmniCode\docs\batch3\research\quota-egg-account-research.md §3.1。
//
// 与 X2 loginHealth（./loginHealth.ts）同一条解密链：读 profile 数据根
//（dataBaseDirOverride ?? profileDir）下 .zcode/v2/credentials.json（明文 JSON、值为
// enc:v2:env:/legacy enc:v1: 密文）+ .zcode/v2/credential-secret，经
// createSystemCredentialCipher（env 注入 ZCODE_CREDENTIAL_SECRET）解密。env 注入时
// getKey 走 source="env" 短路——不触发 OS keyring、不触发文件锁、零写入；不走
// oauthCredentialRepo / credentialService 任何高层读写 API（规避迁移/写入副作用）。
//
// 红线（本模块的存在前提）：
// - 只读不写：任何失败归 unknown/缺省，绝不创建/覆盖/修复凭据文件（沿用 loginHealth
//   的只读与备份哲学）；
// - token/设备号不进返回值、不落日志：zcodejwttoken 解密后仅以 hasJwtToken 布尔暴露，
//   明文仅供 main 侧 billing 客户端在同进程内取用（readOmnicodeBillingCredentials）；
// - 大小有界防御（stat 先行）：credentials.json ≤256KiB、secret ≤4096B、
//   telemetry-state.json ≤64KiB，越界/损坏/缺失一律静默降级。
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createSystemCredentialCipher } from "@zcode/shared/credential-security";
import {
  BIGMODEL_PROVIDER_ID,
  ZAI_CN_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  type OmnicodeAccountIdentityInfo,
  type OmnicodeAccountSessionInfo,
} from "@zcode/shared";

/** 已知 OAuth provider（与 loginHealth / oauthCredentialRepo 对齐）。 */
export const OMNICODE_ACCOUNT_DATA_PROVIDERS = [
  ZAI_PROVIDER_ID,
  ZAI_CN_PROVIDER_ID,
  BIGMODEL_PROVIDER_ID,
] as const;

const CREDENTIALS_FILE_NAME = "credentials.json";
const CREDENTIAL_SECRET_FILE_NAME = "credential-secret";
const TELEMETRY_STATE_FILE_NAME = "telemetry-state.json";
const ACTIVE_PROVIDER_KEY = "oauth:active_provider";
const JWT_TOKEN_KEY = "zcodejwttoken";

/** credentials.json 大小上限（与 loginHealth OMNICODE_LOGIN_CREDENTIALS_MAX_BYTES 同值）。 */
export const OMNICODE_ACCOUNT_CREDENTIALS_MAX_BYTES = 262_144;
/** 密钥文件字节界（systemCredentialCipher.resolveManagedSecret 同值：32..4096）。 */
export const OMNICODE_ACCOUNT_SECRET_MAX_BYTES = 4_096;
/** telemetry-state.json 只读大小上限（真实文件为设备标识+计数器，数 KB 量级）。 */
export const OMNICODE_ACCOUNT_TELEMETRY_STATE_MAX_BYTES = 65_536;

function expiresAtKey(provider: string): string {
  return `oauth:${provider}:expires_at`;
}

function userInfoKey(provider: string): string {
  return `oauth:${provider}:user_info`;
}

/**
 * 读前有界防御（与 loginHealth.readBoundedTextFile 同规则）：stat 校验为常规文件且
 * ≤ maxBytes 再读取；越界抛错由调用方归 unknown。同步 IO 无真超时，以大小上限约束
 * 最坏读取成本。
 */
async function readBoundedTextFile(path: string, maxBytes: number): Promise<string> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > maxBytes) {
    throw new Error(
      `[omnicode] accountData 拒读越界文件 size=${metadata.size} max=${maxBytes}`,
    );
  }
  return readFile(path, "utf8");
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

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * user_info 解析（纯函数，单测覆盖）：OAuthCredentialRepo 的落盘有两种形态——
 * 归一化 `{id,username,displayName,avatarUrl,rawProfile}`，或 ZAI 的 raw `data.user`
 * 原样 JSON（email/name/avatar/customerNumber 等）。本函数同时在顶层、`data.user`
 * 与 `rawProfile` 三层找字段，找齐即用；全是垃圾输入返回空对象（不抛错）。
 */
export function parseOmnicodeUserInfo(raw: unknown): OmnicodeAccountIdentityInfo {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const root = raw as Record<string, unknown>;
  const asObject = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const nestedCandidates = [
    root,
    asObject(root["data"]),
    asObject(root["rawProfile"]),
    asObject(root["user"]),
    // ZAI 后端外层 data.user 包裹形态（envelope.data.user 原样落盘的防御）
    asObject(asObject(root["data"])?.["user"]),
  ].filter((candidate): candidate is Record<string, unknown> => candidate !== undefined);
  const read = (...path: string[]): unknown => {
    for (const layer of nestedCandidates) {
      let cursor: unknown = layer;
      let ok = true;
      for (const key of path) {
        if (!cursor || typeof cursor !== "object") {
          ok = false;
          break;
        }
        cursor = (cursor as Record<string, unknown>)[key];
      }
      if (ok && cursor !== undefined && cursor !== null) return cursor;
    }
    return undefined;
  };
  const displayName = firstNonEmptyString(
    read("displayName"),
    read("name"),
    read("username"),
    read("nickName"),
    read("customerName"),
  );
  const email = firstNonEmptyString(read("email"), read("mail"));
  const avatarUrl = firstNonEmptyString(read("avatarUrl"), read("avatar"), read("picture"));
  const customerNumber = firstNonEmptyString(
    read("customerNumber"),
    read("customerId"),
    read("customer_number"),
  );
  return {
    ...(displayName ? { displayName } : {}),
    ...(email ? { email } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(customerNumber ? { customerNumber } : {}),
  };
}

/** 单 profile 凭据快照读取结果（不含任何明文密钥）。 */
export interface OmnicodeAccountDataSnapshot {
  identity?: OmnicodeAccountIdentityInfo;
  session?: OmnicodeAccountSessionInfo;
  /** 数据根 telemetry-state.json 里已存的设备号（只读复用；读不到=undefined，绝不生成）。 */
  deviceMid?: string;
}

/**
 * 读 telemetry-state.json 的 deviceMid（纯读取）：与实例侧 resolveTelemetryStateFile
 * 的落点（.zcode/v2/telemetry-state.json 的 deviceMid 字段）一致；缺失/损坏/越界 →
 * undefined（调用方标记"无设备号-跳过"，绝不生成新设备号——风控红线）。
 */
export function parseOmnicodeDeviceMid(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const deviceMid = (raw as Record<string, unknown>)["deviceMid"];
  if (typeof deviceMid !== "string") return undefined;
  const trimmed = deviceMid.trim();
  // 实例侧写入的是 UUID；仅接受 UUID 形态，防脏数据混入请求头
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    trimmed,
  )
    ? trimmed
    : undefined;
}

/**
 * 从单个数据根读取账号数据（测试可注入文件系统边界）：
 * - 凭据文件/密钥缺失、损坏、越界、解密失败 → 对应字段缺省（整体不抛错）；
 * - active provider 的 expires_at 优先，否则取全部已知 provider 有效值的最大值
 *   （与 loginHealth 分级取值规则一致，保证看板与徽标口径不分叉）。
 */
export async function readOmnicodeAccountDataFromDataRoot(
  dataRoot: string,
): Promise<OmnicodeAccountDataSnapshot> {
  const credentialsPath = join(dataRoot, ".zcode", "v2", CREDENTIALS_FILE_NAME);
  let secret: string;
  let snapshot: Record<string, unknown>;
  try {
    // 与实例侧 canonical 读取（systemCredentialCipher.resolveManagedSecret）对齐：
    // 原样读取不 trim，按 Buffer.byteLength 判界（loginHealth 同规则，两侧不分叉）。
    const secretRaw = await readBoundedTextFile(
      join(dataRoot, ".zcode", "v2", CREDENTIAL_SECRET_FILE_NAME),
      OMNICODE_ACCOUNT_SECRET_MAX_BYTES,
    );
    const secretBytes = Buffer.byteLength(secretRaw, "utf8");
    if (secretBytes < 32 || secretBytes > OMNICODE_ACCOUNT_SECRET_MAX_BYTES) return {};
    secret = secretRaw;
    const raw = await readBoundedTextFile(credentialsPath, OMNICODE_ACCOUNT_CREDENTIALS_MAX_BYTES);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    snapshot = parsed as Record<string, unknown>;
  } catch {
    return {};
  }
  const cipher = createSystemCredentialCipher({
    filePath: credentialsPath,
    env: { ZCODE_CREDENTIAL_SECRET: secret },
  });

  const activeProvider = await decryptSnapshotValue(
    cipher,
    snapshot[ACTIVE_PROVIDER_KEY] as string | undefined,
  );
  // expires_at：active provider 优先，否则取已知 provider 有效值最大值
  let expiresAt: number | undefined;
  if (activeProvider && OMNICODE_ACCOUNT_DATA_PROVIDERS.includes(activeProvider as never)) {
    const plain = await decryptSnapshotValue(
      cipher,
      snapshot[expiresAtKey(activeProvider)] as string | undefined,
    );
    const parsedExpiresAt = Number.parseInt(plain ?? "", 10);
    if (Number.isFinite(parsedExpiresAt) && parsedExpiresAt > 0) expiresAt = parsedExpiresAt;
  }
  if (expiresAt === undefined) {
    for (const provider of OMNICODE_ACCOUNT_DATA_PROVIDERS) {
      const plain = await decryptSnapshotValue(
        cipher,
        snapshot[expiresAtKey(provider)] as string | undefined,
      );
      const parsedExpiresAt = Number.parseInt(plain ?? "", 10);
      if (Number.isFinite(parsedExpiresAt) && parsedExpiresAt > 0) {
        expiresAt = expiresAt === undefined ? parsedExpiresAt : Math.max(expiresAt, parsedExpiresAt);
      }
    }
  }

  // user_info：active provider 优先（其它 provider 的快照不冒充当前账号）
  let identity: OmnicodeAccountIdentityInfo | undefined;
  if (activeProvider && OMNICODE_ACCOUNT_DATA_PROVIDERS.includes(activeProvider as never)) {
    const plain = await decryptSnapshotValue(
      cipher,
      snapshot[userInfoKey(activeProvider)] as string | undefined,
    );
    if (plain) {
      let parsedUserInfo: unknown;
      try {
        parsedUserInfo = JSON.parse(plain);
      } catch {
        parsedUserInfo = undefined;
      }
      identity = parseOmnicodeUserInfo(parsedUserInfo);
    }
  }

  const jwtPlain = await decryptSnapshotValue(cipher, snapshot[JWT_TOKEN_KEY] as string | undefined);
  const hasJwtToken = typeof jwtPlain === "string" && jwtPlain.trim().length > 0;

  // deviceMid：只读 telemetry-state.json（缺失/损坏/越界 → undefined，不生成）
  let deviceMid: string | undefined;
  try {
    const telemetryRaw = await readBoundedTextFile(
      join(dataRoot, ".zcode", "v2", TELEMETRY_STATE_FILE_NAME),
      OMNICODE_ACCOUNT_TELEMETRY_STATE_MAX_BYTES,
    );
    deviceMid = parseOmnicodeDeviceMid(JSON.parse(telemetryRaw));
  } catch {
    deviceMid = undefined;
  }

  return {
    ...(identity && Object.keys(identity).length > 0 ? { identity } : {}),
    ...(activeProvider || expiresAt !== undefined || hasJwtToken
      ? { session: { ...(activeProvider ? { activeProvider } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}), hasJwtToken } }
      : {}),
    ...(deviceMid ? { deviceMid } : {}),
  };
}

/**
 * 读 billing 请求所需的明文凭据（仅供 main 侧 billing 客户端在同进程内使用，
 * 返回值不进 IPC、不进日志）。凭据/密钥缺失或解密失败 → undefined（调用方按
 * "缺 JWT"降级，不重试、不落盘）。
 */
export async function readOmnicodeBillingCredentials(dataRoot: string): Promise<
  { jwtToken: string } | undefined
> {
  const credentialsPath = join(dataRoot, ".zcode", "v2", CREDENTIALS_FILE_NAME);
  let secret: string;
  let snapshot: Record<string, unknown>;
  try {
    const secretRaw = await readBoundedTextFile(
      join(dataRoot, ".zcode", "v2", CREDENTIAL_SECRET_FILE_NAME),
      OMNICODE_ACCOUNT_SECRET_MAX_BYTES,
    );
    const secretBytes = Buffer.byteLength(secretRaw, "utf8");
    if (secretBytes < 32 || secretBytes > OMNICODE_ACCOUNT_SECRET_MAX_BYTES) return undefined;
    secret = secretRaw;
    const raw = await readBoundedTextFile(credentialsPath, OMNICODE_ACCOUNT_CREDENTIALS_MAX_BYTES);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    snapshot = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const cipher = createSystemCredentialCipher({
    filePath: credentialsPath,
    env: { ZCODE_CREDENTIAL_SECRET: secret },
  });
  const jwtPlain = await decryptSnapshotValue(cipher, snapshot[JWT_TOKEN_KEY] as string | undefined);
  const jwtToken = jwtPlain?.trim();
  return jwtToken ? { jwtToken } : undefined;
}
