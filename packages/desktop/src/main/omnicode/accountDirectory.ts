// [OmniCode] 模式二 R2：附加账号目录 + 解密代理（管理器侧唯一解密权威，spec:
// docs/omnicode/multi-account-sessions.md §5）。
//
// 目录枚举：扫 Profile 注册表（listOmnicodeProfiles）除请求方实例外的各 profile 数据根
// 凭据（复用批次3 accountDetection/accountData 的跨 profile 只读读取链——"凭据在盘、
// 实例不必运行"）。账号条目 {accountId(=profileId 派生), sourceProfileId, family,
// deviceMid(源 profile telemetry-state.json MID), displayName}。
//
// 解密代理：实例 Host 经桥发 accountMaterialRequest {accountId} → 本模块按 accountId
// 反解源 profile → 用批次3 读取链（credential-secret env 注入 + bounded 读）解密
// credentials.json 的 OAuth 材料 → 按官方 oauthCredentialRepo materialFromSnapshot /
// startPlanMaterialFromSnapshot 语义映射成材料快照 → base64 应答（内存现取，**不落盘、
// 不进日志**——红线；错误只回固定结构化键，绝不携带材料内容）。
//
// 幂等性：整个代理只读磁盘、无共享可变状态、无写入——多实例并发请求同一账号各自独立
// 解密，结果一致（源文件在两次读取间被实例刷新则按"现取"语义返回新快照，属预期）。
// 管理器是唯一解密权威：实例不读取其他 profile 的 credential-secret，实例侧只持有
// base64 应答（Host 侧二次校验后短 TTL 内存缓存）。
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  isBuiltinOAuthProvider,
  omnicodeAccountMaterialFileSchema,
  OAUTH_LINKED_BIGMODEL_KEY,
  OAUTH_SESSION_REVISION_KEY,
  providerFamilyConnectionSelectionSettingsSchema,
  resolveProviderFamilyDomainFromOAuthProvider,
  resolveStartPlanFamilyFromOAuthProvider,
  type OmnicodeAccountMaterialFileData,
  type ProviderFamilyDomain,
} from "@zcode/shared";
import { createSystemCredentialCipher } from "@zcode/shared/credential-security";
import {
  OMNICODE_ACCOUNT_CREDENTIALS_MAX_BYTES,
  OMNICODE_ACCOUNT_SECRET_MAX_BYTES,
  readOmnicodeAccountDataFromDataRoot,
  type OmnicodeAccountDataSnapshot,
} from "./accountData.js";
import { resolveOmnicodeDetectionDisplayName } from "./accountDetection.js";
import {
  getOmnicodeProfileDir,
  getOmnicodeProfileRecord,
  listOmnicodeProfiles,
} from "./profileRuntime.js";

/** credentials.json 的 zcodejwttoken 键（oauthCredentialRepo/accountData 同字面量）。 */
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
const ACTIVE_PROVIDER_KEY = "oauth:active_provider";
/** 源 profile setting.json 大小上限（只读防御，越界按读不到→缺省 selections）。 */
const OMNICODE_BRIDGE_ACCOUNT_SETTINGS_MAX_BYTES = 262_144;
/** 桥代理 accountId 前缀：sourceProfileId 派生（请求只带 accountId，反解即得源 profile）。 */
const OMNICODE_BRIDGE_ACCOUNT_ID_PREFIX = "acct-";

/** 附加账号目录条目（不含任何凭据材料——凭据只在解密代理应答路径现取）。 */
export interface OmnicodeBridgeAccountEntry {
  /** 源 profileId 派生（acct-<sourceProfileId>），与请求载荷同一形态约束。 */
  accountId: string;
  sourceProfileId: string;
  family: ProviderFamilyDomain;
  /** 源 profile telemetry-state.json MID（device_mid 红线：bridge-proxy 来源用它）。 */
  deviceMid: string | null;
  displayName: string;
}

/** accountId 派生（纯函数）：acct-<sourceProfileId>。 */
export function deriveOmnicodeBridgeAccountId(sourceProfileId: string): string {
  return `${OMNICODE_BRIDGE_ACCOUNT_ID_PREFIX}${sourceProfileId}`;
}

/**
 * accountId 反解源 profileId（纯函数）：剥离前缀后按 profileRuntime.assertValidProfileId
 * 同一白名单校验（防目录穿越/串号）。非法返回 null。
 */
