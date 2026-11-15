// [OmniCode] 批次3：登录态看板数据快照（数据层第 3 层——编排：凭据快照 × balance API）。
// spec: F:\OmniCode\docs\batch3\BATCH3-DESIGN-DISCUSSION.md §2：
// - 每账号请求用该 profile 自己解密的 token + 该数据根已存的 X-Device-Mid（风控红线，
//   绝不生成/共享；缺设备号 → "无设备号-跳过"）。
// - 刷新策略 = 打开时全量一次 + 手动刷新；30min TTL 缓存防频繁请求 + force 强刷；
//   不做后台高频轮询（低频日查询级别）。
// - 失败必须显示原因不静默：balance 失败 → entry.balanceState=failed + 稳定原因键；
//   任何单账号失败不拖垮整表（永不 reject）。
import {
  buildOmnicodeBalanceUrl,
  buildOmnicodeBillingHeaders,
  fetchOmnicodeBillingEnvelope,
  mapOmnicodeBalanceFailureReasonKey,
  parseOmnicodeBalanceEnvelope,
  resolveOmnicodeBillingRequestPolicy,
  type OmnicodeBalanceEnvelope,
} from "./billingClient.js";
import {
  parseOmnicodeUserInfo,
  readOmnicodeAccountDataFromDataRoot,
  readOmnicodeBillingCredentials,
  type OmnicodeAccountDataSnapshot,
} from "./accountData.js";
import {
  getOmnicodeProfileDir,
  getOmnicodeProfileRecord,
  listOmnicodeProfiles,
} from "./profileRuntime.js";
import type {
  OmnicodeAccountBalanceInfo,
  OmnicodeAccountBalanceState,
  OmnicodeAccountDashboardEntry,
  OmnicodeAccountDashboardSnapshot,
  OmnicodeAccountIdentityInfo,
} from "@zcode/shared";
import { maskOmnicodeAccountEmail } from "@zcode/shared";

/** 快照 TTL（30 分钟；防频繁请求 + 尊重额度与风控）。 */
export const OMNICODE_ACCOUNT_SNAPSHOT_TTL_MS = 30 * 60 * 1000;

/**
 * TTL 判定（纯函数）：force=true 一律 miss；缓存时刻距今超过 TTL 即 miss。
 */
export function resolveOmnicodeSnapshotCacheHit(
  cachedAt: number,
  now: number,
  force: boolean,
): boolean {
  if (force) return false;
  return now - cachedAt < OMNICODE_ACCOUNT_SNAPSHOT_TTL_MS;
}

/** 模块级缓存（管理器进程内存态；进程重启即重建，无需持久化）。 */
let cachedSnapshot: { snapshot: OmnicodeAccountDashboardSnapshot } | null = null;

/**
 * [OmniCode] 批次3 终审修复（P2-④）：进行中的整表快照拉取（单飞去重）。并发 force
 *（单卡刷新双击 / 单卡刷新 × 全部刷新交错）直接复用同一个进行中 Promise——同一账号
 * 不会出现 2 个并发 balance 请求，逐账号串行编排口径不被破坏。函数本身永不 reject
 *（逐账号失败归 entry 状态），Promise 结束即清空。
 */
let snapshotFetchInFlight: Promise<OmnicodeAccountDashboardSnapshot> | null = null;

/** 单测注入点：清空缓存（生产路径不使用）。 */
export function resetOmnicodeAccountDashboardCacheForTest(): void {
  cachedSnapshot = null;
  snapshotFetchInFlight = null;
}

/** balance 查询单账号结果（内部中间态）。 */
export interface OmnicodeBalanceAttempt {
  state: OmnicodeAccountBalanceState;
  balance?: OmnicodeAccountBalanceInfo;
  reasonKey?: string;
  fetchedAt: number;
}

/**
 * balance 结果装配（纯函数）：把 policy/attempt 归一到看板 entry 的 balanceState 语义。
 * 调用方保证 attempt.state ∈ {ok, failed}（skip/unknown 在此处由 attempt 缺省表达）。
 */