export function resolveOmnicodeBridgeAccountSourceProfileId(accountId: string): string | null {
  if (typeof accountId !== "string") return null;
  if (!accountId.startsWith(OMNICODE_BRIDGE_ACCOUNT_ID_PREFIX)) return null;
  const sourceProfileId = accountId.slice(OMNICODE_BRIDGE_ACCOUNT_ID_PREFIX.length);
  return /^p[0-9a-z]{8,20}$/u.test(sourceProfileId) ? sourceProfileId : null;
}

// ─── 源 profile 凭据解密（复用批次3 只读读取链的边界与密钥注入方式） ───

/** 解密后的源 profile OAuth 会话快照（仅本模块内消费，绝不进日志/IPC 其他字段）。 */
export interface OmnicodeProfileOAuthCredentialSnapshot {
  loginProvider: string;
  sessionRevision: string | null;
  zcodeJwtToken: string;
  accessToken: string | null;
  /** 官方 user_info 两种落盘形态归一出的主体 id（zcodeUserId 事实源）。 */
  zcodeUserId: string | null;
  /** ZAI 全球登录关联的 BigModel 业务凭据（userId 必须匹配当前主体才算有效）。 */
  linkedBigModel: { userId: string; customerId: string; accessToken: string } | null;
}

async function readBoundedTextFile(path: string, maxBytes: number): Promise<string> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > maxBytes) {
    throw new Error("[omnicode] accountDirectory 拒读越界文件");
  }
  return readFile(path, "utf8");
}

/**
 * 官方 user_info 两种落盘形态的主体 id 解析（纯函数，单测锁定；与
 * oauthCredentialRepo.parseStoredUserProfile 同语义：归一化 OAuthUserProfile 优先，
 * ZAI raw data.user 形态按 user_id 兜底）。
 */
export function parseOmnicodeStoredProfileUserId(
  raw: string | undefined,
  provider: string,
): string | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record["id"] === "string" && record["id"].trim()) return record["id"].trim();
  // ZAI 后端 data.user 原样落盘：user_id 为主键（zai / zai_cn）。
  if (
    (provider === "zai" || provider === "zai_cn") &&
    typeof record["user_id"] === "string" &&
    record["user_id"].trim()
  ) {
    return record["user_id"].trim();
  }
  return null;
}

/**
 * 读单个源 profile 数据根的 OAuth 会话快照（只读；任何失败 → null，绝不写盘/生成）。
 * 密钥链与批次3 accountData 同款：credential-secret env 注入（不触发 OS keyring/文件锁），
 * bounded 读，逐字段解密（失败字段按缺省，不阻断其余字段）。
 */
export async function readOmnicodeProfileOAuthCredentials(
  dataRoot: string,
): Promise<OmnicodeProfileOAuthCredentialSnapshot | null> {
  const credentialsPath = join(dataRoot, ".zcode", "v2", "credentials.json");
  let snapshot: Record<string, unknown>;
  let secret: string;
  try {
    const secretRaw = await readBoundedTextFile(
      join(dataRoot, ".zcode", "v2", "credential-secret"),
      OMNICODE_ACCOUNT_SECRET_MAX_BYTES,
    );
    const secretBytes = Buffer.byteLength(secretRaw, "utf8");
    if (secretBytes < 32 || secretBytes > OMNICODE_ACCOUNT_SECRET_MAX_BYTES) return null;
    secret = secretRaw;
    const raw = await readBoundedTextFile(credentialsPath, OMNICODE_ACCOUNT_CREDENTIALS_MAX_BYTES);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    snapshot = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const cipher = createSystemCredentialCipher({
    filePath: credentialsPath,
    env: { ZCODE_CREDENTIAL_SECRET: secret },
  });
  const decrypt = async (raw: unknown): Promise<string | undefined> => {
    if (typeof raw !== "string" || raw.length === 0) return undefined;
    try {
      return await cipher.decrypt(raw);
    } catch {
      return undefined;
    }
  };

  const loginProvider = (await decrypt(snapshot[ACTIVE_PROVIDER_KEY]))?.trim();
  if (!loginProvider || !isBuiltinOAuthProvider(loginProvider)) return null;
  const accessTokenKey = `oauth:${loginProvider}:access_token`;
  const userInfoKey = `oauth:${loginProvider}:user_info`;
  const sessionRevision = (await decrypt(snapshot[OAUTH_SESSION_REVISION_KEY])) ?? null;
  const zcodeJwtToken = ((await decrypt(snapshot[ZCODE_JWT_TOKEN_KEY])) ?? "").trim();
  const accessToken = ((await decrypt(snapshot[accessTokenKey])) ?? "").trim();
  const zcodeUserId = parseOmnicodeStoredProfileUserId(
    await decrypt(snapshot[userInfoKey]),
    loginProvider,
  );
  let linkedBigModel: OmnicodeProfileOAuthCredentialSnapshot["linkedBigModel"] = null;
  const linkedRaw = await decrypt(snapshot[OAUTH_LINKED_BIGMODEL_KEY]);
  if (linkedRaw && zcodeUserId) {
    try {
      const parsed: unknown = JSON.parse(linkedRaw);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as Record<string, unknown>)["userId"] === "string" &&
        typeof (parsed as Record<string, unknown>)["customerId"] === "string" &&
        typeof (parsed as Record<string, unknown>)["accessToken"] === "string" &&
        (parsed as Record<string, unknown>)["userId"] === zcodeUserId &&
        ((parsed as Record<string, unknown>)["customerId"] as string).trim() &&
        ((parsed as Record<string, unknown>)["accessToken"] as string).trim()
      ) {
        linkedBigModel = {
          userId: (parsed as Record<string, unknown>)["userId"] as string,
          customerId: ((parsed as Record<string, unknown>)["customerId"] as string).trim(),
          accessToken: ((parsed as Record<string, unknown>)["accessToken"] as string).trim(),
        };
      }
    } catch {
      linkedBigModel = null;
    }
  }
  return {
    loginProvider,
    sessionRevision,
    zcodeJwtToken,
    accessToken: accessToken || null,
    zcodeUserId,
    linkedBigModel,
  };
}

// ─── 材料映射（官方 oauthCredentialRepo 语义的纯函数移植） ───

/** 单 family 的映射输入快照（mapper 输入：解密凭据 + 目标 family）。 */
export interface OmnicodeProfileMaterialMapperInput {
  accountId: string;
  credentials: OmnicodeProfileOAuthCredentialSnapshot;
  selections: Record<string, unknown>;
  deviceMid: string | null;
}

/**
 * 源 profile 的账号 family 决策（纯函数）：active provider 的直连家族优先；
 * zai_cn（非家族 provider）落到 Start Plan 家族 bigmodel（与官方
 * resolveStartPlanFamilyFromOAuthProvider 同源）。不可解析 → null。
 */
export function resolveOmnicodeBridgeAccountFamily(
  loginProvider: string,
): ProviderFamilyDomain | null {
  return (
    resolveProviderFamilyDomainFromOAuthProvider(loginProvider) ??
    resolveStartPlanFamilyFromOAuthProvider(loginProvider)
  );
}

/**
 * 材料快照映射（纯函数，单测锁定；逐字移植 oauthCredentialRepo.materialFromSnapshot /
 * startPlanMaterialFromSnapshot 语义，单 family 快照）：
 * - familyMaterial：直连（loginProvider===family）或 bigmodel 有效关联，二者必有其一；
 * - startPlanMaterial：有家族材料 → 剥离 accessToken；无材料但 Start 家族匹配 →
 *   ZCode 主体兜底（国内无关联账号官方语义同款）；
 * - selections：源 profile setting.json 的 providerFamilyConnectionSelections 原样透传
 *   （桥服务侧已 schema 校验；本 mapper 不再改写）。
 * 返回 null = 无可用材料（目录跳过该 profile / 代理按缺料收口）。
 */