export function assembleOmnicodeAccountBalanceView(
  attempt: OmnicodeBalanceAttempt | undefined,
): {
  balanceState: OmnicodeAccountBalanceState;
  balance?: OmnicodeAccountBalanceInfo;
  balanceErrorReasonKey?: string;
  balanceFetchedAt?: number;
} {
  if (!attempt) {
    return { balanceState: "unknown" };
  }
  if (attempt.state === "ok" && attempt.balance) {
    return {
      balanceState: "ok",
      balance: attempt.balance,
      balanceFetchedAt: attempt.fetchedAt,
    };
  }
  return {
    balanceState: attempt.state === "ok" ? "unknown" : attempt.state,
    ...(attempt.reasonKey ? { balanceErrorReasonKey: attempt.reasonKey } : {}),
    balanceFetchedAt: attempt.fetchedAt,
  };
}

/**
 * [OmniCode] 批次3 终审修复（P2-③）：看板条目 identity 装配时 main 侧统一脱敏邮箱
 * （`xia***@z.ai`，maskOmnicodeAccountEmail 纯函数复用）——与检测链口径一致
 *（accountDetection 装配前脱敏），raw 邮箱不再进 IPC 载荷；渲染层
 * AccountDashboardCard 的脱敏保留为兜底（脱敏串重掩码幂等，无二次伤害）。
 * displayName/avatarUrl/customerNumber 为展示字段原样保留（凭据红线不涉及其它字段）。
 */
function maskOmnicodeDashboardIdentity(
  identity: OmnicodeAccountIdentityInfo | undefined,
): OmnicodeAccountIdentityInfo | undefined {
  if (!identity) return undefined;
  const maskedEmail = maskOmnicodeAccountEmail(identity.email);
  const { email: _rawEmail, ...rest } = identity;
  if (maskedEmail === undefined) return Object.keys(rest).length > 0 ? rest : undefined;
  return { ...rest, email: maskedEmail };
}

/** 单账号完整装配（纯函数）：凭据快照 + balance 尝试 → 看板条目。 */
export function assembleOmnicodeAccountDashboardEntry(input: {
  profileId: string;
  profileName: string;
  accountData: Awaited<ReturnType<typeof readOmnicodeAccountDataFromDataRoot>>;
  balanceAttempt?: OmnicodeBalanceAttempt;
  /** 兜底 identity（accountData 缺省时可由调用方补 parse 结果；正常路径不传）。 */
  identityFallback?: ReturnType<typeof parseOmnicodeUserInfo>;
}): OmnicodeAccountDashboardEntry {
  const balanceView = assembleOmnicodeAccountBalanceView(input.balanceAttempt);
  const identity = maskOmnicodeDashboardIdentity(input.accountData.identity ?? input.identityFallback);
  return {
    profileId: input.profileId,
    profileName: input.profileName,
    ...(identity && Object.keys(identity).length > 0 ? { identity } : {}),
    ...(input.accountData.session ? { session: input.accountData.session } : {}),
    ...balanceView,
  };
}

/**
 * 单账号 balance 查询（永不抛穿）：policy 门（缺设备号→skipped_no_device_mid、缺
 * JWT→missing_jwt）→ 请求（15s 超时）→ 解析。fetchImpl 可注入（单测）。
 * 日志只打 profileId 与结果态，不打 token/设备号（红线）。
 */
export async function fetchOmnicodeAccountBalanceAttempt(input: {
  profileId: string;
  jwtToken: string;
  deviceMid: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  env?: Record<string, string | undefined>;
}): Promise<OmnicodeBalanceAttempt> {
  const now = input.now ?? Date.now;
  const fetchedAt = now();
  try {
    const headers = buildOmnicodeBillingHeaders(
      {
        jwtToken: input.jwtToken,
        deviceMid: input.deviceMid,
        platform: process.platform,
        arch: process.arch,
      },
      { method: "GET" },
    );
    const result = await fetchOmnicodeBillingEnvelope<OmnicodeBalanceEnvelope>(
      input.fetchImpl ?? fetch,
      buildOmnicodeBalanceUrl(input.env),
      { method: "GET", headers },
    );
    if (!result.ok) {
      return {
        state: "failed",
        reasonKey: mapOmnicodeBalanceFailureReasonKey(result.reason),
        fetchedAt,
      };
    }
    if (result.envelope.code !== undefined && Number(result.envelope.code) !== 0) {
      // 服务端明确拒绝（非零 code）按 HTTP 同类归 failed（原因键复用 http 口径）
      return { state: "failed", reasonKey: mapOmnicodeBalanceFailureReasonKey("http"), fetchedAt };
    }
    return { state: "ok", balance: parseOmnicodeBalanceEnvelope(result.envelope), fetchedAt };
  } catch {
    // 理论不可达（内部全吞错）；兜底归 unknown，绝不抛穿
    return { state: "unknown", fetchedAt };
  }
}