export function mapOmnicodeProfileCredentialsToMaterial(
  input: OmnicodeProfileMaterialMapperInput,
): OmnicodeAccountMaterialFileData | null {
  const { credentials } = input;
  const family = resolveOmnicodeBridgeAccountFamily(credentials.loginProvider);
  if (!family) return null;
  if (!credentials.zcodeUserId || !credentials.zcodeJwtToken) return null;
  const profileId = credentials.zcodeUserId;
  const direct = credentials.loginProvider === family;
  const linked =
    family === "bigmodel" ? credentials.linkedBigModel : undefined;
  let familyMaterial: OmnicodeAccountMaterialFileData["familyMaterial"] = null;
  if (direct || linked) {
    familyMaterial = {
      family,
      loginProvider: credentials.loginProvider,
      zcodeUserId: profileId,
      sessionRevision: credentials.sessionRevision,
      accountIdentity: linked ? linked.customerId : profileId,
      accessToken: linked ? linked.accessToken : (credentials.accessToken ?? ""),
      zcodeJwtToken: credentials.zcodeJwtToken,
    };
  }
  let startPlanMaterial: OmnicodeAccountMaterialFileData["startPlanMaterial"] = null;
  if (familyMaterial) {
    const { accessToken: _accessToken, ...material } = familyMaterial;
    startPlanMaterial = material;
  } else if (resolveStartPlanFamilyFromOAuthProvider(credentials.loginProvider) === family) {
    startPlanMaterial = {
      family,
      loginProvider: credentials.loginProvider,
      zcodeUserId: profileId,
      sessionRevision: credentials.sessionRevision,
      accountIdentity: profileId,
      zcodeJwtToken: credentials.zcodeJwtToken,
    };
  }
  if (!familyMaterial && !startPlanMaterial) return null;
  return {
    accountId: input.accountId,
    family,
    selections: input.selections as OmnicodeAccountMaterialFileData["selections"],
    accountIdentity: familyMaterial ? familyMaterial.accountIdentity : profileId,
    startPlanMaterial,
    familyMaterial,
    deviceMid: input.deviceMid,
  };
}

/** 源 profile setting.json 的 selections 读取（纯 IO；越界/损坏/缺键 → null → 缺省）。 */
export async function readOmnicodeProfileConnectionSelections(
  dataRoot: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readBoundedTextFile(
      join(dataRoot, ".zcode", "v2", "setting.json"),
      OMNICODE_BRIDGE_ACCOUNT_SETTINGS_MAX_BYTES,
    );
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const selections = (parsed as Record<string, unknown>)["providerFamilyConnectionSelections"];
    if (!selections || typeof selections !== "object" || Array.isArray(selections)) return null;
    const validated = providerFamilyConnectionSelectionSettingsSchema.safeParse(selections);
    if (!validated.success) return null;
    return selections as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── 目录枚举 + 桥解密代理入口 ───

function resolveProfileDataRoot(
  record: { dataBaseDirOverride?: string } | undefined,
  profileId: string,
): string {
  return record?.dataBaseDirOverride?.trim() || getOmnicodeProfileDir(profileId);
}

/**
 * 附加账号目录枚举：逐 profile 串行只读（批次3 accountDetection 同节奏，无并发批量
 * 指纹）。单 profile 失败静默跳过（永不抛穿）。excludeProfileId = 请求方实例自身的
 * profileId（附加账号 = 主账号之外；本任务 R2 内用于目录语义完备，选择器消费属 R3）。
 */
export async function listOmnicodeBridgeAccounts(
  options: { excludeProfileId?: string } = {},
): Promise<OmnicodeBridgeAccountEntry[]> {
  const exclude = options.excludeProfileId?.trim() ?? "";
  let profiles: { id: string; name: string }[] = [];
  try {
    profiles = await listOmnicodeProfiles();
  } catch {
    return [];
  }
  const entries: OmnicodeBridgeAccountEntry[] = [];
  for (const profile of profiles) {
    if (exclude && profile.id === exclude) continue;
    try {
      const record = await getOmnicodeProfileRecord(profile.id).catch(() => undefined);
      const dataRoot = resolveProfileDataRoot(record, profile.id);
      const [credentials, accountData] = await Promise.all([
        readOmnicodeProfileOAuthCredentials(dataRoot),
        readOmnicodeAccountDataFromDataRoot(dataRoot).catch(
          (): OmnicodeAccountDataSnapshot => ({}),
        ),
      ]);
      if (!credentials) continue;
      const family = resolveOmnicodeBridgeAccountFamily(credentials.loginProvider);
      if (!family || !credentials.zcodeUserId || !credentials.zcodeJwtToken) continue;
      // device_mid 红线（§5）：源 profile 无 MID（telemetry-state 缺失/损坏）= 该账号
      // 无法承载 billing 归属 → 目录跳过（批次3 accountDetection skipped_no_device_mid
      // 同口径；绝不生成新设备号）。
      if (!accountData.deviceMid) continue;
      entries.push({
        accountId: deriveOmnicodeBridgeAccountId(profile.id),
        sourceProfileId: profile.id,
        family,
        deviceMid: accountData.deviceMid,
        displayName: resolveOmnicodeDetectionDisplayName({
          displayName: accountData.identity?.displayName,
          profileName: profile.name,
          profileId: profile.id,
        }),
      });
    } catch {
      continue;
    }
  }
  return entries;
}

/** 桥解密代理应答（ok=true 时 dataBase64 = 材料快照 JSON 的 UTF-8 base64；见 shared 契约）。 */
export type OmnicodeBridgeAccountMaterialResult =
  | { ok: true; dataBase64: string }
  | { ok: false; error: string };

/** 固定结构化错误键（绝不携带材料内容——红线）。 */
export const OMNICODE_BRIDGE_ACCOUNT_ERRORS = {
  request: "omnicode_account_request",
  unknown: "omnicode_account_unknown",
  selfExcluded: "omnicode_account_self_excluded",
  unavailable: "omnicode_account_material_unavailable",
} as const;

/**
 * 桥解密代理入口（管理器桥钩子消费）：accountId 反解源 profile → 解密凭据 → 映射材料
 * 快照 → shared schema 自校验（与 Host 侧二次校验同一 schema，防两端漂移）→ base64。
 * 只读、无状态、永不抛穿（异常统一按缺料收口）。requesterProfileId 缺省不排除（管理器
 * 内部调用）；桥钩子必须传握手已验的连接 profileId（防请求方拉取自己的主账号材料）。
 */
export async function resolveOmnicodeBridgeAccountMaterial(params: {
  accountId: string;
  requesterProfileId?: string;
}): Promise<OmnicodeBridgeAccountMaterialResult> {
  const accountId = typeof params.accountId === "string" ? params.accountId.trim() : "";
  if (!accountId) return { ok: false, error: OMNICODE_BRIDGE_ACCOUNT_ERRORS.request };
  const sourceProfileId = resolveOmnicodeBridgeAccountSourceProfileId(accountId);
  if (!sourceProfileId) return { ok: false, error: OMNICODE_BRIDGE_ACCOUNT_ERRORS.unknown };
  const requester = params.requesterProfileId?.trim() ?? "";
  if (requester && requester === sourceProfileId) {
    return { ok: false, error: OMNICODE_BRIDGE_ACCOUNT_ERRORS.selfExcluded };
  }
  try {
    const record = await getOmnicodeProfileRecord(sourceProfileId).catch(() => undefined);
    if (!record) return { ok: false, error: OMNICODE_BRIDGE_ACCOUNT_ERRORS.unknown };
    const dataRoot = resolveProfileDataRoot(record, sourceProfileId);
    const [credentials, selections, accountData] = await Promise.all([
      readOmnicodeProfileOAuthCredentials(dataRoot),
      readOmnicodeProfileConnectionSelections(dataRoot),
      readOmnicodeAccountDataFromDataRoot(dataRoot).catch(
        (): OmnicodeAccountDataSnapshot => ({}),
      ),
    ]);
    if (!credentials) {
      return { ok: false, error: OMNICODE_BRIDGE_ACCOUNT_ERRORS.unavailable };
    }
    // device_mid 红线（§5）：无源 MID 的账号不代理（与目录枚举同口径——防"无 MID 请求"
    // 混入 billing 面产生新指纹；绝不生成新设备号）。
    if (!accountData.deviceMid) {
      return { ok: false, error: OMNICODE_BRIDGE_ACCOUNT_ERRORS.unavailable };
    }
    // 读不到源 profile 的连接选择 → {kind:"start-plan"} 缺省（该账号自己的 family 上）。
    const family = resolveOmnicodeBridgeAccountFamily(credentials.loginProvider);
    const effectiveSelections =
      selections ?? (family ? { [family]: { kind: "start-plan" } } : {});
    const material = mapOmnicodeProfileCredentialsToMaterial({
      accountId,
      credentials,
      selections: effectiveSelections,
      deviceMid: accountData.deviceMid,
    });
    if (!material) return { ok: false, error: OMNICODE_BRIDGE_ACCOUNT_ERRORS.unavailable };
    // 管理器侧自校验（与 Host 二次校验同一 shared schema）：形状不符按缺料收口。
    const validated = omnicodeAccountMaterialFileSchema.parse(material);
    return {
      ok: true,
      dataBase64: Buffer.from(JSON.stringify(validated), "utf8").toString("base64"),
    };
  } catch {
    return { ok: false, error: OMNICODE_BRIDGE_ACCOUNT_ERRORS.unavailable };
  }
}