/**
 * 全量快照（Profile 列表 IPC 数据源，永不 reject）：逐 profile 串行——凭据快照（只读）
 * → policy 门 → balance API。TTL 缓存命中直接返回（force 绕过）；已有进行中的拉取
 * 直接复用（P2-④ 单飞去重，见 snapshotFetchInFlight 注释）。
 * 单账号失败→该 entry 归 failed/unknown + 原因键，不影响其余账号。
 */
export async function getOmnicodeAccountDashboardSnapshot(
  options: { force?: boolean; fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<OmnicodeAccountDashboardSnapshot> {
  const now = options.now ?? Date.now;
  if (cachedSnapshot && resolveOmnicodeSnapshotCacheHit(cachedSnapshot.snapshot.fetchedAt, now(), options.force === true)) {
    return { ...cachedSnapshot.snapshot, fromCache: true };
  }
  if (snapshotFetchInFlight) return snapshotFetchInFlight;
  const run = (async (): Promise<OmnicodeAccountDashboardSnapshot> => {
    return fetchOmnicodeAccountDashboardSnapshot({ ...options, now });
  })();
  snapshotFetchInFlight = run;
  try {
    return await run;
  } finally {
    if (snapshotFetchInFlight === run) snapshotFetchInFlight = null;
  }
}

/** 整表快照实际编排（供 getOmnicodeAccountDashboardSnapshot 的单飞包装调用）。 */
async function fetchOmnicodeAccountDashboardSnapshot(
  options: { force?: boolean; fetchImpl?: typeof fetch; now: () => number },
): Promise<OmnicodeAccountDashboardSnapshot> {
  const now = options.now;
  const profiles = await listOmnicodeProfiles().catch(() => [] as never[]);
  const accounts: OmnicodeAccountDashboardEntry[] = [];
  for (const profile of profiles) {
    // 逐 profile 隔离：单账号读失败=该账号 unknown，不拖垮整表
    try {
      const record = await getOmnicodeProfileRecord(profile.id).catch(() => undefined);
      const dataRoot = record?.dataBaseDirOverride?.trim() || getOmnicodeProfileDir(profile.id);
      const accountData = await readOmnicodeAccountDataFromDataRoot(dataRoot).catch(
        (): OmnicodeAccountDataSnapshot => ({}),
      );
      let balanceAttempt: OmnicodeBalanceAttempt | undefined;
      const policy = resolveOmnicodeBillingRequestPolicy({
        hasJwtToken: accountData.session?.hasJwtToken === true,
        hasDeviceMid: typeof accountData.deviceMid === "string" && accountData.deviceMid.length > 0,
      });
      if (policy === "go") {
        const credentials = await readOmnicodeBillingCredentials(dataRoot).catch(() => undefined);
        if (credentials && accountData.deviceMid) {
          balanceAttempt = await fetchOmnicodeAccountBalanceAttempt({
            profileId: profile.id,
            jwtToken: credentials.jwtToken,
            deviceMid: accountData.deviceMid,
            fetchImpl: options.fetchImpl,
            now,
          });
        } else {
          balanceAttempt = { state: "unknown", fetchedAt: now() };
        }
      } else {
        balanceAttempt = {
          state: policy === "skip_no_device_mid" ? "skipped_no_device_mid" : "missing_jwt",
          fetchedAt: now(),
        };
      }
      accounts.push(
        assembleOmnicodeAccountDashboardEntry({
          profileId: profile.id,
          profileName: profile.name,
          accountData,
          balanceAttempt,
        }),
      );
    } catch {
      accounts.push({
        profileId: profile.id,
        profileName: profile.name,
        balanceState: "unknown",
      });
    }
  }
  const snapshot: OmnicodeAccountDashboardSnapshot = {
    fetchedAt: now(),
    fromCache: false,
    accounts,
  };
  cachedSnapshot = { snapshot };
  return snapshot;
}
